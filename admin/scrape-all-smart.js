import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import * as cheerio from 'cheerio';

const BASE_URL = 'https://anichin.moe';

function cleanText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function parseEpisodeNumber(epString) {
  if (!epString) return 0;
  const match = String(epString).match(/(\d+(\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

function gitCommitAndPush(slug, epNum) {
  try {
    console.log(`  💾 Menyimpan & commit perubahan untuk ${slug}...`);
    execSync('git config --local user.email "action@github.com"', { stdio: 'ignore' });
    execSync('git config --local user.name "GitHub Action Bot"', { stdio: 'ignore' });
    execSync(`git add donghua/donghua.json donghua/episodes/${slug}.json`, { stdio: 'ignore' });
    
    const status = execSync('git status --porcelain').toString();
    if (status) {
      execSync(`git commit -m "Auto Update: ${slug} (Ep ${epNum}) [skip ci]"`, { stdio: 'inherit' });
      execSync('git push', { stdio: 'inherit' });
      console.log(`  🚀 Berhasil push ke GitHub untuk ${slug}!`);
    } else {
      console.log(`  ℹ️ Tidak ada perubahan file untuk di-push.`);
    }
  } catch (err) {
    console.warn(`  ⚠️ Gagal git push otomatis: ${err.message}`);
  }
}

async function fetchHtmlWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.text();
  } catch (_) {
    clearTimeout(timeout);
    return null;
  }
}

async function getWebLatestEpisode(slug) {
  const urls = [
    `${BASE_URL}/${slug}/`,
    `${BASE_URL}/anime/${slug}/`
  ];

  for (const url of urls) {
    const html = await fetchHtmlWithTimeout(url);
    if (!html) continue;

    const $ = cheerio.load(html);
    let epFound = '';

    $('.lastend .inep, .episodegap, .epcur, .epcurlast, div').each((_, el) => {
      const txt = $(el).text().trim();
      if (txt.includes('Episode Baru')) {
        const match = txt.match(/Episode\s*Baru[\s\S]*?(?:Episode\s*)?(\d+[\w.-]*)/i);
        if (match && match[1]) epFound = match[1].trim();
      }
    });

    if (!epFound) {
      const firstEpItem = $('.eplister ul li, .episodelist ul li, ul.clstyle li').first();
      const num = firstEpItem.find('.epl-num, .epx').text().trim() || firstEpItem.find('a').text().trim();
      if (num) epFound = num;
    }

    if (epFound) return epFound;
  }

  return null;
}

async function main() {
  console.log('=== Memulai Smart Scrape Semua Donghua ===');

  const masterPath = path.resolve('donghua/donghua.json');
  if (!fs.existsSync(masterPath)) {
    console.error('File donghua/donghua.json tidak ditemukan!');
    process.exit(1);
  }

  let donghuaList = [];
  try {
    donghuaList = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
  } catch (e) {
    console.error('Format donghua.json rusak:', e.message);
    process.exit(1);
  }

  const episodesDir = path.resolve('donghua/episodes');
  if (!fs.existsSync(episodesDir)) fs.mkdirSync(episodesDir, { recursive: true });

  const total = donghuaList.length;
  console.log(`Total judul yang akan diperiksa: ${total}`);

  for (let i = 0; i < total; i++) {
    const item = donghuaList[i];
    const slug = item.slug;
    console.log(`\n[${i + 1}/${total}] Memeriksa: ${item.title} (${slug})`);

    const epFilePath = path.join(episodesDir, `${slug}.json`);
    let localHighestEp = 0;

    if (fs.existsSync(epFilePath)) {
      try {
        const epData = JSON.parse(fs.readFileSync(epFilePath, 'utf-8'));
        if (Array.isArray(epData) && epData.length > 0) {
          const numbers = epData.map(e => parseEpisodeNumber(e.episode));
          localHighestEp = Math.max(...numbers, 0);
        }
      } catch (_) {}
    }

    const webLatestEpRaw = await getWebLatestEpisode(slug);
    const webHighestEp = parseEpisodeNumber(webLatestEpRaw);

    console.log(`  - Episode Lokal : ${localHighestEp > 0 ? localHighestEp : 'Belum discrape'}`);
    console.log(`  - Episode di Web: ${webHighestEp > 0 ? webHighestEp : (webLatestEpRaw || 'Tidak ditemukan')}`);

    if (webHighestEp > localHighestEp || localHighestEp === 0) {
      console.log(`  🚀 RILISAN BARU DITEMUKAN! Memulai delta scrape...`);

      try {
        execSync(`node admin/scraper-episodes.js ${slug}`, { stdio: 'inherit' });

        const currentMaster = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
        const targetIndex = currentMaster.findIndex(d => d.slug === slug);
        if (targetIndex > -1) {
          const [updatedItem] = currentMaster.splice(targetIndex, 1);
          updatedItem['latest-episode'] = String(webHighestEp || webLatestEpRaw);
          updatedItem.episode = `Ep ${webHighestEp || webLatestEpRaw}`;
          updatedItem.updated_at = new Date().toISOString();
          currentMaster.unshift(updatedItem);
          fs.writeFileSync(masterPath, JSON.stringify(currentMaster, null, 2), 'utf-8');
        }

        gitCommitAndPush(slug, webHighestEp || webLatestEpRaw);

      } catch (err) {
        console.error(`  ❌ Gagal memproses ${slug}: ${err.message}`);
        console.log(`  ➡️ Melanjutkan ke donghua berikutnya...`);
      }
    } else {
      console.log(`  ✅ Sudah up-to-date. Lewati.`);
    }
  }

  console.log('\n=== Semua donghua selesai diperiksa! ===');
}

main();
