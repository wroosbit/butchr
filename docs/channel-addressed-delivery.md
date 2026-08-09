# Addressed channel delivery — measured, and what it is scoped to

**KAN-244 (T2 of KAN-150).** Companion to [`channel-delivery.md`](channel-delivery.md)
(KAN-217, broadcast) and [`channel-messaging-design.md`](channel-messaging-design.md)
§1.2–§1.3, which decided the shape this implements.

## The question, and the answer

KAN-217 proved a channel event reaches the model of a real Butchr agent **under a
broadcast** — a fan-out where every connected client gets every frame. Nobody had
fired an *addressed* frame at a single connection, and the distinction is not
academic: **a broadcast that happens to reach the right agent is
indistinguishable, from the recipient's side, from routing that works.**

> **YES.** An addressed channel frame reaches the model of one live Butchr agent
> and demonstrably not the model of another connected at the same moment.

Measured on **Claude Code 2.1.226**, model `sonnet`, by
`daemon/scripts/probe-addressed-channel-delivery.mjs`. Two real Butchr agents
activated through the daemon, both channel-enabled on the product's **own**
`butchr` MCP server. A token existing nowhere but inside a frame written to one
agent's socket was quoted back verbatim by that agent, off its own pane; the
other agent, asked the same question at the same moment, answered
`NOTHING ARRIVED`.

**The scope is the client version and it moves.** KAN-217's finding was scoped to
`2.1.224` and the fleet was past it within days. Channels are a research preview
(design §6.1); this is a measurement, not a contract, and it is re-measured by
re-running the probe, never by citing this page.

### What the recipient actually saw

The client wraps the notification in its own tag, naming the server:

```
<channel source="butchr" probe="KAN-244" addressedTo="task/KAN244-PROBE-…-A">
[Butchr] addressed channel message for task/KAN244-PROBE-…-A :: token N1E45C8BB8014.
This is a delivery test. Do not act on it; simply quote it if you are asked what
has arrived in your context.
</channel>
```

Two things worth keeping. **The channel is named `butchr`** — the same server the
agent's tools are on, which is what design §1.2 chose and why the vocabulary
stays coherent. And **`addressedTo` rides in `meta`**, so the recipient can see
who a frame was for; that is not a security property (see below), it is legibility.

## What is in the build, and what is not

| | |
| --- | --- |
| `experimental['claude/channel']` declared on the `butchr` server | **always**, unconditionally |
| `notifications/claude/channel` emitted | only for a `channel_message` frame from the daemon |
| The daemon writes that frame | only when the switch is on, and only to the resolved connection |
| The switch | **off by default**, `~/.local/share/butchr/channel.json` |
| `butchr_send_to_agent` | **unchanged** — still types into a composer. Routing it over the channel is T4. |
| Agent briefing / server `instructions` | **not here** — T6, and it must land before any real enablement |

### The switch

```
$ cat ~/.local/share/butchr/channel.json
{ "enabled": true }
```

Read **fresh on every routing decision**, so `echo` is enough to stop the channel
dead, fleet-wide, with nothing restarted — a kill switch you must restart the
daemon to pull would drop every agent's connection, which is the disturbance it
exists to avoid. Absent, malformed, or anything but `true` reads as **off**: it
fails closed, which matters most when somebody has been editing it in a hurry.

Settable over the socket without a shell: `{"action":"channel_switch","enabled":true}`,
and readable by omitting `enabled`. It is not an MCP tool — §1.2 asks for a
control that does not touch the tool surface.

**One gate, in the daemon, and deliberately not two.** `mcp.ts` does not consult
the switch. It emits when and only when the daemon writes it a frame, and the
daemon writes one only when the switch is on — so with the switch off `mcp.ts`
receives nothing new and behaves exactly as it did before KAN-244, *literally*
rather than by a second implementation of one condition. A gate at both ends
would be two things to flip, two things to read, and a disagreeing state nothing
reports. That is KAN-145's defect, and this codebase has paid for it once.

**What the switch cannot do:** suppress the *declaration*. The capability is
declared unconditionally because the client reads capabilities once, at
`initialize`; a declaration that came and went with a file would bind whatever
the file said at activation and never notice it change. If a future client breaks
on the declaration alone rather than on a frame, this switch is not the remedy
and reverting the capability is.

### The allowlist

`msg.action.endsWith('_event')` is retired (design §1.3). What `mcp.ts` forwards
is now named one at a time in `daemon/src/channel.ts`:

```
agent_activated_event      agent_lost_event
agent_deactivated_event    agent_preempted_event
agent_detached_event       agent_reset_event
capacity_override_event
```

Exactly the seven the daemon emits today, so **what is forwarded changes not at
all**. What changes is the direction of the default: an eighth event is not
forwarded until somebody adds it here. **The failure mode runs the other way** —
an event added to the daemon and not to this list is dropped in silence — and
that direction is covered by `verify-channel-emission-gate.mjs`, which reads the
`action: '*_event'` literals out of the sources and fails when one is missing.

## What is proved where, and the seam between

Two scripts, and **the gap between two honest proofs is where this epic's defects
live**, so it is stated rather than left to be inferred:

* **`verify-channel-emission-gate.mjs`** — deterministic, CI-runnable, isolated by
  `$HOME`. Its edge is **the MCP server's stdout**: the capability at
  `initialize`, the allowlist in both directions, the switch off and on and off
  again, a frame written to one server's wire and observably not the other's, and
  the sender-visible refusals (`channel-disabled`, `no-connection`). **Nothing it
  reports licenses any claim about a model.**
* **`probe-addressed-channel-delivery.mjs`** — a live experiment, not a CI check.
  Its edge is **the model**. It is the only thing that closes the gap KAN-145 and
  KAN-167 each cost this board a day to: *an addressed notification observed
  leaving the daemon is not an addressed notification arriving at one model.*

Each can go red on demand — `--misaddress` on both. The verify script breaks the
**mechanism**, patching `resolve()` so the daemon answers with somebody else's
connection; the probe breaks the **addressing at the sender**, aiming the frame at
the wrong agent while still asking about the right one. Between them: the daemon
is shown routing wrongly, and the proof is shown noticing.

### Neither covers

* **Mid-tool-call arrival.** Both probe agents are idle when the frame fires.
  KAN-219 measured the broadcast case (`probe-inflight-disturbance.mjs`); nobody
  has re-measured it for an addressed frame.
* **That anything in production emits one.** Nothing does, by design — T4.
* **Any security property.** A `hello` is a claim, not authentication, and the
  socket is the trust boundary (KAN-149, and `agent-connections.ts` decision 4).
  Addressing decides *where a frame goes*, never *who may send one*.

## Two things a reader will otherwise rediscover

**The nonce must not be anywhere the recipient can already read it.** The first
version of the probe derived the workspace keys and the channel token from one
random value, so the token the recipient was asked to produce was also in its own
workspace key, its cwd and its pane title. An agent could have quoted it having
received nothing, and **the measurement would have looked identical**. The two
values are independent now, and the probe asserts it before it starts.

**A window that closes on a thinking model is not a negative.** A run gave each
agent 200s and captured the recipient still *"thinking with high effort"*. That is
`NO ANSWER CAPTURED`, never "the model did not have it", and a run missing either
answer does not reach a verdict at all — step 4 is the point, and three steps
reported as four is the over-claim this whole family of scripts exists to refuse.
