#!/bin/bash
# Herdr の右パネル (timeline mod) に出す出来事を、Claude Code の hook から記録する。
# Herdr のターミナル ($HC_TERMINAL_ID) で動いているときだけ、
# ~/.local/state/herdr-timeline/<terminal>.jsonl に 1 行 1 件で追記する。
#
# 使い方 (~/.claude/settings.json の hooks から、種類を引数で渡す):
#   start   SessionStart       セッションの開始
#   prompt  UserPromptSubmit   あなたの指示
#   stop    Stop               最後の返答 (Last report)。80 字を超えるものはバックグラウンドで Haiku に要約させ、できたら差し替える
#   notify  Notification       許可や質問で止まった (確認待ち)
#   tool    PostToolUse        タスクの変化 (TodoWrite / TaskCreate / TaskUpdate) と PR の作成
#
# 1 件の形: {"t": 秒, "kind": "start|you|report|summary|wait|task|pr", "text": "...", "id"?: "...", "session": "..."}
# summary は同じ id の report の本文を差し替える。

[ -n "$HC_TERMINAL_ID" ] || exit 0
[ -z "$HERDR_TIMELINE_SKIP" ] || exit 0   # 要約用の claude -p から呼ばれたとき
command -v jq >/dev/null || exit 0

dir="$HOME/.local/state/herdr-timeline"
file="$dir/${HC_TERMINAL_ID//\//_}.jsonl"
mkdir -p "$dir"
input=$(cat)
session=$(jq -r '.session_id // ""' <<<"$input")

# kind, text, [id] を 1 行追記する。本文は 1 件 400 字まで。
emit() {
  jq -cn --arg kind "$1" --arg text "$2" --arg id "${3:-}" --arg session "$session" --argjson t "$(date +%s)" \
    '{t: $t, kind: $kind, text: ($text | gsub("\\s+"; " ") | ltrimstr(" ") | .[0:400]), session: $session} + (if $id == "" then {} else {id: $id} end)' >>"$file"
}

# 長くなりすぎたら後ろの 400 件だけ残す。
trim() {
  local n
  n=$(wc -l <"$file" 2>/dev/null || echo 0)
  if [ "$n" -gt 600 ]; then
    tail -n 400 "$file" >"$file.tmp" && mv "$file.tmp" "$file"
  fi
}

# 最後の返答の本文。Stop の入力にあればそれを、なければ transcript の最後の assistant の text を使う。
last_reply() {
  local text path
  text=$(jq -r '.last_assistant_message // empty' <<<"$input")
  if [ -z "$text" ]; then
    path=$(jq -r '.transcript_path // empty' <<<"$input")
    [ -f "$path" ] || return
    text=$(tail -n 400 "$path" | jq -rs '
      [ .[] | select(.type == "assistant") | .message.content
        | if type == "array" then [ .[] | select(.type == "text") | .text ] | join("\n") else . end
        | select(type == "string" and length > 0) ] | last // empty' 2>/dev/null)
  fi
  printf '%s' "$text"
}

summarize() {
  local id="$1" text="$2" summary
  summary=$(printf '%s' "$text" | head -c 8000 | env -u HC_TERMINAL_ID HERDR_TIMELINE_SKIP=1 \
    claude -p --model haiku --tools "" --no-session-persistence --setting-sources "" \
      --strict-mcp-config --disable-slash-commands \
      "標準入力は、AI エージェントが作業の区切りでユーザーに返した返答です。サイドパネルで状況を一目でつかめるよう、何をしたか・何を待っているかを日本語1〜2文（80字以内）で要約してください。要約だけを出力してください。" \
      2>/dev/null)
  [ -n "$summary" ] && emit summary "$summary" "$id"
}

case "$1" in
  start)
    case "$(jq -r '.source // ""' <<<"$input")" in
      clear) emit start "/clear で新しいセッション" ;;
      resume) emit start "セッションを再開" ;;
      compact) ;;   # 同じ作業の続きなので記録しない
      *) emit start "セッション開始" ;;
    esac
    ;;

  prompt)
    text=$(jq -r '.prompt // ""' <<<"$input")
    [ -n "$text" ] && emit you "$text"
    ;;

  stop)
    text=$(last_reply)
    [ -n "$text" ] || exit 0
    id="r$(date +%s)$$"
    emit report "$text" "$id"
    # 短い返答はそのまま。長いものだけ要約する (2 秒ほどかかるので待たない)。
    if [ "${#text}" -gt 80 ]; then
      ( summarize "$id" "$text" ) </dev/null >/dev/null 2>&1 &
      disown
    fi
    trim
    ;;

  notify)
    text=$(jq -r '.message // ""' <<<"$input")
    [ -n "$text" ] && emit wait "$text"
    ;;

  tool)
    tool=$(jq -r '.tool_name // ""' <<<"$input")
    case "$tool" in
      TodoWrite)
        # 前回の一覧と比べて、状態が変わった項目だけ記録する（新しく増えた未着手の項目は記録しない）。
        state="$dir/${HC_TERMINAL_ID//\//_}.todos.json"
        now=$(jq -c '[.tool_input.todos // [] | .[] | {content, status}]' <<<"$input")
        before=$(cat "$state" 2>/dev/null || echo '[]')
        jq -r --argjson before "$before" '
          .[] as $n
          | ($before | map(select(.content == $n.content)) | first) as $o
          | select(if $o == null then $n.status != "pending" else $o.status != $n.status end)
          | "\($n.content) → \({"pending":"todo","in_progress":"in progress","completed":"done"}[$n.status] // $n.status)"' <<<"$now" |
          while IFS= read -r line; do emit task "$line"; done
        printf '%s' "$now" >"$state"
        ;;
      TaskCreate)
        subject=$(jq -r '.tool_input.subject // .tool_input.description // ""' <<<"$input")
        [ -n "$subject" ] && emit task "$subject → todo"
        ;;
      TaskUpdate)
        status=$(jq -r '.tool_input.status // ""' <<<"$input")
        [ -n "$status" ] || exit 0
        subject=$(jq -r '.tool_input.subject // .tool_response.task.subject // .tool_response.subject // ""' <<<"$input" 2>/dev/null)
        [ -n "$subject" ] || subject="タスク #$(jq -r '.tool_input.taskId // .tool_input.id // "?"' <<<"$input")"
        label=$status
        [ "$status" = in_progress ] && label="in progress"
        [ "$status" = completed ] && label=done
        [ "$status" = pending ] && label=todo
        emit task "$subject → $label"
        ;;
      Bash)
        cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
        case "$cmd" in
          *"gh pr create"*|*"gh pr merge"*|*"gh pr ready"*)
            out=$(jq -r '.tool_response | if type == "object" then (.stdout // "") else tostring end' <<<"$input")
            url=$(grep -oE 'https://github\.com/[^ ]+/pull/[0-9]+' <<<"$out" | head -1)
            [ -n "$url" ] || exit 0
            ref=$(sed -E 's#https://github\.com/[^/]+/([^/]+)/pull/([0-9]+)#\1\#\2#' <<<"$url")
            case "$cmd" in
              *"gh pr merge"*) emit pr "$ref をマージ" ;;
              *"gh pr ready"*) emit pr "$ref を ready に" ;;
              *) emit pr "$ref を作成" ;;
            esac
            ;;
        esac
        ;;
    esac
    ;;
esac
exit 0
