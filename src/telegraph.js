// Telegraph (telegra.ph) интеграция — родной сервис Telegram для статей с Instant View.
// Создаёт страницу из Markdown-контента + картинки, возвращает URL.
// При публикации этого URL в канал Telegram сам строит компактную preview-карточку,
// тап → открывает Instant View с полным текстом внутри клиента Telegram.

const TELEGRAPH_API = 'https://api.telegra.ph';

async function callApi(method, params) {
  const res = await fetch(`${TELEGRAPH_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegraph ${method}: ${data.error || 'unknown error'}`);
  }
  return data.result;
}

// access_token Telegraph хранится в таблице settings — создаётся при первом вызове.
async function getAccessToken(db) {
  const row = await db.get("SELECT value FROM settings WHERE key = ?", ['telegraph_token']);
  if (row && row.value) return row.value;

  const result = await callApi('createAccount', {
    short_name: 'BlackSynthesis',
    author_name: 'Чёрный Синтез',
    author_url: 'https://t.me/black_synthesis'
  });

  await db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = ?`,
    ['telegraph_token', result.access_token, result.access_token]
  );

  return result.access_token;
}

// Парсинг inline-markdown (*bold* и _italic_) в массив telegraph-нод.
function parseInline(text) {
  if (!text) return [];
  const out = [];
  let buf = '';
  let i = 0;

  const flushBuf = () => {
    if (buf) { out.push(buf); buf = ''; }
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === '*' && text[i + 1] !== '*') {
      const end = text.indexOf('*', i + 1);
      if (end > i + 1) {
        flushBuf();
        out.push({ tag: 'strong', children: [text.slice(i + 1, end)] });
        i = end + 1;
        continue;
      }
    }

    if (ch === '_') {
      const end = text.indexOf('_', i + 1);
      if (end > i + 1) {
        flushBuf();
        out.push({ tag: 'em', children: [text.slice(i + 1, end)] });
        i = end + 1;
        continue;
      }
    }

    // [text](url)
    if (ch === '[') {
      const closeBr = text.indexOf(']', i + 1);
      if (closeBr > i + 1 && text[closeBr + 1] === '(') {
        const closePar = text.indexOf(')', closeBr + 2);
        if (closePar > closeBr) {
          flushBuf();
          out.push({
            tag: 'a',
            attrs: { href: text.slice(closeBr + 2, closePar) },
            children: [text.slice(i + 1, closeBr)]
          });
          i = closePar + 1;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }
  flushBuf();
  return out;
}

// Конвертация всего markdown-контента в массив Telegraph-нод.
function markdownToNodes(text) {
  if (!text) return [];
  const nodes = [];
  const lines = text.split('\n');
  let currentList = null;

  const closeList = () => {
    if (currentList) { nodes.push(currentList); currentList = null; }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { closeList(); continue; }

    // Списки: "• …" или "- …" или "* …"
    if (/^[•\-]\s+/.test(line)) {
      if (!currentList) currentList = { tag: 'ul', children: [] };
      currentList.children.push({ tag: 'li', children: parseInline(line.replace(/^[•\-]\s+/, '')) });
      continue;
    }

    closeList();

    // Заголовки секций вида "📊 *Ключевые факты:*"
    const sectionMatch = line.match(/^(\p{Extended_Pictographic}+|\p{Emoji}+|[\p{S}\p{So}]+)\s*\*([^*\n]+?)\*\s*:?\s*$/u);
    if (sectionMatch) {
      nodes.push({
        tag: 'h4',
        children: [`${sectionMatch[1]} ${sectionMatch[2]}`]
      });
      continue;
    }

    // Жирный заголовок без эмодзи: "*Что-то*"
    const boldHeading = line.match(/^\*([^*\n]+?)\*\s*:?\s*$/);
    if (boldHeading) {
      nodes.push({ tag: 'h4', children: [boldHeading[1]] });
      continue;
    }

    // Хэштеги в конце — отдельным абзацем мелким текстом
    if (/^#\w+/.test(line)) {
      nodes.push({ tag: 'p', children: [{ tag: 'em', children: [line] }] });
      continue;
    }

    // Обычный абзац
    nodes.push({ tag: 'p', children: parseInline(line) });
  }
  closeList();

  return nodes;
}

// Загружает картинку с произвольного URL в Telegraph и возвращает уже telegra.ph-хостинговый URL.
// Это надёжнее чем вставлять внешние ссылки — внешние Telegraph часто не отдаёт в Instant View
// (отсюда "Ошибка в превью" внизу статьи).
async function uploadImageToTelegraph(externalUrl) {
  if (!externalUrl || !/^https?:\/\//.test(externalUrl)) return null;

  // Сначала скачиваем картинку
  const imgRes = await fetch(externalUrl);
  if (!imgRes.ok) {
    throw new Error(`Не удалось скачать картинку (${imgRes.status})`);
  }
  const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await imgRes.arrayBuffer());

  // Native FormData/Blob в Node 18+
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }), 'image.jpg');

  const upRes = await fetch('https://telegra.ph/upload', { method: 'POST', body: form });
  if (!upRes.ok) {
    throw new Error(`Telegraph upload HTTP ${upRes.status}`);
  }
  const data = await upRes.json();
  if (Array.isArray(data) && data[0] && data[0].src) {
    return `https://telegra.ph${data[0].src}`;
  }
  throw new Error(`Telegraph upload неожиданный ответ: ${JSON.stringify(data).slice(0, 200)}`);
}

// Собирает body статьи: фото (загруженное в Telegraph), основной markdown, подпись.
async function buildContentNodes({ title, content, imageUrl }) {
  const nodes = [];

  // Пробуем загрузить картинку в Telegraph для надёжности.
  if (imageUrl && /^https?:\/\//.test(imageUrl)) {
    let hostedUrl = null;
    try {
      hostedUrl = await uploadImageToTelegraph(imageUrl);
    } catch (e) {
      console.warn(`⚠️ Не удалось загрузить картинку в Telegraph (${e.message}). Использую внешний URL как есть.`);
    }
    nodes.push({ tag: 'figure', children: [{ tag: 'img', attrs: { src: hostedUrl || imageUrl } }] });
  }

  // Удаляем из контента ссылку на источник в формате [domain](url) и одиночные [text](http...) ссылки на новостные домены,
  // чтобы Telegraph не пытался сгенерить broken-preview для news.google.com и подобных.
  const cleanedContent = (content || '').replace(/\n*🔗\s*\[[^\]]+\]\(https?:\/\/[^)]+\)\s*\n*/g, '\n').trim();

  nodes.push(...markdownToNodes(cleanedContent));

  nodes.push({
    tag: 'p',
    children: [
      '— ',
      { tag: 'a', attrs: { href: 'https://t.me/black_synthesis' }, children: ['@black_synthesis'] }
    ]
  });
  return nodes;
}

function cleanupTitle(title) {
  return (title || 'Чёрный Синтез').replace(/[*_`]/g, '').slice(0, 256);
}

// Создаёт Telegraph-страницу, возвращает { url, path, ... }.
async function createArticle({ title, content, imageUrl, db }) {
  const token = await getAccessToken(db);
  const result = await callApi('createPage', {
    access_token: token,
    title: cleanupTitle(title),
    author_name: 'Чёрный Синтез',
    author_url: 'https://t.me/black_synthesis',
    content: await buildContentNodes({ title, content, imageUrl }),
    return_content: false
  });
  return result;
}

// Обновляет существующую Telegraph-страницу по её path (например "Test-05-23").
// Telegram Instant View при тапе на ту же ссылку покажет обновлённое содержимое.
async function editArticle({ path, title, content, imageUrl, db }) {
  if (!path) throw new Error('Telegraph editArticle: path обязателен');
  const token = await getAccessToken(db);
  const result = await callApi('editPage', {
    access_token: token,
    path,
    title: cleanupTitle(title),
    author_name: 'Чёрный Синтез',
    author_url: 'https://t.me/black_synthesis',
    content: await buildContentNodes({ title, content, imageUrl }),
    return_content: false
  });
  return result;
}

module.exports = { createArticle, editArticle, markdownToNodes };
