# The scheduled channel liveness probe

**KAN-252**, filed by [KAN-248](https://wroosbit.atlassian.net/browse/KAN-248)
against itself. Companions:
[`channel-selfcheck.md`](channel-selfcheck.md), whose *"who covers it: nobody on
a schedule"* is the sentence this page makes false;
[`channel-messaging-design.md`](channel-messaging-design.md) §6.1, which ranks
the failure being watched for; [`channel-delivery.md`](channel-delivery.md)
(KAN-217) and [`channel-briefing.md`](channel-briefing.md) (KAN-249), which
between them measured both that a model *can* be reached over the channel and
that it may correctly refuse.

## The gap this closes, stated as narrowly as it deserves

The channel loop has five legs. KAN-248's startup self-check proves four:

| Leg | Proved at bring-up? | Proved here? |
| --- | --- | --- |
| 1 — daemon → the agent's connection | yes | — |
| 2 — that frame handled by the agent's own `mcp.js` | yes | — |
| 3 — `mcp.js` emits the notification, and the client **reads** it | yes | — |
| **4 — the client's channel dispatcher accepts it** | **no** | **yes, when a token comes back** |
| **5 — the model reads it** | **no** | **yes, when a token comes back** |

**Leg 4 is unobservable from the server**, measured rather than assumed: the
client's `initialize` request is byte-identical with and without
`--dangerously-load-development-channels`, and Claude Code can decline a channel
for six separately-named reasons while telling the server none of them. A renamed
notification method would be dropped in exactly the same silence. That is §6.1's
*"events leave and arrive nowhere → bad, and **silent**"*.

**The only instrument that reaches legs 4 and 5 is a model echo.** Put something
into an agent's context over the channel and get it back out. KAN-217 (client
`2.1.224`) and KAN-248's own probe (client `2.1.226`) both did, and both got their
token back, so the instrument works.

## Why it is a schedule and not a startup check

KAN-248 rejected a model echo as a *bring-up* check on three counts. All three
still hold and none is stylistic:

* it costs a model turn per run;
* **a model may decline on the merits and be right to** — KAN-217 measured a
  correct refusal, and from outside a refusal is indistinguishable from a broken
  transport;
* at bring-up the agent has not yet read its own brief.

So this runs **occasionally, on a schedule, against one agent at a time**, long
after bring-up. Bolting the echo onto the startup check stays rejected: it would
put a false negative — a model correctly declining — into the decision that gives
an agent a channel at all.

## What a run claims, and what it refuses to claim

**An echo proves legs 4 and 5**, on a named client version, at a stamped time.
Nothing else in this fleet produces that fact.

**A single non-answer is evidence of nothing**, and is recorded as `no-answer`
rather than as a failure. A model that reads the probe and declines is behaving as
[`channel-briefing.md`](channel-briefing.md) asks it to.

**A drought — three delivered runs with no echo — is a thing to go and look at,
and is not a verdict.** It cannot distinguish a broken dispatcher from three
models that all declined. What it does is *stop being green*: a leg-4 break leaves
the startup check passing on every agent forever, and leaves this record with a
`lastProof` that ages and a counter that climbs. **An unobservable break becomes an
observable absence of evidence.** That is the entire improvement, and this page
claims no more of it.

## The false positive it is built around

The echo is read off the agent's pane, which is the only place a model's output is
visible to the daemon. That instrument has two ways to lie, and both lie in the
direction of **looking finished**:

**1. The probe's own carrier could write the token.** A send that fell back to the
composer would *type* the token into the pane the probe then reads, and the run
would report leg 5 proved having proved only that the daemon can type. So the probe
routes through `routeChannelMessage` and **never falls back** — a refusal is the
reported outcome `not-routed`. `ChannelLivenessWorld` has no composer in it at
all, which makes that structural rather than a rule somebody has to keep.

**2. The client might render the frame onto the terminal.** If it does, every word
of the probe message is on the pane with no model having read anything. So **the
token the probe looks for is never in the message**: it carries two halves, named
separately and never adjacently, and what is searched for is the two halves
*joined*. `composeProbeMessage` asserts against its own composed text — with all
whitespace removed, the same transformation the pane search applies — and refuses
to send if the assembled token is in it.

`verify-channel-liveness.mjs --blind` puts the assembled token into the message and
removes that guard; the run then reports `echoed` for an agent that printed
nothing, and the proof goes red on it. That is the failure worth having watched.

## Where a reader meets it

`butchr_list_agents` carries `channelLiveness` beside the per-agent `channel`
rows. Those rows say whether each agent's loop was proved as far as its *client*;
this says whether anything got past the client into a *model*, which is the leg
none of them can see. Omitted entirely — never `null` — when no probe is wired,
by the same rule as `boardControl`.

```
channelLiveness: {
  lastProof:  { address, clientName, clientVersion, clientVersionVerified, startedAt, … },
  lastRun:    { outcome, detail, … },
  nonAnswersSinceProof, unrunSinceProof, drought, runs, recent[], intervalMs,
  detail: "one sentence for a reader who reads nothing else"
}
```

The daemon action `channel_liveness` reads the same record, and with `run: true`
fires the shipped probe now rather than at its interval — the same code path the
timer takes, which is the only reason it is allowed to exist. It **answers
immediately and does not wait for the run**: a reply held open for ten minutes is
one every client's own timeout abandons. Poll it without `run` and watch `runs`
change.

## The brief, and the part of this that is prose

The probe asks for something an agent's brief otherwise tells it not to give:
`[butchr daemon]` messages are notifications and *"no reply is expected"*. So
KAN-252 added a paragraph to all four `prompts/*.md`, in the *Whose voice is this?*
section, naming the probe, saying what it asks for, and saying that **declining is
recorded as a non-answer and not as a fault**.

That last half is as operative as the first two. Without it the brief manufactures
an obligation, and `channel-briefing.md` establishes what that costs: KAN-217's
model quoted the pre-authorising sentence in its instructions as the red flag that
decided it to refuse. The paragraph is out of band **because** a message that
vouches for itself is what an agent should not trust — the brief is what makes the
probe expected, and the probe never argues for itself.

Rule **H-15** in `verify-operative-rules-are-carried.mjs` keeps all three halves in
all four prompts, and that is a required check. **It is deliberately not in the
`instructions` string on the MCP server**, unlike H-12's channel brief: every token
there is paid on every request of every agent forever, this probe runs a handful of
times a day, and a drifted session that declines is reported as a non-answer —
which is the designed-for outcome rather than a wrong one. H-12's *"if you change
one, read the other"* does not extend here.

## What nothing covers

* **Whether an agent that has read the brief answers.** A question about a model.
  `probe-channel-liveness.mjs` measures it live; H-15 can only prove the four files
  say it. A green H-15 is never evidence that agents answer.
* **Telling a broken dispatcher from a fleet of models that declined.** Nothing
  outside the client can, and no future version of this mechanism will.
* **A daemon that restarts more often than the interval.** The record is held in
  memory, deliberately — a persisted `lastProof` would outlive the client it
  described and read as current — so such a daemon never accumulates a drought.
  That is why the first run is minutes rather than one interval after start-up,
  and it is a real limit rather than a mitigated one.

## What it costs

| | |
|---|---|
| Per interval | one agent, one model turn, a few dozen tokens of its context |
| Interval | 6 hours; first run 15 minutes after the daemon starts |
| A run that is answered | as long as the model takes |
| A run that is not | the whole answer window — 10 minutes — by construction |
| Interruption | **none**: a channel event waits for the recipient's turn boundary (KAN-219) |
| Agents other than the one asked | nothing at all |

The agent asked is the **least recently asked** one, so the cost rotates rather
than landing on the same agent repeatedly. Round-robin rather than random for that
reason, and deterministic so a proof can assert the choice instead of tolerating
it.

> **Run-by-run output: see the KAN-252 pull request.** Numbers are deliberately not
> pasted here. This is a live experiment against a research-preview client, so a
> result is a fact with a date and a version attached, and a page that carries one
> invites it to be cited a month later as though it were a contract. Re-run the
> probe; do not cite this page for a number.

## Where the code is

| | |
|---|---|
| The decision procedure, the record and the schedule | `daemon/src/channel-liveness.ts` |
| The wiring — candidates, the pane reader, the channel-only send | `daemon/src/daemon.ts` |
| The action that reads the record and forces a run | `daemon/src/daemon.ts`, `channel_liveness` |
| The row a supervisor reads | `daemon/src/router.ts`, `list_agents_response.channelLiveness` |
| The brief that makes the probe expected | `prompts/{task,story,epic,confluence}.md` |
| The rule that keeps the brief | `daemon/scripts/verify-operative-rules-are-carried.mjs`, H-15 |
| Deterministic proof, every outcome, with `--blind` | `daemon/scripts/verify-channel-liveness.mjs` |
| Live proof against a real model | `daemon/scripts/probe-channel-liveness.mjs` |
