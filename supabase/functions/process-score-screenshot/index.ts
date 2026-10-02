// process-score-screenshot — Supabase Edge Function
// Receives a base64-encoded screenshot from a player, calls Google Gemini Flash
// (free tier) to extract the player's name and score, and returns the result.
//
// Required secrets (Supabase Dashboard → Edge Functions → Manage secrets):
//   GEMINI_API_KEY — your Google AI Studio API key (starts with AIza...)
//
// POST body (JSON):
//   {
//     image_base64: string,   // base64-encoded PNG/JPG (no data: prefix)
//     image_type:   string,   // "image/png" | "image/jpeg"
//     player_name:  string,   // the name the player selected — used for matching
//     event_name:   string    // event context sent to the AI
//   }
//
// Response (JSON):
//   { ok: true,  name: string, score: number, notes: string }
//   { ok: false, error: string }   — retry required

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
      },
    });
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return json({ ok: false, error: "Server configuration error: missing API key" }, 500);
  }

  let body: { image_base64: string; image_type: string; player_name: string; event_name: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const { image_base64, image_type, player_name, event_name } = body;
  if (!image_base64 || !player_name || !event_name) {
    return json({ ok: false, error: "Missing required fields" }, 400);
  }

  const mimeType = (image_type === "image/jpeg" || image_type === "image/jpg")
    ? "image/jpeg"
    : "image/png";

  const prompt = `You are reading a Total Battle game screenshot submitted by a player called "${player_name}" for the "${event_name}" event.

Your job:
1. Find the player named "${player_name}" (or the closest name match) in the screenshot.
2. Read their score for this event.

Rules:
- The score is always a whole number (integer). It may have commas as thousand separators — remove them.
- If you cannot clearly identify the player or their score, say so.
- Reply with ONLY valid JSON in this exact format — no markdown, no explanation:
  { "found": true, "name": "<exact name as shown>", "score": <integer>, "notes": "<any useful context>" }
  OR if not found:
  { "found": false, "notes": "<reason why — unclear image, player not visible, etc.>" }`;

  let geminiRes: Response;
  try {
    geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              inline_data: {
                mime_type: mimeType,
                data:      image_base64,
              },
            },
            { text: prompt },
          ],
        }],
        generationConfig: {
          temperature:     0,
          maxOutputTokens: 256,
        },
      }),
    });
  } catch (e) {
    return json({ ok: false, error: `Gemini API request failed: ${e}` }, 502);
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    return json({ ok: false, error: `Gemini API error ${geminiRes.status}: ${errText}` }, 502);
  }

  const geminiBody = await geminiRes.json();
  const rawText = geminiBody?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  let parsed: { found: boolean; name?: string; score?: number; notes?: string };
  try {
    const clean = rawText.replace(/```[a-z]*\n?/gi, "").trim();
    parsed = JSON.parse(clean);
  } catch {
    return json({ ok: false, error: "Could not read the screenshot — please try a clearer image." }, 200);
  }

  if (!parsed.found) {
    return json({
      ok:    false,
      error: parsed.notes
        ? `Couldn't find your score: ${parsed.notes}. Please try a clearer screenshot.`
        : "Couldn't find your name or score in the screenshot. Please try a clearer image.",
    }, 200);
  }

  if (!parsed.score || typeof parsed.score !== "number") {
    return json({ ok: false, error: "Score wasn't readable — please try a clearer screenshot." }, 200);
  }

  return json({
    ok:    true,
    name:  parsed.name  ?? player_name,
    score: parsed.score,
    notes: parsed.notes ?? "",
  }, 200);
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
