# Herdr の中のエディタ（editor mod）でファイルを開く。~/.zshrc で source する。
#   e README.md
# 今のタブにエディタのペインがあればそこで差し替え、なければ右に分割して開く。
e() {
  if [ $# -ne 1 ]; then
    echo "使い方: e <ファイル>" >&2
    return 2
  fi
  if [ -z "${HC_TERMINAL_ID:-}" ] || ! command -v herdr-app >/dev/null 2>&1; then
    echo "e: Herdr のターミナルの中で使ってください" >&2
    return 1
  fi
  local file=${1:a}
  if [ ! -f "$file" ]; then
    echo "e: ファイルがありません: $file" >&2
    return 1
  fi
  local id="e$(date +%s)$RANDOM" args
  # JSON は jq で組み立てる（改行・タブ・制御文字を含むファイル名でも壊れないように）。
  if command -v jq >/dev/null 2>&1; then
    args=$(jq -cn --arg id "$id" --arg file "$file" '{direction: "right", mod: "editor", props: {id: $id, file: $file, on: null}}') || return 1
  else
    if [[ $file == *[[:cntrl:]]* ]]; then
      echo "e: 制御文字を含むファイル名は jq がないと開けません" >&2
      return 1
    fi
    local f=${file//\\/\\\\}
    f=${f//\"/\\\"}
    args="{\"direction\":\"right\",\"mod\":\"editor\",\"props\":{\"id\":\"$id\",\"file\":\"$f\",\"on\":null}}"
  fi
  herdr-app do pane.split "$args" >/dev/null
}
