"""Single source of truth for the data-contract epoch.

Every run manifest and wire artifact that carries a system epoch MUST import
``SYSTEM_EPOCH`` from here -- never copy the literal string.
"""

SYSTEM_EPOCH = "2026-11-08"

__all__ = ["SYSTEM_EPOCH"]
