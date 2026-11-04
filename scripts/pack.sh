#!/bin/sh
# Pack the runtime-only zip and VERIFY it: extension.js imports ./ui/*.js and
# ./lib/proc.js, so a zip missing either tree loads as a broken extension.
# The v2.2 refactor added ui/ but this script was never updated — the shipped
# zip silently omitted it. The assertions below would have caught that.
set -e
cd "$(dirname "$0")/.."
rm -f procmon@abed.dev.zip
zip -qr procmon@abed.dev.zip \
    metadata.json extension.js prefs.js stylesheet.css \
    README.md LICENSE package.json \
    lib locale schemas ui
# Guard: never ship dev-only trees.
zip -qd procmon@abed.dev.zip 'tests/*' 'po/*' 'scripts/*' '*.zip' '*.bak' 2>/dev/null || true

list=$(unzip -l procmon@abed.dev.zip)
for required in extension.js ui/sparkline.js ui/startup.js ui/sections.js \
        ui/renderers.js ui/rows.js ui/cards.js ui/constants.js lib/proc.js \
        metadata.json schemas/org.gnome.shell.extensions.procmon.gschema.xml; do
    echo "$list" | grep -q " $required\$" || { echo "pack: MISSING $required"; exit 1; }
done
for forbidden in 'tests/' 'po/' 'scripts/'; do
    echo "$list" | grep -q "$forbidden" && { echo "pack: SHIPPED dev tree $forbidden"; exit 1; } || true
done
echo "packed + verified: procmon@abed.dev.zip ($(unzip -l procmon@abed.dev.zip | tail -1))"
