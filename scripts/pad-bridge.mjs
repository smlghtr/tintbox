#!/usr/bin/env node
/**
 * Zero-dependency, near-zero-latency binary WebSocket relay for Tintbox Pad (Android).
 * - Disables Nagle's algorithm (TCP_NODELAY) on every socket for sub-millisecond forwarding.
 * - Routes binary 12-byte pointer frames from `?role=pad` -> `?role=app` (Tintbox browser).
 * - Routes JSON canvas-sync frames from `?role=app` -> `?role=pad` (aspect ratio, tool, color).
 * - Works over USB (`adb reverse tcp:8765 tcp:8765`) AND Wi-Fi (`ws://<LAN-IP>:8765`).
 */
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';

const PORT = Number(process.env.PAD_PORT || 8765);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** @type {Set<import('node:net').Socket>} */
const appClients = new Set();
/** @type {Set<import('node:net').Socket>} */
const padClients = new Set();

function encodeWsFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendFrame(sock, opcode, payload) {
  if (!sock.writable || sock.destroyed) return;
  try {
    sock.write(encodeWsFrame(opcode, payload));
  } catch {
    // Ignore closed socket writes
  }
}

function broadcastPresence() {
  const msg = Buffer.from(
    JSON.stringify({ type: 'bridge', pads: padClients.size, apps: appClients.size }),
    'utf8',
  );
  for (const s of appClients) sendFrame(s, 0x1, msg);
  for (const s of padClients) sendFrame(s, 0x1, msg);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ app: 'tintbox-pad-bridge', port: PORT, pads: padClients.size, apps: appClients.size }));
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.setNoDelay(true);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const role = url.searchParams.get('role') === 'pad' ? 'pad' : 'app';
  const group = role === 'pad' ? padClients : appClients;
  const peers = role === 'pad' ? appClients : padClients;
  group.add(socket);
  console.log(`[pad-bridge] +${role} connected (pads=${padClients.size}, apps=${appClients.size})`);
  broadcastPresence();

  let buf = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf[0];
      const b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;

      let payload;
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        const raw = buf.subarray(off + 4, off + 4 + len);
        payload = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) payload[i] = raw[i] ^ mask[i & 3];
      } else {
        payload = buf.subarray(off, off + len);
      }
      buf = buf.subarray(off + maskLen + len);

      if (opcode === 0x8) {
        sendFrame(socket, 0x8, Buffer.alloc(0));
        socket.end();
        return;
      }
      if (opcode === 0x9) {
        sendFrame(socket, 0xa, payload);
        continue;
      }
      if (opcode === 0x2 || opcode === 0x1) {
        // Fast binary PING (msgType=7) echo back to sender if no peer app handles it, else relay to peers
        if (opcode === 0x2 && payload.length >= 12 && payload[0] === 7 && peers.size === 0) {
          const pong = Buffer.from(payload);
          pong[0] = 8;
          sendFrame(socket, 0x2, pong);
          continue;
        }
        const frame = encodeWsFrame(opcode, payload);
        for (const p of peers) {
          if (p.writable && !p.destroyed) {
            try {
              p.write(frame);
            } catch {
              // ignore
            }
          }
        }
      }
    }
  });

  const cleanup = () => {
    if (group.delete(socket)) {
      console.log(`[pad-bridge] -${role} disconnected (pads=${padClients.size}, apps=${appClients.size})`);
      broadcastPresence();
    }
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

function getLanIps() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    if (!ifaces) continue;
    for (const ni of ifaces) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  return ips;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nTintbox Pad Bridge listening on port ${PORT} (TCP_NODELAY enabled)`);
  console.log(`  Tintbox browser : ws://127.0.0.1:${PORT}/?role=app`);
  console.log(`  USB (Android)   : run "adb reverse tcp:${PORT} tcp:${PORT}" -> ws://127.0.0.1:${PORT}/?role=pad`);
  const ips = getLanIps();
  for (const ip of ips) {
    console.log(`  Wi-Fi (Android) : ws://${ip}:${PORT}/?role=pad`);
  }
  // Best-effort USB reverse setup if an Android device is already plugged in
  execFile('adb', ['reverse', `tcp:${PORT}`, `tcp:${PORT}`], (err) => {
    if (!err) console.log(`  [USB] adb reverse tcp:${PORT} tcp:${PORT} configured automatically.`);
  });
});
