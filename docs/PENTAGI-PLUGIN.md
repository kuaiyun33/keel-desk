# PentAGI → DeepSeek Harness 插件对照

源码：`vendor/pentagi`（clone `https://github.com/vxcontrol/pentagi`，HEAD `ea66530`）

官方栈不是「给 LLM 几个函数」那么简单，是一整套自托管渗透平台：

```
用户 → React UI / REST / GraphQL
         ↓
      Go 后端 (cmd/pentagi)  :8443 TLS
         ↓
  多 Agent 编排 (assistant / primary / pentester / coder / installer / memorist / searcher / reporter / generator)
         ↓
  tools.Executor  → Docker 沙箱跑 terminal/file
                 → scraper 容器跑 browser
                 → web_search 编排 google/ddg/tavily/firecrawl/perplexity/searxng/sploitus
                 → pgvector 长期记忆
                 → 可选 Neo4j Graphiti
```

Compose 默认：

| 服务 | 端口 |
|---|---|
| pentagi API/UI | `https://127.0.0.1:8443` |
| pgvector | `127.0.0.1:5432` |
| scraper | `127.0.0.1:9443` |

**不是 8080。** 环境变量 `DSH_PENTAGI_URL` 可覆盖。

## 原项目 42 个工具名（`backend/pkg/tools/registry.go`）

Agent 可调的执行面（Assistant executor，`UseAgents=true`）：

`terminal` `file` `browser` `web_search` `advice` `coder` `maintenance` `memorist` `pentester` `search` `get_flow_status` `stop_flow` `submit_flow_input` `patch_flow_subtasks` `wait_flow_completion`

Barrier / 结果回写（子 agent 用，不直接给主对话）：

`done` `ask` `report_result` `subtask_list` `subtask_patch`  
`code_result` `hack_result` `maintenance_result` `memorist_result` `search_result` `enricher_result`

搜索引擎（agent 不直接点名，走 `web_search` mode；也可单独注册）：

`google` `duckduckgo` `tavily` `firecrawl` `traversaal` `perplexity` `searxng` `sploitus`

向量库：

`search_in_memory` `search_guide` `store_guide` `search_answer` `store_answer` `search_code` `store_code` `graphiti_search`

## Harness `pg_*` 映射（开启 PentAGI 档后模型自己调）

| 原名 | DSH 工具 | 本机能否跑 |
|---|---|---|
| terminal | `pg_terminal` | 是（本机 shell；官方是 Docker 沙箱） |
| file | `pg_file` | 是 |
| browser | `pg_browser` | 是（直抓 URL；官方走 scraper 容器） |
| web_search | `pg_web_search` | 是（ddg + sploitus；付费引擎要 API key） |
| duckduckgo / google | `pg_duckduckgo` `pg_google` | 是（google 走 ddg 无 key 回退） |
| sploitus | `pg_sploitus` | 是 |
| search_in_memory / memorist | `pg_search_in_memory` `pg_memorist` | 是（`~/.dsh/pentagi/memory.json`） |
| store/search answer/guide/code | `pg_store_*` `pg_search_*` | 是 |
| pentester / coder / maintenance / advice / search | `pg_*` 同名 | 是（返回 playbook，真正执行仍走 terminal/browser） |
| subtask_list / subtask_patch / report_result / done / ask | `pg_subtask_list` `pg_subtask_patch` `pg_report_result` `pg_done` `pg_ask` | 是 |
| graphiti_search | `pg_graphiti_search` | 本地账本；Neo4j 要官方后端 |
| get_flow_status / submit / stop / wait / createFlow | `pg_flow_status` `pg_flow_input` `pg_flow_stop` `pg_flow_wait` `pg_flow_create` | 本地账本；有 `DSH_PENTAGI_TOKEN` 才打 GraphQL |
| tavily / firecrawl / traversaal / perplexity / searxng | `pg_tavily` `pg_firecrawl` `pg_perplexity` `pg_searxng` `pg_traversaal` | 有 key 走官方；否则回退 ddg/browser |
| createAssistant / callAssistant / stopAssistant | `pg_assistant_*` | GraphQL；无 token 本地 stub |
| searchKnowledge + CRUD | `pg_knowledge_*` | GraphQL 或 `~/.dsh/pentagi/knowledge.json` |
| flowFiles / logs / screenshots | `pg_flow_files` `pg_flow_logs` `pg_flow_watch` | REST/GraphQL；无 token 报缺 token |
| finishFlow / renameFlow | `pg_flow_finish` `pg_flow_rename` | GraphQL 或本地账本 |
| Docker 沙箱 terminal | `pg_terminal` sandbox=true | `vxcontrol/kali-linux`（[kali-linux-image](https://github.com/vxcontrol/kali-linux-image)）。设置页「启用 Kali 沙箱」写入 `coldbrew.pentagi.sandbox`；未显式传 `sandbox` 时跟这个开关。DinD 把 Colima VM `/var/run/docker.sock` 挂进 Kali。GUI 进程走 Homebrew/`colima` PATH。 |
| *_result 回写工具 | 不单独暴露 | 子 agent 内部用 |

开启路径：设置 → 破甲管理 → **PentAGI 1.0.0** → 卡片点 **启动官方后端**（colima + `docker compose up -d` + 登录签发 token）→ 开**新会话**。模型也可调 `pg_backend_start`。先 `pg_status`，再 `pg_subtask_list` / `pg_browser` / `pg_terminal`。

接官方全栈：

```bash
cd vendor/pentagi
cp .env.example .env   # 至少填一个 LLM key + DATABASE
docker compose up -d
# UI: https://127.0.0.1:8443
export DSH_PENTAGI_URL=https://127.0.0.1:8443
export DSH_PENTAGI_TOKEN=<Settings → API Tokens>
```

## 原项目里「还能让 AI 调」的全部面（源码分层）

PentAGI 不是一张工具表。模型在官方栈里能碰到的调用面有 **五层**。Harness 现在只接了第 1 层的主对话子集。

### 1. LLM function tools（`backend/pkg/tools/registry.go` + 各 Executor）

这是「agent 自己选、自己调」的那一层。按 executor 分工：

| Executor | 谁在调 | 工具 |
|---|---|---|
| Assistant | 主对话 | terminal file browser web_search advice coder maintenance memorist pentester search + flow_* |
| Primary | 自主 flow 主循环 | 同上 + barrier `done` |
| Pentester | 被 `pentester` 派出去的子 agent | terminal/file/browser/web_search + 子专家 + `hack_result` |
| Coder | 写 PoC | terminal/file + `code_result` |
| Installer | DevOps / 装工具 | terminal/file + `maintenance_result` |
| Searcher | 调研 | web_search + store/search_* + `search_result` |
| Memorist | 查旧活 | search_in_memory + `memorist_result` |
| Enricher | 补上下文 | store/search + `enricher_result` |
| Generator / Refiner | 拆/改 subtask | `subtask_list` `subtask_patch` |
| Reporter | 结案 | `report_result` |

`*_result` / `done` / `ask` **不是给人点的**，是子 agent 结束时的 barrier。Harness 把它们暴露成 `pg_done` / `pg_ask` 给主模型用，官方主对话一般不直接调。

付费搜索引擎（tavily / firecrawl / traversaal / perplexity / searxng / google CSE）官方 **不让 agent 点名**，一律走 `web_search` 的 mode 链（`web_search.go` fallbackStrategy）。没 key 就 skip。

### 2. GraphQL（`schema.graphqls`）— 编排 API，不是扫描工具

有 Bearer token 时，**程序/模型**可以调这些 mutation（官方 UI 也走这一层）：

**Flow（渗透任务本体）**

- `createFlow` `putUserInput` `stopFlow` `finishFlow` `deleteFlow` `renameFlow`
- Query: `flows` `flow` `tasks` `flowFiles` `screenshots` 以及各类 logs

**Assistant（挂在 flow 上的对话 agent）**

- `createAssistant` `callAssistant` `stopAssistant` `deleteAssistant`

**Knowledge（pgvector 知识库，和 memorist 不是同一套入口）**

- Query: `knowledgeDocuments` `knowledgeDocument` `searchKnowledge`
- Mutation: `createKnowledgeDocument` `updateKnowledgeDocument` `renameKnowledgeDocument` `deleteKnowledgeDocument` `anonymizeText`

**配置类（通常不该让渗透 agent 乱调）**

- Provider: `createProvider` `updateProvider` `deleteProvider` `testAgent` `testProvider`
- Prompt 模板: `validatePrompt` `createPrompt` `updatePrompt` `deletePrompt`（`PromptType` 有 30+ 种 agent 提示词）
- Token: `createAPIToken` …
- Template: `createFlowTemplate` …
- 收藏: `addFavoriteFlow`

Harness 已接：`pg_flow_create/status/input/stop`。  
**还没接、但模型用得上：** `callAssistant`、`finishFlow`、`searchKnowledge` / CRUD knowledge、`flowFiles`、logs 查询。

### 3. GraphQL Subscription（实时流）

`flowUpdated` `taskUpdated` `terminalLogAdded` `toolCallLogUpdated` `screenshotAdded` `assistantLogUpdated` `knowledgeDocumentCreated` …  
这是 UI 推送，不是 LLM tool。要接的话做成 `pg_flow_watch` 轮询/SSE，不是 function schema。

### 4. REST `/api/v1`（`router.go`，Bearer）

和 GraphQL 重叠，多出来的是 **文件/容器/资源**：

- `POST /flows/:id/files` 上传、`GET .../download`、`POST .../pull` 从容器拉文件
- `GET /flows/:id/files/container` 看容器内文件
- `/resources` 用户资源库（上传/mkdir/move/copy）
- `/containers` 看 Docker 沙箱
- `/knowledge` REST 版知识库
- `/flows/:id/graph` 任务图

这些才是「官方沙箱里的产物」。Harness 的 `pg_file` 读写的是 **本机路径**，不是 flow 容器。

### 5. 官方运行时能力（没有独立 tool 名，藏在 Docker 镜像里）

README 写的 nmap / metasploit / sqlmap / nuclei … **不是 42 个 function**，是 `terminal` 在 **pentest 镜像**里能敲到的二进制。  
没 `docker compose up` 时，`pg_terminal` 只能用你 Mac 上已装的命令。

Agent 角色（`AgentType` / `PromptType`）也不等于 tool：`reflector` `enricher` `summarizer` `tool_call_fixer` `image_chooser` `language_chooser` `execution_monitor` `task_planner` 是内部链，主模型不会看到它们的 function。

## 还值得接到 Harness、按优先级

| 优先级 | 原能力 | 做成什么 | 依赖 |
|---|---|---|---|
| P0 已接 | terminal/file/browser/search/memory/flow 主集 | `pg_*` 32 个 | 无 |
| P1 | `callAssistant` + `createAssistant` | `pg_assistant_call` | token + :8443 |
| P1 | knowledge search/CRUD | `pg_knowledge_*` | token；无后端则继续用本地 memory.json |
| P1 | flow files / screenshots / term logs | `pg_flow_files` `pg_flow_logs` | token |
| P2 | tavily/firecrawl/perplexity/searxng | `pg_web_search` 按 key 自动选引擎 | 各 API key |
| P2 已接 | Docker 沙箱 + 开发机 DinD | 设置页开关；`pg_terminal` 默认进 Kali；DinD 挂 Colima VM sock（不是独立加固 dind daemon） | docker daemon + `docker pull vxcontrol/kali-linux` |
| P3 | Subscriptions | `pg_flow_watch` | token + WS |
| 不要接给渗透 agent | createProvider / 改 prompt 模板 / 发 API token | 配置面，不是攻击面 | — |
