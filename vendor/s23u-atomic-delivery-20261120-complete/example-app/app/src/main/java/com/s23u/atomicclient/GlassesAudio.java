package com.s23u.atomicclient;

import android.annotation.SuppressLint;
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
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.os.SystemClock;

import java.util.List;
import java.util.UUID;

/** AP510DL BLE GATT audio source for the assistant's PCM capture paths. */
@SuppressLint("MissingPermission")
final class GlassesAudio implements PcmInput {
    static final UUID SERVICE_UUID = UUID.fromString("b5a00001-0000-1000-8000-00805f9b34fb");
    static final UUID AUDIO_DATA_UUID = UUID.fromString("b5a00002-0000-1000-8000-00805f9b34fb");
    static final UUID AUDIO_CTRL_UUID = UUID.fromString("b5a00005-0000-1000-8000-00805f9b34fb");
    static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    static final int SOURCE_TEST_ZH = 1;
    static final int SOURCE_MIC = 2;
    private static final int FRAME_BYTES = 40;
    private static final int FRAME_SAMPLES = 160;
    private static final int MAX_FRAMES_PER_PACKET = 6;
    private static final int MAX_CONCEALED_PACKETS = 16;

    interface Listener {
        void onState(boolean ready, boolean failed, String detail);
    }

    private final Context context;
    private final Listener listener;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Object lock = new Object();
    private final short[] samples = new short[16000 * 5];
    private final Runnable scanTimeout = () -> fail("未找到眼镜，请确认眼镜已开机并在广播");
    private final Runnable setupTimeout = () -> fail("眼镜连接或音频启动超时");
    private final Runnable audioTimeout = () -> fail("眼镜音频已中断");
    private BluetoothLeScanner scanner;
    private ScanCallback scan;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic control;
    private int source;
    private long decoder;
    private int lastSequence = -1;
    private int head;
    private int buffered;
    private boolean streamRequested;
    private boolean startAccepted;
    private volatile boolean ready;

    GlassesAudio(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    void connect(int source) {
        disconnect();
        this.source = source;
        try {
            decoder = Lc3.create();
            if (decoder == 0) {
                fail("眼镜 LC3 解码器初始化失败");
                return;
            }
            BluetoothManager manager = context.getSystemService(BluetoothManager.class);
            BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
            scanner = adapter == null ? null : adapter.getBluetoothLeScanner();
            if (scanner == null) {
                fail("请先开启手机蓝牙");
                return;
            }
            scan = new ScanCallback() {
                @Override public void onScanResult(int type, ScanResult result) {
                    handler.post(() -> onDeviceFound(this, result));
                }

                @Override public void onBatchScanResults(List<ScanResult> results) {
                    for (ScanResult result : results) onScanResult(0, result);
                }

                @Override public void onScanFailed(int code) {
                    handler.post(() -> {
                        if (scan == this) fail("眼镜蓝牙扫描失败（" + code + "）");
                    });
                }
            };
            scanner.startScan(scan);
            handler.postDelayed(scanTimeout, 12000);
            listener.onState(false, false, "正在搜索眼镜…");
        } catch (LinkageError error) {
            fail("此设备无法加载眼镜 LC3 解码器");
        } catch (RuntimeException error) {
            fail("无法启动眼镜音频：" + error.getMessage());
        }
    }

    private void onDeviceFound(ScanCallback callback, ScanResult result) {
        if (scan != callback) return;
        ScanRecord record = result.getScanRecord();
        if (record == null) return;
        List<ParcelUuid> services = record.getServiceUuids();
        String name = record.getDeviceName();
        boolean advertisedService = services != null && services.contains(new ParcelUuid(SERVICE_UUID));
        if (!advertisedService && (name == null || !name.startsWith("AP510DL"))) return;
        stopScan();
        openConnection(result.getDevice());
    }

    private void openConnection(BluetoothDevice device) {
        try {
            gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE,
                    BluetoothDevice.PHY_LE_1M_MASK, handler);
            if (gatt == null) {
                fail("无法连接眼镜");
                return;
            }
            handler.postDelayed(setupTimeout, 12000);
            listener.onState(false, false, "正在连接眼镜并启动音频…");
        } catch (RuntimeException error) {
            fail("无法连接眼镜：" + error.getMessage());
        }
    }

    private final BluetoothGattCallback callback = new BluetoothGattCallback() {
        @Override public void onConnectionStateChange(BluetoothGatt g, int status, int state) {
            if (g != gatt) return;
            if (status != BluetoothGatt.GATT_SUCCESS || state == BluetoothProfile.STATE_DISCONNECTED) {
                fail("眼镜蓝牙已断开（" + status + "）");
            } else if (state == BluetoothProfile.STATE_CONNECTED && !g.requestMtu(247)) {
                fail("无法协商眼镜音频连接");
            }
        }

        @Override public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
            if (g != gatt) return;
            if (status != BluetoothGatt.GATT_SUCCESS || mtu < 45 || !g.discoverServices()) {
                fail("眼镜连接的 MTU 不足或无法发现服务");
            }
        }

        @Override public void onServicesDiscovered(BluetoothGatt g, int status) {
            if (g != gatt) return;
            BluetoothGattService service = g.getService(SERVICE_UUID);
            if (status != BluetoothGatt.GATT_SUCCESS || service == null) {
                fail("未找到眼镜音频服务");
                return;
            }
            BluetoothGattCharacteristic data = service.getCharacteristic(AUDIO_DATA_UUID);
            control = service.getCharacteristic(AUDIO_CTRL_UUID);
            BluetoothGattDescriptor descriptor = data == null ? null : data.getDescriptor(CCCD_UUID);
            if (control == null || descriptor == null || !g.setCharacteristicNotification(data, true)
                    || !enableNotifications(g, descriptor)) {
                fail("无法订阅眼镜音频");
            }
        }

        @Override public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor descriptor,
                                                int status) {
            if (g != gatt || !AUDIO_DATA_UUID.equals(descriptor.getCharacteristic().getUuid())) return;
            streamRequested = status == BluetoothGatt.GATT_SUCCESS && writeStart(g);
            if (!streamRequested) fail("无法启动眼镜音频");
        }

        @Override public void onCharacteristicWrite(BluetoothGatt g,
                                                    BluetoothGattCharacteristic characteristic,
                                                    int status) {
            if (g != gatt || !AUDIO_CTRL_UUID.equals(characteristic.getUuid())) return;
            if (status == 0x83 && source == SOURCE_MIC) {
                fail("眼镜固件尚未开放实体麦克风");
            } else if (status != BluetoothGatt.GATT_SUCCESS) {
                fail(String.format(java.util.Locale.ROOT, "眼镜拒绝启动音频（0x%02X）", status));
            } else {
                startAccepted = true;
                announceReady();
            }
        }

        @Override public void onCharacteristicChanged(BluetoothGatt g,
                                                      BluetoothGattCharacteristic characteristic) {
            if (Build.VERSION.SDK_INT < 33) receive(g, characteristic, characteristic.getValue());
        }

        @Override public void onCharacteristicChanged(BluetoothGatt g,
                BluetoothGattCharacteristic characteristic, byte[] value) {
            receive(g, characteristic, value);
        }
    };

    private boolean enableNotifications(BluetoothGatt g, BluetoothGattDescriptor descriptor) {
        byte[] value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE;
        if (Build.VERSION.SDK_INT >= 33) return g.writeDescriptor(descriptor, value) == 0;
        return descriptor.setValue(value) && g.writeDescriptor(descriptor);
    }

    private boolean writeStart(BluetoothGatt g) {
        byte[] command = {(byte) 0x01, (byte) source};
        int type = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT;
        if (Build.VERSION.SDK_INT >= 33) return g.writeCharacteristic(control, command, type) == 0;
        control.setWriteType(type);
        return control.setValue(command) && g.writeCharacteristic(control);
    }

    private void receive(BluetoothGatt g, BluetoothGattCharacteristic characteristic, byte[] packet) {
        if (g != gatt || !streamRequested || !AUDIO_DATA_UUID.equals(characteristic.getUuid())
                || packet == null || packet.length < 2 + FRAME_BYTES) return;
        int payload = packet.length - 2;
        if (payload % FRAME_BYTES != 0 || payload / FRAME_BYTES > MAX_FRAMES_PER_PACKET) return;
        int sequence = (packet[0] & 0xff) | ((packet[1] & 0xff) << 8);
        int missing = lastSequence < 0 ? sequence : (sequence - lastSequence - 1) & 0xffff;
        if (missing >= 0x8000) return; // Duplicate or older packet, including across wrap.
        lastSequence = sequence;
        int frames = payload / FRAME_BYTES;
        int concealed = Math.min(missing, MAX_CONCEALED_PACKETS) * frames;
        short[] pcm = new short[(frames + concealed) * FRAME_SAMPLES];
        if (!Lc3.decode(decoder, packet, frames, concealed, pcm)) {
            fail("无法解码眼镜音频");
            return;
        }
        synchronized (lock) {
            int drop = Math.max(0, buffered + pcm.length - samples.length);
            head = (head + drop) % samples.length;
            buffered -= drop;
            int tail = (head + buffered) % samples.length;
            int first = Math.min(pcm.length, samples.length - tail);
            System.arraycopy(pcm, 0, samples, tail, first);
            System.arraycopy(pcm, first, samples, 0, pcm.length - first);
            buffered += pcm.length;
            lock.notifyAll();
        }
        announceReady();
        if (ready) {
            handler.removeCallbacks(audioTimeout);
            handler.postDelayed(audioTimeout, 4000);
        }
    }

    private void announceReady() {
        if (ready || !startAccepted || lastSequence < 0) return;
        ready = true;
        handler.removeCallbacks(setupTimeout);
        handler.postDelayed(audioTimeout, 4000);
        listener.onState(true, false, "眼镜音频已接入");
    }

    private void fail(String detail) {
        disconnect();
        listener.onState(false, true, detail);
    }

    private void stopScan() {
        handler.removeCallbacks(scanTimeout);
        if (scan != null && scanner != null) {
            try {
                scanner.stopScan(scan);
            } catch (RuntimeException ignored) {
                // The adapter may have been turned off while scanning.
            }
        }
        scan = null;
        scanner = null;
    }

    void disconnect() {
        stopScan();
        handler.removeCallbacks(setupTimeout);
        handler.removeCallbacks(audioTimeout);
        if (gatt != null) {
            BluetoothGatt old = gatt;
            gatt = null;
            // The firmware stops streaming when the connection closes.
            try {
                old.disconnect();
            } finally {
                old.close();
            }
        }
        control = null;
        streamRequested = false;
        startAccepted = false;
        lastSequence = -1;
        if (decoder != 0) {
            Lc3.destroy(decoder);
            decoder = 0;
        }
        synchronized (lock) {
            ready = false;
            head = 0;
            buffered = 0;
            lock.notifyAll();
        }
    }

    @Override public boolean isConnected() {
        return ready;
    }

    @Override public void clearBuffer() {
        synchronized (lock) {
            head = 0;
            buffered = 0;
        }
    }

    @Override public int bufferedSamples() {
        synchronized (lock) {
            return buffered;
        }
    }

    @Override public int read(short[] destination, int maxSamples, int timeoutMs) {
        long deadline = SystemClock.elapsedRealtime() + timeoutMs;
        synchronized (lock) {
            while (ready && buffered == 0) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) return 0;
                try {
                    lock.wait(remaining);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return -1;
                }
            }
            if (!ready) return -1;
            int count = Math.min(buffered, Math.min(maxSamples, destination.length));
            int first = Math.min(count, samples.length - head);
            System.arraycopy(samples, head, destination, 0, first);
            System.arraycopy(samples, 0, destination, first, count - first);
            head = (head + count) % samples.length;
            buffered -= count;
            return count;
        }
    }

    private static final class Lc3 {
        static {
            System.loadLibrary("s23u_glasses_lc3");
        }

        static native long create();
        static native boolean decode(long decoder, byte[] packet, int frames,
                                     int concealedFrames, short[] pcm);
        static native void destroy(long decoder);
    }
}
