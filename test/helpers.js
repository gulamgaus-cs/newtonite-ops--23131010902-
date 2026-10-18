import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createApp } from '../src/app.js';

export async function boot(items = 0) {
  const db = openDb(':memory:'); seed(db, { items });
  const srv = createApp(db).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const call = async (tok, method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(tok && { authorization: 'Bearer ' + tok }), ...headers }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const login = async (u) => (await call(null, 'POST', '/auth/login', { username: u, password: 'password123' })).body.token;
  const team = (n) => db.prepare('SELECT id FROM teams WHERE name=?').get(n).id;
  const uid = (n) => db.prepare('SELECT id FROM users WHERE username=?').get(n).id;
  const close = () => { srv.closeAllConnections(); srv.close(); };
  const mk = async (tok, extra = {}) => (await call(tok, 'POST', '/items', { title: 'Test', type: 'payment', priority: 'urgent', team_id: team('Payments'), ...extra })).body;
  return { db, call, login, team, uid, close, mk, base };
}

