import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

puppeteer.use(StealthPlugin());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE_URL = 'https://anichin.moe';
const SITE_DOMAIN = 'https://dongflix.my.id';
const CONCURRENCY = 5; // Memproses 5 halaman sekaligus secara paralel

function resolveUrl(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

function generateSitemapXml(donghuaList) {
  const today = new Date().toISOString().split('T')[0];
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
  xml += `  <url>\n    <loc>${SITE_DOMAIN}/</loc>\n    <lastmod>${today}</lastmod>\n    <priority>1.0</priority>\n  </url>\n`;
  xml += `  <url>\n    <loc>${SITE_DOMAIN}/donghua/</loc>\n    <lastmod>${today}</lastmod>\n    <priority>0.9</priority>\n  </url>\n`;

  donghuaList.forEach((item) => {
    if (item.slug) {
      xml += `  <url>\n    <loc>${SITE_DOMAIN}/donghua/${encodeURIComponent(item.slug)}</loc>\n    <lastmod>${today}</lastmod>\n    <priority>0.8</priority>\n  </url>\n`;
    }
  });

  xml += `</urlset>`;
  return xml;
}

// Setup tab cepat (blokir CSS, gambar, font, audio/video)
async function setupFastPage(browser) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'stylesheet', 'font', 'media', 'other'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });
  return page;
}

async function run() {
  console.log('=== Scraper Turbo Dimulai ===');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process'
    ]
  });

  const mainPage = await setupFastPage(browser);
  const queue = [];
  let pageNum = 1;
  let hasNext = true;

  // 1. Ekstrak Semua Daftar Cepat
  console.log('Mengambil daftar halaman katalog...');
  while (hasNext) {
    const listUrl = `${BASE_URL}/anime/?page=${pageNum}&status=&type=&order=update`;
    try {
      await mainPage.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const html = await mainPage.content();
      const $ = cheerio.load(html);

      const items = [];
      $('article.bs, .animposx, .listupd article').each((_, el) => {
        const item = $(el);
        const title = item.find('.tt h2, .tt, h2').first().text().trim() || item.find('a').attr('title') || '';
        const rawLink = item.find('a').first().attr('href') || '';
        const fullLink = resolveUrl(rawLink);
        const slug = fullLink.replace(BASE_URL, '').replace(/^\/+|\/+$/g, '').split('/').pop();
        const rawCover = item.find('img').first().attr('data-src') || item.find('img').first().attr('src') || '';
        const cover = resolveUrl(rawCover);
        const type = item.find('.type, .typeflag').first().text().trim() || 'Donghua';
        const status = item.find('.status, .bt .epx').first().text().trim() || 'Ongoing';

        if (title && slug) items.push({ title, slug, link: fullLink, cover, type, status });
      });

      if (items.length === 0) break;
      queue.push(...items);
      console.log(`Page ${pageNum} OK (${items.length} item)`);

      const nextBtn = $('.pagination .next, .hpage .r, a.next');
      if (nextBtn.length > 0) {
        pageNum++;
      } else {
        hasNext = false;
      }
    } catch (e) {
      console.error(`Page ${pageNum} error:`, e.message);
      break;
    }
  }

  await mainPage.close();
  console.log(`Total terkumpul: ${queue.length} item. Memulai scraping paralel detail...`);

  // 2. Scraping Detail Paralel (5 item sekaligus)
  const detailedResults = [];
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const chunk = queue.slice(i, i + CONCURRENCY);

    const chunkPromises = chunk.map(async (item) => {
      const page = await setupFastPage(browser);
      try {
        await page.goto(item.link, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const html = await page.content();
        const $$ = cheerio.load(html);

        let synopsis = $$('.synopsis, .entry-content, .desc')
          .find('p')
          .map((_, p) => $$(p).text().trim())
          .get()
          .filter((t) => t.length > 0)
          .join('\n\n');

        if (!synopsis) synopsis = $$('.synopsis, .entry-content, .desc').text().trim() || '-';

        const genres = [];
        $$('.genxed a, .genre-info a, a[href*="/genres/"]').each((_, g) => {
          const gText = $$(g).text().trim();
          if (gText && !genres.includes(gText)) genres.push(gText);
        });

        let released = '-';
        let totalEpisode = '-';
        $$('.spe span, .info-content span').each((_, span) => {
          const rowText = $$(span).text();
          if (/Released|Rilis|Tayang/i.test(rowText)) released = rowText.replace(/Released|Rilis|Tayang|:/gi, '').trim();
          if (/Episodes|Episode/i.test(rowText)) totalEpisode = rowText.replace(/Episodes|Episode|:/gi, '').trim();
        });

        if (totalEpisode === '-' || !totalEpisode) {
          totalEpisode = $$('.eplister ul li .epl-num').first().text().trim() || item.status;
        }

        return {
          ...item,
          episode: totalEpisode,
          released,
          genres: genres.length > 0 ? genres : ['Donghua'],
          synopsis
        };
      } catch {
        return { ...item, episode: '-', released: '-', genres: ['Donghua'], synopsis: '-' };
      } finally {
        await page.close();
      }
    });

    const chunkResults = await Promise.all(chunkPromises);
    detailedResults.push(...chunkResults);
    console.log(`Proses detail: ${detailedResults.length}/${queue.length}`);
  }

  await browser.close();

  // 3. Simpan Hasil
  const outputDir = path.resolve('donghua');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const jsonPath = path.join(outputDir, 'donghua.json');
  fs.writeFileSync(jsonPath, JSON.stringify(detailedResults, null, 2), 'utf-8');
  console.log(`Selesai! ${detailedResults.length} item berhasil disimpan.`);

  const sitemapContent = generateSitemapXml(detailedResults);
  fs.writeFileSync(path.resolve('sitemap.xml'), sitemapContent, 'utf-8');
}

run();
