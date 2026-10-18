import { openDb } from './db.js';
import { seed } from './seed.js';
import { createApp } from './app.js';
import { processOutbox, escalateStale } from './worker.js';

const db = openDb(process.env.DB_FILE || 'data.db');
if (!db.prepare('SELECT 1 FROM teams').get()) { seed(db); console.log('Seeded demo data (password: password123)'); }
setInterval(() => { try { processOutbox(db); } catch (e) { console.error('worker', e); } }, 1000);
setInterval(() => { try { escalateStale(db, { minutes: Number(process.env.ESCALATE_MINUTES) || 30 }); } catch (e) { console.error('escalation', e); } }, 60000);
process.env.LOG_REQUESTS ??= '1';
const port = process.env.PORT || 3000;
createApp(db).listen(port, () => console.log(`http://localhost:${port}`));
