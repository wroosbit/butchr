# The Agents page as the org chart

**Ticket:** KAN-81, the extension half of story KAN-78. **Depends on:** KAN-77
(which writes the supervisor of record) and KAN-80 (which puts it on the wire) —
but not for merging: see [Against a daemon that does not send it](#against-a-daemon-that-does-not-send-it).

## The problem

`chrome-extension://<id>/agents.html` listed every running agent as one flat row
among equals. The central design decision of this system is that the issue
hierarchy **is** the org chart — each supervisor watches exactly its children —
and the page that showed the whole fleet was the one place that structure was
invisible. Two epics, three stories and five tasks read as ten undifferentiated
rows, and the shape the reader had to rebuild in their head was the shape the
daemon was already running on.

## Where parentage comes from

From one field, and only from it:

```jsonc
{ "activatedBy": { "type": "epic", "key": "KAN-39" } }   // or null
```

`activatedBy` is the **supervisor of record**, written into the durable registry
at activation time from the identity of the MCP caller that asked for the
activation, and reported on every row of all four lists — `agents`,
`standbyAgents`, `preemptedAgents`, `missingAgents`. `null` means nobody
supervising asked: a human or the extension started it.

The extension makes no Jira call and infers nothing. It does not read issue
keys, issue types, or naming conventions to guess who is above whom. If the
daemon does not say, the page does not know, and an agent it does not know the
parent of renders at top level — which is the honest rendering, not a fallback.

### How the caller's identity gets there (KAN-145)

The whole chain hangs off one link that was missing for the feature's entire
first life: **the agent's own MCP server has to know which workspace it belongs
to.** It learns that from its command line. At activation the daemon writes the
workspace's `.mcp.json` with the identity stamped onto the core server:

```jsonc
"butchr": {
  "command": "…/node",
  "args": ["…/daemon/dist/mcp.js", "--workspace-type", "story", "--workspace-key", "KAN-90"]
}
```

The agent's CLI spawns that server from that file, `mcp.ts` reads the two flags
off its own argv and attaches them to every daemon request, and
`supervisorOfRecord` in `router.ts` records them as the activated agent's
parent. Anyone doubting a link can read the middle of it out of
`/proc/<pid>/cmdline`.

Three things about that are decisions rather than details:

* **`args`, not `env`.** A definition carrying `env` is reported to the settings
  page by its **name alone** (KAN-106, `describeMcpServers`), because `env` is
  where a credential would ride. A workspace type and key are the ticket key —
  not a secret, and already on every surface — so putting them in `env` would
  have hidden the core server's command line for no security reason and made a
  security rule bend for a plumbing fix. Nothing about that rule was loosened.
* **Never in the global agy config.** `configureAgyMcp` writes one file for
  every workspace, so a per-workspace identity written there would name whichever
  agent was activated last. Anti-gravity agents are therefore parentless until
  that CLI grows a project-scoped config: recording the wrong supervisor is worse
  than recording none.

  **Since KAN-398 that is enforced by `configureAgyMcp` itself**, which strips the
  identity flags before writing. It used to hold because `initPty` happened to
  hand `launcher.setup` the unstamped assembly — the stamp was applied one branch
  further along. KAN-398 moved both MCP transforms above the runtime seam so that
  neither runtime can omit them, which means what reaches `launcher.setup` is now
  stamped. **A property that depends on what a caller remembers to pass is not
  enforced**, so it moved to the writer that owns the file. The positive control
  is in `verify-workspace-mcp-preparation.mjs` §6: the same prepared assembly
  goes through both writers, and only the workspace one keeps the flags.
* **No backfill.** Parentage is recorded at activation, and there is nothing to
  recover it from for an agent already running — its MCP server was spawned from
  the old file and cannot be told anything now. Every agent live at the moment
  this shipped stays `activatedBy: null` until it is switched off and on again.
  A migration would have to invent the answer, and inventing one is exactly what
  this field must never do.

Before KAN-145 the identity was set as `BUTCHR_WORKSPACE_TYPE`/`_KEY` on the
`herdr agent attach` PTY — a client of the agent's pane, not an ancestor of the
agent — so nothing ever read it and every agent in every fleet came back
parentless while each individual link looked correct. The proof that this cannot
silently happen again is `daemon/scripts/verify-activation-records-real-parentage.mjs`,
which starts at the `.mcp.json` and ends at `list_agents` without writing a
parentage record anywhere in between.

### Indexed by `(type, key)`, never by key

The live fleet has both `epic/KAN-39` and `task/KAN-39` — a supervisor and a
worker on the same ticket. An index keyed by issue key alone gives every one of
that epic's children to whichever of the two was indexed last. The address of an
agent is the pair, case-folded the way the daemon's own `butchr-<type>-<key>`
naming folds it.

## What the tree is allowed to change, and what it is not

### One switch per agent

The daemon's three not-running lists are disjoint on purpose, so that no agent
ever grows two switches. The tree is the first thing that could break that from
the client side: a stood-down story nested under its live epic is a *second*
place the same agent appears on the page.

So the split is:

| where | what it has |
| --- | --- |
| the banners (`missingAgents`, `preemptedAgents`) and the Stood down section | the agent's one switch — Restore, Put back, Turn on — and any refusal that switch produced |
| its row in the tree | a **reference**: what kind of not-running it is, in its category's colour, and where the switch is |

A reference carries no button. Structure is what the tree adds; it takes nothing
over. The alternative — moving the switches into the tree — would have emptied
the sections of everything except their explanations, including the Stood down
list's "N older stood-down agents are not shown" notice, which is the only place
the daemon's 25-row cap is admitted to.

A running row is not a reference: it is the row, drawn by `agents.jsx` itself
through `AgentTree`'s `renderRunning` prop, so the card, the priority chip, the
supervisor badge, the Off control and its confirmation are literally the same
markup at depth 3 as at depth 0.

### Which not-running agents enter the tree at all

Only those connected to something running — an ancestor of a running agent, a
descendant of one, or a sibling reached through them.

A standby story under a live epic is information: it says the epic has a child
and the child is switched off. A standby agent with no running relative is not
structure, it is the same row twice — once as a shape with nothing in it, once
in the list below that owns its switch. It stays in that list alone.

That rule also settles the empty page. With nothing running, no component
contains a running agent, the forest is empty, and the page says "No agents
currently running" rather than drawing an org chart of things that are all off.

### No type ranking lives here

Sibling order is: what is working, then what is wrong, then what is owed, then
what was chosen — and within a category, the order the daemon sent. It is an
ordering of the four *categories*, not of workspace types. There is deliberately
no `epic > story > task` anywhere in the extension: that rule lives in
`SUPERVISOR_WORKSPACE_TYPES` in `daemon/src/registry.ts` and is reported over the
wire twice already (`list_agents` rows carry `supervisor`; `list_integrations`
carries `providedTypes[].priority` and `.supervisor`). A third copy on this side
is the copy that gets forgotten when a supervisor type is added.

Nesting needs none of it: edges come from `activatedBy` and from nothing else.

## Against a daemon that does not send it

An older daemon omits `activatedBy` entirely. Then no row has a parent, every
running agent is a root with no children, and what `buildAgentTree` returns is
the flat list the page has always drawn — same rows, same order, same keys, no
reference rows.

The flat rendering is the **degenerate tree**, not a second code path. There is
no fallback branch that can rot separately from the thing it falls back to, and
nothing to remember to delete when the daemon catches up. It is the same
ride-along tolerance `staleness` and `priorities` already use.

`buildAgentTree` distinguishes the two cases it would otherwise conflate:
`carriesParentage` is whether the daemon answered the question at all, `nested`
is whether the answer drew any edges. A daemon that answers "nobody" for every
agent is not the same fact as a daemon that cannot answer.

## Keys, and the flicker

Rows are keyed by `agent.agentName` at every depth, never by array index. The
fleet payload is replaced wholesale every 2 seconds, so an agent leaving shifts
every index after it, and React would carry an open Off confirmation — or a
"Stopping…" — onto whichever agent inherited the position. Nesting does not
change that rule; it multiplies the number of lists it has to hold for.

## Files

| file | what it is |
| --- | --- |
| `extension/src/lib/agentTree.js` | `buildAgentTree(payload)` — the four lists in, the forest out. No React. |
| `extension/src/components/AgentTree.jsx` | drawing it: the indent, the rule down its left, and the reference rows |
| `extension/agents.jsx` | the running row, and the page around it — unchanged in what it draws |

## Proof

```bash
cd extension && node scripts/verify-agent-tree.mjs [outDir]
```

Exit code 0 means every assertion held. It feeds a synthetic payload — the
epic→story→task chain, `epic/KAN-39` beside `task/KAN-39`, a stood-down and a
preempted task under a live story, a live task under a *missing* story, an agent
nobody activated, an agent whose activator is on no list, and a stood-down agent
with no running relative — through the real `buildAgentTree` and the real
components, and prints the tree, the assertions, and a census of every agent on
the page with the number of switches it has. It also writes `tree.html`: static
markup, no scripts, screenshottable anywhere.

That render goes to a temp directory outside the repository unless you pass an
`outDir`, and the run prints the full path. It used to default to
`extension/kan81-render/`, which committed a checked-in copy to the repository —
KAN-326 has the account of what that cost, and
`extension/scripts/verify-render-writes-outside-the-tree.mjs` is what keeps the
default where it is.

The payload is synthetic because the daemon does not send the field yet. That is
the intended proof for this half rather than a stand-in for one — the wire
contract is the specification, and this script is the first thing that consumes
it.

The one thing it cannot prove is what the rendering looks like in Chrome. That
is a human pressing Reload at `chrome://extensions` and looking.
