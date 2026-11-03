// Adapter Payment Gateway (UC-09): satu-satunya modul yang tahu penyedia pembayaran.
// Prototype ini memakai gateway SIMULASI yang berjalan di server yang sama: tagihan disimpan di memori,
// halaman /simulasi/bayar/:kode berperan sebagai aplikasi bank/e-wallet, dan hasilnya dikirim
// sebagai notifikasi bertanda tangan HMAC ke /webhook/pembayaran, seperti gateway sungguhan.
// Ganti isi file ini (buatTagihan, cekStatus, verifikasi) untuk memakai Midtrans/Xendit dsb.
const crypto = require('crypto');
const express = require('express');

const RAHASIA = process.env.GATEWAY_SECRET || 'rahasia-simulasi-vocamate';
const BASIS = () => `http://localhost:${process.env.PORT || 3000}`;
const tagihan = new Map(); // kode_pesanan -> { jumlah, metode, status, referensi, batas }

const tandaTangan = (kode, status, jumlah) =>
  crypto.createHmac('sha256', RAHASIA).update(`${kode}|${status}|${Number(jumlah).toFixed(2)}`).digest('hex');

// Memverifikasi keaslian notifikasi dari gateway.
function verifikasi({ kode_pesanan, status, jumlah, signature }) {
  if (typeof signature !== 'string') return false;
  const harus = Buffer.from(tandaTangan(kode_pesanan, status, jumlah));
  const dapat = Buffer.from(signature);
  return harus.length === dapat.length && crypto.timingSafeEqual(harus, dapat);
}

// Membuat tagihan; mengembalikan nomor referensi dan instruksi pembayaran sesuai metode.
function buatTagihan({ kode, jumlah, metode, batas }) {
  const referensi = 'SIM-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  tagihan.set(kode, { jumlah, metode, status: 'menunggu', referensi, batas });
  const url = `${BASIS()}/simulasi/bayar/${encodeURIComponent(kode)}`;
  const instruksi = {
    qris: { judul: 'Pindai kode QRIS', kode_qris: `00020101021226${referensi}5303360540${Math.round(jumlah)}6304`, url },
    ewallet: { judul: 'Lanjutkan di aplikasi e-wallet', url },
    va: { judul: 'Transfer ke Virtual Account', bank: 'Bank Simulasi', nomor_va: '8808' + String(Date.now()).slice(-10), url },
  }[metode];
  return { referensi, instruksi };
}

// Pemeriksaan status berkala (dipakai bila notifikasi tidak diterima). null = gateway tidak mengenal tagihan.
function cekStatus(kode) {
  const t = tagihan.get(kode);
  if (!t) return null;
  if (t.status === 'menunggu' && t.batas <= new Date()) t.status = 'kedaluwarsa';
  return { status: t.status, referensi: t.referensi, jumlah: t.jumlah, signature: tandaTangan(kode, t.status, t.jumlah) };
}

// ---------- halaman simulasi pembayaran (pengganti aplikasi bank/e-wallet) ----------
const router = express.Router();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const halaman = (isi) => `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Simulasi Pembayaran</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px;color:#1d1d2b}
.kartu{border:1px solid #e2e2ec;border-radius:10px;padding:20px}button{font:inherit;font-weight:600;padding:10px 14px;
border-radius:8px;border:1px solid #e2e2ec;cursor:pointer;margin-right:8px}.ok{background:#5b4bdb;color:#fff;border-color:#5b4bdb}
.redup{color:#6b6b80;font-size:13px}</style></head><body><div class="kartu">${isi}</div></body></html>`;

router.get('/bayar/:kode', (req, res) => {
  const kode = req.params.kode;
  const t = cekStatus(kode);
  if (!t) return res.status(404).send(halaman('<h2>Tagihan tidak ditemukan</h2><p class="redup">Tagihan simulasi hilang bila server dijalankan ulang. Buat transaksi baru dari ekstensi.</p>'));
  const info = tagihan.get(kode);
  if (t.status !== 'menunggu') return res.send(halaman(`<h2>Status: ${esc(t.status)}</h2><p>Tagihan ini sudah diproses. Kembali ke panel VocaMate.</p>`));
  res.send(halaman(`<h2>Simulasi Pembayaran</h2>
    <p>Kode pesanan: <b>${esc(kode)}</b><br>Metode: <b>${esc(info.metode.toUpperCase())}</b><br>
    Jumlah: <b>Rp${Number(info.jumlah).toLocaleString('id-ID')}</b><br>
    Batas waktu: ${esc(info.batas.toLocaleString('id-ID'))}</p>
    <form method="post"><button class="ok" name="hasil" value="berhasil">Bayar</button>
    <button name="hasil" value="gagal">Batalkan / Gagal</button></form>
    <p class="redup">Halaman ini menggantikan aplikasi bank/e-wallet. Tidak ada uang sungguhan yang dipindahkan.</p>`));
});

router.post('/bayar/:kode', express.urlencoded({ extended: false }), async (req, res) => {
  const kode = req.params.kode;
  const t = tagihan.get(kode);
  if (!t || cekStatus(kode).status !== 'menunggu') return res.redirect(303, req.originalUrl);
  t.status = req.body.hasil === 'berhasil' ? 'berhasil' : 'gagal';
  // gateway mengirim notifikasi ke server; bila gagal terkirim, server tetap tahu lewat cekStatus berkala
  try {
    await fetch(`${BASIS()}/webhook/pembayaran`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kode_pesanan: kode, status: t.status, jumlah: t.jumlah, referensi: t.referensi, signature: tandaTangan(kode, t.status, t.jumlah) }),
    });
  } catch (e) {
    console.error('Simulasi gateway: notifikasi gagal dikirim:', e.message);
  }
  res.send(halaman(t.status === 'berhasil'
    ? '<h2>Pembayaran berhasil</h2><p>Kembali ke panel VocaMate; status Premium akan aktif otomatis.</p>'
    : '<h2>Pembayaran dibatalkan</h2><p>Kembali ke panel VocaMate untuk mencoba metode lain.</p>'));
});

module.exports = { buatTagihan, cekStatus, verifikasi, router };
