#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOGGLE_FILE="$ROOT_DIR/toggle.txt"

printf '1\n' > "$TOGGLE_FILE"
echo "Set $TOGGLE_FILE to 1"
