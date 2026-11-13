# 开源 Memory System 调研与 MootingAgent 选型

> 调研目标：本地部署；接收持续信息流；理解、压缩、摘要并形成长期记忆；按内存/Memory 文档/SQL/Embedding 向量分层保存；支持高效分层检索；作为 MootingAgent 的 Context System 底座。
>
> 资料以项目官方文档、官方 GitHub 仓库和 API 文档为准，访问时间：2026-11-12。

## 最新需求修订：眼镜交互，检索时延优先（2026-11-13）

**本节取代下文基于“轻量部署优先”的原始排序。** 本地存储复杂度及后台 LLM 消耗不是主要限制；后台有闲置算力用于理解、压缩、合并、总结和索引维护。核心约束改为眼镜交互的检索时延、尾延迟和新信息可见性。

### 修订结论

不再直接推荐“Mem0 优先”或“Cognee 优先”。推荐采用 **异步记忆整理引擎 + 独立低延迟 serving 层**，优先验证 **Hindsight**，并用 **EverMemOS** 作为另一条对照路线。这个优先级依据功能适配性，不是已经实测的速度排名。

- **Hindsight**：官方当前 README 明确描述后台 consolidation、带证据的 observations、后台更新的 mental models/pages。mental model 读取为数据库读取，不需要检索或 LLM 调用；pages 可以投影为 Markdown。后端为 PostgreSQL + pgvector，支持本地模型，因而更接近原始 SQL/向量/文档需求。将其作为后台整理及深度召回引擎，并把活跃页面、人物卡和当前任务预装到 RAM。来源：[官方 README](https://github.com/vectorize-io/hindsight)。完整 recall 还包含四路召回、RRF 和 cross-encoder，不能据此保证毫秒级尾延迟。
- **EverMemOS**：官方明确将 construction 与 retrieval 分离；lightweight 模式跳过 LLM，提供 embedding + BM25 + RRF，而 agentic 模式用 LLM 多轮检索。符合慢写快读，但该版本主数据在 MongoDB，不是 SQL，另用 Elasticsearch、Milvus、Redis。若 SQL 是硬约束，需要额外适配或另选。来源：[官方项目](https://github.com/EverMind-AI/EverMemOS)；此前引用的 lipps 仓库不应代替上游最新版核验。
- **Cognee**：仍是强后台组织候选，但不能默认将普通 recall 当作无 LLM 检索。官方说明默认 HYBRID_COMPLETION 包含生成调用；需固定检索策略，必要时使用 only_context，并确认实际执行路径，才能进入眼镜热路径。来源：[recall 与 search 区别](https://github.com/topoteretes/cognee/blob/main/docs/recall-vs-search.md)。
- **Mem0**：可继续作为对照基线；关闭 LLM rerank 等额外推理环节后测量。后台成本约束放宽后，它的简单 API 不再足以构成首选理由。

### 两条平面而不是四次串行读取

四层应是同一记忆的不同表示，不应实现为 RAM → 文档 → SQL → 向量的串行等待链。

```text
信息流 → 原始事件持久化 → 最近事件/工作记忆立即可读
                    └→ 后台整理：抽取、冲突处理、摘要、合并、索引
                         └→ SQL事实/版本 + 文档/页面 + 向量 + 可选图谱
                              └→ 发布版本化 serving 快照

眼镜输入 → RAM 活跃场景包/人物卡/最近事件 → 第一批可用证据
                    └→ 并行关键词/结构化/向量召回 → deadline 内补充
                    └→ 深度关系查询/反思 → 非阻塞后续结果
```

### 热路径约束

1. 不阻塞等待生成式 LLM 的 query rewrite、摘要、Text-to-SQL、Text-to-Cypher 或多轮 agentic retrieval。小型 embedding 可在线常驻；cross-encoder 只有实测达标才使用。
2. 人物卡、最近讨论、当前任务、用户偏好在后台预计算；上下文事件触发预取，尽可能在用户发问前准备好。
3. 流式 ASR 可触发节流后的推测预取，但临时文本不得作为最终事实写入长期记忆；按 transcript revision、speaker、scene、请求 epoch 丢弃过期结果。
4. 多路检索有统一 deadline 和取消机制；慢分支不能阻塞快分支。精确证据返回即可开始回答，缺失信息明确表述，不得以过期资料冒充当前事实。
5. 最近事件是独立可读覆盖层：后台整理尚未完成时，用户仍能查询刚说过的话。监测 ingest-to-visible lag，而不只是检索耗时。
6. 删除、纠正和权限更新必须即时作用于 RAM/索引读取；缓存 key 带 scope、memory version，使用失效标记防止旧事实重新出现。
7. 整理与检索分进程/队列并设优先级。后台 LLM、embedding 批量任务、向量建索引和数据库写入可能争用 GPU/CPU/IO，空闲整理不等于交互期间无影响。

### 初始验收目标（建议值，并非项目性能承诺）

| 场景 | 初始目标 | 测量边界 |
|---|---|---|
| RAM 活跃包/人物卡 | P95 ≤ 10 ms | 本地 memory service 内部 |
| 一次混合召回 | P95 ≤ 100 ms，P99 ≤ 200 ms | 含 query embedding、索引读取、合并、过滤和上下文打包 |
| 最近定稿输入可读 | P95 ≤ 100 ms | 服务接收定稿事件到可读覆盖层可见；不等待 LLM 整理 |
| 深度召回/反思 | 独立预算，允许更慢 | 不阻塞即时响应；结果需校验当前请求仍有效 |

这些目标须按实际硬件、中文语料、记忆规模与眼镜到主机网络校准。完整用户等待包含 ASR 收束、传输、Router、Worker 与首段输出，不能拿 ANN 查询耗时充当端到端时延。“本地部署”也不代表模型一定运行在眼镜上：当前建议假设部署在本地主机/手机侧，眼镜为交互终端，仍需验证断连与网络抖动。

### 新的 PoC 决策

- A：Hindsight 后台整理 + pages/mental models + RAM serving；完整 recall 放第二级补充。
- B：EverMemOS construction + lightweight retrieval + RAM serving；确认非 SQL 主存储是否接受。
- 同一中文数据集测试：人物提醒、刚才说的话、历史事实纠正、跨会话回忆、场景切换、删除后召回。
- 同时测空闲与后台满载、冷启动与热缓存、不同记忆规模、短时间突发请求；报告 recall@k/事实准确率、P95/P99、缓存命中率、新信息可见延迟和资源争抢。
- **只有达标才决定最终引擎；若现成 recall 不达标，保留其后台整理，独立构建面向眼镜的检索 serving，而不是更换整个记忆系统。**

## 结论先行

**没有一个成熟开源项目能无改造地同时满足“四层存储 + 本地轻量 + 流式理解压缩 + 可控分层检索”。**

推荐采用 **Mem0 OSS 作为记忆抽取/更新/检索起点，并在 MootingAgent 内实现四层 Context Orchestrator**：

- L0：当前请求内存（MootingAgent 已有的 Context snapshot）；
- L1：短期工作记忆/滚动摘要（SQLite）；
- L2：可读、可审计的 Memory Documents（Markdown/JSONL）；
- L3：结构化事实、事件、版本、来源和检索日志（SQLite）；
- L4：向量索引（开发期 SQLite 向量表或 sqlite-vec；数据量上升后 Qdrant）。

如果必须选择一个“完整框架”而不是组合：

1. **首选 Mem0 OSS**：最接近“输入对话 → 抽取/合并/搜索记忆”的核心闭环，支持自托管、可替换 LLM/Embedding/Vector DB，接入成本最低；但它不是完整的四层 Context runtime，文档层和内存层需自行补齐。
2. **需要 Agent 自主读写记忆时选 Letta**：其上下文层级明确包含 memory blocks、files、archival memory 和外部 DB；但服务/运行时较重，核心记忆操作由 Agent/tool 驱动，不适合作为 MootingAgent 的纯 Context 底座。
3. **需要事实时态、实体关系和历史冲突处理时选 Graphiti**：强项是时序知识图谱和增量更新；但依赖图数据库，部署和检索编排明显更重，不符合“轻量第一”的初始目标。
4. **如果希望完全掌控算法，选 LangMem 的 memory manager + 自建存储**：它提供 semantic/episodic/procedural 类型、热路径/后台形成、插入/更新/删除/合并语义，但需要自己提供存储、分层和召回编排。

## 候选比较

| 项目 | 官方定位与能力 | 本地部署/依赖 | 与四层目标匹配度 | 主要风险 |
|---|---|---|---|---|
| **Mem0 OSS** | `add/search/get/update/delete` 记忆闭环；LLM 抽取并合并记忆；可配置向量库、图存储、reranker | Python/Node 库或 Docker self-host；可接 Qdrant、Chroma、FAISS 等 | **高（需自建 L0/L1/L2）** | 默认配置可能依赖外部 LLM/embedding；版本升级需锁定 API/算法 |
| **Letta** | MemGPT 风格的 core memory、recall、archival；memory blocks、files、archival、外部 DB | 可自托管，但包含 Agent runtime/API/数据库等组件 | 中高 | 体系围绕自主 Agent 和工具调用设计，作为纯 context service 偏重 |
| **Graphiti** | 时序 context graph；实体、关系、episode；可处理变化和历史有效期 | Neo4j/FalkorDB/其他图后端；通常还需要 LLM/embedding | 中 | 图数据库运维成本高；并非文档/SQL/向量四层的完整实现 |
| **LangMem** | memory manager 对对话做记忆抽取、更新、删除、整合；支持 semantic/episodic/procedural；热路径与后台模式 | Python 库；核心 API 不绑定具体存储；状态集成依赖 LangGraph store | **高（算法层）** | 不是开箱即用的独立 memory server；需自行设计 schema、索引和生命周期 |
| **LlamaIndex Memory** | 短期 FIFO + 可选长期记忆；`token_limit`、冲刷到长期记忆；可组合存储组件 | Python 生态，存储后端可组合 | 中高 | 更像 Agent/RAG 组件集合，不提供目标所需的统一记忆治理 |

## 一手资料核验

### Mem0 OSS

Mem0 官方说明 OSS 与托管产品使用同一核心记忆引擎，支持库模式和 self-hosted server；开发者可以选择 LLM、embedding、vector store、reranker，并使用 `add/search/get/get_all/update/delete/delete_all/history` 等 API。见 [Mem0 Open Source Overview](https://docs.mem0.ai/open-source/overview) 和 [Platform vs Open Source](https://docs.mem0.ai/platform/platform-vs-oss)。

Mem0 官方仓库的 quickstart 展示了本地运行 Qdrant 后通过配置接入，并支持 graph memory；见 [Mem0 OSS quickstart](https://github.com/mem0ai/mem0/blob/main/docs/open-source/quickstart.mdx)。这说明它适合做“记忆形成 + 向量检索”的中间层，但并不等于它会自动维护本项目要求的内存、文档、SQL、向量四层。

**评价**：最适合先落地。将 Mem0 的记忆记录作为 L2/L3 的上游处理器，或直接复用其抽取/更新逻辑；最终对 MootingAgent 暴露稳定的 `remember()` / `recall()` 接口，不让业务代码直接绑定 Mem0 数据库。

### Letta / MemGPT

Letta 的官方 context hierarchy 把上下文来源分成：持久化的 memory block（直接放在 context 中）、可读文件、可查询的 archival memory，以及通过工具/MCP 接入的外部数据库；官方还建议根据数据规模和重要性选择这些抽象。见 [Letta Context hierarchy](https://docs.letta.com/v1-sdk/memory/context-hierarchy/)。

Letta 的 MemGPT 概念文档明确把 memory 分成 in-context 与 out-of-context，并由 Agent 使用工具移动/编辑记忆；见 [MemGPT concepts](https://docs.letta.com/concepts/memgpt/)。

**评价**：它在“分层上下文”理念上最贴近需求，但默认心智模型是“记忆由 Agent 自主工具调用管理”，而 MootingAgent 需要 Router/Context 层统一控制、可审计、低延迟，因此更适合作为设计参考或后续完整 Agent runtime，而不是第一版底座。

### LangMem

LangMem 官方将长期记忆操作定义为：输入对话和当前记忆状态，由 LLM 扩展或整合记忆，再返回更新后的状态；支持 semantic、episodic、procedural memory。它区分 collection（可插入、更新、失效、合并的记录集合）与 profile（当前状态的单文档），并指出召回不应只依赖相似度，还应结合重要性、最近使用和频率。见 [LangMem Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)。

LangMem 同时支持 hot-path 立即形成和 background/subconscious 后台形成；核心 API 不绑定具体数据库，状态集成则使用 LangGraph store，支持按 namespace、直接 key、语义搜索和 metadata filter 检索。见同一官方文档及 [LangMem Memory API](https://langchain-ai.github.io/langmem/reference/memory/)。

**评价**：非常适合实现本项目的“理解、压缩、摘要、合并、淘汰”算法层；但必须自建事件溯源、文档落盘、SQL schema、向量索引和跨层召回。

### Graphiti / Zep OSS

Graphiti 官方定位为可增量更新、可时间查询的 temporal knowledge graph，围绕 entities、facts/relationships、episodes 和 custom types 构建 context graph；见 [Zep Graphiti Overview](https://help.getzep.com/v4/graphiti/getting-started/overview) 和 [Graphiti GitHub](https://github.com/getzep/graphiti)。

Graphiti 的官方 Docker Compose 使用 Neo4j 作为图后端，并提供 FalkorDB profile；见 [Graphiti docker-compose](https://github.com/getzep/graphiti/blob/main/docker-compose.yml)。官方 README 还明确 Graphiti 的自托管检索和开发者工具需要自行搭建，和托管 Zep 的生产服务不同。

**评价**：如果 MootingAgent 后续需要“某个事实在什么时候成立、何时被替换、人物/项目/事件关系如何演化”，Graphiti 很有价值；但第一版不宜把它作为唯一记忆底座，最好把它作为可选 L3 graph projection。

### LlamaIndex Memory

LlamaIndex 官方 Memory 文档描述了短期聊天记忆（FIFO、token limit）和可选长期记忆：当短期上下文超过比例时，可将较旧内容冲刷到长期记忆；Memory 可通过 `put_messages`、`get` 等接口管理。见 [LlamaIndex Memory](https://developers.llamaindex.ai/python/framework/module_guides/deploying/agents/memory/)。

**评价**：适合复用其 token-aware 短期记忆和存储抽象，但它本身不是一个完整的、可独立部署的 memory service。

## 推荐架构

```text
MootingAgent input stream
        |
        v
[Ingest/Event Log]  -- append-only 原文、时间、session、source、trace id
        |
        +--> L0 Working Context (RAM)
        |       最近消息、当前任务、当前 speaker/topic、预算内 token
        |
        +--> Async Memory Processor
                1. normalize / dedupe
                2. classify: semantic / episodic / procedural / preference
                3. extract structured facts and confidence
                4. summarize/merge/invalidate old memories
                5. write L1/L2/L3/L4 atomically

L1 SQLite short-term state / rolling summaries
L2 Markdown/JSONL Memory Documents (human-readable, auditable)
L3 SQLite facts/events/links/versions/metadata
L4 Vector index (SQLite vector extension first; Qdrant when scale requires)
        |
        v
Layered Retriever
  1. exact filters + current profile (L1/L3)
  2. keyword/FTS5 (L2/L3)
  3. vector ANN (L4)
  4. optional graph traversal (future Graphiti)
  5. rerank by relevance + recency + importance + confidence + scope
        |
        v
Context Compiler -> bounded, attributed Context snapshot -> Router/Worker
```

### 统一记忆记录

建议所有层围绕同一个 `memory_id` 和版本链，不让“摘要”和“向量结果”成为无来源文本：

```json
{
  "memory_id": "uuid",
  "scope": "user|session|project|global",
  "kind": "profile|fact|episode|procedure|summary",
  "content": "可读记忆文本",
  "structured": {"key": "value"},
  "source_event_ids": ["event-id"],
  "created_at": "timestamp",
  "valid_from": "timestamp",
  "valid_to": null,
  "confidence": 0.0,
  "importance": 0.0,
  "last_accessed_at": null,
  "access_count": 0,
  "status": "active|superseded|retracted",
  "version": 1,
  "embedding_model": "model-id",
  "embedding_ref": "vector-record-id"
}
```

### 检索策略

- **先精确、后语义**：scope、kind、status、时间范围和实体过滤先做，避免全库 ANN。
- **分层预算**：L0 固定注入；L1 每轮注入少量；L2/L3 只取候选；L4 取 top-k 后 rerank；超过 token 预算时优先保留高 confidence/importance/recency。
- **混合检索**：SQLite FTS5/BM25 处理专名、编号、代码；向量处理语义改写；合并后用简单可解释打分。
- **摘要不是事实覆盖**：摘要必须保留来源事件 ID；原始事件不可被摘要删除，只可归档/压缩。
- **冷热分层**：活跃记忆保留向量；长期未访问但仍有效的内容只保留 SQL + 文档，命中后再异步向量化。
- **后台处理**：交互热路径只写事件和更新 L0；抽取、合并、embedding、文档归档走队列，避免每次输入增加一次 LLM 延迟。

## 具体选型

### 推荐默认组合

- **算法/抽取**：Mem0 OSS，必要时以 LangMem memory manager 替换/补充复杂 schema 和 episodic/procedural 记忆。
- **本地数据库**：SQLite（事件、事实、版本、FTS5、任务状态）。
- **文档层**：项目数据目录下按 scope 分目录的 Markdown 或 JSONL；Markdown 供人审阅，JSONL 供重建索引。
- **向量层**：第一阶段使用 SQLite 向量扩展或本地嵌入表；达到几十万级向量或并发检索明显上升后切 Qdrant。Mem0 官方支持 Qdrant 等向量后端，可平滑替换。
- **Embedding/LLM**：通过 OpenAI-compatible 接口接本地模型或已有 Router/Worker 配置；不要在 Context 层硬编码云厂商。
- **API**：`ingest(event)`, `process(event_id)`, `remember(memory)`, `recall(query, scope, budget)`, `compile_context(request)`。

### 不建议直接采用

- **只用 Letta**：会把 Context System 的控制权转给 Agent runtime，增加部署和调试面。
- **只用 Graphiti**：图关系很强，但无法替代短期上下文、可读 Memory 文档和通用 SQL 事实表。
- **只用向量数据库**：无法可靠表达当前状态、版本/失效、精确过滤和可审计来源。
- **每轮同步 LLM 总结**：延迟和成本不可控，也会把错误摘要直接写入主链路。

## 分阶段实施

### Phase 1：可用底座

1. 把当前 `persistence: in-memory` 的 Session 事件抽象为 append-only `context_events`。
2. 加 `memory_items`、`memory_versions`、`memory_links`、`memory_embeddings`、`memory_jobs` 五张 SQLite 表。
3. L0 继续使用现有 Context snapshot；L1 实现滚动摘要和当前 profile。
4. 接入 Mem0 OSS 的 add/search/update/delete，先只写入独立 namespace。
5. 编译 Context 时加入来源、时间和置信度，保留 token 预算。

### Phase 2：质量和效率

1. 抽取采用后台队列；失败可重试且不阻塞 Router。
2. FTS5 + vector hybrid retrieval；加入 recency/importance/confidence/access frequency 打分。
3. 对每条摘要做 source coverage 检查，支持用户删除/纠正并反向失效向量。
4. 增加离线评测集：事实召回、时效性、冲突处理、token 压缩率、P50/P95 延迟。

### Phase 3：可选知识图谱

当真实需求出现“人物、项目、地点、事件、关系随时间变化”的查询，再将 L3 事实投影到 Graphiti/Neo4j 或 FalkorDB；图层失败不影响 SQL/向量检索。

## GitHub 补充候选

以下项目是本轮从 GitHub 官方仓库继续筛选出的候选。它们不是简单的向量数据库，而是至少包含记忆形成、结构化组织、生命周期或混合检索中的一项。

| 项目 | 关键能力 | 本地部署形态 | 对 MootingAgent 的判断 |
|---|---|---|---|
| **Cognee** | `remember/recall/improve/forget`；把文本、文件和 URL 转成语义图、实体索引和向量；支持自动路由检索 | Python 版本可用 Ollama；默认本地栈可用 SQLite + Ladybug/Kuzu + LanceDB | **目前最接近“一体化本地底座”**；但图谱/数据管线较重，仍需自行加 Memory Documents 和 Context budget |
| **Cognee-RS** | Rust 实现的本地 AI memory；同样提供 remember/recall/improve/forget | 默认嵌入式 SQLite（关系）、Ladybug（图）、LanceDB（向量）；单进程模型 | 若 MootingAgent 后续追求低延迟和单二进制，值得做性能验证；目前生态和成熟度不如 Python Cognee |
| **Hindsight** | `retain/recall/reflect`；retain 抽取结构化事实、解析实体并生成索引；reflect 做跨记忆综合 | 官方定位为可通过 API/MCP 接入 Agent；文档强调不需要独立向量数据库/RAG pipeline，但实际服务配置需核对数据库依赖 | **适合做独立 Memory API/MCP 服务**；比 Mem0 更强调反思和事实结构化，但服务化运维和数据库依赖要先验证 |
| **EverMemOS** | episode、event log、semantic memory、profile 等多类记忆；提供 lightweight 与 agentic 两种检索；embedding/BM25/RRF | Docker/服务化项目，偏企业级；不是最轻量的单进程库 | 分层记忆和混合检索很贴合需求，但更适合中后期评估，不建议作为第一版底座 |
| **Supermemory** | documents、memories、user profiles、hybrid search；本地一体化启动；提供本地图引擎和本地 embedding | one-binary / `npx supermemory local`；本地 API 默认 `localhost:6767`；可 Docker self-host | **集成体验很好**，但默认本地 embedding 模型偏英文，中文 MootingAgent 必须替换 embedding 或评测召回质量 |
| **A-MEM / A-mem-sys** | Zettelkasten 风格动态记忆组织；LLM 生成关键词、上下文和标签；ChromaDB 向量存储；基于关联建立记忆链接 | Python 库 + ChromaDB，适合实验和论文复现 | 适合研究“记忆之间动态链接和自组织”，不适合作为生产底座；缺少完整 SQL、文档和运维面 |
| **Memary** | Memory Stream + Entity Knowledge Store；面向自主 Agent 的知识图谱记忆 | Python/知识图谱导向，依赖较多 | 可作为实体/关系记忆参考，但项目活跃度、可重复部署和数据治理需要谨慎核验 |
| **AgentMemory** | 宣称支持 short-term FIFO、long-term importance retention、episodic/semantic/procedural 等层次 | 社区项目，具体存储组合需看仓库版本 | 概念上很贴合四层需求，但更适合作为架构参考，不应优先于成熟度更高的 Cognee/Mem0 |

### 新候选的官方依据

- [Cognee GitHub](https://github.com/topoteretes/cognee)：官方定位为开源 AI memory platform；其 [local Ollama example](https://github.com/topoteretes/cognee/blob/main/examples/guides/local_ollama_example.py) 明确展示本地 LLM、embedding，以及 Ladybug/Kuzu、LanceDB、SQLite 组合。
- [Cognee-RS README](https://github.com/topoteretes/cognee-rs)：官方说明其四动词 API 为 `remember / recall / improve / forget`，默认特性集采用 SQLite、Ladybug 和 LanceDB 的嵌入式栈。
- [Hindsight MCP/Agent memory](https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/blog/2026-03-04-mcp-agent-memory.md)：官方说明 `retain` 会抽取结构化事实、做实体解析并建立检索索引，`recall` 和 `reflect` 分别负责召回和跨记忆综合。
- [EverMemOS GitHub](https://github.com/lipps/EverMemOS)：官方 API 示例列出 episode、event log、semantic memory、profile 数据源，以及 embedding、BM25、RRF、lightweight/agentic 检索模式。
- [Supermemory GitHub](https://github.com/supermemoryai/supermemory)：官方说明本地模式提供 documents、memories、profiles、hybrid search；本地 embedding 默认使用 `Xenova/bge-base-en-v1.5`，也可改为 Ollama 或其他兼容端点。
- [A-MEM official implementation](https://github.com/WujiangXu/A-mem-sys)：官方 README 描述了 LLM 分析、增强 embedding、ChromaDB 存储和动态链接流程。
- [Memary GitHub](https://github.com/MemaryAI/MemaryAI)：官方 README 将 Memory Stream 与 Entity Knowledge Store 作为核心模块。
- [AgentMemory GitHub](https://github.com/hanishkeloth/agentmemory)：官方 README 将其定位为 persistent、hierarchical、semantic memory framework。

### 更新后的选型排序

如果优先级是“**四层存储尽量少自建**”，新增候选后排序调整为：

1. **Cognee**：最接近本地 SQLite + 图 + 向量的一体化方案；仍需补 L0 内存、L2 文档和 MootingAgent 专用 Context Compiler。
2. **Mem0 OSS**：最成熟、最简单的记忆形成 API；存储和 Context 分层需要自行编排。
3. **Supermemory**：本地运行和 API 体验好；中文 embedding 和数据模型可控性需要验证。
4. **Hindsight**：事实抽取、反思和 MCP 接入很强；适合作为独立服务候选。
5. **EverMemOS**：分层记忆和混合检索完整，但更偏企业级服务。
6. **Letta / Graphiti / A-MEM**：分别适合 Agent 自主记忆、时序知识图谱、研究型动态链接，不建议直接作为第一版底座。

**因此，最终建议变为：先对 Cognee 和 Mem0 做一周 PoC 对比。**

- 若 Cognee 的中文抽取、图谱构建和查询延迟满足要求，选择 **Cognee + 自建 Context Orchestrator**；
- 若希望最小依赖、最快接入，选择 **Mem0 OSS + SQLite/文档/Qdrant 分层**；
- 不建议为了“看起来有四层”同时引入 Cognee、Mem0、Graphiti，避免重复抽取、重复 embedding 和数据一致性问题。

## 最终判断（按眼镜低时延需求修订）

**首选做 Hindsight 与 EverMemOS 的 PoC，而不是直接锁定 Mem0 或 Cognee。** 两者都明确提供“后台复杂记忆整理 + 快速检索模式”：Hindsight 更适合事实、观察、mental model/page 和证据链；EverMemOS 更适合直接验证 embedding + BM25 + RRF 的 lightweight retrieval。

最终落地形态应是：

- 后台：使用 Hindsight 或 EverMemOS 负责事实抽取、压缩、冲突合并、摘要、关系和索引维护；本地模型可高频运行，不放入用户请求热路径。
- 热路径：自建独立的 RAM serving layer，预加载当前人物卡、场景摘要、最近事件和高频事实；并行执行结构化查询、FTS/BM25 和向量召回。
- 深度路径：Graphiti、Hindsight reflect、EverMemOS agentic retrieval 或 Cognee 图检索只作为超时后补充，不阻塞首个响应。
- 若 Hindsight/EverMemOS 的服务边界不适合现有 Node/MootingAgent，再退回 **Mem0/Cognee 只负责后台整理 + 自建低延迟检索层**。

因此，新的第一阶段不是“选一个库直接接入”，而是先建立 **热路径延迟基线**：P95 混合召回 ≤100 ms、P99 ≤200 ms、最近定稿信息可见 ≤100 ms；所有目标都必须在中文数据、后台满载、冷启动和断连场景下实测。任何需要 LLM query rewrite、LLM rerank 或 agentic 多轮检索的路径，都不能作为眼镜首屏唯一依赖。

这比单纯选择一个“功能最多”的 Memory Framework 更符合 MootingAgent 的真实约束：记忆可以慢慢整理，但用户抬头提问时必须先得到新鲜、可解释、可取消且不被旧缓存污染的上下文。
