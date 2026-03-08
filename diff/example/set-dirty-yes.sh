#!/usr/bin/env bash
set -euo pipefail
curl -sS "http://127.0.0.1:3000/set-dirty?value=diff"
echo
