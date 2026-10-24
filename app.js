/* Agenda 2027 — Gratzob
   Pages fidèles au PDF, synchronisées avec Google Agenda (dans les deux sens).
   Missions / notes / niveau du jour et photos : dans Google Drive (dossier « Agenda 2027 »). */
(function () {
"use strict";
const CFG = window.AGENDA_CONFIG || {};
const DATA = window.AGENDA_DATA;
const YEAR = 2027;
const MOIS = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
const JOURS = ["Dimanche","Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi"];
const JL = ["D","L","M","M","J","V","S"];
const PHOTO_DAYS = {35:"full",45:"half",166:"full",214:"full",215:"full",222:"full",240:"full",344:"full"};
const SCOPES = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.file";
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad = n => String(n).padStart(2, "0");
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};

/* ---------------- dates ---------------- */
const DIM = [31,28,31,30,31,30,31,31,30,31,30,31];
const dayOfYear = (m, d) => DIM.slice(0, m - 1).reduce((a, b) => a + b, 0) + d;
function fromN(n) { let m = 1, d = n; while (d > DIM[m - 1]) { d -= DIM[m - 1]; m++; } return { m, d }; }
const keyOf = (m, d) => `${YEAR}-${pad(m)}-${pad(d)}`;
const dow = (m, d) => new Date(Date.UTC(YEAR, m - 1, d)).getUTCDay();
function isoWeek(m, d) {
  const t = new Date(Date.UTC(YEAR, m - 1, d)); const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 864e5 + 1) / 7);
}
const info = n => { const r = DATA.days[n - 1]; return { fete: r[0], pen: r[1], q: r[2], a: r[3], ic: r[4], bands: r[5] }; };
const garde = n => { const b = info(n).bands.find(x => x[1] === "mere" || x[1] === "enfants"); return b ? b[1] : ""; };
const ferie = n => info(n).bands.some(x => x[1] === "ferie");
function numColor(n, m, d) { const w = dow(m, d); if (w === 0 || ferie(n)) return "c-sun"; if (w === 6) return "c-sat"; return "c-wd"; }

/* ---------------- ordre des pages ---------------- */
const ORDER = ["couverture", "annee"];
for (let m = 1; m <= 12; m++) { ORDER.push("mois-" + pad(m)); for (let d = 1; d <= DIM[m - 1]; d++) ORDER.push(keyOf(m, d)); }
ORDER.push("fin", "dos");
let current = null;
function defaultPage() { const t = new Date(); return t.getFullYear() === YEAR ? keyOf(t.getMonth() + 1, t.getDate()) : "annee"; }
function go(id) { if (!ORDER.includes(id)) id = defaultPage(); if (location.hash !== "#" + id) location.hash = id; else render(); }
const monthOfPage = id => /^mois-(\d\d)$/.test(id) ? +id.slice(5) : (/^\d{4}-/.test(id) ? +id.slice(5, 7) : 0);

/* ---------------- données locales + Drive ---------------- */
const Store = {
  data: ls.get("agenda2027.data", { v: 1, days: {} }),
  get(k) { return this.data.days[k] || { m: [], n: "", s: 0, u: 0 }; },
  set(k, patch) {
    const r = Object.assign({ m: [], n: "", s: 0 }, this.data.days[k], patch, { u: Date.now() });
    this.data.days[k] = r; ls.set("agenda2027.data", this.data); Drive.scheduleSave();
  },
  merge(remote) {
    let changed = false, localNewer = false;
    const all = new Set([...Object.keys(remote.days || {}), ...Object.keys(this.data.days)]);
    for (const k of all) {
      const a = this.data.days[k], b = (remote.days || {})[k];
      if (b && (!a || (b.u || 0) > (a.u || 0))) { this.data.days[k] = b; changed = true; }
      else if (a && (!b || (a.u || 0) > (b.u || 0))) localNewer = true;
    }
    if (changed) ls.set("agenda2027.data", this.data);
    return { changed, localNewer };
  }
};

/* ---------------- Google : connexion ---------------- */
const G = { token: null, exp: 0, client: null, cid: "", busy: false };
(function restoreToken() {
  try { const t = JSON.parse(sessionStorage.getItem("agenda2027.tok") || "null"); if (t && t.exp > Date.now()) { G.token = t.token; G.exp = t.exp; } } catch {}
})();
const connected = () => !!G.token && G.exp > Date.now();
function clientId() { return (CFG.CLIENT_ID || ls.get("agenda2027.cid", "") || "").trim(); }
function initClient() {
  G.cid = clientId();
  if (!G.cid || !window.google?.accounts?.oauth2) return false;
  if (G.client && G.client._cid === G.cid) return true;
  G.client = google.accounts.oauth2.initTokenClient({
    client_id: G.cid, scope: SCOPES, login_hint: CFG.EMAIL || undefined,
    callback: onToken,
    error_callback: e => { G.busy = false; status(); if (e?.type !== "popup_closed") toast("Connexion Google interrompue (" + (e?.type || "erreur") + ")."); }
  });
  G.client._cid = G.cid; return true;
}
function connect() {
  if (!clientId()) { openCfg(); return; }
  if (!initClient()) { toast("Le service Google se charge… réessaie dans une seconde."); return; }
  G.busy = true; status();
  G.client.requestAccessToken({ prompt: ls.get("agenda2027.consent", false) ? "" : "consent" });
}
function onToken(resp) {
  G.busy = false;
  if (resp.error) { status(); toast("Google a refusé la connexion : " + resp.error); return; }
  if (!google.accounts.oauth2.hasGrantedAllScopes(resp, ...SCOPES.split(" "))) {
    toast("Il faut autoriser l'agenda ET Google Drive pour que l'appli fonctionne.");
  }
  G.token = resp.access_token; G.exp = Date.now() + (Number(resp.expires_in || 3600) - 90) * 1000;
  try { sessionStorage.setItem("agenda2027.tok", JSON.stringify({ token: G.token, exp: G.exp })); } catch {}
  ls.set("agenda2027.consent", true);
  afterConnect();
}
function expired() {
  G.token = null; G.exp = 0; try { sessionStorage.removeItem("agenda2027.tok"); } catch {}
  status();
}
async function api(url, opt = {}) {
  if (!connected()) { expired(); throw new Error("not_connected"); }
  const res = await fetch(url, Object.assign({}, opt, { headers: Object.assign({ Authorization: "Bearer " + G.token }, opt.headers || {}) }));
  if (res.status === 401) { expired(); toast("La session Google a expiré : clique sur « Reconnecter »."); throw new Error("expired"); }
  if (!res.ok) { let m = res.status + ""; try { m = (await res.json()).error?.message || m; } catch {} throw new Error(m); }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.blob();
}
async function afterConnect() {
  status("Synchronisation…");
  try {
    await Drive.init();
    await Promise.all([Drive.pull(), Cal.load(monthOfPage(current) || 1, true)]);
    Photos.load();
    render();
    status();
  } catch (e) { console.error(e); status(); if (e.message !== "expired") toast("Erreur Google : " + e.message); }
}

/* ---------------- Google Drive ---------------- */
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const Drive = {
  folder: null, files: [], dataId: null, saveT: null, saving: false,
  async init() {
    if (this.folder) return;
    const name = CFG.DRIVE_FOLDER || "Agenda 2027";
    const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const r = await api(`${DRIVE}?q=${q}&fields=files(id,name)&spaces=drive`);
    if (r.files.length) this.folder = r.files[0].id;
    else this.folder = (await api(DRIVE + "?fields=id", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }) })).id;
    await this.list();
  },
  async list() {
    const q = encodeURIComponent(`'${this.folder}' in parents and trashed=false`);
    const r = await api(`${DRIVE}?q=${q}&fields=files(id,name,modifiedTime,mimeType)&pageSize=200`);
    this.files = r.files || [];
    const f = this.files.find(x => x.name === (CFG.DATA_FILE || "agenda-2027-donnees.json"));
    this.dataId = f ? f.id : null;
    return this.files;
  },
  async upload(name, blob, mime, existingId) {
    if (existingId) return api(`${UPLOAD}/${existingId}?uploadType=media&fields=id,name,modifiedTime`, { method: "PATCH", headers: { "Content-Type": mime }, body: blob });
    const b = "agenda" + Math.random().toString(36).slice(2);
    const meta = { name, parents: [this.folder], mimeType: mime };
    const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`, blob, `\r\n--${b}--`]);
    return api(`${UPLOAD}?uploadType=multipart&fields=id,name,modifiedTime`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${b}` }, body });
  },
  async pull() {
    if (!this.folder) return;
    await this.list();
    if (!this.dataId) { if (Object.keys(Store.data.days).length) await this.save(); return; }
    const remote = await api(`${DRIVE}/${this.dataId}?alt=media`);
    const obj = remote instanceof Blob ? JSON.parse(await remote.text()) : remote;
    const { changed, localNewer } = Store.merge(obj || {});
    if (localNewer) await this.save();
    if (changed && !editing()) render();
  },
  scheduleSave() {
    clearTimeout(this.saveT);
    if (!connected() || !this.folder) { status(); return; }
    status("Enregistrement…");
    this.saveT = setTimeout(() => this.save().catch(e => { console.error(e); status(); }), 1200);
  },
  async save() {
    if (!this.folder) return;
    const blob = new Blob([JSON.stringify(Store.data)], { type: "application/json" });
    const r = await this.upload(CFG.DATA_FILE || "agenda-2027-donnees.json", blob, "application/json", this.dataId);
    this.dataId = r.id; status();
  }
};

/* ---------------- Photos (dans Drive) ---------------- */
const PHOTO_NAMES = ["couverture", ...MOIS.map((_, i) => "mois-" + pad(i + 1)), ...Object.keys(PHOTO_DAYS).map(n => "jour-" + String(n).padStart(3, "0")), "dos"];
const Photos = {
  urls: {}, loading: false,
  async load() {
    if (!Drive.folder || this.loading) return; this.loading = true;
    try {
      let cache = null; try { cache = await caches.open("agenda2027-photos"); } catch {}
      const imgs = Drive.files.filter(f => /^image\//.test(f.mimeType));
      await Promise.all(imgs.map(async f => {
        const key = f.name.replace(/\.[^.]+$/, "").toLowerCase();
        if (!PHOTO_NAMES.includes(key)) return;
        const ck = `https://agenda.local/photo/${f.id}/${encodeURIComponent(f.modifiedTime)}`;
        let blob = null;
        if (cache) { const hit = await cache.match(ck); if (hit) blob = await hit.blob(); }
        if (!blob) { blob = await api(`${DRIVE}/${f.id}?alt=media`); if (cache) { try { await cache.put(ck, new Response(blob)); } catch {} } }
        if (this.urls[key]) URL.revokeObjectURL(this.urls[key]);
        this.urls[key] = URL.createObjectURL(blob);
        this.apply();
      }));
    } catch (e) { console.error(e); }
    this.loading = false; this.apply(); phList();
  },
  apply(root = document) {
    root.querySelectorAll("[data-photo]").forEach(el => {
      const u = this.urls[el.dataset.photo];
      if (u) { el.style.backgroundImage = `url("${u}")`; el.classList.add("loaded"); }
    });
  },
  async importFiles(files) {
    if (!connected()) { toast("Connecte-toi d'abord à Google."); return; }
    await Drive.init(); await Drive.list();
    let ok = 0, skip = [];
    for (const f of files) {
      const key = f.name.replace(/\.[^.]+$/, "").toLowerCase();
      if (!PHOTO_NAMES.includes(key)) { skip.push(f.name); continue; }
      toast(`Envoi de ${f.name}… (${ok + 1}/${files.length})`, 0);
      const ex = Drive.files.find(x => x.name.replace(/\.[^.]+$/, "").toLowerCase() === key);
      await Drive.upload(f.name, f, f.type || "image/jpeg", ex && ex.id);
      ok++;
    }
    await Drive.list(); await this.load();
    toast(`${ok} photo(s) enregistrée(s) dans ton Drive.` + (skip.length ? ` Ignorée(s) : ${skip.join(", ")}` : ""));
  },
  async replaceSlot(key, file) {
    const ext = (file.name.match(/\.[^.]+$/) || [".jpg"])[0].toLowerCase();
    const f = new File([file], key + ext, { type: file.type || "image/jpeg" });
    await this.importFiles([f]);
  }
};
function photoEl(key, cls, style, label) {
  return `<div class="ph ${cls || ""}" data-photo="${key}" data-label="${esc(label || "Photo")}" style="${style || ""}"><button class="chg" data-slot="${key}">Changer la photo</button></div>`;
}

/* ---------------- Google Agenda ---------------- */
const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const Cal = {
  months: {}, // m -> { at, events: [] }
  async load(m, force) {
    if (!m || !connected()) return false;
    const c = this.months[m];
    if (!force && c && Date.now() - c.at < 45000) return false;
    const tMin = new Date(YEAR, m - 1, 1).toISOString(), tMax = new Date(YEAR, m, 1).toISOString();
    let items = [], pageToken = "";
    do {
      const r = await api(`${CAL}?singleEvents=true&orderBy=startTime&maxResults=2500&timeMin=${encodeURIComponent(tMin)}&timeMax=${encodeURIComponent(tMax)}` + (pageToken ? "&pageToken=" + pageToken : ""));
      items = items.concat(r.items || []); pageToken = r.nextPageToken || "";
    } while (pageToken);
    const evs = items.filter(e => e.status !== "cancelled").map(norm);
    const sig = JSON.stringify(evs.map(e => [e.id, e.title, +e.start, +e.end, e.allDay, e.desc]));
    const changed = !c || c.sig !== sig;
    this.months[m] = { at: Date.now(), events: evs, sig };
    return changed;
  },
  forDay(m, d) {
    const c = this.months[m]; if (!c) return { allDay: [], timed: [] };
    const s = new Date(YEAR, m - 1, d), e = new Date(YEAR, m - 1, d + 1);
    const evs = c.events.filter(x => x.start < e && x.end > s);
    return { allDay: evs.filter(x => x.allDay), timed: evs.filter(x => !x.allDay).sort((a, b) => a.start - b.start) };
  },
  find(id) { for (const k in this.months) { const e = this.months[k].events.find(x => x.id === id); if (e) return e; } return null; },
  async save(ev, body) {
    if (ev) return api(`${CAL}/${encodeURIComponent(ev.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return api(CAL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  },
  async remove(ev) { return api(`${CAL}/${encodeURIComponent(ev.id)}`, { method: "DELETE" }); }
};
function norm(e) {
  const allDay = !!e.start.date;
  const start = allDay ? new Date(e.start.date + "T00:00:00") : new Date(e.start.dateTime);
  const end = allDay ? new Date(e.end.date + "T00:00:00") : new Date(e.end.dateTime);
  return { id: e.id, title: e.summary || "(Sans titre)", desc: e.description || "", allDay, start, end, link: e.htmlLink, recurring: !!e.recurringEventId };
}
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/* ---------------- rendu ---------------- */
function render() {
  const id = decodeURIComponent(location.hash.slice(1)) || defaultPage();
  if (!ORDER.includes(id)) { go(defaultPage()); return; }
  current = id;
  const page = $("#page");
  page.className = "page";
  if (id === "couverture") renderCover(page, "couverture", "Couverture");
  else if (id === "dos") renderCover(page, "dos", "Dos de l'agenda");
  else if (id === "fin") renderEnd(page);
  else if (id === "annee") renderYear(page);
  else if (id.startsWith("mois-")) renderMonth(page, +id.slice(5));
  else renderDay(page, +id.slice(5, 7), +id.slice(8, 10));
  Photos.apply(page);
  $("#jump").value = id.startsWith("mois-") || ["couverture", "annee", "fin", "dos"].includes(id) ? id : "mois-" + id.slice(5, 7);
  $("#datejump").value = /^\d{4}-/.test(id) ? id : "";
  fit();
  const m = monthOfPage(id);
  if (m && connected()) Cal.load(m).then(ch => { if (ch && current === id) refreshEvents(); }).catch(() => {});
}
function refreshEvents() {
  const id = current;
  if (/^\d{4}-/.test(id)) { const m = +id.slice(5, 7), d = +id.slice(8, 10); drawEvents(m, d); }
  else if (id.startsWith("mois-")) drawMonthEvents(+id.slice(5));
}

function renderCover(page, key, label) {
  page.classList.add("full-bleed");
  page.innerHTML = photoEl(key, "", "left:0;top:0;width:100%;height:100%", connected() ? label + " — importe la photo via « Photos »" : label + " — connecte-toi à Google pour afficher la photo");
}
function renderEnd(page) {
  page.classList.add("end");
  page.innerHTML = `<div class="endt">Mission accomplie</div><div class="ends">✦&nbsp; RENDEZ-VOUS EN 2028 &nbsp;✦</div>`;
}

function renderYear(page) {
  let h = `<div class="yhead"></div><div class="ybrand">GRATZOB</div><div class="yyear">2027</div><div class="ysub">✦ AGENDA · UNE PAGE PAR JOUR ✦</div>`;
  for (let m = 1; m <= 12; m++) {
    const col = (m - 1) % 4, row = Math.floor((m - 1) / 4);
    const x = 34.1 + col * 138.75, y = 301.9 + row * 178.5;
    h += `<div class="ycard" style="left:${x}pt;top:${y}pt" data-go="mois-${pad(m)}">${photoEl("mois-" + pad(m), "", "", MOIS[m - 1])}<div class="mt">${MOIS[m - 1]}</div>`;
    const cx = k => 25.4 + k * 14.7; // centre des colonnes jours
    h += `<div class="c w" style="left:11.8pt;top:89pt">S</div>` + JL.slice(1).concat("D").map((l, k) => `<div class="c h" style="left:${cx(k)}pt;top:89pt">${l}</div>`).join("");
    h += `<div class="vl"></div>`;
    let r = 0, lastW = -1;
    for (let d = 1; d <= DIM[m - 1]; d++) {
      const w = (dow(m, d) + 6) % 7; const n = dayOfYear(m, d);
      if (d > 1 && w === 0) r++;
      const top = 97.4 + r * 9.75;
      if (r !== lastW) { h += `<div class="c w" style="left:11.8pt;top:${top}pt">${isoWeek(m, d)}</div>`; lastW = r; }
      const g = garde(n);
      const prevG = d > 1 && w > 0 ? garde(n - 1) : "", nextG = d < DIM[m - 1] && w < 6 ? garde(n + 1) : "";
      const cls = [g, g && prevG !== g ? "rs" : "", g && nextG !== g ? "re" : "", !g && numColor(n, m, d) === "c-sun" ? "r" : ""].join(" ");
      h += `<div class="c ${cls}" style="left:${cx(w)}pt;top:${top}pt" data-go="${keyOf(m, d)}">${d}</div>`;
    }
    h += `</div>`;
  }
  page.innerHTML = h;
}

function renderMonth(page, m) {
  let h = `<div class="mframe">${photoEl("mois-" + pad(m), "", "", MOIS[m - 1])}<div class="in"></div></div>
    <div class="mname">${MOIS[m - 1]}</div><div class="myear">2027</div><div class="mlist">`;
  for (let d = 1; d <= DIM[m - 1]; d++) {
    const n = dayOfYear(m, d), w = dow(m, d), left = d <= 16;
    const x = left ? 10.5 : 270, y = 10.5 + ((left ? d : d - 16) - 1) * 18.38;
    const col = numColor(n, m, d);
    const showW = w === 1 || d === 1;
    h += `<div class="mrow ${garde(n)}" style="left:${x}pt;top:${y}pt;width:${left ? 248.25 : 247.5}pt" data-go="${keyOf(m, d)}">
      <span class="n ${col}">${d}</span><span class="l ${col}">${JL[w]}</span>${showW ? `<span class="s">S${isoWeek(m, d)}</span>` : ""}
      <span class="e" data-day="${d}"></span></div>`;
  }
  page.innerHTML = h + `</div>`;
  drawMonthEvents(m);
}
function drawMonthEvents(m) {
  document.querySelectorAll(".mrow .e[data-day]").forEach(el => {
    const d = +el.dataset.day, n = dayOfYear(m, d);
    const lab = info(n).bands.filter(b => b[1] === "ferie" || b[1] === "fete").map(b => b[0].replace(/^Jour férié · /, ""));
    const ev = Cal.forDay(m, d);
    const parts = ev.allDay.map(e => esc(e.title)).concat(ev.timed.map(e => `<i>${e.start.getDate() === d ? hm(e.start) : "…"}</i> ${esc(e.title)}`));
    el.innerHTML = (lab.length ? `<span class="lab">${esc(lab.join(" · "))}</span>` : "") + parts.join(" &nbsp;·&nbsp; ");
  });
}

function renderDay(page, m, d) {
  const n = dayOfYear(m, d), I = info(n), w = dow(m, d), k = keyOf(m, d), rec = Store.get(k);
  let h = `<div class="card"></div>`;
  h += `<div class="bignum" style="top:36pt">${d}${d === 1 ? "<sup>er</sup>" : ""}</div>`;
  h += `<div class="wday">${JOURS[w]}</div><div class="mline">${MOIS[m - 1].toUpperCase()} 2027</div>
    <div class="fete"><span class="st">✦</span>Fête du jour : <i>${esc(I.fete)}</i></div>
    <div class="semaine">SEMAINE ${isoWeek(m, d)} · JOUR ${n}/365</div>`;
  // mini calendrier
  h += `<div class="mini"><div class="t">CARTE · ${MOIS[m - 1].toUpperCase()}</div><div class="vl"></div>`;
  const cx = k2 => 30 + k2 * 17.9;
  h += `<div class="c w" style="left:12pt;top:12.5pt">S</div>` + ["L","M","M","J","V","S","D"].map((l, i) => `<div class="c h" style="left:${cx(i)}pt;top:12.5pt">${l}</div>`).join("");
  let r = 0, lastR = -1;
  for (let dd = 1; dd <= DIM[m - 1]; dd++) {
    const ww = (dow(m, dd) + 6) % 7; if (dd > 1 && ww === 0) r++;
    const top = 22.3 + r * 10.7, nn = dayOfYear(m, dd);
    if (r !== lastR) { h += `<div class="c w" style="left:12pt;top:${top}pt">${isoWeek(m, dd)}</div>`; lastR = r; }
    const red = numColor(nn, m, dd) === "c-sun" ? " r" : "";
    h += `<a class="c${dd === d ? " on" : red}" style="left:${cx(ww)}pt;top:${top}pt" data-go="${keyOf(m, dd)}">${dd}</a>`;
  }
  h += `</div>`;
  h += `<div class="sep" style="left:55.5pt;width:241.5pt"></div><div class="sep" style="left:315pt;width:241.5pt"></div><div class="sepstar">✦</div>`;
  h += `<div class="bands" id="bands"></div>`;
  // heures
  h += `<div class="hours" id="hours">`;
  for (let i = 0; i < 19; i++) {
    const top = i * 31.3, hh = (6 + i) % 24, ht = i === 18 ? 25.3 : 31.3;
    h += `<div class="hr ${i % 2 === 0 ? "sh" : ""} ${i % 4 === 0 ? "tg" : (i % 2 === 0 ? "tl" : "")}" style="top:${top}pt;height:${ht}pt" data-hour="${hh}">
      <span class="lb">${pad(hh)}h</span><span class="dl"></span></div>`;
  }
  h += `<div class="evl" id="evl"></div></div>`;
  // missions
  h += `<div class="box" style="top:190.1pt;height:270pt"><div class="hd"></div><div class="ti">Missions</div><div class="su">OBJECTIFS DU JOUR</div>`;
  for (let i = 0; i < 10; i++) {
    const y = 53.7 + i * 23.25, it = rec.m[i] || { t: "", d: false };
    h += `<div class="ln" style="top:${y}pt"></div><div class="mi ${it.d ? "done" : ""}" style="top:${y - 23.25}pt" data-i="${i}">
      <button class="ck" title="Fait / pas fait">${it.d ? "✓" : ""}</button><input value="${esc(it.t)}" maxlength="120" data-mission="${i}"></div>`;
  }
  h += `</div>`;
  const pm = PHOTO_DAYS[n];
  if (pm === "full") {
    h += `<div class="photoframe" style="top:471.8pt;height:260.2pt">${photoEl("jour-" + String(n).padStart(3, "0"), "", "", I.bands.map(b => b[0]).filter(t => !/Enfants|Vacances/.test(t))[0] || "Photo")}</div>`;
  } else if (pm === "half") {
    h += `<div class="box" style="top:472.1pt;height:97.5pt"><div class="hd"></div><div class="ti">Notes</div><div class="su">LA PLANQUE</div>`;
    [45.4, 60.4, 76.1, 91.1].forEach(y => h += `<div class="ln" style="top:${y}pt"></div>`);
    h += `<textarea class="notes small" style="top:31pt;height:62pt" data-notes>${esc(rec.n)}</textarea></div>`;
    h += `<div class="photoframe" style="top:581.2pt;height:150.8pt">${photoEl("jour-" + String(n).padStart(3, "0"), "", "", "Saint-Valentin")}</div>`;
  } else {
    h += `<div class="box" style="top:472.1pt;height:171.8pt"><div class="hd"></div><div class="ti">Notes</div><div class="su">LA PLANQUE</div>`;
    [52.9, 75.4, 97.9, 120.4, 142.1, 164.7].forEach(y => h += `<div class="ln" style="top:${y}pt"></div>`);
    h += `<textarea class="notes" style="top:30.5pt;height:136pt" data-notes>${esc(rec.n)}</textarea></div>`;
    h += `<div class="pensee"><div class="ti">Pensée positive</div><div class="ln"></div><div class="tx">${esc(I.pen)}</div></div>`;
    h += `<svg class="pico" viewBox="395 668 57 67">${DATA.icons[I.ic] || ""}</svg>`;
  }
  h += `<div class="niveau"><div class="t">NIVEAU DU JOUR</div><div class="stars">${[1,2,3,4,5].map(s => `<button data-star="${s}" title="${s}/5">${s <= rec.s ? "★" : "☆"}</button>`).join("")}</div></div>`;
  h += `<div class="qline"></div><div class="quote"><span>«</span> ${esc(I.q)} <span>»</span></div><div class="auteur">— ${esc(I.a)}</div>`;
  page.innerHTML = h;
  drawEvents(m, d);
}
function drawEvents(m, d) {
  const n = dayOfYear(m, d), I = info(n), ev = Cal.forDay(m, d);
  // bandeaux : ceux du PDF puis les événements « journée entière » de Google
  const fixed = I.bands.map(([t, type]) => {
    const heart = /Valentin|mariage|rencontre/i.test(t);
    const inner = esc(t);
    if (type === "ferie" || type === "fete") return `<div class="band b-${type}"><span class="s">✦</span>${heart ? "<span class=s>♥</span>" : ""}${inner}${heart ? "<span class=s>♥</span>" : ""}<span class="s">✦</span></div>`;
    return `<div class="band b-${type}">${inner}</div>`;
  });
  const gb = ev.allDay.map(e => `<div class="band g" data-ev="${esc(e.id)}" title="${esc(e.title)}"><span>${esc(e.title)}</span></div>`);
  const b = $("#bands"); if (b) b.innerHTML = fixed.concat(gb).join("");
  // rendez-vous dans la grille horaire (06h → 00h)
  const L = $("#evl"); if (!L) return;
  const day0 = new Date(YEAR, m - 1, d, 6), RH = 31.3, MAXH = 18 * RH + 25.3;
  const items = ev.timed.map(e => {
    let a = (e.start - day0) / 36e5, z = (e.end - day0) / 36e5;
    const early = a < 0; a = Math.max(0, a); z = Math.min(z, MAXH / RH);
    if (z <= a) z = a + 0.5;
    return { e, a, z, early };
  });
  // colonnes pour les chevauchements
  const cols = [];
  items.forEach(it => { let c = 0; while (cols[c] && cols[c] > it.a + 1e-6) c++; cols[c] = it.z; it.c = c; });
  items.forEach(it => { it.n = 1 + Math.max(0, ...items.filter(o => o.a < it.z && o.z > it.a).map(o => o.c)); });
  L.innerHTML = items.map(it => {
    const top = it.a * RH, hgt = Math.max(13, Math.min((it.z - it.a) * RH, MAXH - top) - 1.5);
    const wpc = 100 / it.n;
    const t = it.e.start.getDate() !== d || it.early ? `${hm(it.e.start)}` : hm(it.e.start);
    return `<div class="ev" data-ev="${esc(it.e.id)}" style="top:${top + 0.75}pt;height:${hgt}pt;left:${it.c * wpc}%;width:calc(${wpc}% - 2pt)" title="${esc(hm(it.e.start) + "–" + hm(it.e.end) + " " + it.e.title)}">
      <b>${t}–${hm(it.e.end)}</b>${esc(it.e.title)}${hgt > 24 && it.e.desc ? `<span class="d">${esc(it.e.desc)}</span>` : ""}</div>`;
  }).join("");
}

/* ---------------- interactions ---------------- */
document.addEventListener("click", e => {
  const slot = e.target.closest("[data-slot]");
  if (slot) { e.stopPropagation(); if (!connected()) { toast("Connecte-toi à Google pour changer les photos."); return; } pickSlot(slot.dataset.slot); return; }
  const g = e.target.closest("[data-go]");
  if (g && $("#page").contains(g)) { go(g.dataset.go); return; }
  const evEl = e.target.closest("[data-ev]");
  if (evEl) { const ev = Cal.find(evEl.dataset.ev); if (ev) openEvent(ev); return; }
  const hr = e.target.closest(".hr");
  if (hr) { const id = current; openEvent(null, { m: +id.slice(5, 7), d: +id.slice(8, 10), hour: +hr.dataset.hour }); return; }
  const ck = e.target.closest(".mi .ck");
  if (ck) { const i = +ck.parentElement.dataset.i; const rec = Store.get(current); const ms = rec.m.slice(); ms[i] = Object.assign({ t: "", d: false }, ms[i]); ms[i].d = !ms[i].d; Store.set(current, { m: ms }); ck.parentElement.classList.toggle("done", ms[i].d); ck.textContent = ms[i].d ? "✓" : ""; return; }
  const st = e.target.closest("[data-star]");
  if (st) { const rec = Store.get(current); const s = +st.dataset.star === rec.s ? 0 : +st.dataset.star; Store.set(current, { s }); document.querySelectorAll("[data-star]").forEach(b => b.textContent = +b.dataset.star <= s ? "★" : "☆"); return; }
});
let inputT = null;
document.addEventListener("input", e => {
  const t = e.target;
  if (t.matches("[data-mission]") || t.matches("[data-notes]")) {
    clearTimeout(inputT);
    const key = current;
    inputT = setTimeout(() => {
      const rec = Store.get(key);
      if (t.matches("[data-notes]")) Store.set(key, { n: t.value });
      else { const ms = rec.m.slice(); const i = +t.dataset.mission; ms[i] = Object.assign({ t: "", d: false }, ms[i], { t: t.value }); Store.set(key, { m: ms }); }
    }, 350);
  }
});
document.addEventListener("keydown", e => {
  if (e.target.closest("input,textarea,select") || !$("#evmodal").hidden || !$("#cfgmodal").hidden) {
    if (e.key === "Escape") closeModals();
    if (e.key === "Enter" && e.target.matches("[data-mission]")) { const nx = document.querySelector(`[data-mission="${+e.target.dataset.mission + 1}"]`); if (nx) nx.focus(); }
    return;
  }
  if (e.key === "ArrowRight" || e.key === "PageDown") step(1);
  if (e.key === "ArrowLeft" || e.key === "PageUp") step(-1);
});
const editing = () => !!document.activeElement && $("#page").contains(document.activeElement) && document.activeElement.matches("input,textarea");
function step(k) { const i = ORDER.indexOf(current); go(ORDER[Math.max(0, Math.min(ORDER.length - 1, i + k))]); }

/* ---------------- fenêtre rendez-vous ---------------- */
let editEv = null, editDay = null;
function openEvent(ev, at) {
  if (!connected()) { toast("Connecte-toi à Google pour ajouter ou modifier un rendez-vous."); return; }
  editEv = ev;
  const f = $("#evform");
  if (ev) {
    editDay = { m: ev.start.getMonth() + 1, d: ev.start.getDate() };
    f.title.value = ev.title; f.desc.value = ev.desc; f.allday.checked = ev.allDay;
    f.start.value = ev.allDay ? "09:00" : hm(ev.start); f.end.value = ev.allDay ? "10:00" : hm(ev.end);
    $("#evtitle").textContent = ev.recurring ? "Rendez-vous (répétition)" : "Rendez-vous";
    $("#evdel").hidden = false; $("#evlink").hidden = !ev.link; $("#evlink").href = ev.link || "#";
  } else {
    editDay = { m: at.m, d: at.d };
    f.reset(); const h0 = at.hour === 0 ? 23 : at.hour;
    f.start.value = `${pad(h0)}:00`; f.end.value = `${pad((h0 + 1) % 24)}:00`;
    if (at.hour === 0) { f.start.value = "23:00"; f.end.value = "23:59"; }
    $("#evtitle").textContent = "Nouveau rendez-vous"; $("#evdel").hidden = true; $("#evlink").hidden = true;
  }
  $("#evdate").textContent = `${JOURS[dow(editDay.m, editDay.d)]} ${editDay.d} ${MOIS[editDay.m - 1].toLowerCase()} 2027`;
  $("#evtimes").style.display = f.allday.checked ? "none" : "";
  $("#evmodal").hidden = false; setTimeout(() => f.title.focus(), 30);
}
$("#evform").allday.addEventListener("change", e => { $("#evtimes").style.display = e.target.checked ? "none" : ""; });
$("#evform").addEventListener("submit", async e => {
  e.preventDefault(); const f = e.target; const { m, d } = editDay;
  const body = { summary: f.title.value.trim(), description: f.desc.value };
  if (f.allday.checked) { body.start = { date: keyOf(m, d), dateTime: null }; const nx = fromN(Math.min(365, dayOfYear(m, d) + 1)); body.end = { date: dayOfYear(m, d) === 365 ? "2028-01-01" : keyOf(nx.m, nx.d), dateTime: null }; }
  else {
    const [sh, sm] = f.start.value.split(":").map(Number), [eh, em] = f.end.value.split(":").map(Number);
    const s = new Date(YEAR, m - 1, d, sh, sm); let en = new Date(YEAR, m - 1, d, eh, em); if (en <= s) en = new Date(s.getTime() + 36e5);
    // si l'événement durait déjà plusieurs jours, on garde sa date de fin d'origine
    if (editEv && !editEv.allDay && editEv.end.toDateString() !== editEv.start.toDateString()) { en = new Date(editEv.end); en.setHours(eh, em); if (en <= s) en = new Date(s.getTime() + 36e5); }
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Paris";
    body.start = { dateTime: s.toISOString(), timeZone: tz, date: null }; body.end = { dateTime: en.toISOString(), timeZone: tz, date: null };
  }
  if (!editEv) { for (const k of ["start", "end"]) for (const p in body[k]) if (body[k][p] === null) delete body[k][p]; }
  $("#evsave").disabled = true;
  try { await Cal.save(editEv, body); closeModals(); await Cal.load(m, true); refreshEvents(); toast(editEv ? "Rendez-vous modifié dans Google Agenda." : "Rendez-vous ajouté dans Google Agenda."); }
  catch (err) { if (err.message !== "expired") toast("Impossible d'enregistrer : " + err.message); }
  $("#evsave").disabled = false;
});
$("#evdel").addEventListener("click", async () => {
  if (!editEv) return;
  if (!confirmInline()) return;
  try { await Cal.remove(editEv); const m = editDay.m; closeModals(); await Cal.load(m, true); refreshEvents(); toast("Rendez-vous supprimé de Google Agenda."); }
  catch (err) { if (err.message !== "expired") toast("Impossible de supprimer : " + err.message); }
});
let delArmed = 0;
function confirmInline() { // 2 clics pour supprimer (pas de boîte de dialogue navigateur)
  if (Date.now() - delArmed < 4000) { delArmed = 0; $("#evdel").textContent = "Supprimer"; return true; }
  delArmed = Date.now(); $("#evdel").textContent = "Confirmer la suppression"; setTimeout(() => $("#evdel").textContent = "Supprimer", 4000); return false;
}
$("#evcancel").addEventListener("click", closeModals);
function closeModals() { document.querySelectorAll(".modal").forEach(m => m.hidden = true); editEv = null; }
document.querySelectorAll(".modal").forEach(m => m.addEventListener("mousedown", e => { if (e.target === m) closeModals(); }));

/* ---------------- réglage identifiant client ---------------- */
function openCfg() { $("#cfgform").cid.value = clientId(); $("#cfgmodal").hidden = false; setTimeout(() => $("#cfgform").cid.focus(), 30); }
$("#cfgcancel").addEventListener("click", closeModals);
$("#cfgform").addEventListener("submit", e => {
  e.preventDefault(); const v = e.target.cid.value.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(v)) { toast("L'identifiant doit se terminer par .apps.googleusercontent.com"); return; }
  ls.set("agenda2027.cid", v); closeModals(); G.client = null; connect();
});

/* ---------------- photos : fenêtre d'import ---------------- */
function phList() {
  const have = new Set(Drive.files.map(f => f.name.replace(/\.[^.]+$/, "").toLowerCase()));
  $("#phlist").innerHTML = PHOTO_NAMES.map(n => `<div class="${have.has(n) ? "ok" : ""}">${n}</div>`).join("");
}
$("#photosbtn").addEventListener("click", async () => {
  if (!connected()) { toast("Connecte-toi d'abord à Google : les photos sont rangées dans ton Drive."); return; }
  phList(); $("#phmodal").hidden = false;
});
$("#phclose").addEventListener("click", closeModals);
$("#phpick").addEventListener("click", () => $("#phinput").click());
$("#phinput").addEventListener("change", async e => { const fs = [...e.target.files]; e.target.value = ""; if (fs.length) { await Photos.importFiles(fs).catch(err => toast("Erreur : " + err.message)); phList(); } });
let slotKey = null;
function pickSlot(k) { slotKey = k; $("#slotinput").click(); }
$("#slotinput").addEventListener("change", async e => { const f = e.target.files[0]; e.target.value = ""; if (f && slotKey) await Photos.replaceSlot(slotKey, f).catch(err => toast("Erreur : " + err.message)); });

/* ---------------- barre ---------------- */
(function buildJump() {
  const opts = [["couverture", "Couverture"], ["annee", "L'année 2027"]].concat(MOIS.map((x, i) => ["mois-" + pad(i + 1), x])).concat([["fin", "Mission accomplie"], ["dos", "Dos"]]);
  $("#jump").innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
})();
$("#jump").addEventListener("change", e => go(e.target.value));
$("#datejump").addEventListener("change", e => { if (e.target.value) go(e.target.value); });
$("#prev").addEventListener("click", () => step(-1));
$("#next").addEventListener("click", () => step(1));
$("#today").addEventListener("click", () => { const t = new Date(); go(t.getFullYear() === YEAR ? keyOf(t.getMonth() + 1, t.getDate()) : (t.getFullYear() < YEAR ? keyOf(1, 1) : keyOf(12, 31))); });
$("#gbtn").addEventListener("click", () => { if (connected()) { syncNow(true); } else connect(); });
$("#printbtn").addEventListener("click", printPage);

function status(msg) {
  const b = $("#gbtn"), s = $("#sync");
  b.classList.remove("on", "warn");
  if (G.busy) { b.textContent = "Connexion…"; }
  else if (connected()) { b.textContent = "● Google connecté"; b.classList.add("on"); b.title = "Cliquer pour synchroniser maintenant"; }
  else if (ls.get("agenda2027.consent", false)) { b.textContent = "Reconnecter Google"; b.classList.add("warn"); b.title = ""; }
  else { b.textContent = "Se connecter à Google"; b.title = ""; }
  s.textContent = msg || (connected() && Drive.saveT && msg === undefined ? "" : "");
}
async function syncNow(manual) {
  if (!connected()) return;
  try {
    status("Synchronisation…");
    const m = monthOfPage(current);
    const [ch] = await Promise.all([m ? Cal.load(m, true) : false, Drive.pull()]);
    if (ch) refreshEvents();
    if (manual) { await Photos.load(); toast("Synchronisé avec Google."); }
    status();
  } catch (e) { status(); }
}
setInterval(() => { if (document.visibilityState === "visible") syncNow(false); }, 90000);
window.addEventListener("focus", () => syncNow(false));

/* ---------------- impression ---------------- */
function printPage() {
  const id = current, old = document.title;
  let label = id;
  if (/^\d{4}-/.test(id)) label = id;
  else if (id.startsWith("mois-")) label = MOIS[+id.slice(5) - 1];
  else label = ({ couverture: "Couverture", annee: "Annee", fin: "Fin", dos: "Dos" })[id];
  if (document.activeElement) document.activeElement.blur();
  document.title = `Agenda 2027 - ${label}`;
  const restore = () => { document.title = old; window.removeEventListener("afterprint", restore); };
  window.addEventListener("afterprint", restore);
  setTimeout(() => window.print(), 50);
}

/* ---------------- mise à l'échelle écran ---------------- */
function fit() {
  const p = $("#page"); const W = 817.28, H = 1146.56;
  const s = Math.min((window.innerWidth - 32) / W, (window.innerHeight - 52 - 32) / H, 1.25);
  p.style.zoom = Math.max(0.35, s).toFixed(4);
}
window.addEventListener("resize", fit);

let toastT;
function toast(msg, ms = 4200) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); if (ms) toastT = setTimeout(() => t.hidden = true, ms); }

/* ---------------- démarrage ---------------- */
window.AgendaDebug = { Cal, Store, refreshEvents, norm, Photos };
window.addEventListener("hashchange", render);
document.fonts && document.fonts.ready.then(fit);
render();
status();
if (connected()) {
  const wait = setInterval(() => { if (window.google?.accounts?.oauth2) { clearInterval(wait); initClient(); afterConnect(); } }, 200);
  setTimeout(() => clearInterval(wait), 15000);
}
})();
