import Peer, { type DataConnection } from 'peerjs';
import type { LobbySeatInfo, RoomStatePayload } from './lanClient.ts';
import type { LanHostController } from './lanHost.ts';

const PEER_ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(len = 5): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

export function extractRoomCode(input: string): string {
  const raw = input.trim();
  const match = raw.match(/[?&]room=([A-Za-z0-9_-]+)/i);
  const code = (match ? match[1] : raw).replace(/^ceki-bali-/i, '').toUpperCase();
  return code.replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

export class OnlineHostPeer {
  private peer: Peer | null = null;
  private conns = new Map<string, DataConnection>();
  public roomCode = '';
  public inviteUrl = '';
  public status: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';
  public errorMessage: string | null = null;

  private onStatusChange: (status: 'stopped' | 'starting' | 'running' | 'error', err?: string) => void;

  constructor(
    onStatusChange: (status: 'stopped' | 'starting' | 'running' | 'error', err?: string) => void
  ) {
    this.onStatusChange = onStatusChange;
  }

  start(hostName: string, hostController: LanHostController, retryCount = 0): void {
    this.stop(false);
    this.status = 'starting';
    this.errorMessage = null;
    this.roomCode = generateRoomCode(5);
    const peerId = `ceki-bali-${this.roomCode}`;
    this.onStatusChange('starting');

    const peer = new Peer(peerId, { config: PEER_ICE_CONFIG });
    this.peer = peer;

    peer.on('open', () => {
      if (this.peer !== peer) return;
      this.inviteUrl = `${window.location.origin}${window.location.pathname}?room=${this.roomCode}`;
      this.status = 'running';
      hostController.startOnline(hostName, this.inviteUrl, (clientId, payload) => {
        const conn = this.conns.get(clientId);
        if (conn && conn.open) {
          conn.send(payload);
        }
      });
      this.onStatusChange('running');
    });

    peer.on('connection', (conn) => {
      if (this.peer !== peer) return;
      const clientId = conn.peer;
      this.conns.set(clientId, conn);

      conn.on('open', () => {
        if (this.peer !== peer) return;
        hostController.handleExternalRelayMessage({
          type: 'guest_joined',
          clientId,
        });
      });

      conn.on('data', (data) => {
        if (this.peer !== peer) return;
        const pkt = data as {
          type?: string;
          seq?: number;
          ts?: number;
          name?: string;
          cardId?: string;
          fromIndex?: number;
          toIndex?: number;
        };
        if (pkt?.type === 'ping') {
          if (conn.open) {
            conn.send({ type: 'pong', seq: pkt.seq, ts: pkt.ts });
          }
          return;
        }
        hostController.handleExternalRelayMessage({
          type: 'guest_message',
          clientId,
          payload: pkt,
        });
      });

      conn.on('close', () => {
        this.conns.delete(clientId);
        if (this.peer !== peer) return;
        hostController.handleExternalRelayMessage({
          type: 'guest_left',
          clientId,
        });
      });

      conn.on('error', () => {
        this.conns.delete(clientId);
      });
    });

    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      if (err.type === 'unavailable-id' && retryCount < 3) {
        this.start(hostName, hostController, retryCount + 1);
        return;
      }
      this.status = 'error';
      this.errorMessage = `Gagal membuat Room Online (${err.type || err.message}).`;
      this.onStatusChange('error', this.errorMessage);
    });

    peer.on('disconnected', () => {
      if (this.peer === peer && !peer.destroyed) {
        peer.reconnect();
      }
    });
  }

  get connectedCount(): number {
    let n = 0;
    for (const c of this.conns.values()) {
      if (c.open) n++;
    }
    return n;
  }

  stop(notify = true): void {
    for (const conn of this.conns.values()) {
      try {
        conn.close();
      } catch {
        // ignore
      }
    }
    this.conns.clear();
    if (this.peer) {
      const old = this.peer;
      this.peer = null;
      try {
        old.destroy();
      } catch {
        // ignore
      }
    }
    this.status = 'stopped';
    this.roomCode = '';
    this.inviteUrl = '';
    if (notify) {
      this.onStatusChange('stopped');
    }
  }
}

export class OnlineGuestClient {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private onRoomState: (payload: RoomStatePayload) => void;
  private onStatusChange: () => void;

  public status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  public errorMessage: string | null = null;
  public roomCode = '';
  public lobby: LobbySeatInfo[] = [];
  public mySeat = 0;
  public isHost = false;
  public roundActive = false;
  public turnDurationSec = 15;
  public turnDeadlineAt: number | null = null;
  public pingMs: number | null = null;
  public packetLossPct = 0;

  private pingTimer: number | null = null;
  private pingSeq = 0;
  private pingHistory: Array<{ seq: number; sentAt: number; acked: boolean }> = [];
  private onPingUpdate?: () => void;

  constructor(
    onRoomState: (payload: RoomStatePayload) => void,
    onStatusChange: () => void,
    onPingUpdate?: () => void
  ) {
    this.onRoomState = onRoomState;
    this.onStatusChange = onStatusChange;
    this.onPingUpdate = onPingUpdate;
  }

  private startPingLoop(conn: DataConnection): void {
    this.stopPingLoop();
    this.pingHistory = [];
    this.pingMs = null;
    this.packetLossPct = 0;

    const sendPing = () => {
      if (this.conn !== conn || !conn.open) return;
      const now = Date.now();
      const finished = this.pingHistory.filter((p) => now - p.sentAt >= 1500);
      if (finished.length > 0) {
        const lost = finished.filter((p) => !p.acked).length;
        this.packetLossPct = Math.round((lost / finished.length) * 100);
        this.onPingUpdate?.();
      }
      const seq = ++this.pingSeq;
      this.pingHistory.push({ seq, sentAt: now, acked: false });
      if (this.pingHistory.length > 10) {
        this.pingHistory.shift();
      }
      conn.send({ type: 'ping', seq, ts: now });
    };

    sendPing();
    this.pingTimer = window.setInterval(sendPing, 2000);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.pingHistory = [];
    this.pingMs = null;
    this.packetLossPct = 0;
  }

  connect(roomInput: string, playerName: string): void {
    const code = extractRoomCode(roomInput);
    if (!code) {
      this.status = 'error';
      this.errorMessage = 'Masukkan Kode Room atau Link Undangan yang valid.';
      this.onStatusChange();
      return;
    }

    this.disconnect(false);
    this.roomCode = code;
    this.status = 'connecting';
    this.errorMessage = null;
    this.onStatusChange();

    const peer = new Peer({ config: PEER_ICE_CONFIG });
    this.peer = peer;
    let opened = false;

    peer.on('open', () => {
      if (this.peer !== peer) return;
      const conn = peer.connect(`ceki-bali-${code}`, {
        reliable: true,
        serialization: 'json',
      });
      this.conn = conn;

      const timeout = window.setTimeout(() => {
        if (!opened && this.conn === conn) {
          this.status = 'error';
          this.errorMessage = `Room "${code}" tidak ditemukan atau Host sedang offline.`;
          this.disconnect(false);
          this.status = 'error';
          this.onStatusChange();
        }
      }, 10000);

      conn.on('open', () => {
        if (this.conn !== conn) return;
        opened = true;
        window.clearTimeout(timeout);
        this.status = 'connected';
        this.errorMessage = null;
        conn.send({
          type: 'join',
          name: playerName.trim().slice(0, 16) || 'Pemain',
        });
        this.startPingLoop(conn);
        this.onStatusChange();
      });

      conn.on('data', (data) => {
        if (this.conn !== conn) return;
        const msg = data as RoomStatePayload | { type: 'pong'; seq?: number; ts?: number };
        if (msg && msg.type === 'pong') {
          const entry = this.pingHistory.find((p) => p.seq === msg.seq);
          if (entry) entry.acked = true;
          if (typeof msg.ts === 'number') {
            this.pingMs = Math.max(1, Date.now() - msg.ts);
          }
          const now = Date.now();
          const finished = this.pingHistory.filter((p) => p.acked || now - p.sentAt >= 1500);
          if (finished.length > 0) {
            const lost = finished.filter((p) => !p.acked).length;
            this.packetLossPct = Math.round((lost / finished.length) * 100);
          }
          this.onPingUpdate?.();
          return;
        }
        if (msg && msg.type === 'room_state') {
          this.lobby = msg.lobby;
          this.mySeat = msg.mySeat;
          this.isHost = msg.isHost;
          this.roundActive = msg.roundActive;
          this.turnDurationSec = msg.turnDurationSec ?? 15;
          this.turnDeadlineAt = msg.turnDeadlineAt ?? null;
          this.onRoomState(msg);
        }
      });

      conn.on('close', () => {
        window.clearTimeout(timeout);
        if (this.conn !== conn) return;
        this.conn = null;
        this.status = 'disconnected';
        this.errorMessage = 'Koneksi ke Host Room Online terputus.';
        this.onStatusChange();
      });

      conn.on('error', () => {
        window.clearTimeout(timeout);
        if (this.conn !== conn) return;
        this.status = 'error';
        this.errorMessage = `Gagal terhubung ke Room "${code}".`;
        this.onStatusChange();
      });
    });

    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      this.status = 'error';
      this.errorMessage =
        err.type === 'peer-unavailable'
          ? `Room "${code}" tidak ditemukan atau sudah ditutup.`
          : `Koneksi Room Online gagal (${err.type || err.message}).`;
      this.onStatusChange();
    });
  }

  send(msg: Record<string, unknown>): void {
    if (this.conn && this.conn.open) {
      this.conn.send(msg);
    }
  }

  disconnect(notify = true): void {
    this.stopPingLoop();
    if (this.conn) {
      const oldConn = this.conn;
      this.conn = null;
      try {
        oldConn.close();
      } catch {
        // ignore
      }
    }
    if (this.peer) {
      const oldPeer = this.peer;
      this.peer = null;
      try {
        oldPeer.destroy();
      } catch {
        // ignore
      }
    }
    this.status = 'disconnected';
    this.lobby = [];
    this.roundActive = false;
    this.turnDeadlineAt = null;
    if (notify) {
      this.onStatusChange();
    }
  }
}
