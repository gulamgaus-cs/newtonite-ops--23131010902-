// Transactional-outbox worker: retries with exponential backoff, capped attempts, idempotent handler.
export const notifyHandler = (db, job) => {
  const p = JSON.parse(job.payload);
  // UNIQUE(outbox_id) makes this idempotent: processing a job twice yields one notification.
  db.prepare('INSERT OR IGNORE INTO notifications(outbox_id,user_id,item_id,message,created_at) VALUES(?,?,?,?,?)')
    .run(job.id, p.user_id, p.item_id, p.message, Date.now());
};

export function processOutbox(db, { now = Date.now(), handler = notifyHandler, maxAttempts = 5 } = {}) {
  const jobs = db.prepare(`SELECT * FROM outbox WHERE status='pending' AND run_at<=? ORDER BY id LIMIT 50`).all(now);
  let done = 0;
  for (const job of jobs) {
    // Claim the attempt atomically so two workers never run the same attempt.
    const claim = db.prepare(`UPDATE outbox SET attempts=attempts+1 WHERE id=? AND status='pending' AND attempts=?`).run(job.id, job.attempts);
    if (!claim.changes) continue;
    try {
      db.transaction(() => { handler(db, job); db.prepare(`UPDATE outbox SET status='done', error=NULL WHERE id=?`).run(job.id); })();
      done++;
    } catch (e) {
      const attempts = job.attempts + 1;
      if (attempts >= maxAttempts) db.prepare(`UPDATE outbox SET status='failed', error=? WHERE id=?`).run(e.message, job.id);
      else db.prepare(`UPDATE outbox SET run_at=?, error=? WHERE id=?`).run(now + 2 ** attempts * 1000, e.message, job.id);
    }
  }
  return done;
}

// SLA automation: urgent items still open and unassigned after `minutes` are escalated once,
// recorded in history (actor = system) and every Lead/Admin of the team is notified via the outbox.
export function escalateStale(db, { now = Date.now(), minutes = 30 } = {}) {
  const stale = db.prepare(`SELECT id,title,team_id FROM items WHERE status='open' AND assignee_id IS NULL AND priority='urgent'
    AND created_at<=? AND NOT EXISTS(SELECT 1 FROM events WHERE item_id=items.id AND kind='escalated') LIMIT 200`).all(now - minutes * 60000);
  let n = 0;
  for (const it of stale) db.transaction(() => {
    db.prepare(`INSERT INTO events(item_id,actor_id,kind,data,at) VALUES(?,0,'escalated',?,?)`).run(it.id, JSON.stringify({ system: true, minutes }), now);
    for (const l of db.prepare(`SELECT user_id FROM memberships WHERE team_id=? AND role IN ('lead','admin')`).all(it.team_id))
      db.prepare(`INSERT INTO outbox(topic,payload,run_at) VALUES('notify_assignee',?,?)`)
        .run(JSON.stringify({ item_id: it.id, user_id: l.user_id, message: `ESCALATED: urgent item unassigned for ${minutes}+ min: ${it.title}` }), now);
    n++;
  })();
  return n;
}
