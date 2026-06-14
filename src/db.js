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
  let convertedSql = convertPlaceholders(sql);

  if (isProd) {
    // PostgreSQL не возвращает auto-generated id без RETURNING — иначе lastID = null,
    // а вызывающий код потом дёргает /api/posts/null/publish и ловит "invalid input syntax for type integer".
    // Для обычных INSERT'ов автоматически добавляем RETURNING id, ИСКЛЮЧАЯ upsert'ы (ON CONFLICT)
    // — те используются для таблиц с не-id первичным ключом (settings.key, stats.date), где
    // RETURNING id вызовет 'column "id" does not exist'.
    const isInsert = /^\s*INSERT\s+INTO/i.test(convertedSql);
    const hasReturning = /\bRETURNING\b/i.test(convertedSql);
    const hasOnConflict = /\bON\s+CONFLICT\b/i.test(convertedSql);
    if (isInsert && !hasReturning && !hasOnConflict) {
      convertedSql += ' RETURNING id';
    }
    return pgPool.query(convertedSql, params).then(res => {
      return {
        changes: res.rowCount,
        lastID: res.rows && res.rows[0] ? res.rows[0].id : null
      };
    });
  }

  return new Promise((resolve, reject) => {
    sqliteDb.run(convertedSql, params, function(err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
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
      telegram_message_id BIGINT,
      telegraph_url TEXT,
      telegraph_path TEXT,
      reactions TEXT
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
      telegram_message_id INTEGER,
      telegraph_url TEXT,
      telegraph_path TEXT,
      reactions TEXT
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
    await migrateAddTelegraphColumns();
    await migrateAddReactions();
    await migrateAddCarData();
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

// Добавляет колонки telegraph_url + telegraph_path в posts — нужно чтобы при редактировании
// поста уметь дёрнуть Telegraph editPage по path и обновить статью.
async function migrateAddTelegraphColumns() {
  const cols = isProd
    ? ['ALTER TABLE posts ADD COLUMN IF NOT EXISTS telegraph_url TEXT',
       'ALTER TABLE posts ADD COLUMN IF NOT EXISTS telegraph_path TEXT']
    : ['ALTER TABLE posts ADD COLUMN telegraph_url TEXT',
       'ALTER TABLE posts ADD COLUMN telegraph_path TEXT'];
  for (const sql of cols) {
    try { await run(sql); }
    catch (err) { if (!/duplicate column/i.test(err.message)) throw err; }
  }
}

// Колонка reactions хранит JSON-карту {emoji: count} полученных от Telegram через
// message_reaction_count webhook'и. Обновляется live, отображается в админке.
async function migrateAddReactions() {
  const sql = isProd
    ? 'ALTER TABLE posts ADD COLUMN IF NOT EXISTS reactions TEXT'
    : 'ALTER TABLE posts ADD COLUMN reactions TEXT';
  try { await run(sql); }
  catch (err) { if (!/duplicate column/i.test(err.message)) throw err; }
}

// car_data — JSON с характеристиками автомобиля для type='car_listing'.
// Структура: {brand, model, year, mileage_km, body, transmission, drivetrain, color,
//   condition, city, photos:[urls], wants:{brand, model, year_from, doplata_kzt, doplata_direction},
//   owner:{telegram_id, username, first_name, contact},
//   vin, vin_check:{status, found_issues, source_url},
//   price_evaluation:{owner_asks_kzt, market_min, market_avg, market_max, salon_estimate, sources:[]}}
async function migrateAddCarData() {
  const sql = isProd
    ? 'ALTER TABLE posts ADD COLUMN IF NOT EXISTS car_data TEXT'
    : 'ALTER TABLE posts ADD COLUMN car_data TEXT';
  try { await run(sql); }
  catch (err) { if (!/duplicate column/i.test(err.message)) throw err; }
}

async function seedDemoData() {
  try {
    const existing = await get("SELECT value FROM settings WHERE key = 'auto_post'");
    if (existing) return;

    console.log('🌱 DB: Заполнение демо-данными (Авто обмен Казахстан)...');

    await run("INSERT INTO settings (key, value) VALUES ('auto_post', 'false')");
    await run("INSERT INTO settings (key, value) VALUES ('channels_list', '@avto_obmen_kz')");

    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(today.getDate() - i);
      const dateString = date.toISOString().split('T')[0];
      await run(
        "INSERT INTO stats (date, subscribers_count, total_views, active_engagement) VALUES (?, ?, ?, ?)",
        [dateString, 100 + i * 5, 80 + Math.floor(Math.random() * 50), 5 + Math.floor(Math.random() * 8)]
      );
    }

    const now = new Date().toISOString();
    const sampleCar = {
      brand: 'Toyota', model: 'Camry', year: 2020,
      mileage_km: 78000, body: 'Седан', transmission: 'АКПП', drivetrain: 'Передний',
      color: 'Белый', condition: 'Отличное',
      city: 'Алматы',
      photos: ['https://upload.wikimedia.org/wikipedia/commons/3/3a/2018_Toyota_Camry_%28ASV70R%29_Ascent_sedan_%282018-08-27%29_01.jpg'],
      wants: { brand: 'Toyota', model: 'Hilux', year_from: 2018, doplata_kzt: 2000000, doplata_direction: 'я доплачиваю' },
      owner: { telegram_id: 396019118, username: 'A_Dula', first_name: 'Дулат', contact: '@A_Dula' },
      price_evaluation: {
        owner_asks_kzt: 14500000,
        market_min: 14000000, market_avg: 14800000, market_max: 15500000,
        salon_estimate: 12000000,
        sources: [{ url: 'https://kolesa.kz/cars/toyota/camry/', title: 'Toyota Camry 2020 на kolesa.kz' }]
      }
    };

    await run(`
      INSERT INTO posts (title, content, media_url, status, type, car_data)
      VALUES (?, ?, ?, 'draft', 'car_listing', ?)
    `, [
      'Демо: Toyota Camry 2020 → ищу Hilux',
      'Демо-заявка на обмен. Одобри в админке для теста публикации.',
      sampleCar.photos[0],
      JSON.stringify(sampleCar)
    ]);

    console.log('🌱 DB: Демо-данные посеяны.');
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
