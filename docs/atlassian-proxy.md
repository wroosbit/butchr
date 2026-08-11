# The daemon-side Atlassian proxy

**KAN-272, first half.** One credential, held by the daemon, reachable by agents
over the socket they already talk to. Off by default.

This document is the design record the ticket asked for. It answers, in order,
the five things KAN-272 said were *"worth establishing before designing"*, and
it states what this change does **not** do as carefully as what it does.

---

## What this is, in one paragraph

Every agent reaches Atlassian through its own `mcp-remote` process holding its
own OAuth session. `BUTCHR_ATLASSIAN_PROXY=jira-read` adds three read tools to
the `butchr` MCP server every agent already runs — `atlassian_get_issue`,
`atlassian_search_issues`, `atlassian_get_transitions` — and serves them from
the daemon's own API-token credential. No new process, no new socket, no new
credential, and no new scope: all three are GETs under `read:jira-work`, which
the daemon's credential has held since KAN-31.

The whole surface is one table, `PROXY_OPERATIONS` in
`daemon/src/atlassian-proxy.ts`. **That table is the granted scope.** There is
no operation that takes a path, a URL or a REST fragment, so what an agent can
reach through the daemon is bounded by reading one file rather than by
reasoning about one.

## Why — and it is availability, not memory

From roughly 2026-08-10T23:47Z until a human completed OAuth the next morning,
**every** agent's `mcp__atlassian__*` tools were dead while the daemon's single
credential polled the board every 60 seconds throughout. One credential worked;
six OAuth proxies did not. Nothing could be transitioned or closed for about
twelve hours.

**And the failure lied about itself.** The proxy processes stayed alive holding
dead connections, so the tools were still *present* — and tool presence is
exactly what an agent uses to decide whether a capability exists. Only a real
call could tell you they were dead, and nothing made a real call.

The memory argument for this ticket is dead and KAN-273 killed it: agents run
`mcp-remote` twice, so most of the 656 MB is recoverable far more cheaply and
with no change to credential scope. **Do not count those savings here.**

## What this does NOT do

**It does not spend the reversal.** KAN-272 carries a human decision, taken on
2026-08-11 with the reasoning against it in front of them, reversing KAN-39's
invariant 2 and authorising the daemon to hold Jira **write** scope. This change
adds no write method to `jira.ts`, no write operation to the table, and no
widening of the credential's scope by so much as one field. The reversal lands
separately so that it can be reviewed — and reverted — without taking the proxy
with it. That is KAN-272's acceptance criterion 3.

**It does not retire the per-agent proxies, and it is not close.** Measured
across 314 workspace transcripts and 4,698 `mcp__atlassian__*` calls:

| | calls | share |
| --- | --- | --- |
| writes | 2,817 | 60.0% |
| reads | 1,881 | 40.0% |
| Confluence, both directions | 58 | 1.2% |

`addCommentToJiraIssue` alone is 1,233 calls — 26% of all Atlassian traffic and
the single most-called tool. Every agent keeps its `mcp-remote` process for the
writes, so this change removes neither the per-agent OAuth dependency nor its
memory. **The availability case is only cashed by the write half.** What this
half establishes is that the mechanism works and fails honestly, which is what
the write half will be built on.

---

## The five questions

### 1. How is the credential refreshed, and what happens when it fails?

**It is not refreshed, and saying so plainly is the answer.** The daemon holds
an Atlassian API token in `CredentialStore` — the OS keyring where one is
available, a 0600 file otherwise. API tokens do not refresh; they expire on a
date, or a human revokes them. There is no refresh loop to get wrong, which
removes the *class* of bug the 2026-08-10 outage was actually an instance of: an
expired token on disk (expired 2026-07-30) plus a half-finished client
re-registration blocking a clean flow. That was a broken OAuth refresh, and this
design has no OAuth refresh to break.

That is not a claim to be immune. **A credential that cannot expire silently is
the goal; a credential that cannot expire is not achievable.** So what this
change actually engineers is the failure being *loud*:

- A refused read never produces a body. `JiraProxyOutcome` has no success shape
  carrying an empty result — the silent third option is the one that cost twelve
  hours.
- The MCP result is flagged `isError`, so a model cannot read it as data.
- The message names the endpoint that refused it, quotes Atlassian's own words,
  and carries the trace id.
- **`credentialFault` is a separate field from the message**, and it is the
  thing no agent had on 2026-08-10: `true` means the shared credential was
  refused or unreachable and *every other agent is about to hit this too* — a
  thing to report to a human rather than retry. `false` means Atlassian answered
  and disliked *this* request, which is the agent's own to fix. A 404 on a
  mistyped key is `false`; a 401 is `true`.
- Every call is written to the daemon log with its caller, its path and its
  outcome, refusals included.

`verify-atlassian-proxy-failure-is-loud.mjs` revokes the credential mid-run and
asserts every one of those against a real `mcp.ts` over real MCP stdio.

### 2. Scope, enumerated field by field

| tool | method | path | scope |
| --- | --- | --- | --- |
| `atlassian_get_issue` | GET | `/rest/api/3/issue/{issueKey}?fields={fields}` | `read:jira-work` |
| `atlassian_search_issues` | GET | `/rest/api/3/search/jql?jql={jql}&fields={fields}&maxResults={maxResults}` | `read:jira-work` |
| `atlassian_get_transitions` | GET | `/rest/api/3/issue/{issueKey}/transitions` | `read:jira-work` |

**The scope this grants over what the daemon could already do is empty.** Items
1–3 of `jira.ts`'s own header already need `read:jira-work`; so does this. The
settings page's instructions do not change and no user has to re-mint anything.

`atlassian_get_transitions` reads the transitions available on an issue and
performs none. It is a GET; the daemon has no method that could perform one.

Every parameter is validated and then percent-encoded into its own position:
`issueKey` must match `JIRA_KEY` (`/^[A-Z][A-Z0-9]*-\d+$/`), `fields` must match
a restrictive character class, `maxResults` is clamped to 50, and `jql` is
bounded at 2,000 characters. `verify-atlassian-proxy-scope.mjs` fires
path-traversal, query-injection and fragment-injection attempts at every one of
them.

KAN-272 named four separate widenings — transitions, issue creation, description
edits, Confluence — and said not to grant them as a block. **A mode is exactly
the set of operations tagged with it**, so granting the next one means adding a
mode, not loosening a check. `jira-read` is the first and it is the one that
costs nothing.

### 3. What breaks when the daemon is down — a real regression, named

**Today**, an agent with a live `mcp-remote` process can work through a daemon
restart: its Atlassian tools are its own. **Afterwards**, for the operations it
routes through the proxy, a daemon restart takes them away.

**This is a genuine regression in the failure mode and it should not be waved
past.** The thing being fixed is a shared-fate outage; the fix introduces a
different shared fate. Three things make it acceptable, and they are stated so a
reviewer can disagree with them individually:

1. **The shared fate is smaller than the one it replaces.** A daemon restart is
   seconds; `connectToDaemon` spawns one if none is listening, so the ordinary
   case self-heals before an agent notices. The OAuth outage it replaces was
   twelve hours and needed a human at a browser.
2. **It is additive, not a cutover.** Nothing is migrated onto the proxy. Every
   agent keeps every `mcp__atlassian__*` tool it has today, and a proxied call
   that fails leaves the agent's own session untouched — the refusal says so, in
   those words. An agent that finds the proxy down does what it did last week.
3. **It fails toward off.** If `mcp.ts` cannot ask the daemon what it serves, it
   advertises nothing rather than advertising tools that will refuse.

The honest summary is that this trades a *long, silent, fleet-wide* failure for
a *short, loud, self-healing* one, and that the second is much better, not that
the second does not exist.

### 4. Does this retire the per-agent proxies?

No. See **What this does NOT do** above — 60% of agent Atlassian traffic is
writes, and this half proxies none of them. Two categories *do* disappear
outright rather than move: `getAccessibleAtlassianResources` (198 calls) and
`atlassianUserInfo` (94) are cloud-ID and identity lookups that exist only
because each agent authenticates separately, and the daemon resolves its cloud
ID once per transport and caches it. That is about 6% of all calls.

### 5. Blast radius, written down

**After this, any agent can read as far as the daemon's credential can, with no
per-agent scoping and no interactive consent.** Today a confused or compromised
agent reads only as far as its own OAuth session allows. That is the widening
and it is real. Precisely:

- The credential is scoped `read:jira-work` on one Atlassian account, so the
  blast radius is *everything that account can read in Jira*, restricted to the
  three shapes in the table. It is not admin, not user-directory, not
  Confluence, and not write.
- **Attribution is not authentication.** Every proxied call is logged with the
  caller's workspace type and key, stamped by `mcp.ts` from its own argv. That
  makes a read attributable; it does not make it authenticated, because anything
  that can reach the daemon's socket can claim any identity — exactly as
  `agent-connections.ts` decision 4 records for `hello`. The trust boundary is
  still the socket's filesystem permission (`0700` on `BUTCHR_DIR`) and nothing
  here moves it.

**Mitigations in scope, and what was deliberately left out:**

| mitigation | in this change? |
| --- | --- |
| Off by default, with an unrecognised value falling to off | yes |
| One gate, in the daemon, consulted on every call | yes |
| A fixed operation table — no agent-supplied paths | yes |
| Per-call audit line naming the caller, path and outcome | yes |
| Bounded result counts and query lengths | yes |
| Per-tool gating by mode | yes |
| **Restricting reads to the caller's own subtree** | **no** |
| **Per-agent rate limiting** | **no** |

The last two are named rather than silently omitted. Subtree restriction was
considered and rejected *for the read half*: agents legitimately read across the
board — an epic reads its tasks, a task reads its story, the board reconciler
reads everything — and a restriction that has to be widened on its first day is
worse than none, because it looks like a control. **It should be reconsidered
for the write half, where the argument runs the other way**: an agent writing
outside its own subtree is nearly always a mistake, and the cost of being wrong
is much higher. Rate limiting is absent because there is no measured problem;
the search bound is what stops one typo becoming a bulk read.

---

## How it is wired

```
agent (Claude Code)
  └─ butchr MCP server            daemon/src/mcp.ts        (per agent, stdio)
       │  tools/list  → asks the daemon what mode it serves; on failure, offers nothing
       │  tools/call  → forwards, never decides
       └─ unix socket
            └─ MessageRouter      daemon/src/router.ts     handleAtlassianProxyCall
                 │  1. selectedProxyMode()      ← the ONLY reader of the switch
                 │  2. refuseProxyCall()        ← the ONLY gate
                 │  3. operation.build(args)    ← the path, never from the wire
                 │  4. audit line
                 └─ JiraIssueTypeService.proxyRead   daemon/src/jira.ts
                      └─ TokenJiraTransport → Atlassian
```

**The switch has exactly one reader and it is the daemon.** `mcp.ts` could call
`selectedProxyMode` itself — it is exported and compiled into the same package —
and that is the bug this arrangement avoids: the two would be reading two
different environments, because `mcp.ts` is spawned by the agent's CLI while the
daemon may have been started hours earlier from a systemd unit. A tool list
built from the wrong one is a menu of tools the daemon will refuse.

**The advertisement is advisory; the refusal is the gate.** An agent started
while the proxy was on keeps the tools in its list after it is switched off, and
its next call is refused with a sentence naming the switch. This is the same
arrangement `channel.ts` uses for channel emission, for the reason given there:
a second gate is a second copy of one condition, and the copy that drifts is the
one that lets something through.

**The mode is read on every call**, not captured at boot — which is where this
deliberately differs from `runtime-switch.ts`. A runtime owns live sessions and
cannot be swapped under them; a proxy owns nothing. So unsetting the variable
and restarting the daemon takes effect on the next call, with no fleet
interruption. For a feature that widens what agents can do, an off switch that
needs a rebuild of the fleet to take effect is not much of an off switch.

## Turning it on

```bash
BUTCHR_ATLASSIAN_PROXY=jira-read    # the ONLY value that enables anything
```

`off`, unset, empty, and anything unrecognised all serve nothing — no truthiness
test, no prefix match, no `1`. An unrecognised value is reported with its reason
rather than swallowed.

The daemon's `atlassian_proxy_status` action reports the mode, the operations,
the scopes and whether a credential is configured. **`configured: true` is not
`working: true`** and the report says so: it means a token is on this machine,
not that Atlassian still accepts it. Only a call establishes the other, which is
the whole lesson of 2026-08-10.

## The proofs

| script | what it establishes | what it does not |
| --- | --- | --- |
| `verify-atlassian-proxy-scope.mjs` | off by default; the grant is three GETs under one scope; no agent-supplied path can escape its parameter; the gate is in the daemon | that the daemon consults any of it — it is pure, and imports the module directly |
| `verify-atlassian-proxy-failure-is-loud.mjs` | a real `mcp.ts` over real MCP stdio, against a real daemon: a call returns data, the same call with the credential revoked returns a loud attributed refusal with no body, and with the switch unset nothing is offered and nothing reaches the network | that **Atlassian** accepts these paths — the far end is a stub in-process, and the credential is fabricated by the script. The real-Atlassian evidence for these exact paths is the running poller, which has used them on a 60-second timer since 2026-08-04 |
| `probe-atlassian-proxy-agent-call.mjs` | that a **model** — a real Claude Code session with no Atlassian MCP server at all — finds the tool from its description, calls it, and can read the result | anything the verify script covers. It is a `probe-` because it spends tokens and its verdict depends on a model choosing to call a tool; neither belongs in a proof meant to be cheap to re-run |

Both were made to go red before being trusted; the failing runs are in the pull
request. Passing `sweep-verify-exit-paths.mjs` is necessary and not sufficient,
and neither script is in CI: the first could be, and is not yet, because the
sweep's own comment asks that a second CI-safe script be filed rather than
appended.
