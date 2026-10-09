# Stadtsimulation für den Raspberry Pi 4 (linux/arm64) – läuft aber auch auf x86-64.
# Basis-Image (bei Bedarf z. B. --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-alpine)
ARG NODE_IMAGE=node:22-alpine

# Stufe 1: Modelle aus den Kenney-ZIPs auspacken und three.js bereitstellen
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY Assets ./Assets
COPY scripts/prepare-assets.mjs ./scripts/prepare-assets.mjs
RUN node scripts/prepare-assets.mjs

# Stufe 2: schlankes Laufzeit-Image (Server ohne weitere Abhängigkeiten)
FROM ${NODE_IMAGE}
# Zeitzonen kommen aus der ICU-Bibliothek von Node.js (TZ=Europe/Berlin genügt).
# Der Server startet als root, macht /data beschreibbar und läuft dann als „node“.
ENV NODE_ENV=production \
    PORT=8080 \
    DATEN_VERZEICHNIS=/data \
    LAUFZEIT_BENUTZER=node
WORKDIR /app
COPY --from=build /app/build ./build
COPY package.json ./
COPY server ./server
COPY client ./client
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/status" > /dev/null || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "--max-old-space-size=256", "server/index.js"]
