// Adapter AI (NFR-14): satu-satunya modul yang tahu penyedia LLM (Google Gemini).
// Ganti isi file ini untuk berpindah penyedia tanpa mengubah modul lain.
const { GoogleGenAI, ApiError } = require('@google/genai');

// Flash-Lite: respons cepat (NFR-01) dan kuota gratis lebih longgar daripada Flash.
const MODEL = process.env.AI_MODEL || 'gemini-flash-lite-latest';
// Ditambahkan ke instruksi persona: jawaban diucapkan lewat TTS, dan tangkapan layar bisa ikut dikirim (UC-06).
const ATURAN_SUARA =
  ' Jawabanmu akan diucapkan dengan suara, jadi tulis dalam teks biasa tanpa markdown, simbol, atau daftar berpoin.' +
  ' Jika pengguna menyertakan gambar, itu adalah tangkapan layar tab yang sedang ia buka; jelaskan isinya sesuai pertanyaannya.' +
  ' Jika tidak ada gambar dan pengguna minta kamu melihat layarnya, sarankan ia menekan tombol "Baca Layar".';
let client = null;

function tersedia() {
  return Boolean(process.env.GEMINI_API_KEY);
}

// riwayat: [{ penutur: 'pengguna' | 'ai', isi_teks }], urut dari terlama.
// gambar: base64 JPEG tangkapan layar (opsional, untuk UC-06).
// Mengembalikan { teks, ditolak } — ditolak = jawaban diblokir filter keamanan Gemini.
async function balas({ instruksi, riwayat, teks, gambar }) {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const contents = riwayat.map((t) => ({
    role: t.penutur === 'ai' ? 'model' : 'user',
    parts: [{ text: t.isi_teks }],
  }));
  const parts = [];
  if (gambar) parts.push({ inlineData: { mimeType: 'image/jpeg', data: gambar } });
  parts.push({ text: teks });
  contents.push({ role: 'user', parts });

  const res = await client.models.generateContent({
    model: MODEL,
    contents,
    config: { systemInstruction: instruksi + ATURAN_SUARA },
  });

  const finish = res.candidates?.[0]?.finishReason;
  if (res.promptFeedback?.blockReason || finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT')
    return { teks: '', ditolak: true };
  return { teks: (res.text || '').trim(), ditolak: false };
}

module.exports = { tersedia, balas, APIError: ApiError };
