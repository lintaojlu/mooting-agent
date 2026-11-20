package com.s23u.atomicclient;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Process;

import com.s23u.atomic.agent.IAgentAtomicCallback;
import com.s23u.atomic.agent.IAgentAtomicService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

final class AtomicAgentHost implements AutoCloseable {
    private static final String PACKAGE = "com.s23u.atomicservice";
    private static final ComponentName AGENT_COMPONENT = new ComponentName(PACKAGE, PACKAGE + ".AgentAtomicService");
    private static volatile AtomicAgentHost active;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Context context;
    private final LocalServerSocket server;
    private final AtomicServiceBridge legacy;
    private final ThreadPoolExecutor clients = new ThreadPoolExecutor(8, 8, 0, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(8));
    private final java.util.concurrent.Semaphore structuredSlots = new java.util.concurrent.Semaphore(4);
    private final ExecutorService audioLifecycle = Executors.newSingleThreadExecutor();
    private final Object audioLock = new Object();
    private volatile IAgentAtomicService structured;
    private volatile boolean closed;
    private volatile boolean bound;
    private volatile boolean visible;
    private volatile String audioError;
    private volatile String legacyError = "正在连接原子服务";
    private volatile AudioRecord recording;

    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder service) {
            structured = IAgentAtomicService.Stub.asInterface(service);
        }
        @Override public void onServiceDisconnected(ComponentName name) { structured = null; }
        @Override public void onNullBinding(ComponentName name) { structured = null; }
        @Override public void onBindingDied(ComponentName name) {
            structured = null;
            if (bound) context.unbindService(this);
            bound = false;
            if (!closed) main.postDelayed(AtomicAgentHost.this::bindStructured, 500);
        }
    };

    AtomicAgentHost(Context context) throws IOException {
        this.context = context;
        server = new LocalServerSocket("mooting." + MootingAgentActivity.randomHex());
        legacy = new AtomicServiceBridge(context, new AtomicServiceBridge.Listener() {
            @Override public void onConnected(String serviceInfo) { legacyError = null; }
            @Override public void onDisconnected(String reason) {
                legacyError = context.checkSelfPermission(PACKAGE + ".permission.BIND_ATOMIC_SERVICE")
                        == PackageManager.PERMISSION_GRANTED ? reason : "等待原子服务或 Binder 权限";
                audioError = reason;
                if (!closed) audioLifecycle.execute(() -> stopRecording(false));
            }
        });
        active = this;
        main.post(() -> {
            if (closed) return;
            legacy.bind();
            bindStructured();
        });
        new Thread(this::accept, "MootingAgent-Atomic").start();
    }

    String address() { return server.getLocalSocketAddress().getName(); }

    private void bindStructured() {
        try {
            bound = context.bindService(new Intent().setComponent(AGENT_COMPONENT), connection,
                    Context.BIND_AUTO_CREATE | Context.BIND_IMPORTANT);
        } catch (SecurityException ignored) {
            bound = false;
        }
    }

    static void setPageVisible(boolean visible) {
        AtomicAgentHost host = active;
        if (host == null) return;
        host.visible = visible;
        if (!visible && !host.closed) host.audioLifecycle.execute(() -> host.stopRecording(false));
    }

    private void accept() {
        while (!closed) {
            try {
                LocalSocket client = server.accept();
                try {
                    if (client.getPeerCredentials().getUid() != Process.myUid()) client.close();
                    else clients.execute(() -> handle(client));
                } catch (Exception error) {
                    client.close();
                }
            } catch (IOException error) {
                if (!closed) android.util.Log.w("MootingAgent", "Atomic socket stopped", error);
                return;
            }
        }
    }

    private void handle(LocalSocket client) {
        try (client; var reader = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
             var writer = new BufferedWriter(new OutputStreamWriter(client.getOutputStream(), StandardCharsets.UTF_8))) {
            client.setSoTimeout(2000);
            String line = reader.readLine();
            if (line == null || line.length() > 512_000) return;
            try {
                JSONObject request = new JSONObject(line);
                String operation = request.getString("op");
                JSONObject input = request.optJSONObject("input");
                if (input == null) input = new JSONObject();
                switch (operation) {
                    case "status" -> write(writer, status());
                    case "audio.start" -> write(writer, startAudio());
                    case "audio.stop" -> {
                        stopRecording(true);
                        write(writer, new JSONObject().put("ok", true)
                                .put("events", new JSONArray(legacy.pollContinuous())));
                    }
                    case "audio.poll" -> write(writer, new JSONObject()
                            .put("running", recording != null).put("error", audioError)
                            .put("events", new JSONArray(legacy.pollContinuous())));
                    case "speech.archive" -> write(writer, success(legacy.recordSpeechTurn(
                            input.getString("speakerId"), input.getString("text"),
                            input.getLong("occurredAtMs"), input.getInt("segmentId"))));
                    case "graph.snapshot" -> write(writer, success(legacy.socialGraphSnapshot()));
                    case "model", "embedding", "rerank", "reply.archive" -> {
                        if (!structuredSlots.tryAcquire()) throw new IOException("原子服务正在处理其他请求");
                        try { transfer(writer, request, operation, input); }
                        finally { structuredSlots.release(); }
                    }
                    case "cancel" -> {
                        IAgentAtomicService service = structured;
                        if (service != null) service.cancel(input.getString("requestId"));
                        write(writer, new JSONObject().put("ok", true));
                    }
                    default -> throw new IOException("未知原子能力");
                }
            } catch (Exception error) {
                write(writer, new JSONObject().put("type", "error")
                        .put("error", error.getMessage() == null ? "原子能力调用失败" : error.getMessage()));
            }
        } catch (IOException | org.json.JSONException ignored) {
        }
    }

    private JSONObject status() throws Exception {
        JSONObject value = new JSONObject().put("speech", legacy.isConnected())
                .put("speechError", legacyError).put("structured", false);
        IAgentAtomicService service = structured;
        if (service != null) {
            try {
                JSONObject capabilities = new JSONObject(service.getCapabilities());
                JSONObject operations = capabilities.optJSONObject("operations");
                boolean compatible = "s23u.agent.atomic.v1".equals(capabilities.optString("api"));
                boolean router = compatible && operations != null && operations.optBoolean("model")
                        && capabilities.optBoolean("toolCalls") && !capabilities.optString("model", "").trim().isEmpty();
                boolean memory = router && capabilities.optBoolean("jsonSchema") &&
                        operations.optBoolean("embedding") && operations.optBoolean("rerank") &&
                        capabilities.optInt("embeddingDimensions", 0) > 0;
                value.put("structured", router).put("memoryModels", memory)
                        .put("replyArchive", compatible && operations != null && operations.optBoolean("reply.archive"));
                if (!router) value.put("structuredError", "原子服务的本机工具调用模型尚未就绪");
                value.put("capabilities", capabilities);
            } catch (Exception error) {
                value.put("structuredError", error.getMessage());
            }
        }
        return value;
    }

    private JSONObject startAudio() throws Exception {
        synchronized (audioLock) {
            if (recording != null) return new JSONObject().put("ok", true);
            if (!visible) throw new IOException("请先打开 MootingAgent 页面");
            if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                throw new IOException("请先授予麦克风权限");
            }
            int bufferSize = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT);
            if (bufferSize <= 0) throw new IOException("设备不支持 16 kHz 单声道录音");
            var microphone = new AudioRecord(MediaRecorder.AudioSource.MIC, 16000,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                    Math.max(bufferSize, 6400));
            try {
                if (microphone.getState() != AudioRecord.STATE_INITIALIZED) throw new IOException("麦克风初始化失败");
                success(legacy.startContinuous(0.8f, 0.01f, 32, 500));
                if (!visible || closed) throw new IOException("录音启动已取消");
                microphone.startRecording();
                if (microphone.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IOException("麦克风启动失败");
                audioError = null;
                recording = microphone;
                new Thread(() -> pump(microphone), "MootingAgent-Audio").start();
            } catch (Exception error) {
                microphone.release();
                legacy.cancelContinuous();
                throw error;
            }
            return new JSONObject().put("ok", true);
        }
    }

    private void pump(AudioRecord microphone) {
        try {
            short[] samples = new short[1600];
            while (recording == microphone) {
                int count = microphone.read(samples, 0, samples.length);
                if (count < 0) throw new IOException("麦克风读取失败");
                if (count > 0 && recording == microphone && legacy.pushContinuous(samples, count) < 0) {
                    throw new IOException("原子语音会话已断开");
                }
            }
        } catch (Exception error) {
            if (recording == microphone) audioError = error.getMessage();
        } finally {
            synchronized (audioLock) {
                if (recording == microphone) {
                    recording = null;
                    legacy.cancelContinuous();
                }
            }
            microphone.release();
        }
    }

    private void stopRecording(boolean flush) {
        AudioRecord microphone = recording;
        if (microphone == null) return;
        synchronized (audioLock) {
            if (recording != microphone) return;
            recording = null;
            try { microphone.stop(); } catch (IllegalStateException ignored) {}
            if (flush) {
                try { success(legacy.stopContinuous()); }
                catch (Exception error) { audioError = error.getMessage(); legacy.cancelContinuous(); }
            } else legacy.cancelContinuous();
        }
    }

    private void transfer(BufferedWriter writer, JSONObject request, String operation, JSONObject input) throws Exception {
        IAgentAtomicService service = structured;
        if (service == null) throw new IOException("需要安装支持 s23u.agent.atomic.v1 的原子服务");
        String requestId = request.getString("id");
        ArrayBlockingQueue<String> events = new ArrayBlockingQueue<>(256);
        IAgentAtomicCallback callback = new IAgentAtomicCallback.Stub() {
            @Override public void onEvent(String replyId, String eventJson) {
                if (!requestId.equals(replyId)) return;
                if (!events.offer(eventJson)) {
                    events.clear();
                    events.offer("{\"type\":\"error\",\"error\":\"原子能力响应队列已满\"}");
                }
            }
        };
        boolean finished = false;
        try {
            service.invoke(requestId, operation, input.toString(), callback);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(180);
            while (structured == service && !closed && System.nanoTime() < deadline) {
                String event = events.poll(250, TimeUnit.MILLISECONDS);
                if (event == null) continue;
                JSONObject value = new JSONObject(event);
                write(writer, value);
                String type = value.getString("type");
                if ("final".equals(type) || "error".equals(type)) {
                    finished = true;
                    return;
                }
            }
            throw new IOException("原子服务断开或请求超时");
        } finally {
            if (!finished) {
                try { service.cancel(requestId); } catch (Exception ignored) {}
            }
        }
    }

    private static JSONObject success(String raw) throws Exception {
        JSONObject response = new JSONObject(raw);
        if (!response.optBoolean("ok")) throw new IOException(response.optString("error", "原子能力调用失败"));
        return response;
    }

    private static void write(BufferedWriter writer, JSONObject value) throws IOException {
        writer.write(value.toString());
        writer.newLine();
        writer.flush();
    }

    @Override public void close() {
        closed = true;
        active = null;
        audioLifecycle.execute(() -> stopRecording(false));
        audioLifecycle.shutdown();
        try { server.close(); } catch (IOException ignored) {}
        clients.shutdownNow();
        main.post(() -> {
            legacy.close();
            if (bound) context.unbindService(connection);
        });
    }
}
