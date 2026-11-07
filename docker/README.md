# Pelican GUI in Docker

The image is small: Python 3.12 slim plus two app files, with no pip packages. It runs as an unprivileged user on a read-only filesystem.

```
pelican-gui/
├── .dockerignore          only pelican_gui.py + static/ are sent to the build
├── pelican_gui.py
├── static/
└── docker/
    ├── Dockerfile
    ├── docker-compose.yml
    ├── .env.example       copy to .env to change port / hostnames / trusted network
    ├── build.sh / build.bat   build the image only (doesn't start anything)
    └── README.md
```

## Build
```
cd docker
docker compose build            # or: ./build.sh   /   build.bat
```
Without Compose, run this from the project root:
```
docker build -f docker/Dockerfile -t pelican-gui .
```

## Run
```
cd docker
cp .env.example .env            # optional
docker compose up -d
```
Open `http://<docker-host-IP>:8765`. Each person signs in with their own Pelican site, email and password, exactly like the desktop version.

- **Stop:** `docker compose down`. The in-page Quit button is disabled in the container.
- **Logs:** `docker compose logs -f`
- **Update after code changes:** `docker compose up -d --build`

Without Compose:
```
docker run -d --name pelican-gui --restart unless-stopped --init \
  -p 8765:8765 -v pelican-data:/data pelican-gui
```

## Settings (environment variables)
| Variable | Default | What it does |
|---|---|---|
| `PELICAN_HOST_PORT` | 8765 | Port on the Docker host (Compose `.env` only) |
| `PELICAN_ALLOWED_HOSTS` | *(empty)* | Extra hostnames people type, e.g. `nas.local,pelican.home`. IP addresses always work. The app rejects other names, which blocks DNS-rebinding. |
| `PELICAN_TRUSTED_NETS` | *(empty)* | CIDRs treated like "the PC running the app". Sign-ins from them update the shared site list in `pelican.conf`. When empty, each browser keeps its own list. |
| `PELICAN_PUBLIC_URL` | *(empty)* | Address printed in the log |
| `PELICAN_PORT` | 8765 | Port inside the container |
| `PELICAN_CONF` | `/data/pelican.conf` | Config file location (on the `/data` volume) |
| `PELICAN_NO_QUIT` | 1 | Disables the Quit button |
| `TZ` | America/Chicago | Log time zone only. Pelican data always uses each site's own time. |

The same settings also exist as command-line flags. Run `python pelican_gui.py --help` to see them.

## Data and security
- **`/data/pelican.conf`** holds the refresh interval, recent sites and last email. **No passwords are ever written**: they stay in memory and are gone when the container stops. Everyone has to sign in again after a restart.
- **Volume ownership:** the named volume `pelican-data` is created with the right owner. If you use a bind mount instead (`./data:/data`), make the folder writable by UID 10001: `sudo chown 10001:10001 ./data`.
- **No HTTPS:** the app serves plain HTTP. Your Pelican password travels from the browser to the container unencrypted. That's fine on a trusted LAN, but if you expose it beyond that, put it behind a reverse proxy with HTTPS (Caddy, Traefik, nginx), and add the proxy's hostname to `PELICAN_ALLOWED_HOSTS`.
- **Outbound access:** the container needs HTTPS to `*.officeclimatecontrol.net`. It has no other dependencies.
- **Docker Desktop (Windows/Mac):** it may show every visitor as the Docker gateway address. If `PELICAN_TRUSTED_NETS` doesn't seem to apply, that's why. Leave it empty; each browser keeps its own site list.
