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
