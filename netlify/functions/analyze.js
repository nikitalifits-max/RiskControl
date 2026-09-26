// netlify/functions/analyze.js
//
// Серверная функция для кнопки "Проверить с ИИ" на RiskControl.
// Ходит через OpenRouter (openrouter.ai) вместо прямого API Anthropic — так
// можно оплатить доступ криптой/картой через OpenRouter, а не только через
// Anthropic Console. Ключ лежит в переменной окружения (OPENROUTER_API_KEY,
// задаётся в Netlify: Site configuration -> Environment variables) — сайт и
// браузер пользователя этот ключ никогда не видят.
//
// Принимает POST с текущими рыночными данными (цена, тренд, RSI, funding,
// уровни, паттерн), просит модель поискать свежие новости по монете через
// встроенный в OpenRouter веб-поиск (суффикс ":online" у модели) и написать
// короткий анализ на языке интерфейса.
//
// Явный дисклеймер в самом промпте — сайт уже честно говорит, что это не
// сигнал к сделке (см. verdictDisclaimer в index.html), и ответ ИИ должен
// быть в том же духе, а не выглядеть как обещание результата.

// ":online" на конце модели — встроенный веб-поиск OpenRouter (см. их
// документацию по плагину "web"), без него не будет свежих новостей.
const MODEL = 'anthropic/claude-haiku-4.5:online';
const MAX_FIELD_LEN = 200;

const LANG_NAMES = {
  ru: 'русском',
  en: 'English',
  de: 'Deutsch',
  uk: 'українською',
  he: 'עברית',
};

function clip(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.trim().slice(0, MAX_FIELD_LEN);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // Ключ ещё не добавлен в Netlify — честно сообщаем об этом, а не падаем непонятно.
    return { statusCode: 503, body: JSON.stringify({ error: 'api_key_not_configured' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'bad_json' }) };
  }

  const symbol = clip(payload.symbol, 'BTCUSDT');
  const timeframe = clip(payload.timeframe, '1ч');
  const price = clip(payload.price, '—');
  const change24h = clip(payload.change24h, '—');
  const trendText = clip(payload.trendText, '—');
  const fundingText = clip(payload.fundingText, '—');
  const rsiText = clip(payload.rsiText, '—');
  const fibText = clip(payload.fibText, '—');
  const patternText = clip(payload.patternText, '—');
  const responseLang = LANG_NAMES[payload.lang] || LANG_NAMES.ru;
  const focus = clip(payload.focus, 'trade');

  // "risk" — отдельная карточка калькулятора: свои поля (вход/стоп/плечо/объём/ликвидация),
  // отдельный, более узкий промпт про сам риск-менеджмент, а не про рынок в целом.
  const direction = clip(payload.direction, '—');
  const riskAmount = clip(payload.riskAmount, '—');
  const leverage = clip(payload.leverage, '—');
  const entryPrice = clip(payload.entryPrice, '—');
  const stopPrice = clip(payload.stopPrice, '—');
  const positionSize = clip(payload.positionSize, '—');
  const liqPrice = clip(payload.liqPrice, '—');

  let userPrompt;

  if (focus === 'risk') {
    userPrompt = `Оцени риск-менеджмент этой сделки по ${symbol} (бессрочный фьючерс на Bybit), не рынок в целом.

Параметры сделки, уже посчитанные калькулятором:
- Направление: ${direction}
- Риск на сделку: ${riskAmount}
- Плечо: ${leverage}
- Цена входа: ${entryPrice}, цена стопа: ${stopPrice}
- Объём позиции: ${positionSize}
- Оценка цены ликвидации: ${liqPrice}

Коротко (3-5 предложений) на
