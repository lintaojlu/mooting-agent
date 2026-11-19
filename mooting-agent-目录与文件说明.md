# MootingAgent 目录与文件说明

> 生成时间：2026-11-13；Hindsight 记忆相关内容更新：2026-11-19
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
| `.env` | **[运行/生成]** | 本地模型、sound2text 凭证和 Hindsight 的 LLM、embedding、重排、代理配置；被 `.gitignore` 忽略，写入时权限为 `0600`，前端不返回密钥。 |
| `.gitignore` | **[MootingAgent 新增]** | 忽略 `.runtime/`、`node_modules`、`.env` 和日志。 |
| `.DS_Store` | **[运行/生成]** | macOS Finder 元数据，与应用无关，不应纳入项目说明或提交。 |
| `README.md` | **[MootingAgent 新增]** | 启动、模型和 ASR 配置、交互语义、执行路径、测试范围和当前限制。 |
| `package.json` | **[DSH 改造/复用]** | 原型自己的 npm 清单；声明 Node/DSH 版本、vendor/start/build/test 命令及 DSH bundle patch 配置。 |
| `cordis.patch.yml` | **[DSH 改造/复用]** | DSH Loader 的本项目组合配置：插入 DSH 核心插件和 MootingAgent 的 Worker、Models、sound2text、Capabilities、Router 插件。 |
| `node_modules` | **[DSH 改造/复用]** | 指向 `vendor/node_modules` 的符号链接，保证 Node 按项目内复制产物解析依赖。 |
| `.runtime/` | **[运行/生成]** | `src/start.mjs` 生成的隔离 DSH profile、临时模型/ASR 配置、浏览器测试工作目录；不应作为源码使用。 |
| `vendor/` | **[DSH 原始 + DSH 改造/复用]** | 见下文：既包含 DSH 复制产物，也包含来源清单、视图归档和项目构建元数据。 |
| `src/` | **[MootingAgent 新增]** | 后端业务、Context、Router、Worker、任务管理、模型适配、sound2text，以及启动、依赖复制和浏览器验收脚本。 |
| `web/` | **[DSH 改造/复用 + MootingAgent 新增]** | 原型页面、音频采集、DSH 视图适配/构建产物，以及视图构建脚本。 |
| `tests/` | **[MootingAgent 新增]** | 单元、集成、协议、真实模型 fixture、浏览器辅助和前端行为测试。 |
| `artifacts/` | **[运行/生成]** | 浏览器验收截图、报告和调试快照。 |
| `research/` | **[MootingAgent 新增]** | Memory System 调研及 Context 分层选型记录。 |

## `src/`：后端源码

### 根级文件

| 文件 | 作用 |
|---|---|
| [src/index.mjs](<src/index.mjs>) | DSH Loader 入口；校验生产模式，创建一个共享 ContextSystem 和 HindsightBridge，后台启动记忆守护进程，启动 Router/Web，退出时依次停止 Router、强制提交 outbox、停止记忆服务。删除旧 `MEMORY.md`，不导入。 |
| [src/runtime.mjs](<src/runtime.mjs>) | 单 Session Router 运行时；通过 `mooting-memory` 注入本地记忆，ASR 定稿调用 `observe()`，完成的 `turn/end` 调用 `recordTurn()`。注册 `open_speaker`、`close_speaker`、只读 `memory_search` 和后台 `memory_reflect`，复用 Worker 回报唤醒 Router。 |
| [src/user-homes.mjs](<src/user-homes.mjs>) | 各账号独立保存会话日志和工作区；所有账号引用同一个 ContextSystem，长期记忆共用单一 bank。 |
| `src/tasks.mjs` | 输入快照和 Task Manager；把单条指令包装成不可变 Context，管理能力注册、任务状态、AbortSignal、持续显示租约、结果回报和退出清理。 |
| `src/worker-plugin.mjs` | Cordis `mootingWorkers` Service；持有不属于 Router 的 Task Manager 和 Worker 事件总线。 |
| `src/models-plugin.mjs` | Cordis `mootingModels` Service；读取/保存模型配置、注册 DSH LLM adapter、调用独立 Worker 模型，并在公开状态中隐藏密钥。 |
| `src/model-adapters.mjs` | Responses API 适配器；把 DSH 消息转换为 Responses input，解析 SSE/JSON 流、函数调用、推理摘要、终态和同路由 replay。明确不支持 Chat Completions fallback。 |
| `src/model-env.mjs` | `.env` 的安全读写；只替换自有变量、保留其他内容、转义引号、创建目录并强制 `0600`。 |
| `src/capabilities.mjs` | 能力实现与注册：实时字幕、模拟说话人识别，以及 `summarize_context`、`explain_term`、`general_assistant` 三种模型能力；拒绝空结果和隐式模拟回退。 |
| `src/capabilities-plugin.mjs` | Cordis `mootingCapabilities` Service；把真实 Models 和共享 sound2text 注入能力注册。 |
| `src/web-server.mjs` | 仅 loopback 的 HTTP/SSE API 和静态资源服务；提供状态、提交、打断、模型配置、语音交互、字幕帧接口，并挂载音频 WebSocket。 |
| `src/start.mjs` | 创建隔离 profile 和 profile patch，调用复制的 DSH CLI 启动应用；不会写用户全局 Harness profile。 |
| `src/vendor-dsh.mjs` | 从相邻 DSH checkout 解析依赖闭包，复制构建产物/许可证/根包源码，生成 `vendor/manifest.json`，并创建 `node_modules` 链接；不安装依赖、不改 DSH 源码。 |
| `src/vendor-ws.mjs` | 从 DSH checkout 复制 `ws` 运行时包到项目 vendor。 |
| `src/browser-test.mjs` | 启动模型/ASR fixture、DSH profile、Chrome 和 CDP，执行桌面/移动端语音、字幕、Worker、单 Session、轨迹视图和无异常验收，并写入 artifacts。 |

### `src/context/`

| 文件 | 作用 |
|---|---|
| [src/context/index.mjs](<src/context/index.mjs>) | Context 唯一入口；维护最近原话、磁盘 outbox、三份 mental model 缓存、显式记忆和持久墓碑；`recentSpeech()` 只读最近一分钟全部定稿，供 Router user prompt；`compile(..., { includeRecent: false })` 注入档案、事项和人物。控制 Router 空闲时批量写入、异步 operation 完成确认和失败重试，提供只读检索与回想。 |
| [src/context/hindsight.mjs](<src/context/hindsight.mjs>) | HindsightBridge：映射 `.env`、启动/停止固定版本 `hindsight-embed@1.2.1`、初始化 bank/mental model、健康检查、调用超时与取消、操作状态确认。npm `hindsight-all` / `hindsight-client` 同样固定为 `1.2.1`。 |

上游源码在 `vendor/hindsight`（`UPSTREAM.json` 记录提交 `04698b6`），仓库不包含 profile、嵌入式数据库和模型缓存。默认守护进程使用 profile `mooting`、端口 `9077`、bank `mooting`，只监听 `127.0.0.1`；内嵌 Postgres 数据由 Hindsight profile 管理。默认远端 LLM 复用 `MOOTING_CONTEXT_*`，本地 embedding 为 `BAAI/bge-m3`，本地重排为 `hindsight-ai/hs-rerank-1`。首次下载会占用数 GB，允许等待 30 分钟。Python 不读取 macOS 系统代理，必要时设置 `MOOTING_HINDSIGHT_PROXY` 或 `MOOTING_HF_ENDPOINT`；Apple Silicon 默认选择 arm64 Python 3.12，可通过 `MOOTING_HINDSIGHT_PYTHON` 覆盖。完整变量见 [README](<README.md>)。

### `data/`：记忆和账号运行数据

以下均为被 Git 忽略的运行文件；账号只隔离会话和工作区，记忆属于同一个用户。

| 运行路径 | 作用 |
|---|---|
| `data/context-trace.jsonl` | Context 本地执行事件的完整历史：定稿、忙闲、批次、Hindsight 操作状态、缓存、检索与回想；访问走鉴权 API，SSE 只带最近 200 条。 |
| `data/fragments.jsonl` | ASR 定稿原话立即追加到磁盘；RAM 环形缓冲供最近原话读取。 |
| `data/hindsight-outbox.jsonl` | 待写和已提交但未完成的批次、稳定 operation ID；收到异步受理响应后仍保留，确认 `completed` 后才移除。重启后继续确认或重试。 |
| `data/memory-cache.json` | 用户档案、人物关系表、进行中事项，每 60 秒拉取；也持久化显式记忆和待执行墓碑，离线删除在服务恢复后先于 retain 重放。 |
| `data/<账号>/session.jsonl`、`data/<账号>/workspace.json` | 各测试账号独立的会话事件和工作区。 |
| `data/MEMORY.md`、`data/<账号>/MEMORY.md` | 已停用，启动时删除，不导入 Hindsight。 |

「记住」「忘掉」「不对，……」等命令使用固定中文句式识别。更正以主语级屏蔽避免旧缓存与新事实矛盾，可能隐藏同一人物的其他有效信息。删除按文本匹配来源文档，当前会删除整份文档，可能连同相邻事实一起删除；任意语义改写的删除不作保证。

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
| `web/index.html` | **[MootingAgent 新增]** | 页面骨架：输出面板、控制面板→信息流→Router（右侧栈）、整行 Context（最近原话、注入 Router 的记忆）、独立 Context System Trace、原有 Agent Trace 和 DSH 视图。 |
| [web/app.js](<web/app.js>) | **[MootingAgent 新增]** | 前端状态/SSE、语音按钮及 DSH 视图协调；把 Context 事件历史与实时窗口合并，以可展开的表格呈现执行阶段和原始数据，保留 Agent Trace 独立视图。 |
| `web/styles.css` | **[MootingAgent 新增]** | 原型页面的布局、颜色、面板、输入输出双栏、移动端响应式样式和说话人卡片样式。 |
| `web/audio-capture.js` | **[MootingAgent 新增]** | 浏览器麦克风采集器；管理权限、AudioWorklet、WebSocket、检查点、暂停/失败清理，并导出重采样、PCM16 和分包工具。 |
| `web/audio-worklet.js` | **[MootingAgent 新增]** | AudioWorklet 处理器；多声道转单声道、重采样到 16 kHz、3200 样本分包、静音回放、检查点和 flush。 |
| `web/dsh-views.js` | **[DSH 改造/复用，生成]** | 由 Vite 从 DSH 视图源和项目适配入口构建出的自包含浏览器 IIFE；不是 DSH Web shell。 |
| `web/dsh-views.css` | **[DSH 改造/复用，生成]** | DSH 轨迹/聊天组件和主题样式打包产物。 |
| `web/build-dsh-views.mjs` | **[DSH 改造/复用]** | 用相邻 DSH 的 Vite/React 构建 `web/dsh-views.js/css`，归档读取到的 DSH source inputs，并生成视图 manifest 与 SHA-256。 |

### `web/dsh-views-src/`

| 文件 | 标记 | 作用 |
|---|---|---|
| `web/dsh-views-src/index.jsx` | **[DSH 改造/复用]** | 项目适配入口：复用 DSH 的 Timeline、Table、聊天叶组件和 Tool Card，将原始 `SessionEvent` 投影成 DSH 组件所需记录，并实现 Router/Worker 容器排序。 |
| `web/dsh-views-src/views.css` | **[MootingAgent 新增]** | DSH 叶组件在原型容器中的补充样式、Worker 运行卡片和视图布局。 |
| `web/dsh-views-src/.entry.generated.jsx` | **[运行/生成]** | `web/build-dsh-views.mjs` 将 `__DSH__` 替换为相邻 DSH client 路径后的临时入口。 |
| `web/dsh-views-src/smoke.mjs` | **[MootingAgent 新增]** | 以 fixture 事件启动临时页面，用 Chrome 检查聊天/工具/三轨时间线、展开和时间维度切换。 |
| `web/dsh-views-src/smoke.png` | **[运行/生成]** | DSH 视图 smoke 页面截图，不是完整应用截图。 |
| `web/dsh-views-src/README.md` | **[DSH 改造/复用]** | 精确记录复用了哪些 DSH 组件、项目适配边界、未集成的完整 ChatView 能力和构建验证方式。 |

## `vendor/`：DSH 复制物与来源记录

### 运行内核 **[内核]**

`npm start` 实际加载的是 `vendor/node_modules` 里下面这些包的可执行编译结果（入口 `lib/*.js` / `dist` 主文件，以及本机 `darwin-arm64` 的 `.node`）。判定方式：从 `src/start.mjs` 拉起的 `dsh/lib/bin.js` → `profile-boot.js`，加上 `cordis.patch.yml` 插入的 8 个插件和 `src/sound2text` 引用的 `ws`，只沿启动会执行的 import 走。`dsh plugin`、`--dump-config` 这两条 CLI 分支不算内核。

- **加载器**：`@deepseek-ai/dsh`、`dsh-app-boot`、`dsh-home-paths`、`dsh-launch-environment`、`dsh-cmdline`、`dsh-http-proxy`、`dsh-atomic-write`、`dsh-official-bundles`、`dsh-brand`、`commander`、`js-yaml`、`semver`、`resolve.exports`
- **Cordis**：`@deepseek-ai/cordis`、`cordis-plugin-loader`、`cordis-plugin-group`、`cordis-plugin-include`、`cosmokit`、`schemastery`
- **本机原生模块**：`node-addon-require-builtin`、`node-addon-native-custom-loader`、`node-addon-require-builtin-darwin-arm64`
- **patch 插件及其直接运行时依赖**：`dsh-session`、`dsh-session-persistence`、`dsh-session-projection`、`dsh-llm`、`dsh-system-prompt`、`dsh-tools`、`dsh-tool-executor-native`、`dsh-agent`、`dsh-agent-loop`、`dsh-scope`、`dsh-timeout`、`dsh-typert-protocol`、`dsh-util-crypto`、`dsh-util-values`、`zod`
- **语音**：`ws`
- **记忆（第三方运行依赖）**：`@vectorize-io/hindsight-all@1.2.1` 和 `@vectorize-io/hindsight-client@1.2.1`，分别管理 Python 守护进程和访问 HTTP API；不属于 DSH 原始包。

同一批内核包里，下面这些文件已经被编译进包，但启动不读：`lib/types/**`、`*.d.ts`、`*.map`、`*.tsbuildinfo`、`locale/**`，以及 `@deepseek-ai/dsh/lib/plugin-*.js` 和 `dump-config-*.js`。

### 与 MootingAgent 运行无关 **[无关]**

这些包在 `vendor/node_modules` 里，`npm start` 不会 import。它们是 DSH CLI 的插件安装、配置 schema 导出、沙箱或子进程工具链，或这些工具链的第三方依赖。

- **CLI 插件管理 / 子进程**：`dsh-plugin-manager`、`dsh-subprocess`、`dsh-package-manifest`、`dsh-plugin-detail`、`dsh-host-plugin-inventory`、`execa`、`get-stream`、`human-signals`、`npm-run-path`、`signal-exit`、`strip-final-newline`、`@sindresorhus/merge-streams`、`figures`、`is-plain-obj`、`is-stream`、`is-unicode-supported`、`parse-ms`、`path-key`、`pretty-ms`、`unicorn-magic`、`which-command`、`yoctocolors`
- **配置 schema 导出才动态 import**：`ajv`、`fast-uri`、`fast-deep-equal`、`json-schema-traverse`、`@eslint-community/regexpp`
- **沙箱与审批**：`dsh-sandbox`、`dsh-sandbox-policy`、`dsh-user-approval`
- **其余未引用第三方包**：`undici`、`yaml`、`argparse`、`hosted-git-info`、`lru-cache`、`require-from-string`、`@sec-ant/readable-stream`、`@standard-schema/spec`
- **另一平台的原生模块**：`node-addon-require-builtin-linux-x64-gnu/`（当前机器是 darwin-arm64）
- **来源归档，进程不加载**：整个 `vendor/sources/`（TypeScript 与原始 `package.json`）、整个 `vendor/dsh-views-source/`、`vendor/dsh-views-manifest.json`。页面用的是已经打好的 `web/dsh-views.js` 和 `web/dsh-views.css`。`vendor/manifest.json` 只是复制清单。

### 临时文件 **[临时]**

- `vendor/.DS_Store`
- `vendor/dsh-views-source/` 下的 `.DS_Store`
- 各包里的 `*.tsbuildinfo`（TypeScript 增量编译缓存，共 37 个，约 2.0 MiB）

仓库里没有残留的 `*.tmp`。原子写使用的 `.tmp` 是运行时在 profile 目录生成的，不在 `vendor/` 中。

### 编译文件 **[编译]**

`vendor/node_modules` 几乎全是编译结果，不是 MootingAgent 源码。可执行部分是内核包的 `.js` / `.cjs` / `.mjs` 和 `darwin-arm64` 的 `.node`。其余编译副产品运行时不需要：

| 种类 | 大约规模 | 说明 |
|---|---|---|
| `*.map` | 528 个，4.1 MiB | source map |
| `*.d.ts` | 622 个，2.0 MiB | 类型声明 |
| `*.tsbuildinfo` | 37 个，2.0 MiB | 增量编译缓存，同时属于临时文件 |
| `lib/types/**/*.js` | 180 个，1.4 MiB | 随声明发出的类型桩 |
| 内核包内的 `*.ts` / `*.cts` | 与 zod 等包一起复制 | 编译前源码副本，Node 不执行 |

### DSH 原始复制包

以下内容由 `src/vendor-dsh.mjs` 复制，属于 **[DSH 原始]**，运行时不应直接修改；具体文件 SHA-256 和源路径见 `vendor/manifest.json`：

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
- 内核里的启动与 Cordis 辅助包见上一节。`dsh-plugin-manager`、`dsh-subprocess`、`dsh-user-approval`、`dsh-package-manifest`、`dsh-plugin-detail`、`dsh-host-plugin-inventory`、`dsh-sandbox-policy`、`dsh-sandbox` 也在这个目录里，但属于 **[无关]**，启动不加载。

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
| [tests/context.test.mjs](<tests/context.test.mjs>) | 离线验证最近原话、热路径预算、flush 条件、Router 空闲约束、持久化和重放、显式记忆与墓碑，以及 Router 回写语义。 |
| [tests/hindsight-bridge.test.mjs](<tests/hindsight-bridge.test.mjs>) | 使用实际 Hindsight npm SDK 和本地 HTTP fixture 验证超时、取消、连接错误分类、状态码和远端重排配置映射。 |
| [tests/memory-live.test.mjs](<tests/memory-live.test.mjs>) | 连接真实 Hindsight 和 `.env` 中的真实 LLM，验证 retain/recall、mental model、离线恢复及后台 reflect。profile `mooting-test`、端口 `9078`、每次独立 bank，结束时清理；缺 LLM 配置时明确跳过，不算通过。 |
| [tests/context-reliability.test.mjs](<tests/context-reliability.test.mjs>) | 删除/纠正持久化、落盘失败、异步任务确认、封批触发和暂停尾句的回归。 |
| [tests/memory-panel-browser.mjs](<tests/memory-panel-browser.mjs>) | 独立 Chrome + Loader 检查缓存注入、记忆状态与窄屏实际可见性，使用临时数据目录。 |
| [tests/memory-soak.mjs](<tests/memory-soak.mjs>) | 一小时合成 ASR 持续流，真实 Router/Context LLM 与本地模型，记录首包、积压、缓存生成和热路径 P95。 |
| [tests/memory-recall-check.mjs](<tests/memory-recall-check.mjs>) | 六位合成人物的姓名/别名召回样本，生成命中率报告。 |
| [tests/memory-router-latency.mjs](<tests/memory-router-latency.mjs>) | 两个等轮数 Router Session 交替对照记忆注入的首包开销。 |
| [tests/hindsight-live.mjs](<tests/hindsight-live.mjs>) | 真实记忆测试的共享配置和预热入口，下载 Python 环境及本地模型。 |
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

记忆 live 测试调用真实付费 LLM，实际成本和耗时随模型、重试和 CPU 吞吐变化。测试文件的覆盖目标不代表验收已通过；一小时连续语音的 outbox 吞吐、Router 首包时延对比与中文专名召回率仍需单独验收。

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
| [research/hindsight-记忆集成计划.md](<research/hindsight-记忆集成计划.md>) | **[MootingAgent 新增]** | Hindsight 集成的设计决定、存取规则、改动顺序、测试目标与验收条件。 |
| [research/记忆底座选型对比.md](<research/记忆底座选型对比.md>) | **[MootingAgent 新增]** | 记忆底座选型背景和方案比较。 |
| `research/open-memory-systems.md` | **[MootingAgent 新增]** | 对 Mem0、Letta、Graphiti、LangMem、LlamaIndex Memory 等的调研；提出 L0 当前 Context、L1 SQLite 短期状态、L2 可读 Memory 文档、L3 结构化事实、L4 向量索引的分层方向。 |

## DSH 复用边界

1. **复用但未修改 DSH 源码**：`vendor/sources` 和 `vendor/node_modules` 是复制/归档；`vendor-dsh.mjs` 明确从相邻 checkout 读取，不向 DSH 源码树写入。
2. **确实由本项目适配的部分**：`cordis.patch.yml` 的插件组合、`src/*` 业务插件、`web/dsh-views-src/index.jsx` 的事件投影、`web/dsh-views.js/css` 的构建产物、`web/build-dsh-views.mjs` 的构建流程。
3. **不是完整 DSH GUI**：原型只复用聊天/轨迹的叶渲染器、时间线、表格和工具卡；没有挂载完整 ChatView、Slots、Workspace、文件导航、附件、分叉或 GUI RPC。
4. **版本与来源核对入口**：先看 `vendor/manifest.json` 的 `sourceCheckout`、包版本和 `files[].sha256`，再看 `vendor/dsh-views-manifest.json` 的 DSH client 文件来源和哈希。
5. **重新生成规则**：需要相邻 checkout 时运行 `npm run vendor`、`npm run build:web`；普通运行只依赖项目已有复制产物。

## 快速运行关系

```text
src/start.mjs
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
- **由 DSH 改造/复用后的文件**主要是 `cordis.patch.yml`、`vendor/*manifest.json`、`src/vendor-dsh.mjs`、`web/build-dsh-views.mjs`、`web/dsh-views-src/index.jsx` 以及构建出的 `web/dsh-views.js/css`。
- **MootingAgent 新增**主要是 `src/` 业务后端、`src/context/`、`src/sound2text/`、页面和音频采集、测试、启动脚本及研究文档。
- **运行生成物**包括 `.env`、`.runtime/`、`artifacts/`、`.DS_Store`、`.entry.generated.jsx` 和 smoke/浏览器截图报告；它们不应被误认为 DSH 源码或业务源代码。
