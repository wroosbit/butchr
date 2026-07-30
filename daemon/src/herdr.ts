import { ChildProcess } from 'child_process';

export interface HerdrSession {
  sessionId: string;
  type: string;
  key: string;
  url: string;
  process?: ChildProcess;
  createdAt: Date;
  status: 'initializing' | 'active' | 'terminated';
}

export class HerdrBridge {
  private sessions: Map<string, HerdrSession> = new Map();

  public spawnSession(type: string, key: string, url: string, promptContent: string): HerdrSession {
    const sessionId = `${type}-${key.toLowerCase()}-${Date.now()}`;
    
    console.log(`[HerdrBridge] Spawning agent session: ${sessionId}`);
    console.log(`[HerdrBridge] Key: ${key}, Type: ${type}, URL: ${url}`);
    
    const session: HerdrSession = {
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

  public getSessionByKey(key: string): HerdrSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.key === key && session.status === 'active') {
        return session;
      }
    }
    return undefined;
  }

  public listActiveSessions(): HerdrSession[] {
    return Array.from(this.sessions.values()).filter(s => s.status === 'active');
  }
}
