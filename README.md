<div align="center">
  <img src="docs/readme-hero.svg" alt="Agent Trace Workbench — Local-first observability and replay debugger for coding agents" width="100%" />

  <br />

  <strong>面向 Coding Agent 的本地优先轨迹观察、会话回放与调试工作台</strong>

  <br />
  <br />

  <a href="https://github.com/Riordon666/cc-trajectory-workbench/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Riordon666/cc-trajectory-workbench/ci.yml?branch=main&amp;style=flat-square&amp;label=CI" /></a>
  <a href="https://nodejs.org/"><img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-43853d?style=flat-square&amp;logo=node.js&amp;logoColor=white" /></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-5b9bd5?style=flat-square" /></a>
  <img alt="Local-first" src="https://img.shields.io/badge/Local--first-127.0.0.1-e891b5?style=flat-square" />
  <img alt="No telemetry" src="https://img.shields.io/badge/Telemetry-none-5eaaa8?style=flat-square" />

  <br />
  <br />

  <a href="#-三分钟快速开始"><strong>快速开始</strong></a>
  &nbsp;·&nbsp;
  <a href="#工作原理"><strong>工作原理</strong></a>
  &nbsp;·&nbsp;
  <a href="#四个工作区"><strong>界面导览</strong></a>
  &nbsp;·&nbsp;
  <a href="docs/ARCHITECTURE.md"><strong>架构文档</strong></a>
  &nbsp;·&nbsp;
  <a href="ROADMAP.md"><strong>路线图</strong></a>
</div>

---

Agent Trace Workbench 把一次 Coding Agent 运行过程中散落在 **API 流、Agent History、工具调用和终端输出**里的信息，整理成同一个本地 Session。你可以实时观察请求、按轮次回放会话、比较双源数据，并用非阻断 Diagnostics 定位缺失、中断和不一致。

> [!IMPORTANT]
> 这是一个纯本地工具：默认只监听 `127.0.0.1`，没有账号、云端后端或遥测。来源没有提供 reasoning 时，界面会明确显示 `unavailable`，绝不会根据答案反推或伪造思维链。

<p align="center">
  <img src="docs/screenshots/session-explorer.png" alt="Agent Trace Workbench Session Explorer" width="94%" />
</p>

<p align="center"><sub>界面截图由合成 Session 生成，不包含真实对话、API 密钥或本机路径。</sub></p>

## ✨ 一眼看懂

| | 能力 | 你会得到什么 |
|---|---|---|
| 🔭 | **实时捕获** | 通过本地 Gateway 观察 Anthropic Messages API 与 OpenAI Responses API 的流式请求 |
| 🧭 | **统一时间线** | Claude Code、Codex CLI 与协议抓取统一为稳定的 `events.jsonl` 事件模型 |
| ↻ | **逐轮回放** | 在 user、assistant、reasoning、tool call、tool result、usage 之间快速定位 |
| ◫ | **双源对齐** | 对照 Gateway 抓取与 Agent History，发现缺失、旁路和内容差异 |
| ◇ | **非阻断诊断** | warning / error 只解释数据状态，不扣留你的 Session，也不阻止导出 |
| ⛨ | **隐私与完整性** | 本地存储、凭证脱敏、SHA-256 哈希、崩溃恢复和安全导出 Bundle |
| ◉ | **内置终端** | 在同一个工作台运行本机 Agent，并限制 Origin、Shell、CWD 与终端尺寸 |
| ✦ | **特色界面** | 四工作区配色、动漫壁纸、自定义壁纸、透明度、亮度、模糊和专注模式 |

## 🚀 三分钟快速开始

### 1. 安装并启动

```bash
git clone https://github.com/Riordon666/cc-trajectory-workbench.git
cd cc-trajectory-workbench
npm install
npm run workbench
```

### 2. 打开本地工作台

```text
http://127.0.0.1:5177/
```

### 3. 记录第一条轨迹

1. 在左侧创建一个 Session；
2. 在 **A · Live Capture** 选择 Agent 和协议；
3. 点击“开始捕获”；
4. 把客户端 Base URL 指向工作台展示的本地 Gateway；
5. 运行一次 Agent 任务，然后在 **D · Replay & Diagnostics** 查看回放。

> [!TIP]
> 不想重新请求模型？可以直接发现并导入本机 Claude Code / Codex CLI History。只导入 History 也能浏览统一事件和回放会话。

### 环境要求

- Node.js `20` 或更高版本；
- npm；
- Windows、macOS 或 Linux；
- 内置终端依赖 `node-pty`，需要它能在当前系统正常安装。

## 🧩 支持矩阵

| 层级 | 适配器 / 模式 | 状态 | 当前能力 |
|---|---|:---:|---|
| Agent | Claude Code | ✅ | 发现并导入本地 JSONL History，转换消息、thinking、工具和 usage |
| Agent | Codex CLI | ✅ | 发现本机 rollout JSONL，检测已观察格式，转换消息、reasoning summary、工具和 usage |
| Protocol | Anthropic Messages API | ✅ | 流式 SSE 与非流式 JSON 归一化 |
| Protocol | OpenAI Responses API | ✅ | 流式 SSE 与非流式 JSON 归一化 |
| Capture | Local Gateway | ✅ 推荐 | 固定路由转发、即时流式透传、脱敏抓取与事件转换 |
| Capture | Advanced / Legacy MITM | ⚙️ 高级 | 保留证书代理模式，兼容不能设置 Base URL 的客户端 |

<details>
<summary><strong>README 导航</strong></summary>

- [它能解决什么问题](#它能解决什么问题)
- [核心特性](#核心特性)
- [Agent History 发现范围](#agent-history-发现范围)
- [工作原理](#工作原理)
- [安装与启动（详细）](#安装与启动详细)
- [第一次使用](#第一次使用)
- [Gateway 抓取模式](#gateway-抓取模式)
- [导入本地 Agent History](#导入本地-agent-history)
- [四个工作区](#四个工作区)
- [统一事件模型](#统一事件模型)
- [Diagnostics 与双源对齐](#diagnostics-与双源对齐)
- [Session 文件与导出包](#session-文件与导出包)
- [隐私与安全边界](#隐私与安全边界)
- [环境变量](#环境变量)
- [项目结构](#项目结构)
- [开发与测试](#开发与测试)
- [已知限制](#已知限制)
- [常见问题](#常见问题)

</details>

## 它能解决什么问题

Coding Agent 执行一次任务时，信息通常散落在多个地方：

- API 请求里有模型名、输入、流式响应、工具调用和 token 用量；
- Claude Code 或 Codex CLI 的本地 History 里有用户消息、Agent 消息、工具结果和会话元数据；
- 终端里只有命令执行过程；
- 请求失败、用户取消、流式响应中断等异常很难从单一来源还原。

Agent Trace Workbench 把这些信息放到同一个本地 Session 中，主要用于：

- 观察 Agent 实际发出了哪些模型请求；
- 查看完整模型标识，而不是被缩写或模型白名单替换后的名称；
- 按请求回放用户消息、Agent 回复、工具调用、工具结果和 usage；
- 对比 Gateway 抓取与 Agent History 是否一致；
- 定位请求缺失、响应中断、工具结果缺失、模型不一致等问题；
- 导出经过脱敏并带哈希校验的 Session Bundle，供自己备份或调试；
- 在不离开工作台的情况下，通过内置终端运行本地 Agent。

## 核心特性

- **Local-first**：Web 服务默认只监听 `127.0.0.1`，没有云端后端。
- **多 Agent**：首版支持 Claude Code 和 Codex CLI。
- **多协议**：支持 Anthropic Messages API 与 OpenAI Responses API。
- **通用事件模型**：不同 Agent、不同 API 的数据统一写入 `events.jsonl`。
- **流式抓取**：支持 SSE 流式响应，同时保留已观察到的部分事件。
- **双源对齐**：把 Gateway/Legacy 抓取与 Agent History 放到同一回放视图中比较。
- **非阻断 Diagnostics**：warning 或 error 只提示问题，不阻止查看、回放和导出。
- **不伪造 reasoning**：来源未提供时明确显示 `unavailable`。
- **完整模型名**：模型标识按来源原样保存，不做缩写和白名单映射。
- **脱敏与完整性**：已知凭证字段会被脱敏，导出包包含 SHA-256 哈希。
- **崩溃恢复**：事件存储可以跳过损坏的尾行并保留此前已落盘的数据。
- **本地终端**：保留内置 PTY 终端，并限制监听地址、WebSocket Origin、Shell、工作目录和终端尺寸。
- **特色界面**：保留动漫风格、内置动漫壁纸、自定义壁纸、透明度、亮度、模糊和专注模式。

## Agent History 发现范围

Claude Code 默认扫描：

```text
%USERPROFILE%\.claude\projects\**\*.jsonl
或
$HOME/.claude/projects/**/*.jsonl
```

Codex CLI 支持依据本机实际观察到的 rollout 结构实现，默认扫描：

```text
%CODEX_HOME%\sessions\...
或
%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl
```

项目只提交合成测试数据，不提交任何真实 Claude Code 或 Codex CLI Session。

## 工作原理

```mermaid
flowchart LR
    API["Coding Agent / API Client"] --> GW["Local Gateway"]
    GW --> PA["Protocol Adapter"]
    GW --> RAW["脱敏原始抓取"]
    HISTORY["Local Agent History"] --> AA["Agent Adapter"]
    PA --> EVENTS["通用事件流<br/>events.jsonl"]
    RAW --> EVENTS
    AA --> EVENTS
    EVENTS --> EXPLORER["Session Explorer"]
    EVENTS --> REPLAY["Replay"]
    EVENTS --> DIAG["Diagnostics"]
    EVENTS --> BUNDLE["Session Bundle"]

    classDef source fill:#eef5fc,stroke:#5b9bd5,color:#2a2a3a;
    classDef adapter fill:#fdeef4,stroke:#e891b5,color:#2a2a3a;
    classDef core fill:#edfaf8,stroke:#5eaaa8,color:#2a2a3a;
    classDef view fill:#fff4e7,stroke:#f29a3f,color:#2a2a3a;
    class API,HISTORY,GW source;
    class PA,AA,RAW adapter;
    class EVENTS core;
    class EXPLORER,REPLAY,DIAG,BUNDLE view;
```

整个链路分成三层：

1. **捕获层**：Gateway 接收本地客户端请求，将请求转发到真实上游 API，并把已脱敏的请求/响应保存到当前 Session。Legacy MITM 作为高级兼容模式保留。

2. **适配器层**：Protocol Adapter 负责理解 API 协议；Agent Adapter 负责理解 Claude Code 或 Codex CLI 的本地 History。两者都输出相同的通用事件结构。

3. **观察层**：Session Explorer、Replay 和 Diagnostics 只消费通用事件，不需要把每一种 Agent 格式硬编码进 UI。

### 关于 reasoning

本项目不会根据最终答案反推或编造模型思维链：

- 来源包含真实 reasoning/thinking 字段时，才生成 `reasoning` 事件；
- 来源只提供 summary 时，会保留并标记为 `kind: summary`；
- 来源没有提供、内容被加密或不可读取时，显示 `unavailable`；
- `unavailable` 不代表抓取失败，只表示来源没有给出可用的推理文本。

## 安装与启动（详细）

### 环境要求

- Node.js 20 或更高版本；
- npm；
- Windows、macOS 或 Linux；
- 若使用内置终端，需要 `node-pty` 能在当前系统正常安装。

### 快速启动

```powershell
git clone https://github.com/Riordon666/cc-trajectory-workbench.git
cd cc-trajectory-workbench
npm install
npm run workbench
```

浏览器打开：

```text
http://127.0.0.1:5177/
```

工作台页面、终端组件和字体相关资源均从本地加载，不依赖 CDN。

### 指定端口

```powershell
$env:WORKBENCH_PORT = '5180'
npm run workbench
```

也可以通过命令行参数指定端口：

```powershell
npm run workbench -- 5180
```

无论使用哪个端口，服务端都只监听 `127.0.0.1`。

## 第一次使用

推荐按照下面的顺序操作：

1. 执行 `npm run workbench` 并打开工作台；
2. 在左侧创建一个 Session，选择 Agent 类型；
3. 在 **A：Live Capture** 中选择 Gateway 或 Legacy 模式；
4. 点击开始记录；
5. 将 Agent/API 客户端的请求地址指向本地 Gateway，或者在内置终端中运行 Agent；
6. 完成任务后停止记录；
7. 如果本机存在 Claude Code 或 Codex CLI History，在工作台中发现并导入对应文件；
8. 在 **B：Session Explorer** 查看统一事件、模型名、文件和哈希；
9. 在 **D：Replay & Diagnostics** 按请求回放并查看异常；
10. 需要备份或分享调试材料时，导出 Session Bundle，并在分享前人工检查内容。

只导入 Agent History 也可以使用回放功能，不强制要求必须先经过 Gateway。

## Gateway 抓取模式

Gateway 是默认推荐模式。它不需要安装根证书，也不会充当任意网站的通用代理。

### 固定路由

| 协议 | 本地 Base URL | Gateway 最终接收的请求 |
|---|---|---|
| Anthropic Messages API | `http://127.0.0.1:5177/gateway/anthropic` | `POST /gateway/anthropic/v1/messages` |
| OpenAI Responses API | 客户端应配置到 `http://127.0.0.1:5177/gateway/openai/v1` | `POST /gateway/openai/v1/responses` |

不同 SDK 对“Base URL”是否包含 `/v1` 的约定可能不同。配置完成后，请确认客户端最终请求的完整路径与上表第三列完全一致。

Gateway 只接受这两个固定 POST 路由，不是可以访问任意目标的开放转发代理。

### 上游地址

不设置环境变量时，默认上游为：

- Anthropic：`https://api.anthropic.com`
- OpenAI：`https://api.openai.com`

需要使用兼容服务时，可以在启动工作台前覆盖上游 origin：

```powershell
$env:ANTHROPIC_UPSTREAM_BASE_URL = 'https://api.anthropic.com'
$env:OPENAI_UPSTREAM_BASE_URL = 'https://api.openai.com'
npm run workbench
```

上游配置只能是 HTTP(S) origin，不能包含账号密码、路径、查询参数或 fragment。例如应填写 `https://api.example.com`，不能填写 `https://user:pass@api.example.com/v1?key=xxx`。

### Session 路由

只有一个 Session 正在记录时，工作台会使用当前 Session。存在多个可能的 Session 时，客户端可以添加以下请求头：

```text
x-agent-trace-session: <session-id>
x-agent-trace-agent: claude-code | codex-cli
x-agent-trace-request: <optional-request-id>
```

这些内部路由请求头不会转发给真实上游。

### 凭证如何处理

API Key 仍由你的客户端通过正常请求头发送，Gateway 只是本地转发。写入抓取文件时，Authorization、API Key、Cookie 等已知敏感字段会被替换为 `[REDACTED]`。

脱敏器无法理解所有业务上下文。提示词、回复、文件内容和工具输出里仍然可能包含姓名、路径、源代码或其他秘密，因此导出后仍需人工检查。

## Advanced / Legacy MITM

当客户端完全无法修改 Base URL 时，可以使用旧的证书代理模式：

```powershell
npm run setup
npm run proxy
```

这一模式会：

- 在本机生成自签证书；
- 默认在 `127.0.0.1:8888` 启动正向代理；
- 通过代理环境变量接收 HTTP/HTTPS 流量；
- 将兼容抓取写入 Session 的 `https-intercepts.json`。

Legacy MITM 属于高级模式。证书、私钥和代理配置都只应在本机使用，不要提交或分享 `certs/`。如果客户端支持 Base URL，优先使用 Gateway。

## 导入本地 Agent History

### Claude Code

默认扫描：

```text
%USERPROFILE%\.claude\projects\**\*.jsonl
或
$HOME/.claude/projects/**/*.jsonl
```

适配器会读取用户消息、Assistant 消息、thinking、tool use、tool result、usage、模型标识和时间戳。只有 History 中确实存在 thinking 时才生成 reasoning。

### Codex CLI

默认扫描：

```text
%CODEX_HOME%\sessions\...
或
%USERPROFILE%\.codex\sessions\...
或
$HOME/.codex/sessions/...
```

只发现名称符合 `rollout-*.jsonl` 的文件。适配器会先检测格式版本，再转换 Session 元数据、请求、消息、reasoning summary、工具调用、工具结果、usage、取消和完成事件。

### 导入后的处理

- 原始 History 会复制到当前本地 Session 的 `agent-history.jsonl`；
- Claude Code 兼容路径还会保留 `claude-history.jsonl`；
- 转换后的事件会合并到 `events.jsonl`；
- 相同语义事件会去重；
- 原始未脱敏 Agent History 不会进入导出的 Session Bundle。

## 四个工作区

| 工作区 | 主色 | 关注点 | 适合什么时候用 |
|:---:|:---:|---|---|
| **A · Live Capture** | 蓝 | 捕获配置、实时状态、请求列表 | 开始一次新的 Agent 运行时 |
| **B · Session Explorer** | 粉 | 文件、事件、来源、模型与导入导出 | 想快速了解 Session 全貌时 |
| **C · Terminal** | 青 | 本机 Shell、工作目录与 Agent 命令 | 不想在工作台与终端之间来回切换时 |
| **D · Replay & Diagnostics** | 橙 | 逐轮回放、双源对齐与问题定位 | 追查“这一轮究竟发生了什么”时 |

### A：Live Capture

- 创建和选择 Session；
- 选择 Claude Code 或 Codex CLI；
- 选择 Anthropic Messages 或 OpenAI Responses 协议；
- 切换 Gateway / Legacy 捕获方式；
- 开始和停止记录；
- 查看本地 Gateway 地址、连接状态和抓取数量；
- 发现并导入本地 Agent History。

### B：Session Explorer

- 查看 Session 中的文件与生成状态；
- 按类型过滤统一事件；
- 查看事件来源、请求 ID、完整模型名和时间戳；
- 查看哈希和 Diagnostics 摘要；
- 导入或导出 Session Bundle；
- 将当前 Session 送入回放器。

### C：Terminal

- 在浏览器中使用本机 Shell；
- Windows 支持受限选择 PowerShell、CMD 或可用的 Bash；
- 工作目录必须位于允许的根目录内；
- WebSocket 只接受本机工作台的合法 Origin；
- 服务端限制终端尺寸、并发连接和输入消息大小。

可以通过 `TERMINAL_ALLOWED_ROOTS` 添加额外允许的工作目录，多个路径使用当前操作系统的路径分隔符。

### D：Replay & Diagnostics

- 按 request ID 组织时间线；
- 查看 user、assistant、reasoning、tool call、tool result 和 usage；
- 对比 Gateway 与 Agent History；
- 标记缺失请求、失败请求、中断、取消、模型不一致和工具不一致；
- 区分 `info`、`warning` 和 `error`；
- 即使存在 error，仍可继续查看和导出 Session。

## 统一事件模型

`events.jsonl` 每行是一个 JSON 对象，字段固定为：

| 字段 | 含义 |
|---|---|
| `schema_version` | 事件模型版本，当前为 `1.0` |
| `session_id` | 工作台 Session 标识 |
| `request_id` | 一次模型请求或 Agent turn 的标识 |
| `agent` | 事件所属 Agent，例如 `claude-code`、`codex-cli` |
| `provider` | 提供方，例如 `anthropic`、`openai` |
| `model` | 来源中观察到的完整模型标识 |
| `event_type` | 事件类型 |
| `timestamp` | ISO 8601 时间 |
| `content` | 与事件类型相关的数据 |
| `source` | 数据来源，例如 `gateway`、`agent-history` |

当前写入器支持以下事件类型：

| 事件类型 | 含义 |
|---|---|
| `session_start` | Session 开始或 History 元数据 |
| `session_end` | Session 结束 |
| `request_start` | 一次模型请求开始 |
| `user_message` | 用户输入 |
| `reasoning` | 来源明确提供的 reasoning、thinking 或 summary |
| `assistant_message` | Agent/模型回复 |
| `tool_call` | 工具调用 |
| `tool_result` | 工具执行结果 |
| `usage` | token 或用量信息 |
| `error` | 协议错误、请求失败、中断或取消 |
| `request_end` | 请求结束及完整性状态 |

示例：

```json
{
  "schema_version": "1.0",
  "session_id": "synthetic-demo",
  "request_id": "request-001",
  "agent": "codex-cli",
  "provider": "openai",
  "model": "gpt-synthetic-complete-model-name",
  "event_type": "assistant_message",
  "timestamp": "2026-01-01T00:00:02.000Z",
  "content": {
    "text": "这是合成示例，不是真实会话。"
  },
  "source": "agent-history"
}
```

详细适配器边界参见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## Diagnostics 与双源对齐

Diagnostics 的目标是帮助定位数据问题，不是判断 Session 是否“合格”。

可能出现的提示包括：

- 请求有 `request_start` 但缺少 `request_end`；
- 上游返回 HTTP 错误；
- 客户端主动取消或中途断开；
- tool call 找不到对应 tool result；
- Gateway 与 Agent History 的模型名、回复或工具结构不一致；
- reasoning 在某个来源中不可用；
- JSONL 尾部存在无法解析的损坏行；
- 未来版本的未知事件类型。

级别含义：

- **info**：说明当前数据状态，例如 reasoning unavailable；
- **warning**：数据可能不完整，但仍可使用；
- **error**：发现明确失败或结构问题。

任何级别都不会阻止用户查看、回放或导出自己的 Session。

## Session 文件与导出包

### 本地 Session 目录

```text
sessions/<session-id>/
├── config.json
├── events.jsonl
├── gateway-capture.jsonl
├── agent-history.jsonl
├── claude-history.jsonl          # Claude Code 兼容文件，存在时生成
├── diagnostics-result.json
├── https-intercepts.json         # 仅 Legacy MITM
└── bundle-manifest.json          # 导入 Bundle 后可能生成
```

这些文件是不同层次的数据：

- `gateway-capture.jsonl` / `https-intercepts.json` 是抓取来源；
- `agent-history.jsonl` 是导入到本地 Session 的 Agent 原始 History；
- `events.jsonl` 是经过 Adapter 归一化后的通用事件；
- `diagnostics-result.json` 是可重新生成的诊断结果。

不要把原始抓取文件和通用事件文件混为一种格式。

### Session Bundle

导出的 ZIP 至少包含：

```text
manifest.json
events.jsonl
diagnostics.json
hashes.json
```

存在抓取数据时，还可能包含：

```text
raw/gateway-capture.redacted.jsonl
raw/legacy-intercepts.redacted.json
```

Bundle 不包含证书、私钥和未脱敏的 Agent History。每个关键文件都有 SHA-256 哈希，用于发现文件被意外修改或损坏。

## 隐私与安全边界

### 默认保护

- 只监听 `127.0.0.1`；
- 无账号系统；
- 无云端存储；
- 无分析脚本和遥测；
- Gateway 只有固定路由；
- Gateway 上游地址会拒绝携带凭证、路径、查询和 fragment 的 URL；
- 终端 WebSocket 校验 Host 与 Origin；
- 已知密钥、Authorization、Cookie 等字段会脱敏；
- Session Bundle 不导出未脱敏 Agent History。

### 永远不要提交

```text
sessions/
certs/
local-private/
local-data/
node_modules/
*.log
真实 API 抓取
真实 Agent History
API Key、Token、Cookie、证书私钥
```

这些路径已经配置在 `.gitignore` 中，但 Git 忽略规则不能替代人工检查。

### 分享前必须检查

自动脱敏主要识别凭证模式，不是通用隐私清洗器。分享 Bundle 前应检查：

- 用户提示词和模型回复；
- 源代码与补丁；
- 本机绝对路径和用户名；
- 工具参数、命令输出和环境信息；
- 数据库地址、内部域名和业务标识；
- 任何上下文相关的秘密。

完整说明参见 [docs/PRIVACY.md](docs/PRIVACY.md) 和 [SECURITY.md](SECURITY.md)。

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `WORKBENCH_PORT` | `5177` | 工作台端口 |
| `WORKBENCH_SESSIONS_DIR` | 仓库下的 `sessions/` | 自定义本地 Session 根目录 |
| `ANTHROPIC_UPSTREAM_BASE_URL` | `https://api.anthropic.com` | Anthropic Gateway 上游 origin |
| `OPENAI_UPSTREAM_BASE_URL` | `https://api.openai.com` | OpenAI Gateway 上游 origin |
| `TERMINAL_ALLOWED_ROOTS` | 项目允许的默认根目录 | 添加终端允许进入的本地目录 |
| `CODEX_HOME` | `%USERPROFILE%\.codex` 或 `$HOME/.codex` | Codex CLI 数据根目录 |
| `PROXY_PORT` | `8888` | Legacy MITM 代理端口 |
| `TARGET_HOST` | 空 | Legacy MITM 限定拦截域名 |

可以复制 [.env.example](.env.example) 作为配置参考。项目不会自动把 API Key 写入该文件。

## 项目结构

```text
cc-trajectory-workbench/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   └── workflows/ci.yml
├── docs/
│   ├── ARCHITECTURE.md
│   ├── PRIVACY.md
│   ├── RELEASE_CHECKLIST.md
│   └── screenshots/
├── test/                         # 只使用合成 fixture
├── workbench/
│   ├── adapters/
│   │   ├── agents/               # Claude Code、Codex CLI
│   │   └── protocols/            # Anthropic Messages、OpenAI Responses
│   ├── core/                     # 事件、诊断、哈希、脱敏、Bundle、存储
│   ├── lib/                      # 双源对齐等共享逻辑
│   ├── server/
│   │   ├── app.js                # HTTP API 与 Session 编排
│   │   ├── gateway.js            # 固定路由 Gateway
│   │   └── terminal.js           # 本地 PTY 与 WebSocket 边界
│   ├── public/
│   │   ├── pic/                  # 动漫壁纸与 wallpapers.json
│   │   ├── vendor/               # 本地 xterm 资源及许可证
│   │   ├── app.js
│   │   ├── index.html
│   │   └── styles.css
│   └── server.js                 # 轻量启动入口
├── forward-proxy.js              # Advanced / Legacy MITM
├── setup-https-proxy.js           # 本地证书生成
├── package.json
└── README.md
```

## 开发与测试

安装依赖：

```powershell
npm install
```

运行完整检查：

```powershell
npm run check
```

该命令会检查主要 JavaScript 文件语法并运行所有 Node.js 测试。

也可以分别运行：

```powershell
npm test
npm audit --audit-level=high
git diff --check
```

测试范围包括：

- 通用事件模型；
- Anthropic/OpenAI 流式与非流式解析；
- Claude Code/Codex CLI History 转换；
- Gateway 转发和上游安全限制；
- 双源对齐；
- 脱敏、哈希、Bundle 导入导出；
- 事件存储崩溃恢复；
- 终端 Origin、Shell、CWD 和尺寸边界。

所有测试和示例都必须使用合成数据。贡献说明参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 已知限制

- 首版只支持 Claude Code、Codex CLI、Anthropic Messages API 和 OpenAI Responses API；
- Agent 本地 History 格式可能随 CLI 版本变化，无法识别的版本会报告兼容性信息；
- Codex CLI 的 reasoning 通常可能只有 summary，不能把 summary 当作完整私有思维链；
- Gateway 当前只提供 `/v1/messages` 和 `/v1/responses` 两个固定目标；
- 大型 Session 的虚拟列表、全文搜索和横向 Session 对比仍在规划中；
- 自动脱敏无法保证移除提示词或工具输出中的所有业务秘密；
- Legacy MITM 依赖本机证书环境，不同客户端的代理兼容性可能不同；
- 真实 Anthropic/OpenAI 服务联调需要用户自己的凭证，并可能产生 API 费用。

后续方向参见 [ROADMAP.md](ROADMAP.md)。

## 常见问题

### 为什么没有看到 reasoning？

来源没有提供可读取的 reasoning，或者只提供了 summary。工作台会显示 `unavailable`，不会根据最终回复自动编造。

### Diagnostics 出现 error，还能导出吗？

可以。Diagnostics 是非阻断提示；数据是否不完整由用户判断，工作台不会扣留用户自己的 Session。

### 为什么 Gateway 没抓到请求？

依次检查：

1. 工作台是否正在记录正确的 Session；
2. 客户端最终请求路径是否与 Gateway 固定路由一致；
3. 工作台端口是否被修改；
4. 多 Session 时是否发送了正确的 `x-agent-trace-session`；
5. 客户端是否绕过了自定义 Base URL；
6. 上游 origin 是否符合安全限制。

### 可以只导入已有 Session，不重新抓取吗？

可以。Session Explorer 支持发现和导入本机 Claude Code/Codex CLI History，也支持导入由工作台导出的 Bundle。

### 工作台会上传我的对话吗？

不会主动上传。工作台没有云服务和遥测。只有当你主动通过 Gateway 调用真实模型 API 时，请求才会被转发到你配置的上游提供方。

### 能在局域网给其他电脑使用吗？

默认不能，也不建议直接这样做。服务端固定监听 `127.0.0.1`，这是本项目的安全边界之一。

### `master` 和 `main` 有什么区别？

`main` 是当前 Agent Trace Workbench 开源版本；`master` 保留改造前的旧版本历史。

## 参与项目

- 提交 Bug 或建议：[GitHub Issues](https://github.com/Riordon666/cc-trajectory-workbench/issues)
- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- 安全问题：[SECURITY.md](SECURITY.md)
- 版本记录：[CHANGELOG.md](CHANGELOG.md)
- 发布检查：[docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)

## 许可证与壁纸

项目代码采用 [MIT License](LICENSE)。

仓库所有者已确认，项目内置的 22 张动漫图片可以随 Agent Trace Workbench 公开分发。除非单个资源另有明确说明，这些图片不自动适用项目的软件 MIT License。资源清单、来源线索和声明参见：

- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- [workbench/public/pic/wallpapers.json](workbench/public/pic/wallpapers.json)

---

如果你希望观察一个 Coding Agent 实际做了什么，而不是只看它最后说了什么，Agent Trace Workbench 就是为这个场景准备的。
