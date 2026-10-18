// Side panel tidak dapat menampilkan dialog izin mikrofon, jadi izin diminta
// sekali dari tab ini (FR-03). Setelah diberikan, izin berlaku untuk seluruh ekstensi.
const pesan = document.getElementById('pesan-izin');

async function mintaIzin() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // mikrofon langsung dimatikan lagi
    pesan.textContent = 'Izin mikrofon sudah diberikan. Tab ini akan ditutup; kembali ke panel VocaMate lalu klik "Mulai Bicara".';
    setTimeout(() => window.close(), 2000);
  } catch {
    pesan.textContent = 'Izin mikrofon ditolak. Klik ikon gembok/kamera di bilah alamat, izinkan mikrofon, lalu klik "Minta izin lagi".';
  }
}

document.getElementById('btn-izin').addEventListener('click', mintaIzin);
mintaIzin();
