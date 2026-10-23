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
  if (!epString || epString === 'null') return 0;
  const match = String(epString).match(/(\d+(\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

// Mengambil detail lengkap donghua (sinopsis, genre, rilis) untuk entri baru
async function fetchDonghuaDetail(page, detailUrl) {
  try {
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const html = await page.content();
    const $ = cheerio.load(html);

    const genres = [];
    $('.genxed a, .genre-info a, .info-content .spe span:contains("Genre") a').each((_, el) => {
      const g = $(el).text().trim();
      if (g && !genres.includes(g)) genres.push(g);
    });

    let synopsis = $('.entry-content p, .synp .entry-content, .desc p').first().text().trim();
    if (!synopsis) {
      synopsis = $('.entry-content, .desc').first().text().trim();
    }

    let released = '';
    $('.spe span, .info-content span').each((_, el) => {
      const txt = $(el).text().trim();
      if (txt.toLowerCase().includes('released') || txt.toLowerCase().includes('tanggal')) {
        released = txt.replace(/released\s*:\s*/i, '').trim();
      }
    });

    let status = 'Ongoing';
    $('.spe span, .info-content span').each((_, el) => {
      const txt = $(el).text().trim();
      if (txt.toLowerCase().includes('status')) {
        if (txt.toLowerCase().includes('completed')) status = 'Completed';
      }
    });

    return { genres, synopsis, released: released || 'Tanggal -', status };
  } catch (_) {
    return {
      genres: ["Action", "Adventure", "Fantasy", "Martial Arts", "Cultivation"],
      synopsis: "",
      released: "Tanggal -",
      status: "Ongoing"
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
    console.log(`Membaca daftar dari: ${targetUrl}`);

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

    console.log(`Ditemukan ${scrapedCards.length} judul dari web.`);

    let updatedCount = 0;

    // Iterasi dari belakang ke depan agar kartu urutan 1 tetap paling atas
    for (let i = scrapedCards.length - 1; i >= 0; i--) {
      const card = scrapedCards[i];
      const existingIdx = masterList.findIndex(d => d.slug === card.slug);

      if (existingIdx > -1) {
        if (isNewOnly) {
          // Lewati judul yang sudah ada jika mode scrape baru saja
          continue;
        }

        // Mode sync-order: Perbarui urutan dan bersihkan judul duplikat
        const [item] = masterList.splice(existingIdx, 1);
        item.title = sanitizeTitle(item.title) || card.title;
        if (card.cover && !item.cover) item.cover = card.cover;

        const safeEp = card.epRaw !== '1' ? card.epRaw : (item['latest-episode'] || '1');
        item['latest-episode'] = safeEp;
        item.episode = `Ep ${safeEp}`;
        item.updated_at = new Date().toISOString();

        masterList.unshift(item);
        updatedCount++;
      } else {
        // Judul baru: Ambil data sinopsis & genres lengkap
        console.log(`  ✨ Menambahkan judul baru: ${card.title} (${card.slug})`);
        const detail = await fetchDonghuaDetail(page, card.link);

        const newItem = {
          title: card.title,
          slug: card.slug,
          link: card.link,
          cover: card.cover,
          type: "Donghua",
          status: detail.status || "Ongoing",
          episode: `Ep ${card.epRaw}`,
          released: detail.released || "Tanggal -",
          genres: detail.genres.length > 0 ? detail.genres : [
            "Action", "Adventure", "Fantasy", "Martial Arts", "Cultivation"
          ],
          synopsis: detail.synopsis || "",
          "latest-episode": card.epRaw,
          updated_at: new Date().toISOString()
        };

        masterList.unshift(newItem);
        updatedCount++;
      }
    }

    fs.writeFileSync(masterPath, JSON.stringify(masterList, null, 2), 'utf-8');
    console.log(`✅ Berhasil memproses ${updatedCount} judul ke donghua.json.`);

    // Git push otomatis
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
        console.log('ℹ️ Tidak ada perubahan urutan katalog.');
      }
    } catch (pushErr) {
      console.warn(`⚠️ Gagal git push otomatis: ${pushErr.message}`);
      try {
        execSync('git rebase --abort', { stdio: 'ignore' });
      } catch (_) {}
    }

  } catch (error) {
    console.error('Error saat eksekusi scraper:', error);
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
