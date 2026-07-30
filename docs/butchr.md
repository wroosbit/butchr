# Butchr - Chrome Extension & Agent Pairing Architecture

> **Status:** Active Specification  
> **Date:** July 29, 2026  
> **Overview:** Butchr is a Chrome Extension that connects to a local service managing **herdr** (an agent terminal runtime). It maintains specialized AI agents in Herdr bound to specific web pages where Butchr is activated, starting with Jira tasks.

---

## 💡 System Overview & Concept

- **Name:** Butchr
- **Tagline:** Modular Workspace Agent Orchestration for Web & Terminal
- **Architecture Model:** Client-Server Hybrid (Chrome Extension <-> Local Daemon Service <-> Herdr Agent Terminal)
- **Core Concept:** 
  - Butchr is **not** a generic page scraper or arbitrary content reader. Instead, it operates on a structured **Workspace Type** architecture.
  - When Butchr is activated on a supported page, it identifies the page's Workspace Type, extracts the entity key (e.g. Jira Work Item ID), provisions specialized MCP tools, loads an initial prompt from a Markdown file, and spawns/pairs a dedicated agent in **Herdr**.

---

## 🧩 Workspace Types Architecture

Rather than extracting arbitrary page content, Butchr delegates entity fetching and actions to **MCP (Model Context Protocol) tools** tied to distinct **Workspace Types**.

Each Workspace Type configures:
1. **URL Matching & Key Extraction:** Rule to identify if a page matches the type and extract its unique key.
2. **MCP Tools:** Official or custom MCP toolsets attached to the agent environment.
3. **Initial Prompt (`.md` file):** A dedicated Markdown file containing the initial prompt for the agent, making prompt engineering clean, versionable, and easy to iterate on.

### 📌 Initial Supported Type: `task` (Jira)

| Parameter | Configuration |
| :--- | :--- |
| **Workspace Type** | `task` |
| **Target Platform** | Jira (`https://*.atlassian.net/browse/*` or `/jira/*`) |
| **Entity Key** | Jira Work Item ID (e.g., `PROJ-1234`) |
| **MCP Tools** | Official Atlassian MCP Server tools (e.g., Jira issue fetcher, comments, issue updater) |
| **Initial Prompt File** | `prompts/task.md` |

---

## 📄 Prompt Templates (`prompts/*.md`)

All workspace initial prompts are stored as plain Markdown (`.md`) files in the local service configuration directory. This design allows users and developers to tweak, inspect, and refine agent prompts without recompiling code.

### Example Prompt: `prompts/task.md`

```markdown
# Task Agent System Prompt (Jira)

You are an autonomous coding agent managed by **Herdr** for Jira Task: **{{KEY}}**.

## 🚀 Execution Instructions

### 1. Jira Task Retrieval
- Use the official Atlassian MCP tools to read the Jira task **{{KEY}}** (summary, description, acceptance criteria, associated organization/repository info, and comments).

### 2. Environment & Repository Setup
- **Directory Verification:** Check if the `~/code` directory exists. If it does not exist, create it (`mkdir -p ~/code`).
- **Repository Check & Clone:** Check if the required repository exists at `~/code/<org>/<repo>`. If it does not exist, clone it into `~/code/<org>/<repo>`.
- **Git Worktree Creation:**
  - Before starting work on the repository, ensure the `main` branch is up-to-date (`git checkout main && git pull origin main`).
  - Create a new git worktree in `/` (e.g., `/<repo>-{{KEY}}`) off the updated `main` branch.

### 3. Task Execution & Resolution
- Change directory into the created worktree in `/`.
- Execute the required code changes, feature additions, or bug fixes based on the Jira task description.
- Run tests and linting to verify implementation correctness.
- Post progress updates or completion status back to the Jira issue via Atlassian MCP tools.
```

---

## 🏗️ High-Level System Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                             BROWSER LAYER                              │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                       Butchr Chrome Ext                        │   │
│   │                                                                │   │
│   │   1. Detect URL -> Matched Workspace Type (`task`)              │   │
│   │   2. Extract Key (`PROJ-1234`)                                 │   │
│   │   3. Send Activation Request to Local Daemon                       │   │
│   └──────────────────────────────┬─────────────────────────────────┘   │
└──────────────────────────────────┼─────────────────────────────────────┘
                                   │ WebSocket / HTTP (localhost:9182)
┌──────────────────────────────────▼─────────────────────────────────────┐
│                        LOCAL SERVICE LAYER                             │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                       Butchr Local Daemon                      │   │
│   │                                                                │   │
│   │   - Workspace Type Registry (`task`, etc.)                     │   │
│   │   - Prompt File Loader (`prompts/task.md`)                     │   │
│   │   - MCP Configuration Manager (Atlassian MCP Server)           │   │
│   │   - Herdr Session Spawner & Bridge                             │   │
│   └──────────────────────────────┬─────────────────────────────────┘   │
└──────────────────────────────────┼─────────────────────────────────────┘
                                   │ IPC / CLI Invocations
┌──────────────────────────────────▼─────────────────────────────────────┐
│                        HERDR TERMINAL LAYER                            │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                      Herdr Agent Terminal                      │   │
│   │                                                                │   │
│   │   ┌────────────────────────────────────────────────────────┐   │   │
│   │   │ Agent Instance (Key: PROJ-1234)                        │   │   │
│   │   │  - Tools: Atlassian MCP, Terminal Execution, Git       │   │   │
│   │   │  - Initial Prompt: Rendered `prompts/task.md`          │   │   │
│   │   └────────────────────────────────────────────────────────┘   │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🎯 Key Benefits of This Architecture

1. **Clean & Reliable Data Fetching:** Uses official MCP tools (e.g. Atlassian API) instead of fragile DOM scraping or unstructured text extractions.
2. **Extensible Workspace Registry:** Adding support for new platforms (e.g. GitHub PRs, Figma designs, Zendesk tickets) only requires registering a new Workspace Type, MCP server, key extractor, and `.md` prompt file.
3. **Editable Prompts:** Prompts are decoupled from extension logic and maintained in Markdown files for fast experimentation.

---

## ✨ Core Features (V1 / MVP)

- [x] **Chrome Native Messaging Bridge:** Secure IPC communication via `chrome.runtime.connectNative` over `stdio` (binary length-prefixed JSON), replacing open network sockets.
- [ ] **Jira Page Recognition & Key Extractor:** Automatically parses Jira issue IDs from current active tab URL.
- [ ] **Workspace Type Resolver:** Maps Jira URLs to the `task` Workspace Type.
- [ ] **Markdown Prompt Engine:** Reads `prompts/task.md` and interpolates variables (`{{KEY}}`, etc.).
- [ ] **Atlassian MCP Integration:** Spawns Herdr agent configured with official Atlassian MCP tools for Jira issue interaction.
- [ ] **Agent Terminal Pairing:** Spawns/attaches a Herdr agent terminal tab for the active Jira key.
- [x] **Running Agents View:** Dedicated `Agents` tab in Butchr extension UI listing all active Herdr agent sessions with direct clickable links to open their target web pages in Chrome.

---

## 🛠️ Proposed Tech Stack

### Chrome Extension (Butchr)
- **Framework:** Manifest V3 JavaScript/TypeScript
- **UI:** Extension Popup / Sidepanel showing active Workspace Type (`task`), Key (`PROJ-1234`), and agent connection status.
- **Communication:** WebSockets to Local Daemon (`ws://127.0.0.1:9182`).

### Local Service Daemon
- **Runtime:** Node.js / TypeScript daemon process.
- **Config Storage:** JSON registry for Workspace Types + `prompts/` directory for `.md` files.
- **MCP Orchestration:** FastMCP / MCP SDK for managing Atlassian MCP tool bindings.

### Herdr Agent Terminal
- **CLI / Terminal Engine:** Ink (React CLI) or Blessed terminal orchestrator.
- **LLM Integration:** Anthropic Claude / OpenAI / Local LLMs with tool-calling capabilities.

---

## 🔄 Sequence Workflow: Activating Butchr on Jira

1. **User Action:** User navigates to Jira issue `https://company.atlassian.net/browse/PROJ-1234` and clicks **Activate Butchr**.
2. **Match & Extract:** Butchr Extension identifies domain as Jira, resolves Workspace Type to `task`, and extracts Key `PROJ-1234`.
3. **Daemon Request:** Extension sends payload `{ type: "task", key: "PROJ-1234" }` to Local Daemon.
4. **Prompt & MCP Load:** Local Daemon reads `prompts/task.md`, interpolates `{{KEY}} = "PROJ-1234"`, and attaches Atlassian MCP server config.
5. **Herdr Spawn:** Local Daemon runs `herdr spawn --type=task --key=PROJ-1234 --prompt-file=prompts/task.md`.
6. **Agent Execution:** Herdr agent initializes, calls Atlassian MCP tools to read `PROJ-1234` details, and starts working on the task in terminal workspace.

---

## 📝 Next Steps & Implementation Checklist

- [ ] Create `prompts/task.md` template for Jira task execution.
- [ ] Implement Workspace Type registry in Local Daemon (`types.json` or code registry).
- [ ] Build Jira URL key extractor regex in Chrome Extension (`/browse/([A-Z0-9]+-\d+)`).
- [ ] Integrate Atlassian MCP server definitions into Herdr agent launcher.
- [ ] Implement WebSocket protocol between extension and daemon (`ws://127.0.0.1:9182`).


