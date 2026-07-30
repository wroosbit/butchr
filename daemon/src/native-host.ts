import * as path from 'path';
import { WorkspaceRegistry } from './registry.js';
import { PromptLoader } from './prompt.js';
import { HerdrBridge } from './herdr.js';

// Redirect all standard console logging to stderr to protect stdout for binary framing
console.log = (...args: any[]) => process.stderr.write('[NativeHost LOG] ' + args.join(' ') + '\n');
console.error = (...args: any[]) => process.stderr.write('[NativeHost ERR] ' + args.join(' ') + '\n');

const repoRoot = path.resolve(process.cwd(), '..');
const registry = new WorkspaceRegistry();
const promptLoader = new PromptLoader(repoRoot);
const herdrBridge = new HerdrBridge();

console.log('Butchr Native Messaging Host initialized');

function sendNativeMessage(msg: any) {
  const jsonBuf = Buffer.from(JSON.stringify(msg), 'utf-8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(jsonBuf.length, 0);

  process.stdout.write(lenBuf);
  process.stdout.write(jsonBuf);
}

let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk: Buffer) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  while (inputBuffer.length >= 4) {
    const msgLen = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length < 4 + msgLen) {
      break; // Wait for full message
    }

    const jsonBuf = inputBuffer.subarray(4, 4 + msgLen);
    inputBuffer = inputBuffer.subarray(4 + msgLen);

    try {
      const data = JSON.parse(jsonBuf.toString('utf-8'));
      console.log('Received message:', data);
      handleMessage(data);
    } catch (err: any) {
      console.error('JSON parse error:', err);
      sendNativeMessage({ success: false, error: 'Invalid JSON payload' });
    }
  }
});

function handleMessage(data: any) {
  if (data.action === 'activate') {
    const resolved = registry.resolve(data.url);
    if (!resolved) {
      sendNativeMessage({
        action: 'activate_response',
        success: false,
        error: 'Unsupported URL. No matching Workspace Type found.'
      });
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

    sendNativeMessage({
      action: 'activate_response',
      success: true,
      type: config.type,
      key,
      url: data.url,
      sessionId: session.sessionId,
      status: session.status,
      mcpServers: config.mcpServers
    });
  } else if (data.action === 'status') {
    const resolved = registry.resolve(data.url);
    if (resolved) {
      const session = herdrBridge.getSessionByKey(resolved.key);
      sendNativeMessage({
        action: 'status_response',
        success: true,
        supported: true,
        type: resolved.config.type,
        key: resolved.key,
        active: !!session,
        sessionId: session?.sessionId
      });
    } else {
      sendNativeMessage({
        action: 'status_response',
        success: true,
        supported: false
      });
    }
  } else if (data.action === 'list_agents') {
    const activeSessions = herdrBridge.listActiveSessions();
    sendNativeMessage({
      action: 'list_agents_response',
      success: true,
      agents: activeSessions
    });
  }
}

process.stdin.on('end', () => {
  console.log('Stdin closed. Native host exiting.');
  process.exit(0);
});
