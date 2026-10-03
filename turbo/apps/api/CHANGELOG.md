# Changelog

Older releases are archived by month:

- [2026-09](changelog/2026-09/CHANGELOG.md)
- [2026-08](changelog/2026-08/CHANGELOG.md)
- [2026-07](changelog/2026-07/CHANGELOG.md)
- [2026-06](changelog/2026-06/CHANGELOG.md)
- [2026-05](changelog/2026-05/CHANGELOG.md)
- [2026-04](changelog/2026-04/CHANGELOG.md)

## [1.705.3](https://github.com/okou-ai/okou/compare/api-v1.705.2...api-v1.705.3) (2026-10-03)


### Performance Improvements

* **api:** prefetch official workflow and agent storage context ([#37589](https://github.com/okou-ai/okou/issues/37589)) ([0f3ff66](https://github.com/okou-ai/okou/commit/0f3ff662a3a77041bffa7196482f3daa60946205))

## [1.705.2](https://github.com/okou-ai/okou/compare/api-v1.705.1...api-v1.705.2) (2026-10-02)


### Performance Improvements

* **api:** reuse thread and queued input request facts ([#37592](https://github.com/okou-ai/okou/issues/37592)) ([0825e59](https://github.com/okou-ai/okou/commit/0825e5911aa065d54a5a81bacda0efe5824fc518))

## [1.705.1](https://github.com/okou-ai/okou/compare/api-v1.705.0...api-v1.705.1) (2026-10-02)


### Refactoring

* remove retired video generation entitlement ([#37580](https://github.com/okou-ai/okou/issues/37580)) ([d6fb17a](https://github.com/okou-ai/okou/commit/d6fb17af11171e4edd1e7a9b289e255db602a402))
* retire legacy free organization tier ([#37581](https://github.com/okou-ai/okou/issues/37581)) ([26691d8](https://github.com/okou-ai/okou/commit/26691d89ca363d22a9ed045b23fc02894a21d043))


### Performance Improvements

* **api:** share Agent flags and allowance reads through run context ([#37583](https://github.com/okou-ai/okou/issues/37583)) ([2c84f2d](https://github.com/okou-ai/okou/commit/2c84f2dcf22ce8fa700e795b183cca576bdde5e6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.536.1
    * @okouai/core bumped to 8.727.1
    * @okouai/db bumped to 1.319.2
    * @okouai/pi-agent-runtime bumped to 1.45.12

## [1.705.0](https://github.com/okou-ai/okou/compare/api-v1.704.1...api-v1.705.0) (2026-10-02)


### Features

* retire file transcription and seedream 5 models ([#37575](https://github.com/okou-ai/okou/issues/37575)) ([b7ff2f1](https://github.com/okou-ai/okou/commit/b7ff2f12a14123ca3cd56d5804126c1333662896))


### Refactoring

* **api:** converge chat and export ownership to ccstate ([#37525](https://github.com/okou-ai/okou/issues/37525)) ([2fc551c](https://github.com/okou-ai/okou/commit/2fc551c39cd9eceee6769715b09cb160441ed982))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.536.0
    * @okouai/core bumped to 8.727.0
    * @okouai/db bumped to 1.319.1
    * @okouai/pi-agent-runtime bumped to 1.45.11

## [1.704.1](https://github.com/okou-ai/okou/compare/api-v1.704.0...api-v1.704.1) (2026-10-02)


### Bug Fixes

* **api:** prevent automation enqueue deadlocks ([#37567](https://github.com/okou-ai/okou/issues/37567)) ([1713182](https://github.com/okou-ai/okou/commit/1713182a30ccc78226e72616ecca6ded5611a875))
* **pi:** align model context and output limits with provider metadata ([#37558](https://github.com/okou-ai/okou/issues/37558)) ([88b678a](https://github.com/okou-ai/okou/commit/88b678a34566d037e302891c93eb1f4015492b73))


### Performance Improvements

* **api:** prefetch connector identity snapshots for chat picks ([#37563](https://github.com/okou-ai/okou/issues/37563)) ([04f3c32](https://github.com/okou-ai/okou/commit/04f3c32ed60a649a1940f859b4a744e4d185f8b6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/pi-agent-runtime bumped to 1.45.10

## [1.704.0](https://github.com/okou-ai/okou/compare/api-v1.703.0...api-v1.704.0) (2026-10-02)


### Features

* add owner-selected rsa-aes vnc profiles ([#37548](https://github.com/okou-ai/okou/issues/37548)) ([6716f9a](https://github.com/okou-ai/okou/commit/6716f9afed2943ab4c18f0c8aa435a20f2e7f47b))


### Performance Improvements

* **api:** reuse model bootstrap facts across chat enqueue and pick ([#37562](https://github.com/okou-ai/okou/issues/37562)) ([74f0879](https://github.com/okou-ai/okou/commit/74f0879eedf15d299217e10d5a7f9ce655142b62))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.535.0
    * @okouai/core bumped to 8.726.1
    * @okouai/db bumped to 1.319.0
    * @okouai/pi-agent-runtime bumped to 1.45.9

## [1.703.0](https://github.com/okou-ai/okou/compare/api-v1.702.7...api-v1.703.0) (2026-10-02)


### Features

* archive imessage group history with per-message access control ([#37516](https://github.com/okou-ai/okou/issues/37516)) ([c7bd6af](https://github.com/okou-ai/okou/commit/c7bd6af7f99afe1ed700315993cbab38ce68dbbd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.534.0
    * @okouai/core bumped to 8.726.0
    * @okouai/db bumped to 1.318.0
    * @okouai/pi-agent-runtime bumped to 1.45.8

## [1.702.7](https://github.com/okou-ai/okou/compare/api-v1.702.6...api-v1.702.7) (2026-10-02)


### Bug Fixes

* **browser:** log input preflight only on timeout ([#37552](https://github.com/okou-ai/okou/issues/37552)) ([a657013](https://github.com/okou-ai/okou/commit/a657013e661096c8e4d74f242263a2710bda806d))


### Performance Improvements

* **api:** prefetch identity-scoped agent bootstrap during chat enqueue ([#37431](https://github.com/okou-ai/okou/issues/37431)) ([8183dca](https://github.com/okou-ai/okou/commit/8183dca7c7e141f73583ad5e1d6e393a23922abf))

## [1.702.6](https://github.com/okou-ai/okou/compare/api-v1.702.5...api-v1.702.6) (2026-10-02)


### Refactoring

* **model-provider:** graduate deepseek alternative routing ([#37493](https://github.com/okou-ai/okou/issues/37493)) ([489ea16](https://github.com/okou-ai/okou/commit/489ea1657a4e6e83dcd1bc8f8757abda1960a1ef))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.725.7
    * @okouai/db bumped to 1.317.3
    * @okouai/pi-agent-runtime bumped to 1.45.7

## [1.702.5](https://github.com/okou-ai/okou/compare/api-v1.702.4...api-v1.702.5) (2026-10-02)


### Performance Improvements

* **api:** reuse registered volume resource indexes ([#37470](https://github.com/okou-ai/okou/issues/37470)) ([fd3f001](https://github.com/okou-ai/okou/commit/fd3f00176b214077e217baf701fd0584f963b38e))

## [1.702.4](https://github.com/okou-ai/okou/compare/api-v1.702.3...api-v1.702.4) (2026-10-02)


### Bug Fixes

* **api:** read pending usage pack counts from one snapshot ([#37529](https://github.com/okou-ai/okou/issues/37529)) ([e44318f](https://github.com/okou-ai/okou/commit/e44318f096ab8058f210f0bc45c27c086548955d))


### Refactoring

* **api:** remove redundant ssh credential creation transaction ([#37523](https://github.com/okou-ai/okou/issues/37523)) ([aafd915](https://github.com/okou-ai/okou/commit/aafd915862b9cc38aaabac4c72023bf622ab2419))

## [1.702.3](https://github.com/okou-ai/okou/compare/api-v1.702.2...api-v1.702.3) (2026-10-01)


### Refactoring

* **api:** prepare advisory lock cleanup release 1 ([#37313](https://github.com/okou-ai/okou/issues/37313)) ([77b3c9f](https://github.com/okou-ai/okou/commit/77b3c9f855bb9cd434eefc68ab2cb2cb9eb11ab2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.533.2
    * @okouai/core bumped to 8.725.6
    * @okouai/db bumped to 1.317.2
    * @okouai/pi-agent-runtime bumped to 1.45.6

## [1.702.2](https://github.com/okou-ai/okou/compare/api-v1.702.1...api-v1.702.2) (2026-10-01)


### Refactoring

* **api:** prepare agent instructions outside publication transactions ([#37467](https://github.com/okou-ai/okou/issues/37467)) ([d8b16e9](https://github.com/okou-ai/okou/commit/d8b16e9f6d2eb01561cb6399cc14361cf1c315b3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.533.1
    * @okouai/core bumped to 8.725.5
    * @okouai/db bumped to 1.317.1
    * @okouai/pi-agent-runtime bumped to 1.45.5

## [1.702.1](https://github.com/okou-ai/okou/compare/api-v1.702.0...api-v1.702.1) (2026-10-01)


### Refactoring

* **api:** publish bootstrap seeds outside transactions ([#37474](https://github.com/okou-ai/okou/issues/37474)) ([32fef45](https://github.com/okou-ai/okou/commit/32fef452b46b6efe54d27bc2290ec5e202065d1e))

## [1.702.0](https://github.com/okou-ai/okou/compare/api-v1.701.4...api-v1.702.0) (2026-10-01)


### Features

* **vnc:** add owner-selected qemu scram profile ([#37486](https://github.com/okou-ai/okou/issues/37486)) ([8562a7a](https://github.com/okou-ai/okou/commit/8562a7a241033ae023a588e9ead5643e93990957))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.533.0
    * @okouai/core bumped to 8.725.4
    * @okouai/db bumped to 1.317.0
    * @okouai/pi-agent-runtime bumped to 1.45.4

## [1.701.4](https://github.com/okou-ai/okou/compare/api-v1.701.3...api-v1.701.4) (2026-10-01)


### Refactoring

* **api:** govern pick tests and claim/enqueue ownership ([#37430](https://github.com/okou-ai/okou/issues/37430)) ([fe3f02c](https://github.com/okou-ai/okou/commit/fe3f02cdd3b8597a65ec92c4f8ca367edaf7fc87))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.532.3
    * @okouai/connectors bumped to 3.15.6
    * @okouai/core bumped to 8.725.3
    * @okouai/db bumped to 1.316.3
    * @okouai/pi-agent-runtime bumped to 1.45.3

## [1.701.3](https://github.com/okou-ai/okou/compare/api-v1.701.2...api-v1.701.3) (2026-10-01)


### Refactoring

* remove model catalog rollout compatibility ([#37457](https://github.com/okou-ai/okou/issues/37457)) ([bfdefb5](https://github.com/okou-ai/okou/commit/bfdefb56cc71e50764957c7f168584df7398c7b4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.532.2
    * @okouai/core bumped to 8.725.2
    * @okouai/db bumped to 1.316.2
    * @okouai/pi-agent-runtime bumped to 1.45.2

## [1.701.2](https://github.com/okou-ai/okou/compare/api-v1.701.1...api-v1.701.2) (2026-10-01)


### Documentation

* rotate api and app changelogs for 2026-10 ([#37446](https://github.com/okou-ai/okou/issues/37446)) ([a06ea1c](https://github.com/okou-ai/okou/commit/a06ea1c6a37ed97d74639b81dadc357fa3dc7a8f))

## [1.701.1](https://github.com/okou-ai/okou/compare/api-v1.701.0...api-v1.701.1) (2026-10-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.532.1
    * @okouai/core bumped to 8.725.1
    * @okouai/db bumped to 1.316.1
    * @okouai/pi-agent-runtime bumped to 1.45.1
