import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

puppeteer.use(StealthPlugin());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE_URL = 'https://anichin.moe';
const SITE_DOMAIN = 'https://dongflix.my.id'; // Domain web kamu

function resolveUrl(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

// Fungsi generate sitemap XML format standar Google
function generateSitemapXml(donghuaList) {
  const today = new Date().toISOString().split('T')[0];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

  // 1. Halaman Utama / Homepage
  xml += `  <url>\n`;
  xml += `    <loc>${SITE_DOMAIN}/</loc>\n`;
  xml += `    <lastmod>${today}</lastmod>\n`;
  xml += `    <changefreq>daily</changefreq>\n`;
  xml += `    <priority>1.0</priority>\n`;
  xml += `  </url>\n`;

  // 2. Halaman Indeks Katalog /donghua/
  xml += `  <url>\n`;
  xml += `    <loc>${SITE_DOMAIN}/donghua/</loc>\n`;
  xml += `    <lastmod>${today}</lastmod>\n`;
  xml += `    <changefreq>daily</changefreq>\n`;
  xml += `    <priority>0.9</priority>\n`;
  xml += `  </url>\n`;

  // 3. Tiap URL Slug Donghua (/donghua/:slug)
  donghuaList.forEach((item) => {
    if (item.slug) {
      xml += `  <url>\n`;
      xml += `    <loc>${SITE_DOMAIN}/donghua/${encodeURIComponent(item.slug)}</loc>\n`;
      xml += `    <lastmod>${today}</lastmod>\n`;
      xml += `    <changefreq>weekly</changefreq>\n`;
      xml += `    <priority>0.8</priority>\n`;
      xml += `  </url>\n`;
    }
  });

  xml += `</urlset>`;
  return xml;
}

async function run() {
  const allDonghua = [];
  let page = 1;
  let hasNext = true;

  console.log('=== Memulai Scraping Anichin ===');

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
    const targetUrl = `${BASE_URL}/anime/?page=${page}&status=&type=&order=update`;
    console.log(`Membuka halaman ${page}...`);

    try {
      await browserPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);

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

        const rawLink = item.find('a').first().attr('href') || '';
        const fullLink = resolveUrl(rawLink);
        
        const slug = fullLink
          .replace(BASE_URL, '')
          .replace(/^\/+|\/+$/g, '')
          .split('/')
          .pop();

        const img = item.find('img').first();
        const rawCover =
          img.attr('data-src') ||
          img.attr('data-lazy-src') ||
          img.attr('src') ||
          '';
        const cover = resolveUrl(rawCover);

        const type = item.find('.type, .typeflag').first().text().trim() || 'Donghua';

        let epText = item.find('.bt .epx, .epx, .animepost .epx').first().text().trim();
        let statusText = item.find('.status, .bt .status').first().text().trim();

        if (/^(ongoing|completed)$/i.test(epText)) {
          statusText = epText;
          epText = item.find('.sb, .episode, .eps').first().text().trim() || '-';
        }

        if (!statusText) {
          statusText = item.find('.status').text().trim() || 'Ongoing';
        }

        if (title && slug) {
          items.push({
            title,
            slug,
            link: fullLink,
            cover,
            type,
            status: statusText || 'Ongoing',
            episode: epText || '-'
          });
        }
      });

      if (items.length === 0) {
        console.log(`Halaman ${page} tidak memiliki item. Scraping selesai.`);
        break;
      }

      allDonghua.push(...items);
      console.log(`Halaman ${page}: ${items.length} item berhasil diambil.`);

      const nextBtn = $('.pagination .next, .hpage .r, a.next');
      if (nextBtn.length > 0) {
        page++;
      } else {
        hasNext = false;
      }
    } catch (err) {
      console.error(`Gagal scraping di halaman ${page}:`, err.message);
      break;
    }
  }

  await browser.close();

  if (allDonghua.length > 0) {
    // 1. Simpan ke /donghua/donghua.json
    const outputDir = path.resolve('donghua');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const jsonPath = path.join(outputDir, 'donghua.json');
    fs.writeFileSync(jsonPath, JSON.stringify(allDonghua, null, 2), 'utf-8');
    console.log(`JSON tersimpan: ${allDonghua.length} item di ${jsonPath}`);

    // 2. Simpan ke /sitemap.xml di root project
    const sitemapContent = generateSitemapXml(allDonghua);
    const sitemapPath = path.resolve('sitemap.xml');
    fs.writeFileSync(sitemapPath, sitemapContent, 'utf-8');
    console.log(`Sitemap tersimpan di ${sitemapPath}`);
  }
}

run();
