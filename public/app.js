// ----------------------------------------------------
// 🔥 Refinery Channel Admin - Frontend JS Logic
// ----------------------------------------------------

const tg = window.Telegram.WebApp;
let currentUser = null;
let charts = {};

// Глобальное состояние
let state = {
  currentTab: 'overview',
  postFilter: 'draft',
  stats: null,
  posts: [],
  orders: [],
  comments: [],
  settings: {}
};

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', async () => {
  console.log('📱 Инициализация Telegram WebApp...');
  
  // Сигнализируем Telegram, что приложение готово
  tg.ready();
  tg.expand();
  
  // Стилизация под Telegram тему
  tg.setHeaderColor('#070913');
  tg.setBackgroundColor('#070913');

  // Извлекаем информацию о пользователе из Telegram SDK
  const user = tg.initDataUnsafe?.user;
  const initDataRaw = tg.initData;

  // Авторизация
  const authSuccess = await authenticateUser(user, initDataRaw);
  
  if (authSuccess) {
    document.getElementById('loader').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    
    // Инициализируем навигацию и обработчики событий
    initNavigation();
    initEventHandlers();
    
    // Загружаем первоначальные данные
    await refreshAllData();
  }
});

// ---------------------------------------------
// 🔑 Авторизация
// ---------------------------------------------
async function authenticateUser(tgUser, initDataRaw) {
  try {
    const userId = tgUser ? tgUser.id : 'demo_id';
    
    const response = await fetch('/api/auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': encodeURIComponent(initDataRaw || userId)
      },
      body: JSON.stringify({
        initDataRaw: initDataRaw,
        userId: userId
      })
    });

    if (response.ok) {
      const data = await response.json();
      currentUser = data.user;
      console.log('✅ Авторизация успешна. Роль:', currentUser.role);
      
      // Обновляем статус бота
      document.getElementById('bot-status-dot').className = 'pulse-dot active';
      document.getElementById('bot-status-text').innerText = 'Активен';
      
      return true;
    } else {
      const errData = await response.json();
      showAccessDenied(errData.error || 'Доступ запрещен');
      return false;
    }
  } catch (err) {
    console.warn('⚠️ Ошибка соединения с сервером авторизации. Включение демо-режима...');
    // Если бэкенд не отвечает, разрешаем войти в демо-режиме для визуализации
    currentUser = { username: 'demo_user', role: 'Владелец (Локальная симуляция)' };
    document.getElementById('loader').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    initNavigation();
    initEventHandlers();
    await refreshAllData();
    
    document.getElementById('bot-status-dot').className = 'pulse-dot active';
    document.getElementById('bot-status-text').innerText = 'Демо-режим';
    
    return true;
  }
}

function showAccessDenied(reason) {
  document.getElementById('loader').classList.add('hidden');
  const deniedContainer = document.getElementById('access-denied');
  deniedContainer.classList.remove('hidden');
  document.getElementById('denied-reason').innerText = reason;
}

// Получение заголовков для API запросов
function getHeaders() {
  const initDataRaw = tg.initData;
  const userId = tg.initDataUnsafe?.user?.id || 'demo_id';
  return {
    'Content-Type': 'application/json',
    'Authorization': encodeURIComponent(initDataRaw || userId)
  };
}

// ---------------------------------------------
// 🧭 Навигация и Табы
// ---------------------------------------------
function initNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const tabContents = document.querySelectorAll('.tab-content');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const tabId = item.getAttribute('data-tab');
      
      // Смена активного класса в меню
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      
      // Смена отображаемого таба
      tabContents.forEach(tab => {
        tab.classList.remove('active');
        if (tab.id === `tab-${tabId}`) {
          tab.classList.add('active');
        }
      });

      state.currentTab = tabId;
      console.log(`📂 Переключение на вкладку: ${tabId}`);
      
      // Дополнительное действие при открытии таба
      onTabOpened(tabId);
    });
  });
}

function onTabOpened(tabId) {
  if (tabId === 'posts') {
    loadPosts();
  } else if (tabId === 'orders') {
    loadOrders();
  } else if (tabId === 'comments') {
    loadComments();
  } else if (tabId === 'settings') {
    loadSettings();
  } else if (tabId === 'overview') {
    loadStats();
  }
}

// ---------------------------------------------
// 🔄 Получение и обновление данных
// ---------------------------------------------
async function refreshAllData() {
  await Promise.all([
    loadStats(),
    loadPosts(),
    loadOrders(),
    loadComments(),
    loadSettings()
  ]);
}

// 1. Статистика
async function loadStats() {
  try {
    const res = await fetch('/api/stats', { headers: getHeaders() });
    if (!res.ok) throw new Error('Ошибка сети');
    const data = await res.json();
    state.stats = data;
    
    // Обновляем метрики на главном экране
    document.getElementById('metric-posts').innerText = data.summary.totalPosts;
    document.getElementById('metric-comments').innerText = data.summary.totalComments;
    document.getElementById('metric-ads-count').innerText = data.summary.completedOrders;
    
    const sentiments = data.summary.sentiments;
    const totalSentiments = sentiments.positive + sentiments.neutral + sentiments.negative;
    let sentimentIndex = 'Нейтральный';
    
    if (totalSentiments > 0) {
      if (sentiments.positive > sentiments.negative * 1.5) {
        sentimentIndex = 'Позитивный 🔥';
        document.getElementById('metric-sentiment-index').className = 'green-text';
      } else if (sentiments.negative > sentiments.positive * 1.2) {
        sentimentIndex = 'Критический ⚠️';
        document.getElementById('metric-sentiment-index').className = 'red-text';
      }
    }
    document.getElementById('metric-sentiment-index').innerText = sentimentIndex;

    // Отрисовка графиков
    renderSubscribersChart(data.history);
    renderSentimentChart(data.summary.sentiments);
  } catch (err) {
    console.error('Ошибка загрузки статистики:', err);
  }
}

// 2. Посты
async function loadPosts() {
  try {
    const res = await fetch(`/api/posts?status=${state.postFilter}`, { headers: getHeaders() });
    if (!res.ok) throw new Error('Ошибка сети');
    const posts = await res.json();
    state.posts = posts;
    renderPostsList(posts);
  } catch (err) {
    console.error('Ошибка загрузки постов:', err);
  }
}

// 3. Заказы
async function loadOrders() {
  try {
    const res = await fetch('/api/orders', { headers: getHeaders() });
    if (!res.ok) throw new Error('Ошибка сети');
    const orders = await res.json();
    state.orders = orders;
    
    // Считаем выручку
    const totalRev = orders
      .filter(o => o.status === 'completed' || o.status === 'paid')
      .reduce((sum, o) => sum + parseFloat(o.amount_paid || 0), 0);
    
    const activeOrd = orders.filter(o => o.status === 'paid').length;
    
    document.getElementById('metric-revenue').innerText = `${totalRev.toLocaleString()} ₸`;
    document.getElementById('ad-total-revenue').innerText = `${totalRev.toLocaleString()} ₸`;
    document.getElementById('ad-active-orders').innerText = activeOrd;
    document.getElementById('ad-total-orders').innerText = orders.length;

    renderOrdersTable(orders);
  } catch (err) {
    console.error('Ошибка загрузки заказов:', err);
  }
}

// 4. Комментарии
async function loadComments() {
  try {
    const res = await fetch('/api/comments', { headers: getHeaders() });
    if (!res.ok) throw new Error('Ошибка сети');
    const comments = await res.json();
    state.comments = comments;
    renderCommentsFeed(comments);
  } catch (err) {
    console.error('Ошибка загрузки комментариев:', err);
  }
}

// 5. Настройки
async function loadSettings() {
  try {
    const res = await fetch('/api/settings', { headers: getHeaders() });
    if (!res.ok) throw new Error('Ошибка сети');
    const settings = await res.json();
    state.settings = settings;
    
    // Заполняем форму настроек
    document.getElementById('setting-auto-post').checked = settings.auto_post === 'true';
    document.getElementById('setting-channels-list').value = settings.channels_list || '';
    document.getElementById('setting-post-interval').value = settings.post_interval || '6';
    
    if (settings.channels_list) {
      document.getElementById('channel-username').innerText = settings.channels_list;
    }
  } catch (err) {
    console.error('Ошибка загрузки настроек:', err);
  }
}

// ---------------------------------------------
// 🖥️ Отрисовка элементов UI (Рендеринг)
// ---------------------------------------------

// Отрисовка списка постов (черновики/опубликованные)
function renderPostsList(posts) {
  const container = document.getElementById('posts-list');
  container.innerHTML = '';
  
  if (posts.length === 0) {
    container.innerHTML = `
      <div class="no-data glass">
        <i class="fa-solid fa-folder-open"></i>
        <p>Нет постов в категории "${getFilterName(state.postFilter)}"</p>
      </div>
    `;
    return;
  }

  posts.forEach(post => {
    const card = document.createElement('div');
    card.className = 'post-card glass mt-1';
    
    const formattedDate = post.published_at 
      ? new Date(post.published_at).toLocaleString('ru-RU') 
      : post.scheduled_at 
        ? `Запланирован: ${new Date(post.scheduled_at).toLocaleString('ru-RU')}`
        : 'Черновик';

    const imageHtml = post.media_url 
      ? `<img src="${post.media_url}" class="post-card-media" alt="post-img">` 
      : '';

    const badgeText = post.type === 'ad' ? 'Реклама' : 'Статья';
    const badgeClass = post.type === 'ad' ? 'ad' : 'organic';

    // Кнопки управления в зависимости от статуса
    let actionButtons = '';
    if (post.status === 'draft') {
      actionButtons = `
        <button class="btn btn-secondary btn-sm edit-post-btn" data-id="${post.id}">✏️ Изменить</button>
        <button class="btn btn-primary btn-sm publish-post-btn" data-id="${post.id}">🚀 Опубликовать</button>
      `;
    } else if (post.status === 'scheduled') {
      actionButtons = `
        <button class="btn btn-secondary btn-sm edit-post-btn" data-id="${post.id}">✏️ Изменить</button>
        <button class="btn btn-danger btn-sm cancel-post-btn" data-id="${post.id}">❌ Отменить</button>
      `;
    } else {
      actionButtons = `
        <button class="btn btn-secondary btn-sm delete-post-btn" data-id="${post.id}">🗑️ Удалить из БД</button>
      `;
    }

    card.innerHTML = `
      <div class="post-card-header">
        <h3>${post.title}</h3>
        <span class="post-type-badge ${badgeClass}">${badgeText}</span>
      </div>
      ${imageHtml}
      <div class="post-card-body">${post.content}</div>
      <div class="post-card-actions">
        <span class="post-date">${formattedDate}</span>
        ${actionButtons}
      </div>
    `;
    
    container.appendChild(card);
  });

  // Прикрепляем слушатели к динамическим кнопкам постов
  attachPostButtonsListeners();
}

function getFilterName(filter) {
  if (filter === 'draft') return 'Черновики';
  if (filter === 'scheduled') return 'Запланированные';
  return 'Опубликованные';
}

// Отрисовка таблицы заказов рекламы
function renderOrdersTable(orders) {
  const tbody = document.getElementById('orders-list-body');
  tbody.innerHTML = '';
  
  if (orders.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center py-2">Рекламные заказы не найдены</td>
      </tr>
    `;
    return;
  }

  orders.forEach(order => {
    const tr = document.createElement('tr');
    
    const formattedDate = new Date(order.publish_date).toLocaleString('ru-RU');
    const statusText = order.status === 'completed' ? 'Завершен' 
      : order.status === 'paid' ? 'Оплачен' 
      : order.status === 'pending' ? 'Ожидает' : 'Отменен';
      
    const statusClass = order.status;

    let actions = '';
    if (order.status === 'pending') {
      actions = `<button class="btn btn-success btn-sm approve-order-btn" data-id="${order.id}">✓ Одобрить</button>`;
    } else if (order.status === 'paid') {
      actions = `<button class="btn btn-secondary btn-sm complete-order-btn" data-id="${order.id}">✅ Выполнен</button>`;
    } else {
      actions = `<button class="btn btn-secondary btn-sm delete-order-btn" data-id="${order.id}" disabled>🗑️</button>`;
    }

    tr.innerHTML = `
      <td><strong>${order.advertiser_name}</strong></td>
      <td>${parseFloat(order.amount_paid).toLocaleString()} ₸</td>
      <td>${formattedDate}</td>
      <td>${order.post_title || 'Создается...'}</td>
      <td><span class="status-badge ${statusClass}">${statusText}</span></td>
      <td>${actions}</td>
    `;
    tbody.appendChild(tr);
  });
  
  attachOrderButtonsListeners();
}

// Отрисовка ленты комментариев
function renderCommentsFeed(comments) {
  const container = document.getElementById('comments-feed');
  container.innerHTML = '';
  
  if (comments.length === 0) {
    container.innerHTML = `
      <div class="no-data glass">
        <i class="fa-solid fa-comments"></i>
        <p>Комментарии отсутствуют</p>
      </div>
    `;
    return;
  }

  comments.forEach(comment => {
    const card = document.createElement('div');
    card.className = 'comment-card glass mt-1';
    
    const sentimentText = comment.sentiment === 'positive' ? 'Позитив 👍'
      : comment.sentiment === 'negative' ? 'Негатив 👎' : 'Нейтрально';
    
    const formattedDate = new Date(comment.created_at).toLocaleString('ru-RU');

    card.innerHTML = `
      <div class="comment-header">
        <span class="comment-user">${comment.username}</span>
        <span class="sentiment-badge ${comment.sentiment}">${sentimentText}</span>
      </div>
      <p class="comment-text">"${comment.text}"</p>
      <div class="comment-footer">
        <span class="comment-post-title">Тема: ${comment.post_title || 'Общие вопросы'}</span>
        <span>${formattedDate}</span>
      </div>
    `;
    container.appendChild(card);
  });
}

// ---------------------------------------------
// 📈 Построение Графиков (Chart.js)
// ---------------------------------------------

function renderSubscribersChart(history) {
  const ctx = document.getElementById('subscribersChart').getContext('2d');
  
  // Уничтожаем старый график, если есть
  if (charts.subscribers) {
    charts.subscribers.destroy();
  }

  // Данные по умолчанию, если истории нет
  let labels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  let values = [1240, 1242, 1245, 1247, 1249, 1251, 1254];

  if (history && history.length > 0) {
    labels = history.map(h => {
      const date = new Date(h.date);
      return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    });
    values = history.map(h => h.subscribers_count);
    
    // Обновляем счетчик подписчиков в метрике на главном
    const currentSubscribers = values[values.length - 1] || 0;
    const prevSubscribers = values[values.length - 2] || currentSubscribers;
    const diff = currentSubscribers - prevSubscribers;
    
    document.getElementById('metric-subscribers').innerText = currentSubscribers.toLocaleString();
    const changeElem = document.getElementById('metric-subscribers-change');
    if (diff >= 0) {
      changeElem.innerHTML = `<i class="fa-solid fa-arrow-trend-up"></i> +${diff} сегодня`;
      changeElem.className = 'metric-change positive';
    } else {
      changeElem.innerHTML = `<i class="fa-solid fa-arrow-trend-down"></i> ${diff} сегодня`;
      changeElem.className = 'metric-change negative';
    }
  }

  charts.subscribers = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Подписчики',
        data: values,
        borderColor: '#6366f1',
        backgroundColor: 'rgba(99, 102, 241, 0.1)',
        borderWidth: 3,
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#6366f1',
        pointRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#9ca3af', font: { family: 'Inter' } }
        },
        x: {
          grid: { display: false },
          ticks: { color: '#9ca3af', font: { family: 'Inter' } }
        }
      }
    }
  });
}

function renderSentimentChart(sentiments) {
  const ctx = document.getElementById('sentimentChart').getContext('2d');
  
  if (charts.sentiment) {
    charts.sentiment.destroy();
  }

  const values = [
    sentiments.positive || 0,
    sentiments.neutral || 0,
    sentiments.negative || 0
  ];
  
  const hasData = values.some(v => v > 0);

  charts.sentiment = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Позитивные', 'Нейтральные', 'Негативные'],
      datasets: [{
        data: hasData ? values : [1, 1, 1], // Временные данные для пустой диаграммы
        backgroundColor: hasData 
          ? ['#22c55e', '#6b7280', '#ef4444'] 
          : ['rgba(255,255,255,0.05)', 'rgba(255,255,255,0.05)', 'rgba(255,255,255,0.05)'],
        borderWidth: 0,
        hoverOffset: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: {
            color: '#f3f4f6',
            font: { family: 'Inter', size: 10 }
          }
        }
      },
      cutout: '70%'
    }
  });
}

// ---------------------------------------------
// 🎛️ Обработчики событий (Event Handlers)
// ---------------------------------------------
function initEventHandlers() {
  
  // 1. Кнопки фильтрации постов
  const filterBtns = document.querySelectorAll('.filter-btn');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.postFilter = btn.getAttribute('data-status');
      loadPosts();
    });
  });

  // 2. Сборщик постов по требованию (ИИ-генерация)
  const triggerBtn = document.getElementById('btn-trigger-aggregation');
  triggerBtn.addEventListener('click', async () => {
    // Включаем спиннер на кнопке
    const originalHtml = triggerBtn.innerHTML;
    triggerBtn.disabled = true;
    triggerBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Сбор новостей...`;

    try {
      const res = await fetch('/api/cron-trigger', {
        method: 'POST',
        headers: getHeaders()
      });
      
      if (res.ok) {
        const data = await res.json();
        tg.showPopup({
          title: 'Успешно',
          message: `Сбор завершен! Создано новых черновиков: ${data.createdCount}`,
          buttons: [{ type: 'ok' }]
        });
        await loadPosts();
      } else {
        throw new Error('Ошибка вызова API');
      }
    } catch (e) {
      console.error(e);
      tg.showPopup({
        title: 'Ошибка',
        message: 'Не удалось запустить сбор новостей.',
        buttons: [{ type: 'close' }]
      });
    } finally {
      triggerBtn.disabled = false;
      triggerBtn.innerHTML = originalHtml;
    }
  });

  // 3. Форма настроек
  const settingsForm = document.getElementById('settings-form');
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const settings = {
      auto_post: document.getElementById('setting-auto-post').checked ? 'true' : 'false',
      channels_list: document.getElementById('setting-channels-list').value,
      post_interval: document.getElementById('setting-post-interval').value
    };

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(settings)
      });

      if (res.ok) {
        tg.showPopup({
          title: 'Настройки',
          message: 'Настройки успешно сохранены!',
          buttons: [{ type: 'ok' }]
        });
        await loadSettings();
      } else {
        throw new Error();
      }
    } catch (err) {
      tg.showPopup({
        title: 'Ошибка',
        message: 'Не удалось сохранить настройки.',
        buttons: [{ type: 'close' }]
      });
    }
  });

  // 4. Модальное окно Рекламы (Заказов)
  const openOrderBtn = document.getElementById('btn-open-order-modal');
  const closeOrderBtn = document.getElementById('btn-close-order-modal');
  const cancelOrderBtn = document.getElementById('btn-cancel-order');
  const orderModal = document.getElementById('order-modal');

  openOrderBtn.addEventListener('click', () => {
    // Установим текущее время + 1 час по дефолту
    const defaultDate = new Date(Date.now() + 3600000);
    defaultDate.setMinutes(0);
    // Преобразуем в локальную строку для datetime-local
    const pad = num => String(num).padStart(2, '0');
    const localStr = `${defaultDate.getFullYear()}-${pad(defaultDate.getMonth()+1)}-${pad(defaultDate.getDate())}T${pad(defaultDate.getHours())}:${pad(defaultDate.getMinutes())}`;
    
    document.getElementById('order-date').value = localStr;
    orderModal.classList.remove('hidden');
  });

  const closeModal = () => orderModal.classList.add('hidden');
  closeOrderBtn.addEventListener('click', closeModal);
  cancelOrderBtn.addEventListener('click', closeModal);

  // Сабмит формы заказа рекламы
  const orderForm = document.getElementById('order-form');
  orderForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const body = {
      advertiser_name: document.getElementById('order-advertiser').value,
      amount_paid: document.getElementById('order-amount').value,
      publish_date: new Date(document.getElementById('order-date').value).toISOString(),
      title: document.getElementById('order-post-title').value,
      content: document.getElementById('order-post-content').value,
      media_url: document.getElementById('order-post-media').value
    };

    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(body)
      });

      if (res.ok) {
        closeModal();
        orderForm.reset();
        tg.showPopup({
          title: 'Успешно',
          message: 'Рекламный пост запланирован и сохранен в системе.',
          buttons: [{ type: 'ok' }]
        });
        await loadOrders();
      } else {
        throw new Error();
      }
    } catch (e) {
      tg.showPopup({
        title: 'Ошибка',
        message: 'Не удалось создать рекламный заказ.',
        buttons: [{ type: 'close' }]
      });
    }
  });

  // 5. Модальное окно редактирования поста
  const closePostBtn = document.getElementById('btn-close-post-modal');
  const cancelPostBtn = document.getElementById('btn-cancel-post-edit');
  const postModal = document.getElementById('post-modal');

  const closePostModal = () => postModal.classList.add('hidden');
  closePostBtn.addEventListener('click', closePostModal);
  cancelPostBtn.addEventListener('click', closePostModal);

  // Сохранение изменений в посте
  const postEditForm = document.getElementById('post-edit-form');
  postEditForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const id = document.getElementById('edit-post-id').value;
    const body = {
      title: document.getElementById('edit-post-title').value,
      content: document.getElementById('edit-post-content').value,
      media_url: document.getElementById('edit-post-media').value,
      status: document.getElementById('edit-post-status').value,
      scheduled_at: document.getElementById('edit-post-schedule').value
        ? new Date(document.getElementById('edit-post-schedule').value).toISOString()
        : null
    };

    try {
      const res = await fetch(`/api/posts/${id}`, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify(body)
      });

      if (res.ok) {
        closePostModal();
        tg.showPopup({
          title: 'Готово',
          message: 'Пост успешно обновлен.',
          buttons: [{ type: 'ok' }]
        });
        await loadPosts();
      } else {
        throw new Error();
      }
    } catch (err) {
      tg.showPopup({
        title: 'Ошибка',
        message: 'Не удалось обновить пост.',
        buttons: [{ type: 'close' }]
      });
    }
  });

  // Удаление поста из модалки
  const deletePostBtn = document.getElementById('btn-delete-post');
  deletePostBtn.addEventListener('click', async () => {
    const id = document.getElementById('edit-post-id').value;

    tg.showConfirm('Вы уверены, что хотите безвозвратно удалить этот пост?', async (confirmed) => {
      if (confirmed) {
        try {
          const res = await fetch(`/api/posts/${id}`, {
            method: 'DELETE',
            headers: getHeaders()
          });

          if (res.ok) {
            closePostModal();
            await loadPosts();
          } else {
            throw new Error();
          }
        } catch (e) {
          tg.showPopup({
            title: 'Ошибка',
            message: 'Не удалось удалить пост.',
            buttons: [{ type: 'close' }]
          });
        }
      }
    });
  });

  // 6. Модальное окно генерации поста по промпту (ИИ)
  initAiPromptModal();
}

function initAiPromptModal() {
  const aiModal = document.getElementById('ai-prompt-modal');
  const stagePrompt = document.getElementById('ai-stage-prompt');
  const stageResult = document.getElementById('ai-stage-result');
  const scheduleField = document.getElementById('ai-schedule-field');

  const openBtn = document.getElementById('btn-open-ai-prompt-modal');
  const closeBtn = document.getElementById('btn-close-ai-modal');
  const cancelBtn = document.getElementById('btn-cancel-ai');
  const generateBtn = document.getElementById('btn-generate-ai');
  const backBtn = document.getElementById('btn-ai-back-to-prompt');
  const saveDraftBtn = document.getElementById('btn-ai-save-draft');
  const scheduleBtn = document.getElementById('btn-ai-schedule');
  const publishBtn = document.getElementById('btn-ai-publish');

  const promptInput = document.getElementById('ai-user-prompt');
  const styleToggle = document.getElementById('ai-with-channel-style');
  const titleInput = document.getElementById('ai-result-title');
  const contentInput = document.getElementById('ai-result-content');
  const mediaInput = document.getElementById('ai-result-media');
  const scheduleInput = document.getElementById('ai-result-schedule');

  function resetModal() {
    stagePrompt.classList.remove('hidden');
    stageResult.classList.add('hidden');
    scheduleField.classList.add('hidden');
    promptInput.value = '';
    titleInput.value = '';
    contentInput.value = '';
    mediaInput.value = '';
    scheduleInput.value = '';
    styleToggle.checked = true;
  }

  function closeModal() {
    aiModal.classList.add('hidden');
    resetModal();
  }

  function showStage(name) {
    if (name === 'prompt') {
      stagePrompt.classList.remove('hidden');
      stageResult.classList.add('hidden');
    } else {
      stagePrompt.classList.add('hidden');
      stageResult.classList.remove('hidden');
    }
  }

  async function generate() {
    const prompt = promptInput.value.trim();
    if (prompt.length < 5) {
      tg.showPopup({ title: 'Промпт слишком короткий', message: 'Минимум 5 символов', buttons: [{ type: 'ok' }] });
      return;
    }
    const withChannelStyle = styleToggle.checked;
    const orig = generateBtn.innerHTML;
    generateBtn.disabled = true;
    generateBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Gemini думает...';

    try {
      const res = await fetch('/api/posts/generate', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ prompt, withChannelStyle })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка генерации');

      titleInput.value = data.title || '';
      contentInput.value = data.content || '';
      showStage('result');
    } catch (e) {
      tg.showPopup({ title: 'Ошибка', message: e.message, buttons: [{ type: 'close' }] });
    } finally {
      generateBtn.disabled = false;
      generateBtn.innerHTML = orig;
    }
  }

  async function savePost(status, scheduledAt) {
    const body = {
      title: titleInput.value.trim(),
      content: contentInput.value.trim(),
      media_url: mediaInput.value.trim() || null,
      status,
      scheduled_at: scheduledAt || null,
      type: 'organic'
    };
    if (!body.title || !body.content) {
      throw new Error('Заголовок и текст обязательны');
    }
    const res = await fetch('/api/posts', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Не удалось сохранить пост');
    return data;
  }

  openBtn.addEventListener('click', () => {
    resetModal();
    aiModal.classList.remove('hidden');
  });
  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  generateBtn.addEventListener('click', generate);
  backBtn.addEventListener('click', () => showStage('prompt'));

  saveDraftBtn.addEventListener('click', async () => {
    try {
      await savePost('draft');
      closeModal();
      tg.showPopup({ title: 'Сохранено', message: 'Пост добавлен в черновики', buttons: [{ type: 'ok' }] });
      await loadPosts();
    } catch (e) {
      tg.showPopup({ title: 'Ошибка', message: e.message, buttons: [{ type: 'close' }] });
    }
  });

  scheduleBtn.addEventListener('click', async () => {
    // Первое нажатие — показываем поле даты с дефолтом +1 час
    if (scheduleField.classList.contains('hidden')) {
      const d = new Date(Date.now() + 3600000);
      d.setMinutes(0);
      const pad = n => String(n).padStart(2, '0');
      scheduleInput.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      scheduleField.classList.remove('hidden');
      return;
    }
    // Второе нажатие — сохраняем как scheduled
    if (!scheduleInput.value) {
      tg.showPopup({ title: 'Внимание', message: 'Выбери дату публикации', buttons: [{ type: 'ok' }] });
      return;
    }
    try {
      await savePost('scheduled', new Date(scheduleInput.value).toISOString());
      closeModal();
      tg.showPopup({ title: 'Запланировано', message: 'Пост будет опубликован в указанное время', buttons: [{ type: 'ok' }] });
      await loadPosts();
    } catch (e) {
      tg.showPopup({ title: 'Ошибка', message: e.message, buttons: [{ type: 'close' }] });
    }
  });

  publishBtn.addEventListener('click', () => {
    tg.showConfirm('Опубликовать этот пост в канал прямо сейчас?', async (confirmed) => {
      if (!confirmed) return;
      const orig = publishBtn.innerHTML;
      publishBtn.disabled = true;
      publishBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Публикуем...';
      try {
        const saved = await savePost('draft');
        const pubRes = await fetch(`/api/posts/${saved.id}/publish`, {
          method: 'POST',
          headers: getHeaders()
        });
        const pubData = await pubRes.json().catch(() => ({}));
        if (!pubRes.ok) throw new Error(pubData.error || 'Ошибка публикации');
        closeModal();
        tg.showPopup({ title: 'Опубликовано', message: 'Пост отправлен в канал Telegram!', buttons: [{ type: 'ok' }] });
        await refreshAllData();
      } catch (e) {
        tg.showPopup({ title: 'Ошибка', message: e.message, buttons: [{ type: 'close' }] });
      } finally {
        publishBtn.disabled = false;
        publishBtn.innerHTML = orig;
      }
    });
  });
}

// ---------------------------------------------
// 🖱️ Слушатели для динамических элементов
// ---------------------------------------------

// Посты
function attachPostButtonsListeners() {
  // Кнопка Опубликовать немедленно
  document.querySelectorAll('.publish-post-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      
      tg.showConfirm('Опубликовать этот пост в канал прямо сейчас?', async (confirmed) => {
        if (confirmed) {
          btn.disabled = true;
          btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Публикация...`;
          
          try {
            const res = await fetch(`/api/posts/${id}/publish`, {
              method: 'POST',
              headers: getHeaders()
            });

            if (res.ok) {
              tg.showPopup({
                title: 'Опубликовано',
                message: 'Пост успешно отправлен в канал Telegram!',
                buttons: [{ type: 'ok' }]
              });
              await refreshAllData();
            } else {
              throw new Error();
            }
          } catch (err) {
            tg.showPopup({
              title: 'Ошибка',
              message: 'Не удалось отправить пост в Telegram.',
              buttons: [{ type: 'close' }]
            });
            btn.disabled = false;
            btn.innerText = '🚀 Опубликовать';
          }
        }
      });
    });
  });

  // Кнопка изменения/просмотра
  document.querySelectorAll('.edit-post-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const post = state.posts.find(p => String(p.id) === String(id));
      
      if (post) {
        document.getElementById('edit-post-id').value = post.id;
        document.getElementById('edit-post-status').value = post.status;
        document.getElementById('edit-post-title').value = post.title;
        document.getElementById('edit-post-content').value = post.content;
        document.getElementById('edit-post-media').value = post.media_url || '';
        
        const scheduleField = document.getElementById('edit-schedule-field');
        if (post.status === 'scheduled') {
          scheduleField.classList.remove('hidden');
          if (post.scheduled_at) {
            const d = new Date(post.scheduled_at);
            const pad = num => String(num).padStart(2, '0');
            document.getElementById('edit-post-schedule').value = 
              `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
          }
        } else {
          scheduleField.classList.add('hidden');
          document.getElementById('edit-post-schedule').value = '';
        }

        document.getElementById('post-modal').classList.remove('hidden');
      }
    });
  });

  // Кнопка удаления для опубликованных постов
  document.querySelectorAll('.delete-post-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      tg.showConfirm('Удалить запись о посте из базы данных? (Пост в Telegram останется)', async (confirmed) => {
        if (confirmed) {
          await fetch(`/api/posts/${id}`, {
            method: 'DELETE',
            headers: getHeaders()
          });
          await loadPosts();
        }
      });
    });
  });

  // Отмена публикации запланированного поста
  document.querySelectorAll('.cancel-post-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const post = state.posts.find(p => String(p.id) === String(id));
      if (post) {
        tg.showConfirm('Перенести этот пост обратно в Черновики?', async (confirmed) => {
          if (confirmed) {
            const body = { ...post, status: 'draft', scheduled_at: null };
            await fetch(`/api/posts/${id}`, {
              method: 'PUT',
              headers: getHeaders(),
              body: JSON.stringify(body)
            });
            await loadPosts();
          }
        });
      }
    });
  });
}

// Заказы рекламы
function attachOrderButtonsListeners() {
  document.querySelectorAll('.complete-order-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const order = state.orders.find(o => String(o.id) === String(id));

      if (order) {
        tg.showConfirm('Вы действительно опубликовали пост и выполнили заказ?', async (confirmed) => {
          if (confirmed) {
            const body = {
              status: 'completed',
              advertiser_name: order.advertiser_name,
              amount_paid: order.amount_paid,
              publish_date: order.publish_date
            };

            const res = await fetch(`/api/orders/${id}`, {
              method: 'PUT',
              headers: getHeaders(),
              body: JSON.stringify(body)
            });

            if (res.ok) {
              await refreshAllData();
            }
          }
        });
      }
    });
  });

  document.querySelectorAll('.approve-order-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const order = state.orders.find(o => String(o.id) === String(id));
      if (!order) return;

      tg.showConfirm(
        `Одобрить заявку «${order.advertiser_name}»? Заказ переведётся в статус "Оплачен", связанный пост — в "Запланирован". Сумму и дату при необходимости отредактируешь в карточке заказа.`,
        async (confirmed) => {
          if (!confirmed) return;
          btn.disabled = true;
          btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
          try {
            const res = await fetch(`/api/orders/${id}/approve`, {
              method: 'POST',
              headers: getHeaders(),
              body: JSON.stringify({})
            });
            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              throw new Error(err.error || 'Ошибка одобрения');
            }
            tg.showPopup({ title: 'Готово', message: 'Заявка одобрена и запланирована', buttons: [{ type: 'ok' }] });
            await refreshAllData();
          } catch (e) {
            tg.showPopup({ title: 'Ошибка', message: e.message, buttons: [{ type: 'close' }] });
            btn.disabled = false;
            btn.innerHTML = '✓ Одобрить';
          }
        }
      );
    });
  });
}
