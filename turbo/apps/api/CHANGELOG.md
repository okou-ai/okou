# Changelog

Older releases are archived by month:

- [2026-09](changelog/2026-09/CHANGELOG.md)
- [2026-08](changelog/2026-08/CHANGELOG.md)
- [2026-07](changelog/2026-07/CHANGELOG.md)
- [2026-06](changelog/2026-06/CHANGELOG.md)
- [2026-05](changelog/2026-05/CHANGELOG.md)
- [2026-04](changelog/2026-04/CHANGELOG.md)

## [1.709.1](https://github.com/okou-ai/okou/compare/api-v1.709.0...api-v1.709.1) (2026-10-05)


### Refactoring

* **api:** migrate scoped connector selections to immutable entries ([#37699](https://github.com/okou-ai/okou/issues/37699)) ([f413782](https://github.com/okou-ai/okou/commit/f4137823742879fcc8f74b476734d18e8480e15c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.321.2

## [1.709.0](https://github.com/okou-ai/okou/compare/api-v1.708.0...api-v1.709.0) (2026-10-05)


### Features

* **api:** prepare immutable catalog before hash-cas activation ([#37701](https://github.com/okou-ai/okou/issues/37701)) ([b8da8bd](https://github.com/okou-ai/okou/commit/b8da8bd6292a3a436f3f501316d2fa05770ec436))


### Refactoring

* **api:** read chat projections without historical runs ([#37765](https://github.com/okou-ai/okou/issues/37765)) ([dc7a9e7](https://github.com/okou-ai/okou/commit/dc7a9e7ef8b3c30ee3b1c828228bdd25b78e23c5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.3
    * @okouai/connectors bumped to 3.16.0
    * @okouai/core bumped to 8.732.1
    * @okouai/db bumped to 1.321.1
    * @okouai/pi-agent-runtime bumped to 1.46.9

## [1.708.0](https://github.com/okou-ai/okou/compare/api-v1.707.6...api-v1.708.0) (2026-10-05)


### Features

* **db:** add immutable catalog tables and a shared test catalog ([#37697](https://github.com/okou-ai/okou/issues/37697)) ([f24c015](https://github.com/okou-ai/okou/commit/f24c0158fb5d44fe002399bea74aaec8822bf2c0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.321.0

## [1.707.6](https://github.com/okou-ai/okou/compare/api-v1.707.5...api-v1.707.6) (2026-10-05)


### Bug Fixes

* **api:** consume unread state for external notification delivery ([#37751](https://github.com/okou-ai/okou/issues/37751)) ([caba8a3](https://github.com/okou-ai/okou/commit/caba8a39eea743b843142046f5d5ba588afdc710))


### Refactoring

* **api:** own guarded sandbox storage replay version reads ([#37760](https://github.com/okou-ai/okou/issues/37760)) ([2521e92](https://github.com/okou-ai/okou/commit/2521e9231ef2dff5bc147580d93bea8405f8c874))
* **api:** own initial sandbox storage receipt reads ([#37748](https://github.com/okou-ai/okou/issues/37748)) ([1fc92ce](https://github.com/okou-ai/okou/commit/1fc92ce471a5700c6eb4bae9cb144f435e3e60c2))
* retire claude code manual usage reset ([#37755](https://github.com/okou-ai/okou/issues/37755)) ([1855ed7](https://github.com/okou-ai/okou/commit/1855ed7f5d58c7aa931a6acc27f2fa375edc395f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.732.0
    * @okouai/db bumped to 1.320.6
    * @okouai/pi-agent-runtime bumped to 1.46.8

## [1.707.5](https://github.com/okou-ai/okou/compare/api-v1.707.4...api-v1.707.5) (2026-10-05)


### Bug Fixes

* **api:** default organization model mode to auto ([#37745](https://github.com/okou-ai/okou/issues/37745)) ([0d679ea](https://github.com/okou-ai/okou/commit/0d679eacd13a934d407b7ed19bb9c138d04859e5))
* **api:** refresh archive urls with less than four hours remaining ([#37735](https://github.com/okou-ai/okou/issues/37735)) ([b6e6d02](https://github.com/okou-ai/okou/commit/b6e6d02418c07f713a95c29313671a65f3a82643))


### Refactoring

* **api:** own connector account deletion-impact reads ([#37743](https://github.com/okou-ai/okou/issues/37743)) ([fb850a0](https://github.com/okou-ai/okou/commit/fb850a0aa034404f573a778563a97d39312453c5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.2
    * @okouai/core bumped to 8.731.0
    * @okouai/db bumped to 1.320.5
    * @okouai/pi-agent-runtime bumped to 1.46.7

## [1.707.4](https://github.com/okou-ai/okou/compare/api-v1.707.3...api-v1.707.4) (2026-10-05)


### Bug Fixes

* **api:** raise autonomous delegation budget to 32 ([#37737](https://github.com/okou-ai/okou/issues/37737)) ([f57a13f](https://github.com/okou-ai/okou/commit/f57a13f44233adb5b8469d0a039cb4befda9cf32))


### Refactoring

* **api:** own initial checkpoint run reads ([#37738](https://github.com/okou-ai/okou/issues/37738)) ([126a395](https://github.com/okou-ai/okou/commit/126a3957d91de7872daeaf892a8acb604b0ba0f6))
* **api:** own required terminal chat callback reads ([#37707](https://github.com/okou-ai/okou/issues/37707)) ([b190ff1](https://github.com/okou-ai/okou/commit/b190ff107eb5d387ee9b4eab6b42136b335a720d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.1
    * @okouai/core bumped to 8.730.2
    * @okouai/db bumped to 1.320.4
    * @okouai/pi-agent-runtime bumped to 1.46.6

## [1.707.3](https://github.com/okou-ai/okou/compare/api-v1.707.2...api-v1.707.3) (2026-10-05)


### Refactoring

* **api:** own agent builtin connector configuration writes ([#37729](https://github.com/okou-ai/okou/issues/37729)) ([2edb8d8](https://github.com/okou-ai/okou/commit/2edb8d8f0bde8bcf1ebb89388c08e31bcecdc9de))
* graduate fully rolled out feature switches ([#37721](https://github.com/okou-ai/okou/issues/37721)) ([62e6dd4](https://github.com/okou-ai/okou/commit/62e6dd43c07ccfd77517d6f653ab123a37aff89f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.730.1
    * @okouai/db bumped to 1.320.3
    * @okouai/pi-agent-runtime bumped to 1.46.5

## [1.707.2](https://github.com/okou-ai/okou/compare/api-v1.707.1...api-v1.707.2) (2026-10-05)


### Bug Fixes

* **api:** suppress web push for channel-triggered chat runs ([#37726](https://github.com/okou-ai/okou/issues/37726)) ([6e471ef](https://github.com/okou-ai/okou/commit/6e471efd37b31b216bfa35ea0ad5681142f087bb))


### Refactoring

* **api:** own completion initial run read ([#37732](https://github.com/okou-ai/okou/issues/37732)) ([6f073f9](https://github.com/okou-ai/okou/commit/6f073f9cf22637cceaa7715ed206f7014e511e64))

## [1.707.1](https://github.com/okou-ai/okou/compare/api-v1.707.0...api-v1.707.1) (2026-10-05)


### Performance Improvements

* **api:** isolate declaration-heavy typecheck stages ([#37722](https://github.com/okou-ai/okou/issues/37722)) ([2f0d4c2](https://github.com/okou-ai/okou/commit/2f0d4c25f7935c88f362192a38dffb622e197686))

## [1.707.0](https://github.com/okou-ai/okou/compare/api-v1.706.5...api-v1.707.0) (2026-10-05)


### Features

* enable phone group history, message sharing and social jobs globally ([#37716](https://github.com/okou-ai/okou/issues/37716)) ([b1ec157](https://github.com/okou-ai/okou/commit/b1ec157db9ded38688563e0f153df0ab8364802e))


### Refactoring

* **api:** own completion postcommit callback read ([#37717](https://github.com/okou-ai/okou/issues/37717)) ([caddf45](https://github.com/okou-ai/okou/commit/caddf459b1af9dedd4ab9ecc99d96bf228b720b0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.730.0
    * @okouai/db bumped to 1.320.2
    * @okouai/pi-agent-runtime bumped to 1.46.4

## [1.706.5](https://github.com/okou-ai/okou/compare/api-v1.706.4...api-v1.706.5) (2026-10-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.729.0
    * @okouai/db bumped to 1.320.1
    * @okouai/pi-agent-runtime bumped to 1.46.3

## [1.706.4](https://github.com/okou-ai/okou/compare/api-v1.706.3...api-v1.706.4) (2026-10-05)


### Refactoring

* **api:** own connector account rename transaction queries ([#37704](https://github.com/okou-ai/okou/issues/37704)) ([0751216](https://github.com/okou-ai/okou/commit/075121653b2d7b1ab8d8a172b86ac287076f90b1))
* **api:** own pi phase2 recovery reads ([#37710](https://github.com/okou-ai/okou/issues/37710)) ([1931f04](https://github.com/okou-ai/okou/commit/1931f04221f64f604ccb1c6791c94bef111c94ed))

## [1.706.3](https://github.com/okou-ai/okou/compare/api-v1.706.2...api-v1.706.3) (2026-10-04)


### Refactoring

* **api:** own active run connector check registration reads ([#37690](https://github.com/okou-ai/okou/issues/37690)) ([8caba6b](https://github.com/okou-ai/okou/commit/8caba6bb173c6390afff8a215678ae19909cfd69))
* **api:** own deleted-thread callback termination writes ([#37695](https://github.com/okou-ai/okou/issues/37695)) ([e546af7](https://github.com/okou-ai/okou/commit/e546af71edab297187b338fb7f592e4808cd27d7))
* **api:** own http callback dispatch and bookkeeping ([#37698](https://github.com/okou-ai/okou/issues/37698)) ([1a784e5](https://github.com/okou-ai/okou/commit/1a784e5cfca33db01b05696f140e573a1f9bc2e6))

## [1.706.2](https://github.com/okou-ai/okou/compare/api-v1.706.1...api-v1.706.2) (2026-10-04)


### Bug Fixes

* **api:** arbitrate concurrent get started reward conflicts ([#37683](https://github.com/okou-ai/okou/issues/37683)) ([1261224](https://github.com/okou-ai/okou/commit/1261224f046ba759c162f5e35b9aebdc65334023))


### Refactoring

* **api:** own internal callback delivery bookkeeping ([#37685](https://github.com/okou-ai/okou/issues/37685)) ([0fe7f83](https://github.com/okou-ai/okou/commit/0fe7f8334df0621ecd9bb867f00249b18de93a92))
* **api:** own thread read facts and cursor writes ([#37686](https://github.com/okou-ai/okou/issues/37686)) ([b89a709](https://github.com/okou-ai/okou/commit/b89a7096486fad833b2bb6e9081d141202fa699d))

## [1.706.1](https://github.com/okou-ai/okou/compare/api-v1.706.0...api-v1.706.1) (2026-10-04)


### Refactoring

* **api:** own stored connector check snapshots ([#37677](https://github.com/okou-ai/okou/issues/37677)) ([a1173f3](https://github.com/okou-ai/okou/commit/a1173f3cfbdf2af4c28c5007d9f26af82bfb158d))

## [1.706.0](https://github.com/okou-ai/okou/compare/api-v1.705.11...api-v1.706.0) (2026-10-04)


### Features

* add organization-gated thread muting ([#37681](https://github.com/okou-ai/okou/issues/37681)) ([267fa71](https://github.com/okou-ai/okou/commit/267fa71b3cf85592fcbb7b644cdfefc1f5d642ff))


### Bug Fixes

* **agentphone:** parse inbound webhook message identity correctly ([#37682](https://github.com/okou-ai/okou/issues/37682)) ([26e1e57](https://github.com/okou-ai/okou/commit/26e1e57c16f13ecea61441b52b30927e8f79a674))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.0
    * @okouai/core bumped to 8.728.0
    * @okouai/db bumped to 1.320.0
    * @okouai/pi-agent-runtime bumped to 1.46.2

## [1.705.11](https://github.com/okou-ai/okou/compare/api-v1.705.10...api-v1.705.11) (2026-10-04)


### Bug Fixes

* bound firewall auth caching by the refresh deadline ([#37674](https://github.com/okou-ai/okou/issues/37674)) ([0914700](https://github.com/okou-ai/okou/commit/0914700abff4b3ecbac7a4015655355a28bf7216))


### Refactoring

* **api:** own cancellation mutations in the terminal command ([#37678](https://github.com/okou-ai/okou/issues/37678)) ([f160c8f](https://github.com/okou-ai/okou/commit/f160c8fb16730274007f036f1d0b08d09120937c))
* **api:** own independent run metadata writes ([#37675](https://github.com/okou-ai/okou/issues/37675)) ([f07cc4e](https://github.com/okou-ai/okou/commit/f07cc4e01fd2c10e27c7187afffa0bbfde563c05))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.536.2
    * @okouai/core bumped to 8.727.2
    * @okouai/db bumped to 1.319.4
    * @okouai/pi-agent-runtime bumped to 1.46.1

## [1.705.10](https://github.com/okou-ai/okou/compare/api-v1.705.9...api-v1.705.10) (2026-10-04)


### Refactoring

* **api:** own connector credential readiness reads ([#37667](https://github.com/okou-ai/okou/issues/37667)) ([e85733c](https://github.com/okou-ai/okou/commit/e85733c0386991d3661004c39c299f5c1283b615))
* **api:** own runner cancellation reconciliation reads ([#37672](https://github.com/okou-ai/okou/issues/37672)) ([6495346](https://github.com/okou-ai/okou/commit/6495346a3dffbca3c6929f81eb7a74e3d987a3d5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/pi-agent-runtime bumped to 1.46.0

## [1.705.9](https://github.com/okou-ai/okou/compare/api-v1.705.8...api-v1.705.9) (2026-10-03)


### Bug Fixes

* **api:** restore selected eager credential observations ([#37659](https://github.com/okou-ai/okou/issues/37659)) ([840e582](https://github.com/okou-ai/okou/commit/840e582a70c6fd66c76faea29d32fc2a04c4163e))


### Refactoring

* **api:** own connector catalog compatibility status reads ([#37656](https://github.com/okou-ai/okou/issues/37656)) ([5fbafec](https://github.com/okou-ai/okou/commit/5fbafec3e7d26fca09d55bbab962ef17881aea11))

## [1.705.8](https://github.com/okou-ai/okou/compare/api-v1.705.7...api-v1.705.8) (2026-10-03)


### Bug Fixes

* **api:** limit eager connector credential decryption ([#37645](https://github.com/okou-ai/okou/issues/37645)) ([ce2b92d](https://github.com/okou-ai/okou/commit/ce2b92db0a73bae765d22c82a3c3c28c87cd482f))


### Refactoring

* **api:** own chat remote access configuration and runner discovery ([#37644](https://github.com/okou-ai/okou/issues/37644)) ([c2723f0](https://github.com/okou-ai/okou/commit/c2723f0e51f565dec14a89642b586fd8a26005da))


### Performance Improvements

* **api:** batch organization and member preload statements ([#37643](https://github.com/okou-ai/okou/issues/37643)) ([837395f](https://github.com/okou-ai/okou/commit/837395f576a7a7a6886d7cd989a7cc0aba3c1990))
* **api:** split pending tick replacement attribution ([#37652](https://github.com/okou-ai/okou/issues/37652)) ([4ad7491](https://github.com/okou-ai/okou/commit/4ad7491ac5f455f85bce581d315dbb15135b9719))

## [1.705.7](https://github.com/okou-ai/okou/compare/api-v1.705.6...api-v1.705.7) (2026-10-03)


### Refactoring

* **api:** own ssh connection reads in the host-key reset command ([#37636](https://github.com/okou-ai/okou/issues/37636)) ([d8f98b9](https://github.com/okou-ai/okou/commit/d8f98b97b4cfd3d98ebf42043a3c2b0338a59e62))

## [1.705.6](https://github.com/okou-ai/okou/compare/api-v1.705.5...api-v1.705.6) (2026-10-03)


### Refactoring

* **api:** own vnc connection transaction queries in commands ([#37623](https://github.com/okou-ai/okou/issues/37623)) ([29cdbb1](https://github.com/okou-ai/okou/commit/29cdbb1bf358a4b0d4b0838f52a883d4d43b2602))


### Performance Improvements

* **api:** observe shared connector context behind custom value wait ([#37629](https://github.com/okou-ai/okou/issues/37629)) ([df5d734](https://github.com/okou-ai/okou/commit/df5d734feb9b8638e331e5136f4a0a556e922e87))

## [1.705.5](https://github.com/okou-ai/okou/compare/api-v1.705.4...api-v1.705.5) (2026-10-03)


### Bug Fixes

* **api:** skip expected autonomy rejection logs ([#37622](https://github.com/okou-ai/okou/issues/37622)) ([e449777](https://github.com/okou-ai/okou/commit/e449777cc2146db1407d5099be6f9db0f01cbc46))


### Performance Improvements

* **api:** prefetch the user memory storage root ([#37619](https://github.com/okou-ai/okou/issues/37619)) ([234d66d](https://github.com/okou-ai/okou/commit/234d66d11aec993f5d1db1969a1fca006622f936))

## [1.705.4](https://github.com/okou-ai/okou/compare/api-v1.705.3...api-v1.705.4) (2026-10-03)


### Bug Fixes

* preserve pi length completion and cap luna effort at xhigh ([#37607](https://github.com/okou-ai/okou/issues/37607)) ([acb1094](https://github.com/okou-ai/okou/commit/acb10941881de41850f70ab3a4930f22041812b0))


### Refactoring

* **api:** own computer use authorization database access in commands ([#37585](https://github.com/okou-ai/okou/issues/37585)) ([39a7e36](https://github.com/okou-ai/okou/commit/39a7e364c559f99e5b5a1d222e782f5bae4fe424))


### Performance Improvements

* **api:** capture model credentials and pricing in run context ([#37602](https://github.com/okou-ai/okou/issues/37602)) ([d3843ad](https://github.com/okou-ai/okou/commit/d3843adaabe7686f55c1340d86ec37bbb32b32e9))
* **api:** share credit and member metadata context snapshots ([#37604](https://github.com/okou-ai/okou/issues/37604)) ([a26aee7](https://github.com/okou-ai/okou/commit/a26aee7be441cefb159a4bf2bd943a3c1f7ae8c5))
* **api:** start context preload before authorization and enqueue ([#37617](https://github.com/okou-ai/okou/issues/37617)) ([57b1af7](https://github.com/okou-ai/okou/commit/57b1af7034d31ff815ce1a0afd51e0268f118c1a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.319.3

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
