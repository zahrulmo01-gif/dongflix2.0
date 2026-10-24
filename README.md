# 🎬 Dongflix - Platform Streaming Donghua Subtitle Indonesia

**Dongflix** adalah platform web streaming donghua (animasi China) modern yang dirancang ringan, responsif, dan kaya fitur visual dengan sentuhan gaya iOS Glassmorphism. Proyek ini mengintegrasikan otomasi scraping berkala, sistem analitik penayangan harian/total berbasis Firebase Realtime Database, serta panel kontrol administrator.

---

## ✨ Fitur Utama

- **Desain Modern (iOS Glassmorphism):**
  - *Floating Pill Header* dengan efek blur kaca dan aksen *pip light*.
  - Logo lokal terpadu (`image/IMG_6395.png`) dengan tipografi kustom (*Outfit* & *Plus Jakarta Sans*).
  - Tampilan *Hero Banner Slider* sinematik di halaman utama.

- **Katalog Lengkap & Ringan:**
  - Paginasi cerdas *load-more* (18 item per muat) untuk performa optimal.
  - Filter interaktif berdasarkan status (*Ongoing*, *Tamat*), tipe (*Series*, *Movie*), dan kategori/genre.
  - Pencarian instan (*instant search modal*) dengan debounce.

- **Pemutar Video & Detail Episode:**
  - Dukungan multi-server pemutaran video dengan tooltip panduan visual.
  - Opsi pengurutan daftar episode (Terlama / Terbaru) dan modal *full episode list*.
  - Indikator gradasi halus dinamis pada baris gulir episode.
  - **Rekomendasi Cerdas:** Rekomendasi 15 judul donghua serupa berdasarkan kesamaan genre di bawah pemutar.
  - Sinkronisasi riwayat tontonan (*Continue Watching*) yang tersimpan di penyimpanan lokal browser.

- **Analitik Penayangan Terintegrasi (Firebase Realtime Database):**
  - **Views Total:** Akumulasi penayangan keseluruhan per donghua (`views_total/{slug}`).
  - **Views Daily:** Penayangan harian dinamis (`views_daily/{YYYY-MM-DD}/{slug}`) untuk menentukan peringkat **Populer Hari Ini**.
  - Badge jumlah tayangan dengan ikon mata langsung di poster cover.

- **Panel Administrator & Otomasi:**
  - Panel kontrol mandiri untuk memicu alur kerja scraping langsung ke GitHub Actions via `repository_dispatch`.
  - Manajemen katalog, pembersihan data rusak (*fix null & duplicate*), dan pembaruan metadata detail manual.
  - Monitor log eksekusi runner terintegrasi.

---

## 📁 Struktur Direktori

```text
├── admin/
│   ├── clean-json.js             # Skrip pembersih format JSON
│   ├── index.html                # Panel dashboard kontrol administrator
│   ├── scrape-all-smart.js       # Smart delta-scraper otomatis
│   ├── scraper-episodes.js       # Scraper khusus detail daftar episode
│   └── scraper.js                # Scraper utama katalog donghua
├── assets/
│   └── firebase-config.js        # Konfigurasi modular Firebase SDK (Auth, DB)
├── donghua/
│   ├── index.html                # Halaman katalog lengkap dengan tombol muat bertahap
│   └── watch.html                # Halaman pemutar video, episode, views & komentar
├── image/
│   └── IMG_6395.png              # Aset logo dan favicon web utama
├── index.html                    # Halaman beranda utama
└── README.md                     # Dokumentasi repositori
