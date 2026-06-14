// ----------------------------------------------------
// 🔥 Refinery Channel Admin - Frontend JS Logic
// ----------------------------------------------------

const tg = window.Telegram.WebApp;
let currentUser = null;
let charts = {};

// Безопасная обёртка над tg.showPopup: Telegram режет title>64, message>256,
// и кидает WebAppPopupParamInvalid. Обрезаем + ловим любые ошибки.
function safePopup(title, message, btnType = 'ok') {
  const safeTitle = String(title || '').slice(0, 64);
  let safeMessage = String(message || '').replace(/\s+/g, ' ').trim();
  if (safeMessage.length > 256) safeMessage = safeMessage.slice(0, 253) + '...';
  if (!safeMessage) safeMessage = ' ';
  try {
    tg.showPopup({ title: safeTitle, message: safeMessage, buttons: [{ type: btnType }] });
  } catch (e) {
    console.error('showPopup failed:', e.message, { title: safeTitle, message: safeMessage });
    try { alert(`${safeTitle}\n\n${safeMessage}`); } catch (_) {}
  }
}

// Голосовой ввод: кнопка 🎤 рядом с textarea/input. Распознавание через Web Speech API
// браузера (русский). Текст добавляется в конец поля. Telegram WebView поддерживает
// webkitSpeechRecognition на iOS 14.5+ и на Android Chrome.
function setupVoiceInput(elementId) {
  const ta = document.getElementById(elementId);
  if (!ta) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    console.warn(`Voice input: API не поддерживается для #${elementId}`);
    return;
  }
  // Не вешать кнопку дважды
  if (ta.dataset.voiceAttached === '1') return;
  ta.dataset.voiceAttached = '1';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'voice-input-btn';
  btn.innerHTML = '🎤 Голосом';
  btn.title = 'Нажми и говори по-русски — текст добавится в поле';
  ta.parentNode.insertBefore(btn, ta.nextSibling);

  const recognition = new SR();
  recognition.lang = 'ru-RU';
  recognition.continuous = false;
  recognition.interimResults = false;

  let isRecording = false;

  btn.addEventListener('click', () => {
    if (isRecording) {
      try { recognition.stop(); } catch (_) {}
      return;
    }
    try {
      recognition.start();
    } catch (e) {
      // Если уже идёт, прерываем
      if (/already started/i.test(e.message)) {
        try { recognition.stop(); } catch (_) {}
      } else {
        safePopup('Ошибка голосового ввода', e.message);
      }
    }
  });

  recognition.onstart = () => {
    isRecording = true;
    btn.classList.add('recording');
    btn.innerHTML = '🔴 Идёт запись… (стоп)';
  };

  recognition.onresult = (event) => {
    const transcript = (event.results[0][0].transcript || '').trim();
    if (!transcript) return;
    const sep = ta.value && !/\s$/.test(ta.value) ? ' ' : '';
    ta.value = (ta.value || '') + sep + transcript;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };

  recognition.onend = () => {
    isRecording = false;
    btn.classList.remove('recording');
    btn.innerHTML = '🎤 Голосом';
  };

  recognition.onerror = (event) => {
    isRecording = false;
    btn.classList.remove('recording');
    btn.innerHTML = '🎤 Голосом';
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    if (event.error === 'not-allowed') {
      safePopup('Нет доступа к микрофону', 'Разреши Telegram использовать микрофон в настройках устройства.');
      return;
    }
    safePopup('Ошибка распознавания', event.error || 'unknown');
  };
}

// Глобальное состояние
let state = {
  currentTab: 'overview',
  postFilter: 'draft',
  orderFilter: 'pending',
  listingFilter: 'draft',
  stats: null,
  posts: [],
  orders: [],
  listings: [],
  comments: [],
  settings: {}
};

function filterOrders(orders) {
  if (state.orderFilter === 'all') return orders;
  return orders.filter(o => o.status === state.orderFilter);
}

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
      const fullMsg = (errData.error || 'Доступ запрещен') + (errData.hint ? `\n\n💡 ${errData.hint}` : '');
      showAccessDenied(fullMsg);
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
    loadListings();
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
    loadListings(),
    loadOrders(),
    loadComments(),
    loadSettings()
  ]);
}

// ---------------------------------------------
// 🚗 Объявления об обмене авто
// ---------------------------------------------
function filterListings(listings) {
  if (state.listingFilter === 'all') return listings;
  return listings.filter(l => l.status === state.listingFilter);
}

async function loadListings() {
  try {
    const res = await fetch('/api/listings', { headers: getHeaders() });
    if (!res.ok) throw new Error('Ошибка сети');
    const rows = await res.json();
    state.listings = Array.isArray(rows) ? rows : [];
    renderListings(filterListings(state.listings));
  } catch (err) {
    console.error('Ошибка загрузки объявлений:', err);
  }
}

function fmtKzt(n) {
  if (!n && n !== 0) return '—';
  return Number(n).toLocaleString('ru-RU') + ' ₸';
}

function renderListings(listings) {
  const container = document.getElementById('listings-list');
  if (!container) return;
  container.innerHTML = '';

  if (!listings.length) {
    container.innerHTML = `
      <div class="no-data glass">
        <i class="fa-solid fa-car"></i>
        <p>Нет заявок в этой категории</p>
      </div>`;
    return;
  }

  listings.forEach(item => {
    const c = item.car_data || {};
    const ev = c.price_evaluation || {};
    const card = document.createElement('div');
    card.className = 'post-card glass car-card';

    const statusBadge = item.status === 'draft' ? '<span class="post-type-badge orange">⏳ Ждёт</span>'
      : item.status === 'published' ? '<span class="post-type-badge green">✅ В канале</span>'
      : item.status === 'rejected' ? '<span class="post-type-badge red">❌ Отклонено</span>'
      : `<span class="post-type-badge">${item.status}</span>`;

    const photo = (c.photos && c.photos[0]) || item.media_url;
    const photoHtml = photo
      ? `<img src="${String(photo).replace(/"/g, '&quot;')}" class="car-card-photo" alt="фото" onerror="this.style.display='none'">`
      : '';

    const wants = c.wants || {};
    const wantsLine = wants.brand
      ? `${wants.brand} ${wants.model || ''} ${wants.year_from ? wants.year_from + '+' : ''}`.trim()
      : 'не указано';
    const doplata = wants.doplata_kzt
      ? `${fmtKzt(wants.doplata_kzt)} (${wants.doplata_direction || '?'})`
      : 'без доплат';

    // Блок оценки — показываем только если ИИ уже оценил
    let evalHtml = '';
    if (ev.market_avg || ev.salon_estimate) {
      const diff = (ev.market_min && ev.salon_estimate)
        ? Math.round((1 - ev.salon_estimate / ev.market_min) * 100)
        : null;
      evalHtml = `
        <div class="car-eval">
          <div>💰 Рынок: <b>${fmtKzt(ev.market_min)} – ${fmtKzt(ev.market_max)}</b></div>
          <div>🏠 Салоны дадут: <b>${fmtKzt(ev.salon_estimate)}</b>${diff ? ` <span class="red-text">(–${diff}%)</span>` : ''}</div>
        </div>`;
    }

    const contact = (c.owner && (c.owner.contact || (c.owner.username ? '@' + c.owner.username : ''))) || '—';

    let actions = '';
    if (item.status === 'draft') {
      actions = `
        <button class="btn btn-success btn-sm approve-listing-btn" data-id="${item.id}">🤖 Оценить и опубликовать</button>
        <button class="btn btn-secondary btn-sm edit-listing-btn" data-id="${item.id}">✏️</button>
        <button class="btn btn-danger btn-sm reject-listing-btn" data-id="${item.id}">❌</button>
      `;
    } else if (item.status === 'published') {
      actions = `<button class="btn btn-danger btn-sm delete-listing-btn" data-id="${item.id}">🗑 Удалить из канала</button>`;
    } else {
      actions = `<button class="btn btn-secondary btn-sm reapprove-listing-btn" data-id="${item.id}">↩️ Вернуть в очередь</button>`;
    }

    card.innerHTML = `
      <div class="post-card-header">
        <h3>${c.brand || ''} ${c.model || ''} ${c.year || ''}</h3>
        ${statusBadge}
      </div>
      ${photoHtml}
      <div class="car-specs">
        <span>📍 ${c.city || '—'}</span>
        <span>🛣 ${c.mileage_km ? Number(c.mileage_km).toLocaleString('ru-RU') + ' км' : '—'}</span>
        <span>⚙️ ${c.transmission || '—'}</span>
        <span>💵 хочет: ${fmtKzt(ev.owner_asks_kzt)}</span>
      </div>
      <div class="car-wants">🔄 <b>Меняет на:</b> ${wantsLine} · ${doplata}</div>
      ${evalHtml}
      <div class="car-contact">📞 ${contact}${c.vin ? ` · VIN: ${c.vin}` : ''}</div>
      <div class="post-card-actions">${actions}</div>
    `;
    container.appendChild(card);
  });

  attachListingButtons();
}

function attachListingButtons() {
  document.querySelectorAll('.approve-listing-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      tg.showConfirm('ИИ оценит рыночную цену (поиск по kolesa.kz) и опубликует объявление в канал. Продолжить?', async (ok) => {
        if (!ok) return;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ИИ оценивает цену…';
        try {
          const res = await fetch(`/api/listings/${id}/approve`, { method: 'POST', headers: getHeaders() });
          const data = await res.json();
          if (!res.ok) throw new Error((data.error || 'Ошибка') + (data.hint ? '\n\n' + data.hint : ''));
          const ev = data.price_evaluation || {};
          const msg = data.mock
            ? 'Опубликовано (демо-оценка, нужен GEMINI_API_KEY для реальной).'
            : `Опубликовано! Рынок: ${fmtKzt(ev.market_min)}–${fmtKzt(ev.market_max)}, салоны: ${fmtKzt(ev.salon_estimate)}.`;
          safePopup('✅ Готово', msg);
          await Promise.all([loadListings(), loadStats()]);
        } catch (e) {
          safePopup('Ошибка', e.message);
          btn.disabled = false;
          btn.innerHTML = '🤖 Оценить и опубликовать';
        }
      });
    });
  });

  document.querySelectorAll('.reject-listing-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      tg.showConfirm('Отклонить заявку? Объявление не попадёт в канал.', async (ok) => {
        if (!ok) return;
        try {
          const res = await fetch(`/api/listings/${id}/reject`, { method: 'POST', headers: getHeaders() });
          if (!res.ok) throw new Error('Ошибка');
          await loadListings();
        } catch (e) { safePopup('Ошибка', e.message); }
      });
    });
  });

  document.querySelectorAll('.reapprove-listing-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      try {
        // Вернуть в очередь = поставить статус draft через PUT поста
        const item = state.listings.find(l => String(l.id) === String(id));
        if (!item) return;
        await fetch(`/api/posts/${id}`, {
          method: 'PUT', headers: getHeaders(),
          body: JSON.stringify({ title: item.title, content: item.content, media_url: item.media_url, status: 'draft', scheduled_at: null })
        });
        await loadListings();
      } catch (e) { safePopup('Ошибка', e.message); }
    });
  });

  document.querySelectorAll('.delete-listing-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      tg.showConfirm('Удалить объявление из канала Telegram и из базы? Необратимо.', async (ok) => {
        if (!ok) return;
        try {
          const res = await fetch(`/api/posts/${id}`, { method: 'DELETE', headers: getHeaders() });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Ошибка');
          if (data.warning) safePopup('⚠️ Частично', data.warning);
          await Promise.all([loadListings(), loadStats()]);
        } catch (e) { safePopup('Ошибка', e.message); }
      });
    });
  });

  document.querySelectorAll('.edit-listing-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      safePopup('Редактирование', 'Полное редактирование заявки появится в следующем обновлении. Сейчас можно одобрить (ИИ сам всё оформит) или отклонить.');
    });
  });
}

// 1. Статистика
async function loadStats() {
  try {
    const res = await fetch('/api/stats', { headers: getHeaders() });
    if (!res.ok) throw new Error('Ошибка сети');
    const data = await res.json();
    state.stats = data;

    if (data.warning) {
      console.warn('Stats warning:', data.warning);
    }

    // Обновляем метрики на главном экране (null-safe — состав карточек мог измениться)
    const setMetric = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
    setMetric('metric-posts', data.summary.totalPosts);
    setMetric('metric-pending-listings', data.summary.pendingListings ?? 0);
    setMetric('metric-ads-count', data.summary.completedOrders);
    setMetric('metric-comments', data.summary.totalComments);

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

    // Сортировка: сначала pending (ждут одобрения), потом paid, потом completed
    const statusOrder = { pending: 0, paid: 1, completed: 2, cancelled: 3 };
    orders.sort((a, b) => {
      const sa = statusOrder[a.status] ?? 99;
      const sb = statusOrder[b.status] ?? 99;
      if (sa !== sb) return sa - sb;
      return new Date(b.publish_date) - new Date(a.publish_date);
    });
    state.orders = orders;

    const totalRev = orders
      .filter(o => o.status === 'completed' || o.status === 'paid')
      .reduce((sum, o) => sum + parseFloat(o.amount_paid || 0), 0);

    const pendingCount = orders.filter(o => o.status === 'pending').length;
    const activeOrd = orders.filter(o => o.status === 'paid').length;

    document.getElementById('metric-revenue').innerText = `${totalRev.toLocaleString()} ₸`;
    document.getElementById('ad-total-revenue').innerText = `${totalRev.toLocaleString()} ₸`;
    document.getElementById('ad-active-orders').innerText = activeOrd;
    document.getElementById('ad-total-orders').innerText = orders.length;
    const pendingEl = document.getElementById('ad-pending-orders');
    if (pendingEl) pendingEl.innerText = pendingCount;

    renderOrdersTable(filterOrders(orders));
  } catch (err) {
    console.error('Ошибка загрузки заказов:', err);
  }
}

// 4. Комментарии
async function loadComments() {
  try {
    const res = await fetch('/api/comments', { headers: getHeaders() });
    if (!res.ok) throw new Error('Ошибка сети');
    const data = await res.json();
    // Бэкенд возвращает {comments, removedCount} (новый формат) либо просто массив (на всякий случай).
    const comments = Array.isArray(data) ? data : (data.comments || []);
    const removedCount = data.removedCount || 0;

    state.comments = comments;
    renderCommentsFeed(comments);

    if (removedCount > 0) {
      safePopup(
        '🔄 Синхронизация',
        `Удалено ${removedCount} комментариев, которых уже нет в группе обсуждения (подписчики удалили сами).`
      );
      // Стата на главной могла измениться — обновим.
      try { await loadStats(); } catch (_) {}
    }
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
    // По умолчанию комментарии включены (если ключа нет в БД)
    document.getElementById('setting-comments-enabled').checked = settings.comments_enabled !== 'false';
    
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
  if (!container) return; // вкладка "Посты" заменена на "Объявления"
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
      // published — можно редактировать (синхронизируется с каналом) или удалять (из канала + БД)
      actionButtons = `
        <button class="btn btn-secondary btn-sm edit-post-btn" data-id="${post.id}">✏️ Изменить</button>
        <button class="btn btn-danger btn-sm delete-post-btn" data-id="${post.id}">🗑️ Удалить</button>
      `;
    }

    // Реакции под постом (если есть)
    let reactionsHtml = '';
    if (post.reactions) {
      try {
        const r = JSON.parse(post.reactions);
        const entries = Object.entries(r).filter(([, n]) => Number(n) > 0);
        if (entries.length) {
          reactionsHtml = `<div class="post-reactions">${
            entries
              .sort((a, b) => Number(b[1]) - Number(a[1]))
              .map(([emoji, count]) => {
                const display = emoji.startsWith('custom:') ? '🎨' : emoji;
                return `<span class="reaction-badge">${display} ${count}</span>`;
              })
              .join('')
          }</div>`;
        }
      } catch (_) {}
    }

    card.innerHTML = `
      <div class="post-card-header">
        <h3>${post.title}</h3>
        <span class="post-type-badge ${badgeClass}">${badgeText}</span>
      </div>
      ${imageHtml}
      <div class="post-card-body">${post.content}</div>
      ${reactionsHtml}
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
      <div class="comment-actions">
        <button class="btn btn-danger btn-sm delete-comment-btn" data-id="${comment.id}">
          <i class="fa-solid fa-trash"></i> Удалить
        </button>
      </div>
    `;
    container.appendChild(card);
  });

  // Привязка хендлеров на кнопки удаления
  container.querySelectorAll('.delete-comment-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      tg.showConfirm('Удалить этот комментарий из БД и из группы обсуждения? Действие необратимо.', async (ok) => {
        if (!ok) return;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        try {
          const res = await fetch(`/api/comments/${id}`, {
            method: 'DELETE',
            headers: getHeaders()
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Ошибка удаления');
          if (data.warning) safePopup('⚠️ Частично', `${data.warning} Из БД удалён.`);
          await loadComments();
          await loadStats(); // обновляем счётчики
        } catch (e) {
          safePopup('Ошибка', e.message);
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-trash"></i> Удалить';
        }
      });
    });
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

  // 0. Голосовой ввод для всех релевантных полей-промптов админки
  [
    'ai-user-prompt',         // модалка генерации поста по промпту — основное поле
    'ai-result-content',      // редактор сгенерированного содержимого
    'edit-ai-instruction',    // блок "Доработать через ИИ" в модалке поста
    'edit-post-content',      // основной редактор текста поста
    'order-post-content'      // создание рекламного заказа вручную
  ].forEach(setupVoiceInput);

  // 1a. Кнопки фильтрации объявлений (вкладка Объявления)
  const listingFilterBtns = document.querySelectorAll('.filter-btn[data-listing-status]');
  listingFilterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      listingFilterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.listingFilter = btn.getAttribute('data-listing-status');
      renderListings(filterListings(state.listings));
    });
  });

  // 1a-bis. Импорт объявления с kolesa.kz
  const importKolesaBtn = document.getElementById('btn-import-kolesa');
  if (importKolesaBtn) {
    importKolesaBtn.addEventListener('click', async () => {
      const input = document.getElementById('kolesa-url-input');
      const url = (input.value || '').trim();
      if (!/kolesa\.kz\/a\/show\/\d+/.test(url)) {
        safePopup('Неверная ссылка', 'Вставь ссылку вида https://kolesa.kz/a/show/...');
        return;
      }
      const orig = importKolesaBtn.innerHTML;
      importKolesaBtn.disabled = true;
      importKolesaBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Читаю объявление…';
      try {
        const res = await fetch('/api/listings/from-url', {
          method: 'POST', headers: getHeaders(),
          body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (!res.ok) throw new Error((data.error || 'Ошибка') + (data.hint ? '\n\n' + data.hint : ''));
        const c = data.car || {};
        safePopup('✅ Импортировано', `${c.brand || ''} ${c.model || ''} ${c.year || ''}, фото: ${data.photos_count}. Заявка в очереди — проверь и одобри.`);
        input.value = '';
        state.listingFilter = 'draft';
        document.querySelectorAll('.filter-btn[data-listing-status]').forEach(b => {
          b.classList.toggle('active', b.getAttribute('data-listing-status') === 'draft');
        });
        await loadListings();
      } catch (e) {
        safePopup('Ошибка импорта', e.message);
      } finally {
        importKolesaBtn.disabled = false;
        importKolesaBtn.innerHTML = orig;
      }
    });
  }

  // 1b. Кнопки фильтрации заявок на рекламу (вкладка Реклама)
  const orderFilterBtns = document.querySelectorAll('.order-filter-btn');
  orderFilterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      orderFilterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.orderFilter = btn.getAttribute('data-order-status');
      renderOrdersTable(filterOrders(state.orders));
    });
  });

  // 3. Форма настроек
  const settingsForm = document.getElementById('settings-form');
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const settings = {
      auto_post: document.getElementById('setting-auto-post').checked ? 'true' : 'false',
      channels_list: document.getElementById('setting-channels-list').value,
      post_interval: document.getElementById('setting-post-interval').value,
      comments_enabled: document.getElementById('setting-comments-enabled').checked ? 'true' : 'false'
    };

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(settings)
      });

      if (res.ok) {
        safePopup('Настройки', 'Настройки успешно сохранены!');
        await loadSettings();
      } else {
        throw new Error();
      }
    } catch (err) {
      safePopup('Ошибка', 'Не удалось сохранить настройки.');
    }
  });

  // 3c. Обновить ленту комментариев + статистику
  const refreshCommentsBtn = document.getElementById('btn-refresh-comments');
  if (refreshCommentsBtn) {
    refreshCommentsBtn.addEventListener('click', async () => {
      const orig = refreshCommentsBtn.innerHTML;
      refreshCommentsBtn.disabled = true;
      refreshCommentsBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
      try {
        await Promise.all([loadComments(), loadStats()]);
      } finally {
        refreshCommentsBtn.disabled = false;
        refreshCommentsBtn.innerHTML = orig;
      }
    });
  }

  // 3b. Кнопки управления рекламной плашкой в канале
  const pinAdBtn = document.getElementById('btn-pin-ad');
  if (pinAdBtn) {
    pinAdBtn.addEventListener('click', () => {
      tg.showConfirm('Опубликовать и закрепить рекламную плашку в канале? Старая плашка (если есть) открепится.', async (ok) => {
        if (!ok) return;
        const orig = pinAdBtn.innerHTML;
        pinAdBtn.disabled = true;
        pinAdBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Публикую…';
        try {
          const res = await fetch('/api/channel/pin-ad', { method: 'POST', headers: getHeaders() });
          const data = await res.json();
          if (!res.ok) throw new Error((data.error || 'Ошибка') + (data.hint ? ' — ' + data.hint : ''));
          safePopup('Готово', data.demo ? 'Demo: плашка закреплена (имитация).' : `Закреплено в канале (сообщение #${data.message_id}).`);
        } catch (e) {
          safePopup('Ошибка', e.message);
        } finally {
          pinAdBtn.disabled = false;
          pinAdBtn.innerHTML = orig;
        }
      });
    });
  }

  const unpinAdBtn = document.getElementById('btn-unpin-ad');
  if (unpinAdBtn) {
    unpinAdBtn.addEventListener('click', () => {
      tg.showConfirm('Открепить рекламную плашку?', async (ok) => {
        if (!ok) return;
        const orig = unpinAdBtn.innerHTML;
        unpinAdBtn.disabled = true;
        unpinAdBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>…';
        try {
          const res = await fetch('/api/channel/unpin-ad', { method: 'POST', headers: getHeaders() });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Ошибка');
          safePopup('Готово', data.unpinned ? 'Плашка откреплена.' : (data.reason || 'Нечего откреплять.'));
        } catch (e) {
          safePopup('Ошибка', e.message);
        } finally {
          unpinAdBtn.disabled = false;
          unpinAdBtn.innerHTML = orig;
        }
      });
    });
  }

  // 3d. Кнопка "Внести вручную" во вкладке Объявления → открывает форму заявки
  const openListingBtn = document.getElementById('btn-open-listing-modal');
  if (openListingBtn) {
    openListingBtn.addEventListener('click', () => {
      // Форма submit.html создаёт draft-заявку, которая появится здесь же в очереди.
      window.location.href = 'submit.html?admin=1';
    });
  }

  // 4. Модальное окно Рекламы (Заказов)
  const openOrderBtn = document.getElementById('btn-open-order-modal');
  const closeOrderBtn = document.getElementById('btn-close-order-modal');
  const cancelOrderBtn = document.getElementById('btn-cancel-order');
  const orderModal = document.getElementById('order-modal');

  if (openOrderBtn) openOrderBtn.addEventListener('click', () => {
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
        safePopup('Успешно', 'Рекламный пост запланирован и сохранен в системе.');
        await loadOrders();
      } else {
        throw new Error();
      }
    } catch (e) {
      safePopup('Ошибка', 'Не удалось создать рекламный заказ.');
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

      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        closePostModal();
        if (data.warning) {
          safePopup('⚠️ Частично', data.warning);
        } else {
          safePopup('Готово', body.status === 'published'
            ? 'Пост обновлён и синхронизирован с каналом.'
            : 'Пост успешно обновлён.');
        }
        await loadPosts();
      } else {
        throw new Error();
      }
    } catch (err) {
      safePopup('Ошибка', 'Не удалось обновить пост.');
    }
  });

  // Доработать пост через ИИ — chips проставляют готовые инструкции в textarea + клик «Применить»
  const aiInstrInput = document.getElementById('edit-ai-instruction');
  const aiApplyBtn = document.getElementById('btn-edit-ai-apply');

  document.querySelectorAll('.chip-btn[data-improve-prompt]').forEach(chip => {
    chip.addEventListener('click', () => {
      aiInstrInput.value = chip.getAttribute('data-improve-prompt');
      aiInstrInput.focus();
    });
  });

  aiApplyBtn.addEventListener('click', async () => {
    const instruction = aiInstrInput.value.trim();
    if (instruction.length < 3) {
      safePopup('Подождите', 'Опиши задачу или выбери один из пресетов выше.');
      return;
    }
    const titleEl = document.getElementById('edit-post-title');
    const contentEl = document.getElementById('edit-post-content');

    const orig = aiApplyBtn.innerHTML;
    aiApplyBtn.disabled = true;
    aiApplyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Gemini переписывает…';

    try {
      const res = await fetch('/api/posts/improve', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          title: titleEl.value,
          content: contentEl.value,
          instruction
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка доработки');

      titleEl.value = data.title || titleEl.value;
      contentEl.value = data.content || contentEl.value;
      aiInstrInput.value = '';

      if (data.warning) {
        safePopup('⚠️ Mock-режим', data.warning);
      } else {
        safePopup('✅ Готово', 'Текст переписан. Проверь и нажми «Сохранить» для применения.');
      }
    } catch (e) {
      safePopup('Ошибка', e.message);
    } finally {
      aiApplyBtn.disabled = false;
      aiApplyBtn.innerHTML = orig;
    }
  });

  // Удаление поста из модалки
  const deletePostBtn = document.getElementById('btn-delete-post');
  deletePostBtn.addEventListener('click', async () => {
    const id = document.getElementById('edit-post-id').value;
    const status = document.getElementById('edit-post-status').value;
    const isPublished = status === 'published';

    const confirmMsg = isPublished
      ? 'Удалить пост из канала Telegram и из базы? Подписчики больше не увидят его. Действие необратимо.'
      : 'Удалить черновик? Действие необратимо.';

    tg.showConfirm(confirmMsg, async (confirmed) => {
      if (!confirmed) return;
      try {
        const res = await fetch(`/api/posts/${id}`, {
          method: 'DELETE',
          headers: getHeaders()
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok) {
          closePostModal();
          if (data.warning) {
            safePopup('⚠️ Частично', `${data.warning} Запись из БД удалена.`);
          } else if (isPublished) {
            safePopup('Удалено', 'Пост удалён из канала и базы.');
          }
          await loadPosts();
        } else {
          throw new Error(data.error || 'Ошибка удаления');
        }
      } catch (e) {
        safePopup('Ошибка', e.message || 'Не удалось удалить пост.');
      }
    });
  });

  // 6. Модальное окно генерации поста по промпту (ИИ)
  initAiPromptModal();
}

function initAiPromptModal() {
  const openBtn = document.getElementById('btn-open-ai-prompt-modal');
  if (!openBtn) return; // ИИ-пост по промпту убран из авто-обмена — модалки нет

  const aiModal = document.getElementById('ai-prompt-modal');
  const stagePrompt = document.getElementById('ai-stage-prompt');
  const stageResult = document.getElementById('ai-stage-result');
  const scheduleField = document.getElementById('ai-schedule-field');

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
      safePopup('Промпт слишком короткий', 'Минимум 5 символов');
      return;
    }
    const withChannelStyle = styleToggle.checked;
    const webSearchToggle = document.getElementById('ai-with-web-search');
    const withWebSearch = webSearchToggle ? webSearchToggle.checked : true;
    const orig = generateBtn.innerHTML;
    generateBtn.disabled = true;
    generateBtn.innerHTML = withWebSearch
      ? '<i class="fa-solid fa-spinner fa-spin"></i> Gemini ищет источники...'
      : '<i class="fa-solid fa-spinner fa-spin"></i> Gemini думает...';

    try {
      const res = await fetch('/api/posts/generate', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ prompt, withChannelStyle, withWebSearch })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка генерации');

      titleInput.value = data.title || '';
      contentInput.value = data.content || '';
      mediaInput.value = data.media_url || '';

      // Рендер списка источников из веб-поиска (если использовался)
      const sourcesSection = document.getElementById('ai-sources-section');
      const sourcesList = document.getElementById('ai-sources-list');
      if (sourcesSection && sourcesList) {
        if (data.sources && data.sources.length > 0) {
          sourcesList.innerHTML = data.sources.map(s => {
            const safeUrl = String(s.url).replace(/"/g, '&quot;');
            const safeTitle = String(s.title || s.url).replace(/</g, '&lt;');
            return `<li><a href="${safeUrl}" target="_blank" rel="noopener">${safeTitle}</a></li>`;
          }).join('');
          sourcesSection.classList.remove('hidden');
        } else if (data.search_used) {
          sourcesList.innerHTML = '<li>Google Search не вернул чистых источников</li>';
          sourcesSection.classList.remove('hidden');
        } else {
          sourcesSection.classList.add('hidden');
        }
      }

      showStage('result');
      if (data.warning) {
        safePopup('⚠️ Mock-контент', data.warning);
      } else if (!data.media_url) {
        safePopup('ℹ️ Картинка не найдена', 'Wikipedia не нашла иллюстрацию по теме. При публикации будет использован логотип канала.');
      }
    } catch (e) {
      safePopup('Ошибка', e.message);
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
      safePopup('Сохранено', 'Пост добавлен в черновики');
      await loadPosts();
    } catch (e) {
      safePopup('Ошибка', e.message);
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
      safePopup('Внимание', 'Выбери дату публикации');
      return;
    }
    try {
      await savePost('scheduled', new Date(scheduleInput.value).toISOString());
      closeModal();
      safePopup('Запланировано', 'Пост будет опубликован в указанное время');
      await loadPosts();
    } catch (e) {
      safePopup('Ошибка', e.message);
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
        safePopup('Опубликовано', 'Пост отправлен в канал Telegram!');
        await refreshAllData();
      } catch (e) {
        safePopup('Ошибка', e.message);
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

            const data = await res.json().catch(() => ({}));
            if (res.ok) {
              safePopup('Опубликовано', 'Пост успешно отправлен в канал Telegram!');
              await refreshAllData();
            } else {
              const msg = (data.error || 'Не удалось отправить пост') +
                          (data.hint ? `\n\n💡 ${data.hint}` : '');
              throw new Error(msg);
            }
          } catch (err) {
            safePopup('Ошибка публикации', err.message || 'Не удалось отправить пост в Telegram.');
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

        // Подсказка-предупреждение для уже опубликованных постов
        const notice = document.getElementById('edit-published-notice');
        if (post.status === 'published') {
          notice.classList.remove('hidden');
        } else {
          notice.classList.add('hidden');
        }
        
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

  // Кнопка удаления (для опубликованных постов в списке)
  document.querySelectorAll('.delete-post-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      const post = state.posts.find(p => String(p.id) === String(id));
      const isPublished = post && post.status === 'published';

      const msg = isPublished
        ? 'Удалить пост из канала Telegram и из базы? Подписчики больше не увидят его. Действие необратимо.'
        : 'Удалить пост из базы данных?';

      tg.showConfirm(msg, async (confirmed) => {
        if (!confirmed) return;
        try {
          const res = await fetch(`/api/posts/${id}`, {
            method: 'DELETE',
            headers: getHeaders()
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Ошибка удаления');
          if (data.warning) {
            safePopup('⚠️ Частично', `${data.warning} Запись из БД удалена.`);
          } else if (isPublished) {
            safePopup('Удалено', 'Пост удалён из канала и базы.');
          }
          await loadPosts();
        } catch (err) {
          safePopup('Ошибка', err.message || 'Не удалось удалить пост.');
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
            safePopup('Готово', 'Заявка одобрена и запланирована');
            await refreshAllData();
          } catch (e) {
            safePopup('Ошибка', e.message);
            btn.disabled = false;
            btn.innerHTML = '✓ Одобрить';
          }
        }
      );
    });
  });
}
