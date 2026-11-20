import { renderClassicCard } from './cardRenderer.ts';
import type { CardKey } from '../game/types.ts';

interface TutorialStep {
  title: string;
  subtitle: string;
  body: string;
  showcaseTitle: string;
  cards: { key: CardKey; caption?: string }[];
  tip: string;
}

const STEPS: TutorialStep[] = [
  {
    title: 'Selamat Datang di Ceki Bali (5 Pemain)',
    subtitle: 'Langkah 1 dari 5 — Dek Klasik 120 Kartu',
    body: 'Permainan Ceki Bali dimainkan oleh 5 orang (Anda + Made, Nyoman, Ketut, Wayan). Satu set terdiri dari 120 kartu (30 gambar klasik Bali, masing-masing 4 lembar).',
    showcaseTitle: 'Contoh Kartu Klasik & Nama Balinya (Arahkan kursor untuk melihat nama)',
    cards: [
      { key: 'tong1', caption: 'Gunung' },
      { key: 'sok3', caption: 'Dengkek' },
      { key: 'ban5', caption: 'Polak' },
      { key: 'white_flower', caption: 'Cine' },
      { key: 'red_flower', caption: 'Kinci' },
      { key: 'old_thousand', caption: 'Kobar' },
    ],
    tip: 'Kartu buangan setiap pemain diletakkan di sebelah KANAN pemain tersebut.',
  },
  {
    title: 'Susunan Kartu: Soca, Serigat & Lawang',
    subtitle: 'Langkah 2 dari 5 — Menyusun Kartu',
    body: 'Susun 12 kartu menjadi 4 kelompok (masing-masing 3 kartu): Soca (3 kartu sama), Serigat (3 kartu satu baris sekutu, misal Gade–Teje–Jering), atau Lawang (2 kartu sama + 1 kartu yang sama ekor/keluarganya, misal 2 Gade + 1 Teje).',
    showcaseTitle: 'Soca (3 Sama) • Serigat (Sekutu) • Lawang (2 Sama + 1 Se-ekor)',
    cards: [
      { key: 'tong4', caption: 'Soca' },
      { key: 'tong4', caption: 'Soca' },
      { key: 'tong4', caption: 'Soca' },
      { key: 'tong9', caption: 'Gade (Lawang)' },
      { key: 'tong9', caption: 'Gade (Lawang)' },
      { key: 'sok9', caption: 'Teje (Se-ekor)' },
    ],
    tip: 'Di Ceki Bali tidak ada seri angka berurutan. Anda bebas mengombinasikan Soca, Serigat, dan Lawang untuk mencapai 4 susunan lengkap (Ceki!).',
  },
  {
    title: 'Giliran Anda: Ambil atau Ngejuk',
    subtitle: 'Langkah 3 dari 5 — Mendapat Kartu ke-12',
    body: 'Pada giliran Anda, ambil 1 kartu terlebih dahulu: klik "Ambil" (tumpukan tengah), ATAU klik "Ngejuk" untuk mengambil kartu buangan terakhir. Kartu hasil Ngejuk (Jukjukan) harus tetap TERBUKA agar dilihat semua pemain, dan tidak boleh dibuang kecuali untuk Nyari.',
    showcaseTitle: 'Contoh: Ngejuk Kartu Buangan untuk Melengkapi Serigat',
    cards: [
      { key: 'tong1', caption: 'Gunung' },
      { key: 'sok1', caption: 'Jarum' },
      { key: 'ban1', caption: 'Ngejuk Jebung 3!' },
    ],
    tip: 'Aturan Ngutang-Ngejuk: Anda tidak boleh mengejuk kartu yang sama persis dengan kartu yang baru saja Anda buang pada giliran sebelumnya.',
  },
  {
    title: 'Mencari (Mecari) vs Nyaga (Mejaga)',
    subtitle: 'Langkah 4 dari 6 — Menang dari Ngupak vs Buangan',
    body: 'Mecari (1 Soca + 2 Serigat/Lawang + 2 Cecarian) BOLEH menang baik dari Ngupak maupun menyambar Buangan lawan (prioritas jarak terdekat searah putaran / ilehan). Sebaliknya, Nyaga (2 Soca + 1 Serigat/Lawang + 2 Jejagan) HANYA boleh menang dari Ngupak sendiri — dilarang menyambar buangan!',
    showcaseTitle: 'Contoh Posisi Nyari (Menunggu 1 kartu penutup)',
    cards: [
      { key: 'tong2', caption: 'Cawang' },
      { key: 'tong2', caption: 'Tunggu Cawang!' },
    ],
    tip: 'Aktifkan tombol "Saran" di bilah atas jika ingin melihat rekomendasi kartu terbaik untuk dibuang.',
  },
  {
    title: 'Menurunkan Kartu & Pelanggaran (Nongong)',
    subtitle: 'Langkah 5 dari 6 — Jukjukan Terbuka & Aturan Meja',
    body: 'Hanya kartu hasil Ngejuk (Jukjukan) yang wajib diletakkan terbuka di meja agar dilihat semua pemain; kartu sepadan di tangan tetap tertutup. Saat menang (Ngenen), semua 12 kartu dibuka rapi untuk diperiksa.',
    showcaseTitle: 'Contoh Jukjukan Terbuka di Meja',
    cards: [
      { key: 'tong4', caption: 'Jukjukan' },
    ],
    tip: 'Pelanggaran (Nongong): menyambar buangan saat posisi Nyaga (jika opsi Wajib Ngupak aktif), susunan 12 kartu tidak valid, atau Ngutang-Ngejuk.',
  },
  {
    title: 'Serukan "Ceki!" (Ngenen)',
    subtitle: 'Langkah 6 dari 6 — Memenangkan Babak',
    body: 'Begitu 12 kartu di tangan membentuk 4 susunan lengkap sesuai gaya bermain yang dipilih, tombol emas "Ceki!" akan menyala! Klik untuk mengakhiri babak dan meraih +10 poin.',
    showcaseTitle: 'Siap Bermain Melawan Made, Nyoman, Ketut, dan Wayan!',
    cards: [
      { key: 'white_flower', caption: 'Cine' },
      { key: 'red_flower', caption: 'Kinci' },
      { key: 'old_thousand', caption: 'Kobar!' },
    ],
    tip: 'Anda bisa membuka panduan ini kapan saja melalui tombol "? Panduan" di pojok kanan atas. Selamat meceki!',
  },
];

export class TutorialModal {
  private overlay: HTMLElement;
  private stepIndex = 0;
  private onClose?: () => void;

  constructor(onClose?: () => void) {
    this.onClose = onClose;
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay hidden';
    document.body.appendChild(this.overlay);
  }

  public open(startStep = 0): void {
    this.stepIndex = startStep;
    this.render();
    this.overlay.classList.remove('hidden');
  }

  public close(): void {
    this.overlay.classList.add('hidden');
    this.onClose?.();
  }

  private render(): void {
    const step = STEPS[this.stepIndex];
    this.overlay.innerHTML = '';

    const modal = document.createElement('div');
    modal.className = 'tutorial-modal';

    const header = document.createElement('div');
    header.className = 'tutorial-header';
    header.innerHTML = `
      <div>
        <div class="tutorial-subtitle">${step.subtitle}</div>
        <h2 class="tutorial-title">${step.title}</h2>
      </div>
      <button class="btn-icon-close" aria-label="Tutup panduan">✕</button>
    `;
    header.querySelector('.btn-icon-close')?.addEventListener('click', () => this.close());
    modal.appendChild(header);

    const progress = document.createElement('div');
    progress.className = 'tutorial-progress';
    progress.innerHTML = `<div class="tutorial-progress-bar" style="width: ${((this.stepIndex + 1) / STEPS.length) * 100}%"></div>`;
    modal.appendChild(progress);

    const body = document.createElement('p');
    body.className = 'tutorial-body';
    body.textContent = step.body;
    modal.appendChild(body);

    const showcase = document.createElement('div');
    showcase.className = 'tutorial-showcase';
    const scTitle = document.createElement('div');
    scTitle.className = 'tutorial-showcase-title';
    scTitle.textContent = step.showcaseTitle;
    showcase.appendChild(scTitle);

    const cardsRow = document.createElement('div');
    cardsRow.className = 'tutorial-cards-row';
    for (const item of step.cards) {
      const wrap = document.createElement('div');
      wrap.className = 'tutorial-card-item';
      wrap.appendChild(renderClassicCard(item.key, { small: true }));
      if (item.caption) {
        const cap = document.createElement('span');
        cap.className = 'tutorial-card-caption';
        cap.textContent = item.caption;
        wrap.appendChild(cap);
      }
      cardsRow.appendChild(wrap);
    }
    showcase.appendChild(cardsRow);
    modal.appendChild(showcase);

    const tip = document.createElement('div');
    tip.className = 'tutorial-tip';
    tip.innerHTML = `<strong>Tips:</strong> ${step.tip}`;
    modal.appendChild(tip);

    const footer = document.createElement('div');
    footer.className = 'tutorial-footer';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'btn btn-secondary';
    prevBtn.textContent = '← Sebelumnya';
    prevBtn.disabled = this.stepIndex === 0;
    prevBtn.addEventListener('click', () => {
      if (this.stepIndex > 0) {
        this.stepIndex--;
        this.render();
      }
    });

    const skipBtn = document.createElement('button');
    skipBtn.className = 'btn btn-ghost';
    skipBtn.textContent = 'Lewati';
    skipBtn.addEventListener('click', () => this.close());

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn btn-gold';
    nextBtn.textContent = this.stepIndex === STEPS.length - 1 ? 'Mulai Bermain!' : 'Lanjut →';
    nextBtn.addEventListener('click', () => {
      if (this.stepIndex < STEPS.length - 1) {
        this.stepIndex++;
        this.render();
      } else {
        this.close();
      }
    });

    footer.append(prevBtn, skipBtn, nextBtn);
    modal.appendChild(footer);

    this.overlay.appendChild(modal);
  }
}
