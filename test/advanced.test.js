import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';
import { escalateStale, processOutbox } from '../src/worker.js';

test('full-text search: prefix match, no results, and hostile input is safe', async () => {
  const t = await boot(); const bob = await t.login('bob');
  await t.mk(bob, { title: 'Gateway timeout in checkout' }); await t.mk(bob, { title: 'Refund stuck' });
  assert.equal((await t.call(bob, 'GET', '/items?q=gatew')).body.items.length, 1);
  assert.equal((await t.call(bob, 'GET', '/items?q=zzzz')).body.items.length, 0);
  assert.equal((await t.call(bob, 'GET', '/items?q=' + encodeURIComponent('"* OR (NEAR'))).status, 200);
  const it = (await t.call(bob, 'GET', '/items?q=refund')).body.items[0];
  await t.call(bob, 'PATCH', `/items/${it.id}`, { version: 1, title: 'Chargeback dispute' }); // index follows edits
  assert.equal((await t.call(bob, 'GET', '/items?q=refund')).body.items.length, 0);
  assert.equal((await t.call(bob, 'GET', '/items?q=charge')).body.items.length, 1);
  t.close();
});

test('overdue view and metrics are team-scoped', async () => {
  const t = await boot(); const [bob, ivan] = [await t.login('bob'), await t.login('ivan')];
  await t.mk(bob, { due_date: '2020-01-01' }); await t.mk(bob, { due_date: '2999-01-01' });
  assert.equal((await t.call(bob, 'GET', '/items?view=overdue')).body.items.length, 1);
  assert.equal((await t.call(bob, 'GET', '/dashboard')).body.overdue, 1);
  const m = (await t.call(bob, 'GET', '/metrics')).body;
  assert.equal(m.by_status.open, 2); assert.equal(m.overdue, 1);
  assert.deepEqual((await t.call(ivan, 'GET', '/metrics')).body.by_status, {}); // other team sees nothing
  t.close();
});

test('auto-escalation: once per item, logged as system, notifies leads via outbox', async () => {
  const t = await boot(); const bob = await t.login('bob'); const alice = await t.login('alice');
  const item = await t.mk(bob); // urgent + unassigned
  assert.equal(escalateStale(t.db, { now: Date.now() }), 0); // too fresh
  const later = Date.now() + 31 * 60000;
  assert.equal(escalateStale(t.db, { now: later }), 1);
  assert.equal(escalateStale(t.db, { now: later }), 0); // not repeated
  assert.equal(t.db.prepare(`SELECT COUNT(*) n FROM outbox`).get().n, 2); // alice + admin
  processOutbox(t.db, { now: later });
  assert.match((await t.call(alice, 'GET', '/notifications')).body[0].message, /ESCALATED/);
  const act = (await t.call(bob, 'GET', `/items/${item.id}/activity`)).body.at(-1);
  assert.deepEqual([act.kind, act.actor], ['escalated', 'System']);
  t.close();
});

test('CSV export is filter-scoped and neutralises formula injection', async () => {
  const t = await boot(); const [bob, ivan] = [await t.login('bob'), await t.login('ivan')];
  await t.mk(bob, { title: '=HYPERLINK("x")' }); await t.mk(bob, { title: 'Normal, with comma' });
  const get = async (tok) => { const r = await fetch(t.base + '/items.csv', { headers: { authorization: 'Bearer ' + tok } }); return { type: r.headers.get('content-type'), text: await r.text() }; };
  const r = await get(bob);
  assert.match(r.type, /text\/csv/); assert.ok(r.text.startsWith('id,title')); assert.ok(r.text.includes(`"'=HYPERLINK(""x"")"`)); assert.ok(r.text.includes('"Normal, with comma"'));
  assert.equal((await get(ivan)).text.trim().split('\n').length, 1); // header only
  t.close();
});

test('login rate limit: 11th failed attempt is blocked, system user cannot log in', async () => {
  const t = await boot();
  for (let i = 0; i < 10; i++) assert.equal((await t.call(null, 'POST', '/auth/login', { username: 'bob', password: 'bad' })).status, 401);
  assert.equal((await t.call(null, 'POST', '/auth/login', { username: 'bob', password: 'password123' })).status, 429);
  assert.equal((await t.call(null, 'POST', '/auth/login', { username: 'system', password: '' })).status, 401);
  t.close();
});
