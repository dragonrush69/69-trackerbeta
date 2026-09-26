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
const PAGE_SIZE     = 100;
const MAX_PAGES     = 20;   // 2,000 rows per clan per run — covers ~3 weeks comfortably
const KEEP_WEEKS    = 3;    // only keep chests from the last 3 weeks

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
): Promise<{ fetched: number; upserted: number; skipped: number }> {
  let fetched  = 0;
  let upserted = 0;
  let skipped  = 0;
  let page     = 0;

  while (true) {
    const url =
      `${CT_API_BASE}/chests` +
      `?sort=generatedAt,desc` +
      `&size=${PAGE_SIZE}` +
      `&page=${page}`;

    if (page === 0) console.log(`  [${clan}] CT URL: ${url}`);
    const raw = await ctGet(url, token);

    if (page === 0) {
      const firstRow = Array.isArray(raw[0]) ? raw[0][0] : (Array.isArray(raw) ? raw[0] : null);
      console.log(`  [${clan}] first generatedAt from CT: ${firstRow?.generatedAt ?? "none"}`);
    }

    const pageRows: any[] = Array.isArray(raw[0]) ? raw[0] : (Array.isArray(raw) ? raw : []);
    fetched += pageRows.length;

    const dbRows: any[] = [];
    let hitCutoff = false;

    for (const r of pageRows) {
      if (r.generatedAt && r.generatedAt < cutoffIso) { hitCutoff = true; skipped++; continue; }
      if (!r.id)                                          { skipped++; continue; }
      if (!r.memberId || !validPlayerIds.has(r.memberId)) { skipped++; continue; }

      const def = definitionMap.get(r.definitionId ?? "");
      dbRows.push({
        id:            r.id,
        player_id:     r.memberId,
        clan,
        definition_id: r.definitionId  ?? null,
        color:         r.color         ?? null,
        chest_name:    def?.name       ?? null,
        chest_source:  def?.source     ?? null,
        chest_type:    def?.type       ?? null,
        quantity:      r.quantity      ?? 1,
        points:        def?.points     ?? null,
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
    if (page >= MAX_PAGES) {
      console.log(`  [${clan}] hit MAX_PAGES (${MAX_PAGES})`);
      break;
    }
  }

  return { fetched, upserted, skipped };
}

// ── Week-start computation ────────────────────────────────────────────────────

function computeWeekStart(ts: Date, resetDow: number, resetHour: number): string {
  const shifted   = new Date(ts.getTime() - resetHour * 3_600_000);
  const dow       = shifted.getUTCDay();
  const daysSince = (dow - resetDow + 7) % 7;
  const d         = new Date(Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - daysSince,
  ));
  return d.toISOString().slice(0, 10);
}

// ── Aggregate chest rows into chests_weekly table ────────────────────────────

async function updateWeeklyTotals(
  db:        any,
  nowIso:    string,
  resetDow:  number,
  resetHour: number,
): Promise<void> {
  const weeklyMap = new Map<string, { player_id: string; clan: string; week_start: string; points: number; synced_at: string }>();

  // Paginate through the entire chests table — a single query hits the 1000-row default limit
  const PAGE_SIZE = 1000;
  let offset = 0;
  while (true) {
    const { data: chestsData, error: fetchErr } = await db
      .from("chests")
      .select("player_id, clan, generated_at, points, quantity")
      .not("points", "is", null)
      .range(offset, offset + PAGE_SIZE - 1);

    if (fetchErr) { console.warn("updateWeeklyTotals fetch error:", fetchErr.message); return; }

    for (const row of chestsData ?? []) {
      if (!row.generated_at || row.points == null) continue;
      const ws  = computeWeekStart(new Date(row.generated_at), resetDow, resetHour);
      const key = `${row.player_id}||${row.clan}||${ws}`;
      if (!weeklyMap.has(key)) {
        weeklyMap.set(key, { player_id: row.player_id, clan: row.clan, week_start: ws, points: 0, synced_at: nowIso });
      }
      weeklyMap.get(key)!.points += (row.points ?? 0) * (row.quantity ?? 1);
    }

    console.log(`updateWeeklyTotals: page offset=${offset} rows=${(chestsData ?? []).length}`);
    if ((chestsData ?? []).length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const rows = Array.from(weeklyMap.values());
  if (rows.length === 0) { console.log("updateWeeklyTotals: no rows to aggregate"); return; }

  const { error: upsertErr } = await db
    .from("chests_weekly")
    .upsert(rows, { onConflict: "player_id,clan,week_start" });

  if (upsertErr) console.error("updateWeeklyTotals upsert error:", upsertErr.message);
  else console.log(`sync-chests: weekly totals — ${rows.length} rows upserted`);
}

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

    // ── Read week-reset config ────────────────────────────────────────────────
    const { data: weekResetRow } = await db
      .from("config")
      .select("value")
      .eq("key", "weekReset")
      .maybeSingle();

    const weekResetCfg = (weekResetRow?.value ?? {}) as Record<string, any>;
    const resetDow     = weekResetCfg.dayOfWeek ?? 0;
    const resetHour    = weekResetCfg.hour      ?? 17;

    // ── Cutoff: only keep last KEEP_WEEKS weeks ───────────────────────────────
    const now       = new Date();
    const nowIso    = now.toISOString();
    const cutoff    = new Date(now.getTime() - KEEP_WEEKS * 7 * 24 * 3600 * 1000);
    const cutoffIso = cutoff.toISOString();
    console.log(`sync-chests: keeping chests since ${cutoffIso}`);

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

    for (const clan of CLANS_TO_SYNC) {
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
      );

      totalUpserted += clanResult.upserted;
      results[clan] = { fetched: clanResult.fetched, upserted: clanResult.upserted, skipped: clanResult.skipped };
      console.log(`sync-chests [${clan}]: done — upserted=${clanResult.upserted}`);
    }

    // ── Prune rows older than KEEP_WEEKS ─────────────────────────────────────
    const { error: pruneErr } = await db
      .from("chests")
      .delete()
      .lt("generated_at", cutoffIso);
    if (pruneErr) console.warn("sync-chests: prune error:", pruneErr.message);
    else console.log(`sync-chests: pruned rows older than ${cutoffIso}`);

    // ── Write weekly aggregates ───────────────────────────────────────────────
    await updateWeeklyTotals(db, nowIso, resetDow, resetHour);

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
