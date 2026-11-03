// Filter keamanan konten (FR-23): diterapkan pada respons AI di semua persona.
// Daftar kata sederhana; dapat diganti layanan moderasi tanpa mengubah pemanggil.
const TERLARANG = [
  'bunuh diri', 'cara membunuh', 'membuat bom', 'merakit bom', 'narkoba', 'pornografi',
];

const PENGALIHAN = 'Maaf, aku tidak bisa membahas hal itu. Yuk, kita ngobrol tentang hal lain.';

function aman(teks) {
  const t = (teks || '').toLowerCase();
  return !TERLARANG.some((k) => t.includes(k));
}

// Mengembalikan teks asli bila aman, atau jawaban pengalihan bila melanggar.
function terapkan(teks) {
  return aman(teks) && teks ? teks : PENGALIHAN;
}

// Masukan kustomisasi kepribadian (FR-23): selain kata terlarang, tolak upaya mengakali instruksi AI
// (prompt injection), konten dewasa/kekerasan, dan perubahan peran di luar persona dasar.
const MANIPULASI = [
  /\b(abaikan|lupakan|hapus|langgar|timpa)\b.{0,30}\b(instruksi|aturan|perintah|batasan|filter|prompt)/i,
  /\b(ignore|disregard|forget|override|bypass)\b.{0,30}\b(instruction|rule|prompt|filter|guideline)/i,
  /\b(system\s*prompt|jailbreak|developer\s*mode|dan\s*mode|tanpa\s*(batas|filter|sensor|aturan)|no\s*(filter|limit|rules))\b/i,
  /\b(kamu|anda|you)\s+(adalah|sekarang|are\s+now)\b/i,
  /\b(seks|seksual|sensual|vulgar|mesum|telanjang|nsfw|porno|kasar\s+dan\s+menghina|rasis|membenci)\b/i,
];

function amanKustomisasi(teks) {
  return aman(teks) && !MANIPULASI.some((p) => p.test(teks || ''));
}

module.exports = { aman, terapkan, amanKustomisasi, PENGALIHAN };
