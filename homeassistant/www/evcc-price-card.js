/*
 * evcc price card: the next 24 h of grid prices per quarter-hour (the EPEX/Zonneplan
 * granularity) with the quarters the car will charge, their cost, plus Smart / Solar / Manual / Fast.
 *   Smart   evcc's plan picks the hours (oak bars)
 *   Manual  drag across the bars to paint the hours yourself; Clear = stay off.
 *           An HA automation (packages/evcc.yaml) runs evcc "now" inside them, "off" outside.
 *   Solar   surplus only on 1 phase (Smart with the repeating plans off). Phases change only
 *           while the car is unplugged (HA automation evcc_solar), never mid-session.
 *   Fast    charge now at full power; the bars show the projection until full
 *
 * Reads only HA entities (the browser can't reach evcc through the tunnel):
 *   forecast_entity  attributes.rates  [{start, end, value}]  (sensor.evcc_price_forecast)
 *   plan_entity      attributes.plan / .power                  (sensor.evcc_charge_plan)
 *   soc_entity       state + effectivePlanSoc / effectivePlanTime / chargeRemainingEnergy
 *   mode_entity      select with options off / smart / now (only written: its optimistic state can go stale)
 *   mode_sensor      evcc's actual mode, read for display
 *   power_entity     charge power in W
 *   manual_entity    input_boolean: Manual mode on/off
 *   hours_entity     input_text: painted quarters, "<base>:<hex bitmask>" (see encodeQuarters)
 *   solar_entity     input_boolean: Solar mode on/off
 *   solar_forecast_entity  attributes.time / .global_tilted_irradiance (Open-Meteo, 15 min, UTC)
 *   solar_kwp        panel peak power for that forecast; base_load = house use (W) it must cover first
 * Colours come from the active theme; charging hours use the oak accent.
 *
 * Deploy: copy to <config>/www/evcc-price-card.js and load it as a dashboard resource
 * (Settings > Dashboards > Resources, JavaScript module): /local/evcc-price-card.js?v=27.
 * Not via frontend: extra_module_url: that line lives in the page HTML, which the HA app's
 * service worker cached for hours, pinning the phone to an old version ("Configuration error").
 */

const VERSION = 27;
// Errors go to HA's system log, so they're visible server-side
// instead of only as an opaque "Configuration error" in someone's browser.
const report = (level, message) => {
  try {
    document.querySelector("home-assistant")?.hass?.callService("system_log", "write", {
      message: `evcc-price-card v${VERSION}: ${message}`,
      level,
      logger: "evcc_price_card",
    });
  } catch (_) {
    /* reporting must never break the card */
  }
};
window.addEventListener("error", (e) => {
  if (String(e.filename).includes("evcc-price-card")) report("error", `${e.message} @${e.lineno}:${e.colno}`);
});

const DEFAULTS = {
  title: "EV charging",
  forecast_entity: "sensor.evcc_price_forecast",
  plan_entity: "sensor.evcc_charge_plan",
  soc_entity: "sensor.evcc_vehicle_soc",
  mode_entity: "select.evcc_charge_mode",
  mode_sensor: "sensor.evcc_mode",
  power_entity: "sensor.evcc_charge_power",
  manual_entity: "input_boolean.evcc_manual",
  hours_entity: "input_text.evcc_manual_hours",
  solar_entity: "input_boolean.evcc_solar",
  solar_forecast_entity: "sensor.solar_forecast",
  solar_kwp: 4, // placeholder until the real panels are known
  base_load: 300, // shortcut: a flat house load; a learned profile would be better once there's history
};
const PERFORMANCE = 0.85; // inverter, heat and wiring losses: typical for a home system
// No Off button: Manual with no hours painted is off. While Manual is on, its button reads "Clear".
const MODES = [
  ["smart", "Smart"],
  ["solar", "Solar"],
  ["manual", "Manual"],
  ["now", "Fast"],
];
const LEGEND = { smart: "Planned charging", solar: "Charging from surplus", manual: "Your charging hours", now: "Charging until full" };
const HOUR = 3600e3;
const QUARTER = 900e3;
const SLOTS = 96; // quarters shown: 24 h starting with the current one
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
// Same unit and precision as HA's own price entity (EUR/kWh, 3 decimals), so the
// card never contradicts the price chip; axis labels drop to 2 decimals.
const eur = (v, digits = 3) => `€${v.toFixed(digits)}`;
const epochQuarter = (ms) => Math.floor(ms / QUARTER);

// Painted quarters as "<base>:<hex>": base = epoch quarter (unix time // 900) of the first
// bit, then one bit per quarter, most significant bit first in each hex digit. 24 hex
// digits cover the whole window, so it always fits input_text's 255 characters.
// The HA automation (packages/evcc.yaml) decodes the same format.
function parseQuarters(value) {
  const out = new Set();
  const m = /^(\d+):([0-9a-f]*)$/.exec(String(value || ""));
  if (!m) return out;
  [...m[2]].forEach((c, d) => {
    for (let b = 0; b < 4; b++) if (parseInt(c, 16) & (8 >> b)) out.add(+m[1] + d * 4 + b);
  });
  return out;
}
function encodeQuarters(sel, base) {
  const digits = Array(SLOTS / 4).fill(0);
  for (const q of sel) if (q >= base && q < base + SLOTS) digits[(q - base) >> 2] |= 8 >> ((q - base) & 3);
  const hex = digits.map((d) => d.toString(16)).join("").replace(/0+$/, "");
  return hex ? `${base}:${hex}` : "";
}

// Fixed window of the next SLOTS quarters. Each quarter takes the rate covering its start
// (also works for an hourly tariff); a quarter without a rate yet (tomorrow before ~13:00)
// gets value null. charging = any charge slot overlaps; frac = hours of it (from now on)
// spent charging, for the battery projection and the session cost.
function quarterly(rates, slots, now) {
  const nowMs = now.getTime();
  const first = epochQuarter(nowMs) * QUARTER; // quarters are UTC-aligned, as are DST shifts
  const spans = rates.map((r) => [new Date(r.start).getTime(), new Date(r.end).getTime(), r.value]);
  return Array.from({ length: SLOTS }, (_, i) => {
    const start = first + i * QUARTER, end = start + QUARTER;
    const rate = spans.find(([a, b]) => a <= start && start < b);
    const from = Math.max(start, nowMs);
    const ms = slots.reduce((t, [a, b]) => t + Math.max(0, Math.min(b, end) - Math.max(a, from)), 0);
    return {
      start,
      q: epochQuarter(start),
      value: rate ? rate[2] : null,
      charging: slots.some(([a, b]) => a < end && b > start),
      frac: ms / HOUR,
    };
  });
}

// "01:00–04:15, 13:30–14:00" from a set of epoch quarters
function ranges(quarters) {
  const out = [];
  for (const q of [...quarters].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last[1] === q) last[1] = q + 1;
    else out.push([q, q + 1]);
  }
  return out.map(([a, b]) => `${hhmm(new Date(a * QUARTER))}–${hhmm(new Date(b * QUARTER))}`).join(", ");
}

class EvccPriceCard extends HTMLElement {
  setConfig(config) {
    try {
      this._setConfig(config);
    } catch (e) {
      report("error", `setConfig: ${e.message}\n${e.stack}`);
      throw e;
    }
  }

  _setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Invalid configuration");
    this._config = { ...DEFAULTS, ...config };
    // HA calls setConfig more than once; a second attachShadow throws ("Configuration error").
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      // Delegated listeners: they survive re-renders, so a tap or drag mid-update isn't lost.
      const root = this.shadowRoot;
      root.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-mode]");
        if (b) this._setMode(b.dataset.mode);
        if (e.target.closest("button[data-action=clear]")) this._saveHours(new Set());
      });
      root.addEventListener("pointerdown", (e) => {
        this._hover(e);
        this._dragStart(e);
      });
      root.addEventListener("pointermove", (e) => {
        this._hover(e);
        this._dragMove(e);
      });
      // mouse leaving the card hides the readout; touch keeps it after a tap, so it can
      // be read without a finger on the screen
      this.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && this._hover(null));
      root.addEventListener("pointerup", () => this._dragEnd());
      root.addEventListener("pointercancel", () => this._dragEnd());
    }
    this._sig = null;
    if (this._hass) this._render();
  }

  // Draw the chart at the card's real pixel width so text and bars never stretch.
  connectedCallback() {
    this._ro = new ResizeObserver(() =>
      // next frame, not inside the observer: avoids the "ResizeObserver loop" error
      requestAnimationFrame(() => {
        const w = Math.round(this.getBoundingClientRect().width);
        if (w && w !== this._w) {
          this._w = w;
          this._sig = null;
          if (this._hass && !this._drag) this._render();
        }
      })
    );
    this._ro.observe(this);
  }

  disconnectedCallback() {
    this._ro?.disconnect();
  }

  getCardSize() {
    return 6;
  }

  getGridOptions() {
    return { columns: "full", min_rows: 6 };
  }

  _mode(hass = this._hass) {
    const c = this._config;
    if (hass.states[c.manual_entity]?.state === "on") return "manual";
    if (hass.states[c.solar_entity]?.state === "on") return "solar";
    return hass.states[c.mode_sensor]?.state;
  }

  set hass(hass) {
    this._hass = hass;
    const c = this._config;
    if (!c || !this.shadowRoot) return; // hass can arrive before setConfig
    // Optimistic values are dropped once HA confirms them, or after a 15 s grace.
    if (this._pending && (this._mode(hass) === this._pending.mode || Date.now() > this._pending.until)) {
      this._pending = null;
      this._sig = null;
    }
    if (this._hoursPending && ((hass.states[c.hours_entity]?.state ?? "") === this._hoursPending.value || Date.now() > this._hoursPending.until)) {
      this._hoursPending = null;
      this._sig = null;
    }
    if (this._drag) return; // never rebuild the chart under a finger
    // Re-render only when one of our entities changed.
    const sig = [c.forecast_entity, c.plan_entity, c.soc_entity, c.mode_sensor, c.power_entity, c.manual_entity, c.hours_entity, c.solar_entity, c.solar_forecast_entity]
      .map((e) => hass.states[e]?.last_updated)
      .join("|") + epochQuarter(Date.now());
    if (sig === this._sig) return;
    this._sig = sig;
    this._render();
  }

  // Optimistic: highlight the tapped mode at once; HA and evcc confirm within ~1 s.
  _setMode(mode) {
    const c = this._config;
    this._pending = { mode, until: Date.now() + 15000 };
    this._sig = null;
    this._render();
    const call = (domain, service, data) => this._hass.callService(domain, service, data);
    // Manual and Solar are HA toggles (their automations drive evcc); only one is ever on
    const toggle = (entity, on) =>
      (this._hass.states[entity]?.state === "on") === on ? Promise.resolve() : call("input_boolean", on ? "turn_on" : "turn_off", { entity_id: entity });
    const done = toggle(c.manual_entity, mode === "manual")
      .then(() => toggle(c.solar_entity, mode === "solar"))
      .then(() => (mode === "manual" || mode === "solar" ? null : call("select", "select_option", { entity_id: c.mode_entity, option: mode })));
    done.catch(() => {
      this._pending = null;
      this._sig = null;
      this.hass = this._hass; // snap back to the real mode
    });
  }

  _manualHours() {
    if (this._drag) return this._drag.sel;
    const value = this._hoursPending ? this._hoursPending.value : this._hass.states[this._config.hours_entity]?.state;
    return parseQuarters(value);
  }

  _saveHours(sel) {
    const value = encodeQuarters(sel, epochQuarter(Date.now()));
    this._hoursPending = { value, until: Date.now() + 15000 };
    this._sig = null;
    this._render();
    this._hass
      .callService("input_text", "set_value", { entity_id: this._config.hours_entity, value })
      .catch(() => {
        this._hoursPending = null;
        this._sig = null;
        this._render();
      });
  }

  // Readout for the quarter under the pointer: column highlight plus time and price,
  // drawn in place (no re-render) so it tracks the pointer and works mid-drag.
  _hover(e) {
    const svg = this.shadowRoot.querySelector("svg.chart");
    const tip = svg?.querySelector(".tip");
    if (!tip) return;
    const i = e && svg.contains(e.target) ? this._barAt(svg, e.clientX) : null;
    if (i === this._hoverI) return;
    svg.querySelector(".bar.hover")?.classList.remove("hover");
    this._hoverI = i;
    if (i === null) return tip.setAttribute("visibility", "hidden");
    const g = this._geo, it = g.items[i];
    svg.querySelector(`[data-i="${i}"]`)?.classList.add("hover");
    const cx = g.left + (i + 0.5) * g.bw;
    const charging = svg.querySelector(`[data-i="${i}"]`)?.classList.contains("charging");
    const sun = g.solar && it.pv >= 50 ? `  · sun ${(it.pv / 1000).toFixed(1)} kW` : "";
    const text = `${hhmm(new Date(it.start))}–${hhmm(new Date(it.start + QUARTER))}  ${it.value === null ? "not published yet" : `${eur(it.value)}/kWh`}${sun}${charging ? "  · charging" : ""}`;
    const label = tip.querySelector("text");
    label.textContent = text;
    // anchor toward the middle so the label never runs off either edge
    const right = cx > (g.left + g.plotR) / 2;
    label.setAttribute("x", right ? Math.min(cx + 6, g.plotR) : Math.max(cx - 6, g.left));
    label.setAttribute("text-anchor", right ? "end" : "start");
    tip.querySelector("line").setAttribute("x1", cx);
    tip.querySelector("line").setAttribute("x2", cx);
    tip.setAttribute("visibility", "visible");
  }

  // --- painting hours in Manual mode -------------------------------------------
  _barAt(svg, clientX) {
    const g = this._geo;
    if (!g) return null;
    const x = clientX - svg.getBoundingClientRect().left - g.left;
    return Math.min(Math.max(Math.floor(x / g.bw), 0), g.keys.length - 1);
  }

  _dragStart(e) {
    const svg = e.target.closest?.("svg.editable");
    if (!svg || e.button > 0) return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    const i = this._barAt(svg, e.clientX);
    const sel = new Set(this._manualHours());
    // starting on a painted quarter erases, on an empty one paints
    this._drag = { svg, sel, paint: !sel.has(this._geo.keys[i]), last: i };
    this._paint(i, i);
  }

  _dragMove(e) {
    if (!this._drag) return;
    const i = this._barAt(this._drag.svg, e.clientX);
    if (i === this._drag.last) return;
    this._paint(this._drag.last, i); // fill the bars a fast swipe skipped
    this._drag.last = i;
  }

  _dragEnd() {
    if (!this._drag) return;
    const { sel } = this._drag;
    this._drag = null;
    this._saveHours(sel);
  }

  _paint(from, to) {
    const { svg, sel, paint } = this._drag;
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
      const q = this._geo.keys[i];
      if (paint) sel.add(q);
      else sel.delete(q);
      svg.querySelector(`[data-i="${i}"]`)?.classList.toggle("charging", paint);
    }
  }

  // --- which hours charge, per mode --------------------------------------------
  _slots(st, now) {
    // actually drawing power (e.g. evcc's 3-min wind-down after leaving Fast): this quarter charges, whatever the mode says
    const live = st.power > 0 ? [[now.getTime(), now.getTime() + 60e3]] : [];
    return [...live, ...this._modeSlots(st, now)];
  }

  _modeSlots(st, now) {
    if (st.mode === "manual") return [...st.manual].map((q) => [q * QUARTER, (q + 1) * QUARTER]);
    if (st.mode === "smart") return (st.plan || []).map((p) => [new Date(p.start).getTime(), new Date(p.end).getTime()]);
    if (st.mode === "now" && st.soc < (st.limit || 100)) {
      const hours = st.remainingWh && st.maxPower ? st.remainingWh / st.maxPower : 1;
      return [[now.getTime(), now.getTime() + hours * HOUR]];
    }
    return [];
  }

  _status(st, slots) {
    const text = this._modeStatus(st, slots);
    // a phase change waits for the car to be unplugged (see automation evcc_solar)
    const want = st.mode === "solar" ? 1 : 3;
    if (st.connected && st.phasesConfigured !== null && st.phasesConfigured !== want) return `${text}. ${want === 1 ? "1 phase" : "3 phases"} after you unplug`;
    return text;
  }

  _modeStatus(st, slots) {
    const { soc, mode, power, planSoc, planTime, plan } = st;
    const kw = power > 0 ? `charging at ${(power / 1000).toFixed(1)} kW` : "";
    if (st.connected === false) return mode === "solar" ? "Solar: not plugged in, charges on 1 phase from surplus" : "Car not plugged in";
    if (mode === "off") return "Off, not charging";
    if (mode === "manual") {
      if (!st.manual.size) return "Manual: no hours set, so the car stays off";
      return `Manual${kw ? `, ${kw}` : ""}: ${ranges(st.manual)}`;
    }
    if (soc >= 100) return "Car is full";
    if (mode === "solar") {
      if (kw) return `Solar, ${kw} from surplus`;
      return st.solarNext ? `Solar: waiting for surplus, expected from ${hhmm(new Date(st.solarNext))}` : "Solar: no surplus expected in the next 24 h";
    }
    if (mode === "now") {
      if (!kw) return "Fast: waiting for the car";
      const full = slots[slots.length - 1]; // the mode projection comes after the live slot
      return full && full[1] - full[0] > 60e3 ? `Fast, ${kw}, full around ${hhmm(new Date(full[1]))}` : `Fast, ${kw}`;
    }
    // Smart: the plan comes first; live charging (surplus, or evcc's 3-min wind-down after
    // leaving Fast) is added, so a charging car never hides why no quarters are planned
    const live = kw ? `. Now ${kw}` : "";
    if (!planTime) return kw ? `Smart, ${kw} from surplus` : "Smart: solar surplus only, no plan set";
    const t = hhmm(planTime);
    if (!plan?.length) {
      return (st.knownUntil && st.knownUntil < planTime
        ? `Plan ${planSoc}% by ${t}, waiting for tomorrow's prices (~13:00)`
        : `Plan ${planSoc}% by ${t}, already reached`) + live;
    }
    const first = new Date(Math.min(...plan.map((p) => new Date(p.start).getTime())));
    return `Plan ${planSoc}% by ${t}, charges from ${hhmm(first)}${live}`;
  }

  _chart(hours, editable, st) {
    const known = hours.filter((h) => h.value !== null);
    // Two panels in one SVG so the quarter columns line up exactly:
    //   battery %   socTop..socBot   (short)
    //   prices      pTop..H-bottom   (bars)
    // 40 = card padding; left gutter carries both axes' labels.
    const W = Math.max((this._w || 720) - 40, 240), left = 40, right = 6, bottom = 22;
    const socTop = 10, socBot = 62, pTop = socBot + 36, H = pTop + 134 + bottom;
    const plotR = W - right;
    const vals = known.length ? known.map((h) => h.value) : [0.3];
    const max = Math.max(...vals), min = Math.min(0, ...vals);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const span = max - min || 1;
    const bw = (plotR - left) / hours.length;
    const y = (v) => pTop + (H - pTop - bottom) * (1 - (v - min) / span);
    const ySoc = (p) => socBot - (socBot - socTop) * (p / 100);
    const solar = st.mode === "solar" && hours.some((h) => h.pv !== null);
    const pv = solar ? this._pvArea(hours, left, bw, pTop, H - bottom) : { fill: "", line: "" };
    this._geo = { left, bw, plotR, keys: hours.map((h) => h.q), items: hours, solar };
    this._hoverI = null;
    // gaps shrink with the bars: ~9 px bars on desktop, ~3 px on a phone
    const gap = Math.min(1.5, bw * 0.25);
    const bars = hours
      .map((h, i) => {
        const x = left + i * bw + gap / 2, w = Math.max(bw - gap, 0.5);
        const d = new Date(h.start);
        const label = d.getMinutes() === 0 && d.getHours() % 3 === 0
          ? `<text class="x" x="${x + w / 2}" y="${H - 6}">${d.getHours() === 0 ? d.toLocaleDateString(undefined, { weekday: "short" }) : pad(d.getHours())}</text>`
          : "";
        const cls = ["bar", h.value === null && "unknown", h.charging && "charging"].filter(Boolean).join(" ");
        // price not published yet: placeholder at the average height
        const v = h.value ?? avg;
        const y0 = y(Math.max(v, 0)), y1 = y(Math.min(v, 0));
        // full-height hit area per quarter (both panels), so short bars are as easy to paint as tall ones
        const hit = editable ? `<rect class="hit" x="${left + i * bw}" y="${socTop - 6}" width="${bw}" height="${H - bottom - socTop + 6}"/>` : "";
        return `${hit}<rect data-i="${i}" class="${cls}" x="${x}" y="${y0}" width="${w}" height="${Math.max(y1 - y0, 1)}" rx="${Math.min(2, w / 3)}"/>${label}`;
      })
      .join("");
    const firstUnknown = hours.findIndex((h) => h.value === null);
    // no prices at all = evcc hasn't delivered any (e.g. just restarted); otherwise tomorrow's are pending
    const unknownNote = firstUnknown >= 0
      ? `<text class="note" x="${left + ((firstUnknown + hours.length) / 2) * bw}" y="${(y(avg) + y(0)) / 2 + 4}">${firstUnknown === 0 ? "no prices from evcc yet" : "published ~13:00"}</text>` : "";
    const nowX = left + ((Date.now() % QUARTER) / QUARTER) * bw;
    // hairline grids: prices at max, half and zero (plus the minimum when negative); battery at 0/50/100%
    const ticks = [...new Set([max, max / 2, 0, min].map((v) => +v.toFixed(4)))];
    const grid = ticks
      .map((v) => `<line class="${v === 0 ? "base" : "grid"}" x1="${left}" x2="${plotR}" y1="${y(v)}" y2="${y(v)}"/><text class="y" x="${left - 8}" y="${y(v) + 4}">${eur(v, 2)}</text>`)
      .join("");
    const socGrid = [100, 50, 0]
      .map((p) => `<line class="${p === 0 ? "base" : "grid"}" x1="${left}" x2="${plotR}" y1="${ySoc(p)}" y2="${ySoc(p)}"/>${p === 50 ? "" : `<text class="y" x="${left - 8}" y="${ySoc(p) + 4}">${p}%</text>`}`)
      .join("");
    return `
      <svg class="chart${editable ? " editable" : ""}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${editable ? "Drag across the hours the car should charge" : "Expected battery level and electricity prices for the next 24 hours"}">
        ${socGrid}${grid}${pv.fill}${bars}${pv.line}
        ${this._socLine(hours, st, nowX, left, bw, ySoc, socBot, plotR)}
        ${unknownNote}
        <g class="tip" visibility="hidden">
          <line y1="${pTop - 4}" y2="${H - bottom}"/>
          <text y="${socBot + 22}"></text>
        </g>
      </svg>`;
  }

  // Expected panel output on its own scale (the panels' realistic peak, kWp x losses, reaches
  // the top of the price panel): a soft fill behind the bars, its outline on top of them.
  _pvArea(hours, left, bw, top, base) {
    const peak = Math.max(this._config.solar_kwp * 1000 * PERFORMANCE, ...hours.map((h) => h.pv ?? 0));
    const yv = (w) => base - (base - top) * (w / peak);
    const pts = hours.map((h, i) => `L${(left + (i + 0.5) * bw).toFixed(1)},${yv(h.pv ?? 0).toFixed(1)}`).join("");
    const x0 = left + 0.5 * bw, x1 = (left + (hours.length - 0.5) * bw).toFixed(1);
    return { fill: `<path class="pv" d="M${x0},${base}${pts}L${x1},${base}Z"/>`, line: `<path class="pv-line" d="M${pts.slice(1)}"/>` };
  }

  // Expected battery %: starts at the car's SoC now and rises through each charging
  // hour at the max charge power, using evcc's own Wh-per-percent (losses included).
  _socLine(hours, st, nowX, left, bw, ySoc, socBot, plotR) {
    if (isNaN(st.soc)) return "";
    let soc = Math.min(st.soc, 100);
    const pts = [[nowX, soc]];
    hours.forEach((h, i) => {
      soc += h.wh / st.whPerPct;
      pts.push([left + (i + 1) * bw, soc]);
    });
    const line = pts.map(([x, p], i) => `${i ? "L" : "M"}${x.toFixed(1)},${ySoc(p).toFixed(1)}`).join("");
    const area = `${line}L${pts[pts.length - 1][0].toFixed(1)},${socBot}L${nowX.toFixed(1)},${socBot}Z`;
    const [sx, sp] = pts[0], [ex, ep] = pts[pts.length - 1];
    // target of Smart's plan as a dashed oak line
    const target = st.mode === "smart" && st.planSoc
      ? `<line class="soc-target" x1="${left}" x2="${plotR}" y1="${ySoc(st.planSoc)}" y2="${ySoc(st.planSoc)}"/>
         <text class="soc-target-label" x="${plotR - 2}" y="${ySoc(st.planSoc) - 4}">target ${st.planSoc}%</text>`
      : "";
    // start label sits above the dot; the end label only when the line actually moved
    // above the line, except near the top where it would sit on the 100% grid line
    const labelY = (p) => (p > 85 ? ySoc(p) + 13 : ySoc(p) - 6);
    const startLabel = `<text class="soc-now" x="${sx + 6}" y="${labelY(sp)}">${Math.round(sp)}%</text>`;
    const endLabel = ep - sp >= 3 ? `<text class="soc-end" x="${Math.min(ex, plotR) - 2}" y="${labelY(ep)}">${Math.round(ep)}%</text>` : "";
    return `<path class="soc-area" d="${area}"/>${target}<path class="soc-line" d="${line}"/>
      <circle class="soc-dot" cx="${sx}" cy="${ySoc(sp)}" r="3"/>${startLabel}${endLabel}`;
  }

  // Cost of the charging hours selected in the graph (plan, painted hours or Fast's
  // run to full) at the hourly prices; hours without a published price are left out.
  _session(hours, mode) {
    const charged = hours.filter((h) => h.wh > 0);
    const kwh = charged.reduce((t, h) => t + h.wh, 0) / 1000;
    if (kwh < 0.05) return "";
    // own surplus isn't bought at the grid price, so no euro figure for it
    if (mode === "solar") return `<div class="session"><b>${kwh.toFixed(1)} kWh</b><span>from your own surplus</span></div>`;
    const priced = charged.filter((h) => h.value !== null);
    const pkwh = priced.reduce((t, h) => t + h.wh, 0) / 1000;
    const cost = priced.reduce((t, h) => t + (h.wh / 1000) * h.value, 0);
    const sub = priced.length < charged.length
      ? `${kwh.toFixed(1)} kWh, ${pkwh ? `${pkwh.toFixed(1)} priced so far` : "prices not published yet"}`
      : `${kwh.toFixed(1)} kWh at ${eur(cost / kwh)}/kWh`;
    return `<div class="session" title="Cost of the charging hours in the graph"><b>${pkwh ? eur(cost, 2) : "–"}</b><span>${sub}</span></div>`;
  }

  // Expected panel output in W per quarter start (ms). Open-Meteo's radiation is the mean of
  // the preceding 15 min, so the value stamped T belongs to the quarter starting at T - 15 min.
  _solarForecast() {
    const a = this._hass.states[this._config.solar_forecast_entity]?.attributes;
    const out = new Map();
    if (!a?.time || !a?.global_tilted_irradiance) return out;
    a.time.forEach((t, i) => out.set(Date.parse(`${t}Z`) - QUARTER, (a.global_tilted_irradiance[i] || 0) * this._config.solar_kwp * PERFORMANCE));
    return out;
  }

  // A render failure shows inside the card (and in HA's log) instead of taking it down.
  _render() {
    try {
      this._draw();
    } catch (e) {
      report("error", `render: ${e.message}\n${e.stack}`);
      this.shadowRoot.innerHTML = `<ha-card style="padding:16px">evcc price card error: ${e.message}</ha-card>`;
    }
  }

  _draw() {
    const c = this._config, s = this._hass.states;
    const soc = Number(s[c.soc_entity]?.state);
    const socAttr = s[c.soc_entity]?.attributes || {};
    const planTime = socAttr.effectivePlanTime ? new Date(socAttr.effectivePlanTime) : null;
    const rates = s[c.forecast_entity]?.attributes?.rates || [];
    const st = {
      soc,
      mode: this._pending?.mode ?? this._mode(),
      manual: this._manualHours(),
      knownUntil: rates.length ? new Date(rates[rates.length - 1].end) : null,
      power: Number(s[c.power_entity]?.state) || 0,
      maxPower: Number(s[c.plan_entity]?.attributes?.power) || 0,
      remainingWh: Number(socAttr.chargeRemainingEnergy) || 0,
      connected: socAttr.connected,
      phasesConfigured: socAttr.phasesConfigured ?? null, // 0 = automatic: switches mid-session
      limit: Number(socAttr.effectiveLimitSoc) || 100,
      planSoc: socAttr.effectivePlanSoc,
      planTime,
      plan: s[c.plan_entity]?.attributes?.plan,
    };
    // Wh per battery % from evcc's own remaining-energy estimate (charging losses included)
    st.whPerPct = st.remainingWh && st.limit > st.soc ? st.remainingWh / (st.limit - st.soc) : 650;
    if (!st.maxPower) st.maxPower = 11040;
    // on 1 phase the car gets a third of the power (230 V x max current)
    if (Number(socAttr.phasesActive) === 1) st.maxPower = 230 * (Number(socAttr.maxCurrent) || 16);
    const now = new Date();
    const slots = this._slots(st, now);
    const hours = quarterly(rates, slots, now);
    const pv = this._solarForecast();
    for (const h of hours) h.pv = pv.get(h.start) ?? null;
    // Solar: forecast surplus (panels minus the house's base load) charges on 1 phase between
    // the min and max current; below the minimum the car waits. Same projection as the other modes.
    if (st.mode === "solar") {
      const minW = 230 * (Number(socAttr.minCurrent) || 6), maxW = 230 * (Number(socAttr.maxCurrent) || 16);
      for (const h of hours) {
        const surplus = (h.pv ?? 0) - c.base_load;
        const w = surplus >= minW ? Math.min(surplus, maxW) : 0;
        if (!w) continue;
        h.charging = true;
        h.frac = Math.max(h.frac, ((h.start + QUARTER - Math.max(h.start, now.getTime())) / HOUR) * (w / st.maxPower));
      }
      st.solarNext = hours.find((h) => h.charging && h.start > now.getTime())?.start;
    }
    // Wh charged per quarter at max power until the car reaches its limit; feeds the
    // battery line and the session price, so the two always agree
    let room = isNaN(soc) ? Infinity : Math.max((Math.max(st.limit, soc) - soc) * st.whPerPct, 0);
    for (const h of hours) {
      h.wh = Math.min(h.frac * st.maxPower, room);
      room -= h.wh;
    }
    const session = this._session(hours, st.mode);
    const editable = st.mode === "manual";
    const hasUnknown = hours.some((h) => h.value === null);
    const hint = editable
      ? "Drag across the hours the car should charge. Clear removes them: no hours means off."
      : "Smart follows the plan. Solar: own surplus only, 1 phase. Manual: paint the hours yourself. Fast: full power now.";

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; --accent: var(--accent-color); --ink: var(--primary-text-color); --muted: var(--secondary-text-color);
                --bar: color-mix(in srgb, var(--muted) 32%, transparent); font-variant-numeric: tabular-nums; }
        ha-card { padding: 20px; }
        .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
        .title { font-size: 16px; font-weight: 500; color: var(--ink); line-height: 1.3; }
        .status { font-size: 13px; color: var(--muted); margin-top: 2px; line-height: 1.4; text-wrap: pretty; }
        .session { text-align: right; flex: none; }
        .session b { font-size: 26px; font-weight: 400; color: var(--ink); line-height: 1.1; letter-spacing: -0.01em; }
        .session span { display: block; font-size: 12px; color: var(--muted); margin-top: 2px; }
        svg { width: 100%; height: auto; display: block; margin-top: 18px; overflow: visible; }
        svg.editable { touch-action: none; cursor: pointer; user-select: none; -webkit-user-select: none; }
        .hit { fill: transparent; }
        .bar { fill: var(--bar); transition: fill 120ms; }
        .bar.unknown { fill: color-mix(in srgb, var(--muted) 12%, transparent); }
        .bar.charging { fill: var(--accent); stroke: none; }
        .bar.unknown.charging { fill: color-mix(in srgb, var(--accent) 55%, transparent); }
        svg.editable .bar { pointer-events: none; }
        svg.editable .hit:hover + .bar:not(.charging) { fill: color-mix(in srgb, var(--accent) 30%, transparent); }
        .grid { stroke: var(--divider-color); stroke-dasharray: 1 3; }
        .base { stroke: var(--divider-color); }
        .x, .y, .note { font-size: 11px; fill: var(--muted); pointer-events: none; }
        .note { paint-order: stroke; stroke: var(--ha-card-background, var(--card-background-color)); stroke-width: 4px; stroke-linejoin: round; }
        .x, .note { text-anchor: middle; }
        .y { text-anchor: end; }
        .soc-line { fill: none; stroke: var(--ink); stroke-width: 1.5; stroke-linejoin: round; pointer-events: none; }
        .soc-dot { fill: var(--ink); pointer-events: none; }
        .soc-area { fill: color-mix(in srgb, var(--ink) 7%, transparent); stroke: none; pointer-events: none; }
        .soc-target { stroke: var(--accent); stroke-width: 1; stroke-dasharray: 4 3; pointer-events: none; }
        .soc-target-label { font-size: 11px; fill: var(--accent); text-anchor: end; pointer-events: none; }
        .soc-now { font-size: 11px; font-weight: 500; fill: var(--ink); pointer-events: none;
                   paint-order: stroke; stroke: var(--ha-card-background, var(--card-background-color)); stroke-width: 4px; stroke-linejoin: round; }
        .bar.hover { fill: color-mix(in srgb, var(--ink) 45%, transparent); }
        .bar.charging.hover { fill: color-mix(in srgb, var(--accent) 80%, var(--ink)); }
        .tip line { stroke: var(--ink); stroke-width: 1; stroke-dasharray: 2 2; opacity: 0.5; }
        .tip text { font-size: 12px; font-weight: 500; fill: var(--ink); pointer-events: none;
                    paint-order: stroke; stroke: var(--ha-card-background, var(--card-background-color)); stroke-width: 4px; stroke-linejoin: round; }
        .tip { pointer-events: none; }
        .soc-end { font-size: 11px; font-weight: 500; fill: var(--ink); text-anchor: end; pointer-events: none;
                   paint-order: stroke; stroke: var(--ha-card-background, var(--card-background-color)); stroke-width: 4px; stroke-linejoin: round; }
        .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--muted); margin-top: 8px; }
        .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
        .legend i.line { height: 2px; width: 14px; border-radius: 1px; background: var(--ink); vertical-align: 3px; }
        .legend i.sun { background: color-mix(in srgb, var(--warning-color, #d9a400) 45%, transparent); }
        .pv { fill: color-mix(in srgb, var(--warning-color, #d9a400) 20%, transparent); stroke: none; pointer-events: none; }
        .pv-line { fill: none; stroke: var(--warning-color, #d9a400); stroke-width: 1.5; stroke-linejoin: round; pointer-events: none; }
        .legend i.unknown { background: color-mix(in srgb, var(--muted) 12%, transparent); }
        .modes { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-top: 20px;
                 background: var(--secondary-background-color); border-radius: calc(var(--ha-card-border-radius, 12px) * 0.7); padding: 4px; }
        .modes button { font: inherit; font-size: 14px; font-weight: 500; border: 0; background: none; color: var(--ink); min-height: 44px; padding: 0 4px;
                        border-radius: calc(var(--ha-card-border-radius, 12px) * 0.55); cursor: pointer;
                        transition: background-color 140ms cubic-bezier(0.16, 1, 0.3, 1), color 140ms, transform 90ms;
                        -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
        .modes button:hover:not(.on) { background: color-mix(in srgb, var(--ink) 7%, transparent); }
        .modes button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        .modes button:active { transform: scale(0.97); }
        .modes button.on { background: var(--primary-color); color: var(--text-primary-color); }
        .modes button.busy { animation: busy 900ms ease-in-out infinite alternate; }
        @keyframes busy { to { opacity: 0.65; } }
        @media (prefers-reduced-motion: reduce) { .modes button, .bar { transition: none; } .modes button.busy { animation: none; } }
        .foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
        .hint { font-size: 12px; color: var(--muted); line-height: 1.4; }
        .modes button.on:disabled { opacity: 0.55; cursor: default; }
      </style>
      <ha-card>
        <div class="head">
          <div>
            <div class="title">${c.title}</div>
            <div class="status">${this._status(st, slots)}</div>
          </div>
          ${session}
        </div>
        ${this._chart(hours, editable, st)}
        <div class="legend">
          ${LEGEND[st.mode] ? `<span><i style="background: var(--accent)"></i>${LEGEND[st.mode]}</span>` : ""}
          <span><i style="background: var(--bar)"></i>Price per 15 min</span>
          ${st.mode === "solar" && pv.size ? `<span><i class="sun"></i>Expected solar (${c.solar_kwp} kWp)</span>` : ""}
          ${isNaN(soc) ? "" : `<span><i class="line"></i>Expected battery</span>`}
          ${hasUnknown ? `<span><i class="unknown"></i>Not published yet</span>` : ""}
        </div>
        <div class="modes" role="group" aria-label="Charging mode">
          ${MODES.map(([m, label]) => {
            const on = st.mode === m, busy = this._pending?.mode === m ? " busy" : "";
            // selected Manual turns into Clear; with nothing painted there is nothing to clear
            if (m === "manual" && on) {
              return `<button data-action="clear" class="on${busy}" aria-label="Clear charging hours" ${st.manual.size ? "" : "disabled"}>Clear</button>`;
            }
            return `<button data-mode="${m}" aria-pressed="${on}" class="${on ? "on" : ""}${busy}">${label}</button>`;
          }).join("")}
        </div>
        <div class="foot">
          <div class="hint">${hint}</div>
        </div>
      </ha-card>`;
  }
}

// HA (2026.3) replaces window.customElements with a scoped-registry polyfill during
// boot. Loaded early (formerly via extra_module_url, or from cache), this file can run
// *before* that swap, landing the card in the native registry, which HA never reads
// ("Custom element doesn't exist" for good). So wait for HA's registry, then define.
// shortcut: 10 s fallback defines in whatever registry exists, in case HA drops the polyfill.
const register = () => {
  if (!window.customElements.get("evcc-price-card")) window.customElements.define("evcc-price-card", EvccPriceCard);
};
const isNative = () => String(window.customElements.define).includes("[native code]");
const t0 = Date.now();
(function waitForHaRegistry() {
  if (!isNative() || Date.now() - t0 > 10000) register();
  else setTimeout(waitForHaRegistry, 50);
})();
window.customCards = window.customCards || [];
window.customCards.push({ type: "evcc-price-card", name: "evcc price card", description: "Prices with the hours the car charges" });
