// エディタ。1 つのペインに 1 つのテキストファイルを開いて編集する。
//
// 開き方（どちらも props は { id, file, on }）:
//   - my-files でファイルをクリックする。同じタブにエディタがあればそこで差し替え、なければ右に分割する
//   - シェルの e 関数: herdr-app do pane.split '{"direction":"right","mod":"editor","props":{...}}'
// id は開く側が振る一意の文字列。props にはペインの ID が来ないので、
// shared("editor.panes") に { id: ペイン ID } を覚えて、差し替えの依頼の宛先にする。
// 差し替えの依頼は shared("editor.request") = { pane, file, on, at }。
//
// 保存は ⌘S だけ。writeTextFile に開いたときの中身を expected として渡すので、
// ほかで書き換えられたファイルは黙って上書きしない。
// 別のマシン（on がある）のファイルは読み取り専用（writeTextFile がこの Mac にしか書けないため）。

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, panes, focused, shared, setShared, run, nextCommand, exec, readTextFile, writeTextFile, watchFolder, theme, settings } from "herdr";

const PANES = "editor.panes";
const REQUEST = "editor.request";
const LIMIT = 1024 * 1024; // readTextFile が読める上限（1 MiB）
// Files と同じ言語名の対応。ほかは拡張子をそのまま渡す。
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };

const name = (path) => path.split("/").pop();
const folderOf = (path) => path.slice(0, path.lastIndexOf("/")) || "/";
const extOf = (path) => (name(path).includes(".") ? name(path).split(".").pop().toLowerCase() : "");
const isMarkdown = (path) => ["md", "markdown", "mdx"].includes(extOf(path));
const countLines = (text) => (text ? text.split("\n").length - Number(text.endsWith("\n")) : 0);
const sizeText = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export default class EditorPane extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.id = p.id ?? null;
    this.pane = null;
    this.handledAt = shared(REQUEST)?.at ?? 0;
    this.saving = false;
    this.state = null;

    if (p.file) this.open(p.file, p.on ?? null, cx);

    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "save" && this.isFocused()) this.save(false, cx);
        cx.notify();
      }
    });
    // 別のマシンのファイルはフォルダーを監視できないので、10 秒ごとに読み直す。
    cx.timer.every(10000, (cx) => { if (this.on && this.file) this.checkDisk(cx); });
  }

  // init の時点では新しいペインがまだ panes() に出ていないので、最初の render で調べる。
  // 同じタブにほかのエディタがあれば、そちらで開いてもらい、このペインは閉じる（シェルの e から来たとき）。
  resolvePane() {
    if (this.pane || this.closing) return;
    this.pane = this.findPane();
    if (!this.pane) return;
    const p = props() ?? {};
    const other = panes().find((x) => x.mod === "editor" && x.pane !== this.pane && x.tab === this.tabOf(this.pane));
    if (other && p.file && this.fresh) {
      this.closing = true;
      this.state?.release(); this.state = null; this.generation = (this.generation ?? 0) + 1;
      setShared(REQUEST, { pane: other.pane, file: p.file, on: p.on ?? null, at: Date.now() });
      run("pane.focus", { pane: other.pane });
      run("pane.close", { pane: this.pane });
    }
  }

  // 自分のペイン ID。初めて開いたときは、分割した直後でフォーカスがあるペインが自分。
  findPane() {
    const map = { ...(shared(PANES) ?? {}) };
    const alive = new Set(panes().filter((x) => x.mod === "editor").map((x) => x.pane));
    for (const [k, v] of Object.entries(map)) if (!alive.has(v)) delete map[k];
    let pane = this.id ? map[this.id] : null;
    this.fresh = !pane;
    if (!pane) {
      const f = focused()?.pane;
      const taken = new Set(Object.values(map));
      if (f && alive.has(f) && !taken.has(f)) pane = f;
    }
    if (this.id && pane) map[this.id] = pane;
    if (JSON.stringify(map) !== JSON.stringify(shared(PANES) ?? {})) setShared(PANES, map);
    return pane;
  }

  tabOf(pane) { return panes().find((x) => x.pane === pane)?.tab ?? null; }
  isFocused() { return Boolean(this.pane) && panes().find((x) => x.pane === this.pane)?.focused === true; }
  get dirty() { return Boolean(this.state) && !this.readonly && this.current !== this.saved; }
  get readonly() { return this.on !== null; }

  // 差し替えの依頼。保存していない変更があれば、帯で聞いてから開く。
  takeRequest(cx) {
    const r = shared(REQUEST);
    if (!r || r.pane !== this.pane || r.at <= this.handledAt) return;
    this.handledAt = r.at;
    if (r.file === this.file && r.on === this.on) return;
    if (this.dirty) { this.pending = { file: r.file, on: r.on ?? null }; this.banner = "switch"; return; }
    this.open(r.file, r.on ?? null, cx);
  }

  open(file, on, cx) {
    this.state?.release();
    this.waiting?.cancel?.(); this.waiting = null; // 前のファイルのフォルダーの見張りを止める
    Object.assign(this, { file, on, state: null, saved: "", current: "", lines: 0, error: null, banner: null, pending: null, note: "", preview: false });
    this.generation = (this.generation ?? 0) + 1;
    const generation = this.generation;
    cx.spawn(async (cx) => {
      try {
        const size = await exec("wc", ["-c", file], { on }).then((r) => (r.code === 0 ? Number(r.stdout.trim().split(/\s+/)[0]) : null)).catch(() => null);
        if (generation !== this.generation) return;
        if (size !== null && size > LIMIT) { this.error = `大きすぎるので開きません（${sizeText(size)}）。開けるのは 1 MB までです。`; return; }
        const text = await readTextFile(file, { on });
        if (generation !== this.generation) return;
        if (text === null) { this.error = "ファイルがありません。"; return; }
        if (text.includes("\0")) { this.error = "テキストではないので開きません。"; return; }
        this.saved = this.current = text;
        this.lines = countLines(text);
        this.state = this.newState(file, text);
        if (!on) this.watch(file, generation, cx);
      } catch (e) {
        if (generation === this.generation) this.error = `開けません（1 MB を超えるか、UTF-8 ではありません）。${e}`;
      } finally {
        if (generation === this.generation) cx.notify();
      }
    });
  }

  newState(file, text) {
    const t = theme(), ext = extOf(file);
    const state = EditorState.new({
      language: LANG[ext] ?? (ext || "txt"), value: text, readonly: this.readonly,
      font_family: settings().font_family,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
    });
    state.on("change", (_e, cx) => {
      const value = state.value();
      // set_value（読み直し）でも来るので、中身が同じなら何もしない
      if (this.state !== state || value === this.current) return;
      this.current = value;
      this.lines = countLines(this.current);
      this.note = "";
      cx.notify();
    });
    return state;
  }

  // ファイルを、エディタの中身ごと置き換える（外で変わったとき、読み直すとき）。
  replace(text) {
    this.saved = this.current = text;
    this.lines = countLines(text);
    this.state?.set_value(text);
  }

  watch(file, generation, cx) {
    const folder = folderOf(file);
    cx.spawn(async (cx) => {
      try {
        while (generation === this.generation) {
          this.waiting = watchFolder(folder);
          const changed = await this.waiting;
          if (generation !== this.generation) return;
          if (changed.includes(file) || changed.includes(folder)) await this.checkDisk(cx);
        }
      } catch { /* 監視できないフォルダー。保存時の expected で上書きは防げる */ }
    });
  }

  async checkDisk(cx) {
    const generation = this.generation, file = this.file;
    const text = await readTextFile(file, { on: this.on }).catch(() => undefined);
    if (generation !== this.generation || text === undefined || this.saving) return;
    if (text === null) { this.note = "ファイルが消されました。⌘S でもう一度作れます"; this.noteError = true; this.saved = null; cx.notify(); return; }
    if (text === this.saved) return;
    if (!this.dirty) { this.replace(text); this.note = "ほかで変更されたので読み直しました"; this.noteError = false; }
    else if (this.banner !== "conflict") this.banner = "external";
    this.disk = text;
    cx.notify();
  }

  save(force, cx) {
    if (!this.state || this.readonly || this.saving || (!this.dirty && this.saved !== null)) return;
    const file = this.file, text = this.current, generation = this.generation;
    this.saving = true;
    cx.spawn(async (cx) => {
      try {
        let expected = this.saved;
        if (force) expected = await readTextFile(file);
        await writeTextFile(file, text, expected);
        if (generation !== this.generation) return;
        this.saved = text;
        this.banner = null;
        this.note = "保存しました"; this.noteError = false;
        if (this.pending) { const p = this.pending; this.pending = null; this.open(p.file, p.on, cx); }
      } catch (e) {
        if (generation !== this.generation) return;
        const disk = await readTextFile(file).catch(() => undefined);
        if (disk !== undefined && disk !== this.saved) this.banner = "conflict";
        else { this.note = `保存できませんでした: ${e}`; this.noteError = true; }
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  act(what, cx) {
    if (what === "edit") this.preview = false;
    if (what === "preview") this.preview = true;
    if (what === "save-switch") this.save(false, cx);
    if (what === "discard-switch") { const p = this.pending; this.pending = null; this.open(p.file, p.on, cx); }
    if (what === "cancel") { this.pending = null; this.banner = null; }
    if (what === "reload") {
      // 読み直したら、保存してから開くはずだったファイルの依頼も取り下げる（あとの ⌘S で勝手に切り替わらないように）。
      this.banner = null; this.pending = null;
      cx.spawn(async (cx) => {
        const text = await readTextFile(this.file, { on: this.on }).catch(() => null);
        if (text !== null) { this.replace(text); this.note = "読み直しました"; this.noteError = false; }
        cx.notify();
      });
    }
    if (what === "keep") { this.banner = null; this.pending = null; this.note = "手元の変更を残しました。保存すると上書きの確認が出ます"; this.noteError = true; }
    if (what === "overwrite") this.save(true, cx);
    cx.notify();
  }

  button(id, label, t, primary) {
    return div().id(`editor-${id}`).px(9).py(2).rounded(5).cursor_pointer().text_size(12).border_1()
      .border_color(primary ? t.solid : t.input).when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .hover((s) => s.bg(primary ? t.solid : t.hover))
      .on_click((_e, cx) => this.act(id, cx)).child(label);
  }

  bannerView(t) {
    const text = {
      switch: `${this.file ? name(this.file) : ""} に保存していない変更があります。${this.pending ? name(this.pending.file) : ""} を開く前にどうしますか？`,
      external: "このファイルはほかで変更されました（Claude など）。手元にも保存していない変更があります。",
      conflict: "保存しませんでした。開いたあとにファイルが変わっています。上書きすると、ほかでの変更が消えます。",
    }[this.banner];
    const buttons = {
      switch: [["save-switch", "保存して開く", true], ["discard-switch", "破棄して開く"], ["cancel", "やめる"]],
      external: [["reload", "読み直す（手元の変更を捨てる）", true], ["keep", "手元の変更を残す"]],
      conflict: [["reload", "読み直す"], ["overwrite", "上書きする", true]],
    }[this.banner];
    return h_flex().flex_none().flex_wrap().gap(8).px(10).py(6).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(12)
      .child(div().flex_1().min_w(120).text_color(t.blocked).child(text))
      .children(buttons.map(([id, label, primary]) => this.button(id, label, t, primary)));
  }

  iconButton(id, icon, label, on, t) {
    return div().id(`editor-${id}`).w(24).h(22).flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(on ? t.selected : t.hover))
      .tooltip(label).accessibility_label(label).on_click((_e, cx) => this.act(id, cx))
      .child(svg(`mods/editor/${icon}.svg`).size(14));
  }

  render(cx) {
    this.resolvePane();
    this.takeRequest(cx);
    const t = theme();
    const md = this.file && isMarkdown(this.file) && this.state;
    const where = this.on ? `マシン: ${this.on}` : "この Mac";
    const head = h_flex().h(30).flex_none().gap(8).pl(10).pr(6).items_center().border_b(1).border_color(t.border).text_size(12).text_color(t.muted)
      .child(div().flex_none().font_semibold().text_color(t.foreground).child(this.file ? name(this.file) : "エディタ"))
      .when(this.dirty, (el) => el.child(div().flex_none().w(8).h(8).rounded(4).bg(t.accent)))
      .when(Boolean(this.file) && this.readonly, (el) => el.child(div().flex_none().px(6).rounded(4).bg(t.hover).text_size(11).child("読み取り専用")))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(this.file ?? ""))
      .when(Boolean(md), (el) => el.child(h_flex().flex_none().gap(2)
        .child(this.iconButton("edit", "pencil", "編集", !this.preview, t))
        .child(this.iconButton("preview", "eye", "プレビュー", this.preview, t))));

    let body;
    if (!this.file) body = div().flex_1().p(16).text_color(t.dim).child("ファイルが指定されていません。Files でファイルをクリックするか、シェルで e <ファイル> を実行してください。");
    else if (this.error) body = div().flex_1().p(16).text_color(t.muted).child(this.error);
    else if (!this.state) body = div().flex_1().p(16).text_color(t.dim).child("読み込み中…");
    else if (md && this.preview) body = div().flex_1().min_h(0).px(20).py(14).child(TextView.markdown("editor-preview", this.current).selectable(true).scrollable(true).size_full());
    else body = Editor.new(this.state).flex_1().min_h(0);

    const status = h_flex().h(24).flex_none().gap(12).px(10).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
      .when(Boolean(this.state), (el) => el.child(div().child(extOf(this.file) || "text")).child(div().child(`${this.lines} 行`)))
      .when(Boolean(this.file), (el) => el.child(div().child(where)))
      .child(div().flex_1().min_w(0).truncate().text_right().text_color(this.noteError ? t.blocked : t.done).child(this.note ?? ""));

    return v_flex().id("editor").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => { if (e.keystroke === "cmd-s" || e.keystroke === "ctrl-s") { this.save(false, cx); cx.stop_propagation(); } })
      .child(head)
      .when(Boolean(this.banner), (el) => el.child(this.bannerView(t)))
      .child(body)
      .child(status);
  }

  async close() { this.generation = (this.generation ?? 0) + 1; this.waiting?.cancel?.(); this.state?.release(); }
}
