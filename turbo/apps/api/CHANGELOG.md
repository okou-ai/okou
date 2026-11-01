# Changelog

Older releases are archived by month:

- [2026-10](changelog/2026-10/CHANGELOG.md)
- [2026-09](changelog/2026-09/CHANGELOG.md)
- [2026-08](changelog/2026-08/CHANGELOG.md)
- [2026-07](changelog/2026-07/CHANGELOG.md)
- [2026-06](changelog/2026-06/CHANGELOG.md)
- [2026-05](changelog/2026-05/CHANGELOG.md)
- [2026-04](changelog/2026-04/CHANGELOG.md)

## [2.36.0](https://github.com/okou-ai/okou/compare/api-v2.35.0...api-v2.36.0) (2026-11-01)


### Features

* **workflows:** prepare official workflow content bundles ([#44471](https://github.com/okou-ai/okou/issues/44471)) ([868fad8](https://github.com/okou-ai/okou/commit/868fad832660a1430be8f847a4af489888cefa3c))


### Documentation

* rotate api and app changelogs for 2026-11 ([#44468](https://github.com/okou-ai/okou/issues/44468)) ([54bceeb](https://github.com/okou-ai/okou/commit/54bceeba4112484172af0e8ff3b9dd75cc679a4e))


### Refactoring

* **api:** apply permission grants in one atomic statement ([#44465](https://github.com/okou-ai/okou/issues/44465)) ([2363808](https://github.com/okou-ai/okou/commit/2363808b8b1b5e9270594ef642fdc558b1dbe7f2))
* **api:** preconnect custom connector list request graph ([#44473](https://github.com/okou-ai/okou/issues/44473)) ([4cc5204](https://github.com/okou-ai/okou/commit/4cc5204b3c9ad5bfbc307d3cbfde158b60e1bb39))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.29.0
    * @okouai/core bumped to 8.807.0
    * @okouai/db bumped to 2.15.0
    * @okouai/pi-agent-runtime bumped to 1.51.43

## [2.35.0](https://github.com/okou-ai/okou/compare/api-v2.34.2...api-v2.35.0) (2026-11-01)


### Features

* **api:** gate ios api compatibility ([#44438](https://github.com/okou-ai/okou/issues/44438)) ([7014fe7](https://github.com/okou-ai/okou/commit/7014fe7eaa7c9607245ce17cc46d5043fc03c060))


### Refactoring

* **api:** localize agent builtin connector catalog read ([#44440](https://github.com/okou-ai/okou/issues/44440)) ([26b5dbb](https://github.com/okou-ai/okou/commit/26b5dbb813d954899fcbcad36109fb555dd27a7d))
* **api:** preconnect builtin list catalog selection graph ([#44462](https://github.com/okou-ai/okou/issues/44462)) ([516c8ae](https://github.com/okou-ai/okou/commit/516c8aea44938f42e1ad4a039e6d5825f65df7c4))
* **api:** preconstruct agent connector access read graph ([#44446](https://github.com/okou-ai/okou/issues/44446)) ([a992c03](https://github.com/okou-ai/okou/commit/a992c0370e14b980dd845c2e37bf42be61f9d155))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.28.0
    * @okouai/core bumped to 8.806.1
    * @okouai/db bumped to 2.14.3
    * @okouai/pi-agent-runtime bumped to 1.51.42

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
