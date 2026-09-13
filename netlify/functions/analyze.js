// netlify/functions/analyze.js
//
// Серверная функция для кнопки "Проверить с ИИ" на RiskControl.
// Держит ключ Anthropic в переменной окружения (ANTHROPIC_API_KEY, задаётся
// в Netlify: Site configuration -> Environment variables) — сайт и браузер
// пользователя этот ключ никогда не видят.
//
// Принимает POST с текущими рыночными данными (цена, тренд, RSI, funding,
// уровни, паттерн), просит Claude поискать свежие новости по монете через
// встроенный web_search и написать короткий анализ на языке интерфейса.
//
// Явный дисклеймер в самом промпте — сайт уже честно говорит, что это не
// сигнал к сделке (см. verdictDisclaimer в index.html), и ответ ИИ должен
// быть в том же духе, а не выглядеть как обещание результата.

const MODEL = 'claude-haiku-4-5-20251001';
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
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

Коротко (3-5 предложений) на ${responseLang} языке оцени: достаточен ли запас между стопом и ликвидацией при этом плече, не слишком ли агрессивно выбрано плечо относительно расстояния до стопа, и есть ли что-то в этих цифрах, что стоит перепроверить перед входом. Если можешь, через поиск кратко учти самые свежие новости по монете, если они могут резко повлиять на волатильность. Обязательно закончи одним предложением, что это не финансовый совет и не гарантия результата, а решение и риск — на пользователе.`;
  } else if (focus === 'checklist') {
    userPrompt = `Разбери подробнее технический чек-лист по монете ${symbol} (бессрочный фьючерс на Bybit, таймфрейм ${timeframe}), который уже автоматически посчитан на сайте:
- Тренд (EMA20/EMA50): ${trendText}
- RSI(14): ${rsiText}
- Funding rate: ${fundingText}
- Fibonacci/pivot уровни: ${fibText}
- Паттерн свечей: ${patternText}

Через поиск найди самые свежие новости по этой монете и крипторынку (за последние 24-48 часов). Напиши на ${responseLang} языке (5-7 предложений): что именно означает эта комбинация факторов, какой из них сейчас важнее остальных и почему, и что нового в новостях может эту картину изменить. Обязательно закончи одним предложением, что это не финансовый совет и не гарантия результата, а решение и риск — на пользователе.`;
  } else {
    userPrompt = `Проанализируй текущую техническую картину и самые свежие новости по монете ${symbol} (бессрочный фьючерс на Bybit, таймфрейм ${timeframe}).

Технические данные с сайта (уже посчитаны автоматически):
- Цена: ${price}, изменение за 24ч: ${change24h}
- Тренд (EMA20/EMA50): ${trendText}
- RSI(14): ${rsiText}
- Funding rate: ${fundingText}
- Fibonacci/pivot уровни: ${fibText}
- Паттерн свечей: ${patternText}

Через поиск найди самые свежие новости и события по этой монете и по крипторынку в целом (за последние 24-48 часов), которые могут повлиять на цену. Напиши короткий анализ (4-6 предложений) на ${responseLang} языке: что происходит технически, что нового в новостях, и как это в сумме выглядит — бычий, медвежий или смешанный расклад. Обязательно закончи одним предложением о том, что это не финансовый совет и не гарантия результата, а решение и риск — на пользователе.`;
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('Anthropic API error:', resp.status, JSON.stringify(data));
      return { statusCode: resp.status, body: JSON.stringify({ error: 'api_error' }) };
    }

    const text = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n')
      .trim();

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
