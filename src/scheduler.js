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

// Сбор новостей и генерация постов. Возвращает диагностический объект:
// { createdCount, totalArticles, skippedDuplicates, errors, autoPost }
async function runNewsAggregation() {
  console.log('🚀 Агрегатор: Старт сбора новостей...');

  const diag = {
    createdCount: 0,
    totalArticles: 0,
    skippedDuplicates: 0,
    errors: [],
    autoPost: false,
    sources: []
  };

  // 1. Получаем свежие новости
  let latestArticles;
  try {
    latestArticles = await news.fetchLatestNews();
  } catch (e) {
    diag.errors.push(`fetchLatestNews: ${e.message}`);
    console.error('❌ Агрегатор: ошибка получения новостей', e.message);
    return diag;
  }

  diag.totalArticles = (latestArticles || []).length;
  if (!latestArticles || latestArticles.length === 0) {
    diag.errors.push('Не нашли ни одной новости в источниках (Google News + neftegaz.ru)');
    console.log('🚀 Агрегатор: Новостей не найдено.');
    return diag;
  }

  // 2. Получаем настройки автопостинга
  const autoPostSetting = await db.get("SELECT value FROM settings WHERE key = 'auto_post'");
  diag.autoPost = autoPostSetting ? autoPostSetting.value === 'true' : false;
  const autoPost = diag.autoPost;

  // Проверяем каждую новость
  for (const article of latestArticles) {
    // Не создаем больше 2 постов за один запуск планировщика, чтобы не спамить
    if (diag.createdCount >= 2) break;

    try {
      const existing = await db.get(
        'SELECT id FROM posts WHERE title = ? OR content LIKE ?',
        [article.title, `%${article.link}%`]
      );

      if (existing) {
        diag.skippedDuplicates++;
        continue;
      }

      console.log(`📝 Агрегатор: Обнаружена новая новость: "${article.title}". Генерация статьи через Gemini...`);

      const generated = await gemini.generateArticle(article);

      if (!generated || !generated.content) {
        diag.errors.push(`Gemini вернул пустой результат для "${article.title}"`);
        console.error('❌ Агрегатор: ИИ вернул пустой результат.');
        continue;
      }

      const status = autoPost ? 'scheduled' : 'draft';
      const scheduledAt = autoPost ? new Date(Date.now() + 10 * 60000).toISOString() : null;

      const insertQuery = `
        INSERT INTO posts (title, content, media_url, status, scheduled_at, type)
        VALUES (?, ?, ?, ?, ?, 'organic')
      `;

      let mediaUrl = null;
      try {
        const searchQuery = generated.imageKeywords || article.title;
        mediaUrl = await images.findImageForTopic(searchQuery);
      } catch (e) {
        console.warn('Поиск картинки не удался:', e.message);
      }

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

      diag.createdCount++;
      console.log(`✅ Агрегатор: Создан пост #${result.lastID} со статусом "${status}"`);

      if (autoPost) {
        const postData = await db.get('SELECT * FROM posts WHERE id = ?', [result.lastID]);
        try {
          await bot.publishPost(postData);
        } catch (pubErr) {
          diag.errors.push(`Публикация поста #${result.lastID}: ${pubErr.message}`);
        }
      }

    } catch (e) {
      diag.errors.push(`Обработка "${article.title}": ${e.message}`);
      console.error(`❌ Агрегатор: Ошибка обработки новости "${article.title}":`, e.message);
    }
  }

  // Опубликуем также запланированные рекламные посты, время которых пришло
  await publishScheduledPosts();

  // Запомним время последнего запуска (для UI)
  try {
    const ts = new Date().toISOString();
    await db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = ?`,
      ['last_cron_run', ts, ts]
    );
  } catch (_) {}

  return diag;
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
