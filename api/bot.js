const db = require('../src/db');
const bot = require('../src/bot');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 1. Инициализируем БД и бота
    await db.init();
    const botInstance = bot.initBot();

    // 2. Обрабатываем пришедшее обновление от Telegram
    if (botInstance && req.body) {
      // Передаем тело вебхука встроенному парсеру node-telegram-bot-api
      await botInstance.processUpdate(req.body);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Webhook Serverless Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};
