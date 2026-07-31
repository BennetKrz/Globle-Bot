# Globle Discord Bot — container image.
#
# Build this ON the machine that will run it (your Raspberry Pi). npm then
# installs the matching @napi-rs/canvas native binary automatically — on a
# 64-bit Pi OS that's @napi-rs/canvas-linux-arm64-gnu. (Building on an x86
# machine would bake in the x86 binary, which won't run on the Pi.)
#
# bookworm-slim is glibc-based, which is what the -gnu canvas binary needs.
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Install production deps first so this layer is cached until deps change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source + the bundled official country dataset (data/*.json).
COPY . .

# Per-user game state is written here. Mounting a volume at /data keeps player
# history across container restarts/rebuilds (see docker-compose.yml).
# store.js reads STATE_FILE first, so this is all that's needed.
ENV STATE_FILE=/data/state.json
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

# NOTE: a Discord bot dials OUT to Discord's gateway over TLS. There is no
# inbound server, so there is no port to EXPOSE and no tunnel/reverse proxy.
CMD ["node", "src/index.js"]
