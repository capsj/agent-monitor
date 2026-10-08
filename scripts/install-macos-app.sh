#!/bin/zsh
set -euo pipefail

repo_dir="${0:A:h}/.."
app_name="Agent Monitor.app"
built_app="$repo_dir/build/$app_name"
target="/Applications/$app_name"

"$repo_dir/scripts/build-macos-app.sh"

# Quit a running copy so the new bundle is picked up.
osascript -e 'tell application "Agent Monitor" to quit' >/dev/null 2>&1 || true
if [[ -e "$target" ]]; then
  rm -rf -- "$target"
fi
cp -R "$built_app" "$target"

print "Installed $target"
print "Launch it from Spotlight or Launchpad as \"Agent Monitor\"."
print "Turn on \"Launch at login\" from the menu bar popover to start it automatically."
open "$target"
