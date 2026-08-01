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

### 📌 Type: `story` (Jira)

Same URLs, same key format, different prompt — `prompts/story.md`.

| Parameter | Configuration |
| :--- | :--- |
| **Workspace Type** | `story` |
| **URL Patterns** | *(none)* — see below |
| **Entity Key** | Jira Work Item ID |
| **MCP Tools** | Official Atlassian MCP Server tools |
| **Initial Prompt File** | `prompts/story.md` |

### 🔎 Why Jira types need a lookup

A Jira issue URL does not carry the issue's type: `…/browse/KAN-5` is
byte-identical whether `KAN-5` is a **Task** or a **Story**. URL matching alone
therefore cannot choose between the `task` and `story` workspace types.

So `story` deliberately registers **no URL patterns**. Every Jira issue URL
matches `task` first, and that match is then *refined* by asking Jira for the
issue's real `issuetype`:

```
URL ──match──> task (provisional) ──ask Jira──> issuetype name ──map──> task | story
```

The mapping lives in one place in `daemon/src/registry.ts`, as data:

| Jira issue type | Workspace type |
| :--- | :--- |
| `Story` | `story` |
| `Task`, `Bug`, `Epic`, `Subtask`, anything unrecognised | `task` |
| *lookup unavailable or failed* | `task` |

**Resolution is asynchronous** as a result (`registry.resolve()` returns a
Promise). Board-URL handling and its precedence are unchanged: a bare board URL
is still `manage`, and a board URL carrying `&selectedIssue=KEY` is still an
opened issue and still wins over `manage` — it simply now resolves to `task` or
`story` per the lookup.

### 🔐 The Jira credential, and degrading without one

The lookup needs read access to Jira, which the daemon did not previously have.
The user supplies an **Atlassian API token** (site URL + account email + token)
on the extension's **Settings** page. Design constraints, all deliberate:

- **Read-only, one operation.** `daemon/src/jira.ts` can fetch an issue's type
  and validate a credential. There are no write methods, and none should be
  added: agents already hold their own scoped interactive auth for writes.
  Prefer a **scoped** token limited to `read:jira-work` over a classic
  full-permission one.
- **The token travels user → settings UI → daemon and stops.** The daemon
  stores it in the OS keyring where one is available (libsecret / `secret-tool`,
  secret passed on stdin, never argv), otherwise in a `0600` file. The
  extension keeps only *configured / not configured* and a way to clear it.
- **Write-only field.** The token is never rendered back, not even masked.
- **The storage backend is disclosed before the token is typed,** not after it
  has been handed over. Which backend you get depends on whether a working
  keyring is present, which is invisible from outside the machine; the settings
  page probes for it and says which one this machine will use, with the file
  path when it is the file.
- **Validated at submit time,** so a wrong token fails visibly then rather than
  silently months later as a mysterious fallback to `task`. Two reads, and the
  order matters: `/rest/api/3/myself` for the account name, then — only if that
  returns 401/403 — `/rest/api/3/project/search` for the verdict. `/myself`
  needs `read:jira-user`, which is *not* the scope this page asks for, so
  treating it as the verdict rejected correctly-scoped tokens (KAN-31). The
  work probe runs under `read:jira-work`, which is what Butchr's one real
  operation actually needs.
- **A rejection says which leg refused it.** `TokenJiraTransport` tries the
  scoped-token gateway (`api.atlassian.com/ex/jira/{cloudId}`) and falls back
  to the site host; the cloud-ID lookup before either is unauthenticated. Each
  leg is recorded — endpoint, status, Atlassian's own wording, trace id — and
  the message names the decisive one. "Could not reach your site", "the token
  authenticated but lacks `read:jira-work`", and "your site rejected this email
  and token" are different diagnoses with different fixes, and collapsing them
  into a single 401 is what made the original report undebuggable.
- **Nothing derived from the token reaches a message, a log line, or a
  response.** Every string built from a response is scrubbed of the raw token,
  the Basic-auth base64, its percent-encoding, and a leading slice (for a host
  that echoes back a *truncated* token) — and scrubbed **before** it is
  truncated for display, since truncating first defeats whole-value matching.
  `daemon/scripts/verify-jira-credential-diagnostics.mjs` and
  `verify-jira-log-hygiene.mjs` prove both properties against stubs, with no
  real credential.
- **Everything degrades to `task`.** No token, expired token, rate limit,
  network down, 404, timeout, unknown type — all resolve to `task` within a
  hard ~2s timeout, and activation succeeds exactly as before. (Validation is
  the exception: it runs once, interactively, with a spinner the user asked
  for, so it gets a much longer deadline. Holding it to the background budget
  reported "Atlassian did not respond" for credentials that were merely on a
  slow link.) A user who never
  configures a credential notices nothing except that Stories open as `task`
  workspaces. Successful lookups are cached per issue key, and a failure starts
  a short cooldown so an unreachable Jira costs the timeout once rather than on
  every tab change.

`JiraTransport` is the seam for replacing token auth with OAuth 2.0 3LO later:
the client depends on *something that can authenticate a Jira read*, not on a
token string.

---

## 🧮 How many agents this machine will carry

The cap exists because seven agents on a 4-core laptop made the desktop
unusable and nothing in Butchr knew. It is derived from the hardware rather
than declared, so the answer travels: see
[`daemon/src/capacity.ts`](../daemon/src/capacity.ts), and
`node daemon/scripts/verify-agent-capacity.mjs` for the derivation with the
numbers behind it.

**`cap` counts task agents.** Two things that are not work are charged before
the cap is worked out rather than against it:

- **the herdr server** — 0.5 core, always present;
- **the board manager** — one agent's worth of core and memory. It is
  infrastructure that hands work out, not work. Counting it meant a 4-core
  machine could run one task agent and refused every activation after it.

The daemon's own fallback shell (`butchr-default-workspace`) is not counted at
all: it appears in `list_agents` because a session exists for it, but a shell
costs nothing like an agent.

**What an agent costs** is two measured numbers, `MEASURED_AGENT_COST`, and an
agent is a process *tree* — the `claude` process plus the MCP servers it starts.
Re-measure with `node daemon/scripts/measure-agent-cost.mjs [seconds]` before
arguing with them. Four environment variables override the derivation:

| variable | effect |
| --- | --- |
| `BUTCHR_MAX_AGENTS` | sets the cap outright, skipping the derivation |
| `BUTCHR_AGENT_MEMORY_MB` | resident cost of one agent tree |
| `BUTCHR_AGENT_CORES` | load-average cost of one active agent |
| `BUTCHR_SUPERVISOR_AGENTS` | supervisor slots reserved; `0` for a fleet with no board manager |

**Headroom is a different question from the cap** and is answered three ways —
count, 1-minute load average, available memory — with the smallest winning.

**A refusal always says why.** `butchr_capacity` and the MCP activate path
return the reason, the figures and the full derivation; the sidepanel renders
the reason and figures under the toggle with the derivation behind a
disclosure, and offers **Start anyway**, which is recorded with the numbers as
they stood. Re-attaching to an agent that is already running is never gated:
it starts nothing and costs nothing.

---

## 🕰️ Is this the code that was merged?

Merging a PR changes nothing on the machine: the clone is not pulled, `dist/`
does not rebuild, Chrome does not reload the unpacked extension. Since that
turns a live daemon into unreliable evidence — for a human debugging and for an
agent proving its work — the daemon checks four things at startup and on
demand: local `HEAD` against `origin/main` as last fetched, `daemon/dist`
against `daemon/src`, the running process against `daemon/dist`, and
`extension/dist` against the extension sources. Every verdict carries the
commit or the mtime it was decided on.

It **reports and never acts**: no pulling, no rebuilding, no restarting, no
refusing to start. Stale states are shown as a banner on the Agents page (which
already polls `list_agents`, so the report rides along), returned by
`{"action": "staleness_check"}` on the socket, and by the MCP tool
`butchr_staleness_check`, which flags an error response when the install is
stale so an agent must decide to ignore it. A fresh install shows nothing.

Full reasoning — surface choice, why it warns rather than blocks, and how it
avoids firing at agent worktrees and unrelated branches — is in
[docs/staleness.md](staleness.md).

---

## 📄 Prompt Templates (`prompts/*.md`)

All workspace initial prompts are stored as plain Markdown (`.md`) files in the local service configuration directory. This design allows users and developers to tweak, inspect, and refine agent prompts without recompiling code.

### The `task` Prompt: [`prompts/task.md`](../prompts/task.md)

The canonical prompt lives in [`prompts/task.md`](../prompts/task.md) — see that file rather than an embedded copy here, so the two cannot drift. In outline: the agent reads the Jira task via Atlassian MCP tools, maintains a shared clone cache under `~/code/<org>/<repo>` (fetch-only, safe for concurrent agents), creates a per-task git worktree **inside its workspace directory** on a `butchr/{{KEY}}` branch, does the work there, and reports back to Jira. Keeping all work inside the workspace is what makes workspace reset a full cleanup.

### The `story` Prompt: [`prompts/story.md`](../prompts/story.md)

A story agent **decomposes; it never builds**. It reads the story, reads the
repository (read-only — no branch, no commit, no PR), and files the set of Jira
Tasks that deliver the story, each one well-formed enough for an agent to
execute unattended.

**Tasks implement stories.** Story and Task sit at the same hierarchy level in a
team-managed project, so a task cannot be a *child* of a story; the relationship
is recorded as an `Implements` issue link (task → story) plus an explicit line
in each task's description. Where a site has no `Implements` link type
configured, the agent falls back to `Blocks` and reports that it did.

It does **not** activate agents for the tasks it files — agent lifecycle belongs
to the board manager (`prompts/manage.md`). Its handoff is the filed, linked
ticket on the board.

Nothing in the daemon depends on any of this: the prompt is read from disk at
activation, so it is the human's to iterate on.

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
                                   │ Native Messaging (stdio, length-prefixed JSON)
┌──────────────────────────────────▼─────────────────────────────────────┐
│                        LOCAL SERVICE LAYER                             │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                       Butchr Local Daemon                      │   │
│   │                                                                │   │
│   │   - Workspace Type Registry (`task`, `story`, `manage`)        │   │
│   │   - Prompt File Loader (`prompts/task.md`)                     │   │
│   │   - Read-only Jira client (issue type -> workspace type)       │   │
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
- **Communication:** Chrome Native Messaging (`chrome.runtime.connectNative`) to the Local Daemon over stdio.

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
- [x] Implement Native Messaging protocol between extension and daemon (stdio, 4-byte LE length-prefixed JSON). Chrome spawns a thin per-profile native-host proxy; a single long-lived daemon owns all sessions and listens on a Unix domain socket (`~/.local/share/butchr/butchr.sock`, NDJSON, id-correlated) used by both the proxies and the Butchr MCP server. The daemon is auto-spawned by the first client that needs it.


