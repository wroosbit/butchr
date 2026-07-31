export interface WorkspaceTypeConfig {
  type: string;
  name: string;
  urlPatterns: RegExp[];
  keyExtractor: (url: string) => string | null;
  mcpServers: string[];
  promptTemplateFile: string;
  /**
   * Where this type's agent runs, overriding the per-key directory under the
   * workspaces root. A leading `~` expands to the user's home. Types that set
   * this put an agent outside the tree Butchr owns, so reset refuses to delete
   * it and agent provisioning that would touch the user's own configuration is
   * skipped.
   */
  workDir?: string;
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
