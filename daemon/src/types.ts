export interface WorkspaceTypeConfig {
  type: string;
  name: string;
  urlPatterns: RegExp[];
  keyExtractor: (url: string) => string | null;
  mcpServers: string[];
  promptTemplateFile: string;
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
