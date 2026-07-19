/**
 * build-cards.js — генерирует статичную HTML-разметку карточек и вставляет
 * её в index.html, вместе с самими данными.
 *
 * Источник данных — data/cars.json. Это тот же файл, который читает и
 * пополняет Telegram-бот (netlify/functions/bot.js) при публикации или
 * удалении машины. Раньше данные были хардкожены прямо в app.js и
 * извлекались отсюда хрупким regex'ом — теперь один файл данных,
 * используемый и сборкой, и ботом, без риска рассинхронизации.
 *
 * Что делает при запуске:
 *  1. Читает data/cars.json.
 *  2. Рендерит HTML карточек той же функцией, что использует app.js в
 *     браузере (createCarCard), и вставляет готовый HTML в #carsGrid —
 *     чтобы первый кадр страницы сразу показывал карточки нужного размера,
 *     а не пустую сетку, которая через мгновение "прыгает" (источник CLS).
 *  3. Вставляет сами данные в index.html как
 *     <script type="application/json" id="cars-data"> — так app.js в
 *     браузере получает CARS без хардкода и без сетевого запроса.
 *
 * app.js при загрузке страницы продолжает вызывать renderCars() как обычно
 * — просто перерисовывает те же карточки поверх уже вставленных сборкой,
 * без изменения размера (значит, без повторного сдвига вёрстки).
 *
 * Запуск: npm run build:cards (или node build-cards.js)
 * ВАЖНО: запускать после любого изменения data/cars.json.
 */

const fs = require('fs');
const path = require('path');

const carsJsonPath = path.join(__dirname, 'data', 'cars.json');
const appJsPath = path.join(__dirname, 'app.js');
const indexHtmlPath = path.join(__dirname, 'index.html');

const CARS = JSON.parse(fs.readFileSync(carsJsonPath, 'utf8'));

// --- Достаём чистые, не зависящие от document/window куски app.js: иконки,
// форматтеры и саму функцию рендера карточки — они по-прежнему живут в
// app.js как логика представления, только данные оттуда уехали.
const appJs = fs.readFileSync(appJsPath, 'utf8');

function extractBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    throw new Error(`Не нашёл блок между "${startMarker}" и "${endMarker}" в app.js`);
  }
  return source.slice(start, end);
}

const iconsBlock = extractBlock(appJs, 'const ICON_BOLT', '\n// ====');
const formattersBlock = extractBlock(appJs, 'function formatPrice', '\nfunction getManagerLink')
  + '\nfunction getManagerLink(u){return `https://t.me/${u}`;}\n';
const cardFnBlock = extractBlock(appJs, 'function createCarCard', '\nfunction renderCars');

const sandboxSource = `${iconsBlock}\n${formattersBlock}\n${cardFnBlock}\nmodule.exports = { createCarCard };`;
const sandboxPath = path.join(__dirname, '.build-cards-sandbox.js');
fs.writeFileSync(sandboxPath, sandboxSource, 'utf8');

let createCarCard;
try {
  ({ createCarCard } = require(sandboxPath));
} finally {
  fs.unlinkSync(sandboxPath);
}

const cardsHTML = CARS.map(createCarCard).join('');

let html = fs.readFileSync(indexHtmlPath, 'utf8');

// 1. Карточки в #carsGrid
const gridRegex = /(<div id="carsGrid"[^>]*>)([\s\S]*?)(<\/div>\s*<\/main>)/;
if (!gridRegex.test(html)) {
  throw new Error('Не нашёл #carsGrid в index.html — проверь разметку');
}
html = html.replace(gridRegex, `$1${cardsHTML}$3`);

// 2. Данные для app.js — <script type="application/json" id="cars-data">.
// Если тега ещё нет (первый запуск после миграции) — создаём его перед app.js.
const dataScriptRegex = /<script type="application\/json" id="cars-data">[\s\S]*?<\/script>/;
const dataScriptTag = `<script type="application/json" id="cars-data">${JSON.stringify(CARS)}</script>`;
if (dataScriptRegex.test(html)) {
  html = html.replace(dataScriptRegex, dataScriptTag);
} else {
  const appJsScriptTag = '<script src="app.js" defer></script>';
  if (!html.includes(appJsScriptTag)) {
    throw new Error('Не нашёл <script src="app.js" defer></script> в index.html, чтобы вставить перед ним данные');
  }
  html = html.replace(appJsScriptTag, `${dataScriptTag}\n  ${appJsScriptTag}`);
}

fs.writeFileSync(indexHtmlPath, html, 'utf8');
console.log(`Готово: ${CARS.length} карточек предзаписаны в index.html, данные встроены в #cars-data`);
