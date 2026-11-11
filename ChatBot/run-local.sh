#!/usr/bin/env bash
# Café Fernweh — local development runner
# Starts the backend (Cloudflare Worker on :8787) and frontend (Vite on :5173).

set -euo pipefail

cd "$(dirname "$0")"

echo "▶ Starting Café Fernweh backend (Ctrl+C to stop both)..."
npx wrangler dev --port 8787 --ip 127.0.0.1 &
BACKEND_PID=$!

echo "▶ Starting Café Fernweh frontend..."
npm run dev:client &
FRONTEND_PID=$!

cleanup() {
  echo ""
  echo "▶ Shutting down..."
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  echo "▶ Done."
}

trap cleanup EXIT INT TERM

echo "▶ Backend:  http://127.0.0.1:8787"
echo "▶ Frontend: http://localhost:5173"
echo "▶ Admin:    http://127.0.0.1:8787/admin/ (token: admin-secret-token-for-testing)"
echo ""

wait
