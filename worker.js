// Талиб — сервер синхронизации (Cloudflare Worker + база D1).
// Хранит одну запись с данными пользователя. Доступ — только по паролю синхронизации.
//
// Настройки сервиса в панели Cloudflare:
//   • привязка D1-базы с именем переменной DB  (Bindings → D1 database → Variable name: DB)
//   • секрет SYNC_PASSWORD — ваш пароль синхронизации (Settings → Variables and Secrets → Secret)
//
// API (все запросы — с заголовком  Authorization: Bearer <пароль>):
//   GET  /ping  → {ok:true, ver}
//   GET  /data  → {ver, data, updated}       data — строка (JSON документа синхронизации) или null
//   PUT  /data  ← {ver, data}                 записать, только если на сервере всё ещё версия ver
//               → {ok:true, ver}  или  409 {error:'conflict', ver, data, updated}

const MAX_SIZE = 8 * 1024 * 1024; // 8 МБ — с большим запасом

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

// сравнение без утечки по времени
async function samePassword(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}

async function ensureTable(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS talib (k TEXT PRIMARY KEY, ver INTEGER NOT NULL, data TEXT, updated INTEGER NOT NULL)').run();
}

async function current(db) {
  return (await db.prepare("SELECT ver, data, updated FROM talib WHERE k = 'main'").first()) || { ver: 0, data: null, updated: 0 };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/') return json({ app: 'talib-sync', ok: true });
    if (!env.DB) return json({ error: 'no-db', message: 'Не привязана база D1 с именем DB' }, 500);
    if (!env.SYNC_PASSWORD) return json({ error: 'no-password', message: 'Не задан секрет SYNC_PASSWORD' }, 500);

    const auth = request.headers.get('Authorization') || '';
    const pw = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!pw || !(await samePassword(pw, env.SYNC_PASSWORD))) return json({ error: 'auth', message: 'Неверный пароль синхронизации' }, 401);

    await ensureTable(env.DB);

    if (path === '/ping' && request.method === 'GET') {
      const c = await current(env.DB);
      return json({ ok: true, ver: c.ver, updated: c.updated });
    }

    if (path === '/data' && request.method === 'GET') {
      return json(await current(env.DB));
    }

    if (path === '/data' && request.method === 'PUT') {
      const text = await request.text();
      if (text.length > MAX_SIZE) return json({ error: 'too-big' }, 413);
      let body;
      try { body = JSON.parse(text); } catch (e) { return json({ error: 'bad-json' }, 400); }
      if (typeof body.data !== 'string' || !Number.isInteger(body.ver)) return json({ error: 'bad-request' }, 400);
      const now = Date.now(), next = body.ver + 1;
      // записываем только если версия на сервере не изменилась (иначе другое устройство успело раньше)
      let res;
      if (body.ver === 0) {
        res = await env.DB.prepare("INSERT INTO talib (k, ver, data, updated) VALUES ('main', 1, ?, ?) ON CONFLICT(k) DO NOTHING").bind(body.data, now).run();
      } else {
        res = await env.DB.prepare("UPDATE talib SET ver = ?, data = ?, updated = ? WHERE k = 'main' AND ver = ?").bind(next, body.data, now, body.ver).run();
      }
      if (!res.meta || res.meta.changes !== 1) {
        const c = await current(env.DB);
        return json({ error: 'conflict', ...c }, 409);
      }
      return json({ ok: true, ver: next, updated: now });
    }

    return json({ error: 'not-found' }, 404);
  },
};
