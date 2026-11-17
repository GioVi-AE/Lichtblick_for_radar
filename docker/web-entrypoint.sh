#!/bin/sh
# Inject the default layout (bind-mount /lichtblick/default-layout.json to override).
set -e
mkdir -p /lichtblick
touch /lichtblick/default-layout.json
index_html=$(cat index.html)
replace_pattern='/*LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER*/'
replace_value=$(cat /lichtblick/default-layout.json)
echo "${index_html/"$replace_pattern"/$replace_value}" > index.html
exec "$@"
