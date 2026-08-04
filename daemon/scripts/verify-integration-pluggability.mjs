// Proof for KAN-85: an integration is a pluggable unit — a module the daemon
// does not know about can contribute a workspace type *and* an MCP server, and
// both take effect live, with nothing in registry.ts or launchers.ts edited to
// make it happen.
//
// WHAT FAILURE THIS WOULD CATCH: the plug coming loose — a workspace type or
// an MCP server that only takes effect because the daemon hardcodes the
// integration's name. If a module the daemon has never heard of cannot be
// resolved and assembled by the same paths Atlassian's are, the extraction did
// not happen.
//
// The claim being tested is the architectural one. Before this ticket, adding
// a workspace type meant editing `registerDefaults()` inside the registry, and
// adding an MCP server meant editing a hardcoded if-chain in launchers.ts that
// had no idea whose server it was resolving. The test of whether that is fixed
// is not that Atlassian still works — it is that something the daemon has
// never heard of can be plugged in from outside and be resolved, and assembled
// into a workspace's `.mcp.json`, by the same code paths Atlassian's are.
//
// Five sections:
//
//   1. before      — the synthetic URL resolves to nothing and the synthetic
//                    server is absent, so nothing below is a coincidence
//   2. plugged in  — registered and enabled, the same URL resolves to its type
//                    and its server appears in the assembled definitions
//   3. written     — a real `.mcp.json` written to a real workspace directory
//                    by the real writeWorkspaceMcpConfig contains it
//   4. alongside   — Atlassian's own resolution and its `atlassian` server are
//                    unchanged on the same registry: plugging in is additive
//   5. reported    — the synthetic integration appears in `list_integrations`
//                    beside Atlassian, with its provided type, MCP server,
//                    priority, supervisor flag and enabled state
//
// The synthetic integration lives only in this script — no new real workspace
// type is registered anywhere in the daemon. Everything else is production
// code: the real WorkspaceRegistry, the real Atlassian integration, the real
// core server definition, the real config writer, and the real MessageRouter
// answering `list_integrations`.
//
// Usage: node daemon/scripts/verify-integration-pluggability.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

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
const { PRIORITY_TASK } = await import(path.join(distDir, 'priority.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const verdict = (ok, yes, no) => {
  if (!ok) process.exitCode = 1;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};
const show = (resolved) =>
  resolved ? `{ type: '${resolved.config.type}', key: '${resolved.key}' }` : 'null';
const indent = (text) => text.split('\n').map((l) => `     ${l}`).join('\n');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan85-plug-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

// -------------------------------------------- the integration from outside --
//
// A plausible second system: a support desk whose tickets are a workspace and
// whose agents get its own MCP server. Written exactly as
// atlassian-integration.ts is written — an object with an id, a name, its
// workspace types and its servers — and imported by nothing in src/.
const TICKET_URL = 'https://desk.example.com/tickets/SUP-4210';
const JIRA_ISSUE_URL = 'https://wroosbit.atlassian.net/browse/KAN-85';

const supportDesk = {
  id: 'support-desk',
  name: 'Support Desk (this script only)',
  enabled: false,
  workspaceTypes: [
    {
      type: 'ticket',
      name: 'Support Ticket',
      urlPatterns: [/https?:\/\/[^\/]+\/tickets\/(SUP-\d+)/i],
      keyExtractor: (url) => {
        const match = url.match(/\/tickets\/(SUP-\d+)/i);
        return match ? match[1].toUpperCase() : null;
      },
      // Borrowed because the prompt's content is irrelevant here; resolution
      // never reads it.
      promptTemplateFile: 'prompts/task.md',
      priority: PRIORITY_TASK
    }
  ],
  mcpServers: () => ({
    'support-desk': {
      command: '/usr/bin/env',
      args: ['support-desk-mcp', '--stdio']
    }
  })
};

// The registry a daemon comes up with, before anything of this script's is on
// it: Atlassian and nothing else, registered exactly as daemon.ts registers it
// and switched on. The enabled state goes to a throwaway file — a proof script
// must not write into the machine's real integrations.json.
const registry = new WorkspaceRegistry(
  new IntegrationStateStore(path.join(scratch, 'integrations.json'))
);
registry.registerIntegration(
  createAtlassianIntegration({ issueTypeLookup: async () => 'Story' })
);
registry.setEnabled('jira', true);

/** What a spawning agent would get right now: integrations, then core. */
const assembled = () => ({
  ...registry.mcpServerDefinitions(),
  ...coreMcpServerDefinitions()
});

// ------------------------------------------------------------- 1. before --

rule('AC1 — before it is plugged in, neither its URL nor its server exists');

const before = await registry.resolve(TICKET_URL);
console.log(`\n  integrations registered: ${registry.integrations().map((i) => i.id).join(', ')}`);
console.log(`\n  resolving ${TICKET_URL}\n            → ${show(before)}`);
console.log(`\n  MCP servers assembled:   ${Object.keys(assembled()).join(', ')}`);

verdict(
  before === null && !('support-desk' in assembled()),
  'no registered type claims the URL and no server is named for it.',
  'the synthetic type or server was already present — sections 2 and 3 would prove nothing.'
);

// --------------------------------------------------------- 2. plugged in --

rule('AC2 — registering and enabling it makes the URL resolve and the server appear');

registry.registerIntegration(supportDesk);
registry.setEnabled('support-desk', true);
const after = await registry.resolve(TICKET_URL);

console.log('\n  registry.registerIntegration(supportDesk)   ← the whole change');
console.log("  registry.setEnabled('support-desk', true)   ← the user turning it on");
console.log(`\n  integrations registered: ${registry.integrations().map((i) => i.id).join(', ')}`);
console.log(`\n  resolving ${TICKET_URL}\n            → ${show(after)}`);
console.log(`\n  priorityFor('ticket') = ${registry.priorityFor('ticket')}`);
console.log(`\n  MCP servers assembled:   ${Object.keys(assembled()).join(', ')}`);

verdict(
  after !== null && after.config.type === 'ticket' && after.key === 'SUP-4210' &&
    registry.priorityFor('ticket') === PRIORITY_TASK &&
    'support-desk' in assembled(),
  'a type the registry never knew about resolves live, and its server is in the assembly.',
  'the synthetic type did not resolve, or its server was not aggregated.'
);

// ------------------------------------------------------------ 3. written --

rule('AC3 — and it lands in a real workspace .mcp.json, written by the real writer');

const workspace = path.join(scratch, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
writeWorkspaceMcpConfig(workspace, assembled());
const written = fs.readFileSync(path.join(workspace, '.mcp.json'), 'utf8');

console.log(`\n  writeWorkspaceMcpConfig(${workspace})\n`);
console.log(indent(written.trimEnd()));

const parsed = JSON.parse(written);
verdict(
  !!parsed.mcpServers?.['support-desk'] &&
    parsed.mcpServers['support-desk'].args.includes('support-desk-mcp'),
  'the file an agent would boot with carries the synthetic integration\'s server verbatim.',
  'the written .mcp.json does not contain the synthetic server.'
);

// ---------------------------------------------------------- 4. alongside --

rule('AC4 — Atlassian resolves and contributes exactly as before on the same registry');

const jiraResolved = await registry.resolve(JIRA_ISSUE_URL);
console.log(`\n  resolving ${JIRA_ISSUE_URL}\n            → ${show(jiraResolved)}   (lookup answers "Story")`);
console.log(`\n  atlassian server still assembled: ${'atlassian' in assembled()}`);
console.log(`  butchr (core) still assembled:    ${'butchr' in assembled()}`);

verdict(
  jiraResolved !== null && jiraResolved.config.type === 'story' &&
    jiraResolved.key === 'KAN-85' &&
    'atlassian' in assembled() && 'butchr' in assembled(),
  'the URL match, the refinement to `story`, and both existing servers are untouched.',
  'plugging in a second integration changed how Atlassian resolves or what it contributes.'
);

// ----------------------------------------------------------- 5. reported --

rule('AC5 — the settings surface reports it beside Atlassian, off what it registered');

const listed = await new Promise((resolve) => {
  const router = new MessageRouter(registry, null, null, (msg) => {
    if (msg.action === 'list_integrations_response') resolve(msg);
  });
  router.handle({ action: 'list_integrations' });
});

console.log('');
console.log(
  indent(
    JSON.stringify(
      listed.integrations.map(({ id, name, enabled, available, providedTypes, providedMcpServers }) => ({
        id,
        name,
        enabled,
        available,
        providedMcpServers,
        providedTypes
      })),
      null,
      2
    )
  )
);

const row = listed.integrations.find((i) => i.id === 'support-desk');
verdict(
  !!row &&
    row.name === 'Support Desk (this script only)' &&
    row.enabled === true &&
    row.available === false &&
    row.providedMcpServers.join(',') === 'support-desk' &&
    row.providedTypes.length === 1 &&
    row.providedTypes[0].type === 'ticket' &&
    row.providedTypes[0].resolution === 'url-matched' &&
    row.providedTypes[0].supervisor === false &&
    listed.integrations.some((i) => i.id === 'jira' && i.name === 'Atlassian'),
  'the integration is reported with its type, its server, url-matched, non-supervisor, enabled.',
  'the settings surface did not report the registered integration faithfully.'
);

console.log('\n== done ==');
