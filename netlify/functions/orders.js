// GET returns the latest form submissions (orders, custom orders, contact messages) from Netlify.
const { json, checkAuth, missingEnv } = require('../lib/common');

exports.handler = async (event) => {
  const bad = checkAuth(event); if (bad) return json(401, { error: bad });
  const siteId = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  if (!siteId) return json(500, { error: 'Missing settings in Netlify: NETLIFY_SITE_ID' });
  const envBad = missingEnv(['NETLIFY_TOKEN']); if (envBad) return json(500, { error: envBad });
  const page = Math.max(1, parseInt((event.queryStringParameters || {}).page, 10) || 1);
  try {
    const r = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/submissions?per_page=40&page=${page}`, {
      headers: { Authorization: 'Bearer ' + process.env.NETLIFY_TOKEN },
    });
    if (!r.ok) return json(500, { error: `Netlify refused the request (${r.status}). Check NETLIFY_TOKEN.` });
    const rows = await r.json();
    const out = rows.map((s) => ({
      id: s.id, form: s.form_name, created: s.created_at, name: s.name, email: s.email,
      data: s.data || {}, files: s.files || [],
    }));
    return json(200, { submissions: out, page });
  } catch (e) { return json(500, { error: e.message }); }
};
