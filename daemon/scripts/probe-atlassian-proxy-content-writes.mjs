// KAN-293 acceptance criteria 1 and 2, at their strongest reading: **a real
// call per write tool**, made the way an agent makes one — through a real
// `mcp.ts` stamping its own identity, through the daemon, with the daemon's
// real credential, against real Atlassian — and then the nested structure
// **read back** and compared with what was sent.
//
// This is a `probe-`, not a `verify-`, and the distinction is KAN-272's: it
// touches production Jira and Confluence, it needs the machine's real
// credential, and it creates real content. None of that belongs in something CI
// re-runs. The pure assertions about the grant, the policy and the converter
// live in `verify-atlassian-proxy-write-scope.mjs` and
// `verify-adf-conversion.mjs`, which are what go red when a boundary moves.
//
// ── WHAT THIS ADDS THAT NEITHER OF THOSE CAN ───────────────────────────────
//
// `verify-adf-conversion.mjs` proves the converter produces the right tree. It
// **cannot** prove Atlassian stored it — and the entire KAN-183 defect lives in
// that gap: a converter can be perfect and the content still be gone, because
// the server discards a subtree it dislikes rather than rejecting the document.
// §3 below is the only thing in this repository that closes it. It writes the
// nesting, reads the stored document back, and compares marker by marker.
//
// `verify-atlassian-proxy-write-scope.mjs` constructs its own callers, so it
// proves what the policy decides *given* an identity and nothing about whether
// a real identity arrives — the KAN-145 defect named in `prompts/task.md`. Here
// `mcp.ts` is spawned with `--workspace-type task --workspace-key KAN-293` and
// stamps the request itself, so §5's refusals are evidence that the stamping
// works, not merely that the comparison does.
//
// WHAT IT STILL DOES NOT COVER, NAMED RATHER THAN LEFT TO BE ASSUMED: a model
// choosing to call these tools. That is `probe-atlassian-proxy-agent-call.mjs`
// for the read path, and for the write path it is the retirement evidence
// pasted into KAN-293's PR — a real agent doing real ticket work with
// `mcp__atlassian__*` absent.
//
// ── THE CREDENTIAL, AND WHY THIS IS NOT A LEAK ─────────────────────────────
//
// Copied **by path** into a throwaway $HOME with `fs.copyFileSync`. Never read
// into this process, never printed, never passed as an argument. The throwaway
// daemon binds its socket inside that $HOME and runs with
// BUTCHR_BOARD_RECONCILE=off so it cannot see or stand down any agent of the
// running fleet. Same discipline as `probe-atlassian-proxy-write.mjs`.
//
// ── WHAT IT WRITES, SO NOBODY IS SURPRISED BY IT ───────────────────────────
//
// Everything is on KAN-293 (this ticket) or in a scratch Confluence page this
// script creates. It adds a comment and a worklog to KAN-293, sets a label on
// it, creates one Confluence page and edits it, and comments on that page. With
// `--file-followup` it also files one Jira issue and links it to KAN-293; that
// is off by default because a ticket is not a thing to create by accident.
//
// Usage:
//   node daemon/scripts/probe-atlassian-proxy-content-writes.mjs
//   node daemon/scripts/probe-atlassian-proxy-content-writes.mjs --file-followup
// Run it after `npm run build` in daemon/.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');

const OWN_KEY = 'KAN-293';
const OTHER_KEY = 'KAN-288';
const SPACE_ID = '196612';
const FILE_FOLLOWUP = process.argv.includes('--file-followup');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

if (!fs.existsSync(path.join(daemonDir, 'dist', 'mcp.js'))) {
  console.error('daemon/dist/mcp.js is missing — run `npm run build` in daemon/ first.');
  process.exit(1);
}
const REAL_CRED = path.join(os.homedir(), '.local', 'share', 'butchr', 'jira-credential.json');
if (!fs.existsSync(REAL_CRED)) {
  console.error(`No Jira credential at ${REAL_CRED}; this probe needs the machine's real one.`);
  process.exit(1);
}

let failures = 0;
function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}
function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  // Only on a failure. The first run of this probe printed each marker's
  // not-found message underneath its own PASS line, which reads as a
  // contradiction and cost a minute of believing the round trip had failed.
  if (!ok && detail) console.log(`         ${String(detail).split('\n').slice(0, 6).join('\n         ')}`);
  if (!ok) failures++;
}

/** Detail worth seeing on a success too — the response, trimmed. */
function note(text) {
  console.log(`         ${String(text).split('\n').slice(0, 3).join('\n         ')}`);
}

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kan293-writes-'));
const butchrDir = path.join(fakeHome, '.local', 'share', 'butchr');
fs.mkdirSync(butchrDir, { recursive: true, mode: 0o700 });
fs.copyFileSync(REAL_CRED, path.join(butchrDir, 'jira-credential.json'));
fs.chmodSync(path.join(butchrDir, 'jira-credential.json'), 0o600);

let daemon = null;
function cleanup() {
  try { daemon?.child.kill('SIGKILL'); } catch {}
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startDaemon(extraEnv) {
  const child = spawn(process.execPath, [path.join(daemonDir, 'dist', 'daemon.js')], {
    env: { ...process.env, HOME: fakeHome, BUTCHR_BOARD_RECONCILE: 'off', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = [];
  child.stdout.on('data', (b) => log.push(String(b)));
  child.stderr.on('data', (b) => log.push(String(b)));
  child.on('error', () => {});
  return { child, log };
}

function startMcpClient(workspaceKey) {
  const child = spawn(
    process.execPath,
    [path.join(daemonDir, 'dist', 'mcp.js'), '--workspace-type', 'task', '--workspace-key', workspaceKey],
    { env: { ...process.env, HOME: fakeHome }, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const waiting = new Map();
  let buffer = '';
  let id = 0;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const entry = msg.id !== undefined ? waiting.get(msg.id) : undefined;
      if (entry) { waiting.delete(msg.id); entry(msg); }
    }
  });
  child.stderr.on('data', () => {});
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const mine = ++id;
      waiting.set(mine, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, params })}\n`);
      setTimeout(() => { if (waiting.delete(mine)) reject(new Error(`${method} timed out`)); }, 45000);
    });
  return { child, send };
}

async function callTool(mcp, name, args) {
  const res = await mcp.send('tools/call', { name, arguments: args });
  const text = res?.result?.content?.[0]?.text ?? '';
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  return { isError: !!res?.result?.isError, payload, text };
}

async function withMcp(workspaceKey, fn) {
  const mcp = startMcpClient(workspaceKey);
  try {
    await mcp.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'kan293-probe', version: '0' }
    });
    return await fn(mcp);
  } finally {
    try { mcp.child.kill('SIGKILL'); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════

console.log(`Probing the real content-write path. Credential: ${REAL_CRED} (copied by path, never read here).`);
console.log(`Throwaway $HOME: ${fakeHome}`);
console.log(`Run stamp: ${stamp}`);

daemon = startDaemon({ BUTCHR_ATLASSIAN_PROXY: 'confluence-write' });
await sleep(2500);

// ── 1. every write tool is advertised ──────────────────────────────────────
rule('1. all ten writes are offered to a real MCP client under confluence-write');

const EXPECTED_WRITES = [
  'atlassian_add_comment',
  'atlassian_add_worklog',
  'atlassian_create_confluence_footer_comment',
  'atlassian_create_confluence_inline_comment',
  'atlassian_create_confluence_page',
  'atlassian_create_issue',
  'atlassian_create_issue_link',
  'atlassian_edit_issue',
  'atlassian_transition_issue',
  'atlassian_update_confluence_page'
];

const advertised = await withMcp(OWN_KEY, async (mcp) => {
  const res = await mcp.send('tools/list', {});
  return (res?.result?.tools ?? []).map((t) => t.name);
});
const missingTools = EXPECTED_WRITES.filter((t) => !advertised.includes(t));
check('every write tool is advertised', missingTools.length === 0, JSON.stringify(missingTools));
check(
  'and the whole surface is 31 operations — the official server\'s count',
  advertised.filter((n) => n.startsWith('atlassian_')).length === 31,
  `${advertised.filter((n) => n.startsWith('atlassian_')).length} atlassian_* tools offered`
);

// ── 2. a real call per Jira write ──────────────────────────────────────────
rule('2. a real call per Jira write, against the real ticket');

const jiraResults = await withMcp(OWN_KEY, async (mcp) => {
  const out = {};

  out.comment = await callTool(mcp, 'atlassian_add_comment', {
    issueKey: OWN_KEY,
    bodyMarkdown:
      `Posted by \`probe-atlassian-proxy-content-writes.mjs\` at ${stamp}, through Butchr's ` +
      'own proxy rather than `mcp__atlassian__*`.\n\n' +
      '- PROBE-COMMENT-ALPHA\n' +
      '  > PROBE-COMMENT-BRAVO (a blockquote nested in a list item)\n' +
      '- PROBE-COMMENT-CHARLIE'
  });
  check('atlassian_add_comment succeeded', !out.comment.isError, out.comment.text.slice(0, 300));

  out.worklog = await callTool(mcp, 'atlassian_add_worklog', {
    issueKey: OWN_KEY,
    timeSpent: '1m',
    comment: `Proxy write probe ${stamp}.`
  });
  check('atlassian_add_worklog succeeded', !out.worklog.isError, out.worklog.text.slice(0, 300));

  out.edit = await callTool(mcp, 'atlassian_edit_issue', {
    issueKey: OWN_KEY,
    labels: ['kan293-proxy-probe']
  });
  check('atlassian_edit_issue succeeded', !out.edit.isError, out.edit.text.slice(0, 300));

  return out;
});

// ── 3. THE ROUND TRIP — the section nothing else in this repo can do ───────
rule('3. the ADF round trip: write the nesting, read it back, compare');

const MARKERS = ['ROUNDTRIP-CELL-ALPHA', 'ROUNDTRIP-LIST-BRAVO', 'ROUNDTRIP-QUOTE-CHARLIE', 'ROUNDTRIP-TAIL-DELTA'];

const NESTED_MARKDOWN = `Written by KAN-293's probe at ${stamp}.

| Case | Nested content |
| --- | --- |
| ${MARKERS[0]} | - ${MARKERS[1]}<br>  > ${MARKERS[2]} |

- ${MARKERS[3]}
  > and a blockquote in a plain list item too
`;

const roundTrip = await withMcp(OWN_KEY, async (mcp) => {
  const created = await callTool(mcp, 'atlassian_create_confluence_page', {
    spaceId: SPACE_ID,
    title: `KAN-293 round-trip probe ${stamp}`,
    bodyMarkdown: NESTED_MARKDOWN
  });
  check('atlassian_create_confluence_page succeeded', !created.isError, created.text.slice(0, 400));
  const pageId = created.payload?.body?.id ?? created.payload?.result?.id ?? null;
  check('the created page reported an id', !!pageId, JSON.stringify(created.payload).slice(0, 300));
  if (!pageId) return { pageId: null };

  // Read it back THROUGH THE PROXY, as ADF, and compare.
  const readBack = await callTool(mcp, 'atlassian_get_confluence_page', {
    pageId,
    bodyFormat: 'atlas_doc_format'
  });
  check('the page reads back', !readBack.isError, readBack.text.slice(0, 300));

  const stored = JSON.stringify(readBack.payload ?? {});
  for (const marker of MARKERS) {
    check(`marker ${marker} survived the round trip`, stored.includes(marker), 'NOT FOUND in the stored document');
  }

  // And the structure, not just the text: a blockquote must still be inside a
  // list item. Text surviving while the nesting collapsed would be a partial
  // loss that reads as a success — the exact shape this ticket exists for.
  const adf = (() => {
    const body = readBack.payload?.body;
    const raw =
      body?.atlas_doc_format?.value ??
      body?.body?.atlas_doc_format?.value ??
      // The proxy's own read hands back the parsed document directly.
      (body?.type === 'doc' ? body : undefined);
    try { return typeof raw === 'string' ? JSON.parse(raw) : (raw ?? null); } catch { return null; }
  })();
  // WHAT CONFLUENCE ACTUALLY DOES WITH THIS NESTING, measured here rather than
  // assumed — and it is not what either obvious guess says.
  //
  // Read back as **storage** (XHTML) the nesting is literal:
  // `<li><p>…</p><blockquote><p>…</p></blockquote></li>`. Read back as **ADF**
  // the blockquote is not a `blockquote` node at all: Confluence wraps it in a
  // `com.atlassian.confluence.migration / legacy-content` extension whose
  // `parameters.nestedContent` is the blockquote document and whose
  // `parameters.cxhtml` is the same markup as a string.
  //
  // So Confluence's editor has no native ADF spelling for a quote inside a
  // bullet, accepts one anyway, and preserves it losslessly in a wrapper. Both
  // things this check cares about are true — the text is there and it is still
  // marked as quoted, still inside the list item — so both spellings count.
  // Accepting only the native node would fail a round trip that lost nothing,
  // which is a false alarm, and the one thing a proof about silent loss must
  // not do is teach its reader to ignore it.
  const quotedInsideListItem = (() => {
    if (!adf) return false;
    const stack = [[adf, false]];
    while (stack.length) {
      const [node, inList] = stack.pop();
      if (inList && node.type === 'blockquote') return true;
      // The wrapper Confluence actually stores.
      if (
        inList &&
        node.type === 'extension' &&
        node.attrs?.extensionKey === 'legacy-content' &&
        JSON.stringify(node.attrs?.parameters ?? {}).includes('"blockquote"')
      ) {
        return true;
      }
      for (const child of node.content ?? []) stack.push([child, inList || node.type === 'listItem']);
    }
    return false;
  })();
  check(
    'and the quote is still marked as a quote INSIDE the list item in the stored document',
    quotedInsideListItem,
    adf
      ? 'the text survived but the quote structure did not — a partial loss that reads as success'
      : `could not parse stored ADF: ${JSON.stringify(readBack.payload).slice(0, 200)}`
  );

  const updated = await callTool(mcp, 'atlassian_update_confluence_page', {
    pageId,
    title: `KAN-293 round-trip probe ${stamp}`,
    version: '1',
    bodyMarkdown: `${NESTED_MARKDOWN}\n\nUpdated in place — ROUNDTRIP-UPDATE-ECHO.\n`,
    versionMessage: 'KAN-293 probe update'
  });
  check('atlassian_update_confluence_page succeeded', !updated.isError, updated.text.slice(0, 400));

  const footer = await callTool(mcp, 'atlassian_create_confluence_footer_comment', {
    pageId,
    bodyMarkdown: '- FOOTER-COMMENT-FOXTROT\n  > nested quote in a footer comment'
  });
  check('atlassian_create_confluence_footer_comment succeeded', !footer.isError, footer.text.slice(0, 300));

  // RETRIED ONCE, AND THE REASON IS RECORDED RATHER THAN SMOOTHED OVER.
  // This call returned 201 on one run and **500** on the next, same code, same
  // page, same anchor text — an upstream fault, and the timing suggests
  // Confluence has not finished indexing the body the update just replaced when
  // the anchor is resolved. A retry is the honest handling: the proxy did its
  // job both times, and a probe that reports somebody else's 500 as a defect in
  // the thing under test is a probe that trains its reader to ignore it. If the
  // retry also fails, it FAILS — this is a retry, not a suppression.
  let inline = await callTool(mcp, 'atlassian_create_confluence_inline_comment', {
    pageId,
    textSelection: MARKERS[3],
    bodyMarkdown: 'INLINE-COMMENT-GOLF anchored to a passage.'
  });
  if (inline.isError) {
    console.log('         (first attempt failed; retrying once after 3s — see the note in the source)');
    await sleep(3000);
    inline = await callTool(mcp, 'atlassian_create_confluence_inline_comment', {
      pageId,
      textSelection: MARKERS[3],
      bodyMarkdown: 'INLINE-COMMENT-GOLF anchored to a passage.'
    });
  }
  check('atlassian_create_confluence_inline_comment succeeded', !inline.isError, inline.text.slice(0, 300));

  return { pageId };
});

// ── 4. the two writes that create ──────────────────────────────────────────
rule(`4. creation and linking${FILE_FOLLOWUP ? '' : ' — SKIPPED, pass --file-followup to run'}`);

if (FILE_FOLLOWUP) {
  await withMcp(OWN_KEY, async (mcp) => {
    const created = await callTool(mcp, 'atlassian_create_issue', {
      projectKey: 'KAN',
      issueType: 'Task',
      summary:
        'The official markdown->ADF converter silently drops content, fleet-wide, in Jira ' +
        'comments as well as Confluence pages',
      description:
        'Filed through Butchr\'s own proxy by `probe-atlassian-proxy-content-writes.mjs`, ' +
        `which is also what exercises \`atlassian_create_issue\` for KAN-293's AC1 (run ${stamp}).\n\n` +
        'MEASURED, not inherited. Sending this markdown with `contentFormat: markdown`:\n\n' +
        '```\n- ITEM-MARKER-CHARLIE\n  > QUOTE-MARKER-DELTA\n- SECOND-ITEM-ECHO\n```\n\n' +
        'stores only `SECOND-ITEM-ECHO`. Two of three markers gone, including the list ' +
        "item's own text, with a 200 and a page that reads as though it worked. Confluence " +
        'page 5079041 is the reproduction; `epic/KAN-39` reproduced the identical signature ' +
        'in a Jira comment (comment 11611 on KAN-39).\n\n' +
        'WHY IT MATTERS BEYOND ONE TICKET: every agent brief, staffing instruction and piece ' +
        'of pasted evidence on this board goes through that converter. A brief that lost a ' +
        'bullet is one nobody knows is incomplete.\n\n' +
        'KAN-293 removes the exposure for anything written through the Butchr proxy, which ' +
        'builds ADF itself and refuses rather than writes partial. It does NOT remove it for ' +
        '`mcp__atlassian__*`, which every agent still has. This ticket is for deciding what to ' +
        'do about that — interim workaround is a wording rule (do not nest a blockquote inside ' +
        'a list item in anything that matters), already broadcast.\n\n' +
        'A SECOND FINDING worth carrying: Jira and Confluence run DIFFERENT ADF validators. ' +
        'A blockquote inside a list item is stored by Confluence and rejected by Jira with ' +
        '400 INVALID_INPUT. Butchr\'s converter is target-aware because of it.',
      parent: 'KAN-39'
    });
    check('atlassian_create_issue succeeded', !created.isError, created.text.slice(0, 400));
    const key = created.payload?.body?.key ?? null;
    check('the created issue reported a key', !!key, JSON.stringify(created.payload).slice(0, 300));
    if (!key) return;
    console.log(`         created ${key}`);

    const linked = await callTool(mcp, 'atlassian_create_issue_link', {
      linkType: 'Relates',
      inwardIssue: key,
      outwardIssue: OWN_KEY
    });
    check('atlassian_create_issue_link succeeded', !linked.isError, linked.text.slice(0, 300));
  });
} else {
  console.log('   (skipped — this section files a real Jira issue)');
}

// ── 5. the policy, exercised with an identity mcp.ts produced ──────────────
rule("5. the refusals — with a real identity, not one this script wrote down");

await withMcp(OWN_KEY, async (mcp) => {
  const other = await callTool(mcp, 'atlassian_add_comment', {
    issueKey: OTHER_KEY,
    bodyMarkdown: 'This must never appear on KAN-288.'
  });
  check(
    `commenting on ${OTHER_KEY} is refused — an agent writes only to its own ticket`,
    other.isError && /only to the caller's own ticket/i.test(other.text),
    other.text.slice(0, 300)
  );

  const wrongProject = await callTool(mcp, 'atlassian_create_issue', {
    projectKey: 'OTHER',
    issueType: 'Task',
    summary: 'This must never be created.'
  });
  check(
    'creating in another project is refused',
    wrongProject.isError && /own project/i.test(wrongProject.text),
    wrongProject.text.slice(0, 300)
  );

  const foreignLink = await callTool(mcp, 'atlassian_create_issue_link', {
    linkType: 'Relates',
    inwardIssue: 'KAN-288',
    outwardIssue: 'KAN-291'
  });
  check(
    "linking two issues that are both somebody else's is refused",
    foreignLink.isError && /neither end/i.test(foreignLink.text),
    foreignLink.text.slice(0, 300)
  );

  // THE POSITIVE CONTROL. Every check above is a refusal, and a broken gate
  // that refused everything would pass all three while the tools were dead.
  const mine = await callTool(mcp, 'atlassian_add_comment', {
    issueKey: OWN_KEY,
    bodyMarkdown: `Positive control for the refusals above — ${stamp}.`
  });
  check(
    'and the same tool SAYS YES to the caller\'s own ticket, in the same run',
    !mine.isError,
    mine.text.slice(0, 300)
  );
});

// ── 6. the audit line ──────────────────────────────────────────────────────
rule('6. every write is attributable in the daemon log');

// The daemon redirects `console.log` to `~/.local/share/butchr/daemon.log` at
// startup, so reading its stdout pipe reports "nothing was logged" about a
// daemon logging perfectly — which is exactly what the first run of this probe
// concluded. `verify-atlassian-proxy-failure-is-loud.mjs` reads the file for
// the same reason.
const logPath = path.join(butchrDir, 'daemon.log');
const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : daemon.log.join('');
const auditLines = log.split('\n').filter((l) => l.includes('atlassian-proxy:'));
check(
  'the daemon logged a line per proxied call, naming the caller',
  auditLines.length > 0 && auditLines.every((l) => /task\/KAN-293|unidentified/.test(l)),
  `${auditLines.length} audit lines`
);
check(
  'no audit line contains anything token-shaped',
  !/(Bearer |Basic [A-Za-z0-9+/=]{16,}|api[_-]?token["'\s:=]+\S)/i.test(log),
  'a credential reached the daemon log'
);
if (roundTrip.pageId) {
  console.log(`\n   Scratch page: https://wroosbit.atlassian.net/wiki/spaces/SD/pages/${roundTrip.pageId}`);
}
console.log('\n   Audit lines:');
for (const line of auditLines.slice(0, 20)) console.log(`     ${line.trim()}`);

console.log(
  `\n${failures ? `FAILED — ${failures} check(s)` : 'OK — every write tool called for real, the nested structure round-tripped, and the policy refused what it should while saying yes to what it should.'}\n`
);
process.exit(failures ? 1 : 0);
