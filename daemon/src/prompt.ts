import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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
  now: Date = new Date()
): PromptProvenance {
  const base: PromptProvenance = {
    repoRoot,
    templatePath,
    renderedAt: now,
    commit: null
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
  const line = git(repoRoot, [
    'log',
    '-1',
    '--format=%H%x00%h%x00%s%x00%ad',
    '--date=format:%Y-%m-%d %H:%M',
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
 *     tell whether a governance clause moved; it can read one line of `git
 *     log`. Empty output is the whole answer.
 *   - It names an ABSOLUTE path. The reader may be an agent working in another
 *     organisation's repository entirely — CrabCast's agents are briefed from
 *     these same four files, out of Butchr's checkout — and has no `prompts/`
 *     of its own to compare against.
 *   - When it does not know, it SAYS it does not know, and tells the reader
 *     what to do instead. A block that quietly omitted itself on a non-git
 *     install would read as "nothing to check here".
 */
export function renderProvenanceBlock(p: PromptProvenance): string {
  const lines = [`- **Rendered** ${stamp(p.renderedAt)}, from \`${p.repoRoot}\`.`];

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
    `  git -C ${p.repoRoot} log --oneline ${shortSha}..origin/main -- ${p.templatePath}`,
    '  ```',
    '',
    `  **No output means this brief is current** and you need do nothing else. ` +
      `**Any line is a rule that changed after you were briefed** — read what moved with ` +
      `\`git -C ${p.repoRoot} diff ${shortSha}..origin/main -- ${p.templatePath}\`, ` +
      `and follow what \`origin/main\` says rather than what is written above it.`
  );
  return lines.join('\n');
}

/**
 * The variable name a prompt template carries to receive the block above.
 *
 * Declared beside the writer and asserted by
 * `verify-operative-rules-are-carried.mjs` (rule H-14), so a template cannot
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
    const fullPath = path.resolve(this.baseDir, templateRelativePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Prompt template file not found: ${fullPath}`);
    }

    let content = fs.readFileSync(fullPath, 'utf-8');

    // Computed HERE rather than passed in by the caller, and that is the whole
    // point: there are two render call sites (router.ts:1561 and :1803) and a
    // variable either of them could forget is a variable one of them will.
    // KAN-145 is the standing example — a field written where nothing read it —
    // and its lesson is that a fact with two implementations has a wrong one.
    // The loader knows `baseDir` and the template path; nobody else needs to.
    const provenance = templateProvenance(this.baseDir, templateRelativePath);
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
