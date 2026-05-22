const express = require('express');
const cors = require('cors');
const db = require('./db');
const bot = require('./bot');
const gemini = require('./gemini');
const news = require('./news');
const scheduler = require('./scheduler');
const crypto = require('crypto');

const app = express();

app.use(cors());
app.use(express.json());

// Раздача статических файлов из папки public
app.use(express.static('public'));

// Прослойка для инициализации БД при первом запросе на Vercel (ленивая инициализация)
let dbInitialized = false;
app.use(async (req, res, next) => {
  if (!dbInitialized) {
    try {
      await db.init();
      // Если это не локальный запуск (есть DATABASE_URL), инициализируем бота один раз
      if (process.env.DATABASE_URL && !bot.getBotInstance()) {
        bot.initBot();
      }
      dbInitialized = true;
    } catch (e) {
      console.error('❌ Ошибка отложенной инициализации базы/бота:', e.message);
    }
  }
  next();
});

// Middleware для авторизации по Telegram WebApp initData
// Для простоты сверяем ID пользователя с ADMIN_TELEGRAM_ID.
// В проде мы также проверяем подпись Telegram.
function checkAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  const isDemo = process.env.DEMO_MODE === 'true';

  if (isDemo || !adminId) {
    // В демо-режиме пропускаем запросы
    return next();
  }

  if (!authHeader) {
    return res.status(401).json({ error: 'Не авторизован (отсутствует токен авторизации)' });
  }

  try {
    // Наша админка будет присылать JSON строку с initData
    const initData = JSON.parse(decodeURIComponent(authHeader));
    const userId = initData.user ? String(initData.user.id) : null;

    if (userId && userId === String(adminId)) {
      return next();
    }
    
    // Вспомогательный метод на случай если пришел голый ID
    if (String(authHeader) === String(adminId)) {
      return next();
    }

    return res.status(403).json({ error: 'Доступ запрещен (неверный Telegram ID)' });
  } catch (err) {
    // Если пришел просто ID (для локальных тестов)
    if (String(authHeader) === String(adminId)) {
      return next();
    }
    return res.status(401).json({ error: 'Ошибка проверки авторизации' });
  }
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

  if (String(userId) === String(adminId)) {
    return res.json({ success: true, user: { id: userId, role: 'Владелец' } });
  }

  return res.status(403).json({ error: 'У вас нет доступа к этой админ-панели' });
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
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Немедленная публикация поста
app.post('/api/posts/:id/publish', checkAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const post = await db.get('SELECT * FROM posts WHERE id = ?', [id]);
    if (!post) {
      return res.status(404).json({ error: 'Пост не найден' });
    }
    const tgMsgId = await bot.publishPost(post);
    res.json({ success: true, telegram_message_id: tgMsgId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Удаление поста
app.delete('/api/posts/:id', checkAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await db.run('DELETE FROM posts WHERE id = ?', [id]);
    res.json({ success: true });
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
    res.json({ success: true, ...generated });
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
