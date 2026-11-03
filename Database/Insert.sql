USE vocamate;

INSERT INTO paket (nama_paket, harga, durasi_hari, kuota_menit, batas_baca_layar, periode_reset)
VALUES
('Free', 0, NULL, 10, 3, 'harian'),
('Premium', 49000, 30, 120, NULL, 'harian');

-- kode_suara_tts = nama suara peramban; bila tidak ada di perangkat, ekstensi memakai suara Bahasa Indonesia lain
INSERT INTO suara (nama_suara, deskripsi, kode_suara_tts, jenis) VALUES
('Suara Perempuan', 'Suara perempuan Google Bahasa Indonesia (butuh internet)', 'Google Bahasa Indonesia', 'standar'),
('Suara Laki-laki', 'Suara laki-laki Microsoft Andika', 'Microsoft Andika', 'standar'),
('Gadis (Natural)', 'Suara perempuan natural Microsoft Gadis (Microsoft Edge)', 'Microsoft Gadis Online', 'ekspresif'),
('Ardi (Natural)', 'Suara laki-laki natural Microsoft Ardi (Microsoft Edge)', 'Microsoft Ardi Online', 'ekspresif');

INSERT INTO persona (nama_persona, deskripsi, gaya_bahasa, nada_respons, instruksi_dasar, is_standar) VALUES
('Teman', 'Teman ngobrol santai', 'Santai, akrab', 'Hangat dan ramah',
 'Kamu adalah teman ngobrol yang santai dan ramah. Jawab singkat dalam Bahasa Indonesia, cocok untuk percakapan lisan.', TRUE),
('Pacar Virtual', 'Pasangan virtual yang perhatian', 'Lembut, penuh perhatian', 'Manis dan suportif',
 'Kamu adalah pasangan virtual yang perhatian dan suportif. Jawab singkat dalam Bahasa Indonesia, cocok untuk percakapan lisan.', FALSE),
('Mentor', 'Pembimbing yang memberi arahan', 'Jelas, terstruktur', 'Tenang dan memotivasi',
 'Kamu adalah mentor yang memberi arahan jelas dan memotivasi. Jawab singkat dalam Bahasa Indonesia, cocok untuk percakapan lisan.', FALSE);