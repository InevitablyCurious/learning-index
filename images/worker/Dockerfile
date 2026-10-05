# syntax=docker/dockerfile:1.7

# Optional memory-plugin build seam: scripts/rebuild_worker_image.py passes the
# BENCH_PLUGIN_DIR package as
#   --build-context okp-plugin=<dir> --build-arg OKP_PLUGIN_CONTEXT=okp-plugin
# plus BENCH_PLUGIN_ENTRY (the file opencode loads, read from the package's own
# package.json) and BENCH_PLUGIN_ID (name@version). Any opencode plugin package
# fits. A vanilla `docker build` omits them, so OKP_PLUGIN_CONTEXT defaults to the
# empty `no-plugin` stage below and the conditional plugin install is skipped with
# no error. (COPY --from= does not expand variables, hence the FROM ${ARG} AS stage
# workaround.)
#
# The plugin is baked but NOT listed in the image-level opencode.json below: a
# cell loads it only when the per-cell config lists it, which only memory-ON cells
# do. One image therefore serves both arms.
#
# Sidecar build-context seam: the sidecar files (egress-sidecar.js,
# loop-kill-scanner.cjs, supervised-shell.js) live in images/sidecar/, outside
# this build context. The dev build passes
#   --build-context sidecar=images/sidecar --build-arg SIDECAR_CONTEXT=sidecar
# A vanilla `docker build` omits both, so SIDECAR_CONTEXT defaults to the
# empty `no-sidecar` stage below (same FROM ${ARG} AS stage workaround as the
# plugin seam — COPY --from= does not expand variables).
#
# Both ARGs MUST precede the first FROM: an ARG declared after a FROM is scoped
# to that stage, so a later `FROM ${ARG}` sees it blank and the build fails.
ARG OKP_PLUGIN_CONTEXT=no-plugin
ARG SIDECAR_CONTEXT=no-sidecar

FROM scratch AS no-plugin
FROM ${OKP_PLUGIN_CONTEXT} AS plugin-source

FROM scratch AS no-sidecar
FROM ${SIDECAR_CONTEXT} AS sidecar-source

FROM node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213

ARG OPENCODE_VERSION=1.18.20
ARG PLAYWRIGHT_VERSION=1.48.0

ENV DEBIAN_FRONTEND=noninteractive \
    XDG_CONFIG_HOME=/etc/xdg \
    OPENCODE_CONFIG_DIR=/etc/xdg/opencode \
    OPENCODE_CONFIG=/etc/xdg/opencode/opencode.json \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FETCH_RETRIES=0 \
    NPM_CONFIG_FETCH_TIMEOUT=5000 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=1000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=1000 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git ca-certificates procps curl; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    npm i -g "opencode-ai@${OPENCODE_VERSION}"; \
    npm i -g "@ai-sdk/openai-compatible@3.0.40"; \
    opencode --version

# Shipped browser dep: the agent must never need to install chromium at
# runtime. Build-time apt as root is fine; browsers land in
# PLAYWRIGHT_BROWSERS_PATH and are made world-readable for the worker user.
RUN set -eux; \
    npm i -g "playwright@${PLAYWRIGHT_VERSION}"; \
    npx playwright install --with-deps chromium; \
    chmod -R a+rX /opt/ms-playwright; \
    rm -rf /var/lib/apt/lists/*

# Make globally installed packages require()-able from any cwd (e.g. agent
# scripts under /work): node's module search does not include the global
# root otherwise. No build-time dependency, so it sits after the cached
# browser layer.
ENV NODE_PATH=/usr/local/lib/node_modules

RUN set -eux; \
    if id -u worker >/dev/null 2>&1; then \
      :; \
    elif id -u node >/dev/null 2>&1 && [ "$(id -u node)" = "1000" ]; then \
      groupmod -n worker node; \
      usermod -l worker -d /home/worker -m node; \
    else \
      useradd --uid 1000 --create-home --shell /bin/bash worker; \
    fi; \
    mkdir -p /work /etc/xdg/opencode; \
    chmod 0777 /work /etc/xdg/opencode

# Memory plugin install, when a plugin package is provided. Without one, image
# isolation is intact and the image is vanilla.
# NOTE: --install-links=true is REQUIRED — a plain `npm i -g <dir>` creates a SYMLINK into
# /opt/docker-worker-context, which the cleanup step below deletes (dangling plugin path).
COPY . /opt/docker-worker-context
COPY --from=plugin-source / /opt/docker-worker-context/vendor/opencode-plugin/
COPY --from=sidecar-source / /opt/docker-worker-context/sidecar/

ARG BENCH_PLUGIN_ENTRY=
RUN set -eux; \
    mkdir -p /opt/bench; \
    cp /opt/docker-worker-context/self-compact.ts /opt/bench/self-compact.ts; \
    chmod 0644 /opt/bench/self-compact.ts; \
    if [ -f /opt/docker-worker-context/vendor/opencode-plugin/package.json ]; then \
      test -n "${BENCH_PLUGIN_ENTRY}"; \
      npm i -g --install-links=true /opt/docker-worker-context/vendor/opencode-plugin; \
      pkg_name="$(node -p 'require("/opt/docker-worker-context/vendor/opencode-plugin/package.json").name')"; \
      ln -s "$(npm root -g)/${pkg_name}" /opt/bench-plugin; \
      test -f "/opt/bench-plugin/${BENCH_PLUGIN_ENTRY}"; \
    else \
      echo "NOTE: no memory plugin provided; the image is vanilla."; \
    fi; \
    node - <<'NODE'
const fs = require("node:fs")
// Benchmark-native self-compaction: wired into EVERY image, with or without a
// memory plugin. It self-gates on BENCH_SELF_COMPACT=1, so a cell that did not
// ask for compaction loads it and nothing happens. The memory plugin is NOT
// listed here: only a memory-ON cell's own config lists it.
const selfCompactPath = "/opt/bench/self-compact.ts"
const config = {
  $schema: "https://opencode.ai/config.json",
  shell: "/opt/okp/supervised-shell.js",
  plugin: [selfCompactPath],
}
fs.mkdirSync("/etc/xdg/opencode", { recursive: true })
fs.writeFileSync("/etc/xdg/opencode/opencode.json", `${JSON.stringify(config, null, 2)}\n`, "utf8")
NODE

RUN set -eux; \
    chmod 0666 /etc/xdg/opencode/opencode.json; \
    test -f /opt/bench/self-compact.ts; \
    mkdir -p /opt/okp; \
    cp /opt/docker-worker-context/sidecar/egress-sidecar.js /opt/okp/egress-sidecar.js; \
    cp /opt/docker-worker-context/sidecar/loop-kill-scanner.cjs /opt/okp/loop-kill-scanner.cjs; \
    cp /opt/docker-worker-context/sidecar/supervised-shell.js /opt/okp/supervised-shell.js; \
    chmod 0755 /opt/okp /opt/okp/egress-sidecar.js /opt/okp/loop-kill-scanner.cjs /opt/okp/supervised-shell.js; \
    rm -rf /opt/docker-worker-context

# ── SOURCE DIGEST ───────────────────────────────────────────────────────────
# What this image was built FROM, so freshness can be asked as a content
# question. Timestamps cannot answer it: a content-identical rebuild is a full
# cache hit, keeps the same image id, and keeps its original .Created — so an
# mtime comparison reports "stale" forever and no rebuild ever clears it.
#
# Last instruction on purpose: a label layer is free and busts nothing above it.
# Written by scripts/rebuild_worker_image.py, read by scripts/bench_preflight.py.
ARG OKP_WORKER_SOURCE_DIGEST=unset
LABEL okp.worker.source_digest=$OKP_WORKER_SOURCE_DIGEST
ARG OKP_PLUGIN_PRESENT=0
LABEL okp.worker.plugin_present=$OKP_PLUGIN_PRESENT
# The baked memory plugin: the file a memory-ON cell lists in its opencode
# config (relative to /opt/bench-plugin) and the package's name@version.
ARG BENCH_PLUGIN_ID=
LABEL bench.worker.plugin_entry=$BENCH_PLUGIN_ENTRY
LABEL bench.worker.plugin_id=$BENCH_PLUGIN_ID

WORKDIR /work
USER worker
