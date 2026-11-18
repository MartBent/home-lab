/*
 * evcc price card: the next 24 h of grid prices with the hours the car will charge,
 * plus Off / Smart / Manual / Fast.
 *   Smart   evcc's plan picks the hours (oak bars)
 *   Manual  drag across the bars to paint the hours yourself; Clear = stay off.
 *           An HA automation (packages/evcc.yaml) runs evcc "now" inside them, "off" outside.
 *   Fast    charge now at full power; the bars show the projection until full
 *
 * Reads only HA entities (the browser can't reach evcc through the tunnel):
 *   forecast_entity  attributes.rates  [{start, end, value}]  (sensor.evcc_price_forecast)
 *   plan_entity      attributes.plan / .power                  (sensor.evcc_charge_plan)
 *   soc_entity       state + effectivePlanSoc / effectivePlanTime / chargeRemainingEnergy
 *   mode_entity      select with options off / smart / now
 *   power_entity     charge power in W
 *   manual_entity    input_boolean: Manual mode on/off
 *   hours_entity     input_text: painted hours as epoch hours (unix time // 3600), comma separated
 * Colours come from the active theme; charging hours use the oak accent.
 *
 * Deploy: copy to <config>/www/evcc-price-card.js and load it via
 *   frontend: extra_module_url: [/local/evcc-price-card.js?v=10]
 */

const VERSION = 10;
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
  power_entity: "sensor.evcc_charge_power",
  manual_entity: "input_boolean.evcc_manual",
  hours_entity: "input_text.evcc_manual_hours",
};
const MODES = [
  ["off", "Off"],
  ["smart", "Smart"],
  ["manual", "Manual"],
  ["now", "Fast"],
];
const LEGEND = { smart: "Planned charging", manual: "Your charging hours", now: "Charging until full" };
const HOUR = 3600e3;
const AHEAD = 24; // hours shown, starting with the current one
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
// Same unit and precision as HA's own price entity (EUR/kWh, 3 decimals), so the
// card never contradicts the price chip; axis labels drop to 2 decimals.
const eur = (v, digits = 3) => `€${v.toFixed(digits)}`;
const epochHour = (ms) => Math.round(ms / HOUR);
const parseHours = (s) => new Set(String(s || "").split(",").filter((x) => /^\d+$/.test(x)).map(Number));

// Fixed window of the next AHEAD hours. 15-min rates are averaged per hour; an hour
// without rates yet (tomorrow before ~13:00) gets value null. charging = any slot overlaps.
function hourly(rates, slots, now) {
  const sums = new Map();
  for (const r of rates) {
    const s = new Date(r.start);
    const key = new Date(s.getFullYear(), s.getMonth(), s.getDate(), s.getHours()).getTime();
    const h = sums.get(key) || { sum: 0, n: 0 };
    h.sum += r.value;
    h.n += 1;
    sums.set(key, h);
  }
  return Array.from({ length: AHEAD }, (_, i) => {
    // Date() arithmetic on the hour field keeps DST changes right
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + i).getTime();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + i + 1).getTime();
    const s = sums.get(start);
    return {
      start,
      hour: epochHour(start),
      value: s ? s.sum / s.n : null,
      charging: slots.some(([a, b]) => a < end && b > start),
      current: i === 0,
    };
  });
}

// "01:00–04:00, 13:00–14:00" from a set of epoch hours
function ranges(hours) {
  const sorted = [...hours].sort((a, b) => a - b);
  const out = [];
  for (const h of sorted) {
    const last = out[out.length - 1];
    if (last && last[1] === h) last[1] = h + 1;
    else out.push([h, h + 1]);
  }
  return out.map(([a, b]) => `${hhmm(new Date(a * HOUR))}–${hhmm(new Date(b * HOUR))}`).join(", ");
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
      root.addEventListener("pointerdown", (e) => this._dragStart(e));
      root.addEventListener("pointermove", (e) => this._dragMove(e));
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
    return hass.states[c.manual_entity]?.state === "on" ? "manual" : hass.states[c.mode_entity]?.state;
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
    const sig = [c.forecast_entity, c.plan_entity, c.soc_entity, c.mode_entity, c.power_entity, c.manual_entity, c.hours_entity]
      .map((e) => hass.states[e]?.last_updated)
      .join("|") + new Date().getHours();
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
    const manualOn = this._hass.states[c.manual_entity]?.state === "on";
    const call = (domain, service, data) => this._hass.callService(domain, service, data);
    const done =
      mode === "manual"
        ? call("input_boolean", "turn_on", { entity_id: c.manual_entity })
        : (manualOn ? call("input_boolean", "turn_off", { entity_id: c.manual_entity }) : Promise.resolve())
            .then(() => call("select", "select_option", { entity_id: c.mode_entity, option: mode }));
    done.catch(() => {
      this._pending = null;
      this._sig = null;
      this.hass = this._hass; // snap back to the real mode
    });
  }

  _manualHours() {
    if (this._drag) return this._drag.sel;
    const value = this._hoursPending ? this._hoursPending.value : this._hass.states[this._config.hours_entity]?.state;
    return parseHours(value);
  }

  _saveHours(sel) {
    const nowHour = epochHour(new Date(new Date().setMinutes(0, 0, 0)).getTime());
    const value = [...sel].filter((h) => h >= nowHour).sort((a, b) => a - b).join(",");
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

  // --- painting hours in Manual mode -------------------------------------------
  _barAt(svg, clientX) {
    const g = this._geo;
    if (!g) return null;
    const x = clientX - svg.getBoundingClientRect().left - g.left;
    return Math.min(Math.max(Math.floor(x / g.bw), 0), g.hours.length - 1);
  }

  _dragStart(e) {
    const svg = e.target.closest?.("svg.editable");
    if (!svg || e.button > 0) return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    const i = this._barAt(svg, e.clientX);
    const sel = new Set(this._manualHours());
    // starting on a painted hour erases, on an empty one paints
    this._drag = { svg, sel, paint: !sel.has(this._geo.hours[i]), last: i };
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
      const h = this._geo.hours[i];
      if (paint) sel.add(h);
      else sel.delete(h);
      svg.querySelector(`[data-i="${i}"]`)?.classList.toggle("charging", paint);
    }
  }

  // --- which hours charge, per mode --------------------------------------------
  _slots(st, now) {
    // actually drawing power (e.g. evcc's 3-min wind-down after leaving Fast): this hour charges, whatever the mode says
    const live = st.power > 0 ? [[now.getTime(), now.getTime() + 60e3]] : [];
    return [...live, ...this._modeSlots(st, now)];
  }

  _modeSlots(st, now) {
    if (st.mode === "manual") return [...st.manual].map((h) => [h * HOUR, (h + 1) * HOUR]);
    if (st.mode === "smart") return (st.plan || []).map((p) => [new Date(p.start).getTime(), new Date(p.end).getTime()]);
    if (st.mode === "now" && st.soc < (st.limit || 100)) {
      const hours = st.remainingWh && st.maxPower ? st.remainingWh / st.maxPower : 1;
      return [[now.getTime(), now.getTime() + hours * HOUR]];
    }
    return [];
  }

  _status(st, slots) {
    const { soc, mode, power, planSoc, planTime, plan } = st;
    const kw = power > 0 ? `charging at ${(power / 1000).toFixed(1)} kW` : "";
    if (mode === "off") return "Off, not charging";
    if (mode === "manual") {
      if (!st.manual.size) return "Manual: no hours set, so the car stays off";
      return `Manual${kw ? `, ${kw}` : ""}: ${ranges(st.manual)}`;
    }
    if (soc >= 100) return "Car is full";
    if (mode === "now") {
      if (!kw) return "Fast: waiting for the car";
      const full = slots[slots.length - 1]; // the mode projection comes after the live slot
      return full && full[1] - full[0] > 60e3 ? `Fast, ${kw}, full around ${hhmm(new Date(full[1]))}` : `Fast, ${kw}`;
    }
    if (kw) return kw[0].toUpperCase() + kw.slice(1);
    if (!planTime) return "Smart: solar surplus only, no plan set";
    const t = hhmm(planTime);
    if (!plan?.length) {
      return st.knownUntil && st.knownUntil < planTime
        ? `Plan ${planSoc}% by ${t}, waiting for tomorrow's prices (~13:00)`
        : `Plan ${planSoc}% by ${t}, already reached`;
    }
    const first = new Date(Math.min(...plan.map((p) => new Date(p.start).getTime())));
    return `Plan ${planSoc}% by ${t}, charges from ${hhmm(first)}`;
  }

  _chart(hours, editable) {
    const known = hours.filter((h) => h.value !== null);
    if (!known.length && !editable) return `<div class="empty">No price forecast yet</div>`;
    const W = Math.max((this._w || 720) - 40, 240), H = 172, top = 16, bottom = 22, left = 40; // 40 = card padding
    const vals = known.length ? known.map((h) => h.value) : [0.3];
    const max = Math.max(...vals), min = Math.min(0, ...vals);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const span = max - min || 1;
    const bw = (W - left) / hours.length;
    const y = (v) => top + (H - top - bottom) * (1 - (v - min) / span);
    this._geo = { left, bw, hours: hours.map((h) => h.hour) };
    const bars = hours
      .map((h, i) => {
        const x = left + i * bw + 1.5, w = Math.max(bw - 3, 1);
        const d = new Date(h.start);
        const label = d.getHours() % 3 === 0
          ? `<text class="x" x="${x + w / 2}" y="${H - 6}">${d.getHours() === 0 ? d.toLocaleDateString(undefined, { weekday: "short" }) : pad(d.getHours())}</text>`
          : "";
        const cls = ["bar", h.value === null && "unknown", h.charging && "charging", h.current && "current"].filter(Boolean).join(" ");
        // price not published yet: placeholder at the average height
        const v = h.value ?? avg;
        const y0 = y(Math.max(v, 0)), y1 = y(Math.min(v, 0));
        const price = h.value === null ? "price not published yet" : `${eur(h.value)}/kWh`;
        const tip = `<title>${hhmm(d)}  ${price}${h.charging ? "  · charging" : ""}</title>`;
        // full-height hit area per hour, so short bars are as easy to paint as tall ones
        const hit = editable ? `<rect class="hit" x="${left + i * bw}" y="${top - 8}" width="${bw}" height="${H - bottom - top + 8}"/>` : "";
        return `${hit}<rect data-i="${i}" class="${cls}" x="${x}" y="${y0}" width="${w}" height="${Math.max(y1 - y0, 1)}" rx="2">${tip}</rect>${label}`;
      })
      .join("");
    let cheapMark = "";
    if (known.length) {
      const cheapest = known.reduce((a, b) => (b.value < a.value ? b : a));
      const ci = hours.indexOf(cheapest);
      const cheapX = Math.min(Math.max(left + ci * bw + bw / 2, left + 22), W - 22); // keep the label off the axis
      // halo (paint-order stroke in the card colour) keeps it legible over bars and the now line
      cheapMark = `<text class="cheap" x="${cheapX}" y="${y(cheapest.value) - 6}">${eur(cheapest.value)}</text>`;
    }
    const firstUnknown = hours.findIndex((h) => h.value === null);
    const unknownNote = firstUnknown > 0
      ? `<text class="note" x="${left + ((firstUnknown + hours.length) / 2) * bw}" y="${y(avg) - 8}">published ~13:00</text>` : "";
    const nowX = left + (new Date().getMinutes() / 60) * bw;
    // hairline grid at max, half and zero (plus the minimum when prices go negative)
    const ticks = [...new Set([max, max / 2, 0, min].map((v) => +v.toFixed(4)))];
    const grid = ticks
      .map((v) => `<line class="${v === 0 ? "base" : "grid"}" x1="${left}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="y" x="${left - 8}" y="${y(v) + 4}">${eur(v, 2)}</text>`)
      .join("");
    const label = editable ? "Drag across the hours the car should charge" : "Electricity prices for the next 24 hours";
    return `
      <svg class="${editable ? "editable" : ""}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label}">
        ${grid}${bars}
        <line class="now" x1="${nowX}" x2="${nowX}" y1="${top - 8}" y2="${H - bottom}"/>
        ${cheapMark}${unknownNote}
      </svg>`;
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
      limit: Number(socAttr.effectiveLimitSoc) || 100,
      planSoc: socAttr.effectivePlanSoc,
      planTime,
      plan: s[c.plan_entity]?.attributes?.plan,
    };
    const now = new Date();
    const slots = this._slots(st, now);
    const hours = hourly(rates, slots, now);
    const editable = st.mode === "manual";
    // the current 15-min slot, i.e. exactly what evcc (and the price chip) report
    const curRate = rates.find((r) => new Date(r.start) <= now && now < new Date(r.end));
    const hasUnknown = hours.some((h) => h.value === null);
    const hint = editable
      ? "Drag across the hours the car should charge. Outside them it stays off."
      : "Smart charges in the planned hours. Fast charges now at full power, whatever the price.";

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; --accent: var(--accent-color); --ink: var(--primary-text-color); --muted: var(--secondary-text-color);
                --bar: color-mix(in srgb, var(--muted) 32%, transparent); font-variant-numeric: tabular-nums; }
        ha-card { padding: 20px; }
        .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
        .title { font-size: 16px; font-weight: 500; color: var(--ink); line-height: 1.3; }
        .status { font-size: 13px; color: var(--muted); margin-top: 2px; line-height: 1.4; text-wrap: pretty; }
        .now-price { text-align: right; flex: none; }
        .now-price b { font-size: 26px; font-weight: 400; color: var(--ink); line-height: 1.1; letter-spacing: -0.01em; }
        .now-price span { display: block; font-size: 12px; color: var(--muted); margin-top: 2px; }
        .soc { height: 4px; border-radius: 2px; background: var(--divider-color); margin: 18px 0 6px; overflow: hidden; }
        .soc i { display: block; height: 100%; width: ${Math.min(soc || 0, 100)}%; background: var(--accent); }
        .soc-label { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); }
        svg { width: 100%; height: auto; display: block; margin-top: 20px; overflow: visible; }
        svg.editable { touch-action: none; cursor: pointer; user-select: none; -webkit-user-select: none; }
        .hit { fill: transparent; }
        .bar { fill: var(--bar); transition: fill 120ms; }
        .bar.current { fill: color-mix(in srgb, var(--ink) 55%, transparent); }
        .bar.unknown { fill: none; stroke: color-mix(in srgb, var(--muted) 45%, transparent); stroke-dasharray: 2 3; }
        .bar.charging { fill: var(--accent); stroke: none; }
        .bar.unknown.charging { fill: color-mix(in srgb, var(--accent) 55%, transparent); }
        svg.editable .bar { pointer-events: none; }
        svg.editable .hit:hover + .bar:not(.charging) { fill: color-mix(in srgb, var(--accent) 30%, transparent); }
        .grid { stroke: var(--divider-color); stroke-dasharray: 1 3; }
        .base { stroke: var(--divider-color); }
        .x, .y, .cheap, .note { font-size: 11px; fill: var(--muted); pointer-events: none; }
        .x, .cheap, .note { text-anchor: middle; }
        .y { text-anchor: end; }
        .cheap { fill: var(--ink); font-weight: 500; paint-order: stroke; stroke: var(--ha-card-background, var(--card-background-color)); stroke-width: 4px; stroke-linejoin: round; }
        .now { stroke: var(--ink); stroke-width: 1; pointer-events: none; }
        .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--muted); margin-top: 8px; }
        .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
        .legend i.dashed { box-sizing: border-box; border: 1px dashed color-mix(in srgb, var(--muted) 60%, transparent); }
        .modes { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-top: 20px;
                 background: var(--secondary-background-color); border-radius: calc(var(--ha-card-border-radius, 12px) * 0.7); padding: 4px; }
        .modes button { font: inherit; font-size: 14px; font-weight: 500; border: 0; background: none; color: var(--ink); min-height: 44px; padding: 0 4px;
                        border-radius: calc(var(--ha-card-border-radius, 12px) * 0.55); cursor: pointer;
                        transition: background-color 140ms cubic-bezier(0.16, 1, 0.3, 1), color 140ms, transform 90ms;
                        -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
        .modes button:hover:not(.on) { background: color-mix(in srgb, var(--ink) 7%, transparent); }
        .modes button:focus-visible, .clear:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        .modes button:active { transform: scale(0.97); }
        .modes button.on { background: var(--primary-color); color: var(--text-primary-color); }
        .modes button.busy { animation: busy 900ms ease-in-out infinite alternate; }
        @keyframes busy { to { opacity: 0.65; } }
        @media (prefers-reduced-motion: reduce) { .modes button, .bar { transition: none; } .modes button.busy { animation: none; } }
        .foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
        .hint { font-size: 12px; color: var(--muted); line-height: 1.4; }
        .clear { flex: none; font: inherit; font-size: 13px; font-weight: 500; color: var(--ink); background: none; min-height: 36px; padding: 0 14px;
                 border: 1px solid var(--divider-color); border-radius: calc(var(--ha-card-border-radius, 12px) * 0.55); cursor: pointer; }
        .clear:hover:not(:disabled) { background: color-mix(in srgb, var(--ink) 7%, transparent); }
        .clear:disabled { color: var(--muted); cursor: default; opacity: 0.6; }
        .empty { padding: 40px 0; text-align: center; color: var(--muted); }
      </style>
      <ha-card>
        <div class="head">
          <div>
            <div class="title">${c.title}</div>
            <div class="status">${this._status(st, slots)}</div>
          </div>
          <div class="now-price"><b>${curRate ? eur(curRate.value) : "–"}</b><span>per kWh now</span></div>
        </div>
        <div class="soc" role="progressbar" aria-label="Battery" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${isNaN(soc) ? 0 : Math.round(soc)}"><i></i></div>
        <div class="soc-label"><span>Battery ${isNaN(soc) ? "–" : soc.toFixed(0)}%</span><span>${st.planSoc && st.mode === "smart" ? `target ${st.planSoc}%` : ""}</span></div>
        ${this._chart(hours, editable)}
        <div class="legend">
          ${LEGEND[st.mode] ? `<span><i style="background: var(--accent)"></i>${LEGEND[st.mode]}</span>` : ""}
          <span><i style="background: var(--bar)"></i>Price per hour</span>
          ${hasUnknown ? `<span><i class="dashed"></i>Not published yet</span>` : ""}
        </div>
        <div class="modes" role="group" aria-label="Charging mode">
          ${MODES.map(([m, label]) => `<button data-mode="${m}" aria-pressed="${st.mode === m}" class="${st.mode === m ? "on" : ""}${this._pending?.mode === m ? " busy" : ""}">${label}</button>`).join("")}
        </div>
        <div class="foot">
          <div class="hint">${hint}</div>
          ${editable ? `<button class="clear" data-action="clear" ${st.manual.size ? "" : "disabled"}>Clear</button>` : ""}
        </div>
      </ha-card>`;
  }
}

// HA (2026.3) replaces window.customElements with a scoped-registry polyfill during
// boot. extra_module_url runs this file early; served from cache it can run *before*
// that swap, landing the card in the native registry, which HA never reads
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
