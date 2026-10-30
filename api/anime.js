export default async function handler(req, res) {
  // Dukungan CORS jika diakses dari domain frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Ambil token dari env Vercel
    const githubToken = process.env['GITHUB-TOKEN'] || process.env.GITHUB_TOKEN;

    const owner = 'zahrulmo01-gif';
    const repo = 'dongflix-data';
    const filePath = 'data/anime/anime.json';
    const branch = 'main';

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;

    const headers = {
      'User-Agent': 'Dongflix-Serverless-App',
      'Accept': 'application/vnd.github.raw+json', // Mengambil langsung raw content JSON
    };

    if (githubToken) {
      headers['Authorization'] = `Bearer ${githubToken.trim()}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({
        error: `Gagal mengambil data dari GitHub: ${response.status}`,
        details: errText
      });
    }

    const animeData = await response.json();

    // Cache di edge Vercel selama 15 menit agar loading instan dan hemat rate-limit API
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
    return res.status(200).json(animeData);

  } catch (error) {
    console.error('Error api/anime:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
}
