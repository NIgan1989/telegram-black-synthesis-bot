const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const gemini = require('./gemini');
const dotenv = require('dotenv');

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const channelId = process.env.TELEGRAM_CHANNEL_ID;
const isDemo = process.env.DEMO_MODE === 'true' || !token || !channelId;

let bot = null;

// Инициализация бота
function initBot() {
  if (isDemo) {
    console.log('🤖 Telegram (Демо): Запуск бота в режиме имитации...');
    return null;
  }

  try {
    // В Vercel (продакшене) мы НЕ используем polling, а используем webhooks.
    // На локальном компьютере используем polling для удобства тестирования.
    const usePolling = !process.env.DATABASE_URL; // Если есть DATABASE_URL (Supabase), то это прод/Vercel
    
    if (usePolling) {
      console.log('🤖 Telegram: Запуск бота в режиме Long Polling (локально)...');
      bot = new TelegramBot(token, { polling: true });
    } else {
      console.log('🤖 Telegram: Запуск бота в режиме Webhook (для Vercel)...');
      bot = new TelegramBot(token, { polling: false });
    }

    // Слушатель входящих сообщений (для комментариев в группе обсуждения)
    bot.on('message', async (msg) => {
      await handleIncomingMessage(msg);
    });

    // Обработка ошибок
    bot.on('polling_error', (error) => {
      console.error('❌ Telegram Polling Error:', error.message);
    });

  } catch (error) {
    console.error('❌ Ошибка при инициализации Telegram Bot API:', error.message);
  }

  return bot;
}

// Обработка входящих сообщений (отслеживание комментариев)
async function handleIncomingMessage(msg) {
  if (!msg.text) return;

  // В Telegram комментарии к постам канала публикуются в привязанной супергруппе.
  // Сообщение-комментарий является ответом (reply) на автоматически пересланный пост из канала.
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  
  if (isGroup && msg.reply_to_message) {
    const replyTo = msg.reply_to_message;
    
    // Проверяем, переслано ли сообщение из нашего канала
    const isFromChannel = replyTo.forward_from_chat && 
      (String(replyTo.forward_from_chat.id) === String(channelId) || 
       replyTo.forward_from_chat.username === String(channelId).replace('@', ''));

    if (isFromChannel) {
      const channelPostId = replyTo.forward_from_message_id;
      const username = msg.from.username ? `@${msg.from.username}` : `${msg.from.first_name} ${msg.from.last_name || ''}`.trim();
      const commentText = msg.text;
      const tgMsgId = msg.message_id;

      console.log(`💬 Бот: Обнаружен новый комментарий от ${username} к посту #${channelPostId}: "${commentText}"`);

      // 1. Анализируем тональность комментария через Gemini ИИ
      const sentiment = await gemini.analyzeSentiment(commentText);
      console.log(`🧠 ИИ: Тональность комментария — ${sentiment}`);

      // 2. Ищем пост в нашей базе данных по telegram_message_id (channelPostId)
      try {
        const post = await db.get('SELECT id FROM posts WHERE telegram_message_id = ? LIMIT 1', [channelPostId]);
        const internalPostId = post ? post.id : null;

        // Записываем комментарий в БД
        const insertQuery = `
          INSERT INTO comments (telegram_message_id, post_id, username, text, sentiment, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `;
        const createdAt = new Date().toISOString();
        await db.run(insertQuery, [tgMsgId, internalPostId, username, commentText, sentiment, createdAt]);

        // Обновим вовлеченность (active_engagement) в статистике за сегодняшний день
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

  try {
    let resultMessage = null;
    const formattedContent = `*${post.title}*\n\n${post.content}`;

    if (post.media_url && post.media_url.trim().startsWith('http')) {
      // Отправляем фото с подписью
      resultMessage = await bot.sendPhoto(channelId, post.media_url, {
        caption: formattedContent,
        parse_mode: 'Markdown'
      });
    } else {
      // Отправляем текстовое сообщение
      resultMessage = await bot.sendMessage(channelId, formattedContent, {
        parse_mode: 'Markdown'
      });
    }

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
