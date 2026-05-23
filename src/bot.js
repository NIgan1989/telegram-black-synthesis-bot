const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const gemini = require('./gemini');
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
  if (isGroup && msg.reply_to_message) {
    await handleGroupComment(msg);
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

// Разбивает длинный текст на куски ≤ limit символов по границе абзаца/предложения и шлёт по очереди в канал.
// Возвращает последнее отправленное сообщение.
async function sendLongText(text, opts, limit) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut < limit / 2) cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = remaining.lastIndexOf('. ', limit) + 1;
    if (cut < limit / 2) cut = limit;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);

  let last;
  for (const chunk of chunks) {
    last = await bot.sendMessage(channelId, chunk, opts);
  }
  return last;
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

// Существующая логика — отслеживание комментариев в группе обсуждения
async function handleGroupComment(msg) {
  const replyTo = msg.reply_to_message;

  const isFromChannel = replyTo.forward_from_chat &&
    (String(replyTo.forward_from_chat.id) === String(channelId) ||
     replyTo.forward_from_chat.username === String(channelId).replace('@', ''));

  if (!isFromChannel) return;

  const channelPostId = replyTo.forward_from_message_id;
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

    // Заголовок пост-контента: если в content уже есть жирный заголовок первой строкой
    // (новый формат от Gemini), не дублируем; иначе оборачиваем post.title в *...*.
    const contentStartsWithTitle = /^\s*[🏭📊⚙️💡🔬🛢️📈🌍🔥]?\s*\*[^*\n]+\*/.test(post.content || '');
    const formattedContent = contentStartsWithTitle
      ? post.content
      : `*${post.title}*\n\n${post.content}`;

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

    // Единый отправщик: либо фото + текст в caption/отдельным сообщением, либо чистый текст.
    const sendWith = async (media, useMarkdown) => {
      const opts = useMarkdown ? { parse_mode: 'Markdown' } : {};
      const title = useMarkdown ? `*${post.title}*` : post.title;

      if (media) {
        if (formattedContent.length <= CAPTION_LIMIT) {
          return bot.sendPhoto(channelId, media, { caption: formattedContent, ...opts });
        }
        const captionFits = title.length <= CAPTION_LIMIT;
        const photoMsg = captionFits
          ? await bot.sendPhoto(channelId, media, { caption: title, ...opts })
          : await bot.sendPhoto(channelId, media);
        await sendLongText(post.content, opts, TEXT_LIMIT);
        return photoMsg;
      }

      if (formattedContent.length <= TEXT_LIMIT) {
        return bot.sendMessage(channelId, formattedContent, opts);
      }
      return sendLongText(formattedContent, opts, TEXT_LIMIT);
    };

    const isParseErr = (e) => /can't parse entities|Bad Request: can't parse/i.test(e.message);
    const isUrlErr = (e) => /failed to get HTTP URL content|wrong file identifier|PHOTO_INVALID|wrong type of the web page content|wrong remote file|webpage_curl_failed|wrong url/i.test(e.message);

    // Каскад: реальная картинка → фоллбэк logo.png → text-only. На каждом уровне — Markdown, потом plain.
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
        if (a.media === fallbackImage && realMedia) {
          console.warn(`⚠️ Пост #${post.id}: оригинальный media_url не открылся, использован брендированный logo.png`);
        } else if (!a.media && hasMedia) {
          console.warn(`⚠️ Пост #${post.id}: все варианты картинки не сработали, опубликовано без изображения`);
        }
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

module.exports = {
  initBot,
  publishPost,
  getSubscriberCount,
  getBotInstance: () => bot
};
