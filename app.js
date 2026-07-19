/**
 * CarZ3 — Каталог автомобилей под заказ
 * Vanilla JS + Tailwind CSS. Без фреймворков, без сборщика.
 *
 * Структура файла:
 *   1. Данные об автомобилях
 *   2. Иконки (инлайн SVG, без внешних библиотек)
 *   3. Форматирование (цена/пробег/локация/ссылка на менеджера)
 *   4. Инициализация Telegram WebApp
 *   5. Рендер карточек
 *   6. Логика модального окна (+ галерея фото)
 *   7. Полноэкранный просмотр фото (лайтбокс с зумом)
 *   8. Обработчики событий
 */

// ==========================================================================
// 1. ДАННЫЕ ОБ АВТОМОБИЛЯХ
// ==========================================================================
// Раньше здесь был захардкожен сам массив CARS. Теперь данные живут в
// data/cars.json (единственный источник правды — его же читает и пополняет
// Telegram-бот при публикации/удалении машин). На этапе сборки build-cards.js
// вставляет содержимое этого файла прямо в index.html как
// <script type="application/json" id="cars-data">, а здесь мы просто читаем
// его — без сетевого запроса, без риска пустого первого кадра.
//
// manager — Telegram-username менеджера по этой заявке (выбирается ботом
// при публикации). images — массив путей к фото, любое количество (1, 3,
// 8 — сколько есть); первое фото — обложка карточки в сетке. Если файла
// ещё нет — карточка и модалка сами покажут текстовую заглушку вместо
// сломанной картинки, см. handleImageError() и modalImage.onerror ниже.

const CARS = JSON.parse(document.getElementById('cars-data').textContent);


// ==========================================================================
// 2. ИКОНКИ
// ==========================================================================
const ICON_BOLT = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4 shrink-0"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg>`;

// Схема переключения передач (H-паттерн) — читается однозначно, в отличие от
// предыдущей версии (круг с лучами, которая на деле выглядела как значок солнца)
// Шестерёнка — универсальный символ трансмиссии, без намёка на конкретный
// тип коробки. Предыдущая версия (H-паттерн) технически означает схему
// переключения именно МКПП — рядом со значением "Автомат"/"Робот" это
// читалось как ошибка для любого, кто разбирается в машинах. Контур зубьев
// посчитан математически (6 зубьев через тригонометрию), а не нарисован на
// глаз — проверил рендер на 16px перед тем, как ставить сюда.
const ICON_GEAR = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" class="w-4 h-4 shrink-0"><path d="M12 2.5L15.1 6.63L20.23 7.25L18.2 12L20.23 16.75L15.1 17.37L12 21.5L8.9 17.37L3.77 16.75L5.8 12L3.77 7.25L8.9 6.63Z"/><circle cx="12" cy="12" r="2.6"/></svg>`;

// Спидометр (дуга + стрелка) — вместо прежней "дороги", которая на маленьком
// размере читалась как случайная закорючка
const ICON_ROAD = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4 shrink-0"><path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16l4-5"/><circle cx="12" cy="16" r="1" fill="currentColor" stroke="none"/></svg>`;

// ==========================================================================
// 3. ФОРМАТИРОВАНИЕ
// ==========================================================================
function formatPrice(value) {
  return `${new Intl.NumberFormat('ru-RU').format(value)} ₽`;
}

// Некоторые машины продаются несколькими комплектациями по разным ценам —
// car.price тогда хранит минимальную, а car.priceIsFrom честно показывает
// это как диапазон ("от"), а не выдаёт одну цифру за фиксированную цену.
function formatCarPrice(car) {
  const formatted = formatPrice(car.price);
  return car.priceIsFrom ? `от ${formatted}` : formatted;
}

function formatMileage(value) {
  return value === 0 ? 'Новый' : `${new Intl.NumberFormat('ru-RU').format(value)} км`;
}

// Раньше здесь добавлялся эмодзи-флаг (🇰🇷/🇨🇳), но на Windows Chrome (и на
// части Android-прошивок) эмодзи флагов часто не поддерживается шрифтом и
// вместо флага показывается двухбуквенный код текстом ("cn Китай") — выглядит
// как баг. Обычный текст без эмодзи работает одинаково везде.
function formatLocation(location) {
  return location || null;
}

function getManagerLink(username, car) {
  const base = `https://t.me/${username}`;
  if (!car) return base;
  const draftMessage = `Здравствуйте! Меня интересует автомобиль ${car.brand} ${car.model} (${car.year}) — ${formatCarPrice(car)}. Можно узнать подробности?`;
  return `${base}?text=${encodeURIComponent(draftMessage)}`;
}

// ==========================================================================
// 4. ИНИЦИАЛИЗАЦИЯ TELEGRAM WEBAPP
// ==========================================================================
// tg будет undefined, если страница открыта в обычном браузере (например,
// при локальной разработке). Весь код ниже написан так, чтобы в этом случае
// просто ничего не делать — без ошибок в консоли и без потери функциональности.
const tg = window.Telegram && window.Telegram.WebApp;

if (tg) {
  tg.ready();
  tg.expand();

  // Подстраиваем системные цвета Telegram под тёмную тему каталога.
  // На случай очень старых клиентов оборачиваем в try/catch.
  try {
    tg.setHeaderColor('#0a0a0a');
    tg.setBackgroundColor('#000000');
  } catch (err) {
    console.warn('Telegram theming API недоступно в этом клиенте:', err);
  }
}

function hapticImpact(style) {
  if (tg && tg.HapticFeedback) {
    tg.HapticFeedback.impactOccurred(style || 'light');
  }
}

// ==========================================================================
// 5. РЕНДЕР КАРТОЧЕК
// ==========================================================================
const carsGrid = document.getElementById('carsGrid');
const carsCountEl = document.getElementById('carsCount');

function createCarCard(car) {
  const locationBadge = car.location
    ? `<span class="rounded-full bg-black/60 backdrop-blur-md border border-white/10 px-2.5 py-1 text-xs">${formatLocation(car.location)}</span>`
    : '';

  const featureTag = car.features[0]
    ? `<span class="inline-block rounded-full border border-gold/30 bg-gold/5 px-2.5 py-1 text-xs font-medium text-gold">${car.features[0]}</span>`
    : '';

  return `
    <div
      data-car-id="${car.id}"
      data-location="${car.location || ''}"
      data-search-text="${`${car.brand} ${car.model} ${car.year}`.toLowerCase()}"
      tabindex="0"
      role="button"
      aria-label="Подробнее об автомобиле ${car.brand} ${car.model}"
      class="group cursor-pointer rounded-2xl sm:rounded-3xl bg-neutral-900 border border-neutral-800 overflow-hidden transition-all duration-300 hover:-translate-y-1 hover:border-gold/40 hover:shadow-2xl hover:shadow-gold/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-black"
    >
      <div class="relative aspect-[4/3] bg-neutral-800 overflow-hidden">
        <img
          src="${car.images[0]}"
          alt="${car.brand} ${car.model}"
          width="800"
          height="600"
          loading="lazy"
          decoding="async"
          onerror="handleImageError(this)"
          class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
        >
        <div class="hidden absolute inset-0 items-center justify-center bg-neutral-800" data-img-fallback>
          <span class="font-display text-lg text-neutral-400 px-4 text-center">${car.brand} ${car.model}</span>
        </div>

        <div class="absolute inset-x-0 top-0 flex items-start justify-between p-3">
          <span class="inline-flex items-center gap-1.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-gold">
            <span class="w-1.5 h-1.5 rounded-full bg-gold"></span>${car.status}
          </span>
          ${locationBadge}
        </div>

        <div class="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-neutral-900 to-transparent"></div>
      </div>

      <div class="p-5">
        <div class="flex items-baseline justify-between gap-2">
          <h2 class="font-display text-xl font-bold tracking-tight">${car.brand} ${car.model}</h2>
          <span class="text-neutral-400 text-sm shrink-0">${car.year}</span>
        </div>

        <div class="mt-3 grid grid-cols-3 gap-2 text-xs text-neutral-400">
          <div class="flex items-center gap-1.5">${ICON_BOLT}${car.horsePower} л.с.</div>
          <div class="flex items-center gap-1.5">${ICON_GEAR}${car.transmission || '—'}</div>
          <div class="flex items-center gap-1.5">${ICON_ROAD}${formatMileage(car.mileage)}</div>
        </div>

        ${featureTag ? `<div class="mt-3">${featureTag}</div>` : ''}

        <div class="mt-4 flex items-center justify-between">
          <span class="font-display text-xl sm:text-2xl font-extrabold">${formatCarPrice(car)}</span>
          <span class="text-gold text-sm font-semibold inline-flex items-center gap-1 group-hover:gap-2 transition-all">Подробнее →</span>
        </div>
      </div>
    </div>
  `;
}

function renderCars() {
  carsGrid.innerHTML = CARS.map(createCarCard).join('');
  if (carsCountEl) {
    carsCountEl.textContent = `${CARS.length} авто в наличии`;
  }
}

// ==========================================================================
// 5b. ФИЛЬТР ПО СТРАНЕ + ПОИСК (работают вместе, не по отдельности)
// ==========================================================================
const filterTabs = document.querySelectorAll('.filter-tab');
const emptyFilterMessage = document.getElementById('emptyFilterMessage');
const carSearchInput = document.getElementById('carSearch');
const carSearchClearBtn = document.getElementById('carSearchClear');

// Переключаем ВЕСЬ className целиком, а не отдельные классы через toggle() —
// порядок объявления классов в скомпилированном Tailwind CSS ни на что не влияет.
const TAB_ACTIVE = 'filter-tab rounded-full border px-4 py-2 text-sm font-medium transition-colors border-gold bg-gold text-black';
const TAB_INACTIVE = 'filter-tab rounded-full border px-4 py-2 text-sm font-medium transition-colors border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-white';

let currentLocationFilter = 'all';
let currentSearchQuery = '';

function applyFilters() {
  let visibleCount = 0;
  carsGrid.querySelectorAll('[data-car-id]').forEach((card) => {
    const matchesLocation = currentLocationFilter === 'all' || card.dataset.location === currentLocationFilter;
    const matchesSearch = !currentSearchQuery || card.dataset.searchText.includes(currentSearchQuery);
    const visible = matchesLocation && matchesSearch;
    card.classList.toggle('hidden', !visible);
    if (visible) visibleCount += 1;
  });

  if (emptyFilterMessage) {
    emptyFilterMessage.classList.toggle('hidden', visibleCount > 0);
    emptyFilterMessage.textContent = currentSearchQuery
      ? `Ничего не найдено по запросу «${carSearchInput.value}»`
      : 'Пока нет предложений по этому направлению — загляните позже.';
  }
  if (carSearchClearBtn) {
    carSearchClearBtn.classList.toggle('hidden', !currentSearchQuery);
    carSearchClearBtn.classList.toggle('flex', Boolean(currentSearchQuery));
  }
  if (carsCountEl) {
    const suffix = currentLocationFilter === 'all' ? '' : ` · ${currentLocationFilter}`;
    carsCountEl.textContent = `${visibleCount} авто${suffix}`;
  }

  filterTabs.forEach((tab) => {
    const isActive = tab.dataset.filter === currentLocationFilter;
    tab.className = isActive ? TAB_ACTIVE : TAB_INACTIVE;
    tab.setAttribute('aria-selected', String(isActive));
  });
}

// handleImageError() теперь определена инлайн-скриптом в начале index.html
// (см. комментарий там) — картинки карточек теперь есть в статичной
// разметке с самого начала, а не только вставляются этим файлом, так что
// функция должна существовать ДО того, как парсер дойдёт до <img>, а не
// после выполнения app.js (он подключён с defer).

// ==========================================================================
// 6. МОДАЛЬНОЕ ОКНО
// ==========================================================================
const modal = document.getElementById('carModal');
const modalBackdrop = document.getElementById('modalBackdrop');
const modalPanel = document.getElementById('modalPanel');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const modalImageWrap = document.getElementById('modalImageWrap');
const modalImage = document.getElementById('modalImage');
const modalImageFallback = document.getElementById('modalImageFallback');
const modalImageFallbackText = document.getElementById('modalImageFallbackText');
const modalPrevBtn = document.getElementById('modalPrevBtn');
const modalNextBtn = document.getElementById('modalNextBtn');
const modalImageCounter = document.getElementById('modalImageCounter');
const modalTitle = document.getElementById('modalTitle');
const modalYear = document.getElementById('modalYear');
const modalSpecs = document.getElementById('modalSpecs');
const modalFeatures = document.getElementById('modalFeatures');
const modalPrice = document.getElementById('modalPrice');
const modalCTA = document.getElementById('modalCTA');

// Тот же принцип заглушки для фото — на случай, если файл ещё не загружен
modalImage.onerror = () => {
  modalImage.classList.add('hidden');
  modalImageFallback.classList.remove('hidden');
  modalImageFallback.classList.add('flex');
};

let lastFocusedElement = null;
let galleryImages = [];
let galleryIndex = 0;

// Предзагрузка всех фото машины в момент открытия модалки. Без этого браузер
// начинает качать следующее фото только когда пользователь долистает до
// него — отсюда и ощущение "с задержкой" при свайпе. Так все фото уже лежат
// в кэше браузера к моменту, когда до них долистают.
function preloadImages(paths) {
  paths.forEach((src) => {
    const img = new Image();
    img.src = src;
  });
}

// Переключение фото внутри модалки. Стрелки и счётчик показываются только
// если у машины больше одного фото — для машин с одним фото галерея просто
// не появляется, ничего лишнего на экране.
function setGalleryImage(index) {
  if (!galleryImages.length) return;
  galleryIndex = (index + galleryImages.length) % galleryImages.length;

  modalImage.classList.remove('hidden');
  modalImageFallback.classList.add('hidden');
  modalImageFallback.classList.remove('flex');
  modalImage.src = galleryImages[galleryIndex];

  // Если открыт полноэкранный просмотр — держим его в синхроне с модалкой
  if (!lightbox.classList.contains('hidden')) {
    showLightboxImage(galleryIndex);
  }

  const hasMultiple = galleryImages.length > 1;
  [modalPrevBtn, modalNextBtn].forEach((btn) => {
    btn.classList.toggle('hidden', !hasMultiple);
    btn.classList.toggle('flex', hasMultiple);
  });
  modalImageCounter.classList.toggle('hidden', !hasMultiple);
  if (hasMultiple) {
    modalImageCounter.textContent = `${galleryIndex + 1} / ${galleryImages.length}`;
  }
}

function buildSpecsHTML(car) {
  // Раньше отсутствующие поля (например, Привод у Audi Q3) просто не
  // рендерились — из-за этого у разных машин получалось разное число строк
  // и модалки выглядели разного размера. Теперь строк всегда 6, а вместо
  // неизвестного значения — «—», так что структура одинаковая у всех карточек.
  const rows = [
    { label: 'Двигатель', value: `${car.engineVolume.toFixed(1)} л / ${car.horsePower} л.с.` },
    { label: 'Коробка передач', value: car.transmission || '—' },
    { label: 'Привод', value: car.drivetrain || '—' },
    { label: 'Пробег', value: formatMileage(car.mileage) },
    { label: 'Локация', value: formatLocation(car.location) || '—' },
    { label: 'Статус', value: car.status },
  ];

  return rows.map((row) => `
    <div class="flex items-center justify-between py-2.5 border-b border-neutral-800 last:border-0">
      <span class="text-neutral-400 text-sm">${row.label}</span>
      <span class="text-white text-sm font-medium text-right">${row.value}</span>
    </div>
  `).join('');
}

function buildFeaturesHTML(car) {
  return car.features.map((f) => `
    <span class="inline-block rounded-full border border-gold/30 bg-gold/5 px-3 py-1 text-xs font-medium text-gold">${f}</span>
  `).join('');
}

function openModal(car) {
  // Галерея: сбрасываем на первое фото этой машины, качаем остальные в фоне
  galleryImages = car.images;
  preloadImages(car.images);
  modalImageFallbackText.textContent = `${car.brand} ${car.model}`;
  modalImage.alt = `${car.brand} ${car.model}`;
  setGalleryImage(0);

  modalTitle.textContent = `${car.brand} ${car.model}`;
  modalYear.textContent = car.year;
  modalSpecs.innerHTML = buildSpecsHTML(car);
  modalFeatures.innerHTML = buildFeaturesHTML(car);
  modalPrice.textContent = formatCarPrice(car);
  modalCTA.href = getManagerLink(car.manager, car);

  lastFocusedElement = document.activeElement;
  // ВАЖНО: сюда специально НЕ добавляется класс 'flex'. #carModal — это
  // обычный block-элемент; его единственный потомок (обёртка с
  // flex items-center justify-center) сам по себе, как block-ребёнок,
  // корректно растягивается на 100% ширины и центрирует панель. Если
  // сделать #carModal display:flex, он сам станет flex-контейнером
  // (flex-direction: row по умолчанию), и та обёртка превратится в
  // flex-item, который БЕЗ flex-grow сжимается по ширине контента и
  // прижимается к началу строки — именно это и было причиной того, что
  // окно «прилипало» к левому краю на широком экране.
  modal.classList.remove('hidden');
  document.body.classList.add('overflow-hidden');

  // Форсируем reflow, чтобы transition ниже гарантированно запустился
  // с начального состояния (opacity-0/scale-95), а не мгновенно.
  void modal.offsetHeight;

  requestAnimationFrame(() => {
    modalBackdrop.classList.remove('opacity-0');
    modalBackdrop.classList.add('opacity-100');
    modalPanel.classList.remove('opacity-0', 'scale-95');
    modalPanel.classList.add('opacity-100', 'scale-100');
  });

  modalCloseBtn.focus();
  hapticImpact('light');
}

function closeModal() {
  modalBackdrop.classList.add('opacity-0');
  modalBackdrop.classList.remove('opacity-100');
  modalPanel.classList.add('opacity-0', 'scale-95');
  modalPanel.classList.remove('opacity-100', 'scale-100');

  // 300 мс = duration-300 у #modalPanel/#modalBackdrop в index.html.
  // Меняете скорость анимации — поправьте оба места.
  setTimeout(() => {
    modal.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
    if (lastFocusedElement) lastFocusedElement.focus();
  }, 300);

  hapticImpact('light');
}

// ==========================================================================
// 7. ПОЛНОЭКРАННЫЙ ПРОСМОТР ФОТО (ЛАЙТБОКС С ЗУМОМ)
// ==========================================================================
const lightbox = document.getElementById('lightbox');
const lightboxStage = document.getElementById('lightboxStage');
const lightboxImg = document.getElementById('lightboxImg');
const lightboxPrevBtn = document.getElementById('lightboxPrevBtn');
const lightboxNextBtn = document.getElementById('lightboxNextBtn');
const lightboxCloseBtn = document.getElementById('lightboxCloseBtn');
const lightboxCounter = document.getElementById('lightboxCounter');

const LB_MIN_SCALE = 1;
const LB_MAX_SCALE = 4;
let lbScale = 1;
let lbX = 0;
let lbY = 0;

function applyLightboxTransform() {
  lightboxImg.style.transform = `translate(${lbX}px, ${lbY}px) scale(${lbScale})`;
}

function resetLightboxZoom() {
  lbScale = 1;
  lbX = 0;
  lbY = 0;
  applyLightboxTransform();
}

// Грубое, но надёжное ограничение панорамирования, чтобы фото нельзя было
// утащить далеко за пределы экрана на большом зуме.
function clampPan() {
  const maxOffset = (lbScale - 1) * (lightboxStage.clientWidth / 2);
  lbX = Math.max(-maxOffset, Math.min(maxOffset, lbX));
  const maxOffsetY = (lbScale - 1) * (lightboxStage.clientHeight / 2);
  lbY = Math.max(-maxOffsetY, Math.min(maxOffsetY, lbY));
}

function showLightboxImage(index) {
  lightboxImg.src = galleryImages[index];
  resetLightboxZoom();
  const hasMultiple = galleryImages.length > 1;
  [lightboxPrevBtn, lightboxNextBtn].forEach((btn) => {
    btn.classList.toggle('hidden', !hasMultiple);
    btn.classList.toggle('flex', hasMultiple);
  });
  lightboxCounter.classList.toggle('hidden', !hasMultiple);
  if (hasMultiple) {
    lightboxCounter.textContent = `${index + 1} / ${galleryImages.length}`;
  }
}

function openLightbox() {
  // Открыть в полный экран можно только настоящее фото, не текстовую заглушку
  if (modalImage.classList.contains('hidden')) return;
  showLightboxImage(galleryIndex);
  lightbox.classList.remove('hidden');
  document.body.classList.add('overflow-hidden');
  hapticImpact('light');
}

function closeLightbox() {
  lightbox.classList.add('hidden');
  // overflow-hidden всё ещё нужен обычной модалке, которая осталась открытой под низом
  hapticImpact('light');
}

// --- Жесты: пинч-зум и панорамирование через Pointer Events -----------
// Pointer Events унифицируют мышь/тач/перо одним API — не нужно отдельно
// обрабатывать touch- и mouse-события.
const activePointers = new Map();
let pinchStartDist = 0;
let pinchStartScale = 1;
let dragStart = null; // { x, y, lbX, lbY }
let lastTapTime = 0;

function pointerDist(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

lightboxImg.addEventListener('pointerdown', (e) => {
  lightboxImg.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 2) {
    const pts = [...activePointers.values()];
    pinchStartDist = pointerDist(pts[0], pts[1]);
    pinchStartScale = lbScale;
    dragStart = null;
  } else if (activePointers.size === 1) {
    dragStart = { x: e.clientX, y: e.clientY, lbX, lbY };
  }
});

lightboxImg.addEventListener('pointermove', (e) => {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 2) {
    const pts = [...activePointers.values()];
    const dist = pointerDist(pts[0], pts[1]);
    lbScale = Math.min(LB_MAX_SCALE, Math.max(LB_MIN_SCALE, pinchStartScale * (dist / pinchStartDist)));
    clampPan();
    applyLightboxTransform();
  } else if (activePointers.size === 1 && dragStart && lbScale > 1) {
    lbX = dragStart.lbX + (e.clientX - dragStart.x);
    lbY = dragStart.lbY + (e.clientY - dragStart.y);
    clampPan();
    applyLightboxTransform();
  }
});

function endPointer(e) {
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) pinchStartDist = 0;
  if (activePointers.size === 0) {
    const now = Date.now();
    const deltaX = dragStart ? e.clientX - dragStart.x : 0;
    const deltaY = dragStart ? e.clientY - dragStart.y : 0;
    const wasDrag = Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5;

    if (lbScale === 1 && wasDrag && Math.abs(deltaX) > 50 && Math.abs(deltaX) > Math.abs(deltaY)) {
      // Не увеличено — горизонтальный свайп листает фото вместо панорамирования
      setGalleryImage(deltaX > 0 ? galleryIndex - 1 : galleryIndex + 1);
    } else if (!wasDrag && now - lastTapTime < 300) {
      // Двойной тап/клик — переключаем зум
      if (lbScale > 1) {
        resetLightboxZoom();
      } else {
        lbScale = 2.5;
        applyLightboxTransform();
      }
    }
    lastTapTime = now;
    dragStart = null;
    if (lbScale < 1.02) resetLightboxZoom(); // защёлкиваем обратно к центру
  }
}
lightboxImg.addEventListener('pointerup', endPointer);
lightboxImg.addEventListener('pointercancel', endPointer);

// Колесо мыши — зум на десктопе, вокруг текущего положения
lightboxStage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.2 : 0.2;
  lbScale = Math.min(LB_MAX_SCALE, Math.max(LB_MIN_SCALE, lbScale + delta));
  if (lbScale <= 1) { lbX = 0; lbY = 0; }
  clampPan();
  applyLightboxTransform();
}, { passive: false });

// Клик по пустой области (не по самому фото) — закрыть
lightboxStage.addEventListener('click', (e) => {
  if (e.target === lightboxStage) closeLightbox();
});

// ==========================================================================
// 8. ОБРАБОТЧИКИ СОБЫТИЙ
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  renderCars();
  applyFilters();

  filterTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      currentLocationFilter = tab.dataset.filter;
      applyFilters();
      hapticImpact('light');
    });
  });

  if (carSearchInput) {
    carSearchInput.addEventListener('input', () => {
      currentSearchQuery = carSearchInput.value.trim().toLowerCase();
      applyFilters();
    });
  }
  if (carSearchClearBtn) {
    carSearchClearBtn.addEventListener('click', () => {
      carSearchInput.value = '';
      currentSearchQuery = '';
      applyFilters();
      carSearchInput.focus();
    });
  }

  // Делегирование клика: один слушатель на сетку вместо N слушателей на
  // каждую карточку (карточки создаются динамически через innerHTML).
  carsGrid.addEventListener('click', (e) => {
    const card = e.target.closest('[data-car-id]');
    if (!card) return;
    const car = CARS.find((c) => c.id === card.dataset.carId);
    if (car) openModal(car);
  });

  // Клавиатурная доступность: Enter/Space на сфокусированной карточке
  // открывают модалку так же, как клик мышью.
  carsGrid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('[data-car-id]');
    if (!card) return;
    e.preventDefault(); // пробел не должен скроллить страницу
    const car = CARS.find((c) => c.id === card.dataset.carId);
    if (car) openModal(car);
  });

  modalCloseBtn.addEventListener('click', closeModal);
  modalBackdrop.addEventListener('click', closeModal);

  // Клик по фото в модалке — открыть на весь экран
  modalImage.addEventListener('click', openLightbox);
  lightboxCloseBtn.addEventListener('click', closeLightbox);
  lightboxPrevBtn.addEventListener('click', () => setGalleryImage(galleryIndex - 1));
  lightboxNextBtn.addEventListener('click', () => setGalleryImage(galleryIndex + 1));

  // Стрелки галереи
  modalPrevBtn.addEventListener('click', () => {
    setGalleryImage(galleryIndex - 1);
    hapticImpact('light');
  });
  modalNextBtn.addEventListener('click', () => {
    setGalleryImage(galleryIndex + 1);
    hapticImpact('light');
  });

  // Свайп по фото в модалке (мобильные/тач-устройства)
  let touchStartX = 0;
  modalImageWrap.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
  }, { passive: true });
  modalImageWrap.addEventListener('touchend', (e) => {
    const deltaX = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(deltaX) < 40) return; // порог свайпа в пикселях
    setGalleryImage(deltaX > 0 ? galleryIndex - 1 : galleryIndex + 1);
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (modal.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      // Если открыт полноэкранный просмотр — закрываем сначала его,
      // а не всю модалку разом (ожидаемое поведение: верхний слой первым)
      if (!lightbox.classList.contains('hidden')) {
        closeLightbox();
      } else {
        closeModal();
      }
    }
    if (e.key === 'ArrowLeft') setGalleryImage(galleryIndex - 1);
    if (e.key === 'ArrowRight') setGalleryImage(galleryIndex + 1);
  });

  modalCTA.addEventListener('click', (e) => {
    hapticImpact('medium');
    // Внутри Telegram открываем чат нативным методом SDK — это надёжнее
    // обычной ссылки и не выкидывает пользователя в системный браузер.
    if (tg) {
      e.preventDefault();
      tg.openTelegramLink(modalCTA.href);
    }
  });
});
