import { WebSocketServer, WebSocket } from 'ws';
import * as path from 'path';
import { WorkspaceRegistry } from './registry.js';
import { PromptLoader } from './prompt.js';
import { HerdrBridge } from './herdr.js';

const PORT = 9182;
const repoRoot = path.resolve(process.cwd(), '..');

const registry = new WorkspaceRegistry();
const promptLoader = new PromptLoader(repoRoot);
const herdrBridge = new HerdrBridge();

const wss = new WebSocketServer({ port: PORT });

console.log(`[Butchr Daemon] Listening on ws://127.0.0.1:${PORT}`);

wss.on('connection', (ws: WebSocket) => {
  console.log('[Butchr Daemon] Client connected');

  ws.on('message', (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('[Butchr Daemon] Received message:', data);

      if (data.action === 'activate') {
        const resolved = registry.resolve(data.url);
        if (!resolved) {
          ws.send(JSON.stringify({
            success: false,
            error: 'Unsupported URL. No matching Workspace Type found.'
          }));
          return;
        }

        const { config, key } = resolved;

        const renderedPrompt = promptLoader.loadAndRender(config.promptTemplateFile, {
          KEY: key,
          URL: data.url
        });

        let session = herdrBridge.getSessionByKey(key);
        if (!session) {
          session = herdrBridge.spawnSession(config.type, key, data.url, renderedPrompt);
        }

        ws.send(JSON.stringify({
          success: true,
          type: config.type,
          key,
          sessionId: session.sessionId,
          status: session.status,
          mcpServers: config.mcpServers
        }));
      } else if (data.action === 'status') {
        const resolved = registry.resolve(data.url);
        if (resolved) {
          const session = herdrBridge.getSessionByKey(resolved.key);
          ws.send(JSON.stringify({
            action: 'status',
            success: true,
            supported: true,
            type: resolved.config.type,
            key: resolved.key,
            active: !!session,
            sessionId: session?.sessionId
          }));
        } else {
          ws.send(JSON.stringify({
            action: 'status',
            success: true,
            supported: false
          }));
        }
      }
    } catch (err: any) {
      console.error('[Butchr Daemon] Error processing message:', err);
      ws.send(JSON.stringify({
        success: false,
        error: err.message
      }));
    }
  });

  ws.on('close', () => {
    console.log('[Butchr Daemon] Client disconnected');
  });
});
