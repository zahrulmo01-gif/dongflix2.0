import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

puppeteer.use(StealthPlugin());

const BASE_URL = 'https://anichin.moe';
const CONCURRENCY = 4; // 4 worker paralel stabil untuk HTTP + browser fallback
const PUSH_INTERVAL = 50;
const DM_WORKER_URL = 'https://dongflix-dailymotion.zahrulmo01.workers.dev/?id=';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function resolveUrl(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

function parseEpisodeNumber(epString) {
  if (!epString) return 0;
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

  // Dropdown select server
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

  // Mirror tabs
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

  // Default iframe
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

// 1. Eksekusi cepat lewat fetch HTTP
async function fetchEpisodeDirect(ep) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    const res = await fetch(ep.link, {
      signal: controller.signal,
      headers: {
        'User-Agent': getRandomUserAgent(),
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

// 2. Setup tab page yang aman dari race condition
async function createIsolatedPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(getRandomUserAgent());
  await page.setRequestInterception(true);

  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return;

    const type = req.resourceType();
    if (['image', 'stylesheet', 'font', 'media', 'other'].includes(type)) {
      req.abort().catch(() => {});
    } else {
      req.continue().catch(() => {});
    }
  });

  return page;
}

async function scrapeEpisodeWithPage(page, ep) {
  try {
    await page.goto(ep.link, { waitUntil: 'domcontentloaded', timeout: 25000 });
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

    const status = execSync('git status --porcelain').toString();
    if (status) {
      execSync(`git commit -m "Auto: Progres ${slug} (${count}/${total} ep) [skip ci]"`, { stdio: 'ignore' });
      execSync('git push', { stdio: 'ignore' });
      console.log(`  🚀 [Git Checkpoint] Berhasil push progres ${count}/${total} ke GitHub!\n`);
    }
  } catch (err) {
    console.warn(`  ⚠️ [Git Checkpoint] Gagal push checkpoint: ${err.message}`);
  }
}

function updateMasterDonghuaJson(slug, latestEpisodeValue) {
  const masterPath = path.resolve('donghua/donghua.json');
  if (!fs.existsSync(masterPath)) return;

  try {
    const rawData = fs.readFileSync(masterPath, 'utf-8');
    const donghuaList = JSON.parse(rawData);

    for (const item of donghuaList) {
      if (item.slug === slug) {
        item['latest-episode'] = String(latestEpisodeValue);
        item.episode = `Ep ${latestEpisodeValue}`;
        break;
      }
    }
    fs.writeFileSync(masterPath, JSON.stringify(donghuaList, null, 2), 'utf-8');
  } catch (_) {}
}

const rawSlug = process.env.TARGET_SLUG || process.argv[2];
if (!rawSlug) {
  console.error('Target slug tidak ditemukan!');
  process.exit(1);
}

const cleanSlug = rawSlug.replace(/^\/+|\/+$/g, '');

async function run() {
  console.log(`=== Memulai High-Speed Scrape: ${cleanSlug} (Workers: ${CONCURRENCY}) ===`);

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

  let indexHtml = null;
  const indexTargets = [
    `${BASE_URL}/${cleanSlug}/`,
    `${BASE_URL}/anime/${cleanSlug}/`,
    `${BASE_URL}/donghua/${cleanSlug}/`
  ];

  for (const url of indexTargets) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': getRandomUserAgent() },
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) {
        const text = await res.text();
        if (text.includes('eplister') || text.includes('episodelist')) {
          indexHtml = text;
          break;
        }
      }
    } catch (_) {}
  }

  let browser = null;
  const launchBrowser = async () => {
    if (!browser) {
      browser = await puppeteer.launch({
        headless: 'new',
        protocolTimeout: 180000,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--blink-settings=imagesEnabled=false'
        ]
      });
    }
    return browser;
  };

  if (!indexHtml) {
    const b = await launchBrowser();
    const page = await createIsolatedPage(b);
    for (const url of indexTargets) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const html = await page.content();
        if (html.includes('eplister') || html.includes('episodelist')) {
          indexHtml = html;
          break;
        }
      } catch (_) {}
    }
    await page.close().catch(() => {});
  }

  if (!indexHtml) {
    console.error('Container list episode tidak ditemukan.');
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }

  const $ = cheerio.load(indexHtml);
  let latestEpisodeFound = '';
  $('.lastend .inep, .episodegap, .epcur, .epcurlast, div').each((_, el) => {
    const txt = $(el).text().trim();
    if (txt.includes('Episode Baru')) {
      const match = txt.match(/Episode\s*Baru[\s\S]*?(?:Episode\s*)?(\d+[\w.-]*)/i);
      if (match && match[1]) latestEpisodeFound = match[1].trim();
    }
  });

  const rawEpisodeList = [];
  $('.eplister ul li, .episodelist ul li, ul.clstyle li').each((_, el) => {
    const item = $(el);
    const fullLink = resolveUrl(item.find('a').attr('href') || '');
    const epNum = item.find('.epl-num, .epx').text().trim() || item.find('a').text().trim();
    const title = item.find('.epl-title').text().trim() || item.find('a').attr('title') || epNum;
    const date = item.find('.epl-date, .date').text().trim() || '-';

    if (fullLink && fullLink.startsWith('http')) {
      rawEpisodeList.push({ epNum, title, link: fullLink, date });
    }
  });

  if (!latestEpisodeFound && rawEpisodeList.length > 0) {
    latestEpisodeFound = rawEpisodeList[0].epNum || '1';
  }

  const newEpisodesToScrape = rawEpisodeList.filter((ep) => {
    const num = parseEpisodeNumber(ep.epNum);
    return !existingEpNumbers.has(num);
  });

  console.log(`Total episode di web: ${rawEpisodeList.length}`);
  console.log(`Episode sudah tersimpan: ${existingEpisodes.length}`);
  console.log(`Episode baru yang akan discrape: ${newEpisodesToScrape.length}`);

  if (newEpisodesToScrape.length === 0) {
    console.log('Semua episode sudah tersimpan lengkap. Tidak ada antrean baru.');
    if (browser) await browser.close().catch(() => {});
    return;
  }

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const newlyScrapedResults = [];
  let processedCount = 0;
  let lastPushedCount = 0;

  const saveProgress = () => {
    const combined = [...newlyScrapedResults, ...existingEpisodes];
    fs.writeFileSync(targetJsonPath, JSON.stringify(combined, null, 2), 'utf-8');
  };

  let queueIndex = 0;

  async function worker(workerId) {
    let workerPage = null;

    while (queueIndex < newEpisodesToScrape.length) {
      const idx = queueIndex++;
      const ep = newEpisodesToScrape[idx];

      // Coba lewat HTTP cepat dulu
      let result = await fetchEpisodeDirect(ep);

      // Fallback: gunakan dedicated page milik worker ini sendiri jika butuh Puppeteer
      if (!result || !result.servers || result.servers.length === 0) {
        if (!workerPage) {
          const b = await launchBrowser();
          workerPage = await createIsolatedPage(b);
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

  console.log(`\nSelesai! Berhasil memproses ${processedCount} episode baru untuk ${cleanSlug}.json`);
}

run();
