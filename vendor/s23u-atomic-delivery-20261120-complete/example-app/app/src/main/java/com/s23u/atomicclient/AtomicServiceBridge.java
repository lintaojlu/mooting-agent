package com.s23u.atomicclient;

import android.content.Context;
import android.os.ParcelFileDescriptor;

import com.s23u.atomic.api.AtomicClient;
import com.s23u.atomic.api.IAtomicCallback;
import com.s23u.atomic.api.IAtomicService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayDeque;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Application-side adapter for the device-resident atomic capability service.
 * It contains no model/runtime implementation. Blocking methods are called only
 * from the activity's worker executors.
 */
final class AtomicServiceBridge implements AutoCloseable {
    interface Listener {
        void onConnected(String serviceInfo);
        void onDisconnected(String reason);
    }

    interface StreamListener {
        void onChunk(String text, int index, boolean isFinal);
    }

    private interface WavCall {
        void invoke(IAtomicService service, String requestId,
                    ParcelFileDescriptor wav, IAtomicCallback callback) throws Exception;
    }

    private final Context context;
    private final Listener listener;
    private final AtomicClient client;
    private final Object eventLock = new Object();
    private final ArrayDeque<String> continuousEvents = new ArrayDeque<>();
    private volatile IAtomicService service;
    private volatile String continuousRequestId;

    /**
     * 本地开发用的注入点：设置后 {@link #bind()} 直接使用进程内的实现，
     * 不再去连接设备上的 com.s23u.atomicservice。上真机前必须清空。
     */
    private static volatile IAtomicService injectedService;

    static void useInjectedService(IAtomicService impl) { injectedService = impl; }

    static void clearInjectedService() { injectedService = null; }

    AtomicServiceBridge(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
        client = new AtomicClient(context, new AtomicClient.Listener() {
            @Override public void onConnected(IAtomicService value) {
                service = value;
                try { listener.onConnected(value.getServiceInfo()); }
                catch (Exception error) { listener.onDisconnected(error.toString()); }
            }

            @Override public void onDisconnected() {
                service = null;
                listener.onDisconnected("原子能力服务连接已断开");
            }

            @Override public void onError(String message) {
                service = null;
                listener.onDisconnected(message);
            }
        });
    }

    void bind() {
        IAtomicService injected = injectedService;
        if (injected != null) {
            service = injected;
            try {
                listener.onConnected(injected.getServiceInfo());
            } catch (Exception error) {
                service = null;
                listener.onDisconnected(error.toString());
            }
            return;
        }
        client.bind();
    }
    boolean isConnected() { return service != null; }

    String runAsr(File wav) throws Exception {
        return callWithWav(wav, (s, id, fd, callback) -> s.runAsr(id, fd, callback));
    }

    String identifySpeaker(short[] pcm) throws Exception {
        File wav = writeTemporaryWav(pcm, "vpr");
        try {
            return callWithWav(wav,
                    (s, id, fd, callback) -> s.identifySpeaker(id, fd, callback));
        } finally { wav.delete(); }
    }

    String enrollSpeaker(String speakerId, String displayName,
                         String relationType, short[] pcm) throws Exception {
        File wav = writeTemporaryWav(pcm, "enroll");
        try {
            return callWithWav(wav, (s, id, fd, callback) -> s.enrollSpeaker(
                    id, speakerId, displayName, relationType, fd, callback));
        } finally { wav.delete(); }
    }

    String deleteContact(String speakerId) throws Exception {
        return call(callback -> requireService().deleteContact(
                requestId("delete"), speakerId, callback));    }

    String socialGraphSnapshot() throws Exception {
        return requireService().getSocialGraphSnapshot();
    }

    String memoryStats() throws Exception { return requireService().getMemoryStats(); }

    String memoryGraph() throws Exception { return requireService().getMemoryGraph(); }

    String memoryPage(long beforeMs, String beforeId, String speakerId) throws Exception {
        return requireService().listMemory(beforeMs, beforeId, speakerId, 20);
    }

    String searchMemory(String query, String speakerId) throws Exception {
        return requireService().searchMemory(query, speakerId, 20);
    }

    /** 列出服务端实际存在的模型：{"ok":true,"active":{...},"models":{...}} */
    String listModels() throws Exception {
        return requireService().listModels();
    }

    /** 切换某个能力的模型，返回 {"ok":true,...} 或 {"ok":false,"error":...} */
    String selectModel(String capability, String modelId) throws Exception {
        return requireService().selectModel(capability, modelId);
    }

    String recordSpeechTurn(String speakerId, String transcript,
                            long occurredAtMs, int segmentId) throws Exception {
        return call(callback -> requireService().recordSpeechTurn(
                requestId("turn"), speakerId, transcript, occurredAtMs,
                segmentId, callback));
    }

    String warmupLlm(String history) throws Exception {
        return call(callback -> requireService().warmupLlm(
                requestId("warmup"), safe(history), callback));
    }

    String generateLlm(String transcript, String history, String speakerId,
                       StreamListener stream) throws Exception {
        IAtomicService value = requireService();
        String id = requestId("llm");
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        IAtomicCallback callback = new IAtomicCallback.Stub() {
                    int lastIndex;
                    @Override public void onEvent(String requestId, String eventJson) {
                        try {
                            JSONObject event = new JSONObject(eventJson);
                            String type = event.optString("type");
                            if ("chunk".equals(type)) {
                                lastIndex = event.optInt("chunk_index", lastIndex);
                                stream.onChunk(event.optString("text"), lastIndex, false);
                            } else if ("final".equals(type)) {
                                result.set(event.getJSONObject("result").toString());
                                stream.onChunk("", lastIndex + 1, true);
                                done.countDown();
                            } else if ("error".equals(type)) {
                                failure.set(new IllegalStateException(event.optString("error")));
                                done.countDown();
                            }
                        } catch (Throwable error) {
                            failure.set(error);
                            done.countDown();
                        }
                    }
                };
        try {
            value.generateLlmForSpeaker(id, safe(transcript), safe(history), safe(speakerId), callback);
        } catch (android.os.RemoteException unsupported) {
            if (!"Method generateLlmForSpeaker is unimplemented.".equals(unsupported.getMessage())) {
                throw unsupported;
            }
            value.generateLlmStream(id, safe(transcript), safe(history), callback);
        }
        return await(done, result, failure, 180);
    }

    String startContinuous(float probThreshold, float rmsThreshold,
                           int windowSizeMs, int minSilenceMs) throws Exception {
        IAtomicService value = requireService();
        String id = requestId("continuous");
        synchronized (eventLock) { continuousEvents.clear(); }
        CountDownLatch started = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        value.startContinuous(id, probThreshold, rmsThreshold, windowSizeMs,
                minSilenceMs, new IAtomicCallback.Stub() {
                    @Override public void onEvent(String requestId, String eventJson) {
                        try {
                            JSONObject event = new JSONObject(eventJson);
                            String type = event.optString("type");
                            if ("final".equals(type)) {
                                result.set(event.getJSONObject("result").toString());
                                started.countDown();
                            } else if ("error".equals(type)) {
                                failure.set(new IllegalStateException(event.optString("error")));
                                started.countDown();
                            } else {
                                synchronized (eventLock) {
                                    continuousEvents.addLast(event.toString());
                                }
                            }
                        } catch (Throwable error) {
                            failure.set(error);
                            started.countDown();
                        }
                    }
                });
        String raw = await(started, result, failure, 60);
        continuousRequestId = id;
        return raw;
    }

    int pushContinuous(short[] pcm, int count) throws Exception {
        String id = continuousRequestId;
        if (id == null) return -2;
        ByteBuffer bytes = ByteBuffer.allocate(count * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < count; ++i) bytes.putShort(pcm[i]);
        return requireService().pushContinuousPcm(id, bytes.array(), count);
    }

    String stopContinuous() throws Exception {
        String id = continuousRequestId;
        if (id == null) return new JSONObject().put("ok", false)
                .put("error", "No continuous session").toString();
        String raw = call(callback -> requireService().stopContinuous(id, callback));
        continuousRequestId = null;
        return raw;
    }

    void cancelContinuous() {
        String id = continuousRequestId;
        continuousRequestId = null;
        if (id == null || service == null) return;
        try { service.cancelContinuous(id); } catch (Exception ignored) {}
    }

    String pollContinuous() {
        JSONArray events = new JSONArray();
        synchronized (eventLock) {
            while (!continuousEvents.isEmpty()) {
                try { events.put(new JSONObject(continuousEvents.removeFirst())); }
                catch (Exception ignored) {}
            }
        }
        return events.toString();
    }

    short[] pendingUnknownPcm() {
        try {
            byte[] bytes = requireService().getPendingUnknownPcm();
            if (bytes == null || (bytes.length & 1) != 0) return new short[0];
            short[] pcm = new short[bytes.length / 2];
            ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
                    .asShortBuffer().get(pcm);
            return pcm;
        }
        catch (Exception error) { return new short[0]; }
    }

    void clearPendingUnknownAudio() {
        try { requireService().clearPendingUnknownAudio(); }
        catch (Exception ignored) {}
    }

    void cancelLlm() {
        try { if (service != null) service.cancel(requestId("llm_cancel")); }
        catch (Exception ignored) {}
    }

    private interface AsyncCall { void run(IAtomicCallback callback) throws Exception; }

    private String call(AsyncCall operation) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        operation.run(new IAtomicCallback.Stub() {
            @Override public void onEvent(String requestId, String eventJson) {
                try {
                    JSONObject event = new JSONObject(eventJson);
                    if ("final".equals(event.optString("type"))) {
                        result.set(event.getJSONObject("result").toString());
                        done.countDown();
                    } else if ("error".equals(event.optString("type"))) {
                        failure.set(new IllegalStateException(event.optString("error")));
                        done.countDown();
                    }
                } catch (Throwable error) {
                    failure.set(error);
                    done.countDown();
                }
            }
        });
        return await(done, result, failure, 180);
    }

    private String callWithWav(File wav, WavCall operation) throws Exception {
        String id = requestId("wav");
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        try (ParcelFileDescriptor descriptor = ParcelFileDescriptor.open(
                wav, ParcelFileDescriptor.MODE_READ_ONLY)) {
            operation.invoke(requireService(), id, descriptor,
                    new IAtomicCallback.Stub() {
                        @Override public void onEvent(String requestId, String eventJson) {
                            try {
                                JSONObject event = new JSONObject(eventJson);
                                if ("final".equals(event.optString("type"))) {
                                    result.set(event.getJSONObject("result").toString());
                                    done.countDown();
                                } else if ("error".equals(event.optString("type"))) {
                                    failure.set(new IllegalStateException(
                                            event.optString("error")));
                                    done.countDown();
                                }
                            } catch (Throwable error) {
                                failure.set(error);
                                done.countDown();
                            }
                        }
                    });
        }
        return await(done, result, failure, 180);
    }

    private static String await(CountDownLatch done,
                                AtomicReference<String> result,
                                AtomicReference<Throwable> failure,
                                int timeoutSeconds) throws Exception {
        if (!done.await(timeoutSeconds, TimeUnit.SECONDS)) {
            throw new IllegalStateException("原子能力服务调用超时");
        }
        if (failure.get() != null) throw new IllegalStateException(failure.get());
        if (result.get() == null) throw new IllegalStateException("服务返回空结果");
        return result.get();
    }

    private IAtomicService requireService() {
        IAtomicService value = service;
        if (value == null) throw new IllegalStateException("原子能力服务尚未连接");
        return value;
    }

    private File writeTemporaryWav(short[] pcm, String prefix) throws Exception {
        File target = new File(context.getCacheDir(), prefix + "_" + UUID.randomUUID() + ".wav");
        try (FileOutputStream out = new FileOutputStream(target, false)) {
            int dataBytes = pcm == null ? 0 : pcm.length * 2;
            out.write("RIFF".getBytes(StandardCharsets.US_ASCII));
            writeIntLe(out, 36 + dataBytes);
            out.write("WAVEfmt ".getBytes(StandardCharsets.US_ASCII));
            writeIntLe(out, 16); writeShortLe(out, 1); writeShortLe(out, 1);
            writeIntLe(out, 16000); writeIntLe(out, 32000);
            writeShortLe(out, 2); writeShortLe(out, 16);
            out.write("data".getBytes(StandardCharsets.US_ASCII));
            writeIntLe(out, dataBytes);
            if (pcm != null) {
                for (short sample : pcm) {
                    out.write(sample & 0xff);
                    out.write((sample >> 8) & 0xff);
                }
            }
        }
        return target;
    }

    private static void writeIntLe(FileOutputStream out, int value) throws Exception {
        out.write(value & 0xff); out.write((value >> 8) & 0xff);
        out.write((value >> 16) & 0xff); out.write((value >> 24) & 0xff);
    }

    private static void writeShortLe(FileOutputStream out, int value) throws Exception {
        out.write(value & 0xff); out.write((value >> 8) & 0xff);
    }

    private static String requestId(String capability) {
        return capability + "-" + UUID.randomUUID();
    }

    private static String safe(String value) { return value == null ? "" : value; }

    @Override public void close() {
        cancelContinuous();
        client.close();
        service = null;
        injectedService = null;
    }
}
