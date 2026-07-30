export class WorkspaceRegistry {
    types = new Map();
    constructor() {
        this.registerDefaults();
    }
    registerDefaults() {
        this.register({
            type: 'task',
            name: 'Jira Task',
            urlPatterns: [
                /https?:\/\/[^\/]+\/browse\/([A-Z0-9]+-\d+)/i,
                /https?:\/\/[^\/]+\/jira\/[^\/]+\/projects\/[^\/]+\/issues\/([A-Z0-9]+-\d+)/i
            ],
            keyExtractor: (url) => {
                const match = url.match(/\/browse\/([A-Z0-9]+-\d+)/i) ||
                    url.match(/\/issues\/([A-Z0-9]+-\d+)/i);
                return match ? match[1].toUpperCase() : null;
            },
            mcpServers: ['atlassian'],
            promptTemplateFile: 'prompts/task.md'
        });
    }
    register(config) {
        this.types.set(config.type, config);
    }
    resolve(url) {
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
