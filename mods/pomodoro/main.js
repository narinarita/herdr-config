// ポモドーロタイマー。全 space で共通のタイマーを 1 つ持つ。
//
// レイアウトでは、ステータスバーの右端に置く:
//   { "id": "pomodoro", "type": "block", "size": { "px": 112 }, "content": { "mod": "pomodoro" } }
// ステータスバーには輪・「集中 / 休憩」・残り時間だけを出す。クリックすると、同じ mod を
// props { popup: true } でポップアップとして開き、開始・一時停止・次へ・リセットを置く。
//
// 状態は shared("pomodoro") に置く（Herdr を閉じても残り、ポップアップとも共有できる）:
//   { mode: "focus" | "rest", round: 1..4, running, endsAt: 終わる時刻(ms) | null, left: 止めている間の残り秒 }

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, settings, shared, setShared, openOverlay, closeOverlay, notify, exec, props } from "herdr";

const KEY = "pomodoro";
const FOCUS = 25 * 60;
const REST = 5 * 60;
const LONG_REST = 15 * 60;
const ROUNDS = 4;
const STEPS = 24; // ring-00.svg 〜 ring-24.svg
// Herdr を閉じている間に終わっていた回は、知らせずに次へ進める。
const LATE = 60 * 1000;

const initial = () => ({ mode: "focus", round: 1, running: false, endsAt: null, left: FOCUS });

function load() {
  const s = shared(KEY);
  return s && typeof s === "object" && (s.mode === "focus" || s.mode === "rest") ? s : initial();
}

function total(s) {
  if (s.mode === "focus") return FOCUS;
  return s.round % ROUNDS === 0 ? LONG_REST : REST;
}

function remaining(s, now = Date.now()) {
  if (!s.running) return s.left;
  return Math.max(0, Math.ceil((s.endsAt - now) / 1000));
}

function fmt(sec) {
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

// 集中が終わったら休憩をすぐ始め、休憩が終わったら次の集中は止めたまま待つ。
function nextPhase(s, now = Date.now()) {
  if (s.mode === "focus") {
    const rest = { mode: "rest", round: s.round, running: true, endsAt: null, left: 0 };
    const len = total(rest);
    return { ...rest, endsAt: now + len * 1000, left: len };
  }
  return { mode: "focus", round: (s.round % ROUNDS) + 1, running: false, endsAt: null, left: FOCUS };
}

function start(s, now = Date.now()) {
  return { ...s, running: true, endsAt: now + s.left * 1000 };
}

function pause(s, now = Date.now()) {
  return { ...s, running: false, endsAt: null, left: remaining(s, now) };
}

function colors() {
  const dark = Boolean(settings().dark);
  return { focus: dark ? "#ec7458" : "#d4553a", rest: dark ? "#4fbf93" : "#2f8f6b" };
}

function chime() {
  if (settings().sounds?.enabled === false) return;
  exec("afplay", ["/System/Library/Sounds/Glass.aiff"]).catch(() => {});
}

function announce(s) {
  if (s.mode === "rest") {
    notify({ title: `集中 ${s.round} 回目が終わりました`, body: `${total(s) / 60} 分休憩します`, level: "success" });
  } else {
    notify({ title: "休憩が終わりました", body: "ステータスバーのタイマーから次の集中を始めます", level: "info" });
  }
  chime();
}

export default class Pomodoro extends View {
  init(_props, cx) {
    this.popup = Boolean(props()?.popup);
    // 動いている間だけ 1 秒ごとに描き直す。止まっている間は何もしない。
    cx.timer.every(1000, (cx) => {
      const s = load();
      if (!s.running) return;
      if (!this.popup && remaining(s) === 0) {
        const late = Date.now() - s.endsAt > LATE;
        const next = nextPhase(s);
        setShared(KEY, next);
        if (!late) announce(next);
      }
      cx.notify();
    });
  }

  ring(s, size, color) {
    const t = theme();
    const step = Math.round((remaining(s) / total(s)) * STEPS);
    const name = String(Math.max(0, Math.min(STEPS, step))).padStart(2, "0");
    return div().relative().size(size).flex_none()
      .child(svg("mods/pomodoro/ring-track.svg").absolute().top(0).left(0).size(size).text_color(t.border))
      .child(svg(`mods/pomodoro/ring-${name}.svg`).absolute().top(0).left(0).size(size)
        .text_color(color).opacity(s.running ? 1 : 0.5));
  }

  render() {
    return this.popup ? this.renderPopup() : this.renderBar();
  }

  renderBar() {
    const t = theme();
    const s = load();
    const c = colors();
    const color = s.mode === "focus" ? c.focus : c.rest;
    const mono = settings().font_family || settings().font;
    return h_flex().size_full().justify_end().items_center().px(10)
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8)
      .child(h_flex().id("pomodoro-chip").gap(6).items_center().px(8).py(2).rounded(6)
        .text_color(t.muted)
        .hover((st) => st.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "pomodoro", props: { popup: true }, kind: "popup", width: 260, height: 172 });
        })
        .child(this.ring(s, 13, color))
        .child(div().text_color(color).child(s.mode === "focus" ? "集中" : "休憩"))
        .child(div().when(Boolean(mono), (el) => el.font_family(mono)).child(fmt(remaining(s)))));
  }

  renderPopup() {
    const t = theme();
    const s = load();
    const c = colors();
    const color = s.mode === "focus" ? c.focus : c.rest;
    const mono = settings().font_family || settings().font;
    const set = (next, cx) => { setShared(KEY, next); cx.notify(); };

    const button = (id, label, primary, onClick) => div().id(id)
      .px(10).py(4).rounded(6).text_size(12).border(1)
      .border_color(primary ? color : t.border)
      .bg(primary ? color : t.surface)
      .text_color(primary ? "#ffffff" : t.foreground)
      .hover((st) => (primary ? st.opacity(0.9) : st.bg(t.hover)))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(label);

    // 周回: 終わった回は塗り、今の回は枠だけ。
    const pips = h_flex().gap(3).items_center().children(
      Array.from({ length: ROUNDS }, (_, i) => {
        const n = i + 1;
        const done = n < s.round || (n === s.round && s.mode === "rest");
        const now = n === s.round && s.mode === "focus";
        return div().size(6).rounded(3)
          .when(!now, (el) => el.bg(done ? c.focus : t.border))
          .when(now, (el) => el.border(1).border_color(c.focus));
      }));

    const label = s.mode === "focus" ? `集中 ${s.round} / ${ROUNDS}` : (s.round % ROUNDS === 0 ? "長い休憩" : "休憩");
    const primary = s.running
      ? button("pomo-pause", "一時停止", true, (cx) => set(pause(s), cx))
      : button("pomo-start", s.left === total(s) ? "開始" : "再開", true, (cx) => set(start(s), cx));

    return v_flex().size_full().p(14).gap(10).text_color(t.foreground)
      .child(h_flex().gap(12).items_center()
        .child(this.ring(s, 40, color))
        .child(v_flex().gap(2)
          .child(div().text_size(24).font_weight(600).when(Boolean(mono), (el) => el.font_family(mono)).child(fmt(remaining(s))))
          .child(h_flex().gap(6).items_center().text_size(11)
            .child(div().text_color(color).child(label))
            .child(pips))))
      .child(h_flex().gap(6)
        .child(primary)
        .child(button("pomo-next", "次へ", false, (cx) => set(nextPhase(s), cx)))
        .child(button("pomo-reset", "リセット", false, (cx) => { set(initial(), cx); closeOverlay(props().overlay); })))
      .child(div().text_size(11).text_color(t.dim).child("集中 25 分 · 休憩 5 分 · 4 回ごとに 15 分"));
  }
}
