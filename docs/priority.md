# Agent priority and preemption

**Ticket:** KAN-37. **Depends on:** KAN-21 (durable registry, boot-time
reconciliation, resume framing) and KAN-36 (the capacity model and the visible
refusal). Neither dependency is incidental — see *Why this could not be built
first*.

## The problem

At capacity, every activation was refused identically. A board manager that
needed to start a story could not, and neither could anything else, however
important. The machine said no and left the person asking to work out for
themselves what to stand down — with no view of what was running, what it was
worth, or what it was doing.

## The scale

Priority is a property of the **workspace type**, registered in `registry.ts`
alongside `mcpServers` and `promptTemplateFile`:

| type | priority | what it is |
| --- | --- | --- |
| `manage` | **3** | the board manager: supervises the fleet and hands work out |
| `story` | **2** | decomposes a story into the tasks that task agents execute |
| `task` | **1** | does the work |
| anything unregistered | **1** | the floor, so it can preempt nothing |

The ordering is coherent on its own terms rather than a ranking of urgency: a
story agent is *upstream* of the tasks it produces, so taking a task's slot to
run a story unblocks the thing that generates more work, and the manager
supervises both.

### Why the type and not the Jira ticket

The ticket originally proposed reading Jira's own
Highest/High/Medium/Low/Lowest field. That was superseded, and the replacement
is better for three reasons:

- **No lookup.** The type is resolved before activation, so priority is already
  in hand. Reading Jira would put a network call on the activation path for a
  question already answered.
- **Both callers work identically.** The sidepanel toggle cannot supply a Jira
  priority and the board manager can. A property of the type is available to
  both by the same route, so there is no path that degrades.
- **Manager safety stops being a rule.** `manage` is the top of the scale, so
  "never preempt the board manager" is what the ordering already says rather
  than an exception a future change could forget.

## The rules

### Strictly greater, not greater-or-equal

Equal priority never preempts. The general argument is churn — two agents at
the same level displacing each other indefinitely — but on a three-level scale
it is sharper than that. *Equal* is the normal case here: two `task` agents at
priority 1 is what a full machine looks like on the hardware this was built on.
Greater-or-equal would therefore mean any task agent may kill any other task
agent, making the choice of victim arbitrary and every activation a coin toss
over somebody's uncommitted work.

Strictly-greater makes task-versus-task always a refusal, which is the honest
answer: the machine is full of work exactly as important as yours.

### Which agent is taken

Lowest priority first. Among equals, whatever has least in flight:

```
done  →  idle  →  blocked  →  unknown  →  working
```

The ticket guessed "least recently active", reasoning that an agent mid-compile
has more to lose than one idling. There is no last-active timestamp anywhere in
the daemon — but herdr already reports what each agent is *doing*, which is
what that proxy was reaching for, measured rather than inferred. Remaining ties
break on oldest activation, then on name, purely so the same fleet always
yields the same victim: a refusal that names one agent and a preemption that
kills another would be the same request.

An agent the registry has no record of sorts **last** among its equals. Knowing
least about something is a reason to be more careful with it, not less.

### Preemption is opt-in, per activation

A refusal at capacity now carries:

- what is running and what each one is worth (`priorities`, and the same in
  prose on the refusal itself);
- when the activation outranks one of them, a `preemption` block naming the
  agent that would be stopped, its priority, and its current status.

That is all it does. `preempt: true` is what authorises the kill — separate
from `override: true`, because they are different asks: override over-commits
the machine and nobody else pays; preempt ends another agent's turn mid-work.

The sidepanel renders the offer as a red button that reads **Stand down
task/KAN-99 and start**. The name is in the label deliberately: a generic
"Preempt" would be a control whose consequence the user has to reconstruct from
the paragraph above it.

### Once a slot is freed, the activation proceeds

The gate does not re-run after the stand-down. Only the count term responds to
a stand-down immediately — the load average is a one-minute mean and the kernel
has not yet reclaimed the memory — so re-measuring here would sometimes refuse
*after* destroying an agent's work, which is the worst of both outcomes.

If the stand-down itself fails (an unreachable herdr, say), the activation is
refused and says so. Nothing was freed, so nothing may start.

## What is recorded, and why a reboot does not undo it

This was the sharpest question on the ticket, and it did not exist before
KAN-21: preemption is the first case where an agent is stopped *against its
ticket's wishes* rather than because the work finished.

**It is recorded as `deactivated`.** Reconciliation restores the whole expected
fleet at once and does so with `override: true` — deliberately, because a
boot-time load average is high *because the machine is booting*. An agent left
recorded as expected would therefore come back alongside the agent that took
its slot, past a gate that has been told not to argue, on a machine that has
just demonstrated it cannot hold both. **A restart must not overturn a decision
a person made.**

Keeping the event type unchanged also means `intents()` needs no new rule and
there is nothing for a future reader to get wrong.

**But `deactivated` alone throws away the why**, and the why is the whole
difference between a human switching an agent off and work being taken from an
agent in the middle of it. So the same record carries a `preemption`
annotation: who took the slot, both priorities, what the victim was doing, and
the capacity arithmetic that forced it.

The annotation does not survive log compaction, which rewrites the file as one
`activated` record per expected agent. That is deliberate: this is a live
signal about work waiting to be re-staffed, and compaction happens only after
500 records, by which time a preemption nobody acted on is not news.

## Coming back

Re-activating a preempted agent is a **resume**, worked out by the daemon from
the registry rather than trusted to the caller — nobody rebooted anything, a
person just flipped a switch back on, and no client has any reason to say
"resume" in that situation.

It therefore gets both halves of KAN-21's resumption:

- `claude --continue` restores its conversation, and
- it is told, in words, that it was **deliberately stood down** rather than
  crashed — "this was a decision, not a crash: nothing was wrong with what you
  were doing, and you are being brought back to finish it" — and to establish
  what already exists before continuing.

Without the second half this would be KAN-21's idle-forever failure reached by
a new route: Claude Code resumes at an empty prompt and waits, so a restored
agent nobody speaks to is indistinguishable from a finished one. The nudge is
fire-and-forget from the activate handler (it waits up to two minutes for the
agent's prompt to appear, which no client would sit through) and shares its
implementation with reconciliation in `nudge.ts`, so the two cannot drift.

## The preempted ticket

**It goes back to `To Do`, and the daemon does not move it.** Jira access here
is read-only and stays that way.

What the daemon does instead is make the fact impossible to miss to the one
party that *does* hold the Jira write:

- `butchr_list_agents` reports `preemptedAgents` on every poll — a queue of
  decisions still owed, not a log of events, so an agent that is put back
  leaves the list on its own;
- the tool flags `isError` for a non-empty list, exactly as it does for a
  missing agent;
- the Agents page shows an amber banner (distinct from the red missing-agent
  one: a missing agent is a loss to diagnose, a preempted one is a consequence
  to act on);
- `prompts/manage.md` instructs the board manager to transition each back to
  **To Do** and comment naming what took its slot — the ticket being the
  agent's memory, and this being something that happened to it while it could
  not write anything down.

Left In Progress with nothing behind it, a preempted ticket tells exactly the
lie KAN-21 exists to end.

## Out of scope

- **Automatic restart of preempted work.** A preemption queue is a scheduler
  and a much larger idea. The machine that was full an hour ago is not obliged
  to be free now.
- **Changing the capacity arithmetic.** KAN-36 settled it; nothing here touches
  it.
- **Priorities for anything other than activation.**
- **Making the daemon write to Jira.**

## Why this could not be built first

Preemption without resumption is destruction. Standing an agent down mid-work
throws away whatever it had not committed, and before KAN-21 nothing anywhere
recorded that the agent had existed, let alone what it had been doing. Three
agents were found idle with real uncommitted work on the day KAN-37 was filed,
and all three recovered only because a human nudged them by hand.

KAN-21 is what makes the stand-down survivable: the append-only registry, the
finding that Claude Code transcripts survive `SIGKILL` so `--continue` genuinely
restores prior turns, the suppressed resume modal, and the nudge that keeps a
restored agent from idling. KAN-37 is that machinery pointed at a case KAN-21
did not have — an agent stopped on purpose.

## Proof

```
node daemon/scripts/verify-agent-preemption.mjs
```

Nine sections, one per acceptance criterion plus the two design questions:
the scale, the ordering, the refusal, the consent, the preemption with capacity
before and after, manager safety, survival, ticket status, and the registry.
Sections 3 onward drive the real `MessageRouter`, the real `WorkspaceRegistry`
and a real on-disk `AgentRegistry`, so what they print is what a caller
receives and what is actually written to the log.
