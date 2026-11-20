package com.s23u.atomicclient;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 蓝牙链路自检页。与五项原子能力完全解耦：不进主流程、不改 MainActivity 的采集逻辑。
 *
 * <p>目标：证明「手机 ↔ PC」的经典蓝牙 RFCOMM 能建链、能收发字节、能计到速率。
 *
 * <p>手机端有两种发起方式：
 * <ul>
 *   <li><b>搜索附近蓝牙</b>：发现设备 → 点选 → 自动配对（首次）→ 直连，并把选择记下次打开自动填好；</li>
 *   <li><b>手动填 MAC</b>：直接输地址连接。</li>
 * </ul>
 *
 * <p>注意：手机主动连要求 PC 端已发布 SDP 服务记录（RFCOMM 客户端靠 SDP 查通道），
 * 对应的 PC 端工具是 {@code tools/BtLinkTest}。
 */
public final class BluetoothProbeActivity extends Activity {

    private static final int PERMISSION_REQUEST = 2001;
    private static final int MAX_ECHO_BYTES = 64;
    private static final int MAX_LOG_LINES = 12;
    private static final String PREFS_NAME = "bt_probe";
    private static final String PREF_LAST_MAC = "last_mac";
    private static final String PREF_LAST_NAME = "last_name";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ArrayDeque<String> logs = new ArrayDeque<>();
    private final byte[] echoBuffer = new byte[MAX_ECHO_BYTES];
    private final Map<String, BluetoothDevice> discoveredDevices = new LinkedHashMap<>();
    private int echoLength;
    private TextView statusView;
    private TextView adapterView;
    private TextView statsView;
    private TextView hexView;
    private TextView logView;
    private TextView discoveryView;
    private LinearLayout deviceListView;
    private LinearLayout bondedListView;
    private EditText macInput;
    private Button listenButton;
    private Button connectButton;
    private Button disconnectButton;
    private Button discoverButton;
    private BtLink link;
    private BtLink.Listener probeListener;
    private BluetoothAdapter adapter;
    private BroadcastReceiver btReceiver;
    private boolean discovering;
    private long lastRateBytes;
    private long lastRateTimeMs;
    private double rateBytesPerSecond;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(createContentView());
        probeListener = new BtLink.Listener() {
            @Override public void onState(String status, String detail) {
                runOnUiThread(() -> applyState(status, detail));
            }

            @Override public void onData(byte[] chunk, int length, long totalBytes, int totalReads) {
                runOnUiThread(() -> onBytes(chunk, length, totalBytes, totalReads));
            }

            @Override public void onError(String message) {
                runOnUiThread(() -> applyError(message));
            }
        };
        // 与「蓝牙音频」共用同一条链路：离开本页不会断开，回来还能看到已连接。
        link = BtLink.shared(this);
        link.addListener(probeListener);
        if (link.isRunning()) {
            applyState("已连接", "复用已有连接");
        }
        adapter = link.adapter();
        registerBtReceiver();
        ensurePermissions();
        refreshAdapterInfo();
        restoreLastDevice();
        refreshBondedDevices();
        startRateTicker();
    }

    // ---------------------------------------------------------------- 界面

    private View createContentView() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(248, 250, 252));
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(20), dp(20), dp(32));
        scroll.addView(root);

        // 本页没有 ActionBar，必须有显式的返回入口，否则只能靠系统手势。
        Button backButton = actionButton("← 返回主界面");
        backButton.setTextSize(15);
        backButton.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        backButton.setOnClickListener(v -> finish());
        LinearLayout.LayoutParams backParams = new LinearLayout.LayoutParams(-1, dp(46));
        backParams.bottomMargin = dp(4);
        root.addView(backButton, backParams);

        TextView title = text("蓝牙链路自检", 22, Color.rgb(15, 23, 42));
        title.setGravity(Gravity.CENTER_HORIZONTAL);
        title.setTypeface(null, Typeface.BOLD);
        root.addView(title, wrap(dp(10)));

        TextView subtitle = text(
                "只验证 RFCOMM 能建链、能收发。蓝牙音频与五通道解析不在此页。",
                13, Color.rgb(71, 85, 105));
        subtitle.setGravity(Gravity.CENTER_HORIZONTAL);
        root.addView(subtitle, wrap(dp(18)));

        adapterView = text("", 13, Color.rgb(51, 65, 85));
        adapterView.setTextIsSelectable(true);
        adapterView.setPadding(dp(12), dp(12), dp(12), dp(12));
        adapterView.setBackgroundColor(Color.WHITE);
        root.addView(adapterView, wrap(dp(14)));

        statusView = text("状态：未开始", 16, Color.rgb(15, 23, 42));
        statusView.setTypeface(null, Typeface.BOLD);
        statusView.setPadding(dp(12), dp(10), dp(12), dp(10));
        statusView.setBackgroundColor(Color.WHITE);
        root.addView(statusView, wrap(dp(14)));

        root.addView(text("方式一：从已配对设备选择（最快，不用搜索、不用打字）",
                14, Color.rgb(15, 23, 42)), wrap(dp(6)));

        bondedListView = new LinearLayout(this);
        bondedListView.setOrientation(LinearLayout.VERTICAL);
        root.addView(bondedListView, wrap(dp(12)));

        root.addView(text("方式二：搜索附近设备，点选后自动配对并直连",
                14, Color.rgb(15, 23, 42)), wrap(dp(6)));

        discoverButton = actionButton("搜索附近蓝牙设备");
        discoverButton.setOnClickListener(v -> startDiscovery());
        root.addView(discoverButton, wrap(dp(8)));

        discoveryView = text(
                "提示：电脑要处于「可被发现」状态——把 Windows 的「蓝牙和其他设备」设置页打开着即可。",
                12, Color.rgb(100, 116, 139));
        root.addView(discoveryView, wrap(dp(6)));

        deviceListView = new LinearLayout(this);
        deviceListView.setOrientation(LinearLayout.VERTICAL);
        root.addView(deviceListView, wrap(dp(10)));

        root.addView(text("方式三：手动填对端 MAC",
                14, Color.rgb(15, 23, 42)), wrap(dp(6)));
        macInput = new EditText(this);
        macInput.setHint("例如 74:5C:4B:1A:2B:3C");
        macInput.setTextSize(15);
        macInput.setInputType(InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        macInput.setSingleLine(true);
        macInput.setPadding(dp(12), dp(8), dp(12), dp(8));
        macInput.setBackgroundColor(Color.WHITE);
        root.addView(macInput, wrap(dp(14)));

        LinearLayout row1 = new LinearLayout(this);
        row1.setOrientation(LinearLayout.HORIZONTAL);
        listenButton = actionButton("手机监听");
        listenButton.setOnClickListener(v -> {
            ensurePermissions();
            appendLog("开始监听，等 PC 连入");
            link.listen();
        });
        row1.addView(listenButton, new LinearLayout.LayoutParams(0, dp(52), 1));
        connectButton = actionButton("主动连接");
        connectButton.setOnClickListener(v -> {
            ensurePermissions();
            String mac = macInput.getText().toString().trim();
            if (mac.isEmpty()) {
                appendLog("[错误] 请先搜索选择设备，或手动填对端 MAC");
                return;
            }
            appendLog("尝试连接 " + mac);
            link.connect(mac);
        });
        LinearLayout.LayoutParams connectParams = new LinearLayout.LayoutParams(0, dp(52), 1);
        connectParams.leftMargin = dp(8);
        row1.addView(connectButton, connectParams);
        root.addView(row1, wrap(dp(14)));

        LinearLayout row2 = new LinearLayout(this);
        row2.setOrientation(LinearLayout.HORIZONTAL);
        disconnectButton = actionButton("断开");
        disconnectButton.setOnClickListener(v -> {
            appendLog("手动断开");
            link.stop();
        });
        row2.addView(disconnectButton, new LinearLayout.LayoutParams(0, dp(52), 1));
        Button sendButton = actionButton("发测试字节");
        sendButton.setOnClickListener(v -> {
            byte[] payload = "HELLO-FROM-S23U\n".getBytes(StandardCharsets.US_ASCII);
            appendLog("发送 " + payload.length + " 字节");
            link.send(payload);
        });
        LinearLayout.LayoutParams sendParams = new LinearLayout.LayoutParams(0, dp(52), 1);
        sendParams.leftMargin = dp(8);
        row2.addView(sendButton, sendParams);
        root.addView(row2, wrap(dp(10)));

        Button settingsButton = actionButton("打开系统蓝牙设置（配对 / 可发现性）");
        settingsButton.setOnClickListener(v -> openBluetoothSettings());
        root.addView(settingsButton, wrap(dp(16)));

        statsView = text("累计 0 字节 / 0 次读取 · 速率 0 B/s", 14,
                Color.rgb(51, 65, 85));
        statsView.setPadding(dp(12), dp(10), dp(12), dp(10));
        statsView.setBackgroundColor(Color.WHITE);
        root.addView(statsView, wrap(dp(14)));

        root.addView(text("最近收到的字节", 14, Color.rgb(71, 85, 105)), wrap(dp(6)));
        hexView = text("（尚未收到数据）", 13, Color.rgb(15, 23, 42));
        hexView.setTypeface(Typeface.MONOSPACE);
        hexView.setTextIsSelectable(true);
        hexView.setPadding(dp(12), dp(10), dp(12), dp(10));
        hexView.setBackgroundColor(Color.WHITE);
        root.addView(hexView, wrap(dp(14)));

        root.addView(text("事件日志", 14, Color.rgb(71, 85, 105)), wrap(dp(6)));
        logView = text("", 12, Color.rgb(51, 65, 85));
        logView.setTypeface(Typeface.MONOSPACE);
        logView.setTextIsSelectable(true);
        logView.setPadding(dp(12), dp(10), dp(12), dp(10));
        logView.setBackgroundColor(Color.WHITE);
        root.addView(logView, wrap(dp(14)));

        return scroll;
    }

    private Button actionButton(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(14);
        button.setAllCaps(false);
        return button;
    }

    private TextView text(String value, int sizeSp, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sizeSp);
        view.setTextColor(color);
        return view;
    }

    private LinearLayout.LayoutParams wrap(int bottomMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = bottomMargin;
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    // ---------------------------------------------------------------- 搜索与配对

    private void startDiscovery() {
        ensurePermissions();
        if (adapter == null || !adapter.isEnabled()) {
            appendLog("[错误] 蓝牙未打开，请先打开蓝牙");
            return;
        }
        if (discovering) {
            appendLog("正在搜索中，请稍候");
            return;
        }
        discoveredDevices.clear();
        deviceListView.removeAllViews();
        discoveryView.setText("正在搜索附近设备……（约 12 秒）");
        try {
            if (adapter.isDiscovering()) adapter.cancelDiscovery();
            boolean started = adapter.startDiscovery();
            discovering = started;
            appendLog(started ? "已开始搜索" : "[错误] startDiscovery 返回 false");
            if (!started) {
                discoveryView.setText("无法开始搜索：请确认已授予「附近的设备」权限，且蓝牙已打开。");
            }
        } catch (SecurityException denied) {
            appendLog("[错误] 缺少扫描权限：" + denied.getMessage());
        }
    }

    /** 列出已配对设备，点一下直接连：不用搜索、不用手输地址。 */
    private void refreshBondedDevices() {
        if (bondedListView == null) return;
        bondedListView.removeAllViews();
        if (adapter == null) {
            bondedListView.addView(actionButton("这台设备没有蓝牙适配器"));
            return;
        }
        if (!adapter.isEnabled()) {
            bondedListView.addView(actionButton("蓝牙未打开"));
            return;
        }
        Set<BluetoothDevice> bonded;
        try {
            bonded = adapter.getBondedDevices();
        } catch (SecurityException denied) {
            bondedListView.addView(actionButton("缺少蓝牙权限，无法列出已配对设备"));
            return;
        }
        if (bonded == null || bonded.isEmpty()) {
            bondedListView.addView(actionButton("还没有已配对设备，请用方式二搜索配对"));
            return;
        }
        for (BluetoothDevice device : bonded) {
            String address;
            try {
                address = device.getAddress();
            } catch (SecurityException denied) {
                continue;
            }
            Button row = actionButton(safeName(device) + "  " + address + "  · 已配对");
            row.setTextSize(13);
            row.setOnClickListener(v -> selectDevice(device));
            bondedListView.addView(row, new LinearLayout.LayoutParams(-1, dp(48)));
        }
    }

    private void registerBtReceiver() {
        btReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (action == null) return;
                if (BluetoothDevice.ACTION_FOUND.equals(action)) {
                    BluetoothDevice device = extractDevice(intent);
                    short rssi = intent.getShortExtra(BluetoothDevice.EXTRA_RSSI, Short.MIN_VALUE);
                    if (device != null) addDeviceRow(device, rssi);
                } else if (BluetoothAdapter.ACTION_DISCOVERY_STARTED.equals(action)) {
                    discovering = true;
                    appendLog("搜索中……");
                } else if (BluetoothAdapter.ACTION_DISCOVERY_FINISHED.equals(action)) {
                    discovering = false;
                    appendLog("搜索结束，共发现 " + discoveredDevices.size() + " 台设备");
                    refreshBondedDevices();
                    discoveryView.setText(discoveredDevices.isEmpty()
                            ? "没搜到设备。请确认电脑的「蓝牙和其他设备」设置页是打开状态（可被发现）。"
                            : "点选上面任一设备即可配对并连接。");
                } else if (BluetoothDevice.ACTION_BOND_STATE_CHANGED.equals(action)) {
                    BluetoothDevice device = extractDevice(intent);
                    if (device == null) return;
                    int bondState = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE,
                            BluetoothDevice.BOND_NONE);
                    String name = safeName(device);
                    if (bondState == BluetoothDevice.BOND_BONDED) {
                        appendLog("配对完成：" + name + "，开始连接");
                        saveLastDevice(device.getAddress(), name);
                        link.connect(device.getAddress());
                    } else if (bondState == BluetoothDevice.BOND_BONDING) {
                        appendLog("正在配对：" + name + "（请在系统弹窗确认）");
                    } else {
                        appendLog("配对未完成：" + name);
                    }
                }
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(BluetoothDevice.ACTION_FOUND);
        filter.addAction(BluetoothAdapter.ACTION_DISCOVERY_STARTED);
        filter.addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED);
        filter.addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
        registerReceiver(btReceiver, filter);
    }

    private BluetoothDevice extractDevice(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice.class);
        }
        @SuppressWarnings("deprecation")
        BluetoothDevice legacy = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
        return legacy;
    }

    private void addDeviceRow(BluetoothDevice device, short rssi) {
        String address;
        try {
            address = device.getAddress();
        } catch (SecurityException denied) {
            return;
        }
        if (address == null || discoveredDevices.containsKey(address)) return;
        discoveredDevices.put(address, device);

        boolean bonded = device.getBondState() == BluetoothDevice.BOND_BONDED;
        String label = safeName(device) + "  " + address
                + (rssi == Short.MIN_VALUE ? "" : "  " + rssi + "dBm")
                + (bonded ? "  · 已配对" : "");
        Button row = actionButton(label);
        row.setTextSize(13);
        row.setAllCaps(false);
        row.setOnClickListener(v -> selectDevice(device));
        deviceListView.addView(row, new LinearLayout.LayoutParams(-1, dp(48)));
    }

    private void selectDevice(BluetoothDevice device) {
        String address;
        String name;
        try {
            address = device.getAddress();
            name = safeName(device);
        } catch (SecurityException denied) {
            appendLog("[错误] 无权限读取设备信息");
            return;
        }
        macInput.setText(address);
        appendLog("已选择：" + name + "（" + address + "）");
        if (adapter != null && adapter.isDiscovering()) adapter.cancelDiscovery();

        if (device.getBondState() == BluetoothDevice.BOND_BONDED) {
            saveLastDevice(address, name);
            link.connect(address);
            return;
        }
        try {
            saveLastDevice(address, name);
            boolean started = device.createBond();
            appendLog(started
                    ? "发起配对，请在系统弹窗确认"
                    : "[错误] createBond 返回 false，请到系统蓝牙设置里手动配对");
        } catch (SecurityException denied) {
            appendLog("[错误] 无法发起配对：" + denied.getMessage());
        }
    }

    private String safeName(BluetoothDevice device) {
        try {
            String name = device.getName();
            return name == null || name.isEmpty() ? "（未命名设备）" : name;
        } catch (SecurityException denied) {
            return "（无名称权限）";
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
    }

    private void saveLastDevice(String address, String name) {
        prefs().edit()
                .putString(PREF_LAST_MAC, address)
                .putString(PREF_LAST_NAME, name)
                .apply();
    }

    private void restoreLastDevice() {
        String mac = prefs().getString(PREF_LAST_MAC, "");
        String name = prefs().getString(PREF_LAST_NAME, "");
        if (mac == null || mac.isEmpty()) return;
        macInput.setText(mac);
        appendLog("已记住上次设备：" + name + "（" + mac + "）");
    }

    // ---------------------------------------------------------------- 状态

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
        if (needed.isEmpty()) return;
        requestPermissions(needed.toArray(new String[0]), PERMISSION_REQUEST);
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                                     int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != PERMISSION_REQUEST) return;
        boolean granted = grantResults.length > 0;
        for (int result : grantResults) {
            if (result != PackageManager.PERMISSION_GRANTED) granted = false;
        }
        appendLog(granted ? "蓝牙权限已授予" : "[错误] 蓝牙权限被拒绝，无法搜索/建链");
        refreshAdapterInfo();
    }

    private void refreshAdapterInfo() {
        BluetoothAdapter local = link.adapter();
        adapter = local;
        if (local == null) {
            adapterView.setText("蓝牙适配器：无（这台设备不支持蓝牙）");
            return;
        }
        StringBuilder info = new StringBuilder();
        boolean canRead = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)
                != PackageManager.PERMISSION_GRANTED) {
            canRead = false;
        }
        info.append("蓝牙适配器：").append(canRead && local.isEnabled() ? "已打开" : "未打开");
        if (canRead) {
            try {
                info.append("\n本机名称：").append(local.getName());
                info.append("\n本机地址：").append(local.getAddress());
            } catch (SecurityException denied) {
                info.append("\n（无权限读取名称与地址）");
            }
            int bonded = local.getBondedDevices() == null ? 0 : local.getBondedDevices().size();
            info.append("\n已配对设备：").append(bonded).append(" 个");
        }
        info.append("\n服务 UUID：").append(BtLink.CUSTOM_UUID);
        info.append("\n提示：手机 MAC 被系统遮成 XX:XX，电脑端要连手机时请到");
        info.append("「设置 → 关于手机 → 状态信息」查看。");
        adapterView.setText(info.toString());
    }

    private void applyState(String status, String detail) {
        StringBuilder line = new StringBuilder("状态：").append(status);
        if (detail != null && !detail.isEmpty()) line.append(" · ").append(detail);
        statusView.setText(line.toString());
        appendLog("[" + status + "] " + detail);
        handler.removeCallbacks(connectHint);
        if ("连接中".equals(status)) {
            handler.postDelayed(connectHint, 15000);
        }
    }

    /** 失败必须打到状态栏上：之前只写日志，用户看到的就是「一直是连接中」。 */
    private void applyError(String message) {
        handler.removeCallbacks(connectHint);
        statusView.setText("状态：失败 · " + message);
        appendLog("[错误] " + message);
        try {
            Toast.makeText(this, "蓝牙：" + message, Toast.LENGTH_LONG).show();
        } catch (Throwable ignored) {
            // Toast 失败不影响状态栏显示
        }
    }

    private final Runnable connectHint = new Runnable() {
        @Override public void run() {
            if (statusView == null) return;
            if (!statusView.getText().toString().contains("连接中")) return;
            appendLog("[提示] 超过 15 秒仍在连接：①电脑端 bt_link.cmd 是否在运行并已发布 SDP？"
                    + " ②两边是否已配对？③目标地址是电脑而不是别的设备？");
            statusView.setText("状态：连接超时 · 检查电脑端 bt_link.cmd 与配对状态");
        }
    };

    private void onBytes(byte[] chunk, int length, long totalBytes, int totalReads) {
        int copy = Math.min(length, MAX_ECHO_BYTES);
        System.arraycopy(chunk, 0, echoBuffer, 0, copy);
        echoLength = copy;
        renderEcho(length, totalBytes, totalReads);
    }

    private void renderEcho(int lastLength, long totalBytes, int totalReads) {
        StringBuilder hex = new StringBuilder();
        StringBuilder ascii = new StringBuilder();
        for (int i = 0; i < echoLength; ++i) {
            int value = echoBuffer[i] & 0xff;
            hex.append(String.format(Locale.US, "%02X ", value));
            ascii.append(value >= 0x20 && value < 0x7f ? (char) value : '.');
            if ((i + 1) % 16 == 0) {
                hex.append('\n');
                ascii.append('\n');
            }
        }
        hexView.setText(String.format(Locale.US,
                "本次 %d 字节 / 累计 %d 字节 / %d 次读取\n\nHEX:\n%s\nASCII:\n%s",
                lastLength, totalBytes, totalReads,
                hex.toString().trim(), ascii.toString().trim()));
    }

    private void appendLog(String line) {
        String stamp = String.format(Locale.US, "%02d:%02d:%02d",
                nowSeconds() / 3600 % 24, nowSeconds() / 60 % 60, nowSeconds() % 60);
        logs.addLast(stamp + "  " + line);
        while (logs.size() > MAX_LOG_LINES) logs.removeFirst();
        logView.setText(String.join("\n", logs));
    }

    private int nowSeconds() {
        return (int) (android.os.SystemClock.elapsedRealtime() / 1000L);
    }

    private void startRateTicker() {
        lastRateTimeMs = android.os.SystemClock.elapsedRealtime();
        lastRateBytes = 0;
        handler.postDelayed(new Runnable() {
            @Override public void run() {
                long now = android.os.SystemClock.elapsedRealtime();
                long total = link == null ? 0 : link.totalBytes();
                long elapsed = now - lastRateTimeMs;
                if (elapsed >= 500) {
                    rateBytesPerSecond = (total - lastRateBytes) * 1000.0 / elapsed;
                    lastRateBytes = total;
                    lastRateTimeMs = now;
                }
                if (statsView != null && link != null) {
                    statsView.setText(String.format(Locale.US,
                            "累计 %d 字节 / %d 次读取 · 速率 %.0f B/s",
                            total, link.totalReads(), rateBytesPerSecond));
                }
                handler.postDelayed(this, 1000);
            }
        }, 1000);
    }

    private void openBluetoothSettings() {
        try {
            startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS));
            appendLog("已打开系统蓝牙设置");
        } catch (Throwable failure) {
            appendLog("[错误] 无法打开蓝牙设置：" + failure);
        }
    }

    @Override protected void onResume() {
        super.onResume();
        // 用户可能刚在系统设置里配对了新设备，回到本页要刷新。
        refreshAdapterInfo();
        refreshBondedDevices();
    }

    @Override protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (btReceiver != null) {
            try {
                unregisterReceiver(btReceiver);
            } catch (Throwable ignored) {
                // 已经注销或未注册
            }
            btReceiver = null;
        }
        if (adapter != null) {
            try {
                if (adapter.isDiscovering()) adapter.cancelDiscovery();
            } catch (SecurityException ignored) {
                // 权限被撤销
            }
        }
        if (link != null && probeListener != null) {
            // 只退订，不关链路：链路是全局共享的，离开本页不应断开。
            link.removeListener(probeListener);
        }
        probeListener = null;
        super.onDestroy();
    }
}
