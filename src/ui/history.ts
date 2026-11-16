import type { HistoryEntry } from '../game/types.ts';

export class HistoryModal {
  private overlay: HTMLElement;

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay hidden';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.body.appendChild(this.overlay);
  }

  public open(entries: HistoryEntry[]): void {
    this.render(entries);
    this.overlay.classList.remove('hidden');
  }

  public close(): void {
    this.overlay.classList.add('hidden');
  }

  private render(entries: HistoryEntry[]): void {
    this.overlay.innerHTML = '';

    const modal = document.createElement('div');
    modal.className = 'history-modal';

    const header = document.createElement('div');
    header.className = 'tutorial-header';
    header.innerHTML = `
      <div>
        <div class="tutorial-subtitle">Catatan Meja</div>
        <h2 class="tutorial-title">Riwayat Permainan (${entries.length} aksi)</h2>
      </div>
      <button class="btn-icon-close" aria-label="Tutup riwayat">✕</button>
    `;
    header.querySelector('.btn-icon-close')?.addEventListener('click', () => this.close());
    modal.appendChild(header);

    const list = document.createElement('div');
    list.className = 'history-list';

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'Belum ada catatan permainan.';
      list.appendChild(empty);
    } else {
      // Show newest actions at the top
      const reversed = [...entries].reverse();
      for (const item of reversed) {
        const row = document.createElement('div');
        row.className = `history-row ${item.actor === 'Anda' ? 'is-human' : item.actor === 'Sistem' ? 'is-system' : ''}`;
        row.innerHTML = `
          <span class="history-round">B${item.round}</span>
          <span class="history-actor">${item.actor}</span>
          <span class="history-action">${item.action}</span>
          ${item.cardName ? `<span class="history-card">${item.cardName}</span>` : ''}
        `;
        list.appendChild(row);
      }
    }

    modal.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'history-footer';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-gold';
    closeBtn.textContent = 'Tutup';
    closeBtn.addEventListener('click', () => this.close());
    footer.appendChild(closeBtn);
    modal.appendChild(footer);

    this.overlay.appendChild(modal);
  }
}
