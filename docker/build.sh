#!/bin/sh
# Build the Pelican GUI image (does not start a container).
set -e
cd "$(dirname "$0")"
docker compose build "$@"
echo "Built image pelican-gui:latest. Start it with:  docker compose up -d"
