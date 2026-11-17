#!/bin/sh
# Copies this config into ~/.config/herdr-app, keeping the files it replaces.
set -eu
src=$(cd "$(dirname "$0")" && pwd)
dst="${HERDR_HOME:-$HOME/.config/herdr-app}"
backup="$dst/.backup-$(date +%Y%m%d-%H%M%S)"

for path in layouts/my-main.json mods/my-pane mods/claude-worktree mods/branch-tree mods/pomodoro mods/editor mods/my-files mods/my-tabs mods/timeline keys.json settings.json; do
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
  herdr-app check "$dst/mods/pomodoro"
  herdr-app check "$dst/mods/my-tabs"
  herdr-app check "$dst/mods/timeline"
fi
# Timeline の作業ツリー: hook を ~/.claude/hooks に置き、~/.claude/settings.json に登録する（どの Space の Claude でも動くようにグローバル）。
claude_dir="$HOME/.claude"
mkdir -p "$claude_dir/hooks"
cp "$src/hooks/timeline.sh" "$claude_dir/hooks/herdr-timeline.sh"
chmod +x "$claude_dir/hooks/herdr-timeline.sh"
if command -v jq >/dev/null 2>&1; then
  settings="$claude_dir/settings.json"
  [ -f "$settings" ] || echo '{}' >"$settings"
  # 使う hook（stop / start）を足し、前の版で登録した使わない hook（prompt / notify / tool）を外す。
  jq '
    def ours: (.command // "") | startswith("~/.claude/hooks/herdr-timeline.sh");
    def wanted: (.command // "") as $c | ["~/.claude/hooks/herdr-timeline.sh stop", "~/.claude/hooks/herdr-timeline.sh start"] | index($c);
    def add($event; $arg):
      ("~/.claude/hooks/herdr-timeline.sh " + $arg) as $cmd
      | if ([.hooks[$event][]?.hooks[]?.command] | index($cmd)) then .
        else .hooks[$event] += [ {hooks: [{type: "command", command: $cmd}]} ] end;
    .hooks = ((.hooks // {}) | with_entries(.value |= (map(.hooks |= map(select((ours | not) or wanted))) | map(select(.hooks | length > 0))))
               | with_entries(select(.value | length > 0)))
    | add("Stop"; "stop")
    | add("SessionStart"; "start")
  ' "$settings" >"$settings.tmp" || { rm -f "$settings.tmp"; echo "Could not read $settings as JSON: the timeline hooks were not registered" >&2; exit 1; }
  jq -S . "$settings" >"$settings.a" && jq -S . "$settings.tmp" >"$settings.b"
  if cmp -s "$settings.a" "$settings.b"; then
    rm -f "$settings.tmp" "$settings.a" "$settings.b"
    echo "The timeline hooks are already registered in $settings"
  else
    rm -f "$settings.a" "$settings.b"
    # 書き換えるときだけ、日時付きで元を残す。
    saved="$settings.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$settings" "$saved"
    # mv ではなく中身を書き込む（settings.json が dotfiles のシンボリックリンクでも、リンクのまま残るように）。
    cat "$settings.tmp" >"$settings" && rm -f "$settings.tmp"
    echo "Registered the timeline hooks in $settings (previous copy: $saved)"
  fi
else
  echo "jq is not installed: the timeline hooks were not registered" >&2
fi
# 前の版（出来事の並び）が書いた記録は使わないので消す。
find "$HOME/.local/state/herdr-timeline" \( -name '*.jsonl' -o -name '*.todos.json' \) -delete 2>/dev/null || true

echo "Done. Switch with: herdr-app do layout.switch '{\"name\":\"my-main\"}'"
