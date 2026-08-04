# Does a server-initiated MCP notification reach the model's context?

**Finding for KAN-167, establishing the premise of KAN-150.**
Repository read at `4ed15d7`. Probe run 2026-08-04.

---

## The answer, plainly

**No — not yet, and not by the mechanism KAN-150 assumed.**

Claude Code receives our `notifications/message` frames and does not put them in
front of the model. This was tested three ways, in both target states, against a
control that proves the detector works:

| Configuration | CP1 daemon broadcast | CP2 left our server | CP3 in-flight | CP3 idle |
| --- | --- | --- | --- | --- |
| **A** protocol floor (stub server) | n/a | observed | **dropped** | **dropped** |
| **C** positive control | n/a | observed | **dropped** | **dropped** |
| **B** real path (`daemon/dist/mcp.js` + real daemon events) | observed | observed | **dropped** | **dropped** |

In configuration C the *same nonce* carried on a tool result **did** reach the
model's context. So the probe can see a delivered nonce; it did not see these.

**Where the blocker sits — and it is important that it is only one of the three:**

| Site | Verdict |
| --- | --- |
| **The protocol**, at the negotiated revision `2025-11-25` | **Not the blocker.** Unsolicited server→client `notifications/message` is explicitly permitted. |
| **Our SDK**, `@modelcontextprotocol/sdk` `1.30.0` | **Not the blocker.** It sent every frame correctly; we watched them leave on the wire. |
| **This client**, Claude Code `2.1.221` / `2.1.222` | **The blocker.** It reads the frames and discards them without surfacing them to the model. |

There is a **second, future blocker** that matters more for design than the first:
the current revision `2026-07-28` **deprecates Logging outright** and makes
`notifications/message` **request-scoped**, forbidden absent an opt-in on a
specific request. Building the KAN-150 channel on logging notifications would be
building on a feature the specification is actively removing.

**This finding clears none of KAN-150's four defects.** They all remain, because
the replacement channel is not available. Details in [What this does and does not
clear](#what-this-does-and-does-not-clear-of-kan-150s-four-defects).

---

## Question 1 — what the protocol offers

All claims below carry a URL and the revision string they came from. Everything
here was fetched live on 2026-08-04, not recalled.

### Published revisions, and the current one

The **current** revision is **`2026-07-28`**.

> "The **current** protocol version is [**2026-07-28**](/specification/2026-07-28/)."
> — <https://modelcontextprotocol.io/specification/versioning>

Revisions relevant to this ticket, newest first:

| Revision | Status | Evidence |
| --- | --- | --- |
| `2026-07-28` | **Current** | [versioning](https://modelcontextprotocol.io/specification/versioning) |
| `2025-11-25` | Final | [its changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog) |
| `2025-06-18` | Final | [its changelog](https://modelcontextprotocol.io/specification/2025-06-18/changelog) |
| `2025-03-26` | Final | named as predecessor by the `2025-06-18` changelog |
| `2024-11-05` | Final | referenced by the [deprecated registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated) for HTTP+SSE |

Changelogs of every revision since `2025-03-26` were read: `2025-06-18`,
`2025-11-25`, `2026-07-28`.

### Server→client mechanisms

"Outside an in-flight request?" is the column that decides this story: it asks
whether a daemon can reach an agent that is not currently asking anything.

#### At `2025-11-25` — the revision our fleet actually negotiates

| Mechanism | JSON-RPC method | Initiator | Gating capability | Outside an in-flight request? | Introduced |
| --- | --- | --- | --- | --- | --- |
| Logging notification | `notifications/message` | Server | `logging`, declared by the **server** | **Yes** | ≤ `2024-11-05` |
| Sampling | `sampling/createMessage` | Server → client request | `sampling`, declared by the **client** | Yes | ≤ `2024-11-05` |
| Elicitation | `elicitation/create` | Server → client request | `elicitation`, declared by the **client** | Yes | `2025-06-18` |
| Progress | `notifications/progress` | Either | none; tied to a `progressToken` | No — scoped to a request | ≤ `2024-11-05` |
| List changed | `notifications/tools/list_changed`, `…/prompts/…`, `…/resources/…` | Server | `listChanged` sub-capability | Yes | ≤ `2024-11-05` |
| Resource updates | `notifications/resources/updated` | Server | `resources.subscribe` | Yes, after `resources/subscribe` | ≤ `2024-11-05` |

The only timing constraint at this revision is a startup one, and it explicitly
*exempts* logging:

> "The server **SHOULD NOT** send requests other than pings and logging before
> receiving the `initialized` notification."
> — <https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle>

Logging is gated by a **server** capability, not a client one:

> "Servers that emit log message notifications **MUST** declare the `logging`
> capability"
> — <https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/logging>

`logging/setLevel` is a **MAY** for the client, not a precondition on the server:

> "To configure the minimum log level, clients **MAY** send a `logging/setLevel`
> request"
> — same page

**So at `2025-11-25`, Butchr's server is doing something the protocol plainly
allows.** Nothing in the specification says the client may ignore it — but
nothing requires the client to show it to a model either. That gap is the finding.

#### At `2026-07-28` — the current revision, which changes the picture

| Mechanism | Status at `2026-07-28` | Outside an in-flight request? |
| --- | --- | --- |
| Logging / `notifications/message` | **Deprecated**, and now request-scoped | **No** |
| Sampling | **Deprecated**; server-initiated form **removed**, replaced by MRTR | No |
| Elicitation | server-initiated form **removed**, replaced by MRTR | No |
| Roots | **Deprecated** | No |
| `subscriptions/listen` | New; the only long-lived server→client stream | Yes — but only four fixed notification types |
| Progress | unchanged, request-scoped | No |

The decisive sentence for KAN-150:

> "To receive log messages for a specific request, include
> `io.modelcontextprotocol/logLevel` in the request's `_meta`. The server **MUST
> NOT** emit `notifications/message` for a request that does not include this
> field. […] `notifications/message` is request-scoped: the server **MUST NOT**
> deliver it on a `subscriptions/listen` stream or on any stream other than the
> one carrying the response to the request that set the log level."
> — <https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/logging>, revision `2026-07-28`

And the deprecation itself:

> "**Deprecated**: The Logging feature is deprecated as of protocol version
> `2026-07-28` (SEP-2577). […] New implementations **SHOULD NOT** adopt it;
> existing implementations **SHOULD** migrate to logging to `stderr` for stdio
> transports, or to OpenTelemetry for structured observability."
> — same page. Earliest removal: "First revision released on or after 2027-07-28"
> ([deprecated registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated)).

### Is there any client→client or addressed-messaging primitive?

**No, at every revision examined.** All cross-agent traffic must be relayed
through a server, and even then a server cannot address a particular client — it
answers the one client connected to it.

> "Each client is created by the host and communicates with exactly one server"
> — <https://modelcontextprotocol.io/specification/2026-07-28/architecture>

> "Servers should not be able to read the whole conversation, nor 'see into'
> other servers […] Cross-server interactions are controlled by the host"
> — same page

The `2026-07-28` release announcement does not mention agent-to-agent or
client-to-client messaging at all
(<https://blog.modelcontextprotocol.io/posts/2026-07-28/>).

**The human's recollection — "a new version that has messaging" — is correct that
a new version exists (`2026-07-28`) and that it introduces a channel concept
(`subscriptions/listen`), but incorrect that it adds messaging.** The direction of
travel is the opposite: `2026-07-28` removes server-initiated requests, deprecates
the one general-purpose server→client push we were using, and confines what
remains to four fixed change-notification types.

### The four amendment-A claims, resolved individually

**Claim 1 — `subscriptions/listen`, opt-in per notification type. CONFIRMED.**

> "The client sends a `subscriptions/listen` request with a `notifications` filter
> specifying which event types it wants to receive. The server **MUST NOT** send
> notification types the client has not explicitly requested."
> — <https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions>

The filter admits exactly four fields: `toolsListChanged`, `promptsListChanged`,
`resourcesListChanged`, `resourceSubscriptions`. **There is no "arbitrary
message" type**, so this stream cannot carry a Butchr nudge. It is a channel for
"your tool list changed", not a channel for "KAN-150 has a new comment".

**Claim 2 — "server-initiated requests may only be issued while the server is
actively processing a client request; previously recommended, now required."
REFUTED AS PHRASED; CONFIRMED IN SUBSTANCE, AND STRONGER.**

Server-initiated requests are not *constrained* at `2026-07-28` — they are
**abolished**:

> "Multi Round-Trip Requests (MRTR) was introduced in this version of the MCP
> specification. This replaces the previous approach of sending server-initiated
> requests. Servers **MUST** send server-to-client requests (such as
> `roots/list`, `sampling/createMessage`, or `elicitation/create`) using the MRTR
> pattern. The previous pattern of server-initiated requests is no longer
> supported. This is a breaking change."
> — <https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr>

Under MRTR the server asks for input by *returning* an `InputRequiredResult` from
a client request, and only three client requests qualify:

> "Servers **MAY** send `InputRequiredResult` responses on the following client
> requests: `prompts/get`, `resources/read`, `tools/call`. Servers **MUST NOT**
> send `InputRequiredResult` responses on any other client requests."
> — same page

I found no such "only while processing a request" rule at `2025-11-25`; its
lifecycle page states only the startup constraint quoted earlier. The epic
agent's instinct was right and the reality is more restrictive than the claim.

**Claim 3 — `notifications/elicitation/complete` removed. CONFIRMED.**

> "Remove the `notifications/elicitation/complete` notification and the
> `elicitationId` field of URL mode elicitation requests, both introduced in
> `2025-11-25`. Under the Multi Round-Trip Requests pattern, the client learns the
> outcome of an out-of-band interaction by retrying the original request, so a
> server-initiated completion signal — and the identifier used to correlate it —
> no longer fit the protocol."
> — <https://modelcontextprotocol.io/specification/2026-07-28/changelog>

**Claim 4 — stateless core, header-based routing, cacheable list results,
extensions framework. ALL FOUR CONFIRMED**, from the `2026-07-28` changelog:

- Stateless: *"Make MCP stateless: remove the `initialize`/`notifications/initialized` handshake."* (major change 2)
- Header-based routing: *"Require standard MCP request headers (`Mcp-Method`, `Mcp-Name`) on Streamable HTTP POST requests"* (minor change 4)
- Cacheable list results: *"Require `ttlMs` and `cacheScope` fields on results returned by `tools/list`…"* (minor change 5)
- Extensions framework: *"Add `extensions` field to `ClientCapabilities` and `ServerCapabilities`"* (minor change 1); Tasks moved out of core into `io.modelcontextprotocol/tasks` (major change 6)

---

## Question 2 — what the runtime actually surfaces

### How it was tested

`daemon/scripts/probe-mcp-notification-delivery.mjs`, three configurations, three
checkpoints, two target states.

- **CP1 — the daemon emitted the broadcast.** A *second, independent* connection to
  the daemon's Unix socket observes the `*_event` frame. The connection that fires
  the event is a different one, so no broadcast is confirmed only by its own caller.
- **CP2 — the notification left our server.** A tee wrapper around the MCP server
  logs every JSON-RPC frame in both directions.
- **CP3 — the model received it**, in two strengths: **CP3a** the nonce appears
  anywhere in the conversation the client emitted (it was put into context at
  all), and **CP3b** the model quoted it back. Terminal rendering was never
  consulted; a line drawn on a pane the model does not read is the failure this
  ticket exists to catch.

**Target state is measured, not assumed.** For each notification frame the probe
computes from the recorded wire whether a client→server request was outstanding
at that instant. A cell with no frame in it is reported as *untested*, and makes
the probe exit non-zero — an untested cell presented as a result is exactly the
"looks finished" failure this epic keeps re-finding.

### The results

Nonce root `06F4932D42A7`, model `sonnet`, Claude Code `2.1.222`.

```
                        CP1        CP2        CP3a in-flight   CP3a idle
A — protocol floor     n/a        observed   dropped          dropped
C — positive control   n/a        observed   dropped          dropped
B — real path          observed   observed   dropped          dropped
```

Configuration B, per state:

```
  per target state (state measured from the wire, not assumed):
    in-flight : 25 frame(s) [INFLIGHT0 … INFLIGHT24] during tools/call
                CP3a in context: NO    CP3b quoted: NO
    idle      : 1 frame(s) [IDLE]
                CP3a in context: NO    CP3b quoted: NO
```

Real frames, produced by the real `daemon/dist/mcp.js` from real
`agent_reset_event` broadcasts, observed leaving the server:

```json
{"method":"notifications/message","params":{"level":"info","data":"[Butchr Event] agent_reset_event - task/KAN-167-PROBE-06F4932D42A7B-INFLIGHT0"},"jsonrpc":"2.0"}
{"method":"notifications/message","params":{"level":"info","data":"[Butchr Event] agent_reset_event - task/KAN-167-PROBE-06F4932D42A7B-IDLE"},"jsonrpc":"2.0"}
```

### The control — why a "NO" here means anything

A detector that has only ever said NO is indistinguishable from a broken
detector. Configuration C is identical to A except that the same nonce also rides
out **on the tool result**:

```
  CONTROL — the same nonce carried on the tool result instead:
    control nonce present in context : YES  (06F4932D42A7-C-CONTROL)
    control nonce quoted by the model: NO
```

`present in context: YES` is the load-bearing line: the probe **can** see a nonce
that is really delivered. `quoted: NO` is correct behaviour, not a failure — the
question asked the model about text arriving *outside a tool result*, and the
control arrived *inside* one, so "NOTHING ARRIVED" was the right answer.

The four notification-borne nonces in that same session were absent from context
entirely. Same session, same client, same model, same nonce format — the only
difference is which transport carried them.

### The model-side transcript

Verbatim, both turns, configuration B (the real path). Turn 2 asked: *"Since your
previous turn, did any text arrive from an MCP server outside of a tool result —
for example a log line, a server notice, or any text containing the word PROBE or
the phrase 'Butchr Event'? If yes, quote every such line VERBATIM. If nothing of
the kind arrived, reply with exactly: NOTHING ARRIVED."*

```
    | READY
    | NOTHING ARRIVED
```

Twenty-six `[Butchr Event]` notifications had crossed the wire to this client
between those two lines.

### The `initialize` capture, verbatim

Request, from Claude Code to our server:

```json
{"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"roots":{"listChanged":true},"elicitation":{}},"clientInfo":{"name":"claude-code","title":"Claude Code","version":"2.1.222","description":"Anthropic's agentic coding tool","websiteUrl":"https://claude.com/claude-code"}},"jsonrpc":"2.0","id":0}
```

Result, from `daemon/dist/mcp.js`:

```json
{"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{},"logging":{}},"serverInfo":{"name":"butchr-mcp","version":"1.0.0"}},"jsonrpc":"2.0","id":0}
```

What that tells us, directly:

- **Negotiated `protocolVersion` is `2025-11-25`** — not `2026-07-28`. Neither
  side speaks the current revision.
- The client declares **`roots` and `elicitation` only**. It does **not** declare
  `sampling`, and it does not declare `tasks`. Sampling is therefore unavailable
  to us on this client regardless of anything else.
- Our server correctly declares the `logging` capability, which is the one the
  specification requires for `notifications/message`.

**`logging/setLevel` requests from the client: 0**, in every configuration. The
client never sets a log level. At `2025-11-25` that is not a precondition — the
server may emit anyway, and did. There was nothing to suppress, so the "does
suppressing or sending it change the result" question resolves to: the client
never sends it, and the server's emissions are permitted without it.

### Our SDK is not the blocker, and cannot reach the current revision

Read out of the installed package, not assumed:

```
sdk version: 1.30.0
LATEST_PROTOCOL_VERSION = '2025-11-25'
SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
```

`@modelcontextprotocol/sdk` `1.30.0` **does not implement `2026-07-28`.** That is
a finding, not a task — upgrading it is explicitly out of scope for KAN-167, and
there would be nothing to gain from it today, since the client also negotiates
`2025-11-25`.

### What the probe manufactured, and what that leaves uncovered

Stated plainly, because a proof that supplies its own input has not tested that
the input arrives:

- **Configuration A and C emit their own notifications** from a stub this script
  writes. They test the client's handling of a well-formed frame and nothing
  about Butchr's daemon. Configuration B covers that.
- **Configuration B fires its own daemon events**, by resetting scratch
  workspaces it creates for the purpose. It does **not** re-establish that
  production events fire on their own; the ticket already establishes that by
  citation (`router.ts:1220`, `:1409`, `:1491`, `:1555`, `:904`, `:951`, `:1758`;
  `daemon.ts:198`, `:401`). What B tests is that a real event, once broadcast by
  the real daemon, travels through the real `daemon/dist/mcp.js` and is then
  dropped by the client.
- **The in-flight window in configuration B is manufactured.** A real butchr
  `tools/call` answers in ~20ms — measured; the first event landed 9ms after the
  response closed the window. The tee therefore delays **that one response frame**
  by 4s. Its bytes are unchanged, and every notification frame is the real
  server's own output forwarded the instant it is produced. Only the window is
  widened, and it is widened on the client's side of our server.
- **Not covered by anything, by anyone:** whether a notification arriving
  mid-tool-call *disturbs* that call — the fourth defect on KAN-150. This probe
  measures whether such a notification is **delivered**, not whether it is
  destructive, and the destructive case is only reachable if delivery happens at
  all. It cannot be tested until CP3 passes. **No script owns this today**, and
  that is deliberate rather than overlooked.

---

## The idle-vs-in-flight question, answered

**Empirically, at the revision our fleet negotiates (`2025-11-25`): the daemon can
reach neither.** Notifications fired at an idle agent and notifications fired
into an open `tools/call` window were both dropped by the client. The distinction
does not currently buy us anything, because the floor is zero in both states.

**By specification, at the current revision (`2026-07-28`): the daemon could not
reach an idle agent even with a cooperating client.** `notifications/message` is
request-scoped and forbidden absent `io.modelcontextprotocol/logLevel` on a
specific request; `subscriptions/listen` carries only the four change-notification
types and cannot carry a message. So a daemon→agent nudge to an idle agent has no
protocol-legal form at the current revision.

**The shape the epic agent guessed at is the shape the protocol is moving to.**
If this is ever built, it is *the agent asking and the daemon answering* — not the
daemon delivering. That is the same conclusion this epic already reached from
CrabCast: events are a latency optimisation over an authoritative poll, never the
sole source of truth.

---

## What this does and does not clear of KAN-150's four defects

**It clears none of them.** All four are consequences of typing into a composer,
and typing into a composer remains the only mechanism that works.

| Defect | Status after this finding |
| --- | --- |
| 1. The send-race (KAN-61) — `success: true` means *typed*, not *delivered* | **Not cleared.** Unchanged. |
| 2. No provenance (KAN-149) — a nudge is indistinguishable from the human | **Not cleared.** And KAN-149 can no longer be held on the expectation that this lands soon — see below. |
| 3. The storm guards — a send is a destructive interrupt | **Not cleared.** Unchanged. |
| 4. An interrupt leaves a tool call half-applied while reporting total rejection | **Not cleared**, and still untestable: it needs a delivery mechanism that does not exist. |

**One consequence for a held ticket.** KAN-149 was being held because provenance
tagging on the typing mechanism is work we would throw away if KAN-150 landed. On
this finding, KAN-150 cannot land — the earliest it could is a Claude Code release
that surfaces server notifications, which is not ours to schedule. **That is a
decision for the epic agent, not for me**, and I have not touched KAN-149.

Three first-hand specimens of defect 3 were collected without trying: this task's
own agent was interrupted mid-turn by poller nudges three times in the first
twenty minutes, twice while mid-tool-call. The story agent recorded the first
([KAN-150 comment](https://wroosbit.atlassian.net/browse/KAN-150)). They cost a
turn each and every one of them said "no reply is expected".

---

## What would have to change

In increasing order of how much of it is ours:

1. **The client would have to surface server notifications to the model.**
   This is the whole blocker today and **none of it is ours**. Claude Code reads
   the frames and drops them. Nothing in Butchr, in our SDK, or in the protocol
   at `2025-11-25` prevents delivery.
2. **A protocol-legal carrier would have to exist for the current revision.**
   Even with a cooperating client, `notifications/message` is deprecated and
   request-scoped at `2026-07-28`. Anything built on it now is built on a feature
   with a removal date. `subscriptions/listen` is the only surviving push channel
   and it cannot carry arbitrary payloads.
3. **The design would have to invert.** Agent-pulls beats daemon-pushes under
   `2026-07-28`, and it is the only shape that works on both revisions: a tool the
   agent calls to drain its own inbox is legal at `2025-11-25`, legal at
   `2026-07-28`, and works on today's client — because tool results *do* reach the
   model, as configuration C proves in the same session in which notifications did
   not.

Point 3 is a genuine option that this finding does not close off, and it is the
one thing here worth the design task's attention. **It is not in scope for this
ticket and I have not built it.** It would not remove defects 3 and 4 the way a
pushed message would — an agent that must ask is an agent that only hears when it
asks — so it is a different trade, not the same win. That is the epic agent's call.

---

## Reproducing this

```bash
cd daemon && npm run build
node scripts/probe-mcp-notification-delivery.mjs             # all three configs
node scripts/probe-mcp-notification-delivery.mjs --only=B    # the real path only
```

The probe is deliberately **outside** the `verify-` namespace. It drives a live
`claude` CLI and a real model, so it is an experiment, not a deterministic proof
of product behaviour that CI can re-run; a `verify-` name would enrol it in
`verify-script-sweep` and assert a guarantee it cannot make.

Its exit code reports whether it could **observe** each checkpoint, not whether
delivery succeeded — "the client drops it" is the finding, and it exits 0. It
exits non-zero if a configuration fails to reach a verdict, if a target state
goes untested, or if the positive control fails to arrive, because in each of
those cases it is reporting nothing trustworthy.
