// sync-tournaments — Supabase Edge Function
// Uses /v1/tournaments/summary to pull per-player, per-tournament-type, per-date scores
// for 69R and 69S. Covers the last 90 days per run.
//
// Required secrets:
//   CT_EMAIL    — ChestTracker login email
//   CT_PASSWORD — ChestTracker login password

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CT_API_BASE   = "https://api.chesttracker.com/v1";
const CLANS_TO_SYNC = ["69R", "69S"];
const WINDOW_DAYS   = 90;

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
    if (err.name === "AbortError") throw new Error(`CT GET timed out: ${url}`);
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

    const now       = new Date();
    const nowIso    = now.toISOString();
    const startDate = new Date(now.getTime() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();

    const baseToken = await getCTToken(email, password);

    // Clan list + account member IDs
    const [clansList, acctMembers] = await Promise.all([
      ctGet(`${CT_API_BASE}/clans`,   baseToken).then((d: any) => Array.isArray(d[0]) ? d[0] : d),
      ctGet(`${CT_API_BASE}/members`, baseToken).then((d: any) => Array.isArray(d[0]) ? d[0] : d),
    ]);

    const tagToClanId: Record<string, string> = {};
    clansList.forEach((c: any) => { if (c.tag && c.id) tagToClanId[c.tag] = c.id; });

    const clanIdToMemberId: Record<string, string> = {};
    acctMembers.forEach((m: any) => { if (m.clanId && m.id) clanIdToMemberId[m.clanId] = m.id; });

    // Valid player IDs for FK matching
    const { data: playerRows } = await db
      .from("players")
      .select("id")
      .in("clan", CLANS_TO_SYNC);
    const validPlayerIds = new Set<string>((playerRows ?? []).map((p: any) => String(p.id)));

    const results: Record<string, any> = {};

    for (const clan of CLANS_TO_SYNC) {
      const clanId   = tagToClanId[clan];
      const memberId = clanId ? clanIdToMemberId[clanId] : undefined;

      if (!clanId || !memberId) {
        results[clan] = { error: `No CT clanId/memberId for ${clan}` };
        continue;
      }

      const clanToken = await getCTToken(email, password, memberId);

      // /v1/tournaments/summary returns [rankings, dates] tuple
      // rankings: array of players with per-type, per-date point breakdowns
      // dates:    { "Type": ["YYYY-MM-DD", ...] }
      const url = `${CT_API_BASE}/tournaments/summary`
        + `?start=${encodeURIComponent(startDate)}`
        + `&end=${encodeURIComponent(nowIso)}`;

      const raw = await ctGet(url, clanToken);

      // Unwrap [rankings, dates] — CT often returns [[rankings], dates]
      const rankings: any[] = Array.isArray(raw[0]) ? raw[0] : (Array.isArray(raw) ? raw : []);
      const dates: Record<string, string[]> = (Array.isArray(raw) && raw.length > 1 && !Array.isArray(raw[1]))
        ? raw[1]
        : {};

      console.log(`sync-tournaments [${clan}]: ${rankings.length} players in summary`);
      console.log(`sync-tournaments [${clan}]: tournament types — ${Object.keys(dates).join(", ")}`);

      const dbRows: any[] = [];

      for (const player of rankings) {
        const playerId   = player.id;
        const playerName = player.name;

        // Each key that isn't a metadata field is a tournament type
        const metaKeys = new Set(["id", "name", "points", "status", "guardsLevel", "isTracker",
          "createdAt", "joinedAt", "aliases", "collectedAt", "updatedAt", "deletedAt",
          "clanId", "mainId", "isManager", "notes", "avatar", "rank", "userId"]);

        for (const [tournType, dateMap] of Object.entries(player)) {
          if (metaKeys.has(tournType)) continue;
          if (typeof dateMap !== "object" || dateMap === null || Array.isArray(dateMap)) continue;

          for (const [tournDate, scoreObj] of Object.entries(dateMap as Record<string, any>)) {
            const points = scoreObj?.points != null ? Number(scoreObj.points) : null;

            // Log first Olympus scoreObj so we can see what fields CT provides
            if (tournType === "Trials Of Olympus" && dbRows.filter(r => r.tournament_type === "Trials Of Olympus").length === 0) {
              console.log(`sync-tournaments [${clan}] Olympus scoreObj sample:`, JSON.stringify(scoreObj));
            }

            dbRows.push({
              ct_entry_id:      `${playerId}__${tournType}__${tournDate}__${clan}`,
              ct_tournament_id: `${tournType}__${tournDate}__${clan}`,
              tournament_type:  tournType,
              tournament_date:  tournDate,
              clan,
              player_id:        (playerId && validPlayerIds.has(playerId)) ? playerId : null,
              player_name:      playerName ?? null,
              points,
              rank:             null,
              might:            null,
              hero:             null,
              meta:             scoreObj ?? null,
              synced_at:        nowIso,
            });
          }
        }
      }

      console.log(`sync-tournaments [${clan}]: ${dbRows.length} rows to upsert`);

      if (dbRows.length > 0) {
        const { error: upsertErr } = await db
          .from("tournament_entries")
          .upsert(dbRows, { onConflict: "ct_entry_id" });

        if (upsertErr) {
          console.error(`sync-tournaments [${clan}] upsert error:`, upsertErr.message);
          results[clan] = { error: upsertErr.message };
        } else {
          results[clan] = { players: rankings.length, upserted: dbRows.length };
          console.log(`sync-tournaments [${clan}]: done — upserted=${dbRows.length}`);
        }
      } else {
        results[clan] = { players: rankings.length, upserted: 0 };
      }
    }

    return new Response(JSON.stringify({ success: true, results }), { headers: corsHeaders });

  } catch (err: any) {
    console.error("sync-tournaments error:", err.message, err.stack);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: corsHeaders },
    );
  }
});
