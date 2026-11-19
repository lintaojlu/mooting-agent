# MootingAgent

基于复制的 DSH Cordis、官方 CLI/Loader 和最小 Agent 插件的单 Session 原型。Router 和模型 Worker 使用真实 Responses API；sound2text 接入火山引擎双向流式 ASR。长期记忆由本机 [Hindsight](https://github.com/vectorize-io/hindsight) 守护进程负责，自动写入、后台整理，Router 每轮只读本地缓存。生产路径没有规则模型或模拟字幕兜底。

## 启动与配置

需要 Node.js >= 24.9。

```sh
cd /Users/nil/Experiment/agent-harness-selection/mooting-agent
npm start
```

打开 http://127.0.0.1:4317 。首次语音采集需要允许浏览器麦克风权限。浏览器只连接本地服务，火山鉴权在后端执行；开启语音即持续向火山上传音频，暂停则停止上传并释放麦克风。

公网入口挂在路径前缀下，由反向代理终止 HTTPS。Web 默认要求登录，使用下面这组既有账号和同一密码。只有显式设置 `MOOTING_AUTH=0` 才跳过校验，供本机自动化使用。未设置 `MOOTING_PUBLIC_HOSTS` 时仍只接受 `127.0.0.1`。

```dotenv
MOOTING_PORT='4317'
MOOTING_BASE_PATH='/mooting-agent'
MOOTING_PUBLIC_HOSTS='nillin.space'
MOOTING_AUTH='1'
```

账号为 `nil`、`zoe`、`john`、`yanyi`、`fengshuai`、`yuxia`、`zhaoxin`、`olsen`，密码相同，只在服务端比对。登录后写入 HttpOnly Cookie，路径限制在前缀内。每个账号的会话记录和任务快照写在 `data/<用户名>/`。长期记忆只有一份：本原型只服务一个用户，所有账号共用同一个 Hindsight bank 和 `data/` 下的记忆文件，测试账号的记忆会混在一起，这是有意接受的。麦克风页面必须通过 HTTPS 打开。部署示例见 `deploy/`。

### 模型

交互 Web 已移除右上角“设置”入口。请在项目 `.env` 中填写 Router / Worker 的 Base URL、模型名称和可选 API Key，保存后重启应用；两者固定使用 Responses API。Worker 可复用 Router，也可单独配置。Base URL 填 `http://127.0.0.1:8000/v1` 等 API 前缀，不包含 `/responses`。

设置保存到项目 `.env`，包括密钥，文件权限为 0600，已被 Git 忽略。前端只收到 `hasApiKey`，不返回密钥。密钥输入留空保留同一服务地址的旧值。“已保存”不代表服务已验证。生产入口拒绝 `MOOTING_MODE=mock`，调用失败不回退假结果。

```dotenv
MOOTING_PROTOCOL='responses'
MOOTING_BASE_URL=''
MOOTING_MODEL=''
MOOTING_API_KEY=''
MOOTING_WORKER_BASE_URL=''
MOOTING_WORKER_MODEL=''
MOOTING_WORKER_API_KEY=''
```

Worker 配置为空时使用 Router。项目 `.env` 中的值优先于同名启动环境变量。切换模型保留可移植的公开对话与工具结果，同一路由才重放模型原生推理元数据。Responses 请求在收到响应头前遇到可识别的瞬时连接断开时最多重试一次，仍受原 45 秒总超时和用户取消控制；HTTP 错误和已经开始的输出流不重放。

### sound2text

项目 `.env` 已增加空凭证；填写后重启应用：

```dotenv
SOUND2TEXT_API_KEY=''
SOUND2TEXT_RESOURCE_ID=''
SOUND2TEXT_WS_URL='wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
SOUND2TEXT_END_WINDOW_MS='800'
SOUND2TEXT_COMMAND_SILENCE_MS='1500'
SOUND2TEXT_NO_SPEECH_MS='10000'
SOUND2TEXT_MAX_COMMAND_MS='60000'
SOUND2TEXT_FINAL_WAIT_MS='3000'
```

`SOUND2TEXT_API_KEY` 使用火山语音控制台的新版 API Key。资源 ID 按实际开通套餐填写，通常是 `volc.seedasr.sauc.duration` 或 `volc.seedasr.sauc.concurrent`。不是通用云账号的 IAM 密钥。旧版 App-Key/Access-Key 鉴权暂不启用。

接口依据：[火山官方双向流式 ASR 文档](https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh)。字节协议、状态、配置与限制详见 [sound2text 说明](src/sound2text/README.md)。

### 长期记忆（Hindsight）

启动时自动用 `uvx hindsight-embed@1.2.1` 拉起守护进程（profile `mooting`，端口 `9077`，bank `mooting`，只监听 `127.0.0.1`，自带嵌入式 Postgres），退出时自动停止。npm 生命周期管理包 `@vectorize-io/hindsight-all` 和客户端 `@vectorize-io/hindsight-client` 也固定为 `1.2.1`。本机需要 `uv` / `uvx`。上游源码放在 `vendor/hindsight`（提交 `04698b6`，见同目录 `UPSTREAM.json`），不含 profile、嵌入式数据库和模型缓存；这些仍在本机 `~/.hindsight` 与 `data/`。旧的 `MEMORY.md` 已停用，启动时删除，不导入。

```dotenv
MOOTING_HINDSIGHT_ENABLED='1'          # 0 关闭记忆服务
MOOTING_HINDSIGHT_PORT='9077'
MOOTING_HINDSIGHT_LLM_BASE_URL=''      # 留空回落到 MOOTING_CONTEXT_BASE_URL
MOOTING_HINDSIGHT_LLM_MODEL=''         # 留空回落到 MOOTING_CONTEXT_MODEL
MOOTING_HINDSIGHT_LLM_API_KEY=''       # 留空回落到 MOOTING_CONTEXT_API_KEY
MOOTING_HINDSIGHT_LLM_EXTRA_BODY=''    # 可选 JSON 对象，例如 DeepSeek: {"thinking":{"type":"disabled"}}
MOOTING_HINDSIGHT_PROXY=''             # Python 守护进程不读 macOS 系统代理；下载模型需要代理时填，如 http://127.0.0.1:7890
MOOTING_HF_ENDPOINT=''                 # 可选 Hugging Face 镜像
MOOTING_HINDSIGHT_PYTHON=''            # 可选；Apple Silicon 默认 cpython-3.12-macos-aarch64，避免 uvx 选到 x86_64 Python
MOOTING_EMBEDDING_BASE_URL=''          # 留空用本地 BAAI/bge-m3；填写则走 OpenAI 兼容 embedding
MOOTING_EMBEDDING_MODEL=''
MOOTING_EMBEDDING_API_KEY=''
MOOTING_EMBEDDING_DIMENSIONS=''
MOOTING_RERANKER_BASE_URL=''           # 留空用本地 hindsight-ai/hs-rerank-1
MOOTING_RERANKER_PROVIDER=''           # 填写 BASE_URL 时使用，默认 cohere
MOOTING_RERANKER_MODEL=''
MOOTING_RERANKER_API_KEY=''
```

只有 LLM 走远端，Hindsight 抽取和整理的输出语言固定为简体中文。LLM 未配置时不启动守护进程，面板显示「记忆未配置」；最近一分钟原话仍由本地记录并放入 Router 的用户消息。

`MOOTING_HINDSIGHT_LLM_EXTRA_BODY` 透传服务专用参数。本机 DeepSeek 配置使用 `{"thinking":{"type":"disabled"}}`，用于避免长文本整理的思考阶段超时；其他服务需按其接口填写或留空。Hindsight profile 中包含 LLM 凭证，启动时限制为 `0600`。

**首次启动**：uv 下载 Python 环境（每个版本约 1.5 GB 缓存，含 torch），Hugging Face 下载 `bge-m3`（约 2.2 GB）和 `hs-rerank-1`；embedding 和重排在 CPU 上运行。启动等待上限设为 30 分钟，并同步到 Python CLI，避免它默认的 180 秒先超时。期间面板显示「记忆服务启动中」，读取上次的磁盘缓存，写入照常进 outbox。退出会取消尚未完成的启动等待。

Python 不读取 macOS 系统代理；需要代理下载模型时，设置 `MOOTING_HINDSIGHT_PROXY`（为空时可继承 `HTTPS_PROXY`），或用 `MOOTING_HF_ENDPOINT` 指定可用镜像。代理也会传给 daemon 的远端 HTTP 调用，loopback 地址绕过代理。Apple Silicon 默认指定 arm64 Python 3.12，避免 PATH 中的 Intel Python 导致 torch 无可用 wheel；可用 `MOOTING_HINDSIGHT_PYTHON` 覆盖。

远端重排支持 `cohere`、`tei`、`litellm`、`litellm-sdk`、`nvidia`、`zeroentropy`、`openrouter` 和 `siliconflow`，按各服务实际字段映射 URL；TEI 只需要服务 URL。留空 `MOOTING_RERANKER_BASE_URL` 时使用本地模型。

**embedding 维度在第一次写入后固定。** 以后换 embedding 模型或维度，要把全部记忆重新算一遍 embedding（或删掉 bank 重来）。

存取规则：

- **写入**：每条 ASR 定稿立刻进最近原话（内存 + `data/fragments.jsonl`）和 outbox（`data/hindsight-outbox.jsonl`）。攒够 20 句或 2000 字、静默 60 秒、语音暂停或停止，任一成立且 Router 空闲时，按天追加到 `stream-<日期>` 文档。Router 每轮在 `turn/end` 写入 `turn-<inputId>`，被打断的那一轮不写。退出前强制提交剩余内容。异步请求被受理后仍保留在磁盘 outbox，只有 operation 状态为 `completed` 才移除；失败时退避重试，断线或重启后继续确认。同一 `operation_id` 重放避免重复提交，同一天的 append 按顺序执行。说话人一律标为「未确认」。
- **记住 / 忘掉 / 纠正**：「记住……」立即进本地缓存，并提交 `async: false` 的 retain（`explicit` 标签）；远端未成功时仍保留待写内容。「忘掉……」立即用墓碑过滤注入内容与工具结果，删除意图持久化，离线时等待恢复后执行。「不对，王磊是产品经理」这类更正会保留新说法，并以主语「王磊」保守屏蔽旧缓存，随后清理远端旧来源。识别依赖固定中文句式和文本匹配，详见下方限制。
- **每轮输入**：不发网络请求、不调模型，只读内存。最近 **1 分钟内全部定稿原话** 按顺序写进 Router 的 user prompt；按钮收束得到的 command 放在独立「用户指令」节，旧原话不能作为额外授权。旧版不经采集按钮的语音交互会把最近一分钟原话交给 Router，要求它提取最后一个明确、完整的 command；没有指令时不调用工具。长期记忆的用户档案（500 字）、进行中事项（500 字）、相关人物（按姓名和别名命中指令与最近原话，最多 3 人，每人 150 字）仍经 system prompt 注入，不重复塞入原话。三份 mental model（`user-profile`、`people`、`open-items`）每 60 秒拉取一次，存入 `data/memory-cache.json`。面板的「最近原话」只显示最近一分钟内的定稿。
- **Router 工具（只读）**：`memory_search` 同步召回，3 秒超时返回空结果；`memory_reflect` 在 Worker 后台综合回答，60 秒超时，完成后唤醒 Router 回报。Router 没有写记忆的工具。

Context 面板显示服务状态、outbox 积压、三份 mental model 的更新时间和上次写入结果。独立的 Context System Trace 记录定稿、Router 忙闲、封批、Hindsight 提交及操作状态、缓存刷新、检索与回想、失败和重试；事件持久化在权限受限的 `data/context-trace.jsonl`，页面通过受登录保护的 `/api/context/trace` 读取完整历史，实时状态流只带最近 200 条。它记录本应用 Context 的调用边界，不是 Hindsight Python 守护进程内部逐 token 日志。Agent Trace 保持 DSH 原有的 Router/工具轨迹。会话日志保留历次记忆快照用于追溯；发送给模型时仅投影最新的 `mooting-memory` 快照，避免旧记忆反复累加和被纠正的缓存继续出现。删除最后一条记忆也会生成替换快照，声明旧快照失效。

## 交互

第一行是输出面板，右侧从上到下为控制面板、较矮的信息流和 Router；Context 单独占一整行，桌面宽度下「最近原话」「注入 Router 的记忆」两栏并排，窄屏堆叠；其后依次是 Context System Trace 和 Agent Trace。输出面板使用波导绿。输入面板有两个图形操作：播放/暂停语音和同心圆交互键。

| 状态与操作 | 行为 |
| --- | --- |
| 语音未开启 | 输入框可以打字，同心圆发送指令 |
| 点击播放 | 开启麦克风与 sound2text，输入框锁定并显示实时 ASR |
| 语音开启、字幕未开启时按同心圆 | 从音频采样检查点开始收集之后的指令，不包括按钮前内容 |
| 收集指令中再次按同心圆 | 手动结束，等尾部定稿后提交 |
| 有声后连续静默约 1.5 秒 | 自动收束，等待覆盖尾部的 ASR 定稿，合并多个分句后只提交一次 |
| 10 秒未开口 | 结束等待，不提交空指令 |
| 单次指令到 60 秒 | 停止收集并等待定稿，提示达到时限 |
| 尾部超过 3 秒未定稿 | 中止提交，保留已识别文本并提示重试 |
| 暂停、断线、麦克风失效 | 中止未完成指令，不把残缺文本自动交给 Router |
| Router 正在执行时按同心圆 | 打断 Router 并接收新指令，已启动 Worker 不取消 |
| 字幕运行时按同心圆 | 仅关闭字幕，sound2text 继续运行，不同时采集新指令 |
| sound2text 未开启时要求字幕 | Worker 报错给 Router，由 Router 提示先开启语音输入 |
| 字幕运行中暂停或 ASR 断线 | 字幕停止订阅并上报，不显示假文本 |

点击播放只是持续识别，不会把每个 ASR 分句自动交给 Router。按钮后的收集才形成一条指令；Router 用户消息同时带上最近一分钟的所有定稿原话，提取出的 command 单独标明，不能把背景里其他句子当成新指令。临时 ASR 可显示和修订；Router 不把未定稿草稿当作自动提交的指令。按钮恰在一句话中间时用词时间戳裁剪；缺少可靠词时间戳则安全中止，不猜测字符串边界。

播放暂停不会播放录音。AudioWorklet 将实际设备采样率重采样为 16kHz 单声道 PCM16LE，每 200ms 上传，输出音频保持静音，不产生麦克风回放。按键通过 worklet 检查点刷新缓冲，避免混入点击前尚未上传的音频。

## 执行路径与任务生命周期

```text
麦克风 → AudioWorklet / PCM → 本地 sound2text → 火山 WebSocket ASR
                                     ├─ 实时文本 → 输入框
                                     ├─ ASR 定稿 → Context.observe() → 最近原话 + outbox → Hindsight（Router 空闲时）
                                     ├─ 按钮后语句收束 → command + 最近1分钟全部定稿 → user prompt → Router
                                     │                 本地缓存 → system prompt → Router
                                     └─ 字幕订阅 → 输出面板

Router → open_speaker / close_speaker / memory_search（同步）
       → memory_reflect（立即返回受理）→ Worker 后台 reflect → 回报唤醒 Router
       → turn/end → Context.recordTurn() → outbox
每 60 秒：三份 mental model → data/memory-cache.json
```

全局只创建 `mooting-main` 一个 DSH Agent/Session。Router 取消只终止自己的模型循环；Worker 由 Task Manager 独立持有 AbortSignal，宿主退出才统一清理。用户正在采集新指令时，Worker 完成事件先记录不立即唤醒 Router；新的人类输入优先，随后由 Router 决定如何呈现旧结果。Worker 不直接回复用户，字幕是获得展示权后的持续订阅。

Worker 模型使用独立任务输入调用 `dsh-llm`，不创建第二个 Session。请求、增量、结果以 `mooting/worker-*` 事件写入当前 Session，并包含任务 ID；Router 与 Worker 分开显示，所有模块使用同一 Session 数据。

## DSH 与插件

最小后端插件：Session、Session Projection、LLM、System Prompt、Tools、Native Executor、Agent、Agent Loop。业务插件：Models、Workers、sound2text、Capabilities、Router。启动使用复制的官方 DSH CLI 和独立 profile，不加载 dsh-base、Shell、Coding 工具或完整 GUI。

前端复用 DSH 时间轴、轨迹表及对话叶组件。上层视图由原型适配，未声称完整挂载官方 ChatView。详见 [DSH 视图复用说明](web/dsh-views-src/README.md)。

```sh
npm run vendor                # 重复制已有构建的 DSH 依赖
node src/vendor-ws.mjs        # 复制音频 WebSocket 依赖
npm run build:web             # 重新构建 DSH 视图
```

重新复制/构建需要相邻 DSH checkout；普通运行仅依赖本项目已复制产物。`vendor/manifest.json`、`vendor/dsh-views-manifest.json`、`vendor/ws-manifest.json`（如复制脚本生成）记录来源，许可证保留。

## 测试与验证范围

```sh
npm test
npm run test:browser
npm run test:memory            # 真实 Hindsight + 真实 Context LLM
npm run test:memory:browser    # 独立记忆面板 Chrome 检查，不调用收费 API
npm run test:memory:soak       # 一小时持续流 + 真实 Router/Context LLM，会产生费用
npm run test:memory:recall     # 6 位合成人物的姓名/别名召回样本
npm run test:memory:latency    # 等轮数 Router Session 交替首包对照，调用真实 LLM
node tests/hindsight-live.mjs   # 预热测试守护进程（下载依赖），可选
```

模块测试覆盖真实本地 WebSocket 协议、PCM、重采样、采样检查点、静默/定稿/超时/暂停、临时修订、跨按钮边界、Router 打断而 Worker 继续、后台结果排队和单 Session。浏览器测试使用 Chrome 合成麦克风 WAV、**仅测试加载的本地火山协议 fixture** 和 Responses fixture，执行实际 AudioWorklet、页面操作和网络调用。测试不调用收费火山 API，也不代表真实语音识别质量。

**记忆测试调用真实 LLM。** `tests/memory-live.test.mjs` 连接真实 Hindsight（profile `mooting-test`、端口 `9078`，与正式数据隔离），每次运行建一个带运行编号的 bank，结束时清理。它通过 `.env` 里的 Context LLM 抽取事实、刷新 mental model 和 reflect，一次可能产生几十次 LLM 调用。按低价模型估算，成本约几分钱至几角、耗时约 3–10 分钟；实际取决于模型价格、后台重试和 CPU 吞吐，首次运行还要先下载上述依赖。未配置 LLM 时这些测试显示为跳过，不算通过。其余记忆逻辑（flush 条件、上限、墓碑、重放、热路径 P95）由 `tests/context.test.mjs` 离线覆盖；`tests/hindsight-bridge.test.mjs` 使用实际 npm SDK 和本地 HTTP fixture 验证超时、取消、错误分类与配置映射。

记忆集成测试、专名召回样本和一小时验收共用隔离 profile `mooting-test` / 端口 `9078`，需要依次运行。`MOOTING_DATA_ROOT` 可覆盖本地记忆和账号数据目录；独立浏览器检查用临时数据目录，不改正式数据。测试状态与性能结果见 [Hindsight 集成验收记录](research/hindsight-集成验收记录.md)。

已执行三轮完整一小时持续流。最终版本处理 1,199 条定稿，outbox 采样峰值 20、停止输入后约 9 秒清空，三份缓存均生成；compile P95 3.37 ms、定稿到可读 P95 5.72 ms，达到本地指标。最终一轮 Router 59 次成功、1 次远端 HTTP 502，首包 P95 比 8 次顺序基线高 691 ms，**整体验收未通过**。旧快照累加修复后的等轮数负载对照仅增加约 78 ms，但不能替代整小时标准；基线与后续会话长度不同，归因仍有限。中文专名小样本为姓名 6/6、别名 6/6 命中，不能代表大语料精度。完整指标、限制与全部失败报告见验收记录。

浏览器测试产出 `artifacts/browser-report.json`、桌面与窄屏截图。脚本使用 macOS Chrome 默认路径，并仅为读取合成音频禁用该测试浏览器的 AudioServiceSandbox；正常用户浏览器不改安全设置。缺配置时不会连接收费服务或伪造识别结果。

## 当前限制

- 声学静默基于 PCM 能量启发式，初始 RMS 阈值 0.012；环境说话、噪声、轻声可能影响判停，需用真实设备校准。静默并不保证语义完整。
- 实际火山账户鉴权、长连接时长、识别延迟、并发额度和真实语音质量尚未使用用户凭证验收。
- 语音开启期间会持续向火山上传音频；本版没有人物声纹和环境音分类，旁人说的「我」可能被记到用户身上。
- 嵌入式 Postgres 的关键词检索切不开中文，专名可能漏召回，靠语义和实体图检索补偿；需要时再升级外接 Postgres + `pgroonga`。
- mental model 刷新间隔下限为 10 分钟，再加后台抽取和整理耗时，忙碌或离线时可能更久；这段时间由最近原话补上。
- 显式记忆命令依赖固定中文开头，例如「记住……」「忘掉……」「不对，……」「纠正……」，未覆盖任意自然语言表达。墓碑按规范化文本和字符顺序匹配，不能保证删除所有语义相同的改写。
- 远端删除目前删除匹配事实的整个来源文档；按天追加的语音文档可能含有相邻的其他事实，这些事实也会被删掉。更正采用主语级屏蔽，会暂时隐藏该人物其他仍然有效的信息。使用这两项功能时应了解这个取舍。
- 本地音频 WebSocket 只允许同源 loopback 页面与单浏览器连接；远程部署需另行设计 HTTPS、鉴权与设备连接。
- 会话和任务在内存中，重启清空；模型/ASR 配置保存在 `.env`。原始音频只保留有限传输缓冲，不长期落盘。
- DSH 视图未集成附件、文件导航、对话分叉和完整 GUI RPC 工具结果追踪。
