// sync-players — Supabase Edge Function
// Pulls all clan members for 69R and 69S from ChestTracker API.
// Uses CT memberId as the player primary key.
// Matches existing players by name and updates their id to CT memberId.
// Inserts new players that don't exist yet.
//
// Required secrets:
//   CT_EMAIL    — ChestTracker login email
//   CT_PASSWORD — ChestTracker login password

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CT_API_BASE   = "https://api.chesttracker.com/v1";
const CLANS_TO_SYNC = ["69R", "69S"];

async function getCTToken(email: string, password: string, memberId?: string): Promise<string> {
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

    const baseToken = await getCTToken(email, password);
    const nowIso    = new Date().toISOString();

    // Fetch clan list and account members from CT
    const [clansList, acctMembers] = await Promise.all([
      ctGet(`${CT_API_BASE}/clans`,   baseToken).then((d: any) => Array.isArray(d[0]) ? d[0] : d),
      ctGet(`${CT_API_BASE}/members`, baseToken).then((d: any) => Array.isArray(d[0]) ? d[0] : d),
    ]);

    // Build tag → clanId map
    const tagToClanId: Record<string, string> = {};
    clansList.forEach((c: any) => { if (c.tag && c.id) tagToClanId[c.tag] = c.id; });

    // Build clanId → accountMemberId map (needed for clan-scoped token)
    const clanIdToMemberId: Record<string, string> = {};
    acctMembers.forEach((m: any) => { if (m.clanId && m.id) clanIdToMemberId[m.clanId] = m.id; });

    const results: Record<string, any> = {};

    for (const clan of CLANS_TO_SYNC) {
      const clanId   = tagToClanId[clan];
      const memberId = clanId ? clanIdToMemberId[clanId] : undefined;

      if (!clanId || !memberId) {
        results[clan] = { error: `No CT clanId or memberId for clan ${clan}` };
        console.warn(`sync-players [${clan}]: skipped — no clanId/memberId`);
        continue;
      }

      const clanToken = await getCTToken(email, password, memberId);

      // Try multiple endpoints to find clan members
      const endpoints = [
        `${CT_API_BASE}/clans/${clanId}`,
        `${CT_API_BASE}/members?clanId=${clanId}&size=500`,
        `${CT_API_BASE}/players?clanId=${clanId}&size=500`,
        `${CT_API_BASE}/clan-members?clanId=${clanId}&size=500`,
      ];

      let ctMembers: any[] = [];
      for (const endpoint of endpoints) {
        try {
          const raw = await ctGet(endpoint, clanToken);
          // Clan detail endpoint may return members nested
          const arr = raw.members ?? raw.players ?? (Array.isArray(raw[0]) ? raw[0] : (Array.isArray(raw) ? raw : []));
          if (arr.length > 0 && (arr[0].id || arr[0].memberId)) {
            ctMembers = arr;
            console.log(`sync-players [${clan}]: ${ctMembers.length} members from ${endpoint}`);
            break;
          }
        } catch (err: any) {
          console.warn(`sync-players [${clan}]: ${endpoint} failed — ${err.message}`);
        }
      }

      console.log(`sync-players [${clan}]: total members found: ${ctMembers.length}`);

      // Load existing players for this clan
      const { data: existingPlayers, error: fetchErr } = await db
        .from("players")
        .select("id, name")
        .eq("clan", clan);

      if (fetchErr) throw new Error(`Failed to fetch players for ${clan}: ${fetchErr.message}`);

      // Build name → existing player map (lowercase for fuzzy match)
      const nameToPlayer = new Map<string, any>();
      (existingPlayers || []).forEach((p: any) => {
        nameToPlayer.set((p.name || "").toLowerCase().trim(), p);
      });

      let inserted = 0;
      let updated  = 0;
      let skipped  = 0;

      // Log first member's key set so we can see what CT actually returns
      if (ctMembers.length > 0) {
        console.log(`sync-players [${clan}] SAMPLE MEMBER KEYS:`, JSON.stringify(Object.keys(ctMembers[0])));
        console.log(`sync-players [${clan}] SAMPLE MEMBER:`, JSON.stringify(ctMembers[0]).slice(0, 800));
      }

      for (const ctMember of ctMembers) {
        const ctId   = ctMember.id   ?? ctMember.memberId ?? ctMember.userId;
        const ctName = ctMember.name ?? ctMember.username ?? ctMember.playerName;

        if (!ctId || !ctName) { skipped++; continue; }

        // Diagnostic log for every member — captures raw level data so we can see what CT returns
        const rawLevels = ctMember.troopLevels ?? ctMember.levels ?? ctMember.chestLevels ?? null;
        console.log(`sync-players [${clan}] MEMBER ${ctName}: guardsLevel=${ctMember.guardsLevel} rawLevels=${JSON.stringify(rawLevels)} troopLevels=${JSON.stringify(ctMember.troopLevels)} levels=${JSON.stringify(ctMember.levels)}`);

        // Extract stats — try multiple possible CT field names
        const ctHero     = ctMember.heroLevel   ?? ctMember.hero        ?? ctMember.heroLvl    ?? null;
        const ctLevel    = ctMember.level       ?? ctMember.playerLevel ?? ctMember.lvl        ?? null;
        const ctMight    = ctMember.might       ?? ctMember.power       ?? ctMember.mightPoints ?? ctMember.totalMight ?? null;
        const ctJoinedAt = ctMember.joinedAt    ?? ctMember.joined_at   ?? ctMember.createdAt  ?? null;

        // Helper: extract integer rank from CT value (handles "G9" strings or bare numbers)
        const parseRank = (v: any): number | null => {
          if (v == null) return null;
          const n = parseInt(String(v).replace(/[^0-9]/g, ""), 10);
          return isNaN(n) ? null : n;
        };

        // G/M/S/E chest levels — try structured objects first, then top-level CT fields
        const rawG = rawLevels?.G ?? rawLevels?.guard      ?? rawLevels?.Guardian   ?? ctMember.guardsLevel    ?? null;
        const rawM = rawLevels?.M ?? rawLevels?.monster    ?? rawLevels?.Monster    ?? ctMember.monsterLevel   ?? null;
        const rawS = rawLevels?.S ?? rawLevels?.specialist ?? rawLevels?.Specialist ?? ctMember.specialistLevel ?? null;
        const rawE = rawLevels?.E ?? rawLevels?.cannon     ?? rawLevels?.Cannon     ?? ctMember.cannonLevel    ?? null;

        const rankG = parseRank(rawG);
        const rankM = parseRank(rawM);
        const rankS = parseRank(rawS);
        const rankE = parseRank(rawE);

        // Build levels JSONB in "G9" string format (matches frontend expectation)
        const ctLevels: Record<string,string|null> = {
          G: rankG != null ? `G${rankG}` : null,
          M: rankM != null ? `M${rankM}` : null,
          S: rankS != null ? `S${rankS}` : null,
          E: rankE != null ? `E${rankE}` : null,
        };
        const hasAnyLevel = rankG != null || rankM != null || rankS != null || rankE != null;

        const statsUpdate: Record<string,any> = { updated_at: nowIso };
        if (ctHero     != null) statsUpdate.hero      = ctHero;
        if (ctLevel    != null) statsUpdate.level     = ctLevel;
        if (ctMight    != null) statsUpdate.might     = ctMight;
        if (ctJoinedAt != null) statsUpdate.joined_at = ctJoinedAt;
        // Update BOTH integer rank columns (used by frontend) AND levels JSONB
        if (rankG != null) statsUpdate.rank_g = rankG;
        if (rankM != null) statsUpdate.rank_m = rankM;
        if (rankS != null) statsUpdate.rank_s = rankS;
        if (rankE != null) statsUpdate.rank_e = rankE;
        if (hasAnyLevel) statsUpdate.levels = ctLevels;

        const existing = nameToPlayer.get(ctName.toLowerCase().trim());

        if (existing) {
          if (existing.id !== ctId) {
            console.log(`sync-players [${clan}]: fixing ${ctName} — old id=${existing.id} new id=${ctId}`);

            // Step 1: insert new player record first (so FK targets exist)
            const { error: insErr } = await db.from("players").upsert({
              id:         ctId,
              name:       ctName,
              clan,
              active:     existing.active ?? true,
              ...statsUpdate,
            }, { onConflict: "id" });
            if (insErr) { console.warn(`Could not insert new player ${ctName}: ${insErr.message}`); skipped++; continue; }

            // Step 2: migrate all FK references to the new id
            await db.from("epic_chests").update({ player_id: ctId }).eq("player_id", existing.id);
            await db.from("chests_weekly").update({ player_id: ctId }).eq("player_id", existing.id);
            await db.from("chests").update({ player_id: ctId }).eq("player_id", existing.id);

            // Step 3: delete the old player record
            const { error: delErr } = await db.from("players").delete().eq("id", existing.id);
            if (delErr) { console.warn(`Could not delete old player ${ctName} (id=${existing.id}): ${delErr.message}`); }

            updated++;
          } else {
            // ID correct — still update stats if CT returned any
            if (Object.keys(statsUpdate).length > 1) {
              const { error: updErr } = await db.from("players").update(statsUpdate).eq("id", ctId);
              if (updErr) console.warn(`Could not update stats for ${ctName}: ${updErr.message}`);
              else updated++;
            }
          }
        } else {
          // New player — insert
          const { error: insErr } = await db.from("players").insert({
            id:         ctId,
            name:       ctName,
            clan,
            active:     true,
            ...statsUpdate,
          });
          if (insErr) { console.warn(`Could not insert new player ${ctName}: ${insErr.message}`); skipped++; continue; }
          inserted++;
        }
      }

      results[clan] = { ctMembers: ctMembers.length, inserted, updated, skipped };
      console.log(`sync-players [${clan}]: inserted=${inserted} updated=${updated} skipped=${skipped}`);
    }

    return new Response(JSON.stringify({ success: true, results }), { headers: corsHeaders });

  } catch (err: any) {
    console.error("sync-players error:", err.message, err.stack);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: corsHeaders },
    );
  }
});
