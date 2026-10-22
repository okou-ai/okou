# Historical Pi memory billing ledger

Pi memory extraction and consolidation are retired. `v1/ledger.sql` remains the
read-only raw/hourly usage reconciliation query used by the DB package's
`billing:pi-memory-stage1` report and its current-schema cost tests. Historical
charges remain supported; this directory no longer defines worker health alerts
or deployment operations.
