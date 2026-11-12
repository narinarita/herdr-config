# herdr-config

[Herdr](https://herdr.dev) の個人設定です。レイアウト `my-main` と、そのレイアウトが使う mod を入れています。

## 中身

| ファイル | 内容 |
| --- | --- |
| `layouts/my-main.json` | Herdr (main) を元にしたレイアウト。左のサイドバーに `space-tree`、右に Files / Changes パネルを置く |
| `mods/space-tree/` | Spaces と Agents をひとつのツリーにまとめたサイドバー（標準の `spaces` mod 0.1.13 を複製して改造） |
| `mods/my-pane/` | ペインのヘッダー（標準の `pane` mod 0.1.13 の複製） |
| `mods/claude-worktree/` | 新しい git worktree とその space を作り、Claude Code を起動するダイアログ（Command + Shift + N） |
| `keys.json` | macOS 向けの `cmd-*` キー割り当て（`cmd-shift-n` で `claude-worktree` を開く） |
| `settings.json` | 外観とフォントの設定 |

### space-tree でできること

- 各 Space の下に、その Space で動いているエージェントをタブの順に並べる（サブエージェントはさらにその下）
- Space の行の **+** から、その Space にエージェントやターミナルを起動する（1〜9 でエージェント、T でターミナル）
- エージェントの行をドラッグして並べ替える（タブの順番が変わる）
- Space の行の山形のボタンで、エージェントを折りたたむ（折りたたむと件数と一番急ぎの状態を表示）

space-tree は、ワークツリーと git の状態を見るために `git` と `hc`（herdr-core）を実行します。ネットワークにはつながりません。

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

`install.sh` は `~/.config/herdr-app` にファイルをコピーします。上書きする前のファイルは `~/.config/herdr-app/.backup-<日時>/` に残します。そのあと Herdr でレイアウト `my-main` に切り替えます（`herdr-app do layout.switch '{"name":"my-main"}'`）。

### フォント

`settings.json` はターミナルのフォントに [HackGen](https://github.com/yuru7/HackGen) の「HackGen Console」を使います。日本語と英数字の幅がちょうど 2:1 になり、日本語の字間が空きません。先に入れておいてください。

```sh
brew install --cask font-hackgen
```

Herdr が起動したあとでフォントを入れた場合は、Herdr を再起動するか、フォントのファイルを `~/.config/herdr-app/fonts/` にコピーしてください。
