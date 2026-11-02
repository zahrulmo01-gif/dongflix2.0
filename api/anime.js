export default async function handler(req, res) {
  // Dukungan CORS untuk frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Ambil token dari Environment Variables Vercel di project dongflix2.0
    const githubToken = process.env['GITHUB-TOKEN'] || process.env.GITHUB_TOKEN;

    const owner = 'zahrulmo01-gif';
    const repo = 'dongflix-data';
    const branch = 'main';

    // Mendukung parameter slug untuk mengambil data episode spesifik
    const { slug, path: customPath } = req.query;

    let targetPath = 'data/anime/anime.json';
    if (slug) {
      targetPath = `data/anime/episode/${slug}.json`;
    } else if (customPath) {
      targetPath = customPath.startsWith('data/anime/')
        ? customPath
        : `data/anime/${customPath.replace(/^\//, '')}`;
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${targetPath}?ref=${branch}`;

    const headers = {
      'User-Agent': 'Dongflix-Serverless-App',
      'Accept': 'application/vnd.github.raw+json', // Langsung ambil konten mentah JSON
    };

    if (githubToken) {
      headers['Authorization'] = `Bearer ${githubToken.trim()}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({
        error: `Gagal mengambil data dari GitHub: ${response.status}`,
        path: targetPath,
        details: errText
      });
    }

    const data = await response.json();

    // Cache di edge Vercel selama 15 menit agar respons cepat dan hemat kuota request GitHub API
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
    return res.status(200).json(data);

  } catch (error) {
    console.error('Error api/anime:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: error.message
    });
  }
}
