# Baseline history — every platform build stamp the guard has superseded

`.task-baseline` is the reference of record and stays short: check 6 keeps
the newest `PROTECTED_BASELINE_HISTORY` (default 10) superseded stamps in it.
This file is the complete, append-only record: the guard copies every
superseded stamp here *before* it trims, so the cap is a display limit and
never data loss. Written by `scripts/check-4-tasks.sh` (check 6); rows are
appended as the guard sees them, and a stamp is never added twice.

| Stamp | Recorded | Superseded | Replaced by | Note |
|---|---|---|---|---|
| `20261113T212057Z-50da370bf26a` | 2026-11-15T13:44:27Z | 2026-11-24T11:34:29Z | `20261123T234400Z-ab2c2501a060` | platform rollout, fleet-wide |
| `20261123T234400Z-ab2c2501a060` | 2026-11-24T11:34:29Z | 2026-11-25T11:36:02Z | `20261124T221653Z-e69b633e242e` | platform rollout, fleet-wide |
