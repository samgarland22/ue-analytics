// UE Baseball player app. One page, no build step: GitHub Pages serves this folder as is.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const cfg = window.UE_CONFIG || {};
const app = document.getElementById("app");
const modalRoot = document.getElementById("modal-root");

// An invite or password-reset link lands here with type=invite / type=recovery in the URL.
const arrivedToSetPassword = /type=(invite|recovery)/.test(location.hash);

const CATEGORIES = [
  "A pitch type is wrong",
  "A stat or number is wrong",
  "A play result is wrong",
  "Video is wrong or missing",
  "Something else",
];
const AREAS = ["Pitching", "Hitting", "Baserunning", "Defense", "Video"];
const OUTCOME_LABEL = { fixed: "Fixed", no_change: "No change", coach: "Sam has it" };

// ------------------------------------------------------------------ tiny DOM helper
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v; // only ever used with constant strings
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const fmtWhen = (iso) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtDate = (d) =>
  d ? new Date(d + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";

// ------------------------------------------------------------------ setup guard
if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR-PROJECT")) {
  app.replaceChildren(
    h("div", { class: "login" },
      h("div", { class: "card" },
        h("div", { class: "brand" }, "UE Baseball"),
        h("p", {}, "Almost there. Put the Supabase URL and anon key in config.js, then reload."))));
  throw new Error("config.js not filled in yet");
}

const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const state = {
  me: null, user: null, setPassword: arrivedToSetPassword,
  rosterSide: "hitters", viewing: null, season: null,
  sites: [], frame: null,
  news: [],
};

// ------------------------------------------------------------------ routing
sb.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") state.setPassword = true;
  // defer so supabase finishes its own work before we query
  setTimeout(() => route(session), 0);
});

let routing = false;
async function route(session) {
  if (routing) return;
  routing = true;
  try {
    if (!session) { state.me = null; return renderLogin(); }
    state.user = session.user;
    if (state.setPassword) return renderSetPassword();
    const { data, error } = await sb.rpc("whoami");
    if (error) return renderError(error.message);
    state.me = data && data[0];
    if (!state.me) return renderNotOnRoster();
    await loadSites();
    await loadNews();
    const want = siteFromHash();
    if (want && state.sites.some((s) => s.key === want.site)) { openSite(want.site, want.anchor); maybeShowGuide(); maybeShowNews(); return; }
    goHome();
    maybeShowGuide();
    maybeShowNews();
    return;
  } finally {
    routing = false;
  }
}

function goHome() {
  if (state.me.role === "coach") return state.viewing ? renderPlayerPage(state.viewing) : renderRoster();
  return renderPlayerPage({ slug: state.me.slug, display_name: state.me.display_name, side: state.me.side });
}

// ------------------------------------------------------------------ hub sites as tabs
// Coaches get every site; players only the ones marked players = true. The database decides, not this code.
async function loadSites() {
  const { data } = await sb.from("sites").select("key, title, path, sort, updated_at, artifact_url, per_player, player_dir, player_path").order("sort");
  state.sites = data || [];
}
function siteFromHash() {
  const m = location.hash.match(/^#site=([\w-]+)(?:&a=([^&]*))?/);
  return m ? { site: m[1], anchor: m[2] ? decodeURIComponent(m[2]) : "" } : null;
}
function clearSiteHash() {
  if (location.hash.startsWith("#site=")) history.replaceState(null, "", location.pathname + location.search);
}

// The site's HTML, from this browser's cache when the version hasn't changed (saves Supabase's monthly download
// allowance), otherwise downloaded fresh from the private bucket.
// A per-player site (the Pitching Lab and the Hitting Lab, 6 Nov 2026): a player gets his own file,
// <player_dir>/<slug>.html (labs/ for pitchers, labs/hitting/ for hitters) -- his card and
// report only. The database only lets him download that one; coaches get the full site.
const ownFile = (s) => s.per_player && state.me && state.me.role !== "coach";
async function siteHtml(s) {
  if (ownFile(s)) {
    const { data, error } = await sb.storage.from("sites").download(`${s.player_dir || "labs"}/${state.me.slug}.html`);
    if (error) throw new Error(`Your ${s.title} isn't ready yet. It shows up after the next update.`);
    return await data.text();   // not cached: it is small, and it changes on its own schedule
  }
  // A site can give players a different file (9 Nov 2026: the Pitching Lab without coach notes, sites.player_path).
  // The database only lets a player download that one; coaches always get s.path.
  const file = (s.player_path && state.me && state.me.role !== "coach") ? s.player_path : s.path;
  const ck = `https://ue-sites.invalid/${s.key}?v=${encodeURIComponent(s.updated_at)}&f=${encodeURIComponent(file)}`;
  let cache = null;
  try { cache = await caches.open("ue-sites"); } catch { /* no Cache Storage here */ }
  if (cache) {
    try { const hit = await cache.match(ck); if (hit) return await hit.text(); } catch { /* fall through */ }
  }
  const { data, error } = await sb.storage.from("sites").download(file);
  if (error) throw error;
  const txt = await data.text();
  if (cache) {
    try {
      for (const req of await cache.keys()) if (req.url.startsWith(`https://ue-sites.invalid/${s.key}?`)) await cache.delete(req);
      await cache.put(ck, new Response(txt, { headers: { "content-type": "text/html" } }));
    } catch { /* cache is a nicety */ }
  }
  return txt;
}

// Added to the top of every site before it opens:
//  - a stand-in for browser storage (the site runs walled off from the app, where real storage throws)
//  - links to another site's old claude.ai address open that site's tab instead of leaving the app
function prepareSite(html) {
  const idOf = (u) => ((u || "").match(/artifact\/([A-Za-z0-9-]+)/) || [])[1];
  const map = {};
  for (const s of state.sites) { const id = idOf(s.artifact_url); if (id) map[id] = s.key; }
  const hub = idOf(cfg.HUB_URL) || "";
  const shim = `<script>(function(){
function mem(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}
["localStorage","sessionStorage"].forEach(function(n){try{window[n].getItem("_")}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}});
var M=${JSON.stringify(map)},HUB=${JSON.stringify(hub)};
document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;
var m=(a.getAttribute("href")||"").match(/claude\\.ai\\/(?:code\\/)?artifact\\/([A-Za-z0-9-]+)[^#]*(?:#(.*))?/);if(!m)return;
var k=M[m[1]]||(HUB&&m[1]===HUB?"__home":null);if(!k)return;e.preventDefault();
parent.postMessage({ue:"open",site:k,anchor:m[2]||""},"*");},true);
})();<\/script>`;
  // The shim goes RIGHT AFTER <!doctype html>, never after a searched-for "<head>": the Pitching Lab has no
  // <head> tag, and the only "<head>" in it is inside its print-to-PDF JavaScript string, so searching for one
  // dropped the shim into the middle of the Lab's script and nothing ran (6 Nov). The hub's templates also put
  // their ue-version tag ABOVE the doctype, which would drop the page into quirks mode, so that moves below it.
  // Some built pages (the Lab) have NO doctype at the top at all -- the first "<!doctype" in the Lab is 8.8 MB in,
  // inside that same print code. claude.ai adds the page skeleton when it publishes, so they render in standards
  // mode there; here we add the doctype ourselves so they look the same.
  const dt = html.match(/<!doctype[^>]*>/i);
  if (dt && dt.index < 2000) {
    const before = html.slice(0, dt.index).trim();
    return dt[0] + before + shim + html.slice(dt.index + dt[0].length);
  }
  return "<!doctype html>" + shim + html;
}

const siteUrls = new Map(); // key -> { v, url }
async function openSite(key, anchor) {
  const s = state.sites.find((x) => x.key === key);
  if (!s) return goHome();
  history.replaceState(null, "", `${location.pathname}${location.search}#site=${key}${anchor ? "&a=" + encodeURIComponent(anchor) : ""}`);
  const holder = h("div", { class: "site-holder" }, h("div", { class: "empty site-loading" }, `Loading ${s.title}…`));
  app.classList.add("full");
  app.replaceChildren(header("site:" + key), holder);
  state.frame = null;
  try {
    let got = siteUrls.get(key);
    if (!got || got.v !== s.updated_at) {
      if (got) URL.revokeObjectURL(got.url);
      const html = prepareSite(await siteHtml(s));
      got = { v: s.updated_at, url: URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" })) };
      siteUrls.set(key, got);
    }
    const frame = h("iframe", {
      class: "site-frame", title: s.title,
      // walled off from the app: the site can't read your login or reach the database
      sandbox: "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-forms",
      src: got.url + (anchor ? "#" + anchor : ""),
    });
    state.frame = frame;
    holder.replaceChildren(frame);
  } catch (e) {
    holder.replaceChildren(h("div", { class: "empty" }, ownFile(s) ? (e.message || String(e)) : `Couldn't open ${s.title}: ${e.message || e}`));
  }
}

window.addEventListener("message", (e) => {
  if (!state.frame || e.source !== state.frame.contentWindow) return;
  const d = e.data || {};
  if (d.ue === "targets") { targetsBridge(d, e.source); return; }
  if (d.ue !== "open") return;
  if (d.site === "__home") { clearSiteHash(); return goHome(); }
  openSite(d.site, d.anchor);
});

window.addEventListener("hashchange", () => {
  if (!state.me) return;
  const want = siteFromHash();
  if (want) openSite(want.site, want.anchor);
});

// ------------------------------------------------------------------ chrome
function header(active) {
  const me = state.me;
  const home = me.role === "coach"
    ? h("button", { class: "tab" + (active === "roster" ? " on" : ""), onclick: () => { state.viewing = null; clearSiteHash(); renderRoster(); } }, "Roster")
    : h("button", { class: "tab" + (active === "me" ? " on" : ""), onclick: () => { clearSiteHash(); goHome(); } }, "My page");
  const siteTabs = state.sites.map((s) =>
    h("button", { class: "tab" + (active === "site:" + s.key ? " on" : ""), onclick: () => openSite(s.key) }, s.title));
  // until the sites are uploaded, coaches keep the old hub link
  const oldHub = me.role === "coach" && !state.sites.length && cfg.HUB_URL
    ? h("a", { class: "tab", href: cfg.HUB_URL, target: "_blank", rel: "noopener" }, "Analytics hub") : null;
  const tabs = [home, ...siteTabs, oldHub];
  return h("header", { class: "top" },
    h("div", { class: "wrap wide" },
      h("div", { class: "top-row" },
        h("span", { class: "brand" }, "UE Baseball"),
        h("span", { class: "who" }, me.display_name),
        state.news.length ? h("button", { class: "top-btn news-btn" + (unseenNews().length ? " has-new" : ""), onclick: () => openNews() }, "News") : null,
        h("button", { class: "top-btn", onclick: () => openGuide() }, "Guide"),
        me.role === "coach" ? h("button", { class: "top-btn", onclick: openChangePassword }, "Change password") : null,  // players sign in with codes
        h("button", { class: "top-btn", onclick: () => sb.auth.signOut() }, "Sign out")),
      h("nav", { class: "tabs" }, tabs)));
}
function page(active, ...content) {
  app.classList.remove("full");
  state.frame = null;
  app.replaceChildren(header(active), h("main", {}, h("div", { class: "wrap" }, content)));
  window.scrollTo(0, 0);
}
function renderError(text) {
  app.replaceChildren(h("div", { class: "login" }, h("div", { class: "card" },
    h("div", { class: "brand" }, "UE Baseball"), h("p", { class: "msg err" }, text),
    h("button", { class: "btn", onclick: () => sb.auth.signOut() }, "Sign out"))));
}
function renderNotOnRoster() {
  app.replaceChildren(h("div", { class: "login" }, h("div", { class: "card" },
    h("div", { class: "brand" }, "UE Baseball"),
    h("p", {}, `You're signed in as ${state.user.email}, but that email isn't on the roster yet. Ask Sam to add it.`),
    h("button", { class: "btn", onclick: () => sb.auth.signOut() }, "Sign out"))));
}

// ------------------------------------------------------------------ login
// Sign in with a code from the email (9 Nov 2026). School email (UE runs Microsoft 365) opens every link in an
// incoming email to check it, which used up the one-time sign-in links before Jarrett and Jack could tap them.
// A code can't be used up that way. The email shows only the code, no link (Supabase > Auth > Emails > Magic Link).
// shouldCreateUser: false -- sign-ups stay off, so only emails Sam has added can get a code.
// Password sign-in stays for anyone who already set one (Sam), behind "Use a password instead".
const CODE_RE = /^\d{6,10}$/;
function loginShell(...kids) {
  app.replaceChildren(h("div", { class: "login" }, h("div", { class: "card" },
    h("div", { class: "brand" }, "UE Baseball"),
    h("p", { class: "words" }, "Your numbers, your Labs, your reports."), ...kids)));
}
function friendlyAuthError(error) {
  const m = (error && error.message || "").toLowerCase();
  if (error && (error.status === 429 || m.includes("rate limit") || m.includes("security purposes")))
    return "Too many codes were sent in the last few minutes. Wait a bit, then try again.";
  if (m.includes("signups not allowed") || m.includes("not found") || m.includes("not allowed"))
    return "That email isn't set up yet. Ask Sam to add it.";
  return "Something went wrong: " + (error && error.message || "unknown error");
}
function renderLogin(prefill) {
  const email = h("input", { type: "email", autocomplete: "username", inputmode: "email", required: true, value: prefill || "" });
  const msg = h("div", { class: "msg" });
  const go = h("button", { class: "btn primary", type: "submit" }, "Email me a code");
  const form = h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      const addr = email.value.trim().toLowerCase();
      if (!addr) return;
      go.disabled = true; msg.className = "msg"; msg.textContent = "Sending...";
      const { error } = await sb.auth.signInWithOtp({ email: addr, options: { shouldCreateUser: false } });
      go.disabled = false;
      if (error) { msg.className = "msg err"; msg.textContent = friendlyAuthError(error); return; }
      renderCode(addr);
    },
  },
    h("label", {}, "School email"), email,
    h("div", { class: "btn-row" }, go,
      h("button", { type: "button", class: "linkish", onclick: () => renderPasswordLogin(email.value.trim()) }, "Use a password instead")),
    msg);
  loginShell(h("p", {}, "We'll email you a code to sign in. No password needed."), form);
  email.focus();
}
function renderCode(addr) {
  const code = h("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9]*",
    maxlength: 10, required: true, class: "code-input", placeholder: "123456" });
  const msg = h("div", { class: "msg" });
  const go = h("button", { class: "btn primary", type: "submit" }, "Sign in");
  const form = h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      const token = code.value.replace(/\s+/g, "");
      if (!CODE_RE.test(token)) { msg.className = "msg err"; msg.textContent = "Type the number from the email."; return; }
      go.disabled = true; msg.className = "msg"; msg.textContent = "";
      const { error } = await sb.auth.verifyOtp({ email: addr, token, type: "email" });
      go.disabled = false;
      if (error) {
        msg.className = "msg err";
        msg.textContent = /expired|invalid/i.test(error.message)
          ? "That code didn't work. It may be mistyped or expired. Check the newest email, or send a new code."
          : friendlyAuthError(error);
      }
      // success: onAuthStateChange routes into the app
    },
  },
    h("label", {}, "Code from the email"), code,
    h("div", { class: "btn-row" }, go,
      h("button", { type: "button", class: "linkish", onclick: async () => {
        msg.className = "msg"; msg.textContent = "Sending...";
        const { error } = await sb.auth.signInWithOtp({ email: addr, options: { shouldCreateUser: false } });
        if (error) { msg.className = "msg err"; msg.textContent = friendlyAuthError(error); return; }
        msg.className = "msg ok"; msg.textContent = "New code sent. Use the newest email.";
      } }, "Send a new code")),
    msg);
  loginShell(h("p", {}, `We emailed a code to ${addr}. It can take a minute; check junk mail too.`), form,
    h("p", { class: "fine" }, h("button", { type: "button", class: "linkish", onclick: () => renderLogin(addr) }, "Use a different email")));
  code.focus();
}
function renderPasswordLogin(prefill) {
  const email = h("input", { type: "email", autocomplete: "username", required: true, value: prefill || "" });
  const pw = h("input", { type: "password", autocomplete: "current-password", required: true });
  const msg = h("div", { class: "msg" });
  const go = h("button", { class: "btn primary", type: "submit" }, "Sign in");
  const form = h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      go.disabled = true; msg.className = "msg"; msg.textContent = "";
      const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pw.value });
      go.disabled = false;
      if (error) { msg.className = "msg err"; msg.textContent = "That email and password didn't match."; }
    },
  },
    h("label", {}, "School email"), email,
    h("label", {}, "Password"), pw,
    h("div", { class: "btn-row" }, go,
      h("button", { type: "button", class: "linkish", onclick: () => renderLogin(email.value.trim()) }, "Email me a code instead")),
    msg);
  loginShell(form);
}

function passwordForm(onDone, submitLabel) {
  const a = h("input", { type: "password", autocomplete: "new-password", minlength: 8, required: true });
  const b = h("input", { type: "password", autocomplete: "new-password", minlength: 8, required: true });
  const msg = h("div", { class: "msg" });
  const go = h("button", { class: "btn primary", type: "submit" }, submitLabel);
  return h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      if (a.value !== b.value) { msg.className = "msg err"; msg.textContent = "Those don't match."; return; }
      go.disabled = true;
      const { error } = await sb.auth.updateUser({ password: a.value });
      go.disabled = false;
      if (error) { msg.className = "msg err"; msg.textContent = error.message; return; }
      onDone();
    },
  }, h("label", {}, "New password (8+ characters)"), a, h("label", {}, "Type it again"), b,
    h("div", { class: "btn-row" }, go), msg);
}
function renderSetPassword() {
  app.replaceChildren(h("div", { class: "login" }, h("div", { class: "card" },
    h("div", { class: "brand" }, "UE Baseball"),
    h("p", {}, "Pick a password for your account."),
    passwordForm(() => {
      state.setPassword = false;
      history.replaceState(null, "", location.pathname);
      sb.auth.getSession().then(({ data }) => route(data.session));
    }, "Save password"))));
}
function openChangePassword() {
  openSheet("Change password", null, (body, close) => body.append(passwordForm(() => {
    body.replaceChildren(h("p", { class: "msg ok" }, "Password changed."));
    setTimeout(close, 1200);
  }, "Change password")));
}

// ------------------------------------------------------------------ coach: roster
async function renderRoster() {
  const reportsBtn = h("button", { class: "pill-btn", onclick: () => openReports() },
    h("span", { class: "flag" }, "⚑"), "Player reports", h("span", { class: "count zero" }, "…"));
  const seg = h("div", { class: "seg" });
  const list = h("div", { class: "list" }, h("div", { class: "empty" }, "Loading roster…"));
  page("roster",
    h("div", { class: "row-between" },
      h("div", {}, h("p", { class: "eyebrow" }, "Coach view"), h("h1", {}, "Team roster")),
      reportsBtn),
    seg, list);

  refreshOpenCount(reportsBtn.querySelector(".count"));

  const { data, error } = await sb.from("roster").select("slug, display_name, side").eq("role", "player").eq("active", true).order("display_name");
  if (error) { list.replaceChildren(h("div", { class: "empty" }, error.message)); return; }
  const hitters = data.filter((p) => p.side === "hitter" || p.side === "two-way");
  const pitchers = data.filter((p) => p.side === "pitcher" || p.side === "two-way");

  const draw = () => {
    seg.replaceChildren(
      h("button", { class: state.rosterSide === "hitters" ? "on" : "", onclick: () => { state.rosterSide = "hitters"; draw(); } }, `Hitters (${hitters.length})`),
      h("button", { class: state.rosterSide === "pitchers" ? "on" : "", onclick: () => { state.rosterSide = "pitchers"; draw(); } }, `Pitchers (${pitchers.length})`));
    const people = state.rosterSide === "hitters" ? hitters : pitchers;
    list.replaceChildren(...(people.length ? people.map((p) =>
      h("button", { class: "person", onclick: () => { state.viewing = p; state.season = null; renderPlayerPage(p); } },
        h("div", {}, h("div", { class: "name" }, p.display_name), h("div", { class: "sub" }, p.side === "two-way" ? "Two-way" : "")),
        h("span", { class: "chev" }, "›"))) : [h("div", { class: "empty" }, "Nobody here yet.")]));
  };
  draw();
}

async function refreshOpenCount(el) {
  const { count } = await sb.from("reports").select("id", { count: "exact", head: true })
    .eq("status", "open").is("duplicate_of", null);
  el.textContent = `${count || 0} open`;
  el.className = "count" + (count ? "" : " zero");
}

// ------------------------------------------------------------------ player page (player sees his own; coach sees anyone)
async function renderPlayerPage(p) {
  const isCoach = state.me.role === "coach";
  const body = h("div", {}, h("div", { class: "empty" }, "Loading…"));
  page(isCoach ? "roster" : "me",
    isCoach ? h("button", { class: "back", onclick: () => { state.viewing = null; renderRoster(); } }, "‹ Roster") : null,
    h("div", { class: "row-between" },
      h("div", {}, h("p", { class: "eyebrow" }, isCoach ? "Player" : "My page"), h("h1", {}, p.display_name)),
      !isCoach ? h("button", { class: "pill-btn", onclick: () => openReports() }, h("span", { class: "flag" }, "⚑"), "Report a mistake") : null),
    body);

  const { data, error } = await sb.from("player_data").select("kind, season, data, updated_at").eq("slug", p.slug);
  if (error) { body.replaceChildren(h("div", { class: "empty" }, error.message)); return; }
  if (!data.length) {
    // 9 Nov 2026: a player with only bullpens (Tibbs) has no live numbers yet; say why instead of sounding broken
    const side = p.side || (!isCoach && state.me.side) || "";
    const msg = isCoach
      ? "No live numbers yet. Bullpens and BP don't count toward this page."
      : side === "hitter"
        ? "Your numbers show up after your first live at-bats (games or intrasquads)."
        : "Your numbers show up after your first live outing (games or intrasquads). Bullpens don't count toward this page.";
    body.replaceChildren(h("div", { class: "empty" }, msg));
  } else {
    // seasons, newest first: 2027 winter, then 2027 fall + winter (the pooled view), 2027 fall, 2026. Same
    // order rule as every hub site (seasons.py). Opens on the newest real season, never the pooled view.
    const seasons = [...new Set(data.map((r) => r.season))].sort((a, b) => seasonKey(b) - seasonKey(a));
    const real = seasons.filter((s) => !/ fall \+ winter$/.test(s));
    if (!state.season || !seasons.includes(state.season)) state.season = real[0] || seasons[0];
    const pick = h("select", { class: "season-pick", onchange: (e) => { state.season = e.target.value; draw(); } },
      seasons.map((s) => h("option", { value: s, selected: s === state.season }, s)));
    const holder = h("div");
    const draw = () => {
      const rows = data.filter((r) => r.season === state.season).sort((a, b) => a.kind.localeCompare(b.kind));
      holder.replaceChildren(...rows.map((r) => kindBlock(r)));
      const newest = rows.map((r) => r.updated_at).sort().pop();
      if (newest) holder.append(h("p", { class: "words" }, `Updated ${fmtWhen(newest)}`));
    };
    body.replaceChildren(seasons.length > 1 ? h("div", {}, h("label", {}, "Season"), pick) : h("p", { class: "eyebrow" }, seasons[0]), holder);
    draw();
  }

  if (!isCoach) {
    const mine = h("div", {}, h("div", { class: "empty" }, "Loading…"));
    body.append(h("h2", {}, "My reports"), mine);
    loadMyReports(mine);
  }
}

// "2026" (spring) < "2027 fall" < "2027 winter" < "2027 fall + winter" < "2027"
function seasonKey(s) {
  const y = parseInt(s, 10) || 0;
  return / fall \+ winter$/.test(s) ? (y - 1) * 4 + 3 : / winter$/.test(s) ? (y - 1) * 4 + 2 : / fall$/.test(s) ? (y - 1) * 4 + 1 : y * 4;
}

// Goals are off until the staff approves a real set (Sam, 9 Nov 2026). The hub still writes them; set true to show.
const SHOW_GOALS = false;

// One pitching or hitting bundle. Shape is written by the hub's players_app.py (see README).
function kindBlock(r) {
  const d = r.data || {};
  const out = [h("h2", {}, r.kind === "pitching" ? "Pitching" : "Hitting")];
  if (d.note) out.push(h("p", { class: "words" }, d.note));
  if (d.line && Object.keys(d.line).length) {
    out.push(h("div", { class: "card line" }, Object.entries(d.line).map(([k, v]) => h("div", {}, h("b", {}, v), h("span", {}, k)))));
  }
  if (Array.isArray(d.metrics) && d.metrics.length) {
    out.push(h("div", { class: "card", style: "margin-top:10px" }, d.metrics.map((m) =>
      h("div", { class: "metric" },
        h("div", { class: "metric-top" }, h("span", {}, m.label), h("b", {}, m.value)),
        m.pct != null ? h("div", { class: "bar" }, h("i", { style: `width:${Math.max(3, Math.min(100, Number(m.pct)))}%` })) : null,
        m.words ? h("div", { class: "words" }, m.words) : null))));
  }
  if (SHOW_GOALS && Array.isArray(d.goals) && d.goals.length) {
    out.push(h("h2", {}, "Goals"), h("div", { class: "card" }, d.goals.map((g) =>
      h("div", { class: "goal" },
        h("span", {}, g.label, g.target ? h("span", { class: "words" }, ` · goal ${g.target}`) : null),
        h("span", { class: g.met ? "met" : "missed" }, `${g.value ?? "–"} ${g.met ? "✓" : ""}`)))));
  }
  if (Array.isArray(d.links) && d.links.length) {
    // in-app links open that site's tab on this player; shown only for sites this login can see
    // (coaches: all; players: the ones marked players = true). Plain urls open in a new tab.
    const links = d.links.filter((l) => l.url || (l.site && state.sites.some((s) => s.key === l.site)));
    if (links.length) out.push(h("h2", {}, "Go deeper"), h("div", { class: "links" }, links.map((l) =>
      l.site ? h("a", { href: `#site=${l.site}${l.anchor ? "&a=" + encodeURIComponent(l.anchor) : ""}` }, l.label)
             : h("a", { href: l.url, target: "_blank", rel: "noopener" }, l.label))));
  }
  return h("section", {}, out);
}

// ------------------------------------------------------------------ guide (9 Nov 2026)
// A short walkthrough that opens by itself the first time someone signs in, and from "Guide" in the top bar any time.
// "Seen" is kept on the account (user_metadata.guide_v1), so it doesn't come back on his phone after he saw it on a
// laptop; browser storage is a backup. Bump GUIDE_V to show a changed guide to everyone once.
const GUIDE_V = "guide_v1";
function guideSeen() {
  if (state.user && state.user.user_metadata && state.user.user_metadata[GUIDE_V]) return true;
  try { return localStorage.getItem("ue." + GUIDE_V) === "1"; } catch { return false; }
}
function markGuideSeen() {
  try { localStorage.setItem("ue." + GUIDE_V, "1"); } catch { /* private window */ }
  if (state.user && !(state.user.user_metadata || {})[GUIDE_V]) {
    sb.auth.updateUser({ data: { [GUIDE_V]: true } }).then(({ data }) => { if (data && data.user) state.user = data.user; }).catch(() => {});
  }
}
function maybeShowGuide() { if (state.me && !guideSeen()) setTimeout(() => openGuide(), 300); }

function guideSteps() {
  const me = state.me, first = (me.display_name || "").split(" ")[0];
  const has = (k) => state.sites.some((s) => s.key === k);
  if (me.role === "coach") return [
    { t: `Welcome, ${first}`, b: ["UE Analytics puts every hub site in one app, behind one sign-in.",
      "Players see their own page, the full Pitching Lab and Hitting Lab (without your notes), and pitchers see Early + Ahead. Coaches see everything."] },
    { t: "Roster", b: ["Roster lists every player. Tap a name to see exactly what he sees on his page: his season line and where he ranks on the team.",
      "The pitchers / hitters switch at the top changes the list."] },
    { t: "The sites", b: ["The tabs across the top are the hub sites: Savant, the Labs, Blueprint, Early + Ahead and the rest.",
      "They update by themselves after each hub run, and the claude.ai links still work as a backup."] },
    { t: "Player reports", b: ["When a player says a number looks wrong, it lands under the ⚑ on the Roster, with a count.",
      "Open it to mark Fixed, No change or I'll handle it, and leave a reply. He sees your answer on his page."] },
    homeScreenStep(),
  ];
  const pitcher = me.side === "pitcher" || me.side === "two-way";
  const hitter = me.side === "hitter" || me.side === "two-way";
  const who = pitcher && hitter ? "UE players" : pitcher ? "UE pitchers" : "UE hitters";
  const labs = [has("lab") ? "Pitching Lab" : null, has("hitting") ? "Hitting Lab" : null].filter(Boolean);
  return [
    { t: `Welcome, ${first}`, b: ["This is UE Analytics: your numbers from every TrackMan session, plus the same Labs the coaches use.",
      "Your page is private. Only you and the coaches can see it."] },
    { t: "My page", b: ["Pick a season at the top. Your stat line comes first, then your key numbers, each with a line on what it means.",
      `The purple bar shows where you rank among ${who} that season. Further right is better.`,
      "If you see a small-sample note, it's early. Don't read too much into it yet."] },
    labs.length ? { t: labs.length > 1 ? "The Labs" : `The ${labs[0]}`, b: [
      `The tabs across the top open the ${labs.join(" and the ")}: every ${labs.length > 1 ? "pitcher and hitter" : has("lab") ? "pitcher" : "hitter"} on the team.`,
      "Use the season and session buttons at the top of a Lab to filter. Tap a name to open his card.",
      ...(pitcher && has("aar") ? ["Early + Ahead shows how the staff attacks early in the count and when ahead."] : [])] } : null,
    { t: "Something look wrong?", b: ["If a pitch is tagged wrong or a session is missing, tap ⚑ Report a mistake on My page.",
      "Say what it shows and what it should be. A coach will answer, and you'll see it under My reports."] },
    homeScreenStep(),
  ].filter(Boolean);
}
function homeScreenStep() {
  return { t: "Keep it on your phone", b: ["In Safari, tap Share, then Add to Home Screen. It opens like an app and you stay signed in.",
    "If you ever get signed out, type your UE email and tap Email me a code.",
    "Tap Guide at the top any time to see this again."] };
}
function openGuide() {
  const steps = guideSteps();
  let i = 0;
  const { body, close } = openSheet("How UE Analytics works", null, () => {}, markGuideSeen);
  const flag = body.parentElement && body.parentElement.querySelector(".sheet-head .flag");
  if (flag) flag.remove();
  const draw = () => {
    const st = steps[i];
    body.replaceChildren(h("div", { class: "guide" },
      h("p", { class: "eyebrow" }, `${i + 1} of ${steps.length}`),
      h("h2", {}, st.t),
      ...st.b.map((x) => h("p", {}, x)),
      h("div", { class: "guide-dots" }, steps.map((_, j) => h("i", { class: j === i ? "on" : "" }))),
      h("div", { class: "btn-row guide-nav" },
        i > 0 ? h("button", { class: "btn", onclick: () => { i--; draw(); } }, "Back") : h("span"),
        i < steps.length - 1
          ? h("button", { class: "btn primary", onclick: () => { i++; draw(); } }, "Next")
          : h("button", { class: "btn primary", onclick: close }, "Got it"))));
  };
  draw();
}

// ------------------------------------------------------------------ saved target shapes (Pitch Design, 12 Nov 2026)
// Pitch Design runs walled off from the app, so it cannot reach the database. It asks the app instead:
//   {ue:"targets", op:"list"|"save"|"delete", id, arm, pitch, shape, note}
// and the app answers {ue:"targets", id, ok, rows, me:{role, pitcher}}. Rows live in public.pitch_targets, one per
// pitcher + pitch. The database decides who may read and write (a player: his own; a coach: anyone's); the check
// here only gives a clearer message. `arm` is the TrackMan name ("Last, First"); the roster slug is that name in
// lower case with dashes ("vander-luitgaren-conner"), checked against all 18 arms on 12 Nov.
const armSlug = (arm) => String(arm || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const armName = (display) => { const p = String(display || "").trim().split(/\s+/); return p.length > 1 ? p.slice(1).join(" ") + ", " + p[0] : (p[0] || null); };
async function targetsBridge(d, win) {
  const me = state.me;
  if (!me || !win) return;
  const isCoach = me.role === "coach";
  const who = { role: me.role, pitcher: isCoach ? null : armName(me.display_name) };
  const reply = (x) => { try { win.postMessage({ ue: "targets", id: d.id, me: who, ...x }, "*"); } catch { /* frame gone */ } };
  const rows = async () => {
    const { data, error } = await sb.from("pitch_targets").select("arm, pitch, shape, note, updated_at").order("updated_at", { ascending: false });
    if (error) throw error;
    return data || [];
  };
  try {
    if (d.op === "list") {
      let got;
      try { got = await rows(); } catch { return; }   // no table yet, or offline: stay silent so the page says saving isn't on
      return reply({ ok: true, rows: got });
    }
    if (d.op !== "save" && d.op !== "delete") return reply({ ok: false, error: "Unknown request." });
    const slug = armSlug(d.arm), pitch = String(d.pitch || "").slice(0, 40);
    if (!slug || !pitch) return reply({ ok: false, error: "Pick a pitcher and a pitch first." });
    if (!isCoach && slug !== me.slug) return reply({ ok: false, error: "You can save targets for your own pitches only." });
    if (d.op === "save") {
      let shape = d.shape;
      if (typeof shape === "string") { try { shape = JSON.parse(shape); } catch { shape = null; } }
      if (!shape || typeof shape !== "object" || JSON.stringify(shape).length > 6000) return reply({ ok: false, error: "That shape could not be saved." });
      const { error } = await sb.from("pitch_targets").upsert(
        { slug, arm: String(d.arm).slice(0, 80), pitch, shape, note: String(d.note || "").slice(0, 500), updated_at: new Date().toISOString() },
        { onConflict: "slug,pitch" });
      if (error) throw error;
    } else {
      const { error } = await sb.from("pitch_targets").delete().eq("slug", slug).eq("pitch", pitch);
      if (error) throw error;
    }
    reply({ ok: true, rows: await rows() });
  } catch (err) {
    reply({ ok: false, error: (err && err.message) || "Could not reach the database." });
  }
}

// ------------------------------------------------------------------ news (12 Nov 2026)
// Announcements from the staff ("Pitch Design is now in the app"). Rows live in public.announcements; the database
// decides who may read each one (everyone / pitchers / hitters / coaches), so this just shows what comes back.
// A new one opens by itself once, then stays under "News" in the top bar. "Seen" is the highest id he has seen, kept
// on the account (user_metadata.news_seen) so it doesn't pop up again on another device; browser storage is a backup.
const NEWS_POPUP_DAYS = 21;   // older than this never pops up; it is still in the list
async function loadNews() {
  try {
    const { data, error } = await sb.from("announcements").select("id, title, body, audience, site, published_at")
      .order("published_at", { ascending: false }).limit(20);
    state.news = error ? [] : (data || []);
  } catch { state.news = []; }   // table not there yet, or offline: the app works without it
}
function newsSeenId() {
  let a = 0, b = 0;
  try { a = +((state.user && state.user.user_metadata) || {}).news_seen || 0; } catch { /* no account data */ }
  try { b = +localStorage.getItem("ue.news_seen") || 0; } catch { /* private window */ }
  return Math.max(a, b);
}
function unseenNews() { const seen = newsSeenId(); return state.news.filter((n) => n.id > seen); }
function markNewsSeen() {
  const top = Math.max(0, ...state.news.map((n) => n.id));
  if (top <= newsSeenId()) return;
  try { localStorage.setItem("ue.news_seen", String(top)); } catch { /* private window */ }
  if (state.user) sb.auth.updateUser({ data: { news_seen: top } }).then(({ data }) => { if (data && data.user) state.user = data.user; }).catch(() => {});
  document.querySelectorAll(".news-btn.has-new").forEach((b) => b.classList.remove("has-new"));
}
function maybeShowNews() {
  if (!state.me || !guideSeen()) return;            // first sign-in: the guide comes first; News keeps its dot
  const cut = Date.now() - NEWS_POPUP_DAYS * 864e5;
  if (!unseenNews().some((n) => new Date(n.published_at).getTime() >= cut)) return;
  setTimeout(() => { if (!modalRoot.childElementCount) openNews(); }, 400);
}
function openNews() {
  const seen = newsSeenId();
  const { body, close } = openSheet("What's new", null, () => {}, markNewsSeen);
  const flag = body.parentElement && body.parentElement.querySelector(".sheet-head .flag");
  if (flag) flag.remove();
  const FOR = { pitchers: "Pitchers", hitters: "Hitters", coaches: "Coaches" };
  body.replaceChildren(h("div", { class: "news" },
    state.news.length ? state.news.map((n) => {
      const site = n.site && state.sites.find((s) => s.key === n.site);
      return h("article", { class: "news-item" + (n.id > seen ? " new" : "") },
        h("p", { class: "eyebrow" }, n.id > seen ? h("b", { class: "news-tag" }, "New") : null,
          fmtDate(String(n.published_at).slice(0, 10)), FOR[n.audience] ? " · " + FOR[n.audience] : ""),
        h("h2", {}, n.title),
        ...String(n.body || "").split(/\n+/).filter(Boolean).map((x) => h("p", {}, x)),
        site ? h("div", { class: "btn-row" }, h("button", { class: "btn primary", onclick: () => { close(); openSite(site.key); } }, "Open " + site.title)) : null);
    }) : h("p", {}, "Nothing new yet."),
    h("div", { class: "btn-row guide-nav" }, h("span"), h("button", { class: "btn primary", onclick: close }, "Got it"))));
}

// ------------------------------------------------------------------ reports
function openSheet(title, tabs, fill, onClose) {
  const close = () => { modalRoot.replaceChildren(); document.removeEventListener("keydown", esc); if (onClose) onClose(); };
  const esc = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", esc);
  const body = h("div");
  const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "sheet-head" }, h("span", { class: "flag" }, "⚑"), h("h3", {}, title),
      h("button", { class: "x", "aria-label": "Close", onclick: close }, "×")),
    tabs, body);
  modalRoot.replaceChildren(h("div", { class: "scrim", onclick: (e) => { if (e.target === e.currentTarget) close(); } }, sheet));
  fill(body, close);
  return { body, close };
}

function openReports() {
  const isCoach = state.me.role === "coach";
  let tab = isCoach ? "inbox" : "new";
  const tabs = h("div", { class: "sheet-tabs" });
  // refresh the page underneath when the sheet closes (open count, My reports)
  const onClose = () => { if (isCoach && !state.viewing) renderRoster(); else if (!isCoach) renderPlayerPage({ slug: state.me.slug, display_name: state.me.display_name }); };
  const { body, close } = openSheet(isCoach ? "Player reports" : "Report a mistake", tabs, () => {}, onClose);
  const drawTabs = (inboxCount) => {
    tabs.replaceChildren(
      ...(isCoach ? [h("button", { class: tab === "inbox" ? "on" : "", onclick: () => { tab = "inbox"; draw(); } },
        "Inbox", inboxCount != null ? h("span", { class: "count" + (inboxCount ? "" : " zero") }, inboxCount) : null)] : []),
      h("button", { class: tab === "new" ? "on" : "", onclick: () => { tab = "new"; draw(); } }, "New report"));
  };
  const draw = () => {
    drawTabs();
    if (tab === "new") newReportForm(body, () => { if (isCoach) { tab = "inbox"; draw(); } else close(); });
    else coachInbox(body, drawTabs);
  };
  draw();
}

async function newReportForm(body, done) {
  const isCoach = state.me.role === "coach";
  let who = null;
  if (isCoach) {
    const { data } = await sb.from("roster").select("slug, display_name").eq("role", "player").eq("active", true).order("display_name");
    who = h("select", { required: true }, h("option", { value: "" }, "Pick a player"),
      (data || []).map((p) => h("option", { value: p.slug, selected: state.viewing && state.viewing.slug === p.slug }, p.display_name)));
  }
  const cat = h("select", {}, CATEGORIES.map((c) => h("option", {}, c)));
  const area = h("select", {}, AREAS.map((a) => h("option", {}, a)));
  const date = h("input", { type: "date", max: new Date().toISOString().slice(0, 10) });
  const wrong = h("input", { placeholder: "e.g. Pick off attempt" });
  const right = h("input", { placeholder: "e.g. Stolen base" });
  const details = h("textarea", { placeholder: "Who was pitching or hitting, the inning, anything that helps find it." });
  const msg = h("div", { class: "msg" });
  const go = h("button", { class: "btn primary", type: "submit" }, "Send report");
  body.replaceChildren(h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      if (!wrong.value.trim() && !details.value.trim()) { msg.className = "msg err"; msg.textContent = "Tell us what's wrong."; return; }
      go.disabled = true;
      const row = {
        slug: isCoach ? who.value : state.me.slug,
        category: cat.value, area: area.value,
        game_date: date.value || null,
        wrong_value: wrong.value.trim() || null, right_value: right.value.trim() || null,
        details: details.value.trim() || null,
      };
      const { error } = await sb.from("reports").insert(row);
      go.disabled = false;
      if (error) { msg.className = "msg err"; msg.textContent = error.message; return; }
      body.replaceChildren(h("p", { class: "msg ok" }, "Got it. It gets checked against the data and video, and you'll see the answer under My reports."));
      setTimeout(done, 1600);
    },
  },
    isCoach ? [h("label", {}, "Player"), who] : null,
    h("div", { class: "two" }, h("div", {}, h("label", {}, "What's wrong"), cat), h("div", {}, h("label", {}, "Area"), area)),
    h("label", {}, "Game date"), date,
    h("div", { class: "two" }, h("div", {}, h("label", {}, "The site says"), wrong), h("div", {}, h("label", {}, "It should be"), right)),
    h("label", {}, "Details"), details,
    h("div", { class: "btn-row" }, go), msg));
}

function reportSummary(r) {
  return [
    h("div", { class: "cat" }, `${r.category} · ${r.area}${r.game_date ? " · " + fmtDate(r.game_date) : ""}`),
    (r.wrong_value || r.right_value)
      ? h("div", { class: "change" }, r.wrong_value ? h("s", {}, r.wrong_value) : null, r.wrong_value && r.right_value ? " → " : "", r.right_value || "")
      : null,
    r.details ? h("div", {}, r.details) : null,
  ];
}

async function loadMyReports(el) {
  const { data, error } = await sb.from("reports").select("*").eq("slug", state.me.slug).is("duplicate_of", null).order("created_at", { ascending: false }).limit(50);
  if (error) { el.replaceChildren(h("div", { class: "empty" }, error.message)); return; }
  if (!data.length) { el.replaceChildren(h("div", { class: "empty" }, "No reports. If something on your page looks wrong, hit Report a mistake.")); return; }
  el.replaceChildren(...data.map((r) => h("div", { class: "report card" },
    h("div", { class: "report-top" }, h("span", { class: "when" }, fmtWhen(r.created_at)),
      h("span", { class: "badge " + (r.status === "open" ? "new" : r.outcome || "") }, r.status === "open" ? "Being checked" : OUTCOME_LABEL[r.outcome] || "Closed")),
    reportSummary(r),
    r.coach_note ? h("div", { class: "reply" }, h("b", {}, "Reply: "), r.coach_note) : null)));
}

async function coachInbox(body, drawTabs) {
  let filter = "open";
  const filters = h("div", { class: "filters" });
  const list = h("div", {}, h("div", { class: "empty" }, "Loading…"));
  body.replaceChildren(filters, list);

  const { data, error } = await sb.from("reports").select("*, roster(display_name)").order("created_at", { ascending: false }).limit(300);
  if (error) { list.replaceChildren(h("div", { class: "empty" }, error.message)); return; }
  const dupes = {};
  for (const r of data) if (r.duplicate_of) dupes[r.duplicate_of] = (dupes[r.duplicate_of] || 0) + 1;
  const main = data.filter((r) => !r.duplicate_of);
  const openCount = () => main.filter((r) => r.status === "open").length;

  const draw = () => {
    drawTabs(openCount());
    filters.replaceChildren(...["open", "closed", "all"].map((f) =>
      h("button", { class: filter === f ? "on" : "", onclick: () => { filter = f; draw(); } }, f[0].toUpperCase() + f.slice(1))));
    const shown = main.filter((r) => filter === "all" || r.status === filter);
    list.replaceChildren(...(shown.length ? shown.map(card) : [h("div", { class: "empty" }, filter === "open" ? "Nothing open. Inbox zero." : "Nothing here.")]));
  };

  const card = (r) => {
    const note = h("textarea", { placeholder: `Note to ${(r.roster?.display_name || "player").split(" ")[0]} (optional)` }, r.coach_note || "");
    const msg = h("div", { class: "msg" });
    const act = async (outcome) => {
      const patch = { outcome, coach_note: note.value.trim() || null, resolved_by: state.user.id, resolved_at: new Date().toISOString() };
      if (outcome !== "coach") patch.status = "closed";
      const { error } = await sb.from("reports").update(patch).eq("id", r.id);
      if (error) { msg.className = "msg err"; msg.textContent = error.message; return; }
      Object.assign(r, patch); draw();
    };
    const badge = r.status === "open"
      ? h("span", { class: "badge " + (r.outcome === "coach" ? "coach" : "new") }, r.outcome === "coach" ? "Yours" : "New")
      : h("span", { class: "badge " + (r.outcome || "") }, OUTCOME_LABEL[r.outcome] || "Closed");
    return h("div", { class: "report" },
      h("div", { class: "report-top" }, h("b", {}, r.roster?.display_name || r.slug), h("span", { class: "when" }, fmtWhen(r.created_at)), badge),
      reportSummary(r),
      dupes[r.id] ? h("div", { class: "dupes" }, `Sent ${dupes[r.id] + 1} times, shown once.`) : null,
      r.check_note ? h("div", { class: "check" }, h("b", {}, "Morning check: "), r.check_note) : null,
      r.status === "open"
        ? [note,
           h("div", { class: "btn-row" },
             h("button", { class: "btn good", onclick: () => act("fixed") }, "Fixed"),
             h("button", { class: "btn", onclick: () => act("no_change") }, "No change"),
             r.outcome !== "coach" ? h("button", { class: "btn", onclick: () => act("coach") }, "I'll handle it") : null,
             h("button", {
               class: "btn danger", style: "margin-left:auto", onclick: async () => {
                 if (!confirm("Delete this report for good?")) return;
                 const { error } = await sb.from("reports").delete().eq("id", r.id);
                 if (error) { msg.className = "msg err"; msg.textContent = error.message; return; }
                 main.splice(main.indexOf(r), 1); draw();
               },
             }, "Delete")),
           msg]
        : r.coach_note ? h("div", { class: "reply" }, h("b", {}, "Note sent: "), r.coach_note) : null);
  };
  draw();
}

// ------------------------------------------------------------------ go
sb.auth.getSession().then(({ data }) => route(data.session));
