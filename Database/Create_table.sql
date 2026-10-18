DROP DATABASE IF EXISTS vocamate;
CREATE DATABASE IF NOT EXISTS vocamate CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE vocamate;

CREATE TABLE paket (
  id_paket INT AUTO_INCREMENT PRIMARY KEY,
  nama_paket VARCHAR(50) NOT NULL,
  harga DECIMAL(12,2) NOT NULL DEFAULT 0,
  durasi_hari INT NULL,
  kuota_menit INT NOT NULL,
  batas_baca_layar INT NULL,
  periode_reset ENUM('harian','mingguan','bulanan') NOT NULL,
  status ENUM('aktif','nonaktif') NOT NULL DEFAULT 'aktif'
);

CREATE TABLE persona (
  id_persona INT AUTO_INCREMENT PRIMARY KEY,
  nama_persona VARCHAR(50) NOT NULL,
  deskripsi TEXT,
  gaya_bahasa VARCHAR(255),
  nada_respons VARCHAR(255),
  instruksi_dasar TEXT NOT NULL,
  is_standar BOOLEAN NOT NULL DEFAULT FALSE,
  status ENUM('aktif','nonaktif') NOT NULL DEFAULT 'aktif'
);

CREATE TABLE suara (
  id_suara INT AUTO_INCREMENT PRIMARY KEY,
  nama_suara VARCHAR(50) NOT NULL,
  deskripsi VARCHAR(255),
  kode_suara_tts VARCHAR(100),
  url_sampel VARCHAR(255),
  jenis ENUM('standar','ekspresif') NOT NULL DEFAULT 'standar',
  status ENUM('aktif','nonaktif') NOT NULL DEFAULT 'aktif'
);

CREATE TABLE pengguna (
  id_pengguna BIGINT AUTO_INCREMENT PRIMARY KEY,
  nama VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  peran ENUM('pengguna','admin') NOT NULL DEFAULT 'pengguna',
  status_akun ENUM('aktif','diblokir') NOT NULL DEFAULT 'aktif',
  jumlah_gagal_login TINYINT NOT NULL DEFAULT 0,
  login_ditahan_sampai DATETIME NULL,
  dibuat_pada DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sesi_login (
  id_token BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_pengguna BIGINT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  kedaluwarsa_pada DATETIME NOT NULL,
  dicabut BOOLEAN NOT NULL DEFAULT FALSE,
  INDEX (token_hash),
  FOREIGN KEY (id_pengguna) REFERENCES pengguna(id_pengguna) ON DELETE CASCADE
);

CREATE TABLE pengaturan_pengguna (
  id_pengguna BIGINT PRIMARY KEY,
  id_persona_aktif INT NOT NULL,
  id_suara_aktif INT NOT NULL,
  memori_aktif BOOLEAN NOT NULL DEFAULT FALSE,
  FOREIGN KEY (id_pengguna) REFERENCES pengguna(id_pengguna) ON DELETE CASCADE,
  FOREIGN KEY (id_persona_aktif) REFERENCES persona(id_persona),
  FOREIGN KEY (id_suara_aktif) REFERENCES suara(id_suara)
);

CREATE TABLE kuota (
  id_kuota BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_pengguna BIGINT NOT NULL,
  id_paket INT NOT NULL,
  sisa_kuota_detik INT NOT NULL,
  pemakaian_baca_layar INT NOT NULL DEFAULT 0,
  periode_mulai DATETIME NOT NULL,
  periode_berakhir DATETIME NOT NULL,
  FOREIGN KEY (id_pengguna) REFERENCES pengguna(id_pengguna) ON DELETE CASCADE,
  FOREIGN KEY (id_paket) REFERENCES paket(id_paket)
);

CREATE TABLE sesi_percakapan (
  id_sesi BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_pengguna BIGINT NOT NULL,
  id_persona INT NOT NULL,
  id_suara INT NOT NULL,
  waktu_mulai DATETIME NOT NULL,
  waktu_selesai DATETIME NULL,
  durasi_aktif_detik INT NOT NULL DEFAULT 0,
  status ENUM('aktif','dijeda','selesai') NOT NULL DEFAULT 'aktif',
  alasan_berakhir VARCHAR(30) NULL,
  FOREIGN KEY (id_pengguna) REFERENCES pengguna(id_pengguna) ON DELETE CASCADE,
  FOREIGN KEY (id_persona) REFERENCES persona(id_persona),
  FOREIGN KEY (id_suara) REFERENCES suara(id_suara)
);

CREATE TABLE transkrip (
  id_transkrip BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_sesi BIGINT NOT NULL,
  penutur ENUM('pengguna','ai') NOT NULL,
  isi_teks TEXT NOT NULL,
  disela BOOLEAN NOT NULL DEFAULT FALSE,
  waktu DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (id_sesi) REFERENCES sesi_percakapan(id_sesi) ON DELETE CASCADE
);