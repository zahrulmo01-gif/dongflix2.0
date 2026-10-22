import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

puppeteer.use(StealthPlugin());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const allDonghua = [];
  let page = 1;
  let hasNext = true;

  console.log('=== Memulai Scraping Anichin (Stealth Browser) ===');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu'
    ]
  });

  const browserPage = await browser.newPage();
  await browserPage.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  while (hasNext) {
    const url = `https://anichin.moe/anime/?page=${page}&status=&type=&order=update`;
    console.log(`Membuka halaman ${page}...`);

    try {
      await browserPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000); // Tunggu render script halaman

      const content = await browserPage.content();
      const $ = cheerio.load(content);
      const items = [];

      $('article.bs, .animposx, .listupd article').each((_, el) => {
        const item = $(el);
        const title =
          item.find('.tt h2').text().trim() ||
          item.find('.tt').text().trim() ||
          item.find('h2').first().text().trim() ||
          item.find('a').attr('title') ||
          '';

        const link = item.find('a').first().attr('href') || '';
        const img = item.find('img').first();
        const cover =
          img.attr('data-src') ||
          img.attr('data-lazy-src') ||
          img.attr('src') ||
          '';

        const type = item.find('.type, .typeflag').first().text().trim() || 'Donghua';
        const status = item.find('.status, .bt .epx').first().text().trim() || 'Ongoing';
        const episode = item.find('.epx').first().text().trim() || '-';

        if (title && link) {
          items.push({ title, link, cover, type, status, episode });
        }
      });

      if (items.length === 0) {
        console.log(`Tidak ada item ditemukan di halaman ${page}. Selesai.`);
        break;
      }

      allDonghua.push(...items);
      console.log(`Halaman ${page}: Berhasil mengambil ${items.length} item.`);

      const nextBtn = $('.pagination .next, .hpage .r, a.next');
      if (nextBtn.length > 0) {
        page++;
      } else {
        console.log('Halaman terakhir tercapai.');
        hasNext = false;
      }
    } catch (err) {
      console.error(`Gagal di halaman ${page}:`, err.message);
      break;
    }
  }

  await browser.close();

  const outputDir = path.resolve('donghua');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, 'donghua.json');
  if (allDonghua.length > 0) {
    fs.writeFileSync(outputPath, JSON.stringify(allDonghua, null, 2), 'utf-8');
    console.log(`SUKSES! Total ${allDonghua.length} item disimpan ke ${outputPath}`);
  }
}

run();
