# Broward Transit 3D: one container running the API, feed poller, nightly timetable rebuild and web app.
# On first start with an empty /app/data volume it builds the static timetable from BCT's GTFS (~1 min).
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=8787

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY scripts ./scripts
COPY web ./web

# Built timetable (public/data) and the reliability log (data/reliability).
# Mount volumes here so they survive redeploys; without them each new container rebuilds the
# timetable and starts its reliability history from scratch.
RUN mkdir -p data public/data && chown -R node:node /app
VOLUME ["/app/data", "/app/public/data"]
USER node

EXPOSE 8787
# /api/health answers 503 when the feed or timetable is down; busybox wget fails on that.
HEALTHCHECK --interval=60s --timeout=5s --start-period=120s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/api/health || exit 1

CMD ["node", "server/index.mjs"]
