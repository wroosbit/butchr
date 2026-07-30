export interface WorkspaceTypeConfig {
  type: string;
  name: string;
  urlPatterns: RegExp[];
  keyExtractor: (url: string) => string | null;
  mcpServers: string[];
  promptTemplateFile: string;
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
