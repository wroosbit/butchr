import { WorkspaceTypeConfig } from './types.js';
import { Integration, McpServerDefinitions } from './integrations/integration.js';
import { IntegrationStateStore } from './integrations/enablement.js';
import { DEFAULT_WORKSPACE_PRIORITY } from './priority.js';

// URL → workspace type, and nothing about any particular outside system.
//
// This module used to hardcode Jira: three `register` calls in the
// constructor, the Jira issue-type mapping beside them, and the lookup that
// drives refinement injected here. All of that moved to
// integrations/atlassian-integration.ts, which is now just the first caller of
// `registerIntegration`. What is left is the part that is true of every
// integration — match, refine, prioritize, aggregate what they provide, and
// hold whether they are turned on — so a second system is a module rather than
// an edit to this one.

/**
 * Workspace types that hand work out rather than doing it: an epic agent
 * staffs its stories, a story agent staffs its tasks.
 *
 * Aggregated from the `supervisor` flag on every registered type rather than
 * listed here, because the fact belongs to the type and the type belongs to
 * its integration. The set is module-level for one reason: `isSupervisorType`
 * is a free function that two modules import, and supervisor-ness is a
 * property of a workspace type rather than of a registry instance — the union
 * across registries is the same answer any one of them would give.
 *
 * Deliberately not exported: the predicate is the whole interface, and every
 * caller already goes through it (router.ts's capacity gate and its DTO
 * builders; verify-agent-preemption.mjs). Exporting the raw set would invite
 * exactly the second copy of the rule the `supervisor` DTO field exists to
 * prevent. The capacity model exempts supervisors from the cap — see the
 * header of capacity.ts for the argument.
 */
const SUPERVISOR_TYPES = new Set<string>();

export function isSupervisorType(type: string | null | undefined): boolean {
  return typeof type === 'string' && SUPERVISOR_TYPES.has(type);
}

export class WorkspaceRegistry {
  private types: Map<string, WorkspaceTypeConfig> = new Map();
  /** Keyed by id so re-registering an integration replaces it in place. */
  private integrationsById: Map<string, Integration> = new Map();

  /**
   * `state` is injectable so a proof script can point the persisted decisions
   * at a temp file instead of writing into the user's real BUTCHR_DIR.
   */
  constructor(private state: IntegrationStateStore = new IntegrationStateStore()) {}

  /**
   * Take an integration whole: it is remembered so the settings surface can
   * report what this daemon actually has rather than a list restated
   * elsewhere, and — if it is enabled — its workspace types are registered in
   * the order it declares them.
   *
   * The enabled decision is resolved here, once, and it is where the migration
   * lives. An integration nobody has decided about defaults to **off**, except
   * that one whose credential is already configured is an existing install:
   * defaulting *that* off would unregister its workspace types on the next
   * daemon restart, leave its URLs unresolvable and strand a running fleet. So
   * a configured credential migrates as enabled, and the decision is written
   * down at that moment rather than re-derived later — clearing a credential
   * afterwards must not silently disable an integration in use.
   */
  public registerIntegration(integration: Integration) {
    const configured = !!integration.credential?.status().configured;
    if (this.state.decideIfUndecided(integration.id, configured)) {
      console.log(
        `[Integrations] ${integration.id}: no enabled state on record; ` +
          (configured
            ? 'its credential is already configured, so it migrates as enabled'
            : 'defaulting to disabled until it is turned on')
      );
    }
    integration.enabled = this.state.isEnabled(integration.id, configured);

    this.integrationsById.set(integration.id, integration);
    this.applyEnablement(integration);
  }

  /**
   * Turn an integration on or off, persistently.
   *
   * Enabling registers its workspace types and starts contributing its MCP
   * servers; disabling unregisters and stops. Running agents are deliberately
   * untouched either way — they keep the `.mcp.json` already written into
   * their workspace and go on working, because a toggle is not a reason to
   * kill somebody's work. Only new activations are affected, and a URL that
   * belonged to a now-disabled integration is refused with that reason rather
   * than as an unrecognised URL. See `disabledMatch`.
   *
   * Returns false for an id this registry does not have.
   */
  public setEnabled(id: string, enabled: boolean): boolean {
    const integration = this.integrationsById.get(id);
    if (!integration) return false;
    this.state.setEnabled(id, enabled);
    integration.enabled = enabled;
    this.applyEnablement(integration);
    return true;
  }

  /** Register or unregister an integration's types to match its state. */
  private applyEnablement(integration: Integration) {
    for (const config of integration.workspaceTypes) {
      if (integration.enabled) {
        this.register(config);
      } else {
        this.unregister(config.type);
      }
    }
  }

  /** The integrations registered here, in registration order. */
  public integrations(): Integration[] {
    return [...this.integrationsById.values()];
  }

  /**
   * Whether any integration *declares* this type a supervisor, enabled or not.
   *
   * Deliberately different from {@link isSupervisorType}, which answers from
   * the registered types and therefore answers `false` for every type of a
   * switched-off integration. That is the right answer for routing — a
   * disabled type resolves nothing and staffs nothing — and the wrong one for
   * the agent-cost filter (KAN-276), where the question is what a `claude`
   * tree already running on this machine *is*.
   *
   * Those two come apart in one narrow case with a silent and expensive
   * failure: disable Atlassian while epic and story agents are still running,
   * and `isSupervisorType` stops recognising their trees, so they rejoin the
   * per-task-agent divisor and drag it back down — the exact contamination
   * KAN-276 removed, restored by a settings toggle, with nothing in any report
   * saying so. Supervisor-ness is a property of the workspace type, not of
   * whether its integration is switched on, so the cost filter asks this.
   */
  public declaresSupervisor(type: string | null | undefined): boolean {
    if (typeof type !== 'string') return false;
    for (const integration of this.integrationsById.values()) {
      for (const config of integration.workspaceTypes) {
        if (config.type === type) return config.supervisor === true;
      }
    }
    return false;
  }

  /**
   * The MCP servers every spawning agent gets from the integrations, keyed by
   * server name and in registration order.
   *
   * Not filtered by workspace type: an integration's servers attach to every
   * agent this daemon spawns, not only to agents of the types that integration
   * owns. The two readings coincide for Jira, which owns all three types, and
   * diverge only for a type-less integration — which could otherwise
   * contribute to nothing at all, and contributing tools to every agent is the
   * point of being able to add one.
   *
   * Gated on enabled, and on the credential where there is one: a disabled
   * integration contributes nothing at all, and an integration whose
   * credential is absent must not inject a server its agents cannot
   * authenticate. An integration with no credential adapter has nothing to be
   * unconfigured about and contributes whenever it is enabled.
   *
   * Core servers are not here — `butchr` is the daemon's own and is added by
   * the caller, so a name clash cannot let an integration displace it. See
   * coreMcpServerDefinitions in launchers.ts.
   */
  public mcpServerDefinitions(): McpServerDefinitions {
    const defs: McpServerDefinitions = {};
    for (const integration of this.integrationsById.values()) {
      if (!integration.enabled) continue;
      if (!integration.mcpServers) continue;
      if (integration.credential && !integration.credential.status().configured) continue;
      // Assign rather than accumulate: two integrations naming the same server
      // yield one entry, the later registration winning, so aggregation cannot
      // produce a duplicate key in the written config.
      Object.assign(defs, integration.mcpServers());
    }
    return defs;
  }

  /**
   * What a workspace type outranks. Unregistered types get the floor — see
   * DEFAULT_WORKSPACE_PRIORITY for why that is the safe direction — and this is
   * the only place that fallback is applied, so a caller cannot accidentally
   * pick a different one.
   */
  public priorityFor(type: string | null | undefined): number {
    if (typeof type !== 'string') return DEFAULT_WORKSPACE_PRIORITY;
    return this.types.get(type)?.priority ?? DEFAULT_WORKSPACE_PRIORITY;
  }

  public register(config: WorkspaceTypeConfig) {
    this.types.set(config.type, config);
    // The aggregate `isSupervisorType` answers from, maintained here so a type
    // and its supervisor-ness cannot be registered separately and disagree.
    if (config.supervisor) {
      SUPERVISOR_TYPES.add(config.type);
    } else {
      SUPERVISOR_TYPES.delete(config.type);
    }
  }

  /**
   * Drop a workspace type. A disabled integration's types stop resolving and
   * stop counting as supervisors; the configs themselves still exist on the
   * integration, which is what `disabledMatch` and `list_integrations` read.
   *
   * The supervisor aggregate is module-level while the types are per-registry,
   * so in a process holding several registries — proof scripts, not the daemon,
   * which has exactly one — the last registration or unregistration of a given
   * type wins. That is the cost of `isSupervisorType` being a free function,
   * and it is bounded by the fact that supervisor-ness is a property of the
   * type rather than of any registry.
   */
  private unregister(type: string) {
    this.types.delete(type);
    SUPERVISOR_TYPES.delete(type);
  }

  public get(type: string): WorkspaceTypeConfig | undefined {
    return this.types.get(type);
  }

  /**
   * The disabled integration whose patterns claim this URL, if any.
   *
   * Diagnosis only — never matching. `resolve()` sees enabled types and
   * nothing else, so a disabled integration cannot activate anything; but a
   * Jira URL failing as "unsupported URL" when the user has merely switched
   * Atlassian off is a lie, and this is what lets the refusal say the true
   * thing instead. The key is extracted too, so the message can name what it
   * would have opened.
   */
  public disabledMatch(
    url: string
  ): { integration: Integration; config: WorkspaceTypeConfig; key: string | null } | null {
    for (const integration of this.integrationsById.values()) {
      if (integration.enabled) continue;
      for (const config of integration.workspaceTypes) {
        for (const pattern of config.urlPatterns) {
          if (pattern.test(url)) {
            return { integration, config, key: config.keyExtractor(url) };
          }
        }
      }
    }
    return null;
  }

  /**
   * The disabled integration that owns this workspace type, if any. What
   * `activate_by_key` needs: an unregistered type is ordinarily allowed
   * through on the old convention, but a type that is unregistered *because
   * its integration is off* is a refusal with a reason.
   */
  public disabledIntegrationForType(type: string): Integration | null {
    for (const integration of this.integrationsById.values()) {
      if (integration.enabled) continue;
      if (integration.workspaceTypes.some((config) => config.type === type)) return integration;
    }
    return null;
  }

  /** Pure URL-pattern matching — the original, synchronous behaviour. */
  private match(url: string): { config: WorkspaceTypeConfig; key: string } | null {
    for (const config of this.types.values()) {
      for (const pattern of config.urlPatterns) {
        if (pattern.test(url)) {
          const key = config.keyExtractor(url);
          if (key) {
            return { config, key };
          }
        }
      }
    }
    return null;
  }

  /**
   * URL → workspace type and key.
   *
   * Asynchronous because a Jira issue URL alone cannot say whether the issue
   * is a Task or a Story; that needs a question asked of Jira. The network
   * call is confined to the one branch that needs it, is cached, is bounded by
   * a hard timeout, and answers null on any failure — so this resolves to
   * `task` and activation proceeds normally whenever Jira is unavailable.
   *
   * The question itself belongs to the integration that owns the type; this
   * method knows only that some types are matched provisionally, and what to
   * do when the refinement declines to answer.
   */
  public async resolve(
    url: string
  ): Promise<{ config: WorkspaceTypeConfig; key: string } | null> {
    const matched = this.match(url);
    if (!matched) return null;
    const refine = matched.config.refine;
    if (!refine) return matched;

    let refinedType: string | null;
    try {
      refinedType = await refine(matched.key);
    } catch {
      // The hook's contract is "never throw; null means unknown", but the
      // degradation guarantee must not depend on every integration honouring
      // it: a hook that throws is a refinement that could not be performed,
      // and lands on the same null as any other failure.
      refinedType = null;
    }
    // Null is "no better answer than the URL gave" — keep the URL match, which
    // is the type whose patterns claimed this URL in the first place. (Jira's
    // hook maps its own null to `task` before it ever gets here; see
    // DEFAULT_JIRA_WORKSPACE_TYPE, which is the same type by construction.)
    if (!refinedType || refinedType === matched.config.type) return matched;

    const refined = this.types.get(refinedType);
    // A refinement naming an unregistered type is a bug, but not one worth
    // failing an activation over — keep the URL-matched type.
    return refined ? { config: refined, key: matched.key } : matched;
  }
}
