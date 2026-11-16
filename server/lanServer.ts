import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { decideBotDiscard, decideBotDraw } from '../src/game/bot.ts';
import {
  acceptPendingDrawnCard,
  createInitialPlayers,
  declareCeki,
  discardCard,
  discardPendingDrawnCard,
  drawFromStock,
  getNgejukTarget,
  getRecommendedDiscardId,
  ngejukDiscard,
  reorderHumanHand,
  sortHumanHand,
  startNewRound,
} from '../src/game/engine.ts';
import { findWinningMelds } from '../src/game/melds.ts';
import type { CardInstance, GameState, Player } from '../src/game/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '../dist');
const PORT = Number(process.env.PORT || 4173);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

interface LanClient {
  id: string;
  socket: Duplex;
  seatIndex: number;
  name: string;
  buffer: Buffer;
}

export interface LobbySeatInfo {
  seatIndex: number;
  name: string;
  isHuman: boolean;
  connected: boolean;
  score: number;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function getLocalWifiUrls(port: number): string[] {
  const nets = os.networkInterfaces();
  const urls: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        urls.push(`http://${net.address}:${port}/`);
      }
    }
  }
  return urls.length > 0 ? urls : [`http://127.0.0.1:${port}/`];
}

// --- Minimal RFC 6455 WebSocket Framing ---
function encodeWsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendWs(client: LanClient, data: unknown): void {
  if (client.socket.destroyed) return;
  try {
    client.socket.write(encodeWsTextFrame(JSON.stringify(data)));
  } catch {
    // Ignore broken pipe
  }
}

function parseWsFrames(client: LanClient, onMessage: (msg: string) => void, onClose: () => void): void {
  while (client.buffer.length >= 2) {
    const byte1 = client.buffer[0];
    const byte2 = client.buffer[1];
    const opcode = byte1 & 0x0f;
    const masked = (byte2 & 0x80) !== 0;
    let payloadLen = byte2 & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (client.buffer.length < 4) return;
      payloadLen = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (client.buffer.length < 10) return;
      payloadLen = Number(client.buffer.readBigUInt64BE(2));
      offset = 10;
    }

    const maskLen = masked ? 4 : 0;
    if (client.buffer.length < offset + maskLen + payloadLen) return;

    const maskKey = masked ? client.buffer.subarray(offset, offset + 4) : null;
    const payload = Buffer.from(
      client.buffer.subarray(offset + maskLen, offset + maskLen + payloadLen)
    );
    client.buffer = client.buffer.subarray(offset + maskLen + payloadLen);

    if (maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    if (opcode === 0x8) {
      onClose();
      return;
    }
    if (opcode === 0x9) {
      // Ping -> Pong
      const pongHeader = Buffer.from([0x8a, payload.length]);
      if (!client.socket.destroyed) client.socket.write(Buffer.concat([pongHeader, payload]));
      continue;
    }
    if (opcode === 0x1) {
      onMessage(payload.toString('utf8'));
    }
  }
}

// --- Authoritative LAN Room State ---
const defaultPlayers = createInitialPlayers().map((p, idx) => ({
  ...p,
  isHuman: false,
  difficulty: idx === 3 ? ('strategic' as const) : ('balanced' as const),
  name: idx === 0 ? 'Putu (Bot)' : p.name,
  avatarText: idx === 0 ? 'P' : p.avatarText,
}));

let roomState: GameState = startNewRound(undefined, 'nyari', defaultPlayers);
let roundActive = false;
let hostClientId: string | null = null;
let botTimer: NodeJS.Timeout | null = null;
let turnTimer: NodeJS.Timeout | null = null;
let turnDurationSec = 15;
let turnDeadlineAt: number | null = null;
const clients = new Map<string, LanClient>();

function buildLobbySeats(): LobbySeatInfo[] {
  return roomState.players.map((p, idx) => {
    const occupant = Array.from(clients.values()).find((c) => c.seatIndex === idx);
    return {
      seatIndex: idx,
      name: occupant ? occupant.name : p.name,
      isHuman: Boolean(occupant),
      connected: Boolean(occupant),
      score: p.score,
    };
  });
}

function sanitizeStateForSeat(state: GameState, viewerSeat: number): GameState {
  const hiddenCard = (idx: number, pIdx: number): CardInstance => ({
    id: `hidden_${pIdx}_${idx}`,
    key: 'tong1',
    suit: 'tong',
    rank: 1,
    familyId: 7,
  });

  return {
    ...state,
    stock: state.stock.map((_, i) => hiddenCard(i, 99)),
    pendingDrawnCard:
      state.currentPlayerIndex === viewerSeat ? state.pendingDrawnCard : null,
    players: state.players.map((p, idx) => {
      if (idx === viewerSeat || state.phase === 'round_over') {
        return p;
      }
      return {
        ...p,
        hand: p.hand.map((_, cIdx) => hiddenCard(cIdx, idx)),
      };
    }),
  };
}

function broadcastRoom(lastEvent?: { type: string; actorIndex: number }): void {
  const lobby = buildLobbySeats();
  const urls = getLocalWifiUrls(PORT);
  for (const client of clients.values()) {
    sendWs(client, {
      type: 'room_state',
      mySeat: client.seatIndex,
      isHost: client.id === hostClientId,
      roundActive,
      turnDurationSec,
      turnDeadlineAt,
      urls,
      lobby,
      lastEvent: lastEvent ?? null,
      state: sanitizeStateForSeat(roomState, client.seatIndex),
    });
  }
}

function resetHumanTurnTimer(): void {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
  turnDeadlineAt = null;
  if (!roundActive || roomState.phase === 'round_over' || turnDurationSec <= 0) return;
  const current = roomState.players[roomState.currentPlayerIndex];
  if (!current || !current.isHuman) return;

  turnDeadlineAt = Date.now() + turnDurationSec * 1000;
  const expectedPlayer = roomState.currentPlayerIndex;
  const expectedPhase = roomState.phase;
  const expectedPending = roomState.pendingDrawnCard?.id ?? null;

  turnTimer = setTimeout(() => {
    if (!roundActive || roomState.phase === 'round_over') return;
    if (roomState.currentPlayerIndex !== expectedPlayer || roomState.phase !== expectedPhase) return;
    if ((roomState.pendingDrawnCard?.id ?? null) !== expectedPending) return;

    let eventType = 'discard_hand';
    if (roomState.phase === 'awaiting_draw') {
      roomState = drawFromStock(roomState);
      eventType = 'draw_stock';
      if (roomState.phase === 'awaiting_discard' && roomState.pendingDrawnCard) {
        roomState = discardPendingDrawnCard(roomState);
        eventType = 'discard_pending';
      }
    } else if (roomState.phase === 'awaiting_discard') {
      if (roomState.pendingDrawnCard) {
        roomState = discardPendingDrawnCard(roomState);
        eventType = 'discard_pending';
      } else {
        const p = roomState.players[expectedPlayer];
        const recId = getRecommendedDiscardId(p.hand, roomState.playStyle) ?? p.hand[0]?.id;
        if (recId) {
          roomState = discardCard(roomState, recId, true);
          eventType = 'discard_hand';
        }
      }
    }
    resetHumanTurnTimer();
    broadcastRoom({ type: eventType, actorIndex: expectedPlayer });
    scheduleBotIfNeeded();
  }, turnDurationSec * 1000);
}

function scheduleBotIfNeeded(): void {
  if (botTimer) {
    clearTimeout(botTimer);
    botTimer = null;
  }
  if (!roundActive || roomState.phase === 'round_over') return;
  const current = roomState.players[roomState.currentPlayerIndex];
  if (!current || current.isHuman || roomState.phase !== 'bot_thinking') return;

  if (roomState.botStep === 'draw') {
    const drawDelay = 900 + Math.floor(Math.random() * 380);
    botTimer = setTimeout(() => {
      const bot = roomState.players[roomState.currentPlayerIndex];
      if (!bot || bot.isHuman || roomState.botStep !== 'draw') return;
      const target = getNgejukTarget(roomState);
      const choice = decideBotDraw(bot, target?.card, roomState.playStyle);
      const actionType = choice === 'ngejuk' && target ? 'ngejuk' : 'draw_stock';
      roomState = actionType === 'ngejuk' ? ngejukDiscard(roomState) : drawFromStock(roomState);
      broadcastRoom({ type: actionType, actorIndex: bot.id });
      scheduleBotIfNeeded();
    }, drawDelay);
  } else if (roomState.botStep === 'discard') {
    const discardDelay = 950 + Math.floor(Math.random() * 420);
    botTimer = setTimeout(() => {
      const bot = roomState.players[roomState.currentPlayerIndex];
      if (!bot || bot.isHuman || roomState.botStep !== 'discard') return;
      if (findWinningMelds(bot.hand, roomState.playStyle) !== null) {
        roomState = declareCeki(roomState, roomState.currentPlayerIndex);
        resetHumanTurnTimer();
        broadcastRoom({ type: 'declare_ceki', actorIndex: bot.id });
        return;
      }
      const card = decideBotDiscard(bot, roomState);
      roomState = discardCard(roomState, card.id);
      resetHumanTurnTimer();
      broadcastRoom({ type: 'discard_hand', actorIndex: bot.id });
      scheduleBotIfNeeded();
    }, discardDelay);
  }
}

function buildPlayersFromLobby(): Player[] {
  const base = createInitialPlayers();
  return base.map((p, idx) => {
    const occupant = Array.from(clients.values()).find((c) => c.seatIndex === idx);
    const existingScore = roomState.players[idx]?.score ?? 0;
    if (occupant) {
      return {
        ...p,
        name: occupant.name,
        avatarText: occupant.name.slice(0, 2).toUpperCase(),
        isHuman: true,
        score: existingScore,
      };
    }
    const botNames = ['Putu (Bot)', 'Made (Bot)', 'Nyoman (Bot)', 'Ketut (Bot)', 'Wayan (Bot)'];
    return {
      ...p,
      name: botNames[idx],
      avatarText: botNames[idx][0],
      isHuman: false,
      difficulty: idx === 3 ? 'strategic' : 'balanced',
      score: existingScore,
    };
  });
}

function makeUniqueName(desired: string, excludeSeat: number): string {
  const base = desired.trim().slice(0, 16) || `Pemain ${excludeSeat + 1}`;
  const taken = new Set<string>();
  roomState.players.forEach((p, idx) => {
    if (idx !== excludeSeat) taken.add(p.name.trim().toLowerCase());
  });
  if (!taken.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (suffix < 99) {
    const candidate = `${base.slice(0, 13)} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
    suffix++;
  }
  return `${base.slice(0, 12)} #${excludeSeat + 1}`;
}

function handleClientMessage(client: LanClient, raw: string): void {
  let msg: {
    type?: string;
    name?: string;
    cardId?: string;
    fromIndex?: number;
    toIndex?: number;
    turnSeconds?: number;
  };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.type === 'set_name' && typeof msg.name === 'string') {
    const clean = makeUniqueName(msg.name, client.seatIndex);
    client.name = clean;
    roomState = {
      ...roomState,
      players: roomState.players.map((p, idx) =>
        idx === client.seatIndex
          ? { ...p, name: clean, avatarText: clean.slice(0, 2).toUpperCase() }
          : p
      ),
    };
    broadcastRoom();
    return;
  }

  if (msg.type === 'start_round') {
    if (client.id !== hostClientId) return;
    if (botTimer) clearTimeout(botTimer);
    if (typeof msg.turnSeconds === 'number' && msg.turnSeconds >= 0) {
      turnDurationSec = msg.turnSeconds;
    }
    const players = buildPlayersFromLobby();
    roomState = startNewRound(roundActive ? roomState : undefined, 'nyari', players);
    roundActive = true;
    resetHumanTurnTimer();
    broadcastRoom({ type: 'start_round', actorIndex: client.seatIndex });
    scheduleBotIfNeeded();
    return;
  }

  if (!roundActive) return;

  if (msg.type === 'reorder_hand' && typeof msg.fromIndex === 'number' && typeof msg.toIndex === 'number') {
    roomState = reorderHumanHand(roomState, msg.fromIndex, msg.toIndex, client.seatIndex);
    broadcastRoom();
    return;
  }

  if (msg.type === 'sort_hand') {
    roomState = sortHumanHand(roomState, client.seatIndex);
    broadcastRoom();
    return;
  }

  // Turn-restricted actions
  if (roomState.currentPlayerIndex !== client.seatIndex) return;

  const prev = roomState;
  let eventType = '';
  switch (msg.type) {
    case 'draw_stock':
      roomState = drawFromStock(prev);
      eventType = 'draw_stock';
      break;
    case 'ngejuk':
      roomState = ngejukDiscard(prev);
      eventType = 'ngejuk';
      break;
    case 'accept_pending':
      roomState = acceptPendingDrawnCard(prev, false);
      eventType = 'accept_pending';
      break;
    case 'discard_pending':
      roomState = discardPendingDrawnCard(prev);
      eventType = 'discard_pending';
      break;
    case 'discard_hand':
      if (typeof msg.cardId === 'string') {
        roomState = discardCard(prev, msg.cardId, true);
        eventType = 'discard_hand';
      }
      break;
    case 'declare_ceki':
      roomState = declareCeki(prev, client.seatIndex);
      eventType = 'declare_ceki';
      break;
  }

  if (roomState !== prev) {
    resetHumanTurnTimer();
    broadcastRoom({ type: eventType, actorIndex: client.seatIndex });
    scheduleBotIfNeeded();
  }
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  if (urlPath === '/api/lan-info') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        urls: getLocalWifiUrls(PORT),
        connectedPlayers: clients.size,
      })
    );
    return;
  }

  const safeRel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(DIST_DIR, safeRel);
  if (!filePath.startsWith(DIST_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

server.on('upgrade', (req, socket) => {
  const reqUrl = (req.url || '').split('?')[0];
  if (reqUrl !== '/ws') {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return;
  }

  // Find first open seat 0..4
  const takenSeats = new Set(Array.from(clients.values()).map((c) => c.seatIndex));
  let openSeat = -1;
  for (let i = 0; i < 5; i++) {
    if (!takenSeats.has(i)) {
      openSeat = i;
      break;
    }
  }
  if (openSeat === -1) {
    socket.write('HTTP/1.1 503 Room Full\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n')
  );

  const clientId = crypto.randomUUID();
  const client: LanClient = {
    id: clientId,
    socket,
    seatIndex: openSeat,
    name: makeUniqueName(`Pemain ${openSeat + 1}`, openSeat),
    buffer: Buffer.alloc(0),
  };
  clients.set(clientId, client);
  if (!hostClientId) {
    hostClientId = clientId;
  }

  // Mark seat human in current lobby
  roomState = {
    ...roomState,
    players: roomState.players.map((p, idx) =>
      idx === openSeat
        ? { ...p, isHuman: true, name: client.name, avatarText: `P${openSeat + 1}` }
        : p
    ),
  };

  broadcastRoom();

  const disconnect = () => {
    if (!clients.has(clientId)) return;
    clients.delete(clientId);
    if (hostClientId === clientId) {
      hostClientId = clients.keys().next().value ?? null;
    }
    // Convert disconnected seat back to Bot so the game never stalls
    const botNames = ['Putu (Bot)', 'Made (Bot)', 'Nyoman (Bot)', 'Ketut (Bot)', 'Wayan (Bot)'];
    roomState = {
      ...roomState,
      players: roomState.players.map((p, idx) =>
        idx === client.seatIndex
          ? {
              ...p,
              isHuman: false,
              name: botNames[idx],
              avatarText: botNames[idx][0],
              difficulty: 'balanced',
            }
          : p
      ),
    };
    if (
      roundActive &&
      roomState.currentPlayerIndex === client.seatIndex &&
      roomState.phase !== 'round_over'
    ) {
      roomState = {
        ...roomState,
        phase: 'bot_thinking',
        botStep: roomState.pendingDrawnCard || roomState.players[client.seatIndex].hand.length === 12
          ? 'discard'
          : 'draw',
      };
      if (roomState.pendingDrawnCard) {
        roomState = acceptPendingDrawnCard(roomState, false);
      }
      scheduleBotIfNeeded();
    }
    broadcastRoom();
  };

  socket.on('data', (chunk: Buffer) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    parseWsFrames(
      client,
      (text) => handleClientMessage(client, text),
      disconnect
    );
  });

  socket.on('close', disconnect);
  socket.on('error', disconnect);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎴 Server LAN Ceki Bali aktif!');
  console.log('Bagikan salah satu alamat berikut ke teman di Wi-Fi yang sama:');
  for (const u of getLocalWifiUrls(PORT)) {
    console.log(`  ➜  ${u}`);
  }
  console.log('\nTekan Ctrl+C untuk menghentikan server.\n');
});
