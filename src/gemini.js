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

    const prompt = `Ты — ведущий аналитик химической и нефтехимической промышленности, пишешь для Telegram-канала "Чёрный Синтез" о химпроме Казахстана и СНГ.

ИСХОДНЫЕ ДАННЫЕ:
Заголовок: ${rawNews.title}
Описание: ${rawNews.description || ''}

СТРУКТУРА ПОСТА (строго соблюдай):

🏭 *<Цепляющий заголовок, до 90 символов, БЕЗ упоминания источника новости>*

<Лид-абзац: 1-2 предложения, отвечающих "что произошло и почему это важно".>

📊 *Ключевые факты:*
• <Факт 1 с *жирной цифрой/именем*>
• <Факт 2>
• <Факт 3 (если есть)>

⚙️ *Технология / Контекст:*
<Один-два коротких абзаца с техническими деталями: катализаторы, процесс, технология, экология, инвестиции. Конкретика — не общие слова.>

💡 *Что это значит для отрасли:*
<1-2 предложения — аналитический вывод. Влияние на рынок, цены, конкуренцию, регион.>

#хештег1 #хештег2 #хештег3 #ЧёрныйСинтез

ПРАВИЛА:
1. Язык — русский. Тон — экспертный, без воды.
2. Markdown: одинарные звёздочки для жирного (*текст*), подчёркивания для курсива (_текст_). НЕ используй ** (двойные) или ## (заголовки).
3. Общая длина текста: 600-900 символов (без подсчёта хэштегов). Это нужно чтобы пост помещался в caption фото.
4. НЕ добавляй ссылку на источник — она будет добавлена системой автоматически.
5. Хэштеги — 3-5, без запятых, через пробел, в конце.
6. Эмодзи в начале блоков (по одной), не разбрасывай по тексту.
7. Заголовок в первой строке должен быть жирным (*...*) и не повторять слова "анализ" или название агентства.
8. В поле imageKeywords положи 2-4 поисковых слова для иллюстрации (например "Атырауский НПЗ" или "polyethylene plant Kazakhstan" — то, по чему точно есть статья в Wikipedia).
9. Не пиши никаких пояснений до или после JSON.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    return JSON.parse(text);
  } catch (error) {
    console.error('❌ Ошибка при генерации статьи через Gemini API:', error.message);
    // Возвращаем мок-данные при ошибке API, чтобы система не падала
    return mockGenerateArticle(rawNews);
  }
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

    const prompt = `Проанализируй тональность следующего комментария в Telegram-канале о химической и нефтехимической промышленности Казахстана и СНГ. 
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

// Генерация поста по произвольному запросу пользователя
async function generatePostFromPrompt(userPrompt, options = {}) {
  const { withChannelStyle = true } = options;

  if (isDemo) {
    return { ...mockGenerateFromPrompt(userPrompt, withChannelStyle), _mock: true, _reason: !process.env.GEMINI_API_KEY ? 'no_api_key' : 'demo_mode_on' };
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

СТРУКТУРА ПОСТА:

🏭 *<Цепляющий заголовок до 90 символов>*

<Лид: 1-2 предложения отвечающих на "что и почему важно".>

📊 *Ключевые факты:*
• <Факт с *жирной цифрой*>
• <Факт>
• <Факт>

⚙️ *Технология / Контекст:*
<1-2 коротких абзаца с конкретикой по теме запроса.>

💡 *Вывод:*
<1-2 предложения аналитики — что это значит.>

#хештег1 #хештег2 #хештег3 #ЧёрныйСинтез

ПРАВИЛА:
1. Язык — русский.
2. Markdown: *жирный*, _курсив_. НЕ используй ** или ##.
3. Длина: 600-900 символов (чтобы помещался в caption фото).
4. 3-5 хэштегов в конце через пробел.
5. По одной эмодзи в начале блоков.
6. В поле imageKeywords положи 2-4 поисковых слова (компания, объект, технология) для подбора картинки.
7. Не пиши пояснений до или после JSON.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    return JSON.parse(text);
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

module.exports = {
  generateArticle,
  analyzeSentiment,
  generatePostFromPrompt
};
