import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import * as cheerio from 'cheerio';
import { execSync } from 'child_process';

// Konfigurasi Cloudinary langsung
const CLOUDINARY_CLOUD_NAME = 'pqyvpk17';
const CLOUDINARY_UPLOAD_PRESET = 'dongflix';

const masterPath = path.resolve('donghua/donghua.json');

// Daftar mirror utama & CDN anichin
const CANDIDATE_DOMAINS = [
  'https://anichin.my',
  'https://anichin.co',
  'https://v1.anichin.space',
  'https://anichin.site',
  'https://anichin.moe',
  'https://anichin.vip'
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function gitPushCheckpoint(count, total) {
  try {
    console.log(`\n💾 [Git Checkpoint] Commit progres cover (${count}/${total})...`);
    execSync('git config --local user.email "action@github.com"', { stdio: 'ignore' });
    execSync('git config --local user.name "GitHub Action Bot"', { stdio: 'ignore' });
    execSync('git add donghua/donghua.json', { stdio: 'ignore' });

    const status = execSync('git status --porcelain').toString().trim();
    if (status) {
      execSync(`git commit -m "Auto: Sync covers to Cloudinary (${count}/${total}) [skip ci]"`, { stdio: 'ignore' });
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

// Generate URL alternatif untuk file gambar statis
function generateCandidateUrls(rawUrl) {
  if (!rawUrl) return [];
  let url = rawUrl.trim();
  if (url.startsWith('//')) url = `https:${url}`;

  const candidates = [];
  if (url.startsWith('http')) {
    candidates.push(url);
  }

  const match = url.match(/(\/wp-content\/uploads\/[^\s'"]+)/i);
  if (match) {
    const uploadPath = match[1];
    for (const domain of CANDIDATE_DOMAINS) {
      const full = `${domain}${uploadPath}`;
      if (!candidates.includes(full)) {
        candidates.push(full);
      }
    }
  }

  return candidates;
}

// Download dan convert gambar menjadi buffer WebP
async function downloadImageBuffer(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const originHost = new URL(url).origin;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': `${originHost}/`,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }
    });
    clearTimeout(timeout);

    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || (!contentType.includes('image') && !contentType.includes('octet-stream'))) {
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    if (inputBuffer.length < 500) return null;

    const webpBuffer = await sharp(inputBuffer)
      .webp({ quality: 85 })
      .toBuffer();

    return webpBuffer;
  } catch (_) {
    clearTimeout(timeout);
    return null;
  }
}

// Fallback: Jika link gambar di JSON rusak, scrape poster langsung dari halaman detail
async function scrapeCoverFromDetailPage(slug) {
  const pageCandidates = [
    `https://anichin.my/${slug}/`,
    `https://anichin.co/${slug}/`,
    `https://v1.anichin.space/series/${slug}/`,
    `https://v1.anichin.space/${slug}/`
  ];

  for (const pageUrl of pageCandidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(pageUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          'Referer': new URL(pageUrl).origin
        }
      });
      clearTimeout(timeout);

      if (!res.ok) continue;

      const html = await res.text();
      const $ = cheerio.load(html);

      let foundImgUrl = $('.thumb img, .bigcontent img, .ts-post-image').attr('src') ||
                        $('.thumb img, .bigcontent img, .ts-post-image').attr('data-src') || '';

      if (foundImgUrl) {
        if (foundImgUrl.startsWith('//')) foundImgUrl = `https:${foundImgUrl}`;
        const webpBuffer = await downloadImageBuffer(foundImgUrl);
        if (webpBuffer) {
          return { webpBuffer, sourceSuccess: `${pageUrl} -> ${foundImgUrl}` };
        }
      }
    } catch (_) {
      clearTimeout(timeout);
    }
  }

  return { webpBuffer: null, sourceSuccess: null };
}

// Alur utama pencarian cover
async function fetchAndConvertToWebpWithFallback(originalUrl, slug) {
  const candidateUrls = generateCandidateUrls(originalUrl);

  for (const url of candidateUrls) {
    const webpBuffer = await downloadImageBuffer(url);
    if (webpBuffer) {
      return { webpBuffer, sourceSuccess: url };
    }
  }

  return await scrapeCoverFromDetailPage(slug);
}

// Upload buffer Base64 Data URI langsung ke Cloudinary
async function uploadToCloudinary(buffer, slug) {
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const base64Data = `data:image/webp;base64,${buffer.toString('base64')}`;

  const formData = new FormData();
  formData.append('file', base64Data);
  formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  formData.append('public_id', cleanSlug);
  formData.append('folder', 'donghua_covers');

  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
      method: 'POST',
      body: formData
    });

    const json = await res.json();
    if (res.ok && json.secure_url) {
      return json.secure_url;
    } else {
      console.warn(`  ⚠️ Gagal upload ${slug}:`, json?.error?.message || 'Unknown error');
      return null;
    }
  } catch (err) {
    console.warn(`  ⚠️ Error request Cloudinary untuk ${slug}:`, err.message);
    return null;
  }
}

async function run() {
  console.log('=== Memulai Sinkronisasi Cover Multi-Mirror ke Cloudinary ===');

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

  // Targetkan semua item yang cover-nya belum di Cloudinary
  const targets = list.filter(item => {
    const c = String(item.cover || '');
    return c && !c.includes('res.cloudinary.com');
  });

  console.log(`Total judul di katalog       : ${list.length}`);
  console.log(`Judul yang perlu di-sync     : ${targets.length}`);

  if (targets.length === 0) {
    console.log('✅ Semua cover sudah ter-host rapi di Cloudinary!');
    return;
  }

  let processed = 0;
  let successCount = 0;
  let failCount = 0;

  for (const item of targets) {
    processed++;
    const slug = item.slug;
    const originalCover = item.cover;

    console.log(`\n[${processed}/${targets.length}] Memproses: ${item.title} (${slug})`);

    const { webpBuffer, sourceSuccess } = await fetchAndConvertToWebpWithFallback(originalCover, slug);

    if (!webpBuffer) {
      console.log(`  ❌ Gagal menemukan cover dari semua mirror & halaman series: ${slug}`);
      failCount++;
      continue;
    }

    console.log(`  📥 Gambar berhasil diambil dari: ${sourceSuccess}`);

    const newCoverUrl = await uploadToCloudinary(webpBuffer, slug);

    if (newCoverUrl) {
      console.log(`  ✨ Berhasil diunggah ke Cloudinary: ${newCoverUrl}`);
      item.cover = newCoverUrl;
      item.updated_at = new Date().toISOString();
      successCount++;

      fs.writeFileSync(masterPath, JSON.stringify(list, null, 2), 'utf-8');

      if (successCount % 20 === 0) {
        gitPushCheckpoint(successCount, targets.length);
      }
    } else {
      failCount++;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  fs.writeFileSync(masterPath, JSON.stringify(list, null, 2), 'utf-8');
  gitPushCheckpoint(successCount, targets.length);

  console.log(`\n🎉 Proses Selesai!`);
  console.log(`- Berhasil dipindahkan ke Cloudinary : ${successCount}`);
  console.log(`- Gagal                             : ${failCount}`);
}

run();
