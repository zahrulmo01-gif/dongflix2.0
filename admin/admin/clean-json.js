import fs from 'fs';
import path from 'path';

const masterPath = path.resolve('donghua/donghua.json');
const episodesDir = path.resolve('donghua/episodes');

function sanitizeTitle(rawTitle) {
  if (!rawTitle) return '';
  const str = rawTitle.trim();
  const half = Math.floor(str.length / 2);
  if (str.length > 4 && str.slice(0, half) === str.slice(half)) {
    return str.slice(0, half).trim();
  }
  return str;
}

function parseEpisodeNumber(epString) {
  if (!epString || epString === 'null' || epString === null) return 0;
  const match = String(epString).match(/(\d+(\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

function runCleaner() {
  if (!fs.existsSync(masterPath)) {
    console.error('File donghua/donghua.json tidak ditemukan!');
    process.exit(1);
  }

  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
  } catch (err) {
    console.error('Format donghua.json rusak:', err.message);
    process.exit(1);
  }

  let fixedCount = 0;

  for (const item of list) {
    let wasModified = false;

    // 1. Bersihkan judul yang berulang/duplikat
    const cleanTitle = sanitizeTitle(item.title);
    if (cleanTitle !== item.title) {
      item.title = cleanTitle;
      wasModified = true;
    }

    // 2. Perbaiki episode jika bernilai 'null', 'Ep null', atau kosong
    const currentLatest = String(item['latest-episode'] || '').trim().toLowerCase();
    const currentEp = String(item.episode || '').trim().toLowerCase();

    if (currentLatest === 'null' || currentLatest === '' || currentEp.includes('null') || currentEp === '') {
      let resolvedEp = 0;

      // Cari dari file episode lokal yang sudah tersimpan
      const epFile = path.join(episodesDir, `${item.slug}.json`);
      if (fs.existsSync(epFile)) {
        try {
          const episodes = JSON.parse(fs.readFileSync(epFile, 'utf-8'));
          if (Array.isArray(episodes) && episodes.length > 0) {
            const nums = episodes.map(e => parseEpisodeNumber(e.episode)).filter(n => n > 0);
            if (nums.length > 0) {
              resolvedEp = Math.max(...nums);
            }
          }
        } catch (_) {}
      }

      // Jika dari file tidak dapat, coba ekstrak angka dari teks yang ada
      if (!resolvedEp) {
        resolvedEp = parseEpisodeNumber(item.episode) || parseEpisodeNumber(item['latest-episode']);
      }

      // Fallback terakhir: default ke 1
      const finalEpString = resolvedEp > 0 ? String(resolvedEp) : '1';

      item['latest-episode'] = finalEpString;
      item.episode = `Ep ${finalEpString}`;
      item.updated_at = item.updated_at || new Date().toISOString();
      wasModified = true;
    }

    if (wasModified) fixedCount++;
  }

  fs.writeFileSync(masterPath, JSON.stringify(list, null, 2), 'utf-8');
  console.log(`✅ Selesai! Sebanyak ${fixedCount} data berhasil dibersihkan & dinormalkan di donghua.json.`);
}

runCleaner();
