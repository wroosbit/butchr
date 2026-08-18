import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DAEMON_SENDER_TAG } from './provenance.js';
/**
 * Bringing an agent back after the machine died under it.
 *
 * Re-spawning is the easy half. The half that KAN-21 was actually about is
 * that an agent which comes back with no instruction *idles forever*, and that
 * this looks identical to an agent that has finished. Both of the paths below
 * therefore end with the agent being told, in words, that it was interrupted
 * and what to do about it.
 *
 * WHAT WAS MEASURED, because the ticket's premise turned out to be wrong
 *
 * Claude Code 2.1.220 was tested on this host in a real PTY. Its transcript
 * (`~/.claude/projects/<mangled cwd>/<sessionId>.jsonl`) is written *eagerly*,
 * per event; it survives SIGKILL with no shutdown hook; a deliberately torn
 * final record still resumes; and `--continue` restores the prior turns.
 * `--continue` against a directory with genuinely no history exits 1 with
 * "No conversation found to continue", which is what makes the launcher's
 * `||` fallback correct.
 *
 * So conversation restoration was never the broken part. The two things that
 * genuinely stop an unattended resume are handled here and in launchers.ts:
 * the resume modal (see RESUME_ENV) and the missing instruction (see below).
 */
/**
 * Environment that keeps a resume from stopping to ask a question nobody is
 * there to answer.
 *
 * Claude Code offers "Resume from summary / Resume full session as-is / Don't
 * ask me again" when a resumed conversation is **both** older than
 * `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES` (default 70) **and** larger than
 * `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` (default 100000). That is the exact
 * profile of a task agent that has been working all afternoon — which is why
 * it was hit twice on the day this ticket was written, and never by a fresh
 * agent. Unattended, the modal is a hang: the pane sits on a menu until a human
 * happens to look.
 *
 * Both thresholds are read from the environment by the CLI itself, so raising
 * them past any real conversation is a supported configuration rather than a
 * trick. The consequence is deliberate and worth stating: suppressing the
 * prompt means always taking the "full session" branch, which is the more
 * expensive of the two. For an unattended agent that is the right default —
 * its context is the thing being restored — but it is a real cost, not a free
 * win.
 */
export const RESUME_ENV = {
    CLAUDE_CODE_RESUME_THRESHOLD_MINUTES: '525600', // one year of minutes
    CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: '1000000000'
};
/**
 * Claude Code's transcript directory for a working directory.
 *
 * The CLI keys history on the cwd with every non-alphanumeric character
 * replaced by a dash — verified against the directories this machine has
 * already accumulated, e.g.
 * `/home/brooswit/.local/share/butchr/workspaces/task/kan-21` →
 * `-home-brooswit--local-share-butchr-workspaces-task-kan-21` (the doubled
 * dash is the `/` and the `.` of `/.local`).
 *
 * This is knowledge of another program's internals, so it is isolated here and
 * used for exactly one decision — see {@link hasRestorableConversation} — that
 * is safe to get wrong.
 */
export function claudeTranscriptDir(workDir) {
    const key = path.resolve(workDir).replace(/[^a-zA-Z0-9]/g, '-');
    return path.join(os.homedir(), '.claude', 'projects', key);
}
/**
 * Whether `claude --continue` will have something to restore in this
 * workspace.
 *
 * Used to choose which resume framing the agent gets, and deliberately not
 * used for anything that would break if it were wrong:
 *
 * - a false positive (we think there is history, there is none) means the
 *   launcher's fallback runs with resume framing anyway, and the nudge arrives
 *   at an agent that is already reading its ticket — harmless duplication;
 * - a false negative (history exists, we miss it) means `--continue` restores
 *   the conversation and no nudge is sent, leaving an idle-but-remembering
 *   agent — which is the one case the missing-agent sweep and `list_agents`
 *   are there to surface.
 *
 * Zero-length files do not count: an empty transcript is what a session that
 * died before its first write leaves behind, and `--continue` finds nothing in
 * it either.
 */
export function hasRestorableConversation(workDir) {
    const dir = claudeTranscriptDir(workDir);
    try {
        return fs
            .readdirSync(dir)
            .filter((name) => name.endsWith('.jsonl'))
            .some((name) => {
            try {
                return fs.statSync(path.join(dir, name)).size > 0;
            }
            catch {
                return false;
            }
        });
    }
    catch {
        return false;
    }
}
/**
 * Whether a restored agent has to be told to carry on.
 *
 * **The ruling on `'unknown'`, made explicitly rather than left to fall out of
 * a comparison (KAN-432 AC2): it is nudged.** The two errors are not
 * symmetric, and that asymmetry is the whole argument:
 *
 * * **Not nudging an agent that needed it** is the KAN-21 incident. The agent
 *   sits at an empty prompt holding all of its memory, the pane looks healthy,
 *   the reconciler reports `restored`, and nothing is doing anything. Two
 *   agents sat like that until a human retyped their instructions. It is silent,
 *   it is indefinite, and no later sweep detects it — `herdrStatus` reads `done`
 *   for an idle agent and `done` is also what a correct agent awaiting review
 *   reads.
 * * **Nudging an agent that did not need it** costs one turn. {@link
 *   nudgeResumedAgent} reads the pane for a prompt before it types, and the
 *   message it sends says in words that the agent was interrupted and should
 *   check the repository and workspace for what it already did — which is
 *   exactly the recovery a spuriously-nudged agent needs. It is loud, it lands
 *   in the daemon log, and it is recoverable.
 *
 * A recoverable-and-loud failure beats a silent-and-permanent one, so the
 * unknown takes the nudge. What is **not** acceptable, and what the ticket
 * names, is an unknown being *silently* recorded as already-working; callers
 * therefore log the unknown distinctly rather than folding it in with
 * `'restored'`.
 */
export function needsResumeNudge(resumed) {
    return resumed === 'restored' || resumed === 'unknown';
}
/**
 * The filename herdr's own brief is written under, and the one place it is
 * spelled.
 *
 * Not exported: everything outside this module asks {@link workspaceBrief} for
 * the location rather than joining this onto a directory, so the file that gets
 * written and the file an agent is sent to cannot come apart. That mattered
 * enough to be worth the indirection — `herdr.ts` writes it in one function and
 * two messages in this one named it independently, which is three copies of a
 * string that must agree.
 */
const BRIEF_FILENAME = '.butchr-prompt.md';
/**
 * The brief location of a runtime that writes the file into the workspace.
 *
 * The single source of truth for herdr's answer: `HerdrBridge` calls it both
 * where it *writes* the brief and where it *names* it, so the two cannot drift.
 *
 * Returns the **narrow** {@link WorkspaceBrief} rather than the union, so the
 * writer can reach `.path` without a narrowing check. The first draft of this
 * returned `BriefLocation` and made the write site test a `kind` it had just
 * constructed — a branch that could never be taken, standing where a reader
 * would look for a real one.
 */
export function workspaceBrief(workDir) {
    return { kind: 'workspace-file', path: path.join(workDir, BRIEF_FILENAME) };
}
/**
 * How to refer to the brief in a sentence addressed to an agent.
 *
 * Deliberately a noun phrase and not a whole sentence: the two messages below
 * need it in different grammatical positions, and a renderer that emitted
 * sentences would have produced two spellings of the same fact — which is the
 * defect this ticket is fixing, one layer up.
 *
 * **Findability is kept wherever it is available.** The concern with "name the
 * concept, not the path" was that an agent loses a thing it can `cat`. It only
 * loses it where no path exists: the `workspace-file` arm still prints the
 * absolute path, and the `runtime-owned` arm prints the runtime's own account of
 * what the agent should follow — which for CrabCast is a pointer line carrying
 * an absolute path, sitting in the agent's first turn.
 */
export function briefReference(where) {
    return where.kind === 'workspace-file' ? `the file at ${where.path}` : where.pointer;
}
function causeSentence(cause) {
    if (cause === 'reboot') {
        return 'The machine you were running on restarted (a reboot or a power cut), which destroyed your terminal mid-task.';
    }
    if (cause === 'preempted') {
        return ('You were deliberately stood down to free capacity for higher-priority work, ' +
            'which ended your terminal mid-task. This was a decision, not a crash: nothing ' +
            'was wrong with what you were doing, and you are being brought back to finish it.');
    }
    return 'The Butchr daemon restarted, which destroyed your terminal mid-task.';
}
/**
 * What a restored agent is told when its conversation *did* come back.
 *
 * It has its memory but no turn to take: Claude Code resumes at an empty
 * prompt and waits. On the day this ticket was filed that wait was indefinite,
 * and was only broken by a supervising agent re-typing instructions by hand.
 * This message is that manual step, automated — which is what requirement 5
 * asked for.
 *
 * It says "check what you already did" rather than "carry on" because the
 * agent's last remembered turn may have completed after its final transcript
 * write; the repository and the workspace are the ground truth, not its memory
 * of them.
 *
 * KAN-242 ADDED THE BRIEF TO THAT LIST OF THINGS THAT MOVED WHILE IT WAS GONE,
 * AND THIS IS THE SHARPEST PLACE IN THE DAEMON TO SAY IT. An agent on this path
 * kept its conversation, so it is carrying the brief it read at the *start* of
 * that conversation — while the activation that just restored it re-rendered
 * that same brief underneath it (router.ts renders on every `!session`
 * activation; the runtime delivers it). Both halves are true at once and
 * neither is visible from the agent's side: what it would read now is current,
 * the agent's context is not. `epic/KAN-203` is the worked example — one
 * conversation since 2026-08-06, exactly one read of its brief (line 11 of
 * 4035), and a rewrite on every restart since. This is the one moment the
 * daemon knows both facts, so it is the one moment it can say so.
 *
 * KAN-400 TOOK THE PATH OUT OF THAT SENTENCE, AND THE SENTENCE IS WHY. It read
 * *"your `.butchr-prompt.md` was rewritten by this restart"*, which asserts two
 * things — that a file by that name is the agent's brief, and that this restart
 * rewrote it. Under CrabCast **neither** holds: the brief is in a sidecar
 * CrabCast owns, and no file by that name is ever written into the workspace.
 * The claim that survives both runtimes is the one that was load-bearing all
 * along — *the brief was re-rendered by the activation that restored you, and
 * you have not re-read it* — so that is what it now says, with {@link
 * BriefLocation} supplying where. A message asserting a mechanism that is
 * absent is this epic's recurring defect, and it is worst in the message an
 * agent reads when it is most disoriented.
 *
 * It opens with {@link DAEMON_SENDER_TAG} for the reason every injected message
 * does (KAN-149): it arrives by being *typed*, so an untagged one is
 * indistinguishable from the human. This message used to spell the tag
 * `[butchr]` while its two sibling builders spelled it `[butchr daemon]` — a
 * third of the daemon's own notices wearing a token the prompts do not teach.
 * The spelling now comes from the shared constant, so a fourth builder cannot
 * invent a fourth.
 */
export function resumeNudge(type, key, where, cause = 'reboot') {
    return [
        `${DAEMON_SENDER_TAG} You were interrupted mid-work. ${causeSentence(cause)}`,
        `You have been restored automatically and this conversation is your own history — but your last remembered action may not have finished, and nothing has been done on your behalf since.`,
        `Do not start over. First establish what already exists: check this workspace and, if you have a git worktree here, its status, diff, branch, commits and whether a PR is already open. Re-read ${key} for anything recorded there while you were gone.`,
        `Your brief — ${briefReference(where)} — was re-rendered by the activation that restored you, and you have NOT re-read it: you are still working from the copy you read when you started, which may predate a rule that has since changed. Before you act on a governance rule, re-read it and run the check in its "This brief is a snapshot" section.`,
        `Then continue the task from wherever that evidence says you actually got to, and say in one line what state you found before you resume work.`
    ].join(' ');
}
/**
 * The prompt an agent gets when its conversation could **not** be restored.
 *
 * This goes in as the launcher's argv prompt rather than as a message typed
 * afterwards, so the agent starts working the moment the pane opens and does
 * not depend on anything else being delivered. That is the difference between
 * this and {@link resumeNudge}: a nudge that fails leaves an idle agent, and
 * an agent with no memory at all is the one that can least afford to idle.
 *
 * It is deliberately not the cold-start prompt. A cold start would have the
 * agent claim the ticket and begin as though nothing had happened, silently
 * redoing — or worse, conflicting with — work already committed and pushed.
 *
 * STEP 1 NO LONGER SAYS "YOUR ORIGINAL INSTRUCTIONS" (KAN-242). It did, and
 * KAN-242 named that sentence as the daemon's own contribution to the defect:
 * it sent a resumed agent to a named file with a word — *original* — that
 * frames the copy as authoritative *because* it is the oldest thing available.
 * On this path the file has in fact just been re-rendered, so it is current as
 * of this activation; but "current when written" is exactly the property that
 * fooled `task/KAN-234`, and this agent may run for days after reading it. So
 * the step now says what the file is (a snapshot), and points at the check that
 * settles it. The daemon can tell an agent where its instructions are; only the
 * instructions themselves can tell it how old they are, which is why the
 * substance of this lives in `prompts/*.md` and not here.
 *
 * AND STEP 1 NO LONGER NAMES A FILE THIS RUNTIME MAY NOT HAVE WRITTEN (KAN-400).
 * *"Read `.butchr-prompt.md` in this directory"* was the sharpest instance of
 * the defect, because this is the **cold-start** path: it is handed to an agent
 * that has just been told its memory is gone, as its first numbered instruction,
 * with nothing else in its context to cross-check against. Under CrabCast that
 * first instruction names a file that is not there. It takes its location from
 * {@link BriefLocation} now, so the runtime that delivered the brief is what
 * says where it went.
 */
export function degradedResumePrompt(type, key, where, cause = 'reboot') {
    return [
        `You are a Butchr agent for ${type} ${key}, and you have just been restarted with NO memory of your previous session.`,
        causeSentence(cause),
        `Your prior conversation could not be recovered, so treat everything you would normally remember as lost — but assume work was already done.`,
        ``,
        `Before doing anything else, find out what you already did:`,
        `1. Read your brief — ${briefReference(where)} — for your instructions. It is a snapshot rendered when you were activated, not a live copy of the rules — it names the commit it came from and the command that tells you whether anything has changed since. Run that check before you act on any governance rule in it.`,
        `2. Inspect this workspace. If it contains a git worktree, check its branch, status, diff, log, and whether a pull request is already open.`,
        `3. Re-read ${key} — including your own earlier comments on it, which are the only notes your previous self may have left you.`,
        ``,
        `Then state in a few lines what you found and what remains, and continue from there. Do not restart the task from scratch, and do not duplicate work that is already committed or already in review.`
    ].join('\n');
}
