#!/bin/sh
set -e
cd "$(dirname "$0")/.."
rm -f procmon@abed.dev.zip
zip -qr procmon@abed.dev.zip \
    metadata.json extension.js prefs.js stylesheet.css \
    README.md LICENSE package.json \
    lib locale schemas
# Guard: never ship dev-only trees.
zip -qd procmon@abed.dev.zip 'tests/*' 'po/*' 'scripts/*' '*.zip' '*.bak' 2>/dev/null || true
echo "packed: procmon@abed.dev.zip"