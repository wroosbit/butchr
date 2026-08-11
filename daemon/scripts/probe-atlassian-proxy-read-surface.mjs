// KAN-292 acceptance criterion 1, at its strongest reading: **a real call per
// tool**, made the way an agent makes one — through a real `mcp.ts` over real
// MCP stdio, to a real daemon, against **real Atlassian** with the machine's
// **real credential** — returning real data, printed.
//
// WHAT FAILURE THIS WOULD CATCH: a read surface that is present but dead. That
// is not hypothetical here and it is the whole reason this file is a probe
// rather than a schema test: on 2026-08-10 every agent's Atlassian tools were
// *listed* and every one of them was broken, because the processes serving them
// stayed alive holding dead connections. Tool presence has proved nothing on
// this board. It would also catch a path this table builds that Atlassian does
// not actually serve — a v2 endpoint that is really v1, a parameter Confluence
// spells differently, a product routed at the wrong host — none of which any
// pure script can see, because they are all facts about the far end.
//
// This is a `probe-`, not a `verify-`, and the distinction is KAN-272's: it
// touches production Atlassian and needs the machine's real credential, so it
// is not something CI or a reviewer re-runs cheaply. The assertions about
// containment and the grant are `verify-atlassian-proxy-read-surface.mjs`,
// which is pure and which is what goes red when the boundary moves.
//
// ── WHAT THIS SUPPLIES ITSELF, AND WHO COVERS THE REST ─────────────────────
//
// `prompts/task.md`: *a proof that supplies its own input has not tested that
// the input arrives.* So, precisely:
//
//   - **It does NOT supply the data it asserts on.** Every id it uses is read
//     out of an earlier proxied call — the space id comes from
//     atlassian_get_confluence_spaces, the page id from that space's pages, the
//     issue type id from the project's issue types. Nothing is hardcoded except
//     the project key `KAN` and this ticket's own key. That is deliberate: an
//     id written into this file would make each call test a constant rather
//     than the call that produced it.
//   - **It DOES supply the credential's location**, by copying the real one
//     into a throwaway $HOME by path. What that leaves uncovered is a machine
//     where the credential is in the keyring rather than a file; covered by
//     `verify-jira-credential-diagnostics.mjs`, not here.
//   - **It does NOT cover a model choosing to call these tools.**
//     `probe-atlassian-proxy-agent-call.mjs` does that for the three KAN-272
//     reads and nobody does it for these eighteen. Named rather than implied.
//   - **One tool cannot return populated data on this site.**
//     atlassian_get_confluence_comment_children needs a comment to have
//     children, and `cql: type=comment` returns zero results across the entire
//     Confluence — no comment exists anywhere. The call is made and whatever
//     Atlassian really answers is printed, and it is reported as REACHABILITY
//     rather than as a populated read. Manufacturing a comment to make this
//     line look better would be a fixture this script authored, which is not
//     evidence that the read works on data it did not write.
//
// ── THE CREDENTIAL, AND WHY THIS IS NOT A LEAK ─────────────────────────────
//
// The daemon's credential file is **copied by path** into a throwaway $HOME.
// It is never read into this process, never printed, never passed as an
// argument, and never written anywhere but a 0600 file inside a 0700 directory
// removed on exit. `fs.copyFileSync` moves bytes between two paths and this
// script never sees them — the discipline `prompts/task.md` states for a
// transcript: referenced by path, never echoed. The daemon binds its socket
// inside that $HOME and runs with BUTCHR_BOARD_RECONCILE=off, so it cannot see,
// start or stand down any agent of the running fleet.
//
// Usage: node daemon/scripts/probe-atlassian-proxy-read-surface.mjs [--verbose]
// Run it after `npm run build` in daemon/.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const VERBOSE = process.argv.includes('--verbose');

const OWN_KEY = 'KAN-292';
const PROJECT_KEY = 'KAN';

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
const covered = new Set();

function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}
function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail) console.log(`         ${String(detail).split('\n').slice(0, 6).join('\n         ')}`);
  if (!ok) failures++;
}

/** One line of evidence: the tool, and a fingerprint of what really came back. */
function evidence(tool, summary) {
  covered.add(tool);
  console.log(`   DATA  ${tool.padEnd(46)} ${summary}`);
}

/**
 * A tool this run could not exercise, and why — recorded loudly rather than
 * skipped quietly.
 *
 * It counts as covered for section 3's arithmetic **and prints as an exemption
 * in the summary**, so a reader of the output cannot mistake it for a tool that
 * returned data. Every exemption has to be licensed by a condition this script
 * established itself; see the call site.
 */
const exemptions = [];
function exempt(tool, why) {
  covered.add(tool);
  exemptions.push({ tool, why });
  console.log(`   EXEMPT ${tool.padEnd(45)} ${why}`);
}

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kan292-read-'));
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
      setTimeout(() => { if (waiting.delete(mine)) reject(new Error(`${method} timed out`)); }, 30000);
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
      clientInfo: { name: 'kan292-probe', version: '0' }
    });
    return await fn(mcp);
  } finally {
    try { mcp.child.kill('SIGKILL'); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════

console.log(`Probing the real read surface. Credential: ${REAL_CRED} (copied by path, never read here).`);
console.log(`Throwaway $HOME: ${fakeHome}`);

daemon = startDaemon({ BUTCHR_ATLASSIAN_PROXY: 'confluence-read' });
await sleep(2500);

const { PROXY_OPERATIONS, operationsFor } = await import(
  path.join(daemonDir, 'dist', 'atlassian-proxy.js')
);
const READS = operationsFor('confluence-read').filter((op) => op.method === 'GET');

// ── 1. every read is advertised to a real MCP client ───────────────────────
rule('1. the whole read surface is advertised to a real MCP client under confluence-read');

const advertised = await withMcp(OWN_KEY, async (mcp) => {
  const res = await mcp.send('tools/list', {});
  return (res?.result?.tools ?? []).map((t) => t.name);
});
const missing = READS.filter((op) => !advertised.includes(op.tool)).map((op) => op.tool);
check(
  `all ${READS.length} read operations are offered`,
  missing.length === 0,
  missing.length ? `missing: ${missing.join(', ')}` : ''
);
check(
  'the write is NOT offered — this mode is reads only',
  !advertised.includes('atlassian_transition_issue'),
  advertised.filter((n) => n.startsWith('atlassian_')).join(', ')
);

// ── 2. A REAL CALL PER TOOL, against real Atlassian ────────────────────────
rule('2. a real call per tool, returning real data');

await withMcp(OWN_KEY, async (mcp) => {
  const call = async (tool, args = {}) => {
    const { isError, payload, text } = await callTool(mcp, tool, args);
    if (isError || payload?.success === false) {
      check(`${tool} returned data`, false, payload?.error ?? text.slice(0, 300));
      return null;
    }
    if (VERBOSE) console.log(`         ${JSON.stringify(payload?.body).slice(0, 400)}`);
    return payload?.body ?? null;
  };

  // --- the three KAN-272 shipped, re-run as REGRESSION evidence ------------
  //
  // Not padding. KAN-292 changed the transport these three go through: it now
  // takes a `product` and selects a gateway base from it. That is exactly the
  // kind of change that works for the new callers and breaks the old ones, and
  // no pure script can see it because the defect would be in which host the
  // request went to. So the three operations that were working before this
  // ticket are called here, against real Atlassian, to show they still are.

  const issue = await call('atlassian_get_issue', { issueKey: OWN_KEY });
  if (issue) {
    evidence(
      'atlassian_get_issue',
      `${issue.key}: "${issue.fields?.summary?.slice(0, 50)}" [${issue.fields?.status?.name}] ` +
        `parent ${issue.fields?.parent?.key} — unchanged by the product routing`
    );
  }

  const searched = await call('atlassian_search_issues', {
    jql: `project = ${PROJECT_KEY} AND status = "In Progress"`,
    maxResults: 3
  });
  if (searched) {
    evidence(
      'atlassian_search_issues',
      `${searched.issues?.length} in-progress issue(s): ${searched.issues?.map((i) => i.key).join(', ')}`
    );
  }

  const transitions = await call('atlassian_get_transitions', { issueKey: OWN_KEY });
  if (transitions) {
    evidence(
      'atlassian_get_transitions',
      `${OWN_KEY} can move to: ` +
        transitions.transitions?.map((t) => `${t.name}(id ${t.id})`).join(', ')
    );
  }

  // --- Jira ---------------------------------------------------------------

  const linkTypes = await call('atlassian_get_issue_link_types');
  if (linkTypes) {
    evidence(
      'atlassian_get_issue_link_types',
      `${linkTypes.issueLinkTypes?.length} types: ${linkTypes.issueLinkTypes?.map((t) => t.name).join(', ')}`
    );
  }

  const remote = await call('atlassian_get_issue_remote_links', { issueKey: OWN_KEY });
  if (remote) {
    evidence(
      'atlassian_get_issue_remote_links',
      `${OWN_KEY} has ${Array.isArray(remote) ? remote.length : '?'} remote link(s) — an empty array is a real answer`
    );
  }

  const issueTypes = await call('atlassian_get_project_issue_types', { projectKey: PROJECT_KEY });
  // The id the NEXT call uses comes from this response, not from this file.
  const taskType = issueTypes?.issueTypes?.find((t) => t.name === 'Task') ?? issueTypes?.issueTypes?.[0];
  if (issueTypes) {
    evidence(
      'atlassian_get_project_issue_types',
      `${PROJECT_KEY} has ${issueTypes.issueTypes?.length} types: ` +
        issueTypes.issueTypes?.map((t) => `${t.name}(id ${t.id}, level ${t.hierarchyLevel})`).join(', ')
    );
  }

  if (taskType) {
    const fields = await call('atlassian_get_issue_type_fields', {
      projectKey: PROJECT_KEY,
      issueTypeId: String(taskType.id)
    });
    if (fields) {
      evidence(
        'atlassian_get_issue_type_fields',
        `${PROJECT_KEY}/${taskType.name} has ${fields.fields?.length} fields; required: ` +
          (fields.fields?.filter((f) => f.required).map((f) => f.fieldId).join(', ') || '(none)')
      );
    }
  }

  const projects = await call('atlassian_get_visible_projects', { limit: 5 });
  if (projects) {
    evidence(
      'atlassian_get_visible_projects',
      `${projects.total} project(s): ${projects.values?.map((p) => `${p.key} "${p.name}"`).join(', ')}`
    );
  }

  const users = await call('atlassian_lookup_account_id', { query: 'wroos', limit: 5 });
  if (users) {
    evidence(
      'atlassian_lookup_account_id',
      `${users.length} match(es): ${users.map((u) => `${u.displayName} (${u.accountType})`).join(', ')}`
    );
  }

  const me = await call('atlassian_get_user_info');
  if (me) {
    evidence(
      'atlassian_get_user_info',
      `daemon authenticates as ${me.displayName} <${me.emailAddress}>, active=${me.active}`
    );
  }

  const resources = await call('atlassian_get_accessible_resources');
  if (resources) {
    evidence(
      'atlassian_get_accessible_resources',
      `${resources.length} site: ${resources.map((r) => `${r.name} (cloudId ${r.id})`).join(', ')}`
    );
  }

  // --- Confluence ---------------------------------------------------------

  const spaces = await call('atlassian_get_confluence_spaces', { limit: 5 });
  // Every Confluence id below is read out of THIS response, not written here.
  const space = spaces?.results?.[0];
  if (spaces) {
    evidence(
      'atlassian_get_confluence_spaces',
      `${spaces.results?.length} space(s): ${spaces.results?.map((s) => `${s.key} (id ${s.id})`).join(', ')}`
    );
  }

  let page = null;
  if (space) {
    const pages = await call('atlassian_get_confluence_space_pages', {
      spaceId: String(space.id),
      limit: 5
    });
    page = pages?.results?.[0];
    if (pages) {
      evidence(
        'atlassian_get_confluence_space_pages',
        `space ${space.id} has ${pages.results?.length} page(s): ` +
          pages.results?.map((p) => `"${p.title}" (id ${p.id})`).join(', ')
      );
    }
  }

  if (page) {
    const full = await call('atlassian_get_confluence_page', { pageId: String(page.id) });
    if (full) {
      const body = full.body?.storage?.value ?? '';
      evidence(
        'atlassian_get_confluence_page',
        `"${full.title}" (id ${full.id}, status ${full.status}), storage body ${body.length} chars`
      );
    }

    const descendants = await call('atlassian_get_confluence_page_descendants', {
      pageId: String(page.id),
      limit: 5
    });
    if (descendants) {
      evidence(
        'atlassian_get_confluence_page_descendants',
        `page ${page.id} has ${descendants.results?.length} descendant(s) — an empty set is a real answer`
      );
    }

    const footer = await call('atlassian_get_confluence_page_footer_comments', {
      pageId: String(page.id),
      limit: 5
    });
    if (footer) {
      evidence(
        'atlassian_get_confluence_page_footer_comments',
        `page ${page.id} has ${footer.results?.length} footer comment(s)`
      );
    }

    const inline = await call('atlassian_get_confluence_page_inline_comments', {
      pageId: String(page.id),
      limit: 5
    });
    if (inline) {
      evidence(
        'atlassian_get_confluence_page_inline_comments',
        `page ${page.id} has ${inline.results?.length} inline comment(s)`
      );
    }

  }

  // THE ONE OPERATION THAT CANNOT RETURN DATA ON THIS SITE, AND THE EXEMPTION
  // IS EARNED RATHER THAN HARDCODED.
  //
  // `/wiki/api/v2/footer-comments/{id}/children` answers 400 for any id that is
  // not a real footer comment — verified against a page id and against an
  // absent-but-plausible id, both 400 — so a successful call needs a comment to
  // exist. On this site none does, anywhere.
  //
  // Rather than skipping the tool on a hardcoded exception, the exemption is
  // made CONDITIONAL ON A FACT THIS SCRIPT ESTABLISHES THROUGH THE SURFACE
  // ITSELF: a CQL search for comments. If that search ever returns one, the
  // exemption evaporates and the tool must return data like every other. A skip
  // that cannot expire is how a permanently-untested tool ends up looking
  // covered.
  const anyComment = await call('atlassian_search_confluence_cql', {
    cql: 'type=comment',
    limit: 1
  });
  const existingComment = anyComment?.results?.[0]?.content?.id;
  if (existingComment) {
    const children = await call('atlassian_get_confluence_comment_children', {
      commentId: String(existingComment),
      limit: 5
    });
    if (children) {
      evidence(
        'atlassian_get_confluence_comment_children',
        `comment ${existingComment} has ${children.results?.length} repl(ies)`
      );
    }
  } else {
    // Make the call anyway and print what Atlassian really said. This is
    // reachability evidence, and it is reported as exactly that.
    const { payload } = await callTool(mcp, 'atlassian_get_confluence_comment_children', {
      commentId: String(page?.id ?? 1),
      limit: 5
    });
    exempt(
      'atlassian_get_confluence_comment_children',
      `NO SUCCESSFUL CALL — this site has zero Confluence comments (established by ` +
        `atlassian_search_confluence_cql type=comment above), so no id exists that this ` +
        `endpoint would accept. Asked with page id ${page?.id} and Atlassian answered: ` +
        `${(payload?.error ?? '').slice(0, 120)}`
    );
  }

  const cql = await call('atlassian_search_confluence_cql', { cql: 'type=page', limit: 3 });
  if (cql) {
    evidence(
      'atlassian_search_confluence_cql',
      `${cql.totalSize} page(s) match type=page; first: ${cql.results?.map((r) => `"${r.content?.title ?? r.title}"`).join(', ')}`
    );
  }

  // --- cross-product ------------------------------------------------------

  const search = await call('atlassian_search', { query: 'butchr', limit: 3 });
  if (search) {
    evidence(
      'atlassian_search',
      `jira ${search.jira?.issues?.length} hit(s) ` +
        `(${search.jira?.issues?.map((i) => i.key).join(', ')}), ` +
        `confluence ${search.confluence?.results?.length} hit(s)`
    );
    check(
      'atlassian_search says in its own payload that it is not Rovo',
      /not Rovo Search/i.test(search.note ?? ''),
      search.note
    );
  }

  // The ARI is built from a cloudId this run resolved and a key this ticket
  // owns — an identifier of the shape a search result carries.
  const cloudId = resources?.[0]?.id;
  const fetched = await call('atlassian_fetch_resource', {
    id: `ari:cloud:jira:${cloudId}:issue/${OWN_KEY}`
  });
  if (fetched) {
    evidence(
      'atlassian_fetch_resource (jira)',
      `${fetched.key}: "${fetched.fields?.summary?.slice(0, 60)}" [${fetched.fields?.status?.name}]`
    );
  }
  if (page) {
    const fetchedPage = await call('atlassian_fetch_resource', {
      id: `ari:cloud:confluence:${cloudId}:page/${page.id}`
    });
    if (fetchedPage) {
      evidence(
        'atlassian_fetch_resource (confluence)',
        `"${fetchedPage.title}" (id ${fetchedPage.id}) — same tool, other product, from the ARI alone`
      );
    }
  }
});

// ── 3. every tool in the table was actually called ─────────────────────────
rule('3. the coverage claim, checked against the table rather than asserted');

const called = new Set([...covered].map((t) => t.replace(/ \(.*\)$/, '')));
const uncalled = READS.filter((op) => !called.has(op.tool)).map((op) => op.tool);
check(
  `every one of the ${READS.length} read operations was called and returned data`,
  uncalled.length === 0,
  uncalled.length ? `never returned data: ${uncalled.join(', ')}` : ''
);

// ── 4. the negative control ────────────────────────────────────────────────
//
// Every PASS above is a call that worked. A harness that could not fail would
// produce those too — so this turns the proxy off, makes the same call on the
// same instrument, and requires a refusal naming the switch. Section 2's greens
// are worth something only because this red is.
rule('4. negative control — the same instrument, with the proxy off, refuses');

try { daemon.child.kill('SIGKILL'); } catch {}
await sleep(500);
daemon = startDaemon({});
await sleep(2500);

await withMcp(OWN_KEY, async (mcp) => {
  const { payload } = await callTool(mcp, 'atlassian_get_confluence_spaces', { limit: 1 });
  check(
    'with the switch unset, a Confluence read is refused rather than served',
    payload?.success === false && /proxy is off/i.test(payload?.error ?? ''),
    payload?.error ?? JSON.stringify(payload)
  );
  check(
    'and the refusal names the switch, so an operator can act on it',
    /BUTCHR_ATLASSIAN_PROXY/.test(payload?.error ?? ''),
    payload?.error
  );
});

if (exemptions.length) {
  rule('WHAT THIS RUN DID NOT ESTABLISH');
  for (const { tool, why } of exemptions) console.log(`   ${tool}\n      ${why}\n`);
  console.log(
    '   Each exemption above is licensed by a condition this run established through the\n' +
      '   surface itself, not by a list written into this file. If the condition stops\n' +
      '   holding, the tool is required to return data like every other one.'
  );
}

console.log(
  failures
    ? `\nFAILED — ${failures} check(s)`
    : `\nOK — ${READS.length - exemptions.length} of ${READS.length} read operations reached ` +
      `real Atlassian through a real mcp.ts and returned real data` +
      (exemptions.length ? `, ${exemptions.length} exempted above` : '') +
      `, and the same instrument refused with the switch off.`
);
process.exit(failures ? 1 : 0);
