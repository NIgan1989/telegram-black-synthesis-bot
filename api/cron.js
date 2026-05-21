const db = require('../src/db');
const bot = require('../src/bot');
const scheduler = require('../src/scheduler');

module.exports = async (req, res) => {
  // Проверяем авторизацию Cron-задачи
  // Vercel отправляет заголовок Authorization: Bearer <CRON_SECRET>
  const authHeader = req.headers.authorization;
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  
  const isVercelCron = req.headers['x-vercel-cron'] === 'true';
  const isDemo = process.env.DEMO_MODE === 'true';

  if (!isDemo && !isVercelCron && (!authHeader || authHeader !== expectedAuth)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('⏰ Serverless Cron: Запуск плановых задач...');

  try {
    // 1. Инициализируем БД и Telegram Bot API
    await db.init();
    bot.initBot();

    // 2. Выполняем сбор новостей и автогенерацию
    const createdCount = await scheduler.runNewsAggregation();

    // 3. Обновляем статистику подписчиков
    await scheduler.updateDailyStats();

    // 4. Публикуем запланированные посты
    await scheduler.publishScheduledPosts();

    res.status(200).json({ 
      success: true, 
      message: 'Плановые задачи успешно выполнены', 
      createdPosts: createdCount 
    });
  } catch (error) {
    console.error('❌ Serverless Cron Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};
