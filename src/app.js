const express = require('express');
const cors = require('cors');
const db = require('./db');
const bot = require('./bot');
const gemini = require('./gemini');
const news = require('./news');
const scheduler = require('./scheduler');
const images = require('./images');
const kolesa = require('./kolesa');
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
    // Перед чтением — берём актуальное число подписчиков напрямую из Telegram
    // и записываем его в сегодняшнюю строку stats. Без этого карточка
    // "Подписчики" застаивалась до следующего cron'а (раз в сутки на Hobby Vercel).
    let subscribersWarning = null;
    try {
      const botInstance = bot.getBotInstance();
      if (botInstance && process.env.TELEGRAM_CHANNEL_ID) {
        const realCount = await botInstance.getChatMemberCount(process.env.TELEGRAM_CHANNEL_ID);
        if (typeof realCount === 'number') {
          const today = new Date().toISOString().split('T')[0];
          await db.run(
            `INSERT INTO stats (date, subscribers_count) VALUES (?, ?)
             ON CONFLICT(date) DO UPDATE SET subscribers_count = ?`,
            [today, realCount, realCount]
          );
          console.log(`📊 /api/stats: подписчиков сейчас в канале = ${realCount}`);
        }
      } else if (!botInstance) {
        subscribersWarning = 'Бот не инициализирован — счётчик подписчиков не обновлён';
      }
    } catch (e) {
      subscribersWarning = `Telegram API: ${e.message}`;
      console.warn('⚠️ getChatMemberCount failed:', e.message);
    }

    // Последние 7 записей статистики подписчиков
    const statsData = await db.query('SELECT * FROM stats ORDER BY date DESC LIMIT 7');

    // Реальные счётчики прямо из таблиц — всегда актуальны.
    const postsCount = await db.get("SELECT COUNT(*) as count FROM posts WHERE type = 'car_listing' AND status = 'published'");
    const pendingListings = await db.get("SELECT COUNT(*) as count FROM posts WHERE type = 'car_listing' AND status = 'draft'");
    const ordersCount = await db.get("SELECT COUNT(*) as count FROM orders WHERE status = 'completed' OR status = 'paid'");
    const commentsCount = await db.get('SELECT COUNT(*) as count FROM comments');

    const sentiments = await db.query(
      'SELECT sentiment, COUNT(*) as count FROM comments GROUP BY sentiment'
    );
    const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
    sentiments.forEach(s => {
      sentimentCounts[s.sentiment] = parseInt(s.count) || 0;
    });

    // active_engagement по дням — пересчитываем ВСЕГДА из comments напрямую,
    // чтобы удалённые комменты убирались из стат-графика, а не оставались "залипшими".
    // (Старая логика просто инкрементила stats.active_engagement при INSERT в comments
    // и не уменьшала при DELETE.)
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const recentComments = await db.query(
      'SELECT created_at FROM comments WHERE created_at >= ?',
      [sevenDaysAgo]
    );
    const engagementByDay = {};
    for (const c of recentComments) {
      const day = String(c.created_at || '').slice(0, 10); // YYYY-MM-DD
      if (day) engagementByDay[day] = (engagementByDay[day] || 0) + 1;
    }
    statsData.forEach(stat => {
      const day = String(stat.date || '').slice(0, 10);
      stat.active_engagement = engagementByDay[day] || 0;
    });

    const totalViews = statsData.reduce((sum, s) => sum + (s.total_views || 0), 0);
    const totalEngagement = statsData.reduce((sum, s) => sum + (s.active_engagement || 0), 0);

    res.json({
      history: statsData.reverse(),
      summary: {
        totalPosts: postsCount ? postsCount.count : 0,
        pendingListings: pendingListings ? pendingListings.count : 0,
        completedOrders: ordersCount ? ordersCount.count : 0,
        totalComments: commentsCount ? commentsCount.count : 0,
        sentiments: sentimentCounts,
        activeEngagement: totalEngagement
      },
      warning: subscribersWarning || undefined
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
    let comments = await db.query(`
      SELECT c.*, p.title as post_title
      FROM comments c
      LEFT JOIN posts p ON c.post_id = p.id
      ORDER BY c.id DESC LIMIT 50
    `);

    // Auto-sync с Telegram: проверяем что каждый коммент ещё существует в группе обсуждения.
    // Если подписчик удалил свой коммент — Telegram API не присылает событие, поэтому
    // мы периодически "пингуем" forwardMessage'ом (с моментальным удалением форварда).
    // Параметр ?sync=false позволяет отключить, если будет тормозить.
    let removedCount = 0;
    if (req.query.sync !== 'false' && process.env.TELEGRAM_BOT_TOKEN && process.env.ADMIN_TELEGRAM_ID) {
      try {
        const sync = await probeCommentsExistence(comments);
        if (sync.removedIds.length > 0) {
          const placeholders = sync.removedIds.map(() => '?').join(',');
          await db.run(`DELETE FROM comments WHERE id IN (${placeholders})`, sync.removedIds);
          removedCount = sync.removedIds.length;
          comments = comments.filter(c => !sync.removedIds.includes(c.id));
          console.log(`🔄 Sync: удалено ${removedCount} комментов, которых уже нет в группе обсуждения`);
        }
      } catch (e) {
        console.warn('⚠️ Auto-sync комментов не удался (не критично):', e.message);
      }
    }

    res.json({ comments, removedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Проверяет существование комментариев в группе обсуждения через forwardMessage в личку админу
// с моментальным удалением форварда. Возвращает {removedIds: [...]} — те, что больше не существуют.
async function probeCommentsExistence(comments) {
  const botInstance = bot.getBotInstance();
  if (!botInstance) return { removedIds: [] };
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  if (!adminId) return { removedIds: [] };

  // Узнаём id группы обсуждения через getChat → linked_chat_id канала.
  let groupChatId;
  try {
    const chat = await botInstance.getChat(process.env.TELEGRAM_CHANNEL_ID);
    groupChatId = chat && chat.linked_chat_id;
  } catch (e) {
    console.warn('probeComments: не удалось получить linked_chat_id:', e.message);
    return { removedIds: [] };
  }
  if (!groupChatId) return { removedIds: [] };

  const CONCURRENCY = 5;
  const removedIds = [];

  for (let i = 0; i < comments.length; i += CONCURRENCY) {
    const batch = comments.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (c) => {
      if (!c.telegram_message_id) return; // нечего проверять
      try {
        const fwd = await botInstance.forwardMessage(adminId, groupChatId, c.telegram_message_id, {
          disable_notification: true
        });
        if (fwd && fwd.message_id) {
          // Сразу убираем форвард, чтобы не засорять админскую личку
          botInstance.deleteMessage(adminId, fwd.message_id).catch(() => {});
        }
      } catch (e) {
        // Telegram использует разные формулировки для "сообщения нет".
        if (/message to forward not found|message_id_invalid|message id is invalid|message to copy not found|chat not found|MESSAGE_ID_INVALID/i.test(e.message)) {
          removedIds.push(c.id);
        }
        // Другие ошибки (rate limit, network) игнорируем — не удаляем легитимные комменты.
      }
    }));
  }

  return { removedIds };
}

// Удаление комментария: убираем из БД и пытаемся удалить из группы обсуждения.
// Telegram Bot API не присылает события об удалении подписчиком собственного коммента —
// поэтому эта ручка нужна, чтобы админ мог синхронизировать состояние вручную.
app.delete('/api/comments/:id', checkAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const comment = await db.get('SELECT * FROM comments WHERE id = ?', [id]);
    if (!comment) return res.status(404).json({ error: 'Комментарий не найден в БД' });

    let tgWarning = null;
    if (comment.telegram_message_id) {
      // Найдём group_chat_id из канала через getChat (linked_chat_id).
      const botInstance = bot.getBotInstance();
      if (botInstance) {
        try {
          const chat = await botInstance.getChat(process.env.TELEGRAM_CHANNEL_ID);
          if (chat && chat.linked_chat_id) {
            await botInstance.deleteMessage(chat.linked_chat_id, comment.telegram_message_id);
          } else {
            tgWarning = 'У канала не привязана группа обсуждения — удалить из Telegram нечего';
          }
        } catch (e) {
          // Не валим всё — комментарий мог уже быть удалён пользователем.
          if (/message to delete not found|message can't be deleted/i.test(e.message)) {
            tgWarning = 'В Telegram сообщения уже нет (возможно, удалено автором)';
          } else {
            tgWarning = `Не удалось удалить из Telegram: ${e.message}`;
          }
        }
      }
    }

    await db.run('DELETE FROM comments WHERE id = ?', [id]);
    res.json({ success: true, warning: tgWarning || undefined });
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

// 7a-bis. Доработка существующего поста через ИИ (для модалки редактирования).
// Не пишет в БД — возвращает новые {title, content}, фронт подставляет в форму.
app.post('/api/posts/improve', checkAuth, async (req, res) => {
  const { title, content, instruction } = req.body || {};
  if (!instruction || typeof instruction !== 'string' || instruction.trim().length < 3) {
    return res.status(400).json({ error: 'Инструкция обязательна (минимум 3 символа)' });
  }
  if (!content || typeof content !== 'string' || content.trim().length < 5) {
    return res.status(400).json({ error: 'Содержимое поста пустое, нечего дорабатывать' });
  }
  try {
    const improved = await gemini.improvePost({
      title: title || '',
      content: content || '',
      instruction: instruction.trim()
    });
    const response = { success: true, title: improved.title, content: improved.content };
    if (improved._mock) {
      response.warning = improved._reason === 'no_api_key'
        ? 'GEMINI_API_KEY не задан — вернулся mock без реальной доработки.'
        : improved._reason === 'demo_mode_on'
          ? 'DEMO_MODE=true — вернулся mock.'
          : `Gemini API ошибка: ${improved._error || 'unknown'}`;
    }
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7a. Генерация поста по произвольному промпту (на лету, без сохранения)
app.post('/api/posts/generate', checkAuth, async (req, res) => {
  const { prompt, withChannelStyle, withWebSearch } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 5) {
    return res.status(400).json({ error: 'Промпт обязателен и должен содержать минимум 5 символов' });
  }
  try {
    const generated = await gemini.generatePostFromPrompt(prompt.trim(), {
      withChannelStyle: withChannelStyle !== false,
      withWebSearch: withWebSearch !== false
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
      image_keywords: generated.imageKeywords || null,
      sources: generated.sources || [],
      search_used: !!generated._searchUsed
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

// 8. Реклама в канале: закрепить компактную плашку с кнопкой "Заказать рекламу".
app.post('/api/channel/pin-ad', checkAuth, async (req, res) => {
  try {
    const result = await bot.pinAdAnnouncement();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ pin-ad failed:', err.message);
    // Подбираем подсказку под конкретную ошибку, а не одну на все случаи.
    let hint = '';
    const m = err.message;
    if (/BUTTON_TYPE_INVALID/i.test(m)) {
      hint = 'Сервер ещё не задеплоил фикс кнопок (web_app → URL deeplink). Подожди 1-2 мин после последнего push, либо сделай Redeploy в Vercel.';
    } else if (/not enough rights to pin|need administrator rights|CHAT_ADMIN_REQUIRED/i.test(m)) {
      hint = 'Бот должен быть админом канала с правом "Закрепление сообщений". Проверь Telegram → канал → Управление → Администраторы.';
    } else if (/chat not found|bot is not a member/i.test(m)) {
      hint = 'Канал не найден или бот не админ. Проверь TELEGRAM_CHANNEL_ID в Vercel env vars и что бот добавлен в канал.';
    } else if (/Unauthorized/i.test(m)) {
      hint = 'Неверный TELEGRAM_BOT_TOKEN. Сбрось через @BotFather → /revoke и обнови в Vercel env vars.';
    }
    res.status(500).json({ error: m, hint });
  }
});

// 8b. Открепить рекламную плашку.
app.post('/api/channel/unpin-ad', checkAuth, async (req, res) => {
  try {
    const result = await bot.unpinAdAnnouncement();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Ручной вызов сборщика новостей (для тестирования)
app.post('/api/cron-trigger', checkAuth, async (req, res) => {
  console.log('⚡ Ручной запуск агрегации новостей из админки...');
  try {
    const diag = await scheduler.runNewsAggregation();
    // Бэк может вернуть либо число (старый формат), либо объект (новый).
    if (typeof diag === 'number') {
      res.json({ success: true, createdCount: diag });
    } else {
      res.json({ success: true, ...diag });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
//  АВТО ОБМЕН КАЗАХСТАН — заявки на объявления о машинах
// =========================================================================

// Публичная подача заявки. Без авторизации, чтобы любой мог подать через форму.
// Honeypot против ботов. Сохраняет как draft, status='draft', type='car_listing'.
app.post('/api/listings/submit', async (req, res) => {
  const b = req.body || {};
  if (b.honeypot) return res.json({ success: true });

  const car = {
    brand: (b.brand || '').trim(),
    model: (b.model || '').trim(),
    year: parseInt(b.year, 10) || null,
    mileage_km: parseInt(b.mileage_km, 10) || null,
    body: (b.body || '').trim(),
    transmission: (b.transmission || '').trim(),
    drivetrain: (b.drivetrain || '').trim(),
    color: (b.color || '').trim(),
    condition: (b.condition || '').trim(),
    city: (b.city || '').trim(),
    photos: Array.isArray(b.photos) ? b.photos.filter(u => typeof u === 'string' && u.startsWith('http')).slice(0, 6) : [],
    wants: {
      brand: (b.wants_brand || '').trim(),
      model: (b.wants_model || '').trim(),
      year_from: parseInt(b.wants_year_from, 10) || null,
      doplata_kzt: parseInt(b.wants_doplata_kzt, 10) || 0,
      doplata_direction: (b.wants_doplata_direction || '').trim()
    },
    owner: {
      telegram_id: b.telegram_user_id || null,
      username: (b.telegram_username || '').replace(/^@/, ''),
      first_name: (b.telegram_first_name || '').trim(),
      contact: (b.contact || '').trim()
    },
    vin: (b.vin || '').trim().toUpperCase(),
    price_evaluation: {
      owner_asks_kzt: parseInt(b.owner_asks_kzt, 10) || null
    },
    submitted_at: new Date().toISOString()
  };

  if (!car.brand || !car.model || !car.year) {
    return res.status(400).json({ error: 'Укажите минимум марку, модель и год.' });
  }
  if (!car.owner.contact && !car.owner.username) {
    return res.status(400).json({ error: 'Укажите контакт для связи (телеграм или телефон).' });
  }

  try {
    const title = `[Заявка] ${car.brand} ${car.model} ${car.year} → ${car.wants.brand || '?'}`;
    const summary = `${car.brand} ${car.model}, ${car.year}, ${car.mileage_km || '?'} км, ${car.city}\n` +
      `Хочет: ${car.wants.brand} ${car.wants.model || ''} ${car.wants.year_from ? car.wants.year_from + '+' : ''}`;

    const ins = await db.run(
      `INSERT INTO posts (title, content, media_url, status, type, car_data)
       VALUES (?, ?, ?, 'draft', 'car_listing', ?)`,
      [title, summary, car.photos[0] || null, JSON.stringify(car)]
    );

    // Уведомление админу в Telegram о новой заявке
    try {
      const botInstance = bot.getBotInstance();
      const adminId = process.env.ADMIN_TELEGRAM_ID;
      if (botInstance && adminId) {
        const msg = `🚗 <b>Новая заявка на обмен</b>\n\n` +
          `<b>${car.brand} ${car.model}</b>, ${car.year}\n` +
          `Пробег: ${car.mileage_km || '?'} км\n` +
          `Город: ${car.city}\n\n` +
          `🔄 Хочет обменять на: ${car.wants.brand} ${car.wants.model || ''}\n` +
          `Доплата: ${car.wants.doplata_kzt ? car.wants.doplata_kzt.toLocaleString('ru') + ' ₸' : 'нет'}\n\n` +
          `Контакт: ${car.owner.contact || ('@' + car.owner.username)}\n\n` +
          `Открой админку → Объявления → одобри или отклони.`;
        botInstance.sendMessage(adminId, msg, { parse_mode: 'HTML' }).catch(() => {});
      }
    } catch (_) {}

    res.json({ success: true, id: ins.lastID });
  } catch (err) {
    console.error('❌ submit listing failed:', err.message);
    res.status(500).json({ error: 'Не удалось сохранить заявку. Попробуйте позже.' });
  }
});

// Список объявлений для админки (с фильтром по статусу)
app.get('/api/listings', checkAuth, async (req, res) => {
  const { status } = req.query;
  try {
    let rows;
    if (status) {
      rows = await db.query(
        "SELECT * FROM posts WHERE type = 'car_listing' AND status = ? ORDER BY id DESC LIMIT 100",
        [status]
      );
    } else {
      rows = await db.query(
        "SELECT * FROM posts WHERE type = 'car_listing' ORDER BY id DESC LIMIT 100"
      );
    }
    res.json(rows.map(r => ({ ...r, car_data: tryParseJson(r.car_data) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function tryParseJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

// Импорт объявления по ссылке kolesa.kz (admin). Заходит на страницу, тащит
// характеристики + фото + цену, нормализует через Gemini, создаёт draft-заявку.
app.post('/api/listings/from-url', checkAuth, async (req, res) => {
  const { url, exchangeWish } = req.body || {};
  if (!url || !kolesa.isKolesaUrl(url)) {
    return res.status(400).json({ error: 'Дай корректную ссылку kolesa.kz/a/show/...' });
  }
  try {
    const car = await kolesa.importFromKolesa(url, { exchangeWish: exchangeWish || '' });
    const title = `[Импорт] ${car.brand} ${car.model} ${car.year || ''}`.trim();
    const summary = `${car.brand} ${car.model}, ${car.year || '?'}, ${car.mileage_km || '?'} км, ${car.city || ''}\nИсточник: ${url}`;
    const ins = await db.run(
      `INSERT INTO posts (title, content, media_url, status, type, car_data)
       VALUES (?, ?, ?, 'draft', 'car_listing', ?)`,
      [title, summary, car.photos[0] || null, JSON.stringify(car)]
    );
    res.json({ success: true, id: ins.lastID, car, photos_count: car.photos.length });
  } catch (err) {
    console.error('❌ import from kolesa failed:', err.message);
    res.status(502).json({ error: err.message, hint: 'Если kolesa блокирует — заполни заявку вручную через форму.' });
  }
});

// Одобрение заявки: вызывает Gemini оценку + публикует в канал.
// Тяжёлый: 5-15 сек (поиск цен через Google + генерация описания + sendMessage в Telegram).
app.post('/api/listings/:id/approve', checkAuth, async (req, res) => {
  const { id } = req.params;
  const postId = parseInt(id, 10);
  if (!Number.isInteger(postId) || postId <= 0) {
    return res.status(400).json({ error: 'Невалидный id' });
  }
  try {
    const row = await db.get("SELECT * FROM posts WHERE id = ? AND type = 'car_listing'", [postId]);
    if (!row) return res.status(404).json({ error: 'Заявка не найдена' });
    const car = tryParseJson(row.car_data) || {};

    // 1. Gemini оценивает рыночную цену и пишет красивое описание
    const evaluation = await gemini.evaluateAndDescribeCar(car);

    // Сохраняем обогащённый car_data
    car.price_evaluation = evaluation.price_evaluation;
    car.ai_generated_at = new Date().toISOString();

    await db.run(
      'UPDATE posts SET title = ?, content = ?, car_data = ? WHERE id = ?',
      [evaluation.title, evaluation.content, JSON.stringify(car), postId]
    );

    // 2. Публикация в канал
    const refreshed = await db.get('SELECT * FROM posts WHERE id = ?', [postId]);
    const tgMsgId = await bot.publishPost(refreshed);

    res.json({
      success: true,
      telegram_message_id: tgMsgId,
      price_evaluation: evaluation.price_evaluation,
      mock: !!evaluation._mock
    });
  } catch (err) {
    console.error(`❌ approve listing #${id} failed:`, err.message);
    res.status(500).json({
      error: err.message,
      hint: 'Если про бота — проверь TELEGRAM_BOT_TOKEN. Если про Gemini — GEMINI_API_KEY.'
    });
  }
});

// Отклонение заявки
app.post('/api/listings/:id/reject', checkAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await db.run("UPDATE posts SET status = 'rejected' WHERE id = ? AND type = 'car_listing'", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = app;
