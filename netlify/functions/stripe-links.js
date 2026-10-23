// POST {action:'status'} lists designs and whether they have a Stripe payment link.
// POST {action:'create', recreate:['slug']} creates missing links (and re-creates the listed ones),
// then saves data/payment-links.json to GitHub, which makes Netlify redeploy the site.
const { json, checkAuth, missingEnv, slugify, ghGetFile, ghPutFile, stripe } = require('../lib/common');

const SITE = process.env.SITE_URL || 'https://specra.store';
const SIZES = ['S', 'M', 'L', 'XL', '2XL'];
const EU = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];

function priceFor(settings, type, sides) {
  const p = (settings.prices || {})[type];
  if (!p) return null;
  return +(sides >= 2 ? p.two : p.one);
}

async function shippingRates(settings) {
  const d = settings.delivery || {};
  const wanted = [
    ['Estonia - free delivery (launch offer)', +d.estonia || 0],
    ['Latvia and Lithuania', +d.latvia_lithuania || 0],
    ['Rest of the EU', +d.other || 0],
  ];
  const existing = await stripe('GET', 'shipping_rates', { active: true, limit: 100 });
  const out = [];
  for (const [name, eur] of wanted) {
    const cents = Math.round(eur * 100);
    const hit = (existing.data || []).find((r) => r.display_name === name && r.fixed_amount && r.fixed_amount.amount === cents);
    if (hit) { out.push({ shipping_rate: hit.id }); continue; }
    const r = await stripe('POST', 'shipping_rates', {
      display_name: name, type: 'fixed_amount', tax_behavior: 'inclusive',
      fixed_amount: { amount: cents, currency: 'eur' },
    });
    out.push({ shipping_rate: r.id });
  }
  return out;
}

async function makeLink(design, eur, rates) {
  const slug = slugify(design.name);
  const prodArgs = { name: design.name, description: design.description || undefined };
  if (design.image) prodArgs.images = [SITE + design.image];
  let prod;
  try { prod = await stripe('POST', 'products', prodArgs); }
  catch (e) { delete prodArgs.images; prod = await stripe('POST', 'products', prodArgs); }
  const price = await stripe('POST', 'prices', { product: prod.id, unit_amount: Math.round(eur * 100), currency: 'eur', tax_behavior: 'inclusive' });
  const args = {
    line_items: [{ price: price.id, quantity: 1, adjustable_quantity: { enabled: true, minimum: 1, maximum: 50 } }],
    shipping_address_collection: { allowed_countries: EU },
    shipping_options: rates,
    allow_promotion_codes: true,
    after_completion: { type: 'redirect', redirect: { url: SITE + '/thanks.html' } },
    metadata: { specra_key: slug },
    consent_collection: { terms_of_service: 'required' },
  };
  if (design.type !== 'tote') {
    args.custom_fields = [{ key: 'size', label: { type: 'custom', custom: 'Size' }, type: 'dropdown',
      dropdown: { options: SIZES.map((s) => ({ label: s, value: s.toLowerCase() })) } }];
  }
  let link;
  try { link = await stripe('POST', 'payment_links', args); }
  catch (e) {
    if (/terms/i.test(e.message)) { delete args.consent_collection; link = await stripe('POST', 'payment_links', args); }
    else throw e;
  }
  return link.url;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Use POST.' });
  const bad = checkAuth(event); if (bad) return json(401, { error: bad });
  const envBad = missingEnv(['GITHUB_TOKEN', 'GITHUB_REPO']); if (envBad) return json(500, { error: envBad });
  let body = {}; try { body = JSON.parse(event.body || '{}'); } catch (e) {}

  try {
    const prods = await ghGetFile('data/products.json');
    const settings = (await ghGetFile('data/settings.json')).data;
    const links = await ghGetFile('data/payment-links.json');
    const have = {}; (links.data.designs || []).forEach((d) => { if (d && d.slug) have[d.slug] = d.url; });
    const list = (prods.data.products || []).map((p) => {
      const slug = slugify(p.name), eur = priceFor(settings, p.type, +p.sides || 1);
      return { slug, name: p.name, type: p.type, sides: +p.sides || 1, price: eur, url: have[slug] || '' };
    });
    if (body.action === 'status') return json(200, { designs: list });

    if (body.action === 'create') {
      const sBad = missingEnv(['STRIPE_KEY']); if (sBad) return json(500, { error: sBad });
      const recreate = new Set(body.recreate || []);
      const todo = prods.data.products.filter((p) => { const s = slugify(p.name); return !have[s] || recreate.has(s); });
      if (!todo.length) return json(200, { created: [], failed: [], message: 'Every design already has a payment link.' });
      const rates = await shippingRates(settings);
      const created = [], failed = [];
      for (const p of todo) {
        const slug = slugify(p.name), eur = priceFor(settings, p.type, +p.sides || 1);
        if (!eur) { failed.push({ name: p.name, error: 'No price set for this product type.' }); continue; }
        try { have[slug] = await makeLink(p, eur, rates); created.push({ name: p.name, url: have[slug] }); }
        catch (e) { failed.push({ name: p.name, error: e.message }); }
      }
      if (created.length) {
        // keep the original order of links, add new ones at the end
        const next = (links.data.designs || []).map((d) => ({ slug: d.slug, url: have[d.slug] || d.url }));
        created.forEach((c) => { const s = slugify(c.name); if (!next.some((d) => d.slug === s)) next.push({ slug: s, url: c.url }); });
        const data = { ...links.data, designs: next };
        try { await ghPutFile('data/payment-links.json', data, links.sha, 'Add payment links (admin)'); }
        catch (e) {
          if (e.status === 409) { const fresh = await ghGetFile('data/payment-links.json'); await ghPutFile('data/payment-links.json', { ...fresh.data, designs: next }, fresh.sha, 'Add payment links (admin)'); }
          else return json(500, { error: 'Links were created in Stripe but could not be saved to the site: ' + e.message, created, failed });
        }
      }
      return json(200, { created, failed });
    }
    return json(400, { error: 'Unknown action.' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
