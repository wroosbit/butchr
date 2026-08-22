import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RuntimeMode } from './agent-runtime.js';
import { workspaceDirFor, workspacesRoot } from './workspace-dir.js';

/**
 * What population a census-derived answer actually covers, said on the answer
 * (KAN-630).
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 *
 * Since the workforce moved to a second machine, the manager box runs
 * supervisors and the workforce box runs task agents. **Every instrument on
 * either box still answers as though it could see the whole fleet, and none of
 * them says which half it is describing.** `epic/KAN-203` put the shared cause
 * on the ticket: *"Both our daemons answer confidently about a world that is
 * now half the fleet."*
 *
 * Three agents made the same wrong inference within one hour on 2026-08-21,
 * from three different vantage points, and **every instrument answered
 * truthfully every time**:
 *
 *   1. `story/KAN-609` read `butchr_agent_status` on `task/KAN-587`, `KAN-598`
 *      and `KAN-600` — `sessionless: true`, `herdrStatus: "unknown"` — and
 *      concluded all three had stood down. Its own retraction: *"I measured my
 *      search and reported it as the world."*
 *   2. `epic/KAN-39` accepted that and escalated a governance question on it,
 *      **having established in writing in the same hour that this daemon
 *      cannot see the other box's agents.**
 *   3. `epic/KAN-203` found no workspace directories for the three under this
 *      box's tree. Its positive control is the useful part: *"424 task
 *      workspaces exist here, so the probe works"* — those three simply never
 *      lived on this machine.
 *
 * All three were alive throughout, and GitHub is what refuted it in every case.
 *
 * ⚠ **`sessionless: true` is a true statement. `herdrStatus: "unknown"` is a
 * true statement. An absent workspace directory is a true statement.** No
 * instrument errored, returned empty, or hedged. The defect is that each
 * answer is *phrased* as a fact about the fleet and every reader completes it
 * that way:
 *
 * ```
 * what the instrument knows     "not in this daemon's registry"
 * what the sentence says        "no live agent"
 * what the reader concludes     "the agent is gone"
 * ```
 *
 * ---------------------------------------------------------------------------
 * WHY A CAVEAT WOULD NOT HAVE WORKED, WHICH IS WHY THIS IS A VALUE
 * ---------------------------------------------------------------------------
 *
 * **All three agents had read the caveat.** `epic/KAN-39` had measured the
 * limitation personally an hour before making the inference. `task/KAN-552`'s
 * line is the one that applies: *"knowing the rule did not help, which is the
 * argument for the mechanism rather than for more care."*
 *
 * So this is a field on the answer rather than a sentence in a docstring, on
 * the precedent KAN-649 shipped for a different report the same evening — the
 * unstaffable report names the query that produced it, so *"an absent audit"*
 * and *"a clean board"* stopped being the same bytes. `askedJql` is what a
 * build with no such query cannot produce; {@link CensusScope.sentence} is what
 * a reader completing *"absent, therefore dead"* cannot get past.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DAEMON MAY AND MAY NOT CLAIM
 * ---------------------------------------------------------------------------
 *
 * ⚠ **This module does not know that a second machine exists, and it must not
 * pretend to.** Butchr runs one daemon per machine, over a Unix socket, with no
 * peer link of any kind — so *"how many boxes are there?"* is not a question
 * this process can answer, and a field claiming to have counted them would be
 * the same defect one level up.
 *
 * What it can say is what its population **is**, which is enough: an answer
 * that names the host, the runtime and the workspace tree it covers cannot be
 * completed as an answer about the fleet, whether the fleet is one box or six.
 * That is the difference between reporting a boundary and reporting a census of
 * boundaries, and only the first is a fact this process holds.
 */
export interface CensusScope {
  /**
   * Discriminates this shape, on the same rule as `UnstaffableEvidence.from` in
   * `board-reconcile.ts`: a value that carries its own kind cannot be assembled
   * out of parts whose provenance was dropped on the way.
   */
  readonly from: 'this-box';
  /** The machine that answered. */
  readonly host: string;
  /** The runtime holding the agents this answer covers. */
  readonly runtime: RuntimeMode;
  /** The tree every agent in this population works in. */
  readonly workspacesRoot: string;
  /**
   * The completion, pre-written.
   *
   * ⚠ **It is on the wire rather than in a docstring because the docstring did
   * not work** — see the module docblock. A reader who takes nothing else off
   * this block still cannot read an absence here as a death, because the
   * sentence saying so arrived with the absence.
   */
  readonly sentence: string;
}

/**
 * The one producer of a {@link CensusScope}.
 *
 * `host`, `runtime` and `workspacesRoot` are read rather than passed where they
 * can be, for the reason `UnstaffableEvidence` gives about `askedJql` being a
 * parameter: what the report names and what the answer came from must not be
 * able to drift. Here the direction is reversed — the runtime is a fact about
 * the object `createAgentRuntime` built at boot, which this module cannot see,
 * so it is the one parameter. The tree is derived from the same
 * {@link workspacesRoot} every workspace is created under, so a scope cannot
 * name a directory the fleet does not use.
 */
export function censusScope(runtime: RuntimeMode, hostname: string = os.hostname()): CensusScope {
  const root = workspacesRoot();
  return {
    from: 'this-box',
    host: hostname,
    runtime,
    workspacesRoot: root,
    sentence:
      `Butchr runs one daemon per machine and this one can see no other. This answer covers ` +
      `agents the ${runtime} runtime holds on host ${hostname}, whose workspaces live under ` +
      `${root}. An agent staffed on another machine is absent from every field here, and that ` +
      `absence is NOT evidence about whether it is running.`
  };
}

/**
 * Whether this box holds a workspace for an address, **and whether the question
 * could be asked at all** (KAN-630).
 *
 * ---------------------------------------------------------------------------
 * `absent` CARRIES ITS OWN POSITIVE CONTROL, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * `epic/KAN-203` got this right by hand on the night of the incident, and it is
 * the half of its reading worth keeping: it did not report three absent
 * directories, it reported three absent directories **beside 424 present
 * ones**. The count is what separates *"this box does not have that agent"*
 * from *"this probe cannot find anything"*, and without it the two are the same
 * bytes — which is `prompts/task.md`'s rule exactly: *an empty result is a
 * claim about your search*, and *a 404 from a query that would 404 on anything
 * has measured nothing.*
 *
 * So {@link siblings} is not diagnostic colour. **It is the precondition of the
 * `absent` arm**, and {@link workspacePresence} is the only thing that can
 * produce one: an unreadable tree, or a tree holding no workspace of that type
 * at all, returns `cannot-tell` rather than `absent`. A probe that would answer
 * absent for every address on the board is a probe that has not run, and it
 * cannot say otherwise here.
 *
 * ⚠ **`cannot-tell` is not a degraded `absent` and must never be folded into
 * one.** It is the same asymmetry `WorkDirLiveness` keeps in `router.ts`: this
 * function's failure mode is *asserting an absence it did not observe*, so
 * silence rounds away from the confident answer rather than toward it.
 */
export type WorkspacePresence =
  /** The directory is there. This box is where this agent lives. */
  | { readonly kind: 'present'; readonly dir: string }
  /**
   * The directory is not there **and the search demonstrably works**:
   * `siblings` other workspaces of this type were counted in the same read.
   * Never constructible with `siblings === 0` — see the type's docblock.
   */
  | { readonly kind: 'absent'; readonly dir: string; readonly siblings: number }
  /** Nothing was established. NOT the same as `absent`. */
  | { readonly kind: 'cannot-tell'; readonly dir: string; readonly because: string };

/**
 * The one producer of a {@link WorkspacePresence}.
 *
 * `readdir` on the type directory rather than an `existsSync` on the workspace
 * itself, and the extra work is the whole mechanism: an `existsSync` answers
 * `false` in both the worlds this type exists to separate, and a directory
 * listing answers `false` **with the evidence that false means something**.
 *
 * Case-folded on the key exactly as {@link workspaceDirFor} folds it, because a
 * workspace is created at the lower-cased spelling and a caller may address an
 * agent in Jira's upper-case one.
 *
 * ⚠ **`type` is optional because the addresses this is asked about are.**
 * `butchr_agent_status` takes a bare key and infers the type from the one agent
 * holding it — and for the population this whole module exists for there is no
 * such agent to infer from, so there is nothing to pass. A bare key is
 * therefore searched across **every** type this box holds, and the control is
 * summed over the same read. Requiring a type here would have made the
 * commonest call site guess one, which is a fabricated premise underneath a
 * refusal about fabricated premises.
 *
 * `readdir` is injectable for the same reason `homeIdentity` takes its `env`: a
 * proof has to be able to drive the unreadable-tree arm without making a
 * directory on the machine unreadable.
 */
export function workspacePresence(
  type: string | undefined,
  key: string,
  readdir: (dir: string) => string[] = (dir) => fs.readdirSync(dir)
): WorkspacePresence {
  const root = workspacesRoot();
  const dir = type ? workspaceDirFor(type, key) : path.join(root, '<type>', key.toLowerCase());

  let types: string[];
  if (type) {
    types = [type];
  } else {
    try {
      types = readdir(root);
    } catch (err: any) {
      return {
        kind: 'cannot-tell',
        dir,
        because:
          `'${root}' could not be listed (${err?.message ?? String(err)}), so nothing was ` +
          `searched and an absence here would be a fact about this read rather than about the ` +
          `agent`
      };
    }
  }

  const wanted = key.toLowerCase();
  const unreadable: string[] = [];
  let siblings = 0;

  for (const t of types) {
    const typeRoot = path.join(root, t);
    let entries: string[];
    try {
      entries = readdir(typeRoot);
    } catch (err: any) {
      // A missing `workspaces/<type>/` lands here too, and that is correct:
      // this box has never held an agent of that type, so it can say nothing
      // at all about one. Recorded rather than skipped — a directory that
      // could not be read is one the agent could have been in, so it is a
      // reason not to conclude `absent` in exactly the way an unreadable
      // census row is in `workDirLiveness`.
      unreadable.push(`${typeRoot} (${err?.message ?? String(err)})`);
      continue;
    }
    if (entries.some((e) => e.toLowerCase() === wanted)) {
      return { kind: 'present', dir: path.join(typeRoot, wanted) };
    }
    siblings += entries.length;
  }

  if (unreadable.length > 0) {
    return {
      kind: 'cannot-tell',
      dir,
      because:
        `${unreadable.length} workspace ${unreadable.length === 1 ? 'directory' : 'directories'} ` +
        `could not be listed (${unreadable.join('; ')}), so the agent may be in ` +
        `${unreadable.length === 1 ? 'it' : 'one of them'}`
    };
  }

  // THE POSITIVE CONTROL, AND THE ONLY GATE ON THE `absent` ARM. A tree holding
  // nothing cannot distinguish "not here" from "this read found nothing at
  // all", so it does not try.
  if (siblings === 0) {
    return {
      kind: 'cannot-tell',
      dir,
      because:
        `'${root}' holds no workspace of ${type ? `type '${type}'` : 'any type'} at all, so this ` +
        `search would have answered "absent" for every address on the board — it has measured ` +
        `itself and not this agent`
    };
  }

  return { kind: 'absent', dir, siblings };
}

/**
 * What this box knows about one address, as four answers that cannot be
 * confused for one another (KAN-630).
 *
 * **The defect this type makes unrepresentable** is a `butchr_agent_status`
 * row asserting `sessionless: true, herdrStatus: "unknown"` about an address
 * this daemon has never held. Under the CrabCast runtime that row is
 * *fabricated*: `CrabCastRuntime.describeAgent` looks the address up with an
 * optional `find` and, when it misses, returns `workDir: workspaceDirFor(type,
 * key)` — a path it computed rather than found — and
 * `herdrStatus: asHerdrStatus(undefined)`, which is `'unknown'`. Nothing on the
 * response distinguishes that from a real reading of a real agent, which is
 * what `story/KAN-609` read three of.
 *
 * ⚠ **`HerdrBridge.describeAgent` throws for the same input** — `No agent found
 * for key '<key>'` — so the two runtimes disagreed about the whole question,
 * and the fleet runs on the one that answers.
 *
 * - `known-here`   — the census holds it, the durable registry recorded it, or
 *                    its workspace is on this disk. This box may speak about
 *                    it, and every existing sentence stays exactly as earned.
 * - `unknown-here` — none of the three, **and the search was shown to work**.
 *                    This box has never held this agent, so it may report that
 *                    and nothing further.
 * - `cannot-tell`  — the question could not be asked. Not evidence either way.
 */
export type AddressKnowledge =
  | { readonly kind: 'known-here'; readonly because: string }
  | { readonly kind: 'unknown-here'; readonly siblings: number }
  | { readonly kind: 'cannot-tell'; readonly because: string };

/**
 * The one composer of an {@link AddressKnowledge}.
 *
 * Three independent witnesses, and **any one of them is enough** — they are
 * ORed rather than ANDed, deliberately. Each covers a hole the others leave:
 *
 *   - **the census** is the live reading, and misses an agent whose pane the
 *     runtime spells differently (the KAN-579 population);
 *   - **the durable registry** is what this daemon recorded activating, and
 *     survives a restart the census does not;
 *   - **the workspace directory** is what survives *both*, and is the only one
 *     of the three that answers for an agent this daemon started before it was
 *     last rebuilt.
 *
 * ⚠ **The direction of the OR is the safe one and is not symmetric.** A false
 * `known-here` costs nothing — it returns the caller to today's answer, which
 * is the behaviour every other agent on this box already gets. A false
 * `unknown-here` is a refusal to answer about an agent that is right here, so
 * every route to it is gated on evidence and the fallback is `known-here`.
 */
export function addressKnowledge(witnesses: {
  liveInCensus: boolean;
  inDurableRegistry: boolean;
  presence: WorkspacePresence;
}): AddressKnowledge {
  const { liveInCensus, inDurableRegistry, presence } = witnesses;
  if (liveInCensus) return { kind: 'known-here', because: 'the census holds a live row for it' };
  if (inDurableRegistry) {
    return {
      kind: 'known-here',
      because: "this daemon's durable registry records having activated it"
    };
  }
  switch (presence.kind) {
    case 'present':
      return { kind: 'known-here', because: `its workspace is on this disk at '${presence.dir}'` };
    case 'cannot-tell':
      return { kind: 'cannot-tell', because: presence.because };
    case 'absent':
      return { kind: 'unknown-here', siblings: presence.siblings };
  }
}

/**
 * The one place a refusal to answer about an off-box address is written
 * (KAN-630), on the same rule as `reasonForMissingAgent` in `router.ts`: the
 * sentence a reader acts on is composed at exactly one site, so a call site
 * cannot write a stronger conclusion than the evidence carries.
 *
 * ⚠ **What it must never say is that the agent is not running**, and the shape
 * is what stops it: this function has no branch that concludes anything about
 * the agent, because no branch of {@link AddressKnowledge} that reaches it has
 * looked anywhere the agent could be.
 *
 * The last sentence is doing real work and is not politeness. `story/KAN-609`,
 * `epic/KAN-39` and `epic/KAN-203` all had a route to the true answer and none
 * of them took it until afterwards — GitHub refuted all three cases, and
 * `epic/KAN-39` retracted only after checking a merge timestamp for an
 * unrelated reason. Naming the route on the refusal is cheaper than the hour
 * it cost three times.
 */
export function refusalForOffBoxAddress(
  type: string,
  key: string,
  knowledge: Extract<AddressKnowledge, { kind: 'unknown-here' }>,
  scope: CensusScope
): string {
  return (
    `This box has no record of '${type}/${key}': the census holds no row for it, this daemon's ` +
    `durable registry never recorded activating it, and there is no workspace for it under ` +
    `${scope.workspacesRoot}. THAT IS NOT A CLAIM THAT IT IS NOT RUNNING. ${scope.sentence} ` +
    `The search did work: ${knowledge.siblings} other '${type}' workspace` +
    `${knowledge.siblings === 1 ? '' : 's'} ${knowledge.siblings === 1 ? 'was' : 'were'} counted ` +
    `in the same read, so this absence is a reading of this box rather than a search that finds ` +
    `nothing. To establish whether this agent is alive, ask the machine it was staffed on, or ` +
    `read its Jira ticket and its pull request — those are fleet-wide and this daemon is not.`
  );
}

/**
 * The sentence for the arm that established nothing, written here beside its
 * sibling so the two cannot drift into each other.
 *
 * ⚠ It is a **separate refusal from {@link refusalForOffBoxAddress}** rather
 * than a softening of it, for the reason the whole ticket exists: *"the census
 * could not be searched"* and *"this box does not hold that agent"* are the two
 * answers that must not collapse, and giving them one composer is how they
 * would.
 */
export function refusalForUnestablishedAddress(
  type: string,
  key: string,
  knowledge: Extract<AddressKnowledge, { kind: 'cannot-tell' }>,
  scope: CensusScope
): string {
  return (
    `Whether '${type}/${key}' is held by this box could not be established, because ` +
    `${knowledge.because}. That is a fact about this check and not about the agent: it is ` +
    `neither a report that it is running nor a report that it is not. ${scope.sentence}`
  );
}
