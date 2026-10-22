import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

puppeteer.use(StealthPlugin());

const BASE_URL = 'https://anichin.moe';
const CONCURRENCY = 5;

// URL Cloudflare Worker aktif milikmu
const CF_WORKER_URL = 'https://dongflix-dailymotion.zahrulmo01.workers.dev/?url=';

function resolveUrl(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
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

  if (processed.includes('nunadrama.sbs') || processed.includes('player.nunadrama')) {
    const videoIdMatch = processed.match(/[?&]video=([a-zA-Z0-9]+)/);
    if (videoIdMatch && videoIdMatch[1]) {
      return `https://www.dailymotion.com/embed/video/${videoIdMatch[1]}`;
    }
  }

  return processed.startsWith('http') ? processed : '';
}

// 1. Ekstraksi D-Tube langsung ke gateway IPFS
async function extractDTubeDirect(dTubeUrl) {
  try {
    const videoId = new URL(dTubeUrl).searchParams.get('v');
    if (!videoId) return null;

    const res = await fetch(dTubeUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36' }
    });
    const html = await res.text();

    const hashMatch = html.match(/(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z0-9]{55})/);
    if (hashMatch) {
      return `https://ipfs.io/ipfs/${hashMatch[0]}`;
    }

    const mp4Match = html.match(/https?:\/\/[^"']+\.mp4/);
    if (mp4Match) {
      return mp4Match[0];
    }

    return null;
  } catch (_) {
    return null;
  }
}

// 2. Ekstraksi Dailymotion lewat API Metadata resmi
async function extractDailymotionM3u8(rawUrl) {
  try {
    let videoId = null;
    const nunadramaMatch = rawUrl.match(/[?&]video=([a-zA-Z0-9]+)/);
    const directMatch = rawUrl.match(/\/video\/([a-zA-Z0-9]+)/);

    if (nunadramaMatch) videoId = nunadramaMatch[1];
    else if (directMatch) videoId = directMatch[1];

    if (!videoId) return null;

    const res = await fetch(`https://www.dailymotion.com/player/metadata/video/${videoId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36' }
    });
    if (!res.ok) return null;

    const data = await res.json();
    return data?.qualities?.auto?.[0]?.url || null;
  } catch (_) {
    return null;
  }
}

const rawSlug = process.env.TARGET_SLUG || process.argv[2];
if (!rawSlug) {
  console.error('Target slug tidak ditemukan!');
  process.exit(1);
}

const cleanSlug = rawSlug.replace(/^\/+|\/+$/g, '');

async function createFastPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
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

async function scrapeEpisodeServers(browser, ep) {
  const page = await createFastPage(browser);
  const rawServers = [];

  try {
    await page.goto(ep.link, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const content = await page.content();
    const $$ = cheerio.load(content);

    // Ambil dari Select Dropdown
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

    // Ambil dari Tombol Mirror Tab
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

    const finalServers = [];

    // Prioritas 1: D-Tube langsung untuk dfplayer (Native MP4)
    const dtubeItem = rawServers.find((s) => s.link.includes('d.tube') || s.name.toLowerCase().includes('d-tube'));
    if (dtubeItem) {
      const directDTube = await extractDTubeDirect(dtubeItem.link);
      if (directDTube) {
        finalServers.push({
          name: 'dfplayer (D-Tube)',
          type: 'direct',
          link: directDTube
        });
      }
    }

    // Prioritas 2: Dailymotion lewat Cloudflare Worker (.m3u8 HLS)
    const dailyItem = rawServers.find((s) => s.link.includes('dailymotion.com') || s.name.toLowerCase().includes('dailymotion'));
    if (dailyItem) {
      const directM3u8 = await extractDailymotionM3u8(dailyItem.link);
      if (directM3u8) {
        finalServers.push({
          name: 'Dailymotion (Proxy)',
          type: 'hls',
          link: `${CF_WORKER_URL}${encodeURIComponent(directM3u8)}`
        });
      }
    }

    // Server fallback (Iframe standar dengan sandbox)
    for (const s of rawServers) {
      finalServers.push({
        name: s.name,
        type: 'iframe',
        link: s.link
      });
    }

    return {
      episode: ep.epNum,
      title: ep.title,
      link: ep.link,
      date: ep.date,
      servers: finalServers
    };
  } catch (err) {
    return { episode: ep.epNum, title: ep.title, link: ep.link, date: ep.date, servers: [] };
  } finally {
    await page.close();
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
  console.log(`=== Scrape Episode Turbo: ${cleanSlug} ===`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const mainPage = await createFastPage(browser);
  const possibleUrls = [
    `${BASE_URL}/${cleanSlug}/`,
    `${BASE_URL}/anime/${cleanSlug}/`
  ];

  let mainHtml = null;
  for (const url of possibleUrls) {
    try {
      await mainPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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

  const episodeQueue = [];
  $('.eplister ul li, .episodelist ul li, ul.clstyle li').each((_, el) => {
    const item = $(el);
    const fullLink = resolveUrl(item.find('a').attr('href') || '');
    const epNum = item.find('.epl-num, .epx').text().trim() || item.find('a').text().trim();
    const title = item.find('.epl-title').text().trim() || item.find('a').attr('title') || epNum;
    const date = item.find('.epl-date, .date').text().trim() || '-';

    if (fullLink && fullLink.startsWith('http')) {
      episodeQueue.push({ epNum, title, link: fullLink, date });
    }
  });

  if (!latestEpisodeFound && episodeQueue.length > 0) {
    latestEpisodeFound = episodeQueue[0].epNum || '1';
  }

  const allDetailedEpisodes = [];
  for (let i = 0; i < episodeQueue.length; i += CONCURRENCY) {
    const chunk = episodeQueue.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map((ep) => scrapeEpisodeServers(browser, ep)));
    allDetailedEpisodes.push(...results);
    console.log(`Proses episode: ${allDetailedEpisodes.length}/${episodeQueue.length}`);
  }

  await browser.close();

  const outDir = path.resolve('donghua/episodes');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, `${cleanSlug}.json`), JSON.stringify(allDetailedEpisodes, null, 2), 'utf-8');
  updateMasterDonghuaJson(cleanSlug, latestEpisodeFound);
  console.log(`Selesai! File tersimpan di donghua/episodes/${cleanSlug}.json`);
}

run();
