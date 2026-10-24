import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import * as cheerio from 'cheerio';

const BASE_URL = 'https://anichin.moe';

function cleanText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function parseEpisodeNumber(epString) {
  if (!epString || epString === 'null') return 0;
  const match = String(epString).match(/(\d+(\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

function gitCommitAndPush(slug, epNum) {
  try {
    console.log(`  💾 Menyimpan & commit perubahan untuk ${slug}...`);
    execSync('git config --local user.email "action@github.com"', { stdio: 'ignore' });
    execSync('git config --local user.name "GitHub Action Bot"', { stdio: 'ignore' });
    execSync(`git add donghua/donghua.json donghua/episodes/${slug}.json`, { stdio: 'ignore' });
    
    const status = execSync('git status --porcelain').toString().trim();
    if (status) {
      execSync(`git commit -m "Auto Update: ${slug} (Ep ${epNum}) [skip ci]"`, { stdio: 'inherit' });
      
      try {
        execSync('git pull --rebase origin main', { stdio: 'inherit' });
      } catch (_) {
        execSync('git pull --rebase', { stdio: 'inherit' });
      }

      execSync('git push origin main', { stdio: 'inherit' });
      console.log(`  🚀 Berhasil push ke GitHub untuk ${slug}!`);
    } else {
      console.log(`  ℹ️ Tidak ada perubahan file untuk di-push.`);
    }
  } catch (err) {
    console.warn(`  ⚠️ Gagal git push otomatis: ${err.message}`);
    try {
      execSync('git rebase --abort', { stdio: 'ignore' });
    } catch (_) {}
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

// Cek apakah ada filter slug pilihan
let targetSelectedSlugs = null;
const slugsArg = process.argv.find(arg => arg.startsWith('--slugs='));
if (slugsArg) {
  const rawList = slugsArg.split('=')[1];
  if (rawList) {
    targetSelectedSlugs = new Set(
      rawList.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    );
  }
}

async function main() {
  console.log('=== Memulai Scrape Donghua ===');

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

  // Jika ada pilihan slug dari checklist admin, filter donghuaList
  if (targetSelectedSlugs && targetSelectedSlugs.size > 0) {
    donghuaList = donghuaList.filter(d => targetSelectedSlugs.has(String(d.slug).toLowerCase()));
    console.log(`🎯 Mode Pilihan Terpilih Aktif: Memproses ${donghuaList.length} donghua terpilih.`);
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
          const numbers = epData.map(e => parseEpisodeNumber(e.episode)).filter(n => n > 0);
          localHighestEp = numbers.length > 0 ? Math.max(...numbers) : 0;
        }
      } catch (_) {}
    }

    const webLatestEpRaw = await getWebLatestEpisode(slug);
    const webHighestEp = parseEpisodeNumber(webLatestEpRaw);

    console.log(`  - Episode Lokal : ${localHighestEp > 0 ? localHighestEp : 'Belum discrape'}`);
    console.log(`  - Episode di Web: ${webHighestEp > 0 ? webHighestEp : (webLatestEpRaw || 'Tidak terdeteksi')}`);

    // Jika mode checklist terpilih, selalu jalankan scrape untuk donghua tersebut
    const isTargetSelected = targetSelectedSlugs && targetSelectedSlugs.has(String(slug).toLowerCase());

    if (isTargetSelected || webHighestEp > localHighestEp || localHighestEp === 0) {
      console.log(`  🚀 Memulai proses scrape episode untuk ${slug}...`);

      try {
        execSync(`node admin/scraper-episodes.js ${slug}`, { stdio: 'inherit' });

        let finalEpNum = webHighestEp || parseEpisodeNumber(webLatestEpRaw);
        
        if (fs.existsSync(epFilePath)) {
          try {
            const savedEps = JSON.parse(fs.readFileSync(epFilePath, 'utf-8'));
            if (Array.isArray(savedEps) && savedEps.length > 0) {
              const nums = savedEps.map(e => parseEpisodeNumber(e.episode)).filter(n => n > 0);
              if (nums.length > 0) {
                finalEpNum = Math.max(...nums);
              }
            }
          } catch (_) {}
        }

        const currentMaster = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
        const targetIndex = currentMaster.findIndex(d => d.slug === slug);

        if (targetIndex > -1) {
          const [updatedItem] = currentMaster.splice(targetIndex, 1);
          let safeEp = (finalEpNum && finalEpNum > 0) ? String(finalEpNum) : (updatedItem['latest-episode'] || '1');

          updatedItem['latest-episode'] = safeEp;
          updatedItem.episode = `Ep ${safeEp}`;
          updatedItem.updated_at = new Date().toISOString();

          currentMaster.unshift(updatedItem);
          fs.writeFileSync(masterPath, JSON.stringify(currentMaster, null, 2), 'utf-8');

          gitCommitAndPush(slug, safeEp);
        }

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
