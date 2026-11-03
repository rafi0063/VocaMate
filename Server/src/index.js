require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('./db');
const ai = require('./ai');
const filter = require('./filter');
const gateway = require('./gateway');

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' })); // tangkapan layar (UC-07) dikirim sebagai base64

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const galat = (res, kode, pesan, extra = {}) => res.status(kode).json({ pesan, ...extra });
const HARI = { harian: 1, mingguan: 7, bulanan: 30 };
const teks = (v) => (typeof v === 'string' ? v.trim() : '');
// nama: huruf (termasuk beraksen), spasi, titik, apostrof, dan tanda hubung; tolak simbol seperti ; = -- /* */
const POLA_NAMA = /^\p{L}[\p{L} .'-]*$/u;

// Status Premium diturunkan dari tabel langganan (SDD 3.4.1): Premium bila ada langganan aktif
// yang sedang berjalan. Langganan perpanjangan yang belum dimulai tidak dihitung di sini.
async function langgananBerjalan(conn, idPengguna) {
  const sekarang = new Date();
  const [[l]] = await conn.query(
    `SELECT l.*, p.nama_paket FROM langganan l JOIN paket p ON p.id_paket = l.id_paket
     WHERE l.id_pengguna = ? AND l.status = 'aktif' AND l.tanggal_mulai <= ? AND l.tanggal_berakhir > ?
     ORDER BY l.tanggal_berakhir DESC LIMIT 1`,
    [idPengguna, sekarang, sekarang]
  );
  return l || null;
}
const isPremium = async (idPengguna, conn = pool) => Boolean(await langgananBerjalan(conn, idPengguna));

// Akhir masa Premium termasuk perpanjangan yang sudah dibayar (null bila tidak Premium).
async function akhirPremium(conn, idPengguna) {
  if (!(await isPremium(idPengguna, conn))) return null;
  const [[r]] = await conn.query(
    "SELECT MAX(tanggal_berakhir) AS akhir FROM langganan WHERE id_pengguna = ? AND status = 'aktif'",
    [idPengguna]
  );
  return r.akhir;
}

// Paket yang berlaku sekarang: paket langganan yang berjalan, atau Free.
async function paketBerlaku(conn, idPengguna) {
  const l = await langgananBerjalan(conn, idPengguna);
  const [[p]] = l
    ? await conn.query('SELECT * FROM paket WHERE id_paket = ?', [l.id_paket])
    : await conn.query("SELECT * FROM paket WHERE nama_paket = 'Free' LIMIT 1");
  if (!p) throw new Error('Paket Free tidak ditemukan di basis data.');
  return p;
}

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
  // Buat baris kuota baru bila: belum ada (data lama/rusak), periode berakhir (reset periodik),
  // atau paket berubah (Premium baru aktif / Premium berakhir kembali ke Free).
  const paket = await paketBerlaku(conn, idPengguna);
  if (!rows[0] || new Date(rows[0].periode_berakhir) <= new Date() || rows[0].id_paket !== paket.id_paket) {
    await buatKuota(conn, idPengguna, paket);
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
  const nama = teks(req.body?.nama);
  const email = teks(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!nama || !email || !password) return galat(res, 422, 'Nama, email, dan password wajib diisi.');
  if (nama.length > 100 || !POLA_NAMA.test(nama))
    return galat(res, 422, 'Nama hanya boleh berisi huruf, spasi, titik, apostrof, dan tanda hubung (maks. 100 karakter).');
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
  const email = teks(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
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

// ---------- UC-03 Melihat Informasi Akun ----------
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
    premium_berakhir: await akhirPremium(pool, req.user.id_pengguna),
  });
});

// ---------- UC-04 Menghapus Akun ----------
app.delete('/akun', auth, async (req, res) => {
  const { password } = req.body || {};
  const [[u]] = await pool.query('SELECT password_hash FROM pengguna WHERE id_pengguna = ?', [req.user.id_pengguna]);
  if (!password || !(await bcrypt.compare(password, u.password_hash))) return galat(res, 401, 'Password salah.');
  // FK ON DELETE CASCADE ikut menghapus token, pengaturan, kuota, sesi, dan transkrip.
  await pool.query('DELETE FROM pengguna WHERE id_pengguna = ?', [req.user.id_pengguna]);
  res.json({ pesan: 'Akun dihapus.' });
});

// ---------- UC-05 Persona dan Suara ----------
app.get('/personalisasi', auth, async (req, res) => {
  const [persona] = await pool.query("SELECT id_persona, nama_persona, deskripsi FROM persona WHERE status = 'aktif' ORDER BY id_persona");
  const [suara] = await pool.query("SELECT id_suara, nama_suara, deskripsi, kode_suara_tts, jenis FROM suara WHERE status = 'aktif' ORDER BY id_suara");
  const [[p]] = await pool.query('SELECT id_persona_aktif, id_suara_aktif FROM pengaturan_pengguna WHERE id_pengguna = ?', [req.user.id_pengguna]);
  const [kustomisasi] = await pool.query(
    'SELECT id_persona_dasar, nama_panggilan, sifat, gaya_bicara, status FROM kustomisasi_kepribadian WHERE id_pengguna = ?',
    [req.user.id_pengguna]
  );
  res.json({
    persona,
    suara,
    kustomisasi,
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

// ---------- UC-09 (sebagian): daftar paket untuk halaman Upgrade ----------
app.get('/paket', auth, async (req, res) => {
  const [paket] = await pool.query(
    "SELECT id_paket, nama_paket, harga, durasi_hari, kuota_menit, batas_baca_layar, periode_reset FROM paket WHERE status = 'aktif' ORDER BY harga"
  );
  res.json({ paket });
});

// ---------- UC-06 Melakukan Percakapan Suara ----------
async function ambilSesi(idSesi, idPengguna) {
  const [[s]] = await pool.query(
    `SELECT s.*, p.instruksi_dasar, p.nama_persona, kk.nama_panggilan, kk.sifat, kk.gaya_bicara
     FROM sesi_percakapan s
     JOIN persona p ON p.id_persona = s.id_persona
     LEFT JOIN kustomisasi_kepribadian kk ON kk.id_kustomisasi = s.id_kustomisasi AND kk.status = 'aktif'
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
  // FR-20: kustomisasi kepribadian untuk persona aktif, hanya bila Premium
  const [[kk]] = (await isPremium(id))
    ? await pool.query(
        "SELECT id_kustomisasi, nama_panggilan FROM kustomisasi_kepribadian WHERE id_pengguna = ? AND id_persona_dasar = ? AND status = 'aktif'",
        [id, p.id_persona_aktif])
    : [[]];
  const [s] = await pool.query(
    'INSERT INTO sesi_percakapan (id_pengguna,id_persona,id_kustomisasi,id_suara,waktu_mulai) VALUES (?,?,?,?,?)',
    [id, p.id_persona_aktif, kk?.id_kustomisasi || null, p.id_suara_aktif, new Date()]
  );
  res.status(201).json({
    id_sesi: s.insertId,
    persona: p.nama_persona + (kk?.nama_panggilan ? ` (${kk.nama_panggilan})` : ''),
    kustomisasi: Boolean(kk),
    memori: await memoriDipakai(id),
    kode_suara: p.kode_suara_tts,
    sisa_kuota_detik: k.sisa,
    batas_baca_layar: k.batas_baca_layar,
    pemakaian_baca_layar: k.pemakaian_baca_layar,
  });
});

// Satu giliran bicara: teks hasil STT (dan opsional tangkapan layar, UC-07) -> jawaban AI.
app.post('/sesi/:id/pesan', auth, async (req, res) => {
  const { gambar, sela } = req.body || {};
  const ucapan = teks(req.body?.teks);
  if (!ucapan) return galat(res, 422, 'Ucapan kosong.');
  if (gambar !== undefined && typeof gambar !== 'string') return galat(res, 422, 'Format gambar tidak valid.');
  const s = await ambilSesi(req.params.id, req.user.id_pengguna);
  if (!s || s.status === 'selesai') return galat(res, 409, 'Sesi sudah berakhir.');

  // UC-07: batas baca layar hanya untuk Free (batas NULL = tanpa batas)
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
  await pool.query("INSERT INTO transkrip (id_sesi,penutur,isi_teks) VALUES (?,'pengguna',?)", [s.id_sesi, ucapan]);

  // FR-21: memori jangka panjang dipakai sebagai konteks (Premium yang mengaktifkan memori)
  let memori = [];
  if (await memoriDipakai(req.user.id_pengguna)) {
    const [m] = await pool.query(
      "SELECT isi_memori FROM memori WHERE id_pengguna = ? AND status = 'aktif' ORDER BY id_memori DESC LIMIT 30",
      [req.user.id_pengguna]
    );
    memori = m.map((r) => r.isi_memori);
  }

  let hasil;
  try {
    const kustomisasi = { nama_panggilan: s.nama_panggilan, sifat: s.sifat, gaya_bicara: s.gaya_bicara };
    hasil = await ai.balas({ instruksi: s.instruksi_dasar, riwayat, teks: ucapan, gambar, memori, kustomisasi });
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
  // memori diperbarui di latar belakang agar pengguna tidak menunggu layanan AI
  if (alasan !== 'hapus_akun' && (await memoriDipakai(req.user.id_pengguna)))
    perbaruiMemori(req.user.id_pengguna, s.id_sesi).catch((e) => console.error('Ekstraksi memori gagal:', e.message));
});

// ---------- UC-08 Riwayat ----------
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

// ---------- UC-08 Memori Jangka Panjang (Premium, FR-21, FR-22) ----------
const MAKS_MEMORI = 500; // karakter per butir

// Memori dipakai hanya bila pengguna Premium dan sakelar memori aktif.
async function memoriDipakai(idPengguna) {
  const [[g]] = await pool.query('SELECT memori_aktif FROM pengaturan_pengguna WHERE id_pengguna = ?', [idPengguna]);
  return Boolean(g?.memori_aktif) && (await isPremium(idPengguna));
}

// Mengekstrak butir memori baru dari ucapan pengguna pada sesi yang baru berakhir.
async function perbaruiMemori(idPengguna, idSesi) {
  if (!ai.tersedia()) return;
  const [ucapan] = await pool.query(
    "SELECT isi_teks FROM transkrip WHERE id_sesi = ? AND penutur = 'pengguna' ORDER BY id_transkrip",
    [idSesi]
  );
  if (!ucapan.length) return;
  const [lama] = await pool.query(
    "SELECT isi_memori FROM memori WHERE id_pengguna = ? AND status = 'aktif' ORDER BY id_memori DESC LIMIT 50",
    [idPengguna]
  );
  const butir = await ai.ekstrakMemori({
    ucapan: ucapan.slice(-60).map((u) => u.isi_teks),
    memoriLama: lama.map((m) => m.isi_memori),
  });
  for (const b of butir.filter((x) => filter.aman(x)))
    await pool.query('INSERT INTO memori (id_pengguna,id_sesi_sumber,isi_memori) VALUES (?,?,?)', [idPengguna, idSesi, b]);
}

app.get('/memori', auth, async (req, res) => {
  const id = req.user.id_pengguna;
  const [[g]] = await pool.query('SELECT memori_aktif FROM pengaturan_pengguna WHERE id_pengguna = ?', [id]);
  const [butir] = await pool.query(
    'SELECT id_memori, isi_memori, dibuat_pada, diperbarui_pada FROM memori WHERE id_pengguna = ? ORDER BY id_memori DESC',
    [id]
  );
  res.json({ premium: await isPremium(id), memori_aktif: Boolean(g?.memori_aktif), butir });
});

// Mengaktifkan memori khusus Premium; menonaktifkan selalu diizinkan.
app.put('/memori/pengaturan', auth, async (req, res) => {
  const aktif = req.body?.aktif;
  if (typeof aktif !== 'boolean') return galat(res, 422, 'Nilai pengaturan memori tidak valid.');
  if (aktif && !(await isPremium(req.user.id_pengguna)))
    return galat(res, 403, 'Memori jangka panjang khusus Pengguna Premium.', { kode: 'butuh_premium' });
  await pool.query('UPDATE pengaturan_pengguna SET memori_aktif = ? WHERE id_pengguna = ?', [aktif, req.user.id_pengguna]);
  res.json({ pesan: aktif ? 'Memori diaktifkan.' : 'Memori dinonaktifkan.' });
});

app.put('/memori/:id', auth, async (req, res) => {
  const isi = teks(req.body?.isi_memori);
  if (!(await isPremium(req.user.id_pengguna)))
    return galat(res, 403, 'Mengubah memori khusus Pengguna Premium.', { kode: 'butuh_premium' });
  if (!isi) return galat(res, 422, 'Isi memori tidak boleh kosong.');
  if (isi.length > MAKS_MEMORI) return galat(res, 422, `Isi memori maksimal ${MAKS_MEMORI} karakter.`);
  if (!filter.aman(isi)) return galat(res, 422, 'Isi memori mengandung konten yang tidak diizinkan.');
  const [r] = await pool.query('UPDATE memori SET isi_memori = ? WHERE id_memori = ? AND id_pengguna = ?',
    [isi, req.params.id, req.user.id_pengguna]);
  if (!r.affectedRows) return galat(res, 404, 'Memori tidak ditemukan.');
  res.json({ pesan: 'Memori diperbarui.' });
});

// Menghapus memori selalu diizinkan, termasuk setelah Premium berakhir.
app.delete('/memori/:id', auth, async (req, res) => {
  const [r] = await pool.query('DELETE FROM memori WHERE id_memori = ? AND id_pengguna = ?', [req.params.id, req.user.id_pengguna]);
  if (!r.affectedRows) return galat(res, 404, 'Memori tidak ditemukan.');
  res.json({ pesan: 'Memori dihapus.' });
});

app.delete('/memori', auth, async (req, res) => {
  const [r] = await pool.query('DELETE FROM memori WHERE id_pengguna = ?', [req.user.id_pengguna]);
  res.json({ pesan: `${r.affectedRows} memori dihapus.` });
});

// ---------- UC-05 Kustomisasi Kepribadian AI (Premium, FR-20, FR-23) ----------
const BATAS_KUSTOMISASI = { nama_panggilan: 50, sifat: 255, gaya_bicara: 255 };
const POLA_PANGGILAN = /^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u;

app.put('/kustomisasi/:id_persona', auth, async (req, res) => {
  const id = req.user.id_pengguna;
  if (!(await isPremium(id)))
    return galat(res, 403, 'Kustomisasi kepribadian khusus Pengguna Premium.', { kode: 'butuh_premium' });
  const [ada] = await pool.query("SELECT 1 FROM persona WHERE id_persona = ? AND status = 'aktif'", [req.params.id_persona]);
  if (!ada.length) return galat(res, 422, 'Persona tidak valid.');

  const isi = {};
  for (const [kolom, maks] of Object.entries(BATAS_KUSTOMISASI)) {
    const v = req.body?.[kolom];
    if (v !== undefined && v !== null && typeof v !== 'string') return galat(res, 422, 'Isian kustomisasi tidak valid.');
    isi[kolom] = teks(v) || null;
    if (isi[kolom] && isi[kolom].length > maks) return galat(res, 422, `Isian terlalu panjang (maks. ${maks} karakter).`);
  }
  if (!isi.nama_panggilan && !isi.sifat && !isi.gaya_bicara) return galat(res, 422, 'Isi minimal satu kolom kustomisasi.');
  if (isi.nama_panggilan && !POLA_PANGGILAN.test(isi.nama_panggilan))
    return galat(res, 422, 'Nama panggilan hanya boleh berisi huruf, angka, spasi, titik, apostrof, dan tanda hubung.');
  if (!Object.values(isi).every((v) => !v || filter.amanKustomisasi(v)))
    return galat(res, 422, 'Kustomisasi mengandung konten atau instruksi yang tidak diizinkan.', { kode: 'konten_ditolak' });

  await pool.query(
    `INSERT INTO kustomisasi_kepribadian (id_pengguna,id_persona_dasar,nama_panggilan,sifat,gaya_bicara,status)
     VALUES (?,?,?,?,?,'aktif')
     ON DUPLICATE KEY UPDATE nama_panggilan = VALUES(nama_panggilan), sifat = VALUES(sifat),
       gaya_bicara = VALUES(gaya_bicara), status = 'aktif'`,
    [id, req.params.id_persona, isi.nama_panggilan, isi.sifat, isi.gaya_bicara]
  );
  res.json({ pesan: 'Kustomisasi disimpan. Berlaku pada sesi berikutnya.' });
});

// Mengembalikan ke kepribadian bawaan selalu diizinkan.
app.delete('/kustomisasi/:id_persona', auth, async (req, res) => {
  await pool.query('DELETE FROM kustomisasi_kepribadian WHERE id_pengguna = ? AND id_persona_dasar = ?',
    [req.user.id_pengguna, req.params.id_persona]);
  res.json({ pesan: 'Kepribadian dikembalikan ke bawaan.' });
});

// ---------- UC-09 Berlangganan Paket Premium ----------
const METODE = ['qris', 'ewallet', 'va'];
const BATAS_BAYAR_MENIT = 30;
const PENGINGAT_HARI = 3;
// pembatasan pembuatan transaksi per pengguna, agar tidak bisa membuat tagihan tanpa henti
const BATAS_TRANSAKSI = { jumlah: 5, menit: 15 };
const BATAS_TRANSAKSI_HARIAN = 20;

const formatTransaksi = (t) => ({
  id_transaksi: t.id_transaksi,
  kode_pesanan: t.kode_pesanan,
  metode: t.metode_pembayaran,
  jumlah: Number(t.jumlah),
  status: t.status,
  batas_waktu_bayar: t.batas_waktu_bayar,
  instruksi: typeof t.instruksi_bayar === 'string' ? JSON.parse(t.instruksi_bayar) : t.instruksi_bayar,
});

// Memperbarui status transaksi dari notifikasi atau pemeriksaan berkala, secara idempoten:
// notifikasi duplikat diabaikan; notifikasi "berhasil" yang terlambat tetap diproses.
async function prosesPembayaran({ kode, status, jumlah, referensi }) {
  if (!['berhasil', 'gagal', 'kedaluwarsa'].includes(status)) return;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[t]] = await conn.query('SELECT * FROM transaksi WHERE kode_pesanan = ? FOR UPDATE', [kode]);
    const bisaDiproses = t && (t.status === 'menunggu' || (t.status === 'kedaluwarsa' && status === 'berhasil'));
    if (!bisaDiproses) return await conn.commit();
    if (jumlah !== undefined && Number(jumlah) !== Number(t.jumlah)) {
      console.warn(`[pembayaran] jumlah tidak cocok untuk ${kode}: ${jumlah} != ${t.jumlah}; diabaikan`);
      return await conn.commit();
    }
    await conn.query('UPDATE transaksi SET status = ?, referensi_gateway = COALESCE(?, referensi_gateway) WHERE id_transaksi = ?',
      [status, referensi || null, t.id_transaksi]);
    console.log(`[pembayaran] ${kode}: ${t.status} -> ${status}`);

    if (status === 'berhasil' && t.id_pengguna) {
      // perpanjangan dihitung dari tanggal berakhir langganan aktif
      const [[p]] = await conn.query('SELECT durasi_hari FROM paket WHERE id_paket = ?', [t.id_paket]);
      const [[r]] = await conn.query(
        "SELECT MAX(tanggal_berakhir) AS akhir FROM langganan WHERE id_pengguna = ? AND status = 'aktif' AND tanggal_berakhir > ?",
        [t.id_pengguna, new Date()]
      );
      // dibulatkan ke bawah per detik: DATETIME MySQL membulatkan milidetik ke atas, sehingga
      // tanggal_mulai bisa jatuh di masa depan dan Premium belum terhitung aktif
      const mulai = r.akhir ? new Date(r.akhir) : new Date(Math.floor(Date.now() / 1000) * 1000);
      const akhir = new Date(mulai.getTime() + (p.durasi_hari || 30) * 86400000);
      await conn.query(
        'INSERT INTO langganan (id_pengguna,id_paket,id_transaksi,tanggal_mulai,tanggal_berakhir) VALUES (?,?,?,?,?)',
        [t.id_pengguna, t.id_paket, t.id_transaksi, mulai, akhir]
      );
      console.log(`[langganan] pengguna ${t.id_pengguna} Premium sampai ${akhir.toISOString()}`);
      // kustomisasi yang tersimpan aktif kembali
      await conn.query("UPDATE kustomisasi_kepribadian SET status = 'aktif' WHERE id_pengguna = ?", [t.id_pengguna]);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

app.get('/langganan', auth, async (req, res) => {
  const id = req.user.id_pengguna;
  const berakhir = await akhirPremium(pool, id);
  // pengingat sebelum masa berlaku berakhir, dikirim sekali per langganan
  let pengingat = false;
  if (berakhir && new Date(berakhir) - Date.now() <= PENGINGAT_HARI * 86400000) {
    const [r] = await pool.query(
      "UPDATE langganan SET pengingat_terkirim = TRUE WHERE id_pengguna = ? AND status = 'aktif' AND tanggal_berakhir = ? AND pengingat_terkirim = FALSE",
      [id, berakhir]
    );
    pengingat = r.affectedRows > 0;
  }
  const [[t]] = await pool.query(
    "SELECT * FROM transaksi WHERE id_pengguna = ? AND status = 'menunggu' AND batas_waktu_bayar > ? ORDER BY id_transaksi DESC LIMIT 1",
    [id, new Date()]
  );
  res.json({ premium: Boolean(berakhir), berakhir, pengingat, transaksi_menunggu: t ? formatTransaksi(t) : null });
});

app.post('/transaksi', auth, async (req, res) => {
  const { id_paket, metode } = req.body || {};
  if (!METODE.includes(metode)) return galat(res, 422, 'Pilih metode pembayaran: QRIS, e-wallet, atau virtual account.');
  const [[p]] = await pool.query("SELECT * FROM paket WHERE id_paket = ? AND status = 'aktif'", [id_paket]);
  if (!p || Number(p.harga) <= 0) return galat(res, 422, 'Paket tidak valid.');

  // dihitung dari basis data (waktu MySQL) sehingga tetap berlaku walau server dijalankan ulang
  const [[jml]] = await pool.query(
    `SELECT SUM(dibuat_pada > NOW() - INTERVAL ? MINUTE) AS baru, COUNT(*) AS harian,
            TIMESTAMPDIFF(SECOND, NOW(), MIN(CASE WHEN dibuat_pada > NOW() - INTERVAL ? MINUTE THEN dibuat_pada END)
              + INTERVAL ? MINUTE) AS tunggu_detik
     FROM transaksi WHERE id_pengguna = ? AND dibuat_pada > NOW() - INTERVAL 1 DAY`,
    [BATAS_TRANSAKSI.menit, BATAS_TRANSAKSI.menit, BATAS_TRANSAKSI.menit, req.user.id_pengguna]
  );
  if (Number(jml.harian) >= BATAS_TRANSAKSI_HARIAN)
    return galat(res, 429, `Batas ${BATAS_TRANSAKSI_HARIAN} transaksi per hari tercapai. Coba lagi besok.`, { kode: 'batas_transaksi' });
  if (Number(jml.baru) >= BATAS_TRANSAKSI.jumlah) {
    const menit = Math.max(1, Math.ceil(Number(jml.tunggu_detik) / 60));
    return galat(res, 429, `Terlalu banyak transaksi. Coba lagi dalam ${menit} menit.`, { kode: 'batas_transaksi' });
  }

  // transaksi menunggu sebelumnya dianggap batal (pengguna memilih paket/metode lain)
  await pool.query("UPDATE transaksi SET status = 'gagal' WHERE id_pengguna = ? AND status = 'menunggu'", [req.user.id_pengguna]);
  const kode = `VM${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const batas = new Date(Date.now() + BATAS_BAYAR_MENIT * 60000);
  const { referensi, instruksi } = gateway.buatTagihan({ kode, jumlah: Number(p.harga), metode, batas });
  const [r] = await pool.query(
    `INSERT INTO transaksi (id_pengguna,id_paket,kode_pesanan,metode_pembayaran,referensi_gateway,instruksi_bayar,jumlah,batas_waktu_bayar)
     VALUES (?,?,?,?,?,?,?,?)`,
    [req.user.id_pengguna, p.id_paket, kode, metode, referensi, JSON.stringify(instruksi), p.harga, batas]
  );
  const [[t]] = await pool.query('SELECT * FROM transaksi WHERE id_transaksi = ?', [r.insertId]);
  res.status(201).json(formatTransaksi(t));
});

// Status transaksi; sekaligus pemeriksaan berkala ke gateway bila notifikasi belum diterima.
app.get('/transaksi/:id', auth, async (req, res) => {
  const ambil = async () =>
    (await pool.query('SELECT * FROM transaksi WHERE id_transaksi = ? AND id_pengguna = ?', [req.params.id, req.user.id_pengguna]))[0][0];
  let t = await ambil();
  if (!t) return galat(res, 404, 'Transaksi tidak ditemukan.');
  if (t.status === 'menunggu') {
    const g = gateway.cekStatus(t.kode_pesanan);
    if (g && g.status !== 'menunggu' && gateway.verifikasi({ kode_pesanan: t.kode_pesanan, ...g }))
      await prosesPembayaran({ kode: t.kode_pesanan, status: g.status, jumlah: g.jumlah, referensi: g.referensi });
    else if (new Date(t.batas_waktu_bayar) <= new Date())
      await prosesPembayaran({ kode: t.kode_pesanan, status: 'kedaluwarsa' });
    t = await ambil();
  }
  res.json({ ...formatTransaksi(t), premium_berakhir: await akhirPremium(pool, req.user.id_pengguna) });
});

app.post('/transaksi/:id/batal', auth, async (req, res) => {
  const [[t]] = await pool.query('SELECT kode_pesanan, status FROM transaksi WHERE id_transaksi = ? AND id_pengguna = ?',
    [req.params.id, req.user.id_pengguna]);
  if (!t) return galat(res, 404, 'Transaksi tidak ditemukan.');
  if (t.status !== 'menunggu') return galat(res, 409, 'Transaksi sudah diproses.');
  await prosesPembayaran({ kode: t.kode_pesanan, status: 'gagal' });
  res.json({ pesan: 'Transaksi dibatalkan.' });
});

// Notifikasi status pembayaran dari Payment Gateway (tanpa token pengguna; keaslian dicek lewat tanda tangan).
app.post('/webhook/pembayaran', async (req, res) => {
  const n = req.body || {};
  if (!gateway.verifikasi(n)) {
    console.warn('[pembayaran] notifikasi tidak valid diabaikan:', JSON.stringify(n).slice(0, 200));
    return galat(res, 400, 'Notifikasi tidak valid.');
  }
  await prosesPembayaran({ kode: n.kode_pesanan, status: n.status, jumlah: n.jumlah, referensi: n.referensi });
  res.json({ pesan: 'OK' });
});

app.use('/simulasi', gateway.router);

// ---------- penjadwal: kedaluwarsa transaksi dan berakhirnya Premium ----------
async function penjadwal() {
  const sekarang = new Date();
  await pool.query("UPDATE transaksi SET status = 'kedaluwarsa' WHERE status = 'menunggu' AND batas_waktu_bayar <= ?", [sekarang]);
  const [r] = await pool.query("UPDATE langganan SET status = 'berakhir' WHERE status = 'aktif' AND tanggal_berakhir <= ?", [sekarang]);
  if (r.affectedRows) console.log(`[penjadwal] ${r.affectedRows} langganan berakhir`);
  // Premium berakhir: kustomisasi nonaktif (data tetap tersimpan)
  await pool.query(
    `UPDATE kustomisasi_kepribadian k SET k.status = 'nonaktif'
     WHERE k.status = 'aktif' AND NOT EXISTS (
       SELECT 1 FROM langganan l WHERE l.id_pengguna = k.id_pengguna AND l.status = 'aktif'
       AND l.tanggal_mulai <= ? AND l.tanggal_berakhir > ?)`,
    [sekarang, sekarang]
  );
  // Premium berakhir: suara ekspresif kembali ke suara standar (memori tidak dipakai, datanya tetap tersimpan)
  const [[standar]] = await pool.query("SELECT id_suara FROM suara WHERE jenis = 'standar' AND status = 'aktif' ORDER BY id_suara LIMIT 1");
  if (standar)
    await pool.query(
      `UPDATE pengaturan_pengguna g JOIN suara s ON s.id_suara = g.id_suara_aktif SET g.id_suara_aktif = ?
       WHERE s.jenis = 'ekspresif' AND NOT EXISTS (
         SELECT 1 FROM langganan l WHERE l.id_pengguna = g.id_pengguna AND l.status = 'aktif'
         AND l.tanggal_mulai <= ? AND l.tanggal_berakhir > ?)`,
      [standar.id_suara, sekarang, sekarang]
    );
}
const jalankanPenjadwal = () => penjadwal().catch((e) => console.error('Penjadwal:', e.message));
setInterval(jalankanPenjadwal, 60000);
jalankanPenjadwal();

// ---------- penanganan error ----------
app.use((err, req, res, next) => {
  console.error(err);
  galat(res, 500, 'Terjadi kesalahan di server.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('VocaMate server jalan di http://localhost:' + PORT));
