// New Claude worktree: fetch origin, make a worktree on a new branch from
// origin's default branch in <repo>/.claude/worktrees/, open it as a space
// and start claude there. Opened by a key (mod.open:claude-worktree); the
// repo is the focused space's. Empty input makes a placeholder branch
// wip/<MMDD>-<HHMM>, to be renamed before the first push.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, focused, exec, home } from "herdr";

const DIR = ".claude/worktrees"; // under the repo's main checkout
const ARGV = ["claude"];

const tilde = (path) => (path.startsWith(home()) ? `~${path.slice(home().length)}` : path);
const two = (n) => String(n).padStart(2, "0");

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

async function git(cwd, args, timeout) {
  const r = await exec("git", args, { cwd, ...(timeout === undefined ? {} : { timeout }) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

export default class ClaudeWorktree extends View {
  init(_props, cx) {
    this.text = "";
    this.stamp = new Date(); // fixed while the dialog is open, so the preview doesn't drift
    this.input = InputState.new({ value: "", placeholder: "ブランチ名（空のまま Enter で仮の名前）" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.input.focus();
    this.busy = "";
    this.error = "";
    this.skipFetch = false; // set after a failed fetch: the next Enter goes on with local refs
    this.repo = undefined; // undefined: looking, null: can't be used (this.error says why)
    this.local = new Set(); // branch names here
    this.remote = new Set(); // branch names on origin
    cx.spawn(async (cx) => {
      try { this.repo = await this.find(); }
      catch (error) { this.repo = null; this.error = String(error); }
      cx.notify();
      this.handle.focus();
      cx.timer.after(100, () => this.input.focus());
    });
  }

  // The focused space's repo: { main, name, base } (base: origin's default branch, "origin/develop").
  async find() {
    const s = spaces().find((x) => x.id === focused()?.space);
    if (s?.machine) throw "別のマシンの space では使えません（この Mac の space だけ）。";
    const folder = place(s) || focused()?.cwd;
    if (!folder) throw "作業するリポジトリの space を選んでから開いてください。";
    const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!common.ok) throw `${tilde(folder)} は git リポジトリではありません。`;
    const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
    const repo = { main, name: main.split("/").pop(), base: "" };
    await this.refs(repo);
    return repo;
  }

  // Reads origin's default branch and the branch names (again after a fetch).
  async refs(repo) {
    const head = await git(repo.main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (!head.ok) throw "origin の既定ブランチが分かりません。git remote set-head origin -a を実行してください。";
    repo.base = head.out;
    const list = await git(repo.main, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"]);
    this.local = new Set();
    this.remote = new Set();
    for (const ref of list.out.split("\n")) {
      if (ref.startsWith("refs/heads/")) this.local.add(ref.slice(11));
      else if (ref.startsWith("refs/remotes/origin/")) this.remote.add(ref.slice(20));
    }
  }

  // What Enter would make: { branch, from, path }. `from` is null for a branch that exists here.
  plan() {
    const r = this.repo;
    let branch = this.text.trim();
    if (!branch) {
      const d = this.stamp;
      const base = `wip/${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
      branch = base;
      for (let n = 2; this.local.has(branch) || this.remote.has(branch); n++) branch = `${base}-${n}`;
    }
    const from = this.local.has(branch) ? null : this.remote.has(branch) ? `origin/${branch}` : r.base;
    return { branch, from, path: `${r.main}/${DIR}/${branch.replace(/\//g, "-")}` };
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  go(cx) {
    if (this.busy || !this.repo) return;
    cx.spawn(async (cx) => {
      this.error = "";
      try { this.error = await this.create(cx); }
      catch (error) { this.error = String(error); }
      this.busy = "";
      if (!this.error) this.close();
      cx.notify();
    });
  }

  async create(cx) {
    const r = this.repo;
    const step = (text) => { this.busy = text; cx.notify(); };
    const typed = this.text.trim();
    if (typed) {
      step("ブランチ名を確認しています…");
      // Also refuses a leading "-", which git would read as an option.
      if (!(await git(r.main, ["check-ref-format", "--branch", typed])).ok) return `「${typed}」はブランチ名に使えません。`;
    }
    if (!this.skipFetch) {
      step("git fetch origin…");
      let fetched;
      try { fetched = await git(r.main, ["fetch", "origin"], 120_000); }
      catch (error) { fetched = { ok: false, err: String(error) }; }
      if (!fetched.ok) {
        this.skipFetch = true;
        return `fetch に失敗しました。もう一度 Enter で、手元の参照のまま進めます。\n${fetched.err}`;
      }
      await this.refs(r);
    }
    const { branch, from, path } = this.plan();
    step("worktree を作っています…");
    const add =
      from === null ? ["worktree", "add", path, branch]
      : from === r.base ? ["worktree", "add", "--no-track", "-b", branch, path, from] // never push or pull the default branch by accident
      : ["worktree", "add", "--track", "-b", branch, path, from];
    const made = await git(r.main, add, 600_000);
    if (!made.ok) return made.err || "git worktree add に失敗しました。";
    // The space stays unnamed, so it follows the folder and nests under the repo's space.
    run("space.new", { folder: path, machine: "", argv: ARGV });
    return "";
  }

  key(e, cx) {
    if (e.key === "escape") { this.close(); cx.stop_propagation(); }
  }

  render() {
    const t = theme();
    const r = this.repo;
    const plan = r ? this.plan() : null;
    const line = (label, value) =>
      h_flex().gap(10).items_start()
        .child(div().flex_none().w(64).text_color(t.dim).child(label))
        .child(div().flex_1().min_w(0).text_color(t.foreground).child(value));
    const from = plan && (plan.from === null ? "手元にある同じ名前のブランチを使う" : plan.from === r.base ? `${plan.from}（fetch してから）` : `${plan.from}（origin にあるブランチを追跡）`);
    return v_flex()
      .id("claude-worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(`New Claude worktree${r ? ` of ${r.name}` : ""}`))
      .when(r === undefined, (el) => el.child(div().text_color(t.muted).child("…")))
      .when(Boolean(r), (el) =>
        el
          .child(Input.new(this.input).h(34).px(10).items_center().rounded(8).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
          .child(
            v_flex().gap(4).text_size(12)
              .child(line("ブランチ", plan.branch))
              .child(line("起点", from))
              .child(line("置き場所", tilde(plan.path))),
          ),
      )
      .when(Boolean(this.error), (el) => el.children(this.error.split("\n").slice(0, 6).map((l) => div().text_color(t.blocked).child(l))))
      .child(
        h_flex().pt(4).justify_end().gap(6).text_size(11).text_color(t.dim)
          .when(Boolean(this.busy), (el) => el.child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
          .child(this.busy || (r ? "↵ 作って claude を起動 · esc 閉じる" : "esc 閉じる")),
      );
  }
}
