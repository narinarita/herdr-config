// 右パネルの Timeline。フォーカスしているターミナルの Claude が何をしてきたかを、新しい順に並べる。
//
//   [◌] herdr appでのツイート内容再現        作業中
//       herdr-config / wip/1115-1407
//   ┃ LAST REPORT                        20:43
//   ┃ 右パネルに Timeline を足した。次は…        <- 最後の返答の要約（Haiku）。要約前は返答そのもの
//   TIMELINE  すべて  Report  あなた  タスク
//   今日
//   ● 20:41  テストを通す → done
//   ○ 20:38  あなた  タイムラインを組み込みたい
//
// 記録するのは hooks/timeline.sh（Claude Code の hook）。ターミナルごとに
// ~/.local/state/herdr-timeline/<terminal>.jsonl へ 1 行 1 件で書く。
// この mod はそのファイルを読むだけで、何も書かない。

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, focused, panes, agents, spaces, readTextFile, watchFolder, theme, checking } from "herdr";

const DIR = () => `${home()}/.local/state/herdr-timeline`;
const MAX = 200;   // 表示する件数の上限
const FILTERS = [["all", "すべて"], ["report", "Report"], ["you", "あなた"], ["task", "タスク"]];
const STATE = { working: "作業中", blocked: "あなた待ち", done: "完了", idle: "待機" };

// 今見ているターミナル。別のマシンのものはファイルが手元にないので扱わない。
function current() {
  const f = focused();
  const id = f?.shown ?? f?.terminal ?? f?.agent ?? null;
  if (!id) return { id: null };
  if (id.includes("/")) return { id, remote: true };
  return { id };
}

function parse(text) {
  const events = [], summaries = new Map();
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e.t !== "number" || typeof e.text !== "string") continue;
    if (e.kind === "summary") { if (e.id) summaries.set(e.id, e.text); continue; }
    events.push(e);
  }
  for (const e of events) if (e.kind === "report" && summaries.has(e.id)) { e.full = e.text; e.text = summaries.get(e.id); e.summarized = true; }
  return events.slice(-MAX).reverse();
}

const pad = (n) => String(n).padStart(2, "0");
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function day(t) {
  const d = new Date(t * 1000), now = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86400000);
  return diff === 0 ? "今日" : diff === 1 ? "昨日" : `${d.getMonth() + 1}/${d.getDate()}`;
}
function ago(t) {
  const m = Math.floor((Date.now() / 1000 - t) / 60);
  if (m < 1) return "たった今";
  if (m < 60) return `${m} 分前`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} 時間前` : `${Math.floor(h / 24)} 日前`;
}

export default class Timeline extends View {
  init(_props, cx) {
    this.key = null; this.events = []; this.filter = "all"; this.open = new Set(); this.loaded = false;
    if (checking()) return;
    this.watch(cx);
    // 「〜分前」を進める時計。見張りが止まっていたら（フォルダーがまだない等）ここで読み直し、見張り直す。
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
          this.pending = watchFolder(DIR());
          await this.pending;
          if (this.key && !this.closed) this.load(this.key, cx);
        }
      } catch {}
      this.watching = false;
    });
  }

  async close() {
    this.closed = true;
    this.pending?.cancel();
  }

  load(id, cx) {
    cx.spawn(async (cx) => {
      let text = null;
      try { text = await readTextFile(`${DIR()}/${id.replaceAll("/", "_")}.jsonl`); } catch {}
      if (this.key !== id) return;
      this.events = parse(text); this.loaded = true;
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    // エディタなどターミナルでないペインに移ったときは、直前のターミナルのまま出しておく。
    const now = current();
    const where = now.id || !this.key ? now : { id: this.key, remote: this.key.includes("/") };
    if (where.id !== this.key) {
      this.key = where.id; this.events = []; this.loaded = false; this.open = new Set();
      if (where.id && !where.remote && !checking()) this.load(where.id, cx);
    }
    const root = v_flex().id("timeline").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13);
    if (!where.id) return root.child(this.empty(t, "ターミナルを選ぶと、そこで動いている Claude の記録が出ます"));
    if (where.remote) return root.child(this.empty(t, "別のマシンのターミナルの記録は、まだ表示できません"));

    const pane = panes().find((p) => p.terminal === where.id);
    const agent = agents().find((a) => a.address === where.id || a.pane === pane?.pane);
    const space = spaces().find((s) => s.id === agent?.space) ?? spaces().find((s) => s.active);
    const title = agent?.title?.replace(/^[^\p{L}\p{N}]+/u, "").trim() || agent?.tab_name || pane?.title || where.id;
    const status = agent?.status ?? pane?.status ?? null;

    return root
      .child(this.header(t, title, status, space?.name, pane?.branch))
      .when(this.events.length > 0, (el) => el.child(this.lastReport(t, status)).child(this.list(t)))
      .when(this.events.length === 0, (el) => el.child(this.empty(t, this.loaded
        ? "まだ記録がありません。Claude Code に指示を送ると、ここに並びます"
        : "読み込み中…")));
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

  lastReport(t, status) {
    const report = this.events.find((e) => e.kind === "report");
    // 許可や質問で止まっている間（Herdr が blocked と言っている間）だけ、最後の確認待ちを先に出す。
    // 承認したあとは記録が残っていても出さない。
    const latest = this.events[0];
    const waiting = status === "blocked" && latest?.kind === "wait" ? latest : null;
    const box = v_flex().mx(12).mt(12).px(12).py(9).gap(4).rounded(8).bg(t.raised).border_l(3).border_color(waiting ? t.blocked : t.accent);
    if (!report && !waiting) return box.child(div().text_color(t.dim).text_size(12.5).child("まだ返答がありません"));
    return box
      .child(h_flex().gap(6).text_size(10.5).font_weight(600).text_color(t.muted)
        .child("LAST REPORT")
        .when(Boolean(report && !report.summarized && (report.text.length > 80)), (el) => el.child(div().font_weight(400).text_color(t.dim).child("要約中…")))
        .child(div().flex_1())
        .when(Boolean(report), (el) => el.child(div().font_weight(400).text_color(t.dim).child(`${clock(new Date(report.t * 1000))} · ${ago(report.t)}`))))
      .when(Boolean(waiting), (el) => el.child(div().text_color(t.blocked).font_weight(500).whitespace_normal().child(`確認待ち: ${waiting.text}`)))
      .when(Boolean(report), (el) => el.child(div().whitespace_normal().child(report.text.length > 300 ? `${report.text.slice(0, 300)}…` : report.text)));
  }

  list(t) {
    const shown = this.events.filter((e) => this.filter === "all" || e.kind === this.filter
      || (this.filter === "you" && e.kind === "wait") || (this.filter === "task" && e.kind === "pr"));
    const rows = [];
    let lastDay = null;
    shown.forEach((e, i) => {
      const d = day(e.t);
      if (d !== lastDay) { rows.push(div().pl(22).pt(i ? 10 : 2).pb(4).text_size(11).text_color(t.dim).child(d)); lastDay = d; }
      rows.push(this.row(t, e, i, i === shown.length - 1 || day(shown[i + 1].t) !== d));
    });
    return v_flex().flex_1().min_h(0).pt(14)
      .child(h_flex().px(14).pb(8).gap(6).items_center().flex_wrap()
        .child(div().mr(4).text_size(10.5).font_weight(600).text_color(t.muted).child("TIMELINE"))
        .children(FILTERS.map(([k, label]) => div().id(`f-${k}`).px(8).rounded(9).text_size(11.5)
          .bg(this.filter === k ? t.selected : t.background).text_color(this.filter === k ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.filter = k; cx.notify(); })
          .child(label))))
      .child(v_flex().id("events").flex_1().min_h(0).px(14).pb(14).overflow_y_scrollbar()
        .children(rows.length ? rows : [div().pl(22).pt(8).text_color(t.dim).child("該当する記録はありません")]));
  }

  row(t, e, i, last) {
    const color = { you: t.ansi5, report: t.ansi3, task: t.done ?? t.ansi2, pr: t.accent, wait: t.blocked, start: t.dim }[e.kind] ?? t.dim;
    const filled = e.kind === "task" || e.kind === "wait";
    const label = { you: "あなた", report: "Report", pr: "PR", wait: "確認待ち" }[e.kind];
    const key = `${e.t}-${i}-${e.kind}`;
    const open = this.open.has(key);
    const body = open && e.full ? e.full : e.text;
    return div().id(`e-${key}`).flex().gap(10).rounded(6).hover((s) => s.bg(t.hover))
      .on_click((_ev, cx) => { this.open.has(key) ? this.open.delete(key) : this.open.add(key); cx.notify(); })
      // 印と、次の印までの縦線
      .child(v_flex().w(12).flex_none().items_center().pt(5)
        .child(div().size(10).flex_none().rounded(5).border_2().border_color(color).bg(filled ? color : t.background))
        .when(!last, (el) => el.child(div().w(1).flex_1().mt(2).bg(t.border))))
      .child(div().w(36).flex_none().py(2).text_size(12).text_color(t.dim).child(clock(new Date(e.t * 1000))))
      .child(h_flex().flex_1().min_w(0).py(2).pr(4).gap(5).items_start()
        .when(Boolean(label), (el) => el.child(div().flex_none().text_color(t.muted).child(label)))
        .child(div().flex_1().min_w(0).when(open, (el) => el.whitespace_normal()).when(!open, (el) => el.truncate()).child(body)));
  }
}
