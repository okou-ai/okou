# Changelog

## [0.5.13](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.12...runner-provider-v0.5.13) (2026-10-09)


### Bug Fixes

* **runner:** defer incomplete response alerts until degradation ([#38281](https://github.com/okou-ai/okou/issues/38281)) ([c3e28db](https://github.com/okou-ai/okou/commit/c3e28db3f0d5292c821a496522b854aba4286429))

## [0.5.12](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.11...runner-provider-v0.5.12) (2026-10-09)

## [0.5.11](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.10...runner-provider-v0.5.11) (2026-10-08)

## [0.5.10](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.9...runner-provider-v0.5.10) (2026-10-08)


### Refactoring

* assemble current run inputs without agent configuration ([#38004](https://github.com/okou-ai/okou/issues/38004)) ([22efd4b](https://github.com/okou-ai/okou/commit/22efd4b6b34872c0585a0d4c3778cb3b59d9d100))

## [0.5.9](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.8...runner-provider-v0.5.9) (2026-10-08)

## [0.5.8](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.7...runner-provider-v0.5.8) (2026-10-07)


### Refactoring

* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))

## [0.5.7](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.6...runner-provider-v0.5.7) (2026-10-07)

## [0.5.6](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.5...runner-provider-v0.5.6) (2026-10-07)


### Refactoring

* remove all remaining custom model mode awareness ([#37856](https://github.com/okou-ai/okou/issues/37856)) ([f383835](https://github.com/okou-ai/okou/commit/f3838353ba0455ec7d57dfa2d0974e34a44796ff))

## [0.5.5](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.4...runner-provider-v0.5.5) (2026-10-03)


### Bug Fixes

* **runner:** track cached firewall catalog connection resets ([#37587](https://github.com/okou-ai/okou/issues/37587)) ([1ac40a6](https://github.com/okou-ai/okou/commit/1ac40a63b5787c5aacaafde47ada7a4eb6298f9c))

## [0.5.4](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.3...runner-provider-v0.5.4) (2026-10-03)


### Bug Fixes

* **runner:** allow three total completion reporting attempts ([#37584](https://github.com/okou-ai/okou/issues/37584)) ([70bf078](https://github.com/okou-ai/okou/commit/70bf0780ba916bffc8ab1ac23ef04cfaaa2e9ffa))

## [0.5.3](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.2...runner-provider-v0.5.3) (2026-10-02)

## [0.5.2](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.1...runner-provider-v0.5.2) (2026-10-01)

## [0.5.1](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.0...runner-provider-v0.5.1) (2026-10-01)


### Documentation

* **rust:** correct builtin firewall catalog validator path ([#37433](https://github.com/okou-ai/okou/issues/37433)) ([bee3673](https://github.com/okou-ai/okou/commit/bee3673a65726f4bb12b3735112b52b44adca943))

## [0.5.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.4.6...runner-provider-v0.5.0) (2026-09-30)


### Features

* make the database model catalog the model authority ([#37416](https://github.com/okou-ai/okou/issues/37416)) ([7a8cf4d](https://github.com/okou-ai/okou/commit/7a8cf4d005dea492e0375b91ac46bcf3201d902d))

## [0.4.6](https://github.com/okou-ai/okou/compare/runner-provider-v0.4.5...runner-provider-v0.4.6) (2026-09-30)

## [0.4.5](https://github.com/okou-ai/okou/compare/runner-provider-v0.4.4...runner-provider-v0.4.5) (2026-09-30)


### Refactoring

* **chat:** complete chat event v8 transition cleanup ([#37411](https://github.com/okou-ai/okou/issues/37411)) ([cd4aac5](https://github.com/okou-ai/okou/commit/cd4aac5fa635dd7f71eb82756529c5643c552cc9))

## [0.4.4](https://github.com/okou-ai/okou/compare/runner-provider-v0.4.3...runner-provider-v0.4.4) (2026-09-30)

## [0.4.3](https://github.com/okou-ai/okou/compare/runner-provider-v0.4.2...runner-provider-v0.4.3) (2026-09-29)

## [0.4.2](https://github.com/okou-ai/okou/compare/runner-provider-v0.4.1...runner-provider-v0.4.2) (2026-09-29)

## [0.4.1](https://github.com/okou-ai/okou/compare/runner-provider-v0.4.0...runner-provider-v0.4.1) (2026-09-28)


### Bug Fixes

* **runner:** read steerable input only on start, push, and ably reconnect ([#37232](https://github.com/okou-ai/okou/issues/37232)) ([5a4713a](https://github.com/okou-ai/okou/commit/5a4713ab3fbd39ee99a5a6067880ab7538ab359a))

## [0.4.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.15...runner-provider-v0.4.0) (2026-09-28)


### Features

* **runner:** gate wss tickets on host ingress heartbeat ([#37192](https://github.com/okou-ai/okou/issues/37192)) ([00b5a33](https://github.com/okou-ai/okou/commit/00b5a334dceacc63b97978c57108d736822fd230))

## [0.3.15](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.14...runner-provider-v0.3.15) (2026-09-28)


### Refactoring

* **runner:** chat queue release 6 - steer endpoints and sandbox-first pi ([#37175](https://github.com/okou-ai/okou/issues/37175)) ([2ccafb0](https://github.com/okou-ai/okou/commit/2ccafb0e9add22ecefebd62785e7ecafe05a8ea7))

## [0.3.14](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.13...runner-provider-v0.3.14) (2026-09-28)

## [0.3.13](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.12...runner-provider-v0.3.13) (2026-09-27)

## [0.3.12](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.11...runner-provider-v0.3.12) (2026-09-26)


### Refactoring

* remove expired deployment compatibility ([#37056](https://github.com/okou-ai/okou/issues/37056)) ([736f701](https://github.com/okou-ai/okou/commit/736f70167be41d6d99cf07d842071cbd9b2fa68c))

## [0.3.11](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.10...runner-provider-v0.3.11) (2026-09-25)

## [0.3.10](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.9...runner-provider-v0.3.10) (2026-09-25)


### Bug Fixes

* retain runner affinity for active predecessor producers ([#36866](https://github.com/okou-ai/okou/issues/36866)) ([d90ba1e](https://github.com/okou-ai/okou/commit/d90ba1e7d4a7bc36c2c5f1abf168c1b1e83e657a))

## [0.3.9](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.8...runner-provider-v0.3.9) (2026-09-25)

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
