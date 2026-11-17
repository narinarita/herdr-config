#!/bin/sh
# Copies this config into ~/.config/herdr-app, keeping the files it replaces,
# and registers the Claude Code hooks and statusline that timeline and branch-tree use.
#
# 順番: 1) Claude Code の設定を組み立てられるか確かめる（読めなければ、何も変えずに止まる）
#       2) Herdr の設定・mod をコピーする  3) mod を確かめる
#       4) Claude Code の設定を、その時点の中身からもう一度組み立てて書く（間に Claude Code が書いた変更を消さないように）
set -eu
src=$(cd "$(dirname "$0")" && pwd -P)
# Herdr が読む場所。HERDR_APP_HOME で変えている人はそちらに入れる（HERDR_HOME は前の版の名前）。
dst="${HERDR_APP_HOME:-${HERDR_HOME:-$HOME/.config/herdr-app}}"
mkdir -p "$dst"
dst=$(cd "$dst" && pwd -P)
# 入れ先とこのリポジトリが重なっていると、下の rm -rf がソースを消す。
case "$dst/" in "$src/"*) echo "The install folder ($dst) is inside this repository. Set HERDR_APP_HOME to Herdr's config folder." >&2; exit 1 ;; esac
case "$src/" in "$dst/"*) echo "This repository is inside the install folder ($dst). Clone it somewhere else." >&2; exit 1 ;; esac
backup="$dst/.backup-$(date +%Y%m%d-%H%M%S)"
has_jq=false
command -v jq >/dev/null 2>&1 && has_jq=true

# --- 1) Claude Code の設定（~/.claude/settings.json）を組み立てる ---
claude_dir="$HOME/.claude"
settings="$claude_dir/settings.json"
# $settings を元に、hook と statusline を足した設定を $settings.tmp に書く。組み立てられなければ 1 を返す。
build_settings() {
  # timeline の hook（stop / start / prompt）を足し、前の版で登録した使わない hook（notify / tool）を外す。
  # 外すのは、自分の hook を含んでいたエントリとイベントだけ。ユーザーの空の配列や .hooks のないエントリには触らない。
  # 使用量: 今の statusline を herdr-usage.sh の後ろに { …; } で包んでつなぐ（複数のコマンドから成る statusline にも入力が届くように）。
  # statusline がなければ、何も出さない herdr-usage.sh だけにする。
  jq '
    def ours: (.command // "") | startswith("~/.claude/hooks/herdr-timeline.sh");
    def wanted: (.command // "") as $c | ["~/.claude/hooks/herdr-timeline.sh stop", "~/.claude/hooks/herdr-timeline.sh start", "~/.claude/hooks/herdr-timeline.sh prompt"] | index($c);
    def stale: ours and (wanted | not);
    def prune:
      if type != "array" then .
      else map(if type == "object" and (.hooks | type) == "array" and any(.hooks[]; stale)
               then (.hooks |= map(select(stale | not))) | select(.hooks | length > 0)
               else . end) end;
    def add($event; $arg):
      ("~/.claude/hooks/herdr-timeline.sh " + $arg) as $cmd
      | if ([.hooks[$event][]? | objects | .hooks[]? | objects | .command] | index($cmd)) then .
        else .hooks[$event] = ((.hooks[$event] // []) + [ {hooks: [{type: "command", command: $cmd}]} ]) end;
    if (.hooks | type) != "object" and .hooks != null then error("hooks is not an object") else . end
    | .hooks = ((.hooks // {}) | with_entries(
        .value as $before | .value |= prune
        | select((.value | type) != "array" or (.value | length) > 0 or ($before | length) == 0)))
    | add("Stop"; "stop")
    | add("SessionStart"; "start")
    | add("UserPromptSubmit"; "prompt")
    | "~/.claude/hooks/herdr-usage.sh" as $usage
    | ($usage + " tee | ") as $pre
    | (.statusLine.command // "") as $cmd
    | if ($cmd | startswith($pre + "{ ")) then .
      elif ($cmd | startswith($pre)) then .statusLine.command = ($pre + "{ " + ($cmd | ltrimstr($pre)) + "\n}")
      elif ($cmd | contains($usage)) then .
      elif $cmd != "" then .statusLine.command = ($pre + "{ " + $cmd + "\n}")
      else .statusLine = ((.statusLine // {}) + {type: "command", command: $usage}) end
  ' "$settings" >"$settings.tmp" 2>"$settings.err" && rm -f "$settings.err"
}
if $has_jq; then
  mkdir -p "$claude_dir"
  [ -f "$settings" ] || echo '{}' >"$settings"
  if ! build_settings; then
    echo "Could not update $settings: $(cat "$settings.err")" >&2
    echo "Nothing was changed." >&2
    rm -f "$settings.tmp" "$settings.err"
    exit 1
  fi
  rm -f "$settings.tmp"
fi

# --- 2) Herdr の設定と mod をコピーする ---
# settings.json と keys.json は、今のファイルにこのリポジトリの値を重ねる（アプリで変えた設定や、足したキーは残す）。
# 今のファイルが読めないときと jq がないときは、まるごと置き換える。どちらも前のファイルは backup に残す。
mods=$(cd "$src" && for m in mods/*/; do printf '%s\n' "${m%/}"; done)
for path in layouts/my-main.json $mods keys.json settings.json; do
  if [ -e "$dst/$path" ]; then
    mkdir -p "$backup/$(dirname "$path")"
    cp -R "$dst/$path" "$backup/$path"
  fi
  mkdir -p "$dst/$(dirname "$path")"
  case "$path" in
    keys.json|settings.json)
      # 重ねるので、このリポジトリから消したキーは、今のファイルからは消えない。
      if $has_jq && [ -f "$dst/$path" ] && jq -e 'type == "object"' "$dst/$path" >/dev/null 2>&1; then
        if jq -s '.[0] * .[1]' "$dst/$path" "$src/$path" >"$dst/$path.tmp"; then
          cat "$dst/$path.tmp" >"$dst/$path"
          rm -f "$dst/$path.tmp"
          continue
        fi
        rm -f "$dst/$path.tmp"
        echo "Could not merge into $dst/$path: replacing it whole (the previous file is in $backup)" >&2
      fi
      ;;
  esac
  rm -rf "${dst:?}/$path"
  cp -R "$src/$path" "$dst/$path"
done
[ -d "$backup" ] && echo "Replaced files are in $backup"

# --- 3) mod を確かめる。失敗しても hook の登録までは進め、最後に知らせる ---
failed=""
if command -v herdr-app >/dev/null 2>&1; then
  for m in $mods; do
    herdr-app check "$dst/$m" || failed="$failed ${m#mods/}"
  done
fi

# --- 4) Claude Code の hook と statusline ---
mkdir -p "$claude_dir/hooks"
# timeline の作業ツリー（どの Space の Claude でも動くようにグローバル）。
cp "$src/hooks/timeline.sh" "$claude_dir/hooks/herdr-timeline.sh"
chmod +x "$claude_dir/hooks/herdr-timeline.sh"
# サイドバーの使用量: statusline に渡る JSON から rate_limits を書き出す。
cp "$src/hooks/usage.sh" "$claude_dir/hooks/herdr-usage.sh"
chmod +x "$claude_dir/hooks/herdr-usage.sh"
if $has_jq && ! build_settings; then
  echo "Could not update $settings (it changed while installing?): $(cat "$settings.err")" >&2
  echo "The mods were installed, but $settings was left as it was (hooks and statusline not updated). Run install.sh again." >&2
  [ -z "$failed" ] || echo "herdr-app check also failed for:$failed (see above)" >&2
  rm -f "$settings.tmp" "$settings.err"
  exit 1
fi
if $has_jq; then
  jq -S . "$settings" >"$settings.a" && jq -S . "$settings.tmp" >"$settings.b"
  if cmp -s "$settings.a" "$settings.b"; then
    rm -f "$settings.tmp" "$settings.a" "$settings.b"
    echo "The timeline hooks and the usage statusline are already registered in $settings"
  else
    rm -f "$settings.a" "$settings.b"
    # 書き換えるときだけ、日時付きで元を残す。
    saved="$settings.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$settings" "$saved"
    # mv ではなく中身を書き込む（settings.json が dotfiles のシンボリックリンクでも、リンクのまま残るように）。
    cat "$settings.tmp" >"$settings" && rm -f "$settings.tmp"
    echo "Registered the timeline hooks and the usage statusline in $settings (previous copy: $saved)"
  fi
else
  echo "jq is not installed: the timeline hooks and the usage statusline were not registered, and keys.json / settings.json were replaced whole" >&2
fi
# 前の版（出来事の並び）が書いた記録は使わないので消す。
find "$HOME/.local/state/herdr-timeline" \( -name '*.jsonl' -o -name '*.todos.json' \) -delete 2>/dev/null || true

if [ -n "$failed" ]; then
  echo "herdr-app check failed for:$failed (see above)" >&2
  exit 1
fi
echo "Done. This does not switch the layout; switch with: herdr-app do layout.switch '{\"name\":\"my-main\"}'"
