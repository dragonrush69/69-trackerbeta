// ─── AppScript_Migrate_To_Supabase.js ────────────────────────────────────────
// One-time migration: copies all data from Google Sheets → Supabase.
//
// HOW TO USE:
//   1. Open your Apps Script project (the same one as AppScript_Backend.js).
//   2. Click the "+" next to Files and add a new script file.
//   3. Name it "AppScript_Migrate_To_Supabase" and paste this entire file in.
//   4. Select "migrateToSupabase" from the function dropdown at the top.
//   5. Click Run. Approve permissions if prompted.
//   6. Open View → Logs to see progress and confirm it says "COMPLETE".
//
// Safe to re-run: all writes use upsert (no duplicates created).
// This file can be deleted from Apps Script after the migration is done.

var SUPA_URL = "https://jssybjxthkhrzxbzpslx.supabase.co";
var SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impzc3lianh0aGtocnp4Ynpwc2x4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4Nzk5NTQsImV4cCI6MjEwNTQ1NTk1NH0.d5yGivZXVuiangjMgAHxSu8Qs5i7wW8jn6hSJZdgMD4";

// ── Supabase upsert helper ────────────────────────────────────────────────────
// Sends rows to Supabase in batches of 500.
// onConflict: comma-separated column names for the ON CONFLICT clause.
function supabaseUpsert(table, rows, onConflict) {
  if (!rows || rows.length === 0) {
    Logger.log("migrate [" + table + "]: no rows — skipping");
    return;
  }
  var BATCH = 500;
  for (var i = 0; i < rows.length; i += BATCH) {
    var batch = rows.slice(i, i + BATCH);
    var url   = SUPA_URL + "/rest/v1/" + table;
    if (onConflict) url += "?on_conflict=" + encodeURIComponent(onConflict);
    var resp = UrlFetchApp.fetch(url, {
      method:  "post",
      headers: {
        "apikey":        SUPA_KEY,
        "Authorization": "Bearer " + SUPA_KEY,
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates",
      },
      payload:            JSON.stringify(batch),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    if (code !== 200 && code !== 201) {
      Logger.log("migrate ERROR [" + table + "] batch " + i + ": HTTP " + code + " — " + resp.getContentText().slice(0, 300));
    } else {
      Logger.log("migrate [" + table + "]: rows " + i + "–" + (i + batch.length) + " OK");
    }
  }
}

// ── Converts frontend score entries → Supabase rows ───────────────────────────
// fieldMap: { supabaseColumn: frontendField }
// validIds: object map of valid player IDs (skips orphaned historical player refs)
function scoreEntriesToRows(entries, clan, fieldMap, nowIso, validIds) {
  var rows = [];
  var skipped = 0;
  (entries || []).forEach(function(entry) {
    // Skip rows where weekStart is not a valid YYYY-MM-DD date
    var ws = entry.weekStart || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) { skipped++; return; }
    Object.keys(entry.scores || {}).forEach(function(pid) {
      // Skip score rows referencing players not in the players table
      if (validIds && !validIds[pid]) { skipped++; return; }
      var s   = entry.scores[pid] || {};
      var row = {
        week_start: ws,
        clan:       clan,
        player_id:  pid,
        synced_at:  entry.syncedAt || nowIso,
      };
      Object.keys(fieldMap).forEach(function(dbCol) {
        var val = s[fieldMap[dbCol]];
        row[dbCol] = (val !== undefined && val !== null && val !== "") ? Number(val) : 0;
      });
      rows.push(row);
    });
  });
  if (skipped) Logger.log("migrate: skipped " + skipped + " rows (invalid date or orphaned player_id)");
  return rows;
}

// ── Main migration function ───────────────────────────────────────────────────
function migrateToSupabase() {
  Logger.log("=== migrate: START ===");
  var ss   = SpreadsheetApp.getActiveSpreadsheet();
  var data = readData(ss); // reuses readData() from AppScript_Backend.js
  var nowIso = new Date().toISOString();

  // ── 1. Players ──────────────────────────────────────────────────────────────
  var playerRows = (data.players || []).map(function(p) {
    return {
      id:     p.id,
      name:   p.name,
      clan:   p.clan,
      active: (p.active === true || p.active === "TRUE" || p.active === "true"),
      hero:   p.hero   || null,
      level:  p.level  ? Math.round(Number(p.level))  : null,
      might:  p.might  ? Math.round(Number(p.might))  : null,
      rank_g: p.G      ? Number(p.G)      : null,
      rank_m: p.M      ? Number(p.M)      : null,
      rank_s: p.S      ? Number(p.S)      : null,
      rank_e: p.E      ? Number(p.E)      : null,
      updated_at: nowIso,
    };
  });
  Logger.log("migrate: players=" + playerRows.length);
  supabaseUpsert("players", playerRows, "id");

  // Build set of valid player IDs so score rows referencing deleted players are skipped
  var validPlayerIds = {};
  playerRows.forEach(function(p) { validPlayerIds[p.id] = true; });

  // ── 2. Config (pins, norms, ctSync, ctAliases, ctIgnored, lastBackup) ───────
  var configRows = [];
  ["pins","norms","ctSync","ctAliases","ctIgnored","lastBackup"].forEach(function(key) {
    if (data[key] !== undefined && data[key] !== null) {
      configRows.push({ key: key, value: data[key], updated_at: nowIso });
    }
  });
  Logger.log("migrate: config keys=" + configRows.map(function(r){ return r.key; }).join(", "));
  supabaseUpsert("config", configRows, "key");

  // ── 3. Score tables ─────────────────────────────────────────────────────────
  var CLANS = ["69R", "69S", "69D"];
  CLANS.forEach(function(clan) {
    var scores = data.scores || {};

    var weeklyRows = scoreEntriesToRows(scores[clan + "_weekly_chests"], clan, { points:"points" }, nowIso, validPlayerIds);
    Logger.log("migrate: " + clan + "_weekly_chests=" + weeklyRows.length);
    supabaseUpsert("weekly_chests", weeklyRows, "week_start,clan,player_id");

    var tinManRows = scoreEntriesToRows(scores[clan + "_tin_man"], clan, { points:"points" }, nowIso, validPlayerIds);
    Logger.log("migrate: " + clan + "_tin_man=" + tinManRows.length);
    supabaseUpsert("tin_man", tinManRows, "week_start,clan,player_id");

    var ragnarokRows = scoreEntriesToRows(scores[clan + "_ragnarok"], clan, { points:"points" }, nowIso, validPlayerIds);
    Logger.log("migrate: " + clan + "_ragnarok=" + ragnarokRows.length);
    supabaseUpsert("ragnarok", ragnarokRows, "week_start,clan,player_id");

    var omensRows = scoreEntriesToRows(scores[clan + "_omens"], clan, {
      essence: "essence", damage: "damage", chests: "chests",
    }, nowIso, validPlayerIds);
    Logger.log("migrate: " + clan + "_omens=" + omensRows.length);
    supabaseUpsert("omens", omensRows, "week_start,clan,player_id");

    // Olympus: frontend "chests" → Supabase "total_chests"
    var olympusRows = scoreEntriesToRows(scores[clan + "_olympus"], clan, {
      score: "score", total_chests: "chests",
    }, nowIso, validPlayerIds);
    Logger.log("migrate: " + clan + "_olympus=" + olympusRows.length);
    supabaseUpsert("olympus", olympusRows, "week_start,clan,player_id");

    // EpicChests: frontend "score" → Supabase "total_score"
    var epicRows = scoreEntriesToRows(scores[clan + "_epic_chests"], clan, {
      total_score: "score",
    }, nowIso, validPlayerIds);
    epicRows.forEach(function(r) { r.source = "migration"; });
    Logger.log("migrate: " + clan + "_epic_chests=" + epicRows.length);
    supabaseUpsert("epic_chests", epicRows, "week_start,clan,player_id");
  });

  // ── 4. Level Requests ───────────────────────────────────────────────────────
  var levelReqRows = (data.levelRequests || []).filter(function(r) {
    // Skip rows where player_id references a player not in our migration set
    return !r.playerId || validPlayerIds[r.playerId];
  }).map(function(r) {
    // from_level / to_level stored as NUMERIC in schema — pass raw value
    var fromVal = (r.from !== undefined && r.from !== null && r.from !== "") ? Number(r.from) : null;
    var toVal   = (r.to   !== undefined && r.to   !== null && r.to   !== "") ? Number(r.to)   : null;
    return {
      id:             r.id,
      player_id:      r.playerId    || null,
      player_name:    r.playerName  || "",
      clan:           r.clan,
      level_type:     r.levelType   || null,
      from_level:     (fromVal !== null && !isNaN(fromVal)) ? fromVal : null,
      to_level:       (toVal   !== null && !isNaN(toVal))   ? toVal   : null,
      status:         r.status      || "pending",
      date:           r.date        || null,
      resolved_date:  r.resolvedDate || null,
    };
  });
  Logger.log("migrate: level_requests=" + levelReqRows.length);
  supabaseUpsert("level_requests", levelReqRows, "id");

  // ── 5. Rotation Log ─────────────────────────────────────────────────────────
  var rotLogRows = (data.rotationLog || []).filter(function(r) {
    return !r.playerId || validPlayerIds[r.playerId];
  }).map(function(r) {
    return {
      id:           r.id,
      player_id:    r.playerId   || null,
      player_name:  r.playerName || "",
      from_clan:    r.fromClan,
      to_clan:      r.toClan,
      date:         r.date,
    };
  });
  Logger.log("migrate: rotation_log=" + rotLogRows.length);
  supabaseUpsert("rotation_log", rotLogRows, "id");

  // ── 6. Fragment Distributions ────────────────────────────────────────────────
  var fragRows = (data.fragmentDistributions || []).map(function(r) {
    return {
      id:                r.id,
      clan:              r.clan,
      event_id:          r.eventId,
      date:              r.date             || null,
      score_entry_date:  r.scoreEntryDate   || null,
      total_fragments:   r.totalFragments   ? Number(r.totalFragments) : 0,
      config:            r.config           || null,
      allocations:       r.allocations      || null,
    };
  });
  Logger.log("migrate: fragment_distributions=" + fragRows.length);
  supabaseUpsert("fragment_distributions", fragRows, "id");

  Logger.log("=== migrate: COMPLETE ===");
}
