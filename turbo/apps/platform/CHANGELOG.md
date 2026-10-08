# Changelog

Older releases are archived by month:

- [2026-09](changelog/2026-09/CHANGELOG.md)
- [2026-08](changelog/2026-08/CHANGELOG.md)
- [2026-07](changelog/2026-07/CHANGELOG.md)
- [2026-06](changelog/2026-06/CHANGELOG.md)
- [2026-05](changelog/2026-05/CHANGELOG.md)
- [2026-04](changelog/2026-04/CHANGELOG.md)
- [2026-03](changelog/2026-03/CHANGELOG.md)
- [2026-02](changelog/2026-02/CHANGELOG.md)
- [2026-01](changelog/2026-01/CHANGELOG.md)

## [0.1003.2](https://github.com/okou-ai/okou/compare/app-v0.1003.1...app-v0.1003.2) (2026-10-08)


### Bug Fixes

* **app:** preserve artifact reading state when expanding diagrams ([#38118](https://github.com/okou-ai/okou/issues/38118)) ([d2ce547](https://github.com/okou-ai/okou/commit/d2ce5471a31c238e2f45b4fc9f08246543114b0e))
* **billing:** keep member usage packs nonnegative ([#38071](https://github.com/okou-ai/okou/issues/38071)) ([532c7f8](https://github.com/okou-ai/okou/commit/532c7f813cc2e824ff4fa487f251786848b8d752))
* suppress pwa push while the user is foreground in the same org ([#38091](https://github.com/okou-ai/okou/issues/38091)) ([22f89a5](https://github.com/okou-ai/okou/commit/22f89a5c8b69990bb3834c7678acb25f00d1c823))
* **voice:** separate segment transcription from final polish ([#38082](https://github.com/okou-ai/okou/issues/38082)) ([1c7cb86](https://github.com/okou-ai/okou/commit/1c7cb86855d50504a57a6fcb86b9357a5965e3de))


### Refactoring

* **api:** use client-only platform realtime token exchange ([#38105](https://github.com/okou-ai/okou/issues/38105)) ([0fdfb57](https://github.com/okou-ai/okou/commit/0fdfb57b88d655219e84f18050a88362071cdd41))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.540.0
    * @okouai/core bumped to 8.735.2
    * @okouai/ui bumped to 1.12.5

## [0.1003.1](https://github.com/okou-ai/okou/compare/app-v0.1003.0...app-v0.1003.1) (2026-10-08)


### Bug Fixes

* **app:** add native network log disclosure controls ([#38027](https://github.com/okou-ai/okou/issues/38027)) ([90be135](https://github.com/okou-ai/okou/commit/90be1356d1f97459f064e34d4b06ea550f8baf05))
* **app:** expose workflow filter selection state ([#38024](https://github.com/okou-ai/okou/issues/38024)) ([31a2ad7](https://github.com/okou-ai/okou/commit/31a2ad7fc108be956ae6c9c80a2753e709835401))
* **app:** manage mobile sidebar focus with sheet ([#38034](https://github.com/okou-ai/okou/issues/38034)) ([c44c598](https://github.com/okou-ai/okou/commit/c44c598b9b9fbe549e2f088e0342d6527a391a41))
* **app:** preserve modified feishu icon download clicks ([#38026](https://github.com/okou-ai/okou/issues/38026)) ([d4f2a1f](https://github.com/okou-ai/okou/commit/d4f2a1f50c5135721d9eaedb34ccc79abfffb4ce))
* **app:** preserve safari ime confirmation in imported template titles ([#38022](https://github.com/okou-ai/okou/issues/38022)) ([2f87226](https://github.com/okou-ai/okou/commit/2f87226be63d2e54097ae75b5aa6f5060103ae5a))
* **app:** remove ppt template detail loading bar ([#38075](https://github.com/okou-ai/okou/issues/38075)) ([27cc202](https://github.com/okou-ai/okou/commit/27cc2027c516cac91ca57eb9bd893710a045699a))
* **app:** use native links for ideation cards ([#38025](https://github.com/okou-ai/okou/issues/38025)) ([18c50ea](https://github.com/okou-ai/okou/commit/18c50eaf2c6edc265498331bc6b804bb845734fd))
* **app:** use native links for static navigation entries ([#38031](https://github.com/okou-ai/okou/issues/38031)) ([5a6ef9f](https://github.com/okou-ai/okou/commit/5a6ef9f8e3db3c2100dc83e0a8c8d41fa24769f0))
* **platform:** expose current workflow file as a menu radio selection ([#38029](https://github.com/okou-ai/okou/issues/38029)) ([2d7237a](https://github.com/okou-ai/okou/commit/2d7237a299393b10674f8638b686c4ff42373e80))
* **platform:** preserve skill import on modified workflow link clicks ([#38017](https://github.com/okou-ai/okou/issues/38017)) ([5a4befc](https://github.com/okou-ai/okou/commit/5a4befc8551e7c16c3aa92f89a1c5283f63c8273))
* **platform:** submit feishu and lark wizard steps natively ([#38018](https://github.com/okou-ai/okou/issues/38018)) ([770ca24](https://github.com/okou-ai/okou/commit/770ca24ead6cd475bef8c1846d16f54d9859e1e2))


### Refactoring

* remove agent responsibility setup feature switch ([#38069](https://github.com/okou-ai/okou/issues/38069)) ([bbb313e](https://github.com/okou-ai/okou/commit/bbb313e561cf6904565d5b91e7e227e2016557ee))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.539.1
    * @okouai/core bumped to 8.735.1
    * @okouai/ui bumped to 1.12.4

## [0.1003.0](https://github.com/okou-ai/okou/compare/app-v0.1002.2...app-v0.1003.0) (2026-10-08)


### Features

* enable private artifacts for all users ([#37951](https://github.com/okou-ai/okou/issues/37951)) ([91e19d1](https://github.com/okou-ai/okou/commit/91e19d1e55e49ffb5822aa2a9d7fcb336b9cb9cf))


### Bug Fixes

* **platform:** restore connector account rename focus ([#37939](https://github.com/okou-ai/okou/issues/37939)) ([c40583b](https://github.com/okou-ai/okou/commit/c40583b6a0e685fa2c8c58ab657779b0804a2005))
* **platform:** scope image navigation keys to the focused canvas ([#36527](https://github.com/okou-ai/okou/issues/36527)) ([fb921ee](https://github.com/okou-ai/okou/commit/fb921ee515fee951cfa8cc33664696f5b56c06bb))
* **platform:** submit chat events alongside read-status effects ([#37991](https://github.com/okou-ai/okou/issues/37991)) ([0fbd917](https://github.com/okou-ai/okou/commit/0fbd91781aa4f04bc8e6a41d6242fda959917d75))


### Refactoring

* **platform:** remove abandoned chat last-read marker ([#37966](https://github.com/okou-ai/okou/issues/37966)) ([d85fdca](https://github.com/okou-ai/okou/commit/d85fdcad049428b366f892a181c69e7ab61a8523))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.539.0
    * @okouai/core bumped to 8.735.0

## [0.1002.2](https://github.com/okou-ai/okou/compare/app-v0.1002.1...app-v0.1002.2) (2026-10-08)


### Bug Fixes

* **app:** use native spotlight search filters ([#37947](https://github.com/okou-ai/okou/issues/37947)) ([6766c12](https://github.com/okou-ai/okou/commit/6766c12541fa97b0ade1ef0e5cd956df8b8a7b34))
* let the model catalog decide which models accept reasoning effort ([#37958](https://github.com/okou-ai/okou/issues/37958)) ([abc2a1c](https://github.com/okou-ai/okou/commit/abc2a1c29edd2a840f109d36fd460aea6db3888a))
* **platform:** preserve native pinned agent link activations ([#36523](https://github.com/okou-ai/okou/issues/36523)) ([ee36a55](https://github.com/okou-ai/okou/commit/ee36a5590a1ceca332ff1ef5d582c8e6a446507f))
* **platform:** use native buttons for mobile sidebar disclosures ([#36514](https://github.com/okou-ai/okou/issues/36514)) ([df048aa](https://github.com/okou-ai/okou/commit/df048aa008484b05199a1606c4b68652ca1a41f7))


### Refactoring

* **ui:** use native network type checkbox menu items ([#36525](https://github.com/okou-ai/okou/issues/36525)) ([e9241d9](https://github.com/okou-ai/okou/commit/e9241d948e5a565afa081e2e44f533a545c9bb8a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.538.1
    * @okouai/core bumped to 8.734.9
    * @okouai/ui bumped to 1.12.3

## [0.1002.1](https://github.com/okou-ai/okou/compare/app-v0.1002.0...app-v0.1002.1) (2026-10-08)


### Bug Fixes

* **platform:** navigate immediately when archiving from the chat header ([#37938](https://github.com/okou-ai/okou/issues/37938)) ([367bc26](https://github.com/okou-ai/okou/commit/367bc268b77e01b0dafbe056fc81bfb5fea6fd98))

## [0.1002.0](https://github.com/okou-ai/okou/compare/app-v0.1001.5...app-v0.1002.0) (2026-10-08)


### Features

* **platform:** prepare tailscale-aware ssh and vnc readers ([#37814](https://github.com/okou-ai/okou/issues/37814)) ([a648388](https://github.com/okou-ai/okou/commit/a648388f2dd47531d577fe4e68205c505335a9c3))


### Bug Fixes

* **platform:** drop credential source column from chat model picker ([#37924](https://github.com/okou-ai/okou/issues/37924)) ([3fbe719](https://github.com/okou-ai/okou/commit/3fbe719ec539bb68a51d0fb5deccfd9381b92989))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.538.0
    * @okouai/connectors bumped to 3.16.7
    * @okouai/core bumped to 8.734.8

## [0.1001.5](https://github.com/okou-ai/okou/compare/app-v0.1001.4...app-v0.1001.5) (2026-10-07)


### Refactoring

* represent auto model selection as null ([#37901](https://github.com/okou-ai/okou/issues/37901)) ([d0e0b71](https://github.com/okou-ai/okou/commit/d0e0b7191fe168e8935e1abf3df1fa1806efea2a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.14
    * @okouai/connectors bumped to 3.16.6
    * @okouai/core bumped to 8.734.7

## [0.1001.4](https://github.com/okou-ai/okou/compare/app-v0.1001.3...app-v0.1001.4) (2026-10-07)


### Refactoring

* finish connector catalog release 2 follow-up cleanup ([#37895](https://github.com/okou-ai/okou/issues/37895)) ([013d37d](https://github.com/okou-ai/okou/commit/013d37d5513f5ff071097621e4436109742f6dc8))
* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))
* retire cooldown, ultrafast, us routing and model provider leftovers ([#37884](https://github.com/okou-ai/okou/issues/37884)) ([a9c3270](https://github.com/okou-ai/okou/commit/a9c3270099034c0f7ee73f6c730b07efa7d1d733))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.13
    * @okouai/connectors bumped to 3.16.5
    * @okouai/core bumped to 8.734.6

## [0.1001.3](https://github.com/okou-ai/okou/compare/app-v0.1001.2...app-v0.1001.3) (2026-10-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.12
    * @okouai/connectors bumped to 3.16.4
    * @okouai/core bumped to 8.734.5

## [0.1001.2](https://github.com/okou-ai/okou/compare/app-v0.1001.1...app-v0.1001.2) (2026-10-07)


### Bug Fixes

* **platform:** skip the pwa slide after a browser swipe navigation ([#37880](https://github.com/okou-ai/okou/issues/37880)) ([90e4f4a](https://github.com/okou-ai/okou/commit/90e4f4acc7bdc8fdb2dd02a06904a1c57c77f0b2))


### Refactoring

* move release 1 connector catalog consumers off legacy storage ([#37861](https://github.com/okou-ai/okou/issues/37861)) ([e664957](https://github.com/okou-ai/okou/commit/e664957caa2056a336595e55f475001b81247fd0))
* **platform:** start the pwa slide before the route moves ([#37868](https://github.com/okou-ai/okou/issues/37868)) ([892d17e](https://github.com/okou-ai/okou/commit/892d17e1f2096acbaf24e9c822c24f0a38db2f01))
* remove remaining model provider residue ([#37870](https://github.com/okou-ai/okou/issues/37870)) ([a93133b](https://github.com/okou-ai/okou/commit/a93133b0493858a39924a1206ff5a5677e43cad6))
* remove retired per-agent ssh access traces ([#37876](https://github.com/okou-ai/okou/issues/37876)) ([dc33264](https://github.com/okou-ai/okou/commit/dc332649051e79460f1075a294ba8d3707f8504f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.11
    * @okouai/connectors bumped to 3.16.3
    * @okouai/core bumped to 8.734.4

## [0.1001.1](https://github.com/okou-ai/okou/compare/app-v0.1001.0...app-v0.1001.1) (2026-10-07)


### Refactoring

* clean up released switch leftovers and drop legacy chat thread provider pins ([#37851](https://github.com/okou-ai/okou/issues/37851)) ([066e9c3](https://github.com/okou-ai/okou/commit/066e9c32c2bbd5e3d48783fb0028f8dcfbaeaf06))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.10
    * @okouai/core bumped to 8.734.3

## [0.1001.0](https://github.com/okou-ai/okou/compare/app-v0.1000.1...app-v0.1001.0) (2026-10-07)


### Features

* **platform:** slide pwa pages between tab roots and nested pages ([#37853](https://github.com/okou-ai/okou/issues/37853)) ([1d3fcca](https://github.com/okou-ai/okou/commit/1d3fccac2606c5a226b35b38a158b3c25b6da28a))


### Refactoring

* **platform:** remove page clearing and the react app skeleton ([#37857](https://github.com/okou-ai/okou/issues/37857)) ([7fbda7d](https://github.com/okou-ai/okou/commit/7fbda7de74bad50dad377ffe0d048c41fadc8a2f))
* remove all remaining custom model mode awareness ([#37856](https://github.com/okou-ai/okou/issues/37856)) ([f383835](https://github.com/okou-ai/okou/commit/f3838353ba0455ec7d57dfa2d0974e34a44796ff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.9
    * @okouai/core bumped to 8.734.2

## [0.1000.1](https://github.com/okou-ai/okou/compare/app-v0.1000.0...app-v0.1000.1) (2026-10-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.8
    * @okouai/connectors bumped to 3.16.2
    * @okouai/core bumped to 8.734.1

## [0.1000.0](https://github.com/okou-ai/okou/compare/app-v0.999.2...app-v0.1000.0) (2026-10-06)


### Features

* **core:** release eleven staff feature switches to all users ([#37818](https://github.com/okou-ai/okou/issues/37818)) ([8d05119](https://github.com/okou-ai/okou/commit/8d051194184d595b67f78f5d6f7ec728ed6cc31d))


### Refactoring

* remove expired deployment compatibility ([#37845](https://github.com/okou-ai/okou/issues/37845)) ([ada585f](https://github.com/okou-ai/okou/commit/ada585fdc70a1fc5c26e70e0ec53bbef893c4f4c))


### Performance Improvements

* **platform:** pin i18next-cli to 1.74.0 to fix quadratic i18n lint ([#37825](https://github.com/okou-ai/okou/issues/37825)) ([f5360e5](https://github.com/okou-ai/okou/commit/f5360e56a58748cd5c808a8b73943372315274ad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.7
    * @okouai/core bumped to 8.734.0

## [0.999.2](https://github.com/okou-ai/okou/compare/app-v0.999.1...app-v0.999.2) (2026-10-06)


### Refactoring

* retire organization custom model configuration ([#37746](https://github.com/okou-ai/okou/issues/37746)) ([014fe18](https://github.com/okou-ai/okou/commit/014fe1867c6d1830fd35b03c3d77491da5aaa36a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.6
    * @okouai/core bumped to 8.733.3

## [0.999.1](https://github.com/okou-ai/okou/compare/app-v0.999.0...app-v0.999.1) (2026-10-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.5
    * @okouai/connectors bumped to 3.16.1
    * @okouai/core bumped to 8.733.2

## [0.999.0](https://github.com/okou-ai/okou/compare/app-v0.998.7...app-v0.999.0) (2026-10-06)


### Features

* **platform:** add archive to mobile chat header ([#37805](https://github.com/okou-ai/okou/issues/37805)) ([949c258](https://github.com/okou-ai/okou/commit/949c258bdece47e14d6e1a7fc55a604f6feb71c1))

## [0.998.7](https://github.com/okou-ai/okou/compare/app-v0.998.6...app-v0.998.7) (2026-10-06)


### Bug Fixes

* **app:** keep billing pricing dialog stable across async loading ([#37801](https://github.com/okou-ai/okou/issues/37801)) ([3a62e63](https://github.com/okou-ai/okou/commit/3a62e6375801e96fa6378104c95f1818aad9eb32))

## [0.998.6](https://github.com/okou-ai/okou/compare/app-v0.998.5...app-v0.998.6) (2026-10-06)


### Bug Fixes

* **platform:** remove model and byok plan highlights ([#37797](https://github.com/okou-ai/okou/issues/37797)) ([486298e](https://github.com/okou-ai/okou/commit/486298e628e544d65810cb37b0b7e2aec4b3fa49))

## [0.998.5](https://github.com/okou-ai/okou/compare/app-v0.998.4...app-v0.998.5) (2026-10-06)


### Performance Improvements

* **ci:** build app once and remove deployment probes ([#37794](https://github.com/okou-ai/okou/issues/37794)) ([c0a3dfd](https://github.com/okou-ai/okou/commit/c0a3dfdbaa222244926ff14f6e50cdab5384acc4))

## [0.998.4](https://github.com/okou-ai/okou/compare/app-v0.998.3...app-v0.998.4) (2026-10-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.4
    * @okouai/core bumped to 8.733.1

## [0.998.3](https://github.com/okou-ai/okou/compare/app-v0.998.2...app-v0.998.3) (2026-10-06)


### Bug Fixes

* **platform:** reject silent voice uploads with a client vad gate ([#37784](https://github.com/okou-ai/okou/issues/37784)) ([4e9adf9](https://github.com/okou-ai/okou/commit/4e9adf9324b6d8f3c0c660bbde8ff8951215c50e))
* simplify subscription reset card controls ([#37780](https://github.com/okou-ai/okou/issues/37780)) ([65338a1](https://github.com/okou-ai/okou/commit/65338a1201a4eed55bda1ed8a01dc91ac15bea4b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.733.0

## [0.998.2](https://github.com/okou-ai/okou/compare/app-v0.998.1...app-v0.998.2) (2026-10-06)


### Bug Fixes

* **app:** remove sidebar double-click rename ([#37775](https://github.com/okou-ai/okou/issues/37775)) ([2764bf6](https://github.com/okou-ai/okou/commit/2764bf6f755cb0f2e05cd98ff58cba51f247d53d))

## [0.998.1](https://github.com/okou-ai/okou/compare/app-v0.998.0...app-v0.998.1) (2026-10-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.3
    * @okouai/connectors bumped to 3.16.0
    * @okouai/core bumped to 8.732.1

## [0.998.0](https://github.com/okou-ai/okou/compare/app-v0.997.1...app-v0.998.0) (2026-10-05)


### Features

* **db:** add immutable catalog tables and a shared test catalog ([#37697](https://github.com/okou-ai/okou/issues/37697)) ([f24c015](https://github.com/okou-ai/okou/commit/f24c0158fb5d44fe002399bea74aaec8822bf2c0))

## [0.997.1](https://github.com/okou-ai/okou/compare/app-v0.997.0...app-v0.997.1) (2026-10-05)


### Bug Fixes

* **platform:** use filled icons for active pwa tabs ([#37749](https://github.com/okou-ai/okou/issues/37749)) ([7341256](https://github.com/okou-ai/okou/commit/7341256d123ca8583d5af1537afe80c5b827297c))
* **platform:** use native links for model approval pages ([#37756](https://github.com/okou-ai/okou/issues/37756)) ([73ddcf9](https://github.com/okou-ai/okou/commit/73ddcf90af7e260d331987c18b380970afb59590))


### Refactoring

* retire claude code manual usage reset ([#37755](https://github.com/okou-ai/okou/issues/37755)) ([1855ed7](https://github.com/okou-ai/okou/commit/1855ed7f5d58c7aa931a6acc27f2fa375edc395f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.732.0

## [0.997.0](https://github.com/okou-ai/okou/compare/app-v0.996.2...app-v0.997.0) (2026-10-05)


### Features

* **platform:** add a feature-gated last-read divider and entry positioning ([#37740](https://github.com/okou-ai/okou/issues/37740)) ([52fbc35](https://github.com/okou-ai/okou/commit/52fbc351e258b79ac0e9a104a46247d695ac959e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.2
    * @okouai/core bumped to 8.731.0

## [0.996.2](https://github.com/okou-ai/okou/compare/app-v0.996.1...app-v0.996.2) (2026-10-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.1
    * @okouai/core bumped to 8.730.2

## [0.996.1](https://github.com/okou-ai/okou/compare/app-v0.996.0...app-v0.996.1) (2026-10-05)


### Refactoring

* graduate fully rolled out feature switches ([#37721](https://github.com/okou-ai/okou/issues/37721)) ([62e6dd4](https://github.com/okou-ai/okou/commit/62e6dd43c07ccfd77517d6f653ab123a37aff89f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.730.1

## [0.996.0](https://github.com/okou-ai/okou/compare/app-v0.995.0...app-v0.996.0) (2026-10-05)


### Features

* simplify mobile pwa chat list header ([#37728](https://github.com/okou-ai/okou/issues/37728)) ([4844ec7](https://github.com/okou-ai/okou/commit/4844ec7dd63b7854700dc2eb43f5fcf9ba9b41b3))

## [0.995.0](https://github.com/okou-ai/okou/compare/app-v0.994.0...app-v0.995.0) (2026-10-05)


### Features

* enable phone group history, message sharing and social jobs globally ([#37716](https://github.com/okou-ai/okou/issues/37716)) ([b1ec157](https://github.com/okou-ai/okou/commit/b1ec157db9ded38688563e0f153df0ab8364802e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.730.0

## [0.994.0](https://github.com/okou-ai/okou/compare/app-v0.993.0...app-v0.994.0) (2026-10-05)


### Features

* **app:** add opt-in responsive mobile navigation ([#37713](https://github.com/okou-ai/okou/issues/37713)) ([507bc00](https://github.com/okou-ai/okou/commit/507bc00e3fd3570b866c66d21c47871512938859))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.729.0

## [0.993.0](https://github.com/okou-ai/okou/compare/app-v0.992.0...app-v0.993.0) (2026-10-04)


### Features

* **platform:** add muted chat list filter ([#37691](https://github.com/okou-ai/okou/issues/37691)) ([cf155ac](https://github.com/okou-ai/okou/commit/cf155ac9e19c1ce08a1a55fa43f97ff5da358d7f))


### Bug Fixes

* **platform:** show inbox filter when chat archiving is enabled ([#37692](https://github.com/okou-ai/okou/issues/37692)) ([fcc16bd](https://github.com/okou-ai/okou/commit/fcc16bd06b002909610f6e4319795f14e9ce7280))

## [0.992.0](https://github.com/okou-ai/okou/compare/app-v0.991.6...app-v0.992.0) (2026-10-04)


### Features

* add organization-gated thread muting ([#37681](https://github.com/okou-ai/okou/issues/37681)) ([267fa71](https://github.com/okou-ai/okou/commit/267fa71b3cf85592fcbb7b644cdfefc1f5d642ff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.0
    * @okouai/core bumped to 8.728.0

## [0.991.6](https://github.com/okou-ai/okou/compare/app-v0.991.5...app-v0.991.6) (2026-10-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.536.2
    * @okouai/core bumped to 8.727.2

## [0.991.5](https://github.com/okou-ai/okou/compare/app-v0.991.4...app-v0.991.5) (2026-10-04)


### Bug Fixes

* **app:** normalize slack icon size in onboarding ([#37676](https://github.com/okou-ai/okou/issues/37676)) ([0ffd6a2](https://github.com/okou-ai/okou/commit/0ffd6a2ee15480bfecbd7b4777a3556464733d7a))

## [0.991.4](https://github.com/okou-ai/okou/compare/app-v0.991.3...app-v0.991.4) (2026-10-03)


### Bug Fixes

* preserve pi length completion and cap luna effort at xhigh ([#37607](https://github.com/okou-ai/okou/issues/37607)) ([acb1094](https://github.com/okou-ai/okou/commit/acb10941881de41850f70ab3a4930f22041812b0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/ui bumped to 1.12.2

## [0.991.3](https://github.com/okou-ai/okou/compare/app-v0.991.2...app-v0.991.3) (2026-10-03)


### Bug Fixes

* **deps:** clear new high pnpm audit findings without patched releases ([#37601](https://github.com/okou-ai/okou/issues/37601)) ([47440e8](https://github.com/okou-ai/okou/commit/47440e804b57e7c00fde42cc14ffdd72ae593749))

## [0.991.2](https://github.com/okou-ai/okou/compare/app-v0.991.1...app-v0.991.2) (2026-10-02)


### Refactoring

* remove retired video generation entitlement ([#37580](https://github.com/okou-ai/okou/issues/37580)) ([d6fb17a](https://github.com/okou-ai/okou/commit/d6fb17af11171e4edd1e7a9b289e255db602a402))
* retire legacy free organization tier ([#37581](https://github.com/okou-ai/okou/issues/37581)) ([26691d8](https://github.com/okou-ai/okou/commit/26691d89ca363d22a9ed045b23fc02894a21d043))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.536.1
    * @okouai/core bumped to 8.727.1

## [0.991.1](https://github.com/okou-ai/okou/compare/app-v0.991.0...app-v0.991.1) (2026-10-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.536.0
    * @okouai/core bumped to 8.727.0

## [0.991.0](https://github.com/okou-ai/okou/compare/app-v0.990.7...app-v0.991.0) (2026-10-02)


### Features

* add owner-selected rsa-aes vnc profiles ([#37548](https://github.com/okou-ai/okou/issues/37548)) ([6716f9a](https://github.com/okou-ai/okou/commit/6716f9afed2943ab4c18f0c8aa435a20f2e7f47b))


### Bug Fixes

* **app:** align pro upgrade concurrency copy with plan limits ([#37565](https://github.com/okou-ai/okou/issues/37565)) ([5082528](https://github.com/okou-ai/okou/commit/50825281399fd2936139bfe7fceb5b544757b96d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.535.0
    * @okouai/core bumped to 8.726.1

## [0.990.7](https://github.com/okou-ai/okou/compare/app-v0.990.6...app-v0.990.7) (2026-10-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.534.0
    * @okouai/core bumped to 8.726.0

## [0.990.6](https://github.com/okou-ai/okou/compare/app-v0.990.5...app-v0.990.6) (2026-10-02)


### Refactoring

* **platform:** bind account search debounce to page lifecycle ([#37492](https://github.com/okou-ai/okou/issues/37492)) ([e072833](https://github.com/okou-ai/okou/commit/e07283388b6590bb222f8059b1ef29f298d89892))

## [0.990.5](https://github.com/okou-ai/okou/compare/app-v0.990.4...app-v0.990.5) (2026-10-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.725.7

## [0.990.4](https://github.com/okou-ai/okou/compare/app-v0.990.3...app-v0.990.4) (2026-10-02)


### Bug Fixes

* **platform:** throttle worker indicator refreshes ([#37538](https://github.com/okou-ai/okou/issues/37538)) ([142747e](https://github.com/okou-ai/okou/commit/142747eece04d8346b23764911c862f357a5658f))

## [0.990.3](https://github.com/okou-ai/okou/compare/app-v0.990.2...app-v0.990.3) (2026-10-01)


### Bug Fixes

* **app:** simplify auto model account connection states ([#37519](https://github.com/okou-ai/okou/issues/37519)) ([8385c05](https://github.com/okou-ai/okou/commit/8385c05827f8a34c32a599ebd48fb970825adf68))

## [0.990.2](https://github.com/okou-ai/okou/compare/app-v0.990.1...app-v0.990.2) (2026-10-01)


### Refactoring

* **api:** prepare advisory lock cleanup release 1 ([#37313](https://github.com/okou-ai/okou/issues/37313)) ([77b3c9f](https://github.com/okou-ai/okou/commit/77b3c9f855bb9cd434eefc68ab2cb2cb9eb11ab2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.533.2
    * @okouai/core bumped to 8.725.6

## [0.990.1](https://github.com/okou-ai/okou/compare/app-v0.990.0...app-v0.990.1) (2026-10-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.533.1
    * @okouai/core bumped to 8.725.5

## [0.990.0](https://github.com/okou-ai/okou/compare/app-v0.989.5...app-v0.990.0) (2026-10-01)


### Features

* **vnc:** add owner-selected qemu scram profile ([#37486](https://github.com/okou-ai/okou/issues/37486)) ([8562a7a](https://github.com/okou-ai/okou/commit/8562a7a241033ae023a588e9ead5643e93990957))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.533.0
    * @okouai/core bumped to 8.725.4

## [0.989.5](https://github.com/okou-ai/okou/compare/app-v0.989.4...app-v0.989.5) (2026-10-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.532.3
    * @okouai/connectors bumped to 3.15.6
    * @okouai/core bumped to 8.725.3

## [0.989.4](https://github.com/okou-ai/okou/compare/app-v0.989.3...app-v0.989.4) (2026-10-01)


### Bug Fixes

* **platform:** surface imessage onboarding and display numeric phone numbers ([#37478](https://github.com/okou-ai/okou/issues/37478)) ([706cc37](https://github.com/okou-ai/okou/commit/706cc37f73e9f00494cd07015422be92e20748ec))

## [0.989.3](https://github.com/okou-ai/okou/compare/app-v0.989.2...app-v0.989.3) (2026-10-01)


### Refactoring

* remove model catalog rollout compatibility ([#37457](https://github.com/okou-ai/okou/issues/37457)) ([bfdefb5](https://github.com/okou-ai/okou/commit/bfdefb56cc71e50764957c7f168584df7398c7b4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.532.2
    * @okouai/core bumped to 8.725.2

## [0.989.2](https://github.com/okou-ai/okou/compare/app-v0.989.1...app-v0.989.2) (2026-10-01)


### Documentation

* rotate api and app changelogs for 2026-10 ([#37446](https://github.com/okou-ai/okou/issues/37446)) ([a06ea1c](https://github.com/okou-ai/okou/commit/a06ea1c6a37ed97d74639b81dadc357fa3dc7a8f))

## [0.989.1](https://github.com/okou-ai/okou/compare/app-v0.989.0...app-v0.989.1) (2026-10-01)


### Refactoring

* remove expired deployment compatibility ([#37439](https://github.com/okou-ai/okou/issues/37439)) ([bc8e82f](https://github.com/okou-ai/okou/commit/bc8e82f9151022ce93cff17e29b4273752d61a1f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.532.1
    * @okouai/core bumped to 8.725.1
