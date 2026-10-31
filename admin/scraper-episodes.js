import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

puppeteer.use(StealthPlugin());

// Daftar domain mirror yang akan dicoba berurutan
const MIRROR_DOMAINS = [
  'https://anichin.moe',
  'https://anichin.co',
  'https://anichin.my'
];

const CONCURRENCY = 4;
const PUSH_INTERVAL = 50;
const DM_WORKER_URL = 'https://dongflix-dailymotion.zahrulmo01.workers.dev/?id=';

const REAL_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function resolveUrl(baseUrl, url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
}

function parseEpisodeNumber(epString) {
  if (!epString || epString === 'null') return 0;
  const match = String(epString).match(/(\d+(\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

function extractCleanUrl(rawVal) {
  if (!rawVal || rawVal === '0') return '';
  let processed = rawVal.trim();

  const directIframeMatch = processed.match(/src=["'](.*?)["']/i);
  if (directIframeMatch && directIframeMatch[1]) {
    processed = directIframeMatch[1];
  } else if (!processed.startsWith('http') && processed.length > 20) {
    try {
      const decoded = Buffer.from(processed, 'base64').toString('utf-8');
      const srcMatch = decoded.match(/src=["'](.*?)["']/i);
      if (srcMatch && srcMatch[1]) {
        processed = srcMatch[1];
      } else if (decoded.startsWith('http') || decoded.startsWith('//')) {
        processed = decoded;
      }
    } catch (_) {}
  }

  if (processed.startsWith('//')) {
    processed = `https:${processed}`;
  }

  return processed.startsWith('http') ? processed : '';
}

function extractDailymotionId(url) {
  const nunaMatch = url.match(/[?&]video=([a-zA-Z0-9]+)/);
  if (nunaMatch) return nunaMatch[1];

  const dmMatch = url.match(/(?:video\/|embed\/video\/|dailymotion\.com\/)([a-zA-Z0-9]+)/);
  if (dmMatch) return dmMatch[1];

  return null;
}

function parseServersFromHtml(html) {
  const $$ = cheerio.load(html);
  const rawServers = [];

  $$('select.mirror option, select[name="server"] option, .server-select option').each((_, opt) => {
    const o = $$(opt);
    let name = o.text().trim();
    const val = o.attr('value') || '';

    if (name && !name.toLowerCase().includes('pilih server')) {
      const cleanLink = extractCleanUrl(val);
      if (cleanLink && !rawServers.some((s) => s.link === cleanLink)) {
        rawServers.push({ name, link: cleanLink });
      }
    }
  });

  $$('.mirror a, .mobius a, ul.post-servers li a').each((_, a) => {
    const el = $$(a);
    let name = el.text().trim();
    const rawHref = el.attr('href') || el.attr('data-embed') || '';

    if (name && rawHref && rawHref !== '#' && !name.toLowerCase().includes('pilih server')) {
      const cleanLink = extractCleanUrl(rawHref);
      if (cleanLink && !rawServers.some((s) => s.link === cleanLink)) {
        rawServers.push({ name, link: cleanLink });
      }
    }
  });

  const defaultIframe = $$('.player-embed iframe, #pembed iframe, .responsive-embed-stream iframe').attr('src');
  if (defaultIframe) {
    const cleanIframe = extractCleanUrl(defaultIframe);
    if (cleanIframe && !rawServers.some((s) => s.link === cleanIframe)) {
      rawServers.unshift({ name: 'Default', link: cleanIframe });
    }
  }

  const okruServers = [];
  const dtubeServers = [];
  const dailyServers = [];
  const otherServers = [];

  for (const s of rawServers) {
    const l = s.link.toLowerCase();
    const n = s.name.toLowerCase();

    if (l.includes('ok.ru') || n.includes('ok.ru') || n.includes('okru')) {
      okruServers.push({ name: 'OK.ru', link: s.link });
    } else if (l.includes('d.tube') || n.includes('d.tube') || n.includes('dtube')) {
      dtubeServers.push({ name: 'D-Tube', link: s.link });
    } else if (l.includes('dailymotion.com') || l.includes('nunadrama') || n.includes('dailymotion')) {
      const dmId = extractDailymotionId(s.link);
      if (dmId && !dailyServers.some((d) => d.link.includes(dmId))) {
        dailyServers.push({
          name: 'Dailymotion',
          link: `${DM_WORKER_URL}${dmId}`
        });
      }
    } else {
      otherServers.push(s);
    }
  }

  return [...okruServers, ...dtubeServers, ...dailyServers, ...otherServers];
}

async function fetchEpisodeDirect(ep) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(ep.link, {
      signal: controller.signal,
      headers: {
        'User-Agent': REAL_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8'
      }
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const html = await res.text();

    if (html.includes('Just a moment...') || html.includes('challenge-running')) {
      return null;
    }

    const servers = parseServersFromHtml(html);
    if (servers.length === 0) return null;

    return {
      episode: ep.epNum,
      title: ep.title,
      link: ep.link,
      date: ep.date,
      servers
    };
  } catch (_) {
    clearTimeout(timeout);
    return null;
  }
}

async function launchBrowser() {
  return await puppeteer.launch({
    headless: false,
    protocolTimeout: 240000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080'
    ]
  });
}

async function createIsolatedPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent(REAL_USER_AGENT);

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  return page;
}

async function scrapeEpisodeWithPage(page, ep) {
  try {
    await page.goto(ep.link, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const content = await page.content();
    const servers = parseServersFromHtml(content);

    return {
      episode: ep.epNum,
      title: ep.title,
      link: ep.link,
      date: ep.date,
      servers
    };
  } catch (_) {
    return {
      episode: ep.epNum,
      title: ep.title,
      link: ep.link,
      date: ep.date,
      servers: []
    };
  }
}

function gitPushCheckpoint(slug, count, total) {
  try {
    console.log(`\n  💾 [Git Checkpoint] Mendorong progres ${count}/${total} episode ke GitHub...`);
    execSync('git config --local user.email "action@github.com"', { stdio: 'ignore' });
    execSync('git config --local user.name "GitHub Action Bot"', { stdio: 'ignore' });
    execSync(`git add donghua/episodes/${slug}.json donghua/donghua.json`, { stdio: 'ignore' });

    const status = execSync('git status --porcelain').toString().trim();
    if (status) {
      execSync(`git commit -m "Auto: Progres ${slug} (${count}/${total} ep) [skip ci]"`, { stdio: 'ignore' });
      try {
        execSync('git pull --rebase origin main', { stdio: 'ignore' });
      } catch (_) {
        execSync('git pull --rebase', { stdio: 'ignore' });
      }
      execSync('git push origin main', { stdio: 'inherit' });
      console.log(`  🚀 [Git Checkpoint] Berhasil push progres ${count}/${total} ke GitHub!\n`);
    }
  } catch (err) {
    console.warn(`  ⚠️ [Git Checkpoint] Gagal push checkpoint: ${err.message}`);
    try {
      execSync('git rebase --abort', { stdio: 'ignore' });
    } catch (_) {}
  }
}

function updateMasterDonghuaJson(slug, latestEpisodeValue) {
  const masterPath = path.resolve('donghua/donghua.json');
  if (!fs.existsSync(masterPath)) return;

  try {
    const rawData = fs.readFileSync(masterPath, 'utf-8');
    const donghuaList = JSON.parse(rawData);
    const targetIndex = donghuaList.findIndex((item) => item.slug === slug);

    if (targetIndex !== -1) {
      const [updatedItem] = donghuaList.splice(targetIndex, 1);
      let safeEp = parseEpisodeNumber(latestEpisodeValue);

      if (!safeEp) {
        const epFile = path.resolve(`donghua/episodes/${slug}.json`);
        if (fs.existsSync(epFile)) {
          try {
            const eps = JSON.parse(fs.readFileSync(epFile, 'utf-8'));
            if (Array.isArray(eps) && eps.length > 0) {
              const nums = eps.map((e) => parseEpisodeNumber(e.episode)).filter((n) => n > 0);
              if (nums.length > 0) safeEp = Math.max(...nums);
            }
          } catch (_) {}
        }
      }

      if (!safeEp) {
        if (updatedItem['latest-episode'] && updatedItem['latest-episode'] !== 'null') {
          safeEp = parseEpisodeNumber(updatedItem['latest-episode']);
        } else if (updatedItem.episode && updatedItem.episode !== 'null') {
          safeEp = parseEpisodeNumber(updatedItem.episode);
        }
      }

      const finalEpString = (safeEp && safeEp > 0) ? String(safeEp) : '1';

      updatedItem['latest-episode'] = finalEpString;
      updatedItem.episode = `Ep ${finalEpString}`;
      updatedItem.updated_at = new Date().toISOString();

      donghuaList.unshift(updatedItem);
      fs.writeFileSync(masterPath, JSON.stringify(donghuaList, null, 2), 'utf-8');
      console.log(`  🔝 Berhasil memindahkan ${slug} (Ep ${finalEpString}) ke urutan teratas di donghua.json!`);
    }
  } catch (err) {
    console.warn(`  ⚠️ Gagal memperbarui urutan donghua.json: ${err.message}`);
  }
}

const rawSlug = process.env.TARGET_SLUG || process.argv[2];
if (!rawSlug) {
  console.error('Target slug tidak ditemukan!');
  process.exit(1);
}

const cleanSlug = rawSlug.replace(/^\/+|\/+$/g, '');

let targetFilterEpisodes = null;
const epArg = process.argv.find(arg => arg.startsWith('--episodes='));
if (epArg) {
  const epStr = epArg.split('=')[1];
  if (epStr) {
    targetFilterEpisodes = new Set(
      epStr.split(',').map(s => parseEpisodeNumber(s.trim())).filter(n => n > 0)
    );
  }
}

// Cek apakah halaman memiliki container episode
function hasEpisodeContainer(html) {
  if (!html) return false;
  return html.includes('eplister') || 
         html.includes('episodelist') || 
         html.includes('bxcl') || 
         html.includes('clstyle') ||
         html.includes('-episode-');
}

async function run() {
  console.log(`=== Memulai High-Speed Scrape Multi-Mirror: ${cleanSlug} (Workers: ${CONCURRENCY}) ===`);
  if (targetFilterEpisodes && targetFilterEpisodes.size > 0) {
    console.log(`🎯 Mode Parsial Aktif: Memproses episode [${Array.from(targetFilterEpisodes).join(', ')}]`);
  }

  const outDir = path.resolve('donghua/episodes');
  const targetJsonPath = path.join(outDir, `${cleanSlug}.json`);
  let existingEpisodes = [];

  if (fs.existsSync(targetJsonPath)) {
    try {
      existingEpisodes = JSON.parse(fs.readFileSync(targetJsonPath, 'utf-8'));
      if (!Array.isArray(existingEpisodes)) existingEpisodes = [];
    } catch (_) {
      existingEpisodes = [];
    }
  }

  const existingEpNumbers = new Set(
    existingEpisodes.map((ep) => parseEpisodeNumber(ep.episode))
  );

  let rawEpisodeList = [];
  let latestEpisodeFound = '';
  let activeBaseUrl = MIRROR_DOMAINS[0];

  // Susun semua target URL yang akan diuji dari semua mirror
  const testUrls = [];
  for (const domain of MIRROR_DOMAINS) {
    testUrls.push({ domain, url: `${domain}/series/${cleanSlug}/` });
    testUrls.push({ domain, url: `${domain}/donghua/${cleanSlug}/` });
    testUrls.push({ domain, url: `${domain}/${cleanSlug}/` });
    testUrls.push({ domain, url: `${domain}/anime/${cleanSlug}/` });
  }

  let indexHtml = null;

  // 1. Coba Direct HTTP Fetch ke semua mirror (anichin.my / anichin.co / anichin.moe)
  console.log('  🔍 Menguji mirror HTTP langsung...');
  for (const target of testUrls) {
    try {
      const res = await fetch(target.url, {
        headers: { 
          'User-Agent': REAL_USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(9000)
      });

      if (res.ok) {
        const text = await res.text();
        if (hasEpisodeContainer(text)) {
          indexHtml = text;
          activeBaseUrl = target.domain;
          console.log(`  ⚡ Berhasil menemukan container via HTTP di: ${target.url}`);
          break;
        }
      }
    } catch (_) {}
  }

  let browser = null;

  // 2. Jika HTTP terblokir, coba via Puppeteer
  if (!indexHtml) {
    console.log('  🌐 HTTP gagal, mencoba buka via Browser Engine ke mirror...');
    browser = await launchBrowser();
    const page = await createIsolatedPage(browser);

    for (const target of testUrls) {
      try {
        console.log(`  ➡️ Mencoba rute: ${target.url}`);
        await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await new Promise(r => setTimeout(r, 2000));
        const content = await page.content();

        if (hasEpisodeContainer(content)) {
          indexHtml = content;
          activeBaseUrl = target.domain;
          console.log(`  ✅ Berhasil membuka via browser di: ${target.url}`);
          break;
        }
      } catch (_) {}
    }

    await page.close().catch(() => {});
  }

  if (!indexHtml) {
    console.error('Container list episode tidak ditemukan di semua domain mirror.');
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }

  const $ = cheerio.load(indexHtml);

  $('.lastend .inep, .episodegap, .epcur, .epcurlast, div').each((_, el) => {
    const txt = $(el).text().trim();
    if (txt.includes('Episode Baru')) {
      const match = txt.match(/Episode\s*Baru[\s\S]*?(?:Episode\s*)?(\d+[\w.-]*)/i);
      if (match && match[1]) latestEpisodeFound = match[1].trim();
    }
  });

  $('.eplister ul li, .episodelist ul li, ul.clstyle li, .bxcl ul li, ul[class*="episode"] li').each((_, el) => {
    const item = $(el);
    const linkEl = item.find('a');
    const fullLink = resolveUrl(activeBaseUrl, linkEl.attr('href') || '');
    const epNum = item.find('.epl-num, .epx, .centang').text().trim() || linkEl.text().trim();
    const epTitle = item.find('.epl-title').text().trim() || linkEl.attr('title') || epNum;
    const date = item.find('.epl-date, .date').text().trim() || '-';

    if (fullLink && fullLink.startsWith('http') && parseEpisodeNumber(epNum) > 0) {
      rawEpisodeList.push({ epNum, title: epTitle, link: fullLink, date });
    }
  });

  if (rawEpisodeList.length === 0) {
    $('a[href*="-episode-"]').each((_, a) => {
      const linkEl = $(a);
      const fullLink = resolveUrl(activeBaseUrl, linkEl.attr('href') || '');
      const rawText = linkEl.text().trim();
      const num = parseEpisodeNumber(rawText) || parseEpisodeNumber(fullLink);
      if (fullLink && num > 0 && !rawEpisodeList.some(e => parseEpisodeNumber(e.epNum) === num)) {
        rawEpisodeList.push({
          epNum: String(num),
          title: `Episode ${num}`,
          link: fullLink,
          date: '-'
        });
      }
    });
  }

  if (!latestEpisodeFound && rawEpisodeList.length > 0) {
    latestEpisodeFound = rawEpisodeList[0].epNum || '1';
  }

  const newEpisodesToScrape = rawEpisodeList.filter((ep) => {
    const num = parseEpisodeNumber(ep.epNum);
    if (targetFilterEpisodes && targetFilterEpisodes.size > 0) {
      return targetFilterEpisodes.has(num);
    }
    return !existingEpNumbers.has(num);
  });

  console.log(`Total episode di web: ${rawEpisodeList.length}`);
  console.log(`Episode sudah tersimpan: ${existingEpisodes.length}`);
  console.log(`Episode baru yang akan discrape: ${newEpisodesToScrape.length}`);

  if (newEpisodesToScrape.length === 0) {
    console.log('Semua episode sudah tersimpan lengkap. Tidak ada antrean baru.');
    updateMasterDonghuaJson(cleanSlug, latestEpisodeFound);
    if (browser) await browser.close().catch(() => {});
    return;
  }

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const newlyScrapedResults = [];
  let processedCount = 0;
  let lastPushedCount = 0;

  const saveProgress = () => {
    const combinedMap = new Map();
    existingEpisodes.forEach(ep => combinedMap.set(parseEpisodeNumber(ep.episode), ep));
    newlyScrapedResults.forEach(ep => combinedMap.set(parseEpisodeNumber(ep.episode), ep));

    const finalSorted = Array.from(combinedMap.values()).sort((a, b) => {
      return parseEpisodeNumber(b.episode) - parseEpisodeNumber(a.episode);
    });

    fs.writeFileSync(targetJsonPath, JSON.stringify(finalSorted, null, 2), 'utf-8');
  };

  let queueIndex = 0;

  async function worker(workerId) {
    let workerPage = null;

    while (queueIndex < newEpisodesToScrape.length) {
      const idx = queueIndex++;
      const ep = newEpisodesToScrape[idx];

      let result = await fetchEpisodeDirect(ep);

      if (!result || !result.servers || result.servers.length === 0) {
        if (!browser) {
          browser = await launchBrowser();
        }
        if (!workerPage) {
          workerPage = await createIsolatedPage(browser);
        }
        result = await scrapeEpisodeWithPage(workerPage, ep);
      }

      newlyScrapedResults.push(result);
      processedCount++;
      console.log(`[W-${workerId}] Episode diproses: ${processedCount}/${newEpisodesToScrape.length} (Ep ${ep.epNum})`);

      saveProgress();

      if (processedCount - lastPushedCount >= PUSH_INTERVAL) {
        updateMasterDonghuaJson(cleanSlug, latestEpisodeFound);
        gitPushCheckpoint(cleanSlug, processedCount, newEpisodesToScrape.length);
        lastPushedCount = processedCount;
      }
    }

    if (workerPage) {
      await workerPage.close().catch(() => {});
    }
  }

  const workers = [];
  const activeWorkersCount = Math.min(CONCURRENCY, newEpisodesToScrape.length);
  for (let i = 0; i < activeWorkersCount; i++) {
    workers.push(worker(i + 1));
  }

  await Promise.all(workers);

  if (browser) await browser.close().catch(() => {});

  updateMasterDonghuaJson(cleanSlug, latestEpisodeFound);
  if (processedCount > lastPushedCount) {
    gitPushCheckpoint(cleanSlug, processedCount, newEpisodesToScrape.length);
  }

  console.log(`\nSelesai! Berhasil memproses ${processedCount} episode untuk ${cleanSlug}.json`);
}

run();
