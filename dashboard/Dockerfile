# ─────────────────────────────────────────────────────────────────────────────
# Bench Dashboard
#
#   docker compose up -d          (from bench/dashboard/)
#   open http://localhost:8717
#
# Single stage on purpose: there is nothing to build. The dashboard has zero
# dependencies and no build step, so a builder stage would produce nothing and
# only add a layer to keep in sync.
#
# The image carries `postgresql-client` solely for the OPT-IN `hub-db` source,
# which is disabled by default. It connects over TCP — the docker socket is
# NEVER mounted, because handing a read-only dashboard control of the host's
# docker daemon to read four tables is an absurd trade.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-alpine

# psql for the opt-in hub-db source; tini so the container stops on the first
# Ctrl-C / `docker stop` instead of waiting out the 10s SIGKILL timeout.
RUN apk add --no-cache postgresql16-client tini

WORKDIR /app

# No package.json, no install: the whole point is zero dependencies. If a
# package.json ever appears here, something has been added that should not be.
COPY contract.mjs server.mjs run-liveness.mjs board.js board-actions.js overlay.js dom.js index.html history.html history.js ./
# server.mjs's extracted modules (board-build / broadcast / tui / state) —
# without this line `node server.mjs` crashes on import inside the image.
COPY lib/ ./lib/
COPY panels/ ./panels/
# Vendored xterm.js + WebGL addon (MIT, prebuilt UMD). Static assets, not a
# package-manager dependency: nothing installs or compiles them.
COPY vendor/ ./vendor/
COPY sources/ ./sources/

# Bind all interfaces INSIDE the container. A process bound to the container's
# loopback is unreachable from a published port, so the host default of
# 127.0.0.1 would silently serve nothing. Exposure is still opt-in at the
# `ports:` / `-p` level — the container network namespace is the boundary.
ENV OKP_DASH_HOST=0.0.0.0 \
    OKP_DASH_PORT=8717 \
    OKP_DASH_BENCH_ROOT=/bench \
    NODE_ENV=production

# The bench artifacts are mounted READ-ONLY at /bench (see compose). The
# dashboard never writes anywhere, so the container also runs as a non-root
# user with no writable state of its own.
USER node

EXPOSE 8717

# Reports unhealthy if the board stops assembling — this is what makes the
# green/red dot in Docker Desktop meaningful rather than decorative.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.OKP_DASH_PORT||8717)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.mjs"]
