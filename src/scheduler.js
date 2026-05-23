const cron = require('node-cron');
const db = require('./db');
const news = require('./news');
const gemini = require('./gemini');
const bot = require('./bot');
const images = require('./images');

// Запуск планировщика (для локального режима)
function startScheduler() {
  console.log('⏰ Планировщик: Локальный планировщик задач запущен.');

  // Каждые 6 часов собираем новости и создаем черновики постов
  cron.schedule('0 */6 * * *', async () => {
    console.log('⏰ Планировщик: Запуск автоматического сбора новостей...');
    try {
      await runNewsAggregation();
    } catch (err) {
      console.error('⏰ Планировщик: Ошибка сбора новостей:', err.message);
    }
  });

  // Каждый час обновляем статистику подписчиков в БД
  cron.schedule('0 * * * *', async () => {
    console.log('⏰ Планировщик: Обновление статистики подписчиков...');
    try {
      await updateDailyStats();
    } catch (err) {
      console.error('⏰ Планировщик: Ошибка обновления статистики:', err.message);
    }
  });
}

// Сбор новостей и генерация постов
async function runNewsAggregation() {
  console.log('🚀 Агрегатор: Старт сбора новостей...');
  
  // 1. Получаем свежие новости
  const latestArticles = await news.fetchLatestNews();
  if (!latestArticles || latestArticles.length === 0) {
    console.log('🚀 Агрегатор: Новостей не найдено.');
    return 0;
  }

  // 2. Получаем настройки автопостинга
  const autoPostSetting = await db.get("SELECT value FROM settings WHERE key = 'auto_post'");
  const autoPost = autoPostSetting ? autoPostSetting.value === 'true' : false;

  let newPostsCreated = 0;

  // Проверяем каждую новость
  for (const article of latestArticles) {
    // Не создаем больше 2 постов за один запуск планировщика, чтобы не спамить
    if (newPostsCreated >= 2) break;

    try {
      // Проверяем, не обрабатывали ли мы уже эту новость
      // Проверка по заголовку новости (или ссылке) в БД
      const existing = await db.get(
        'SELECT id FROM posts WHERE title = ? OR content LIKE ?', 
        [article.title, `%${article.link}%`]
      );

      if (existing) {
        continue; // Уже обрабатывали
      }

      console.log(`📝 Агрегатор: Обнаружена новая новость: "${article.title}". Генерация статьи через Gemini...`);
      
      // Генерируем профессиональную статью с помощью ИИ
      const generated = await gemini.generateArticle(article);
      
      if (!generated || !generated.content) {
        console.error('❌ Агрегатор: ИИ вернул пустой результат.');
        continue;
      }

      // Сохраняем пост в БД
      const status = autoPost ? 'scheduled' : 'draft';
      const scheduledAt = autoPost ? new Date(Date.now() + 10 * 60000).toISOString() : null; // опубликовать через 10 минут, если автопостинг

      const insertQuery = `
        INSERT INTO posts (title, content, media_url, status, scheduled_at, type)
        VALUES (?, ?, ?, ?, ?, 'organic')
      `;
      // Ищем релевантную картинку в Wikipedia по ключевикам от Gemini (или по заголовку).
      let mediaUrl = null;
      try {
        const searchQuery = generated.imageKeywords || article.title;
        mediaUrl = await images.findImageForTopic(searchQuery);
      } catch (e) {
        console.warn('Поиск картинки не удался:', e.message);
      }
      // publishPost при null упадёт на брендированный logo.png через WEBAPP_URL.

      const sourceDomain = (() => {
        try { return new URL(article.link).hostname.replace(/^www\./, ''); }
        catch { return 'источник'; }
      })();
      const sourceLink = `\n\n🔗 [${sourceDomain}](${article.link})`;

      const result = await db.run(insertQuery, [
        generated.title,
        generated.content + sourceLink,
        mediaUrl,
        status,
        scheduledAt
      ]);

      newPostsCreated++;
      console.log(`✅ Агрегатор: Создан пост #${result.lastID} со статусом "${status}"`);

      // Если включен автопостинг и пост запланирован сразу, опубликуем его
      if (autoPost) {
        const postData = await db.get('SELECT * FROM posts WHERE id = ?', [result.lastID]);
        await bot.publishPost(postData);
      }

    } catch (e) {
      console.error(`❌ Агрегатор: Ошибка обработки новости "${article.title}":`, e.message);
    }
  }

  // Опубликуем также запланированные рекламные посты, время которых пришло
  await publishScheduledPosts();

  return newPostsCreated;
}

// Публикация запланированных постов (если время пришло)
async function publishScheduledPosts() {
  const now = new Date().toISOString();
  try {
    const pendingPosts = await db.query(
      "SELECT * FROM posts WHERE status = 'scheduled' AND (scheduled_at <= ? OR scheduled_at IS NULL)", 
      [now]
    );

    for (const post of pendingPosts) {
      console.log(`⏰ Планировщик: Пришло время публикации поста #${post.id} ("${post.title}")...`);
      await bot.publishPost(post);
    }
  } catch (err) {
    console.error('❌ Ошибка автопубликации запланированных постов:', err.message);
  }
}

// Сбор статистики подписчиков
async function updateDailyStats() {
  const today = new Date().toISOString().split('T')[0];
  const count = await bot.getSubscriberCount();
  
  console.log(`📊 Статистика: Замер подписчиков на сегодня (${today}): ${count}`);

  try {
    // Вставляем или обновляем запись за сегодня
    await db.run(`
      INSERT INTO stats (date, subscribers_count)
      VALUES (?, ?)
      ON CONFLICT(date) DO UPDATE SET subscribers_count = ?
    `, [today, count, count]);
  } catch (err) {
    console.error('❌ Ошибка записи статистики в БД:', err.message);
  }
}

module.exports = {
  startScheduler,
  runNewsAggregation,
  updateDailyStats,
  publishScheduledPosts
};
