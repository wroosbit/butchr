# Staleness: when what is running is not what was merged

Merging a PR changes nothing on this machine. The clone is not pulled, `dist/`
does not rebuild itself, and Chrome does not reload an unpacked extension.
Three manual steps stand between a merge and the code actually running, and
until KAN-30 nothing said they were outstanding.

That is not a tidiness problem. It produces **false conclusions about whether
features work**. On 2026-07-31 a merged Settings feature appeared to be broken;
the bundle was simply a day old. Worse, every agent that proves its work by
pointing at a running daemon is proving something about *whatever was last
built* — an agent can pass its acceptance criteria while testing code that no
longer exists on `main`.

---

## The ritual

Do all of this, in this order, every time something merges:

```bash
# 1. the code
git pull --ff-only

# 2. the daemon: rebuild, then restart it — a running daemon keeps executing
#    the code it loaded at startup, no matter what is on disk now
cd daemon && npm run build && cd ..
systemctl --user restart butchr-daemon.service
#   (no systemd: pkill -f butchr/daemon/dist/daemon.js — the next client respawns it)

# 3. the extension: rebuild...
cd extension && npm run build && cd ..
```

**There is no step 4, and that is the point of the next section.** None of the
above restarts the per-workspace MCP servers — one `mcp.js` per running agent,
each serving every proxy call that agent makes. They go on executing whatever
they loaded at spawn. Since KAN-526 the daemon says so ~45s after it starts,
naming which agents are behind, instead of leaving the four green items above to
read as a complete account of the deploy.

...and then **press Reload on the extension at `chrome://extensions` yourself.**

That last step cannot be automated from here, and this document is not going to
pretend otherwise. An unpacked extension is reloaded by the browser, on a user
gesture or by an extension-management API that only another extension can call.
A daemon outside the browser has no channel that reaches it — not the native
messaging port, which is *owned* by the extension it would have to restart.
Skipping it means reading today's source while testing yesterday's bundle,
which is exactly the mistake this page exists to prevent.

---

## What the check looks at

The daemon compares the following, all from local reads. Each is reported
fresh / stale / unknown **with the evidence it was decided on**, because
"stale" without a commit hash or an mtime is one more thing to distrust.

| Item | Compares | Stale means |
| --- | --- | --- |
| `git` — local checkout | `HEAD` vs `origin/main`, as last fetched | commits merged that this checkout does not have |
| `daemon-build` | newest mtime among `daemon/`'s **build inputs** vs newest `daemon/dist` mtime | an input changed after the last build |
| `daemon-process` | daemon start time vs `daemon/dist` mtime | `dist` was rebuilt while this daemon kept running |
| `mcp-servers` | the build each connected agent's `mcp.js` loaded, vs newest `daemon/dist` mtime | an agent is serving its own calls out of a build older than the deploy |
| `extension-build` | newest mtime among `extension/`'s **build inputs** vs newest `extension/dist` mtime | an input changed after the last build |

### What counts as a build input

Not "everything in the directory". `tsc` compiles `daemon/src/**` and nothing
else; `vite build` reads the three HTML entry points at the extension root,
what they import, and `public/`. Neither reads `scripts/` — the verify scripts
and render harnesses there run *against* a build and are never compiled into
one — so editing one used to report a stale extension build with a remedy no
rebuild could satisfy, and which asks the operator for a `chrome://extensions`
reload (KAN-305). The cost was not the noise: **while that item was red for a
verify script, a genuinely stale build was indistinguishable from it.**

The input set lives in `BuildInputs` in `daemon/src/staleness.ts` and each
report repeats it on the evidence line, so what was compared is visible in the
answer rather than only in the source.

**It is a classification, not a list.** Every entry beside the build must be
declared either an input or — with the reason — not one. An entry matching
neither makes the item `unknown`, names itself, and says where to classify it,
because the failure mode of a bare allowlist is the directory added after it
was written: never scanned, and so a `dist` genuinely behind it reports fresh.
A lying green is worse than the lying red this replaced. You will also see that
`unknown` on a checkout that is behind `origin/main` and still holds a
directory since deleted; pulling clears it, and the `git` item is red alongside
it saying so.

`daemon-process` is not in the original ticket; it is here because it is
symptomatically identical to a stale build. You rebuild, you do not restart,
and the daemon serves the old code from memory with a perfectly fresh `dist/`
on disk to reassure you.

**No network call.** The git comparison uses the remote-tracking ref as it
stands — what `git fetch` last told us — and says how old that knowledge is. A
blocking `git fetch` at daemon startup would trade a silent failure for a slow
one, and would fail entirely on a machine that is offline or behind an
expired credential.

---

## Where you see it

* **The Agents page** (`chrome-extension://…/agents.html`) — a red banner above
  the agent list whenever something is demonstrably stale, with a *Show
  details* toggle for the evidence and the fix for each item.
* **The daemon log**, once at startup, in the same shape.
* **Over the socket**: `{"action": "staleness_check"}`, with `{"force": true}`
  to bypass the 15s cache.
* **Over MCP**: `butchr_staleness_check`. It returns `isError` when the
  install is stale, so an agent that asks cannot skim past the answer. Its
  `servingProcess` block is written by the `mcp.js` answering *your* call, not
  by the daemon — see below.

### Why the Agents page

A log line does not count — that is the standard KAN-24 was held to, and it is
the right one. Of the surfaces that exist:

* The **sidepanel** is per-page and terminal-shaped. It is where you watch one
  agent work, not where you ask what state this machine is in, and it would put
  the same warning in front of you once per tab.
* The **Agents page** is already the one view about the installation as a
  whole, it is where a human goes when they are deciding whether to believe
  what they are seeing, and it already polls `list_agents` every 2s — so the
  banner needs no request of its own. The report rides along on that poll.

For agents rather than humans, the MCP tool is the surface, and it is the one
worth using *before* citing anything observed from a running daemon as proof.

---

## A live probe measures the answering process, not the deploy

**This is the one on this page that costs the most time when it is not known**,
and it was re-derived at cost on 2026-08-18 (KAN-526) after two agents read the
same deployed build and observed opposite behaviour, both reporting honestly.

Butchr has **two** long-lived processes, and they are restarted by different
things:

| Process | One per | Restarted by | Reached by a deploy? |
| --- | --- | --- | --- |
| `daemon.js` | machine | `systemctl --user restart butchr-daemon.service` | **yes** |
| `mcp.js` | *running agent* | that agent's client starting — i.e. an agent reset or re-activation | **no** |

Every proxy call an agent makes is served by that agent's own `mcp.js`, spawned
when its client started and living as long as the session does. Nothing in the
deploy path restarts them, and nothing should decide to on its own: reloading
one costs that agent its session and whatever work it had in flight, which is a
decision rather than a defect (KAN-526 scopes the restart policy out
deliberately).

**So "is this deployed?" is not answerable by observation.** A live probe
reports the age of whichever process answered it. Concretely, on 2026-08-18 a
single call from one agent carried both halves at once:

* a **daemon-side** ADF coercion carrying KAN-502's fix, merged twelve minutes
  earlier and **live** — because a daemon restart reaches it;
* an **`mcp.js`-side** recovery recipe carrying KAN-501's defect, merged
  eighteen minutes earlier and **inert** — because nothing had restarted that
  server, which had been up since 21:42.

⚠ **The direction of the error is the dangerous one.** The daemon-side half goes
live first, so a deploy *looks* successful; KAN-501 was announced fleet-wide as
live on exactly that basis and had to be retracted.

⚠ **And the unit is the surface, not the commit and not the ticket.** KAN-501
straddles the seam by itself: its ADF-to-text rendering lives in
`atlassian-proxy.ts` and rides the daemon, while its response-budget stub and the
recipe that stub prints come from `mcp.js` and do not. One commit, half live. A
check that answered *"KAN-501: live"* or *"KAN-501: not live"* would be wrong
either way — which is why the `mcp-servers` item and `servingProcess` both report
**processes and builds**, never tickets.

⚠ **Whether a behavioural probe sees the defect depends on the size of its
response.** Two agents on the same build reported opposite results and both were
right: one's comments call fit the response budget, so the stub never fired and
only the daemon-side half was exercised; the other's exceeded it, so the stale
`mcp.js` half spoke. **"I called the tool and it worked" is therefore not
evidence** — a response small enough to pass the budget never reaches the path in
question. Any *behavioural* verification of a budget-side fix has to provoke a
clip deliberately and say that it did. (The `mcp-servers` item is not exposed to
this: it compares build stamps and exercises no response path, so no size of
anything can turn it green.)

### What to do about it

* **Say which surface you measured.** "The fix is live" is true per surface, not
  per commit. A check that does not name its surface is true and misleading at
  once.
* **`reshapedByDaemon: true` on a proxy response is a per-response
  discriminator** — it marks daemon-side behaviour, and its absence on a clip
  envelope marks the `mcp.js` side. It needs no knowledge of process start
  times.
* **Ask, rather than infer.** `butchr_staleness_check` carries
  `servingProcess`: the pid, start time and loaded build of the `mcp.js`
  answering *that call*, with `relation.kind` of `current`, `older`,
  `other-tree`, `unreadable` or `unstamped`. It is composed by that process,
  because a report about the answering process cannot be written by anything
  else. `older` means your own live output is evidence about the code you
  started with.
* **`unstamped` means old, not unknown.** Only an `mcp.js` built after KAN-526
  announces a build at all, so a server that announces none cannot be running
  one that does.
* **Read the `mcp-servers` item for the fleet.** It names which agents are
  behind. An **empty** list there is reported as `unknown`, never as fresh: a
  daemon restart drops every registration and servers re-announce themselves
  over the following seconds, so "I can see nobody" and "nobody is stale" stay
  different sentences.

---

## It warns. It never blocks.

Refusing to start on a stale build would have prevented the confusion that
opened KAN-30 — and it would be the wrong trade:

* The daemon is restarted **most often by the person actively changing it**,
  which is precisely when `daemon/dist` is legitimately mid-flight. A hard
  refusal would fire hardest at the one person who already knows.
* Blocking startup takes the whole board down — every running agent's terminal
  — over a condition whose remedy is a `git pull`. The failure mode of the
  block is strictly worse than the failure mode it prevents.
* Staleness is frequently *correct*: an agent on a feature branch is meant to
  be behind `origin/main`, and a bisect or a revert test is meant to be behind
  it by a lot.
* The actual harm is a **false conclusion**, not a wrong execution. Old code
  runs fine; it just is not the code under review. The fix for a false
  conclusion is telling the person, loudly, at the moment they are drawing it.

So: nothing here pulls, builds, restarts, or refuses. It reports. The one
concession to loudness is that the MCP tool marks its response as an error when
the install is stale, which an agent has to actively decide to ignore.

---

## Why it does not cry wolf

A warning that fires when nothing is wrong is ignored by the following
afternoon, so each way that could happen is closed deliberately:

* **An agent building in its own worktree.** The mtime scan never leaves the
  daemon's own repo root, and refuses to descend into any directory containing
  a `.git` entry — which every worktree has. A task agent's worktree is
  invisible to it even when the worktree is created *inside* the checkout.
* **`origin/main` moved for an unrelated branch.** The comparison is against
  `origin/main` alone. Other refs moving, however many, change nothing.
* **A deliberate feature-branch checkout.** When the checkout is not on the
  default branch it is reported as *not applicable* — with the behind-count as
  information, not as an alarm. This is the state every agent worktree and
  every mid-feature human is permanently in.
* **Not knowing.** A missing or long-stale `FETCH_HEAD` yields `unknown`, never
  `stale`. Only demonstrable staleness turns the banner red; when everything is
  fresh the banner renders nothing at all, because a green "all good" bar
  teaches the eye to skip the space the red one needs.

---

## See also

* `node daemon/scripts/butchr-doctor.mjs` — the on-demand health check for a
  whole install. It covers the two build gaps from a terminal; this check adds
  the git and running-process gaps and puts all four where they are seen
  without being asked for.
* `node daemon/scripts/verify-staleness-check.mjs` — manufactures each stale
  state against a real clone and shows the check reporting it.
* `node daemon/scripts/verify-staleness-over-socket.mjs` — starts a real daemon
  against a real stale checkout and shows the startup log, the socket response
  and the `list_agents` payload the banner reads.
* [docs/SETUP.md](SETUP.md) §10 — the same ritual, in install order.
