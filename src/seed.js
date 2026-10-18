import { pathToFileURL } from 'node:url';
import { openDb, hash } from './db.js';

const TEAMS = ['Payments', 'Compliance', 'Support', 'Platform'];
const USERS = [
  ['admin', 'Ada Admin', { Payments: 'admin', Compliance: 'admin', Support: 'admin', Platform: 'admin' }],
  ['alice', 'Alice Lead', { Payments: 'lead', Support: 'member' }],
  ['bob', 'Bob Member', { Payments: 'member' }],
  ['carol', 'Carol Lead', { Compliance: 'lead' }],
  ['dave', 'Dave Member', { Compliance: 'member', Payments: 'viewer' }],
  ['erin', 'Erin Lead', { Support: 'lead' }],
  ['frank', 'Frank Member', { Support: 'member' }],
  ['grace', 'Grace Lead', { Platform: 'lead' }],
  ['heidi', 'Heidi Member', { Platform: 'member', Payments: 'member' }],
  ['ivan', 'Ivan Viewer', { Platform: 'viewer' }],
];
export const DEMO_PASSWORD = 'password123';

export function seed(db, { items = 5000 } = {}) {
  const pw = hash(DEMO_PASSWORD);
  db.transaction(() => {
    const tid = {};
    for (const t of TEAMS) tid[t] = db.prepare('INSERT INTO teams(name) VALUES(?)').run(t).lastInsertRowid;
    for (const [u, name, roles] of USERS) {
      const id = db.prepare('INSERT INTO users(username,name,pw_hash) VALUES(?,?,?)').run(u, name, pw).lastInsertRowid;
      for (const [t, r] of Object.entries(roles)) db.prepare('INSERT INTO memberships VALUES(?,?,?)').run(id, tid[t], r);
    }
    let s = 42; const rnd = (n) => (s = (s * 1664525 + 1013904223) % 4294967296) % n;
    const pick = (a) => a[rnd(a.length)];
    const members = db.prepare(`SELECT user_id, team_id FROM memberships WHERE role!='viewer'`).all();
    const types = ['incident', 'customer_issue', 'payment', 'compliance', 'task'];
    const prios = ['low', 'medium', 'medium', 'high', 'urgent'];
    const stats = ['open', 'open', 'in_progress', 'in_progress', 'awaiting_approval', 'resolved', 'closed'];
    const ins = db.prepare(`INSERT INTO items(title,description,type,priority,status,team_id,assignee_id,created_by,due_date,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)`);
    const ev = db.prepare(`INSERT INTO events(item_id,actor_id,kind,data,at) VALUES(?,?,'created','{}',?)`);
    const subjects = ['Payment gateway timeout', 'Refund stuck', 'KYC review pending', 'Chargeback dispute', 'Login failures', 'Audit evidence request', 'Settlement mismatch', 'Customer escalation', 'API latency spike', 'Webhook retries failing'];
    for (let i = 0; i < items; i++) {
      const creator = pick(members); const team = creator.team_id;
      const status = pick(stats);
      const pool = members.filter((m) => m.team_id === team);
      const assignee = status === 'open' && rnd(3) ? null : pick(pool).user_id;
      const at = Date.now() - rnd(60 * 86400000);
      const id = ins.run(`${pick(subjects)} #${i + 1}`, 'Seeded sample item.', pick(types), pick(prios), status, team, assignee, creator.user_id,
        new Date(Date.now() + (rnd(30) - 10) * 86400000).toISOString().slice(0, 10), at, at).lastInsertRowid;
      ev.run(id, creator.user_id, at);
    }
  })();
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const db = openDb(process.env.DB_FILE || 'data.db');
  if (db.prepare('SELECT 1 FROM teams').get()) console.log('Already seeded.');
  else { seed(db); console.log('Seeded 4 teams, 10 users, 5000 items. Password for all users:', DEMO_PASSWORD); }
}
