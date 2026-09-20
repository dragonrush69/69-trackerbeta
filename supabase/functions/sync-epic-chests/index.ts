// sync-epic-chests — Supabase Edge Function
// Calls the ChestTracker API and writes epic chest scores to Supabase.
// Triggered hourly via pg_cron, or manually from the beta app.
//
// Required secrets (set in Supabase Dashboard → Edge Functions → Manage secrets):
//   CT_EMAIL    — your ChestTracker login email
//   CT_PASSWORD — your ChestTracker login password
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CT_API_BASE    = "https://api.chesttracker.com/v1";
const CLANS_TO_SYNC  = ["69R", "69S"];

// ── Week boundary ─────────────────────────────────────────────────────────────
// Week runs Sunday 18:00 UTC → following Sunday 17:59 UTC (matches production)
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

// ── CT API helpers ────────────────────────────────────────────────────────────
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
  if (!res.ok) {
    throw new Error(`CT auth failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  const token =
    data.authToken ?? data.token ?? data.accessToken ??
    data.access_token ?? data.jwt;
  if (!token) {
    throw new Error(
      `No token in CT auth response. Keys: ${Object.keys(data).join(", ")}`,
    );
  }
  return token as string;
}

async function ctGet(url: string, token: string): Promise<any[]> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`CT GET ${url} failed: ${res.status}`);
  const data = await res.json();
  // CT sometimes wraps results in a nested array
  return Array.isArray(data[0]) ? data[0] : data;
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  // CORS preflight
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
    // ── Credentials & DB client ───────────────────────────────────────────────
    const email    = Deno.env.get("CT_EMAIL");
    const password = Deno.env.get("CT_PASSWORD");
    if (!email || !password) {
      throw new Error(
        "CT_EMAIL and CT_PASSWORD secrets not configured. " +
        "Set them in Supabase Dashboard → Edge Functions → Manage secrets.",
      );
    }

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Week window ───────────────────────────────────────────────────────────
    const now = new Date();
    const { weekStart, startISO } = getWeekStart(now);
    const timeParams =
      `?levels=1` +
      `&start=${encodeURIComponent(startISO)}` +
      `&end=${encodeURIComponent(now.toISOString())}`;

    // ── CT clan / member maps ─────────────────────────────────────────────────
    const baseToken = await getCTToken(email, password);
    const [clansList, acctMembers] = await Promise.all([
      ctGet(`${CT_API_BASE}/clans`,   baseToken),
      ctGet(`${CT_API_BASE}/members`, baseToken),
    ]);

    const tagToClanId: Record<string, string> = {};
    clansList.forEach((c: any) => {
      if (c.tag && c.id) tagToClanId[c.tag] = c.id;
    });

    const clanIdToMemberId: Record<string, string> = {};
    acctMembers.forEach((m: any) => {
      if (m.clanId && m.id) clanIdToMemberId[m.clanId] = m.id;
    });

    const tagToMemberId: Record<string, string> = {};
    Object.keys(tagToClanId).forEach(tag => {
      const cid = tagToClanId[tag];
      if (clanIdToMemberId[cid]) tagToMemberId[tag] = clanIdToMemberId[cid];
    });

    // ── Load players + config from Supabase ───────────────────────────────────
    const [{ data: playersData }, { data: configRows }] = await Promise.all([
      db.from("players").select("id, name, clan, active"),
      db.from("config").select("key, value").in("key", ["ctAliases", "ctIgnored"]),
    ]);

    const configMap: Record<string, any> = {};
    (configRows ?? []).forEach((r: any) => { configMap[r.key] = r.value; });
    const ctAliases = configMap.ctAliases ?? {};
    const ctIgnored = configMap.ctIgnored ?? {};

    // ── Sync each clan ────────────────────────────────────────────────────────
    const results: Record<string, any>  = {};
    const epicChestRows: any[]          = [];
    const ctSyncUpdates: Record<string, any> = {};

    for (const clan of CLANS_TO_SYNC) {
      const memberId = tagToMemberId[clan];
      if (!memberId) {
        results[clan] = { matched: 0, unmatched: 0, error: "No CT memberId found for this clan" };
        continue;
      }

      // Get clan-scoped token
      const clanToken = await getCTToken(email, password, memberId);

      let clanMembers: any[];
      try {
        clanMembers = await ctGet(
          `${CT_API_BASE}/chests/breakdown${timeParams}`,
          clanToken,
        );
      } catch (e: any) {
        results[clan] = { matched: 0, unmatched: 0, error: e.message };
        continue;
      }

      // Build name → playerId lookup
      const clanPlayers = (playersData ?? []).filter(
        (p: any) => p.clan === clan && p.active,
      );
      const aliases    = (ctAliases[clan] ?? {}) as Record<string, string>;
      const ignored    = (ctIgnored[clan]  ?? []) as string[];
      const nameLookup: Record<string, string> = {};
      clanPlayers.forEach((p: any) => {
        nameLookup[p.name.toLowerCase().trim()] = p.id;
      });

      const matched:   Record<string, number>             = {};
      const unmatched: Array<{ name: string; epics: number }> = [];

      clanMembers.forEach((member: any) => {
        const ctName = (member.name ?? "").trim();
        if (!ctName || ignored.includes(ctName)) return;

        const epicSquad = member["epic squad"];
        const epics = epicSquad && typeof epicSquad.chests === "number"
          ? epicSquad.chests
          : 0;

        const playerId =
          aliases[ctName] ?? nameLookup[ctName.toLowerCase().trim()];

        if (playerId) {
          matched[playerId] = epics;
        } else {
          unmatched.push({ name: ctName, epics });
        }
      });

      // Build upsert rows
      Object.entries(matched).forEach(([pid, score]) => {
        epicChestRows.push({
          week_start:  weekStart,
          clan,
          player_id:   pid,
          total_score: score,
          synced_at:   now.toISOString(),
          source:      "api",
        });
      });

      ctSyncUpdates[clan] = {
        lastSync:  now.toISOString(),
        matched:   Object.keys(matched).length,
        unmatched,
      };

      results[clan] = {
        matched:   Object.keys(matched).length,
        unmatched: unmatched.length,
      };
    }

    // ── Write to Supabase ─────────────────────────────────────────────────────
    const ops: Promise<any>[] = [];

    if (epicChestRows.length) {
      ops.push(
        db.from("epic_chests").upsert(epicChestRows, {
          onConflict: "week_start,clan,player_id",
        }),
      );
    }

    if (Object.keys(ctSyncUpdates).length) {
      // Merge with existing ctSync so we don't clobber other clans' records
      const { data: existing } = await db
        .from("config").select("value").eq("key", "ctSync").maybeSingle();
      const merged = { ...(existing?.value ?? {}), ...ctSyncUpdates };
      ops.push(
        db.from("config").upsert(
          { key: "ctSync", value: merged, updated_at: now.toISOString() },
          { onConflict: "key" },
        ),
      );
    }

    const writeResults = await Promise.all(ops);
    const writeErrors  = writeResults
      .filter(r => r?.error)
      .map(r => r.error.message);
    if (writeErrors.length) {
      throw new Error("Supabase write failed: " + writeErrors.join("; "));
    }

    return new Response(
      JSON.stringify({ success: true, weekStart, results }),
      { headers: corsHeaders },
    );
  } catch (err: any) {
    console.error("sync-epic-chests error:", err.message);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: corsHeaders },
    );
  }
});
