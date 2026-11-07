@echo off
REM Build the Pelican GUI image (does not start a container).
cd /d "%~dp0"
docker compose build %*
if errorlevel 1 exit /b 1
echo Built image pelican-gui:latest. Start it with:  docker compose up -d
