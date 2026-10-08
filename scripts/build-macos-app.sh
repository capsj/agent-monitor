#!/bin/zsh
set -euo pipefail

repo_dir="${0:A:h}/.."
app_dir="$repo_dir/build/Agent Monitor.app"
contents_dir="$app_dir/Contents"
macos_dir="$contents_dir/MacOS"
resources_dir="$contents_dir/Resources"

cd "$repo_dir"
pnpm build
swift build --package-path "$repo_dir/macos" -c release
swift_bin_dir="$(swift build --package-path "$repo_dir/macos" -c release --show-bin-path)"

if [[ -e "$app_dir" ]]; then
  rm -rf -- "$app_dir"
fi
mkdir -p "$macos_dir" "$resources_dir"
cp "$swift_bin_dir/AgentMonitorMenuBar" "$macos_dir/AgentMonitorMenuBar"
cp "$repo_dir/macos/Resources/Info.plist" "$contents_dir/Info.plist"
cp "$repo_dir/macos/Resources/agent-monitor-backend" "$resources_dir/agent-monitor-backend"
cp "$repo_dir/macos/Resources/AppIcon.icns" "$resources_dir/AppIcon.icns"
node_path="$(command -v node)"
print -r -- "$node_path" > "$resources_dir/node-path"
# Remember where this checkout's CLI lives so the app keeps working after it is
# copied to /Applications.
print -r -- "${repo_dir:A}/dist/cli.js" > "$resources_dir/cli-path"
chmod 755 "$macos_dir/AgentMonitorMenuBar" "$resources_dir/agent-monitor-backend"

# Ad-hoc signing avoids a quarantine-style warning for this local development build.
codesign --force --sign - "$app_dir"

print "Built $app_dir"
print "Open it with: open '$app_dir'"
print "Install it with: pnpm install:macos"
