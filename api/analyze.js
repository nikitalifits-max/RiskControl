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
// Сайт присылает полную сводку рынка (marketSummary): 11 факторов с цифрами, итоговую
// оценку алгоритма и ближайшие уровни. Модель ищет свежие новости через встроенный в
// OpenRouter веб-поиск (суффикс ":online") и даёт конкретный ответ: вердикт с уверенностью,
// причины с цифрами, уровни и точку, где картина ломается — а не дежурное "смешанный".

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
    .replace(/\n{3,}/g, '\n\n')
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

Ответ на ${responseLang} языке, максимально коротко, СТРОГО в этом формате, без вступлений и заголовков:
Строка 1 — только одно из трёх слов, максимально конкретно: «ОК» (риск и плечо адекватны), «РИСКОВАННО» (плечо слишком агрессивно относительно стопа) или «СЛИШКОМ ОСТОРОЖНО» (запас чрезмерный, есть смысл пересчитать).
Строка 2 — ровно одно предложение почему именно этот вердикт (запас между стопом и ликвидацией, размер плеча).
Строка 3 — короткий дисклеймер (до 12 слов), что решение и риск на пользователе.
Не используй поиск и новости для этой оценки — это чисто вопрос цифр риск-менеджмента, отвечай сразу.`;
  } else if (focus === 'checklist') {
    userPrompt = `Ты — опытный аналитик крипто-фьючерсов. Разложи по полочкам аргументы за рост и за снижение по ${symbol} (бессрочный фьючерс Bybit, таймфрейм ${timeframe}).

Данные, которые сайт только что посчитал по Bybit:
${marketSummary}

Через поиск проверь новости и события за последние 24–48 часов по этой монете и крипторынку в целом; упоминай их, только если они реально влияют на цену.

Правила:
- Старший таймфрейм и тренд важнее осцилляторов; funding и доля лонгов — контр-сигналы; для альткоинов учитывай фон BTC.
- Используй только цифры из данных выше и из найденных новостей, уровни не выдумывай.
- Итог должен называть более вероятный сценарий. «Равновесие» — только если оценка сайта в пределах ±15 и нет сильной новости.

Ответ на ${responseLang} языке, обычным текстом без markdown, звёздочек, списков и ссылок, СТРОГО 5 строк; названия строк переведи на язык ответа:
Итог: какой сценарий вероятнее и насколько (уверенность NN%, честно, от 50 до 85%).
За рост: 1–2 самых сильных аргумента с цифрами.
За снижение: 1–2 самых сильных аргумента с цифрами.
Что изменит картину: конкретный уровень цены (закрытие свечи за ним) или событие.
Последняя строка — дисклеймер до 10 слов: не финансовый совет, решение и риск за пользователем.`;
  } else {
    userPrompt = `Ты — опытный аналитик крипто-фьючерсов. Дай конкретный и полезный разбор ${symbol} (бессрочный фьючерс Bybit) на таймфрейме ${timeframe}.

Данные, которые сайт только что посчитал по Bybit:
${marketSummary}

Через поиск найди важные новости и события за последние 24–48 часов по этой монете и по крипторынку в целом (макро и ФРС, ETF, листинги и делистинги, взломы, разлоки токенов, резкие движения BTC), которые реально могут повлиять на цену.

Правила вердикта:
- Взвесь всё сам: старший таймфрейм и тренд важнее осцилляторов; перекос толпы (funding, доля лонгов) — контр-сигнал; для альткоинов учитывай фон BTC; сильная свежая новость может перевесить технику.
- Выбери «БЫЧИЙ» или «МЕДВЕЖИЙ», если перевес в одну сторону хотя бы умеренный (уверенность от 55%). «НЕЙТРАЛЬНЫЙ» — только если факторы действительно уравновешены (оценка сайта в пределах ±15) и нет сильной новости. Не прячься за нейтральный вердикт.
- Уверенность — честная, от 50 до 85%, выше 85% не ставь.
- Используй только цифры из данных выше и из найденных новостей, уровни не выдумывай.

Ответ на ${responseLang} языке, обычным текстом без markdown, звёздочек, списков и ссылок, 4–5 строк; названия строк и слово вердикта переведи на язык ответа:
Вердикт: БЫЧИЙ, МЕДВЕЖИЙ или НЕЙТРАЛЬНЫЙ · уверенность NN%
Почему: 2–3 самых сильных аргумента с цифрами из данных, одним-двумя предложениями.
Уровни: ближайшая поддержка и сопротивление из данных, и при закрытии свечи за каким уровнем этот вердикт перестаёт работать.
Новости: одно предложение о самой важной свежей новости и её влиянии — только если такая есть; иначе пропусти эту строку целиком.
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
        max_tokens: focus === 'risk' ? 220 : 450,
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
