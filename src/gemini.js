const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');

dotenv.config();

const isDemo = process.env.DEMO_MODE === 'true' || !process.env.GEMINI_API_KEY;

let genAI = null;
if (!isDemo) {
  try {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  } catch (e) {
    console.error('❌ Инициализация Gemini SDK не удалась:', e.message);
  }
}

// Генерация статьи
async function generateArticle(rawNews) {
  if (isDemo) {
    console.log('🤖 ИИ (Демо): Имитация генерации статьи на основе:', rawNews.title || 'Новость');
    return mockGenerateArticle(rawNews);
  }

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING', description: 'Краткий цепляющий заголовок поста на русском.' },
            content: { type: 'STRING', description: 'Полный текст поста в Markdown, со структурой: заголовок-лид-факты-технология-вывод-хэштеги.' },
            imageKeywords: { type: 'STRING', description: '2-4 ключевых слова на английском или русском для поиска иллюстрации в Wikipedia (название компании, объекта, технологии, города). Через пробел, без кавычек.' }
          },
          required: ['title', 'content', 'imageKeywords']
        }
      }
    });

    const prompt = `Ты — редактор делового Telegram-канала "Чёрный Синтез" о химической и нефтехимической промышленности Казахстана и СНГ. Пишешь в стиле журналистской аналитики (PACE / "Нефть и Газ Казахстана. Факты и комментарии"): сначала факт, потом твой комментарий и контекст.

ИСХОДНЫЕ ДАННЫЕ:
Заголовок: ${rawNews.title}
Описание: ${rawNews.description || ''}
Источник (ссылка): ${rawNews.link || ''}

СТРУКТУРА ПОСТА:

🏷 *<КОРОТКИЙ ЦЕПЛЯЮЩИЙ ЗАГОЛОВОК В ОДНУ СТРОКУ. Ключевое слово можно КАПСОМ.>*

*Факт.* <Что произошло: компания, цифры, даты, локация. Используй *жирный* для названий компаний и сумм. Включи [кликабельную ссылку на источник](${rawNews.link || 'https://t.me/black_synthesis'}) прямо в текст, например "сообщает [neftegaz.ru](URL)".>

*Комментарий.* <Аналитический разбор: что это значит для отрасли, какой контекст, чем интересно. 2-3 предложения. Можно добавить ещё [inline-ссылки](url) на дополнительные источники из ИСХОДНЫХ ДАННЫХ.>

> «Прямая цитата из новости — слова чиновника, аналитика или официальное заявление компании. Если в исходнике нет цитат — опусти этот блок целиком.»
— Должность и имя автора цитаты

🇰🇿 <Если есть страновой контекст для Казахстана/Узбекистана/России — 1-2 предложения о влиянии на рынок этой страны. Флаг в начале.>

#хештег1 #хештег2 #хештег3

ПРАВИЛА РАЗМЕТКИ:
1. Только эти конструкции: *жирный*, _курсив_, [текст](url), > строка-цитата
2. НЕ используй ** (двойные звёздочки), ## (заголовки) — Telegram их не парсит.
3. Цитата — отдельный абзац, строка начинается с "> ", максимум 4-5 строк.
4. Inline-ссылки — обязательно как минимум одна, прямо в тексте лида (не в подвале).
5. Длина: 600-1000 символов, чтобы помещалось в Telegraph-карточку.

В imageKeywords положи 2-4 поисковых слова для иллюстрации в Wikipedia.

Не пиши пояснений до или после JSON.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parsed = JSON.parse(text);
    if (parsed.content) parsed.content = sanitizeMarkdown(parsed.content);
    return parsed;
  } catch (error) {
    console.error('❌ Ошибка при генерации статьи через Gemini API:', error.message);
    return mockGenerateArticle(rawNews);
  }
}

// Чистка Markdown под Telegram legacy parse_mode: 'Markdown'.
// Gemini регулярно генерит **bold** (GitHub-стиль) и ## заголовки — Telegram их не парсит и
// показывает буквально. Конвертируем в одинарные * и убираем ## хедеры.
function sanitizeMarkdown(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/\*\*\*([^*\n]+?)\*\*\*/g, '*$1*')         // ***bold-italic*** → *bold*
    .replace(/\*\*([^*\n]+?)\*\*/g, '*$1*')             // **bold** → *bold*
    .replace(/__([^_\n]+?)__/g, '_$1_')                 // __italic__ → _italic_
    .replace(/^#{1,6}\s+/gm, '')                        // remove ## headings markers
    .replace(/\n{3,}/g, '\n\n')                         // collapse triple+ newlines
    .trim();
}

// Экранирует HTML-спецсимволы в обычном тексте
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Применяет inline-разметку (звёздочки/подчёркивания/ссылки) к УЖЕ экранированной строке.
function applyInlineHtml(escaped) {
  // [text](url) → <a href="url">text</a>
  let out = escaped.replace(/\[([^\]\n]+?)\]\(([^)\n]+?)\)/g, (_, txt, url) => {
    const safeUrl = url.replace(/"/g, '&quot;');
    return `<a href="${safeUrl}">${txt}</a>`;
  });
  // *bold* → <b>bold</b>
  out = out.replace(/\*([^*\n]+?)\*/g, '<b>$1</b>');
  // _italic_ → <i>italic</i>
  out = out.replace(/_([^_\n]+?)_/g, '<i>$1</i>');
  return out;
}

// Конвертер расширенного Markdown в Telegram HTML:
//   *bold* → <b>, _italic_ → <i>, [text](url) → <a href=…>,
//   строки начинающиеся с "> " → <blockquote>,
//   строки начинающиеся с "**>" → <blockquote expandable>.
function richToHtml(text) {
  if (!text || typeof text !== 'string') return '';
  const cleaned = sanitizeMarkdown(text);
  const lines = cleaned.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const ln = lines[i];
    const stripped = ln.trim();
    const isExpandable = stripped.startsWith('**>');
    const isQuote = isExpandable || stripped.startsWith('>');

    if (isQuote) {
      const quoted = [];
      while (i < lines.length) {
        const cur = lines[i].trim();
        if (cur === '') break;
        if (!cur.startsWith('>') && !cur.startsWith('**>')) break;
        quoted.push(lines[i].replace(/^\s*\*?\*?>\s?/, ''));
        i++;
      }
      const inner = quoted.map(l => applyInlineHtml(escapeHtml(l))).join('\n');
      const tag = isExpandable ? '<blockquote expandable>' : '<blockquote>';
      out.push(`${tag}${inner}</blockquote>`);
    } else {
      out.push(applyInlineHtml(escapeHtml(ln)));
      i++;
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// Анализ тональности комментария
async function analyzeSentiment(commentText) {
  if (isDemo) {
    return mockAnalyzeSentiment(commentText);
  }

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            sentiment: { 
              type: 'STRING', 
              enum: ['positive', 'neutral', 'negative'],
              description: 'Тональность комментария. positive - одобрение, благодарность, радость. neutral - вопрос по существу, сухое обсуждение фактов. negative - критика, ругань, сарказм, недовольство.'
            }
          },
          required: ['sentiment']
        }
      }
    });

    const prompt = `Проанализируй тональность комментария к объявлению об обмене авто на Telegram-канале «Авто обмен Казахстан».
Верни строго JSON со значением "positive", "neutral" или "negative".

КОММЕНТАРИЙ:
"${commentText}"`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const data = JSON.parse(text);
    return data.sentiment || 'neutral';
  } catch (error) {
    console.error('❌ Ошибка анализа тональности через Gemini API:', error.message);
    return mockAnalyzeSentiment(commentText);
  }
}

// ГЕНЕРАТОРЫ ИМИТАЦИОННЫХ ДАННЫХ (MOCK)

function mockGenerateArticle(rawNews) {
  const rawTitle = (rawNews.title || 'Развитие химического кластера в СНГ').replace(/\s*[-—|]\s*[A-Za-zА-Яа-я.]+\.?\s*$/, '');
  const title = rawTitle.length > 90 ? rawTitle.slice(0, 87) + '...' : rawTitle;

  const techKeywords = [
    'каталитическая полимеризация пропилена',
    'синтез поливинилхлорида методом суспензионной полимеризации',
    'производство аммиака по технологии Haldor Topsoe',
    'каталитический риформинг с выделением параксилола',
    'дегидрирование пропана (PDH) на платиновом катализаторе',
    'экструзия высокопрочного полиэтилена трубных марок'
  ];
  const selectedTech = techKeywords[Math.floor(Math.random() * techKeywords.length)];

  const content = `🏭 *${title}*

${rawNews.description || 'Развитие химического кластера и производства полимеров в Казахстане и СНГ.'}

📊 *Ключевые факты:*
• Развиваются нефтехимические кластеры в *Атырауской* и *Навоийской* областях
• Идёт интеграция базовых мономеров с выпуском конечных изделий
• Растёт экспорт полипропилена, полиэтилена и удобрений

⚙️ *Технология / Контекст:*
Ключевую роль играет _${selectedTech}_. Это повышает выход целевых фракций, улучшает прочностные характеристики полимеров и снижает углеродный след за счёт утилизации факельных газов.

💡 *Что это значит для отрасли:*
Казахстан и страны СНГ укрепляют позиции на мировом рынке базовой химии. Спрос на полипропилен, ПЭ и азотные удобрения открывает горизонт для долгосрочного экспорта.

#нефтехимия #полимеры #удобрения #Казахстан #ЧёрныйСинтез`;

  return { title, content, imageKeywords: 'нефтехимия Казахстан завод' };
}

function mockAnalyzeSentiment(commentText) {
  const text = commentText.toLowerCase();
  
  // Простые правила для эмуляции
  if (text.includes('отлично') || text.includes('круто') || text.includes('супер') || text.includes('класс') || text.includes('согласен') || text.includes('спасибо') || text.includes('👍') || text.includes('🔥')) {
    return 'positive';
  }
  
  if (text.includes('плохо') || text.includes('ужас') || text.includes('бред') || text.includes('фигня') || text.includes('вранье') || text.includes('👎') || text.includes('говно') || text.includes('ерунда')) {
    return 'negative';
  }
  
  // Рандомный выбор при отсутствии явных триггеров
  const rand = Math.random();
  if (rand < 0.2) return 'positive';
  if (rand < 0.4) return 'negative';
  return 'neutral';
}

// Прямой HTTP-вызов Gemini API с подключённым инструментом google_search (grounding).
// Возвращает {text, sources}. Используется когда нужно, чтобы Gemini сначала пошёл в интернет
// проверить факты и нашёл реальные источники, а потом написал пост.
async function callGeminiWithSearch(promptText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY не задан');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.7 }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await res.json();
  const candidate = data.candidates && data.candidates[0];
  if (!candidate) throw new Error('Gemini не вернул кандидатов');

  const text = (candidate.content && candidate.content.parts)
    ? candidate.content.parts.map(p => p.text || '').join('')
    : '';
  const grounding = candidate.groundingMetadata || {};
  const sources = ((grounding.groundingChunks || [])
    .filter(c => c.web && c.web.uri)
    .map(c => ({ url: c.web.uri, title: c.web.title || c.web.uri })));

  return { text, sources };
}

// Парсит JSON из текста Gemini, снимая markdown-обёртки ```json …``` если есть.
function extractJsonFromText(text) {
  let s = String(text || '').trim();
  const fence = /^```(?:json)?\s*([\s\S]+?)\s*```$/i;
  const m = s.match(fence);
  if (m) s = m[1].trim();
  return JSON.parse(s);
}

// Полноценная генерация поста с веб-поиском. Возвращает {title, content, imageKeywords, sources}.
async function generateWithWebSearch(userPrompt, withChannelStyle) {
  const channelStyle = withChannelStyle ? `СТИЛЬ КАНАЛА «Чёрный Синтез»:
Экспертный, аналитический тон. Химпром и нефтехимия Казахстана и СНГ.
Технические детали, региональный контекст.
` : '';

  const prompt = `${channelStyle}
ЗАДАЧА РЕДАКТОРА: Найди в интернете АКТУАЛЬНЫЕ И ДОСТОВЕРНЫЕ источники по теме, и напиши пост на их основе для Telegram-канала.

ТЕМА:
${userPrompt}

ШАГ 1: Через Google Search найди свежие новости от авторитетных источников (neftegaz.ru, interfax.ru, kursiv.kz, primeminister.kz, официальные сайты компаний, отраслевые издания). Игнорируй блоги без атрибуции, форумы, агрегаторы низкого качества.

ШАГ 2: На основе НАЙДЕННЫХ фактов напиши пост. ОБЯЗАТЕЛЬНО включи 1-2 кликабельные [inline-ссылки](url) на главные источники прямо в текст лида или комментария. Если не нашёл достоверных источников — добавь в начало content явную пометку "_⚠️ Информация требует дополнительной проверки._" и пиши на основе общеотраслевых знаний.

СТРУКТУРА:
🏷 *<КОРОТКИЙ ЦЕПЛЯЮЩИЙ ЗАГОЛОВОК>*

*Факт.* <Что произошло: компания, цифры, даты, локация. Жирным *выделяй ключевое*. Включи [inline-ссылку](url) на главный источник.>

*Комментарий.* <Аналитика, контекст, значение для отрасли. Можно ещё одну [ссылку](url).>

> «Прямая цитата чиновника/компании, если есть в найденных источниках. Если нет — опусти блок.»
— Должность и имя

🇰🇿 <Страновой контекст, если уместен>

#хештег1 #хештег2 #хештег3

ПРАВИЛА РАЗМЕТКИ:
- Только *жирный*, _курсив_, [текст](url), > строка-цитата. БЕЗ ** или ##.
- Длина: 600-1000 символов.

ВЕРНИ СТРОГО JSON (без обёрток markdown, без \`\`\`json):
{"title": "...", "content": "...", "imageKeywords": "2-4 слова для Wikipedia"}`;

  const { text, sources } = await callGeminiWithSearch(prompt);
  let parsed;
  try {
    parsed = extractJsonFromText(text);
  } catch (e) {
    throw new Error(`Не удалось распарсить JSON от Gemini: ${e.message}. Raw: ${text.slice(0, 200)}`);
  }

  return {
    title: parsed.title || '',
    content: sanitizeMarkdown(parsed.content || ''),
    imageKeywords: parsed.imageKeywords || '',
    sources: sources.slice(0, 8),
    _searchUsed: true
  };
}

// Генерация поста по произвольному запросу пользователя
async function generatePostFromPrompt(userPrompt, options = {}) {
  const { withChannelStyle = true, withWebSearch = true } = options;

  if (isDemo) {
    return { ...mockGenerateFromPrompt(userPrompt, withChannelStyle), _mock: true, _reason: !process.env.GEMINI_API_KEY ? 'no_api_key' : 'demo_mode_on' };
  }

  // С веб-поиском (по умолчанию) — сначала ищем источники, потом пишем по ним.
  if (withWebSearch) {
    try {
      return await generateWithWebSearch(userPrompt, withChannelStyle);
    } catch (e) {
      console.warn('⚠️ Web-search generation failed, fallback на обычную:', e.message);
      // Падаем дальше — попробуем без поиска
    }
  }

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING', description: 'Краткий цепляющий заголовок поста на русском' },
            content: { type: 'STRING', description: 'Основной текст поста с Markdown-разметкой и хэштегами' },
            imageKeywords: { type: 'STRING', description: '2-4 ключевых слова для поиска иллюстрации в Wikipedia (название объекта, компании, технологии). Через пробел, без кавычек.' }
          },
          required: ['title', 'content', 'imageKeywords']
        }
      }
    });

    const channelStyle = withChannelStyle ? `СТИЛЬ КАНАЛА «Чёрный Синтез»:
Экспертный, аналитический тон. Химпром и нефтехимия Казахстана и СНГ.
Технические детали: катализаторы, полимеризация, переработка газа, производство удобрений и полимеров.
Региональный контекст: Казахстан, Узбекистан, Россия, Беларусь.
` : '';

    const prompt = `${channelStyle}
ЗАДАНИЕ ОТ РЕДАКТОРА:
${userPrompt}

СТРУКТУРА ПОСТА (журналистский стиль с цитатами и inline-ссылками):

🏷 *<КОРОТКИЙ ЦЕПЛЯЮЩИЙ ЗАГОЛОВОК В ОДНУ СТРОКУ>*

*Факт.* <Суть события: компания, цифры, даты, локация. Жирным выделяй *суммы* и *названия*. Если уместно — вставь [inline-ссылку](https://example.com) на источник.>

*Комментарий.* <Аналитический контекст: значение для отрасли, технологии, рынка. 2-3 предложения.>

> «Прямая цитата эксперта/чиновника/компании по теме — если уместна для запроса.»
— Должность и имя

🇰🇿 <Страновой контекст, если есть. Флаг в начале.>

#хештег1 #хештег2 #хештег3

ПРАВИЛА РАЗМЕТКИ:
1. Только: *жирный*, _курсив_, [текст](url), > строка-цитата
2. НЕ используй ** или ## (Telegram это не парсит).
3. Цитата — отдельный абзац, каждая строка с "> " в начале, 3-5 строк максимум.
4. Длина: 600-1000 символов.
5. imageKeywords — 2-4 слова для поиска картинки в Wikipedia.

Не пиши пояснений до или после JSON.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parsed = JSON.parse(text);
    if (parsed.content) parsed.content = sanitizeMarkdown(parsed.content);
    return parsed;
  } catch (error) {
    console.error('❌ Ошибка генерации поста через Gemini:', error.message);
    return { ...mockGenerateFromPrompt(userPrompt, withChannelStyle), _mock: true, _reason: 'gemini_api_error', _error: error.message };
  }
}

function mockGenerateFromPrompt(userPrompt, withChannelStyle) {
  const shortPrompt = userPrompt.length > 80 ? userPrompt.slice(0, 77) + '...' : userPrompt;

  const content = `🏭 *${shortPrompt}*

_(Демо-режим: реальная Gemini-генерация недоступна — нужен GEMINI_API_KEY с выключенным DEMO_MODE)_

📊 *Ключевые факты:*
• На этом месте будут *конкретные цифры и факты* по теме
• Региональный контекст: *Казахстан, СНГ*
• Технические подробности процесса

⚙️ *Технология / Контекст:*
В продакшене Gemini напишет подробный технический разбор с упоминанием катализаторов, реакторов, экологических аспектов и сравнения с международными аналогами.

💡 *Что это значит:*
Аналитический вывод о влиянии события на рынок и отрасль.

#ЧёрныйСинтез #демо ${withChannelStyle ? '#нефтехимия #СНГ' : '#свободныйСтиль'}`;

  // Простой эвристический парсинг ключевых слов из промпта на случай мока.
  const imageKeywords = userPrompt
    .replace(/[^\w\sА-Яа-яёЁ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4)
    .slice(0, 3)
    .join(' ') || 'нефтехимия';

  return { title: shortPrompt, content, imageKeywords };
}

// Доработка существующего поста через Gemini: принимает текущие title+content и инструкцию редактора,
// возвращает переписанный {title, content}. Используется в модалке редактирования поста.
async function improvePost({ title, content, instruction }) {
  if (isDemo) {
    return { ...mockImprovePost(title, content, instruction), _mock: true, _reason: !process.env.GEMINI_API_KEY ? 'no_api_key' : 'demo_mode_on' };
  }

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING', description: 'Цепляющий заголовок поста на русском.' },
            content: { type: 'STRING', description: 'Переписанный текст в Markdown с одинарными звёздочками.' }
          },
          required: ['title', 'content']
        }
      }
    });

    const prompt = `Ты — редактор Telegram-канала "Чёрный Синтез" о химической и нефтехимической промышленности Казахстана и СНГ.

ТЕКУЩИЙ ПОСТ:
Заголовок: ${title || '(не задан)'}

Содержимое:
${content || '(пусто)'}

ЗАДАЧА ОТ РЕДАКТОРА:
${instruction}

ПРАВИЛА:
1. Перепиши пост согласно задаче, не меняя главный смысл и фактическую базу.
2. Сохраняй структуру: эмодзи-заголовок → лид → 📊 *Ключевые факты* → ⚙️ *Технология* → 💡 *Вывод* → #хэштеги.
3. Markdown: одинарные звёздочки *жирный*, подчёркивания _курсив_. НЕ используй ** или ##.
4. Длина: 600-900 символов (без хэштегов), чтобы помещалось в Telegraph-карточку.
5. Не пиши пояснений до или после JSON.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parsed = JSON.parse(text);
    if (parsed.content) parsed.content = sanitizeMarkdown(parsed.content);
    return parsed;
  } catch (error) {
    console.error('❌ Ошибка доработки поста через Gemini:', error.message);
    return { ...mockImprovePost(title, content, instruction), _mock: true, _reason: 'gemini_api_error', _error: error.message };
  }
}

function mockImprovePost(title, content, instruction) {
  return {
    title: title || 'Заголовок (демо)',
    content: `${content || ''}\n\n_[Демо-режим: реальная доработка недоступна. Инструкция была: "${instruction.slice(0, 100)}"]_`
  };
}

// === АВТО ОБМЕН КАЗАХСТАН: оценка машины + генерация поста =========================

// Главная функция: на основе данных автомобиля делает 2 вещи через Gemini + Google Search:
// 1) ищет рыночную цену похожих машин на kolesa.kz / mojo.kz / автоплощадках и оценивает
//    диапазон min-avg-max, плюс примерную цену которую дадут перекупы/салоны;
// 2) пишет красивое экспертное описание в стиле объявления для канала.
// Возвращает { title, content, price_evaluation:{owner_asks_kzt,market_min,market_avg,
//   market_max, salon_estimate, sources:[]}, _searchUsed }
async function evaluateAndDescribeCar(car) {
  if (isDemo || !process.env.GEMINI_API_KEY) {
    return mockEvaluateCar(car);
  }

  const ownerAsks = car && car.price_evaluation && car.price_evaluation.owner_asks_kzt;
  const photo = (car && car.photos && car.photos[0]) || '';
  const wantsLine = car.wants
    ? `${car.wants.brand || '?'} ${car.wants.model || ''} ${car.wants.year_from ? `${car.wants.year_from}+` : ''}`.trim()
    : 'любой авто';

  const prompt = `Ты — эксперт казахстанского авторынка, ведёшь Telegram-канал «Авто обмен Казахстан».
Канал — альтернатива салонам Санжар рулит / Ержан рулит / Астер, которые занижают цены б/у машин.
Твоя задача: дать ЧЕСТНУЮ оценку и красивое описание объявления об ОБМЕНЕ (не продаже).

ДАННЫЕ ОБ АВТО:
• Марка/модель: ${car.brand || ''} ${car.model || ''}
• Год: ${car.year || ''}
• Пробег: ${car.mileage_km || '?'} км
• Кузов: ${car.body || ''}
• КПП: ${car.transmission || ''}
• Привод: ${car.drivetrain || ''}
• Цвет: ${car.color || ''}
• Состояние: ${car.condition || ''}
• Город: ${car.city || ''}
• Владелец просит цену: ${ownerAsks ? `${ownerAsks.toLocaleString('ru')} ₸` : 'не указана'}
• ХОЧЕТ ОБМЕНЯТЬ НА: ${wantsLine}
• Доплата: ${car.wants && car.wants.doplata_kzt ? `${car.wants.doplata_kzt.toLocaleString('ru')} ₸ (${car.wants.doplata_direction || 'не указано направление'})` : 'без доплат'}

ШАГ 1: Через Google Search найди рыночные цены ИМЕННО этой модели/года/пробега на kolesa.kz, mojo.kz, krisha.kz и других казахстанских автоплощадках. Не путай Россию/мир — нужны казахстанские тенге.

ШАГ 2: Оцени диапазон рынка: min / avg / max. Прикинь среднюю цену которую дадут перекупы или салоны (Санжар/Ержан/Астер) — обычно это 80-85% от рыночной нижней границы.

ШАГ 3: Напиши красивое описание для канала в формате-карточке обмена.

СТРУКТУРА ОПИСАНИЯ (HTML-разметка Telegram):

🔄 *<КОРОТКИЙ ЗАГОЛОВОК: марка модель год → что хочет>*

📋 *На руках:*
• <Марка> <Модель>, <Год>
• Пробег: <X> км
• <Кузов>, <КПП>, <Привод>
• Состояние: <состояние>
• Город: <город>

💰 *Рыночная цена:* <min-max> млн ₸ (по данным [kolesa.kz](url))
⚠️ *В салонах предложат:* ~<salon_estimate> млн ₸ — на <X> % ниже рынка

🔄 *Хочу обменять на:*
<что и доплата с какой стороны>

📞 *Связь с владельцем:* ${car.owner && car.owner.username ? `@${car.owner.username}` : car.owner && car.owner.contact || '@admin'}

#обмен #${car.brand || ''} #${(car.model || '').replace(/\s/g, '')} #${car.city || ''}

ПРАВИЛА:
1. Только *жирный*, _курсив_, [текст](url), > строка-цитата. БЕЗ ** и ##.
2. Длина: 600-1000 символов.
3. Цены округляй до десятков тысяч.
4. Если рыночные данные не нашёл — добавь в начало "_⚠️ Цена требует ручной проверки_" и поставь market_min=market_avg=market_max=owner_asks.

ВЕРНИ СТРОГО JSON (без \`\`\`json обёрток):
{
  "title": "<заголовок поста>",
  "content": "<HTML-готовый текст по структуре выше>",
  "market_min": <число KZT>,
  "market_avg": <число KZT>,
  "market_max": <число KZT>,
  "salon_estimate": <число KZT>
}`;

  try {
    const { text, sources } = await callGeminiWithSearch(prompt);
    const parsed = extractJsonFromText(text);
    return {
      title: parsed.title || `Обмен: ${car.brand} ${car.model} ${car.year}`,
      content: sanitizeMarkdown(parsed.content || ''),
      price_evaluation: {
        owner_asks_kzt: ownerAsks || null,
        market_min: parsed.market_min || null,
        market_avg: parsed.market_avg || null,
        market_max: parsed.market_max || null,
        salon_estimate: parsed.salon_estimate || null,
        sources: sources.slice(0, 6)
      },
      _searchUsed: true
    };
  } catch (e) {
    console.warn('⚠️ Gemini car eval failed:', e.message);
    return mockEvaluateCar(car);
  }
}

function mockEvaluateCar(car) {
  const ownerAsks = car && car.price_evaluation && car.price_evaluation.owner_asks_kzt || 10000000;
  const wantsLine = car.wants ? `${car.wants.brand || '?'} ${car.wants.model || ''}`.trim() : 'любой';
  return {
    title: `Обмен: ${car.brand || 'Авто'} ${car.model || ''} ${car.year || ''} → ${wantsLine}`,
    content: `🔄 *${(car.brand || '').toUpperCase()} ${car.model || ''} ${car.year || ''} → ${wantsLine}*\n\n` +
      `_⚠️ Демо: реальная оценка цены недоступна без GEMINI_API_KEY._\n\n` +
      `📋 *На руках:*\n• ${car.brand || ''} ${car.model || ''}, ${car.year || ''}\n• Пробег: ${car.mileage_km || '?'} км\n• ${car.city || ''}\n\n` +
      `💰 *Цена владельца:* ${ownerAsks.toLocaleString('ru')} ₸\n\n` +
      `🔄 *Хочу обменять на:* ${wantsLine}\n\n` +
      `📞 *Связь:* ${(car.owner && car.owner.contact) || '@admin'}\n\n` +
      `#обмен #${car.brand || 'авто'}`,
    price_evaluation: {
      owner_asks_kzt: ownerAsks,
      market_min: Math.round(ownerAsks * 0.95),
      market_avg: ownerAsks,
      market_max: Math.round(ownerAsks * 1.08),
      salon_estimate: Math.round(ownerAsks * 0.78),
      sources: []
    },
    _mock: true
  };
}

module.exports = {
  generateArticle,
  analyzeSentiment,
  generatePostFromPrompt,
  improvePost,
  sanitizeMarkdown,
  richToHtml,
  evaluateAndDescribeCar
};
