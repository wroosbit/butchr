import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  describeBuildGap,
  readTemplateAt,
  resolvePromptSource,
  type PromptSource
} from './prompt-source.js';

/**
 * A workspace brief is a SNAPSHOT, and until KAN-242 nothing in it said so.
 *
 * `.butchr-prompt.md` is rendered from `prompts/<type>.md` once, at activation
 * (router.ts, inside `if (!session)`), and written once (herdr.ts). Nothing
 * refreshes it while the agent lives, and — the half that makes rewriting it
 * pointless — nothing makes the agent *re-read* it if something does. So an
 * agent that outlives a governance change goes on teaching itself the
 * superseded rule, with no signal that anything moved.
 *
 * MEASURED, NOT ARGUED. `epic/KAN-203` has held one conversation since
 * 2026-08-06T20:29Z. It read its brief **once**, at line 11 of what is now a
 * 4035-line transcript, and has not read it since — while merge governance
 * changed underneath it at 2026-08-08 10:57 (`efde3cb`) and its
 * `.butchr-prompt.md` was re-rendered and rewritten by every daemon restart in
 * those four days, most recently at 05:17 on 2026-08-10. (Its transcript
 * mentions the file four more times; every one is a `stat` or a Jira call from
 * the investigation that produced KAN-242, not a re-read.) **The file on disk is
 * fresh and the agent's context is not**, which is why "rewrite the file in
 * place" was rejected as the fix: it is already what happens, and it does not
 * work.
 *
 * What is missing is not a fresher file — it is any way for an agent to find
 * out. That is what this module adds: one block, rendered at activation, naming
 * the commit the brief came from and the exact command that answers *has this
 * rule changed since?* It turns a silent staleness into a checkable one. It
 * does not make anything current, and it must never be read as claiming to;
 * what acts on it is the agent, instructed by the `## This brief is a snapshot`
 * section the block is rendered into. See docs/prompt-staleness.md.
 *
 * KAN-442 CHANGED WHAT THE SNAPSHOT IS A SNAPSHOT OF, and nothing above it.
 * The template used to be read off the checkout's *working tree*, whose `main`
 * is never advanced — correctly, since agents read that tree concurrently and
 * `prompts/task.md` forbids moving it. So the brief was a snapshot of a tree
 * that was behind `origin/main` by one commit per merge and falling further
 * behind for as long as the fleet kept merging.
 *
 * It is now read at `origin/main` itself, via `git show`, which touches no
 * working tree and takes no lock — see `prompt-source.ts` for why that dissolves
 * the concurrency hazard rather than mitigating it. The stamp, the two commands
 * and the honest-silence rule are all unchanged; what moved is that the commit
 * they name is now the merged one, so the check they carry usually answers
 * "current" instead of reliably answering "a rule moved".
 */

/** How long git is given before the render gives up and says so. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * Run git read-only against a checkout, or null if it fails for any reason.
 *
 * `GIT_OPTIONAL_LOCKS=0` for the reason staleness.ts gives: this clone is
 * shared, task agents run git in it concurrently, and a read that takes
 * `index.lock` could make one of their commands fail. A brief that broke the
 * agents it briefs would be a poor trade.
 *
 * Deliberately a second small helper rather than an import from staleness.ts:
 * that module answers a different question and reports its failures as a
 * `Freshness` verdict, while a failure here has to degrade into prose an agent
 * reads. Sharing ten lines of `execFileSync` would have coupled the two answers
 * without making either shorter.
 */
function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    }).trim();
  } catch {
    return null;
  }
}

/** The commit a template last changed in. */
export interface TemplateCommit {
  sha: string;
  shortSha: string;
  subject: string;
  /** Author date, ISO-ish and local, for a human reading the brief. */
  date: string;
}

/**
 * Where a rendered brief came from — enough for its reader to check it.
 *
 * `commit: null` is a first-class answer, not an error. A checkout that is not
 * a git working tree, a template that has never been committed, and a git that
 * would not answer are all real and all produce a brief; what they must not
 * produce is a brief that *implies* it is current. {@link unavailable} carries
 * the reason into the rendered text.
 */
export interface PromptProvenance {
  /** Absolute path of the checkout the template was read from. */
  repoRoot: string;
  /** The template's path relative to `repoRoot` — its git pathspec, verbatim. */
  templatePath: string;
  renderedAt: Date;
  commit: TemplateCommit | null;
  /** Why `commit` is null. Present exactly when `commit` is null. */
  unavailable?: string;
  /**
   * Which source the bytes came from, so the block cannot claim the wrong one.
   *
   * Carried on the provenance rather than recomputed by the renderer: the
   * loader is what actually chose, and a second resolution could disagree with
   * the first — which is the KAN-145 shape, a fact with two implementations.
   */
  source: PromptSource;
  /** The `origin/main`-ahead-of-build gap, when there is one to state. */
  buildGap?: string;
}

/**
 * What the brief this agent is reading was rendered from.
 *
 * Two git calls on the activation path, both bounded and both allowed to fail:
 * an activation must never be lost to a slow or absent git, so every failure
 * lands in `unavailable` and the brief still ships.
 */
export function templateProvenance(
  repoRoot: string,
  templatePath: string,
  source: PromptSource = { kind: 'worktree', because: 'no source was resolved' },
  now: Date = new Date()
): PromptProvenance {
  // Once, not once per use: this is on the activation path and it shells out.
  const buildGap = describeBuildGap(repoRoot, source);
  const base: PromptProvenance = {
    repoRoot,
    templatePath,
    renderedAt: now,
    commit: null,
    source,
    ...(buildGap ? { buildGap } : {})
  };

  if (git(repoRoot, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return {
      ...base,
      unavailable: `${repoRoot} is not a git working tree, so the daemon cannot name a commit for this file`
    };
  }

  // `-1` on the pathspec, NOT `rev-parse HEAD`: the question is when this
  // *file* last changed, and HEAD moves on every unrelated commit. Stamping
  // HEAD would make every brief look freshly-ruled and turn the comparison
  // below into noise — the reader would see commits between the two shas that
  // touched nothing they care about.
  //
  // AND MERGES ARE DELIBERATELY NOT EXCLUDED, though a merge commit's subject
  // is a duller thing to read than a real change's. `--no-merges` looks like a
  // tidy-up and is a correctness bug: where a merge is what last changed this
  // path, skipping it stamps an OLDER commit, and the reader's
  // `log <older>..origin/main` then lists that merge — reporting "a rule
  // changed after you were briefed" about a change their file already contains.
  // A dull subject line is worth far less than a false positive, because the
  // false positive is what teaches an agent to stop running the check.
  // WALKED FROM THE SOURCE'S OWN COMMIT, not from HEAD. With the bytes now read
  // at `origin/main` (KAN-442), a `log` left to default to HEAD would stamp the
  // last commit touching this path *in the working tree* — an older one — while
  // the text came from the ref. The reader's `log <stamp>..origin/main` would
  // then list the very commits their brief already contains, and report "a rule
  // changed after you were briefed" about a change they are looking at. That is
  // the false positive `--no-merges` was rejected for causing, arriving by a
  // different route, and it is the failure that teaches an agent to stop running
  // the check.
  const line = git(repoRoot, [
    'log',
    '-1',
    '--format=%H%x00%h%x00%s%x00%ad',
    '--date=format:%Y-%m-%d %H:%M',
    ...(source.kind === 'ref' ? [source.sha] : []),
    '--',
    templatePath
  ]);
  if (!line) {
    return {
      ...base,
      unavailable:
        `git recorded no commit touching ${templatePath} in ${repoRoot} ` +
        `(never committed, or git did not answer)`
    };
  }

  const [sha, shortSha, subject, date] = line.split('\0');
  if (!sha || !shortSha) {
    return {
      ...base,
      unavailable: `git's answer for ${templatePath} in ${repoRoot} could not be parsed`
    };
  }

  return { ...base, commit: { sha, shortSha, subject: subject ?? '', date: date ?? '' } };
}

/** Local time, to the minute, in the form the rest of the briefs use. */
function stamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/**
 * The provenance block, as the Markdown an agent meets in its brief.
 *
 * WHAT THE WORDING HAS TO DO, because the failure this ticket exists to fix is
 * an artifact whose sentence claims more than its mechanism covers:
 *
 *   - It states a FACT (this file came from commit X at time T) and never a
 *     reassurance. Nothing here says the brief is current, because nothing here
 *     knows: the daemon's own checkout can be behind `origin/main`, so even a
 *     brief rendered one second ago can carry a superseded rule.
 *   - It gives the reader a COMMAND rather than an instruction to go and
 *     compare prose. An agent cannot eyeball two copies of a 40 KB brief and
 *     tell whether a governance clause moved; it can compare two shas.
 *   - ⚠ It compares the FILE and never walks HISTORY, and that is KAN-523
 *     rather than a stylistic preference. Until 2026-08-18 this block emitted
 *     `git log --oneline <sha>..origin/main -- <path>`, which is correct on a
 *     full clone and gives a FALSE POSITIVE on a shallow one: a graft root has
 *     its parents erased, so a range starting before it cannot be walked and
 *     git reports every file in that tree as newly ADDED there. The shared
 *     clone was grafted at `e7ac6bf` on 2026-08-17, and the check answered
 *     `739 insertions` — the entire brief — for a blob whose sha was identical
 *     at every point. It fails toward the ALARMING answer, so the cost lands on
 *     the agent that is being careful: it is told every rule it operates under
 *     has moved. `<rev>:<path>` resolves through the tree instead, so depth
 *     cannot reach it.
 *   - ⚠ And it must never answer when it cannot. A missing commit makes
 *     `rev-parse` exit non-zero with `fatal:` rather than print a sha, which is
 *     why the third outcome is spelled out in the block: a refusal that reads
 *     as "nothing changed" would be the quiet failure this whole section exists
 *     to prevent.
 *   - It names an ABSOLUTE path. The reader may be an agent working in another
 *     organisation's repository entirely — CrabCast's agents are briefed from
 *     these same four files, out of Butchr's checkout — and has no `prompts/`
 *     of its own to compare against.
 *   - When it does not know, it SAYS it does not know, and tells the reader
 *     what to do instead. A block that quietly omitted itself on a non-git
 *     install would read as "nothing to check here".
 */
export function renderProvenanceBlock(p: PromptProvenance): string {
  // The source is stated on the first line because it changes what the reader
  // should conclude from everything under it. `origin/main` means the stamp
  // below names a merged commit and the check will usually come back empty;
  // the working tree means it names whatever that tree happens to hold, which
  // is behind by one commit per merge and is the state KAN-442 was filed about.
  const from =
    p.source.kind === 'ref'
      ? `\`${p.repoRoot}\` at \`${p.source.ref}\` — read with \`git show\`, so no working tree was involved`
      : `\`${p.repoRoot}\`'s **working tree**, which may be behind \`origin/main\` (${p.source.because})`;
  const lines = [`- **Rendered** ${stamp(p.renderedAt)}, from ${from}.`];

  if (!p.commit) {
    lines.push(
      `- **Which commit \`${p.templatePath}\` came from could not be determined** — ` +
        `${p.unavailable}.`,
      `- **So you cannot check it from here, and must not assume it is current.** ` +
        `Read \`${p.templatePath}\` at \`origin/main\` yourself before acting on any ` +
        `governance rule in this file.`
    );
    return lines.join('\n');
  }

  const { shortSha, subject, date } = p.commit;
  lines.push(
    `- **\`${p.templatePath}\` last changed in \`${shortSha}\`** — *${subject}* (${date}).`,
    `- **To find out whether that is still the rule**, run these two — they are the` +
      ` whole check:`,
    '',
    '  ```bash',
    `  git -C ${p.repoRoot} fetch origin`,
    `  git -C ${p.repoRoot} rev-parse ${shortSha}:${p.templatePath} origin/main:${p.templatePath}`,
    '  ```',
    '',
    `  **Two identical shas mean this brief is current** and you need do nothing else. ` +
      `**Two different shas mean a rule changed after you were briefed** — read what moved with ` +
      `\`git -C ${p.repoRoot} diff ${shortSha}:${p.templatePath} origin/main:${p.templatePath}\`, ` +
      `and follow what \`origin/main\` says rather than what is written above it.`,
    '',
    `  **And if it prints \`fatal:\` instead of two shas, it has told you it cannot answer** — ` +
      `which is the third outcome and not a broken command. That clone does not have \`${shortSha}\`, ` +
      `almost always because it is **shallow**: \`git -C ${p.repoRoot} rev-parse --is-shallow-repository\` ` +
      `says so, and \`git -C ${p.repoRoot} fetch --unshallow origin\` repairs it. ` +
      `**Do not read a refusal as "nothing changed."**`
  );

  // Stated because the alternative is implying a guarantee we have not got. The
  // brief is current with what was merged; the daemon answering your tool calls
  // is not. A rule here can therefore describe a mechanism this install has not
  // been rebuilt to have — which is a real thing to meet, and much easier to
  // meet with the sentence in front of you than to work out afterwards.
  if (p.buildGap) {
    lines.push(
      '',
      `- ⚠ **The brief is current; the running daemon is not.** ${p.buildGap}. ` +
        `So a rule above may name a tool or a field this install has not been rebuilt to have. ` +
        `Governance — who approves you, what you may merge — is what this file is for and it is ` +
        `current. Where a *mechanism* it describes is missing, that is this gap and not your error; ` +
        `say so on your ticket rather than working around it silently.`
    );
  }

  return lines.join('\n');
}

/**
 * The variable name a prompt template carries to receive the block above.
 *
 * Declared beside the writer and asserted by
 * `verify-operative-rules-are-carried.mjs` (rule H-16), so a template cannot
 * quietly stop carrying it: an unsubstituted `{{...}}` in a shipped brief is
 * visible, but a *deleted* one is not, and the deleted one is the failure.
 */
export const PROVENANCE_VARIABLE = 'PROMPT_PROVENANCE';

export class PromptLoader {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  public loadAndRender(templateRelativePath: string, variables: Record<string, string>): string {
    // Resolved per render rather than per loader (KAN-442): a daemon that
    // started before its first fetch would otherwise be pinned to the working
    // tree for its whole life, which is the drift this change exists to remove.
    let source = resolvePromptSource(this.baseDir);

    // The ref is tried first and the working tree is the fallback, never the
    // other way round. Both legs have to work: a template added since the last
    // fetch exists on disk and not in the ref, and refusing to render it would
    // turn a stale ref into a failed activation — trading a small, visible
    // problem for a total one.
    let content = readTemplateAt(this.baseDir, source, templateRelativePath);
    if (content === null && source.kind === 'ref') {
      source = {
        kind: 'worktree',
        because: `${templateRelativePath} could not be read at ${source.ref} (${source.sha.slice(0, 7)})`
      };
    }

    if (content === null) {
      const fullPath = path.resolve(this.baseDir, templateRelativePath);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Prompt template file not found: ${fullPath}`);
      }
      content = fs.readFileSync(fullPath, 'utf-8');
    }

    // Computed HERE rather than passed in by the caller, and that is the whole
    // point: there are two render call sites (router.ts:1561 and :1803) and a
    // variable either of them could forget is a variable one of them will.
    // KAN-145 is the standing example — a field written where nothing read it —
    // and its lesson is that a fact with two implementations has a wrong one.
    // The loader knows `baseDir` and the template path; nobody else needs to.
    //
    // `source` is PASSED rather than re-resolved, so the block cannot describe a
    // source other than the one these bytes actually came from — including the
    // fallback narrowing just above.
    const provenance = templateProvenance(this.baseDir, templateRelativePath, source);
    const resolved: Record<string, string> = {
      ...variables,
      [PROVENANCE_VARIABLE]: renderProvenanceBlock(provenance)
    };

    for (const [key, value] of Object.entries(resolved)) {
      const placeholder = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
      // A FUNCTION replacement, not the string: `String.replace` reads `$&`,
      // `$'` and `$1` out of a string replacement, so a value containing one
      // would be silently mangled. That was survivable while every value was a
      // Jira key or a URL; the provenance block is generated multi-line text
      // built from a filesystem path, and a `$` anywhere in it would corrupt
      // the brief in a way nothing downstream could detect.
      content = content.replace(placeholder, () => value);
    }

    return content;
  }
}
