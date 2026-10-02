// process-score-screenshot — Supabase Edge Function
// Receives a base64-encoded screenshot from a player, calls Google Gemini
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

const GEMINI_BASE = "https://generativelanguage.googleapis.com";

// Models to try in order — matched to what this API key actually has available
const CANDIDATE_MODELS = [
  "gemini-2.5-flash",          // best multimodal, confirmed available
  "gemini-3.5-flash",          // newer, confirmed available
  "gemini-2.5-flash-image",    // image-specific variant
  "gemini-3.1-flash-image",    // image-specific variant
  "gemini-3.7-flash",          // confirmed available
  "gemini-3.8-flash",          // confirmed available
];

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

  // Try each candidate model until one works
  let geminiRes: Response | null = null;
  let usedModel = "";
  const modelErrors: string[] = [];

  for (const model of CANDIDATE_MODELS) {
    const url = `${GEMINI_BASE}/v1beta/models/${model}:generateContent?key=${apiKey}`;
    console.log(`[process-score-screenshot] Trying model: ${model}`);

    try {
      const res = await fetch(url, {
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
            maxOutputTokens: 1024,
          },
        }),
      });

      if (res.status === 404 || res.status === 400) {
        const errText = await res.text();
        console.log(`[process-score-screenshot] Model ${model} not found: ${res.status} ${errText}`);
        modelErrors.push(`${model}: ${res.status}`);
        continue; // try next model
      }

      if (res.status === 503 || res.status === 429) {
        const errText = await res.text();
        console.log(`[process-score-screenshot] Model ${model} unavailable/rate-limited: ${res.status} ${errText}`);
        modelErrors.push(`${model}: ${res.status} (overloaded)`);
        continue; // try next model
      }

      // 200 or any other status — stop trying models
      geminiRes = res;
      usedModel = model;
      break;
    } catch (e) {
      console.log(`[process-score-screenshot] Model ${model} fetch error: ${e}`);
      modelErrors.push(`${model}: fetch error`);
    }
  }

  // If no model worked, list available models to help diagnose
  if (!geminiRes) {
    // Try to list models so we can log what's actually available
    try {
      const listRes = await fetch(`${GEMINI_BASE}/v1beta/models?key=${apiKey}`);
      const listBody = await listRes.json();
      const available = (listBody?.models || [])
        .map((m: { name: string }) => m.name)
        .filter((n: string) => n.includes("gemini"))
        .join(", ");
      console.log(`[process-score-screenshot] Available models: ${available || "none listed"}`);
      return json({
        ok: false,
        error: `No Gemini model available for this API key. Tried: ${modelErrors.join("; ")}. Available: ${available || "check API key / enable Generative Language API in Google Cloud"}`,
      }, 502);
    } catch (e) {
      return json({
        ok: false,
        error: `No Gemini model available. Tried: ${modelErrors.join("; ")}. List error: ${e}`,
      }, 502);
    }
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    console.error(`[process-score-screenshot] Gemini error (${usedModel}): ${geminiRes.status} ${errText}`);
    return json({ ok: false, error: `Gemini API error ${geminiRes.status}: ${errText}` }, 502);
  }

  let geminiBody: unknown;
  try {
    geminiBody = await geminiRes.json();
  } catch (e) {
    return json({ ok: false, error: `Gemini response not JSON: ${e}` }, 502);
  }

  console.log(`[process-score-screenshot] Success with model: ${usedModel}`);
  console.log(`[process-score-screenshot] Full response: ${JSON.stringify(geminiBody)}`);

  // Check for safety blocks or empty candidates
  const candidates = (geminiBody as Record<string, unknown>)?.candidates as Array<Record<string, unknown>> | undefined;
  if (!candidates || candidates.length === 0) {
    const promptFeedback = (geminiBody as Record<string, unknown>)?.promptFeedback;
    return json({ ok: false, error: `Gemini returned no candidates. promptFeedback: ${JSON.stringify(promptFeedback)}` }, 200);
  }

  const finishReason = candidates[0]?.finishReason as string | undefined;
  const rawText = (candidates[0]?.content as Record<string, unknown>)?.parts?.[0]?.text as string ?? "";

  if (!rawText) {
    return json({ ok: false, error: `Gemini returned empty text. finishReason: ${finishReason}. Full response: ${JSON.stringify(geminiBody)}` }, 200);
  }

  let parsed: { found: boolean; name?: string; score?: number; notes?: string };
  try {
    // Strip markdown fences, then try direct parse
    const clean = rawText.replace(/```[a-z]*\n?/gi, "").trim();
    try {
      parsed = JSON.parse(clean);
    } catch {
      // Gemini sometimes wraps JSON in surrounding text — extract the first {...} block
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`No JSON found in: ${clean.slice(0, 200)}`);
      parsed = JSON.parse(match[0]);
    }
  } catch (e) {
    console.error("[process-score-screenshot] Gemini raw response:", rawText);
    return json({ ok: false, error: `Parse error: ${e}. Raw: ${rawText.slice(0, 300)}` }, 200);
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
