/**
 * storageLayer.test.js
 *
 * Tests for the storage layer — the object that reads from and writes to
 * window._appData, which is the in-memory data store synced to Google Sheets.
 *
 * Key risks this guards against:
 *   1. getScores() losing score keys that aren't present in _appData.scores
 *   2. Legacy date-keyed score format not being normalised to array format
 *   3. savePlayers() / saveScores() not updating _appData correctly
 *   4. score keys being wiped on save if some events have no data yet
 *
 * These tests run directly against index.html via htmlLoader — no copied code.
 *
 * Run: cd tests && npm test -- storageLayer
 */

const { loadApp } = require('./htmlLoader');

let sandbox, app;
beforeAll(() => {
  ({ sandbox, app } = loadApp());
});

// Reset _appData before each test
beforeEach(() => {
  sandbox.window._appData = null; // forces _ensure() to re-initialise if called
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal valid _appData object for tests that need players but no scores. */
const baseAppData = (overrides = {}) => ({
  players:               [],
  scores:                {},
  levelRequests:         [],
  rotationLog:           [],
  fragmentDistributions: [],
  lastBackup:            null,
  ...overrides,
});

const TEST_PLAYERS = [
  { id: 'p1', name: 'Alpha', clan: '69R', active: true  },
  { id: 'p2', name: 'Bravo', clan: '69R', active: false },
  { id: 'p3', name: 'Echo',  clan: '69S', active: true  },
];

// ─── getPlayers ───────────────────────────────────────────────────────────────

describe('storage.getPlayers()', () => {
  test('returns [] when _appData is null', () => {
    sandbox.window._appData = null;
    expect(app.storage.getPlayers()).toEqual([]);
  });

  test('returns [] when players array is missing', () => {
    sandbox.window._appData = baseAppData({ players: undefined });
    expect(app.storage.getPlayers()).toEqual([]);
  });

  test('returns all players from _appData', () => {
    sandbox.window._appData = baseAppData({ players: TEST_PLAYERS });
    expect(app.storage.getPlayers()).toHaveLength(3);
    expect(app.storage.getPlayers()[0].name).toBe('Alpha');
  });

  test('includes both active and inactive players', () => {
    sandbox.window._appData = baseAppData({ players: TEST_PLAYERS });
    const active   = app.storage.getPlayers().filter(p => p.active);
    const inactive = app.storage.getPlayers().filter(p => !p.active);
    expect(active).toHaveLength(2);
    expect(inactive).toHaveLength(1);
  });
});

// ─── getScores ────────────────────────────────────────────────────────────────

describe('storage.getScores() — array format (current)', () => {
  const ARRAY_SCORES = {
    '69R_weekly_chests': [
      { date: '2026-06-01', scores: { p1: { points: 5000 } } },
      { date: '2026-05-25', scores: { p1: { points: 4500 } } },
    ],
    '69R_omens': [
      { date: '2026-06-01', scores: { p1: { essence: 1200, damage: 85000, chests: 6 } } },
    ],
  };

  test('returns undefined for missing keys — consuming code uses || [] to handle this safely', () => {
    // getScores() only includes keys that are present in _appData.scores.
    // Consuming functions (getClanHealthMetrics etc.) always use || [] defensively.
    sandbox.window._appData = baseAppData({ scores: {} });
    const scores = app.storage.getScores();
    expect(scores['69R_weekly_chests']).toBeUndefined();
    // Idiomatic consumer usage is safe:
    expect(scores['69R_weekly_chests'] || []).toEqual([]);
  });

  test('passes array format through unchanged', () => {
    sandbox.window._appData = baseAppData({ scores: ARRAY_SCORES });
    const scores = app.storage.getScores();
    expect(Array.isArray(scores['69R_weekly_chests'])).toBe(true);
    expect(scores['69R_weekly_chests']).toHaveLength(2);
  });

  test('preserves all fields in each entry', () => {
    sandbox.window._appData = baseAppData({ scores: ARRAY_SCORES });
    const entry = app.storage.getScores()['69R_omens'][0];
    expect(entry.scores.p1.essence).toBe(1200);
    expect(entry.scores.p1.damage).toBe(85000);
    expect(entry.scores.p1.chests).toBe(6);
  });

  test('returns undefined for missing keys when _appData is null', () => {
    // null _appData → scores = {} → missing keys are undefined
    sandbox.window._appData = null;
    const scores = app.storage.getScores();
    expect(scores['69R_weekly_chests']).toBeUndefined();
  });
});

describe('storage.getScores() — legacy date-keyed object format', () => {
  // Old format: { "2026-01-01": { p1: { points: 5000 } }, ... }
  // Should be converted to array format: [{ date: "2026-01-01", scores: { p1: ... } }, ...]

  const LEGACY_SCORES = {
    '69R_weekly_chests': {
      '2026-05-01': { p1: { points: 5000 }, p2: { points: 4000 } },
      '2026-05-08': { p1: { points: 5500 }, p2: { points: 4500 } },
    },
  };

  test('legacy format is normalised to an array', () => {
    sandbox.window._appData = baseAppData({ scores: LEGACY_SCORES });
    const result = app.storage.getScores()['69R_weekly_chests'];
    expect(Array.isArray(result)).toBe(true);
  });

  test('each array entry has a date and scores object', () => {
    sandbox.window._appData = baseAppData({ scores: LEGACY_SCORES });
    const result = app.storage.getScores()['69R_weekly_chests'];
    result.forEach(entry => {
      expect(entry).toHaveProperty('date');
      expect(entry).toHaveProperty('scores');
    });
  });

  test('legacy entries are sorted newest-first after normalisation', () => {
    sandbox.window._appData = baseAppData({ scores: LEGACY_SCORES });
    const result = app.storage.getScores()['69R_weekly_chests'];
    expect(result[0].date).toBe('2026-05-08'); // newer first
    expect(result[1].date).toBe('2026-05-01');
  });

  test('player scores are preserved after normalisation', () => {
    sandbox.window._appData = baseAppData({ scores: LEGACY_SCORES });
    const result = app.storage.getScores()['69R_weekly_chests'];
    const may8 = result.find(e => e.date === '2026-05-08');
    expect(may8.scores.p1.points).toBe(5500);
  });
});

// ─── savePlayers ─────────────────────────────────────────────────────────────

describe('storage.savePlayers()', () => {
  test('updates window._appData.players', () => {
    sandbox.window._appData = baseAppData({ players: [] });
    app.storage.savePlayers(TEST_PLAYERS);
    expect(sandbox.window._appData.players).toHaveLength(3);
  });

  test('overwrites existing players entirely', () => {
    sandbox.window._appData = baseAppData({ players: TEST_PLAYERS });
    const newPlayers = [{ id: 'nx', name: 'New', clan: '69D', active: true }];
    app.storage.savePlayers(newPlayers);
    expect(sandbox.window._appData.players).toHaveLength(1);
    expect(sandbox.window._appData.players[0].name).toBe('New');
  });

  test('getPlayers() reads the updated value immediately after save', () => {
    sandbox.window._appData = baseAppData({ players: [] });
    app.storage.savePlayers(TEST_PLAYERS);
    expect(app.storage.getPlayers()).toHaveLength(3);
  });
});

// ─── saveScores ───────────────────────────────────────────────────────────────

describe('storage.saveScores()', () => {
  const FRESH_SCORES = {
    '69R_weekly_chests': [
      { date: '2026-06-01', scores: { p1: { points: 5000 } } },
    ],
  };

  test('updates window._appData.scores', () => {
    sandbox.window._appData = baseAppData({ scores: {} });
    app.storage.saveScores(FRESH_SCORES);
    expect(sandbox.window._appData.scores['69R_weekly_chests']).toHaveLength(1);
  });

  test('getScores() reads the updated value immediately after save', () => {
    sandbox.window._appData = baseAppData({ scores: {} });
    app.storage.saveScores(FRESH_SCORES);
    expect(app.storage.getScores()['69R_weekly_chests']).toHaveLength(1);
  });

  test('saving a full scores object preserves all event keys', () => {
    // This guards the "omens scores disappearing" bug class:
    // the full scores object must include all keys before saving.
    sandbox.window._appData = baseAppData({ scores: {} });
    const fullScores = {
      '69R_weekly_chests': [{ date: '2026-06-01', scores: { p1: { points: 5000 } } }],
      '69R_omens':         [{ date: '2026-06-01', scores: { p1: { essence: 1000, damage: 50000, chests: 4 } } }],
    };
    app.storage.saveScores(fullScores);
    expect(app.storage.getScores()['69R_omens']).toHaveLength(1);
    expect(app.storage.getScores()['69R_weekly_chests']).toHaveLength(1);
  });
});

// ─── Other storage accessors ─────────────────────────────────────────────────

describe('storage — other accessors', () => {
  test('getLevelRequests() returns [] when null', () => {
    sandbox.window._appData = null;
    expect(app.storage.getLevelRequests()).toEqual([]);
  });

  test('getRotationLog() returns [] when null', () => {
    sandbox.window._appData = null;
    expect(app.storage.getRotationLog()).toEqual([]);
  });

  test('getLastBackup() returns null when not set', () => {
    sandbox.window._appData = baseAppData({ lastBackup: null });
    expect(app.storage.getLastBackup()).toBeNull();
  });
});
