// Proof for KAN-603 that a workspace provisioned while the Atlassian proxy is
// on comes up WITHOUT the official `atlassian` MCP server, and that an
// un-proxied install is unchanged.
//
// WHAT FAILURE THIS WOULD CATCH: `atlassianMcpServers()` emitting the official
// `mcp-remote` server into every workspace's `.mcp.json` regardless of whether
// the proxy — which carries every Atlassian action the fleet performs, under
// the daemon's own credential — is serving. That server is a remote endpoint
// needing a per-machine browser OAuth flow nobody completes, so on a fresh box
// it is a guaranteed hang at first boot, and the failure mode is an agent
// waiting quietly rather than erroring. Measured on `servyboi`, 2026-08-21:
// four `mcp-remote` processes hanging on https://mcp.atlassian.com, none
// authenticated, and `task/KAN-568` spending its runway inside
// `until ls ~/.mcp-auth/…/*token*; do sleep 3; done`.
//
// CI-RUNNABLE: yes — no daemon, no network, no herdr, no real credential. The
// gate under test reads `process.env.BUTCHR_ATLASSIAN_PROXY` at call time, so
// every rung is exercised in-process by setting it and running the real
// registry and the real writer.
//
// ── THE DISCRIMINATING ARM, WHICH IS THE POINT OF §2 ──────────────────────
//
// A gate that returned `{}` unconditionally would pass §1 perfectly, and so
// would a registry that had simply stopped contributing anything. §2 is what
// separates "the server is withheld while the proxy serves" from "the server
// is gone": with the variable unset — the default, and what an un-proxied
// install runs — the same code path must still write `atlassian`. So §2 is
// also §1's positive control. It names what the instrument prints when the
// server IS there, on the same instrument, three lines further down; an
// absence check whose reader has never seen its own present-case output has
// measured its search rather than the world.
//
// ── WHAT IS REAL HERE AND WHAT IS SUBSTITUTED ─────────────────────────────
//
// Real: `WorkspaceRegistry`, `createAtlassianIntegration`,
// `coreMcpServerDefinitions` and `writeWorkspaceMcpConfig` — the same four
// daemon.ts and herdr.ts use — and a real directory, read back off disk as
// bytes rather than asserted on in memory.
//
// Substituted: the credential, as a stub reporting `configured: true`. The
// registry drops an integration whose credential is unconfigured, which on a
// runner with no token would empty every arm below and make §2 unfailable —
// a green with no red available, which is the shape this board treats as no
// check at all. That gate is a DIFFERENT gate and is proved elsewhere:
// `verify-mcp-assembly.mjs` §4 owns it, and nothing here re-tests it.
//
// ── WHAT THIS DOES NOT COVER, AND WHO DOES ────────────────────────────────
//
// This asserts the assembly-and-write leg. It does NOT exercise a real
// activation spawning a real agent, so it cannot tell you that herdr hands
// this assembly to the workspace it provisions — `writeWorkspaceMcpConfig` is
// called here directly rather than reached through `initPty`. That leg is
// `verify-workspace-mcp-preparation.mjs`'s and
// `verify-activation-records-real-parentage.mjs`'s; between them the chain is
// covered, and neither of them knows about the proxy gate.
//
// Nor does it show that an agent can do real ticket work with no Atlassian MCP
// present. That is KAN-293's criterion and `probe-atlassian-retirement.mjs`
// answers it with a real model on a real ticket; a green here is not evidence
// for it.
//
// Usage: node daemon/scripts/verify-atlassian-server-retired.mjs [--verbose]
// Run it after `npm run build` in daemon/.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { requireFreshDist } from './lib/require-fresh-dist.mjs';
import { reportAndExit } from './lib/verdict-exit.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const distDir = path.join(daemonDir, 'dist');
const verbose = process.argv.includes('--verbose');

requireFreshDist(path.join(daemonDir, 'src'), distDir, {
  hint: 'npm run build --prefix daemon'
});

const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { atlassianMcpServers } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);
const { coreMcpServerDefinitions, writeWorkspaceMcpConfig } = await import(
  path.join(distDir, 'launchers.js')
);
const { PROXY_MODES, PROXY_ENV_VAR } = await import(path.join(distDir, 'atlassian-proxy.js'));

let failures = 0;
const skipped = 0;

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const check = (label, ok, detail) => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if ((!ok || verbose) && detail) console.log(`         ${detail}`);
  if (!ok) failures++;
};
const indent = (text) => text.split('\n').map((l) => `     ${l}`).join('\n');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan603-retire-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

/**
 * A credential that reports itself configured — see the header for why this is
 * substituted and what still owns the gate it stands in for.
 */
const configuredCredential = {
  status: () => ({ configured: true }),
  storageTarget: async () => ({ storage: 'file', reason: 'this script only' }),
  setCredential: async () => ({ valid: true }),
  clearCredential: async () => {}
};

/**
 * Provision one workspace exactly as the daemon does, at the given proxy mode,
 * and hand back the bytes that landed on disk.
 *
 * `undefined` means the variable is unset, which is not the same statement as
 * `off` and is checked as its own case below: unset is what a machine that has
 * never heard of the proxy runs, and it is the default this fix must not move.
 */
let seq = 0;
function provision(rawMode) {
  const before = process.env[PROXY_ENV_VAR];
  if (rawMode === undefined) delete process.env[PROXY_ENV_VAR];
  else process.env[PROXY_ENV_VAR] = rawMode;

  try {
    const workspace = path.join(scratch, `ws-${seq++}`);
    fs.mkdirSync(workspace, { recursive: true });
    const registry = new WorkspaceRegistry(
      new IntegrationStateStore(path.join(workspace, 'integrations.json'))
    );
    registry.registerIntegration(createAtlassianIntegration({ credential: configuredCredential }));
    registry.setEnabled('jira', true);

    const assembled = { ...registry.mcpServerDefinitions(), ...coreMcpServerDefinitions() };
    writeWorkspaceMcpConfig(workspace, assembled);
    const bytes = fs.readFileSync(path.join(workspace, '.mcp.json'), 'utf8');
    return { bytes, servers: Object.keys(JSON.parse(bytes).mcpServers) };
  } finally {
    if (before === undefined) delete process.env[PROXY_ENV_VAR];
    else process.env[PROXY_ENV_VAR] = before;
  }
}

// ------------------------------------------------ 1. every rung above off --

rule('AC1 — with the proxy serving, a provisioned workspace has butchr and NOT atlassian');

const rungs = PROXY_MODES.filter((mode) => mode !== 'off');
console.log(`\n  rungs above off, read from PROXY_MODES rather than listed here: ${rungs.join(', ')}\n`);

for (const mode of rungs) {
  const { servers } = provision(mode);
  check(
    `${PROXY_ENV_VAR}=${mode} → ${servers.join(', ') || '(no servers at all)'}`,
    servers.includes('butchr') && !servers.includes('atlassian'),
    servers.includes('atlassian')
      ? 'the official server was written anyway — the gate did not fire'
      : 'butchr is missing, so this workspace has NO route to Atlassian at all'
  );
}

console.log(
  '\n  Every rung, not just the one this fleet happens to run. The gate is written\n' +
    "  `!== 'off'`, so a rung added later is covered by construction; reading the list\n" +
    '  off PROXY_MODES rather than repeating it here is what keeps that true.'
);

// -------------------------- 2. the off path, which is also §1's control ----

rule('AC2 — unset and off still get the official server: an un-proxied install is unchanged');

const unset = provision(undefined);
const explicitOff = provision('off');

console.log(`\n  ${PROXY_ENV_VAR} unset  → ${unset.servers.join(', ')}`);
console.log(`  ${PROXY_ENV_VAR}=off    → ${explicitOff.servers.join(', ')}`);
console.log('\n  what the file looks like when the server IS there:\n');
console.log(indent(unset.bytes));

check(
  'unset — the default — still writes atlassian',
  unset.servers.includes('atlassian') && unset.servers.includes('butchr'),
  'the server is gone from the un-proxied path too, which retires it for installs that ' +
    'have no other route to Atlassian'
);
check(
  'off, said explicitly, still writes atlassian',
  explicitOff.servers.includes('atlassian') && explicitOff.servers.includes('butchr'),
  'an operator who turned the proxy off got no Atlassian access at all'
);
check(
  'an unrecognised value falls to off, and therefore still writes atlassian',
  provision('jira-reed').servers.includes('atlassian'),
  'a typo silently retired the server — the fallback must not be able to remove access'
);

console.log(
  '\n  These three are the positive control for AC1. The absence asserted above is read\n' +
    '  by the same code that reports the presence here, on the same instrument, against a\n' +
    "  real file — so \"not there\" is a statement about the world rather than about this\n" +
    '  script\'s ability to look.'
);

// ------------------------------------- 3. the decision cannot be skipped ---

rule('AC3 — consulting the proxy is a compile-time obligation, not a convention');

check(
  'atlassianMcpServers takes the mode as a required parameter (arity 1)',
  atlassianMcpServers.length === 1,
  `arity is ${atlassianMcpServers.length} — a zero-argument signature lets a call site ` +
    'emit the server without ever consulting the proxy, which is the shape the defect had'
);

const asOff = Object.keys(atlassianMcpServers('off'));
const asOn = Object.keys(atlassianMcpServers('jira-read'));
console.log(`\n  atlassianMcpServers('off')       → ${asOff.join(', ') || '(none)'}`);
console.log(`  atlassianMcpServers('jira-read') → ${asOn.join(', ') || '(none)'}`);

check(
  'called directly, the mode alone decides',
  asOff.includes('atlassian') && asOn.length === 0,
  'the function does not honour its own argument'
);

console.log(
  '\n  The parameter is the half a later author cannot delete without the compiler\n' +
    '  objecting at every call site. The assertion above is belt as well as braces, in\n' +
    '  that order — it is what catches a signature that keeps the parameter and ignores it.'
);

// ------------------------------------------------------------- verdict ----

console.log();
reportAndExit({ failures, skipped });
