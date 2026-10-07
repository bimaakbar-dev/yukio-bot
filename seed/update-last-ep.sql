-- Seed: update last_ep untuk anime yang di-track
-- Bot akan mulai cek dari last_ep + 1
-- chunk_start/chunk_end = 0 artinya fresh chunk (file lama dianggap tidak ada)

UPDATE tracked_anime SET last_ep = 2, chunk_start = 0, chunk_end = 0 WHERE slug = 'tempal-item-no-chikara';
UPDATE tracked_anime SET last_ep = 1, chunk_start = 0, chunk_end = 0 WHERE slug = 'kanata-kara';
UPDATE tracked_anime SET last_ep = 1, chunk_start = 0, chunk_end = 0 WHERE slug = 'doumo-suki-na-hito-ni-horegusuri-wo-irai-sareta-majo-desu';
UPDATE tracked_anime SET last_ep = 2, chunk_start = 0, chunk_end = 0 WHERE slug = 'tensei-goblin-dakedo-shitsumon-aru';
UPDATE tracked_anime SET last_ep = 2, chunk_start = 0, chunk_end = 0 WHERE slug = 'tensei-kizoku-kantei-skill-de-nariagaru-3rd-season';

-- Verifikasi
SELECT slug, last_ep, chunk_start, chunk_end, status FROM tracked_anime ORDER BY slug;
