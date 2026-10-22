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
    console.log(`Mengambil halaman: ${page}... (${url})`);

    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
          'Referer': 'https://anichin.moe/',
        },
        timeout: 20000,
      });

      const $ = cheerio.load(response.data);
      const items = [];

      // Selektor mencakup semua varian layout tema tema anime/dooplay
      const elements = $('article.bs, .animposx, .listupd article, .film-list .film-poster, .listo .bs');
      console.log(`Elemen terdeteksi di halaman ${page}: ${elements.length}`);

      elements.each((_, el) => {
        const item = $(el);

        // Ambil Judul
        const title =
          item.find('.tt h2').text().trim() ||
          item.find('.tt').text().trim() ||
          item.find('.title h2').text().trim() ||
          item.find('h2').first().text().trim() ||
          item.find('a').attr('title') ||
          '';

        // Ambil Link
        const link = item.find('a').first().attr('href') || '';

        // Ambil Cover / Thumbnail
        const img = item.find('img').first();
        const cover =
          img.attr('data-src') ||
          img.attr('data-lazy-src') ||
          img.attr('srcset')?.split(' ')[0] ||
          img.attr('src') ||
          '';

        // Metadata tambahan
        const type = item.find('.type, .typeflag').first().text().trim() || 'Donghua';
        const status = item.find('.status, .bt .epx').first().text().trim() || 'Ongoing';
        const episode = item.find('.epx, .bt .epx').first().text().trim() || '-';

        if (title && link) {
          items.push({ title, link, cover, type, status, episode });
        }
      });

      if (items.length === 0) {
        console.log(`Tidak ada item yang berhasil diekstrak di halaman ${page}. Dump HTML title: "${$('title').text().trim()}"`);
        break;
      }

      allDonghua.push(...items);
      console.log(`Halaman ${page}: Sukses mengambil ${items.length} item.`);

      // Deteksi tombol navigasi halaman selanjutnya
      const nextBtn = $('.pagination .next, .hpage .r, a.next, .pagination a:contains("Next"), .pagination a:contains("»")');
      if (nextBtn.length > 0) {
        page++;
        await sleep(1500); // jeda 1.5 detik
      } else {
        console.log('Tidak ada tombol halaman berikutnya. Selesai.');
        hasNext = false;
      }
    } catch (err) {
      console.error(`Gagal di halaman ${page}:`, err.message);
      if (err.response) {
        console.error(`Status HTTP: ${err.response.status}`);
      }
      break;
    }
  }

  // Simpan data jika ada hasil yang didapat
  const outputDir = path.resolve('donghua');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, 'donghua.json');

  if (allDonghua.length > 0) {
    fs.writeFileSync(outputPath, JSON.stringify(allDonghua, null, 2), 'utf-8');
    console.log(`SELESAI! ${allDonghua.length} donghua berhasil disimpan ke ${outputPath}`);
  } else {
    console.log('PERINGATAN: 0 data didapat. File donghua.json tidak di-overwrite agar data lama tidak hilang.');
  }
}

run();
