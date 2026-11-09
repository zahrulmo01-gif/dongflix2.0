import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

puppeteer.use(StealthPlugin());

const MIRROR_DOMAINS = [
  'https://anichin.my',
  'https://anichin.co',
  'https://anichin.moe',
  'https://v1.anichin.space'
];

let ACTIVE_BASE_URL = MIRROR_DOMAINS[0];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function resolveUrl(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return `${ACTIVE_BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

function extractSlug(url) {
  if (!url) return '';
  let clean = url;
  for (const domain of MIRROR_DOMAINS) {
    clean = clean.replace(domain, '');
  }
  clean = clean.replace(/^\/+|\/+$/g, '');
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

function gitPushCheckpoint(commitMsg) {
  try {
    execSync('git config --local user.email "action@github.com"', { stdio: 'ignore' });
    execSync('git config --local user.name "GitHub Action Bot"', { stdio: 'ignore' });
    execSync('git add donghua/donghua.json', { stdio: 'ignore' });

    const status = execSync('git status --porcelain donghua/donghua.json').toString().trim();
    if (status) {
      execSync(`git commit -m "${commitMsg} [skip ci]"`, { stdio: 'inherit' });
      try {
        execSync('git pull --rebase origin main', { stdio: 'inherit' });
      } catch (_) {
        execSync('git pull --rebase', { stdio: 'inherit' });
      }
      execSync('git push origin main', { stdio: 'inherit' });
      console.log('🚀 Checkpoint tersimpan dan di-push ke GitHub!');
    }
  } catch (err) {
    console.warn(`⚠️ Gagal checkpoint: ${err.message}`);
    try { execSync('git rebase --abort', { stdio: 'ignore' }); } catch (_) {}
  }
}

async function createStealthPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent(USER_AGENT);

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  });

  return page;
}

async function fetchDonghuaDetail(page, detailUrl, fallbackTitle = '', fallbackSlug = '') {
  try {
    await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 35000 });
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

    let released = 'Tanggal -';
    let status = 'Ongoing';
    let detectedType = 'Donghua';
    let totalEp = 0;

    $('.spe span, .info-content span').each((_, el) => {
      const txt = $(el).text().trim();
      const lower = txt.toLowerCase();

      if (lower.includes('tanggal rilis') || lower.includes('released')) {
        released = txt.replace(/tanggal rilis\s*:\s*/i, '').replace(/released\s*:\s*/i, '').trim();
      }

      if (lower.includes('status')) {
        if (lower.includes('completed') || lower.includes('tamat')) {
          status = 'Completed';
        } else if (lower.includes('ongoing')) {
          status = 'Ongoing';
        }
      }

      if (lower.includes('tipe') || lower.includes('type')) {
        if (lower.includes('movie')) {
          detectedType = 'Movie';
        }
      }

      if (lower.includes('episode')) {
        const epFound = parseEpisodeNumber(txt);
        if (epFound > 0) totalEp = epFound;
      }
    });

    if (`${fallbackTitle} ${fallbackSlug}`.toLowerCase().includes('movie')) {
      detectedType = 'Movie';
    }

    let coverHigh = $('.thumb img, .bigcontent img').attr('src') || $('.thumb img, .bigcontent img').attr('data-src') || '';
    if (coverHigh.startsWith('//')) coverHigh = `https:${coverHigh}`;

    return {
      genres: genres.length > 0 ? genres : ["Action", "Adventure", "Fantasy", "Martial Arts", "Cultivation"],
      synopsis: synopsis || '',
      released: released.startsWith('Tanggal') ? released : `Tanggal  ${released}`,
      status,
      type: detectedType,
      totalEp,
      cover: coverHigh
    };
  } catch (_) {
    const isMovieFallback = `${fallbackTitle} ${fallbackSlug}`.toLowerCase().includes('movie');
    return {
      genres: ["Action", "Adventure", "Fantasy", "Martial Arts", "Cultivation"],
      synopsis: "",
      released: "Tanggal -",
      status: "Ongoing",
      type: isMovieFallback ? "Movie" : "Donghua",
      totalEp: 0,
      cover: ""
    };
  }
}

async function main() {
  const isSyncOrder = process.argv.includes('--mode=sync-order');
  const isNewOnly = process.argv.includes('--mode=new-only');
  const isUpdateAllDetails = process.argv.includes('--mode=update-all-details');

  console.log(`=== Menjalankan Scraper Katalog: ${isUpdateAllDetails ? 'UPDATE-ALL-DETAILS' : (isSyncOrder ? 'SYNC-ORDER' : (isNewOnly ? 'NEW-ONLY' : 'DEFAULT'))} ===`);

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
    headless: true,
    protocolTimeout: 240000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  });

  const page = await createStealthPage(browser);

  try {
    // 1. Uji domain yang benar-benar menampilkan kontainer kartu, bukan Cloudflare challenge
    for (const domain of MIRROR_DOMAINS) {
      try {
        console.log(`Menguji domain katalog: ${domain}...`);
        const resp = await page.goto(`${domain}/anime/?status=&type=&order=update`, { 
          waitUntil: 'networkidle2', 
          timeout: 25000 
        });

        if (resp && resp.status() === 200) {
          const content = await page.content();
          // Pastikan bukan Cloudflare block page
          if (!content.includes('Just a moment...') && !content.includes('Checking your browser')) {
            const hasList = await page.$('.listupd, .animepost, .bsx, article');
            if (hasList) {
              ACTIVE_BASE_URL = domain;
              console.log(`✅ Menggunakan domain aktif: ${ACTIVE_BASE_URL}`);
              break;
            }
          }
        }
      } catch (err) {
        console.warn(`Domain ${domain} bermasalah: ${err.message}`);
      }
    }

    const pagesToScrape = isSyncOrder ? [1, 2] : [1];
    const scrapedCards = [];

    for (const pageNum of pagesToScrape) {
      const targetUrl = pageNum === 1
        ? `${ACTIVE_BASE_URL}/anime/?status=&type=&order=update`
        : `${ACTIVE_BASE_URL}/anime/?page=${pageNum}&status=&type=&order=update`;

      console.log(`Membaca katalog dari halaman ${pageNum}: ${targetUrl}`);

      try {
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 35000 });

        // Tunggu elemen kartu muncul
        await page.waitForSelector('.listupd article, .animepost, .bsx', { timeout: 10000 }).catch(() => null);

        const html = await page.content();
        const $ = cheerio.load(html);

        // Debug info bila masih kosong
        if (html.includes('Just a moment...')) {
          console.warn('⚠️ Halaman tertahan Cloudflare bot challenge!');
        }

        const items = $('.listupd article, .animepost, .bsx, .animpost');

        items.each((_, el) => {
          const card = $(el);
          const linkEl = card.find('a').first();
          const rawLink = resolveUrl(linkEl.attr('href') || '');
          const slug = extractSlug(rawLink);

          if (!slug || slug === 'anime' || slug === 'donghua') return;

          const rawTitle = linkEl.attr('title') || 
                           card.find('.tt h2, .entry-title, .title').first().text() || 
                           card.find('.tt').first().text() || '';

          const title = sanitizeTitle(rawTitle);

          let cover = card.find('img').attr('src') || card.find('img').attr('data-src') || '';
          if (cover.startsWith('//')) cover = `https:${cover}`;

          const epRaw = card.find('.epx, .bt .ep, .sb').first().text().trim();
          const epNum = parseEpisodeNumber(epRaw);

          const typeBadge = card.find('.typez').text().trim().toLowerCase();
          const isMovie = typeBadge.includes('movie') || `${title} ${slug}`.toLowerCase().includes('movie');

          scrapedCards.push({
            slug,
            title,
            link: rawLink,
            cover,
            type: isMovie ? 'Movie' : 'Donghua',
            epRaw: epNum > 0 ? String(epNum) : '1'
          });
        });
      } catch (err) {
        console.warn(`Gagal memuat halaman ${pageNum}: ${err.message}`);
      }
    }

    console.log(`Total judul yang didapat dari halaman arsip: ${scrapedCards.length}`);

    if (scrapedCards.length === 0) {
      console.warn('⚠️ Tidak ada kartu yang ditemukan. Mirror mungkin sedang memblokir request bot.');
      return;
    }

    let updatedCount = 0;

    for (let i = scrapedCards.length - 1; i >= 0; i--) {
      const card = scrapedCards[i];
      const existingIdx = masterList.findIndex(d => d.slug === card.slug);

      if (existingIdx > -1) {
        if (isNewOnly) continue;

        const [item] = masterList.splice(existingIdx, 1);
        item.title = sanitizeTitle(item.title) || card.title;
        if (card.cover && !item.cover) item.cover = card.cover;
        if (card.type === 'Movie') item.type = 'Movie';

        const safeEp = card.epRaw !== '1' ? card.epRaw : (item['latest-episode'] || '1');
        item['latest-episode'] = safeEp;
        item.episode = `Ep ${safeEp}`;
        item.updated_at = new Date().toISOString();

        masterList.unshift(item);
        updatedCount++;
      } else {
        console.log(`✨ Menemukan judul baru di arsip: ${card.title} (${card.slug})`);
        const detail = await fetchDonghuaDetail(page, card.link, card.title, card.slug);
        const finalEp = detail.totalEp > 0 ? String(detail.totalEp) : card.epRaw;

        const newItem = {
          title: card.title,
          slug: card.slug,
          link: card.link,
          cover: card.cover || detail.cover,
          type: detail.type || card.type,
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
    console.log(`✅ Berhasil menyinkronkan ${updatedCount} judul ke urutan teratas.`);
    gitPushCheckpoint(`Auto: Update Catalog Order (${isSyncOrder ? 'Sync Order' : 'New Only'})`);

  } catch (error) {
    console.error('Terjadi error saat proses scraping:', error);
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
