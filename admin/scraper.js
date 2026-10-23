import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

puppeteer.use(StealthPlugin());

const BASE_URL = 'https://anichin.moe';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function resolveUrl(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

function extractSlug(url) {
  if (!url) return '';
  const clean = url.replace(BASE_URL, '').replace(/^\/+|\/+$/g, '');
  const segments = clean.split('/').filter(Boolean);
  return segments.pop() || '';
}

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

// Mengambil detail lengkap donghua/movie langsung dari halaman Anichin
async function fetchDonghuaDetail(page, detailUrl, fallbackTitle = '', fallbackSlug = '') {
  try {
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const html = await page.content();
    const $ = cheerio.load(html);

    // 1. Ekstrak Genre
    const genres = [];
    $('.genxed a, .genre-info a, .info-content .spe span:contains("Genre") a').each((_, el) => {
      const g = $(el).text().trim();
      if (g && !genres.includes(g)) genres.push(g);
    });

    // 2. Ekstrak Sinopsis
    let synopsis = $('.entry-content p, .synp .entry-content, .desc p').first().text().trim();
    if (!synopsis) {
      synopsis = $('.entry-content, .desc').first().text().trim();
    }

    // 3. Ekstrak Spesifikasi (Status, Rilis, Tipe, Total Episode)
    let released = 'Tanggal -';
    let status = 'Ongoing';
    let detectedType = 'Donghua';
    let totalEp = 0;

    $('.spe span, .info-content span').each((_, el) => {
      const txt = $(el).text().trim();
      const lower = txt.toLowerCase();

      // Tanggal Rilis
      if (lower.includes('tanggal rilis') || lower.includes('released')) {
        released = txt.replace(/tanggal rilis\s*:\s*/i, '').replace(/released\s*:\s*/i, '').trim();
      }

      // Status
      if (lower.includes('status')) {
        if (lower.includes('completed') || lower.includes('tamat')) {
          status = 'Completed';
        } else if (lower.includes('ongoing')) {
          status = 'Ongoing';
        }
      }

      // Tipe (Donghua vs Movie)
      if (lower.includes('tipe') || lower.includes('type')) {
        if (lower.includes('movie')) {
          detectedType = 'Movie';
        }
      }

      // Total Episode
      if (lower.includes('episode')) {
        const epFound = parseEpisodeNumber(txt);
        if (epFound > 0) totalEp = epFound;
      }
    });

    // Fallback deteksi movie dari judul atau slug jika tidak terdeteksi di spesifikasi
    const combinedCheck = `${fallbackTitle} ${fallbackSlug}`.toLowerCase();
    if (combinedCheck.includes('movie')) {
      detectedType = 'Movie';
    }

    return {
      genres: genres.length > 0 ? genres : ["Action", "Adventure", "Fantasy", "Martial Arts", "Cultivation"],
      synopsis: synopsis || '',
      released: released.startsWith('Tanggal') ? released : `Tanggal  ${released}`,
      status,
      type: detectedType,
      totalEp
    };
  } catch (err) {
    const isMovieFallback = `${fallbackTitle} ${fallbackSlug}`.toLowerCase().includes('movie');
    return {
      genres: ["Action", "Adventure", "Fantasy", "Martial Arts", "Cultivation"],
      synopsis: "",
      released: "Tanggal -",
      status: "Ongoing",
      type: isMovieFallback ? "Movie" : "Donghua",
      totalEp: 0
    };
  }
}

async function main() {
  const isSyncOrder = process.argv.includes('--mode=sync-order');
  const isNewOnly = process.argv.includes('--mode=new-only');

  console.log(`=== Menjalankan Scraper: ${isSyncOrder ? 'SYNC-ORDER' : (isNewOnly ? 'NEW-ONLY' : 'DEFAULT')} ===`);

  const masterPath = path.resolve('donghua/donghua.json');
  if (!fs.existsSync(masterPath)) {
    console.error('File donghua/donghua.json tidak ditemukan!');
    process.exit(1);
  }

  let masterList = [];
  try {
    masterList = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
  } catch (err) {
    console.error('Format donghua.json rusak:', err.message);
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--blink-settings=imagesEnabled=false'
    ]
  });

  const page = await browser.newPage();
  await page.setUserAgent(getRandomUserAgent());

  try {
    const targetUrl = `${BASE_URL}/donghua/`;
    console.log(`Membaca katalog dari: ${targetUrl}`);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    const html = await page.content();
    const $ = cheerio.load(html);

    const scrapedCards = [];
    const items = $('.listupd article, .animepost, .bsx, .animpost');

    items.each((_, el) => {
      const card = $(el);
      const linkEl = card.find('a').first();
      const rawLink = resolveUrl(linkEl.attr('href') || '');
      const slug = extractSlug(rawLink);

      if (!slug || slug === 'donghua' || slug === 'anime') return;

      const rawTitle = linkEl.attr('title') || 
                       card.find('.tt h2, .entry-title, .title').first().text() || 
                       card.find('.tt').first().text() || '';

      const title = sanitizeTitle(rawTitle);

      let cover = card.find('img').attr('src') || card.find('img').attr('data-src') || '';
      if (cover.startsWith('//')) cover = `https:${cover}`;

      const epRaw = card.find('.epx, .bt .ep, .sb').first().text().trim();
      const epNum = parseEpisodeNumber(epRaw);

      scrapedCards.push({
        slug,
        title,
        link: rawLink,
        cover,
        epRaw: epNum > 0 ? String(epNum) : '1'
      });
    });

    console.log(`Ditemukan ${scrapedCards.length} judul pada halaman pertama.`);

    let updatedCount = 0;

    // Iterasi terbalik agar kartu urutan teratas pada web tetap berada paling atas di array
    for (let i = scrapedCards.length - 1; i >= 0; i--) {
      const card = scrapedCards[i];
      const existingIdx = masterList.findIndex(d => d.slug === card.slug);

      if (existingIdx > -1) {
        if (isNewOnly) {
          continue;
        }

        // Mode sync-order: update data eksisting dan pindahkan ke urutan teratas
        const [item] = masterList.splice(existingIdx, 1);
        item.title = sanitizeTitle(item.title) || card.title;
        if (card.cover && !item.cover) item.cover = card.cover;

        // Validasi tipe jika belum Movie
        if (`${item.title} ${item.slug}`.toLowerCase().includes('movie')) {
          item.type = 'Movie';
        }

        const safeEp = card.epRaw !== '1' ? card.epRaw : (item['latest-episode'] || '1');
        item['latest-episode'] = safeEp;
        item.episode = `Ep ${safeEp}`;
        item.updated_at = new Date().toISOString();

        masterList.unshift(item);
        updatedCount++;
      } else {
        // Judul baru: ambil detail lengkap dari halaman spesifik
        console.log(`✨ Menambahkan entri baru: ${card.title} (${card.slug})`);
        const detail = await fetchDonghuaDetail(page, card.link, card.title, card.slug);

        const finalEp = detail.totalEp > 0 ? String(detail.totalEp) : card.epRaw;

        const newItem = {
          title: card.title,
          slug: card.slug,
          link: card.link,
          cover: card.cover,
          type: detail.type,
          status: detail.status,
          episode: `Ep ${finalEp}`,
          released: detail.released,
          genres: detail.genres,
          synopsis: detail.synopsis,
          "latest-episode": finalEp,
          updated_at: new Date().toISOString()
        };

        masterList.unshift(newItem);
        updatedCount++;
      }
    }

    fs.writeFileSync(masterPath, JSON.stringify(masterList, null, 2), 'utf-8');
    console.log(`✅ Berhasil memproses ${updatedCount} judul ke dalam donghua.json.`);

    // Otomasi Git Commit & Push
    try {
      execSync('git config --local user.email "action@github.com"', { stdio: 'ignore' });
      execSync('git config --local user.name "GitHub Action Bot"', { stdio: 'ignore' });
      execSync('git add donghua/donghua.json', { stdio: 'ignore' });

      const status = execSync('git status --porcelain').toString().trim();
      if (status) {
        execSync(`git commit -m "Auto: Update Catalog (${isSyncOrder ? 'Sync Order' : 'New Only'}) [skip ci]"`, { stdio: 'inherit' });
        try {
          execSync('git pull --rebase origin main', { stdio: 'inherit' });
        } catch (_) {
          execSync('git pull --rebase', { stdio: 'inherit' });
        }
        execSync('git push origin main', { stdio: 'inherit' });
        console.log('🚀 Perubahan katalog berhasil di-push ke GitHub!');
      } else {
        console.log('ℹ️ Tidak ada perubahan data baru.');
      }
    } catch (pushErr) {
      console.warn(`⚠️ Git push dilewati / gagal: ${pushErr.message}`);
      try {
        execSync('git rebase --abort', { stdio: 'ignore' });
      } catch (_) {}
    }

  } catch (error) {
    console.error('Terjadi error saat scraping:', error);
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
