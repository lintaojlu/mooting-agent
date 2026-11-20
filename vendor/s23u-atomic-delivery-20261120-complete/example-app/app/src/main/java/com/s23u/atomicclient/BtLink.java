package com.s23u.atomicclient;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothServerSocket;
import android.bluetooth.BluetoothSocket;
import android.content.Context;

import java.io.InputStream;
import java.io.OutputStream;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 极简经典蓝牙 RFCOMM 链路。
 *
 * <p>只负责：监听 / 连接 / 收字节 / 发字节 / 计数 / 把原始字节交给上层。
 * <b>不做任何协议解析</b> —— 这一版的目标只是证明链路和权限没问题，
 * 五个通道的 B5AU 封包留到链路确认之后再接。
 *
 * <p>两种角色：
 * <ul>
 *   <li>{@link #listen()}：手机当服务端，等 PC 主动连。PC 侧不需要 SDP，
 *       按 channel 1..30 探测即可，这是最稳的一条路。</li>
 *   <li>{@link #connect(String)}：手机主动连 PC。要求 PC 侧在 SDP 里注册了
 *       对应 UUID 的服务，否则必然失败（纯 Python 监听做不到这一点）。</li>
 * </ul>
 */
final class BtLink {

    interface Listener {
        /** state 是简短状态词，detail 是补充信息（可为空）。 */
        void onState(String state, String detail);

        /** 收到原始字节；totalBytes / totalReads 是累计值。 */
        void onData(byte[] chunk, int length, long totalBytes, int totalReads);

        void onError(String message);
    }

    /** 自定义服务 UUID：手机监听时用，PC 按 channel 探测，不依赖 SDP。 */
    static final UUID CUSTOM_UUID =
            UUID.fromString("b5a00001-0000-1000-8000-00805f9b34fb");
    /** 标准 SPP UUID：手机主动连时优先尝试，多数 SPP 服务端会挂这个。 */
    static final UUID SPP_UUID =
            UUID.fromString("00001101-0000-1000-8000-00805f9b34fb");

    private static final String SERVICE_NAME = "S23U-BT-PROBE";

    private static BtLink sharedInstance;

    /**
     * 全局唯一的一条蓝牙链路。
     *
     * <p>「蓝牙连接测试」页和「蓝牙音频」必须共用同一条连接：一个服务端只会 accept 一次，
     * 各自建链既连不上，又会在页面销毁时把对方的连接一起关掉。
     */
    static synchronized BtLink shared(Context context) {
        if (sharedInstance == null) {
            sharedInstance = new BtLink(context, new Dispatcher());
        }
        return sharedInstance;
    }

    /** 把事件分发给所有订阅者（自检页、蓝牙音频各一个）。 */
    private static final class Dispatcher implements Listener {
        private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();

        void add(Listener listener) {
            if (listener != null) listeners.addIfAbsent(listener);
        }

        void remove(Listener listener) {
            if (listener != null) listeners.remove(listener);
        }

        @Override public void onState(String state, String detail) {
            for (Listener listener : listeners) listener.onState(state, detail);
        }

        @Override public void onData(byte[] chunk, int length, long totalBytes, int totalReads) {
            for (Listener listener : listeners) {
                listener.onData(chunk, length, totalBytes, totalReads);
            }
        }

        @Override public void onError(String message) {
            for (Listener listener : listeners) listener.onError(message);
        }
    }

    void addListener(Listener listener) {
        if (listener instanceof Dispatcher) return;
        if (listener != null && this.listener instanceof Dispatcher) {
            ((Dispatcher) this.listener).add(listener);
        }
    }

    void removeListener(Listener listener) {
        if (listener == null) return;
        if (this.listener instanceof Dispatcher) {
            ((Dispatcher) this.listener).remove(listener);
        }
    }

    private final Context context;
    private final Listener listener;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "s23u-bt-link");
        thread.setDaemon(true);
        return thread;
    });

    /**
     * 发送必须用独立线程：读循环会长期阻塞在 worker 里，
     * 如果 send() 也排进 worker，任务永远轮不到，表现就是「已连接但发不出去」。
     */
    private final ExecutorService sender = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "s23u-bt-send");
        thread.setDaemon(true);
        return thread;
    });

    private volatile BluetoothAdapter adapter;
    private volatile BluetoothServerSocket serverSocket;
    private volatile BluetoothSocket socket;
    private volatile InputStream input;
    private volatile OutputStream output;
    private volatile boolean running;
    private volatile long totalBytes;
    private volatile int totalReads;

    BtLink(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    BluetoothAdapter adapter() {
        if (adapter == null) {
            BluetoothManager manager =
                    (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
            adapter = manager == null ? null : manager.getAdapter();
        }
        return adapter;
    }

    boolean isRunning() {
        return running;
    }

    long totalBytes() {
        return totalBytes;
    }

    int totalReads() {
        return totalReads;
    }

    /** 手机当服务端，阻塞等待对端连接。 */
    void listen() {
        BluetoothAdapter local = requireAdapter();
        if (local == null) return;
        resetCounters();
        state("等待连接", "本机监听中，等 PC 连过来");
        worker.execute(() -> {
            BluetoothServerSocket server = null;
            try {
                server = local.listenUsingInsecureRfcommWithServiceRecord(
                        SERVICE_NAME, CUSTOM_UUID);
                serverSocket = server;
                BluetoothSocket accepted = server.accept();
                if (accepted == null) {
                    state("已停止", "监听被取消");
                    return;
                }
                attach(accepted, "手机监听 / PC 已连入");
            } catch (SecurityException denied) {
                error("缺少蓝牙权限：" + denied.getMessage());
            } catch (Throwable failure) {
                if (running) error("监听失败：" + failure);
                else state("已停止", "监听已关闭");
            } finally {
                closeQuietly(server);
            }
        });
    }

    /** 手机主动连 PC，按 MAC 地址。 */
    void connect(String macAddress) {
        BluetoothAdapter local = requireAdapter();
        if (local == null) return;
        BluetoothDevice device;
        try {
            device = local.getRemoteDevice(macAddress.trim().toUpperCase());
        } catch (Throwable invalid) {
            error("MAC 地址无效：" + macAddress);
            return;
        }
        resetCounters();
        state("连接中", "目标 " + device.getAddress());
        worker.execute(() -> {
            BluetoothSocket client = null;
            Throwable last = null;
            // 先试我们自己发布的自定义 UUID（PC 端 bt_link.cmd 发布的就是它），
            // 再退回标准 SPP——避免每次都先白等一次 SDP 超时。
            for (UUID uuid : new UUID[]{CUSTOM_UUID, SPP_UUID}) {
                try {
                    client = device.createInsecureRfcommSocketToServiceRecord(uuid);
                    client.connect();
                    break;
                } catch (SecurityException denied) {
                    error("缺少蓝牙权限：" + denied.getMessage());
                    return;
                } catch (Throwable failure) {
                    last = failure;
                    closeQuietly(client);
                    client = null;
                }
            }
            if (client == null) {
                error("连接失败：" + (last == null ? "无可用服务" : last)
                        + "（PC 侧需在 SDP 注册该 UUID，或改用手机监听模式）");
                return;
            }
            try {
                attach(client, "手机主动连接 / 对端 " + device.getAddress());
            } catch (Throwable failure) {
                error("链路建立后读取失败：" + failure);
                closeQuietly(client);
            }
        });
    }

    /** 往对端写几个字节，验证是否双向。 */
    void send(byte[] payload) {
        OutputStream out = output;
        if (out == null) {
            error("尚未连接，无法发送");
            return;
        }
        sender.execute(() -> {
            try {
                out.write(payload);
                out.flush();
                state("已连接", "已发送 " + payload.length + " 字节");
            } catch (Throwable failure) {
                error("发送失败：" + failure);
            }
        });
    }

    void stop() {
        running = false;
        closeQuietly(serverSocket);
        closeQuietly(socket);
        serverSocket = null;
        socket = null;
        input = null;
        output = null;
        state("已断开", "链路已关闭");
    }

    void shutdown() {
        stop();
        worker.shutdownNow();
        sender.shutdownNow();
    }

    // ---------------------------------------------------------------- 内部

    private void attach(BluetoothSocket connected, String detail) throws Exception {
        socket = connected;
        input = connected.getInputStream();
        output = connected.getOutputStream();
        running = true;
        state("已连接", detail);
        byte[] buffer = new byte[4096];
        while (running) {
            int count;
            try {
                count = input.read(buffer);
            } catch (Throwable broken) {
                if (running) error("读取中断：" + broken);
                break;
            }
            if (count < 0) {
                state("已断开", "对端关闭了连接");
                break;
            }
            if (count == 0) continue;
            totalBytes += count;
            totalReads += 1;
            byte[] copy = new byte[count];
            System.arraycopy(buffer, 0, copy, 0, count);
            listener.onData(copy, count, totalBytes, totalReads);
        }
        running = false;
        closeQuietly(connected);
        if (socket == connected) {
            socket = null;
            input = null;
            output = null;
        }
    }

    private BluetoothAdapter requireAdapter() {
        BluetoothAdapter local = adapter();
        if (local == null) {
            error("这台设备没有蓝牙适配器");
            return null;
        }
        if (!local.isEnabled()) {
            error("蓝牙未打开，请先打开蓝牙并完成配对");
            return null;
        }
        return local;
    }

    private void resetCounters() {
        totalBytes = 0;
        totalReads = 0;
    }

    private void state(String state, String detail) {
        listener.onState(state, detail == null ? "" : detail);
    }

    private void error(String message) {
        listener.onError(message);
    }

    private static void closeQuietly(Object target) {
        if (target == null) return;
        try {
            if (target instanceof BluetoothServerSocket) {
                ((BluetoothServerSocket) target).close();
            } else if (target instanceof BluetoothSocket) {
                ((BluetoothSocket) target).close();
            }
        } catch (Throwable ignored) {
            // 关闭失败不影响后续状态
        }
    }
}
