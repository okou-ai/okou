# Changelog

Older releases are archived by month:

- [2026-09](changelog/2026-09/CHANGELOG.md)
- [2026-08](changelog/2026-08/CHANGELOG.md)
- [2026-07](changelog/2026-07/CHANGELOG.md)
- [2026-06](changelog/2026-06/CHANGELOG.md)
- [2026-05](changelog/2026-05/CHANGELOG.md)
- [2026-04](changelog/2026-04/CHANGELOG.md)

## [1.718.0](https://github.com/okou-ai/okou/compare/api-v1.717.1...api-v1.718.0) (2026-10-09)


### Features

* make pi memory free with an openrouter preset ([#38290](https://github.com/okou-ai/okou/issues/38290)) ([5768ad5](https://github.com/okou-ai/okou/commit/5768ad5ef7ce0808c6cde85a9eb628be7e8aeb57))
* **notify:** add morning brief notification kind ([#38308](https://github.com/okou-ai/okou/issues/38308)) ([31d9036](https://github.com/okou-ai/okou/commit/31d9036dcb2e6a005ebbdb250a3b216ce713c51c))


### Bug Fixes

* **api:** remove chat input and auxiliary write latency warnings ([#38318](https://github.com/okou-ai/okou/issues/38318)) ([7a61cc2](https://github.com/okou-ai/okou/commit/7a61cc21582c21782ac307a7a945941d334bcf65))
* **api:** remove cloudflare mutation transaction retries ([#38282](https://github.com/okou-ai/okou/issues/38282)) ([d99e140](https://github.com/okou-ai/okou/commit/d99e140bd25233b4e009b8a074aaf9b63e8b164a))
* stop reporting handled clerk ui and invalid workflow payload errors ([#38299](https://github.com/okou-ai/okou/issues/38299)) ([d138629](https://github.com/okou-ai/okou/commit/d13862990122a1309790326f956e5b093faa73ad))


### Documentation

* consolidate official morning brief contracts ([#38297](https://github.com/okou-ai/okou/issues/38297)) ([1b853f2](https://github.com/okou-ai/okou/commit/1b853f27e087c5e3e5ba7a8d6607333079760826))


### Refactoring

* **api:** own chat-run-finished budget and receipt reads ([#38271](https://github.com/okou-ai/okou/issues/38271)) ([424678d](https://github.com/okou-ai/okou/commit/424678d61fb1c53c073df6ea7d07f30796a0d25e))
* **api:** own connector account default-transition writes ([#38276](https://github.com/okou-ai/okou/issues/38276)) ([9aae815](https://github.com/okou-ai/okou/commit/9aae815c4a30cea1f89ae133c54d5ed9922a3dac))
* **api:** own custom oauth state preview reads ([#38189](https://github.com/okou-ai/okou/issues/38189)) ([91a7384](https://github.com/okou-ai/okou/commit/91a7384611dc0fc6d09fe30462e0a6674ca4100f))
* **api:** own pi memory provider admission ([#38292](https://github.com/okou-ai/okou/issues/38292)) ([37d4265](https://github.com/okou-ai/okou/commit/37d426591dcb5d7aff864044468ea2148d89b6d1))
* **api:** own pi memory scheduling and claim transactions ([#38269](https://github.com/okou-ai/okou/issues/38269)) ([cdeec87](https://github.com/okou-ai/okou/commit/cdeec8712c65b885ed8b9c8e62c50a0127d6783f))
* **api:** own stripe invoice fanout transaction ([#38305](https://github.com/okou-ai/okou/issues/38305)) ([0826bc3](https://github.com/okou-ai/okou/commit/0826bc32f2787c00bec30e1f0e6b86a18c27c04e))
* **api:** own workflow visibility, profile and thread reads ([#38237](https://github.com/okou-ai/okou/issues/38237)) ([1fec562](https://github.com/okou-ai/okou/commit/1fec56212453e7e84125f20336924138551ad793))
* **api:** own workflow webhook dispatch reads ([#38280](https://github.com/okou-ai/okou/issues/38280)) ([3dcf096](https://github.com/okou-ai/okou/commit/3dcf096997cdd5448a74df524afba9a2ac46df91))
* **api:** remove mcp input snapshot transaction ([#38287](https://github.com/okou-ai/okou/issues/38287)) ([803ede6](https://github.com/okou-ai/okou/commit/803ede641fb73f38a56c8d799d25bbe14d4def6a))
* **api:** use bounded s3 command for stage1 history ([#38316](https://github.com/okou-ai/okou/issues/38316)) ([6bd5cc8](https://github.com/okou-ai/okou/commit/6bd5cc8ca6e6e6613c84f8791a0b5144f30426de))
* **artifacts:** remove video poster extraction ([#38146](https://github.com/okou-ai/okou/issues/38146)) ([641cf0d](https://github.com/okou-ai/okou/commit/641cf0ddff6c631cf94386e6c3d26c78395c63aa))
* **artifacts:** use artifact identity for google drive uploads ([#38300](https://github.com/okou-ai/okou/issues/38300)) ([e223f5e](https://github.com/okou-ai/okou/commit/e223f5e45fd22cdd729f84f075686ec5afb24b6e))
* retire organization usage allowance ([#37971](https://github.com/okou-ai/okou/issues/37971)) ([2659878](https://github.com/okou-ai/okou/commit/26598788903fb817edd71d82ccbdfcd66cfa3a0a))
* **ssh:** make metadata rename an atomic statement ([#38284](https://github.com/okou-ai/okou/issues/38284)) ([9da771d](https://github.com/okou-ai/okou/commit/9da771dd0928a7a83f81a418ec3a93cc3da17f0d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.543.0
    * @okouai/core bumped to 8.737.2
    * @okouai/db bumped to 1.326.2
    * @okouai/pi-agent-runtime bumped to 1.48.0

## [1.717.1](https://github.com/okou-ai/okou/compare/api-v1.717.0...api-v1.717.1) (2026-10-09)


### CI

* remove production release catalog sync ([#38230](https://github.com/okou-ai/okou/issues/38230)) ([1a51a67](https://github.com/okou-ai/okou/commit/1a51a6731107a55a1adc4d34160860f186c96758))


### Refactoring

* **api:** derive connector prompts from bootstrap authorization ([#38228](https://github.com/okou-ai/okou/issues/38228)) ([4c016da](https://github.com/okou-ai/okou/commit/4c016da6694e286c9a471536b020f0dcd6ace8cd))
* **api:** retire batch 017 private test fixtures ([#38235](https://github.com/okou-ai/okou/issues/38235)) ([a218941](https://github.com/okou-ai/okou/commit/a2189418b48f7dab6b8d5b9237f7d4c6bfd20d4e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.542.1
    * @okouai/core bumped to 8.737.1
    * @okouai/db bumped to 1.326.1
    * @okouai/pi-agent-runtime bumped to 1.47.1

## [1.717.0](https://github.com/okou-ai/okou/compare/api-v1.716.0...api-v1.717.0) (2026-10-09)


### Features

* prepare model identity compatibility without switching writes ([#38092](https://github.com/okou-ai/okou/issues/38092)) ([21177df](https://github.com/okou-ai/okou/commit/21177dfd37bc19114098a628a094adb67fb60db0))


### Bug Fixes

* **host:** prepare canonical deployment delivery authority ([#38212](https://github.com/okou-ai/okou/issues/38212)) ([bd8b130](https://github.com/okou-ai/okou/commit/bd8b13065d6b8ce406c3c7659f6634528f794913))


### Refactoring

* **api:** finish storage worker and timestamp ownership ([#38194](https://github.com/okou-ai/okou/issues/38194)) ([4729e51](https://github.com/okou-ai/okou/commit/4729e51f8cc5261e1badcd7cd96b14b82b1918d7))
* **api:** own atomic pi memory stage1 result commits ([#38202](https://github.com/okou-ai/okou/issues/38202)) ([bf452e6](https://github.com/okou-ai/okou/commit/bf452e611c290a8284fb44dcbfcb8f213529df8d))
* **api:** own automation watch source queries ([#38203](https://github.com/okou-ai/okou/issues/38203)) ([5a9c95d](https://github.com/okou-ai/okou/commit/5a9c95daa2ae539adb63ba12f2213e40fd2023f7))
* **api:** own hosted-site reads and allocation queries ([#38218](https://github.com/okou-ai/okou/issues/38218)) ([2c1f7e7](https://github.com/okou-ai/okou/commit/2c1f7e7477a5ad5a72e2346bc78df2153c499d1c))
* **api:** own morning brief preference reads ([#38211](https://github.com/okou-ai/okou/issues/38211)) ([e421739](https://github.com/okou-ai/okou/commit/e42173971274448bcc8afb541cc4b7208bfe80e2))
* **api:** own official catalog execution reads ([#38195](https://github.com/okou-ai/okou/issues/38195)) ([7fad614](https://github.com/okou-ai/okou/commit/7fad61491780e3eb0d1be79353e6ec1ef056160f))
* **api:** own official result email callback sources ([#38220](https://github.com/okou-ai/okou/issues/38220)) ([21abaa2](https://github.com/okou-ai/okou/commit/21abaa2843c193c4928ce7e907f16feb529d2db2))
* **api:** own parallel agent connector scope reads ([#38117](https://github.com/okou-ai/okou/issues/38117)) ([7fe8278](https://github.com/okou-ai/okou/commit/7fe8278fb7dc3581f50bf8d77d7cd19fbb9db8e0))
* **api:** own pi maintenance preparation snapshots ([#38205](https://github.com/okou-ai/okou/issues/38205)) ([eb2214d](https://github.com/okou-ai/okou/commit/eb2214d14903c83b68e06518debf70dabad82b3b))
* **api:** own pi memory maintenance admission transactions ([#38214](https://github.com/okou-ai/okou/issues/38214)) ([aa2cbc3](https://github.com/okou-ai/okou/commit/aa2cbc3700fbad19a43f3eef1492bca094e7523a))
* **api:** own pi memory phase2 claim transaction ([#38055](https://github.com/okou-ai/okou/issues/38055)) ([b917942](https://github.com/okou-ai/okou/commit/b91794262fa14780372d3cc5bb5c1b1fddbf18b7))
* **api:** own pi memory stage 1 preflight queries ([#38226](https://github.com/okou-ai/okou/issues/38226)) ([1cd9eff](https://github.com/okou-ai/okou/commit/1cd9eff56f912f5c177c6fe63e6ab19f2ee3693a))
* **api:** own pi memory stage1 credential commands ([#38210](https://github.com/okou-ai/okou/issues/38210)) ([9ee013b](https://github.com/okou-ai/okou/commit/9ee013bab9e2f3a53e2d063816955b84c6d66fb5))
* **api:** own remaining hosted-site transaction queries ([#38225](https://github.com/okou-ai/okou/issues/38225)) ([7982faf](https://github.com/okou-ai/okou/commit/7982faf50f4936909ccc6d0c107d371e74c613d4))
* **api:** own runner notification preference reads ([#38222](https://github.com/okou-ai/okou/issues/38222)) ([8048b62](https://github.com/okou-ai/okou/commit/8048b6290029e27a1f1fd36a0dd04d24e8e5eb85))
* **api:** own workflow automation enable and stripe commits ([#38191](https://github.com/okou-ai/okou/issues/38191)) ([b07bc3a](https://github.com/okou-ai/okou/commit/b07bc3a54c75efe9205afc7614d3c8f936a32d67))
* **api:** own workflow catalog list and deletion queries ([#38216](https://github.com/okou-ai/okou/issues/38216)) ([774706e](https://github.com/okou-ai/okou/commit/774706e3d0b05ff5358c06ed6bc41df2824185c6))
* **api:** own workflow copy publication ([#38223](https://github.com/okou-ai/okou/issues/38223)) ([b4c06fd](https://github.com/okou-ai/okou/commit/b4c06fde2d6d95b129f63b83661e488e49dd71f2))
* **api:** remove oauth contract hash bindings ([#38190](https://github.com/okou-ai/okou/issues/38190)) ([3e0f689](https://github.com/okou-ai/okou/commit/3e0f689475709a63a8ed534d11f34e583e8ac3f6))
* **api:** separate automation lifecycle from event dispatch ([#38199](https://github.com/okou-ai/okou/issues/38199)) ([d0e80d5](https://github.com/okou-ai/okou/commit/d0e80d56313dbbfb5a1c11d72c1e44eb3b0a357b))
* **api:** statically own official workflow reconciliation ([#38208](https://github.com/okou-ai/okou/issues/38208)) ([628d2e8](https://github.com/okou-ai/okou/commit/628d2e83be3dcf21b7806bb482c75bcb73f904e3))
* **api:** use static bounded reads for memory summaries ([#38204](https://github.com/okou-ai/okou/issues/38204)) ([13d9bc2](https://github.com/okou-ai/okou/commit/13d9bc248c60f520893f145c9e5ed38617f89e56))
* remove expired deployment compatibility ([#38219](https://github.com/okou-ai/okou/issues/38219)) ([303f42b](https://github.com/okou-ai/okou/commit/303f42bafd0d70928c477dc87a5f25fdc00db6d7))
* retire deepseek memory execution route ([#38193](https://github.com/okou-ai/okou/issues/38193)) ([dd70bd4](https://github.com/okou-ai/okou/commit/dd70bd4b01bd2ee0dbfbe748940544e5e072bf5a))
* retire generic run checkpoints from completion ([#38147](https://github.com/okou-ai/okou/issues/38147)) ([e8002cf](https://github.com/okou-ai/okou/commit/e8002cfcc9995e2b245947dbf25a9f9dd73f1ca0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.542.0
    * @okouai/core bumped to 8.737.0
    * @okouai/db bumped to 1.326.0
    * @okouai/pi-agent-runtime bumped to 1.47.0

## [1.716.0](https://github.com/okou-ai/okou/compare/api-v1.715.0...api-v1.716.0) (2026-10-08)


### Features

* **notify:** add agent-controlled mail notifications ([#38093](https://github.com/okou-ai/okou/issues/38093)) ([702c270](https://github.com/okou-ai/okou/commit/702c270169c8de738aa9f47ed5480ed377edcfda))


### Refactoring

* **api:** inline web input transaction writes ([#38183](https://github.com/okou-ai/okou/issues/38183)) ([4d6305f](https://github.com/okou-ai/okou/commit/4d6305f2693f022cc05f6d4d3d9c02086cfbd443))
* **api:** own agent instruction lifecycle transactions ([#38172](https://github.com/okou-ai/okou/issues/38172)) ([e15eeea](https://github.com/okou-ai/okou/commit/e15eeeac9ea25d50335d408ccec3572072e3e6e1))
* **api:** own official workflow reconciliation transactions ([#38170](https://github.com/okou-ai/okou/issues/38170)) ([7fdd681](https://github.com/okou-ai/okou/commit/7fdd6812fb11c08d244b3eca9ee18d7edf067112))
* **api:** own pi memory stage1 accounting ([#38053](https://github.com/okou-ai/okou/issues/38053)) ([2371910](https://github.com/okou-ai/okou/commit/2371910b887fca12b4220ae7941d84a588e3c656))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.541.0
    * @okouai/core bumped to 8.736.0
    * @okouai/db bumped to 1.325.0
    * @okouai/pi-agent-runtime bumped to 1.46.27

## [1.715.0](https://github.com/okou-ai/okou/compare/api-v1.714.1...api-v1.715.0) (2026-10-08)


### Features

* **desktop:** enforce minimum versions with automatic required upgrades ([#38115](https://github.com/okou-ai/okou/issues/38115)) ([ae3a5b2](https://github.com/okou-ai/okou/commit/ae3a5b291a085bd900c21689563c74240c4123cb))


### Bug Fixes

* **api:** bind stripe customers with an atomic upsert ([#38126](https://github.com/okou-ai/okou/issues/38126)) ([282b045](https://github.com/okou-ai/okou/commit/282b045539de6636eea6691581f5cff0626ff235))
* **api:** grant onboarding credits as personal usage packs ([#38059](https://github.com/okou-ai/okou/issues/38059)) ([6798f0a](https://github.com/okou-ai/okou/commit/6798f0a0a233331d18f384ec9d81608c3bd060f1))
* **api:** use luna with current memory owner credentials ([#38129](https://github.com/okou-ai/okou/issues/38129)) ([77357ab](https://github.com/okou-ai/okou/commit/77357abdb29ce96b2caf9ee679299602757844dc))
* **billing:** keep member usage packs nonnegative ([#38071](https://github.com/okou-ai/okou/issues/38071)) ([532c7f8](https://github.com/okou-ai/okou/commit/532c7f813cc2e824ff4fa487f251786848b8d752))
* suppress pwa push while the user is foreground in the same org ([#38091](https://github.com/okou-ai/okou/issues/38091)) ([22f89a5](https://github.com/okou-ai/okou/commit/22f89a5c8b69990bb3834c7678acb25f00d1c823))
* **voice:** separate segment transcription from final polish ([#38082](https://github.com/okou-ai/okou/issues/38082)) ([1c7cb86](https://github.com/okou-ai/okou/commit/1c7cb86855d50504a57a6fcb86b9357a5965e3de))


### Refactoring

* **api:** encapsulate continuation and template preparation ([#38155](https://github.com/okou-ai/okou/issues/38155)) ([207088f](https://github.com/okou-ai/okou/commit/207088f19c5df05553c233d8a0ccbaf195fb0314))
* **api:** extract integration and session rotation prompts ([#38119](https://github.com/okou-ai/okou/issues/38119)) ([8418b0d](https://github.com/okou-ai/okou/commit/8418b0d73d57b2e6f2d18234e262f9527ed9e006))
* **api:** localize credit checkout database ownership ([#38133](https://github.com/okou-ai/okou/issues/38133)) ([c903605](https://github.com/okou-ai/okou/commit/c903605cc80af3f68c9896ccf65203a53adcd9ec)), closes [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** make plan purchase exclusion a pure sql builder ([#38151](https://github.com/okou-ai/okou/issues/38151)) ([669d03a](https://github.com/okou-ai/okou/commit/669d03a9cb7ad9b8db0f8c936dbef3a4c7b2f823)), closes [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own official workflow reconciliation commands ([#38056](https://github.com/okou-ai/okou/issues/38056)) ([1f88668](https://github.com/okou-ai/okou/commit/1f8866885baf48dcbfbf11cca37def52529cfc49))
* **api:** own private artifact preview cache operations ([#38156](https://github.com/okou-ai/okou/issues/38156)) ([b2d4bb3](https://github.com/okou-ai/okou/commit/b2d4bb32f4c1c3915edb2608998711c4b3a68bb1))
* **api:** own private artifact reads and reference resolution ([#38078](https://github.com/okou-ai/okou/issues/38078)) ([88d0941](https://github.com/okou-ai/okou/commit/88d0941e21a956a49efe69e8d7cf5b88b21de381))
* **api:** own storage commit publication ([#38154](https://github.com/okou-ai/okou/issues/38154)) ([bcc9507](https://github.com/okou-ai/okou/commit/bcc9507ad9b444b85abd45634642a452c10b328b))
* **api:** own storage preparation admission reads ([#38039](https://github.com/okou-ai/okou/issues/38039)) ([d6a2727](https://github.com/okou-ai/okou/commit/d6a27272a7406aa8aca409aed4ecc23a855b1f7e))
* **api:** own stripe deauthorization ingress ([#38142](https://github.com/okou-ai/okou/issues/38142)) ([5d0324c](https://github.com/okou-ai/okou/commit/5d0324c25bfd050409a0694d98d820b58252c5e0))
* **api:** own volume publication fences and cleanup ([#38042](https://github.com/okou-ai/okou/issues/38042)) ([8b2e3d0](https://github.com/okou-ai/okou/commit/8b2e3d09603ee6c56c6e62a64f86cc4720b0ba1f))
* **api:** publish artifact shares outside database transactions ([#38038](https://github.com/okou-ai/okou/issues/38038)) ([1a317a4](https://github.com/okou-ai/okou/commit/1a317a4964ad8906894e150b13b21b3373871040))
* **api:** resolve queued connector permissions from current catalog ([#38066](https://github.com/okou-ai/okou/issues/38066)) ([865afb7](https://github.com/okou-ai/okou/commit/865afb7a05d413c9db56713035a373ebaa767672))
* **api:** use client-only platform realtime token exchange ([#38105](https://github.com/okou-ai/okou/issues/38105)) ([0fdfb57](https://github.com/okou-ai/okou/commit/0fdfb57b88d655219e84f18050a88362071cdd41))
* **api:** use fixed commands for canonical input imports ([#38062](https://github.com/okou-ai/okou/issues/38062)) ([f8299d6](https://github.com/okou-ai/okou/commit/f8299d6a5d49657caf7ba1c033f1b33cb52c1ffb))
* prepare payload-independent connector catalog api ([#38099](https://github.com/okou-ai/okou/issues/38099)) ([9d3a1b4](https://github.com/okou-ai/okou/commit/9d3a1b406f1f44b224c33046162df01a77e035f8))
* remove pi openrouter chat completions feature switch ([#38096](https://github.com/okou-ai/okou/issues/38096)) ([a635ec3](https://github.com/okou-ai/okou/commit/a635ec3afa20cdb5df9c8125afe6cec24ef53e16))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.540.0
    * @okouai/core bumped to 8.735.2
    * @okouai/db bumped to 1.324.2
    * @okouai/pi-agent-runtime bumped to 1.46.26

## [1.714.1](https://github.com/okou-ai/okou/compare/api-v1.714.0...api-v1.714.1) (2026-10-08)


### Bug Fixes

* **api:** handle attached schedules in billing previews ([#38065](https://github.com/okou-ai/okou/issues/38065)) ([f590586](https://github.com/okou-ai/okou/commit/f5905861eb85c3492d072255ee2fea35118ba48f))
* distinguish shared instructions from personal memory ([#38072](https://github.com/okou-ai/okou/issues/38072)) ([ce08549](https://github.com/okou-ai/okou/commit/ce085495f43d88f6d6197532e6c15ca634889ae2))
* **maps:** explain oversized grounding responses ([#38046](https://github.com/okou-ai/okou/issues/38046)) ([9ea9cde](https://github.com/okou-ai/okou/commit/9ea9cde34b01d89bb258b44250ce4b17260cf37c)), closes [#36791](https://github.com/okou-ai/okou/issues/36791)


### Refactoring

* **api:** claim official workflow work atomically ([#38041](https://github.com/okou-ai/okou/issues/38041)) ([b6befac](https://github.com/okou-ai/okou/commit/b6befacb367f900e0da9c1159bfa60e66a34d6f9))
* **api:** give catalog commands database ownership ([#38037](https://github.com/okou-ai/okou/issues/38037)) ([6f7b47c](https://github.com/okou-ai/okou/commit/6f7b47c2bd8892d2ea82908114a5e36bf0597819))
* **api:** own official workflow installation writes ([#38050](https://github.com/okou-ai/okou/issues/38050)) ([cfe934c](https://github.com/okou-ai/okou/commit/cfe934c79e7220da9c9a7913186ebd8ccbc5036a))
* **api:** own pi memory phase2 terminal observation ([#38054](https://github.com/okou-ai/okou/issues/38054)) ([e84363a](https://github.com/okou-ai/okou/commit/e84363a75b9e0236edf8e96c27f1b9a1d938cb08))
* **api:** own pi memory quota reads ([#38061](https://github.com/okou-ai/okou/issues/38061)) ([e75dacd](https://github.com/okou-ai/okou/commit/e75dacdb59c2bdc019b28f8742c3d19c7824bde8))
* **api:** own skill storage publication transactions ([#38060](https://github.com/okou-ai/okou/issues/38060)) ([36ca5da](https://github.com/okou-ai/okou/commit/36ca5da3245592c9c3c422311458d6ccf24340a2))
* **api:** own workflow automation reads ([#38048](https://github.com/okou-ai/okou/issues/38048)) ([a01abf6](https://github.com/okou-ai/okou/commit/a01abf616a49a15fb23b7fdbaeceeb548c5f9521))
* **api:** use canonical official workflow queue contexts ([#38049](https://github.com/okou-ai/okou/issues/38049)) ([76c17bc](https://github.com/okou-ai/okou/commit/76c17bcc4048d9aff4907477012172c364a66e5c))
* remove agent responsibility setup feature switch ([#38069](https://github.com/okou-ai/okou/issues/38069)) ([bbb313e](https://github.com/okou-ai/okou/commit/bbb313e561cf6904565d5b91e7e227e2016557ee))


### Performance Improvements

* **ssh:** narrow cloudflare rename locks and reference reloads ([#38003](https://github.com/okou-ai/okou/issues/38003)) ([191ca92](https://github.com/okou-ai/okou/commit/191ca92a931d80acc4a55b750b3b5275863e08df))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.539.1
    * @okouai/core bumped to 8.735.1
    * @okouai/db bumped to 1.324.1
    * @okouai/pi-agent-runtime bumped to 1.46.25

## [1.714.0](https://github.com/okou-ai/okou/compare/api-v1.713.2...api-v1.714.0) (2026-10-08)


### Features

* **desktop:** use clerk session tokens for native computer use ([#37965](https://github.com/okou-ai/okou/issues/37965)) ([fccd4a9](https://github.com/okou-ai/okou/commit/fccd4a98bb370bdaf9c8dd312988f5ba267bbb2c))
* enable private artifacts for all users ([#37951](https://github.com/okou-ai/okou/issues/37951)) ([91e19d1](https://github.com/okou-ai/okou/commit/91e19d1e55e49ffb5822aa2a9d7fcb336b9cb9cf))


### Bug Fixes

* **api:** exclude inline-only agentphone callbacks ([#37996](https://github.com/okou-ai/okou/issues/37996)) ([a9ca48e](https://github.com/okou-ai/okou/commit/a9ca48ebfca4c9222052ccaa4268f1f513e921e9))
* **api:** keep successful schedule expiry below warning ([#37998](https://github.com/okou-ai/okou/issues/37998)) ([e2bb3de](https://github.com/okou-ai/okou/commit/e2bb3de9bfc8a59202a9572264e8010d3e065a7b))
* **api:** persist initial file share revocations ([#38015](https://github.com/okou-ai/okou/issues/38015)) ([61b9112](https://github.com/okou-ai/okou/commit/61b91126a88149de8aaa3dd196e1d4af092a91c1))
* **api:** stop warning on expected queued input rejections ([#37974](https://github.com/okou-ai/okou/issues/37974)) ([2443e7b](https://github.com/okou-ai/okou/commit/2443e7b20d23d60dddd9cf9613f3242a113d7d33))
* **seo:** preserve dataforseo partial serp results ([#37961](https://github.com/okou-ai/okou/issues/37961)) ([b5d9654](https://github.com/okou-ai/okou/commit/b5d96542a902d7cad11325c86966f49746e41172))
* **ssh:** fence cloudflare bindings with host-first mutations ([#37955](https://github.com/okou-ai/okou/issues/37955)) ([42935d1](https://github.com/okou-ai/okou/commit/42935d1cc0181aa3bfa6a571ceb8059282d292ae))


### Refactoring

* **api:** own personal subscription account activation queries ([#37949](https://github.com/okou-ai/okou/issues/37949)) ([9206b1c](https://github.com/okou-ai/okou/commit/9206b1cff0529de4f84d6283823c8658df0a57f6))
* **api:** own resource projection worker transactions ([#38012](https://github.com/okou-ai/okou/issues/38012)) ([0157b0f](https://github.com/okou-ai/okou/commit/0157b0fce6ffd2bab89704aa188a3be93f60d6f8))
* **api:** own workflow metadata commits and simplify gmail updates ([#38011](https://github.com/okou-ai/okou/issues/38011)) ([4824eff](https://github.com/okou-ai/okou/commit/4824eff35f768456096b89ac19bfb287056d1243))
* assemble current run inputs without agent configuration ([#38004](https://github.com/okou-ai/okou/issues/38004)) ([22efd4b](https://github.com/okou-ai/okou/commit/22efd4b6b34872c0585a0d4c3778cb3b59d9d100))
* **computer-use:** remove retired desktop plugins ([#37980](https://github.com/okou-ai/okou/issues/37980)) ([8b8928c](https://github.com/okou-ai/okou/commit/8b8928cdf85d4fb2243a9326194d7cfb3936d53c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.539.0
    * @okouai/core bumped to 8.735.0
    * @okouai/db bumped to 1.324.0
    * @okouai/pi-agent-runtime bumped to 1.46.24

## [1.713.2](https://github.com/okou-ai/okou/compare/api-v1.713.1...api-v1.713.2) (2026-10-08)


### Bug Fixes

* **integrations:** hide auto model attribution in message footers ([#37959](https://github.com/okou-ai/okou/issues/37959)) ([46a2d1a](https://github.com/okou-ai/okou/commit/46a2d1a044c0d48829d2879c689539ccfea64a65))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.538.1
    * @okouai/core bumped to 8.734.9
    * @okouai/db bumped to 1.323.10
    * @okouai/pi-agent-runtime bumped to 1.46.23

## [1.713.1](https://github.com/okou-ai/okou/compare/api-v1.713.0...api-v1.713.1) (2026-10-08)


### Performance Improvements

* **api:** reduce mcp input observation reads ([#37921](https://github.com/okou-ai/okou/issues/37921)) ([b4497cd](https://github.com/okou-ai/okou/commit/b4497cd5a05367fd6ee6fde0d5a4d2c98bfb3ae9))

## [1.713.0](https://github.com/okou-ai/okou/compare/api-v1.712.7...api-v1.713.0) (2026-10-08)


### Features

* **desktop:** replace electron with native swift desktop ([#37889](https://github.com/okou-ai/okou/issues/37889)) ([303d7bc](https://github.com/okou-ai/okou/commit/303d7bc2e3176b02c66ca3ef1c9c9b0eb2bb7700))


### Refactoring

* **api:** own permission-grant list database reads ([#37910](https://github.com/okou-ai/okou/issues/37910)) ([1a4cbda](https://github.com/okou-ai/okou/commit/1a4cbda1d901006994149202b74d5135d8b74f6d))
* **api:** remove unused pi stable-context and report delisted connectors absent ([#37905](https://github.com/okou-ai/okou/issues/37905)) ([c339e73](https://github.com/okou-ai/okou/commit/c339e73f0fb5d0ca0a8f4a4e80c67331ea9fb79d))
* **api:** unify test projects with per-case database isolation ([#37896](https://github.com/okou-ai/okou/issues/37896)) ([28c0ec4](https://github.com/okou-ai/okou/commit/28c0ec43505f5032b005505d92c5e7c6d74d8a03))


### Performance Improvements

* **api:** read connector catalog entries by slug on runtime hot paths ([#37903](https://github.com/okou-ai/okou/issues/37903)) ([f8a3a9b](https://github.com/okou-ai/okou/commit/f8a3a9b1f0bb44a30c5f443273439069332903a3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.538.0
    * @okouai/connectors bumped to 3.16.7
    * @okouai/core bumped to 8.734.8
    * @okouai/db bumped to 1.323.9
    * @okouai/pi-agent-runtime bumped to 1.46.22

## [1.712.7](https://github.com/okou-ai/okou/compare/api-v1.712.6...api-v1.712.7) (2026-10-07)


### Bug Fixes

* **api:** treat connectors missing from the catalog as unauthorized everywhere ([#37898](https://github.com/okou-ai/okou/issues/37898)) ([d281779](https://github.com/okou-ai/okou/commit/d28177961e86fd7cc41c62a0c0749e61a1859867))


### Refactoring

* **api:** retire workflow automation worker test endpoints ([#37904](https://github.com/okou-ai/okou/issues/37904)) ([1375381](https://github.com/okou-ai/okou/commit/13753817e6507ac8b71315166dac807a87711c4c))
* represent auto model selection as null ([#37901](https://github.com/okou-ai/okou/issues/37901)) ([d0e0b71](https://github.com/okou-ai/okou/commit/d0e0b7191fe168e8935e1abf3df1fa1806efea2a))


### Performance Improvements

* **api:** read connector catalog from purpose-specific columns ([#37900](https://github.com/okou-ai/okou/issues/37900)) ([8c38a39](https://github.com/okou-ai/okou/commit/8c38a399d41d0786e6450e78a897d1de01892a58))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.14
    * @okouai/connectors bumped to 3.16.6
    * @okouai/core bumped to 8.734.7
    * @okouai/db bumped to 1.323.8
    * @okouai/pi-agent-runtime bumped to 1.46.21

## [1.712.6](https://github.com/okou-ai/okou/compare/api-v1.712.5...api-v1.712.6) (2026-10-07)


### Refactoring

* finish connector catalog release 2 follow-up cleanup ([#37895](https://github.com/okou-ai/okou/issues/37895)) ([013d37d](https://github.com/okou-ai/okou/commit/013d37d5513f5ff071097621e4436109742f6dc8))
* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))
* retire cooldown, ultrafast, us routing and model provider leftovers ([#37884](https://github.com/okou-ai/okou/issues/37884)) ([a9c3270](https://github.com/okou-ai/okou/commit/a9c3270099034c0f7ee73f6c730b07efa7d1d733))


### Performance Improvements

* **api:** consolidate global and identity context reads before enqueue ([#37885](https://github.com/okou-ai/okou/issues/37885)) ([3a37588](https://github.com/okou-ai/okou/commit/3a375883212f6264b4ef133faae1ae92d7d4b5bb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.13
    * @okouai/connectors bumped to 3.16.5
    * @okouai/core bumped to 8.734.6
    * @okouai/db bumped to 1.323.7
    * @okouai/pi-agent-runtime bumped to 1.46.20

## [1.712.5](https://github.com/okou-ai/okou/compare/api-v1.712.4...api-v1.712.5) (2026-10-07)


### Bug Fixes

* **api:** omit agent-enabled connectors missing from the catalog instead of rejecting the run ([#37893](https://github.com/okou-ai/okou/issues/37893)) ([3ff1f40](https://github.com/okou-ai/okou/commit/3ff1f404e2b2908ddc3a39dff60abe1e12177d90))


### Refactoring

* contract connector catalog storage to pointer and immutable entries ([#37886](https://github.com/okou-ai/okou/issues/37886)) ([baf302f](https://github.com/okou-ai/okou/commit/baf302f5373a000999dfde0abf521752a779e29c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.12
    * @okouai/connectors bumped to 3.16.4
    * @okouai/core bumped to 8.734.5
    * @okouai/db bumped to 1.323.6
    * @okouai/pi-agent-runtime bumped to 1.46.19

## [1.712.4](https://github.com/okou-ai/okou/compare/api-v1.712.3...api-v1.712.4) (2026-10-07)


### Refactoring

* **api:** retire native morning brief storage dependencies ([#37874](https://github.com/okou-ai/okou/issues/37874)) ([094ef4c](https://github.com/okou-ai/okou/commit/094ef4c402089b1acdcafede8af8f7e081506d2f))
* move release 1 connector catalog consumers off legacy storage ([#37861](https://github.com/okou-ai/okou/issues/37861)) ([e664957](https://github.com/okou-ai/okou/commit/e664957caa2056a336595e55f475001b81247fd0))
* remove remaining model provider residue ([#37870](https://github.com/okou-ai/okou/issues/37870)) ([a93133b](https://github.com/okou-ai/okou/commit/a93133b0493858a39924a1206ff5a5677e43cad6))
* remove retired per-agent ssh access traces ([#37876](https://github.com/okou-ai/okou/issues/37876)) ([dc33264](https://github.com/okou-ai/okou/commit/dc332649051e79460f1075a294ba8d3707f8504f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.11
    * @okouai/connectors bumped to 3.16.3
    * @okouai/core bumped to 8.734.4
    * @okouai/db bumped to 1.323.5
    * @okouai/pi-agent-runtime bumped to 1.46.18

## [1.712.3](https://github.com/okou-ai/okou/compare/api-v1.712.2...api-v1.712.3) (2026-10-07)


### Refactoring

* clean up released switch leftovers and drop legacy chat thread provider pins ([#37851](https://github.com/okou-ai/okou/issues/37851)) ([066e9c3](https://github.com/okou-ai/okou/commit/066e9c32c2bbd5e3d48783fb0028f8dcfbaeaf06))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.10
    * @okouai/core bumped to 8.734.3
    * @okouai/db bumped to 1.323.4
    * @okouai/pi-agent-runtime bumped to 1.46.17

## [1.712.2](https://github.com/okou-ai/okou/compare/api-v1.712.1...api-v1.712.2) (2026-10-07)


### Refactoring

* remove all remaining custom model mode awareness ([#37856](https://github.com/okou-ai/okou/issues/37856)) ([f383835](https://github.com/okou-ai/okou/commit/f3838353ba0455ec7d57dfa2d0974e34a44796ff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.9
    * @okouai/core bumped to 8.734.2
    * @okouai/db bumped to 1.323.3
    * @okouai/pi-agent-runtime bumped to 1.46.16

## [1.712.1](https://github.com/okou-ai/okou/compare/api-v1.712.0...api-v1.712.1) (2026-10-07)


### Refactoring

* read connector catalogs from immutable entries ([#37820](https://github.com/okou-ai/okou/issues/37820)) ([562e53f](https://github.com/okou-ai/okou/commit/562e53fdeb02c8feb1f131f0f8629bc84bf1f2d0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.8
    * @okouai/connectors bumped to 3.16.2
    * @okouai/core bumped to 8.734.1
    * @okouai/db bumped to 1.323.2
    * @okouai/pi-agent-runtime bumped to 1.46.15

## [1.712.0](https://github.com/okou-ai/okou/compare/api-v1.711.0...api-v1.712.0) (2026-10-06)


### Features

* **core:** release eleven staff feature switches to all users ([#37818](https://github.com/okou-ai/okou/issues/37818)) ([8d05119](https://github.com/okou-ai/okou/commit/8d051194184d595b67f78f5d6f7ec728ed6cc31d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.7
    * @okouai/core bumped to 8.734.0
    * @okouai/db bumped to 1.323.1
    * @okouai/pi-agent-runtime bumped to 1.46.14

## [1.711.0](https://github.com/okou-ai/okou/compare/api-v1.710.3...api-v1.711.0) (2026-10-06)


### Features

* materialize connector catalog entry query columns ([#37816](https://github.com/okou-ai/okou/issues/37816)) ([a032281](https://github.com/okou-ai/okou/commit/a032281cb085da66d271087211c94955748cb803))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.323.0

## [1.710.3](https://github.com/okou-ai/okou/compare/api-v1.710.2...api-v1.710.3) (2026-10-06)


### Refactoring

* retire organization custom model configuration ([#37746](https://github.com/okou-ai/okou/issues/37746)) ([014fe18](https://github.com/okou-ai/okou/commit/014fe1867c6d1830fd35b03c3d77491da5aaa36a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.6
    * @okouai/core bumped to 8.733.3
    * @okouai/db bumped to 1.322.2
    * @okouai/pi-agent-runtime bumped to 1.46.13

## [1.710.2](https://github.com/okou-ai/okou/compare/api-v1.710.1...api-v1.710.2) (2026-10-06)


### Refactoring

* **api:** migrate projection readers to slug-first current entries ([#37808](https://github.com/okou-ai/okou/issues/37808)) ([8850112](https://github.com/okou-ai/okou/commit/88501125e1390528e09386d3148028c32c82ba65))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.5
    * @okouai/connectors bumped to 3.16.1
    * @okouai/core bumped to 8.733.2
    * @okouai/db bumped to 1.322.1
    * @okouai/pi-agent-runtime bumped to 1.46.12

## [1.710.1](https://github.com/okou-ai/okou/compare/api-v1.710.0...api-v1.710.1) (2026-10-06)


### Performance Improvements

* **api:** avoid eager full catalog reads during run bootstrap ([#37769](https://github.com/okou-ai/okou/issues/37769)) ([c1c2d77](https://github.com/okou-ai/okou/commit/c1c2d77ab51b38acf91008b2c60937ac2c29cda3))

## [1.710.0](https://github.com/okou-ai/okou/compare/api-v1.709.4...api-v1.710.0) (2026-10-06)


### Features

* **api:** support organization openrouter preset overrides ([#37799](https://github.com/okou-ai/okou/issues/37799)) ([dacd31d](https://github.com/okou-ai/okou/commit/dacd31d031d98d45ccb3c6bd134f55b5f76063f4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.322.0

## [1.709.4](https://github.com/okou-ai/okou/compare/api-v1.709.3...api-v1.709.4) (2026-10-06)


### Refactoring

* **api:** migrate auxiliary gemini generation to vertex ai ([#37792](https://github.com/okou-ai/okou/issues/37792)) ([7d5660d](https://github.com/okou-ai/okou/commit/7d5660d2fabe4497b352b4a74e77ac0ab67ffa3c))


### Performance Improvements

* **ci:** bound api preview connector catalog initialization ([#37790](https://github.com/okou-ai/okou/issues/37790)) ([d6300c1](https://github.com/okou-ai/okou/commit/d6300c15d49be1602c846acfc82b96f60caed4ea))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.4
    * @okouai/core bumped to 8.733.1
    * @okouai/db bumped to 1.321.4
    * @okouai/pi-agent-runtime bumped to 1.46.11

## [1.709.3](https://github.com/okou-ai/okou/compare/api-v1.709.2...api-v1.709.3) (2026-10-06)


### Refactoring

* **api:** own initial agent deletion read ([#37783](https://github.com/okou-ai/okou/issues/37783)) ([c0e8f66](https://github.com/okou-ai/okou/commit/c0e8f661e10f5d464cc271d97d95df904b13c196))
* **api:** own terminal sandbox storage lineage reads ([#37789](https://github.com/okou-ai/okou/issues/37789)) ([a1a3e19](https://github.com/okou-ai/okou/commit/a1a3e19104a04a226a5916ef61e745e20ea15f4b))
* **api:** own terminal sandbox storage version reads ([#37782](https://github.com/okou-ai/okou/issues/37782)) ([2fe6f11](https://github.com/okou-ai/okou/commit/2fe6f11be34ab296e93ad4193d18dd4a192bb4fa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.733.0
    * @okouai/db bumped to 1.321.3
    * @okouai/pi-agent-runtime bumped to 1.46.10

## [1.709.2](https://github.com/okou-ai/okou/compare/api-v1.709.1...api-v1.709.2) (2026-10-06)


### Bug Fixes

* **api:** allow sandbox tokens to read the model catalog ([#37773](https://github.com/okou-ai/okou/issues/37773)) ([936ccb3](https://github.com/okou-ai/okou/commit/936ccb30e40aa238c19f7045462f5709099ec079))

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
