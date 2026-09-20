/**
 * htmlLoader.js
 *
 * Reads index.html, transforms JSX with Babel, and evaluates the app logic
 * in a sandboxed Node.js VM context.
 *
 * WHY THIS APPROACH:
 *   Tests run against the ACTUAL source in index.html — no copied logic files
 *   to keep in sync.  If a function changes in the HTML, all tests that use it
 *   automatically test the new version.
 *
 * USAGE (in a test file):
 *   const { loadApp } = require('./htmlLoader');
 *
 *   let sandbox, app;
 *   beforeAll(() => ({ sandbox, app } = loadApp()));
 *
 *   beforeEach(() => {
 *     sandbox.window._appData = { players: [...], scores: {...}, ... };
 *   });
 *
 *   test('example', () => {
 *     expect(app.ragStatus(0.9)).toBe('green');
 *   });
 */

const fs    = require('fs');
const path  = require('path');
const vm    = require('vm');
const babel = require('@babel/core');

const HTML_PATH = path.join(__dirname, '..', 'index.html');

// ─── Mock DOM element factory ────────────────────────────────────────────────
function mockElem() {
  const el = {
    style:             {},
    textContent:       '',
    appendChild:       () => {},
    removeChild:       () => {},
    remove:            () => {},
    addEventListener:  () => {},
    removeEventListener: () => {},
    setAttribute:      () => {},
    getAttribute:      () => null,
    classList:         { add: () => {}, remove: () => {}, contains: () => false },
  };
  return el;
}

// ─── Build sandbox with all browser globals stubbed ─────────────────────────
function buildSandbox(initialAppData) {
  return {
    // App state
    window: { _appData: initialAppData ?? null },

    // DOM
    document: {
      createElement:      () => mockElem(),
      body:               { appendChild: () => {}, removeChild: () => {} },
      getElementById:     () => mockElem(),
      querySelector:      () => null,
      querySelectorAll:   () => [],
      addEventListener:   () => {},
      removeEventListener: () => {},
      title: '',
    },

    // Browser storage (all stubs return null/empty)
    sessionStorage: {
      getItem:    () => null,
      setItem:    () => {},
      removeItem: () => {},
    },
    localStorage: {
      getItem:    () => null,
      setItem:    () => {},
      removeItem: () => {},
    },

    // Network (no-op — prevents real HTTP calls during tests)
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),

    // React — stubs that let component DEFINITIONS succeed without rendering
    React: {
      createContext:  (def)  => ({ _default: def }),
      useState:       (init) => [typeof init === 'function' ? init() : init, () => {}],
      useEffect:      () => {},
      useRef:         (init) => ({ current: init ?? null }),
      useContext:     () => null,
      useCallback:    (fn)   => fn,
      useMemo:        (fn, _deps) => (typeof fn === 'function' ? fn() : fn),
      useReducer:     (r, s) => [s, () => {}],
      createElement:  () => ({}),
      cloneElement:   (el)   => el,
      Fragment:       'Fragment',
      Children: {
        map:     () => [],
        forEach: () => {},
        toArray: () => [],
      },
    },

    // ReactDOM — prevents the createRoot().render() call at the bottom of the file
    ReactDOM: {
      createRoot: () => ({ render: () => {} }),
    },

    // Standard JS globals
    console,
    Date, Math, JSON, Array, Object, Number, String, Boolean, Symbol,
    isNaN, isFinite, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent,
    Error, TypeError, RangeError, SyntaxError, Promise,
    Set, Map, WeakMap, WeakSet,
    // setTimeout is a no-op to prevent showSaveToast timers leaking into Jest's open-handle detector
    setTimeout:   () => 0,
    clearTimeout: () => {},
    setInterval:  () => 0,
    clearInterval: () => {},
    Proxy, Reflect,
  };
}

// ─── Transform JSX → plain JS (cached after first run) ───────────────────────
let _transformedCode = null;

function getTransformedCode() {
  if (_transformedCode) return _transformedCode;

  const html      = fs.readFileSync(HTML_PATH, 'utf8');
  const startTag  = '<script type="text/babel">';
  const startIdx  = html.indexOf(startTag) + startTag.length;
  const endIdx    = html.lastIndexOf('</script>');
  const jsxSource = html.slice(startIdx, endIdx);

  const { code } = babel.transform(jsxSource, {
    presets:    [['@babel/preset-react', { runtime: 'classic' }]],
    filename:   'index.html',
    configFile: false,
    babelrc:    false,
  });

  // Export block: assigns all testable identifiers onto `this` (= sandbox).
  // In vm.runInContext, `const foo = …` is scoped to the script but still
  // accessible to code appended in the same script string.
  // `this.foo = foo` makes them accessible as sandbox.__exports.foo outside.
  const exportBlock = `
// ── htmlLoader: expose testable symbols on the sandbox ────────────────────
const __safeGet = (fn) => { try { return fn(); } catch (_) { return undefined; } };
this.__exports = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  resolvePin:              __safeGet(() => resolvePin),
  getActivePins:           __safeGet(() => getActivePins),

  // ── Fuzzy match ───────────────────────────────────────────────────────────
  normalise:               __safeGet(() => normalise),
  levenshtein:             __safeGet(() => levenshtein),
  strSimilarity:           __safeGet(() => strSimilarity),
  fuzzyMatch:              __safeGet(() => fuzzyMatch),

  // ── Trend helpers ─────────────────────────────────────────────────────────
  getPlayerEventScores:    __safeGet(() => getPlayerEventScores),
  getTrend:                __safeGet(() => getTrend),
  formatScore:             __safeGet(() => formatScore),
  abbrev:                  __safeGet(() => abbrev),

  // ── Clan health ───────────────────────────────────────────────────────────
  ragStatus:               __safeGet(() => ragStatus),
  getClanHealthMetrics:    __safeGet(() => getClanHealthMetrics),
  getPlayerHealthMetrics:  __safeGet(() => getPlayerHealthMetrics),
  HEALTH_WINDOW:           __safeGet(() => HEALTH_WINDOW),

  // ── Player insight ────────────────────────────────────────────────────────
  getPlayerRecommendation: __safeGet(() => getPlayerRecommendation),
  getSuggestedInactive:    __safeGet(() => getSuggestedInactive),
  getActionItems:          __safeGet(() => getActionItems),

  // ── Fragment distribution ─────────────────────────────────────────────────
  calcOmensFrags:          __safeGet(() => calcOmensFrags),
  DEFAULT_TIER_VALUES:     __safeGet(() => DEFAULT_TIER_VALUES),

  // ── Storage layer ─────────────────────────────────────────────────────────
  storage:                 __safeGet(() => storage),
  _ensure:                 __safeGet(() => _ensure),

  // ── Constants ─────────────────────────────────────────────────────────────
  EVENT_TYPES:             __safeGet(() => EVENT_TYPES),
  CLANS:                   __safeGet(() => CLANS),
  LEVEL_TYPES:             __safeGet(() => LEVEL_TYPES),
  SAMPLE_DATA:             __safeGet(() => SAMPLE_DATA),

  // ── Helpers ───────────────────────────────────────────────────────────────
  uid:                     __safeGet(() => uid),
  today:                   __safeGet(() => today),
};
`;

  _transformedCode = code + '\n' + exportBlock;
  return _transformedCode;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load and evaluate the app in a fresh sandbox.
 *
 * @param {object|null} initialAppData  Seed for window._appData (default: null)
 * @returns {{ sandbox, app }}
 *   sandbox  — The vm context; set sandbox.window._appData in beforeEach
 *   app      — Exported pure-logic functions from the app
 */
function loadApp(initialAppData = null) {
  const sandbox = buildSandbox(initialAppData);
  vm.createContext(sandbox);
  vm.runInContext(getTransformedCode(), sandbox);
  return { sandbox, app: sandbox.__exports };
}

module.exports = { loadApp };
