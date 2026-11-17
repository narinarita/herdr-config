#!/bin/sh
# Claude Code の使用量（5 時間枠と週の上限）を、branch-tree のサイドバーに出すために書き出す。
#
# Claude Code が statusline に渡す JSON の rate_limits を読み、
# ~/.local/state/herdr-usage/limits.json に次の形で書く（値が変わったときだけ）:
#   { "five_hour": { "pct": 34, "resets": 1795000000 }, "seven_day": { "pct": 22, "resets": 1795400000 } }
# resets は epoch 秒。取れなかった枠は null。
#
# 使い方（install.sh が ~/.claude/settings.json の statusLine に登録する）:
#   herdr-usage.sh tee | <元の statusline>   入力をそのまま次へ渡す
#   herdr-usage.sh                           statusline を使っていないとき。何も出さない
#
# 使用量はアカウントごとなので、Herdr の外の Claude からも書く。

input=$(cat)
if [ "${1:-}" = tee ]; then
  printf '%s' "$input"
fi
# 次の statusline を待たせないよう、先に出力を閉じる。
exec >&-

command -v jq >/dev/null 2>&1 || exit 0
dir="$HOME/.local/state/herdr-usage"
file="$dir/limits.json"

# resets_at は数値（秒 / ミリ秒）でも ISO 8601 の文字列でも受ける。
data=$(printf '%s' "$input" | jq -c '
  def epoch:
    if type == "number" then (if . > 1e12 then . / 1000 else . end | floor)
    elif type == "string" then
      ((tonumber? // (sub("\\.[0-9]+"; "") | sub("[+-]00:?00$"; "Z") | fromdateiso8601?)) // null)
    else null end;
  def window:
    if type == "object" and (.used_percentage | type) == "number"
    then { pct: (.used_percentage | round), resets: (.resets_at | epoch) }
    else null end;
  .rate_limits // empty
  | { five_hour: (.five_hour | window), seven_day: (.seven_day | window) }
  | select(.five_hour != null or .seven_day != null)
' 2>/dev/null) || exit 0
[ -n "$data" ] || exit 0

# 同じ値なら書かない（statusline は頻繁に呼ばれ、書くたびにサイドバーが読み直すため）。
if [ -f "$file" ] && [ "$(cat "$file")" = "$data" ]; then
  exit 0
fi
mkdir -p "$dir"
tmp="$file.$$"
printf '%s' "$data" >"$tmp" && mv "$tmp" "$file"
