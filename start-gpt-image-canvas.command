#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")"

URL="http://127.0.0.1:5173/"
NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  source "$NVM_DIR/nvm.sh"
  nvm use 24.15.0 >/dev/null
fi

is_listening() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

echo "GPT Image Canvas"
echo "Project: $PWD"
echo

if is_listening 5173 && is_listening 8787; then
  echo "Service is already running."
  echo "Opening $URL"
  open "$URL"
  exit 0
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm was not found. Activating pnpm 9.14.2 with Corepack..."
  corepack prepare pnpm@9.14.2 --activate
fi

echo "Starting local service..."
echo "Open this URL after it starts: $URL"
echo "Press Ctrl+C in this window to stop the service."
echo

(sleep 5; open "$URL") &
pnpm dev
