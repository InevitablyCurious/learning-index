# syntax=docker/dockerfile:1.7
#
# THE GRADING IMAGE — the instrument, pinned as tightly as the corpus.
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
#
# The candidate is BUILT inside okp-bench-worker (node:22.12.0, digest-pinned)
# and used to be GRADED on whatever the operator had installed. Four things
# differed: Node, Playwright, Chromium, and vitest — the last declared as
# `^2.1.0`, a RANGE, so a reinstall could silently swap the test runner. And
# `grader_hash` excludes node_modules, so nothing recorded which one ran.
#
# The corpus is frozen byte-for-byte and a run aborts on a mismatch. The thing
# measuring it was whatever `npm install` produced that day. This closes that.
#
# ── WHAT MUST MATCH, AND WHAT MUST MERELY BE FIXED ──────────────────────────
#
# MATCH the worker: **Node**. It is what executes the candidate's server.ts,
# game.ts and ai.ts, so it is part of the artifact's runtime. The digest below
# is the same one docker/worker/Dockerfile pins, and a meta test reads both
# files and fails if they ever drift apart.
#
# FIXED, but free to differ from the worker: Playwright, Chromium, vitest.
# These are measuring tools, not the game's runtime. They only have to be
# identical across runs — the artifact never calls them.
FROM node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213

# Content-addressed identity, baked at build time by scripts/rebuild_grader_image.py.
# Freshness is asked the way docker answers it — same bytes in the image as on
# disk means current — rather than by an mtime docker never moves on a cache hit.
ARG OKP_GRADER_SOURCE_DIGEST=unknown
LABEL okp.grader.source_digest="${OKP_GRADER_SOURCE_DIGEST}"

ENV DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    # The gates resolve the candidate through BENCH_TARGET; the mount point is
    # fixed by the image so no caller has to agree with it separately.
    BENCH_TARGET=/candidate

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates procps lsof; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /gates

# THE LOCKFILE IS THE TOOLCHAIN. Copied alone and installed before the test
# sources, so editing a gate does not re-resolve dependencies — and so this
# layer's cache key IS the pinned toolchain.
COPY package.json package-lock.json ./

# `npm ci`, never `npm install`: ci installs exactly the lockfile and FAILS if
# package.json and the lock disagree. `install` would quietly resolve a newer
# version and hand us back the problem this image exists to remove.
RUN set -eux; \
    npm ci; \
    npx playwright install --with-deps chromium; \
    chmod -R a+rX /opt/ms-playwright

# The gates themselves. Last, so a gate edit rebuilds only this layer.
COPY . /gates

# Grading writes exactly one artifact, to a mounted directory. Everything else
# it touches is read-only.
VOLUME ["/out"]

# Runs as a normal user: this container handles untrusted model output, and
# nothing it does needs root.
# The node base already owns uid 1000 (`node`), so reuse it rather than fighting
# for the number — same approach as docker/worker/Dockerfile. Matching the
# worker's uid also keeps file ownership sane across the two images when they
# see the same mounted worktree.
RUN set -eux; \
    if id -u grader >/dev/null 2>&1; then \
      :; \
    elif id -u node >/dev/null 2>&1 && [ "$(id -u node)" = "1000" ]; then \
      groupmod -n grader node; \
      usermod -l grader -d /home/grader -m node; \
    else \
      useradd --uid 1000 --create-home --shell /bin/bash grader; \
    fi; \
    chown -R grader:grader /gates
USER grader

ENTRYPOINT ["node", "report.mjs"]
