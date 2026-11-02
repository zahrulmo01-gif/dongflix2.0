export default async function handler(req, res) {
  // 1. Dukungan CORS untuk frontend web
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 2. KUNCI REALTIME: Matikan seluruh lapisan cache di browser, Vercel Edge Network, dan CDN
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');

  try {
    // Ambil token dari Environment Variables Vercel
    const githubToken = process.env['GITHUB-TOKEN'] || process.env.GITHUB_TOKEN;

    const owner = 'zahrulmo01-gif';
    const repo = 'dongflix-data';
    const branch = 'main';

    // Mendukung parameter slug (untuk detail episode) atau parameter custom path
    const { slug, path: customPath } = req.query;

    let targetPath = 'data/anime/anime.json';
    if (slug) {
      targetPath = `data/anime/episode/${slug}.json`;
    } else if (customPath) {
      targetPath = customPath.startsWith('data/anime/')
        ? customPath
        : `data/anime/${customPath.replace(/^\//, '')}`;
    }

    // Tambahkan timestamp query parameter (_t) agar API GitHub tidak mengembalikan cache internalnya
    const timestamp = Date.now();
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${targetPath}?ref=${branch}&_t=${timestamp}`;

    const headers = {
      'User-Agent': 'Dongflix-Serverless-App',
      'Accept': 'application/vnd.github.raw+json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache'
    };

    if (githubToken) {
      headers['Authorization'] = `Bearer ${githubToken.trim()}`;
    }

    // fetch dengan opsi no-store agar Node.js runtime selalu membuat request jaringan baru
    const response = await fetch(url, { 
      headers,
      cache: 'no-store'
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({
        error: `Gagal mengambil data dari GitHub: ${response.status}`,
        path: targetPath,
        details: errText
      });
    }

    const data = await response.json();

    return res.status(200).json(data);

  } catch (error) {
    console.error('Error api/anime:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: error.message
    });
  }
}
