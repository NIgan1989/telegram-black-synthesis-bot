const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const gemini = require('./gemini');
const telegraph = require('./telegraph');
const dotenv = require('dotenv');

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const channelId = process.env.TELEGRAM_CHANNEL_ID;
const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;
const adminUsername = (process.env.ADMIN_TELEGRAM_USERNAME || '').replace(/^@/, '');
const webAppUrl = (process.env.WEBAPP_URL || '').replace(/\/$/, '');
const isDemo = process.env.DEMO_MODE === 'true' || !token || !channelId;

let bot = null;
let commandsRegistered = false;

function getChannelUrl() {
  if (!channelId) return '';
  if (String(channelId).startsWith('@')) return `https://t.me/${String(channelId).slice(1)}`;
  return '';
}

function getAdminContactUrl() {
  if (adminUsername) return `https://t.me/${adminUsername}`;
  if (adminTelegramId) return `tg://user?id=${adminTelegramId}`;
  return '';
}

// Главное меню — постоянная reply-клавиатура внизу чата.
// Где возможно, ставим web_app-кнопки чтобы открывать Mini App в один тап,
// иначе падаем на текстовые кнопки, которые транслируются в команды.
function getMainKeyboard(isAdmin) {
  const orderBtn = webAppUrl
    ? { text: '💼 Заказать рекламу', web_app: { url: `${webAppUrl}/order.html` } }
    : { text: '💼 Заказать рекламу' };

  const keyboard = [
    [{ text: '📢 О канале' }, orderBtn],
    [{ text: '❓ Помощь' }]
  ];

  if (isAdmin) {
    const adminBtn = webAppUrl
      ? { text: '🛠 Админка', web_app: { url: webAppUrl } }
      : { text: '🛠 Админка' };
    keyboard.splice(1, 0, [{ text: '📊 Статистика' }, adminBtn]);
  }

  return {
    keyboard,
    resize_keyboard: true,
    is_persistent: true
  };
}

// Маппинг текста кнопок reply-клавиатуры на команды — на случай fallback'а
// (когда WEBAPP_URL не задан и web_app-кнопок нет, тап шлёт текст).
const BUTTON_TO_COMMAND = {
  '📢 О канале': '/about',
  '💼 Заказать рекламу': '/order',
  '❓ Помощь': '/help',
  '📊 Статистика': '/stats',
  '🛠 Админка': '/admin'
};

// Инициализация бота
function initBot() {
  if (isDemo) {
    console.log('🤖 Telegram (Демо): Запуск бота в режиме имитации...');
    return null;
  }

  try {
    // В Vercel (продакшене) мы НЕ используем polling, а используем webhooks.
    // На локальном компьютере используем polling для удобства тестирования.
    const usePolling = !process.env.DATABASE_URL;

    if (usePolling) {
      console.log('🤖 Telegram: Запуск бота в режиме Long Polling (локально)...');
      bot = new TelegramBot(token, { polling: true });
    } else {
      console.log('🤖 Telegram: Запуск бота в режиме Webhook (для Vercel)...');
      bot = new TelegramBot(token, { polling: false });
    }

    bot.on('message', async (msg) => {
      try { await handleIncomingMessage(msg); }
      catch (e) { console.error('❌ message handler error:', e.message); }
    });

    bot.on('callback_query', async (cbq) => {
      try { await handleCallbackQuery(cbq); }
      catch (e) { console.error('❌ callback_query handler error:', e.message); }
    });

    // Реакции (смайлы) на посте канала — Telegram шлёт агрегированные счётчики
    // только если webhook подписан на 'message_reaction_count' в allowed_updates.
    bot.on('message_reaction_count', async (event) => {
      try { await handleReactionCount(event); }
      catch (e) { console.error('❌ reaction_count handler error:', e.message); }
    });

    bot.on('polling_error', (error) => {
      console.error('❌ Telegram Polling Error:', error.message);
    });

    registerBotCommands();
  } catch (error) {
    console.error('❌ Ошибка при инициализации Telegram Bot API:', error.message);
  }

  return bot;
}

async function registerBotCommands() {
  if (commandsRegistered || !bot) return;
  commandsRegistered = true;

  const publicCommands = [
    { command: 'start', description: 'Информация о канале' },
    { command: 'about', description: 'О канале «Чёрный Синтез»' },
    { command: 'order', description: 'Заказать рекламу' },
    { command: 'help', description: 'Список команд' }
  ];

  const adminCommands = [
    ...publicCommands,
    { command: 'admin', description: 'Открыть админ-панель' },
    { command: 'stats', description: 'Быстрая статистика канала' }
  ];

  try {
    await bot.setMyCommands(publicCommands);
    console.log('✅ Публичные команды бота зарегистрированы');
  } catch (e) {
    console.error('❌ Не удалось зарегистрировать публичные команды:', e.message);
  }

  // Для админа в личке регистрируем расширенный набор — будет видно в подсказках "/"
  if (adminTelegramId) {
    try {
      await bot.setMyCommands(adminCommands, {
        scope: { type: 'chat', chat_id: Number(adminTelegramId) }
      });
      console.log('✅ Расширенный набор команд зарегистрирован для админа');
    } catch (e) {
      console.error('❌ Не удалось зарегистрировать команды админа:', e.message);
    }
  }
}

// Маршрутизация входящих сообщений: команды, кнопки меню или комментарии
async function handleIncomingMessage(msg) {
  const text = msg.text || msg.caption;
  if (!text) return;

  // Текстовые кнопки reply-клавиатуры → перенаправляем на соответствующую команду
  if (BUTTON_TO_COMMAND[text]) {
    return handleCommand(msg, BUTTON_TO_COMMAND[text]);
  }

  if (text.startsWith('/')) {
    await handleCommand(msg, text);
    return;
  }

  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  if (!isGroup) return;

  // В группе обсуждения два сценария:
  // 1. msg.reply_to_message → это коммент подписчика → существующая логика трекинга
  // 2. msg.forward_from_chat === канал → это пересылка нашего поста, появившаяся автоматически.
  //    Если комменты в глобальных настройках выключены — удаляем эту пересылку,
  //    и кнопка "Комментировать" под постом канала пропадает.
  if (msg.reply_to_message) {
    await handleGroupComment(msg);
    return;
  }

  const fwdSrc = getForwardSource(msg);
  if (fwdSrc && isFromOurChannel(fwdSrc)) {
    await maybeDisableComments(msg);
  }
}

// Обработка обновления счётчиков реакций (смайлов) под каналом-постом.
// Telegram присылает суммарные счётчики каждой реакции при изменении.
async function handleReactionCount(event) {
  if (!event || !event.message_id || !event.chat) return;

  // Игнорируем реакции в чатах, кроме нашего канала.
  const fromOurChannel = String(event.chat.id) === String(channelId).replace('@', '') ||
    String(event.chat.id) === String(channelId) ||
    (event.chat.username && event.chat.username === String(channelId).replace('@', ''));
  if (!fromOurChannel) return;

  // Преобразуем массив реакций Telegram в карту {emoji: total_count}.
  const counts = {};
  for (const r of (event.reactions || [])) {
    if (!r || !r.type) continue;
    let key;
    if (r.type.type === 'emoji') key = r.type.emoji;
    else if (r.type.type === 'custom_emoji') key = `custom:${r.type.custom_emoji_id}`;
    else if (r.type.type === 'paid') key = '⭐';
    if (key) counts[key] = r.total_count;
  }

  try {
    const post = await db.get('SELECT id FROM posts WHERE telegram_message_id = ? LIMIT 1', [event.message_id]);
    if (!post) {
      console.log(`ℹ️ Реакция на неизвестный msg #${event.message_id} — пропускаем`);
      return;
    }
    await db.run('UPDATE posts SET reactions = ? WHERE id = ?', [JSON.stringify(counts), post.id]);
    const summary = Object.entries(counts).map(([e, n]) => `${e}×${n}`).join(' ') || '(пусто)';
    console.log(`👍 Реакции поста #${post.id}: ${summary}`);
  } catch (err) {
    console.error('❌ Ошибка обновления реакций в БД:', err.message);
  }
}

// Удаляет пересылку нашего поста из группы обсуждения, если комменты в настройках выключены.
async function maybeDisableComments(msg) {
  try {
    const setting = await db.get("SELECT value FROM settings WHERE key = 'comments_enabled'");
    const enabled = !setting || setting.value !== 'false';
    if (enabled) return; // По умолчанию включены — ничего не делаем

    await bot.deleteMessage(msg.chat.id, msg.message_id);
    console.log(`🚫 Комменты выключены глобально → удалена пересылка channel-поста #${msg.forward_from_message_id} из группы обсуждения`);
  } catch (e) {
    console.error('❌ Не удалось удалить пересылку для отключения комментов:', e.message);
  }
}

// Команды бота
async function handleCommand(msg, text) {
  const fromId = msg.from ? String(msg.from.id) : '';
  const isAdmin = adminTelegramId && fromId === String(adminTelegramId);
  const chatId = msg.chat.id;
  const isPrivate = msg.chat.type === 'private';

  // /command или /command@botname — извлекаем чистое имя
  const [rawCmd, ...args] = text.split(/\s+/);
  const command = rawCmd.toLowerCase().split('@')[0];
  const argText = args.join(' ');

  switch (command) {
    case '/start':
      // Deeplink-параметр (например /start order) — переход с кнопки в канале на заказ рекламы.
      if (argText === 'order') return sendOrderMessage(chatId, msg.from, isAdmin);
      return sendStartMessage(chatId, isAdmin);
    case '/about':
      return sendAboutMessage(chatId, isAdmin);
    case '/help':
      return sendHelpMessage(chatId, isAdmin);
    case '/order':
      return sendOrderMessage(chatId, msg.from, isAdmin);
    case '/admin':
      if (!isAdmin) return safeSend(chatId, '⛔ Команда доступна только администратору канала.');
      return sendAdminMessage(chatId);
    case '/stats':
      if (!isAdmin) return safeSend(chatId, '⛔ Команда доступна только администратору канала.');
      return sendStatsMessage(chatId, isAdmin);
    default:
      if (isPrivate) {
        return safeSend(chatId, `Неизвестная команда ${command}. Используй /help для списка команд.`);
      }
  }
}

async function handleCallbackQuery(cbq) {
  const data = cbq.data || '';
  const chatId = cbq.message ? cbq.message.chat.id : (cbq.from ? cbq.from.id : null);
  if (!chatId) return;

  await bot.answerCallbackQuery(cbq.id).catch(() => {});

  const isAdmin = adminTelegramId && cbq.from && String(cbq.from.id) === String(adminTelegramId);

  if (data === 'order') return sendOrderMessage(chatId, cbq.from, isAdmin);
  if (data === 'help') return sendHelpMessage(chatId, isAdmin);
  if (data === 'about') return sendAboutMessage(chatId, isAdmin);
}

// Умная обрезка: режет на границе абзаца, потом строки, потом предложения.
// Финальный символ — многоточие, чтобы было видно что текст обрезан.
function truncateToFit(text, limit) {
  if (!text || text.length <= limit) return text;
  const target = limit - 1; // место под "…"
  let cut = text.lastIndexOf('\n\n', target);
  if (cut < target * 0.6) cut = text.lastIndexOf('\n', target);
  if (cut < target * 0.6) cut = text.lastIndexOf('. ', target) + 1;
  if (cut < target * 0.6) cut = text.lastIndexOf(' ', target);
  if (cut < target * 0.5) cut = target;
  return text.slice(0, cut).trim() + '…';
}

// Безопасная отправка с фоллбэком на plain text если Markdown не парсится
async function safeSend(chatId, text, options = {}) {
  if (!bot) return null;
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (e) {
    if (options.parse_mode && /can't parse entities|Bad Request: can't parse/i.test(e.message)) {
      const { parse_mode, ...rest } = options;
      console.warn(`⚠️ Markdown не распознан, повтор без parse_mode: ${e.message}`);
      return bot.sendMessage(chatId, text, rest);
    }
    console.error('❌ Ошибка отправки сообщения:', e.message);
    return null;
  }
}

// Тексты команд
async function sendStartMessage(chatId, isAdmin) {
  const channelUrl = getChannelUrl();
  const channelLine = channelUrl
    ? `📢 Канал: [${channelId}](${channelUrl})`
    : `📢 Канал: ${channelId || ''}`;

  const text = `👋 *Добро пожаловать!*

*Чёрный Синтез* — аналитический канал о химической и нефтехимической промышленности Казахстана и стран СНГ.

${channelLine}

📊 *Здесь:*
• Анализ ключевых событий отрасли
• Технологии переработки и синтеза
• Обзоры рынка полимеров и удобрений
• Новости заводов и кластеров

Используй кнопки внизу — меню закреплено в этом чате.`;

  return safeSend(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: getMainKeyboard(isAdmin)
  });
}

async function sendAboutMessage(chatId, isAdmin) {
  const text = `🏭 *О канале «Чёрный Синтез»*

Канал ведёт отраслевая команда аналитиков. Здесь публикуются:

⚙️ *Технологии:* каталитические процессы, полимеризация, дегидрирование, переработка газа и нефти.

📈 *Рынки:* динамика цен на полипропилен, ПЭ, ПВХ, аммиак, карбамид и азотные удобрения.

🌍 *Регион:* Казахстан, Узбекистан, Россия, Беларусь — крупные проекты, модернизации НПЗ, химкластеры.

🤖 *ИИ-аналитика:* посты готовятся с помощью Google Gemini, тональность комментариев анализируется автоматически.

📩 Для сотрудничества и рекламы — команда /order.`;

  return safeSend(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: getMainKeyboard(isAdmin)
  });
}

async function sendHelpMessage(chatId, isAdmin) {
  const lines = [
    '🤖 *Команды бота*',
    '',
    '/start — приветствие и быстрый старт',
    '/about — подробнее о канале',
    '/order — заказать рекламу',
    '/help — этот список',
    '',
    '_Внизу чата закреплено меню с кнопками._'
  ];
  return safeSend(chatId, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: getMainKeyboard(isAdmin)
  });
}

async function sendOrderMessage(chatId, fromUser, isAdmin) {
  const text = `📢 *Реклама в канале «Чёрный Синтез»*

Канал читают специалисты химической и нефтехимической отрасли Казахстана и СНГ. Здесь покупают рекламу:

• Производители оборудования и реагентов
• ИТ-решения для промышленности
• Образовательные программы и конференции
• Вакансии в крупных компаниях отрасли
• Логистика и сервис

📝 *Как заказать:*
1. Напиши админу с описанием задачи
2. Согласуй текст, изображение и дату
3. После оплаты пост публикуется в выбранное время

💡 Возможен как готовый пост (твой материал), так и нативная статья от лица канала (ИИ-генерация с твоими тезисами).`;

  const adminContact = getAdminContactUrl();
  const buttons = [];
  if (webAppUrl) {
    buttons.push([{ text: '📝 Заполнить заявку', web_app: { url: `${webAppUrl}/order.html` } }]);
  }
  if (adminContact) buttons.push([{ text: '💬 Написать админу', url: adminContact }]);

  // Уведомление админу о входящем интересе к рекламе
  if (adminTelegramId && fromUser && String(fromUser.id) !== String(adminTelegramId)) {
    const who = fromUser.username
      ? `@${fromUser.username}`
      : `${fromUser.first_name || ''} ${fromUser.last_name || ''}`.trim() || `ID ${fromUser.id}`;
    const notify = `📨 Новый интерес к рекламе:\n${who} (id: ${fromUser.id})\nКоманда /order в боте.`;
    safeSend(adminTelegramId, notify).catch(() => {});
  }

  return safeSend(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined
  });
}

async function sendAdminMessage(chatId) {
  if (!webAppUrl) {
    return safeSend(chatId, '⚠️ WEBAPP_URL не задан в env-переменных Vercel. Открыть Mini App не получится — настрой переменную и сделай Redeploy.');
  }
  return safeSend(chatId, '🛠 *Админ-панель*\n\nУправление каналом, постами, заказами и статистикой.', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: 'Открыть админку', web_app: { url: webAppUrl } }]]
    }
  });
}

async function sendStatsMessage(chatId, isAdmin) {
  try {
    const subs = await getSubscriberCount().catch(() => 0);
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

    const publishedToday = await db.get(
      "SELECT COUNT(*) AS count FROM posts WHERE status = ? AND published_at >= ? AND published_at <= ?",
      ['published', todayStart.toISOString(), todayEnd.toISOString()]
    );
    const drafts = await db.get("SELECT COUNT(*) AS count FROM posts WHERE status = ?", ['draft']);
    const scheduled = await db.get("SELECT COUNT(*) AS count FROM posts WHERE status = ?", ['scheduled']);
    const pendingOrders = await db.get("SELECT COUNT(*) AS count FROM orders WHERE status = ?", ['pending']);
    const paidOrders = await db.get("SELECT COUNT(*) AS count FROM orders WHERE status = ?", ['paid']);
    const totalRevenue = await db.get("SELECT COALESCE(SUM(amount_paid), 0) AS total FROM orders WHERE status IN ('paid', 'completed')");

    const text = `📊 *Статистика «Чёрный Синтез»*

👥 Подписчики: *${subs}*
📝 Опубликовано сегодня: *${publishedToday ? publishedToday.count : 0}*
📂 Черновиков в очереди: *${drafts ? drafts.count : 0}*
⏰ Запланировано: *${scheduled ? scheduled.count : 0}*

💼 *Реклама*
📨 Заявок ожидает: *${pendingOrders ? pendingOrders.count : 0}*
✅ Активных заказов: *${paidOrders ? paidOrders.count : 0}*
💰 Заработано: *${totalRevenue ? Number(totalRevenue.total).toLocaleString('ru-RU') : 0} ₸*`;

    return safeSend(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: getMainKeyboard(isAdmin)
    });
  } catch (e) {
    return safeSend(chatId, '⚠️ Ошибка получения статистики: ' + e.message);
  }
}

// Извлекаем chat origin из msg — поддерживаем и старое forward_from_chat и новое forward_origin.
function getForwardSource(msg) {
  if (!msg) return null;
  if (msg.forward_from_chat) {
    return { chatId: msg.forward_from_chat.id, username: msg.forward_from_chat.username, messageId: msg.forward_from_message_id };
  }
  if (msg.forward_origin && msg.forward_origin.chat) {
    return { chatId: msg.forward_origin.chat.id, username: msg.forward_origin.chat.username, messageId: msg.forward_origin.message_id };
  }
  return null;
}

function isFromOurChannel(src) {
  if (!src) return false;
  const channelIdStr = String(channelId || '').replace('@', '');
  return String(src.chatId) === channelIdStr ||
    (src.username && src.username === channelIdStr);
}

// Существующая логика — отслеживание комментариев в группе обсуждения
async function handleGroupComment(msg) {
  const replyTo = msg.reply_to_message;
  const src = getForwardSource(replyTo);

  if (!isFromOurChannel(src)) return;

  const channelPostId = src.messageId;
  const username = msg.from.username ? `@${msg.from.username}` : `${msg.from.first_name} ${msg.from.last_name || ''}`.trim();
  const commentText = msg.text;
  const tgMsgId = msg.message_id;

  console.log(`💬 Комментарий от ${username} к посту #${channelPostId}: "${commentText}"`);

  const sentiment = await gemini.analyzeSentiment(commentText);
  console.log(`🧠 Тональность: ${sentiment}`);

  try {
    const post = await db.get('SELECT id FROM posts WHERE telegram_message_id = ? LIMIT 1', [channelPostId]);
    const internalPostId = post ? post.id : null;

    const createdAt = new Date().toISOString();
    await db.run(
      `INSERT INTO comments (telegram_message_id, post_id, username, text, sentiment, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [tgMsgId, internalPostId, username, commentText, sentiment, createdAt]
    );

    const today = new Date().toISOString().split('T')[0];
    await db.run(`
      INSERT INTO stats (date, active_engagement)
      VALUES (?, 1)
      ON CONFLICT(date) DO UPDATE SET active_engagement = stats.active_engagement + 1
    `, [today]);
  } catch (err) {
    console.error('❌ Ошибка записи комментария в БД:', err.message);
  }
}

// Извлекает лид (первый абзац без заголовка) из markdown-контента, ≤250 символов, без разметки.
function buildLead(cleanContent) {
  const paragraphs = (cleanContent || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  let lead = paragraphs[0] || '';
  // Пропускаем первую строку если она целиком — заголовок в звёздочках (с возможным эмодзи)
  if (paragraphs.length > 1 && /^\s*[^\s]*\s*\*[^*\n]+\*\s*$/.test(lead)) {
    lead = paragraphs[1];
  }
  return lead.replace(/\*/g, '').replace(/_/g, '').slice(0, 250).trim();
}

// Текст сообщения в канале для постов, опубликованных через Telegraph.
// Используется и при первой публикации, и при последующих правках,
// чтобы формат сообщения оставался "карточка с превью + лид + ссылка".
function buildTelegraphMessageText(title, cleanContent, telegraphUrl) {
  const lead = buildLead(cleanContent);
  return `*${title}*\n\n${lead}\n\n[Читать полностью →](${telegraphUrl})`;
}

// Публикация поста в канал
async function publishPost(post) {
  if (isDemo) {
    console.log(`📢 Telegram (Демо): Публикация поста в канал:\n📌 Заголовок: ${post.title}\n📝 Текст:\n${post.content}\n🖼️ Медиа: ${post.media_url || 'нет'}`);
    
    // Имитируем успешную отправку, возвращаем случайный Telegram Message ID
    const fakeTgMsgId = Math.floor(Math.random() * 100000) + 1;

    // Обновим пост в базе как опубликованный
    const now = new Date().toISOString();
    await db.run(
      'UPDATE posts SET status = ?, published_at = ?, telegram_message_id = ? WHERE id = ?',
      ['published', now, fakeTgMsgId, post.id]
    );

    // Добавим фейковые комментарии для демонстрации, если это демо-режим
    await generateMockCommentsForPost(post.id, fakeTgMsgId);

    return fakeTgMsgId;
  }

  // На холодном старте serverless-функции бот может быть ещё null — поднимем сейчас.
  if (!bot) initBot();
  if (!bot) {
    throw new Error(
      'Бот не инициализирован. Проверь TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID и DEMO_MODE в Vercel env vars (должны быть в Production).'
    );
  }

  try {
    // Telegram лимиты: caption у sendPhoto = 1024 символа, текст у sendMessage = 4096.
    const CAPTION_LIMIT = 1024;
    const TEXT_LIMIT = 4096;

    // Санитарим Markdown (`**bold**` → `*bold*`, убираем `##` заголовки).
    // Это критично — Telegram parse_mode='Markdown' не понимает GitHub-стиль,
    // и без чистки пост уходит в plain-text fallback с буквальными звёздочками.
    const cleanContent = gemini.sanitizeMarkdown(post.content || '');

    // Дедуп заголовка: если первая строка содержимого уже похожа на title, не префиксуем.
    const firstLineNorm = (cleanContent.split('\n')[0] || '')
      .toLowerCase()
      .replace(/[*_\s🏭📊⚙️💡🔬🛢️📈🌍🔥]/g, '');
    const titleNorm = (post.title || '').toLowerCase().replace(/[*_\s]/g, '');
    const contentStartsWithTitle = !!(
      firstLineNorm && titleNorm &&
      (firstLineNorm === titleNorm || firstLineNorm.startsWith(titleNorm.slice(0, 24)))
    );
    const formattedContent = contentStartsWithTitle
      ? cleanContent
      : `*${post.title}*\n\n${cleanContent}`;

    // Картинка обязательна: используем post.media_url, если есть валидный URL.
    // Иначе — фоллбэк на брендированную logo.png с того же Vercel-домена (стабильно доступна).
    const fallbackImage = process.env.WEBAPP_URL
      ? `${process.env.WEBAPP_URL.replace(/\/$/, '')}/logo.png`
      : null;
    const realMedia = post.media_url && post.media_url.trim().startsWith('http')
      ? post.media_url.trim()
      : null;
    const mediaUrl = realMedia || fallbackImage;
    const hasMedia = !!mediaUrl;

    // ОСНОВНОЙ путь: Telegraph-статья + sendMessage с URL → Telegram строит карточку.
    // Тап на карточку → Instant View с полным текстом, лайки и комментарии на самом канал-посте.
    try {
      const article = await telegraph.createArticle({
        title: post.title,
        content: cleanContent,
        imageUrl: realMedia || fallbackImage,
        db
      });

      const messageText = buildTelegraphMessageText(post.title, cleanContent, article.url);

      const resultMessage = await bot.sendMessage(channelId, messageText, {
        parse_mode: 'Markdown',
        // Превью включено по умолчанию — Telegram сам построит карточку из Telegraph URL.
        link_preview_options: { is_disabled: false, prefer_large_media: true, show_above_text: true, url: article.url }
      });

      const tgMessageId = resultMessage.message_id;
      console.log(`✅ Пост #${post.id} опубликован через Telegraph: ${article.url} (msg #${tgMessageId})`);

      const now = new Date().toISOString();
      await db.run(
        'UPDATE posts SET status = ?, published_at = ?, telegram_message_id = ?, telegraph_url = ?, telegraph_path = ? WHERE id = ?',
        ['published', now, tgMessageId, article.url, article.path, post.id]
      );

      return tgMessageId;
    } catch (telegraphErr) {
      console.warn(`⚠️ Telegraph не сработал (${telegraphErr.message}), фоллбэк на sendPhoto+caption`);
    }

    // ФОЛЛБЭК: если Telegraph недоступен — обычный sendPhoto с caption (старая логика).
    const sendWith = async (media, useMarkdown) => {
      const opts = useMarkdown ? { parse_mode: 'Markdown' } : {};
      if (media) {
        const caption = truncateToFit(formattedContent, CAPTION_LIMIT);
        return bot.sendPhoto(channelId, media, { caption, ...opts });
      }
      if (formattedContent.length <= TEXT_LIMIT) {
        return bot.sendMessage(channelId, formattedContent, opts);
      }
      return bot.sendMessage(channelId, truncateToFit(formattedContent, TEXT_LIMIT), opts);
    };

    const isParseErr = (e) => /can't parse entities|Bad Request: can't parse/i.test(e.message);
    const isUrlErr = (e) => /failed to get HTTP URL content|wrong file identifier|PHOTO_INVALID|wrong type of the web page content|wrong remote file|webpage_curl_failed|wrong url/i.test(e.message);

    const attempts = [];
    if (realMedia) {
      attempts.push({ media: realMedia, markdown: true });
      attempts.push({ media: realMedia, markdown: false });
    }
    if (fallbackImage && fallbackImage !== realMedia) {
      attempts.push({ media: fallbackImage, markdown: true });
      attempts.push({ media: fallbackImage, markdown: false });
    }
    attempts.push({ media: null, markdown: true });
    attempts.push({ media: null, markdown: false });

    let resultMessage = null;
    let lastErr = null;
    for (const a of attempts) {
      try {
        resultMessage = await sendWith(a.media, a.markdown);
        break;
      } catch (e) {
        lastErr = e;
        if (isParseErr(e) || isUrlErr(e)) continue;
        throw e;
      }
    }
    if (!resultMessage) throw lastErr || new Error('Не удалось опубликовать пост ни в одном варианте');

    const tgMessageId = resultMessage.message_id;
    console.log(`✅ Пост #${post.id} успешно опубликован в Telegram. Message ID: ${tgMessageId}`);

    const now = new Date().toISOString();
    await db.run(
      'UPDATE posts SET status = ?, published_at = ?, telegram_message_id = ? WHERE id = ?',
      ['published', now, tgMessageId, post.id]
    );

    return tgMessageId;
  } catch (error) {
    console.error(`❌ Ошибка публикации поста #${post.id} в Telegram:`, error.message);
    throw error;
  }
}

// Редактирование уже опубликованного в канал поста.
// Не знаем заранее, был ли пост sendMessage (Telegraph-карточка) или sendPhoto (caption-фоллбэк),
// поэтому пробуем editMessageText, при ошибке про "no text" фоллбэчимся на editMessageCaption.
// Если у поста есть telegraph_path — параллельно обновляем саму Telegraph-статью.
async function editPublishedPost(post) {
  if (isDemo) {
    console.log(`✏️ Demo: симуляция редактирования поста #${post.id} в канале`);
    return;
  }
  if (!bot) initBot();
  if (!bot) throw new Error('Бот не инициализирован');
  if (!post.telegram_message_id) {
    throw new Error('У поста нет telegram_message_id — нечего редактировать в канале');
  }

  const cleanContent = gemini.sanitizeMarkdown(post.content || '');
  const fallbackImg = process.env.WEBAPP_URL
    ? `${process.env.WEBAPP_URL.replace(/\/$/, '')}/logo.png` : null;
  const realImg = post.media_url && post.media_url.trim().startsWith('http')
    ? post.media_url.trim() : null;

  // 1. Обновляем Telegraph-статью если она была создана (не фейлим всё если упало — это бонус).
  if (post.telegraph_path) {
    try {
      await telegraph.editArticle({
        path: post.telegraph_path,
        title: post.title,
        content: cleanContent,
        imageUrl: realImg || fallbackImg,
        db
      });
      console.log(`📝 Telegraph статья ${post.telegraph_path} обновлена`);
    } catch (e) {
      console.warn(`⚠️ Telegraph editArticle не сработал: ${e.message} (продолжаем — обновим сообщение в канале)`);
    }
  }

  // Формируем НОВЫЙ текст сообщения с учётом формата исходной публикации:
  //  • если есть telegraph_url → "карточка с превью" (title + лид + ссылка на статью);
  //  • если нет → полный текст поста (фоллбэк-публикация была sendPhoto+caption или sendMessage).
  let newText;
  if (post.telegraph_url) {
    newText = buildTelegraphMessageText(post.title, cleanContent, post.telegraph_url);
  } else {
    const titleNorm = (post.title || '').toLowerCase().replace(/[*_\s]/g, '');
    const firstLineNorm = (cleanContent.split('\n')[0] || '').toLowerCase().replace(/[*_\s🏭📊⚙️💡🔬🛢️📈🌍🔥]/g, '');
    const contentStartsWithTitle = firstLineNorm && titleNorm &&
      (firstLineNorm === titleNorm || firstLineNorm.startsWith(titleNorm.slice(0, 24)));
    const formatted = contentStartsWithTitle ? cleanContent : `*${post.title}*\n\n${cleanContent}`;
    newText = truncateToFit(formatted, 1024);
  }

  const baseOpts = {
    chat_id: channelId,
    message_id: post.telegram_message_id,
    parse_mode: 'Markdown'
  };
  // Для Telegraph-карточек обязательно подтягиваем тот же link_preview, что был при публикации,
  // иначе editMessageText может выйти без превью.
  if (post.telegraph_url) {
    baseOpts.link_preview_options = {
      is_disabled: false,
      prefer_large_media: true,
      show_above_text: true,
      url: post.telegraph_url
    };
  }

  // Сценарий 1: пост был отправлен как sendMessage (Telegraph-карточка) → editMessageText.
  try {
    await bot.editMessageText(newText, baseOpts);
    console.log(`✏️ Пост #${post.id}: editMessageText OK`);
    return;
  } catch (e) {
    if (/can't parse entities/i.test(e.message)) {
      try {
        await bot.editMessageText(newText, { ...baseOpts, parse_mode: undefined });
        console.log(`✏️ Пост #${post.id}: editMessageText (plain) OK`);
        return;
      } catch (_) { /* fallthrough в caption */ }
    }
    if (/MESSAGE_NOT_MODIFIED/i.test(e.message)) {
      console.log(`ℹ️ Пост #${post.id}: содержимое не изменилось`);
      return;
    }
    // Сюда попадаем если это был photo+caption — нет текста для editMessageText
  }

  // Сценарий 2: пост был отправлен как sendPhoto (caption-фоллбэк) → editMessageCaption.
  // Caption-варианту link_preview_options не нужен.
  const capOpts = { ...baseOpts };
  delete capOpts.link_preview_options;
  try {
    await bot.editMessageCaption(newText, capOpts);
    console.log(`✏️ Пост #${post.id}: editMessageCaption OK`);
  } catch (e) {
    if (/can't parse entities/i.test(e.message)) {
      await bot.editMessageCaption(newText, { ...capOpts, parse_mode: undefined });
      console.log(`✏️ Пост #${post.id}: editMessageCaption (plain) OK`);
      return;
    }
    if (/MESSAGE_NOT_MODIFIED/i.test(e.message)) return;
    throw new Error(`Не удалось отредактировать пост в канале: ${e.message}`);
  }
}

// Удаление поста из канала.
async function deletePublishedPost(post) {
  if (isDemo) {
    console.log(`🗑️ Demo: симуляция удаления поста #${post.id} из канала`);
    return;
  }
  if (!bot) initBot();
  if (!bot || !post.telegram_message_id) return;

  try {
    await bot.deleteMessage(channelId, post.telegram_message_id);
    console.log(`🗑️ Пост #${post.id} удалён из канала`);
  } catch (e) {
    // Telegram запрещает удалять сообщения старше 48 часов в каналах.
    if (/message to delete not found|message can't be deleted|too old/i.test(e.message)) {
      console.warn(`⚠️ Пост #${post.id}: ${e.message}`);
      throw new Error(`Не удалось удалить из канала (${e.message}). Возможно, пост старше 48 часов — удали вручную в Telegram.`);
    }
    throw e;
  }
}

// Получение количества подписчиков канала
async function getSubscriberCount() {
  if (isDemo) {
    // В демо-режиме генерируем плавный рост подписчиков
    try {
      const today = new Date().toISOString().split('T')[0];
      const lastStat = await db.get('SELECT subscribers_count FROM stats ORDER BY date DESC LIMIT 1');
      let baseCount = lastStat ? lastStat.subscribers_count : 1240;
      
      // Небольшой случайный прирост (+1..+5 в день)
      const randomGrowth = Math.floor(Math.random() * 5) + 1;
      return baseCount + randomGrowth;
    } catch (e) {
      return 1250;
    }
  }

  try {
    const count = await bot.getChatMemberCount(channelId);
    return count;
  } catch (error) {
    console.error('❌ Ошибка получения числа подписчиков:', error.message);
    // Возвращаем старое значение из БД, если API недоступно
    const lastStat = await db.get('SELECT subscribers_count FROM stats ORDER BY date DESC LIMIT 1');
    return lastStat ? lastStat.subscribers_count : 0;
  }
}

// Имитатор комментариев для ДЕМО-режима
async function generateMockCommentsForPost(internalPostId, tgMsgId) {
  const mockComments = [
    { user: '@Arman_KNG', text: 'Очень актуальная статья! Расширение Шымкентского НПЗ давно назрело.' },
    { user: '@Dmitry_Oil', text: 'Интересно, а какие катализаторы они используют? Китайские или европейские?' },
    { user: '@Elena_Eco', text: 'Опять эти выбросы... Жители Шымкента и так жалуются на экологию. Надеюсь модернизация снизит вред.' },
    { user: '@Zhaksylyk_ref', text: 'Каталитический крекинг — это хорошо. А глубина переработки какая будет в итоге?' },
    { user: '@Skeptik_01', text: 'Да сколько можно модернизировать, бензин АИ-95 все равно дорожает каждый месяц! 👎' }
  ];

  // Выберем случайное количество комментариев (от 1 до 4)
  const count = Math.floor(Math.random() * 4) + 1;
  const selected = mockComments.sort(() => Math.random() - 0.5).slice(0, count);

  for (const c of selected) {
    const sentiment = await gemini.analyzeSentiment(c.text);
    const createdAt = new Date(Date.now() + Math.random() * 60000).toISOString(); // небольшая задержка
    
    await db.run(`
      INSERT INTO comments (telegram_message_id, post_id, username, text, sentiment, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [tgMsgId + Math.floor(Math.random()*10), internalPostId, c.user, c.text, sentiment, createdAt]);
  }
}

// Публикует в канал компактную рекламную плашку и закрепляет её.
// Старая закреплённая (если её id сохранён в settings.ad_pin_message_id) — открепляется.
async function pinAdAnnouncement() {
  if (isDemo) {
    console.log('📌 Demo: симуляция закрепления рекламной плашки');
    return { message_id: Math.floor(Math.random() * 100000), demo: true };
  }
  if (!bot) initBot();
  if (!bot) throw new Error('Бот не инициализирован — проверь TELEGRAM_BOT_TOKEN');

  const adminContact = getAdminContactUrl();
  const text = `📢 *Реклама в канале*

Размещение для производителей оборудования, реагентов, IT-решений, образовательных программ, вакансий и сервиса в нефтехимической отрасли Казахстана и СНГ.

Заявку оставь через кнопку ниже или напиши админу.`;

  // ВАЖНО: в каналах кнопки web_app в inline-клавиатуре запрещены (BUTTON_TYPE_INVALID).
  // Используем URL-кнопку на deeplink к боту с параметром start=order — бот при /start order
  // покажет тот же сценарий заявки с web_app формой (там уже личка, web_app работает).
  const buttons = [];
  if (bot && bot.options && bot.me && bot.me.username) {
    // на всякий случай не используется — короче через env
  }
  const botUsername = (process.env.TELEGRAM_BOT_USERNAME || 'black_synthesis_bot').replace(/^@/, '');
  buttons.push([{ text: '📝 Оставить заявку', url: `https://t.me/${botUsername}?start=order` }]);
  if (adminContact) buttons.push([{ text: '💬 Связаться с админом', url: adminContact }]);

  // Открепляем старую плашку если есть
  const oldPin = await db.get("SELECT value FROM settings WHERE key = 'ad_pin_message_id'");
  if (oldPin && oldPin.value) {
    try {
      await bot.unpinChatMessage(channelId, Number(oldPin.value));
      console.log(`📌 Старая рекламная плашка #${oldPin.value} откреплена`);
    } catch (e) {
      console.warn(`⚠️ Не удалось открепить старое сообщение #${oldPin.value}: ${e.message}`);
    }
  }

  const sent = await bot.sendMessage(channelId, text, {
    parse_mode: 'Markdown',
    disable_notification: true,
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined
  });

  try {
    await bot.pinChatMessage(channelId, sent.message_id, { disable_notification: true });
    console.log(`📌 Рекламная плашка #${sent.message_id} закреплена в канале`);
  } catch (e) {
    throw new Error(`Опубликовано, но не удалось закрепить: ${e.message}. Дай боту право "Закреплять сообщения" в админке канала.`);
  }

  await db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = ?`,
    ['ad_pin_message_id', String(sent.message_id), String(sent.message_id)]
  );

  return { message_id: sent.message_id, demo: false };
}

// Открепить рекламную плашку (если есть).
async function unpinAdAnnouncement() {
  if (isDemo) {
    console.log('📌 Demo: симуляция открепления плашки');
    return { unpinned: true, demo: true };
  }
  if (!bot) initBot();
  if (!bot) throw new Error('Бот не инициализирован');

  const oldPin = await db.get("SELECT value FROM settings WHERE key = 'ad_pin_message_id'");
  if (!oldPin || !oldPin.value) return { unpinned: false, reason: 'Нет закреплённой плашки в БД' };

  try {
    await bot.unpinChatMessage(channelId, Number(oldPin.value));
    await db.run("DELETE FROM settings WHERE key = 'ad_pin_message_id'");
    return { unpinned: true };
  } catch (e) {
    throw new Error(`Не удалось открепить: ${e.message}`);
  }
}

module.exports = {
  initBot,
  publishPost,
  editPublishedPost,
  deletePublishedPost,
  pinAdAnnouncement,
  unpinAdAnnouncement,
  getSubscriberCount,
  getBotInstance: () => bot
};
