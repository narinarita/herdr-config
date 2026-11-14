#!/bin/sh
# Copies this config into ~/.config/herdr-app, keeping the files it replaces.
set -eu
src=$(cd "$(dirname "$0")" && pwd)
dst="${HERDR_HOME:-$HOME/.config/herdr-app}"
backup="$dst/.backup-$(date +%Y%m%d-%H%M%S)"

for path in layouts/my-main.json mods/my-pane mods/claude-worktree mods/branch-tree keys.json settings.json; do
  if [ -e "$dst/$path" ]; then
    mkdir -p "$backup/$(dirname "$path")"
    cp -R "$dst/$path" "$backup/$path"
  fi
  mkdir -p "$dst/$(dirname "$path")"
  rm -rf "$dst/$path"
  cp -R "$src/$path" "$dst/$path"
done

[ -d "$backup" ] && echo "Replaced files are in $backup"
if command -v herdr-app >/dev/null 2>&1; then
  herdr-app check "$dst/mods/my-pane"
  herdr-app check "$dst/mods/branch-tree"
fi
echo "Done. Switch with: herdr-app do layout.switch '{\"name\":\"my-main\"}'"
