#!/usr/bin/env python3
"""Thin entrypoint for the canonical primary scored cumulative benchmark CLI.

The implementation lives in the ``run_cumulative`` package (the sibling directory
``scripts/run_cumulative/``). LI-14 split the original 2272-line module into
``run_cumulative/{paths,template,roster,runner,context}.py`` with
``run_cumulative/__init__.py`` as the facade that DEFINES the conductor functions
(so their ``__globals__`` is the package namespace and monkeypatching the package
reaches them). This file stays at the SAME path so ``python3 scripts/run_cumulative.py``
and every ``spec_from_file_location(... run_cumulative.py)`` consumer keep working:
it puts ``scripts/`` on sys.path, re-exports the full public/test-facing surface,
and delegates to ``main()``.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from run_cumulative import (  # noqa: E402
    DEFAULT_MANIFEST_PATH,
    DEFAULT_ON_BUDGET,
    DEFAULT_ORG_ID,
    DEFAULT_PROXY_RUNS_DIR,
    DEFAULT_SEED,
    DEFAULT_TASK_LABEL,
    FROZEN_TASK_TEMPLATE_HASH,
    GATE_ROSTER_TIMEOUT_S,
    IS_PRIMARY_SCORED_PATH,
    PROMPTS_DIR,
    REPO_ROOT,
    CliContext,
    PathLayout,
    RealSessionRunner,
    _NoopSessionRunner,
    _SessionRunState,
    _append_results_ledger,
    _apply_model_override,
    _build_arg_parser,
    _build_context,
    _build_real_runner,
    _build_roster,
    _compose_cloud_slug,
    _current_session_or_raise,
    _discover_bench_ports,
    _emit_predicate_outcomes,
    _handle_run,
    _handle_state,
    _mode_dir,
    _normalize_model_slug,
    _print_json,
    _provider_pin_from_model,
    _prune_runs_retention,
    _read_proxy_served_identity,
    _resolve_manifest_layout,
    _resolve_positive_int_env,
    _runs_root_from_args,
    _utc_now_iso,
    assert_primary_path,
    compute_task_template_hash,
    main,
    progress_from_cell_result,
    verify_task_template_frozen,
)

if __name__ == "__main__":
    raise SystemExit(main())
