/*
 * evcc price card: the next 24 h of grid prices per quarter-hour (the EPEX/Zonneplan
 * granularity) with the quarters the car will charge, their cost, and the charge mode.
 * The mode lives in HA (input_select); HA's evcc_mode automation drives evcc (packages/evcc.yaml).
 *   3 phases:
 *   Smart   the cheapest quarters with a known price before the target (HA's
 *           script.evcc_smart_plan), off otherwise. Tap Smart again to replan with newer prices
 *   Fast    charge now, at the lowest current (whole amps, 3 phases) that reaches the target by
 *           its time; when even full power can't, the time moves back to when full power does
 *   Smart and Fast share one target: the oak dot on the battery chart (evcc's daily repeating
 *   plan), dragged up/down for the %, sideways for the time. At or below the battery = off.
 *   1 phase:
 *   Solar   own surplus only. Phases change only while the car is unplugged, never mid-session.
 *
 * Reads only HA entities (the browser can't reach evcc through the tunnel):
 *   forecast_entity  attributes.rates  [{start, end, value}]  (sensor.evcc_price_forecast)
 *   soc_entity       state + effectivePlanSoc / effectivePlanTime / chargeRemainingEnergy
 *   mode_entity      input_select: smart / fast / solar
 *   mode_sensor      evcc's own mode (off / now / smart), to see when it has followed a change
 *   power_entity     charge power in W
 *   max_current      the loadpoint's full current (A); the minimum is evcc's minCurrent
 *   smart_entity     input_text: Smart's quarters, "<base>:<hex bitmask>" (see parseQuarters)
 *   smart_script     plans Smart and selects it; with soc + time it sets evcc's target first
 *   solar_forecast_entity  attributes.time / .global_tilted_irradiance (Open-Meteo, 15 min, UTC)
 *   solar_kwp        panel peak power for that forecast; base_load = house use (W) it must cover first
 * Colours come from the active theme; charging hours use the oak accent.
 *
 * Deploy: copy to <config>/www/evcc-price-card.js and load it as a dashboard resource
 * (Settings > Dashboards > Resources, JavaScript module): /local/evcc-price-card.js?v=54.
 * Not via frontend: extra_module_url: that line lives in the page HTML, which the HA app's
 * service worker cached for hours, pinning the phone to an old version ("Configuration error").
 */

const VERSION = 54;
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
  soc_entity: "sensor.evcc_vehicle_soc",
  mode_entity: "input_select.evcc_charge_mode",
  mode_sensor: "sensor.evcc_mode",
  power_entity: "sensor.evcc_charge_power",
  max_current: 16, // = the loadpoint's maxCurrent; HA's evcc_mode automation uses the same
  smart_entity: "input_text.evcc_smart_hours",
  smart_script: "script.evcc_smart_plan",
  solar_forecast_entity: "sensor.solar_forecast",
  solar_kwp: 4, // placeholder until the real panels are known
  base_load: 300, // shortcut: a flat house load; a learned profile would be better once there's history
};
const PERFORMANCE = 0.85; // inverter, heat and wiring losses: typical for a home system
// Mode buttons grouped by the phases they charge on. No Off button: a target dot at or
// below the battery keeps the car off.
const GROUPS = [
  [3, [
    ["smart", "mdi:leaf", "Smart: the cheapest quarters"],
    ["fast", "mdi:lightning-bolt", "Fast: charge now"],
  ]],
  [1, [["solar", "mdi:white-balance-sunny", "Solar: own surplus only"]]],
];
const LEGEND = { smart: "Planned charging", solar: "Charging from surplus", fast: "Charging now" };
const HOUR = 3600e3;
const QUARTER = 900e3;
const SLOTS = 96; // quarters shown: 24 h starting with the current one
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
// Same unit and precision as HA's own price entity (EUR/kWh, 3 decimals), so the
// card never contradicts the price chip; axis labels drop to 2 decimals.
const eur = (v, digits = 3) => `€${v.toFixed(digits)}`;
const epochQuarter = (ms) => Math.floor(ms / QUARTER);

// Smart's quarters as "<base>:<hex>": base = epoch quarter (unix time // 900) of the first
// bit, then one bit per quarter, most significant bit first in each hex digit. Written by
// HA's script.evcc_smart_plan; the evcc_mode automation decodes the same format.
function parseQuarters(value) {
  const out = new Set();
  const m = /^(\d+):([0-9a-f]*)(?::\d+)?$/.exec(String(value || ""));
  if (!m) return out;
  [...m[2]].forEach((c, d) => {
    for (let b = 0; b < 4; b++) if (parseInt(c, 16) & (8 >> b)) out.add(+m[1] + d * 4 + b);
  });
  return out;
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
      });
      root.addEventListener("keydown", (e) => e.target.closest?.(".target-hit") && this._targetKey(e));
      // shortcut: temporary trace of touches on the chart for debugging the phone; remove once dragging works there
      const trace = (e) => {
        if (e.type === "pointerdown" && e.pointerType === "touch" && e.target.closest?.(".plot")) {
          this._trace = { t0: Date.now(), on: e.target.getAttribute("class"), at: [Math.round(e.clientX), Math.round(e.clientY)], y0: window.scrollY, n: {}, from: this._target ? `${this._target.soc}% ${hhmm(new Date(this._target.t))}` : "", path: [] };
        }
        const tr = this._trace;
        if (!tr) return;
        tr.n[e.type] = (tr.n[e.type] || 0) + 1;
        if (e.type === "pointermove" && tr.path.length < 12 && tr.n.pointermove % 3 === 1) tr.path.push(`${Math.round(e.clientX)},${Math.round(e.clientY)}`);
        if (e.type === "pointerup" || e.type === "pointercancel") {
          this._trace = null;
          const d = this._drag;
          setTimeout(() => report("warning", `drag trace: on=${tr.on} at=${tr.at} ms=${Date.now() - tr.t0} scrollY ${Math.round(tr.y0)}->${Math.round(window.scrollY)} ${e.type} drag=${d?.kind || "none"} target ${tr.from} -> ${d ? `${d.soc}% ${d.t ? hhmm(new Date(d.t)) : ""}` : "-"} events=${JSON.stringify(tr.n)} path=${tr.path.join(" ")} w=${window.innerWidth} dpr=${devicePixelRatio} ua=${navigator.userAgent.slice(-50)}`), 0);
        }
      };
      for (const t of ["touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]) root.addEventListener(t, trace, { capture: true, passive: true });
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
      root.addEventListener("pointercancel", () => this._dragEnd(true));
      // Chrome ignores touch-action on shapes inside an SVG: without this a finger on the
      // target handle scrolls the page after a few px and the browser cancels the drag
      root.addEventListener("touchstart", (e) => e.target.closest?.(".target-hit") && e.preventDefault(), { passive: false }); // belt and braces next to touch-action
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
    clearTimeout(this._tick);
  }

  getCardSize() {
    return 6;
  }

  getGridOptions() {
    return { columns: "full", min_rows: 6 };
  }

  _mode(hass = this._hass) {
    const c = this._config;
    return hass.states[c.mode_entity]?.state;
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
    if (this._drag) return; // never rebuild the chart under a finger
    // Re-render only when one of our entities changed.
    const sig = [c.forecast_entity, c.soc_entity, c.mode_entity, c.mode_sensor, c.power_entity, c.smart_entity, c.solar_forecast_entity]
      .map((e) => hass.states[e]?.last_updated)
      .join("|") + epochQuarter(Date.now());
    if (sig === this._sig) return;
    this._sig = sig;
    this._render();
  }

  // Optimistic: highlight the tapped mode at once; HA confirms within ~100 ms, then the
  // button keeps loading until evcc has followed (see st.transition).
  _setMode(mode) {
    const c = this._config;
    this._pending = { mode, until: Date.now() + 15000 };
    this._sig = null;
    this._render();
    // Smart replans first (also when already on Smart: a replan with newer prices), then selects
    const select = () => this._hass.callService("input_select", "select_option", { entity_id: c.mode_entity, option: mode });
    const [domain, service] = c.smart_script.split(".");
    const call = mode === "smart" ? this._hass.callService(domain, service, {}).then(select) : select();
    call.catch(() => {
      this._pending = null;
      this._sig = null;
      this.hass = this._hass; // snap back to the real mode
    });
  }

  // A dragged target goes into evcc's repeating plan (the script); Smart replans for it and
  // HA's evcc_mode automation sets Fast's current from it.
  _setTarget(soc, time) {
    this._targetPending = { soc, time, until: Date.now() + 15000 };
    this._sig = null;
    this._render();
    this._hass.callService("script", "turn_on", { entity_id: this._config.smart_script, variables: { soc, time } }).catch(() => {
      this._targetPending = null;
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

  // --- dragging the target dot ------------------------------------------------
  _barAt(svg, clientX) {
    const g = this._geo;
    if (!g) return null;
    const x = clientX - svg.getBoundingClientRect().left - g.left;
    return Math.min(Math.max(Math.floor(x / g.bw), 0), g.keys.length - 1);
  }

  _dragStart(e) {
    const hit = e.target.closest?.(".target-hit");
    if (hit && e.button <= 0) {
      e.preventDefault();
      hit.setPointerCapture(e.pointerId);
      this._drag = { kind: "target", svg: this.shadowRoot.querySelector("svg.chart"), ...this._target };
    }
  }

  _dragMove(e) {
    if (!this._drag || this._drag.kind === "keys") return;
    this._dragTarget(e);
  }

  _dragEnd(cancelled) {
    if (!this._drag || this._drag.kind === "keys") return;
    const d = this._drag;
    this._drag = null;
    if (cancelled) return this._render(); // a half-finished drag must not move the target
    const old = this._target;
    if (d.soc !== old.soc || d.t !== old.t) this._setTarget(d.soc, hhmm(new Date(d.t)));
    else this._render();
  }

  // y = battery % (steps of 5, 10..100), x = time (quarter boundaries). Redrawn in place to follow the pointer.
  _dragTarget(e) {
    const g = this._geo, d = this._drag;
    const r = d.svg.getBoundingClientRect(), sx = r.width / g.W, sy = r.height / g.H; // svg px -> screen px
    const p = (g.socBot - (e.clientY - r.top) / sy) / (g.socBot - g.socTop) * 100;
    d.soc = Math.min(Math.max(Math.round(p / 5) * 5, 10), 100);
    const k = Math.min(Math.max(Math.round(((e.clientX - r.left) / sx - g.left) / g.bw), 1), g.keys.length);
    d.t = g.t0 + k * QUARTER;
    this._moveTarget(d);
  }

  // Keyboard: arrows move the handle (15 min / 5 %); saved once the keys rest
  _targetKey(e) {
    const step = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [5, 0], ArrowDown: [-5, 0] }[e.key];
    if (!step) return;
    e.preventDefault();
    const g = this._geo, { soc, t } = this._target;
    const next = {
      soc: Math.min(Math.max(soc + step[0], 10), 100),
      t: Math.min(Math.max(t + step[1] * QUARTER, g.t0 + QUARTER), g.t0 + g.keys.length * QUARTER),
    };
    this._target = next;
    this._moveTarget(next);
    this.shadowRoot.querySelector(".target-hit").focus();
    this._drag = { kind: "keys" }; // hold re-renders while adjusting
    clearTimeout(this._keyTimer);
    this._keyTimer = setTimeout(() => {
      this._drag = null;
      this._setTarget(next.soc, hhmm(new Date(next.t)));
      this.shadowRoot.querySelector(".target-hit")?.focus();
    }, 800);
  }

  // Moves the drawn target and its handle in place. Not innerHTML: that would remove the
  // handle the finger is on, and the browser keeps sending that touch's events to the removed node.
  _moveTarget(target) {
    const fresh = document.createElementNS("http://www.w3.org/2000/svg", "g");
    fresh.innerHTML = this._targetInner(target);
    const old = this.shadowRoot.querySelector("svg.chart g.target").children;
    [...fresh.children].forEach((n, i) => {
      for (const a of n.attributes) old[i].setAttribute(a.name, a.value);
      if (n.tagName === "text") old[i].textContent = n.textContent;
    });
    const tmp = document.createElement("div");
    tmp.innerHTML = this._targetHit(target);
    const hit = this.shadowRoot.querySelector(".target-hit");
    for (const a of tmp.firstElementChild.attributes) hit.setAttribute(a.name, a.value);
  }

  // The target: dashed lines at its % (battery chart) and time (down through the prices:
  // Smart's later quarters don't count; Fast is done there), and a handle where they cross.
  // Fast: when even full power can't make it, the dot moves back to when full power does.
  _targetGeom({ soc, t }) {
    const g = this._geo, fast = g.mode === "fast";
    const amps = fast ? this._fastAmps(soc, t) : 0, done = fast ? this._fastAt(soc, amps) : t;
    const late = done > t + 60e3;
    if (late) t = done;
    const x = Math.min(g.left + ((t - g.t0) / QUARTER) * g.bw, g.plotR), y = g.ySoc(soc);
    const text = !fast ? `${soc}% by ${hhmm(new Date(t))}`
      : soc <= g.soc ? `${soc}%, already there`
      : `${soc}% ${late ? "around" : "by"} ${hhmm(new Date(t))} · ${((230 * 3 * amps) / 1000).toFixed(1)} kW`;
    return { x, y, soc, text };
  }

  _targetInner(target) {
    const g = this._geo, { x, y, soc, text } = this._targetGeom(target);
    const end = x > g.left + 90; // label left of the handle, unless that runs off the chart
    const ly = soc > 80 ? y + 16 : y - 9;
    return `<line class="soc-target" x1="${g.left}" x2="${x}" y1="${y}" y2="${y}"/>
      <line class="soc-target" x1="${x}" x2="${x}" y1="${g.socTop}" y2="${g.bottomY}"/>
      <text class="soc-target-label" x="${end ? x - 9 : x + 9}" y="${ly}" text-anchor="${end ? "end" : "start"}">${text}</text>
      <circle class="target-dot" cx="${x}" cy="${y}" r="6"/>`;
  }

  // The handle is an HTML element over the chart, not an SVG shape: Chrome ignores touch-action
  // on SVG shapes, and the HA app's WebView then cancels the drag as a pan after ~100 ms.
  // Placed in % of the chart so it stays on the dot however the SVG is scaled.
  _targetHit(target) {
    const g = this._geo, { x, y, soc, text } = this._targetGeom(target);
    return `<div class="target-hit" tabindex="0" role="slider" aria-label="Charging target" aria-valuemin="10" aria-valuemax="100"
      aria-valuenow="${soc}" aria-valuetext="${text}" title="Drag to set the target: time across, battery % up and down"
      style="left: ${((x / g.W) * 100).toFixed(3)}%; top: ${((y / g.H) * 100).toFixed(3)}%"></div>`;
  }

  // --- which hours charge, per mode --------------------------------------------
  _slots(st, now) {
    // actually drawing power (e.g. evcc's 3-min wind-down after leaving Fast): this quarter charges, whatever the mode says
    const live = st.power > 0 ? [[now.getTime(), now.getTime() + 60e3]] : [];
    return [...live, ...this._modeSlots(st, now)];
  }

  _modeSlots(st, now) {
    if (st.mode === "smart") return [...st.smart].map((q) => [q * QUARTER, (q + 1) * QUARTER]);
    if (st.mode === "fast" && st.soc < Math.min(st.limit, st.target.soc)) return [[now.getTime(), this._fastAt(st.target.soc, st.fastAmps)]];
    return [];
  }

  _chart(hours, st) {
    const known = hours.filter((h) => h.value !== null);
    // Two panels in one SVG so the quarter columns line up exactly:
    //   battery %   socTop..socBot   (tall enough to drag the target in 5 % steps by finger)
    //   prices      pTop..H-bottom   (bars)
    // 40 = card padding; left gutter carries both axes' labels.
    const W = Math.max((this._w || 720) - 40, 240), left = 40, right = 6, bottom = 22;
    const socTop = 10, socBot = 110, pTop = socBot + 36, H = pTop + 134 + bottom;
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
    this._geo = { left, bw, plotR, keys: hours.map((h) => h.q), items: hours, solar, t0: hours[0].start, socTop, socBot, ySoc, bottomY: H - bottom, soc: st.soc, mode: st.mode, W, H };
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
        return `<rect data-i="${i}" class="${cls}" x="${x}" y="${y0}" width="${w}" height="${Math.max(y1 - y0, 1)}" rx="${Math.min(2, w / 3)}"/>${label}`;
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
    return `<div class="plot">
      <svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Expected battery level and electricity prices for the next 24 hours">
        ${socGrid}${grid}${pv.fill}${bars}${pv.line}
        ${this._socLine(hours, st, nowX, left, bw, ySoc, socBot, plotR)}
        ${unknownNote}
        ${this._target ? `<g class="target">${this._targetInner(this._target)}</g>` : ""}
        <g class="tip" visibility="hidden">
          <line y1="${pTop - 4}" y2="${H - bottom}"/>
          <text y="${socBot + 22}"></text>
        </g>
      </svg>${this._target ? this._targetHit(this._target) : ""}</div>`;
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
    // start label sits above the dot; the end label only when the line actually moved
    // above the line, except near the top where it would sit on the 100% grid line
    const labelY = (p) => (p > 85 ? ySoc(p) + 13 : ySoc(p) - 6);
    const startLabel = `<text class="soc-now" x="${sx + 6}" y="${labelY(sp)}">${Math.round(sp)}%</text>`;
    const endLabel = ep - sp >= 3 ? `<text class="soc-end" x="${Math.min(ex, plotR) - 2}" y="${labelY(ep)}">${Math.round(ep)}%</text>` : "";
    return `<path class="soc-area" d="${area}"/><path class="soc-line" d="${line}"/>
      <circle class="soc-dot" cx="${sx}" cy="${ySoc(sp)}" r="3"/>${startLabel}${endLabel}`;
  }

  // Caption under a phase group: which phase count is in use, and whether a switch to it is
  // waiting for the car to be unplugged or happening now. HA only sends a phase change while
  // the car is unplugged; evcc applies it at the next plug-in, before power flows.
  _phaseCaption(st, g) {
    const want = st.mode === "solar" ? 1 : 3, cfg = Number(st.phasesConfigured);
    if (g === want) {
      if (st.connected && cfg !== want) return { text: "after unplug", cls: " next" };
      if (!st.connected && cfg !== want) return { text: "switching…", cls: " switching" };
      if (st.connected && st.phasesActive && st.phasesActive !== want) return { text: "switching…", cls: " switching" };
    }
    if (st.connected && st.phasesActive === g) return { text: "in use", cls: " in-use" };
    if (st.connected === false && cfg === g) return { text: "next plug-in", cls: " next" };
    return { text: "", cls: "" };
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

  // While evcc is mid-change, redraw every 2 s (countdown, pulsing button) and ask HA for
  // fresh evcc state every 10 s (the REST sensors' minimum) instead of waiting for the 30 s poll.
  _scheduleTick(waiting) {
    clearTimeout(this._tick);
    if (!waiting || !this.isConnected) return;
    if (Date.now() - (this._lastRefresh || 0) > 10000) {
      this._lastRefresh = Date.now();
      this._hass.callService("homeassistant", "update_entity", { entity_id: this._config.soc_entity }).catch(() => {});
    }
    this._tick = setTimeout(() => {
      if (this._drag) return this._scheduleTick(true);
      this._sig = null;
      this._render();
    }, 2000);
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
      smart: parseQuarters(s[c.smart_entity]?.state),
      power: Number(s[c.power_entity]?.state) || 0,
      pvAction: socAttr.pvAction,
      remainingWh: Number(socAttr.chargeRemainingEnergy) || 0,
      connected: socAttr.connected,
      phasesConfigured: socAttr.phasesConfigured ?? null, // 0 = automatic: switches mid-session
      phasesActive: Number(socAttr.phasesActive) || 0,
      limit: Number(socAttr.effectiveLimitSoc) || 100,
      planSoc: socAttr.effectivePlanSoc,
      planTime,
    };
    const tp = this._targetPending;
    // Smart's target as configured in evcc (its daily repeating plan); evcc's effectivePlan*
    // go empty once the car is past the target, so they can't place the handle
    const rp = s[c.mode_sensor]?.attributes?.repeatingPlans?.[0];
    if (tp && ((rp?.soc === tp.soc && rp?.time === tp.time) || Date.now() > tp.until)) this._targetPending = null;
    st.minA = Number(socAttr.minCurrent) || 6;
    st.maxA = c.max_current;
    // evcc is still acting on a change: its start/stop timer runs (pvAction enable/disable);
    // stays on after the timer until evcc reports the stop/start (its next cycle)
    st.transition = st.pvAction === "disable" && st.power > 0 ? "stopping" : st.pvAction === "enable" && !st.power ? "starting" : null;
    // Wh per battery % from evcc's own remaining-energy estimate (charging losses included)
    st.whPerPct = st.remainingWh && st.limit > st.soc ? st.remainingWh / (st.limit - st.soc) : 650;
    const now = new Date();
    // The shared target (evcc's daily repeating plan); a just-dragged one wins until evcc reports it.
    // shortcut: evcc's target is a daily HH:MM, so its next occurrence always lies within the 24 h chart
    const nextAt = (time) => {
      const [h, m] = time.split(":").map(Number), d = new Date(now);
      d.setHours(h, m, 0, 0);
      if (d <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    };
    const tgt = this._targetPending ?? rp ?? { soc: 80, time: "07:00" };
    st.target = { soc: tgt.soc, t: nextAt(tgt.time) };
    // Fast on 3 phases, same sums as HA's evcc_mode automation: the lowest whole-amp current that
    // reaches a % by a time, and when a current gets there (from the car's battery now)
    const need = (p) => Math.max(p - st.soc, 0) * st.whPerPct;
    this._fastAmps = (p, t) => Math.min(Math.max(Math.ceil(need(p) / ((Math.max(t - now.getTime(), 60e3) / HOUR) * 230 * 3)), st.minA), st.maxA);
    this._fastAt = (p, amps) => now.getTime() + (need(p) / (230 * 3 * amps)) * HOUR;
    st.fastAmps = this._fastAmps(st.target.soc, st.target.t);
    // full power on the phases in use: 1 after Solar until the next unplug, else 3; Fast at its current
    st.maxPower = st.mode === "fast" ? 230 * 3 * st.fastAmps : 230 * st.maxA * (Number(socAttr.phasesActive) === 1 ? 1 : 3);
    // the mode wants charging right now but evcc hasn't started yet: it acts on its next
    // 30 s cycle. Loading for up to 90 s after a change; after that it's the car.
    const changed = Math.max(...[c.mode_entity, c.mode_sensor, c.smart_entity].map((e) => Date.parse(s[e]?.last_changed) || 0));
    const wantsNow = this._modeSlots(st, now).some(([a, b]) => a <= now.getTime() && now.getTime() < b);
    const recent = Date.now() - changed < 90e3;
    if (!st.transition && !st.power && st.connected && recent && wantsNow) {
      st.transition = "starting";
    }
    // Stopping covers evcc's whole wind-down: from the change until its stop timer starts
    // (a cycle later), and after the timer until the power reading actually drops to 0.
    // Not for Solar: there, charging right after the switch can be real surplus.
    if (!st.transition && st.power > 0 && st.mode !== "solar" && !wantsNow && (recent || Date.now() < (this._stopUntil || 0))) {
      st.transition = "stopping";
    }
    if (st.transition === "stopping") this._stopUntil = Date.now() + 60e3;
    if (!st.power) this._stopUntil = 0;
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
    }
    // Wh charged per quarter at max power until the car reaches its limit (Smart: its target,
    // where HA stops it); feeds the battery line and the session price, so the two always agree
    const stopAt = Math.min(st.limit, st.mode === "solar" ? 100 : st.target.soc);
    let room = isNaN(soc) ? Infinity : Math.max((Math.max(stopAt, soc) - soc) * st.whPerPct, 0);
    for (const h of hours) {
      h.wh = Math.min(h.frac * st.maxPower, room);
      room -= h.wh;
    }
    const session = this._session(hours, st.mode);
    const hasUnknown = hours.some((h) => h.value === null);
    const hint = "Drag the dot to set the target. Smart: the cheapest quarters before it. Fast: charges now, slower when there's time. Solar: own surplus only.";
    this._target = st.mode === "solar" ? null : st.target;

    this._scheduleTick(st.transition || this._pending);
    const refocus = this.shadowRoot.activeElement?.classList?.contains("target-hit");
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; --accent: var(--accent-color); --ink: var(--primary-text-color); --muted: var(--secondary-text-color);
                --bar: color-mix(in srgb, var(--muted) 32%, transparent); font-variant-numeric: tabular-nums; }
        ha-card { padding: 20px; }
        .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
        .title { font-size: 16px; font-weight: 500; color: var(--ink); line-height: 1.3; }
        .session { text-align: right; flex: none; }
        .session b { font-size: 26px; font-weight: 400; color: var(--ink); line-height: 1.1; letter-spacing: -0.01em; }
        .session span { display: block; font-size: 12px; color: var(--muted); margin-top: 2px; }
        .plot { position: relative; margin-top: 18px; }
        svg { width: 100%; height: auto; display: block; overflow: visible; }
        .bar { fill: var(--bar); transition: fill 120ms; }
        .bar.unknown { fill: color-mix(in srgb, var(--muted) 12%, transparent); }
        .bar.charging { fill: var(--accent); stroke: none; }
        .bar.unknown.charging { fill: color-mix(in srgb, var(--accent) 55%, transparent); }
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
        .soc-target-label { font-size: 11px; font-weight: 500; fill: var(--accent); pointer-events: none; }
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
        .modes { display: flex; gap: 8px; margin-top: 20px; align-items: stretch; }
        /* each phase group is its own small card: status top-left, buttons at the bottom */
        .group { min-width: 0; display: flex; flex-direction: column; justify-content: space-between; gap: 6px; padding: 8px 4px 4px;
                 background: var(--secondary-background-color); border-radius: calc(var(--ha-card-border-radius, 12px) * 0.7); }
        .pill { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 4px; }
        .modes ha-icon { --mdc-icon-size: 22px; display: block; margin: auto; pointer-events: none; }
        /* two lines, top-left: the phase count, then its state (in use / after unplug / ...) */
        .cap { font-size: 12px; line-height: 1.35; padding: 0 6px; text-align: left; }
        .cap .ph { display: block; color: var(--ink); font-weight: 500; }
        .cap .st { display: block; min-height: 1.35em; color: var(--muted); }
        .cap.in-use .st::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); margin-right: 5px; vertical-align: 1px; }
        .cap.next .st { color: var(--accent); }
        .cap.switching .st { color: var(--accent); animation: busy 900ms ease-in-out infinite alternate; }
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
        @media (prefers-reduced-motion: reduce) { .modes button, .bar { transition: none; } .modes button.busy, .cap.switching .st { animation: none; } }
        .foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
        .hint { font-size: 12px; color: var(--muted); line-height: 1.4; }
        .target-dot { fill: var(--accent); stroke: var(--card-background-color, var(--ha-card-background)); stroke-width: 2; pointer-events: none; }
        .target-hit { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
                      touch-action: none; cursor: grab; outline: none; -webkit-tap-highlight-color: transparent; }
        .target-hit:focus-visible { box-shadow: 0 0 0 2px var(--accent) inset; }
        .modes button.on:disabled { opacity: 0.55; cursor: default; }
      </style>
      <ha-card>
        <div class="head">
          <div>
            <div class="title">${c.title}</div>
          </div>
          ${session}
        </div>
        ${this._chart(hours, st)}
        <div class="legend">
          ${LEGEND[st.mode] ? `<span><i style="background: var(--accent)"></i>${LEGEND[st.mode]}</span>` : ""}
          <span><i style="background: var(--bar)"></i>Price per 15 min</span>
          ${st.mode === "solar" && pv.size ? `<span><i class="sun"></i>Expected solar (${c.solar_kwp} kWp)</span>` : ""}
          ${isNaN(soc) ? "" : `<span><i class="line"></i>Expected battery</span>`}
          ${hasUnknown ? `<span><i class="unknown"></i>Not published yet</span>` : ""}
        </div>
        <div class="modes">
          ${GROUPS.map(([phases, modes]) => {
            const cap = this._phaseCaption(st, phases);
            return `<div class="group" style="flex: ${modes.length}">
              <div class="cap${cap.cls}"><span class="ph">${phases === 3 ? "3 phases" : "1 phase"}</span><span class="st">${cap.text}</span></div>
              <div class="pill" role="group" aria-label="${phases === 3 ? "3 phases" : "1 phase"}">
                ${modes.map(([m, icon, label]) => {
                  // loading until evcc has done it: mode confirmed and any start/stop finished
                  const on = st.mode === m, busy = this._pending?.mode === m || (on && st.transition) ? " busy" : "";
                  return `<button data-mode="${m}" aria-pressed="${on}" class="${on ? "on" : ""}${busy}" title="${label}" aria-label="${label}"><ha-icon icon="${icon}"></ha-icon></button>`;
                }).join("")}
              </div>
            </div>`;
          }).join("")}
        </div>
        <div class="foot">
          <div class="hint">${hint}</div>
        </div>
      </ha-card>`;
    if (refocus) this.shadowRoot.querySelector(".target-hit")?.focus();
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
