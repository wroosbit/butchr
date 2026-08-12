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
| `yes` | 67 |
| `partial` | 6 |
| `quarantined` | 3 |
| `no` | 14 |
| **total** | **90** |

**73 of 90** run on every pull request.

## `yes` — runs in CI; every section asserts

| script | class | reason |
| --- | --- | --- |
| `verify-absence-attribution` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-absence-is-not-intent` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. Section 5 additionally shells out to the repo's own `tsc`. |
| `verify-activate-requires-agent` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-activation-records-real-parentage` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-adf-conversion` | yes | imports the built converter and asserts against it in process; no live daemon, no herdr, no credential, no network, no terminal. |
| `verify-agent-capacity` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. Every section that ASSERTS derives from stated facts, so no verdict here moves with the load, the disk pressure or the free memory of the host. |
| `verify-agent-connection-identity` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-agent-power-controls` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-agent-preemption` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-agent-resumption` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-agent-runtime-seam` | yes | reads files off the checkout and asserts on their contents; node builtins only. |
| `verify-approval-recorded` | yes | drives `lib/approval-marker.mjs` over fixtures in process, and drives `check-approval-recorded.mjs` as a child against a stub GitHub API bound to 127.0.0.1. No herdr, no live daemon, no credential, no peer, no terminal, and no egress: the only socket it opens is its own loopback stub. |
| `verify-atlassian-proxy-failure-is-loud` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-atlassian-proxy-read-surface` | yes | imports the built daemon modules and asserts against them in process, and reads `atlassian-proxy.ts` and `router.ts` off the checkout; no live daemon, no herdr, no credential, no peer, no terminal, no network. The half that needs real Atlassian is deliberately not here — it is `probe-atlassian-proxy-read-surface.mjs`, which is a `probe-` precisely because CI cannot run it. |
| `verify-atlassian-proxy-scope` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-atlassian-proxy-write-scope` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-board-reconciler-guard` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-channel-emission-gate` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-channel-launch-flag` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-channel-liveness` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-channel-meta-renderable` | yes | reads `daemon/src` as text and imports the built daemon modules in process, under a private $HOME in os.tmpdir(). No live daemon, no herdr, no credential, no peer, no terminal, no network. |
| `verify-channel-registration-loss` | yes | sections 1 and 2 import the built daemon modules and assert against them in process. Section 3 STARTS TWO REAL DAEMONS from the built dist, SIGKILLs the first, and spawns a real dist/mcp.js as the surviving agent, all under a private $HOME in os.tmpdir(); it needs no herdr, no credential, no peer, no terminal and no network, which is what makes it unattended-runnable. It is not, and never was, a "no live daemon" script — that clause was carried here by the shared boilerplate and was simply false, contradicting this file's own header four lines up (KAN-309; the general case is KAN-308's). Because it runs real processes it is subject to scheduling, so the one observation whose window a fast machine can close — the identity map immediately after a restart — is taken with the agent SIGSTOPped rather than by winning a race for it. |
| `verify-channel-selfcheck` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-channel-spawn-verdict` | yes | imports the built daemon modules, stages its own $HOME and its own unix socket in temporary directories, and needs no herdr, no pty, no network and no CrabCast. Section 3 creates and removes two probe workspaces under the workspaces root, per path and never by reverting a directory. |
| `verify-channel-startup-supervision` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-ci-partition-is-enforced` | yes | builds its fixtures in a temporary directory and reads `ci.yml` and the script headers off the checkout; node builtins only, no build, no daemon, no herdr, no credential, no network. |
| `verify-confluence-workspaces` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-cost-estimate-plausibility` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-cpu-headroom-gate` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-crabcast-runtime-switch` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-cross-type-activation` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-guardian-board-display` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-guardian-poke` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-integration-enablement` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-integration-pluggability` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-io-stall-gate` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-jira-credential-diagnostics` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-jira-log-hygiene` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-jira-parent-topology` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-jira-poller-nudges` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-jira-self-echo-suppression` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-jira-storage-disclosure` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-launchdarkly-proxy-failure-is-loud` | yes | spawns the built daemon and mcp server against a loopback stub under a temporary $HOME; no herdr, no real credential, no peer, no terminal, no network beyond 127.0.0.1. |
| `verify-launchdarkly-proxy-scope` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-ld-credential-diagnostics` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-ld-log-hygiene` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-ld-storage-disclosure` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-list-agents-survives-restart` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-message-provenance` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-notifications-never-type` | yes | imports the built daemon modules and asserts against them in process, over Unix sockets it creates under a private $HOME in os.tmpdir(); no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-off-button-honesty` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-operative-rules-are-carried` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-parentage-in-list-agents` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-per-epic-supervision` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-pr-watch` | yes | imports the built daemon modules and asserts against them in process, over Unix sockets it creates under a private $HOME in os.tmpdir(); no live daemon, no herdr, no credential, no peer, no terminal, and no network (§1 replays RECORDED `gh` output; §2-6 stub the reader). |
| `verify-prompt-poller-seam` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-prompt-provenance-stamp` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-staleness-check` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. It does `git clone` this checkout into a scratch directory and then `checkout -B main origin/main` inside the clone, so the checkout it runs from needs a **local** `main` branch — a clone resolves `origin/*` from the local branches of its source, and `actions/checkout` leaves a detached HEAD with none. The `verify-runnable-set` job creates one; see the comment there. |
| `verify-staleness-over-socket` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. It does `git clone` this checkout into a scratch directory and then `checkout -B main origin/main` inside the clone, so the checkout it runs from needs a **local** `main` branch — a clone resolves `origin/*` from the local branches of its source, and `actions/checkout` leaves a detached HEAD with none. The `verify-runnable-set` job creates one; see the comment there. |
| `verify-standdown-survives-degraded-activation` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-startup-admission` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-status-change-nudges` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-supervision-key-spelling` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-tail-asks-every-source` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-tail-async-awaited` | yes | imports the built daemon modules and reads `daemon/src` off the checkout; the only herdr is a shim this file writes onto PATH. No live daemon, no real herdr, no credential, no peer, no terminal, no network. |
| `verify-workspace-deps-are-shared` | yes | reads files off the checkout and asserts on their contents; node builtins only. |
| `verify-workspace-reclaim` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |
| `verify-agent-tree` | yes | imports the built daemon modules and asserts against them in process; no live daemon, no herdr, no credential, no peer, no terminal. |

## `partial` — runs in CI and asserts a real subset — named sections need something CI has not got

| script | class | reason |
| --- | --- | --- |
| `verify-crabcast-census-disclosure` | partial | sections 1-7 assert in CI. They stand up their own Unix socket and a fake `herdr` on PATH, and need no peer, no real herdr, no PTY, no credential and no network. Section 8 needs a live CrabCast daemon and SKIPS without one; a skip is printed as a skip and never counted as a pass. |
| `verify-jira-nudge-coalescing` | partial | the coalescing assertions run in CI. The CONTROL leg needs an `--unfixed` build to show the defect it prevents, and AC3d needs `--live`; both are skipped without them and both are named in the run output. |
| `verify-mcp-runtime-validation` | partial | sections 2 onward run in CI. Section 1 — the red — needs an unfixed dist built from `origin/main` and is skipped without one, which the script prints. |
| `verify-prompt-write-refusal` | partial | the refusal itself is asserted in CI. Section 1, the silent uninstructed start that makes the refusal meaningful, needs a dist built from `origin/main` and is skipped without one. |
| `verify-pty-init-rejects-unknown-session` | partial | the rejection path asserts in CI. The regression stage needs herdr to start a real agent and prints `SKIPPED: no herdr to start an agent with` instead. |
| `verify-supervisor-cost-exclusion` | partial | the exclusion arithmetic asserts in CI. Section 5 needs a running fleet and is skipped without one — the header already said so before this partition existed. |

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
| `verify-crabcast-runtime-live` | no | needs a real CrabCast daemon at `BUTCHR_CRABCAST_SOCKET`; it attempts nothing without one. |
| `verify-fleet-switch-live` | no | starts a real daemon from a built dist and needs herdr to spawn the fleet whose runtime it switches. |
| `verify-message-provenance-live` | no | needs a real daemon, herdr, a pane and a live Claude Code agent — the provenance it checks is what a model actually received. |
| `verify-no-attach-steal` | no | takes the key of a live agent as its argument and attaches to it; there is nothing to pass in CI. |
| `verify-pretrust-survives-concurrency` | no | every stage needs a real spawn, and it refuses to run at all when herdr is absent rather than pretending otherwise. |
| `verify-send-interrupts-inflight-work` | no | needs a real daemon and a live agent with a tool call actually in flight — the interrupt is the thing under test. |
| `verify-send-transport-claims` | no | the switch-off and stop-now legs spawn herdr, and it counts their absence as failures rather than skipping them, so it is red in CI by its own honest design. |
| `verify-spawn-failure-legibility` | no | stands up a private herdr server and makes real spawns fail against it. |
| `verify-tab-per-agent` | no | spawns herdr directly to inspect how panes and tabs are allocated. |
| `verify-tail-source-boundary-live` | no | needs a real herdr server and a terminal; it says so and stops when there is neither. |
| `verify-sidepanel-survives-daemon-restart` | no | needs a real daemon, herdr and a loaded extension side panel driving it. |

