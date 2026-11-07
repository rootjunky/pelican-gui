# Pelican GUI

A local web dashboard for Pelican Wireless thermostats. It uses only the Python standard library.

## Run
```
python pelican_gui.py          # opens http://<this-PC-ip>:8765, e.g. http://192.168.1.50:8765
python pelican_gui.py --local  # this PC only (http://127.0.0.1:8765)
python pelican_gui.py --port 9000 --no-browser --conf D:\path\pelican.conf
```
The app listens on the machine's network IP, so phones and other PCs on the same network can open the same address.
- **Each browser signs in separately** (cookie-based). Signing in on the PC does not unlock it for anyone else.
- The PC running the app keeps its site list in `pelican.conf`. Other devices keep their own list in their browser, so they never see the PC's list, and their sign-ins don't change it.
- **Quit** only shows up, and only works, on the PC running the app.
- The first time it runs, Windows Firewall will ask whether to allow it. Choose **Private networks** only.
- Traffic between other devices and this app is plain HTTP on your LAN. Only use it on a network you trust.
Each time the program starts, the sign-in screen asks for:
- **Pelican site URL.** Every site has its own address. You can paste the full URL, enter the hostname (`your-site.officeclimatecontrol.net`), or type just the first part (`your-site`).
- **Email** and **password**.

The app first checks the login against the site, then opens the dashboard. Use **Switch site** to sign out and connect to a different site.

The password is held in memory only, for as long as the program runs. It is never saved to disk and never sent back to the browser.
`pelican.conf` (next to the program) remembers:
```ini
[Settings]
timeout = 5            ; seconds per API call (history calls use at least 60)
refresh_seconds = 60

[Pelican]
last_site = your-site.officeclimatecontrol.net
last_user = you@example.com
recent_sites = your-site.officeclimatecontrol.net,demo.officeclimatecontrol.net
```
The `[Settings] timeout` key matches the old pelican9.py config, so an existing `pelican.conf` keeps working.

To try the app without your own site, use Pelican's public demo: `demo` / `pelicandemosite@gmail.com` / `pelican`.
The demo is shared with other users, so don't press Apply there.

## Run in Docker
See [`docker/README.md`](docker/README.md). In short: `cd docker && docker compose up -d --build`, then open `http://<docker-host-IP>:8765`.

## Build the EXE (Windows)
```
python -m pip install pyinstaller
build.bat                      # -> dist\PelicanGUI.exe
```
The EXE has no console window. Use the **Quit** button in the page to stop it.

## Features
Every Pelican API object is used. Each tab is listed with the objects it calls.

| Tab | What you can do | API |
|---|---|---|
| **Zones** | Cards grouped by building, with search. Temperature, humidity, CO₂, run status and sensors. Change setpoints, mode, fan, keypad lock, occupancy and schedule hold. History chart. | Thermostat get/set, ThermostatHistory |
| Zones → **Details** | Device info. Setpoint limits, humidity/CO₂/ventilation, schedule settings, alert thresholds, demand control (Heat/Cool/Fan + Allow), installer settings (with a warning), and custom attributes. | Thermostat get/set (all attributes) |
| **Events** | List current and upcoming events. Create (several zones at once), edit and delete. | ThermostatEvent |
| **Schedules** | Zone schedule editor (Daily/Weekday/Weekly + vacation, up to 12 times a day). Create, replace and delete shared schedules, and assign them to zones. Templates saved in the browser. | ThermostatSchedule, SharedSchedule, Thermostat |
| **Usage** | Heat/cool/fan runtime by day, month or 15 minutes, for one zone or the whole site. Busiest zones. kWh/therms and cost at the site's rates. PowerLink metered energy. | ThermostatUsage, PowerUsage, Site |
| **Power** | Relay outputs: on/off and schedule hold. Power schedules: list, create, edit, delete. | PowerOutput, PowerSchedule |
| **Alerts** | Active and past alerts, Dismiss, and an alert badge on the tab. A user's email/text alert settings. | Notification, User |
| **Site** | Name, type, ZIP, time zone, energy costs. OpenADR status. Schedule or cancel a demand-response event. Demand-response history. | Site (get/set/drEvent/drEventCancel), DemandResponseHistory |
| **My sites** | Every site on the account with device, gateway and alert counts. One-click switch. | Sites (MySites), MySites token |

Sign-in screen: dropdown of previous sites. **Load my sites from Pelican** fills it from your account. If a site doesn't accept your password directly, the app gets a 24-hour MySites token for it automatically.

### What Pelican doesn't allow
- **Reading** ThermostatSchedule, SharedSchedule and User. Pelican answers "Get … is currently unsupported", so those editors can only send changes. They can't show the current values.
- Some write formats aren't spelled out in Pelican's docs. These were built from the docs and **haven't been tried against a real site yet**: event delete, Notification dismiss, User settings, ThermostatSchedule entries. Test them on your own site first. Error messages from Pelican are shown as-is.

## Layout
```
pelican_gui.py      local server + Pelican API proxy
static/index.html   the web UI (zones, sign-in, history)
static/features.js  the other tabs and the zone details dialog
NOTES.md            organized API notes and examples
legacy/pelican9.py  previous tkinter version (reference only)
tests/             UI tests + demo-site fixtures
docker/            Dockerfile, docker-compose.yml, .env.example
```

## Security notes
- Requests must use an IP address or this PC's name as the Host (this blocks DNS-rebinding). POSTs need the app's custom header (this blocks cross-site requests). Sessions are random 256-bit cookies (HttpOnly, SameSite=Strict) that expire after 12 h idle.
- Credentials are sent only to the Pelican site address you enter, over HTTPS.

## Tests
```
python -m pip install mini-racer
python tests/uitest.py static/index.html     # 53 UI-logic checks, using real demo-site data
pip install playwright && python -m playwright install chromium-headless-shell
python tests/e2e_test.py                     # 42 end-to-end checks in a real browser
```
`e2e_test.py` reads from Pelican's public demo site. It **intercepts every write** and checks the exact request instead of sending it, so the shared demo is never changed. Screenshots go to `tests/screenshots/`.

## License

MIT. See [LICENSE](LICENSE).
