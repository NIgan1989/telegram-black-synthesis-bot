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
      model: 'gemini-1.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING', description: 'Краткий и цепляющий заголовок для поста в Telegram на русском языке.' },
            content: { type: 'STRING', description: 'Подробный, профессиональный, отформатированный пост для Telegram на русском языке с использованием markdown (жирный текст, списки, хэштеги).' }
          },
          required: ['title', 'content']
        }
      }
    });

    const prompt = `Ты — ведущий аналитик химической и нефтехимической промышленности, эксперт по развитию химических кластеров в Казахстане и странах СНГ.
На основе следующих исходных данных о новости напиши качественный, глубокий и экспертный аналитический пост для Telegram-канала "Черный Синтез".

ИСХОДНЫЕ ДАННЫЕ:
Заголовок: ${rawNews.title}
Описание/Текст: ${rawNews.description || ''}
Источник: ${rawNews.link || ''}

ТРЕБОВАНИЯ К ПОСТУ:
1. Язык: русский.
2. Проанализируй влияние этого события на химический и нефтехимический кластер Казахстана, стран СНГ и на мировые рынки полимеров, удобрений, базовой химии.
3. Добавь технические детали и ноу-хау, если они уместны (технологии синтеза, полимеризация, производство полиэтилена, полипропилена, азотных/фосфорных удобрений, катализаторы, аппараты колонного типа, экологические аспекты утилизации побочных газов).
4. Оформи пост профессионально: используй абзацы, списки, важные мысли выдели жирным шрифтом.
5. В конце поста добавь уместные хэштеги (например, #нефтехимия #полимеры #удобрения #Казахстан #СНГ #технологии #ЧерныйСинтез).
6. Избегай шаблонных фраз и общих мест. Пост должен выглядеть так, как будто его написал живой отраслевой эксперт.
7. Не пиши никаких дополнительных пояснений, верни строго JSON по схеме.`;

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
      model: 'gemini-1.5-flash',
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
  const title = `Анализ: ${rawNews.title || 'Развитие химического кластера в СНГ'}`;
  
  const techKeywords = [
    'каталитическая полимеризация пропилена',
    'синтез поливинилхлорида методом суспензионной полимеризации',
    'производство аммиака из природного газа по технологии Haldor Topsoe',
    'каталитический риформинг и выделение параксилола',
    'дегидрирование пропана (PDH) на платиновом катализаторе',
    'экструзия высокопрочного полиэтилена трубных марок'
  ];
  
  const selectedTech = techKeywords[Math.floor(Math.random() * techKeywords.length)];
  
  const content = `📊 **${title}**

Событие: *${rawNews.description || 'Развитие химического кластера и производства полимеров в Казахстане и СНГ.'}*

🔍 **Влияние на отрасль и аналитика:**
Химическая промышленность и производство полимеров в Казахстане и СНГ переживают этап масштабной трансформации. Создание полноценных нефтехимических кластеров в Атырауской и Навоийской областях позволяет повысить добавленную стоимость сырья, сократить зависимость от импорта готовой продукции и интегрировать производство базовых мономеров с выпуском конечных изделий.

⚙️ **Технологические нюансы (Know-How):**
Специалисты отмечают, что ключевую роль играет внедрение такой технологии, как **${selectedTech}**. Это позволяет достичь высокого выхода целевых фракций, улучшить прочностные характеристики полимеров и снизить углеродный след за счет утилизации факельных газов. Проекты таких гигантов, как KPI Inc, KazAzot и Navoiyazot, служат отличным примером практического применения этих решений.

💡 **Выводы для рынка:**
Казахстан и СНГ последовательно укрепляют позиции на мировом рынке химии. Растущий спрос на полипропилен, полиэтилен и современные минеральные удобрения открывает широкие возможности для долгосрочного экспорта и внутренней кооперации в рамках СНГ на ближайшие годы.

🔗 *Источник информации: ${rawNews.link || 'Ассоциация химической промышленности'}*

#нефтехимия #полимеры #удобрения #Казахстан #СНГ #технологии #ЧерныйСинтез #ИИ_Аналитика`;

  return { title, content };
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
    return mockGenerateFromPrompt(userPrompt, withChannelStyle);
  }

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING', description: 'Краткий цепляющий заголовок поста на русском' },
            content: { type: 'STRING', description: 'Основной текст поста с Markdown-разметкой и хэштегами' }
          },
          required: ['title', 'content']
        }
      }
    });

    const channelStyle = withChannelStyle ? `СТИЛЬ КАНАЛА:
Ты пишешь для Telegram-канала «Чёрный Синтез» — отраслевого канала о химической и нефтехимической промышленности Казахстана и стран СНГ.
Голос канала: экспертный, аналитический, с техническими деталями (катализаторы, процессы полимеризации, переработка углеводородов, производство удобрений и полимеров).
Региональный контекст: Казахстан, Узбекистан, Россия, Беларусь и другие страны СНГ.
` : '';

    const prompt = `${channelStyle}
ЗАДАНИЕ ОТ РЕДАКТОРА:
${userPrompt}

ТРЕБОВАНИЯ К ПОСТУ:
1. Язык: русский.
2. Форматирование: Markdown (жирный *...*, курсив _..._, абзацы, маркированные списки).
3. Эмодзи в начале ключевых блоков (1-2 на абзац, не злоупотребляй).
4. В конце — 3-5 уместных хэштегов.
5. Длина: 800-2000 символов.
6. Не пиши никаких пояснений до или после JSON — верни строго JSON по схеме.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    return JSON.parse(text);
  } catch (error) {
    console.error('❌ Ошибка генерации поста через Gemini:', error.message);
    return mockGenerateFromPrompt(userPrompt, withChannelStyle);
  }
}

function mockGenerateFromPrompt(userPrompt, withChannelStyle) {
  const shortPrompt = userPrompt.length > 60 ? userPrompt.slice(0, 57) + '...' : userPrompt;
  const styleNote = withChannelStyle
    ? '*Аналитика отрасли | Канал «Чёрный Синтез»*\n\n'
    : '';

  const content = `${styleNote}_(Демо-режим: реальная генерация недоступна — нет GEMINI_API_KEY или включён DEMO_MODE)_

📝 **Запрос редактора:** ${userPrompt}

В продакшене на этом месте окажется полноценный экспертный пост, написанный Gemini под заданную тему с техническими подробностями, региональным контекстом и форматированием в стиле канала.

#ЧерныйСинтез #демо #ИИ_генерация`;

  return { title: shortPrompt, content };
}

module.exports = {
  generateArticle,
  analyzeSentiment,
  generatePostFromPrompt
};
