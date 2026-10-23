import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

puppeteer.use(StealthPlugin());

const BASE_URL = 'https://anichin.moe';
const CONCURRENCY = 3;
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

const rawSlug = process.env.TARGET_SLUG || process.argv[2];
if (!rawSlug) {
  console.error('Target slug tidak ditemukan!');
  process.exit(1);
}

const cleanSlug = rawSlug.replace(/^\/+|\/+$/g, '');

async function createFreshPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(getRandomUserAgent());
  await page.setDefaultNavigationTimeout(35000);
  await page.setDefaultTimeout(35000);

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

async function scrapeSingleEpisode(page, ep) {
  const rawServers = [];

  try {
    await page.goto(ep.link, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const content = await page.content();
    const $$ = cheerio.load(content);

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

    return {
      episode: ep.epNum,
      title: ep.title,
      link: ep.link,
      date: ep.date,
      servers: [...okruServers, ...dtubeServers, ...dailyServers, ...otherServers]
    };
  } catch (err) {
    return {
      episode: ep.epNum,
      title: ep.title,
      link: ep.link,
      date: ep.date,
      servers: []
    };
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

async function run() {
  console.log(`=== Memulai Scrape Episode: ${cleanSlug} ===`);

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

  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 300000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-component-update',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--js-flags="--max-old-space-size=512"'
    ]
  });

  const mainPage = await createFreshPage(browser);

  const possibleUrls = [
    `${BASE_URL}/${cleanSlug}/`,
    `${BASE_URL}/anime/${cleanSlug}/`
  ];

  let mainHtml = null;
  for (const url of possibleUrls) {
    try {
      await mainPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      const html = await mainPage.content();
      const $ = cheerio.load(html);
      if ($('.eplister, .episodelist, .bxcl ul, ul.clstyle').length > 0) {
        mainHtml = html;
        break;
      }
    } catch (_) {}
  }

  await mainPage.close();

  if (!mainHtml) {
    console.error('Container list episode tidak ditemukan.');
    await browser.close();
    process.exit(1);
  }

  const $ = cheerio.load(mainHtml);
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
    await browser.close();
    return;
  }

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const newlyScrapedResults = new Array(newEpisodesToScrape.length);
  let currentIndex = 0;

  const saveProgress = () => {
    const finished = newlyScrapedResults.filter(Boolean);
    const combined = [...finished, ...existingEpisodes];
    fs.writeFileSync(targetJsonPath, JSON.stringify(combined, null, 2), 'utf-8');
  };

  async function worker(workerId) {
    let page = await createFreshPage(browser);
    let requestsOnThisTab = 0;

    while (currentIndex < newEpisodesToScrape.length) {
      const idx = currentIndex++;
      const ep = newEpisodesToScrape[idx];

      if (requestsOnThisTab >= 15) {
        try {
          await page.close();
        } catch (_) {}
        page = await createFreshPage(browser);
        requestsOnThisTab = 0;
      }

      try {
        const res = await scrapeSingleEpisode(page, ep);
        newlyScrapedResults[idx] = res;
        requestsOnThisTab++;
        console.log(`Episode diproses: ${idx + 1}/${newEpisodesToScrape.length} (Ep ${ep.epNum})`);

        if ((idx + 1) % 10 === 0) {
          saveProgress();
        }
      } catch (err) {
        console.warn(`[Worker ${workerId}] Retry atau lewati Ep ${ep.epNum}`);
      }
    }

    try {
      await page.close();
    } catch (_) {}
  }

  const workerPromises = [];
  const actualConcurrency = Math.min(CONCURRENCY, newEpisodesToScrape.length);
  for (let i = 0; i < actualConcurrency; i++) {
    workerPromises.push(worker(i + 1));
  }

  await Promise.all(workerPromises);
  await browser.close().catch(() => {});

  saveProgress();
  updateMasterDonghuaJson(cleanSlug, latestEpisodeFound);
  console.log(`Selesai! Berhasil memproses antrean episode untuk ${cleanSlug}.json`);
}

run();
