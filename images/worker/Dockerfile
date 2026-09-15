# syntax=docker/dockerfile:1.7

# Optional-plugin build seam: the dev build passes
#   --build-context okp-plugin=dev/benchmark/opencode-plugin --build-arg OKP_PLUGIN_CONTEXT=okp-plugin
# A vanilla `docker build` omits both, so OKP_PLUGIN_CONTEXT defaults to the empty
# `no-plugin` stage below and the conditional plugin install is skipped with no error.
# (COPY --from= does not expand variables, hence the FROM ${ARG} AS stage workaround.)
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

# Attempt vendored plugin wiring when images/worker/vendor/opencode-plugin is provided.
# If the vendored plugin is absent, image isolation remains intact; ON-cell plugin validation is
# handled separately by bench smoke (out of scope for this chunk).
# NOTE: --install-links=true is REQUIRED — a plain `npm i -g <dir>` creates a SYMLINK into
# /opt/docker-worker-context, which the cleanup step below deletes (dangling plugin path).
COPY . /opt/docker-worker-context
COPY --from=plugin-source / /opt/docker-worker-context/vendor/opencode-plugin/
COPY --from=sidecar-source / /opt/docker-worker-context/sidecar/

RUN set -eux; \
    plugin_path=""; \
    self_compact_path=""; \
    if [ -f /opt/docker-worker-context/vendor/opencode-plugin/package.json ]; then \
      npm i -g --install-links=true /opt/docker-worker-context/vendor/opencode-plugin; \
      pkg_name="$(node -p 'require("/opt/docker-worker-context/vendor/opencode-plugin/package.json").name')"; \
      ln -s "$(npm root -g)/${pkg_name}" /opt/bench-plugin; \
      plugin_path="/opt/bench-plugin/plugins/plugin.ts"; \
      test -f "${plugin_path}"; \
      self_compact_path="/opt/bench-plugin/plugins/self-compact.ts"; \
      test -f "${self_compact_path}"; \
    else \
      echo "NOTE: vendored opencode-plugin missing; opencode plugin remains disabled in-image."; \
    fi; \
    OKP_PLUGIN_PATH="${plugin_path}" OKP_SELF_COMPACT_PATH="${self_compact_path}" node - <<'NODE'
const fs = require("node:fs")
const pluginPath = (process.env.OKP_PLUGIN_PATH || "").trim()
const selfCompactPath = (process.env.OKP_SELF_COMPACT_PATH || "").trim()
const config = {
  $schema: "https://opencode.ai/config.json",
  shell: "/opt/okp/supervised-shell.js",
}
if (pluginPath) {
  config.plugin = [pluginPath, selfCompactPath].filter(Boolean)
  config.mcp = {
    okp: {
      "//": "disabled by design: the plugin supplies its own MCP transport, do not auto-spawn local MCP",
      enabled: false,
    },
  }
}
fs.mkdirSync("/etc/xdg/opencode", { recursive: true })
fs.writeFileSync("/etc/xdg/opencode/opencode.json", `${JSON.stringify(config, null, 2)}\n`, "utf8")
NODE

RUN set -eux; \
    chmod 0666 /etc/xdg/opencode/opencode.json; \
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

WORKDIR /work
USER worker
