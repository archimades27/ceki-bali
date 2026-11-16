# Ceki Bali — Spesifikasi animasi match

## Instruksi untuk Antigravity

Buka root proyek `ceki-bali` dan implementasikan spesifikasi ini pada TypeScript + Vite yang ada. Jalankan `npm test` dan `npm run build` sebelum dan sesudah perubahan. Baca `src/main.ts`, `src/game/{types,engine,bot}.ts`, `src/ui/cardRenderer.ts`, dan `src/style.css` sebelum menentukan titik integrasi. Gunakan aset muka kartu, punggung kartu dan meja mandala yang sudah ada. Pertahankan aturan Ceki, skor, mode Soca/Serigat/Nyari, susunan lima pemain, dan operasi offline.

## Arah visual

Gerakan kartu harus memperjelas asal dan tujuan. Saat saya mengambil kartu, saya ingin melihat kartu keluar dari tumpukan, sampai di area keputusan dekat tangan, lalu baru membaca mukanya. Saat bot membuang, saya ingin langsung tahu siapa yang membuang dan apakah kartu itu bisa di-Ngejuk. Pertahankan posisi tangan dan tombol selama perpindahan. Gunakan gerak meluncur singkat dengan perlambatan di akhir dan bayangan ringan. Gunakan sorotan tipis pada kartu tujuan. Nilai durasi di bawah adalah titik awal untuk diuji saat bermain.

| Aksi | Asal → tujuan | Tampilan | Durasi awal |
|---|---|---|---|
| Ambil dari stok, pemain | Tumpukan tengah → slot kartu pending dekat tangan | Punggung saat terbang. Flip dan buka muka setelah tiba. Tampilkan aksi pending di lokasi tetap. | 240 ms + flip 120 ms |
| Ngejuk, pemain | Kartu buangan terakhir yang sah → slot pending | Muka terlihat sepanjang lintasan. Hilangkan kartu dari tumpukan asal selama perpindahan. | 240 ms |
| Masukkan kartu pending | Slot pending → posisi aktual kartu dalam tangan | Muka terlihat. Ukur posisi setelah engine menerapkan urutan otomatis atau manual. Kartu tetangga bergeser pendek bila perlu. | 170 ms |
| Buang kartu dari tangan atau langsung | Kartu tangan atau slot pending → buangan pemain | Muka terlihat. Selama gerak, tujuan mempunyai ruang tetap. Sorot singkat kartu begitu tiba. | 220 ms |
| Bot ambil atau Ngejuk | Stok atau buangan sah → kursi bot aktif | Dari stok gunakan punggung saja. Saat Ngejuk, tampilkan muka yang sudah diketahui publik selama lintasan, lalu hilangkan kartu ketika masuk tangan bot. | 180–220 ms |
| Bot buang | Kursi bot aktif → buangan bot | Mulai dengan punggung dan buka muka saat mendarat. Perbarui penanda buangan terbaru setelah tiba. | 200 ms + flip 100 ms |
| Ceki dan ronde berikutnya | Kartu menang → ringkasan ronde. Stok → kursi untuk ronde baru | Prioritaskan keterbacaan kombinasi. Animasi pembagian kartu masuk tahap kedua, dalam kelompok per kursi dengan jeda singkat. | Ringkasan 160 ms. Pembagian total maksimal 700 ms. |

## Implementasi

1. **Kunci transisi engine.** Periksa guard pada `drawFromStock`, `ngejukDiscard`, `discardCard`, aksi pending, dan deklarasi Ceki. Aksi yang tidak sah mengembalikan state lama tanpa mengurangi stok, mengubah skor, atau menambah riwayat. Bedakan fase ambil dan buang bot secara eksplisit bila fase masih sama. Cocokkan perpindahan giliran human maupun bot sebelum memasang animasi. Tambahkan regresi untuk dua kali ambil dan buang sebelum ambil.
2. **Buat satu jalur dispatch untuk aksi kartu.** Handler manusia dan bot memakai transisi engine yang sama. Dari aksi yang diterima, gunakan ID kartu serta pemain asal dan tujuan untuk memilih animasi. Gunakan state sebelum dan sesudah aksi. Jangan mem-parsing teks riwayat dan jangan memakai nama jenis kartu sebagai ID karena kartu sejenis bisa muncul berkali-kali.
3. **Ukur sebelum dan sesudah render.** Beri penanda stabil untuk stok, kursi, slot pending, dan kartu per ID. Simpan rect asal lewat `getBoundingClientRect()` sebelum render. Commit state sekali, render tujuan, lalu ukur rect akhir. Letakkan proxy kartu pada overlay permanen langsung di bawah `body` dengan `position: fixed`, `pointer-events: none` dan `aria-hidden="true"`. Dengan begitu perspektif meja dan `app.innerHTML = ''` pada render saat ini tidak menghapus atau mendistorsi proxy. Sembunyikan visual tujuan sampai animasi selesai dan jaga ukuran slotnya. Jika kartu bot masuk tangan tersembunyi, gunakan kursi sebagai jangkar.
4. **Animasikan dengan Web Animations API.** Gunakan `transform` untuk posisi dan skala, serta `opacity` jika diperlukan. Pisahkan elemen yang bergerak dari elemen yang flip. Gunakan renderer kartu yang ada dan lindungi muka kartu bot yang belum terbuka. Bila koordinat tidak tersedia, API tidak tersedia, atau layout berubah karena resize, selesaikan langsung ke state akhir.
5. **Kelola satu urutan aksi per giliran.** Simpan token ronde/giliran untuk callback bot, timer, dan animasi. Selama kartu bergerak, nonaktifkan tombol gameplay dan interaksi drag yang berkonflik. Restart dan ganti mode boleh membatalkan animasi. Batalkan timer/proxy lama, pulihkan visibilitas tujuan melalui cleanup, dan abaikan callback yang tokennya sudah kedaluwarsa. Pindahkan penjadwalan aksi berikutnya ke completion yang juga berjalan saat animasi dilewati. Kurangi jeda buatan bot yang bertumpuk dengan animasi setelah alur teruji.
6. **Aksesibilitas dan audio.** Hormati `prefers-reduced-motion` dengan perpindahan seketika dan sorotan singkat tanpa flip. Jaga fokus tombol setelah render. Umumkan hasil aksi lewat status yang sudah ada bila dapat dipakai sebagai `aria-live`. Gunakan efek suara saat aksi sah selesai secara visual, satu kali per aksi, termasuk bila reduced motion aktif. Callback yang dibatalkan tidak memutar audio.

## Urutan delivery

- **Tahap 1:** Guard engine, dispatch dan overlay, ambil pemain, Ngejuk, keputusan pending dan buang.
- **Tahap 2:** Sambungkan bot, sinkronkan sorotan giliran dan kartu buangan, lalu perhalus perpindahan menuju ringkasan Ceki dan pembagian ronde. Integrasikan kedua tahap sebelum menyatakan pekerjaan selesai.

## Kriteria penerimaan

- [ ] Ambil dari stok mengurangi stok tepat satu dan membuka kartu pending tepat satu kali.
- [ ] Ngejuk mengambil ID kartu buangan yang sah, memperbarui tumpukan sumber, dan mempertahankan muka publik.
- [ ] Masukkan ke tangan mendarat pada slot yang benar dalam mode urutan otomatis maupun manual. Buang langsung dan buang dari tangan masing-masing memindahkan satu kartu.
- [ ] Bot mengambil tanpa membocorkan kartu stok. Bot membuang ke kursi pemiliknya dan giliran berikutnya berjalan sekali.
- [ ] Klik ganda, aksi ilegal, dan restart atau ganti mode saat animasi berlangsung tidak membuat kartu hilang, stok berkurang dua kali, atau timer lama memproses ronde baru.
- [ ] Bila Ceki bisa dinyatakan dengan kartu pending, animasi tiba lalu aksi Ceki tersedia dan skor diberikan tepat sekali.
- [ ] Resize di tengah gerakan, pilihan reduced motion, dan kondisi tanpa API animasi tetap memperlihatkan state akhir serta memungkinkan langkah berikutnya.
- [ ] Uji di browser desktop, jendela macOS/WKWebView yang diperkecil, dan iPad landscape atau viewport sentuh ekuivalen. Periksa clipping, ketepatan titik tiba, dan kontrol setelah animasi. Sebutkan perangkat mana yang benar-benar digunakan.
- [ ] `npm test` dan `npm run build` lulus. Tambahkan regresi engine untuk aksi ilegal dan skenario pergantian giliran yang tersentuh. Laporkan perubahan file, hasil verifikasi, dan pengujian perangkat yang belum dilakukan.
