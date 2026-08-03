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
 */
export interface McpServerDefinition {
  command: string;
  args: string[];
  env?: Record<string, string>;
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
