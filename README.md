# herdr-config

[Herdr](https://herdr.dev) の個人設定です。レイアウト `my-main` と、そのレイアウトが使う mod を入れています。

## 中身

| ファイル | 内容 |
| --- | --- |
| `layouts/my-main.json` | Herdr (main) を元にしたレイアウト。左のサイドバーは `branch-tree`（Space → ブランチ → Agent のツリー）、右に Files（`my-files`）/ Changes / Timeline（`timeline`）パネル、上のタブの帯は `my-tabs`、下のステータスバーの右端に `pomodoro` を置く |
| `mods/branch-tree/` | サイドバー。リポジトリの下に、本体のブランチ（ブランチのアイコン）と worktree（フォルダーのアイコン）を並べ、その下にそれぞれの Agent をぶら下げる（いなければ「Agent なし」）。本体の Space を閉じていても、リポジトリ名の見出しの下に worktree をまとめる。git でない Space は Agent を直下に置く。下端に Claude Code の使用量（5 時間枠と週の上限）のバーと、状態ごとの Agent 数を出す。Herdr の `spaces` と `agents` の代わり |
| `mods/my-pane/` | ペインのヘッダー（標準の `pane` mod 0.1.13 の複製） |
| `mods/claude-worktree/` | 新しい git worktree とその space を作り、Claude Code を起動するダイアログ（Command + Shift + N） |
| `mods/editor/` | ファイルを Herdr の中のペインで開いて編集するエディタ。保存は Command + S |
| `mods/my-files/` | Files パネル（標準の `files` mod 0.1.15 の複製）。ファイルをクリックすると `editor` で開く |
| `shell/e.zsh` | シェルの `e <ファイル>` で `editor` を開く関数。`~/.zshrc` で `source` する |
| `mods/pomodoro/` | ステータスバーのポモドーロタイマー。全 space で共通の 1 つ |
| `mods/my-tabs/` | タブの帯（標準の `tabs` mod 0.1.16 の複製）。右上の Files / Changes の横に Timeline の切り替えを足す |
| `mods/timeline/` | 右パネルの Timeline。フォーカスしているターミナルの Claude の目標と作業ツリーを出す |
| `hooks/timeline.sh` | 作業ツリーを書く Claude Code の hook（Stop / UserPromptSubmit / SessionStart）。`install.sh` が `~/.claude/hooks/herdr-timeline.sh` に置き、`~/.claude/settings.json` に登録する |
| `hooks/usage.sh` | Claude Code の使用量を書き出す statusline 用のスクリプト。`install.sh` が `~/.claude/hooks/herdr-usage.sh` に置き、`~/.claude/settings.json` の今の statusline の前に挟む |
| `keys.json` | macOS 向けの `cmd-*` キー割り当て（`cmd-shift-n` で `claude-worktree` を開く。`editor` の中では `cmd-s` で保存） |
| `settings.json` | 外観とフォントの設定 |

### editor でできること

ファイルを Xcode などの外部アプリで開かずに、Herdr の中のペインで編集します。

- 開き方は2つ。右の Files パネルでファイルをクリックするか、Herdr のターミナルで `e <ファイル>` を実行する
- 同じタブにエディタのペインがあればそこで差し替え、なければ今のペインの右に分割して開く。1つのペインに開くのは1つのファイル
- Command + S で保存する。保存していない変更があると、ヘッダーのファイル名の横に点が付く
- 保存していない変更があるまま別のファイルを開くと、保存して開くか、破棄して開くかを聞く
- Claude などがファイルを書き換えると、保存していない変更がなければそのまま読み直す。あれば、読み直すか手元の変更を残すかを聞く
- 開いたあとにファイルが変わっていたら、保存しても上書きせずに確認を出す
- Markdown はヘッダーの鉛筆と目のアイコンで、編集とプレビューを切り替える
- 別のマシンの space のファイルは読み取り専用で開き、10 秒ごとに読み直す
- 1 MB を超えるファイルと、テキストでないファイルは開かずに理由だけ出す

LSP、補完、検索、1つのペインの中のタブは入れていません。

`e` を使うには、`~/.zshrc` に次を足します。

```sh
source ~/Desktop/herdr-config/shell/e.zsh   # clone した場所に合わせる
```

注意点:

- ペインのヘッダーの × で閉じると、保存していない変更は消える（閉じる前に止める手段が Herdr にない）
- ターミナルに出たパスを Command + クリックしたときは、今までどおり macOS の既定のアプリで開く
- エディタは `shared("editor.panes")` にペインの対応を、`shared("editor.request")` に差し替えの依頼を置く

### timeline でできること

右上の Timeline を押すと、右パネルに、フォーカスしているターミナルで動いている Claude の作業を、目標と作業ツリーで出します。

- 上に目標と全体の進み具合（終わった件数 / 全件数、始めてからの時間、%）
- その下に作業ツリー。入れ子は2段まで。項目ごとに状態（● 終わった、◐ 進めている、◇ あなたの返事待ち、○ まだ）だけを出し、進めている項目と返事待ちの項目には背景を付ける。返事待ちの項目があると、目標の札が「あなた待ち」になる
- 下に「これまでの目標」。同じセッションで前に取り組んだ目標を 1 行ずつ畳んで出す（● 終わった、◐ 途中で別の目標に移った）。件数とかかった時間を付け、押すと開いて項目を見られる。新しいものほど上
- 目標が 100% になると、その目標を畳んで「これまでの目標」の先頭に移し、上には「次の作業を頼むと、ここに出ます」だけを出す。新しい作業を頼むと、新しい目標が畳んだ目標の上に出る
- エディタなどターミナルでないペインに移っても、直前のターミナルの作業ツリーを出したままにする

作業ツリーの作り方:

- Claude が返答を終えるたびに、`hooks/timeline.sh`（Stop hook）が今回のやりとり（指示・返答・使った操作）と今のツリーを Haiku（`claude -p --model haiku`）に渡し、更新したツリーを書く。同じ目標の続きなら項目は変えずに状態だけ直し、別の目標なら作り直す。質問に答えただけのときは変えない
- 指示を送った時点でも（UserPromptSubmit hook）、目標と項目の状態だけを直す。返事待ち（◇）の項目を ● にし、指示にあたる項目を ◐ にし、なければ1つ足し、別の目標なら目標を変える。作業を細かく分けるのは返答の終わりに任せる。質問や雑談、引数のないスラッシュコマンドでは変えない
- 項目は状態だけを持つ（% を持たない）ので、作業の区切りごとの更新で、実際の作業とのずれが小さい
- 更新は 2〜5 秒かかるので、バックグラウンドで動かし、その間はパネルに「更新中…」を出す
- 別の目標に移るときは、前の目標を（終わっていても途中でも）`past` に移して残す。20 件まで。`past` は Haiku には渡さない
- 新しいセッション（起動・`/clear`）では、前の作業のツリーと「これまでの目標」を空にする。再開（resume）では残す
- 長いやりとりは、指示と最後の部分を残して間を省いて渡す。スキルの展開や通知など、ユーザーが書いたのではないメッセージは指示と見なさない
- 更新は 1 つずつ順番に行う。前の更新が書いたツリーを元に次の更新が作る
- どの Space の Claude でも動くよう、hook はグローバルの `~/.claude/settings.json` に登録する。Herdr の外（`$HC_TERMINAL_ID` がない）では何もしない
- 書き先は `~/.local/state/herdr-timeline/<ターミナル ID>.plan.json`
- 更新用の `claude -p` は hook を読まず（`--setting-sources ""`）、`HC_TERMINAL_ID` を外して動かすので、自分自身の返答でツリーを更新したり、再開用の記録を上書きしたりしない
- 必要なもの: `jq` と、ログイン済みの Claude Code（「入れ方」の「必要なもの」）

注意点:

- 指示を送ったときと Claude が返答を終えたときに、Haiku を 1 回ずつ呼ぶので、そのぶん使用量が増える
- ツリーは Haiku の解釈なので、項目の切り方や状態が実際とずれることがある
- 別のマシンの Space のターミナルの作業ツリーは出せない
- 登録前から動いている Claude のセッションでは更新されないことがある。そのときは Claude を起動し直す

### サイドバーの使用量

左のサイドバーの下端（状態ごとの Agent 数の上）に、Claude Code の使用量を 2 本の細いバーで出します。

- 左に「h」（5 時間枠）と「w」（週の上限）、その下にリセットの時刻（`1:10 (水)`）。右にバーと使った割合（%）
- 80% から黄、100% で赤。上限に達した枠は、リセットの時刻も赤にする
- マウスを乗せると、リセットまでの残り時間が出る
- サイドバーを細くした（rail の）ときは出さない

値の取り方:

- Claude Code が statusline に渡す JSON の `rate_limits` を、`hooks/usage.sh` が `~/.local/state/herdr-usage/limits.json` に書く。値が変わったときだけ書く。サイドバーはそれを読むだけ
- `install.sh` は `~/.claude/settings.json` の `statusLine.command` の前に `~/.claude/hooks/herdr-usage.sh tee |` を足す。statusline を使っていなければ、何も出さない `herdr-usage.sh` だけを登録する
- 使用量はアカウントごとなので、Herdr の外の Claude からも書く

注意点:

- statusline は Claude Code が動いている間しか呼ばれない。Claude を使っていない間は、最後に取った値のまま。リセット時刻を過ぎた値は 0% として出す
- 一度も値を取れていないうちは、バーを出さない

### pomodoro でできること

ステータスバーの右端に、輪・「集中」か「休憩」・残り時間を出します。タイマーは全 space で共通の 1 つで、Herdr を閉じても状態が残ります。

- 表示をクリックすると小さな窓が開き、開始（再開）・一時停止・次へ・リセットができる。Esc か窓の外のクリックで閉じる
- 集中 25 分、休憩 5 分。4 回目の集中のあとは 15 分の休憩
- 集中が終わると休憩がすぐ始まる。休憩が終わると次の集中は止めたまま待つ
- 切り替わるときに通知を出し、macOS の Glass の音を鳴らす（`settings.json` の `sounds.enabled` が `false` なら鳴らさない）
- Herdr を閉じている間に時間が過ぎていた回は、知らせずに次へ進める

### claude-worktree でできること

作業を始めるときに、新しい git worktree とその space を作り、Claude Code を起動します。

1. サイドバーで、作業するリポジトリの space（またはその下の worktree）を選ぶ
2. Command + Shift + N を押す
3. 入力欄が出たら、そのまま Enter を押す（ブランチ名を入れてもよい）

入力欄の下に、作る予定のブランチ、起点、置き場所が表示されます。Esc で閉じます。

| 入力 | 作られるブランチ |
| --- | --- |
| 空のまま Enter | 仮の名前 `wip/<月日>-<時分>`（例 `wip/1112-1835`）。同じ名前があれば `-2`、`-3` を付ける |
| 名前を入れる（例 `feature/snooze-alarm`） | 入れた名前のまま。ブランチ名に使えない文字はエラーになる |

仮の名前は、作業の中身が見えてから、push や PR の前に `git branch -m <新しい名前>` で付け直します。

Enter を押すと、次の順に動きます。

1. `git fetch origin` で origin を最新にする。失敗したらエラーを表示し、もう一度 Enter で手元の参照のまま進める
2. origin の既定ブランチ（`refs/remotes/origin/HEAD`）から、新しいブランチで worktree を作る
   - 置き場所は `<リポジトリ>/.claude/worktrees/<ブランチ名の / を - にしたもの>`
   - 新しいブランチは `--no-track` で作る。既定ブランチを追跡しないので、うっかり既定ブランチに push や pull をしない
   - 同じ名前のブランチが手元にあればそれを使い、origin にだけあればそれを追跡して使う
3. その worktree をフォルダーにした space を作り、`claude` を起動する。space には名前を付けないので、サイドバーではリポジトリの space の下に並ぶ

Herdr 付属の New worktree との違いは、起点（付属は今の HEAD、この mod は fetch した origin の既定ブランチ）、置き場所（付属は `~/.herdr/worktrees/<repo>/`）、Claude の起動（付属は別に起動が要る）です。

注意点:

- `.claude/worktrees/` がそのリポジトリで ignore されていなければ、メインのチェックアウトの `git status` に未追跡として出る。共有の `.gitignore` は変えずに、`.git/info/exclude` に `.claude/worktrees/` を足せばよい
- 別のマシンの space では使えない（この Mac の space だけ）
- origin の既定ブランチが分からないときは、`git remote set-head origin -a` を実行する
- `.env` のコピーや `pnpm install` はしない。必要なら worktree を作ったあとに行う
- 作業が終わった worktree は、サイドバーでその space のメニューから Remove worktree を選ぶと、space を閉じて worktree を消せる。ブランチは残るので、不要なら `git -C <メインのチェックアウト> branch -D <ブランチ名>` で消す

claude-worktree は `git`（`fetch` を含むのでネットワークにつながります）を実行します。

## 入れ方

```sh
git clone https://github.com/narinarita/herdr-config.git
cd herdr-config
./install.sh
```

`install.sh` は `~/.config/herdr-app` にファイルをコピーします（`HERDR_APP_HOME` を設定していればその場所）。上書きする前のファイルは `~/.config/herdr-app/.backup-<日時>/` に残します。そのあと Herdr でレイアウト `my-main` に切り替えます（`herdr-app do layout.switch '{"name":"my-main"}'`）。

### 必要なもの

- Herdr（`herdr-app` と、付いてくる `hc`）
- `jq`（`brew install jq`）。ないと timeline の hook を登録しない
- Claude Code（`claude`）にログイン済みであること。timeline は作業ツリーを作るのに `claude -p --model haiku` を呼ぶ
- フォント HackGen（下の「フォント」）

### 入れると変わるもの

`~/.config/herdr-app` のほかに、次のものを書き換えます。

| 場所 | 変わること |
| --- | --- |
| `~/.config/herdr-app/settings.json` | 外観（dark）とフォントを、このリポジトリの設定で上書きする。前のファイルは `.backup-<日時>/` に残る |
| `~/.claude/hooks/herdr-timeline.sh` | timeline の hook を置く |
| `~/.claude/settings.json` | Claude Code の hook を 3 つ登録する（`SessionStart`・`UserPromptSubmit`・`Stop`）。どのプロジェクトの Claude にも効くが、Herdr の外（`$HC_TERMINAL_ID` がない）では何もしない。書き換える前のファイルは `~/.claude/settings.json.bak-<日時>` に残る |
| `~/.local/state/herdr-timeline/` | 作業ツリーの記録を置く |

timeline の hook は、Herdr の中で Claude に指示を送るたび、返答が終わるたびに Haiku を 1 回ずつ呼びます。そのぶん Claude の使用量が増えます。

### timeline の hook を外す

`~/.claude/settings.json` から `herdr-timeline.sh` を含む hook を消し、hook 本体と記録を消します。

```sh
jq '.hooks |= (with_entries(.value |= map(select(any(.hooks[]?; .command | contains("herdr-timeline.sh")) | not)))
               | with_entries(select(.value | length > 0)))' ~/.claude/settings.json > /tmp/s.json \
  && cat /tmp/s.json > ~/.claude/settings.json && rm /tmp/s.json
rm -f ~/.claude/hooks/herdr-timeline.sh
rm -rf ~/.local/state/herdr-timeline
```

もう一度 `install.sh` を実行すると、また登録されます。

### フォント

`settings.json` はターミナルのフォントに [HackGen](https://github.com/yuru7/HackGen) の「HackGen Console」を使います。日本語と英数字の幅がちょうど 2:1 になり、日本語の字間が空きません。先に入れておいてください。

```sh
brew install --cask font-hackgen
```

Herdr が起動したあとでフォントを入れた場合は、Herdr を再起動するか、フォントのファイルを `~/.config/herdr-app/fonts/` にコピーしてください。
