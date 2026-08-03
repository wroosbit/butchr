/**
 * Second half of a two-step resolution: given the key a URL match extracted,
 * answer the workspace type the entity *really* is, or null if that cannot be
 * determined right now.
 *
 * Supplied by the integration that owns the type, because only it knows what
 * question to ask and of whom. Its contract is Jira's old one, generalized:
 * never throw, and answer within your own budget — but the registry's
 * degradation does not depend on either being honoured.
 */
export type RefineWorkspaceType = (key: string) => Promise<string | null>;

export interface WorkspaceTypeConfig {
  type: string;
  name: string;
  urlPatterns: RegExp[];
  keyExtractor: (url: string) => string | null;
  // No `mcpServers` here any more. A type used to name its servers as bare
  // strings resolved against a hardcoded table in launchers.ts; servers are now
  // declared by the integration that owns them and attach to every spawned
  // agent while that integration is configured, so a per-type list would select
  // nothing and would be a second, stale statement of the fact. See
  // integrations/integration.ts.
  promptTemplateFile: string;
  /**
   * What this type outranks when the machine is full. See priority.ts for the
   * scale and for why priority is a property of the type rather than of the
   * Jira ticket.
   *
   * Required rather than optional so a new workspace type cannot be registered
   * without someone deciding where it sits — a type that defaulted silently to
   * the floor would be preemptable by everything and nobody would find out
   * until its work was destroyed.
   */
  priority: number;
  /**
   * Whether this type hands work out rather than doing it: an epic agent
   * staffs its stories, a story agent staffs its tasks. A property of the type
   * because that is what it has always been — the registry aggregates the flags
   * across every registered type and `isSupervisorType` in registry.ts answers
   * from that aggregate, so the capacity model and the fleet UI still read one
   * fact from one place. See the header of capacity.ts for why supervisors are
   * exempt from the cap.
   */
  supervisor?: boolean;
  /**
   * When set, a URL match against this type is only provisional: the extracted
   * key goes to this hook and its answer decides the final workspace type. Set
   * on Jira's `task`, whose URLs are indistinguishable from a Story's or an
   * Epic's.
   */
  refine?: RefineWorkspaceType;
}

export interface ActivationPayload {
  action: 'activate' | 'deactivate' | 'status';
  url: string;
  tabId?: number;
}

export interface ActivationResponse {
  success: boolean;
  type?: string;
  key?: string;
  sessionId?: string;
  status?: string;
  error?: string;
}
