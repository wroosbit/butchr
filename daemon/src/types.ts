export interface WorkspaceTypeConfig {
  type: string;
  name: string;
  urlPatterns: RegExp[];
  keyExtractor: (url: string) => string | null;
  mcpServers: string[];
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
   * When set, a URL match against this type is only provisional: the extracted
   * key is looked up in Jira and the issue's own type decides the final
   * workspace type. Set on `task`, whose URLs are indistinguishable from a
   * Story's.
   */
  refineByJiraIssueType?: boolean;
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
