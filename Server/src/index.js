require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('./db');
const ai = require('./ai');
const filter = require('./filter');

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' })); // tangkapan layar (UC-06) dikirim sebagai base64

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const galat = (res, kode, pesan, extra = {}) => res.status(kode).json({ pesan, ...extra });
const HARI = { harian: 1, mingguan: 7, bulanan: 30 };

// Status Premium diturunkan dari tabel langganan (SDD 3.4.1). Tabel langganan belum ada
// di basis data, sehingga semua pengguna saat ini berstatus Free.
const isPremium = async () => false;

// ---------- kuota (FR-12 s.d. FR-14) ----------
async function buatKuota(conn, idPengguna, paket) {
  const mulai = new Date();
  const akhir = new Date(mulai.getTime() + HARI[paket.periode_reset] * 86400000);
  await conn.query(
    'INSERT INTO kuota (id_pengguna,id_paket,sisa_kuota_detik,periode_mulai,periode_berakhir) VALUES (?,?,?,?,?)',
    [idPengguna, paket.id_paket, paket.kuota_menit * 60, mulai, akhir]
  );
}

async function ambilKuota(conn, idPengguna) {
  const sql = `SELECT k.id_kuota, k.sisa_kuota_detik, k.pemakaian_baca_layar, k.periode_berakhir, p.*
               FROM kuota k JOIN paket p ON p.id_paket = k.id_paket
               WHERE k.id_pengguna = ? ORDER BY k.id_kuota DESC LIMIT 1`;
  let [rows] = await conn.query(sql, [idPengguna]);
  // reset periodik: bila periode berakhir, buat baris kuota baru
  if (rows[0] && new Date(rows[0].periode_berakhir) <= new Date()) {
    await buatKuota(conn, idPengguna, rows[0]);
    [rows] = await conn.query(sql, [idPengguna]);
  }
  const k = rows[0];
  return {
    id_kuota: k.id_kuota,
    sisa: k.sisa_kuota_detik,
    total: k.kuota_menit * 60,
    paket: k.nama_paket,
    reset_pada: k.periode_berakhir,
    batas_baca_layar: k.batas_baca_layar,
    pemakaian_baca_layar: k.pemakaian_baca_layar,
  };
}

// ---------- middleware token sesi ----------
async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return galat(res, 401, 'Belum login.');
  const tokenHash = sha256(token);
  const [r] = await pool.query(
    `SELECT u.id_pengguna, u.peran, u.status_akun
     FROM sesi_login s JOIN pengguna u ON u.id_pengguna = s.id_pengguna
     WHERE s.token_hash = ? AND s.dicabut = FALSE AND s.kedaluwarsa_pada > ?`,
    [tokenHash, new Date()]
  );
  if (!r[0]) return galat(res, 401, 'Sesi tidak valid. Silakan masuk lagi.');
  if (r[0].status_akun === 'diblokir') return galat(res, 403, 'Akun diblokir.');
  req.user = r[0];
  req.tokenHash = tokenHash;
  next();
}

// ---------- UC-01 Registrasi ----------
app.post('/auth/register', async (req, res) => {
  const { nama, email, password } = req.body || {};
  if (!nama || !email || !password) return galat(res, 422, 'Nama, email, dan password wajib diisi.');
  if (!/^\S+@\S+\.\S+$/.test(email)) return galat(res, 422, 'Format email tidak valid.');
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password))
    return galat(res, 422, 'Password minimal 8 karakter, mengandung huruf dan angka.');
  const [ada] = await pool.query('SELECT 1 FROM pengguna WHERE email = ?', [email]);
  if (ada.length) return galat(res, 409, 'Email sudah terdaftar.');

  const hash = await bcrypt.hash(password, 10);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [u] = await conn.query('INSERT INTO pengguna (nama,email,password_hash) VALUES (?,?,?)', [nama, email, hash]);
    const [[persona]] = await conn.query('SELECT id_persona FROM persona WHERE is_standar = TRUE LIMIT 1');
    const [[suara]] = await conn.query("SELECT id_suara FROM suara WHERE jenis = 'standar' LIMIT 1");
    const [[paket]] = await conn.query("SELECT * FROM paket WHERE nama_paket = 'Free' LIMIT 1");
    await conn.query(
      'INSERT INTO pengaturan_pengguna (id_pengguna,id_persona_aktif,id_suara_aktif) VALUES (?,?,?)',
      [u.insertId, persona.id_persona, suara.id_suara]
    );
    await buatKuota(conn, u.insertId, paket);
    await conn.commit();
    res.status(201).json({ pesan: 'Akun dibuat.' });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

// ---------- UC-02 Login ----------
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return galat(res, 422, 'Email dan password wajib diisi.');
  const [r] = await pool.query('SELECT * FROM pengguna WHERE email = ?', [email]);
  const u = r[0];

  if (u && u.login_ditahan_sampai && new Date(u.login_ditahan_sampai) > new Date()) {
    const mnt = Math.ceil((new Date(u.login_ditahan_sampai) - new Date()) / 60000);
    return galat(res, 429, `Login ditahan sementara. Coba lagi dalam ${mnt} menit.`);
  }
  if (!u || !(await bcrypt.compare(password, u.password_hash))) {
    if (u) { // 5 kali gagal -> tahan login 15 menit
      const gagal = u.jumlah_gagal_login + 1;
      if (gagal >= 5)
        await pool.query('UPDATE pengguna SET jumlah_gagal_login = 0, login_ditahan_sampai = ? WHERE id_pengguna = ?',
          [new Date(Date.now() + 15 * 60000), u.id_pengguna]);
      else
        await pool.query('UPDATE pengguna SET jumlah_gagal_login = ? WHERE id_pengguna = ?', [gagal, u.id_pengguna]);
    }
    return galat(res, 401, 'Email atau password salah.');
  }
  if (u.status_akun === 'diblokir') return galat(res, 403, 'Akun diblokir.');

  await pool.query('UPDATE pengguna SET jumlah_gagal_login = 0, login_ditahan_sampai = NULL WHERE id_pengguna = ?', [u.id_pengguna]);
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO sesi_login (id_pengguna,token_hash,kedaluwarsa_pada) VALUES (?,?,?)',
    [u.id_pengguna, sha256(token), new Date(Date.now() + 7 * 86400000)]);
  const k = await ambilKuota(pool, u.id_pengguna);
  res.json({ token, peran: u.peran, paket: k.paket, sisa_kuota_detik: k.sisa, kuota_total_detik: k.total });
});

// ---------- UC-02 Logout ----------
app.post('/auth/logout', auth, async (req, res) => {
  await pool.query('UPDATE sesi_login SET dicabut = TRUE WHERE token_hash = ?', [req.tokenHash]);
  res.json({ pesan: 'OK' });
});

// ---------- Kuota ----------
app.get('/kuota', auth, async (req, res) => {
  const k = await ambilKuota(pool, req.user.id_pengguna);
  res.json({ sisa_kuota_detik: k.sisa, kuota_total_detik: k.total, paket: k.paket, reset_pada: k.reset_pada });
});

// ---------- UC-03 Melihat Informasi dan Menghapus Akun ----------
app.get('/akun', auth, async (req, res) => {
  const [[u]] = await pool.query('SELECT nama, email, dibuat_pada FROM pengguna WHERE id_pengguna = ?', [req.user.id_pengguna]);
  const k = await ambilKuota(pool, req.user.id_pengguna);
  res.json({
    nama: u.nama,
    email: u.email,
    paket: k.paket,
    sisa_kuota_detik: k.sisa,
    kuota_total_detik: k.total,
    reset_pada: k.reset_pada,
    batas_baca_layar: k.batas_baca_layar,
    pemakaian_baca_layar: k.pemakaian_baca_layar,
    premium_berakhir: null,
  });
});

app.delete('/akun', auth, async (req, res) => {
  const { password } = req.body || {};
  const [[u]] = await pool.query('SELECT password_hash FROM pengguna WHERE id_pengguna = ?', [req.user.id_pengguna]);
  if (!password || !(await bcrypt.compare(password, u.password_hash))) return galat(res, 401, 'Password salah.');
  // FK ON DELETE CASCADE ikut menghapus token, pengaturan, kuota, sesi, dan transkrip.
  await pool.query('DELETE FROM pengguna WHERE id_pengguna = ?', [req.user.id_pengguna]);
  res.json({ pesan: 'Akun dihapus.' });
});

// ---------- UC-04 Persona dan Suara ----------
app.get('/personalisasi', auth, async (req, res) => {
  const [persona] = await pool.query("SELECT id_persona, nama_persona, deskripsi FROM persona WHERE status = 'aktif' ORDER BY id_persona");
  const [suara] = await pool.query("SELECT id_suara, nama_suara, deskripsi, kode_suara_tts, jenis FROM suara WHERE status = 'aktif' ORDER BY id_suara");
  const [[p]] = await pool.query('SELECT id_persona_aktif, id_suara_aktif FROM pengaturan_pengguna WHERE id_pengguna = ?', [req.user.id_pengguna]);
  res.json({
    persona,
    suara,
    id_persona_aktif: p.id_persona_aktif,
    id_suara_aktif: p.id_suara_aktif,
    premium: await isPremium(req.user.id_pengguna),
  });
});

app.put('/personalisasi', auth, async (req, res) => {
  const { id_persona, id_suara } = req.body || {};
  const [ada] = await pool.query("SELECT 1 FROM persona WHERE id_persona = ? AND status = 'aktif'", [id_persona]);
  if (!ada.length) return galat(res, 422, 'Persona tidak valid.');
  if (id_suara !== undefined) {
    const [[s]] = await pool.query("SELECT jenis FROM suara WHERE id_suara = ? AND status = 'aktif'", [id_suara]);
    if (!s) return galat(res, 422, 'Suara tidak valid.');
    if (s.jenis === 'ekspresif' && !(await isPremium(req.user.id_pengguna)))
      return galat(res, 403, 'Suara ekspresif khusus Pengguna Premium.');
    await pool.query('UPDATE pengaturan_pengguna SET id_suara_aktif = ? WHERE id_pengguna = ?', [id_suara, req.user.id_pengguna]);
  }
  await pool.query('UPDATE pengaturan_pengguna SET id_persona_aktif = ? WHERE id_pengguna = ?', [id_persona, req.user.id_pengguna]);
  res.json({ pesan: 'OK' });
});

// ---------- UC-08 (sebagian): daftar paket untuk halaman Upgrade ----------
app.get('/paket', auth, async (req, res) => {
  const [paket] = await pool.query(
    "SELECT id_paket, nama_paket, harga, durasi_hari, kuota_menit, batas_baca_layar, periode_reset FROM paket WHERE status = 'aktif' ORDER BY harga"
  );
  res.json({ paket });
});

// ---------- UC-05 Melakukan Percakapan Suara ----------
async function ambilSesi(idSesi, idPengguna) {
  const [[s]] = await pool.query(
    `SELECT s.*, p.instruksi_dasar, p.nama_persona FROM sesi_percakapan s
     JOIN persona p ON p.id_persona = s.id_persona
     WHERE s.id_sesi = ? AND s.id_pengguna = ?`,
    [idSesi, idPengguna]
  );
  return s;
}

app.post('/sesi', auth, async (req, res) => {
  const id = req.user.id_pengguna;
  const k = await ambilKuota(pool, id); // sekaligus mereset kuota bila periode berakhir
  if (k.sisa <= 0) return galat(res, 403, 'Kuota waktu kamu sudah habis.', { kode: 'kuota_habis', reset_pada: k.reset_pada });
  if (!ai.tersedia()) return galat(res, 503, 'Layanan AI belum dikonfigurasi di server.');

  // sesi lama yang tertinggal (misalnya peramban ditutup) ditutup tanpa memotong kuota
  await pool.query(
    "UPDATE sesi_percakapan SET status = 'selesai', waktu_selesai = ?, alasan_berakhir = 'koneksi_terputus' WHERE id_pengguna = ? AND status <> 'selesai'",
    [new Date(), id]
  );
  const [[p]] = await pool.query(
    `SELECT g.id_persona_aktif, g.id_suara_aktif, ps.nama_persona, sr.kode_suara_tts
     FROM pengaturan_pengguna g
     JOIN persona ps ON ps.id_persona = g.id_persona_aktif
     JOIN suara sr ON sr.id_suara = g.id_suara_aktif
     WHERE g.id_pengguna = ?`,
    [id]
  );
  const [s] = await pool.query(
    'INSERT INTO sesi_percakapan (id_pengguna,id_persona,id_suara,waktu_mulai) VALUES (?,?,?,?)',
    [id, p.id_persona_aktif, p.id_suara_aktif, new Date()]
  );
  res.status(201).json({
    id_sesi: s.insertId,
    persona: p.nama_persona,
    kode_suara: p.kode_suara_tts,
    sisa_kuota_detik: k.sisa,
    batas_baca_layar: k.batas_baca_layar,
    pemakaian_baca_layar: k.pemakaian_baca_layar,
  });
});

// Satu giliran bicara: teks hasil STT (dan opsional tangkapan layar, UC-06) -> jawaban AI.
app.post('/sesi/:id/pesan', auth, async (req, res) => {
  const { teks, gambar, sela } = req.body || {};
  if (!teks || !teks.trim()) return galat(res, 422, 'Ucapan kosong.');
  const s = await ambilSesi(req.params.id, req.user.id_pengguna);
  if (!s || s.status === 'selesai') return galat(res, 409, 'Sesi sudah berakhir.');

  // UC-06: batas baca layar hanya untuk Free (batas NULL = tanpa batas)
  let k = null;
  if (gambar) {
    k = await ambilKuota(pool, req.user.id_pengguna);
    const premium = await isPremium(req.user.id_pengguna);
    if (!premium && k.batas_baca_layar !== null && k.pemakaian_baca_layar >= k.batas_baca_layar)
      return galat(res, 403, 'Batas baca layar periode ini sudah tercapai.', { kode: 'batas_baca_layar' });
  }

  // jawaban AI sebelumnya disela pengguna (FR-05)
  if (sela)
    await pool.query(
      "UPDATE transkrip SET disela = TRUE WHERE id_sesi = ? AND penutur = 'ai' ORDER BY id_transkrip DESC LIMIT 1",
      [s.id_sesi]
    );

  const [riwayat] = await pool.query(
    'SELECT penutur, isi_teks FROM transkrip WHERE id_sesi = ? ORDER BY id_transkrip DESC LIMIT 20',
    [s.id_sesi]
  );
  riwayat.reverse();
  await pool.query("INSERT INTO transkrip (id_sesi,penutur,isi_teks) VALUES (?,'pengguna',?)", [s.id_sesi, teks]);

  let hasil;
  try {
    hasil = await ai.balas({ instruksi: s.instruksi_dasar, riwayat, teks, gambar });
  } catch (e) {
    if (e instanceof ai.APIError) {
      console.error('Layanan AI:', e.status, e.message);
      // hanya gangguan sementara (5xx) yang dicoba ulang oleh ekstensi (FR-24)
      if (e.status === 429 && /PerDay/.test(e.message))
        return galat(res, 429, 'Kuota harian layanan AI sudah habis. Coba lagi besok atau ganti AI_MODEL/API key di server.', { kode: 'ai_limit' });
      if (e.status === 429)
        return galat(res, 429, 'Batas pemakaian layanan AI tercapai. Tunggu sekitar satu menit lalu bicara lagi.', { kode: 'ai_limit' });
      if (e.status === 400 || e.status === 401 || e.status === 403)
        return galat(res, 502, 'API key layanan AI ditolak. Periksa GEMINI_API_KEY di server.', { kode: 'ai_ditolak' });
      return galat(res, 502, 'Layanan AI sedang terganggu. Mencoba lagi...', { kode: 'ai_terganggu' });
    }
    throw e;
  }

  const jawaban = hasil.ditolak ? filter.PENGALIHAN : filter.terapkan(hasil.teks);
  await pool.query("INSERT INTO transkrip (id_sesi,penutur,isi_teks) VALUES (?,'ai',?)", [s.id_sesi, jawaban]);
  // pemakaian baca layar dicatat hanya bila pemrosesan berhasil
  if (gambar) await pool.query('UPDATE kuota SET pemakaian_baca_layar = pemakaian_baca_layar + 1 WHERE id_kuota = ?', [k.id_kuota]);

  res.json({ jawaban });
});

app.post('/sesi/:id/akhiri', auth, async (req, res) => {
  const { durasi_aktif_detik, alasan } = req.body || {};
  const s = await ambilSesi(req.params.id, req.user.id_pengguna);
  if (!s) return galat(res, 404, 'Sesi tidak ditemukan.');
  if (s.status === 'selesai') return galat(res, 409, 'Sesi sudah berakhir.');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const k = await ambilKuota(conn, req.user.id_pengguna);
    // durasi aktif dari ekstensi (tanpa jeda dan gangguan), dibatasi lama sesi sebenarnya dan sisa kuota
    const lamaSesi = Math.floor((Date.now() - new Date(s.waktu_mulai).getTime()) / 1000);
    const durasi = Math.max(0, Math.min(Math.floor(Number(durasi_aktif_detik) || 0), lamaSesi, k.sisa));
    const ALASAN = ['pengguna', 'kuota_habis', 'koneksi_terputus', 'logout', 'hapus_akun'];
    await conn.query(
      "UPDATE sesi_percakapan SET status = 'selesai', waktu_selesai = ?, durasi_aktif_detik = ?, alasan_berakhir = ? WHERE id_sesi = ?",
      [new Date(), durasi, ALASAN.includes(alasan) ? alasan : 'pengguna', s.id_sesi]
    );
    await conn.query('UPDATE kuota SET sisa_kuota_detik = sisa_kuota_detik - ? WHERE id_kuota = ?', [durasi, k.id_kuota]);
    await conn.commit();
    res.json({ durasi_aktif_detik: durasi, sisa_kuota_detik: k.sisa - durasi });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

// ---------- UC-07 Riwayat ----------
app.get('/riwayat', auth, async (req, res) => {
  const [sesi] = await pool.query(
    `SELECT s.id_sesi, s.waktu_mulai, s.durasi_aktif_detik, p.nama_persona
     FROM sesi_percakapan s JOIN persona p ON p.id_persona = s.id_persona
     WHERE s.id_pengguna = ? AND s.status = 'selesai'
     ORDER BY s.waktu_mulai DESC`,
    [req.user.id_pengguna]
  );
  res.json({ sesi });
});

app.get('/riwayat/:id', auth, async (req, res) => {
  const s = await ambilSesi(req.params.id, req.user.id_pengguna);
  if (!s) return galat(res, 404, 'Riwayat tidak ditemukan.');
  const [transkrip] = await pool.query(
    'SELECT penutur, isi_teks, disela, waktu FROM transkrip WHERE id_sesi = ? ORDER BY id_transkrip',
    [s.id_sesi]
  );
  res.json({ id_sesi: s.id_sesi, persona: s.nama_persona, waktu_mulai: s.waktu_mulai, transkrip });
});

app.delete('/riwayat/:id', auth, async (req, res) => {
  // transkrip ikut terhapus (ON DELETE CASCADE)
  const [r] = await pool.query(
    "DELETE FROM sesi_percakapan WHERE id_sesi = ? AND id_pengguna = ? AND status = 'selesai'",
    [req.params.id, req.user.id_pengguna]
  );
  if (!r.affectedRows) return galat(res, 404, 'Riwayat tidak ditemukan.');
  res.json({ pesan: 'Riwayat dihapus.' });
});

// ---------- penanganan error ----------
app.use((err, req, res, next) => {
  console.error(err);
  galat(res, 500, 'Terjadi kesalahan di server.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('VocaMate server jalan di http://localhost:' + PORT));
