# S23U 原子能力应用侧完整交付包（2026-11-20）

这是给应用层开发人员的完整包。接口版本仍为 `s23u.atomic.service.v1`；此包使用 2026-11-20 的构建产物。

## 内容

- `aar/atomic-api-debug.aar`：应用接入所需 AIDL 与 `AtomicClient`。
- `apk/atomic-service-debug.apk`：设备侧原子服务（`com.s23u.atomicservice`，`1.2.0-dev3`）。
- `apk/memory-transport-debug.apk`：本机数据库连接组件，须与原子服务同签名。
- `apk/S23UAtomicAssistant-debug.apk`：当前参考应用，含「记忆库 → 历史对话 / 社交图谱」。
- `example-app/`：当前参考应用源码做成的独立 Android Studio 工程，依赖包内 AAR，不依赖原工作区的其他模块。
- `docs/`：当前接口说明、接入指南、Debug 部署说明和安全说明。
- `samples/atomic-events-20261108.jsonl`：旧包中 2026-11-08 采集的真实回调，仅覆盖当时已实现的事件。
- `samples/memory-responses.example.jsonl`：新记忆接口的**合成结构样例**，不是设备实录；`example` 和 `method` 是样例包裹字段，真实返回只包含 `response` 中的 JSON。
- `SHA256SUMS.txt`：包内文件哈希。

## 接入与编译

应用只需把 AAR 加入自身模块，并按 `docs/APP_DEVELOPER_GUIDE.md` 声明权限与包可见性。完整接口以 `docs/原子能力接口交付说明.md` 为准。

`example-app` 可在 Android Studio 中独立打开；也可在其目录运行 `gradlew.bat :app:assembleDebug`。工程需要 Android SDK 36、JDK 17、AGP 9.4.0、NDK 30.0.16248370 和 CMake 3.22.1。请在 Android Studio 的 SDK Manager 中安装对应 NDK 和 CMake。参考应用的 mock 服务可用于无真机的界面联调；当前 mock 的历史记录返回空列表，记忆页的非空数据解析可用 `samples/memory-responses.example.jsonl` 验证。

这是 Debug 交付包。大模型文件、PostgreSQL/pgvector、Termux 配置与部署脚本不在包中；在新手机使用完整能力仍需另行部署。设备升级时保留服务数据，不要卸载服务或清除应用数据。

