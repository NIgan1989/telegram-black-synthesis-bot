// Поиск релевантной картинки в открытых источниках.
// Wikipedia ru/en через MediaWiki API — без авторизации, URL на upload.wikimedia.org
// стабильно загружаются Telegram-ботом (в отличие от Unsplash).

async function findImageForTopic(query) {
  if (!query || typeof query !== 'string' || query.trim().length < 3) return null;
  const q = query.trim().slice(0, 200);

  for (const lang of ['ru', 'en']) {
    try {
      const url = `https://${lang}.wikipedia.org/w/api.php?` +
        `action=query&prop=pageimages&piprop=original|thumbnail&pithumbsize=1200&` +
        `generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=8&format=json`;

      const res = await fetch(url, {
        headers: { 'User-Agent': 'BlackSynthesisBot/1.0 (https://t.me/black_synthesis)' }
      });
      if (!res.ok) continue;

      const data = await res.json();
      const pages = data && data.query && data.query.pages;
      if (!pages) continue;

      // Берём первую страницу из результатов поиска, у которой есть картинка.
      // gsrsearch выдаёт пагинацию по index — сортируем по нему.
      const ordered = Object.values(pages).sort((a, b) => (a.index || 0) - (b.index || 0));
      for (const page of ordered) {
        const src = (page.original && page.original.source) || (page.thumbnail && page.thumbnail.source);
        if (src && /^https?:\/\//.test(src) && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(src)) {
          return src;
        }
      }
    } catch (e) {
      console.warn(`Wikipedia image search (${lang}) failed for "${q}":`, e.message);
    }
  }

  return null;
}

module.exports = { findImageForTopic };
