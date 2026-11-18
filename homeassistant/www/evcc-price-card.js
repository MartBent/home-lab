/*
 * evcc price card: hourly grid prices with evcc's planned charging hours, plus
 * an Off / Smart / Fast switch. Fast is the "charge now, ignore prices" override.
 *
 * Reads only HA entities (the browser can't reach evcc through the tunnel):
 *   forecast_entity  attributes.rates  [{start, end, value}]  (sensor.evcc_price_forecast)
 *   plan_entity      attributes.plan   [{start, end, ...}]    (sensor.evcc_charge_plan)
 *   soc_entity       state + attributes.effectivePlanSoc / effectivePlanTime
 *   mode_entity      select with options off / smart / now
 *   power_entity     charge power in W
 * Colours come from the active theme; planned hours use the oak accent.
 *
 * Deploy: copy to <config>/www/evcc-price-card.js and load it via
 *   frontend: extra_module_url: [/local/evcc-price-card.js?v=8]
 */

const VERSION = 8;
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
};
const MODES = [
  ["off", "Off"],
  ["smart", "Smart"],
  ["now", "Fast"],
];
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
// Same unit and precision as HA's own price entity (EUR/kWh, 3 decimals), so the
// card never contradicts the price chip; axis labels drop to 2 decimals.
const eur = (v, digits = 3) => `€${v.toFixed(digits)}`;

const AHEAD = 24; // hours shown, starting with the current one

// Fixed window of the next AHEAD hours. 15-min rates are averaged per hour; an hour
// without rates yet (tomorrow before ~13:00) gets value null. Planned = any plan slot overlaps.
function hourly(rates, plan, now) {
  const sums = new Map();
  for (const r of rates) {
    const s = new Date(r.start);
    const key = new Date(s.getFullYear(), s.getMonth(), s.getDate(), s.getHours()).getTime();
    const h = sums.get(key) || { sum: 0, n: 0 };
    h.sum += r.value;
    h.n += 1;
    sums.set(key, h);
  }
  const slots = (plan || []).map((p) => [new Date(p.start).getTime(), new Date(p.end).getTime()]);
  return Array.from({ length: AHEAD }, (_, i) => {
    // Date() arithmetic on the hour field keeps DST changes right
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + i).getTime();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + i + 1).getTime();
    const s = sums.get(start);
    return {
      start,
      value: s ? s.sum / s.n : null,
      planned: slots.some(([a, b]) => a < end && b > start),
      current: i === 0,
    };
  });
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
      // One delegated listener: survives re-renders, so a tap mid-update isn't lost.
      this.shadowRoot.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-mode]");
        if (b) this._setMode(b.dataset.mode);
      });
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
          if (this._hass) this._render();
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

  set hass(hass) {
    this._hass = hass;
    const c = this._config;
    if (!c || !this.shadowRoot) return; // hass can arrive before setConfig
    // The confirmed mode arrived (or the 15 s grace ran out): drop the optimistic one.
    if (this._pending && (hass.states[c.mode_entity]?.state === this._pending.mode || Date.now() > this._pending.until)) {
      this._pending = null;
      this._sig = null;
    }
    // Re-render only when one of our entities changed.
    const sig = [c.forecast_entity, c.plan_entity, c.soc_entity, c.mode_entity, c.power_entity]
      .map((e) => hass.states[e]?.last_updated)
      .join("|") + new Date().getHours();
    if (sig === this._sig) return;
    this._sig = sig;
    this._render();
  }

  // Optimistic: highlight the tapped mode at once; evcc -> REST sensor -> select takes ~1-2 s.
  _setMode(mode) {
    this._pending = { mode, until: Date.now() + 15000 };
    this.shadowRoot.querySelectorAll("button[data-mode]").forEach((b) => {
      b.classList.toggle("on", b.dataset.mode === mode);
      b.classList.toggle("busy", b.dataset.mode === mode);
    });
    this._hass
      .callService("select", "select_option", { entity_id: this._config.mode_entity, option: mode })
      .catch(() => {
        this._pending = null;
        this._sig = null;
        this.hass = this._hass; // snap back to the real mode
      });
  }

  _status(hours, st) {
    const { soc, mode, power, planSoc, planTime, plan } = st;
    if (power > 0) return `Charging at ${(power / 1000).toFixed(1)} kW`;
    if (mode === "off") return "Off, not charging";
    if (mode === "now") return "Fast: waiting for the car";
    if (soc >= 100) return "Car is full";
    if (!planTime) return "Smart: solar surplus only, no plan set";
    const t = hhmm(planTime);
    if (!plan?.length) {
      const known = st.knownUntil;
      return known && known < planTime
        ? `Plan ${planSoc}% by ${t}, waiting for tomorrow's prices (~13:00)`
        : `Plan ${planSoc}% by ${t}, already reached`;
    }
    const first = new Date(Math.min(...plan.map((p) => new Date(p.start).getTime())));
    return `Plan ${planSoc}% by ${t}, charges from ${hhmm(first)}`;
  }

  _chart(hours) {
    const known = hours.filter((h) => h.value !== null);
    if (!known.length) return `<div class="empty">No price forecast yet</div>`;
    const W = Math.max((this._w || 720) - 40, 240), H = 172, top = 16, bottom = 22, left = 40; // 40 = card padding
    const vals = known.map((h) => h.value);
    const max = Math.max(...vals), min = Math.min(0, ...vals);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const span = max - min || 1;
    const bw = (W - left) / hours.length;
    const y = (v) => top + (H - top - bottom) * (1 - (v - min) / span);
    const cheapest = known.reduce((a, b) => (b.value < a.value ? b : a));
    const bars = hours
      .map((h, i) => {
        const x = left + i * bw + 1.5, w = Math.max(bw - 3, 1);
        const d = new Date(h.start);
        const label = d.getHours() % 3 === 0
          ? `<text class="x" x="${x + w / 2}" y="${H - 6}">${d.getHours() === 0 ? d.toLocaleDateString(undefined, { weekday: "short" }) : pad(d.getHours())}</text>`
          : "";
        if (h.value === null) {
          // price not published yet: dashed placeholder at the average height
          return `<rect class="bar unknown" x="${x}" y="${y(avg)}" width="${w}" height="${y(0) - y(avg)}" rx="2"><title>${hhmm(d)}  price not published yet</title></rect>${label}`;
        }
        const y0 = y(Math.max(h.value, 0)), y1 = y(Math.min(h.value, 0));
        const cls = ["bar", h.planned && "planned", h.current && "current"].filter(Boolean).join(" ");
        const tip = `<title>${hhmm(d)}  ${eur(h.value)}/kWh${h.planned ? "  · planned" : ""}</title>`;
        return `<rect class="${cls}" x="${x}" y="${y0}" width="${w}" height="${Math.max(y1 - y0, 1)}" rx="2">${tip}</rect>${label}`;
      })
      .join("");
    const ci = hours.indexOf(cheapest);
    // halo (paint-order stroke in the card colour) keeps the label legible over bars and the now line
    const cheapX = Math.min(Math.max(left + ci * bw + bw / 2, left + 22), W - 22); // keep the label off the axis
    const cheapMark = `<text class="cheap" x="${cheapX}" y="${y(cheapest.value) - 6}">${eur(cheapest.value)}</text>`;
    const firstUnknown = hours.findIndex((h) => h.value === null);
    const unknownNote = firstUnknown > 0
      ? `<text class="note" x="${left + ((firstUnknown + hours.length) / 2) * bw}" y="${y(avg) - 8}">published ~13:00</text>` : "";
    const nowX = left + (new Date().getMinutes() / 60) * bw;
    // hairline grid at max, half and zero (plus the minimum when prices go negative)
    const ticks = [...new Set([max, max / 2, 0, min].map((v) => +v.toFixed(4)))];
    const grid = ticks
      .map((v) => `<line class="${v === 0 ? "base" : "grid"}" x1="${left}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="y" x="${left - 8}" y="${y(v) + 4}">${eur(v, 2)}</text>`)
      .join("");
    return `
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Electricity prices for the next 24 hours">
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
      mode: this._pending?.mode ?? s[c.mode_entity]?.state,
      knownUntil: rates.length ? new Date(rates[rates.length - 1].end) : null,
      power: Number(s[c.power_entity]?.state) || 0,
      planSoc: socAttr.effectivePlanSoc,
      planTime,
      plan: s[c.plan_entity]?.attributes?.plan,
    };
    const now = new Date();
    const hours = hourly(rates, st.plan, now);
    // the current 15-min slot, i.e. exactly what evcc (and the price chip) report
    const curRate = rates.find((r) => new Date(r.start) <= now && now < new Date(r.end));
    const hasUnknown = hours.some((h) => h.value === null);

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
        .bar { fill: var(--bar); }
        .bar.planned { fill: var(--accent); }
        .bar.current:not(.planned) { fill: color-mix(in srgb, var(--ink) 55%, transparent); }
        .bar.unknown { fill: none; stroke: color-mix(in srgb, var(--muted) 45%, transparent); stroke-dasharray: 2 3; }
        .grid { stroke: var(--divider-color); stroke-dasharray: 1 3; }
        .base { stroke: var(--divider-color); }
        .x, .y, .cheap, .note { font-size: 11px; fill: var(--muted); }
        .x, .cheap, .note { text-anchor: middle; }
        .y { text-anchor: end; }
        .cheap { fill: var(--ink); font-weight: 500; paint-order: stroke; stroke: var(--ha-card-background, var(--card-background-color)); stroke-width: 4px; stroke-linejoin: round; }
        .now { stroke: var(--ink); stroke-width: 1; }
        .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--muted); margin-top: 8px; }
        .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
        .legend i.dashed { box-sizing: border-box; border: 1px dashed color-mix(in srgb, var(--muted) 60%, transparent); }
        .modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 20px;
                 background: var(--secondary-background-color); border-radius: calc(var(--ha-card-border-radius, 12px) * 0.7); padding: 4px; }
        .modes button { font: inherit; font-size: 14px; font-weight: 500; border: 0; background: none; color: var(--ink); min-height: 44px;
                        border-radius: calc(var(--ha-card-border-radius, 12px) * 0.55); cursor: pointer;
                        transition: background-color 140ms cubic-bezier(0.16, 1, 0.3, 1), color 140ms, transform 90ms;
                        -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
        .modes button:hover:not(.on) { background: color-mix(in srgb, var(--ink) 7%, transparent); }
        .modes button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        .modes button:active { transform: scale(0.97); }
        .modes button.on { background: var(--primary-color); color: var(--text-primary-color); }
        .modes button.busy { animation: busy 900ms ease-in-out infinite alternate; }
        @keyframes busy { to { opacity: 0.65; } }
        @media (prefers-reduced-motion: reduce) { .modes button { transition: none; } .modes button.busy { animation: none; } }
        .hint { font-size: 12px; color: var(--muted); margin-top: 10px; line-height: 1.4; }
        .empty { padding: 40px 0; text-align: center; color: var(--muted); }
      </style>
      <ha-card>
        <div class="head">
          <div>
            <div class="title">${c.title}</div>
            <div class="status">${this._status(hours, st)}</div>
          </div>
          <div class="now-price"><b>${curRate ? eur(curRate.value) : "–"}</b><span>per kWh now</span></div>
        </div>
        <div class="soc" role="progressbar" aria-label="Battery" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${isNaN(soc) ? 0 : Math.round(soc)}"><i></i></div>
        <div class="soc-label"><span>Battery ${isNaN(soc) ? "–" : soc.toFixed(0)}%</span><span>${st.planSoc ? `target ${st.planSoc}%` : ""}</span></div>
        ${this._chart(hours)}
        <div class="legend">
          <span><i style="background: var(--accent)"></i>Planned charging</span>
          <span><i style="background: var(--bar)"></i>Price per hour</span>
          ${hasUnknown ? `<span><i class="dashed"></i>Not published yet</span>` : ""}
        </div>
        <div class="modes" role="group" aria-label="Charging mode">
          ${MODES.map(([m, label]) => `<button data-mode="${m}" aria-pressed="${st.mode === m}" class="${st.mode === m ? "on" : ""}${this._pending?.mode === m ? " busy" : ""}">${label}</button>`).join("")}
        </div>
        <div class="hint">Smart charges in the planned hours. Fast charges now at full power, whatever the price.</div>
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
window.customCards.push({ type: "evcc-price-card", name: "evcc price card", description: "Prices with evcc's planned charging hours" });
