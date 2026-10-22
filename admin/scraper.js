import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

puppeteer.use(StealthPlugin());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE_URL = 'https://anichin.moe';
const SITE_DOMAIN = 'https://dongflix.my.id';

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

async function run() {
  const allDonghua = [];
  let page = 1;
  let hasNext = true;

  console.log('=== Memulai Scraping Anichin (List + Detail) ===');

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

  // Batasi pemuatan gambar saat buka halaman detail agar proses lebih cepat
  await browserPage.setRequestInterception(true);
  browserPage.on('request', (req) => {
    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  while (hasNext) {
    const listUrl = `${BASE_URL}/anime/?page=${page}&status=&type=&order=update`;
    console.log(`Mengambil daftar halaman: ${page}...`);

    try {
      await browserPage.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await sleep(1500);

      const content = await browserPage.content();
      const $ = cheerio.load(content);
      const listItems = [];

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
        const status = item.find('.status, .bt .epx').first().text().trim() || 'Ongoing';

        if (title && slug) {
          listItems.push({ title, slug, link: fullLink, cover, type, status });
        }
      });

      if (listItems.length === 0) {
        console.log(`Tidak ada item di halaman ${page}. Berhenti.`);
        break;
      }

      console.log(`Ditemukan ${listItems.length} item di halaman ${page}. Mengambil data detail...`);

      // Buka tiap link anime untuk ekstrak Sinopsis, Kategori, Tanggal Rilis, dan Episode detail
      for (const item of listItems) {
        try {
          console.log(`-> Scrape detail: ${item.slug}`);
          await browserPage.goto(item.link, { waitUntil: 'domcontentloaded', timeout: 25000 });
          await sleep(600);

          const detailHtml = await browserPage.content();
          const $$ = cheerio.load(detailHtml);

          // 1. Ekstrak Sinopsis (mengambil teks paragraf di bawah container sinopsis)
          let synopsis = $$('.synopsis, .entry-content, .desc, .mindesc')
            .find('p')
            .map((_, p) => $$(p).text().trim())
            .get()
            .filter((t) => t.length > 0)
            .join('\n\n');

          if (!synopsis) {
            synopsis = $$('.synopsis, .entry-content, .desc').text().trim() || '-';
          }

          // 2. Ekstrak Kategori / Genre
          const genres = [];
          $$('.genxed a, .genre-info a, a[href*="/genres/"]').each((_, g) => {
            const gText = $$(g).text().trim();
            if (gText && !genres.includes(gText)) genres.push(gText);
          });

          // 3. Ekstrak Info dari Metadata Spesifikasi (.spe atau .info-content)
          let released = '-';
          let totalEpisode = '-';

          $$('.spe span, .info-content span').each((_, span) => {
            const rowText = $$(span).text();
            if (/Released|Rilis|Tayang/i.test(rowText)) {
              released = rowText.replace(/Released|Rilis|Tayang|:/gi, '').trim();
            }
            if (/Episodes|Episode/i.test(rowText)) {
              totalEpisode = rowText.replace(/Episodes|Episode|:/gi, '').trim();
            }
          });

          // Fallback episode jika tidak ada di metadata spesifikasi
          if (totalEpisode === '-' || totalEpisode === '') {
            const lastEp = $$('.eplister ul li .epl-num').first().text().trim();
            totalEpisode = lastEp || item.status;
          }

          allDonghua.push({
            title: item.title,
            slug: item.slug,
            link: item.link,
            cover: item.cover,
            type: item.type,
            status: item.status,
            episode: totalEpisode,
            released: released,
            genres: genres.length > 0 ? genres : ['3D Animation'],
            synopsis: synopsis
          });
        } catch (detailErr) {
          console.error(`Gagal scrape detail ${item.slug}:`, detailErr.message);
          // Simpan dengan fallback data
          allDonghua.push({
            ...item,
            episode: '-',
            released: '-',
            genres: ['Donghua'],
            synopsis: '-'
          });
        }
      }

      const nextBtn = $('.pagination .next, .hpage .r, a.next');
      if (nextBtn.length > 0) {
        page++;
      } else {
        hasNext = false;
      }
    } catch (err) {
      console.error(`Gagal di halaman ${page}:`, err.message);
      break;
    }
  }

  await browser.close();

  if (allDonghua.length > 0) {
    const outputDir = path.resolve('donghua');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const jsonPath = path.join(outputDir, 'donghua.json');
    fs.writeFileSync(jsonPath, JSON.stringify(allDonghua, null, 2), 'utf-8');
    console.log(`Sukses: ${allDonghua.length} item lengkap disimpan di ${jsonPath}`);

    const sitemapContent = generateSitemapXml(allDonghua);
    fs.writeFileSync(path.resolve('sitemap.xml'), sitemapContent, 'utf-8');
    console.log('Sitemap.xml berhasil diperbarui.');
  }
}

run();
