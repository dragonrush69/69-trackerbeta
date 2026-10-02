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
  externalIdMap:  Map<number, any>,
  maxPagesOverride?: number,
  pageSizeOverride?: number,
  startPageOverride?: number,
  sourcesFilter?: string[],   // if set, only store chests whose source matches one of these substrings
  activeEventName?: string | null,  // active event name from CT API (e.g. "Arachne")
): Promise<{ fetched: number; upserted: number; skipped: number }> {
  const effectiveMaxPages = maxPagesOverride ?? MAX_PAGES;
  const effectivePageSize = pageSizeOverride ?? PAGE_SIZE;
  let fetched  = 0;
  let upserted = 0;
  let skipped  = 0;
  let page = startPageOverride ?? 0;
  let unmappedSample = 0;
  let guardsL10Sample = 0;

  while (true) {
    const url =
      `${CT_API_BASE}/chests` +
      `?sort=generatedAt,desc` +
      `&size=${effectivePageSize}` +
      `&page=${page}` +
      `&include=definition`;

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
        console.log(`  [${clan}] CT chest sample (full): ${JSON.stringify(firstRow)}`);
      }
    }

    const dbRows: any[] = [];
    let hitCutoff = false;

    for (const r of pageRows) {
      if (r.generatedAt && r.generatedAt < cutoffIso) { hitCutoff = true; skipped++; continue; }
      if (!r.id)                                          { skipped++; continue; }
      if (!r.memberId || !validPlayerIds.has(r.memberId)) { skipped++; continue; }

      // Resolve definition: embedded (include=definition) → DB by definitionId → DB by externalId
      const embeddedDef = r.definition ?? r.override ?? null;
      const def = embeddedDef
        ?? definitionMap.get(r.definitionId ?? "")
        ?? (r.externalId != null ? externalIdMap.get(Number(r.externalId)) : undefined)
        ?? null;

      // Log first unmapped chest so we can see what CT is giving us
      if (!def && unmappedSample++ < 1) {
        console.log(`sync-chests: unmapped chest = ${JSON.stringify(r).slice(0, 500)}`);
      }

      // Map directly from definition — no heuristics
      // Rule 8: "Guard" must never appear in classification fields — it belongs to rewards only
      const rawName   = def?.name   ?? null;
      const rawSource = def?.source ?? null;
      const rawType   = def?.type   ?? null;
      const guardLeak = [rawName, rawSource, rawType].some(v => v && /guard/i.test(v));
      if (guardLeak) {
        console.error(`sync-chests RULE8 VIOLATION: "Guard" found in definition fields — chest id=${r.id} def=${JSON.stringify(def)}`);
      }
      const chestName   = guardLeak ? null : rawName;
      const chestSource = guardLeak ? null : rawSource;
      const chestType   = guardLeak ? null : rawType;
      const chestPoints = def?.override?.points ?? def?.points ?? r.points ?? null;
      const defId       = def?.id     ?? r.definitionId ?? null;

      // If sourcesFilter is active, skip chests whose source doesn't match any substring
      if (sourcesFilter && sourcesFilter.length > 0) {
        if (!chestSource || !sourcesFilter.some(f => chestSource.toLowerCase().includes(f.toLowerCase()))) {
          skipped++;
          continue;
        }
      }

      dbRows.push({
        id:              r.id,
        player_id:       r.memberId,
        clan,
        definition_id:   defId,
        ct_external_id:  r.externalId != null ? Number(r.externalId) : null,
        color:           r.color ?? def?.color ?? null,
        chest_name:      chestName,
        chest_source:    chestSource,
        chest_type:      chestType,
        quantity:        r.quantity      ?? 1,
        points:          chestPoints,
        generated_at:    r.generatedAt   ?? r.rawTime ?? null,
        reward:          r.reward        ?? null,
        synced_at:       nowIso,
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
    // probeAll: sample every CT API endpoint and exit — no sync performed
    const isProbeAll = bodyJson?.probeAll === true;

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

    const firstClanId   = tagToClanId[CLANS_TO_SYNC[0]];
    const firstMemberId = firstClanId ? clanIdToMemberId[firstClanId] : undefined;
    const defToken      = firstMemberId ? await getCTToken(email, password, firstMemberId) : baseToken;

    // ── probeAll mode: sample every CT endpoint RIGHT AFTER auth, then exit ───
    if (isProbeAll) {
      const probeClanTag   = CLANS_TO_SYNC[0];
      const probeClanId    = tagToClanId[probeClanTag];
      const probeMemberId  = probeClanId ? clanIdToMemberId[probeClanId] : undefined;
      const probeClanToken = probeMemberId
        ? await getCTToken(email, password, probeMemberId)
        : defToken;

      const probeEnd   = new Date();
      const probeStart = new Date(probeEnd.getTime() - 7 * 24 * 3600 * 1000);
      const ps = encodeURIComponent(probeStart.toISOString());
      const pe = encodeURIComponent(probeEnd.toISOString());

      const probes: Array<{ name: string; url: string; token: string }> = [
        { name: "clans",               url: `${CT_API_BASE}/clans`,                                                                  token: baseToken      },
        { name: "members",             url: `${CT_API_BASE}/members`,                                                                token: baseToken      },
        { name: "definitions?size=2",  url: `${CT_API_BASE}/definitions?size=2`,                                                     token: defToken       },
        { name: "chests?size=1",       url: `${CT_API_BASE}/chests?size=1&sort=generatedAt,desc&include=definition`,                 token: probeClanToken },
        { name: "breakdown levels=1",  url: `${CT_API_BASE}/chests/breakdown?levels=1&start=${ps}&end=${pe}`,                        token: probeClanToken },
        { name: "breakdown levels=2",  url: `${CT_API_BASE}/chests/breakdown?levels=2&start=${ps}&end=${pe}`,                        token: probeClanToken },
        { name: "breakdown levels=3",  url: `${CT_API_BASE}/chests/breakdown?levels=3&start=${ps}&end=${pe}`,                        token: probeClanToken },
        { name: "dashboards/summary",  url: `${CT_API_BASE}/dashboards/summary`,                                                     token: probeClanToken },
        { name: "dashboards/members",  url: `${CT_API_BASE}/dashboards/members?size=3`,                                              token: probeClanToken },
        { name: "tournaments?size=3",  url: `${CT_API_BASE}/tournaments?size=3`,                                                     token: probeClanToken },
        { name: "tournaments/summary", url: `${CT_API_BASE}/tournaments/summary`,                                                    token: probeClanToken },
        { name: "queue",               url: `${CT_API_BASE}/queue`,                                                                  token: defToken       },
        { name: "penalties?size=2",    url: `${CT_API_BASE}/penalties?size=2`,                                                       token: probeClanToken },
        { name: "events",              url: `${CT_API_BASE}/events`,                                                                 token: defToken       },
        { name: "squads",              url: `${CT_API_BASE}/squads`,                                                                 token: defToken       },
      ];

      console.log(`PROBE: sampling ${probes.length} CT endpoints as clan ${probeClanTag} (${probeClanId})`);
      for (const ep of probes) {
        try {
          const raw    = await ctGet(ep.url, ep.token);
          const sample = JSON.stringify(raw).slice(0, 1200);
          console.log(`PROBE [${ep.name}]: ${sample}`);
        } catch (e: any) {
          console.log(`PROBE [${ep.name}] ERROR: ${e.message}`);
        }
      }

      return new Response(JSON.stringify({ probeAll: true, done: true, clan: probeClanTag }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Fetch definitions from CT and upsert into definitions table ───────────
    {
      const defsRaw = await ctGet(`${CT_API_BASE}/definitions?size=500`, defToken);
      const defs: any[] = Array.isArray(defsRaw[0]) ? defsRaw[0] : (Array.isArray(defsRaw) ? defsRaw : []);
      console.log(`sync-chests: fetched ${defs.length} definitions from CT`);
      if (defs.length > 0 && defs[0]?.id) {
        // Log one full definition so we can see every field CT provides
        console.log(`sync-chests: FULL definition example: ${JSON.stringify(defs[0])}`);
        const epicEx = defs.find((d: any) => d.type === 'Epic Squad');
        if (epicEx) console.log(`sync-chests: FULL epic definition example: ${JSON.stringify(epicEx)}`);
        const defRows = defs.map((d: any) => ({
          id:           d.id,
          name:         d.name                     ?? null,
          source:       d.source                   ?? null,
          type:         d.type                     ?? null,
          points:       d.override?.points         ?? d.points ?? null,
          color:        d.color                    ?? null,
          external_ids: Array.isArray(d.externalIds) ? d.externalIds.map(Number) : null,
          enabled:      d.isEnabled                ?? true,
          raw:          d,
          synced_at:    nowIso,
        }));
        const { error: defUpsertErr } = await db.from("definitions").upsert(defRows, { onConflict: "id" });
        if (defUpsertErr) console.warn(`sync-chests: definitions upsert error: ${defUpsertErr.message}`);
        else console.log(`sync-chests: upserted ${defRows.length} definitions to DB`);
      }
    }

    // ── Load definitions from DB (includes any manually added rows) ───────────
    const definitionMap = new Map<string, any>();   // keyed by UUID id
    const externalIdMap = new Map<number, any>();   // keyed by integer externalId
    {
      const { data: dbDefs } = await db.from("definitions").select("*");
      for (const d of (dbDefs ?? [])) {
        if (d.id) definitionMap.set(d.id, d);
        if (Array.isArray(d.external_ids)) {
          for (const eid of d.external_ids) externalIdMap.set(Number(eid), d);
        }
      }
      console.log(`sync-chests: loaded ${definitionMap.size} definitions from DB (${externalIdMap.size} externalId entries)`);
      const arachneDefs = [...definitionMap.values()].filter((d: any) => (d.name ?? '').toLowerCase().includes('arachne'));
      console.log(`sync-chests: ARACHNE defs in DB (${arachneDefs.length}): ${arachneDefs.map((d:any) => d.name).join(', ')}`);
    }

    // Probe CT API endpoints to find active event/squad name — always log result
    let activeEventName: string | null = null;
    for (const probe of [
      `${CT_API_BASE}/events`,
      `${CT_API_BASE}/events/active`,
      `${CT_API_BASE}/squads`,
      `${CT_API_BASE}/epic-squads`,
      `${CT_API_BASE}/tournaments`,
      `${CT_API_BASE}/tournaments/active`,
    ]) {
      try {
        const raw = await ctGet(probe, defToken);
        const sample = JSON.stringify(raw).slice(0, 400);
        console.log(`sync-chests: probe ${probe} → ${sample}`);
        // Try to extract an active event name
        const rows: any[] = Array.isArray(raw[0]) ? raw[0] : (Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []));
        for (const row of rows) {
          const name = row.name ?? row.title ?? row.eventName ?? row.squadName ?? null;
          if (name && !activeEventName) {
            activeEventName = String(name);
            console.log(`sync-chests: activeEventName candidate from ${probe}: "${activeEventName}"`);
          }
        }
      } catch (err: any) {
        console.log(`sync-chests: probe ${probe} → ERROR: ${err.message}`);
      }
    }
    // Fallback to known event name if API probe didn't return one
    if (!activeEventName) activeEventName = "Arachne";
    console.log(`sync-chests: activeEventName resolved to: ${activeEventName}`);

    // DIAGNOSTIC: tournaments per clan using their CT clanId UUID
    for (const clanTag of CLANS_TO_SYNC) {
      const clanUuid = tagToClanId[clanTag];
      if (!clanUuid) { console.log(`DIAG [${clanTag}] no clanId found`); continue; }
      try {
        const tRaw = await ctGet(`${CT_API_BASE}/tournaments?clanId=${clanUuid}&size=20`, defToken);
        const tRows: any[] = Array.isArray(tRaw[0]) ? tRaw[0] : (Array.isArray(tRaw) ? tRaw : []);
        const types = [...new Set(tRows.map((r: any) => r.type))];
        console.log(`DIAG [${clanTag}] tournaments: ${tRows.length} rows, types: ${JSON.stringify(types)}`);
        if (tRows[0]) console.log(`DIAG [${clanTag}] tournament[0]: ${JSON.stringify(tRows[0])}`);
      } catch (e: any) { console.log(`DIAG [${clanTag}] tournaments error: ${e.message}`); }
    }


    if (definitionMap.size === 0) {
      console.warn("sync-chests: no definitions in DB — chest_name/points will be null");
    }

    // ── Load valid player IDs + names (for breakdown name matching) ───────────
    const { data: playerRows } = await db
      .from("players")
      .select("id, name, clan")
      .in("clan", CLANS_TO_SYNC);

    const validPlayerIds = new Set<string>((playerRows ?? []).map((p: any) => String(p.id)));
    // Per-clan name → player_id lookup (for breakdown endpoint matching)
    const clanNameToPlayerId: Record<string, Record<string, string>> = {};
    for (const p of (playerRows ?? [])) {
      if (!clanNameToPlayerId[p.clan]) clanNameToPlayerId[p.clan] = {};
      clanNameToPlayerId[p.clan][p.name.toLowerCase().trim()] = String(p.id);
    }
    console.log(`sync-chests: ${validPlayerIds.size} known players in ${CLANS_TO_SYNC.join(", ")}`);

    // ── Sync each clan ────────────────────────────────────────────────────────
    const results: Record<string, any> = {};
    let totalUpserted = 0;
    const clanTokens: Record<string, string> = {};  // reused in daily breakdown

    for (const clan of clansToRun) {
      const clanId   = tagToClanId[clan];
      const memberId = clanId ? clanIdToMemberId[clanId] : undefined;

      if (!memberId) {
        results[clan] = { error: `No CT memberId found for clan ${clan}` };
        console.warn(`sync-chests [${clan}]: skipped — no memberId`);
        continue;
      }

      const clanToken = await getCTToken(email, password, memberId);
      clanTokens[clan] = clanToken;
      console.log(`sync-chests [${clan}]: streaming chest readings...`);

      const clanResult = await streamChestsForClan(
        clanToken, cutoffIso, validPlayerIds, clan, nowIso, db, definitionMap, externalIdMap,
        maxPages, pageSizeReq, startPage,
        sourcesFilter.length > 0 ? sourcesFilter : undefined,
        activeEventName,
      );

      totalUpserted += clanResult.upserted;
      results[clan] = { fetched: clanResult.fetched, upserted: clanResult.upserted, skipped: clanResult.skipped };
      console.log(`sync-chests [${clan}]: done — upserted=${clanResult.upserted}`);
    }

    // ── Sync epic squad scores from /chests/breakdown ────────────────────────
    if (!isBackfill) {
      try {
        // Read weekReset from config so clock changes only require a config update, not a redeploy.
        // Fallback: Sunday (dayOfWeek=0) at 17:00 UTC.
        const [{ data: wkResetCfg }, { data: cfgRow }, { data: etUrlCfg }, { data: etMapCfg }] = await Promise.all([
          db.from("config").select("value").eq("key", "weekReset").single(),
          db.from("config").select("value").eq("key", "ctAliases").single(),
          db.from("config").select("value").eq("key", "eventTrackerUrl").single(),
          db.from("config").select("value").eq("key", "eventTypeMap").single(),
        ]);
        const resetHour = wkResetCfg?.value?.hour      ?? 17;   // UTC hour of weekly reset
        const resetDow  = wkResetCfg?.value?.dayOfWeek ?? 0;    // 0=Sunday

        // How many UTC days back to the last reset?
        const nowDate = new Date();
        const dow = nowDate.getUTCDay();
        let daysBack = (dow - resetDow + 7) % 7;
        // If we ARE on the reset day but haven't hit the reset hour yet, go back a full week.
        // Add a 1-minute grace window so a chest claimed at exactly reset time isn't mis-bucketed.
        if (daysBack === 0 && (nowDate.getUTCHours() < resetHour ||
            (nowDate.getUTCHours() === resetHour && nowDate.getUTCMinutes() < 1))) {
          daysBack = 7;
        }
        const weekStart = new Date(nowDate);
        weekStart.setUTCDate(nowDate.getUTCDate() - daysBack);
        weekStart.setUTCHours(resetHour, 0, 0, 0);
        weekStart.setUTCSeconds(0, 0);
        const weekStartDate = weekStart.toISOString().slice(0, 10);
        console.log(`sync-chests: breakdown weekStart=${weekStart.toISOString()} (resetHour=${resetHour}, resetDow=${resetDow})`);

        // Load ctAliases from config for name matching
        const ctAliases: Record<string, Record<string, string>> = cfgRow?.value ?? {};

        for (const clan of clansToRun) {
          const clanId   = tagToClanId[clan];
          const memberId = clanId ? clanIdToMemberId[clanId] : undefined;
          if (!memberId) continue;

          const clanToken  = await getCTToken(email, password, memberId);
          const bdUrl      = `${CT_API_BASE}/chests/breakdown?levels=1`
            + `&start=${encodeURIComponent(weekStart.toISOString())}`
            + `&end=${encodeURIComponent(nowDate.toISOString())}`;
          const bdRaw      = await ctGet(bdUrl, clanToken);
          const bdMembers: any[] = Array.isArray(bdRaw[0]) ? bdRaw[0] : (Array.isArray(bdRaw) ? bdRaw : []);
          // Log first member's full breakdown so we can see the exact structure
          if (bdMembers[0]) console.log(`sync-chests [${clan}] breakdown sample: ${JSON.stringify(bdMembers[0])}`);

          const nameLookup  = clanNameToPlayerId[clan] ?? {};
          const aliases     = ctAliases[clan] ?? {};
          const scoreRows: any[] = [];

          for (const m of bdMembers) {
            const ctName   = (m.name ?? "").trim();
            if (!ctName) continue;
            const epicSquad = m["epic squad"] ?? m["epicSquad"] ?? m["Epic Squad"] ?? null;
            const epicChests  = (epicSquad && typeof epicSquad.chests === "number") ? epicSquad.chests : 0;
            // Total points is top-level on the breakdown member object
            const totalPoints = typeof m.points === "number" ? m.points : 0;

            const playerId = aliases[ctName] ?? nameLookup[ctName.toLowerCase()] ?? null;
            if (!playerId || !validPlayerIds.has(playerId)) continue;
            scoreRows.push({
              week_start:   weekStartDate,
              clan,
              player_id:    playerId,
              total_chests: epicChests,
              total_points: totalPoints,
              synced_at:    nowIso,
            });
          }

          if (scoreRows.length > 0) {
            const { error: bdErr } = await db.from("epic_squad_scores").upsert(scoreRows, { onConflict: "week_start,clan,player_id" });
            if (bdErr) console.warn(`sync-chests [${clan}] breakdown upsert error: ${bdErr.message}`);
            else console.log(`sync-chests [${clan}] breakdown: wrote ${scoreRows.length} epic squad scores for week ${weekStartDate}`);
          } else {
            console.log(`sync-chests [${clan}] breakdown: no matched players`);
          }
        }
      } catch (err: any) {
        console.warn(`sync-chests: breakdown sync error: ${err.message}`);
      }

      // ── Sync daily chest breakdown (levels=2 — dominant sub-type stored as event_name) ──
      try {
        const { data: _wkResetCfg } = await db.from("config").select("value").eq("key", "weekReset").single();
        const dailyResetHour: number = _wkResetCfg?.value?.hour ?? 17;

        const DAILY_DAYS = 14;
        const now3 = new Date();

        for (const clan of clansToRun) {
          const token = clanTokens[clan];
          if (!token) continue;

          for (let d = 0; d < DAILY_DAYS; d++) {
            // dayEnd = 17:00 UTC on (today - d)
            const dayEnd = new Date(now3);
            dayEnd.setUTCDate(now3.getUTCDate() - d);
            dayEnd.setUTCHours(dailyResetHour, 0, 0, 0);
            dayEnd.setUTCSeconds(0, 0);

            const effectiveEnd = dayEnd > now3 ? now3 : dayEnd;

            const dayStart = new Date(dayEnd);
            dayStart.setUTCDate(dayEnd.getUTCDate() - 1);
            if (dayStart > now3) continue;

            // Label date = the day the window ENDS (the "day" in game terms)
            const labelDate = dayEnd.toISOString().slice(0, 10);

            // levels=2 returns nested sub-types inside each chest type key
            const dailyUrl = `${CT_API_BASE}/chests/breakdown?levels=2`
              + `&start=${encodeURIComponent(dayStart.toISOString())}`
              + `&end=${encodeURIComponent(effectiveEnd.toISOString())}`;
            const dailyRaw = await ctGet(dailyUrl, token);
            const dailyMembers: any[] = Array.isArray(dailyRaw[0]) ? dailyRaw[0] : (Array.isArray(dailyRaw) ? dailyRaw : []);

            // Sum all players per chest type, and accumulate sub-type totals
            const typeTotals: Record<string, number> = {};
            const typeSubTotals: Record<string, Record<string, number>> = {};
            // Per-player epic squad sub-type rows for daily_player_epic
            const playerEpicRows: any[] = [];

            for (const m of dailyMembers) {
              // Per-player: extract epic squad sub-type chests
              const epicSquad = (m as any)["epic squad"];
              if (epicSquad && typeof epicSquad.chests === "number" && m.id) {
                for (const [subKey, subVal] of Object.entries(epicSquad as Record<string, any>)) {
                  if (subKey !== "chests" && subVal && typeof (subVal as any).chests === "number" && (subVal as any).chests > 0) {
                    playerEpicRows.push({
                      date:        labelDate,
                      clan,
                      player_id:   String(m.id),
                      player_name: m.name || null,
                      event_name:  subKey,
                      chests:      (subVal as any).chests,
                      synced_at:   nowIso,
                    });
                  }
                }
              }

              // Clan-level aggregates (existing logic)
              for (const [key, val] of Object.entries(m as Record<string, any>)) {
                if (val && typeof val === "object" && typeof val.chests === "number") {
                  typeTotals[key] = (typeTotals[key] ?? 0) + val.chests;
                  if (!typeSubTotals[key]) typeSubTotals[key] = {};
                  // Nested sub-types are sibling keys to "chests" inside each type object
                  for (const [subKey, subVal] of Object.entries(val as Record<string, any>)) {
                    if (subKey !== "chests" && subVal && typeof subVal === "object" && typeof (subVal as any).chests === "number") {
                      typeSubTotals[key][subKey] = (typeSubTotals[key][subKey] ?? 0) + (subVal as any).chests;
                    }
                  }
                }
              }
            }

            // Pick dominant sub-type (most chests) per chest type as event_name
            // Stored as text[] to match existing column type and app expectations
            // sub_events stores ALL sub-type totals for stacked chart rendering
            const dailyRows = Object.entries(typeTotals).map(([chestType, totalChests]) => {
              const subs = typeSubTotals[chestType] ?? {};
              const dominant = Object.entries(subs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
              return {
                date:         labelDate,
                clan,
                chest_type:   chestType,
                total_chests: totalChests,
                event_name:   dominant ? [dominant] : null,
                sub_events:   Object.keys(subs).length > 0 ? subs : null,
                synced_at:    nowIso,
              };
            });

            if (dailyRows.length > 0) {
              const { error: dErr } = await db.from("daily_chest_breakdown")
                .upsert(dailyRows, { onConflict: "date,clan,chest_type" });
              if (dErr) console.warn(`sync-chests [${clan}] daily ${labelDate}: ${dErr.message}`);
              else {
                const sample = dailyRows.find(r => r.event_name);
                console.log(`sync-chests [${clan}] daily ${labelDate}: ${dailyRows.length} types — e.g. ${sample?.chest_type}: [${sample?.event_name}]`);
              }
            }

            // Write per-player epic sub-type data
            if (playerEpicRows.length > 0) {
              const { error: peErr } = await db.from("daily_player_epic")
                .upsert(playerEpicRows, { onConflict: "date,clan,player_id,event_name" });
              if (peErr) console.warn(`sync-chests [${clan}] daily_player_epic ${labelDate}: ${peErr.message}`);
              else console.log(`sync-chests [${clan}] daily_player_epic ${labelDate}: ${playerEpicRows.length} rows`);
            }
          }
        }
      } catch (dailyErr: any) {
        console.warn(`sync-chests: daily breakdown error: ${dailyErr.message}`);
      }
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

    // ── Refresh chests_weekly matview ────────────────────────────────────────
    const { error: refreshErr } = await db.rpc("refresh_chests_weekly");
    if (refreshErr) console.warn("sync-chests: chests_weekly refresh error:", refreshErr.message);
    else console.log("sync-chests: chests_weekly refreshed");

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
