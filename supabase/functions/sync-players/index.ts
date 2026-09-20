// sync-players — Supabase Edge Function
// Pulls the full member roster from ChestTracker API and upserts into the players table.
// Run once to seed players, or on demand to pick up new members / stat updates.
//
// Required secrets (set in Supabase Dashboard → Edge Functions → Manage secrets):
//   CT_EMAIL    — ChestTracker login email
//   CT_PASSWORD — ChestTracker login password
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
//
// Fields populated from CT:
//   id        — CT member UUID (used as our primary key)
//   name      — display name as it appears in-game
//   clan      — "69R" or "69S" (derived from which token was used)
//   active    — true unless CT status is "left" or "inactive"
//   might     — CT mightLevel
//   level     — CT heroLevel
//   rank_g    — CT guardsLevel (1–9)
//   rank_m    — CT monstersLevel (1–9)
//   rank_s    — CT specialistsLevel (1–9)
//   rank_e    — CT engineersLevel (1–9)
//
// Fields NOT populated (not available in CT API):
//   hero      — hero name (text); remains null unless set manually

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CT_API_BASE   = "https://api.chesttracker.com/v1";
const CLANS_TO_SYNC = ["69R", "69S"];

// Active statuses — anything else is considered inactive
const ACTIVE_STATUSES = new Set(["new", "veteran", "manager", "owner", "member"]);
// "left" and "inactive" → active = false
const INACTIVE_STATUSES = new Set(["left", "inactive"]);

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
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`CT GET ${url} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Status → active mapping ───────────────────────────────────────────────────
// CT status.value: new / inactive / exempt / vacation / rotation in / rotation out
//                  administrative / left
// We consider everything except "left" and "inactive" as active.
function isActive(member: any): boolean {
  const statusVal = member?.status?.value ?? member?.status ?? "";
  return !INACTIVE_STATUSES.has(statusVal);
}

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
    if (!email || !password) {
      throw new Error("CT_EMAIL and CT_PASSWORD secrets not set.");
    }

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Get base token + clan/member maps ─────────────────────────────────────
    const baseToken = await getCTToken(email, password);

    const [clansList, acctMembers] = await Promise.all([
      ctGet(`${CT_API_BASE}/clans`, baseToken).then(d => Array.isArray(d[0]) ? d[0] : d),
      ctGet(`${CT_API_BASE}/members`, baseToken).then(d => Array.isArray(d[0]) ? d[0] : d),
    ]);

    // tag → clanId, clanId → memberId (our account's memberId in that clan)
    const tagToClanId: Record<string, string>   = {};
    clansList.forEach((c: any) => { if (c.tag && c.id) tagToClanId[c.tag] = c.id; });

    const clanIdToMemberId: Record<string, string> = {};
    acctMembers.forEach((m: any) => { if (m.clanId && m.id) clanIdToMemberId[m.clanId] = m.id; });

    // ── Fetch existing player data so we can protect manually-set values ─────
    // Rule: for every numeric field, keep whichever value is higher — CT or app.
    // A value set manually in the app is never downgraded by a lower CT figure.
    const { data: existingPlayers } = await db
      .from("players")
      .select("id, might, level, rank_g, rank_m, rank_s, rank_e")
      .in("clan", CLANS_TO_SYNC);

    const existingMap: Record<string, any> = {};
    (existingPlayers ?? []).forEach((p: any) => { existingMap[p.id] = p; });

    // Returns whichever is higher; if one side is null, returns the other.
    const takeHigher = (ctVal: number | null, appVal: number | null): number | null => {
      if (ctVal == null)  return appVal;
      if (appVal == null) return ctVal;
      return Math.max(ctVal, appVal);
    };

    // ── Sync each clan ────────────────────────────────────────────────────────
    const results: Record<string, any> = {};
    const allPlayerRows: any[]         = [];
    const allAliasUpdates: Record<string, Record<string, string>> = {};
    const nowIso = new Date().toISOString();

    for (const clan of CLANS_TO_SYNC) {
      const clanId  = tagToClanId[clan];
      const memberId = clanId ? clanIdToMemberId[clanId] : undefined;

      if (!memberId) {
        results[clan] = { error: `No CT memberId found for clan ${clan}` };
        continue;
      }

      // Get clan-scoped token so /members only returns THIS clan's roster
      const clanToken = await getCTToken(email, password, memberId);

      // Fetch all members — request every useful field
      const fields = [
        "id", "name", "rank", "status",
        "mightLevel", "heroLevel",
        "guardsLevel", "monstersLevel", "specialistsLevel", "engineersLevel",
        "aliases", "hasGoldPass", "notes", "clanId",
      ].join(",");

      const raw = await ctGet(
        `${CT_API_BASE}/members?fields=${encodeURIComponent(fields)}&size=500`,
        clanToken,
      );

      // CT list response is [rows, totalCount]
      const members: any[] = Array.isArray(raw[0]) ? raw[0] : (Array.isArray(raw) ? raw : []);
      const total: number  = typeof raw[1] === "number" ? raw[1] : members.length;

      console.log(`sync-players [${clan}]: fetched ${members.length} / ${total} members`);

      // ── Map to player rows ─────────────────────────────────────────────────
      let inserted = 0, skipped = 0;
      const aliasMap: Record<string, string> = {}; // ctName → playerId

      for (const m of members) {
        if (!m.id || !m.name) { skipped++; continue; }

        const existing = existingMap[m.id];
        const ctMight  = m.mightLevel  ? Math.round(Number(m.mightLevel))  : null;
        const ctLevel  = m.heroLevel   ? Math.round(Number(m.heroLevel))   : null;
        const ctRankG  = m.guardsLevel      ? Number(m.guardsLevel)      : null;
        const ctRankM  = m.monstersLevel    ? Number(m.monstersLevel)    : null;
        const ctRankS  = m.specialistsLevel ? Number(m.specialistsLevel) : null;
        const ctRankE  = m.engineersLevel   ? Number(m.engineersLevel)   : null;

        allPlayerRows.push({
          id:         m.id,
          name:       m.name,
          clan,
          active:     isActive(m),
          // All numeric fields: take the higher of CT vs app — no exceptions.
          might:      takeHigher(ctMight,  existing?.might  ?? null),
          level:      takeHigher(ctLevel,  existing?.level  ?? null),
          rank_g:     takeHigher(ctRankG,  existing?.rank_g ?? null),
          rank_m:     takeHigher(ctRankM,  existing?.rank_m ?? null),
          rank_s:     takeHigher(ctRankS,  existing?.rank_s ?? null),
          rank_e:     takeHigher(ctRankE,  existing?.rank_e ?? null),
          updated_at: nowIso,
          // hero: null — not available from CT; preserved as-is by upsert merge
        });

        // Build alias map: each alias name → CT member id
        (m.aliases ?? []).forEach((alias: string) => {
          if (alias) aliasMap[alias] = m.id;
        });

        inserted++;
      }

      allAliasUpdates[clan] = aliasMap;
      results[clan] = {
        fetched: members.length,
        mapped:  inserted,
        skipped,
        sample:  members.slice(0, 2), // include first 2 raw members so caller can inspect shape
      };
    }

    // ── Upsert players ────────────────────────────────────────────────────────
    let upsertError: string | null = null;
    if (allPlayerRows.length) {
      const { error } = await db
        .from("players")
        .upsert(allPlayerRows, { onConflict: "id" });
      if (error) upsertError = error.message;
    }

    // ── Merge alias updates into config.ctAliases ─────────────────────────────
    // Merge rather than replace so any manually-set aliases survive
    const { data: existingCfg } = await db
      .from("config").select("value").eq("key", "ctAliases").maybeSingle();
    const existing = (existingCfg?.value ?? {}) as Record<string, any>;
    for (const clan of CLANS_TO_SYNC) {
      existing[clan] = { ...(existing[clan] ?? {}), ...allAliasUpdates[clan] };
    }
    await db.from("config").upsert(
      { key: "ctAliases", value: existing, updated_at: nowIso },
      { onConflict: "key" },
    );

    return new Response(
      JSON.stringify({
        success:     !upsertError,
        playerCount: allPlayerRows.length,
        upsertError,
        results,
      }),
      { headers: corsHeaders },
    );
  } catch (err: any) {
    console.error("sync-players error:", err.message);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: corsHeaders },
    );
  }
});
