// Proof for KAN-187, second half: the attribution parser is reading the shape
// Claude Code actually writes — checked against this machine's real, untouched
// transcripts and against Jira itself.
//
// WHAT FAILURE THIS WOULD CATCH: a parser that is correct about a record shape
// nobody produces. `verify-jira-self-echo-suppression.mjs` proves the filter
// logic, and it does so over transcript records **it writes itself** — so if
// Claude Code renamed the tool, moved the arguments, wrapped the tool result in
// an envelope, or stopped returning the created comment's id, that script would
// stay green while every comment in production went unattributed and every
// agent kept being interrupted about its own text. That is precisely the defect
// KAN-145 shipped: two verify scripts asserting on records that already
// contained the field whose arrival nobody had tested. This script is the
// missing half. It supplies no input at all: it reads transcripts written by
// real agents doing real work, and checks the ids it extracts against the live
// Jira API.
//
// CI-RUNNABLE: no — checks comment ids against the live Jira API and needs a
// real Atlassian credential; without one it correctly reports that it is not
// evidence of anything.
//
// It fails if it finds no attributions to check (a parser that matches nothing
// is the failure, not a quiet machine), and it fails if an id it extracted is
// not really a comment on the issue it named.
//
// THE ONE THING IT DOES NOT COVER: the filter. Extracting an id correctly is
// not the same claim as suppressing the right nudge with it, and no assertion
// here touches the poller. `verify-jira-self-echo-suppression.mjs` owns that,
// section by section. Run both — the hole this pair is arranged around is the
// one between "the record is real" and "the record is acted on correctly", and
// each script covers exactly one side of it.
//
// Usage: node daemon/scripts/verify-comment-authorship-live.mjs [distDir]
//        Run from the repo root, after `cd daemon && npx tsc`.
//
//        --no-jira  skip the Jira cross-check and assert only on the parse.
//                   The cross-check needs the daemon's stored read-only
//                   credential; without one configured it is skipped and said
//                   so, rather than counted as a pass.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const SKIP_JIRA = args.includes('--no-jira');
const distDir = args.find((a) => !a.startsWith('--')) ?? path.join(scriptDir, '..', 'dist');

const { CommentAuthorship, createdCommentId } = await import(
  path.join(distDir, 'comment-authorship.js')
);
const { claudeTranscriptDir } = await import(path.join(distDir, 'resume.js'));
const { workspaceDirFor, workspacesRoot } = await import(path.join(distDir, 'herdr.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
let failures = 0;
const verdict = (ok, yes, no) => {
  if (!ok) failures++;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};
const row = (label, value) => console.log(`  ${label.padEnd(46)} ${value}`);

const JIRA_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

// ------------------------------------------- the real fleet, off the disk --

/** Every Butchr workspace on this machine whose key looks like a Jira issue. */
function realWorkspaces() {
  const root = workspacesRoot();
  const found = [];
  let types = [];
  try {
    types = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return found;
  }
  for (const type of types) {
    let keys = [];
    try {
      keys = fs.readdirSync(path.join(root, type.name), { withFileTypes: true })
        .filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const key of keys) {
      const spelled = key.name.toUpperCase();
      if (!JIRA_KEY.test(spelled)) continue;
      found.push({ agentName: `butchr-${type.name}-${key.name}`, type: type.name, key: spelled });
    }
  }
  return found;
}

rule('1 — the parser, run over real Claude Code transcripts nobody wrote for it');

const agents = realWorkspaces();
const withTranscripts = agents.filter((a) => {
  try {
    return fs
      .readdirSync(claudeTranscriptDir(workspaceDirFor(a.type, a.key)))
      .some((n) => n.endsWith('.jsonl'));
  } catch {
    return false;
  }
});

row('Butchr workspaces on this machine', String(agents.length));
row('…with a Claude Code transcript directory', String(withTranscripts.length));

// A deliberately large seed: this is a one-off manual run, and reading further
// back finds more real records to check. The daemon's own default is 1MB.
const SEED = Number(process.env.KAN187_SEED_BYTES ?? 16 * 1024 * 1024);
row('bytes of transcript tail read per file', SEED.toLocaleString());

const log = [];
const authorship = new CommentAuthorship({
  seedTailBytes: SEED,
  // Nothing is expired: this run is reading history on purpose.
  ttlMs: Number.MAX_SAFE_INTEGER,
  log: (...a) => log.push(a.join(' '))
});

const startedAt = Date.now();
authorship.scan(withTranscripts);
const entries = authorship.entries();

row('seconds spent scanning', ((Date.now() - startedAt) / 1000).toFixed(1));
row('comments attributed to an agent', String(entries.length));
row('results whose id could not be read', String(log.filter((l) => l.includes('could not be read')).length));

console.log('\n  what it found (up to 15):\n');
for (const [id, author] of entries.slice(0, 15)) {
  console.log(`    comment ${id.padEnd(7)} on ${author.issueKey.padEnd(9)} written by ${author.agentName}`);
}

verdict(
  entries.length > 0,
  `${entries.length} real comment(s) attributed to the agent that wrote them, from ` +
    `transcripts written by agents doing their own work.`,
  'the parser matched nothing in any real transcript — the record shape it expects ' +
    'is not the shape Claude Code writes, and every comment in production would go ' +
    'unattributed while the synthetic proof stayed green.'
);

// ------------------------------------------ 2 — the raw record, unedited --

rule('2 — the raw transcript record behind one attribution, quoted verbatim');

console.log(`
  So the shape can be read rather than taken on trust. Nothing below was
  written by this script or by anything in this repository: it is a slice of a
  file Claude Code appended while an agent was working.`);

{
  let shown = null;
  outer: for (const agent of withTranscripts) {
    let dir;
    try {
      dir = claudeTranscriptDir(workspaceDirFor(agent.type, agent.key));
    } catch {
      continue;
    }
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      let lines;
      try {
        lines = fs.readFileSync(file, 'utf8').split('\n');
      } catch {
        continue;
      }
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('addCommentToJiraIssue')) continue;
        let record;
        try {
          record = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        const use = (record?.message?.content ?? []).find(
          (b) => b?.type === 'tool_use' && String(b?.name ?? '').endsWith('addCommentToJiraIssue')
        );
        if (!use) continue;

        // The result is in a later record, joined by tool_use_id.
        let result = null;
        for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
          let next;
          try {
            next = JSON.parse(lines[j]);
          } catch {
            continue;
          }
          const block = (next?.message?.content ?? []).find(
            (b) => b?.type === 'tool_result' && b?.tool_use_id === use.id
          );
          if (block) {
            result = block;
            break;
          }
        }
        if (!result) continue;
        shown = { agent, file, use, result };
        break outer;
      }
    }
  }

  if (!shown) {
    console.log('\n  (no paired record found to quote)');
    verdict(false, '', 'no real addCommentToJiraIssue call with its result was found to quote.');
  } else {
    const text = Array.isArray(shown.result.content)
      ? shown.result.content.map((b) => b?.text ?? '').join('')
      : String(shown.result.content ?? '');
    const extracted = createdCommentId(shown.result.content);

    console.log(`\n  file: ${shown.file.replace(os.homedir(), '~')}`);
    console.log(`  agent: ${shown.agent.agentName}\n`);
    console.log('  the tool_use, as written:\n');
    console.log(`    name        ${shown.use.name}`);
    console.log(`    id          ${shown.use.id}`);
    console.log(`    issue       ${shown.use.input?.issueIdOrKey}`);
    console.log('\n  the tool_result it was paired with, first 240 characters:\n');
    console.log(text.slice(0, 240).split('\n').map((l) => `    ${l}`).join('\n'));
    console.log(`\n  the id the parser extracted from it:   ${extracted}`);

    verdict(
      Boolean(extracted) && text.includes(String(extracted)),
      'the created comment\'s id is present in a real Atlassian response and the ' +
        'parser reads it out of the real bytes.',
      'the parser could not extract an id from a real response.'
    );
  }
}

// -------------------------------------- 3 — the ids checked against Jira --

rule('3 — the extracted ids are really comments on the issues they were attributed to');

if (SKIP_JIRA) {
  console.log('\n  --no-jira: cross-check skipped by request.');
} else {
  const { JiraIssueTypeService } = await import(path.join(distDir, 'jira.js'));
  const { CredentialStore } = await import(path.join(distDir, 'credentials.js'));

  const jira = new JiraIssueTypeService(new CredentialStore());

  // At most one read per distinct issue, and at most six issues: this holds the
  // daemon's own credential and has no business making a sweep of requests to
  // prove a parser.
  const byIssue = new Map();
  for (const [id, author] of entries) {
    if (!JIRA_KEY.test(author.issueKey)) continue;
    if (!byIssue.has(author.issueKey)) byIssue.set(author.issueKey, []);
    byIssue.get(author.issueKey).push(id);
  }
  const sample = [...byIssue.entries()].slice(0, 6);

  row('distinct issues attributed', String(byIssue.size));
  row('issues this run checks', String(sample.length));
  console.log('');

  let checked = 0;
  let mismatched = 0;
  let unreadable = 0;

  for (const [issueKey, ids] of sample) {
    const outcome = await jira.pollIssue(issueKey);
    if (!outcome.ok) {
      unreadable++;
      row(`${issueKey}`, `could not be read: ${outcome.error}`);
      continue;
    }
    const real = new Set(outcome.snapshot.commentIds);
    const missing = ids.filter((id) => !real.has(id));
    checked += ids.length;
    mismatched += missing.length;
    row(
      `${issueKey}`,
      `${ids.length} attributed id(s), ${ids.length - missing.length} present on the issue` +
        (missing.length ? ` — MISSING ${missing.join(', ')}` : '')
    );
  }

  console.log('');
  row('ids checked against the live Jira API', String(checked));
  row('ids that were not really on their issue', String(mismatched));
  if (unreadable) {
    row('issues unreadable (no credential, or deleted)', String(unreadable));
    console.log(`
  An unreadable issue is not a pass. If every issue was unreadable the daemon
  has no working Jira credential on this machine, and this section proved
  nothing — which is why zero ids checked is a failure below.`);
  }

  verdict(
    checked > 0 && mismatched === 0,
    `every id the parser pulled out of a real transcript is really a comment on the ` +
      `issue that transcript said it was posted to.`,
    checked === 0
      ? 'no id could be checked against Jira — the credential is missing or every ' +
        'issue was unreadable, so this section is not evidence of anything.'
      : 'an id was attributed to an issue it is not actually a comment on.'
  );
}

// --------------------------------------------------------------------------

console.log(`\n== ${failures ? `${failures} SECTION(S) FAILED` : 'all sections passed'} ==`);
process.exit(failures ? 1 : 0);
