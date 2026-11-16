# Cara Memasang & Bermain Ceki Bali di Steam Deck (SteamOS)

Game ini sudah dioptimalkan untuk layar **1280×800** Steam Deck, mendukung **Touchscreen** maupun **Kontroler Steam Deck (Gamepad)**, dan berjalan **100% offline**.

## Langkah Instalasi

1. **Salin & Ekstrak**
   Pindahkan `Ceki-Bali-SteamDeck.tar.gz` ke Steam Deck (misalnya ke `/home/deck/Games/`), lalu ekstrak di **Desktop Mode**:
   ```bash
   mkdir -p ~/Games && tar -xzf Ceki-Bali-SteamDeck.tar.gz -C ~/Games/
   ```
   *(Pastikan ada satu browser terpasang di Desktop Mode, misalnya Chrome, Chromium, Edge, atau Firefox dari Discover Store).*

2. **Tambahkan ke Steam (Non-Steam Game)**
   - Buka **Steam** di Desktop Mode → **Games** → **Add a Non-Steam Game to My Library...** → **Browse...**
   - Pilih `/home/deck/Games/ceki-bali-steamdeck/launch-steamdeck.sh` *(ubah filter file ke `All Files` jika perlu)*.
   - Klik kanan **Ceki Bali** → **Properties** → ubah nama menjadi `Ceki Bali` dan pasang ikon `icon.png` jika diinginkan.

3. **Mainkan di Gaming Mode**
   - Kembali ke **Gaming Mode** → jalankan **Ceki Bali**.
   - Jika menggunakan browser Flatpak di Gaming Mode, pastikan izin Flatpak mengizinkan akses jaringan lokal atau gunakan template kontroler **Gamepad with Joystick Trackpad**.

## Kontrol Steam Deck (Gamepad)
- **D-Pad / Analog Kiri**: Pilih kartu di tangan
- **Tombol A**: Ambil kartu dari Tumpukan / Masukkan ke Tangan / Buang kartu terpilih
- **Tombol X**: Ngejuk / Buang Langsung kartu baru
- **Tombol Y**: Deklarasi **Ceki!**
- **LB / RB**: Atur Posisi / Susun Otomatis
- **Select (View)**: Buka / Tutup Riwayat Meja
- **Start (Menu)**: Buka / Tutup Panduan
