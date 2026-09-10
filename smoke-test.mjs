// smoke-test.mjs — быстрая проверка RiskControl перед каждым обновлением.
//
// Что делает: открывает сайт в headless-браузере, проверяет ключевые сценарии
// (расчёт, тема, язык, автодополнение монет, вёрстку) и падает с понятным
// сообщением, если что-то из этого сломалось. Именно эти проверки я гонял
// вручную перед каждой отправкой файла — теперь это можно делать одной командой.
//
// Запросы к api.bybit.com подменяются заранее заготовленными ответами (см.
// mockBybitApi ниже) — тест не зависит ни от реальной сети, ни от того, блокирует
// ли Bybit конкретный дата-центр (CI-раннеры GitHub Actions и открытие файла
// напрямую с диска через file:// получают от Bybit CORS-отказ, потому что
// запрос идёт с origin "null" — это не баг сайта, а особенность локального
// запуска; на реальном https-адресе сайта такого не происходит).
//
// Установка (один раз):
//   npm install playwright
//   npx playwright install chromium
//
// Запуск:
//   node smoke-test.mjs https://joyful-crostata-027e18.netlify.app
//   node smoke-test.mjs ./index.html          (можно и по локальному файлу)
//
// Если аргумент не указан — по умолчанию проверяет локальный ./index.html

import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const targetArg = process.argv[2] || './index.html';
const target = /^https?:\/\//.test(targetArg)
  ? targetArg
  : pathToFileURL(path.resolve(targetArg)).href;

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures++;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ' — ' + detail : ''}`);
  }
}

// Подменяет 4 эндпоинта Bybit, которые использует калькулятор, на
// фиктивные, но правдоподобные ответы — чтобы тест не зависел от реальной
// биржи (сеть/гео-блок/CORS с file://) и всегда давал одинаковый результат.
async function mockBybitApi(page) {
  await page.route('https://api.bybit.com/v5/market/**', async (route) => {
    const url = route.request().url();
    const json = (body) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/tickers')) {
      return json({
        retCode: 0, retMsg: 'OK',
        result: { category: 'linear', list: [{
          symbol: 'BTCUSDT', lastPrice: '65000', price24hPcnt: '0.015',
          fundingRate: '0.0001', openInterest: '50000'
        }] },
        time: Date.now()
      });
    }
    if (url.includes('/instruments-info')) {
      return json({
        retCode: 0, retMsg: 'OK',
        result: { category: 'linear', list: [{
          symbol: 'BTCUSDT',
          lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001' }
        }] },
        time: Date.now()
      });
    }
    if (url.includes('/risk-limit')) {
      return json({
        retCode: 0, retMsg: 'OK',
        result: { category: 'linear', list: [
          { riskLimitValue: '2000000', maintainMargin: '0.005' },
          { riskLimitValue: '5000000', maintainMargin: '0.01' }
        ] },
        time: Date.now()
      });
    }
    if (url.includes('/kline')) {
      const now = Date.now();
      const rows = [];
      let price = 65000;
      for (let i = 0; i < 60; i++) {
        const t = now - i * 60000;
        const open = price, close = price + (Math.random() - 0.5) * 100;
        const high = Math.max(open, close) + 20, low = Math.min(open, close) - 20;
        rows.push([String(t), String(open), String(high), String(low), String(close), '10', '650000']);
        price = close;
      }
      return json({
        retCode: 0, retMsg: 'OK',
        result: { category: 'linear', symbol: 'BTCUSDT', list: rows },
        time: now
      });
    }
    return route.continue();
  });
}

async function main() {
  console.log(`\nRiskControl smoke-test → ${target}\n`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
  await mockBybitApi(page);

  const consoleErrors = [];
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/net::ERR_|Failed to fetch/.test(m.text())) {
      consoleErrors.push(m.text());
    }
  });

  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // 1) страница загрузилась, без JS-исключений
  check('страница загружается без JS-ошибок', pageErrors.length === 0, pageErrors.join('; '));
  check('нет ошибок в консоли (кроме сетевых)', consoleErrors.length === 0, consoleErrors.join('; '));

  // 2) нет горизонтального переполнения (та самая пропавшая тема)
  const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
  check('нет горизонтального переполнения страницы', overflow === 0, `overflow=${overflow}px`);

  // 3) переключатель темы виден и работает
  const themeBtn = await page.$('#themeToggle');
  const box1 = themeBtn ? await themeBtn.boundingBox() : null;
  const vpWidth = page.viewportSize().width;
  check(
    'переключатель темы виден и помещается на странице',
    !!box1 && box1.x + box1.width <= vpWidth,
    box1 ? `x=${box1.x}, width=${box1.width}, viewport=${vpWidth}` : 'элемент не найден'
  );
  await themeBtn.click();
  await page.waitForTimeout(150);
  const themeAttr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('клик по переключателю темы меняет тему', themeAttr === 'dark', `data-theme=${themeAttr}`);

  // 4) переключение языка + RTL для иврита
  await page.selectOption('#langSelect', 'en');
  await page.waitForTimeout(150);
  const h1en = await page.$eval('h1', (el) => el.textContent);
  check('переключение на английский меняет текст', /Risk/i.test(h1en), h1en);

  await page.selectOption('#langSelect', 'he');
  await page.waitForTimeout(150);
  const dir = await page.evaluate(() => document.documentElement.getAttribute('dir'));
  check('иврит переключает страницу в RTL', dir === 'rtl', `dir=${dir}`);
  await page.selectOption('#langSelect', 'ru');
  await page.waitForTimeout(150);

  // 5) быстрый выбор монеты
  await page.click('button[data-coin="ETHUSDT"]');
  await page.waitForTimeout(150);
  const symbolVal = await page.$eval('#symbol', (el) => el.value);
  check('быстрый выбор монеты подставляет символ', symbolVal === 'ETHUSDT', `symbol=${symbolVal}`);

  // 6) автодополнение при вводе
  await page.fill('#symbol', '');
  await page.type('#symbol', 'sol', { delay: 30 });
  await page.waitForTimeout(200);
  const suggestions = await page.$$eval('#symbolSuggest .sug-item', (els) => els.map((e) => e.textContent));
  check('автодополнение показывает варианты', suggestions.some((s) => /Solana/i.test(s)), suggestions.join(', '));
  await page.keyboard.press('Escape');

  // 7) расчёт объёма позиции — известные вход/стоп/риск дают ожидаемый размер
  await page.fill('#symbol', 'BTCUSDT');
  await page.click('#btnApplySymbol');
  await page.waitForTimeout(800); // дать время подмененным данным биржи примениться (qtyStep для округления)
  await page.click('#entryManualBtn');
  await page.fill('#entry', '65000');
  await page.fill('#stop', '64000');
  await page.fill('#risk', '25');
  await page.fill('#leverage', '10');
  await page.waitForTimeout(200);
  const oSize = await page.$eval('#oSize', (el) => el.textContent);
  const sizeNum = parseFloat(oSize);
  // без комиссии было бы 25/1000=0.025; с тейкерской комиссией чуть меньше
  check(
    'расчёт объёма позиции в разумных пределах (0.02–0.025 BTC)',
    sizeNum > 0.02 && sizeNum <= 0.025,
    `oSize=${oSize}`
  );

  await browser.close();

  console.log('');
  if (failures === 0) {
    console.log('\x1b[32mВсё ок — можно обновлять сайт.\x1b[0m\n');
    process.exit(0);
  } else {
    console.log(`\x1b[31m${failures} проверок не прошли — смотри выше, что именно сломалось.\x1b[0m\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Тест упал с ошибкой:', e);
  process.exit(1);
});
