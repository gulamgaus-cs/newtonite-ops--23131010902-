import Database from 'better-sqlite3';
import crypto from 'node:crypto';

export const ROLES = { viewer: 1, member: 2, lead: 3, admin: 4 };

export const hash = (pw) => {
  const salt = crypto.randomBytes(8).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
};
export const verify = (pw, stored) => {
  const [salt, key] = stored.split(':');
  if (!key) return false;
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), crypto.scryptSync(pw, salt, 32));
};

export function openDb(file = ':memory:') {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const hadFts = db.prepare("SELECT 1 FROM sqlite_master WHERE name='items_fts'").get();
  db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pw_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS teams(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS memberships(
  user_id INT NOT NULL REFERENCES users, team_id INT NOT NULL REFERENCES teams,
  role TEXT NOT NULL CHECK(role IN ('viewer','member','lead','admin')), PRIMARY KEY(user_id, team_id));
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INT NOT NULL REFERENCES users, expires INT NOT NULL);
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK(type IN ('incident','customer_issue','payment','compliance','task')),
  priority TEXT NOT NULL CHECK(priority IN ('low','medium','high','urgent')),
  status TEXT NOT NULL CHECK(status IN ('open','in_progress','awaiting_approval','resolved','closed')),
  team_id INT NOT NULL REFERENCES teams, assignee_id INT REFERENCES users, created_by INT NOT NULL REFERENCES users,
  due_date TEXT, version INT NOT NULL DEFAULT 1, created_at INT NOT NULL, updated_at INT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_items_team_status ON items(team_id, status, id);
CREATE INDEX IF NOT EXISTS ix_items_assignee ON items(assignee_id, status, id);
CREATE INDEX IF NOT EXISTS ix_items_urgent ON items(priority, status, assignee_id, id);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, item_id INT NOT NULL REFERENCES items, actor_id INT NOT NULL REFERENCES users,
  kind TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', at INT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_events_item ON events(item_id, id);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TABLE IF NOT EXISTS idem(key TEXT NOT NULL, user_id INT NOT NULL, status INT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(key, user_id));
CREATE TABLE IF NOT EXISTS outbox(
  id INTEGER PRIMARY KEY, topic TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','failed')),
  attempts INT NOT NULL DEFAULT 0, run_at INT NOT NULL, error TEXT);
CREATE INDEX IF NOT EXISTS ix_outbox ON outbox(status, run_at);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY, outbox_id INT UNIQUE NOT NULL, user_id INT NOT NULL, item_id INT NOT NULL,
  message TEXT NOT NULL, created_at INT NOT NULL);
-- Full-text search (FTS5), kept in sync by triggers
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(title, description, content='items', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid,title,description) VALUES(new.id,new.title,new.description); END;
CREATE TRIGGER IF NOT EXISTS items_fts_au AFTER UPDATE OF title,description ON items BEGIN
  INSERT INTO items_fts(items_fts,rowid,title,description) VALUES('delete',old.id,old.title,old.description);
  INSERT INTO items_fts(rowid,title,description) VALUES(new.id,new.title,new.description); END;
`);
  if (!hadFts) db.exec("INSERT INTO items_fts(items_fts) VALUES('rebuild')");
  // Reserved system actor (id 0) for automated events; cannot log in (no valid hash).
  db.prepare("INSERT OR IGNORE INTO users(id,username,name,pw_hash) VALUES(0,'system','System','!')").run();
  return db;
}
