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

function removeDuplicateTitle(rawTitle) {
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

async function syncOrderMode(page) {
  console.log('=== Menjalankan Scraper Mode: SYNC-ORDER ===');
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

  const targetUrl = `${BASE_URL}/donghua/`;
  console.log(`Membaca daftar dari: ${targetUrl}`);

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
  const html = await page.content();
  const $ = cheerio.load(html);

  const webSlugsInOrder = [];
  const items = $('.listupd article, .animepost, .bsx, .animpost');

  if (items.length > 0) {
    items.each((_, el) => {
      const card = $(el);
      const linkEl = card.find('a').first();
      const rawLink = resolveUrl(linkEl.attr('href') || '');
      const slug = extractSlug(rawLink);

      if (!slug || slug === 'donghua' || slug === 'anime') return;

      const rawTitle = linkEl.attr('title') || 
                       card.find('.tt h2, .entry-title, .title').first().text() || 
                       card.find('.tt').first().text() || '';

      const title = removeDuplicateTitle(rawTitle);

      let cover = card.find('img').attr('src') || card.find('img').attr('data-src') || '';
      if (cover.startsWith('//')) cover = `https:${cover}`;

      const epRaw = card.find('.epx, .bt .ep, .sb').first().text().trim();
      const epNum = parseEpisodeNumber(epRaw);

      webSlugsInOrder.push({
        slug,
        title,
        cover,
        episode: epNum > 0 ? `Ep ${epNum}` : (epRaw || 'Ep 1'),
        'latest-episode': epNum > 0 ? String(epNum) : '1'
      });
    });
  }

  console.log(`Berhasil membaca ${webSlugsInOrder.length} judul dari halaman utama.`);

  // Susun ulang masterList mengikuti urutan web terbaru
  let updatedCount = 0;
  for (let i = webSlugsInOrder.length - 1; i >= 0; i--) {
    const webItem = webSlugsInOrder[i];
    const existingIndex = masterList.findIndex(d => d.slug === webItem.slug);

    if (existingIndex > -1) {
      const [existingItem] = masterList.splice(existingIndex, 1);
      existingItem['latest-episode'] = webItem['latest-episode'] !== '1' ? webItem['latest-episode'] : (existingItem['latest-episode'] || '1');
      existingItem.episode = `Ep ${existingItem['latest-episode']}`;
      existingItem.updated_at = new Date().toISOString();
      masterList.unshift(existingItem);
      updatedCount++;
    } else {
      masterList.unshift({
        slug: webItem.slug,
        title: webItem.title || webItem.slug,
        cover: webItem.cover || '',
        status: 'Ongoing',
        type: 'Donghua',
        'latest-episode': webItem['latest-episode'],
        episode: webItem.episode,
        updated_at: new Date().toISOString()
      });
      updatedCount++;
    }
  }

  fs.writeFileSync(masterPath, JSON.stringify(masterList, null, 2), 'utf-8');
  console.log(`✅ Berhasil menyinkronkan urutan untuk ${updatedCount} donghua.`);

  try {
    execSync('git config --local user.email "action@github.com"', { stdio: 'ignore' });
    execSync('git config --local user.name "GitHub Action Bot"', { stdio: 'ignore' });
    execSync('git add donghua/donghua.json', { stdio: 'ignore' });

    const status = execSync('git status --porcelain').toString().trim();
    if (status) {
      execSync('git commit -m "Auto: Sync Catalog Order [skip ci]"', { stdio: 'inherit' });
      try {
        execSync('git pull --rebase origin main', { stdio: 'inherit' });
      } catch (_) {
        execSync('git pull --rebase', { stdio: 'inherit' });
      }
      execSync('git push origin main', { stdio: 'inherit' });
      console.log('🚀 Perubahan katalog berhasil di-push ke GitHub!');
    } else {
      console.log('ℹ️ Urutan katalog sudah sinkron. Tidak ada commit baru.');
    }
  } catch (err) {
    console.warn(`⚠️ Gagal git push otomatis: ${err.message}`);
    try {
      execSync('git rebase --abort', { stdio: 'ignore' });
    } catch (_) {}
  }
}

async function main() {
  const isSyncOrder = process.argv.includes('--mode=sync-order');

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
    if (isSyncOrder) {
      await syncOrderMode(page);
    } else {
      console.log('Jalankan dengan argumen --mode=sync-order untuk menyelaraskan urutan katalog.');
    }
  } catch (error) {
    console.error('Terjadi error saat menjalankan scraper:', error);
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
