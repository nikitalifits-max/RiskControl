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

Ответ на ${responseLang} языке, максимально коротко, СТРОГО в этом формате, без вступлений и заголовков:
Строка 1 — только одно из трёх слов, максимально конкретно: «ОК» (риск и плечо адекватны), «РИСКОВАННО» (плечо слишком агрессивно относительно стопа) или «СЛИШКОМ ОСТОРОЖНО» (запас чрезмерный, есть смысл пересчитать).
Строка 2 — ровно одно предложение почему именно этот вердикт (запас между стопом и ликвидацией, размер плеча).
Строка 3 — короткий дисклеймер (до 12 слов), что решение и риск на пользователе.
Не используй поиск и новости для этой оценки — это чисто вопрос цифр риск-менеджмента, отвечай сразу.`;
  } else if (focus === 'checklist') {
    userPrompt = `Разбери технический чек-лист по монете ${symbol} (бессрочный фьючерс на Bybit, таймфрейм ${timeframe}), который уже автоматически посчитан на сайте:
- Тренд (EMA20/EMA50): ${trendText}
- RSI(14): ${rsiText}
- Funding rate: ${fundingText}
- Fibonacci/pivot уровни: ${fibText}
- Паттерн свечей: ${patternText}

Через поиск кратко учти самые важные свежие новости по этой монете и крипторынку (за последние 24-48 часов), только если они реально важны — иначе пропусти новости совсем и не пиши "новостей нет".

Ответ на ${responseLang} языке, максимально коротко, СТРОГО в этом формате, без вступлений и заголовков:
Строка 1 — только одно слово: «БЫЧИЙ», «МЕДВЕЖИЙ» или «СМЕШАННЫЙ» — самая честная оценка по этим факторам.
Строка 2 — ровно одно предложение: какой из факторов сейчас важнее остальных и почему.
Строка 3 (только если есть по-настоящему важная свежая новость) — ровно одно предложение о ней; иначе пропусти эту строку.
Последняя строка — короткий дисклеймер (до 12 слов), что решение и риск на пользователе.
Никаких дополнительных пояснений, только эти строки.`;
  } else {
    userPrompt = `Проанализируй текущую техническую картину и самые свежие новости по монете ${symbol} (бессрочный фьючерс на Bybit, таймфрейм ${timeframe}).

Технические данные с сайта (уже посчитаны автоматически):
- Цена: ${price}, изменение за 24ч: ${change24h}
- Тренд (EMA20/EMA50): ${trendText}
- RSI(14): ${rsiText}
- Funding rate: ${fundingText}
- Fibonacci/pivot уровни: ${fibText}
- Паттерн свечей: ${patternText}

Через поиск найди самые свежие новости и события по этой монете и по крипторынку в целом (за последние 24-48 часов), которые реально могут повлиять на цену.

Ответ на ${responseLang} языке, максимально коротко, СТРОГО в этом формате, без вступлений и заголовков:
Строка 1 — только одно слово, самая честная и конкретная оценка: «БЫЧИЙ», «МЕДВЕЖИЙ» или «СМЕШАННЫЙ». Не бойся дать чёткую оценку, если технически и по новостям есть явный перевес в одну сторону — не прячься за "смешанный", если это не так.
Строка 2 — ровно одно предложение: главная техническая причина.
Строка 3 (только если есть по-настоящему важная свежая новость) — ровно одно предложение о ней; иначе пропусти эту строку.
Последняя строка — короткий дисклеймер (до 12 слов), что это не сигнал и решение/риск на пользователе.
Никаких дополнительных пояснений, только эти строки.`;
  }

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`,
        // Рекомендовано OpenRouter — помогает им идентифицировать источник запроса,
        // на функциональность сайта не влияет.
        'http-referer': 'https://3457893.netlify.app',
        'x-title': 'RiskControl',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 220,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('OpenRouter API error:', resp.status, JSON.stringify(data));
      return { statusCode: resp.status, body: JSON.stringify({ error: 'api_error' }) };
    }

    const text = ((data.choices || [])[0]?.message?.content || '').trim();

    if (!text) {
      return { statusCode: 502, body: JSON.stringify({ error: 'empty_response' }) };
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    };
  } catch (err) {
    console.error('AI analyze function failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'fetch_failed' }) };
  }
};
