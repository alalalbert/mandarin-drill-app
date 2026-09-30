// Recall practice: the opt-in mode where you try to remember a card before
// seeing it, then rate yourself. Kept deliberately separate from srs.js and
// from Classic scheduling.
//
// Two rules govern everything in this file:
//
//   1. It never writes cards.json, state.json, reviews.jsonl or
//      reviews-phone.jsonl, and never touches the localStorage keys Classic
//      uses ('cachedCards', 'cachedState', 'pendingReviews', 'ghtok'). Its
//      own records live under 'learn.*' locally and learning-v2/ remotely.
//      test-learn.js asserts this against a spying store.
//
//   2. Nothing here is machine-graded. Every outcome is the learner's own
//      rating, so every label this file produces says so. There is no code
//      path that promotes a self-rating to a measured result -- that
//      distinction is the only thing keeping the progress screen honest.
'use strict';

const LEARN = {
  SCHEMA: 1,

  // The 24 starting items, by their EXISTING base id. Identifiers only: the
  // Chinese, pinyin, gloss, component note and example are all read from
  // cards.json at runtime, so no private deck content is committed to the
  // public app repository.
  PILOT: [
    'vocab:qing', 'vocab:kuai', 'vocab:kuai4', 'vocab:gen', 'vocab:hen',
    'vocab:gongyu', 'vocab:jian', 'vocab:youdian', 'vocab:xiuxi',
    'vocab:gui', 'vocab:shengyi', 'vocab:gei', 'vocab:lei', 'vocab:qian2',
    'vocab:lu', 'vocab:pianyi', 'vocab:yifu', 'vocab:qunzi',
    'vocab:chenshan', 'vocab:xie2', 'vocab:shi4try', 'vocab:jian4mw',
    'vocab:tiao2', 'vocab:jiaqian',
  ],

  KEY_LOG: 'learn.log.v1',
  KEY_DEVICE: 'learn.device.v1',
  KEY_FLAG: 'learn.enabled.v1',

  // Keys Classic owns. Asserted against in the tests; listed here so the
  // rule is visible rather than remembered.
  CLASSIC_KEYS: ['cachedCards', 'cachedState', 'pendingReviews', 'ghtok',
                 'pushEnabled'],

  SESSION_ITEMS: 6,
  CONFIRM_GAP_H: 24,

  /* ----------------------------- pure logic ----------------------------- */

  uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'e-' + Date.now().toString(36) + '-' +
           Math.random().toString(36).slice(2, 10);
  },

  // One event per card shown: what was rated, when it was revealed, and
  // whether help was used. `assessment` is hard-coded to 'self' because
  // there is no other kind in this mode.
  newEvent(o) {
    const ev = {
      schemaVersion: LEARN.SCHEMA,
      eventId: o.eventId || LEARN.uuid(),
      deviceId: o.deviceId,
      sessionId: o.sessionId,
      itemId: o.itemId,
      eventType: 'answer',
      presentation: 'reveal_then_rate',
      assessment: 'self',
      revealedAt: o.revealedAt || null,
      occurredAt: o.occurredAt,
      ratings: { pronunciation: o.pronunciation, meaning: o.meaning },
      support: o.support || [],
      firstAttempt: o.firstAttempt !== false,
    };
    if (o.audioMuted) ev.audioMuted = true;
    return ev;
  },

  // An item counts as recalled for scheduling only when BOTH halves were a
  // clean yes. "Partly" is not recall -- it just means the item comes back.
  wasClean(ev) {
    const r = (ev && ev.ratings) || {};
    return r.pronunciation === 'yes' && r.meaning === 'yes' &&
           (ev.support || []).length === 0;
  },

  // Deterministic, order-independent merge. Same id + same payload is one
  // event; same id + different payload is a conflict the caller must keep
  // rather than resolve, so this throws instead of picking a winner.
  unionEvents(left, right) {
    const byId = new Map();
    for (const ev of [].concat(left || [], right || [])) {
      const seen = byId.get(ev.eventId);
      if (!seen) { byId.set(ev.eventId, ev); continue; }
      if (JSON.stringify(seen) !== JSON.stringify(ev)) {
        const e = new Error('conflicting payloads for event ' + ev.eventId);
        e.conflict = [seen, ev];
        throw e;
      }
    }
    return [...byId.values()].sort((a, b) =>
        a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);
  },

  acknowledge(pending, ackedIds) {
    const acked = new Set(ackedIds || []);
    return (pending || []).filter(ev => !acked.has(ev.eventId));
  },

  // Fold events into per-item, per-skill history. Events are authoritative;
  // this result is a cache and may be thrown away and rebuilt at any time.
  // Sorted by (occurredAt, eventId) so arrival order cannot change it.
  projectSkills(events, SRSref) {
    const srs = SRSref || (typeof SRS !== 'undefined' ? SRS : null);
    const ordered = (events || []).slice().sort((a, b) => {
      if (a.occurredAt !== b.occurredAt) {
        return a.occurredAt < b.occurredAt ? -1 : 1;
      }
      return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
    });
    const out = {};
    for (const ev of ordered) {
      if (ev.schemaVersion !== LEARN.SCHEMA) continue;   // unsupported: kept in raw, excluded here
      if (ev.eventType !== 'answer') continue;
      const it = out[ev.itemId] || (out[ev.itemId] = {
        pronunciation: [], meaning: [], attempts: 0, lastAt: null,
        entry: srs ? srs.entryFor({}, ev.itemId) : null,
      });
      it.attempts += 1;
      it.lastAt = ev.occurredAt;
      const assisted = (ev.support || []).length > 0;
      it.pronunciation.push({ at: ev.occurredAt,
                              ok: ev.ratings.pronunciation === 'yes' && !assisted,
                              assisted });
      it.meaning.push({ at: ev.occurredAt,
                        ok: ev.ratings.meaning === 'yes' && !assisted,
                        assisted });
      // Reuse the golden-tested interval maths rather than inventing a
      // second scheduler. This track is isolated: it never reads or writes
      // Classic's state.
      if (srs) {
        it.entry = srs.grade(it.entry, LEARN.wasClean(ev),
                             new Date(ev.occurredAt));
      }
    }
    return out;
  },

  // Deliberately wordy. A label that omits "you rated" would be a lie, and
  // this is the only place the wording is decided.
  skillLabel(history) {
    const h = history || [];
    if (!h.length) return 'not practised yet';
    const last = h[h.length - 1];
    if (!last.ok) {
      return last.assisted ? 'needed a hint last time' : 'needs review';
    }
    const yes = h.filter(x => x.ok);
    const spread = Date.parse(yes[yes.length - 1].at) - Date.parse(yes[0].at);
    if (yes.length >= 2 && spread >= LEARN.CONFIRM_GAP_H * 3600e3) {
      return 'you rated this right on two different days';
    }
    return 'you rated this right once';
  },

  // Due first, then whatever has gone longest without practice. Items with
  // no history sort ahead of practised ones so the pilot actually starts.
  dueItems(projection, now, cap) {
    const t = (now || new Date()).getTime();
    const scored = LEARN.PILOT.map(id => {
      const st = projection[id];
      if (!st || !st.entry) return { id, rank: 0, key: 0 };
      const due = Date.parse(st.entry.due);
      return { id, rank: due <= t ? 1 : 2, key: due };
    });
    scored.sort((a, b) => (a.rank - b.rank) || (a.key - b.key) ||
                          (a.id < b.id ? -1 : 1));
    return scored.slice(0, cap || LEARN.SESSION_ITEMS).map(s => s.id);
  },

  /* ------------------------------- storage ------------------------------ */
  // localStorage on purpose: it is synchronous, so the record is durable
  // before the screen is allowed to move on. IndexedDB would need an await
  // there and a crash between the two would lose the answer. The log is one
  // key holding [{event, synced}] so an event and its pending flag can
  // never disagree -- two keys could.

  _store: (typeof localStorage !== 'undefined') ? localStorage : null,

  _read() {
    if (!LEARN._store) return [];
    try {
      const raw = LEARN._store.getItem(LEARN.KEY_LOG);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];              // never destroy: an unreadable log is left alone
    }
  },
  _write(rows) {
    LEARN._store.setItem(LEARN.KEY_LOG, JSON.stringify(rows));
  },

  events() { return LEARN._read().map(r => r.event); },
  pending() { return LEARN._read().filter(r => !r.synced).map(r => r.event); },

  // Appends and returns only once the write has happened.
  append(ev) {
    const rows = LEARN._read();
    if (rows.some(r => r.event.eventId === ev.eventId)) return ev;
    rows.push({ event: ev, synced: false });
    LEARN._write(rows);
    return ev;
  },

  markSynced(ids) {
    const acked = new Set(ids || []);
    const rows = LEARN._read();
    let touched = false;
    for (const r of rows) {
      if (!r.synced && acked.has(r.event.eventId)) { r.synced = true; touched = true; }
    }
    if (touched) LEARN._write(rows);
    return rows.filter(r => !r.synced).length;
  },

  deviceId() {
    if (!LEARN._store) return 'unknown-device';
    let d = LEARN._store.getItem(LEARN.KEY_DEVICE);
    if (!d) {
      d = 'dev-' + LEARN.uuid().slice(0, 8);
      LEARN._store.setItem(LEARN.KEY_DEVICE, d);
    }
    return d;
  },

  // Default on: the operator asked for this mode, so hiding it behind a
  // switch they have to find would be perverse. Only an explicit 'off'
  // disables it, and the Classic buttons never move either way.
  enabled() {
    return !LEARN._store || LEARN._store.getItem(LEARN.KEY_FLAG) !== 'off';
  },
  setEnabled(on) {
    if (LEARN._store) {
      LEARN._store.setItem(LEARN.KEY_FLAG, on ? 'on' : 'off');
    }
  },

  // Derived from the event ids themselves, so retrying the same set targets
  // the same path and a partial upload cannot fork into two batches.
  batchId(events) {
    const ids = (events || []).map(e => e.eventId).sort().join('|');
    let h = 5381;
    for (let i = 0; i < ids.length; i++) {
      h = ((h << 5) + h + ids.charCodeAt(i)) | 0;
    }
    return 'b' + (h >>> 0).toString(36) + '-' + (events || []).length;
  },

  // Remote path. One immutable file per device per day per batch; nothing is
  // ever written twice to the same path.
  batchPath(deviceId, occurredAt, batchId) {
    const day = String(occurredAt).slice(0, 10);
    return `learning-v2/events/${deviceId}/${day}/${batchId}.json`;
  },

  // Everything this device knows, for the export button. Takes the Classic
  // values as arguments rather than reading them, so that export can never
  // be the thing that mutates them.
  exportBundle(o) {
    return {
      exportedAt: new Date().toISOString(),
      schemaVersion: LEARN.SCHEMA,
      deviceId: LEARN.deviceId(),
      coverage: o.coverage || 'this device only',
      pilotItems: LEARN.PILOT,
      learnLog: LEARN._read(),
      pendingCount: LEARN.pending().length,
      legacyState: o.legacyState || null,
      legacyPendingReviews: o.legacyPendingReviews || [],
      note: 'Self-rated practice records. Nothing here was machine-graded. ' +
            'Contains no GitHub token and no push credentials.',
    };
  },
};

if (typeof module !== 'undefined') module.exports = LEARN;
