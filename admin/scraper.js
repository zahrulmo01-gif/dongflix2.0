import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

puppeteer.use(StealthPlugin());

const BASE_URL = 'https://anichin.moe';

// Ambil mode dari argumen CLI (default: new-only)
const modeArg = process.argv.find((arg) => arg.startsWith('--mode=')) || '--mode=new-only';
const MODE = modeArg.split('=')[1]; // 'new-only' atau 'sync-order'

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
    if (['font', 'media', 'stylesheet'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });
}

async function run() {
  console.log(`=== Menjalankan Scraper List Katalog (Mode: ${MODE}) ===`);

  const masterPath = path.resolve('donghua/donghua.json');
  let existingData = [];
  if (fs.existsSync(masterPath)) {
    try {
      existingData = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
    } catch (_) {
      existingData = [];
    }
  }

  const existingMap = new Map();
  const existingSlugs = new Set();
  for (const item of existingData) {
    if (item.slug) {
      existingMap.set(item.slug, item);
      existingSlugs.add(item.slug);
    }
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const page = await browser.newPage();
  await setupPageConfig(page);

  // Ambil data halaman depan atau list katalog Anichin
  const listTargets = [
    `${BASE_URL}/donghua/`,
    `${BASE_URL}/anime/`,
    `${BASE_URL}/`
  ];

  let webDonghuaList = [];

  for (const targetUrl of listTargets) {
    try {
      console.log(`Membaca daftar dari: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
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

          if (title && rawLink && !webDonghuaList.some((w) => w.slug === slug)) {
            webDonghuaList.push({
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

        if (webDonghuaList.length > 0) {
          console.log(`Berhasil mengambil ${webDonghuaList.length} judul dari ${targetUrl}`);
          break;
        }
      }
    } catch (err) {
      console.warn(`Gagal memuat ${targetUrl}: ${err.message}`);
    }
  }

  await page.close();
  await browser.close();

  if (webDonghuaList.length === 0) {
    console.error('Tidak ada data yang berhasil diambil dari web Anichin.');
    process.exit(1);
  }

  let finalResult = [];

  // LOGIKA 1: HANYA TAMBAHKAN YANG BELUM ADA (SKIP YANG SUDAH ADA)
  if (MODE === 'new-only') {
    const brandNewItems = [];

    for (const item of webDonghuaList) {
      if (!existingSlugs.has(item.slug)) {
        brandNewItems.push({
          ...item,
          synopsis: 'Sinopsis belum tersedia.',
          genres: ['Donghua', '3D'],
          updated_at: new Date().toISOString()
        });
        existingSlugs.add(item.slug);
      }
    }

    console.log(`Donghua baru ditemukan: ${brandNewItems.length}`);
    if (brandNewItems.length === 0) {
      console.log('Semua donghua sudah ada di database. Dilewati.');
      return;
    }

    // Masukkan judul baru di atas, pertahankan urutan data lama
    finalResult = [...brandNewItems, ...existingData];
  }

  // LOGIKA 2: PERBAIKI URUTAN LIST MENGIKUTI ANICHIN
  else if (MODE === 'sync-order') {
    console.log('Menyelaraskan urutan daftar donghua mengikuti urutan Anichin...');
    const trackedSlugs = new Set();

    // 1. Masukkan item yang sesuai dengan urutan web saat ini
    for (const webItem of webDonghuaList) {
      trackedSlugs.add(webItem.slug);
      const oldItem = existingMap.get(webItem.slug) || {};
      finalResult.push({
        ...oldItem,
        ...webItem,
        synopsis: oldItem.synopsis || 'Sinopsis belum tersedia.',
        genres: oldItem.genres || ['Donghua', '3D'],
        updated_at: oldItem.updated_at || new Date().toISOString()
      });
    }

    // 2. Tambahkan sisa judul lama yang ada di file lokal namun tidak muncul di halaman awal web
    for (const oldItem of existingData) {
      if (!trackedSlugs.has(oldItem.slug)) {
        trackedSlugs.add(oldItem.slug);
        finalResult.push(oldItem);
      }
    }
    console.log('Urutan list berhasil diperbaiki.');
  }

  const outDir = path.resolve('donghua');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(masterPath, JSON.stringify(finalResult, null, 2), 'utf-8');
  console.log(`Selesai! Database tersimpan dengan total ${finalResult.length} donghua.`);
}

run();
