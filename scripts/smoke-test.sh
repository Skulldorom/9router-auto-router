#!/bin/sh
set -eu
IMAGE="${1:-9router-auto-router:smoke}"
check='test -f /opt/9router-auto-router/auto-router.cjs && grep -Fq "9router-auto-router:v1" /app/.next/server/chunks/8635.js && node -e "const r=require(\"/opt/9router-auto-router/auto-router.cjs\"); const a=r.selectRoute({messages:[{role:\"user\",content:\"hello\"}]},\"coder-auto\"); const b=r.selectRoute({messages:[{role:\"user\",content:\"fully audit this repository\"}]},\"coder-auto\"); if(a.target!==\"coder\"||b.target!==\"coder-high\")process.exit(1)"'
docker run --rm --entrypoint sh "$IMAGE" -c "$check"
echo "Smoke test passed: coder-auto routes easy→coder and hard→coder-high."
