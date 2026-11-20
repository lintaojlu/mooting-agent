# 部署、升级与调试

## 首次部署

```powershell
cd E:\S23U_AI\app_end
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\01_Build_All.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\02_Deploy_First_Time.ps1 -SkipBuild
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\04_Test_Cross_App.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\06_Test_Phase2_App.ps1
```

首次部署把约 2.48 GiB 模型复制到服务私有目录。脚本按字节数跳过已存在模型，并在成功复制后删除 `/data/local/tmp` 中明确创建的中转副本。

手机端布局：

```text
/data/user/0/com.s23u.atomicservice/files/
├─ models/
│  ├─ vad/silero_vad.onnx
│  ├─ asr/model.bin + tokens.txt
│  ├─ vpr/campplus.onnx
│  └─ llm/qwen3-4b-q4_0.gguf
└─ data/
   ├─ vpr/identity_registry.v1.db
   └─ social_graph/contacts.v1.db
```

## 日常升级

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\03_Reinstall_Keep_Data.ps1
```

该脚本只使用 `adb install -r -g`，随后检查五个模型字节数。它不会调用 uninstall，不会清空联系人或声纹库。

如果更新了原生 JNI/Runtime，先把主工程最新 `.so` 刷进服务工程：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\01_Build_All.ps1 -RefreshNativeLibraries
```

## 重新部署模型

模型缺失时运行首次部署脚本；强制覆盖模型时加 `-ForceModelCopy`。这会覆盖对应模型文件，但仍不删除数据库。

## 记忆库

「S23U 原子助手 → 记忆库」通过 `s23u.memory.v1` 读取对话和社交图谱，通过
`s23u.retrieval.v1` 搜索对话。服务首次启动会导入旧图谱文件中可读取的交互记录。

新设备先在 Termux 中安装 PostgreSQL、Clang 和 Make。用 Termux 的原生会话或从该会话启动的 SSH 运行以下命令。

```sh
cd pgvector-0.8.7
make OPTFLAGS= with_llvm=no SHLIB_LINK=-lm
make install OPTFLAGS= with_llvm=no SHLIB_LINK=-lm
bash /path/to/setup_memory_postgres_termux.sh
```

数据库只监听手机的 `127.0.0.1:55432`。将配置脚本生成的
`~/.s23u-memory/app-password` 通过标准输入写入服务私有目录
`files/memory-postgres.properties` 的 `password` 键，并设置 `transport=binder`。
同签名的 `memory-transport-debug.apk` 只向原子服务提供该回环地址的连接。
将 `bge-small-zh-v1.5-int8.onnx` 和配套 `vocab.txt` 放入服务的
`files/models/embedding/` 以启用 512 维语义检索。

手机重启或 Termux 结束后，在 Termux 执行 `~/start-s23u-memory`。
应用会在 PostgreSQL 不可用时读取 SQLite，并在数据库恢复连接后自动同步待写入内容。

## 故障诊断

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\05_Diagnose.ps1
```

重点日志标签：

- `S23U_ATOMIC_SERVICE`：Binder 请求和 final/error
- `S23U_ATOMIC_CLIENT`：独立客户端验收
- `S23U_LLM_STREAM`：流式 chunk
- `S23U_LLM`：llama.cpp/HTP 模型加载和生成
- `S23U_PHASE2_SERVICE_ACCEPT`：第二阶段综合 APP 作为 Binder 客户端的验收

常见问题：

- `Cannot bind`：服务未安装、Manifest 缺少 queries/permission，或权限未 grant。
- `model missing`：运行 `02_Deploy_First_Time.ps1`。
- WAV 格式错误：确保 PCM16、mono、16 kHz。
- LLM 首次慢：首次 HTP 模型装载约数秒；应在连续识别开始时预热。
- 服务断开：查看 `lowmemorykiller`；客户端必须使用交付 AAR 中带 `BIND_IMPORTANT | BIND_ABOVE_CLIENT` 的 `AtomicClient`。
- 升级后数据消失：通常是误用了 uninstall 或清除应用数据；`install -r` 本身不会删除。

## 恢复原则

原始模型仍保存在 Windows `E:\S23U_AI\llm_SenseVoice_Small\models`。手机端服务数据没有自动备份；声纹/图谱数据库如需迁机或防丢失，应在下一阶段新增经用户授权的导出/导入接口，而不是让普通应用直接访问服务私有目录。


