import { connectToDaemon, onJsonLines, writeJsonLine } from './ipc.js';
// Thin proxy between Chrome Native Messaging and the Butchr daemon.
// Chrome spawns one of these per browser profile; all of them relay to the
// single long-lived daemon over its Unix socket. No session state lives here.
// Redirect all standard console logging to stderr to protect stdout for binary framing
console.log = (...args) => process.stderr.write('[NativeHost LOG] ' + args.join(' ') + '\n');
console.error = (...args) => process.stderr.write('[NativeHost ERR] ' + args.join(' ') + '\n');
process.on('uncaughtException', (err) => {
    console.error(`Uncaught exception: ${err.stack}`);
    process.exit(1);
});
function sendNativeMessage(msg) {
    const jsonBuf = Buffer.from(JSON.stringify(msg), 'utf-8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(jsonBuf.length, 0);
    // stdout is already gone once Chrome tears the port down; a write here
    // would throw EPIPE and take the process out through uncaughtException.
    try {
        process.stdout.write(lenBuf);
        process.stdout.write(jsonBuf);
    }
    catch (err) {
        console.error('Failed to write to Chrome: ' + err.message);
    }
}
// --- Service worker keepalive --------------------------------------------
// Chrome stops an MV3 service worker after ~30s without activity, which
// closes the native port, kills this host, and drops the daemon connection
// along with its PTY output listeners. Traffic on the port counts as
// activity, so a periodic no-op message keeps the worker (and the terminal)
// alive. The extension ignores actions it doesn't recognise.
const HEARTBEAT_INTERVAL_MS = 20_000;
const heartbeat = setInterval(() => sendNativeMessage({ action: 'ping' }), HEARTBEAT_INTERVAL_MS);
// Never let the heartbeat alone hold the process open.
heartbeat.unref();
// --- Daemon link ---------------------------------------------------------
let daemonSocket = null;
let connecting = null;
const outbox = [];
function ensureDaemonLink() {
    if (daemonSocket)
        return Promise.resolve();
    if (!connecting) {
        connecting = connectToDaemon()
            .then((socket) => {
            connecting = null;
            daemonSocket = socket;
            console.log('Connected to butchr daemon');
            // Everything the daemon sends — responses and broadcast events —
            // is forwarded to Chrome verbatim.
            onJsonLines(socket, (msg) => sendNativeMessage(msg));
            socket.on('error', (err) => console.error('Daemon socket error: ' + err.message));
            socket.on('close', () => {
                console.error('Daemon connection lost');
                daemonSocket = null;
            });
            while (outbox.length && daemonSocket) {
                writeJsonLine(daemonSocket, outbox.shift());
            }
        })
            .catch((err) => {
            connecting = null;
            outbox.length = 0;
            console.error('Cannot reach butchr daemon: ' + err.message);
            sendNativeMessage({ action: 'daemon_error', success: false, error: 'Cannot reach butchr daemon' });
        });
    }
    return connecting;
}
function forwardToDaemon(msg) {
    if (daemonSocket) {
        writeJsonLine(daemonSocket, msg);
        return;
    }
    outbox.push(msg);
    void ensureDaemonLink();
}
// --- Chrome stdio framing (4-byte LE length prefix + JSON) ----------------
let inputBuffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
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
            console.log('Received message:', data.action);
            forwardToDaemon(data);
        }
        catch (err) {
            console.error('JSON parse error:', err);
            sendNativeMessage({ success: false, error: 'Invalid JSON payload' });
        }
    }
});
process.stdin.on('end', () => {
    console.log('Stdin closed. Native host exiting.');
    clearInterval(heartbeat);
    if (daemonSocket)
        daemonSocket.end();
    process.exit(0);
});
// Connect (and spawn the daemon if needed) as soon as Chrome starts us, so
// the first real message doesn't pay the startup latency.
void ensureDaemonLink();
