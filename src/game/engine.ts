import { CARD_DEFS, createDeck, sortHand } from './deck.ts';
import {
  checkWinWithCard,
  evaluateHandScore,
  findBestPartialMelds,
  findWinningMelds,
  getNyagaWaits,
  getReadyStatus,
} from './melds.ts';
import type { CardInstance, GameRulesOptions, GameState, Player, PlayStyle } from './types.ts';

export const DEFAULT_GAME_RULES: GameRulesOptions = {
  revealWaitingCards: false,
  nyagaWinRule: 'ngupak_only',
};

export function createInitialPlayers(): Player[] {
  return [
    {
      id: 0,
      name: 'Anda',
      isHuman: true,
      hand: [],
      discards: [],
      score: 0,
      avatarText: 'ANDA',
      statusText: 'Giliran Anda',
    },
    {
      id: 1,
      name: 'Made',
      isHuman: false,
      difficulty: 'casual',
      hand: [],
      discards: [],
      score: 0,
      avatarText: 'M',
      statusText: 'Menunggu',
    },
    {
      id: 2,
      name: 'Nyoman',
      isHuman: false,
      difficulty: 'balanced',
      hand: [],
      discards: [],
      score: 0,
      avatarText: 'N',
      statusText: 'Menunggu',
    },
    {
      id: 3,
      name: 'Ketut',
      isHuman: false,
      difficulty: 'strategic',
      hand: [],
      discards: [],
      score: 0,
      avatarText: 'K',
      statusText: 'Menunggu',
    },
    {
      id: 4,
      name: 'Wayan',
      isHuman: false,
      difficulty: 'balanced',
      hand: [],
      discards: [],
      score: 0,
      avatarText: 'W',
      statusText: 'Menunggu',
    },
  ];
}

export function getNgejukTarget(state: GameState): {
  playerIndex: number;
  card: CardInstance;
} | null {
  if (state.lastDiscardPlayerIndex === null) return null;
  const sourcePlayer = state.players[state.lastDiscardPlayerIndex];
  if (!sourcePlayer || sourcePlayer.discards.length === 0) return null;
  const topCard = sourcePlayer.discards[sourcePlayer.discards.length - 1];
  const currentPlayer = state.players[state.currentPlayerIndex];
  // Ngutang-Ngejuk: tidak boleh mengejuk kartu yang sama persis dengan yang baru saja dibuang sendiri
  if (currentPlayer?.lastDiscardedKey && currentPlayer.lastDiscardedKey === topCard.key) {
    return null;
  }
  return {
    playerIndex: state.lastDiscardPlayerIndex,
    card: topCard,
  };
}

/**
 * Returns true if the player is allowed to discard `cardId` from their hand.
 * Cards taken via Ngejuk (jukjukan) stay open and cannot be discarded unless
 * discarding them puts/keeps the player in Nyari (Mecari / Mejaga).
 */
export function canDiscardCardFromHand(
  player: Player,
  cardId: string,
  playStyle: PlayStyle = 'nyari'
): boolean {
  const exposed = player.exposedCardIds ?? [];
  if (!exposed.includes(cardId)) return true;
  const remaining = player.hand.filter((c) => c.id !== cardId);
  return getReadyStatus(remaining, playStyle).mode !== null;
}

/**
 * Returns true if the active player can immediately discard `pendingDrawnCard`.
 * A pending card drawn via Ngejuk cannot be discarded unless the remaining 11 cards are Nyari.
 */
export function canDiscardPendingCard(state: GameState): boolean {
  if (!state.pendingDrawnCard) return false;
  if (state.lastDrawSource !== 'ngejuk') return true;
  const activePlayer = state.players[state.currentPlayerIndex];
  if (!activePlayer) return false;
  return getReadyStatus(activePlayer.hand, state.playStyle).mode !== null;
}

export function startNewRound(
  existingState?: GameState,
  playStyleOverride?: PlayStyle,
  customPlayers?: Player[],
  rulesOverride?: GameRulesOptions
): GameState {
  const deck = createDeck();
  const playStyle: PlayStyle = playStyleOverride ?? existingState?.playStyle ?? 'nyari';
  const rules: GameRulesOptions = rulesOverride ?? existingState?.rules ?? DEFAULT_GAME_RULES;
  // Randomize starting player at round spawn
  const playerCount = customPlayers?.length ?? existingState?.players.length ?? 5;
  const startPlayerIndex = Math.floor(Math.random() * playerCount);
  const prevPlayerIndex = (startPlayerIndex + 1) % playerCount;

  const basePlayers = customPlayers
    ? customPlayers.map((p, idx) => ({
        ...p,
        hand: [],
        discards: [],
        exposedCardIds: [],
        lastDiscardedKey: null,
        statusText: idx === startPlayerIndex ? 'Giliran' : 'Menunggu',
      }))
    : existingState
      ? existingState.players.map((p, idx) => ({
          ...p,
          hand: [],
          discards: [],
          exposedCardIds: [],
          lastDiscardedKey: null,
          statusText: idx === startPlayerIndex ? (p.isHuman ? 'Giliran Anda' : 'Giliran') : 'Menunggu',
        }))
      : createInitialPlayers().map((p, idx) => ({
          ...p,
          exposedCardIds: [],
          lastDiscardedKey: null,
          statusText: idx === startPlayerIndex ? (p.isHuman ? 'Giliran Anda' : 'Giliran') : 'Menunggu',
        }));
  const players: Player[] = basePlayers;

  // Deal 11 cards to each of the 5 players (55 cards)
  for (let i = 0; i < players.length; i++) {
    const dealt = deck.splice(0, 11);
    players[i].hand = players[i].isHuman ? sortHand(dealt) : dealt;
    players[i].readyMode = getReadyStatus(players[i].hand, playStyle).mode;
  }

  // Place 1 opening discard to the right of the player just before the random starter
  const openingDiscard = deck.pop()!;
  players[prevPlayerIndex].discards = [openingDiscard];

  const round = existingState ? existingState.round + 1 : 1;
  const styleLabel =
    playStyle === 'soca' ? 'Soca' : playStyle === 'serigat' ? 'Serigat' : 'Nyari';

  const firstPlayer = players[startPlayerIndex];
  const startEntry = {
    round,
    actor: 'Sistem',
    action: `Babak ${round} dimulai (${styleLabel}) • Mulai: ${firstPlayer.name}`,
    cardName: `Kartu awal: ${CARD_DEFS[openingDiscard.key].balineseName}`,
  };

  return {
    round,
    playStyle,
    rules,
    players,
    currentPlayerIndex: startPlayerIndex,
    phase: firstPlayer.isHuman ? 'awaiting_draw' : 'bot_thinking',
    botStep: firstPlayer.isHuman ? null : 'draw',
    stock: deck,
    lastDiscardPlayerIndex: prevPlayerIndex,
    lastDrawnCardId: null,
    lastDrawSource: null,
    pendingDrawnCard: null,
    winnerId: null,
    winningMelds: null,
    winReason: null,
    lastActionLog: `Babak ${round} (${styleLabel}) • Giliran pertama: ${firstPlayer.name}.`,
    history: [...(existingState?.history ?? []).slice(-100), startEntry],
  };
}

function canCurrentPlayerDraw(state: GameState): boolean {
  if (state.phase === 'round_over') return false;
  if (state.pendingDrawnCard !== null) return false;
  const player = state.players[state.currentPlayerIndex];
  if (!player || player.hand.length !== 11) return false;
  if (player.isHuman) {
    return state.phase === 'awaiting_draw';
  }
  return state.phase === 'bot_thinking' && state.botStep === 'draw';
}

function canCurrentPlayerDiscard(state: GameState, playerIndex = state.currentPlayerIndex): boolean {
  if (state.phase === 'round_over') return false;
  if (playerIndex !== state.currentPlayerIndex) return false;
  const player = state.players[playerIndex];
  if (!player) return false;
  if (player.isHuman) {
    return state.phase === 'awaiting_discard' && state.pendingDrawnCard === null && player.hand.length === 12;
  }
  return state.phase === 'bot_thinking' && state.botStep === 'discard' && player.hand.length === 12;
}

export function getExposedTableCards(
  player: Player,
  _playStyle: PlayStyle = 'nyari'
): CardInstance[] {
  const exposedIds = new Set(player.exposedCardIds ?? []);
  if (exposedIds.size === 0) return [];
  return player.hand.filter((c) => exposedIds.has(c.id));
}

export function getExposedWaitingCards(
  player: Player,
  playStyle: PlayStyle = 'nyari'
): CardInstance[] {
  if (player.hand.length !== 11) return [];
  if (player.readyMode !== 'mecari' && player.readyMode !== 'mejaga') return [];
  const partial = findBestPartialMelds(player.hand, playStyle);
  if (partial.melds.length === 3 && partial.leftover.length === 2) {
    return partial.leftover;
  }
  return [];
}

function checkKupakNyariWinner(
  state: GameState,
  openedCard: CardInstance,
  openerIdx: number,
  sourceLabel: string,
  allowMejaga = true
): GameState | null {
  const count = state.players.length;
  for (let offset = 1; offset < count; offset++) {
    const idx = (openerIdx + count - offset) % count;
    const candidate = state.players[idx];
    if (!candidate || candidate.hand.length !== 11) continue;
    const winRes = checkWinWithCard(candidate.hand, openedCard, state.playStyle);
    if (!winRes) continue;
    if (!allowMejaga && winRes.mode === 'mejaga') continue;

    const fullHand = [...candidate.hand, openedCard];
    const openerName = state.players[openerIdx]?.name ?? 'Pemain';
    const modeLabel = winRes.mode === 'mejaga' ? 'Mejaga' : 'Mecari';
    const actionPrefix = sourceLabel === 'Buangan' ? `Menang ${modeLabel} (Buangan` : `Menang Kupak ${modeLabel} (${sourceLabel}`;
    const reasonSource =
      sourceLabel === 'Buangan'
        ? `${modeLabel} Buangan — ${CARD_DEFS[openedCard.key].balineseName} dibuang oleh ${openerName}`
        : `Kupak ${modeLabel} — ${CARD_DEFS[openedCard.key].balineseName} dibuka oleh ${openerName}`;
    const updatedPlayers = state.players.map((p, pIdx) =>
      pIdx === idx
        ? { ...p, hand: fullHand, score: p.score + 10, statusText: `CEKI (${modeLabel})!` }
        : p
    );

    return {
      ...state,
      players: updatedPlayers,
      pendingDrawnCard: null,
      lastDrawnCardId: null,
      phase: 'round_over',
      botStep: null,
      winnerId: candidate.id,
      winKind: 'kupak',
      winningMelds: winRes.melds,
      winReason: `${candidate.name} menang CEKI! (${reasonSource})`,
      lastActionLog: `${candidate.name} langsung menang CEKI (${reasonSource})! (+10 poin)`,
      history: [
        ...state.history,
        {
          round: state.round,
          actor: candidate.name,
          action: `${actionPrefix} ${openerName})`,
          cardName: CARD_DEFS[openedCard.key].balineseName,
        },
      ],
    };
  }
  return null;
}

export function drawFromStock(state: GameState): GameState {
  if (!canCurrentPlayerDraw(state)) return state;

  if (state.stock.length === 0) {
    return {
      ...state,
      phase: 'round_over',
      botStep: null,
      winnerId: null,
      winReason: 'Tumpukan habis — Babak berakhir Seri!',
      lastActionLog: 'Tumpukan habis! Babak berakhir Seri.',
      history: [...state.history, { round: state.round, actor: 'Sistem', action: 'Tumpukan habis (Seri)' }],
    };
  }

  const nextStock = [...state.stock];
  const drawn = nextStock.pop()!;
  const player = state.players[state.currentPlayerIndex];

  const updatedPlayers = state.players.map((p, idx) => {
    if (idx !== state.currentPlayerIndex) return p;
    // Human gets pendingDrawnCard above the hand first; bots add directly
    const nextHand = p.isHuman ? p.hand : [...p.hand, drawn];
    return {
      ...p,
      hand: nextHand,
      readyMode: p.isHuman ? p.readyMode : null,
      statusText: 'Ambil kartu',
    };
  });

  const nextState: GameState = {
    ...state,
    players: updatedPlayers,
    stock: nextStock,
    lastDrawnCardId: player.isHuman ? null : drawn.id,
    lastDrawSource: 'stock',
    pendingDrawnCard: player.isHuman ? drawn : null,
    phase: player.isHuman ? 'awaiting_discard' : 'bot_thinking',
    botStep: player.isHuman ? null : 'discard',
    lastActionLog: `${player.name} membuka/mengambil kartu dari Tumpukan.`,
    history: [
      ...state.history,
      {
        round: state.round,
        actor: player.name,
        action: 'Ambil dari Tumpukan',
        cardName: player.isHuman ? CARD_DEFS[drawn.key].balineseName : undefined,
      },
    ],
  };

  // Kupak Nyari: if another player is Nyari and waiting for this opened card, they win immediately
  const kupakWin = checkKupakNyariWinner(nextState, drawn, state.currentPlayerIndex, 'Kupak');
  return kupakWin ?? nextState;
}

export function ngejukDiscard(state: GameState): GameState {
  if (!canCurrentPlayerDraw(state)) return state;
  const target = getNgejukTarget(state);
  if (!target) return state;

  const taken = target.card;
  const player = state.players[state.currentPlayerIndex];

  const updatedPlayers = state.players.map((p, idx) => {
    let nextDiscards = p.discards;
    if (idx === target.playerIndex) {
      nextDiscards = p.discards.slice(0, -1);
    }
    if (idx !== state.currentPlayerIndex) {
      return idx === target.playerIndex ? { ...p, discards: nextDiscards } : p;
    }
    const nextHand = p.isHuman ? p.hand : [...p.hand, taken];
    const nextExposed = p.isHuman
      ? p.exposedCardIds ?? []
      : [...(p.exposedCardIds ?? []), taken.id];
    return {
      ...p,
      hand: nextHand,
      discards: nextDiscards,
      exposedCardIds: nextExposed,
      readyMode: p.isHuman ? p.readyMode : null,
      statusText: 'Ngejuk!',
    };
  });

  return {
    ...state,
    players: updatedPlayers,
    lastDiscardPlayerIndex: null,
    lastNgejukFromIndex: target.playerIndex,
    lastDrawnCardId: player.isHuman ? null : taken.id,
    lastDrawSource: 'ngejuk',
    pendingDrawnCard: player.isHuman ? taken : null,
    phase: player.isHuman ? 'awaiting_discard' : 'bot_thinking',
    botStep: player.isHuman ? null : 'discard',
    lastActionLog: `${player.name} melakukan Ngejuk pada ${CARD_DEFS[taken.key].balineseName}!`,
    history: [
      ...state.history,
      {
        round: state.round,
        actor: player.name,
        action: `Ngejuk dari ${state.players[target.playerIndex].name}`,
        cardName: CARD_DEFS[taken.key].balineseName,
      },
    ],
  };
}

export function cancelNgejuk(state: GameState): GameState {
  const activeIdx = state.currentPlayerIndex;
  const activePlayer = state.players[activeIdx];
  if (
    state.phase !== 'awaiting_discard' ||
    !activePlayer?.isHuman ||
    !state.pendingDrawnCard ||
    state.lastDrawSource !== 'ngejuk' ||
    state.lastNgejukFromIndex === null ||
    state.lastNgejukFromIndex === undefined
  ) {
    return state;
  }

  const returnedCard = state.pendingDrawnCard;
  const sourceIdx = state.lastNgejukFromIndex;
  const updatedPlayers = state.players.map((p, idx) => {
    if (idx === sourceIdx) {
      return { ...p, discards: [...p.discards, returnedCard] };
    }
    if (idx === activeIdx) {
      return { ...p, statusText: 'Giliran Anda' };
    }
    return p;
  });

  return {
    ...state,
    players: updatedPlayers,
    pendingDrawnCard: null,
    lastDrawSource: null,
    lastDiscardPlayerIndex: sourceIdx,
    lastNgejukFromIndex: null,
    phase: 'awaiting_draw',
    botStep: null,
    lastActionLog: `${activePlayer.name} batal Ngejuk dan mengembalikan ${CARD_DEFS[returnedCard.key].balineseName}.`,
  };
}

export function acceptPendingDrawnCard(
  state: GameState,
  preserveHumanOrder = false
): GameState {
  const activeIdx = state.currentPlayerIndex;
  const activePlayer = state.players[activeIdx];
  if (
    state.phase !== 'awaiting_discard' ||
    !activePlayer?.isHuman ||
    !state.pendingDrawnCard ||
    activePlayer.hand.length !== 11
  ) {
    return state;
  }
  const drawn = state.pendingDrawnCard;
  const isNgejuk = state.lastDrawSource === 'ngejuk';
  const updatedPlayers = state.players.map((p, idx) => {
    if (idx !== activeIdx) return p;
    const nextHand = preserveHumanOrder ? [...p.hand, drawn] : sortHand([...p.hand, drawn]);
    const nextExposed = isNgejuk
      ? [...(p.exposedCardIds ?? []), drawn.id]
      : p.exposedCardIds ?? [];
    return { ...p, hand: nextHand, exposedCardIds: nextExposed, readyMode: null };
  });
  return {
    ...state,
    players: updatedPlayers,
    pendingDrawnCard: null,
    lastDrawnCardId: drawn.id,
    lastActionLog: `${activePlayer.name} menyimpan ${CARD_DEFS[drawn.key].balineseName} ke tangan. Pilih 1 kartu untuk dibuang.`,
  };
}

export function discardPendingDrawnCard(state: GameState): GameState {
  const activeIdx = state.currentPlayerIndex;
  const activePlayer = state.players[activeIdx];
  if (
    state.phase !== 'awaiting_discard' ||
    !activePlayer?.isHuman ||
    !state.pendingDrawnCard ||
    !canDiscardPendingCard(state)
  ) {
    return state;
  }
  const cardToDiscard = state.pendingDrawnCard;
  const nextPlayerIdx = (activeIdx + state.players.length - 1) % state.players.length;
  const nextPlayer = state.players[nextPlayerIdx];
  const ready = getReadyStatus(activePlayer.hand, state.playStyle);
  const waits = ready.waits;

  const updatedPlayers = state.players.map((p, idx) => {
    if (idx === activeIdx) {
      return {
        ...p,
        discards: [...p.discards, cardToDiscard],
        lastDiscardedKey: cardToDiscard.key,
        readyMode: ready.mode,
        statusText:
          ready.mode === 'mejaga'
            ? 'Mejaga!'
            : ready.mode === 'mecari'
              ? 'Mecari!'
              : `Buang ${CARD_DEFS[cardToDiscard.key].balineseName}`,
      };
    }
    if (idx === nextPlayerIdx) {
      return { ...p, statusText: nextPlayer.isHuman ? 'Giliran' : 'Berpikir...' };
    }
    return p;
  });

  const nextHistory = [
    ...state.history,
    {
      round: state.round,
      actor: activePlayer.name,
      action: 'Buang langsung',
      cardName: CARD_DEFS[cardToDiscard.key].balineseName,
    },
  ];

  const nextState: GameState = {
    ...state,
    players: updatedPlayers,
    pendingDrawnCard: null,
    lastDiscardPlayerIndex: activeIdx,
    currentPlayerIndex: nextPlayerIdx,
    lastDrawnCardId: null,
    lastDrawSource: null,
    phase: nextPlayer.isHuman ? 'awaiting_draw' : 'bot_thinking',
    botStep: nextPlayer.isHuman ? null : 'draw',
    lastActionLog: `${activePlayer.name} langsung membuang ${CARD_DEFS[cardToDiscard.key].balineseName}.${waits.length > 0 ? ' (Sudah Nyari!)' : ''}`,
    history: nextHistory,
  };

  // Mencari (Mecari) boleh menyambar buangan untuk menang; Nyaga sesuai opsi (wajib ngupak atau bebas)
  const allowMejagaFromBuangan = (nextState.rules?.nyagaWinRule ?? 'ngupak_only') === 'free';
  const buanganWin = checkKupakNyariWinner(
    nextState,
    cardToDiscard,
    activeIdx,
    'Buangan',
    allowMejagaFromBuangan
  );
  if (buanganWin) return buanganWin;

  if (state.stock.length === 0) {
    return {
      ...nextState,
      currentPlayerIndex: activeIdx,
      phase: 'round_over',
      botStep: null,
      winnerId: null,
      winReason: 'Tumpukan habis — Babak berakhir Seri!',
      lastActionLog: `${activePlayer.name} membuang ${CARD_DEFS[cardToDiscard.key].balineseName}. Tumpukan habis!`,
    };
  }

  return nextState;
}

export function reorderHumanHand(
  state: GameState,
  fromIndex: number,
  toIndex: number,
  playerIndex = 0
): GameState {
  const human = state.players[playerIndex];
  if (
    !human ||
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= human.hand.length ||
    toIndex >= human.hand.length
  ) {
    return state;
  }
  const nextHand = [...human.hand];
  const [moved] = nextHand.splice(fromIndex, 1);
  nextHand.splice(toIndex, 0, moved);

  const updatedPlayers = state.players.map((p, idx) =>
    idx === playerIndex ? { ...p, hand: nextHand } : p
  );
  return {
    ...state,
    players: updatedPlayers,
  };
}

export function sortHumanHand(state: GameState, playerIndex = 0): GameState {
  const updatedPlayers = state.players.map((p, idx) => {
    if (idx !== playerIndex) return p;
    const grouped = findBestPartialMelds(p.hand, state.playStyle);
    const ordered = [...grouped.melds.flatMap((m) => m.cards), ...grouped.leftover];
    return { ...p, hand: ordered };
  });
  return {
    ...state,
    players: updatedPlayers,
  };
}

export function discardCard(
  state: GameState,
  cardId: string,
  preserveHumanOrder = false
): GameState {
  const playerIdx = state.currentPlayerIndex;
  if (!canCurrentPlayerDiscard(state, playerIdx)) return state;
  const player = state.players[playerIdx];
  const cardToDiscard = player.hand.find((c) => c.id === cardId);
  if (!cardToDiscard) return state;
  if (!canDiscardCardFromHand(player, cardId, state.playStyle)) return state;

  const nextHand = player.hand.filter((c) => c.id !== cardId);
  const ready = getReadyStatus(nextHand, state.playStyle);
  const waits = ready.waits;

  const nextPlayerIdx = (playerIdx + state.players.length - 1) % state.players.length;
  const nextPlayer = state.players[nextPlayerIdx];

  const updatedPlayers = state.players.map((p, idx) => {
    if (idx === playerIdx) {
      return {
        ...p,
        hand: p.isHuman && !preserveHumanOrder ? sortHand(nextHand) : nextHand,
        discards: [...p.discards, cardToDiscard],
        exposedCardIds: (p.exposedCardIds ?? []).filter((id) => id !== cardId),
        lastDiscardedKey: cardToDiscard.key,
        readyMode: ready.mode,
        statusText:
          ready.mode === 'mejaga'
            ? 'Mejaga!'
            : ready.mode === 'mecari'
              ? 'Mecari!'
              : `Buang ${CARD_DEFS[cardToDiscard.key].balineseName}`,
      };
    }
    if (idx === nextPlayerIdx) {
      return {
        ...p,
        statusText: p.isHuman ? 'Giliran Anda' : 'Berpikir...',
      };
    }
    return p;
  });

  const nextHistory = [
    ...state.history,
    {
      round: state.round,
      actor: player.name,
      action: 'Buang',
      cardName: CARD_DEFS[cardToDiscard.key].balineseName,
    },
  ];

  const nextState: GameState = {
    ...state,
    players: updatedPlayers,
    lastDiscardPlayerIndex: playerIdx,
    currentPlayerIndex: nextPlayerIdx,
    lastDrawnCardId: null,
    lastDrawSource: null,
    phase: nextPlayer.isHuman ? 'awaiting_draw' : 'bot_thinking',
    botStep: nextPlayer.isHuman ? null : 'draw',
    lastActionLog: `${player.name} membuang ${CARD_DEFS[cardToDiscard.key].balineseName}.${waits.length > 0 ? ` (${player.name} sudah Nyari!)` : ''}`,
    history: nextHistory,
  };

  // Mencari (Mecari) boleh menyambar buangan untuk menang; Nyaga sesuai opsi (wajib ngupak atau bebas)
  const allowMejagaFromBuangan = (nextState.rules?.nyagaWinRule ?? 'ngupak_only') === 'free';
  const buanganWin = checkKupakNyariWinner(
    nextState,
    cardToDiscard,
    playerIdx,
    'Buangan',
    allowMejagaFromBuangan
  );
  if (buanganWin) return buanganWin;

  if (state.stock.length === 0) {
    return {
      ...nextState,
      currentPlayerIndex: playerIdx,
      phase: 'round_over',
      botStep: null,
      winnerId: null,
      winReason: 'Tumpukan habis — Babak berakhir Seri!',
      lastActionLog: `${player.name} membuang ${CARD_DEFS[cardToDiscard.key].balineseName}. Tumpukan habis!`,
    };
  }

  return nextState;
}

export function declareCeki(state: GameState, playerIndex = state.currentPlayerIndex): GameState {
  if (state.phase === 'round_over' || playerIndex !== state.currentPlayerIndex) {
    return state;
  }
  // Ngenen hanya boleh dari kupakan kartu tumpukan, tidak boleh dari hasil Ngejuk / buangan
  if (state.lastDrawSource === 'ngejuk') {
    return state;
  }
  const player = state.players[playerIndex];
  if (!player) return state;
  if (player.isHuman && state.phase !== 'awaiting_discard') return state;
  if (!player.isHuman && (state.phase !== 'bot_thinking' || state.botStep !== 'discard')) return state;

  const fullHand =
    player.isHuman && state.pendingDrawnCard
      ? [...player.hand, state.pendingDrawnCard]
      : player.hand;
  if (fullHand.length !== 12) return state;

  // Check Ngandang: self-drawn/self-opened winning card while already Mecari or Mejaga
  let isNgandang = false;
  let melds = findWinningMelds(fullHand, state.playStyle);
  const drawnCard =
    player.isHuman && state.pendingDrawnCard
      ? state.pendingDrawnCard
      : state.lastDrawnCardId
        ? player.hand.find((c) => c.id === state.lastDrawnCardId) ?? null
        : null;

  if (drawnCard) {
    const base11 = fullHand.filter((c) => c.id !== drawnCard.id);
    if (base11.length === 11) {
      const ready = getReadyStatus(base11, state.playStyle);
      const winRes = checkWinWithCard(base11, drawnCard, state.playStyle);
      if (ready.mode && winRes) {
        isNgandang = true;
        melds = winRes.melds;
      }
    }
  }
  if (!melds) return state;

  const updatedPlayers = state.players.map((p, idx) =>
    idx === playerIndex
      ? { ...p, hand: fullHand, score: p.score + 10, statusText: isNgandang ? 'NGANDANG!' : 'CEKI!' }
      : p
  );

  const styleLabel = isNgandang
    ? 'NGANDANG! (Ngupak Kartu Kemenangan Sendiri)'
    : state.playStyle === 'soca'
      ? 'Gaya Soca'
      : state.playStyle === 'serigat'
        ? 'Gaya Serigat'
        : '4 Susunan Lengkap';

  return {
    ...state,
    players: updatedPlayers,
    pendingDrawnCard: null,
    phase: 'round_over',
    botStep: null,
    winnerId: player.id,
    winKind: isNgandang ? 'ngandang' : 'ceki',
    winningMelds: melds,
    winReason: isNgandang
      ? `${player.name} NGANDANG! (Menang dari kartu yang diupak/ambil sendiri)`
      : `${player.name} menang Ngenen / Ceki! (${styleLabel})`,
    lastActionLog: isNgandang
      ? `🔥 ${player.name} NGANDANG pada Babak ${state.round}! (+10 poin)`
      : `${player.name} memenangkan Babak ${state.round} dengan CEKI! (+10 poin)`,
    history: [
      ...state.history,
      {
        round: state.round,
        actor: player.name,
        action: isNgandang ? 'Menang NGANDANG! 🔥' : `Menang CEKI! (${styleLabel})`,
      },
    ],
  };
}

/**
 * Returns the recommended card ID to discard for the Live Hint feature.
 */
export function getRecommendedDiscardId(
  hand12: CardInstance[],
  playStyle: PlayStyle = 'nyari',
  exposedCardIds: string[] = []
): string | null {
  if (hand12.length !== 12) return null;
  let bestId: string | null = null;
  let bestScore = -Infinity;

  for (let i = 0; i < hand12.length; i++) {
    const candidate = hand12[i];
    const remaining11 = hand12.filter((_, idx) => idx !== i);
    if (exposedCardIds.includes(candidate.id) && getReadyStatus(remaining11, playStyle).mode === null) {
      continue;
    }
    let score = evaluateHandScore(remaining11, playStyle);
    if (getNyagaWaits(remaining11, playStyle).length > 0) {
      score += 500;
    }
    if (score > bestScore) {
      bestScore = score;
      bestId = candidate.id;
    }
  }
  return bestId ?? hand12[0].id;
}
