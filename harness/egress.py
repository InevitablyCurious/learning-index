"""Egress contract for sandboxed bench worker cells.

Single source of truth for the worker/egress-sidecar network contract
(WO-BENCH-WORKER-SANDBOX-HARDENING).

Contract:
- The worker container runs on EGRESS_NETWORK, a Docker network created with
  ``--internal``: it has ZERO internet route and no direct host access.
- The worker reaches the model API, the okp MCP, and the hub ONLY through
  a per-run egress sidecar container whose name is
  ``egress_container_name(run_label)``. The sidecar is attached to BOTH
  EGRESS_NETWORK and the routable bench network.
- The sidecar forwards four fixed listening ports to four allowlisted
  upstreams (the port->upstream map is duplicated verbatim in
  images/sidecar/egress-sidecar.js, which this module defines the contract
  for):
    EGRESS_LOCAL_MODEL_PORT (4545) -> http://host.docker.internal:4545
                                      (local model relay)
    EGRESS_CLOUD_MODEL_PORT (8443) -> EGRESS_CLOUD_UPSTREAM
                                      (https://api.orcarouter.ai)
    EGRESS_MCP_PORT         (4550) -> http://host.docker.internal:4550
    EGRESS_HUB_PORT         (4440) -> http://host.docker.internal:4440
- Ingress forward (WO-25): when EGRESS_INGRESS_CELL_HOST_ENV is set, the
  sidecar additionally listens on EGRESS_INGRESS_PORT_ENV and forwards to the
  named cell container's serve port, so host :4096 reaches the cell's
  live-view `opencode serve` while the cell stays internal-only.
- Worker-facing URLs are plain HTTP to the sidecar; cloud TLS is terminated
  at the sidecar.

Stdlib only by design: importable from any harness context without deps.
"""

import hashlib

EGRESS_NETWORK = "bench-internal"
EGRESS_LOCAL_MODEL_PORT = (
    4545  # sidecar listens 4545 -> host.docker.internal:4545 (local relay)
)
EGRESS_CLOUD_MODEL_PORT = (
    8443  # sidecar listens 8443 -> https://api.orcarouter.ai (cloud)
)
EGRESS_MCP_PORT = 4550  # sidecar listens 4550 -> host.docker.internal:4550
EGRESS_HUB_PORT = 4440  # sidecar listens 4440 -> host.docker.internal:4440
EGRESS_CLOUD_UPSTREAM = "https://api.orcarouter.ai"

# Ingress forward (WO-25): the sidecar publishes host serve_host_port -> the
# cell's serve_container_port, so the live-view `opencode serve` stays reachable
# while the cell itself remains on the --internal network only. Read by
# images/sidecar/egress-sidecar.js via env (names MUST match the JS literals).
EGRESS_INGRESS_CELL_HOST_ENV = "OKP_INGRESS_CELL_HOST"
EGRESS_INGRESS_PORT_ENV = "OKP_INGRESS_PORT"


def egress_container_name(run_label: str) -> str:
    """Deterministic DNS-safe sidecar container name for a run."""
    return f"okp-egress-{hashlib.sha256(run_label.encode('utf-8')).hexdigest()[:12]}"


def worker_model_base_url(run_label: str, *, cloud: bool) -> str:
    """OpenAI-compatible model base URL the worker uses (via the sidecar)."""
    port = EGRESS_CLOUD_MODEL_PORT if cloud else EGRESS_LOCAL_MODEL_PORT
    return f"http://{egress_container_name(run_label)}:{port}/v1"
