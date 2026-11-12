// Tasks: a kanban of Jira issues (TODO / 進行中 / レビュー / 完了), opened as a
// dialog by a key (mod.open:tasks, again closes it). Dragging a card to another
// column moves the Jira issue there through one of its transitions. Nothing
// else is linked: no worktrees, no agents. Reads ~/.config/herdr-jira.json and
// the API token from the macOS keychain; talks to Jira over the network.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, exec, home, readTextFile, notify as toast } from "herdr";
import { COLUMNS, ConfigError, parseConfig, client, plan } from "./jira.js";

const CONFIG = ".config/herdr-jira.json"; // under home: kept out of this repo and of install.sh
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const LABEL = Object.fromEntries(COLUMNS.map((c) => [c.id, c.label]));
const two = (n) => String(n).padStart(2, "0");
const clock = (d) => `${two(d.getHours())}:${two(d.getMinutes())}`;

export default class Tasks extends View {
  init(_props, cx) {
    this.phase = "loading"; // loading | setup | error | ready
    this.message = "";      // why setup or error
    this.issues = [];
    this.synced = null;
    this.refreshing = false;
    this.drag = null;       // { key, from } while a card is held
    this.over = null;       // the column under the pointer while dragging
    this.moves = {};        // key -> transitions, read when the card is pressed
    this.pending = {};      // key -> true while a transition is on its way
    this.choice = null;     // { title, options: [{ label, pick }] }
    this.notice = null;     // { text, level } at the bottom
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.load(cx);
  }

  load(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (!this.api) this.api = await this.connect();
        this.issues = await this.api.issues();
        this.synced = new Date();
        this.phase = "ready";
      } catch (e) {
        this.phase = e instanceof ConfigError || e?.setup ? "setup" : "error";
        this.message = e?.message ?? String(e);
        this.api = null; // read the config and the token again next time (a fixed token, say)
      }
      this.refreshing = false;
      cx.notify();
    });
  }

  async connect() {
    const path = `${home()}/${CONFIG}`;
    const config = parseConfig(await readTextFile(path).catch(() => null));
    const r = await exec("security", ["find-generic-password", "-s", config.keychain, "-a", config.email, "-w"]);
    const token = (r.stdout ?? "").trim();
    if (r.code !== 0 || !token) {
      const e = new Error(`キーチェーンに ${config.keychain}（${config.email}）のトークンがありません。`);
      e.setup = true;
      throw e;
    }
    this.site = config.site;
    return client(config, token, fetch);
  }

  // A card was pressed: hold it, and learn where it can go meanwhile.
  press(issue, cx) {
    if (this.pending[issue.key] || this.choice) return;
    this.drag = { key: issue.key, from: issue.column };
    this.over = issue.column;
    if (!this.moves[issue.key]) {
      cx.spawn(async (cx) => {
        try { this.moves[issue.key] = await this.api.transitions(issue.key); cx.notify(); }
        catch { /* the drop asks again and reports the error */ }
      });
    }
    cx.notify();
  }

  release(column, cx) {
    const d = this.drag;
    this.drag = null;
    this.over = null;
    cx.notify();
    if (!d || column === d.from) return;
    const issue = this.issues.find((i) => i.key === d.key);
    if (!issue) return;
    cx.spawn(async (cx) => {
      let moves = this.moves[issue.key];
      try { moves = moves ?? (this.moves[issue.key] = await this.api.transitions(issue.key)); }
      catch (e) { this.say(e.message, "error"); cx.notify(); return; }
      const p = plan(moves, column, LABEL[column]);
      if (p.error) this.say(`${issue.key}: ${p.error}`, "error");
      else if (p.go) this.ask(issue, p.go, cx);
      else this.choice = {
        title: `${issue.key} をどの遷移で「${LABEL[column]}」へ移しますか？`,
        options: p.choose.map((t) => ({ label: `${t.name} → ${t.to?.name ?? ""}`, pick: (cx) => this.ask(issue, t, cx) })),
      };
      cx.notify();
    });
  }

  // Asks for a resolution when the transition needs one, then moves.
  ask(issue, t, cx) {
    const res = t.needs.resolution;
    if (res && res.length) {
      this.choice = {
        title: `${issue.key} を ${t.to?.name ?? "完了"} にします。解決状況を選んでください。`,
        options: res.map((v) => ({ label: v.name, pick: (cx) => this.move(issue, t, { resolution: { id: v.id } }, cx) })),
      };
      cx.notify();
      return;
    }
    this.move(issue, t, null, cx);
  }

  // Moves the card at once and puts it back if Jira refuses.
  move(issue, t, fields, cx) {
    const before = { status: issue.status, column: issue.column };
    const from = issue.status?.name ?? "";
    issue.status = t.to;
    issue.column = t.column;
    this.pending[issue.key] = true;
    this.notice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.api.transition(issue.key, t.id, fields);
        toast({ title: `${issue.key}: ${from} → ${t.to?.name ?? ""}`, body: issue.summary, level: "success", timeout: 4000 });
      } catch (e) {
        Object.assign(issue, before);
        this.say(`${issue.key} を移せませんでした。${e.message}`, "error");
      }
      delete this.pending[issue.key];
      delete this.moves[issue.key]; // where it can go next has changed
      cx.notify();
    });
  }

  say(text, level) { this.notice = { text, level }; }

  key(e, cx) {
    if (e.key === "escape" && this.choice) { this.choice = null; cx.stop_propagation(); cx.notify(); return; }
    if (e.key === "r" && !this.choice && !this.drag) this.load(cx);
  }

  // ---- drawing ----

  button(t, id, label, onClick) {
    return div().id(id).flex_none().px(9).py(3).rounded(6).border(1).border_color(t.border).text_size(11.5).text_color(t.foreground)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(label);
  }

  card(t, i) {
    const held = this.drag?.key === i.key;
    const busy = Boolean(this.pending[i.key]);
    return v_flex()
      .id(`card-${i.key}`)
      .flex_none()
      .gap(3)
      .p(9)
      .rounded(8)
      .border(1)
      .border_color(held ? t.accent : t.border)
      .bg(t.background)
      .when(held, (el) => el.opacity(0.5))
      .when(busy, (el) => el.opacity(0.7))
      .when(!busy, (el) => el.cursor_grab().hover((s) => s.border_color(t.input)))
      .on_mouse_down("left", (_e, cx) => this.press(i, cx))
      .child(h_flex().gap(6).items_center().text_size(11)
        .child(div().flex_none().text_color(t.accent).font_medium().child(i.key))
        .child(div().flex_1())
        .when(busy, (el) => el.child(div().flex_none().text_color(t.working).frames(SPIN, 90)).child(div().flex_none().text_color(t.dim).child("Jira に反映中")))
        .when(!busy, (el) => el.child(div().min_w(0).truncate().text_color(t.dim).child(i.status?.name ?? ""))))
      .child(div().text_size(12.5).text_color(i.column === "done" ? t.muted : t.foreground).child(i.summary))
      .when(Boolean(i.type), (el) => el.child(div().text_size(11).text_color(t.dim).child(i.type)));
  }

  lane(t, col) {
    const list = this.issues.filter((i) => i.column === col.id);
    const d = this.drag;
    const moves = d && this.moves[d.key];
    const closed = Boolean(d && moves && col.id !== d.from && !moves.some((m) => m.column === col.id));
    const target = Boolean(d && this.over === col.id && col.id !== d.from && !closed);
    return v_flex()
      .id(`lane-${col.id}`)
      .flex_1()
      .min_w(0)
      .min_h(0)
      .rounded(10)
      .border(1)
      .border_color(target ? t.accent : t.border)
      .bg(target ? t.selected : t.chrome)
      .when(closed, (el) => el.opacity(0.45))
      .on_mouse_move((_e, cx) => { if (this.drag && this.over !== col.id) { this.over = col.id; cx.notify(); } })
      .on_mouse_up("left", (_e, cx) => this.release(col.id, cx))
      .child(h_flex().flex_none().px(11).pt(9).pb(5).gap(7).items_center().text_size(12)
        .child(div().font_semibold().text_color(t.foreground).child(col.label))
        .child(div().text_color(t.dim).child(String(list.length)))
        .when(closed, (el) => el.child(div().flex_1().min_w(0).truncate().text_right().text_size(10.5).text_color(t.dim).child("この遷移はできません"))))
      .child(v_flex().id(`cards-${col.id}`).flex_1().min_h(0).px(8).pb(10).gap(7).overflow_y_scrollbar()
        .children(list.map((i) => this.card(t, i)))
        .when(list.length === 0, (el) => el.child(div().p(12).rounded(8).border(1).border_color(t.border).text_size(11.5).text_color(t.dim).text_center().child("ここにドラッグ"))));
  }

  board(t) {
    const loose = this.issues.filter((i) => !i.column);
    return v_flex().flex_1().min_h(0)
      .when(loose.length > 0, (el) => el.child(h_flex().flex_none().px(14).py(6).gap(8).items_center().text_size(11.5).border_b(1).border_color(t.border)
        .child(div().flex_none().font_semibold().text_color(t.blocked).child("列のないステータス"))
        .child(div().min_w(0).truncate().text_color(t.dim).child(loose.map((i) => `${i.key}（${i.status?.name ?? "?"}）`).join("、")))
        .child(div().flex_none().text_color(t.dim).child("設定の columns で列を指定できます"))))
      .child(h_flex().flex_1().min_h(0).p(12).gap(10).items_stretch().children(COLUMNS.map((c) => this.lane(t, c))));
  }

  lines(t, text, color) {
    return v_flex().gap(4).children(String(text).split("\n").slice(0, 8).map((l) => div().text_color(color).child(l)));
  }

  setup(t) {
    const code = (s) => div().px(8).py(4).rounded(6).bg(t.chrome).text_color(t.foreground).child(s);
    return v_flex().flex_1().p(24).gap(10).text_size(12.5)
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Jira の設定がまだです"))
      .child(this.lines(t, this.message === "missing" ? `~/${CONFIG} がありません。` : this.message, t.blocked))
      .child(div().pt(6).text_color(t.dim).child(`1. ~/${CONFIG} を作る`))
      .child(code(`{ "site": "example.atlassian.net", "email": "you@example.com" }`))
      .child(div().pt(6).text_color(t.dim).child("2. API トークンをキーチェーンに入れる（-w のあとで入力を求められます）"))
      .child(code("security add-generic-password -s herdr-jira -a you@example.com -w"))
      .child(h_flex().pt(8).child(this.button(t, "retry", "読み直す", (cx) => this.load(cx))));
  }

  chooser(t) {
    const c = this.choice;
    return div().absolute().top(0).left(0).right(0).bottom(0).flex().items_center().justify_center().bg(t.canvas + "b3")
      .child(v_flex().id("choice").w(380).p(14).gap(8).rounded(12).border(1).border_color(t.border).bg(t.popover)
        .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child(c.title))
        .children(c.options.map((o, n) => div().id(`opt-${n}`).px(10).py(6).rounded(7).border(1).border_color(t.border)
          .text_size(12.5).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover).border_color(t.accent))
          .on_click((_e, cx) => { this.choice = null; o.pick(cx); cx.notify(); }).child(o.label)))
        .child(h_flex().pt(4).justify_end().child(this.button(t, "choice-cancel", "キャンセル", (cx) => { this.choice = null; cx.notify(); }))));
  }

  render() {
    const t = theme();
    const source = this.site ? `Jira · ${this.site}${this.synced ? ` · ${clock(this.synced)} 更新` : ""}` : "Jira";
    return v_flex()
      .id("tasks")
      .relative()
      .size_full()
      .min_h(0)
      .bg(t.popover)
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; this.over = null; cx.notify(); } })
      .child(h_flex().flex_none().h(46).px(14).gap(12).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().text_size(14).font_semibold().text_color(t.foreground).child("Tasks"))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(source))
        .when(this.refreshing, (el) => el.child(div().flex_none().text_color(t.dim).frames(SPIN, 90)))
        .when(this.phase === "ready", (el) => el.child(this.button(t, "refresh", "↻ 更新", (cx) => this.load(cx)))))
      .when(this.phase === "loading", (el) => el.child(div().flex_1().p(24).text_color(t.dim).child("Jira から読み込んでいます…")))
      .when(this.phase === "setup", (el) => el.child(this.setup(t)))
      .when(this.phase === "error", (el) => el.child(v_flex().flex_1().p(24).gap(10)
        .child(this.lines(t, this.message, t.blocked))
        .child(h_flex().child(this.button(t, "retry", "読み直す", (cx) => this.load(cx))))))
      .when(this.phase === "ready", (el) => el.child(this.board(t)))
      .child(h_flex().flex_none().h(30).px(14).gap(10).items_center().border_t(1).border_color(t.border).text_size(11)
        .when(Boolean(this.notice), (el) => el.child(div().flex_1().min_w(0).truncate()
          .text_color(this.notice.level === "error" ? t.blocked : t.dim).child(this.notice.text)))
        .when(!this.notice, (el) => el.child(div().flex_1()))
        .child(div().flex_none().text_color(t.dim).child("カードをドラッグしてステータスを変える · r 更新 · esc 閉じる")))
      .when(Boolean(this.choice), (el) => el.child(this.chooser(t)));
  }
}
