// api/analyze.js
//
// Vercel Serverless Function для кнопки "Проверить с ИИ" на RiskControl.
// Делает то же самое, что раньше делала netlify/functions/analyze.js, просто
// в формате, который понимает Vercel: обычная функция (req, res) в папке /api.
//
// Ходит через OpenRouter (openrouter.ai), а не напрямую в Anthropic — так можно
// платить криптой/картой через OpenRouter. Ключ лежит в переменной окружения
// (OPENROUTER_API_KEY, задаётся в Vercel: Project Settings -> Environment
// Variables) — сайт и браузер пользователя этот ключ никогда не видят.
// Запросы принимаются только со своего сайта и не чаще лимита (см. ниже) — чтобы
// посторонние не могли тратить баланс OpenRouter.
//
// Сайт присылает сводку рынка (marketSummary): обычный размах движения по модели волатильности,
// предупреждения о перегреве, технические факторы и ближайшие уровни. ИИ НЕ прогнозирует направление:
// проверка на истории показала, что технические сигналы угадывают его на уровне монетки. Модель
// объясняет картину и риски простым языком и ищет свежие новости через веб-поиск OpenRouter (":online").

// ":online" = встроенный веб-поиск OpenRouter (для свежих новостей). Для оценки риска
// сделки новости не нужны — там используем модель без поиска: дешевле и быстрее.
const MODEL = 'anthropic/claude-haiku-4.5:online';
const MODEL_NO_SEARCH = 'anthropic/claude-haiku-4.5';
const MAX_FIELD_LEN = 200;
const MAX_SUMMARY_LEN = 3000;

// ---- защита от чужого использования (каждый запрос стоит денег с баланса OpenRouter) ----
// 1) Запросы из браузера принимаем только со своего же сайта (Origin == домен сайта).
// 2) Простое ограничение частоты: не больше RATE_MAX запросов с одного IP за RATE_WINDOW_MS
//    и не больше GLOBAL_MAX запросов в час на один экземпляр функции.
// Это не абсолютная защита (у Vercel может работать несколько экземпляров функции),
// поэтому дополнительно стоит поставить лимит расходов на сам ключ в OpenRouter.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 10;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_MAX = 300;
const hitsByIp = new Map();
let globalHits = [];

function clientIp(req) {
  const xff = String((req.headers && req.headers['x-forwarded-for']) || '');
  return (xff.split(',')[0] || '').trim() || String((req.headers && req.headers['x-real-ip']) || '') || 'unknown';
}
function rateLimited(ip, now) {
  globalHits = globalHits.filter((ts) => now - ts < GLOBAL_WINDOW_MS);
  if (globalHits.length >= GLOBAL_MAX) return true;
  const list = (hitsByIp.get(ip) || []).filter((ts) => now - ts < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) { hitsByIp.set(ip, list); return true; }
  list.push(now);
  hitsByIp.set(ip, list);
  globalHits.push(now);
  if (hitsByIp.size > 5000) hitsByIp.clear(); // не даём карте разрастись
  return false;
}
function sameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true; // не браузер (или очень старый) — таких ограничивает только лимит частоты
  let originHost;
  try { originHost = new URL(origin).host; } catch (e) { return false; }
  const host = String((req.headers['x-forwarded-host'] || req.headers.host || '')).split(',')[0].trim();
  return !!host && originHost === host;
}

const LANG_NAMES = {
  ru: 'русском',
  en: 'English',
  de: 'Deutsch',
  uk: 'українською',
  he: 'עברית',
};

function clip(value, fallback, max) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.trim().slice(0, max || MAX_FIELD_LEN);
}

// Ответ показывается как обычный текст — убираем markdown и ссылки-цитаты веб-поиска.
function cleanText(text) {
  return String(text || '')
    .replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g, '$1')   // [текст](url) → текст
    .replace(/\(\s*(?:https?:\/\/|www\.)[^)]*\)/g, '')       // (https://...) → ''
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/[ \t]+([.,;!?])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (!sameOrigin(req)) {
    res.status(403).json({ error: 'forbidden_origin' });
    return;
  }
  if (rateLimited(clientIp(req), Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // Ключ ещё не добавлен в Vercel — честно сообщаем об этом, а не падаем непонятно.
    res.status(503).json({ error: 'api_key_not_configured' });
    return;
  }

  // Vercel обычно уже сам разбирает JSON-тело в req.body, но на всякий случай
  // подстрахуемся, если вдруг придёт строкой.
  let payload = req.body;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload || '{}');
    } catch (e) {
      res.status(400).json({ error: 'bad_json' });
      return;
    }
  }
  if (!payload || typeof payload !== 'object') payload = {};

  const symbol = clip(payload.symbol, 'BTCUSDT');
  const timeframe = clip(payload.timeframe, '1ч');
  const price = clip(payload.price, '—');
  const change24h = clip(payload.change24h, '—');
  const trendText = clip(payload.trendText, '—');
  const fundingText = clip(payload.fundingText, '—');
  const rsiText = clip(payload.rsiText, '—');
  const fibText = clip(payload.fibText, '—');
  const patternText = clip(payload.patternText, '—');
  // новая версия сайта присылает всю сводку одним блоком; старые поля — запасной вариант
  const marketSummary = clip(payload.marketSummary, '', MAX_SUMMARY_LEN) || [
    `Цена: ${price}, изменение за 24ч: ${change24h}`,
    `Тренд (EMA20/EMA50): ${trendText}`,
    `RSI(14): ${rsiText}`,
    `Funding rate: ${fundingText}`,
    `Fibonacci/pivot уровни: ${fibText}`,
    `Паттерн свечей: ${patternText}`,
  ].join('\n');
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
  const noise = clip(payload.noise, '', 400);

  let userPrompt;

  if (focus === 'risk') {
    userPrompt = `Оцени риск-менеджмент этой сделки по ${symbol} (бессрочный фьючерс на Bybit), не рынок в целом.

Параметры сделки, уже посчитанные калькулятором:
- Направление: ${direction}
- Риск на сделку: ${riskAmount}
- Плечо: ${leverage}
- Цена входа: ${entryPrice}, цена стопа: ${stopPrice}
- Объём позиции: ${positionSize}
- Оценка цены ликвидации: ${liqPrice}${noise ? `
- Шум рынка по истории этой монеты: ${noise}` : ''}

Ответ на ${responseLang} языке, максимально коротко, СТРОГО в этом формате, без вступлений и заголовков:
Строка 1 — только одно из трёх слов, максимально конкретно: «ОК» (риск и плечо адекватны), «РИСКОВАННО» (плечо слишком агрессивно относительно стопа) или «СЛИШКОМ ОСТОРОЖНО» (запас чрезмерный, есть смысл пересчитать).
Строка 2 — ровно одно предложение почему именно этот вердикт (запас между стопом и ликвидацией, размер плеча, и — если даны данные о шуме — не выбьет ли стоп обычным движением цены).
Строка 3 — короткий дисклеймер (до 12 слов), что решение и риск на пользователе.
Не используй поиск и новости для этой оценки — это чисто вопрос цифр риск-менеджмента, отвечай сразу.`;
  } else if (focus === 'checklist') {
    userPrompt = `Ты — опытный риск-менеджер по крипто-фьючерсам. Объясни простым языком, что может пойти не так в сделке по ${symbol} (бессрочный фьючерс Bybit, таймфрейм ${timeframe}) — отдельно для лонга и для шорта.

Данные, которые сайт только что посчитал по Bybit:
${marketSummary}

Через поиск проверь события за последние 24–48 часов по этой монете и рынку (макро, ФРС, ETF, листинги/делистинги, взломы, разлоки токенов); упоминай только конкретные свежие события, реально способные двинуть цену.

Правила:
- НЕ прогнозируй направление, НЕ пиши «бычий/медвежий» как вывод, НЕ давай вероятностей роста/падения и советов купить или продать. Проверка на истории показала, что технические сигналы угадывают направление на уровне монетки.
- Опирайся на цифры из данных: обычный ход цены, предупреждения о перегреве, уровни. Уровни не выдумывай.
- Доля лонгов 45–70% на Bybit — норма, а не перекос.

Ответ на ${responseLang} языке, обычным текстом без markdown, звёздочек, списков и ссылок, СТРОГО 4 строки, каждая не длиннее двух коротких предложений, без пустых строк; названия строк переведи на язык ответа:
Для лонга: главный риск сейчас с цифрами (ближайшее сопротивление, перегрев, новость).
Для шорта: главный риск сейчас с цифрами (ближайшая поддержка, перекос толпы, новость).
Стопы: какой стоп скорее всего выбьет обычный шум, исходя из обычного хода цены за 4 и 24 часа.
Последняя строка — дисклеймер до 10 слов: не финансовый совет, решение и риск за пользователем.`;
  } else {
    userPrompt = `Ты — опытный аналитик крипто-фьючерсов. Объясни простым языком, что сейчас происходит с ${symbol} (бессрочный фьючерс Bybit, таймфрейм ${timeframe}), чтобы трейдер понимал контекст и риски.

Данные, которые сайт только что посчитал по Bybit:
${marketSummary}

Через поиск найди важные события за последние 24–48 часов по этой монете и по крипторынку в целом (макро и ФРС, ETF, листинги и делистинги, взломы, разлоки токенов, резкие движения BTC).

Правила:
- НЕ прогнозируй направление: не пиши вывод «бычий/медвежий/нейтральный», не давай «уверенность NN%», вероятностей роста или падения и советов купить или продать. Проверка на истории показала, что технические сигналы угадывают направление на уровне монетки — описывай, а не предсказывай.
- Опирайся только на цифры из данных и найденные новости, уровни не выдумывай.
- Доля лонгов 45–70% на Bybit — обычное состояние, а не перекос толпы.
- Новости — только конкретные события, опубликованные за последние 48 часов (не старые и не чужие прогнозы/аналитика); если таких нет — строку «Новости» не пиши.
- Пиши коротко: каждая строка — не больше двух коротких предложений, без пустых строк.

Ответ на ${responseLang} языке, обычным текстом без markdown, звёздочек, списков и ссылок, 4–5 строк; названия строк переведи на язык ответа:
Картина: что происходит сейчас — тренд на этом и старшем таймфрейме, импульс, объём (описание, не прогноз).
Риск: насколько рынок сейчас шумный и перегрет — с цифрами обычного хода и предупреждениями из данных.
Уровни: ближайшие поддержка и сопротивление из данных.
Новости: одно предложение о самой важной свежей новости — только если такая есть; иначе пропусти строку.
Последняя строка — дисклеймер до 10 слов: не финансовый совет, решение и риск за пользователем.`;
  }

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`,
        // Рекомендовано OpenRouter — помогает им идентифицировать источник запроса,
        // на функциональность сайта не влияет, точный домен не важен.
        'http-referer': 'https://www.riskctrl.app',
        'x-title': 'RiskControl',
      },
      body: JSON.stringify({
        model: focus === 'risk' ? MODEL_NO_SEARCH : MODEL,
        max_tokens: focus === 'risk' ? 220 : 700,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('OpenRouter API error:', resp.status, JSON.stringify(data));
      // ошибки на стороне OpenRouter (нет баланса, их лимиты и т.п.) отдаём как 502,
      // чтобы сайт не путал их с нашим собственным ограничением частоты (429)
      res.status(502).json({ error: 'api_error', upstream: resp.status });
      return;
    }

    const text = cleanText((data.choices || [])[0]?.message?.content || '');

    if (!text) {
      res.status(502).json({ error: 'empty_response' });
      return;
    }

    res.status(200).json({ text });
  } catch (err) {
    console.error('AI analyze function failed:', err);
    res.status(500).json({ error: 'fetch_failed' });
  }
};
