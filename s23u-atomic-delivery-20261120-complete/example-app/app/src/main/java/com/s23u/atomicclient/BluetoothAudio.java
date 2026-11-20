package com.s23u.atomicclient;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.ArrayDeque;

/**
 * 蓝牙音频源：把 RFCOMM 收到的字节当 PCM16 / 16 kHz / 单声道 音频，供上层当"麦克风"使用。
 *
 * <p>约定（与电脑端 {@code bt_link.cmd --audio} 一致）：链路里**只有裸 PCM 数据流**，
 * 不带 WAV 头、不带自定义包头。每 20 ms 一块（320 样本 / 640 字节）是电脑端的发送节奏，
 * 但接收端不依赖这个节奏——按字节到达的先后直接拼接即可。
 *
 * <p>设计成单例，是因为连续识别和按压录音两条路径都要用它，
 * 而且整个 APP 同时只应该有一个蓝牙音频连接。
 */
final class BluetoothAudio implements PcmInput {

    interface StateListener {
        void onBluetoothAudioState(boolean connected, String detail);
    }

    private static final BluetoothAudio INSTANCE = new BluetoothAudio();

    static BluetoothAudio get() { return INSTANCE; }

    /** 缓冲上限：5 秒音频，超了丢最旧的并计数，避免内存无限涨。 */
    private static final int MAX_BUFFERED_SAMPLES = 16000 * 5;

    private final Object lock = new Object();
    private final ArrayDeque<short[]> chunks = new ArrayDeque<>();

    private Context context;
    private BtLink link;
    private BtLink.Listener audioListener;
    private StateListener listener;
    private volatile boolean connected;
    private volatile String lastError = "";
    private int bufferedSamples;
    private long droppedSamples;
    private long receivedSamples;
    private byte leftoverByte = 0;
    private boolean hasLeftover;

    private BluetoothAudio() { }

    void init(Context appContext) {
        this.context = appContext.getApplicationContext();
    }

    void setListener(StateListener value) {
        listener = value;
    }

    @Override public boolean isConnected() {
        return connected;
    }

    String lastError() {
        return lastError == null ? "" : lastError;
    }

    long receivedSamples() {
        return receivedSamples;
    }

    long droppedSamples() {
        return droppedSamples;
    }

    /** 丢掉积压的旧音频：开始"按住说话"/连续识别时调用，避免拿到几秒前的残留。 */
    @Override public void clearBuffer() {
        synchronized (lock) {
            chunks.clear();
            bufferedSamples = 0;
        }
    }

    @Override public int bufferedSamples() {
        synchronized (lock) { return bufferedSamples; }
    }

    /** 用「蓝牙连接测试」页记住的设备地址发起连接。 */
    boolean connect() {
        if (connected) return true;
        if (context == null) {
            lastError = "未初始化";
            return false;
        }
        SharedPreferences prefs = context.getSharedPreferences("bt_probe", Context.MODE_PRIVATE);
        String mac = prefs.getString("last_mac", "");
        if (mac == null || mac.isEmpty()) {
            lastError = "还没有记住的设备，请先到「蓝牙连接测试」里连一次";
            return false;
        }
        lastError = "";
        synchronized (lock) {
            chunks.clear();
            bufferedSamples = 0;
            droppedSamples = 0;
            receivedSamples = 0;
            hasLeftover = false;
        }
        audioListener = new BtLink.Listener() {
            @Override public void onState(String state, String detail) {
                boolean nowConnected = "已连接".equals(state);
                if (nowConnected != connected) {
                    connected = nowConnected;
                    notifyState(state + (detail == null || detail.isEmpty() ? "" : " · " + detail));
                }
                if ("已断开".equals(state) || "已停止".equals(state)) {
                    connected = false;
                    notifyState(state + " · " + detail);
                }
            }

            @Override public void onData(byte[] chunk, int length, long totalBytes, int totalReads) {
                appendPcm(chunk, length);
            }

            @Override public void onError(String message) {
                lastError = message;
                connected = false;
                notifyState("错误 · " + message);
            }
        };
        // 与「蓝牙连接测试」页共用同一条链路，避免各建一条互相踢掉。
        link = BtLink.shared(context);
        link.addListener(audioListener);
        if (link.isRunning()) {
            // 自检页已经连上了，这里直接接管，不要再发起第二次连接
            //（电脑端只会 accept 一次，第二次必失败）。
            connected = true;
            notifyState("已复用「蓝牙连接测试」里建立的连接");
            return true;
        }
        link.connect(mac);
        lastError = "";
        return true;
    }

    void disconnect() {
        if (link != null) {
            if (audioListener != null) link.removeListener(audioListener);
            link.stop();
            link = null;
        }
        audioListener = null;
        connected = false;
        synchronized (lock) {
            chunks.clear();
            bufferedSamples = 0;
            lock.notifyAll();
        }
    }

    /**
     * 读一段 PCM。行为对齐 AudioRecord.read：
     * 返回 &gt;0 表示样本数，0 表示本次超时没数据，-1 表示链路已断。
     */
    @Override public int read(short[] destination, int maxSamples, int timeoutMs) {
        int wanted = Math.min(maxSamples, destination.length);
        long deadline = System.currentTimeMillis() + Math.max(1, timeoutMs);
        synchronized (lock) {
            while (bufferedSamples == 0) {
                if (!connected) return -1;
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0) return 0;
                try {
                    lock.wait(remaining);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return -1;
                }
            }

            int copied = 0;
            while (copied < wanted && !chunks.isEmpty()) {
                short[] head = chunks.peekFirst();
                int available = head.length;
                int take = Math.min(available, wanted - copied);
                System.arraycopy(head, 0, destination, copied, take);
                copied += take;
                if (take == available) {
                    chunks.removeFirst();
                } else {
                    short[] rest = new short[available - take];
                    System.arraycopy(head, take, rest, 0, rest.length);
                    chunks.removeFirst();
                    chunks.addFirst(rest);
                }
                bufferedSamples -= take;
            }
            return copied;
        }
    }

    private void appendPcm(byte[] data, int length) {
        if (length <= 0) return;
        synchronized (lock) {
            int offset = 0;
            short[] samples;
            if (hasLeftover) {
                // 上一次剩下一个字节，和这次的第一个字节凑成一个样本
                int low = leftoverByte & 0xff;
                int high = data[0] & 0xff;
                int count = (length - 1) / 2;
                samples = new short[count + 1];
                samples[0] = (short) (low | (high << 8));
                for (int i = 0; i < count; ++i) {
                    int lo = data[1 + i * 2] & 0xff;
                    int hi = data[2 + i * 2] & 0xff;
                    samples[i + 1] = (short) (lo | (hi << 8));
                }
                offset = 1 + count * 2;
                hasLeftover = false;
            } else {
                int count = length / 2;
                samples = new short[count];
                for (int i = 0; i < count; ++i) {
                    int lo = data[i * 2] & 0xff;
                    int hi = data[i * 2 + 1] & 0xff;
                    samples[i] = (short) (lo | (hi << 8));
                }
                offset = count * 2;
            }
            if (offset < length) {
                leftoverByte = data[length - 1];
                hasLeftover = true;
            }

            chunks.addLast(samples);
            bufferedSamples += samples.length;
            receivedSamples += samples.length;
            while (bufferedSamples > MAX_BUFFERED_SAMPLES && !chunks.isEmpty()) {
                short[] dropped = chunks.removeFirst();
                bufferedSamples -= dropped.length;
                droppedSamples += dropped.length;
            }
            lock.notifyAll();
        }
    }

    private void notifyState(String detail) {
        StateListener current = listener;
        if (current != null) current.onBluetoothAudioState(connected, detail);
    }
}
