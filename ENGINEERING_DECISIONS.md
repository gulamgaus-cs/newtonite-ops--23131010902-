# Engineering Decisions

## 1. Data model and history
**Context:** History must never disagree with the item. **Options:** separate audit writes; event sourcing; same-transaction event rows. **Choice:** `items` holds current state + `version`; `events` is append-only (DB triggers block UPDATE/DELETE) and every change writes its event inside the same transaction. Comments are events. **Trade-off:** reading history needs a join/second query; no full event-sourced replay.

## 2. Concurrency control
**Context:** double claims, stale edits, retries. **Options:** row locks, optimistic locking, conditional updates. **Choice:** conditional `UPDATE … WHERE` for claim/transition (0 rows → 409), `version` check for edits, `Idempotency-Key` table for retries (stored inside the same transaction as the work, so a crash stores neither). **Trade-off:** clients must handle 409 and refetch; keys are never expired yet.

## 3. Authorization model
**Context:** roles per team, enforced on the server. **Choice:** `memberships(user, team, role)` with ranks viewer < member < lead < admin; one `can()/authorize()` function used by every endpoint, and every list query is filtered by the caller's team ids. The transition map carries the minimum role per edge, so the Lead-only approval is data, not scattered `if`s. **Trade-off:** role is per team, not per item; non-members get 403 (leaks that an id exists).

## 4. Sync vs async
**Context:** assignee notifications must not be lost or duplicated. **Choice:** transactional outbox written with the change; a worker polls, claims each attempt atomically, retries with exponential backoff up to 5 attempts, then marks `failed`. Handler is idempotent via `UNIQUE(outbox_id)`. **Trade-off:** at-least-once delivery with ~1 s latency; polling instead of LISTEN/NOTIFY or a queue.

## 5. Database, search and pagination
**Context:** brief suggests Postgres, tens of thousands of items. **Choice:** SQLite (WAL) so the reviewer needs only `npm install`; writes serialize, which makes the conditional updates trivially safe. Keyset pagination (`id < cursor`) and composite indexes `(team_id,status,id)`, `(assignee_id,status,id)`, `(priority,status,assignee_id,id)`. **Trade-off:** single-node only, `LIKE` search; at 10× I would move to Postgres (read replicas, `pg_trgm`/FTS, partition `events` by time) and a real queue.

## 6. Search: FTS5 instead of LIKE
**Context:** `LIKE '%x%'` cannot use an index and degrades with tens of thousands of items. **Choice:** an external-content FTS5 table synced by triggers; user input is reduced to letters/digits and turned into quoted prefix terms, so MATCH syntax can't be injected. **Trade-off:** no ranking/typo tolerance; a Postgres move would use `tsvector`/`pg_trgm`.

## 7. SLA escalation as a system actor
**Context:** urgent work must not sit unseen. **Choice:** a periodic job finds stale urgent items and, per item in one transaction, writes an `escalated` event (actor = reserved `system` user that cannot log in) and outbox rows for team Leads; a NOT EXISTS check makes it run-once. **Trade-off:** fixed threshold, no repeat reminders or on-call routing.

## What I chose not to build
Sign-up, email, attachments, SSO, websockets, per-item ACLs, fancy styling.
