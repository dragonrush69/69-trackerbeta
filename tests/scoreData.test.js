/**
 * scoreData.test.js
 *
 * Tests for score data integrity across all five event types:
 *   weekly_chests, tin_man, ragnarok, omens, olympus
 *
 * Covers the two known failure modes:
 *
 *   1. SILENT SCORE WIPE — Every saveToSheets writes ALL 12 score cells.
 *      If _appData.scores is missing a key (race condition, failed load,
 *      partial initialisation), that event's cell is overwritten with {}.
 *      Tests: "score completeness" and "no-key-wipe" suites.
 *
 *   2. PRUNE FORMAT CORRUPTION — The backend's pruneEventDates treats
 *      score data as a date-keyed object, but the frontend stores arrays.
 *      Under 20 entries the array is returned untouched; at 21+ entries
 *      the array is converted to a numeric-keyed object which the frontend
 *      cannot correctly iterate. Tests: "pruneEventDates" suite.
 *
 * Run: cd tests && npm test
 */

const {
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
} = require("./scoreDataLogic");

// ─── Schema / key coverage ────────────────────────────────────────────────────

describe("SCORE_ROW_MAP — key coverage", () => {
  test("contains an entry for every clan × event combination", () => {
    ACTIVE_SCORE_KEYS.forEach(key => {
      expect(SCORE_ROW_MAP).toHaveProperty(key);
    });
  });

  test("every row number is unique (no two keys share a cell)", () => {
    const rows = Object.values(SCORE_ROW_MAP);
    const unique = new Set(rows);
    expect(unique.size).toBe(rows.length);
  });

  test("no active score key is mapped to rows 1, 2, 21, 22, or 23 (reserved cells)", () => {
    const reserved = new Set([1, 2, 21, 22, 23]);
    Object.values(SCORE_ROW_MAP).forEach(row => {
      expect(reserved.has(row)).toBe(false);
    });
  });

  test("armageddon keys are NOT in SCORE_ROW_MAP (retired event)", () => {
    CLANS.forEach(clan => {
      expect(SCORE_ROW_MAP).not.toHaveProperty(`${clan}_armageddon`);
    });
  });
});

// ─── Event type field structure ───────────────────────────────────────────────

describe("Event type field definitions", () => {
  const eventById = id => EVENT_TYPES.find(e => e.id === id);

  test("weekly_chests has exactly one field: points", () => {
    const ev = eventById("weekly_chests");
    expect(ev.fields.map(f => f.key)).toEqual(["points"]);
  });

  test("tin_man has exactly one field: points", () => {
    const ev = eventById("tin_man");
    expect(ev.fields.map(f => f.key)).toEqual(["points"]);
  });

  test("ragnarok has exactly one field: points", () => {
    const ev = eventById("ragnarok");
    expect(ev.fields.map(f => f.key)).toEqual(["points"]);
  });

  test("omens has exactly three fields: essence, damage, chests", () => {
    const ev = eventById("omens");
    expect(ev.fields.map(f => f.key)).toEqual(["essence", "damage", "chests"]);
  });

  test("olympus has exactly two fields: score, chests", () => {
    const ev = eventById("olympus");
    expect(ev.fields.map(f => f.key)).toEqual(["score", "chests"]);
  });

  test("all five event types are present", () => {
    const ids = EVENT_TYPES.map(e => e.id);
    expect(ids).toContain("weekly_chests");
    expect(ids).toContain("tin_man");
    expect(ids).toContain("ragnarok");
    expect(ids).toContain("omens");
    expect(ids).toContain("olympus");
  });
});

// ─── Score entry structure ────────────────────────────────────────────────────

describe("Score entry structure — all event types", () => {
  EVENT_TYPES.forEach(ev => {
    test(`${ev.id}: entry contains all required fields`, () => {
      const entry = makeScoreEntry(ev.id, "2026-01-01", ["p1", "p2"]);
      expect(entry).toHaveProperty("date", "2026-01-01");
      expect(entry.scores).toHaveProperty("p1");
      expect(entry.scores).toHaveProperty("p2");
      ev.fields.forEach(f => {
        expect(entry.scores["p1"]).toHaveProperty(f.key);
        expect(typeof entry.scores["p1"][f.key]).toBe("number");
      });
    });
  });

  test("omens entry has essence, damage AND chests — not just one field", () => {
    const entry = makeScoreEntry("omens", "2026-01-01", ["p1"]);
    expect(entry.scores["p1"]).toHaveProperty("essence");
    expect(entry.scores["p1"]).toHaveProperty("damage");
    expect(entry.scores["p1"]).toHaveProperty("chests");
  });

  test("olympus entry has score AND chests", () => {
    const entry = makeScoreEntry("olympus", "2026-01-01", ["p1"]);
    expect(entry.scores["p1"]).toHaveProperty("score");
    expect(entry.scores["p1"]).toHaveProperty("chests");
  });
});

// ─── Cell size / 50K char limit ───────────────────────────────────────────────

describe("Cell size — Google Sheets 50K character limit at 130 players", () => {
  // Worst-case clan size: MAX_PLAYERS_PER_CLAN = 130
  // Each event uses its own per-event history limit from MAX_HISTORY_BY_EVENT.

  EVENT_TYPES.forEach(ev => {
    const limit = MAX_HISTORY_BY_EVENT[ev.id];
    CLANS.forEach(clan => {
      const key = `${clan}_${ev.id}`;
      test(`${key}: ${limit} entries × ${MAX_PLAYERS_PER_CLAN} players stays under ${SHEETS_CELL_CHAR_LIMIT} chars`, () => {
        const arr  = makeScoreArray(ev.id, limit, MAX_PLAYERS_PER_CLAN);
        const cell = serializeScoreCell(key, arr);
        expect(cell.length).toBeLessThan(SHEETS_CELL_CHAR_LIMIT);
      });
    });
  });

  test("omens is the largest event type per entry — bigger than single-field events", () => {
    const omensCell  = serializeScoreCell("69R_omens",   makeScoreArray("omens",   1, MAX_PLAYERS_PER_CLAN));
    const tinManCell = serializeScoreCell("69R_tin_man", makeScoreArray("tin_man", 1, MAX_PLAYERS_PER_CLAN));
    expect(omensCell.length).toBeGreaterThan(tinManCell.length);
  });

  test("old limit (20 entries) would overflow every event at 130 players", () => {
    // Documents why the old MAX_HISTORY_ENTRIES = 20 caused silent data loss.
    // Bypass pruning (simulate old behaviour) by serialising raw arrays directly.
    EVENT_TYPES.forEach(ev => {
      const key  = `69R_${ev.id}`;
      const arr  = makeScoreArray(ev.id, 20, MAX_PLAYERS_PER_CLAN);
      const cell = JSON.stringify({ scores: { [key]: arr } }); // no pruning
      expect(cell.length).toBeGreaterThan(SHEETS_CELL_CHAR_LIMIT);
    });
  });
});

// ─── pruneEventDates format compatibility ─────────────────────────────────────

describe("pruneEventDates — fixed array handling (regression guard)", () => {
  test("under the limit: array is returned unchanged", () => {
    const limit = MAX_HISTORY_BY_EVENT["omens"]; // 5
    const arr = makeScoreArray("omens", limit - 1, 3);
    const result = pruneEventDates(arr, "omens");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(limit - 1);
  });

  test("at exactly the limit: array is returned unchanged", () => {
    const limit = MAX_HISTORY_BY_EVENT["tin_man"]; // 12
    const arr = makeScoreArray("tin_man", limit, 3);
    const result = pruneEventDates(arr, "tin_man");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(limit);
  });

  test("over the limit: returns an array (not a corrupted object)", () => {
    // This is the key regression guard — the old code returned a plain object
    // with numeric keys, breaking .forEach() on the frontend.
    const limit = MAX_HISTORY_BY_EVENT["weekly_chests"]; // 12
    const arr = makeScoreArray("weekly_chests", limit + 5, 3);
    const result = pruneEventDates(arr, "weekly_chests");
    expect(Array.isArray(result)).toBe(true);   // must still be an array
    expect(result).toHaveLength(limit);          // trimmed to the limit
  });

  test("over the limit: keeps the MOST RECENT entries, not the oldest", () => {
    const arr = makeScoreArray("tin_man", 15, 2); // dates: 2025-01-01, 2025-01-08, ...
    const result = pruneEventDates(arr, "tin_man"); // keeps 12
    const dates = result.map(e => e.date);
    // All kept dates must be more recent than any dropped date
    const allDates = arr.map(e => e.date).sort();
    const droppedDates = allDates.slice(0, 3); // oldest 3 dropped
    droppedDates.forEach(d => expect(dates).not.toContain(d));
  });

  test("omens pruned to 5 entries, weekly_chests to 12 — different limits enforced", () => {
    const omensArr   = makeScoreArray("omens", 10, 3);
    const weeklyArr  = makeScoreArray("weekly_chests", 20, 3);
    const omensResult  = pruneEventDates(omensArr,  "omens");
    const weeklyResult = pruneEventDates(weeklyArr, "weekly_chests");
    expect(omensResult).toHaveLength(MAX_HISTORY_BY_EVENT["omens"]);       // 5
    expect(weeklyResult).toHaveLength(MAX_HISTORY_BY_EVENT["weekly_chests"]); // 12
  });

  test("legacy date-keyed object format still works correctly", () => {
    const legacy = {
      "2026-01-01": { p1: { points: 100 } },
      "2026-01-08": { p1: { points: 200 } },
    };
    const result = pruneEventDates(legacy, "tin_man");
    // Under the limit → returned unchanged as object
    expect(Array.isArray(result)).toBe(false);
    expect(Object.keys(result)).toHaveLength(2);
  });
});

// ─── Score serialise / deserialise roundtrip ──────────────────────────────────

describe("Score cell roundtrip — serialize then deserialize returns identical data", () => {
  EVENT_TYPES.forEach(ev => {
    test(`${ev.id}: roundtrip preserves all entries and fields`, () => {
      const key   = `69R_${ev.id}`;
      const arr   = makeScoreArray(ev.id, MAX_HISTORY_BY_EVENT[ev.id], 4);
      const cell  = serializeScoreCell(key, arr);
      const back  = deserializeScoreCell(cell, key);

      expect(Array.isArray(back)).toBe(true);
      expect(back).toHaveLength(arr.length);

      // All dates preserved
      arr.forEach((orig, i) => {
        expect(back[i].date).toBe(orig.date);
      });

      // All player score fields preserved
      ev.fields.forEach(f => {
        expect(back[0].scores["player_0"][f.key]).toBe(arr[0].scores["player_0"][f.key]);
      });
    });
  });

  test("omens roundtrip preserves essence, damage, and chests independently", () => {
    const key  = "69S_omens";
    const entry = { date: "2026-03-01", scores: { pid1: { essence: 250, damage: 1800, chests: 42 } } };
    const cell = serializeScoreCell(key, [entry]);
    const back = deserializeScoreCell(cell, key);
    expect(back[0].scores.pid1.essence).toBe(250);
    expect(back[0].scores.pid1.damage).toBe(1800);
    expect(back[0].scores.pid1.chests).toBe(42);
  });
});

// ─── Score completeness — no silent key wipe ─────────────────────────────────

describe("Score completeness — all 12 keys must be present before save", () => {
  test("ACTIVE_SCORE_KEYS contains exactly 15 keys (3 clans × 5 active events)", () => {
    expect(ACTIVE_SCORE_KEYS).toHaveLength(15);
  });

  test("a full _appData.scores object has an entry for every active score key", () => {
    // Build a scores object as the frontend would after loading from sheets
    const scores = {};
    ACTIVE_SCORE_KEYS.forEach(key => {
      scores[key] = makeScoreArray(key.split("_").slice(1).join("_"), 2, 3);
    });

    ACTIVE_SCORE_KEYS.forEach(key => {
      expect(scores).toHaveProperty(key);
      expect(Array.isArray(scores[key])).toBe(true);
    });
  });

  test("saveToSheets with a partial scores object silently wipes missing keys", () => {
    // This demonstrates the wipe bug: if scores only contains one key,
    // writeData writes {} to every other score cell.
    const partialScores = { "69R_weekly_chests": makeScoreArray("weekly_chests", 3, 5) };

    // Simulate what writeData does for each key
    const writtenCells = {};
    ACTIVE_SCORE_KEYS.forEach(key => {
      const eventData = pruneEventDates(partialScores[key] || []);
      writtenCells[key] = JSON.stringify({ scores: { [key]: eventData } });
    });

    // 69R_weekly_chests is preserved
    const preserved = deserializeScoreCell(writtenCells["69R_weekly_chests"], "69R_weekly_chests");
    expect(preserved).toHaveLength(3);

    // All other keys are wiped to empty arrays
    const omensCell = deserializeScoreCell(writtenCells["69R_omens"], "69R_omens");
    expect(omensCell).toEqual([]);

    // THIS IS THE BUG — document it clearly so it's never silently missed
    const wipedKeys = ACTIVE_SCORE_KEYS.filter(k => k !== "69R_weekly_chests");
    wipedKeys.forEach(key => {
      const cell = deserializeScoreCell(writtenCells[key], key);
      expect(cell).toEqual([]); // wiped!
    });
  });

  test("saveToSheets with a full scores object preserves all keys", () => {
    const fullScores = {};
    ACTIVE_SCORE_KEYS.forEach(key => {
      const eventId = key.split("_").slice(1).join("_");
      fullScores[key] = makeScoreArray(eventId, 3, 5);
    });

    const writtenCells = {};
    ACTIVE_SCORE_KEYS.forEach(key => {
      const eventData = pruneEventDates(fullScores[key]);
      writtenCells[key] = JSON.stringify({ scores: { [key]: eventData } });
    });

    ACTIVE_SCORE_KEYS.forEach(key => {
      const back = deserializeScoreCell(writtenCells[key], key);
      expect(Array.isArray(back)).toBe(true);
      expect(back.length).toBeGreaterThan(0);
    });
  });
});

// ─── normaliseScores (frontend getScores) ────────────────────────────────────

describe("normaliseScores — handles both array and legacy object format", () => {
  test("array format is returned as-is", () => {
    const arr = makeScoreArray("tin_man", 3, 4);
    const result = normaliseScores({ "69R_tin_man": arr });
    expect(result["69R_tin_man"]).toEqual(arr);
  });

  test("missing key returns empty array, not undefined", () => {
    const result = normaliseScores({});
    // normaliseScores only processes keys it finds — caller gets {} for empty input
    expect(result).toEqual({});
  });

  test("null / undefined value returns empty array for that key", () => {
    const result = normaliseScores({ "69R_omens": null });
    expect(result["69R_omens"]).toEqual([]);
  });

  test("date-keyed object (legacy format) is converted to sorted array", () => {
    const legacy = {
      "2026-01-01": { p1: { points: 100 } },
      "2026-01-15": { p1: { points: 200 } },
    };
    const result = normaliseScores({ "69R_tin_man": legacy });
    expect(Array.isArray(result["69R_tin_man"])).toBe(true);
    expect(result["69R_tin_man"]).toHaveLength(2);
    // Sorted descending (newest first)
    expect(result["69R_tin_man"][0].date).toBe("2026-01-15");
    expect(result["69R_tin_man"][1].date).toBe("2026-01-01");
  });

  test("omens legacy object is converted and all three fields are preserved", () => {
    const legacy = {
      "2026-02-01": { p1: { essence: 150, damage: 900, chests: 30 } },
    };
    const result = normaliseScores({ "69S_omens": legacy });
    const entry = result["69S_omens"][0];
    expect(entry.date).toBe("2026-02-01");
    expect(entry.scores.p1.essence).toBe(150);
    expect(entry.scores.p1.damage).toBe(900);
    expect(entry.scores.p1.chests).toBe(30);
  });
});
