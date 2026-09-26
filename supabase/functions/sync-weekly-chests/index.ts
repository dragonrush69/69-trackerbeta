// sync-weekly-chests — Supabase Edge Function
// Uses /v1/chests/breakdown?levels=1&start=...&end=... (same endpoint as sync-epic-chests)
// Sums points across ALL chest types per member for the current event week.
// Writes to chests_weekly (player_id, clan, week_start, points).
//
// Required secrets: CT_EMAIL, CT_PASSWORD

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CT_API_BASE   = "https://api.chesttracker.com/v1";
const CLANS_TO_SYNC = ["69R", "69S"];

// Week resets Sunday at 18:00 UTC — matches sync-epic-chests logic
function getWeekStart(now: Date): { weekStart: string; startISO: string } {
  const dayOfWeek = now.getUTCDay();
  const daysBack  = dayOfWeek === 0 && now.getUTCHours() < 18 ? 7 : dayOfWeek;
  const startOfWeek = new Date(now);
  startOfWeek.setUTCDate(now.getUTCDate() - daysBack);
  startOfWeek.setUTCHours(18, 0, 0, 0);
  return {
    weekStart: startOfWeek.toISOString().slice(0, 10),
    startISO:  startOfWeek.toISOString(),
  };
}

async function getCTToken(email: string, password: string, memberId?: string): Promise<string> {
  const body: Record<string, string> = { email, password };
  if (memberId) body.memberId = memberId;
  const res = await fetch(`${CT_API_BASE}/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`CT auth failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const token = data.authToken ?? data.token ?? data.accessToken ?? data.access_token ?? data.jwt;
  if (!token) throw new Error(`No token in CT auth response. Keys: ${Object.keys(data).join(", ")}`);
  return token as string;
}

async function ctGet(url: string, token: string): Promise<any[]> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`CT GET ${url} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data[0]) ? data[0] : data;
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

  const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  try {
    const email    = Deno.env.get("CT_EMAIL");
    const password = Deno.env.get("CT_PASSWORD");
    if (!email || !password) throw new Error("CT_EMAIL and CT_PASSWORD secrets not configured.");

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const now = new Date();
    const { weekStart, startISO } = getWeekStart(now);
    const timeParams = `?levels=1&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(now.toISOString())}`;

    console.log(`sync-weekly-chests: week ${weekStart}, window ${startISO} → ${now.toISOString()}`);

    // Get clan/member maps
    const baseToken = await getCTToken(email, password);
    const [clansList, acctMembers] = await Promise.all([
      ctGet(`${CT_API_BASE}/clans`,   baseToken),
      ctGet(`${CT_API_BASE}/members`, baseToken),
    ]);

    const tagToClanId: Record<string, string> = {};
    clansList.forEach((c: any) => { if (c.tag && c.id) tagToClanId[c.tag] = c.id; });

    const clanIdToMemberId: Record<string, string> = {};
    acctMembers.forEach((m: any) => { if (m.clanId && m.id) clanIdToMemberId[m.clanId] = m.id; });

    // Load players + aliases config
    const [{ data: playersData }, { data: configRows }] = await Promise.all([
      db.from("players").select("id, name, clan, active"),
      db.from("config").select("key, value").in("key", ["ctAliases", "ctIgnored"]),
    ]);

    const configMap: Record<string, any> = {};
    (configRows ?? []).forEach((r: any) => { configMap[r.key] = r.value; });
    const ctAliases = configMap.ctAliases ?? {};
    const ctIgnored = configMap.ctIgnored ?? {};

    const results: Record<string, any> = {};
    // Use a Map to deduplicate — CT sometimes returns the same player twice
    const weeklyMap = new Map<string, any>();

    for (const clan of CLANS_TO_SYNC) {
      const clanId  = tagToClanId[clan];
      const memberId = clanId ? clanIdToMemberId[clanId] : undefined;
      if (!memberId) { results[clan] = { error: `No CT memberId for ${clan}` }; continue; }

      const clanToken = await getCTToken(email, password, memberId);

      let clanMembers: any[];
      try {
        clanMembers = await ctGet(`${CT_API_BASE}/chests/breakdown${timeParams}`, clanToken);
      } catch (e: any) {
        results[clan] = { error: e.message };
        continue;
      }

      console.log(`sync-weekly-chests [${clan}]: ${clanMembers.length} members from breakdown`);

      // Log first member so we can see the data shape
      if (clanMembers.length > 0) {
        console.log(`sync-weekly-chests [${clan}] first member sample:`, JSON.stringify(clanMembers[0]).slice(0, 500));
      }

      const clanPlayers = (playersData ?? []).filter((p: any) => p.clan === clan && p.active);
      const aliases  = (ctAliases[clan] ?? {}) as Record<string, string>;
      const ignored  = (ctIgnored[clan] ?? []) as string[];

      const nameLookup: Record<string, string> = {};
      clanPlayers.forEach((p: any) => { nameLookup[p.name.toLowerCase().trim()] = p.id; });

      let matched = 0;
      let unmatched = 0;

      clanMembers.forEach((member: any) => {
        const ctName = (member.name ?? "").trim();
        if (!ctName || ignored.includes(ctName)) return;

        // Use the pre-calculated total points from CT (member.points)
        const totalPoints = typeof member.points === "number" ? member.points : 0;

        const playerId = aliases[ctName] ?? nameLookup[ctName.toLowerCase().trim()];
        if (playerId) {
          const mapKey = `${playerId}||${clan}||${weekStart}`;
          const existing = weeklyMap.get(mapKey);
          weeklyMap.set(mapKey, {
            week_start: weekStart,
            clan,
            player_id:  playerId,
            points:     (existing?.points ?? 0) + totalPoints,
            synced_at:  now.toISOString(),
          });
          matched++;
        } else {
          unmatched++;
          console.log(`sync-weekly-chests [${clan}] unmatched: "${ctName}" (points=${totalPoints})`);
        }
      });

      results[clan] = { matched, unmatched };
      console.log(`sync-weekly-chests [${clan}]: matched=${matched} unmatched=${unmatched}`);
    }

    const weeklyRows = Array.from(weeklyMap.values());
    if (weeklyRows.length > 0) {
      const { error: upsertErr } = await db
        .from("chests_weekly")
        .upsert(weeklyRows, { onConflict: "player_id,clan,week_start" });
      if (upsertErr) throw new Error(`chests_weekly upsert error: ${upsertErr.message}`);
    }

    return new Response(
      JSON.stringify({ success: true, weekStart, rows: weeklyRows.length, results }),
      { headers: corsHeaders },
    );

  } catch (err: any) {
    console.error("sync-weekly-chests error:", err.message);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: corsHeaders },
    );
  }
});
