import type { CardKey } from '../game/types.ts';
import { renderCardBack, renderClassicCard } from './cardRenderer.ts';

export interface FlightSpec {
  sourceRect: DOMRect | null;
  destEl: HTMLElement | null;
  destRect?: DOMRect | null;
  faceKey?: CardKey;
  startWithBack: boolean;
  flipOnArrive: boolean;
  spinOnArrive?: boolean;
  smallCard: boolean;
  flightMs: number;
  flipMs?: number;
  fadeIntoDest?: boolean;
  hideDestDuringFlight?: boolean;
  highlightOnLand?: boolean;
}

export class MatchAnimator {
  private overlay: HTMLElement;
  private epoch = 0;
  private activeAnims: Animation[] = [];
  private activeTimers: number[] = [];
  private hiddenEls: HTMLElement[] = [];
  private displayNoneEls: HTMLElement[] = [];
  private pendingComplete: (() => void) | null = null;
  private _isAnimating = false;

  constructor() {
    let existing = document.getElementById('card-anim-overlay');
    if (!existing) {
      existing = document.createElement('div');
      existing.id = 'card-anim-overlay';
      existing.className = 'card-anim-overlay';
      existing.setAttribute('aria-hidden', 'true');
      document.body.appendChild(existing);
    }
    this.overlay = existing;

    window.addEventListener('resize', () => {
      if (this._isAnimating) {
        this.finishImmediately();
      }
    });
  }

  get isAnimating(): boolean {
    return this._isAnimating;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  prefersReducedMotion(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  hasWaapi(): boolean {
    return typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.animate === 'function';
  }

  /**
   * Cancels all running animations and timers without invoking completion callbacks.
   * Used on restart / new round / mode switch.
   */
  cancel(): void {
    this.epoch++;
    this.pendingComplete = null;
    this.cleanupVisuals();
  }

  /**
   * Finishes any in-flight animation immediately to its final state (e.g. on window resize)
   * and invokes its completion callback once.
   */
  finishImmediately(): void {
    const done = this.pendingComplete;
    this.epoch++;
    this.pendingComplete = null;
    this.cleanupVisuals();
    if (done) done();
  }

  private cleanupVisuals(): void {
    for (const anim of this.activeAnims) {
      try {
        anim.cancel();
      } catch {
        // Ignore already finished animations
      }
    }
    this.activeAnims = [];

    for (const tid of this.activeTimers) {
      window.clearTimeout(tid);
    }
    this.activeTimers = [];

    for (const el of this.hiddenEls) {
      el.style.visibility = '';
    }
    this.hiddenEls = [];

    for (const el of this.displayNoneEls) {
      el.style.display = '';
    }
    this.displayNoneEls = [];

    document.querySelectorAll('.human-hand-row.is-dealing, .table-felt.is-dealing').forEach((el) => {
      el.classList.remove('is-dealing');
    });

    this.overlay.innerHTML = '';
    this._isAnimating = false;
  }

  private trackTimer(fn: () => void, ms: number, myEpoch: number): void {
    const tid = window.setTimeout(() => {
      if (myEpoch !== this.epoch) return;
      fn();
    }, ms);
    this.activeTimers.push(tid);
  }

  private pulseLanded(el: HTMLElement | null): void {
    if (!el || this.prefersReducedMotion()) return;
    el.classList.add('anim-card-landed');
    const myEpoch = this.epoch;
    this.trackTimer(() => {
      if (myEpoch === this.epoch) {
        el.classList.remove('anim-card-landed');
      }
    }, 340, myEpoch);
  }

  runFlight(spec: FlightSpec, onComplete: () => void): void {
    const myEpoch = this.epoch;
    const destRect = spec.destRect ?? spec.destEl?.getBoundingClientRect() ?? null;

    const completeOnce = () => {
      if (myEpoch !== this.epoch) return;
      this.pendingComplete = null;
      this.cleanupVisuals();
      if (spec.highlightOnLand) {
        this.pulseLanded(spec.destEl);
      }
      onComplete();
    };

    if (
      this.prefersReducedMotion() ||
      !this.hasWaapi() ||
      !spec.sourceRect ||
      !destRect ||
      spec.sourceRect.width === 0 ||
      destRect.width === 0
    ) {
      if (spec.destEl) {
        spec.destEl.style.visibility = '';
      }
      if (spec.highlightOnLand && spec.destEl) {
        spec.destEl.classList.add('anim-card-landed-instant');
        this.trackTimer(() => {
          spec.destEl?.classList.remove('anim-card-landed-instant');
        }, 260, myEpoch);
      }
      onComplete();
      return;
    }

    this._isAnimating = true;
    this.pendingComplete = completeOnce;

    if (spec.hideDestDuringFlight !== false && spec.destEl) {
      spec.destEl.style.visibility = 'hidden';
      this.hiddenEls.push(spec.destEl);
    }

    // Build proxy mover (position + scale + opacity) and inner flipper (rotateY)
    const mover = document.createElement('div');
    mover.className = 'anim-proxy-mover';
    const w = destRect.width;
    const h = destRect.height;
    mover.style.width = `${w}px`;
    mover.style.height = `${h}px`;

    const flipper = document.createElement('div');
    flipper.className = 'anim-proxy-flipper';

    const renderContent = (showBack: boolean): HTMLElement => {
      if (showBack || !spec.faceKey) {
        const back = renderCardBack('vertical', false);
        back.style.width = '100%';
        back.style.height = '100%';
        return back;
      }
      const card = renderClassicCard(spec.faceKey, { small: spec.smallCard });
      card.style.width = '100%';
      card.style.height = '100%';
      return card;
    };

    flipper.appendChild(renderContent(spec.startWithBack));
    mover.appendChild(flipper);
    this.overlay.appendChild(mover);

    const startCenterX = spec.sourceRect.left + spec.sourceRect.width / 2;
    const startCenterY = spec.sourceRect.top + spec.sourceRect.height / 2;
    const endCenterX = destRect.left + destRect.width / 2;
    const endCenterY = destRect.top + destRect.height / 2;

    const startX = startCenterX - w / 2;
    const startY = startCenterY - h / 2;
    const endX = endCenterX - w / 2;
    const endY = endCenterY - h / 2;

    const scaleX = Math.max(0.45, Math.min(1.4, spec.sourceRect.width / w));
    const scaleY = Math.max(0.45, Math.min(1.4, spec.sourceRect.height / h));

    const endScale = spec.fadeIntoDest ? 0.62 : 1;
    const endOpacity = spec.fadeIntoDest ? 0.15 : 1;

    const moveAnim = mover.animate(
      [
        {
          transform: `translate3d(${startX}px, ${startY}px, 0) scale(${scaleX}, ${scaleY})`,
          opacity: 0.96,
        },
        {
          transform: `translate3d(${endX}px, ${endY}px, 0) scale(${endScale}, ${endScale})`,
          opacity: endOpacity,
        },
      ],
      {
        duration: spec.flightMs,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'forwards',
      }
    );
    this.activeAnims.push(moveAnim);

    moveAnim.finished
      .then(() => {
        if (myEpoch !== this.epoch) return;
        if (!spec.flipOnArrive || !spec.faceKey) {
          if (spec.spinOnArrive && spec.faceKey) {
            const spinAnim = flipper.animate(
              [
                { transform: 'perspective(700px) rotateY(0deg) scale(1)' },
                { transform: 'perspective(700px) rotateY(180deg) scale(1.08)' },
                { transform: 'perspective(700px) rotateY(360deg) scale(1)' },
              ],
              { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }
            );
            this.activeAnims.push(spinAnim);
            spinAnim.finished
              .then(() => {
                if (myEpoch === this.epoch) completeOnce();
              })
              .catch(() => {});
            return;
          }
          completeOnce();
          return;
        }

        const totalFlip = spec.flipMs ?? 120;
        const halfFlip = Math.max(40, Math.round(totalFlip / 2));

        const flipOut = flipper.animate(
          [
            { transform: 'perspective(700px) rotateY(0deg) scale(1)' },
            { transform: 'perspective(700px) rotateY(90deg) scale(1.06)' },
          ],
          { duration: halfFlip, easing: 'ease-in', fill: 'forwards' }
        );
        this.activeAnims.push(flipOut);

        flipOut.finished
          .then(() => {
            if (myEpoch !== this.epoch) return;
            flipper.innerHTML = '';
            flipper.appendChild(renderContent(false));
            const endDeg = spec.spinOnArrive ? '360deg' : '0deg';
            const flipIn = flipper.animate(
              [
                { transform: 'perspective(700px) rotateY(90deg) scale(1.06)' },
                { transform: `perspective(700px) rotateY(${endDeg}) scale(1)` },
              ],
              {
                duration: spec.spinOnArrive ? 240 : halfFlip,
                easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                fill: 'forwards',
              }
            );
            this.activeAnims.push(flipIn);
            return flipIn.finished;
          })
          .then(() => {
            if (myEpoch !== this.epoch) return;
            completeOnce();
          })
          .catch(() => {
            // Cancelled via epoch/resize
          });
      })
      .catch(() => {
        // Cancelled via epoch/resize
      });
  }

  /**
   * One-by-one card dealing animation from stock to all 5 seats (11 cards each = 55 cards),
   * revealing human hand cards one-by-one as each dealt card lands.
   */
  runRoundDeal(
    stockEl: HTMLElement | null,
    seatTargets: (HTMLElement | null)[],
    humanHandCards: HTMLElement[] = [],
    onStepSound?: (cardIndex: number) => void,
    onComplete?: () => void
  ): void {
    const myEpoch = this.epoch;
    if (this.prefersReducedMotion() || !this.hasWaapi() || !stockEl || seatTargets.length === 0) {
      onComplete?.();
      return;
    }
    const stockRect = stockEl.getBoundingClientRect();
    if (stockRect.width === 0) {
      onComplete?.();
      return;
    }

    this._isAnimating = true;
    const w = 44;
    const h = 100;
    const sx = stockRect.left + stockRect.width / 2 - w / 2;
    const sy = stockRect.top + stockRect.height / 2 - h / 2;

    const handRowEl = document.querySelector('.human-hand-row') as HTMLElement | null;
    if (handRowEl) {
      handRowEl.classList.add('is-dealing');
    }
    const tableEl = document.querySelector('.table-felt') as HTMLElement | null;
    if (tableEl) {
      tableEl.classList.add('is-dealing');
    }

    // Keep exact left-to-right slot geometry while visually empty (visibility: hidden)
    for (const cardEl of humanHandCards) {
      cardEl.style.visibility = 'hidden';
      this.hiddenEls.push(cardEl);
    }

    // Initialize bot card counts to 0 and stock count to 120 so table starts empty
    const botCounts = new Map<HTMLElement, number>();
    const setBotCountText = (targetEl: HTMLElement, count: number) => {
      const sub = targetEl.querySelector('.bot-sub');
      if (!sub || !sub.textContent) return;
      sub.textContent = sub.textContent.replace(/\d+\s*kartu/, `${count} kartu`);
    };
    seatTargets.forEach((t) => {
      if (t && !t.classList.contains('human-hand-row')) {
        botCounts.set(t, 0);
        setBotCountText(t, 0);
      }
    });
    const stockBadge = stockEl.parentElement?.querySelector('.stock-count-badge') as HTMLElement | null;
    const finalStockText = stockBadge?.textContent ?? null;
    let remainingDeck = 120;
    if (stockBadge) {
      stockBadge.textContent = String(remainingDeck);
    }

    const totalRounds = 11;
    const staggerMs = 55;
    const flightMs = 260;
    const totalCards = totalRounds * seatTargets.length;
    let humanCardIdx = 0;

    this.pendingComplete = () => {
      if (myEpoch !== this.epoch) return;
      this.pendingComplete = null;
      if (stockBadge && finalStockText !== null) {
        stockBadge.textContent = finalStockText;
      }
      this.cleanupVisuals();
      onComplete?.();
    };

    for (let roundIdx = 0; roundIdx < totalRounds; roundIdx++) {
      seatTargets.forEach((target, seatOrderIdx) => {
        const cardSeq = roundIdx * seatTargets.length + seatOrderIdx;
        const delay = cardSeq * staggerMs;
        const isHumanTarget = target?.classList.contains('human-hand-row') ?? false;
        const assignedHumanEl = isHumanTarget ? humanHandCards[humanCardIdx++] ?? null : null;

        if (!target) return;

        this.trackTimer(() => {
          if (myEpoch !== this.epoch) return;

          const tRect = assignedHumanEl
            ? assignedHumanEl.getBoundingClientRect()
            : target.getBoundingClientRect();
          if (tRect.width === 0) return;

          if (stockBadge) {
            remainingDeck = Math.max(0, remainingDeck - 1);
            stockBadge.textContent = String(remainingDeck);
          }

          const tx = tRect.left + tRect.width / 2 - w / 2;
          const ty = tRect.top + tRect.height / 2 - h / 2;

          const proxy = document.createElement('div');
          proxy.className = 'anim-proxy-mover';
          proxy.style.width = `${w}px`;
          proxy.style.height = `${h}px`;
          proxy.style.opacity = '0';
          const back = renderCardBack('vertical', false);
          back.style.width = '100%';
          back.style.height = '100%';
          proxy.appendChild(back);
          this.overlay.appendChild(proxy);

          if (onStepSound && cardSeq % 2 === 0) {
            onStepSound(cardSeq);
          }

          const startRot = (seatOrderIdx - 2) * 5;
          const anim = proxy.animate(
            [
              {
                transform: `translate3d(${sx}px, ${sy}px, 0) scale(0.88) rotate(${startRot}deg)`,
                opacity: 0.98,
              },
              {
                transform: `translate3d(${(sx + tx) / 2}px, ${(sy + ty) / 2 - 14}px, 0) scale(1.0) rotate(${startRot * 0.35}deg)`,
                opacity: 1,
                offset: 0.55,
              },
              {
                transform: `translate3d(${tx}px, ${ty}px, 0) scale(${isHumanTarget ? 0.96 : 0.78}) rotate(0deg)`,
                opacity: isHumanTarget ? 1 : 0.9,
              },
            ],
            {
              duration: flightMs,
              easing: 'cubic-bezier(0.2, 0.85, 0.32, 1)',
              fill: 'forwards',
            }
          );
          this.activeAnims.push(anim);
          anim.finished
            .then(() => {
              if (myEpoch !== this.epoch) {
                proxy.remove();
                return;
              }
              if (assignedHumanEl) {
                assignedHumanEl.style.visibility = '';
                assignedHumanEl.classList.add('anim-card-deal-pop');
                this.trackTimer(() => {
                  assignedHumanEl.classList.remove('anim-card-deal-pop');
                }, 220, myEpoch);
              } else if (botCounts.has(target)) {
                const nextCount = (botCounts.get(target) ?? 0) + 1;
                botCounts.set(target, nextCount);
                setBotCountText(target, nextCount);
              }
              proxy.remove();
            })
            .catch(() => {
              proxy.remove();
            });
        }, delay, myEpoch);
      });
    }

    const totalDuration = (totalCards - 1) * staggerMs + flightMs + 100;
    this.trackTimer(() => {
      this.pendingComplete?.();
    }, totalDuration, myEpoch);
  }

  /**
   * Short delay (160ms) to highlight winning Ceki state before modal opens.
   */
  runCekiPause(onComplete: () => void): void {
    if (this.prefersReducedMotion()) {
      onComplete();
      return;
    }
    const myEpoch = this.epoch;
    this._isAnimating = true;
    this.pendingComplete = () => {
      if (myEpoch !== this.epoch) return;
      this.pendingComplete = null;
      this.cleanupVisuals();
      onComplete();
    };
    this.trackTimer(() => {
      this.pendingComplete?.();
    }, 160, myEpoch);
  }
}
