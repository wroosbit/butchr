# Proving one agent's channel at bring-up — and what that proof does not cover

**KAN-248 (T5 of KAN-150).** What the startup self-check does, what it licenses
you to say, the one leg it cannot reach and what stands in for it.

Scoped to **Claude Code 2.1.226**, measured 2026-08-10. §6.1 of
[the design](channel-messaging-design.md) says the contract may move; the
[version pin](#the-version-pin) is what notices when the evidence for it lapses.

---

## The short version

| | |
|---|---|
| **When it runs** | After [T3's](channel-launch.md) startup watcher reports `ready`, on every channel-enabled activation. Never on an activation with channels off — there is nothing to check. |
| **What it does** | The daemon writes a probe frame to the agent's connection; the agent's own `mcp.js` emits a real `notifications/claude/channel` to its client, sends an MCP `ping` behind it, and reports back what happened and **what version the client says it is**. |
| **What a failure does** | Degrades that one agent to the composer, visibly. It never fails an activation. |
| **Where you see it** | The `channel` field on that agent's `butchr_list_agents` row, and `[ChannelSelfCheck]` in the daemon log. |
| **What it costs** | 256 ms on the measured run, off the activation's critical path entirely. |

---

## The five legs, and where the proof stops

| Leg | Established? |
|---|---|
| 1 — daemon → the agent's connection in [KAN-243's](channel-messaging-design.md) identity map | **yes** |
| 2 — that frame handled by the agent's own `mcp.js` | **yes** |
| 3 — `mcp.js` emits `notifications/claude/channel`, and the client **reads** it | **yes** |
| 4 — the client's channel dispatcher **accepts** it | **no** |
| 5 — the model reads it | **no** |

T3 establishes that a socket exists. This establishes that a message crosses it.
Those are different claims and this story has paid twice for treating them as
one — T3's own header hands the gap here in terms.

### Leg 3 is the interesting one, and ordering is why it is provable

An MCP notification is unacknowledgeable by construction. The client returns
nothing, and `await mcp.notification()` resolves when the bytes reach the
transport rather than when anything reads them — the reference says so and
KAN-217 measured it. On its own that licenses exactly one claim, *we wrote to a
pipe*, which is worth very little.

**stdio is an ordered byte stream.** So the check emits the real channel frame
and then, on the same stream, sends an ordinary MCP `ping` — a request the
client must answer. A ping response can only be produced by a client that has
consumed everything ahead of it, **including the notification**. That upgrades
*we wrote it* to *the client read it*, without asking the model for anything and
without costing a turn.

`ping` is base-protocol and needs no declared capability, so this does not
depend on anything the preview may move.

### Leg 4 is unobservable, and that is measured rather than assumed

**A client that reads the frame and silently declines the channel looks
identical to one that delivered it.** Claude Code 2.1.226 can decline for six
separately-named reasons — `policy`, `era`, `provider`, `disabled`,
`capability`, `session` — and tells the server none of them.

The evidence, off a teed wire on a real channel-enabled agent:

```
clientInfo   : {"name":"claude-code","title":"Claude Code","version":"2.1.226", …}
capabilities : {"roots":{"listChanged":true},"elicitation":{}}
```

That is the client's `initialize` request **with
`--dangerously-load-development-channels server:butchr` on its command line**.
It is byte-identical to the same handshake without the flag. Nothing on the wire
distinguishes a client that took the channel from one that did not, so nothing
the server can look at will ever detect leg 4 breaking.

**So the ticket's framing — "the only thing that catches the silent contract
move" — is more than this mechanism can carry, and it does not claim it.**

---

## The version pin

§6.1 asks for three mechanisms and this is the third: *"pin the observation to a
version, so 'it worked on 2.1.226' is a fact with a date rather than an
assumption with a habit."*

The client reports its own version in `initialize`. The check records it beside
the result, **per agent**, and compares it against `VERIFIED_CLIENT_VERSIONS` —
the set of versions on which a channel event was measured reaching *the model*:

| Version | Measured by |
|---|---|
| `2.1.224` | KAN-217, configuration D — a nonce that existed only inside a daemon broadcast came back out through the channel's reply tool ([docs](channel-delivery.md)) |
| `2.1.226` | KAN-219, re-confirmed while measuring in-flight disturbance on the same path ([docs](channel-inflight-disturbance.md)) |

An agent on a version nobody has measured is reported `unverified-client`. **It
still uses the channel** — the loop was proved on that very client, seconds ago,
and dropping the fleet to the composer on a patch release would be the daemon
inventing a policy nobody asked for. It is flagged, prominently, on its row.

That does not detect the break. **It detects the condition under which the
evidence lapsed**, which is the only thing detectable from here.

**Adding a version to that list is a claim that somebody measured it.** Add one
with a probe run and a document to point at, not because the fleet upgraded.

---

## The outcomes

| Outcome | Transport | What it means |
|---|---|---|
| `passed` | channel | The loop crossed and the client read it, on a measured version. |
| `unverified-client` | channel | The loop crossed and the client read it, on a version nobody has measured — or on a client that reported no version at all. |
| `no-answer` | **composer** | The frame was written and the agent's `mcp.js` never answered. |
| `emit-failed` | **composer** | `mcp.js` could not emit the notification to its client. |
| `client-unresponsive` | **composer** | The notification went out and the client did not answer the ping behind it. |
| `not-ready` | **composer** | T3's watcher never reached `ready`, so there was no loop to test. |
| `channel-disabled` | **composer** | Emission was switched off before the check ran. |
| `no-connection` | **composer** | Nothing to write the probe frame to. |
| *(absent)* | channel | **`unchecked`** — nobody has checked. Not a fault. See below. |

Every outcome that learned a client version carries it, **including the
failures**: a `no-answer` on an unmeasured client is a different investigation
from the same failure on a measured one.

### Unchecked is not failed

An agent with no verdict routes over the channel. The ordinary way to be
unchecked is to have outlived the daemon that would have checked you — and
treating that as a failure would take the whole fleet off channels on every
daemon restart, which is a larger and quieter behaviour change than the one
being guarded.

Two rules keep `unchecked` meaning *"the connection you would write to has not
been checked"* rather than *"something was checked once"*:

* a verdict is **dropped when the connection it was measured on closes**, matched
  by connection id so a reconnect cannot delete its own new verdict;
* a verdict is **forgotten at the top of a re-spawn**, because a verdict that
  never held a connection (`not-ready`, `no-connection`) is released by nothing.
  Without that, a re-activated agent carried its previous run's verdict — with
  its previous run's timestamp — until the new check finished. The live probe
  found this by believing one.

### The fallback is a behaviour, not a label

A failed check is enforced in `routeChannelMessage`, the one function that
chooses a carrier, between the kill switch and the identity map. A degraded
agent's sends answer `selfcheck-failed` and land on the composer, and the sender
is told:

```
transport              : composer
transportChosenBecause : task/KAN-9249374 failed its startup channel self-check and is
                         degraded to the composer; butchr_list_agents carries the
                         outcome and the client version on that agent's row
```

The kill switch still answers first: a shut gate must not leak which agents are
degraded any more than which are connected.

---

## What it costs

| | |
|---|---|
| The check, end to end | **256 ms** (measured, 2026-08-10) |
| Added to activation latency | **nothing** |
| Per activation | one socket round trip, one MCP ping, ~40 tokens of the agent's context for the frame |
| On a **failing** agent | the 20 s the daemon waits for an answer that is not coming |

"Nothing" is structural rather than a measurement: the check is chained onto
T3's watcher, which the daemon fires with `void` from a spawn listener. Nobody
awaits it. `activate_by_key` returned in 679 ms on the same run and had been
back for twelve seconds before T3 said `ready`.

During the window between readiness and the verdict the agent has no record and
therefore routes — one socket round trip wide.

---

## The alternative that would cover leg 4, and why it is not this

Ask the model to echo a nonce back. KAN-217's configuration D and this ticket's
own probe both did, and both got a real answer, so the instrument works. It is
rejected as a **startup** check on three counts:

* it costs a model turn per activation;
* a model may decline on the merits and be right to — KAN-217 measured a correct
  refusal, and from outside a refusal is indistinguishable from a broken
  transport;
* at bring-up the agent has not yet read its own brief.

**Who covers it: nobody on a schedule.** That is filed as
[KAN-252](https://wroosbit.atlassian.net/browse/KAN-252) rather than left for a
reader to infer a coverage that does not exist.

---

## Where the code is

| | |
|---|---|
| The decision procedure and the store | `daemon/src/channel-selfcheck.ts` |
| The agent's own leg — the emit, the ping, the client version | `daemon/src/mcp.ts`, `answerSelfCheck` |
| The gate that enforces the fallback | `daemon/src/channel.ts`, `routeChannelMessage` |
| The row a supervisor reads | `daemon/src/router.ts`, `channelStateOf` |
| Deterministic proof, every outcome, with `--blind` | `daemon/scripts/verify-channel-selfcheck.mjs` |
| Live proof on a real agent | `daemon/scripts/probe-channel-selfcheck.mjs` |
