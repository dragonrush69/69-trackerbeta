/**
 * mergePlayerLogic.js
 *
 * Pure logic extracted from MergePlayersView in index.html.
 * Keeping this separate means the tests don't need a browser or React.
 *
 * If you change the filtering / merge logic in index.html, update the
 * matching function here so the tests stay in sync.
 */

const EVENT_TYPES = [
  { id: "weekly_chests", name: "Weekly Chests", fields: [{ key: "points" }] },
  { id: "tin_man",       name: "Tin Man",       fields: [{ key: "points" }] },
  { id: "ragnarok",      name: "Ragnarök",       fields: [{ key: "points" }] },
  { id: "omens",         name: "Omens",          fields: [{ key: "essence" }, { key: "damage" }, { key: "chests" }] },
  { id: "olympus",       name: "Olympus",        fields: [{ key: "score" },  { key: "chests" }] },
];

/**
 * Attach _idx to every player so two identically-named/same-id players
 * are always distinguishable by their position in the array.
 */
function buildIndexed(players) {
  return players.map((p, i) => Object.assign({}, p, { _idx: i }));
}

/**
 * Build the PRIMARY picker list.
 * Excludes the currently-selected source entry (by index, not by id).
 */
function buildPList(allIndexed, { sourceIdx = -1, pClan = "", pSearch = "" } = {}) {
  let list = allIndexed.slice();
  if (sourceIdx >= 0)  list = list.filter(p => p._idx !== sourceIdx);
  if (pClan !== "")    list = list.filter(p => p.clan === pClan);
  if (pSearch !== "")  list = list.filter(p => p.name && p.name.toLowerCase().includes(pSearch.toLowerCase()));
  return list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

/**
 * Build the SECONDARY picker list.
 * Excludes the currently-selected primary entry (by index, not by id).
 */
function buildSList(allIndexed, { primaryIdx = -1, sClan = "", sSearch = "" } = {}) {
  let list = allIndexed.slice();
  if (primaryIdx >= 0) list = list.filter(p => p._idx !== primaryIdx);
  if (sClan !== "")    list = list.filter(p => p.clan === sClan);
  if (sSearch !== "")  list = list.filter(p => p.name && p.name.toLowerCase().includes(sSearch.toLowerCase()));
  return list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

/**
 * Returns true when both pickers point at the same array position — prevents
 * merging a player into themselves.
 */
function isSameEntry(primaryIdx, sourceIdx) {
  return primaryIdx >= 0 && sourceIdx >= 0 && primaryIdx === sourceIdx;
}

/**
 * Score merge logic.
 * - If primary and source share the same id the score key is already shared;
 *   skip manipulation to avoid deleting scores.
 * - Otherwise, move source's scores into primary (higher value wins per event),
 *   then remove the source key.
 */
function mergeScores(allScores, primaryId, sourceId) {
  if (primaryId === sourceId) {
    // Same id → scores are already unified under that key; nothing to do.
    return allScores;
  }

  const newScores = {};
  Object.keys(allScores).forEach(key => {
    newScores[key] = allScores[key].map(entry => {
      if (!entry.scores || !entry.scores[sourceId]) return entry;

      const s = Object.assign({}, entry.scores);
      const eventId = key.split("_").slice(1).join("_");
      const ev = EVENT_TYPES.find(e => e.id === eventId);
      const fk = ev && ev.fields[0] ? ev.fields[0].key : "points";

      if (s[primaryId]) {
        // Keep whichever score is higher
        if (Number(s[sourceId][fk] || 0) > Number(s[primaryId][fk] || 0)) {
          s[primaryId] = s[sourceId];
        }
      } else {
        // Primary has no score for this event — take source's
        s[primaryId] = s[sourceId];
      }
      delete s[sourceId];
      return Object.assign({}, entry, { scores: s });
    });
  });
  return newScores;
}

/**
 * Remove the source player by array index (not by id), so a same-id duplicate
 * only loses one record.
 */
function deleteByIndex(players, sourceIdx) {
  return players.filter((_, i) => i !== sourceIdx);
}

module.exports = { buildIndexed, buildPList, buildSList, isSameEntry, mergeScores, deleteByIndex };
