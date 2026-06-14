// Парсер объявлений kolesa.kz.
// Пользователь присылает ссылку вида https://kolesa.kz/a/show/<id>, мы заходим на страницу,
// вытаскиваем заголовок, цену, характеристики и фото, затем через Gemini нормализуем в car_data.
//
// На странице kolesa.kz для SEO сервер-рендерит: <title>, og:-теги, JSON-LD и список
// характеристик (dt/dd). Мы собираем сигналы из всех источников и не падаем, если какой-то
// из них поменялся.

const gemini = require('./gemini');

const KOLESA_URL_RE = /https?:\/\/(?:www\.|m\.)?kolesa\.kz\/a\/show\/\d+[^\s]*/i;

function extractKolesaUrl(text) {
  if (!text) return null;
  const m = String(text).match(KOLESA_URL_RE);
  return m ? m[0] : null;
}

function isKolesaUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)kolesa\.kz$/.test(u.hostname) && /\/a\/show\/\d+/.test(u.pathname);
  } catch (_) { return false; }
}

// --- low-level helpers ---------------------------------------------------

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ''; } });
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Все значения мета-тега (og:image и т.п.) — атрибуты в любом порядке.
function metaAll(html, key) {
  const out = [];
  const k = escapeRe(key);
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*?\\scontent=["']([^"']+)["']`, 'gi');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*?\\s(?:property|name)=["']${k}["']`, 'gi');
  let m;
  while ((m = re1.exec(html))) out.push(decodeEntities(m[1]));
  while ((m = re2.exec(html))) out.push(decodeEntities(m[1]));
  return [...new Set(out)];
}
function metaOne(html, key) { return metaAll(html, key)[0] || ''; }

// dt/dd пары характеристик ("Год выпуска" → "2020")
function parseParams(html) {
  const map = {};
  const re = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  let m;
  while ((m = re.exec(html))) {
    const k = stripTags(m[1]).toLowerCase().replace(/[:：]\s*$/, '');
    const v = stripTags(m[2]);
    if (k && v && k.length < 60 && v.length < 200) map[k] = v;
  }
  return map;
}

function parsePrice(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[   ]/g, ' ');
  const m = cleaned.match(/([\d][\d ]{3,})\s*(?:₸|тг|тенге|kzt)/i);
  if (m) { const n = parseInt(m[1].replace(/\D/g, ''), 10); if (n > 100000) return n; }
  return null;
}

function parseJsonLd(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1].trim());
      const nodes = Array.isArray(data) ? data : (data['@graph'] ? data['@graph'] : [data]);
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const t = String(node['@type'] || '').toLowerCase();
        if (t.includes('product') || t.includes('vehicle') || t.includes('car') || node.offers) {
          const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
          return {
            name: node.name || '',
            price: offers && offers.price ? parseInt(String(offers.price).replace(/\D/g, ''), 10) || null : null,
            images: [].concat(node.image || []).map(String)
          };
        }
      }
    } catch (_) { /* пропускаем кривой JSON-LD */ }
  }
  return null;
}

// Собирает URL фотографий с CDN kolesa, плюс og:image. Фильтрует логотипы/иконки.
function collectPhotos(html, ogImages) {
  const found = new Set((ogImages || []).map(decodeEntities));
  const re = /https?:\/\/[a-z0-9.\-]*(?:kolesa\.kz|kcdn\.online|kolesa-kz[a-z0-9.\-]*)[^\s"'<>)]*?\.(?:jpe?g|png|webp)/gi;
  let m;
  while ((m = re.exec(html))) found.add(decodeEntities(m[0]));
  return [...found]
    .filter(u => !/logo|sprite|icon|placeholder|avatar|noimage|no-photo|favicon/i.test(u))
    .slice(0, 10);
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache'
    }
  });
  if (!res.ok) throw new Error(`kolesa.kz вернул HTTP ${res.status}`);
  return res.text();
}

// --- public API ----------------------------------------------------------

// Заходит на страницу и собирает сырые данные. Бросает понятную ошибку при блокировке.
async function parseKolesaListing(url) {
  if (!isKolesaUrl(url)) throw new Error('Это не похоже на ссылку kolesa.kz/a/show/...');

  const html = await fetchHtml(url);

  // Анти-бот заглушка обычно короткая и без og-тегов.
  if (html.length < 3000 && /(captcha|cloudflare|доступ ограничен|access denied|robot)/i.test(html)) {
    throw new Error('kolesa.kz заблокировал автоматический доступ к странице.');
  }

  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? stripTags(titleM[1]) : '';
  const ogTitle = metaOne(html, 'og:title');
  const ogDesc = metaOne(html, 'og:description');
  const ogImages = metaAll(html, 'og:image');
  const jsonld = parseJsonLd(html);
  const params = parseParams(html);
  const photos = collectPhotos(html, [...ogImages, ...(jsonld && jsonld.images || [])]);

  const priceKzt = parsePrice(ogTitle) || parsePrice(title)
    || (jsonld && jsonld.price) || parsePrice(ogDesc)
    || parsePrice(Object.values(params).join(' '));

  if (!title && !ogTitle && photos.length === 0) {
    throw new Error('Не удалось прочитать страницу объявления (структура изменилась или доступ закрыт).');
  }

  return {
    url,
    title: ogTitle || title,
    description: ogDesc,
    params,
    photos,
    priceKzt: priceKzt || null
  };
}

// Полный импорт: парсит страницу + нормализует через Gemini → готовый car_data.
// owner: { telegram_id, username, first_name, contact }
// exchangeWish: текст "что хочет взамен" (необязательно)
async function importFromKolesa(url, { owner = {}, exchangeWish = '' } = {}) {
  const parsed = await parseKolesaListing(url);
  const fields = await gemini.extractCarFields({
    title: parsed.title,
    description: parsed.description,
    params: parsed.params,
    priceKzt: parsed.priceKzt,
    exchangeWish
  });

  const car = {
    brand: fields.brand || '',
    model: fields.model || '',
    year: fields.year || null,
    mileage_km: fields.mileage_km || null,
    body: fields.body || '',
    transmission: fields.transmission || '',
    drivetrain: fields.drivetrain || '',
    color: fields.color || '',
    engine: fields.engine || '',
    city: fields.city || '',
    photos: parsed.photos,
    source: { type: 'kolesa', url },
    wants: {
      brand: fields.wants_brand || '',
      model: fields.wants_model || '',
      year_from: null,
      doplata_kzt: 0,
      doplata_direction: '',
      note: fields.wants_text || exchangeWish || ''
    },
    owner: {
      telegram_id: owner.telegram_id || null,
      username: (owner.username || '').replace(/^@/, ''),
      first_name: owner.first_name || '',
      contact: owner.contact || (owner.username ? '@' + String(owner.username).replace(/^@/, '') : '')
    },
    vin: '',
    price_evaluation: {
      owner_asks_kzt: fields.owner_asks_kzt || parsed.priceKzt || null
    },
    imported_at: new Date().toISOString()
  };

  return car;
}

module.exports = {
  extractKolesaUrl,
  isKolesaUrl,
  parseKolesaListing,
  importFromKolesa
};
