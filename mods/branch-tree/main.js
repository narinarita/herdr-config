// Spaces, their branches and the agents in them, as one tree (from `space-tree`):
//
//   [H] herdr-config              1 agent
//    ├ add-jira-tasks-mod                    <- the repo's own checkout (branch icon), when it has worktrees
//    └ design                                <- a worktree space (folder icon)
//       └ Herdr Appデザインの再現   14h ○     <- the agents in that branch
//   [D] Desktop                   2 agents   <- not a repo: agents right under it
//
// Stable colored avatars, grouped by machine when more than one is known, sub-agents
// under their agent, and a line at the bottom counting agents by state (this replaces
// the separate `agents` list). A space's + starts a terminal or an agent in that space;
// its chevron folds its agents away (folded, it shows how many and the most urgent
// state). Click to switch, right-click for its menu, drag to reorder.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { focused, spaces, machines, panes, run, openOverlay, closeOverlay, props, exec, hc, theme, shared, setShared, watchFolder, window, layout, agents, terminals, setAgentOrder, knownAgents } from "herdr";

// --- agents (from the `agents` mod) ---
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as blocked.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}
function tabTitle(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
// The program's icon from the app's table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}
// Folded spaces, shared so the launcher popup can unfold the space it starts in.
const FOLDED = "branch-tree.folded";
const foldedSpaces = () => new Set(shared(FOLDED) ?? []);
function setFolded(id, folded) {
  const s = foldedSpaces();
  if (folded) s.add(id); else s.delete(id);
  setShared(FOLDED, [...s]);
}
// The last agents each machine reported (the same cache as `new-menu`).
const KNOWN = "new-menu.agents";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
// How far a branch row's agents sit right of a space's: their elbow starts under the branch icon.
const UNDER_BRANCH = 20;
const plural = (n) => `${n} agent${n === 1 ? "" : "s"}`;
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class SpaceTree extends View {
  init(_props, cx) {
    if (props()?.launch) return this.initLauncher(cx);
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.hoverSpace = null;
    this.dragAgent = null; // the agent row being dragged (its tab moves)
    this.overAgent = null;
    cx.timer.every(30000, (cx) => cx.notify());
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  // --- the + launcher: a popup copy of this mod with props {launch: spaceId} ---
  initLauncher(cx) {
    const space = spaces().find((s) => s.id === props().launch);
    const machine = space?.machine;
    const where = machine ?? "";
    this.agents = shared(KNOWN)?.[where] ?? [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        this.agents = await knownAgents({ on: machine });
        setShared(KNOWN, { ...shared(KNOWN), [where]: this.agents });
      } catch { this.failed = true; }
      cx.notify();
    });
  }

  start(argv, name) {
    const id = props().launch;
    closeOverlay(props().overlay);
    setFolded(id, false);
    run("tab.new", { space: id, ...(name ? { name } : {}), ...(argv ? { argv } : {}) });
  }

  launcher(t) {
    const space = spaces().find((s) => s.id === props().launch);
    const installed = this.agents.filter((a) => a.installed);
    const choices = [...installed, ...this.agents.filter((a) => !a.installed).slice(0, 2)];
    const item = (id, pic, name, action, hint = "", enabled = true) => h_flex().id(id).h(31).px(9).gap(10).rounded(7).items_center().flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, (el) => el.hover((s) => s.bg(t.selected)))
      .on_click(() => { if (enabled) action(); })
      .child(pic).child(div().flex_1().truncate().child(name)).child(div().text_size(11).text_color(t.dim).child(hint));
    return v_flex().id("launcher").w_full().min_h(0).bg(t.popover).p(5).text_size(12.8)
      .track_focus(this.handle)
      .on_key_down((e) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        if (e.key === "t") return this.start(null, null);
        const agent = /^[1-9]$/.test(e.key) ? installed[Number(e.key) - 1] : null;
        if (agent) this.start(agent.run, agent.name);
      })
      .child(div().px(9).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(`Start in ${space?.name ?? "this space"}`))
      .children(choices.map((a, i) => item(`run-${a.key}`, a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14), a.name,
        () => this.start(a.run, a.name), a.installed ? (i < 9 ? String(i + 1) : "") : "not installed", a.installed)))
      .when(this.agents.length === 0, (el) => el.child(div().px(9).py(6).text_color(t.dim).child(this.failed ? "Could not load agents" : "Checking installed agents…")))
      .child(div().h(1).mx(4).my(5).bg(t.border))
      .child(item("run-terminal", svg("icons/shell.svg").size(14), "Terminal", () => this.start(null, null), "T"));
  }

  openLauncher(w) {
    const n = (shared(KNOWN)?.[w.machine ?? ""] ?? []).length || 4;
    openOverlay({ mod: "branch-tree", kind: "popup", width: 230, height: Math.min(420, 90 + n * 31), props: { launch: w.id } });
  }

  // Stamps agents whose state changed. Done and idle count as one.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Live sub-agents of `addr`, depth first, each with its depth.
  tree(addr, depth = 1) {
    const kids = this.terms.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k) => [{ t: k, depth }, ...this.tree(k.address, depth + 1)]);
  }

  // compact: a ! for blocked.
  status(t, status, compact = true) {
    if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    if (status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(status === "done" ? t.done : t.dim + "00");
  }

  // The elbow in front of an agent row, one per depth.
  elbow(t, depth, indent = 0) {
    return h_flex().flex_none().pl(9 + indent + (depth - 1) * 13).child(div().self_start().mt(-4).w(9).h(17).mr(5).flex_none()
      .border_l(1.5).border_b(1.5).rounded_bl(6).border_color(t.input));
  }

  agentRow(a, t, now, indent) {
    const pic = icon(a.program, 15, t.foreground);
    const idle = a.status === "idle" && !a.focused;
    const when = this.changed[a.address]?.at;
    const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
    const drag = this.dragAgent;
    const target = drag && this.overAgent === a.address && drag.tab !== a.tab;
    const up = target && drag.index > (this.tabIndex.get(a.tab) ?? 0);
    return h_flex().relative().id(`ag-${a.address}`).h(28).pl(8).pr(8).flex_none().rounded(8).items_center().gap(8).text_size(12.5)
      .when(a.focused, (el) => el.bg(t.selected))
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .when(drag?.address === a.address && this.overAgent !== a.address, (el) => el.opacity(0.5))
      .when(Boolean(target), (el) => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
        .when(up, (l) => l.top(0)).when(!up, (l) => l.bottom(0))))
      // Drag within its space to reorder (moves its tab); a plain click focuses it.
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        this.dragAgent = { address: a.address, tab: a.tab, space: a.space, index: this.tabIndex.get(a.tab) ?? 0 };
        this.overAgent = a.address;
      })
      .on_mouse_move((_e, cx) => {
        const over = this.dragAgent && this.dragAgent.space === a.space ? a.address : null;
        if (this.dragAgent && this.overAgent !== over) { this.overAgent = over; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation();
        const d = this.dragAgent;
        this.dragAgent = null;
        this.overAgent = null;
        if (d && d.address === a.address) run("pane.focus", { pane: a.pane });
        else if (d && d.space === a.space && d.tab !== a.tab) run("tab.move", { id: d.tab, index: this.tabIndex.get(a.tab) });
        cx.notify();
      })
      .child(this.elbow(t, 1, indent).gap(0))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_1().min_w(0).truncate().text_color(idle ? t.muted : t.foreground).child(this.agentName(a)))
      .when(Boolean(machine), (el) => el.child(div().text_size(10).text_color(t.dim).child(machine)))
      .when(Boolean(when), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
      .child(this.status(t, a.status));
  }

  subRow(s, t, shown, indent) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex().id(`sub-${k.address}`).h(26).pl(8).pr(8).flex_none().rounded(8).items_center().gap(8).text_size(12)
      .when(on, (el) => el.bg(t.raised))
      .hover((el) => el.bg(t.hover))
      .on_click(() => run("terminal.peek", { terminal: k.address }))
      .child(this.elbow(t, s.depth + 1, indent))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, st));
  }

  // A row's name: a tab someone named or the agent's own title, else its program.
  agentName(a) {
    const l = this.labels.get(a.tab) ?? (a.title || a.program?.name || "");
    return /^\d+$/.test(l) ? a.program?.name || l : l;
  }

  // The agents under a space in tab order, each followed by its sub-agents.
  // indent: UNDER_BRANCH when they hang from a branch row rather than the space's avatar.
  agentRows(w, t, indent = 0) {
    if (foldedSpaces().has(w.id)) return [];
    const now = Date.now();
    const shown = this.shownAgent;
    return (this.bySpace.get(w.id) ?? []).flatMap((a) => [this.agentRow(a, t, now, indent), ...this.tree(a.address).map((s) => this.subRow(s, t, shown, indent))]);
  }

  // A space and what hangs under it. A repo with worktrees gets a row for its own
  // checkout's branch, and its agents go under that row, like a worktree's.
  block(r, t) {
    const under = () => {
      const rows = this.agentRows(r.w, t, UNDER_BRANCH);
      return rows.length || foldedSpaces().has(r.w.id) ? rows : [this.noAgents(r.w, t)];
    };
    if (r.tree) return [...(r.header ? [this.repoRow(r.header, t)] : []), this.row(r, t), ...under()];
    if (r.kids) return [this.row(r, t), this.checkoutRow(r, t), ...under()];
    return [this.row(r, t), ...this.agentRows(r.w, t)];
  }

  // The repo's own checkout, as a branch beside its worktrees. Clicking it selects the repo's space.
  checkoutRow({ w, g }, t) {
    return h_flex().id(`checkout-${w.id}`).h(28).px(8).flex_none().rounded(8).items_center().gap(9)
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .on_mouse_down("right", () => this.menu(w))
      .child(div().pl(22).flex_none().child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
      .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.muted).child(g.branch ?? "detached"))
      .child(h_flex().flex_1().min_w(0).gap(5).justify_end().items_center().text_size(11).text_color(t.dim)
        .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`↑${g.ahead}`)))
        .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`↓${g.behind}`))));
  }

  // A repo whose main checkout has no space: a heading over its worktrees, not a space itself.
  repoRow({ name, repo, agents: count }, t) {
    const colors = Object.values(MARK);
    let hash = 0;
    for (const ch of repo) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return h_flex().id(`repo-${repo}`).h(30).px(8).flex_none().gap(9).items_center()
      .child(h_flex().size(18).flex_none().rounded(5).bg(colors[hash % colors.length]).items_center().justify_center()
        .text_size(10.5).font_bold().text_color("#ffffff").child([...name][0]?.toUpperCase() ?? "?"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(name))
      .when(count > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(plural(count))));
  }

  // Under a branch or worktree with no agents, so the empty branch doesn't look like a missing row.
  noAgents(w, t) {
    return div().id(`none-${w.id}`).h(26).flex_none().flex().items_center().pl(8 + 9 + UNDER_BRANCH + 15)
      .text_size(11.5).text_color(t.dim).child("Agent なし");
  }

  // The bottom line: how many agents are in each state, the urgent ones first.
  summary(t, list) {
    const count = { blocked: 0, done: 0, working: 0, idle: 0 };
    for (const a of list) if (a.status in count) count[a.status]++;
    const label = { blocked: "Needs you", done: "Done", working: "Working", idle: "Idle" };
    const shown = ["blocked", "done", "working", "idle"].filter((s) => count[s] > 0 || s === "working" || s === "idle");
    return h_flex().h(34).flex_none().px(16).gap(12).items_center().border_t(1).border_color(t.border).text_size(11.5).text_color(t.dim)
      .children(shown.map((s) => h_flex().id(`sum-${s}`).gap(6).items_center()
        .child(this.status(t, s))
        .child(div().text_color(count[s] > 0 && s !== "idle" ? tone(t, s) : t.dim).child(`${label[s]} ${count[s]}`))));
  }

  // The most urgent state among a space's agents and their sub-agents.
  topStatus(list) {
    let top = null;
    for (const a of list) {
      for (const s of [a.status, ...this.tree(a.address).map((k) => kidStatus(k.t, this.listed))]) {
        if ((RANK[s] ?? 0) > (RANK[top] ?? 0)) top = s;
      }
    }
    return top;
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    // A worktree whose repo has no space of its own (its main checkout was closed).
    const orphan = (r) => r.g?.linked && !mains.has(r.g.repo);
    const agentsIn = (x) => (this.bySpace.get(x.w.id) ?? []).length;
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      // Orphans of one repo go together, under a header row for the repo (drawn by block()).
      if (orphan(r)) {
        if (placed.has(r.g.repo)) continue;
        placed.add(r.g.repo);
        const kids = list.filter((k) => orphan(k) && k.g.repo === r.g.repo);
        const header = { name: r.g.name, repo: r.g.repo, agents: kids.reduce((n, k) => n + agentsIn(k), 0) };
        kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─", kids: 0, agents: agentsIn(k), header: n === 0 ? header : null }));
        continue;
      }
      const kids = !r.g || r.g.linked || placed.has(r.g.repo) ? [] : list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      // kids: how many worktrees hang under it; agents: its own and theirs, for the count on its row.
      out.push({ ...r, tree: null, kids: kids.length, agents: agentsIn(r) + kids.reduce((n, k) => n + agentsIn(k), 0) });
      if (!kids.length) continue;
      placed.add(r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─", kids: 0, agents: agentsIn(k) }));
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? [this.compact(r, t)] : this.block(r, t));
    // agent.next / agent.prev follow the tree.
    setAgentOrder(rows.flatMap((r) => (this.bySpace.get(r.w.id) ?? []).map((a) => a.address)));
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.flatMap(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      if (!collapsed && rebuilt) return [head];
      return [head, ...(folded ? [] : mine.length ? mine.flatMap(draw) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree, kids, agents: count }, t) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .on_hover((over, cx) => {
        if (over) this.hoverSpace = w.id;
        else if (this.hoverSpace === w.id) this.hoverSpace = null;
        cx.notify();
      })
      .child(
        h_flex()
          .gap(9)
          .items_center()
          // A worktree is a folder of its own: drawn as one, so it reads apart from the repo's own branch.
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/folder.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
          // With worktrees, its branch has its own row below; the space shows how many agents it holds.
          .child(g && !kids ? this.gitTail(g, tree, w.name, t) : div().flex_1())
          .when(!tree && count > 0 && !foldedSpaces().has(w.id), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(plural(count))))
          .child(this.spaceTail(w, t)),
      );
  }

  // After the git tail: folded, how many agents and the most urgent state; the fold
  // chevron when it has agents; the + while pointed at (or active).
  spaceTail(w, t) {
    const list = this.bySpace.get(w.id) ?? [];
    const folded = foldedSpaces().has(w.id);
    const top = folded ? this.topStatus(list) : null;
    const showPlus = this.hoverSpace === w.id || w.active;
    const button = (id) => div().id(id).size(20).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation());
    // Acts on press and keeps it from the row (which would start a drag and select the space).
    const press = (el, action) => el.on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); action(cx); });
    return h_flex().flex_none().gap(2).items_center()
      .when(folded && list.length > 0, (el) => el.child(div().text_size(11).text_color(t.dim).mr(2).child(String(list.length)))
        .when(Boolean(top) && top !== "idle", (el) => el.child(this.status(t, top))))
      .when(list.length > 0, (el) => el.child(press(button(`fold-${w.id}`), () => setFolded(w.id, !folded))
        .tooltip(folded ? "Show agents" : "Hide agents")
        .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11))))
      .child(press(button(`add-${w.id}`), () => this.openLauncher(w))
        .when(!showPlus, (el) => el.opacity(0))
        .tooltip(`Start an agent in ${w.name}`)
        .child(svg("mods/workspace-chrome/plus.svg").size(13)));
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render() {
    const t = theme();
    if (props()?.launch) return this.launcher(t);
    const collapsed = narrow();
    // Agents by space, in tab order (the order people drag them into); read once per render.
    const list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    this.terms = terminals();
    this.shownAgent = focused()?.agent;
    this.track(list, Date.now());
    this.bySpace = new Map();
    for (const a of list) {
      if (!this.bySpace.has(a.space)) this.bySpace.set(a.space, []);
      this.bySpace.get(a.space).push(a);
    }
    const leads = leadPanes(panes());
    this.tabIndex = new Map(spaces().flatMap((s) => s.tabs ?? []).map((tab) => [tab.id, tab.index]));
    this.labels = new Map(spaces().flatMap((s) => s.tabs ?? []).map((tab) => [tab.id, tabTitle(tab, leads.get(tab.id))]));
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.dragAgent = null; this.overAgent = null; cx.notify(); })
        .children(this.grouped(t, collapsed)))
      .when(!collapsed, (el) => el.child(this.summary(t, list)));
  }
}
