# Changelog

Older releases are archived by month:

- [2026-10](changelog/2026-10/CHANGELOG.md)
- [2026-09](changelog/2026-09/CHANGELOG.md)
- [2026-08](changelog/2026-08/CHANGELOG.md)
- [2026-07](changelog/2026-07/CHANGELOG.md)
- [2026-06](changelog/2026-06/CHANGELOG.md)
- [2026-05](changelog/2026-05/CHANGELOG.md)
- [2026-04](changelog/2026-04/CHANGELOG.md)
- [2026-03](changelog/2026-03/CHANGELOG.md)
- [2026-02](changelog/2026-02/CHANGELOG.md)
- [2026-01](changelog/2026-01/CHANGELOG.md)

## [0.1083.2](https://github.com/okou-ai/okou/compare/app-v0.1083.1...app-v0.1083.2) (2026-11-02)


### Bug Fixes

* **app:** keep markdown table exports repeatable ([#44584](https://github.com/okou-ai/okou/issues/44584)) ([6976833](https://github.com/okou-ai/okou/commit/6976833d83a549c278964b9546433deb8fba63ff))

## [0.1083.1](https://github.com/okou-ai/okou/compare/app-v0.1083.0...app-v0.1083.1) (2026-11-02)


### Bug Fixes

* **browser:** copy selected text from focusable page content ([#44582](https://github.com/okou-ai/okou/issues/44582)) ([e7625c9](https://github.com/okou-ai/okou/commit/e7625c9d0f8841ea71a49e3be90d98723dd26456))
* **platform:** retain native browser close diagnostics ([#44558](https://github.com/okou-ai/okou/issues/44558)) ([878108c](https://github.com/okou-ai/okou/commit/878108cd25993c75be642e768ee3c59e45deb8ba))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.807.3

## [0.1083.0](https://github.com/okou-ai/okou/compare/app-v0.1082.5...app-v0.1083.0) (2026-11-02)


### Features

* **browser:** mirror remote keyboard hints and native enter ([#44505](https://github.com/okou-ai/okou/issues/44505)) ([1b12658](https://github.com/okou-ai/okou/commit/1b12658c367894d6d68909c241503db69519a05f))


### Bug Fixes

* align app connector introductions with 4,000+ catalog ([#44375](https://github.com/okou-ai/okou/issues/44375)) ([9b974cf](https://github.com/okou-ai/okou/commit/9b974cf48403e6daf872459231ad0d6a4e3ed8df))
* **app:** retain cdp response diagnostics in sentry ([#44557](https://github.com/okou-ai/okou/issues/44557)) ([01b26ea](https://github.com/okou-ai/okou/commit/01b26eab2624f3d8bb6fe74fff09ada3b7c1778f))
* **platform:** retain native browser websocket failure observations ([#44560](https://github.com/okou-ai/okou/issues/44560)) ([d05fd2a](https://github.com/okou-ai/okou/commit/d05fd2a3c85421ae7fd958ffe7ceca6317bf01c5))
* **platform:** retain original browser input cleanup failures ([#44562](https://github.com/okou-ai/okou/issues/44562)) ([c95f580](https://github.com/okou-ai/okou/commit/c95f580b90493922b787aca3ce1a70926017fbbd))

## [0.1082.5](https://github.com/okou-ai/okou/compare/app-v0.1082.4...app-v0.1082.5) (2026-11-01)


### Bug Fixes

* **app:** limit halloween entry clicks to the ghost ([#44513](https://github.com/okou-ai/okou/issues/44513)) ([5fe8b3b](https://github.com/okou-ai/okou/commit/5fe8b3b04f3f10fc959886b164cc7e18f84f6d39))
* **platform:** forward soft-keyboard backward deletion ([#44497](https://github.com/okou-ai/okou/issues/44497)) ([2047e61](https://github.com/okou-ai/okou/commit/2047e61f55909f7e2f2d173fe744bc69c45a33d2))


### Refactoring

* **platform:** bind landing file transfer deadlines to their owners ([#44509](https://github.com/okou-ai/okou/issues/44509)) ([b2c15b7](https://github.com/okou-ai/okou/commit/b2c15b724e4570ae695799016ca9e790c0b4bd98))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.30.0
    * @okouai/core bumped to 8.807.2

## [0.1082.4](https://github.com/okou-ai/okou/compare/app-v0.1082.3...app-v0.1082.4) (2026-11-01)


### Bug Fixes

* **browser:** seed new viewer windows from the target display ([#44486](https://github.com/okou-ai/okou/issues/44486)) ([c544f6f](https://github.com/okou-ai/okou/commit/c544f6f2b7b41015b290cb6bec04758b765ac558))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.29.1
    * @okouai/core bumped to 8.807.1

## [0.1082.3](https://github.com/okou-ai/okou/compare/app-v0.1082.2...app-v0.1082.3) (2026-11-01)


### Bug Fixes

* **app:** start landing attachment tasks directly in chat ([#44479](https://github.com/okou-ai/okou/issues/44479)) ([566d375](https://github.com/okou-ai/okou/commit/566d375771134a61c1f112205338d53bc0de286c))

## [0.1082.2](https://github.com/okou-ai/okou/compare/app-v0.1082.1...app-v0.1082.2) (2026-11-01)


### Bug Fixes

* **app:** deliver onboarding documents as artifacts ([#44472](https://github.com/okou-ai/okou/issues/44472)) ([c22d0ce](https://github.com/okou-ai/okou/commit/c22d0cecc62e6a28bcf12959ea40b11e1a0daf0f))
* **app:** guide onboarding toward a useful first task ([#44482](https://github.com/okou-ai/okou/issues/44482)) ([b2ca36d](https://github.com/okou-ai/okou/commit/b2ca36dddce0cac9545095243291ff616dc917ec))
* **platform:** support android browser address submission ([#44437](https://github.com/okou-ai/okou/issues/44437)) ([df6aad0](https://github.com/okou-ai/okou/commit/df6aad0584984ae072a10ca6fbabf328a0b8868c))
* **platform:** support browser touch taps and swipe scrolling ([#44483](https://github.com/okou-ai/okou/issues/44483)) ([bb033ff](https://github.com/okou-ai/okou/commit/bb033ff74555e70ce677735864722eb2aeb0f054))


### Documentation

* rotate api and app changelogs for 2026-11 ([#44468](https://github.com/okou-ai/okou/issues/44468)) ([54bceeb](https://github.com/okou-ai/okou/commit/54bceeba4112484172af0e8ff3b9dd75cc679a4e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.29.0
    * @okouai/core bumped to 8.807.0

## [0.1082.1](https://github.com/okou-ai/okou/compare/app-v0.1082.0...app-v0.1082.1) (2026-11-01)


### Performance Improvements

* **platform:** ignore lease-only browser panel updates ([#44460](https://github.com/okou-ai/okou/issues/44460)) ([98ae36c](https://github.com/okou-ai/okou/commit/98ae36c0a5a2db3ac4d5885ac1af0827e8eb2c07))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.28.0
    * @okouai/core bumped to 8.806.1

## [0.1082.0](https://github.com/okou-ai/okou/compare/app-v0.1081.3...app-v0.1082.0) (2026-10-31)


### Features

* **app:** preserve landing page files through onboarding ([#44425](https://github.com/okou-ai/okou/issues/44425)) ([5ae758c](https://github.com/okou-ai/okou/commit/5ae758cf6bb113218c9a0247354bbe60cc1f85f8))


### Refactoring

* **platform:** remove browser async wrappers and defensive timeouts ([#44416](https://github.com/okou-ai/okou/issues/44416)) ([1db5a82](https://github.com/okou-ai/okou/commit/1db5a82d3f6b8b0bfd07ad3b47bc2df5dd861091))


### Performance Improvements

* **api-contracts:** split send/data contracts and use zod 4 top-level string formats ([#44419](https://github.com/okou-ai/okou/issues/44419)) ([381bd6b](https://github.com/okou-ai/okou/commit/381bd6be3712a60db5135c776f3e6aa4bb7b94cf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.27.1
    * @okouai/connectors bumped to 3.20.2
    * @okouai/core bumped to 8.806.0
    * @okouai/ui bumped to 1.18.7
