import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

puppeteer.use(StealthPlugin());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE_URL = 'https://anichin.moe';

function resolveUrl(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

const rawSlug = process.env.TARGET_SLUG || process.argv[2];

if (!rawSlug) {
  console.error('Target slug tidak ditemukan!');
  process.exit(1);
}

const cleanSlug = rawSlug.replace(/^\/+|\/+$/g, '');

async function run() {
  console.log(`=== Scrape Episode Dimulai: ${cleanSlug} ===`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  // Blokir media agar scraping cepat
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  const possibleUrls = [
    `${BASE_URL}/${cleanSlug}/`,
    `${BASE_URL}/anime/${cleanSlug}/`
  ];

  let mainHtml = null;

  for (const url of possibleUrls) {
    try {
      console.log(`Mencoba membuka: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);
      const html = await page.content();
      const $ = cheerio.load(html);

      if ($('.eplister, .episodelist, .bxcl ul, ul.clstyle').length > 0) {
        mainHtml = html;
        console.log(`Berhasil menemukan daftar episode di: ${url}`);
        break;
      }
    } catch (e) {
      console.log(`URL ${url} gagal diakses: ${e.message}`);
    }
  }

  if (!mainHtml) {
    console.error('Tidak dapat menemukan container episode.');
    await browser.close();
    process.exit(1);
  }

  const $ = cheerio.load(mainHtml);
  const episodeLinks = [];

  $('.eplister ul li, .episodelist ul li, ul.clstyle li').each((_, el) => {
    const item = $(el);
    const rawLink = item.find('a').attr('href') || '';
    const fullLink = resolveUrl(rawLink);

    const epNum =
      item.find('.epl-num').text().trim() ||
      item.find('.epx').text().trim() ||
      item.find('a').text().trim();
    const title =
      item.find('.epl-title').text().trim() ||
      item.find('a').attr('title') ||
      item.find('a').text().trim();
    const date = item.find('.epl-date, .date').text().trim() || '-';

    if (fullLink && fullLink.startsWith('http')) {
      episodeLinks.push({ epNum, title, link: fullLink, date });
    }
  });

  console.log(`Total episode valid ditemukan: ${episodeLinks.length}`);

  if (episodeLinks.length === 0) {
    console.log('Tidak ada link episode valid.');
    await browser.close();
    return;
  }

  const detailedEpisodes = [];

  for (const ep of episodeLinks) {
    console.log(`-> Mengambil player: Ep ${ep.epNum} (${ep.link})`);
    try {
      await page.goto(ep.link, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await sleep(1500);

      const epContent = await page.content();
      const $$ = cheerio.load(epContent);
      const servers = [];

      // Ekstrak dropdown option player
      $$('select.mirror option, select[name="server"] option, .server-select option').each((_, opt) => {
        const o = $$(opt);
        const name = o.text().trim();
        let val = o.attr('value') || '';

        if (name && !name.toLowerCase().includes('pilih server') && val && val !== '0') {
          if (!val.startsWith('http') && val.length > 25) {
            try {
              const decoded = Buffer.from(val, 'base64').toString('utf-8');
              const srcMatch = decoded.match(/src=["'](.*?)["']/);
              if (srcMatch && srcMatch[1]) val = srcMatch[1];
            } catch (_) {}
          }
          servers.push({ name, link: val });
        }
      });

      // Ekstrak tab link player
      $$('.mirror a, .mobius a, ul.post-servers li a').each((_, a) => {
        const el = $$(a);
        const name = el.text().trim();
        const href = el.attr('href') || el.attr('data-embed') || '';
        if (name && href && href !== '#' && !servers.some(s => s.name === name)) {
          servers.push({ name, link: href });
        }
      });

      // Iframe player aktif default
      const currentIframe = $$('.player-embed iframe, #pembed iframe, .responsive-embed-stream iframe').attr('src');
      if (currentIframe && !servers.some(s => s.link === currentIframe)) {
        servers.unshift({ name: 'Default Server', link: currentIframe });
      }

      detailedEpisodes.push({
        episode: ep.epNum,
        title: ep.title,
        link: ep.link,
        date: ep.date,
        servers: servers
      });
    } catch (err) {
      console.error(`Gagal di episode ${ep.epNum}:`, err.message);
    }
  }

  await browser.close();

  const outDir = path.resolve('donghua/episodes');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outFile = path.join(outDir, `${cleanSlug}.json`);
  if (detailedEpisodes.length > 0) {
    fs.writeFileSync(outFile, JSON.stringify(detailedEpisodes, null, 2), 'utf-8');
    console.log(`SUKSES! ${detailedEpisodes.length} episode tersimpan di ${outFile}`);
  }
}

run();
