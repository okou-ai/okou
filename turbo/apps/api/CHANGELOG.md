# Changelog

Older releases are archived by month:

- [2026-10](changelog/2026-10/CHANGELOG.md)
- [2026-09](changelog/2026-09/CHANGELOG.md)
- [2026-08](changelog/2026-08/CHANGELOG.md)
- [2026-07](changelog/2026-07/CHANGELOG.md)
- [2026-06](changelog/2026-06/CHANGELOG.md)
- [2026-05](changelog/2026-05/CHANGELOG.md)
- [2026-04](changelog/2026-04/CHANGELOG.md)

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
