# MootingAgent Android 接入

从 S23U 原子助手首页进入 MootingAgent。页面复用现有 Web UI。APK 打包 arm64 Node 与仓库固定版本的 DSH，运行在应用的 `:mooting` 进程。Java 采集手机麦克风 PCM，并通过现有 Binder 服务调用 ASR、VPR、语音归档和社交图谱。Agent 与 DSH 通过同 UID Unix socket 使用这些接口。文本由用户直接提交，语音转写须确认后才作为指令。声纹登记与眼镜输入继续使用现有原生页面。

Android 的 Hindsight 进程使用 APK 内的 CPython、依赖和仓库 vendored 的 Hindsight 1.2.1。Hindsight API 监听应用私有 Unix socket，Node 使用带鉴权的回环代理调用。提取、嵌入和重排由 Node 通过 Binder 转给本机原子模型。Web 搜索和抓取在设备端停用。应用私有目录中的 Hindsight outbox 和原子归档队列用于恢复待写记录。当前 DSH 对话存在进程内，进程重启后开始新对话。

## 原子服务接口

扩展 AAR 和服务 APK 由原子服务提供方交付。现有 `AtomicCapabilityService` 继续提供原接口。客户端用显式组件绑定 `com.s23u.atomicservice/com.s23u.atomicservice.AgentAtomicService`，服务需声明现有 `com.s23u.atomicservice.permission.BIND_ATOMIC_SERVICE` 权限。两个 AIDL 位于本项目的 `app/src/main/aidl/com/s23u/atomic/agent/`。`invoke` 应快速返回，后续通过 callback 对回相同的 request ID。`cancel` 幂等，服务取消后释放推理资源，迟到的回调会被客户端丢弃。

`getCapabilities()` 返回当前已就绪的能力，模型显示名和当前嵌入维数。例如：

```json
{
  "api": "s23u.agent.atomic.v1",
  "model": "qwen-local",
  "toolCalls": true,
  "jsonSchema": true,
  "embeddingDimensions": 512,
  "operations": { "model": true, "embedding": true, "rerank": true, "reply.archive": true }
}
```

| 操作 | 请求 | 响应 |
| --- | --- | --- |
| `model` | `{messages,tools,maxTokens,archive:false,responseFormat?}`。消息和内容块采用 DSH 格式，含 `system`、`user`、`assistant`、`tool` 消息，`tool-call` 和 `tool-result` 通过调用 ID 对应。工具定义为 `{name,description,parameters}`。Hindsight 提供 OpenAI `response_format` 的 `json_object` 或 `json_schema`。 | 流事件 `{type:"text",index,delta}` 或 `{type:"tool",index,id,name,delta}`。索引从 0 起且小于 256。同一工具块各事件的 ID、名称固定，`delta` 拼接成 JSON 参数。终止事件 `{type:"final",result:{ok:true,usage?:{inputTokens,outputTokens}}}`。调用期间关闭服务自动归档。 |
| `embedding` | `{texts:string[],dimensions:number}` | `{type:"final",result:{ok:true,vectors:number[][]}}`，与输入顺序、数量和维数一致。 |
| `rerank` | `{query:string,texts:string[]}` | `{type:"final",result:{ok:true,scores:number[]}}`，每个输入文本一个有限数值，分数越大越相关。 |
| `reply.archive` | `{sourceId,text,reply}`，`sourceId` 为用户指令 ID。 | `{type:"final",result:{ok:true}}`。在持久提交后才确认，重试同一个 `sourceId` 返回同样的成功结果。 |

调用失败时发送 `{type:"error",error:"可展示信息"}`，每次调用只发送一个终止事件。服务需支持已有 `recordSpeechTurn` 对同一 `occurredAtMs` 和 `segmentId` 幂等。结构化模型调用的客户端请求上限为 512 KB。请将 Binder 消息控制在事务预算内，必要时拆分模型增量。

## 构建与升级

在本目录运行：

```sh
bash gradlew :app:assembleDebug -Pandroid.ndk.version=28.2.13676358
```

可以用 `-Pmooting.node.archive=/absolute/path/to/nodejs-mobile-android-24.22.1-0.zip` 从本地读取经过 SHA-256 校验的 Node 包。默认下载同版本发布包。

完整 APK 构建需提供 Android arm64 CPython 3.14 运行时与依赖。以 Hindsight 仓库 `uv.lock` 中的 `hindsight-api-slim` 基础依赖为输入，提供 Android/Bionic 的安装目录，其中包括 `asyncpg`、`psycopg2`、`toktok_rs`、`numpy`、`pydantic_core`、`orjson` 与 Uvicorn。Native wheels 及其共享库必须使用 Android ABI。将依赖安装目录、CPython 3.14.10 Android aarch64 官方发布包和 NDK `aarch64-linux-android26-clang` 传给仓库的 `src/android/pack_hindsight.py`。把脚本生成的 ZIP 和 SHA-256 分别传给 `-Pmooting.hindsight.runtime` 和 `-Pmooting.hindsight.sha256`。正式构建要求这两个输入，缺少它们时仅调试 APK 可构建，页面会显示缺编译好的运行时。

在仓库的 `vendor/hindsight` 目录导出锁定版本。

```sh
uv export --locked --package hindsight-api-slim --no-dev --no-emit-workspace --no-annotate
```

CPython 3.14.10 和 NDK 交叉编译的 `asyncpg 0.32.0` 已分别在 ARM64 模拟器验证。锁定版本的 `psycopg2-binary`、`toktok-rs`、`numpy`、`pydantic-core`、`orjson` 等仍需供应兼容的 Android wheel，或在专用构建中验证可用的依赖方案。完整运行时 ZIP 及 Hindsight 的数据库迁移、写入和召回仍待验证。

从同一应用 ID 升级并保留设备数据时，供应原 APK 的签名。构建读取 `MOOTING_UPGRADE_KEYSTORE`、`MOOTING_UPGRADE_KEY_ALIAS`、`MOOTING_UPGRADE_STORE_PASSWORD` 和 `MOOTING_UPGRADE_KEY_PASSWORD`。安装前对照旧包证书，并用 `adb install -r -g` 升级。此次本机调试证书和交付目录内原 APK 的证书不同。

## PostgreSQL 与验收

在 Termux PostgreSQL 中创建专用数据库和角色，安装 `vector` 扩展，并允许该角色执行自身数据库中的 Hindsight migrations。沿用设备回环端口（原交付默认 `55432`）。Hindsight 工程只读应用私有的 `files/mooting/postgres.json`，格式是 `{"databaseUrl":"postgresql://<role>:<encoded-password>@127.0.0.1:55432/<db>"}`。调试包可以用 `adb shell run-as com.s23u.atomicclient` 将配置经标准输入写入，也可从完整 APK 的 MootingAgent 页打开「记忆设置」录入。Termux 服务重启后，Hindsight 启动会重试，恢复后补交 outbox 中的记录。已创建向量索引的库必须维持嵌入模型及其维数，切换时先规划向量迁移。

在装有扩展服务、模型和数据库的 S23U 上断开外网，按以下顺序验收。

1. 原生首页、模型配置、记忆库和眼镜页正常进入。
2. MootingAgent 提交文字指令，检查工具调用轨迹、取消以及最终回复一次归档。
3. 开启手机麦克风，检查 VAD、ASR、VPR、暂停时落盘的最后一段和确认后的指令执行。
4. 完成一轮后重启应用，通过 `memory_search` 召回内容，检查联系人图谱。中断 PostgreSQL 后恢复，确认队列重试及记录去重。
