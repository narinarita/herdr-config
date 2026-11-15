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
  # JSON の文字列に入れるため、\ と " をエスケープする
  file=${file//\\/\\\\}
  file=${file//\"/\\\"}
  local id="e$(date +%s)$RANDOM"
  herdr-app do pane.split "{\"direction\":\"right\",\"mod\":\"editor\",\"props\":{\"id\":\"$id\",\"file\":\"$file\",\"on\":null}}" >/dev/null
}
