# Channel-based delivery for Butchr messages — a design

**KAN-234, the design slice of KAN-150.** Repository read at `51e8fc2`.
Written 2026-08-08. **Design only — no product file is modified by this
ticket.**

This exists so `epic/KAN-39` can agree or disagree cheaply, and so
implementation tickets can be carved from it. It is not a specification: where
a decision is mine to make I make it and say why, and where something is
unknown I say that instead of choosing a plausible answer.

---

## 0. The decisions, up front

| # | Question | Decision |
| --- | --- | --- |
| 1 | `mcp.ts` capability or a sibling server? | **`mcp.ts` gains the capability.** §1.2 |
| 2 | What carries an *addressed* message? | **Nothing today — this is the missing piece.** §1.3 |
| 3 | What may a sender claim? | **Four distinct claims, never collapsed.** §2 |
| 4 | Does the channel supersede KAN-149's tag? | **No — they coexist, and the tag stays.** §3 |
| 5 | Do channel events disturb a tool call? | **UNANSWERED. KAN-219 has not reported.** §4 |
| 6 | What happens to the composer path? | **Kept, for a named and shrinking set of cases.** §5 |
| 7 | CrabCast: CLI or socket? | **Socket — the lean holds, and I read why.** §5.3 |

**The single most important thing in this document is §1.3**, and it is not in
KAN-217, KAN-150 or KAN-234. The pump this migration is supposed to be built on
is a **broadcast** — it fans out to every connected client and carries no
addressing whatsoever. The story wants to send a message *to one agent*. Those
are different mechanisms, and the gap between them is the largest piece of
unnamed work in this migration.

### Three conditions in my own ticket had lapsed by the time I started

Re-checked at the moment of starting rather than taken from the ticket:

* **KAN-207 is In Review, not In Progress** (checked 2026-08-08, updated
  09:38). Its work is done and waiting on review, so §5 treats it as landing
  *before* channels, not racing them.
* **KAN-233 has left this repository** — the human stopped it, per KAN-234
  comment 11026. §5.4 handles its substance rather than its ticket.
* **The client is `2.1.226`, not `2.1.224`** (`claude --version`, this machine,
  today). KAN-217 scoped its finding to *"`2.1.224`, and about nothing else."*
  I did not re-test it — that is out of scope and KAN-219 is exercising the
  same path anyway — but §6.1 records that the premise's stated scope no longer
  covers today's client, because that is exactly the moving contract §6.1 is
  about.

---

## 1. Delivery

### 1.1 What is established, and what it does not cover

From KAN-217 (`docs/channel-delivery.md`, `daemon/scripts/probe-channel-delivery.mjs`),
cited rather than re-run:

* A channel event **reaches the model** of a real Butchr agent — proven by a
  nonce that existed only inside a daemon broadcast, echoed back out through
  the channel's own reply tool, composer never used in either direction.
* **The flag is load-bearing.** A server in `.mcp.json` but not named to
  `--channels` reaches neither pane nor model. Enabling this is a **launcher**
  change as well as a server change.
* **A dead recipient is loud** (`ECONNREFUSED`); **a misconfigured one is
  silent**.
* **Bun is not required.** Plain Node against `@modelcontextprotocol/sdk`,
  which the daemon already depends on.
* **Delivery is not compliance.** An unprimed session correctly refused to act
  on a channel event, naming it as probable prompt injection.

**Every configuration in that probe fired at an idle agent.** That is the
KAN-219 gap, and it is §4.

### 1.2 Decision: the capability goes in `daemon/src/mcp.ts`

KAN-217 recommended this and I agree, but not for the reason it gave — its
reason is true and is the weaker half.

**The stated reason (plumbing) is real:** `mcp.ts` is already spawned once per
agent, already holds a persistent connection to the daemon's Unix socket
(`daemon/src/mcp.ts:69-95`), and already carries the agent's identity on its
argv via `withWorkspaceIdentity`. Verified at `51e8fc2`; the capabilities
object is at `:54-56` and the `*_event` forwarder at `:84-92`, exactly as
cited.

**The reason that actually decides it is the reply path.** Two-way delivery
needs `capabilities.tools` and a reply tool the model can call. If the channel
is a sibling server, that reply tool lives on a *second* butchr-shaped server,
and the model must choose between two servers that both look like Butchr — one
holding `butchr_send_to_agent`, the other holding the reply. If the capability
is on `mcp.ts`, the reply is simply another `butchr_*` tool beside the ones the
agent already knows. The vocabulary stays coherent.

**And the identity argument is decisive against a sibling.** §1.3 shows the
daemon will have to learn which connection belongs to which agent. A sibling
server means a *second* connection per agent that must also register an
identity, in a second place, kept in step by hand — which is KAN-145's defect
reproduced deliberately after we have already paid for it once.

**The honest argument for a sibling, and why it loses.** A sibling isolates a
research-preview capability from the server that carries every Butchr tool: if
the channel contract moves, the blast radius is a server nobody's tools live
on. That is a real concern and I am not dismissing it. It loses because the
isolation is mostly illusory — both servers are spawned by the same client from
the same `.mcp.json`, so a client-side change severe enough to break one
breaks the other's transport too — and because the cost is paid on every
activation forever, while the benefit applies only in a failure we can also
mitigate directly.

**So the mitigation is required rather than optional** (and is a named ticket
in §7): **channel emission must be independently disableable at runtime,
without removing the declared capability and without touching the tool
surface.** When it is off, `mcp.ts` must behave exactly as it does today. That
is what makes the blast-radius objection answerable rather than merely
outvoted.

### 1.3 The gap nobody has named: there is no addressing

**This is the core finding of this design.**

The pump KAN-217 points at is fed by `broadcast`, and `broadcast` is
fan-out-to-everyone. Read at `51e8fc2`, `daemon/src/daemon.ts:191-197`:

```ts
const connections = new Set<net.Socket>();

const broadcast = (msg: any) => {
  for (const conn of connections) {
    writeJsonLine(conn, msg);
  }
};
```

`connections` is a bare `Set<net.Socket>`. **No identity is attached to a
connection anywhere.** Agent identity reaches the daemon *per request* — the
MCP server stamps `workspaceType`/`workspaceKey` into each request body, which
is how `senderTagFor` derives KAN-149's tag (`daemon/src/router.ts:1987`) — but
that tells the daemon **who is calling**, never **which socket to answer on**
for an arbitrary recipient.

So the two payload classes that would ride a channel are not the same problem:

| Class | Today | Over a channel |
| --- | --- | --- |
| **Fleet events** (`agent_activated_event`, …) | broadcast → `notifications/message` → **discarded** (KAN-167) | works with the pump as-is; every agent gets every event |
| **Agent-to-agent messages** (`butchr_send_to_agent`) | typed into the recipient's composer with a Ctrl+C | **has no carrier** — there is nothing to route on |

**KAN-150 is about the second row.** KAN-217 proved the first row's carrier and
recommended reusing it, which is right about the *place* and incomplete about
the *mechanism*. Broadcasting an addressed message to every agent and having
each ignore the ones not for it is not an acceptable design: it puts every
agent's private steer into every other agent's context, and it makes the storm
guards meaningless because every send interrupts the whole fleet.

**What has to be built, therefore:**

1. **The MCP server announces itself on connect.** A `hello` carrying the
   `workspaceType`/`workspaceKey` already on its argv — the same values, from
   the same source, so nothing new can drift.
2. **The daemon keeps an identity → connection map**, maintained on connect and
   on `close`. One agent may legitimately hold more than one connection (a
   reconnect after a daemon restart, plus the Chrome extension, which is *not*
   an agent and must not be routable as one).
3. **`butchr_send_to_agent` gains a channel route**: look up the recipient's
   connection, write a `channel_message` frame to that connection only, and let
   that agent's `mcp.ts` turn it into `notifications/claude/channel`.

**The failure mode of the lookup is the interesting part**, and it is what
makes §2's confirmation honest: *no connection for that identity* is a
first-class, sender-visible answer, and it is structurally the same fact as
KAN-217's `ECONNREFUSED` — the agent is not there. That is the fail-fast the
human asked for, surfaced at the routing layer instead of at the transport.

**One inherited hazard worth fixing while here, not separately.** The pump
selects events with `msg.action.endsWith('_event')`. CrabCast has already
retired exactly that convention: `crabcast/docs/event-contract.md` at their
`origin/main` says the suffix test meant *"reading an internal broadcast over
somebody's shoulder"*, and their nine events are now dotted names
(`agent.activated`, `agent.status_changed`, …) governed by an executable
allowlist. Butchr still emits `*_event` names from its own
`router.ts`/`daemon.ts`, so **the suffix test is correct today** — but under
KAN-104 decision 3, where Butchr proxies CrabCast, a suffix test matches
**zero** dotted names and the pump's `.catch(() => {})` makes that silent. The
channel should select on an explicit allowlist from the day it is written.

### 1.4 The launcher, and what the flag costs an unattended fleet

`daemon/src/launchers.ts:496-510`, verified at `51e8fc2`:

```
claude --permission-mode bypassPermissions --continue ||
claude --permission-mode bypassPermissions <prompt>
```

The `||` is load-bearing and measured — `--continue` exits 1 when there is no
conversation — and this design does not restructure it. The channels flag is
added to **both** arms, which is what KAN-217's configuration D did.

During the research preview `--channels` accepts only Anthropic-allowlisted
plugins, so a Butchr-written channel needs
`--dangerously-load-development-channels server:butchr`. **Three consequences
for a fleet that runs unattended, in descending order of how much they should
worry a reviewer:**

**1. It puts a blocking dialog on the critical path of activation itself.**
The flag opens a full-screen confirmation *before the session starts*, once per
`claude` invocation — so **twice** on a fresh workspace, because of the `||`.
Nothing in Butchr answers it; KAN-217's probe drives it with
`herdr pane send-keys … Enter`. The failure mode is therefore **not** "a
message is lost" but "**the agent never reaches its prompt**". A messaging
feature that can brick activation has a blast radius far beyond messaging, and
that asymmetry is the strongest argument in this document for staging the
cutover (§5) and for the kill switch in §1.2 being a hard requirement.

**2. It is a second dangerous flag on top of one we already run.** The fleet
already launches with `--permission-mode bypassPermissions`. Adding a channel
means content can be injected directly into the model's context of a session
that does not stop to ask before acting. **This is not a new exposure** — the
composer path already types arbitrary text into a bypassing agent, and anything
that can reach the daemon's Unix socket could already do it (KAN-149 names the
socket as the trust boundary, and it is a filesystem permission, not a
credential check). But it becomes *quieter*: a composer injection leaves a
visible line in the pane a human can scroll back to, and a channel event does
not. Worth stating plainly rather than discovering later.

**3. There is a startup race, already measured.** KAN-217's defect 3: the
client spawns the channel server only *after* the dialog clears, so the pane
can look ready seconds before a listener exists, and an event fired into that
window is lost silently. Whatever answers the dialog must wait for the
server's own readiness, not for the pane. KAN-217 also warns that the
`Channels (experimental) …` startup banner is **not** evidence of a working
channel — it was printed over a crashed server — so it must not be used as the
health check.

---

## 2. Confirmation — four claims, and the sender may make exactly one

This is where `success: true` has failed five times on this board. The
discipline is to name the claims separately and never let a mechanism assert a
stronger one than it measured.

| # | Claim | What establishes it | Available? |
| --- | --- | --- | --- |
| **C1** | *The transport accepted the bytes* | the `await` on `notification()` resolving | **yes**, and it is nearly worthless alone |
| **C2** | *A live session exists for this recipient* | the identity→connection lookup (§1.3); `ECONNREFUSED` at transport | **yes** — this is the useful one |
| **C3** | *The text entered the session's transcript* | composer path only: `messageLanded` scraping the pane | **yes, composer only** |
| **C4** | *The model read it* | an application-level ack — the model calling the reply tool | **yes, and only the channel can offer it** |

**What the sender learns on the channel path: C1 and C2.** A resolve means the
bytes left; a missing connection or a refused one means the agent is not there.
That pair is exactly the fail-fast the human specified — *"if the agent is
offline it doesn't get the notification, and the sending agent will be notified
of that."*

**What it still cannot learn: C4, unless the recipient volunteers it.** KAN-217
is explicit that the reference is right about this — the await resolves when
the message is written to the transport, not when Claude has processed it.
Delivered-to-the-session and read-by-the-model are different claims and this
design does not collapse them.

**The silent case is the one to design against.** KAN-217 reproduced it twice
by different causes (flag absent; print mode): a live session, a clean resolve,
and nothing arrives. **A misconfigured recipient is invisible.** That is a
configuration error rather than a runtime one, which is why the mitigation is
also configuration-shaped: §7's T5 asks for a startup self-check that proves
the loop end-to-end once per agent, at bring-up, when a failure is cheap —
rather than discovering it at the first steer that mattered.

**What the channel gains over the composer, and what it gives up.** It gains
C4, which the composer has never had: today `deliverToAgent` polls the pane for
20s and can conclude only C3. It gives up C3 — and that is a real loss worth
naming, because C3 is what `nudge.ts` currently retries on. **The channel must
not be health-checked by scraping the pane.** KAN-217 measured the inbound
render truncating to pane width with the nonce clipped off a line that was
plainly drawn, flapping YES/NO across runs while the model received it every
time. A pane-scraping health check on this path would report failures that did
not happen.

**Composer-path confirmation is not ours to reimplement.** Per KAN-234 comment
11041, relaying the human's decision: Butchr consumes CrabCast's interface and
never its source, and CrabCast's `send_to_agent` already returns a three-way
`verdict`. I verified the citation at their `origin/main` rather than trusting
it: `crabcast/src/router.ts:4492` carries *"THREE VERDICTS REACH THE CALLER,
NOT TWO"*, with `verdict: 'refused'` at `:4537` and `verdict: 'unverifiable'`
at `:4564`. Their reasoning is worth importing wholesale, because it is the
same distinction this section is built on:

> *"a caller that cannot tell 'it did not arrive' from 'I could not see' will
> eventually treat one as the other, and the two license opposite actions.
> Resending on `not-delivered` is right; resending on `unverifiable` types a
> duplicate at an agent that may already be working on the first copy."*

**So the two paths keep two separate confirmation stories** — CrabCast's
`verdict`, consumed, for the composer; C1/C2/C4 for the channel — and this
design deliberately does not merge them into one vocabulary. A single word
covering both would have to be the weaker of the two.

---

## 3. Provenance

KAN-149 is Done. The composer path carries a daemon-derived tag —
`[from story/KAN-75]`, `[butchr daemon]`, `[from an unidentified butchr
caller]` — stamped in `handleSendToAgent` from the caller's own MCP process
identity, never from the message body (`docs/message-provenance.md`).

**What the channel gives us that KAN-149 could not.** The tag is a *convention*:
its own documentation says so, and says why — an agent can type
`[from epic/KAN-39]` into a body, and the forgery lands *behind* the daemon's
real leading tag rather than replacing it, but the text is there and a careless
reader can still be fooled. A channel event is different in kind:
`<channel source="…">` is **structure the model receives from its runtime, not
text inside the payload**, and `source` is set by the client from the server's
configured name rather than by anything the sender writes. A message body
cannot forge a tag it is nested inside.

**That is a real upgrade and it is narrower than it sounds.** What becomes
unforgeable is *"this arrived over Butchr's channel"* — a statement about the
carrier. It is **not** *"this came from `story/KAN-75`"*: `source` names the
channel server, which is one server per agent, so every message on it carries
the same `source` regardless of who asked for it to be sent. **The sender's
identity still rides inside the payload**, and it is still only as good as the
daemon's stamping.

So the honest statement is: **the channel authenticates the channel; the daemon
still vouches for the sender.** The trust boundary is unchanged — it remains
the daemon's Unix socket, a filesystem permission rather than a credential
check. What improves is that the *outermost* frame stops being forgeable, which
closes the "unmarked means the human" complement structurally instead of by
enumeration.

**Decision: they coexist; the tag stays, and this is not a transitional
compromise.**

1. Two carriers survive the cutover (§5), and the composer one has no
   structural frame at all. Removing the tag would leave that path bare.
2. `meta` keys **must be identifiers** — the reference states that keys with
   hyphens *"are silently dropped"*. A workspace key like `KAN-75` is not an
   identifier, so the sender cannot be carried as a `meta` key, and a dropped
   attribute fails silently. The tag in the body is not made redundant by
   anything the channel offers.
3. Prompt vocabulary is a fleet-wide contract. Four prompts teach `[from
   type/KEY]`; the channel adds an outer frame and should not invalidate the
   inner one agents are already trained to read.

**One prompt change is required and it is not optional.** KAN-217's refusal
finding: an unprimed session correctly declined to act on a channel event,
naming it as probable prompt injection, and *"the `instructions` string is
load-bearing, and pressure in it backfires"* — wording that pre-authorises its
own execution is what marks content as an attack. So agents must be told, in
`.butchr-prompt.md` where they read it before anything arrives, that the
channel is an expected carrier — and the server's `instructions` must describe
the reply tool **without** urging its use. §7's T6 owns this, and it is
sequenced *before* the cutover rather than alongside it, because an agent that
has not been briefed will refuse correctly and look exactly like a delivery
failure.

---

## 4. Interruption semantics — **INCOMPLETE, and deliberately so**

**KAN-219 has not reported. This section is a gap, not an answer.**

Checked at 2026-08-08 09:4x: KAN-219 is **In Progress** under another owner,
with one comment (11028) that is a **plan**, not a finding. It states its
approach — three arms (**U** undisturbed control, **C** channel mid-call, **X**
`send_to_agent` mid-call), the in-flight outcome recorded on the filesystem by
the tool itself rather than by the model, the window observed rather than
assumed and widened with that fact stated. **No result exists yet.**

Per KAN-234's acceptance criterion 4, I am leaving this unanswered rather than
assuming, because assuming it is what cost this story four days.

### What the design provisionally assumes, marked as an assumption

**Assumption A (unverified): a channel event does not disturb an in-flight tool
call.** Its only basis is the reference — *"Events queue into the session and
are processed in order. If several notifications arrive while Claude is busy,
they're delivered together on the next turn"* — and KAN-219's own ticket says
in terms **not to let that sentence stand in for the observation**, because
that substitution is this epic's named defect. The reference was right about
acknowledgement and about Bun; it was silent about the blocking startup dialog
and about a model declining to act on delivered content, both of which KAN-217
found only by running it.

**What rests on Assumption A, and what does not:**

* **Everything in §1, §2, §3 and §5 stands without it.** Delivery, addressing,
  confirmation, provenance and the cutover shape do not depend on the answer.
* **The storm guards depend on it entirely**, and so does the *value* of the
  migration. If channels interrupt too, the migration buys provenance and
  confirmation but not the thing KAN-150's defect list is mostly about.

### The storm guards: re-derived conditionally, relaxed on nothing

The guards in `prompts/task.md:202-215` (and the same text in `epic.md`,
`story.md`) exist because **a send is a preemption**: `butchr_send_to_agent`
opens with a Ctrl+C, and a tool call in flight is killed and does not resume.
Each guard traces to that cost:

| Guard | Why it exists today | If Assumption A holds | If it does not |
| --- | --- | --- | --- |
| Meaningful transitions only | every send destroys work | **relaxable** — cost falls to context, not lost work | unchanged |
| Never notify the actor | it already knows; the interrupt is pure loss | **stays** — noise, not destruction | unchanged |
| A nudge must not generate nudges | cascade of preemptions | **stays** — cascades are still bad | unchanged |
| **Never two in a row** | *"the second kills its session"* | **relaxable, and this is the one that matters** | unchanged |

**None of these may be relaxed until KAN-219 reports.** The fourth is the one
KAN-207 is currently fixing on the daemon side (§5.2), and it is the clearest
example of a rule whose entire justification is the Ctrl+C. If channels do not
interrupt, that rule is obsolete on the channel path — and if they do, it
applies unchanged and the migration's headline benefit is much smaller.

**Recommendation to `epic/KAN-39`: do not file the prompt-rewrite ticket (T7)
until KAN-219 reports.** Every other ticket in §7 can be filed and worked now.
T7 is the only one that needs the answer, which is why it is last.

---

## 5. The cutover

KAN-150's acceptance criterion 4 is **no partial migration**: two mechanisms at
once is worse than either, because agents would have to know which one they are
on.

### 5.1 Decision: the composer is kept, for a named and shrinking set of cases

Not "retired", and not "kept as a fallback" in the vague sense AC 4 rightly
distrusts. **Kept for cases a channel structurally cannot serve**, enumerated
here so the set is closed rather than open:

| Case | Why the channel cannot serve it |
| --- | --- |
| **A human typing at a pane** | no Butchr code runs in that path at all (KAN-149's writer 4) |
| **An agent with no live session** | a channel is not a queue; there is nothing to deliver into |
| **Any agent not launched with the channels flag** | KAN-217's negative control: the event reaches nobody, silently |
| **Fallback while channels are a research preview** | §6.1 — the contract may move under us |

**AC 4 is satisfied not by having one mechanism, but by removing the guess.**
The rule that makes it honest: **an agent never chooses its transport and never
infers it.** The daemon decides, per recipient, at send time — it is the only
party that knows whether a live connection exists (§1.3) and whether that agent
was launched with the flag. The sender calls `butchr_send_to_agent` exactly as
it does today.

**And the response says which path was used and what that licenses.** This is
the part that discharges *"must not have to guess"*: the sender is told the
transport and the claim (§2) in the same response, so it never has to reason
about the fleet's configuration to interpret an outcome. An agent that wants to
know how its message travelled reads the answer; it never derives it.

### 5.2 KAN-207 — unaffected, and it lands first

**KAN-207 is In Review as of today**, not In Progress as my ticket said. It
fixes the daemon delivering one transition-plus-comment as **two back-to-back
nudges** to the same recipient — the daemon breaking the storm guard the
prompts impose on agents.

**Nothing in this design competes with it, and its work is not wasted:**

* It lands **before** channels — it is in review now, and §7 is at least five
  tickets of work.
* Its fix is in `jira-poll.ts`'s `recognise`/`notify`, deciding **whether to
  send at all and to whom**. That is *routing policy*, and it sits **above** the
  transport this design changes. Coalescing two events into one notification is
  correct regardless of what carries the notification.
* Its second question — *is the lost Enter caused by the back-to-back send
  itself?* — is a **composer** question, and §5.1 keeps the composer. If
  channels later carry poll notices, KAN-207's coalescing still applies and its
  Enter-loss investigation stops applying to that path. Neither outcome
  invalidates the ticket.

**One genuine interaction its owner should know about**, and the reason it is
named here rather than left to be discovered: KAN-207 asks *"whether the two
events should coalesce, or whether the status event alone should win"*. If
Assumption A (§4) turns out true, the pressure behind that question drops
sharply — two channel events cost context, not destroyed work, and the
reference says they would be *"delivered together on the next turn"* anyway,
which is coalescing performed by the runtime. **This is not a reason to change
KAN-207.** It is a reason not to be surprised later that its careful trade-off
became cheap, and its coalescing remains correct either way.

### 5.3 KAN-233's substance — CrabCast's, and the question that actually matters

KAN-233 was stopped on the human's decision and its substance moved to CrabCast
(KAN-234 comment 11026). So the question is not *what becomes of its work* but
the sharper one that comment names: **if Butchr's messages move to channels,
what is CrabCast still detecting composer strands for?**

**The answer is that most of it survives, and this is worth stating so nobody
reads the migration as retiring their work.** §5.1's table is the argument: a
human typing at a pane is untouched by channels, and it is the case CrabCast's
detection most clearly serves. The composer keeps carrying the fallback cases.
What shrinks is only the agent-to-agent share of composer traffic, and only for
agents on the flag.

**I am not designing anything into CrabCast and am not filing against them**
(KAN-104 decision 3). Naming the interaction is the deliverable; the decision
is `epic/KAN-59`'s.

**On CLI versus socket, I was asked to check a fact rather than argue a
preference — so here is what I read.** `story/KAN-150`'s lean was the socket,
overturnable if CrabCast's socket is not a supported external surface while its
`bin` is. **The lean holds, and more strongly than it was offered.** At their
`origin/main`:

* `README.md` documents the socket as an interface, not an implementation
  detail: *"One long-lived daemon per machine, listening on a Unix socket
  (`<dataDir>/crabcast.sock`, newline-delimited JSON, id-correlated)."*
* `docs/event-contract.md` opens *"This document is what a consumer builds
  against"*, and its executable half (`src/events.ts`) is imported by both the
  daemon and the MCP server specifically so the contract and the code cannot
  drift.
* `package.json` is `"private": true` with `"main": "dist/index.js"` and a
  `bin` — so the package is **not** publishable and importing it as a library
  is the option genuinely foreclosed, which is the constraint the human's
  decision states.

**One condition a consumer must accept, and it belongs in whichever ticket
consumes it:** their events are **at-most-once**, and their README is explicit
that *"a subscriber that does not independently poll `list` on a timer is not
entitled to convergence."* That is the same shape as our own no-durable-queue
decision (§6.2) — and it is one more reason the ticket, not any event stream,
remains the durable inbox.

### 5.4 The order that keeps the fleet working

The composer stays fully functional until the last step. There is no moment
where the fleet is half-migrated:

1. Channel carrier and addressing land **disabled** (§1.2's kill switch). Zero
   behaviour change; the composer carries everything.
2. Agents are briefed (§3's T6) **before** anything can arrive, so no agent
   meets an unexplained channel event.
3. Enabled for **one** agent type, with the composer still the fallback for
   every recipient that has no live channel.
4. Widened only after the self-check (§7 T5) has run clean across a full fleet
   bring-up.
5. Prompt guards re-derived **only once KAN-219 has reported** (§4).

---

## 6. The two constraints, designed within

### 6.1 Channels are a research preview

**The contract has already moved once during this ticket's own lifetime**, in
the weakest possible sense but the sense that matters: KAN-217 scoped its
finding to client `2.1.224` *"and about nothing else"*, and this machine now
runs `2.1.226`. Nothing is known to have broken — KAN-219 is exercising the
same path today and will report against `2.1.226` — but the premise's stated
scope no longer covers the client the fleet runs. That is not alarmism; it is
the constraint behaving exactly as documented, on day one.

**What breaks if the contract moves, in order of blast radius:**

| Change | Symptom | How bad |
| --- | --- | --- |
| Flag renamed/removed | `unknown option` → **every activation fails** | **worst** — messaging feature kills bring-up |
| Dialog text/flow changes | whatever answers it stops answering it → agents hang at start | **very bad**, same reason |
| Notification shape changes | events leave and arrive nowhere | bad, and **silent** |
| `source`/`meta` semantics change | provenance degrades | contained |

**The top two are activation failures, not messaging failures.** That is the
asymmetry from §1.4 restated, and it is why the kill switch must be operable
without a rebuild.

**How we would notice** — three mechanisms, because the silent case is the one
that matters:

1. **A startup self-check** (§7 T5). Each agent proves its own channel loop at
   bring-up, when failure is cheap and attributable. This is the one that
   catches the silent notification-shape change; nothing else does.
2. **Fall back rather than fail.** If the self-check does not pass, that agent
   uses the composer and says so. §5.1's rule holds: the daemon knows, the
   agent is told, nobody guesses.
3. **Pin the observation to a version.** Record the client version alongside
   the self-check result, so *"it worked on 2.1.226"* is a fact with a date
   rather than an assumption with a habit. `docs/staleness.md` already
   establishes this idiom in the daemon.

**Not** the startup banner: KAN-217 caught it printing over a crashed server.

### 6.2 A channel is not a durable queue — and this design does not build one

The human decided this is correct rather than a gap (KAN-217 comments 10918,
10919). **The ticket remains the durable inbox**, and that convention is what
makes fail-fast safe.

Concretely, this design **does not** introduce: a message store, retry-until-
delivered, replay-on-reconnect, or an outbox. §1.3's identity→connection lookup
is a *point-in-time* question — is this agent here right now — and its negative
answer is returned to the sender immediately rather than parked.

The one place a queue would be tempting is §1.4's startup race, where the
listener lags the pane and an event fired into that window is lost. **The fix
there is ordering, not buffering**: do not send until the agent's own readiness
is observed. KAN-217 established that the pane is not the signal.

---

## 7. Proposed task breakdown — **not filed**

Filing is `story/KAN-150`'s, after `epic/KAN-39` reviews this. **Seven tickets.**
T1–T3 are the migration's spine and are strictly ordered; T4–T6 can run in
parallel once T2 lands; T7 is blocked on KAN-219.

| # | Ticket | Depends on | Why it is its own ticket |
| --- | --- | --- | --- |
| **T1** | **Identity on the daemon connection** — `hello` on connect, identity→connection map, removal on `close`, extension explicitly not routable | — | §1.3. Pure daemon-side plumbing with no channel in it. Independently provable and independently useful. |
| **T2** | **The channel capability on `mcp.ts`** — declare `experimental['claude/channel']`, emit `notifications/claude/channel`, explicit event allowlist replacing the `endsWith('_event')` test, **behind an off-by-default runtime switch** | T1 | §1.2. Lands inert. The switch is the §1.2 mitigation and must ship *with* it, never after. |
| **T3** | **The launcher change** — flag on both arms of the `||`, something that answers the blocking dialog and waits for **server** readiness, not the pane | T2 | §1.4. Highest-risk ticket in the set: it can break activation. Deserves its own review and its own revert. |
| **T4** | **Addressed send over the channel** — `butchr_send_to_agent` routes to a connection; response names transport and claim (§2, §5.1) | T2 | The behaviour change the story is actually about. Reviewed on semantics, not plumbing. |
| **T5** | **Per-agent startup self-check** — prove the loop at bring-up, record it with the client version, fall back to composer and say so | T3 | §6.1. The only thing that catches a silent contract move. |
| **T6** | **Brief the agents** — `.butchr-prompt.md` and the server `instructions`; describe the reply tool **without** urging its use | T2 | §3. Must land **before** any enablement, or agents refuse correctly and it reads as delivery failure. |
| **T7** | **Re-derive the storm guards** in the four prompts | **KAN-219** | §4. Cannot be written until the interruption answer exists. Do not file it yet. |

**Ordering:** T1 → T2 → {T3, T4, T6} → T5 → *(KAN-219)* → T7. The cutover
sequence in §5.4 rides on top of this and is not itself a ticket.

**KAN-223 and KAN-224 stay outside this set**, per `story/KAN-150`'s decision
(KAN-150 comment 11042) — parallel, `Relates`, not inside the decomposition.

**And its "least certain" case does not trigger.** That decision said it should
be revisited if this design concluded Butchr should route *all* agent messaging
through CrabCast's daemon, which would make KAN-223 the seam. **It does not.**
§5.1 keeps the composer for a named set and §2 consumes CrabCast's `verdict`
for exactly that path — reading a response field from a call Butchr already
makes, which needs no interface extraction. The channel path is Butchr's own
daemon socket to Butchr's own MCP server and does not touch `HerdrBridge`. So
the two stay parallel, and I am recording that I checked rather than leaving
the condition unexamined.

---

## 8. What this design does not establish

Stated plainly, because an artifact whose sentence claims more than its
mechanism covers is this epic's recurring defect.

* **Interruption is unanswered** (§4). Assumption A is unverified and is
  labelled everywhere it is load-bearing.
* **Nothing here was measured by me.** This is a design built on KAN-167's and
  KAN-217's measurements plus a reading of the tree at `51e8fc2`. The claims I
  verified myself are citations — that the lines say what they were said to say,
  that `connections` carries no identity, that CrabCast's socket is documented
  as a consumer surface, that the client is `2.1.226`.
* **§1.3's addressing design is unbuilt and untested.** That the daemon *can*
  hold an identity→connection map is evident from the code; that routing a
  channel frame to one connection reaches that agent's model is **not**
  established. KAN-217 proved the carrier under a broadcast; nobody has fired an
  addressed frame at one connection. **T1 and T2 must prove it, and if it fails
  the whole shape in §1.3 is wrong.** No script owns this today.
* **The dialog-answering mechanism is unproven outside a probe.** KAN-217 drove
  it with `herdr pane send-keys`; whether that is robust across every activation
  path in an unattended fleet is T3's to establish and is the riskiest unknown
  in the set.
* **No security review of channels + `bypassPermissions`** (§1.4 point 2). I
  named the exposure and its precedent; I did not assess it. If `epic/KAN-39`
  thinks that needs its own ticket, it is not in my seven.

---

## References

| Source | What it establishes |
| --- | --- |
| `docs/channel-delivery.md` (KAN-217) | channels reach the model; flag is load-bearing; `ECONNREFUSED`; refusal; no Bun |
| `docs/mcp-notification-delivery.md` (KAN-167) | `notifications/message` is discarded — a different path, still true |
| `docs/message-provenance.md` (KAN-149) | the tag, and that it is convention not authentication |
| `daemon/src/mcp.ts:54-56`, `:84-92`, `:208-210` | capabilities, the pump, `butchr_send_to_agent`'s contract |
| `daemon/src/daemon.ts:191-197`, `:210-211` | **`broadcast` fans out; connections carry no identity** |
| `daemon/src/launchers.ts:96-148`, `:496-510` | identity stamping; the `claude` command and its load-bearing `||` |
| `daemon/src/nudge.ts:150-247`, `:286` | `messageLanded`, `deliverToAgent` — what composer confirmation can claim |
| `prompts/task.md:202-215` | the storm guards, and that they are rules |
| `crabcast` @ `origin/main`: `README.md`, `docs/event-contract.md`, `src/router.ts:4492-4564` | the socket as a documented consumer surface; at-most-once; the three verdicts |
| KAN-150 comments 11039, 11042; KAN-234 comments 11026, 11041 | the CrabCast constraint; KAN-223/224 parallel; KAN-233 moved |
