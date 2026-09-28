#!/usr/bin/env node
// Deploy an Edge Function to Supabase via the Management API (no CLI needed)
// Usage: node deploy.js <supabase-access-token> [function-name]
//
// Get your access token at: https://supabase.com/dashboard/account/tokens

const fs   = require("fs");
const path = require("path");

const PROJECT_REF   = "jssybjxthkhrzxbzpslx";
const ACCESS_TOKEN  = process.argv[2];
const FUNCTION_NAME = process.argv[3] ?? "sync-chests";

if (!ACCESS_TOKEN) {
  console.error("Usage: node deploy.js <supabase-access-token> [function-name]");
  console.error("Get your token at: https://supabase.com/dashboard/account/tokens");
  process.exit(1);
}

const fnPath = path.join(__dirname, "supabase", "functions", FUNCTION_NAME, "index.ts");
if (!fs.existsSync(fnPath)) {
  console.error(`Function file not found: ${fnPath}`);
  process.exit(1);
}

const source = fs.readFileSync(fnPath, "utf8");
console.log(`Deploying ${FUNCTION_NAME} (${source.length} chars) to project ${PROJECT_REF}…`);

async function deploy() {
  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/${FUNCTION_NAME}`;

  const res = await fetch(url, {
    method:  "PUT",
    headers: {
      "Authorization": `Bearer ${ACCESS_TOKEN}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      verify_jwt: false,
      body:       source,
    }),
  });

  const text = await res.text();
  if (res.ok) {
    console.log(`✅ ${FUNCTION_NAME} deployed successfully`);
    try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
  } else {
    console.error(`❌ Deploy failed (${res.status}): ${text}`);
    process.exit(1);
  }
}

deploy().catch(err => { console.error("Error:", err.message); process.exit(1); });
