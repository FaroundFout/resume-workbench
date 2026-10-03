#!/bin/sh
set -eu
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 22 or newer is required. Install Node.js and reopen this terminal.' >&2
  exit 1
fi
if ! node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'; then
  echo 'Node.js 22 or newer is required.' >&2
  exit 1
fi
project_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
exec node "$project_root/server/index.mjs" "$@"
