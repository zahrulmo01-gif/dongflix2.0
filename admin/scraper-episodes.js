import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

puppeteer.use(StealthPlugin());

const BASE_URL = 'https://anichin.moe';
const CONCURRENCY = 5;

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

  return processed.startsWith('http') ? processed : '';
}

async function extractOkRuDirectVideo(okRuEmbedUrl) {
  try {
    const res = await fetch(okRuEmbedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });
    const html = await res.text();

    const match = html.match(/data-options="([^"]+)"/);
    if (!match) return null;

    const rawJson = match[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'");

    const parsed = JSON.parse(rawJson);
    const flashVars = parsed.flashvars || {};

    let metadata = flashVars.metadata || {};
    if (typeof metadata === 'string') {
      try {
        metadata = JSON.parse(metadata);
      } catch (_) {
        metadata = {};
      }
    }

    const videos = metadata.videos || [];
    if (videos.length === 0) return null;

    const labelMap = {
      ultra: '1080p',
      hd: '720p',
      sd: '480p',
      low: '360p',
      lowest: '240p'
    };

    const priority = ['ultra', 'hd', 'sd', 'low', 'lowest'];
    videos.sort((a, b) => {
      const idxA = priority.indexOf(a.name);
      const idxB = priority.indexOf(b.name);
      return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
    });

    const qualities = videos.map((v) => ({
      resolution: labelMap[v.name] || v.name,
      url: v.url
    }));

    return qualities;
  } catch (err) {
    console.error('Gagal ekstrak resolusi OK.ru:', err.message);
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
  const servers = [];

  try {
    await page.goto(ep.link, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const content = await page.content();
    const $$ = cheerio.load(content);

    // 1. Dropdown Mirror Option
    $$('select.mirror option, select[name="server"] option, .server-select option').each((_, opt) => {
      const o = $$(opt);
      const name = o.text().trim();
      const val = o.attr('value') || '';

      if (name && !name.toLowerCase().includes('pilih server')) {
        const cleanLink = extractCleanUrl(val);
        if (cleanLink && !servers.some((s) => s.link === cleanLink)) {
          servers.push({ name, link: cleanLink, type: 'iframe' });
        }
      }
    });

    // 2. Tab Link/Button Mirror
    $$('.mirror a, .mobius a, ul.post-servers li a').each((_, a) => {
      const el = $$(a);
      const name = el.text().trim();
      const rawHref = el.attr('href') || el.attr('data-embed') || '';
      if (name && rawHref && rawHref !== '#' && !name.toLowerCase().includes('pilih server')) {
        const cleanLink = extractCleanUrl(rawHref);
        if (cleanLink && !servers.some((s) => s.link === cleanLink)) {
          servers.push({ name, link: cleanLink, type: 'iframe' });
        }
      }
    });

    // 3. Iframe Aktif Bawaan
    const defaultIframe = $$('.player-embed iframe, #pembed iframe, .responsive-embed-stream iframe').attr('src');
    if (defaultIframe) {
      const cleanIframe = extractCleanUrl(defaultIframe);
      if (cleanIframe && !servers.some((s) => s.link === cleanIframe)) {
        servers.unshift({ name: 'Default Server', link: cleanIframe, type: 'iframe' });
      }
    }

    // 4. Bangun dfplayer jika ditemukan server OK.ru
    const okRuServer = servers.find((s) => s.name.toLowerCase().includes('ok') || s.link.includes('ok.ru'));
    if (okRuServer && okRuServer.link) {
      const qualities = await extractOkRuDirectVideo(okRuServer.link);
      if (qualities && qualities.length > 0) {
        servers.unshift({
          name: 'dfplayer',
          type: 'direct',
          link: qualities[0].url,
          qualities: qualities
        });
      }
    }

    return {
      episode: ep.epNum,
      title: ep.title,
      link: ep.link,
      date: ep.date,
      servers: servers
    };
  } catch (err) {
    console.error(`Gagal scrape ep ${ep.epNum}:`, err.message);
    return {
      episode: ep.epNum,
      title: ep.title,
      link: ep.link,
      date: ep.date,
      servers: []
    };
  } finally {
    await page.close();
  }
}

function updateMasterDonghuaJson(slug, latestEpisodeValue) {
  const masterPath = path.resolve('donghua/donghua.json');
  if (!fs.existsSync(masterPath)) {
    console.error('File donghua/donghua.json tidak ditemukan.');
    return;
  }

  try {
    const rawData = fs.readFileSync(masterPath, 'utf-8');
    const donghuaList = JSON.parse(rawData);

    let updated = false;
    for (const item of donghuaList) {
      if (item.slug === slug) {
        item['latest-episode'] = String(latestEpisodeValue);
        item.episode = `Ep ${latestEpisodeValue}`;
        updated = true;
        break;
      }
    }

    if (updated) {
      fs.writeFileSync(masterPath, JSON.stringify(donghuaList, null, 2), 'utf-8');
      console.log(`Berhasil update "latest-episode": "${latestEpisodeValue}" untuk slug [${slug}] di donghua.json`);
    } else {
      console.log(`Slug [${slug}] tidak ditemukan dalam donghua.json`);
    }
  } catch (err) {
    console.error('Gagal update donghua.json:', err.message);
  }
}

async function run() {
  console.log(`=== Scrape Episode Turbo: ${cleanSlug} ===`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process'
    ]
  });

  const mainPage = await createFastPage(browser);
  const possibleUrls = [
    `${BASE_URL}/${cleanSlug}/`,
    `${BASE_URL}/anime/${cleanSlug}/`
  ];

  let mainHtml = null;

  for (const url of possibleUrls) {
    try {
      console.log(`Mencoba akses: ${url}`);
      await mainPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const html = await mainPage.content();
      const $ = cheerio.load(html);

      if ($('.eplister, .episodelist, .bxcl ul, ul.clstyle').length > 0) {
        mainHtml = html;
        console.log(`Daftar episode ditemukan di: ${url}`);
        break;
      }
    } catch (e) {
      console.log(`Gagal akses ${url}: ${e.message}`);
    }
  }

  await mainPage.close();

  if (!mainHtml) {
    console.error('Container list episode tidak ditemukan.');
    await browser.close();
    process.exit(1);
  }

  const $ = cheerio.load(mainHtml);

  // Ambil teks dari badge 'Episode Baru'
  let latestEpisodeFound = '';
  $('.lastend .inep, .episodegap, .epcur, .epcurlast, div').each((_, el) => {
    const txt = $(el).text().trim();
    if (txt.includes('Episode Baru')) {
      const match = txt.match(/Episode\s*Baru[\s\S]*?(?:Episode\s*)?(\d+[\w.-]*)/i);
      if (match && match[1]) {
        latestEpisodeFound = match[1].trim();
      }
    }
  });

  if (!latestEpisodeFound) {
    $('h4, span, div').each((_, el) => {
      const txt = $(el).text().trim();
      if (/^Episode Baru$/i.test(txt)) {
        const nextText = $(el).next().text().trim() || $(el).parent().text().trim();
        const numMatch = nextText.match(/(\d+[\w.-]*)/);
        if (numMatch && numMatch[1]) latestEpisodeFound = numMatch[1];
      }
    });
  }

  const episodeQueue = [];
  $('.eplister ul li, .episodelist ul li, ul.clstyle li').each((_, el) => {
    const item = $(el);
    const rawLink = item.find('a').attr('href') || '';
    const fullLink = resolveUrl(rawLink);

    const epNum =
      item.find('.epl-num').text().trim() ||
      item.find('.epx').text().trim() ||
      item.find('a').text().trim();
    const title =
      item.find('.epl-title').text().trim() ||
      item.find('a').attr('title') ||
      item.find('a').text().trim();
    const date = item.find('.epl-date, .date').text().trim() || '-';

    if (fullLink && fullLink.startsWith('http')) {
      episodeQueue.push({ epNum, title, link: fullLink, date });
    }
  });

  if (!latestEpisodeFound && episodeQueue.length > 0) {
    latestEpisodeFound = episodeQueue[0].epNum || '1';
  }

  console.log(`Episode Baru terdeteksi: "${latestEpisodeFound}"`);
  console.log(`Total episode yang akan di-scrape: ${episodeQueue.length}`);

  if (episodeQueue.length === 0) {
    await browser.close();
    return;
  }

  // Scrape secara paralel
  const allDetailedEpisodes = [];
  for (let i = 0; i < episodeQueue.length; i += CONCURRENCY) {
    const chunk = episodeQueue.slice(i, i + CONCURRENCY);
    const chunkPromises = chunk.map((ep) => scrapeEpisodeServers(browser, ep));
    const results = await Promise.all(chunkPromises);
    allDetailedEpisodes.push(...results);
    console.log(`Proses episode: ${allDetailedEpisodes.length}/${episodeQueue.length}`);
  }

  await browser.close();

  // Simpan hasil ke JSON episode
  const outDir = path.resolve('donghua/episodes');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outFile = path.join(outDir, `${cleanSlug}.json`);
  fs.writeFileSync(outFile, JSON.stringify(allDetailedEpisodes, null, 2), 'utf-8');
  console.log(`SUKSES! File tersimpan di: ${outFile}`);

  // Simpan update latest-episode ke donghua.json
  updateMasterDonghuaJson(cleanSlug, latestEpisodeFound);
}

run();
