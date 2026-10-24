// Listening practice: a sentence is played, you type back the pinyin, and it
// is checked syllable by syllable.
//
// There is no model in the loop. Everything here is rules, which means the
// feedback is instant, identical every time, free, and works with no signal.
// What it can say is narrow but exact: "second syllable — you typed shì, it
// was shí. Right sound, wrong tone: you heard fourth, it was second."
//
// Storage follows the same arrangement as learn.js: its own namespace, its
// own remote folder, and it never touches Classic or recall practice.
'use strict';

const LISTEN = {
  SCHEMA: 1,
  KEY_LOG: 'listen.log.v1',
  KEY_LEVEL: 'listen.level.v1',
  KEY_DEVICE: 'learn.device.v1',     // shared: it identifies the phone, not the mode
  CLASSIC_KEYS: ['cachedCards', 'cachedState', 'pendingReviews', 'ghtok',
                 'pushEnabled', 'learn.log.v1'],

  SESSION_ITEMS: 8,
  // promote after this many clean first attempts in a row at the current level
  PROMOTE_AFTER: 6,
  DEMOTE_AFTER: 4,

  /* ------------------------- reading the input ------------------------- */

  // ā -> a1 and so on. Also folds ü, v and u: together, because a phone
  // keyboard will not give you ü and nobody should have to fight for it.
  TONE_MARKS: {
    'ā': 'a1', 'á': 'a2', 'ǎ': 'a3', 'à': 'a4',
    'ē': 'e1', 'é': 'e2', 'ě': 'e3', 'è': 'e4',
    'ī': 'i1', 'í': 'i2', 'ǐ': 'i3', 'ì': 'i4',
    'ō': 'o1', 'ó': 'o2', 'ǒ': 'o3', 'ò': 'o4',
    'ū': 'u1', 'ú': 'u2', 'ǔ': 'u3', 'ù': 'u4',
    'ǖ': 'v1', 'ǘ': 'v2', 'ǚ': 'v3', 'ǜ': 'v4', 'ü': 'v',
  },

  INITIALS: ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g',
             'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'],
  FINALS: ['iang', 'iong', 'uang', 'ueng', 'ang', 'eng', 'ing', 'ong', 'uai',
           'uan', 'ian', 'iao', 'van', 'ai', 'ei', 'ao', 'ou', 'an', 'en',
           'er', 'ia', 'ie', 'iu', 'in', 'ua', 'uo', 'ui', 'un', 'ue', 've',
           'vn', 'a', 'o', 'e', 'i', 'u', 'v'],

  _syllableSet: null,
  syllableSet() {
    if (LISTEN._syllableSet) return LISTEN._syllableSet;
    const s = new Set(LISTEN.FINALS);
    for (const f of LISTEN.FINALS) {
      for (const i of LISTEN.INITIALS) s.add(i + f);
    }
    LISTEN._syllableSet = s;
    return s;
  },

  // Anything the learner might reasonably type becomes one canonical form:
  // lowercase, numbered tones, v for ü, single spaces.
  normalise(input) {
    let out = '';
    for (const ch of String(input)) {
      const mapped = LISTEN.TONE_MARKS[ch] || LISTEN.TONE_MARKS[ch.toLowerCase()];
      out += mapped !== undefined ? mapped : ch.toLowerCase();
    }
    out = out.replace(/u:/g, 'v').replace(/ü/g, 'v');
    out = out.replace(/[^a-z0-9 ']/g, ' ').replace(/'/g, ' ');
    return out.replace(/\s+/g, ' ').trim();
  },

  // A tone digit can land anywhere inside a syllable, because converting a
  // mark puts the digit where the marked VOWEL was: chènshān becomes
  // che4nshan1, not chen4shan1. So digits are lifted out, the bare letters
  // are split, and each digit is handed back to the syllable it sat inside.
  parse(input) {
    const text = LISTEN.normalise(input);
    if (!text) return [];
    const set = LISTEN.syllableSet();
    const out = [];
    for (const word of text.split(' ')) {
      let letters = '';
      const tones = {};                 // index in `letters` -> tone digit
      for (const ch of word) {
        if (ch >= '0' && ch <= '5') tones[letters.length - 1] = ch;
        else letters += ch;
      }
      let i = 0;
      while (i < letters.length) {
        let matched = false;
        for (let len = Math.min(6, letters.length - i); len > 0; len--) {
          const piece = letters.slice(i, i + len);
          const erhua = piece.endsWith('r') && piece !== 'er' &&
                        set.has(piece.slice(0, -1));
          if (!set.has(piece) && !erhua) continue;
          let tone = '';
          for (let off = 0; off < len; off++) {
            if (tones[i + off] !== undefined) tone = tones[i + off];
          }
          out.push({ base: piece, tone });
          i += len;
          matched = true;
          break;
        }
        if (!matched) {
          out.push({ base: letters.slice(i), tone: '', bad: true });
          break;
        }
      }
    }
    return out;
  },

  // A target syllable is written the canonical way: base + tone digit, with
  // 5 or 0 for neutral.
  splitTarget(syl) {
    const m = String(syl).match(/^([a-z]+?)([0-5])?$/);
    if (!m) return { base: String(syl), tone: '' };
    return { base: m[1], tone: m[2] === undefined ? '5' : m[2] };
  },

  ASPIRATED: [['b', 'p'], ['d', 't'], ['g', 'k'], ['j', 'q'],
              ['zh', 'ch'], ['z', 'c']],
  RETROFLEX: [['zh', 'z'], ['ch', 'c'], ['sh', 's']],

  // Split a syllable into its initial and the rest, so an initial error can
  // be told apart from a final error.
  onset(base) {
    for (const i of LISTEN.INITIALS) {
      if (base.startsWith(i)) return [i, base.slice(i.length)];
    }
    return ['', base];
  },

  // What KIND of mistake was this? The whole value of rule-based checking is
  // that it can say which part went wrong rather than just "no".
  classify(want, got) {
    if (!got || got.bad) return 'unparseable';
    const w = LISTEN.splitTarget(want);
    const g = { base: got.base, tone: got.tone };
    const neutral = w.tone === '5';
    if (w.base === g.base) {
      if (g.tone === '' ) return neutral ? null : 'missing_tone';
      if (g.tone === w.tone) return null;
      if (neutral && (g.tone === '0' || g.tone === '5')) return null;
      return 'tone';
    }
    const [wi, wf] = LISTEN.onset(w.base);
    const [gi, gf] = LISTEN.onset(g.base);
    if (wf === gf) {
      for (const [a, b] of LISTEN.ASPIRATED) {
        if ((wi === a && gi === b) || (wi === b && gi === a)) return 'aspiration';
      }
      for (const [a, b] of LISTEN.RETROFLEX) {
        if ((wi === a && gi === b) || (wi === b && gi === a)) return 'retroflex';
      }
      return 'initial';
    }
    if (wi === gi) return 'final';
    return 'wrong_syllable';
  },

  /* --------------------------- the verdict ----------------------------- */

  evaluate(input, target) {
    const want = (target.syllables || []).map(String);
    const accepted = target.accepted || [];
    const got = LISTEN.parse(input);

    const run = (expect) => {
      const rows = expect.map((w, i) => {
        const g = got[i];
        const error = LISTEN.classify(w, g);
        return {
          expected: w, got: g ? g.base + g.tone : null,
          ok: error === null, error,
        };
      });
      const extra = got.length > expect.length;
      return { rows, extra,
               correct: !extra && rows.every(r => r.ok) };
    };

    let best = run(want);
    for (const alt of accepted) {
      if (best.correct) break;
      const tryAlt = run(alt.map(String));
      if (tryAlt.correct) best = tryAlt;
    }

    const firstBad = best.rows.find(r => !r.ok);
    return {
      correct: best.correct,
      syllables: best.rows,
      tooMany: best.extra,
      tooFew: got.length < want.length,
      errorType: best.correct ? null
                 : (best.extra ? 'too_many'
                    : (got.length < want.length && !firstBad ? 'too_few'
                       : (firstBad ? firstBad.error : 'other'))),
    };
  },

  TONE_NAME: { '1': 'first', '2': 'second', '3': 'third', '4': 'fourth',
               '5': 'neutral', '0': 'neutral', '': 'no tone' },

  // Plain words, because the point of rules over a model is that the message
  // is exact. Never says more than it checked.
  explain(result) {
    if (result.correct) return 'Right.';
    const lines = [];
    result.syllables.forEach((r, i) => {
      if (r.ok) return;
      const n = i + 1;
      const w = LISTEN.splitTarget(r.expected);
      const g = r.got ? LISTEN.splitTarget(r.got) : null;
      const where = `syllable ${n}`;
      if (r.error === 'unparseable' && !r.got) {
        lines.push(`${where}: nothing typed — it was ${r.expected}.`);
      } else if (r.error === 'unparseable') {
        lines.push(`${where}: couldn't read "${r.got}" — it was ${r.expected}.`);
      } else if (r.error === 'missing_tone') {
        lines.push(`${where}: right sound, but no tone. It was ${w.base} in the `
                   + `${LISTEN.TONE_NAME[w.tone]} tone.`);
      } else if (r.error === 'tone') {
        lines.push(`${where}: right sound, wrong tone. You heard `
                   + `${LISTEN.TONE_NAME[g.tone]}, it was `
                   + `${LISTEN.TONE_NAME[w.tone]}.`);
      } else if (r.error === 'aspiration') {
        lines.push(`${where}: ${r.got} against ${r.expected} — that pair differs `
                   + `only by the puff of air.`);
      } else if (r.error === 'retroflex') {
        lines.push(`${where}: ${r.got} against ${r.expected} — tongue curled `
                   + `back or flat.`);
      } else if (r.error === 'initial') {
        lines.push(`${where}: the ending was right, the start was not — `
                   + `${r.got} against ${r.expected}.`);
      } else if (r.error === 'final') {
        lines.push(`${where}: the start was right, the ending was not — `
                   + `${r.got} against ${r.expected}.`);
      } else {
        lines.push(`${where}: ${r.got} — it was ${r.expected}.`);
      }
    });
    if (result.tooMany) lines.push('More syllables typed than were said.');
    if (result.tooFew && !lines.length) lines.push('Fewer syllables than were said.');
    return lines.join(' ');
  },

  /* ------------------------------ storage ------------------------------ */

  _store: (typeof localStorage !== 'undefined') ? localStorage : null,

  _read() {
    if (!LISTEN._store) return [];
    try {
      const raw = LISTEN._store.getItem(LISTEN.KEY_LOG);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  },
  _write(rows) { LISTEN._store.setItem(LISTEN.KEY_LOG, JSON.stringify(rows)); },

  events() { return LISTEN._read().map(r => r.event); },
  pending() { return LISTEN._read().filter(r => !r.synced).map(r => r.event); },

  append(ev) {
    const rows = LISTEN._read();
    if (rows.some(r => r.event.eventId === ev.eventId)) return ev;
    rows.push({ event: ev, synced: false });
    LISTEN._write(rows);
    return ev;
  },

  markSynced(ids) {
    const acked = new Set(ids || []);
    const rows = LISTEN._read();
    let touched = false;
    for (const r of rows) {
      if (!r.synced && acked.has(r.event.eventId)) { r.synced = true; touched = true; }
    }
    if (touched) LISTEN._write(rows);
    return rows.filter(r => !r.synced).length;
  },

  newEvent(o) {
    return {
      schemaVersion: LISTEN.SCHEMA,
      eventId: o.eventId || ((typeof crypto !== 'undefined' && crypto.randomUUID)
                             ? crypto.randomUUID()
                             : 'l-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
      deviceId: o.deviceId,
      sessionId: o.sessionId,
      sentenceId: o.sentenceId,
      level: o.level,
      occurredAt: o.occurredAt,
      eventType: 'answer',
      assessment: 'automatic',       // this one IS measured, unlike recall practice
      presentation: 'typed_pinyin',
      typed: o.typed,
      correct: o.correct,
      errorType: o.errorType || null,
      perSyllable: o.perSyllable || [],
      replays: o.replays || 0,
      revealed: !!o.revealed,
      firstAttempt: o.firstAttempt !== false,
    };
  },

  // Level is held locally and moves on a run of clean FIRST attempts, so
  // replaying or revealing never promotes you.
  level() {
    const v = LISTEN._store && LISTEN._store.getItem(LISTEN.KEY_LEVEL);
    const n = parseInt(v, 10);
    return (n >= 1 && n <= 6) ? n : 1;
  },
  setLevel(n) {
    if (LISTEN._store) {
      LISTEN._store.setItem(LISTEN.KEY_LEVEL, String(Math.max(1, Math.min(6, n))));
    }
  },

  // Walk this level's recent history and decide whether to move.
  reconsiderLevel() {
    const lv = LISTEN.level();
    const here = LISTEN.events().filter(e => e.level === lv && e.firstAttempt);
    const tail = here.slice(-Math.max(LISTEN.PROMOTE_AFTER, LISTEN.DEMOTE_AFTER));
    const clean = e => e.correct && !e.revealed && (e.replays || 0) <= 1;
    const last = n => tail.slice(-n);
    if (here.length >= LISTEN.PROMOTE_AFTER &&
        last(LISTEN.PROMOTE_AFTER).length === LISTEN.PROMOTE_AFTER &&
        last(LISTEN.PROMOTE_AFTER).every(clean) && lv < 6) {
      LISTEN.setLevel(lv + 1);
      return lv + 1;
    }
    if (here.length >= LISTEN.DEMOTE_AFTER &&
        last(LISTEN.DEMOTE_AFTER).every(e => !e.correct) && lv > 1) {
      LISTEN.setLevel(lv - 1);
      return lv - 1;
    }
    return lv;
  },

  batchPath(deviceId, occurredAt, batchId) {
    const day = String(occurredAt).slice(0, 10);
    return `listening-v1/events/${deviceId}/${day}/${batchId}.json`;
  },

  batchId(events) {
    const ids = (events || []).map(e => e.eventId).sort().join('|');
    let h = 5381;
    for (let i = 0; i < ids.length; i++) h = ((h << 5) + h + ids.charCodeAt(i)) | 0;
    return 'b' + (h >>> 0).toString(36) + '-' + (events || []).length;
  },
};

if (typeof module !== 'undefined') module.exports = LISTEN;
