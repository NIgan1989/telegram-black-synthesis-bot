const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const isProd = process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres');
let pgPool = null;
let sqliteDb = null;

// Инициализация подключения
function connect() {
  if (isProd) {
    console.log('🔌 DB: Подключение к облачной базе PostgreSQL (Supabase)...');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false // необходимо для Supabase/Vercel
      }
    });
  } else {
    console.log('🔌 DB: Использование локальной базы данных SQLite...');
    const dbPath = path.join(__dirname, '..', 'data.db');
    
    // Проверим наличие директории (хотя она должна быть в корне)
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    sqliteDb = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('❌ DB: Ошибка создания локальной SQLite базы:', err.message);
      }
    });
  }
}

// Помощник для трансляции плейсхолдеров "?" в "$1, $2..." для PostgreSQL
function convertPlaceholders(sql) {
  if (!isProd) return sql;
  let index = 1;
  return sql.replace(/\?/g, () => `$${index++}`);
}

// Запрос нескольких строк (SELECT)
function query(sql, params = []) {
  const convertedSql = convertPlaceholders(sql);
  
  if (isProd) {
    return pgPool.query(convertedSql, params).then(res => res.rows);
  } else {
    return new Promise((resolve, reject) => {
      sqliteDb.all(convertedSql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
}

// Запрос одной строки (SELECT LIMIT 1)
function get(sql, params = []) {
  const convertedSql = convertPlaceholders(sql);
  
  if (isProd) {
    return pgPool.query(convertedSql, params).then(res => res.rows[0] || null);
  } else {
    return new Promise((resolve, reject) => {
      sqliteDb.get(convertedSql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      });
    });
  }
}

// Выполнение команды (INSERT, UPDATE, DELETE)
function run(sql, params = []) {
  const convertedSql = convertPlaceholders(sql);
  
  if (isProd) {
    return pgPool.query(convertedSql, params).then(res => {
      // Имитируем SQLite `changes` и `lastID` для совместимости
      return {
        changes: res.rowCount,
        lastID: res.rows[0] ? res.rows[0].id : null
      };
    });
  } else {
    return new Promise((resolve, reject) => {
      sqliteDb.run(convertedSql, params, function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes, lastID: this.lastID });
      });
    });
  }
}

// Создание таблиц (Инициализация)
async function init() {
  connect();
  
  // Таблица постов
  const postsSchema = isProd ? `
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      media_url TEXT,
      status VARCHAR(20) DEFAULT 'draft',
      scheduled_at TIMESTAMP,
      published_at TIMESTAMP,
      type VARCHAR(20) DEFAULT 'organic',
      views INTEGER DEFAULT 0,
      telegram_message_id BIGINT
    );
  ` : `
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      media_url TEXT,
      status TEXT DEFAULT 'draft',
      scheduled_at TEXT,
      published_at TEXT,
      type TEXT DEFAULT 'organic',
      views INTEGER DEFAULT 0,
      telegram_message_id INTEGER
    );
  `;

  // Таблица рекламных заказов
  const ordersSchema = isProd ? `
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      advertiser_name VARCHAR(255) NOT NULL,
      amount_paid NUMERIC DEFAULT 0,
      publish_date TIMESTAMP NOT NULL,
      post_id INTEGER,
      status VARCHAR(50) DEFAULT 'pending'
    );
  ` : `
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      advertiser_name TEXT NOT NULL,
      amount_paid REAL DEFAULT 0,
      publish_date TEXT NOT NULL,
      post_id INTEGER,
      status TEXT DEFAULT 'pending'
    );
  `;

  // Таблица комментариев и тональности
  const commentsSchema = isProd ? `
    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      telegram_message_id BIGINT NOT NULL,
      post_id INTEGER,
      username VARCHAR(255),
      text TEXT NOT NULL,
      sentiment VARCHAR(20) DEFAULT 'neutral',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  ` : `
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_message_id INTEGER NOT NULL,
      post_id INTEGER,
      username TEXT,
      text TEXT NOT NULL,
      sentiment TEXT DEFAULT 'neutral',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `;

  // Таблица статистики
  const statsSchema = isProd ? `
    CREATE TABLE IF NOT EXISTS stats (
      date DATE PRIMARY KEY,
      subscribers_count INTEGER DEFAULT 0,
      total_views INTEGER DEFAULT 0,
      active_engagement INTEGER DEFAULT 0
    );
  ` : `
    CREATE TABLE IF NOT EXISTS stats (
      date TEXT PRIMARY KEY,
      subscribers_count INTEGER DEFAULT 0,
      total_views INTEGER DEFAULT 0,
      active_engagement INTEGER DEFAULT 0
    );
  `;

  // Таблица глобальных настроек
  const settingsSchema = `
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `;

  try {
    await run(postsSchema);
    await run(ordersSchema);
    await run(commentsSchema);
    await run(statsSchema);
    await run(settingsSchema);
    await migrateAddTelegramMessageId();
    console.log('✅ DB: Все таблицы успешно инициализированы.');

    if (process.env.DEMO_MODE === 'true') {
      await seedDemoData();
    }
  } catch (err) {
    console.error('❌ DB: Ошибка инициализации таблиц базы данных:', err.message);
    throw new Error(`DB init failed: ${err.message}`);
  }
}

// Миграция: добавляет колонку telegram_message_id в таблицу posts, если её ещё нет.
// PostgreSQL поддерживает IF NOT EXISTS, для SQLite ловим ошибку "duplicate column".
async function migrateAddTelegramMessageId() {
  if (isProd) {
    await run('ALTER TABLE posts ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT');
    return;
  }
  try {
    await run('ALTER TABLE posts ADD COLUMN telegram_message_id INTEGER');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
}

async function seedDemoData() {
  try {
    const existing = await get("SELECT value FROM settings WHERE key = 'auto_post'");
    if (existing) {
      return; // Уже заполнено
    }
    
    console.log('🌱 DB: Заполнение базы данных демонстрационными данными...');
    
    // 1. Настройки
    await run("INSERT INTO settings (key, value) VALUES ('auto_post', 'false')");
    await run("INSERT INTO settings (key, value) VALUES ('channels_list', '@black_synthesis')");
    await run("INSERT INTO settings (key, value) VALUES ('post_interval', '6')");
    
    // 2. Статистика за последние 7 дней
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(today.getDate() - i);
      const dateString = date.toISOString().split('T')[0];
      const subs = 1200 + (6 - i) * 8 + Math.floor(Math.random() * 5);
      const views = 450 + Math.floor(Math.random() * 150);
      const engagement = 15 + Math.floor(Math.random() * 20);
      
      await run(
        "INSERT INTO stats (date, subscribers_count, total_views, active_engagement) VALUES (?, ?, ?, ?)",
        [dateString, subs, views, engagement]
      );
    }
    
    // 3. Посты
    const now = new Date().toISOString();
    const scheduledTime = new Date(Date.now() + 3600000 * 4).toISOString(); // через 4 часа
    
    const post1 = await run(`
      INSERT INTO posts (title, content, media_url, status, published_at, type, views)
      VALUES (?, ?, ?, 'published', ?, 'organic', 450)
    `, [
      'Запуск KPI Inc в Атырау: флагман нефтехимического кластера Казахстана',
      'Интегрированный газохимический комплекс KPI Inc в Атырауской области вышел на проектную мощность по производству полипропилена (до 500 тыс. тонн в год).\n\n⚙️ Это первый масштабный шаг Казахстана в глубокую переработку газа. Комплекс использует технологию Catofin от Lummus Technology и процесс Novolen для полимеризации. Продукция уже активно экспортируется в страны СНГ, Европу и Китай.\n\n#KPI #Атырау #нефтехимия #полипропилен #Казахстан',
      'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1200&q=80',
      now
    ]);
    
    await run(`
      INSERT INTO posts (title, content, media_url, status, scheduled_at, type)
      VALUES (?, ?, ?, 'scheduled', ?, 'organic')
    `, [
      'Модернизация «Навоиазот» и развитие химкластера Узбекистана',
      'Крупнейший химический комбинат Узбекистана АО «Navoiyazot» продолжает диверсификацию производства. Запущены новые мощности по выпуску ПВХ (поливинилхлорида) и каустической соды.\n\n💡 Развитие химического кластера в Навои создает синергию для всей Центральной Азии, обеспечивая полимерами строительный и упаковочный сектора.\n\n#Navoiyazot #Узбекистан #СНГ #полимеры #ПВХ',
      'https://images.unsplash.com/photo-1563986768609-322da13575f3?auto=format&fit=crop&w=1200&q=80',
      scheduledTime
    ]);
    
    await run(`
      INSERT INTO posts (title, content, media_url, status, type)
      VALUES (?, ?, ?, 'draft', 'organic')
    `, [
      'Черновик: Перспективы завода по производству полиэтилена Silleno',
      'Будущий завод Silleno в Атырауской области мощностью 1,25 млн тонн полиэтилена в год привлечет более 7 млрд долларов инвестиций. Проект реализуется КазМунайГазом совместно с СИБУРом и Sinopec.\n\n#Silleno #полиэтилен #Казахстан #нефтехимия',
      'https://images.unsplash.com/photo-1542060748-10c28b629f6f?auto=format&fit=crop&w=1200&q=80'
    ]);

    // 4. Комментарии к первому опубликованному посту
    const postId = post1.lastID || 1;
    await run(`
      INSERT INTO comments (telegram_message_id, post_id, username, text, sentiment, created_at)
      VALUES (?, ?, '@Arman_KNG', 'Отличные новости! Наконец-то начали производить полимеры высокого передела прямо у нас.', 'positive', ?)
    `, [10001, postId, now]);

    await run(`
      INSERT INTO comments (telegram_message_id, post_id, username, text, sentiment, created_at)
      VALUES (?, ?, '@Dmitry_Oil', 'Комплекс огромный. Хватит ли стабильных объемов пропана с Тенгиза для полной загрузки круглый год?', 'neutral', ?)
    `, [10002, postId, now]);

    await run(`
      INSERT INTO comments (telegram_message_id, post_id, username, text, sentiment, created_at)
      VALUES (?, ?, '@Skeptik_01', 'Экспорт идет, а внутренние производители пластиковых изделий все еще жалуются на цены на сырье.', 'negative', ?)
    `, [10003, postId, now]);

    // 5. Рекламный заказ
    const adPost = await run(`
      INSERT INTO posts (title, content, media_url, status, scheduled_at, type)
      VALUES (?, ?, ?, 'scheduled', ?, 'ad')
    `, [
      'Спецпроект: Минеральные удобрения от АО «КазАзот»',
      'АО «КазАзот» представляет обновленную линейку азотных удобрений (аммиачная селитра) для аграриев Казахстана и стран СНГ. Гарантия высокой урожайности и соответствие мировым экологическим стандартам.\n\n📞 Подробности и заказы на сайте kazazot.kz\n\n#реклама #удобрения #КазАзот #Актау #сельхоз',
      'https://images.unsplash.com/photo-1563986768609-322da13575f3?auto=format&fit=crop&w=1200&q=80',
      scheduledTime
    ]);

    await run(`
      INSERT INTO orders (advertiser_name, amount_paid, publish_date, post_id, status)
      VALUES (?, 150000, ?, ?, 'paid')
    `, ['АО КазАзот', scheduledTime, adPost.lastID || 4]);

    console.log('🌱 DB: База успешно заполнена демонстрационными данными.');
  } catch (err) {
    console.error('❌ DB: Ошибка заполнения демо-данными:', err.message);
  }
}

module.exports = {
  init,
  query,
  get,
  run,
  isProd
};
