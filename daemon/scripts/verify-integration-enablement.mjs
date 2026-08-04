// Proof for KAN-85's enabled state: an integration is off until it is turned
// on, a disabled one contributes nothing, a URL it would have claimed is
// refused with *that* reason rather than as an unrecognised URL, and an
// install that already had a configured credential is never silently switched
// off.
//
// WHAT FAILURE THIS WOULD CATCH: an integration that is live before anyone
// turned it on, a disabled one still contributing workspace types or MCP
// servers, a URL it would have claimed being refused as merely unrecognised
// rather than as switched off, or an upgrade silently disabling an install
// that already had a working credential.
//
// Six sections:
//
//   1. default        — a fresh install with no credential comes up disabled,
//                       contributing no workspace types and no MCP servers
//   2. migration      — the hazard task 11 names: an install whose credential
//                       is already configured comes up ENABLED on first read,
//                       and the decision is written down rather than re-derived
//   3. legible        — with the integration off, a Jira URL is refused as
//                       "the integration is switched off", not "unsupported
//                       URL"; by-key activation says the same thing
//   4. no server      — and the assembled .mcp.json has no `atlassian` entry,
//                       while core's `butchr` is still there
//   5. reversible     — enabling through the router action brings the types,
//                       the server and the resolution back with no restart
//   6. persisted      — the decision survives a new registry over the same
//                       state file, which is what a daemon restart is
//
// Every registry here has its own throwaway state file: a proof script must
// not write into the machine's real ~/.local/share/butchr/integrations.json.
// The credential adapters are stubs for the same reason — this script must be
// able to show both an unconfigured and a configured install on any machine.
//
// Usage: node daemon/scripts/verify-integration-enablement.mjs [distDir]

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
const { coreMcpServerDefinitions } = await import(path.join(distDir, 'launchers.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const verdict = (ok, yes, no) => {
  if (!ok) process.exitCode = 1;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};
const indent = (text) => text.split('\n').map((l) => `     ${l}`).join('\n');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan85-enable-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

const ISSUE_URL = 'https://wroosbit.atlassian.net/browse/KAN-85';

/** A credential adapter that reports exactly the configured-ness asked for. */
const stubCredential = (configured) => ({
  status: () => (configured ? { configured: true, storage: 'file' } : { configured: false }),
  storageTarget: async () => ({ storage: 'file', reason: 'this script only' }),
  setCredential: async () => ({ valid: false }),
  clearCredential: async () => {}
});

/** A registry wired as daemon.ts wires it, on its own state file. */
function install(name, { configured }) {
  const statePath = path.join(scratch, `${name}.json`);
  const registry = new WorkspaceRegistry(new IntegrationStateStore(statePath));
  registry.registerIntegration(
    createAtlassianIntegration({
      issueTypeLookup: async () => 'Task',
      credential: stubCredential(configured)
    })
  );
  return { registry, statePath };
}

const serversOf = (registry) =>
  Object.keys({ ...registry.mcpServerDefinitions(), ...coreMcpServerDefinitions() });

/** Drive one request through the real router and await its correlated reply. */
function drive(registry, message) {
  return new Promise((resolve) => {
    const router = new MessageRouter(registry, null, null, (msg) => resolve(msg));
    router.handle(message);
  });
}

// ------------------------------------------------------------ 1. default --

rule('AC1 — a fresh install, no credential: disabled, contributing nothing');

const fresh = install('fresh', { configured: false });
const freshIntegration = fresh.registry.integrations()[0];

console.log(`\n  enabled                 ${freshIntegration.enabled}`);
console.log(`  registry.get('task')    ${fresh.registry.get('task') ? 'registered' : 'not registered'}`);
console.log(`  MCP servers assembled   ${serversOf(fresh.registry).join(', ')}`);
console.log(`  state written           ${fs.readFileSync(fresh.statePath, 'utf8').trim()}`);

verdict(
  freshIntegration.enabled === false &&
    !fresh.registry.get('task') &&
    !serversOf(fresh.registry).includes('atlassian') &&
    serversOf(fresh.registry).includes('butchr'),
  'off until turned on: no workspace types, no MCP server, and core is unaffected.',
  'a never-configured integration started contributing on its own.'
);

// ---------------------------------------------------------- 2. migration --

rule('AC2 — an install whose credential is already configured migrates as ENABLED');

console.log(
  '\n  The hazard: this machine runs a live fleet on a configured Atlassian credential.\n' +
  '  A naive "default disabled" applied on the next daemon restart would unregister\n' +
  '  epic/story/task, leave every Jira URL unresolvable and strand agents nobody\n' +
  '  could reactivate. So the default is a function of what is already there.\n'
);

const existing = install('existing', { configured: true });
const existingIntegration = existing.registry.integrations()[0];
const types = existingIntegration.workspaceTypes
  .map((t) => t.type)
  .filter((t) => !!existing.registry.get(t));

console.log(`  enabled                 ${existingIntegration.enabled}`);
console.log(`  types registered        ${types.join(', ')}`);
console.log(`  MCP servers assembled   ${serversOf(existing.registry).join(', ')}`);
console.log(`  state written           ${fs.readFileSync(existing.statePath, 'utf8').trim()}`);

const migratedResolve = await existing.registry.resolve(ISSUE_URL);
console.log(`\n  resolving ${ISSUE_URL}\n            → ${migratedResolve ? `{ type: '${migratedResolve.config.type}', key: '${migratedResolve.key}' }` : 'null'}`);

verdict(
  existingIntegration.enabled === true &&
    types.length === 3 &&
    serversOf(existing.registry).includes('atlassian') &&
    migratedResolve !== null,
  'the existing install keeps working: enabled, all three types, its server, URLs resolving.',
  'a configured install was switched off by the new default — this is the stranding bug.'
);

// ----------------------------------------------------------- 3. legible --

rule('AC3 — with it switched off, a Jira URL is refused with the reason, not as "unsupported"');

const live = install('live', { configured: true });
live.registry.setEnabled('jira', false);

const refusedByUrl = await drive(live.registry, { action: 'activate', url: ISSUE_URL });
const refusedByKey = await drive(live.registry, {
  action: 'activate_by_key',
  type: 'task',
  key: 'KAN-85'
});
const status = await drive(live.registry, { action: 'status', url: ISSUE_URL });

console.log('\n  activate (by URL):\n');
console.log(indent(JSON.stringify(refusedByUrl, null, 2)));
console.log('\n  activate_by_key:\n');
console.log(indent(JSON.stringify(refusedByKey, null, 2)));
console.log('\n  status (what the sidepanel asks):\n');
console.log(indent(JSON.stringify(status, null, 2)));

verdict(
  refusedByUrl.success === false &&
    refusedByUrl.refusedBy === 'integration-disabled' &&
    refusedByUrl.integration === 'jira' &&
    /switched off/.test(refusedByUrl.error) &&
    !/Unsupported URL/.test(refusedByUrl.error) &&
    refusedByKey.refusedBy === 'integration-disabled' &&
    status.refusedBy === 'integration-disabled',
  'every refusal names the switched-off integration and the fix; none of them lies about the URL.',
  'a disabled integration\'s URL was refused as unrecognised, which is the lie this exists to prevent.'
);

// ---------------------------------------------------------- 4. no server --

rule('AC4 — and its MCP server is out of the assembly while core stays in');

console.log(`\n  MCP servers assembled   ${serversOf(live.registry).join(', ')}`);
console.log(
  '\n  Agents that are already running are untouched: they keep the .mcp.json already\n' +
  '  written into their workspaces. Only the next activation sees this.'
);

verdict(
  !serversOf(live.registry).includes('atlassian') && serversOf(live.registry).includes('butchr'),
  'the disabled integration contributes no server; the daemon\'s own is unaffected.',
  'a disabled integration was still contributing an MCP server.'
);

// --------------------------------------------------------- 5. reversible --

rule('AC5 — enabling through the router action brings everything back, with no restart');

const enabled = await drive(live.registry, {
  action: 'set_integration_enabled',
  integration: 'jira',
  enabled: true
});
const resolvedAgain = await live.registry.resolve(ISSUE_URL);

console.log('\n  set_integration_enabled { integration: "jira", enabled: true } →\n');
console.log(indent(JSON.stringify({ ...enabled, providedTypes: '…as listed above…' }, null, 2)));
console.log(`\n  resolving ${ISSUE_URL}\n            → ${resolvedAgain ? `{ type: '${resolvedAgain.config.type}', key: '${resolvedAgain.key}' }` : 'null'}`);
console.log(`\n  MCP servers assembled   ${serversOf(live.registry).join(', ')}`);
console.log(
  '\n  No restart: the same registry object answers differently on the next call,\n' +
  '  because enabling registers the types and un-gates the servers in place.'
);

verdict(
  enabled.success === true &&
    enabled.enabled === true &&
    resolvedAgain !== null &&
    resolvedAgain.config.type === 'task' &&
    serversOf(live.registry).includes('atlassian'),
  'the toggle is immediate and complete: types, server and resolution all return.',
  'enabling did not restore what disabling removed.'
);

// ---------------------------------------------------------- 6. persisted --

rule('AC6 — the decision survives a restart, which is a new registry over the same file');

live.registry.setEnabled('jira', false);
const afterRestart = new WorkspaceRegistry(new IntegrationStateStore(live.statePath));
afterRestart.registerIntegration(
  createAtlassianIntegration({
    issueTypeLookup: async () => 'Task',
    credential: stubCredential(true)
  })
);

console.log(`\n  disabled, then a fresh registry over the same state file:`);
console.log(`    enabled               ${afterRestart.integrations()[0].enabled}`);
console.log(`    registry.get('task')  ${afterRestart.get('task') ? 'registered' : 'not registered'}`);
console.log(`    state on disk         ${fs.readFileSync(live.statePath, 'utf8').trim()}`);
console.log(
  '\n  Note what did NOT happen: the credential is still configured, and the migration\n' +
  '  did not re-fire and turn it back on. The migration decides only when nothing has\n' +
  '  been decided — a deliberate choice, once, rather than a default reapplied forever.'
);

verdict(
  afterRestart.integrations()[0].enabled === false && !afterRestart.get('task'),
  'a recorded decision wins over the migration default, which is what makes it a decision.',
  'the persisted decision did not survive, or the migration overrode it.'
);

console.log('\n== done ==');
