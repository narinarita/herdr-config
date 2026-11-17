#!/bin/bash
# Herdr の右パネル (timeline mod) に出す作業ツリーを、Claude Code の hook から更新する。
# Herdr のターミナル ($HC_TERMINAL_ID) で動いているときだけ動く。
#
# 使い方 (~/.claude/settings.json の hooks から、種類を引数で渡す):
#   prompt  UserPromptSubmit  指示を送った時点で、目標と項目の状態だけを直す（指示にあたる項目を doing にする。
#                         なければ 1 つ足す。別の目標なら目標を変える）。作業を細かく分けるのは stop に任せる
#   stop    Stop          今回のやりとり（指示・返答・操作）と今のツリーを Haiku に渡し、更新したツリーを書く。
#   どちらも 2〜5 秒かかるので、バックグラウンドで動かして Claude を待たせない
#   start   SessionStart  新しいセッション（起動・/clear）では、前の作業のツリーを空にする。再開 (resume) では残す
#
# 書き先: ~/.local/state/herdr-timeline/<terminal>.plan.json
#   {"goal": "...", "started": 秒, "updated": 秒, "turn": ミリ秒,
#    "items": [{"title": "...", "state": "done|doing|waiting|todo", "children": [...]}],
#    "past": [{"goal": "...", "started": 秒, "ended": 秒, "items": [...]}, ...]}
# 別の目標に移るときは、前の目標を（終わっていても途中でも）past の先頭に移す。新しいものほど前、20 件まで。
# past は Haiku には渡さない。新しいセッション（起動・/clear）で空にする。
# 新しいセッションで空にしたときは "cleared" にその時刻を置き、それより前に始まった更新は書かない。
# 更新中は <terminal>.plan.pending に、その更新の turn を置く（mod が「更新中…」を出す）。
# 作業ツリーの各項目は状態だけを持つ（% は持たない）ので、作業の区切りごとの更新で十分。

[ -n "$HC_TERMINAL_ID" ] || exit 0
[ -z "$HERDR_TIMELINE_SKIP" ] || exit 0   # 更新用の claude -p から呼ばれたとき
command -v jq >/dev/null || exit 0

# Claude が Bash から動かした claude -p も HC_TERMINAL_ID を受け継ぎ、この hook を呼ぶ。
# 親をたどって最初に出会う claude が、このターミナルの前面のプロセス（本物の Claude）でなければ何もしない。
if command -v hc >/dev/null; then
  fg=$(hc get "$HC_TERMINAL_ID" --json 2>/dev/null | jq -r '.foreground.pid // empty' 2>/dev/null)
  if [ -n "$fg" ]; then
    p=$PPID
    for _ in 1 2 3 4 5 6 7 8; do
      [ -n "$p" ] && [ "$p" -gt 1 ] || break
      if [ "$(basename "$(ps -o comm= -p "$p" 2>/dev/null)")" = claude ]; then
        [ "$p" = "$fg" ] || exit 0
        break
      fi
      p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    done
  fi
fi

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
        "state": {"enum": ["done", "doing", "waiting", "todo"]},
        "children": {"type": "array", "items": {
          "type": "object",
          "properties": {"title": {"type": "string"}, "state": {"enum": ["done", "doing", "waiting", "todo"]}},
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
- state: done は終わった作業。doing は今進めている作業。waiting は、エージェントがユーザーに質問・確認・判断を求めて、その返事を待っている作業（返答の最後でユーザーに聞いているなら、その項目を waiting にする）。todo はまだ手を付けていない作業。
- 今のツリーで waiting の項目は、今回ユーザーが指示を送った（返事をした）ので、done にする。
- 今のツリーがあり、今回の指示が同じ目標の続きなら、new_goal は false。既存の項目の title と順番は変えず、state だけ直し、新しく出てきた作業を足す。
- ただし、子のない項目の作業が今回いくつかに分かれて進んだなら、その項目の children に分けて入れる（項目の title は変えない）。指示の時点で足した大まかな項目は、こうして分ける。
- 足すと末端が12個を超えるときは、子が全部 done の親項目から順に、子を消して親1行（done）にまとめて数を減らす。
- 今回の指示が別の目標なら、new_goal を true にして、新しいツリーを作る。
- 質問に答えただけ、または雑談だけで作業が進んでいないなら、changed を false にして、今のツリーをそのまま返す（今のツリーがなければ goal は空、items は空）。それ以外は changed を true。
- 話に出ていない作業を推測で足さない。ユーザーが頼んだ作業と、エージェントがこれからやると言った作業は todo で足してよい。'

PROMPT_START='あなたは、AI エージェントの作業を作業ツリーとして管理する係です。
標準入力には「今の作業ツリー」（JSON。まだなければ null か、items が空）と、ユーザーが今送った「指示」があります。エージェントはまだ作業を始めていません。
次のことだけをして、作業ツリーを返してください。作業を細かく分けたり、推測で項目を足したりしないでください（細かく分けるのは、エージェントが作業を終えた後の別の更新で行います）。
- 今のツリーがない（null か items が空）ときは、別の目標のときと同じにする。
- 今のツリーで waiting の項目は、ユーザーが返事をしたので done にする（目標の続きのときも、別の目標のときも）。
- 指示が今の目標の続きなら、new_goal は false。goal と既存の項目の title・順番は変えない。指示にあたる項目があれば、その state を doing にする（子のある項目なら、あたる子を doing に）。なければ、指示を表す項目を1つ（25字以内、state は doing）末尾に足す。
- 指示が別の目標なら、new_goal を true にし、goal を指示から日本語1文（40字以内）で書き、items は指示を表す項目1つ（state は doing）だけにする。
- 指示が質問や雑談だけで作業を頼んでいないなら、changed を false にして、今のツリーをそのまま返す。それ以外は changed を true。'

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
# 3 分待っても取れなければ（落ちた更新が残したロック）、取り除いて取り直す。
lock() {
  local i=0
  until mkdir "$plan.lock" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -gt 900 ]; then rmdir "$plan.lock" 2>/dev/null; i=0; fi
    sleep 0.2
  done
}
unlock() { rmdir "$plan.lock" 2>/dev/null; }

update() {
  local turn="$1" turn_text="$2" prompt="$3" old out
  lock
  old=$(cat "$plan" 2>/dev/null || echo null)
  jq -e . <<<"$old" >/dev/null 2>&1 || old=null
  # 待っている間に新しいセッションで空にされていたら、それより前のやりとりでは更新しない。
  # （ロックを取る順番は決まっていないので、ほかの更新との前後では捨てない）
  if [ "$(jq -r '.cleared // 0' <<<"$old" 2>/dev/null || echo 0)" -gt "$turn" ]; then
    unlock; [ "$(cat "$pending" 2>/dev/null)" = "$turn" ] && rm -f "$pending"; return
  fi
  # これまでの目標 (past) は渡さない（今の目標の更新には要らず、入力が長くなるだけ）。
  out=$(printf '今の作業ツリー:\n%s\n\n今回のやりとり:\n%s\n' "$(jq -c 'if type == "object" then del(.past) else . end' <<<"$old")" "$turn_text" |
    env -u HC_TERMINAL_ID HERDR_TIMELINE_SKIP=1 perl -e 'alarm shift; exec @ARGV' 120 claude -p --model haiku --tools "" --no-session-persistence \
      --setting-sources "" --strict-mcp-config --disable-slash-commands \
      --output-format json --json-schema "$SCHEMA" "$prompt" 2>/dev/null |
    jq -c '.structured_output // empty' 2>/dev/null)
  if [ -n "$out" ] && [ "$(jq -r .changed <<<"$out")" = true ] &&
     [ "$(jq -r '.cleared // 0' "$plan" 2>/dev/null || echo 0)" -le "$turn" ]; then
    jq -n --argjson out "$out" --argjson old "$old" --argjson t "$(date +%s)" --argjson turn "$turn" '
      {goal: $out.goal,
       started: (if $out.new_goal or (($old.items // []) | length) == 0 then $t else ($old.started // $t) end),
       updated: $t, turn: ([$turn, ($old.turn // 0)] | max), cleared: ($old.cleared // 0),
       items: [ $out.items[] | {title, state} + (if (.children // []) | length > 0 then {children: [ .children[] | {title, state} ]} else {} end) ],
       # 別の目標に移るとき、前の目標を past の先頭に残す。
       past: ((if $out.new_goal and (($old.items // []) | length) > 0
               then [{goal: ($old.goal // ""), started: ($old.started // null), ended: $t, items: $old.items}] else [] end)
              + ($old.past // []))[0:20]}
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
        jq -n --argjson turn "$(now_ms)" '{goal: "", items: [], turn: $turn, cleared: $turn}' >"$plan.tmp.$$" && mv "$plan.tmp.$$" "$plan"
        rm -f "$pending"
        ;;
    esac
    ;;
  stop)
    text=$(this_turn)
    [ -n "$text" ] || exit 0
    turn=$(now_ms)
    echo "$turn" >"$pending"
    ( update "$turn" "$text" "$PROMPT" ) </dev/null >/dev/null 2>&1 &
    disown
    ;;
  prompt)
    text=$(jq -r '.prompt // "" | .[0:6000]' <<<"$input")   # 文字単位で切る
    # 引数のないスラッシュコマンド（/clear、/compact など）と、タグで始まるメッセージは指示と見なさない。
    # 文字列全体で判定する（grep だと、複数行の指示の 1 行が /path だけでも当たる）。
    case "$text" in
      ""|"<"*) exit 0 ;;
    esac
    [[ $text =~ ^/[^[:space:]]+[[:space:]]*$ ]] && exit 0
    turn=$(now_ms)
    echo "$turn" >"$pending"
    ( update "$turn" "ユーザー: $text" "$PROMPT_START" ) </dev/null >/dev/null 2>&1 &
    disown
    ;;
esac
exit 0
