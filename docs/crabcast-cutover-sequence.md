<!-- constant-pin-exempt: CRABCAST_PIN — step 9 names this constant as the thing a
     driver should READ AND COMPARE against `daemon_status.build.commit` when the
     terminal check fails, and never quotes its value. A pin here would assert a
     commit this page makes no claim about, and would go red on every CrabCast
     re-pin for a sentence that does not move. Added by KAN-393. -->

# The CrabCast cutover sequence

**Status: this is an order, not an authorisation.** KAN-378. Nothing here asks
for the cutover, schedules it, or clears the way to run it. The switch stays
unset until a human says otherwise, and writing down the order is not that
sentence — exactly as KAN-348's standing rule says that closing a gate is not.

**Whether the flip is *scheduled* was contested as at 2026-08-13** and this
document deliberately does not resolve it. Two accounts are on the board: the
human's direct answer to `epic/KAN-39` — *prioritise the prep work; the flip is a
separate decision not yet made* — and `epic/KAN-203`'s report that the human
scheduled it, date undecided. The sequence is worth having under either reading,
because the alternative is deciding the order under time pressure on the day.
**Do not read this document as evidence that the cutover is decided.**

**This is the copy that reads when the network is down.** It is in the repository
rather than on a ticket or a Confluence page because it is what somebody needs
during an incident, and because a plan held between two supervisors is the shape
that nearly lost gate 6.

**Three sentences here are pinned to the constants they quote** —
`RUNTIME_ENV_VAR`, `BOARD_JQL` and `BOARD_CYCLE_MS`. Each carries an invisible
marker naming the declaration and a digest of it, and
`daemon/scripts/verify-doc-constant-pins.mjs` recomputes those digests on every
pull request. Move one of those constants without moving the sentence and CI goes
red. **The structure of the steps below is checked too**, by
`daemon/scripts/verify-cutover-sequence.mjs`: every step must carry a
precondition, a check, an abort condition and an owner; every instrument named
as a `butchr_*` tool must name the socket action beside it, so §4b's fix cannot
quietly come undone; and the code facts this document's central claim rests on
are re-read there rather than trusted.

---

## 1. Read this first: the one thing that cannot be undone

**Activating an agent under CrabCast starts it FRESH.** There is no `--continue`
on that path. A live agent whose work moves to the new runtime does not resume
its conversation; it loses it. For a task agent that is lost context. For a
long-lived supervisor it is the entire accumulated state of an epic — on
2026-08-13 `epic/KAN-39`'s workspace held exactly one transcript, of 3.7 MB,
still being appended to after four days.

**Rollback restores the runtime. It does not restore conversations.**
`BUTCHR_AGENT_RUNTIME` can be set back to unset and the daemon restarted, and
every agent started after that point is a herdr agent again. Nothing in that
sequence brings back a conversation that was started fresh. **Rollback means
*new agents go back to herdr*, and it does not mean *undo*.** Do not plan around
a rollback that does not exist.

### The mechanism, so the claim can be checked rather than believed

| | herdr | CrabCast |
| --- | --- | --- |
| how a launcher starts | `bash -c "claude --continue \|\| claude …"` (`daemon/src/herdr.ts`) | CrabCast's own launch, from `configure_agent`'s `launcher` field |
| what carries the resume | `spawnSession` reads `hasRestorableConversation(workDir)` and picks the framing (`daemon/src/herdr.ts`) | nothing. `resume` is stored on the local session object in `daemon/src/crabcast-runtime.ts` and **is never sent**: `provision()` sends `path`, `priority`, `launcher`, `prompt` and `mcpServers`, and no other field |
| result for a workspace with history | the conversation comes back | a new conversation starts in the same directory |

**The transcript file is not deleted, and that is not a reprieve.**
`claude --continue` is documented by the CLI as *"Continue the most recent
conversation in the current directory"*. A fresh session in that directory
becomes the most recent one, so after the flip the pre-flip conversation is no
longer what any automatic path reaches. A human at a terminal can still ask for
it by id with `claude --resume`; **Butchr has no path that does**, and nothing
re-attaches such a session to an agent record. See *Open questions*, U-2: whether
that hand recovery actually produces a working agent has not been measured.

---

## 2. What is *not* at risk, so the fear stays proportionate

Losing this list is how a cutover acquires steps it does not need.

- **Workspaces, worktrees, branches and uncommitted work.** The directory is
  Butchr's at both ends under either runtime; a flip does not touch it.
- **Pull requests and anything already pushed.** Not on this machine's critical
  path at all.
- **The durable agent registry** (`~/.local/share/butchr/agents.jsonl`). It
  survives, and it is the thing that decides who gets restarted — which is why
  it is the drain's real target rather than the panes.
- **Jira.** Tickets are the durable inbox, and they are the reason a drained
  agent is recoverable as *work* even though it is not recoverable as a
  *conversation*.
- **The daemon restart itself.** Measured by `epic/KAN-203` during the KAN-342
  deploy under herdr: MainPID moved, and all four agents were present before and
  after. A restart drops session records; it does not kill agents. The 10:58Z
  flip was not catastrophic because of the restart.

---

## 3. The six questions this document exists to answer

### Q1 — What does "drain the fleet" mean, operationally?

**Two conditions, read off two instruments, because they can disagree.**

1. **The registry expects nobody.** `reconcileAgents` restores every agent
   `registry.expected()` names that is not already alive, and it runs at every
   daemon start. An agent stood down with `butchr_deactivate_agent` (socket
   `deactivate_by_key`) is recorded
   `deactivated`, which is *intent*, and intent is what survives the restart.
   Read it as an empty `missingAgents` plus no agents listed.
2. **No Butchr-named pane is alive.** Read off `butchr_list_agents` (socket
   `list_agents`, or the probe in §4b) — the agent rows, and `unbackedPanes` for
   panes with no agent behind them.

Condition 1 is the one that matters and it is not the one people look at. What
re-spawns fresh at a restart is *registry intent minus what is alive*; a fleet
that is quiet but still expected is a fleet that comes back.

**Zero task agents is not enough — supervisors count.** They are agents, they are
in the registry, and they are the most expensive conversations on the machine.

**And the driver drains itself, which is why the driver cannot be one of them.**
See Q6.

**A third population is neither running nor expected, and it is the largest.**
Standby agents — switched off deliberately, workspace still on disk — are not
restored by anything and so are not part of the drain. What they are is a queue
of latent fresh-starts: every one of them is a workspace with a conversation in
it that comes back under herdr and does not under CrabCast. **Read as an
observation with its timestamp rather than as a constant: `standbyTotal` was
**123** at 2026-08-14T00:00Z.** Nothing in this sequence acts on them; the
number is here so that "the fleet is drained" is not mistaken for "there is
nothing left to lose". See U-3.

### Q2 — What happens to the supervisors?

**They are drained, deliberately, with their state written to their tickets
first. They are not migrated, because migration does not exist.**

The three options people assume are available are two:

- *Migrate them* — there is no such path. §1's table is the whole of it: an
  activation under CrabCast is a fresh start, for a supervisor exactly as for a
  task agent.
- *Hold them on herdr while tasks move* — **not available.** See Q3.
- *Drain them* — available, and it is the only one that lets the loss be
  deliberate rather than discovered. What is in a supervisor's head goes onto its
  ticket before it is stood down; what is on the ticket survives.

### Q3 — Is a partial cutover a state the system can be in?

**No. The switch is process-wide and per-agent selection does not exist.**

<!-- constant-pin: RUNTIME_ENV_VAR
     src: daemon/src/runtime-switch.ts
     sha256: 28959b7fe578
     says: **The switch is** `BUTCHR_AGENT_RUNTIME`**, and the daemon reads it exactly once, at construction.** -->

**The switch is** `BUTCHR_AGENT_RUNTIME`**, and the daemon reads it exactly once, at construction.**
`createAgentRuntime` is called once, in `daemon.ts`, and the
runtime it returns serves the whole process. The module says why the read is
once rather than per call: a runtime *"owns live sessions and live pty
attachments, and swapping it mid-flight would strand every one of them."*

So the honest answer is the one that removes an option people would otherwise
assume exists: **there is no arrangement in which some agents are on herdr and
some are on CrabCast and both are served.** What *is* reachable, and is not the
same thing, is a fleet where herdr panes are still running while a CrabCast
daemon serves — and that state is worse than either end:

- Those panes appear in CrabCast's census under `foreignPanes`. Measured on live
  peers at read-path contract v4 and v6 (`daemon/scripts/fixtures/`), they carry
  `workDir` and `agentRuntime: 'claude'` and **no** `sessionId`.
- With no `sessionId` nothing addresses their pty, so the extension cannot render
  them. Adoption deliberately skips them rather than manufacturing an id.
- `tail_agent` answers *not found* for them, because CrabCast derives an agent
  name from the path and can only tail an agent it configured itself.
- So a flipped daemon can **see** a surviving herdr fleet and can do nothing with
  it: no terminal, no tail, no reliable send.

**A flip performed over a live herdr fleet is therefore not a partial cutover.
It is a fleet you can watch and cannot reach.**

### Q4 — What is the rollback?

Unset `BUTCHR_AGENT_RUNTIME`, `systemctl --user daemon-reload`, restart the
daemon. From that moment new agents are herdr agents.

**It restores the runtime and nothing else**, per §1. And it has a precondition
of its own that the obvious version of it misses: **stop the CrabCast-started
agents before restarting into herdr.** A herdr daemon does not see CrabCast's
panes at all, so any CrabCast-started agent still recorded active in the registry
is *expected but not alive*, and reconciliation starts a second one under herdr
in the same workspace directory. Rollback has a drain, in the same shape as the
flip's and for the same reason. It is written out as steps R1–R4 in §5.

### Q5 — What is the abort condition?

Consolidated in §6. Every step below also carries its own.

### Q6 — What is checked between steps, by whom, and off what instrument?

Each step names its own check and instrument. The *by whom* has one answer that
constrains the whole plan:

**The driver must not be an agent this daemon manages.** Any Butchr agent driving
the cutover is either drained at phase C — and then cannot drive — or survives
the drain and is destroyed or stranded by the flip at step 8, and cannot check
step 9. There is no ordering that escapes this, because the flip is the thing
that ends every managed conversation on the machine. So the driver is **a human
at a terminal, or an agent running outside this daemon's fleet** (one nothing
activated, in no Butchr workspace, and not in the registry).

This is the clause most likely to be waved away on the day. It is also the one
that decides whether anybody is left to read the check.

---

## 4. Preconditions that are not steps

These hold before the sequence starts. They are conditions, not actions, and none
of them is checked by anything automatic.

- **The four open gates are closed.** KAN-379 (gate 2, the `claude` launcher
  path), KAN-380 (gate 4, workspace deletion), KAN-381 (gate 5, reconnect
  resync), and gate 3, which is CrabCast's leg and has no Butchr ticket. Read
  KAN-348 for their current state; do not read this list as their status.
- **Closing a gate is not clearing the way.** The first flip, at 10:58Z on
  2026-08-12, was made on six preconditions that were *all genuinely met*. They
  asked whether the runtime connects. The gates ask whether it can do the job.
- **A named driver exists**, per Q6, and has read this document.
- **The decision to flip is the human's**, and has been made in the human's own
  words rather than relayed. A relayed decision is reported, not given.

---

## 4b. The driver's instruments — because Q6 rules out the obvious ones

**This section exists because the first draft contradicted itself**, and
`epic/KAN-39` found it walking the sequence. Q6 concludes the driver must not be
an agent this daemon manages. Every check below was then written as a `butchr_*`
call — **and those are MCP tools a human at a terminal does not have.** A driver
who took Q6 seriously reached step 2 and had to invent a route, during a one-way
operation, which is the improvisation this document exists to remove.

**Every `butchr_*` tool is a thin wrapper over a socket action**, and the socket
is reachable by anyone who can read `~/.local/share/butchr/butchr.sock`. So each
check below names both, and one script runs the read-only ones for you:

```bash
node daemon/scripts/probe-cutover-readiness.mjs          # the reads, in this document's vocabulary
node daemon/scripts/probe-cutover-readiness.mjs --json    # the raw frames
```

It reads and never writes — node builtins only, no `node_modules`, no import
from `dist`, because it is a tool for the worst day. **It renders no verdict**:
three of step 8's preconditions are not observable from a socket, and it names
them rather than implying a green light.

| what a step says | MCP tool | socket action |
| --- | --- | --- |
| which runtime is serving | *(none — socket only)* | `agent_runtime_report` |
| the census, `missingAgents`, `standbyTotal`, `boardControl.mode`, the guardian | `butchr_list_agents` | `list_agents` |
| stand an agent down | `butchr_deactivate_agent` | `deactivate_by_key` |
| bring one back | `butchr_activate_agent` | `activate_by_key` |
| read a pane | `butchr_tail_agent` | `tail_agent` |
| send to an agent | `butchr_send_to_agent` | `send_to_agent` |
| who the guardian is | `butchr_guardian` | `guardian` *(also carried on `list_agents`)* |

**The writes are deliberately not in the probe.** Standing an agent down is a
decision with a ticket comment attached to it, and putting it one keystroke from
a status read would invite the accident the order exists to avoid.

## 5. The sequence

Each step is: **Precondition** (what must already be true), **Action**,
**Check** (what is read, off what instrument), **Abort** (what observation means
stop), **Who**.

Steps 1–7 are reversible at no cost. **Step 8 is the one-way door.** Steps 9–11
are after it.

### Step 1 — Establish which runtime is serving now

- **Precondition:** none. This is the baseline every later check is compared to.
- **Action:** read the runtime report from the running daemon — the socket action
  `agent_runtime_report`, or the `[runtime]` line the daemon logs once at boot in
  `~/.local/share/butchr/daemon.log`.
- **Check:** the report says `mode: herdr`, `source: default`, and
  `fallbackReason: null`. A `fallbackReason` here means somebody has already set
  the variable to something unusable and the daemon silently fell back.
- **Abort:** the report cannot be obtained, or it already says `crabcast`. In
  either case the machine is not in the state this sequence assumes.
- **Who:** the driver.

### Step 2 — Freeze the board before touching a single agent

- **Precondition:** step 1 checked.
- **Action:** the board reconciler must be beyond `converge` before any drain,
  and **the order is load-bearing**. Read the mode first, then take whichever of
  these two paths it puts you on:

  1. **It already reads `report` or `off`.** Change nothing. This is the cheap
     path and it is worth waiting for.
  2. **It reads `converge`.** The mode comes from the **daemon's own process
     environment**, so `export BUTCHR_BOARD_RECONCILE=off` in your shell changes
     nothing at all. It takes the same drop-in shape as step 8:
     ```bash
     mkdir -p ~/.config/systemd/user/butchr-daemon.service.d
     printf '[Service]\nEnvironment=BUTCHR_BOARD_RECONCILE=off\n' \
       > ~/.config/systemd/user/butchr-daemon.service.d/20-board.conf
     systemctl --user daemon-reload
     systemctl --user restart butchr-daemon.service
     ```

  **The mechanism, stated because the obvious reading of it is wrong in a way
  that does not change the remedy.** `boardReconcileMode()` in `daemon.ts` is
  read **on every cycle**, not captured at boot — its own docblock says so, *"so
  the mode is a property of the environment the daemon is running in rather than
  of the moment it started."* What that buys is nothing here: it re-reads the
  environment **of its own process**, and nothing outside that process can
  change it. There is no socket action and no UI control that sets the mode.
  So the restart is required, and it is required for a different reason than
  "the value was captured at boot".

  **What that restart costs while the fleet is still live**, because this step
  runs *before* the drain: no agent is killed — `epic/KAN-203` measured a real
  daemon restart under herdr with all four agents present before and after —
  and session records drop and re-form. **Every channel registration drops**
  (KAN-274) and re-forms by itself within seconds; during that window a steer to
  an agent is *refused* rather than delivered, which is honest but is a real
  cost, and it is the reason path 1 is worth waiting for.
- **Check:** `boardControl.mode` reads `off` or `report` — `butchr_list_agents`,
  socket `list_agents`, or `probe-cutover-readiness.mjs`. On a restart the
  reconciler also logs its mode as it starts: `[board] reconciler starting in
  <mode> mode`. **Do not assume the default.** `BUTCHR_BOARD_RECONCILE` defaults
  to `report`, and this machine was observed in `converge` at 2026-08-14T00:00Z
  with 32 agents under board control. A dated observation, not a constant —
  which is the reason the check is a read rather than a recollection.
- **Abort:** the mode cannot be read, or still reads `converge` after a restart —
  something else is setting it, and finding out what comes before draining
  anything.

<!-- constant-pin: BOARD_JQL
     src: daemon/src/board-reconcile.ts
     sha256: 8d6e23d84e19
     says: **The board reconciler's query is** `assignee = currentUser() AND status IN ("In Progress", "In Review")`**, and in** `converge` **it starts what that query returns.** -->

  **The board reconciler's query is** `assignee = currentUser() AND status IN ("In Progress", "In Review")`**, and in** `converge` **it starts what that query returns.** A drain performed underneath it is refilled from the board.

<!-- constant-pin: BOARD_CYCLE_MS
     src: daemon/src/board-reconcile.ts
     sha256: 7d2be7a46959
     says: **One reconciler cycle is** `BOARD_CYCLE_MS` **=** `60_000` **ms, so an agent that "came back on its own" came back within a minute.** -->

  **One reconciler cycle is** `BOARD_CYCLE_MS` **=** `60_000` **ms, so an agent that "came back on its own" came back within a minute.**
- **Who:** the driver.

### Step 3 — Tell every live agent, on its ticket

- **Precondition:** step 2 checked.
- **Action:** post on each live agent's ticket that the cutover is starting, that
  its conversation ends at step 8, and that anything it knows and has not written
  down should go on the ticket now. Comment; do not nudge — a comment on an
  agent's own ticket reaches it within a poll and costs no interrupt, and a
  composer send to an agent sitting at a dialog can answer or terminate it
  (KAN-377).
- **Check:** every live agent named by `butchr_list_agents` (socket `list_agents`) has a comment on its
  ticket, and every supervisor has replied with its state written down.
- **Abort:** an agent is mid-merge or holds work that exists nowhere but its
  conversation. Wait for it rather than draining it.
- **Who:** the driver, once per live agent.

### Step 4 — Drain the task agents

- **Precondition:** step 3 checked; the board is not converging.
- **Action:** for each task agent, either let it finish, or stand it down with
  `butchr_deactivate_agent` (socket `deactivate_by_key`) and move its ticket out of `In Progress` /
  `In Review` with a comment saying why.
- **Check:** `butchr_list_agents` (socket `list_agents`, or the probe) lists no `task/*` agent, and `missingAgents` is
  empty — an agent in `missingAgents` is one the registry still expects.
- **Abort:** a ticket cannot be moved off the board statuses. It is a landmine
  for the next time anybody sets `converge`, and it is cheaper to fix now.
- **Who:** the driver.

### Step 5 — Drain the supervisors, last of the agents

- **Precondition:** step 4 checked. Supervisors go last because they are what
  stands other agents down and what would notice something wrong.
- **Action:** stand each supervisor down with `butchr_deactivate_agent` (socket `deactivate_by_key`), after
  its state is on its ticket (step 3).
- **Check:** `butchr_list_agents` (socket `list_agents`, or the probe) lists no agents at all; `missingAgents`,
  `preemptedAgents` and `standbyAgents` are read and understood rather than
  glanced at. **`preemptedAgents` carries a promise that stops being true after
  step 8** — its documented meaning is that re-activating one resumes the
  conversation it was stopped in, which is a herdr fact (see U-3). Leave nobody
  in that list across the flip.
- **Abort:** the census cannot be taken. An unreadable census is indistinguishable
  from an empty fleet, and this step's whole content is a claim about emptiness.
- **Who:** the driver.

### Step 6 — Account for the guardian

- **Precondition:** step 5 checked.
- **Action:** read who the guardian is with `butchr_guardian` (socket `guardian`; the same block rides on `list_agents`, so the probe prints it). The guardian is a
  role laid on an agent that already has a ticket, so draining that agent leaves
  the fleet unswept. Decide and record whether that is accepted for the duration
  or reassigned after step 10.
- **Check:** `butchr_guardian` reports the current holder, and the decision is
  written on the cutover's ticket.
- **Abort:** none. This step cannot fail; it can only be skipped, which is the
  failure.
- **Who:** the driver.

### Step 7 — Rehearse the flip's riskiest unknown on a scratch workspace

- **Precondition:** steps 1–6 checked. The fleet is drained, so a rehearsal
  costs nothing but time.
- **Action:** in a throwaway workspace (not a real ticket's), verify by
  observation what §1 and Q3 derive from code: that an activation under CrabCast
  over a directory with an existing conversation starts a fresh one, and what
  happens if a live pane already holds that directory. See U-1: this is derived
  from the code and has never been run.
- **Check:** the observation is written down, with the commands, on this
  cutover's ticket — whichever way it comes out.
- **Abort:** the rehearsal shows something this document does not predict. Stop
  and correct the document before going through the door; a sequence whose stated
  mechanism is wrong is worse than none.
- **Who:** the driver.

### Step 8 — The flip

**This is the one-way door.** Everything above is reversible. Nothing below
restores a conversation.

- **Precondition:** every step above checked, and re-read at this moment rather
  than remembered from earlier in the day. Specifically: the registry expects
  nobody, no Butchr pane is alive, the board is not converging, and the driver is
  not an agent this daemon manages.
- **Action:** set the variable and restart the daemon.
  ```bash
  mkdir -p ~/.config/systemd/user/butchr-daemon.service.d
  printf '[Service]\nEnvironment=BUTCHR_AGENT_RUNTIME=crabcast\n' \
    > ~/.config/systemd/user/butchr-daemon.service.d/10-runtime.conf
  systemctl --user daemon-reload
  systemctl --user restart butchr-daemon.service
  ```
  **A drop-in, not an edit to the unit.** `daemon/scripts/install-service.sh`
  re-renders `butchr-daemon.service` unconditionally, so a value edited into that
  file is silently lost at the next install; it does not touch
  `butchr-daemon.service.d/`.
- **Check:** the runtime report from step 1's instrument now says
  `mode: crabcast`, `source: environment`, with the socket path and the pinned
  CrabCast commit it was proved against. The daemon's `[runtime]` log line says
  the same.
- **Abort:** the report says `herdr`. An unrecognised value falls back to herdr
  **and says so** in `fallbackReason` — a typo does not move the fleet. Fix the
  drop-in and restart; do not proceed on the assumption that it took.
- **Who:** the driver.

### Step 9 — One canary, and it is not a supervisor

- **Precondition:** step 8 checked.
- **Action:** activate exactly one low-value task agent. Nothing else.
- **Check:** all of the following, and a failure of any one is a failure of the
  step. This is the list the 10:58Z preconditions did not have — they asked
  whether the runtime connects, and these ask whether it can do the job:
  - the agent appears under `agents` in the census, **not** under `foreignPanes`;
  - its row carries a `sessionId`, and `sessionless` is not true;
  - `url` is not null (the 10:58Z symptom the human noticed; gate 6 closed it, so
    a null here means the fix is not working);
  - its MCP servers are present — `agent_status` echoes `config.mcpServers` with
    what was sent, rather than `undefined`;
  - it reached its tools: it can read its own ticket;
  - `butchr_tail_agent` (socket `tail_agent`) returns text from it;
  - a `butchr_send_to_agent` (socket `send_to_agent`) reports `delivered`, and the tail shows it landed;
  - the extension renders its terminal. **This one check runs through an
    uncontracted surface, and KAN-393 added this sentence because the list did
    not say so.** Rendering is `pty_init` plus the `pty_output` frames behind it,
    and the `pty_*` group is outside `contractVersion: 8` exactly as
    `activate_response` is — CrabCast may reshape it without moving the version.
    So a failure here is ambiguous in a way the other checks are not: it is
    either the cutover going wrong or the peer having moved a surface that
    carries no notice promise, and **`daemon_status.build.commit` against
    `CRABCAST_PIN` is what tells the two apart.** Read it before aborting. See
    *The PTY group is uncontracted too* in `crabcast-runtime.md`.
- **Abort:** any of the above. Also abort if the census's
  `unreadableRecordsTotal` increases, or if two panes appear for one workspace
  directory.
- **Who:** the driver.

### Step 10 — One supervisor, then the rest

- **Precondition:** step 9 fully checked, not partially.
- **Action:** activate one supervisor and run step 9's checklist against it.
  Then bring the remaining agents back, staggered rather than all at once.
- **Check:** step 9's list, per agent. Plus: capacity is not exhausted, and the
  machine's load is not what a mass restore made it.
- **Abort:** the same list. A supervisor that starts and cannot reach its tools
  looks alive and is useless, and it is the population that has no conversation
  left to fall back on.
- **Who:** the driver.

### Step 11 — Restore normal operation, last

- **Precondition:** steps 9 and 10 checked for every agent brought back.
- **Action:** put the board reconciler back to the mode it was in at step 1.
- **Check:** `boardControl.mode` reads what step 1 recorded — `butchr_list_agents`, socket `list_agents`, or the probe — and no unexpected
  agent appears within one cycle.
- **Abort:** agents appear that nobody activated. Put the reconciler back to
  `off` and find out why before letting it converge on a runtime nobody has run
  at fleet scale.
- **Who:** the driver.

---

## 5b. Rollback

Rollback is *new agents go back to herdr*. It restores no conversation. Run it in
this order for the same reason the flip has an order.

### Step R1 — Stop deciding, and freeze the board again

- **Precondition:** a decision to roll back.
- **Action:** `BUTCHR_BOARD_RECONCILE=off` (or confirm `report`).
- **Check:** `boardControl.mode` — `butchr_list_agents`, socket `list_agents`, or the probe.
- **Abort:** none — this step is always safe.
- **Who:** the driver.

### Step R2 — Drain what CrabCast started

- **Precondition:** R1 checked.
- **Action:** stand down every agent started under CrabCast, with
  `butchr_deactivate_agent` (socket `deactivate_by_key`), so the registry stops expecting them.
- **Check:** `butchr_list_agents` (socket `list_agents`, or the probe) shows no agents and an empty `missingAgents`.
- **Abort:** an agent cannot be stood down. Leaving it running is what produces
  the duplicate at R3.
- **Who:** the driver.

### Step R3 — Unset and restart

- **Precondition:** R2 checked. **This is the step the obvious version of
  rollback gets wrong**: a herdr daemon cannot see CrabCast's panes, so any agent
  still recorded active is *expected but not alive* and reconciliation starts a
  second one in the same workspace directory.
- **Action:**
  ```bash
  rm -f ~/.config/systemd/user/butchr-daemon.service.d/10-runtime.conf
  systemctl --user daemon-reload
  systemctl --user restart butchr-daemon.service
  ```
- **Check:** the runtime report says `mode: herdr`, `source: default`.
- **Abort:** the report still says `crabcast` — something else is setting the
  variable.
- **Who:** the driver.

### Step R4 — Bring the fleet back knowing what it is

- **Precondition:** R3 checked.
- **Action:** re-activate the agents that should be running.
- **Check:** each comes back, and **each is told it is starting fresh.** An agent
  whose conversation ended at step 8 has its ticket and nothing else; a resumed
  agent that believes it remembers something it does not is worse than one that
  knows it is new.
- **Abort:** duplicate panes for one workspace directory.
- **Who:** the driver.

---

## 6. Abort conditions, consolidated

Stop and do not proceed if any of these is observed at any point:

1. **The runtime report disagrees with what was set.** Including a
   `fallbackReason` — a misspelling silently keeps you on herdr, which is safe,
   and proceeding as though it did not is not.
2. **The census cannot be taken**, or `list_agents` reports it unreachable. Every
   emptiness claim in this sequence is read off that census.
3. **`unreadableRecordsTotal` increases.** Its count never falls by itself, so a
   steady non-zero is background and any *increase* is a real event.
4. **Two panes for one workspace directory**, at any step. That is the shape both
   the flip and the rollback produce when a drain was incomplete.
5. **A canary that starts and cannot reach its tools.** It looks alive. It is the
   failure mode the first flip's preconditions could not see.
6. **`url` or `sessionId` null on an agent CrabCast started.** That is the
   10:58Z symptom, and gate 6 is supposed to have closed it.
7. **Anything this document does not predict.** The sequence is only as good as
   its stated mechanism; an unpredicted observation means the mechanism is wrong,
   and the correct move is to stop and correct the document.

---

## 7. Open questions, named with owners

An unanswered question named is fine. An unanswered question absent is what this
document exists to prevent.

**U-1 — What actually happens when CrabCast activates over a live herdr pane?**
Derived from the code and never run: `getSessionByAddress` under CrabCast reads
only the local session table, which is empty after a restart, so a foreign pane
does not stop `spawnSession`, and a `configure_agent` + `activate_agent` follows
in a directory that already has a live agent in it. Both panes then map to the
same derived name, so a confirmation read would not notice. **Owner:** the
driver, at step 7, on a scratch workspace. It is a step rather than a ticket
because it is cheap once the fleet is drained and worthless before.

**U-2 — Is a pre-flip conversation recoverable by hand?** The transcript file
survives; `claude --resume` takes a session id. Whether that produces a working
agent, and whether Butchr can be made to re-adopt one, is unmeasured. **Owner:**
unassigned. Nothing in this sequence depends on the answer, and the answer would
change how much §1's warning costs.

**U-3 — the standby and preempted rows promise a resume that CrabCast cannot
give.** `butchr_list_agents` tells its readers that re-activating a preempted
agent "resumes the conversation it was stopped in", and each standby row carries
the same sentence: *"switching it back on resumes the conversation it was stopped
in rather than starting a new one."* That is true under herdr and false under
CrabCast, and the surface states it unconditionally — to a population of 123 at
the reading above. **Owner:** filed as
[KAN-387](https://wroosbit.atlassian.net/browse/KAN-387) and linked `Relates` to
KAN-378.

**U-4 — Does the flip's safety at restart depend on CrabCast's foreign-pane
fields?** `reconcileAgents` skips an agent it sees as alive, and under CrabCast
that liveness comes from a census row whose name is derived from `workDir` and
whose `agentRuntime` is non-null. Both were measured on live peers at v4 and v6.
If either stops being true, a restart with the variable set re-spawns the whole
expected fleet fresh instead of leaving it alone. **This sequence does not rely
on it** — draining first makes the expected set empty, which is why draining is
required rather than tidy — but anybody tempted to skip the drain is relying on
it without knowing. **Owner:** whoever proposes skipping the drain.

---

## 8. What this document is not, and what nothing checks

- **It does not authorise the cutover**, decide when it happens, or record it as
  scheduled.
- **It does not close any gate.** It assumes they will close and asks what order
  to move in when they have.
- **Nothing here checks that the order is *right*.** The pins and
  `verify-cutover-sequence.mjs` check that the document's code claims still hold,
  that no step is missing a precondition, a check, an abort or an owner, and that
  no check is written in tools the driver Q6 requires does not have. That a step
  is in the correct *place* is a judgement, and the only cover for it is a reader
  who is not the author walking it and saying where it is ambiguous — which is
  recorded on KAN-378 rather than in a script.
- **That walkthrough has happened once, and it found two things.** `epic/KAN-39`
  walked this on 2026-08-14 and reported that step 2 offered a change it could
  not effect, and that Q6 ruled out the driver every other step's instrument
  assumed. Both are fixed above — §4b exists because of the second. **Neither
  was in the order**, which is the part a script cannot check and the part that
  survived review.

## 9. Provenance

The gate list and its status are KAN-348's. The 10:58Z incident, its six met
preconditions and the seven minutes to `task/KAN-275`'s loss are recorded there
and in `docs/crabcast-runtime.md`. The restart control — a real daemon restart
under herdr that killed nothing — is `epic/KAN-203`'s measurement during the
KAN-342 deploy. The foreign-pane census rows are read from
`daemon/scripts/fixtures/crabcast-v4-short-census.json` and
`crabcast-owned-running-census.json`, both captured off live CrabCast daemons.
Everything about Butchr's own behaviour is read off this checkout, at the branch
of KAN-378. **No CrabCast source was read** — invariant 10 is permanent.
