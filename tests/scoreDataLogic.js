/**
 * scoreDataLogic.js
 *
 * Pure score-handling logic extracted from index.html (frontend) and
 * AppScript_Backend.js (backend) so they can be tested without a browser
 * or Google Apps Script runtime.
 *
 * Keep these in sync with the originals.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const CLANS = ["69R", "69S", "69D"];

const EVENT_TYPES = [
  { id: "weekly_chests", name: "Weekly Chests",  fields: [{ key: "points",  label: "Points"  }] },
  { id: "tin_man",       name: "Tin Man",         fields: [{ key: "points",  label: "Points"  }] },
  { id: "ragnarok",      name: "Ragnarök",         fields: [{ key: "points",  label: "Points"  }] },
  { id: "omens",         name: "Omens",            fields: [{ key: "essence", label: "Essence" }, { key: "damage", label: "Damage" }, { key: "chests", label: "Chests" }] },
  { id: "olympus",       name: "Olympus",          fields: [{ key: "score",   label: "Score"   }, { key: "chests", label: "Chests" }] },
];

/** All active score keys used in SCORE_ROW_MAP (armageddon is retired). */
const ACTIVE_SCORE_KEYS = CLANS.flatMap(clan =>
  EVENT_TYPES.map(ev => `${clan}_${ev.id}`)
);

/** Backend mapping of score key → Google Sheet row. */
const SCORE_ROW_MAP = {
  "69R_weekly_chests":  3,
  "69R_tin_man":        4,
  "69R_ragnarok":       5,
  "69R_omens":          7,
  "69R_olympus":        8,
  "69S_weekly_chests":  9,
  "69S_tin_man":        10,
  "69S_ragnarok":       11,
  "69S_omens":          13,
  "69S_olympus":        14,
  "69D_weekly_chests":  15,
  "69D_tin_man":        16,
  "69D_ragnarok":       17,
  "69D_omens":          19,
  "69D_olympus":        20,
};

/** Per-event history limits — must stay in sync with AppScript_Backend.js */
const MAX_HISTORY_BY_EVENT = {
  "weekly_chests": 12,
  "tin_man":       12,
  "ragnarok":      12,
  "omens":          5,
  "olympus":        5,
};

const SHEETS_CELL_CHAR_LIMIT = 50000;
const MAX_PLAYERS_PER_CLAN   = 130; // worst-case clan size

// ─── Backend logic (from AppScript_Backend.js) ────────────────────────────────

/**
 * Prunes a single event's entries to the per-event limit.
 * Handles both the current ARRAY format and the legacy date-keyed OBJECT format.
 * Mirrors AppScript_Backend.js pruneEventDates exactly.
 */
function pruneEventDates(eventData, eventId) {
  const limit = MAX_HISTORY_BY_EVENT[eventId] || 12;

  if (Array.isArray(eventData)) {
    if (eventData.length <= limit) return eventData;
    return eventData.slice()
      .sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0)
      .slice(0, limit);
  }

  // Legacy date-keyed object format
  if (!eventData || typeof eventData !== "object") return eventData;
  const dates = Object.keys(eventData).sort();
  if (dates.length <= limit) return eventData;
  const pruned = {};
  dates.slice(dates.length - limit).forEach(d => { pruned[d] = eventData[d]; });
  return pruned;
}

/**
 * Simulate what writeData does: serialise one score key into its cell JSON.
 * Returns the string that would be written to the Google Sheet cell.
 */
function serializeScoreCell(key, scoreArray) {
  const eventId = key.split("_").slice(1).join("_"); // "69R_weekly_chests" → "weekly_chests"
  const eventData = pruneEventDates(scoreArray || [], eventId);
  return JSON.stringify({ scores: { [key]: eventData } });
}

/**
 * Simulate what readData does: parse a cell value back to a score array for
 * one key.  Returns the raw value (may be array or object depending on pruning).
 */
function deserializeScoreCell(cellJson, key) {
  try {
    const d = JSON.parse(cellJson);
    return (d.scores && d.scores[key]) ? d.scores[key] : null;
  } catch (_) { return null; }
}

// ─── Frontend logic (from index.html — storage.getScores) ────────────────────

/**
 * Normalises raw score data from _appData into the canonical array format.
 * Handles both the array format (new) and legacy date-keyed object format.
 */
function normaliseScores(rawScores) {
  const out = {};
  Object.keys(rawScores).forEach(k => {
    const v = rawScores[k];
    if (Array.isArray(v)) {
      out[k] = v;
    } else if (v && typeof v === "object" && Object.keys(v).length > 0) {
      // Legacy OR corrupted-by-prune: date-keyed object → convert to array
      out[k] = Object.entries(v)
        .map(([date, scores]) => ({ date, scores }))
        .sort((a, b) => new Date(b.date) - new Date(a.date));
    } else {
      out[k] = [];
    }
  });
  return out;
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Build a realistic score entry for the given event type.
 * Uses all required fields with plausible values.
 */
function makeScoreEntry(eventId, date, playerIds) {
  const ev = EVENT_TYPES.find(e => e.id === eventId);
  if (!ev) throw new Error(`Unknown eventId: ${eventId}`);
  const scores = {};
  playerIds.forEach(pid => {
    const entry = {};
    ev.fields.forEach((f, i) => { entry[f.key] = 1000 + i * 100; });
    scores[pid] = entry;
  });
  return { date, scores };
}

/**
 * Build a full realistic score array for one event key with N date entries.
 * Simulates a clan with playerCount active players.
 */
function makeScoreArray(eventId, entryCount, playerCount) {
  const playerIds = Array.from({ length: playerCount }, (_, i) => `player_${i}`);
  return Array.from({ length: entryCount }, (_, i) => {
    const date = new Date(2025, 0, 1 + i * 7).toISOString().slice(0, 10);
    return makeScoreEntry(eventId, date, playerIds);
  });
}

module.exports = {
  CLANS,
  EVENT_TYPES,
  ACTIVE_SCORE_KEYS,
  SCORE_ROW_MAP,
  MAX_HISTORY_BY_EVENT,
  MAX_PLAYERS_PER_CLAN,
  SHEETS_CELL_CHAR_LIMIT,
  pruneEventDates,
  serializeScoreCell,
  deserializeScoreCell,
  normaliseScores,
  makeScoreEntry,
  makeScoreArray,
};
