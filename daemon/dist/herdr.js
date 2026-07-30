export class HerdrBridge {
    sessions = new Map();
    spawnSession(type, key, url, promptContent) {
        const sessionId = `${type}-${key.toLowerCase()}-${Date.now()}`;
        console.log(`[HerdrBridge] Spawning agent session: ${sessionId}`);
        console.log(`[HerdrBridge] Key: ${key}, Type: ${type}, URL: ${url}`);
        const session = {
            sessionId,
            type,
            key,
            url,
            createdAt: new Date(),
            status: 'active'
        };
        this.sessions.set(sessionId, session);
        return session;
    }
    getSessionByKey(key) {
        for (const session of this.sessions.values()) {
            if (session.key === key && session.status === 'active') {
                return session;
            }
        }
        return undefined;
    }
    listActiveSessions() {
        return Array.from(this.sessions.values()).filter(s => s.status === 'active');
    }
}
