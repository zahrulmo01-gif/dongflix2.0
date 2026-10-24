export default async function handler(req, res) {
  // Hanya izinkan metode POST
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  // Ambil konfigurasi dari Environment Variables Vercel
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO = process.env.GITHUB_REPO; // format: username/repo

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({
      success: false,
      message: 'Environment variable GITHUB_TOKEN atau GITHUB_REPO belum disetel di Vercel.'
    });
  }

  try {
    const { event_type, payload } = req.body;

    if (!event_type) {
      return res.status(400).json({ success: false, message: 'event_type wajib disertakan.' });
    }

    // Trigger GitHub Action melalui API repository_dispatch
    const ghResponse = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Vercel-Serverless-Function'
      },
      body: JSON.stringify({
        event_type: event_type,
        client_payload: payload || {}
      })
    });

    if (ghResponse.status === 204) {
      return res.status(200).json({
        success: true,
        message: `Trigger [${event_type}] berhasil dikirim ke GitHub Actions.`
      });
    } else {
      const errorText = await ghResponse.text();
      return res.status(ghResponse.status).json({
        success: false,
        message: `GitHub API error: ${errorText}`
      });
    }
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: `Internal Server Error: ${err.message}`
    });
  }
}
