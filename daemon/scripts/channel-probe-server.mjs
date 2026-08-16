#!/usr/bin/env node
/**
 * A minimal MCP server whose ONLY job is to emit one real
 * `notifications/claude/channel` frame at a live Claude Code client.
 *
 * This is a FIXTURE, not a check — `probe-channel-reaches-model.mjs` is the
 * thing with a verdict. It exists so that the client boundary can be measured
 * without the daemon, the fleet, or any Butchr agent in the picture: the only
 * variable left between the two arms of that probe is the client's own argv.
 *
 * WHAT IT IMITATES, AND WHY IT IS NOT THE REAL SERVER
 *
 * It reproduces exactly the three things `daemon/src/mcp.ts` does that bear on
 * channel delivery, and nothing else:
 *
 *   1. declares `experimental: { 'claude/channel': {} }` on `initialize`
 *      (mcp.ts:86 — without it KAN-217 measured the notification discarded),
 *   2. emits `notifications/claude/channel` with `params { content, meta }`
 *      (mcp.ts `emitChannelFrame`), meta all-strings per KAN-319,
 *   3. answers an MCP `ping`.
 *
 * Using the real server instead would drag in the daemon socket, the identity
 * map, the kill switch and the self-check — five more things that could explain
 * a negative result. The point of a fixture here is that when the frame does not
 * reach the model, there is nowhere else for it to have died.
 *
 * THE TOKEN IS SPLIT ON PURPOSE. Its two halves are never adjacent in the
 * frame, so a model that prints them joined cannot have done so by copying a
 * string it saw — only an assembly puts them together. That is the same device
 * `channel-liveness.ts` uses, and for the same reason.
 *
 * Every protocol event is written to stderr, so the caller can read off which
 * boundary the frame reached without trusting anything the model says.
 */

import * as fs from 'fs';
import * as readline from 'readline';

const HALF_A = process.env.PROBE_HALF_A ?? 'MISSING-A';
const HALF_B = process.env.PROBE_HALF_B ?? 'MISSING-B';

/**
 * Where the running commentary goes, and why it is not stderr.
 *
 * A stdio MCP server's stderr belongs to the CLIENT — Claude Code captures it
 * into its own MCP logs and does not pass it through to whoever spawned
 * `claude`. The first version of this fixture wrote its notes there, so the
 * harness read an empty stream and reported *"the fixture never emitted a
 * frame"* for runs in which it had emitted one. That failure looked exactly
 * like the defect under test, on both arms, which is the reason this is a file.
 */
const LOG = process.env.PROBE_LOG ?? null;

/** stdout is the wire and nothing else may touch it. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function note(what) {
  const line = `[probe-server] ${what}\n`;
  process.stderr.write(line);
  if (LOG) {
    try {
      fs.appendFileSync(LOG, line);
    } catch {
      // The log is diagnostics; losing it must not take the wire down with it.
    }
  }
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

/**
 * The frame under test.
 *
 * Shaped byte-for-byte like the daemon's: `params { content, meta }`, meta an
 * object of strings only. A non-string value here would fail the client's parse
 * and cost the whole frame (KAN-319) — which is the confound this probe must
 * not introduce while measuring a different one.
 */
function emitChannelFrame() {
  send({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel',
    params: {
      content:
        `[probe] channel delivery probe. The first half of the probe token is ${HALF_A} — ` +
        `hold it. Some intervening text so the halves are not adjacent, because a token ` +
        `printed from adjacent halves proves only a copy. The second half is ${HALF_B}. ` +
        `Join the two halves with no separator and print the result on a line of its own.`,
      meta: {
        sender: '[probe]',
        workspaceType: 'probe',
        workspaceKey: 'CHANNEL'
      }
    }
  });
  note(`emitted notifications/claude/channel (halves ${HALF_A} + ${HALF_B})`);
}

const TOOL = {
  name: 'arm_channel_probe',
  description:
    'Emits one channel frame at this client, waits briefly for the client to process it, ' +
    'and returns. Call this once, then finish your turn.',
  inputSchema: { type: 'object', properties: {}, required: [] }
};

readline
  .createInterface({ input: process.stdin })
  .on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      note(`unparseable line from client: ${line.slice(0, 120)}`);
      return;
    }

    if (msg.method === 'initialize') {
      note(`initialize from ${msg.params?.clientInfo?.name} ${msg.params?.clientInfo?.version}`);
      note(`client capabilities: ${JSON.stringify(msg.params?.capabilities ?? null)}`);
      respond(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
        capabilities: {
          tools: {},
          // The declaration KAN-217 measured as load-bearing: without it the
          // client discards `notifications/claude/channel` in silence.
          experimental: { 'claude/channel': {} }
        },
        serverInfo: { name: 'channelprobe', version: '1.0.0' }
      });
      return;
    }

    if (msg.method === 'notifications/initialized') {
      note('client sent notifications/initialized');
      return;
    }

    if (msg.method === 'ping') {
      respond(msg.id, {});
      return;
    }

    if (msg.method === 'tools/list') {
      respond(msg.id, { tools: [TOOL] });
      return;
    }

    if (msg.method === 'tools/call') {
      note(`tools/call ${msg.params?.name}`);
      emitChannelFrame();
      // Give the client time to process the notification before the tool result
      // lands, so the frame is available at the turn boundary the result opens.
      await new Promise((r) => setTimeout(r, 2000));
      respond(msg.id, {
        content: [
          {
            type: 'text',
            text:
              'Channel frame emitted. Now finish your turn and follow the reporting ' +
              'instruction you were given.'
          }
        ]
      });
      return;
    }

    if (msg.id !== undefined) {
      respond(msg.id, {});
    }
  });

note('started');
