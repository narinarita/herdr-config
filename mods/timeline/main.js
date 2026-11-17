// 右パネルの Timeline。フォーカスしているターミナルの Claude の作業を、目標と作業ツリーで出す。
//
//   [◌] herdr appでのツイート内容再現        作業中
//       timeline-panel
//   ┌───────────────────────────────────────┐
//   │ 作業ツリーを区切りごとに更新する   進行中 │   <- 目標
//   │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━── │
//   │ 4/6 件 · 38 分              66.7%     │
//   └───────────────────────────────────────┘
//   ● 作業ツリーの % 表示をなくす
//   ◐ Stop hook で作業ツリーを更新する
//      ● hooks/timeline.sh を書き直す
//      ◐ 実際のやりとりで動作を確かめる          <- 進めている作業は背景を付ける
//   ○ timeline mod を作り直す
//
// ツリーを書くのは hooks/timeline.sh（Claude Code の Stop hook。返答が終わるたびに Haiku が更新する）。
// ~/.local/state/herdr-timeline/<terminal>.plan.json を読むだけで、この mod は何も書かない。
// 項目は状態だけを持つ。全体の % は、末端の項目のうち終わったものの割合（進めている項目は 0 と数える）。

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, focused, panes, agents, spaces, readTextFile, watchFolder, theme, checking } from "herdr";

const DIR = () => `${home()}/.local/state/herdr-timeline`;
const STATE = { working: "作業中", blocked: "あなた待ち", done: "完了", idle: "待機" };
const ICON = { done: "●", doing: "◐", todo: "○" };

// 今見ているターミナル。別のマシンのものはファイルが手元にないので扱わない。
function current() {
  const f = focused();
  const id = f?.shown ?? f?.terminal ?? f?.agent ?? null;
  if (!id) return { id: null };
  return id.includes("/") ? { id, remote: true } : { id };
}

const STATES = new Set(["done", "doing", "todo"]);
function parse(text) {
  let p;
  try { p = JSON.parse(text ?? ""); } catch { return null; }
  if (!p || typeof p !== "object" || !Array.isArray(p.items)) return null;
  const item = (x) => ({
    title: String(x?.title ?? ""),
    state: STATES.has(x?.state) ? x.state : "todo",
    children: Array.isArray(x?.children) ? x.children.map(item) : [],
  });
  return { goal: String(p.goal ?? ""), started: Number(p.started) || null, updated: Number(p.updated) || null, items: p.items.map(item) };
}

// 子を持つ項目の状態は子から決める。
function stateOf(it) {
  if (!it.children.length) return it.state;
  const s = it.children.map(stateOf);
  return s.every((x) => x === "done") ? "done" : s.some((x) => x !== "todo") ? "doing" : "todo";
}
const leaves = (items) => items.flatMap((it) => it.children.length ? leaves(it.children) : [it]);

function minutes(from) {
  const m = Math.max(0, Math.floor((Date.now() / 1000 - from) / 60));
  return m < 60 ? `${m} 分` : `${Math.floor(m / 60)} 時間 ${m % 60} 分`;
}

export default class Timeline extends View {
  init(_props, cx) {
    this.key = null; this.plan = null; this.pending = false; this.loaded = false;
    if (checking()) return;
    this.watch(cx);
    // 経過時間を進める時計。見張りが止まっていたら（フォルダーがまだない等）ここで読み直し、見張り直す。
    cx.timer.every(30000, (cx) => {
      if (!this.watching) { if (this.key) this.load(this.key, cx); this.watch(cx); }
      cx.notify();
    });
  }

  // 記録のフォルダーを見張り、変わったら今のターミナルの分を読み直す。
  watch(cx) {
    this.watching = true;
    cx.spawn(async (cx) => {
      try {
        while (!this.closed) {
          this.waiting = watchFolder(DIR());
          await this.waiting;
          if (this.key && !this.closed) this.load(this.key, cx);
        }
      } catch {}
      this.watching = false;
    });
  }

  async close() {
    this.closed = true;
    this.waiting?.cancel();
  }

  load(id, cx) {
    cx.spawn(async (cx) => {
      const base = `${DIR()}/${id.replaceAll("/", "_")}`;
      let text = null, mark = null;
      try { text = await readTextFile(`${base}.plan.json`); } catch {}
      try { mark = await readTextFile(`${base}.plan.pending`); } catch {}
      if (this.key !== id) return;
      this.plan = parse(text);
      // 更新の印が 2 分を超えて残っていたら、更新が落ちたものとみなす。
      this.pending = Boolean(mark) && Date.now() / 1000 - Number(mark) < 120;
      this.loaded = true;
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    // エディタなどターミナルでないペインに移ったときは、直前のターミナルのまま出しておく。
    const now = current();
    const where = now.id || !this.key ? now : { id: this.key, remote: this.key.includes("/") };
    if (where.id !== this.key) {
      this.key = where.id; this.plan = null; this.pending = false; this.loaded = false;
      if (where.id && !where.remote && !checking()) this.load(where.id, cx);
    }
    const root = v_flex().id("timeline").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13);
    if (!where.id) return root.child(this.empty(t, "ターミナルを選ぶと、そこで動いている Claude の作業ツリーが出ます"));
    if (where.remote) return root.child(this.empty(t, "別のマシンのターミナルの作業ツリーは、まだ表示できません"));

    const pane = panes().find((p) => p.terminal === where.id);
    const agent = agents().find((a) => a.address === where.id || a.pane === pane?.pane);
    const space = spaces().find((s) => s.id === agent?.space) ?? spaces().find((s) => s.active);
    const title = agent?.title?.replace(/^[^\p{L}\p{N}]+/u, "").trim() || agent?.tab_name || pane?.title || where.id;
    const status = agent?.status ?? pane?.status ?? null;

    root.child(this.header(t, title, status, space?.name, pane?.branch));
    if (!this.plan?.items.length) {
      return root.child(this.empty(t, !this.loaded ? "読み込み中…" : this.pending
        ? "作業ツリーを作っています…"
        : "作業ツリーはまだありません。Claude が作業を1回終えると、ここにできます"));
    }
    return root.child(v_flex().id("plan").flex_1().min_h(0).px(12).pt(12).pb(14).gap(10).overflow_y_scrollbar()
      .child(this.goal(t, status))
      .child(v_flex().gap(1).children(this.plan.items.flatMap((it) => this.rows(t, it, 0)))));
  }

  empty(t, text) {
    return div().flex_1().p(20).flex().items_center().justify_center()
      .child(div().w_full().whitespace_normal().text_center().text_color(t.dim).text_size(12.5).child(text));
  }

  header(t, title, status, spaceName, branch) {
    const dot = status === "working"
      ? svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)
      : div().size(8).mx(2).flex_none().rounded(4).bg(t[status] ?? t.idle);
    return v_flex().px(14).pt(12).pb(10).gap(3).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(dot)
        .child(div().flex_1().min_w(0).truncate().font_weight(600).child(title))
        .when(Boolean(STATE[status]), (el) => el.child(div().flex_none().text_size(11.5).px(7).rounded(9).border_1()
          .border_color(t[status] ?? t.border).text_color(t[status] ?? t.muted).child(STATE[status]))))
      .when(Boolean(spaceName), (el) => el.child(div().pl(20).truncate().text_size(12).text_color(t.muted)
        // worktree の Space はブランチ名と同じ名前（/ が - になっただけ）なので、そのときはブランチだけ出す。
        .child(!branch ? spaceName : spaceName === branch.replaceAll("/", "-") ? branch : `${spaceName} / ${branch}`)));
  }

  goal(t, status) {
    const all = leaves(this.plan.items), done = all.filter((x) => x.state === "done").length;
    const pct = all.length ? (done / all.length) * 100 : 0;
    const finished = all.length > 0 && done === all.length;
    const chip = finished ? ["完了", t.done] : status === "blocked" ? ["あなた待ち", t.blocked] : ["進行中", t.working];
    return v_flex().px(12).py(10).gap(7).rounded(8).bg(t.raised)
      .child(h_flex().gap(8).items_start()
        .child(div().flex_1().min_w(0).whitespace_normal().font_weight(600).child(this.plan.goal || "（目標なし）"))
        .child(div().flex_none().text_size(11).px(7).rounded(9).border_1().border_color(chip[1]).text_color(chip[1]).child(chip[0])))
      .child(div().h(4).w_full().rounded(2).bg(t.border).overflow_hidden()
        .child(div().h_full().rounded(2).bg(t.done).w(`${pct}%`)))
      .child(h_flex().gap(6).text_size(11.5).text_color(t.muted)
        .child(`${done}/${all.length} 件`)
        .when(Boolean(this.plan.started), (el) => el.child(`· ${minutes(this.plan.started)}`))
        .when(this.pending, (el) => el.child(div().text_color(t.dim).child("· 更新中…")))
        .child(div().flex_1())
        .child(`${pct.toFixed(1)}%`));
  }

  rows(t, it, depth) {
    const s = stateOf(it), leaf = !it.children.length;
    const color = { done: t.done, doing: t.working, todo: t.dim }[s];
    const row = h_flex().gap(8).items_start().py(3).pr(6).pl(6 + depth * 18).rounded(5)
      .when(leaf && s === "doing", (el) => el.bg(t.raised))
      .child(div().w(12).flex_none().text_size(11).text_color(color).child(ICON[s]))
      .child(div().flex_1().min_w(0).whitespace_normal()
        .text_color(s === "done" ? t.muted : t.foreground)
        .when(!leaf || s === "doing", (el) => el.font_weight(500))
        .child(it.title));
    return [row, ...it.children.flatMap((c) => this.rows(t, c, depth + 1))];
  }
}
