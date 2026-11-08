# herdr-config

[Herdr](https://herdr.dev) の個人設定です。レイアウト `my-main` と、そのレイアウトが使う mod を入れています。

## 中身

| ファイル | 内容 |
| --- | --- |
| `layouts/my-main.json` | Herdr (main) を元にしたレイアウト。左のサイドバーに `space-tree`、右に Files / Changes パネルを置く |
| `mods/space-tree/` | Spaces と Agents をひとつのツリーにまとめたサイドバー（標準の `spaces` mod 0.1.13 を複製して改造） |
| `mods/my-pane/` | ペインのヘッダー（標準の `pane` mod 0.1.13 の複製） |
| `keys.json` | macOS 向けの `cmd-*` キー割り当て |
| `settings.json` | 外観とフォントの設定 |

### space-tree でできること

- 各 Space の下に、その Space で動いているエージェントをタブの順に並べる（サブエージェントはさらにその下）
- Space の行の **+** から、その Space にエージェントやターミナルを起動する（1〜9 でエージェント、T でターミナル）
- エージェントの行をドラッグして並べ替える（タブの順番が変わる）
- Space の行の山形のボタンで、エージェントを折りたたむ（折りたたむと件数と一番急ぎの状態を表示）

space-tree は、ワークツリーと git の状態を見るために `git` と `hc`（herdr-core）を実行します。ネットワークにはつながりません。

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
