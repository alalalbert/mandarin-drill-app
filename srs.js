// SM-2 scheduling + queue building for the phone, ported line-for-line from
// drill.py. The Python file remains the reference implementation; the golden
// test asserts this port grades identically (`node test-srs.js`, vectors
// from gen-golden.py; CI runs both). If you change one, change both,
// regenerate the vectors, and re-run the test.
'use strict';

const SRS = {
  LEARNING_STEPS_MIN: [10, 30, 120],
  GRADUATED_MIN: 24 * 60,
  EASE_START: 2.5,
  EASE_FLOOR: 1.3,
  EASE_PENALTY: 0.2,
  MAX_INTERVAL_MIN: 180 * 24 * 60,
  SESSION_CAP: 20,
  SIBLING_MIN_GAP: 6,
  NEW_PER_SESSION: 12,
  NEW_RESERVED: 6,
  MIN_SESSION: 5,
  ORDER_SLACK: 5,

  // Mirrors drill.py: quarantined cats never surface on their own -- not in
  // due sessions, not in the due count. Only via an explicit mode choice.
  QUARANTINED_CATS: new Set(['phrases']),

  // Local-time ISO without milliseconds, matching Python's isoformat --
  // the two sides must produce comparable strings.
  iso(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  },

  entryFor(state, id) {
    return state[id] || { due: '1970-01-01T00:00:00', step: 0, interval_min: 0,
                          ease: SRS.EASE_START, reps: 0, lapses: 0 };
  },

  grade(entry, correct, now) {
    const e = Object.assign({}, entry);
    let wait;
    if (correct) {
      e.reps += 1;
      if (e.step < SRS.LEARNING_STEPS_MIN.length) {
        wait = SRS.LEARNING_STEPS_MIN[e.step];
        e.step += 1;
      } else if (e.interval_min < SRS.GRADUATED_MIN) {
        wait = SRS.GRADUATED_MIN;
      } else {
        wait = Math.floor(e.interval_min * e.ease);
      }
      e.interval_min = Math.min(wait, SRS.MAX_INTERVAL_MIN);
    } else {
      e.lapses += 1;
      // no rounding: Python keeps the raw float and IEEE 754 doubles are
      // identical across the two languages, so the ports stay bit-equal
      e.ease = Math.max(SRS.EASE_FLOOR, e.ease - SRS.EASE_PENALTY);
      wait = SRS.LEARNING_STEPS_MIN[0];
      e.step = 1;
      e.interval_min = wait;
    }
    e.due = SRS.iso(new Date(now.getTime() + wait * 60000));
    return e;
  },

  // Answers on two devices can arrive in any order; every answer increments
  // reps or lapses, so the entry with the larger total has seen more history
  // and wins. Ties (same count) break toward the later due date.
  mergeEntry(a, b) {
    if (!a) return b;
    if (!b) return a;
    const ca = a.reps + a.lapses, cb = b.reps + b.lapses;
    if (ca !== cb) return ca > cb ? a : b;
    return a.due >= b.due ? a : b;
  },

  mergeState(local, remote) {
    const out = {};
    const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
    for (const k of keys) out[k] = SRS.mergeEntry(local[k], remote[k]);
    return out;
  },

  baseOf(id) { return id.slice(0, id.lastIndexOf(':')); },

  // Cards tagged deliver:"table" are a paradigm the grid and the matching
  // round teach as a system. They keep their schedule and their history --
  // they are just never handed out as isolated multiple-choice.
  drillable(cards) { return cards.filter(c => c.deliver !== 'table'); },

  preferredDir(base) {
    let s = 0;
    for (const ch of base) s += ch.codePointAt(0);
    return s % 2 ? 'en2zh' : 'zh2en';
  },

  dueCards(cards, state, now, includeQuarantined) {
    const nowIso = SRS.iso(now);
    const out = [];
    for (const c of SRS.drillable(cards)) {
      if (!includeQuarantined && SRS.QUARANTINED_CATS.has(c.cat)) continue;
      const e = SRS.entryFor(state, c.id);
      if (e.due <= nowIso) out.push([c, e]);
    }
    out.sort((x, y) => {
      const nx = x[1].reps === 0 ? 1 : 0, ny = y[1].reps === 0 ? 1 : 0;
      if (nx !== ny) return nx - ny;
      return x[1].due < y[1].due ? -1 : x[1].due > y[1].due ? 1 : 0;
    });
    return out;
  },

  penalty(cand, out, gap) {
    const card = cand[0];
    let p = 0;
    const b = SRS.baseOf(card.id);
    const recent = out.slice(-gap);
    for (let i = 0; i < recent.length; i++) {
      const prev = recent[recent.length - 1 - i];
      if (SRS.baseOf(prev[0].id) === b) p += 100 * (gap - i);
    }
    if (out.length) {
      const last = out[out.length - 1][0];
      if (last.dir === card.dir) p += 4;
      if (last.cat === card.cat) p += 1;
      if ((last.lesson || '') === (card.lesson || '')) p += 1;
    }
    if (out.length >= 2 &&
        out[out.length - 1][0].dir === card.dir &&
        out[out.length - 2][0].dir === card.dir) p += 8;
    return p;
  },

  orderQueue(pairs, cap, gap, newCap) {
    cap = cap || SRS.SESSION_CAP;
    gap = gap || SRS.SIBLING_MIN_GAP;
    if (!pairs.length) return [];

    const arrange = tier => {
      const order = [], byBase = {};
      for (const [card, entry] of tier) {
        const b = SRS.baseOf(card.id);
        if (!byBase[b]) { byBase[b] = []; order.push(b); }
        byBase[b].push([card, entry]);
      }
      const primary = [], held = [], used = { zh2en: 0, en2zh: 0, zh2py: 0 };
      for (const b of order) {
        const options = byBase[b];
        let pick = options[0];
        if (options.length > 1) {
          const pref = SRS.preferredDir(b);
          pick = options.slice().sort((x, y) =>
            (used[x[0].dir] - used[y[0].dir]) ||
            ((x[0].dir === pref ? 0 : 1) - (y[0].dir === pref ? 0 : 1)))[0];
        }
        primary.push(pick);
        used[pick[0].dir] = (used[pick[0].dir] || 0) + 1;
        for (const ce of options) if (ce !== pick) held.push(ce);
      }
      return [primary, held];
    };

    const [seenPrimary, seenHeld] = arrange(pairs.filter(p => p[1].reps > 0));
    let [newPrimary, newHeld] = arrange(pairs.filter(p => p[1].reps === 0));

    const reviewed = new Set(seenPrimary.map(p => SRS.baseOf(p[0].id)));
    newHeld = newHeld.concat(newPrimary.filter(p => reviewed.has(SRS.baseOf(p[0].id))));
    newPrimary = newPrimary.filter(p => !reviewed.has(SRS.baseOf(p[0].id)));

    const limitNew = (newCap === undefined || newCap === null)
        ? SRS.NEW_PER_SESSION : newCap;
    let picked = seenPrimary.slice(0, cap);
    let room = Math.min(cap - picked.length, limitNew);
    if (newPrimary.length && room < Math.min(SRS.NEW_RESERVED, limitNew)) {
      picked = seenPrimary.slice(0, Math.max(0, cap - SRS.NEW_RESERVED));
      room = Math.min(cap - picked.length, limitNew);
    }
    if (room > 0) picked = picked.concat(newPrimary.slice(0, room));
    if (picked.length < SRS.MIN_SESSION) {
      for (const extra of [seenHeld, newHeld]) {
        if (picked.length < cap) {
          picked = picked.concat(extra.slice(0, cap - picked.length));
        }
      }
    }

    const out = [];
    for (const tier of [picked.filter(p => p[1].reps > 0),
                        picked.filter(p => p[1].reps === 0)]) {
      const remaining = tier.slice();
      while (remaining.length) {
        const scored = remaining.map((cand, i) => [SRS.penalty(cand, out, gap), i]);
        const best = Math.min(...scored.map(s => s[0]));
        const near = scored.filter(s => s[0] <= best + SRS.ORDER_SLACK)
                           .map(s => s[1]);
        const pick = near[Math.floor(Math.random() * near.length)];
        out.push(remaining.splice(pick, 1)[0]);
      }
    }
    return out;
  },

  selectQueue(cards, state, mode, now) {
    now = now || new Date();
    cards = SRS.drillable(cards);
    if (mode === 'due') return SRS.orderQueue(SRS.dueCards(cards, state, now));

    let pool;
    if (mode === 'vocab' || mode === 'sentences' || mode === 'numbers' ||
        mode === 'phrases') {
      pool = cards.filter(c => c.cat === mode);
    } else if (mode === 'zh2en' || mode === 'en2zh' || mode === 'zh2py') {
      pool = cards.filter(c => c.dir === mode);
    } else if (mode === 'hardest') {
      pool = cards.slice().sort((a, b) => {
        const ea = SRS.entryFor(state, a.id), eb = SRS.entryFor(state, b.id);
        return (eb.lapses - ea.lapses) || (ea.ease - eb.ease);
      }).filter(c => SRS.entryFor(state, c.id).lapses > 0);
    } else if (mode === 'new') {
      pool = cards.filter(c => SRS.entryFor(state, c.id).reps === 0);
    } else if (mode === 'lesson') {
      const tags = [...new Set(cards.map(c => c.lesson).filter(Boolean))].sort();
      const latest = tags[tags.length - 1];
      pool = latest ? cards.filter(c => c.lesson === latest) : [];
    } else {
      pool = cards.slice();
    }

    if (mode !== 'hardest') {
      const dueIds = new Set(
          SRS.dueCards(cards, state, now, true).map(p => p[0].id));
      const head = pool.filter(c => dueIds.has(c.id));
      const tail = pool.filter(c => !dueIds.has(c.id));
      for (let i = tail.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tail[i], tail[j]] = [tail[j], tail[i]];
      }
      pool = head.concat(tail);
    }
    return SRS.orderQueue(pool.map(c => [c, SRS.entryFor(state, c.id)]),
                          undefined, undefined,
                          mode === 'new' ? SRS.SESSION_CAP : undefined);
  },
};

if (typeof module !== 'undefined') module.exports = SRS;
