export default async function handler(req, res) {
  // 1. Header CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 2. Matikan Cache di Browser & Edge CDN Vercel
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    const githubToken = process.env['GITHUB-TOKEN'] || process.env.GITHUB_TOKEN;

    const owner = 'zahrulmo01-gif';
    const repo = 'dongflix-data';
    const branch = 'main';

    const { slug, path: customPath } = req.query;

    let targetPath = 'data/anime/anime.json';
    if (slug) {
      targetPath = `data/anime/episode/${slug}.json`;
    } else if (customPath) {
      targetPath = customPath.startsWith('data/anime/')
        ? customPath
        : `data/anime/${customPath.replace(/^\//, '')}`;
    }

    // Menggunakan raw URL bebas batas 1 MB + anti-cache query
    const cacheBuster = Date.now();
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${targetPath}?v=${cacheBuster}`;

    const headers = {
      'User-Agent': 'Dongflix-Serverless-App',
      'Accept': 'application/json'
    };

    if (githubToken) {
      headers['Authorization'] = `token ${githubToken.trim()}`;
    }

    const response = await fetch(rawUrl, {
      headers,
      cache: 'no-store'
    });

    if (!response.ok) {
      // Fallback jika token menggunakan format Bearer
      if (response.status === 404 || response.status === 401) {
        const altHeaders = { 'User-Agent': 'Dongflix-Serverless-App' };
        if (githubToken) altHeaders['Authorization'] = `Bearer ${githubToken.trim()}`;
        const fallbackRes = await fetch(rawUrl, { headers: altHeaders, cache: 'no-store' });
        
        if (fallbackRes.ok) {
          const data = await fallbackRes.json();
          return res.status(200).json(data);
        }
      }

      const errText = await response.text();
      return res.status(response.status).json({
        error: `Gagal mengambil data: HTTP ${response.status}`,
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
