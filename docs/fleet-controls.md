# Switching agents on and off from the Agents page

**Ticket:** KAN-38. **Depends on:** KAN-21 (the durable registry, which is where
the *on* candidates come from), KAN-36 (the visible refusal) and KAN-28 (a
census taken from what exists rather than from the session map).

## The problem

`chrome-extension://<id>/agents.html` listed every running agent — name, state
chip, workspace, link — and could act on none of them. The one screen that
showed the whole fleet was the one screen that could not touch it. Stopping an
agent meant opening its own Jira tab and using the sidepanel toggle, or asking
the board manager to do it.

## Off is nearly free. On is the design question.

**Off** already had its plumbing: `DEACTIVATE_BUTCHR_BY_KEY` → `deactivate_by_key`,
which since KAN-9 tears down sessionless agents too. It is reached by key rather
than by session id, deliberately — an agent that outlived the daemon holding its
terminal has no session id and is exactly as stoppable, so there is one way an
agent stops rather than two.

**On** is harder, because *the page lists what is running, and something that is
off is not in that list*. The candidates cannot come from the page. They come
from KAN-21's registry — the append-only record of activation intent that
boot-time reconciliation already reads — reduced three ways, disjointly, so no
agent ever grows two switches:

| list | what it means | the switch |
| --- | --- | --- |
| `missingAgents` | recorded active, absent anyway — a loss nobody chose | **Restore** |
| `preemptedAgents` | stood down so something more important could run — a debt | **Put back** |
| `standbyAgents` | stood down because a person said so — a choice | **Turn on** |

No parallel registry is written. `standbyAgents` is the new one, and it exists
because without it Off would be a one-way door: an agent switched off from this
page leaves every list the page renders, and there would be no way back except
finding its Jira tab again.

Two filters keep that list honest. An agent that is **still running** is never
offered On — the stand-down failed, or it has been started again since, and a
control that offers to start what is already started is a control that lies. An
agent whose **workspace is no longer on disk** is not offered either: `reset`
records a stand-down too, and the deleted directory is the only thing that
distinguishes "stopped" from "finished with".

The service worker gained `ACTIVATE_BUTCHR_BY_KEY` → `activate_by_key`. That
path existed in the daemon and in the MCP tool and had never been exposed to the
extension, which only knew how to activate by URL. Every agent on the three
lists above has no page open, so URL activation could not reach any of them.

### A stand-down now carries the activation record

`AgentRecord` is the argument list of an activation, and `defaultAgent` is one of
its arguments. Before this, a stand-down recorded only
`{ agentName, type, key, workDir }` — harmless for exactly as long as nothing
switched a stood-down agent back on. With an On button that is the ordinary
path, and an agent whose launcher was forgotten comes back through
`resolveLauncher(undefined)` as a **bare shell wearing the name of a Claude
agent**: running nothing, reporting nothing, and indistinguishable on this page
from a healthy row.

So `url`, `defaultAgent`, `mcpServers` and `workDir` are carried from the last
activation onto the stand-down, along with the key's Jira spelling — an agent
addressed from a census arrives as `kan-38`, and the row it is about to appear
on sits next to a ticket spelled `KAN-38`. Records written before this cannot be
repaired retrospectively; the page marks those rows `shell` so the promise it
makes is one it can keep.

## Off is not one click

The hazard is specific and has already happened: on 2026-07-31 three agents were
found **idle** with real unpushed changes in their worktrees. From a fleet list,
that is what an hour of uncommitted work looks like.

A `confirm()` dialog says the same words whether there is anything to lose or
not, and a warning that never varies is one nobody finishes reading. So the
confirmation goes and looks: `{"action": "agent_work_state"}` runs git in the
agent's workspace and one level below it — which is where the work is, because
agents create their worktree *inside* the workspace — and the confirmation
renders what it found:

```
Stop task/KAN-38?
herdr reports it is working. Stopping it ends the conversation it is in;
switching it back on later resumes that conversation, but anything it has
not committed is gone for good.
🚨 Unsaved work in 1 repository — butchr on butchr/KAN-38: 1 changed,
   1 untracked, never pushed.
[ Cancel ]  [ Stop task/KAN-38 ]
```

It is asked **once**, when the button is pressed — never on the page's
2-second poll, which would put a permanent subprocess load on the machine whose
capacity this system spends its time rationing.

When it cannot look — no repository, git unavailable, workspace gone — it says
so and the warning still stands. A check that renders its own failure as
"nothing to lose" is worse than no check, because the all-clear is the one that
gets believed.

## The board manager: allowed, guarded, reversible

`manage/work` is listed here like anything else, and switching it off stops the
thing that reads the board, staffs tickets and merges finished work — which
after KAN-37 is also the only agent nothing can preempt.

**It is allowed.** Refusing was the tempting answer and it is the wrong one: a
supervisor you cannot stop is a worse failure than one you can stop by accident,
and it is the agent a human is most likely to need stood down. Three things make
that safe rather than reckless:

1. `list_agents` marks the row `supervisor: true`. The rule lives in
   `registry.ts` (`SUPERVISOR_WORKSPACE_TYPES`) and is sent over the wire rather
   than duplicated in the UI, so adding a second supervisor type does not leave
   a stale copy behind.
2. Its confirmation is different in kind — red rather than amber, and it says
   what stops while it is off, including that nothing the other agents finish
   will be merged.
3. It appears on the **Stood down** list the moment it stops, so the guard is a
   speed limit rather than a cliff.

## Fighting the poll

The page replaces the whole fleet every 2 seconds. Anything a person is in the
middle of lives on a different clock, so the two are kept apart:

- **the poll owns what is running** (`list_agents`)
- **`useFleetControls` owns what was asked for**, keyed by agent *name*

Neither writes to the other, and three bugs are closed by that:

**Rows are keyed by agent name, not array index.** Index keys were harmless
while the page was read-only. The moment a row holds state they are not: an
agent leaving the list shifts every index after it, and React carries an open
confirmation — or a "Stopping…" — onto whichever agent inherited the position.

**An in-flight action ends when the census agrees, not when the daemon replies.**
`deactivate_response` means *accepted*, not *gone*. Clearing the control there
would flash the row back to "running, press Off" for the length of the teardown.
A pending Off clears when the agent leaves the census; a pending On clears when
it appears in it — the same ground truth `herdr agent list` reports. A refusal
or an error ends it too, because those mean it will never happen, and 45 seconds
of silence ends it with a visible complaint rather than a spinner that never
stops.

**The row reports the decision rather than offering a disabled button.**
"Stopping…" and "Starting…" replace the control outright: nothing to
double-press, and nothing whose enabled-ness the poll could argue with.

## Refusals

Turning an agent on can be refused at capacity. The Agents page renders that
with `ActivationRefusal.jsx` — the same component the sidepanel uses, given the
same fields — placed under the row whose button was pressed, because on a list
of near-identical rows a refusal that appears somewhere else is one the reader
has to attribute for themselves. KAN-36 exists because one surface swallowed
this; a second surface swallowing it differently would be that defect twice.

Both answers the daemon names are offered: **Start anyway** (recorded, with the
figures at the time) and **Stand down X and start** when the refusal carries a
preemption offer. Neither decides anything — KAN-37 put scheduling out of scope
and this does not reopen it. A person still reads a name and presses a button
that states its cost.

## What is deliberately absent

- **`reset`.** Deleting a workspace is destructive in a different league from
  stopping an agent and does not belong behind a fleet-list button.
- **Anything automatic.** Nothing here restarts, rebalances or queues. Every
  transition on this page is a person pressing a button that named what it
  would do.

## Proving it

```bash
cd daemon && npm run build
node scripts/verify-agent-power-controls.mjs      # the decisions, against a stubbed herdr
node scripts/verify-fleet-switch-live.mjs         # a real daemon, real herdr, real panes
```

The first drives the real `MessageRouter`, `WorkspaceRegistry` and on-disk
`AgentRegistry` through all eight questions the ticket asked — off, the
confirmation, the manager, on, the launcher record, the refusal, poll stability,
and reset. The second opens and closes a real pane on a real herdr and uses
`herdr agent list` as the ground truth, isolating its registry under a temporary
`$HOME` so the live install is never written to. It cleans up on every exit path.

For what the human sees:

```bash
node daemon/scripts/verify-agent-power-controls.mjs --dump /tmp/kan38-payloads
cd extension && npm run build
node scripts/screenshot-agent-controls.mjs /tmp/kan38-payloads /tmp/shots   # clicks the real bundle
node scripts/render-agent-controls.mjs /tmp/kan38-payloads /tmp/out         # no browser needed
```

Both render real daemon output rather than a hand-written fixture. The first is
the better proof where a browser will render; the second is the fallback for
sandboxes where headless Chrome produces no frame at all, and emits a static
page that any browser can screenshot.
