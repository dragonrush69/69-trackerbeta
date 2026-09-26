// ct-probe — temporary diagnostic function
// Tries common CT API endpoints and logs what comes back.
// Deploy, run once, check logs, then delete.

const CT_API_BASE = "https://api.chesttracker.com/v1";

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
  if (!token) throw new Error(`No token in CT auth response`);
  return token as string;
}

Deno.serve(async (req) => {
  const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  try {
    const email    = Deno.env.get("CT_EMAIL");
    const password = Deno.env.get("CT_PASSWORD");
    if (!email || !password) throw new Error("CT_EMAIL and CT_PASSWORD not set");

    const baseToken = await getCTToken(email, password);

    // Decode base token to see account user id
    const [, payloadB64] = baseToken.split(".");
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));
    console.log("BASE TOKEN PAYLOAD:", JSON.stringify(payload).slice(0, 500));

    // Get clan list
    const clansRaw = await fetch(`${CT_API_BASE}/clans`, { headers: { Authorization: `Bearer ${baseToken}` } });
    const clans = await clansRaw.json();
    const clansList = Array.isArray(clans[0]) ? clans[0] : clans;
    const clan69R   = clansList.find((c: any) => c.tag === "69R");
    console.log(`clan 69R id: ${clan69R?.id}`);

    // Get account members — log raw response to see what's actually returned
    const membersRaw = await fetch(`${CT_API_BASE}/members`, { headers: { Authorization: `Bearer ${baseToken}` } });
    const membersJson = await membersRaw.json();
    console.log("MEMBERS RESPONSE:", JSON.stringify(membersJson).slice(0, 800));
    const membersList = Array.isArray(membersJson[0]) ? membersJson[0] : (Array.isArray(membersJson) ? membersJson : []);
    const acctMember  = clan69R ? membersList.find((m: any) => m.clanId === clan69R.id) : membersList[0];
    console.log(`acctMember: ${JSON.stringify(acctMember)?.slice(0, 200)}`);

    // Try clan-scoped token; also try all member IDs we find
    const clanToken = acctMember ? await getCTToken(email, password, acctMember.id) : baseToken;
    const [, clanPayloadB64] = clanToken.split(".");
    const clanPayload = JSON.parse(atob(clanPayloadB64.replace(/-/g, "+").replace(/_/g, "/")));
    console.log("CLAN TOKEN PAYLOAD:", JSON.stringify(clanPayload).slice(0, 500));

    // Date window covering the last 30 days for summary
    const endDate   = new Date().toISOString();
    const startDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

    const endpointsBase = [
      "/tournaments",
      "/tournaments?size=5",
      `/tournaments?type=Rise+of+Ancient&size=5`,
      `/clans/${clan69R?.id}/tournaments`,
    ];
    const endpointsClan = [
      "/tournaments?size=10&sort=date,desc",
      `/tournaments?size=5&filter=type,%%,Rise`,
      `/tournaments/summary?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`,
      `/clans/${clan69R?.id}/tournaments`,
      `/members?clanId=${clan69R?.id}&size=5`,
    ];

    const results: Record<string, any> = {};

    for (const ep of endpointsBase) {
      try {
        const res = await fetch(`${CT_API_BASE}${ep}`, {
          headers: { Authorization: `Bearer ${baseToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text();
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        console.log(`[base] ${ep} → ${res.status}: ${JSON.stringify(parsed).slice(0, 300)}`);
      } catch (err: any) {
        console.log(`[base] ${ep} → ERROR: ${err.message}`);
      }
    }

    for (const ep of endpointsClan) {
      try {
        const res = await fetch(`${CT_API_BASE}${ep}`, {
          headers: { Authorization: `Bearer ${clanToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text();
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        console.log(`[clan] ${ep} → ${res.status}: ${JSON.stringify(parsed).slice(0, 300)}`);
      } catch (err: any) {
        console.log(`[clan] ${ep} → ERROR: ${err.message}`);
      }
    }

    return new Response(JSON.stringify(results, null, 2), { headers: corsHeaders });

  } catch (err: any) {
    console.error("ct-probe error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
});
