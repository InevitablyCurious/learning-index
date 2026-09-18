# ─────────────────────────────────────────────────────────────────────────────
# Bench Dashboard — serves the board's files and relays /api/* to the control
# plane on the host. It reads no run data and mounts nothing.
#
#   docker compose up -d          (from dashboard/)
#   open http://localhost:8717
#
# Zero dependencies, no build step, no package.json.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-alpine

# tini so the container stops on the first `docker stop` instead of waiting
# out the 10s SIGKILL timeout.
RUN apk add --no-cache tini

WORKDIR /app

COPY server.mjs board.js board-actions.js overlay.js dom.js index.html history.html history.js ./
COPY lib/ ./lib/
COPY panels/ ./panels/
# Vendored xterm.js and diff2html (MIT, prebuilt): static files, not installed.
COPY vendor/ ./vendor/

# Bind all interfaces INSIDE the container; the published port (compose
# `ports:`) decides who can reach it.
ENV OKP_DASH_HOST=0.0.0.0 \
    OKP_DASH_PORT=8717 \
    NODE_ENV=production

USER node

EXPOSE 8717

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.OKP_DASH_PORT||8717)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.mjs"]
