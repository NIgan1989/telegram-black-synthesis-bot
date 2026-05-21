const Parser = require('rss-parser');
const dotenv = require('dotenv');

dotenv.config();

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  }
});

const isDemo = process.env.DEMO_MODE === 'true';

// Поисковые запросы для Google News RSS
const SEARCH_QUERIES = [
  'нефтехимия Казахстан',
  'химический кластер СНГ',
  'производство полимеров СНГ',
  'удобрения нефтехимия',
  'petrochemical cluster Kazakhstan'
];

// Прямые RSS ленты (по выбору)
const DIRECT_RSS_FEEDS = [
  'https://neftegaz.ru/xml/rss_ru.xml' // Популярный нефтегазовый портал СНГ
];

// Функция для получения свежих новостей
async function fetchLatestNews() {
  if (isDemo) {
    console.log('📰 Сборщик (Демо): Генерация случайных новостных заголовков...');
    return mockLatestNews();
  }

  const allNews = [];
  const processedTitles = new Set();

  // 1. Сбор новостей через Google News RSS по ключевым словам
  for (const query of SEARCH_QUERIES) {
    try {
      const encodedQuery = encodeURIComponent(query);
      const url = `https://news.google.com/rss/search?q=${encodedQuery}&hl=ru&gl=RU&ceid=RU:ru`;
      
      console.log(`📡 Сборщик: Запрос Google News RSS для "${query}"...`);
      const feed = await parser.parseURL(url);
      
      for (const item of feed.items) {
        if (!processedTitles.has(item.title)) {
          processedTitles.add(item.title);
          allNews.push({
            title: item.title,
            link: item.link,
            description: item.contentSnippet || item.content || '',
            pubDate: item.pubDate,
            source: 'Google News'
          });
        }
      }
    } catch (error) {
      console.error(`❌ Сборщик: Ошибка сбора для запроса "${query}":`, error.message);
    }
  }

  // 2. Сбор из прямых отраслевых RSS-лент
  for (const url of DIRECT_RSS_FEEDS) {
    try {
      console.log(`📡 Сборщик: Запрос RSS-ленты: ${url}...`);
      const feed = await parser.parseURL(url);
      
      for (const item of feed.items) {
        if (!processedTitles.has(item.title)) {
          processedTitles.add(item.title);
          allNews.push({
            title: item.title,
            link: item.link,
            description: item.contentSnippet || item.content || '',
            pubDate: item.pubDate,
            source: feed.title || 'Direct RSS'
          });
        }
      }
    } catch (error) {
      console.error(`❌ Сборщик: Ошибка сбора с RSS-ленты ${url}:`, error.message);
    }
  }

  // Сортировка по дате (свежие впереди)
  allNews.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return allNews.slice(0, 15); // Возвращаем 15 самых свежих новостей
}

// Имитационные новости для демо-режима
function mockLatestNews() {
  const mockArticles = [
    {
      title: 'KPI Inc в Атырау наращивает экспорт полипропилена в страны СНГ',
      link: 'https://example.com/kpi-polypropylene-export',
      description: 'Атырауский газохимический комплекс KPI Inc отгрузил рекордную партию полипропилена. Основными потребителями стали переработчики пластмасс из России, Узбекистана и Белоруссии.',
      pubDate: new Date().toUTCString(),
      source: 'Central Asia Chem'
    },
    {
      title: 'Модернизация производства азотной кислоты на «КазАзот» в Актау',
      link: 'https://example.com/kazazot-nitric-acid-modernization',
      description: 'Единственный производитель аммиака и аммиачной селитры в Казахстане АО «КазАзот» завершил модернизацию отделения азотной кислоты, снизив выбросы NOx на 25%.',
      pubDate: new Date(Date.now() - 3600000 * 5).toUTCString(),
      source: 'EcoIndustry'
    },
    {
      title: 'Navoiyazot запустил новую линию поливинилхлорида (ПВХ)',
      link: 'https://example.com/navoiyazot-pvc-launch',
      description: 'Узбекский химический гигант «Навоиазот» успешно завершил пусконаладочные работы на второй очереди комплекса ПВХ, что позволит полностью закрыть внутренний спрос и увеличить экспорт.',
      pubDate: new Date(Date.now() - 3600000 * 12).toUTCString(),
      source: 'Uzbekistan News'
    },
    {
      title: 'Казахстан и СИБУР обсуждают детали проекта производства полиэтилена Silleno',
      link: 'https://example.com/silleno-polyethylene-project',
      description: 'В Атырау состоялась встреча руководства КМГ, СИБУРа и Sinopec. Стороны утвердили график строительства гиганта Silleno мощностью 1,25 млн тонн полиэтилена в год.',
      pubDate: new Date(Date.now() - 3600000 * 24).toUTCString(),
      source: 'Petrochem Today'
    },
    {
      title: 'Рынок минеральных удобрений СНГ: рост спроса стимулирует новые мощности',
      link: 'https://example.com/cis-fertilizer-market-growth',
      description: 'Аналитики отмечают дефицит фосфорных и азотных удобрений в регионе. Ведущие игроки, такие как «КазФосфат» и «ЕвроХим», объявляют о расширении инвестиционных программ.',
      pubDate: new Date(Date.now() - 3600000 * 48).toUTCString(),
      source: 'Chemical Digest'
    }
  ];

  return mockArticles.sort(() => Math.random() - 0.5);
}

module.exports = {
  fetchLatestNews
};
