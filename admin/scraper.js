import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const allDonghua = [];
  let page = 1;
  let hasNext = true;

  console.log('=== Memulai Scraping Anichin ===');

  while (hasNext) {
    const url = `https://anichin.moe/anime/?page=${page}&status=&type=&order=update`;
    console.log(`Mengambil halaman: ${page}...`);

    try {
      const { data } = await axios.get(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
        },
        timeout: 15000,
      });

      const $ = cheerio.load(data);
      const items = [];

      $('article.bs, .animposx, .listupd article').each((_, el) => {
        const item = $(el);
        const title =
          item.find('.tt h2, .tt, .title, h2').first().text().trim() ||
          item.find('a').attr('title') ||
          '';
        const link = item.find('a').first().attr('href') || '';
        const cover =
          item.find('img').attr('data-src') ||
          item.find('img').attr('data-lazy-src') ||
          item.find('img').attr('src') ||
          '';
        const type = item.find('.type, .typeflag').first().text().trim() || 'Donghua';
        const status = item.find('.status, .bt .epx').first().text().trim() || 'Unknown';
        const episode = item.find('.epx').first().text().trim() || '-';

        if (title && link) {
          items.push({ title, link, cover, type, status, episode });
        }
      });

      if (items.length === 0) {
        console.log(`Halaman ${page} tidak memiliki data. Selesai.`);
        break;
      }

      allDonghua.push(...items);
      console.log(`Halaman ${page}: Sukses (${items.length} item).`);

      const nextBtn = $('.pagination .next, .hpage .r, a.next');
      if (nextBtn.length > 0) {
        page++;
        await sleep(1000); // Jeda sopan agar aman dari blokir
      } else {
        hasNext = false;
      }
    } catch (err) {
      console.error(`Gagal di halaman ${page}:`, err.message);
      break;
    }
  }

  // Simpan ke /donghua/donghua.json
  const outputDir = path.resolve('donghua');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, 'donghua.json');
  fs.writeFileSync(outputPath, JSON.stringify(allDonghua, null, 2), 'utf-8');
  console.log(`Selesai! Total ${allDonghua.length} donghua tersimpan di ${outputPath}`);
}

run();
