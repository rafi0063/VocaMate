const API = 'http://localhost:3000';
const AMBANG_PERINGATAN = 300; // detik; peringatan kuota hampir habis (FR-13)
const JEDA_ULANG = [1000, 2000, 4000]; // sambung ulang bertahap (SDD 3.2.2)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const $ = (id) => document.getElementById(id);

// ================= utilitas =================

// Membuat elemen DOM; teks selalu lewat textContent agar aman dari HTML.
function el(tag, attrs = {}, ...anak) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const a of anak) if (a != null) e.append(a);
  return e;
}

const fmtDurasi = (d) => `${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}`;
const fmtMenit = (d) => `${Math.floor(d / 60)} menit`;
const fmtTanggal = (t) =>
  new Date(t).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtRupiah = (n) => (Number(n) === 0 ? 'Gratis' : 'Rp' + Number(n).toLocaleString('id-ID'));

let timerNotif = null;
function notif(teks, jenis = 'info', lama = 6000) {
  const n = $('notif');
  n.textContent = teks;
  n.className = `notif ${jenis}`;
  clearTimeout(timerNotif);
  if (lama) timerNotif = setTimeout(() => n.classList.add('hidden'), lama);
}

// ================= penyimpanan lokal (chrome.storage.local, SDD 3.4.16) =================

const simpanLokal = (obj) => chrome.storage.local.set(obj);
const bacaLokal = async (k) => (await chrome.storage.local.get(k))[k];
const hapusLokal = (k) => chrome.storage.local.remove(k);

// ================= API server =================

let token = null;

class GalatApi extends Error {
  constructor(status, data) {
    super(data.pesan || `Terjadi kesalahan (HTTP ${status}). Coba jalankan ulang server.`);
    this.status = status;
    this.data = data;
  }
}

async function api(path, { method = 'GET', body, cekSesi = true } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new GalatApi(0, { pesan: 'Tidak dapat terhubung ke server VocaMate. Pastikan server sudah dijalankan.' });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && cekSesi) {
    await keluarLokal();
    notif(data.pesan || 'Sesi login berakhir. Silakan masuk lagi.', 'galat');
  }
  if (!res.ok) throw new GalatApi(res.status, data);
  return data;
}

// ================= navigasi =================

function tampilView(id) {
  for (const v of ['view-masuk', 'view-daftar', 'app']) $(v).classList.toggle('hidden', v !== id);
}

const PEMUAT = {
  'tab-bicara': () => { if (!sesi.id) muatKuota(); },
  'tab-persona': muatPersona,
  'tab-riwayat': muatRiwayat,
  'tab-memori': muatMemori,
  'tab-upgrade': muatPaket,
  'tab-akun': muatAkun,
};

function bukaTab(id) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== id));
  document.querySelectorAll('.menu-item').forEach((m) => m.classList.toggle('aktif', m.dataset.tab === id));
  PEMUAT[id]?.();
}

document.querySelectorAll('.menu-item').forEach((m) => m.addEventListener('click', () => bukaTab(m.dataset.tab)));
document.querySelectorAll('[data-ke]').forEach((b) => b.addEventListener('click', () => tampilView(b.dataset.ke)));

// ================= UC-01 Registrasi =================

$('form-daftar').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  f.nama = f.nama.trim();
  f.email = f.email.trim();
  if (!f.nama) return notif('Nama tidak boleh kosong atau hanya spasi.', 'galat');
  if (!/^\p{L}[\p{L} .'-]*$/u.test(f.nama))
    return notif('Nama hanya boleh berisi huruf, spasi, titik, apostrof, dan tanda hubung.', 'galat');
  if (f.password.length < 8 || !/[A-Za-z]/.test(f.password) || !/\d/.test(f.password))
    return notif('Password minimal 8 karakter, mengandung huruf dan angka.', 'galat');
  try {
    await api('/auth/register', { method: 'POST', body: f });
    e.target.reset();
    $('form-masuk').email.value = f.email;
    tampilView('view-masuk');
    notif('Akun berhasil dibuat. Silakan masuk.', 'sukses');
  } catch (err) {
    notif(err.message, 'galat');
  }
});

// ================= UC-02 Login dan Logout =================

$('form-masuk').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    const r = await api('/auth/login', { method: 'POST', body: f, cekSesi: false });
    token = r.token;
    await simpanLokal({ token });
    e.target.reset();
    $('notif').classList.add('hidden');
    masukApp();
  } catch (err) {
    notif(err.message, 'galat');
  }
});

function masukApp() {
  tampilView('app');
  bukaTab('tab-bicara');
  cekPengingatPremium();
}

async function keluarLokal() {
  token = null;
  hentikanPantau();
  await hapusLokal(['token', 'tertunda']);
  $('label-paket').classList.add('hidden');
  tampilView('view-masuk');
}

$('btn-keluar').addEventListener('click', async () => {
  if (sesi.id) await akhiriSesi('logout');
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* token tetap dihapus dari perangkat */ }
  await keluarLokal();
  notif('Kamu sudah keluar.', 'sukses');
});

// ================= Kuota =================

function renderKuota() {
  $('kuota-sisa').textContent = `${fmtDurasi(sesi.sisa)} / ${fmtMenit(sesi.total)}`;
  const persen = sesi.total ? (sesi.sisa / sesi.total) * 100 : 0;
  $('kuota-bar').style.width = persen + '%';
  $('kuota-bar').classList.toggle('rendah', sesi.sisa <= AMBANG_PERINGATAN);
}

function tampilPaket(nama) {
  $('label-paket').textContent = nama;
  $('label-paket').classList.remove('hidden');
}

async function muatKuota() {
  try {
    const k = await api('/kuota');
    sesi.sisa = k.sisa_kuota_detik;
    sesi.total = k.kuota_total_detik;
    renderKuota();
    tampilPaket(k.paket);
  } catch (err) {
    if (err.status !== 401) notif(err.message, 'galat');
  }
}

// ================= UC-06 Melakukan Percakapan Suara =================

const sesi = {
  id: null,
  dijeda: false,
  dibisukan: false,
  gangguan: false,
  durasi: 0,          // durasi aktif (tanpa jeda dan gangguan), dasar pengurangan kuota
  sisa: 0,
  total: 0,
  sudahPeringatan: false,
  sela: false,        // jawaban AI terakhir disela pengguna
  jawabanTerakhir: '',
  kodeSuara: 'id-ID',
  baca: { batas: null, pakai: 0 },
  antrian: Promise.resolve(),
  timer: null,
};
let pengenal = null;
let statusSekarang = 'idle';

const LABEL_STATUS = {
  idle: 'Siap',
  mendengarkan: 'Mendengarkan...',
  berpikir: 'Berpikir...',
  berbicara: 'Berbicara...',
  dijeda: 'Dijeda',
  dibisukan: 'Mikrofon dibisukan',
  gangguan: 'Koneksi terganggu, menyambung ulang...',
};

function setStatus(s) {
  statusSekarang = s;
  $('status-sesi').dataset.status = s;
  $('status-teks').textContent = LABEL_STATUS[s];
}

// status saat AI tidak sedang berpikir/berbicara
const statusDiam = () => (sesi.dijeda ? 'dijeda' : sesi.dibisukan ? 'dibisukan' : 'mendengarkan');

function tambahGelembung(wadah, penutur, teks, disela = false) {
  const g = el('div', { class: `gelembung ${penutur}` }, teks);
  if (disela) g.append(el('span', { class: 'disela' }, '(disela)'));
  wadah.append(g);
  g.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return g;
}

let gelembungSementara = null;
function tampilSementara(teks) {
  if (!gelembungSementara) gelembungSementara = tambahGelembung($('percakapan'), 'pengguna sementara', '');
  gelembungSementara.textContent = teks;
}
function hapusSementara() {
  gelembungSementara?.remove();
  gelembungSementara = null;
}

async function izinMikrofon() {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    return p.state;
  } catch {
    return 'prompt';
  }
}

$('btn-mulai').addEventListener('click', mulaiSesi);

async function mulaiSesi() {
  if (!SR) return notif('Peramban ini tidak mendukung pengenalan ucapan. Gunakan Google Chrome versi terbaru.', 'galat');

  // FR-03: izin mikrofon diminta lewat tab terpisah karena side panel tidak bisa menampilkan dialog izin
  if ((await izinMikrofon()) !== 'granted') {
    chrome.tabs.create({ url: chrome.runtime.getURL('izin.html') });
    return notif('Berikan izin mikrofon di tab yang baru dibuka, lalu klik "Mulai Bicara" lagi.', 'peringatan', 10000);
  }

  $('btn-mulai').disabled = true;
  try {
    const r = await api('/sesi', { method: 'POST' });
    Object.assign(sesi, {
      id: r.id_sesi,
      dijeda: false,
      dibisukan: false,
      gangguan: false,
      durasi: 0,
      sisa: r.sisa_kuota_detik,
      sudahPeringatan: false,
      sela: false,
      jawabanTerakhir: '',
      kodeSuara: r.kode_suara || 'id-ID',
      baca: { batas: r.batas_baca_layar, pakai: r.pemakaian_baca_layar },
      antrian: Promise.resolve(),
    });
    $('percakapan').replaceChildren();
    $('persona-aktif').textContent = `Persona: ${r.persona}${r.memori ? ' · Memori aktif' : ''}`;
    $('btn-jeda').textContent = 'Jeda';
    $('btn-bisu').textContent = 'Bisukan';
    $('kontrol-idle').classList.add('hidden');
    $('kontrol-sesi').classList.remove('hidden');
    renderBacaLayar();
    renderKuota();
    setStatus('mendengarkan');
    sesi.timer = setInterval(detik, 1000);
    pengenal = buatPengenal();
    dengarkan();
  } catch (err) {
    if (err.data?.kode === 'kuota_habis') {
      const reset = err.data.reset_pada ? ` Kuota direset pada ${fmtTanggal(err.data.reset_pada)}.` : '';
      notif(`Kuota waktu kamu sudah habis.${reset} Upgrade ke Premium untuk kuota lebih banyak.`, 'peringatan', 10000);
    } else if (err.status !== 401) {
      notif(err.message, 'galat');
    }
  } finally {
    $('btn-mulai').disabled = false;
  }
}

// Penghitung durasi aktif: tidak berjalan saat dijeda atau saat gangguan (FR-12, FR-24)
function detik() {
  if (!sesi.id || sesi.dijeda || sesi.gangguan) return;
  sesi.durasi++;
  sesi.sisa = Math.max(0, sesi.sisa - 1);
  renderKuota();
  if (!sesi.sudahPeringatan && sesi.sisa <= AMBANG_PERINGATAN) {
    sesi.sudahPeringatan = true;
    notif(`Sisa kuota tinggal ${fmtDurasi(sesi.sisa)}.`, 'peringatan');
  }
  if (sesi.sisa <= 0) akhiriSesi('kuota_habis');
}

// ---------- pengenalan ucapan (STT) ----------

const perluMendengar = () => sesi.id && !sesi.dijeda && !sesi.dibisukan;

function dengarkan() {
  try { pengenal.start(); } catch { /* sudah berjalan */ }
}

// Ucapan yang isinya bagian dari jawaban AI dianggap gema dari speaker, bukan ucapan pengguna.
function gema(teks) {
  const t = teks.toLowerCase().trim();
  return t.length > 0 && sesi.jawabanTerakhir.toLowerCase().includes(t);
}

function buatPengenal() {
  const r = new SR();
  r.lang = 'id-ID';
  r.continuous = true;
  r.interimResults = true;

  r.onresult = (e) => {
    let sementara = '';
    let akhir = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) akhir += t;
      else sementara += t;
    }
    const terdengar = (akhir || sementara).trim();
    // gema bisa datang sedikit setelah AI selesai bicara, jadi diperiksa di semua status
    if (gema(terdengar)) {
      if (akhir) hapusSementara();
      return;
    }

    // FR-05: pengguna berbicara saat AI berbicara -> hentikan suara AI
    if (statusSekarang === 'berbicara' && terdengar.length > 2) {
      speechSynthesis.cancel();
      sesi.sela = true;
      setStatus(statusDiam());
    }
    if (akhir.trim()) {
      hapusSementara();
      antre(akhir.trim());
    } else if (sementara) {
      tampilSementara(sementara);
    }
  };

  r.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      notif('Izin mikrofon ditolak. Aktifkan izin mikrofon untuk VocaMate.', 'galat');
      akhiriSesi('pengguna');
    } else if (e.error === 'no-match') {
      notif('Ucapan tidak dikenali, coba ulangi.', 'peringatan');
    } else if (e.error === 'network') {
      notif('Pengenalan ucapan butuh koneksi internet. Menyambung ulang...', 'peringatan');
    }
    // no-speech dan aborted: cukup didengarkan ulang lewat onend
  };

  // Chrome menghentikan pengenalan secara berkala; jalankan lagi selama sesi aktif (hands-free)
  r.onend = () => {
    if (perluMendengar()) setTimeout(() => perluMendengar() && dengarkan(), 250);
  };
  return r;
}

// Giliran bicara diproses berurutan agar jawaban tidak saling tumpang tindih.
function antre(teks, gambar) {
  sesi.antrian = sesi.antrian.then(() => kirimUcapan(teks, gambar));
  return sesi.antrian;
}

// cocok juga untuk "layarku", "layarnya", "liatin layar", dll.
const PERINTAH_BACA_LAYAR = /\b(baca(in|kan)?|lihat(in)?|liat(in)?|cek|jelasin|jelaskan)\b.*\blayar/i;

// Mengembalikan true bila AI berhasil menjawab.
async function kirimUcapan(teks, gambar) {
  if (!sesi.id) return false;
  if (!gambar && PERINTAH_BACA_LAYAR.test(teks)) return bacaLayar(teks);

  tambahGelembung($('percakapan'), 'pengguna', teks);
  setStatus('berpikir');
  try {
    const r = await kirimDenganUlang(`/sesi/${sesi.id}/pesan`, { teks, gambar, sela: sesi.sela });
    if (!sesi.id) return false;
    sesi.sela = false;
    const jawaban = r.jawaban.replace(/[*_#`]+/g, ''); // sisa format markdown tidak ikut tampil/dibacakan
    tambahGelembung($('percakapan'), 'ai', jawaban);
    bicara(jawaban);
    return true;
  } catch (err) {
    if (!sesi.id) return false;
    setStatus(statusDiam());
    if (err.data?.kode === 'batas_baca_layar') {
      sesi.baca.pakai = sesi.baca.batas;
      renderBacaLayar();
      notif('Batas baca layar periode ini sudah tercapai. Upgrade ke Premium untuk baca layar tanpa batas.', 'peringatan');
    } else if (err.status === 409) {
      notif('Sesi sudah berakhir.', 'galat');
      tutupSesiLokal();
    } else if (err.status !== 401) {
      notif(err.message, 'galat');
    }
    return false;
  }
}

// FR-24: saat server/AI tidak terjangkau, coba ulang bertahap; durasi tidak dihitung selama gangguan.
async function kirimDenganUlang(path, body) {
  for (let i = 0; ; i++) {
    try {
      const r = await api(path, { method: 'POST', body });
      if (sesi.gangguan) {
        sesi.gangguan = false;
        notif('Koneksi kembali normal.', 'sukses', 3000);
      }
      return r;
    } catch (err) {
      const bisaDiulang = err.status === 0 || err.data?.kode === 'ai_terganggu';
      if (!bisaDiulang || i >= JEDA_ULANG.length || !sesi.id) {
        sesi.gangguan = false;
        throw err;
      }
      sesi.gangguan = true;
      setStatus('gangguan');
      await new Promise((ok) => setTimeout(ok, JEDA_ULANG[i]));
    }
  }
}

// ---------- sintesis suara (TTS) ----------

let daftarSuara = [];
const muatSuara = () => (daftarSuara = speechSynthesis.getVoices());
speechSynthesis.addEventListener('voiceschanged', muatSuara);
muatSuara();

// Suara laki-laki Bahasa Indonesia yang dikenal (Windows: Andika; Edge: Ardi Online (Natural)).
const SUARA_LAKI = ['andika', 'ardi'];

// kode_suara_tts berisi nama suara peramban (misalnya "Google Bahasa Indonesia") atau kode bahasa ("id-ID").
// Bila suara dengan nama itu tidak ada di perangkat, dipakai suara Bahasa Indonesia lain. Untuk suara laki-laki,
// dicari dulu suara laki-laki lain; bila tidak ada sama sekali, suara cadangan diputar dengan nada lebih rendah.
// Mengembalikan { suara, nada }.
function pilihSuara(kode) {
  const k = kode.toLowerCase();
  const persis = daftarSuara.find((v) => v.name.toLowerCase().includes(k));
  if (persis) return { suara: persis, nada: 1 };
  const indo = daftarSuara.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith('id'));
  if (SUARA_LAKI.some((n) => k.includes(n))) {
    const laki = indo.find((v) => SUARA_LAKI.some((n) => v.name.toLowerCase().includes(n)));
    return { suara: laki || indo[0], nada: laki ? 1 : 0.5 };
  }
  return { suara: daftarSuara.find((v) => v.lang === kode) || indo[0], nada: 1 };
}

// Memutar teks per kalimat (ujaran panjang sering terpotong di Chrome); onSelesai dipanggil setelah kalimat terakhir.
function putarSuara(teks, kode, onSelesai) {
  speechSynthesis.cancel();
  const kalimat = teks.match(/[^.!?\n]+[.!?]*/g) || [teks];
  const { suara, nada } = pilihSuara(kode);
  kalimat.forEach((k, i) => {
    const u = new SpeechSynthesisUtterance(k.trim());
    u.lang = suara?.lang || 'id-ID';
    u.pitch = nada;
    if (suara) u.voice = suara;
    if (i === kalimat.length - 1 && onSelesai) u.onend = onSelesai;
    speechSynthesis.speak(u);
  });
}

function bicara(teks) {
  sesi.jawabanTerakhir = teks;
  setStatus('berbicara');
  putarSuara(teks, sesi.kodeSuara, () => {
    if (statusSekarang === 'berbicara') setStatus(statusDiam());
  });
}

// ---------- kontrol sesi (FR-07) ----------

$('btn-jeda').addEventListener('click', () => {
  sesi.dijeda = !sesi.dijeda;
  if (sesi.dijeda) {
    pengenal.abort();
    speechSynthesis.cancel();
  } else if (!sesi.dibisukan) {
    dengarkan();
  }
  $('btn-jeda').textContent = sesi.dijeda ? 'Lanjutkan' : 'Jeda';
  setStatus(statusDiam());
});

// Bisukan: mikrofon mati, sesi tetap aktif dan durasi tetap dihitung
$('btn-bisu').addEventListener('click', () => {
  sesi.dibisukan = !sesi.dibisukan;
  if (sesi.dibisukan) pengenal.abort();
  else if (!sesi.dijeda) dengarkan();
  $('btn-bisu').textContent = sesi.dibisukan ? 'Bunyikan' : 'Bisukan';
  if (statusSekarang !== 'berpikir' && statusSekarang !== 'berbicara') setStatus(statusDiam());
});

$('btn-akhiri').addEventListener('click', () => akhiriSesi('pengguna'));

function tutupSesiLokal() {
  sesi.id = null;
  clearInterval(sesi.timer);
  pengenal?.abort();
  pengenal = null;
  speechSynthesis.cancel();
  hapusSementara();
  $('kontrol-sesi').classList.add('hidden');
  $('kontrol-idle').classList.remove('hidden');
  $('persona-aktif').textContent = '';
  setStatus('idle');
}

async function akhiriSesi(alasan) {
  const id = sesi.id;
  if (!id) return;
  const durasi = sesi.durasi;
  tutupSesiLokal(); // mikrofon langsung dimatikan
  try {
    const r = await api(`/sesi/${id}/akhiri`, { method: 'POST', body: { durasi_aktif_detik: durasi, alasan } });
    sesi.sisa = r.sisa_kuota_detik;
    renderKuota();
    const awal = alasan === 'kuota_habis' ? 'Kuota habis, sesi diakhiri otomatis.' : 'Sesi selesai.';
    notif(`${awal} Durasi ${fmtDurasi(r.durasi_aktif_detik)}, sisa kuota ${fmtDurasi(r.sisa_kuota_detik)}.`, 'sukses', 8000);
  } catch (err) {
    if (err.status === 0) {
      // disimpan di perangkat lalu disinkronkan saat koneksi kembali (FR-24)
      await simpanLokal({ tertunda: { id, durasi, alasan } });
      notif('Server tidak terjangkau. Data sesi disimpan dan akan disinkronkan nanti.', 'peringatan');
    } else if (err.status !== 401) {
      notif(err.message, 'galat');
    }
  }
}

async function sinkronTertunda() {
  const t = await bacaLokal('tertunda');
  if (!t || !token) return;
  try {
    await api(`/sesi/${t.id}/akhiri`, { method: 'POST', body: { durasi_aktif_detik: t.durasi, alasan: t.alasan } });
    await hapusLokal('tertunda');
  } catch (err) {
    if (err.status !== 0) await hapusLokal('tertunda'); // sesi sudah ditutup server
  }
}
window.addEventListener('online', sinkronTertunda);

// Panel ditutup saat sesi berjalan: kirim durasi aktif lewat request keepalive.
window.addEventListener('pagehide', () => {
  if (!sesi.id || !token) return;
  fetch(`${API}/sesi/${sesi.id}/akhiri`, {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ durasi_aktif_detik: sesi.durasi, alasan: 'pengguna' }),
  });
});

// ================= UC-07 Membaca Konteks Layar =================

function renderBacaLayar() {
  const { batas, pakai } = sesi.baca;
  $('info-baca-layar').textContent =
    batas === null ? 'Baca layar tanpa batas' : `Baca layar: ${pakai} dari ${batas} kali periode ini`;
}

// Memperkecil tangkapan layar sebelum dikirim (NFR-03); hasilnya base64 JPEG tanpa awalan data URL.
function perkecil(dataUrl, lebarMaks = 1280) {
  return new Promise((ok, gagal) => {
    const img = new Image();
    img.onload = () => {
      const skala = Math.min(1, lebarMaks / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * skala);
      c.height = Math.round(img.height * skala);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      ok(c.toDataURL('image/jpeg', 0.7).split(',')[1]);
    };
    img.onerror = gagal;
    img.src = dataUrl;
  });
}

$('btn-baca-layar').addEventListener('click', () => {
  sesi.antrian = sesi.antrian.then(() => bacaLayar());
});

async function bacaLayar(teks) {
  if (!sesi.id) return false;
  const { batas, pakai } = sesi.baca;
  if (batas !== null && pakai >= batas) {
    notif('Batas baca layar periode ini sudah tercapai. Upgrade ke Premium untuk baca layar tanpa batas.', 'peringatan');
    return false;
  }

  let gambar;
  try {
    const jendela = await chrome.windows.getCurrent();
    const dataUrl = await chrome.tabs.captureVisibleTab(jendela.id, { format: 'jpeg', quality: 80 });
    gambar = await perkecil(dataUrl);
  } catch {
    notif('Layar tidak dapat dibaca. Halaman internal peramban (misalnya chrome://) tidak bisa ditangkap.', 'galat');
    return false;
  }

  // tangkapan layar hanya ada di variabel lokal ini dan tidak disimpan (NFR-06)
  const berhasil = await kirimUcapan(teks || 'Tolong lihat layar saya dan jelaskan apa yang sedang tampil.', gambar);
  if (berhasil) {
    sesi.baca.pakai++;
    renderBacaLayar();
  }
  return berhasil;
}

// ================= UC-05 Memilih Persona dan Suara =================

let dataPersonalisasi = null;
let personaKustom = null; // persona yang sedang dikustomisasi

const ringkasKustomisasi = (k) => [k.nama_panggilan, k.sifat, k.gaya_bicara].filter(Boolean).join(' · ');

async function muatPersona() {
  try {
    const r = await api('/personalisasi');
    dataPersonalisasi = r;
    $('daftar-persona').replaceChildren(
      ...r.persona.map((p) => {
        const kk = r.kustomisasi.find((k) => k.id_persona_dasar === p.id_persona);
        return el('label', { class: 'opsi' },
          el('input', { type: 'radio', name: 'persona', value: p.id_persona, checked: p.id_persona === r.id_persona_aktif }),
          el('span', { class: 'isi' },
            el('b', {}, p.nama_persona),
            p.deskripsi || '',
            kk ? el('span', { class: 'ringkas' },
              `Kustomisasi${kk.status === 'nonaktif' || !r.premium ? ' (nonaktif)' : ''}: ${ringkasKustomisasi(kk)}`) : null,
            el('button', {
              type: 'button',
              class: 'tautan',
              onclick: (e) => {
                e.preventDefault();
                bukaKustomisasi(p);
              },
            }, r.premium ? 'Kustomisasi kepribadian' : 'Kustomisasi kepribadian (Premium)')));
      })
    );
    $('daftar-suara').replaceChildren(
      ...r.suara.map((s) => {
        const terkunci = s.jenis === 'ekspresif' && !r.premium;
        return el('label', { class: 'opsi' + (terkunci ? ' terkunci' : '') },
          el('input', { type: 'radio', name: 'suara', value: s.id_suara, checked: s.id_suara === r.id_suara_aktif, disabled: terkunci }),
          el('span', { class: 'isi' },
            el('b', {}, s.nama_suara + (s.jenis === 'ekspresif' ? ' (Premium)' : '')),
            s.deskripsi || '',
            el('br'),
            el('button', {
              type: 'button',
              class: 'tautan',
              onclick: (e) => {
                e.preventDefault();
                if (sesi.id) return notif('Pratinjau tidak tersedia saat sesi percakapan berjalan.', 'peringatan');
                putarSuara('Halo, aku VocaMate. Senang bisa ngobrol denganmu.', s.kode_suara_tts || 'id-ID');
              },
            }, 'Dengarkan pratinjau')));
      })
    );
  } catch (err) {
    if (err.status !== 401) notif(err.message, 'galat');
  }
}

$('btn-simpan-persona').addEventListener('click', async () => {
  const persona = document.querySelector('input[name="persona"]:checked');
  const suara = document.querySelector('input[name="suara"]:checked');
  if (!persona) return notif('Pilih salah satu persona.', 'galat');
  try {
    await api('/personalisasi', {
      method: 'PUT',
      body: { id_persona: Number(persona.value), id_suara: suara ? Number(suara.value) : undefined },
    });
    notif('Tersimpan. Pengaturan berlaku pada sesi berikutnya.', 'sukses');
  } catch (err) {
    if (err.status !== 401) notif(err.message, 'galat');
  }
});

// ---------- kustomisasi kepribadian AI (Premium, FR-20) ----------

function bukaKustomisasi(p) {
  personaKustom = p;
  const r = dataPersonalisasi;
  const kk = r.kustomisasi.find((k) => k.id_persona_dasar === p.id_persona);
  $('judul-kustomisasi').textContent = `Kustomisasi ${p.nama_persona}`;
  const f = $('form-kepribadian');
  for (const k of ['nama_panggilan', 'sifat', 'gaya_bicara']) f[k].value = kk?.[k] || '';
  $('isian-kustomisasi').disabled = !r.premium;

  const info = $('info-kustomisasi');
  info.replaceChildren();
  if (!r.premium) {
    info.append('Kustomisasi kepribadian khusus Pengguna Premium. ',
      el('button', { class: 'tautan', onclick: () => bukaTab('tab-upgrade') }, 'Upgrade ke Premium'));
    if (kk) info.append(el('br'), 'Kustomisasimu tetap tersimpan dan aktif lagi saat Premium diperpanjang.');
  }
  info.classList.toggle('hidden', !info.childNodes.length);
  $('btn-reset-kustomisasi').classList.toggle('hidden', !kk);
  $('panel-kustomisasi').classList.remove('hidden');
  $('panel-kustomisasi').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function tutupKustomisasi() {
  personaKustom = null;
  $('panel-kustomisasi').classList.add('hidden');
}

$('btn-tutup-kustomisasi').addEventListener('click', tutupKustomisasi);

$('form-kepribadian').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!personaKustom) return;
  // kustomisasi sesi yang sedang berjalan tidak boleh berubah di tengah percakapan
  if (sesi.id) return notif('Akhiri sesi percakapan dulu sebelum mengubah kustomisasi.', 'peringatan');
  const isi = Object.fromEntries(new FormData(e.target));
  if (!Object.values(isi).some((v) => v.trim())) return notif('Isi minimal satu kolom kustomisasi.', 'galat');
  try {
    const r = await api(`/kustomisasi/${personaKustom.id_persona}`, { method: 'PUT', body: isi });
    notif(r.pesan, 'sukses');
    tutupKustomisasi();
    muatPersona();
  } catch (err) {
    if (err.status !== 401) notif(err.message, 'galat');
  }
});

$('btn-reset-kustomisasi').addEventListener('click', async () => {
  if (!personaKustom || !confirm(`Kembalikan kepribadian ${personaKustom.nama_persona} ke bawaan?`)) return;
  if (sesi.id) return notif('Akhiri sesi percakapan dulu sebelum mengubah kustomisasi.', 'peringatan');
  try {
    const r = await api(`/kustomisasi/${personaKustom.id_persona}`, { method: 'DELETE' });
    notif(r.pesan, 'sukses');
    tutupKustomisasi();
    muatPersona();
  } catch (err) {
    if (err.status !== 401) notif(err.message, 'galat');
  }
});

// ================= UC-08 Riwayat =================

let riwayatTerpilih = null;

async function muatRiwayat() {
  $('riwayat-detail').classList.add('hidden');
  $('riwayat-daftar').classList.remove('hidden');
  try {
    const r = await api('/riwayat');
    if (!r.sesi.length) {
      $('riwayat-daftar').replaceChildren(el('p', { class: 'redup' }, 'Riwayat percakapan masih kosong.'));
      return;
    }
    $('riwayat-daftar').replaceChildren(
      ...r.sesi.map((s) =>
        el('button', { class: 'item', onclick: () => bukaRiwayat(s.id_sesi) },
          el('b', {}, s.nama_persona),
          el('div', { class: 'meta' }, `${fmtTanggal(s.waktu_mulai)} · ${fmtDurasi(s.durasi_aktif_detik)}`))
      )
    );
  } catch (err) {
    if (err.status !== 401) notif(err.message, 'galat');
  }
}

async function bukaRiwayat(id) {
  try {
    const r = await api(`/riwayat/${id}`);
    riwayatTerpilih = id;
    $('riwayat-judul').textContent = `${r.persona} · ${fmtTanggal(r.waktu_mulai)}`;
    const wadah = $('riwayat-transkrip');
    wadah.replaceChildren();
    if (!r.transkrip.length) wadah.append(el('p', { class: 'redup' }, 'Sesi ini tidak memiliki transkrip.'));
    r.transkrip.forEach((t) => tambahGelembung(wadah, t.penutur, t.isi_teks, t.disela));
    $('riwayat-daftar').classList.add('hidden');
    $('riwayat-detail').classList.remove('hidden');
    window.scrollTo(0, 0);
  } catch (err) {
    if (err.status !== 401) notif(err.message, 'galat');
  }
}

$('btn-kembali-riwayat').addEventListener('click', muatRiwayat);

$('btn-hapus-riwayat').addEventListener('click', async () => {
  if (!confirm('Hapus sesi ini beserta transkripnya?')) return;
  try {
    await api(`/riwayat/${riwayatTerpilih}`, { method: 'DELETE' });
    notif('Riwayat dihapus.', 'sukses');
    muatRiwayat();
  } catch (err) {
    if (err.status !== 401) notif(err.message, 'galat');
  }
});

// ================= UC-09 Berlangganan Paket Premium =================

const NAMA_METODE = { qris: 'QRIS', ewallet: 'E-wallet', va: 'Virtual Account' };
const JEDA_PANTAU = 3000; // pemeriksaan status pembayaran berkala
let transaksi = null;
let timerPantau = null;

const fiturPaket = (p) => [
  `Kuota ${p.kuota_menit} menit per periode ${p.periode_reset}`,
  `Baca layar ${p.batas_baca_layar === null ? 'tanpa batas' : p.batas_baca_layar + ' kali per periode'}`,
  ...(Number(p.harga) > 0
    ? ['Suara ekspresif yang lebih natural', 'Memori jangka panjang']
    : ['Persona Teman, Pacar Virtual, dan Mentor', 'Suara standar']),
];

async function muatPaket() {
  try {
    const [r, l] = await Promise.all([api('/paket'), api('/langganan')]);
    tampilStatusLangganan(l);
    $('daftar-paket').replaceChildren(
      ...r.paket.map((p) => {
        const berbayar = Number(p.harga) > 0;
        const kini = berbayar ? l.premium : !l.premium;
        const isi = el('span', { class: 'isi' },
          el('b', {}, `${p.nama_paket}${kini ? ' · Paket kamu' : ''}`),
          `${fmtRupiah(p.harga)}${p.durasi_hari ? ` / ${p.durasi_hari} hari` : ''}`,
          el('ul', { class: 'fitur' }, ...fiturPaket(p).map((f) => el('li', {}, f))));
        return berbayar
          ? el('label', { class: 'opsi' }, el('input', { type: 'radio', name: 'paket', value: p.id_paket, 'data-harga': p.harga }), isi)
          : el('div', { class: 'opsi statis' }, isi);
      })
    );
    const pertama = document.querySelector('input[name="paket"]');
    if (pertama) pertama.checked = true;
    $('btn-bayar').textContent = l.premium ? 'Perpanjang Premium' : 'Upgrade ke Premium';
    if (l.transaksi_menunggu) tampilInstruksi(l.transaksi_menunggu);
    else tampilFormBayar(Boolean(pertama));
  } catch (err) {
    if (err.status !== 401) notif(err.message, 'galat');
  }
}

function tampilStatusLangganan(l) {
  const kotak = $('status-langganan');
  kotak.classList.toggle('premium', l.premium);
  if (!l.premium) return (kotak.textContent = 'Kamu memakai paket Free.');
  const sisaHari = Math.ceil((new Date(l.berakhir) - Date.now()) / 86400000);
  kotak.textContent = `Premium aktif sampai ${fmtTanggal(l.berakhir)}` +
    (sisaHari <= 3 ? ` (tinggal ${sisaHari} hari, segera perpanjang).` : '.');
}

function tampilFormBayar(ada) {
  hentikanPantau();
  transaksi = null;
  $('form-bayar').classList.toggle('hidden', !ada);
  $('instruksi-bayar').classList.add('hidden');
}

$('btn-bayar').addEventListener('click', async () => {
  const paket = document.querySelector('input[name="paket"]:checked');
  const metode = document.querySelector('input[name="metode"]:checked');
  if (!paket || !metode) return notif('Pilih paket dan metode pembayaran.', 'galat');
  $('btn-bayar').disabled = true;
  try {
    const t = await api('/transaksi', { method: 'POST', body: { id_paket: Number(paket.value), metode: metode.value } });
    tampilInstruksi(t);
  } catch (err) {
    if (err.status !== 401) notif(err.message, 'galat');
  } finally {
    $('btn-bayar').disabled = false;
  }
});

function tampilInstruksi(t) {
  transaksi = t;
  const ins = t.instruksi || {};
  const baris = [
    ['Kode pesanan', t.kode_pesanan],
    ['Jumlah', fmtRupiah(t.jumlah)],
    ['Metode', NAMA_METODE[t.metode]],
    ...(t.metode === 'qris' ? [['Kode QRIS', el('span', { class: 'kode' }, ins.kode_qris || '-')]] : []),
    ...(t.metode === 'va' ? [['Bank', ins.bank], ['Nomor VA', el('span', { class: 'kode' }, ins.nomor_va || '-')]] : []),
    ['Bayar sebelum', el('span', { id: 'hitung-mundur' })],
  ];
  $('info-transaksi').replaceChildren(...baris.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
  $('btn-buka-bayar').textContent = ins.judul ? `${ins.judul} (simulasi)` : 'Buka Halaman Pembayaran';
  $('status-bayar').textContent = 'Menunggu konfirmasi pembayaran...';
  $('form-bayar').classList.add('hidden');
  $('instruksi-bayar').classList.remove('hidden');
  hentikanPantau();
  timerPantau = setInterval(pantauPembayaran, JEDA_PANTAU);
  perbaruiHitungMundur();
}

function perbaruiHitungMundur() {
  const sisa = Math.max(0, Math.floor((new Date(transaksi.batas_waktu_bayar) - Date.now()) / 1000));
  const e = $('hitung-mundur');
  if (e) e.textContent = `${fmtTanggal(transaksi.batas_waktu_bayar)} (${fmtDurasi(sisa)} lagi)`;
}

function hentikanPantau() {
  clearInterval(timerPantau);
  timerPantau = null;
}

async function pantauPembayaran() {
  if (!transaksi || !token) return hentikanPantau();
  perbaruiHitungMundur();
  try {
    const t = await api(`/transaksi/${transaksi.id_transaksi}`);
    if (t.status === 'menunggu') return;
    hentikanPantau();
    if (t.status === 'berhasil') {
      notif(`Pembayaran berhasil. Premium aktif sampai ${fmtTanggal(t.premium_berakhir)}.`, 'sukses', 10000);
      muatKuota(); // label paket di header ikut diperbarui
    } else {
      notif(t.status === 'kedaluwarsa'
        ? 'Batas waktu pembayaran habis. Silakan buat pembayaran baru.'
        : 'Pembayaran gagal atau dibatalkan. Kamu bisa memilih metode lain.', 'peringatan', 10000);
    }
    muatPaket();
  } catch (err) {
    if (err.status === 401) hentikanPantau();
    // gangguan koneksi: dicoba lagi pada pemeriksaan berikutnya
  }
}

$('btn-buka-bayar').addEventListener('click', () => {
  if (transaksi?.instruksi?.url) chrome.tabs.create({ url: transaksi.instruksi.url });
});

$('btn-batal-bayar').addEventListener('click', async () => {
  if (!transaksi || !confirm('Batalkan pembayaran ini?')) return;
  try {
    await api(`/transaksi/${transaksi.id_transaksi}/batal`, { method: 'POST' });
    notif('Pembayaran dibatalkan.', 'info');
  } catch (err) {
    if (err.status !== 401 && err.status !== 409) notif(err.message, 'galat');
  }
  muatPaket();
});

// Pengingat sebelum masa Premium berakhir (dikirim sekali oleh server).
async function cekPengingatPremium() {
  try {
    const l = await api('/langganan');
    if (l.pengingat)
      notif(`Premium kamu berakhir pada ${fmtTanggal(l.berakhir)}. Perpanjang di menu Upgrade agar fitur Premium tetap aktif.`, 'peringatan', 12000);
  } catch { /* tidak mengganggu pemakaian */ }
}

// ================= UC-08 Memori Jangka Panjang =================

let infoMemori = { premium: false, memori_aktif: false };

async function muatMemori() {
  try {
    const r = await api('/memori');
    infoMemori = r;
    $('sakelar-memori').checked = r.memori_aktif;
    // mengaktifkan khusus Premium; menonaktifkan selalu boleh
    $('sakelar-memori').disabled = !r.premium && !r.memori_aktif;

    const info = $('info-memori');
    info.replaceChildren();
    if (!r.premium) {
      info.append('Memori jangka panjang khusus Pengguna Premium. ',
        el('button', { class: 'tautan', onclick: () => bukaTab('tab-upgrade') }, 'Upgrade ke Premium'));
      if (r.butir.length) info.append(el('br'), 'Memori yang tersimpan tidak dipakai selama Premium tidak aktif, tetapi tetap bisa kamu hapus.');
    } else if (!r.memori_aktif) {
      info.textContent = 'Memori sedang nonaktif: AI tidak mencatat atau memakai memori.';
    }
    info.classList.toggle('hidden', !info.childNodes.length);

    $('btn-hapus-semua-memori').classList.toggle('hidden', !r.butir.length);
    if (!r.butir.length) {
      $('daftar-memori').replaceChildren(el('p', { class: 'redup' }, 'Memori masih kosong.'));
      return;
    }
    $('daftar-memori').replaceChildren(...r.butir.map(itemMemori));
  } catch (err) {
    if (err.status !== 401) notif(err.message, 'galat');
  }
}

function itemMemori(m) {
  const item = el('div', { class: 'item statis' });
  const tampil = () => item.replaceChildren(
    el('div', {}, m.isi_memori),
    el('div', { class: 'meta' }, `Dicatat ${fmtTanggal(m.dibuat_pada)}`),
    el('div', { class: 'aksi' },
      infoMemori.premium ? el('button', { class: 'tautan', onclick: ubah }, 'Ubah') : null,
      el('button', { class: 'tautan bahaya', onclick: hapus }, 'Hapus'))
  );
  function ubah() {
    const isian = el('textarea', { maxlength: 500 });
    isian.value = m.isi_memori;
    item.replaceChildren(isian, el('div', { class: 'aksi' },
      el('button', { class: 'tautan', onclick: () => simpan(isian.value) }, 'Simpan'),
      el('button', { class: 'tautan', onclick: tampil }, 'Batal')));
    isian.focus();
  }
  async function simpan(isi) {
    if (!isi.trim()) return notif('Isi memori tidak boleh kosong.', 'galat');
    try {
      await api(`/memori/${m.id_memori}`, { method: 'PUT', body: { isi_memori: isi } });
      m.isi_memori = isi.trim();
      tampil();
      notif('Memori diperbarui.', 'sukses');
    } catch (err) {
      if (err.status !== 401) notif(err.message, 'galat');
    }
  }
  async function hapus() {
    if (!confirm('Hapus butir memori ini?')) return;
    try {
      await api(`/memori/${m.id_memori}`, { method: 'DELETE' });
      notif('Memori dihapus.', 'sukses');
      muatMemori();
    } catch (err) {
      if (err.status !== 401) notif(err.message, 'galat');
    }
  }
  tampil();
  return item;
}

$('sakelar-memori').addEventListener('change', async (e) => {
  const aktif = e.target.checked;
  try {
    const r = await api('/memori/pengaturan', { method: 'PUT', body: { aktif } });
    notif(r.pesan + ' Berlaku pada sesi berikutnya.', 'sukses');
  } catch (err) {
    e.target.checked = !aktif;
    if (err.status !== 401) notif(err.message, 'galat');
  }
  muatMemori();
});

$('btn-hapus-semua-memori').addEventListener('click', async () => {
  if (!confirm('Hapus semua memori? Tindakan ini tidak bisa dibatalkan.')) return;
  try {
    const r = await api('/memori', { method: 'DELETE' });
    notif(r.pesan, 'sukses');
    muatMemori();
  } catch (err) {
    if (err.status !== 401) notif(err.message, 'galat');
  }
});

// ================= UC-03 Melihat Informasi Akun =================

async function muatAkun() {
  try {
    const a = await api('/akun');
    const baris = [
      ['Nama', a.nama],
      ['Email', a.email],
      ['Paket', a.paket],
      ['Sisa kuota', `${fmtDurasi(a.sisa_kuota_detik)} dari ${fmtMenit(a.kuota_total_detik)}`],
      ['Reset kuota', fmtTanggal(a.reset_pada)],
      ['Baca layar', a.batas_baca_layar === null ? 'Tanpa batas' : `${a.pemakaian_baca_layar} dari ${a.batas_baca_layar} kali`],
      ['Masa Premium', a.premium_berakhir ? fmtTanggal(a.premium_berakhir) : 'Tidak aktif'],
    ];
    $('info-akun').replaceChildren(...baris.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
    tampilPaket(a.paket);
  } catch (err) {
    if (err.status !== 401) notif(err.message, 'galat');
  }
}

// ================= UC-04 Menghapus Akun =================

$('form-hapus-akun').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!confirm('Akun dan seluruh data pribadimu akan dihapus permanen. Lanjutkan?')) return;
  const { password } = Object.fromEntries(new FormData(e.target));
  if (sesi.id) await akhiriSesi('hapus_akun');
  try {
    await api('/akun', { method: 'DELETE', body: { password }, cekSesi: false });
    e.target.reset();
    await keluarLokal();
    notif('Akunmu sudah dihapus.', 'sukses');
  } catch (err) {
    notif(err.message, 'galat');
  }
});

// ================= mulai =================

(async function init() {
  token = await bacaLokal('token');
  if (!token) return tampilView('view-masuk');
  await sinkronTertunda();
  masukApp();
})();
