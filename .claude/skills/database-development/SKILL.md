---
name: database-development
description: Choose migration workflows, transaction boundaries, or Drizzle runtime decoding and SQL construction rules
---

# Database Development

Start with the [database guide](../../../docs/database.md) for shared database
policy. Read the detailed guidance matching the change; a router does not
replace its selected reference.

| Task                                                | Read                                                                                                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema changes or data migration                    | [Migration workflows](references/migrations.md) and [DB migrations](../../../turbo/packages/db/MIGRATIONS.md)                                                                                                         |
| Selections, raw results, or SQL rewrites            | [Query contracts](references/query-contracts.md)                                                                                                                                                                      |
| Transactions or concurrency changes                 | [Transaction boundaries](../../../docs/database.md#transaction-boundaries), [concurrency](../../../docs/database.md#concurrency-and-coordination), and [transaction lint](../../../docs/database.md#transaction-lint) |
| External effects, recovery, or integration ordering | [External effects and recovery](../../../docs/database.md#external-effects-and-recovery)                                                                                                                              |
| Persisted shapes or deploy order                    | [Deployment compatibility](../../../docs/deployment-compatibility.md)                                                                                                                                                 |
