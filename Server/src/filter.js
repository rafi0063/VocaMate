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

module.exports = { aman, terapkan, PENGALIHAN };
