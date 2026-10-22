// Ежедневный «пинг» базы, чтобы бесплатный проект Supabase не уходил в паузу из-за неактивности.
// Вызывается автоматически раз в день (Vercel Cron, см. "crons" в vercel.json).
// Делает один лёгкий запрос на чтение с публичным ключом: правила RLS не отдают чужих данных,
// но сам запрос проходит через базу и считается активностью проекта.
module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) || !key) {
    res.status(200).json({ ok: false, reason: 'not_configured' });
    return;
  }
  try {
    const r = await fetch(url + '/rest/v1/trades?select=id&limit=1', {
      headers: { apikey: key, Authorization: 'Bearer ' + key }
    });
    res.status(200).json({ ok: r.ok, status: r.status, at: new Date().toISOString() });
  } catch (e) {
    res.status(200).json({ ok: false, reason: 'fetch_failed' });
  }
};
