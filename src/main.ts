import './style.css';
import { decideBotDiscard, decideBotDraw } from './game/bot.ts';
import { CARD_DEFS } from './game/deck.ts';
import {
  acceptPendingDrawnCard,
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
} from './game/engine.ts';
import {
  analyzeLeftoverHints,
  checkWinWithCard,
  detectContiguousMelds,
  findBestPartialMelds,
  findWinningMelds,
  getNyagaWaits,
  getReadyStatus,
} from './game/melds.ts';
import type { CardInstance, GameState, Meld, MeldType } from './game/types.ts';
import { sfx } from './ui/audio.ts';
import { renderCardBack, renderClassicCard } from './ui/cardRenderer.ts';
import { DeckInputController } from './ui/gamepad.ts';
import { LanClient, type RoomStatePayload } from './ui/lanClient.ts';
import { LanHostController } from './ui/lanHost.ts';
import { MatchAnimator } from './ui/matchAnimator.ts';
import { OnlineGuestClient, OnlineHostPeer, extractRoomCode } from './ui/onlinePeer.ts';
import { TutorialModal } from './ui/tutorial.ts';

type GameAction =
  | { type: 'draw_stock' }
  | { type: 'ngejuk' }
  | { type: 'accept_pending' }
  | { type: 'discard_pending' }
  | { type: 'discard_hand'; cardId: string }
  | { type: 'declare_ceki'; playerIndex?: number };

let state: GameState = startNewRound();
let showHints = true;
let settingsOpen = false;
let historyOpen = window.innerWidth >= 1024 && window.innerHeight >= 600;
let manualOrderMode = false;
let moveMode = false;
let selectedMoveCardId: string | null = null;
let draggedCardId: string | null = null;
let botTimer: number | null = null;
let cekiModalReady = true;
let knownMeldSignatures = new Set<string>();
let lanMode = false;
let lanModalOpen = false;
let onlineMode = false;
let onlineModalOpen = false;
let onlineTab: 'host' | 'join' = 'host';
let startupOpen = true;
let savedOnlineRoomCode = extractRoomCode(window.location.search);
let inspectDiscardPlayerIdx: number | null = null;
let lanTab: 'host' | 'join' = 'host';
let hostErrorMsg: string | null = null;
let hostSnapshot: RoomStatePayload | null = null;
let customTurnSeconds = Number(window.localStorage.getItem('ceki_bali_turn_sec') ?? '15');
if (Number.isNaN(customTurnSeconds) || customTurnSeconds < 0) customTurnSeconds = 15;
let activeTurnDeadlineAt: number | null = null;
let soloTurnTimer: number | null = null;
let savedPlayerName = window.localStorage.getItem('ceki_bali_lan_name') || 'Pemain';
let savedServerHost =
  window.localStorage.getItem('ceki_bali_lan_host') ||
  (window.location.protocol.startsWith('http') && window.location.host
    ? window.location.host
    : '127.0.0.1:4173');

function isHostingLan(): boolean {
  return lanHost.status === 'running';
}

function isHostingOnline(): boolean {
  return onlineHostPeer.status === 'running' && isHostingLan();
}

function isMultiplayer(): boolean {
  return lanMode || onlineMode;
}

function sendGuestMessage(msg: Record<string, unknown>): void {
  if (onlineMode) onlineGuest.send(msg);
  else lan.send(msg);
}

function isGuestConnected(): boolean {
  return onlineMode ? onlineGuest.status === 'connected' : lan.status === 'connected';
}

function isGuestRoundActive(): boolean {
  return onlineMode ? onlineGuest.roundActive : lan.roundActive;
}

function mySeatIndex(): number {
  if (isHostingLan()) return 0;
  if (onlineMode && onlineGuest.status === 'connected') return onlineGuest.mySeat;
  return lanMode && lan.status === 'connected' ? lan.mySeat : 0;
}

function getMeldSignature(meld: Meld): string {
  return `${meld.type}:${meld.cards.map((c) => c.id).sort().join(',')}`;
}

function seedKnownMelds(s: GameState, seatIdx = 0): void {
  knownMeldSignatures = new Set(
    findBestPartialMelds(s.players[seatIdx]?.hand ?? [], s.playStyle).melds.map(getMeldSignature)
  );
}
seedKnownMelds(state);

const app = document.getElementById('app')!;
const tutorial = new TutorialModal();
const animator = new MatchAnimator();

function applyRoomPayload(payload: RoomStatePayload): void {
  const prevRound = state.round;
  cancelAllPending();
  state = payload.state;
  cekiModalReady = true;
  activeTurnDeadlineAt = payload.turnDeadlineAt ?? null;

  if (payload.roundActive) {
    lanModalOpen = false;
    onlineModalOpen = false;
    startupOpen = false;
  }

  if (payload.lastEvent?.type === 'start_round' || payload.state.round !== prevRound) {
    manualOrderMode = false;
    selectedMoveCardId = null;
    seedKnownMelds(state, payload.mySeat);
  }

  switch (payload.lastEvent?.type) {
    case 'draw_stock':
      sfx.playDraw();
      break;
    case 'ngejuk':
      sfx.playNgejuk();
      break;
    case 'discard_hand':
    case 'discard_pending':
      sfx.playDiscard();
      break;
    case 'declare_ceki':
      sfx.playCekiWin();
      break;
  }

  render();
}

const lanHost = new LanHostController(
  (payload) => {
    hostSnapshot = payload;
    if (isHostingLan()) {
      if (onlineHostPeer.status === 'running') {
        onlineMode = true;
      } else {
        lanMode = true;
      }
      applyRoomPayload(payload);
    }
  },
  (status, err) => {
    hostErrorMsg = err ?? null;
    if (
      status === 'stopped' &&
      (lanMode || onlineMode) &&
      lan.status !== 'connected' &&
      lan.status !== 'connecting' &&
      onlineGuest.status !== 'connected' &&
      onlineGuest.status !== 'connecting'
    ) {
      lanMode = false;
      onlineMode = false;
      hostSnapshot = null;
      state = startNewRound(undefined, 'nyari');
      seedKnownMelds(state, 0);
      scheduleBotTurnIfNeeded();
    }
    render();
  }
);

window.addEventListener('ceki-host-ready', ((ev: CustomEvent) => {
  const detail = ev.detail as { ok?: boolean; port?: number; urls?: string[]; error?: string };
  if (detail?.ok && detail.port) {
    hostErrorMsg = null;
    lanMode = true;
    lanHost.start(detail.port, savedPlayerName, detail.urls ?? []);
  } else {
    hostErrorMsg = detail?.error || 'Gagal menjalankan server Host LAN.';
    render();
  }
}) as EventListener);

async function startHostingLan(name: string): Promise<void> {
  savedPlayerName = name.trim() || 'Host';
  window.localStorage.setItem('ceki_bali_lan_name', savedPlayerName);
  lan.disconnect();
  hostErrorMsg = null;
  lanMode = true;

  const wk = (window as unknown as {
    webkit?: { messageHandlers?: { cekiHost?: { postMessage: (v: unknown) => void } } };
  }).webkit;
  if (wk?.messageHandlers?.cekiHost) {
    wk.messageHandlers.cekiHost.postMessage({ action: 'start_host' });
    return;
  }

  // Windows native wrapper (/api/host-start) or browser fallback
  try {
    const res = await fetch('/api/host-start', { method: 'POST' });
    const data = (await res.json()) as { ok?: boolean; port?: number; urls?: string[]; error?: string };
    if (data.ok && data.port) {
      lanHost.start(data.port, savedPlayerName, data.urls ?? []);
      return;
    }
  } catch {
    // Not running inside Windows wrapper; try connecting to local `npm run lan` server if present
  }

  // Fallback for browser / Steam Deck: try connecting to current host or 127.0.0.1:4173
  const fallbackHost =
    window.location.protocol.startsWith('http') && window.location.host
      ? window.location.host
      : '127.0.0.1:4173';
  lan.connect(fallbackHost, savedPlayerName);
}

function stopLanAndReturnSolo(): void {
  lanMode = false;
  onlineMode = false;
  onlineHostPeer.stop();
  lanHost.stop();
  const wk = (window as unknown as {
    webkit?: { messageHandlers?: { cekiHost?: { postMessage: (v: unknown) => void } } };
  }).webkit;
  wk?.messageHandlers?.cekiHost?.postMessage({ action: 'stop_host' });
  fetch('/api/host-stop', { method: 'POST' }).catch(() => {});
  lan.disconnect();
  onlineGuest.disconnect();
  hostSnapshot = null;
  hostErrorMsg = null;
  lanModalOpen = false;
  onlineModalOpen = false;
  state = startNewRound(undefined, 'nyari');
  seedKnownMelds(state, 0);
  render();
  scheduleBotTurnIfNeeded();
}

const onlineHostPeer = new OnlineHostPeer((status, err) => {
  hostErrorMsg = err ?? null;
  if (status === 'running') {
    onlineMode = true;
    lanMode = false;
  } else if (status === 'stopped') {
    if (onlineMode && isHostingLan()) {
      lanHost.stop();
    }
    onlineMode = false;
  }
  render();
});

function updateNetStatsBadge(): void {
  const pill = document.getElementById('net-stats-pill');
  if (!pill) return;
  if (isHostingOnline()) {
    pill.textContent = `📡 Host • ${onlineHostPeer.connectedCount} Klien`;
    pill.className = 'net-stats-pill is-good';
    return;
  }
  if (onlineMode && onlineGuest.status === 'connected') {
    const ping = onlineGuest.pingMs;
    const loss = onlineGuest.packetLossPct;
    if (ping === null) {
      pill.textContent = '📶 Mengukur ping…';
      pill.className = 'net-stats-pill';
    } else {
      pill.textContent = `📶 ${ping}ms • Loss ${loss}%`;
      pill.className = `net-stats-pill ${
        loss > 0 || ping > 200 ? 'is-bad' : ping > 80 ? 'is-warn' : 'is-good'
      }`;
    }
    return;
  }
  if (lanMode) {
    pill.textContent = isHostingLan() ? '📡 Host LAN' : '📡 LAN';
    pill.className = 'net-stats-pill is-good';
  }
}

const onlineGuest = new OnlineGuestClient(
  (payload) => {
    if (isHostingLan()) return;
    onlineMode = true;
    lanMode = false;
    applyRoomPayload(payload);
  },
  () => {
    if (onlineGuest.status === 'disconnected' && onlineMode && !isHostingLan()) {
      onlineMode = false;
      state = startNewRound(undefined, 'nyari');
      seedKnownMelds(state, 0);
      scheduleBotTurnIfNeeded();
    }
    render();
  },
  updateNetStatsBadge
);

const lan = new LanClient(
  (payload) => {
    if (isHostingLan()) return;
    lanMode = true;
    applyRoomPayload(payload);
  },
  () => {
    if (lan.status === 'disconnected' && lanMode && !isHostingLan()) {
      lanMode = false;
      state = startNewRound(undefined, 'nyari');
      seedKnownMelds(state, 0);
      scheduleBotTurnIfNeeded();
    }
    render();
  }
);

let gamepadCursorIdx = 0;

function getRenderedHandCardIds(): string[] {
  return Array.from(document.querySelectorAll('.human-hand-row [data-card-id]'))
    .map((el) => (el as HTMLElement).dataset.cardId)
    .filter((id): id is string => Boolean(id));
}

const deckInput = new DeckInputController({
  onLeft: () => {
    const ids = getRenderedHandCardIds();
    if (ids.length === 0) return;
    gamepadCursorIdx = (gamepadCursorIdx - 1 + ids.length) % ids.length;
    render();
  },
  onRight: () => {
    const ids = getRenderedHandCardIds();
    if (ids.length === 0) return;
    gamepadCursorIdx = (gamepadCursorIdx + 1) % ids.length;
    render();
  },
  onConfirm: () => {
    if (animator.isAnimating) return;
    if (state.phase === 'round_over' && cekiModalReady) {
      startRoundWithDeal();
      return;
    }
    if (state.currentPlayerIndex !== mySeatIndex()) return;
    if (state.pendingDrawnCard) {
      handleAcceptPendingCard();
      return;
    }
    if (state.phase === 'awaiting_draw') {
      handleHumanDraw();
      return;
    }
    if (state.phase === 'awaiting_discard') {
      const ids = getRenderedHandCardIds();
      const targetId = ids[Math.min(gamepadCursorIdx, Math.max(0, ids.length - 1))];
      if (!targetId) return;
      if (moveMode) {
        if (!selectedMoveCardId) {
          selectedMoveCardId = targetId;
          render();
        } else if (selectedMoveCardId === targetId) {
          selectedMoveCardId = null;
          render();
        } else {
          const fromId = selectedMoveCardId;
          selectedMoveCardId = null;
          moveCardInHandById(fromId, targetId);
        }
      } else {
        handleHumanDiscard(targetId);
      }
    }
  },
  onSecondary: () => {
    if (animator.isAnimating || state.currentPlayerIndex !== mySeatIndex()) return;
    if (state.pendingDrawnCard) {
      handleDiscardPendingCard();
    } else if (state.phase === 'awaiting_draw' && getNgejukTarget(state)) {
      handleHumanNgejuk();
    }
  },
  onSpecial: () => {
    if (!animator.isAnimating) {
      handleHumanCeki();
    }
  },
  onLB: () => {
    if (animator.isAnimating) return;
    moveMode = !moveMode;
    selectedMoveCardId = null;
    render();
  },
  onRB: () => {
    if (animator.isAnimating) return;
    manualOrderMode = false;
    selectedMoveCardId = null;
    if (isMultiplayer()) {
      if (isHostingLan()) lanHost.handleLocalHostAction({ type: 'sort_hand' });
      else sendGuestMessage({ type: 'sort_hand' });
    } else {
      state = sortHumanHand(state);
      render();
    }
  },
  onBack: () => {
    historyOpen = !historyOpen;
    render();
  },
  onStart: () => {
    const modalClose = document.querySelector('.tutorial-modal .btn-icon-close') as HTMLButtonElement | null;
    if (modalClose) {
      modalClose.click();
    } else {
      tutorial.open(0);
    }
  },
  onConnectionChange: () => render(),
});

function cancelAllPending(): void {
  if (botTimer !== null) {
    window.clearTimeout(botTimer);
    botTimer = null;
  }
  animator.cancel();
}

function scheduleBotTurnIfNeeded(): void {
  if (botTimer !== null) {
    window.clearTimeout(botTimer);
    botTimer = null;
  }
  if (startupOpen || onlineModalOpen || lanModalOpen || isMultiplayer()) return;

  const current = state.players[state.currentPlayerIndex];
  if (state.phase === 'bot_thinking' && state.botStep === 'draw' && !current.isHuman) {
    const myEpoch = animator.currentEpoch;
    const delay = 850 + Math.floor(Math.random() * 350);
    botTimer = window.setTimeout(() => {
      if (myEpoch !== animator.currentEpoch) return;
      runBotDrawStep();
    }, delay);
  }
}

function runBotDrawStep(): void {
  const bot = state.players[state.currentPlayerIndex];
  if (!bot || bot.isHuman || state.phase !== 'bot_thinking' || state.botStep !== 'draw') return;

  const ngejukTarget = getNgejukTarget(state);
  const drawChoice = decideBotDraw(bot, ngejukTarget?.card, state.playStyle);

  if (drawChoice === 'ngejuk' && ngejukTarget) {
    dispatchAction({ type: 'ngejuk' });
  } else {
    dispatchAction({ type: 'draw_stock' });
  }
}

function scheduleBotDiscardStep(): void {
  if (botTimer !== null) {
    window.clearTimeout(botTimer);
    botTimer = null;
  }
  if (startupOpen || onlineModalOpen || lanModalOpen || isMultiplayer()) return;
  const bot = state.players[state.currentPlayerIndex];
  if (!bot || bot.isHuman || state.phase !== 'bot_thinking' || state.botStep !== 'discard') return;

  const myEpoch = animator.currentEpoch;
  if (state.lastDrawSource !== 'ngejuk' && findWinningMelds(bot.hand, state.playStyle) !== null) {
    botTimer = window.setTimeout(() => {
      if (myEpoch !== animator.currentEpoch) return;
      dispatchAction({ type: 'declare_ceki', playerIndex: state.currentPlayerIndex });
    }, 550);
    return;
  }

  const discardDelay = 900 + Math.floor(Math.random() * 400);
  botTimer = window.setTimeout(() => {
    if (myEpoch !== animator.currentEpoch) return;
    const activeBot = state.players[state.currentPlayerIndex];
    if (!activeBot || activeBot.isHuman || state.botStep !== 'discard') return;
    const cardToDiscard = decideBotDiscard(activeBot, state);
    dispatchAction({ type: 'discard_hand', cardId: cardToDiscard.id });
  }, discardDelay);
}

function applyGameAction(prev: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'draw_stock':
      return drawFromStock(prev);
    case 'ngejuk':
      return ngejukDiscard(prev);
    case 'accept_pending':
      return acceptPendingDrawnCard(prev, manualOrderMode);
    case 'discard_pending':
      return discardPendingDrawnCard(prev);
    case 'discard_hand':
      return discardCard(prev, action.cardId, manualOrderMode);
    case 'declare_ceki':
      return declareCeki(prev, action.playerIndex ?? prev.currentPlayerIndex);
  }
}

function dispatchAction(action: GameAction): void {
  if (animator.isAnimating) return;

  if (isMultiplayer()) {
    if (isHostingLan()) {
      const mapped =
        action.type === 'discard_hand'
          ? { type: 'discard_hand', cardId: action.cardId }
          : { type: action.type };
      lanHost.handleLocalHostAction(mapped);
      return;
    }
    if (!isGuestConnected() || !isGuestRoundActive()) return;
    switch (action.type) {
      case 'draw_stock':
        sendGuestMessage({ type: 'draw_stock' });
        break;
      case 'ngejuk':
        sendGuestMessage({ type: 'ngejuk' });
        break;
      case 'accept_pending':
        sendGuestMessage({ type: 'accept_pending' });
        break;
      case 'discard_pending':
        sendGuestMessage({ type: 'discard_pending' });
        break;
      case 'discard_hand':
        sendGuestMessage({ type: 'discard_hand', cardId: action.cardId });
        break;
      case 'declare_ceki':
        sendGuestMessage({ type: 'declare_ceki' });
        break;
    }
    return;
  }

  const prevState = state;
  const nextState = applyGameAction(prevState, action);
  if (nextState === prevState) return;

  const myEpoch = animator.currentEpoch;
  const actorIdx = prevState.currentPlayerIndex;
  const isHumanActor = prevState.players[actorIdx]?.isHuman ?? false;

  // Measure source rect BEFORE committing state & re-rendering
  let sourceRect: DOMRect | null = null;
  if (action.type === 'draw_stock') {
    sourceRect = document.querySelector('[data-anim-anchor="stock"]')?.getBoundingClientRect() ?? null;
  } else if (action.type === 'ngejuk') {
    const target = getNgejukTarget(prevState);
    if (target) {
      sourceRect =
        document
          .querySelector(`[data-discard-pile="${target.playerIndex}"] [data-card-id="${target.card.id}"]`)
          ?.getBoundingClientRect() ?? null;
    }
  } else if (action.type === 'accept_pending' || action.type === 'discard_pending') {
    sourceRect =
      document.querySelector('[data-anim-anchor="pending-card"]')?.getBoundingClientRect() ?? null;
  } else if (action.type === 'discard_hand') {
    sourceRect = isHumanActor
      ? document
          .querySelector(`.human-hand-row [data-card-id="${action.cardId}"]`)
          ?.getBoundingClientRect() ?? null
      : document
          .querySelector(`[data-anim-anchor="seat-${actorIdx}"]`)
          ?.getBoundingClientRect() ?? null;
  }

  state = nextState;

  if (action.type === 'declare_ceki') {
    cekiModalReady = false;
    render();
    animator.runCekiPause(() => {
      if (myEpoch !== animator.currentEpoch) return;
      cekiModalReady = true;
      sfx.playCekiWin();
      render();
    });
    return;
  }

  render();

  const finishTurnStep = (soundFn: () => void, afterRender?: () => void) => {
    if (myEpoch !== animator.currentEpoch) return;
    soundFn();
    resetSoloTurnTimer();
    render();
    afterRender?.();
  };

  // If stock ran out or Kupak Nyari win happened immediately
  if (nextState.phase === 'round_over') {
    if (nextState.winnerId !== null) {
      sfx.playCekiWin();
    }
    if (action.type === 'discard_pending' || action.type === 'discard_hand') {
      const discardedId =
        action.type === 'discard_pending'
          ? prevState.pendingDrawnCard?.id
          : action.cardId;
      const destEl = discardedId
        ? (document.querySelector(
            `[data-discard-pile="${actorIdx}"] [data-card-id="${discardedId}"]`
          ) as HTMLElement | null)
        : null;
      const discardedCard = nextState.players[actorIdx]?.discards.slice(-1)[0];
      animator.runFlight(
        {
          sourceRect,
          destEl,
          faceKey: discardedCard?.key,
          startWithBack: !isHumanActor,
          flipOnArrive: !isHumanActor,
          smallCard: true,
          flightMs: isHumanActor ? 220 : 200,
          flipMs: 100,
          highlightOnLand: true,
        },
        () => finishTurnStep(() => sfx.playDiscard())
      );
    }
    return;
  }

  if (action.type === 'draw_stock') {
    if (isHumanActor && nextState.pendingDrawnCard) {
      const destEl = document.querySelector(
        '[data-anim-anchor="pending-card"]'
      ) as HTMLElement | null;
      animator.runFlight(
        {
          sourceRect,
          destEl,
          faceKey: nextState.pendingDrawnCard.key,
          startWithBack: true,
          flipOnArrive: true,
          spinOnArrive: true,
          smallCard: false,
          flightMs: 240,
          flipMs: 140,
          highlightOnLand: true,
        },
        () => finishTurnStep(() => sfx.playDraw())
      );
      return;
    }

    if (!isHumanActor) {
      const destEl = document.querySelector(
        `[data-anim-anchor="seat-${actorIdx}"]`
      ) as HTMLElement | null;
      animator.runFlight(
        {
          sourceRect,
          destEl,
          startWithBack: true,
          flipOnArrive: false,
          smallCard: true,
          flightMs: 190,
          fadeIntoDest: true,
          hideDestDuringFlight: false,
        },
        () => finishTurnStep(() => sfx.playDraw(), scheduleBotDiscardStep)
      );
      return;
    }
  }

  if (action.type === 'ngejuk') {
    if (isHumanActor && nextState.pendingDrawnCard) {
      const destEl = document.querySelector(
        '[data-anim-anchor="pending-card"]'
      ) as HTMLElement | null;
      animator.runFlight(
        {
          sourceRect,
          destEl,
          faceKey: nextState.pendingDrawnCard.key,
          startWithBack: false,
          flipOnArrive: false,
          spinOnArrive: true,
          smallCard: false,
          flightMs: 240,
          highlightOnLand: true,
        },
        () => finishTurnStep(() => sfx.playNgejuk())
      );
      return;
    }

    if (!isHumanActor) {
      const takenCard = nextState.players[actorIdx]?.hand.slice(-1)[0];
      const destEl = document.querySelector(
        `[data-anim-anchor="seat-${actorIdx}"]`
      ) as HTMLElement | null;
      animator.runFlight(
        {
          sourceRect,
          destEl,
          faceKey: takenCard?.key,
          startWithBack: false,
          flipOnArrive: false,
          smallCard: true,
          flightMs: 210,
          fadeIntoDest: true,
          hideDestDuringFlight: false,
        },
        () => finishTurnStep(() => sfx.playNgejuk(), scheduleBotDiscardStep)
      );
      return;
    }
  }

  if (action.type === 'accept_pending') {
    const acceptedId = prevState.pendingDrawnCard?.id;
    const acceptedCard = acceptedId
      ? nextState.players[0].hand.find((c) => c.id === acceptedId)
      : undefined;
    const destEl = acceptedId
      ? (document.querySelector(`.human-hand-row [data-card-id="${acceptedId}"]`) as HTMLElement | null)
      : null;
    animator.runFlight(
      {
        sourceRect,
        destEl,
        faceKey: acceptedCard?.key,
        startWithBack: false,
        flipOnArrive: false,
        smallCard: false,
        flightMs: 170,
        highlightOnLand: true,
      },
      () => finishTurnStep(() => {})
    );
    return;
  }

  if (action.type === 'discard_pending' || action.type === 'discard_hand') {
    const discardedId =
      action.type === 'discard_pending'
        ? prevState.pendingDrawnCard?.id
        : action.cardId;
    const discardedCard = nextState.players[actorIdx]?.discards.slice(-1)[0];
    const destEl = discardedId
      ? (document.querySelector(
          `[data-discard-pile="${actorIdx}"] [data-card-id="${discardedId}"]`
        ) as HTMLElement | null)
      : null;

    animator.runFlight(
      {
        sourceRect,
        destEl,
        faceKey: discardedCard?.key,
        startWithBack: !isHumanActor,
        flipOnArrive: !isHumanActor,
        smallCard: true,
        flightMs: isHumanActor ? 220 : 200,
        flipMs: 100,
        highlightOnLand: true,
      },
      () => finishTurnStep(() => sfx.playDiscard(), scheduleBotTurnIfNeeded)
    );
  }
}

function handleHumanDraw(): void {
  if (state.phase !== 'awaiting_draw' || state.currentPlayerIndex !== mySeatIndex()) return;
  dispatchAction({ type: 'draw_stock' });
}

function handleHumanNgejuk(): void {
  if (state.phase !== 'awaiting_draw' || state.currentPlayerIndex !== mySeatIndex()) return;
  if (!getNgejukTarget(state)) return;
  dispatchAction({ type: 'ngejuk' });
}

function handleHumanDiscard(cardId: string): void {
  if (state.phase !== 'awaiting_discard' || state.currentPlayerIndex !== mySeatIndex()) return;
  dispatchAction({ type: 'discard_hand', cardId });
}

function moveCardInHandById(fromId: string, toId: string): void {
  if (animator.isAnimating || fromId === toId) return;
  const seatIdx = mySeatIndex();
  const hand = state.players[seatIdx].hand;
  const fromIdx = hand.findIndex((c) => c.id === fromId);
  const toIdx = hand.findIndex((c) => c.id === toId);
  if (fromIdx === -1 || toIdx === -1) return;
  manualOrderMode = true;
  if (isMultiplayer()) {
    if (isHostingLan()) {
      lanHost.handleLocalHostAction({ type: 'reorder_hand', fromIndex: fromIdx, toIndex: toIdx });
    } else {
      sendGuestMessage({ type: 'reorder_hand', fromIndex: fromIdx, toIndex: toIdx });
    }
  } else {
    state = reorderHumanHand(state, fromIdx, toIdx, seatIdx);
    render();
  }
}

function attachHandCardInteractions(cardEl: HTMLElement, cardId: string, canDiscard: boolean): void {
  const locked = animator.isAnimating;
  const isTouchDevice = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  // Drag-and-drop reordering enabled on desktop mouse; touch devices use 'Atur Posisi' tap-to-swap
  cardEl.draggable = !locked && !isTouchDevice;
  if (!isTouchDevice) {
    cardEl.addEventListener('dragstart', (e) => {
      if (animator.isAnimating) {
        e.preventDefault();
        return;
      }
      draggedCardId = cardId;
      cardEl.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', cardId);
      }
    });
    cardEl.addEventListener('dragend', () => {
      draggedCardId = null;
      cardEl.classList.remove('is-dragging');
    });
    cardEl.addEventListener('dragover', (e) => {
      if (animator.isAnimating || !draggedCardId || draggedCardId === cardId) return;
      e.preventDefault();
      cardEl.classList.add('is-drag-over');
    });
    cardEl.addEventListener('dragleave', () => {
      cardEl.classList.remove('is-drag-over');
    });
    cardEl.addEventListener('drop', (e) => {
      e.preventDefault();
      cardEl.classList.remove('is-drag-over');
      if (animator.isAnimating) return;
      const sourceId = draggedCardId || e.dataTransfer?.getData('text/plain');
      if (sourceId && sourceId !== cardId) {
        moveCardInHandById(sourceId, cardId);
      }
    });
  }

  // Click behavior: either Move Position (when moveMode is ON) or Discard (when canDiscard)
  if (moveMode) {
    cardEl.classList.add('is-clickable');
    if (selectedMoveCardId === cardId) {
      cardEl.classList.add('is-selected');
    }
    cardEl.addEventListener('click', () => {
      if (animator.isAnimating) return;
      if (!selectedMoveCardId) {
        selectedMoveCardId = cardId;
        render();
      } else if (selectedMoveCardId === cardId) {
        selectedMoveCardId = null;
        render();
      } else {
        const fromId = selectedMoveCardId;
        selectedMoveCardId = null;
        moveCardInHandById(fromId, cardId);
      }
    });
  } else if (canDiscard) {
    cardEl.addEventListener('click', () => handleHumanDiscard(cardId));
  }
}

function handleHumanCeki(): void {
  const seatIdx = mySeatIndex();
  if (state.phase !== 'awaiting_discard' || state.currentPlayerIndex !== seatIdx) return;
  if (state.lastDrawSource === 'ngejuk') return;
  const player = state.players[seatIdx];
  const canWin = state.pendingDrawnCard
    ? checkWinWithCard(player.hand, state.pendingDrawnCard, state.playStyle) !== null
    : findWinningMelds(player.hand, state.playStyle) !== null;
  if (!canWin) return;
  dispatchAction({ type: 'declare_ceki', playerIndex: seatIdx });
}

function handleAcceptPendingCard(): void {
  if (!state.pendingDrawnCard) return;
  dispatchAction({ type: 'accept_pending' });
}

function handleDiscardPendingCard(): void {
  if (!state.pendingDrawnCard) return;
  dispatchAction({ type: 'discard_pending' });
}

function clearSoloTurnTimer(): void {
  if (soloTurnTimer !== null) {
    window.clearTimeout(soloTurnTimer);
    soloTurnTimer = null;
  }
}

function resetSoloTurnTimer(): void {
  clearSoloTurnTimer();
  if (startupOpen || onlineModalOpen || lanModalOpen || isMultiplayer()) return;
  if (state.phase === 'round_over' || state.currentPlayerIndex !== 0 || customTurnSeconds <= 0) {
    activeTurnDeadlineAt = null;
    return;
  }
  activeTurnDeadlineAt = Date.now() + customTurnSeconds * 1000;
  const expectedPhase = state.phase;
  const expectedPending = state.pendingDrawnCard?.id ?? null;

  soloTurnTimer = window.setTimeout(() => {
    if (isMultiplayer() || state.phase === 'round_over' || state.currentPlayerIndex !== 0) return;
    if (state.phase !== expectedPhase || (state.pendingDrawnCard?.id ?? null) !== expectedPending) return;
    if (animator.isAnimating) return;

    if (state.phase === 'awaiting_draw') {
      dispatchAction({ type: 'draw_stock' });
      return;
    }
    if (state.phase === 'awaiting_discard') {
      if (state.pendingDrawnCard) {
        dispatchAction({ type: 'discard_pending' });
      } else {
        const hand = state.players[0].hand;
        const recId = getRecommendedDiscardId(hand, state.playStyle) ?? hand[0]?.id;
        if (recId) dispatchAction({ type: 'discard_hand', cardId: recId });
      }
    }
  }, customTurnSeconds * 1000);
}

function updateTurnTimerBadge(): void {
  const pill = document.querySelector('.turn-timer-pill') as HTMLElement | null;
  if (!pill || activeTurnDeadlineAt === null) return;
  const sec = Math.max(0, Math.ceil((activeTurnDeadlineAt - Date.now()) / 1000));
  pill.textContent = `⏱ ${sec}d`;
  pill.classList.toggle('is-urgent', sec <= 5);
}

window.setInterval(updateTurnTimerBadge, 1000);

function startRoundWithDeal(): void {
  if (isMultiplayer()) {
    if (isHostingLan()) {
      lanHost.startRound(customTurnSeconds);
    } else if (lan.isHost) {
      sendGuestMessage({ type: 'start_round', turnSeconds: customTurnSeconds });
    }
    return;
  }
  cancelAllPending();
  settingsOpen = false;
  manualOrderMode = false;
  selectedMoveCardId = null;
  cekiModalReady = true;
  state = startNewRound(state);
  seedKnownMelds(state, 0);
  resetSoloTurnTimer();
  render();

  const stockEl = document.querySelector('[data-anim-anchor="stock"]') as HTMLElement | null;
  const targets = [
    document.querySelector('[data-anim-anchor="seat-1"]') as HTMLElement | null,
    document.querySelector('[data-anim-anchor="seat-2"]') as HTMLElement | null,
    document.querySelector('[data-anim-anchor="seat-3"]') as HTMLElement | null,
    document.querySelector('[data-anim-anchor="seat-4"]') as HTMLElement | null,
    document.querySelector('.human-hand-row') as HTMLElement | null,
  ];
  animator.runRoundDeal(stockEl, targets);
  window.setTimeout(() => scheduleBotTurnIfNeeded(), 650);
}

function getDiscardCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of state.players) {
    for (const c of p.discards) {
      counts.set(c.key, (counts.get(c.key) ?? 0) + 1);
    }
  }
  return counts;
}

function renderPlayerRightDiscards(
  playerIdx: number,
  canDraw: boolean,
  ngejukRecommended: boolean,
  discardCounts: Map<string, number>,
  neededKeys: Set<string>,
  large = false
): HTMLElement {
  const player = state.players[playerIdx];
  const ngejukTarget = getNgejukTarget(state);
  const isNgejukSource = ngejukTarget?.playerIndex === playerIdx;

  const box = document.createElement('div');
  box.className = `player-discard-right ${large ? 'is-large' : ''} ${player.discards.length > 0 ? 'is-inspectable' : ''}`;
  box.dataset.discardPile = String(playerIdx);
  if (player.discards.length > 0) {
    box.title = `Klik untuk melihat semua ${player.discards.length} kartu buangan ${player.name}`;
    box.addEventListener('click', (e) => {
      const targetEl = e.target as HTMLElement | null;
      if (targetEl?.closest('.discard-top') && isNgejukSource && canDraw) {
        return; // Let Ngejuk click handler handle the top card when Ngejuk is active
      }
      inspectDiscardPlayerIdx = playerIdx;
      render();
    });
  }

  const recent = player.discards.slice(-3);
  if (recent.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'discard-empty-slot';
    empty.dataset.discardEmpty = String(playerIdx);
    empty.textContent = 'Buangan';
    box.appendChild(empty);
    return box;
  }

  recent.forEach((c, idx) => {
    const isTop = idx === recent.length - 1;
    const outCount = discardCounts.get(c.key) ?? 1;
    const isUsefulNgejuk = isTop && isNgejukSource && canDraw && ngejukRecommended;
    const isNeeded = neededKeys.has(c.key);

    let hintTone: 'ngejuk' | 'count' = 'count';
    let hoverExtra: string | undefined;

    if (showHints) {
      if (isUsefulNgejuk) {
        hintTone = 'ngejuk';
        hoverExtra = `Ngejuk! Lengkapi susunan (${outCount}/4 keluar)`;
      } else {
        hoverExtra = isNeeded
          ? `Keluar ${outCount}/4 • Cocok dengan pegangan Anda`
          : `Keluar ${outCount}/4 di meja`;
      }
    }

    const cardEl = renderClassicCard(c.key, {
      small: !large,
      clickable: isTop && isNgejukSource && canDraw && !animator.isAnimating,
      isHint: isUsefulNgejuk,
      hintTone,
      hoverExtra,
    });
    cardEl.dataset.cardId = c.id;
    if (isTop && isNgejukSource) {
      cardEl.classList.add('discard-top');
      if (canDraw && !animator.isAnimating) {
        cardEl.title = `Klik untuk Ngejuk ${CARD_DEFS[c.key].balineseName}`;
        cardEl.addEventListener('click', handleHumanNgejuk);
      }
    }
    box.appendChild(cardEl);
  });

  if (player.discards.length > 0) {
    const countPill = document.createElement('span');
    countPill.className = 'discard-count-pill';
    countPill.textContent = `${player.discards.length}`;
    box.appendChild(countPill);
  }

  return box;
}

function renderBotSeat(
  playerIdx: number,
  seatClass: string,
  canDraw: boolean,
  ngejukRecommended: boolean,
  discardCounts: Map<string, number>,
  neededKeys: Set<string>
): HTMLElement {
  const player = state.players[playerIdx];
  const isActive = state.currentPlayerIndex === playerIdx && state.phase !== 'round_over';

  const isNyari = player.readyMode === 'mecari' || player.readyMode === 'mejaga';
  const nyariPill =
    player.readyMode === 'mejaga'
      ? `<span class="player-nyari-pill is-mejaga" title="Sedang Mejaga (2+ Soca)">🔥 MEJAGA</span>`
      : player.readyMode === 'mecari'
        ? `<span class="player-nyari-pill is-mecari" title="Sedang Mecari (1 Soca)">🔍 MECARI</span>`
        : '';

  const seat = document.createElement('div');
  seat.className = `bot-seat ${seatClass} ${isActive ? 'is-active' : ''}`;
  seat.dataset.seatIndex = String(playerIdx);

  const badge = document.createElement('div');
  badge.className = `bot-badge ${isActive ? 'is-active' : ''} ${isNyari ? 'is-nyari' : ''}`;
  badge.dataset.animAnchor = `seat-${playerIdx}`;
  const activeLogo = isActive
    ? `<span class="active-turn-logo" title="Giliran ${player.name}">👑</span>`
    : '';
  const activePill = isActive
    ? `<span class="active-turn-pill">GILIRAN</span>`
    : '';
  badge.innerHTML = `
    ${activeLogo}
    <div class="bot-avatar">${player.avatarText}</div>
    <div class="bot-meta">
      <span class="bot-name">${player.name} (${player.score}) ${activePill} ${nyariPill}</span>
      <span class="bot-sub">${player.statusText} • ${player.hand.length} kartu</span>
    </div>
  `;

  // Only show bot badge + discarded cards to the RIGHT of the player (no opponent hand cards)
  const rightDiscards = renderPlayerRightDiscards(
    playerIdx,
    canDraw,
    ngejukRecommended,
    discardCounts,
    neededKeys
  );
  seat.append(badge, rightDiscards);

  return seat;
}

function clearPendingArrows(): void {
  document.getElementById('pending-arrow-overlay')?.remove();
}

function findPendingMeldMatches(
  pending: CardInstance,
  hand: CardInstance[]
): { kind: MeldType; complete: boolean; targetIds: string[] } | null {
  const sameKey = hand.filter((c) => c.key === pending.key);
  if (sameKey.length >= 2) {
    return { kind: 'soca', complete: true, targetIds: sameKey.slice(0, 2).map((c) => c.id) };
  }

  const sameFamily = hand.filter((c) => c.familyId === pending.familyId && c.key !== pending.key);
  const distinctByKey = new Map<string, CardInstance[]>();
  for (const c of sameFamily) {
    const arr = distinctByKey.get(c.key) ?? [];
    arr.push(c);
    distinctByKey.set(c.key, arr);
  }
  const distinctFamilyCards = [...distinctByKey.values()].map((arr) => arr[0]);
  if (distinctFamilyCards.length >= 2) {
    return {
      kind: 'serigat',
      complete: true,
      targetIds: distinctFamilyCards.slice(0, 2).map((c) => c.id),
    };
  }

  // Lawang complete: (pending + 1 same key + 1 same family) OR (pending + 2 same-key cards from same family)
  if (sameKey.length >= 1 && distinctFamilyCards.length >= 1) {
    return {
      kind: 'lawang',
      complete: true,
      targetIds: [sameKey[0].id, distinctFamilyCards[0].id],
    };
  }
  for (const arr of distinctByKey.values()) {
    if (arr.length >= 2) {
      return {
        kind: 'lawang',
        complete: true,
        targetIds: [arr[0].id, arr[1].id],
      };
    }
  }

  if (sameKey.length === 1) {
    return { kind: 'soca', complete: false, targetIds: [sameKey[0].id] };
  }
  if (distinctFamilyCards.length === 1) {
    return { kind: 'serigat', complete: false, targetIds: [distinctFamilyCards[0].id] };
  }
  return null;
}

function renderPendingMatchArrows(): void {
  clearPendingArrows();
  if (!state.pendingDrawnCard || animator.isAnimating) return;
  const match = findPendingMeldMatches(state.pendingDrawnCard, state.players[mySeatIndex()].hand);
  if (!match || match.targetIds.length === 0) return;

  const sourceEl = document.querySelector('[data-anim-anchor="pending-card"]') as HTMLElement | null;
  if (!sourceEl) return;
  const sRect = sourceEl.getBoundingClientRect();
  if (sRect.width === 0) return;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'pending-arrow-overlay';
  svg.setAttribute('class', 'pending-arrow-overlay');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);

  const color =
    match.kind === 'soca' ? '#fb923c' : match.kind === 'lawang' ? '#c084fc' : '#22d3ee';
  const glow =
    match.kind === 'soca'
      ? 'rgba(249,115,22,0.85)'
      : match.kind === 'lawang'
        ? 'rgba(192,132,252,0.85)'
        : 'rgba(34,211,238,0.85)';

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'ceki-arrow-head');
  marker.setAttribute('markerWidth', '9');
  marker.setAttribute('markerHeight', '9');
  marker.setAttribute('refX', '6');
  marker.setAttribute('refY', '4.5');
  marker.setAttribute('orient', 'auto');
  const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrowPath.setAttribute('d', 'M1,1 L7.5,4.5 L1,8 Z');
  arrowPath.setAttribute('fill', color);
  marker.appendChild(arrowPath);
  defs.appendChild(marker);
  svg.appendChild(defs);

  const sx = sRect.left + sRect.width / 2;
  const sy = sRect.bottom - 6;

  match.targetIds.forEach((id, idx) => {
    const destEl = document.querySelector(`.human-hand-row [data-card-id="${id}"]`) as HTMLElement | null;
    if (!destEl) return;
    destEl.classList.add(
      match.kind === 'soca'
        ? 'hint-arrow-target-soca'
        : match.kind === 'lawang'
          ? 'hint-arrow-target-lawang'
          : 'hint-arrow-target-serigat'
    );
    const dRect = destEl.getBoundingClientRect();
    if (dRect.width === 0) return;

    const dx = dRect.left + dRect.width / 2;
    const dy = dRect.top + 4;
    const curveOffset = (dx >= sx ? 1 : -1) * (24 + idx * 16);
    const cx = (sx + dx) / 2 + curveOffset;
    const cy = Math.min(sy, dy) + (dy - sy) * 0.45 - 18;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${sx} ${sy} Q ${cx} ${cy} ${dx} ${dy}`);
    path.setAttribute('class', 'pending-arrow-path');
    path.setAttribute('stroke', color);
    path.setAttribute('marker-end', 'url(#ceki-arrow-head)');
    path.style.filter = `drop-shadow(0 0 6px ${glow})`;
    svg.appendChild(path);
  });

  document.body.appendChild(svg);
}

window.addEventListener('resize', clearPendingArrows);

function render(): void {
  clearPendingArrows();
  const activeFocusId = (document.activeElement as HTMLElement | null)?.dataset?.focusId ?? null;
  const locked = animator.isAnimating;
  app.innerHTML = '';

  if (startupOpen && !onlineModalOpen && !lanModalOpen) {
    const startWrap = document.createElement('div');
    startWrap.className = 'startup-screen';

    const card = document.createElement('div');
    card.className = 'startup-card';

    card.innerHTML = `
      <div class="startup-emblem">🎴</div>
      <h1 class="startup-title">CEKI BALI</h1>
      <p class="startup-subtitle">Permainan Kartu Tradisional Bali • 5 Pemain (Soca • Serigat • Lawang)</p>
    `;

    const nameRow = document.createElement('div');
    nameRow.className = 'startup-name-row';
    const nameLbl = document.createElement('label');
    nameLbl.className = 'startup-name-label';
    nameLbl.textContent = 'Nama Pemain Anda';
    const nameInput = document.createElement('input');
    nameInput.className = 'lan-input';
    nameInput.maxLength = 16;
    nameInput.value = savedPlayerName;
    nameInput.placeholder = 'Masukkan nama Anda…';
    nameInput.addEventListener('input', () => {
      savedPlayerName = nameInput.value.trim() || 'Pemain';
      window.localStorage.setItem('ceki_bali_lan_name', savedPlayerName);
    });
    nameRow.append(nameLbl, nameInput);

    const modesGrid = document.createElement('div');
    modesGrid.className = 'startup-modes';

    const offlineBtn = document.createElement('button');
    offlineBtn.className = 'startup-mode-btn is-offline';
    offlineBtn.innerHTML = `
      <span class="startup-mode-icon">🤖</span>
      <span class="startup-mode-text">
        <strong>Play Offline</strong>
        <small>Solo melawan 4 Bot AI di meja kayu</small>
      </span>
    `;
    offlineBtn.addEventListener('click', () => {
      startupOpen = false;
      if (isMultiplayer()) {
        stopLanAndReturnSolo();
      } else {
        startRoundWithDeal();
      }
    });

    const onlineBtn = document.createElement('button');
    onlineBtn.className = 'startup-mode-btn is-online';
    onlineBtn.innerHTML = `
      <span class="startup-mode-icon">🌍</span>
      <span class="startup-mode-text">
        <strong>Play Online</strong>
        <small>Buat Room Online / Gabung Kode &amp; Link Undangan</small>
      </span>
    `;
    onlineBtn.addEventListener('click', () => {
      startupOpen = false;
      onlineTab = savedOnlineRoomCode ? 'join' : 'host';
      onlineModalOpen = true;
      render();
    });

    const lanBtnStart = document.createElement('button');
    lanBtnStart.className = 'startup-mode-btn is-lan';
    lanBtnStart.innerHTML = `
      <span class="startup-mode-icon">📡</span>
      <span class="startup-mode-text">
        <strong>Play LAN</strong>
        <small>Main bersama teman dalam 1 Wi-Fi lokal</small>
      </span>
    `;
    lanBtnStart.addEventListener('click', () => {
      startupOpen = false;
      lanModalOpen = true;
      render();
    });

    modesGrid.append(offlineBtn, onlineBtn, lanBtnStart);

    const guideBtn = document.createElement('button');
    guideBtn.className = 'btn btn-hud startup-guide-btn';
    guideBtn.textContent = '📖 Panduan & Aturan Main';
    guideBtn.addEventListener('click', () => tutorial.open(0));

    card.append(nameRow, modesGrid, guideBtn);
    startWrap.appendChild(card);
    app.appendChild(startWrap);
    return;
  }

  const mySeat = mySeatIndex();
  const human = state.players[mySeat];
  const isHumanTurn = state.currentPlayerIndex === mySeat;
  const hasPendingCard = isHumanTurn && state.pendingDrawnCard !== null;
  const canDraw = isHumanTurn && state.phase === 'awaiting_draw';
  const canDiscardFromHand = isHumanTurn && state.phase === 'awaiting_discard' && !hasPendingCard;
  const winCheck = state.pendingDrawnCard
    ? checkWinWithCard(human.hand, state.pendingDrawnCard, state.playStyle)
    : null;
  const canCeki =
    isHumanTurn &&
    state.phase === 'awaiting_discard' &&
    state.lastDrawSource !== 'ngejuk' &&
    (state.pendingDrawnCard ? winCheck !== null : findWinningMelds(human.hand, state.playStyle) !== null);
  const readyBeforeDraw =
    human.hand.length === 11 ? getReadyStatus(human.hand, state.playStyle) : { mode: null, waits: [] };
  const isNgandangReady = Boolean(
    hasPendingCard && state.lastDrawSource !== 'ngejuk' && winCheck !== null && readyBeforeDraw.mode !== null
  );
  const ngejukTarget = getNgejukTarget(state);

  const ngejukRecommended =
    showHints &&
    canDraw &&
    ngejukTarget !== undefined &&
    ngejukTarget !== null &&
    findBestPartialMelds([...human.hand, ngejukTarget.card], state.playStyle).melds.length >
      findBestPartialMelds(human.hand, state.playStyle).melds.length;

  const discardCounts = getDiscardCounts();
  const neededKeys = new Set<string>(getNyagaWaits(human.hand, state.playStyle));
  for (const c of human.hand) {
    neededKeys.add(c.key);
  }

  // 1. Organized HUD Bar (Left: Round + Scoreboard | Center: Gaya Bermain | Right: Menu Actions)
  const hud = document.createElement('header');
  hud.className = 'hud-bar';

  const hudLeft = document.createElement('div');
  hudLeft.className = 'hud-left';

  const activeLobby = isHostingLan()
    ? (hostSnapshot?.lobby ?? [])
    : onlineMode
      ? onlineGuest.lobby
      : lan.lobby;
  const roundPill = document.createElement('span');
  roundPill.className = 'round-pill';
  roundPill.textContent = onlineMode
    ? `Babak ${state.round} • ${isHostingOnline() ? `Online Host (${onlineHostPeer.roomCode})` : `Room ${onlineGuest.roomCode}`} (${activeLobby.filter((s) => s.connected).length}/5)`
    : lanMode
      ? `Babak ${state.round} • ${isHostingLan() ? 'Host LAN' : 'LAN Wi-Fi'} (${activeLobby.filter((s) => s.connected).length}/5)`
      : `Babak ${state.round} • Solo (Bot)`;

  hudLeft.append(roundPill);
  if (isMultiplayer()) {
    const netPill = document.createElement('span');
    netPill.id = 'net-stats-pill';
    netPill.className = 'net-stats-pill';
    hudLeft.append(netPill);
    updateNetStatsBadge();
  }

  const hudRight = document.createElement('div');
  hudRight.className = 'hud-right';

  const menuBtn = document.createElement('button');
  menuBtn.className = 'btn btn-hud';
  menuBtn.textContent = '🏠 Menu';
  menuBtn.title = 'Kembali ke Halaman Awal (Offline / Online / LAN)';
  menuBtn.addEventListener('click', () => {
    settingsOpen = false;
    startupOpen = true;
    render();
  });

  const onlineHudBtn = document.createElement('button');
  onlineHudBtn.className = `btn btn-hud ${onlineMode ? 'is-on' : ''}`;
  onlineHudBtn.textContent = onlineMode ? '🌍 Online: ON' : '🌍 Online';
  onlineHudBtn.title = 'Buat atau gabung Room Online';
  onlineHudBtn.addEventListener('click', () => {
    settingsOpen = false;
    onlineModalOpen = !onlineModalOpen;
    render();
  });

  const lanBtn = document.createElement('button');
  lanBtn.className = `btn btn-hud ${lanMode ? 'is-on' : ''}`;
  lanBtn.dataset.focusId = 'lan-btn';
  lanBtn.textContent = lanMode ? '📡 LAN: ON' : '📡 LAN';
  lanBtn.title = 'Main bersama teman di Wi-Fi yang sama (atau tetap Solo vs Bot)';
  lanBtn.addEventListener('click', () => {
    settingsOpen = false;
    lanModalOpen = !lanModalOpen;
    render();
  });

  const historyBtn = document.createElement('button');
  historyBtn.className = `btn btn-hud ${historyOpen ? 'is-on' : ''}`;
  historyBtn.dataset.focusId = 'history-btn';
  historyBtn.textContent = '📜 Riwayat';
  historyBtn.addEventListener('click', () => {
    settingsOpen = false;
    historyOpen = !historyOpen;
    render();
  });

  const canStartNewRound = !isMultiplayer() || isHostingLan() || lan.isHost || onlineGuest.isHost;
  const newRoundBtn = document.createElement('button');
  newRoundBtn.className = 'btn btn-hud';
  newRoundBtn.dataset.focusId = 'new-round-btn';
  newRoundBtn.textContent = '↻ Babak Baru';
  newRoundBtn.disabled = !canStartNewRound;
  if (!canStartNewRound) {
    newRoundBtn.title = 'Hanya Host yang bisa memulai babak baru LAN';
  }
  newRoundBtn.addEventListener('click', () => {
    startRoundWithDeal();
  });

  const helpBtn = document.createElement('button');
  helpBtn.className = 'btn btn-gold';
  helpBtn.dataset.focusId = 'help-btn';
  helpBtn.textContent = '? Panduan';
  helpBtn.addEventListener('click', () => {
    settingsOpen = false;
    tutorial.open(0);
  });

  // Settings dropdown
  const settingsWrap = document.createElement('div');
  settingsWrap.className = 'settings-wrap';

  const settingsBtn = document.createElement('button');
  settingsBtn.className = `btn btn-hud ${settingsOpen ? 'is-on' : ''}`;
  settingsBtn.dataset.focusId = 'settings-btn';
  settingsBtn.textContent = '⚙ Pengaturan ▾';
  settingsBtn.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    render();
  });
  settingsWrap.appendChild(settingsBtn);

  if (settingsOpen) {
    const menu = document.createElement('div');
    menu.className = 'settings-dropdown';

    const hintsBtn = document.createElement('button');
    hintsBtn.className = `btn-menu-item ${showHints ? 'is-on' : ''}`;
    hintsBtn.innerHTML = `<span>Saran / Hint</span><strong>${showHints ? 'ON' : 'OFF'}</strong>`;
    hintsBtn.addEventListener('click', () => {
      showHints = !showHints;
      render();
    });

    const soundBtn = document.createElement('button');
    soundBtn.className = `btn-menu-item ${!sfx.muted ? 'is-on' : ''}`;
    soundBtn.innerHTML = `<span>Efek Suara Bali</span><strong>${sfx.muted ? 'OFF' : 'ON'}</strong>`;
    soundBtn.addEventListener('click', () => {
      sfx.muted = !sfx.muted;
      render();
    });

    menu.append(hintsBtn, soundBtn);
    settingsWrap.appendChild(menu);
  }

  hudRight.append(menuBtn, onlineHudBtn, lanBtn, historyBtn, newRoundBtn, settingsWrap, helpBtn);
  hud.append(hudLeft, hudRight);
  app.appendChild(hud);

  // 2. Main Workspace: Perspective Circular Table (Left/Center) + Dedicated History Window (Right)
  const workspace = document.createElement('div');
  workspace.className = 'main-workspace';

  const tableWrapper = document.createElement('main');
  tableWrapper.className = 'table-wrapper';

  // Dota Underlords-style Top-Left Vertical Scoreboard Panel
  const scorePanel = document.createElement('aside');
  scorePanel.className = 'underlords-scoreboard';
  scorePanel.setAttribute('aria-label', 'Skor Pemain');
  const scoreHeader = document.createElement('div');
  scoreHeader.className = 'underlords-score-header';
  scoreHeader.textContent = 'SKOR MEJA';
  scorePanel.appendChild(scoreHeader);

  state.players.forEach((p, idx) => {
    const isMe = idx === mySeat;
    const isTurn = state.currentPlayerIndex === idx && state.phase !== 'round_over';
    const row = document.createElement('div');
    row.className = `underlords-score-row ${isMe ? 'is-human' : ''} ${isTurn ? 'is-turn' : ''}`;
    const nyariTag =
      p.readyMode === 'mejaga'
        ? ' <span class="ul-nyari is-mejaga" title="Mejaga">🔥</span>'
        : p.readyMode === 'mecari'
          ? ' <span class="ul-nyari is-mecari" title="Mecari">🔍</span>'
          : '';
    row.innerHTML = `
      <span class="ul-dot">${isMe ? '★' : p.avatarText}</span>
      <span class="ul-name">${p.name}${nyariTag}</span>
      <strong class="ul-val">${p.score}</strong>
    `;
    scorePanel.appendChild(row);
  });
  tableWrapper.appendChild(scorePanel);

  const table = document.createElement('div');
  table.className = `table-surface ${state.pendingDrawnCard ? 'has-pending' : ''}`;

  // Clockwise 5-seat arrangement rotated relative to mySeat
  table.appendChild(renderBotSeat((mySeat + 1) % 5, 'seat-left', canDraw, ngejukRecommended, discardCounts, neededKeys));
  table.appendChild(renderBotSeat((mySeat + 2) % 5, 'seat-top-left', canDraw, ngejukRecommended, discardCounts, neededKeys));
  table.appendChild(renderBotSeat((mySeat + 3) % 5, 'seat-top-right', canDraw, ngejukRecommended, discardCounts, neededKeys));
  table.appendChild(renderBotSeat((mySeat + 4) % 5, 'seat-right', canDraw, ngejukRecommended, discardCounts, neededKeys));

  // Center Arena (Tumpukan Stock Pile)
  const center = document.createElement('div');
  center.className = 'center-arena';

  const stockBox = document.createElement('div');
  stockBox.className = 'pile-box';
  const stockStack = document.createElement('div');
  stockStack.className = `stock-stack ${canDraw && !locked ? 'is-clickable' : ''}`;
  stockStack.dataset.animAnchor = 'stock';
  stockStack.title = canDraw ? 'Klik untuk mengambil kartu dari Tumpukan' : 'Tumpukan Kartu';
  const stackLayer2 = document.createElement('div');
  stackLayer2.className = 'stock-layer-2';
  const stackLayer1 = document.createElement('div');
  stackLayer1.className = 'stock-layer-1';
  stockStack.append(stackLayer2, stackLayer1, renderCardBack('vertical', false));
  const countBadge = document.createElement('span');
  countBadge.className = 'stock-count-badge';
  countBadge.textContent = String(state.stock.length);
  stockStack.appendChild(countBadge);
  if (canDraw && !locked) {
    stockStack.addEventListener('click', handleHumanDraw);
  }
  const stockLabel = document.createElement('span');
  stockLabel.className = 'pile-label';
  stockLabel.textContent = 'Tumpukan';
  stockBox.append(stockStack, stockLabel);
  center.appendChild(stockBox);
  table.appendChild(center);

  // Bottom Human Seat (Hand + Right-Side Discard Pile + Action Dock)
  const bottom = document.createElement('div');
  bottom.className = `seat-bottom ${isHumanTurn && state.phase !== 'round_over' ? 'is-your-turn' : ''}`;

  const statusBanners = document.createElement('div');
  statusBanners.className = 'bottom-banners';

  const turnPrompt = document.createElement('div');
  const activePlayer = state.players[state.currentPlayerIndex];
  turnPrompt.className = `turn-prompt ${
    isHumanTurn && state.phase !== 'round_over'
      ? 'is-yours'
      : state.phase !== 'round_over'
        ? 'is-opponent'
        : ''
  }`;
  turnPrompt.setAttribute('aria-live', 'polite');
  const crownPrefix = isHumanTurn && state.phase !== 'round_over' ? '👑 ' : '';
  if (canDraw) {
    turnPrompt.textContent = ngejukTarget
      ? `${crownPrefix}GILIRAN ANDA: Ambil dari Tumpukan atau Ngejuk ${CARD_DEFS[ngejukTarget.card.key].balineseName}`
      : `${crownPrefix}GILIRAN ANDA: Ambil kartu dari Tumpukan`;
  } else if (hasPendingCard) {
    turnPrompt.textContent = canCeki
      ? '👑 CEKI SIAP! Tekan tombol emas Ceki! untuk menang!'
      : `${crownPrefix}GILIRAN ANDA: Pilih Ambil atau Buang kartu baru di atas tangan.`;
  } else if (canDiscardFromHand) {
    turnPrompt.textContent = canCeki
      ? '👑 CEKI SIAP! Tekan tombol emas Ceki! untuk menang!'
      : `${crownPrefix}GILIRAN ANDA: Pilih 1 kartu di tangan untuk dibuang.`;
  } else if (state.phase !== 'round_over') {
    const roleLabel = activePlayer.isHuman ? 'PEMAIN' : 'MUSUH';
    turnPrompt.textContent = `⏳ GILIRAN ${roleLabel}: ${activePlayer.name} sedang bermain…`;
  } else {
    turnPrompt.textContent = 'Babak Selesai';
  }
  if (!hasPendingCard || canCeki) {
    statusBanners.appendChild(turnPrompt);
  }
  if (!isMultiplayer() && !startupOpen && !onlineModalOpen && !lanModalOpen) {
    if (isHumanTurn && state.phase !== 'round_over' && customTurnSeconds > 0 && soloTurnTimer === null) {
      resetSoloTurnTimer();
    } else if (!isHumanTurn || state.phase === 'round_over') {
      clearSoloTurnTimer();
      activeTurnDeadlineAt = null;
    }
  }
  if (activeTurnDeadlineAt !== null && state.phase !== 'round_over') {
    const timerPill = document.createElement('span');
    timerPill.className = 'turn-timer-pill';
    const sec = Math.max(0, Math.ceil((activeTurnDeadlineAt - Date.now()) / 1000));
    timerPill.textContent = `⏱ ${sec}d`;
    if (sec <= 5) timerPill.classList.add('is-urgent');
    statusBanners.appendChild(timerPill);
  }

  if (human.hand.length === 11) {
    const ready = readyBeforeDraw;
    if (ready.mode !== null && ready.waits.length > 0) {
      const nyaga = document.createElement('div');
      nyaga.className = `nyaga-banner ${ready.mode === 'mejaga' ? 'is-mejaga' : 'is-mecari'}`;
      const waitNames = ready.waits
        .map((w) => `${CARD_DEFS[w].balineseName} (${CARD_DEFS[w].shortCode})`)
        .join(', ');
      nyaga.textContent =
        ready.mode === 'mejaga'
          ? `MEJAGA! (2+ Soca — Sekeluarga): ${waitNames}`
          : `MECARI! (1 Soca — Kartu Sama): ${waitNames}`;
      statusBanners.appendChild(nyaga);
    }
  }
  if (isNgandangReady) {
    const ngandangBanner = document.createElement('div');
    ngandangBanner.className = 'ngandang-glow-banner';
    ngandangBanner.textContent = '🔥 NGANDANG! Ngupak Kartu Kemenangan Sendiri — Tekan Ceki!';
    statusBanners.appendChild(ngandangBanner);
  }
  const handControls = document.createElement('div');
  handControls.className = 'hand-controls';

  const moveToggleBtn = document.createElement('button');
  moveToggleBtn.className = `btn btn-hud btn-compact-ctrl ${moveMode ? 'is-on' : ''}`;
  moveToggleBtn.dataset.focusId = 'move-toggle-btn';
  moveToggleBtn.disabled = locked;
  moveToggleBtn.textContent = moveMode ? 'Posisi: ON' : 'Atur Posisi';
  moveToggleBtn.title = 'Aktifkan untuk memindahkan posisi kartu dengan klik, atau langsung seret (drag & drop) kapan saja';
  moveToggleBtn.addEventListener('click', () => {
    if (animator.isAnimating) return;
    moveMode = !moveMode;
    selectedMoveCardId = null;
    render();
  });

  const autoSortBtn = document.createElement('button');
  autoSortBtn.className = 'btn btn-hud btn-compact-ctrl';
  autoSortBtn.dataset.focusId = 'auto-sort-btn';
  autoSortBtn.disabled = locked;
  autoSortBtn.textContent = '↻ Susun';
  autoSortBtn.title = 'Kelompokkan ulang Soca & Serigat secara otomatis';
  autoSortBtn.addEventListener('click', () => {
    if (animator.isAnimating) return;
    manualOrderMode = false;
    selectedMoveCardId = null;
    if (isMultiplayer()) {
      if (isHostingLan()) lanHost.handleLocalHostAction({ type: 'sort_hand' });
      else sendGuestMessage({ type: 'sort_hand' });
    } else {
      state = sortHumanHand(state, mySeat);
      render();
    }
  });

  handControls.append(moveToggleBtn, autoSortBtn);
  if (!hasPendingCard) {
    statusBanners.appendChild(handControls);
  }
  bottom.appendChild(statusBanners);

  // Large Spotlight "Kartu Baru Diambil" above the human hand with Ambil & Buang buttons BELOW it
  if (state.pendingDrawnCard) {
    const pending = state.pendingDrawnCard;
    const def = CARD_DEFS[pending.key];
    const match = findPendingMeldMatches(pending, human.hand);

    const pendingBox = document.createElement('div');
    pendingBox.className = `pending-spotlight ${isNgandangReady ? 'is-ngandang' : ''}`;

    const titlePill = document.createElement('div');
    titlePill.className = 'pending-spotlight-header';
    const ngandangTag = isNgandangReady
      ? `<span class="pending-match-tag is-ngandang">🔥 NGANDANG!</span>`
      : '';
    const matchTag = match
      ? `<span class="pending-match-tag is-${match.kind}">${
          match.complete
            ? match.kind === 'soca'
              ? '🔥 Soca Lengkap!'
              : match.kind === 'lawang'
                ? '🔥 Lawang Lengkap!'
                : '🔥 Serigat Lengkap!'
            : match.kind === 'soca'
              ? '➜ Calon Soca'
              : '➜ Calon Serigat'
        }</span>`
      : '';
    titlePill.innerHTML = `<span class="pending-title">Kartu Baru: <strong>${def.balineseName}</strong></span>${ngandangTag}${matchTag}`;

    const pendingCardEl = renderClassicCard(pending.key, {
      small: false,
      isNew: true,
      hoverExtra: 'Kartu baru diambil',
    });
    pendingCardEl.classList.add('ceki-card--large');
    pendingCardEl.dataset.animAnchor = 'pending-card';
    pendingCardEl.dataset.cardId = pending.id;

    const pendingBtns = document.createElement('div');
    pendingBtns.className = 'pending-spotlight-actions';

    const takeBtn = document.createElement('button');
    takeBtn.className = 'btn btn-gold btn-pending-choice';
    takeBtn.dataset.focusId = 'take-pending-btn';
    takeBtn.disabled = locked;
    takeBtn.textContent = '✓ Ambil';
    takeBtn.addEventListener('click', handleAcceptPendingCard);

    const dropBtn = document.createElement('button');
    dropBtn.className = 'btn btn-action btn-pending-choice';
    dropBtn.dataset.focusId = 'drop-pending-btn';
    dropBtn.disabled = locked;
    dropBtn.textContent = '✕ Buang';
    dropBtn.addEventListener('click', handleDiscardPendingCard);

    pendingBtns.append(takeBtn, dropBtn);
    pendingBox.append(titlePill, pendingCardEl, pendingBtns);
    bottom.appendChild(pendingBox);
  }

  const recommendedDiscardId =
    showHints && canDiscardFromHand && !canCeki
      ? getRecommendedDiscardId(human.hand, state.playStyle)
      : null;

  const bottomRow = document.createElement('div');
  bottomRow.className = 'human-area-row';

  const handRow = document.createElement('div');
  handRow.className = 'human-hand-row';

  const currentMeldSigs = new Set<string>();
  let formedNewMeld = false;

  if (manualOrderMode) {
    // Manual arrangement: keep exact user order, detect contiguous 3-card Soca/Serigat
    const contiguous = detectContiguousMelds(human.hand);
    const ungrouped = human.hand.filter((c) => !contiguous.has(c.id));
    const leftoverHints = showHints ? analyzeLeftoverHints(ungrouped) : new Map();

    // Build contiguous group signatures to detect newly formed melds
    const manualGroupCards = new Map<number, { type: MeldType; ids: string[] }>();
    human.hand.forEach((card) => {
      const m = contiguous.get(card.id);
      if (m) {
        const entry = manualGroupCards.get(m.groupIndex) ?? { type: m.type, ids: [] };
        entry.ids.push(card.id);
        manualGroupCards.set(m.groupIndex, entry);
      }
    });
    const newManualGroups = new Set<number>();
    manualGroupCards.forEach((g, idx) => {
      const sig = `${g.type}:${[...g.ids].sort().join(',')}`;
      currentMeldSigs.add(sig);
      if (!knownMeldSignatures.has(sig)) {
        newManualGroups.add(idx);
        formedNewMeld = true;
      }
    });

    human.hand.forEach((card) => {
      const meldInfo = contiguous.get(card.id);
      const isNewCard = state.lastDrawnCardId === card.id;
      const isRecDiscard = recommendedDiscardId === card.id;
      const pairHint = leftoverHints.get(card.id);

      let hintTone: 'discard' | 'pair' | 'serigat' | undefined;
      let hoverExtra: string | undefined;

      if (meldInfo) {
        const mLabel = meldInfo.type.toUpperCase();
        hoverExtra = `Susunan ${mLabel} (Manual)`;
      } else if (showHints) {
        if (isRecDiscard) {
          hintTone = 'discard';
          hoverExtra = 'Saran: Buang kartu ini';
        } else if (pairHint) {
          hintTone = pairHint.tag === 'PASANG' ? 'pair' : 'serigat';
          hoverExtra = pairHint.detail;
        }
      }

      const cardEl = renderClassicCard(card.key, {
        inMeld: meldInfo !== undefined,
        meldColorIndex: meldInfo?.groupIndex,
        isNew: isNewCard,
        isHint: isRecDiscard,
        hintTone,
        hoverExtra,
        clickable: !locked && (canDiscardFromHand || moveMode),
      });
      if (meldInfo?.type === 'soca') {
        cardEl.classList.add('is-soca-card');
        const flames = document.createElement('div');
        flames.className = 'meld-fire-flames is-card-flames';
        flames.setAttribute('aria-hidden', 'true');
        flames.innerHTML = '<span></span><span></span><span></span>';
        cardEl.appendChild(flames);
      }
      if (meldInfo && newManualGroups.has(meldInfo.groupIndex)) {
        cardEl.classList.add('is-newly-formed');
        const groupIds = manualGroupCards.get(meldInfo.groupIndex)?.ids;
        if (groupIds && groupIds[1] === card.id) {
          const badge = document.createElement('span');
          badge.className = `meld-formed-badge is-${meldInfo.type}`;
          badge.textContent = `🔥 ${meldInfo.type.toUpperCase()}!`;
          cardEl.appendChild(badge);
        }
      }
      cardEl.dataset.cardId = card.id;
      attachHandCardInteractions(cardEl, card.id, canDiscardFromHand);
      handRow.appendChild(cardEl);
    });
  } else {
    // Auto-grouped arrangement: Soca/Serigat groups, then leftovers
    const newCard = state.lastDrawnCardId
      ? human.hand.find((c) => c.id === state.lastDrawnCardId) ?? null
      : null;
    const baseHand = newCard
      ? human.hand.filter((c) => c.id !== newCard.id)
      : human.hand;
    const partial = findBestPartialMelds(baseHand, state.playStyle);
    const leftoverHints = showHints ? analyzeLeftoverHints(partial.leftover) : new Map();

    if (newCard) {
      const isRecDiscard = recommendedDiscardId === newCard.id;
      const newEl = renderClassicCard(newCard.key, {
        isNew: true,
        isHint: isRecDiscard,
        hoverExtra: isRecDiscard ? 'Saran: Buang kartu ini' : 'Baru dimasukkan ke tangan',
        clickable: !locked && (canDiscardFromHand || moveMode),
      });
      newEl.dataset.cardId = newCard.id;
      attachHandCardInteractions(newEl, newCard.id, canDiscardFromHand);
      handRow.appendChild(newEl);
    }

    partial.melds.forEach((meld, mIdx) => {
      const sig = getMeldSignature(meld);
      currentMeldSigs.add(sig);
      const isNewlyFormed = !knownMeldSignatures.has(sig);
      if (isNewlyFormed) formedNewMeld = true;

      const groupWrap = document.createElement('div');
      groupWrap.className = `hand-meld-group meld-group-box-${mIdx % 4} is-${meld.type}-meld ${isNewlyFormed ? 'is-newly-formed' : ''}`;

      if (meld.type === 'soca') {
        const flames = document.createElement('div');
        flames.className = 'meld-fire-flames';
        flames.setAttribute('aria-hidden', 'true');
        flames.innerHTML = '<span></span><span></span><span></span><span></span><span></span><span></span>';
        groupWrap.appendChild(flames);
      }

      const meldName = meld.type.toUpperCase();

      const groupCards = document.createElement('div');
      groupCards.className = 'hand-meld-cards';
      meld.cards.forEach((card) => {
        const isRecDiscard = recommendedDiscardId === card.id;
        const cardEl = renderClassicCard(card.key, {
          inMeld: true,
          meldColorIndex: mIdx,
          isHint: isRecDiscard,
          hintTone: isRecDiscard ? 'discard' : undefined,
          hoverExtra: `Sudah jadi ${meldName}`,
          clickable: !locked && (canDiscardFromHand || moveMode),
        });
        cardEl.dataset.cardId = card.id;
        attachHandCardInteractions(cardEl, card.id, canDiscardFromHand);
        groupCards.appendChild(cardEl);
      });

      const typeCaption = document.createElement('span');
      typeCaption.className = `meld-type-caption is-${meld.type}`;
      typeCaption.textContent =
        meld.type === 'soca' ? 'Soca' : meld.type === 'lawang' ? 'Lawang' : 'Serigat';

      if (isNewlyFormed) {
        const badge = document.createElement('span');
        badge.className = `meld-formed-badge is-${meld.type}`;
        badge.textContent = `🔥 ${meld.type.toUpperCase()}!`;
        groupWrap.appendChild(badge);
      }

      groupWrap.append(groupCards, typeCaption);
      handRow.appendChild(groupWrap);
    });

    for (const card of partial.leftover) {
      const isRecDiscard = recommendedDiscardId === card.id;
      const pairHint = leftoverHints.get(card.id);

      let hintTone: 'discard' | 'pair' | 'serigat' | undefined;
      let hoverExtra: string | undefined;

      if (showHints) {
        if (isRecDiscard) {
          hintTone = 'discard';
          hoverExtra = 'Saran: Buang kartu ini';
        } else if (pairHint) {
          hintTone = pairHint.tag === 'PASANG' ? 'pair' : 'serigat';
          hoverExtra = pairHint.detail;
        }
      }

      const cardEl = renderClassicCard(card.key, {
        isHint: isRecDiscard,
        hintTone,
        hoverExtra,
        clickable: !locked && (canDiscardFromHand || moveMode),
      });
      cardEl.dataset.cardId = card.id;
      attachHandCardInteractions(cardEl, card.id, canDiscardFromHand);
      handRow.appendChild(cardEl);
    }
  }

  knownMeldSignatures = currentMeldSigs;
  if (formedNewMeld && !animator.isAnimating) {
    sfx.playMeldFormed();
  }

  // Human's own large discard pile placed on the RIGHT (replacing old button dock)
  const humanDiscardWrap = document.createElement('div');
  humanDiscardWrap.className = 'human-discard-wrap is-large';
  const humanDiscardTitle = document.createElement('span');
  humanDiscardTitle.className = 'pile-label';
  humanDiscardTitle.textContent = lanMode ? `Buangan ${human.name}` : 'Buangan Anda';
  humanDiscardWrap.append(
    renderPlayerRightDiscards(mySeat, false, false, discardCounts, neededKeys, true),
    humanDiscardTitle
  );

  // Ornate Balinese Action Plaques on the LEFT
  const dock = document.createElement('div');
  dock.className = 'action-dock';

  const drawBtn = document.createElement('button');
  drawBtn.className = 'btn-plaque plaque-draw';
  drawBtn.dataset.focusId = 'draw-btn';
  drawBtn.disabled = locked || !canDraw;
  drawBtn.innerHTML = `
    <span class="plaque-icon" aria-hidden="true">
      <svg viewBox="0 0 28 28" fill="none">
        <rect x="6" y="4" width="11" height="17" rx="2" stroke="currentColor" stroke-width="1.8" fill="rgba(255,255,255,0.08)"/>
        <rect x="11" y="7" width="11" height="17" rx="2" stroke="currentColor" stroke-width="1.8" fill="rgba(254,240,138,0.16)"/>
        <path d="M16.5 11v7m0 0-2.5-2.5m2.5 2.5 2.5-2.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </span>
    <span class="plaque-text">
      <strong>Ambil</strong>
      <small>Tumpukan</small>
    </span>
  `;
  drawBtn.addEventListener('click', handleHumanDraw);

  const ngejukBtn = document.createElement('button');
  ngejukBtn.className = `btn-plaque plaque-ngejuk ${ngejukRecommended ? 'btn-ceki-ready' : ''}`;
  ngejukBtn.dataset.focusId = 'ngejuk-btn';
  ngejukBtn.disabled = locked || !canDraw || !ngejukTarget;
  ngejukBtn.innerHTML = `
    <span class="plaque-icon" aria-hidden="true">
      <svg viewBox="0 0 28 28" fill="none">
        <rect x="8" y="6" width="12" height="17" rx="2" stroke="currentColor" stroke-width="1.8" fill="rgba(254,240,138,0.14)"/>
        <path d="M5 14c3-5 15-5 18 0" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        <circle cx="14" cy="14" r="2.5" fill="currentColor"/>
      </svg>
    </span>
    <span class="plaque-text">
      <strong>${ngejukRecommended ? 'Ngejuk! ★' : 'Ngejuk'}</strong>
      <small>Ambil Buangan</small>
    </span>
  `;
  ngejukBtn.addEventListener('click', handleHumanNgejuk);

  const cekiBtn = document.createElement('button');
  cekiBtn.className = `btn-plaque plaque-ceki ${canCeki ? 'btn-ceki-ready' : ''} ${isNgandangReady ? 'is-ngandang' : ''}`;
  cekiBtn.dataset.focusId = 'ceki-btn';
  cekiBtn.disabled = locked || !canCeki;
  cekiBtn.innerHTML = `
    <span class="plaque-icon" aria-hidden="true">
      <svg viewBox="0 0 28 28" fill="none">
        <path d="M14 4l2.7 5.6 6.1.9-4.4 4.3 1 6.1L14 18l-5.4 2.9 1-6.1L5.2 10.5l6.1-.9L14 4z" stroke="currentColor" stroke-width="1.7" fill="rgba(254,240,138,0.22)" stroke-linejoin="round"/>
      </svg>
    </span>
    <span class="plaque-text">
      <strong>Ceki!</strong>
      <small>Ngenen</small>
    </span>
  `;
  cekiBtn.addEventListener('click', handleHumanCeki);

  const deckCluster = document.createElement('div');
  deckCluster.className = 'human-deck-cluster';
  deckCluster.append(handRow);

  dock.append(drawBtn, ngejukBtn, cekiBtn);
  bottomRow.append(dock, deckCluster, humanDiscardWrap);
  bottom.appendChild(bottomRow);

  table.appendChild(bottom);
  tableWrapper.appendChild(table);
  workspace.appendChild(tableWrapper);

  // Dedicated Right-Side History Window
  if (historyOpen) {
    const sidebar = document.createElement('aside');
    sidebar.className = 'history-sidebar';

    const sideHeader = document.createElement('div');
    sideHeader.className = 'history-sidebar-header';
    sideHeader.innerHTML = `
      <span>📜 Riwayat Meja (${state.history.length})</span>
      <button class="btn-icon-close btn-side-close" title="Sembunyikan riwayat">✕</button>
    `;
    sideHeader.querySelector('.btn-side-close')?.addEventListener('click', () => {
      historyOpen = false;
      render();
    });

    const sideList = document.createElement('div');
    sideList.className = 'history-sidebar-list';
    const reversed = [...state.history].reverse();
    for (const item of reversed) {
      const row = document.createElement('div');
      row.className = `history-row ${item.actor === 'Anda' ? 'is-human' : item.actor === 'Sistem' ? 'is-system' : ''}`;
      row.innerHTML = `
        <span class="history-round">B${item.round}</span>
        <div class="history-row-body">
          <div class="history-row-top">
            <span class="history-actor">${item.actor}</span>
            ${item.cardName ? `<span class="history-card">${item.cardName}</span>` : ''}
          </div>
          <div class="history-action">${item.action}</div>
        </div>
      `;
      sideList.appendChild(row);
    }

    sidebar.append(sideHeader, sideList);
    workspace.appendChild(sidebar);
  }

  app.appendChild(workspace);

  // 3. Round Over Modal
  if (state.phase === 'round_over' && cekiModalReady) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const isNgandangWin = state.winKind === 'ngandang';
    const winModal = document.createElement('div');
    winModal.className = `win-modal ${isNgandangWin ? 'is-ngandang' : ''}`;

    if (isNgandangWin) {
      const ngandangBadge = document.createElement('div');
      ngandangBadge.className = 'ngandang-glow-banner is-modal';
      ngandangBadge.textContent = '🔥 NGANDANG! Ngupak Kartu Kemenangan Sendiri!';
      winModal.appendChild(ngandangBadge);
    }

    const title = document.createElement('h2');
    title.className = 'tutorial-title';
    title.textContent = isNgandangWin
      ? '🔥 NGANDANG! (Menang Sendiri)'
      : state.winKind === 'kupak'
        ? 'KUPAK NYARI! (Ngenen)'
        : state.winnerId !== null
          ? 'CEKI! (Ngenen)'
          : 'Babak Seri';

    const sub = document.createElement('p');
    sub.className = 'tutorial-body';
    sub.textContent = state.winReason ?? 'Babak selesai.';

    winModal.append(title, sub);

    if (state.winningMelds) {
      const grid = document.createElement('div');
      grid.className = 'win-melds-grid';
      state.winningMelds.forEach((meld) => {
        const box = document.createElement('div');
        box.className = 'win-meld-box';
        const lbl = document.createElement('div');
        lbl.className = 'win-meld-label';
        lbl.textContent =
          meld.type === 'soca'
            ? 'Soca (3 Sama)'
            : meld.type === 'lawang'
              ? 'Lawang (2 Sama + 1 Se-ekor)'
              : 'Serigat (Sekutu)';
        const cardsDiv = document.createElement('div');
        cardsDiv.className = 'win-meld-cards';
        meld.cards.forEach((c) => {
          cardsDiv.appendChild(renderClassicCard(c.key, { small: true }));
        });
        box.append(lbl, cardsDiv);
        grid.appendChild(box);
      });
      winModal.appendChild(grid);
    }

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn btn-gold';
    nextBtn.dataset.focusId = 'next-round-btn';
    nextBtn.disabled = !canStartNewRound;
    nextBtn.textContent = canStartNewRound
      ? `Main Babak ${state.round + 1} →`
      : `Menunggu Host Memulai Babak ${state.round + 1}…`;
    nextBtn.addEventListener('click', () => {
      startRoundWithDeal();
    });
    winModal.appendChild(nextBtn);

    overlay.appendChild(winModal);
    app.appendChild(overlay);
  }

  // 4. Multiplayer LAN Wi-Fi Modal (preserves Solo vs Bot mode cleanly)
  if (lanModalOpen) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'win-modal lan-modal';

    const header = document.createElement('div');
    header.className = 'lan-modal-header';
    header.innerHTML = `<h2 class="tutorial-title">🌐 Main Bersama di Wi-Fi Lokal (LAN)</h2>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-icon-close';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Tutup';
    closeBtn.addEventListener('click', () => {
      lanModalOpen = false;
      render();
    });
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const desc = document.createElement('p');
    desc.className = 'lan-desc';
    desc.textContent =
      'Pilih "Jadi Host" untuk membuat meja LAN langsung dari aplikasi, atau "Gabung Meja" untuk masuk ke meja teman di Wi-Fi yang sama. Kursi kosong otomatis diisi Bot.';
    modal.appendChild(desc);

    const tabs = document.createElement('div');
    tabs.className = 'lan-tabs';

    const hostTabBtn = document.createElement('button');
    hostTabBtn.className = `btn btn-hud ${lanTab === 'host' ? 'is-on' : ''}`;
    hostTabBtn.textContent = '👑 Jadi Host (Buat Meja)';
    hostTabBtn.addEventListener('click', () => {
      lanTab = 'host';
      render();
    });

    const joinTabBtn = document.createElement('button');
    joinTabBtn.className = `btn btn-hud ${lanTab === 'join' ? 'is-on' : ''}`;
    joinTabBtn.textContent = '🔗 Gabung Meja (Join)';
    joinTabBtn.addEventListener('click', () => {
      lanTab = 'join';
      render();
    });

    tabs.append(hostTabBtn, joinTabBtn);
    modal.appendChild(tabs);

    const form = document.createElement('div');
    form.className = 'lan-form';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'lan-input';
    nameInput.placeholder = 'Nama Anda (mis. Putu)';
    nameInput.value = savedPlayerName;
    nameInput.maxLength = 16;
    form.appendChild(nameInput);

    const activeSnapshot = isHostingLan() ? hostSnapshot : null;
    const isConnectedToRoom = isHostingLan() || lan.status === 'connected';
    const roomUrls = isHostingLan() ? lanHost.shareUrls : lan.urls;
    const roomLobby = isHostingLan() ? (activeSnapshot?.lobby ?? []) : lan.lobby;
    const roomMySeat = isHostingLan() ? 0 : lan.mySeat;
    const roomIsHost = isHostingLan() || lan.isHost;
    const roomRoundActive = isHostingLan()
      ? (activeSnapshot?.roundActive ?? false)
      : lan.roundActive;

    const isNameTakenByOther = (candidate: string): boolean => {
      const lower = candidate.trim().toLowerCase();
      return roomLobby.some(
        (s) => s.seatIndex !== roomMySeat && s.name.trim().toLowerCase() === lower
      );
    };

    if (lanTab === 'host') {
      const hostActionBtn = document.createElement('button');
      hostActionBtn.className = 'btn btn-gold';
      hostActionBtn.textContent = isHostingLan()
        ? 'Perbarui Nama Host'
        : '👑 Aktifkan Meja sebagai Host LAN';
      hostActionBtn.addEventListener('click', () => {
        const cleanName = nameInput.value.trim() || 'Host';
        if (isHostingLan() && isNameTakenByOther(cleanName)) {
          hostErrorMsg = `Nama "${cleanName}" sudah dipakai pemain lain di meja.`;
          render();
          return;
        }
        hostErrorMsg = null;
        savedPlayerName = cleanName;
        window.localStorage.setItem('ceki_bali_lan_name', savedPlayerName);
        if (isHostingLan()) {
          lanHost.setHostName(cleanName);
        } else {
          void startHostingLan(cleanName);
        }
      });
      form.appendChild(hostActionBtn);

      const timerConfigRow = document.createElement('div');
      timerConfigRow.className = 'lan-timer-row';
      timerConfigRow.innerHTML = `<span class="lan-timer-label">⏱ Timer Giliran:</span>`;
      const timerSelect = document.createElement('select');
      timerSelect.className = 'lan-timer-select';
      [
        { val: 10, label: '10 Detik' },
        { val: 15, label: '15 Detik (Default)' },
        { val: 20, label: '20 Detik' },
        { val: 30, label: '30 Detik' },
        { val: 0, label: 'Tanpa Timer' },
      ].forEach((opt) => {
        const o = document.createElement('option');
        o.value = String(opt.val);
        o.textContent = opt.label;
        if (customTurnSeconds === opt.val) o.selected = true;
        timerSelect.appendChild(o);
      });
      timerSelect.addEventListener('change', () => {
        customTurnSeconds = Number(timerSelect.value);
        window.localStorage.setItem('ceki_bali_turn_sec', String(customTurnSeconds));
      });
      timerConfigRow.appendChild(timerSelect);
      form.appendChild(timerConfigRow);
    } else {
      const hostInput = document.createElement('input');
      hostInput.type = 'text';
      hostInput.className = 'lan-input';
      hostInput.placeholder = 'Alamat Host (mis. 192.168.1.10:4173)';
      hostInput.value = savedServerHost;

      const connectBtn = document.createElement('button');
      connectBtn.className = 'btn btn-gold';
      connectBtn.textContent =
        lan.status === 'connected' ? 'Perbarui Nama / Reconnect' : 'Gabung Meja LAN';
      connectBtn.addEventListener('click', () => {
        const cleanName = nameInput.value.trim() || 'Pemain';
        if (lan.status === 'connected' && isNameTakenByOther(cleanName)) {
          hostErrorMsg = `Nama "${cleanName}" sudah dipakai pemain lain di meja.`;
          render();
          return;
        }
        hostErrorMsg = null;
        lanHost.stop();
        savedPlayerName = cleanName;
        savedServerHost = hostInput.value.trim() || '127.0.0.1:4173';
        window.localStorage.setItem('ceki_bali_lan_name', savedPlayerName);
        window.localStorage.setItem('ceki_bali_lan_host', savedServerHost);
        lanMode = true;
        if (lan.status === 'connected' && hostInput.value.trim() === savedServerHost) {
          lan.send({ type: 'set_name', name: savedPlayerName });
        } else {
          lan.connect(savedServerHost, savedPlayerName);
        }
      });

      form.append(hostInput, connectBtn);
    }
    modal.appendChild(form);

    const errToShow = hostErrorMsg || lan.errorMessage;
    if (errToShow) {
      const err = document.createElement('div');
      err.className = 'lan-error';
      err.textContent = errToShow;
      modal.appendChild(err);
    }

    if (isConnectedToRoom) {
      if (roomUrls.length > 0) {
        const shareBox = document.createElement('div');
        shareBox.className = 'lan-share-box';
        const lbl = document.createElement('span');
        lbl.className = 'lan-share-label';
        lbl.textContent = 'Bagikan ke teman di Wi-Fi yang sama:';
        shareBox.appendChild(lbl);

        roomUrls.forEach((url) => {
          const row = document.createElement('div');
          row.className = 'lan-share-row';
          const codeEl = document.createElement('code');
          codeEl.textContent = url;
          const copyBtn = document.createElement('button');
          copyBtn.className = 'btn-copy-url';
          copyBtn.type = 'button';
          copyBtn.textContent = '📋 Salin';
          copyBtn.addEventListener('click', async () => {
            try {
              if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(url);
              } else {
                const ta = document.createElement('textarea');
                ta.value = url;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
              }
              copyBtn.textContent = '✓ Tersalin!';
              copyBtn.classList.add('is-copied');
              window.setTimeout(() => {
                copyBtn.textContent = '📋 Salin';
                copyBtn.classList.remove('is-copied');
              }, 1600);
            } catch {
              copyBtn.textContent = 'Gagal salin';
            }
          });
          row.append(codeEl, copyBtn);
          shareBox.appendChild(row);
        });
        modal.appendChild(shareBox);
      }

      const seatsGrid = document.createElement('div');
      seatsGrid.className = 'lan-seats-list';
      roomLobby.forEach((seat) => {
        const item = document.createElement('div');
        item.className = `lan-seat-item ${seat.seatIndex === roomMySeat ? 'is-me' : ''}`;
        item.innerHTML = `
          <span>Kursi ${seat.seatIndex + 1}: <strong>${seat.name}</strong></span>
          <span class="lan-seat-tag">${seat.connected ? (seat.seatIndex === 0 && roomIsHost ? 'Host (Wi-Fi)' : 'Manusia (Wi-Fi)') : 'Bot Pengisi'}</span>
        `;
        seatsGrid.appendChild(item);
      });
      modal.appendChild(seatsGrid);
    }

    const footer = document.createElement('div');
    footer.className = 'lan-footer-actions';

    if (isConnectedToRoom) {
      const startLanBtn = document.createElement('button');
      startLanBtn.className = 'btn btn-gold';
      startLanBtn.disabled = !roomIsHost;
      startLanBtn.textContent = roomIsHost
        ? roomRoundActive
          ? '↻ Mulai Babak Baru LAN'
          : '▶ Mulai Main Bersama (LAN)'
        : 'Menunggu Host Memulai…';
      startLanBtn.addEventListener('click', () => {
        lanMode = true;
        if (isHostingLan()) {
          lanHost.startRound(customTurnSeconds);
        } else {
          lan.send({ type: 'start_round', turnSeconds: customTurnSeconds });
        }
      });
      footer.appendChild(startLanBtn);
    }

    const soloBtn = document.createElement('button');
    soloBtn.className = 'btn btn-hud';
    soloBtn.textContent = '🤖 Mode Solo (vs 4 Bot Offline)';
    soloBtn.addEventListener('click', stopLanAndReturnSolo);
    footer.appendChild(soloBtn);

    modal.appendChild(footer);
    overlay.appendChild(modal);
    app.appendChild(overlay);
  }

  // 4b. Room Online (WebRTC P2P) Modal
  if (onlineModalOpen) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'win-modal lan-modal';

    const header = document.createElement('div');
    header.className = 'lan-modal-header';
    header.innerHTML = `<h2 class="tutorial-title">🌍 Room Online (Mabar Jarak Jauh)</h2>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-icon-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => {
      onlineModalOpen = false;
      render();
    });
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const desc = document.createElement('p');
    desc.className = 'lan-desc';
    desc.textContent =
      'Buat Room Online untuk mendapatkan Kode Room & Link Undangan, lalu bagikan ke teman di mana saja. Kursi kosong otomatis diisi Bot.';
    modal.appendChild(desc);

    const tabs = document.createElement('div');
    tabs.className = 'lan-tabs';
    const hostTabBtn = document.createElement('button');
    hostTabBtn.className = `btn lan-tab-btn ${onlineTab === 'host' ? 'is-active' : ''}`;
    hostTabBtn.textContent = '🌐 Buat Room Online';
    hostTabBtn.addEventListener('click', () => {
      onlineTab = 'host';
      render();
    });
    const joinTabBtn = document.createElement('button');
    joinTabBtn.className = `btn lan-tab-btn ${onlineTab === 'join' ? 'is-active' : ''}`;
    joinTabBtn.textContent = '🔗 Gabung Room (Kode)';
    joinTabBtn.addEventListener('click', () => {
      onlineTab = 'join';
      render();
    });
    tabs.append(hostTabBtn, joinTabBtn);
    modal.appendChild(tabs);

    const isOnlineHost = isHostingOnline();
    const isOnlineGuest = onlineGuest.status === 'connected';
    const isInOnlineRoom = isOnlineHost || isOnlineGuest;
    const onlineLobby = isOnlineHost ? (hostSnapshot?.lobby ?? []) : onlineGuest.lobby;
    const onlineMySeat = isOnlineHost ? 0 : onlineGuest.mySeat;
    const onlineIsHost = isOnlineHost || onlineGuest.isHost;
    const onlineRoundActive = isOnlineHost
      ? Boolean(hostSnapshot?.roundActive)
      : onlineGuest.roundActive;

    if (onlineTab === 'host') {
      const form = document.createElement('div');
      form.className = 'lan-form';

      const nameInput = document.createElement('input');
      nameInput.className = 'lan-input';
      nameInput.maxLength = 16;
      nameInput.placeholder = 'Nama Host (mis. Made)';
      nameInput.value = savedPlayerName;
      nameInput.addEventListener('input', () => {
        savedPlayerName = nameInput.value.trim() || 'Host';
        window.localStorage.setItem('ceki_bali_lan_name', savedPlayerName);
      });

      const timerRow = document.createElement('div');
      timerRow.className = 'lan-timer-row';
      const timerLbl = document.createElement('label');
      timerLbl.textContent = '⏱ Timer Giliran (detik, 0 = tanpa batas):';
      const timerInput = document.createElement('input');
      timerInput.type = 'number';
      timerInput.min = '0';
      timerInput.max = '120';
      timerInput.className = 'lan-input lan-timer-input';
      timerInput.value = String(customTurnSeconds);
      timerInput.addEventListener('input', () => {
        const val = Math.max(0, Math.min(120, Number(timerInput.value) || 0));
        customTurnSeconds = val;
        window.localStorage.setItem('ceki_bali_turn_sec', String(val));
      });
      timerRow.append(timerLbl, timerInput);

      const createBtn = document.createElement('button');
      createBtn.className = 'btn btn-gold';
      createBtn.disabled = onlineHostPeer.status === 'starting';
      createBtn.textContent =
        onlineHostPeer.status === 'starting'
          ? 'Membuat Room Online…'
          : isOnlineHost
            ? 'Perbarui Nama Host'
            : '🚀 Buat Room Online';
      createBtn.addEventListener('click', () => {
        const cleanName = nameInput.value.trim().slice(0, 16) || 'Host';
        savedPlayerName = cleanName;
        window.localStorage.setItem('ceki_bali_lan_name', cleanName);
        if (isOnlineHost) {
          lanHost.setHostName(cleanName);
        } else {
          lan.disconnect();
          lanHost.stop();
          lanMode = false;
          onlineHostPeer.start(cleanName, lanHost);
        }
      });

      form.append(nameInput, timerRow, createBtn);
      modal.appendChild(form);

      if (hostErrorMsg) {
        const errEl = document.createElement('div');
        errEl.className = 'lan-error';
        errEl.textContent = hostErrorMsg;
        modal.appendChild(errEl);
      }

      if (isOnlineHost && onlineHostPeer.roomCode) {
        const urlBox = document.createElement('div');
        urlBox.className = 'lan-urls-box';
        const codeRow = document.createElement('div');
        codeRow.className = 'online-code-row';
        codeRow.innerHTML = `<span>Kode Room:</span><strong class="online-room-code">${onlineHostPeer.roomCode}</strong>`;
        const copyCodeBtn = document.createElement('button');
        copyCodeBtn.className = 'btn btn-hud btn-copy-url';
        copyCodeBtn.textContent = '📋 Salin Kode';
        copyCodeBtn.addEventListener('click', () => {
          navigator.clipboard?.writeText(onlineHostPeer.roomCode).then(() => {
            copyCodeBtn.textContent = '✓ Tersalin!';
            window.setTimeout(() => {
              copyCodeBtn.textContent = '📋 Salin Kode';
            }, 1800);
          });
        });
        codeRow.appendChild(copyCodeBtn);
        urlBox.appendChild(codeRow);

        const urlRow = document.createElement('div');
        urlRow.className = 'lan-url-row';
        const urlText = document.createElement('code');
        urlText.className = 'lan-url-code';
        urlText.textContent = onlineHostPeer.inviteUrl;
        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn btn-hud btn-copy-url';
        copyBtn.textContent = '📋 Salin Link';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard?.writeText(onlineHostPeer.inviteUrl).then(() => {
            copyBtn.textContent = '✓ Tersalin!';
            window.setTimeout(() => {
              copyBtn.textContent = '📋 Salin Link';
            }, 1800);
          });
        });
        urlRow.append(urlText, copyBtn);
        urlBox.appendChild(urlRow);
        modal.appendChild(urlBox);
      }
    } else {
      const form = document.createElement('div');
      form.className = 'lan-form';

      const nameInput = document.createElement('input');
      nameInput.className = 'lan-input';
      nameInput.maxLength = 16;
      nameInput.placeholder = 'Nama Anda (mis. Ketut)';
      nameInput.value = savedPlayerName;

      const roomInput = document.createElement('input');
      roomInput.className = 'lan-input';
      roomInput.placeholder = 'Kode Room (mis. K7M2P) atau tempel Link Undangan';
      roomInput.value = savedOnlineRoomCode;

      const connectBtn = document.createElement('button');
      connectBtn.className = 'btn btn-gold';
      connectBtn.disabled = onlineGuest.status === 'connecting';
      connectBtn.textContent =
        onlineGuest.status === 'connecting'
          ? 'Menghubungkan ke Room…'
          : isOnlineGuest
            ? 'Terhubung! (Perbarui Nama)'
            : '🔗 Gabung Room Online';
      connectBtn.addEventListener('click', () => {
        savedPlayerName = nameInput.value.trim().slice(0, 16) || 'Pemain';
        savedOnlineRoomCode = extractRoomCode(roomInput.value);
        window.localStorage.setItem('ceki_bali_lan_name', savedPlayerName);
        if (isOnlineGuest) {
          onlineGuest.send({ type: 'set_name', name: savedPlayerName });
        } else {
          onlineHostPeer.stop();
          lanHost.stop();
          lan.disconnect();
          lanMode = false;
          onlineGuest.connect(roomInput.value, savedPlayerName);
        }
      });

      form.append(nameInput, roomInput, connectBtn);
      modal.appendChild(form);

      if (onlineGuest.errorMessage) {
        const errEl = document.createElement('div');
        errEl.className = 'lan-error';
        errEl.textContent = onlineGuest.errorMessage;
        modal.appendChild(errEl);
      }
    }

    if (isInOnlineRoom && onlineLobby.length > 0) {
      const lobbyList = document.createElement('div');
      lobbyList.className = 'lan-lobby-list';
      onlineLobby.forEach((seat) => {
        const row = document.createElement('div');
        row.className = `lan-seat-row ${seat.seatIndex === onlineMySeat ? 'is-me' : ''}`;
        row.innerHTML = `
          <span>Kursi ${seat.seatIndex + 1}: <strong>${seat.name}</strong></span>
          <span class="lan-seat-badge">${
            seat.seatIndex === 0
              ? 'Host (Online)'
              : seat.connected
                ? 'Manusia (Online)'
                : 'Bot Pengisi'
          }</span>
        `;
        lobbyList.appendChild(row);
      });
      modal.appendChild(lobbyList);
    }

    const footer = document.createElement('div');
    footer.className = 'lan-footer';

    if (isInOnlineRoom) {
      const startOnlineBtn = document.createElement('button');
      startOnlineBtn.className = 'btn btn-gold';
      startOnlineBtn.disabled = !onlineIsHost;
      startOnlineBtn.textContent = onlineIsHost
        ? onlineRoundActive
          ? '↻ Mulai Babak Baru Online'
          : '▶ Mulai Main Bersama (Online)'
        : 'Menunggu Host Memulai…';
      startOnlineBtn.addEventListener('click', () => {
        onlineMode = true;
        if (isHostingLan()) {
          lanHost.startRound(customTurnSeconds);
        } else {
          onlineGuest.send({ type: 'start_round', turnSeconds: customTurnSeconds });
        }
      });
      footer.appendChild(startOnlineBtn);
    }

    const soloBtn = document.createElement('button');
    soloBtn.className = 'btn btn-hud';
    soloBtn.textContent = isInOnlineRoom ? '🛑 Keluar Room (Mode Solo)' : '🤖 Main Offline (Solo)';
    soloBtn.addEventListener('click', stopLanAndReturnSolo);
    footer.appendChild(soloBtn);

    modal.appendChild(footer);
    overlay.appendChild(modal);
    app.appendChild(overlay);
  }

  // 5. Inspect All Discards Modal for any player
  if (inspectDiscardPlayerIdx !== null) {
    const targetPlayer = state.players[inspectDiscardPlayerIdx];
    if (targetPlayer) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          inspectDiscardPlayerIdx = null;
          render();
        }
      });

      const modal = document.createElement('div');
      modal.className = 'win-modal lan-modal';

      const header = document.createElement('div');
      header.className = 'lan-modal-header';
      header.innerHTML = `<h2 class="tutorial-title">🃏 Buangan ${targetPlayer.name} (${targetPlayer.discards.length} kartu)</h2>`;
      const closeBtn = document.createElement('button');
      closeBtn.className = 'btn-icon-close';
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', () => {
        inspectDiscardPlayerIdx = null;
        render();
      });
      header.appendChild(closeBtn);
      modal.appendChild(header);

      const grid = document.createElement('div');
      grid.className = 'discard-inspect-grid';
      if (targetPlayer.discards.length === 0) {
        grid.innerHTML = `<p class="lan-desc">Belum ada kartu yang dibuang.</p>`;
      } else {
        targetPlayer.discards.forEach((c, idx) => {
          const item = document.createElement('div');
          item.className = 'discard-inspect-item';
          const cardEl = renderClassicCard(c.key, {
            small: true,
            hoverExtra: `Buangan ke-${idx + 1}`,
          });
          const seq = document.createElement('span');
          seq.className = 'discard-inspect-seq';
          seq.textContent = `#${idx + 1} ${CARD_DEFS[c.key].balineseName}`;
          item.append(cardEl, seq);
          grid.appendChild(item);
        });
      }

      modal.appendChild(grid);
      overlay.appendChild(modal);
      app.appendChild(overlay);
    }
  }

  if (activeFocusId) {
    const target = app.querySelector(`[data-focus-id="${activeFocusId}"]`) as HTMLButtonElement | null;
    if (target && !target.disabled) {
      target.focus({ preventScroll: true });
    }
  }

  if (state.pendingDrawnCard && !animator.isAnimating) {
    window.requestAnimationFrame(() => renderPendingMatchArrows());
  }

  if (deckInput.isConnected) {
    const handCardEls = Array.from(app.querySelectorAll('.human-hand-row [data-card-id]')) as HTMLElement[];
    if (handCardEls.length > 0) {
      gamepadCursorIdx = Math.max(0, Math.min(gamepadCursorIdx, handCardEls.length - 1));
      handCardEls[gamepadCursorIdx].classList.add('is-gamepad-focused');
    }

    const hintBar = document.createElement('div');
    hintBar.className = 'deck-hint-bar';
    hintBar.textContent =
      '🎮 D-Pad: Pilih Kartu • Ⓐ Ambil / Buang • Ⓧ Ngejuk / Buang Langsung • Ⓨ Ceki! • LB/RB: Atur/Susun • Select: Riwayat';
    app.appendChild(hintBar);
  }
}

render();
if (!startupOpen && !onlineModalOpen && !lanModalOpen) {
  scheduleBotTurnIfNeeded();
}

// Auto-open Online Join modal if URL has ?room=CODE, or auto-connect LAN Guest on private LAN URL
let autoJoinedLan = false;
if (savedOnlineRoomCode) {
  autoJoinedLan = true;
  startupOpen = false;
  onlineTab = 'join';
  onlineModalOpen = true;
  render();
} else if (window.location.protocol === 'http:' && window.location.host) {
  const host = window.location.hostname;
  const isPrivateLanHost =
    /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.|100\.)/.test(host) || host.endsWith('.local');
  if (isPrivateLanHost || window.location.port === '4173') {
    autoJoinedLan = true;
    fetch('/api/lan-info')
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => {
        if (!info || isHostingLan()) return;
        startupOpen = false;
        lanMode = true;
        lanTab = 'join';
        lanModalOpen = true;
        lan.connect(window.location.host, savedPlayerName);
      })
      .catch(() => {});
  }
}

const TUTORIAL_KEY = 'ceki_bali_tutorial_seen_v2';
if (!autoJoinedLan && !startupOpen && !window.localStorage.getItem(TUTORIAL_KEY)) {
  window.localStorage.setItem(TUTORIAL_KEY, '1');
  tutorial.open(0);
}
