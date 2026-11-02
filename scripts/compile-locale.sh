#!/bin/sh
set -e
cd "$(dirname "$0")/.."
for po in po/*.po; do
    [ -e "$po" ] || continue
    lang=$(basename "$po" .po)
    mkdir -p "locale/$lang/LC_MESSAGES"
    msgfmt -c "$po" -o "locale/$lang/LC_MESSAGES/procmon@abed.dev.mo"
done