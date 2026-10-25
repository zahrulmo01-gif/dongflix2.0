import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { execSync } from 'child_process';

const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const masterPath = path.resolve('donghua/donghua.json');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

if (!IMGBB_API_KEY) {
  console.error('❌ IMGBB_API_KEY belum disetel! Harap jalankan dengan environment variable IMGBB_API_KEY.');
  process.exit(1);
}

function gitPushCheckpoint(count, total) {
  try {
    console.log(`\n💾 [Git Checkpoint] Commit progres cover (${count}/${total})...`);
    execSync('git config --local user.email "action@github.com"', { stdio: 'ignore' });
    execSync('git config --local user.name "GitHub Action Bot"', { stdio: 'ignore' });
    execSync('git add donghua/donghua.json', { stdio: 'ignore' });

    const status = execSync('git status --porcelain').toString().trim();
    if (status) {
      execSync(`git commit -m "Auto: Sync covers to ImgBB (${count}/${total}) [skip ci]"`, { stdio: 'ignore' });
      try {
        execSync('git pull --rebase origin main', { stdio: 'ignore' });
      } catch (_) {
        execSync('git pull --rebase', { stdio: 'ignore' });
      }
      execSync('git push origin main', { stdio: 'inherit' });
      console.log('🚀 Berhasil push checkpoint ke GitHub!\n');
    }
  } catch (err) {
    console.warn(`⚠️ Gagal checkpoint: ${err.message}`);
    try { execSync('git rebase --abort', { stdio: 'ignore' }); } catch (_) {}
  }
}

// Download cover dari URL sumber dan ubah ke Buffer WebP
async function fetchAndConvertToWebp(imageUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': 'https://anichin.my/'
      }
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    // Kompresi dan convert ke WebP menggunakan sharp
    const webpBuffer = await sharp(inputBuffer)
      .webp({ quality: 85 })
      .toBuffer();

    return webpBuffer;
  } catch (err) {
    clearTimeout(timeout);
    return null;
  }
}

// Upload buffer Base64 ke ImgBB API
async function uploadToImgBB(base64Data, slug) {
  const finalName = `${slug}.webp`;
  const formData = new FormData();
  formData.append('image', base64Data);
  formData.append('name', finalName);

  try {
    const res = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
      method: 'POST',
      body: formData
    });

    const json = await res.json();
    if (json && json.success) {
      return json.data.image ? json.data.image.url : json.data.url;
    } else {
      console.warn(`  ⚠️ Gagal upload ${slug}:`, json?.error?.message || 'Unknown error');
      return null;
    }
  } catch (err) {
    console.warn(`  ⚠️ Error request ImgBB untuk ${slug}:`, err.message);
    return null;
  }
}

async function run() {
  console.log('=== Memulai Otomatisasi Sinkronisasi Cover ke ImgBB ===');

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

  // Filter judul yang cover-nya BELUM di-host di ImgBB (tidak mengandung i.ibb.co)
  const targets = list.filter(item => {
    const c = String(item.cover || '');
    return c && !c.includes('i.ibb.co') && !c.includes('ibb.co');
  });

  console.log(`Total judul di katalog : ${list.length}`);
  console.log(`Judul yang butuh cover ImgBB: ${targets.length}`);

  if (targets.length === 0) {
    console.log('✅ Semua cover sudah ter-host rapi di ImgBB!');
    return;
  }

  let processed = 0;
  let successCount = 0;

  for (const item of targets) {
    processed++;
    const slug = item.slug;
    const oldCover = item.cover;

    console.log(`\n[${processed}/${targets.length}] Memproses cover: ${item.title} (${slug})`);

    // 1. Download & ubah ke WebP
    const webpBuffer = await fetchAndConvertToWebp(oldCover);
    if (!webpBuffer) {
      console.log(`  ❌ Gagal mengunduh cover dari: ${oldCover}`);
      continue;
    }

    // 2. Upload ke ImgBB
    const base64Str = webpBuffer.toString('base64');
    const newCoverUrl = await uploadToImgBB(base64Str, slug);

    if (newCoverUrl) {
      console.log(`  ✨ Berhasil! URL baru: ${newCoverUrl}`);
      item.cover = newCoverUrl;
      item.updated_at = new Date().toISOString();
      successCount++;

      // Simpan langsung ke file lokal
      fs.writeFileSync(masterPath, JSON.stringify(list, null, 2), 'utf-8');

      // Commit bertahap setiap 25 judul agar aman
      if (successCount % 25 === 0) {
        gitPushCheckpoint(successCount, targets.length);
      }
    }

    // Delay ramah agar tidak terkena rate limit API ImgBB
    await new Promise(r => setTimeout(r, 1200));
  }

  // Push hasil akhir
  fs.writeFileSync(masterPath, JSON.stringify(list, null, 2), 'utf-8');
  gitPushCheckpoint(successCount, targets.length);

  console.log(`\n🎉 Selesai! Sebanyak ${successCount} cover berhasil dipindahkan ke ImgBB.`);
}

run();
