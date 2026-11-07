# Pelican GUI - container image
#
# Build from the PROJECT ROOT (the folder that has pelican_gui.py):
#   docker build -f docker/Dockerfile -t pelican-gui .
# or simply:
#   cd docker && docker compose build
#
# The app uses only the Python standard library: no pip install, no build step.

FROM python:3.12.7-slim-bookworm

LABEL org.opencontainers.image.title="Pelican GUI" \
      org.opencontainers.image.description="Local web dashboard for Pelican Wireless thermostats"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # --- app settings (override in docker-compose.yml / .env / docker run -e) ---
    PELICAN_PORT=8765 \
    PELICAN_BIND=0.0.0.0 \
    PELICAN_CONF=/data/pelican.conf \
    PELICAN_NO_BROWSER=1 \
    PELICAN_NO_QUIT=1

# Unprivileged user; /data holds pelican.conf (recent sites, refresh interval - never passwords)
RUN groupadd --system --gid 10001 pelican \
 && useradd --system --uid 10001 --gid pelican --home-dir /app --shell /usr/sbin/nologin pelican \
 && mkdir -p /app /data \
 && chown pelican:pelican /data

WORKDIR /app
COPY --chown=root:root pelican_gui.py /app/
COPY --chown=root:root static/ /app/static/

USER pelican
VOLUME ["/data"]
EXPOSE 8765

# Healthy = the web page is being served (no Pelican login needed).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/' % os.environ.get('PELICAN_PORT','8765'), timeout=4)"]

ENTRYPOINT ["python", "/app/pelican_gui.py"]
