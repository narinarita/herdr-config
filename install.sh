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
# Timeline の記録: hook を ~/.claude/hooks に置き、~/.claude/settings.json に登録する（どの Space の Claude でも動くようにグローバル）。
claude_dir="$HOME/.claude"
mkdir -p "$claude_dir/hooks"
cp "$src/hooks/timeline.sh" "$claude_dir/hooks/herdr-timeline.sh"
chmod +x "$claude_dir/hooks/herdr-timeline.sh"
if command -v jq >/dev/null 2>&1; then
  settings="$claude_dir/settings.json"
  [ -f "$settings" ] || echo '{}' >"$settings"
  cp "$settings" "$settings.bak-timeline"
  jq '
    def add($event; $arg; $matcher):
      ("~/.claude/hooks/herdr-timeline.sh " + $arg) as $cmd
      | if ([.hooks[$event][]?.hooks[]?.command] | index($cmd)) then .
        else .hooks[$event] += [ {hooks: [{type: "command", command: $cmd}]} + (if $matcher == "" then {} else {matcher: $matcher} end) ]
        end;
    add("SessionStart"; "start"; "")
    | add("UserPromptSubmit"; "prompt"; "")
    | add("Stop"; "stop"; "")
    | add("Notification"; "notify"; "")
    | add("PostToolUse"; "tool"; "TodoWrite|TaskCreate|TaskUpdate|Bash")
  ' "$settings.bak-timeline" >"$settings.tmp" && mv "$settings.tmp" "$settings"
  echo "Registered the timeline hooks in $settings (previous copy: $settings.bak-timeline)"
else
  echo "jq is not installed: the timeline hooks were not registered" >&2
fi

echo "Done. Switch with: herdr-app do layout.switch '{\"name\":\"my-main\"}'"
