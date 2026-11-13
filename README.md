# MootingAgent

基于复制的 DSH Cordis、官方 CLI/Loader 和最小 Agent 插件的单 Session 原型。Router 和模型 Worker 使用真实 Responses API；sound2text 接入火山引擎双向流式 ASR。Context 当前只做结构化包装，没有长期记忆或知识图谱。生产路径没有规则模型或模拟字幕兜底。

## 启动与配置

需要 Node.js >= 24.9。

```sh
cd /Users/nil/Experiment/agent-harness-selection/mooting-agent
npm start
```

打开 http://127.0.0.1:4317 。首次语音采集需要允许浏览器麦克风权限。浏览器只连接本地服务，火山鉴权在后端执行；开启语音即持续向火山上传音频，暂停则停止上传并释放麦克风。

公网入口挂在路径前缀下，由反向代理终止 HTTPS。设置 `MOOTING_PUBLIC_HOSTS` 后默认要求登录；本地不设置这些变量时仍只监听 `127.0.0.1`，不启用账号校验。

```dotenv
MOOTING_PORT='4317'
MOOTING_BASE_PATH='/mooting-agent'
MOOTING_PUBLIC_HOSTS='nillin.space'
MOOTING_AUTH='1'
```

账号为 `nil`、`zoe`、`john`、`yanyi`、`fengshuai`、`yuxia`、`zhaoxin`、`olsen`，密码相同，只在服务端比对。登录后写入 HttpOnly Cookie，路径限制在前缀内。每个账号的记忆、信息流片段、会话记录和任务快照都写在 `data/<用户名>/`。麦克风页面必须通过 HTTPS 打开。部署示例见 `deploy/`。

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

Worker 配置为空时使用 Router。项目 `.env` 中的值优先于同名启动环境变量。切换模型保留可移植的公开对话与工具结果，同一路由才重放模型原生推理元数据。

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

## 交互

输入、输出面板在同一行；Context、Router、Worker、轨迹各独占一行。输出面板使用波导绿。输入面板有两个图形操作：播放/暂停语音和同心圆交互键。

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

点击播放只是持续识别，不会把每个 ASR 分句自动交给 Router。按钮后的收集才形成一条指令。临时 ASR 可显示和修订；Router 只收到收束后的定稿文本。按钮恰在一句话中间时用词时间戳裁剪；缺少可靠词时间戳则安全中止，不猜测字符串边界。

播放暂停不会播放录音。AudioWorklet 将实际设备采样率重采样为 16kHz 单声道 PCM16LE，每 200ms 上传，输出音频保持静音，不产生麦克风回放。按键通过 worklet 检查点刷新缓冲，避免混入点击前尚未上传的音频。

## 执行路径与任务生命周期

```text
麦克风 → AudioWorklet / PCM → 本地 sound2text → 火山 WebSocket ASR
                                     ├─ 实时文本 → 输入框
                                     ├─ 按钮后语句收束 → submit → Context → Router
                                     └─ 字幕订阅 → 输出面板

Router → dispatch_worker（立即返回受理状态）
       → 独立 Worker 执行
       → 结果/失败/ready 排队回报 Router
       → Router 简短回复用户
```

全局只创建 `mooting-main` 一个 DSH Agent/Session。Router 取消只终止自己的模型循环；Worker 由 Task Manager 独立持有 AbortSignal，宿主退出才统一清理。用户正在采集新指令时，Worker 完成事件先记录不立即唤醒 Router；新的人类输入优先，随后由 Router 决定如何呈现旧结果。Worker 不直接回复用户，字幕是获得展示权后的持续订阅。

Worker 模型使用独立任务输入调用 `dsh-llm`，不创建第二个 Session。请求、增量、结果以 `mooting/worker-*` 事件写入当前 Session，并包含任务 ID；Router 与 Worker 分开显示，所有模块使用同一 Session 数据。

## DSH 与插件

最小后端插件：Session、Session Projection、LLM、System Prompt、Tools、Native Executor、Agent、Agent Loop。业务插件：Models、Workers、sound2text、Capabilities、Router。启动使用复制的官方 DSH CLI 和独立 profile，不加载 dsh-base、Shell、Coding 工具或完整 GUI。

前端复用 DSH 时间轴、轨迹表及对话叶组件。上层视图由原型适配，未声称完整挂载官方 ChatView。详见 [DSH 视图复用说明](web/dsh-views-src/README.md)。

```sh
npm run vendor                # 重复制已有构建的 DSH 依赖
node scripts/vendor-ws.mjs     # 复制音频 WebSocket 依赖
npm run build:web             # 重新构建 DSH 视图
```

重新复制/构建需要相邻 DSH checkout；普通运行仅依赖本项目已复制产物。`vendor/manifest.json`、`vendor/dsh-views-manifest.json`、`vendor/ws-manifest.json`（如复制脚本生成）记录来源，许可证保留。

## 测试与验证范围

```sh
npm test
npm run test:browser
```

模块测试覆盖真实本地 WebSocket 协议、PCM、重采样、采样检查点、静默/定稿/超时/暂停、临时修订、跨按钮边界、Router 打断而 Worker 继续、后台结果排队和单 Session。浏览器测试使用 Chrome 合成麦克风 WAV、**仅测试加载的本地火山协议 fixture** 和 Responses fixture，执行实际 AudioWorklet、页面操作和网络调用。测试不调用收费火山 API，也不代表真实大模型推理或语音识别质量。

浏览器测试产出 `artifacts/browser-report.json`、桌面与窄屏截图。脚本使用 macOS Chrome 默认路径，并仅为读取合成音频禁用该测试浏览器的 AudioServiceSandbox；正常用户浏览器不改安全设置。缺配置时不会连接收费服务或伪造识别结果。

## 当前限制

- 声学静默基于 PCM 能量启发式，初始 RMS 阈值 0.012；环境说话、噪声、轻声可能影响判停，需用真实设备校准。静默并不保证语义完整。
- 实际火山账户鉴权、长连接时长、识别延迟、并发额度和真实语音质量尚未使用用户凭证验收。
- 语音开启期间会持续向火山上传音频；本版没有人物声纹、环境音分类、长期记忆或知识图谱。
- 本地音频 WebSocket 只允许同源 loopback 页面与单浏览器连接；远程部署需另行设计 HTTPS、鉴权与设备连接。
- 会话和任务在内存中，重启清空；模型/ASR 配置保存在 `.env`。原始音频只保留有限传输缓冲，不长期落盘。
- DSH 视图未集成附件、文件导航、对话分叉和完整 GUI RPC 工具结果追踪。
