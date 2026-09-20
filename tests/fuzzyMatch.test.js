/**
 * fuzzyMatch.test.js
 *
 * Tests for the fuzzy name-matching logic used in the Bulk Paste flow.
 * This is the code that decides whether a pasted player name is:
 *   "exact"      — confident match, auto-assigned
 *   "suggestion" — possible match, officer must accept/reject
 *   "none"       — no match, officer must create or skip
 *
 * Getting this wrong causes duplicate players (if a match is missed and the
 * officer clicks "Create") or wrong attribution (if the wrong player is matched).
 *
 * These tests run directly against index.html via htmlLoader — no copied code.
 *
 * Run: cd tests && npm test -- fuzzyMatch
 */

const { loadApp } = require('./htmlLoader');

let app;
beforeAll(() => {
  ({ app } = loadApp());
});

// ─── normalise ────────────────────────────────────────────────────────────────
// Strips everything except a–z and 0–9, lowercases.
// This is why "War Pig" and "warpig" are treated as the same name.

describe('normalise', () => {
  test('lowercases the input', () => {
    expect(app.normalise('DragonSlayer')).toBe('dragonslayer');
    expect(app.normalise('IRONMAN')).toBe('ironman');
  });

  test('removes spaces', () => {
    expect(app.normalise('War Pig')).toBe('warpig');
    expect(app.normalise('Night Hawk')).toBe('nighthawk');
  });

  test('removes underscores and special chars', () => {
    expect(app.normalise('xX_Dragon_Xx')).toBe('xxdragonxx');
    expect(app.normalise('Iron.Man-69')).toBe('ironman69');
  });

  test('preserves numbers', () => {
    expect(app.normalise('Player123')).toBe('player123');
  });

  test('empty string returns empty string', () => {
    expect(app.normalise('')).toBe('');
  });
});

// ─── levenshtein ──────────────────────────────────────────────────────────────
// Edit distance: minimum single-character edits to transform one string into another.

describe('levenshtein', () => {
  test('identical strings → 0', () => {
    expect(app.levenshtein('warpig', 'warpig')).toBe(0);
  });

  test('empty strings → 0', () => {
    expect(app.levenshtein('', '')).toBe(0);
  });

  test('one string empty → length of other', () => {
    expect(app.levenshtein('abc', '')).toBe(3);
    expect(app.levenshtein('', 'abc')).toBe(3);
  });

  test('one insertion → 1', () => {
    // "warpig" → "warping" is 1 substitution, "warpig" → "war pig" but we normalise first
    // Test with known pair: "cat" → "cats" = 1 insertion
    expect(app.levenshtein('cat', 'cats')).toBe(1);
  });

  test('one deletion → 1', () => {
    expect(app.levenshtein('dragonslayer', 'dragonslaer')).toBe(1);
  });

  test('one substitution → 1', () => {
    expect(app.levenshtein('ironfist', 'ironfest')).toBe(1);
  });

  test('completely different short strings → max length', () => {
    expect(app.levenshtein('abc', 'xyz')).toBe(3);
  });
});

// ─── strSimilarity ────────────────────────────────────────────────────────────
// 0–1 score. Key thresholds used in fuzzyMatch:
//   >= 0.85 → "exact"
//   >= 0.45 → "suggestion"
//   < 0.45  → "none"

describe('strSimilarity', () => {
  test('identical names → 1.0', () => {
    expect(app.strSimilarity('WarPig', 'WarPig')).toBe(1);
  });

  test('same name different case → 1.0 (normalised)', () => {
    expect(app.strSimilarity('warpig', 'WarPig')).toBe(1);
  });

  test('prefix is a substring → 0.9 (includes path)', () => {
    // "dragons" is a prefix of "dragonslayer" — includes() triggers before levenshtein
    expect(app.strSimilarity('dragons', 'dragonslayer')).toBe(0.9);
  });

  test('one typo in a long name → >= 0.85 (counts as exact)', () => {
    // "dragonslayr" vs "dragonslayer" — 1 edit in 12 chars → 1 - 1/12 ≈ 0.917
    expect(app.strSimilarity('DragonSlayr', 'DragonSlayer')).toBeGreaterThanOrEqual(0.85);
  });

  test('two typos in a short name may fall into suggestion range', () => {
    // "Wrpig" vs "WarPig" (normalised): "wrpig" vs "warpig" — edit dist = 1 insert → 1 - 1/6 ≈ 0.833
    // "Warpig" vs "WarBig": 1 substitution in 6 chars → 5/6 ≈ 0.833 — also exact
    // Test a harder case: "WrPig" vs "WarPig" — "wrpig" vs "warpig" — 1 insertion, score ≥ 0.45
    expect(app.strSimilarity('WrPig', 'WarPig')).toBeGreaterThan(0.45);
  });

  test('completely different names → < 0.45 (none)', () => {
    expect(app.strSimilarity('DragonSlayer', 'IronFist')).toBeLessThan(0.45);
  });

  test('empty string → 0', () => {
    expect(app.strSimilarity('', 'DragonSlayer')).toBe(0);
    expect(app.strSimilarity('DragonSlayer', '')).toBe(0);
  });
});

// ─── fuzzyMatch ───────────────────────────────────────────────────────────────
// The main function used in the Bulk Paste flow.

const CLAN_69R = [
  { id: 'r1', name: 'DragonSlayer', clan: '69R', active: true },
  { id: 'r2', name: 'IronFist',     clan: '69R', active: true },
  { id: 'r3', name: 'NightHawk',    clan: '69R', active: true },
  { id: 'r4', name: 'WarPig',       clan: '69R', active: true },
];

describe('fuzzyMatch — exact matches', () => {
  test('identical name → { type: "exact" }', () => {
    const result = app.fuzzyMatch('DragonSlayer', CLAN_69R);
    expect(result.type).toBe('exact');
    expect(result.player.id).toBe('r1');
  });

  test('different case → exact (normalised)', () => {
    expect(app.fuzzyMatch('dragonslayer', CLAN_69R).type).toBe('exact');
    expect(app.fuzzyMatch('IRONMAN', [{ id:'x', name:'IronMan', clan:'69R', active:true }]).type).toBe('exact');
  });

  test('space in pasted name removed → exact (War Pig → warpig)', () => {
    // Key regression guard: "War Pig" should match "WarPig" because normalise removes spaces
    expect(app.fuzzyMatch('War Pig', CLAN_69R).type).toBe('exact');
    expect(app.fuzzyMatch('War Pig', CLAN_69R).player.id).toBe('r4');
  });

  test('underscore in pasted name → exact (Night_Hawk → nighthawk)', () => {
    expect(app.fuzzyMatch('Night_Hawk', CLAN_69R).type).toBe('exact');
    expect(app.fuzzyMatch('Night_Hawk', CLAN_69R).player.id).toBe('r3');
  });

  test('one-character typo in long name → exact (score ≥ 0.85)', () => {
    // "DragonSlayr" is one deletion from "DragonSlayer"
    const result = app.fuzzyMatch('DragonSlayr', CLAN_69R);
    expect(result.type).toBe('exact');
    expect(result.player.id).toBe('r1');
  });

  test('picks the best match when multiple players present', () => {
    const result = app.fuzzyMatch('NightHawk', CLAN_69R);
    expect(result.player.id).toBe('r3');
  });
});

describe('fuzzyMatch — suggestions', () => {
  test('two-character typo in short name → suggestion (not exact, not none)', () => {
    // "WrPg" vs "WarPig": normalised "wrpg" vs "warpig" — edit dist=2, score ≈ 1-2/6 ≈ 0.667
    const result = app.fuzzyMatch('WrPg', CLAN_69R);
    expect(result.type).toBe('suggestion');
  });

  test('suggestion carries the best-matching player', () => {
    const result = app.fuzzyMatch('WrPg', CLAN_69R);
    expect(result.player).toBeDefined();
    expect(result.player.name).toBe('WarPig');
  });

  test('suggestion carries a numeric score', () => {
    const result = app.fuzzyMatch('WrPg', CLAN_69R);
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThanOrEqual(0.45);
    expect(result.score).toBeLessThan(0.85);
  });
});

describe('fuzzyMatch — no match', () => {
  test('completely different name → { type: "none" }', () => {
    expect(app.fuzzyMatch('RandomXYZ999', CLAN_69R).type).toBe('none');
  });

  test('empty players list → { type: "none" }', () => {
    expect(app.fuzzyMatch('DragonSlayer', []).type).toBe('none');
  });

  test('empty name → { type: "none" }', () => {
    expect(app.fuzzyMatch('', CLAN_69R).type).toBe('none');
  });
});

describe('fuzzyMatch — regression guards for bulk paste', () => {
  test('name that caused duplicate bug: same name in list → always exact, never creates duplicate', () => {
    // If fuzzyMatch returns "exact" for an existing name, the BulkPaste flow
    // auto-assigns the score to the existing player without showing a "Create" button.
    // This prevents the duplicate-player bug.
    const players = [{ id: 'wp1', name: 'WarPig', clan: '69R', active: true }];
    expect(app.fuzzyMatch('WarPig', players).type).toBe('exact');
    expect(app.fuzzyMatch('warpig', players).type).toBe('exact');
    expect(app.fuzzyMatch('War Pig', players).type).toBe('exact');
    // All three should resolve to the same player
    expect(app.fuzzyMatch('WarPig', players).player.id).toBe('wp1');
  });

  test('name with trailing/leading whitespace still matches (normalised)', () => {
    const players = [{ id: 'x', name: 'IronFist', clan: '69R', active: true }];
    // normalise('  IronFist  ') strips spaces → 'ironfist' → exact
    expect(app.fuzzyMatch('  IronFist  ', players).type).toBe('exact');
  });
});
