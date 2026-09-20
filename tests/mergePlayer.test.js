/**
 * mergePlayer.test.js
 *
 * Tests for the Merge Players screen in 69 Tracker.
 *
 * Covers the two root-cause bugs that were fixed:
 *   1. Same-ID duplicates (e.g. two "WarPig" records sharing one id string)
 *      caused both rows to highlight on a single click.
 *   2. Filtering by id instead of index removed BOTH duplicate records from
 *      the secondary picker, making it impossible to select the second copy.
 *
 * Run: cd tests && npm install && npm test
 */

const {
  buildIndexed,
  buildPList,
  buildSList,
  isSameEntry,
  mergeScores,
  deleteByIndex,
} = require("./mergePlayerLogic");

// ─── Shared fixtures ──────────────────────────────────────────────────────────

/** Two WarPig records that share the SAME id string (the original bug scenario). */
const SAME_ID_PLAYERS = [
  { id: "warpig", name: "WarPig", clan: "69R", active: true },
  { id: "warpig", name: "WarPig", clan: "69R", active: true },  // duplicate id
  { id: "ironman", name: "IronMan", clan: "69R", active: true },
];

/** Two WarPig records with DIFFERENT ids (created via separate bulk-paste "create" actions). */
const DIFF_ID_PLAYERS = [
  { id: "wp_abc", name: "WarPig", clan: "69R", active: true },
  { id: "wp_xyz", name: "WarPig", clan: "69R", active: true },
  { id: "ironman", name: "IronMan", clan: "69R", active: true },
];

/** Mixed-clan player list for filter tests. */
const MULTI_CLAN_PLAYERS = [
  { id: "p1", name: "Alpha",  clan: "69R", active: true },
  { id: "p2", name: "Bravo",  clan: "69S", active: true },
  { id: "p3", name: "Charlie",clan: "69D", active: true },
  { id: "p4", name: "Delta",  clan: "69R", active: true },
  { id: "p5", name: "Echo",   clan: "69S", active: false },
];

// ─── buildIndexed ─────────────────────────────────────────────────────────────

describe("buildIndexed", () => {
  test("attaches unique _idx to every player regardless of shared ids", () => {
    const indexed = buildIndexed(SAME_ID_PLAYERS);
    const idxValues = indexed.map(p => p._idx);
    expect(idxValues).toEqual([0, 1, 2]);
  });

  test("preserves all original player properties", () => {
    const indexed = buildIndexed(DIFF_ID_PLAYERS);
    expect(indexed[0].name).toBe("WarPig");
    expect(indexed[0].id).toBe("wp_abc");
    expect(indexed[0]._idx).toBe(0);
  });
});

// ─── isSameEntry ──────────────────────────────────────────────────────────────

describe("isSameEntry", () => {
  test("returns true when both pickers point at the same index", () => {
    expect(isSameEntry(2, 2)).toBe(true);
  });

  test("returns false when indices differ (even if players share the same id)", () => {
    // This is the core fix — two WarPigs at index 0 and 1 are NOT the same entry
    expect(isSameEntry(0, 1)).toBe(false);
  });

  test("returns false when neither picker has a selection (-1)", () => {
    expect(isSameEntry(-1, -1)).toBe(false);
  });

  test("returns false when only one picker is set", () => {
    expect(isSameEntry(0, -1)).toBe(false);
    expect(isSameEntry(-1, 3)).toBe(false);
  });
});

// ─── buildPList (primary picker) ──────────────────────────────────────────────

describe("buildPList — same-id duplicate scenario (WarPig bug)", () => {
  const indexed = buildIndexed(SAME_ID_PLAYERS);

  test("shows both WarPig entries when nothing is selected yet", () => {
    const list = buildPList(indexed);
    const names = list.map(p => p.name);
    expect(names.filter(n => n === "WarPig")).toHaveLength(2);
  });

  test("hides the source entry by INDEX, not by id — leaves the other WarPig visible", () => {
    // sourceIdx = 1 (second WarPig). Primary list must still show first WarPig (idx 0).
    const list = buildPList(indexed, { sourceIdx: 1 });
    const idxValues = list.map(p => p._idx);
    expect(idxValues).toContain(0);   // first WarPig still present
    expect(idxValues).not.toContain(1); // second WarPig excluded
  });

  test("OLD bug: filtering by id would have removed BOTH WarPigs", () => {
    // This demonstrates what the bug was — if you filtered by id you'd remove all
    // players with id "warpig", leaving an empty list.
    const buggyFilter = indexed.filter(p => p.id !== "warpig");
    expect(buggyFilter.filter(p => p.name === "WarPig")).toHaveLength(0); // both gone!

    // The fixed filter by index leaves one behind:
    const fixedFilter = indexed.filter(p => p._idx !== 1);
    expect(fixedFilter.filter(p => p.name === "WarPig")).toHaveLength(1); // exactly one remains
  });
});

describe("buildPList — different-id duplicate scenario", () => {
  const indexed = buildIndexed(DIFF_ID_PLAYERS);

  test("hides source entry; leaves the other same-named player selectable", () => {
    const list = buildPList(indexed, { sourceIdx: 1 });
    const idxValues = list.map(p => p._idx);
    expect(idxValues).toContain(0);
    expect(idxValues).not.toContain(1);
  });
});

describe("buildPList — clan filter", () => {
  const indexed = buildIndexed(MULTI_CLAN_PLAYERS);

  test("returns only players from the selected clan", () => {
    const list = buildPList(indexed, { pClan: "69R" });
    expect(list.every(p => p.clan === "69R")).toBe(true);
  });

  test("status count matches the rendered list length", () => {
    const list = buildPList(indexed, { pClan: "69S" });
    // 69S players: Bravo (active), Echo (inactive) — both should appear
    expect(list).toHaveLength(2);
  });

  test("returns all clans when pClan is empty string", () => {
    const list = buildPList(indexed);
    expect(list).toHaveLength(MULTI_CLAN_PLAYERS.length);
  });
});

describe("buildPList — search filter", () => {
  const indexed = buildIndexed(MULTI_CLAN_PLAYERS);

  test("filters by name substring, case-insensitive", () => {
    const list = buildPList(indexed, { pSearch: "alpha" });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Alpha");
  });

  test("returns empty list when no player matches search", () => {
    const list = buildPList(indexed, { pSearch: "zzznomatch" });
    expect(list).toHaveLength(0);
  });

  test("clan filter and search work together", () => {
    const list = buildPList(indexed, { pClan: "69R", pSearch: "al" });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Alpha");
  });

  test("list is sorted alphabetically", () => {
    const list = buildPList(indexed, { pClan: "69R" });
    const names = list.map(p => p.name);
    expect(names).toEqual([...names].sort());
  });
});

// ─── buildSList (secondary picker) ────────────────────────────────────────────

describe("buildSList — same-id duplicate scenario", () => {
  const indexed = buildIndexed(SAME_ID_PLAYERS);

  test("after selecting WarPig[0] as primary, WarPig[1] is still in secondary list", () => {
    const list = buildSList(indexed, { primaryIdx: 0 });
    const idxValues = list.map(p => p._idx);
    expect(idxValues).toContain(1);      // second WarPig still available
    expect(idxValues).not.toContain(0);  // first WarPig excluded (it's primary)
  });

  test("after selecting WarPig[1] as primary, WarPig[0] is still in secondary list", () => {
    const list = buildSList(indexed, { primaryIdx: 1 });
    const idxValues = list.map(p => p._idx);
    expect(idxValues).toContain(0);
    expect(idxValues).not.toContain(1);
  });
});

describe("buildSList — clan and search mirrors primary picker behaviour", () => {
  const indexed = buildIndexed(MULTI_CLAN_PLAYERS);

  test("clan filter restricts secondary list", () => {
    const list = buildSList(indexed, { sClan: "69D" });
    expect(list.every(p => p.clan === "69D")).toBe(true);
    expect(list).toHaveLength(1);
  });

  test("search filter works on secondary list", () => {
    const list = buildSList(indexed, { sSearch: "brav" });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Bravo");
  });
});

// ─── mergeScores ──────────────────────────────────────────────────────────────

describe("mergeScores — same-id players", () => {
  test("returns scores unchanged when primary and source share the same id", () => {
    const scores = {
      "69R_weekly_chests": [
        { date: "2026-01-01", scores: { warpig: { points: 5000 } } },
      ],
    };
    const result = mergeScores(scores, "warpig", "warpig");
    // Must be identical — no mutation, no deletion
    expect(result["69R_weekly_chests"][0].scores).toEqual({ warpig: { points: 5000 } });
  });
});

describe("mergeScores — different-id players", () => {
  const baseScores = {
    "69R_weekly_chests": [
      {
        date: "2026-01-01",
        scores: {
          wp_abc: { points: 2000 },
          wp_xyz: { points: 3500 },  // source has higher score
        },
      },
      {
        date: "2026-01-08",
        scores: {
          wp_abc: { points: 4000 },  // primary has higher score
          wp_xyz: { points: 1000 },
        },
      },
      {
        date: "2026-01-15",
        scores: {
          wp_xyz: { points: 800 },   // only source has a score
        },
      },
    ],
  };

  test("source score replaces primary when source is higher", () => {
    const result = mergeScores(baseScores, "wp_abc", "wp_xyz");
    expect(result["69R_weekly_chests"][0].scores["wp_abc"].points).toBe(3500);
  });

  test("primary score is kept when primary is higher", () => {
    const result = mergeScores(baseScores, "wp_abc", "wp_xyz");
    expect(result["69R_weekly_chests"][1].scores["wp_abc"].points).toBe(4000);
  });

  test("source score is adopted when primary has no entry for that event date", () => {
    const result = mergeScores(baseScores, "wp_abc", "wp_xyz");
    expect(result["69R_weekly_chests"][2].scores["wp_abc"].points).toBe(800);
  });

  test("source id is removed from all score entries after merge", () => {
    const result = mergeScores(baseScores, "wp_abc", "wp_xyz");
    result["69R_weekly_chests"].forEach(entry => {
      expect(entry.scores).not.toHaveProperty("wp_xyz");
    });
  });

  test("entries with no source score are passed through untouched", () => {
    const scores = {
      "69R_weekly_chests": [
        { date: "2026-02-01", scores: { someone_else: { points: 999 } } },
      ],
    };
    const result = mergeScores(scores, "wp_abc", "wp_xyz");
    expect(result["69R_weekly_chests"][0].scores).toEqual({ someone_else: { points: 999 } });
  });
});

// ─── deleteByIndex ────────────────────────────────────────────────────────────

describe("deleteByIndex", () => {
  test("removes exactly one record at the given index", () => {
    const players = [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Bravo" },
      { id: "c", name: "Charlie" },
    ];
    const result = deleteByIndex(players, 1);
    expect(result).toHaveLength(2);
    expect(result.map(p => p.name)).toEqual(["Alpha", "Charlie"]);
  });

  test("removes only ONE record even when two entries share the same id (same-id bug)", () => {
    const players = [
      { id: "warpig", name: "WarPig" },   // idx 0
      { id: "warpig", name: "WarPig" },   // idx 1 — the duplicate to delete
      { id: "ironman", name: "IronMan" },
    ];
    const result = deleteByIndex(players, 1);
    expect(result).toHaveLength(2);
    // One WarPig remains (the one at idx 0), and IronMan is untouched
    expect(result[0].name).toBe("WarPig");
    expect(result[1].name).toBe("IronMan");
  });

  test("OLD bug: filtering by id would remove ALL records with that id", () => {
    const players = [
      { id: "warpig", name: "WarPig" },
      { id: "warpig", name: "WarPig" },
      { id: "ironman", name: "IronMan" },
    ];
    // Demonstrate the old behaviour
    const buggyDelete = players.filter(p => p.id !== "warpig");
    expect(buggyDelete).toHaveLength(1); // both WarPigs gone!

    // The fixed behaviour
    const fixedDelete = deleteByIndex(players, 1);
    expect(fixedDelete.filter(p => p.name === "WarPig")).toHaveLength(1); // one remains
  });

  test("removing the first index shifts remaining players but preserves their data", () => {
    const players = [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Bravo" },
    ];
    const result = deleteByIndex(players, 0);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Bravo");
  });
});

// ─── End-to-end merge flow ────────────────────────────────────────────────────

describe("Full merge flow — same-id WarPig scenario", () => {
  const players = [
    { id: "warpig", name: "WarPig", clan: "69R", active: true },  // idx 0 — keep
    { id: "warpig", name: "WarPig", clan: "69R", active: true },  // idx 1 — delete
    { id: "ironman", name: "IronMan", clan: "69R", active: true },
  ];
  const indexed = buildIndexed(players);
  const primaryIdx = 0;
  const sourceIdx  = 1;

  test("isSameEntry is false — different positions, same id", () => {
    expect(isSameEntry(primaryIdx, sourceIdx)).toBe(false);
  });

  test("pList shows only one WarPig (the source at idx 1 is excluded)", () => {
    const list = buildPList(indexed, { sourceIdx, pClan: "69R" });
    expect(list.filter(p => p.name === "WarPig")).toHaveLength(1);
    expect(list.find(p => p.name === "WarPig")._idx).toBe(0);
  });

  test("sList shows only one WarPig (the primary at idx 0 is excluded)", () => {
    const list = buildSList(indexed, { primaryIdx, sClan: "69R" });
    expect(list.filter(p => p.name === "WarPig")).toHaveLength(1);
    expect(list.find(p => p.name === "WarPig")._idx).toBe(1);
  });

  test("scores are not mutated when ids are identical", () => {
    const scores = {
      "69R_tin_man": [{ date: "2026-05-01", scores: { warpig: { points: 1200 } } }],
    };
    const merged = mergeScores(scores, players[primaryIdx].id, players[sourceIdx].id);
    expect(merged["69R_tin_man"][0].scores).toEqual({ warpig: { points: 1200 } });
  });

  test("deleteByIndex removes only the source record, leaving primary intact", () => {
    const result = deleteByIndex(players, sourceIdx);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("WarPig");   // primary WarPig still exists
    expect(result[1].name).toBe("IronMan");
  });
});
