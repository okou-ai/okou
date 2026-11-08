# Changelog

Older releases are archived by month:

- [2026-10](changelog/2026-10/CHANGELOG.md)
- [2026-09](changelog/2026-09/CHANGELOG.md)
- [2026-08](changelog/2026-08/CHANGELOG.md)
- [2026-07](changelog/2026-07/CHANGELOG.md)
- [2026-06](changelog/2026-06/CHANGELOG.md)
- [2026-05](changelog/2026-05/CHANGELOG.md)
- [2026-04](changelog/2026-04/CHANGELOG.md)

## [2.54.0](https://github.com/okou-ai/okou/compare/api-v2.53.2...api-v2.54.0) (2026-11-08)


### Features

* prepare template guidance bundle readers ([#45935](https://github.com/okou-ai/okou/issues/45935)) ([f7dce82](https://github.com/okou-ai/okou/commit/f7dce82c3f8feef4c1b1269552c69b839cfcf9c6))


### Performance Improvements

* **api:** batch owner-scoped project reference validation ([#45895](https://github.com/okou-ai/okou/issues/45895)) ([d8c2bce](https://github.com/okou-ai/okou/commit/d8c2bcec6d599e90e0e3e6e8e988d10b7030d53d))
* **api:** batch private attachment owner reads ([#45883](https://github.com/okou-ai/okou/issues/45883)) ([bf1fa96](https://github.com/okou-ai/okou/commit/bf1fa96477d2c92f5e096e5a2423c6dc8cdf1272))
* **api:** overlap runner candidate lookup with launch persistence ([#45882](https://github.com/okou-ai/okou/issues/45882)) ([05f52bb](https://github.com/okou-ai/okou/commit/05f52bbb2204e2c8bdc010fd11e704f48ce12dd1))
* **api:** reuse attachment lookups and refill validation slots ([#45892](https://github.com/okou-ai/okou/issues/45892)) ([08d7679](https://github.com/okou-ai/okou/commit/08d76793b064bbe3fc82f223707825c9f02dd058))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.45.0
    * @okouai/core bumped to 8.824.0
    * @okouai/db bumped to 2.24.0
    * @okouai/pi-agent-runtime bumped to 1.51.84

## [2.53.2](https://github.com/okou-ai/okou/compare/api-v2.53.1...api-v2.53.2) (2026-11-08)


### Refactoring

* **api:** retire non-seed skill storage publication ([#45919](https://github.com/okou-ai/okou/issues/45919)) ([c825fc8](https://github.com/okou-ai/okou/commit/c825fc80d116bfeeba68aa58ffb065dda29ebe6f))


### Performance Improvements

* **api:** stop tracing axiom ingest requests ([#45923](https://github.com/okou-ai/okou/issues/45923)) ([9909c82](https://github.com/okou-ai/okou/commit/9909c827471751874206d39e67f6747e1b2962e2))

## [2.53.1](https://github.com/okou-ai/okou/compare/api-v2.53.0...api-v2.53.1) (2026-11-07)


### Bug Fixes

* **browser:** prepare snapshot readers for complete tab lists ([#45867](https://github.com/okou-ai/okou/issues/45867)) ([22e6913](https://github.com/okou-ai/okou/commit/22e69133c44bd4449119c4c6ebdc9eee825fffcf))

## [2.53.0](https://github.com/okou-ai/okou/compare/api-v2.52.6...api-v2.53.0) (2026-11-07)


### Features

* **api:** force app.vm0.ai clients to upgrade to v0.1098.0 ([#45850](https://github.com/okou-ai/okou/issues/45850)) ([5d5fe56](https://github.com/okou-ai/okou/commit/5d5fe56e2df2386ea863fab58ed679705c1f82aa))


### Refactoring

* **connectors:** accept skill metadata without storage addresses ([#45846](https://github.com/okou-ai/okou/issues/45846)) ([fb2b44c](https://github.com/okou-ai/okou/commit/fb2b44cc80615dd5bbda9aab39af7897b3b18a40)) [#45309](https://github.com/okou-ai/okou/issues/45309)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.44.5
    * @okouai/connectors bumped to 3.21.6
    * @okouai/core bumped to 8.823.0
    * @okouai/db bumped to 2.23.12
    * @okouai/pi-agent-runtime bumped to 1.51.83

## [2.52.6](https://github.com/okou-ai/okou/compare/api-v2.52.5...api-v2.52.6) (2026-11-07)


### Refactoring

* **desktop:** replace heartbeat liveness with scoped presence ([#45811](https://github.com/okou-ai/okou/issues/45811)) ([4a7b3db](https://github.com/okou-ai/okou/commit/4a7b3db94ea5b97274f5ea3fb80689683c202254))


### Performance Improvements

* **runner:** reduce periodic heartbeats with immediate state reports ([#45825](https://github.com/okou-ai/okou/issues/45825)) ([8c64e5a](https://github.com/okou-ai/okou/commit/8c64e5aa6693a52afaa219b4a3ad51e368a17029))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.44.4
    * @okouai/core bumped to 8.822.4
    * @okouai/db bumped to 2.23.11
    * @okouai/pi-agent-runtime bumped to 1.51.82

## [2.52.5](https://github.com/okou-ai/okou/compare/api-v2.52.4...api-v2.52.5) (2026-11-07)


### Refactoring

* **api:** retire connector skill storage writes ([#45808](https://github.com/okou-ai/okou/issues/45808)) ([1eff26d](https://github.com/okou-ai/okou/commit/1eff26d7b735f6459f0157f1d111231bc6e0f9d4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.23.10

## [2.52.4](https://github.com/okou-ai/okou/compare/api-v2.52.3...api-v2.52.4) (2026-11-07)


### Refactoring

* remove single-character skill claim negotiation ([#45775](https://github.com/okou-ai/okou/issues/45775)) ([ff5a579](https://github.com/okou-ai/okou/commit/ff5a5793fa5f19083c6a4fe76f8c020554bea19f)) [#45748](https://github.com/okou-ai/okou/issues/45748)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.44.3
    * @okouai/core bumped to 8.822.3
    * @okouai/db bumped to 2.23.9
    * @okouai/pi-agent-runtime bumped to 1.51.81

## [2.52.3](https://github.com/okou-ai/okou/compare/api-v2.52.2...api-v2.52.3) (2026-11-06)


### Refactoring

* remove four fully rolled-out feature switches ([#45747](https://github.com/okou-ai/okou/issues/45747)) ([0f03d03](https://github.com/okou-ai/okou/commit/0f03d03881ff81b8eb72e1ceca6a80619603873c))


### Performance Improvements

* **browser:** combine authorized viewer acquisition ([#45723](https://github.com/okou-ai/okou/issues/45723)) ([92a34a9](https://github.com/okou-ai/okou/commit/92a34a9767f5c87fb7413a88fafa7d6e9febddef))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.44.2
    * @okouai/core bumped to 8.822.2
    * @okouai/db bumped to 2.23.8
    * @okouai/pi-agent-runtime bumped to 1.51.80

## [2.52.2](https://github.com/okou-ai/okou/compare/api-v2.52.1...api-v2.52.2) (2026-11-06)


### Bug Fixes

* refresh runner platform api and cli release markers ([#45745](https://github.com/okou-ai/okou/issues/45745)) ([47693c2](https://github.com/okou-ai/okou/commit/47693c2ed37fd90fa108346a36158d28c5c1c9ca))
* restore x connector skill claims across rolling deployments ([#45749](https://github.com/okou-ai/okou/issues/45749)) ([1f7157d](https://github.com/okou-ai/okou/commit/1f7157da70b987ac0d98274a333003a61fd75c91))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.44.1
    * @okouai/core bumped to 8.822.1
    * @okouai/db bumped to 2.23.7
    * @okouai/pi-agent-runtime bumped to 1.51.79

## [2.52.1](https://github.com/okou-ai/okou/compare/api-v2.52.0...api-v2.52.1) (2026-11-06)


### Bug Fixes

* **api:** return a bad request for custom account selection races ([#45721](https://github.com/okou-ai/okou/issues/45721)) ([ae350f6](https://github.com/okou-ai/okou/commit/ae350f6de0bd2076e6f03b18ec674b1ad1fb5174))
* **app:** make chat header panels consistent and retire artifacts auto-open ([#45669](https://github.com/okou-ai/okou/issues/45669)) ([11b6837](https://github.com/okou-ai/okou/commit/11b6837e854dcd643e31ca309b450b7a15a5de37))
* **browser:** attribute native window health failures ([#45698](https://github.com/okou-ai/okou/issues/45698)) ([37ee564](https://github.com/okou-ai/okou/commit/37ee564ebb06f50a8906ab2159b1769e539c1e94))


### Refactoring

* **api:** make connector skill bundle delivery unconditional ([#45697](https://github.com/okou-ai/okou/issues/45697)) ([767c72c](https://github.com/okou-ai/okou/commit/767c72c2e73de6a774581bcb9fd4b01ecfc46f19))


### Performance Improvements

* refresh chat indicators only on run state changes ([#45712](https://github.com/okou-ai/okou/issues/45712)) ([ac06095](https://github.com/okou-ai/okou/commit/ac0609591b2a0a5f159afb50b7561df46a23f6a4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.44.0
    * @okouai/core bumped to 8.822.0
    * @okouai/db bumped to 2.23.6
    * @okouai/pi-agent-runtime bumped to 1.51.78

## [2.52.0](https://github.com/okou-ai/okou/compare/api-v2.51.1...api-v2.52.0) (2026-11-06)


### Features

* roll out message pdf export, pwa navigation and subscription usage to all users ([#45649](https://github.com/okou-ai/okou/issues/45649)) ([7dfca6c](https://github.com/okou-ai/okou/commit/7dfca6cb087e0337b3519a8ae72d1fefd271ff69))


### Bug Fixes

* synchronize instruction editors with external saves ([#45677](https://github.com/okou-ai/okou/issues/45677)) ([edce7e5](https://github.com/okou-ai/okou/commit/edce7e52437c912359603b4672b50300605b4fff))


### Refactoring

* remove chat thread archiving and muting feature switches ([#45680](https://github.com/okou-ai/okou/issues/45680)) ([4183b2f](https://github.com/okou-ai/okou/commit/4183b2f44fb472a38962c5ad3124939bb11b5cdc))


### Performance Improvements

* **api:** reference default personal instructions instead of initializing at dispatch ([#45686](https://github.com/okou-ai/okou/issues/45686)) ([22b2e6b](https://github.com/okou-ai/okou/commit/22b2e6b28a4eda306d61ba6a35e17a1d9831d74d))
* **api:** reuse immutable connector permission indexes ([#45687](https://github.com/okou-ai/okou/issues/45687)) ([1e5e709](https://github.com/okou-ai/okou/commit/1e5e70969033c330b2e5c3bc6732cc70edb3cf4a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.43.3
    * @okouai/core bumped to 8.821.0
    * @okouai/db bumped to 2.23.5
    * @okouai/pi-agent-runtime bumped to 1.51.77

## [2.51.1](https://github.com/okou-ai/okou/compare/api-v2.51.0...api-v2.51.1) (2026-11-06)


### Refactoring

* remove marketing content handoff feature switch ([#45651](https://github.com/okou-ai/okou/issues/45651)) ([75493dc](https://github.com/okou-ai/okou/commit/75493dc2e0b68047d72fe961678f549c94ba9be5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.820.1
    * @okouai/db bumped to 2.23.4
    * @okouai/pi-agent-runtime bumped to 1.51.76

## [2.51.0](https://github.com/okou-ai/okou/compare/api-v2.50.0...api-v2.51.0) (2026-11-06)


### Features

* **api:** stage connector skill bundle delivery ([#45631](https://github.com/okou-ai/okou/issues/45631)) ([885c5cf](https://github.com/okou-ai/okou/commit/885c5cf9e2e261bb969a025529b98e8848583ad8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.820.0
    * @okouai/db bumped to 2.23.3
    * @okouai/pi-agent-runtime bumped to 1.51.75

## [2.50.0](https://github.com/okou-ai/okou/compare/api-v2.49.2...api-v2.50.0) (2026-11-06)


### Features

* **api:** force app.vm0.ai clients to upgrade to v0.1095.2 ([#45617](https://github.com/okou-ai/okou/issues/45617)) ([dc460f6](https://github.com/okou-ai/okou/commit/dc460f627471a01d44f8d0c4fd3c40a8dfc61a08))


### Bug Fixes

* **api:** log private multipart upload rejection reasons ([#45625](https://github.com/okou-ai/okou/issues/45625)) ([d95bb8e](https://github.com/okou-ai/okou/commit/d95bb8e390d5acdc1273607f8f2d79c039ed7638))
* **integrations:** prioritize thread context for short replies ([#45622](https://github.com/okou-ai/okou/issues/45622)) ([15ae7e2](https://github.com/okou-ai/okou/commit/15ae7e2be7d8aac6a18f074140af2a6883ec1c36))


### Refactoring

* retire halloween campaign and restore the greeting avatar ([#45618](https://github.com/okou-ai/okou/issues/45618)) ([60127c6](https://github.com/okou-ai/okou/commit/60127c60e299ae35549f889340859cd758f78db5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.43.2
    * @okouai/core bumped to 8.819.2
    * @okouai/db bumped to 2.23.2
    * @okouai/pi-agent-runtime bumped to 1.51.74

## [2.49.2](https://github.com/okou-ai/okou/compare/api-v2.49.1...api-v2.49.2) (2026-11-06)


### Refactoring

* **api:** enforce fixed instance environment configuration ([#45542](https://github.com/okou-ai/okou/issues/45542)) ([64fc3ee](https://github.com/okou-ai/okou/commit/64fc3eef0b63ac6cff825515cf11160e890858be))


### Performance Improvements

* **api:** narrow claim permission catalog projection ([#45541](https://github.com/okou-ai/okou/issues/45541)) ([1b602d3](https://github.com/okou-ai/okou/commit/1b602d3789e8552268ab9e10fc87b0ec518dac22))

## [2.49.1](https://github.com/okou-ai/okou/compare/api-v2.49.0...api-v2.49.1) (2026-11-06)


### Refactoring

* **app:** stop passing view callbacks into platform commands ([#45452](https://github.com/okou-ai/okou/issues/45452)) ([8725c3b](https://github.com/okou-ai/okou/commit/8725c3b15d76e1bdf76b1421d22e7803a6c405cb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.43.1
    * @okouai/core bumped to 8.819.1
    * @okouai/db bumped to 2.23.1
    * @okouai/pi-agent-runtime bumped to 1.51.73

## [2.49.0](https://github.com/okou-ai/okou/compare/api-v2.48.10...api-v2.49.0) (2026-11-05)


### Features

* **api:** add personal instructions and captured run source ([#45498](https://github.com/okou-ai/okou/issues/45498)) ([b309bcb](https://github.com/okou-ai/okou/commit/b309bcbfa7f2245d6c3909f44c59e6ab763a2d83))
* **cli:** add personal instructions and captured my okou guidance ([#45499](https://github.com/okou-ai/okou/issues/45499)) ([392b08d](https://github.com/okou-ai/okou/commit/392b08d79f8d257cdcb0f78ddf22b962013d298c))
* **workflow:** support personal workspace workflows in single-agent mode ([#45497](https://github.com/okou-ai/okou/issues/45497)) ([b74dd61](https://github.com/okou-ai/okou/commit/b74dd614ea04401617b27c9d07ce5562eae3743b))


### Bug Fixes

* **api:** preserve workflow mode after runner claim ([#45511](https://github.com/okou-ai/okou/issues/45511)) ([402b9fe](https://github.com/okou-ai/okou/commit/402b9fe279e8c7e608bff33cc0d49dcecd88054f))


### Refactoring

* retire reddit oauth and remove feature switch ([#45441](https://github.com/okou-ai/okou/issues/45441)) ([eb71c77](https://github.com/okou-ai/okou/commit/eb71c779eeb2aab3a9caf02e67a6f63715b68589))
* simplify suggestion feedback context ([#45493](https://github.com/okou-ai/okou/issues/45493)) ([f52030e](https://github.com/okou-ai/okou/commit/f52030ec40ee282a9f7de9d270ba4282639c26ab))


### Performance Improvements

* **api:** cache content bundle signed urls across claims ([#45507](https://github.com/okou-ai/okou/issues/45507)) ([093a9ac](https://github.com/okou-ai/okou/commit/093a9ac15a2fa5d2f3acf1d46de8c070d28c5227))
* **browser:** skip discovery for native window health ([#45520](https://github.com/okou-ai/okou/issues/45520)) ([cb89c0e](https://github.com/okou-ai/okou/commit/cb89c0e6b03f6bc7d29d891d190034bfff861b86))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.43.0
    * @okouai/connectors bumped to 3.21.5
    * @okouai/core bumped to 8.819.0
    * @okouai/db bumped to 2.23.0
    * @okouai/pi-agent-runtime bumped to 1.51.72

## [2.48.10](https://github.com/okou-ai/okou/compare/api-v2.48.9...api-v2.48.10) (2026-11-05)


### Refactoring

* remove zapier connector feature switch ([#45434](https://github.com/okou-ai/okou/issues/45434)) ([a0dffed](https://github.com/okou-ai/okou/commit/a0dffedcad6d1a71682fc099d55b9877156857b6))
* retire ahrefs oauth and remove feature switch ([#45430](https://github.com/okou-ai/okou/issues/45430)) ([385da3e](https://github.com/okou-ai/okou/commit/385da3e75b353bf977474131072c27ca2f1840c9))
* retire deel oauth and remove feature switch ([#45438](https://github.com/okou-ai/okou/issues/45438)) ([e9a395b](https://github.com/okou-ai/okou/commit/e9a395b39628a6859a1eb92e21d1368c215f0fa0))
* retire neon oauth and remove feature switch ([#45440](https://github.com/okou-ai/okou/issues/45440)) ([a65332c](https://github.com/okou-ai/okou/commit/a65332c2b52eaa01436a08f5fa2eda241530b0df))


### Performance Improvements

* **api:** attribute runner claim signing and policy refresh time ([#45465](https://github.com/okou-ai/okou/issues/45465)) ([6dc4e5f](https://github.com/okou-ai/okou/commit/6dc4e5fb64a0ba294794ec9f2fc60cb4bd1031f9))
* **browser:** validate shared browser reuse once ([#45443](https://github.com/okou-ai/okou/issues/45443)) ([0d8f922](https://github.com/okou-ai/okou/commit/0d8f9227aa48465ef824f7d157dbad97c1ff7d78))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.42.5
    * @okouai/connectors bumped to 3.21.4
    * @okouai/core bumped to 8.818.7
    * @okouai/db bumped to 2.22.8
    * @okouai/pi-agent-runtime bumped to 1.51.71

## [2.48.9](https://github.com/okou-ai/okou/compare/api-v2.48.8...api-v2.48.9) (2026-11-05)


### Refactoring

* remove bill connector feature switch ([#45424](https://github.com/okou-ai/okou/issues/45424)) ([96a631a](https://github.com/okou-ai/okou/commit/96a631a4b162fc73d2107781900d888f140738a7))
* remove netsuite connector feature switch ([#45428](https://github.com/okou-ai/okou/issues/45428)) ([b4e2b13](https://github.com/okou-ai/okou/commit/b4e2b13a0b1406c5d743c07d85846e8dc32b3414))
* remove workday connector feature switch ([#45437](https://github.com/okou-ai/okou/issues/45437)) ([cdabb63](https://github.com/okou-ai/okou/commit/cdabb63e8d24c30353cb01fe84cfd620d3091ffd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.818.6
    * @okouai/db bumped to 2.22.7
    * @okouai/pi-agent-runtime bumped to 1.51.70

## [2.48.8](https://github.com/okou-ai/okou/compare/api-v2.48.7...api-v2.48.8) (2026-11-05)


### Refactoring

* **teams:** retire v1 upload protocol independently of account ownership ([#45413](https://github.com/okou-ai/okou/issues/45413)) ([a63d7c1](https://github.com/okou-ai/okou/commit/a63d7c10b05eda93f6ba0cd1b719f988796fb1c3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.42.4
    * @okouai/core bumped to 8.818.5
    * @okouai/db bumped to 2.22.6
    * @okouai/pi-agent-runtime bumped to 1.51.69

## [2.48.7](https://github.com/okou-ai/okou/compare/api-v2.48.6...api-v2.48.7) (2026-11-05)


### Refactoring

* remove close connector feature switch ([#45384](https://github.com/okou-ai/okou/issues/45384)) ([50e1913](https://github.com/okou-ai/okou/commit/50e1913bdce011ced6e184c0806bf389e61052e4))
* remove expensify connector feature switch ([#45387](https://github.com/okou-ai/okou/issues/45387)) ([5c434bc](https://github.com/okou-ai/okou/commit/5c434bc83fddc0ba7dbfdead87154c73eb28d154))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.818.4
    * @okouai/db bumped to 2.22.5
    * @okouai/pi-agent-runtime bumped to 1.51.68

## [2.48.6](https://github.com/okou-ai/okou/compare/api-v2.48.5...api-v2.48.6) (2026-11-05)


### Refactoring

* **api:** prepare connector skill bundle references ([#45339](https://github.com/okou-ai/okou/issues/45339)) ([6a51f10](https://github.com/okou-ai/okou/commit/6a51f10737ae9c0e2ee40509387fbd6f04b0f095))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.42.3
    * @okouai/connectors bumped to 3.21.3
    * @okouai/core bumped to 8.818.3
    * @okouai/db bumped to 2.22.4
    * @okouai/pi-agent-runtime bumped to 1.51.67

## [2.48.5](https://github.com/okou-ai/okou/compare/api-v2.48.4...api-v2.48.5) (2026-11-05)


### Bug Fixes

* **api:** preserve connector permission scope and grant expiry ([#45340](https://github.com/okou-ai/okou/issues/45340)) ([5d9c758](https://github.com/okou-ai/okou/commit/5d9c758aeaae80e595011dbe1da099097a462759))

## [2.48.4](https://github.com/okou-ai/okou/compare/api-v2.48.3...api-v2.48.4) (2026-11-05)


### Performance Improvements

* **app:** cache chat connector overview and refresh changed targets ([#45294](https://github.com/okou-ai/okou/issues/45294)) ([1b68448](https://github.com/okou-ai/okou/commit/1b684482eb01e7ff92d743ae140f7d6ea5932c1d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.42.2
    * @okouai/core bumped to 8.818.2
    * @okouai/db bumped to 2.22.3
    * @okouai/pi-agent-runtime bumped to 1.51.66

## [2.48.3](https://github.com/okou-ai/okou/compare/api-v2.48.2...api-v2.48.3) (2026-11-05)


### Refactoring

* remove proactive planning and tasks ([#45210](https://github.com/okou-ai/okou/issues/45210)) ([222d861](https://github.com/okou-ai/okou/commit/222d8618346194b5af227c5e147a0076181ee3e0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.42.1
    * @okouai/core bumped to 8.818.1
    * @okouai/db bumped to 2.22.2
    * @okouai/pi-agent-runtime bumped to 1.51.65

## [2.48.2](https://github.com/okou-ai/okou/compare/api-v2.48.1...api-v2.48.2) (2026-11-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.22.1

## [2.48.1](https://github.com/okou-ai/okou/compare/api-v2.48.0...api-v2.48.1) (2026-11-04)


### Refactoring

* **api:** simplify incomplete chat context recovery ([#45237](https://github.com/okou-ai/okou/issues/45237)) ([d8673df](https://github.com/okou-ai/okou/commit/d8673df49047add4ddec8a44b0fd7e2639752107))

## [2.48.0](https://github.com/okou-ai/okou/compare/api-v2.47.0...api-v2.48.0) (2026-11-04)


### Features

* **teams:** prepare account-scoped canonical uploads ([#45181](https://github.com/okou-ai/okou/issues/45181)) ([03f0c3e](https://github.com/okou-ai/okou/commit/03f0c3e07a46fc9ba300255498cd7af707d7020c))


### Bug Fixes

* **api:** preserve immutable bundle uploads and cancellation ([#45217](https://github.com/okou-ai/okou/issues/45217)) ([e5de08f](https://github.com/okou-ai/okou/commit/e5de08f80346912dc3f86aa4aa271bd6f1120f04))
* **api:** recover concurrent agent identity conflicts ([#45233](https://github.com/okou-ai/okou/issues/45233)) ([3f1c80a](https://github.com/okou-ai/okou/commit/3f1c80afd6b11681ce107faf4cb86c6e9c6fd4b0))
* refresh runner platform api and cli release markers ([#45244](https://github.com/okou-ai/okou/issues/45244)) ([a1933e5](https://github.com/okou-ai/okou/commit/a1933e593f4c66bce81c0ac201cd40c5826a07f9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.42.0
    * @okouai/core bumped to 8.818.0
    * @okouai/db bumped to 2.22.0
    * @okouai/pi-agent-runtime bumped to 1.51.64

## [2.47.0](https://github.com/okou-ai/okou/compare/api-v2.46.3...api-v2.47.0) (2026-11-04)


### Features

* switch registry downloads to independent archives ([#45172](https://github.com/okou-ai/okou/issues/45172)) ([7b2c84e](https://github.com/okou-ai/okou/commit/7b2c84e6f17b88c2a9fe165ad6efe9d80672be9e))


### Bug Fixes

* **api:** classify agentphone webhook content rejections ([#45167](https://github.com/okou-ai/okou/issues/45167)) ([33922e5](https://github.com/okou-ai/okou/commit/33922e5d81237d206be59621b4501172b054178a))
* **api:** reuse published content bundles ([#45215](https://github.com/okou-ai/okou/issues/45215)) ([a3a492d](https://github.com/okou-ai/okou/commit/a3a492d75c838e45d506d94484d0a12928d8abb0))
* **api:** route named platforms to data router families in run prompt ([#45185](https://github.com/okou-ai/okou/issues/45185)) ([9277115](https://github.com/okou-ai/okou/commit/9277115040db02346f8ed6e2d9b397cd81c077fe))
* **marketing:** verify short addresses in batch publication ([#45163](https://github.com/okou-ai/okou/issues/45163)) ([a965f60](https://github.com/okou-ai/okou/commit/a965f602dcb1d2090596f563a1e660a7ace97e66))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.41.0
    * @okouai/core bumped to 8.817.0
    * @okouai/db bumped to 2.21.0
    * @okouai/pi-agent-runtime bumped to 1.51.63

## [2.46.3](https://github.com/okou-ai/okou/compare/api-v2.46.2...api-v2.46.3) (2026-11-04)


### Bug Fixes

* **api:** auto-continue rate-limited chats ([#45119](https://github.com/okou-ai/okou/issues/45119)) ([21424ad](https://github.com/okou-ai/okou/commit/21424ad05c8527e2017c2869d9f413098fcd9955))
* **api:** honor effective oauth dcr authentication methods ([#45148](https://github.com/okou-ai/okou/issues/45148)) ([5dc70bb](https://github.com/okou-ai/okou/commit/5dc70bb1131edac912c4f410481bc9f6b5e17cf1))


### Refactoring

* inject suggestions feedback into run context ([#45160](https://github.com/okou-ai/okou/issues/45160)) ([c1968cc](https://github.com/okou-ai/okou/commit/c1968ccdb16c1371d660e5fa7d54002400102e63))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.40.1
    * @okouai/core bumped to 8.816.0
    * @okouai/db bumped to 2.20.3
    * @okouai/pi-agent-runtime bumped to 1.51.62

## [2.46.2](https://github.com/okou-ai/okou/compare/api-v2.46.1...api-v2.46.2) (2026-11-04)


### Bug Fixes

* **api:** keep automation listeners on allowed chat accounts after deletion ([#45052](https://github.com/okou-ai/okou/issues/45052)) ([9b16eed](https://github.com/okou-ai/okou/commit/9b16eedce1e66d9bc4ea4faffb0d2dfb0728efd5))
* **api:** render notification emails with marked ([#45100](https://github.com/okou-ai/okou/issues/45100)) ([3188803](https://github.com/okou-ai/okou/commit/31888030d8487b938a27423463fa6d6e34692cac))
* **api:** skip follow-ups after thread deletion ([#45110](https://github.com/okou-ai/okou/issues/45110)) ([2fddf0e](https://github.com/okou-ai/okou/commit/2fddf0e56cf6f94451acdedbe7a48c60fb287cd3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.20.2

## [2.46.1](https://github.com/okou-ai/okou/compare/api-v2.46.0...api-v2.46.1) (2026-11-04)


### Bug Fixes

* **api:** preserve atlassian mcp discovery ranking ([#45022](https://github.com/okou-ai/okou/issues/45022)) ([bb377bb](https://github.com/okou-ai/okou/commit/bb377bbc4144455628028f135f274342d4499c9f))
* **api:** show claude max and ultra plan names ([#45011](https://github.com/okou-ai/okou/issues/45011)) ([af4db60](https://github.com/okou-ai/okou/commit/af4db608f8700c96b1059caaa01b9e0441b580f4))
* **api:** synchronize automation listeners after chat account changes ([#45040](https://github.com/okou-ai/okou/issues/45040)) ([8441431](https://github.com/okou-ai/okou/commit/84414314b470b9bee9db37ff16af3ea590fad198))


### Refactoring

* **api:** require available accounts for every initial connector choice ([#45058](https://github.com/okou-ai/okou/issues/45058)) ([83ae79f](https://github.com/okou-ai/okou/commit/83ae79f68d6a7cfbeabb93e1726d0420dcd762fb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.40.0
    * @okouai/core bumped to 8.815.0
    * @okouai/db bumped to 2.20.1
    * @okouai/pi-agent-runtime bumped to 1.51.61

## [2.46.0](https://github.com/okou-ai/okou/compare/api-v2.45.1...api-v2.46.0) (2026-11-03)


### Features

* add friend referrals with expiring credit rewards ([#44961](https://github.com/okou-ai/okou/issues/44961)) ([beaff0e](https://github.com/okou-ai/okou/commit/beaff0e0ddf72f5d2fcd835314f14d6661e721af))
* shorten marketing handoff links to twelve characters ([#44980](https://github.com/okou-ai/okou/issues/44980)) ([046a7ba](https://github.com/okou-ai/okou/commit/046a7bac03cc5f5a94cc67394756f69be2eaf111))


### Performance Improvements

* **api:** batch incremental marketing handoff publication ([#44976](https://github.com/okou-ai/okou/issues/44976)) ([392e0ef](https://github.com/okou-ai/okou/commit/392e0ef3ddc3f55fa2842c3c48459adfe2891a33))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.39.0
    * @okouai/connectors bumped to 3.21.2
    * @okouai/core bumped to 8.814.0
    * @okouai/db bumped to 2.20.0
    * @okouai/pi-agent-runtime bumped to 1.51.60

## [2.45.1](https://github.com/okou-ai/okou/compare/api-v2.45.0...api-v2.45.1) (2026-11-03)


### Bug Fixes

* **api:** compact existing memory during proactive learning ([#44953](https://github.com/okou-ai/okou/issues/44953)) ([9acb4f0](https://github.com/okou-ai/okou/commit/9acb4f0004c16177a63ff6f6d836dcdde10f8907))
* **integrations:** unify attribution and remove model footers ([#44941](https://github.com/okou-ai/okou/issues/44941)) ([7e379df](https://github.com/okou-ai/okou/commit/7e379df88127354feea56ebeca0a84807cf2551c))


### Refactoring

* retire project wire preparation adapters ([#44956](https://github.com/okou-ai/okou/issues/44956)) ([babbf94](https://github.com/okou-ai/okou/commit/babbf9431679a767b0e6e8221d99a3c50b094293))


### Performance Improvements

* **api:** cut chat send and runner reuse sql round trips ([#44924](https://github.com/okou-ai/okou/issues/44924)) ([7d074ee](https://github.com/okou-ai/okou/commit/7d074eeaaf1367755c83eead825b0c9130988f4f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.38.1
    * @okouai/browser-extension-client bumped to 0.4.4
    * @okouai/core bumped to 8.813.1
    * @okouai/db bumped to 2.19.1
    * @okouai/pi-agent-runtime bumped to 1.51.59

## [2.45.0](https://github.com/okou-ai/okou/compare/api-v2.44.2...api-v2.45.0) (2026-11-03)


### Features

* **api:** show active connector catalog version in debug settings ([#44900](https://github.com/okou-ai/okou/issues/44900)) ([2e3fd47](https://github.com/okou-ai/okou/commit/2e3fd47a9993bfee38cba6607954b37e4ff1222c))
* prepare storage-independent registry resource archives ([#44895](https://github.com/okou-ai/okou/issues/44895)) ([e894e7e](https://github.com/okou-ai/okou/commit/e894e7e17a3a0e7285f537e50958051e4dbd13d7))


### Bug Fixes

* record safe connector oauth callback failures ([#44922](https://github.com/okou-ai/okou/issues/44922)) ([32ca387](https://github.com/okou-ai/okou/commit/32ca387252ee3230930cd4baa694c9a7a87de88d))


### Refactoring

* **api:** remove browser window bookkeeping from prompts ([#44906](https://github.com/okou-ai/okou/issues/44906)) ([43da01e](https://github.com/okou-ai/okou/commit/43da01ebb58b43156fe6b0d3ae4ed96021a7253f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.38.0
    * @okouai/connectors bumped to 3.21.1
    * @okouai/core bumped to 8.813.0
    * @okouai/db bumped to 2.19.0
    * @okouai/pi-agent-runtime bumped to 1.51.58

## [2.44.2](https://github.com/okou-ai/okou/compare/api-v2.44.1...api-v2.44.2) (2026-11-03)


### Bug Fixes

* preserve imessage history received before connecting ([#44875](https://github.com/okou-ai/okou/issues/44875)) ([fdd3263](https://github.com/okou-ai/okou/commit/fdd32631946bbe3eec64ab86483bbfb6e74760d5))


### Refactoring

* retire shared-chat link, site title and telegram bot list compatibility ([#44887](https://github.com/okou-ai/okou/issues/44887)) ([d8f4e29](https://github.com/okou-ai/okou/commit/d8f4e29836f9a70ea4f1c2ee54de79c2380a37f9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.37.1
    * @okouai/core bumped to 8.812.2
    * @okouai/db bumped to 2.18.5
    * @okouai/pi-agent-runtime bumped to 1.51.57

## [2.44.1](https://github.com/okou-ai/okou/compare/api-v2.44.0...api-v2.44.1) (2026-11-03)


### Bug Fixes

* authorize imessage group sends by current membership ([#44868](https://github.com/okou-ai/okou/issues/44868)) ([94a8911](https://github.com/okou-ai/okou/commit/94a8911769d50d1949ce207669c90ef389353c85))

## [2.44.0](https://github.com/okou-ai/okou/compare/api-v2.43.0...api-v2.44.0) (2026-11-03)


### Features

* add shared imessage group discovery ([#44856](https://github.com/okou-ai/okou/issues/44856)) ([0980704](https://github.com/okou-ai/okou/commit/0980704d01366e046fc13733fb679f7740253a76))


### Bug Fixes

* allow project snapshot garbage collection progress ([#44855](https://github.com/okou-ai/okou/issues/44855)) ([cce4d0c](https://github.com/okou-ai/okou/commit/cce4d0cda93e3e861f6c202e6056589fd5ee18a4))
* attribute local firewall auth failures through run completion ([#44847](https://github.com/okou-ai/okou/issues/44847)) ([d672c61](https://github.com/okou-ai/okou/commit/d672c6141ad26b6f19522363841b7659a7c38673))
* **workflows:** retry transient gmail history reads without warning logs ([#44853](https://github.com/okou-ai/okou/issues/44853)) ([91cdfb9](https://github.com/okou-ai/okou/commit/91cdfb92a83bad344f2849d45b9b6b7ed12b5094))


### Refactoring

* **workflows:** retire official storage execution compatibility ([#44854](https://github.com/okou-ai/okou/issues/44854)) ([8eb2a91](https://github.com/okou-ai/okou/commit/8eb2a91f518b62e0363749f8387f36a46dc4cd38))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.37.0
    * @okouai/core bumped to 8.812.1
    * @okouai/db bumped to 2.18.4
    * @okouai/pi-agent-runtime bumped to 1.51.56

## [2.43.0](https://github.com/okou-ai/okou/compare/api-v2.42.0...api-v2.43.0) (2026-11-03)


### Features

* add staff-gated tiktok oauth ([#44849](https://github.com/okou-ai/okou/issues/44849)) ([7176b11](https://github.com/okou-ai/okou/commit/7176b11ac1bd57ce3ff0f4c78fa41f58a1b67bb8))


### Bug Fixes

* **api:** classify snapshot local resource failures ([#44834](https://github.com/okou-ai/okou/issues/44834)) ([a14a92e](https://github.com/okou-ai/okou/commit/a14a92e7af4121ec64ec2c6e3a3027108405d025))
* **api:** reuse lazy s3 clients and bound shared connections ([#44831](https://github.com/okou-ai/okou/issues/44831)) ([a547ff8](https://github.com/okou-ai/okou/commit/a547ff89ff469c2ca7053aee7a69837afc2c4f38))
* **browser:** retain shared window reconciliation failure details ([#44838](https://github.com/okou-ai/okou/issues/44838)) ([c0d9fd9](https://github.com/okou-ai/okou/commit/c0d9fd98c6d8852558150802ba517d5342bfa551))
* reuse marketing handoff S3 transport across requests ([#44752](https://github.com/okou-ai/okou/issues/44752)) ([daf6b22](https://github.com/okou-ai/okou/commit/daf6b223c62e0f8290e5fe40d3fc9e10bc6dd8bd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.36.1
    * @okouai/connectors bumped to 3.21.0
    * @okouai/core bumped to 8.812.0
    * @okouai/db bumped to 2.18.3
    * @okouai/pi-agent-runtime bumped to 1.51.55

## [2.42.0](https://github.com/okou-ai/okou/compare/api-v2.41.1...api-v2.42.0) (2026-11-03)


### Features

* use chat connector accounts for runs and cli switching ([#44778](https://github.com/okou-ai/okou/issues/44778)) ([9eb2bcb](https://github.com/okou-ai/okou/commit/9eb2bcba1f9804a86b338b63eb0c05d20852962f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.36.0
    * @okouai/browser-extension-client bumped to 0.4.3
    * @okouai/core bumped to 8.811.1
    * @okouai/db bumped to 2.18.2
    * @okouai/pi-agent-runtime bumped to 1.51.54

## [2.41.1](https://github.com/okou-ai/okou/compare/api-v2.41.0...api-v2.41.1) (2026-11-03)


### Bug Fixes

* **e2e:** retry stalled agent creation after five seconds safely ([#44770](https://github.com/okou-ai/okou/issues/44770)) ([8cfb1c3](https://github.com/okou-ai/okou/commit/8cfb1c34bf6ed6e28127fb8aaff1e1f6d6f231bd))


### Refactoring

* **skills:** detach legacy seed storage bindings ([#44760](https://github.com/okou-ai/okou/issues/44760)) ([352c12e](https://github.com/okou-ai/okou/commit/352c12e45336e4d35e27394d92de09ec170f728c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.35.0
    * @okouai/core bumped to 8.811.0
    * @okouai/db bumped to 2.18.1
    * @okouai/pi-agent-runtime bumped to 1.51.53

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
