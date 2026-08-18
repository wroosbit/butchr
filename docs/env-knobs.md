<!-- constant-pin: RUNTIME_ENV_VAR
     src: daemon/src/runtime-switch.ts
     sha256: 28959b7fe578
     says: **The runtime switch:** `BUTCHR_AGENT_RUNTIME`, the knob that selects which agent runtime the daemon serves. -->

# The `BUTCHR_*` environment knobs

**Ticket:** KAN-534. **This is the one place a `BUTCHR_*` environment variable is
documented.** Before this file the knowledge was spread across the source and
seven other pages in `docs/`; **seven of the fifteen live knobs were written
down nowhere at all** (nine of the nineteen identifiers KAN-534 counted, two of
which turned out not to be knobs), and the list had grown without anyone
deciding it should.

`node daemon/scripts/verify-env-knobs-documented.mjs` is what keeps it that way:
it reads the environment reads out of `daemon/src` and the table below out of
this file, and goes red when they disagree in either direction. It runs on every
pull request. **Adding a knob without a row here is a failing check, not a
review comment.**

## What counts as a knob, and why the first count was wrong

KAN-534 was filed against a measurement of **nineteen** knobs, taken by grepping
`daemon/src` for the token `BUTCHR_[A-Z0-9_]+`. That grep matches an
*identifier*, and four of the nineteen are identifiers that are not environment
variables at all:

| identifier | what it actually is |
| --- | --- |
| `BUTCHR_AGENT_NAME_BRAND` | a TypeScript `declare const … unique symbol`, the brand on the `ButchrAgentName` type (`herdr.ts`). It does not exist at runtime. |
| `BUTCHR_DIR` | an exported constant, `~/.local/share/butchr` (`ipc.ts`). Never read from the environment — setting it does nothing. |
| `BUTCHR_LAUNCHERS` | an exported constant array, `Object.keys(AGENT_LAUNCHERS)` (`crabcast-runtime.ts`). |
| `BUTCHR_WORKSPACE_TYPE` | **a knob that was removed.** KAN-145 deleted the env read; the two surviving mentions are comments explaining the deletion. The identity now arrives on the MCP server's command line. |

So the live count is **fifteen**, and it is the fifteen below. This distinction
is not pedantry: three of the four read like operator controls, and
`BUTCHR_DIR` in particular looks exactly like a directory override a person
would try to set.

The check enforces the narrower definition. A name is a knob when `daemon/src`
reads it **as an environment key** — `process.env.X`, `env.X`, `env['X']`, or a
string literal `'X'` handed to a reader such as `envNumber` or held in a
`*_ENV_VAR` constant. Comments are stripped before matching, so describing a
knob in prose does not create one.

## Operator controls

These are meant for a person running a fleet. Every one of them falls back to
the stated default when unset, and every one of them falls back **loudly** when
set to something it cannot read — an unparseable value never takes a subsystem
off the air.

**The runtime switch:** `BUTCHR_AGENT_RUNTIME`, the knob that selects which agent runtime the daemon serves. That sentence is pinned to `RUNTIME_ENV_VAR` at the top of this file (KAN-347's mechanism), so renaming the constant turns this page red rather than leaving it quietly wrong.

<!-- knob-table -->
| knob | values | default | what it does |
| --- | --- | --- | --- |
| `BUTCHR_MAX_AGENTS` | integer > 0 | derived from CPU and memory | Assigns the agent `cap` outright, skipping the derivation. **A ceiling, not a target** — see below. |
| `BUTCHR_AGENT_MEMORY_MB` | integer > 0 | measured, else the 650 MB seed | Resident cost charged for one agent tree. Beats the live measurement. |
| `BUTCHR_AGENT_CORES` | number > 0 | measured, else the seed | Cores charged for one active agent tree. Beats the live measurement. |
| `BUTCHR_STALL_PERCENT` | number > 0 | `20` | `/proc/pressure` `full avg10` at or above which nothing is admitted. Above 100 disables the veto. |
| `BUTCHR_SUPERVISOR_MEMORY_MB` | integer ≥ 0 | `650` | Memory reserved per running supervisor. **`0` is meaningful** — it disables the reserve, which is why zero is distinguished from unset. |
| `BUTCHR_STALE_COST_MAX_MINUTES` | number ≥ 0 | `240` (4 h) | How long a cost measurement is retained once there is nothing left to measure. **`0` disables retention**, restoring the pre-KAN-365 behaviour. |
| `BUTCHR_AGENT_RUNTIME` | `herdr` \| `crabcast` | `herdr` | Which agent runtime the daemon serves. An unrecognised value falls back to `herdr` and says so — never to `crabcast`. |
| `BUTCHR_CRABCAST_SOCKET` | path | CrabCast's default socket | Where to reach CrabCast. Consulted only in `crabcast` mode. `~` is expanded. |
| `BUTCHR_ATLASSIAN_PROXY` | `off` \| `jira-read` \| `confluence-read` \| `jira-write` \| `confluence-write` | `off` | Which rung of the Atlassian proxy ladder this daemon serves. Exact string match — no truthiness, no `1`. |
| `BUTCHR_LAUNCHDARKLY_PROXY` | `off` \| `launchdarkly-read` | `off` | Whether the LaunchDarkly read proxy is served. Same exact-match discipline. |
| `BUTCHR_BOARD_RECONCILE` | `off` \| `report` \| `converge` | `report` | Whether the board reconciler only computes the diff (`report`), acts on it (`converge`), or does not read Jira at all (`off`). |
| `BUTCHR_PR_WATCH_REPOS` | comma-separated `org/repo` | discovered from agent checkouts | Pins the watched set, overriding discovery entirely. |
| `BUTCHR_MCP_RESPONSE_BUDGET_CHARS` | integer ≥ 1000 | `9000` | Character budget for an MCP response. For an operator on a client roomier than the one this default was measured against. Below the floor the override is ignored. |

## Internal — read from the environment, but not operator controls

Both of these exist so a proof can drive something that is otherwise
unobservable, and both are **deliberately** still environment reads: the thing
they configure lives in a daemon the proof spawns as a child process, so there
is no in-process seam to pass them through. They are documented here rather than
hidden because an environment variable is discoverable by accident whatever we
intend, and a reader who finds one deserves to learn it is not for them.

<!-- knob-table -->
| knob | values | default | what it does |
| --- | --- | --- | --- |
| `BUTCHR_GUARDIAN_FIRST_POKE_MS` | integer ms | the built-in first-poke delay | Shortens the delay before the guardian's *first* poke, so `probe-guardian-poke-delivery.mjs` §5 can exercise the timer without waiting five minutes. Clamped to [1 s, 10 min] so a stray value cannot busy-loop at a real agent's expense. **The interval is not settable here** — that is a real setting and lives in `guardian.json`. |
| `BUTCHR_LAUNCHDARKLY_API_ORIGIN` | loopback URL | LaunchDarkly's real API origin | Points the LaunchDarkly client at a local fixture for a proof. **Loopback-only, checked by hostname rather than by resolution, and a non-loopback value is refused rather than honoured** — an override that could redirect the daemon's LaunchDarkly traffic would be a credential-exfiltration primitive configured by an environment variable. |

## `BUTCHR_MAX_AGENTS` is a ceiling among ceilings

KAN-517 established that setting `BUTCHR_MAX_AGENTS=10` on this machine yielded
an effective ceiling of about seven, and reported the mechanism as *"`cap` is
never read at admission … a number the gate never reads."* **The conclusion is
right and that mechanism is wrong**, which matters because it is the sentence a
later reader would act on.

`cap` **is** read at admission. The chain is unbroken:

```
BUTCHR_MAX_AGENTS → optionsFromEnv().configuredCap → cap  (capBoundBy: 'configured')
                  → headroomByCap = max(0, cap − running)
                  → headroom = min(headroomByCap, headroomByCpu, headroomByMemory)
                  → atCapacity = headroom <= 0            → router.ts's gate
```

Measured with `computeCapacity` directly, on a machine with CPU and memory to
spare so that the count term is the only one that can bind:

```
cap=2, running=2 → headroomByCap=0 headroomByCpu=74 headroomByMemory=342
                 → headroom=0 boundBy=cap  atCapacity=true
cap=9, running=2 → headroomByCap=7 headroomByCpu=74 headroomByMemory=342
                 → headroom=7 boundBy=cap  atCapacity=false
```

Changing **only** the cap flipped the gate. Had the gate not read `cap`, it
could not have.

What is true is the other half. `cap` is one of three terms in a `min`, so it
can only ever **lower** the number admitted, never raise it:

```
cap=10, memory-starved machine → headroomByCap=10 headroomByCpu=74 headroomByMemory=0
                               → headroom=0 boundBy=memory  atCapacity=true
```

So the **name is accurate** — it is a maximum, and it behaves as one. What
overclaimed was the description *"sets the cap outright, skipping the
derivation"*: true of the derivation of `cap`, and read by a person as though it
settled how many agents will run. It does not, and `effectiveCeilingOf`
(KAN-517) is what reports the gap. The wording is corrected in `capacity.ts` and
in `docs/butchr.md` rather than the variable being renamed; renaming a knob four
places set it, to fix a sentence, would be a breaking change bought for nothing.

## What is set on this machine

Read from the running daemon's `/proc/<pid>/environ` on 2026-08-18, not from the
unit files (a drop-in that has not been reloaded is not in force):

```
BUTCHR_AGENT_RUNTIME=crabcast
BUTCHR_ATLASSIAN_PROXY=confluence-write
BUTCHR_BOARD_RECONCILE=converge
BUTCHR_MAX_AGENTS=6
```

The other eleven are unset here and run on their defaults. **That is not
evidence that nobody sets them** — they are environment variables, and the whole
point of one is that it is set outside the repository. No knob has been deleted
on the strength of this, and none should be.

## Nothing in CI sets any of these

Every one of the fifteen runs at its default on every CI run. That is a
deliberate property and not an oversight — a required check that depended on a
knob would be testing a configuration rather than the code — but it does mean
**the non-default branch of each knob is exercised only by whatever proof names
it**. The check this file is enforced by does not close that; it guards the
documentation, not the behaviour.
