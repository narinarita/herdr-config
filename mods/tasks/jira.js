// Jira Cloud REST API v3, kept free of Herdr imports so it can run under node
// with a stub fetch. The board (main.js) only calls what is exported here.

export const COLUMNS = [
  { id: "todo", label: "TODO" },
  { id: "doing", label: "進行中" },
  { id: "review", label: "レビュー" },
  { id: "done", label: "完了" },
];
export const DEFAULT_JQL = "assignee = currentUser() AND sprint in openSprints() ORDER BY rank";
const IDS = new Set(COLUMNS.map((c) => c.id));

// Reads the config file's text: { site, email, jql?, columns?, keychain? }.
export function parseConfig(text) {
  if (text === null || text === undefined) throw new ConfigError("missing");
  let c;
  try { c = JSON.parse(text); } catch (e) { throw new ConfigError(`JSON として読めません: ${e.message ?? e}`); }
  const site = String(c.site ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const email = String(c.email ?? "").trim();
  if (!site) throw new ConfigError("site がありません（例: example.atlassian.net）");
  if (!email) throw new ConfigError("email がありません（Jira にログインするメールアドレス）");
  const columns = {};
  for (const [name, col] of Object.entries(c.columns ?? {})) {
    if (!IDS.has(col)) throw new ConfigError(`columns の「${name}」の値 ${JSON.stringify(col)} は todo / doing / review / done のどれかにしてください`);
    columns[name.toLowerCase()] = col;
  }
  return { site, email, jql: String(c.jql ?? "").trim() || DEFAULT_JQL, columns, keychain: String(c.keychain ?? "herdr-jira") };
}

export class ConfigError extends Error {}

// Which column a Jira status goes in: the config's columns by name, else a
// name that says review, else its status category.
export function columnOf(status, columns = {}) {
  if (!status) return null;
  const byName = columns[String(status.name ?? "").toLowerCase()];
  if (byName) return byName;
  if (/review|レビュー/i.test(status.name ?? "")) return "review";
  const cat = status.statusCategory?.key;
  return cat === "new" ? "todo" : cat === "indeterminate" ? "doing" : cat === "done" ? "done" : null;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function utf8(text) {
  const out = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

// No btoa in the mod runtime's type files, so encode by hand.
export function base64(text) {
  const bytes = utf8(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

export class JiraError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// Jira's error body: { errorMessages: [...], errors: { field: message } }.
function reason(status, body) {
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* not JSON */ }
  const parts = [...(parsed?.errorMessages ?? []), ...Object.values(parsed?.errors ?? {})].filter(Boolean);
  const detail = parts.join(" / ") || String(body ?? "").slice(0, 200);
  if (status === 401) return `認証に失敗しました（401）。email とキーチェーンのトークンを確かめてください。${detail ? `\n${detail}` : ""}`;
  if (status === 403) return `権限がありません（403）。IP 制限やトークンの範囲を確かめてください。${detail ? `\n${detail}` : ""}`;
  if (status === 404) return `見つかりません（404）。site を確かめてください。${detail ? `\n${detail}` : ""}`;
  return `Jira がエラーを返しました（${status}）${detail ? `\n${detail}` : ""}`;
}

export function client(config, token, fetchImpl) {
  const auth = `Basic ${base64(`${config.email}:${token}`)}`;
  const base = `https://${config.site}/rest/api/3`;
  async function call(method, path, body) {
    let r;
    try {
      r = await fetchImpl(base + path, {
        method,
        headers: { Authorization: auth, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new JiraError(`Jira に届きませんでした: ${e?.message ?? e}`, 0);
    }
    const text = await r.text();
    if (!r.ok) throw new JiraError(reason(r.status, text), r.status);
    return text ? JSON.parse(text) : null; // a transition answers 204 with no body
  }

  return {
    // Every issue the JQL finds, as { key, summary, type, status, column, url }.
    async issues() {
      const out = [];
      let next;
      for (let page = 0; page < 10; page++) {
        const r = await call("POST", "/search/jql", {
          jql: config.jql, fields: ["summary", "status", "issuetype"], maxResults: 100,
          ...(next ? { nextPageToken: next } : {}),
        });
        for (const i of r?.issues ?? []) out.push(issue(i, config));
        next = r?.nextPageToken;
        if (!next || r?.isLast) break;
      }
      return out;
    },
    // What this issue can move to now, each with the column it lands in.
    async transitions(key) {
      const r = await call("GET", `/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields`);
      return (r?.transitions ?? []).map((t) => ({
        id: t.id, name: t.name, to: t.to, column: columnOf(t.to, config.columns), needs: needs(t.fields),
      }));
    },
    async transition(key, id, fields) {
      await call("POST", `/issue/${encodeURIComponent(key)}/transitions`, { transition: { id }, ...(fields ? { fields } : {}) });
    },
  };
}

function issue(i, config) {
  const status = i.fields?.status ?? null;
  return {
    key: i.key,
    summary: i.fields?.summary ?? "",
    type: i.fields?.issuetype?.name ?? "",
    status,
    column: columnOf(status, config.columns),
    url: `https://${config.site}/browse/${i.key}`,
  };
}

// Required fields a transition's screen asks for, without a default:
// { resolution: [{id, name}] } handled here; anything else listed by name.
function needs(fields) {
  const out = { resolution: null, other: [] };
  for (const [id, f] of Object.entries(fields ?? {})) {
    if (!f?.required || f.hasDefaultValue) continue;
    if (id === "resolution") out.resolution = (f.allowedValues ?? []).map((v) => ({ id: v.id, name: v.name }));
    else out.other.push(f.name ?? id);
  }
  return out;
}

// What to do with a drop of an issue onto a column, given its transitions:
// { error } | { choose: [transition, ...] } (several lead there) | { go: transition }.
export function plan(transitions, column, columnLabel) {
  const here = transitions.filter((t) => t.column === column);
  if (here.length === 0) {
    const can = [...new Set(transitions.map((t) => t.to?.name).filter(Boolean))];
    return { error: `「${columnLabel}」には移せません。今いけるのは ${can.join("、") || "なし"} です。` };
  }
  const ok = here.filter((t) => t.needs.other.length === 0);
  if (ok.length === 0) return { error: `この遷移には ${here[0].needs.other.join("、")} の入力が要ります。Jira で操作してください。` };
  return ok.length === 1 ? { go: ok[0] } : { choose: ok };
}
