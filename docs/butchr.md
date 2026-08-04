# Butchr - Chrome Extension & Agent Pairing Architecture

> **Status:** Active Specification  
> **Date:** July 29, 2026  
> **Overview:** Butchr is a Chrome Extension that connects to a local service managing **herdr** (an agent terminal runtime). It maintains specialized AI agents in Herdr bound to specific web pages where Butchr is activated, starting with Jira tasks.  
> **Layer boundary:** the orchestration half of that local service is moving to
> **CrabCast**. Read *The layer boundary — Butchr and CrabCast* first; the rest
> of this document describes the system as it ships **today**, before that
> cutover, and passages the boundary contradicts are marked as such.

---

## 💡 System Overview & Concept

- **Name:** Butchr
- **Tagline:** Modular Workspace Agent Orchestration for Web & Terminal
- **Architecture Model:** Client-Server Hybrid (Chrome Extension <-> Local Daemon Service <-> Herdr Agent Terminal)
- **Core Concept:** 
  - Butchr is **not** a generic page scraper or arbitrary content reader. Instead, it operates on a structured **Workspace Type** architecture.
  - When Butchr is activated on a supported page, it identifies the page's Workspace Type, extracts the entity key (e.g. Jira Work Item ID), provisions specialized MCP tools, loads an initial prompt from a Markdown file, and spawns/pairs a dedicated agent in **Herdr**.

---

## 🧱 The layer boundary — Butchr and CrabCast

> **Decided by the human on 2026-08-03**, live with the epic agent, and recorded
> here from [KAN-104](https://wroosbit.atlassian.net/browse/KAN-104) comments
> **10363** (decisions 1–3) and **10371** (decisions 4–6). Those comments stay
> authoritative if this summary and they ever disagree.
> **None of it is built yet:** the sections below this one describe the daemon as
> it ships today, driving herdr directly. The cutover is a later story.

**CrabCast** (`wroosbit/crabcast`) is the sibling orchestration runtime Butchr is
adopting. It spawns and attaches agents, gates them on capacity, orders them by
priority, preempts with consent, keeps a durable registry across restarts and
assembles each agent's MCP config — all of which Butchr owns today, so the two
repositories own it twice over. The justification for adopting was to **stop
owning that code**, and the question this boundary answers is which layer keeps
which job.

Each decision is recorded with the alternatives that were rejected and why. A
boundary that records only what was chosen cannot be argued with later, and being
able to argue with it later is the whole point of writing it down.

The per-module keep/move/split assessment that these decisions were taken
against is KAN-105's, and lives on KAN-104; it is not restated here.

### Decision 1 — Butchr keeps its own daemon

Two long-lived processes. **Butchr's daemon** owns URL→type resolution,
integrations and credentials, the Jira poller and assignee routing, and
staleness. It **calls CrabCast's socket** for spawn, attach, verified
activation, capacity, priority, preemption, the durable registry and MCP
assembly.

* _Rejected — Butchr as a CrabCast plugin._ It would need a far richer
  in-process contract than a plugin API wants to carry — modules with their own
  state, outbound HTTP, timers — and it couples every Butchr release to their
  plugin API.
* _Rejected — the extension plus a thin client, with no Butchr server at all._
  It collides with two things this repo already holds: the credential invariant
  that a token never lives in the browser, and the assignee-routing poller,
  which has to run when Chrome is closed — something an MV3 service worker
  cannot promise.

### Decision 2 — CrabCast never learns Butchr's workspace types

Butchr resolves **URL → path itself** and hands CrabCast a **fully-specified
spawn request**: path, priority number, gate flags, prompt file, MCP servers.
CrabCast never sees `epic`, never calls Jira, and needs no refine hook, no
fallback type and no credential adapter for us.

This **retracts the advice Butchr gave CrabCast** on KAN-59, that behavioural
extension points were their number-one adoption blocker. That is true only under
the rejected option where CrabCast owns resolution; under this boundary their
original config-shaped model plus an attribute-carrying spawn call is
sufficient. The retraction was sent immediately rather than at the end of the
exercise, because their KAN-103 was mid-design and would otherwise have built
the wrong thing.

* _Rejected — types as data-only registration._ It keeps CrabCast's own surfaces
  meaningful, but it puts the type list in two places, where it can drift.

**Accepted cost:** CrabCast's CLI and fleet output show **paths** rather than
typed names for Butchr-spawned agents, since Butchr holds the vocabulary and
re-labels everything CrabCast reports. Flagged to them as the consequence: row
identity must be stable and path-keyed, and they may want an optional opaque
label on spawn purely for their own reporting.

### Decision 3 — agents get Butchr's MCP only; Butchr proxies CrabCast

Agents keep speaking `butchr_activate_agent {type, key}` and the rest of the
existing surface. **Every existing prompt stays valid**, and agents never see a
path. Butchr's daemon proxies fleet operations to CrabCast and re-labels paths
back into type/key on the way out.

* _Rejected — both MCP servers, split by concern._ No proxy to maintain and
  CrabCast's new features arrive free, but it puts two vocabularies in one
  prompt and forces agents to know when a path applies and when a type/key does
  — exactly the kind of seam agents get wrong.
* _Rejected — CrabCast's MCP only._ The thinnest Butchr, but it rewrites every
  prompt around paths and costs the supervision model the vocabulary it is
  written in.

**Accepted cost:** we own and version a proxy over CrabCast's API indefinitely,
and each new CrabCast capability is invisible to agents until we wrap it.

### Decision 4 — CrabCast is a hard dependency; Butchr's orchestration is deleted at cutover

The cutover PR adds the CrabCast client and removes Butchr's herdr bridge,
launchers, capacity and cost measurement, priority, durable registry, reconcile
and socket transport. **Butchr will not start without CrabCast.**

The reasoning, in the frame of the adoption decision itself: the justification
for adopting was to stop owning this code, and a fallback never collects it.

* _Rejected — a permanent fallback._ The most resilient option, but we would own
  both paths, both sets of proofs and the switch, forever — the reason for
  adopting never banked.
* _Rejected — staged, with a named deletion condition._ Safe rollback and a
  scheduled deletion; declined in favour of banking the win immediately.

**Accepted cost, stated plainly: there is no rollback.** A bad CrabCast release
or an unfixed bug is a Butchr outage, and we debug someone else's daemon.

### Decision 5 — one gate condition: Butchr's own verify suite green against CrabCast

Butchr's own proofs — activation honesty, capacity refusals, preemption consent,
restart survival, the five generations of `success: true` — re-run with CrabCast
as the orchestrator and pass. Behaviour parity **demonstrated by our scripts**,
not asserted by their claims.

Three heavier gates were considered and explicitly **not** required:

* _Rejected — a published, pinnable CrabCast artifact._
* _Rejected — a documented contract carrying a compatibility promise._
* _Rejected — a full-fleet rehearsal before cutover._

The reason all three were declined is the same: they are packaging discipline
for third parties, and Butchr is CrabCast's only consumer with one owner across
both repositories. The condition chosen is the one that proves behaviour rather
than process. Its
consequence is that all compatibility risk lands on that suite — which is what
the first carried mitigation below answers.

### Decision 6 — linked local checkout (`file:../crabcast`)

Edit CrabCast, restart Butchr's daemon, the change is live. No release ceremony
while both repositories move fast.

* _Rejected — a pinned submodule._ Every build would name its CrabCast and
  updates would be reviewed; declined as too slow a loop.
* _Rejected — a private registry._ It reintroduces exactly the ceremony
  decision 5 declined.

### What the six settle by implication

No separate decision was needed for any of these — each follows from the six.

* **Prompts stay Butchr's.** Decision 2 passes `promptFile` in the spawn request,
  so CrabCast reads a file we name and has no prompt model of its own.
* **Butchr keeps per-agent state keyed by path**, because re-labelling anything
  CrabCast reports requires a path → ticket map.
* **The Agents page stays Butchr's.** It renders type/key, the org chart and the
  integrations, none of which CrabCast will know about.
* **The verify suite is kept and re-pointed**, not deleted, since decision 5
  makes it the gate.

### Carried mitigations — standing unless the human objects

Both of these come from the epic rather than from the human, and both
**stand unless the human objects** — they are not the human's decisions and are
not numbered among the six.

* **The verify suite must run in CI against CrabCast on every PR, not once at
  cutover.** Decision 5 makes that suite the only compatibility signal, and
  decision 4 makes undetected breakage a full outage rather than a degraded
  mode. Worth pairing with the fact KAN-105 established: CI today runs only
  `daemon-typecheck` and `extension-build`, and gates no verify script at all.
* **The staleness checker must learn to report CrabCast's checkout** — its
  commit, whether it is dirty or clean, and whether its built output is newer
  than its sources. Decisions 4, 5 and 6 compose into a fleet that an
  uncommitted edit in a sibling directory can break, with no version identifying
  what is running and no fallback to retreat to. Extending the checker restores
  the "which CrabCast am I running" answer that decision 6 gives up, with no
  publish step and no version discipline, and it fails in the direction this
  repo already trusts: it reports, and never acts (see *Is this the code that
  was merged?* below).

### Still open

**Who owns "what would this agent lose if stopped now"** —
[`daemon/src/work-state.ts`](../daemon/src/work-state.ts), KAN-105's Q4. The
module is git-only and names no tracker, no URL and no issue key, which argues
it belongs to whoever owns stopping agents; its only consumer is the Chrome
Agents page, which is unambiguously Butchr's. CrabCast has no pre-stop check of
any kind today. The six decisions do not settle it, and it is not settled here.

---

## 🧩 Workspace Types Architecture

Rather than extracting arbitrary page content, Butchr delegates entity fetching and actions to **MCP (Model Context Protocol) tools** tied to distinct **Workspace Types**.

**An integration owns its workspace types.** The unit of extension is an
*integration* — one outside system: its id and display name, the workspace
types it contributes, the credential that reaches it, the MCP servers its
agents get, and whether it is switched on
(`daemon/src/integrations/integration.ts`). **Atlassian** is the first
(`integrations/atlassian-integration.ts`, contributing `task`, `story` and
`epic`, and owning the `atlassian` MCP server); LaunchDarkly is the second and
contributes no types at all, only a credential (`integrations/launchdarkly.ts`).
`daemon/src/registry.ts` knows how to *take* an integration — match, refine,
prioritize, aggregate — and nothing about any particular outside system, so a
third one is a new module plus one `registerIntegration` call in `daemon.ts`.
`daemon/scripts/verify-integration-pluggability.mjs` proves that live by
resolving a URL to a synthetic integration's type and finding its MCP server in
an assembled workspace config.

The integration is *Atlassian* — one credential, one `mcp-remote` endpoint,
serving Jira today and Confluence later — but its persisted and on-the-wire
identity stays `jira`: the credential file `jira-credential.json`, the keyring
attributes `account jira`, and the `list_integrations` row `id: "jira"` are
unchanged, because renaming them would cost a migration of a live credential
and break a shipped settings UI for nothing a user can see.

**Integrations provide MCP servers, and are off until turned on.** A spawning
agent's `.mcp.json` is assembled from the *enabled and configured*
integrations, plus Butchr's own `butchr` server, which is core rather than an
integration and is attached to every agent regardless. An integration's servers
attach to every spawned agent once it is enabled, not only to agents of the
types it owns. The enabled state is persisted in
`~/.local/share/butchr/integrations.json` and defaults to **disabled** — except
that an integration whose credential is already configured migrates as enabled,
so an existing install is never silently switched off. A disabled integration
contributes nothing but keeps its URL patterns for diagnosis, so a Jira URL
refuses with *"the Atlassian integration is switched off"* rather than
"unsupported URL". Running agents are never stopped by a toggle; only new
activations are refused.

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

### 📌 Type: `epic` (Jira)

Same URLs, same key format, different prompt — `prompts/epic.md`.

| Parameter | Configuration |
| :--- | :--- |
| **Workspace Type** | `epic` |
| **URL Patterns** | *(none)* — same reason as `story`, see below |
| **Entity Key** | Jira Work Item ID |
| **MCP Tools** | Official Atlassian MCP Server tools |
| **Initial Prompt File** | `prompts/epic.md` |

### 🔎 Why Jira types need a lookup

A Jira issue URL does not carry the issue's type: `…/browse/KAN-5` is
byte-identical whether `KAN-5` is a **Task** or a **Story**. URL matching alone
therefore cannot choose between the `task` and `story` workspace types.

So `story` deliberately registers **no URL patterns**. Every Jira issue URL
matches `task` first, and that match is then *refined* by asking Jira for the
issue's real `issuetype`:

```
URL ──match──> task (provisional) ──ask Jira──> issuetype name ──map──> task | story | epic
```

The mapping lives in one place in `daemon/src/integrations/atlassian-integration.ts`,
as data — Jira's own knowledge, held by the Jira integration:

| Jira issue type | Workspace type |
| :--- | :--- |
| `Story` | `story` |
| `Epic` | `epic` |
| `Task`, `Bug`, `Subtask`, anything unrecognised | `task` |
| *lookup unavailable or failed* | `task` |

**Resolution is asynchronous** as a result (`registry.resolve()` returns a
Promise). A bare board URL resolves to **nothing**: board pages are not a
workspace, the sidepanel shows its ordinary "no workspace for this page" state,
and an epic is reached by opening the epic issue like any other issue. A board
URL carrying `&selectedIssue=KEY` still resolves as an ordinary issue URL — no
longer by winning a precedence contest, since there is nothing left to beat —
and lands on `task`, `story` or `epic` per the lookup.

### 🔐 The Jira credential, and degrading without one

The lookup needs read access to Jira, which the daemon did not previously have.
The user supplies an **Atlassian API token** (site URL + account email + token)
on the extension's **Settings** page. Design constraints, all deliberate:

- **Read-only, two operations.** `daemon/src/jira.ts` can fetch an issue's type,
  read an issue's status/comment-ids/links for the poller (widened by the
  human's KAN-75 decision on 2026-08-03 — see [When a ticket changes and its
  agent is mid-turn](#-when-a-ticket-changes-and-its-agent-is-mid-turn)), and
  validate a credential. Both reads fit inside the same `read:jira-work` scope
  the settings page has always asked for, so the widening costs the user nothing
  to grant. There are **no write methods**, and none should be added: agents
  already hold their own scoped interactive auth for writes. Prefer a **scoped**
  token limited to `read:jira-work` over a classic full-permission one.
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

> **Pre-cutover.** This describes capacity and cost measurement as Butchr owns
> them today. Decision 1 hands capacity to CrabCast's socket and decision 4
> deletes Butchr's capacity and cost-measurement code at cutover; the behaviour
> described here is what the verify suite then has to reproduce against
> CrabCast (decision 5).

The cap exists because seven agents on a 4-core laptop made the desktop
unusable and nothing in Butchr knew. It is derived from the hardware rather
than declared, so the answer travels: see
[`daemon/src/capacity.ts`](../daemon/src/capacity.ts), and
`node daemon/scripts/verify-agent-capacity.mjs` for the derivation with the
numbers behind it.

**`cap` counts task agents, and only task agents.** The **herdr server** —
0.5 core, always present — is charged before the cap is worked out rather than
against it. **Epic and story agents are reported but never charged**: they
supervise rather than do the work, spending most of their lives reading Jira
and waiting, so they neither occupy a slot in `running` nor have one reserved
for them. (KAN-36 reserved a slot for the then always-on board manager; KAN-39
replaced that manager with per-epic and per-story agents that come and go, and
KAN-41 removed the reservation with it.) Since KAN-57 the **capacity gate
honours this end to end: a supervisor activation is never refused** — no
override needed, none recorded — because refusing an agent the model never
charges was the gate arguing with its own arithmetic, and desktop baseline
load alone could otherwise pin supervisors off indefinitely.

The daemon's own fallback shell (`butchr-default-workspace`) is not counted at
all: it appears in `list_agents` because a session exists for it, but a shell
costs nothing like an agent.

**What an agent costs** is measured, continuously, by the daemon itself. An
agent is a process *tree* — the `claude` process plus the MCP servers it
starts — and every 60 seconds the daemon measures its live trees with the same
instrument as `node daemon/scripts/measure-agent-cost.mjs [seconds]`
([`daemon/src/agent-cost.ts`](../daemon/src/agent-cost.ts)) and divides the
cap by a **damped** per-tree figure. The damping
([`daemon/src/agent-cost-damping.ts`](../daemon/src/agent-cost-damping.ts)) is
asymmetric on purpose — quick to believe an agent is expensive, slow to
believe it is cheap — because the errors are not symmetric: under-estimating
cost makes the desktop unusable, over-estimating merely refuses an activation.

The `MEASURED_AGENT_COST` constants (measured 2026-07-31) remain as the
**seed**: what capacity answers from until the first damped figure lands, and
what it degrades to whenever there is nothing to measure — no agent trees,
`/proc` unreadable, a sample that fails validation. Every capacity report
labels each figure `seed`, `measured` (with the sample's window, tree count
and timestamp) or `override`, so the derivation stays checkable by hand even
though the divisor moves. Three environment variables override the derivation:

| variable | effect |
| --- | --- |
| `BUTCHR_MAX_AGENTS` | sets the cap outright, skipping the derivation |
| `BUTCHR_AGENT_MEMORY_MB` | resident cost of one agent tree |
| `BUTCHR_AGENT_CORES` | load-average cost of one active agent |

Precedence is strict: an override beats the live measurement outright, the
measurement beats the seed, and `BUTCHR_MAX_AGENTS` pins the cap before any of
it. Overrides are per-dimension — setting `BUTCHR_AGENT_CORES` alone leaves
the memory figure measured.

**Headroom is a different question from the cap** and is answered three ways —
count, 1-minute load average, available memory — with the smallest winning.

**A refusal always says why.** `butchr_capacity` and the MCP activate path
return the reason, the figures and the full derivation; the sidepanel renders
the reason and figures under the toggle with the derivation behind a
disclosure, and offers **Start anyway**, which is recorded with the numbers as
they stood. Re-attaching to an agent that is already running is never gated:
it starts nothing and costs nothing.

---

## 🥇 Who gets the machine when it is full

> **Pre-cutover.** Priority, preemption and the durable registry described here
> are Butchr's today; decision 1 moves them to CrabCast and decision 4 deletes
> Butchr's copies at cutover. The priority *number* stays Butchr's to choose —
> decision 2 puts it in the spawn request — while the ordering and the
> preemption mechanics become CrabCast's.

At capacity the cap used to refuse everything identically, which left whoever
was asking to work out for themselves what to stand down. Agents now carry a
priority, fixed by workspace type: **`epic` 3, `story` 2, `task` 1.** It is a
property of the type rather than of the Jira ticket, so it needs no lookup and
both callers — the sidepanel toggle and the agents that activate over MCP — get
it the same way.

**Strictly greater.** Equal never preempts, which makes task-versus-task — the
normal shape of a full machine here — always a refusal. And it makes "never
preempt an epic agent" a consequence of the ordering rather than a rule
anyone has to remember: 3 is the top of the scale.

**Never automatic.** A refusal at capacity now names what is running and what
each one is worth, and — when the activation outranks one of them — which agent
would be stopped and what it is doing. That is all it does. `preempt: true` on
the MCP tool, or a sidepanel button that reads **Stand down task/KAN-99 and
start**, is what authorises it. Nothing dies before a person has read its name.

**A preempted agent survives.** Its stand-down is recorded as `deactivated`
with an annotation saying who took its slot and why — so a reboot does *not*
resurrect it (that would overturn a person's decision on a machine that has just
proved it cannot hold both) while the reason stays legible. Switching it back on
is recognised as a resume: it comes back with its conversation *and* KAN-21's
interrupted-work nudge, rather than sitting silently at a restored prompt.

**Its ticket is somebody's job.** The daemon holds no Jira write and never will,
so `butchr_list_agents` reports `preemptedAgents` on every poll until the agent
is put back, and `prompts/epic.md` tells the epic agent to move each one
back to **To Do** with a comment naming what took its slot. Left In Progress
with nothing behind it, a preempted ticket tells exactly the lie KAN-21 exists
to end.

Full reasoning — the ordering, the victim rule, why the registry records what it
records — is in [`docs/priority.md`](priority.md);
`node daemon/scripts/verify-agent-preemption.mjs` proves all of it against the
real router, registry and on-disk log.

---

## 🔌 Switching agents on and off from the Agents page

> **Pre-cutover in part.** The page itself stays Butchr's — decision 3 keeps
> type/key as the vocabulary it renders. What moves is underneath it: the
> durable registry these candidate lists are drawn from becomes CrabCast's
> (decision 1) and Butchr's copy is deleted (decision 4), so after cutover the
> daemon reads the fleet over CrabCast's socket and re-labels paths back into
> type/key before the page ever sees them.

The Agents page shows the whole fleet and, until KAN-38, could act on none of
it. Every running agent now carries an **Off** switch, and every agent that is
*not* running can be switched back on from the same page.

**Off** goes through `deactivate_by_key`, so it reaches an agent that outlived
the daemon holding its terminal as readily as one it is attached to. It is not a
single click: the daemon runs git in the agent's workspace first
(`{"action": "agent_work_state"}`) and the confirmation names what would
actually be lost — a `confirm()` dialog says the same words whether there is
work to lose or not. A supervisor — an epic or story agent — may be switched
off too, behind a confirmation that names it and says what stops with it, and
it reappears immediately on the list that switches it back on.

**On** takes its candidates from KAN-21's registry, because the page lists what
is running and a stopped agent is by definition not in it: `missingAgents` (a
loss), `preemptedAgents` (a debt) and `standbyAgents` (a person's choice),
disjoint so no agent grows two switches. Starting one goes through
`activate_by_key` — a path the daemon and the MCP tool always had and the
extension never exposed. A stand-down now carries the whole activation record
forward, so an agent comes back as what it was rather than as a bare shell.

Refusals are rendered with the same `ActivationRefusal.jsx` the sidepanel uses,
under the row whose button was pressed. Full reasoning — the candidate sources,
the confirmation, the manager decision, and how an in-flight control is kept
from fighting the 2-second poll — is in
[`docs/fleet-controls.md`](fleet-controls.md);
`node daemon/scripts/verify-agent-power-controls.mjs` and
`node daemon/scripts/verify-fleet-switch-live.mjs` prove it against the real
router and against a real herdr respectively.

---

## 📣 When an agent transitions its own ticket

Status changes used to travel by hand and by luck. `prompts/task.md`,
`prompts/story.md` and `prompts/epic.md` each told an agent to transition its
ticket — To Do → In Progress → In Review → Done — and none of them told the
transitioning agent to *tell anyone*. So an agent whose work depended on that
status found out when its own polling loop next looked, or not at all: KAN-61's
completed story sat silently done after its one hand-back nudge was eaten by a
daemon restart, and the epic agent's polling loop exists largely because a lost
nudge is otherwise invisible.

**The convention: the agent that transitions announces it, at the moment it
transitions.** This is prompt text, not daemon code — there is nothing to build,
because the agent making the change is the one process that certainly knows
about it.

**The link graph is the notification topology.** A status change is interesting
precisely to the issues linked to the one that moved and to its parent, which is
the same convention the board's liberal linking already serves. The transitioning
agent reads its own `issuelinks`, identifies its parent (a task's *Implements
story* line, a story's `parent` epic; an epic has none), asks
`butchr_list_agents` which of those issues have a **live** agent, and sends each
one exactly one short `butchr_send_to_agent` nudge naming the issue, the
transition and what it means for them. An issue with no live agent gets nothing
extra: the ticket comment the agent already posts is its durable inbox, and
starting an agent in order to inform it would be staffing work as a side effect
of a notification.

**Storm guards, stated the same way in all three prompts.** Notify on meaningful
transitions only (To Do ↔ In Progress, → In Review, → Done) and not on edits,
comments or assignment; never notify the agent whose action caused the event;
a nudge you receive must never itself generate nudges — react by reading tickets
and acting, not by re-broadcasting; and never send two nudges in a row to the
same agent, because the second kills its session. The first three bound the
fan-out of a single event; the last is the pre-existing interrupt rule, kept
adjacent because this convention is what makes an agent likely to break it.

This is the prompts half of status propagation. Its complement is daemon-side and
lands separately: the next section covers what an agent *cannot* announce —
dying, or going `blocked` — where the daemon nudges the supervisor of record on
the agent's behalf.

---

## 📣 When an agent changes state without saying so

> **Pre-cutover, deliberately.** Supervisor-of-record parentage and a delivery
> primitive that confirms rather than dispatches are two of the requirements
> CrabCast accepted from us, so the implementation here is throwaway and the
> interface is permanent (decision 4). Deleting this at cutover is the plan
> working. What must survive the swap unchanged is the field name and shape —
> `activatedBy: { type, key } | null` — because it is what the Agents page's org
> chart and CrabCast's extension-point API are both written against.

An agent announces its own progress in its ticket. What it cannot announce is
the thing that stopped it: an agent that died, or went `blocked`, says nothing,
because it is not running or not proceeding. The 30-second missing-agent sweep
already *detected* that and broadcast `agent_lost_event` to whatever clients
were connected — which is the right answer for a board somebody is watching and
no answer at all for the story agent whose task agent just died. It found out
whenever its polling loop next looked.

**The supervisor of record.** Supervision used to be type-level only —
`isSupervisorType` answers whether a *kind* of agent supervises, and nothing
recorded which story staffed which task. `AgentRecord` now carries
`activatedBy: { type, key } | null`, written at activation from the identity the
butchr MCP already attaches to every request (`workspaceType`/`workspaceKey`,
`daemon/src/mcp.ts`). Nothing is invented: a human toggling an agent on from the
sidepanel records an explicit `null`, and an agent that activates itself is
nobody's child. The null is explicit rather than omitted because over JSON an
absent field reads as "the daemon didn't answer that" while `null` reads as
"there is nothing to report" — and because `intents()` strips and re-spreads
records, so the two behave differently through a round-trip. Boot-time
reconciliation passes the recorded parentage back through the activation it
replays, so a reboot does not orphan a fleet that had parents.

**On the wire, on every row.** The nudge is one consumer of that field; the
other is the Agents page, which draws the org chart and needs the parentage of
agents nobody is nudging about. So `list_agents` reports `activatedBy` on every
row of all four of its lists — `agents`, `standbyAgents`, `missingAgents` and
`preemptedAgents` — with the same meaning in each: **the supervisor of record
at activation**, and `null` for *no known parent*. `null` is a real answer, not
an unknown one; the field being absent altogether is what "this daemon cannot
tell you" looks like, and a client that cannot tell those apart draws either a
false root or no tree at all.

Two properties the shape depends on, both load-bearing:

* **Read, never cached.** The rows resolve parentage through
  `MessageRouter.supervisorFor` — the same registry read the notifier uses — on
  every poll. One fact, one place: a parent recorded after this daemon booted
  appears on the next list, and the agent the page nests under can never differ
  from the agent a notice is delivered to.
* **Addressed by `(type, key)`, never by key alone.** The live fleet routinely
  holds both an `epic/KAN-39` and a `task/KAN-39`. `activatedBy` carries the key
  as the registry recorded it (`KAN-900`), while a sessionless row recovers its
  own key from the agent name and so reads case-folded (`kan-900`); matching
  folds both sides. Folding one side only silently orphans every child.

A stand-down does not change who staffed the work, which is why the three
not-running categories carry the field too: a story switched off under a live
epic is information — the epic has a child and the child is off — and a lost or
preempted agent is a decision owed to whoever staffed it.

`node daemon/scripts/verify-parentage-in-list-agents.mjs` proves all of it
against the real router and a real on-disk registry: the epic→story→task chain
rebuilt from the DTO alone, the explicit `null` surviving a JSON round-trip,
and the standby, missing and preempted rows each keeping their parent.

> The implementation is throwaway and the interface is permanent (decision 4).
> The exposure here is deleted at CrabCast cutover; `activatedBy: { type, key }
> | null` is not, so the verify script is written as the executable
> specification of the contract rather than as a regression test for the code
> that currently satisfies it.

**What is worth a nudge, and what is not.** herdr's `agent_status` is not this
daemon's judgement — `toAgentStatus` whitelists whatever `herdr agent list`
reports — and it tracks the agent's own hook-reported turn boundaries. So `done`
fires at the end of every *turn*, not at the end of the work, and on 2026-08-03
it was observed reporting `done` for `task/KAN-72` while a tail of the same
agent showed a live diff scrolling. Nudging on `working` → `done` would deliver
a false "your agent finished" several times an hour per agent, so it is not
wired, and corroborating it across two sweeps would not help: an agent between
turns is still `done` a minute later. What is wired is what is unambiguous —
**newly missing** per `findMissingAgents`, and **`working` → `blocked`**, which
`prompts/epic.md` already tells supervisors to investigate immediately.

**Delivery is confirmed, not dispatched.** `sendToAgent` answering `success:
true` means the keystrokes were typed, which is not the same claim as the
message landing: on 2026-08-03 a nudge returned success and two consecutive
tails showed the text sitting unsubmitted at the recipient's `❯` composer with
the tool call above it reading `Interrupted`. `deliverToAgent`
(`daemon/src/nudge.ts`, exported so the Jira poller consumes it rather than
reimplementing it) sends, then reads the pane back and requires the message to
appear as **submitted output** — text after the final composer caret has not
been sent, and a plain substring check passes on exactly the frame that proves
the failure. It retries once and no more, because every send begins with a
Ctrl+C at somebody's working agent.

**Storm guards.** One event, one nudge, remembered until the condition clears,
so a standing block is not news twice a minute and an unblock-then-block is two
events rather than one. Nobody is told about themselves. A supervisor that is
not running is logged and left alone — its ticket comments and its own polling
are its durable inbox, and starting it to receive a notice would be the daemon
staffing agents on its own initiative. The text informs and instructs nothing,
because every sentence telling an agent to act is a sentence that can produce
another nudge.

`node daemon/scripts/verify-status-change-nudges.mjs` proves all of it against
the real router and the real registry; `--live` adds a section that starts two
real agents, closes the child's pane, and reads the notice back out of the
supervisor's real terminal.

---

## 📨 When a ticket changes and its agent is mid-turn

> **Pre-cutover.** The poller reads Jira and delivers through the same
> primitives decision 4 hands to CrabCast; what must survive the swap is the
> behaviour described here, which the verify script below is written against.

The section above watches an agent's **runtime**. This watches its **ticket**.
An agent reads its ticket at the start of a turn and not again, so a human
moving it on the board — or commenting on it while the agent is mid-turn — was
discovered only if somebody remembered to nudge. For a comment that is the whole
steering channel: a comment is how a human redirects work already in flight, and
every steer typed at a busy agent's ticket was landing in a file nobody was
going to open until the turn ended.

**Polling, not webhooks** — decided by the human on 2026-08-03 and not a
shortcut. A webhook is an inbound network surface on a developer laptop, and
Butchr's posture is outbound-only: a Unix socket whose permissions are the auth
boundary, and no listening port at all. A poll costs a request a minute and
keeps that true.

**Only issues with live agents.** An issue whose agent is not running has its
ticket as a durable inbox — it reads it when it starts — so polling it would pay
requests to notify nobody. The fleet comes from the same census the
missing-agent sweep uses, and two agents on one ticket are one read.

**Who gets told.** On a status change or a new comment on a watched issue:
the live agents of its **linked issues** (from the same GET's `issuelinks`), and
its **parent agent** (the `activatedBy` supervisor of record). Plus, for a **new
comment only**, the issue's **own** agent — that is the mid-turn steer, and it
is the point. A **status change** deliberately does *not* go to the issue's own
agent: its own transitions are announced to it by the prompts layer, and telling
an agent that the ticket it just moved has moved is noise it caused itself. A
target that is not running is logged and left alone, for the same reason as
above.

**The Jira `status` field is not herdr's agent status.** They share a word and
nothing else. herdr's `done` is the agent's own per-turn hook boundary, fires at
the end of every turn, and is wired to nothing (see the section above, and
`verify-status-change-nudges.mjs` AC2, which asserts that absence). A Jira
transition is rare, deliberate, performed by a human or an agent, and is exactly
the news a linked ticket needs — **including a transition to Done**. Nothing in
the poller reads herdr's agent status.

**The nudge is a pointer, never content.** "`KAN-79` status changed to In
Review" or "`KAN-79` has a new comment", plus why you are being told, plus
"re-read it when you next look". The comment's text is not copied: a second,
ageing copy of a steer in a terminal nobody can edit is worse than none, and the
ticket is where a reply belongs. Delivery goes through `deliverToAgent`, so it
is confirmed against the pane rather than dispatched.

**Self-echo suppression, and its stated limit.** Every agent reaches Jira
through the same shared Atlassian account, so a comment's author reads "somebody
in this fleet" and never *which* agent — there is no authorship signal to
suppress an agent's own actions with. Suppression is event-based instead: last-
seen status and highest-seen comment id per issue, in
`~/.local/share/butchr/jira-poll.json` beside `agents.jsonl`, written by the same
atomic write-fsync-rename-fsync the registry's compaction uses. One event, one
nudge, ever. **The limit, stated rather than hidden: an agent that comments on
its own ticket receives one redundant pointer to its own comment.** Bounded to
exactly one by the dedupe, a pointer rather than an echo, and accepted as the
cost of having no authorship signal — the alternative, not nudging an issue's
own agent, would drop the steer this exists to deliver.

**Restarts do not replay history.** An issue the poller has never seen is
recorded silently — its status and its whole comment history at once, notifying
nobody, so a fresh install is not a broadcast of the past. A *restart* is not
that case: the state file survives, so a restarted daemon diffs against what it
recorded before it went down. Already-notified events are never re-sent; a
comment posted during the downtime still arrives, because that is what a watcher
is for. Discarding state on boot would satisfy the letter of "do not replay" and
make the file ornamental.

**Rate limits.** One GET per distinct watched issue every **60 seconds** — the
interval is paced by the recipient rather than by Jira, since every nudge begins
with a Ctrl+C at somebody's working agent. At the stated ceiling of 19 task
agents plus supervisors, 25 issues × 1 GET ÷ 60s ≈ **0.42 requests/second**,
about one request every 2.4 seconds from one account. On a **429 or a 5xx** (or
an unreachable host) the interval lengthens to five minutes **with a log line**,
and recovery is logged too — never to silence, on the same reasoning that gave
the issue-type lookup a bounded cooldown rather than a kill switch.

`node daemon/scripts/verify-jira-poller-nudges.mjs` proves all of it against the
real poller, a real on-disk state file, real Jira response bodies through the
real parser, and the real delivery primitive against stubbed panes; `--live`
adds a section that starts three real agents and polls the real Jira API while a
real transition and a real comment are made.

---

## ✅ What `success` means on the agent-lifecycle responses

> **Pre-cutover.** Verified activation is CrabCast's after cutover (decision 1),
> and the herdr bridge this verification polls is deleted from Butchr
> (decision 4). The guarantee itself is not up for renegotiation: it is one of
> the five generations of `success: true` that decision 5 makes the gate, so the
> verify script named below is re-pointed at CrabCast rather than retired.

`success: true` is a claim about the world, not a report that a command was
issued, and every response on this surface is held to that.

**`activate` verifies the agent exists before it says so.** It used to answer
`success: true` with a plausible session id for an agent that had never been
created (KAN-23). KAN-24 closed the half of that where herdr *told* us the
spawn failed and the answer was discarded; what remained was herdr reporting
success and leaving no agent behind. So after the spawn, activate looks: it
polls `herdr agent list` — the same census `list_agents` reports from, so the
two can never disagree — until the agent appears, and only then records the
activation, broadcasts it and answers. Successful responses carry
`verified: true`.

The wait is bounded: at most 5s of polling every 250ms, plus the 5s ceiling on
the census call in flight. In the ordinary case it costs one call, because an
agent herdr has started is listable immediately.

**A failure says which kind it is.** An agent herdr answered about and does not
have is *absent*: `success: false`, and the session is torn down so the next
activate is free to try again rather than being handed a dead one. A herdr that
did not answer at all is *unverifiable*: also `success: false`, because an
unverified activation must not be reported as a verified one — but nothing is
torn down, since silence is not evidence that a working agent is gone.

**The siblings were audited for the same pattern.** `deactivate` had it: the
pane close was wrapped in a try/catch that logged the failure and swallowed it,
so a stand-down herdr had refused was answered `success: true` while the agent
carried on working. It now reports the refusal, and the
`agent_deactivated_event` is not broadcast for a teardown that did not happen —
an agent or pane herdr does not *have* still counts as success, because that is
what the caller asked for. `reset` and `send` were already state-derived and
needed no change; `reset` by URL now reports `agentClosed` alongside the delete,
which the by-key path already did.

`node daemon/scripts/verify-activate-verified-existence.mjs` proves all of it
against a real herdr on a private socket: the happy path with the agent present
in `list_agents`, an injected spawn that herdr reports as successful and never
performs, the timeout bound, the unverifiable case leaving a live agent alone,
and the deactivate refusal. The failure is injected by a `herdr` shim that
intercepts one subcommand and passes every other call to the real binary, so
the absence being reported is a real one.

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

Staleness stays Butchr's under decision 1, and the carried mitigation above asks
it to grow a fifth check: CrabCast's own checkout, since decision 6 links it
locally and nothing else can then say which CrabCast is running.

---

## 🖥️ Which terminal the panel is looking at

`pty_init`, `pty_input` and `pty_resize` all name a `sessionId`, and a session
id is only meaningful to the daemon process that issued it. The session map
lives in memory and dies with the daemon; the herdr pane behind it does not. So
after a daemon restart the sidepanel is holding an id nothing will ever answer
to again — and it does not know, because the native host is a separate process
that keeps Chrome's port open across the restart and reconnects to the new
daemon on the next message it is asked to forward.

**An id the daemon does not hold is refused, by name.** It used to be treated as
"no preference": the request fell through to a helper that returned an arbitrary
active session or, with none running, spawned a `default/workspace` shell to
answer with. Either way the caller got a plausible reply to a question it had
not asked — output from an agent it was not watching, keystrokes delivered to
someone else's terminal, and a phantom agent left holding a herdr pane. That
helper had no other caller, so it is gone rather than narrowed.

**What the panel does with the refusal** is the other half, since a rejection
nothing recovers from is only a different failure. On any refused PTY reply the
panel drops the session id it was holding, leaves the last good frame on screen
rather than clearing it, and lets the ordinary re-attach path re-resolve the
workspace — either adopting the session the next status check names, or
activating, which reuses the running herdr pane. It does that **once**. A second
refusal without a working attach in between stops and renders "Terminal session
not recognised" with a Reconnect button, because at that point re-asking is not
a fix and a panel silently trading requests with the daemon is worse than one
that says it is stuck.

All three PTY actions are covered, not just `pty_init`: the first thing to meet
a new daemon is usually whatever the user did next — a keystroke, a panel drag —
and learning it from a refused keystroke is the same news by a different route.

Two live proofs, both against real processes on a private herdr server and a
temp `$HOME`, so neither can touch the live daemon:

* `node daemon/scripts/verify-pty-init-rejects-unknown-session.mjs` — the
  refusal itself, that nothing is created or attached to, that no
  `default/workspace` appears, and that a genuine session still works. Point
  `--dist` at a build of an older commit to watch the phantom being spawned.
* `node extension/scripts/verify-sidepanel-survives-daemon-restart.mjs` — the
  built sidepanel and the real service worker against a daemon that is killed
  and restarted underneath them, printing the wire transcript and what the panel
  rendered at each step. It also re-runs the KAN-4 service-worker-death path
  with the daemon left alone, which must still recover in silence.

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
is recorded as a `Blocks` issue link — the task blocks the story — plus an
explicit line in each task's description. `Blocks` is the standing convention
(standard link types only — human decision, 2026-08-03): a story cannot close
until its implementing tasks land. Beyond that convention, the prompts direct
agents to use all four standard link types liberally — `Blocks` for real
dependencies, `Relates` for loose association, `Duplicate` before closing
duplicate work, `Cloners` for tickets cloned as templates.

It **activates the task agents for the tasks it files** — agent lifecycle for
its tasks is its own. It monitors those agents, steers them when they stall,
and when a task's PR merges it sets the task **Done** and deactivates the
agent.

Nothing in the daemon depends on any of this: the prompt is read from disk at
activation, so it is the human's to iterate on.

### The `epic` Prompt: [`prompts/epic.md`](../prompts/epic.md)

The canonical prompt lives in [`prompts/epic.md`](../prompts/epic.md) — see that file rather than an embedded copy here, so the two cannot drift. In outline: the agent decomposes its epic into Stories, staffs and steers the story agents that carry them, and **reviews and merges its own epic's pull requests** (decided 2026-08-03) — merging only with green required CI and the ticket's live-proof acceptance criteria re-run against the PR head; story and task agents never merge. It also owns the epic's **description**, which does two jobs. It is the **design doc** for the system the epic is about, maintained as stories land, with the reasoning behind each decision attached; and it is the agent's **operating memory** — what must persist across a deactivation or reset so a restarted agent picks up where the last one left off. Point-in-time state ("what is staffed, what is blocked") goes in comments, not the description; `prompts/epic.md` is the canonical statement of the rule and the test that applies it.

---

## 🏗️ High-Level System Architecture

> **Pre-cutover.** The three layers below are today's: Butchr's daemon spawns
> and bridges herdr itself. Under decisions 1–3 a fourth box sits between the
> daemon and the terminal layer — **CrabCast's daemon**, reached over its socket
> with a fully-specified spawn request (path, priority, gate flags, prompt file,
> MCP servers) — and *Herdr Session Spawner & Bridge* is deleted from Butchr's
> daemon rather than redrawn (decision 4). What does not change: the extension
> still speaks type and key, and so do agents.

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
│   │   - Workspace Type Registry (`task`, `story`, `epic`)          │   │
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

> **Pre-cutover.** The daemon below still owns MCP orchestration and drives
> herdr directly. Decision 1 hands MCP assembly and the terminal layer to
> CrabCast, decision 4 deletes Butchr's launchers and socket transport at
> cutover, and decision 6 adds CrabCast as a linked local checkout
> (`file:../crabcast`) rather than a published dependency.

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

> **Pre-cutover.** Steps 1–4 are unchanged by the boundary. Step 5 is the one
> that moves: after cutover Butchr resolves the workspace **path** itself and
> calls CrabCast's socket with the fully-specified spawn request, instead of
> running `herdr spawn` (decisions 1, 2 and 4).

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


