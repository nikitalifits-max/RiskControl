// Публичные настройки для сайта: адрес проекта Supabase и его ПУБЛИЧНЫЙ ключ (anon / publishable).
// Значения задаются в Vercel → Settings → Environment Variables:
//   SUPABASE_URL       — https://<project>.supabase.co
//   SUPABASE_ANON_KEY  — ключ "anon" (JWT) или "sb_publishable_..."
//   SUPABASE_SMTP=1    — (необязательно) когда подключена своя почта: включает «Забыли пароль?»
// Публичный ключ по задумке Supabase виден в браузере; доступ к данным защищают правила RLS в базе.
// Секретный ключ (service_role / sb_secret_...) сюда попасть не должен — такой ключ мы не отдаём.

function isPublicKey(key) {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  if (/^sb_secret_/.test(key)) return false;
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload && payload.role === 'anon';
  } catch (e) {
    return false;
  }
}

module.exports = (req, res) => {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
  res.setHeader('cache-control', 'public, max-age=300, s-maxage=300');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) || !key) {
    res.status(200).json({ auth: false });
    return;
  }
  if (!isPublicKey(key)) {
    console.error('SUPABASE_ANON_KEY is not a public anon/publishable key — refusing to expose it');
    res.status(200).json({ auth: false, error: 'not_public_key' });
    return;
  }
  res.status(200).json({ auth: true, url, key, reset: process.env.SUPABASE_SMTP === '1' });
};
