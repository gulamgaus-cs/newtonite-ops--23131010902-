import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES, verify } from './db.js';

export const STATUSES = ['open', 'in_progress', 'awaiting_approval', 'resolved', 'closed'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'task'];

// from -> { to: minimum role }. Approval (awaiting_approval -> resolved) is Lead-only.
export const TRANSITIONS = {
  open: { in_progress: 'member' },
  in_progress: { awaiting_approval: 'member', open: 'member' },
  awaiting_approval: { resolved: 'lead', in_progress: 'lead' },
  resolved: { closed: 'lead', in_progress: 'member' },
  closed: {},
};
const PERMS = { read: 'viewer', create: 'member', comment: 'member', edit: 'member', claim: 'member', reassign: 'lead' };

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

// Single permission function used by every endpoint. Roles are per team.
export function can(user, teamId, action, arg) {
  const role = user.teams.get(teamId);
  if (!role) return false;
  const min = action === 'transition' ? TRANSITIONS[arg.from]?.[arg.to] : PERMS[action];
  return !!min && ROLES[role] >= ROLES[min];
}
export function authorize(user, teamId, action, arg) {
  if (!can(user, teamId, 'read')) throw new HttpError(403, 'You are not a member of this item\'s team');
  if (action === 'transition' && !TRANSITIONS[arg.from]?.[arg.to])
    throw new HttpError(409, `Invalid transition: ${arg.from} → ${arg.to}`);
  if (!can(user, teamId, action, arg)) throw new HttpError(403, `Your role does not allow this action (${action})`);
}

const BASE = `SELECT i.*, t.name team_name, a.name assignee_name, c.name created_by_name FROM items i
  JOIN teams t ON t.id=i.team_id LEFT JOIN users a ON a.id=i.assignee_id JOIN users c ON c.id=i.created_by`;

const today = () => new Date().toISOString().slice(0, 10);

export function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  const api = express.Router();
  app.use((req, res, next) => { // request id + structured access log
    const id = crypto.randomUUID().slice(0, 8), t = Date.now(); res.set('X-Request-Id', id);
    if (process.env.LOG_REQUESTS) res.on('finish', () => console.log(JSON.stringify({ id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t })));
    next();
  });
  app.get('/healthz', (req, res) => res.json({ ok: !!db.prepare('SELECT 1 ok').get() }));
  const fails = new Map(); // failed-login rate limit: 10 failures / minute per ip+username
  const h = (fn) => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } };
  const tx = (fn) => db.transaction(fn)();

  const auth = (req, res, next) => {
    try {
      const tok = (req.get('Authorization') || '').replace(/^Bearer /, '');
      const u = tok && db.prepare(`SELECT u.id,u.username,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?`).get(tok, Date.now());
      if (!u) throw new HttpError(401, 'Login required');
      u.teams = new Map(db.prepare('SELECT team_id, role FROM memberships WHERE user_id=?').all(u.id).map((r) => [r.team_id, r.role]));
      req.user = u; next();
    } catch (e) { next(e); }
  };

  const getItem = (id) => {
    const it = db.prepare(BASE + ' WHERE i.id=?').get(id);
    if (!it) throw new HttpError(404, 'Item not found');
    return it;
  };
  const idParam = (req) => { const id = Number(req.params.id); if (!Number.isInteger(id)) throw new HttpError(400, 'Bad id'); return id; };
  const present = (it, u) => ({
    ...it,
    allowed: {
      transitions: Object.keys(TRANSITIONS[it.status]).filter((to) => can(u, it.team_id, 'transition', { from: it.status, to })),
      claim: can(u, it.team_id, 'claim') && !it.assignee_id && it.status === 'open',
      edit: can(u, it.team_id, 'edit'), reassign: can(u, it.team_id, 'reassign'), comment: can(u, it.team_id, 'comment'),
    },
  });
  // History is written inside the same transaction as the change it describes.
  const log = (itemId, actor, kind, data = {}) =>
    db.prepare('INSERT INTO events(item_id,actor_id,kind,data,at) VALUES(?,?,?,?,?)').run(itemId, actor, kind, JSON.stringify(data), Date.now());
  const notify = (itemId, userId, message) => userId &&
    db.prepare(`INSERT INTO outbox(topic,payload,run_at) VALUES('notify_assignee',?,?)`).run(JSON.stringify({ item_id: itemId, user_id: userId, message }), Date.now());
  const assertMember = (userId, teamId) => {
    if (!db.prepare(`SELECT 1 FROM memberships WHERE user_id=? AND team_id=? AND role!='viewer'`).get(userId, teamId))
      throw new HttpError(400, 'Assignee must be a non-viewer member of the item\'s team');
  };
  const conflict = (id, u, msg = 'This item changed. Reload and try again.') =>
    new HttpError(409, msg, { item: present(getItem(id), u) });

  // Idempotency: same (user, route, key) returns the stored response instead of re-running.
  const idempotent = (req, res, fn) => {
    const key = req.get('Idempotency-Key') && `${req.method} ${req.path}:${req.get('Idempotency-Key')}`;
    const out = tx(() => {
      if (key) {
        const r = db.prepare('SELECT status, body FROM idem WHERE key=? AND user_id=?').get(key, req.user.id);
        if (r) return { status: r.status, body: JSON.parse(r.body), replay: true };
      }
      const o = fn();
      if (key) db.prepare('INSERT INTO idem VALUES(?,?,?,?)').run(key, req.user.id, o.status, JSON.stringify(o.body));
      return o;
    });
    if (out.replay) res.set('Idempotent-Replay', 'true');
    res.status(out.status).json(out.body);
  };

  // ---------- auth ----------
  api.post('/auth/login', h((req, res) => {
    const k = `${req.ip}:${String(req.body.username || '')}`, f = fails.get(k), live = f && Date.now() < f.until;
    if (live && f.n >= 10) throw new HttpError(429, 'Too many failed logins. Try again in a minute.');
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(req.body.username || ''));
    if (!u || !verify(String(req.body.password || ''), u.pw_hash)) {
      fails.set(k, { n: (live ? f.n : 0) + 1, until: Date.now() + 60000 });
      throw new HttpError(401, 'Wrong username or password');
    }
    fails.delete(k);
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, u.id, Date.now() + 12 * 3600e3);
    res.json({ token, user: { id: u.id, name: u.name, username: u.username } });
  }));
  api.get('/me', auth, h((req, res) => {
    const teams = db.prepare('SELECT t.id, t.name, m.role FROM memberships m JOIN teams t ON t.id=m.team_id WHERE m.user_id=?').all(req.user.id);
    res.json({ id: req.user.id, name: req.user.name, username: req.user.username, teams });
  }));
  api.get('/teams', auth, h((req, res) => {
    const ids = [...req.user.teams.keys()];
    res.json(ids.map((id) => ({
      id, name: db.prepare('SELECT name FROM teams WHERE id=?').get(id).name, role: req.user.teams.get(id),
      members: db.prepare(`SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=? AND m.role!='viewer'`).all(id),
    })));
  }));

  // ---------- list / dashboard (server-side filter, search, keyset pagination) ----------
  function buildWhere(u, q) {
    let teams = [...u.teams.keys()];
    if (q.team) { const t = Number(q.team); if (!u.teams.has(t)) throw new HttpError(403, 'Not your team'); teams = [t]; }
    const w = [`i.team_id IN (${teams.map(() => '?').join(',') || 'NULL'})`], p = [...teams];
    const add = (c, ...v) => { w.push(c); p.push(...v); };
    for (const [k, list] of [['status', STATUSES], ['priority', PRIORITIES], ['type', TYPES]])
      if (q[k]) { if (!list.includes(q[k])) throw new HttpError(400, `Bad ${k}`); add(`i.${k}=?`, q[k]); }
    if (q.assignee === 'me') add('i.assignee_id=?', u.id);
    else if (q.assignee === 'unassigned') add('i.assignee_id IS NULL');
    else if (q.assignee) add('i.assignee_id=?', Number(q.assignee));
    if (q.q) { // FTS5 prefix search; only letters/digits reach MATCH, so no query-syntax injection
      const terms = String(q.q).match(/[\p{L}\p{N}_]+/gu) || [];
      if (terms.length) add('i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)', terms.map((t) => `"${t}"*`).join(' '));
    }
    if (q.view === 'assigned_to_me') add(`i.assignee_id=? AND i.status NOT IN ('resolved','closed')`, u.id);
    else if (q.view === 'overdue') add(`i.due_date IS NOT NULL AND i.due_date < ? AND i.status NOT IN ('resolved','closed')`, today());
    else if (q.view === 'unassigned_urgent') add(`i.assignee_id IS NULL AND i.priority='urgent' AND i.status='open'`);
    else if (q.view === 'awaiting_my_approval') {
      const leads = teams.filter((t) => ROLES[u.teams.get(t)] >= ROLES.lead);
      add(`i.status='awaiting_approval' AND i.team_id IN (${leads.map(() => '?').join(',') || 'NULL'})`, ...leads);
    }
    return { sql: w.join(' AND '), p };
  }
  api.get('/items', auth, h((req, res) => {
    const { sql, p } = buildWhere(req.user, req.query);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
    const cur = req.query.cursor ? Number(req.query.cursor) : null;
    const rows = db.prepare(`${BASE} WHERE ${sql}${cur ? ' AND i.id<?' : ''} ORDER BY i.id DESC LIMIT ?`).all(...p, ...(cur ? [cur] : []), limit + 1);
    const more = rows.length > limit; if (more) rows.pop();
    res.json({ items: rows.map((r) => present(r, req.user)), next_cursor: more ? rows[rows.length - 1].id : null });
  }));
  api.get('/items.csv', auth, h((req, res) => { // export of the current filter, capped, CSV-injection safe
    const { sql, p } = buildWhere(req.user, req.query);
    const rows = db.prepare(`${BASE} WHERE ${sql} ORDER BY i.id DESC LIMIT 10000`).all(...p);
    const cols = ['id', 'title', 'type', 'priority', 'status', 'team_name', 'assignee_name', 'created_by_name', 'due_date', 'version'];
    const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="items.csv"' });
    res.send([cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'));
  }));
  api.get('/metrics', auth, h((req, res) => {
    const teams = [...req.user.teams.keys()], ph = teams.map(() => '?').join(',') || 'NULL';
    const group = (col) => Object.fromEntries(db.prepare(`SELECT ${col} k, COUNT(*) n FROM items WHERE team_id IN (${ph}) GROUP BY ${col}`).all(...teams).map((r) => [r.k, r.n]));
    const od = buildWhere(req.user, { view: 'overdue' });
    const avg = db.prepare(`SELECT AVG(e.at-i.created_at) a FROM events e JOIN items i ON i.id=e.item_id WHERE e.kind='status_changed'
      AND json_extract(e.data,'$.to')='resolved' AND i.team_id IN (${ph})`).get(...teams).a;
    res.json({
      by_status: group('status'), by_priority: group('priority'),
      overdue: db.prepare(`SELECT COUNT(*) n FROM items i WHERE ${od.sql}`).get(...od.p).n,
      avg_resolution_hours: avg == null ? null : +(avg / 3600000).toFixed(1),
      workload: db.prepare(`SELECT u.name, COUNT(*) active FROM items i JOIN users u ON u.id=i.assignee_id WHERE i.team_id IN (${ph})
        AND i.status IN ('open','in_progress','awaiting_approval') GROUP BY u.id ORDER BY active DESC LIMIT 5`).all(...teams),
    });
  }));
  api.get('/dashboard', auth, h((req, res) => {
    const out = {};
    for (const view of ['assigned_to_me', 'unassigned_urgent', 'awaiting_my_approval', 'overdue']) {
      const { sql, p } = buildWhere(req.user, { view });
      out[view] = db.prepare(`SELECT COUNT(*) n FROM items i WHERE ${sql}`).get(...p).n;
    }
    res.json(out);
  }));

  // ---------- create (idempotent) ----------
  api.post('/items', auth, h((req, res) => idempotent(req, res, () => {
    const b = req.body, u = req.user;
    const title = String(b.title || '').trim();
    if (!title || title.length > 200) throw new HttpError(400, 'Title is required (max 200 characters)');
    const priority = b.priority || 'medium';
    if (!TYPES.includes(b.type) || !PRIORITIES.includes(priority)) throw new HttpError(400, 'Invalid type or priority');
    const teamId = Number(b.team_id);
    authorize(u, teamId, 'create');
    const assignee = b.assignee_id ? Number(b.assignee_id) : null;
    if (assignee) { authorize(u, teamId, 'reassign'); assertMember(assignee, teamId); }
    const now = Date.now();
    const id = db.prepare(`INSERT INTO items(title,description,type,priority,status,team_id,assignee_id,created_by,due_date,version,created_at,updated_at)
      VALUES(?,?,?,?, 'open',?,?,?,?,1,?,?)`).run(title, String(b.description || ''), b.type, priority, teamId, assignee, u.id, b.due_date || null, now, now).lastInsertRowid;
    log(id, u.id, 'created', { title, type: b.type, priority });
    if (assignee) { log(id, u.id, 'owner_changed', { from: null, to: assignee }); notify(id, assignee, `You were assigned: ${title}`); }
    return { status: 201, body: present(getItem(id), u) };
  })));

  api.get('/items/:id', auth, h((req, res) => {
    const it = getItem(idParam(req));
    authorize(req.user, it.team_id, 'read');
    res.json(present(it, req.user));
  }));

  // ---------- edit with optimistic locking ----------
  api.patch('/items/:id', auth, h((req, res) => {
    const id = idParam(req), b = req.body, u = req.user;
    const out = tx(() => {
      const it = getItem(id);
      authorize(u, it.team_id, 'edit');
      const v = Number(b.version);
      if (!Number.isInteger(v)) throw new HttpError(400, 'version is required');
      const set = {};
      for (const f of ['title', 'description', 'due_date']) if (f in b && b[f] !== it[f]) set[f] = b[f];
      if ('title' in set && !String(set.title).trim()) throw new HttpError(400, 'Title cannot be empty');
      if ('priority' in b && b.priority !== it.priority) {
        if (!PRIORITIES.includes(b.priority)) throw new HttpError(400, 'Invalid priority');
        set.priority = b.priority;
      }
      if ('assignee_id' in b && (b.assignee_id ?? null) !== it.assignee_id) {
        authorize(u, it.team_id, 'reassign');
        if (b.assignee_id !== null) assertMember(Number(b.assignee_id), it.team_id);
        set.assignee_id = b.assignee_id === null ? null : Number(b.assignee_id);
      }
      const cols = Object.keys(set); // whitelisted above, safe to interpolate
      if (!cols.length) return present(it, u);
      const r = db.prepare(`UPDATE items SET ${cols.map((c) => c + '=?').join(',')}, version=version+1, updated_at=? WHERE id=? AND version=?`)
        .run(...cols.map((c) => set[c]), Date.now(), id, v);
      if (!r.changes) throw conflict(id, u);
      if ('priority' in set) log(id, u.id, 'priority_changed', { from: it.priority, to: set.priority });
      if ('assignee_id' in set) {
        log(id, u.id, 'owner_changed', { from: it.assignee_id, to: set.assignee_id });
        notify(id, set.assignee_id, `You were assigned: ${it.title}`);
      }
      const other = cols.filter((c) => !['priority', 'assignee_id'].includes(c));
      if (other.length) log(id, u.id, 'updated', { fields: other });
      return present(getItem(id), u);
    });
    res.json(out);
  }));

  // ---------- atomic claim ----------
  api.post('/items/:id/claim', auth, h((req, res) => idempotent(req, res, () => {
    const id = idParam(req), u = req.user, it = getItem(id);
    authorize(u, it.team_id, 'claim');
    const r = db.prepare(`UPDATE items SET assignee_id=?, status='in_progress', version=version+1, updated_at=?
      WHERE id=? AND assignee_id IS NULL AND status='open'`).run(u.id, Date.now(), id);
    if (!r.changes) throw conflict(id, u, 'Someone else claimed this item first, or it is no longer open.');
    log(id, u.id, 'owner_changed', { from: null, to: u.id });
    log(id, u.id, 'status_changed', { from: 'open', to: 'in_progress' });
    return { status: 200, body: present(getItem(id), u) };
  })));

  // ---------- workflow transition ----------
  api.post('/items/:id/transition', auth, h((req, res) => idempotent(req, res, () => {
    const id = idParam(req), u = req.user, b = req.body, it = getItem(id);
    authorize(u, it.team_id, 'transition', { from: it.status, to: b.to });
    if (b.version !== undefined && Number(b.version) !== it.version) throw conflict(id, u);
    const r = db.prepare('UPDATE items SET status=?, version=version+1, updated_at=? WHERE id=? AND status=?').run(b.to, Date.now(), id, it.status);
    if (!r.changes) throw conflict(id, u);
    log(id, u.id, 'status_changed', { from: it.status, to: b.to, note: b.note ? String(b.note).slice(0, 500) : undefined });
    return { status: 200, body: present(getItem(id), u) };
  })));

  // ---------- comments & activity ----------
  api.post('/items/:id/comments', auth, h((req, res) => {
    const id = idParam(req), it = getItem(id), body = String(req.body.body || '').trim();
    authorize(req.user, it.team_id, 'comment');
    if (!body || body.length > 2000) throw new HttpError(400, 'Comment is required (max 2000 characters)');
    tx(() => log(id, req.user.id, 'comment', { body }));
    res.status(201).json({ ok: true });
  }));
  api.get('/items/:id/activity', auth, h((req, res) => {
    const id = idParam(req), it = getItem(id);
    authorize(req.user, it.team_id, 'read');
    const rows = db.prepare(`SELECT e.id, e.kind, e.data, e.at, u.name actor FROM events e JOIN users u ON u.id=e.actor_id WHERE e.item_id=? ORDER BY e.id`).all(id);
    const names = new Map(db.prepare('SELECT id, name FROM users').all().map((r) => [r.id, r.name]));
    res.json(rows.map((r) => {
      const data = JSON.parse(r.data);
      if (r.kind === 'owner_changed') { data.from_name = names.get(data.from) ?? null; data.to_name = names.get(data.to) ?? null; }
      return { ...r, data };
    }));
  }));
  api.get('/notifications', auth, h((req, res) =>
    res.json(db.prepare('SELECT id, item_id, message, created_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id))));

  app.use('/api', api);
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));
  app.use((e, req, res, next) => {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, ...e.extra });
    if (e.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(e); res.status(500).json({ error: 'Internal error' });
  });
  return app;
}
