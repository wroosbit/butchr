import { WorkspaceTypeConfig } from '../types.js';
import { CredentialStatus, StorageTarget } from '../credentials.js';

// An integration is Butchr's unit of extension: one outside system, the
// workspace types it contributes, the credential that reaches it, the MCP
// servers its agents get, and whether it is switched on.
//
// Before this file, "Jira's workspace types" were three `register` calls in
// the registry's constructor, the issue-type mapping was a module constant
// next to them, the lookup that drives refinement was injected into the
// registry itself, and the Atlassian MCP server's definition sat in a
// hardcoded if-chain in launchers.ts that had no idea it was Jira's. Nothing
// named the thing they collectively are, so adding a second system meant
// editing three modules that each knew a piece of it. The registry now knows
// only how to *take* an integration; what Atlassian is lives in
// atlassian-integration.ts, and what LaunchDarkly is lives in launchdarkly.ts.

/**
 * The four operations a stored credential supports, as KAN-86 shipped them on
 * `LaunchDarklyIntegration` and as `JiraIssueTypeService` already answered
 * them. Named here rather than reinvented: both classes satisfy this by
 * construction, and neither changed to do so.
 *
 * `Fields` and `Result` are the integration's own — Jira submits site URL,
 * email and token and answers a `ValidationResult`; LaunchDarkly submits a
 * token and answers an `LdValidationResult`. The shared part is the *shape of
 * the surface*, not the payloads, so they are left to the implementation and
 * the concrete types stay where they are documented.
 */
export interface CredentialAdapter<Fields = any, Result = any> {
  /** Non-secret summary — safe to send to the UI and to log. */
  status(): CredentialStatus;
  /** Where a credential submitted right now would land, answered before entry. */
  storageTarget(): Promise<StorageTarget>;
  /** Validate first, store only if valid. Never answers with the secret. */
  setCredential(fields: Fields): Promise<Result>;
  /** Remove the credential from every backend. Idempotent. */
  clearCredential(): Promise<void>;
}

/**
 * One MCP server, in the shape Claude Code's `.mcp.json` and the other agent
 * CLIs read: a command and its arguments. Written verbatim into the
 * workspace's config by writeWorkspaceMcpConfig.
 *
 * A definition is also *described* to the settings page (KAN-106), and there is
 * one rule about that which belongs here rather than only at the far end: if a
 * definition is built from a stored credential, the credential goes in `env`.
 * `describeMcpServers` in router.ts reports an `env`-carrying definition by
 * name alone and never reports `env` itself, so that convention is what keeps a
 * token out of a UI. A token smuggled into `args` would be rendered like any
 * other argument.
 */
export interface McpServerDefinition {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * Directories to place ahead of `PATH` **in this server's own process**,
   * materialized into the written `env.PATH` by the config writers in
   * launchers.ts. Added by KAN-157.
   *
   * WHY THIS EXISTS AT ALL. `npx` is a `#!/usr/bin/env node` script and so is
   * the bin of the package it fetches, so naming an absolute `npx` in `command`
   * decides nothing about which Node actually runs the server — the PATH the
   * process is handed does. That was measured, not assumed; the transcript is in
   * node-runtime.ts. Without this field the Atlassian server's interpreter is
   * whatever the daemon's PATH happens to front, which is precisely KAN-157.
   *
   * WHY IT IS NOT `env`, WHICH IS WHERE A PATH WOULD OBVIOUSLY GO. `env` is the
   * credential channel, and `describeMcpServers` in router.ts closes any
   * `env`-carrying definition down to its bare name for that reason. Putting a
   * search path there would have hidden Atlassian's command line from the
   * settings page and told its reader "configured from your stored credential",
   * which is false — mcp-remote does its own OAuth and this definition carries
   * no token. The alternative was an exemption to a security rule bought by a
   * plumbing change, which KAN-145 already declined to do for the same reason.
   *
   * A list of directories is safe to report because the daemon composes it: an
   * integration supplies directories, the writer joins them onto the daemon's
   * own PATH. That is the same standing this field has as `args` — see the
   * limit stated on `describeMcpServers`, which applies here unchanged.
   */
  pathPrefix?: string[];
  /**
   * Set when this server **cannot start on this machine**, in one sentence
   * naming what is wrong and what to do about it. Added by KAN-157.
   *
   * A definition is still returned when it is unusable, rather than being
   * omitted or thrown over, because two different readers need it: the settings
   * page has to be able to say *why* a server it advertises will not run, and
   * the activation path has to be able to refuse with that reason in its error.
   * An omitted server would leave both saying nothing, which is the original bug
   * in a new costume — a workspace whose Atlassian server silently does not
   * exist.
   *
   * The writers strip this field before it reaches disk: it is Butchr's note to
   * its own reader, not a key any MCP client reads.
   */
  unusable?: string;
}

/** Server name → definition, exactly as the `mcpServers` object is keyed. */
export type McpServerDefinitions = Record<string, McpServerDefinition>;

/**
 * The MCP servers an integration provides, resolved fresh on every call.
 *
 * A function rather than data because the definitions bake absolute paths
 * (`which('npx')`, `process.execPath`) and the daemon rewrites `.mcp.json` on
 * every activation precisely so those paths cannot go stale — see the comment
 * on Atlassian's definition. Data captured once at registration would defeat
 * that.
 */
export type McpServerProvider = () => McpServerDefinitions;

/**
 * One outside system, as the daemon knows it.
 *
 * `workspaceTypes` may be empty: LaunchDarkly holds a credential and owns no
 * workspace types, which is an honest answer rather than a missing one. A
 * credential is likewise optional — an integration that needs no auth is
 * simply one that contributes types — and so are `mcpServers`.
 */
export interface Integration {
  /** Stable id: 'jira', 'launchdarkly', … Matches the credential spec's id. */
  id: string;
  /** Display name, as the settings UI renders it. */
  name: string;
  /**
   * The workspace types this integration contributes, in registration order.
   * A type's URL patterns, key extraction, prompt, priority, supervisor-ness
   * and refinement hook all travel with it — the registry adds no knowledge of
   * its own about what any particular type means.
   */
  workspaceTypes: WorkspaceTypeConfig[];
  /**
   * Whether this integration is turned on.
   *
   * Every factory declares `false`: an integration is off until the user turns
   * it on, so a release that adds one does not start contributing workspace
   * types and MCP servers to every spawned agent on its own. The registry
   * overwrites this at registration from the persisted decision — including
   * the migration that keeps an already-configured install working. See
   * enablement.ts, and `WorkspaceRegistry.registerIntegration`.
   *
   * A disabled integration contributes nothing: no workspace types, no MCP
   * servers. It stays registered and still appears in `list_integrations`,
   * with what it *would* provide, because that is what the toggle is rendered
   * from.
   */
  enabled: boolean;
  /**
   * Present when this integration stores a credential.
   *
   * What the credential is *for*: it is input to the MCP server definition —
   * the server the agents get is configured with the stored token — not fuel
   * for daemon-side vendor API calls, which the daemon neither needs nor holds
   * write scope for. Butchr writes per-workspace config sourced from a
   * 0600/keyring store rather than registering a vendor server globally with
   * its token as a plaintext argv parameter. (Jira's own server happens to
   * need no token: mcp-remote does its own OAuth.)
   */
  credential?: CredentialAdapter;
  /**
   * The MCP servers this integration provides to spawning agents.
   *
   * These attach to **every** agent this daemon spawns once the integration is
   * enabled and configured — not only to agents of the workspace types this
   * integration owns. The two readings coincide for Atlassian, which owns all
   * three types today, and
   * diverge only for a type-less integration; a type-less integration that
   * could contribute to nothing would be pointless, and contributing tools to
   * every agent is the whole point of being able to add one.
   *
   * "Configured" means configured: where an integration has a credential, the
   * registry attaches its servers only while `credential.status().configured`
   * is true, so an integration whose credential is absent never injects a
   * server its agents cannot authenticate. A disabled integration contributes
   * none of them at all.
   */
  mcpServers?: McpServerProvider;
}
