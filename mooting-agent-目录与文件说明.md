# MootingAgent 目录与文件说明

> 生成时间：2026-11-13
>
> 本文按当前工作区实际文件、`package.json`、`cordis.patch.yml`、`vendor/manifest.json` 和 `vendor/dsh-views-manifest.json` 编制。标记不是 Git 状态：当前原型目录整体位于上层实验仓库的未跟踪目录中，因此“新增”表示相对于相邻 DSH checkout 的项目新增，而不是“本次会话新建”。

## 标记规则

| 标记 | 含义 |
|---|---|
| **[DSH 原始]** | 从相邻 `deepseek-harness` checkout 复制、未按 MootingAgent 业务改写的 DSH/Cordis 包或源码；通常由 `vendor/manifest.json` 的来源路径和 SHA-256 记录证明。 |
| **[DSH 改造/复用]** | 以 DSH 能力为基础，由本项目适配、打包、配置或投影后的文件；它不是官方 DSH 原文件，不能直接回写覆盖 DSH。 |
| **[MootingAgent 新增]** | 本项目自己的业务、ASR、HTTP、前端、测试、脚本和研究文件。 |
| **[运行/生成]** | 启动、构建或浏览器测试产生的本地状态、截图、报告、缓存或密钥文件；通常不应提交。 |

## 项目定位

MootingAgent 是一个单 Session 原型：复用 DSH 的 Cordis、Agent、Agent Loop、Session、LLM、Tools 和部分 Web 叶组件；Router 负责理解和调度，Worker 独立执行模型任务或持续字幕任务，sound2text 连接火山引擎流式 ASR。全局只创建 `mooting-main` 一个 DSH Session。生产入口只接受真实模型，不把失败替换为模拟结果；模拟能力仅存在于自动化测试和明确标注的说话人卡片。

## 顶层目录和文件

| 路径 | 标记 | 作用 |
|---|---|---|
| `.env` | **[运行/生成]** | 本地模型和 sound2text 凭证；被 `.gitignore` 忽略，写入时权限为 `0600`，前端只看到是否存在 API Key。 |
| `.gitignore` | **[MootingAgent 新增]** | 忽略 `.runtime/`、`node_modules`、`.env` 和日志。 |
| `.DS_Store` | **[运行/生成]** | macOS Finder 元数据，与应用无关，不应纳入项目说明或提交。 |
| `README.md` | **[MootingAgent 新增]** | 启动、模型和 ASR 配置、交互语义、执行路径、测试范围和当前限制。 |
| `package.json` | **[DSH 改造/复用]** | 原型自己的 npm 清单；声明 Node/DSH 版本、vendor/start/build/test 命令及 DSH bundle patch 配置。 |
| `cordis.patch.yml` | **[DSH 改造/复用]** | DSH Loader 的本项目组合配置：插入 DSH 核心插件和 MootingAgent 的 Worker、Models、sound2text、Capabilities、Router 插件。 |
| `node_modules` | **[DSH 改造/复用]** | 指向 `vendor/node_modules` 的符号链接，保证 Node 按项目内复制产物解析依赖。 |
| `.runtime/` | **[运行/生成]** | `scripts/start.mjs` 生成的隔离 DSH profile、临时模型/ASR 配置、浏览器测试工作目录；不应作为源码使用。 |
| `vendor/` | **[DSH 原始 + DSH 改造/复用]** | 见下文：既包含 DSH 复制产物，也包含来源清单、视图归档和项目构建元数据。 |
| `src/` | **[MootingAgent 新增]** | 后端业务、Router、Worker、任务管理、模型适配和 sound2text 实现。 |
| `web/` | **[DSH 改造/复用 + MootingAgent 新增]** | 原型页面、音频采集和 DSH 视图适配/构建产物。 |
| `scripts/` | **[MootingAgent 新增]** | DSH vendor、视图构建、WebSocket 依赖复制、启动器和浏览器验收脚本。 |
| `tests/` | **[MootingAgent 新增]** | 单元、集成、协议、真实模型 fixture、浏览器辅助和前端行为测试。 |
| `artifacts/` | **[运行/生成]** | 浏览器验收截图、报告和调试快照。 |
| `research/` | **[MootingAgent 新增]** | Memory System 调研及 Context 分层选型记录。 |

## `src/`：后端源码

### 根级文件

| 文件 | 作用 |
|---|---|
| `src/index.mjs` | DSH Loader 入口；校验生产模式不允许 mock，等待 Models/ASR 就绪，创建 `MootingRuntime`，启动本地 Web 服务并注册清理效果。 |
| `src/runtime.mjs` | 单 Session Router 运行时核心；创建 `mooting-main` Agent，记录 DSH 事件、流式输出和错误，注册 `dispatch_worker`，处理提交、打断、持续任务报告、模型切换和销毁。 |
| `src/tasks.mjs` | 输入快照和 Task Manager；把单条指令包装成不可变 Context，管理能力注册、任务状态、AbortSignal、持续显示租约、结果回报和退出清理。 |
| `src/worker-plugin.mjs` | Cordis `mootingWorkers` Service；持有不属于 Router 的 Task Manager 和 Worker 事件总线。 |
| `src/models-plugin.mjs` | Cordis `mootingModels` Service；读取/保存模型配置、注册 DSH LLM adapter、调用独立 Worker 模型，并在公开状态中隐藏密钥。 |
| `src/model-adapters.mjs` | Responses API 适配器；把 DSH 消息转换为 Responses input，解析 SSE/JSON 流、函数调用、推理摘要、终态和同路由 replay。明确不支持 Chat Completions fallback。 |
| `src/model-env.mjs` | `.env` 的安全读写；只替换自有变量、保留其他内容、转义引号、创建目录并强制 `0600`。 |
| `src/capabilities.mjs` | 能力实现与注册：实时字幕、模拟说话人识别，以及 `summarize_context`、`explain_term`、`general_assistant` 三种模型能力；拒绝空结果和隐式模拟回退。 |
| `src/capabilities-plugin.mjs` | Cordis `mootingCapabilities` Service；把真实 Models 和共享 sound2text 注入能力注册。 |
| `src/web-server.mjs` | 仅 loopback 的 HTTP/SSE API 和静态资源服务；提供状态、提交、打断、模型配置、语音交互、字幕帧接口，并挂载音频 WebSocket。 |

### `src/sound2text/`

| 文件 | 作用 |
|---|---|
| `src/sound2text/protocol.mjs` | 火山引擎双向流式 ASR v1 帧编码/解码；处理 gzip、序列号、终止帧、长度限制和初始化 payload。 |
| `src/sound2text/service.mjs` | `Sound2Text` 状态机；建立 ASR WebSocket、上传 16 kHz PCM、合并临时/定稿 utterance、按声学静默收束指令、处理边界时间戳、超时、暂停和错误。 |
| `src/sound2text/plugin.mjs` | 将 `Sound2Text` 引擎包装成 Cordis `sound2text` Service，暴露 `ready/events/state/start/pushAudio/pause/subscribe/armCapture/finishCapture/cancelCapture`。 |
| `src/sound2text/http-ws.mjs` | 浏览器到后端的同源、单所有者 PCM WebSocket；校验 Host/Origin、控制消息、消息队列和断线清理。 |
| `src/sound2text/README.md` | ASR 协议来源、服务接口、状态/事件、配置、采集边界语义、限制和测试说明。 |

## `web/`：浏览器端

### 页面与音频

| 文件 | 标记 | 作用 |
|---|---|---|
| `web/index.html` | **[MootingAgent 新增]** | 页面骨架：设置对话框、输入/输出面板、只读 Context、Router、Worker、执行轨迹、原始事件区和 DSH 视图资源引用。 |
| `web/app.js` | **[MootingAgent 新增]** | 前端状态校验、SSE 连接、模型配置、提交/打断、输出优先级、语音按钮和 DSH 视图渲染协调；不把密钥回填到表单。 |
| `web/styles.css` | **[MootingAgent 新增]** | 原型页面的布局、颜色、面板、输入输出双栏、移动端响应式样式和说话人卡片样式。 |
| `web/audio-capture.js` | **[MootingAgent 新增]** | 浏览器麦克风采集器；管理权限、AudioWorklet、WebSocket、检查点、暂停/失败清理，并导出重采样、PCM16 和分包工具。 |
| `web/audio-worklet.js` | **[MootingAgent 新增]** | AudioWorklet 处理器；多声道转单声道、重采样到 16 kHz、3200 样本分包、静音回放、检查点和 flush。 |
| `web/dsh-views.js` | **[DSH 改造/复用，生成]** | 由 Vite 从 DSH 视图源和项目适配入口构建出的自包含浏览器 IIFE；不是 DSH Web shell。 |
| `web/dsh-views.css` | **[DSH 改造/复用，生成]** | DSH 轨迹/聊天组件和主题样式打包产物。 |

### `web/dsh-views-src/`

| 文件 | 标记 | 作用 |
|---|---|---|
| `web/dsh-views-src/index.jsx` | **[DSH 改造/复用]** | 项目适配入口：复用 DSH 的 Timeline、Table、聊天叶组件和 Tool Card，将原始 `SessionEvent` 投影成 DSH 组件所需记录，并实现 Router/Worker 容器排序。 |
| `web/dsh-views-src/views.css` | **[MootingAgent 新增]** | DSH 叶组件在原型容器中的补充样式、Worker 运行卡片和视图布局。 |
| `web/dsh-views-src/.entry.generated.jsx` | **[运行/生成]** | `build-dsh-views.mjs` 将 `__DSH__` 替换为相邻 DSH client 路径后的临时入口。 |
| `web/dsh-views-src/smoke.mjs` | **[MootingAgent 新增]** | 以 fixture 事件启动临时页面，用 Chrome 检查聊天/工具/三轨时间线、展开和时间维度切换。 |
| `web/dsh-views-src/smoke.png` | **[运行/生成]** | DSH 视图 smoke 页面截图，不是完整应用截图。 |
| `web/dsh-views-src/README.md` | **[DSH 改造/复用]** | 精确记录复用了哪些 DSH 组件、项目适配边界、未集成的完整 ChatView 能力和构建验证方式。 |

## `scripts/`：构建、启动和验收

| 文件 | 作用 |
|---|---|
| `scripts/vendor-dsh.mjs` | 从相邻 DSH checkout 解析依赖闭包，复制构建产物/许可证/根包源码，生成 `vendor/manifest.json`，并创建 `node_modules` 链接；不安装依赖、不改 DSH 源码。 |
| `scripts/build-dsh-views.mjs` | 用相邻 DSH 的 Vite/React 构建 `web/dsh-views.js/css`，归档读取到的 DSH source inputs，并生成视图 manifest 与 SHA-256。 |
| `scripts/vendor-ws.mjs` | 从 DSH checkout 复制 `ws` 运行时包到项目 vendor。 |
| `scripts/start.mjs` | 创建隔离 profile 和 profile patch，调用复制的 DSH CLI 启动应用；不会写用户全局 Harness profile。 |
| `scripts/browser-test.mjs` | 启动模型/ASR fixture、DSH profile、Chrome 和 CDP，执行桌面/移动端语音、字幕、Worker、单 Session、轨迹视图和无异常验收，并写入 artifacts。 |

## `vendor/`：DSH 复制物与来源记录

### DSH 原始复制包

以下内容由 `scripts/vendor-dsh.mjs` 复制，属于 **[DSH 原始]**，运行时不应直接修改；具体文件 SHA-256 和源路径见 `vendor/manifest.json`：

- `vendor/node_modules/@deepseek-ai/dsh/`：官方 CLI/Loader 构建包。
- `vendor/node_modules/@deepseek-ai/cordis/`：Cordis 运行时。
- `vendor/node_modules/@deepseek-ai/dsh-agent/`：Agent 注册与 Session Agent API。
- `vendor/node_modules/@deepseek-ai/dsh-agent-loop/`：Agent 循环、工具调用和助手流处理。
- `vendor/node_modules/@deepseek-ai/dsh-session/`：Session 事件存储与生命周期。
- `vendor/node_modules/@deepseek-ai/dsh-system-prompt/`：系统提示词插件。
- `vendor/node_modules/@deepseek-ai/dsh-tools/`：工具注册、schema、调用和结果处理。
- `vendor/node_modules/@deepseek-ai/dsh-tool-executor-native/`：原生工具执行器。
- `vendor/node_modules/@deepseek-ai/dsh-session-projection/`：Session 投影。
- `vendor/node_modules/@deepseek-ai/dsh-llm/`：LLM adapter、消息、流和调用配置。
- 其余依赖包：`dsh-app-boot`、`dsh-cmdline`、`dsh-home-paths`、`dsh-launch-environment`、`dsh-official-bundles`、`dsh-http-proxy`、`dsh-plugin-manager`、`dsh-atomic-write`、`dsh-brand`、`dsh-scope`、`dsh-typert-protocol`、`dsh-util-values`、`dsh-session-persistence`、`dsh-user-approval`、`dsh-util-crypto`、`dsh-timeout`、`dsh-package-manifest`、`dsh-plugin-detail`、`dsh-host-plugin-inventory`、`dsh-subprocess`、`dsh-sandbox-policy`、`dsh-sandbox`，以及 Cordis/Schema 辅助包。

每个 `vendor/node_modules/<包>/` 通常包含 `package.json`、`LICENSE` 和 `lib/`（包括运行时代码、类型声明、source map 或 build info）；这些是构建产物，不逐个重复抄录。若需精确逐文件清单，以 `vendor/manifest.json` 中对应包的 `files[].path` 为准。

### DSH 原始源码归档

`vendor/sources/` 是 vendor 脚本为根包保留的来源平面，标记为 **[DSH 原始]**：

- `vendor/sources/@deepseek-ai/dsh/`：`package.original.json` 和 `src/args.ts`、`bin.ts`、`dump-config-schema.ts`、`dump-config.ts`、`installed-bin.ts`、`plugin.ts`、`process-shutdown.ts`、`profile-boot.ts`、`startup-diagnostics.ts`、`sdk-source.cordis.patch.yml`。
- `vendor/sources/@deepseek-ai/cordis/`：`package.original.json` 和 `src/context.ts`、`events.ts`、`fiber.ts`、`index.ts`、`logger.ts`、`reflect.ts`、`registry.ts`、`service.ts`、`utils.ts`。
- `vendor/sources/@deepseek-ai/dsh-agent/`：`package.original.json` 和 `src/archive-admission.ts`、`consumed-work.ts`、`dispatch.ts`、`index.ts`、`model-selection.ts`、`projection.ts`、`runtime-types.ts`、`types.ts`。
- `vendor/sources/@deepseek-ai/dsh-agent-loop/`：`package.original.json` 和 `src/agent.ts`、`assistant-stream.ts`、`constants.ts`、`inbox.ts`、`index.ts`、`runtime-context.ts`。
- `vendor/sources/@deepseek-ai/dsh-session/`：`package.original.json` 和 `src/fork.ts`、`index.ts`、`known-event-types.ts`、`preparation.ts`、`repair.ts`、`request-header.ts`、`seq-ranges.ts`、`surface.ts`、`tool-history.ts`、`types.ts`。
- `vendor/sources/@deepseek-ai/dsh-system-prompt/`：`package.original.json` 和 `src/index.ts`。
- `vendor/sources/@deepseek-ai/dsh-tools/`：`package.original.json` 和 `src/batch.ts`、`contracts.ts`、`events.ts`、`executor.ts`、`index.ts`、`json-schema.ts`、`pipeline.ts`、`presentation.ts`、`schema.ts`。
- `vendor/sources/@deepseek-ai/dsh-tool-executor-native/`：`package.original.json` 和 `src/index.ts`。
- `vendor/sources/@deepseek-ai/dsh-session-projection/`：`package.original.json` 和 `src/index.ts`、`types.ts`。
- `vendor/sources/@deepseek-ai/dsh-llm/`：`package.original.json` 和 `src/adapter-failure.ts`、`api-key.ts`、`assembler.ts`、`assistant-stream.ts`、`attribution.ts`、`brand.ts`、`call-config.ts`、`content.ts`、`error.ts`、`index.ts`、`message.ts`、`retry-policy.ts`、`types.ts`。
- `vendor/sources/@deepseek-ai/dsh-*` 其余目录：主要保留 `package.original.json`，用于记录非根依赖包的原始 package metadata；不等于项目业务源码。
- `vendor/sources/@deepseek-ai/cordis/package.original.json` 记录 Cordis 包原始 metadata。

### DSH 改造/复用记录

| 文件/目录 | 作用 |
|---|---|
| `vendor/manifest.json` | 来源 checkout、根包、版本、源目录、manifest SHA、依赖和复制文件 SHA-256 的机器可读清单。 |
| `vendor/dsh-views-manifest.json` | 被视图构建读取的 DSH client 文件、来源路径、SHA-256、复用组件和项目适配声明。 |
| `vendor/dsh-views-source/` | 视图构建实际读取的 DSH source inputs 归档；内容仍是 DSH 原始实现，但放置和清单由本项目构建脚本管理。 |
| `vendor/node_modules/ws/` | 从相邻 DSH 复制的 WebSocket 依赖；不是业务新增实现。 |
| `vendor/.DS_Store` | Finder 元数据，删除不影响运行。 |

## `tests/`：测试和 fixture

| 文件 | 作用 |
|---|---|
| `tests/harness.mjs` | 测试专用 Cordis/DSH plugin mounting；允许 mock 或 real model，但应用生产入口仍必须经过 DSH profile。 |
| `tests/modules.test.mjs` | Context 不可变快照、Task Manager 生命周期/取消/容量、工具调用和禁止 mock fallback。 |
| `tests/integration.test.mjs` | Router→Worker→Router、单 Session、字幕持续任务、报告排队和打断语义。 |
| `tests/model-wire.test.mjs` | Responses API 函数调用 round trip、原生 replay、加密 reasoning 保留。 |
| `tests/responses-adapter.test.mjs` | Responses SSE/JSON 事件解析、工具调用、终态、错误、边界和大小限制。 |
| `tests/real-model-flow.test.mjs` | 真实模型配置持久化、路由/Worker 独立 HTTP 请求、密钥保护和切换模型。 |
| `tests/model-env.test.mjs` | `.env` 读写、变量保留、引号处理和文件权限。 |
| `tests/capabilities-live.test.mjs` | 生产能力传递精确 Context/指令/信号，模型错误不变成假成功。 |
| `tests/model-fixture.mjs` | 本地 Responses API fixture，驱动 Router/Worker 流式模型测试。 |
| `tests/mock-router-adapter.mjs` | 测试专用 Router adapter，模拟工具调用和后续回复。 |
| `tests/mock-capabilities.mjs` | 测试专用能力注册器和可控字幕帧。 |
| `tests/fake-sound2text.mjs` | 测试专用 ASR Service 替身，模拟状态、提交和字幕更新。 |
| `tests/sound2text.test.mjs` | 本地 WebSocket ASR 协议、认证头、200 ms PCM 包、修订、边界、静默、超时、暂停和清理。 |
| `tests/asr-fixture.mjs` | 本地 ASR WebSocket fixture 和合成麦克风 WAV。 |
| `tests/audio-capture.test.mjs` | 浏览器音频采集器、权限错误、WebSocket、检查点、暂停和资源回收。 |
| `tests/audio-worklet.test.mjs` | AudioWorklet 重采样、PCM16、分包、flush 和静音输出。 |
| `tests/web.test.mjs` | 前端纯函数、HTML 结构、模型配置、SSE/API 路径、单输入框和 DSH 视图挂载。 |

## `artifacts/`：运行产物

| 文件 | 标记 | 作用 |
|---|---|---|
| `artifacts/browser-report.json` | **[运行/生成]** | 浏览器测试通过标记、测试项目列表、模式、Session 数和任务快照。 |
| `artifacts/mooting-desktop.png` | **[运行/生成]** | 桌面端完整页面截图。 |
| `artifacts/mooting-mobile.png` | **[运行/生成]** | 390 px 窄屏截图，用于响应式验收。 |
| `artifacts/speaker-identification.png` | **[运行/生成]** | 模拟说话人卡片截图。 |
| `artifacts/context-before-asr-fix-1794488939956.json` | **[运行/生成]** | ASR 修复前的调试状态快照，属于历史诊断资料，不是运行必需文件。 |

## `research/`

| 文件 | 标记 | 作用 |
|---|---|---|
| `research/open-memory-systems.md` | **[MootingAgent 新增]** | 对 Mem0、Letta、Graphiti、LangMem、LlamaIndex Memory 等的调研；提出 L0 当前 Context、L1 SQLite 短期状态、L2 可读 Memory 文档、L3 结构化事实、L4 向量索引的分层方向。 |

## DSH 复用边界

1. **复用但未修改 DSH 源码**：`vendor/sources` 和 `vendor/node_modules` 是复制/归档；`vendor-dsh.mjs` 明确从相邻 checkout 读取，不向 DSH 源码树写入。
2. **确实由本项目适配的部分**：`cordis.patch.yml` 的插件组合、`src/*` 业务插件、`web/dsh-views-src/index.jsx` 的事件投影、`web/dsh-views.js/css` 的构建产物、`scripts/build-dsh-views.mjs` 的构建流程。
3. **不是完整 DSH GUI**：原型只复用聊天/轨迹的叶渲染器、时间线、表格和工具卡；没有挂载完整 ChatView、Slots、Workspace、文件导航、附件、分叉或 GUI RPC。
4. **版本与来源核对入口**：先看 `vendor/manifest.json` 的 `sourceCheckout`、包版本和 `files[].sha256`，再看 `vendor/dsh-views-manifest.json` 的 DSH client 文件来源和哈希。
5. **重新生成规则**：需要相邻 checkout 时运行 `npm run vendor`、`npm run build:web`；普通运行只依赖项目已有复制产物。

## 快速运行关系

```text
scripts/start.mjs
  -> vendor/@deepseek-ai/dsh/lib/bin.js
  -> .runtime/profiles/mooting-demo/cordis.patch.yml
  -> cordis.patch.yml
  -> DSH 原始插件 + MootingAgent 新增插件
  -> src/index.mjs
  -> MootingRuntime + 本地 HTTP/SSE + sound2text WebSocket
  -> web/index.html + app.js + DSH 改造视图 bundle
```

## 结论

- **DSH 本身**主要集中在 `vendor/node_modules/@deepseek-ai/*`、`vendor/node_modules/@deepseek-ai/cordis`、`vendor/sources/@deepseek-ai/*` 和 `vendor/dsh-views-source` 的归档内容。
- **由 DSH 改造/复用后的文件**主要是 `cordis.patch.yml`、`vendor/*manifest.json`、`scripts/vendor-dsh.mjs`、`scripts/build-dsh-views.mjs`、`web/dsh-views-src/index.jsx` 以及构建出的 `web/dsh-views.js/css`。
- **MootingAgent 新增**主要是 `src/` 业务后端、`src/sound2text/`、页面和音频采集、测试、启动脚本及研究文档。
- **运行生成物**包括 `.env`、`.runtime/`、`artifacts/`、`.DS_Store`、`.entry.generated.jsx` 和 smoke/浏览器截图报告；它们不应被误认为 DSH 源码或业务源代码。
