#!/bin/bash
# Herdr の右パネル (timeline mod) に出す作業ツリーを、Claude Code の hook から更新する。
# Herdr のターミナル ($HC_TERMINAL_ID) で動いているときだけ動く。
#
# 使い方 (~/.claude/settings.json の hooks から、種類を引数で渡す):
#   stop    Stop          今回のやりとり（指示・返答・操作）と今のツリーを Haiku に渡し、更新したツリーを書く。
#                         2〜5 秒かかるので、バックグラウンドで動かして Claude を待たせない
#   start   SessionStart  新しいセッション（起動・/clear）では、前の作業のツリーを空にする。再開 (resume) では残す
#
# 書き先: ~/.local/state/herdr-timeline/<terminal>.plan.json
#   {"goal": "...", "started": 秒, "updated": 秒, "turn": ミリ秒,
#    "items": [{"title": "...", "state": "done|doing|todo", "children": [...]}]}
# 更新中は <terminal>.plan.pending に、その更新の turn を置く（mod が「更新中…」を出す）。
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

# ミリ秒。同じ秒に 2 回動いても、更新の順番と印を区別できるように。
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }

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
標準入力には「今の作業ツリー」（JSON。まだなければ null か、items が空）と、「今回のやりとり」（ユーザーの指示、エージェントの返答、エージェントが使った操作）があります。
次の規則で、更新した作業ツリーを返してください。
- goal: ユーザーが達成したいことを日本語1文で（40字以内）。
- items: 作業の一覧。入れ子は2段まで（children）。末端の項目は全部で12個まで。title は日本語で25字以内。
- state: done は終わった作業。doing は今進めている作業と、ユーザーの判断や返事を待っている作業。todo はまだ手を付けていない作業。
- 今のツリーがあり、今回の指示が同じ目標の続きなら、new_goal は false。既存の項目の title と順番は変えず、state だけ直し、新しく出てきた作業を足す。
- 足すと末端が12個を超えるときは、子が全部 done の親項目から順に、子を消して親1行（done）にまとめて数を減らす。
- 今回の指示が別の目標なら、new_goal を true にして、新しいツリーを作る。
- 質問に答えただけ、または雑談だけで作業が進んでいないなら、changed を false にして、今のツリーをそのまま返す（今のツリーがなければ goal は空、items は空）。それ以外は changed を true。
- 話に出ていない作業を推測で足さない。ユーザーが頼んだ作業と、エージェントがこれからやると言った作業は todo で足してよい。'

# 今回のやりとり: transcript の最後の「本物のユーザーの指示」から後ろを、短い行にして返す。
# スキルの展開 (isMeta)、<command-…> や <task-notification> などのタグで始まるもの、中断の印は指示と見なさない。
# 長いときは、指示（先頭）と、状態を決めるのに大事な最後の部分を残し、間を省く。
this_turn() {
  local path
  path=$(jq -r '.transcript_path // empty' <<<"$input")
  [ -f "$path" ] || return
  tail -n 800 "$path" | jq -rs '
    def cut($n): if length > $n then .[0:$n] + "…" else . end;
    def text: .message.content | if type == "string" then . else [ .[]? | select(.type == "text") | .text ] | join("\n") end;
    def prompt: .type == "user" and (.isMeta | not)
      and (text | ltrimstr(" ") | length > 0 and (startswith("<") or startswith("[Request interrupted") | not));
    def brief: (.input // {}) as $i
      | .name + " " + ($i.description // $i.file_path // $i.path // $i.pattern // $i.command // $i.url // $i.prompt // "" | tostring | cut(120));
    [ .[] | select(.type == "user" or .type == "assistant") ] as $all
    | ([ $all | to_entries[] | select(.value | prompt) | .key ] | last // 0) as $from
    | [ $all[$from:][]
        | if .type == "user" then
            select(prompt) | "ユーザー: " + (text | cut(1500))
          else
            .message.content[]?
            | if .type == "text" then "エージェント: " + (.text | cut(1500))
              elif .type == "tool_use" then "操作: " + brief
              else empty end
          end ] as $lines
    | ($lines[0] // "") as $head
    | ($lines[1:] | join("\n")) as $rest
    | if ($rest | length) > 14000 then $head + "\n（途中を省略）\n" + $rest[-14000:] else ([$head, $rest] | join("\n")) end
  ' 2>/dev/null
}

# 更新は 1 つずつ。前の更新が書いたツリーを元に次の更新が作るように、読む前から書き終わるまでロックする。
# 2 分待っても取れなければ（落ちた更新が残したロック）、取り除いて進む。
lock() {
  local i=0
  until mkdir "$plan.lock" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -gt 600 ]; then rmdir "$plan.lock" 2>/dev/null; mkdir "$plan.lock" 2>/dev/null; return; fi
    sleep 0.2
  done
}
unlock() { rmdir "$plan.lock" 2>/dev/null; }

update() {
  local turn="$1" turn_text="$2" old out
  lock
  old=$(cat "$plan" 2>/dev/null || echo null)
  # 待っている間に新しいセッションで空にされていたら（turn が新しい）、この古いやりとりでは更新しない。
  if [ "$(jq -r '.turn // 0' <<<"$old" 2>/dev/null || echo 0)" -gt "$turn" ]; then
    unlock; [ "$(cat "$pending" 2>/dev/null)" = "$turn" ] && rm -f "$pending"; return
  fi
  out=$(printf '今の作業ツリー:\n%s\n\n今回のやりとり:\n%s\n' "$old" "$turn_text" |
    env -u HC_TERMINAL_ID HERDR_TIMELINE_SKIP=1 claude -p --model haiku --tools "" --no-session-persistence \
      --setting-sources "" --strict-mcp-config --disable-slash-commands \
      --output-format json --json-schema "$SCHEMA" "$PROMPT" 2>/dev/null |
    jq -c '.structured_output // empty' 2>/dev/null)
  if [ -n "$out" ] && [ "$(jq -r .changed <<<"$out")" = true ] &&
     [ "$(jq -r '.turn // 0' "$plan" 2>/dev/null || echo 0)" -le "$turn" ]; then
    jq -n --argjson out "$out" --argjson old "$old" --argjson t "$(date +%s)" --argjson turn "$turn" '
      {goal: $out.goal,
       started: (if $out.new_goal or (($old.items // []) | length) == 0 then $t else ($old.started // $t) end),
       updated: $t, turn: $turn,
       items: [ $out.items[] | {title, state} + (if (.children // []) | length > 0 then {children: [ .children[] | {title, state} ]} else {} end) ]}
    ' >"$plan.tmp.$$" && mv "$plan.tmp.$$" "$plan"
  fi
  unlock
  # 自分の更新の印だけを消す（後の更新が置き直した印は残す）。
  [ "$(cat "$pending" 2>/dev/null)" = "$turn" ] && rm -f "$pending"
}

case "$1" in
  start)
    case "$(jq -r '.source // ""' <<<"$input")" in
      startup|clear)
        # 消すのではなく、新しい turn の空のツリーを置く。裏で動いている古い更新が書き戻さないように。
        jq -n --argjson turn "$(now_ms)" '{goal: "", items: [], turn: $turn}' >"$plan.tmp.$$" && mv "$plan.tmp.$$" "$plan"
        rm -f "$pending"
        ;;
    esac
    ;;
  stop)
    text=$(this_turn)
    [ -n "$text" ] || exit 0
    turn=$(now_ms)
    echo "$turn" >"$pending"
    ( update "$turn" "$text" ) </dev/null >/dev/null 2>&1 &
    disown
    ;;
esac
exit 0
