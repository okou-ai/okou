# Changelog

## [0.3.8](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.7...runner-provider-v0.3.8) (2026-09-25)

## [0.3.7](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.6...runner-provider-v0.3.7) (2026-09-24)


### Performance Improvements

* **runner:** attribute first claim body chunk wait ([#36747](https://github.com/okou-ai/okou/issues/36747)) ([bb22f6a](https://github.com/okou-ai/okou/commit/bb22f6a8bf717c1b104567028a4d35e4648229b9))

## [0.3.6](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.5...runner-provider-v0.3.6) (2026-09-24)

## [0.3.5](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.4...runner-provider-v0.3.5) (2026-09-24)


### Performance Improvements

* **runner:** attribute claim response size on both sides ([#36582](https://github.com/okou-ai/okou/issues/36582)) ([954136f](https://github.com/okou-ai/okou/commit/954136fe0a41a917ac49cdb76095075ee6b4f3a4))

## [0.3.4](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.3...runner-provider-v0.3.4) (2026-09-24)


### Bug Fixes

* **runner:** defer poll reset errors until fallback degrades ([#36499](https://github.com/okou-ai/okou/issues/36499)) ([27f936e](https://github.com/okou-ai/okou/commit/27f936edcb4cb68c93f8acc5a9ae9387766fd852))

## [0.3.3](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.2...runner-provider-v0.3.3) (2026-09-24)


### Bug Fixes

* **runner:** log transient ably connection retries at info ([#36488](https://github.com/okou-ai/okou/issues/36488)) ([8d3dcb2](https://github.com/okou-ai/okou/commit/8d3dcb23e4a6496c667a13ca42e1ec16048dcdb7))


### Refactoring

* **runner:** consolidate shared API transport in provider ([#36447](https://github.com/okou-ai/okou/issues/36447)) ([193d460](https://github.com/okou-ai/okou/commit/193d460a94a242db4958f4a90631800cd9eed3e4))

## [0.3.2](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.1...runner-provider-v0.3.2) (2026-09-23)

## [0.3.1](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.0...runner-provider-v0.3.1) (2026-09-23)

## [0.3.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.2.0...runner-provider-v0.3.0) (2026-09-23)


### Features

* **pi:** enable session-construction digest parity ([#36201](https://github.com/okou-ai/okou/issues/36201)) ([00b1434](https://github.com/okou-ai/okou/commit/00b14343e69073fdc87f42d378deab55e8c232ba)), closes [#35967](https://github.com/okou-ai/okou/issues/35967)

## [0.2.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.1.1...runner-provider-v0.2.0) (2026-09-23)


### Features

* **models:** add Claude Opus 5.5 ([#36168](https://github.com/okou-ai/okou/issues/36168)) ([e0fc624](https://github.com/okou-ai/okou/commit/e0fc62414d039c9e0dfda36145c2e62edfcf79a2))

## [0.1.1](https://github.com/okou-ai/okou/compare/runner-provider-v0.1.0...runner-provider-v0.1.1) (2026-09-23)


### Refactoring

* **runner:** extract provider coordination crate ([#36148](https://github.com/okou-ai/okou/issues/36148)) ([789a24f](https://github.com/okou-ai/okou/commit/789a24f6632566071af38533d4df58a0ef0c0c75))

## 0.1.0

- Extract API and local Runner job-provider coordination from the Runner binary crate.
