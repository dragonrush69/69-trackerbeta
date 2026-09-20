// ─── 69 Tracker — Stack Calculator Apps Script ────────────────────────────────
// Deploy this as a Web App on your STACKING CALCULATOR spreadsheet
// (NOT the main 69 Tracker data spreadsheet — this is a separate deployment).
//
// Steps:
//   1. Open your stacking calculator Google Sheet
//   2. Extensions → Apps Script
//   3. Paste this entire file (replace any existing code)
//   4. Click Deploy → New Deployment
//      - Type: Web App
//      - Execute as: Me
//      - Who has access: Anyone
//   5. Copy the Web App URL and paste it into the STACK_URL constant in index.html
//
// Input cells (Input Sheet):
//   B4  → Leadership
//   B5  → Authority
//   B6  → Dominance
//   B9  → E9 (true/false)   B10 → G9   B11 → S9
//   B12 → E8                B13 → G8   B14 → S8
//   B15 → E7                B16 → G7   B17 → S7
//   B18 → E6                B19 → G6   B20 → S6
//   B21 → M9                B22 → M8   B23 → M7   B24 → M6
//
// Output columns (Input Sheet, rows 3+):
//   E-F = Mercs (name, qty)
//   H-I = Monsters (name, qty)
//   K-L = Guards/Specialists/Cannons (name, qty)
// ─────────────────────────────────────────────────────────────────────────────

const STACK_INPUT_SHEET = "Input Sheet";

// Tier order matches B8:B23 exactly
const TIER_ORDER = ["E9","G9","S9","E8","G8","S8","E7","G7","S7","E6","G6","S6","M9","M8","M7","M6"];

// ── Accept calculation request ────────────────────────────────────────────────
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000); // Queue requests — wait up to 20 seconds

    const inputs = JSON.parse(e.postData.contents);
    const sheet  = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STACK_INPUT_SHEET);

    if (!sheet) {
      return jsonResponse({ error: 'Sheet "' + STACK_INPUT_SHEET + '" not found.' });
    }

    // Write LAD values to B4:B6
    sheet.getRange("B4:B6").setValues([
      [Number(inputs.leadership) || 0],
      [Number(inputs.authority)  || 0],
      [Number(inputs.dominance)  || 0],
    ]);

    // Write tier checkboxes to B9:B24 (16 rows, in TIER_ORDER sequence)
    const tiers    = inputs.tiers || {};
    const tierVals = TIER_ORDER.map(key => [tiers[key] === true]);
    sheet.getRange("B9:B24").setValues(tierVals);

    // Force recalculation before reading results
    SpreadsheetApp.flush();

    // Read output: E3:L60 (columns E=5 through L=12, starting row 3)
    const raw = sheet.getRange("E3:L60").getValues();

    const mercs    = [];
    const monsters = [];
    const guards   = [];

    raw.forEach(function(row) {
      // Group 1: E (col 0), F (col 1)
      var n1 = row[0], q1 = row[1];
      if (n1 && typeof n1 === "string" && n1.trim() !== "" && Number(q1) > 0) {
        mercs.push({ name: n1.trim(), qty: Math.round(Number(q1)) });
      }
      // Group 2: H (col 3), I (col 4)
      var n2 = row[3], q2 = row[4];
      if (n2 && typeof n2 === "string" && n2.trim() !== "" && Number(q2) > 0) {
        monsters.push({ name: n2.trim(), qty: Math.round(Number(q2)) });
      }
      // Group 3: K (col 6), L (col 7)
      var n3 = row[6], q3 = row[7];
      if (n3 && typeof n3 === "string" && n3.trim() !== "" && Number(q3) > 0) {
        guards.push({ name: n3.trim(), qty: Math.round(Number(q3)) });
      }
    });

    return jsonResponse({ ok: true, stack: { mercs: mercs, monsters: monsters, guards: guards } });

  } catch (err) {
    return jsonResponse({ error: err.message });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// ── Health check ──────────────────────────────────────────────────────────────
function doGet(e) {
  return jsonResponse({ ok: true, service: "69 Tracker Stack Calculator" });
}

// ── Helper ────────────────────────────────────────────────────────────────────
function jsonResponse(obj) {
  var output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}
