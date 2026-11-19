# Hindsight 记忆集成计划

日期：2026-11-19。依据是本轮逐项对齐的设计决定，以及本地克隆的 Hindsight（`../hindsight`，`main` 分支，提交 `04698b6`）里的文档。选型背景见 `research/记忆底座选型对比.md`。

## 1. 目标与范围

把 Context System 的长期记忆换成 Hindsight，实现记忆自动存取：

- 语音定稿和 Router 对话自动写入，抽取、合并、整理全部在后台完成。
- Router 每轮自动带上用户档案、身边人物、进行中事项和最近原话，热路径不发网络请求、不调模型。
- Router 需要更深的记忆时，自己调用工具去查。

**本期不做：** 首次启动问答、声纹、外接 Postgres 加 `pgroonga`。

**使用前提：** 只有一个用户，在本机使用。现在的多账号页面只用于测试，所有账号共用同一个 bank，不做隔离。这个用户的记忆里也要记录身边的人，比如姓名、职业、与用户的关系。

## 2. 已定决定

| 编号 | 决定 |
|---|---|
| Q1 / Q20 | Hindsight 完全替换按整份文档重写的旧 `MEMORY.md` 逻辑。旧 `MEMORY.md` 直接删除，不导入；`fragments.jsonl` 保留，作为最近原话的来源 |
| Q2 | 每轮不做 `recall`，只注入本地缓存和最近原话 |
| Q3 | 用 `@vectorize-io/hindsight-all` 让 MootingAgent 启动时自动拉起 `hindsight-embed`（带嵌入式 Postgres，只监听 `127.0.0.1`），退出时自动停止。profile 用 `mooting`，端口 `9077`，版本固定 |
| Q4 | LLM 配置写在 `.env`，默认复用 `MOOTING_CONTEXT_*` |
| Q5 | 只有一个 bank，名为 `mooting` |
| Q6 | 文本流的说话人一律标为「未确认」，以后再接声纹 |
| Q7 | Router 每轮在 `turn/end` 时异步写入；被打断的那一轮不写 |
| Q8 | Hindsight 离线时静默降级，面板显示状态 |
| Q9' / Q14 / Q15 | 只有 LLM 走远端。embedding 用本地 `BAAI/bge-m3`，重排用本地 `hindsight-ai/hs-rerank-1`；预留远端配置，留空就用本地 |
| Q10 | 先用嵌入式 Postgres 自带的关键词检索，接受它切不开中文 |
| Q12 | 身边的人放进一份「人物关系表」mental model，附带结构化输出 |
| Q13 | 固定三份 mental model：用户档案、人物关系表、进行中事项 |
| Q16' | 写入 Hindsight 要满足两点：Router 空闲，且攒够数量、静默或语音暂停中任一条件成立；进程退出时强制写入 |
| Q17 | 本地缓存每 60 秒拉取一次，持久化到磁盘 |
| Q18 | Router 有两个只读工具：`memory_search` 和 `memory_reflect` |
| Q19 | 注入 Router 的记忆按节设上限，见第 5.2 节 |
| Q21' | 测试连接真实 Hindsight，使用单独的 profile 和端口，跑完清理测试数据 |

**待确认：Q22。** `memory_reflect` 推荐放到后台执行，复用 Worker 的回报机制，超时 60 秒。本文按这个推荐写；如果改成同步执行，只需要改第 5.3 节和第 7 节第 5 步。

## 3. 架构

```text
ASR 定稿 ──► ContextSystem.observe()
              ├─ 最近原话：RAM 环形缓冲 + data/fragments.jsonl     立即可读
              └─ outbox：data/hindsight-outbox.jsonl
                    └─ flush（Router 空闲，且满足任一触发条件）
                         └─ retain(async, append) ─► hindsight-embed
                                                       ├─ 抽取事实、实体解析、embedding
                                                       ├─ 后台合并 observation
                                                       └─ 刷新 mental model（delta）

Router turn/end ──► recordTurn() ──► outbox ──► retain(async)

每 60 秒 ──► 拉取三份 mental model ──► data/memory-cache.json + RAM

提交指令 ──► compile()：本地缓存 + 最近原话 ──► systemPrompt 'mooting-memory' ──► Router
Router ──► memory_search（同步）/ memory_reflect（后台，回报 Router）
```

各部分的职责：

- **`ContextSystem`**（`src/context/index.mjs`）：对外唯一入口，负责本地最近原话、outbox、本地缓存和拼装注入内容。
- **`HindsightBridge`**（新增 `src/context/hindsight.mjs`）：负责守护进程的启动和停止、客户端调用、超时、重试、outbox 重放，以及 bank 和 mental model 的初始化。
- **`runtime.mjs`**：只在现有挂点上调用上面两者，不直接调用 Hindsight。

## 4. 部署与配置

### 4.1 守护进程

- **依赖**：新增 `@vectorize-io/hindsight-all` 和 `@vectorize-io/hindsight-client`。本机需要有 `uv` / `uvx`，当前机器已装 `uv 0.9.9`。
- **启动**：在 `src/index.mjs` 启动时调用 `HindsightServer.start()`，通过 `ctx.effect` 在退出时调用 `stop()`。参数为 `profile: 'mooting'`、`port: 9077`、固定的 `embedVersion`。
- **首次启动**：会下载 Python 环境（每个版本约 1.5 GB 的 `uv` 缓存），以及 `bge-m3`（约 2.2 GB）和 `hs-rerank-1`。`readyTimeoutMs` 要相应放大，期间面板显示「记忆服务启动中」。
- **macOS**：`hindsight-all` 默认让 embedding 和重排跑在 CPU 上，保留这个默认。

### 4.2 `.env`

| 变量 | 默认 | 映射到守护进程 |
|---|---|---|
| `MOOTING_HINDSIGHT_ENABLED` | `1` | — |
| `MOOTING_HINDSIGHT_PORT` | `9077` | daemon port |
| `MOOTING_HINDSIGHT_LLM_BASE_URL` / `_MODEL` / `_API_KEY` | 回落到 `MOOTING_CONTEXT_*` | `HINDSIGHT_API_LLM_PROVIDER=openai`、`HINDSIGHT_API_LLM_BASE_URL`、`_MODEL`、`_API_KEY` |
| `MOOTING_EMBEDDING_BASE_URL` / `_MODEL` / `_API_KEY` / `_DIMENSIONS` | 留空即本地 | 留空：`HINDSIGHT_API_EMBEDDINGS_PROVIDER=local`、`HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL=BAAI/bge-m3`；填上：`provider=openai` 和 `HINDSIGHT_API_EMBEDDINGS_OPENAI_*` |
| `MOOTING_RERANKER_*` | 留空即本地 | 留空：`HINDSIGHT_API_RERANKER_PROVIDER=local`（`hs-rerank-1`）；填上则按对应服务映射 |
| — | 固定 | `HINDSIGHT_API_LLM_OUTPUT_LANGUAGE` 设为中文 |

- **LLM 未配置**：不启动 Hindsight，面板显示「记忆未配置」，只保留最近原话。
- **embedding 维度**：第一次写入后就固定了。以后换模型或换维度，要把全部记忆重新算一遍 embedding，这件事在 README 里写明。

### 4.3 bank 初始化（启动时，可重复执行）

- **bank**：创建 `mooting`。`retain_mission` 用中文写：「保留用户本人及其身边人物的姓名、职业、关系、偏好、约定、待办、决定及原因；忽略寒暄、口令、识别噪声。」
- **mental model**：创建三份，已存在就跳过。三份共用的设置是 `trigger.mode: "delta"`、`refresh_after_consolidation: true`、`min_refresh_interval_seconds: 600`。

| id | source_query | 结构化输出 |
|---|---|---|
| `user-profile` | 用户是谁：身份、职业、所在地、偏好、习惯、表达方式 | 无 |
| `people` | 用户身边的人：姓名、别名、职业、与用户的关系、近况 | `response_schema`：`[{name, aliases[], occupation, relation, recent}]` |
| `open-items` | 进行中的事项、约定、待办、未结束的话题和最近的决定 | 无 |

## 5. 存取规则

### 5.1 写入

| 时机 | 内容 | 调用 |
|---|---|---|
| 每条 ASR 定稿（`definite === true`） | 原话、`start_time`、时间 | 立即写入 RAM 和 `fragments.jsonl`，同时进 outbox |
| outbox flush | 这一批定稿，拼成带时间戳的段落 | `retain('mooting', text, { documentId: 'stream-<YYYY-MM-DD>', updateMode: 'append', async: true, timestamp, context: '现场对话，说话人未确认' })` |
| Router `turn/end` | 这一轮 `user/message` 的指令原文和 `assistant/message` 的回复；Worker 回报唤醒的那一轮写回报摘要 | 进 outbox，flush 时调用 `retain(..., { documentId: 'turn-<inputId>', async: true, context: 'MootingAgent 助手与用户对话' })` |
| 用户明说「记住……」 | 原话 | 立即写入本地缓存的显式记忆，同时同步 `retain`（`async: false`），并打上 `explicit` 标签 |
| 用户说「忘掉……」或纠正事实 | 墓碑或纠正后的事实 | 本地缓存立即过滤；Hindsight 侧删除对应文档，或写入纠正后的事实 |

**flush 规则：**

- 触发条件，任一成立即可：攒够 20 句或 2000 字、静默 60 秒、语音暂停或停止。
- 前提是 Router 空闲。Router 在跑时只把内容记进 outbox；这一轮一结束，如果有内容在等，就立即 flush。
- 进程退出前强制 flush，不等 Router。
- 写入成功后从 outbox 删掉。失败就保留，下次 flush 或服务恢复后重放；用同一个 `document_id` 重放不会产生重复记忆。

**不写入的内容：**

- 临时 ASR。
- 注入给 Router 的记忆本身。指令原文是 `input.instruction`，记忆是经由 `systemPrompt.context` 注入的，所以天然不会回写进 Hindsight。
- 工具的原始输出、字幕全文。
- 被打断、没有完整回复的那一轮。

### 5.2 每轮注入（热路径，不发网络请求、不调模型）

`compile(command)` 只读 RAM，输出四节，注入到现有的 `systemPrompt.context('mooting-memory')`：

| 节 | 来源 | 上限 |
|---|---|---|
| 用户档案 | 缓存的 `user-profile` | 500 字 |
| 进行中事项 | 缓存的 `open-items` | 500 字 |
| 相关人物 | `people` 的结构化输出，用姓名和别名去匹配指令和最近原话 | 最多 3 人，每人 150 字 |
| 最近原话 | RAM 环形缓冲 | 最近 10 分钟，最多 30 句、1500 字 |

- **标注**：每节都写上更新时间，并告诉 Router「记忆可能滞后，以最近原话为准；没有的细节用 `memory_search` 去查」。
- **过滤**：显式记忆和墓碑在拼装时生效。
- **本地缓存的刷新**：每 60 秒拉取三份 mental model，写入 `data/memory-cache.json`。重启后先读这个文件，不用等 Hindsight 启动完成。

### 5.3 按需工具（只读）

| 工具 | 调用 | 执行方式 | 用途 |
|---|---|---|---|
| `memory_search` | `recall('mooting', query, { budget: 'mid', maxTokens: 2048 })` | 同步，3 秒超时，超时返回空结果并附说明 | 查具体事实、原话、时间 |
| `memory_reflect` | `reflect('mooting', query, { budget: 'mid' })` | Q22 待确认，推荐在后台执行：先返回「已受理」，完成后经 Worker 回报队列唤醒 Router；60 秒超时 | 需要综合很多条记忆的问题，或「为什么」「总结一下」这类问题 |

Router 不提供任何写记忆的工具；写入只由 Context 根据第 5.1 节的规则自动完成。

## 6. 降级

| 状态 | 表现 |
|---|---|
| LLM 未配置 | 不启动守护进程；面板显示「记忆未配置」；只注入最近原话 |
| 启动中或首次下载 | 读取磁盘上的缓存；outbox 正常积累 |
| 守护进程离线 | 面板显示「记忆服务离线」；只注入本地缓存和最近原话；`memory_search` 和 `memory_reflect` 返回不可用；outbox 落盘，服务恢复后重放 |
| retain 失败 | 内容留在 outbox，按退避重试；面板显示积压条数 |

## 7. 改动清单与顺序

1. **配置与守护进程**：新增 `src/context/hindsight.mjs`，负责读取 `.env`、映射 `HINDSIGHT_API_*`、启动和停止 `HindsightServer`、初始化 bank 和 mental model。`src/index.mjs` 在启动时创建它，退出时释放。`package.json` 增加两个依赖。
2. **重写 `ContextSystem`**（`src/context/index.mjs`）：
   - 删除 `consolidate()`、`SYSTEM` 提示词和 `MEMORY.md` 读写，删除 `data/MEMORY.md` 和 `data/<user>/MEMORY.md`。
   - `observe()` 只写最近原话和 outbox。
   - 新增 `flush()`、`recordTurn()`、`compile()`、`search()`、`reflect()`、`refreshCache()`。
   - `state()` 增加记忆服务状态、outbox 积压和缓存更新时间。
3. **单例**：`src/user-homes.mjs` 不再为每个账号单独创建 `ContextSystem`，所有账号共用一个实例。`session.jsonl` 和 `workspace.json` 仍按账号存放。
4. **挂到 `runtime.mjs` 的现有位置**：
   - 约第 208 行，`heard` 回调继续调用 `context.observe()`。
   - 约第 245 行，`admit()` 里的 `context.read()` 改为 `context.compile(command)`。
   - 约第 171–180 行，`mooting-memory` 改为输出第 5.2 节的四节。
   - 约第 140–151 行，在 `session/event` 里收集本轮的 `user/message` 和 `assistant/message`，在 `turn/end` 时调用 `context.recordTurn()`，被打断的那一轮跳过。
   - 根据 Router 是否空闲（`busy` 和 `activePromise`），通知 Context 能否 flush。
5. **工具**：在 Router 的 `setup` 里注册 `memory_search` 和 `memory_reflect`。`memory_reflect` 的后台执行和回报复用 `src/tasks.mjs` 现有的 Worker 回报队列。
6. **面板**：Context 面板显示记忆服务状态、outbox 积压、三份 mental model 的更新时间，以及最近一次 flush。
7. **README**：更新 Context 一节、`.env` 说明、首次启动要下载的内容和磁盘占用，以及测试会调用真实 LLM 这一点。

## 8. 测试

- **方式**：直接连接真实 Hindsight，不用模拟客户端。测试用 profile `mooting-test`、端口 `9078`，bank 名带上本次运行编号，跑完删除，不碰正式数据。
- **未配置 LLM 时**：记忆测试明确显示为跳过，不算通过。
- **覆盖的场景**：
  1. 定稿写入后，最近原话立即可读，不等 Hindsight。
  2. 四个 flush 条件分别能触发；Router 在跑时不写，结束后补写；进程退出时强制写。
  3. 用同一个 `document_id` 追加内容不会产生重复记忆；把守护进程停掉再启动，outbox 能重放成功。
  4. `turn/end` 时写入这一轮；被打断的那一轮不写；Worker 回报唤醒的那一轮也写。
  5. mental model 刷新后，本地缓存能拉到；注入内容符合第 5.2 节的上限；人物按姓名命中。
  6. 显式记忆和墓碑立即生效。
  7. `memory_search` 能查到已写入的事实，并在超时时降级；`memory_reflect` 完成后能回报 Router。
  8. 真的停掉守护进程，验证离线降级。
- **README 同步**：「测试不调用收费 API」改为「记忆测试调用真实 LLM」，并说明大致成本和耗时。

## 9. 验收

- **热路径**：`compile()` 不发网络请求、不调模型，P95 ≤ 10 ms。
- **最近原话**：定稿后到能读到，P95 ≤ 100 ms。
- **持续文本流**：一小时连续语音下，Router 的首包时延和没接 Hindsight 时相比，没有明显变差；outbox 不会一直积压下去。
- **中文效果**：中文人物、关系和约定能出现在 `people` 和 `open-items` 里；`memory_search` 能找回具体事实。专名的召回率单独记录，作为是否升级到 `pgroonga` 的依据。
- **删除**：被删除或纠正的事实，不会再出现在注入内容和工具结果里。

## 10. 风险与待测

- **中文关键词检索不可用**：嵌入式 Postgres 切不开中文，专名可能漏召回，靠语义和实体图检索补偿。
- **bge-m3 在 CPU 上较慢**：写入是后台批量的，但要测一小时连续语音下 outbox 会不会持续积压。
- **mental model 有滞后**：最多滞后 10 分钟，加上整理本身的耗时。这段时间的内容由最近原话补上，`min_refresh_interval_seconds` 要根据实际情况调整。
- **磁盘和首次启动**：`uv` 缓存约 1.5 GB/版本，加上本地模型，首次启动耗时较长。
- **说话人未确认**：旁人说的「我」可能被记到用户身上。声纹上线前，靠 `retain_mission` 和「未确认」标注降低风险。
- **多账号测试页面**：所有账号的记忆会混在同一个 bank 里，这是有意接受的。
