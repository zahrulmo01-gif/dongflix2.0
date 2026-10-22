import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

puppeteer.use(StealthPlugin());

const BASE_URL = 'https://anichin.moe';

function resolveUrl(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

function cleanText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function extractSlug(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && parts[0] === 'anime') return parts[1];
    return parts[parts.length - 1] || '';
  } catch (_) {
    return '';
  }
}

async function setupPageConfig(page) {
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    // Blokir resource berat untuk menghemat kuota dan memori runner
    if (['font', 'media'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });
}

async function run() {
  console.log('=== Memulai Scraper Katalog Master Donghua ===');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process'
    ]
  });

  const page = await browser.newPage();
  await setupPageConfig(page);

  // Baca database lama jika sudah ada
  const masterPath = path.resolve('donghua/donghua.json');
  let existingData = [];
  if (fs.existsSync(masterPath)) {
    try {
      existingData = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
    } catch (_) {}
  }

  const existingMap = new Map();
  for (const item of existingData) {
    if (item.slug) existingMap.set(item.slug, item);
  }

  // Target URL daftar donghua
  const listTargets = [
    `${BASE_URL}/donghua/`,
    `${BASE_URL}/anime/`,
    `${BASE_URL}/az-list/`
  ];

  let rawDonghuaList = [];

  for (const url of listTargets) {
    try {
      console.log(`Mengakses target katalog: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      const html = await page.content();
      const $ = cheerio.load(html);

      const items = $('.listupd article, .animepost, .bsx, .animpost');

      if (items.length > 0) {
        items.each((_, el) => {
          const card = $(el);
          const linkEl = card.find('a').first();
          const rawLink = resolveUrl(linkEl.attr('href') || '');
          const slug = extractSlug(rawLink);

          if (!slug || slug === 'donghua' || slug === 'anime') return;

          const title = cleanText(
            card.find('.tt, h2, .title, .entry-title').first().text() || 
            linkEl.attr('title') || 
            ''
          );

          let cover = card.find('img').attr('src') || card.find('img').attr('data-src') || '';
          if (cover.startsWith('//')) cover = `https:${cover}`;

          const status = cleanText(card.find('.status, .bt .epx').text()) || 'Ongoing';
          const epText = cleanText(card.find('.epx, .bt .epx, .egg').text()) || '-';
          const type = cleanText(card.find('.typez').text()) || 'Donghua';

          if (title && rawLink) {
            rawDonghuaList.push({
              title,
              slug,
              link: rawLink,
              cover,
              status: status.toLowerCase().includes('comp') ? 'Completed' : 'Ongoing',
              episode: epText,
              type
            });
          }
        });

        if (rawDonghuaList.length > 0) {
          console.log(`Berhasil mengambil ${rawDonghuaList.length} donghua dari ${url}`);
          break;
        }
      }
    } catch (err) {
      console.warn(`Gagal memuat target ${url}: ${err.message}`);
    }
  }

  // Fallback ke Homepage jika list khusus kosong
  if (rawDonghuaList.length === 0) {
    console.log('Mencoba fallback: scrape rilis terbaru dari homepage...');
    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 35000 });
      const html = await page.content();
      const $ = cheerio.load(html);

      $('.listupd article, .bsx, .animpost').each((_, el) => {
        const card = $(el);
        const linkEl = card.find('a').first();
        const rawLink = resolveUrl(linkEl.attr('href') || '');
        const slug = extractSlug(rawLink);

        if (!slug) return;

        const title = cleanText(card.find('.tt, h2, .title').first().text() || linkEl.attr('title') || '');
        let cover = card.find('img').attr('src') || card.find('img').attr('data-src') || '';
        if (cover.startsWith('//')) cover = `https:${cover}`;

        const status = cleanText(card.find('.status').text()) || 'Ongoing';
        const epText = cleanText(card.find('.epx').text()) || '-';

        if (title && rawLink) {
          rawDonghuaList.push({
            title,
            slug,
            link: rawLink,
            cover,
            status: status.toLowerCase().includes('comp') ? 'Completed' : 'Ongoing',
            episode: epText,
            type: 'Donghua'
          });
        }
      });
    } catch (_) {}
  }

  await page.close();
  await browser.close();

  // Penggabungan data cerdas tanpa duplikasi
  const finalMergedList = [];
  const processedSlugs = new Set();

  for (const item of rawDonghuaList) {
    if (processedSlugs.has(item.slug)) continue;
    processedSlugs.add(item.slug);

    const oldItem = existingMap.get(item.slug) || {};
    finalMergedList.push({
      ...oldItem,
      ...item,
      synopsis: oldItem.synopsis || item.synopsis || 'Sinopsis belum tersedia.',
      genres: oldItem.genres || item.genres || ['Donghua', '3D'],
      updated_at: new Date().toISOString()
    });
  }

  // Tambahkan judul lama yang tidak berada di halaman 1 rilis terbaru
  for (const item of existingData) {
    if (!processedSlugs.has(item.slug)) {
      processedSlugs.add(item.slug);
      finalMergedList.push(item);
    }
  }

  const outDir = path.resolve('donghua');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(masterPath, JSON.stringify(finalMergedList, null, 2), 'utf-8');
  console.log(`\nSelesai! Total ${finalMergedList.length} donghua tersimpan di ${masterPath}`);
}

run();
