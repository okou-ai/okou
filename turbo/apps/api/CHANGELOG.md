# Changelog

Older releases are archived by month:

- [2026-10](changelog/2026-10/CHANGELOG.md)
- [2026-09](changelog/2026-09/CHANGELOG.md)
- [2026-08](changelog/2026-08/CHANGELOG.md)
- [2026-07](changelog/2026-07/CHANGELOG.md)
- [2026-06](changelog/2026-06/CHANGELOG.md)
- [2026-05](changelog/2026-05/CHANGELOG.md)
- [2026-04](changelog/2026-04/CHANGELOG.md)

## [2.142.0](https://github.com/okou-ai/okou/compare/api-v2.141.0...api-v2.142.0) (2026-11-27)


### Features

* **artifacts:** add unified artifact access api, files dual-write, and client migration ([#51416](https://github.com/okou-ai/okou/issues/51416)) ([2980f4b](https://github.com/okou-ai/okou/commit/2980f4b5f176b0fa5cd871b71a1c5a9a90717eb5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.143.0
    * @okouai/core bumped to 8.888.0
    * @okouai/db bumped to 2.73.0
    * @okouai/pi-agent-runtime bumped to 1.52.107

## [2.141.0](https://github.com/okou-ai/okou/compare/api-v2.140.3...api-v2.141.0) (2026-11-27)


### Features

* carry builtin firewall placeholders to runner ([#51568](https://github.com/okou-ai/okou/issues/51568)) ([1491876](https://github.com/okou-ai/okou/commit/149187644f73ac84bce660e192eab03ad38c251f))
* **platform:** allow renaming remote devices ([#51545](https://github.com/okou-ai/okou/issues/51545)) ([da8e9a8](https://github.com/okou-ai/okou/commit/da8e9a8cf879e42a1a402c98d2b891a91703e404))


### Bug Fixes

* **api:** require web 0.1180.0 for suggestions compatibility ([#51578](https://github.com/okou-ai/okou/issues/51578)) ([7f8e736](https://github.com/okou-ai/okou/commit/7f8e736db39801406d4161c20e45800c0f04b33e))


### Refactoring

* **api:** retire the proactive scheduler handoff ([#51579](https://github.com/okou-ai/okou/issues/51579)) ([fd7c785](https://github.com/okou-ai/okou/commit/fd7c78522aa4d1bbd900ed50606b291fc582cbf5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.142.0
    * @okouai/connectors bumped to 3.27.0
    * @okouai/core bumped to 8.887.11
    * @okouai/db bumped to 2.72.4
    * @okouai/pi-agent-runtime bumped to 1.52.106

## [2.140.3](https://github.com/okou-ai/okou/compare/api-v2.140.2...api-v2.140.3) (2026-11-27)


### Refactoring

* **api:** remove retired official workflow paths ([#51547](https://github.com/okou-ai/okou/issues/51547)) ([8aeee6a](https://github.com/okou-ai/okou/commit/8aeee6ac04dd5b60c8b2e72cb859fb09ecce56c7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.141.2
    * @okouai/core bumped to 8.887.10
    * @okouai/db bumped to 2.72.3
    * @okouai/pi-agent-runtime bumped to 1.52.105

## [2.140.2](https://github.com/okou-ai/okou/compare/api-v2.140.1...api-v2.140.2) (2026-11-27)


### Bug Fixes

* **api:** handle account deletion during chat connector selection ([#51496](https://github.com/okou-ai/okou/issues/51496)) ([fec30b8](https://github.com/okou-ai/okou/commit/fec30b8cef2ab7863fadcb720d8233b318c1db40))
* keep presentation conversion cli-only for staff ([#51491](https://github.com/okou-ai/okou/issues/51491)) ([01e91b1](https://github.com/okou-ai/okou/commit/01e91b16ebf389c63c2d59b5406154d30369be86))


### Refactoring

* remove markdown-first output feature switch ([#51492](https://github.com/okou-ai/okou/issues/51492)) ([50510b8](https://github.com/okou-ai/okou/commit/50510b8e1d508dadfd4048f6ec16733edacafebb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.141.1
    * @okouai/core bumped to 8.887.9
    * @okouai/db bumped to 2.72.2
    * @okouai/pi-agent-runtime bumped to 1.52.104

## [2.140.1](https://github.com/okou-ai/okou/compare/api-v2.140.0...api-v2.140.1) (2026-11-27)


### Performance Improvements

* **artifacts:** batch covers behind the library switch ([#51464](https://github.com/okou-ai/okou/issues/51464)) ([3462fe6](https://github.com/okou-ai/okou/commit/3462fe66da1741d8902e7f846e852ecca1775756))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.141.0
    * @okouai/core bumped to 8.887.8
    * @okouai/db bumped to 2.72.1
    * @okouai/pi-agent-runtime bumped to 1.52.103

## [2.140.0](https://github.com/okou-ai/okou/compare/api-v2.139.1...api-v2.140.0) (2026-11-27)


### Features

* **platform:** add remote device deletion with confirmation ([#51428](https://github.com/okou-ai/okou/issues/51428)) ([b09fbb2](https://github.com/okou-ai/okou/commit/b09fbb279a729ee9f57878dfcb798b7cfa930170))


### Refactoring

* **api:** retire official workflow admission for proactive runs ([#51409](https://github.com/okou-ai/okou/issues/51409)) ([7a23914](https://github.com/okou-ai/okou/commit/7a239141cfc683da184e8f42ff2456b294025b7d))
* **api:** retire template startup ordering anchors ([#51368](https://github.com/okou-ai/okou/issues/51368)) ([b31aeaa](https://github.com/okou-ai/okou/commit/b31aeaaa18d1d578c8fd506560371d7a46d0debf))


### Performance Improvements

* **api:** bound artifact library list and search queries ([#51460](https://github.com/okou-ai/okou/issues/51460)) ([d443ccc](https://github.com/okou-ai/okou/commit/d443ccc7f45264f8bde975c8a30f54ae9755f882))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.140.0
    * @okouai/core bumped to 8.887.7
    * @okouai/db bumped to 2.72.0
    * @okouai/pi-agent-runtime bumped to 1.52.102

## [2.139.1](https://github.com/okou-ai/okou/compare/api-v2.139.0...api-v2.139.1) (2026-11-27)


### Performance Improvements

* **api:** reduce database round-trips in run launch, terminal callback, and search projection paths ([#51389](https://github.com/okou-ai/okou/issues/51389)) ([74f349f](https://github.com/okou-ai/okou/commit/74f349f7a046715e24dac37d3fd64401cc9419c3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.139.0
    * @okouai/core bumped to 8.887.6
    * @okouai/db bumped to 2.71.13
    * @okouai/pi-agent-runtime bumped to 1.52.101

## [2.139.0](https://github.com/okou-ai/okou/compare/api-v2.138.7...api-v2.139.0) (2026-11-27)


### Features

* **api,ios:** remove transitional client transforms and support google ai on ios ([#51397](https://github.com/okou-ai/okou/issues/51397)) ([837d89a](https://github.com/okou-ai/okou/commit/837d89a786d8b798eb44305ade70b8a17fd66c1d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.138.0
    * @okouai/core bumped to 8.887.5
    * @okouai/db bumped to 2.71.12
    * @okouai/pi-agent-runtime bumped to 1.52.100

## [2.138.7](https://github.com/okou-ai/okou/compare/api-v2.138.6...api-v2.138.7) (2026-11-27)


### Performance Improvements

* **api:** reuse selected bundle urls without speculative sql ([#51387](https://github.com/okou-ai/okou/issues/51387)) ([44115ce](https://github.com/okou-ai/okou/commit/44115ceb75ad719e92b10008748250d86b800a55))

## [2.138.6](https://github.com/okou-ai/okou/compare/api-v2.138.5...api-v2.138.6) (2026-11-27)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.137.3
    * @okouai/core bumped to 8.887.4
    * @okouai/db bumped to 2.71.11
    * @okouai/pi-agent-runtime bumped to 1.52.99

## [2.138.5](https://github.com/okou-ai/okou/compare/api-v2.138.4...api-v2.138.5) (2026-11-27)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.137.2
    * @okouai/core bumped to 8.887.3
    * @okouai/db bumped to 2.71.10
    * @okouai/pi-agent-runtime bumped to 1.52.98

## [2.138.4](https://github.com/okou-ai/okou/compare/api-v2.138.3...api-v2.138.4) (2026-11-27)


### Performance Improvements

* **api:** reuse built-in route pricing checks ([#51348](https://github.com/okou-ai/okou/issues/51348)) ([5536f8a](https://github.com/okou-ai/okou/commit/5536f8a75be7ac3284c8e1d865d7021b61e33508))
* **api:** trim startup model pricing ([#51347](https://github.com/okou-ai/okou/issues/51347)) ([e20c2e9](https://github.com/okou-ai/okou/commit/e20c2e9f59be38867b48dd4994824ad81eeb0f60))

## [2.138.3](https://github.com/okou-ai/okou/compare/api-v2.138.2...api-v2.138.3) (2026-11-27)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.137.1
    * @okouai/core bumped to 8.887.2
    * @okouai/db bumped to 2.71.9
    * @okouai/pi-agent-runtime bumped to 1.52.97

## [2.138.2](https://github.com/okou-ai/okou/compare/api-v2.138.1...api-v2.138.2) (2026-11-27)


### Refactoring

* **api:** retire legacy proactive workflow dispatch ([#51313](https://github.com/okou-ai/okou/issues/51313)) ([32982c1](https://github.com/okou-ai/okou/commit/32982c12436b34f6d1c99eb69f1f78aa0078a39b)) [#50929](https://github.com/okou-ai/okou/issues/50929)

## [2.138.1](https://github.com/okou-ai/okou/compare/api-v2.138.0...api-v2.138.1) (2026-11-27)


### Bug Fixes

* **host:** restore domain lists with stale verification ([#51296](https://github.com/okou-ai/okou/issues/51296)) ([41e0059](https://github.com/okou-ai/okou/commit/41e005959d8163494e35a0860048e70f42eace8c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.71.8

## [2.138.0](https://github.com/okou-ai/okou/compare/api-v2.137.3...api-v2.138.0) (2026-11-27)


### Features

* **artifacts:** add visual browsing to library ([#51115](https://github.com/okou-ai/okou/issues/51115)) ([d11e612](https://github.com/okou-ai/okou/commit/d11e6120de54a6d91addd74541361e0497d5ae0a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.137.0
    * @okouai/core bumped to 8.887.1
    * @okouai/db bumped to 2.71.7
    * @okouai/pi-agent-runtime bumped to 1.52.96

## [2.137.3](https://github.com/okou-ai/okou/compare/api-v2.137.2...api-v2.137.3) (2026-11-26)


### Bug Fixes

* **api:** generate chat titles from voice-only messages ([#51235](https://github.com/okou-ai/okou/issues/51235)) ([3380039](https://github.com/okou-ai/okou/commit/3380039d50092d5b9a69629f2d37f78c1ed812a3))


### Refactoring

* resolve message artifacts by url and navigate within their chat group ([#51081](https://github.com/okou-ai/okou/issues/51081)) ([fe23396](https://github.com/okou-ai/okou/commit/fe233968313c8ef91e51bd11ea6d75a4551ddf83))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.136.0
    * @okouai/core bumped to 8.887.0
    * @okouai/db bumped to 2.71.6
    * @okouai/pi-agent-runtime bumped to 1.52.95

## [2.137.2](https://github.com/okou-ai/okou/compare/api-v2.137.1...api-v2.137.2) (2026-11-26)


### Bug Fixes

* **api:** complete the proactive cutover from the minute cron ([#51207](https://github.com/okou-ai/okou/issues/51207)) ([3743211](https://github.com/okou-ai/okou/commit/37432116e7617cc1b185907d1669aa8600d7df1b))
* refresh linked gmail drafts during active runs ([#51188](https://github.com/okou-ai/okou/issues/51188)) ([75d38ca](https://github.com/okou-ai/okou/commit/75d38ca957eed0354634ddd0f96797fb58d8dc14))


### Refactoring

* **api:** remove hardcoded agentSuggestion feature switch ([#51200](https://github.com/okou-ai/okou/issues/51200)) ([9b08a6a](https://github.com/okou-ai/okou/commit/9b08a6ab106941ed505e626245c4e7e701fc0138))
* **runner:** retire legacy startup dispatch fields ([#51189](https://github.com/okou-ai/okou/issues/51189)) ([ae83fa7](https://github.com/okou-ai/okou/commit/ae83fa732618ccd8d0fa0d1bd3172c7c4c7ecd41))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.135.0
    * @okouai/core bumped to 8.886.1
    * @okouai/db bumped to 2.71.5
    * @okouai/pi-agent-runtime bumped to 1.52.94

## [2.137.1](https://github.com/okou-ai/okou/compare/api-v2.137.0...api-v2.137.1) (2026-11-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.886.0
    * @okouai/db bumped to 2.71.4
    * @okouai/pi-agent-runtime bumped to 1.52.93

## [2.137.0](https://github.com/okou-ai/okou/compare/api-v2.136.2...api-v2.137.0) (2026-11-26)


### Features

* prepare later feedback for suggestions ([#51159](https://github.com/okou-ai/okou/issues/51159)) ([938f9b2](https://github.com/okou-ai/okou/commit/938f9b2cc1c2c188316ed17f72ce06ec4edb42b8))


### Performance Improvements

* **api:** deduplicate desktop shell authorization notifications ([#51143](https://github.com/okou-ai/okou/issues/51143)) ([9a306f4](https://github.com/okou-ai/okou/commit/9a306f4e71c700f4eb61b12dea718e4ad5f6df9b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.134.0
    * @okouai/core bumped to 8.885.4
    * @okouai/db bumped to 2.71.3
    * @okouai/pi-agent-runtime bumped to 1.52.92

## [2.136.2](https://github.com/okou-ai/okou/compare/api-v2.136.1...api-v2.136.2) (2026-11-26)


### Refactoring

* **runner:** generate startup storage destinations ([#51106](https://github.com/okou-ai/okou/issues/51106)) ([88e458e](https://github.com/okou-ai/okou/commit/88e458e669546d4c263cdb2d6016355806bba59c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.133.1
    * @okouai/core bumped to 8.885.3
    * @okouai/db bumped to 2.71.2
    * @okouai/pi-agent-runtime bumped to 1.52.91

## [2.136.1](https://github.com/okou-ai/okou/compare/api-v2.136.0...api-v2.136.1) (2026-11-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.885.2
    * @okouai/db bumped to 2.71.1
    * @okouai/pi-agent-runtime bumped to 1.52.90

## [2.136.0](https://github.com/okou-ai/okou/compare/api-v2.135.0...api-v2.136.0) (2026-11-26)


### Features

* **api:** prepare schedules for the standalone proactive cron ([#51079](https://github.com/okou-ai/okou/issues/51079)) ([2b49ea5](https://github.com/okou-ai/okou/commit/2b49ea55c08205b79c036a97f26a2e0e38baf117))


### Refactoring

* remove slack artifact sharing feature switch ([#51083](https://github.com/okou-ai/okou/issues/51083)) ([50b7d05](https://github.com/okou-ai/okou/commit/50b7d05735afeaefa0cbcc86b33ffa8e4141922f))


### Performance Improvements

* **api:** deduplicate chat search projection around runner dispatch ([#51080](https://github.com/okou-ai/okou/issues/51080)) ([ade8eac](https://github.com/okou-ai/okou/commit/ade8eac256f73ca08fffe6135d19151666a2e02c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.133.0
    * @okouai/core bumped to 8.885.1
    * @okouai/db bumped to 2.71.0
    * @okouai/pi-agent-runtime bumped to 1.52.89

## [2.135.0](https://github.com/okou-ai/okou/compare/api-v2.134.1...api-v2.135.0) (2026-11-26)


### Features

* **ios:** authorize supported connectors through installed apps ([#50975](https://github.com/okou-ai/okou/issues/50975)) ([a105bd9](https://github.com/okou-ai/okou/commit/a105bd92a24247370daf3b932a7d20fc7ab61d87))


### Performance Improvements

* **api:** prefetch execution bundle URL cache with package sources ([#51056](https://github.com/okou-ai/okou/issues/51056)) ([897d1e1](https://github.com/okou-ai/okou/commit/897d1e187f337a39688bcaaa9fb32f412f5117fd))
* **api:** reuse the serialized body for preferred home dispatch ([#51063](https://github.com/okou-ai/okou/issues/51063)) ([52482b9](https://github.com/okou-ai/okou/commit/52482b9014d36c98db7783ead28326ce6d4806e8))
* **api:** trim run startup SQL results ([#51060](https://github.com/okou-ai/okou/issues/51060)) ([94374ba](https://github.com/okou-ai/okou/commit/94374ba48828673d96c89e7fe1d85691d411146a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.132.0
    * @okouai/connectors bumped to 3.26.0
    * @okouai/core bumped to 8.885.0
    * @okouai/db bumped to 2.70.2
    * @okouai/pi-agent-runtime bumped to 1.52.88

## [2.134.1](https://github.com/okou-ai/okou/compare/api-v2.134.0...api-v2.134.1) (2026-11-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.884.0
    * @okouai/db bumped to 2.70.1
    * @okouai/pi-agent-runtime bumped to 1.52.87

## [2.134.0](https://github.com/okou-ai/okou/compare/api-v2.133.1...api-v2.134.0) (2026-11-26)


### Features

* **api:** enforce live remote device access ([#50892](https://github.com/okou-ai/okou/issues/50892)) ([df3cad0](https://github.com/okou-ai/okou/commit/df3cad08ac5cc8cfbe7167341149e70ac39ba6d2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.131.0
    * @okouai/core bumped to 8.883.2
    * @okouai/db bumped to 2.70.0
    * @okouai/pi-agent-runtime bumped to 1.52.86

## [2.133.1](https://github.com/okou-ai/okou/compare/api-v2.133.0...api-v2.133.1) (2026-11-26)


### Bug Fixes

* **api:** bind phone use operations to the registration generation ([#50976](https://github.com/okou-ai/okou/issues/50976)) ([5180e1d](https://github.com/okou-ai/okou/commit/5180e1dcf8a16b958edeb7d721882ca22b1eb56c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.130.0
    * @okouai/core bumped to 8.883.1
    * @okouai/db bumped to 2.69.8
    * @okouai/pi-agent-runtime bumped to 1.52.85

## [2.133.0](https://github.com/okou-ai/okou/compare/api-v2.132.1...api-v2.133.0) (2026-11-26)


### Features

* **core:** enable artifact timing for everyone ([#50973](https://github.com/okou-ai/okou/issues/50973)) ([3d737bf](https://github.com/okou-ai/okou/commit/3d737bf1c93875478f6c5f70c6df2a106edbdf92))


### Bug Fixes

* **browser:** retain cli proxy shutdown diagnostics ([#50961](https://github.com/okou-ai/okou/issues/50961)) ([715a4e4](https://github.com/okou-ai/okou/commit/715a4e4a166d009ffadcbc6d466c261e69211273))


### Refactoring

* **api:** remove clerk lookups from vnc run authorization ([#50970](https://github.com/okou-ai/okou/issues/50970)) ([47da7c9](https://github.com/okou-ai/okou/commit/47da7c97682aa46f93f1acce4a5389a1ac9e0f7e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.883.0
    * @okouai/db bumped to 2.69.7
    * @okouai/pi-agent-runtime bumped to 1.52.84

## [2.132.1](https://github.com/okou-ai/okou/compare/api-v2.132.0...api-v2.132.1) (2026-11-26)


### Bug Fixes

* **connectors:** replace duplicate provider account authorizations ([#50784](https://github.com/okou-ai/okou/issues/50784)) ([c8f6d04](https://github.com/okou-ai/okou/commit/c8f6d04eec805cf2edb634af0fa48019ad82bd0d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.882.0
    * @okouai/db bumped to 2.69.6
    * @okouai/pi-agent-runtime bumped to 1.52.83

## [2.132.0](https://github.com/okou-ai/okou/compare/api-v2.131.0...api-v2.132.0) (2026-11-26)


### Features

* **api:** support third-party browser origins on mcp ([#50914](https://github.com/okou-ai/okou/issues/50914)) ([cf56730](https://github.com/okou-ai/okou/commit/cf56730747acaae3a4b96b0b5d89fe00d4daf7c6))


### Refactoring

* **api:** retire official workflow catalog and automation identities ([#50902](https://github.com/okou-ai/okou/issues/50902)) ([1edc731](https://github.com/okou-ai/okou/commit/1edc731cfb612688e2c648ce00f4fd7f1da98e45))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.129.1
    * @okouai/core bumped to 8.881.4
    * @okouai/db bumped to 2.69.5
    * @okouai/pi-agent-runtime bumped to 1.52.82

## [2.131.0](https://github.com/okou-ai/okou/compare/api-v2.130.3...api-v2.131.0) (2026-11-25)


### Features

* **api:** support device chat over mcp ([#50911](https://github.com/okou-ai/okou/issues/50911)) ([b455daa](https://github.com/okou-ai/okou/commit/b455daa4f5ce613d3d6981e479f246ac85695260))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.129.0
    * @okouai/core bumped to 8.881.3
    * @okouai/db bumped to 2.69.4
    * @okouai/pi-agent-runtime bumped to 1.52.81

## [2.130.3](https://github.com/okou-ai/okou/compare/api-v2.130.2...api-v2.130.3) (2026-11-25)


### Bug Fixes

* **api:** allow bearer-authenticated chat from the even g2 webview ([#50907](https://github.com/okou-ai/okou/issues/50907)) ([b7de833](https://github.com/okou-ai/okou/commit/b7de833561ce9337f2295a42b72c6dffe2b59bf4))
* transcribe voice messages before sending progress updates ([#50901](https://github.com/okou-ai/okou/issues/50901)) ([112ad56](https://github.com/okou-ai/okou/commit/112ad5653516635f981824195ecb1f6cb7f2024f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/pi-agent-runtime bumped to 1.52.80

## [2.130.2](https://github.com/okou-ai/okou/compare/api-v2.130.1...api-v2.130.2) (2026-11-25)


### Performance Improvements

* **app:** defer feed and recent workflow requests at startup ([#50893](https://github.com/okou-ai/okou/issues/50893)) ([48a1ed1](https://github.com/okou-ai/okou/commit/48a1ed18b82cb459328118d6790dc35f67e200cf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.128.4
    * @okouai/core bumped to 8.881.2
    * @okouai/db bumped to 2.69.3
    * @okouai/pi-agent-runtime bumped to 1.52.79

## [2.130.1](https://github.com/okou-ai/okou/compare/api-v2.130.0...api-v2.130.1) (2026-11-25)


### Refactoring

* **api:** pass built-in workflow instructions in automation run prompts ([#50895](https://github.com/okou-ai/okou/issues/50895)) ([587a0fa](https://github.com/okou-ai/okou/commit/587a0fac74e2eea912d1a73be5b46afb20faab68))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.128.3
    * @okouai/core bumped to 8.881.1
    * @okouai/db bumped to 2.69.2
    * @okouai/pi-agent-runtime bumped to 1.52.78

## [2.130.0](https://github.com/okou-ai/okou/compare/api-v2.129.0...api-v2.130.0) (2026-11-25)


### Features

* **connectors:** release linkedin oauth to all users ([#50870](https://github.com/okou-ai/okou/issues/50870)) ([8569b73](https://github.com/okou-ai/okou/commit/8569b736e2f89ae64986ca5a43a6b34a846d483d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.881.0
    * @okouai/db bumped to 2.69.1
    * @okouai/pi-agent-runtime bumped to 1.52.77

## [2.129.0](https://github.com/okou-ai/okou/compare/api-v2.128.1...api-v2.129.0) (2026-11-25)


### Features

* **db:** prepare member-owned remote device storage ([#50817](https://github.com/okou-ai/okou/issues/50817)) ([29caea0](https://github.com/okou-ai/okou/commit/29caea00aee82182dfa6015c76b534adeb708521))


### Bug Fixes

* **connectors:** prepare outgoing writers for account identity uniqueness ([#50794](https://github.com/okou-ai/okou/issues/50794)) ([7a53b18](https://github.com/okou-ai/okou/commit/7a53b184e46f7ad55585029d347b6824a9b40d39))
* refresh welcome artifact addresses ([#50849](https://github.com/okou-ai/okou/issues/50849)) ([0f5ca8c](https://github.com/okou-ai/okou/commit/0f5ca8ce9028f78dd046658a5765e0758d78e44a))


### Performance Improvements

* **api:** cache builtin connector execution metadata across runs ([#50859](https://github.com/okou-ai/okou/issues/50859)) ([c6d6ddc](https://github.com/okou-ai/okou/commit/c6d6ddc34dbd09b8cd334a9485b568161578ecee))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.128.2
    * @okouai/connectors bumped to 3.25.1
    * @okouai/core bumped to 8.880.0
    * @okouai/db bumped to 2.69.0
    * @okouai/pi-agent-runtime bumped to 1.52.76

## [2.128.1](https://github.com/okou-ai/okou/compare/api-v2.128.0...api-v2.128.1) (2026-11-25)


### Bug Fixes

* **host:** preserve owner previews of legacy public sites ([#50847](https://github.com/okou-ai/okou/issues/50847)) ([7efbeb2](https://github.com/okou-ai/okou/commit/7efbeb25b7bc21caafc2b6bb72a23a1a5bc944bd)) [#50841](https://github.com/okou-ai/okou/issues/50841)
* **ios:** return all connector oauth attempts to the app ([#50773](https://github.com/okou-ai/okou/issues/50773)) ([e683a88](https://github.com/okou-ai/okou/commit/e683a886bb389afe4671e7eca49a100d485137eb))


### Performance Improvements

* **api:** tune Runner dispatch keep-alive and send timings ([#50839](https://github.com/okou-ai/okou/issues/50839)) ([3afe539](https://github.com/okou-ai/okou/commit/3afe53917b9429a9fc549179d8f325020d923c4d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.128.1
    * @okouai/core bumped to 8.879.1
    * @okouai/db bumped to 2.68.4
    * @okouai/pi-agent-runtime bumped to 1.52.75

## [2.128.0](https://github.com/okou-ai/okou/compare/api-v2.127.0...api-v2.128.0) (2026-11-25)


### Features

* guide custom domain setup through verification and activation ([#50730](https://github.com/okou-ai/okou/issues/50730)) ([8846eae](https://github.com/okou-ai/okou/commit/8846eae8a6948dc3177e550be081b39857308062))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.128.0
    * @okouai/core bumped to 8.879.0
    * @okouai/db bumped to 2.68.3
    * @okouai/pi-agent-runtime bumped to 1.52.74

## [2.127.0](https://github.com/okou-ai/okou/compare/api-v2.126.0...api-v2.127.0) (2026-11-25)


### Features

* restart an unresponsive shared browser instance ([#50780](https://github.com/okou-ai/okou/issues/50780)) ([ce2d936](https://github.com/okou-ai/okou/commit/ce2d9360453d9fb4ca063d2a9c9cc2a71b35c4e9))


### Bug Fixes

* **api:** allow browser native input from Slack chat runs ([#50810](https://github.com/okou-ai/okou/issues/50810)) ([9ceca37](https://github.com/okou-ai/okou/commit/9ceca377e6ede591b274ba11fe1bf42245af133c))
* **billing:** unify feedback surveys and one-time rewards ([#50759](https://github.com/okou-ai/okou/issues/50759)) ([44c32b7](https://github.com/okou-ai/okou/commit/44c32b74189f160fe9d3035465970f9a512a5354))
* **ios:** try google connector universal links before browser authorization ([#50771](https://github.com/okou-ai/okou/issues/50771)) ([9b3c7f0](https://github.com/okou-ai/okou/commit/9b3c7f08e8a1669d118bf367000a4ec0012120c1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.127.0
    * @okouai/core bumped to 8.878.1
    * @okouai/db bumped to 2.68.2
    * @okouai/pi-agent-runtime bumped to 1.52.73

## [2.126.0](https://github.com/okou-ai/okou/compare/api-v2.125.0...api-v2.126.0) (2026-11-25)


### Features

* **api:** run official schedules only for recently active owners ([#50775](https://github.com/okou-ai/okou/issues/50775)) ([260dffe](https://github.com/okou-ai/okou/commit/260dffe5585f16f48c7dbd22f682e6ca1819c1a6))
* **connectors:** support linkedin publishing oauth ([#50774](https://github.com/okou-ai/okou/issues/50774)) ([c63a475](https://github.com/okou-ai/okou/commit/c63a475bf35f4f53a6fa2607576001e81ead0834))
* deliver opted-in mac app state to the assigned sandbox ([#50748](https://github.com/okou-ai/okou/issues/50748)) ([58beac7](https://github.com/okou-ai/okou/commit/58beac7e0900ba3f87616e7b6068715e2620a0fc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.126.1
    * @okouai/connectors bumped to 3.25.0
    * @okouai/core bumped to 8.878.0
    * @okouai/db bumped to 2.68.1
    * @okouai/pi-agent-runtime bumped to 1.52.72

## [2.125.0](https://github.com/okou-ai/okou/compare/api-v2.124.1...api-v2.125.0) (2026-11-25)


### Features

* **api:** enable suggestions for new accounts after onboarding ([#50749](https://github.com/okou-ai/okou/issues/50749)) ([9478076](https://github.com/okou-ai/okou/commit/9478076996f9e58fd3775f50e3bab7f0a815b187))
* receive computer use app state on the assigned runner ([#50745](https://github.com/okou-ai/okou/issues/50745)) ([9977243](https://github.com/okou-ai/okou/commit/99772436210306fef0b462d019a9fe57d118ff81))


### Bug Fixes

* **billing:** align feedback surveys and share one-time rewards ([#50566](https://github.com/okou-ai/okou/issues/50566)) ([ddf37fc](https://github.com/okou-ai/okou/commit/ddf37fc99d5ab9ee763a6299f597c56241c4224d))


### Refactoring

* graduate suggestions into the shared morning brief ([#50746](https://github.com/okou-ai/okou/issues/50746)) ([3a296b9](https://github.com/okou-ai/okou/commit/3a296b93fe3b031bfcf1cb30ce189841198b825f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.126.0
    * @okouai/core bumped to 8.877.0
    * @okouai/db bumped to 2.68.0
    * @okouai/pi-agent-runtime bumped to 1.52.71

## [2.124.1](https://github.com/okou-ai/okou/compare/api-v2.124.0...api-v2.124.1) (2026-11-25)


### Bug Fixes

* **api:** send invitation emails to all artifact recipients ([#50727](https://github.com/okou-ai/okou/issues/50727)) ([bb729d8](https://github.com/okou-ai/okou/commit/bb729d87d5a0753e9e7e144a7568357fc1c59fe8))

## [2.124.0](https://github.com/okou-ai/okou/compare/api-v2.123.1...api-v2.124.0) (2026-11-25)


### Features

* **cli:** add gated custom domain configuration ([#50696](https://github.com/okou-ai/okou/issues/50696)) ([6792328](https://github.com/okou-ai/okou/commit/679232832d580bf2b7545ed5ab99bb6ed4ce8159))
* roll out content-aware document output to everyone ([#50706](https://github.com/okou-ai/okou/issues/50706)) ([d7d26cd](https://github.com/okou-ai/okou/commit/d7d26cd3922157848f7adf6d631a2c02f3d3a8fb))


### Bug Fixes

* **api:** read flattened openrouter network log fields ([#50714](https://github.com/okou-ai/okou/issues/50714)) ([baaa4d4](https://github.com/okou-ai/okou/commit/baaa4d46ace3f662278e4e5c8e237a17d29ba5b4))


### Refactoring

* remove workflow recency sync feature switch ([#50708](https://github.com/okou-ai/okou/issues/50708)) ([edc8bb9](https://github.com/okou-ai/okou/commit/edc8bb96bba57f6e4390bfa3a8905924d1b4b88f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.876.0
    * @okouai/db bumped to 2.67.4
    * @okouai/pi-agent-runtime bumped to 1.52.70

## [2.123.1](https://github.com/okou-ai/okou/compare/api-v2.123.0...api-v2.123.1) (2026-11-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.875.0
    * @okouai/db bumped to 2.67.3
    * @okouai/pi-agent-runtime bumped to 1.52.69

## [2.123.0](https://github.com/okou-ai/okou/compare/api-v2.122.0...api-v2.123.0) (2026-11-24)


### Features

* **connectors:** enable app store connect signing and google play oauth ([#50644](https://github.com/okou-ai/okou/issues/50644)) ([81d115b](https://github.com/okou-ai/okou/commit/81d115b8e1d4d25ff40bfee210859bbd12547927))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.125.0
    * @okouai/connectors bumped to 3.24.0
    * @okouai/core bumped to 8.874.0
    * @okouai/db bumped to 2.67.2
    * @okouai/pi-agent-runtime bumped to 1.52.68

## [2.122.0](https://github.com/okou-ai/okou/compare/api-v2.121.0...api-v2.122.0) (2026-11-24)


### Features

* add first-use presentation format setup ([#50150](https://github.com/okou-ai/okou/issues/50150)) ([0e802ee](https://github.com/okou-ai/okou/commit/0e802ee6b10be62579cc7a5e40f3fc21182a0b15))
* enable member connector account access for staff ([#50629](https://github.com/okou-ai/okou/issues/50629)) ([d824b76](https://github.com/okou-ai/okou/commit/d824b7647e34b77f0bfb0f6d86049a62d8b5f1d0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.873.0
    * @okouai/db bumped to 2.67.1
    * @okouai/pi-agent-runtime bumped to 1.52.67

## [2.121.0](https://github.com/okou-ai/okou/compare/api-v2.120.0...api-v2.121.0) (2026-11-24)


### Features

* add subscription-gated custom domains for hosted sites ([#50462](https://github.com/okou-ai/okou/issues/50462)) ([a898459](https://github.com/okou-ai/okou/commit/a8984599f91d9596a3721b0c6d8fa67274c9f985))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.124.0
    * @okouai/core bumped to 8.872.0
    * @okouai/db bumped to 2.67.0
    * @okouai/pi-agent-runtime bumped to 1.52.66

## [2.120.0](https://github.com/okou-ai/okou/compare/api-v2.119.1...api-v2.120.0) (2026-11-24)


### Features

* bind internal antigravity sign-in to member profiles ([#50523](https://github.com/okou-ai/okou/issues/50523)) ([ab93ff8](https://github.com/okou-ai/okou/commit/ab93ff8c008746117d5d90211f58425c1f6a0ae8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.123.0
    * @okouai/core bumped to 8.871.0
    * @okouai/db bumped to 2.66.0
    * @okouai/pi-agent-runtime bumped to 1.52.65

## [2.119.1](https://github.com/okou-ai/okou/compare/api-v2.119.0...api-v2.119.1) (2026-11-24)


### Performance Improvements

* **api:** trim pending run commit result ([#50572](https://github.com/okou-ai/okou/issues/50572)) ([0bec3de](https://github.com/okou-ai/okou/commit/0bec3de9e9af11512cc04261b844bb2ff365859f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.122.0
    * @okouai/core bumped to 8.870.2
    * @okouai/db bumped to 2.65.1
    * @okouai/pi-agent-runtime bumped to 1.52.64

## [2.119.0](https://github.com/okou-ai/okou/compare/api-v2.118.0...api-v2.119.0) (2026-11-24)


### Features

* add member-wide connector account approval ([#50516](https://github.com/okou-ai/okou/issues/50516)) ([ff76d52](https://github.com/okou-ai/okou/commit/ff76d52e21a55cd8f3e34a513e7e5fcfd8ab1e1b))
* **billing:** allow free workspaces to buy credits ([#50532](https://github.com/okou-ai/okou/issues/50532)) ([f79cdfd](https://github.com/okou-ai/okou/commit/f79cdfde1673397bf7716c1411dd68e8c3020875))


### Bug Fixes

* **ios:** discard drafts for unavailable chats ([#50503](https://github.com/okou-ai/okou/issues/50503)) ([4aeac42](https://github.com/okou-ai/okou/commit/4aeac42344c6a9c6a81bbb472d509e04548d8c1d))


### Performance Improvements

* **api:** remove redundant connector policy preparation ([#50537](https://github.com/okou-ai/okou/issues/50537)) ([519bc1a](https://github.com/okou-ai/okou/commit/519bc1a711128be1116ecd351babf60f86c15ccc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.121.0
    * @okouai/core bumped to 8.870.1
    * @okouai/db bumped to 2.65.0
    * @okouai/pi-agent-runtime bumped to 1.52.63

## [2.118.0](https://github.com/okou-ai/okou/compare/api-v2.117.1...api-v2.118.0) (2026-11-24)


### Features

* **android:** add built-in tool settings ([#50488](https://github.com/okou-ai/okou/issues/50488)) ([728e8ce](https://github.com/okou-ai/okou/commit/728e8ce2a260f26018932353d8c973a552fd6cf7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.120.0
    * @okouai/core bumped to 8.870.0
    * @okouai/db bumped to 2.64.2
    * @okouai/pi-agent-runtime bumped to 1.52.62

## [2.117.1](https://github.com/okou-ai/okou/compare/api-v2.117.0...api-v2.117.1) (2026-11-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.119.0
    * @okouai/core bumped to 8.869.1
    * @okouai/db bumped to 2.64.1
    * @okouai/pi-agent-runtime bumped to 1.52.61

## [2.117.0](https://github.com/okou-ai/okou/compare/api-v2.116.0...api-v2.117.0) (2026-11-24)


### Features

* migrate billing feedback to posthog surveys ([#50412](https://github.com/okou-ai/okou/issues/50412)) ([b3c517c](https://github.com/okou-ai/okou/commit/b3c517cd416a26bda272000095c0aa1deafc332e))
* use saved presentation format for generation ([#50260](https://github.com/okou-ai/okou/issues/50260)) ([ad98aaa](https://github.com/okou-ai/okou/commit/ad98aaa608c934f8eac3325ab079b3ee8fc50dd1))


### Refactoring

* **api:** remove staff cutover queue readers ([#49991](https://github.com/okou-ai/okou/issues/49991)) ([3dafb67](https://github.com/okou-ai/okou/commit/3dafb6732b554774fe4673642fc943b3874e1207)) [#46783](https://github.com/okou-ai/okou/issues/46783)


### Performance Improvements

* **api:** overlap runner preparation with pending run commit ([#50459](https://github.com/okou-ai/okou/issues/50459)) ([c04f4bf](https://github.com/okou-ai/okou/commit/c04f4bf68d67381de52923c013d8e0cb500d6068))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.118.0
    * @okouai/core bumped to 8.869.0
    * @okouai/db bumped to 2.64.0
    * @okouai/pi-agent-runtime bumped to 1.52.60

## [2.116.0](https://github.com/okou-ai/okou/compare/api-v2.115.0...api-v2.116.0) (2026-11-24)


### Features

* **runner:** log managed openrouter routing metadata ([#50392](https://github.com/okou-ai/okou/issues/50392)) ([637a49c](https://github.com/okou-ai/okou/commit/637a49cc6646031aa023c8a631863e88be17ee5d))


### Refactoring

* remove artifact name sorting ([#50428](https://github.com/okou-ai/okou/issues/50428)) ([b693ca5](https://github.com/okou-ai/okou/commit/b693ca5a66bab74587596b3971fdc5163f47f352))


### Performance Improvements

* **api:** lower runner dispatch gzip threshold to 160 kib ([#50413](https://github.com/okou-ai/okou/issues/50413)) ([74fc1b7](https://github.com/okou-ai/okou/commit/74fc1b78c227e8a8f05d9d6de3f92986030a5bce))
* **api:** narrow memory startup projections ([#50437](https://github.com/okou-ai/okou/issues/50437)) ([805f349](https://github.com/okou-ai/okou/commit/805f349ee7f455eac7466e1bb7d8a4b93ab0e8e0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.117.0
    * @okouai/core bumped to 8.868.1
    * @okouai/db bumped to 2.63.6
    * @okouai/pi-agent-runtime bumped to 1.52.59

## [2.115.0](https://github.com/okou-ai/okou/compare/api-v2.114.1...api-v2.115.0) (2026-11-24)


### Features

* **ios:** add connector management and align chat account controls ([#50371](https://github.com/okou-ai/okou/issues/50371)) ([b6afd7e](https://github.com/okou-ai/okou/commit/b6afd7e2be27cb0356358062dc7bb813200d18f9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.116.0
    * @okouai/core bumped to 8.868.0
    * @okouai/db bumped to 2.63.5
    * @okouai/pi-agent-runtime bumped to 1.52.58

## [2.114.1](https://github.com/okou-ai/okou/compare/api-v2.114.0...api-v2.114.1) (2026-11-24)


### Bug Fixes

* **app:** remove standalone template picker ([#50365](https://github.com/okou-ai/okou/issues/50365)) ([6a20b9e](https://github.com/okou-ai/okou/commit/6a20b9e686f663c0f71403cf4d52c6d77820e7a6))


### Performance Improvements

* **api:** narrow queue head and memory projections ([#50372](https://github.com/okou-ai/okou/issues/50372)) ([abd2454](https://github.com/okou-ai/okou/commit/abd24544982dc355b67bac959f1f640af7d47523))
* **api:** prefetch chat follow-ups and batch template sources ([#50375](https://github.com/okou-ai/okou/issues/50375)) ([e91f433](https://github.com/okou-ai/okou/commit/e91f433d6b14dfc6acbb04469b6cf47a93e10556))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.867.1
    * @okouai/db bumped to 2.63.4
    * @okouai/pi-agent-runtime bumped to 1.52.57

## [2.114.0](https://github.com/okou-ai/okou/compare/api-v2.113.0...api-v2.114.0) (2026-11-24)


### Features

* **artifacts:** add a gated searchable artifact library list ([#50231](https://github.com/okou-ai/okou/issues/50231)) ([2bb0a85](https://github.com/okou-ai/okou/commit/2bb0a8587efb1fc8abc513dba5c50109406226ed))
* scope composer voice recordings to the organization ([#50373](https://github.com/okou-ai/okou/issues/50373)) ([4e0340a](https://github.com/okou-ai/okou/commit/4e0340a5ffea0390e87b43e77fefdd217abc1cbd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.115.0
    * @okouai/core bumped to 8.867.0
    * @okouai/db bumped to 2.63.3
    * @okouai/pi-agent-runtime bumped to 1.52.56

## [2.113.0](https://github.com/okou-ai/okou/compare/api-v2.112.1...api-v2.113.0) (2026-11-24)


### Features

* add recording chips to chat composers behind a switch ([#50334](https://github.com/okou-ai/okou/issues/50334)) ([7fa55b1](https://github.com/okou-ai/okou/commit/7fa55b15b8286465939af85fe2faeaa1d39a952e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.114.0
    * @okouai/core bumped to 8.866.0
    * @okouai/db bumped to 2.63.2
    * @okouai/pi-agent-runtime bumped to 1.52.55

## [2.112.1](https://github.com/okou-ai/okou/compare/api-v2.112.0...api-v2.112.1) (2026-11-24)


### Refactoring

* remove voice messages feature switch ([#50338](https://github.com/okou-ai/okou/issues/50338)) ([35e38a9](https://github.com/okou-ai/okou/commit/35e38a9a333962f7477ff090634b8c38b723f55c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.865.1
    * @okouai/db bumped to 2.63.1
    * @okouai/pi-agent-runtime bumped to 1.52.54

## [2.112.0](https://github.com/okou-ai/okou/compare/api-v2.111.1...api-v2.112.0) (2026-11-23)


### Features

* archive projects in the chat sidebar ([#50306](https://github.com/okou-ai/okou/issues/50306)) ([8c9f004](https://github.com/okou-ai/okou/commit/8c9f004ac760d95f3f47e8e3fa83d470f2de28c6))


### Bug Fixes

* **api:** read subscription oauth client ids from doppler ([#50330](https://github.com/okou-ai/okou/issues/50330)) ([916d81b](https://github.com/okou-ai/okou/commit/916d81b3cb93a6fb0d03dc90ef05b2631fe6a523))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.113.0
    * @okouai/connectors bumped to 3.23.3
    * @okouai/core bumped to 8.865.0
    * @okouai/db bumped to 2.63.0
    * @okouai/pi-agent-runtime bumped to 1.52.53

## [2.111.1](https://github.com/okou-ai/okou/compare/api-v2.111.0...api-v2.111.1) (2026-11-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.864.1
    * @okouai/db bumped to 2.62.1
    * @okouai/pi-agent-runtime bumped to 1.52.52

## [2.111.0](https://github.com/okou-ai/okou/compare/api-v2.110.0...api-v2.111.0) (2026-11-23)


### Features

* **workflows:** sync recent usage across devices ([#50189](https://github.com/okou-ai/okou/issues/50189)) ([6f67414](https://github.com/okou-ai/okou/commit/6f674143c8776b90c2fbc6410baebbfc02eb4443))


### Refactoring

* **api:** remove obsolete agent webhook and telemetry routes ([#50195](https://github.com/okou-ai/okou/issues/50195)) ([2e9ac02](https://github.com/okou-ai/okou/commit/2e9ac02642d6365caa2e1c3da02fe3b15dfa58c1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.112.0
    * @okouai/core bumped to 8.864.0
    * @okouai/db bumped to 2.62.0
    * @okouai/pi-agent-runtime bumped to 1.52.51

## [2.110.0](https://github.com/okou-ai/okou/compare/api-v2.109.0...api-v2.110.0) (2026-11-23)


### Features

* persist presentation output format preference ([#50220](https://github.com/okou-ai/okou/issues/50220)) ([c68256f](https://github.com/okou-ai/okou/commit/c68256fc724a9baf19e9c099443be1a2d86b513e))


### Bug Fixes

* **api:** repair stale calendar and notion listener accounts ([#50218](https://github.com/okou-ai/okou/issues/50218)) ([fe10a84](https://github.com/okou-ai/okou/commit/fe10a84819276c22396cee7a1de7e31cc3385eb7))


### Performance Improvements

* **api:** narrow run startup sql projections ([#50236](https://github.com/okou-ai/okou/issues/50236)) ([42d9ddf](https://github.com/okou-ai/okou/commit/42d9ddf056b6df7bc9d7112e7f95b6034be2cb74))
* **api:** narrow startup model and plan projections ([#50268](https://github.com/okou-ai/okou/issues/50268)) ([e1d3482](https://github.com/okou-ai/okou/commit/e1d34828328c22ee31c106d806d7b987fb85ed4f))
* **api:** skip redundant incomplete chat history reads ([#50265](https://github.com/okou-ai/okou/issues/50265)) ([70488be](https://github.com/okou-ai/okou/commit/70488bef11ccc03ceb0251cd895fc9a3878f69a7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.111.0
    * @okouai/core bumped to 8.863.0
    * @okouai/db bumped to 2.61.0
    * @okouai/pi-agent-runtime bumped to 1.52.50

## [2.109.0](https://github.com/okou-ai/okou/compare/api-v2.108.0...api-v2.109.0) (2026-11-23)


### Features

* **ios:** authorize strava through the installed app ([#50179](https://github.com/okou-ai/okou/issues/50179)) ([f98f068](https://github.com/okou-ai/okou/commit/f98f068841b3ff663dcf250beec2267eb5122f66))


### Performance Improvements

* **api:** advance captured run launch preparation ([#50219](https://github.com/okou-ai/okou/issues/50219)) ([54b522f](https://github.com/okou-ai/okou/commit/54b522f197475f6089cda41f179eaa29d16b234f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.110.0
    * @okouai/core bumped to 8.862.1
    * @okouai/db bumped to 2.60.1
    * @okouai/pi-agent-runtime bumped to 1.52.49

## [2.108.0](https://github.com/okou-ai/okou/compare/api-v2.107.0...api-v2.108.0) (2026-11-23)


### Features

* share hosted websites with accounts and email invitations ([#50054](https://github.com/okou-ai/okou/issues/50054)) ([124f0fd](https://github.com/okou-ai/okou/commit/124f0fdba68d55c83ac0723181cc6d0a3041afec))


### Performance Improvements

* **api:** gzip large runner dispatch bodies ([#50184](https://github.com/okou-ai/okou/issues/50184)) ([df24b62](https://github.com/okou-ai/okou/commit/df24b62fb3ef693aa8f3372624d4138477b93e40))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.109.0
    * @okouai/core bumped to 8.862.0
    * @okouai/db bumped to 2.60.0
    * @okouai/pi-agent-runtime bumped to 1.52.48

## [2.107.0](https://github.com/okou-ai/okou/compare/api-v2.106.0...api-v2.107.0) (2026-11-23)


### Features

* **app:** track suggestion card impressions and outcomes ([#50158](https://github.com/okou-ai/okou/issues/50158)) ([d1cb596](https://github.com/okou-ai/okou/commit/d1cb596036a9079ecd0eb85072610dce8d44f5fb))


### Performance Improvements

* **api:** prepare run launch resources before admission ([#50174](https://github.com/okou-ai/okou/issues/50174)) ([288d064](https://github.com/okou-ai/okou/commit/288d0649dda1e7cf22a90cb61944018da3596875))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.108.0
    * @okouai/core bumped to 8.861.1
    * @okouai/db bumped to 2.59.0
    * @okouai/pi-agent-runtime bumped to 1.52.47

## [2.106.0](https://github.com/okou-ai/okou/compare/api-v2.105.1...api-v2.106.0) (2026-11-23)


### Features

* **core:** expand artifact timing to staff workspaces ([#50130](https://github.com/okou-ai/okou/issues/50130)) ([c1660c4](https://github.com/okou-ai/okou/commit/c1660c425117954b973d5439ccee5f866079787b))
* **ios:** add the native for you deck ([#50086](https://github.com/okou-ai/okou/issues/50086)) ([8ff411e](https://github.com/okou-ai/okou/commit/8ff411ea4757a12255c04401bcceb0b47246fd35))
* **runner:** accept gzip direct dispatch bodies ([#50128](https://github.com/okou-ai/okou/issues/50128)) ([dcb3ce1](https://github.com/okou-ai/okou/commit/dcb3ce10bce5c4d9e8f7c27586b5ccb876fcf290))


### Performance Improvements

* **api:** consolidate suggestion validation and prefetch send checks ([#50131](https://github.com/okou-ai/okou/issues/50131)) ([5a0dc63](https://github.com/okou-ai/okou/commit/5a0dc6316ac1457cc1ee8220800ec3977dc0dec8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.107.0
    * @okouai/core bumped to 8.861.0
    * @okouai/db bumped to 2.58.17
    * @okouai/pi-agent-runtime bumped to 1.52.46

## [2.105.1](https://github.com/okou-ai/okou/compare/api-v2.105.0...api-v2.105.1) (2026-11-23)


### Performance Improvements

* **api:** consolidate chat startup reads and advance package prefetch ([#50114](https://github.com/okou-ai/okou/issues/50114)) ([b275885](https://github.com/okou-ai/okou/commit/b2758859687e179dd43b826e46afa361611cdb73))
* **runner:** prewarm committed memory archives ([#50072](https://github.com/okou-ai/okou/issues/50072)) ([9c7ce5a](https://github.com/okou-ai/okou/commit/9c7ce5ab35704edc606231b1976ab826fa8e4df3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.106.1
    * @okouai/core bumped to 8.860.4
    * @okouai/db bumped to 2.58.16
    * @okouai/pi-agent-runtime bumped to 1.52.45

## [2.105.0](https://github.com/okou-ai/okou/compare/api-v2.104.5...api-v2.105.0) (2026-11-23)


### Features

* **android:** show confirmed workflow run history ([#50055](https://github.com/okou-ai/okou/issues/50055)) ([a3c5ba1](https://github.com/okou-ai/okou/commit/a3c5ba1c7418d75fa58233da2de637380ed1814b))
* **api:** separate app store and testflight minimum versions ([#50101](https://github.com/okou-ai/okou/issues/50101)) ([fe33370](https://github.com/okou-ai/okou/commit/fe333701c6a92676741d61982e3aeadd99fd0f85))


### Performance Improvements

* **api:** overlap memory and network policy preparation ([#50090](https://github.com/okou-ai/okou/issues/50090)) ([717a564](https://github.com/okou-ai/okou/commit/717a564f4d61fb25b7bdbdf2876b6d158189a6b3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.106.0
    * @okouai/core bumped to 8.860.3
    * @okouai/db bumped to 2.58.15
    * @okouai/pi-agent-runtime bumped to 1.52.44

## [2.104.5](https://github.com/okou-ai/okou/compare/api-v2.104.4...api-v2.104.5) (2026-11-23)


### Bug Fixes

* **api:** preserve drive scope recovery in conversion preflight ([#50079](https://github.com/okou-ai/okou/issues/50079)) ([495d69d](https://github.com/okou-ai/okou/commit/495d69dcf11f2db2bec4624ac71938d000a45f4b))


### Refactoring

* **api:** retire single-agent flags and migrate mitm callbacks ([#50073](https://github.com/okou-ai/okou/issues/50073)) ([b755712](https://github.com/okou-ai/okou/commit/b7557125818de8883c22704c19728207f5308428))


### Performance Improvements

* **runner:** measure dispatch body frame latency ([#50088](https://github.com/okou-ai/okou/issues/50088)) ([33b2a66](https://github.com/okou-ai/okou/commit/33b2a66c0f79129a3fe8e9940672014f3b2f826a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.105.2
    * @okouai/core bumped to 8.860.2
    * @okouai/db bumped to 2.58.14
    * @okouai/pi-agent-runtime bumped to 1.52.43

## [2.104.4](https://github.com/okou-ai/okou/compare/api-v2.104.3...api-v2.104.4) (2026-11-23)


### Bug Fixes

* persist for you cover preferences in the database ([#50069](https://github.com/okou-ai/okou/issues/50069)) ([c912fc4](https://github.com/okou-ai/okou/commit/c912fc4a238d3558ab6053520a1a63caf02f0ed5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.105.1
    * @okouai/core bumped to 8.860.1
    * @okouai/db bumped to 2.58.13
    * @okouai/pi-agent-runtime bumped to 1.52.42

## [2.104.3](https://github.com/okou-ai/okou/compare/api-v2.104.2...api-v2.104.3) (2026-11-23)


### Bug Fixes

* **billing:** retire canceled legacy plan conversions ([#49529](https://github.com/okou-ai/okou/issues/49529)) ([0a7f08d](https://github.com/okou-ai/okou/commit/0a7f08d090e9d8e407418f2f7da465288b0fb895)) [#49527](https://github.com/okou-ai/okou/issues/49527)


### Refactoring

* **api:** read custom connector skills from their owning rows ([#50060](https://github.com/okou-ai/okou/issues/50060)) ([6f0ea3d](https://github.com/okou-ai/okou/commit/6f0ea3d5f562bff447cfc7f0093fb44ea7acaaff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.860.0
    * @okouai/db bumped to 2.58.12
    * @okouai/pi-agent-runtime bumped to 1.52.41

## [2.104.2](https://github.com/okou-ai/okou/compare/api-v2.104.1...api-v2.104.2) (2026-11-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.105.0
    * @okouai/core bumped to 8.859.10
    * @okouai/db bumped to 2.58.11
    * @okouai/pi-agent-runtime bumped to 1.52.40

## [2.104.1](https://github.com/okou-ai/okou/compare/api-v2.104.0...api-v2.104.1) (2026-11-22)


### Refactoring

* migrate run telemetry and runner callbacks ([#50027](https://github.com/okou-ai/okou/issues/50027)) ([08dc352](https://github.com/okou-ai/okou/commit/08dc352da3fda206528eaddfef6bb60efcf68db6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.104.1
    * @okouai/core bumped to 8.859.9
    * @okouai/db bumped to 2.58.10
    * @okouai/pi-agent-runtime bumped to 1.52.39

## [2.104.0](https://github.com/okou-ai/okou/compare/api-v2.103.7...api-v2.104.0) (2026-11-22)


### Features

* **api:** authorize private voice clip playback for zero ([#50024](https://github.com/okou-ai/okou/issues/50024)) ([de960f7](https://github.com/okou-ai/okou/commit/de960f7eba38bd0f32afe65e2555cdae338388df))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.104.0
    * @okouai/core bumped to 8.859.8
    * @okouai/db bumped to 2.58.9
    * @okouai/pi-agent-runtime bumped to 1.52.38

## [2.103.7](https://github.com/okou-ai/okou/compare/api-v2.103.6...api-v2.103.7) (2026-11-22)


### Bug Fixes

* **api:** frame voice clips as the user message ([#50020](https://github.com/okou-ai/okou/issues/50020)) ([925a41c](https://github.com/okou-ai/okou/commit/925a41cd3cfe24df9bc3401324450839690b1e47))


### Refactoring

* **api:** use run capabilities for personal resources ([#50021](https://github.com/okou-ai/okou/issues/50021)) ([e870be5](https://github.com/okou-ai/okou/commit/e870be51a01a822242d29089113bfc3e059b8a8f))
* move rust run callbacks to run webhook paths ([#50022](https://github.com/okou-ai/okou/issues/50022)) ([ea009d1](https://github.com/okou-ai/okou/commit/ea009d1a44ab6b2a7164f03033a47a043ed09355))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.103.1
    * @okouai/core bumped to 8.859.7
    * @okouai/db bumped to 2.58.8
    * @okouai/pi-agent-runtime bumped to 1.52.37

## [2.103.6](https://github.com/okou-ai/okou/compare/api-v2.103.5...api-v2.103.6) (2026-11-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.58.7

## [2.103.5](https://github.com/okou-ai/okou/compare/api-v2.103.4...api-v2.103.5) (2026-11-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.103.0
    * @okouai/core bumped to 8.859.6
    * @okouai/db bumped to 2.58.6
    * @okouai/pi-agent-runtime bumped to 1.52.36

## [2.103.4](https://github.com/okou-ai/okou/compare/api-v2.103.3...api-v2.103.4) (2026-11-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.102.0
    * @okouai/core bumped to 8.859.5
    * @okouai/db bumped to 2.58.5
    * @okouai/pi-agent-runtime bumped to 1.52.35

## [2.103.3](https://github.com/okou-ai/okou/compare/api-v2.103.2...api-v2.103.3) (2026-11-22)


### Refactoring

* **db:** retire the legacy storage registry ([#49953](https://github.com/okou-ai/okou/issues/49953)) ([5771504](https://github.com/okou-ai/okou/commit/5771504eb487a9246a1b986a77cedc143e12d99d))
* retire product agent apis and use member identity across clients ([#49933](https://github.com/okou-ai/okou/issues/49933)) ([1d34e53](https://github.com/okou-ai/okou/commit/1d34e531ac4c777d6df6236fa871ce6c834f5380))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.101.1
    * @okouai/core bumped to 8.859.4
    * @okouai/db bumped to 2.58.4
    * @okouai/pi-agent-runtime bumped to 1.52.34

## [2.103.2](https://github.com/okou-ai/okou/compare/api-v2.103.1...api-v2.103.2) (2026-11-22)


### Performance Improvements

* **api:** short-circuit history reads for completed predecessors ([#49934](https://github.com/okou-ai/okou/issues/49934)) ([68423cd](https://github.com/okou-ai/okou/commit/68423cd7e4d8507731245b5811b9e9133c46e995))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.101.0
    * @okouai/core bumped to 8.859.3
    * @okouai/db bumped to 2.58.3
    * @okouai/pi-agent-runtime bumped to 1.52.33

## [2.103.1](https://github.com/okou-ai/okou/compare/api-v2.103.0...api-v2.103.1) (2026-11-22)


### Refactoring

* **app:** retire agent prerequisites from member flows ([#49854](https://github.com/okou-ai/okou/issues/49854)) ([6eea61b](https://github.com/okou-ai/okou/commit/6eea61b4a4f5c7a3e218bb027b148f10c3d4dab7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.100.1
    * @okouai/core bumped to 8.859.2
    * @okouai/db bumped to 2.58.2
    * @okouai/pi-agent-runtime bumped to 1.52.32

## [2.103.0](https://github.com/okou-ai/okou/compare/api-v2.102.0...api-v2.103.0) (2026-11-22)


### Features

* **android:** add the workspace artifacts page ([#49864](https://github.com/okou-ai/okou/issues/49864)) ([f0babd9](https://github.com/okou-ai/okou/commit/f0babd9a5b1d68fef595bc35d6944d3859e593f2))
* **api:** accept device OAuth for private voice uploads ([#49908](https://github.com/okou-ai/okou/issues/49908)) ([a5b394d](https://github.com/okou-ai/okou/commit/a5b394d5308926d9cd9b03e0b6e8a21c9e010a53))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.100.0
    * @okouai/core bumped to 8.859.1
    * @okouai/db bumped to 2.58.1
    * @okouai/pi-agent-runtime bumped to 1.52.31

## [2.102.0](https://github.com/okou-ai/okou/compare/api-v2.101.2...api-v2.102.0) (2026-11-22)


### Features

* transcribe ordered voice messages with model credits ([#49901](https://github.com/okou-ai/okou/issues/49901)) ([10fb53e](https://github.com/okou-ai/okou/commit/10fb53e67b9ae25cd3bcb984e8dca394e5682a94))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.99.0
    * @okouai/core bumped to 8.859.0
    * @okouai/db bumped to 2.58.0
    * @okouai/pi-agent-runtime bumped to 1.52.30

## [2.101.2](https://github.com/okou-ai/okou/compare/api-v2.101.1...api-v2.101.2) (2026-11-22)


### Refactoring

* remove workflow and workspace default agent references ([#49886](https://github.com/okou-ai/okou/issues/49886)) ([53b3b5e](https://github.com/okou-ai/okou/commit/53b3b5ea7efb21dc4d0d7802346fa5cbbf08c443))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.98.5
    * @okouai/core bumped to 8.858.10
    * @okouai/db bumped to 2.57.11
    * @okouai/pi-agent-runtime bumped to 1.52.29

## [2.101.1](https://github.com/okou-ai/okou/compare/api-v2.101.0...api-v2.101.1) (2026-11-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.98.4
    * @okouai/core bumped to 8.858.9
    * @okouai/db bumped to 2.57.10
    * @okouai/pi-agent-runtime bumped to 1.52.28

## [2.101.0](https://github.com/okou-ai/okou/compare/api-v2.100.9...api-v2.101.0) (2026-11-21)


### Features

* **api:** force app.okou.ai clients to upgrade to v0.1162.3 ([#49883](https://github.com/okou-ai/okou/issues/49883)) ([28d20b2](https://github.com/okou-ai/okou/commit/28d20b2ff00e817cb96b938189395c02265f3642))

## [2.100.9](https://github.com/okou-ai/okou/compare/api-v2.100.8...api-v2.100.9) (2026-11-21)


### Bug Fixes

* **api:** allow chat creation with native OAuth ([#49875](https://github.com/okou-ai/okou/issues/49875)) ([4a34883](https://github.com/okou-ai/okou/commit/4a3488355b00872e24f684df8a1c1c0506e78b6c))


### Refactoring

* contract legacy chat and run agent storage ([#49868](https://github.com/okou-ai/okou/issues/49868)) ([abbf9f8](https://github.com/okou-ai/okou/commit/abbf9f8e672ac56f0f98583cfb0b536e9225e905))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.98.3
    * @okouai/core bumped to 8.858.8
    * @okouai/db bumped to 2.57.9
    * @okouai/pi-agent-runtime bumped to 1.52.27

## [2.100.8](https://github.com/okou-ai/okou/compare/api-v2.100.7...api-v2.100.8) (2026-11-21)


### Refactoring

* **app:** retire legacy agent management and chat action ids ([#49838](https://github.com/okou-ai/okou/issues/49838)) ([c83928a](https://github.com/okou-ai/okou/commit/c83928ad6fc787a648fa6f2a71fbf5d98b3001cc))
* stage retirement of chat and run agent identity ([#49839](https://github.com/okou-ai/okou/issues/49839)) ([01b34f9](https://github.com/okou-ai/okou/commit/01b34f9b9f1a7f7b117739ad834931fa646a1b8b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.98.2
    * @okouai/core bumped to 8.858.7
    * @okouai/db bumped to 2.57.8
    * @okouai/pi-agent-runtime bumped to 1.52.26

## [2.100.7](https://github.com/okou-ai/okou/compare/api-v2.100.6...api-v2.100.7) (2026-11-21)


### Bug Fixes

* **cli:** remove legacy agent ids from cli requests ([#49830](https://github.com/okou-ai/okou/issues/49830)) ([fad4dc9](https://github.com/okou-ai/okou/commit/fad4dc9a841aac86dcdaf62f17d07ff200c287e3))
* return 404 for unconfigured get started rewards ([#49832](https://github.com/okou-ai/okou/issues/49832)) ([b8b046f](https://github.com/okou-ai/okou/commit/b8b046f5daf43e740a8ed051e59ca7738ed327ad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.98.1
    * @okouai/core bumped to 8.858.6
    * @okouai/db bumped to 2.57.7
    * @okouai/pi-agent-runtime bumped to 1.52.25

## [2.100.6](https://github.com/okou-ai/okou/compare/api-v2.100.5...api-v2.100.6) (2026-11-21)


### Bug Fixes

* **app:** support member-scoped connector permission approvals ([#49815](https://github.com/okou-ai/okou/issues/49815)) ([d264a98](https://github.com/okou-ai/okou/commit/d264a981e964c318ca2535b8e0651315c09fcf19))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.858.5
    * @okouai/db bumped to 2.57.6
    * @okouai/pi-agent-runtime bumped to 1.52.24

## [2.100.5](https://github.com/okou-ai/okou/compare/api-v2.100.4...api-v2.100.5) (2026-11-21)


### Refactoring

* **api:** stop mirroring custom connector skill writes ([#49780](https://github.com/okou-ai/okou/issues/49780)) ([c45ea3b](https://github.com/okou-ai/okou/commit/c45ea3bb479b9db4106a054134ee6bcfaf4a0988))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.57.5

## [2.100.4](https://github.com/okou-ai/okou/compare/api-v2.100.3...api-v2.100.4) (2026-11-21)


### Refactoring

* **db:** prepare custom connector skill writes before cutover ([#49718](https://github.com/okou-ai/okou/issues/49718)) ([ff65248](https://github.com/okou-ai/okou/commit/ff65248c67bcbafca4a1afe6c5a1d1407db2b7b4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.57.4

## [2.100.3](https://github.com/okou-ai/okou/compare/api-v2.100.2...api-v2.100.3) (2026-11-21)


### Bug Fixes

* **android:** keep running chats eligible for unread actions ([#49730](https://github.com/okou-ai/okou/issues/49730)) ([7a9953d](https://github.com/okou-ai/okou/commit/7a9953ddcdf16cbea66610f40345d504d6f5c058))


### Performance Improvements

* **api:** advance Chat send validation reads ([#49767](https://github.com/okou-ai/okou/issues/49767)) ([7f0b87d](https://github.com/okou-ai/okou/commit/7f0b87d3f62eeb6d53e973f31c05d1ac51b03fd7))
* **api:** advance scoped reads during run startup ([#49754](https://github.com/okou-ai/okou/issues/49754)) ([78003a5](https://github.com/okou-ai/okou/commit/78003a5026119ff6ea5fb27aa7df450758dd0794))
* **api:** overlap admission and consolidate startup reads ([#49743](https://github.com/okou-ai/okou/issues/49743)) ([32bee13](https://github.com/okou-ai/okou/commit/32bee13cf9505e9276fe1bef38d79f465ca76f22))
* **api:** remove mailbox and phone grant waits from run startup ([#49721](https://github.com/okou-ai/okou/issues/49721)) ([e3a95cf](https://github.com/okou-ai/okou/commit/e3a95cf2b04210bdd306948eff761563efc31f93))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.98.0
    * @okouai/core bumped to 8.858.4
    * @okouai/db bumped to 2.57.3
    * @okouai/pi-agent-runtime bumped to 1.52.23

## [2.100.2](https://github.com/okou-ai/okou/compare/api-v2.100.1...api-v2.100.2) (2026-11-21)


### Refactoring

* **api:** use member workflow bindings for chat run admission ([#49698](https://github.com/okou-ai/okou/issues/49698)) ([6bb1e26](https://github.com/okou-ai/okou/commit/6bb1e26af7737c36ea543a9ac3e96f51fee54337))


### Performance Improvements

* **api:** capture desktop grants with fifo and prefetch attachment records ([#49714](https://github.com/okou-ai/okou/issues/49714)) ([695e836](https://github.com/okou-ai/okou/commit/695e8363125b7b404c28ba5c9235823c0b2f04ec))
* **api:** overlap chat context reads and reuse project references ([#49705](https://github.com/okou-ai/okou/issues/49705)) ([9b90eaa](https://github.com/okou-ai/okou/commit/9b90eaa9867fb54811101ca7954f818dc5310172))
* **api:** prefetch chat packages and reuse launch inputs ([#49689](https://github.com/okou-ai/okou/issues/49689)) ([50c3992](https://github.com/okou-ai/okou/commit/50c399224cd1b62a29bf767ef041420c2730cafe))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.97.0
    * @okouai/core bumped to 8.858.3
    * @okouai/db bumped to 2.57.2
    * @okouai/pi-agent-runtime bumped to 1.52.22

## [2.100.1](https://github.com/okou-ai/okou/compare/api-v2.100.0...api-v2.100.1) (2026-11-21)


### Refactoring

* **api:** read native custom connector skill publications ([#49677](https://github.com/okou-ai/okou/issues/49677)) ([4f5de2f](https://github.com/okou-ai/okou/commit/4f5de2f6f8f7f61b0470bdaca4af99a7e3ce2aea))
* **api:** remove redundant drive account readiness ([#49664](https://github.com/okou-ai/okou/issues/49664)) ([2a48ac4](https://github.com/okou-ai/okou/commit/2a48ac4e25abc2e34a780a2f6b28a9914082d315))
* **api:** require member-scoped chat clients for run creation ([#49676](https://github.com/okou-ai/okou/issues/49676)) ([8ed0c41](https://github.com/okou-ai/okou/commit/8ed0c41efd72d4ddd1f6b9cc6c90d103cde20eb3))


### Performance Improvements

* **api:** capture coherent memory and connector inputs for chat runs ([#49660](https://github.com/okou-ai/okou/issues/49660)) ([c5b9ea9](https://github.com/okou-ai/okou/commit/c5b9ea99725f7658fff226ca85206baa96966599))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.96.2
    * @okouai/core bumped to 8.858.2
    * @okouai/db bumped to 2.57.1
    * @okouai/pi-agent-runtime bumped to 1.52.21

## [2.100.0](https://github.com/okou-ai/okou/compare/api-v2.99.0...api-v2.100.0) (2026-11-21)


### Features

* **api:** persist workspace ownership on chat threads ([#49631](https://github.com/okou-ai/okou/issues/49631)) ([e732eef](https://github.com/okou-ai/okou/commit/e732eef90dedcc3eecc8993c713d0ba695136579))


### Bug Fixes

* **api:** retry preferred Home checkout during Runner drain ([#49610](https://github.com/okou-ai/okou/issues/49610)) ([1236b95](https://github.com/okou-ai/okou/commit/1236b95d968982192768ef3543d5d3d0f7ded239))


### Documentation

* link workflow copy adapters to their retirement issue ([#49675](https://github.com/okou-ai/okou/issues/49675)) ([4806b77](https://github.com/okou-ai/okou/commit/4806b774b21d728224cf8995d5d333e7da9dd7c4))


### Refactoring

* **api:** remove retired my okou feature-switch response keys ([#49654](https://github.com/okou-ai/okou/issues/49654)) ([1c55faf](https://github.com/okou-ai/okou/commit/1c55faf576d6e5219080bace4668360692bcd8a1))
* **api:** retire legacy storage bindings from connector execution ([#49653](https://github.com/okou-ai/okou/issues/49653)) ([4238087](https://github.com/okou-ai/okou/commit/4238087d01c671077d6b6a021455ff73db1444c4))
* drop compose jobs and two retired agent columns ([#49632](https://github.com/okou-ai/okou/issues/49632)) ([8765355](https://github.com/okou-ai/okou/commit/87653555f2076921e05544c605522040256be6d0))
* retire agent fields from member features ([#49650](https://github.com/okou-ai/okou/issues/49650)) ([5803fa4](https://github.com/okou-ai/okou/commit/5803fa40457b2f0e2a2164c40cd1b8e3c6bb2d55))
* retire agent storage and cli selection ([#49638](https://github.com/okou-ai/okou/issues/49638)) ([4956bda](https://github.com/okou-ai/okou/commit/4956bda0bc2859cb1f91e5b7ca0b3fc8790c8732))
* scope chat run admission to workspace members ([#49637](https://github.com/okou-ai/okou/issues/49637)) ([30c1941](https://github.com/okou-ai/okou/commit/30c1941239202722c767b1190718538a5c0b00d3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.96.1
    * @okouai/connectors bumped to 3.23.2
    * @okouai/core bumped to 8.858.1
    * @okouai/db bumped to 2.57.0
    * @okouai/pi-agent-runtime bumped to 1.52.20

## [2.99.0](https://github.com/okou-ai/okou/compare/api-v2.98.2...api-v2.99.0) (2026-11-20)


### Features

* **mcp:** use projects for chat discovery and sends ([#49620](https://github.com/okou-ai/okou/issues/49620)) ([1e5b4d1](https://github.com/okou-ai/okou/commit/1e5b4d1546a109198b96874acad169221dad8ae7))


### Bug Fixes

* **api:** avoid syncing the temporary export restore index ([#49612](https://github.com/okou-ai/okou/issues/49612)) ([1af0084](https://github.com/okou-ai/okou/commit/1af00846322840ce2ea1a78d7c39af08052c5597))


### Performance Improvements

* **api:** align chat pick snapshots and prefetch package urls sooner ([#49586](https://github.com/okou-ai/okou/issues/49586)) ([422db13](https://github.com/okou-ai/okou/commit/422db135d5dd610491dbe5d4e3f8891d5d0fedf3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.96.0
    * @okouai/core bumped to 8.858.0
    * @okouai/db bumped to 2.56.4
    * @okouai/pi-agent-runtime bumped to 1.52.19

## [2.98.2](https://github.com/okou-ai/okou/compare/api-v2.98.1...api-v2.98.2) (2026-11-20)


### Refactoring

* **api:** preconnect runner dispatch with built-in fetch ([#49557](https://github.com/okou-ai/okou/issues/49557)) ([25f0b2b](https://github.com/okou-ai/okou/commit/25f0b2b6cec4fc8c5cf100125b74325a21229b4e))
* retire the single-agent feature switch ([#49556](https://github.com/okou-ai/okou/issues/49556)) ([4e5707d](https://github.com/okou-ai/okou/commit/4e5707de3ea728c59038345c47399cd51510a499))


### Performance Improvements

* **api:** overlap run bundle cache reads with admission preparation ([#49569](https://github.com/okou-ai/okou/issues/49569)) ([99a8cb2](https://github.com/okou-ai/okou/commit/99a8cb2b3253928960cc9ac7e3eeed104bdd574a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.95.3
    * @okouai/core bumped to 8.857.6
    * @okouai/db bumped to 2.56.3
    * @okouai/pi-agent-runtime bumped to 1.52.18

## [2.98.1](https://github.com/okou-ai/okou/compare/api-v2.98.0...api-v2.98.1) (2026-11-20)


### Refactoring

* **drive:** retire agent-scoped artifact exports ([#49545](https://github.com/okou-ai/okou/issues/49545)) ([8622b04](https://github.com/okou-ai/okou/commit/8622b04aa8c1c872e2dcb4fa52184072f6e6eda6))


### Performance Improvements

* **api:** prefetch run bundle urls and reuse initialized memory ([#49550](https://github.com/okou-ai/okou/issues/49550)) ([25140c0](https://github.com/okou-ai/okou/commit/25140c0f56ab3d512d9ea60580541b2e4e81d945))
* **api:** read direct runner placement in one snapshot ([#49535](https://github.com/okou-ai/okou/issues/49535)) ([0b68bbb](https://github.com/okou-ai/okou/commit/0b68bbb942b6727ea14857e85d36ffaa6e18716d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.95.2
    * @okouai/core bumped to 8.857.5
    * @okouai/db bumped to 2.56.2
    * @okouai/pi-agent-runtime bumped to 1.52.17

## [2.98.0](https://github.com/okou-ai/okou/compare/api-v2.97.4...api-v2.98.0) (2026-11-20)


### Features

* **cli:** add controls for all proactive settings ([#49491](https://github.com/okou-ai/okou/issues/49491)) ([fa9de5d](https://github.com/okou-ai/okou/commit/fa9de5d35ef2dba39d40940af9290b5ab692450b))


### Bug Fixes

* **api:** require the web client with chat Drive exports ([#49528](https://github.com/okou-ai/okou/issues/49528)) ([5cd43a8](https://github.com/okou-ai/okou/commit/5cd43a82df450e3c893c23a3c5d91e7085f4b5a1))


### Performance Improvements

* **api:** measure runner dispatch socket reuse ([#49515](https://github.com/okou-ai/okou/issues/49515)) ([a4e32f3](https://github.com/okou-ai/okou/commit/a4e32f300053676447b714cd927dd60ac86135c4))
* **api:** reuse run launch snapshots and overlap signing ([#49516](https://github.com/okou-ai/okou/issues/49516)) ([942dd91](https://github.com/okou-ai/okou/commit/942dd918f0da2113cf603bdb75b0bd6d7aee02cc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.56.1

## [2.97.4](https://github.com/okou-ai/okou/compare/api-v2.97.3...api-v2.97.4) (2026-11-20)


### Refactoring

* **drive:** authorize artifact and table exports with chat accounts ([#49430](https://github.com/okou-ai/okou/issues/49430)) ([efa10f0](https://github.com/okou-ai/okou/commit/efa10f0bb95b3f3c9c5d09aa3e1049c3c49163e7))


### Performance Improvements

* **api:** capture and overlap remaining run launch inputs ([#49489](https://github.com/okou-ai/okou/issues/49489)) ([1b6f8c8](https://github.com/okou-ai/okou/commit/1b6f8c886493476eafcc18cbd729fb81941bd334))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.95.1
    * @okouai/core bumped to 8.857.4
    * @okouai/db bumped to 2.56.0
    * @okouai/pi-agent-runtime bumped to 1.52.16

## [2.97.3](https://github.com/okou-ai/okou/compare/api-v2.97.2...api-v2.97.3) (2026-11-20)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.95.0
    * @okouai/core bumped to 8.857.3
    * @okouai/db bumped to 2.55.1
    * @okouai/pi-agent-runtime bumped to 1.52.15

## [2.97.2](https://github.com/okou-ai/okou/compare/api-v2.97.1...api-v2.97.2) (2026-11-20)


### Refactoring

* **api:** retire legacy run callbacks and simplify queued prompts ([#49448](https://github.com/okou-ai/okou/issues/49448)) ([e704f76](https://github.com/okou-ai/okou/commit/e704f76b00fe4bd450a293de15e6a594c2637261))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.857.2
    * @okouai/db bumped to 2.55.0
    * @okouai/pi-agent-runtime bumped to 1.52.14

## [2.97.1](https://github.com/okou-ai/okou/compare/api-v2.97.0...api-v2.97.1) (2026-11-20)


### Bug Fixes

* **platform:** use the suggestions switch for my okou proactive settings ([#49439](https://github.com/okou-ai/okou/issues/49439)) ([1d42e69](https://github.com/okou-ai/okou/commit/1d42e6994ad6d82a6678d34b955335765fc560b5))


### Refactoring

* remove feature guides feature switch ([#49441](https://github.com/okou-ai/okou/issues/49441)) ([e5642ea](https://github.com/okou-ai/okou/commit/e5642ea2ef0ea2ba7a6cd451d395c8329a855c88))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.94.1
    * @okouai/core bumped to 8.857.1
    * @okouai/db bumped to 2.54.3
    * @okouai/pi-agent-runtime bumped to 1.52.13

## [2.97.0](https://github.com/okou-ai/okou/compare/api-v2.96.0...api-v2.97.0) (2026-11-20)


### Features

* **platform:** consolidate proactive settings in my okou ([#49401](https://github.com/okou-ai/okou/issues/49401)) ([9d20531](https://github.com/okou-ai/okou/commit/9d20531a9ad041abf15a8e5c1697b06475b563df))


### Refactoring

* **api:** capture queued prompt delivery once ([#49420](https://github.com/okou-ai/okou/issues/49420)) ([3a14110](https://github.com/okou-ai/okou/commit/3a14110a3b066522c42361a57ceccb329aef907a))
* **api:** make queued continuation explicit ([#49429](https://github.com/okou-ai/okou/issues/49429)) ([97d31fb](https://github.com/okou-ai/okou/commit/97d31fb66579a567eda930952acba611c23e75f0))
* **api:** share run connector scope across account and skill resolution ([#49414](https://github.com/okou-ai/okou/issues/49414)) ([ae86233](https://github.com/okou-ai/okou/commit/ae86233b41a72b49c967fe580ea185bdf8c2ab9a))
* **api:** simplify queued launch binding and callbacks ([#49432](https://github.com/okou-ai/okou/issues/49432)) ([3e70d86](https://github.com/okou-ai/okou/commit/3e70d865438fe987ea77468340793cafe8c26c30))
* **api:** simplify queued prompt launch handoffs ([#49409](https://github.com/okou-ai/okou/issues/49409)) ([69c9055](https://github.com/okou-ai/okou/commit/69c905577283656d83a027e291a4b8a4a2601e22))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.94.0
    * @okouai/core bumped to 8.857.0
    * @okouai/db bumped to 2.54.2
    * @okouai/pi-agent-runtime bumped to 1.52.12

## [2.96.0](https://github.com/okou-ai/okou/compare/api-v2.95.7...api-v2.96.0) (2026-11-20)


### Features

* **api:** force app.vm0.ai clients to upgrade to v0.1154.2 ([#49404](https://github.com/okou-ai/okou/issues/49404)) ([e8a2091](https://github.com/okou-ai/okou/commit/e8a20918cc75930cce2f3512e764fad9ea6eb4f3))

## [2.95.7](https://github.com/okou-ai/okou/compare/api-v2.95.6...api-v2.95.7) (2026-11-20)


### Bug Fixes

* **db:** drop retired agent connector access storage ([#49382](https://github.com/okou-ai/okou/issues/49382)) ([1705898](https://github.com/okou-ai/okou/commit/1705898f6c9c9bf65db78be502dc3ccf5a17a6ab))


### Refactoring

* **api:** simplify queued prompt timing and routing ([#49391](https://github.com/okou-ai/okou/issues/49391)) ([e647058](https://github.com/okou-ai/okou/commit/e647058478c46b17bb46e55860054d48590ec706))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.54.1

## [2.95.6](https://github.com/okou-ai/okou/compare/api-v2.95.5...api-v2.95.6) (2026-11-20)


### Refactoring

* **api:** simplify terminal chat delivery receipts ([#49371](https://github.com/okou-ai/okou/issues/49371)) ([0069eac](https://github.com/okou-ai/okou/commit/0069eac69858cbfa960332b9c2607be583f3e4d2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.54.0

## [2.95.5](https://github.com/okou-ai/okou/compare/api-v2.95.4...api-v2.95.5) (2026-11-20)


### Bug Fixes

* **api:** retry gmail events after workflow rebinding ([#49295](https://github.com/okou-ai/okou/issues/49295)) ([dad3f2b](https://github.com/okou-ai/okou/commit/dad3f2b0fc6e9a2e3767f3ba4187d46a06db7ac3))


### Refactoring

* **api:** carry checked queued launch facts into planning ([#49305](https://github.com/okou-ai/okou/issues/49305)) ([062650e](https://github.com/okou-ai/okou/commit/062650e5cea55d69082220865f0b6c5ceaab3ea9))
* **api:** retire agent connector execution grants ([#49268](https://github.com/okou-ai/okou/issues/49268)) ([596e8ca](https://github.com/okou-ai/okou/commit/596e8ca5d65c2ba7d7b447816042a9bc48fa8b44))
* **api:** simplify queued launch handoff ([#49267](https://github.com/okou-ai/okou/issues/49267)) ([3e6a8a9](https://github.com/okou-ai/okou/commit/3e6a8a9d5049f746c1e490899ba7f1e624f77713))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.93.2
    * @okouai/core bumped to 8.856.2
    * @okouai/db bumped to 2.53.3
    * @okouai/pi-agent-runtime bumped to 1.52.11

## [2.95.4](https://github.com/okou-ai/okou/compare/api-v2.95.3...api-v2.95.4) (2026-11-19)


### Bug Fixes

* let each suggestion decide where its custom direction goes ([#49274](https://github.com/okou-ai/okou/issues/49274)) ([8ee03b2](https://github.com/okou-ai/okou/commit/8ee03b20a05e80b4cd1059f8dd55b72ff85df347))


### Refactoring

* remove expired deployment compatibility ([#49278](https://github.com/okou-ai/okou/issues/49278)) ([4338aee](https://github.com/okou-ai/okou/commit/4338aeeabfdb74ebee71a8e3c3c3862610b1262b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.93.1
    * @okouai/core bumped to 8.856.1
    * @okouai/db bumped to 2.53.2
    * @okouai/pi-agent-runtime bumped to 1.52.10

## [2.95.3](https://github.com/okou-ai/okou/compare/api-v2.95.2...api-v2.95.3) (2026-11-19)


### Bug Fixes

* **api:** isolate optional run packages and provision missing memory ([#49199](https://github.com/okou-ai/okou/issues/49199)) ([72c3c69](https://github.com/okou-ai/okou/commit/72c3c690b21f4934b87706d55dbd8f6c4cefa4ff))
* **api:** state run limits and saved data responses as facts ([#49270](https://github.com/okou-ai/okou/issues/49270)) ([6c2ec0a](https://github.com/okou-ai/okou/commit/6c2ec0a09b22dd1bed15ccaa32c4b05886f5d217))


### Refactoring

* **api:** classify runner dispatch custody exhaustively ([#49202](https://github.com/okou-ai/okou/issues/49202)) ([ed9c0ee](https://github.com/okou-ai/okou/commit/ed9c0eecfa42a0ec5e4b3fda0136ba112fdf1df8))
* **api:** enforce queued launch readiness at preparation ([#49204](https://github.com/okou-ai/okou/issues/49204)) ([60283b4](https://github.com/okou-ai/okou/commit/60283b4a3dbc984be44d9c4eabfe83c9c712f01b))

## [2.95.2](https://github.com/okou-ai/okou/compare/api-v2.95.1...api-v2.95.2) (2026-11-19)


### Bug Fixes

* **api:** isolate invalid connector configuration during run admission ([#49122](https://github.com/okou-ai/okou/issues/49122)) ([dcc6776](https://github.com/okou-ai/okou/commit/dcc6776d57ff2286294c4566c2dd59217f303f55))
* raise the automatic run limit to 128 hops ([#49055](https://github.com/okou-ai/okou/issues/49055)) ([dd33709](https://github.com/okou-ai/okou/commit/dd3370985e018240a46347ec0be5780ee23d7fec))


### Refactoring

* **api:** consolidate queued automation preflight ([#49132](https://github.com/okou-ai/okou/issues/49132)) ([97077ee](https://github.com/okou-ai/okou/commit/97077ee58e164b9fb998c0fe39a0f12278888d8e))
* **api:** resolve mail drafts through chat connector accounts ([#49080](https://github.com/okou-ai/okou/issues/49080)) ([cfb5cb9](https://github.com/okou-ai/okou/commit/cfb5cb9f06ac07a0db130b07c6dc6bb74ce2f92a))
* **api:** simplify automation assembly and launch results ([#49061](https://github.com/okou-ai/okou/issues/49061)) ([8c96a1e](https://github.com/okou-ai/okou/commit/8c96a1e0cedeb5d7d3c736b47b89ce22a939a1db))
* **api:** unify runner dispatch offer policy ([#49115](https://github.com/okou-ai/okou/issues/49115)) ([0eb6d55](https://github.com/okou-ai/okou/commit/0eb6d5575c679c18fa5d33fd00b1a674079477e3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.93.0
    * @okouai/core bumped to 8.856.0
    * @okouai/db bumped to 2.53.1
    * @okouai/pi-agent-runtime bumped to 1.52.9

## [2.95.1](https://github.com/okou-ai/okou/compare/api-v2.95.0...api-v2.95.1) (2026-11-19)


### Refactoring

* **api:** remove queued run startup remnants ([#49046](https://github.com/okou-ai/okou/issues/49046)) ([66d7775](https://github.com/okou-ai/okou/commit/66d7775eb7dce25b22529760728854c071bd53e4))
* **api:** resolve custom runtime from selected chat accounts ([#49025](https://github.com/okou-ai/okou/issues/49025)) ([3d3351f](https://github.com/okou-ai/okou/commit/3d3351f281c530b7d81bba93fd59cd87c02ba57c))
* **api:** retire chat connector client compatibility ([#49047](https://github.com/okou-ai/okou/issues/49047)) ([3202044](https://github.com/okou-ai/okou/commit/3202044add225011588e98a5724cec7470c78cde))
* **api:** simplify queued run planning and launch receipts ([#49019](https://github.com/okou-ai/okou/issues/49019)) ([f838858](https://github.com/okou-ai/okou/commit/f838858251a73c1fba7a7cb21b9ce314ed665549))


### Performance Improvements

* **api:** send bounded predecessor home checkout hints ([#49035](https://github.com/okou-ai/okou/issues/49035)) ([4fbea89](https://github.com/okou-ai/okou/commit/4fbea89804e16caa8372afcb9626b5716bb8f8e0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.92.1
    * @okouai/core bumped to 8.855.1
    * @okouai/db bumped to 2.53.0
    * @okouai/pi-agent-runtime bumped to 1.52.8

## [2.95.0](https://github.com/okou-ai/okou/compare/api-v2.94.4...api-v2.95.0) (2026-11-19)


### Features

* **api:** roll out chat connector accounts and retire the switch ([#48841](https://github.com/okou-ai/okou/issues/48841)) ([a5a153e](https://github.com/okou-ai/okou/commit/a5a153e20f5e7e9e3d3d7761772bd80720b3f684))


### Bug Fixes

* **api:** repair unpaired surrogates in chat message text ([#48989](https://github.com/okou-ai/okou/issues/48989)) ([077c6d9](https://github.com/okou-ai/okou/commit/077c6d9a53d324f225b773cfbdf564feb7066c75))


### Refactoring

* **api:** pass committed Run inputs directly to dispatch ([#48987](https://github.com/okou-ai/okou/issues/48987)) ([a936007](https://github.com/okou-ai/okou/commit/a9360077aa7df14a9cf5e37187af9615bc15f01a))


### Performance Improvements

* **api:** defer claude code subscription recovery lookup ([#48991](https://github.com/okou-ai/okou/issues/48991)) ([e2bf143](https://github.com/okou-ai/okou/commit/e2bf1434678d987e73a28d395bf7693224bfe7fe))
* **api:** resolve queued integration delivery without prompts ([#48986](https://github.com/okou-ai/okou/issues/48986)) ([d722b53](https://github.com/okou-ai/okou/commit/d722b53d2716b0536dc84738e7932e0f7bdab616))
* **api:** reuse private attachment records in conversation shares ([#48990](https://github.com/okou-ai/okou/issues/48990)) ([ee4d1de](https://github.com/okou-ai/okou/commit/ee4d1de1b0227f18b64321961abc9b66272ae801))
* **api:** reuse proactive preference eligibility on reads ([#48981](https://github.com/okou-ai/okou/issues/48981)) ([05f347f](https://github.com/okou-ai/okou/commit/05f347f2cac7795dd64740226137d7dbaa6fb895))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.92.0
    * @okouai/core bumped to 8.855.0
    * @okouai/db bumped to 2.52.0
    * @okouai/pi-agent-runtime bumped to 1.52.7

## [2.94.4](https://github.com/okou-ai/okou/compare/api-v2.94.3...api-v2.94.4) (2026-11-19)


### Bug Fixes

* **db:** drop retired ios widget push columns ([#48956](https://github.com/okou-ai/okou/issues/48956)) ([d18d687](https://github.com/okou-ai/okou/commit/d18d6871bd8ebca73e559cbabb73f5b95850d056))


### Refactoring

* consolidate artifact timing behind one switch ([#48953](https://github.com/okou-ai/okou/issues/48953)) ([18b57aa](https://github.com/okou-ai/okou/commit/18b57aa53cf9a5451a38b092fe86b6065da5b052))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.91.0
    * @okouai/core bumped to 8.854.6
    * @okouai/db bumped to 2.51.2
    * @okouai/pi-agent-runtime bumped to 1.52.6

## [2.94.3](https://github.com/okou-ai/okou/compare/api-v2.94.2...api-v2.94.3) (2026-11-19)


### Refactoring

* **api:** retire legacy reward campaign orchestration ([#48939](https://github.com/okou-ai/okou/issues/48939)) ([d1739be](https://github.com/okou-ai/okou/commit/d1739bed31dcde34fead64d82e54489fda10549f))
* **api:** share Teams launch context and delivery ([#48937](https://github.com/okou-ai/okou/issues/48937)) ([d972a61](https://github.com/okou-ai/okou/commit/d972a6163eca6ac35450d990345cfd33cc42ba82))


### Performance Improvements

* **api:** advance chat read cursors in one write ([#48932](https://github.com/okou-ai/okou/issues/48932)) ([39d40e3](https://github.com/okou-ai/okou/commit/39d40e3eaa0f20f87eaaeebd8df994d805ff3bcf))
* **api:** defer codex subscription recovery until authorization completes ([#48935](https://github.com/okou-ai/okou/issues/48935)) ([ee65216](https://github.com/okou-ai/okou/commit/ee6521690304375a8a97480de0a506386c987360))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.90.2
    * @okouai/core bumped to 8.854.5
    * @okouai/db bumped to 2.51.1
    * @okouai/pi-agent-runtime bumped to 1.52.5

## [2.94.2](https://github.com/okou-ai/okou/compare/api-v2.94.1...api-v2.94.2) (2026-11-19)


### Bug Fixes

* **api:** handle phone use authority read timeouts ([#48681](https://github.com/okou-ai/okou/issues/48681)) ([1b1b28f](https://github.com/okou-ai/okou/commit/1b1b28fef198b6e6548542691746291740cac9fc))
* **app:** clarify paused automation feed cards ([#48887](https://github.com/okou-ai/okou/issues/48887)) ([4b72b66](https://github.com/okou-ai/okou/commit/4b72b660f8279424182640658aa21773cc49ccd4))


### Refactoring

* **api:** pass effective queued model selection to routing ([#48912](https://github.com/okou-ai/okou/issues/48912)) ([4843b38](https://github.com/okou-ai/okou/commit/4843b38b94cf7777598a16287a8d559136bc695c))
* **api:** use three-point axiom artifact timing ([#48854](https://github.com/okou-ai/okou/issues/48854)) ([d930e21](https://github.com/okou-ai/okou/commit/d930e21f8d3d93278613fcef287ae7b58febdf72))


### Performance Improvements

* **api:** capture thread and fifo head in one pick query ([#48897](https://github.com/okou-ai/okou/issues/48897)) ([9c9183b](https://github.com/okou-ai/okou/commit/9c9183b4015b9c8b363e56fd68124ac972bb5baa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.90.1
    * @okouai/core bumped to 8.854.4
    * @okouai/db bumped to 2.51.0
    * @okouai/pi-agent-runtime bumped to 1.52.4

## [2.94.1](https://github.com/okou-ai/okou/compare/api-v2.94.0...api-v2.94.1) (2026-11-19)


### Bug Fixes

* **api:** authorize OAuth by route scopes ([#48878](https://github.com/okou-ai/okou/issues/48878)) ([34d574a](https://github.com/okou-ai/okou/commit/34d574a25f2bb3f096829e94b7a53d7608545245))


### Refactoring

* **api:** reuse resolved skill mounts during dispatch ([#48883](https://github.com/okou-ai/okou/issues/48883)) ([1d13675](https://github.com/okou-ai/okou/commit/1d136754b73d395b3b1a587ee9a947e745a2b2b0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.50.0

## [2.94.0](https://github.com/okou-ai/okou/compare/api-v2.93.0...api-v2.94.0) (2026-11-19)


### Features

* **ios:** refresh home screen widgets when chats change elsewhere ([#47010](https://github.com/okou-ai/okou/issues/47010)) ([a3459ce](https://github.com/okou-ai/okou/commit/a3459ce8b0a9e90434e1b2ae3d1791108e7eebd1))


### Refactoring

* **api:** carry the accepted official workflow mounts into dispatch ([#48857](https://github.com/okou-ai/okou/issues/48857)) ([47c480b](https://github.com/okou-ai/okou/commit/47c480bc3f4ab7f99722a823f512261d10e8040d))
* **api:** delegate mcp token verification to clerk ([#48863](https://github.com/okou-ai/okou/issues/48863)) ([bbf2529](https://github.com/okou-ai/okou/commit/bbf25298b7e7127fe90a41dabdf82c84b942ae46))


### Performance Improvements

* **api:** reuse the picked input when rejecting a chat queue head ([#48873](https://github.com/okou-ai/okou/issues/48873)) ([6a663c9](https://github.com/okou-ai/okou/commit/6a663c942ad3ce0aa2726c65962880b68b875f0e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.90.0
    * @okouai/core bumped to 8.854.3
    * @okouai/db bumped to 2.49.0
    * @okouai/pi-agent-runtime bumped to 1.52.3

## [2.93.0](https://github.com/okou-ai/okou/compare/api-v2.92.1...api-v2.93.0) (2026-11-19)


### Features

* **onboarding:** persist drafts across devices ([#48816](https://github.com/okou-ai/okou/issues/48816)) ([368d3dd](https://github.com/okou-ai/okou/commit/368d3dd31744833319c9cffce3c17191a5c327d7))


### Bug Fixes

* **api:** restore worker chat contract boundary ([#48831](https://github.com/okou-ai/okou/issues/48831)) ([eaa5345](https://github.com/okou-ai/okou/commit/eaa534508cd90d369ce240cd754aaf98ecb4e289))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.89.0
    * @okouai/core bumped to 8.854.2
    * @okouai/db bumped to 2.48.0
    * @okouai/pi-agent-runtime bumped to 1.52.2

## [2.92.1](https://github.com/okou-ai/okou/compare/api-v2.92.0...api-v2.92.1) (2026-11-19)


### Bug Fixes

* **api:** classify malformed outlook draft ids ([#48794](https://github.com/okou-ai/okou/issues/48794)) ([4cfd459](https://github.com/okou-ai/okou/commit/4cfd45983a517e8975e1e5021f7eeb7a37ad41b7))


### Performance Improvements

* **api:** overlap bundle url cache reads with storage signing ([#48801](https://github.com/okou-ai/okou/issues/48801)) ([c732cf0](https://github.com/okou-ai/okou/commit/c732cf0bb6f00c5f2db1f9881c9f18ade1f48a4d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.88.0
    * @okouai/core bumped to 8.854.1
    * @okouai/db bumped to 2.47.0
    * @okouai/pi-agent-runtime bumped to 1.52.1

## [2.92.0](https://github.com/okou-ai/okou/compare/api-v2.91.3...api-v2.92.0) (2026-11-18)


### Features

* add ultrafast for codex subscriptions ([#48736](https://github.com/okou-ai/okou/issues/48736)) ([c352dad](https://github.com/okou-ai/okou/commit/c352dadadbbec10cea8cf77adccfac8462ecdb94))


### Refactoring

* **api:** remove legacy storage export authorization ([#48732](https://github.com/okou-ai/okou/issues/48732)) ([ad521c5](https://github.com/okou-ai/okou/commit/ad521c515f25954f1cc271eceab18da4f2bb2789))
* **api:** separate verified firewall and sandbox authority ([#48761](https://github.com/okou-ai/okou/issues/48761)) ([f642984](https://github.com/okou-ai/okou/commit/f64298411819eea46a8dc3ff7d570f3794f43214))
* **firewall:** retire legacy resolver and envelope compatibility ([#48739](https://github.com/okou-ai/okou/issues/48739)) ([7dcd7ca](https://github.com/okou-ai/okou/commit/7dcd7cac45f2b26e253703533fc7f1097609c0f6))


### Performance Improvements

* **api:** prefetch chat attachment metadata once ([#48725](https://github.com/okou-ai/okou/issues/48725)) ([f688f4a](https://github.com/okou-ai/okou/commit/f688f4aa48b0d85c248529a701c82492b618a041))
* **api:** prefetch execution packages from picked sources ([#48743](https://github.com/okou-ai/okou/issues/48743)) ([ed12b4c](https://github.com/okou-ai/okou/commit/ed12b4c17134868df08762d0c64142a4c4eb9a8f))
* **api:** reuse accepted memory metadata in direct dispatch ([#48735](https://github.com/okou-ai/okou/issues/48735)) ([c3ceff1](https://github.com/okou-ai/okou/commit/c3ceff1935ba73b29a0b6962ceb69562295f3802))
* **api:** reuse resolved pi config during run startup ([#48752](https://github.com/okou-ai/okou/issues/48752)) ([c4acfaa](https://github.com/okou-ai/okou/commit/c4acfaaf5f34d3df2dd4d1bf72fbd46f70170d4d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.87.0
    * @okouai/core bumped to 8.854.0
    * @okouai/db bumped to 2.46.0
    * @okouai/pi-agent-runtime bumped to 1.52.0

## [2.91.3](https://github.com/okou-ai/okou/compare/api-v2.91.2...api-v2.91.3) (2026-11-18)


### Performance Improvements

* **api:** remove execution-startup secret encryption ([#48677](https://github.com/okou-ai/okou/issues/48677)) ([ffad11e](https://github.com/okou-ai/okou/commit/ffad11eaaca4de2da2218225794d16f39c2b7796))
* **api:** remove redundant workflow reads from run startup ([#48693](https://github.com/okou-ai/okou/issues/48693)) ([d9e8999](https://github.com/okou-ai/okou/commit/d9e89992f9a754faccc7d2c88cd39da8ec970339))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.86.4
    * @okouai/core bumped to 8.853.2
    * @okouai/db bumped to 2.45.2
    * @okouai/pi-agent-runtime bumped to 1.51.162

## [2.91.2](https://github.com/okou-ai/okou/compare/api-v2.91.1...api-v2.91.2) (2026-11-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.45.1

## [2.91.1](https://github.com/okou-ai/okou/compare/api-v2.91.0...api-v2.91.1) (2026-11-18)


### Bug Fixes

* **artifacts:** reduce visibility update latency ([#48652](https://github.com/okou-ai/okou/issues/48652)) ([7f50485](https://github.com/okou-ai/okou/commit/7f50485e293fab339942a621798bd35ae9464bc2))


### Refactoring

* **api:** retire generic storage writeback ([#48673](https://github.com/okou-ai/okou/issues/48673)) ([a357e01](https://github.com/okou-ai/okou/commit/a357e018a228f4f2e3880015f9c4cc921c52b766))
* **api:** unify marketing reward notifications ([#48668](https://github.com/okou-ai/okou/issues/48668)) ([20e7c48](https://github.com/okou-ai/okou/commit/20e7c4853f65e4cb6d6a841876a713e3a8870dfb))


### Performance Improvements

* **api:** reuse accepted execution package sources ([#48671](https://github.com/okou-ai/okou/issues/48671)) ([23abb62](https://github.com/okou-ai/okou/commit/23abb6281382fed7c525e61da173c7619fbee81a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.86.3
    * @okouai/core bumped to 8.853.1
    * @okouai/db bumped to 2.45.0
    * @okouai/pi-agent-runtime bumped to 1.51.161

## [2.91.0](https://github.com/okou-ai/okou/compare/api-v2.90.2...api-v2.91.0) (2026-11-18)


### Features

* **core:** enable artifact generation timing by default ([#48626](https://github.com/okou-ai/okou/issues/48626)) ([f3c43bf](https://github.com/okou-ai/okou/commit/f3c43bf0cb414043f36623cc451d12d8ce223bae))


### Refactoring

* **api:** resolve direct run mounts from member memory ([#48641](https://github.com/okou-ai/okou/issues/48641)) ([831b2cb](https://github.com/okou-ai/okou/commit/831b2cb7c1bbc8f25f0fb6fae2b3b6f044a51ba9))


### Performance Improvements

* **api:** reuse accepted connector preparation ([#48634](https://github.com/okou-ai/okou/issues/48634)) ([2f150ac](https://github.com/okou-ai/okou/commit/2f150acc7c4f7b6861e101bebe82c2f5220d3cba))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.853.0
    * @okouai/db bumped to 2.44.9
    * @okouai/pi-agent-runtime bumped to 1.51.160

## [2.90.2](https://github.com/okou-ai/okou/compare/api-v2.90.1...api-v2.90.2) (2026-11-18)


### Refactoring

* **api:** publish invitation facts and retire marketing read bridges ([#48630](https://github.com/okou-ai/okou/issues/48630)) ([fd53dd1](https://github.com/okou-ai/okou/commit/fd53dd1e7c58e7fdb39bb6f2d97b70ce8c53e162))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.86.2
    * @okouai/core bumped to 8.852.2
    * @okouai/db bumped to 2.44.8
    * @okouai/pi-agent-runtime bumped to 1.51.159

## [2.90.1](https://github.com/okou-ai/okou/compare/api-v2.90.0...api-v2.90.1) (2026-11-18)


### Bug Fixes

* **api:** include integration context in chat title generation ([#48616](https://github.com/okou-ai/okou/issues/48616)) ([9a33655](https://github.com/okou-ai/okou/commit/9a33655d9402d053fa0c9828bd7375b1a4429c81))
* **api:** support attachments on inactive single agent workflow copies ([#48624](https://github.com/okou-ai/okou/issues/48624)) ([f41a05a](https://github.com/okou-ai/okou/commit/f41a05a04f254ecc6e4e614db921fef94b44ace1))
* **chat:** dismiss archived reminders without marking chats read ([#48560](https://github.com/okou-ai/okou/issues/48560)) ([d3d69ae](https://github.com/okou-ai/okou/commit/d3d69ae2e7738d8b0b02450dde04399c91641a54))


### Refactoring

* **firewall:** separate host resolver authority from guest identity ([#48459](https://github.com/okou-ai/okou/issues/48459)) ([949de84](https://github.com/okou-ai/okou/commit/949de843f47dd8152058c7d7e2ca8a418305f0fc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.86.1
    * @okouai/core bumped to 8.852.1
    * @okouai/db bumped to 2.44.7
    * @okouai/pi-agent-runtime bumped to 1.51.158

## [2.90.0](https://github.com/okou-ai/okou/compare/api-v2.89.1...api-v2.90.0) (2026-11-18)


### Features

* **app:** enable feature guides with the my okou redesign ([#47733](https://github.com/okou-ai/okou/issues/47733)) ([0e9387d](https://github.com/okou-ai/okou/commit/0e9387d6ef081ec765f9c1392e1158ac95bc6da0))


### Performance Improvements

* **api:** reuse the first accepted model source ([#48568](https://github.com/okou-ai/okou/issues/48568)) ([e0a42f9](https://github.com/okou-ai/okou/commit/e0a42f9498c18331db0a718b2539696079cfb1e4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.86.0
    * @okouai/core bumped to 8.852.0
    * @okouai/db bumped to 2.44.6
    * @okouai/pi-agent-runtime bumped to 1.51.157

## [2.89.1](https://github.com/okou-ai/okou/compare/api-v2.89.0...api-v2.89.1) (2026-11-18)


### Bug Fixes

* classify codex terminal failures and agent oom ([#48521](https://github.com/okou-ai/okou/issues/48521)) ([00075f2](https://github.com/okou-ai/okou/commit/00075f2f8a0d64e6aa8c3cecc8dc7bdc6cccde5f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.85.2
    * @okouai/core bumped to 8.851.1
    * @okouai/db bumped to 2.44.5
    * @okouai/pi-agent-runtime bumped to 1.51.156

## [2.89.0](https://github.com/okou-ai/okou/compare/api-v2.88.0...api-v2.89.0) (2026-11-18)


### Features

* **core:** enable presentation output format for staff ([#48524](https://github.com/okou-ai/okou/issues/48524)) ([af156ca](https://github.com/okou-ai/okou/commit/af156ca8c7dea3483e14ae37a058890dd57581d0))


### Refactoring

* **api:** retire marketing reward read callbacks ([#48553](https://github.com/okou-ai/okou/issues/48553)) ([0e0b6a9](https://github.com/okou-ai/okou/commit/0e0b6a982616cf1641df58b3412c3dc7b87331e2))


### Performance Improvements

* **api:** reuse browser health connections within bounded sweeps ([#48474](https://github.com/okou-ai/okou/issues/48474)) ([5110f7e](https://github.com/okou-ai/okou/commit/5110f7ef309c5df996cb35b517bdaf89f2a2d887))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.85.1
    * @okouai/core bumped to 8.851.0
    * @okouai/db bumped to 2.44.4
    * @okouai/pi-agent-runtime bumped to 1.51.155

## [2.88.0](https://github.com/okou-ai/okou/compare/api-v2.87.2...api-v2.88.0) (2026-11-18)


### Features

* **cli:** save data responses and reuse identical calls ([#48466](https://github.com/okou-ai/okou/issues/48466)) ([cfd8171](https://github.com/okou-ai/okou/commit/cfd8171f6c0268b617f212d32802cb4ca20cfb74))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.850.2
    * @okouai/db bumped to 2.44.3
    * @okouai/pi-agent-runtime bumped to 1.51.154

## [2.87.2](https://github.com/okou-ai/okou/compare/api-v2.87.1...api-v2.87.2) (2026-11-18)


### Refactoring

* **api:** resolve data router token at firewall auth ([#48427](https://github.com/okou-ai/okou/issues/48427)) ([f63c8b6](https://github.com/okou-ai/okou/commit/f63c8b6ac4617ea3cbe93c61a38410ed2c33546e))


### Performance Improvements

* **api:** reuse admitted timezone and seed skill contributions ([#48425](https://github.com/okou-ai/okou/issues/48425)) ([ecd1e72](https://github.com/okou-ai/okou/commit/ecd1e722ba816f9a046be353035ab1bb6df227fb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.85.0
    * @okouai/core bumped to 8.850.1
    * @okouai/db bumped to 2.44.2
    * @okouai/pi-agent-runtime bumped to 1.51.153

## [2.87.1](https://github.com/okou-ai/okou/compare/api-v2.87.0...api-v2.87.1) (2026-11-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.850.0
    * @okouai/db bumped to 2.44.1
    * @okouai/pi-agent-runtime bumped to 1.51.152

## [2.87.0](https://github.com/okou-ai/okou/compare/api-v2.86.0...api-v2.87.0) (2026-11-17)


### Features

* add independent project sorting ([#48352](https://github.com/okou-ai/okou/issues/48352)) ([5ace277](https://github.com/okou-ai/okou/commit/5ace277384c9a3e0da65abdbf87a89fea3311d85))


### Refactoring

* activate structured run failures with retained storage ([#47844](https://github.com/okou-ai/okou/issues/47844)) ([fdb91d8](https://github.com/okou-ai/okou/commit/fdb91d8fea44a0be90036ebd9d6c25210eb5baa2))
* **api:** resolve managed model keys at firewall auth ([#48410](https://github.com/okou-ai/okou/issues/48410)) ([7b9fc81](https://github.com/okou-ai/okou/commit/7b9fc81233caa9800f895d3df38ea9f65bf69454))
* **memory:** retire legacy memory compatibility runtime ([#48363](https://github.com/okou-ai/okou/issues/48363)) ([7a30ea0](https://github.com/okou-ai/okou/commit/7a30ea0ee45da9dabdda7167d9c60e5b91496b7e))


### Performance Improvements

* **api:** start input prefetch from minimum dependencies ([#48266](https://github.com/okou-ai/okou/issues/48266)) ([cf2e300](https://github.com/okou-ai/okou/commit/cf2e3002da39bba2419fb7811e60323baea66458))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.84.0
    * @okouai/core bumped to 8.849.0
    * @okouai/db bumped to 2.44.0
    * @okouai/pi-agent-runtime bumped to 1.51.151

## [2.86.0](https://github.com/okou-ai/okou/compare/api-v2.85.0...api-v2.86.0) (2026-11-17)


### Features

* **api:** allow scoped native oauth companion access ([#48263](https://github.com/okou-ai/okou/issues/48263)) ([6c27338](https://github.com/okou-ai/okou/commit/6c273389fcde806f2b8067941a4fb3750c6375ac))


### Bug Fixes

* **api:** scope committed work to owners and reduce test isolation ([#48329](https://github.com/okou-ai/okou/issues/48329)) ([af5863f](https://github.com/okou-ai/okou/commit/af5863fc181e298829cd5f1ea2a4bc4dc63d89fa))


### Performance Improvements

* **runner:** attribute archive staging writes ([#48338](https://github.com/okou-ai/okou/issues/48338)) ([1aeffbc](https://github.com/okou-ai/okou/commit/1aeffbc8c757415acb407157dba177305ed1b210))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.83.1
    * @okouai/core bumped to 8.848.1
    * @okouai/db bumped to 2.43.1
    * @okouai/pi-agent-runtime bumped to 1.51.150

## [2.85.0](https://github.com/okou-ai/okou/compare/api-v2.84.1...api-v2.85.0) (2026-11-17)


### Features

* **api:** durably refresh marketing reward progress ([#48264](https://github.com/okou-ai/okou/issues/48264)) ([f0eddb0](https://github.com/okou-ai/okou/commit/f0eddb06ec314725bc198c2bbbde7c5bb31a00c2))
* drive phone use through realtime notifications ([#48253](https://github.com/okou-ai/okou/issues/48253)) ([7a71cfe](https://github.com/okou-ai/okou/commit/7a71cfe71674871cae66ddee7d0d12cd0a7f2760))
* roll out free plan artifact paywall ([#48265](https://github.com/okou-ai/okou/issues/48265)) ([a8c6d85](https://github.com/okou-ai/okou/commit/a8c6d85e09610d0268362ec7db53d7ec8f031fb6))


### Bug Fixes

* **api:** record artifact success separately from run completion ([#48245](https://github.com/okou-ai/okou/issues/48245)) ([d9940ef](https://github.com/okou-ai/okou/commit/d9940efa398db348d91044a76fda715abc5f1dce))
* **api:** remove outdated model guidance from welcome messages ([#48237](https://github.com/okou-ai/okou/issues/48237)) ([3f547ff](https://github.com/okou-ai/okou/commit/3f547ffdd411027959a59b207f7c968dc649b9c7))
* generate semantic filenames for message pdf downloads ([#48262](https://github.com/okou-ai/okou/issues/48262)) ([d311fd8](https://github.com/okou-ai/okou/commit/d311fd8ca02dc9b2c555e52c2e8112a0fbab002b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.83.0
    * @okouai/core bumped to 8.848.0
    * @okouai/db bumped to 2.43.0
    * @okouai/pi-agent-runtime bumped to 1.51.149

## [2.84.1](https://github.com/okou-ai/okou/compare/api-v2.84.0...api-v2.84.1) (2026-11-17)


### Bug Fixes

* **phone-use:** remove local action review guidance ([#48248](https://github.com/okou-ai/okou/issues/48248)) ([72ef73a](https://github.com/okou-ai/okou/commit/72ef73aec992722ecd4b4173a02113a3e4f48327))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.82.0
    * @okouai/core bumped to 8.847.6
    * @okouai/db bumped to 2.42.4
    * @okouai/pi-agent-runtime bumped to 1.51.148

## [2.84.0](https://github.com/okou-ai/okou/compare/api-v2.83.0...api-v2.84.0) (2026-11-17)


### Features

* **api:** prepare controlled marketing reward routing ([#48235](https://github.com/okou-ai/okou/issues/48235)) ([850096b](https://github.com/okou-ai/okou/commit/850096b648aa3d77b198e18cfb69baa6cdf3dff9))


### Refactoring

* **api:** activate member memory authority ([#48232](https://github.com/okou-ai/okou/issues/48232)) ([91ce356](https://github.com/okou-ai/okou/commit/91ce3565d08415a9133200504e26708d4d78db10))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.81.0
    * @okouai/core bumped to 8.847.5
    * @okouai/db bumped to 2.42.3
    * @okouai/pi-agent-runtime bumped to 1.51.147

## [2.83.0](https://github.com/okou-ai/okou/compare/api-v2.82.0...api-v2.83.0) (2026-11-17)


### Features

* **api:** expose read-only invitation source facts ([#48225](https://github.com/okou-ai/okou/issues/48225)) ([2ef7440](https://github.com/okou-ai/okou/commit/2ef744094b871e889eb74c4d50c5ee475ef6baab))


### Bug Fixes

* align phone availability with usable native control ([#48135](https://github.com/okou-ai/okou/issues/48135)) ([1744a58](https://github.com/okou-ai/okou/commit/1744a58d3f33923f71a34d07e85a87eeb86d03c1))
* **app:** keep artifact categories visible and group pptx presentations ([#48154](https://github.com/okou-ai/okou/issues/48154)) ([ff91500](https://github.com/okou-ai/okou/commit/ff915007aee99db02847333166b8f4bd2962b0f3))


### Performance Improvements

* **api:** retire debug-only run fields from application sql ([#48082](https://github.com/okou-ai/okou/issues/48082)) ([a40cf00](https://github.com/okou-ai/okou/commit/a40cf00d2f9e5c63fcb2dfa6ea68485b13be4f13))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.80.0
    * @okouai/core bumped to 8.847.4
    * @okouai/db bumped to 2.42.2
    * @okouai/pi-agent-runtime bumped to 1.51.146

## [2.82.0](https://github.com/okou-ai/okou/compare/api-v2.81.0...api-v2.82.0) (2026-11-17)


### Features

* **api:** retain source-proven daily check-in requests ([#48157](https://github.com/okou-ai/okou/issues/48157)) ([2685448](https://github.com/okou-ai/okou/commit/26854487b208b5123e9c9e03f84d4154f12c6475))


### Bug Fixes

* automatically continue integration chats after model recovery ([#48152](https://github.com/okou-ai/okou/issues/48152)) ([70b6624](https://github.com/okou-ai/okou/commit/70b6624fcc16a0197b0dceb88fc587ac694c1c86))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.79.0
    * @okouai/core bumped to 8.847.3
    * @okouai/db bumped to 2.42.1
    * @okouai/pi-agent-runtime bumped to 1.51.145

## [2.81.0](https://github.com/okou-ai/okou/compare/api-v2.80.0...api-v2.81.0) (2026-11-17)


### Features

* **api:** durably refresh confirmed marketing rewards ([#48139](https://github.com/okou-ai/okou/issues/48139)) ([6d68129](https://github.com/okou-ai/okou/commit/6d68129031a759c9a2cc232d4c365021e6b820be))


### Bug Fixes

* make projects follow the single agent switch ([#48142](https://github.com/okou-ai/okou/issues/48142)) ([c8c181a](https://github.com/okou-ai/okou/commit/c8c181a5d258306463622a74129e8f770ba00fd7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.78.0
    * @okouai/core bumped to 8.847.2
    * @okouai/db bumped to 2.42.0
    * @okouai/pi-agent-runtime bumped to 1.51.144

## [2.80.0](https://github.com/okou-ai/okou/compare/api-v2.79.2...api-v2.80.0) (2026-11-17)


### Features

* **api:** settle source-proven marketing rewards ([#48079](https://github.com/okou-ai/okou/issues/48079)) ([95e2816](https://github.com/okou-ai/okou/commit/95e2816dd55eef02f025b55699e01bc0b1f16f8f))


### Refactoring

* remove for you sources feature switch ([#48074](https://github.com/okou-ai/okou/issues/48074)) ([335f7b5](https://github.com/okou-ai/okou/commit/335f7b5c0410626867316382e92753d219e1e937))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.77.0
    * @okouai/core bumped to 8.847.1
    * @okouai/db bumped to 2.41.2
    * @okouai/pi-agent-runtime bumped to 1.51.143

## [2.79.2](https://github.com/okou-ai/okou/compare/api-v2.79.1...api-v2.79.2) (2026-11-17)


### Refactoring

* **api:** build complete execution requests in publication ([#48065](https://github.com/okou-ai/okou/issues/48065)) ([bba6568](https://github.com/okou-ai/okou/commit/bba65683295e470256cba42f0ce6c8457972fd98))

## [2.79.1](https://github.com/okou-ai/okou/compare/api-v2.79.0...api-v2.79.1) (2026-11-17)


### Bug Fixes

* **api:** deliver canonical slack file bytes on the server ([#48047](https://github.com/okou-ai/okou/issues/48047)) ([b94750b](https://github.com/okou-ai/okou/commit/b94750b39f87264646854948b0cfac50f1585a14))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.76.1
    * @okouai/core bumped to 8.847.0
    * @okouai/db bumped to 2.41.1
    * @okouai/pi-agent-runtime bumped to 1.51.142

## [2.79.0](https://github.com/okou-ai/okou/compare/api-v2.78.0...api-v2.79.0) (2026-11-17)


### Features

* **api:** persist marketing reward invitation source events ([#48038](https://github.com/okou-ai/okou/issues/48038)) ([1a0090d](https://github.com/okou-ai/okou/commit/1a0090dd00ee6cc9e53f8768f8be30b317ba888d))
* **api:** persist marketing reward link source events ([#47991](https://github.com/okou-ai/okou/issues/47991)) ([599e4df](https://github.com/okou-ai/okou/commit/599e4dfd4d619cd6921157c14cd0d52133cbe1e6))
* **my-okou:** preserve initialized members and enable new-member defaults ([#47051](https://github.com/okou-ai/okou/issues/47051)) ([cf1c9e5](https://github.com/okou-ai/okou/commit/cf1c9e53c2076c58bd6bb85d51dedbd62c30b6d1))


### Refactoring

* **api:** require complete run preparation facts ([#47955](https://github.com/okou-ai/okou/issues/47955)) ([b916d05](https://github.com/okou-ai/okou/commit/b916d05c76c4412d29b3dce3d9eb702dab89a29b))


### Performance Improvements

* **api:** overlap package selection with runtime preparation ([#47997](https://github.com/okou-ai/okou/issues/47997)) ([ac83c22](https://github.com/okou-ai/okou/commit/ac83c220322c3342e117d4020899dcda56e466aa))
* **api:** publish signed url cache outside runner delivery ([#47999](https://github.com/okou-ai/okou/issues/47999)) ([1977242](https://github.com/okou-ai/okou/commit/1977242528586fefd74eb8541bf1ff6b149473fc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.76.0
    * @okouai/core bumped to 8.846.0
    * @okouai/db bumped to 2.41.0
    * @okouai/pi-agent-runtime bumped to 1.51.141

## [2.78.0](https://github.com/okou-ai/okou/compare/api-v2.77.0...api-v2.78.0) (2026-11-17)


### Features

* **api:** persist marketing reward oauth source events ([#47894](https://github.com/okou-ai/okou/issues/47894)) ([2a9ec88](https://github.com/okou-ai/okou/commit/2a9ec88aa67e09cd12bec71ac18b6379682fd2e3))

## [2.77.0](https://github.com/okou-ai/okou/compare/api-v2.76.1...api-v2.77.0) (2026-11-16)


### Features

* route presentation templates by output format ([#47842](https://github.com/okou-ai/okou/issues/47842)) ([b342805](https://github.com/okou-ai/okou/commit/b342805293be679b34781d7ff4811669feccbb77))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.75.0
    * @okouai/core bumped to 8.845.0
    * @okouai/db bumped to 2.40.0
    * @okouai/pi-agent-runtime bumped to 1.51.140

## [2.76.1](https://github.com/okou-ai/okou/compare/api-v2.76.0...api-v2.76.1) (2026-11-16)


### Refactoring

* **api:** carry pinned model selection through thread launch ([#47920](https://github.com/okou-ai/okou/issues/47920)) ([bce1ee8](https://github.com/okou-ai/okou/commit/bce1ee89e973cd00fec9327392a6c9db21b196b1))
* **api:** remove workflow storage launch remnants ([#47913](https://github.com/okou-ai/okou/issues/47913)) ([5093a7d](https://github.com/okou-ai/okou/commit/5093a7d563b2290b988726b3ef4bdb5ac1459e08))


### Performance Improvements

* **api:** skip unused conditional run preparation reads ([#47919](https://github.com/okou-ai/okou/issues/47919)) ([2e87907](https://github.com/okou-ai/okou/commit/2e879078228fab6f73ace6cd935056aa85a3af62))
* **api:** trim redundant run preparation projections ([#47903](https://github.com/okou-ai/okou/issues/47903)) ([75554a2](https://github.com/okou-ai/okou/commit/75554a2485cb2a0a4ebab9935be1d211db2610f5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.844.3
    * @okouai/db bumped to 2.39.3
    * @okouai/pi-agent-runtime bumped to 1.51.139

## [2.76.0](https://github.com/okou-ai/okou/compare/api-v2.75.1...api-v2.76.0) (2026-11-16)


### Features

* **api:** add dedicated reward receipt lookup ([#47848](https://github.com/okou-ai/okou/issues/47848)) ([fcc0ab8](https://github.com/okou-ai/okou/commit/fcc0ab87f7cdde80581b8b496f1689585f5c0ac9))


### Bug Fixes

* make system updates configurable ([#47882](https://github.com/okou-ai/okou/issues/47882)) ([f1bf918](https://github.com/okou-ai/okou/commit/f1bf918e9c3d2033a956b51a8bcb3ee0ad77cb3c))


### Refactoring

* **api:** consolidate execution admission facts ([#47899](https://github.com/okou-ai/okou/issues/47899)) ([270a932](https://github.com/okou-ai/okou/commit/270a932913e030a8d3628889d04d7a11ff213761))
* **api:** consume captured execution inputs directly ([#47885](https://github.com/okou-ai/okou/issues/47885)) ([e761a45](https://github.com/okou-ai/okou/commit/e761a45ea5a1569151e19169b0ab3e0b2accf761))


### Performance Improvements

* **api:** trim run preparation credential and template projections ([#47886](https://github.com/okou-ai/okou/issues/47886)) ([7daca56](https://github.com/okou-ai/okou/commit/7daca560b2b79e6d1722b9b599fa715c4d71764d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.74.0
    * @okouai/core bumped to 8.844.2
    * @okouai/db bumped to 2.39.2
    * @okouai/pi-agent-runtime bumped to 1.51.138

## [2.75.1](https://github.com/okou-ai/okou/compare/api-v2.75.0...api-v2.75.1) (2026-11-16)


### Bug Fixes

* **api:** preserve custom connector execution network bindings ([#47836](https://github.com/okou-ai/okou/issues/47836)) ([627c2f0](https://github.com/okou-ai/okou/commit/627c2f06e0b3cd65b8c12c33827ccd94a2796460))
* **browser:** retain native cdp connection diagnostics ([#47833](https://github.com/okou-ai/okou/issues/47833)) ([9b6aa42](https://github.com/okou-ai/okou/commit/9b6aa42b138c34b2ccef2044be78443dd4e4b602))


### Refactoring

* **api:** make direct execution thread-bound ([#47827](https://github.com/okou-ai/okou/issues/47827)) ([814d333](https://github.com/okou-ai/okou/commit/814d3333573251f72d46132bb58d3606276c845e))


### Performance Improvements

* **api:** reuse custom connector runtime builds and narrow execution fields ([#47828](https://github.com/okou-ai/okou/issues/47828)) ([d728e34](https://github.com/okou-ai/okou/commit/d728e349bddd5c4f5e991a7c9403034a4067d8fa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/browser-extension-client bumped to 0.4.5
    * @okouai/core bumped to 8.844.1
    * @okouai/db bumped to 2.39.1
    * @okouai/pi-agent-runtime bumped to 1.51.137

## [2.75.0](https://github.com/okou-ai/okou/compare/api-v2.74.0...api-v2.75.0) (2026-11-16)


### Features

* add for you source preferences and unread indicators ([#47771](https://github.com/okou-ai/okou/issues/47771)) ([5d3bca3](https://github.com/okou-ai/okou/commit/5d3bca33002b020ebed8d8a0d379777fb1c542b8))
* **api:** add read-only reward history export ([#47764](https://github.com/okou-ai/okou/issues/47764)) ([3a0c748](https://github.com/okou-ai/okou/commit/3a0c748549d997794f364d03486610476f60881e))


### Bug Fixes

* **suggestions:** verify user identity in third-party sources ([#47812](https://github.com/okou-ai/okou/issues/47812)) ([3dcd0c8](https://github.com/okou-ai/okou/commit/3dcd0c8e27b7ae1dbce309bf71c943d613b3f89f))
* use registry guide for presentation templates ([#47810](https://github.com/okou-ai/okou/issues/47810)) ([c38e98e](https://github.com/okou-ai/okou/commit/c38e98ea3b0f4527f492d42a6c342399e803ba4e))


### Refactoring

* prepare structured run failures and recovery ([#47749](https://github.com/okou-ai/okou/issues/47749)) ([fca7335](https://github.com/okou-ai/okou/commit/fca73354c6b5b0aa4f122e78947565b274323991))
* remove integration model recovery feature switch ([#47814](https://github.com/okou-ai/okou/issues/47814)) ([42f602a](https://github.com/okou-ai/okou/commit/42f602a3099b330cd59ef01fc389c43d3f067840))


### Performance Improvements

* **api:** remove unused runtime preparation work ([#47775](https://github.com/okou-ai/okou/issues/47775)) ([61305ba](https://github.com/okou-ai/okou/commit/61305bacbf5293ab0e579eb104a5df183c7eef8d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.73.0
    * @okouai/core bumped to 8.844.0
    * @okouai/db bumped to 2.39.0
    * @okouai/pi-agent-runtime bumped to 1.51.136

## [2.74.0](https://github.com/okou-ai/okou/compare/api-v2.73.2...api-v2.74.0) (2026-11-16)


### Features

* replace the notification bell with platform feed events ([#47711](https://github.com/okou-ai/okou/issues/47711)) ([b5aac15](https://github.com/okou-ai/okou/commit/b5aac15af841802f580b268f27cfce7539cb9269))


### Bug Fixes

* **api:** read android release manifest directly from r2 ([#47755](https://github.com/okou-ai/okou/issues/47755)) ([5baac71](https://github.com/okou-ai/okou/commit/5baac71439dde57bde5d4608c30ed716d05beaa4))


### Refactoring

* **api:** require captured thread continuation for launch ([#47754](https://github.com/okou-ai/okou/issues/47754)) ([ad8cca4](https://github.com/okou-ai/okou/commit/ad8cca4bb9a3d3db47bd8852201b8d6c3cfd17e7))


### Performance Improvements

* **api:** separate connector selection from execution hydration ([#47700](https://github.com/okou-ai/okou/issues/47700)) ([32083e3](https://github.com/okou-ai/okou/commit/32083e3260413e2c831e88840900a98d5c05ead2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.72.0
    * @okouai/core bumped to 8.843.0
    * @okouai/db bumped to 2.38.0
    * @okouai/pi-agent-runtime bumped to 1.51.135

## [2.73.2](https://github.com/okou-ai/okou/compare/api-v2.73.1...api-v2.73.2) (2026-11-16)


### Refactoring

* **api:** remove thread launch request scaffolding ([#47688](https://github.com/okou-ai/okou/issues/47688)) ([073f49e](https://github.com/okou-ai/okou/commit/073f49ed8937a60f9b840bbf30e71cf1e406a0cf))

## [2.73.1](https://github.com/okou-ai/okou/compare/api-v2.73.0...api-v2.73.1) (2026-11-16)


### Bug Fixes

* cap connector rewards at ten per user ([#47699](https://github.com/okou-ai/okou/issues/47699)) ([8093612](https://github.com/okou-ai/okou/commit/8093612f536b8d3e8d5920fa9ed0a7583a29f80b))
* **integrations:** add native model recovery controls ([#47649](https://github.com/okou-ai/okou/issues/47649)) ([89c954e](https://github.com/okou-ai/okou/commit/89c954ec0e6a6408cac0f1ad960074b2d7fbdf24))
* redeem onboarding codes for existing free workspaces ([#47701](https://github.com/okou-ai/okou/issues/47701)) ([92e7bd7](https://github.com/okou-ai/okou/commit/92e7bd7fdafe3afa458b39b57c148faf66cdebec))
* require phone use opt-in and authorize access from chat ([#47650](https://github.com/okou-ai/okou/issues/47650)) ([d99b85b](https://github.com/okou-ai/okou/commit/d99b85b2a06c635ca25fa93b9f6a0fc66b55b276))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.71.1
    * @okouai/core bumped to 8.842.1
    * @okouai/db bumped to 2.37.1
    * @okouai/pi-agent-runtime bumped to 1.51.134

## [2.73.0](https://github.com/okou-ai/okou/compare/api-v2.72.2...api-v2.73.0) (2026-11-16)


### Features

* **run:** add opt-in artifact phase timing ([#47655](https://github.com/okou-ai/okou/issues/47655)) ([3e71f58](https://github.com/okou-ai/okou/commit/3e71f58b819fe638d46df9ecb8596fef07ddf88f))


### Bug Fixes

* **browser:** retain native phases for health check timeouts ([#47642](https://github.com/okou-ai/okou/issues/47642)) ([e2a51a4](https://github.com/okou-ai/okou/commit/e2a51a46b092bf79711e071b5b6cf0163a0bc1bd))


### Refactoring

* **memory:** isolate selection and writeback boundaries ([#47062](https://github.com/okou-ai/okou/issues/47062)) ([596a752](https://github.com/okou-ai/okou/commit/596a752a9a328ec8fe3310e00de6b581e3d95c5e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.71.0
    * @okouai/core bumped to 8.842.0
    * @okouai/db bumped to 2.37.0
    * @okouai/pi-agent-runtime bumped to 1.51.133

## [2.72.2](https://github.com/okou-ai/okou/compare/api-v2.72.1...api-v2.72.2) (2026-11-16)


### Refactoring

* **api:** remove retired run creation contracts ([#47651](https://github.com/okou-ai/okou/issues/47651)) ([80a55d8](https://github.com/okou-ai/okou/commit/80a55d8e2cece736c0b0dafbee86bd520e388222))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.70.1
    * @okouai/core bumped to 8.841.1
    * @okouai/db bumped to 2.36.2
    * @okouai/pi-agent-runtime bumped to 1.51.132

## [2.72.1](https://github.com/okou-ai/okou/compare/api-v2.72.0...api-v2.72.1) (2026-11-16)


### Bug Fixes

* **api:** exclude credential-bearing telegram telemetry ([#47631](https://github.com/okou-ai/okou/issues/47631)) ([8e7d060](https://github.com/okou-ai/okou/commit/8e7d060ab09a55976b308e2ca2339138d58d2a23))
* **wallet:** accept saved cards without deprecated expiry ([#47627](https://github.com/okou-ai/okou/issues/47627)) ([7a14ea6](https://github.com/okou-ai/okou/commit/7a14ea67b62610689337040be952f906090dc589))


### Refactoring

* **api:** prepare runner launches from captured facts ([#47619](https://github.com/okou-ai/okou/issues/47619)) ([7036d6a](https://github.com/okou-ai/okou/commit/7036d6a979114f3f948273ec7e8512df612c0ee7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.70.0
    * @okouai/core bumped to 8.841.0
    * @okouai/db bumped to 2.36.1
    * @okouai/pi-agent-runtime bumped to 1.51.131

## [2.72.0](https://github.com/okou-ai/okou/compare/api-v2.71.3...api-v2.72.0) (2026-11-16)


### Features

* add internal phone use api and cli ([#47520](https://github.com/okou-ai/okou/issues/47520)) ([e6491e5](https://github.com/okou-ai/okou/commit/e6491e5c74670fcdb572681e652c08576136bd19))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.69.0
    * @okouai/core bumped to 8.840.0
    * @okouai/db bumped to 2.36.0
    * @okouai/pi-agent-runtime bumped to 1.51.130

## [2.71.3](https://github.com/okou-ai/okou/compare/api-v2.71.2...api-v2.71.3) (2026-11-16)


### Refactoring

* **api:** build thread runs from captured facts ([#47527](https://github.com/okou-ai/okou/issues/47527)) ([000faf2](https://github.com/okou-ai/okou/commit/000faf251cb92c4bbe839c7f6b8e3740cbc063b3))

## [2.71.2](https://github.com/okou-ai/okou/compare/api-v2.71.1...api-v2.71.2) (2026-11-16)


### Refactoring

* **api:** consume captured thread model facts directly ([#47521](https://github.com/okou-ai/okou/issues/47521)) ([255d21b](https://github.com/okou-ai/okou/commit/255d21bb235928727f48e778e009bb998b7a9bb1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.68.0
    * @okouai/core bumped to 8.839.7
    * @okouai/db bumped to 2.35.11
    * @okouai/pi-agent-runtime bumped to 1.51.129

## [2.71.1](https://github.com/okou-ai/okou/compare/api-v2.71.0...api-v2.71.1) (2026-11-15)


### Refactoring

* **api:** require captured thread launch inputs ([#47486](https://github.com/okou-ai/okou/issues/47486)) ([0c5a0db](https://github.com/okou-ai/okou/commit/0c5a0dbb256f4d1c578fe4ce255522f961ce832a))

## [2.71.0](https://github.com/okou-ai/okou/compare/api-v2.70.8...api-v2.71.0) (2026-11-15)


### Features

* **android:** add native apk update and recovery flows ([#47331](https://github.com/okou-ai/okou/issues/47331)) ([c9d9bdb](https://github.com/okou-ai/okou/commit/c9d9bdb0c7a3affbfc4f0a3910a1eb22cbeddf21))


### Refactoring

* **api:** align launch preparation with current consumers ([#47419](https://github.com/okou-ai/okou/issues/47419)) ([52f57b4](https://github.com/okou-ai/okou/commit/52f57b4fbdb3d7c0f03cd069b119ce627c393718))
* **api:** derive thread admission from current sources ([#47449](https://github.com/okou-ai/okou/issues/47449)) ([5a86554](https://github.com/okou-ai/okou/commit/5a865546b211d24a8afbf4dd7859393294a791e4))
* **api:** flatten thread claim graph dependencies ([#47483](https://github.com/okou-ai/okou/issues/47483)) ([0a3791e](https://github.com/okou-ai/okou/commit/0a3791ee588dcf6739a688a6caa01e57f077de11))
* **api:** simplify current launch preparation ([#47387](https://github.com/okou-ai/okou/issues/47387)) ([29f1322](https://github.com/okou-ai/okou/commit/29f132228d5837cf420c185528735903453ab24a))
* **runner:** finish execution input and timing cleanup ([#47356](https://github.com/okou-ai/okou/issues/47356)) ([4b7190a](https://github.com/okou-ai/okou/commit/4b7190afbe6ae6571dbfcf6f122573891065937b))
* **runner:** finish native execution model cleanup ([#47328](https://github.com/okou-ai/okou/issues/47328)) ([d4f131f](https://github.com/okou-ai/okou/commit/d4f131fab3253a843b49afaf4589afa043c8ce13))
* **runner:** model direct execution without claim scaffolding ([#47235](https://github.com/okou-ai/okou/issues/47235)) ([8bf20fb](https://github.com/okou-ai/okou/commit/8bf20fb75b2788038d699332435a84e551660c49))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.67.0
    * @okouai/core bumped to 8.839.6
    * @okouai/db bumped to 2.35.10
    * @okouai/pi-agent-runtime bumped to 1.51.128

## [2.70.8](https://github.com/okou-ai/okou/compare/api-v2.70.7...api-v2.70.8) (2026-11-14)


### Refactoring

* **api:** stop accepting the retired chat resources preference write ([#47299](https://github.com/okou-ai/okou/issues/47299)) ([c2fbb97](https://github.com/okou-ai/okou/commit/c2fbb97cd4c674b73720b375573bd592e7ee7f77))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.66.0
    * @okouai/core bumped to 8.839.5
    * @okouai/db bumped to 2.35.9
    * @okouai/pi-agent-runtime bumped to 1.51.127

## [2.70.7](https://github.com/okou-ai/okou/compare/api-v2.70.6...api-v2.70.7) (2026-11-14)


### Bug Fixes

* **api:** read office guidance directly from github ([#47229](https://github.com/okou-ai/okou/issues/47229)) ([aeb78a9](https://github.com/okou-ai/okou/commit/aeb78a9fcea8e2f5366b30ca249a9cb504c134e7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.65.0
    * @okouai/core bumped to 8.839.4
    * @okouai/db bumped to 2.35.8
    * @okouai/pi-agent-runtime bumped to 1.51.126

## [2.70.6](https://github.com/okou-ai/okou/compare/api-v2.70.5...api-v2.70.6) (2026-11-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.35.7

## [2.70.5](https://github.com/okou-ai/okou/compare/api-v2.70.4...api-v2.70.5) (2026-11-14)


### Refactoring

* **api:** remove legacy runner acquisition and queue readers ([#47138](https://github.com/okou-ai/okou/issues/47138)) ([50c5853](https://github.com/okou-ai/okou/commit/50c5853b53188770b588d3f8a3df267830d295a3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.64.0
    * @okouai/core bumped to 8.839.3
    * @okouai/db bumped to 2.35.6
    * @okouai/pi-agent-runtime bumped to 1.51.125

## [2.70.4](https://github.com/okou-ai/okou/compare/api-v2.70.3...api-v2.70.4) (2026-11-14)


### Bug Fixes

* **api:** retire selection endpoints after ios 0.43.3 release ([#47146](https://github.com/okou-ai/okou/issues/47146)) ([bcca359](https://github.com/okou-ai/okou/commit/bcca359a055c278064b113aa7648572539eae72b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.63.2
    * @okouai/core bumped to 8.839.2
    * @okouai/db bumped to 2.35.5
    * @okouai/pi-agent-runtime bumped to 1.51.124

## [2.70.3](https://github.com/okou-ai/okou/compare/api-v2.70.2...api-v2.70.3) (2026-11-14)


### Bug Fixes

* **ios:** match existing web chat sharing behavior ([#47105](https://github.com/okou-ai/okou/issues/47105)) ([e25ad70](https://github.com/okou-ai/okou/commit/e25ad705a20e4cf55d75ade9c6dd7c0a9d45d0e5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.63.1
    * @okouai/core bumped to 8.839.1
    * @okouai/db bumped to 2.35.4
    * @okouai/pi-agent-runtime bumped to 1.51.123

## [2.70.2](https://github.com/okou-ai/okou/compare/api-v2.70.1...api-v2.70.2) (2026-11-14)


### Refactoring

* **browser:** enforce native connections and retire viewer endpoint ([#47114](https://github.com/okou-ai/okou/issues/47114)) ([78e6915](https://github.com/okou-ai/okou/commit/78e6915a86aad95ad10b91b3552adc49328a2c42))
* **browser:** remove obsolete mode boundaries ([#47103](https://github.com/okou-ai/okou/issues/47103)) ([a3f1c8f](https://github.com/okou-ai/okou/commit/a3f1c8fe3916e1751339b0e7b23ab602e2670dfd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.63.0
    * @okouai/core bumped to 8.839.0
    * @okouai/db bumped to 2.35.3
    * @okouai/pi-agent-runtime bumped to 1.51.122

## [2.70.1](https://github.com/okou-ai/okou/compare/api-v2.70.0...api-v2.70.1) (2026-11-13)


### Refactoring

* **billing:** remove retired custom plan contracts ([#47020](https://github.com/okou-ai/okou/issues/47020)) ([84cfbb9](https://github.com/okou-ai/okou/commit/84cfbb9a93416818bc36ed5fa1645e1db3a31571))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.62.1
    * @okouai/core bumped to 8.838.0
    * @okouai/db bumped to 2.35.2
    * @okouai/pi-agent-runtime bumped to 1.51.121

## [2.70.0](https://github.com/okou-ai/okou/compare/api-v2.69.0...api-v2.70.0) (2026-11-13)


### Features

* align web and ios chat message sharing ([#47059](https://github.com/okou-ai/okou/issues/47059)) ([971a42f](https://github.com/okou-ai/okou/commit/971a42fa47c06591adb653265a8ce4055c40b266))


### Refactoring

* **browser:** retire legacy maintenance and screenshot paths ([#47064](https://github.com/okou-ai/okou/issues/47064)) ([8a47781](https://github.com/okou-ai/okou/commit/8a4778115a65b2badff828d20d1857294d1b4881))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.62.0
    * @okouai/core bumped to 8.837.0
    * @okouai/db bumped to 2.35.1
    * @okouai/pi-agent-runtime bumped to 1.51.120

## [2.69.0](https://github.com/okou-ai/okou/compare/api-v2.68.0...api-v2.69.0) (2026-11-13)


### Features

* introduce typed feed items under suggestions rollout ([#47053](https://github.com/okou-ai/okou/issues/47053)) ([e052b90](https://github.com/okou-ai/okou/commit/e052b90b3ed950ce46c7fc51235e87c1c3034164))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.61.0
    * @okouai/core bumped to 8.836.2
    * @okouai/db bumped to 2.35.0
    * @okouai/pi-agent-runtime bumped to 1.51.119

## [2.68.0](https://github.com/okou-ai/okou/compare/api-v2.67.8...api-v2.68.0) (2026-11-13)


### Features

* **api:** dispatch complete run inputs without queue persistence ([#46910](https://github.com/okou-ai/okou/issues/46910)) ([4862caf](https://github.com/okou-ai/okou/commit/4862caf28ec28fa86c88f0f66d8634a1598c6a06))


### Bug Fixes

* **api:** page hyperdrive inventory before reconciling workers ([#47061](https://github.com/okou-ai/okou/issues/47061)) ([358190b](https://github.com/okou-ai/okou/commit/358190b01ea5e2b83144fd0ad9b33a8ebeaa2044))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.60.0
    * @okouai/core bumped to 8.836.1
    * @okouai/db bumped to 2.34.6
    * @okouai/pi-agent-runtime bumped to 1.51.118

## [2.67.8](https://github.com/okou-ai/okou/compare/api-v2.67.7...api-v2.67.8) (2026-11-13)


### Refactoring

* **billing:** retire atom and custom plan issuance ([#47016](https://github.com/okou-ai/okou/issues/47016)) ([d193291](https://github.com/okou-ai/okou/commit/d193291916805888cf1f4952e249d65021f642b4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.59.1
    * @okouai/core bumped to 8.836.0
    * @okouai/db bumped to 2.34.5
    * @okouai/pi-agent-runtime bumped to 1.51.117

## [2.67.7](https://github.com/okou-ai/okou/compare/api-v2.67.6...api-v2.67.7) (2026-11-13)


### Refactoring

* **api:** remove legacy browser country and screen fields ([#46995](https://github.com/okou-ai/okou/issues/46995)) ([d4e7cac](https://github.com/okou-ai/okou/commit/d4e7cac108098cbf988f7e6944f3f24054b5e5d9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.59.0
    * @okouai/core bumped to 8.835.2
    * @okouai/db bumped to 2.34.4
    * @okouai/pi-agent-runtime bumped to 1.51.116

## [2.67.6](https://github.com/okou-ai/okou/compare/api-v2.67.5...api-v2.67.6) (2026-11-13)


### Bug Fixes

* **browser:** commit orphan cleanup one chat at a time ([#46989](https://github.com/okou-ai/okou/issues/46989)) ([d53b8a3](https://github.com/okou-ai/okou/commit/d53b8a3ba9df615e9447d62bf57689e492679a9f))

## [2.67.5](https://github.com/okou-ai/okou/compare/api-v2.67.4...api-v2.67.5) (2026-11-13)


### Bug Fixes

* **connectors:** preserve builtin mcp endpoint queries ([#46959](https://github.com/okou-ai/okou/issues/46959)) ([b82ba36](https://github.com/okou-ai/okou/commit/b82ba3634f5ce631f814989078d2809aaf6b9fa0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.58.1
    * @okouai/connectors bumped to 3.23.1
    * @okouai/core bumped to 8.835.1
    * @okouai/db bumped to 2.34.3
    * @okouai/pi-agent-runtime bumped to 1.51.115

## [2.67.4](https://github.com/okou-ai/okou/compare/api-v2.67.3...api-v2.67.4) (2026-11-13)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.835.0
    * @okouai/db bumped to 2.34.2
    * @okouai/pi-agent-runtime bumped to 1.51.114

## [2.67.3](https://github.com/okou-ai/okou/compare/api-v2.67.2...api-v2.67.3) (2026-11-13)


### Bug Fixes

* **api:** require ios clients to upgrade to 0.39.0 ([#46947](https://github.com/okou-ai/okou/issues/46947)) ([aee6838](https://github.com/okou-ai/okou/commit/aee6838bdbaef0b811e31b2e1d980d6bdc441279))

## [2.67.2](https://github.com/okou-ai/okou/compare/api-v2.67.1...api-v2.67.2) (2026-11-13)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.58.0
    * @okouai/core bumped to 8.834.2
    * @okouai/db bumped to 2.34.1
    * @okouai/pi-agent-runtime bumped to 1.51.113

## [2.67.1](https://github.com/okou-ai/okou/compare/api-v2.67.0...api-v2.67.1) (2026-11-13)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.57.0
    * @okouai/core bumped to 8.834.1
    * @okouai/db bumped to 2.34.0
    * @okouai/pi-agent-runtime bumped to 1.51.112

## [2.67.0](https://github.com/okou-ai/okou/compare/api-v2.66.0...api-v2.67.0) (2026-11-12)


### Features

* **browser:** graduate shared browser and remove rollout switch ([#46833](https://github.com/okou-ai/okou/issues/46833)) ([e50e38e](https://github.com/okou-ai/okou/commit/e50e38e284b2e310198bf8f96cc0c44cd3752001))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.56.0
    * @okouai/core bumped to 8.834.0
    * @okouai/db bumped to 2.33.1
    * @okouai/pi-agent-runtime bumped to 1.51.111

## [2.66.0](https://github.com/okou-ai/okou/compare/api-v2.65.0...api-v2.66.0) (2026-11-12)


### Features

* **remote-control:** approve vnc chat access from message cards ([#46844](https://github.com/okou-ai/okou/issues/46844)) ([068dd05](https://github.com/okou-ai/okou/commit/068dd0513427864c4469e7c4b05d4e42dacf5841))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.55.0
    * @okouai/core bumped to 8.833.0
    * @okouai/db bumped to 2.33.0
    * @okouai/pi-agent-runtime bumped to 1.51.110

## [2.65.0](https://github.com/okou-ai/okou/compare/api-v2.64.0...api-v2.65.0) (2026-11-12)


### Features

* **connectors:** enforce cloudflare access for custom http and mcp ([#46635](https://github.com/okou-ai/okou/issues/46635)) ([e31b757](https://github.com/okou-ai/okou/commit/e31b757de380ca9e2a659dc5630872bd2d4e85c4))
* prepare readers for staff single agent workflow copies ([#46786](https://github.com/okou-ai/okou/issues/46786)) ([eddbe0f](https://github.com/okou-ai/okou/commit/eddbe0f4edae253b6a9240e0f312f25b36acad5b))


### Refactoring

* **api:** remove unused storage cache lookup bookkeeping ([#46820](https://github.com/okou-ai/okou/issues/46820)) ([59a53f7](https://github.com/okou-ai/okou/commit/59a53f7bb201a19d2031a5bb791c55ad947f60ab))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.54.0
    * @okouai/connectors bumped to 3.23.0
    * @okouai/core bumped to 8.832.0
    * @okouai/db bumped to 2.32.0
    * @okouai/pi-agent-runtime bumped to 1.51.109

## [2.64.0](https://github.com/okou-ai/okou/compare/api-v2.63.0...api-v2.64.0) (2026-11-12)


### Features

* add email workspace binding commands ([#46756](https://github.com/okou-ai/okou/issues/46756)) ([79b09c6](https://github.com/okou-ai/okou/commit/79b09c6f37978f2124b39912b743384cfc16fdb4))
* **runner:** restore caddy ingress with startup health validation ([#46655](https://github.com/okou-ai/okou/issues/46655)) ([d2c31a2](https://github.com/okou-ai/okou/commit/d2c31a2eed677380c6f3ecc6b3c15df490d5031b))


### Bug Fixes

* adapt welcome and connector copy to my okou ([#46760](https://github.com/okou-ai/okou/issues/46760)) ([369db8a](https://github.com/okou-ai/okou/commit/369db8a0df2e4546bc35a03cf9ec1ba701e4dc55))
* allow unlinking the login email integration ([#46749](https://github.com/okou-ai/okou/issues/46749)) ([d6f52fc](https://github.com/okou-ai/okou/commit/d6f52fcb2b01ba376fd83e41b4f2494a264f2567))
* **api:** provide the official office skill source ([#46765](https://github.com/okou-ai/okou/issues/46765)) ([180d511](https://github.com/okou-ai/okou/commit/180d511e6658aa4971ccbd926e6b20efd9ee3d44))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.53.0
    * @okouai/core bumped to 8.831.1
    * @okouai/db bumped to 2.31.0
    * @okouai/pi-agent-runtime bumped to 1.51.108

## [2.63.0](https://github.com/okou-ai/okou/compare/api-v2.62.0...api-v2.63.0) (2026-11-12)


### Features

* **billing:** ask one-question surveys at the paywall and abandoned checkout ([#46373](https://github.com/okou-ai/okou/issues/46373)) ([dba1a1b](https://github.com/okou-ai/okou/commit/dba1a1be581f3310df718f62f1b4813a96a3e780))


### Bug Fixes

* **api:** resolve email senders through connected mailbox workspaces ([#46753](https://github.com/okou-ai/okou/issues/46753)) ([ee21036](https://github.com/okou-ai/okou/commit/ee210363a32e1e5e2ff5a5d2d40800b2f4925a6a))
* **email:** align thread context formatting with slack ([#46748](https://github.com/okou-ai/okou/issues/46748)) ([d37ea27](https://github.com/okou-ai/okou/commit/d37ea27b50055c2575051cd51d1abc041ecbb8e9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.52.0
    * @okouai/core bumped to 8.831.0
    * @okouai/db bumped to 2.30.0
    * @okouai/pi-agent-runtime bumped to 1.51.107

## [2.62.0](https://github.com/okou-ai/okou/compare/api-v2.61.2...api-v2.62.0) (2026-11-12)


### Features

* **android:** add generated api transport and release compatibility ([#46666](https://github.com/okou-ai/okou/issues/46666)) ([2898887](https://github.com/okou-ai/okou/commit/2898887d268ba4efdec8b7bbffdf6a93a9de7490))


### Bug Fixes

* **api:** remove desktop notification disconnect warning ([#46737](https://github.com/okou-ai/okou/issues/46737)) ([e27cfc3](https://github.com/okou-ai/okou/commit/e27cfc30dd86da43ec791718f1cb061e2d65bc68))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.51.0
    * @okouai/core bumped to 8.830.0
    * @okouai/db bumped to 2.29.3
    * @okouai/pi-agent-runtime bumped to 1.51.106

## [2.61.2](https://github.com/okou-ai/okou/compare/api-v2.61.1...api-v2.61.2) (2026-11-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.829.3
    * @okouai/db bumped to 2.29.2
    * @okouai/pi-agent-runtime bumped to 1.51.105

## [2.61.1](https://github.com/okou-ai/okou/compare/api-v2.61.0...api-v2.61.1) (2026-11-12)


### Bug Fixes

* **api:** restrict suggestion feedback to morning brief and suggestions ([#46716](https://github.com/okou-ai/okou/issues/46716)) ([b2811f1](https://github.com/okou-ai/okou/commit/b2811f1d0f3bf75fc1d8f1f37f75b6fbefd92411))
* **email:** include prior mailbox thread context ([#46715](https://github.com/okou-ai/okou/issues/46715)) ([2795388](https://github.com/okou-ai/okou/commit/2795388ea2500176bfb42af138e5fe791889c758))
* normalize skill attachment paths and skip failed uploads ([#46689](https://github.com/okou-ai/okou/issues/46689)) ([bb76f65](https://github.com/okou-ai/okou/commit/bb76f65a44e7ec385eef81e1201f46bf4c91e419))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.50.2
    * @okouai/core bumped to 8.829.2
    * @okouai/db bumped to 2.29.1
    * @okouai/pi-agent-runtime bumped to 1.51.104

## [2.61.0](https://github.com/okou-ai/okou/compare/api-v2.60.0...api-v2.61.0) (2026-11-11)


### Features

* **api:** add correlated chat enqueue phase timings ([#46625](https://github.com/okou-ai/okou/issues/46625)) ([896077c](https://github.com/okou-ai/okou/commit/896077c837a2fda2c157533946a2ab300a500593))


### Refactoring

* **api:** remove unused run volume override inputs ([#46627](https://github.com/okou-ai/okou/issues/46627)) ([d6e2b91](https://github.com/okou-ai/okou/commit/d6e2b918d7b052620e365fd90651c5a6ae46e188))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.50.1
    * @okouai/core bumped to 8.829.1
    * @okouai/db bumped to 2.29.0
    * @okouai/pi-agent-runtime bumped to 1.51.103

## [2.60.0](https://github.com/okou-ai/okou/compare/api-v2.59.2...api-v2.60.0) (2026-11-11)


### Features

* **connectors:** prepare organization cloudflare access bindings ([#46562](https://github.com/okou-ai/okou/issues/46562)) ([25ec802](https://github.com/okou-ai/okou/commit/25ec8029d50d1392c508fa4355fcbbbce439ad27))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.50.0
    * @okouai/connectors bumped to 3.22.0
    * @okouai/core bumped to 8.829.0
    * @okouai/db bumped to 2.28.0
    * @okouai/pi-agent-runtime bumped to 1.51.102

## [2.59.2](https://github.com/okou-ai/okou/compare/api-v2.59.1...api-v2.59.2) (2026-11-11)


### Bug Fixes

* **api:** route event flyers to the dedicated skill ([#46567](https://github.com/okou-ai/okou/issues/46567)) ([00cbcc7](https://github.com/okou-ai/okou/commit/00cbcc7a5be376000e80535a2fa4fa8bc4ac3b85))
* **email:** align enriched message context with slack ([#46542](https://github.com/okou-ai/okou/issues/46542)) ([fda06e0](https://github.com/okou-ai/okou/commit/fda06e0f66824a2b7657b22ea9c8b4399631c6cb))
* **memory:** merge concurrent run changes before publication ([#46529](https://github.com/okou-ai/okou/issues/46529)) ([fef343e](https://github.com/okou-ai/okou/commit/fef343edcb076caa33115a724820f5e5c2faf83c))


### Refactoring

* **api:** remove unreachable captured storage preparation ([#46569](https://github.com/okou-ai/okou/issues/46569)) ([dca259d](https://github.com/okou-ai/okou/commit/dca259d8ffb725ebf80c0837dc9f19f60e4e142e))
* remove mercuryConnector feature switch ([#46576](https://github.com/okou-ai/okou/issues/46576)) ([2f848b1](https://github.com/okou-ai/okou/commit/2f848b148ae68294a462925699420763682bd086))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.49.1
    * @okouai/core bumped to 8.828.1
    * @okouai/db bumped to 2.27.1
    * @okouai/pi-agent-runtime bumped to 1.51.101

## [2.59.1](https://github.com/okou-ai/okou/compare/api-v2.59.0...api-v2.59.1) (2026-11-11)


### Bug Fixes

* **email:** allow resend cdn attachment downloads ([#46548](https://github.com/okou-ai/okou/issues/46548)) ([d37f02d](https://github.com/okou-ai/okou/commit/d37f02da66990f4d03226b6932232c4c707243d3))

## [2.59.0](https://github.com/okou-ai/okou/compare/api-v2.58.0...api-v2.59.0) (2026-11-11)


### Features

* **ssh:** approve chat host access from message cards ([#46522](https://github.com/okou-ai/okou/issues/46522)) ([e2ffb56](https://github.com/okou-ai/okou/commit/e2ffb56490b707b96cd6af58b82aaa8e6bc7711c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.49.0
    * @okouai/core bumped to 8.828.0
    * @okouai/db bumped to 2.27.0
    * @okouai/pi-agent-runtime bumped to 1.51.100

## [2.58.0](https://github.com/okou-ai/okou/compare/api-v2.57.3...api-v2.58.0) (2026-11-11)


### Features

* add meeting notes to document templates ([#46428](https://github.com/okou-ai/okou/issues/46428)) ([821606a](https://github.com/okou-ai/okou/commit/821606a3d093f8d51d0c39834acccc4a232329d2))


### Bug Fixes

* **api:** silently skip deleted chat snapshot candidates ([#46499](https://github.com/okou-ai/okou/issues/46499)) ([1e55f00](https://github.com/okou-ai/okou/commit/1e55f00a05f7a6fe60fb7ed6440d75e3f1fe906e))


### Performance Improvements

* **api:** remove the chat search time filter ([#46502](https://github.com/okou-ai/okou/issues/46502)) ([baa9594](https://github.com/okou-ai/okou/commit/baa95943ef45870b92855b3974772657ca2b6711))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.48.3
    * @okouai/core bumped to 8.827.0
    * @okouai/db bumped to 2.26.1
    * @okouai/pi-agent-runtime bumped to 1.51.99

## [2.57.3](https://github.com/okou-ai/okou/compare/api-v2.57.2...api-v2.57.3) (2026-11-11)


### Bug Fixes

* **api:** discover oauth after public mcp initialization ([#46422](https://github.com/okou-ai/okou/issues/46422)) ([9142ab9](https://github.com/okou-ai/okou/commit/9142ab9ffdf3407d25100ee50ae884841374c1c2))
* **api:** let owners maintain public workflows ([#46438](https://github.com/okou-ai/okou/issues/46438)) ([9259d92](https://github.com/okou-ai/okou/commit/9259d92721466cf27c0ab86006b740b16862b5eb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.48.2
    * @okouai/core bumped to 8.826.2
    * @okouai/db bumped to 2.26.0
    * @okouai/pi-agent-runtime bumped to 1.51.98

## [2.57.2](https://github.com/okou-ai/okou/compare/api-v2.57.1...api-v2.57.2) (2026-11-10)


### Bug Fixes

* **api:** allow verified memory cache cleanup across runs ([#46461](https://github.com/okou-ai/okou/issues/46461)) ([0122027](https://github.com/okou-ai/okou/commit/0122027f0fee256b8d439891ed3435304aeb2aa3))


### Performance Improvements

* **api:** reuse claim catalog and permission inputs ([#46454](https://github.com/okou-ai/okou/issues/46454)) ([46f2ac7](https://github.com/okou-ai/okou/commit/46f2ac7fd9056b0c3ffd59f611381dbf7d3092a2))

## [2.57.1](https://github.com/okou-ai/okou/compare/api-v2.57.0...api-v2.57.1) (2026-11-10)


### Refactoring

* **api:** persist only irrecoverable execution inputs ([#46382](https://github.com/okou-ai/okou/issues/46382)) ([cee3bd3](https://github.com/okou-ai/okou/commit/cee3bd3b92c6d8b28bde8da1dd81876ee144b811))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.48.1
    * @okouai/core bumped to 8.826.1
    * @okouai/db bumped to 2.25.1
    * @okouai/pi-agent-runtime bumped to 1.51.97

## [2.57.0](https://github.com/okou-ai/okou/compare/api-v2.56.0...api-v2.57.0) (2026-11-10)


### Features

* add workflow and email follow-up suggestions ([#46409](https://github.com/okou-ai/okou/issues/46409)) ([dcd6403](https://github.com/okou-ai/okou/commit/dcd6403fd62681e52300224fa020d8c7b9f443d2))
* **email:** support multiple workspace sender connections ([#46296](https://github.com/okou-ai/okou/issues/46296)) ([f9761e3](https://github.com/okou-ai/okou/commit/f9761e3378b4a881a28d855962f8d87199b6a5d1))
* **notifications:** notify owners when schedules are auto-disabled ([#46353](https://github.com/okou-ai/okou/issues/46353)) ([dbe6412](https://github.com/okou-ai/okou/commit/dbe6412be838f46e3200b9998358fb120f386dbb))


### Bug Fixes

* **email:** clarify workspace connection and show success toast ([#46399](https://github.com/okou-ai/okou/issues/46399)) ([321c716](https://github.com/okou-ai/okou/commit/321c7160da2c7a4156d5151c1d1639e99ef984bd))


### Refactoring

* **api:** prepare explicit preview bypass authorization receipt ([#46400](https://github.com/okou-ai/okou/issues/46400)) ([4c98de8](https://github.com/okou-ai/okou/commit/4c98de8a0ad8e8230a27c248ddc1534360646d33))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.48.0
    * @okouai/core bumped to 8.826.0
    * @okouai/db bumped to 2.25.0
    * @okouai/pi-agent-runtime bumped to 1.51.96

## [2.56.0](https://github.com/okou-ai/okou/compare/api-v2.55.7...api-v2.56.0) (2026-11-10)


### Features

* **email:** register new senders through confirmed replies ([#46356](https://github.com/okou-ai/okou/issues/46356)) ([0c64db3](https://github.com/okou-ai/okou/commit/0c64db344440e3507b033e9478b5944451575d3d))


### Bug Fixes

* **api:** admit useful delegable suggestions ([#46378](https://github.com/okou-ai/okou/issues/46378)) ([bd8efe4](https://github.com/okou-ai/okou/commit/bd8efe4f4182fc3498bc80e1cf4a72bb1a26136f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.24.14

## [2.55.7](https://github.com/okou-ai/okou/compare/api-v2.55.6...api-v2.55.7) (2026-11-10)


### Bug Fixes

* **api:** retain original artifact links in email replies ([#46344](https://github.com/okou-ai/okou/issues/46344)) ([6a3a684](https://github.com/okou-ai/okou/commit/6a3a684ce2af76d050f6a6365f02a569629707f7))
* **email:** add thread context and message source labels ([#46348](https://github.com/okou-ai/okou/issues/46348)) ([c25e9f1](https://github.com/okou-ai/okou/commit/c25e9f1e62bfa7a1b557ac5bcc770ddbb5821ded))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.47.0
    * @okouai/core bumped to 8.825.5
    * @okouai/db bumped to 2.24.13
    * @okouai/pi-agent-runtime bumped to 1.51.95

## [2.55.6](https://github.com/okou-ai/okou/compare/api-v2.55.5...api-v2.55.6) (2026-11-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.46.4
    * @okouai/core bumped to 8.825.4
    * @okouai/db bumped to 2.24.12
    * @okouai/pi-agent-runtime bumped to 1.51.94

## [2.55.5](https://github.com/okou-ai/okou/compare/api-v2.55.4...api-v2.55.5) (2026-11-10)


### Bug Fixes

* **api:** preserve drive upload errors and add safe diagnostics ([#46261](https://github.com/okou-ai/okou/issues/46261)) ([ef6bd89](https://github.com/okou-ai/okou/commit/ef6bd8900402e16b088a7af61c4f57e8d7aefab7))
* preserve handoff session access and recover failed task entry ([#46268](https://github.com/okou-ai/okou/issues/46268)) ([f68a92e](https://github.com/okou-ai/okou/commit/f68a92e1d2838100fcaaa2d7601d1b0338bc7e2a))

## [2.55.4](https://github.com/okou-ai/okou/compare/api-v2.55.3...api-v2.55.4) (2026-11-10)


### Bug Fixes

* **api:** attribute oauth callback failure stages ([#46241](https://github.com/okou-ai/okou/issues/46241)) ([37a7775](https://github.com/okou-ai/okou/commit/37a777587f7e7737bbf1da3ea0830a21c40723a3))
* **api:** validate calendar webhook channel ids ([#46238](https://github.com/okou-ai/okou/issues/46238)) ([1bc2965](https://github.com/okou-ai/okou/commit/1bc29653ab7c5a6bdd9ea88dc4b3f23b88c4771a))


### Refactoring

* **api:** remove unused claude launch overrides ([#46229](https://github.com/okou-ai/okou/issues/46229)) ([5772174](https://github.com/okou-ai/okou/commit/577217495842ffe4b8969b53ed8a6bb07e07dd38))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.46.3
    * @okouai/connectors bumped to 3.21.7
    * @okouai/core bumped to 8.825.3
    * @okouai/db bumped to 2.24.11
    * @okouai/pi-agent-runtime bumped to 1.51.93

## [2.55.3](https://github.com/okou-ai/okou/compare/api-v2.55.2...api-v2.55.3) (2026-11-10)


### Refactoring

* **api:** compact queued runner execution context ([#46198](https://github.com/okou-ai/okou/issues/46198)) ([f6abaa7](https://github.com/okou-ai/okou/commit/f6abaa77353b4c6b6d23ae10aaffa51419f9aed6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.46.2
    * @okouai/core bumped to 8.825.2
    * @okouai/db bumped to 2.24.10
    * @okouai/pi-agent-runtime bumped to 1.51.92

## [2.55.2](https://github.com/okou-ai/okou/compare/api-v2.55.1...api-v2.55.2) (2026-11-09)


### Bug Fixes

* **api:** require ios 0.31.0 or later ([#46186](https://github.com/okou-ai/okou/issues/46186)) ([f75796f](https://github.com/okou-ai/okou/commit/f75796fa0745e3ef000478d9cd62f7307e3ea127))
* **api:** start runner reuse windows after final candidate selection ([#46164](https://github.com/okou-ai/okou/issues/46164)) ([51eec70](https://github.com/okou-ai/okou/commit/51eec707a38a2fed444c7dbf7f01d8bb8bcf16e3))


### Refactoring

* **api:** prepare optional runner context readers ([#46173](https://github.com/okou-ai/okou/issues/46173)) ([200a124](https://github.com/okou-ai/okou/commit/200a12489fb62c0b86da3da27d9a9936d0d4463a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.46.1
    * @okouai/core bumped to 8.825.1
    * @okouai/db bumped to 2.24.9
    * @okouai/pi-agent-runtime bumped to 1.51.91

## [2.55.1](https://github.com/okou-ai/okou/compare/api-v2.55.0...api-v2.55.1) (2026-11-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.24.8

## [2.55.0](https://github.com/okou-ai/okou/compare/api-v2.54.7...api-v2.55.0) (2026-11-09)


### Features

* **email:** add file uploads and integration context ([#46119](https://github.com/okou-ai/okou/issues/46119)) ([831ba71](https://github.com/okou-ai/okou/commit/831ba71f8ef3abfe63860da9ac69970e809f8910))


### Bug Fixes

* **api:** guide integration subscription limit recovery ([#46059](https://github.com/okou-ai/okou/issues/46059)) ([0532c0c](https://github.com/okou-ai/okou/commit/0532c0c77f97245f58c5249c3d85199991a1d4e7))
* **api:** log google drive conversion preflight failures ([#46077](https://github.com/okou-ai/okou/issues/46077)) ([de796fb](https://github.com/okou-ai/okou/commit/de796fb59073c61ec6135d26c679e933ccf762e8))
* **api:** restore committed template usage telemetry ([#46093](https://github.com/okou-ai/okou/issues/46093)) ([c32c0b8](https://github.com/okou-ai/okou/commit/c32c0b83b95c0daba5fa16263e10516526078ecc))
* unify optional callbacks across computer access cards ([#46066](https://github.com/okou-ai/okou/issues/46066)) ([fbf9922](https://github.com/okou-ai/okou/commit/fbf9922703e4f61dfddf0e377092a3382d20fdf6))


### Documentation

* direct chat history guidance to temporary storage ([#46104](https://github.com/okou-ai/okou/issues/46104)) ([e862ae0](https://github.com/okou-ai/okou/commit/e862ae074025e2723fa4184177fdb2ca8b354c54))


### Refactoring

* **api:** remove marketing handoff publisher endpoints ([#46061](https://github.com/okou-ai/okou/issues/46061)) ([dc72401](https://github.com/okou-ai/okou/commit/dc72401e79f1c5b6505be1a39c681af26b6d1fb2))
* remove automatic continuation for busy chats ([#46148](https://github.com/okou-ai/okou/issues/46148)) ([54073d0](https://github.com/okou-ai/okou/commit/54073d0594fac9acbd8a07208573cd24120b7b4f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.46.0
    * @okouai/core bumped to 8.825.0
    * @okouai/db bumped to 2.24.7
    * @okouai/pi-agent-runtime bumped to 1.51.90

## [2.54.7](https://github.com/okou-ai/okou/compare/api-v2.54.6...api-v2.54.7) (2026-11-09)


### Bug Fixes

* **desktop:** use presence without idle queue polling ([#46068](https://github.com/okou-ai/okou/issues/46068)) ([eb45eb5](https://github.com/okou-ai/okou/commit/eb45eb52ab1d2b40517d452df22dae6e7270c7c1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.45.1
    * @okouai/core bumped to 8.824.5
    * @okouai/db bumped to 2.24.6
    * @okouai/pi-agent-runtime bumped to 1.51.89

## [2.54.6](https://github.com/okou-ai/okou/compare/api-v2.54.5...api-v2.54.6) (2026-11-09)


### Bug Fixes

* **api:** guide integration credit recovery by plan ([#46045](https://github.com/okou-ai/okou/issues/46045)) ([9a9dfa3](https://github.com/okou-ai/okou/commit/9a9dfa333cd34c9faf4a2e44e9145c001523e3a8))
* **api:** make suggestions a conservative maintenance loop ([#46035](https://github.com/okou-ai/okou/issues/46035)) ([8376e57](https://github.com/okou-ai/okou/commit/8376e57861eb08b5472d0f671147f72b7b6c3829))


### Refactoring

* **api:** retire template guidance storage fallback ([#46072](https://github.com/okou-ai/okou/issues/46072)) ([1fcf82a](https://github.com/okou-ai/okou/commit/1fcf82a3b88713b5d959146aff4455618056ac12))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.824.4
    * @okouai/db bumped to 2.24.5
    * @okouai/pi-agent-runtime bumped to 1.51.88

## [2.54.5](https://github.com/okou-ai/okou/compare/api-v2.54.4...api-v2.54.5) (2026-11-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.824.3
    * @okouai/db bumped to 2.24.4
    * @okouai/pi-agent-runtime bumped to 1.51.87

## [2.54.4](https://github.com/okou-ai/okou/compare/api-v2.54.3...api-v2.54.4) (2026-11-09)


### Bug Fixes

* retire thread-list indicator refresh fallback ([#46009](https://github.com/okou-ai/okou/issues/46009)) ([3696606](https://github.com/okou-ai/okou/commit/36966068cf7f6465fddc6dde6fde2574b95f4c1c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.24.3

## [2.54.3](https://github.com/okou-ai/okou/compare/api-v2.54.2...api-v2.54.3) (2026-11-08)


### Bug Fixes

* **api:** auto-continue chats after execution timeouts ([#45953](https://github.com/okou-ai/okou/issues/45953)) ([bcd58fe](https://github.com/okou-ai/okou/commit/bcd58fe38493ceb6b84ecc1ed890782d322b7fa6))


### Performance Improvements

* **api:** reuse codex account identity during run preparation ([#45966](https://github.com/okou-ai/okou/issues/45966)) ([5ba48dc](https://github.com/okou-ai/okou/commit/5ba48dc21548f89d90dc4707d1af428d5455df31))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.824.2
    * @okouai/db bumped to 2.24.2
    * @okouai/pi-agent-runtime bumped to 1.51.86

## [2.54.2](https://github.com/okou-ai/okou/compare/api-v2.54.1...api-v2.54.2) (2026-11-08)


### Refactoring

* publish template guidance as immutable bundles ([#45951](https://github.com/okou-ai/okou/issues/45951)) ([3f37903](https://github.com/okou-ai/okou/commit/3f37903b5452d477b82936cda8cd89f48c5816e7))


### Performance Improvements

* **api:** acquire normal-send lease during input publication ([#45938](https://github.com/okou-ai/okou/issues/45938)) ([425c2ee](https://github.com/okou-ai/okou/commit/425c2eeb5f5845368f713d51ed8a68e0e989a11d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.824.1
    * @okouai/db bumped to 2.24.1
    * @okouai/pi-agent-runtime bumped to 1.51.85

## [2.54.1](https://github.com/okou-ai/okou/compare/api-v2.54.0...api-v2.54.1) (2026-11-08)


### Bug Fixes

* **api:** deliver ios alerts independently of web presence ([#45944](https://github.com/okou-ai/okou/issues/45944)) ([6b3f7b6](https://github.com/okou-ai/okou/commit/6b3f7b664e5daead6d590105878d2f2a94dff4d6))

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
