# Globle Discord Activity: one image serving the activity client and the game API.
#
# Two stages, so the host needs no Node install for either the build or the run.
# The client is compiled to static files in the first stage and copied into the
# runtime image, which carries no build tooling.
#
# The application id is baked into the client bundle at build time, because the
# Embedded App SDK needs it before the page can make any request. It is not a
# secret -- every player's Discord client sees it -- unlike CLIENT_SECRET, which
# stays on the server and never enters an image layer.
#
# The result card is drawn with @napi-rs/canvas, whose prebuilt binaries the
# lockfile pins for every platform it publishes, so `npm ci` resolves the right
# one and the image still builds on a 64-bit Raspberry Pi. The typeface travels
# as a dependency too, because this base image carries no fonts.

FROM node:22-bookworm-slim AS client

ARG VITE_DISCORD_CLIENT_ID
ENV VITE_DISCORD_CLIENT_ID=${VITE_DISCORD_CLIENT_ID}

WORKDIR /build
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build


FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Server dependencies first, so this layer stays cached until they change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Server source and the bundled official country dataset.
COPY src/ ./src/
COPY data/ ./data/
COPY deploy-commands.js ./

COPY --from=client /build/dist ./client/dist

# Per-user game state is written here. Mounting a volume at /data keeps player
# history across restarts and rebuilds; store.js reads STATE_FILE first.
ENV STATE_FILE=/data/state.json
ENV PORT=3000
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

# Unlike the bot-only image this replaces, this one serves HTTP: Discord's proxy
# fetches the activity from here through the tunnel.
EXPOSE 3000

CMD ["node", "src/index.js"]
