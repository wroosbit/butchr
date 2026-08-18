import * as fs from 'fs';
import * as os from 'os';

/**
 * How many agents this machine can carry — measured, not declared.
 *
 * On 2026-07-31 the board manager staffed seven agents on a 4-core laptop:
 * load average 11.3 against 4 cores, 9 claude processes holding 3.0 GB, and
 * 319 MB of 15 GB free. Nothing in Butchr knew any of that. The only
 * instrument that noticed was a human saying the desktop felt slow.
 *
 * Everything here is arithmetic over figures read from the machine, so the
 * answer travels: the same code on a 64-core box says 73, not 2. The
 * arithmetic is deliberately simple and deliberately explained — a cap nobody
 * can follow is a cap people route around.
 *
 * The costs below are calibrated against that incident and are meant to be
 * re-measured, which is why they are constants with names rather than magic
 * numbers, why every one of them has an environment override, and why
 * `scripts/measure-agent-cost.mjs` exists to produce the evidence.
 *
 * KAN-36 corrected two things about the first version, both discovered the
 * same way — a human found the product unusable and no instrument had noticed:
 *
 *   - The cap counts *task* agents. At the time there was one always-on board
 *     manager, so KAN-36 reserved its share off the top like herdr's rather
 *     than spending it from the same budget as the work. Counting it had left
 *     a 4-core machine able to run exactly one task agent, forever.
 *   - An agent is a process tree, not a process. The MCP servers every agent
 *     starts are most of the difference between 480 MB and the 650 MB one
 *     actually holds.
 *
 * KAN-36's one-slot supervisor reservation was deliberately
 * unconditional. The manager was "present whenever Butchr is being used at
 * all, exactly like herdr", so holding its slot whether or not it happened to
 * be up kept `cap` a static property of the hardware. That was right when it
 * was written, and then KAN-39 removed the thing it assumed: there is no
 * longer one always-on supervisor. Zero or more `epic` and `story` agents are
 * staffed and stood down as work comes and goes, and a fixed reservation for
 * one of them had become arithmetic about an agent that may not exist.
 *
 * The rule that replaced it (KAN-41): only task agents are accounted for at
 * all. `cap` is cores and memory minus the human reserve and herdr's
 * overhead, and nothing else. Epic and story agents are neither counted in
 * `running` nor reserved for — they are typically low-resource and idle,
 * reading Jira, filing tickets and waiting, not competing for the machine the
 * way a task agent compiling a repo does. They are still reported in
 * `Capacity.supervisors`, so a reader of a capacity report can see they
 * exist; they are simply never charged.
 *
 * KAN-44/KAN-56 closed the loop this header opened. `readCapacity()` always
 * read cores, memory and load live; the one static input left was the
 * per-agent cost divisor, measured once on 2026-07-31. Now the daemon
 * re-measures its own fleet on a timer (daemon.ts, with agent-cost.ts as the
 * instrument), damps the estimate (agent-cost-damping.ts — asymmetric on
 * purpose, see that file), and this arithmetic divides by the damped figure.
 * The constants below remain as the *seed*: what capacity answers from when
 * there is nothing to measure — no agent trees, no /proc, a sample that fails
 * validation — because whatever breaks, capacity still answers, conservatively.
 *
 * That accuracy is paid for in predictability. The original argument here was
 * for a static cap — "a cap nobody can follow is a cap people route around" —
 * and a divisor that moves with the fleet is exactly a cap nobody can follow
 * from the constants alone. So the deal is: the cost input may move, but every
 * report says where each figure came from (seed, measured, or override), when
 * the sample was taken, over what window, from how many trees — and the
 * arithmetic from those printed figures to `cap` stays reproducible by hand.
 * A reader who cannot predict tomorrow's cap can still check today's.
 *
 * Precedence is strict and short: an operator override
 * (BUTCHR_AGENT_CORES / BUTCHR_AGENT_MEMORY_MB) beats the measurement
 * outright — someone who typed a number into their environment has re-measured
 * or decided, and a fleet that argues with its operator gets turned off. The
 * measurement beats the seed. The seed is what remains. BUTCHR_MAX_AGENTS
 * still pins the cap and skips the derivation entirely.
 *
 * KAN-201 replaced the live term that actually did the refusing. Until then,
 * headroom asked the 1-minute load average how much of the machine was left:
 *
 *     headroomByLoad = (cores − reservedForHuman − load1) ÷ costPerAgentCores
 *
 * The human's verdict on it was "the formula that limits the number of agents
 * is trash", and the numbers agreed. Four things were wrong with it, and only
 * the last one is about strictness:
 *
 *   1. It measured the whole machine and charged it to the fleet. `load1`
 *      counts the browser, a `npm run build`, and the human's own work
 *      indiscriminately, then subtracts all of it from a budget that is
 *      denominated in *per-agent* cost. One build pinned headroom at 0 for a
 *      minute afterwards with no agent having done anything, which is also why
 *      KAN-57 had to exempt supervisors from a gate that could never open.
 *   2. It contradicted this file's own other answer by two orders of
 *      magnitude. On 2026-08-06, with the same measured 0.064 core/agent
 *      divisor, `capByCpu` said 39 and `headroomByLoad` said 0. Two routes
 *      through one model cannot both describe one machine.
 *   3. It is a lagging average used as an admission test. Admission is a
 *      question about the next agent's marginal cost; `load1` is a smoothed
 *      report of the last minute, so the gate refused on work that may already
 *      have finished, and stayed wrong for up to a minute after it did.
 *   4. It subtracted a queue length from a core count. Load average is the
 *      run-queue — runnable *plus* uninterruptible-sleep tasks — not a
 *      utilisation fraction. A load of 4.45 on this 4-core machine was
 *      measured against 1.19 cores of actual CPU. The arithmetic was
 *      dimensionally confused, and that confusion is the root of (2).
 *
 * What replaced it is the memory term's shape, because the memory term is the
 * one nobody has ever complained about: take what the machine says is
 * *available* right now, hold back the human's reserve, divide by the measured
 * per-agent cost.
 *
 *     headroomByMemory = (availableBytes − reservedBytes) ÷ costPerAgentBytes
 *     headroomByCpu    = (cores − busyCores − reservedCores) ÷ costPerAgentCores
 *
 * `busyCores` is CPU actually consumed, read from /proc/stat over a recent
 * window (see {@link sampleCpuBusy}) — the same quantity, in the same units,
 * that agent-cost.ts already measures per agent tree. `load1` is still read and
 * still reported, because it is the number a human feels when the machine goes
 * treacly; it no longer decides anything.
 *
 * This is a loosening and it is meant to be one — it was authorised as "about
 * 2x" and it delivers more than that on this hardware. What it is not is a
 * removal: a machine whose cores are genuinely spent still refuses, by the
 * same arithmetic, with the same legible reason. The two terms that ration
 * hardest are untouched: memory (which kills rather than slows, and which
 * binds first on this laptop once CPU stops lying) and the static cap.
 * daemon/scripts/verify-cpu-headroom-gate.mjs is the proof that the gate still
 * closes, and it is written so that it goes red if it stops.
 *
 * KAN-204 is the second half of that work, and it is about the *divisor*
 * rather than the numerator. Within an hour of KAN-201 deploying, capacity on
 * this machine went from `cap 19 (bound by memory)` to `cap 3 (bound by cpu)`
 * — worse, not 2.7x better. The arithmetic was right and every figure it
 * printed was right; what was wrong was one input:
 *
 *     agent cost: 684 MB resident (measured), 0.631 core while active (measured)
 *       measured (damped): 5 tree(s) over a 60s window ending 21:19:07Z
 *
 * Five trees at 0.631 core each is 3.15 cores of agent CPU, on a machine
 * reporting 1.94 cores busy *in total* on the same call. The estimate asserted
 * more CPU than the machine said was in use anywhere, and it was labelled
 * `measured` while it did so. It was not a measurement: it was the 0.75 seed,
 * two damping windows into a walk back down toward the ~0.05 this fleet
 * actually costs — a walk that takes the better part of half an hour at
 * ALPHA_DOWN.
 *
 * The damping is not the defect and is not changed. Its asymmetry is still
 * right for the reason KAN-55/56 gives, and the half of that reasoning being
 * preserved here is the half about *direction*: believe an expensive fleet
 * quickly, because under-charging is what made the desktop unusable. The half
 * that KAN-201 falsified is the consolation — that over-charging "merely
 * refuses an activation, which the operator can read, override, or wait out".
 * Once the cap divides by the estimate, over-charging is a fleet-wide throttle
 * for twenty-five minutes after every restart, and this epic restarts the
 * daemon on every deploy. So the fix is not to make the filter symmetric. It
 * is to stop the filter starting from a fiction after every restart, and to
 * bound what it publishes by an instrument that cannot be argued with:
 *
 *   1. The estimate survives a restart. It is the filter's state, and it was
 *      the one piece of capacity state nothing wrote down — see
 *      agent-cost-store.ts. Damping resumes from what this fleet last cost
 *      instead of from a July constant, and a restored figure says `restored`
 *      rather than `measured`, because a number sampled before this daemon
 *      existed must not claim to be a measurement of what it is dividing.
 *      **This is the fix for the cap.** The cap collapsed because its divisor
 *      was wrong; the divisor is right again, and `cap` goes back to 19 on the
 *      machine that reported 3.
 *   2. The fleet cannot spend more CPU than the machine is spending. See
 *      {@link boundCoresByObservedCpu}. `cpuBusyCores` and the per-agent core
 *      estimate come from the same /proc data in the same units, so
 *      `cores × agentTrees > cpuBusyCores` is not a heuristic — it is the
 *      estimate contradicting the machine, and the machine wins. Nothing
 *      checked it, and it costs one multiplication.
 *
 * WHERE THE BOUND IS ALLOWED TO ACT, AND WHY ONLY THERE
 *
 * It bounds the **live headroom term only**. It does not touch `capByCpu`, and
 * the first draft of this change did, which was wrong twice over.
 *
 * Wrong on the model: `cap` is "what the hardware supports with nothing else
 * assumed" — a static property of the machine, deliberately independent of what
 * is running on it this second. A cap that moved with `cpuBusyCores` would be a
 * cap nobody can follow, which is the objection this file opens with.
 * verify-agent-capacity.mjs section 8 encodes exactly that — same machine, same
 * agent count, different CPU in use, and `headroomByCap` must not move — and it
 * caught the draft.
 *
 * Wrong on safety, which matters more: `busyCores ÷ agentTrees` is one
 * instant's reading of a fleet that is mostly *waiting on an API*. Eight agents
 * spending 0.5 cores between them says nothing about what they cost when they
 * all wake, and believing it would open the static cap with no feedback loop to
 * close it again. That is KAN-34 verbatim — "believe too quickly that agents
 * are cheap and the cap opens to a fleet the machine cannot carry the moment
 * they all wake" — and the asymmetric damping exists to prevent precisely it.
 *
 * In the live term neither objection holds. Live dependence is the whole point
 * of headroom, and the loop closes on itself: a bounded divisor lets another
 * agent start, that agent spends CPU, `cpuBusyCores` rises within one five-
 * second window, the numerator shrinks, and the gate closes again. The static
 * cap sits above it all as the ceiling that does not move. So the two
 * mechanisms cover each other — the estimate is prevented from throttling the
 * live gate on a figure the machine contradicts, and the cap is prevented from
 * opening on a figure that is one idle instant.
 *
 * The bound is skipped entirely for an operator override (someone who typed a
 * number has decided) and on the load-average fallback path (a figure that is
 * not a measurement cannot falsify one).
 * daemon/scripts/verify-cost-estimate-plausibility.mjs is the proof, and it
 * reproduces the post-restart collapse before showing its absence.
 *
 * KAN-218 puts back a protection KAN-201 removed without naming, which
 * `epic/KAN-59` found in their own port of the same change and reported as a
 * regression in their own work.
 *
 * `load1` was accidentally a signal about more than CPU. The run queue counts
 * tasks in uninterruptible sleep as well as tasks wanting CPU, so a machine
 * thrashing on swap or stalled on a failing disk showed a high load with idle
 * cores — and the old gate refused there, for the wrong reason but with the
 * right outcome. `busyCores` deliberately counts iowait as *not busy* (see
 * {@link sampleCpuBusy}), which is correct for a CPU term and leaves I/O
 * saturation bounded by nothing at all.
 *
 * THE INSTRUMENT, AND WHY NOT THE OBVIOUS ONE
 *
 * The obvious candidate is /proc/stat's `iowait`, and it is the wrong one — not
 * merely "famously misleading" but wrong in a way that was measured here on
 * 2026-08-08 rather than repeated from folklore. `iowait` is a *per-CPU* bucket:
 * a jiffy counts as iowait only when that CPU is **idle** and has at least one
 * task on it blocked on I/O. Two consequences, both fatal for a gate:
 *
 *   - It is divided by the core count. One task fully blocked on I/O reads as
 *     25% iowait on this 4-core laptop and 1.6% on a 64-core box. The same
 *     physical stall reports differently depending on hardware that has nothing
 *     to do with the disk, so a threshold on it measures core count as much as
 *     saturation.
 *   - It goes to **zero** precisely when the machine is busiest. If the CPUs
 *     have other runnable work, blocked tasks contribute nothing to iowait at
 *     all. Under a deliberate 8-way synchronous-direct-write load on this
 *     machine, `iowait` peaked at 14.5% and then fell to **0.00%** while the
 *     disk was doing the same work — because CPU use had risen from 32% to 55%
 *     and there were no longer idle CPUs to charge the wait to. At that instant
 *     PSI reported 21% of wall time with something stalled on I/O and 3% with
 *     everything stalled. A gate on iowait would have seen a healthy machine.
 *
 * So: **pressure stall information**, /proc/pressure/{io,memory}, which measures
 * the thing directly — the share of wall-clock time that tasks spent stalled,
 * machine-wide, independent of core count and independent of whether the CPUs
 * had other work. `some` is "at least one task stalled"; `full` is "every
 * non-idle task stalled", i.e. the machine made no forward progress at all.
 * This term reads `full`, because `some` fires on one process doing one honest
 * read and `full` is the share of time the machine was actually stopped.
 *
 * BOTH FILES, BECAUSE SWAP THRASH IS NOT FILED UNDER I/O
 *
 * The ticket's headline case is a machine thrashing on swap, and an io-only term
 * would miss it: the kernel accounts a task waiting on swap-in as a **memory**
 * stall (`psi_memstall_enter`, alongside direct reclaim and cache thrashing),
 * not an I/O one. So this term reads both files and takes the worse of the two,
 * and reports which one it was. That is also why it is not folded into the
 * memory term above: `availableBytes` asks *is there room*, and this asks *is
 * the machine stalling to make room*. They disagree exactly when it matters —
 * measured here on 2026-08-08 at 934 MB swapped out against 7.2 GiB reported
 * available, a machine the memory term reads as entirely healthy.
 *
 * A VETO, NOT A DIVISOR — WHICH IS WHY IT HAS NO `headroomBy…` COUNT
 *
 * Every other term is `(budget − in use − reserved) ÷ per-agent cost`, and
 * answers in agents. This one cannot honestly take that shape: there is no
 * measured per-agent I/O cost to divide by, and inventing one to make the
 * arithmetic look symmetrical would be the dimensional confusion KAN-201 exists
 * to have removed. A stalled machine does not have room for 0.4 of an agent; it
 * has no room, and the honest model is a veto that zeroes the headroom the other
 * three terms computed. It is reported as {@link Capacity.stallPercent} and a
 * boolean, and `headroomBoundBy` gains `'stall'` rather than a fourth count.
 *
 * It names itself only when it is the reason there is no room — if the board was
 * already full, `cap` still binds, by the same tie rule as the other terms:
 * closing an agent is something the reader can act on, waiting for a disk is not.
 *
 * THE THRESHOLD IS A DECISION, NOT A MEASUREMENT, AND THERE IS NO INCIDENT
 *
 * Said plainly because the rest of this file is careful about the difference.
 * {@link STALL_REFUSE_PERCENT} is 20%, and no observed outage calibrated it,
 * because — as the ticket says — this is a real gap with no observed instance.
 * What it is calibrated against is the other side: what this machine produces
 * when nothing is wrong. Over five minutes spanning a full agent fleet, several
 * builds and two deliberately induced I/O loads, `io full avg10` averaged 1.05%
 * and peaked at 7.24%; `memory full avg10` averaged 0.016% and peaked at 0.54%.
 * 20% sits roughly 3x above the worst reading a deliberate stress test produced
 * and two orders of magnitude above the ordinary one, so the term is inert in
 * normal operation, which is what is wanted from a saturation guard. It is an
 * env override (BUTCHR_STALL_PERCENT) for the same reason every other constant
 * here is, and a value above 100 disables it outright.
 *
 * `avg10` and not `avg60`, deliberately: admission is a question about now, and
 * preferring a smoother, more-lagging average is the exact mistake KAN-201
 * catalogued as (3). Ten seconds is the same order as the CPU term's window.
 *
 * WHERE PSI IS ABSENT — AND THERE IS NO FALLBACK, ON PURPOSE
 *
 * Pre-4.20 kernels, kernels without CONFIG_PSI, and everything that is not
 * Linux have no /proc/pressure. The term then goes inert and every report says
 * so. It is tempting to fall back to `procs_blocked` from /proc/stat, which is
 * available everywhere, and it is declined: that is an instantaneous count of
 * tasks in uninterruptible sleep, one `dd` puts it at 1 on a perfectly healthy
 * machine, and without a rate and a window there is no threshold that separates
 * healthy from thrashing. A fabricated instrument that refuses activations on a
 * healthy machine is worse than a named hole. So the hole is named: on a machine
 * without PSI, I/O saturation is bounded by nothing, the derivation says that in
 * words, and this comment is the line beside the CPU term that the next reader
 * needs in order to learn that the gap is known rather than missed.
 *
 * daemon/scripts/verify-io-stall-gate.mjs is the proof; it drives the reader
 * from fixture files, so the arithmetic and the parsing are both exercised, and
 * it removes the term to show the same machine admitted.
 *
 * KAN-365 is about the moment there is nothing to measure, which this file had
 * treated as a kind of breakage since KAN-56. Measured on this machine on
 * 2026-08-12, thirteen minutes apart and with nothing changed but elapsed time:
 *
 *     13:02Z  agentCoresSource: measured  agentCores 0.195  cap 12  headroom 6
 *     21:5xZ  agentCoresSource: seed      agentCores 0.75   cap  3  headroom 2
 *
 * The divisor reverted to a constant 3.8x the measured figure and the cap fell
 * to a quarter, because the last task agent had finished. **An idle fleet is
 * the cheapest possible moment to start work, and this is where the machine
 * claimed it could afford least** — and self-reinforcingly so, since the
 * measurement that would correct the estimate requires the very agents the
 * estimate is refusing. `epic/KAN-59` was refused three activations against a
 * 68-ticket backlog with nothing running.
 *
 * THE DISTINCTION THAT WAS MISSING: NO SUBJECT IS NOT A BROKEN INSTRUMENT
 *
 * The sampler's doctrine is *degrade, never guess*, and it is right. What it
 * collapsed together is two situations that differ in what is actually wrong:
 *
 *   - **The instrument failed** — /proc unreadable, a sample that fails
 *     validation. The estimate may be wrong and nothing can say by how much.
 *     Discarding it is the only honest answer, and that is unchanged.
 *   - **There is nothing to measure** — every task agent has finished. The last
 *     measurement is not wrong. It was taken over the right population, by this
 *     daemon, and the only thing that has changed about it is its age. An empty
 *     fleet is evidence about *how busy the machine is*, and none at all about
 *     *what an agent costs on it*.
 *
 * So the second case now retains what it measured, labelled {@link CostSource}
 * `stale` with its age in every report, and only the first discards. The rule
 * this narrows is agent-cost-damping.ts's — *"nothing to measure means the seed
 * is the only honest answer for the next agent"* — which was written (KAN-276)
 * about publishing a figure **derived from the wrong population**, supervisors
 * standing in for task agents. That remains refused: nothing here computes a
 * new figure out of an empty window. Retaining a measurement of the right
 * population and computing one out of the wrong one are different acts, and
 * only the second is a guess.
 *
 * AND THE SEED IS STILL THERE, WHICH IS WHAT KEEPS THIS FROM BEING A LOOSENING
 *
 * A retained figure is lower than the seed on this fleet, so it raises the cap,
 * and the failure that matters in that direction is a machine the human is
 * using becoming unusable. Four things bound it, and none of them is new:
 *
 *   1. **The cap is not the gate.** `cap` is a statement about hardware; every
 *      admission still goes through live headroom, which divides CPU and memory
 *      measured seconds ago.
 *   2. **Every start against a stale figure is charged the seed.** Its window
 *      closed before any agent running now existed, so `unobservedStartsAmong`
 *      returns every one of them and {@link startingAgentCost} charges 0.75
 *      core each until an instrument has priced them. The cap opens; the ramp
 *      does not. On this 4-core machine that is three or four starts before the
 *      live term closes again — after which the first real window replaces the
 *      stale figure outright, sixty seconds in.
 *   3. **The retention ceiling.** Past it the figure is dropped and the seed is
 *      the answer again — which is today's behaviour, so the change can never
 *      be worse than what it replaces, only better for as long as the ceiling
 *      lasts. See cost-sampler-policy.ts, which owns that decision.
 *   4. **{@link boundCoresByObservedCpu} is unmoved**, and it can only ever
 *      lower a divisor, never raise one.
 *
 * ALL THREE FIGURES REVERT TOGETHER, SO ALL THREE ARE RETAINED TOGETHER
 *
 * The first version of this ticket read as a CPU-cost problem and it is not:
 * `epic/KAN-203` measured `agentMemoryMb` (650) and the per-supervisor reserve
 * (650) falling back to seed in the same breath as `agentCores`, because they
 * come from one {@link MeasuredAgentCost} record and one `pick()`. A fix for
 * cores alone would have left two thirds of it. Retention is of the record, so
 * `costSource.residentBytes`, `costSource.cores` and
 * `supervisorReserve.source` move to `stale` together — they were never
 * separable and nothing here separates them.
 *
 * "WHICH LAST MEASUREMENT?" — THE OBJECTION, AND WHY THE ANSWER IS DIRECTIONAL
 *
 * `epic/KAN-203` measured the same two trees over the same 60s window six
 * minutes apart and got `agentCores` 0.262 then 0.184 — a 30% move with nothing
 * changing about the subject — while `agentMemoryMb` went 682 → 709, *rising*
 * as cores fell. Both readings are honestly labelled `measured`, so "persist
 * the last measurement" has a question inside it: a fleet that runs briefly and
 * stops leaves behind a still-settling figure that "was never wrong and was
 * never right either".
 *
 * That is real, and it does not need a settledness rule, because of where a
 * settling figure sits. The damping filter starts each dimension from the seed
 * and walks toward the truth (agent-cost-damping.ts), so an unsettled figure is
 * always **between the seed and the settled answer**:
 *
 *     cores:   seed 0.75  ≥  settling 0.262  ≥  settled 0.184
 *     memory:  seed 650   ≤  settling 682    ≤  settled 709
 *
 * On cores — the term that binds on this hardware — a retained early figure is
 * therefore *higher* than the truth, which is the conservative direction: it
 * under-opens the cap rather than over-opening it, and the error shrinks the
 * longer the fleet ran. On memory the interval runs the other way, so an early
 * figure can understate the per-agent cost by up to the seed-to-truth gap
 * (~8% in the reading above) — named rather than buried, and bounded by
 * {@link startingAgentCost}, which charges every start in flight the larger of
 * the estimate and the seed **on both dimensions**, memory included.
 *
 * So the answer to "which measurement" is "the last one, whatever it was" — and
 * the reason that is safe is that the interval it can be wrong within is the
 * interval between the two answers this file would otherwise have chosen
 * between anyway.
 *
 * **KAN-368 narrowed one premise of that argument and left its conclusion
 * standing.** Both `cores` readings above were taken through an instrument that
 * could not see a child process which exited inside its window, so `0.262 ≥
 * 0.184` is a comparison of two undercounts and neither is "the settled
 * answer": the same fleet measured properly runs 0.16–0.43 core, and a
 * compiling agent 1.03. What is unaffected is the *directional* claim this
 * section actually rests on — a settling figure lies between the seed and
 * wherever the filter is walking, and `startingAgentCost` bounds the memory
 * side either way. What is affected is any reader taking `0.184` from here as
 * what an agent costs. It is not; see {@link MEASURED_AGENT_COST} for figures
 * taken over a population known to be working.
 *
 * daemon/scripts/verify-idle-fleet-capacity.mjs is the proof, and it reproduces
 * the collapse before showing its absence.
 */

export const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** What one agent costs the machine while it is working. */
export interface AgentCost {
  /** Resident memory the agent holds, working or idle. */
  residentBytes: number;
  /**
   * Cores the agent tree spends while active — utime+stime over wall clock,
   * the quantity agent-cost.ts measures. Not load-average units: those are a
   * run-queue length, and KAN-201 is the story of the difference.
   */
  cores: number;
}

/**
 * Measured on 2026-07-31, re-measured the same evening with
 * `scripts/measure-agent-cost.mjs`, which exists so the next argument with
 * these numbers can be settled with evidence.
 *
 * `residentBytes` went up, and the reason is the correction: 480 MB was the
 * `claude` process, and an agent is not a process. Every agent also carries
 * its MCP servers — an `npm exec mcp-remote` for Atlassian and a node process
 * for butchr — which the morning's measurement never looked at. Measured over
 * the whole tree: 654, 658 and 679 MB across three live agents, of which the
 * claude process itself was 424–443 MB. 650 MB is the bottom of that range,
 * and memory is the dimension that kills rather than slows.
 *
 * `cores` is neither of the two numbers that can be measured directly, and
 * that is the whole difficulty. Measured CPU is 0.15 cores per agent tree over
 * 90 seconds (0.02–0.24 across three agents), because most of an agent's life
 * is spent waiting on an API; calibrating on that says a 4-core box carries
 * sixteen, and the human who filed KAN-34 had already found out what seven
 * feels like. The load average is the other extreme: seven agents produced a
 * load of 11.3, ~1.6 each, but that is a queue length, and it inflates as the
 * machine gets worse — each of those seven was mostly waiting on the other
 * six. Calibrating on 1.6 says a 4-core box carries one.
 *
 * So it is calibrated on the configuration that was *observed to be fine*.
 * Manager plus two task agents sat at a load of 2.6–2.9 on four cores, with
 * the desktop responsive. Three agents against a budget of 4 cores − 1 held
 * back for the human − 0.5 for herdr = 2.5 gives 0.83 each; 0.75 is that
 * rounded to a figure that divides cleanly and leaves a little slack, and it
 * reproduces exactly the fleet this machine was seen to carry. It sits well
 * above the ~0.3 cores an agent actually spends and well below its
 * thrashing-inflated share, which is the range a divisor in a load-average
 * budget has to live in. Re-measure it before trusting it — that is what the
 * script is for.
 *
 * Since KAN-56 the daemon does re-measure it, continuously, and these numbers
 * are the seed rather than the answer: they hold until the sampler has a
 * damped live figure, and they are what everything degrades to when it does
 * not. A capacity report built from them says `seed`, because a figure nobody
 * measured on this fleet must be labelled as such — that mislabelling is the
 * exact failure story KAN-44 exists to correct.
 *
 * ---------------------------------------------------------------------------
 * THE SEED'S ERROR AGAINST A KNOWN-WORKING POPULATION (KAN-368)
 * ---------------------------------------------------------------------------
 *
 * "Re-measure it before trusting it" was never done against the right
 * population — every reading since had been taken over whatever the fleet
 * happened to be doing, and through an instrument that could not see a child
 * process that exited inside its window (agent-cost.ts's `subtreeTicks`). So
 * the *"6x–9x pessimistic"* verdict recorded on KAN-365 was a comparison
 * between two different quantities, and KAN-368 exists to replace it with one.
 *
 * Measured on the filing machine (4 cores, 15.4 GiB) on 2026-08-14, over
 * task-agent trees herdr called `working` at **both** ends of the window:
 *
 *     120s, 5 working trees, ordinary fleet:      0.160 core,  852 MB each
 *      90s, 6 working trees, two compiling:       0.426 core,  900 MB each
 *      90s, one agent sustaining `tsc`:           1.03  core,  984 MB
 *
 * The last figure is externally corroborated: `/usr/bin/time` put the same
 * compiles at 101.32 core-seconds over 103.0s — 0.98 core — and the tree
 * measured 1.03 with its own idle baseline on top. The instrument and the
 * ground truth agree to ~1%.
 *
 * So, against `cores: 0.75`:
 *
 *   - a working agent at ordinary load costs **0.160 core** — the seed is 4.7x
 *     high;
 *   - a working agent on a busy fleet costs **0.426 core** — 1.8x high;
 *   - an agent actually spending CPU costs **1.03 core** — the seed is **27%
 *     LOW**.
 *
 * **The seed is not wrong, and the direction of its error is not constant.** It
 * was calibrated as a budget share on a fleet observed to be fine, and it lands
 * between what a working agent averages and what one costs at its peak — which
 * is what a divisor with one number for a bursty cost can do at best. What was
 * wrong was every measurement it had been compared against.
 *
 * `residentBytes` is the dimension where the seed is *optimistic and always in
 * the same direction*: 650 MB against 852–984 MB measured, a 31–51%
 * understatement, on the dimension this file's own comment calls the one that
 * "kills rather than slows". It is not raised here, because the live divisor
 * already measures ~800 MB over the whole fleet and damps up quickly, so the
 * seed binds only in the seconds before a first window closes — but a reader
 * reaching for this constant as a memory figure should know it is a floor and
 * not an estimate.
 */
export const MEASURED_AGENT_COST: AgentCost = {
  residentBytes: 650 * MIB,
  cores: 0.75
};

/**
 * ---------------------------------------------------------------------------
 * WHAT A SUPERVISOR HOLDS, AND WHY IT IS A RESERVE RATHER THAN A DIVISOR
 * (KAN-276)
 * ---------------------------------------------------------------------------
 *
 * The header's KAN-41 rule — "only task agents are accounted for at all" — is
 * kept, and one half of its justification is withdrawn. The justification was
 * that supervisors are "typically low-resource and idle". Measured on this
 * machine on 2026-08-11, over two windows of 60s and 90s with a real compile
 * running in a task agent's tree:
 *
 *     task agents  (n=2):  0.198 / 0.187 core,  844 / 722 MB
 *     supervisors  (n=3):  0.014 / 0.011 core,  775 / 775 MB
 *
 * On memory the claim does not hold at all: 775 MB against 722–844 MB is the
 * same order, because a supervisor is the same `claude` binary holding the same
 * MCP servers. It reads Jira and waits, which costs no CPU and frees no RAM.
 *
 * ---------------------------------------------------------------------------
 * A SUPERVISOR'S CPU IS NOT FREE. READ THIS BEFORE QUOTING THE 14x.
 * ---------------------------------------------------------------------------
 *
 * "Supervisors are cheap on CPU, so supervisors are free" is the misreading
 * this paragraph exists to prevent, and it is the one the ratio above invites.
 * It is wrong twice.
 *
 * **The 14x is a duty cycle, not a peak.** A 15s window on the same afternoon
 * caught `epic/KAN-203` at **0.25 core** while it was actively staffing — more
 * than either task agent was spending at that moment. A supervisor's CPU is
 * *bursty and low-duty*: near zero while it waits on Jira, which is most of its
 * life, and comparable to a task agent's while it works. The 60s and 90s
 * figures average over both, which is what makes them small.
 *
 * **So the exclusion is an argument about estimator quality, not about cost.**
 * A task agent's *sustained* cost is what the divisor has to predict, and a
 * mostly-idle bursty process is a bad estimator of it — averaging one in drags
 * the figure toward an idleness the next task agent will not have. That is the
 * whole justification, and it says nothing about supervisors being free.
 *
 * **Their CPU is charged, and here is where.** `cpuBusyCores` is machine-wide:
 * it is measured from /proc/stat over a recent window and contains every
 * process on the box, so a supervisor mid-burst is already inside it and
 * already shrinking `headroomByCpu`. The live term feels their real cost, at
 * the moment they are spending it, without anybody having to estimate it.
 *
 * What is left uncharged is supervisor CPU in the **static cap**, and that is
 * deliberate rather than an oversight: `cap` describes the hardware, a duty
 * cycle is not a property of hardware, and charging a peak that the live term
 * already catches would refuse activations twice for one burst.
 *
 * So the exemption is split along the dimension the evidence actually supports.
 * Supervisors stay uncharged on CPU and stay out of `running`. Their memory —
 * which they demonstrably hold, and which on this 4-core laptop is ~2.3 GiB
 * across three of them — is held back from the static cap's memory budget, as
 * a reserve sized by how many are actually running.
 *
 * **This is KAN-36's supervisor reservation restored, with the objection that
 * removed it answered.** KAN-36 held back one supervisor's share
 * unconditionally; KAN-41 deleted it because there was no longer one always-on
 * supervisor and a fixed reservation had become "arithmetic about an agent that
 * may not exist". That objection was about the *count*, not about the charge.
 * The count is now observed — the same census that reports `supervisors` — and
 * the per-supervisor figure is measured rather than assumed, so the reservation
 * is zero when no supervisor is running and exact when three are.
 *
 * WHY THE STATIC CAP AND NOT LIVE HEADROOM — IT WOULD BE CHARGED TWICE
 *
 * `headroomByMemory` divides what the machine says is **available**, and a
 * running supervisor's resident pages are already not available: the kernel
 * stopped offering them the moment it started. Subtracting a supervisor reserve
 * there as well would charge the same memory twice and refuse activations for
 * memory nobody is short of.
 *
 * `capByMemory` has the opposite problem — it divides `totalBytes`, which is
 * the machine's RAM with nothing running at all, so supervisors were charged
 * **nowhere** in it. That is the hole, and it is the one this fills.
 *
 * This is exactly the shape of {@link HERDR_OVERHEAD_CORES}, for exactly the
 * same reason, and that precedent is why the asymmetry is not a special case:
 * herdr's share comes off the static cap and is deliberately left out of live
 * headroom, "which already contains herdr's real usage — subtracting it there
 * would charge for it twice".
 *
 * THE SEED IS THE AGENT SEED, ON PURPOSE
 *
 * 650 MB, the same figure as {@link MEASURED_AGENT_COST}.residentBytes rather
 * than a second constant of its own. The measurement above is the argument: on
 * memory a supervisor and a task agent are the same thing to within the spread
 * of either, so a separate number would be two names for one quantity, free to
 * drift apart and be re-derived by somebody who noticed only one of them. What
 * differs between the two populations is CPU, and CPU is not what this reserves.
 *
 * BUTCHR_SUPERVISOR_MEMORY_MB overrides it, and 0 disables the term.
 */
export const SUPERVISOR_MEMORY_BYTES = 650 * MIB;

/**
 * Where a cost figure came from. Tracked per dimension, because the operator
 * may override cores while memory stays measured.
 *
 * `restored` is a measurement of this fleet that was taken before this daemon
 * started, carried across a restart by agent-cost-store.ts. It is a separate
 * word from `measured` on purpose: it is the best figure available and it is
 * still not a measurement of the process that is dividing by it, and KAN-44
 * exists because a figure nobody measured on this fleet was labelled as though
 * somebody had.
 *
 * `stale` (KAN-365) is this daemon's own measurement, of the right population,
 * held on past the window that produced it because there is nothing left to
 * re-measure — every task agent has finished. It is a fourth word rather than
 * `measured` for exactly KAN-44's reason: the fleet it describes is not running
 * any more, so a report must be able to say "this is what agents cost here, and
 * it was N minutes ago" rather than implying somebody is measuring now. See
 * cost-sampler-policy.ts for why an idle fleet retains it and a broken
 * instrument does not.
 */
export type CostSource = 'override' | 'measured' | 'restored' | 'stale' | 'seed';

/**
 * How a measurement reached the process that is publishing it.
 *
 * Named rather than spelled inline at each use so that {@link
 * COST_SOURCE_BY_PROVENANCE} can be exhaustive over it — adding a fifth way for
 * a figure to arrive is then a compile error at the one place that decides what
 * a report calls it, instead of being silently labelled `measured` by a chain
 * of equality tests. Two such chains existed before KAN-365 and a new
 * provenance would have slipped through both.
 */
export type MeasurementProvenance = 'measured' | 'restored' | 'stale';

/**
 * What a report calls a measurement, given how it arrived.
 *
 * A total function over {@link MeasurementProvenance}, which is the point: the
 * mapping is the only place the two vocabularies meet, and `Record` makes
 * leaving a provenance out unrepresentable rather than merely untested.
 */
export const COST_SOURCE_BY_PROVENANCE: Record<MeasurementProvenance, CostSource> = {
  measured: 'measured',
  restored: 'restored',
  stale: 'stale'
};

/** The label for a measurement, or `measured` for a record written before
 * provenance was tracked at all. */
export function costSourceOf(measured: Pick<MeasuredAgentCost, 'provenance'>): CostSource {
  return COST_SOURCE_BY_PROVENANCE[measured.provenance ?? 'measured'];
}

/**
 * A damped live measurement of what one agent tree costs, with the metadata a
 * reader needs to judge it: when the window closed, how long it was, and how
 * many trees the per-tree figure was averaged over. Produced by the daemon's
 * sampler (daemon.ts) from agent-cost.ts windows, damped by
 * agent-cost-damping.ts — by design never an instantaneous reading.
 */
export interface MeasuredAgentCost extends AgentCost {
  /** Wall-clock ms (Date.now()) when the sample window closed. */
  sampledAt: number;
  /** Length of the window that closed the measurement, in seconds. */
  windowSeconds: number;
  /**
   * Agent trees the **cores** figure was averaged over: the task-agent trees,
   * since KAN-276. It was every tree, which made this a count of one population
   * printed beside a cost for another.
   */
  agentTrees: number;
  /**
   * Agent trees the **residentBytes** figure was averaged over, which since
   * KAN-276 is a different and larger population — every tree, unchanged.
   *
   * Reported separately rather than left to be assumed equal to `agentTrees`,
   * because they now differ and the derivation has to be able to say so. A
   * report that printed one tree count next to two figures averaged over
   * different populations would be exactly the kind of artifact whose sentence
   * claims more than its mechanism covers. Absent on a record written before
   * this field existed, where it falls back to `agentTrees`.
   */
  memoryAgentTrees?: number | null;
  /**
   * Set to `'restored'` by agent-cost-store.ts when this figure was read back
   * from disk after a daemon restart rather than sampled by the process that
   * is publishing it, and to `'stale'` by cost-sampler-policy.ts when this
   * daemon measured it and then ran out of task agents to re-measure (KAN-365).
   * Absent means the running daemon measured it over a window that has just
   * closed. It travels on the measurement rather than in a separate option so
   * it cannot be lost on the way to the report that has to say it (KAN-204).
   */
  provenance?: MeasurementProvenance;
  /**
   * Mean resident memory of one *supervisor* tree over the same window, for
   * {@link SUPERVISOR_MEMORY_BYTES}'s reserve (KAN-276). Null or absent when
   * the window held no supervisors, which is not the same as zero and must not
   * be rounded into it — the reserve then falls back to the labelled seed.
   *
   * It rides here rather than in its own option for the reason `provenance`
   * does: it is measured by the same window over the same fleet, and a figure
   * that travels separately from the measurement it came from is a figure that
   * arrives without one.
   */
  supervisorResidentBytes?: number | null;
}

/**
 * Memory held back for the supervisors that are actually running (KAN-276).
 *
 * Reported in full rather than as a single number because the whole of this
 * file's promise is that the arithmetic can be re-done by hand from what it
 * prints, and `bytes` alone would leave a reader unable to tell a large
 * reserve caused by many supervisors from one caused by an expensive estimate.
 */
export interface SupervisorReserve {
  /** Supervisors running, from the census. Zero makes the term inert. */
  count: number;
  /** What each is charged. */
  perSupervisorBytes: number;
  /** `count × perSupervisorBytes` — what comes off the static memory budget. */
  bytes: number;
  /** Where `perSupervisorBytes` came from. */
  source: CostSource;
}

/**
 * The record of the per-agent core figure having been overruled, for the live
 * headroom term, by the machine's own account of what it is spending.
 *
 * Present on a {@link Capacity} only when the bound actually fired, so
 * `liveCoresBound === null` is the ordinary case and reads as "the estimate was
 * believed". When it is set, `published` is what the estimate said and `used`
 * is what `headroomByCpu` divided by — both are reported, because a term that
 * quietly divides by something other than the figure the report prints is the
 * hand-reproducibility promise broken.
 *
 * `capByCpu` is never affected; see the header for why the static cap must not
 * move with an instantaneous reading.
 */
export interface CoresBound {
  /** The per-agent core figure before bounding — what the estimate claimed. */
  published: number;
  /** What `headroomByCpu` divided by instead: `busyCores ÷ agentTrees`. */
  used: number;
  /** Agent trees on the machine when the bound was applied. */
  agentTrees: number;
  /** `published × agentTrees` — the CPU the estimate claims the fleet spends. */
  impliedFleetCores: number;
  /** What the machine says is in use, by everything, right now. */
  busyCores: number;
}

/**
 * The free invariant nothing was checking: the fleet cannot be spending more
 * CPU than the machine is spending.
 *
 * Returns the bound to apply, or null to leave the estimate alone. Null is the
 * answer for every case where the comparison is not meaningful, and each of
 * those is a case where the *conservative* thing is to keep the larger
 * divisor:
 *
 *   - a non-positive or non-finite estimate, tree count, or busy figure. A
 *     machine reporting exactly zero busy cores would bound the divisor to
 *     zero and divide by it; there is no such machine while agents run on it,
 *     and refusing to answer beats a division by zero.
 *   - an estimate that is already plausible (`implied <= busy`), which is what
 *     a warm, honest sampler produces and is the overwhelmingly common case.
 *   - a bound that would not actually lower the divisor.
 *
 * The caller is responsible for the two exemptions that are policy rather than
 * arithmetic — an operator override is not second-guessed, and a `busyCores`
 * that is itself the load-average fallback is not a measurement and cannot
 * bound one. Keeping those out of here leaves this function a statement about
 * two numbers, which is what makes it drivable from a script without a machine.
 */
export function boundCoresByObservedCpu(
  cores: number,
  agentTrees: number,
  busyCores: number
): CoresBound | null {
  if (!Number.isFinite(cores) || cores <= 0) return null;
  if (!Number.isFinite(agentTrees) || agentTrees <= 0) return null;
  if (!Number.isFinite(busyCores) || busyCores <= 0) return null;
  const impliedFleetCores = cores * agentTrees;
  if (impliedFleetCores <= busyCores) return null;
  const used = busyCores / agentTrees;
  if (!Number.isFinite(used) || used <= 0 || used >= cores) return null;
  return { published: cores, used, agentTrees, impliedFleetCores, busyCores };
}

/**
 * ---------------------------------------------------------------------------
 * STARTS THE INSTRUMENTS CANNOT HAVE SEEN YET (KAN-258)
 * ---------------------------------------------------------------------------
 *
 * The gate below is sound per activation and was blind in aggregate, and the
 * incident it cost was load 29.14 on a 4-core machine at two minutes' uptime,
 * ending in a hard power-off. Nothing about the arithmetic was wrong. What was
 * missing is stated here because it is the whole of this term:
 *
 *   **Every figure the gate divides describes an agent that has settled, and
 *   an agent that started three seconds ago has not.**
 *
 * Both cost figures are steady-state by construction. {@link
 * MEASURED_AGENT_COST} is a seed taken over a running fleet; the live figure is
 * damped over a 60-second window (daemon.ts's cost sampler) and its own header
 * says so. `cpuBusyCores` is honest and fresh — a /proc/stat window seconds old
 * — but freshness is not the property that was missing: **an observation taken
 * now cannot contain an agent that has not finished spawning its node processes
 * and its MCP servers.** So the reconciler's starts, serial and staggered and
 * each individually admissible, were each measured against a machine that did
 * not yet contain the previous ones.
 *
 * The board reconciler's stagger is the right instinct and does not fix this.
 * `epic/KAN-59` put it best on KAN-263: *"a stagger spaces starts; it does not
 * make the instrument notice them."*
 *
 * **What this charges, and why it is the seed rather than a new number.** An
 * agent admitted since the instruments could have priced it is charged
 * {@link startingAgentCost} — the larger of the published estimate and the
 * seed. That is not an invented ramp constant, and deliberately so: this file's
 * own doctrine is *degrade, never guess*, and the seed is the labelled figure
 * everything already degrades to when nothing has been measured. A damped
 * figure of 0.217 core is a measurement of *settled* agents, so charging it to
 * an agent that is still starting applies a measurement outside the population
 * it was taken over. The seed is the honest floor, and it is already in the
 * file.
 *
 * **It over-charges, on purpose, and that is the conservative direction.** The
 * CPU observation may already contain part of a starting agent's cost, so a
 * start can be paid for twice. A gate that admits one agent too few recovers on
 * the next cycle; a gate that admits ten too many costs the human their
 * machine. The derivation says the charge is being made, so it is visible
 * rather than a mystery in the arithmetic.
 */
export type UnobservedReason = 'no-measurement' | 'restored' | 'after-window';

/** Starts already admitted that no instrument has priced. */
export interface UnobservedStarts {
  /** How many. Zero is the ordinary steady-state answer. */
  count: number;
  /** What each is charged while unobserved — {@link startingAgentCost}. */
  cost: AgentCost;
  /** `count × cost.cores`: CPU the observation cannot contain. */
  cores: number;
  /** `count × cost.residentBytes`: memory the kernel has not been asked for. */
  bytes: number;
  /**
   * Why these count as unobserved. Reported because the three are genuinely
   * different situations and a reader who cannot tell them apart cannot judge
   * the charge:
   *
   *   - `no-measurement` — nothing has ever been sampled, so nothing is priced.
   *   - `restored`       — the figure was carried across a daemon restart, so
   *                        it was sampled by a process that never saw these
   *                        agents. **This is the cold-boot case, which is where
   *                        the incident happened both times.**
   *   - `after-window`   — a live window exists and these starts happened after
   *                        it opened.
   */
  because: UnobservedReason;
}

/**
 * What one *starting* agent is charged: the larger of the published estimate
 * and the seed, per dimension.
 *
 * `Math.max` rather than the seed outright so an operator override or a
 * measurement above the seed is never undercut by this term — a machine whose
 * agents really do cost more than the seed must not have that finding thrown
 * away by the thing that exists to be careful.
 */
export function startingAgentCost(cost: AgentCost): AgentCost {
  return {
    cores: Math.max(cost.cores, MEASURED_AGENT_COST.cores),
    residentBytes: Math.max(cost.residentBytes, MEASURED_AGENT_COST.residentBytes)
  };
}

/**
 * How long a start can still be *in flight*.
 *
 * A start is charged here because no instrument can have priced it yet. That is
 * a claim with a shelf life: an agent that started two minutes ago has either
 * reached the census — in which case it is counted in `running`, its CPU is
 * inside `cpuBusyCores` and its pages are already out of `availableBytes` — or
 * it never will, because the pane died on the way up. In the first case the
 * charge has become a double charge; in the second it is a charge for an agent
 * that does not exist. Neither is the thing KAN-258 set out to price.
 *
 * Two minutes, matching {@link CPU_SAMPLE_MAX_AGE_SECONDS}, because it is the
 * same question in a different dimension — how long may an observation still be
 * said to describe *now* — and two answers to one question drift apart.
 *
 * WHAT THIS FIXES, AND WHY IT IS NOT A LOOSENING (KAN-365)
 *
 * The `after-window` branch below was always bounded: a start older than the
 * current window is not counted, and the window is 60s. The other two branches
 * were not bounded by anything, and router.ts's own leak guard asserted in
 * prose that they were — *"it stops being charged on its own, because
 * `unobservedStartsAmong` ignores anything older than the current measurement
 * window"*. That sentence is false exactly when there is no window to be older
 * than, which is the `no-measurement` branch, which is the state an idle fleet
 * is in permanently. So a single start that never reached the census charged
 * 0.75 core for as long as the daemon ran, on the machine least able to explain
 * why: `epic/KAN-59` was refused three activations by it while nothing was
 * running. This restores the bound the caller already believed it had.
 */
export const UNOBSERVED_START_MAX_AGE_SECONDS = 120;

/**
 * How many of `startedAt` the measurement cannot have contained.
 *
 * Pure, and drivable from a script with no daemon and no /proc — which is what
 * lets a proof exercise the cold-boot case without booting anything. `now` is
 * passed rather than read so that stays true of the clock as well: a horizon
 * measured against `Date.now()` inside here would make every case below
 * untestable except in real time.
 *
 * `startedAt` is wall-clock ms per *currently running* agent this daemon
 * started; the caller prunes agents that have gone, and {@link
 * UNOBSERVED_START_MAX_AGE_SECONDS} bounds what a failure of that pruning can
 * cost.
 *
 * The `restored` branch is the one that matters and it is not a special case
 * bolted on: a restored figure was sampled by the previous daemon, so by
 * definition it contains nothing this one has started. Charging all of them is
 * not conservatism, it is the literal truth about what that figure measured.
 *
 * A `stale` figure (KAN-365) deliberately takes no branch of its own. It was
 * sampled by this daemon over a fleet that has since gone, so its window closed
 * before any agent running now started — the ordinary `after-window`
 * comparison already charges every one of them, and a branch that said the same
 * thing in different words would be one more place to keep in step.
 */
export function unobservedStartsAmong(
  startedAt: readonly number[],
  measured: MeasuredAgentCost | null,
  now: number
): { count: number; because: UnobservedReason } {
  // Applied before the branches rather than inside each of them: the bound is
  // about the start, not about which figure happens to be published, and a
  // per-branch version is how the two unbounded branches came to exist.
  const horizon = now - UNOBSERVED_START_MAX_AGE_SECONDS * 1000;
  const inFlight = startedAt.filter((at) => at > horizon);
  if (!measured) return { count: inFlight.length, because: 'no-measurement' };
  if (measured.provenance === 'restored') {
    return { count: inFlight.length, because: 'restored' };
  }
  // The window's opening edge, not its close: a window from t0 to t1 contains
  // the full cost only of an agent that existed for all of it, so an agent that
  // appeared partway through was averaged over a period it was mostly absent
  // from.
  const windowOpenedAt = measured.sampledAt - measured.windowSeconds * 1000;
  let count = 0;
  for (const at of inFlight) {
    if (at > windowOpenedAt) count++;
  }
  return { count, because: 'after-window' };
}

/**
 * The herdr server's own appetite. It sat at ~49% of a core with seven agents
 * attached, and it is not an agent, so it comes off the top of the budget
 * before agents are counted.
 *
 * This is subtracted only from the *static* cap. Live headroom is computed
 * against the load average, which already contains herdr's real usage —
 * subtracting it there would charge for it twice.
 */
export const HERDR_OVERHEAD_CORES = 0.5;

/**
 * How much wall-clock time the machine spent stalled, from
 * /proc/pressure/{io,memory}.
 *
 * Both figures are the `full avg10` field: the share of the last ten seconds in
 * which *every* non-idle task was stalled on that resource — the machine
 * stopped, not merely something waiting. See the header for why `full` rather
 * than `some`, and why both files rather than just `io`.
 *
 * Either may be null on its own if that file is unreadable; both null means PSI
 * is unavailable on this machine and the term is inert.
 */
export interface StallFacts {
  /** `/proc/pressure/io` → `full avg10`, as a percentage. */
  ioFullPercent: number | null;
  /** `/proc/pressure/memory` → `full avg10`, as a percentage. Swap-in lives here. */
  memoryFullPercent: number | null;
}

/**
 * The share of wall time at or above which no agent is admitted, whatever the
 * other three terms say.
 *
 * A decision rather than a measurement, and the header says so at length: no
 * outage calibrated it, because this gap has no observed instance. It is
 * calibrated from the other side — 20% is ~3x the worst reading (7.24%) a
 * deliberate I/O stress test produced on the machine this was written on, and
 * ~20x its ordinary 1.05% average under a full agent fleet.
 *
 * BUTCHR_STALL_PERCENT overrides it; a value above 100 disables the term, since
 * `full` cannot exceed 100.
 */
export const STALL_REFUSE_PERCENT = 20;

/**
 * Which pressure file produced the figure that was compared against the
 * threshold — the worse of the two. Reported so a refusal can say "stalled on
 * I/O" or "thrashing on memory", which are different problems with different
 * operator responses, and KAN-60 is about a refusal naming its real constraint.
 */
export type StallSource = 'io' | 'memory';

/**
 * The worse of the two stall figures, and which one it was, or null when
 * neither could be read.
 *
 * Exported because the verify script drives it directly: a max() over two
 * nullable numbers is exactly the kind of thing that quietly returns 0 instead
 * of null on the day one file disappears, and that failure would silently
 * disable the gate while every report still printed a figure.
 */
export function worstStall(
  stall: StallFacts | null | undefined
): { percent: number; source: StallSource } | null {
  if (!stall) return null;
  const candidates: Array<{ percent: number; source: StallSource }> = [];
  if (typeof stall.ioFullPercent === 'number' && Number.isFinite(stall.ioFullPercent)) {
    candidates.push({ percent: stall.ioFullPercent, source: 'io' });
  }
  if (typeof stall.memoryFullPercent === 'number' && Number.isFinite(stall.memoryFullPercent)) {
    candidates.push({ percent: stall.memoryFullPercent, source: 'memory' });
  }
  if (candidates.length === 0) return null;
  // Ties go to io: it is the cheaper of the two to act on (a disk is a thing an
  // operator can look at), and a tie between two equal figures is arbitrary
  // anyway. reduce with `>` rather than `>=` keeps that stable.
  return candidates.reduce((worst, c) => (c.percent > worst.percent ? c : worst));
}

/** What the machine looks like right now, or what we pretend it looks like. */
export interface MachineFacts {
  cores: number;
  totalBytes: number;
  /** Memory that could be handed out now: MemAvailable, not MemFree. */
  availableBytes: number;
  /**
   * 1-minute load average. Reported, never gated on since KAN-201 — it is the
   * number a human feels, and it is not a count of cores in use.
   */
  load1: number;
  /**
   * Cores actually being consumed right now, measured from /proc/stat over a
   * recent window. This is the CPU analogue of `availableBytes`: what the
   * machine says it is spending, not what it says is queued.
   *
   * Null (or absent) when nothing could be measured — no /proc, no window
   * closed yet, a window too old to describe "now". The arithmetic then falls
   * back to `min(load1, cores)`, which over-states CPU use on a contended
   * machine and therefore refuses sooner: the conservative direction, and
   * labelled `load-average` in every report so nobody mistakes it for a
   * measurement.
   */
  busyCores?: number | null;
  /** Length of the window `busyCores` was averaged over, in seconds. */
  busyWindowSeconds?: number | null;
  /**
   * How much of the last ten seconds this machine spent stalled on I/O or on
   * memory reclaim, from /proc/pressure (KAN-218). Null or absent where PSI is
   * unavailable, and the term is then inert and says so — there is deliberately
   * no fallback instrument, see the header.
   */
  stall?: StallFacts | null;
}

/**
 * Cores held back for the person using the machine.
 *
 * A whole core on a small box, because that is the complaint this exists to
 * answer: the human is *using* this desktop, and a fleet that eats it to the
 * last cycle is a fleet that gets turned off. It grows with core count so a
 * big machine is not left with a token reservation, but slowly — a 64-core
 * box does not need 16 cores held back to stay responsive.
 */
export function humanReserveCores(cores: number): number {
  return Math.max(1, Math.floor(cores / 8));
}

/**
 * Memory held back for everything that is not an agent: the browser, the
 * editor, the page cache that keeps the machine from feeling like treacle.
 * 15% of RAM, floored at 2 GB so a small machine is not left with scraps.
 */
export function humanReserveBytes(totalBytes: number): number {
  return Math.max(2 * GIB, Math.floor(totalBytes * 0.15));
}

/** Which measurement set the static cap. */
export type CapBound = 'cpu' | 'memory' | 'floor' | 'configured';

/**
 * Which measurement set the live headroom.
 *
 * `'load'` was retired by KAN-201 along with the term that produced it. It is
 * deliberately not kept as an alias: a reader who sees `cpu` must be able to
 * conclude that CPU actually in use is what bound, and a payload that could
 * still say `load` would leave that in doubt.
 *
 * `'stall'` (KAN-218) is the odd one out and is meant to be: the other three
 * are counts of agents and the smallest wins, while `'stall'` is a veto that
 * zeroes them. It is reported here anyway because the question this type
 * answers — "which thing said no" — is the same question, and a caller that
 * switched on three cases and silently mishandled a fourth is why it is in the
 * union rather than a separate boolean nobody reads.
 */
export type HeadroomBound = 'cap' | 'cpu' | 'memory' | 'stall';

/** Where the `busyCores` figure the CPU term divided came from. */
export type CpuBusySource = 'measured' | 'load-average';

export interface Capacity {
  machine: MachineFacts;
  /**
   * What one agent is believed to cost: the override, the measurement, or the
   * seed. Every static term divides by exactly this. The live CPU term may
   * divide by less — see {@link liveCoresBound} — and says so when it does.
   */
  cost: AgentCost;
  /**
   * Where each dimension of `cost` came from: override, measured, restored, or
   * seed. This is the *origin* of the estimate; whether the live term then
   * declined to believe it is {@link liveCoresBound}, because "who produced
   * this number" and "was it believed" are different questions and collapsing
   * them would make one of them unanswerable.
   */
  costSource: { residentBytes: CostSource; cores: CostSource };
  /**
   * Set when the per-agent core estimate implied more CPU than the machine
   * reported in use, and `headroomByCpu` therefore divided by less than
   * `cost.cores` (KAN-204). Null in the ordinary case. `cap` and `capByCpu`
   * are never affected.
   */
  liveCoresBound: CoresBound | null;
  /**
   * Starts admitted that no instrument has priced yet, and what they were
   * charged (KAN-258). `count: 0` is the ordinary steady-state answer.
   *
   * Never null: a term that is inert must say so rather than vanish, for the
   * reason KAN-218 gives about the stall veto — a gate that is silent when it
   * is not protecting you is a gate you will assume is.
   */
  unobservedStarts: UnobservedStarts;
  /**
   * The damped measurement that was consulted, if the sampler had one. Kept
   * even when an override beat it, so a report can say what was ignored.
   */
  measured: MeasuredAgentCost | null;
  reservedForHuman: { cores: number; bytes: number };

  /** Concurrent *task* agents this hardware supports, load aside. */
  cap: number;
  capByCpu: number;
  capByMemory: number;
  capBoundBy: CapBound;
  /** Set when BUTCHR_MAX_AGENTS overrode the derivation. */
  configuredCap: number | null;

  /** Task agents alive right now. Supervisors are not among them. */
  running: number;
  /**
   * Epic and story agents alive right now. Never counted in `running` and
   * never charged on CPU — they supervise rather than do the work, and measure
   * at a fourteenth of a task agent's cores.
   *
   * They are no longer charged *nowhere*: the memory they hold is reserved off
   * the static cap, because on that dimension they cost the same as a task
   * agent. See {@link supervisorReserve} and SUPERVISOR_MEMORY_BYTES.
   */
  supervisors: number;
  /**
   * The memory held back for those supervisors, and how it was arrived at
   * (KAN-276). `count: 0` makes it inert, and it is still reported then, for
   * the reason KAN-218 gives about the stall veto: a term that is silent when
   * it is not protecting you is a term you will assume is.
   */
  supervisorReserve: SupervisorReserve;

  /** How many more can be started right now. Never negative. */
  headroom: number;
  headroomByCap: number;
  /**
   * What CPU allows right now: (cores − in use − reserved) ÷ per-agent cores.
   * Replaced `headroomByLoad` in KAN-201 — see the header for why the load
   * average was the wrong instrument rather than a strict one.
   */
  headroomByCpu: number;
  headroomByMemory: number;
  headroomBoundBy: HeadroomBound;
  /**
   * What the three counting terms agreed on before the stall veto was applied
   * (KAN-218). Equal to `headroom` in the ordinary case; when `stalled` is true
   * this is the room the machine would otherwise have had, and printing it is
   * what makes the veto's effect visible instead of looking like a machine that
   * happened to be full.
   */
  headroomBeforeStall: number;

  /** The cores-in-use figure the CPU term used, and where it came from. */
  cpuBusyCores: number;
  cpuBusySource: CpuBusySource;
  /** Window `cpuBusyCores` was averaged over; null on the fallback path. */
  cpuBusyWindowSeconds: number | null;

  /**
   * The worse of the two `/proc/pressure` `full avg10` figures — the share of
   * the last ten seconds in which every non-idle task was stalled (KAN-218).
   * Null where PSI is unavailable, which is also the one case where nothing
   * bounds I/O saturation at all.
   */
  stallPercent: number | null;
  /** Which pressure file `stallPercent` came from. Null when it is null. */
  stallSource: StallSource | null;
  /** Both figures as read, so a report can show the one that did not bind. */
  stall: StallFacts | null;
  /** The threshold `stallPercent` was compared against, after any override. */
  stallRefusePercent: number;
  /**
   * True when the veto fired: the machine is stalled and no agent is admitted
   * however much CPU and memory are free. Always false where PSI is
   * unavailable — an absent instrument refuses nothing.
   */
  stalled: boolean;

  /** True when starting another agent would exceed what the machine can carry. */
  atCapacity: boolean;
}

export interface CapacityOptions {
  /**
   * Operator-set costs (BUTCHR_AGENT_CORES / BUTCHR_AGENT_MEMORY_MB). A
   * dimension set here beats the measurement outright — see the header for
   * the precedence argument.
   */
  overrides?: Partial<AgentCost>;
  /** The damped live measurement, if there is one. Beats the seed, loses to
   * overrides. */
  measured?: MeasuredAgentCost | null;
  /** A cap the operator set by hand, bypassing the derivation entirely. */
  configuredCap?: number | null;
  /**
   * Supervisors observed running.
   *
   * This used to say "reported only; it changes no arithmetic", and since
   * KAN-276 it changes one line: it sizes the memory reserve held back from the
   * static cap. It still changes nothing on CPU, and still never enters
   * `running`.
   */
  supervisorsRunning?: number;
  /**
   * BUTCHR_SUPERVISOR_MEMORY_MB: what one supervisor is charged, overriding
   * both the measurement and {@link SUPERVISOR_MEMORY_BYTES}. Zero disables the
   * reserve, which is the way to turn the term off deliberately rather than by
   * pretending no supervisors are running.
   */
  supervisorMemoryOverride?: number | null;
  /**
   * Agents this daemon has started that the instruments cannot have priced
   * yet, from {@link unobservedStartsAmong} (KAN-258).
   *
   * Absent or 0 leaves every term exactly as it was before this option
   * existed, which is what keeps `computeCapacity` callable from the scripts
   * and reports that have no ledger to consult.
   */
  unobservedStarts?: number;
  /** Why they are unobserved, for the derivation. Ignored when the count is 0. */
  unobservedBecause?: UnobservedReason;
  /**
   * BUTCHR_STALL_PERCENT: the stall threshold, overriding
   * {@link STALL_REFUSE_PERCENT}. Above 100 disables the term.
   */
  stallRefusePercent?: number | null;
}

/**
 * The whole model, as a pure function of measured figures.
 *
 * Pure so the same arithmetic can be run against hardware nobody here owns —
 * which is the property being bought, and which
 * `scripts/verify-agent-capacity.mjs` exercises.
 */
export function computeCapacity(
  machine: MachineFacts,
  running: number,
  options: CapacityOptions = {}
): Capacity {
  // The divisor, one dimension at a time: override, else measured, else seed.
  // Per dimension rather than all-or-nothing so an operator who has re-measured
  // cores does not silently discard the memory measurement too.
  const overrides = options.overrides ?? {};
  const measured = options.measured ?? null;
  const pick = (dim: keyof AgentCost): { value: number; source: CostSource } => {
    const override = overrides[dim];
    if (override !== undefined) return { value: override, source: 'override' };
    // A restored or stale figure is a real measurement of this fleet and beats
    // the seed for the same reason a fresh one does — it is the only number
    // anybody has actually taken here. Each is labelled differently because of
    // what is no longer true of it: `restored` was taken by a process that is
    // no longer running, `stale` over a fleet that is no longer running.
    if (measured) {
      return { value: measured[dim], source: costSourceOf(measured) };
    }
    return { value: MEASURED_AGENT_COST[dim], source: 'seed' };
  };
  const resident = pick('residentBytes');
  const coreCost = pick('cores');
  const cost: AgentCost = { residentBytes: resident.value, cores: coreCost.value };
  const costSource = { residentBytes: resident.source, cores: coreCost.source };
  const configuredCap = options.configuredCap ?? null;

  const reservedCores = humanReserveCores(machine.cores);
  const reservedBytes = humanReserveBytes(machine.totalBytes);

  // What the supervisors that are actually running hold (KAN-276). Measured
  // over the same window as the agent cost when that window contained one,
  // else the seed; an operator override beats both, by the same precedence as
  // every other cost figure here.
  //
  // Null and 0 are different answers and are kept different: a window with no
  // supervisors in it has measured nothing, so it falls to the seed, while an
  // explicit override of 0 is an operator turning the term off.
  const supervisorsRunning = Math.max(0, Math.floor(options.supervisorsRunning ?? 0));
  const supervisorMemory = ((): { value: number; source: CostSource } => {
    const override = options.supervisorMemoryOverride;
    if (override !== undefined && override !== null) return { value: override, source: 'override' };
    const m = measured?.supervisorResidentBytes;
    if (measured && typeof m === 'number' && Number.isFinite(m) && m > 0) {
      return { value: m, source: costSourceOf(measured) };
    }
    return { value: SUPERVISOR_MEMORY_BYTES, source: 'seed' };
  })();
  const supervisorReserve: SupervisorReserve = {
    count: supervisorsRunning,
    perSupervisorBytes: supervisorMemory.value,
    bytes: supervisorsRunning * supervisorMemory.value,
    source: supervisorMemory.source
  };

  // Static cap: what the hardware supports with nothing else assumed. herdr's
  // share comes off here because the load average cannot be consulted for a
  // machine that is not this one.
  //
  // Supervisor memory comes off here too, and only here (KAN-276). `totalBytes`
  // is the machine's RAM with nothing running, so a supervisor's ~650 MB was
  // charged nowhere in this term; `availableBytes` in the live term below has
  // already had it taken out by the kernel, so charging it there as well would
  // charge it twice. Same asymmetry as HERDR_OVERHEAD_CORES, same reason.
  //
  // Their CPU is still not charged, and that is the measurement rather than a
  // leftover: a supervisor spends ~0.012 core against a task agent's ~0.19.
  const cpuBudget = machine.cores - reservedCores - HERDR_OVERHEAD_CORES;
  const capByCpu = Math.floor(Math.max(0, cpuBudget) / cost.cores);
  const capByMemory = Math.floor(
    Math.max(0, machine.totalBytes - reservedBytes - supervisorReserve.bytes) /
      cost.residentBytes
  );

  let cap: number;
  let capBoundBy: CapBound;
  if (configuredCap !== null) {
    cap = configuredCap;
    capBoundBy = 'configured';
  } else {
    cap = Math.min(capByCpu, capByMemory);
    capBoundBy = capByCpu <= capByMemory ? 'cpu' : 'memory';
    if (cap < 1) {
      // A machine too small to carry one agent by this arithmetic can still
      // run one, badly, and refusing everything would make Butchr useless
      // rather than careful. This floor is a decision, not a measurement, and
      // it says so in capBoundBy.
      cap = 1;
      capBoundBy = 'floor';
    }
  }

  // Live headroom: three independent answers to "how many more right now",
  // and the smallest wins. They disagree on purpose — count knows nothing
  // about effort, load knows nothing about memory, and memory knows nothing
  // about either.
  const headroomByCap = Math.max(0, cap - running);

  // CPU actually in use, the same way memory asks what is actually available.
  // Every agent, every supervisor, herdr and the human are all in this figure —
  // so it is still the one term that distinguishes three idle agents from three
  // that are compiling, which was the load term's one real virtue and is kept.
  // It is also where running epic and story agents are felt at all: never
  // charged in the model, their real (usually small) usage shows up here and in
  // availableBytes below — a running supervisor's memory is memory the kernel
  // has already stopped offering.
  //
  // What changed in KAN-201 is only which instrument answers "how much of this
  // machine is spent": cores consumed over a recent window, instead of a
  // 1-minute run-queue average that counted I/O waits as CPU demand and
  // disagreed with capByCpu by two orders of magnitude. See the header.
  //
  // The fallback keeps the gate honest when the instrument is missing: no
  // sample means `min(load1, cores)`, which over-states use on a contended
  // machine and so refuses sooner rather than later. On a platform with no load
  // average either (Windows reports 0) this term goes inert, exactly as the
  // load term did, and the count and memory terms still bind.
  //
  // The human's reserve is subtracted here even though what they are already
  // using is inside `cpuBusyCores`, and that is not double-charging: the same
  // is true of the memory term, where the browser's resident pages are already
  // out of `availableBytes`. The reserve is room for what the human might start
  // doing next, which is the complaint the gate exists to answer.
  const cpuBusySource: CpuBusySource =
    typeof machine.busyCores === 'number' ? 'measured' : 'load-average';
  const cpuBusyCores =
    cpuBusySource === 'measured'
      ? Math.max(0, Math.min(machine.cores, machine.busyCores as number))
      : Math.max(0, Math.min(machine.cores, machine.load1));
  const cpuBusyWindowSeconds =
    cpuBusySource === 'measured' ? machine.busyWindowSeconds ?? null : null;

  // The estimate against the machine's own account of itself (KAN-204), for
  // this term and this term only — see the header for why the static cap above
  // is deliberately left dividing by the unbounded figure.
  //
  // Every claude tree on the box counts toward what the fleet is claiming to
  // spend. Supervisors are never *charged* for capacity, but they are running
  // processes and their CPU is inside `cpuBusyCores`, so leaving them out of
  // the multiplication would compare an estimate for six trees against the
  // observed cost of three and fail to catch a contradiction that is there.
  //
  // Two exemptions, both stated in boundCoresByObservedCpu's contract: an
  // operator override is not overruled by anything, and the load-average
  // fallback is not a measurement and so cannot falsify one.
  // Starts nothing has priced yet (KAN-258). Charged at the seed-or-higher
  // figure, and charged to the *live* terms only: the static cap describes
  // hardware and must not move with who happens to be starting, for the same
  // reason `capByCpu` is deliberately left out of the `liveCoresBound`
  // correction above.
  const unobservedCount = Math.max(0, Math.floor(options.unobservedStarts ?? 0));
  const unobservedCost = startingAgentCost(cost);
  const unobservedStarts: UnobservedStarts = {
    count: unobservedCount,
    cost: unobservedCost,
    cores: unobservedCount * unobservedCost.cores,
    bytes: unobservedCount * unobservedCost.residentBytes,
    because: options.unobservedBecause ?? 'after-window'
  };

  // Unobserved starts are excluded from the tree count here, and that is the
  // half of KAN-258 that is easiest to get backwards. `boundCoresByObservedCpu`
  // asks whether the estimate implies more CPU than the machine reports in use
  // — a genuine contradiction when every tree in the count is spending. An
  // agent that has not begun spending makes `implied > busy` **by
  // construction**, so counting it would manufacture the contradiction and the
  // term would respond by *lowering* the divisor, i.e. by finding more room the
  // more agents were mid-start. That is positive feedback pointed at the
  // failure this ticket is about. Excluding them keeps the comparison between
  // trees that are actually in `busyCores`, and leaves the divisor at the
  // larger, published figure — the conservative direction.
  //
  // Supervisors are excluded too, and KAN-276 is why the previous line was
  // right before it and wrong after. `impliedFleetCores` is `cost.cores ×
  // agentTrees`, and `cost.cores` used to be the average over *every* tree, so
  // multiplying it by every tree was dimensionally sound. It is now the cost of
  // a **task agent** specifically, measured at ~14x what a supervisor spends,
  // so multiplying it by a count that includes supervisors would claim a fleet
  // CPU nobody is spending — manufacturing the contradiction on an idle machine
  // exactly as an unobserved start does, and provoking the same response of
  // *lowering* the divisor and finding more room. Counting only task trees
  // makes the bound fire strictly less often, which leaves the larger published
  // divisor standing: the conservative direction, and the one this ticket's
  // hard constraint requires.
  //
  // The supervisors' own CPU stays in `busyCores` on the other side of the
  // comparison, where it belongs — it is real CPU the machine is spending, and
  // leaving it in only makes the estimate harder to falsify.
  const agentTrees = Math.max(0, running - unobservedCount);
  const liveCoresBound =
    coreCost.source === 'override' || cpuBusySource !== 'measured'
      ? null
      : boundCoresByObservedCpu(cost.cores, agentTrees, cpuBusyCores);
  const liveCoreCost = liveCoresBound ? liveCoresBound.used : cost.cores;

  const liveCpuBudget =
    machine.cores - cpuBusyCores - reservedCores - unobservedStarts.cores;
  const headroomByCpu = Math.max(0, Math.floor(liveCpuBudget / liveCoreCost));

  const headroomByMemory = Math.max(
    0,
    Math.floor(
      Math.max(0, machine.availableBytes - reservedBytes - unobservedStarts.bytes) /
        cost.residentBytes
    )
  );

  const headroomBeforeStall = Math.min(headroomByCap, headroomByCpu, headroomByMemory);
  // Ties resolve to the term the reader can most directly act on: closing an
  // agent is a decision, waiting for the machine to go quiet is not.
  const countingBoundBy: HeadroomBound =
    headroomByCap <= headroomByCpu && headroomByCap <= headroomByMemory
      ? 'cap'
      : headroomByCpu <= headroomByMemory
        ? 'cpu'
        : 'memory';

  // The stall veto (KAN-218). Not a fourth count — a machine that is stalled
  // has no room at all, whatever the three terms above computed, and there is
  // no per-agent I/O cost to divide by that would make it one. See the header.
  //
  // `worst` is null exactly when /proc/pressure could not be read, and a
  // missing instrument must refuse nothing: `stalled` is false, the derivation
  // says the term is inert, and I/O saturation is bounded by nothing on that
  // machine. That is a named hole rather than a silent one.
  const worst = worstStall(machine.stall);
  const stallRefusePercent = options.stallRefusePercent ?? STALL_REFUSE_PERCENT;
  const stalled = worst !== null && worst.percent >= stallRefusePercent;
  const headroom = stalled ? 0 : headroomBeforeStall;
  // `stall` names itself only when it is the reason there is no room. If the
  // board was already full the count still binds, by the same tie rule as
  // above: the reader can close an agent, and cannot hurry a disk.
  const headroomBoundBy: HeadroomBound =
    stalled && headroomBeforeStall > 0 ? 'stall' : countingBoundBy;

  return {
    machine,
    cost,
    costSource,
    liveCoresBound,
    unobservedStarts,
    measured,
    reservedForHuman: { cores: reservedCores, bytes: reservedBytes },
    cap,
    capByCpu,
    capByMemory,
    capBoundBy,
    configuredCap,
    running,
    supervisors: supervisorsRunning,
    supervisorReserve,
    headroom,
    headroomByCap,
    headroomByCpu,
    headroomByMemory,
    headroomBoundBy,
    headroomBeforeStall,
    cpuBusyCores,
    cpuBusySource,
    cpuBusyWindowSeconds,
    stallPercent: worst ? worst.percent : null,
    stallSource: worst ? worst.source : null,
    stall: machine.stall ?? null,
    stallRefusePercent,
    stalled,
    atCapacity: headroom <= 0
  };
}

/**
 * Memory the kernel believes it could hand out, which is not MemFree: most of
 * a healthy machine's "free" memory is page cache it will surrender on
 * demand. On this machine the two differ by 8 GB, which is the difference
 * between "no room for an agent" and "room for sixteen".
 *
 * Falls back to os.freemem() where /proc/meminfo is not readable, which
 * understates availability — the conservative direction.
 */
export function readAvailableBytes(): number {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const line = meminfo.split('\n').find((l) => l.startsWith('MemAvailable:'));
    const kb = Number(line?.trim().split(/\s+/)[1]);
    if (Number.isFinite(kb) && kb > 0) return kb * 1024;
  } catch {
    // not Linux, or /proc is not mounted
  }
  return os.freemem();
}

/**
 * `full avg10` out of one /proc/pressure file, as a percentage.
 *
 * The file looks like this, and both lines are always present except for
 * /proc/pressure/cpu, whose `full` is undefined at system level:
 *
 *     some avg10=2.27 avg60=2.32 avg300=1.98 total=537036752
 *     full avg10=0.01 avg60=0.18 avg300=0.24 total=313582439
 *
 * Returns null for every way this can fail — no file (pre-4.20, no CONFIG_PSI,
 * not Linux), no `full` line, an unparseable field, a figure outside 0..100 —
 * because the caller's handling of "no instrument" is to leave the gate open
 * and say so, and a half-read file must take that path rather than produce a
 * number that looks measured.
 *
 * The path is a parameter so the proof can drive it from fixtures. That is not
 * only convenience: a gate whose arithmetic is verified on facts the test
 * supplied has not been shown to receive real ones (KAN-145), and pointing the
 * real parser at a file containing a real stalled machine's numbers is what
 * closes the seam between the parse and the arithmetic.
 */
export function readPressureFull(path: string): number | null {
  try {
    const line = fs
      .readFileSync(path, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('full '));
    if (!line) return null;
    const field = line.split(/\s+/).find((f) => f.startsWith('avg10='));
    if (!field) return null;
    const value = Number(field.slice('avg10='.length));
    if (!Number.isFinite(value) || value < 0 || value > 100) return null;
    return value;
  } catch {
    // no /proc/pressure: pre-4.20, CONFIG_PSI off, or not Linux
    return null;
  }
}

/**
 * How stalled this machine is, from both pressure files.
 *
 * `root` is a parameter for the same reason {@link readPressureFull}'s path is:
 * the proof points it at a directory of fixtures so that the reader, the
 * worst-of-two, the veto and the sentence are all exercised by one call, rather
 * than the arithmetic being tested against a `StallFacts` a script typed out.
 */
export function readStallFacts(root = '/proc/pressure'): StallFacts {
  return {
    ioFullPercent: readPressureFull(`${root}/io`),
    memoryFullPercent: readPressureFull(`${root}/memory`)
  };
}

/**
 * CPU actually consumed, which is not the load average.
 *
 * /proc/stat's first line is cumulative jiffies per CPU state since boot, so
 * one reading says nothing; two readings a window apart say what fraction of
 * the machine was spent in between. That fraction times the core count is the
 * quantity the CPU headroom term divides — the same units agent-cost.ts
 * measures per agent tree, and the reason the two now agree.
 *
 * `idle` and `iowait` both count as *not busy*. A core in iowait had nothing
 * runnable to put on it; it is available to a new agent. Counting it as spent
 * is precisely the run-queue confusion KAN-201 removed, since iowait tasks are
 * a large part of what inflates the load average above real CPU use.
 */
interface CpuTicks {
  busy: number;
  idle: number;
  /** Date.now() when the reading was taken. */
  at: number;
}

/** A closed window: what fraction of the machine was spent over it. */
interface CpuBusyWindow {
  busyFraction: number;
  windowSeconds: number;
  /** Date.now() when the window closed. */
  closedAt: number;
}

/**
 * Windows shorter than this are not closed; the baseline is kept so the next
 * read closes a usable one. Two capacity calls a few milliseconds apart would
 * otherwise divide two nearly-equal jiffy counters and report noise.
 */
const CPU_WINDOW_MIN_SECONDS = 2;
/**
 * A window longer than this is thrown away rather than closed: it would be an
 * average over five minutes of history, which is the very property (a lagging
 * average standing in for "now") that this term exists to stop relying on.
 */
const CPU_WINDOW_MAX_SECONDS = 300;
/**
 * How long a closed window still counts as describing "now". Past this the
 * measurement is discarded and the arithmetic degrades to the labelled
 * load-average fallback rather than dividing by a figure from another era.
 */
const CPU_SAMPLE_MAX_AGE_SECONDS = 120;

function readCpuTicks(): CpuTicks | null {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    if (!line.startsWith('cpu ')) return null;
    // user nice system idle iowait irq softirq steal guest guest_nice
    const v = line.trim().split(/\s+/).slice(1).map(Number);
    if (v.length < 5 || v.some((n) => !Number.isFinite(n))) return null;
    const idle = v[3] + v[4];
    const total = v.reduce((s, n) => s + n, 0);
    return { busy: total - idle, idle, at: Date.now() };
  } catch {
    // not Linux, or /proc is not mounted
    return null;
  }
}

let cpuBaseline: CpuTicks | null = null;
let cpuWindow: CpuBusyWindow | null = null;

/**
 * Advance the /proc/stat sampler and return the most recent completed window,
 * or null if there is none fresh enough to use.
 *
 * Self-maintaining on purpose: every `readMachineFacts()` calls it, so a daemon
 * that answers capacity questions keeps its own measurement warm without any
 * caller having to know that it exists. The daemon also ticks it on a short
 * timer (daemon.ts) so the first question after a quiet spell is answered from
 * a window that closed seconds ago rather than from the fallback — but nothing
 * here *depends* on that timer running, which is what keeps the degraded path
 * a degradation rather than a silent difference between the daemon and every
 * script that imports this module.
 */
export function sampleCpuBusy(): CpuBusyWindow | null {
  const ticks = readCpuTicks();
  if (!ticks) {
    // No instrument at all: forget everything rather than let an old window
    // outlive the thing that produced it.
    cpuBaseline = null;
    cpuWindow = null;
    return null;
  }
  if (cpuBaseline) {
    const seconds = (ticks.at - cpuBaseline.at) / 1000;
    const busy = ticks.busy - cpuBaseline.busy;
    const idle = ticks.idle - cpuBaseline.idle;
    const total = busy + idle;
    if (seconds >= CPU_WINDOW_MIN_SECONDS && seconds <= CPU_WINDOW_MAX_SECONDS) {
      // total <= 0 means the counters did not move (or went backwards, which
      // happens across a suspend): no window, and the baseline restarts.
      if (total > 0 && busy >= 0) {
        cpuWindow = { busyFraction: busy / total, windowSeconds: seconds, closedAt: ticks.at };
      }
      cpuBaseline = ticks;
    } else if (seconds > CPU_WINDOW_MAX_SECONDS) {
      cpuBaseline = ticks;
    }
    // Shorter than the minimum: keep the baseline, so the next read closes.
  } else {
    cpuBaseline = ticks;
  }
  if (cpuWindow && (Date.now() - cpuWindow.closedAt) / 1000 > CPU_SAMPLE_MAX_AGE_SECONDS) {
    cpuWindow = null;
  }
  return cpuWindow;
}

/** What this machine actually is. Never throws. */
export function readMachineFacts(): MachineFacts {
  // os.cpus() returns [] in some containers; a machine with no CPUs is not a
  // thing, so a wrong-but-usable 1 beats a division by zero.
  const cores = os.cpus().length || 1;
  const cpu = sampleCpuBusy();
  return {
    cores,
    totalBytes: os.totalmem(),
    availableBytes: readAvailableBytes(),
    // os.loadavg() is [0,0,0] on Windows. Nothing gates on it since KAN-201,
    // but it is still what a report quotes as the number the human feels.
    load1: os.loadavg()[0],
    // Null until the first window closes — one capacity call cannot measure a
    // rate. The fallback is labelled, and it is the conservative direction.
    busyCores: cpu ? cpu.busyFraction * cores : null,
    busyWindowSeconds: cpu ? cpu.windowSeconds : null,
    // Unlike the CPU window, this needs no baseline and no timer: PSI is
    // already an average over the last ten seconds, so the first call answers
    // as well as the thousandth. Both fields are null where PSI is absent.
    stall: readStallFacts()
  };
}

function envNumber(name: string, allowZero = false): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    console.warn(
      `${name}=${raw} is not a ${allowZero ? 'non-negative' : 'positive'} number; ignoring it`
    );
    return undefined;
  }
  return value;
}

/**
 * Operator overrides, because someone who has re-measured their own hardware
 * should not have to argue with figures taken on a laptop in July 2026.
 *
 *   BUTCHR_MAX_AGENTS        — set the cap outright, skipping the derivation
 *   BUTCHR_AGENT_MEMORY_MB   — resident cost of one agent
 *   BUTCHR_AGENT_CORES       — cores one active agent tree spends
 *   BUTCHR_STALL_PERCENT     — the /proc/pressure `full avg10` at which no
 *                              agent is admitted; above 100 disables the term
 *   BUTCHR_SUPERVISOR_MEMORY_MB — memory reserved per running supervisor;
 *                              0 disables the reserve (KAN-276)
 */
export function optionsFromEnv(): CapacityOptions {
  const memoryMb = envNumber('BUTCHR_AGENT_MEMORY_MB');
  const cores = envNumber('BUTCHR_AGENT_CORES');
  // Only the dimensions actually set become overrides: an unset variable must
  // leave room for the measurement, not silently pin the seed.
  const overrides: Partial<AgentCost> = {};
  if (memoryMb !== undefined) overrides.residentBytes = memoryMb * MIB;
  if (cores !== undefined) overrides.cores = cores;
  // Zero is allowed here and nowhere else in this function: it is how an
  // operator turns the supervisor reserve off deliberately, which has to be
  // distinguishable from not having set the variable at all.
  const supervisorMemoryMb = envNumber('BUTCHR_SUPERVISOR_MEMORY_MB', true);
  return {
    overrides,
    configuredCap: envNumber('BUTCHR_MAX_AGENTS') ?? null,
    stallRefusePercent: envNumber('BUTCHR_STALL_PERCENT') ?? null,
    supervisorMemoryOverride:
      supervisorMemoryMb !== undefined ? supervisorMemoryMb * MIB : null
  };
}

/**
 * The damped live measurement, held here so every caller of readCapacity —
 * each per-connection router and the daemon's own — divides by the same
 * figure. The daemon's sampler (daemon.ts) is the only writer: it sets a
 * fresh value after each valid window and clears back to null the moment the
 * instrument fails, which is what makes "whatever breaks, capacity still
 * answers from the seed" true without any caller having to know.
 */
let liveMeasuredCost: MeasuredAgentCost | null = null;

export function setMeasuredAgentCost(measured: MeasuredAgentCost | null): void {
  liveMeasuredCost = measured;
}

export function getMeasuredAgentCost(): MeasuredAgentCost | null {
  return liveMeasuredCost;
}

/**
 * Capacity of this machine, with `running` task agents already on it.
 *
 * `supervisors` is how many epic and story agents were found running. It is
 * passed so the report can say so, not so the arithmetic can charge for them —
 * they are never charged at all.
 */
export function readCapacity(
  running: number,
  supervisors = 0,
  /**
   * When each still-running agent this daemon started was started, wall-clock
   * ms. The count that is charged is derived here rather than by the caller, so
   * the one place that knows which measurement is live is the one place that
   * decides which starts it cannot have contained (KAN-258).
   */
  startedAt: readonly number[] = []
): Capacity {
  const unobserved = unobservedStartsAmong(startedAt, liveMeasuredCost, Date.now());
  return computeCapacity(readMachineFacts(), running, {
    ...optionsFromEnv(),
    measured: liveMeasuredCost,
    supervisorsRunning: supervisors,
    unobservedStarts: unobserved.count,
    unobservedBecause: unobserved.because
  });
}

const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GiB`;

/**
 * WHETHER THE CEILING FORECASTS ANYTHING, WHICH IS NOT THE SAME QUESTION AS
 * WHAT IT IS RIGHT NOW
 *
 * `running + headroom` is one number whichever term produced it, and the three
 * terms differ in what that number is *worth* to a reader planning starts:
 *
 * - `'static'` — bound by `cap`. Nothing live moves it; the ceiling is the
 *   configured number and reaching it is arithmetic.
 * - `'projects'` — bound by `memory`. Every admitted start is **charged to
 *   this term**: it takes one `cost.residentBytes` out of `availableBytes`,
 *   which is the numerator the term divides. So the count does not chase
 *   itself — `running + headroomByMemory` stays put as starts land, and the
 *   figure is a forecast of where they stop rather than a description of now.
 *   It is still a reading: `availableBytes` also moves for reasons that are
 *   nobody's agent, so the forecast drifts with the machine even though it
 *   does not drift with the fleet.
 * - `'drifts'` — bound by `cpu` or vetoed by `stall`. Neither term is charged
 *   per start: `cpuBusyCores` measures what the fleet is *doing* and a stall
 *   measures the disk, so five idle agents and five compiling ones give
 *   different ceilings at the same population. This reading describes the
 *   moment it was taken and forecasts nothing.
 *
 * KAN-517 is the ticket that made this distinction load-bearing rather than
 * decorative. It measured `headroom: 3` at `running: 2` (bound by cpu) and
 * again at `running: 4` (bound by memory) and read the pair as one stable
 * ceiling of about 7 — two readings of two *different* terms, one of which
 * forecasts and one of which does not. A ceiling published without this field
 * would have been exactly the artifact that ticket exists to complain about:
 * a sentence claiming more than its mechanism covers.
 *
 * THE WORKED CASE, WHICH IS TWO AGENTS DISAGREEING AND BOTH BEING RIGHT
 *
 * Within the same half hour on 2026-08-18, three readings of this machine:
 *
 *     06:13:49Z  running 2  headroom 3  bound by cpu      (epic/KAN-203)
 *     06:18:49Z  running 4  headroom 3  bound by memory   (epic/KAN-203)
 *     ~06:2xZ    running 5  headroom 1  bound by cpu      (epic/KAN-59)
 *     06:23:49Z  running 5  headroom 3  bound by memory   (task/KAN-517)
 *
 * The last two are minutes apart at the *same* population and disagree by two.
 * Neither is wrong. `epic/KAN-59` caught the machine busy, so the cpu term —
 * which measures what the fleet is *doing* — bound at 1 and `stability` would
 * have read `'drifts'`; the memory term, which measures how many there are,
 * bound at 3 and reads `'projects'`. **A ceiling is a reading with a timestamp
 * on it, and this field is what says whether the timestamp matters.** Quoting
 * either figure as "the ceiling of this machine" without it is the thing that
 * made two correct measurements look like a contradiction.
 *
 * AND THIS IS BUTCHR'S GATE, WHICH IS NOT THE ONLY ONE IN THE PATH
 *
 * `epic/KAN-59` established (KAN-517, 2026-08-18) that CrabCast carries an
 * independent headroom gate of its own — same `if (!capacity.atCapacity)`
 * shape, its own file, its own terms — and that the two disagreed four times
 * in a day, Butchr reporting headroom 5 while CrabCast refused at 3/3. Their
 * KAN-504 activation was refused with `refused by crabcast-daemon:
 * activate_agent refused: at capacity`, which is not this gate at all.
 *
 * So everything computed here is **an answer about Butchr's admission**, and a
 * start can still be refused downstream by a ceiling this figure knows nothing
 * about. That limit is stated in the rendered text as well as here, because a
 * reader who takes this for the machine's only ceiling will go looking for a
 * bug in the wrong daemon. Recorded second-hand and deliberately not verified
 * from source: reading CrabCast's tree is invariant 10, permanent.
 */
export type CeilingStability = 'static' | 'projects' | 'drifts';

/**
 * The largest task-agent fleet this machine will actually admit, with the
 * arithmetic and the term that set it.
 *
 * @see effectiveCeilingOf — and read its contract before adding this to
 * {@link Capacity}, which is deliberately where it does not live.
 */
export interface EffectiveCeiling {
  /**
   * Task agents this machine admits in total, override aside. `running +
   * headroom`: what is already on it plus what the gate will still let on.
   */
  ceiling: number;
  /** The term that set it — the same one {@link Capacity.headroomBoundBy} names. */
  boundBy: HeadroomBound;
  /** Whether this figure forecasts where starts stop, or only describes now. */
  stability: CeilingStability;
  /**
   * Slots the configured cap offers that the gate will not admit: `cap −
   * ceiling`, floored at 0. Zero means the cap is reachable and there is
   * nothing to report — which is most machines, and why every caller here
   * says nothing when it is 0.
   */
  shortfall: number;
  /** The arithmetic, in the figures it used, naming the term. One line. */
  arithmetic: string;
}

/**
 * The effective ceiling — KAN-517.
 *
 * THE FINDING THIS ANSWERS: `cap` is not consulted at admission. The gate is
 * `if (!capacity.atCapacity)` and `atCapacity` is `headroom <= 0`, so setting
 * `BUTCHR_MAX_AGENTS=10` sets a number the gate never reads. Measured on the
 * human's 15.4 GiB machine on 2026-08-18, the memory term admitted about eight
 * while `cap` read 10 — so the configured number bound lower than configured,
 * and nothing said so. Two of the three surfaces a person actually reads
 * opened with `5/10`, which subtracts to five free slots when three were.
 *
 * THIS IS A REPORT AND NOT A TERM, AND THAT IS ENFORCED BY WHERE IT LIVES
 *
 * KAN-517's acceptance criterion 5 forbids changing any live capacity term
 * without first-hand human authorisation, and the obvious way to break it is
 * not malice — it is a later author finding `effectiveCeiling` sitting on
 * {@link Capacity} beside `headroom` and reasonably concluding the gate ought
 * to consider it. So it is not on {@link Capacity}. It is a pure function of
 * one, computed by whoever is about to *render* it, and the admission path in
 * router.ts holds a `Capacity` that has no such property to read.
 *
 * That is a type-level fact rather than a comment asking nicely: `capacity.
 * effectiveCeiling` does not compile, so the gate cannot start consulting this
 * by accident, and a deliberate change has to import this function and say so
 * in a diff. Preferring the unrepresentable state to the assertion is this
 * repository's own rule (prompts/task.md, 2026-08-11); this is that rule
 * applied to a number whose whole risk is being mistaken for a limit.
 *
 * `daemon/scripts/verify-effective-ceiling.mjs` holds the proof, including the
 * red drive: the gate refusing a start with its own measured figures while
 * `cap` still reads 10.
 *
 * THE THREE OPTIONS KAN-517 PUT UP, AND WHY ONLY THIS ONE WAS TAKEN
 *
 * The ticket offered three and required that the two not taken be named with
 * their reasons, because the next person to meet a cap of 10 that admits 8
 * will reach for one of them. Recorded here rather than only on the ticket:
 * this file is where somebody about to raise a number is already reading.
 *
 *   1. **Accept it — treat the cap as a ceiling, not a target — and make the
 *      gap visible.** TAKEN, and it is the only one of the three that changes
 *      no live term. Everything above is that option.
 *
 *   2. **Raise the reachable number by lowering the human reserve or the
 *      per-agent figure.** NOT TAKEN. It changes a live term, which KAN-517's
 *      own criterion 5 forbids without recorded first-hand human
 *      authorisation, and the human was away. On the substance it is also
 *      weaker than it looks: `cost.residentBytes` is *measured* (757 MB on
 *      2026-08-18), so lowering it does not spend anything — it makes the
 *      model understate what an agent costs while the agent goes on costing
 *      it, which buys admissions and not memory. Lowering
 *      {@link humanReserveBytes} does spend something real, and the thing it
 *      spends is the one this file names as the failure in that direction:
 *      the human's own machine becoming unusable. That is a price worth
 *      paying or not, and it is theirs to set.
 *
 *   3. **Make the configured cap authoritative and drop the live memory
 *      veto.** NOT TAKEN, and this is the one to argue with hardest, because
 *      it is the reading that makes "get rid of dynamic cap calculations"
 *      come out tidiest. Three costs, the third of which is new:
 *
 *      - **The out-of-memory risk, named because it is the whole cost.** Ten
 *        task agents plus four supervisors at ~760 MB each is ~10.6 GiB on a
 *        15.4 GiB machine the human also uses. The live memory term is the
 *        only thing between that arithmetic and the OOM killer.
 *      - **`epic/KAN-59` argued against it on the ticket, from the other side
 *        of the same seam**: cap as ceiling and headroom as admission is the
 *        shape they want kept, and closing this by gating on `cap` "deletes
 *        the machine-side protection".
 *      - **It would not even deliver 10.** CrabCast runs an independent
 *        headroom gate (see above), so removing this one moves the refusal
 *        downstream rather than removing it — and moves it somewhere with no
 *        ceiling report and no derivation attached. The visible symptom would
 *        improve and the actual limit would not.
 *
 * ⚠ **And no single term is the lever anyway.** The binding term moved
 * between every pair of readings taken on 2026-08-18 — cpu, memory, cpu,
 * memory — so raising whichever one bound last leaves the other one binding.
 * KAN-517 says this in its own words: "this is not one weak term that could
 * simply be raised." `epic/KAN-203` measured the end state at 07:05Z: **both
 * live terms at zero independently**, cpu allowing 0 and memory allowing 0.
 *
 * ⚠ **AND THE LOAD AVERAGE IS NOT THE LEVER EITHER, WHICH LOOKS LIKE ONE.**
 * Two readings twenty-six minutes apart, same fleet size, same answer:
 *
 *     06:39:49Z  running 6  headroom 0  bound by cpu  load1 16.63
 *     07:05:50Z  running 6  headroom 0  bound by cpu  load1  4.76
 *
 * `load1` fell by a factor of three and moved nothing, because it is reported
 * and is explicitly not what gates (KAN-201 retired it in favour of
 * {@link Capacity.cpuBusyCores}). Anyone reaching for the intuitive measure
 * gets that pair as the counter-example.
 *
 * WHAT THE CEILING COUNTS, WHICH IS NOT WHAT A READER WILL ASSUME
 *
 * ⚠ **It counts agents ALIVE, not agents working**, and on this board those
 * are routinely very different numbers. An agent that has finished, opened its
 * PR and is waiting on an approval marker is idle — it spends almost no CPU —
 * **and it still holds its full resident set**, which is exactly the quantity
 * the memory term divides. `epic/KAN-203` measured the case on KAN-517:
 * six agents running, four of them parked awaiting a decision, `cpuBusyCores`
 * 1.91 across the whole fleet, and ~704 MB held by each of the parked ones.
 *
 * **That is correct behaviour and nothing here proposes changing it** — a
 * parked agent must stay alive to answer its approval and carry its merge, and
 * standing one down means its PR never lands. But it means the honest reading
 * of this figure is *"how many agents can exist at once"*, and never *"how
 * many can work at once"*. On a queue with several PRs in flight the parked
 * ones can be most of the fleet, as they were when this was written. The
 * rendered text says so for the same reason this comment does: a ceiling a
 * reader silently converts into a throughput is the artifact this whole ticket
 * is about.
 */
export function effectiveCeilingOf(c: Capacity): EffectiveCeiling {
  const ceiling = c.running + c.headroom;
  const stability: CeilingStability =
    c.headroomBoundBy === 'cap'
      ? 'static'
      : c.headroomBoundBy === 'memory'
        ? 'projects'
        : 'drifts';

  // Named per term rather than generically, because "bound by memory" tells a
  // reader which lever moves the number and a bare figure does not. The
  // KAN-60 rule — lead with the constraint, not the count — applied to the
  // ceiling instead of to the refusal.
  const sum = `${c.running} running + ${c.headroom} more`;
  const arithmetic =
    c.headroomBoundBy === 'cap'
      ? `${sum} = ${ceiling}, the configured cap itself — no live term is binding below it`
      : c.headroomBoundBy === 'memory'
        ? `${sum} = ${ceiling}, set by memory: ` +
          `(${gib(c.machine.availableBytes)} available − ${gib(c.reservedForHuman.bytes)} reserved) ` +
          `÷ ${Math.round(c.cost.residentBytes / MIB)} MB per agent = ${c.headroomByMemory}. ` +
          'Each start is charged to this term, so the figure holds as they land'
        : c.headroomBoundBy === 'cpu'
          ? `${sum} = ${ceiling}, set by cpu: ` +
            `(${c.machine.cores} cores − ${c.cpuBusyCores.toFixed(2)} in use − ` +
            `${c.reservedForHuman.cores} reserved) ÷ ` +
            `${(c.liveCoresBound ? c.liveCoresBound.used : c.cost.cores).toFixed(3)} per agent = ` +
            `${c.headroomByCpu}. This term measures what the fleet is doing, not how ` +
            'many there are, so the figure moves when they go quiet'
          : `${sum} = ${ceiling}, vetoed by a ${c.stallPercent?.toFixed(2)}% ` +
            `${c.stallSource} stall — the terms allowed ${c.headroomBeforeStall} and a ` +
            'stalled machine admits nothing whatever they say';

  return {
    ceiling,
    boundBy: c.headroomBoundBy,
    stability,
    shortfall: Math.max(0, c.cap - ceiling),
    arithmetic
  };
}

/**
 * The derivation in words, with the numbers that produced it.
 *
 * This is the whole point of the ticket: an agent refused for capacity has to
 * say why, in figures the reader can check, the way KAN-24 made a refused
 * spawn name its cause instead of failing obscurely.
 */
export function describeCapacity(c: Capacity): string {
  const m = c.machine;
  const lines: string[] = [];

  lines.push(
    `machine: ${m.cores} cores, ${gib(m.totalBytes)} RAM ` +
    `(${gib(m.availableBytes)} available), load average ${m.load1.toFixed(2)}`
  );
  // The CPU figure gets its own line with its provenance, for the same reason
  // the cost figures do: since KAN-201 this is what the live gate divides, and
  // a reader must be able to tell a /proc/stat measurement from the
  // load-average fallback that stands in when there is none. The load average
  // stays on the line above, reported and no longer consulted — printing only
  // the figure that gates would hide the very disagreement between the two
  // that motivated the change.
  lines.push(
    c.cpuBusySource === 'measured'
      ? `cpu in use: ${c.cpuBusyCores.toFixed(2)} of ${m.cores} cores (measured over ` +
        `${Math.round(c.cpuBusyWindowSeconds ?? 0)}s); the load average is reported above and ` +
        'is not what gates'
      : `cpu in use: ${c.cpuBusyCores.toFixed(2)} of ${m.cores} cores (load-average fallback — ` +
        'no /proc/stat window; this over-states use and so refuses sooner)'
  );
  // Every cost figure carries its provenance, because the divisor can now be
  // a measurement: a reader must be able to tell a number this fleet produced
  // from the 2026-07-31 seed and from a number the operator typed in.
  lines.push(
    `agent cost: ${Math.round(c.cost.residentBytes / MIB)} MB resident (${c.costSource.residentBytes}), ` +
    `${c.cost.cores} core while active (${c.costSource.cores})`
  );
  // The contradiction gets its own line with the whole comparison on it,
  // because it is the one place where a term divides by something other than
  // the cost figure printed above. A reader who cannot see both numbers cannot
  // tell a bounded headroom from headroom off a suspiciously low measurement,
  // and the arithmetic on the headroom line below would not reproduce (KAN-204).
  if (c.liveCoresBound) {
    const b = c.liveCoresBound;
    lines.push(
      `  contradicted: ${b.published} core × ${b.agentTrees} agent tree(s) = ` +
      `${b.impliedFleetCores.toFixed(2)} cores, more than the ${b.busyCores.toFixed(2)} cores this ` +
      `machine reports in use in total — so the estimate is not describing this fleet. The cpu ` +
      `headroom term below divides ${b.busyCores.toFixed(2)} ÷ ${b.agentTrees} = ${b.used.toFixed(3)} ` +
      'instead, which still charges the fleet for every busy core on the machine, yours and ' +
      "herdr's included. The cap above is unaffected and still divides by " +
      `${b.published}`
    );
  }
  // The starts-in-flight charge gets its own line whenever it is non-zero, and
  // says which of the three situations produced it. Both live terms below
  // subtract it, so without this line neither of their arithmetic reproduces —
  // and the derivation's whole promise is that it does.
  if (c.unobservedStarts.count > 0) {
    const u = c.unobservedStarts;
    const why =
      u.because === 'restored'
        ? 'the cost figure was carried across a daemon restart, so it was sampled by a ' +
          'process that never saw these agents — every start since this daemon came up is ' +
          'unpriced. This is the cold-boot case'
        : u.because === 'no-measurement'
          ? 'nothing has been sampled yet, so no start has been priced'
          : 'they started after the current measurement window opened';
    lines.push(
      `starts in flight: ${u.count} agent(s) admitted that no instrument has priced — ${why}. ` +
      `Charged ${u.cost.cores} core and ${Math.round(u.cost.residentBytes / MIB)} MB each ` +
      `(the larger of the estimate above and the seed, because a damped figure measures ` +
      `agents that have settled and these have not), so ${u.cores.toFixed(2)} cores and ` +
      `${gib(u.bytes)} come off the two live terms below. The cap does not move. This charge ` +
      `may double-count cost the cpu window has already caught, which is the conservative ` +
      `direction and is deliberate (KAN-258)`
    );
  }
  if (c.measured) {
    const beaten: string[] = [];
    if (c.costSource.residentBytes === 'override') {
      beaten.push(`BUTCHR_AGENT_MEMORY_MB overrides its ${Math.round(c.measured.residentBytes / MIB)} MB`);
    }
    if (c.costSource.cores === 'override') {
      beaten.push(`BUTCHR_AGENT_CORES overrides its ${c.measured.cores} core`);
    }
    const restored = c.measured.provenance === 'restored';
    const stale = c.measured.provenance === 'stale';
    // Disclosed in the derivation rather than left as a timestamp the reader has
    // to subtract, because the age *is* the caveat: a retained figure is a real
    // measurement of this fleet whose only defect is when it was taken (KAN-365).
    const staleMinutes = Math.round((Date.now() - c.measured.sampledAt) / 60000);
    // The two figures are averaged over two populations since KAN-276 — cores
    // over the task-agent trees, memory over every tree — so the line names the
    // population beside each figure rather than printing one tree count and
    // leaving the reader to assume it covers both. Where they are equal (an
    // all-task fleet, or a record written before the split) it prints as it
    // always did.
    const memoryTrees = c.measured.memoryAgentTrees ?? c.measured.agentTrees;
    const split = memoryTrees !== c.measured.agentTrees;
    lines.push(
      `  ${restored ? 'restored (damped)' : stale ? 'stale (damped)' : 'measured (damped)'}: ` +
      `${Math.round(c.measured.residentBytes / MIB)} MB` +
      (split ? ` over ${memoryTrees} agent tree(s)` : '') + ', ' +
      `${c.measured.cores} core per ${split ? 'task ' : ''}agent tree — ` +
      `${c.measured.agentTrees} ${split ? 'task ' : ''}tree(s) ` +
      `over a ${Math.round(c.measured.windowSeconds)}s window ` +
      `ending ${new Date(c.measured.sampledAt).toISOString()}` +
      (split
        ? '; the core figure excludes supervisor trees (measured at ~1/14th of a task ' +
          'agent) and the memory figure does not (measured the same within noise)'
        : '') +
      (restored
        ? ', carried across a daemon restart — sampled by the previous daemon, not this one; ' +
          'the next window replaces it with a measurement of this fleet'
        : '') +
      (stale
        ? `, held on for ${staleMinutes} minute(s) because no task agent has been running to ` +
          're-measure — this is what agents cost on this machine, taken over the fleet named ' +
          'above and not refreshed since it finished. It is kept rather than discarded because ' +
          'an idle fleet is the cheapest moment to start work and reverting to the seed makes ' +
          'the machine claim it can afford least exactly then (KAN-365). The first agent to ' +
          'start is charged the seed until a window has priced it, so this figure opens the cap ' +
          'without opening the gate; past the retention ceiling it is dropped for the seed'
        : '') +
      (beaten.length ? `; ignored: ${beaten.join(', ')}` : '')
    );
  } else if (c.costSource.residentBytes === 'seed' || c.costSource.cores === 'seed') {
    lines.push(
      '  no live measurement; seed figures are the 2026-07-31 constants, ' +
      'not a measurement of this fleet'
    );
  }
  lines.push(
    `reserved for you: ${c.reservedForHuman.cores} core(s), ${gib(c.reservedForHuman.bytes)}`
  );

  if (c.capBoundBy === 'configured') {
    lines.push(`cap: ${c.cap} task agents (set by BUTCHR_MAX_AGENTS, derivation skipped)`);
  } else {
    lines.push(
      `cap: ${c.cap} task agents — ` +
      `CPU allows ${c.capByCpu} ((${m.cores} cores − ${c.reservedForHuman.cores} reserved ` +
      `− ${HERDR_OVERHEAD_CORES} for herdr) ÷ ${c.cost.cores} core/agent), ` +
      `memory allows ${c.capByMemory} ((${gib(m.totalBytes)} − ${gib(c.reservedForHuman.bytes)}` +
      (c.supervisorReserve.bytes > 0
        ? ` − ${gib(c.supervisorReserve.bytes)} for supervisors`
        : '') +
      `) ÷ ${Math.round(c.cost.residentBytes / MIB)} MB/agent)` +
      (c.capBoundBy === 'floor'
        ? '; both said 0, floored to 1 because a machine that can run nothing is not a useful answer'
        : `; bound by ${c.capBoundBy}`)
    );
  }

  // The supervisor reserve, spelled out whenever there is one. It is the only
  // term whose size depends on how many agents of a kind the cap does not count
  // happen to be running, so a reader who cannot see the count and the
  // per-supervisor figure cannot reproduce `capByMemory` by hand — which is the
  // promise this whole function exists to keep (KAN-276).
  if (c.supervisorReserve.count > 0) {
    lines.push(
      `supervisor memory reserve: ${gib(c.supervisorReserve.bytes)} ` +
      `(${c.supervisorReserve.count} supervisor(s) × ` +
      `${Math.round(c.supervisorReserve.perSupervisorBytes / MIB)} MB, ` +
      `${c.supervisorReserve.source}) — held back from the cap's memory budget only. ` +
      'Their CPU is not charged (measured at ~1/14th of a task agent); their memory is, ' +
      'because it is not. Live headroom below does not subtract it again: a running ' +
      "supervisor's pages are already out of the available figure it divides"
    );
  }

  lines.push(
    `running: ${c.running} task agent(s)` +
    (c.supervisors > 0
      ? `, plus ${c.supervisors} epic/story supervisor agent(s) ` +
        '(not counted against the cap, and not measured into the per-agent cost above)'
      : '')
  );
  // The stall term gets its own line whether or not it fired, and says so when
  // it cannot fire at all. A gate that is silent when it is inert is a gate a
  // reader will assume is protecting them (KAN-218) — the whole reason this
  // ticket exists is that a protection disappeared without a line anywhere
  // saying it had.
  if (c.stallPercent === null) {
    lines.push(
      'io/memory stall: no /proc/pressure on this machine (needs Linux 4.20+ with CONFIG_PSI), ' +
      'so this term is inert and nothing here bounds a machine thrashing on swap or stalled ' +
      'on a failing disk. The cpu term deliberately counts iowait as idle, and there is no ' +
      'honest fallback instrument — see capacity.ts'
    );
  } else {
    const io = c.stall?.ioFullPercent;
    const mem = c.stall?.memoryFullPercent;
    const both =
      `${typeof io === 'number' ? `${io.toFixed(2)}% io` : 'io unreadable'}, ` +
      `${typeof mem === 'number' ? `${mem.toFixed(2)}% memory` : 'memory unreadable'}`;
    lines.push(
      `io/memory stall: ${both} (/proc/pressure \`full avg10\` — the share of the last 10s in ` +
      `which every non-idle task was stalled); worst is ${c.stallPercent.toFixed(2)}% on ` +
      `${c.stallSource}, against a ${c.stallRefusePercent}% threshold` +
      (c.stalled
        ? ` — AT OR OVER, so headroom is 0 regardless of the ${c.headroomBeforeStall} the ` +
          'terms below allow. Swap-in is accounted to memory pressure, not io, which is why ' +
          'both files are read'
        : ' — under, so this term does not bind')
    );
  }
  lines.push(
    `headroom: ${c.headroom} more — ` +
    `count allows ${c.headroomByCap} (${c.cap} cap − ${c.running} running), ` +
    `cpu allows ${c.headroomByCpu} ((${m.cores} cores − ${c.cpuBusyCores.toFixed(2)} in use ` +
    `− ${c.reservedForHuman.cores} reserved` +
    (c.unobservedStarts.count > 0
      ? ` − ${c.unobservedStarts.cores.toFixed(2)} for ${c.unobservedStarts.count} start(s) in flight`
      : '') +
    ') ÷ ' +
    (c.liveCoresBound
      ? `${c.liveCoresBound.used.toFixed(3)}, the bounded figure from the contradiction above`
      : `${c.cost.cores}`) + '), ' +
    `memory allows ${c.headroomByMemory} ((${gib(m.availableBytes)} available ` +
    `− ${gib(c.reservedForHuman.bytes)} reserved` +
    (c.unobservedStarts.count > 0
      ? ` − ${gib(c.unobservedStarts.bytes)} for ${c.unobservedStarts.count} start(s) in flight`
      : '') +
    `) ÷ ${Math.round(c.cost.residentBytes / MIB)} MB)` +
    // The veto is arithmetic the reader cannot see in the three terms, so it is
    // spelled out where it acts rather than only on the line above: min(...) of
    // the three would not reproduce `headroom`, and the derivation promises it
    // does.
    (c.stalled
      ? `; the smallest of those is ${c.headroomBeforeStall}, vetoed to 0 by the ` +
        `${c.stallPercent?.toFixed(2)}% ${c.stallSource} stall above; bound by ${c.headroomBoundBy}`
      : `; bound by ${c.headroomBoundBy}`)
  );

  // The effective ceiling (KAN-517), stated here because this is the one place
  // that promises the whole arithmetic. Every line above answers "how much room
  // is there now"; none of them answers "how many will this machine ever take",
  // and the gap between that number and `cap` is what nothing said.
  //
  // Printed unconditionally, including when there is no gap. A line that
  // appeared only on machines whose cap is unreachable would be a line whose
  // absence a reader has to interpret, and "the ceiling is the cap" is the
  // answer they came for as much as the other one is (the KAN-218 rule about
  // the stall term, applied here).
  const ceiling = effectiveCeilingOf(c);
  lines.push(
    `effective ceiling: ${ceiling.ceiling} task agent(s) alive — working OR ` +
    `parked awaiting a decision, which cost the same memory — ${ceiling.arithmetic}` +
    (ceiling.shortfall > 0
      ? `. The cap is ${c.cap}, so ${ceiling.shortfall} of its slot(s) cannot be reached: ` +
        `${ceiling.boundBy} binds first, and admission never reads the cap at all`
      : `. The cap is ${c.cap} and it is reachable`) +
    ` (this figure ${
      ceiling.stability === 'projects'
        ? 'holds as starts land — they are charged to the term that set it'
        : ceiling.stability === 'static'
          ? 'is fixed until the cap is changed'
          : 'describes this moment only — the term that set it measures activity, not population'
    }). It is a reading and not a constant: quote it with the time it was taken. ` +
    'This is Butchr\'s admission only — CrabCast runs an independent headroom gate ' +
    'and can refuse a start this figure says there is room for'
  );

  return lines.join('\n');
}

/**
 * One line for callers that only have room for one.
 *
 * When there is no room, it leads with the binding constraint rather than
 * with the count (KAN-60): opening "2/10 task agents" on a load-bound refusal
 * read as "at capacity" by count, which the line's own figures contradicted.
 */
export function summarizeCapacity(c: Capacity): string {
  // Cores in use, not the load average: a one-line refusal that quotes a
  // figure nothing gated on sends the reader after the wrong lever, which is
  // the KAN-60 defect in a new costume. The load average is one line down in
  // the derivation for anyone who wants to compare the two.
  // Where the divisor came from, on the one line a caller may be reading
  // (KAN-365). The ticket's candidate 2 — "make its use loud in `summary`
  // rather than only in `derivation`" — kept, and kept for BOTH of the figures
  // that are not a live measurement of this fleet: a seed nobody took here, and
  // a measurement whose fleet has gone. Silent in the ordinary case, so this
  // says something exactly when there is something to say.
  const provenanceNote =
    c.costSource.cores === 'seed'
      ? '; cost figures are the 2026-07-31 seed — nothing has been measured on this fleet'
      : c.costSource.cores === 'stale'
        ? `; cost figures were measured ${Math.round((Date.now() - (c.measured?.sampledAt ?? 0)) / 60000)} ` +
          'minute(s) ago and held — no task agent has run since'
        : c.costSource.cores === 'restored'
          ? '; cost figures were carried across a daemon restart'
          : '';
  // The effective ceiling, on the one line most callers read (KAN-517).
  //
  // `5/10 task agents` was the specific text that ticket named as misleading,
  // and the defect is in the *fraction*, not in either number: a reader
  // subtracts, gets five slots free, and the gate was holding at three. Both
  // figures were honest and the shape they were in was not — the same failure
  // the `unobservedStarts` block was renamed for (a rate beside an amount,
  // with nothing saying which was which).
  //
  // So when the cap cannot be reached, the fraction is taken apart into the
  // three numbers it was hiding, in the order that decides anything: what is
  // running, what this machine will actually take, what somebody configured.
  // Nothing is dropped — `10 configured` still appears, and now it appears
  // somewhere a reader cannot subtract from it by accident.
  //
  // Unchanged when there is no gap, which is the ordinary case and every
  // machine whose cap is reachable. This says something exactly when there is
  // something to say, the same rule `provenanceNote` above follows.
  const ceiling = effectiveCeilingOf(c);
  const population =
    ceiling.shortfall > 0
      ? `${c.running} running, ${ceiling.ceiling} reachable on this machine, ` +
        `${c.cap} configured`
      : `${c.running}/${c.cap} task agents`;
  const figures =
    `${population}, room for ${c.headroom} more ` +
    `(${c.machine.cores} cores, ${c.cpuBusyCores.toFixed(2)} in use, ` +
    `${gib(c.machine.availableBytes)} available` +
    provenanceNote +
    // Only when it fired: a stall figure on every line would be noise, and its
    // absence must not read as "measured and fine" on a machine that has no
    // instrument at all — the derivation is where that distinction lives.
    (c.stalled ? `, ${c.stallPercent?.toFixed(2)}% ${c.stallSource} stall` : '') +
    `; bound by ${c.headroomBoundBy})`;
  if (!c.atCapacity) return figures;
  // Count-bound, the figures already open with N-of-cap; repeating the whole
  // reason would bury a one-line summary under its own headline.
  return c.headroomBoundBy === 'cap'
    ? `at capacity: ${figures}`
    : `${capacityHeadline(c)}; ${figures}`;
}

/**
 * The one sentence that says why there is no room, without the arithmetic
 * behind it.
 *
 * Separate from {@link capacityRefusal} because the sidepanel has a line, not
 * a page: the panel shows this and puts the full derivation behind a
 * disclosure, while an MCP caller and the log get the whole thing. Both are
 * built from the same numbers, so they cannot drift into disagreeing.
 */
/**
 * The clause a refusal adds when part of what refused it is a start already
 * admitted but not yet visible to any instrument (KAN-258).
 *
 * Empty in the ordinary case, so a refusal on a settled machine reads exactly
 * as it did before this term existed. Both the CPU and the memory branch use
 * it, because both terms subtract the charge.
 */
function unobservedClause(c: Capacity): string {
  const u = c.unobservedStarts;
  if (u.count < 1) return '';
  return (
    `; ${u.cores.toFixed(2)} core and ${gib(u.bytes)} of that is ${u.count} agent(s) ` +
    `already started and not yet spending — they are charged the ${u.cost.cores}-core seed ` +
    `until an instrument has seen them, so this refusal counts starts in flight`
  );
}

export function capacityReason(c: Capacity): string {
  if (c.headroomBoundBy === 'stall') {
    // Every figure the veto compared, in the order it compared them, so the
    // sentence is checkable without opening the derivation — and naming which
    // resource, because "your disk is stalling" and "you are thrashing on swap"
    // send the reader to different levers, which is the KAN-60 requirement.
    const what =
      c.stallSource === 'memory'
        ? 'stalled reclaiming memory — swap thrash, not a shortage of free memory'
        : 'stalled on I/O';
    return (
      `this machine spent ${c.stallPercent?.toFixed(2)}% of the last 10 seconds with every ` +
      `non-idle task ${what}, at or above the ${c.stallRefusePercent}% threshold, so no agent ` +
      `is admitted even though CPU and memory allow ${c.headroomBeforeStall}`
    );
  }
  if (c.headroomBoundBy === 'cpu') {
    // Every figure the CPU term divided, in the order it divides them, so the
    // sentence is checkable without opening the derivation: in use, total,
    // held back. KAN-201 changed the arithmetic, so it changed this sentence
    // with it — a refusal explaining an arithmetic that is no longer the
    // arithmetic is worse than no explanation at all.
    return (
      `${c.cpuBusyCores.toFixed(2)} of this machine's ${c.machine.cores} cores are already ` +
      `in use${c.cpuBusySource === 'measured' ? '' : ' (estimated from the load average)'}, and ` +
      `${c.reservedForHuman.cores} core${c.reservedForHuman.cores === 1 ? ' is' : 's are'} ` +
      `held back for you` +
      // Named in the sentence, not only in the derivation: a refusal whose
      // figures do not add up without a term the reader cannot see sends them
      // to check the wrong thing, which is KAN-60's defect. It also has to be
      // said out loud that some of what refused you has not happened yet.
      unobservedClause(c)
    );
  }
  if (c.headroomBoundBy === 'memory') {
    return (
      `only ${gib(c.machine.availableBytes)} of memory is available, ` +
      `${gib(c.reservedForHuman.bytes)} of that is held back for you` +
      unobservedClause(c)
    );
  }
  return (
    `${c.running} task agent${c.running === 1 ? ' is' : 's are'} already running ` +
    `against a cap of ${c.cap}`
  );
}

/**
 * The headline of a refusal: the binding constraint, named, then the figures
 * that make it checkable.
 *
 * KAN-60: a load-bound refusal used to be headlined "at capacity" with the
 * cap count leading — read by a human as "2 of 10, at capacity", which was
 * false by its own numbers (2 running against a cap of 10) and pointed at the
 * wrong constraint entirely. `headroomBoundBy` already knows which term
 * bound; the headline renders from it, so "at capacity" is said only when
 * the count is what bound.
 */
export function capacityHeadline(c: Capacity): string {
  const constraint =
    c.headroomBoundBy === 'cpu'
      ? 'not enough cpu'
      : c.headroomBoundBy === 'memory'
        ? 'not enough memory'
        : c.headroomBoundBy === 'stall'
          ? // Not "not enough" anything: the machine has room and cannot use
            // it, which is a different problem and must not read as a shortage.
            c.stallSource === 'memory'
            ? 'machine thrashing on memory'
            : 'machine stalled on i/o'
          : 'at capacity';
  return `${constraint} — ${capacityReason(c)}`;
}

/** Why an activation was refused, with the arithmetic that refused it. */
export function capacityRefusal(c: Capacity, what: string): string {
  // "Deactivate an agent to make room" is false advice on a stalled machine: a
  // stall is not a slot shortage, and freeing a slot destroys an agent's work
  // without moving the figure that refused. Saying it anyway would send the
  // reader to a lever that does nothing, which is the KAN-60 defect wearing the
  // new term's clothes. router.ts declines to offer a victim for the same
  // reason; this is the same decision said in the sentence.
  const remedy =
    c.headroomBoundBy === 'stall'
      ? `Wait for the machine to stop stalling — the figure above is a 10-second average, ` +
        `so give it at least that long — or fix what is stalling it. Deactivating an agent ` +
        `will not help: this is not a shortage of slots. Pass override: true to start it ` +
        `anyway (the override is recorded with these numbers).`
      : `Deactivate an agent to make room, or pass override: true to start it anyway ` +
        `(the override is recorded with these numbers).`;
  return `Refusing to activate ${what}: ${capacityHeadline(c)}.\n${describeCapacity(c)}\n${remedy}`;
}
