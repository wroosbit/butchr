# The CI partition of the `verify-` scripts

**Generated — do not hand-edit.** Regenerate with:

```bash
node daemon/scripts/run-ci-verify-set.mjs --markdown > daemon/scripts/ci-partition.md
```

One row per `verify-*.mjs`. The **source of truth is the `CI-RUNNABLE:` line in
each script's own header**, where the next reader of that script meets it; this
file is a view of those lines and nothing more.
`verify-ci-partition-is-enforced.mjs` §6 goes red when the two disagree, in
either direction.

## If you got here from a merge conflict

**Regenerate this file. Never hand-merge it.** Two pull requests that each add
a `verify-*` script both regenerate it, so they collide here and usually
nowhere else. KAN-590 measured three such collisions on 2026-08-21, and in one
of them the only conflicted file was this one while the code that was actually
under review auto-merged clean.

Run this from the repository root, with the conflict still in the tree:

```bash
node daemon/scripts/run-ci-verify-set.mjs --markdown > daemon/scripts/ci-partition.md
git add daemon/scripts/ci-partition.md
node daemon/scripts/verify-ci-partition-is-enforced.mjs
```

The redirect overwrites the conflict markers whole, and the generator reads the
scripts in the merged tree — which already contain BOTH sides' new scripts,
because those auto-merged. Check both appear in the result; the third line is
that check, and it is a separate command so that its verdict is its own.

**Two steps you may have seen are not needed.** The version of this recipe that
circulated in commit messages opened with `git checkout origin/main --` on this
file and a `cd daemon && npm run build`. Neither is required: the redirect
replaces the file regardless of its conflicted state, and `--markdown` returns
before the generator looks for `dist` — measured on a worktree carrying no
`daemon/dist` directory at all, emitting a byte-identical document.

**Why no merge driver does this for you.** Measured on that conflict, four
arms, a separate clone each so that no arm inherited the merge of another:

| arm | merge | this file afterwards |
| --- | --- | --- |
| no `.gitattributes` — today | conflict | both rows, with markers |
| `merge=ours`, driver not configured | **conflict — the attribute is a silent no-op** | both rows, with markers |
| `merge=ours`, `merge.ours.driver` configured | clean | **the incoming row is silently dropped** |
| `merge=union` | clean | both rows, summary wrong |

`ours` is **not** one of git's built-in merge drivers — `text`, `binary` and
`union` are the whole list — so a `.gitattributes` line naming it does nothing
until `merge.ours.driver` is configured, which lives in the config of a clone
and cannot be carried by the repository. `git check-attr` reports `merge: ours`
the whole time, so the no-op is silent.

And every arm still ends here: `verify-ci-partition-is-enforced.mjs` was red in
**all four**, because a driver resolves *text* and cannot know what the
generator would emit. A driver would not remove the regenerate — it would only
move the discovery from merge time, with the file open in front of you, to CI
time.

## Why this file exists

KAN-295. On 2026-08-11 this repository held 76 `verify-*` scripts and CI
evaluated the assertions of **one**. `verify-script-sweep` swept all 76, but
only for
verdict-driven exits — that each *could* report failure, never what any of them
asserted. Every "made to go red" proof on the board was therefore a one-time,
hand-driven demonstration at review time: real the day it landed, and never
re-evaluated after merge.

The answer is not "run all 76" — many genuinely cannot run unattended. So the
classification is the deliverable and the CI job is downstream of it.

## The classes

| class | meaning | run by CI |
| --- | --- | --- |
| `yes` | runs in CI; every section asserts | **yes** |
| `partial` | runs in CI and asserts a real subset — named sections need something CI has not got | **yes** |
| `quarantined` | CI-runnable but currently RED — excluded loudly, with a reason and a ticket | no |
| `no` | cannot run unattended in CI | no |

## Totals

| class | count |
| --- | --- |
| `yes` | 140 |
| `partial` | 23 |
| `quarantined` | 3 |
| `no` | 23 |
| **total** | **189** |

**163 of 189** run on every pull request.

## `yes` — runs in CI; every section asserts

| script | class | reason |
| --- | --- | --- |
| `verify-absence-attribution` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-absence-is-not-intent` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. Section 5 additionally shells out to the repo's own `tsc`. |
| `verify-activate-requires-agent` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-activation-records-real-parentage` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-adf-conversion` | yes | imports the built converter and asserts against it in process; no live daemon, no herdr, no credential, no network, no terminal. |
| `verify-adf-identifier-survives` | yes | imports the built converter and asserts against it in process; no live daemon, no herdr, no credential, no network, no terminal. |
| `verify-adf-jira-mark-combinations` | yes | imports the built converter and asserts against it in process; no live daemon, no herdr, no credential, no network, no terminal. |
| `verify-adf-refusal-names-the-construct` | yes | `explainProxyFailure` is a pure function from a status and a payload to a sentence, and it is called here directly; no live daemon, no herdr, no credential, no network, no terminal. |
| `verify-adopted-pane-supervision` | yes | imports the built daemon modules and drives them in process, plus one source-text section; no live daemon, no herdr, no credential, no peer, no terminal, no real CrabCast socket (section 5 speaks CrabCast's wire protocol to a fake peer on a unix socket in a temp dir). |
| `verify-agent-capacity` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. Every section that ASSERTS derives from stated facts, so no verdict here moves with the load, the disk pressure or the free memory of the host. |
| `verify-agent-connection-identity` | yes | it STARTS A REAL DAEMON from a copy of the build, plus a real `dist/mcp.js`, both isolated by a temp $HOME; no herdr, no credential, no peer, no terminal. This line read "no live daemon" until KAN-574 and that was wrong from the day it was written — §1 has always spawned `dist/daemon.js`, and the paragraph below about isolation-by-$HOME describes the daemon it spawns. The class is unchanged and correct: CI runs this and it passes. What was wrong was the REASON, which is the half `ci-partition.md` copies, so a reader deciding whether a change needs a live daemon was being told the opposite of the truth by a generated file. |
| `verify-agent-name-brands-have-one-home` | yes | reads `daemon/src/**/*.ts` as TEXT and asserts against it in process. No build, no `dist`, no live daemon, no herdr, no credential, no peer, no terminal, no network, and it writes nothing: the red-drive flags rewrite an in-memory copy of the source rather than the tree. |
| `verify-agent-name-fits-herdr` | yes | imports `daemon/dist` and reads `daemon/src` as text, both in process. No live daemon, no herdr, no credential, no network, no terminal, no peer, and it writes nothing outside memory. §1-§3 exercise pure exported functions (`agentNameProblem`, `assertAgentNameFitsHerdr`, `computeBoardDiff`); §4 and §5 read the tree; none of them spawns anything. §6 DOES shell out to herdr and is therefore behind `--against-herdr`, which CI never passes and which is not a default: without the flag it prints SKIP and asserts nothing, so the classification above is a claim about the run CI performs. |
| `verify-agent-power-controls` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-agent-preemption` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-agent-resumption` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-agent-runtime-seam` | yes | reads files off the checkout and asserts on their contents; node builtins only. |
| `verify-ambiguous-key-refusal` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-approval-recorded` | yes | drives `lib/approval-marker.mjs` over fixtures in process, and drives `check-approval-recorded.mjs` as a child against a stub GitHub API bound to 127.0.0.1. No herdr, no live daemon, no credential, no peer, no terminal, and no egress: the only socket it opens is its own loopback stub. |
| `verify-atlassian-proxy-failure-is-loud` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-atlassian-proxy-off-is-not-broken` | yes | no network, no herdr, no credential of yours, no terminal. Sections 3a/3b spawn a real daemon and a real `mcp.ts` under a temporary $HOME that did not exist a moment ago. |
| `verify-atlassian-proxy-read-surface` | yes | imports the built daemon modules and asserts against them in process, and reads `atlassian-proxy.ts` and `router.ts` off the checkout; no live daemon, no herdr, no credential, no peer, no terminal, no network. The half that needs real Atlassian is deliberately not here — it is `probe-atlassian-proxy-read-surface.mjs`, which is a `probe-` precisely because CI cannot run it. |
| `verify-atlassian-proxy-scope` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-atlassian-proxy-write-scope` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-atlassian-server-retired` | yes | no daemon, no network, no herdr, no real credential. The gate under test reads `process.env.BUTCHR_ATLASSIAN_PROXY` at call time, so every rung is exercised in-process by setting it and running the real registry and the real writer. |
| `verify-board-asked-is-not-stopped` | yes | imports the built `board-reconcile.js` and drives it with in-process stubs. It points `HOME` at a temp dir and touches nothing else: no herdr, no CrabCast, no PTY, no network, no Jira, no wall clock. |
| `verify-board-reconciler-guard` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-brief-location` | yes | §1 and §2 read `daemon/src/*.ts` as text; §3 and §4 import the built daemon modules and call them over values this script constructs. It needs no peer, no herdr, no PTY, no credential and no network, and it writes nothing. The `--static-only` flag below is for a human running this against a build that just failed, not for CI, which builds first. |
| `verify-cap-claims-match-the-chain` | yes | imports the built daemon modules, reads source files off the checkout, and builds its red-drive fixtures in memory. No live daemon, no herdr, no credential, no peer, no terminal, no network. |
| `verify-channel-capability-refusal` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. Its sockets are unix sockets it creates under os.tmpdir(), and the one piece of shared state it touches — the channel kill switch under BUTCHR_DIR — it reads, overwrites and restores in a `finally`, which the CI runner sandboxes per child anyway. |
| `verify-channel-client-reach` | yes | imports the built daemon modules and asserts against them in process, over unix sockets and child processes it creates under os.tmpdir(); no live daemon, no herdr, no credential, no peer, no terminal, and nothing read from the fleet. EVERY section runs on a runner, so there is no skip tally and no way to report a green that a section did not earn. |
| `verify-channel-emission-gate` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-channel-launch-flag` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-channel-liveness` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-channel-meta-renderable` | yes | reads `daemon/src` as text and imports the built daemon modules in process, under a private $HOME in os.tmpdir(). No live daemon, no herdr, no credential, no peer, no terminal, no network. |
| `verify-channel-registration-loss` | yes | sections 1 and 2 import the built daemon modules and assert against them in process. Section 3 STARTS TWO REAL DAEMONS from the built dist, SIGKILLs the first, and spawns a real dist/mcp.js as the surviving agent, all under a private $HOME in os.tmpdir(); it needs no herdr, no credential, no peer, no terminal and no network, which is what makes it unattended-runnable. It is not, and never was, a "no live daemon" script — that clause was carried here by the shared boilerplate and was simply false, contradicting this file's own header four lines up (KAN-309; the general case is KAN-308's). Because it runs real processes it is subject to scheduling, so the one observation whose window a fast machine can close — the identity map immediately after a restart — is taken with the agent SIGSTOPped rather than by winning a race for it. |
| `verify-channel-selfcheck` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-channel-spawn-verdict` | yes | imports the built daemon modules, stages its own $HOME and its own unix socket in temporary directories, and needs no herdr, no pty, no network and no CrabCast. Section 3 creates and removes two probe workspaces under the workspaces root, per path and never by reverting a directory. |
| `verify-channel-startup-supervision` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-ci-partition-conflict-recipe` | yes | builds a repository-shaped fixture under `os.tmpdir()` from the files of this checkout, drives `git` on it, and spawns the generator and the enforcement guard as node children; node builtins and the `git` binary only, no build, no `npm install`, no daemon, no herdr, no credential, no network, no wall clock. |
| `verify-ci-partition-is-enforced` | yes | builds its fixtures in a temporary directory, reads `ci.yml` and the script headers off the checkout, and spawns the generator's own `--markdown` mode as a node child; node builtins only, no build, no daemon, no herdr, no credential, no network. |
| `verify-ci-set-guards-tree-writes` | yes | it builds a throwaway git repository under `os.tmpdir()` and spawns the copied runner in it. No live daemon, no herdr, no credential, no peer, no terminal, no network; the only external binary is `git`, which the checkout already requires. It does not run this repository's own verify set, so it does not run the set from inside the set. |
| `verify-clip-recipes-are-executable` | yes | imports the built modules in process and reads two captured fixtures; no live daemon, no herdr, no credential, no peer, no terminal, no network. |
| `verify-confirm-present-joins-on-path` | yes | it stands up its own Unix socket and answers its own frames from a committed capture. No live peer, no herdr, no PTY, no credential, no network. |
| `verify-confluence-workspaces` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-cost-estimate-plausibility` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-cpu-headroom-gate` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-crabcast-channel-startup-supervision` | yes | reads `daemon/src/*.ts` as TEXT and asserts against them in process; no build, no live daemon, no herdr, no credential, no peer, no terminal, no CrabCast socket. |
| `verify-crabcast-reconnect-resync` | yes | stands up its own Unix socket and answers its own frames in process; no live daemon, no herdr, no PTY, no credential, no peer, no network. It writes nothing to disk outside os.tmpdir(). |
| `verify-crabcast-runtime-switch` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-cross-type-activation` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-cutover-health-predicate` | yes | node builtins only, no build, no daemon, no herdr, no credential, no peer, no terminal, no network. Every frame is a literal in this file or a recorded line quoted in it. §5 spawns cutover-health.mjs as a child node process and writes its frames under os.tmpdir(), never into the repository, then removes them. |
| `verify-cutover-reap-verdict` | yes | node builtins only, no build, no daemon, no herdr, no credential, no peer, no terminal, no network. §3 and §5 create a temporary unix socket and a temporary directory tree under `os.tmpdir()`, never inside the repository, and remove both. §3 additionally spawns two short-lived node children as positive controls — one held open and killed in a `finally`, one that prints a reading and exits — and §5 spawns the reaper three times. Every child is `process.execPath` and every path is under `os.tmpdir()`. |
| `verify-cutover-sequence` | yes | reads `docs/*.md`, `daemon/src/*.ts` and `daemon/scripts/install-service.sh` off the checkout as text and asserts on their contents; node builtins only, no build, no daemon, no herdr, no credential, no peer, no terminal, no network. |
| `verify-daemon-log-is-greppable` | yes | builds its fixtures in a temp directory and asserts against the built daemon modules in process. No live daemon, no herdr, no credential, no peer, no terminal, no network. |
| `verify-declared-approver-parity` | yes | it imports the built daemon module and the `.mjs` library and compares them in process; no network, no credential, no `gh`, no daemon. |
| `verify-dep-linking-covers-every-repo-shape` | yes | builds every fixture in a temporary directory, runs `npm ci` only against a hand-written zero-dependency lockfile (no network), and reads `prompts/task.md` off the checkout. Node builtins plus `npm` and `cp`. |
| `verify-diagnostic-evidence-visible` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no network, no terminal. Section 5 additionally shells out to the repo's own `tsc`, as verify-absence-is-not-intent.mjs §5 does. |
| `verify-doc-constant-pins` | yes | reads `docs/*.md` and `daemon/src/*.ts` off the checkout as text and asserts on their contents; node builtins only, no build, no daemon, no herdr, no credential, no peer, no terminal, no network. |
| `verify-effective-ceiling` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-env-knobs-documented` | yes | reads `daemon/src/**/*.ts` and `docs/env-knobs.md` off the checkout and matches regexes; node builtins only, no build, no daemon, no herdr, no credential, no network, no terminal, no wall clock. |
| `verify-exit-path-classifier` | yes | writes fixture trees under `os.tmpdir()` and runs the shipped sweep against them as a child process. Node builtins only: no build, no daemon, no herdr, no credential, no network, no terminal. |
| `verify-exit-path-containment` | yes | writes fixture trees under `os.tmpdir()` and runs the shipped sweep against them as a child process. Node builtins only: no build, no daemon, no herdr, no credential, no network, no terminal. |
| `verify-exit-path-skip-consultation` | yes | writes fixture trees under `os.tmpdir()` and runs the shipped sweep against them as a child process. Node builtins only: no build, no daemon, no herdr, no credential, no network, no terminal. |
| `verify-failure-excerpt-names-the-assertion` | yes | KAN-576. Pure arithmetic over strings, plus one fixture repository built in a temp directory. Needs no daemon, no herdr and no peer. |
| `verify-gate-register-schema` | yes | reads Markdown off the checkout and matches on it. No build, no `npm install`, no daemon, no herdr, no PTY, no network, no credential, no peer, no wall clock. It imports only node builtins. |
| `verify-guardian-board-display` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-guardian-poke` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-herdr-channel-reach-per-agent` | yes | imports the built daemon modules and asserts against them in process, over unix sockets it creates under os.tmpdir(); no live daemon, no herdr, no credential, no peer, no terminal. EVERY section runs on a runner, which is why this is `yes` rather than `partial` and why it tallies no skips: the real-spawn proof is a separate file, `verify-herdr-channel-reach-live.mjs`, and a green here has never claimed anything about it. |
| `verify-herdr-spawn-argv` | yes | reads `daemon/src/*.ts` as TEXT and imports the built daemon's `herdr-health.js`. No herdr binary, no server, no pane, no PTY. |
| `verify-idle-fleet-capacity` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. Section 1 reads this machine's real /proc for its machine facts and says so. |
| `verify-integration-enablement` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-integration-pluggability` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-io-stall-gate` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-jira-comment-window` | yes | imports the built daemon modules and drives the real JiraPoller, JiraPollState and snapshotFrom. No network, no panes, no Jira. |
| `verify-jira-credential-diagnostics` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-jira-log-hygiene` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-jira-parent-topology` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-jira-poller-nudges` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-jira-self-echo-suppression` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-jira-storage-disclosure` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-launchdarkly-proxy-failure-is-loud` | yes | spawns the built daemon and mcp server against a loopback stub under a temporary $HOME; no herdr, no real credential, no peer, no terminal, no network beyond 127.0.0.1. |
| `verify-launchdarkly-proxy-scope` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-launcher-table-is-claude-only` | yes | imports the built daemon modules, stages its own $HOME and a fake `herdr` first on PATH, and reads four repository files as text. No live daemon, no real herdr, no pty, no CrabCast peer, no credential, no network. Everything it writes is under `os.tmpdir()`. |
| `verify-ld-credential-diagnostics` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-ld-log-hygiene` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-ld-storage-disclosure` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-list-agents-answer-is-bounded` | yes | reads a captured census fixture and imports the built budget module in process; no live daemon, no herdr, no credential, no peer, no terminal, no network. |
| `verify-list-agents-survives-restart` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-mcp-server-build-staleness` | yes | no live daemon, no herdr, no credential, no network. It spawns the built `dist/mcp.js` against a stub socket in a temp HOME, and drives the real registry and the real staleness report in process. |
| `verify-message-provenance` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-missing-agent-name-vs-agent` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-mjs-stub-arity-matches-seam` | yes | reads `daemon/src/agent-runtime.ts` and the `.mjs` files as TEXT; no build, no socket, no peer, no credential, no network. Unaffected by a failed build, so its verdict is about what you wrote rather than what last compiled. |
| `verify-never-clipped-exemption-is-bounded` | yes | imports the built module in process and reads one source file as text. No live daemon, no herdr, no credential, no peer, no terminal, no network. |
| `verify-no-build-output-is-committed` | yes | reads `git ls-files` off the checkout and the bytes of the files it names, and builds its fixtures under `os.tmpdir()`; node builtins and `git` only, no build, no daemon, no herdr, no credential, no peer, no network, no terminal, no wall clock. |
| `verify-notifications-never-type` | yes | imports the built daemon modules and asserts against them in process, over Unix sockets it creates under a private $HOME in os.tmpdir(); no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-nudge-refuses-a-dialog-pane` | yes | imports the built daemon modules and drives the real `awaitAgentReadiness` and `nudgeResumedAgent` against a scripted runtime stub. No live daemon, no herdr, no terminal, no network, no credential, no Jira. It spends real monotonic time, deliberately and about a second of it: every call passes a `ReadinessBudget` shortening the 120s budget to tens of milliseconds. KAN-543 added that seam for this script, and it is why the parked branch is watchable at all. The CLOCK is not part of the seam — see §6, and see `ReadinessBudget`'s docblock for the invariant that decided it. |
| `verify-off-button-honesty` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-operative-rules-are-carried` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-parentage-in-list-agents` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-per-epic-supervision` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-pr-watch-checkout-provenance` | yes | imports the built daemon module and asserts against it in process, over a tree it builds in os.tmpdir(); no live daemon, no herdr, no credential, no network, no terminal. Nothing is written inside the repository. |
| `verify-pr-watch-notice-tense` | yes | imports the built daemon modules and asserts against them in process, over a workspace tree it builds under a private $HOME in os.tmpdir(); no live daemon, no herdr, no credential, no peer, no terminal and no network (the GitHub reader is stubbed). Every clock is injected, so nothing here reads the wall clock and nothing is timing-dependent. |
| `verify-pr-watch-readiness` | yes | imports the built daemon modules and asserts in process, with no live daemon, no herdr, no credential, no network and no terminal. §1 replays a RECORDED fixture; §2-§5 stub the GitHub reader. |
| `verify-pr-watch-repo-retention` | yes | imports the built daemon modules and asserts against them in process, over a workspace tree it builds under a private $HOME in os.tmpdir(); no live daemon, no herdr, no credential, no peer, no terminal and no network (the GitHub reader is stubbed). Nothing is written inside the repository. |
| `verify-pr-watch` | yes | imports the built daemon modules and asserts against them in process, over Unix sockets it creates under a private $HOME in os.tmpdir(); no live daemon, no herdr, no credential, no peer, no terminal, and no network (§1 replays RECORDED `gh` output; §2-6 stub the reader). |
| `verify-prompt-poller-seam` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-prompt-provenance-stamp` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-prompt-source-is-fetched-ref` | yes | builds scratch git repositories under `os.tmpdir()` and imports the built daemon modules in process; git and node builtins only, no live daemon, no herdr, no credential, no peer, no terminal, no network. |
| `verify-pty-write-refusal-is-read` | yes | imports the built daemon modules and serves its own CrabCast over a unix socket in a temp dir; node builtins only, no live daemon, no herdr, no credential, no network, no terminal. |
| `verify-reclaim-bytes-are-freed-bytes` | yes | imports the built daemon module and builds its own filesystem fixture on tmpfs; no live daemon, no herdr, no credential, no peer, no terminal, no network. |
| `verify-resumed-conversation-nudge` | yes | imports the built daemon modules, stands up its own unix socket in a temporary directory, and needs no herdr, no pty, no network, no credential and no CrabCast. Sections 3 and 4 create and remove probe workspaces under the workspaces root, per path and never by reverting a directory. |
| `verify-runtime-agnostic-census` | yes | imports the built daemon modules, stands a fake CrabCast peer on a Unix socket in a scratch $HOME, and asserts in process. No live daemon, no real CrabCast, no herdr, no credential, no terminal. |
| `verify-runtime-pin-spares-test-daemons` | yes | it brings its own `systemctl` on PATH, so the installed unit that this defect needs is simulated rather than required, and the sections run identically on a runner and on a developer machine. That is the point rather than a convenience: the defect was invisible to CI *by construction*, and a proof that needed the unit to be really installed would have inherited exactly that blindness. |
| `verify-same-key-other-type` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-search-keeps-every-issue` | yes | imports the built modules in process and reads one captured fixture; no live daemon, no herdr, no credential, no peer, no terminal, no network. |
| `verify-selfcheck-rechecks-replaced-connection` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. §4 opens a Unix socket inside its own scratch directory. |
| `verify-selfcheck-verdict-outlives-connection` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-send-claims-not-collapsed` | yes | it imports the built daemon modules and drives the real MessageRouter in-process. No terminal, no socket, no network, no `claude`. |
| `verify-staleness-check` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. It does `git clone` this checkout into a scratch directory and then `checkout -B main origin/main` inside the clone, so the checkout it runs from needs a **local** `main` branch — a clone resolves `origin/*` from the local branches of its source, and `actions/checkout` leaves a detached HEAD with none. The `verify-runnable-set` job creates one; see the comment there. |
| `verify-staleness-over-socket` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. It does `git clone` this checkout into a scratch directory and then `checkout -B main origin/main` inside the clone, so the checkout it runs from needs a **local** `main` branch — a clone resolves `origin/*` from the local branches of its source, and `actions/checkout` leaves a detached HEAD with none. The `verify-runnable-set` job creates one; see the comment there. |
| `verify-standdown-and-override-cross-the-seam` | yes | imports the built daemon modules and asserts against them in process. Sections 3 and 4 stand up a fake CrabCast on a unix socket in a temp dir; no live daemon, no real peer, no herdr, no credential, no terminal. |
| `verify-standdown-answers-name-their-rows` | yes | builds its fixture under `os.tmpdir()`, serves a fake CrabCast over a unix socket it creates itself, and points `HOME` at that temp tree so `workspacesRoot()` resolves inside it. It imports from `daemon/dist`, so it needs the build and nothing else: no herdr, no PTY, no network, no Jira, no wall clock, no live peer. |
| `verify-standdown-ask-streak-is-visible` | yes | imports the built `board-reconcile.js` and drives it with in-process stubs. Points `HOME` at a temp dir and touches nothing else: no herdr, no CrabCast, no PTY, no network, no Jira, no wall clock. |
| `verify-standdown-reaches-sessionless-agent` | yes | every section stands up its own Unix socket under os.tmpdir() and answers its own frames, and §7's first arm additionally reads daemon/src/board-reconcile.ts as text out of the checkout, which CI has; no peer, no herdr, no PTY, no credential, no network, and nothing is skipped, so a green is a green. |
| `verify-standdown-survives-degraded-activation` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-startup-admission` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-startup-dialog-discrimination` | yes | imports the built daemon modules and drives the real `superviseChannelStartup` on a virtual clock. No live daemon, no herdr, no terminal, no credential. |
| `verify-status-change-nudges` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-supervision-key-spelling` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-tail-asks-every-source` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-tail-async-awaited` | yes | imports the built daemon modules and reads `daemon/src` off the checkout; the only herdr is a shim this file writes onto PATH. No live daemon, no real herdr, no credential, no peer, no terminal, no network. |
| `verify-task-agent-write-list` | yes | every section reads repository files as TEXT and asserts in process; no live daemon, no herdr, no credential, no peer, no terminal, no network. |
| `verify-working-agent-cost` | yes | every section drives pure exported functions over hand-built fixtures. No /proc, no herdr, no daemon, no fleet. That is deliberate and it is the same argument aggregateTrees carries: CI runs on a box with no agents on it, so a proof that could only measure a live fleet would assert nothing there and go green on an empty sample. |
| `verify-workspace-deps-are-shared` | yes | reads files off the checkout and asserts on their contents; node builtins only. |
| `verify-workspace-mcp-preparation` | yes | reads `daemon/src/*.ts` as TEXT and imports `daemon/dist/launchers.js` in process. No live daemon, no herdr, no CrabCast peer, no credential, no terminal. §6 writes one file, under `os.tmpdir()` and never into the repository tree. |
| `verify-workspace-reclaim` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-workspace-reset-boundary` | yes | imports the built daemon modules, builds every fixture inside a temporary directory it creates and removes, and reads three source files off the checkout; no live daemon, no herdr, no CrabCast, no credential, no network, no terminal. |
| `verify-agent-tree` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-render-writes-outside-the-tree` | yes | it spawns `verify-agent-tree.mjs`, which needs only the extension's own node_modules and its own vite build; no live daemon, no herdr, no credential, no peer, no terminal. It runs the real script with the real argv the runner gives it, so what is under test is the shipped default and not a path this file constructs. |

## `partial` — runs in CI and asserts a real subset — named sections need something CI has not got

| script | class | reason |
| --- | --- | --- |
| `verify-brief-staleness-check-is-depth-robust` | partial | §1-§5 build their own git repositories under a temp dir and need nothing but `git` and node: no network, no shared clone, no build. §6 imports daemon/dist and SKIPS loudly on a runner that has not built. |
| `verify-capacity-runtime-override` | partial | sections 2 to 8 need nothing but a build and a temp directory, so they run anywhere. Section 1, the unfixed baseline that makes the rest mean anything, needs a second dist built from origin/main's capacity.ts and is SKIPPED with a note when one is not supplied. A skipped section is reported as skipped and never counted as a pass, so a CI run cannot read as though the red had been demonstrated. The red itself is in the PR body, run by hand with the commands in the Usage block below. |
| `verify-crabcast-adopt-launcher-vocabulary` | partial | §1-§5 assert in CI. They read source as text and stand up their own Unix socket under os.tmpdir(); they need no peer, no herdr, no PTY, no credential and no network. §6 needs a live CrabCast daemon and SKIPS without one. A skip is printed as a skip and never counted as a pass. |
| `verify-crabcast-census-disclosure` | partial | sections 1-7 assert in CI. They stand up their own Unix socket and a fake `herdr` on PATH, and need no peer, no real herdr, no PTY, no credential and no network. Section 8 needs a live CrabCast daemon and SKIPS without one; a skip is printed as a skip and never counted as a pass. |
| `verify-crabcast-mcp-residue-cleared` | partial | §1 and §2 read `daemon/src/*.ts` as text and assert in full. §3–§8 drive CrabCast's REAL `provisionMcpConfig` out of the peer checkout at ~/code/wroosbit/crabcast, which CI has not got, so they announce themselves SKIPPED there and the process exits 2 (INCOMPLETE) rather than 0. They are not mocked: this proof's whole value is that the refusal is theirs. Note the skip is reachable ONLY when the checkout is absent — one that is present but dirty, behind CRABCAST_PIN, or serving a stale dist FAILS instead. |
| `verify-crabcast-priority-roundtrip` | partial | §1–§4 read `daemon/src/*.ts` as TEXT and §5 imports `daemon/dist`, and all five assert in full on a runner. §6 and §7 need a LIVE CrabCast daemon on this machine's socket, which CI has not got, so they announce themselves SKIPPED there. They are not mocked and there is no fallback: the whole value of §6 is that the echo is CrabCast's, so a reproduction of it would prove nothing. The skip is reachable ONLY when the socket is absent — a socket that is present and refuses FAILS instead. (KAN-482) |
| `verify-crabcast-session-restore` | partial | sections 1-4 assert in CI. They stand up their own Unix socket and their own agent registry under os.tmpdir(), and need no peer, no herdr, no PTY, no credential and no network. Section 5 needs a live CrabCast daemon and SKIPS without one; a skip is printed as a skip and never counted as a pass. |
| `verify-crabcast-standing` | partial | sections 1-5 assert in CI. They import the built daemon modules and run over frames this script constructs and two committed captures, and need no peer, no herdr, no PTY, no credential and no network. Section 6 reads a live CrabCast socket and SKIPS without one; a skip is printed as a skip and never counted as a pass. |
| `verify-crabcast-supervisor-exemption` | partial | §1–§4 read `daemon/src/*.ts` as TEXT and §5 imports `daemon/dist`, and all five assert in full on a runner. §6–§8 need a LIVE CrabCast daemon on this machine's socket, which CI has not got, so they announce themselves SKIPPED there. They are not mocked: the whole value of §6 is that the echo is CrabCast's and of §7 that the refusal is CrabCast's gate, so a reproduction would prove nothing. The skip is reachable ONLY when the socket is absent — a socket that is present and refuses FAILS instead. |
| `verify-create-issue-staffable` | partial | sections 2-6 assert against the built modules in process, so CI runs them: no daemon, no credential, no network. Section 1, the pre-fix build that makes the rest mean something, needs a `dist` built from the merge base and is SKIPPED (loudly) without one, which is what CI reaches. A run that skips it says so in its verdict rather than reporting a clean sweep. |
| `verify-daemon-decisions-reach-journal` | partial | §3 is pure and needs nothing at all. §1 imports the built gate; §2 and §4 additionally spawn real node processes against a temp `HOME`; all three SKIP without a build. §5 needs a reachable `systemctl --user` and a `journalctl` and SKIPS on a runner, which makes this script exit 2 there rather than 0 (KAN-373's contract). `run-ci-verify-set.mjs` builds first, so §1, §2 and §4 execute there. |
| `verify-daemon-provenance-is-loud` | partial | §1-§4 are pure and need nothing. §6 and §7 need `daemon/dist` and spawn real node processes with a stubbed `systemctl`; they SKIP without a build. §5 needs a reachable `systemctl --user` and SKIPS on a runner, which makes this script exit 2 there rather than 0 (KAN-373's contract). `run-ci-verify-set.mjs` builds first, so §6 and §7 execute there. |
| `verify-jira-nudge-coalescing` | partial | the coalescing assertions run in CI. The CONTROL leg needs an `--unfixed` build to show the defect it prevents, and AC3d needs `--live`; both are skipped without them and both are named in the run output. |
| `verify-mcp-runtime-validation` | partial | sections 2 onward run in CI. Section 1 — the red — needs an unfixed dist built from `origin/main` and is skipped without one, which the script prints. |
| `verify-pr-watch-approver-routing` | partial | §2-§6 run anywhere: the GitHub reader is a stub, the fleet is invented, and there is no network, no `gh`, no credential and no terminal. §1, the red drive, needs a second `dist` built from `origin/main` and is SKIPPED — loudly, and saying that its absence makes the run no evidence that the defect existed. The recipe is below and its output is pasted in the pull request. |
| `verify-prompt-write-refusal` | partial | the refusal itself is asserted in CI. Section 1, the silent uninstructed start that makes the refusal meaningful, needs a dist built from `origin/main` and is skipped without one. |
| `verify-pty-init-rejects-unknown-session` | partial | the rejection path asserts in CI. The regression stage needs herdr to start a real agent and prints `SKIPPED: no herdr to start an agent with` instead. |
| `verify-setup-shell-portability` | partial | §1–§3 read `docs/SETUP.md` as TEXT and assert in full on any runner: they parse its fenced `bash` blocks, refuse a bare `$?` outside a `bash -c` wrapper, and prove the detector fires on a synthetic hazard it was never told about. Node builtins only — no build, no daemon, no herdr, no credential, no network, no wall clock. §4 runs the hazard against a REAL `fish` to show that a single parse unit is refused ENTIRE -- the command before the `$?` does not run either; a runner without `fish` on PATH announces that section SKIPPED, and a skip is printed as a skip and never counted as a pass. It is not mocked: the whole value of §4 is that the parse error is fish's own. §5 does the same for FILE mode — it writes a four-step fixture with a `$?` on line 3 and shows that none of the four ran, steps 1 and 2 above it included — and skips identically. |
| `verify-shared-clone-is-not-grafted` | partial | sections 1 and 2 build their own git repositories in a temp dir and need nothing but `git`, node and a built `dist`, so they assert in full on a runner. Section 3 classifies the real shared clone at ~/code/wroosbit/butchr, which no CI runner has; it skips loudly and does not fail, and it is the only section that observes a clone this script did not create. |
| `verify-skip-is-not-a-pass` | partial | §1 and §2 need no peer, no herdr, no PTY, no credential and no network; they read this repository's own helper and spawn `node`. §3 needs `daemon/dist` and SKIPS without it, which makes THIS script exit 2 rather than 0 — the contract under test applied to itself, and deliberate. `run-ci-verify-set.mjs` builds before it runs, so §3 executes there; the `verify-script-sweep` job does not build, and that step passes `--allow-skipped` to say so out loud. |
| `verify-supervisor-cost-exclusion` | partial | the exclusion arithmetic (1-4), the enablement predicate (5b), the unmarked-tree discriminator (5c) and the falsifier (6) all assert in CI. Section 5 reads the live fleet through /proc and is skipped on a runner, which has no agent trees. KAN-537 is why its unmarked arm no longer fails on a tree that holds no MCP server at all. |
| `verify-unstaffable-covers-every-door` | partial | sections 1-5 run in process against the built modules and section 3 shells the repo's own tsc: no daemon, no credential, no network, so CI reaches all five. Section 6 files real Jira tickets through a door that is NOT this daemon's proxy, which is the only thing that can demonstrate the acceptance criterion, and it is SKIPPED (loudly) without `--live`. A run that skips it says so in its verdict rather than reporting a clean sweep. |
| `verify-unstaffable-report-names-its-query` | partial | sections 1, 2 and 5 run in process against this repo's own build and its own tsc (no daemon, no credential, no network), while sections 3 and 4 need a SECOND build to read — a `dist` from another commit, named with `--against-build <dir>` — and are SKIPPED (loudly, and tallied) without one, because the acceptance criterion is a comparison between two builds and one build cannot make it. |

## `quarantined` — CI-runnable but currently RED — excluded loudly, with a reason and a ticket

| script | class | reason |
| --- | --- | --- |
| `verify-board-key-spelling` | quarantined | CI-runnable (0.3 s, build only) but RED as of KAN-295. Two assertions pin log wording that KAN-221/KAN-256 have since changed: §3 requires the literal `have KAN-501 In Progress`, and §5 selects its line with `.find(l => l.includes("stood down"))`, which now matches the KAN-256 no-assignee diagnostic instead of the stand-down it means. The property under test still holds — the correctly spelled `task/KAN-500` line is in the same output. Rot, not regression. Owned by KAN-300. |
| `verify-mcp-assembly` | quarantined | CI-runnable (0.1 s, build only) but RED as of KAN-295. It crashes with a TypeError in a diagnostic `console.log` when no `atlassian` entry is written — the no-credential case, which is CI. Its own verdict below that line was written to handle exactly that case, so the assertion is fine and the logging above it is not. Rot, not regression. Owned by KAN-300. |
| `verify-rule-inventory-catches-dropped-entry` | quarantined | CI-runnable (5.6 s, git + node) but RED as of KAN-295. Its `--baseline` defaults to `origin/main` — "the version this PR changes", which stopped being true the moment KAN-241 merged — so the three `BEFORE is GREEN` legs now fail because the baseline already carries the fix. Every `AFTER CATCHES it` leg passes. A pinning defect of the kind this repository already knows about; rot, not regression. Owned by KAN-300. |

## `no` — cannot run unattended in CI

| script | class | reason |
| --- | --- | --- |
| `verify-activate-verified-existence` | no | shells out to `which herdr` and activates a real agent through it; it throws outright when herdr is not on PATH. |
| `verify-capacity-survives-daemon-restart` | no | starts a real daemon and then warms up for 780 s across 13 cost windows so the estimate can walk down off its seed. Both the daemon and the wall clock put it out of reach of a per-PR check. |
| `verify-comment-authorship-live` | no | checks comment ids against the live Jira API and needs a real Atlassian credential; without one it correctly reports that it is not evidence of anything. |
| `verify-crabcast-brief-reachable-live` | no | it needs a live CrabCast daemon on a Unix socket, room in that daemon's capacity gate for one more agent, and it starts a real `claude` process that spends real tokens. `verify-brief-location.mjs` is the offline half of the same claim and does run in CI. |
| `verify-crabcast-claude-launcher-live` | no | needs a real CrabCast daemon, real capacity for one more agent, and it starts a real `claude` process that spends real tokens. |
| `verify-crabcast-confirm-present-name-join` | no | needs a real CrabCast daemon at `BUTCHR_CRABCAST_SOCKET` (or the default socket path) and it spawns a real `claude` agent. It attempts nothing without one. Its output goes on the pull request. |
| `verify-crabcast-peer-restart-live` | no | needs the `crabcast` binary, a real herdr and a real pty. It asserts nothing without them. |
| `verify-crabcast-reconnect-live` | no | needs a real CrabCast daemon at `BUTCHR_CRABCAST_SOCKET`, a real herdr and a real pty; it attempts nothing without one. |
| `verify-crabcast-rude-death-live` | no | needs the `crabcast` binary on PATH. Every setup failure prints "setup:" and asserts nothing; none may be read as a red against KAN-456. |
| `verify-crabcast-runtime-live` | no | needs a real CrabCast daemon at `BUTCHR_CRABCAST_SOCKET`; it attempts nothing without one. |
| `verify-crabcast-second-activation-resumes` | no | needs a real CrabCast daemon, real capacity for one agent, and it starts a real `claude` process that spends real tokens. |
| `verify-fleet-switch-live` | no | starts a real daemon from a built dist and needs herdr to spawn the fleet whose runtime it switches. |
| `verify-herdr-channel-reach-live` | no | it needs a real herdr on PATH, spawns two real `claude` panes and writes the fleet's own channel kill switch. None of those exist on a runner, and none of them can be mocked without destroying the only thing this script is for: that the `AgentSpawn` is the product's rather than one a harness built. |
| `verify-message-provenance-live` | no | needs a real daemon, herdr, a pane and a live Claude Code agent — the provenance it checks is what a model actually received. |
| `verify-no-attach-steal` | no | takes the key of a live agent as its argument and attaches to it; there is nothing to pass in CI. |
| `verify-pretrust-survives-concurrency` | no | every stage needs a real spawn, and it refuses to run at all when herdr is absent rather than pretending otherwise. |
| `verify-restart-channel-recovery` | no | its evidence is this machine's live ~/.local/share/butchr/ daemon.log, which records real restarts of a real fleet. A CI runner has no daemon, no fleet and no such file, so there is nothing for it to read and nothing it could conclude. It exits 2 (setup, not verdict) when the log is absent, so a CI run that reached it anyway would report "could not check" rather than a green. |
| `verify-send-interrupts-inflight-work` | no | needs a real daemon and a live agent with a tool call actually in flight — the interrupt is the thing under test. |
| `verify-send-transport-claims` | no | the switch-off and stop-now legs spawn herdr, and it counts their absence as failures rather than skipping them, so it is red in CI by its own honest design. |
| `verify-spawn-failure-legibility` | no | stands up a private herdr server and makes real spawns fail against it. |
| `verify-tab-per-agent` | no | spawns herdr directly to inspect how panes and tabs are allocated. |
| `verify-tail-source-boundary-live` | no | needs a real herdr server and a terminal; it says so and stops when there is neither. |
| `verify-sidepanel-survives-daemon-restart` | no | needs a real daemon, herdr and a loaded extension side panel driving it. |

