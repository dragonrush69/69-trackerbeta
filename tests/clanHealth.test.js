/**
 * clanHealth.test.js
 *
 * Tests for clan health and trend logic — the dashboard metrics that show
 * how a clan is performing across events.
 *
 * Covers:
 *   ragStatus         — RAG colour thresholds
 *   getTrend          — up / down / flat / none from score history
 *   getClanHealthMetrics  — participation, pctOfNorm, trend, RAG rating
 *   getPlayerHealthMetrics — per-player metrics, sort order
 *
 * These tests run directly against index.html via htmlLoader — no copied code.
 *
 * Run: cd tests && npm test -- clanHealth
 */

const { loadApp } = require('./htmlLoader');

let sandbox, app;
beforeAll(() => {
  ({ sandbox, app } = loadApp());
});

// Reset _appData before each test so storage functions see fresh data.
beforeEach(() => {
  sandbox.window._appData = {
    players: [],
    scores:  {},
    levelRequests: [],
    rotationLog: [],
    fragmentDistributions: [],
    lastBackup: null,
  };
});

// ─── Shared test fixtures ────────────────────────────────────────────────────

const R_PLAYERS = [
  { id: 'r1', name: 'Alpha',   clan: '69R', active: true  },
  { id: 'r2', name: 'Bravo',   clan: '69R', active: true  },
  { id: 'r3', name: 'Charlie', clan: '69R', active: true  },
  { id: 'r4', name: 'Retired', clan: '69R', active: false }, // inactive — should be excluded
];

const S_PLAYERS = [
  { id: 's1', name: 'Echo',    clan: '69S', active: true },
  { id: 's2', name: 'Foxtrot', clan: '69S', active: true },
];

/** 3 active 69R players, all scored in 3 consecutive weekly entries. */
const PERFECT_SCORES = {
  '69R_weekly_chests': [
    { date: '2026-06-01', scores: { r1: { points: 10000 }, r2: { points: 9000 }, r3: { points: 8000 } } },
    { date: '2026-05-25', scores: { r1: { points: 9500  }, r2: { points: 8500 }, r3: { points: 7500 } } },
    { date: '2026-05-18', scores: { r1: { points: 9000  }, r2: { points: 8000 }, r3: { points: 7000 } } },
  ],
};

/** 1 of 3 players scored — participation should be ≈ 0.333. */
const PARTIAL_SCORES = {
  '69R_weekly_chests': [
    { date: '2026-06-01', scores: { r1: { points: 10000 } } },
    { date: '2026-05-25', scores: { r1: { points:  9000 } } },
    { date: '2026-05-18', scores: { r1: { points:  8000 } } },
  ],
};

/** Scores are higher in the most recent entry → trend = "up". */
const RISING_SCORES = {
  '69R_weekly_chests': [
    { date: '2026-06-01', scores: { r1: { points: 12000 }, r2: { points: 11000 }, r3: { points: 10000 } } }, // most recent
    { date: '2026-05-25', scores: { r1: { points:  6000 }, r2: { points:  5000 }, r3: { points:  4000 } } }, // previous
  ],
};

/** Scores are lower in the most recent entry → trend = "down". */
const FALLING_SCORES = {
  '69R_weekly_chests': [
    { date: '2026-06-01', scores: { r1: { points:  4000 }, r2: { points:  3000 }, r3: { points:  2000 } } },
    { date: '2026-05-25', scores: { r1: { points: 12000 }, r2: { points: 11000 }, r3: { points: 10000 } } },
  ],
};

/** 69R scores much higher than 69S → 69R has high pctOfNorm, 69S has low. */
const MULTI_CLAN_SCORES = {
  '69R_weekly_chests': [
    { date: '2026-06-01', scores: { r1: { points: 20000 }, r2: { points: 20000 }, r3: { points: 20000 } } },
  ],
  '69S_weekly_chests': [
    { date: '2026-06-01', scores: { s1: { points: 2000 }, s2: { points: 2000 } } },
  ],
};

// ─── ragStatus ────────────────────────────────────────────────────────────────

describe('ragStatus', () => {
  test('null → "grey" (no data yet)', () => {
    expect(app.ragStatus(null)).toBe('grey');
  });

  test('undefined → "grey"', () => {
    expect(app.ragStatus(undefined)).toBe('grey');
  });

  test('exactly 0.90 → "green"', () => {
    expect(app.ragStatus(0.90)).toBe('green');
  });

  test('above 0.90 → "green"', () => {
    expect(app.ragStatus(1.0)).toBe('green');
    expect(app.ragStatus(1.5)).toBe('green');
  });

  test('exactly 0.75 → "amber"', () => {
    expect(app.ragStatus(0.75)).toBe('amber');
  });

  test('between 0.75 and 0.90 → "amber"', () => {
    expect(app.ragStatus(0.80)).toBe('amber');
    expect(app.ragStatus(0.89)).toBe('amber');
  });

  test('below 0.75 → "red"', () => {
    expect(app.ragStatus(0.74)).toBe('red');
    expect(app.ragStatus(0.50)).toBe('red');
    expect(app.ragStatus(0.0)).toBe('red');
  });
});

// ─── getTrend ─────────────────────────────────────────────────────────────────
// Takes the array returned by getPlayerEventScores: [{ values: { points: N } }, ...]
// Most recent entry is [0], previous is [1].

describe('getTrend', () => {
  const makeScores = (vals, field = 'points') =>
    vals.map(v => ({ date: '2026-01-01', displayDate: '2026-01-01', values: { [field]: v } }));

  test('empty array → "none"', () => {
    expect(app.getTrend([], 'points')).toBe('none');
  });

  test('single entry → "none" (need at least 2)', () => {
    expect(app.getTrend(makeScores([5000]), 'points')).toBe('none');
  });

  test('current > previous → "up"', () => {
    expect(app.getTrend(makeScores([8000, 5000]), 'points')).toBe('up');
  });

  test('current < previous → "down"', () => {
    expect(app.getTrend(makeScores([5000, 8000]), 'points')).toBe('down');
  });

  test('current === previous → "flat"', () => {
    expect(app.getTrend(makeScores([5000, 5000]), 'points')).toBe('flat');
  });

  test('non-numeric values → "none"', () => {
    const scores = [
      { values: { points: 'N/A' } },
      { values: { points: 5000  } },
    ];
    expect(app.getTrend(scores, 'points')).toBe('none');
  });

  test('works with multi-field events (omens — uses essence key)', () => {
    const scores = makeScores([1200, 900], 'essence');
    expect(app.getTrend(scores, 'essence')).toBe('up');
  });
});

// ─── getClanHealthMetrics ─────────────────────────────────────────────────────

describe('getClanHealthMetrics — edge cases', () => {
  test('clan with no players → returns null', () => {
    sandbox.window._appData.players = [];
    expect(app.getClanHealthMetrics('69R', null)).toBeNull();
  });

  test('clan with only inactive players → returns null', () => {
    sandbox.window._appData.players = [R_PLAYERS[3]]; // active: false
    expect(app.getClanHealthMetrics('69R', null)).toBeNull();
  });

  test('players exist but no scores → participation and pctOfNorm are null', () => {
    sandbox.window._appData.players = R_PLAYERS;
    sandbox.window._appData.scores  = {};
    const m = app.getClanHealthMetrics('69R', null);
    expect(m).not.toBeNull();
    expect(m.participation).toBeNull();
    expect(m.pctOfNorm).toBeNull();
    expect(m.trend).toBe('none');
    expect(m.rag).toBe('grey');
  });

  test('returns playerCount equal to active player count only', () => {
    sandbox.window._appData.players = R_PLAYERS; // 3 active, 1 inactive
    sandbox.window._appData.scores  = PERFECT_SCORES;
    const m = app.getClanHealthMetrics('69R', null);
    expect(m.playerCount).toBe(3);
  });
});

describe('getClanHealthMetrics — participation', () => {
  test('all players scored in all entries → participation = 1.0', () => {
    sandbox.window._appData.players = R_PLAYERS;
    sandbox.window._appData.scores  = PERFECT_SCORES;
    const m = app.getClanHealthMetrics('69R', 'weekly_chests');
    expect(m.participation).toBeCloseTo(1.0, 2);
  });

  test('1 of 3 players scored → participation ≈ 0.333', () => {
    sandbox.window._appData.players = R_PLAYERS;
    sandbox.window._appData.scores  = PARTIAL_SCORES;
    const m = app.getClanHealthMetrics('69R', 'weekly_chests');
    expect(m.participation).toBeCloseTo(1/3, 2);
  });
});

describe('getClanHealthMetrics — trend', () => {
  test('rising scores → trend = "up"', () => {
    sandbox.window._appData.players = R_PLAYERS;
    sandbox.window._appData.scores  = RISING_SCORES;
    const m = app.getClanHealthMetrics('69R', 'weekly_chests');
    expect(m.trend).toBe('up');
  });

  test('falling scores → trend = "down"', () => {
    sandbox.window._appData.players = R_PLAYERS;
    sandbox.window._appData.scores  = FALLING_SCORES;
    const m = app.getClanHealthMetrics('69R', 'weekly_chests');
    expect(m.trend).toBe('down');
  });

  test('only one entry → trend = "none"', () => {
    sandbox.window._appData.players = R_PLAYERS;
    sandbox.window._appData.scores  = {
      '69R_weekly_chests': [
        { date: '2026-06-01', scores: { r1: { points: 10000 }, r2: { points: 9000 }, r3: { points: 8000 } } },
      ],
    };
    const m = app.getClanHealthMetrics('69R', 'weekly_chests');
    expect(m.trend).toBe('none');
  });
});

describe('getClanHealthMetrics — pctOfNorm (cross-clan comparison)', () => {
  test('clan with much higher scores → pctOfNorm > 1 → green', () => {
    sandbox.window._appData.players = [...R_PLAYERS, ...S_PLAYERS];
    sandbox.window._appData.scores  = MULTI_CLAN_SCORES;
    const m = app.getClanHealthMetrics('69R', 'weekly_chests');
    expect(m.pctOfNorm).toBeGreaterThan(1.0);
    expect(m.rag).toBe('green');
  });

  test('clan with much lower scores → pctOfNorm < 0.75 → red', () => {
    sandbox.window._appData.players = [...R_PLAYERS, ...S_PLAYERS];
    sandbox.window._appData.scores  = MULTI_CLAN_SCORES;
    const m = app.getClanHealthMetrics('69S', 'weekly_chests');
    expect(m.pctOfNorm).toBeLessThan(0.75);
    expect(m.rag).toBe('red');
  });
});

describe('getClanHealthMetrics — HEALTH_WINDOW constant', () => {
  test('HEALTH_WINDOW is 3', () => {
    // Regression guard: if HEALTH_WINDOW changes, participation calculations change.
    expect(app.HEALTH_WINDOW).toBe(3);
  });

  test('only the most recent HEALTH_WINDOW entries are used for participation', () => {
    // Add 5 entries. Entries 4 and 5 have no scores — participation should still = 1.0
    // because only the most recent 3 are used.
    sandbox.window._appData.players = R_PLAYERS;
    sandbox.window._appData.scores  = {
      '69R_weekly_chests': [
        { date: '2026-06-15', scores: { r1: { points: 10000 }, r2: { points: 9000 }, r3: { points: 8000 } } },
        { date: '2026-06-08', scores: { r1: { points:  9000 }, r2: { points: 8000 }, r3: { points: 7000 } } },
        { date: '2026-06-01', scores: { r1: { points:  8000 }, r2: { points: 7000 }, r3: { points: 6000 } } },
        { date: '2026-05-25', scores: {} }, // no one scored — but this is entry #4, outside window
        { date: '2026-05-18', scores: {} }, // no one scored — entry #5, outside window
      ],
    };
    const m = app.getClanHealthMetrics('69R', 'weekly_chests');
    expect(m.participation).toBeCloseTo(1.0, 2); // old entries ignored
  });
});

// ─── getPlayerHealthMetrics ───────────────────────────────────────────────────

describe('getPlayerHealthMetrics', () => {
  test('returns one entry per active player', () => {
    sandbox.window._appData.players = R_PLAYERS; // 3 active, 1 inactive
    sandbox.window._appData.scores  = PERFECT_SCORES;
    const metrics = app.getPlayerHealthMetrics('69R', 'weekly_chests');
    expect(metrics).toHaveLength(3);
  });

  test('each entry has player, participation, trend, rag, normPct', () => {
    sandbox.window._appData.players = R_PLAYERS;
    sandbox.window._appData.scores  = PERFECT_SCORES;
    const metrics = app.getPlayerHealthMetrics('69R', 'weekly_chests');
    metrics.forEach(m => {
      expect(m).toHaveProperty('player');
      expect(m).toHaveProperty('participation');
      expect(m).toHaveProperty('trend');
      expect(m).toHaveProperty('rag');
      expect(m).toHaveProperty('normPct');
    });
  });

  test('sorted by normPct descending — highest scorer is first', () => {
    sandbox.window._appData.players = R_PLAYERS;
    sandbox.window._appData.scores  = PERFECT_SCORES;
    // r1 scores 10000 (above avg 9000), r3 scores 8000 (below avg)
    const metrics = app.getPlayerHealthMetrics('69R', 'weekly_chests');
    const normPcts = metrics.map(m => m.normPct ?? -1);
    expect(normPcts[0]).toBeGreaterThanOrEqual(normPcts[1]);
    expect(normPcts[1]).toBeGreaterThanOrEqual(normPcts[2]);
  });

  test('player with no scores has normPct = null and is sorted last', () => {
    sandbox.window._appData.players = R_PLAYERS;
    // Only r1 and r2 have scores; r3 has none
    sandbox.window._appData.scores  = {
      '69R_weekly_chests': [
        { date: '2026-06-01', scores: { r1: { points: 10000 }, r2: { points: 9000 } } },
      ],
    };
    const metrics = app.getPlayerHealthMetrics('69R', 'weekly_chests');
    const r3metric = metrics.find(m => m.player.id === 'r3');
    expect(r3metric.normPct).toBeNull();
    // r3 should be last in the sorted list
    expect(metrics[metrics.length - 1].player.id).toBe('r3');
  });

  test('no scores at all → all players have null normPct', () => {
    sandbox.window._appData.players = R_PLAYERS;
    sandbox.window._appData.scores  = {};
    const metrics = app.getPlayerHealthMetrics('69R', 'weekly_chests');
    metrics.forEach(m => expect(m.normPct).toBeNull());
  });
});
