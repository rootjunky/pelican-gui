"""Pelican Wireless thermostat web GUI.

Listens on the machine's network IP (e.g. http://192.168.1.50:8765) so other
devices on the LAN can open it; each browser signs in separately.
Use --local to restrict it to this computer (127.0.0.1).

A small local web server (Python standard library only) that proxies the
Pelican API and serves a browser dashboard.

Every time the program starts, the user signs in with the site address,
email and password. The password is held in memory only and is never written
to disk or sent to the browser. pelican.conf remembers the last site and email
plus a list of recent sites, so signing in again is quick.

Run:   python pelican_gui.py            (opens http://<this-PC-ip>:8765)
Opts:  --port 9000  --no-browser  --local  --conf path\\to\\pelican.conf
"""

import argparse
import configparser
import json
import os
import ipaddress
import re
import secrets
import signal
import socket
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET  # parses only Pelican's own responses (fallback path)
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_NAME = "Pelican GUI"
DEFAULT_PORT = 8765
PELICAN_SUFFIX = ".officeclimatecontrol.net"
MAX_RECENT = 10

# Attributes shown on the dashboard.
THERMOSTAT_FIELDS = [
    "name", "description", "groupName", "system", "fan", "heatSetting",
    "coolSetting", "temperature", "humidity", "runStatus", "status",
    "statusDisplay", "frontKeypad", "setBy", "schedule", "slaves",
    "serialNo", "scheduleName", "setback", "outsideVentilation", "co2Level",
    "auxStatus", "demandRequest",
]
SITE_FIELDS = ["altName", "postalCode", "timeZone", "type", "kwhCost", "thermCost",
               "OpenADRStatus", "OpenADREventType", "OpenADREventStart", "OpenADREventEnd"]
MYSITES_HOST = "mysites.officeclimatecontrol.net"

# Generic proxy whitelist: object -> request types the GUI may send.
# (GET of ThermostatSchedule / SharedSchedule / User is answered by Pelican with
#  "currently unsupported", so those are write-only.)
API_OBJECTS = {
    "Thermostat": {"get", "set"},
    "ThermostatSchedule": {"set"},
    "SharedSchedule": {"set"},
    "ThermostatEvent": {"get", "set"},
    "ThermostatHistory": {"get"},
    "ThermostatUsage": {"get"},
    "Notification": {"get", "set"},
    "User": {"set"},
    "PowerOutput": {"get", "set"},
    "PowerSchedule": {"get", "set"},
    "PowerUsage": {"get"},
    "DemandResponseHistory": {"get"},
    "Site": {"get", "set", "drEvent", "drEventCancel"},
}
SLOW_OBJECTS = {"ThermostatHistory", "ThermostatUsage", "PowerUsage", "DemandResponseHistory"}

# What the GUI is allowed to SET, with validation.
ENUMS = {
    "system": {"Off", "Auto", "Heat", "Cool"},
    "fan": {"Auto", "On"},
    "frontKeypad": {"On", "Off"},
    "status": {"Occupied", "Vacant"},
    "schedule": {"On", "Off"},
}
INTS = {"heatSetting", "coolSetting"}
STRINGS = {"description"}
SITE_SETTABLE = {"altName"}


# --------------------------------------------------------------------------- paths
def app_dir():
    """Folder that holds pelican.conf (next to the .exe when frozen)."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def resource_dir():
    """Folder that holds static/ (PyInstaller unpacks to _MEIPASS)."""
    return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


CONF_PATH = os.path.join(app_dir(), "pelican.conf")
STATIC_DIR = os.path.join(resource_dir(), "static")


# --------------------------------------------------------------------------- pelican.conf
_conf_lock = threading.Lock()


def load_conf():
    """Read pelican.conf -> plain dict. Missing file or keys fall back to defaults."""
    cp = configparser.ConfigParser()
    try:
        cp.read(CONF_PATH, encoding="utf-8")
    except configparser.Error:
        pass
    s = cp["Settings"] if cp.has_section("Settings") else {}
    p = cp["Pelican"] if cp.has_section("Pelican") else {}

    def as_int(v, default):
        try:
            return int(v)
        except (TypeError, ValueError):
            return default

    recent = [r.strip() for r in (p.get("recent_sites", "") or "").split(",") if r.strip()]
    return {
        "timeout": max(5, as_int(s.get("timeout"), 5)),
        "refreshSeconds": max(15, as_int(s.get("refresh_seconds"), 60)),
        "lastSite": p.get("last_site", "") or "",
        "lastUser": p.get("last_user", "") or "",
        "recentSites": recent,
    }


def save_conf(conf):
    """Write pelican.conf. Never contains a password."""
    cp = configparser.ConfigParser()
    cp["Settings"] = {
        "timeout": str(conf["timeout"]),
        "refresh_seconds": str(conf["refreshSeconds"]),
    }
    cp["Pelican"] = {
        "last_site": conf["lastSite"],
        "last_user": conf["lastUser"],
        "recent_sites": ",".join(conf["recentSites"][:MAX_RECENT]),
    }
    with _conf_lock:
        tmp = CONF_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("# Pelican GUI settings. Passwords are never stored here.\n")
            cp.write(f)
        os.replace(tmp, CONF_PATH)


# --------------------------------------------------------------------------- sessions
# One sign-in per browser (cookie), so other people on the network who open the
# dashboard must sign in themselves. Memory only; gone when the app exits.
COOKIE = "pelican_sid"
SESSION_IDLE = timedelta(hours=12)
_sessions = {}            # token -> {"creds": (domain, user, pass), "account": (user, pass), "seen": datetime}
_sessions_lock = threading.Lock()
_current = threading.local()  # creds for the request being handled (one thread per request)


def session_new(creds, account):
    """creds = what the site accepts (password, or a MySites token with blank user);
    account = the email/password typed in (for MySites calls)."""
    token = secrets.token_urlsafe(32)
    with _sessions_lock:
        _sessions[token] = {"creds": creds, "account": account, "seen": datetime.now()}
    return token


def session_account(token):
    with _sessions_lock:
        s = _sessions.get(token)
        return s["account"] if s else None


def session_get(token):
    if not token:
        return None
    now = datetime.now()
    with _sessions_lock:
        for t in [t for t, s in _sessions.items() if now - s["seen"] > SESSION_IDLE]:
            del _sessions[t]
        s = _sessions.get(token)
        if s:
            s["seen"] = now
            return s["creds"]
    return None


def session_drop(token):
    with _sessions_lock:
        _sessions.pop(token, None)


# --------------------------------------------------------------------------- API
class PelicanError(Exception):
    def __init__(self, msg, auth=False):
        super().__init__(msg)
        self.auth = auth  # True -> browser should show the sign-in screen


_HOST_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$")


def normalize_site(text):
    """Accept 'your-site', 'your-site.officeclimatecontrol.net',
    or a full URL (even a pasted api.cgi link) and return the bare hostname."""
    t = (text or "").strip()
    if not t:
        raise PelicanError("Enter the Pelican site address")
    if "://" not in t:
        t = "https://" + t
    host = (urllib.parse.urlsplit(t).hostname or "").lower().rstrip(".")
    if host and "." not in host:
        host += PELICAN_SUFFIX
    if not _HOST_RE.match(host):
        raise PelicanError(f"'{text.strip()}' doesn't look like a site address")
    if host == "mysites" + PELICAN_SUFFIX:
        raise PelicanError("Use the site's own address (e.g. your-site.officeclimatecontrol.net), not mysites")
    return host


def _check_token(s, what):
    s = str(s)
    if ";" in s or ":" in s:
        raise PelicanError(f"{what} may not contain ':' or ';'")
    return s


def _http_get(url, domain, timeout, json_accept=True):
    headers = {"User-Agent": "PelicanGUI/1.0"}
    if json_accept:
        headers["Accept"] = "application/json"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        # Pelican puts a readable message in the body even on 4xx (e.g. 403
        # "Invalid Authentication Credentials").
        msg = ""
        try:
            msg = json.loads(e.read().decode("utf-8", "replace")).get("result", {}).get("message", "")
        except Exception:  # noqa: BLE001
            pass
        if not msg and e.code in (401, 403):
            msg = "Login rejected. Check the email and password."
        raise PelicanError(msg or f"HTTP {e.code} from {domain}")
    except urllib.error.URLError as e:
        reason = str(e.reason)
        if "Name or service not known" in reason or "getaddrinfo failed" in reason or "nodename nor servname" in reason:
            raise PelicanError(f"Site '{domain}' not found. Check the URL.")
        raise PelicanError(f"Cannot reach {domain}: {reason}")
    except TimeoutError:
        raise PelicanError(f"Timed out talking to {domain} (raise 'timeout' in pelican.conf if this keeps happening)")


def _xml_node(el):
    kids = list(el)
    if not kids:
        return (el.text or "").strip()
    out = {}
    for k in kids:
        v = _xml_node(k)
        if k.tag in out:
            if not isinstance(out[k.tag], list):
                out[k.tag] = [out[k.tag]]
            out[k.tag].append(v)
        else:
            out[k.tag] = v
    return out


def xml_result(raw):
    """Pelican XML <result> -> same dict shape as its JSON (values are strings)."""
    root = ET.fromstring(raw.encode("utf-8"))
    node = _xml_node(root)
    return node if isinstance(node, dict) else {}


def pelican_call(request, obj, selection=None, value=None, creds=None, timeout=None):
    """Call api.cgi and return the parsed 'result' dict. Raises PelicanError."""
    domain, username, password = creds or getattr(_current, "creds", None) or ("", "", "")
    if not domain:
        raise PelicanError("Not signed in", auth=True)
    params = {
        "username": username,
        "password": password,
        "request": request,
        "object": obj,
    }
    if selection:
        params["selection"] = selection
    if value:
        params["value"] = value
    url = f"https://{domain}/api.cgi?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    timeout = timeout or load_conf()["timeout"]
    raw = _http_get(url, domain, timeout, json_accept=True)
    try:
        result = json.loads(raw).get("result", {})
    except (json.JSONDecodeError, AttributeError):
        # Pelican sometimes emits malformed JSON (seen: serialNo-filtered
        # ThermostatUsage ends in a run of stray '}'). Its XML is fine - retry as XML.
        try:
            result = xml_result(_http_get(url, domain, timeout, json_accept=False))
        except ET.ParseError:
            raise PelicanError(f"{domain} did not answer like a Pelican site. Check the address.")
    if str(result.get("success")) != "1":
        raise PelicanError(result.get("message") or "Request failed")
    return result


def as_list(x):
    if x is None:
        return []
    return x if isinstance(x, list) else [x]


def get_thermostats():
    r = pelican_call("get", "Thermostat", value=";".join(THERMOSTAT_FIELDS))
    stats = as_list(r.get("Thermostat"))
    for t in stats:
        t["slaves"] = as_list(t.get("slaves"))
    stats.sort(key=lambda t: str(t.get("name", "")).lower())
    return stats


def set_thermostat(name, values):
    name = _check_token(name, "Thermostat name")
    pairs = []
    for k, v in values.items():
        if k in ENUMS:
            if v not in ENUMS[k]:
                raise PelicanError(f"Invalid {k}: {v}")
        elif k in INTS:
            try:
                v = int(round(float(v)))
            except (TypeError, ValueError):
                raise PelicanError(f"{k} must be a number")
            if not 35 <= v <= 99:
                raise PelicanError(f"{k} out of range (35-99)")
        elif k in STRINGS:
            v = _check_token(v, k).strip()
        else:
            raise PelicanError(f"Not allowed to set {k}")
        pairs.append(f"{k}:{v}")
    if not pairs:
        raise PelicanError("Nothing to change")
    if "heatSetting" in values and "coolSetting" in values:
        if int(float(values["heatSetting"])) >= int(float(values["coolSetting"])):
            raise PelicanError("Heat setpoint must be below cool setpoint")
    r = pelican_call("set", "Thermostat", selection=f"name:{name};", value=";".join(pairs))
    return r.get("message", "Saved")


def get_site(creds=None):
    r = pelican_call("get", "Site", value=";".join(SITE_FIELDS), creds=creds)
    attrs = r.get("attribute") or r.get("Site") or {}
    if isinstance(attrs, list):
        attrs = attrs[0] if attrs else {}
    return attrs


def set_site(values):
    pairs = []
    for k, v in values.items():
        if k not in SITE_SETTABLE:
            raise PelicanError(f"Not allowed to set {k}")
        pairs.append(f"{k}:{_check_token(v, k).strip()}")
    if not pairs:
        raise PelicanError("Nothing to change")
    r = pelican_call("set", "Site", value=";".join(pairs))
    return r.get("message", "Saved")


def get_history(name, hours, serial=""):
    try:
        hours = max(1, min(int(hours), 24 * 28))
    except (TypeError, ValueError):
        hours = 24
    # Pelican reads startDateTime/endDateTime in the *site's* local time and
    # ignores a trailing "Z". This PC may be in another time zone, so ask for a
    # window padded by a day on each side, then trim to the newest `hours`
    # (see the end of this function). No time-zone database needed.
    now = datetime.now()
    end = now + timedelta(hours=26)
    start = now - timedelta(hours=hours + 26)
    fmt = "%Y-%m-%dT%H:%M"
    base_sel = f"startDateTime:{start.strftime(fmt)};endDateTime:{end.strftime(fmt)};"
    value = "name;temperature;heatSetting;coolSetting;runStatus;timestamp"
    slow = max(60, load_conf()["timeout"])  # history is a big download
    # Selecting by serialNo works and returns just one zone (fast). name: in the
    # selection returns "not found" (tested on the demo site), so without a serial
    # we fetch every zone and filter.
    r = None
    if serial:
        try:
            r = pelican_call("get", "ThermostatHistory",
                             selection=base_sel + f"serialNo:{_check_token(serial, 'serialNo')};", value=value, timeout=slow)
        except PelicanError as e:
            if e.auth:
                raise
    if r is None:
        r = pelican_call("get", "ThermostatHistory", selection=base_sel, value=value, timeout=slow)
    rows = []
    entries = as_list(r.get("ThermostatHistory"))
    for entry in entries:
        if entry.get("name") == name or (serial and len(entries) == 1):
            rows = as_list(entry.get("History"))
            break

    def ts(row):
        try:
            return datetime.strptime(str(row.get("timestamp", ""))[:16], fmt)
        except ValueError:
            return None

    stamped = [(ts(row), row) for row in rows]
    stamped = [(t, row) for t, row in stamped if t is not None]
    if not stamped:
        return []
    latest = max(t for t, _ in stamped)
    cutoff = latest - timedelta(hours=hours)
    return [row for t, row in sorted(stamped, key=lambda x: x[0]) if t >= cutoff]


# --------------------------------------------------------------------------- site icon
# Every Pelican site serves an "office building" icon at images/... (the same
# files the site's own web page uses). Fetched once per site, kept in memory.
ICON_PATHS = ("images/apple-touch-icon.png?v=1", "images/favicon-32x32.png?v=1")
ICON_MAX_BYTES = 512 * 1024
_icon_cache = {}          # domain -> (content_type, bytes) or None (= not available)
_icon_lock = threading.Lock()


def fetch_site_icon(domain):
    with _icon_lock:
        if domain in _icon_cache:
            return _icon_cache[domain]
    found = None
    for path in ICON_PATHS:
        req = urllib.request.Request(f"https://{domain}/{path}", headers={"User-Agent": "PelicanGUI/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                data = resp.read(ICON_MAX_BYTES + 1)
        except (urllib.error.URLError, TimeoutError, OSError):
            continue
        # Only accept real raster images (no SVG/HTML: keeps scripts out of our origin).
        if ctype in ("image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/jpeg", "image/gif", "image/webp") \
                and 0 < len(data) <= ICON_MAX_BYTES:
            found = (ctype, data)
            break
    with _icon_lock:
        _icon_cache[domain] = found
    return found


def login(site, username, password, remember=True):
    """Check credentials against the site, then start the session.
    remember=True records the site/email in pelican.conf (PC running the app only)."""
    domain = normalize_site(site)
    username = (username or "").strip()
    if not username or not password:
        raise PelicanError("Enter your email and password")
    creds = (domain, username, password)
    via_token = False
    # Site is a cheap call that only works with a valid login. Keep its error
    # text (e.g. bad password) but don't let it trigger the sign-in screen loop.
    try:
        site_info = get_site(creds=creds)
    except PelicanError as e:
        # The site may not know this login directly (MySites "Shared Users", or a
        # different password per site). MySites can hand out a 24 h token for the
        # site: blank username + token as password.
        tok = mysites_token(domain, username, password)
        if not tok:
            raise PelicanError(str(e))
        creds = (domain, "", tok)
        site_info = get_site(creds=creds)
        via_token = True
    token = session_new(creds, (username, password))

    if remember:
        conf = load_conf()
        conf["lastSite"] = domain
        conf["lastUser"] = username
        conf["recentSites"] = [domain] + [r for r in conf["recentSites"] if r != domain]
        try:
            save_conf(conf)
        except OSError:
            pass  # read-only folder: still usable, just won't remember
    return token, {"domain": domain, "username": username, "altName": site_info.get("altName", ""),
                   "viaToken": via_token}


# --------------------------------------------------------------------------- MySites (account level)
def mysites_list(username, password):
    """All sites on the account (no selection = every site; verified on demo)."""
    r = pelican_call("get", "Sites",
                     value="name;domain;gateways;activeGateways;devices;activeDevices;notifications",
                     creds=(MYSITES_HOST, username, password), timeout=max(20, load_conf()["timeout"]))
    sites = as_list(r.get("Sites"))
    sites.sort(key=lambda x: str(x.get("name", "")).lower())
    return sites


def mysites_token(domain, username, password):
    """24 h token for one site via MySites, or None."""
    name = domain[:-len(PELICAN_SUFFIX)] if domain.endswith(PELICAN_SUFFIX) else domain
    try:
        r = pelican_call("get", "Sites", selection=f"name:{_check_token(name, 'site')};", value="name;domain;token",
                         creds=(MYSITES_HOST, username, password))
    except PelicanError:
        return None
    for site in as_list(r.get("Sites")):
        if site.get("token"):
            return str(site["token"])
    return None


# --------------------------------------------------------------------------- generic API proxy
_MAX_PARAM = 4000


def api_proxy(request, obj, selection="", value=""):
    """Whitelisted pass-through used by the Events/Schedules/Usage/Power/Alerts/Site tabs.
    The caller is already signed in to this site with their own Pelican login, so
    this lets them do exactly what their Pelican account allows - nothing more."""
    if obj not in API_OBJECTS or request not in API_OBJECTS[obj]:
        raise PelicanError(f"{request} {obj} is not supported")
    for what, v in (("selection", selection), ("value", value)):
        if not isinstance(v, str) or len(v) > _MAX_PARAM:
            raise PelicanError(f"Bad {what}")
        if any(c in v for c in "\r\n\x00"):
            raise PelicanError(f"{what} contains a character Pelican can't accept")
    timeout = max(90, load_conf()["timeout"]) if obj in SLOW_OBJECTS else None
    r = pelican_call(request, obj, selection=selection or None, value=value or None, timeout=timeout)
    r.pop("success", None)
    return r


# --------------------------------------------------------------------------- HTTP
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "PelicanGUI/1.0"

    def log_message(self, fmt, *args):  # quiet; also keeps URLs out of any console
        pass

    # ---- helpers
    def _ok(self, data=None, **extra):
        self._send_json({"ok": True, "data": data, **extra})

    def _err(self, msg, status=200, auth=False):
        self._send_json({"ok": False, "error": str(msg), "auth": auth}, status)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 100_000:
            raise PelicanError("Request too large")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            raise PelicanError("Bad JSON")
        if not isinstance(data, dict):
            raise PelicanError("Bad JSON")
        return data

    def _origin_ok(self):
        # Block other web pages from driving this server.
        # Host must be an IP literal or one of this machine's names: that stops
        # DNS-rebinding (an attacker's domain pointed at this IP). POSTs also need
        # a custom header, which a cross-site form or image can't send (CSRF).
        host = (self.headers.get("Host") or "").strip().lower()
        if host.startswith("["):
            host = host[1:host.find("]")] if "]" in host else ""
        else:
            host = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
        if host not in ALLOWED_HOSTS:
            try:
                ipaddress.ip_address(host)
            except ValueError:
                return False
        if self.command == "POST" and self.headers.get("X-Pelican-GUI") != "1":
            return False
        return True

    def _is_local_client(self):
        try:
            ip = ipaddress.ip_address(self.client_address[0])
        except ValueError:
            return False
        return ip.is_loopback or str(ip) in LOCAL_IPS or any(ip in net for net in OPTS["trusted_nets"])

    def _token(self):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE:
                return v
        return ""

    def _session_info(self):
        conf = load_conf()
        domain, username, _ = getattr(_current, "creds", None) or ("", "", "")
        local = self._is_local_client()
        # Remembered email/sites are only pre-filled on the PC running the app,
        # not for other devices on the network.
        return {
            "signedIn": bool(domain),
            "domain": domain,
            "username": username,
            "lastSite": conf["lastSite"] if local else "",
            "lastUser": conf["lastUser"] if local else "",
            "recentSites": conf["recentSites"] if local else [],
            "refreshSeconds": conf["refreshSeconds"],
            "canQuit": local and not OPTS["no_quit"],
        }

    def _send_json(self, obj, status=200, cookie=None):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # browser left (page closed / site switched) before the answer came back

    # ---- routing
    def do_GET(self):
        if not self._origin_ok():
            return self._err("Forbidden", 403)
        _current.creds = session_get(self._token())
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        try:
            if u.path == "/api/session":
                return self._ok(self._session_info())
            if u.path == "/api/thermostats":
                return self._ok(get_thermostats())
            if u.path == "/api/site":
                return self._ok(get_site())
            if u.path == "/api/site-icon":
                return self._site_icon((q.get("site") or [""])[0])
            if u.path == "/api/history":
                name = (q.get("name") or [""])[0]
                hours = (q.get("hours") or ["24"])[0]
                serial = (q.get("serial") or [""])[0]
                return self._ok(get_history(name, hours, serial))
            return self._static(u.path)
        except PelicanError as e:
            return self._err(e, auth=e.auth)
        except Exception as e:  # noqa: BLE001 - surface anything to the UI
            return self._err(f"Internal error: {e}", 500)

    def do_POST(self):
        if not self._origin_ok():
            return self._err("Forbidden", 403)
        _current.creds = session_get(self._token())
        path = urllib.parse.urlparse(self.path).path
        try:
            body = self._body()
            if path == "/api/login":
                token, info = login(body.get("site"), body.get("username"), body.get("password") or "",
                                    remember=self._is_local_client())
                session_drop(self._token())
                return self._send_json({"ok": True, "data": info},
                                       cookie=f"{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict")
            if path == "/api/logout":
                session_drop(self._token())
                return self._send_json({"ok": True, "data": "Signed out"},
                                       cookie=f"{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
            if path == "/api/mysites":
                # Login screen: list the account's sites with the typed email/password.
                # Signed in: use this browser's own account login.
                acct = session_account(self._token())
                user = (body.get("username") or "").strip() or (acct[0] if acct else "")
                pw = body.get("password") or (acct[1] if acct else "")
                if not user or not pw:
                    raise PelicanError("Enter your email and password first")
                return self._ok(mysites_list(user, pw))
            if path == "/api/forget-site":
                # Login-screen action, so no sign-in needed - but only on the PC
                # running the app (other devices keep their list in the browser).
                if not self._is_local_client():
                    raise PelicanError("Only the computer running the app can edit its site list")
                site = str(body.get("site") or "").strip().lower()
                conf = load_conf()
                conf["recentSites"] = [r for r in conf["recentSites"] if r != site]
                if conf["lastSite"] == site:
                    conf["lastSite"] = conf["recentSites"][0] if conf["recentSites"] else ""
                save_conf(conf)
                return self._ok(conf["recentSites"])
            if path == "/api/quit" and OPTS["no_quit"]:
                raise PelicanError("Quit is turned off here (stop it from Docker / the service manager)")
            if path == "/api/quit" and not self._is_local_client():
                raise PelicanError("Quit is only allowed on the computer running the app")
            if path != "/api/quit" and not _current.creds:
                raise PelicanError("Not signed in", auth=True)
            if path == "/api/prefs":
                conf = load_conf()
                try:
                    conf["refreshSeconds"] = max(15, int(body.get("refreshSeconds", conf["refreshSeconds"])))
                except (TypeError, ValueError):
                    raise PelicanError("Refresh must be a number of seconds")
                save_conf(conf)
                return self._ok(self._session_info())
            if path == "/api/switch-site":
                # My sites tab: sign in to another site with this browser's account login.
                acct = session_account(self._token())
                if not acct:
                    raise PelicanError("Not signed in", auth=True)
                token, info = login(body.get("site"), acct[0], acct[1], remember=self._is_local_client())
                session_drop(self._token())
                return self._send_json({"ok": True, "data": info},
                                       cookie=f"{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict")
            if path == "/api/call":
                return self._ok(api_proxy(str(body.get("request") or ""), str(body.get("object") or ""),
                                          body.get("selection") or "", body.get("value") or ""))
            if path == "/api/thermostat":
                name = body.get("name") or ""
                values = body.get("values") or {}
                if not isinstance(values, dict):
                    raise PelicanError("values must be an object")
                return self._ok(set_thermostat(name, values))
            if path == "/api/site":
                return self._ok(set_site(body.get("values") or {}))
            if path == "/api/quit":
                self._ok("Shutting down")
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return None
            return self._err("Not found", 404)
        except PelicanError as e:
            return self._err(e, auth=e.auth)
        except Exception as e:  # noqa: BLE001
            return self._err(f"Internal error: {e}", 500)

    def _site_icon(self, site):
        """Icon of ?site=... (login screen; Pelican hosts only, no sign-in needed)
        or of the signed-in site."""
        if site:
            domain = normalize_site(site)
            if not domain.endswith(PELICAN_SUFFIX):
                return self._err("Not found", 404)
        else:
            creds = getattr(_current, "creds", None)
            if not creds:
                return self._err("Not found", 404)
            domain = creds[0]
        icon = fetch_site_icon(domain)
        if not icon:
            return self._err("Not found", 404)
        ctype, data = icon
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, max-age=86400")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def _static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.normpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not full.startswith(os.path.normpath(STATIC_DIR) + os.sep) or not os.path.isfile(full):
            return self._err("Not found", 404)
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", STATIC_TYPES.get(os.path.splitext(full)[1], "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def lan_ip():
    """This machine's main LAN IPv4 address (no packet is actually sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def local_names_and_ips():
    names = {"localhost", "127.0.0.1", "::1"}
    ips = {"127.0.0.1", "::1"}
    hn = socket.gethostname()
    for n in {hn, socket.getfqdn()}:
        if n:
            names.update({n.lower(), n.lower() + ".local", n.lower().split(".")[0]})
        try:
            for info in socket.getaddrinfo(n, None):
                ips.add(info[4][0])
        except OSError:
            pass
    ips.add(lan_ip())
    return names | ips, ips


ALLOWED_HOSTS, LOCAL_IPS = local_names_and_ips()
# Runtime options set by main() (command line or PELICAN_* environment variables).
OPTS = {"no_quit": False, "trusted_nets": []}


def _env_list(name):
    return [x.strip() for x in os.environ.get(name, "").split(",") if x.strip()]


def _env_flag(name):
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def main():
    global CONF_PATH
    ap = argparse.ArgumentParser(
        description=APP_NAME,
        epilog="Every option can also be set with an environment variable (shown in brackets), handy for Docker.")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PELICAN_PORT") or DEFAULT_PORT),
                    help="port to listen on [PELICAN_PORT] (default 8765)")
    ap.add_argument("--no-browser", action="store_true", default=_env_flag("PELICAN_NO_BROWSER"),
                    help="don't open a browser on start [PELICAN_NO_BROWSER=1]")
    ap.add_argument("--local", action="store_true", default=_env_flag("PELICAN_LOCAL"),
                    help="only allow this computer (listen on 127.0.0.1 instead of the network) [PELICAN_LOCAL=1]")
    ap.add_argument("--bind", default=os.environ.get("PELICAN_BIND", ""),
                    help="address to listen on [PELICAN_BIND] (default 0.0.0.0, or 127.0.0.1 with --local)")
    ap.add_argument("--conf", default=os.environ.get("PELICAN_CONF", ""),
                    help="path to pelican.conf [PELICAN_CONF] (default: next to the program)")
    ap.add_argument("--allow-host", action="append", default=_env_list("PELICAN_ALLOWED_HOSTS"),
                    help="extra hostname people use to reach the app, e.g. nas.local; repeatable "
                         "[PELICAN_ALLOWED_HOSTS=a,b]. IP addresses are always accepted.")
    ap.add_argument("--trusted-net", action="append", default=_env_list("PELICAN_TRUSTED_NETS"),
                    help="network (CIDR) treated like 'this computer': its sign-ins are remembered in "
                         "pelican.conf and it may Quit; repeatable [PELICAN_TRUSTED_NETS=192.168.1.0/24]")
    ap.add_argument("--no-quit", action="store_true", default=_env_flag("PELICAN_NO_QUIT"),
                    help="hide/disable the Quit button, e.g. in Docker [PELICAN_NO_QUIT=1]")
    ap.add_argument("--public-url", default=os.environ.get("PELICAN_PUBLIC_URL", ""),
                    help="address to print in the log, e.g. http://192.168.1.50:8765 [PELICAN_PUBLIC_URL]")
    args = ap.parse_args()
    if args.conf:
        CONF_PATH = os.path.abspath(args.conf)
        os.makedirs(os.path.dirname(CONF_PATH), exist_ok=True)
    for h in args.allow_host:
        ALLOWED_HOSTS.add(h.strip().lower())
    try:
        OPTS["trusted_nets"] = [ipaddress.ip_network(n, strict=False) for n in args.trusted_net]
    except ValueError as e:
        ap.error(f"--trusted-net: {e}")
    OPTS["no_quit"] = args.no_quit
    # docker stop sends SIGTERM; shut down cleanly instead of being killed.
    def _on_sigterm(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, _on_sigterm)
    if not os.path.exists(CONF_PATH):
        try:
            save_conf(load_conf())  # create with defaults
        except OSError:
            pass

    bind = args.bind or ("127.0.0.1" if args.local else "0.0.0.0")
    ip = "127.0.0.1" if args.local else lan_ip()
    url = args.public_url or f"http://{ip}:{args.port}/"
    try:
        server = ThreadingHTTPServer((bind, args.port), Handler)
    except OSError as e:
        if args.no_browser:  # headless / Docker: a real error
            print(f"{APP_NAME}: cannot listen on {bind}:{args.port}: {e}", file=sys.stderr, flush=True)
            sys.exit(1)
        # Port taken - most likely the app is already running; just open it.
        webbrowser.open(url)
        return
    print(f"{APP_NAME} running at {url}  (listening on {bind}:{args.port}, config {CONF_PATH})", flush=True)
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
