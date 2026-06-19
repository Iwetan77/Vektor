#!/usr/bin/env bash
cd "$(dirname "$0")/.."
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null
for t in zklogin sametoken auth keycrypt onboard ratelimit suins; do
  echo "=== $t ==="
  npx tsx "tests/${t}.smoke.ts" 2>&1 | tail -5
done
