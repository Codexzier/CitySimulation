#!/usr/bin/env bash
# Lädt die Tagesergebnisse der Stadtsimulation in ein GitHub-Repository hoch
# (wie bei der RTS-Simulation). Gedacht für einen Cron-Job auf dem Raspberry Pi.
#
# Einmalig einrichten:
#   1. Ergebnis-Repository auf GitHub anlegen, z. B. "CitySimulationResults"
#   2. auf dem Pi klonen (SSH-Schlüssel oder Token müssen pushen dürfen):
#        git clone git@github.com:Codexzier/CitySimulationResults.git ~/CitySimulationResults
#   3. Cron-Job eintragen (crontab -e), täglich um 00:10 Uhr:
#        10 0 * * * /home/pi/CitySimulation/scripts/upload-ergebnisse.sh >> /home/pi/stadt-upload.log 2>&1
#
# Alle Einstellungen lassen sich über Umgebungsvariablen überschreiben.
set -euo pipefail

SIM_URL="${SIM_URL:-http://localhost:8080}"          # Adresse der laufenden Simulation
REPO_DIR="${REPO_DIR:-$HOME/CitySimulationResults}"  # lokaler Klon des Ergebnis-Repositorys
ZIEL_ORDNER="${ZIEL_ORDNER:-data}"                   # Unterordner im Repository
BRANCH="${BRANCH:-main}"
GIT_NAME="${GIT_NAME:-Stadt-Sim}"
GIT_MAIL="${GIT_MAIL:-stadt-sim@localhost}"
DATEIEN=(stadt_aktuell.json stadt_historie.json stadt_ereignisse.json stadt_karte.svg)

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "Fehler: $REPO_DIR ist kein Git-Repository (siehe Einrichtung oben)." >&2
  exit 1
fi

# Aktuellen Stand erzeugen und abholen
curl -fsS --max-time 60 "$SIM_URL/api/export" > /dev/null
mkdir -p "$REPO_DIR/$ZIEL_ORDNER"
for f in "${DATEIEN[@]}"; do
  curl -fsS --max-time 60 "$SIM_URL/export/$f" -o "$REPO_DIR/$ZIEL_ORDNER/$f.tmp"
  mv "$REPO_DIR/$ZIEL_ORDNER/$f.tmp" "$REPO_DIR/$ZIEL_ORDNER/$f"
done

cd "$REPO_DIR"
git pull --rebase --quiet origin "$BRANCH" || echo "Hinweis: git pull fehlgeschlagen, versuche trotzdem zu pushen"
git add "$ZIEL_ORDNER"
if git diff --cached --quiet; then
  echo "$(date +'%F %T') keine Änderungen"
  exit 0
fi

wert() { grep -o "\"$1\": *[0-9]*" "$ZIEL_ORDNER/stadt_aktuell.json" | head -1 | grep -o '[0-9]*$'; }
TAG="$(wert tag)"
EINWOHNER="$(wert einwohner)"
git -c user.name="$GIT_NAME" -c user.email="$GIT_MAIL" \
  commit -q -m "Stadt $(date +'%Y-%m-%d %H:%M') (Tag ${TAG:-?}, ${EINWOHNER:-?} Einwohner)"
git push -q origin "$BRANCH"
echo "$(date +'%F %T') hochgeladen: Tag ${TAG:-?}, ${EINWOHNER:-?} Einwohner"
