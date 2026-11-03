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

## [0.1087.2](https://github.com/okou-ai/okou/compare/app-v0.1087.1...app-v0.1087.2) (2026-11-03)


### Bug Fixes

* attribute local firewall auth failures through run completion ([#44847](https://github.com/okou-ai/okou/issues/44847)) ([d672c61](https://github.com/okou-ai/okou/commit/d672c6141ad26b6f19522363841b7659a7c38673))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.37.0
    * @okouai/core bumped to 8.812.1

## [0.1087.1](https://github.com/okou-ai/okou/compare/app-v0.1087.0...app-v0.1087.1) (2026-11-03)


### Bug Fixes

* **app:** rename visualization task label to charts ([#44830](https://github.com/okou-ai/okou/issues/44830)) ([53bf130](https://github.com/okou-ai/okou/commit/53bf13017bdddb74d3a4c13e598b3145b59287ba))
* **app:** stabilize homepage discovery icons in safari ([#44832](https://github.com/okou-ai/okou/issues/44832)) ([017ff41](https://github.com/okou-ai/okou/commit/017ff4168b73f75145c07a1b74665667468fab15))
* **browser:** attribute native navigation rejections safely ([#44836](https://github.com/okou-ai/okou/issues/44836)) ([c40af58](https://github.com/okou-ai/okou/commit/c40af58d91481b3ce3a3696de642d5dba61ee930))
* **browser:** recover crashed page renderers without stale readiness ([#44805](https://github.com/okou-ai/okou/issues/44805)) ([7d8d433](https://github.com/okou-ai/okou/commit/7d8d43385447609e2f8f918e95f28bfa2935722f))
* keep feed feedback in the original card position ([#44843](https://github.com/okou-ai/okou/issues/44843)) ([f6d7913](https://github.com/okou-ai/okou/commit/f6d79138acf010b3364fcba03465cfd9771c5716))
* **platform:** classify owned browser input cancellations as aborts ([#44835](https://github.com/okou-ai/okou/issues/44835)) ([dd02549](https://github.com/okou-ai/okou/commit/dd02549e38443c14c1dc1f47510e5972cd4ef772))
* use chat consistently in interface copy ([#44841](https://github.com/okou-ai/okou/issues/44841)) ([cab1f61](https://github.com/okou-ai/okou/commit/cab1f617736d9918070fae7060b92f01f7d7e1b1))


### Refactoring

* **browser:** derive presentation from owned resource state ([#44846](https://github.com/okou-ai/okou/issues/44846)) ([59a09de](https://github.com/okou-ai/okou/commit/59a09deb49960f01d76915963ba7b12af9e7674d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.36.1
    * @okouai/connectors bumped to 3.21.0
    * @okouai/core bumped to 8.812.0

## [0.1087.0](https://github.com/okou-ai/okou/compare/app-v0.1086.0...app-v0.1087.0) (2026-11-03)


### Features

* use chat connector accounts for runs and cli switching ([#44778](https://github.com/okou-ai/okou/issues/44778)) ([9eb2bcb](https://github.com/okou-ai/okou/commit/9eb2bcba1f9804a86b338b63eb0c05d20852962f))


### Bug Fixes

* **browser:** continue lease renewal after gateway failures ([#44800](https://github.com/okou-ai/okou/issues/44800)) ([ecaad07](https://github.com/okou-ai/okou/commit/ecaad07edba38b6dbdf455a4b6d671b8127d749d))
* **browser:** isolate frames connection loss from viewer control ([#44802](https://github.com/okou-ai/okou/issues/44802)) ([d043458](https://github.com/okou-ai/okou/commit/d043458b7b6d19afaff42a9d6e21548ff2e7a77e))
* **platform:** bound unanswered browser requests and expose recovery ([#44801](https://github.com/okou-ai/okou/issues/44801)) ([47f22ca](https://github.com/okou-ai/okou/commit/47f22ca434f6cbf2069ab919286d6050033f5a42))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.36.0
    * @okouai/browser-extension-client bumped to 0.4.3
    * @okouai/core bumped to 8.811.1

## [0.1086.0](https://github.com/okou-ai/okou/compare/app-v0.1085.0...app-v0.1086.0) (2026-11-03)


### Features

* **app:** add homepage task discovery ([#44734](https://github.com/okou-ai/okou/issues/44734)) ([9a61c65](https://github.com/okou-ai/okou/commit/9a61c65def6f53af57ed38f9272a61d612bf6999))


### Bug Fixes

* **app:** group subscription usage and surface recovery when needed ([#44761](https://github.com/okou-ai/okou/issues/44761)) ([156d007](https://github.com/okou-ai/okou/commit/156d0079d730401b1af49e5229d2f966b4eeec37))
* **browser:** recover scoped targets across selection phases ([#44688](https://github.com/okou-ai/okou/issues/44688)) ([2563c30](https://github.com/okou-ai/okou/commit/2563c30f45698ee02848ed3749cc30e23edca37d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.35.0
    * @okouai/core bumped to 8.811.0

## [0.1085.0](https://github.com/okou-ai/okou/compare/app-v0.1084.1...app-v0.1085.0) (2026-11-02)


### Features

* **app:** organize projects as chat sidebar folders ([#44751](https://github.com/okou-ai/okou/issues/44751)) ([e2c0304](https://github.com/okou-ai/okou/commit/e2c03040852a6eebd24921e9dc75529ad58a83c1))


### Bug Fixes

* **browser:** keep new tabs blank during preparation ([#44738](https://github.com/okou-ai/okou/issues/44738)) ([661d1a9](https://github.com/okou-ai/okou/commit/661d1a96f5f2198d2c42c6657187c862a4111a50))
* unify chat filter actions without icons ([#44717](https://github.com/okou-ai/okou/issues/44717)) ([9286fc4](https://github.com/okou-ai/okou/commit/9286fc46885823d472ed15365a0ae148f9d4d905))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.34.0
    * @okouai/core bumped to 8.810.0

## [0.1084.1](https://github.com/okou-ai/okou/compare/app-v0.1084.0...app-v0.1084.1) (2026-11-02)


### Bug Fixes

* use high-resolution okou sharing artwork ([#44721](https://github.com/okou-ai/okou/issues/44721)) ([4ebff22](https://github.com/okou-ai/okou/commit/4ebff22651c042d5de49e298c4a255cdd121e350))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.809.1

## [0.1084.0](https://github.com/okou-ai/okou/compare/app-v0.1083.6...app-v0.1084.0) (2026-11-02)


### Features

* **chat:** quote email contacts from inline mail icons ([#44620](https://github.com/okou-ai/okou/issues/44620)) ([e855924](https://github.com/okou-ai/okou/commit/e855924e6fabe9c22d67b73858e640183d4ff285))
* implement private cross-agent projects behind release gate ([#44617](https://github.com/okou-ai/okou/issues/44617)) ([428f461](https://github.com/okou-ai/okou/commit/428f46154beb1a11cdf09f150650c388826e539c))


### Bug Fixes

* **app:** move markdown table export to footer ([#44618](https://github.com/okou-ai/okou/issues/44618)) ([66c8873](https://github.com/okou-ai/okou/commit/66c88739620676718f77d7eaa1837279686b9ba2))
* **app:** stabilize composer task icons in safari ([#44685](https://github.com/okou-ai/okou/issues/44685)) ([8a58467](https://github.com/okou-ai/okou/commit/8a584679b9c727bbf7ccf7a45f6c444b5b43022a))
* **browser:** preserve mounted heartbeat after transient lease failures ([#44680](https://github.com/okou-ai/okou/issues/44680)) ([70dcba0](https://github.com/okou-ai/okou/commit/70dcba080dac5dbfe1c2831e2ffd0996f6037987))
* **browser:** report established viewer disconnects once ([#44682](https://github.com/okou-ai/okou/issues/44682)) ([460f2e6](https://github.com/okou-ai/okou/commit/460f2e6b2a35b971b1deb96300af9cde3bd27ce2))
* **browser:** retain safe bridge failure diagnostics ([#44683](https://github.com/okou-ai/okou/issues/44683)) ([05cb9a7](https://github.com/okou-ai/okou/commit/05cb9a723e071d2be7877fb19c7fac2e65ad1e19))
* **browser:** unblock reconnect from unacknowledged cleanup ([#44676](https://github.com/okou-ai/okou/issues/44676)) ([8a18bc7](https://github.com/okou-ai/okou/commit/8a18bc77877df1005a40b9471e23b4d4ac06de1b))
* gate cjk markdown emphasis rendering behind a lab switch ([#44653](https://github.com/okou-ai/okou/issues/44653)) ([aa7c978](https://github.com/okou-ai/okou/commit/aa7c9787430bc29a8b59587bf42a51d49b4a8429))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.33.0
    * @okouai/browser-extension-client bumped to 0.4.2
    * @okouai/core bumped to 8.809.0

## [0.1083.6](https://github.com/okou-ai/okou/compare/app-v0.1083.5...app-v0.1083.6) (2026-11-02)


### Bug Fixes

* **browser:** end native input focus on remote navigation ([#44655](https://github.com/okou-ai/okou/issues/44655)) ([b9653cc](https://github.com/okou-ai/okou/commit/b9653ccec674b02b6c40a206a483b12097d36afd))


### Refactoring

* remove artifact deletion feature switch ([#44649](https://github.com/okou-ai/okou/issues/44649)) ([6fdcb0e](https://github.com/okou-ai/okou/commit/6fdcb0e11da48286252c8277d54c8fcf23d0abf3))
* remove chat thread timeline feature switch ([#44651](https://github.com/okou-ai/okou/issues/44651)) ([9fa275a](https://github.com/okou-ai/okou/commit/9fa275ac619738a90345e866425fa3dfdeb4dd14))
* remove shared thread visibility feature switch ([#44658](https://github.com/okou-ai/okou/issues/44658)) ([5578cdb](https://github.com/okou-ai/okou/commit/5578cdb5b540607a66f7c8d2de52a287ecd8ee09))
* **teams:** remove workspace identity feature switch ([#44660](https://github.com/okou-ai/okou/issues/44660)) ([e77bc14](https://github.com/okou-ai/okou/commit/e77bc14635c0b1f8b8420aa1f8b5fb4fc9f01db5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.32.0
    * @okouai/core bumped to 8.808.1
    * @okouai/ui bumped to 1.18.8

## [0.1083.5](https://github.com/okou-ai/okou/compare/app-v0.1083.4...app-v0.1083.5) (2026-11-02)


### Bug Fixes

* **app:** confirm message shares immediately ([#44636](https://github.com/okou-ai/okou/issues/44636)) ([2443df9](https://github.com/okou-ai/okou/commit/2443df9417d4ebd4634b18f5c36da8cb3b745727))
* **app:** remove screenshots from paused browser panels ([#44585](https://github.com/okou-ai/okou/issues/44585)) ([602b616](https://github.com/okou-ai/okou/commit/602b616e40a9f0b3287cd0193f29a71435220865))
* **billing:** turn off auto-recharge after consecutive failures ([#44587](https://github.com/okou-ai/okou/issues/44587)) ([5881a17](https://github.com/okou-ai/okou/commit/5881a17e5c332bef9ff4efe94f96048deef82962))
* **browser:** acquire coherent viewer bindings on reconnect ([#44606](https://github.com/okou-ai/okou/issues/44606)) ([03444af](https://github.com/okou-ai/okou/commit/03444afe60a11dec7134c1e8872f72519ccef099))
* handle invalid feishu bot connection links ([#44619](https://github.com/okou-ai/okou/issues/44619)) ([7801052](https://github.com/okou-ai/okou/commit/78010527837678d7e7f5e4bfc338c1d577de88f7))


### Refactoring

* **app:** remove artifact quick actions ([#44615](https://github.com/okou-ai/okou/issues/44615)) ([17a4d1e](https://github.com/okou-ai/okou/commit/17a4d1e2b224595281cbeb98ab45a97c0a2fc701))
* remove released first task halloween and onboarding switches ([#44575](https://github.com/okou-ai/okou/issues/44575)) ([4571899](https://github.com/okou-ai/okou/commit/4571899bd04a73a9e13591326ad0f9b21f9612fd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.31.1
    * @okouai/core bumped to 8.808.0

## [0.1083.4](https://github.com/okou-ai/okou/compare/app-v0.1083.3...app-v0.1083.4) (2026-11-02)


### Bug Fixes

* **browser:** restore native windows before display calibration ([#44580](https://github.com/okou-ai/okou/issues/44580)) ([c59be2a](https://github.com/okou-ai/okou/commit/c59be2a623bc46bec18bc1238ac2605a8e4e644c))

## [0.1083.3](https://github.com/okou-ai/okou/compare/app-v0.1083.2...app-v0.1083.3) (2026-11-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.31.0
    * @okouai/core bumped to 8.807.4

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
