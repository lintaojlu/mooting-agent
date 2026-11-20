package com.s23u.atomicclient;

import android.content.Context;
import android.os.ParcelFileDescriptor;

import com.s23u.atomic.api.IAtomicCallback;
import com.s23u.atomic.api.IAtomicService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 仅用于“本地开发、手里还没有真机”阶段的假服务。
 *
 * <p>它实现完整的 {@link IAtomicService} 接口，返回结构与真机抓包完全一致的 JSON，
 * 让界面、SpeechTurn 汇聚、图谱渲染和流式卡片可以在没有 S23 Ultra 的情况下先跑通。
 *
 * <p>使用方式（见 {@code AtomicServiceBridge.useInjectedService}）：
 * <pre>
 *   AtomicServiceBridge.useInjectedService(new MockAtomicService(context));
 *   atomicBridge.bind();
 * </pre>
 *
 * <p>上真机前请删掉注入、改用真实 {@code com.s23u.atomicservice}。
 * 本文件的报文样本来自 2026-11-08 真机验收报告，字段名与数值区间均可直接用于布局。
 */
final class MockAtomicService extends IAtomicService.Stub {

    private static final int SAMPLE_RATE = 16000;
    private static final int FRAME_SAMPLES = 1600;        // 100 ms 一帧 vad_frame
    private static final int SPEECH_START_SAMPLES = 32000; // 2.0 s 后判为开口
    private static final int SPEECH_END_SAMPLES = 72000;   // 4.5 s 后判为一句话结束

    /** 真机抓包得到的 ASR 文本，按段循环使用。 */
    private static final String[] SEGMENT_TEXTS = {
            "大家好今天我们开会讨论一下项目进度目前整体开发已经完成百分之八十"
                    + "下周需要完成第一版交付请大家注意测试进度按时提交",
            "另外前端交互还需要再打磨一下尤其是流式输出的展示效果",
            "最后请各位把本周的测试结论汇总到共享文档里"
    };

    private final Context context;

    private final List<JSONObject> contacts = new ArrayList<>();

    private String continuousRequestId;
    private IAtomicCallback continuousCallback;
    private long samplesPushed;
    private long nextFrameSample;
    private long segmentStartSample;
    private boolean speechActive;
    private int segmentCount;

    MockAtomicService(Context context) {
        this.context = context == null ? null : context.getApplicationContext();
    }

    // ---------------------------------------------------------------- 查询

    @Override public String getServiceInfo() {
        try {
            JSONObject models = new JSONObject();
            addModel(models, "vad", 2327524L);
            addModel(models, "asr_context", 255197184L);
            addModel(models, "asr_tokens", 315894L);
            addModel(models, "vpr", 28281138L);
            addModel(models, "llm", 2375773472L);
            return new JSONObject()
                    .put("ok", true)
                    .put("atomic_api", "s23u.atomic.service.v1")
                    .put("service_package", "com.s23u.atomicservice")
                    .put("service_version", "1.2.0-dev3")
                    .put("llm_prompt_profile", "phone_assistant.v3")
                    .put("pid", 0)
                    .put("mock", true)
                    .put("capabilities", new JSONArray()
                            .put("s23u.vad.v1").put("s23u.asr.v1")
                            .put("s23u.llm.v1").put("s23u.vpr.v1")
                            .put("s23u.social_graph.v2")
                            .put("s23u.continuous_speech.v1"))
                    .put("models", models)
                    .toString();
        } catch (Exception error) {
            return errorJson(error);
        }
    }

    @Override public String getSocialGraphSnapshot() {
        try {
            JSONArray nodes = new JSONArray();
            for (JSONObject contact : contacts) nodes.put(contact);
            StringBuilder context = new StringBuilder();
            if (nodes.length() == 0) {
                context.append("暂无已确认联系人。");
            } else {
                for (int i = 0; i < contacts.size(); ++i) {
                    JSONObject contact = contacts.get(i);
                    if (i > 0) context.append("；");
                    context.append(contact.optString("name"))
                            .append("（").append(contact.optString("relation")).append("）")
                            .append("与当前使用者互动 ")
                            .append(contact.optInt("interactions")).append(" 次");
                }
                context.append("。");
            }
            return new JSONObject()
                    .put("ok", true)
                    .put("atomic_api", "s23u.social_graph.v2")
                    .put("center", new JSONObject().put("id", "self").put("name", "当前使用者"))
                    .put("nodes", nodes)
                    .put("edges", new JSONArray())
                    .put("context", context.toString())
                    .toString();
        } catch (Exception error) {
            return errorJson(error);
        }
    }

    @Override public String getMemoryStats() {
        return "{\"ok\":true,\"backend\":\"mock\",\"entries\":0}";
    }

    @Override public String listMemory(long beforeMs, String beforeId, String speakerId, int limit) {
        return "{\"ok\":true,\"backend\":\"mock\",\"items\":[]}";
    }

    @Override public String getMemoryGraph() {
        try {
            return new JSONObject().put("ok", true).put("backend", "mock")
                    .put("graph", new JSONObject(getSocialGraphSnapshot())).toString();
        } catch (Exception error) { return errorJson(error); }
    }

    @Override public String searchMemory(String query, String speakerId, int limit) {
        return listMemory(0, "", speakerId, limit);
    }

    @Override public void generateLlmForSpeaker(String requestId, String transcript, String historyContext,
                                                String speakerId, IAtomicCallback callback) {
        generateLlmStream(requestId, transcript, historyContext, callback);
    }

    // ---------------------------------------------------------------- 模型目录

    /** 假服务里没有真实模型文件，返回一份占位目录，保证配置页能正常显示。 */
    @Override public String listModels() {
        try {
            JSONObject active = new JSONObject()
                    .put("asr", "asr")
                    .put("vad", "vad/silero_vad.onnx")
                    .put("llm", "llm/qwen3-4b-q4_0.gguf")
                    .put("vpr", "vpr/campplus.onnx");
            JSONObject models = new JSONObject()
                    .put("asr", new JSONArray().put(new JSONObject()
                            .put("id", "asr").put("name", "asr（mock）").put("bytes", 0)))
                    .put("vad", new JSONArray().put(new JSONObject()
                            .put("id", "vad/silero_vad.onnx").put("name", "silero_vad.onnx（mock）").put("bytes", 0)))
                    .put("llm", new JSONArray().put(new JSONObject()
                            .put("id", "llm/qwen3-4b-q4_0.gguf").put("name", "qwen3-4b-q4_0.gguf（mock）").put("bytes", 0)))
                    .put("vpr", new JSONArray().put(new JSONObject()
                            .put("id", "vpr/campplus.onnx").put("name", "campplus.onnx（mock）").put("bytes", 0)));
            return new JSONObject()
                    .put("ok", true)
                    .put("mock", true)
                    .put("active", active)
                    .put("models", models).toString();
        } catch (Exception error) {
            return errorJson(error);
        }
    }

    @Override public String selectModel(String capability, String modelId) {
        try {
            return new JSONObject()
                    .put("ok", true)
                    .put("mock", true)
                    .put("capability", capability)
                    .put("id", modelId).toString();
        } catch (Exception error) {
            return errorJson(error);
        }
    }

    // ---------------------------------------------------------------- 整段 WAV

    @Override public void runVad(String requestId, ParcelFileDescriptor wav,
                                 IAtomicCallback callback) {
        try {
            sendFinal(callback, requestId, new JSONObject()
                    .put("ok", true)
                    .put("atomic_api", "s23u.vad.v1")
                    .put("speech_detected", true)
                    .put("frame_count", 477)
                    .put("event_count", 4)
                    .put("max_probability", 0.1686)
                    .put("max_rms", 0.314)
                    .put("inference_ms", 647.5188));
        } catch (Exception error) {
            sendError(callback, requestId, error);
        }
    }

    @Override public void runAsr(String requestId, ParcelFileDescriptor wav,
                                 IAtomicCallback callback) {
        try {
            sendFinal(callback, requestId, new JSONObject()
                    .put("ok", true)
                    .put("atomic_api", "s23u.asr.v1")
                    .put("engine", "QNN HTP V73")
                    .put("engine_reused", false)
                    .put("init_ms", 2142.731)
                    .put("inference_ms", 256.736)
                    .put("audio_seconds", 15.229)
                    .put("rtf", 0.017)
                    .put("result", new JSONObject()
                            .put("lang", "<|yue|>")
                            .put("emotion", "<|NEUTRAL|>")
                            .put("event", "<|Speech|>")
                            .put("text", SEGMENT_TEXTS[0])
                            .put("timestamps", new JSONArray())
                            .put("durations", new JSONArray())
                            .put("tokens", new JSONArray())
                            .put("ys_log_probs", new JSONArray())
                            .put("words", new JSONArray())));
        } catch (Exception error) {
            sendError(callback, requestId, error);
        }
    }

    @Override public void identifySpeaker(String requestId, ParcelFileDescriptor wav,
                                          IAtomicCallback callback) {
        try {
            sendFinal(callback, requestId, vprResult(1, 0.0, 15.229).put("embedding_ms", 2694.7326));
        } catch (Exception error) {
            sendError(callback, requestId, error);
        }
    }

    @Override public void enrollSpeaker(String requestId, String speakerId,
                                        String displayName, String relationType,
                                        ParcelFileDescriptor wav,
                                        IAtomicCallback callback) {
        try {
            synchronized (contacts) {
                boolean exists = false;
                for (JSONObject contact : contacts) {
                    if (contact.optString("id").equals(speakerId)) exists = true;
                }
                if (!exists) {
                    contacts.add(new JSONObject()
                            .put("id", speakerId)
                            .put("name", displayName == null || displayName.isEmpty()
                                    ? "未命名联系人" : displayName)
                            .put("relation", relationType == null || relationType.isEmpty()
                                    ? "联系人" : relationType)
                            .put("interactions", 0));
                }
            }
            sendFinal(callback, requestId, new JSONObject()
                    .put("ok", true)
                    .put("atomic_api", "s23u.vpr.v1")
                    .put("action", "enroll")
                    .put("speaker_id", speakerId)
                    .put("display_name", displayName)
                    .put("relation_type", relationType)
                    .put("embedding_ms", 183.5423)
                    .put("mock", true));
        } catch (Exception error) {
            sendError(callback, requestId, error);
        }
    }

    @Override public void deleteContact(String requestId, String speakerId,
                                        IAtomicCallback callback) {
        try {
            int removed = 0;
            synchronized (contacts) {
                for (int i = contacts.size() - 1; i >= 0; --i) {
                    if (contacts.get(i).optString("id").equals(speakerId)) {
                        contacts.remove(i);
                        ++removed;
                    }
                }
            }
            sendFinal(callback, requestId, new JSONObject()
                    .put("ok", true)
                    .put("atomic_api", "s23u.social_graph.v2")
                    .put("action", "delete_contact")
                    .put("speaker_id", speakerId)
                    .put("removed", removed)
                    .put("mock", true));
        } catch (Exception error) {
            sendError(callback, requestId, error);
        }
    }

    @Override public void recordSpeechTurn(String requestId, String speakerId,
                                           String transcript, long occurredAtMs,
                                           int segmentId, IAtomicCallback callback) {
        try {
            if (speakerId != null && !speakerId.isEmpty() && !"unknown".equals(speakerId)) {
                synchronized (contacts) {
                    for (JSONObject contact : contacts) {
                        if (!contact.optString("id").equals(speakerId)) continue;
                        contact.put("interactions", contact.optInt("interactions") + 1);
                    }
                }
            }
            sendFinal(callback, requestId, new JSONObject()
                    .put("ok", true)
                    .put("atomic_api", "s23u.social_graph.v2")
                    .put("action", "record_speech_turn")
                    .put("segment_id", segmentId)
                    .put("speaker_id", speakerId)
                    .put("transcript", transcript)
                    .put("occurred_at_ms", occurredAtMs)
                    .put("mock", true));
        } catch (Exception error) {
            sendError(callback, requestId, error);
        }
    }

    // ---------------------------------------------------------------- LLM

    @Override public void warmupLlm(String requestId, String historyContext,
                                    IAtomicCallback callback) {
        try {
            sendFinal(callback, requestId, llmResult(0, "", true)
                    .put("warmup", true)
                    .put("first_token_ms", 707.529)
                    .put("decode_ms", 5.454)
                    .put("generation_ms", 5.454)
                    .put("end_to_end_ms", 707.532)
                    .put("output_tokens", 1)
                    .put("output_chunks", 1));
        } catch (Exception error) {
            sendError(callback, requestId, error);
        }
    }

    @Override public void generateLlmStream(String requestId, String transcript,
                                            String historyContext,
                                            IAtomicCallback callback) {
        try {
            String reply = mockReply(transcript);
            // 切成小块模仿真机的流式节奏（真机约 3~5 字一块）。
            String[] chunks = splitChunks(reply);
            for (int i = 0; i < chunks.length; ++i) {
                send(callback, requestId, new JSONObject()
                        .put("type", "chunk")
                        .put("text", chunks[i])
                        .put("chunk_index", i));
            }
            sendFinal(callback, requestId, llmResult(chunks.length, reply, false)
                    .put("reply_stream", true)
                    .put("response", reply)
                    .put("summary", reply)
                    .put("first_token_ms", 204.895)
                    .put("prompt_eval_ms", 202.598)
                    .put("decode_ms", 855.849)
                    .put("generation_ms", 855.849)
                    .put("end_to_end_ms", 1058.447)
                    .put("tokens_per_second", 11.684));
        } catch (Exception error) {
            sendError(callback, requestId, error);
        }
    }

    @Override public void cancel(String requestId) {
        // 真机上是全局停止当前 LLM 生成；mock 的生成是同步的，无需处理。
    }

    // ---------------------------------------------------------------- 连续会话

    @Override public void startContinuous(String requestId, float probThreshold,
                                          float rmsThreshold, int windowSizeMs,
                                          int minSilenceMs, IAtomicCallback callback) {
        synchronized (this) {
            continuousRequestId = requestId;
            continuousCallback = callback;
            samplesPushed = 0L;
            nextFrameSample = 0L;
            segmentStartSample = 0L;
            speechActive = false;
            segmentCount = 0;
        }
        try {
            // 真机（2026-11-08 抓包）只回这个最小结构。这里刻意不加 session_id /
            // 阈值等自定义字段：否则你的解析代码上了真机会拿到 null。
            sendFinal(callback, requestId, new JSONObject()
                    .put("ok", true)
                    .put("atomic_api", "s23u.continuous_asr.v1")
                    .put("code", 0));
        } catch (Exception error) {
            sendError(callback, requestId, error);
        }
    }

    @Override public int pushContinuousPcm(String requestId, byte[] pcm16le, int sampleCount) {
        synchronized (this) {
            if (continuousRequestId == null || !continuousRequestId.equals(requestId)) return -2;
            if (pcm16le == null || sampleCount < 0 || sampleCount * 2 > pcm16le.length) return -3;
            samplesPushed += sampleCount;
            while (samplesPushed >= nextFrameSample) {
                emitVadFrame(nextFrameSample);
                nextFrameSample += FRAME_SAMPLES;
            }
            while (true) {
                long elapsed = samplesPushed - segmentStartSample;
                if (!speechActive && elapsed >= SPEECH_START_SAMPLES) {
                    speechActive = true;
                    emitVadEvent("speech_start", samplesPushed);
                } else if (speechActive && elapsed >= SPEECH_END_SAMPLES) {
                    speechActive = false;
                    finishSegment(segmentStartSample, samplesPushed);
                    segmentStartSample = samplesPushed;
                } else {
                    break;
                }
            }
            return 0;
        }
    }

    @Override public void stopContinuous(String requestId, IAtomicCallback callback) {
        String activeId;
        synchronized (this) {
            activeId = continuousRequestId;
            continuousRequestId = null;
            if (speechActive) {
                speechActive = false;
                finishSegment(segmentStartSample, samplesPushed);
            }
            emitVadEvent("speech_end_flush", samplesPushed);
        }
        try {
            // 与 startContinuous 的真机返回保持同一最小结构。
            sendFinal(callback, requestId, new JSONObject()
                    .put("ok", true)
                    .put("atomic_api", "s23u.continuous_asr.v1")
                    .put("code", 0));
        } catch (Exception error) {
            sendError(callback, requestId, error);
        }
    }

    @Override public void cancelContinuous(String requestId) {
        synchronized (this) {
            continuousRequestId = null;
            continuousCallback = null;
            speechActive = false;
        }
    }

    @Override public byte[] getPendingUnknownPcm() {
        return new byte[0];
    }

    @Override public void clearPendingUnknownAudio() {
        // mock 不缓存未知说话人音频。
    }

    // ---------------------------------------------------------------- 内部

    private void emitVadFrame(long atSample) {
        IAtomicCallback callback = continuousCallback;
        String id = continuousRequestId;
        if (callback == null || id == null) return;
        double seconds = atSample / (double) SAMPLE_RATE;
        boolean speaking = speechActive;
        try {
            send(callback, id, new JSONObject()
                    .put("type", "vad_frame")
                    .put("event", "none")
                    .put("time_seconds", round(seconds))
                    .put("probability", speaking ? 0.91 : 0.003383)
                    .put("rms", speaking ? 0.167 : 0.024837));
        } catch (Exception ignored) {
            // mock 不应因为一个坏事件打断调用方线程。
        }
    }

    private void emitVadEvent(String event, long atSample) {
        IAtomicCallback callback = continuousCallback;
        String id = continuousRequestId;
        if (callback == null || id == null) return;
        try {
            send(callback, id, new JSONObject()
                    .put("type", "vad")
                    .put("event", event)
                    .put("time_seconds", round(atSample / (double) SAMPLE_RATE))
                    .put("probability", 0.00391)
                    .put("rms", 0.079266));
        } catch (Exception ignored) {
            // ignore
        }
    }

    /** 一句话结束：依次吐 asr 与 vpr，segment_id 与真机一致。 */
    private void finishSegment(long startSample, long endSample) {
        IAtomicCallback callback = continuousCallback;
        String id = continuousRequestId;
        if (callback == null || id == null) return;
        ++segmentCount;
        int segmentId = segmentCount;
        double startSeconds = round(startSample / (double) SAMPLE_RATE);
        double endSeconds = round(endSample / (double) SAMPLE_RATE);
        String text = SEGMENT_TEXTS[(segmentId - 1) % SEGMENT_TEXTS.length];
        emitVadEvent("speech_end_max_duration", endSample);
        try {
            send(callback, id, new JSONObject()
                    .put("type", "asr")
                    .put("segment_id", segmentId)
                    .put("start_seconds", startSeconds)
                    .put("end_seconds", endSeconds)
                    .put("ok", true)
                    .put("text", text)
                    .put("error", "")
                    .put("inference_ms", 66.831)
                    .put("rtf", 0.005));
            // 第二段给一个“已认识”的说话人，方便验证图谱高亮与具名卡片。
            JSONObject vpr = segmentId == 2
                    ? new JSONObject()
                            .put("ok", true)
                            .put("known", true)
                            .put("speaker_id", "contact_zhangwei")
                            .put("contact_id", "contact_zhangwei")
                            .put("display_name", "张伟")
                            .put("similarity", 0.7124)
                            .put("threshold", 0.5)
                            .put("reason", "matched")
                            .put("embedding_ms", 183.5423)
                    : vprResult(segmentId, startSeconds, endSeconds).put("embedding_ms", 183.5423);
            send(callback, id, new JSONObject()
                    .put("type", "vpr")
                    .put("segment_id", segmentId)
                    .put("start_seconds", startSeconds)
                    .put("end_seconds", endSeconds)
                    .put("ok", vpr.optBoolean("ok", true))
                    .put("known", vpr.optBoolean("known", false))
                    .put("speaker_id", vpr.optString("speaker_id", "unknown"))
                    .put("contact_id", vpr.optString("contact_id", ""))
                    .put("display_name", vpr.optString("display_name", "未知说话人"))
                    .put("similarity", vpr.optDouble("similarity", 0.0))
                    .put("threshold", vpr.optDouble("threshold", 0.5))
                    .put("reason", vpr.optString("reason", ""))
                    .put("error", "")
                    .put("embedding_ms", vpr.optDouble("embedding_ms", 0.0)));
        } catch (Exception ignored) {
            // ignore
        }
    }

    private JSONObject vprResult(int segmentId, double startSeconds, double endSeconds)
            throws Exception {
        return new JSONObject()
                .put("ok", true)
                .put("atomic_api", "s23u.vpr.v1")
                .put("known", false)
                .put("speaker_id", "unknown")
                .put("contact_id", "")
                .put("display_name", "未知说话人")
                .put("similarity", 0.1533)
                .put("second_similarity", 0.0902)
                .put("threshold", 0.5)
                .put("reason", "below_threshold")
                .put("audio_seconds", round(endSeconds - startSeconds))
                .put("engine_reused", true);
    }

    private static JSONObject llmResult(int chunkCount, String text, boolean warmup)
            throws Exception {
        return new JSONObject()
                .put("ok", true)
                .put("atomic_api", "s23u.llm.v1")
                .put("provider", "mock / llama.cpp GGUF Hexagon HTP V73")
                .put("model_path", "/data/user/0/com.s23u.atomicservice/files/models/llm/qwen3-4b-q4_0.gguf")
                .put("reply_stream", !warmup)
                .put("response", text)
                .put("summary", text)
                .put("input_tokens", 295)
                .put("cached_prompt_tokens", 281)
                .put("evaluated_prompt_tokens", 14)
                .put("output_chunks", chunkCount)
                .put("init_ms", 7745.896)
                .put("mock", true);
    }

    private static String mockReply(String transcript) {
        if (transcript != null && transcript.contains("进度")) {
            return "理解：这段发言在同步项目进度与交付安排。"
                    + " 回应：目前整体开发完成约百分之八十，下周需要完成第一版交付，请注意测试进度并按时提交。";
        }
        if (transcript != null && transcript.contains("测试")) {
            return "理解：这段发言在安排测试与汇总工作。 回应：建议把本周结论统一汇总到共享文档。";
        }
        return "理解：已收到这段发言。 回应：这里会显示真机 Qwen3-4B 的输出。";
    }

    /** 按真机节奏把回复切成 1~4 字的小块。 */
    private static String[] splitChunks(String text) {
        List<String> chunks = new ArrayList<>();
        int index = 0;
        int size = 2;
        while (index < text.length()) {
            int end = Math.min(text.length(), index + size);
            chunks.add(text.substring(index, end));
            index = end;
            size = size >= 4 ? 1 : size + 1;
        }
        return chunks.toArray(new String[0]);
    }

    private static void addModel(JSONObject target, String name, long bytes) throws Exception {
        target.put(name, new JSONObject()
                .put("ready", true)
                .put("bytes", bytes)
                .put("path", "mock://models/" + name));
    }

    private static double round(double value) {
        return Math.round(value * 1000000d) / 1000000d;
    }

    private static void send(IAtomicCallback callback, String id, JSONObject event)
            throws Exception {
        if (callback != null) callback.onEvent(id, event.toString());
    }

    private static void sendFinal(IAtomicCallback callback, String id, JSONObject result) {
        try {
            send(callback, id, new JSONObject().put("type", "final").put("result", result));
        } catch (Exception ignored) {
            // ignore
        }
    }

    private static void sendError(IAtomicCallback callback, String id, Throwable error) {
        try {
            send(callback, id, new JSONObject()
                    .put("type", "error")
                    .put("error", error.toString()));
        } catch (Exception ignored) {
            // ignore
        }
    }

    private static String errorJson(Throwable error) {
        try {
            return new JSONObject().put("ok", false).put("error", error.toString()).toString();
        } catch (Exception impossible) {
            return "{\"ok\":false}";
        }
    }
}
