# ChestTracker69 — Chest Data Rules

These rules exist to prevent bad data from entering the system. Any future work must follow them. If a proposed change would violate a rule, stop and question the approach.

---

## Rule 1 — Use breakdown, not individual chest records, for type counts
The CT `/chests/breakdown` endpoint is the only reliable source of chest type counts per player. Individual chest records (`/chests`) cannot be reliably linked to definitions (CT removed `definitionId` and `externalIds` is null). Do not attempt to count chest types from individual chest records.

## Rule 2 — Daily windows for granularity
Call breakdown with 24-hour windows aligned to the weekly reset boundary (17:00 UTC → 17:00 UTC) to get daily data. One call per day per clan.

## Rule 3 — Chest type label = breakdown key exactly
Event/type names used in charts come from breakdown keys as CT returns them ("epic squad", "dark omens", "ancients", etc.). No remapping, no renaming, no inference.

## Rule 4 — Rewards never determine chest classification
The `reward` field on a chest record is stored as-is and is never used to infer or set `chest_name`, `chest_source`, or `chest_type`. Ever.

## Rule 5 — Active event name is supplementary only
If CT's API probe returns an active event name (e.g., "Ascendant Ashen Squad"), it may be displayed as a label alongside the breakdown key. It never replaces or overwrites the breakdown key as the source of truth.

## Rule 6 — Store snapshots, don't compute live
Daily breakdown data is persisted to the database so charts never require live CT API calls at read time. History accumulates over time via the hourly sync.

## Rule 7 — chest_name / chest_source / chest_type must come from definitions only
These three fields in the `chests` table may only be populated from a matched row in the `definitions` table:
- `chest_name` ← `definitions.name`
- `chest_source` ← `definitions.source`
- `chest_type` ← `definitions.type`

If no definition row can be matched, the field stays `null`. No other source may write to these fields.

## Rule 8 — "Guard" must never appear in chest_name, chest_source, or chest_type
If any of these three fields is about to be populated with a value containing the string "Guard" (case-insensitive), **stop immediately** — something is broken. "Guard" belongs to the `reward` field (`guardsLevel`) and is a game mechanic, not a chest identifier. Its presence in classification fields means reward data or some other wrong source is leaking into definition fields. This is a hard stop: null is always preferable to a wrong value.

---

## Current API Limitations (as of October 2026)
- CT chest records no longer include `definitionId`
- CT `/definitions` endpoint returns `externalIds: null` for Epic Squad chest types
- `?include=definition` on the `/chests` endpoint does not embed definition data
- `externalId` on individual chest records is a unique-per-scan instance ID, not a type ID — cannot be used for definition matching
- Consequence: `chest_name`, `chest_source`, `chest_type` are currently null for all chest records. This is expected and correct given the above.
