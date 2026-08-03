// Proof for KAN-85 that moving the MCP server definitions out of the launcher
// and into the integrations that own them changed *where they come from* and
// nothing else: the `.mcp.json` a spawning agent boots with is byte-identical
// to the one `origin/main` writes today.
//
// Before: `mcpServerDefinitions()` in launchers.ts, a hardcoded if-chain
// resolving the bare strings a workspace type listed — `atlassian` → npx
// mcp-remote, `butchr` → node dist/mcp.js. After: the Atlassian integration
// owns its definition, `butchr` is core, and the registry aggregates what the
// enabled-and-configured integrations provide.
//
// Four sections:
//
//   1. what main wrote     — origin/main's if-chain, reproduced here as a
//                            literal so this script can compare against it
//                            without needing a second checkout, and the file
//                            it produces for ['atlassian', 'butchr']
//   2. what this writes    — the same workspace directory, written by the real
//                            writeWorkspaceMcpConfig from the real registry's
//                            assembly, and a byte comparison of the two
//   3. the merge is intact — an existing .mcp.json carrying a server of the
//                            user's own keeps it, exactly as before
//   4. the gates           — an unconfigured or disabled integration
//                            contributes nothing, and core still does
//
// The credential is read from this machine, not stubbed: what this script
// asserts about section 2 is what this machine's daemon actually writes.
//
// Usage: node daemon/scripts/verify-mcp-assembly.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(process.argv[2] ?? path.join(scriptDir, '..', 'dist'));

const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);
const { coreMcpServerDefinitions, writeWorkspaceMcpConfig } = await import(
  path.join(distDir, 'launchers.js')
);
const { JiraIssueTypeService } = await import(path.join(distDir, 'jira.js'));
const { CredentialStore } = await import(path.join(distDir, 'credentials.js'));
const { which } = await import(path.join(distDir, 'env.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const verdict = (ok, yes, no) => {
  if (!ok) process.exitCode = 1;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};
const indent = (text) => text.split('\n').map((l) => `     ${l}`).join('\n');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan85-mcp-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

// ------------------------------------------------------ 1. what main wrote --

rule('AC1 — the definitions origin/main produces, reproduced verbatim');

/**
 * `mcpServerDefinitions(['atlassian', 'butchr'])` as it stands on origin/main
 * at 8d765e8 — copied from launchers.ts:14-33, with the same `which('npx')`
 * resolution and the same `dist/mcp.js` path relative to the built module.
 * A literal rather than an import so this comparison needs no second checkout;
 * if it ever drifts from what main writes, section 2's byte comparison is the
 * thing that would have to be re-argued.
 */
const mainDefinitions = () => ({
  atlassian: {
    command: which('npx') ?? 'npx',
    args: ['-y', 'mcp-remote', 'https://mcp.atlassian.com/v1/mcp']
  },
  butchr: {
    command: process.execPath,
    args: [path.join(distDir, 'mcp.js')]
  }
});

const mainWorkspace = path.join(scratch, 'main');
fs.mkdirSync(mainWorkspace, { recursive: true });
fs.writeFileSync(
  path.join(mainWorkspace, '.mcp.json'),
  JSON.stringify({ mcpServers: mainDefinitions() }, null, 2)
);
const mainBytes = fs.readFileSync(path.join(mainWorkspace, '.mcp.json'), 'utf8');

console.log('\n  what a task/story/epic workspace gets on origin/main:\n');
console.log(indent(mainBytes));

verdict(
  mainBytes.includes('mcp-remote') && mainBytes.includes('mcp.js'),
  'the baseline is the real pair: the Atlassian remote bridge and Butchr\'s own server.',
  'the reproduced baseline is not what it should be.'
);

// ----------------------------------------------------- 2. what this writes --

rule('AC2 — the restructured code writes the same bytes');

// The production wiring, exactly as daemon.ts assembles it — the real
// credential store, so the configured-gate below is answered by this machine.
const jira = new JiraIssueTypeService(new CredentialStore());
const registry = new WorkspaceRegistry(
  new IntegrationStateStore(path.join(scratch, 'integrations.json'))
);
registry.registerIntegration(
  createAtlassianIntegration({
    issueTypeLookup: (key) => jira.getIssueTypeName(key),
    credential: jira
  })
);

const credentialConfigured = !!jira.status().configured;
console.log(`\n  this machine's Atlassian credential: ${credentialConfigured ? 'configured' : 'NOT configured'}`);
console.log(
  `  enabled state after registration:   ${registry.integrations()[0].enabled}` +
    `   (a configured credential migrates as enabled — see enablement.ts)`
);
if (!credentialConfigured) {
  // Keep the comparison meaningful on a machine with no credential: the point
  // of section 2 is the assembly, and the gate has its own section below.
  registry.setEnabled('jira', true);
  console.log('  no credential here, so the integration is switched on explicitly for this section');
}

const assembled = { ...registry.mcpServerDefinitions(), ...coreMcpServerDefinitions() };
const mineWorkspace = path.join(scratch, 'mine');
fs.mkdirSync(mineWorkspace, { recursive: true });
writeWorkspaceMcpConfig(mineWorkspace, assembled);
const mineBytes = fs.readFileSync(path.join(mineWorkspace, '.mcp.json'), 'utf8');

console.log('\n  what the same workspace gets now:\n');
console.log(indent(mineBytes));
console.log(`\n  atlassian sourced from: the Atlassian integration (atlassian-integration.ts)`);
console.log(`  butchr sourced from:    core (launchers.ts, coreMcpServerDefinitions)`);
console.log(`\n  byte comparison: ${mineBytes === mainBytes ? 'IDENTICAL' : 'DIFFERENT'}`);

verdict(
  mineBytes === mainBytes,
  'byte-for-byte the file main writes — same servers, same commands, same key order.',
  'the assembled .mcp.json differs from what origin/main writes; see the two blocks above.'
);

// -------------------------------------------------- 3. the merge is intact --

rule('AC3 — an existing .mcp.json keeps whatever the user put in it');

const mergeWorkspace = path.join(scratch, 'merge');
fs.mkdirSync(mergeWorkspace, { recursive: true });
fs.writeFileSync(
  path.join(mergeWorkspace, '.mcp.json'),
  JSON.stringify(
    { mcpServers: { 'user-own': { command: '/bin/true', args: [] } }, otherKey: 'kept' },
    null,
    2
  )
);
writeWorkspaceMcpConfig(mergeWorkspace, assembled);
const merged = JSON.parse(fs.readFileSync(path.join(mergeWorkspace, '.mcp.json'), 'utf8'));

console.log('\n  after rewriting a workspace that already had a server of its own:\n');
console.log(indent(JSON.stringify(merged, null, 2)));

verdict(
  !!merged.mcpServers['user-own'] && !!merged.mcpServers.atlassian &&
    !!merged.mcpServers.butchr && merged.otherKey === 'kept',
  'the merge behaviour is unchanged: our servers are added, everything else survives.',
  'rewriting the workspace config lost something it should have kept.'
);

// ---------------------------------------------------------- 4. the gates --

rule('AC4 — an unconfigured or disabled integration contributes nothing; core always does');

/** An integration whose credential is present but not configured. */
const unconfigured = {
  id: 'unconfigured-example',
  name: 'Unconfigured Example (this script only)',
  enabled: false,
  workspaceTypes: [],
  credential: {
    status: () => ({ configured: false }),
    storageTarget: async () => ({ storage: 'file', reason: 'this script only' }),
    setCredential: async () => ({ valid: false }),
    clearCredential: async () => {}
  },
  mcpServers: () => ({ 'unconfigured-example': { command: '/bin/true', args: [] } })
};

const gates = new WorkspaceRegistry(
  new IntegrationStateStore(path.join(scratch, 'gates.json'))
);
gates.registerIntegration(unconfigured);
const whileDisabled = Object.keys({ ...gates.mcpServerDefinitions(), ...coreMcpServerDefinitions() });
gates.setEnabled('unconfigured-example', true);
const whileEnabledUnconfigured = Object.keys({
  ...gates.mcpServerDefinitions(),
  ...coreMcpServerDefinitions()
});

console.log(`\n  registered, disabled, unconfigured  → ${whileDisabled.join(', ')}`);
console.log(`  enabled but still unconfigured      → ${whileEnabledUnconfigured.join(', ')}`);
console.log(
  '\n  Both gates matter and they are different questions: "the user has not turned this\n' +
  '  on" and "there is no credential for the server to authenticate with". Either one\n' +
  '  keeps the server out of the file; core is unaffected by both.'
);

verdict(
  !whileDisabled.includes('unconfigured-example') &&
    !whileEnabledUnconfigured.includes('unconfigured-example') &&
    whileDisabled.includes('butchr') &&
    whileEnabledUnconfigured.includes('butchr'),
  'neither gate lets an unauthenticated server into an agent\'s config; core is always there.',
  'a gated integration contributed a server, or core went missing.'
);

console.log('\n== done ==');
