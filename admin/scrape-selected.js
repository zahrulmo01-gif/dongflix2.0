import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Mengambil argumen slug pilihan dari command line (misal: "supreme-god-emperor,one-slash-to-the-heavens")
const rawSlugs = process.argv[2];
if (!rawSlugs) {
  console.error('❌ Error: Tidak ada slug yang dipilih untuk di-scrape!');
  process.exit(1);
}

const selectedSlugs = rawSlugs.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
console.log(`🎯 Memulai Scrape Batch untuk ${selectedSlugs.length} donghua terpilih:`, selectedSlugs);

const masterPath = path.resolve('donghua/donghua.json');
if (!fs.existsSync(masterPath)) {
  console.error('❌ Error: File donghua/donghua.json tidak ditemukan!');
  process.exit(1);
}

let donghuaList = [];
try {
  donghuaList = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
} catch (e) {
  console.error('❌ Error: Format donghua.json rusak:', e.message);
  process.exit(1);
}

// Filter hanya donghua yang dipilih oleh admin
const targets = donghuaList.filter(d => selectedSlugs.includes(String(d.slug).toLowerCase()));

if (targets.length === 0) {
  console.log('⚠️ Tidak ada donghua yang cocok dengan slug pilihan di dalam katalog.');
  process.exit(0);
}

console.log(`🚀 Menjalankan proses scrape untuk ${targets.length} judul...`);

for (let i = 0; i < targets.length; i++) {
  const item = targets[i];
  const slug = item.slug;
  console.log(`\n----------------------------------------`);
  console.log(`[${i + 1}/${targets.length}] Memproses: ${item.title} (${slug})`);
  console.log(`----------------------------------------`);

  try {
    // Memanggil skrip smart-scrape atau scraper-episodes untuk slug tersebut
    execSync(`node admin/smart-scrape.js --slugs=${slug}`, { stdio: 'inherit' });
    console.log(`✅ Berhasil memproses ${slug}`);
  } catch (err) {
    console.error(`❌ Gagal memproses ${slug}: ${err.message}`);
    console.log(`➡️ Melanjutkan ke donghua berikutnya...`);
  }
}

console.log('\n=== Semua batch scrape donghua terpilih selesai! ===');
