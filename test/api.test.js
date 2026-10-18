import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';
import { processOutbox, notifyHandler } from '../src/worker.js';

test('concurrent claim: exactly one wins', async () => {
  const t = await boot(); const [bob, heidi] = [await t.login('bob'), await t.login('heidi')];
  const item = await t.mk(bob);
  const res = await Promise.all([t.call(bob, 'POST', `/items/${item.id}/claim`), t.call(heidi, 'POST', `/items/${item.id}/claim`)]);
  assert.deepEqual(res.map((r) => r.status).sort(), [200, 409]);
  const final = await t.call(bob, 'GET', `/items/${item.id}`);
  assert.equal(final.body.version, 2);
  assert.equal(t.db.prepare(`SELECT COUNT(*) n FROM events WHERE item_id=? AND kind='owner_changed'`).get(item.id).n, 1);
  t.close();
});

test('stale update is rejected with latest item; data unchanged', async () => {
  const t = await boot(); const bob = await t.login('bob');
  const item = await t.mk(bob);
  const ok = await t.call(bob, 'PATCH', `/items/${item.id}`, { version: 1, title: 'Fresh' });
  assert.equal(ok.status, 200); assert.equal(ok.body.version, 2);
  const stale = await t.call(bob, 'PATCH', `/items/${item.id}`, { version: 1, title: 'Stale' });
  assert.equal(stale.status, 409); assert.equal(stale.body.item.title, 'Fresh');
  assert.equal((await t.call(bob, 'GET', `/items/${item.id}`)).body.title, 'Fresh');
  t.close();
});

test('same Idempotency-Key creates one item and replays the response', async () => {
  const t = await boot(); const bob = await t.login('bob');
  const body = { title: 'Once', type: 'task', team_id: t.team('Payments') };
  const h = { 'Idempotency-Key': 'abc-123' };
  const [a, b] = await Promise.all([t.call(bob, 'POST', '/items', body, h), t.call(bob, 'POST', '/items', body, h)]);
  assert.equal(a.body.id, b.body.id);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM items').get().n, 1);
  t.close();
});

test('workflow: invalid jump rejected; only a Lead approves', async () => {
  const t = await boot(); const [bob, alice] = [await t.login('bob'), await t.login('alice')];
  const a = await t.mk(bob);
  assert.equal((await t.call(bob, 'POST', `/items/${a.id}/transition`, { to: 'closed' })).status, 409);
  await t.call(bob, 'POST', `/items/${a.id}/claim`);
  assert.equal((await t.call(bob, 'POST', `/items/${a.id}/transition`, { to: 'awaiting_approval' })).status, 200);
  assert.equal((await t.call(bob, 'POST', `/items/${a.id}/transition`, { to: 'resolved' })).status, 403);
  assert.equal((await t.call(alice, 'POST', `/items/${a.id}/transition`, { to: 'resolved' })).status, 200);
  t.close();
});

test('authorization is enforced per team and role on the server', async () => {
  const t = await boot(); const [bob, ivan, carol, dave] = await Promise.all(['bob', 'ivan', 'carol', 'dave'].map(t.login));
  const item = await t.mk(bob);
  assert.equal((await t.call(ivan, 'GET', `/items/${item.id}`)).status, 403);
  assert.equal((await t.call(carol, 'PATCH', `/items/${item.id}`, { version: 1, title: 'x' })).status, 403);
  assert.equal((await t.call(carol, 'POST', `/items/${item.id}/claim`)).status, 403);
  assert.equal((await t.call(dave, 'POST', '/items', { title: 'v', type: 'task', team_id: t.team('Payments') })).status, 403); // viewer
  assert.equal((await t.call(ivan, 'GET', '/items')).body.items.length, 0); // list is scoped
  assert.equal((await t.call(bob, 'PATCH', `/items/${item.id}`, { version: 1, assignee_id: t.uid('heidi') })).status, 403); // reassign is Lead-only
  t.close();
});

test('history is written with every change and is append-only', async () => {
  const t = await boot(); const [bob, alice] = [await t.login('bob'), await t.login('alice')];
  const item = await t.mk(bob);
  await t.call(alice, 'PATCH', `/items/${item.id}`, { version: 1, priority: 'low', assignee_id: t.uid('bob') });
  await t.call(bob, 'POST', `/items/${item.id}/comments`, { body: 'on it' });
  const kinds = (await t.call(bob, 'GET', `/items/${item.id}/activity`)).body.map((e) => e.kind);
  assert.deepEqual(kinds, ['created', 'priority_changed', 'owner_changed', 'comment']);
  assert.throws(() => t.db.prepare('DELETE FROM events').run(), /append-only/);
  assert.throws(() => t.db.prepare(`UPDATE events SET kind='x'`).run(), /append-only/);
  t.close();
});

test('outbox: processed twice => one notification; failures retry then fail', async () => {
  const t = await boot(); const [bob, alice] = [await t.login('bob'), await t.login('alice')];
  const item = await t.mk(bob);
  await t.call(alice, 'PATCH', `/items/${item.id}`, { version: 1, assignee_id: t.uid('bob') });
  assert.equal(processOutbox(t.db), 1);
  const job = t.db.prepare('SELECT * FROM outbox').get();
  notifyHandler(t.db, job); notifyHandler(t.db, job); // simulate duplicate delivery
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM notifications').get().n, 1);
  assert.equal((await t.call(bob, 'GET', '/notifications')).body.length, 1);

  await t.call(alice, 'PATCH', `/items/${item.id}`, { version: 2, assignee_id: t.uid('heidi') });
  for (let i = 1; i <= 6; i++) processOutbox(t.db, { now: Date.now() + i * 1e7, handler: () => { throw new Error('boom'); } });
  const failed = t.db.prepare(`SELECT * FROM outbox WHERE status='failed'`).get();
  assert.equal(failed.attempts, 5); assert.equal(failed.error, 'boom');
  t.close();
});

test('keyset pagination returns every item exactly once; filters are server-side', async () => {
  const t = await boot(120); const admin = await t.login('admin');
  const seen = new Set(); let cursor = null, pages = 0;
  do {
    const r = await t.call(admin, 'GET', `/items?limit=50${cursor ? '&cursor=' + cursor : ''}`);
    r.body.items.forEach((i) => seen.add(i.id)); cursor = r.body.next_cursor; pages++;
  } while (cursor);
  assert.equal(seen.size, 120); assert.equal(pages, 3);
  const urgent = await t.call(admin, 'GET', '/items?priority=urgent&limit=100');
  assert.ok(urgent.body.items.every((i) => i.priority === 'urgent'));
  t.close();
});
