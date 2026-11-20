# 应用开发人员接入指南

## 1. 前提

手机上已经安装并部署 `com.s23u.atomicservice`。应用不复制模型、不加载 `.so`，只引入 AAR。

把 `aar/atomic-api-debug.aar` 放进应用模块 `libs`：

```gradle
dependencies {
    implementation files('libs/atomic-api-debug.aar')
}
```

Manifest：

```xml
<uses-permission android:name="com.s23u.atomicservice.permission.BIND_ATOMIC_SERVICE" />
<queries>
    <package android:name="com.s23u.atomicservice" />
</queries>
```

开发期安装后授权：

```powershell
.\adb.exe shell pm grant 你的应用包名 com.s23u.atomicservice.permission.BIND_ATOMIC_SERVICE
```

## 2. 绑定

```java
AtomicClient atomic = new AtomicClient(context, new AtomicClient.Listener() {
    @Override public void onConnected(IAtomicService service) {
        // 保存 service；先读取 getServiceInfo() 检查 API 和模型 ready 状态。
    }
    @Override public void onDisconnected() {
        // 清空引用；界面提示服务重连/模型可能需要重新预热。
    }
    @Override public void onError(String message) {
        // 显示安装、权限或绑定错误。
    }
});
atomic.bind();
```

在 Activity/组件销毁时调用 `atomic.close()`。

## 3. WAV 调用

```java
String requestId = UUID.randomUUID().toString();
try (ParcelFileDescriptor fd = ParcelFileDescriptor.open(
        wavFile, ParcelFileDescriptor.MODE_READ_ONLY)) {
    service.runAsr(requestId, fd, new IAtomicCallback.Stub() {
        @Override public void onEvent(String id, String eventJson) {
            // 解析 type=final/error；切回 UI 线程后更新界面。
        }
    });
}
```

VAD、ASR、VPR 都采用同一 PFD 方式。若录音格式不是 PCM16/mono/16k，先在应用层录制或重采样成符合条件的 WAV。

## 4. 流式 LLM

麦克风连续识别先启动服务端会话，并持续提交小块 PCM：

```java
service.startContinuous(sessionId, 0.8f, 0.01f, 32, 500, callback);
service.pushContinuousPcm(sessionId, pcm16LittleEndian, sampleCount);
// 停止时：
service.stopContinuous(sessionId, callback);
```

启动 callback 会持续收到 `vad_frame`、`vad`、`asr`、`vpr` 事件。应用用相同 `segment_id` 组装 SpeechTurn；模型、切段状态和声纹库均留在服务进程。

连续识别开始时调用一次：

```java
service.warmupLlm(requestId, graphContext, callback);
```

每一条流式 ASR 完整分段都调用：

```java
service.generateLlmStream(requestId, asrText, graphContext, callback);
```

收到 `type=chunk` 立即追加到当前卡片；收到 `type=final` 后用完整结果和延时字段完成该卡片。不要等会议整体结束才调用 LLM。应用层负责队列、TurnAssembler、会议历史和展示策略；原子服务只提供模型能力。

## 5. 声纹与图谱

识别未知人时，应用自行决定防打扰策略（例如连续两次稳定未知才提示）。用户输入姓名后，用最近一次质量合格的 WAV 调用 `enrollSpeaker`，不要求再次录音。成功后再调用 `getSocialGraphSnapshot()` 刷新人物关系。

删除联系人调用 `deleteContact(requestId, speakerId, callback)`；成功后同样刷新图谱。不要只删 UI 节点，数据库和声纹注册必须由服务接口统一更新。

## 6. 可运行参考

`example-app/app/src` 是独立包 `com.s23u.atomicclient` 的完整应用层源码，应用名“S23U 原子助手”，没有模型或原子服务 Native Runtime。它提供与第二阶段 APP 对齐的连续录音、流式 ASR/LLM、声纹录入、成员管理和图谱界面。接入前先在该手机运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File E:\S23U_AI\app_end\scripts\04_Test_Cross_App.ps1
```

只有出现 `TEST_RESULT=PASS`，才说明设备、服务、权限、模型和 Binder 全链路可用。



