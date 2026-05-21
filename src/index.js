const app = require('./app');
const db = require('./db');
const bot = require('./bot');
const scheduler = require('./scheduler');
const dotenv = require('dotenv');

dotenv.config();

const PORT = process.env.PORT || 3000;

async function bootstrap() {
  console.log('🚀 Инициализация локального сервера...');
  
  try {
    // 1. Подключаемся к БД и создаем таблицы
    await db.init();
    
    // 2. Инициализируем Telegram Бота
    bot.initBot();

    // 3. Запускаем крон-планировщик (для локального ПК)
    scheduler.startScheduler();

    // 4. Опрашиваем статистику один раз при старте
    await scheduler.updateDailyStats();

    // 5. Запускаем Express веб-сервер
    app.listen(PORT, () => {
      console.log(`📡 Сервер запущен локально на порту ${PORT}`);
      console.log(`🔗 Админка (локально): http://localhost:${PORT}`);
      console.log('----------------------------------------------------');
    });

  } catch (error) {
    console.error('❌ Ошибка запуска приложения:', error.message);
    process.exit(1);
  }
}

bootstrap();
