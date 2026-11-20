package com.s23u.atomicclient;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;
import org.json.JSONArray;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public final class MainActivity extends Activity {
    private static final String PIPELINE_TAG = "S23U_ASR_LLM_PIPELINE";
    private static final String MODEL_FILE = "model.bin";
    private static final String TOKENS_FILE = "tokens.txt";
    private static final String FIXED_AUDIO_FILE = "test_meeting.wav";
    private static final String VAD_FILE = "silero_vad.onnx";
    private static final String VPR_MODEL_FILE =
            "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx";
    private static final String LLM_MODEL_FILE = "meeting_summary_qwen3.gguf";
    private static final long MODEL_BYTES = 255197184L;
    private static final long TOKENS_BYTES = 315894L;
    private static final long FIXED_AUDIO_BYTES = 487382L;
    private static final long VAD_BYTES = 2327524L;
    private static final long VPR_MODEL_BYTES = 28281138L;
    private static final int SAMPLE_RATE = 16000;
    private static final int RECORD_PERMISSION_REQUEST = 1001;
    private static final int GLASSES_PERMISSION_REQUEST = 1002;
    private static final long MAX_RECORDING_MS = 30000L;

    private final ExecutorService inferenceWorker = Executors.newSingleThreadExecutor();
    private final ExecutorService llmWorker = Executors.newSingleThreadExecutor();
    private final ExecutorService graphWorker = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private AtomicServiceBridge atomicBridge;
    private TextView statusView;
    private TextView resultView;
    private TextView metricsView;
    private Button fixedButton;
    private Button recordButton;
    private Button continuousButton;
    private Button summaryButton;
    private Button vprButton;
    private Button socialGraphButton;
    private Button manageMembersButton;
    private Button enrollSelfButton;
    private Button enrollNewButton;
    private Button unknownEnrollButton;
    private Button unknownDismissButton;
    private SocialGraphView socialGraphView;
    private TextView graphContextView;
    private PipelineFlowView pipelineFlowView;
    private TextView llmView;
    private TextView capabilityView;
    private String loadError = "";
    private volatile String atomicServiceInfo = "";
    private volatile boolean recording;
    private volatile boolean inferenceRunning;
    private AudioRecord audioRecord;
    private Button bluetoothAudioButton;
    private Button glassesAudioButton;
    private TextView audioInputView;
    private boolean bluetoothAudioEnabled;
    private GlassesAudio glassesAudio;
    private int glassesSource = -1;
    private String glassesAudioDetail = "";
    private String recordingInputName = "手机麦克风";
    private Thread recordingThread;
    private ByteArrayOutputStream recordedPcm;
    private long recordingStartMs;
    private volatile boolean continuousMode;
    private volatile boolean continuousStarting;
    private volatile long continuousSampleCount;
    private volatile int continuousPcmPeak;
    private volatile double continuousMaxVadProbability;
    private volatile double continuousMaxVadRms;
    private int pendingAutoStopSeconds;
    private float vadProbThreshold = 0.8f;
    private float vadRmsThreshold = 0.01f;
    private int vadWindowSizeMs = 32;
    private int vadMinSilenceMs = 500;
    private final StringBuilder continuousTranscript = new StringBuilder();
    private volatile String currentTranscript = "";
    private volatile String lastSummary = "";
    private volatile String liveGraphContext = "";
    private volatile boolean llmWarmupReady;
    private final AtomicInteger pendingLlmTurns = new AtomicInteger();
    private final AtomicInteger llmTurnSequence = new AtomicInteger();
    private final Object llmLogLock = new Object();
    private final StringBuilder completedLlmTurns = new StringBuilder();
    private volatile boolean fixedPipelineTestActive;
    private volatile boolean fixedPipelineAsrDone;
    private String recordingPurpose = "asr";
    private String enrollmentSpeakerId = "";
    private String enrollmentDisplayName = "";
    private String enrollmentRelation = "";
    private Button activeRecordButton;
    private String activeRecordButtonDefaultText = "";
    private final Map<Integer, PendingTurn> pendingTurns = new HashMap<>();
    private static final long TURN_ASSEMBLY_TIMEOUT_MS = 3000L;
    private static final int UNKNOWN_CONFIRMATION_TURNS = 2;
    private static final long UNKNOWN_SEQUENCE_WINDOW_MS = 20000L;
    private static final long UNKNOWN_OFFER_COOLDOWN_MS = 300000L;
    private int consecutiveReliableUnknowns;
    private long lastReliableUnknownMs;
    private long unknownOfferSnoozedUntilMs;
    private boolean unknownOfferVisible;

    private static final class AsrTurn {
        final int id;
        final double startSeconds;
        final double endSeconds;
        final String text;
        final String speakerId;
        final String contactId;
        final String speakerName;
        final double speakerScore;
        final double asrInferenceMs;
        final long asrCompletedAtMs;

        AsrTurn(int id, double startSeconds, double endSeconds, String text,
                String speakerId, String contactId, String speakerName,
                double speakerScore, double asrInferenceMs,
                long asrCompletedAtMs) {
            this.id = id;
            this.startSeconds = startSeconds;
            this.endSeconds = endSeconds;
            this.text = text;
            this.speakerId = speakerId;
            this.contactId = contactId;
            this.speakerName = speakerName;
            this.speakerScore = speakerScore;
            this.asrInferenceMs = asrInferenceMs;
            this.asrCompletedAtMs = asrCompletedAtMs;
        }

        String promptText() {
            return String.format(Locale.US, "[%s][片段%d %.2f–%.2f s] %s",
                    speakerName, id, startSeconds, endSeconds, text);
        }

        String displayHeader() {
            String completedAt = new SimpleDateFormat(
                    "HH:mm:ss.SSS", Locale.getDefault()).format(new Date(asrCompletedAtMs));
            return String.format(Locale.US,
                    "[ASR #%d · %.2f–%.2f s][%s · VPR %.3f]\n"
                            + "[ASR完成 %s · 推理 %.1f ms]\n%s\n",
                    id, startSeconds, endSeconds, speakerName, speakerScore,
                    completedAt, asrInferenceMs, text);
        }
    }

    private static final class PendingTurn {
        final int segmentId;
        final long createdAtMs = SystemClock.elapsedRealtime();
        double startSeconds;
        double endSeconds;
        String text;
        double asrInferenceMs;
        double asrRtf;
        long asrCompletedAtMs;
        boolean asrReady;
        boolean vprReady;
        boolean vprKnown;
        String speakerId = "unknown";
        String contactId = "";
        String speakerName = "未知说话人";
        double speakerScore;
        String vprReason = "pending";

        PendingTurn(int segmentId) { this.segmentId = segmentId; }
    }

    private interface LlmStreamCallback {
        void onChunk(String text, int chunkIndex, boolean isFinal);
    }

    private interface BridgeCall<T> { T run() throws Exception; }

    private <T> T bridgeCall(BridgeCall<T> call) {
        try { return call.run(); }
        catch (Exception error) { throw new IllegalStateException(error); }
    }

    private String runNative(String modelDir, String nativeLibDir, String audioPath) {
        return bridgeCall(() -> atomicBridge.runAsr(new File(audioPath)));
    }
    private String startContinuousNative(String modelDir, String nativeLibDir,
                                         String vadModelPath, String vprModelPath,
                                         String vprRegistryPath, String graphDatabasePath,
                                         float probThreshold, float rmsThreshold,
                                         int windowSizeMs, int minSilenceMs) {
        return bridgeCall(() -> atomicBridge.startContinuous(probThreshold,
                rmsThreshold, windowSizeMs, minSilenceMs));
    }
    private int pushContinuousNative(short[] pcm, int count) {
        return bridgeCall(() -> atomicBridge.pushContinuous(pcm, count));
    }
    private String stopContinuousNative() {
        return bridgeCall(() -> atomicBridge.stopContinuous());
    }
    private void cancelContinuousNative() {
        if (atomicBridge != null) atomicBridge.cancelContinuous();
    }
    private String pollContinuousNative() {
        return atomicBridge == null ? "[]" : atomicBridge.pollContinuous();
    }
    private short[] getPendingUnknownPcmNative() {
        return atomicBridge == null ? new short[0] : atomicBridge.pendingUnknownPcm();
    }
    private void clearPendingUnknownAudioNative() {
        if (atomicBridge != null) atomicBridge.clearPendingUnknownAudio();
    }
    private String runLlmSummaryStreamNative(String modelPath,
                                             String nativeLibDir,
                                             String transcript,
                                             String historySummary,
                                             String speakerId,
                                             LlmStreamCallback callback) {
        return bridgeCall(() -> atomicBridge.generateLlm(transcript, historySummary,
                speakerId, callback::onChunk));
    }
    private String warmupLlmNative(String modelPath, String nativeLibDir,
                                   String historyContext) {
        return bridgeCall(() -> atomicBridge.warmupLlm(historyContext));
    }
    private void cancelLlmNative() {
        if (atomicBridge != null) atomicBridge.cancelLlm();
    }
    private void releaseLlmNative() { /* Model lifetime belongs to the service. */ }
    private String runVprSelfTestNative(String modelPath, String registryPath,
                                        short[] pcm) {
        return bridgeCall(() -> atomicBridge.identifySpeaker(pcm));
    }
    private String runSocialGraphSelfTestNative(String databasePath) {
        return bridgeCall(() -> atomicBridge.socialGraphSnapshot());
    }
    private String enrollSpeakerNative(String modelPath, String registryPath,
                                       String graphDatabasePath, String speakerId,
                                       String displayName, String relationType,
                                       short[] pcm) {
        return bridgeCall(() -> atomicBridge.enrollSpeaker(speakerId, displayName,
                relationType, pcm));
    }
    private String getSocialGraphSnapshotNative(String databasePath) {
        return bridgeCall(() -> atomicBridge.socialGraphSnapshot());
    }
    private String deleteContactNative(String modelPath, String registryPath,
                                       String databasePath, String speakerId) {
        return bridgeCall(() -> atomicBridge.deleteContact(speakerId));
    }
    private String recordSpeechTurnNative(String databasePath, String speakerId,
                                          String transcript, long occurredAtMs,
                                          int segmentId) {
        return bridgeCall(() -> atomicBridge.recordSpeechTurn(speakerId,
                transcript, occurredAtMs, segmentId));
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        BluetoothAudio.get().init(this);
        BluetoothAudio.get().setListener((connected, detail) -> runOnUiThread(() -> {
            if (bluetoothAudioEnabled) updateAudioInput(detail);
        }));
        glassesAudio = new GlassesAudio(this, this::onGlassesAudioState);
        setContentView(createContentView());
        vadProbThreshold = getIntent().getFloatExtra(
                "vad_prob_threshold", vadProbThreshold);
        vadRmsThreshold = getIntent().getFloatExtra(
                "vad_rms_threshold", vadRmsThreshold);
        vadWindowSizeMs = getIntent().getIntExtra(
                "vad_window_size_ms", vadWindowSizeMs);
        vadMinSilenceMs = getIntent().getIntExtra(
                "vad_min_silence_ms", vadMinSilenceMs);
        loadError = "正在连接原子能力服务";
        statusView.setText("状态：正在连接 com.s23u.atomicservice……");
        setControlsEnabled(false);
        // 本地联调入口：没有真机时用
        //   adb shell am start -n com.s23u.atomicclient/.MainActivity --ez mock_service true
        // 让应用接进程内的 MockAtomicService；真机验收不要带这个参数。
        if (getIntent().getBooleanExtra("mock_service", false)) {
            AtomicServiceBridge.useInjectedService(new MockAtomicService(this));
        }
        atomicBridge = new AtomicServiceBridge(this,
                new AtomicServiceBridge.Listener() {
                    @Override public void onConnected(String info) {
                        runOnUiThread(() -> onAtomicServiceConnected(info));
                    }
                    @Override public void onDisconnected(String reason) {
                        runOnUiThread(() -> {
                            loadError = reason;
                            statusView.setText("状态：原子能力服务未连接");
                            resultView.setText(reason + "\n请先安装 S23U 原子能力服务 APK。");
                            setControlsEnabled(false);
                        });
                    }
                });
        atomicBridge.bind();
    }

    private void onAtomicServiceConnected(String info) {
        try {
            atomicServiceInfo = info;
            ensureServicePlaceholders();
            loadError = "";
            statusView.setText("状态：原子能力服务已连接 / 可开始使用");
            metricsView.setText("独立 APP → AIDL/Binder → 原子能力服务\n" + info);
            setControlsEnabled(true);
            refreshSocialGraph();
            int requestedSeconds = getIntent().getIntExtra("auto_continuous_seconds", 0);
            if (requestedSeconds >= 5 && requestedSeconds <= 120) {
                pendingAutoStopSeconds = requestedSeconds;
                mainHandler.postDelayed(this::onContinuousClick, 800);
            } else if (getIntent().getBooleanExtra("auto_fixed_pipeline", false)) {
                mainHandler.postDelayed(this::runFixedContinuousLlmPipeline, 1200);
            }
        } catch (Throwable error) {
            loadError = error.toString();
            statusView.setText("状态：客户端初始化失败");
            resultView.setText(loadError);
            setControlsEnabled(false);
        }
    }

    private void ensureServicePlaceholders() throws Exception {
        File llmDir = new File(getFilesDir(), "llm");
        if (!llmDir.isDirectory() && !llmDir.mkdirs()) {
            throw new IllegalStateException("无法创建客户端状态目录：" + llmDir);
        }
        File marker = new File(llmDir, LLM_MODEL_FILE);
        if (!marker.isFile() && !marker.createNewFile()) {
            throw new IllegalStateException("无法创建服务就绪标记：" + marker);
        }
    }

    private View createContentView() {
        int pad = dp(20);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad, pad, pad);
        root.setBackgroundColor(Color.rgb(248, 250, 252));

        TextView title = text("S23U 原子助手", 25, Color.rgb(15, 23, 42));
        title.setGravity(Gravity.CENTER_HORIZONTAL);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        root.addView(title, matchWrap(dp(8)));

        TextView subtitle = text("独立应用层 → AIDL/Binder → 五项原子能力服务", 15,
                Color.rgb(71, 85, 105));
        subtitle.setGravity(Gravity.CENTER_HORIZONTAL);
        root.addView(subtitle, matchWrap(dp(22)));

        Button mootingButton = new Button(this);
        mootingButton.setText("MootingAgent");
        mootingButton.setTextSize(17);
        mootingButton.setAllCaps(false);
        mootingButton.setOnClickListener(view -> startActivity(
                new android.content.Intent(this, MootingAgentActivity.class)));
        root.addView(mootingButton, matchWrap(dp(12)));

        // 蓝牙联调入口放在最顶部：独立 Activity，不影响下面任何原子能力流程。
        Button bluetoothButton = new Button(this);
        bluetoothButton.setText("蓝牙连接测试（PC 联调）");
        bluetoothButton.setTextSize(17);
        bluetoothButton.setAllCaps(false);
        bluetoothButton.setOnClickListener(v -> startActivity(
                new android.content.Intent(this, BluetoothProbeActivity.class)));
        LinearLayout.LayoutParams bluetoothParams =
                new LinearLayout.LayoutParams(-1, dp(56));
        bluetoothParams.bottomMargin = dp(18);
        root.addView(bluetoothButton, bluetoothParams);

        // 蓝牙音频开关：打开后所有需要麦克风的能力都改吃电脑传来的 PCM。
        bluetoothAudioButton = new Button(this);
        bluetoothAudioButton.setTextSize(16);
        bluetoothAudioButton.setAllCaps(false);
        bluetoothAudioButton.setOnClickListener(v -> toggleBluetoothAudio());
        LinearLayout.LayoutParams btAudioParams = new LinearLayout.LayoutParams(-1, dp(62));
        btAudioParams.bottomMargin = dp(8);
        root.addView(bluetoothAudioButton, btAudioParams);

        glassesAudioButton = new Button(this);
        glassesAudioButton.setTextSize(16);
        glassesAudioButton.setAllCaps(false);
        glassesAudioButton.setOnClickListener(v -> toggleGlassesAudio());
        root.addView(glassesAudioButton, matchWrap(dp(8)));

        // 音频输入来源指示：让"手机麦克风是否已关闭"一眼可见。
        audioInputView = text("", 14, Color.rgb(15, 23, 42));
        audioInputView.setPadding(dp(12), dp(10), dp(12), dp(10));
        audioInputView.setBackgroundColor(Color.WHITE);
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(-1, -2);
        inputParams.bottomMargin = dp(18);
        root.addView(audioInputView, inputParams);

        // 模型配置入口：为 ASR / VAD / LLM / 声纹 各自选择要用的模型。
        Button modelConfigButton = new Button(this);
        modelConfigButton.setText("模型配置 · ASR / VAD / LLM / 声纹");
        modelConfigButton.setTextSize(16);
        modelConfigButton.setAllCaps(false);
        modelConfigButton.setOnClickListener(v -> startActivity(
                new android.content.Intent(this, ModelConfigActivity.class)));
        LinearLayout.LayoutParams modelConfigParams =
                new LinearLayout.LayoutParams(-1, dp(56));
        modelConfigParams.bottomMargin = dp(18);
        root.addView(modelConfigButton, modelConfigParams);

        Button memoryButton = new Button(this);
        memoryButton.setText("记忆库 · 历史对话 / 社交图谱");
        memoryButton.setTextSize(16);
        memoryButton.setAllCaps(false);
        memoryButton.setOnClickListener(v -> startActivity(
                new android.content.Intent(this, MemoryActivity.class)));
        root.addView(memoryButton, matchWrap(dp(8)));

        // 智能眼镜联调入口：BLE GATT 链路自检（与 PC 联调页同样风格）。
        Button glassesButton = new Button(this);
        glassesButton.setText("蓝牙连接调试（智能眼镜联调）");
        glassesButton.setTextSize(16);
        glassesButton.setAllCaps(false);
        glassesButton.setOnClickListener(v -> {
            if (!canChangeAudioInput()) return;
            if (glassesSource >= 0) {
                disableGlassesAudio();
                updateAudioInput("");
            }
            startActivity(new Intent(this, GlassesProbeActivity.class));
        });
        LinearLayout.LayoutParams glassesParams =
                new LinearLayout.LayoutParams(-1, dp(56));
        glassesParams.bottomMargin = dp(18);
        root.addView(glassesButton, glassesParams);

        updateAudioInput("");

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(14), dp(16), dp(14));
        card.setBackgroundColor(Color.WHITE);
        String soc = Build.VERSION.SDK_INT >= 31 ? Build.SOC_MODEL : "SM8550";
        card.addView(text("设备：" + Build.MODEL + " / " + soc, 15, Color.rgb(30, 41, 59)));
        card.addView(text("当前基线：ASR / SenseVoice Small INT8 / QNN HTP V73", 15, Color.rgb(30, 41, 59)));
        card.addView(text("音频契约：WAV · PCM16 · 单声道 · 16 kHz", 15, Color.rgb(30, 41, 59)));
        root.addView(card, matchWrap(dp(18)));

        statusView = text("状态：等待测试", 16, Color.rgb(37, 99, 235));
        statusView.setTypeface(null, android.graphics.Typeface.BOLD);
        root.addView(statusView, matchWrap(dp(12)));

        Button serviceAcceptanceButton = new Button(this);
        serviceAcceptanceButton.setText("查看原子能力服务连接信息");
        serviceAcceptanceButton.setTextSize(16);
        serviceAcceptanceButton.setAllCaps(false);
        serviceAcceptanceButton.setOnClickListener(v -> new AlertDialog.Builder(this)
                .setTitle("原子能力服务")
                .setMessage(atomicServiceInfo.isEmpty()
                        ? "尚未连接 com.s23u.atomicservice" : atomicServiceInfo)
                .setPositiveButton("关闭", null).show());
        LinearLayout.LayoutParams acceptanceParams =
                new LinearLayout.LayoutParams(-1, dp(56));
        acceptanceParams.bottomMargin = dp(14);
        root.addView(serviceAcceptanceButton, acceptanceParams);

        fixedButton = new Button(this);
        fixedButton.setText("固定 WAV 回归测试");
        fixedButton.setTextSize(16);
        fixedButton.setAllCaps(false);
        fixedButton.setOnClickListener(v -> runFixedAudio());
        root.addView(fixedButton, new LinearLayout.LayoutParams(-1, dp(52)));

        recordButton = new Button(this);
        recordButton.setText("按住说话 · 松开识别");
        recordButton.setTextSize(17);
        recordButton.setAllCaps(false);
        recordButton.setOnTouchListener(this::onRecordTouch);
        LinearLayout.LayoutParams recordParams = new LinearLayout.LayoutParams(-1, dp(62));
        recordParams.topMargin = dp(10);
        recordParams.bottomMargin = dp(16);
        root.addView(recordButton, recordParams);

        continuousButton = new Button(this);
        continuousButton.setText("开始连续识别");
        continuousButton.setTextSize(17);
        continuousButton.setAllCaps(false);
        continuousButton.setOnClickListener(v -> onContinuousClick());
        LinearLayout.LayoutParams continuousParams = new LinearLayout.LayoutParams(-1, dp(58));
        continuousParams.bottomMargin = dp(16);
        root.addView(continuousButton, continuousParams);

        summaryButton = new Button(this);
        summaryButton.setText("固定 WAV：连续 ASR → LLM");
        summaryButton.setTextSize(17);
        summaryButton.setAllCaps(false);
        summaryButton.setEnabled(true);
        summaryButton.setOnClickListener(v -> runFixedContinuousLlmPipeline());
        LinearLayout.LayoutParams summaryParams = new LinearLayout.LayoutParams(-1, dp(58));
        summaryParams.bottomMargin = dp(16);
        root.addView(summaryButton, summaryParams);

        vprButton = new Button(this);
        vprButton.setText("测试声纹识别原子能力");
        vprButton.setTextSize(16);
        vprButton.setAllCaps(false);
        vprButton.setOnClickListener(v -> runVprAtomicTest());
        LinearLayout.LayoutParams vprParams = new LinearLayout.LayoutParams(-1, dp(54));
        vprParams.bottomMargin = dp(10);
        root.addView(vprButton, vprParams);

        LinearLayout enrollmentRow = new LinearLayout(this);
        enrollmentRow.setOrientation(LinearLayout.HORIZONTAL);
        enrollSelfButton = new Button(this);
        enrollSelfButton.setText("录入当前使用者");
        enrollSelfButton.setTextSize(14);
        enrollSelfButton.setAllCaps(false);
        enrollSelfButton.setOnClickListener(v -> startEnrollment(
                "self", "当前使用者", "本人", enrollSelfButton));
        enrollmentRow.addView(enrollSelfButton,
                new LinearLayout.LayoutParams(0, dp(52), 1));
        enrollNewButton = new Button(this);
        enrollNewButton.setText("录入新联系人");
        enrollNewButton.setTextSize(14);
        enrollNewButton.setAllCaps(false);
        enrollNewButton.setOnClickListener(v -> showNewContactDialog(enrollNewButton));
        LinearLayout.LayoutParams secondParams =
                new LinearLayout.LayoutParams(0, dp(52), 1);
        secondParams.leftMargin = dp(8);
        enrollmentRow.addView(enrollNewButton, secondParams);
        root.addView(enrollmentRow, matchWrap(dp(10)));

        LinearLayout unknownRow = new LinearLayout(this);
        unknownRow.setOrientation(LinearLayout.HORIZONTAL);
        unknownEnrollButton = new Button(this);
        unknownEnrollButton.setText("检测到未匹配声纹 · 录入并命名");
        unknownEnrollButton.setTextSize(14);
        unknownEnrollButton.setAllCaps(false);
        unknownEnrollButton.setVisibility(View.GONE);
        unknownEnrollButton.setOnClickListener(v -> openUnknownEnrollmentFlow());
        unknownRow.addView(unknownEnrollButton,
                new LinearLayout.LayoutParams(0, dp(52), 3));
        unknownDismissButton = new Button(this);
        unknownDismissButton.setText("忽略");
        unknownDismissButton.setTextSize(14);
        unknownDismissButton.setAllCaps(false);
        unknownDismissButton.setVisibility(View.GONE);
        unknownDismissButton.setOnClickListener(v -> dismissUnknownOffer());
        LinearLayout.LayoutParams dismissParams =
                new LinearLayout.LayoutParams(0, dp(52), 1);
        dismissParams.leftMargin = dp(8);
        unknownRow.addView(unknownDismissButton, dismissParams);
        root.addView(unknownRow, new LinearLayout.LayoutParams(-1, dp(52)));

        socialGraphButton = new Button(this);
        socialGraphButton.setText("测试社交图谱原子能力");
        socialGraphButton.setTextSize(16);
        socialGraphButton.setAllCaps(false);
        socialGraphButton.setOnClickListener(v -> runSocialGraphAtomicTest());
        LinearLayout.LayoutParams graphParams = new LinearLayout.LayoutParams(-1, dp(54));
        graphParams.bottomMargin = dp(16);
        root.addView(socialGraphButton, graphParams);

        manageMembersButton = new Button(this);
        manageMembersButton.setText("管理图谱成员 · 添加 / 删除");
        manageMembersButton.setTextSize(16);
        manageMembersButton.setAllCaps(false);
        manageMembersButton.setOnClickListener(v -> showMemberManagementDialog());
        LinearLayout.LayoutParams manageParams = new LinearLayout.LayoutParams(-1, dp(54));
        manageParams.bottomMargin = dp(16);
        root.addView(manageMembersButton, manageParams);

        root.addView(text("以当前使用者为中心的社交图谱", 17,
                Color.rgb(15, 23, 42)), matchWrap(dp(8)));
        socialGraphView = new SocialGraphView(this);
        socialGraphView.setBackgroundColor(Color.WHITE);
        root.addView(socialGraphView, new LinearLayout.LayoutParams(-1, dp(320)));

        root.addView(text("实时生成给 LLM 的图谱上下文", 17,
                Color.rgb(15, 23, 42)), matchWrap(dp(8)));
        graphContextView = text("正在读取正式联系人图谱……", 15,
                Color.rgb(71, 85, 105));
        graphContextView.setTextIsSelectable(true);
        graphContextView.setPadding(dp(14), dp(14), dp(14), dp(14));
        graphContextView.setBackgroundColor(Color.WHITE);
        root.addView(graphContextView, matchWrap(dp(12)));

        root.addView(text("系统数据流（调试视图）", 17,
                Color.rgb(15, 23, 42)), matchWrap(dp(8)));
        pipelineFlowView = new PipelineFlowView(this);
        pipelineFlowView.setBackgroundColor(Color.WHITE);
        root.addView(pipelineFlowView, new LinearLayout.LayoutParams(-1, dp(220)));

        root.addView(text("VPR / 社交图谱测试结果", 17, Color.rgb(15, 23, 42)),
                matchWrap(dp(8)));
        capabilityView = text("声纹只保存 embedding，不保存原始录音；社交图谱写入原子服务私有目录。",
                15, Color.rgb(100, 116, 139));
        capabilityView.setTextIsSelectable(true);
        capabilityView.setPadding(dp(14), dp(14), dp(14), dp(14));
        capabilityView.setBackgroundColor(Color.WHITE);
        root.addView(capabilityView, matchWrap(dp(12)));

        root.addView(text("识别结果", 17, Color.rgb(15, 23, 42)), matchWrap(dp(8)));
        resultView = text("可运行固定 WAV 回归，或按住按钮说话。录音仅保存在 App 私有目录。",
                18, Color.rgb(30, 41, 59));
        resultView.setTextIsSelectable(true);
        resultView.setPadding(dp(14), dp(14), dp(14), dp(14));
        resultView.setBackgroundColor(Color.WHITE);
        root.addView(resultView, matchWrap(dp(12)));

        root.addView(text("流式 ASR → LLM 回答 / 总结", 17, Color.rgb(15, 23, 42)), matchWrap(dp(8)));
        llmView = text("连续识别产生的每个 SpeechTurn 会自动进入 s23u.llm.v1；"
                        + "直接问题会回答，会议陈述会增量总结，流式片段在此显示。",
                15, Color.rgb(100, 116, 139));
        llmView.setPadding(dp(14), dp(14), dp(14), dp(14));
        llmView.setBackgroundColor(Color.WHITE);
        root.addView(llmView, matchWrap(dp(12)));

        metricsView = text("", 14, Color.rgb(71, 85, 105));
        metricsView.setTextIsSelectable(true);
        root.addView(metricsView, matchWrap(0));

        ScrollView scroll = new ScrollView(this);
        scroll.addView(root);
        return scroll;
    }

    private boolean onRecordTouch(View view, MotionEvent event) {
        if (!loadError.isEmpty() || inferenceRunning) return true;
        if (event.getAction() == MotionEvent.ACTION_DOWN) {
            if (waitingForGlassesAudio()) return true;
            if (externalAudio() == null && !hasRecordPermission()) {
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},
                        RECORD_PERMISSION_REQUEST);
                statusView.setText("状态：请允许麦克风权限后再次按住说话");
                return true;
            }
            recordingPurpose = "asr";
            activeRecordButton = recordButton;
            startVoiceRecording();
            return true;
        }
        if (event.getAction() == MotionEvent.ACTION_UP ||
                event.getAction() == MotionEvent.ACTION_CANCEL) {
            if (recording) finishVoiceRecording();
            return true;
        }
        return true;
    }

    private boolean hasRecordPermission() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == GLASSES_PERMISSION_REQUEST) {
            if (glassesSource >= 0 && hasGlassesPermissions()) {
                glassesAudio.connect(glassesSource);
            } else if (glassesSource >= 0) {
                onGlassesAudioState(false, true, "需要允许附近设备权限");
            }
            return;
        }
        if (requestCode != RECORD_PERMISSION_REQUEST) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            statusView.setText("状态：麦克风已授权，请按住按钮说话");
        } else {
            statusView.setText("状态：未获得麦克风权限，仍可运行固定 WAV 回归");
        }
    }

    private void showNewContactDialog(Button triggerButton) {
        showNewContactDialog(triggerButton, false);
    }

    private void showNewContactDialog(Button triggerButton, boolean usePendingUnknownAudio) {
        if (inferenceRunning || recording || continuousMode || !loadError.isEmpty()) return;
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        int padding = dp(20);
        form.setPadding(padding, dp(8), padding, 0);
        EditText nameInput = new EditText(this);
        nameInput.setHint("联系人姓名，例如：张三204");
        nameInput.setSingleLine(true);
        form.addView(nameInput, new LinearLayout.LayoutParams(-1, -2));
        EditText relationInput = new EditText(this);
        relationInput.setHint("关系，例如：同事（可选）");
        relationInput.setSingleLine(true);
        form.addView(relationInput, new LinearLayout.LayoutParams(-1, -2));
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("录入并命名新声纹")
                .setMessage(usePendingUnknownAudio
                        ? "将直接使用刚才连续识别缓存的两段陌生人语音。只需输入姓名和关系，不再重新录音。"
                        : "命名由用户确认；系统不会根据声音自动猜姓名。")
                .setView(form)
                .setNegativeButton("取消", (ignored, which) -> {
                    if (usePendingUnknownAudio) clearPendingUnknownAudioNative();
                })
                .setPositiveButton(usePendingUnknownAudio ? "直接添加" : "开始录音", null)
                .create();
        dialog.setOnCancelListener(ignored -> {
            if (usePendingUnknownAudio) clearPendingUnknownAudioNative();
        });
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(v -> {
                    String name = nameInput.getText().toString().trim();
                    String relation = relationInput.getText().toString().trim();
                    if (name.isEmpty()) {
                        nameInput.setError("请输入联系人姓名");
                        return;
                    }
                    if (relation.isEmpty()) relation = "联系人";
                    String stableId = "contact_" + System.currentTimeMillis();
                    dialog.dismiss();
                    if (usePendingUnknownAudio) {
                        enrollPendingUnknownSpeaker(stableId, name, relation);
                    } else {
                        startEnrollment(stableId, name, relation, triggerButton);
                    }
                }));
        dialog.show();
    }

    private void hideUnknownOffer() {
        unknownOfferVisible = false;
        unknownEnrollButton.setVisibility(View.GONE);
        unknownDismissButton.setVisibility(View.GONE);
    }

    private void dismissUnknownOffer() {
        hideUnknownOffer();
        clearPendingUnknownAudioNative();
        consecutiveReliableUnknowns = 0;
        unknownOfferSnoozedUntilMs = SystemClock.elapsedRealtime()
                + UNKNOWN_OFFER_COOLDOWN_MS;
        capabilityView.setText("已忽略本次未匹配声纹提示；5 分钟内不再提醒。"
                + "连续识别和原始转写不受影响。");
    }

    private void openUnknownEnrollmentFlow() {
        hideUnknownOffer();
        consecutiveReliableUnknowns = 0;
        unknownOfferSnoozedUntilMs = SystemClock.elapsedRealtime()
                + UNKNOWN_OFFER_COOLDOWN_MS;
        if (continuousMode) {
            statusView.setText("状态：正在停止连续识别，随后使用已缓存语音添加联系人");
            stopContinuousMode();
            mainHandler.postDelayed(
                    () -> showNewContactDialog(enrollNewButton, true), 1200L);
        } else {
            showNewContactDialog(enrollNewButton, true);
        }
    }

    private boolean handleUnknownVoiceCommand(String text) {
        if (!unknownOfferVisible || text == null) return false;
        String normalized = text.replaceAll("[\\s，。！？、,.!?]", "");
        if (normalized.contains("不需要") || normalized.contains("不用")
                || normalized.contains("不要录入") || normalized.contains("取消")) {
            dismissUnknownOffer();
            statusView.setText("状态：已取消本次陌生声纹录入提示 / 继续监听");
            return true;
        }
        if (normalized.contains("需要命名") || normalized.contains("录入并命名")
                || normalized.contains("添加联系人") || normalized.equals("是的")
                || normalized.equals("需要") || normalized.equals("确认")) {
            openUnknownEnrollmentFlow();
            return true;
        }
        return false;
    }

    private static boolean isReliableUnknownReason(String reason) {
        return "registry_empty".equals(reason)
                || "ambiguous_margin".equals(reason)
                || "below_threshold".equals(reason);
    }

    private void updateUnknownOffer(PendingTurn pending) {
        if (!isReliableUnknownReason(pending.vprReason)) {
            consecutiveReliableUnknowns = 0;
            return;
        }
        long now = SystemClock.elapsedRealtime();
        if (now - lastReliableUnknownMs > UNKNOWN_SEQUENCE_WINDOW_MS) {
            consecutiveReliableUnknowns = 0;
        }
        lastReliableUnknownMs = now;
        consecutiveReliableUnknowns++;
        if (unknownOfferVisible || consecutiveReliableUnknowns < UNKNOWN_CONFIRMATION_TURNS
                || now < unknownOfferSnoozedUntilMs) return;
        unknownOfferVisible = true;
        unknownEnrollButton.setVisibility(View.VISIBLE);
        unknownDismissButton.setVisibility(View.VISIBLE);
        capabilityView.setText("连续检测到 " + consecutiveReliableUnknowns
                + " 段未可靠匹配的声纹。若确认是新联系人，可点击“录入并命名”，"
                + "或在下一句说“是的，需要命名”；也可点击“忽略”，5 分钟内不再提醒。"
                + "unknown 不等于一定是陌生人。原因：" + pending.vprReason);
    }

    private void showMemberManagementDialog() {
        if (inferenceRunning || recording || continuousMode || !loadError.isEmpty()) return;
        graphWorker.execute(() -> {
            try {
                JSONObject snapshot = new JSONObject(getSocialGraphSnapshotNative(
                        liveGraphDatabase().getAbsolutePath()));
                if (!snapshot.optBoolean("ok", false)) {
                    throw new IllegalStateException(snapshot.optString("error"));
                }
                JSONArray nodes = snapshot.optJSONArray("nodes");
                int count = nodes == null ? 0 : nodes.length();
                String[] labels = new String[count];
                String[] ids = new String[count];
                for (int i = 0; i < count; ++i) {
                    JSONObject node = nodes.getJSONObject(i);
                    ids[i] = node.optString("id");
                    labels[i] = node.optString("name", ids[i]) + " · "
                            + node.optString("relation", "联系人");
                }
                runOnUiThread(() -> {
                    LinearLayout list = new LinearLayout(this);
                    list.setOrientation(LinearLayout.VERTICAL);
                    list.setPadding(dp(18), dp(8), dp(18), dp(8));
                    TextView help = text(count == 0
                                    ? "当前没有可删除的联系人；当前使用者节点不能删除。"
                                    : "每个联系人右侧都有独立删除按钮。删除会同时清理"
                                    + "声纹、图谱关系和相关互动。",
                            14, Color.rgb(71, 85, 105));
                    help.setPadding(0, 0, 0, dp(10));
                    list.addView(help, new LinearLayout.LayoutParams(-1, -2));
                    final AlertDialog[] holder = new AlertDialog[1];
                    for (int i = 0; i < count; ++i) {
                        final String memberId = ids[i];
                        final String memberLabel = labels[i];
                        LinearLayout row = new LinearLayout(this);
                        row.setOrientation(LinearLayout.HORIZONTAL);
                        row.setGravity(Gravity.CENTER_VERTICAL);
                        TextView member = text(memberLabel, 16, Color.rgb(15, 23, 42));
                        member.setPadding(dp(8), dp(10), dp(8), dp(10));
                        row.addView(member, new LinearLayout.LayoutParams(0, -2, 1));
                        Button delete = new Button(this);
                        delete.setText("删除");
                        delete.setTextSize(14);
                        delete.setAllCaps(false);
                        delete.setTextColor(Color.rgb(185, 28, 28));
                        delete.setContentDescription("删除联系人 " + memberLabel);
                        delete.setOnClickListener(v -> {
                            if (holder[0] != null) holder[0].dismiss();
                            confirmDeleteContact(memberId, memberLabel);
                        });
                        row.addView(delete, new LinearLayout.LayoutParams(dp(92), dp(50)));
                        list.addView(row, new LinearLayout.LayoutParams(-1, -2));
                    }
                    ScrollView scroll = new ScrollView(this);
                    scroll.addView(list, new ScrollView.LayoutParams(-1, -2));
                    holder[0] = new AlertDialog.Builder(this)
                            .setTitle("管理图谱成员")
                            .setView(scroll)
                            .setPositiveButton("添加联系人",
                                    (dialog, which) -> showNewContactDialog(manageMembersButton))
                            .setNegativeButton("关闭", null)
                            .create();
                    holder[0].show();
                });
            } catch (Throwable t) {
                runOnUiThread(() -> showCapabilityFailure("读取图谱成员失败：" + t));
            }
        });
    }

    private void confirmDeleteContact(String speakerId, String label) {
        new AlertDialog.Builder(this)
                .setTitle("删除联系人")
                .setMessage("确定删除“" + label + "”吗？\n\n将删除本机声纹 embedding、"
                        + "图谱成员、关系和相关互动记录；不会删除其他联系人。")
                .setNegativeButton("取消", null)
                .setPositiveButton("删除", (dialog, which) -> deleteContact(speakerId, label))
                .show();
    }

    private void deleteContact(String speakerId, String label) {
        if (speakerId == null || speakerId.isEmpty() || "self".equals(speakerId)) return;
        inferenceRunning = true;
        setControlsEnabled(false);
        statusView.setText("状态：正在删除联系人和声纹绑定……");
        graphWorker.execute(() -> {
            try {
                File[] vpr = prepareVprFiles();
                String raw = deleteContactNative(vpr[0].getAbsolutePath(),
                        vpr[1].getAbsolutePath(), liveGraphDatabase().getAbsolutePath(),
                        speakerId);
                JSONObject result = new JSONObject(raw);
                if (!result.optBoolean("ok", false)) {
                    throw new IllegalStateException(result.optString("error", raw));
                }
                runOnUiThread(() -> {
                    statusView.setText("状态：联系人删除成功");
                    capabilityView.setText("已删除：" + label
                            + "\n声纹：" + (result.optBoolean("speaker_removed")
                            ? "已删除" : "原注册库中不存在")
                            + "；图谱成员/关系/互动：已删除");
                });
                refreshSocialGraphOnCurrentThread("");
            } catch (Throwable t) {
                runOnUiThread(() -> showCapabilityFailure("删除联系人失败：" + t));
            } finally {
                inferenceRunning = false;
                runOnUiThread(() -> setControlsEnabled(loadError.isEmpty()));
            }
        });
    }

    private void startEnrollment(String speakerId, String displayName,
                                 String relationType, Button button) {
        if (inferenceRunning || recording || continuousMode || !loadError.isEmpty()) return;
        if (waitingForGlassesAudio()) return;
        if (externalAudio() == null && !hasRecordPermission()) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},
                    RECORD_PERMISSION_REQUEST);
            statusView.setText("状态：请允许麦克风权限后重新点击声纹录入");
            return;
        }
        recordingPurpose = "enroll";
        enrollmentSpeakerId = speakerId;
        enrollmentDisplayName = displayName;
        enrollmentRelation = relationType;
        activeRecordButton = button;
        activeRecordButtonDefaultText = button.getText().toString();
        startVoiceRecording();
        mainHandler.postDelayed(() -> {
            if (recording && "enroll".equals(recordingPurpose)
                    && speakerId.equals(enrollmentSpeakerId)) {
                finishVoiceRecording();
            }
        }, 5000L);
    }

    private File liveGraphDatabase() throws Exception {
        File dir = new File(getFilesDir(), "social_graph");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("无法创建社交图谱目录");
        }
        return new File(dir, "contacts.v1.db");
    }

    private File[] prepareVprFiles() throws Exception {
        File dir = new File(getFilesDir(), "vpr");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("无法创建声纹目录：" + dir);
        }
        File model = new File(dir, VPR_MODEL_FILE);
        if (!model.isFile()) model.createNewFile();
        return new File[]{model, new File(dir, "identity_registry.v1.db")};
    }

    private void enrollRecordedSpeaker(short[] pcm) throws Exception {
        File[] vpr = prepareVprFiles();
        File graph = liveGraphDatabase();
        String raw = enrollSpeakerNative(vpr[0].getAbsolutePath(),
                vpr[1].getAbsolutePath(), graph.getAbsolutePath(),
                enrollmentSpeakerId, enrollmentDisplayName,
                enrollmentRelation, pcm);
        JSONObject result = new JSONObject(raw);
        if (!result.optBoolean("ok", false)) {
            throw new IllegalStateException(result.optString("error", raw));
        }
        String message = String.format(Locale.US,
                "声纹录入成功：%s（%s）\n校验相似度：%.4f\n"
                        + "已关联社交图谱：%s\n原始录音未持久化。",
                result.optString("display_name"), result.optString("speaker_id"),
                result.optDouble("similarity"),
                result.optBoolean("graph_linked") ? "是" : "否");
        runOnUiThread(() -> {
            statusView.setText("状态：声纹注册与联系人关联成功");
            capabilityView.setText(message);
            hideUnknownOffer();
        });
        refreshSocialGraph();
    }

    private void enrollPendingUnknownSpeaker(String speakerId, String displayName,
                                             String relationType) {
        if (inferenceRunning || recording || continuousMode || !loadError.isEmpty()) return;
        inferenceRunning = true;
        setControlsEnabled(false);
        statusView.setText("状态：正在使用刚才的陌生人语音直接注册声纹……");
        inferenceWorker.execute(() -> {
            try {
                short[] pcm = getPendingUnknownPcmNative();
                double seconds = pcm == null ? 0.0 : pcm.length / (double) SAMPLE_RATE;
                if (pcm == null || seconds < 2.0) {
                    throw new IllegalStateException(
                            "待确认语音缓存不足 2 秒，请让新联系人再说两段完整语音");
                }
                File[] vpr = prepareVprFiles();
                String raw = enrollSpeakerNative(vpr[0].getAbsolutePath(),
                        vpr[1].getAbsolutePath(), liveGraphDatabase().getAbsolutePath(),
                        speakerId, displayName, relationType, pcm);
                JSONObject result = new JSONObject(raw);
                if (!result.optBoolean("ok", false)) {
                    throw new IllegalStateException(result.optString("error", raw));
                }
                clearPendingUnknownAudioNative();
                String message = String.format(Locale.US,
                        "联系人直接添加成功：%s（%s）\n使用已缓存陌生人语音：%.2f 秒"
                                + "\n校验相似度：%.4f\n已关联社交图谱：%s"
                                + "\n无需重新录音；缓存已清除，原始语音未持久化。",
                        result.optString("display_name"), result.optString("speaker_id"),
                        seconds, result.optDouble("similarity"),
                        result.optBoolean("graph_linked") ? "是" : "否");
                runOnUiThread(() -> {
                    statusView.setText("状态：已使用刚才语音完成联系人注册");
                    capabilityView.setText(message);
                    hideUnknownOffer();
                });
                refreshSocialGraph();
            } catch (Throwable t) {
                runOnUiThread(() -> showCapabilityFailure(
                        "使用待确认语音添加联系人失败：" + t));
            } finally {
                inferenceRunning = false;
                runOnUiThread(() -> setControlsEnabled(loadError.isEmpty()));
            }
        });
    }

    private static short[] bytesToShorts(byte[] pcm) {
        short[] out = new short[pcm.length / 2];
        for (int i = 0; i < out.length; ++i) {
            out[i] = (short) ((pcm[i * 2] & 0xff) | (pcm[i * 2 + 1] << 8));
        }
        return out;
    }

    private void startVoiceRecording() {
        PcmInput input = externalAudio();
        if (input != null) {
            startExternalVoiceRecording(input);
            return;
        }
        recordingInputName = "手机麦克风";
        Log.i(PIPELINE_TAG, "capture_source=PHONE_MIC mode=record");
        int minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minimum <= 0) {
            showFailure("设备不支持 16 kHz 单声道 PCM16 录音");
            return;
        }
        int bufferSize = Math.max(minimum, 4096);
        AudioRecord recorder;
        try {
            recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, bufferSize * 2);
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                recorder.release();
                showFailure("AudioRecord 初始化失败");
                return;
            }
            recordedPcm = new ByteArrayOutputStream(SAMPLE_RATE * 2 * 10);
            audioRecord = recorder;
            recording = true;
            recordingStartMs = SystemClock.elapsedRealtime();
            recorder.startRecording();
        } catch (Throwable t) {
            showFailure("无法开始录音：" + t);
            return;
        }

        statusView.setText("asr".equals(recordingPurpose)
                ? "状态：录音中，松开后调用 ASR 原子能力"
                : "状态：声纹录入中，请自然说话 5 秒");
        resultView.setText("正在聆听……");
        metricsView.setText("");
        fixedButton.setEnabled(false);
        Button displayButton = activeRecordButton == null ? recordButton : activeRecordButton;
        displayButton.setText("正在录音 · 0.0 s");
        displayButton.setTextColor(Color.rgb(185, 28, 28));

        final AudioRecord activeRecorder = recorder;
        recordingThread = new Thread(() -> {
            byte[] buffer = new byte[bufferSize];
            while (recording) {
                int count = activeRecorder.read(buffer, 0, buffer.length,
                        AudioRecord.READ_BLOCKING);
                if (count > 0) recordedPcm.write(buffer, 0, count);
                if (count == AudioRecord.ERROR_DEAD_OBJECT ||
                        count == AudioRecord.ERROR_INVALID_OPERATION) break;
            }
        }, "s23u-audio-capture");
        recordingThread.start();
        mainHandler.post(recordingTicker);
    }

    private void onContinuousClick() {
        if (continuousStarting || inferenceRunning || !loadError.isEmpty()) return;
        if (continuousMode) {
            stopContinuousMode();
            return;
        }
        if (pendingLlmTurns.get() > 0) {
            statusView.setText("状态：请等待上一轮 LLM 队列处理完成");
            return;
        }
        if (waitingForGlassesAudio()) return;
        if (externalAudio() == null && !hasRecordPermission()) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},
                    RECORD_PERMISSION_REQUEST);
            statusView.setText("状态：请允许麦克风权限后点击开始连续识别");
            return;
        }
        startContinuousMode();
    }

    private void startContinuousMode() {
        PcmInput input = externalAudio();
        continuousStarting = true;
        setControlsEnabled(false);
        statusView.setText("状态：初始化 Silero VAD 与 SenseVoice QNN……");
        resultView.setText("连续识别准备中……");
        metricsView.setText("");
        continuousTranscript.setLength(0);
        pendingTurns.clear();
        currentTranscript = "";
        resetLlmTurnSession();
        pipelineFlowView.reset();
        pipelineFlowView.updateNode("麦克风", "初始化", 0, false);
        warmupLlmForContinuous();
        inferenceWorker.execute(() -> {
            try {
                File modelDir = prepareModelFiles();
                File vad = new File(modelDir, VAD_FILE);
                File[] vpr = prepareVprFiles();
                File graph = liveGraphDatabase();
                String raw = startContinuousNative(modelDir.getAbsolutePath(),
                        getApplicationInfo().nativeLibraryDir, vad.getAbsolutePath(),
                        vpr[0].getAbsolutePath(), vpr[1].getAbsolutePath(),
                        graph.getAbsolutePath(),
                        vadProbThreshold, vadRmsThreshold, vadWindowSizeMs,
                        vadMinSilenceMs);
                JSONObject status = new JSONObject(raw);
                if (!status.optBoolean("ok", false)) {
                    throw new IllegalStateException(status.optString("error", raw));
                }
                runOnUiThread(() -> beginContinuousAudioCapture(input));
            } catch (Throwable t) {
                runOnUiThread(() -> showFailure("连续能力初始化失败：" + t));
            } finally {
                continuousStarting = false;
            }
        });
    }

    // ------------------------------------------------------------ 蓝牙音频


    private PcmInput externalAudio() {
        if (glassesSource >= 0 && glassesAudio.isConnected()) return glassesAudio;
        BluetoothAudio pc = BluetoothAudio.get();
        return bluetoothAudioEnabled && pc.isConnected() ? pc : null;
    }

    private boolean canChangeAudioInput() {
        if (!recording && !continuousMode && !continuousStarting) return true;
        statusView.setText("状态：请先停止当前录音或连续识别，再切换音频输入");
        return false;
    }

    private boolean waitingForGlassesAudio() {
        if (glassesSource < 0 || glassesAudio.isConnected()) return false;
        statusView.setText("状态：眼镜音频连接中，请稍候");
        return true;
    }

    private void toggleBluetoothAudio() {
        if (!canChangeAudioInput()) return;
        if (bluetoothAudioEnabled) {
            bluetoothAudioEnabled = false;
            BluetoothAudio.get().disconnect();
            updateAudioInput("已关闭 PC 音频");
            return;
        }
        disableGlassesAudio();
        bluetoothAudioEnabled = true;
        BluetoothAudio pc = BluetoothAudio.get();
        if (!pc.connect()) {
            bluetoothAudioEnabled = false;
            updateAudioInput("开启失败：" + pc.lastError());
        } else {
            updateAudioInput(pc.isConnected() ? "PC 音频已接入" : "正在连接 PC 音频…");
        }
    }

    private void toggleGlassesAudio() {
        if (!canChangeAudioInput()) return;
        if (glassesSource >= 0) {
            disableGlassesAudio();
            updateAudioInput("已关闭眼镜音频");
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("音频输入")
                .setItems(new String[]{"眼镜麦克风", "眼镜测试音频（中文）"}, (dialog, choice) ->
                        selectGlassesAudio(choice == 0 ? GlassesAudio.SOURCE_MIC
                                : GlassesAudio.SOURCE_TEST_ZH))
                .show();
    }

    private void selectGlassesAudio(int source) {
        bluetoothAudioEnabled = false;
        BluetoothAudio.get().disconnect();
        glassesSource = source;
        glassesAudioDetail = "";
        if (hasGlassesPermissions()) {
            glassesAudio.connect(source);
        } else {
            updateAudioInput("");
            String[] permissions = Build.VERSION.SDK_INT >= 31
                    ? new String[]{Manifest.permission.BLUETOOTH_SCAN,
                            Manifest.permission.BLUETOOTH_CONNECT}
                    : new String[]{Manifest.permission.ACCESS_FINE_LOCATION};
            requestPermissions(permissions, GLASSES_PERMISSION_REQUEST);
        }
    }

    private boolean hasGlassesPermissions() {
        if (Build.VERSION.SDK_INT < 31) {
            return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED;
        }
        return checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN)
                == PackageManager.PERMISSION_GRANTED
                && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void disableGlassesAudio() {
        glassesSource = -1;
        glassesAudioDetail = "";
        glassesAudio.disconnect();
    }

    private void onGlassesAudioState(boolean ready, boolean failed, String detail) {
        if (failed) glassesSource = -1;
        glassesAudioDetail = ready ? "" : detail;
        updateAudioInput(detail);
    }

    private String externalAudioName(PcmInput input) {
        if (input != glassesAudio) return "PC 音频";
        return glassesSource == GlassesAudio.SOURCE_TEST_ZH ? "眼镜测试音频" : "眼镜麦克风";
    }

    private void updateAudioInput(String detail) {
        PcmInput input = externalAudio();
        if (bluetoothAudioButton != null) {
            bluetoothAudioButton.setText(input == BluetoothAudio.get()
                    ? "音频输入：PC 音频（已接入）"
                    : bluetoothAudioEnabled
                            ? "音频输入：PC 音频（等待连接）" : "音频输入：PC 音频");
        }
        if (glassesAudioButton != null) {
            String label = glassesSource >= 0 ? externalAudioName(glassesAudio) : "眼镜麦克风";
            glassesAudioButton.setText("音频输入：" + label + (input == glassesAudio
                    ? "（已接入）" : glassesSource >= 0 ? "（连接中）" : ""));
        }
        if (audioInputView != null) {
            String inputName = input == null ? "手机麦克风" : externalAudioName(input);
            if (glassesSource >= 0 && input == null) inputName = "等待眼镜音频";
            audioInputView.setText("当前输入：" + inputName
                    + (glassesAudioDetail.isEmpty() ? "" : "\n" + glassesAudioDetail));
            audioInputView.setTextColor(input != null ? Color.rgb(22, 163, 74)
                    : Color.rgb(15, 23, 42));
        }
        if (statusView != null && !detail.isEmpty()) {
            statusView.setText("状态：" + detail);
        }
    }

    private void externalAudioFailed(String detail) {
        Thread capture = Thread.currentThread();
        mainHandler.post(() -> {
            if (capture != recordingThread || !recording) return;
            if (continuousMode) {
                stopContinuousMode();
            } else {
                finishVoiceRecording();
            }
            statusView.setText("状态：" + detail);
        });
    }

    /** 彻底关掉手机麦克风：切到蓝牙音频时调用，避免残留的 AudioRecord 继续占用音频输入。 */
    private void releasePhoneMicrophone() {
        AudioRecord current = audioRecord;
        audioRecord = null;
        if (current == null) return;
        try {
            current.stop();
        } catch (Throwable ignored) {
            // 已经停止
        }
        try {
            current.release();
        } catch (Throwable ignored) {
            // 已经释放
        }
        android.util.Log.i(PIPELINE_TAG, "phone_microphone_released");
    }

    private void beginExternalContinuousCapture(PcmInput input) {
        String inputName = externalAudioName(input);
        releasePhoneMicrophone();
        continuousMode = true;
        recording = true;
        Log.i(PIPELINE_TAG, "capture_source=" + inputName + " mode=continuous"
                + " bufferedSamples=" + input.bufferedSamples());
        input.clearBuffer();
        continuousSampleCount = 0;
        continuousPcmPeak = 0;
        continuousMaxVadProbability = 0.0;
        continuousMaxVadRms = 0.0;
        recordingStartMs = SystemClock.elapsedRealtime();
        statusView.setText("状态：正在监听（" + inputName + "）");
        resultView.setText("正在从" + inputName + "接收音频。\n");
        pipelineFlowView.updateNode("麦克风", inputName, 0, true);
        continuousButton.setText("停止并完成识别");
        continuousButton.setEnabled(true);
        fixedButton.setEnabled(false);
        recordButton.setEnabled(false);

        recordingThread = new Thread(() -> {
            short[] buffer = new short[320];
            while (continuousMode && recording) {
                int count = input.read(buffer, buffer.length, 500);
                if (count < 0) {
                    externalAudioFailed(inputName + "已断开");
                    break;
                }
                if (count == 0) continue;
                int blockPeak = 0;
                for (int i = 0; i < count; ++i) {
                    blockPeak = Math.max(blockPeak, Math.abs((int) buffer[i]));
                }
                continuousSampleCount += count;
                continuousPcmPeak = Math.max(continuousPcmPeak, blockPeak);
                int code = pushContinuousNative(buffer, count);
                if (code != 0) {
                    externalAudioFailed("连续音频输入失败，code=" + code);
                    break;
                }
            }
        }, "s23u-external-audio");
        recordingThread.start();
        mainHandler.post(continuousPoller);
    }

    private void startExternalVoiceRecording(PcmInput input) {
        String inputName = externalAudioName(input);
        recordingInputName = inputName;
        releasePhoneMicrophone();
        recordedPcm = new ByteArrayOutputStream(SAMPLE_RATE * 2 * 10);
        recording = true;
        Log.i(PIPELINE_TAG, "capture_source=" + inputName + " mode=record"
                + " bufferedSamples=" + input.bufferedSamples());
        input.clearBuffer();
        recordingStartMs = SystemClock.elapsedRealtime();
        statusView.setText("asr".equals(recordingPurpose)
                ? "状态：录音中（" + inputName + "），松开后开始转写"
                : "状态：声纹录入中（" + inputName + "），请自然说话 5 秒");
        resultView.setText("正在从" + inputName + "接收音频……");
        metricsView.setText("");
        fixedButton.setEnabled(false);
        Button displayButton = activeRecordButton == null ? recordButton : activeRecordButton;
        displayButton.setText("正在录音 · 0.0 s");
        displayButton.setTextColor(Color.rgb(185, 28, 28));

        recordingThread = new Thread(() -> {
            short[] buffer = new short[320];
            while (recording) {
                int count = input.read(buffer, buffer.length, 500);
                if (count < 0) {
                    externalAudioFailed(inputName + "已断开");
                    break;
                }
                if (count == 0) continue;
                byte[] bytes = new byte[count * 2];
                for (int i = 0; i < count; ++i) {
                    bytes[i * 2] = (byte) (buffer[i] & 0xff);
                    bytes[i * 2 + 1] = (byte) ((buffer[i] >> 8) & 0xff);
                }
                recordedPcm.write(bytes, 0, bytes.length);
            }
        }, "s23u-external-record");
        recordingThread.start();
        mainHandler.post(recordingTicker);
    }

    private void beginContinuousAudioCapture(PcmInput input) {
        if (input != null) {
            if (input.isConnected()) {
                beginExternalContinuousCapture(input);
            } else {
                cancelContinuousNative();
                showFailure("所选音频输入已断开，请重新连接");
            }
            return;
        }
        if (!hasRecordPermission()) {
            cancelContinuousNative();
            showFailure("当前音频输入已断开，请重新连接或授权手机麦克风");
            return;
        }
        Log.i(PIPELINE_TAG, "capture_source=PHONE_MIC mode=continuous");
        int minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minimum <= 0) {
            cancelContinuousNative();
            showFailure("设备不支持 16 kHz 单声道 PCM16 录音");
            return;
        }
        int bufferSamples = Math.max(1600, minimum / 2);
        try {
            audioRecord = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, bufferSamples * 4);
            if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                audioRecord.release();
                audioRecord = null;
                throw new IllegalStateException("AudioRecord 初始化失败");
            }
            continuousMode = true;
            recording = true;
            continuousSampleCount = 0;
            continuousPcmPeak = 0;
            continuousMaxVadProbability = 0.0;
            continuousMaxVadRms = 0.0;
            recordingStartMs = SystemClock.elapsedRealtime();
            audioRecord.startRecording();
        } catch (Throwable t) {
            cancelContinuousNative();
            showFailure("无法开始连续录音：" + t);
            return;
        }
        statusView.setText("状态：正在监听 / 等待语音");
        resultView.setText("请连续说话；同一语音段将并行进入 ASR 与 VPR。\n");
        pipelineFlowView.updateNode("麦克风", "采集中", 0, true);
        continuousButton.setText("停止并完成识别");
        continuousButton.setEnabled(true);
        fixedButton.setEnabled(false);
        recordButton.setEnabled(false);
        final AudioRecord active = audioRecord;
        recordingThread = new Thread(() -> {
            short[] samples = new short[bufferSamples];
            while (continuousMode && recording) {
                int count = active.read(samples, 0, samples.length, AudioRecord.READ_BLOCKING);
                if (count > 0) {
                    int blockPeak = 0;
                    for (int i = 0; i < count; ++i) {
                        blockPeak = Math.max(blockPeak, Math.abs((int) samples[i]));
                    }
                    continuousSampleCount += count;
                    continuousPcmPeak = Math.max(continuousPcmPeak, blockPeak);
                    int code = pushContinuousNative(samples, count);
                    if (code != 0) {
                        mainHandler.post(() -> showFailure("连续音频输入失败，code=" + code));
                        break;
                    }
                } else if (count == AudioRecord.ERROR_DEAD_OBJECT ||
                        count == AudioRecord.ERROR_INVALID_OPERATION) {
                    mainHandler.post(() -> showFailure("连续录音设备失效，code=" + count));
                    break;
                }
            }
        }, "s23u-continuous-audio");
        recordingThread.start();
        mainHandler.post(continuousPoller);
        if (pendingAutoStopSeconds > 0) {
            int autoStopSeconds = pendingAutoStopSeconds;
            pendingAutoStopSeconds = 0;
            mainHandler.postDelayed(() -> {
                if (continuousMode) stopContinuousMode();
            }, autoStopSeconds * 1000L);
        }
    }

    private final Runnable continuousPoller = new Runnable() {
        @Override public void run() {
            if (!continuousMode) return;
            consumeContinuousEvents();
            mainHandler.postDelayed(this, 120);
        }
    };

    private void consumeContinuousEvents() {
        try {
            processContinuousEvents(new JSONArray(pollContinuousNative()));
        } catch (Throwable t) {
            statusView.setText("状态：事件解析失败");
            metricsView.setText(t.toString());
        }
    }

    private void processContinuousEvents(JSONArray events) throws Exception {
        for (int i = 0; i < events.length(); ++i) {
            JSONObject event = events.getJSONObject(i);
            String type = event.optString("type");
            if ("vad_frame".equals(type)) {
                continuousMaxVadProbability = Math.max(
                        continuousMaxVadProbability, event.optDouble("probability", 0.0));
                continuousMaxVadRms = Math.max(
                        continuousMaxVadRms, event.optDouble("rms", 0.0));
                metricsView.setText(String.format(Locale.US,
                        "实时诊断：VOICE_RECOGNITION · gain32x · prob阈值 %.3f · RMS阈值 %.3f · window %d ms · silence %d ms · 采集 %.2f s · PCM峰值 %d/32768 · VAD最大概率 %.6f · 原始RMS最大值 %.6f",
                        vadProbThreshold, vadRmsThreshold, vadWindowSizeMs,
                        vadMinSilenceMs,
                        continuousSampleCount / (double) SAMPLE_RATE,
                        continuousPcmPeak, continuousMaxVadProbability,
                        continuousMaxVadRms));
            } else if ("vad".equals(type)) {
                continuousMaxVadProbability = Math.max(
                        continuousMaxVadProbability, event.optDouble("probability", 0.0));
                String name = event.optString("event");
                pipelineFlowView.updateNode("VAD", name,
                        event.optDouble("time_seconds") * 1000.0, true);
                if ("speech_start".equals(name)) {
                    statusView.setText("状态：检测到语音 / 正在收音");
                } else {
                    statusView.setText("状态：语音段结束 / ASR 与 VPR 并行处理中");
                }
            } else if ("asr".equals(type)) {
                int segmentId = event.optInt("segment_id");
                if (!event.optBoolean("ok", false)) {
                    pendingTurns.remove(segmentId);
                    statusView.setText("状态：分段 ASR 失败");
                    metricsView.setText(event.optString("error"));
                    pipelineFlowView.updateNode("ASR", "失败", 0, false);
                    continue;
                }
                PendingTurn turn = pendingTurns.computeIfAbsent(
                        segmentId, PendingTurn::new);
                turn.startSeconds = event.optDouble("start_seconds");
                turn.endSeconds = event.optDouble("end_seconds");
                turn.text = event.optString("text", "").trim();
                turn.asrInferenceMs = event.optDouble("inference_ms");
                turn.asrRtf = event.optDouble("rtf");
                turn.asrCompletedAtMs = System.currentTimeMillis();
                turn.asrReady = true;
                pipelineFlowView.updateNode("ASR", "segment " + segmentId,
                        turn.asrInferenceMs, true);
                tryFinalizeTurn(turn, false);
            } else if ("vpr".equals(type)) {
                int segmentId = event.optInt("segment_id");
                PendingTurn turn = pendingTurns.computeIfAbsent(
                        segmentId, PendingTurn::new);
                turn.vprReady = true;
                turn.vprKnown = event.optBoolean("known", false);
                turn.speakerId = turn.vprKnown
                        ? event.optString("speaker_id", "unknown") : "unknown";
                turn.contactId = event.optString("contact_id", "");
                turn.speakerName = turn.vprKnown
                        ? event.optString("display_name", "已注册说话人")
                        : "未知说话人";
                turn.speakerScore = event.optDouble("similarity", 0.0);
                turn.vprReason = event.optString("reason",
                        event.optString("error", "unknown"));
                pipelineFlowView.updateNode("VPR",
                        turn.vprKnown ? turn.speakerName : "unknown",
                        event.optDouble("embedding_ms"), turn.vprKnown);
                tryFinalizeTurn(turn, false);
            } else if ("error".equals(type)) {
                statusView.setText("状态：连续能力错误");
                metricsView.setText(event.optString("error"));
            }
        }
        flushExpiredTurns();
    }

    private void tryFinalizeTurn(PendingTurn pending, boolean timedOut) {
        if (!pending.asrReady || (!pending.vprReady && !timedOut)) return;
        pendingTurns.remove(pending.segmentId);
        if (!pending.vprReady) {
            pending.speakerId = "unknown";
            pending.speakerName = "未知说话人";
            pending.vprReason = "timeout";
        }
        if (pending.text == null || pending.text.isEmpty()) {
            statusView.setText("状态：分段 ASR 为空 / 继续监听");
            return;
        }
        if (handleUnknownVoiceCommand(pending.text)) {
            continuousTranscript.append("[应用指令] ").append(pending.text).append('\n');
            resultView.setText(continuousTranscript.toString());
            return;
        }
        AsrTurn turn = new AsrTurn(pending.segmentId, pending.startSeconds,
                pending.endSeconds, pending.text, pending.speakerId,
                pending.contactId, pending.speakerName, pending.speakerScore,
                pending.asrInferenceMs, pending.asrCompletedAtMs);
        continuousTranscript.append(String.format(Locale.US,
                "[%02d:%05.2f][片段%d][%s] %s\n",
                (int) (pending.startSeconds / 60.0), pending.startSeconds % 60.0,
                pending.segmentId, pending.speakerName, pending.text));
        currentTranscript = continuousTranscript.toString().trim();
        resultView.setText(continuousTranscript.toString());
        pipelineFlowView.updateNode("界面", pending.speakerName, 0, true);
        metricsView.setText(String.format(Locale.US,
                "最近一段：ASR完成 %s · %.1f ms / RTF %.3f；VPR=%s %.3f（%s）\n"
                        + "汇聚键：segment_id=%d；随后进入社交图谱与 s23u.llm.v1",
                new SimpleDateFormat("HH:mm:ss.SSS", Locale.getDefault())
                        .format(new Date(pending.asrCompletedAtMs)),
                pending.asrInferenceMs, pending.asrRtf, pending.speakerName,
                pending.speakerScore, pending.vprReason, pending.segmentId));
        pipelineFlowView.updateNode("汇聚", "SpeechTurn " + pending.segmentId,
                SystemClock.elapsedRealtime() - pending.createdAtMs, true);
        recordTurnAndRefreshGraph(turn, pending.vprKnown);
        enqueueAsrTurnForLlm(turn);
        statusView.setText("状态：已生成 SpeechTurn / 已送入 LLM / 继续监听");
        if (pending.vprKnown) {
            consecutiveReliableUnknowns = 0;
            if (unknownOfferVisible) hideUnknownOffer();
            socialGraphView.setHighlightedId(pending.speakerId);
        } else {
            updateUnknownOffer(pending);
        }
    }

    private void flushExpiredTurns() {
        long now = SystemClock.elapsedRealtime();
        for (PendingTurn turn : new java.util.ArrayList<>(pendingTurns.values())) {
            if (turn.asrReady && now - turn.createdAtMs >= TURN_ASSEMBLY_TIMEOUT_MS) {
                tryFinalizeTurn(turn, true);
            }
        }
    }

    private void recordTurnAndRefreshGraph(AsrTurn turn, boolean knownSpeaker) {
        graphWorker.execute(() -> {
            try {
                String raw = recordSpeechTurnNative(liveGraphDatabase().getAbsolutePath(),
                        turn.speakerId, turn.text, turn.asrCompletedAtMs, turn.id);
                Log.i("S23U_SOCIAL_GRAPH", raw);
                if (!knownSpeaker) return;
                pipelineFlowView.updateNode("图谱", turn.speakerName, 0, true);
                refreshSocialGraphOnCurrentThread(turn.speakerId);
            } catch (Throwable t) {
                Log.e("S23U_SOCIAL_GRAPH", "record turn failed", t);
            }
        });
    }

    private void stopContinuousMode() {
        if (!continuousMode) return;
        continuousMode = false;
        recording = false;
        mainHandler.removeCallbacks(continuousPoller);
        final AudioRecord recorder = audioRecord;
        final Thread thread = recordingThread;
        audioRecord = null;
        recordingThread = null;
        try { if (recorder != null) recorder.stop(); } catch (Throwable ignored) {}
        continuousButton.setEnabled(false);
        continuousButton.setText("正在排空 ASR 队列……");
        statusView.setText("状态：停止录音 / 完成最后语音段");
        inferenceWorker.execute(() -> {
            try {
                if (thread != null) thread.join(3000);
                if (recorder != null) recorder.release();
                String raw = stopContinuousNative();
                JSONObject status = new JSONObject(raw);
                if (!status.optBoolean("ok", false)) {
                    throw new IllegalStateException(status.optString("error", raw));
                }
                runOnUiThread(() -> {
                    consumeContinuousEvents();
                    statusView.setText(pendingLlmTurns.get() > 0
                            ? "状态：连续 ASR 已停止 / 等待 LLM 队列完成"
                            : "状态：连续 ASR 与 LLM 队列均已完成");
                });
            } catch (Throwable t) {
                runOnUiThread(() -> showFailure("停止连续识别失败：" + t));
            } finally {
                runOnUiThread(() -> {
                    continuousButton.setText("开始连续识别");
                    setControlsEnabled(loadError.isEmpty());
                });
            }
        });
    }

    private final Runnable recordingTicker = new Runnable() {
        @Override
        public void run() {
            if (!recording) return;
            long elapsed = SystemClock.elapsedRealtime() - recordingStartMs;
            Button displayButton = activeRecordButton == null ? recordButton : activeRecordButton;
            displayButton.setText(String.format(Locale.US, "正在录音 · %.1f s", elapsed / 1000.0));
            if (elapsed >= MAX_RECORDING_MS) {
                finishVoiceRecording();
            } else {
                mainHandler.postDelayed(this, 100);
            }
        }
    };

    private void finishVoiceRecording() {
        if (!recording) return;
        recording = false;
        mainHandler.removeCallbacks(recordingTicker);
        final AudioRecord recorder = audioRecord;
        final Thread thread = recordingThread;
        audioRecord = null;
        recordingThread = null;
        try {
            if (recorder != null) recorder.stop();
        } catch (Throwable ignored) {
        }
        final Button displayButton = activeRecordButton == null ? recordButton : activeRecordButton;
        displayButton.setText("正在处理录音……");
        displayButton.setTextColor(Color.rgb(30, 41, 59));
        setControlsEnabled(false);
        inferenceRunning = true;

        inferenceWorker.execute(() -> {
            try {
                if (thread != null) thread.join(3000);
                if (recorder != null) recorder.release();
                byte[] pcm = recordedPcm.toByteArray();
                recordedPcm = null;
                double seconds = pcm.length / (double) (SAMPLE_RATE * 2);
                if (seconds < 0.35) {
                    throw new IllegalStateException("录音太短，请至少说话 0.35 秒");
                }
                if ("asr".equals(recordingPurpose)) {
                    File recordingDir = new File(getFilesDir(), "recordings");
                    if (!recordingDir.exists() && !recordingDir.mkdirs()) {
                        throw new IllegalStateException("无法创建录音目录");
                    }
                    File wav = new File(recordingDir, "last_recording.wav");
                    writePcm16Wav(wav, pcm, SAMPLE_RATE);
                    executeInference(wav, recordingInputName, false);
                } else {
                    if (seconds < 2.0) {
                        throw new IllegalStateException("声纹录入至少需要 2 秒自然语音");
                    }
                    enrollRecordedSpeaker(bytesToShorts(pcm));
                }
            } catch (Throwable t) {
                runOnUiThread(() -> showFailure(t.toString()));
            } finally {
                inferenceRunning = false;
                runOnUiThread(() -> {
                    displayButton.setText("asr".equals(recordingPurpose)
                            ? "按住说话 · 松开识别"
                            : (activeRecordButtonDefaultText.isEmpty()
                            ? "录入新联系人" : activeRecordButtonDefaultText));
                    activeRecordButton = null;
                    activeRecordButtonDefaultText = "";
                    recordingPurpose = "asr";
                    setControlsEnabled(loadError.isEmpty());
                });
            }
        });
    }

    private void runFixedAudio() {
        if (inferenceRunning || recording || !loadError.isEmpty()) return;
        inferenceRunning = true;
        setControlsEnabled(false);
        resultView.setText("正在准备固定回归音频……");
        metricsView.setText("");
        statusView.setText("状态：准备 ASR 原子能力");
        inferenceWorker.execute(() -> {
            try {
                File modelDir = prepareModelFiles();
                File audio = new File(modelDir, FIXED_AUDIO_FILE);
                copyAssetIfNeeded(FIXED_AUDIO_FILE, audio, FIXED_AUDIO_BYTES);
                executeInference(audio, "固定 WAV 回归", true);
            } catch (Throwable t) {
                runOnUiThread(() -> showFailure(t.toString()));
            } finally {
                inferenceRunning = false;
                runOnUiThread(() -> setControlsEnabled(loadError.isEmpty()));
            }
        });
    }

    private File prepareModelFiles() throws Exception {
        File modelDir = new File(getFilesDir(), "sensevoice_sm8550");
        if (!modelDir.exists() && !modelDir.mkdirs()) {
            throw new IllegalStateException("无法创建模型目录：" + modelDir);
        }
        return modelDir;
    }

    private void runVprAtomicTest() {
        if (inferenceRunning || recording || continuousMode ||
                pendingLlmTurns.get() > 0 || !loadError.isEmpty()) return;
        inferenceRunning = true;
        setControlsEnabled(false);
        statusView.setText("状态：声纹模型初始化与注册/识别测试中……");
        capabilityView.setText("正在执行 s23u.vpr.v1 真机测试。首次运行需要复制 CAM++ 模型。");
        inferenceWorker.execute(() -> {
            try {
                File modelDir = prepareModelFiles();
                File wav = new File(modelDir, FIXED_AUDIO_FILE);
                copyAssetIfNeeded(FIXED_AUDIO_FILE, wav, FIXED_AUDIO_BYTES);
                short[] pcm = readPcm16Mono16kWav(wav);
                File vprDir = new File(getFilesDir(), "vpr");
                if (!vprDir.exists() && !vprDir.mkdirs()) {
                    throw new IllegalStateException("无法创建声纹目录：" + vprDir);
                }
                File model = new File(vprDir, VPR_MODEL_FILE);
                if (!model.isFile()) model.createNewFile();
                File registry = new File(vprDir, "selftest_speakers.v1.db");
                String raw = runVprSelfTestNative(model.getAbsolutePath(),
                        registry.getAbsolutePath(), pcm);
                Log.i("S23U_VPR_ATOM", raw);
                JSONObject result = new JSONObject(raw);
                if (!result.optBoolean("ok", false)) {
                    throw new IllegalStateException(result.optString("error", raw));
                }
                String detail = String.format(Locale.US,
                        "原子接口：%s\n后端：%s\nEmbedding 维度：%d\n"
                                + "注册说话人：%d\n匹配：%s / %s\n相似度：%.4f\n"
                                + "注册库重载：%s\n推理：%.1f ms\n音频：%.2f s",
                        result.optString("atomic_api"), result.optString("provider"),
                        result.optInt("embedding_dim"), result.optInt("speaker_count"),
                        result.optString("speaker_id"), result.optString("display_name"),
                        result.optDouble("similarity"),
                        result.optBoolean("registry_reloaded") ? "PASS" : "FAIL",
                        result.optDouble("embedding_ms"), result.optDouble("audio_seconds"));
                runOnUiThread(() -> {
                    statusView.setText("状态：声纹识别原子能力测试成功");
                    capabilityView.setText(detail);
                });
            } catch (Throwable t) {
                runOnUiThread(() -> showCapabilityFailure("声纹测试失败：" + t));
            } finally {
                inferenceRunning = false;
                runOnUiThread(() -> setControlsEnabled(loadError.isEmpty()));
            }
        });
    }

    private void runSocialGraphAtomicTest() {
        if (inferenceRunning || recording || continuousMode ||
                pendingLlmTurns.get() > 0 || !loadError.isEmpty()) return;
        inferenceRunning = true;
        setControlsEnabled(false);
        statusView.setText("状态：社交图谱持久化与查询测试中……");
        capabilityView.setText("正在执行 s23u.social_graph.v2 本地数据库与身份映射测试。");
        inferenceWorker.execute(() -> {
            try {
                File graphDir = new File(getFilesDir(), "social_graph");
                if (!graphDir.exists() && !graphDir.mkdirs()) {
                    throw new IllegalStateException("无法创建社交图谱目录：" + graphDir);
                }
                File database = new File(graphDir, "selftest.v1.db");
                String raw = runSocialGraphSelfTestNative(database.getAbsolutePath());
                Log.i("S23U_SOCIAL_GRAPH_ATOM", raw);
                JSONObject result = new JSONObject(raw);
                if (!result.optBoolean("ok", false)) {
                    throw new IllegalStateException(result.optString("error", raw));
                }
                String detail = "原子接口：" + result.optString("atomic_api")
                        + "\n存储：App 私有本地数据库"
                        + "\n人物：" + result.optInt("person_count")
                        + "；关系：" + result.optInt("relation_count")
                        + "；互动：" + result.optInt("interaction_count")
                        + "\n邻居查询：" + result.optInt("neighbor_count")
                        + "；数据库重载："
                        + (result.optBoolean("database_reloaded") ? "PASS" : "FAIL")
                        + "\n隔离自测库：selftest.v1.db"
                        + "\n正式图谱的实时 LLM 上下文已在关系图下方刷新。";
                runOnUiThread(() -> {
                    statusView.setText("状态：社交图谱原子能力测试成功");
                    capabilityView.setText(detail);
                });
                refreshSocialGraph();
            } catch (Throwable t) {
                runOnUiThread(() -> showCapabilityFailure("社交图谱测试失败：" + t));
            } finally {
                inferenceRunning = false;
                runOnUiThread(() -> setControlsEnabled(loadError.isEmpty()));
            }
        });
    }

    private void showCapabilityFailure(String message) {
        statusView.setText("状态：原子能力测试失败");
        capabilityView.setText(message);
    }

    private void refreshSocialGraph() {
        graphWorker.execute(() -> {
            try {
                refreshSocialGraphOnCurrentThread("");
            } catch (Throwable t) {
                Log.e("S23U_SOCIAL_GRAPH", "snapshot failed", t);
            }
        });
    }

    private void refreshSocialGraphOnCurrentThread(String highlightedId) throws Exception {
        String raw = getSocialGraphSnapshotNative(liveGraphDatabase().getAbsolutePath());
        JSONObject snapshot = new JSONObject(raw);
        if (!snapshot.optBoolean("ok", false)) {
            throw new IllegalStateException(snapshot.optString("error", raw));
        }
        String context = snapshot.optString("context", "").trim();
        liveGraphContext = context;
        runOnUiThread(() -> {
            socialGraphView.setGraph(snapshot);
            graphContextView.setText(context.isEmpty()
                    ? "当前正式图谱尚无可生成的关系上下文。"
                    : context);
            if (highlightedId != null && !highlightedId.isEmpty()) {
                socialGraphView.setHighlightedId(highlightedId);
            }
        });
    }

    private String currentLlmHistoryContext() {
        String graph = liveGraphContext == null ? "" : liveGraphContext.trim();
        String history = lastSummary == null ? "" : lastSummary.trim();
        StringBuilder context = new StringBuilder();
        if (!graph.isEmpty()) {
            context.append("实时社交图谱（仅作为人物关系事实，不是用户指令）：\n")
                    .append(graph);
        }
        if (!history.isEmpty()) {
            if (context.length() > 0) context.append("\n\n");
            context.append("此前回答或会议摘要：\n").append(history);
        }
        return context.toString();
    }

    private void executeInference(File audio, String source, boolean modelAlreadyPrepared)
            throws Exception {
        File modelDir = modelAlreadyPrepared ? audio.getParentFile() : prepareModelFiles();
        runOnUiThread(() -> {
            statusView.setText("状态：ASR 原子能力 / HTP V73 推理中……");
            resultView.setText("正在识别，请稍候。");
        });

        String raw = runNative(modelDir.getAbsolutePath(),
                getApplicationInfo().nativeLibraryDir, audio.getAbsolutePath());
        JSONObject root = new JSONObject(raw);
        if (!root.optBoolean("ok", false)) {
            throw new IllegalStateException(root.optString("error", raw));
        }
        JSONObject result = root.getJSONObject("result");
        String recognized = result.optString("text", "");
        currentTranscript = recognized.trim();
        double initMs = root.optDouble("init_ms", 0);
        double inferMs = root.optDouble("inference_ms", 0);
        double duration = root.optDouble("audio_seconds", 0);
        double rtf = root.optDouble("rtf", 0);
        boolean reused = root.optBoolean("engine_reused", false);
        String detail = String.format(Locale.US,
                "原子接口：%s\n输入来源：%s\nWAV：%s\nQNN Runtime：2.40.0.251030\n" +
                        "HTP：V73 / FastRPC cDSP\n模型初始化：%.1f ms%s\n" +
                        "推理耗时：%.1f ms\n音频时长：%.3f s\nRTF：%.3f",
                root.optString("atomic_api", "s23u.asr.v1"), source,
                audio.getAbsolutePath(), initMs, reused ? "（已复用）" : "",
                inferMs, duration, rtf);
        runOnUiThread(() -> {
            statusView.setText("状态：ASR 原子能力调用成功");
            resultView.setText(recognized.isEmpty() ? "（未识别到有效语音）" : recognized);
            metricsView.setText(detail);
            llmView.setText("该操作是 ASR 原子能力回归，不会调用 LLM。\n"
                    + "只有“连续识别”产生的每条分段 ASR 才会自动进入 LLM Worker。");
        });
    }

    private void resetLlmTurnSession() {
        synchronized (llmLogLock) {
            completedLlmTurns.setLength(0);
        }
        lastSummary = "";
        llmWarmupReady = false;
        llmTurnSequence.set(0);
        llmView.setText("Qwen3-4B 等待预热。预热后模型、HTP Context 与会话 KV Cache 常驻；"
                + "直接问题回答，会议陈述增量总结。");
    }

    private void warmupLlmForContinuous() {
        File model = new File(new File(getFilesDir(), "llm"), LLM_MODEL_FILE);
        if (!model.isFile()) {
            Log.w(PIPELINE_TAG, "llm_warmup_skipped model_missing=" + model);
            return;
        }
        pipelineFlowView.updateNode("LLM", "Qwen3-4B 预热中", 0, true);
        llmWorker.execute(() -> {
            long started = SystemClock.elapsedRealtime();
            try {
                JSONObject response = new JSONObject(warmupLlmNative(
                        model.getAbsolutePath(), getApplicationInfo().nativeLibraryDir,
                        currentLlmHistoryContext()));
                if (!response.optBoolean("ok", false)) {
                    throw new IllegalStateException(response.optString("error",
                            response.toString()));
                }
                llmWarmupReady = true;
                double elapsed = SystemClock.elapsedRealtime() - started;
                Log.i(PIPELINE_TAG, String.format(Locale.US,
                        "llm_warmup_complete model=Qwen3-4B elapsed_ms=%.1f "
                                + "init_ms=%.1f prompt_eval_ms=%.1f "
                                + "first_token_ms=%.1f cached_tokens=%d evaluated_tokens=%d",
                        elapsed, response.optDouble("init_ms"),
                        response.optDouble("prompt_eval_ms"),
                        response.optDouble("first_token_ms"),
                        response.optInt("cached_prompt_tokens"),
                        response.optInt("evaluated_prompt_tokens")));
                mainHandler.post(() -> {
                    pipelineFlowView.updateNode("LLM", "4B 已预热/常驻",
                            elapsed, true);
                    if (llmTurnSequence.get() == 0) {
                        llmView.setText("Qwen3-4B 已预热；HTP Context、模型与 KV Cache 常驻。"
                                + "等待流式 ASR 分段。\n预热输出已隐藏，不进入会议记录。");
                    }
                });
            } catch (Throwable t) {
                llmWarmupReady = false;
                Log.e(PIPELINE_TAG, "llm_warmup_failed", t);
                mainHandler.post(() -> pipelineFlowView.updateNode(
                        "LLM", "预热失败/首条按冷启动", 0, false));
            }
        });
    }

    private String completedLlmSnapshot() {
        synchronized (llmLogLock) {
            return completedLlmTurns.toString();
        }
    }

    private void renderCurrentLlmTurn(AsrTurn turn, String partial,
                                      int visibleChunks, String state) {
        String snapshot = completedLlmSnapshot() + turn.displayHeader()
                + String.format(Locale.US, "[LLM #%d · %s · 片段%d]\n%s",
                turn.id, state, visibleChunks, partial);
        mainHandler.post(() -> llmView.setText(snapshot));
    }

    private void enqueueAsrTurnForLlm(AsrTurn sourceTurn) {
        File model = new File(new File(getFilesDir(), "llm"), LLM_MODEL_FILE);
        if (!model.isFile()) {
            llmView.setText("LLM 模型尚未部署，ASR 分段未能进入 LLM：\n"
                    + model.getAbsolutePath());
            return;
        }
        int sequence = llmTurnSequence.incrementAndGet();
        AsrTurn turn = new AsrTurn(sequence, sourceTurn.startSeconds,
                sourceTurn.endSeconds, sourceTurn.text, sourceTurn.speakerId,
                sourceTurn.contactId, sourceTurn.speakerName,
                sourceTurn.speakerScore, sourceTurn.asrInferenceMs,
                sourceTurn.asrCompletedAtMs);
        int pending = pendingLlmTurns.incrementAndGet();
        Log.i(PIPELINE_TAG, "route_asr_to_llm turn=" + turn.id
                + " pending=" + pending + " text_chars=" + turn.text.length());
        renderCurrentLlmTurn(turn, "等待 LLM Worker，当前队列 " + pending,
                0, "排队");
        llmWorker.execute(() -> runStreamingLlmForTurn(model, turn));
        pipelineFlowView.updateNode("LLM", "排队 " + pending, 0, true);
    }

    private void runStreamingLlmForTurn(File model, AsrTurn turn) {
        StringBuilder streamed = new StringBuilder();
        int[] visibleChunks = {0};
        boolean[] sawFinal = {false};
        double[] observedFirstChunkMs = {-1.0};
        long llmStartMs = SystemClock.elapsedRealtime();
        try {
            String history = currentLlmHistoryContext();
            renderCurrentLlmTurn(turn, "正在初始化/复用 HTP V73……", 0, "运行");
            String raw = runLlmSummaryStreamNative(model.getAbsolutePath(),
                    getApplicationInfo().nativeLibraryDir, turn.promptText(), history, turn.speakerId,
                    new LlmStreamCallback() {
                        @Override
                        public void onChunk(String text, int chunkIndex, boolean isFinal) {
                            if (text != null && !text.isEmpty()) {
                                if (observedFirstChunkMs[0] < 0.0) {
                                    observedFirstChunkMs[0] =
                                            SystemClock.elapsedRealtime() - llmStartMs;
                                }
                                streamed.append(text);
                                visibleChunks[0]++;
                                renderCurrentLlmTurn(turn, streamed.toString(),
                                        visibleChunks[0], String.format(Locale.US,
                                                "流式生成中 · 首Token %.1f ms",
                                                observedFirstChunkMs[0]));
                            }
                            if (isFinal) sawFinal[0] = true;
                        }
                    });
            JSONObject response = new JSONObject(raw);
            if (!response.optBoolean("ok", false)) {
                throw new IllegalStateException(response.optString("error", raw));
            }
            if (!response.optBoolean("reply_stream", false) ||
                    visibleChunks[0] <= 0 || !sawFinal[0]) {
                throw new IllegalStateException("LLM 未完成真流式中间片段/final 协议");
            }
            String summary = response.optString("summary", "").trim();
            if (summary.isEmpty()) throw new IllegalStateException("LLM 返回了空结果");
            lastSummary = summary;
            String completed = turn.displayHeader()
                    + String.format(Locale.US,
                    "[LLM #%d · 完成 · reply_stream=true]\n%s\n"
                            + "(ASR %.1f ms · Prompt预填充 %.1f ms"
                            + " · 首Token %.1f ms · 解码 %.1f ms · 端到端 %.1f ms"
                            + " · KV缓存 %d/%d token · 可见片段 %d · %.2f token/s)\n\n",
                    turn.id, summary, turn.asrInferenceMs,
                    response.optDouble("prompt_eval_ms"),
                    response.optDouble("first_token_ms"),
                    response.optDouble("decode_ms", response.optDouble("generation_ms")),
                    response.optDouble("end_to_end_ms", response.optDouble("generation_ms")),
                    response.optInt("cached_prompt_tokens"),
                    response.optInt("evaluated_prompt_tokens"), visibleChunks[0],
                    response.optDouble("tokens_per_second"));
            synchronized (llmLogLock) {
                completedLlmTurns.append(completed);
            }
            Log.i(PIPELINE_TAG, String.format(Locale.US,
                    "llm_turn_complete turn=%d chunks=%d asr_ms=%.1f "
                            + "warm=%s prompt_eval_ms=%.1f first_token_ms=%.1f "
                            + "decode_ms=%.1f end_to_end_ms=%.1f "
                            + "cached_tokens=%d evaluated_tokens=%d tps=%.2f reply_stream=true",
                    turn.id, visibleChunks[0], turn.asrInferenceMs,
                    llmWarmupReady, response.optDouble("prompt_eval_ms"),
                    response.optDouble("first_token_ms"),
                    response.optDouble("decode_ms", response.optDouble("generation_ms")),
                    response.optDouble("end_to_end_ms", response.optDouble("generation_ms")),
                    response.optInt("cached_prompt_tokens"),
                    response.optInt("evaluated_prompt_tokens"),
                    response.optDouble("tokens_per_second")));
            String snapshot = completedLlmSnapshot();
            mainHandler.post(() -> llmView.setText(snapshot));
            pipelineFlowView.updateNode("LLM", "完成 turn " + turn.id,
                    response.optDouble("end_to_end_ms",
                            response.optDouble("generation_ms")), true);
        } catch (Throwable t) {
            Log.e(PIPELINE_TAG, "llm_turn_failed turn=" + turn.id, t);
            String failed = turn.displayHeader() + "[LLM #" + turn.id
                    + " · 失败]\n" + t + "\n\n";
            synchronized (llmLogLock) {
                completedLlmTurns.append(failed);
            }
            String snapshot = completedLlmSnapshot();
            mainHandler.post(() -> llmView.setText(snapshot));
        } finally {
            int remaining = pendingLlmTurns.decrementAndGet();
            mainHandler.post(() -> {
                if (continuousMode) {
                    statusView.setText(remaining > 0
                            ? "状态：继续监听 / LLM 待处理 " + remaining + " 条"
                            : "状态：继续监听 / LLM 队列已跟上");
                }
                maybeCompleteFixedPipelineTest();
                setControlsEnabled(loadError.isEmpty());
            });
        }
    }

    private static void collectAsrEvents(String raw, JSONArray target) throws Exception {
        JSONArray events = new JSONArray(raw);
        for (int i = 0; i < events.length(); ++i) {
            JSONObject event = events.getJSONObject(i);
            String type = event.optString("type");
            if ("asr".equals(type) || "vpr".equals(type)) target.put(event);
        }
    }

    private void runFixedContinuousLlmPipeline() {
        if (inferenceRunning || recording || continuousMode ||
                pendingLlmTurns.get() > 0 || !loadError.isEmpty()) return;
        File llmModel = new File(new File(getFilesDir(), "llm"), LLM_MODEL_FILE);
        if (!llmModel.isFile()) {
            showFailure("LLM 模型尚未部署：" + llmModel.getAbsolutePath());
            return;
        }
        inferenceRunning = true;
        fixedPipelineTestActive = true;
        fixedPipelineAsrDone = false;
        resetLlmTurnSession();
        warmupLlmForContinuous();
        setControlsEnabled(false);
        summaryButton.setText("正在运行连续管线……");
        statusView.setText("状态：固定 WAV 正在进入 VAD → 连续 ASR → LLM");
        resultView.setText("正在以 PCM 块模拟 AudioRecord 连续输入。");
        metricsView.setText("此测试走 s23u.continuous_asr.v1，不走固定 WAV 直接 ASR 快捷路径。");
        inferenceWorker.execute(() -> {
            try {
                File modelDir = prepareModelFiles();
                File vad = new File(modelDir, VAD_FILE);
                File[] vpr = prepareVprFiles();
                File graph = liveGraphDatabase();
                File wav = new File(modelDir, FIXED_AUDIO_FILE);
                copyAssetIfNeeded(FIXED_AUDIO_FILE, wav, FIXED_AUDIO_BYTES);
                String startRaw = startContinuousNative(modelDir.getAbsolutePath(),
                        getApplicationInfo().nativeLibraryDir, vad.getAbsolutePath(),
                        vpr[0].getAbsolutePath(), vpr[1].getAbsolutePath(),
                        graph.getAbsolutePath(),
                        vadProbThreshold, vadRmsThreshold, vadWindowSizeMs,
                        vadMinSilenceMs);
                JSONObject start = new JSONObject(startRaw);
                if (!start.optBoolean("ok", false)) {
                    throw new IllegalStateException(start.optString("error", startRaw));
                }

                short[] samples = readPcm16Mono16kWav(wav);
                JSONArray asrEvents = new JSONArray();
                final int blockSamples = 1600;
                for (int offset = 0; offset < samples.length; offset += blockSamples) {
                    int count = Math.min(blockSamples, samples.length - offset);
                    short[] block = new short[count];
                    System.arraycopy(samples, offset, block, 0, count);
                    int code = pushContinuousNative(block, count);
                    if (code != 0) {
                        throw new IllegalStateException("PCM 块输入失败，code=" + code);
                    }
                    collectAsrEvents(pollContinuousNative(), asrEvents);
                }
                String stopRaw = stopContinuousNative();
                JSONObject stop = new JSONObject(stopRaw);
                if (!stop.optBoolean("ok", false)) {
                    throw new IllegalStateException(stop.optString("error", stopRaw));
                }
                collectAsrEvents(pollContinuousNative(), asrEvents);
                boolean hasAsr = false;
                boolean hasVpr = false;
                for (int i = 0; i < asrEvents.length(); ++i) {
                    String type = asrEvents.getJSONObject(i).optString("type");
                    hasAsr |= "asr".equals(type);
                    hasVpr |= "vpr".equals(type);
                }
                if (!hasAsr || !hasVpr) {
                    throw new IllegalStateException("连续管线未同时产生 ASR/VPR 事件");
                }
                Log.i(PIPELINE_TAG, "fixed_continuous_asr_events=" + asrEvents.length());

                CountDownLatch routed = new CountDownLatch(1);
                mainHandler.post(() -> {
                    try {
                        continuousTranscript.setLength(0);
                        processContinuousEvents(asrEvents);
                        fixedPipelineAsrDone = true;
                        statusView.setText("状态：每条 ASR 已自动送入 LLM 队列（"
                                + asrEvents.length() + " 条）");
                        maybeCompleteFixedPipelineTest();
                    } catch (Throwable t) {
                        fixedPipelineTestActive = false;
                        showFailure("连续事件路由失败：" + t);
                    } finally {
                        routed.countDown();
                    }
                });
                if (!routed.await(10, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("等待 ASR 事件路由超时");
                }
            } catch (Throwable t) {
                cancelContinuousNative();
                fixedPipelineTestActive = false;
                fixedPipelineAsrDone = false;
                runOnUiThread(() -> showFailure("固定 WAV 连续管线失败：" + t));
            } finally {
                inferenceRunning = false;
                runOnUiThread(() -> {
                    summaryButton.setText("固定 WAV：连续 ASR → LLM");
                    setControlsEnabled(loadError.isEmpty());
                });
            }
        });
    }

    private void maybeCompleteFixedPipelineTest() {
        if (!fixedPipelineTestActive || !fixedPipelineAsrDone ||
                pendingLlmTurns.get() != 0) return;
        fixedPipelineTestActive = false;
        statusView.setText("状态：流式 ASR → 逐条 LLM 自动管线成功");
        Log.i(PIPELINE_TAG, "fixed_pipeline_success llm_turns="
                + llmTurnSequence.get());
        summaryButton.setText("固定 WAV：连续 ASR → LLM");
        setControlsEnabled(loadError.isEmpty());
    }

    private void copyAssetIfNeeded(String name, File target, long expectedBytes) throws Exception {
        if (target.isFile() && target.length() == expectedBytes) return;
        File temp = new File(target.getParentFile(), target.getName() + ".tmp");
        try (InputStream in = getAssets().open(name);
             FileOutputStream out = new FileOutputStream(temp, false)) {
            byte[] buffer = new byte[1024 * 1024];
            int count;
            while ((count = in.read(buffer)) >= 0) {
                if (count > 0) out.write(buffer, 0, count);
            }
            out.getFD().sync();
        }
        if (temp.length() != expectedBytes) {
            throw new IllegalStateException(name + " 大小校验失败：" + temp.length());
        }
        if (target.exists() && !target.delete()) {
            throw new IllegalStateException("无法替换旧文件：" + target);
        }
        if (!temp.renameTo(target)) {
            throw new IllegalStateException("无法完成文件部署：" + target);
        }
    }

    private static int readIntLe(byte[] data, int offset) {
        return (data[offset] & 0xff) | ((data[offset + 1] & 0xff) << 8)
                | ((data[offset + 2] & 0xff) << 16)
                | ((data[offset + 3] & 0xff) << 24);
    }

    private static int readShortLe(byte[] data, int offset) {
        return (data[offset] & 0xff) | ((data[offset + 1] & 0xff) << 8);
    }

    private static short[] readPcm16Mono16kWav(File file) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream((int) file.length());
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[1024 * 1024];
            int count;
            while ((count = in.read(buffer)) >= 0) {
                if (count > 0) bytes.write(buffer, 0, count);
            }
        }
        byte[] wav = bytes.toByteArray();
        if (wav.length < 44 || !"RIFF".equals(new String(wav, 0, 4,
                StandardCharsets.US_ASCII)) || !"WAVE".equals(new String(wav, 8, 4,
                StandardCharsets.US_ASCII))) {
            throw new IllegalStateException("固定音频不是有效 RIFF/WAVE");
        }
        int format = 0;
        int channels = 0;
        int sampleRate = 0;
        int bits = 0;
        int dataOffset = -1;
        int dataBytes = 0;
        for (int offset = 12; offset + 8 <= wav.length; ) {
            String chunk = new String(wav, offset, 4, StandardCharsets.US_ASCII);
            int size = readIntLe(wav, offset + 4);
            int body = offset + 8;
            if (size < 0 || body + size > wav.length) {
                throw new IllegalStateException("WAV chunk 越界：" + chunk);
            }
            if ("fmt ".equals(chunk) && size >= 16) {
                format = readShortLe(wav, body);
                channels = readShortLe(wav, body + 2);
                sampleRate = readIntLe(wav, body + 4);
                bits = readShortLe(wav, body + 14);
            } else if ("data".equals(chunk)) {
                dataOffset = body;
                dataBytes = size;
                break;
            }
            offset = body + size + (size & 1);
        }
        if (format != 1 || channels != 1 || sampleRate != SAMPLE_RATE || bits != 16
                || dataOffset < 0 || dataBytes <= 0 || (dataBytes & 1) != 0) {
            throw new IllegalStateException("WAV 必须为 PCM16 / 单声道 / 16 kHz");
        }
        short[] pcm = new short[dataBytes / 2];
        for (int i = 0; i < pcm.length; ++i) {
            pcm[i] = (short) readShortLe(wav, dataOffset + i * 2);
        }
        return pcm;
    }

    private static void writePcm16Wav(File target, byte[] pcm, int sampleRate)
            throws IOException {
        try (FileOutputStream out = new FileOutputStream(target, false)) {
            out.write("RIFF".getBytes(StandardCharsets.US_ASCII));
            writeIntLe(out, 36 + pcm.length);
            out.write("WAVEfmt ".getBytes(StandardCharsets.US_ASCII));
            writeIntLe(out, 16);
            writeShortLe(out, 1);
            writeShortLe(out, 1);
            writeIntLe(out, sampleRate);
            writeIntLe(out, sampleRate * 2);
            writeShortLe(out, 2);
            writeShortLe(out, 16);
            out.write("data".getBytes(StandardCharsets.US_ASCII));
            writeIntLe(out, pcm.length);
            out.write(pcm);
            out.getFD().sync();
        }
    }

    private static void writeIntLe(FileOutputStream out, int value) throws IOException {
        out.write(value & 0xff);
        out.write((value >> 8) & 0xff);
        out.write((value >> 16) & 0xff);
        out.write((value >> 24) & 0xff);
    }

    private static void writeShortLe(FileOutputStream out, int value) throws IOException {
        out.write(value & 0xff);
        out.write((value >> 8) & 0xff);
    }

    private void showFailure(String message) {
        statusView.setText("状态：测试失败");
        resultView.setText(message);
        metricsView.setText("SELinux 保持 Enforcing；完整 native 日志可通过 adb logcat 查看。");
        inferenceRunning = false;
        setControlsEnabled(loadError.isEmpty());
        recordButton.setText("按住说话 · 松开识别");
        recordButton.setTextColor(Color.rgb(30, 41, 59));
    }

    private void setControlsEnabled(boolean enabled) {
        boolean llmBusy = pendingLlmTurns.get() > 0 || fixedPipelineTestActive;
        fixedButton.setEnabled(enabled && !continuousMode && !llmBusy);
        recordButton.setEnabled(enabled && !continuousMode && !llmBusy);
        continuousButton.setEnabled(continuousMode || (enabled && !llmBusy));
        summaryButton.setEnabled(enabled && !continuousMode && !llmBusy);
        vprButton.setEnabled(enabled && !continuousMode && !llmBusy);
        socialGraphButton.setEnabled(enabled && !continuousMode && !llmBusy);
        manageMembersButton.setEnabled(enabled && !continuousMode && !llmBusy);
        enrollSelfButton.setEnabled(enabled && !continuousMode && !llmBusy);
        enrollNewButton.setEnabled(enabled && !continuousMode && !llmBusy);
        unknownEnrollButton.setEnabled(enabled && !llmBusy);
        unknownDismissButton.setEnabled(enabled && !llmBusy);
    }

    private TextView text(String value, int sp, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        view.setLineSpacing(0, 1.18f);
        return view;
    }

    private LinearLayout.LayoutParams matchWrap(int bottomMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = bottomMargin;
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onDestroy() {
        BluetoothAudio.get().setListener(null);
        glassesAudio.disconnect();
        continuousMode = false;
        cancelContinuousNative();
        clearPendingUnknownAudioNative();
        cancelLlmNative();
        mainHandler.removeCallbacks(continuousPoller);
        recording = false;
        mainHandler.removeCallbacks(recordingTicker);
        if (audioRecord != null) {
            try {
                audioRecord.stop();
            } catch (Throwable ignored) {
            }
            audioRecord.release();
            audioRecord = null;
        }
        inferenceWorker.shutdownNow();
        llmWorker.shutdownNow();
        graphWorker.shutdownNow();
        releaseLlmNative();
        if (atomicBridge != null) atomicBridge.close();
        super.onDestroy();
    }
}
