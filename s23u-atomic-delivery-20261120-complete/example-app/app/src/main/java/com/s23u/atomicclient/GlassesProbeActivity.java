package com.s23u.atomicclient;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * 智能眼镜（AP510DL EVB）BLE 链路自检页。
 *
 * <p>本页只验证 BLE 契约，不做 LC3 解码、不接 ASR：
 * 扫描 → 连接 → MTU/PHY → 服务发现 → 开通知 → START → 统计收包 → 文本回传。
 *
 * <p>协议见 PROTOCOL.md / ANDROID.md：EVB 是 GATT 服务端，手机是 central。
 */
public final class GlassesProbeActivity extends Activity {

    // ---- 协议常量（PROTOCOL v1，2026-11-19 版：基址 b5a0XXXX-0000-1000-8000-00805f9b34fb）----
    private static final UUID SERVICE_UUID = GlassesAudio.SERVICE_UUID;
    private static final UUID AUDIO_DATA_UUID = GlassesAudio.AUDIO_DATA_UUID;
    private static final UUID TEXT_STREAM_UUID =
            UUID.fromString("b5a00003-0000-1000-8000-00805f9b34fb");
    private static final UUID NOTIFY_MSG_UUID =
            UUID.fromString("b5a00004-0000-1000-8000-00805f9b34fb");
    private static final UUID AUDIO_CTRL_UUID = GlassesAudio.AUDIO_CTRL_UUID;
    private static final UUID STATUS_UUID =
            UUID.fromString("b5a00006-0000-1000-8000-00805f9b34fb");
    private static final UUID CCCD_UUID = GlassesAudio.CCCD_UUID;

    private static final int REQUEST_MTU = 247;
    private static final int GATT_TIMEOUT_MS = 2500;
    private static final int TEXT_CLEAR = 0x03;
    private static final int TYPE_PARTIAL = 0x01;
    private static final int TYPE_FINAL = 0x02;
    private static final int TYPE_SUMMARY = 0x10;
    private static final int TYPE_CARD = 0x11;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ArrayDeque<Runnable> gattQueue = new ArrayDeque<>();
    private final java.util.Set<String> loggedAddresses = new java.util.HashSet<>();
    private final StringBuilder transcript = new StringBuilder();

    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private BluetoothDevice target;
    private BluetoothGattCharacteristic audioData;
    private BluetoothGattCharacteristic textStream;
    private BluetoothGattCharacteristic notifyMsg;
    private BluetoothGattCharacteristic audioCtrl;
    private BluetoothGattCharacteristic statusChar;

    private TextView statusView;
    private TextView linkView;
    private TextView statsView;
    private TextView statusReportView;
    private TextView rawView;
    private TextView transcriptView;
    private TextView logView;

    private int mtu = 23;
    private int phyTx = -1;
    private int framesPerPacket;
    private long packets;
    private long gaps;
    private long bytes;
    private int lastSeq = -1;
    private int seqErrors;
    private int packetsThisSecond;
    private int packetsPerSecond;
    private String lastStatusJson = "-";
    private String lastPacketInfo = "-";
    private byte[] lastPacket = new byte[0];
    private int messageId = 1;
    private boolean scanning;
    private boolean scanAll;
    private boolean gattBusy;
    private long lastUiUpdate;
    private long lastStatusLog;
    private boolean periodicEcho;
    private Button periodicEchoButton;
    private long periodicEchoCount;

    // ---------------------------------------------------------------- 生命周期

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(createContentView());
        BluetoothManager manager = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = manager == null ? null : manager.getAdapter();
        refreshLinkInfo();
        startStatsTicker();
    }

    @Override protected void onDestroy() {
        periodicEcho = false;
        handler.removeCallbacksAndMessages(null);
        stopScan();
        closeGatt();
        super.onDestroy();
    }

    // ---------------------------------------------------------------- UI

    private View createContentView() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(248, 250, 252));
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(18), dp(18), dp(28));
        scroll.addView(root);

        Button back = button("← 返回主界面", 15);
        back.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        back.setOnClickListener(v -> finish());
        root.addView(back, wrap(dp(6)));

        TextView title = text("眼镜链路自检（BLE）", 22, Color.rgb(15, 23, 42));
        title.setGravity(Gravity.CENTER_HORIZONTAL);
        title.setTypeface(null, Typeface.BOLD);
        root.addView(title, wrap(dp(6)));

        TextView sub = text("只验证 BLE 契约：扫描 / 连接 / MTU / PHY / 收包 / 文本回传。不做 LC3 解码。",
                12, Color.rgb(100, 116, 139));
        sub.setGravity(Gravity.CENTER_HORIZONTAL);
        root.addView(sub, wrap(dp(14)));

        statusView = card("状态：未开始", 15, Color.rgb(15, 23, 42));
        root.addView(statusView, wrap(dp(10)));

        LinearLayout row1 = new LinearLayout(this);
        row1.setOrientation(LinearLayout.HORIZONTAL);
        Button scanButton = button("扫描并连接", 15);
        scanButton.setOnClickListener(v -> startScan());
        row1.addView(scanButton, new LinearLayout.LayoutParams(0, dp(50), 1));
        Button disconnect = button("断开", 15);
        disconnect.setOnClickListener(v -> {
            stopScan();
            closeGatt();
            setStatus("已断开");
        });
        LinearLayout.LayoutParams p1 = new LinearLayout.LayoutParams(0, dp(50), 1);
        p1.leftMargin = dp(8);
        row1.addView(disconnect, p1);
        root.addView(row1, wrap(dp(8)));

        // 排查用：不加过滤器，把附近所有 BLE 设备都列出来，确认眼镜到底有没有在广播。
        Button scanAllButton = button("扫描全部 BLE 设备（排查用）", 13);
        scanAllButton.setOnClickListener(v -> startScan(true));
        root.addView(scanAllButton, wrap(dp(12)));

        linkView = card("连接：-", 13, Color.rgb(51, 65, 85));
        linkView.setTypeface(Typeface.MONOSPACE);
        root.addView(linkView, wrap(dp(10)));

        root.addView(sectionLabel("音频控制（audio_ctrl）"), wrap(dp(4)));
        LinearLayout row2 = new LinearLayout(this);
        row2.setOrientation(LinearLayout.HORIZONTAL);
        Button startEn = button("START 英文", 14);
        startEn.setOnClickListener(v -> sendStart(0));
        row2.addView(startEn, new LinearLayout.LayoutParams(0, dp(48), 1));
        Button startZh = button("START 中文", 14);
        startZh.setOnClickListener(v -> sendStart(1));
        LinearLayout.LayoutParams p2 = new LinearLayout.LayoutParams(0, dp(48), 1);
        p2.leftMargin = dp(6);
        row2.addView(startZh, p2);
        Button stop = button("STOP", 14);
        stop.setOnClickListener(v -> sendStop());
        LinearLayout.LayoutParams p3 = new LinearLayout.LayoutParams(0, dp(48), 1);
        p3.leftMargin = dp(6);
        row2.addView(stop, p3);
        root.addView(row2, wrap(dp(10)));

        root.addView(sectionLabel("状态与文本回传"), wrap(dp(4)));
        LinearLayout row3 = new LinearLayout(this);
        row3.setOrientation(LinearLayout.HORIZONTAL);
        Button readStatus = button("读 status", 14);
        readStatus.setOnClickListener(v -> readStatus());
        row3.addView(readStatus, new LinearLayout.LayoutParams(0, dp(48), 1));
        Button cardBtn = button("发测试 CARD", 14);
        cardBtn.setOnClickListener(v -> sendCard());
        LinearLayout.LayoutParams p4 = new LinearLayout.LayoutParams(0, dp(48), 1);
        p4.leftMargin = dp(6);
        row3.addView(cardBtn, p4);
        Button summaryBtn = button("发测试 SUMMARY", 14);
        summaryBtn.setOnClickListener(v -> sendSummary());
        LinearLayout.LayoutParams p5 = new LinearLayout.LayoutParams(0, dp(48), 1);
        p5.leftMargin = dp(6);
        row3.addView(summaryBtn, p5);
        root.addView(row3, wrap(dp(10)));

        LinearLayout row4 = new LinearLayout(this);
        row4.setOrientation(LinearLayout.HORIZONTAL);
        Button partial = button("发 PARTIAL", 14);
        partial.setOnClickListener(v -> sendText(TYPE_PARTIAL, false,
                "部分识别结果 partial " + messageId));
        row4.addView(partial, new LinearLayout.LayoutParams(0, dp(48), 1));
        Button finals = button("发 FINAL", 14);
        finals.setOnClickListener(v -> sendText(TYPE_FINAL, false,
                "最终识别结果 final " + messageId));
        LinearLayout.LayoutParams p6 = new LinearLayout.LayoutParams(0, dp(48), 1);
        p6.leftMargin = dp(6);
        row4.addView(finals, p6);
        Button clear = button("CLEAR", 14);
        clear.setOnClickListener(v -> sendClear());
        LinearLayout.LayoutParams p7 = new LinearLayout.LayoutParams(0, dp(48), 1);
        p7.leftMargin = dp(6);
        row4.addView(clear, p7);
        root.addView(row4, wrap(dp(8)));

        // 原样回传：把最近收到的那一包原始字节以 HEX 发回，供对端逐字节比对。
        Button echoButton = button("回传最近一包原始数据（HEX）", 14);
        echoButton.setOnClickListener(v -> sendRawEcho());
        root.addView(echoButton, wrap(dp(6)));

        // 周期回传：每 500ms 把最近一包原样发回（约 6 次写/秒，BLE 能吃下）。
        periodicEchoButton = button("每 500ms 回传：关", 14);
        periodicEchoButton.setOnClickListener(v -> togglePeriodicEcho());
        root.addView(periodicEchoButton, wrap(dp(10)));

        root.addView(sectionLabel("统计"), wrap(dp(4)));
        statsView = card("", 13, Color.rgb(51, 65, 85));
        statsView.setTypeface(Typeface.MONOSPACE);
        root.addView(statsView, wrap(dp(10)));

        root.addView(sectionLabel("status 回报"), wrap(dp(4)));
        statusReportView = card("-", 12, Color.rgb(51, 65, 85));
        statusReportView.setTypeface(Typeface.MONOSPACE);
        root.addView(statusReportView, wrap(dp(10)));

        root.addView(sectionLabel("最近一包（前 16 字节）"), wrap(dp(4)));
        rawView = card("（尚未收到）", 12, Color.rgb(15, 23, 42));
        rawView.setTypeface(Typeface.MONOSPACE);
        root.addView(rawView, wrap(dp(10)));

        root.addView(sectionLabel("回传的文本"), wrap(dp(4)));
        transcriptView = card("（空）", 13, Color.rgb(15, 23, 42));
        root.addView(transcriptView, wrap(dp(10)));

        root.addView(sectionLabel("事件日志"), wrap(dp(4)));
        logView = card("", 11, Color.rgb(71, 85, 105));
        logView.setTypeface(Typeface.MONOSPACE);
        root.addView(logView, wrap(dp(10)));

        return scroll;
    }

    private TextView sectionLabel(String value) {
        return text(value, 13, Color.rgb(71, 85, 105));
    }

    private TextView card(String value, int size, int color) {
        TextView view = text(value, size, color);
        view.setTextIsSelectable(true);
        view.setPadding(dp(12), dp(10), dp(12), dp(10));
        view.setBackgroundColor(Color.WHITE);
        return view;
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private Button button(String label, int size) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextSize(size);
        b.setAllCaps(false);
        return b;
    }

    private LinearLayout.LayoutParams wrap(int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = bottom;
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    // ---------------------------------------------------------------- 权限与扫描

    private void ensurePermissions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
        java.util.List<String> needed = new java.util.ArrayList<>();
        if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.BLUETOOTH_CONNECT);
        }
        if (checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.BLUETOOTH_SCAN);
        }
        if (!needed.isEmpty()) {
            requestPermissions(needed.toArray(new String[0]), 3001);
        }
    }

    @SuppressLint("MissingPermission")
    private void startScan() {
        startScan(false);
    }

    @SuppressLint("MissingPermission")
    private void startScan(boolean scanEverything) {
        ensurePermissions();
        if (adapter == null || !adapter.isEnabled()) {
            setStatus("蓝牙未打开");
            return;
        }
        // 关键：上次扫描没停就再 startScan，系统会回 SCAN_FAILED_ALREADY_STARTED(1)。
        if (scanning) {
            stopScan();
            setStatus("已停止上一次扫描；再点一次即可重新扫描");
            return;
        }
        closeGatt();
        scanAll = scanEverything;
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) {
            setStatus("无法获取 BLE 扫描器");
            return;
        }
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();
        // 实测：带 ScanFilter(setServiceUuid) 在本机扫不到眼镜，
        // 不带过滤器立刻就能扫到（名字在 scan response 里）。
        // 所以统一不过滤，按名字前缀 AP510DL 匹配；服务 UUID 仍用于后续发现。
        List<ScanFilter> filters = Collections.emptyList();
        scanning = true;
        setStatus(scanEverything ? "正在扫描全部 BLE 设备…" : "正在扫描 AP510DL_* 设备…");
        log("startScan all=" + scanEverything + "（不过滤，按名字匹配）");
        try {
            scanner.startScan(filters, settings, scanCallback);
        } catch (SecurityException denied) {
            setStatus("扫描被拒绝：" + denied.getMessage());
            scanning = false;
        }
    }

    @SuppressLint("MissingPermission")
    private void stopScan() {
        if (!scanning) return;
        scanning = false;
        try {
            if (scanner != null) scanner.stopScan(scanCallback);
        } catch (Throwable ignored) {
            // 扫描已停止
        }
    }

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override public void onScanResult(int callbackType, ScanResult result) {
            BluetoothDevice device = result.getDevice();
            if (device == null) return;
            String name;
            try {
                name = device.getName();
            } catch (SecurityException denied) {
                name = null;
            }
            String address = device.getAddress();
            // 名字只在 scan response 里，部分扫描结果拿不到名字；
            // 再用扫描记录里的服务 UUID 做第二判据，两个命中任一即可。
            boolean hasService = false;
            try {
                android.bluetooth.le.ScanRecord record = result.getScanRecord();
                List<ParcelUuid> uuids = record == null ? null : record.getServiceUuids();
                hasService = uuids != null && uuids.contains(new ParcelUuid(SERVICE_UUID));
            } catch (Throwable ignored) {
                // 扫描记录不可用时只看名字
            }
            boolean nameMatch = name != null && name.startsWith("AP510DL");

            // 同一地址只记一次，避免日志刷屏（也会让 uiautomator 抓不到界面）
            if (loggedAddresses.add(address)) {
                log("BLE 设备 " + (name == null ? "(无名)" : name) + " " + address
                        + " rssi=" + result.getRssi()
                        + (nameMatch ? " [名字命中]" : "") + (hasService ? " [UUID 命中]" : ""));
            }

            if (scanAll) {
                if (nameMatch) {
                    setStatus("扫到目标 " + name + "，可以切回「扫描并连接」");
                }
                return;
            }
            if (!nameMatch && !hasService) return;

            log("目标确认：" + (name == null ? address : name)
                    + (nameMatch ? "" : "（靠服务 UUID 识别）"));
            stopScan();
            target = device;
            connect(device);
        }

        @Override public void onScanFailed(int errorCode) {
            scanning = false;
            if (errorCode == SCAN_FAILED_ALREADY_STARTED) {
                // 系统里还有别的扫描在跑：先停再自动重试一次
                setStatus("已有扫描在进行，已停止并重试…");
                try {
                    if (scanner != null) scanner.stopScan(scanCallback);
                } catch (Throwable ignored) {
                    // 停止失败则依赖下次点击
                }
                handler.postDelayed(() -> startScan(scanAll), 800);
                return;
            }
            setStatus("扫描失败 errorCode=" + errorCode
                    + "（1=已在进行 2=注册失败 3=内部错误 4=不支持 5=资源不足 6=过于频繁）");
        }
    };

    // ---------------------------------------------------------------- 连接与 GATT

    @SuppressLint("MissingPermission")
    private void connect(BluetoothDevice device) {
        setStatus("正在连接 " + device.getAddress() + " …");
        try {
            gatt = device.connectGatt(this, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
        } catch (SecurityException denied) {
            setStatus("连接被拒绝：" + denied.getMessage());
        }
    }

    @SuppressLint("MissingPermission")
    private void closeGatt() {
        synchronized (gattQueue) {
            gattQueue.clear();
            gattBusy = false;
        }
        BluetoothGatt current = gatt;
        gatt = null;
        audioData = null;
        textStream = null;
        notifyMsg = null;
        audioCtrl = null;
        statusChar = null;
        if (current != null) {
            try {
                current.disconnect();
            } catch (Throwable ignored) {
                // 已断开
            }
            try {
                current.close();
            } catch (Throwable ignored) {
                // 已关闭
            }
        }
    }

    /**
     * Android 每个连接只允许一个未完成的 GATT 操作，全部串行进这个队列。
     * 关键：入队时只有在"当前没有操作在飞"的情况下才立刻启动，
     * 否则第二个操作会在第一个回调之前发出去，被系统丢弃（表现为 status=129 或静默失败）。
     */
    private void enqueue(Runnable operation) {
        synchronized (gattQueue) {
            gattQueue.addLast(operation);
        }
        if (!gattBusy) {
            runNext();
        }
    }

    private void runNext() {
        Runnable next;
        synchronized (gattQueue) {
            next = gattQueue.pollFirst();
            gattBusy = next != null;
        }
        handler.removeCallbacks(gattTimeout);
        if (next == null) return;
        // 看门狗：某个操作的回调丢了（实测多片写第 2 片就可能不回），
        // 不超时的话 gattBusy 永远为 true，后面所有操作都会被堵死。
        handler.postDelayed(gattTimeout, GATT_TIMEOUT_MS);
        try {
            next.run();
        } catch (Throwable error) {
            log("GATT 操作异常：" + error);
            synchronized (gattQueue) {
                gattBusy = false;
            }
            runNext();
        }
    }

    private final Runnable gattTimeout = new Runnable() {
        @Override public void run() {
            synchronized (gattQueue) {
                if (!gattBusy) return;
                gattBusy = false;
            }
            log("GATT 操作超时（" + GATT_TIMEOUT_MS + "ms 无回调），强制推进队列");
            runNext();
        }
    };

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {

        @Override public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                setStatus("已连接，开始服务发现");
                log("connected status=" + status);
                try {
                    g.discoverServices();
                } catch (SecurityException denied) {
                    setStatus("服务发现被拒绝");
                }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                setStatus("连接已断开 status=" + status);
                log("disconnected status=" + status);
                refreshLinkInfo();
            }
        }

        @Override public void onServicesDiscovered(BluetoothGatt g, int status) {
            log("onServicesDiscovered status=" + status);
            if (status != BluetoothGatt.GATT_SUCCESS) {
                setStatus("服务发现失败 status=" + status);
                return;
            }
            BluetoothGattService service = g.getService(SERVICE_UUID);
            if (service == null) {
                setStatus("没找到目标服务，设备可能不是这套协议");
                for (BluetoothGattService other : g.getServices()) {
                    log("  发现服务 " + other.getUuid());
                }
                return;
            }
            audioData = service.getCharacteristic(AUDIO_DATA_UUID);
            textStream = service.getCharacteristic(TEXT_STREAM_UUID);
            notifyMsg = service.getCharacteristic(NOTIFY_MSG_UUID);
            audioCtrl = service.getCharacteristic(AUDIO_CTRL_UUID);
            statusChar = service.getCharacteristic(STATUS_UUID);
            log("特征值：audio=" + (audioData != null) + " text=" + (textStream != null)
                    + " msg=" + (notifyMsg != null) + " ctrl=" + (audioCtrl != null)
                    + " status=" + (statusChar != null));
            setStatus("服务已发现，请求 MTU " + REQUEST_MTU);
            g.requestMtu(REQUEST_MTU);
        }

        @Override public void onMtuChanged(BluetoothGatt g, int newMtu, int status) {
            mtu = newMtu;
            log("onMtuChanged mtu=" + newMtu + " status=" + status);
            framesPerPacket = Math.max(1, Math.min(6, (mtu - 5) / 40));
            refreshLinkInfo();
            // 注意：这里不再调用 setPreferredPhy / requestConnectionPriority。
            // 它们是 GATT 操作，紧接着写 CCCD 会撞车（实测 START 写回 129）。
            // 协议里 EVB 自己会请求 2M PHY 和 15–30ms 间隔，实测已拿到 PHY=2M、interval=24(30ms)。
            enableNotifications(g);
        }

        @Override public void onPhyUpdate(BluetoothGatt g, int txPhy, int rxPhy, int status) {
            phyTx = txPhy;
            log("onPhyUpdate tx=" + phyName(txPhy) + " rx=" + phyName(rxPhy) + " status=" + status);
            refreshLinkInfo();
        }

        @Override public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
            UUID characteristic = d.getCharacteristic().getUuid();
            log("onDescriptorWrite " + shortUuid(characteristic) + " status=" + status);
            if (AUDIO_DATA_UUID.equals(characteristic) && status == BluetoothGatt.GATT_SUCCESS) {
                setStatus("通知已开启（audio_data），可以点 START");
            }
            runNext();
        }

        @Override public void onCharacteristicWrite(BluetoothGatt g,
                                                    BluetoothGattCharacteristic c, int status) {
            log("onCharacteristicWrite " + shortUuid(c.getUuid()) + " status=" + status
                    + (status != BluetoothGatt.GATT_SUCCESS ? "（失败，看协议错误码表）" : ""));
            runNext();
        }

        @Override public void onCharacteristicRead(BluetoothGatt g,
                                                   BluetoothGattCharacteristic c, int status) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                return; // API 33+ 走下面带 value 的重载
            }
            log("onCharacteristicRead(legacy) " + shortUuid(c.getUuid()) + " status=" + status);
            handleStatusValue(c.getValue());
            runNext();
        }

        @Override public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c,
                                                   byte[] value, int status) {
            log("onCharacteristicRead " + shortUuid(c.getUuid()) + " status=" + status);
            handleStatusValue(value);
            runNext();
        }

        @Override public void onCharacteristicChanged(BluetoothGatt g,
                                                      BluetoothGattCharacteristic c) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                return; // API 33+ 走下面带 value 的重载
            }
            handleNotification(c.getUuid(), c.getValue());
        }

        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c,
                                                       byte[] value) {
            handleNotification(c.getUuid(), value);
        }
    };

    // ---------------------------------------------------------------- 通知与操作

    @SuppressLint("MissingPermission")
    private void enableNotifications(BluetoothGatt g) {
        if (statusChar != null) {
            g.setCharacteristicNotification(statusChar, true);
            writeCccd(g, statusChar, true);
        }
        if (audioData != null) {
            g.setCharacteristicNotification(audioData, true);
            writeCccd(g, audioData, true);
        }
    }

    private void writeCccd(BluetoothGatt g, BluetoothGattCharacteristic c, boolean enable) {
        BluetoothGattDescriptor descriptor = c.getDescriptor(CCCD_UUID);
        if (descriptor == null) {
            log("CCCD 不存在：" + shortUuid(c.getUuid()));
            // 不能直接 return：队列里后面的操作会永久卡住
            runNext();
            return;
        }
        byte[] value = enable
                ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                : BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE;
        enqueue(() -> {
            boolean started;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                started = g.writeDescriptor(descriptor, value) == BluetoothStatusCodes.SUCCESS;
            } else {
                descriptor.setValue(value);
                started = g.writeDescriptor(descriptor);
            }
            log("写 CCCD " + shortUuid(c.getUuid()) + " = " + (enable ? "01 00" : "00 00")
                    + (started ? "" : "（提交失败）"));
            // 提交失败不会有回调，必须自己推进队列，否则 START 永远发不出去
            if (!started) runNext();
        });
    }

    private void sendStart(int source) {
        byte[] payload = new byte[] {0x01, (byte) source};
        writeControl(payload, "START source=" + source);
    }

    private void sendStop() {
        writeControl(new byte[] {0x00}, "STOP");
    }

    private void writeControl(byte[] payload, String label) {
        BluetoothGatt g = gatt;
        if (g == null || audioCtrl == null) {
            setStatus("未连接或无 audio_ctrl");
            return;
        }
        enqueue(() -> {
            write(g, audioCtrl, payload, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            log("写 audio_ctrl：" + label + " → " + hex(payload));
        });
    }

    private void readStatus() {
        BluetoothGatt g = gatt;
        if (g == null || statusChar == null) {
            setStatus("未连接或无 status 特征值");
            return;
        }
        enqueue(() -> {
            g.readCharacteristic(statusChar);
            log("读 status …");
        });
    }

    private void sendCard() {
        int id = messageId++;
        sendText(TYPE_CARD, true, "TEST CARD " + id + "\nhello from S23U, mtu=" + mtu);
    }

    private void sendSummary() {
        int id = messageId++;
        sendText(TYPE_SUMMARY, true, "TEST SUMMARY " + id + "：这是一条来自手机的测试摘要。");
    }

    /**
     * 原样回传：把最近收到的那个包的原始字节以 HEX 发回给眼镜，
     * 供对端逐字节比对（文本通道只能发文本，所以用 HEX 表示原始数据）。
     */
    private void sendRawEcho() {
        byte[] packet = lastPacket;
        if (packet == null || packet.length == 0) {
            setStatus("还没收到过数据，无法回传");
            return;
        }
        int id = messageId++;
        String text = "ECHO len=" + packet.length + " hex=" + hex(packet);
        log("回传原始数据 " + packet.length + " 字节（HEX " + (packet.length * 2) + " 字符）");
        sendText(TYPE_FINAL, true, text);
        appendTranscript("[ECHO msg=" + id + "] len=" + packet.length
                + " seq=" + lastSeq + " → " + (packet.length * 2) + " 字符");
    }

    /** 每 500ms 回传最近一包。500ms = 2 次/秒 × 约 3 片写 ≈ 6 写/秒，BLE 可以承受。 */
    private void togglePeriodicEcho() {
        periodicEcho = !periodicEcho;
        handler.removeCallbacks(periodicEchoTask);
        if (periodicEcho) {
            periodicEchoCount = 0;
            handler.post(periodicEchoTask);
            setStatus("已开始每 500ms 回传最近一包");
        } else {
            setStatus("已停止周期回传（共 " + periodicEchoCount + " 次）");
        }
        if (periodicEchoButton != null) {
            periodicEchoButton.setText(periodicEcho ? "每 500ms 回传：开（点击停止）" : "每 500ms 回传：关");
        }
    }

    private final Runnable periodicEchoTask = new Runnable() {
        @Override public void run() {
            if (!periodicEcho) return;
            if (gatt != null && lastPacket != null && lastPacket.length > 0) {
                periodicEchoCount++;
                sendRawEcho();
            }
            handler.postDelayed(this, 500);
        }
    };
    private void sendClear() {
        BluetoothGatt g = gatt;
        if (g == null || textStream == null) return;
        int id = messageId++;
        enqueue(() -> {
            write(g, textStream, frame(id, TEXT_CLEAR, 0x80, new byte[0]),
                    BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            log("发 CLEAR msg_id=" + id);
        });
    }

    /**
     * 按协议分片发送文本：每写最多 MTU-3 字节，头 4 字节，所以每片最多 MTU-7 字节文本。
     * frag = bit7 表示最后一片，低 7 位是片序号。
     */
    private void sendText(int type, boolean reliable, String text) {
        BluetoothGatt g = gatt;
        BluetoothGattCharacteristic target = reliable ? notifyMsg : textStream;
        if (g == null || target == null) {
            setStatus("未连接或无目标特征值");
            return;
        }
        int id = messageId++;
        byte[] utf8 = text.getBytes(StandardCharsets.UTF_8);
        int perWrite = Math.max(1, mtu - 7);
        int total = Math.max(1, (utf8.length + perWrite - 1) / perWrite);
        for (int index = 0; index < total; index++) {
            int from = index * perWrite;
            int to = Math.min(utf8.length, from + perWrite);
            byte[] chunk = Arrays.copyOfRange(utf8, from, to);
            int frag = index | ((index == total - 1) ? 0x80 : 0x00);
            final int fragIndex = index;
            enqueue(() -> {
                write(g, target, frame(id, type, frag, chunk),
                        reliable ? BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                                 : BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
                log("发 type=0x0" + Integer.toHexString(type) + " msg=" + id
                        + " frag=" + fragIndex + "/" + total + " 长度=" + chunk.length);
            });
        }
        appendTranscript(String.format(Locale.US, "[type=0x%02X msg=%d] %s", type, id, text));
    }

    private static byte[] frame(int msgId, int type, int frag, byte[] text) {
        byte[] out = new byte[4 + text.length];
        out[0] = (byte) (msgId & 0xFF);
        out[1] = (byte) ((msgId >> 8) & 0xFF);
        out[2] = (byte) type;
        out[3] = (byte) frag;
        System.arraycopy(text, 0, out, 4, text.length);
        return out;
    }

    @SuppressLint("MissingPermission")
    private void write(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value, int writeType) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            int code = g.writeCharacteristic(c, value, writeType);
            if (code != BluetoothStatusCodes.SUCCESS) {
                log("writeCharacteristic 返回 " + code);
                runNext();
            }
        } else {
            c.setWriteType(writeType);
            c.setValue(value);
            if (!g.writeCharacteristic(c)) {
                log("writeCharacteristic 返回 false");
                runNext();
            }
        }
    }

    /** API 33 的 writeCharacteristic 返回码常量。 */
    private static final class BluetoothStatusCodes {
        static final int SUCCESS = 0;
    }

    // ---------------------------------------------------------------- 回调数据

    private void handleNotification(UUID uuid, byte[] value) {
        if (value == null) return;
        if (STATUS_UUID.equals(uuid)) {
            handleStatusValue(value);
            return;
        }
        if (!AUDIO_DATA_UUID.equals(uuid)) return;

        packets++;
        packetsThisSecond++;
        bytes += value.length;
        if (value.length >= 2) {
            int seq = (value[0] & 0xFF) | ((value[1] & 0xFF) << 8);
            if (lastSeq >= 0) {
                int expected = (lastSeq + 1) & 0xFFFF;
                if (seq != expected) {
                    int lost = (seq - expected + 65536) & 0xFFFF;
                    gaps++;
                    seqErrors += lost;
                    log("seq 跳变 期望 " + expected + " 实际 " + seq + "（丢 " + lost + " 包）");
                }
            }
            lastSeq = seq;
            int frames = (value.length - 2) / 40;
            lastPacket = value.clone();
            lastPacketInfo = "len=" + value.length + " seq=" + seq
                    + " frames=" + frames + " hex=" + hex14(value);
            // 每包都刷 UI 会让界面持续重排（也抓不到界面、日志被刷屏），节流到 500ms。
            long now = System.currentTimeMillis();
            if (now - lastUiUpdate < 500) return;
            lastUiUpdate = now;
            final String raw = "长度 " + value.length + " 字节 / seq=" + seq
                    + " / " + frames + " 帧（每帧 40B）\n" + hex14(value);
            runOnUiThread(() -> {
                if (rawView != null) rawView.setText(raw);
            });
        }
        refreshStats();
    }

    private void handleStatusValue(byte[] value) {
        if (value == null || value.length < 16) {
            statusReportView.setText("status 长度异常：" + (value == null ? 0 : value.length));
            return;
        }
        int version = value[0] & 0xFF;
        int state = value[1] & 0xFF;
        int source = value[2] & 0xFF;
        int frames = value[3] & 0xFF;
        int reportedMtu = (value[4] & 0xFF) | ((value[5] & 0xFF) << 8);
        long queued = (value[6] & 0xFF) | ((value[7] & 0xFF) << 8);
        long dropped = readU32(value, 8);
        long sent = readU32(value, 12);
        lastStatusJson = String.format(Locale.US,
                "version=%d state=%d source=%d frames/包=%d mtu=%d queued=%d dropped=%d sent=%d",
                version, state, source, frames, reportedMtu, queued, dropped, sent);
        final String report = lastStatusJson;
        runOnUiThread(() -> {
            if (statusReportView != null) statusReportView.setText(report);
        });
        // status 每秒来一次，全记进日志会把其它关键事件冲掉；只每 5 秒记一条。
        long now = System.currentTimeMillis();
        if (now - lastStatusLog >= 5000) {
            lastStatusLog = now;
            log("status: " + lastStatusJson);
        }
        refreshLinkInfo();
    }

    private static long readU32(byte[] value, int offset) {
        return ((long) (value[offset] & 0xFF))
                | ((long) (value[offset + 1] & 0xFF) << 8)
                | ((long) (value[offset + 2] & 0xFF) << 16)
                | ((long) (value[offset + 3] & 0xFF) << 24);
    }

    // ---------------------------------------------------------------- 展示

    private void startStatsTicker() {
        handler.postDelayed(new Runnable() {
            @Override public void run() {
                packetsPerSecond = packetsThisSecond;
                packetsThisSecond = 0;
                refreshStats();
                handler.postDelayed(this, 1000);
            }
        }, 1000);
    }

    private void refreshStats() {
        final long p = packets;
        final long b = bytes;
        final long g2 = gaps;
        final int s = seqErrors;
        final int pps = packetsPerSecond;
        runOnUiThread(() -> {
            if (statsView == null) return;
            statsView.setText(String.format(Locale.US,
                    "包数=%d  字节=%d  seq 跳变=%d  丢失包=%d\n每秒包数=%d（期望约 1000/60ms≈16）",
                    p, b, g2, s, pps));
        });
    }

    @SuppressLint("MissingPermission")
    private void refreshLinkInfo() {
        String name = "-";
        String address = "-";
        if (target != null) {
            try {
                name = target.getName() == null ? "(无名)" : target.getName();
                address = target.getAddress();
            } catch (SecurityException denied) {
                name = "(无权限)";
            }
        }
        final String deviceName = name;
        final String deviceAddress = address;
        final int currentMtu = mtu;
        final int currentFrames = framesPerPacket;
        final int currentPhy = phyTx;
        final String currentStatus = lastStatusJson;
        runOnUiThread(() -> {
            if (linkView == null) return;
            linkView.setText(String.format(Locale.US,
                    "设备：%s\n%s\nMTU：%d（每包 %d 帧 × 40B）\nPHY：%s\nstatus：%s",
                    deviceName, deviceAddress, currentMtu, currentFrames,
                    phyName(currentPhy), currentStatus));
        });
    }

    private void setStatus(String value) {
        runOnUiThread(() -> {
            if (statusView != null) statusView.setText("状态：" + value);
        });
        log(value);
    }

    private void appendTranscript(String line) {
        transcript.append(line).append('\n');
        final String all = transcript.toString();
        runOnUiThread(() -> {
            if (transcriptView == null) return;
            transcriptView.setText(all.length() > 1200
                    ? all.substring(all.length() - 1200) : all);
        });
    }

    /**
     * GATT 回调在 binder 线程，直接改 TextView 会抛 CalledFromWrongThreadException
     * 并中断回调（服务发现就永远不执行）。所以所有 UI 更新统一切主线程。
     */
    private void log(String line) {
        String stamp = new java.text.SimpleDateFormat("HH:mm:ss", Locale.US)
                .format(new java.util.Date());
        final String entry = stamp + "  " + line;
        runOnUiThread(() -> {
            if (logView == null) return;
            String current = logView.getText().toString();
            String[] lines = (entry + "\n" + current).split("\n");
            StringBuilder keep = new StringBuilder();
            for (int i = 0; i < Math.min(lines.length, 12); i++) {
                keep.append(lines[i]).append('\n');
            }
            logView.setText(keep.toString());
        });
    }

    private static String phyName(int phy) {
        if (phy < 0) return "-";
        if (phy == 1) return "1M";
        if (phy == 2) return "2M";
        if (phy == 3) return "coded";
        return String.valueOf(phy);
    }

    private static String shortUuid(UUID uuid) {
        String text = uuid.toString();
        return text.length() >= 8 ? text.substring(0, 8) : text;
    }

    private static String hex(byte[] data) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < data.length; i++) {
            sb.append(String.format(Locale.US, "%02X", data[i]));
            if (i + 1 < data.length) sb.append(' ');
        }
        return sb.toString();
    }

    private static String hex14(byte[] data) {
        int count = Math.min(16, data.length);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < count; i++) {
            sb.append(String.format(Locale.US, "%02X ", data[i]));
        }
        if (data.length > count) sb.append("…");
        return sb.toString().trim();
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                                     int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != 3001) return;
        boolean granted = grantResults.length > 0;
        for (int result : grantResults) {
            if (result != PackageManager.PERMISSION_GRANTED) granted = false;
        }
        if (granted) {
            setStatus("权限已授予，可以重新扫描");
        } else {
            setStatus("蓝牙权限被拒绝，无法扫描/连接");
        }
    }
}
