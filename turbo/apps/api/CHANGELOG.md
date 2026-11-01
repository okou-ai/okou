# Changelog

Older releases are archived by month:

- [2026-10](changelog/2026-10/CHANGELOG.md)
- [2026-09](changelog/2026-09/CHANGELOG.md)
- [2026-08](changelog/2026-08/CHANGELOG.md)
- [2026-07](changelog/2026-07/CHANGELOG.md)
- [2026-06](changelog/2026-06/CHANGELOG.md)
- [2026-05](changelog/2026-05/CHANGELOG.md)
- [2026-04](changelog/2026-04/CHANGELOG.md)

## [2.34.2](https://github.com/okou-ai/okou/compare/api-v2.34.1...api-v2.34.2) (2026-10-31)


### Refactoring

* **api:** localize agent detail read ownership ([#44432](https://github.com/okou-ai/okou/issues/44432)) ([5892f2a](https://github.com/okou-ai/okou/commit/5892f2a0f4a0c8efb55c61bb3b9d8cb16ba4a394))
* **browser:** make retention cleanup one atomic statement ([#44431](https://github.com/okou-ai/okou/issues/44431)) ([d272d29](https://github.com/okou-ai/okou/commit/d272d29b98bfaf797a04e1b9f28a781d60ca98ca))


### Performance Improvements

* **api-contracts:** split send/data contracts and use zod 4 top-level string formats ([#44419](https://github.com/okou-ai/okou/issues/44419)) ([381bd6b](https://github.com/okou-ai/okou/commit/381bd6be3712a60db5135c776f3e6aa4bb7b94cf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.27.1
    * @okouai/connectors bumped to 3.20.2
    * @okouai/core bumped to 8.806.0
    * @okouai/db bumped to 2.14.2
    * @okouai/pi-agent-runtime bumped to 1.51.41
