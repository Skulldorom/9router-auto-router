#!/bin/sh
set -eu
IMAGE="${1:-9router-auto-router:smoke}"
check='test -f /opt/9router-auto-router/auto-router-config.cjs && test -f /opt/9router-auto-router/auto-router.cjs && test "$(grep -RFl "9router-auto-router:v3" /app/.next/server | wc -l)" -eq 1 && test "$(grep -RFl "9router-auto-router-ui:v5" /app/.next | wc -l)" -eq 2 && node /opt/9router-auto-router/apply-patch.mjs /app --check && node -e "const r=require(\"/opt/9router-auto-router/auto-router.cjs\"); const tools=Array.from({length:12},(_,n)=>({function:{name:\"tool_\"+n}})); const easy={messages:[{role:\"user\",content:\"Rename this variable in src/foo.js\"}],tools}; const hard={messages:[{role:\"user\",content:\"Fully audit the concurrency implementation\"}],tools}; if(r.selectRoute(easy,\"coder-auto\").target!==\"coder\"||r.selectRoute(hard,\"coder-auto\").target!==\"coder-high\")process.exit(1)"'
docker run --rm --entrypoint sh "$IMAGE" -c "$check"
echo "Smoke test passed: dynamic runtime/UI patches present; easy→coder and hard→coder-high."
