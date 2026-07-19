'use strict';

/**
 * netlify/functions/bot.js — CarZ3 контент-бот
 *
 * Пайплайн: менеджер шлёт боту фото + сырой текст → Gemini превращает текст
 * в пост для канала и структурированный car_json → бот показывает превью и
 * спрашивает, кому из двух менеджеров отдать заявку → по подтверждению бот
 * ОДНИМ атомарным коммитом добавляет машину в data/cars.json + фото в
 * images/cars/ (триггерит билд на Netlify), а затем присылает готовые фото
 * и текст поста админу в личку — публикация в канал делается вручную.
 *
 * Отдельно: /list показывает все машины на сайте с кнопкой удаления у каждой.
 *
 * Состояние диалога живёт в Netlify Blobs (функция stateless между вызовами).
 *
 * ============================================================================
 * ПЕРЕД ЗАПУСКОМ:
 * 1. Заполнить все ENV VARS (список — в конце ответа).
 * 2. В TRUST_AND_CTA_BLOCK ниже вписать РЕАЛЬНЫЕ условия сделки — это
 *    сознательно не отдано на генерацию модели, юридически значимый текст
 *    не должен зависеть от того, что нейросеть "решит" сочинить в этот раз.
 * 3. setWebhook на https://<сайт>.netlify.app/.netlify/functions/bot
 *    с secret_token = TELEGRAM_WEBHOOK_SECRET.
 * 4. В репозитории должен существовать файл data/cars.json (массив, можно
 *    пустой []) — бот читает и дополняет именно его.
 * ============================================================================
 */

const { getStore, connectLambda } = require('@netlify/blobs');
const { GoogleGenAI } = require('@google/genai');

// ============================================================================
// 0. КОНФИГУРАЦИЯ
// ============================================================================
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET,
  ADMIN_CHAT_IDS,
  WEBAPP_URL,
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH,
  GCP_PROJECT_ID,
  GCP_LOCATION,
  GCP_SERVICE_ACCOUNT_JSON,
  GEMINI_MODEL,
  EMOJI_CHECK_ID,
  EMOJI_ARROW_ID,
  EMOJI_DIAMOND_ID,
} = process.env;

const BRANCH = GITHUB_BRANCH || 'main';
const MODEL = GEMINI_MODEL || 'gemini-2.5-flash';
const ADMIN_IDS = (ADMIN_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

// Менеджеры для ручного выбора при публикации — имя для кнопки + username,
// на который на сайте ведёт "Оформить заказ". Поменять состав/имена — только здесь.
const MANAGERS = [
  { username: 'Michail2004', name: 'Михаил' },
  { username: 'alexcash2025', name: 'Алексей' },
];

const BLOB_STORE_NAME = 'carz3-drafts';

// ============================================================================
// 1. ОБЩИЕ УТИЛИТЫ
// ============================================================================

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Оборачивает символ в кастом-эмодзи, если ID настроен в env; иначе просто
// отдаёт обычный символ — деградация без единого if в вызывающем коде.
function tgEmoji(id, fallbackChar) {
  if (!id) return fallbackChar;
  return `<tg-emoji emoji-id="${id}">${fallbackChar}</tg-emoji>`;
}

const RU_TO_LAT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

// Тот же формат id, что и в CARS на фронтенде: bmw-x3-2026
function slugify(brand, model, year) {
  const translit = (s) => String(s)
    .toLowerCase()
    .split('')
    .map((ch) => RU_TO_LAT[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${translit(brand)}-${translit(model)}-${year}`;
}

function uniqueId(baseId, existingCars) {
  const ids = new Set(existingCars.map((c) => c.id));
  if (!ids.has(baseId)) return baseId;
  let n = 2;
  while (ids.has(`${baseId}-${n}`)) n += 1;
  return `${baseId}-${n}`;
}

// Больше не выбирает менеджера автоматически — только считает текущий баланс
// для подсказки в превью, финальный выбор всегда делает человек кнопкой.
function managerCounts(existingCars) {
  const counts = {};
  MANAGERS.forEach((m) => { counts[m.username] = 0; });
  existingCars.forEach((c) => {
    if (counts[c.manager] !== undefined) counts[c.manager] += 1;
  });
  return counts;
}

function managerName(username) {
  const m = MANAGERS.find((x) => x.username === username);
  return m ? m.name : username;
}

// Защита от того, чтобы в реальный прайс на сайте улетела галлюцинация —
// не доверяем числам от Gemini вслепую, проверяем на здравый смысл.
function validateCarJson(car) {
  const errors = [];
  if (!car.brand || !car.model) errors.push('нет марки или модели');
  if (!Number.isInteger(car.year) || car.year < 2000 || car.year > 2030) {
    errors.push(`подозрительный год: ${car.year}`);
  }
  if (!Number.isInteger(car.price) || car.price < 100000 || car.price > 100000000) {
    errors.push(`подозрительная цена: ${car.price}`);
  }
  if (!Number.isInteger(car.mileage) || car.mileage < 0) {
    errors.push(`подозрительный пробег: ${car.mileage}`);
  }
  if (!Array.isArray(car.features) || car.features.length === 0) {
    errors.push('нет комплектации');
  }
  return errors;
}

// Фиксированные, НЕ генерируемые моделью блоки — см. пункт 2 в шапке файла.
// Два варианта окончания поста: если машина идёт в каталог — кликабельное
// слово "витрину" вместо голого URL; если нет — прямые контакты обоих
// менеджеров сразу в посте. Выбор между ними — явный шаг в диалоге с ботом,
// один и тот же процесс для абсолютно всех машин, каталожных и нет.
function trustLine() {
  return 'Работаем по договору. Перед выкупом — проверка автомобиля и фотоотчёт с площадки.';
}

function catalogCtaBlock() {
  const arrow = tgEmoji(EMOJI_ARROW_ID, '→');
  const diamond = tgEmoji(EMOJI_DIAMOND_ID, '·');
  return [
    trustLine(),
    '',
    `${arrow} Открыть <a href="${WEBAPP_URL}">витрину</a> с фото и актуальными ценами`,
    `CarZ3 ${diamond} Автомобили под заказ ${diamond} Корея ${diamond} Китай`,
  ].join('\n');
}

function directContactBlock() {
  const diamond = tgEmoji(EMOJI_DIAMOND_ID, '·');
  const contacts = MANAGERS.map((m) => `${m.name} — @${m.username}`).join('\n');
  return [
    trustLine(),
    '',
    'По этому автомобилю:',
    contacts,
    '',
    `CarZ3 ${diamond} Автомобили под заказ ${diamond} Корея ${diamond} Китай`,
  ].join('\n');
}

function formatPriceRu(value) {
  return `${new Intl.NumberFormat('ru-RU').format(value)} ₽`;
}

function assembleFinalPost(geminiPostText, wantsCatalog) {
  const footer = wantsCatalog ? catalogCtaBlock() : directContactBlock();
  return `${geminiPostText.trim()}\n\n${footer}`;
}

// ============================================================================
// 2. ЧЕРНОВИК — состояние диалога между сообщениями, через GitHub
// ============================================================================
//
// Изначально черновик жил в Netlify Blobs. После нескольких раундов попыток
// (включая strong consistency на уровне store и точечно на чтении) осталась
// одна и та же поломка: даже простая, последовательная отправка фото по
// одному не давала счётчику расти дальше "1 шт." — то есть запись одного
// сообщения не была надёжно видна следующему. Дальше гадать с настройками
// одного и того же примитива было бы просто ещё одной попыткой того же.
//
// Вместо этого черновик хранится файлом в самом репозитории, на отдельной
// ветке (GITHUB_DRAFT_BRANCH), которую Netlify НЕ отслеживает для деплоя —
// значит, ни один апдейт черновика не тратит деплой-кредиты и не вызывает
// пересборку сайта. Механизм тот же самый Git Data API, которым мы уже
// пользуемся для машин на сайте — там ни разу не было проблем с тем, видит
// ли следующее чтение предыдущую запись. Чуть больше сетевых вызовов на
// каждое сообщение, зато основано на том, что уже доказанно работает.

const GITHUB_DRAFT_BRANCH = process.env.GITHUB_DRAFT_BRANCH || 'bot-state';
const DRAFT_TTL_MS = 2 * 60 * 60 * 1000; // 2 часа — старше считаем брошенным черновиком
const MAX_PHOTOS_PER_CAR = 15; // с запасом над нативным лимитом Telegram в 10 фото на альбом

function draftPath(chatId) {
  return `.bot-drafts/${chatId}.json`;
}

function isNotFound(err) {
  return err.message.includes('→ 404');
}

// Ветка создаётся один раз при первом обращении, если её ещё нет —
// от текущего HEAD основной ветки. Дальше просто существует и используется.
async function ensureDraftBranch() {
  try {
    await githubApi(`${REPO_PATH}/git/refs/heads/${GITHUB_DRAFT_BRANCH}`);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    const mainRef = await githubApi(`${REPO_PATH}/git/refs/heads/${BRANCH}`);
    await githubApi(`${REPO_PATH}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${GITHUB_DRAFT_BRANCH}`, sha: mainRef.object.sha }),
    });
  }
}

async function getDraft(chatId) {
  let file;
  try {
    file = await githubApi(`${REPO_PATH}/contents/${draftPath(chatId)}?ref=${GITHUB_DRAFT_BRANCH}`);
  } catch (err) {
    if (isNotFound(err)) return null; // черновика ещё нет — это нормальное состояние
    throw err; // любая другая ошибка должна дойти до пользователя, не прятаться молча
  }

  const draft = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  if (draft.updatedAt && Date.now() - draft.updatedAt > DRAFT_TTL_MS) {
    await clearDraft(chatId);
    return null;
  }
  // sha нужен для следующей записи (оптимистичная блокировка GitHub) —
  // неперечисляемый, чтобы не попасть в JSON.stringify/спред дальше по коду
  Object.defineProperty(draft, '_sha', { value: file.sha, enumerable: false });
  return draft;
}

async function setDraft(chatId, draft) {
  await ensureDraftBranch();

  const payload = { ...draft, updatedAt: Date.now() };
  const blob = await githubApi(`${REPO_PATH}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({
      content: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
      encoding: 'base64',
    }),
  });

  // GitHub отклонит обновление ветки (не fast-forward), если она успела
  // сдвинуться между нашим чтением и записью — это и есть защита от гонки,
  // в отличие от Netlify Blobs, где конфликтующая запись просто молча
  // побеждает. Но без повтора это означало бы, что редкая гонка (два
  // сообщения почти одновременно) превращается в видимую ошибку у
  // пользователя. Пробуем ещё раз с уже новым состоянием ветки — это
  // единственное реальное решение для гонки: подхватить, что появилось,
  // и переналожить свою запись поверх, а не просто упасть.
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { baseCommitSha, baseTreeSha } = await getBaseTreeInfo(GITHUB_DRAFT_BRANCH);
      // eslint-disable-next-line no-await-in-loop
      await pushTreeAsCommit(
        GITHUB_DRAFT_BRANCH, baseTreeSha, baseCommitSha,
        [{ path: draftPath(chatId), mode: '100644', type: 'blob', sha: blob.sha }],
        `draft: ${chatId}`,
      );
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function clearDraft(chatId) {
  let exists = true;
  try {
    await githubApi(`${REPO_PATH}/contents/${draftPath(chatId)}?ref=${GITHUB_DRAFT_BRANCH}`);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    exists = false;
  }
  if (!exists) return; // уже нечего чистить

  const { baseCommitSha, baseTreeSha } = await getBaseTreeInfo(GITHUB_DRAFT_BRANCH);
  await pushTreeAsCommit(
    GITHUB_DRAFT_BRANCH, baseTreeSha, baseCommitSha,
    [{ path: draftPath(chatId), mode: '100644', type: 'blob', sha: null }],
    `draft: очищен ${chatId}`,
  );
}

// Фото живут ПРЯМО в черновике (draft.photos, массив base64-строк), тем же
// способом, что rawText и lastMediaGroupId — один файл, одна операция
// чтения-изменения-записи через getDraft/setDraft выше, без отдельных
// ключей на каждое фото.
//
// Осознанный компромисс: если 10+ фото одного альбома придут ПО-НАСТОЯЩЕМУ
// одновременно, в редком случае возможен конфликт записи (GitHub отклонит
// commit с устаревшим sha) — тогда конкретно то фото не сохранится, но
// вебхук всё равно не упадёт с ошибкой. Это узкий случай при обычной
// человеческой скорости отправки, и он несравнимо лучше того, что было
// на Netlify Blobs: полностью нерабочий подсчёт даже при отправке по одному.

// ============================================================================
// 3. GEMINI — генерация поста и car_json одним structured-output вызовом
// ============================================================================

const CAR_JSON_SCHEMA = {
  type: 'object',
  properties: {
    telegram_post: {
      type: 'string',
      description:
        'Готовый текст поста в HTML-разметке Telegram, БЕЗ блока доверия, ' +
        'БЕЗ призыва открыть каталог и БЕЗ подписи бренда — это добавляется отдельно кодом.',
    },
    car_json: {
      type: 'object',
      properties: {
        brand: { type: 'string' },
        model: { type: 'string' },
        year: { type: 'integer' },
        engineVolume: { type: 'number', nullable: true },
        horsePower: { type: 'integer', nullable: true },
        transmission: { type: 'string', nullable: true },
        drivetrain: { type: 'string', nullable: true },
        mileage: { type: 'integer' },
        price: { type: 'integer' },
        features: { type: 'array', items: { type: 'string' } },
        location: { type: 'string', nullable: true },
        status: { type: 'string' },
      },
      required: ['brand', 'model', 'year', 'mileage', 'price', 'features', 'status'],
      propertyOrdering: [
        'brand', 'model', 'year', 'engineVolume', 'horsePower', 'transmission',
        'drivetrain', 'mileage', 'price', 'features', 'location', 'status',
      ],
    },
  },
  required: ['telegram_post', 'car_json'],
};

function buildSystemInstruction() {
  const check = tgEmoji(EMOJI_CHECK_ID, '✓');
  return `Ты — копирайтер автомобильного бренда премиум-сегмента CarZ3 (параллельный импорт из Кореи и Китая, чек 3-10 млн ₽) и одновременно точный парсер данных. На вход — сырой неструктурированный текст от поставщика. На выходе — JSON строго по заданной схеме.

=== ГЛАВНЫЙ ПРИНЦИП ТЕКСТА ===
Покупатель дорогой машины боится не переплатить — он боится обмана. Пост снижает тревогу, а не разгоняет ажиотаж. Премиум не кричит.

=== ЖЁСТКИЕ ЗАПРЕТЫ В ТЕКСТЕ ===
- Запрещены слова: супер, срочно, успей, жми, шок, горит, топ, вау, скидка, выгодно.
- Запрещены CAPS LOCK (кроме аббревиатур вроде AWD, TFSI), тройные знаки (!!!), эмодзи 🔥❗️👉👇🟢💥🚨.
- Максимум 1 нейтральный обычный эмодзи на пост, по умолчанию — ноль.
- Дефицит и сроки ("последняя", "уходит") — ТОЛЬКО если это прямо есть во входных данных. Не выдумывай.

=== СТРУКТУРА ПОЛЯ telegram_post (строго, используй HTML-теги Telegram) ===
Строка 1: <b>Марка Модель · главная деталь комплектации</b>
Строка 2: год · страна · пробег (0 км или "новый" в тексте → пиши "новый", не "0 км")
(пустая строка)
2-3 строки характеристик связной прозой — мощность, привод, коробка + 1-2 самые статусные опции. НЕ маркированный список всего подряд.
1 строка смысла: что эти факты значат для покупателя. Выводи строго из данных, не фантазируй (пример хода мысли: маленький пробег → "фактически новый автомобиль — без пробега по России"; нет данных для такого вывода — пропусти строку, не выдумывай).
(пустая строка)
<b>${check} ЦЕНА ₽ — финальная цена под ключ</b>
1 строка: что включено в цену — бери из входных данных (таможня, утильсбор, доставка до города N). Если во входных данных этого нет — пропусти строку.

НЕ включай в telegram_post: блок доверия, призыв открыть каталог, подпись бренда — это добавляется отдельно кодом после твоего ответа.

=== ПРАВИЛА ДАННЫХ ДЛЯ car_json (это важнее, чем красота текста) ===
- Извлекай только то, что ЯВНО есть во входном тексте. Если transmission, drivetrain, location, engineVolume или horsePower в тексте нет — верни null для этого поля. НИКОГДА не угадывай и не подставляй типичное для этой модели значение, даже если уверен в нём технически: это реальный автомобиль, который продают за реальные деньги, ошибка в характеристике — это чужой репутационный и юридический риск, не твой.
- price — только число, без валюты и разделителей разрядов.
- mileage: если "новый" или "0 км" — верни 0.
- features — 3-8 пунктов из явно перечисленной комплектации, каждый — короткая именная группа ("Панорамная крыша", а не "Есть панорамная крыша с электроприводом").
- status — "Под заказ", если явно не указано иное.

=== HTML-РАЗМЕТКА ===
Разрешённые теги внутри telegram_post: <b>...</b> и <tg-emoji emoji-id="ID">символ</tg-emoji>. Символ внутри tg-emoji ОБЯЗАТЕЛЕН — это видимый fallback для клиентов без поддержки кастом-эмодзи, никогда не оставляй тег пустым. Символы & < > вне тегов экранируй как &amp; &lt; &gt;.`;
}

// Разбирает GCP_SERVICE_ACCOUNT_JSON и кэширует результат на весь "тёплый"
// жизненный цикл функции. Специально ЛЕНИВАЯ (вызывается только при
// реальном обращении к Gemini, не при загрузке модуля) — если ключ сервис-
// аккаунта окажется битым, сломается только генерация поста, а не приём
// фото/текста и остальные команды бота.
let cachedCredentials = null;
function getServiceAccountCredentials() {
  if (cachedCredentials) return cachedCredentials;

  const raw = GCP_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON не задан в переменных окружения Netlify');
  }

  // Значение может быть либо сырым JSON, либо (рекомендуется) его base64 —
  // см. инструкцию по заполнению переменной. Раскодируем, если это не JSON.
  let jsonText = raw.trim();
  if (!jsonText.startsWith('{')) {
    try {
      jsonText = Buffer.from(jsonText, 'base64').toString('utf8');
    } catch {
      // не похоже на валидный base64 — оставляем как есть, JSON.parse ниже
      // сам даст понятную ошибку вместо тихого падения здесь
    }
  }

  let credentials;
  try {
    credentials = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `GCP_SERVICE_ACCOUNT_JSON не парсится как JSON: ${err.message}. ` +
      'Проверь, что в переменную попал весь файл ключа целиком (или его base64), без обрезки.',
    );
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON не похож на ключ сервисного аккаунта: нет client_email или private_key');
  }

  // Известный класс проблем с ключами в env-переменных: где-то по пути
  // реальный перенос строки внутри private_key превращается в ДВА символа
  // "\" и "n" вместо настоящего 0x0A. Штатный JSON.parse так не делает —
  // но если значение прошло через промежуточный слой с доп. экранированием
  // (bash-скрипт, другой конфиг-менеджер), это встречается. Чиним защитно.
  if (credentials.private_key.includes('\\n')) {
    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  }

  cachedCredentials = credentials;
  return credentials;
}

let cachedGeminiClient = null;
function getGeminiClient() {
  if (cachedGeminiClient) return cachedGeminiClient;
  if (!GCP_PROJECT_ID || !GCP_LOCATION) {
    throw new Error('GCP_PROJECT_ID и/или GCP_LOCATION не заданы в переменных окружения Netlify');
  }
  cachedGeminiClient = new GoogleGenAI({
    vertexai: true,
    project: GCP_PROJECT_ID,
    location: GCP_LOCATION,
    googleAuthOptions: {
      credentials: getServiceAccountCredentials(),
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    },
  });
  return cachedGeminiClient;
}

async function generatePost(rawText) {
  const ai = getGeminiClient();
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: rawText,
    config: {
      systemInstruction: buildSystemInstruction(),
      responseMimeType: 'application/json',
      responseSchema: CAR_JSON_SCHEMA,
      temperature: 0.6,
    },
  });

  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch (err) {
    throw new Error(`Gemini вернул невалидный JSON: ${err.message}`);
  }
  if (!parsed.telegram_post || !parsed.car_json) {
    throw new Error('Gemini вернул неполный объект (нет telegram_post или car_json)');
  }
  return parsed;
}

// ============================================================================
// 4. GITHUB — атомарный коммит (Git Data API: blob → tree → commit → ref)
// ============================================================================

const GITHUB_API = 'https://api.github.com';
const REPO_PATH = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

async function githubApi(path, options = {}) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${options.method || 'GET'} ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function getCurrentCarsJson() {
  const file = await githubApi(`${REPO_PATH}/contents/data/cars.json?ref=${BRANCH}`);
  const content = Buffer.from(file.content, 'base64').toString('utf8');
  return JSON.parse(content);
}

/**
 * Публикует машину: обновлённый data/cars.json + фото — ОДНИМ коммитом,
 * значит Netlify увидит один пуш и запустит одну сборку, а не N.
 *
 * existingCars передаётся снаружи, а не читается здесь заново — вызывающий
 * код уже прочитал cars.json один раз, чтобы посчитать id/manager, и то же
 * прочитанное состояние используется для пуша, а не два независимых чтения
 * с окном рассинхронизации между ними.
 *
 * Известное и принятое упрощение: между чтением ref и записью нет
 * оптимистичной блокировки. Для одного администратора, жмущего кнопки
 * последовательно, гонка практически невозможна; если бот когда-нибудь
 * станет многопользовательским — здесь нужен retry с повторным чтением ref.
 */
async function getBaseTreeInfo(branch) {
  const ref = await githubApi(`${REPO_PATH}/git/refs/heads/${branch}`);
  const baseCommitSha = ref.object.sha;
  const baseCommit = await githubApi(`${REPO_PATH}/git/commits/${baseCommitSha}`);
  return { baseCommitSha, baseTreeSha: baseCommit.tree.sha };
}

async function pushTreeAsCommit(branch, baseTreeSha, baseCommitSha, treeEntries, message) {
  const tree = await githubApi(`${REPO_PATH}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
  });
  const commit = await githubApi(`${REPO_PATH}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [baseCommitSha] }),
  });
  await githubApi(`${REPO_PATH}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha }),
  });
  return commit.sha;
}

async function commitCarToRepo({ car, existingCars, photoBuffers, photoPaths }) {
  const { baseCommitSha, baseTreeSha } = await getBaseTreeInfo(BRANCH);

  const cars = [...existingCars, car];
  const carsJsonContent = `${JSON.stringify(cars, null, 2)}\n`;

  const [carsBlob, ...photoBlobs] = await Promise.all([
    githubApi(`${REPO_PATH}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({
        content: Buffer.from(carsJsonContent, 'utf8').toString('base64'),
        encoding: 'base64',
      }),
    }),
    ...photoBuffers.map((buf) => githubApi(`${REPO_PATH}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }),
    })),
  ]);

  return pushTreeAsCommit(
    BRANCH, baseTreeSha, baseCommitSha,
    [
      { path: 'data/cars.json', mode: '100644', type: 'blob', sha: carsBlob.sha },
      ...photoPaths.map((path, i) => ({ path, mode: '100644', type: 'blob', sha: photoBlobs[i].sha })),
    ],
    `car: добавлен ${car.brand} ${car.model} (${car.year}), фото: ${photoBuffers.length}`,
  );
}

/**
 * Удаляет машину: убирает её из data/cars.json И удаляет её фото из
 * images/cars/ — тем же коммитом. Для удаления файла из дерева GitHub
 * задокументировано: передать sha: null для этого пути в tree — это не
 * догадка, а официальный механизм Git Data API.
 */
async function deleteCarFromRepo(carId) {
  const { baseCommitSha, baseTreeSha } = await getBaseTreeInfo(BRANCH);

  const cars = await getCurrentCarsJson();
  const car = cars.find((c) => c.id === carId);
  if (!car) throw new Error(`Машина ${carId} не найдена в cars.json — возможно, уже удалена`);

  const remainingCars = cars.filter((c) => c.id !== carId);
  const carsJsonContent = `${JSON.stringify(remainingCars, null, 2)}\n`;

  const carsBlob = await githubApi(`${REPO_PATH}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({
      content: Buffer.from(carsJsonContent, 'utf8').toString('base64'),
      encoding: 'base64',
    }),
  });

  const treeEntries = [
    { path: 'data/cars.json', mode: '100644', type: 'blob', sha: carsBlob.sha },
    ...(car.images || []).map((imgPath) => ({ path: imgPath, mode: '100644', type: 'blob', sha: null })),
  ];

  return pushTreeAsCommit(
    BRANCH, baseTreeSha, baseCommitSha, treeEntries,
    `car: удалён ${car.brand} ${car.model} (${car.year})`,
  );
}

// ============================================================================
// 5. TELEGRAM API
// ============================================================================

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TG_FILE_API = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}`;

async function tg(method, payload) {
  if (!TELEGRAM_BOT_TOKEN) {
    // Пустой токен даёт URL вида ".../bot/sendMessage" — Telegram вернёт
    // просто "404: Not Found", по которому невозможно понять причину не
    // заглянув в переменные окружения. Проверяем это здесь явно.
    throw new Error('TELEGRAM_BOT_TOKEN не задан в переменных окружения Netlify');
  }
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    // Повторное редактирование тем же содержимым (двойной тап, повторная
    // доставка вебхука) — не поломка, а безобидный no-op. Telegram сам
    // отказывается менять то, что уже показано; не роняем из-за этого
    // остальной обработчик и не пугаем пользователя "Что-то сломалось".
    if (data.description && data.description.includes('message is not modified')) {
      return null;
    }
    throw new Error(`Telegram ${method} → ${data.error_code}: ${data.description}`);
  }
  return data.result;
}

function stripHtml(text) {
  return String(text).replace(/<[^>]+>/g, '');
}

// Gemini иногда выдаёт чуть кривой HTML (незакрытый тег и т.п.), и Telegram
// тогда отказывается принять сообщение целиком с ENTITY_TEXT_INVALID.
// Вместо жёсткого падения — отправляем то же самое обычным текстом, без
// разметки, но пользователь хотя бы получает контент, а не ошибку.
async function tgWithHtmlFallback(method, payload) {
  try {
    return await tg(method, { ...payload, parse_mode: 'HTML' });
  } catch (err) {
    if (err.message && (err.message.includes('ENTITY_TEXT_INVALID') || err.message.includes("can't parse entities"))) {
      const fallback = { ...payload };
      delete fallback.parse_mode;
      if (fallback.text) fallback.text = stripHtml(fallback.text);
      return tg(method, fallback);
    }
    throw err;
  }
}

function sendMessage(chatId, text, extra = {}) {
  return tgWithHtmlFallback('sendMessage', { chat_id: chatId, text, ...extra });
}

function editMessageText(chatId, messageId, text, extra = {}) {
  return tgWithHtmlFallback('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra });
}

// Истёкший callback (нажатие больше ~секунды назад) не должен ронять весь
// остальной обработчик — это просто визуальный "часики" на кнопке у Мики.
function answerCallbackQuery(id, text) {
  return tg('answerCallbackQuery', { callback_query_id: id, text }).catch(() => {});
}

async function sendPhotoBuffer(chatId, buffer, filename, caption, extra = {}) {
  const buildForm = (captionText) => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (captionText) {
      form.append('caption', captionText);
      form.append('parse_mode', 'HTML');
    }
    if (extra.reply_markup) form.append('reply_markup', JSON.stringify(extra.reply_markup));
    form.append('photo', new Blob([buffer]), filename);
    return form;
  };

  const send = async (captionText) => {
    const res = await fetch(`${TG_API}/sendPhoto`, { method: 'POST', body: buildForm(captionText) });
    return res.json();
  };

  let data = await send(caption);
  if (!data.ok && caption && data.description
      && (data.description.includes('ENTITY_TEXT_INVALID') || data.description.includes("can't parse entities"))) {
    // Та же защита, что у sendMessage/editMessageText: кривой HTML в подписи
    // не должен ронять отправку фото целиком — откатываемся на голый текст.
    data = await send(stripHtml(caption));
  }
  if (!data.ok) throw new Error(`Telegram sendPhoto → ${data.error_code}: ${data.description}`);
  return data.result;
}

async function getFileBuffer(fileId) {
  const fileInfo = await tg('getFile', { file_id: fileId });
  const res = await fetch(`${TG_FILE_API}/${fileInfo.file_path}`);
  if (!res.ok) throw new Error(`Не удалось скачать файл у Telegram: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function inlineKeyboard(rows) {
  return { inline_keyboard: rows };
}

// ============================================================================
// 6. РОУТИНГ ОБНОВЛЕНИЙ
// ============================================================================

async function handleMessage(msg) {
  const chatId = msg.chat.id;

  if (msg.text === '/start' || msg.text === '/help') {
    await sendMessage(
      chatId,
      'Пришли фото машины (можно сразу с подписью-текстом от поставщика) — или фото и текст отдельными сообщениями, в любом порядке. Когда всё будет на месте, появится кнопка «Сгенерировать».\n\n/list — список машин на сайте, с удалением.\n/new — сбросить текущий черновик и начать заново.',
    );
    return;
  }

  if (msg.text === '/list') {
    await handleList(chatId, null);
    return;
  }

  if (msg.text === '/new') {
    await clearDraft(chatId);
    await sendMessage(chatId, 'Черновик сброшен. Пришли фото новой машины.');
    return;
  }

  const draft = (await getDraft(chatId)) || {};
  draft.photos = draft.photos || [];

  if (Array.isArray(msg.photo) && msg.photo.length) {
    if (draft.photos.length >= MAX_PHOTOS_PER_CAR) {
      await sendMessage(chatId, `Уже ${draft.photos.length} фото — этого более чем достаточно, дальше не принимаю. Пришли текст с характеристиками или /new, если это другая машина.`);
      return;
    }

    const largest = msg.photo[msg.photo.length - 1]; // Telegram шлёт несколько размеров, берём самый крупный
    const photoBase64 = (await getFileBuffer(largest.file_id)).toString('base64');
    draft.photos.push(photoBase64);

    // Подавление повторного ответа на каждое фото альбома — косметика,
    // не критично для сохранности: фото уже в draft.photos выше.
    const isContinuingSameAlbum = Boolean(msg.media_group_id) && draft.lastMediaGroupId === msg.media_group_id;
    if (msg.media_group_id) draft.lastMediaGroupId = msg.media_group_id;
    if (msg.caption) draft.rawText = msg.caption;
    await setDraft(chatId, draft);

    if (isContinuingSameAlbum) return;
  } else if (msg.text) {
    draft.rawText = msg.text;
    await setDraft(chatId, draft);
  } else {
    await sendMessage(chatId, 'Понимаю только текст и фото. Пришли характеристики машины и хотя бы одно фото.');
    return;
  }

  const photoCount = draft.photos.length;
  if (photoCount > 0 && draft.rawText) {
    await sendMessage(chatId, `Фото (${photoCount} шт.) и текст на месте.`, {
      reply_markup: inlineKeyboard([
        [{ text: '🪄 Сгенерировать', callback_data: 'gen' }],
        [{ text: '🆕 Новая машина (сбросить)', callback_data: 'new' }],
      ]),
    });
  } else if (photoCount > 0) {
    await sendMessage(chatId, `Фото получил (${photoCount} шт.) — присылай ещё, если есть, добавятся автоматически. Теперь пришли текст с характеристиками от поставщика.`);
  } else {
    await sendMessage(chatId, 'Текст получил. Теперь пришли фото машины (можно несколько подряд, до 10 шт.).');
  }
}

async function handleGenerate(chatId, messageId) {
  const draft = await getDraft(chatId);
  const photoCountCheck = draft && draft.photos ? draft.photos.length : 0;
  if (!draft || !draft.rawText || !photoCountCheck) {
    const details = !draft
      ? 'черновика нет вообще (истёк по времени или был явно сброшен)'
      : `текст: ${draft.rawText ? 'есть' : 'нет'}, фото: ${photoCountCheck} шт.`;
    await editMessageText(
      chatId, messageId,
      `Черновик потерян — пришли фото и текст заново.\n\n<code>${escapeHtml(details)}</code>\n\nЕсли жал «Сгенерировать» на старом сообщении бота — новые кнопки появляются только на последнем, старые в переписке уже неактивны по смыслу, даже если Telegram их не подсвечивает серым.`,
    );
    return;
  }

  await editMessageText(chatId, messageId, '⏳ Генерирую...');

  let result;
  try {
    result = await generatePost(draft.rawText);
  } catch (err) {
    await editMessageText(
      chatId, messageId,
      `Не получилось сгенерировать: ${escapeHtml(err.message)}`,
      { reply_markup: inlineKeyboard([[{ text: '🔄 Повторить', callback_data: 'gen' }]]) },
    );
    return;
  }

  const problems = validateCarJson(result.car_json);
  if (problems.length) {
    await clearDraft(chatId);
    await editMessageText(
      chatId, messageId,
      `Не публикую — данные выглядят подозрительно:\n${problems.map((p) => `· ${escapeHtml(p)}`).join('\n')}\n\nПроверь исходный текст поставщика и пришли заново.`,
    );
    return;
  }

  draft.geminiResult = result;
  await setDraft(chatId, draft);
  // Превью тут — ещё БЕЗ подвала: он зависит от следующего выбора
  // (каталог даёт ссылку-витрину, без каталога — прямые контакты обоих
  // менеджеров), поэтому финальный текст собирается уже после этого шага.
  const preview = `${result.telegram_post.trim()}\n\n———\n<code>${escapeHtml(JSON.stringify(result.car_json, null, 2))}</code>`;

  await editMessageText(chatId, messageId, `${preview}\n\nЭта машина идёт в каталог на сайте?`, {
    reply_markup: inlineKeyboard([
      [{ text: '✅ Да, в каталог', callback_data: 'cat:yes' }, { text: '📰 Только пост', callback_data: 'cat:no' }],
      [{ text: '🔄 Заново', callback_data: 'gen' }, { text: '❌ Отмена', callback_data: 'cancel' }],
    ]),
  });
}

// Развилка после генерации: с каталогом — ещё нужен менеджер (см. ниже),
// без каталога — сразу к единственному подтверждению, оба контакта в тексте.
async function handleCatalogChoice(chatId, messageId, wantsCatalog) {
  const draft = await getDraft(chatId);
  if (!draft || !draft.geminiResult) {
    await editMessageText(chatId, messageId, 'Черновик потерян — начни заново.');
    return;
  }

  const finalPost = assembleFinalPost(draft.geminiResult.telegram_post, wantsCatalog);
  const preview = `${finalPost}\n\n———\n<code>${escapeHtml(JSON.stringify(draft.geminiResult.car_json, null, 2))}</code>`;

  if (!wantsCatalog) {
    await editMessageText(chatId, messageId, `${preview}\n\nВсё верно?`, {
      reply_markup: inlineKeyboard([
        [{ text: '✅ Готово, пришли мне', callback_data: 'pubdirect' }],
        [{ text: '🔄 Заново', callback_data: 'gen' }, { text: '❌ Отмена', callback_data: 'cancel' }],
      ]),
    });
    return;
  }

  let balanceLine = '';
  try {
    const counts = managerCounts(await getCurrentCarsJson());
    balanceLine = `\n\nСейчас на сайте: ${MANAGERS.map((m) => `${m.name} — ${counts[m.username]}`).join(', ')}`;
  } catch {
    // не смогли прочитать cars.json для подсказки — не блокируем публикацию из-за этого
  }

  await editMessageText(chatId, messageId, `${preview}${balanceLine}\n\nКому эта заявка?`, {
    reply_markup: inlineKeyboard([
      MANAGERS.map((m) => ({ text: `✅ ${m.name}`, callback_data: `pub:${m.username}` })),
      [{ text: '🔄 Заново', callback_data: 'gen' }, { text: '❌ Отмена', callback_data: 'cancel' }],
    ]),
  });
}

async function handlePublish(chatId, messageId, managerUsername) {
  const draft = await getDraft(chatId);
  const storedPhotos = draft && draft.photos ? draft.photos : [];
  if (!draft || !draft.geminiResult || !storedPhotos.length) {
    await editMessageText(chatId, messageId, 'Черновик потерян — начни заново.');
    return;
  }
  if (!MANAGERS.some((m) => m.username === managerUsername)) {
    await editMessageText(chatId, messageId, 'Не узнаю этого менеджера — начни заново.');
    return;
  }

  await editMessageText(chatId, messageId, '⏳ Добавляю на сайт...');

  const { telegram_post: rawPost, car_json: carContent } = draft.geminiResult;
  const photoBuffers = storedPhotos.map((b64) => Buffer.from(b64, 'base64'));
  const finalPost = assembleFinalPost(rawPost, true);

  try {
    const existingCars = await getCurrentCarsJson();
    const id = uniqueId(slugify(carContent.brand, carContent.model, carContent.year), existingCars);
    const photoPaths = photoBuffers.map((_, i) => `images/cars/${id}/${id}-${i + 1}.jpg`);
    const car = { id, ...carContent, manager: managerUsername, images: photoPaths };

    const commitSha = await commitCarToRepo({ car, existingCars, photoBuffers, photoPaths });

    await clearDraft(chatId);
    await editMessageText(
      chatId, messageId,
      `✅ Добавлено на сайт: ${photoBuffers.length} фото, менеджер ${managerName(managerUsername)}.\nКоммит: <code>${commitSha.slice(0, 7)}</code>\nСайт обновится примерно через минуту.\n\nОбложка и готовый пост для канала — следующими двумя сообщениями (остальные фото уже на сайте, для канала обычно достаточно одного). Опубликуй их сам: скопируй текст и прикрепи фото.`,
    );

    // Для ручной публикации в канал хватает одной обложки — постить туда все
    // 10 фото одним постом не нужно, для этого и есть галерея на сайте.
    // Фото и текст отдельными сообщениями — не подписью к фото, чтобы текст
    // копировался одним движением без лимита длины подписи, и без пометки
    // "переслано от бота", если решишь скопировать текст, а не переслать.
    await sendPhotoBuffer(chatId, photoBuffers[0], `${id}-1.jpg`, null);
    await sendMessage(chatId, finalPost);
  } catch (err) {
    await editMessageText(
      chatId, messageId,
      `Ошибка при добавлении на сайт: ${escapeHtml(err.message)}\n\nЧерновик сохранён — можно попробовать снова.`,
      { reply_markup: inlineKeyboard([[{ text: '🔁 Повторить', callback_data: `pub:${managerUsername}` }]]) },
    );
  }
}

// Машина НЕ идёт на сайт — ни одного обращения к GitHub. Просто отдаём
// готовые фото и текст (с прямыми контактами обоих менеджеров в подвале),
// публикация в канал — вручную, как и для каталожных машин.
async function handlePublishDirect(chatId, messageId) {
  const draft = await getDraft(chatId);
  const storedPhotos = draft && draft.photos ? draft.photos : [];
  if (!draft || !draft.geminiResult || !storedPhotos.length) {
    await editMessageText(chatId, messageId, 'Черновик потерян — начни заново.');
    return;
  }

  const finalPost = assembleFinalPost(draft.geminiResult.telegram_post, false);
  const photoBuffer = Buffer.from(storedPhotos[0], 'base64'); // для поста в канал хватает одной обложки
  const { brand, model, year } = draft.geminiResult.car_json;
  const filenameStub = slugify(brand, model, year);

  await clearDraft(chatId);
  await editMessageText(chatId, messageId, '✅ Готово — фото и текст следующими сообщениями. На сайт эта машина не добавляется.');

  await sendPhotoBuffer(chatId, photoBuffer, `${filenameStub}.jpg`, null);
  await sendMessage(chatId, finalPost);
}

async function handleList(chatId, messageId) {
  let cars;
  try {
    cars = await getCurrentCarsJson();
  } catch (err) {
    const text = `Не смог прочитать список машин: ${escapeHtml(err.message)}`;
    if (messageId) await editMessageText(chatId, messageId, text);
    else await sendMessage(chatId, text);
    return;
  }

  if (!cars.length) {
    const text = 'На сайте пока нет машин.';
    if (messageId) await editMessageText(chatId, messageId, text);
    else await sendMessage(chatId, text);
    return;
  }

  const lines = cars.map((c, i) => `${i + 1}. ${escapeHtml(c.brand)} ${escapeHtml(c.model)} (${c.year}) — ${formatPriceRu(c.price)}`);
  const buttons = cars.map((c) => [{ text: `🗑 ${c.brand} ${c.model} (${c.year})`, callback_data: `del:${c.id}` }]);
  const text = `На сайте сейчас ${cars.length} машин${cars.length === 1 ? 'а' : ''}:\n\n${lines.join('\n')}\n\nЖми на машину, чтобы удалить.`;

  if (messageId) await editMessageText(chatId, messageId, text, { reply_markup: inlineKeyboard(buttons) });
  else await sendMessage(chatId, text, { reply_markup: inlineKeyboard(buttons) });
}

async function handleDeleteRequest(chatId, messageId, carId) {
  const cars = await getCurrentCarsJson();
  const car = cars.find((c) => c.id === carId);
  if (!car) {
    await editMessageText(chatId, messageId, 'Эта машина уже не найдена на сайте — возможно, уже удалена.');
    return;
  }
  await editMessageText(
    chatId, messageId,
    `Удалить <b>${escapeHtml(car.brand)} ${escapeHtml(car.model)} (${car.year})</b> — ${formatPriceRu(car.price)}?\n\nЭто действие необратимо: фото тоже удалится из репозитория.`,
    {
      reply_markup: inlineKeyboard([
        [{ text: '🗑 Да, удалить', callback_data: `delconfirm:${carId}` }],
        [{ text: '‹ Назад к списку', callback_data: 'list' }],
      ]),
    },
  );
}

async function handleDeleteConfirm(chatId, messageId, carId) {
  await editMessageText(chatId, messageId, '⏳ Удаляю...');
  try {
    const sha = await deleteCarFromRepo(carId);
    await editMessageText(
      chatId, messageId,
      `✅ Удалено с сайта.\nКоммит: <code>${sha.slice(0, 7)}</code>\nСайт обновится примерно через минуту.`,
      { reply_markup: inlineKeyboard([[{ text: '📋 К списку', callback_data: 'list' }]]) },
    );
  } catch (err) {
    await editMessageText(chatId, messageId, `Ошибка при удалении: ${escapeHtml(err.message)}`);
  }
}

async function handleCallbackQuery(cq) {
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const data = cq.data || '';
  const [action, payload] = data.split(':');

  await answerCallbackQuery(cq.id);

  if (action === 'gen') await handleGenerate(chatId, messageId);
  else if (action === 'cat') await handleCatalogChoice(chatId, messageId, payload === 'yes');
  else if (action === 'pub') await handlePublish(chatId, messageId, payload);
  else if (action === 'pubdirect') await handlePublishDirect(chatId, messageId);
  else if (action === 'new') {
    await clearDraft(chatId);
    await editMessageText(chatId, messageId, 'Черновик сброшен. Пришли фото новой машины.');
  } else if (action === 'cancel') {
    await clearDraft(chatId);
    await editMessageText(chatId, messageId, 'Отменено.');
  } else if (action === 'list') await handleList(chatId, messageId);
  else if (action === 'del') await handleDeleteRequest(chatId, messageId, payload);
  else if (action === 'delconfirm') await handleDeleteConfirm(chatId, messageId, payload);
}

// ============================================================================
// 7. ТОЧКА ВХОДА
// ============================================================================

exports.handler = async (event) => {
  connectLambda(event);

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Секретный токен вебхука (ставится через setWebhook secret_token) —
  // защита от поддельных POST-запросов на этот URL извне
  const secretHeader = event.headers['x-telegram-bot-api-secret-token'];
  if (TELEGRAM_WEBHOOK_SECRET && secretHeader !== TELEGRAM_WEBHOOK_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let update;
  try {
    update = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Bad Request' };
  }

  const senderChatId = String(
    update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? '',
  );
  if (!senderChatId || !ADMIN_IDS.includes(senderChatId)) {
    // Молча игнорируем чужих — не подтверждаем и не опровергаем существование бота
    return { statusCode: 200, body: 'ok' };
  }

  try {
    // Дедупликация ретраев — единственное оставшееся использование Netlify
    // Blobs в этом файле (черновик переехал на GitHub, см. раздел 2 выше).
    // Здесь консистентность не критична: худший случай — редкий genuine
    // ретрай Telegram обработается дважды, что не теряет данные, просто
    // может прислать повторное сообщение.
    const store = getStore({ name: BLOB_STORE_NAME });
    const seenKey = `seen:${update.update_id}`;
    const alreadySeen = await store.get(seenKey, { type: 'text' }).catch(() => null);
    if (alreadySeen) {
      return { statusCode: 200, body: 'ok' };
    }
    await store.set(seenKey, '1');

    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallbackQuery(update.callback_query);
  } catch (err) {
    console.error('Необработанная ошибка:', err);
    await sendMessage(senderChatId, `Что-то сломалось: ${escapeHtml(err.message)}`).catch(() => {});
  }

  return { statusCode: 200, body: 'ok' };
};

// Экспорт для тестов (см. test-bot-logic.js) — сам Netlify это поле игнорирует
exports.__testing = {
  escapeHtml, slugify, uniqueId, managerCounts, managerName, validateCarJson,
  catalogCtaBlock, directContactBlock, assembleFinalPost, formatPriceRu, CAR_JSON_SCHEMA,
  getServiceAccountCredentials, tg,
};
