import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

puppeteer.use(StealthPlugin());

const BASE_URL = 'https://anichin.moe';

function parseEpisodeNumber(epString) {
  if (!epString) return 0;
  const match = String(epString).match(/(\d+(\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

function getLocalLatestEpisode(slug) {
  const filePath = path.resolve(`donghua/episodes/${slug}.json`);
  if (!fs.existsSync(filePath)) return null;

  try {
    const episodes = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!Array.isArray(episodes) || episodes.length === 0) return null;

    let maxEp = 0;
    for (const ep of episodes) {
      const num = parseEpisodeNumber(ep.episode);
      if (num > maxEp) maxEp = num;
    }
    return maxEp > 0 ? maxEp : null;
  } catch (_) {
    return null;
  }
}

async function fetchWebLatestEpisode(page, slug) {
  const possibleUrls = [
    `${BASE_URL}/${slug}/`,
    `${BASE_URL}/anime/${slug}/`
  ];

  for (const url of possibleUrls) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      const html = await page.content();
      const $ = cheerio.load(html);

      let foundEp = '';
      $('.lastend .inep, .episodegap, .epcur, .epcurlast, div').each((_, el) => {
        const txt = $(el).text().trim();
        if (txt.includes('Episode Baru')) {
          const match = txt.match(/Episode\s*Baru[\s\S]*?(?:Episode\s*)?(\d+[\w.-]*)/i);
          if (match && match[1]) foundEp = match[1].trim();
        }
      });

      if (!foundEp) {
        const firstEp = $('.eplister ul li, .episodelist ul li, ul.clstyle li').first();
        const epNum = firstEp.find('.epl-num, .epx').text().trim() || firstEp.find('a').text().trim();
        if (epNum) foundEp = epNum;
      }

      if (foundEp) {
        return parseEpisodeNumber(foundEp);
      }
    } catch (_) {}
  }
  return null;
}

function bumpDonghuaToTop(slug, newEpisodeNum) {
  const masterPath = path.resolve('donghua/donghua.json');
  if (!fs.existsSync(masterPath)) return;

  try {
    const rawData = fs.readFileSync(masterPath, 'utf-8');
    let donghuaList = JSON.parse(rawData);

    const index = donghuaList.findIndex((item) => item.slug === slug);
    if (index > -1) {
      const [item] = donghuaList.splice(index, 1);
      item['latest-episode'] = String(newEpisodeNum);
      item.episode = `Ep ${newEpisodeNum}`;
      item.updated_at = new Date().toISOString();

      donghuaList.unshift(item);

      fs.writeFileSync(masterPath, JSON.stringify(donghuaList, null, 2), 'utf-8');
      console.log(`📌 [BUMP] Posisi ${slug} berhasil dipindahkan ke baris teratas.`);
    }
  } catch (err) {
    console.error(`Gagal bump donghua: ${err.message}`);
  }
}

async function run() {
  const masterPath = path.resolve('donghua/donghua.json');
  if (!fs.existsSync(masterPath)) {
    console.error('File donghua/donghua.json tidak ditemukan!');
    process.exit(1);
  }

  const donghuaList = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
  console.log(`Total terdaftar di katalog: ${donghuaList.length} donghua\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36');
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  for (let i = 0; i < donghuaList.length; i++) {
    const item = donghuaList[i];
    const slug = item.slug;

    console.log(`[${i + 1}/${donghuaList.length}] Memeriksa: ${item.title} (${slug})`);

    const localEp = getLocalLatestEpisode(slug);
    const webEp = await fetchWebLatestEpisode(page, slug);

    if (!webEp) {
      console.log(`  ⚠️ Gagal mengambil info web, dilewati.`);
      continue;
    }

    console.log(`  - Episode Lokal : ${localEp !== null ? localEp : 'Belum discrape'}`);
    console.log(`  - Episode di Web: ${webEp}`);

    if (localEp !== null && localEp >= webEp) {
      console.log(`  ⏩ Sudah up-to-date (Ep ${localEp}). Dilewati.`);
      continue;
    }

    console.log(`  🚀 RILISAN BARU DITEMUKAN! Mulai scrape episode...`);
    try {
      execSync(`node admin/scraper-episodes.js ${slug}`, { stdio: 'inherit' });
      bumpDonghuaToTop(slug, webEp);
    } catch (err) {
      console.error(`  ❌ Gagal scrape ${slug}: ${err.message}`);
    }
  }

  await browser.close();
  console.log('\n=== Semua pengecekan & update selesai ===');
}

run();
