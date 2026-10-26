import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { execSync } from 'child_process';

const IMGBB_API_KEY = '885deff423c3a1c6f97f7b9c2982f1a2';
const masterPath = path.resolve('donghua/donghua.json');

const TARGET_IMAGE_HOST = 'https://anichin.my';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

if (!IMGBB_API_KEY) {
  console.error('❌ IMGBB_API_KEY belum disetel!');
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

// Format ulang link agar selalu diarahkan ke anichin.my
function normalizeToAnichinMy(rawUrl) {
  if (!rawUrl) return '';
  let url = rawUrl.trim();
  
  // Ubah domain mirror lain ke anichin.my
  url = url.replace(/https?:\/\/(www\.)?anichin\.(moe|co|site|vip)/gi, TARGET_IMAGE_HOST);
  
  if (url.startsWith('//')) {
    url = `https:${url}`;
  } else if (url.startsWith('/')) {
    url = `${TARGET_IMAGE_HOST}${url}`;
  }
  
  return url;
}

// Download cover dari anichin.my dan convert ke Buffer WebP
async function fetchAndConvertToWebp(imageUrl) {
  const finalUrl = normalizeToAnichinMy(imageUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(finalUrl, {
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

    // Kompresi dan ubah ke format WebP via sharp
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
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const formData = new FormData();
  formData.append('image', base64Data);
  formData.append('name', cleanSlug);

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
  console.log('=== Memulai Sinkronisasi Cover via anichin.my ke ImgBB ===');

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

  // Ambil judul yang belum di-host di ImgBB
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
    const originalCover = item.cover;
    const targetSourceUrl = normalizeToAnichinMy(originalCover);

    console.log(`\n[${processed}/${targets.length}] Memproses: ${item.title}`);
    console.log(`  Source: ${targetSourceUrl}`);

    // 1. Download dari anichin.my & convert ke WebP
    const webpBuffer = await fetchAndConvertToWebp(targetSourceUrl);
    if (!webpBuffer) {
      console.log(`  ❌ Gagal mengunduh cover dari: ${targetSourceUrl}`);
      continue;
    }

    // 2. Upload ke ImgBB
    const base64Str = webpBuffer.toString('base64');
    const newCoverUrl = await uploadToImgBB(base64Str, slug);

    if (newCoverUrl) {
      console.log(`  ✨ Berhasil! URL baru ImgBB: ${newCoverUrl}`);
      item.cover = newCoverUrl;
      item.updated_at = new Date().toISOString();
      successCount++;

      fs.writeFileSync(masterPath, JSON.stringify(list, null, 2), 'utf-8');

      // Commit bertahap tiap 25 judul
      if (successCount % 25 === 0) {
        gitPushCheckpoint(successCount, targets.length);
      }
    }

    // Delay 1.2 detik agar aman dari rate limit
    await new Promise(r => setTimeout(r, 1200));
  }

  fs.writeFileSync(masterPath, JSON.stringify(list, null, 2), 'utf-8');
  gitPushCheckpoint(successCount, targets.length);

  console.log(`\n🎉 Selesai! Sebanyak ${successCount} cover dari anichin.my berhasil diunggah ke ImgBB.`);
}

run();
