# Axiom query validation receipts (#34433)

Validation is read-only. No dataset, monitor, notifier or production configuration was written. These are parser/query receipts, not active-alert or delivery receipts.

## Source identity

| File                                     | SHA-256                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| [cost.apl](cost.apl)                     | `07e44e33dbd8fed0950ee06f62ebcaddbb860980c12121bc04babf3f9667e1be` |
| [health.apl](health.apl)                 | `240406475a459e8362a4ec9a7e10f6690692fa766e73145a08890d83526b7099` |
| [fixtures.json](fixtures.json)           | `a7fc2cc9326762ec55d981cd345e59293ed51f8b460efc20c63498b00b879037` |
| [query-fixtures.mjs](query-fixtures.mjs) | `b72f13043498d6ef4f5282f34af039a5549fdca34619376134e57b3528c953e8` |
| [validate-apl.mjs](validate-apl.mjs)     | `e450df332a2c73b81af8e5e3634994702259475ac3ad4cab72454b7b7342b64f` |

## Exact production requests

Executed 2026-09-15T17:08:54.290Z through 2026-09-15T17:08:55.415Z.

`POST https://api.axiom.co/v1/datasets/_apl?format=tabular`

For each request, `apl` is the linked file text above, byte-for-byte; no fixture binding or clock substitution is applied. JSON request members:

```json
{
  "apl": "<exact cost.apl or health.apl bytes at the SHA-256 above>",
  "startTime": "2026-09-15T16:22:40.786857Z",
  "endTime": "2026-09-15T16:27:40.786857Z"
}
```

| Query      | HTTP | isPartial | Dataset             | Result                                                  |
| ---------- | ---- | --------- | ------------------- | ------------------------------------------------------- |
| cost.apl   | 200  | false     | `vm0-web-logs-prod` | `[]`                                                    |
| health.apl | 200  | false     | `vm0-web-logs-prod` | `[{"incidentDay":"2026-09-15","healthProblemCount":0}]` |

Both responses carried `query_range_alignment` (bucket alignment) warnings, with `isPartial=false`. The internal observation range remains bounded to today plus the previous two UTC days. Root `_time`, `source`, and `level` are the existing logger envelope; every D-specific field uses nullable `ensure_field` access. The controller's original-file request in this same window failed with `invalid field: "fields.billingMode"`; no schema bootstrap was performed.

Cost has no daily rows; health reports no detected problems. While PiMemory is off for everyone this is expected inactivity. Ingestion completeness, destination and delivery remain unproven.

Full sanitized production response bodies:

<details>
<summary>cost.apl: HTTP 200</summary>

```json
{
  "format": "tabular",
  "status": {
    "elapsedTime": 141226,
    "blocksExamined": 7,
    "blocksCached": 0,
    "blocksMatched": 0,
    "blocksSkipped": 0,
    "rowsExamined": 128926,
    "rowsMatched": 0,
    "bytesRead": 699531,
    "numGroups": 0,
    "isPartial": false,
    "cacheStatus": 1,
    "minBlockTime": "2026-09-11T06:09:38.001Z",
    "maxBlockTime": "2262-04-11T23:47:16.854775807Z",
    "messages": [
      {
        "priority": "warn",
        "count": 1,
        "code": "query_range_alignment",
        "msg": "Query range has been adjusted, to align to buckets"
      }
    ]
  },
  "tables": [
    {
      "name": "0",
      "sources": [
        {
          "name": "vm0-web-logs-prod"
        }
      ],
      "fields": [
        {
          "name": "accountingDay",
          "type": "unknown"
        },
        {
          "name": "grossCreditValueUsd",
          "type": "float",
          "agg": {
            "name": "computed",
            "fields": ["nanoUsd"]
          }
        }
      ],
      "order": [
        {
          "field": "grossCreditValueUsd",
          "desc": true
        }
      ],
      "groups": [
        {
          "name": "accountingDay"
        }
      ],
      "range": {
        "field": "_time",
        "start": "0001-01-01T00:00:00Z",
        "end": "2262-04-11T23:47:16.854775807Z"
      },
      "columns": [[], []]
    }
  ],
  "datasetNames": ["vm0-web-logs-prod"],
  "fieldsMetaMap": {}
}
```

</details>

<details>
<summary>health.apl: HTTP 200</summary>

```json
{
  "format": "tabular",
  "status": {
    "elapsedTime": 90583,
    "blocksExamined": 38,
    "blocksCached": 0,
    "blocksMatched": 0,
    "blocksSkipped": 0,
    "rowsExamined": 644634,
    "rowsMatched": 4,
    "bytesRead": 3648055,
    "numGroups": 1,
    "isPartial": false,
    "cacheStatus": 9,
    "minBlockTime": "2026-09-11T06:09:38.001Z",
    "maxBlockTime": "2262-04-11T23:47:16.854775807Z",
    "messages": [
      {
        "priority": "warn",
        "count": 1,
        "code": "query_range_alignment",
        "msg": "Query range has been adjusted, to align to buckets"
      }
    ]
  },
  "tables": [
    {
      "name": "0",
      "sources": [
        {
          "name": "vm0-web-logs-prod"
        }
      ],
      "fields": [
        {
          "name": "incidentDay",
          "type": "string"
        },
        {
          "name": "healthProblemCount",
          "type": "float",
          "agg": {
            "name": "sum",
            "fields": ["healthProblemCount"]
          }
        }
      ],
      "order": [
        {
          "field": "healthProblemCount",
          "desc": true
        }
      ],
      "groups": [
        {
          "name": "incidentDay"
        }
      ],
      "range": {
        "field": "_time",
        "start": "0001-01-01T00:00:00Z",
        "end": "2262-04-11T23:47:16.854775807Z"
      },
      "columns": [["2026-09-15"], [0]]
    }
  ],
  "datasetNames": ["vm0-web-logs-prod"],
  "fieldsMetaMap": {}
}
```

</details>

## Query-only execution corpus

Executed 2026-09-15T17:08:37.579Z through 2026-09-15T17:08:54.577Z. **53 scenarios / 106 requests**, all HTTP 200, `isPartial=false`, and `datasetNames=[]`. Every response also passes exact group-name and value-aggregation metadata assertions. Each scenario runs both exact query bodies; only the input dataset binding and `now()` clock are substituted by the committed harness. The request window is the same explicit five-minute window above. The typed fixture clock controls the synthetic accounting/observation window.

The table records actual service rows, not JavaScript-calculated costs. Health cells list positive incident groups (`day:count`); `none` means no detected fixture problem. The threshold assertions use the committed monitor definitions. `healthProblemCount` can count multiple problem classes per identity.

| #   | Scenario                                                              | Actual daily cost rows (USD)  | Actual positive health groups | Assertions |
| --- | --------------------------------------------------------------------- | ----------------------------- | ----------------------------- | ---------- |
| 0   | budget 19.99                                                          | 2026-09-15: 19.99             | none                          | PASS       |
| 1   | budget 20                                                             | 2026-09-15: 20                | none                          | PASS       |
| 2   | budget 20.01                                                          | 2026-09-15: 20.01             | none                          | PASS       |
| 3   | duplicate deliveries, categories and outcomes                         | 2026-09-15: 20                | none                          | PASS       |
| 4   | replay cannot reprice or shift accounting day                         | 2026-09-15: 1                 | none                          | PASS       |
| 5   | later higher repricing preserves first estimate and alerts health     | 2026-09-15: 1                 | 2026-09-15: 1                 | PASS       |
| 6   | same timestamp conflicting duplicate is deterministic and unhealthy   | 2026-09-15: 1                 | 2026-09-15: 1                 | PASS       |
| 7   | unavailable first estimate cannot become available on replay          | none                          | 2026-09-15: 2                 | PASS       |
| 8   | replay without original is a coverage gap                             | none                          | 2026-09-15: 1                 | PASS       |
| 9   | legacy replay is unpriced history                                     | none                          | 2026-09-15: 1                 | PASS       |
| 10  | BYOK exclusion                                                        | none                          | none                          | PASS       |
| 11  | nonproduction exclusion                                               | none                          | none                          | PASS       |
| 12  | future accounting day excluded                                        | none                          | none                          | PASS       |
| 13  | expired accounting day excluded                                       | none                          | none                          | PASS       |
| 14  | late arrival survives midnight as previous-day incident               | 2026-09-14: 20, 2026-09-15: 1 | none                          | PASS       |
| 15  | unknown provider usage                                                | none                          | 2026-09-15: 1                 | PASS       |
| 16  | malformed observation missing identity                                | none                          | 2026-09-15: 1                 | PASS       |
| 17  | zero usage has no billable anchor                                     | none                          | none                          | PASS       |
| 18  | valid zero rate remains zero                                          | 2026-09-15: 0                 | none                          | PASS       |
| 19  | all off with every D column absent                                    | none                          | none                          | PASS       |
| 20  | context and operation only; all accounting columns absent             | none                          | 2026-09-15: 1                 | PASS       |
| 21  | missing billing mode column                                           | none                          | 2026-09-15: 1                 | PASS       |
| 22  | unsupported cost version                                              | none                          | 2026-09-15: 1                 | PASS       |
| 23  | missing token column                                                  | 2026-09-15: 20                | 2026-09-15: 1                 | PASS       |
| 24  | negative token quantity                                               | 2026-09-15: 20                | 2026-09-15: 1                 | PASS       |
| 25  | fractional token quantity                                             | 2026-09-15: 20                | 2026-09-15: 1                 | PASS       |
| 26  | malformed token quantity                                              | 2026-09-15: 20                | 2026-09-15: 1                 | PASS       |
| 27  | missing exact nano value                                              | none                          | 2026-09-15: 1                 | PASS       |
| 28  | fractional nano string                                                | none                          | 2026-09-15: 1                 | PASS       |
| 29  | invalid nano string                                                   | none                          | 2026-09-15: 1                 | PASS       |
| 30  | negative nano string                                                  | none                          | 2026-09-15: 1                 | PASS       |
| 31  | out of int64 nano value                                               | none                          | 2026-09-15: 1                 | PASS       |
| 32  | missing display value                                                 | none                          | 2026-09-15: 1                 | PASS       |
| 33  | negative display value                                                | none                          | 2026-09-15: 1                 | PASS       |
| 34  | malformed display value                                               | none                          | 2026-09-15: 1                 | PASS       |
| 35  | missing pricing status                                                | none                          | 2026-09-15: 1                 | PASS       |
| 36  | fallback-only pricing                                                 | none                          | 2026-09-15: 1                 | PASS       |
| 37  | one hundred fractional observations equal exactly 20                  | 2026-09-15: 20                | none                          | PASS       |
| 38  | one nano below threshold                                              | 2026-09-15: 19.999999999      | none                          | PASS       |
| 39  | one nano above threshold                                              | 2026-09-15: 20.000000001      | none                          | PASS       |
| 40  | identity model and quantity conflict                                  | 2026-09-15: 20                | 2026-09-15: 1                 | PASS       |
| 41  | choose first before day filtering; never replace expired identity     | none                          | 2026-09-15: 1                 | PASS       |
| 42  | tied identity anchor conflict forward                                 | 2026-09-14: 20                | 2026-09-15: 1                 | PASS       |
| 43  | tied identity anchor conflict reverse                                 | 2026-09-14: 20                | 2026-09-15: 1                 | PASS       |
| 44  | stable incident across evaluation 2026-09-15T23:59:59Z                | 2026-09-15: 20                | none                          | PASS       |
| 45  | stable incident across evaluation 2026-09-16T00:00:00Z                | 2026-09-15: 20                | none                          | PASS       |
| 46  | stable incident across evaluation 2026-09-16T00:05:00Z                | 2026-09-15: 20                | none                          | PASS       |
| 47  | group expires after previous-day reconciliation window                | none                          | none                          | PASS       |
| 48  | late previous-day health retains ingestion day                        | none                          | 2026-09-15: 1                 | PASS       |
| 49  | non-api and non-info exclusion                                        | none                          | none                          | PASS       |
| 50  | unsafe aggregate is unavailable with explicit precision health        | none                          | 2026-09-15: 1                 | PASS       |
| 51  | unsafe individual nano value is unavailable                           | none                          | 2026-09-15: 1                 | PASS       |
| 52  | millisecond order keeps the earlier observation before a repriced one | 2026-09-15: 1                 | 2026-09-15: 1                 | PASS       |

## Discovered service constraints

- Full tracked review of the initial PR head found that a final `project` erased `groups` and value `agg` metadata, although all scalar values passed. The final cost operator is now a grouped `summarize` after the precision filter. Both exact-file production responses and all 106 fixture responses preserve the configured group and aggregation metadata. The harness rejects the earlier result shape.

- `ensure_field(..., typeof(real))` can attempt an implicit float conversion and fail on malformed string data (`unable to convert string to float`). Numeric fields now use nullable explicit conversion from a dynamic field. The malformed quantity/display cases execute successfully and report health.
- A literal constant datasource with table operations in one `let` failed with `const datasources may not have table operations`; a nested dynamic projection also hit `field '_tmp2' not found`. The supported adapter first binds a flat typed `datatable`, then aliases it. This changes no production query operator.
- `sum(long)` returns float: the exact query `let rows = datatable(n:long)[9007199254740992, 1]; rows | summarize nano = sum(n)` returned HTTP 200/non-partial with `nano=9007199254740992`. `sum(todecimal(n))` returned HTTP 400 `function 'todecimal' not found`. Cost now treats daily sums at/above `9007199254740991` nano-USD as unavailable, and health reports precision coverage. This is a finite supported alternative; arbitrary-int64 aggregate precision is not claimed.

## Reproduction and limits

Use the [runbook](../README.md#actual-query-validation-and-evidence) commands and a new output directory. Each invocation writes the exact request, complete response and request SHA-256 before checking status/results. It stops on errors or partial responses without retry. The checked-in fixture inputs and source hashes reproduce the query-only request text; the local 24-case oracle is separate evidence.

UTC grouping, repeated evaluation, midnight retention and group expiry are query-result checks. No live monitor state machine, notifier binding, notification opening/recovery/repeat, or delivery was tested. Those remain controller-owned post-deployment gates. Aggregate precision outside the documented range, absent original logs, late data outside retention and complete ingestion require the existing bounded reconciliation and operational disposition. No pricing, writer, migration, ledger, inference or feature switch changed.
