export interface GamepadCallbacks {
  onLeft: () => void;
  onRight: () => void;
  onConfirm: () => void; // A / Enter
  onSecondary: () => void; // X
  onSpecial: () => void; // Y
  onLB: () => void; // LB (Toggle Atur Posisi)
  onRB: () => void; // RB (Susun Otomatis)
  onBack: () => void; // Select / View (Toggle Riwayat)
  onStart: () => void; // Start / Menu (Panduan / Close Modal)
  onConnectionChange: (connected: boolean) => void;
}

/**
 * Lightweight Steam Deck / Xbox Gamepad + Keyboard input handler.
 * Polls via requestAnimationFrame only while a gamepad is connected.
 */
export class DeckInputController {
  private callbacks: GamepadCallbacks;
  private connected = false;
  private rafId: number | null = null;
  private prevButtons: boolean[] = [];
  private lastStickDir: -1 | 0 | 1 = 0;
  private lastStickMoveAt = 0;

  constructor(callbacks: GamepadCallbacks) {
    this.callbacks = callbacks;

    window.addEventListener('gamepadconnected', () => {
      this.connected = true;
      this.callbacks.onConnectionChange(true);
      this.startLoop();
    });

    window.addEventListener('gamepaddisconnected', () => {
      const anyConnected = this.hasAnyGamepad();
      this.connected = anyConnected;
      this.callbacks.onConnectionChange(anyConnected);
      if (!anyConnected) {
        this.stopLoop();
      }
    });

    window.addEventListener('keydown', (e) => this.handleKeyDown(e));

    if (this.hasAnyGamepad()) {
      this.connected = true;
      this.startLoop();
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private hasAnyGamepad(): boolean {
    if (typeof navigator.getGamepads !== 'function') return false;
    const pads = navigator.getGamepads();
    for (const p of pads) {
      if (p && p.connected) return true;
    }
    return false;
  }

  private startLoop(): void {
    if (this.rafId !== null) return;
    const tick = () => {
      this.pollGamepad();
      this.rafId = window.requestAnimationFrame(tick);
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private pollGamepad(): void {
    if (typeof navigator.getGamepads !== 'function') return;
    const pads = navigator.getGamepads();
    const pad = Array.from(pads).find((p) => p && p.connected);
    if (!pad) return;

    const pressed = pad.buttons.map((b) => b.pressed);
    const justPressed = (idx: number) => Boolean(pressed[idx] && !this.prevButtons[idx]);

    if (justPressed(14)) this.callbacks.onLeft(); // D-pad Left
    if (justPressed(15)) this.callbacks.onRight(); // D-pad Right
    if (justPressed(0)) this.callbacks.onConfirm(); // A
    if (justPressed(2)) this.callbacks.onSecondary(); // X
    if (justPressed(3)) this.callbacks.onSpecial(); // Y
    if (justPressed(4)) this.callbacks.onLB(); // LB
    if (justPressed(5)) this.callbacks.onRB(); // RB
    if (justPressed(8)) this.callbacks.onBack(); // Select / View
    if (justPressed(9)) this.callbacks.onStart(); // Start / Menu

    // Left analog stick horizontal navigation with repeat guard
    const axisX = pad.axes[0] ?? 0;
    const dir: -1 | 0 | 1 = axisX < -0.55 ? -1 : axisX > 0.55 ? 1 : 0;
    const now = performance.now();
    if (dir !== 0 && (dir !== this.lastStickDir || now - this.lastStickMoveAt > 190)) {
      if (dir === -1) this.callbacks.onLeft();
      else this.callbacks.onRight();
      this.lastStickMoveAt = now;
    }
    this.lastStickDir = dir;
    this.prevButtons = pressed;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        this.callbacks.onLeft();
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.callbacks.onRight();
        break;
      case 'Enter':
      case ' ':
        if (document.activeElement instanceof HTMLButtonElement) return;
        e.preventDefault();
        this.callbacks.onConfirm();
        break;
      case 'x':
      case 'X':
        this.callbacks.onSecondary();
        break;
      case 'y':
      case 'Y':
        this.callbacks.onSpecial();
        break;
      case 'Escape':
        this.callbacks.onStart();
        break;
    }
  }
}
