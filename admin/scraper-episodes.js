import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

puppeteer.use(StealthPlugin());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const targetSlug = process.env.TARGET_SLUG || process.argv[2];

if (!targetSlug) {
  console.error('Target slug tidak ditemukan!');
  process.exit(1);
}

const BASE_URL = 'https://anichin.moe';
const targetUrl = `${BASE_URL}/${targetSlug}/`;

async function run() {
  console.log(`=== Memulai Scraping Episode & Server: ${targetSlug} ===`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  // Blokir file media/gambar agar hemat kuota & cepat
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    console.log(`Membuka halaman utama donghua: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(2000);

    const mainContent = await page.content();
    const $ = cheerio.load(mainContent);

    // 1. Kumpulkan semua link episode dari tabel / list (.eplister)
    const episodesQueue = [];
    $('.eplister ul li, .episodelist ul li').each((_, el) => {
      const row = $(el);
      const link = row.find('a').attr('href');
      const epNum = row.find('.epl-num').text().trim() || row.find('.epl-sub .status').text().trim();
      const title = row.find('.epl-title').text().trim() || `Episode ${epNum}`;
      const date = row.find('.epl-date').text().trim();

      if (link) {
        episodesQueue.push({ epNum, title, link, date });
      }
    });

    console.log(`Ditemukan ${episodesQueue.length} episode. Mengambil server player...`);

    const detailedEpisodes = [];

    // 2. Kunjungi setiap episode untuk mengambil dropdown server video
    for (const ep of episodesQueue) {
      console.log(`-> Mengambil server: ${ep.title} (${ep.link})`);
      try {
        await page.goto(ep.link, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(1500);

        const epHtml = await page.content();
        const $$ = cheerio.load(epHtml);

        const servers = [];

        // Opsi A: Dropdown select option player (mirip tema Dooplay)
        $$('select.mirror option, .server-select option').each((_, opt) => {
          const optEl = $$(opt);
          const serverName = optEl.text().trim();
          let serverValue = optEl.attr('value') || '';

          // Jika valuenya base64 embed code
          if (serverValue && serverValue !== '0' && !serverValue.includes('Pilih Server')) {
            try {
              if (!serverValue.startsWith('http') && serverValue.length > 20) {
                const decoded = Buffer.from(serverValue, 'base64').toString('utf-8');
                const srcMatch = decoded.match(/src=["'](.*?)["']/);
                if (srcMatch && srcMatch[1]) serverValue = srcMatch[1];
              }
            } catch (_) {}

            servers.push({
              name: serverName,
              link: serverValue
            });
          }
        });

        // Opsi B: Tab mirror/server biasa (.mirror a / ul li)
        if (servers.length === 0) {
          $$('.mirror a, .mobius select option').each((_, m) => {
            const mEl = $$(m);
            const sName = mEl.text().trim();
            const sLink = mEl.attr('href') || mEl.attr('value') || '';
            if (sLink && sLink !== '#' && !sName.toLowerCase().includes('pilih server')) {
              servers.push({ name: sName, link: sLink });
            }
          });
        }

        // Opsi C: Iframe player default aktif di halaman
        const defaultIframe = $$('.player-embed iframe, #pembed iframe, .video-content iframe').attr('src');
        if (defaultIframe && !servers.some(s => s.link === defaultIframe)) {
          servers.unshift({ name: 'Default Server', link: defaultIframe });
        }

        detailedEpisodes.push({
          episode: ep.epNum,
          title: ep.title,
          link: ep.link,
          date: ep.date,
          servers: servers
        });
      } catch (epErr) {
        console.error(`Gagal ekstrak episode ${ep.epNum}:`, epErr.message);
      }
    }

    // 3. Simpan hasil ke /donghua/episodes/{slug}.json
    const episodesDir = path.resolve('donghua/episodes');
    if (!fs.existsSync(episodesDir)) {
      fs.mkdirSync(episodesDir, { recursive: true });
    }

    const outputPath = path.join(episodesDir, `${targetSlug}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(detailedEpisodes, null, 2), 'utf-8');
    console.log(`SUKSES! Data ${detailedEpisodes.length} episode tersimpan di ${outputPath}`);

  } catch (err) {
    console.error('Error saat scraping:', err);
  } finally {
    await browser.close();
  }
}

run();
