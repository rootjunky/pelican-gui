// Pelican GUI - feature tabs: zone details, events, schedules, usage, power,
// alerts, site/demand response, MySites. Loaded after the main script in
// index.html and uses its helpers ($, api, esc, toast, setMsg, state, stat, ...).
"use strict";

// ====================================================================== helpers
const F = { loaded: {}, power: [], notifTimer: null };

/** Whitelisted pass-through to Pelican: returns the result object (minus success). */
async function pcall(request, object, selection, value) {
  const j = await api("/api/call", { request, object, selection: selection || "", value: value || "" });
  return j.data || {};
}
const asList = x => x == null ? [] : Array.isArray(x) ? x : [x];

/** {a:1,b:"x"} -> "a:1;b:x;"  (skips empty values). Values may not contain ';'. */
function kv(obj, trailing = true) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    const s = String(v);
    if (s.includes(";")) throw new Error(`${k} can't contain ";"`);
    parts.push(s === "\u0000" ? k : `${k}:${s}`);   // "\u0000" = flag-style attribute with no value
  }
  return parts.join(";") + (trailing && parts.length ? ";" : "");
}
const FLAG = "\u0000";

function noColon(v, what) {
  if (/[;:]/.test(String(v))) throw new Error(`${what} can't contain : or ;`);
  return v;
}
const pad2 = n => String(n).padStart(2, "0");
function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function isoMinute(d) { return `${isoDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function spinner(text) { return `<span class="spin"></span> ${esc(text || "Loading…")}`; }
function errBox(e) { return `<div class="note" style="color:var(--bad)">${esc(e.message || e)}</div>`; }
/** Friendly text for "nothing here" answers from Pelican. */
function isEmptyAnswer(e) { return /no .* found|not found matching/i.test(e.message || ""); }
function zoneNames() { return state.stats.map(t => t.name); }
function zoneOptions(selected, withAll) {
  return (withAll ? `<option value="">All zones</option>` : "") +
    zoneNames().map(n => `<option value="${esc(n)}" ${n === selected ? "selected" : ""}>${esc(n)}</option>`).join("");
}
function opts(list, selected) {
  const l = list.slice();
  if (selected !== undefined && selected !== null && selected !== "" && !l.includes(String(selected))) l.push(String(selected));
  return l.map(o => `<option ${String(o) === String(selected) ? "selected" : ""}>${esc(o)}</option>`).join("");
}
async function runAll(items, fn, msgEl) {
  // sequential, so Pelican sees one change at a time; reports progress
  let ok = 0; const errors = [];
  for (let i = 0; i < items.length; i++) {
    if (msgEl) { msgEl.innerHTML = spinner(`Sending ${i + 1} of ${items.length}…`); msgEl.className = "msg"; }
    try { await fn(items[i]); ok++; } catch (e) { errors.push(`${items[i].label || items[i]}: ${e.message}`); }
  }
  return { ok, errors };
}
function reportAll(msgEl, r, what) {
  if (!r.errors.length) return setMsg(msgEl, `${what}: ${r.ok} sent.`, "ok");
  setMsg(msgEl, `${r.ok} sent, ${r.errors.length} failed: ${r.errors.slice(0, 3).join(" | ")}${r.errors.length > 3 ? " …" : ""}`, "bad");
}

// ---------------------------------------------------------------- generic forms
// spec: {k, label, type: int|dec|text|enum|time|date|bool, opts, ro, hint}
function fieldHTML(sp, value, prefix) {
  const id = `${prefix}-${sp.k}`, v = value ?? "";
  let input;
  if (sp.ro) input = `<input id="${id}" value="${esc(v === "" ? "–" : v)}" readonly>`;
  else if (sp.type === "enum") input = `<select id="${id}">${v === "" ? '<option value=""></option>' : ""}${opts(sp.opts, v)}</select>`;
  else if (sp.type === "int") input = `<input id="${id}" type="number" step="1" value="${esc(v)}">`;
  else if (sp.type === "dec") input = `<input id="${id}" type="number" step="any" value="${esc(v)}">`;
  else if (sp.type === "time") input = `<input id="${id}" type="time" value="${esc(v)}">`;
  else if (sp.type === "date") input = `<input id="${id}" type="date" value="${esc(v)}">`;
  else input = `<input id="${id}" value="${esc(v)}" spellcheck="false">`;
  return `<div class="field"><label for="${id}">${esc(sp.label)}</label>${input}${sp.hint ? `<span class="hint">${esc(sp.hint)}</span>` : ""}</div>`;
}
function formHTML(specs, data, prefix) { return `<div class="form-grid">${specs.map(sp => fieldHTML(sp, data[sp.k], prefix)).join("")}</div>`; }
/** Changed, validated values only. */
function readForm(root, specs, data, prefix) {
  const out = {};
  for (const sp of specs) {
    if (sp.ro) continue;
    const el = root.querySelector(`#${prefix}-${sp.k}`); if (!el) continue;
    let v = String(el.value).trim();
    if (v === String(data[sp.k] ?? "").trim()) continue;
    if (v === "" && sp.type !== "text") continue;
    if (sp.type === "int" && !/^-?\d+$/.test(v)) throw new Error(`${sp.label} must be a whole number`);
    if (sp.type === "dec" && isNaN(+v)) throw new Error(`${sp.label} must be a number`);
    if (sp.type === "text") noColon(v, sp.label);
    out[sp.k] = v;
  }
  return out;
}

// ====================================================================== tabs
const TAB_INIT = {
  events: initEvents, schedules: initSchedules, usage: initUsage, power: initPower,
  alerts: initAlerts, site: initSite, sites: initSites,
};
function showTab(name) {
  document.querySelectorAll("nav.tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll("main > section.tab").forEach(s => { s.hidden = s.id !== `tab-${name}`; });
  try { localStorage.setItem("pelican.tab", name); } catch {}
  if (TAB_INIT[name] && !F.loaded[name]) {
    // Tabs build zone pickers from the zone list, so wait for the first load.
    if (!state.stats.length && name !== "sites" && (F.waits = (F.waits || 0) + 1) < 120) {
      $(`#tab-${name}`).innerHTML = spinner("Loading zones…");
      clearTimeout(F.waitTimer);
      F.waitTimer = setTimeout(() => { if (!$(`#tab-${name}`).hidden) showTab(name); }, 500);
      return;
    }
    F.waits = 0; F.loaded[name] = true; TAB_INIT[name]();
  }
}
$("#tabs").addEventListener("click", e => {
  const b = e.target.closest("button[data-tab]"); if (b) showTab(b.dataset.tab);
});

/** Called by enterApp() after every sign-in / site switch. */
function featuresOnEnter() {
  F.loaded = {}; F.power = [];
  for (const id of Object.keys(TAB_INIT)) $(`#tab-${id}`).innerHTML = "";
  let tab = "zones";
  try { tab = localStorage.getItem("pelican.tab") || "zones"; } catch {}
  showTab(TAB_INIT[tab] || tab === "zones" ? tab : "zones");
  clearInterval(F.notifTimer);
  updateAlertBadge();
  F.notifTimer = setInterval(() => { if (!document.hidden) updateAlertBadge(); }, 5 * 60 * 1000);
}

// ====================================================================== zone details
const ZONE_FIELDS = {
  info: [
    { k: "serialNo", label: "Serial number", ro: 1 }, { k: "modelNo", label: "Model", ro: 1 },
    { k: "version", label: "Firmware", ro: 1 }, { k: "gateway", label: "Gateway", ro: 1 },
    { k: "installDate", label: "Installed", ro: 1 }, { k: "setBy", label: "Last set by", ro: 1 },
    { k: "runStatus", label: "Run status", ro: 1 }, { k: "statusDisplay", label: "Status display", ro: 1 },
    { k: "auxStatus", label: "Aux heat running", ro: 1 }, { k: "temperature", label: "Temperature", ro: 1 },
    { k: "humidity", label: "Humidity %", ro: 1 }, { k: "co2Level", label: "CO₂ ppm", ro: 1 },
  ],
  naming: [
    { k: "name", label: "Zone name", type: "text", hint: "Renaming changes how the zone is addressed" },
    { k: "groupName", label: "Group / building", type: "text" },
    { k: "description", label: "Description", type: "text" },
  ],
  limits: [
    { k: "minHeatSetting", label: "Lowest heat setpoint", type: "int" },
    { k: "maxHeatSetting", label: "Highest heat setpoint", type: "int" },
    { k: "minCoolSetting", label: "Lowest cool setpoint", type: "int" },
    { k: "maxCoolSetting", label: "Highest cool setpoint", type: "int" },
  ],
  air: [
    { k: "humidityControl", label: "Humidity control", type: "enum", opts: ["None", "Humidify", "Dehumidify", "Full Control", "Cool Only"] },
    { k: "humidifySetting", label: "Humidify to (min %RH)", type: "int" },
    { k: "dehumidifySetting", label: "Dehumidify above (max %RH)", type: "int" },
    { k: "co2Setting", label: "CO₂ ventilation setpoint (ppm)", type: "int" },
    { k: "outsideVentilation", label: "Outside ventilation", type: "enum", opts: ["On", "Off"] },
  ],
  schedule: [
    { k: "schedule", label: "Schedule", type: "text", hint: "On, Off, or a shared schedule's name" },
    { k: "scheduleName", label: "Shared schedule name", type: "text" },
    { k: "scheduleRepeat", label: "Schedule repeats", type: "enum", opts: ["Daily", "Weekday", "Weekly"] },
    { k: "setback", label: "Demand-response setback", type: "enum", opts: ["On", "Off"] },
  ],
  alerts: [
    { k: "notificationSensitivity", label: "Alert sensitivity", type: "enum", opts: ["Off", "Low", "Medium", "High", "Custom"] },
    { k: "notificationSetpoint", label: "Alert setpoint offset", type: "int", hint: "Setting this switches sensitivity to Custom" },
    { k: "notificationUnreachable", label: "Alert when unreachable", type: "enum", opts: ["Yes", "No"] },
    { k: "minSafeTemp", label: "Alert below temp", type: "int" }, { k: "maxSafeTemp", label: "Alert above temp", type: "int" },
    { k: "minSafeHumidity", label: "Alert below %RH", type: "int" }, { k: "maxSafeHumidity", label: "Alert above %RH", type: "int" },
  ],
  installer: [
    { k: "systemType", label: "System type", type: "enum", opts: ["Conventional", "Heat Pump"] },
    { k: "heatStages", label: "Heat stages", type: "int" }, { k: "coolStages", label: "Cool stages", type: "int" },
    { k: "fanStages", label: "Fan stages", type: "int" },
    { k: "auxHeat", label: "Aux heat", type: "enum", opts: ["Disabled", "Auxiliary", "Emergency"] },
    { k: "reversingValve", label: "Reversing valve", type: "enum", opts: ["Heat", "Cool"] },
    { k: "HeatNeedsFan", label: "Heat needs fan", type: "enum", opts: ["Yes", "No"] },
    { k: "cycleRate", label: "Cycle rate", type: "int" },
    { k: "anticipationDegrees", label: "Anticipation (°)", type: "dec" },
    { k: "calibrationOffset", label: "Calibration offset (°)", type: "dec" },
    { k: "fanCirculationTime", label: "Fan circulation (min)", type: "int" },
    { k: "temperatureFormat", label: "Temperature format", type: "enum", opts: ["Fahrenheit", "Celsius"] },
    { k: "allowKeypadDisable", label: "Allow keypad lock", type: "enum", opts: ["Yes", "No"] },
    { k: "weight", label: "Sensor weight", type: "int" },
    { k: "heatingType", label: "Heating type", type: "text" }, { k: "heating2Type", label: "Heating 2 type", type: "text" },
    { k: "heatingAuxType", label: "Aux heating type", type: "text" },
    { k: "coolingType", label: "Cooling type", type: "text" }, { k: "cooling2Type", label: "Cooling 2 type", type: "text" },
  ],
};
const DEMAND_FIELDS = ["demandControl", "demandRequest", "demandAllow"];
const ZONE_SECTIONS = [
  ["naming", "Name & group"], ["limits", "Setpoint limits"], ["air", "Humidity, CO₂ & ventilation"],
  ["schedule", "Schedule"], ["alerts", "Alert thresholds"],
];

async function openZone(name) {
  const body = $("#zoneBody");
  $("#zoneTitle").textContent = `${name} · details & settings`;
  body.innerHTML = spinner();
  $("#dlgZone").showModal();
  const all = Object.values(ZONE_FIELDS).flat().map(f => f.k).concat(DEMAND_FIELDS);
  let z;
  try {
    const r = await pcall("get", "Thermostat", kv({ name: noColon(name, "Zone name") }), [...new Set(all)].join(";"));
    z = asList(r.Thermostat)[0] || {};
  } catch (e) { body.innerHTML = errBox(e); return; }
  F.zone = { name, data: z };
  const sec = (key, title, extra) => `<div class="panel" data-sec="${key}"><h3>${title}</h3>${extra || ""}
      ${formHTML(ZONE_FIELDS[key], z, "zf")}
      <div class="form-actions"><span class="msg"></span><button type="button" class="btn small primary" data-save="${key}">Save</button></div></div>`;
  const dc = String(z.demandControl || "Off");
  body.innerHTML = `
    <div class="panel"><h3>Device</h3>${formHTML(ZONE_FIELDS.info, z, "zf")}</div>
    ${ZONE_SECTIONS.map(([k, t]) => sec(k, t)).join("")}
    <div class="panel" data-sec="demand"><h3>Demand control</h3>
      <span class="hint">Lets a building system approve each heat/cool/fan cycle. When enabled, the thermostat asks first and waits for <b>Allow</b>.</span>
      <div class="form-grid">
        <div class="field"><label>Managed cycles</label><div class="seg" id="zfDemand">
          ${["Heat", "Cool", "Fan"].map(c => `<button type="button" data-v="${c}" class="${dc.split(" ").includes(c) ? "on" : ""}">${c}</button>`).join("")}</div>
          <span class="hint">None selected = demand control off</span></div>
        <div class="field"><label>Thermostat is requesting</label><input value="${esc(z.demandRequest || "None")}" readonly></div>
        <div class="field"><label for="zfAllow">Allow</label><select id="zfAllow">${opts(["None", "Heat", "Cool", "Fan"], z.demandAllow || "None")}</select></div>
      </div>
      <div class="form-actions"><span class="msg"></span><button type="button" class="btn small primary" data-save="demand">Save</button></div></div>
    <details class="panel" data-sec="installer"><summary><b>Installer settings</b> <span class="hint" style="display:inline">(equipment setup: change only if you know the HVAC hardware)</span></summary>
      ${formHTML(ZONE_FIELDS.installer, z, "zf")}
      <div class="form-actions"><span class="msg"></span><button type="button" class="btn small danger" data-save="installer">Save installer settings</button></div></details>
    <div class="panel" data-sec="custom"><h3>Custom attributes</h3>
      <span class="hint">Your own tags stored on the thermostat (e.g. <code>managed</code> = <code>yes</code>). Any name Pelican doesn't reserve becomes a custom attribute.</span>
      <div class="form-grid">
        <div class="field"><label for="zfCk">Attribute</label><input id="zfCk" placeholder="managed" spellcheck="false"></div>
        <div class="field"><label for="zfCv">Value</label><input id="zfCv" placeholder="yes" spellcheck="false"></div>
      </div>
      <div class="form-actions"><span class="msg"></span>
        <button type="button" class="btn small" data-save="custom-get">Read</button>
        <button type="button" class="btn small primary" data-save="custom-set">Set</button></div></div>`;
}

$("#zoneBody").addEventListener("click", async e => {
  const segBtn = e.target.closest("#zfDemand button");
  if (segBtn) { segBtn.classList.toggle("on"); return; }
  const b = e.target.closest("button[data-save]"); if (!b || !F.zone) return;
  const key = b.dataset.save, panel = b.closest("[data-sec]"), msg = panel.querySelector(".msg");
  const name = F.zone.name, z = F.zone.data;
  try {
    let values = {};
    if (ZONE_FIELDS[key]) values = readForm(panel, ZONE_FIELDS[key], z, "zf");
    else if (key === "demand") {
      const on = [...panel.querySelectorAll("#zfDemand button.on")].map(x => x.dataset.v);
      const dc = on.length ? on.join(" ") : "Off";
      if (dc !== String(z.demandControl || "Off")) values.demandControl = dc;
      const allow = $("#zfAllow").value;
      if (allow !== String(z.demandAllow || "None")) values.demandAllow = allow;
    } else if (key === "custom-get" || key === "custom-set") {
      const k = $("#zfCk").value.trim();
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) throw new Error("Attribute name: letters, digits and _ only");
      if (key === "custom-get") {
        const r = await pcall("get", "Thermostat", kv({ name }), k);
        const v = (asList(r.Thermostat)[0] || {})[k];
        $("#zfCv").value = v ?? "";
        return setMsg(msg, v === undefined || v === "" ? `${k} is not set` : `${k} = ${v}`, "ok");
      }
      values[k] = noColon($("#zfCv").value.trim(), "Value");
    }
    if (!Object.keys(values).length) return setMsg(msg, "Nothing changed", "");
    if (key === "installer" && !confirm(`Change installer settings on ${name}?\n\n${Object.entries(values).map(([k, v]) => `${k} → ${v}`).join("\n")}\n\nWrong values can stop the HVAC equipment working.`)) return;
    msg.innerHTML = spinner("Saving…"); msg.className = "msg";
    const r = await pcall("set", "Thermostat", kv({ name }), kv(values, false));
    Object.assign(z, values);
    if (values.name) { F.zone.name = values.name; $("#zoneTitle").textContent = `${values.name} · details & settings`; }
    setMsg(msg, r.message || "Saved", "ok");
    setTimeout(() => refresh(false), 2000);
  } catch (err) { setMsg(msg, err.message, "bad"); }
});

// ====================================================================== events
const EVENT_VALUES = "name;eventId;title;startDate;startTime;endTime;system;heatSetting;coolSetting;fan;keypad;outsideVentilation;editable;origin";
function initEvents() {
  $("#tab-events").innerHTML = `
    <div class="panel">
      <h3>Scheduled events</h3>
      <span class="hint">One-off overrides such as holidays, after-hours meetings or early starts. Pelican only lists current and upcoming events.
        Events made here are labelled <b>External</b>. Events can't cross midnight.</span>
      <div class="toolbar">
        <select id="evZone" aria-label="Zone">${zoneOptions("", true)}</select>
        <label><input type="checkbox" id="evAll" checked> Include events made in the Pelican app</label>
        <button class="btn small" id="evReload">Refresh</button>
        <span class="spacer" style="flex:1"></span>
        <button class="btn small primary" id="evNew">New event</button>
      </div>
      <div id="evList" class="tbl-wrap"></div>
    </div>
    <div class="panel" id="evFormPanel" hidden></div>`;
  $("#evReload").onclick = loadEvents;
  $("#evZone").onchange = loadEvents;
  $("#evAll").onchange = loadEvents;
  $("#evNew").onclick = () => eventForm(null);
  loadEvents();
}
async function loadEvents() {
  const box = $("#evList"); box.innerHTML = spinner();
  const zone = $("#evZone").value;
  try {
    const sel = kv({ name: zone || "", origin: $("#evAll").checked ? "all" : "" });
    const r = await pcall("get", "ThermostatEvent", sel, EVENT_VALUES);
    F.events = asList(r.ThermostatEvent).map(e => ({ ...e, name: e.name || zone }));
  } catch (e) {
    if (isEmptyAnswer(e)) F.events = []; else { box.innerHTML = errBox(e); return; }
  }
  F.events.sort((a, b) => `${a.startDate}${a.startTime}${a.name}`.localeCompare(`${b.startDate}${b.startTime}${b.name}`));
  if (!F.events.length) { box.innerHTML = '<div class="empty" style="padding:24px 0">No upcoming events.</div>'; return; }
  box.innerHTML = `<table class="tbl"><thead><tr><th>Zone</th><th>Title</th><th>Date</th><th>Time</th><th>Mode</th><th>Heat/Cool</th><th>Fan</th><th>Keypad</th><th>Made in</th><th></th></tr></thead><tbody>
    ${F.events.map((ev, i) => `<tr>
      <td>${esc(ev.name)}</td><td>${esc(ev.title || "–")}</td><td>${esc(ev.startDate)}</td>
      <td>${esc(ev.startTime)}–${esc(ev.endTime)}</td><td>${esc(ev.system || "")}</td>
      <td class="num">${esc(ev.heatSetting ?? "")} / ${esc(ev.coolSetting ?? "")}</td><td>${esc(ev.fan || "")}</td>
      <td>${ev.keypad === "Off" ? "Locked" : "Unlocked"}</td>
      <td><span class="pill">${ev.origin === "External" ? "This app / API" : esc(ev.origin || "")}</span></td>
      <td style="white-space:nowrap">${ev.editable === "No" ? '<span class="hint">read-only</span>' :
        `<button class="btn small" data-ev-edit="${i}">Edit</button> <button class="btn small danger" data-ev-del="${i}">Delete</button>`}</td></tr>`).join("")}
    </tbody></table>`;
}
$("#tab-events").addEventListener("click", async e => {
  const ed = e.target.closest("[data-ev-edit]"), del = e.target.closest("[data-ev-del]");
  if (ed) return eventForm(F.events[+ed.dataset.evEdit]);
  if (del) {
    const ev = F.events[+del.dataset.evDel];
    if (!confirm(`Delete event "${ev.title || ev.eventId}" on ${ev.name} (${ev.startDate} ${ev.startTime}–${ev.endTime})?`)) return;
    try {
      await pcall("set", "ThermostatEvent", kv({ eventId: ev.eventId }), kv({ delete: "Yes" }, false));
      toast("Event deleted"); loadEvents();
    } catch (err) { toast(err.message); }
  }
});
function eventForm(ev) {
  const p = $("#evFormPanel"); p.hidden = false;
  const d = ev || { startDate: isoDate(addDays(new Date(), 1)), startTime: "08:00", endTime: "17:00", system: "Auto", heatSetting: 68, coolSetting: 74, fan: "Auto", keypad: "On", outsideVentilation: "", editable: "Yes" };
  p.innerHTML = `<h3>${ev ? `Edit event ${esc(ev.eventId)}` : "New event"}</h3>
    <div class="form-grid">
      <div class="field" style="grid-column:1/-1"><label for="evZones">Zone${ev ? "" : "s (hold Ctrl/⌘ to pick several)"}</label>
        <select id="evZones" ${ev ? "disabled" : "multiple size=6"}>${zoneOptions(ev ? ev.name : "", false)}</select></div>
      <div class="field"><label for="evTitle">Title</label><input id="evTitle" value="${esc(d.title || "")}" placeholder="Holiday"></div>
      <div class="field"><label for="evDate">Date</label><input id="evDate" type="date" value="${esc(d.startDate)}"></div>
      <div class="field"><label for="evStart">Start</label><input id="evStart" type="time" value="${esc(d.startTime)}"></div>
      <div class="field"><label for="evEnd">End</label><input id="evEnd" type="time" value="${esc(d.endTime)}"></div>
      <div class="field"><label for="evSystem">Mode</label><select id="evSystem">${opts(["Auto", "Heat", "Cool", "Off"], d.system)}</select></div>
      <div class="field"><label for="evHeat">Heat to</label><input id="evHeat" type="number" value="${esc(d.heatSetting)}"></div>
      <div class="field"><label for="evCool">Cool to</label><input id="evCool" type="number" value="${esc(d.coolSetting)}"></div>
      <div class="field"><label for="evFan">Fan</label><select id="evFan">${opts(["Auto", "On"], d.fan)}</select></div>
      <div class="field"><label for="evKeypad">Keypad</label><select id="evKeypad"><option value="On" ${d.keypad !== "Off" ? "selected" : ""}>Unlocked</option><option value="Off" ${d.keypad === "Off" ? "selected" : ""}>Locked</option></select></div>
      <div class="field"><label for="evVent">Outside ventilation</label><select id="evVent"><option value="">(leave as is)</option>${opts(["On", "Off"], d.outsideVentilation)}</select></div>
      <div class="field"><label for="evEditable">Editable in Pelican app</label><select id="evEditable">${opts(["Yes", "No"], d.editable || "Yes")}</select></div>
    </div>
    <div class="form-actions"><span class="msg" id="evMsg"></span>
      <button class="btn small" id="evCancel">Cancel</button><button class="btn small primary" id="evSave">${ev ? "Save changes" : "Create event"}</button></div>`;
  $("#evCancel").onclick = () => { p.hidden = true; };
  $("#evSave").onclick = async () => {
    const msg = $("#evMsg");
    try {
      const zones = ev ? [ev.name] : [...$("#evZones").selectedOptions].map(o => o.value);
      if (!zones.length) throw new Error("Pick at least one zone");
      const st = $("#evStart").value, en = $("#evEnd").value;
      if (!$("#evDate").value || !st || !en) throw new Error("Date, start and end are required");
      if (en <= st) throw new Error("End must be after start (events can't cross midnight)");
      const h = +$("#evHeat").value, c = +$("#evCool").value;
      if (h >= c) throw new Error("Heat setpoint must be below cool setpoint");
      const values = {
        title: noColon($("#evTitle").value.trim(), "Title"), startDate: $("#evDate").value, startTime: st, endTime: en,
        system: $("#evSystem").value, heatSetting: h, coolSetting: c, fan: $("#evFan").value, keypad: $("#evKeypad").value,
        outsideVentilation: $("#evVent").value, editable: $("#evEditable").value, eventId: ev ? ev.eventId : "",
      };
      const r = await runAll(zones.map(z => ({ label: z, z })),
        it => pcall("set", "ThermostatEvent", kv({ name: noColon(it.z, "Zone") }), kv(values, false)), msg);
      reportAll(msg, r, ev ? "Event updated" : "Event created");
      if (!r.errors.length) { setTimeout(() => { p.hidden = true; }, 1200); }
      loadEvents();
    } catch (err) { setMsg(msg, err.message, "bad"); }
  };
  p.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ====================================================================== schedules
// Pelican's API can WRITE schedules but not read them ("Get ... is currently
// unsupported"), so the editor starts from a template (or one saved in this browser).
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function daysFor(repeat) {
  // Per Pelican docs: Daily uses Sunday's entries, Weekday uses Sunday (weekend) + Monday (weekdays), Weekly uses all 7.
  if (repeat === "Daily") return [["Sunday", "Every day"]];
  if (repeat === "Weekday") return [["Monday", "Weekdays (Mon–Fri)"], ["Sunday", "Weekend (Sat–Sun)"]];
  return DAYS.map(d => [d, d]);
}
function defaultRows() {
  return [
    { startTime: "06:00", system: "Auto", heatSetting: 68, coolSetting: 74, fan: "Auto", keypad: "On" },
    { startTime: "18:00", system: "Auto", heatSetting: 62, coolSetting: 80, fan: "Auto", keypad: "On" },
  ];
}
function schedTemplates() { try { return JSON.parse(localStorage.getItem("pelican.schedTemplates") || "{}") || {}; } catch { return {}; } }
function saveSchedTemplates(t) { try { localStorage.setItem("pelican.schedTemplates", JSON.stringify(t)); } catch {} }

/** A day-by-day editor. kind = "zone" adds Optimum start / Ventilation columns. */
function SchedEditor(root, kind) {
  this.root = root; this.kind = kind; this.repeat = "Weekly"; this.days = {}; this.vacation = false;
}
SchedEditor.prototype.setRepeat = function (r) {
  this.repeat = r;
  for (const [d] of daysFor(r)) if (!this.days[d]) this.days[d] = defaultRows();
  this.render();
};
SchedEditor.prototype.render = function () {
  const zone = this.kind === "zone";
  const dayList = daysFor(this.repeat).concat(this.vacation ? [["Vacation", "Vacation"]] : []);
  for (const [d] of dayList) if (!this.days[d]) this.days[d] = defaultRows();
  this.root.innerHTML = dayList.map(([d, label]) => `<div class="sched-day" data-day="${d}"><h4>${esc(label)}</h4>
      <div class="sched-row hint"><span>#</span><span>Starts</span><span>Mode</span><span>Heat</span><span>Cool</span><span>Fan</span><span>Keypad</span><span>${zone ? "Optimum start · Vent" : ""}</span></div>
      ${this.days[d].map((r, i) => `<div class="sched-row" data-i="${i}">
        <span>${i + 1}</span>
        <input type="time" data-f="startTime" value="${esc(r.startTime)}" aria-label="Start time">
        <select data-f="system">${opts(["Auto", "Heat", "Cool", "Off"], r.system)}</select>
        <input type="number" data-f="heatSetting" value="${esc(r.heatSetting)}" aria-label="Heat">
        <input type="number" data-f="coolSetting" value="${esc(r.coolSetting)}" aria-label="Cool">
        <select data-f="fan">${opts(["Auto", "On"], r.fan)}</select>
        <select data-f="keypad"><option value="On" ${r.keypad !== "Off" ? "selected" : ""}>Unlocked</option><option value="Off" ${r.keypad === "Off" ? "selected" : ""}>Locked</option></select>
        <span style="display:flex;gap:6px;align-items:center">
          ${zone ? `<select data-f="optimumStart" title="Optimum start"><option value="">–</option>${opts(["On", "Off"], r.optimumStart)}</select>
                    <select data-f="outsideVentilation" title="Outside ventilation"><option value="">–</option>${opts(["On", "Off"], r.outsideVentilation)}</select>` : ""}
          <button type="button" class="btn small" data-del-row title="Remove this time">✕</button></span>
      </div>`).join("")}
      <button type="button" class="btn small" data-add-row ${this.days[d].length >= 12 ? "disabled" : ""}>+ Add time</button></div>`).join("");
};
SchedEditor.prototype.sync = function () {
  this.root.querySelectorAll(".sched-day").forEach(dayEl => {
    const d = dayEl.dataset.day;
    dayEl.querySelectorAll(".sched-row[data-i]").forEach(rowEl => {
      const r = this.days[d][+rowEl.dataset.i];
      rowEl.querySelectorAll("[data-f]").forEach(inp => { r[inp.dataset.f] = inp.value; });
    });
  });
};
SchedEditor.prototype.onClick = function (e) {
  const add = e.target.closest("[data-add-row]"), del = e.target.closest("[data-del-row]");
  if (!add && !del) return;
  this.sync();
  const d = e.target.closest(".sched-day").dataset.day;
  if (add) { const last = this.days[d][this.days[d].length - 1] || defaultRows()[0]; this.days[d].push({ ...last, startTime: "" }); }
  if (del) { this.days[d].splice(+e.target.closest(".sched-row").dataset.i, 1); }
  this.render();
};
/** [{day, setTime, values}] validated, in Pelican's terms. */
SchedEditor.prototype.entries = function () {
  this.sync();
  const out = [];
  const dayList = daysFor(this.repeat).concat(this.vacation ? [["Vacation", "Vacation"]] : []);
  for (const [d, label] of dayList) {
    const rows = this.days[d] || [];
    if (rows.length > 12) throw new Error(`${label}: at most 12 times per day`);
    let prev = "";
    rows.forEach((r, i) => {
      if (!/^\d\d:\d\d$/.test(r.startTime)) throw new Error(`${label} #${i + 1}: start time missing`);
      if (r.startTime <= prev) throw new Error(`${label}: times must be in order`);
      prev = r.startTime;
      if (+r.heatSetting >= +r.coolSetting) throw new Error(`${label} #${i + 1}: heat must be below cool`);
      const v = { startTime: r.startTime, system: r.system, heatSetting: +r.heatSetting, coolSetting: +r.coolSetting, fan: r.fan, keypad: r.keypad };
      if (this.kind === "zone") { v.optimumStart = r.optimumStart || ""; v.outsideVentilation = r.outsideVentilation || ""; }
      out.push({ day: d, setTime: i + 1, values: v, label: `${label} #${i + 1}` });
    });
  }
  return out;
};
SchedEditor.prototype.toJSON = function () { this.sync(); return { repeat: this.repeat, days: this.days, vacation: this.vacation }; };
SchedEditor.prototype.load = function (t) { this.repeat = t.repeat || "Weekly"; this.days = JSON.parse(JSON.stringify(t.days || {})); this.vacation = !!t.vacation; this.render(); };

function sharedScheduleNames() {
  return [...new Set(state.stats.map(t => t.scheduleName).filter(Boolean))].sort();
}
function templateBar(prefix) {
  const t = schedTemplates();
  return `<select id="${prefix}Tpl" aria-label="Saved templates"><option value="">Saved templates…</option>${Object.keys(t).sort().map(n => `<option>${esc(n)}</option>`).join("")}</select>
    <button type="button" class="btn small" id="${prefix}TplLoad">Load</button>
    <button type="button" class="btn small" id="${prefix}TplSave">Save as template</button>`;
}
function wireTemplates(prefix, ed) {
  $(`#${prefix}TplLoad`).onclick = () => {
    const n = $(`#${prefix}Tpl`).value, t = schedTemplates()[n]; if (!t) return;
    ed.load(t); $(`#${prefix}Repeat`).value = ed.repeat; $(`#${prefix}Vac`).checked = ed.vacation; toast(`Loaded "${n}"`);
  };
  $(`#${prefix}TplSave`).onclick = () => {
    const n = prompt("Template name:"); if (!n) return;
    const t = schedTemplates(); t[n] = ed.toJSON(); saveSchedTemplates(t);
    document.querySelectorAll('[id$="Tpl"]').forEach(sel => { if (![...sel.options].some(o => o.value === n)) sel.add(new Option(n, n)); });
    toast(`Saved template "${n}" in this browser`);
  };
}

function initSchedules() {
  const shared = sharedScheduleNames();
  $("#tab-schedules").innerHTML = `
    <div class="note" style="margin-bottom:16px">Pelican lets apps <b>write</b> schedules but not read them back, so these editors can't show what's on a thermostat now.
      Build the schedule here (or load a template you saved), then send it. Sending <b>replaces</b> that day's existing times.</div>
    <div class="panel">
      <h3>Zone schedule</h3>
      <span class="hint">Sends the schedule to each selected zone, then turns its schedule on.</span>
      <div class="form-grid">
        <div class="field" style="grid-column:1/-1"><label for="zsZones">Zones (hold Ctrl/⌘ to pick several)</label><select id="zsZones" multiple size="6">${zoneOptions("", false)}</select></div>
        <div class="field"><label for="zsRepeat">Repeats</label><select id="zsRepeat">${opts(["Daily", "Weekday", "Weekly"], "Weekday")}</select></div>
        <div class="field check"><input type="checkbox" id="zsVac"><label for="zsVac">Include vacation schedule</label></div>
      </div>
      <div class="toolbar" style="margin-top:10px">${templateBar("zs")}</div>
      <div id="zsEditor"></div>
      <div class="form-actions"><span class="msg" id="zsMsg"></span>
        <button type="button" class="btn small danger" id="zsClear" title="Delete every time on the selected days">Clear days</button>
        <button type="button" class="btn small primary" id="zsSend">Send to zones</button></div>
    </div>
    <div class="panel">
      <h3>Shared schedules</h3>
      <span class="hint">One schedule used by many zones. Schedules this site's zones already use: ${shared.length ? shared.map(s => `<b>${esc(s)}</b>`).join(", ") : "none"}.</span>
      <div class="form-grid">
        <div class="field"><label for="ssName">Schedule name</label><input id="ssName" list="ssNames" spellcheck="false" placeholder="Hallways">
          <datalist id="ssNames">${shared.map(s => `<option value="${esc(s)}">`).join("")}</datalist></div>
        <div class="field"><label for="ssRepeat">Repeats</label><select id="ssRepeat">${opts(["Daily", "Weekday", "Weekly"], "Weekday")}</select></div>
        <div class="field check"><input type="checkbox" id="ssVac"><label for="ssVac">Include vacation schedule</label></div>
      </div>
      <div class="toolbar" style="margin-top:10px">${templateBar("ss")}</div>
      <div id="ssEditor"></div>
      <div class="form-actions"><span class="msg" id="ssMsg"></span>
        <button type="button" class="btn small danger" id="ssDelete">Delete schedule</button>
        <button type="button" class="btn small primary" id="ssSend">Create / replace schedule</button></div>
      <h3 style="margin-top:18px">Assign to zones</h3>
      <div class="form-grid">
        <div class="field" style="grid-column:1/-1"><label for="ssZones">Zones (hold Ctrl/⌘ to pick several)</label><select id="ssZones" multiple size="6">${zoneOptions("", false)}</select></div>
      </div>
      <div class="form-actions"><span class="msg" id="ssAssignMsg"></span><button type="button" class="btn small primary" id="ssAssign">Use this schedule on selected zones</button></div>
    </div>`;
  const zs = F.zs = new SchedEditor($("#zsEditor"), "zone"); zs.setRepeat("Weekday");
  const ss = F.ss = new SchedEditor($("#ssEditor"), "shared"); ss.setRepeat("Weekday");
  $("#zsEditor").addEventListener("click", e => zs.onClick(e));
  $("#ssEditor").addEventListener("click", e => ss.onClick(e));
  $("#zsRepeat").onchange = e => { zs.sync(); zs.setRepeat(e.target.value); };
  $("#ssRepeat").onchange = e => { ss.sync(); ss.setRepeat(e.target.value); };
  $("#zsVac").onchange = e => { zs.sync(); zs.vacation = e.target.checked; zs.render(); };
  $("#ssVac").onchange = e => { ss.sync(); ss.vacation = e.target.checked; ss.render(); };
  wireTemplates("zs", zs); wireTemplates("ss", ss);

  const pickedZones = id => { const z = [...$(id).selectedOptions].map(o => o.value); if (!z.length) throw new Error("Pick at least one zone"); return z; };
  const dayNames = ed => daysFor(ed.repeat).map(d => d[0]).concat(ed.vacation ? ["Vacation"] : []);

  $("#zsSend").onclick = async () => {
    const msg = $("#zsMsg");
    try {
      const zones = pickedZones("#zsZones"), entries = zs.entries();
      if (!confirm(`Replace the ${zs.repeat} schedule on ${zones.length} zone(s) with ${entries.length} time(s) each?`)) return;
      const jobs = [];
      for (const z of zones) {
        noColon(z, "Zone");
        jobs.push({ label: `${z} repeat`, run: () => pcall("set", "Thermostat", kv({ name: z }), kv({ scheduleRepeat: zs.repeat }, false)) });
        for (const d of dayNames(zs)) jobs.push({ label: `${z} clear ${d}`, run: () => pcall("set", "ThermostatSchedule", kv({ name: z, dayOfWeek: d }), kv({ deleteAll: FLAG }, false)) });
        for (const en of entries) jobs.push({ label: `${z} ${en.label}`, run: () => pcall("set", "ThermostatSchedule", kv({ name: z, dayOfWeek: en.day, setTime: en.setTime }), kv(en.values, false)) });
        jobs.push({ label: `${z} schedule on`, run: () => pcall("set", "Thermostat", kv({ name: z }), kv({ schedule: "On" }, false)) });
      }
      reportAll(msg, await runAll(jobs, j => j.run(), msg), "Schedule sent");
      setTimeout(() => refresh(false), 2000);
    } catch (e) { setMsg(msg, e.message, "bad"); }
  };
  $("#zsClear").onclick = async () => {
    const msg = $("#zsMsg");
    try {
      const zones = pickedZones("#zsZones"), days = dayNames(zs);
      if (!confirm(`Delete all schedule times for ${days.join(", ")} on ${zones.length} zone(s)?`)) return;
      const jobs = zones.flatMap(z => days.map(d => ({ label: `${z} ${d}`, run: () => pcall("set", "ThermostatSchedule", kv({ name: noColon(z, "Zone"), dayOfWeek: d }), kv({ deleteAll: FLAG }, false)) })));
      reportAll(msg, await runAll(jobs, j => j.run(), msg), "Cleared");
    } catch (e) { setMsg(msg, e.message, "bad"); }
  };
  const ssName = () => { const n = $("#ssName").value.trim(); if (!n) throw new Error("Enter a schedule name"); return noColon(n, "Schedule name"); };
  $("#ssSend").onclick = async () => {
    const msg = $("#ssMsg");
    try {
      const name = ssName(), entries = ss.entries();
      if (!confirm(`Create or replace shared schedule "${name}" (${ss.repeat}, ${entries.length} times)?\n\nIf it exists it is deleted and rebuilt, as Pelican recommends.`)) return;
      const jobs = [
        { label: "delete old", run: () => pcall("set", "SharedSchedule", kv({ name }), kv({ scheduleDelete: FLAG }, false)).catch(() => null) },
        { label: "create", run: () => pcall("set", "SharedSchedule", kv({ name }), kv({ scheduleRepeat: ss.repeat }, false)) },
        ...entries.map(en => ({ label: en.label, run: () => pcall("set", "SharedSchedule", kv({ name, dayOfWeek: en.day, setTime: en.setTime }), kv(en.values, false)) })),
      ];
      reportAll(msg, await runAll(jobs, j => j.run(), msg), `Schedule "${name}" sent`);
    } catch (e) { setMsg(msg, e.message, "bad"); }
  };
  $("#ssDelete").onclick = async () => {
    const msg = $("#ssMsg");
    try {
      const name = ssName();
      if (!confirm(`Delete shared schedule "${name}"? Zones using it will stop following it.`)) return;
      const r = await pcall("set", "SharedSchedule", kv({ name }), kv({ scheduleDelete: FLAG }, false));
      setMsg(msg, r.message || "Deleted", "ok");
    } catch (e) { setMsg(msg, e.message, "bad"); }
  };
  $("#ssAssign").onclick = async () => {
    const msg = $("#ssAssignMsg");
    try {
      const name = ssName(), zones = pickedZones("#ssZones");
      const r = await runAll(zones.map(z => ({ label: z, z })), it => pcall("set", "Thermostat", kv({ name: noColon(it.z, "Zone") }), kv({ scheduleName: name }, false)), msg);
      reportAll(msg, r, `Assigned "${name}"`);
      setTimeout(() => refresh(false), 2000);
    } catch (e) { setMsg(msg, e.message, "bad"); }
  };
}

// ====================================================================== usage
const USAGE_SERIES = [
  ["heatMinutes", "Heat", "--heat", 1], ["heatStage2Minutes", "Heat stage 2", "--heat", .65], ["heatAuxiliaryMinutes", "Aux heat", "--bad", .8],
  ["coolMinutes", "Cool", "--cool", 1], ["CoolStage2Minutes", "Cool stage 2", "--cool", .6], ["fanMinutes", "Fan only", "--fan", .7],
];
const USAGE_VALUES = "name;heatMinutes;coolMinutes;fanMinutes;heatStage2Minutes;heatAuxiliaryMinutes;CoolStage2Minutes;totalkWh;totalTherms;timestamp";
function num(v) { const n = +v; return isNaN(n) ? 0 : n; }
/** Usage rows may spell CoolStage2Minutes either way; normalise. */
function usageRow(u) { const r = { ...u }; if (r.coolStage2Minutes !== undefined && r.CoolStage2Minutes === undefined) r.CoolStage2Minutes = r.coolStage2Minutes; return r; }

function initUsage() {
  const today = new Date();
  $("#tab-usage").innerHTML = `
    <div class="panel">
      <h3>HVAC runtime</h3>
      <span class="hint">How long zones heated, cooled and ran the fan. Energy and cost appear when Pelican has kWh/therm data for the site.</span>
      <div class="toolbar">
        <select id="usZone" aria-label="Zone">${zoneOptions("", true)}</select>
        <select id="usDur" aria-label="Resolution"><option value="day">Daily</option><option value="month">Monthly</option><option value="15minute">15 minutes (one day)</option></select>
        <label id="usFromL">From <input type="date" id="usFrom" value="${isoDate(addDays(today, -13))}"></label>
        <label id="usToL">To <input type="date" id="usTo" value="${isoDate(today)}"></label>
        <label id="usMonthsL" hidden>Last <select id="usMonths">${[3, 6, 12].map(n => `<option ${n === 6 ? "selected" : ""}>${n}</option>`).join("")}</select> months</label>
        <label id="usDayL" hidden>Day <input type="date" id="usDay" value="${isoDate(addDays(today, -1))}"></label>
        <button class="btn small primary" id="usLoad">Show</button>
      </div>
      <div id="usOut"></div>
    </div>
    <div class="panel">
      <h3>PowerLink energy</h3>
      <span class="hint">Metered electricity from Pelican PowerLink devices, if this site has them.</span>
      <div class="toolbar">
        <select id="puDur" aria-label="Resolution"><option value="day">Daily</option><option value="month">Monthly</option><option value="PT1H">Hourly</option><option value="PT15M">15 minutes</option></select>
        <label>From <input type="date" id="puFrom" value="${isoDate(addDays(today, -13))}"></label>
        <label>To <input type="date" id="puTo" value="${isoDate(today)}"></label>
        <button class="btn small primary" id="puLoad">Show</button>
      </div>
      <div id="puOut"></div>
    </div>`;
  const syncDur = () => {
    const d = $("#usDur").value;
    $("#usFromL").hidden = $("#usToL").hidden = d !== "day";
    $("#usMonthsL").hidden = d !== "month"; $("#usDayL").hidden = d !== "15minute";
  };
  $("#usDur").onchange = syncDur;
  $("#usLoad").onclick = loadUsage;
  $("#puLoad").onclick = loadPowerUsage;
  loadUsage();
}

function usageRange() {
  const d = $("#usDur").value;
  if (d === "month") {
    const n = +$("#usMonths").value, now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - n + 1, 1);
    return [`${isoDate(start)}T00:00`, `${isoDate(addDays(now, 1))}T00:00`, d];
  }
  if (d === "15minute") { const day = $("#usDay").value; return [`${day}T00:00`, `${isoDate(addDays(new Date(day + "T00:00"), 1))}T00:00`, d]; }
  const from = $("#usFrom").value, to = $("#usTo").value;
  if (!from || !to || to < from) throw new Error("Pick a valid date range");
  if ((new Date(to) - new Date(from)) / 864e5 > 30) throw new Error("Daily usage is limited to 31 days per request");
  return [`${from}T00:00`, `${isoDate(addDays(new Date(to + "T00:00"), 1))}T00:00`, d];
}

async function loadUsage() {
  const out = $("#usOut");
  let range;
  try { range = usageRange(); } catch (e) { out.innerHTML = errBox(e); return; }
  out.innerHTML = spinner("Loading usage… (all zones can take a while)");
  const zone = $("#usZone").value, t = stat(zone);
  const sel = kv({ startDateTime: range[0], endDateTime: range[1], duration: range[2], serialNo: t && t.serialNo ? t.serialNo : "" });
  let zones;
  try {
    const [r, site] = await Promise.all([pcall("get", "ThermostatUsage", sel, USAGE_VALUES), F.siteInfo ? F.siteInfo : api("/api/site").then(j => (F.siteInfo = j.data)).catch(() => ({}))]);
    zones = asList(r.ThermostatUsage).filter(z => !zone || z.name === zone || asList(r.ThermostatUsage).length === 1);
  } catch (e) { out.innerHTML = isEmptyAnswer(e) ? '<div class="note">No usage recorded for this period.</div>' : errBox(e); return; }
  // sum per timestamp across zones
  const byTs = new Map(), perZone = [];
  for (const z of zones) {
    const tot = { name: z.name, heat: 0, cool: 0, fan: 0 };
    for (const u0 of asList(z.Usage)) {
      const u = usageRow(u0), key = u.timestamp;
      if (!byTs.has(key)) byTs.set(key, { timestamp: key });
      const agg = byTs.get(key);
      for (const [k] of USAGE_SERIES) agg[k] = (agg[k] || 0) + num(u[k]);
      agg.totalkWh = (agg.totalkWh || 0) + num(u.totalkWh); agg.totalTherms = (agg.totalTherms || 0) + num(u.totalTherms);
      tot.heat += num(u.heatMinutes) + num(u.heatStage2Minutes) + num(u.heatAuxiliaryMinutes);
      tot.cool += num(u.coolMinutes) + num(u.CoolStage2Minutes); tot.fan += num(u.fanMinutes);
    }
    perZone.push(tot);
  }
  const rows = [...byTs.values()].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  if (!rows.length) { out.innerHTML = '<div class="note">No usage recorded for this period.</div>'; return; }
  const sum = k => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const heatH = (sum("heatMinutes") + sum("heatStage2Minutes") + sum("heatAuxiliaryMinutes")) / 60;
  const coolH = (sum("coolMinutes") + sum("CoolStage2Minutes")) / 60, fanH = sum("fanMinutes") / 60;
  const kwh = sum("totalkWh"), therms = sum("totalTherms");
  const s = F.siteInfo || {}, kwhCost = num(s.kwhCost), thermCost = num(s.thermCost);
  const cost = kwh * kwhCost + therms * thermCost;
  const tiles = [
    ["Heating", `${heatH.toFixed(1)} h`], ["Cooling", `${coolH.toFixed(1)} h`], ["Fan only", `${fanH.toFixed(1)} h`],
    ...(kwh ? [["Electricity", `${kwh.toFixed(1)} kWh`]] : []), ...(therms ? [["Gas", `${therms.toFixed(1)} therms`]] : []),
    ...(cost ? [["Est. cost", `$${cost.toFixed(2)}`]] : []),
  ];
  const series = USAGE_SERIES.filter(([k]) => sum(k) > 0);
  const label = ts => range[2] === "month" ? new Date(ts + "T00:00").toLocaleDateString([], { month: "short", year: "2-digit" })
    : range[2] === "15minute" ? String(ts).slice(11, 16) : new Date(String(ts).slice(0, 10) + "T00:00").toLocaleDateString([], { month: "short", day: "numeric" });
  perZone.sort((a, b) => (b.heat + b.cool) - (a.heat + a.cool));
  out.innerHTML = `
    <div class="summary">${tiles.map(([k, v]) => `<span class="chip">${k} <b>${v}</b></span>`).join("")}</div>
    ${cost ? `<div class="hint" style="margin:-6px 0 10px">Cost uses this site's rates: $${kwhCost}/kWh, $${thermCost}/therm (set on the Site tab).</div>` : ""}
    <div class="legend">${series.map(([, n, c, o]) => `<span><i style="background:var(${c});opacity:${o};height:8px"></i>${n}</span>`).join("")}</div>
    <div class="bars chart-wrap">${stackedBars(rows, series, label, range[2] === "15minute" ? "min" : "h")}</div>
    ${!zone && perZone.length > 1 ? `<h3 style="margin-top:16px">Busiest zones</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Zone</th><th class="num">Heating h</th><th class="num">Cooling h</th><th class="num">Fan h</th></tr></thead><tbody>
      ${perZone.slice(0, 15).map(z => `<tr><td>${esc(z.name)}</td><td class="num">${(z.heat / 60).toFixed(1)}</td><td class="num">${(z.cool / 60).toFixed(1)}</td><td class="num">${(z.fan / 60).toFixed(1)}</td></tr>`).join("")}
      </tbody></table></div>` : ""}`;
}

/** Stacked bar chart (inline SVG). unit "h" divides minutes by 60. */
function stackedBars(rows, series, label, unit) {
  const W = 900, H = 260, L = 44, R = 10, T = 10, B = 30;
  const div = unit === "h" ? 60 : 1;
  const totals = rows.map(r => series.reduce((a, [k]) => a + (r[k] || 0), 0) / div);
  const max = Math.max(1, ...totals), step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const bw = (W - L - R) / rows.length, gap = Math.min(6, bw * .2);
  const css = getComputedStyle(document.documentElement), col = k => css.getPropertyValue(k).trim();
  let g = "";
  for (let v = 0; v <= top + 1e-9; v += step) {
    const y = T + (1 - v / top) * (H - T - B);
    g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="${col("--line")}"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="${col("--muted")}">${+v.toFixed(1)}${unit}</text>`;
  }
  const every = Math.ceil(rows.length / 16);
  rows.forEach((r, i) => {
    let y = H - B; const x = L + i * bw + gap / 2, w = Math.max(1, bw - gap);
    const tip = [label(r.timestamp), ...series.filter(([k]) => r[k]).map(([k, n]) => `${n}: ${(r[k] / div).toFixed(unit === "h" ? 1 : 0)}${unit}`)].join("\n");
    g += `<g><title>${esc(tip)}</title>`;
    for (const [k, , c, o] of series) {
      const h = (r[k] || 0) / div / top * (H - T - B); if (!h) continue;
      y -= h; g += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${col(c)}" opacity="${o}"/>`;
    }
    g += `</g>`;
    if (i % every === 0) g += `<text x="${(x + w / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="${col("--muted")}">${esc(label(r.timestamp))}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Runtime chart">${g}</svg>`;
}
function niceStep(max) {
  const raw = max / 5, p = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

async function loadPowerUsage() {
  const out = $("#puOut"), from = $("#puFrom").value, to = $("#puTo").value, dur = $("#puDur").value;
  if (!from || !to || to < from) { out.innerHTML = errBox("Pick a valid date range"); return; }
  out.innerHTML = spinner();
  try {
    const r = await pcall("get", "PowerUsage",
      kv({ startDateTime: `${from}T00:00:00Z`, endDateTime: `${to}T23:59:59Z`, duration: dur }),
      "name;groupName;serialNo;meterId;kWh;kW;units;unitsPerPulse;timestamp");
    const meters = asList(r.PowerUsage);
    const byTs = new Map();
    for (const m of meters) for (const u of asList(m.Usage || m.PowerUsage || m)) {
      if (!u.timestamp) continue;
      const a = byTs.get(u.timestamp) || { timestamp: u.timestamp, kWh: 0 };
      a.kWh += num(u.kWh); byTs.set(u.timestamp, a);
    }
    const rows = [...byTs.values()].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    if (!rows.length) { out.innerHTML = '<div class="note">No energy readings for this period.</div>'; return; }
    const total = rows.reduce((a, x) => a + x.kWh, 0), rate = num((F.siteInfo || {}).kwhCost);
    out.innerHTML = `<div class="summary"><span class="chip">Total <b>${total.toFixed(1)} kWh</b></span>${rate ? `<span class="chip">Est. cost <b>$${(total * rate).toFixed(2)}</b></span>` : ""}
      <span class="chip"><b>${meters.length}</b> meter${meters.length === 1 ? "" : "s"}</span></div>
      <div class="bars chart-wrap">${stackedBars(rows, [["kWh", "kWh", "--accent", 1]], ts => String(ts).slice(5, dur.startsWith("PT") ? 16 : 10).replace("T", " "), "")}</div>`;
  } catch (e) {
    out.innerHTML = /no powerlink/i.test(e.message) ? '<div class="note">This site has no PowerLink energy meters.</div>' : errBox(e);
  }
}

// ====================================================================== power (relays)
const PS_VALUES = "name;serialNo;scheduleId;title;startDate;endDate;startTime;endTime;repeat;editable;origin";
const WEEKDAYS = [["Mo", "Mon"], ["Tu", "Tue"], ["We", "Wed"], ["Th", "Thu"], ["Fr", "Fri"], ["Sa", "Sat"], ["Su", "Sun"]];
function initPower() {
  $("#tab-power").innerHTML = `
    <div class="panel"><h3>Power outputs</h3>
      <span class="hint">Lights, pumps and other loads wired to Pelican power control modules.</span>
      <div class="toolbar"><button class="btn small" id="poReload">Refresh</button></div>
      <div id="poList"></div></div>
    <div class="panel"><h3>Power schedules</h3>
      <span class="hint">When each output turns on and off. Times can also be relative to sunrise/sunset in the Pelican app (e.g. <code>Dusk-30</code>).</span>
      <div class="toolbar"><button class="btn small" id="psReload">Refresh</button><span style="flex:1"></span><button class="btn small primary" id="psNew">New schedule</button></div>
      <div id="psList" class="tbl-wrap"></div></div>
    <div class="panel" id="psFormPanel" hidden></div>`;
  $("#poReload").onclick = loadPowerOutputs;
  $("#psReload").onclick = loadPowerSchedules;
  $("#psNew").onclick = () => powerScheduleForm(null);
  loadPowerOutputs().then(loadPowerSchedules);
}
async function loadPowerOutputs() {
  const box = $("#poList"); box.innerHTML = spinner();
  try {
    const r = await pcall("get", "PowerOutput", "", "name;groupName;serialNo;output;setBy;schedule");
    F.power = asList(r.PowerOutput);
  } catch (e) {
    F.power = [];
    box.innerHTML = isEmptyAnswer(e) ? '<div class="note">This site has no power control modules.</div>' : errBox(e);
    return;
  }
  const groups = new Map();
  for (const p of F.power) { const g = p.groupName || "Ungrouped"; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); }
  box.innerHTML = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([g, list]) => `
    <h4 style="margin:12px 0 8px">${esc(g)}</h4>
    <div class="cards-mini">${list.map(p => {
      const i = F.power.indexOf(p);
      return `<div class="card" style="gap:8px;padding:12px">
        <div class="card-head"><div><h2 style="font-size:14px">${esc(p.name)}</h2><div class="hint">${esc(p.serialNo)} · set by ${esc(p.setBy || "–")}</div></div>
          <span class="run ${p.output === "On" ? "heat" : "off"}">${p.output === "On" ? "On" : "Off"}</span></div>
        <div class="controls">
          <span>Output</span><div class="seg" data-po="${i}" data-f="output">${["On", "Off"].map(v => `<button type="button" data-v="${v}" class="${p.output === v ? "on" : ""}">${v}</button>`).join("")}</div>
          <span>Schedule</span><div class="seg" data-po="${i}" data-f="schedule">${[["On", "Running"], ["Off", "Hold"]].map(([v, l]) => `<button type="button" data-v="${v}" class="${p.schedule === v ? "on" : ""}">${l}</button>`).join("")}</div>
        </div></div>`;
    }).join("")}</div>`).join("");
}
$("#tab-power").addEventListener("click", async e => {
  const b = e.target.closest(".seg[data-po] button");
  if (b) {
    const seg = b.parentElement, p = F.power[+seg.dataset.po], f = seg.dataset.f, v = b.dataset.v;
    if (p[f] === v) return;
    if (f === "output" && !confirm(`Turn ${p.name} ${v}?`)) return;
    try {
      // Pelican's example capitalises "Schedule"; attribute names are case-insensitive.
      const r = await pcall("set", "PowerOutput", kv({ name: noColon(p.name, "Output name") }), kv({ [f]: v }, false));
      toast(r.message || "Updated"); p[f] = v; if (f === "output") p.setBy = "Remote";
      loadPowerOutputs();
    } catch (err) { toast(err.message); }
    return;
  }
  const ed = e.target.closest("[data-ps-edit]"), del = e.target.closest("[data-ps-del]");
  if (ed) return powerScheduleForm(F.pschedules[+ed.dataset.psEdit]);
  if (del) {
    const s = F.pschedules[+del.dataset.psDel];
    if (!confirm(`Delete power schedule ${s.scheduleId}${s.name ? ` (${s.name})` : ""}?`)) return;
    try { await pcall("set", "PowerSchedule", kv({ scheduleId: s.scheduleId }), kv({ delete: "Yes" }, false)); toast("Schedule deleted"); loadPowerSchedules(); }
    catch (err) { toast(err.message); }
  }
});
async function loadPowerSchedules() {
  const box = $("#psList"); if (!box) return;
  if (!F.power.length) { box.innerHTML = '<div class="hint">No power outputs, so no power schedules.</div>'; $("#psNew").disabled = true; return; }
  box.innerHTML = spinner();
  // Per-module requests return the output names (a site-wide request leaves them blank).
  const serials = [...new Set(F.power.map(p => p.serialNo).filter(Boolean))];
  const all = [];
  try {
    for (const sn of serials) {
      try { all.push(...asList((await pcall("get", "PowerSchedule", kv({ serialNo: sn, origin: "all" }), PS_VALUES)).PowerSchedule)); }
      catch (e) { if (!isEmptyAnswer(e)) throw e; }
    }
  } catch (e) { box.innerHTML = errBox(e); return; }
  F.pschedules = all.sort((a, b) => `${a.name}${a.startTime}`.localeCompare(`${b.name}${b.startTime}`));
  if (!all.length) { box.innerHTML = '<div class="note">No power schedules.</div>'; return; }
  box.innerHTML = `<table class="tbl"><thead><tr><th>Output</th><th>Title</th><th>On</th><th>Off</th><th>Repeats</th><th>From</th><th>Until</th><th>Made in</th><th></th></tr></thead><tbody>
    ${all.map((s, i) => `<tr><td>${esc(s.name || "–")}<div class="hint">${esc(s.scheduleId)}</div></td><td>${esc(s.title || "–")}</td>
      <td>${esc(s.startTime)}</td><td>${esc(s.endTime)}</td><td>${esc(prettyRepeat(s.repeat))}</td><td>${esc(s.startDate || "–")}</td><td>${esc(s.endDate || "no end")}</td>
      <td><span class="pill">${s.origin === "External" ? "This app / API" : esc(s.origin || "")}</span></td>
      <td style="white-space:nowrap">${s.editable === "No" ? '<span class="hint">read-only</span>' : `<button class="btn small" data-ps-edit="${i}">Edit</button> <button class="btn small danger" data-ps-del="${i}">Delete</button>`}</td></tr>`).join("")}
    </tbody></table>`;
}
function prettyRepeat(r) {
  const m = /^Weekly\((.*)\)$/.exec(r || "");
  if (!m) return r || "";
  const d = m[1].split(",").map(x => x.trim());
  if (d.join() === "Mo,Tu,We,Th,Fr") return "Weekdays";
  if (d.join() === "Sa,Su") return "Weekends";
  return d.map(x => (WEEKDAYS.find(w => w[0] === x) || [x, x])[1]).join(", ");
}
function powerScheduleForm(s) {
  const p = $("#psFormPanel"); p.hidden = false;
  const d = s || { startDate: isoDate(new Date()), endDate: "", startTime: "07:00", endTime: "18:00", repeat: "Weekly(Mo,Tu,We,Th,Fr)", editable: "Yes" };
  const rep = /^Weekly/.test(d.repeat) ? "Weekly" : (d.repeat || "Daily");
  const wk = (/^Weekly\((.*)\)$/.exec(d.repeat || "") || [, ""])[1].split(",");
  const outIdx = s ? F.power.findIndex(o => o.serialNo === s.serialNo && o.name === s.name) : 0;
  const relTime = v => /^\d\d:\d\d$/.test(v || "") ? "" : v;   // Dawn/Dusk offsets: keep as text
  p.innerHTML = `<h3>${s ? `Edit ${esc(s.scheduleId)}` : "New power schedule"}</h3>
    <div class="form-grid">
      <div class="field" style="grid-column:span 2"><label for="psOut">Output</label><select id="psOut" ${s ? "disabled" : ""}>
        ${F.power.map((o, i) => `<option value="${i}" ${i === outIdx ? "selected" : ""}>${esc(o.name)} (${esc(o.serialNo)})</option>`).join("")}</select></div>
      <div class="field"><label for="psTitle">Title</label><input id="psTitle" value="${esc(d.title || "")}"></div>
      <div class="field"><label for="psStart">On at</label><input id="psStart" type="${relTime(d.startTime) ? "text" : "time"}" value="${esc(d.startTime)}"></div>
      <div class="field"><label for="psEnd">Off at</label><input id="psEnd" type="${relTime(d.endTime) ? "text" : "time"}" value="${esc(d.endTime)}"></div>
      <div class="field"><label for="psRepeat">Repeats</label><select id="psRepeat">${["None", "Daily", "Weekly", "Monthly", "Yearly"].map(o => `<option value="${o}" ${o === rep ? "selected" : ""}>${o === "None" ? "Once" : o}</option>`).join("")}</select></div>
      <div class="field"><label for="psFrom">Starting</label><input id="psFrom" type="date" value="${esc(d.startDate)}"></div>
      <div class="field"><label for="psTo">Until (optional)</label><input id="psTo" type="date" value="${esc(d.endDate)}"></div>
      <div class="field"><label for="psEditable">Editable in Pelican app</label><select id="psEditable">${opts(["Yes", "No"], d.editable || "Yes")}</select></div>
      <div class="field" id="psDaysF" style="grid-column:1/-1" ${rep === "Weekly" ? "" : "hidden"}><label>Days</label><div class="seg" id="psDays">
        ${WEEKDAYS.map(([k, l]) => `<button type="button" data-v="${k}" class="${wk.includes(k) ? "on" : ""}">${l}</button>`).join("")}</div></div>
    </div>
    <div class="form-actions"><span class="msg" id="psMsg"></span><button class="btn small" id="psCancel">Cancel</button>
      <button class="btn small primary" id="psSave">${s ? "Save changes" : "Create schedule"}</button></div>`;
  $("#psRepeat").onchange = e => { $("#psDaysF").hidden = e.target.value !== "Weekly"; };
  $("#psDays").onclick = e => { const b = e.target.closest("button"); if (b) b.classList.toggle("on"); };
  $("#psCancel").onclick = () => { p.hidden = true; };
  $("#psSave").onclick = async () => {
    const msg = $("#psMsg");
    try {
      const out = s ? { name: s.name, serialNo: s.serialNo } : F.power[+$("#psOut").value];
      const st = $("#psStart").value.trim(), en = $("#psEnd").value.trim();
      if (!st || !en) throw new Error("On and off times are required");
      if (/^\d\d:\d\d$/.test(st) && /^\d\d:\d\d$/.test(en) && en <= st) throw new Error("Off must be after on (schedules can't cross midnight)");
      let repeat = $("#psRepeat").value;
      if (repeat === "Weekly") {
        const days = [...$("#psDays").querySelectorAll("button.on")].map(b => b.dataset.v);
        if (!days.length) throw new Error("Pick at least one day");
        repeat = `Weekly(${days.join(",")})`;
      }
      const from = $("#psFrom").value, to = $("#psTo").value;
      if (!from) throw new Error("Pick a start date");
      if (to && to < from) throw new Error("'Until' is before 'Starting'");
      const values = { startDate: from, endDate: to, startTime: st, endTime: en, title: noColon($("#psTitle").value.trim(), "Title"),
        scheduleID: s ? s.scheduleId : "", editable: $("#psEditable").value, repeat };
      msg.innerHTML = spinner("Saving…"); msg.className = "msg";
      const r = await pcall("set", "PowerSchedule", kv({ serialNo: out.serialNo, name: noColon(out.name, "Output name") }), kv(values, false));
      setMsg(msg, r.message || "Saved", "ok"); loadPowerSchedules();
      setTimeout(() => { p.hidden = true; }, 1200);
    } catch (err) { setMsg(msg, err.message, "bad"); }
  };
  p.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ====================================================================== alerts
async function fetchNotifications() {
  try { return asList((await pcall("get", "Notification", "", "name;serialNo;type;description;status;updatedAt")).Notification); }
  catch (e) { if (isEmptyAnswer(e)) return []; throw e; }
}
async function updateAlertBadge() {
  try {
    const list = await fetchNotifications();
    F.notifications = list;
    const n = list.filter(x => x.status === "Active").length;
    const b = $("#alertBadge"); b.hidden = !n; b.textContent = n;
  } catch { /* badge is best-effort */ }
}
function initAlerts() {
  const me = state.sess && state.sess.username || "";
  $("#tab-alerts").innerHTML = `
    <div class="panel"><h3>Alerts</h3>
      <span class="hint">Equipment and comfort alerts Pelican has raised for this site (heat failures, unreachable devices, out-of-range temperatures…).</span>
      <div class="toolbar">
        <select id="alShow" aria-label="Show"><option value="Active">Active</option><option value="">All</option></select>
        <button class="btn small" id="alReload">Refresh</button></div>
      <div id="alList" class="tbl-wrap"></div></div>
    <div class="panel"><h3>My alert delivery</h3>
      <span class="hint">How Pelican sends alerts to a user on this site. Pelican doesn't let apps read these settings, so the current values can't be shown. Only the fields you change are sent.</span>
      <div class="form-grid">
        <div class="field"><label for="usEmail">User's email</label><input id="usEmail" type="email" value="${esc(me)}"></div>
        <div class="field"><label for="usEmailOn">Email alerts</label><select id="usEmailOn"><option value="">(no change)</option><option>On</option><option>Off</option></select></div>
        <div class="field"><label for="usTextOn">Text alerts</label><select id="usTextOn"><option value="">(no change)</option><option>On</option><option>Off</option></select></div>
        <div class="field"><label for="usText">Text address</label><input id="usText" placeholder="5551234567@txt.carrier.com" spellcheck="false"><span class="hint">Your carrier's email-to-text address</span></div>
      </div>
      <div class="form-actions"><span class="msg" id="usMsg"></span><button class="btn small primary" id="usSave">Save</button></div></div>`;
  $("#alShow").onchange = renderAlerts;
  $("#alReload").onclick = async () => { $("#alList").innerHTML = spinner(); try { F.notifications = await fetchNotifications(); renderAlerts(); updateAlertBadge(); } catch (e) { $("#alList").innerHTML = errBox(e); } };
  $("#usSave").onclick = async () => {
    const msg = $("#usMsg");
    try {
      const email = $("#usEmail").value.trim();
      if (!/^[^@\s;:]+@[^@\s;:]+$/.test(email)) throw new Error("Enter the user's email");
      const values = { emailNotifications: $("#usEmailOn").value, textNotifications: $("#usTextOn").value, textEmail: $("#usText").value.trim() };
      if (values.textEmail) noColon(values.textEmail, "Text address");
      if (!Object.values(values).some(Boolean)) throw new Error("Nothing to change");
      const r = await pcall("set", "User", kv({ email }), kv(values, false));
      setMsg(msg, r.message || "Saved", "ok");
    } catch (e) { setMsg(msg, e.message, "bad"); }
  };
  $("#alReload").onclick();
}
function renderAlerts() {
  const box = $("#alList"), want = $("#alShow").value;
  const list = (F.notifications || []).filter(n => !want || n.status === want)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (!list.length) { box.innerHTML = `<div class="empty" style="padding:24px 0">${want ? "No active alerts. 🎉" : "No alerts."}</div>`; return; }
  box.innerHTML = `<table class="tbl"><thead><tr><th>When</th><th>Device</th><th>Type</th><th>Details</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(n => { const i = F.notifications.indexOf(n); return `<tr>
      <td style="white-space:nowrap">${esc(String(n.updatedAt || "").replace("T", " "))}</td>
      <td>${esc(n.name)}<div class="hint">${esc(n.serialNo)}</div></td><td>${esc(n.type)}</td>
      <td style="white-space:pre-line">${esc(String(n.description || "").trim())}</td>
      <td><span class="pill ${n.status === "Active" ? "bad" : "ok"}">${esc(n.status)}</span></td>
      <td>${n.status === "Active" ? `<button class="btn small" data-dismiss="${i}">Dismiss</button>` : ""}</td></tr>`; }).join("")}
    </tbody></table>`;
}
$("#tab-alerts").addEventListener("click", async e => {
  const b = e.target.closest("[data-dismiss]"); if (!b) return;
  const n = F.notifications[+b.dataset.dismiss];
  try {
    // Pelican only accepts status:Dismissed; the docs don't say how to pick the alert, so match device + type.
    const r = await pcall("set", "Notification", kv({ serialNo: n.serialNo, type: n.type }), kv({ status: "Dismissed" }, false));
    toast(r.message || "Dismissed"); n.status = "Dismissed"; renderAlerts(); updateAlertBadge();
  } catch (err) { toast(err.message); }
});

// ====================================================================== site + demand response
const SITE_SPECS = [
  { k: "altName", label: "Site name (shown in MySites)", type: "text" },
  { k: "type", label: "Site type", type: "enum", opts: ["Business", "Hotel", "Residential"] },
  { k: "postalCode", label: "ZIP / postal code", type: "text" },
  { k: "timeZone", label: "Time zone", type: "text", hint: "e.g. America/Chicago" },
  { k: "kwhCost", label: "Electricity $/kWh", type: "dec" },
  { k: "thermCost", label: "Gas $/therm", type: "dec" },
];
const DR_LEVELS = [["0", "Normal"], ["1", "Moderate"], ["2", "High"], ["3", "Special"]];
async function initSite() {
  const tab = $("#tab-site");
  tab.innerHTML = spinner();
  let s;
  try { s = F.siteInfo = (await api("/api/site")).data; } catch (e) { tab.innerHTML = errBox(e); return; }
  const now = new Date(); now.setMinutes(0, 0, 0); now.setHours(now.getHours() + 1);
  const setback = state.stats.filter(t => t.setback === "On");
  tab.innerHTML = `
    <div class="panel" id="sitePanel"><h3>Site settings</h3>
      ${formHTML(SITE_SPECS, s, "sf")}
      <div class="form-actions"><span class="msg" id="sfMsg"></span><button class="btn small primary" id="sfSave">Save</button></div></div>
    <div class="panel"><h3>Demand response</h3>
      <span class="hint">Ask every participating zone to ease off (a "setback") for a while, e.g. during a utility peak. Which zones take part and how far they set back is configured in the Pelican app.
        Only one event can be scheduled at a time; a new one replaces it.</span>
      <dl class="kv" style="margin:6px 0 12px">
        <dt>OpenADR</dt><dd>${esc(s.OpenADRStatus || "–")}</dd>
        <dt>Current utility event</dt><dd>${esc(s.OpenADREventType || "None")}${s.OpenADREventStart ? ` · ${esc(s.OpenADREventStart)} → ${esc(s.OpenADREventEnd)}` : ""}</dd>
        <dt>Zones in setback now</dt><dd>${setback.length ? setback.map(t => esc(t.name)).join(", ") : "none"}</dd>
      </dl>
      <div class="form-grid">
        <div class="field"><label for="drStart">Start</label><input id="drStart" type="datetime-local" value="${isoMinute(now)}"></div>
        <div class="field"><label for="drDur">Duration</label><select id="drDur">${[["PT15M", "15 min"], ["PT30M", "30 min"], ["PT1H", "1 hour"], ["PT2H", "2 hours"], ["PT3H", "3 hours"], ["PT4H", "4 hours"], ["PT6H", "6 hours"], ["PT8H", "8 hours"]].map(([v, l]) => `<option value="${v}" ${v === "PT2H" ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field"><label for="drLevel">Level</label><select id="drLevel">${DR_LEVELS.map(([v, l]) => `<option value="${v}" ${v === "1" ? "selected" : ""}>${v} · ${l}</option>`).join("")}</select></div>
      </div>
      <div class="form-actions"><span class="msg" id="drMsg"></span>
        <button class="btn small danger" id="drCancel">Cancel scheduled event</button>
        <button class="btn small primary" id="drGo">Schedule event</button></div>
      <h3 style="margin-top:18px">Past demand-response events</h3>
      <div class="toolbar">
        <label>From <input type="date" id="drhFrom" value="${isoDate(addDays(new Date(), -29))}"></label>
        <label>To <input type="date" id="drhTo" value="${isoDate(new Date())}"></label>
        <button class="btn small" id="drhLoad">Show</button></div>
      <div id="drhOut" class="tbl-wrap"></div></div>`;
  $("#sfSave").onclick = async () => {
    const msg = $("#sfMsg");
    try {
      const values = readForm($("#sitePanel"), SITE_SPECS, s, "sf");
      if (!Object.keys(values).length) return setMsg(msg, "Nothing changed", "");
      if (values.timeZone && !/^[A-Za-z_]+\/[A-Za-z_\/+-]+$/.test(values.timeZone)) throw new Error("Time zone looks wrong (use e.g. America/Chicago)");
      msg.innerHTML = spinner("Saving…"); msg.className = "msg";
      const r = await pcall("set", "Site", "", kv(values, false));
      Object.assign(s, values); setMsg(msg, r.message || "Saved", "ok");
      if (values.altName !== undefined) loadSiteName();
    } catch (e) { setMsg(msg, e.message, "bad"); }
  };
  $("#drGo").onclick = async () => {
    const msg = $("#drMsg");
    try {
      const st = $("#drStart").value; if (!st) throw new Error("Pick a start time");
      const lvl = DR_LEVELS.find(l => l[0] === $("#drLevel").value);
      if (!confirm(`Schedule a level ${lvl[0]} (${lvl[1]}) demand-response event at ${st.replace("T", " ")} for ${$("#drDur").selectedOptions[0].text}?\n\nThis replaces any event already scheduled.`)) return;
      const r = await pcall("drEvent", "Site", "", kv({ startDateTime: st, duration: $("#drDur").value, level: lvl[0] }));
      setMsg(msg, r.message || "Event scheduled", "ok");
    } catch (e) { setMsg(msg, e.message, "bad"); }
  };
  $("#drCancel").onclick = async () => {
    const msg = $("#drMsg");
    if (!confirm("Cancel the scheduled demand-response event?")) return;
    try { const r = await pcall("drEventCancel", "Site", "", ""); setMsg(msg, r.message || "Cancelled", "ok"); }
    catch (e) { setMsg(msg, e.message, "bad"); }
  };
  $("#drhLoad").onclick = async () => {
    const out = $("#drhOut"), from = $("#drhFrom").value, to = $("#drhTo").value;
    if (!from || !to || to < from) { out.innerHTML = errBox("Pick a valid date range"); return; }
    out.innerHTML = spinner();
    try {
      const r = await pcall("get", "DemandResponseHistory", kv({ startDateTime: `${from}T00:00`, endDateTime: `${to}T23:59` }), "eventID;startDateTime;endDateTime;duration");
      const list = asList(r.DemandResponseHistory);
      out.innerHTML = !list.length ? '<div class="note">No demand-response events in this period.</div>' :
        `<table class="tbl"><thead><tr><th>Event</th><th>Start</th><th>End</th><th class="num">Minutes</th></tr></thead><tbody>
        ${list.map(x => `<tr><td>${esc(x.eventID || x.eventId)}</td><td>${esc(String(x.startDateTime).replace("T", " "))}</td><td>${esc(String(x.endDateTime).replace("T", " "))}</td><td class="num">${esc(x.duration)}</td></tr>`).join("")}</tbody></table>`;
    } catch (e) {
      out.innerHTML = isEmptyAnswer(e) ? '<div class="note">No demand-response events in this period.</div>'
        : /permission/i.test(e.message) ? '<div class="note">This login isn\'t allowed to see demand-response history (Pelican: "' + esc(e.message) + '").</div>' : errBox(e);
    }
  };
  $("#drhLoad").onclick();
}

// ====================================================================== my sites (MySites)
async function initSites() {
  const tab = $("#tab-sites");
  tab.innerHTML = `<div class="panel"><h3>My sites</h3>
    <span class="hint">Every site on your Pelican account. Switching uses the login you signed in with. If a site has a different password, or you were only shared into it, the app gets a 24-hour access token from Pelican automatically.</span>
    <div class="toolbar"><button class="btn small" id="msReload">Refresh</button></div><div id="msList"></div></div>`;
  $("#msReload").onclick = loadMySites;
  loadMySites();
}
async function loadMySites() {
  const box = $("#msList"); box.innerHTML = spinner();
  try {
    const sites = (await api("/api/mysites", {})).data || [];
    if (!sites.length) { box.innerHTML = '<div class="note">No sites found on this account.</div>'; return; }
    const cur = state.sess && state.sess.domain;
    box.innerHTML = `<div class="cards-mini">${sites.map(s => {
      const off = num(s.devices) - num(s.activeDevices), gwOff = num(s.gateways) - num(s.activeGateways);
      return `<div class="card" style="padding:14px;gap:10px">
        <div class="card-head" style="align-items:center"><div style="display:flex;gap:10px;align-items:center">
          <img class="site-icon" style="width:34px;height:34px;border-radius:8px" src="${esc(siteIconUrl(s.domain, false))}" alt="" onerror="this.onerror=null;this.src='building.svg'">
          <div><h2 style="font-size:14px">${esc(s.name)}</h2><div class="hint">${esc(s.domain)}</div></div></div>
          ${s.domain === cur ? '<span class="pill ok">Current</span>' : ""}</div>
        <dl class="kv"><dt>Devices</dt><dd>${esc(s.activeDevices)} / ${esc(s.devices)} online${off ? ` · <b style="color:var(--bad)">${off} offline</b>` : ""}</dd>
          <dt>Gateways</dt><dd>${esc(s.activeGateways)} / ${esc(s.gateways)} online${gwOff ? ` · <b style="color:var(--bad)">${gwOff} offline</b>` : ""}</dd>
          <dt>Alerts</dt><dd>${num(s.notifications) ? `<b style="color:var(--bad)">${esc(s.notifications)}</b>` : "0"}</dd></dl>
        ${s.domain === cur ? "" : `<button class="btn small primary" data-switch="${esc(s.domain)}">Switch to this site</button>`}</div>`;
    }).join("")}</div>`;
  } catch (e) { box.innerHTML = errBox(e); }
}
$("#tab-sites").addEventListener("click", async e => {
  const b = e.target.closest("[data-switch]"); if (!b) return;
  if (Object.keys(state.pending).length && !confirm("You have zone changes that haven't been applied. Switch anyway?")) return;
  b.disabled = true; b.innerHTML = spinner("Switching…");
  try {
    const j = await api("/api/switch-site", { site: b.dataset.switch });
    saveLocalSites([j.data.domain, ...localSites().filter(x => x !== j.data.domain)]);
    await loadSession();
    try { localStorage.setItem("pelican.tab", "zones"); } catch {}   // land on the new site's zones
    enterApp(j.data);
    toast(`Switched to ${j.data.altName || j.data.domain}${j.data.viaToken ? " (using a Pelican access token)" : ""}`);
  } catch (err) { toast(err.message); b.disabled = false; b.textContent = "Switch to this site"; }
});
