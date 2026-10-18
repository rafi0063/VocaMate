# VocaMate

Ekstensi peramban berbasis Chromium yang menyediakan asisten percakapan suara AI secara hands-free. Dokumen acuan: SRS dan SDD VocaMate v1.3.

VocaMate adalah ekstensi Chrome yang bisa dipakai buat ngobrol dengan AI lewat suara. Kamu cukup bicara, lalu AI menjawab dengan suara juga, jadi tidak perlu pencet tombol setiap giliran. Obrolannya tetap jalan walaupun kamu pindah tab atau lagi buka website lain.

AI-nya punya tiga persona, yaitu Teman, Pacar Virtual, dan Mentor, dengan gaya bicara yang berbeda. Kalau perlu, AI juga bisa diminta membaca isi layar, misalnya untuk menjelaskan halaman yang sedang dibuka.

Pemakaiannya dibatasi kuota waktu bicara. Rencananya ada paket Free dan Premium (suara lebih ekspresif, kustomisasi kepribadian, dan memori jangka panjang), tapi bagian Premium belum dikerjakan di prototype ini.

Repo ini masih prototype untuk UTS, dibuat berdasarkan SRS dan SDD v1.3 yang ada di folder Docs. Dibuat dengan Chrome Extension (Manifest V3), Node.js + Express, MySQL, dan Gemini.

## Struktur

| Folder | Isi |
|---|---|
| `Database/` | `Create_table.sql` (skema) dan `Insert.sql` (data awal: paket Free, persona, suara standar) |
| `Server/` | API REST Node.js + Express + MySQL; layanan AI memakai Google Gemini (`src/ai.js`) |
| `Extension/` | Ekstensi Chrome Manifest V3 (side panel) |

## Kebutuhan

- Node.js versi LTS
- MySQL 8
- Google Chrome atau Microsoft Edge versi terbaru
- API key Gemini dari https://aistudio.google.com/apikey

## Persiapan (sekali saja)

1. **Database.** Jalankan `Database/Create_table.sql` lalu `Database/Insert.sql` di MySQL (misalnya lewat DBeaver).
   Perhatian: `Create_table.sql` menghapus database `vocamate` lama beserta seluruh isinya.
2. **Konfigurasi server.** Salin `Server/.env.example` menjadi `Server/.env`, lalu isi `DB_PASSWORD` dan `GEMINI_API_KEY`.
3. **Dependensi server.** Di terminal:
   ```
   cd Server
   npm install
   ```
4. **Pasang ekstensi.** Buka `chrome://extensions`, aktifkan **Developer mode**, klik **Load unpacked**, pilih folder `Extension`.

## Menjalankan

1. Pastikan MySQL menyala (service `MySQL80` di Windows).
2. Jalankan server dan biarkan terminalnya terbuka:
   ```
   cd Server
   npm start
   ```
   Berhasil bila muncul `VocaMate server jalan di http://localhost:3000`. Matikan dengan `Ctrl + C`.
3. Klik ikon VocaMate di Chrome untuk membuka panel samping.

Setiap kali kode di `Server/` diubah, matikan server (`Ctrl + C`) lalu `npm start` lagi.
Setiap kali kode di `Extension/` diubah, klik tombol reload ↻ pada kartu VocaMate di `chrome://extensions`, lalu buka ulang panelnya.

## Fitur yang sudah tersedia

| Use case | Fitur |
|---|---|
| UC-01, UC-02 | Registrasi, login (penahanan setelah 5 kali gagal), logout |
| UC-03 | Menu Akun: profil, sisa kuota, jadwal reset, hapus akun |
| UC-04 | Pilih persona (Teman, Pacar Virtual, Mentor) dan suara |
| UC-05 | Percakapan suara hands-free: jeda/lanjutkan, bisukan, akhiri, menyela AI, kuota berkurang sesuai durasi aktif |
| UC-06 | Baca layar (tombol atau ucapan "baca layarku"), batas 3 kali per hari untuk Free |
| UC-07 | Lihat dan hapus riwayat percakapan |

Belum tersedia: langganan Premium dan pembayaran, memori jangka panjang, kustomisasi kepribadian, catatan tindakan, dan dashboard Admin.

## Mengatasi masalah

| Gejala | Penyebab dan solusi |
|---|---|
| "Tidak dapat terhubung ke server VocaMate" | Server belum dijalankan atau terminalnya tertutup. Jalankan `npm start`. |
| "Terjadi kesalahan (HTTP 404)" | Server yang berjalan masih kode lama. Matikan lalu jalankan ulang. |
| `EADDRINUSE` saat `npm start` | Port 3000 masih dipakai server lain. Tutup terminal lain yang menjalankan server, atau jalankan `npx kill-port 3000`. |
| "Layanan AI belum dikonfigurasi" | `GEMINI_API_KEY` di `.env` kosong, atau server belum dijalankan ulang setelah mengisinya. |
| "API key layanan AI ditolak" | Key tidak valid atau project Google-nya diblokir. Buat key baru dengan akun Gmail pribadi. |
| "Batas pemakaian layanan AI tercapai" | Batas gratis Gemini per menit. Tunggu satu menit. |
| "Kuota harian layanan AI sudah habis" | Kuota gratis harian model itu habis (dihitung per model dan per project). Isi `AI_MODEL=` di `.env` dengan model lain, misalnya `gemini-2.5-flash-lite` atau `gemini-3.1-flash-lite`, lalu jalankan ulang server. Atau buat API key di project Google lain. |
| "Layar tidak dapat dibaca" | Tab aktif adalah halaman internal Chrome (`chrome://...`). Pindah ke tab website biasa. |
| `ER_ACCESS_DENIED_ERROR` di terminal | `DB_USER` atau `DB_PASSWORD` di `.env` salah. |
| `ER_BAD_DB_ERROR` di terminal | Database `vocamate` belum dibuat; jalankan file SQL. |
| `ECONNREFUSED` di terminal | MySQL belum menyala. |

Untuk error lain di panel: klik kanan di dalam panel, pilih **Inspect**, lalu lihat tab **Console**.
