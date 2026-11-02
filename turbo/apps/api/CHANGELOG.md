# Changelog

Older releases are archived by month:

- [2026-10](changelog/2026-10/CHANGELOG.md)
- [2026-09](changelog/2026-09/CHANGELOG.md)
- [2026-08](changelog/2026-08/CHANGELOG.md)
- [2026-07](changelog/2026-07/CHANGELOG.md)
- [2026-06](changelog/2026-06/CHANGELOG.md)
- [2026-05](changelog/2026-05/CHANGELOG.md)
- [2026-04](changelog/2026-04/CHANGELOG.md)

## [2.41.0](https://github.com/okou-ai/okou/compare/api-v2.40.1...api-v2.41.0) (2026-11-02)


### Features

* **connector:** add chat accounts and shared connector permissions ([#44669](https://github.com/okou-ai/okou/issues/44669)) ([4785f0d](https://github.com/okou-ai/okou/commit/4785f0df14390de71e59178a4138d0689411cb85))


### Bug Fixes

* **api:** preserve slides text leading and table borders ([#44731](https://github.com/okou-ai/okou/issues/44731)) ([b5727c0](https://github.com/okou-ai/okou/commit/b5727c03618f822c3d0975a8adf0418460d4f63c))
* **browser:** allow shared browser sessions without chat runs ([#44703](https://github.com/okou-ai/okou/issues/44703)) ([70488f9](https://github.com/okou-ai/okou/commit/70488f99ac868ea87f968e45bd53003e89c2e682))
* **browser:** restore thread mode when shared browser is disabled ([#44740](https://github.com/okou-ai/okou/issues/44740)) ([67a856e](https://github.com/okou-ai/okou/commit/67a856e60792571b417da0c6e2af4a592c013c45))


### Refactoring

* **api:** isolate slack reward financial settlement ([#44710](https://github.com/okou-ai/okou/issues/44710)) ([885c8a9](https://github.com/okou-ai/okou/commit/885c8a9e2271bfc035ecbaf8b9fa289033ad9097))
* **api:** use statement authorization for ssh mutations ([#44718](https://github.com/okou-ai/okou/issues/44718)) ([020805a](https://github.com/okou-ai/okou/commit/020805af30ee2461d349a7dd4404a803dc082165))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.34.0
    * @okouai/core bumped to 8.810.0
    * @okouai/db bumped to 2.18.0
    * @okouai/pi-agent-runtime bumped to 1.51.52

## [2.40.1](https://github.com/okou-ai/okou/compare/api-v2.40.0...api-v2.40.1) (2026-11-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.809.1
    * @okouai/db bumped to 2.17.1
    * @okouai/pi-agent-runtime bumped to 1.51.51

## [2.40.0](https://github.com/okou-ai/okou/compare/api-v2.39.0...api-v2.40.0) (2026-11-02)


### Features

* fall back to whatsapp task completion templates ([#44706](https://github.com/okou-ai/okou/issues/44706)) ([a74db41](https://github.com/okou-ai/okou/commit/a74db4120a1f1561897dba23d0625909f7a096ed))
* implement private cross-agent projects behind release gate ([#44617](https://github.com/okou-ai/okou/issues/44617)) ([428f461](https://github.com/okou-ai/okou/commit/428f46154beb1a11cdf09f150650c388826e539c))


### Refactoring

* **skills:** retire seed storage publication ([#44711](https://github.com/okou-ai/okou/issues/44711)) ([74d6775](https://github.com/okou-ai/okou/commit/74d677573334a37c848fba8c5b23c45c95c16ecd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.33.0
    * @okouai/browser-extension-client bumped to 0.4.2
    * @okouai/core bumped to 8.809.0
    * @okouai/db bumped to 2.17.0
    * @okouai/pi-agent-runtime bumped to 1.51.50

## [2.39.0](https://github.com/okou-ai/okou/compare/api-v2.38.1...api-v2.39.0) (2026-11-02)


### Features

* **browser:** return installed extension metadata with shared connections ([#44659](https://github.com/okou-ai/okou/issues/44659)) ([a4a4cb1](https://github.com/okou-ai/okou/commit/a4a4cb122c222e55bdca57f54f63964dcf4296f1))


### Refactoring

* remove artifact deletion feature switch ([#44649](https://github.com/okou-ai/okou/issues/44649)) ([6fdcb0e](https://github.com/okou-ai/okou/commit/6fdcb0e11da48286252c8277d54c8fcf23d0abf3))
* remove shared thread visibility feature switch ([#44658](https://github.com/okou-ai/okou/issues/44658)) ([5578cdb](https://github.com/okou-ai/okou/commit/5578cdb5b540607a66f7c8d2de52a287ecd8ee09))
* **teams:** remove workspace identity feature switch ([#44660](https://github.com/okou-ai/okou/issues/44660)) ([e77bc14](https://github.com/okou-ai/okou/commit/e77bc14635c0b1f8b8420aa1f8b5fb4fc9f01db5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.32.0
    * @okouai/core bumped to 8.808.1
    * @okouai/db bumped to 2.16.2
    * @okouai/pi-agent-runtime bumped to 1.51.49

## [2.38.1](https://github.com/okou-ai/okou/compare/api-v2.38.0...api-v2.38.1) (2026-11-02)


### Bug Fixes

* **api:** acknowledge unsupported sms short-code senders ([#44611](https://github.com/okou-ai/okou/issues/44611)) ([2f54813](https://github.com/okou-ai/okou/commit/2f5481306c4ce88dee30762a6ff5df3901e147cf))
* **api:** seed auto fast pricing in development and preview ([#44640](https://github.com/okou-ai/okou/issues/44640)) ([f93ec17](https://github.com/okou-ai/okou/commit/f93ec17cbf05e800bbc13eb744af5cf85260ad00))
* **api:** tune agentphone typing timeout and logging ([#44616](https://github.com/okou-ai/okou/issues/44616)) ([3343d8e](https://github.com/okou-ai/okou/commit/3343d8e2ef06b72f9c57811495c933e76c2d7067))
* **billing:** turn off auto-recharge after consecutive failures ([#44587](https://github.com/okou-ai/okou/issues/44587)) ([5881a17](https://github.com/okou-ai/okou/commit/5881a17e5c332bef9ff4efe94f96048deef82962))
* **browser:** acquire coherent viewer bindings on reconnect ([#44606](https://github.com/okou-ai/okou/issues/44606)) ([03444af](https://github.com/okou-ai/okou/commit/03444afe60a11dec7134c1e8872f72519ccef099))
* handle invalid feishu bot connection links ([#44619](https://github.com/okou-ai/okou/issues/44619)) ([7801052](https://github.com/okou-ai/okou/commit/78010527837678d7e7f5e4bfc338c1d577de88f7))
* keep whatsapp typing active during runs ([#44643](https://github.com/okou-ai/okou/issues/44643)) ([30dfc4a](https://github.com/okou-ai/okou/commit/30dfc4ae7724bb86ffff158fd531b4db3720312f))
* require explicit requests for presentation pptx conversion ([#44614](https://github.com/okou-ai/okou/issues/44614)) ([3961310](https://github.com/okou-ai/okou/commit/3961310dfb81580fa11bc96ed60030faa220e64e))


### Refactoring

* remove released first task halloween and onboarding switches ([#44575](https://github.com/okou-ai/okou/issues/44575)) ([4571899](https://github.com/okou-ai/okou/commit/4571899bd04a73a9e13591326ad0f9b21f9612fd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.31.1
    * @okouai/core bumped to 8.808.0
    * @okouai/db bumped to 2.16.1
    * @okouai/pi-agent-runtime bumped to 1.51.48

## [2.38.0](https://github.com/okou-ai/okou/compare/api-v2.37.2...api-v2.38.0) (2026-11-02)


### Features

* **skills:** prepare seed skill content bundles ([#44596](https://github.com/okou-ai/okou/issues/44596)) ([649698d](https://github.com/okou-ai/okou/commit/649698d2ca9b1b9ecb144e89058c866f147882b7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.31.0
    * @okouai/core bumped to 8.807.4
    * @okouai/db bumped to 2.16.0
    * @okouai/pi-agent-runtime bumped to 1.51.47

## [2.37.2](https://github.com/okou-ai/okou/compare/api-v2.37.1...api-v2.37.2) (2026-11-02)


### Refactoring

* **workflows:** decouple official bundles from legacy storage ([#44578](https://github.com/okou-ai/okou/issues/44578)) ([4efa008](https://github.com/okou-ai/okou/commit/4efa00809be22ef8adf37a3837f0c58297a71b56))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.807.3
    * @okouai/db bumped to 2.15.3
    * @okouai/pi-agent-runtime bumped to 1.51.46

## [2.37.1](https://github.com/okou-ai/okou/compare/api-v2.37.0...api-v2.37.1) (2026-11-02)


### Bug Fixes

* align app connector introductions with 4,000+ catalog ([#44375](https://github.com/okou-ai/okou/issues/44375)) ([9b974cf](https://github.com/okou-ai/okou/commit/9b974cf48403e6daf872459231ad0d6a4e3ed8df))

## [2.37.0](https://github.com/okou-ai/okou/compare/api-v2.36.1...api-v2.37.0) (2026-11-01)


### Features

* **workflows:** activate current official workflow bundles ([#44537](https://github.com/okou-ai/okou/issues/44537)) ([53eb442](https://github.com/okou-ai/okou/commit/53eb44219252b774d85bfc3be7c8b54a80049dd1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.30.0
    * @okouai/core bumped to 8.807.2
    * @okouai/db bumped to 2.15.2
    * @okouai/pi-agent-runtime bumped to 1.51.45

## [2.36.1](https://github.com/okou-ai/okou/compare/api-v2.36.0...api-v2.36.1) (2026-11-01)


### Bug Fixes

* **browser:** seed new viewer windows from the target display ([#44486](https://github.com/okou-ai/okou/issues/44486)) ([c544f6f](https://github.com/okou-ai/okou/commit/c544f6f2b7b41015b290cb6bec04758b765ac558))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.29.1
    * @okouai/core bumped to 8.807.1
    * @okouai/db bumped to 2.15.1
    * @okouai/pi-agent-runtime bumped to 1.51.44

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
