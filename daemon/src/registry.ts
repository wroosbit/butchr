import { WorkspaceTypeConfig } from './types.js';

export class WorkspaceRegistry {
  private types: Map<string, WorkspaceTypeConfig> = new Map();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults() {
    this.register({
      type: 'task',
      name: 'Jira Task',
      urlPatterns: [
        /https?:\/\/[^\/]+\/browse\/([A-Z0-9]+-\d+)/i,
        /https?:\/\/[^\/]+\/jira\/[^\/]+\/projects\/[^\/]+\/issues\/([A-Z0-9]+-\d+)/i,
        /[\?&]selectedIssue=([A-Z0-9]+-\d+)/i
      ],
      keyExtractor: (url: string) => {
        const match = url.match(/\/browse\/([A-Z0-9]+-\d+)/i) || 
                      url.match(/\/issues\/([A-Z0-9]+-\d+)/i) ||
                      url.match(/[\?&]selectedIssue=([A-Z0-9]+-\d+)/i);
        return match ? match[1].toUpperCase() : null;
      },
      mcpServers: ['atlassian', 'butchr'],
      promptTemplateFile: 'prompts/task.md'
    });

    // Registered after `task` on purpose: resolve() returns the first match,
    // and a board URL carrying &selectedIssue=KAN-5 is an opened issue — a
    // task context — not a board one. Task must get first refusal.
    //
    // There is a single board manager, so the key is the constant 'work'
    // rather than anything derived from the URL: every board page activates
    // the same agent.
    this.register({
      type: 'manage',
      name: 'Board Manager',
      urlPatterns: [
        /https?:\/\/[^\/]+\/jira\/software\/projects\/[^\/]+\/boards\/\d+/i
      ],
      keyExtractor: (url: string) =>
        /https?:\/\/[^\/]+\/jira\/software\/projects\/[^\/]+\/boards\/\d+/i.test(url)
          ? 'work'
          : null,
      mcpServers: ['atlassian', 'butchr'],
      promptTemplateFile: 'prompts/manage.md'
    });
  }

  public register(config: WorkspaceTypeConfig) {
    this.types.set(config.type, config);
  }

  public resolve(url: string): { config: WorkspaceTypeConfig; key: string } | null {
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
}
