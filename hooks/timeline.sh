#!/bin/bash
# Herdr の右パネル (timeline mod) に出す作業ツリーを、Claude Code の hook から更新する。
# Herdr のターミナル ($HC_TERMINAL_ID) で動いているときだけ動く。
#
# 使い方 (~/.claude/settings.json の hooks から、種類を引数で渡す):
#   stop    Stop          今回のやりとり（指示・返答・操作）と今のツリーを Haiku に渡し、更新したツリーを書く。
#                         2〜5 秒かかるので、バックグラウンドで動かして Claude を待たせない
#   start   SessionStart  /clear で始めたときは、前の作業のツリーを消す
#
# 書き先: ~/.local/state/herdr-timeline/<terminal>.plan.json
#   {"goal": "...", "started": 秒, "updated": 秒, "turn": 秒,
#    "items": [{"title": "...", "state": "done|doing|todo", "children": [...]}]}
# 更新中は <terminal>.plan.pending を置く（mod が「更新中…」を出す）。
# 作業ツリーの各項目は状態だけを持つ（% は持たない）ので、作業の区切りごとの更新で十分。

[ -n "$HC_TERMINAL_ID" ] || exit 0
[ -z "$HERDR_TIMELINE_SKIP" ] || exit 0   # 更新用の claude -p から呼ばれたとき
command -v jq >/dev/null || exit 0

dir="$HOME/.local/state/herdr-timeline"
base="$dir/${HC_TERMINAL_ID//\//_}"
plan="$base.plan.json"
pending="$base.plan.pending"
mkdir -p "$dir"
input=$(cat)

SCHEMA='{
  "type": "object",
  "properties": {
    "changed": {"type": "boolean"},
    "new_goal": {"type": "boolean"},
    "goal": {"type": "string"},
    "items": {"type": "array", "items": {
      "type": "object",
      "properties": {
        "title": {"type": "string"},
        "state": {"enum": ["done", "doing", "todo"]},
        "children": {"type": "array", "items": {
          "type": "object",
          "properties": {"title": {"type": "string"}, "state": {"enum": ["done", "doing", "todo"]}},
          "required": ["title", "state"]
        }}
      },
      "required": ["title", "state"]
    }}
  },
  "required": ["changed", "new_goal", "goal", "items"]
}'

PROMPT='あなたは、AI エージェントの作業を作業ツリーとして管理する係です。
標準入力には「今の作業ツリー」（JSON。まだなければ null）と、「今回のやりとり」（ユーザーの指示、エージェントの返答、エージェントが使った操作）があります。
次の規則で、更新した作業ツリーを返してください。
- goal: ユーザーが達成したいことを日本語1文で（40字以内）。
- items: 作業の一覧。入れ子は2段まで（children）。末端の項目は全部で12個まで。title は日本語で25字以内。
- state: done は終わった作業。doing は今進めている作業と、ユーザーの判断や返事を待っている作業。todo はまだ手を付けていない作業。
- 今のツリーがあり、今回の指示が同じ目標の続きなら、new_goal は false。既存の項目の title と順番は変えず、state だけ直し、新しく出てきた作業を足す。
- 今回の指示が別の目標なら、new_goal を true にして、新しいツリーを作る。
- 質問に答えただけ、または雑談だけで作業が進んでいないなら、changed を false にして、今のツリーをそのまま返す（今のツリーがなければ goal は空、items は空）。それ以外は changed を true。
- 話に出ていない作業を推測で足さない。ユーザーが頼んだ作業と、エージェントがこれからやると言った作業は todo で足してよい。'

# 今回のやりとり: transcript の最後の「本物のユーザーの指示」から後ろを、短い行にして返す。
this_turn() {
  local path
  path=$(jq -r '.transcript_path // empty' <<<"$input")
  [ -f "$path" ] || return
  tail -n 800 "$path" | jq -rs '
    def cut($n): if length > $n then .[0:$n] + "…" else . end;
    def prompt: .type == "user" and (.message.content | (type == "string") or (type == "array" and any(.[]; .type == "text")));
    def brief: (.input // {}) as $i
      | .name + " " + ($i.description // $i.file_path // $i.path // $i.pattern // $i.command // $i.url // $i.prompt // "" | tostring | cut(120));
    [ .[] | select(.type == "user" or .type == "assistant") ] as $all
    | ([ $all | to_entries[] | select(.value | prompt) | .key ] | last // 0) as $from
    | $all[$from:][]
    | if .type == "user" then
        (.message.content | if type == "string" then . else [ .[] | select(.type == "text") | .text ] | join("\n") end)
        | select(length > 0) | "ユーザー: " + cut(1500)
      else
        .message.content[]?
        | if .type == "text" then "エージェント: " + (.text | cut(1500))
          elif .type == "tool_use" then "操作: " + brief
          else empty end
      end' 2>/dev/null | head -c 16000
}

update() {
  local turn="$1" turn_text="$2" now out
  now=$(cat "$plan" 2>/dev/null || echo null)
  out=$(printf '今の作業ツリー:\n%s\n\n今回のやりとり:\n%s\n' "$now" "$turn_text" |
    env -u HC_TERMINAL_ID HERDR_TIMELINE_SKIP=1 claude -p --model haiku --tools "" --no-session-persistence \
      --setting-sources "" --strict-mcp-config --disable-slash-commands \
      --output-format json --json-schema "$SCHEMA" "$PROMPT" 2>/dev/null |
    jq -c '.structured_output // empty' 2>/dev/null)
  if [ -n "$out" ] && [ "$(jq -r .changed <<<"$out")" = true ]; then
    # 後から始まった更新が先に書いていたら、古いこちらは書かない。
    if [ "$(jq -r '.turn // 0' "$plan" 2>/dev/null || echo 0)" -le "$turn" ]; then
      jq -n --argjson out "$out" --argjson old "$now" --argjson t "$(date +%s)" --argjson turn "$turn" '
        {goal: $out.goal,
         started: (if $out.new_goal or $old == null then $t else ($old.started // $t) end),
         updated: $t, turn: $turn,
         items: [ $out.items[] | {title, state} + (if (.children // []) | length > 0 then {children: [ .children[] | {title, state} ]} else {} end) ]}
      ' >"$plan.tmp.$$" && mv "$plan.tmp.$$" "$plan"
    fi
  fi
  # 自分の更新の印だけを消す（後の更新が置き直した印は残す）。
  [ "$(cat "$pending" 2>/dev/null)" = "$turn" ] && rm -f "$pending"
}

case "$1" in
  start)
    [ "$(jq -r '.source // ""' <<<"$input")" = clear ] && rm -f "$plan" "$pending"
    ;;
  stop)
    text=$(this_turn)
    [ -n "$text" ] || exit 0
    turn=$(date +%s)
    echo "$turn" >"$pending"
    ( update "$turn" "$text" ) </dev/null >/dev/null 2>&1 &
    disown
    ;;
esac
exit 0
