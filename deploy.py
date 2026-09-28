#!/usr/bin/env python3
# Deploy an Edge Function to Supabase via the Management API (no CLI needed)
# Usage: python3 deploy.py YOUR_ACCESS_TOKEN [function-name]

import sys, os, json, urllib.request, urllib.error

PROJECT_REF   = "jssybjxthkhrzxbzpslx"
ACCESS_TOKEN  = sys.argv[1] if len(sys.argv) > 1 else None
FUNCTION_NAME = sys.argv[2] if len(sys.argv) > 2 else "sync-chests"

if not ACCESS_TOKEN:
    print("Usage: python3 deploy.py <supabase-access-token> [function-name]")
    print("Get your token at: https://supabase.com/dashboard/account/tokens")
    sys.exit(1)

script_dir = os.path.dirname(os.path.abspath(__file__))
fn_path = os.path.join(script_dir, "supabase", "functions", FUNCTION_NAME, "index.ts")

if not os.path.exists(fn_path):
    print(f"Function file not found: {fn_path}")
    sys.exit(1)

with open(fn_path, "r") as f:
    source = f.read()

print(f"Deploying {FUNCTION_NAME} ({len(source)} chars) to project {PROJECT_REF}…")

url     = f"https://api.supabase.com/v1/projects/{PROJECT_REF}/functions/{FUNCTION_NAME}"
payload = json.dumps({"verify_jwt": False, "body": source}).encode("utf-8")
req     = urllib.request.Request(url, data=payload, method="PUT")
req.add_header("Authorization", f"Bearer {ACCESS_TOKEN}")
req.add_header("Content-Type", "application/json")

try:
    with urllib.request.urlopen(req) as res:
        body = res.read().decode("utf-8")
        print(f"✅ {FUNCTION_NAME} deployed successfully")
        try: print(json.dumps(json.loads(body), indent=2))
        except: print(body)
except urllib.error.HTTPError as e:
    body = e.read().decode("utf-8")
    print(f"❌ Deploy failed ({e.code}): {body}")
    sys.exit(1)
except Exception as e:
    print(f"❌ Error: {e}")
    sys.exit(1)
