// Proof for KAN-142 and KAN-143 (story KAN-90): a real Confluence page URL
// opens a `confluence` workspace keyed by the page id, a `/wiki/` URL that is
// not a page opens nothing, a tiny link opens the *same* workspace as the
// canonical URL for the same page, and the type inherits the Atlassian MCP
// server rather than declaring one.
//
// WHAT FAILURE THIS WOULD CATCH: a Confluence page URL that stops resolving or
// resolves to the wrong key — the personal-space and `edit-v2` forms are where
// a lazy space pattern breaks; a non-page `/wiki/` URL (a space home, the bare
// `/pages` listing, a whiteboard, a database, a blog post) being claimed by the
// `confluence` type instead of resolving to nothing; a Jira `/browse/` URL being
// stolen by a Confluence pattern; the `atlassian` MCP server appearing twice or
// not at all in a Confluence workspace's `.mcp.json`; `confluence` resolving
// while the Atlassian integration is switched off, or its refusal degrading to
// "unsupported URL"; the three behaviours this type inherits rather than
// declares — the Jira poller ignoring a numeric page id, agent names
// round-tripping, and `list_integrations` reporting the right `resolution`;
// and, from KAN-143, a tiny link keyed by its tiny id rather than by the page
// id it encodes — which would give one page two workspaces with two
// conversation histories — or a tiny-link decoder that is right *most* of the
// time, which is the same bug wearing a disguise. The two decoder mistakes that
// are easy to make and impossible to notice by inspection each have a real
// counter-example asserted in section 7: the non-standard `-`/`_` alphabet, and
// `A` rather than `=` padding.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// Seven sections, one per acceptance criterion, plus the inherited behaviours:
//
//   1. page URLs     — all four forms resolve to { confluence, <pageId> },
//                      including a personal space, an edit URL with a query
//                      string, and a draft's resumedraft.action link
//   2. non-pages     — every non-page /wiki/ URL resolves to null, and a Jira
//                      /browse/ URL still resolves to a Jira type
//   3. one server    — the .mcp.json a Confluence workspace is spawned with
//                      holds exactly one `atlassian` and one `butchr`, and is
//                      byte-identical to a Jira workspace's
//   4. list          — list_integrations reports all four Atlassian types with
//                      the right `resolution` for each
//   5. switched off  — with Atlassian disabled no Confluence URL resolves, and
//                      the refusal names the integration rather than the URL
//   6. inherited     — the Jira poller does not poll a page id, and
//                      addressFromAgentName('butchr-confluence-196787')
//                      round-trips
//   7. tiny links    — (KAN-143) the canonical URL and the tiny link for the
//                      same real page resolve to the same { type, key }; the
//                      decoder agrees with tiny links Confluence itself
//                      reported; and a tiny link that does not decode to a
//                      positive id resolves to nothing
//
// The URLs are this site's real ones, read back from the Atlassian MCP on
// 2026-08-04: page 196787 in space SD (`getConfluencePage(196787).webUrl`),
// page 196761 as a smart link inside a real page body, and the personal space
// key `~712020619ec5ec2e92492f897991ccda318230`.
//
// Section 7's tiny links were read from Confluence's own `_links.tinyui` on
// 2026-08-04 — `GET /wiki/rest/api/content/<id>` on wroosbit.atlassian.net for
// this site's six pages, and the same endpoint on two public Confluence sites
// for the cases this site's five-digit ids cannot reach. None of them is
// computed; the whole point of the section is comparing what Confluence says
// against what the decoder says.
//
// Every registry here gets its own throwaway state file, and the credential is
// a stub: a proof script must not write into the machine's real
// ~/.local/share/butchr/integrations.json, nor depend on what is recorded
// there, nor need a configured Atlassian credential to run. What is being
// proved is the assembly and the resolution — not this machine's credential.
//
// Usage: node daemon/scripts/verify-confluence-workspaces.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(process.argv[2] ?? path.join(scriptDir, '..', 'dist'));

const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);
const { coreMcpServerDefinitions, writeWorkspaceMcpConfig } = await import(
  path.join(distDir, 'launchers.js')
);
const { addressFromAgentName, agentNameFor } = await import(path.join(distDir, 'herdr.js'));
const { JiraPoller, JiraPollState } = await import(path.join(distDir, 'jira-poll.js'));
const { PRIORITY_TASK } = await import(path.join(distDir, 'priority.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const verdict = (ok, yes, no) => {
  if (!ok) process.exitCode = 1;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};
const indent = (text) => text.split('\n').map((l) => `     ${l}`).join('\n');
const show = (resolved) =>
  resolved ? `{ type: '${resolved.config.type}', key: '${resolved.key}' }` : 'null';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan142-confluence-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

/** Reports configured, so the assembly runs on a machine with no credential. */
const stubCredential = () => ({
  status: () => ({ configured: true, storage: 'file' }),
  storageTarget: async () => ({ storage: 'file', reason: 'this script only' }),
  setCredential: async () => ({ valid: false }),
  clearCredential: async () => {}
});

/** A registry wired as daemon.ts wires it, on its own throwaway state file. */
function install(name) {
  const statePath = path.join(scratch, `${name}.json`);
  const registry = new WorkspaceRegistry(new IntegrationStateStore(statePath));
  registry.registerIntegration(
    createAtlassianIntegration({
      issueTypeLookup: async () => 'Task',
      credential: stubCredential()
    })
  );
  registry.setEnabled('jira', true);
  return registry;
}

/** Drive one request through the real router and await its correlated reply. */
function drive(registry, message) {
  return new Promise((resolve) => {
    const router = new MessageRouter(registry, null, null, (msg) => resolve(msg));
    router.handle(message);
  });
}

const registry = install('enabled');

const SITE = 'https://wroosbit.atlassian.net';
const PERSONAL = '~712020619ec5ec2e92492f897991ccda318230';

// ------------------------------------------------------------- 1. page URLs --

rule('AC2 — every real page URL form resolves to { confluence, <pageId> }');

const pageUrls = [
  {
    label: 'canonical, with slug   ',
    url: `${SITE}/wiki/spaces/SD/pages/196787/Template+-+Decision+documentation`,
    want: '196787'
  },
  {
    label: 'canonical, no slug     ',
    url: `${SITE}/wiki/spaces/SD/pages/196761`,
    want: '196761'
  },
  {
    label: 'personal space         ',
    url: `${SITE}/wiki/spaces/${PERSONAL}/pages/163935/Getting+started`,
    want: '163935'
  },
  {
    label: 'edit URL + query string',
    url: `${SITE}/wiki/spaces/${PERSONAL}/pages/edit-v2/65823?draftShareId=abc-123&createdWithTemplate=true`,
    want: '65823'
  },
  {
    label: 'resumedraft.action     ',
    url: `${SITE}/wiki/pages/resumedraft.action?draftId=65823&draftShareId=abc-123`,
    want: '65823'
  },
  {
    label: 'with a fragment        ',
    url: `${SITE}/wiki/spaces/SD/pages/196787/Template+-+Decision+documentation#Outcome`,
    want: '196787'
  }
];

console.log('');
let pagesOk = true;
for (const { label, url, want } of pageUrls) {
  const resolved = await registry.resolve(url);
  const ok = resolved !== null && resolved.config.type === 'confluence' && resolved.key === want;
  pagesOk &&= ok;
  console.log(`  ${label}  ${url}`);
  console.log(
    `                           → ${show(resolved)}${ok ? '' : `   (expected confluence/${want})`}\n`
  );
}

console.log(
  '  The page id is the key because it is the only part that holds still: the slug\n' +
  '  moves on a retitle, the path moves between viewing and editing, and both move\n' +
  '  when a draft is published. Every row above is the same page under a different\n' +
  '  one of those, and the last two are the same page id reached two ways.'
);

verdict(
  pagesOk,
  'all six real forms resolve to the confluence type keyed by the page id.',
  'a real page URL did not resolve to confluence/<pageId> — see the rows above.'
);

// ------------------------------------------------------------- 2. non-pages --

rule('AC3 — a /wiki/ URL that is not a page resolves to nothing; Jira is untouched');

const nonPages = [
  { label: 'space home            ', url: `${SITE}/wiki/spaces/SD` },
  { label: 'space overview        ', url: `${SITE}/wiki/spaces/SD/overview` },
  { label: 'the page LISTING      ', url: `${SITE}/wiki/spaces/SD/pages` },
  { label: 'whiteboard            ', url: `${SITE}/wiki/spaces/~766660823/whiteboard/3078363456` },
  { label: 'database              ', url: `${SITE}/wiki/spaces/SD/database/196800` },
  { label: 'blog post             ', url: `${SITE}/wiki/spaces/SD/blog/2026/08/04/196900/A+post` },
  // KAN-142 listed `/wiki/x/HwEB` here, expecting null, and said in as many
  // words that it was unmatched "until KAN-143 decodes it". KAN-143 has, so
  // that row moved to section 7 and now asserts the opposite — the one
  // expectation in this script this ticket is entitled to invert, because it
  // was written as a placeholder for exactly this change. What stays here is
  // the half that does not change: a tiny link whose segment does not decode
  // to a positive page id is still nothing, the same as a whiteboard.
  { label: 'tiny link, undecodable', url: `${SITE}/wiki/x/AAAA` }
];

console.log('');
let nonPagesOk = true;
for (const { label, url } of nonPages) {
  const resolved = await registry.resolve(url);
  const ok = resolved === null;
  nonPagesOk &&= ok;
  console.log(`  ${label} ${url.padEnd(62)} → ${show(resolved)}${ok ? '' : '   (expected null)'}`);
}

const jiraUrl = `${SITE}/browse/KAN-90`;
const jiraResolved = await registry.resolve(jiraUrl);
const jiraOk = jiraResolved !== null && jiraResolved.config.type === 'task' && jiraResolved.key === 'KAN-90';
console.log(`\n  a Jira issue, unchanged ${jiraUrl.padEnd(60)} → ${show(jiraResolved)}`);

console.log(
  '\n  Two of these are the traps the patterns are written around. `/pages` with no id\n' +
  '  is what a naive /pages\\/([^\\/]+)/ would claim — with "pages" or "edit-v2" as the\n' +
  '  key — and `/pages/edit-v2/<id>` is what a naive /pages\\/(\\d+)/ would miss. Both\n' +
  '  forms are spelled out rather than approximated by one loose pattern.\n' +
  '\n  Nothing resolving is the honest answer, not a gap: a whiteboard is not a page,\n' +
  '  and degrading it to `task` would open an agent briefed on a Jira issue that does\n' +
  '  not exist. `/wiki/x/AAAA` decodes to the id 0, which is not a page id either, so\n' +
  '  it gets the same answer — see section 7 for the tiny links that do decode.'
);

verdict(
  nonPagesOk && jiraOk,
  'no non-page /wiki/ URL opens a workspace, and a Jira URL still resolves to task.',
  'a non-page /wiki/ URL resolved to something, or a Confluence pattern claimed a Jira URL.'
);

// ------------------------------------------------------------ 3. one server --

rule('AC4 — a Confluence workspace is spawned with exactly one `atlassian`, inherited');

// Exactly what the daemon assembles at spawn time: MessageRouter's
// mcpServersForSpawn() — the registry's aggregate over enabled, configured
// integrations, plus core — handed to writeWorkspaceMcpConfig by herdr.ts.
//
// The assembly, and not quite the whole file: since KAN-145 herdr.ts stamps the
// workspace's own identity onto the core server's args on the way to disk, so a
// real confluence workspace's `butchr` entry names that workspace and a real
// task workspace's names that one. The byte comparison below is therefore about
// the servers — which is what this section is asking — and the identity is
// proved by verify-activation-records-real-parentage.mjs.
const spawnDefs = { ...registry.mcpServerDefinitions(), ...coreMcpServerDefinitions() };

const confluenceWorkspace = path.join(scratch, 'workspaces', 'confluence', '196787');
const jiraWorkspace = path.join(scratch, 'workspaces', 'task', 'KAN-90');
fs.mkdirSync(confluenceWorkspace, { recursive: true });
fs.mkdirSync(jiraWorkspace, { recursive: true });
writeWorkspaceMcpConfig(confluenceWorkspace, spawnDefs);
writeWorkspaceMcpConfig(jiraWorkspace, spawnDefs);

const confluenceMcp = fs.readFileSync(path.join(confluenceWorkspace, '.mcp.json'), 'utf8');
const jiraMcp = fs.readFileSync(path.join(jiraWorkspace, '.mcp.json'), 'utf8');
const confluenceServers = Object.keys(JSON.parse(confluenceMcp).mcpServers);

console.log(`\n  workspaces/confluence/196787/.mcp.json\n`);
console.log(indent(confluenceMcp.trim()));
console.log(`\n  workspaces/task/KAN-90/.mcp.json — for comparison\n`);
console.log(indent(jiraMcp.trim()));

console.log(
  `\n  servers: ${confluenceServers.join(', ')}` +
  '\n\n  The `confluence` type declares no MCP server, and none is missing. Servers\n' +
  '  belong to the integration and attach to every agent it spawns, so a second\n' +
  '  product behind the same credential inherits the first one\'s tools by\n' +
  '  construction. That inheritance is the whole reason Jira and Confluence are one\n' +
  '  integration rather than two.'
);

verdict(
  confluenceServers.filter((s) => s === 'atlassian').length === 1 &&
    confluenceServers.includes('butchr') &&
    confluenceServers.length === 2 &&
    confluenceMcp === jiraMcp,
  'one `atlassian`, one `butchr`, and a Jira workspace\'s config is byte-identical.',
  'the assembled config gained a duplicate server, lost one, or differs between types.'
);

// ------------------------------------------------------------------ 4. list --

rule('AC5 — list_integrations reports all four Atlassian types with the right resolution');

const listed = await drive(registry, { action: 'list_integrations' });
const atlassianRow = listed.integrations.find((i) => i.id === 'jira');

console.log('\n  the Atlassian row, verbatim:\n');
console.log(indent(JSON.stringify(atlassianRow, null, 2)));

const confluenceType = atlassianRow.providedTypes.find((t) => t.type === 'confluence');
const taskType = atlassianRow.providedTypes.find((t) => t.type === 'task');
const storyType = atlassianRow.providedTypes.find((t) => t.type === 'story');

console.log(
  '\n  `resolution` is derived from whether the type owns URL patterns, never declared:\n' +
  '  `confluence` is url-matched because a page URL carries the page id, exactly as\n' +
  '  `task` is; `story` and `epic` are refined-from-issue-type because their URLs are\n' +
  '  byte-identical to a Task\'s. The settings UI already renders both phrases, so no\n' +
  '  extension change is needed for this type to appear.'
);

verdict(
  atlassianRow.providedTypes.length === 4 &&
    confluenceType?.resolution === 'url-matched' &&
    confluenceType?.name === 'Confluence Page' &&
    confluenceType?.priority === PRIORITY_TASK &&
    confluenceType?.supervisor === false &&
    taskType?.resolution === 'url-matched' &&
    storyType?.resolution === 'refined-from-issue-type',
  'four types, and confluence reports url-matched, priority 1, and supervisor false.',
  'the type list or a resolution is wrong — see the row above.'
);

// ---------------------------------------------------------- 5. switched off --

rule('AC6 — with Atlassian switched off, no Confluence URL resolves, and it says why');

const off = install('disabled');
off.setEnabled('jira', false);

const pageUrl = `${SITE}/wiki/spaces/SD/pages/196787/Template+-+Decision+documentation`;
const offResolved = await off.resolve(pageUrl);
const offRefusal = await drive(off, { action: 'activate', url: pageUrl });

console.log(`\n  registry.get('confluence')  ${off.get('confluence') ? 'registered' : 'not registered'}`);
console.log(`  resolving the page URL      → ${show(offResolved)}`);
console.log('\n  activate, as the sidepanel asks it:\n');
console.log(indent(JSON.stringify(offRefusal, null, 2)));

console.log(
  '\n  The distinction that matters: this is not "unsupported URL". The type still\n' +
  '  carries its patterns while unregistered, so `disabledMatch` can name both the\n' +
  '  integration and the page it would have opened. A user who has merely switched\n' +
  '  Atlassian off is told that, rather than being told their page is unrecognised.'
);

verdict(
  offResolved === null &&
    !off.get('confluence') &&
    offRefusal.success === false &&
    offRefusal.refusedBy === 'integration-disabled' &&
    offRefusal.integration === 'jira' &&
    offRefusal.key === '196787' &&
    /switched off/.test(offRefusal.error) &&
    !/Unsupported URL/.test(offRefusal.error),
  'the page does not resolve, and the refusal names Atlassian and the page id.',
  'a Confluence URL resolved while Atlassian was off, or the refusal lied about the URL.'
);

// ------------------------------------------------------------- 6. inherited --

rule('AC7 — the two behaviours this type inherits rather than declares');

// (a) The Jira poller must not poll a page id as though it were an issue key.
// `polled` is what it actually asked Jira for, so a page id appearing there is
// the daemon reading a Confluence workspace as an issue.
const tick = await new JiraPoller({
  jira: {
    pollIssue: async (key) => ({
      ok: true,
      snapshot: { key, statusName: 'In Progress', updated: null, commentIds: [], linkedKeys: [] }
    })
  },
  herdrBridge: null,
  liveAgents: () => [
    { agentName: agentNameFor('confluence', '196787'), type: 'confluence', key: '196787' },
    { agentName: agentNameFor('task', 'KAN-90'), type: 'task', key: 'KAN-90' }
  ],
  supervisorFor: () => null,
  log: () => {},
  state: new JiraPollState(path.join(scratch, 'jira-poll.json'))
}).pollOnce();

console.log(
  '\n  (a) the Jira poller, given one confluence agent and one task agent live:\n' +
  `        polled  ${JSON.stringify(tick.polled)}`
);
console.log(
  '\n      The poller filters its watch list with /^[A-Z][A-Z0-9]*-\\d+$/, so a bare\n' +
  '      page id fails it and is never read as a Jira issue. Nothing had to be added\n' +
  '      for that — but a proof that never looked would not notice it being relaxed.'
);

// (b) Agent names round-trip through a dashless, numeric key.
const agentName = agentNameFor('confluence', '196787');
const address = addressFromAgentName(agentName);
console.log(
  `\n  (b) agentNameFor('confluence', '196787')      → '${agentName}'` +
  `\n      addressFromAgentName('${agentName}')  → ${JSON.stringify(address)}`
);
console.log(
  '\n      The parse splits at the first dash after the prefix, which assumes the type\n' +
  '      is a single token. `confluence` is one, and a numeric key with no dash in it\n' +
  '      round-trips like any other.'
);

verdict(
  tick.polled.length === 1 &&
    tick.polled[0] === 'KAN-90' &&
    address !== null &&
    address.type === 'confluence' &&
    address.key === '196787',
  'the poller ignores the page id, and the agent name round-trips to confluence/196787.',
  'the poller tried to read a page id as a Jira issue, or the agent name did not round-trip.'
);

// ------------------------------------------------------------ 7. tiny links --

rule('KAN-143 — a tiny link and the canonical URL open ONE workspace, not two');

// (a) The criterion that matters. Each row is one real page on this site,
// reached two ways: the canonical URL a human copies from the address bar, and
// the tiny link Confluence's own share button and REST API hand out. If these
// two ever disagree, that page has two workspaces — `workspaces/confluence/<a>`
// and `workspaces/confluence/<b>` — with two conversation histories that never
// converge. That is the whole hazard KAN-143 exists to prevent, so it is
// asserted rather than described.
//
// tinyui values below are what `GET /wiki/rest/api/content/<id>` on
// wroosbit.atlassian.net returned on 2026-08-04, not values this script
// computed.
const identity = [
  { id: '196761', tiny: 'mQAD', canonical: `${SITE}/wiki/spaces/SD/pages/196761/Template+-+Product+requirements` },
  { id: '196774', tiny: 'pgAD', canonical: `${SITE}/wiki/spaces/SD/pages/196774/Template+-+Meeting+notes` },
  { id: '196787', tiny: 'swAD', canonical: `${SITE}/wiki/spaces/SD/pages/196787/Template+-+Decision+documentation` },
  { id: '163935', tiny: 'X4AC', canonical: `${SITE}/wiki/spaces/${PERSONAL}/pages/163935/Getting+started+in+Confluence+from+Jira` }
];

console.log('\n  (a) the same page, reached two ways:\n');
let identityOk = true;
for (const { id, tiny, canonical } of identity) {
  const viaCanonical = await registry.resolve(canonical);
  const viaTiny = await registry.resolve(`${SITE}/wiki/x/${tiny}`);
  const same =
    viaCanonical !== null &&
    viaTiny !== null &&
    viaCanonical.config.type === viaTiny.config.type &&
    viaCanonical.key === viaTiny.key &&
    viaTiny.config.type === 'confluence' &&
    viaTiny.key === id;
  identityOk &&= same;
  console.log(`      canonical  ${canonical}`);
  console.log(`                 → ${show(viaCanonical)}`);
  console.log(`      tiny link  ${SITE}/wiki/x/${tiny}`);
  console.log(`                 → ${show(viaTiny)}`);
  console.log(`                 ${same ? 'SAME workspace' : 'DIFFERENT — one page would get two workspaces'}\n`);
}

// (b) The encoding, checked against tiny links Confluence reported rather than
// against itself. One pair is a hypothesis with a good story; these are the
// samples that turned it into a fact, and each of the last four is here because
// it fails a decoder that is *nearly* right.
//
// Provenance: the 196xxx/163xxx rows are this site, via
// `GET /wiki/rest/api/content/<id>`; 65823 is the pair recorded on KAN-90
// comment 10385; the rest are the same REST endpoint on two public Confluence
// sites, used because every id on this site is five digits and so never
// exercises the two traps below. All 2407 pairs collected that way decode
// correctly; these fourteen are the ones worth keeping in the repository.
const observed = [
  { id: '196725', tiny: 'dQAD',     note: 'wroosbit — space home (see note below)' },
  { id: '196761', tiny: 'mQAD',     note: 'wroosbit' },
  { id: '196774', tiny: 'pgAD',     note: 'wroosbit' },
  { id: '196787', tiny: 'swAD',     note: 'wroosbit' },
  { id: '163933', tiny: 'XYAC',     note: 'wroosbit — personal space home' },
  { id: '163935', tiny: 'X4AC',     note: 'wroosbit — personal space' },
  { id: '65823',  tiny: 'HwEB',     note: 'KAN-90 comment 10385, the original pair' },
  { id: '59806090', tiny: 'ipGQAw', note: 'confluence.atlassian.com — largest id checked' },
  { id: '7676',   tiny: '-B0',      note: "TRAP: '-' is '/', not '+' as base64url would have it" },
  { id: '12027',  tiny: '_y4',      note: "TRAP: '_' is '+', not '/'" },
  { id: '12292',  tiny: 'BD',       note: "TRAP: 'A' padding — '=' padding decodes this to 4" },
  { id: '12310',  tiny: 'Fj',       note: "TRAP: 'A' padding — '=' padding decodes this to 22" },
  { id: '12536',  tiny: '_D',       note: 'TRAP: both at once — 248 if either is wrong' },
  { id: '12540',  tiny: '-D',       note: 'TRAP: both at once — 252 if either is wrong' }
];

console.log('  (b) tiny links as Confluence reported them, against what the decoder makes of them:\n');
console.log(`      ${'page id'.padStart(9)}  ${'tiny link'.padEnd(14)} ${'decoder says'.padEnd(13)} ok   provenance / why this row is here`);
let observedOk = true;
for (const { id, tiny, note } of observed) {
  const resolved = await registry.resolve(`${SITE}/wiki/x/${tiny}`);
  const got = resolved && resolved.config.type === 'confluence' ? resolved.key : null;
  const ok = got === id;
  observedOk &&= ok;
  console.log(
    `      ${id.padStart(9)}  ${('/wiki/x/' + tiny).padEnd(14)} ${String(got).padEnd(13)} ${ok ? 'YES ' : 'NO  '} ${note}`
  );
}

// (c) What must not resolve. The pattern's character class means `!!!!` and an
// empty segment never match at all; `AAAA` and `A` match and are refused by the
// decoder, which is the `string | null` seam KAN-142 left for exactly this.
const garbage = [
  { label: 'not base64 at all      ', url: `${SITE}/wiki/x/!!!!` },
  { label: 'nothing after /x/      ', url: `${SITE}/wiki/x/` },
  { label: 'decodes to 0           ', url: `${SITE}/wiki/x/AAAA` },
  { label: 'decodes to 0, one char ', url: `${SITE}/wiki/x/A` },
  { label: 'more than 8 bytes      ', url: `${SITE}/wiki/x/AQAAAAAAAAABAQ` }
];

console.log('\n  (c) a tiny link that does not decode to a positive page id resolves to nothing:\n');
let garbageOk = true;
for (const { label, url } of garbage) {
  const resolved = await registry.resolve(url);
  const ok = resolved === null;
  garbageOk &&= ok;
  console.log(`      ${label} ${url.padEnd(46)} → ${show(resolved)}${ok ? '' : '   (expected null)'}`);
}

console.log(
  '\n      Nothing is the honest answer here, and the important half of it: a tiny id\n' +
  '      must never itself become a key. `workspaces/confluence/AAAA` alongside\n' +
  '      `workspaces/confluence/196787` is the split this task exists to prevent.'
);

console.log(
  '\n  One asymmetry this leaves behind, named rather than hidden: 196725 and 163933\n' +
  '  are space *home* pages. They are real pages with real ids and real tiny links,\n' +
  '  so their tiny links now resolve — while their canonical URL is the space\n' +
  '  overview form, which KAN-142 deliberately does not match. So those two pages\n' +
  '  open from one address and not the other. That is not the two-workspaces hazard\n' +
  '  — it is one key or no key, never two — and narrowing it would need a Confluence\n' +
  '  lookup on the resolution path, which KAN-90 rules out. Filed as a follow-up.'
);

verdict(
  identityOk && observedOk && garbageOk,
  'the tiny link and the canonical URL are one workspace, the decoder matches every\n' +
  '    tiny link Confluence reported, and what does not decode resolves to nothing.',
  identityOk
    ? 'the decoder disagreed with a tiny link Confluence reported, or something that\n' +
      '    does not decode resolved to a key — see the rows above.'
    : 'a tiny link and the canonical URL for the same page resolved DIFFERENTLY — that\n' +
      '    page now gets two workspaces with two conversation histories. See section 7(a).'
);

console.log('\n== done ==');
