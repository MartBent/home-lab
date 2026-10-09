# Home Assistant configuration sources

Version-controlled sources for the Home Assistant instance on the NAS (`homeassistant` container, host networking, `http://server.home:8123`).

The live HA config directory, `ha/`, is gitignored, so runtime config isn't tracked. This folder holds the sources worth keeping under version control (theme, dashboards, automations). Deploy them into the live `ha/` tree on the NAS as described below.

## Layout

| Path | Deploy to (under `ha/` on the NAS) | What it is |
|---|---|---|
| `themes/mart.yaml` | `themes/mart.yaml` | "Mart's Theme", a household-wide Japandi theme in beige and oak with matched light and dark modes. Covers the whole environment (sidebar, dialogs, inputs), not one dashboard. CSS-variable overrides only, no HACS. |
| `www/alarms-panel.js` | `www/alarms-panel.js` | The alarms screen. A custom panel on the sidebar route `/alarms`, one web component wired to the live entities, inheriting the active theme. This is the primary alarms UI. Registered in `configuration.yaml` under `panel_custom`. |
| `dashboards/alarms.yaml` | `dashboards/alarms.yaml` | The older stock-card alarms dashboard (YAML mode, `sections`). Superseded by the panel, kept as a no-JS fallback. |
| `dashboards/alarms-card.yaml` | not deployed | Paste-in card variant of the stock-card view, for adding to an existing dashboard. |
| `automations/nightly-alarm-reminder.yaml` | append to `automations.yaml` | Optional 21:00 "set an alarm?" actionable notification and its button handler. |

The alarm entities come from the `smart_alarm_clock` custom integration, which lives in its own repo (`MartBent/smart-alarm-clock`, under `homeassistant/custom_components/`). It's the device driver and is versioned with the firmware, not here.

## Theme: install and make it the household default

1. Copy `themes/mart.yaml` to `ha/themes/mart.yaml`.
2. Make sure `configuration.yaml` loads themes:
   ```yaml
   frontend:
     themes: !include_dir_merge_named themes
   ```
3. Set it as everyone's default with a startup automation in `configuration.yaml` (already applied on the NAS):
   ```yaml
   automation manual:
     - id: default_household_theme
       alias: Default theme
       trigger:
         - platform: homeassistant
           event: start
       action:
         - service: frontend.set_theme
           data:
             name: "Mart's Theme"
       mode: single
   automation ui: !include automations.yaml
   ```
4. Restart HA with `docker restart homeassistant`. Every user still on "Backend-selected theme" picks it up, in Auto light/dark. A per-user choice still wins.

## Alarms panel: install

1. Copy `www/alarms-panel.js` to `ha/www/alarms-panel.js`. HA serves it at `/local/alarms-panel.js`.
2. Register it in `configuration.yaml`:
   ```yaml
   panel_custom:
     - name: sac-alarms-panel      # must match customElements.define() in the JS
       sidebar_title: Alarms
       sidebar_icon: mdi:alarm
       url_path: alarms
       module_url: /local/alarms-panel.js
       embed_iframe: false
       require_admin: false
   ```
3. Restart HA. It shows up in the sidebar as Alarms.

The panel reads the `smart_alarm_clock` entities (`sensor.*_phase`, `sensor.*_time`, `switch.*_alarm_1..8`, `time.*_alarm_1_time..8`, `button.*_snooze|_dismiss`) and writes through `switch.turn_on/off`, `time.set_value`, and `button.press`. All colour comes from the active theme, which it reads as HA CSS variables. Times are 24-hour. It shows the first 3 slots with an add control, up to 8.

## Deploy notes

- The NAS is authoritative for runtime, at `~/Git/home-lab/ha/`. Copy over SSH, docker lives at `/usr/local/bin/docker`, restart with `docker restart homeassistant`.
- Custom integrations and themes load at startup only, so restart after any change.
- Validate before restarting:
  `docker exec homeassistant python3 -m homeassistant --script check_config -c /config`
