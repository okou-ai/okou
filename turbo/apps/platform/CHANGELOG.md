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
