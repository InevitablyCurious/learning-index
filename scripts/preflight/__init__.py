"""Check families for scripts/bench_preflight.py (WO LI-13 split).

The runnable entrypoint (scripts/bench_preflight.py) stays thin: it owns the
monkeypatch seam (port_open/check_ports), the regex-pinned TOOL_* remedy ids,
and main()'s run order. Each check family lives in its own module here and
imports the shared scaffolding from preflight.core.
"""
