// 右パネルの Timeline。フォーカスしているターミナルの Claude の作業を、目標と作業ツリーで出す。
//
//   [◌] herdr appでのツイート内容再現        作業中
//       timeline-panel
//   ┌───────────────────────────────────────┐
//   │ 作業ツリーを区切りごとに更新する   進行中 │   <- 目標
//   │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━── │
//   │ 2/4 件 · 38 分              50.0%     │
//   └───────────────────────────────────────┘
//   ● 作業ツリーの % 表示をなくす
//   ◐ Stop hook で作業ツリーを更新する
//      ● hooks/timeline.sh を書き直す
//      ◐ 実際のやりとりで動作を確かめる          <- 進めている作業は背景を付ける
//   ○ timeline mod を作り直す
//   ── これまでの目標 2 ─────────────────────
//   › ● Usage をサイドバーに出す     13/13 · 1 時間 31 分   <- 畳んだ前の目標。押すと開く
//   › ◐ 別の作業                       3/5 · 12 分        <- 途中で別の目標に移ったもの
//
// 目標が 100% になったら、その目標を畳んで「これまでの目標」の先頭に出し、上には「次の作業を頼むと…」だけを出す。
// 別の目標に移ると、hook が前の目標を plan.json の past に移す（終わっていても途中でも）。新しい目標は畳んだ目標の上に出る。
//
// ツリーを書くのは hooks/timeline.sh（Claude Code の hook）。指示を送った時点（UserPromptSubmit）で目標と状態を直し、
// 返答が終わるたび（Stop）に作業を分けて状態を更新する。どちらも Haiku が行う。
// ~/.local/state/herdr-timeline/<terminal>.plan.json を読むだけで、この mod は何も書かない。
// 項目は状態だけを持つ。全体の % は、末端の項目のうち終わったものの割合（進めている項目は 0 と数える）。

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, focused, panes, agents, spaces, readTextFile, watchFolder, theme, checking } from "herdr";

const DIR = () => `${home()}/.local/state/herdr-timeline`;
const STATE = { working: "作業中", blocked: "あなた待ち", done: "完了", idle: "待機" };
const ICON = { done: "●", doing: "◐", waiting: "◇", todo: "○" };

// 今見ているターミナル。別のマシンのものはファイルが手元にないので扱わない。
function current() {
  const f = focused();
  const id = f?.shown ?? f?.terminal ?? f?.agent ?? null;
  if (!id) return { id: null };
  return id.includes("/") ? { id, remote: true } : { id };
}

const STATES = new Set(["done", "doing", "waiting", "todo"]);
function parse(text) {
  let p;
  try { p = JSON.parse(text ?? ""); } catch { return null; }
  if (!p || typeof p !== "object" || !Array.isArray(p.items)) return null;
  const item = (x) => ({
    title: String(x?.title ?? ""),
    state: STATES.has(x?.state) ? x.state : "todo",
    children: Array.isArray(x?.children) ? x.children.map(item) : [],
  });
  const past = (Array.isArray(p.past) ? p.past : []).filter((g) => g && Array.isArray(g.items)).map((g) => ({
    goal: String(g.goal ?? ""), started: Number(g.started) || null, ended: Number(g.ended) || null, items: g.items.map(item),
  }));
  return { goal: String(p.goal ?? ""), started: Number(p.started) || null, updated: Number(p.updated) || null, items: p.items.map(item), past };
}

// 子を持つ項目の状態は子から決める。返事待ちの子があれば返事待ち、次に進めている子があれば進行中。
function stateOf(it) {
  if (!it.children.length) return it.state;
  const s = it.children.map(stateOf);
  return s.every((x) => x === "done") ? "done" : s.includes("waiting") ? "waiting"
    : s.some((x) => x !== "todo") ? "doing" : "todo";
}
const leaves = (items) => items.flatMap((it) => it.children.length ? leaves(it.children) : [it]);
const complete = (items) => { const all = leaves(items); return all.length > 0 && all.every((x) => x.state === "done"); };

function minutes(from, to = Date.now() / 1000) {
  const m = Math.max(0, Math.floor((to - from) / 60));
  return m < 60 ? `${m} 分` : `${Math.floor(m / 60)} 時間 ${m % 60} 分`;
}

export default class Timeline extends View {
  init(_props, cx) {
    this.key = null; this.plan = null; this.pendingAt = null; this.loaded = false; this.seq = 0;
    this.open = new Set(); // 開いている「これまでの目標」（started と goal で見分ける）
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
    // 読み込みが重なったら、最後に始めたものだけを使う（古い結果が後から入らないように）。
    const seq = ++this.seq;
    cx.spawn(async (cx) => {
      const base = `${DIR()}/${id.replaceAll("/", "_")}`;
      let text = null, mark = null;
      try { text = await readTextFile(`${base}.plan.json`); } catch {}
      try { mark = await readTextFile(`${base}.plan.pending`); } catch {}
      if (this.key !== id || seq !== this.seq) return;
      this.plan = parse(text);
      this.pendingAt = mark ? Number(mark) || null : null;   // 更新を始めた時刻（ミリ秒）
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
      this.key = where.id; this.plan = null; this.pendingAt = null; this.loaded = false;
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

    // 更新の印が 5 分を超えて残っていたら、更新が落ちたものとみなす（印は消えないので、描くたびに比べる）。
    // hook 側はロック待ちが最大 3 分、Haiku の打ち切りが 2 分。
    this.pending = Boolean(this.pendingAt) && Date.now() - this.pendingAt < 300000;
    root.child(this.header(t, title, status, space?.name, pane?.branch));
    // 100% になった目標は、上には出さず「これまでの目標」の先頭に畳んで出す。
    const plan = this.plan;
    const finished = Boolean(plan?.items.length) && complete(plan.items);
    const active = Boolean(plan?.items.length) && !finished;
    const past = !plan ? [] : [
      ...(finished ? [{ goal: plan.goal, started: plan.started, ended: plan.updated, items: plan.items }] : []),
      ...plan.past,
    ];
    if (!active && !past.length) {
      return root.child(this.empty(t, !this.loaded ? "読み込み中…" : this.pending
        ? "作業ツリーを作っています…"
        : "作業ツリーはまだありません。Claude に作業を頼むと、ここにできます"));
    }
    return root.child(v_flex().id("plan").flex_1().min_h(0).px(12).pt(12).pb(14).gap(10).overflow_y_scrollbar()
      .when(active, (el) => el.child(this.goal(t, status))
        .child(v_flex().gap(1).children(plan.items.flatMap((it) => this.rows(t, it, 0)))))
      .when(!active, (el) => el.child(div().px(12).py(14).rounded(8).border_1().border_color(t.border)
        .whitespace_normal().text_center().text_size(12.5).text_color(t.dim)
        .child(this.pending ? "作業ツリーを作っています…" : "次の作業を頼むと、ここに出ます")))
      .when(past.length > 0, (el) => el.child(this.pastView(t, past))));
  }

  // これまでの目標。1 行に畳み、押すと開いて子の項目を出す。
  pastView(t, past) {
    return v_flex().gap(2).pt(4)
      .child(h_flex().gap(8).items_center().pb(2).text_size(11).text_color(t.dim)
        .child(div().flex_none().child(`これまでの目標 ${past.length}`))
        .child(div().flex_1().h(1).bg(t.border)))
      .children(past.flatMap((g, i) => {
        const key = `${g.started}:${g.goal}`, open = this.open.has(key);
        const all = leaves(g.items), done = all.filter((x) => x.state === "done").length;
        const ok = all.length > 0 && done === all.length;
        const span = g.started && g.ended ? ` · ${minutes(g.started, g.ended)}` : "";
        const row = h_flex().id(`past-${i}`).gap(7).items_center().py(4).px(6).rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.raised))
          .on_click((_e, cx) => { if (open) this.open.delete(key); else this.open.add(key); cx.notify(); })
          .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.dim))
          .child(div().w(12).flex_none().text_size(11).text_color(ok ? t.done : t.muted).child(ok ? ICON.done : ICON.doing))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(g.goal || "（目標なし）"))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`${done}/${all.length}${span}`));
        return [row, ...(open ? g.items.flatMap((it) => this.rows(t, it, 1, true)) : [])];
      }));
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
    const waiting = all.some((x) => x.state === "waiting");
    const chip = finished ? ["完了", t.done] : status === "blocked" || waiting ? ["あなた待ち", t.blocked] : ["進行中", t.working];
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

  // quiet: 畳んだ目標を開いたときの項目。背景・太字・「返事待ち」を付けず、薄く出す。
  rows(t, it, depth, quiet = false) {
    const s = stateOf(it), leaf = !it.children.length;
    const color = { done: t.done, doing: t.working, waiting: t.blocked, todo: t.dim }[s];
    const strong = !quiet && (!leaf || s === "doing" || s === "waiting");
    const row = h_flex().gap(8).items_start().py(3).pr(6).pl(6 + depth * 18).rounded(5)
      .when(!quiet && leaf && (s === "doing" || s === "waiting"), (el) => el.bg(t.raised))
      .child(div().w(12).flex_none().text_size(11).text_color(color).child(ICON[s]))
      .child(div().flex_1().min_w(0).whitespace_normal()
        .text_color(quiet ? t.dim : s === "done" ? t.muted : t.foreground)
        .when(strong, (el) => el.font_weight(500))
        .child(it.title))
      .when(!quiet && s === "waiting", (el) => el.child(div().flex_none().text_size(11).text_color(t.blocked).child("返事待ち")));
    return [row, ...it.children.flatMap((c) => this.rows(t, c, depth + 1, quiet))];
  }
}
