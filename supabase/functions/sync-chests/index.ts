// sync-chests — Supabase Edge Function
// Pulls the most recent 3 weeks of chest scan readings from ChestTracker API.
// Sorts newest-first (desc) — no date filter needed, CT's filter is unreliable.
// Stops when rows older than KEEP_WEEKS are reached, or MAX_PAGES is hit.
//
// Required secrets (set in Supabase Dashboard → Edge Functions → Manage secrets):
//   CT_EMAIL    — ChestTracker login email
//   CT_PASSWORD — ChestTracker login password
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CT_API_BASE   = "https://api.chesttracker.com/v1";
const CLANS_TO_SYNC = ["69R", "69S"];
const PAGE_SIZE     = 500;  // CT supports up to 500 rows per page
const MAX_PAGES     = 20;   // 20 × 500 = 10,000 rows per clan — normal daily sync
const KEEP_WEEKS    = 13;   // keep chests from the last 13 weeks (~3 months) to cover Olympus history

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function getCTToken(
  email: string,
  password: string,
  memberId?: string,
): Promise<string> {
  const body: Record<string, string> = { email, password };
  if (memberId) body.memberId = memberId;
  const res = await fetch(`${CT_API_BASE}/authenticate`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`CT auth failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const token = data.authToken ?? data.token ?? data.accessToken ?? data.access_token ?? data.jwt;
  if (!token) throw new Error(`No token in CT auth response. Keys: ${Object.keys(data).join(", ")}`);
  return token as string;
}

async function ctGet(url: string, token: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`CT GET ${url} failed: ${res.status} ${await res.text()}`);
    return res.json();
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error(`CT GET timed out after 30s: ${url}`);
    throw err;
  }
}

// ── Per-page streaming fetch + upsert ────────────────────────────────────────
// Fetches newest-first. Stops when rows are older than cutoff or MAX_PAGES hit.

async function streamChestsForClan(
  token:          string,
  cutoffIso:      string,
  validPlayerIds: Set<string>,
  clan:           string,
  nowIso:         string,
  db:             any,
  definitionMap:  Map<string, any>,
  maxPagesOverride?: number,
  pageSizeOverride?: number,
  startPageOverride?: number,
  sourcesFilter?: string[],   // if set, only store chests whose source matches one of these substrings
): Promise<{ fetched: number; upserted: number; skipped: number }> {
  const effectiveMaxPages = maxPagesOverride ?? MAX_PAGES;
  const effectivePageSize = pageSizeOverride ?? PAGE_SIZE;
  let fetched  = 0;
  let upserted = 0;
  let skipped  = 0;
  let page = startPageOverride ?? 0;

  while (true) {
    const url =
      `${CT_API_BASE}/chests` +
      `?sort=generatedAt,desc` +
      `&size=${effectivePageSize}` +
      `&page=${page}`;

    if (page === 0) console.log(`  [${clan}] CT URL: ${url}`);
    const raw = await ctGet(url, token);

    const pageRows: any[] = Array.isArray(raw[0]) ? raw[0] : (Array.isArray(raw) ? raw : []);
    fetched += pageRows.length;

    if (page === 0) {
      const firstRow = pageRows[0] ?? null;
      console.log(`  [${clan}] first generatedAt from CT: ${firstRow?.generatedAt ?? "none"}`);
      // Log full structure of first raw CT chest record so we can detect API changes
      if (firstRow) {
        console.log(`  [${clan}] CT chest keys: ${Object.keys(firstRow).join(", ")}`);
        console.log(`  [${clan}] CT chest sample: ${JSON.stringify(firstRow).slice(0, 600)}`);
      }
    }

    const dbRows: any[] = [];
    let hitCutoff = false;

    for (const r of pageRows) {
      if (r.generatedAt && r.generatedAt < cutoffIso) { hitCutoff = true; skipped++; continue; }
      if (!r.id)                                          { skipped++; continue; }
      if (!r.memberId || !validPlayerIds.has(r.memberId)) { skipped++; continue; }

      // Definition lookup (may be empty if CT API no longer returns definitionId)
      const defId = r.definitionId ?? r.typeId ?? r.chestDefinitionId ?? null;
      const def   = definitionMap.get(defId ?? "");

      // New CT API format: chest metadata comes from the reward object, not a definition
      // reward: { guardsLevel: N, <optional bonus>: value, ... }
      const reward      = (r.reward ?? {}) as Record<string, any>;
      const guardsLvl   = reward.guardsLevel != null ? Number(reward.guardsLevel) : null;

      // Extract chest metadata: definition map first, then reward-based inference
      const chestName   = def?.name   ?? r.chestName ?? r.name   ?? (guardsLvl != null ? `Guards Chest L${guardsLvl}` : null);
      const chestSource = def?.source ?? r.chestSource ?? r.source ?? (guardsLvl != null ? "Guards" : null);
      const chestType   = def?.type   ?? r.chestType  ?? r.type   ?? (guardsLvl != null ? "Guards"  : null);
      const chestPoints = def?.points != null ? def.points
                        : (r.points   != null ? r.points
                        : guardsLvl);  // guardsLevel IS the point value in the new CT API

      // If sourcesFilter is active, skip chests whose source doesn't match any substring
      if (sourcesFilter && sourcesFilter.length > 0) {
        if (!chestSource || !sourcesFilter.some(f => chestSource.toLowerCase().includes(f.toLowerCase()))) {
          skipped++;
          continue;
        }
      }

      dbRows.push({
        id:            r.id,
        player_id:     r.memberId,
        clan,
        definition_id: defId,
        color:         r.color         ?? null,
        chest_name:    chestName,
        chest_source:  chestSource,
        chest_type:    chestType,
        quantity:      r.quantity      ?? 1,
        points:        chestPoints,
        generated_at:  r.generatedAt   ?? r.rawTime ?? null,
        reward:        r.reward        ?? null,
        synced_at:     nowIso,
      });
    }

    if (dbRows.length > 0) {
      const { error: upsertErr } = await db.from("chests").upsert(dbRows, { onConflict: "id" });
      if (upsertErr) throw new Error(`[${clan}] upsert error page ${page}: ${upsertErr.message}`);
      upserted += dbRows.length;
    }

    console.log(`  [${clan}][page ${page}]: fetched=${pageRows.length} upserted=${dbRows.length} skipped=${pageRows.length - dbRows.length}`);

    if (pageRows.length < PAGE_SIZE || hitCutoff) break;

    page++;
    if (page >= effectiveMaxPages) {
      console.log(`  [${clan}] hit MAX_PAGES (${effectiveMaxPages})`);
      break;
    }
  }

  return { fetched, upserted, skipped };
}

// chests_weekly and epic_chests are now materialized views refreshed via RPC

// ── Edge Function entry point ─────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  const corsHeaders = {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const email    = Deno.env.get("CT_EMAIL");
    const password = Deno.env.get("CT_PASSWORD");
    if (!email || !password) throw new Error("CT_EMAIL and CT_PASSWORD secrets not set.");

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Backfill mode: POST body options:
    //   { "backfill": true }                          — 13 weeks, up to 2000 pages
    //   { "backfill": true, "weeksBack": 13 }         — explicit weeks
    //   { "backfill": true, "pageSize": 500 }         — larger CT page size (if supported)
    //   { "backfill": true, "startPage": 100 }        — resume from a page offset
    let bodyJson: any = {};
    try { bodyJson = await req.clone().json(); } catch { /* no body */ }
    const isBackfill    = bodyJson?.backfill === true;
    const weeksBack     = bodyJson?.weeksBack  ? Number(bodyJson.weeksBack)  : (isBackfill ? 13 : KEEP_WEEKS);
    const maxPages      = bodyJson?.maxPages   ? Number(bodyJson.maxPages)   : (isBackfill ? 2000 : MAX_PAGES);
    const pageSizeReq   = bodyJson?.pageSize   ? Number(bodyJson.pageSize)   : PAGE_SIZE;
    const startPage     = bodyJson?.startPage  ? Number(bodyJson.startPage)  : 0;
    // sourcesFilter: array of substrings to match against chest_source (backfill only)
    // e.g. ["Olympus","Omens","Dread"] to capture only Olympus and Dark Omens chests
    const sourcesFilter: string[] = Array.isArray(bodyJson?.sourcesFilter) ? bodyJson.sourcesFilter : [];
    // clan: restrict sync to a single clan tag, e.g. "69S" (default: all clans)
    const clansToRun: string[] = bodyJson?.clan ? [bodyJson.clan] : CLANS_TO_SYNC;

    const now       = new Date();
    const nowIso    = now.toISOString();
    const cutoff    = new Date(now.getTime() - weeksBack * 7 * 24 * 3600 * 1000);
    const cutoffIso = cutoff.toISOString();
    console.log(`sync-chests: ${isBackfill ? "BACKFILL MODE" : "normal"} — keeping chests since ${cutoffIso} (maxPages=${maxPages}, startPage=${startPage}${sourcesFilter.length > 0 ? `, sourcesFilter=[${sourcesFilter.join(",")}]` : ""})`);

    // ── Get clan/member maps + definitions from CT ────────────────────────────
    const baseToken = await getCTToken(email, password);

    const [clansList, acctMembers] = await Promise.all([
      ctGet(`${CT_API_BASE}/clans`,   baseToken).then((d: any) => Array.isArray(d[0]) ? d[0] : d),
      ctGet(`${CT_API_BASE}/members`, baseToken).then((d: any) => Array.isArray(d[0]) ? d[0] : d),
    ]);

    const tagToClanId: Record<string, string> = {};
    clansList.forEach((c: any) => { if (c.tag && c.id) tagToClanId[c.tag] = c.id; });

    const clanIdToMemberId: Record<string, string> = {};
    acctMembers.forEach((m: any) => { if (m.clanId && m.id) clanIdToMemberId[m.clanId] = m.id; });

    // Fetch chest definitions (clan-scoped token needed)
    const definitionMap = new Map<string, any>();
    const defEndpoints = [
      `${CT_API_BASE}/definitions?size=1000`,
      `${CT_API_BASE}/chest-definitions?size=1000`,
      `${CT_API_BASE}/chestDefinitions?size=1000`,
    ];
    const firstClanId   = tagToClanId[CLANS_TO_SYNC[0]];
    const firstMemberId = firstClanId ? clanIdToMemberId[firstClanId] : undefined;
    const defToken      = firstMemberId ? await getCTToken(email, password, firstMemberId) : baseToken;

    for (const endpoint of defEndpoints) {
      try {
        const defsRaw = await ctGet(endpoint, defToken);
        const defs: any[] = Array.isArray(defsRaw[0]) ? defsRaw[0] : (Array.isArray(defsRaw) ? defsRaw : []);
        if (defs.length > 0 && defs[0].id) {
          for (const d of defs) { if (d.id) definitionMap.set(d.id, d); }
          console.log(`sync-chests: loaded ${definitionMap.size} definitions from ${endpoint}`);
          break;
        }
      } catch (err: any) {
        console.warn(`sync-chests: ${endpoint} failed (${err.message})`);
      }
    }
    if (definitionMap.size === 0) {
      console.warn("sync-chests: no definitions loaded — chest_name/points will be null");
    }

    // ── Load valid player IDs ─────────────────────────────────────────────────
    const { data: playerRows } = await db
      .from("players")
      .select("id")
      .in("clan", CLANS_TO_SYNC);

    const validPlayerIds = new Set<string>((playerRows ?? []).map((p: any) => String(p.id)));
    console.log(`sync-chests: ${validPlayerIds.size} known players in ${CLANS_TO_SYNC.join(", ")}`);

    // ── Sync each clan ────────────────────────────────────────────────────────
    const results: Record<string, any> = {};
    let totalUpserted = 0;

    for (const clan of clansToRun) {
      const clanId   = tagToClanId[clan];
      const memberId = clanId ? clanIdToMemberId[clanId] : undefined;

      if (!memberId) {
        results[clan] = { error: `No CT memberId found for clan ${clan}` };
        console.warn(`sync-chests [${clan}]: skipped — no memberId`);
        continue;
      }

      const clanToken = await getCTToken(email, password, memberId);
      console.log(`sync-chests [${clan}]: streaming chest readings...`);

      const clanResult = await streamChestsForClan(
        clanToken, cutoffIso, validPlayerIds, clan, nowIso, db, definitionMap,
        maxPages, pageSizeReq, startPage,
        sourcesFilter.length > 0 ? sourcesFilter : undefined,
      );

      totalUpserted += clanResult.upserted;
      results[clan] = { fetched: clanResult.fetched, upserted: clanResult.upserted, skipped: clanResult.skipped };
      console.log(`sync-chests [${clan}]: done — upserted=${clanResult.upserted}`);
    }

    // ── Prune rows older than cutoff (skip during backfill to preserve history) ─
    if (!isBackfill) {
      const { error: pruneErr } = await db
        .from("chests")
        .delete()
        .lt("generated_at", cutoffIso);
      if (pruneErr) console.warn("sync-chests: prune error:", pruneErr.message);
      else console.log(`sync-chests: pruned rows older than ${cutoffIso}`);
    } else {
      console.log("sync-chests: backfill mode — skipping prune to preserve history");
    }

    // ── Refresh all materialized views ───────────────────────────────────────
    const { error: refreshErr } = await db.rpc("refresh_epic_squad_views");
    if (refreshErr) console.warn("sync-chests: matview refresh error:", refreshErr.message);
    else console.log("sync-chests: epic squad views refreshed");

    const response = { success: true, cutoff: cutoffIso, totalUpserted, results };
    console.log("sync-chests: done —", JSON.stringify(response));
    return new Response(JSON.stringify(response), { headers: corsHeaders });

  } catch (err: any) {
    console.error("sync-chests error:", err.message, err.stack);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: corsHeaders },
    );
  }
});
