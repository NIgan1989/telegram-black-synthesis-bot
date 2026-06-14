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
    await db.init();
    bot.initBot();

    // Авто обмен Казахстан: новостной агрегатор (химия) ОТКЛЮЧЁН — канал теперь про авто.
    // Объявления заводятся продавцами через форму и одобряются вручную.
    // Cron оставлен только для:
    //  1) обновления статистики подписчиков
    //  2) публикации запланированных постов (если такие появятся)

    await scheduler.updateDailyStats();
    await scheduler.publishScheduledPosts();

    res.status(200).json({
      success: true,
      message: 'Плановые задачи выполнены (статистика + запланированные посты)'
    });
  } catch (error) {
    console.error('❌ Serverless Cron Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};
