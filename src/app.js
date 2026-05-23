const express = require('express');
const cors = require('cors');
const db = require('./db');
const bot = require('./bot');
const gemini = require('./gemini');
const news = require('./news');
const scheduler = require('./scheduler');
const images = require('./images');
const crypto = require('crypto');

const app = express();

app.use(cors());
app.use(express.json());

// Раздача статических файлов из папки public
app.use(express.static('public'));

// Ленивая инициализация БД и бота на холодном старте serverless.
// БД и бот инициализируются независимо — если БД не поднялась, ошибка возвращается клиенту;
// инициализация бота вызывается при каждом запросе, но идемпотентна (initBot проверяет внутри).
let dbInitialized = false;
app.use(async (req, res, next) => {
  if (!dbInitialized) {
    try {
      await db.init();
      dbInitialized = true;
    } catch (e) {
      console.error('❌ DB init failed:', e.message);
      return res.status(500).json({
        error: 'Ошибка подключения к базе данных',
        details: e.message,
        hint: 'Проверь DATABASE_URL в Vercel env vars: должен быть Transaction pooler URI с портом 6543 и юзером postgres.<project_ref>.'
      });
    }
  }
  // Бот инициализируется при наличии DATABASE_URL (то есть на проде), если ещё не инициализирован.
  // Делается ПОСЛЕ try/catch БД — чтобы и в случае краша БД не блокировать, и чтобы не пытаться повторно.
  if (process.env.DATABASE_URL && !bot.getBotInstance()) {
    try { bot.initBot(); }
    catch (e) { console.error('❌ Bot init failed in middleware:', e.message); }
  }
  next();
});

// Middleware для авторизации по Telegram WebApp initData
// Принимает три формата Authorization-заголовка (все приходят URL-encoded):
//  1. Telegram initData (query-строка query_id=...&user={...}&auth_date=...&hash=...)
//  2. JSON-обёртка вида {"user":{"id":...}}
//  3. Голый числовой ID (для локальных тестов)
function checkAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  const isDemo = process.env.DEMO_MODE === 'true';

  if (isDemo || !adminId) {
    return next();
  }

  if (!authHeader) {
    return res.status(401).json({ error: 'Не авторизован (отсутствует токен авторизации)' });
  }

  const decoded = decodeURIComponent(authHeader);
  const adminIdStr = String(adminId);

  // 3. Голый ID
  if (decoded === adminIdStr) return next();

  // 1. Telegram initData (URL query string c полем user=<json>)
  if (decoded.includes('user=')) {
    try {
      const params = new URLSearchParams(decoded);
      const userJson = params.get('user');
      if (userJson) {
        const user = JSON.parse(userJson);
        if (user && String(user.id) === adminIdStr) return next();
      }
    } catch (_) { /* падаем дальше на JSON-обёртку */ }
  }

  // 2. JSON-обёртка
  try {
    const obj = JSON.parse(decoded);
    const userId = obj && obj.user ? String(obj.user.id) : null;
    if (userId && userId === adminIdStr) return next();
  } catch (_) { /* не JSON — игнорируем */ }

  return res.status(403).json({ error: 'Доступ запрещен (неверный Telegram ID)' });
}

// 1. Авторизация
app.post('/api/auth', (req, res) => {
  const { initDataRaw, userId } = req.body;
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  const isDemo = process.env.DEMO_MODE === 'true';

  console.log(`🔑 Получен запрос авторизации: ID ${userId}, админ в env: ${adminId}`);

  if (isDemo) {
    return res.json({ success: true, user: { username: 'demo_admin', role: 'Владелец (Демо)' } });
  }

  if (!adminId) {
    return res.json({ success: true, user: { username: 'test_admin', role: 'Владелец (Без токена)' } });
  }

  // Открыто вне контекста Telegram WebApp (нет initData, или userId — заглушка фронта).
  if (!initDataRaw || !userId || userId === 'demo_id') {
    return res.status(403).json({
      error: 'Админка должна открываться через Telegram',
      hint: 'Открой @black_synthesis_bot → команда /admin → нажми "Открыть админку". Прямая ссылка в браузере не сработает — там нет Telegram WebApp initData.'
    });
  }

  if (String(userId) === String(adminId)) {
    return res.json({ success: true, user: { id: userId, role: 'Владелец' } });
  }

  return res.status(403).json({
    error: 'У этого аккаунта нет доступа к админ-панели',
    hint: `Войди под Telegram-аккаунтом с ID ${adminId} (видишь свой ID через @userinfobot). Получено ID: ${userId}.`
  });
});

// 2. Получение общей статистики
app.get('/api/stats', checkAuth, async (req, res) => {
  try {
    // Получаем последние 7 записей статистики
    const statsData = await db.query('SELECT * FROM stats ORDER BY date DESC LIMIT 7');
    
    // Получаем общее количество постов, заказов и комментариев
    const postsCount = await db.get('SELECT COUNT(*) as count FROM posts');
    const ordersCount = await db.get("SELECT COUNT(*) as count FROM orders WHERE status = 'completed' OR status = 'paid'");
    const commentsCount = await db.get('SELECT COUNT(*) as count FROM comments');
    
    // Получаем тональность комментариев
    const sentiments = await db.query(
      'SELECT sentiment, COUNT(*) as count FROM comments GROUP BY sentiment'
    );
    
    // Форматируем тональность для удобства
    const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
    sentiments.forEach(s => {
      sentimentCounts[s.sentiment] = parseInt(s.count) || 0;
    });

    // Расчет вовлеченности (engagement rate)
    const totalViews = statsData.reduce((sum, s) => sum + (s.total_views || 0), 0);
    const totalEngagement = statsData.reduce((sum, s) => sum + (s.active_engagement || 0), 0);

    res.json({
      history: statsData.reverse(),
      summary: {
        totalPosts: postsCount ? postsCount.count : 0,
        completedOrders: ordersCount ? ordersCount.count : 0,
        totalComments: commentsCount ? commentsCount.count : 0,
        sentiments: sentimentCounts,
        activeEngagement: totalEngagement
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Получение постов (с фильтрацией по статусу)
app.get('/api/posts', checkAuth, async (req, res) => {
  const { status } = req.query;
  try {
    let posts;
    if (status) {
      posts = await db.query('SELECT * FROM posts WHERE status = ? ORDER BY id DESC', [status]);
    } else {
      posts = await db.query('SELECT * FROM posts ORDER BY id DESC');
    }
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Создание поста вручную (или рекламного)
app.post('/api/posts', checkAuth, async (req, res) => {
  const { title, content, media_url, status, scheduled_at, type } = req.body;
  try {
    const queryStr = `
      INSERT INTO posts (title, content, media_url, status, scheduled_at, type)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    const result = await db.run(queryStr, [
      title, 
      content, 
      media_url || null, 
      status || 'draft', 
      scheduled_at || null, 
      type || 'organic'
    ]);
    res.json({ success: true, id: result.lastID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Редактирование поста
app.put('/api/posts/:id', checkAuth, async (req, res) => {
  const { id } = req.params;
  const { title, content, media_url, status, scheduled_at } = req.body;
  try {
    await db.run(
      'UPDATE posts SET title = ?, content = ?, media_url = ?, status = ?, scheduled_at = ? WHERE id = ?',
      [title, content, media_url || null, status, scheduled_at || null, id]
    );

    // Если пост уже опубликован — синхронизируем правки с каналом.
    if (status === 'published') {
      const updated = await db.get('SELECT * FROM posts WHERE id = ?', [id]);
      if (updated && updated.telegram_message_id) {
        try {
          await bot.editPublishedPost(updated);
        } catch (e) {
          return res.json({
            success: true,
            warning: `БД обновлена, но не удалось изменить пост в канале: ${e.message}`
          });
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Немедленная публикация поста
app.post('/api/posts/:id/publish', checkAuth, async (req, res) => {
  const { id } = req.params;
  const postId = parseInt(id, 10);
  if (!Number.isInteger(postId) || postId <= 0) {
    return res.status(400).json({ error: `Невалидный id поста: "${id}". Возможно, пост не был сохранён перед публикацией.` });
  }
  try {
    const post = await db.get('SELECT * FROM posts WHERE id = ?', [postId]);
    if (!post) {
      return res.status(404).json({ error: 'Пост не найден' });
    }
    const tgMsgId = await bot.publishPost(post);
    res.json({ success: true, telegram_message_id: tgMsgId });
  } catch (err) {
    console.error(`❌ Publish post #${id} failed:`, err.message, err.stack);
    res.status(500).json({
      error: err.message || 'Не удалось опубликовать пост',
      hint: 'Если ошибка про бота — проверь TELEGRAM_BOT_TOKEN/TELEGRAM_CHANNEL_ID в Vercel env vars (Production). Если про Telegram API — убедись, что бот добавлен админом в канал с правом публикации.'
    });
  }
});

// Удаление поста
app.delete('/api/posts/:id', checkAuth, async (req, res) => {
  const { id } = req.params;
  try {
    // Если пост опубликован — сначала удаляем его из канала Telegram.
    const post = await db.get('SELECT * FROM posts WHERE id = ?', [id]);
    let channelWarning = null;
    if (post && post.status === 'published' && post.telegram_message_id) {
      try {
        await bot.deletePublishedPost(post);
      } catch (e) {
        channelWarning = e.message;
      }
    }

    await db.run('DELETE FROM posts WHERE id = ?', [id]);
    res.json({ success: true, warning: channelWarning || undefined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Управление заказами рекламы
app.get('/api/orders', checkAuth, async (req, res) => {
  try {
    const orders = await db.query(`
      SELECT o.*, p.title as post_title, p.status as post_status 
      FROM orders o 
      LEFT JOIN posts p ON o.post_id = p.id 
      ORDER BY o.id DESC
    `);
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders', checkAuth, async (req, res) => {
  const { advertiser_name, amount_paid, publish_date, title, content, media_url } = req.body;
  try {
    // 1. Создаем связанный рекламный пост
    const postQuery = `
      INSERT INTO posts (title, content, media_url, status, scheduled_at, type)
      VALUES (?, ?, ?, 'scheduled', ?, 'ad')
    `;
    const postResult = await db.run(postQuery, [title, content, media_url || null, publish_date]);
    const postId = postResult.lastID;

    // 2. Создаем сам заказ
    const orderQuery = `
      INSERT INTO orders (advertiser_name, amount_paid, publish_date, post_id, status)
      VALUES (?, ?, ?, ?, 'paid')
    `;
    const orderResult = await db.run(orderQuery, [advertiser_name, amount_paid, publish_date, postId]);

    res.json({ success: true, orderId: orderResult.lastID, postId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/orders/:id', checkAuth, async (req, res) => {
  const { id } = req.params;
  const { status, advertiser_name, amount_paid, publish_date } = req.body;
  try {
    const order = await db.get('SELECT post_id FROM orders WHERE id = ?', [id]);
    
    // Обновляем заказ
    await db.run(
      'UPDATE orders SET status = ?, advertiser_name = ?, amount_paid = ?, publish_date = ? WHERE id = ?',
      [status, advertiser_name, amount_paid, publish_date, id]
    );

    // Если у заказа есть связанный пост, обновим его дату планирования и статус
    if (order && order.post_id) {
      let postStatus = 'scheduled';
      if (status === 'completed') postStatus = 'published';
      if (status === 'cancelled') postStatus = 'draft';

      await db.run(
        'UPDATE posts SET scheduled_at = ?, status = ? WHERE id = ?',
        [publish_date, postStatus, order.post_id]
      );
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Комментарии
app.get('/api/comments', checkAuth, async (req, res) => {
  try {
    const comments = await db.query(`
      SELECT c.*, p.title as post_title 
      FROM comments c
      LEFT JOIN posts p ON c.post_id = p.id
      ORDER BY c.id DESC LIMIT 50
    `);
    res.json(comments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Настройки
app.get('/api/settings', checkAuth, async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM settings');
    const settingsMap = {};
    
    // Дефолтные настройки
    settingsMap['auto_post'] = 'false';
    settingsMap['channels_list'] = process.env.TELEGRAM_CHANNEL_ID || '';
    
    rows.forEach(r => {
      settingsMap[r.key] = r.value;
    });
    
    res.json(settingsMap);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', checkAuth, async (req, res) => {
  const settings = req.body; // Объект { key: value, ... }
  try {
    for (const [key, value] of Object.entries(settings)) {
      await db.run(`
        INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = ?
      `, [key, String(value), String(value)]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7b. Публичная форма заявки на рекламу (без авторизации)
// Создаёт заказ со статусом 'pending', админ потом одобряет и переводит в 'paid'.
app.post('/api/orders/request', async (req, res) => {
  const { advertiser_name, contact, ad_text, desired_date, budget, telegram_user_id, telegram_username, honeypot } = req.body || {};

  // Honeypot против ботов: поле должно быть пустым
  if (honeypot) return res.json({ success: true });

  if (!advertiser_name || !contact || !ad_text || ad_text.length < 20) {
    return res.status(400).json({ error: 'Заполните название компании, контакт и описание рекламы (минимум 20 символов).' });
  }
  if (ad_text.length > 5000) {
    return res.status(400).json({ error: 'Текст слишком длинный (макс 5000 символов).' });
  }

  try {
    const publishDate = desired_date ? new Date(desired_date).toISOString() : new Date(Date.now() + 86400000).toISOString();
    const amount = Number(budget) || 0;

    const meta = [
      `📞 Контакт: ${contact}`,
      telegram_user_id ? `Telegram: @${telegram_username || ''} (id ${telegram_user_id})` : '',
      desired_date ? `📅 Желаемая дата: ${publishDate}` : '',
      budget ? `💰 Бюджет: ${budget} ₸` : ''
    ].filter(Boolean).join('\n');

    // Создаём связанный пост-заглушку с заявкой
    const postRes = await db.run(
      `INSERT INTO posts (title, content, status, type, scheduled_at)
       VALUES (?, ?, 'draft', 'ad', ?)`,
      [`[Заявка] ${advertiser_name}`, `${meta}\n\n---\n${ad_text}`, publishDate]
    );

    const orderRes = await db.run(
      `INSERT INTO orders (advertiser_name, amount_paid, publish_date, post_id, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [advertiser_name, amount, publishDate, postRes.lastID]
    );

    // Уведомление админу в Telegram (если бот настроен)
    try {
      const botInstance = bot.getBotInstance();
      const adminId = process.env.ADMIN_TELEGRAM_ID;
      if (botInstance && adminId) {
        const notify = `📨 *Новая заявка на рекламу*\n\n` +
          `*Компания:* ${advertiser_name}\n` +
          `*Контакт:* ${contact}\n` +
          (budget ? `*Бюджет:* ${budget} ₸\n` : '') +
          (desired_date ? `*Желаемая дата:* ${new Date(publishDate).toLocaleString('ru-RU')}\n` : '') +
          `\n*Текст рекламы:*\n${ad_text.substring(0, 500)}${ad_text.length > 500 ? '...' : ''}\n\n` +
          `Открой админку для одобрения.`;
        botInstance.sendMessage(adminId, notify, { parse_mode: 'Markdown' }).catch(() => {
          botInstance.sendMessage(adminId, notify.replace(/[*_`\[\]]/g, ''));
        });
      }
    } catch (notifyErr) {
      console.warn('⚠️ Не удалось отправить уведомление админу:', notifyErr.message);
    }

    res.json({ success: true, orderId: orderRes.lastID });
  } catch (err) {
    console.error('❌ Ошибка создания заявки:', err.message);
    res.status(500).json({ error: 'Не удалось отправить заявку. Попробуйте позже.' });
  }
});

// 7c. Одобрение pending-заказа (admin only)
app.post('/api/orders/:id/approve', checkAuth, async (req, res) => {
  const { id } = req.params;
  const { amount_paid, publish_date } = req.body || {};
  try {
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [id]);
    if (!order) return res.status(404).json({ error: 'Заявка не найдена' });

    const newAmount = amount_paid !== undefined ? amount_paid : order.amount_paid;
    const newDate = publish_date || order.publish_date;

    await db.run(
      'UPDATE orders SET status = ?, amount_paid = ?, publish_date = ? WHERE id = ?',
      ['paid', newAmount, newDate, id]
    );
    if (order.post_id) {
      await db.run('UPDATE posts SET status = ?, scheduled_at = ? WHERE id = ?', ['scheduled', newDate, order.post_id]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7a. Генерация поста по произвольному промпту (на лету, без сохранения)
app.post('/api/posts/generate', checkAuth, async (req, res) => {
  const { prompt, withChannelStyle } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 5) {
    return res.status(400).json({ error: 'Промпт обязателен и должен содержать минимум 5 символов' });
  }
  try {
    const generated = await gemini.generatePostFromPrompt(prompt.trim(), {
      withChannelStyle: withChannelStyle !== false
    });

    // Параллельно с подготовкой ответа ищем картинку через Wikipedia.
    const searchQuery = generated.imageKeywords || generated.title || prompt;
    let mediaUrl = null;
    try {
      mediaUrl = await images.findImageForTopic(searchQuery);
    } catch (e) {
      console.warn('Image search failed:', e.message);
    }

    const response = {
      success: true,
      title: generated.title,
      content: generated.content,
      media_url: mediaUrl,
      image_keywords: generated.imageKeywords || null
    };
    if (generated._mock) {
      response.warning = (() => {
        switch (generated._reason) {
          case 'no_api_key': return 'GEMINI_API_KEY не задан в Vercel env vars (Production). Возвращён заглушечный mock.';
          case 'demo_mode_on': return 'DEMO_MODE=true в env vars. Реальный Gemini отключён, возвращён mock.';
          case 'gemini_api_error': return `Gemini API вернул ошибку: ${generated._error || 'unknown'}. Возможно, неверный ключ или превышена квота.`;
          default: return 'Получен mock-контент. Проверь GEMINI_API_KEY и DEMO_MODE в Vercel.';
        }
      })();
    }
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Ручной вызов сборщика новостей (для тестирования)
app.post('/api/cron-trigger', checkAuth, async (req, res) => {
  console.log('⚡ Ручной запуск агрегации новостей из админки...');
  try {
    const createdCount = await scheduler.runNewsAggregation();
    res.json({ success: true, createdCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = app;
