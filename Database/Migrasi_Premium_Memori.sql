-- Migrasi untuk basis data yang sudah ada: menambah fitur Upgrade Premium (UC-09), Memori (UC-08),
-- dan kustomisasi kepribadian AI (UC-05)
-- tanpa menghapus data. Jalankan sekali saja. Instalasi baru cukup Create_table.sql + Insert.sql.
USE vocamate;
-- UC-09: transaksi pembayaran Premium. Tidak menyimpan data kartu/rekening (NFR-15);
-- id_pengguna dikosongkan saat akun dihapus (anonimisasi).
CREATE TABLE IF NOT EXISTS transaksi (
  id_transaksi BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_pengguna BIGINT NULL,
  id_paket INT NOT NULL,
  kode_pesanan VARCHAR(50) NOT NULL UNIQUE,
  metode_pembayaran ENUM('qris','ewallet','va') NOT NULL,
  referensi_gateway VARCHAR(100) NULL,
  instruksi_bayar JSON NULL,
  jumlah DECIMAL(12,2) NOT NULL,
  status ENUM('menunggu','berhasil','gagal','kedaluwarsa') NOT NULL DEFAULT 'menunggu',
  batas_waktu_bayar DATETIME NOT NULL,
  dibuat_pada DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  diperbarui_pada DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (id_pengguna) REFERENCES pengguna(id_pengguna) ON DELETE SET NULL,
  FOREIGN KEY (id_paket) REFERENCES paket(id_paket)
);

-- Satu transaksi berhasil = satu langganan; perpanjangan dimulai dari tanggal berakhir langganan sebelumnya.
CREATE TABLE IF NOT EXISTS langganan (
  id_langganan BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_pengguna BIGINT NULL,
  id_paket INT NOT NULL,
  id_transaksi BIGINT NOT NULL UNIQUE,
  tanggal_mulai DATETIME NOT NULL,
  tanggal_berakhir DATETIME NOT NULL,
  status ENUM('aktif','berakhir') NOT NULL DEFAULT 'aktif',
  pengingat_terkirim BOOLEAN NOT NULL DEFAULT FALSE,
  INDEX (id_pengguna, status),
  FOREIGN KEY (id_pengguna) REFERENCES pengguna(id_pengguna) ON DELETE SET NULL,
  FOREIGN KEY (id_paket) REFERENCES paket(id_paket),
  FOREIGN KEY (id_transaksi) REFERENCES transaksi(id_transaksi)
);

-- UC-08: butir memori jangka panjang (Premium)
CREATE TABLE IF NOT EXISTS memori (
  id_memori BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_pengguna BIGINT NOT NULL,
  id_sesi_sumber BIGINT NULL,
  isi_memori TEXT NOT NULL,
  status ENUM('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
  dibuat_pada DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  diperbarui_pada DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (id_pengguna) REFERENCES pengguna(id_pengguna) ON DELETE CASCADE,
  FOREIGN KEY (id_sesi_sumber) REFERENCES sesi_percakapan(id_sesi) ON DELETE SET NULL
);

INSERT INTO paket (nama_paket, harga, durasi_hari, kuota_menit, batas_baca_layar, periode_reset)
SELECT 'Premium', 49000, 30, 120, NULL, 'harian' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM paket WHERE nama_paket = 'Premium');

INSERT INTO suara (nama_suara, deskripsi, kode_suara_tts, jenis)
SELECT 'Gadis (Natural)', 'Suara perempuan natural Microsoft Gadis (Microsoft Edge)', 'Microsoft Gadis Online', 'ekspresif' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM suara WHERE kode_suara_tts = 'Microsoft Gadis Online');

INSERT INTO suara (nama_suara, deskripsi, kode_suara_tts, jenis)
SELECT 'Ardi (Natural)', 'Suara laki-laki natural Microsoft Ardi (Microsoft Edge)', 'Microsoft Ardi Online', 'ekspresif' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM suara WHERE kode_suara_tts = 'Microsoft Ardi Online');

-- UC-05: kustomisasi kepribadian AI (Premium). Satu kustomisasi per pengguna per persona dasar;
-- status nonaktif saat Premium berakhir, datanya tetap tersimpan.
CREATE TABLE IF NOT EXISTS kustomisasi_kepribadian (
  id_kustomisasi BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_pengguna BIGINT NOT NULL,
  id_persona_dasar INT NOT NULL,
  nama_panggilan VARCHAR(50) NULL,
  sifat VARCHAR(255) NULL,
  gaya_bicara VARCHAR(255) NULL,
  status ENUM('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
  UNIQUE (id_pengguna, id_persona_dasar),
  FOREIGN KEY (id_pengguna) REFERENCES pengguna(id_pengguna) ON DELETE CASCADE,
  FOREIGN KEY (id_persona_dasar) REFERENCES persona(id_persona)
);

-- kolom id_kustomisasi pada sesi_percakapan (ditambahkan hanya bila belum ada)
SET @ada := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sesi_percakapan' AND COLUMN_NAME = 'id_kustomisasi');
SET @sql := IF(@ada = 0,
  'ALTER TABLE sesi_percakapan ADD COLUMN id_kustomisasi BIGINT NULL AFTER id_persona, ADD FOREIGN KEY (id_kustomisasi) REFERENCES kustomisasi_kepribadian(id_kustomisasi) ON DELETE SET NULL',
  'SELECT 1');
PREPARE st FROM @sql;
EXECUTE st;
DEALLOCATE PREPARE st;
