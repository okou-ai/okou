# Changelog

Older releases are archived by month:

- [2026-09](changelog/2026-09/CHANGELOG.md)
- [2026-08](changelog/2026-08/CHANGELOG.md)
- [2026-07](changelog/2026-07/CHANGELOG.md)
- [2026-06](changelog/2026-06/CHANGELOG.md)
- [2026-05](changelog/2026-05/CHANGELOG.md)
- [2026-04](changelog/2026-04/CHANGELOG.md)

## [2.31.1](https://github.com/okou-ai/okou/compare/api-v2.31.0...api-v2.31.1) (2026-10-30)


### Refactoring

* **api:** keep optional enrichment execution in ingress owners ([#44251](https://github.com/okou-ai/okou/issues/44251)) ([de9cd7f](https://github.com/okou-ai/okou/commit/de9cd7f3d16fbc70e854550ba10f138eb8a07151))
* **api:** remove tx-0047 agent deletion transaction ([#44248](https://github.com/okou-ai/okou/issues/44248)) ([60d3a02](https://github.com/okou-ai/okou/commit/60d3a021ba08e389c7dae490f780eba267d9aeb0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.13.5

## [2.31.0](https://github.com/okou-ai/okou/compare/api-v2.30.1...api-v2.31.0) (2026-10-30)


### Features

* **phone:** add emoji reactions and interaction guidance ([#44173](https://github.com/okou-ai/okou/issues/44173)) ([692e807](https://github.com/okou-ai/okou/commit/692e8071af47baeb6fa4d9c5902f07439c698594))


### Bug Fixes

* **api:** declare public mcp oauth dynamic registration ([#44235](https://github.com/okou-ai/okou/issues/44235)) ([21106db](https://github.com/okou-ai/okou/commit/21106dbaef4fa98577692679ebe0573478a56a33))
* **api:** share phone group threads and fork reply conversations ([#44171](https://github.com/okou-ai/okou/issues/44171)) ([a0987a7](https://github.com/okou-ai/okou/commit/a0987a786a1d800cb8aa4ab42f479720afbc4515))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.24.0
    * @okouai/core bumped to 8.804.2
    * @okouai/db bumped to 2.13.4
    * @okouai/pi-agent-runtime bumped to 1.51.33

## [2.30.1](https://github.com/okou-ai/okou/compare/api-v2.30.0...api-v2.30.1) (2026-10-30)


### Refactoring

* **api:** localize runner reuse preference capture ownership ([#44212](https://github.com/okou-ai/okou/issues/44212)) ([c349eda](https://github.com/okou-ai/okou/commit/c349edab2cd37730da11610704b13d7b8ac55a7a))
* **api:** remove builtin connector selection transaction ([#44221](https://github.com/okou-ai/okou/issues/44221)) ([738c3fa](https://github.com/okou-ai/okou/commit/738c3fa6a3b11bca957ce6f59791be62b3cdc1b3))


### Performance Improvements

* **browser:** use native extension window operations ([#44195](https://github.com/okou-ai/okou/issues/44195)) ([90925ae](https://github.com/okou-ai/okou/commit/90925ae2ce82dc5ab1457b09c0caf8df08651d19))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.23.2
    * @okouai/core bumped to 8.804.1
    * @okouai/db bumped to 2.13.3
    * @okouai/pi-agent-runtime bumped to 1.51.32

## [2.30.0](https://github.com/okou-ai/okou/compare/api-v2.29.0...api-v2.30.0) (2026-10-30)


### Features

* release halloween quiz to all users ([#44208](https://github.com/okou-ai/okou/issues/44208)) ([5b89b78](https://github.com/okou-ai/okou/commit/5b89b784990936be1d6a050aa0b3ed2789e69ad9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.804.0
    * @okouai/db bumped to 2.13.2
    * @okouai/pi-agent-runtime bumped to 1.51.31

## [2.29.0](https://github.com/okou-ai/okou/compare/api-v2.28.0...api-v2.29.0) (2026-10-30)


### Features

* **connectors:** support declared automatic oauth prompts ([#44202](https://github.com/okou-ai/okou/issues/44202)) ([3063efe](https://github.com/okou-ai/okou/commit/3063efe6cf29cf22b8bdc4ac39feff7d4ae856b9))


### Refactoring

* **api:** localize admission commit capture ownership ([#44177](https://github.com/okou-ai/okou/issues/44177)) ([e025482](https://github.com/okou-ai/okou/commit/e02548264985bd94a023fcc5d6525ea9c31d3900))
* **api:** remove tx-0012 from agent metadata updates ([#44201](https://github.com/okou-ai/okou/issues/44201)) ([a2ce78e](https://github.com/okou-ai/okou/commit/a2ce78e6d3a43ae08b39f4a4df4ef49bfb6eb583))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.23.1
    * @okouai/connectors bumped to 3.20.0
    * @okouai/core bumped to 8.803.1
    * @okouai/db bumped to 2.13.1
    * @okouai/pi-agent-runtime bumped to 1.51.30

## [2.28.0](https://github.com/okou-ai/okou/compare/api-v2.27.0...api-v2.28.0) (2026-10-30)


### Features

* prepare content-addressed instruction and workflow bundles ([#44189](https://github.com/okou-ai/okou/issues/44189)) ([fc8f994](https://github.com/okou-ai/okou/commit/fc8f99468cc7946843620ff655ae22c09f9cb2ae))


### Bug Fixes

* refresh runner platform api cli and browser extension release markers ([#44180](https://github.com/okou-ai/okou/issues/44180)) ([ca744df](https://github.com/okou-ai/okou/commit/ca744df83b1f51794edcb1b58f10634df2da7aed))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.23.0
    * @okouai/core bumped to 8.803.0
    * @okouai/db bumped to 2.13.0
    * @okouai/pi-agent-runtime bumped to 1.51.29

## [2.27.0](https://github.com/okou-ai/okou/compare/api-v2.26.0...api-v2.27.0) (2026-10-30)


### Features

* **browser:** own extension source and release delivery ([#44106](https://github.com/okou-ai/okou/issues/44106)) ([a45e176](https://github.com/okou-ai/okou/commit/a45e176ab11bba983668681f929cf9d2d58b5e9e))


### Bug Fixes

* bound computer-use auth reads and preserve heartbeat diagnostics ([#44157](https://github.com/okou-ai/okou/issues/44157)) ([77f4d3b](https://github.com/okou-ai/okou/commit/77f4d3b67081731ec70886ed63715f9a012e2db8))
* log claude account verification failures at info ([#44165](https://github.com/okou-ai/okou/issues/44165)) ([6c13dec](https://github.com/okou-ai/okou/commit/6c13dec6a6f7d0ed8981656fc309c0a4e44a254d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.22.1
    * @okouai/core bumped to 8.802.0
    * @okouai/db bumped to 2.12.1
    * @okouai/pi-agent-runtime bumped to 1.51.28

## [2.26.0](https://github.com/okou-ai/okou/compare/api-v2.25.4...api-v2.26.0) (2026-10-30)


### Features

* **connectors:** support declared scopes for automatic mcp oauth ([#44072](https://github.com/okou-ai/okou/issues/44072)) ([f8d5751](https://github.com/okou-ai/okou/commit/f8d5751ed41e5ab85d33d7ec1f9c0add42bc3bfe))


### Bug Fixes

* **api:** preserve custom http prefix trailing slashes ([#44081](https://github.com/okou-ai/okou/issues/44081)) ([68507fc](https://github.com/okou-ai/okou/commit/68507fc490a0672b547717e9709942abc3ce5be9))
* **api:** preserve identical concurrent feishu setup ([#44102](https://github.com/okou-ai/okou/issues/44102)) ([57cfebf](https://github.com/okou-ai/okou/commit/57cfebfb235895495b4cc53aa57a81a6352c22d0))


### Refactoring

* **api:** detach chat references before agent cascades ([#44092](https://github.com/okou-ai/okou/issues/44092)) ([facc305](https://github.com/okou-ai/okou/commit/facc305a27a819d435cba4b4fad89aa9d8bcc669))
* **api:** detach chat references before thread deletion ([#44074](https://github.com/okou-ai/okou/issues/44074)) ([af1eca7](https://github.com/okou-ai/okou/commit/af1eca735653814fc0ea92f5339c87e649a85acc))
* **api:** localize chat callback timing operations ([#44117](https://github.com/okou-ai/okou/issues/44117)) ([99e0f3d](https://github.com/okou-ai/okou/commit/99e0f3dc8e6f4e1ad1530d4ab989eec7d2c60a06))
* **api:** localize google event timed operations ([#44077](https://github.com/okou-ai/okou/issues/44077)) ([300710f](https://github.com/okou-ai/okou/commit/300710f198f38d38b77cafd9ba26e0436a2e00db))
* **api:** localize pending launch persistence timing ([#44122](https://github.com/okou-ai/okou/issues/44122)) ([b31930b](https://github.com/okou-ai/okou/commit/b31930be9daabe774c054b0aacfc6c73ae7437af))
* **api:** localize runner lifecycle timing operations ([#44108](https://github.com/okou-ai/okou/issues/44108)) ([2d06103](https://github.com/okou-ai/okou/commit/2d061034617059558f31b09ff85637930264169d))
* **api:** localize storage manifest timing ownership ([#44133](https://github.com/okou-ai/okou/issues/44133)) ([4e15364](https://github.com/okou-ai/okou/commit/4e153646ea5573a77209422aea221ffeb9255654))
* **api:** localize workflow entry timed operations ([#44090](https://github.com/okou-ai/okou/issues/44090)) ([2146e3b](https://github.com/okou-ai/okou/commit/2146e3ba99704034074f9b3daa93a5ae6566c268))
* remove expired deployment compatibility ([#44123](https://github.com/okou-ai/okou/issues/44123)) ([9a8519a](https://github.com/okou-ai/okou/commit/9a8519a566cd50861fa9edd108a9719660e58f5b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.22.0
    * @okouai/connectors bumped to 3.19.0
    * @okouai/core bumped to 8.801.0
    * @okouai/db bumped to 2.12.0
    * @okouai/pi-agent-runtime bumped to 1.51.27

## [2.25.4](https://github.com/okou-ai/okou/compare/api-v2.25.3...api-v2.25.4) (2026-10-29)


### Bug Fixes

* **api:** reduce phone typing latency ([#44058](https://github.com/okou-ai/okou/issues/44058)) ([b776878](https://github.com/okou-ai/okou/commit/b776878902ebb4c80dd20d0bf6f35e8d6b14b5fe))
* **api:** require desktop 0.54.0 and retire pre-shell claims ([#44039](https://github.com/okou-ai/okou/issues/44039)) ([3e057a5](https://github.com/okou-ai/okou/commit/3e057a519e07bb639e7befea10f68b739ce454c7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.21.0
    * @okouai/core bumped to 8.800.7
    * @okouai/db bumped to 2.11.6
    * @okouai/pi-agent-runtime bumped to 1.51.26

## [2.25.3](https://github.com/okou-ai/okou/compare/api-v2.25.2...api-v2.25.3) (2026-10-29)


### Refactoring

* remove outlook chat mail feature switch ([#44040](https://github.com/okou-ai/okou/issues/44040)) ([685f0d1](https://github.com/okou-ai/okou/commit/685f0d10e07c044f9987fa5e0a4552f3241a196b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.800.6
    * @okouai/db bumped to 2.11.5
    * @okouai/pi-agent-runtime bumped to 1.51.25

## [2.25.2](https://github.com/okou-ai/okou/compare/api-v2.25.1...api-v2.25.2) (2026-10-29)


### Bug Fixes

* **agents:** restore editable default agent configuration ([#44033](https://github.com/okou-ai/okou/issues/44033)) ([bfada2a](https://github.com/okou-ai/okou/commit/bfada2a09f491143186a92d26e0c4878af02d941))
* **api:** prevent discord typing refresh gaps ([#44036](https://github.com/okou-ai/okou/issues/44036)) ([ddc3240](https://github.com/okou-ai/okou/commit/ddc32409caa5fa06c03402bade144ec7b16a2282))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.800.5
    * @okouai/db bumped to 2.11.4
    * @okouai/pi-agent-runtime bumped to 1.51.24

## [2.25.1](https://github.com/okou-ai/okou/compare/api-v2.25.0...api-v2.25.1) (2026-10-29)


### Bug Fixes

* **api:** align whatsapp run context and prompts ([#43972](https://github.com/okou-ai/okou/issues/43972)) ([36af6d9](https://github.com/okou-ai/okou/commit/36af6d9b9d5c6018ea1939e6fedb7a364326ca2b))
* **api:** route imessage group replies to their web thread ([#44024](https://github.com/okou-ai/okou/issues/44024)) ([9e70dbf](https://github.com/okou-ai/okou/commit/9e70dbfcd33e5d7c750e528ca43f480fe66b31c6))
* preserve whatsapp partial send outcomes ([#43970](https://github.com/okou-ai/okou/issues/43970)) ([6ad1188](https://github.com/okou-ai/okou/commit/6ad1188fa8b397a28c350285765f8ee938512b7c))


### Refactoring

* **api:** localize post-commit runtime wakeup fanout ([#44025](https://github.com/okou-ai/okou/issues/44025)) ([1e4765d](https://github.com/okou-ai/okou/commit/1e4765d99964a303e1735faf7c382819707a8bd4))
* **api:** make custom account deletion statement-atomic ([#44014](https://github.com/okou-ai/okou/issues/44014)) ([5c506c2](https://github.com/okou-ai/okou/commit/5c506c20e016a78456a6aec82c12b1decc3d49a9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.20.1
    * @okouai/core bumped to 8.800.4
    * @okouai/db bumped to 2.11.3
    * @okouai/pi-agent-runtime bumped to 1.51.23

## [2.25.0](https://github.com/okou-ai/okou/compare/api-v2.24.0...api-v2.25.0) (2026-10-29)


### Features

* **cli:** support file uploads to imessage groups ([#44002](https://github.com/okou-ai/okou/issues/44002)) ([ea08509](https://github.com/okou-ai/okou/commit/ea0850926d622ac4a7a4f7cbe9144af34866dc7e))


### Refactoring

* **api:** localize hosted site file signing ([#44007](https://github.com/okou-ai/okou/issues/44007)) ([5c8b615](https://github.com/okou-ai/okou/commit/5c8b615ebd186bf474e10dfeb75dbb1dce9801a2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.20.0
    * @okouai/core bumped to 8.800.3
    * @okouai/db bumped to 2.11.2
    * @okouai/pi-agent-runtime bumped to 1.51.22

## [2.24.0](https://github.com/okou-ai/okou/compare/api-v2.23.0...api-v2.24.0) (2026-10-29)


### Features

* **cli:** send text to existing imessage groups ([#43990](https://github.com/okou-ai/okou/issues/43990)) ([846f53f](https://github.com/okou-ai/okou/commit/846f53f4c20a2d641d53ad459ec4ac6c729410ac))


### Bug Fixes

* configure whatsapp regions and standardize unsupported replies ([#43971](https://github.com/okou-ai/okou/issues/43971)) ([37fffbf](https://github.com/okou-ai/okou/commit/37fffbf81e095bbebee1b5cec13d30a468f3cd80))


### Refactoring

* **api:** localize run connector and model snapshot timing ([#43978](https://github.com/okou-ai/okou/issues/43978)) ([e17db34](https://github.com/okou-ai/okou/commit/e17db34d252cf32127d77ad002365122b95e4361))
* remove hosted site visibility feature switch ([#43947](https://github.com/okou-ai/okou/issues/43947)) ([4aade90](https://github.com/okou-ai/okou/commit/4aade9015eaf2e73d9b63fab530758ca155fed07))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.19.0
    * @okouai/core bumped to 8.800.2
    * @okouai/db bumped to 2.11.1
    * @okouai/pi-agent-runtime bumped to 1.51.21

## [2.23.0](https://github.com/okou-ai/okou/compare/api-v2.22.7...api-v2.23.0) (2026-10-29)


### Features

* learn from suggestions with per-card feedback storage ([#43771](https://github.com/okou-ai/okou/issues/43771)) ([cefb967](https://github.com/okou-ai/okou/commit/cefb967db3d9b20e83b3f7239815a264975bd2ec)) [#43760](https://github.com/okou-ai/okou/issues/43760)


### Bug Fixes

* **api:** remove official identities before workflow automations ([#43952](https://github.com/okou-ai/okou/issues/43952)) ([2a9472b](https://github.com/okou-ai/okou/commit/2a9472b83d4737c002b8cd227b2ec5791ffb7519))
* **api:** use conversation ids for group imessage typing ([#43939](https://github.com/okou-ai/okou/issues/43939)) ([e67bb39](https://github.com/okou-ai/okou/commit/e67bb39a77fa02e89f620093e1331e3f614bd5ab))
* **teams:** return connect links for unconnected greetings ([#43941](https://github.com/okou-ai/okou/issues/43941)) ([73a1c2e](https://github.com/okou-ai/okou/commit/73a1c2eed9ae9ab7a355276ed18258ee594a61c2))


### Refactoring

* **api:** keep google event source timing in its owning commands ([#43951](https://github.com/okou-ai/okou/issues/43951)) ([252750f](https://github.com/okou-ai/okou/commit/252750f26ba7a69247f682ca9e5be2e8f1bddc66))
* **api:** remove run settlement audit endpoint ([#43458](https://github.com/okou-ai/okou/issues/43458)) ([d33052b](https://github.com/okou-ai/okou/commit/d33052bb1ff3dfb9e26d053da7ebf4dec52c7a1e))
* remove hosted site url editing feature switch ([#43937](https://github.com/okou-ai/okou/issues/43937)) ([bd980f4](https://github.com/okou-ai/okou/commit/bd980f407b03e4b513f8d76ead8338433c5d9b38))
* remove icloud connector feature switch ([#43932](https://github.com/okou-ai/okou/issues/43932)) ([f080c78](https://github.com/okou-ai/okou/commit/f080c7849bb0f52cb74daff61e1c0d06359af3f2))
* remove thread email manager feature switch ([#43934](https://github.com/okou-ai/okou/issues/43934)) ([4233f42](https://github.com/okou-ai/okou/commit/4233f42b391ba6c96c39c02d0eb5d64c54bc196e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.18.0
    * @okouai/core bumped to 8.800.1
    * @okouai/db bumped to 2.11.0
    * @okouai/pi-agent-runtime bumped to 1.51.20

## [2.22.7](https://github.com/okou-ai/okou/compare/api-v2.22.6...api-v2.22.7) (2026-10-29)


### Bug Fixes

* **artifacts:** expose owner deletion on shared pages ([#43889](https://github.com/okou-ai/okou/issues/43889)) ([56f4bbe](https://github.com/okou-ai/okou/commit/56f4bbec6c59f81389ad0e158f9b090799872988))
* **browser:** scope shared viewers and keepalive to the chat window ([#43872](https://github.com/okou-ai/okou/issues/43872)) ([21e89be](https://github.com/okou-ai/okou/commit/21e89bedb30ed755d9f41825f102607cea3635a0))
* **mail:** treat outlook accepted sends as successful ([#43888](https://github.com/okou-ai/okou/issues/43888)) ([59d7bcb](https://github.com/okou-ai/okou/commit/59d7bcbb97937af5a48ca65c3c86153e0d73c678))


### Refactoring

* **api:** capture automation cleanup targets before deleting workflows ([#43919](https://github.com/okou-ai/okou/issues/43919)) ([b2df651](https://github.com/okou-ai/okou/commit/b2df6512e157f6ff9367fcbe99964719364e7fe1))
* **api:** keep github source preflight timing in its owning commands ([#43926](https://github.com/okou-ai/okou/issues/43926)) ([b5a4c8f](https://github.com/okou-ai/okou/commit/b5a4c8f5b87b74878ae4f55ce3af1509706e4942))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.17.4
    * @okouai/core bumped to 8.800.0
    * @okouai/db bumped to 2.10.5
    * @okouai/pi-agent-runtime bumped to 1.51.19

## [2.22.6](https://github.com/okou-ai/okou/compare/api-v2.22.5...api-v2.22.6) (2026-10-29)


### Refactoring

* **api:** atomically retire threadless runs ([#43894](https://github.com/okou-ai/okou/issues/43894)) ([fd47188](https://github.com/okou-ai/okou/commit/fd47188ffa3209c3ab559e65599538b7a63e2e8d))
* **api:** keep snapshot gc page work in its owning commands ([#43898](https://github.com/okou-ai/okou/issues/43898)) ([5878e11](https://github.com/okou-ai/okou/commit/5878e1199f7ee0599227a535ee9415f01100b366))
* **api:** localize shared browser creation work before settlement ([#43906](https://github.com/okou-ai/okou/issues/43906)) ([d8d5b87](https://github.com/okou-ai/okou/commit/d8d5b8761fd296634cadfe31fc48153248bedb1b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.10.4

## [2.22.5](https://github.com/okou-ai/okou/compare/api-v2.22.4...api-v2.22.5) (2026-10-29)


### Bug Fixes

* **artifacts:** revoke deleted shared conversations ([#43863](https://github.com/okou-ai/okou/issues/43863)) ([d52d7d3](https://github.com/okou-ai/okou/commit/d52d7d3b90c8b039983422d2f63afc365cc983a0))

## [2.22.4](https://github.com/okou-ai/okou/compare/api-v2.22.3...api-v2.22.4) (2026-10-29)


### Bug Fixes

* **api:** allow owners to delete legacy hosted sites ([#43867](https://github.com/okou-ai/okou/issues/43867)) ([0b9fc2b](https://github.com/okou-ai/okou/commit/0b9fc2b60d72207c7b2508eadaef295c76f83b62))

## [2.22.3](https://github.com/okou-ai/okou/compare/api-v2.22.2...api-v2.22.3) (2026-10-29)


### Bug Fixes

* **app:** align halloween quiz copy with v1 ([#43861](https://github.com/okou-ai/okou/issues/43861)) ([a44c7f3](https://github.com/okou-ai/okou/commit/a44c7f3baf50059be9a017767fa6159fe167002b))


### Refactoring

* **api:** localize threadless run deletion ownership ([#43833](https://github.com/okou-ai/okou/issues/43833)) ([4e1c4af](https://github.com/okou-ai/okou/commit/4e1c4af2d9be762f3f22c2199981fe6c92a8c22d))
* **api:** retire inline workflow claim compatibility ([#43857](https://github.com/okou-ai/okou/issues/43857)) ([39aa90b](https://github.com/okou-ai/okou/commit/39aa90b52ca549653b95dcfc30696175c27995ac))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.17.3
    * @okouai/core bumped to 8.799.3
    * @okouai/db bumped to 2.10.3
    * @okouai/pi-agent-runtime bumped to 1.51.18

## [2.22.2](https://github.com/okou-ai/okou/compare/api-v2.22.1...api-v2.22.2) (2026-10-29)


### Bug Fixes

* **app:** refresh chat resources after artifact publication ([#43727](https://github.com/okou-ai/okou/issues/43727)) ([2da7f7a](https://github.com/okou-ai/okou/commit/2da7f7a765ef61cfe8d417be6733c5059ccb0fe5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.17.2
    * @okouai/core bumped to 8.799.2
    * @okouai/db bumped to 2.10.2
    * @okouai/pi-agent-runtime bumped to 1.51.17

## [2.22.1](https://github.com/okou-ai/okou/compare/api-v2.22.0...api-v2.22.1) (2026-10-29)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.17.1
    * @okouai/core bumped to 8.799.1
    * @okouai/db bumped to 2.10.1
    * @okouai/pi-agent-runtime bumped to 1.51.16

## [2.22.0](https://github.com/okou-ai/okou/compare/api-v2.21.1...api-v2.22.0) (2026-10-29)


### Features

* add whatsapp integration through agentphone ([#43656](https://github.com/okou-ai/okou/issues/43656)) ([a7306f0](https://github.com/okou-ai/okou/commit/a7306f0da51d3d9b00064ceae121fd002b3b64ed))


### Refactoring

* **api:** localize agent visibility validation reads ([#43801](https://github.com/okou-ai/okou/issues/43801)) ([1b26f11](https://github.com/okou-ai/okou/commit/1b26f11336350b4152aeed42cd273737df506550))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.17.0
    * @okouai/core bumped to 8.799.0
    * @okouai/db bumped to 2.10.0
    * @okouai/pi-agent-runtime bumped to 1.51.15

## [2.21.1](https://github.com/okou-ai/okou/compare/api-v2.21.0...api-v2.21.1) (2026-10-29)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.798.0
    * @okouai/db bumped to 2.9.1
    * @okouai/pi-agent-runtime bumped to 1.51.14

## [2.21.0](https://github.com/okou-ai/okou/compare/api-v2.20.3...api-v2.21.0) (2026-10-29)


### Features

* add shared conversation visibility controls ([#43707](https://github.com/okou-ai/okou/issues/43707)) ([eb74ccc](https://github.com/okou-ai/okou/commit/eb74ccccd7aec24c2f29f1711a9b9f56decfe945))
* **api:** add automatic continuation for busy chats ([#43725](https://github.com/okou-ai/okou/issues/43725)) ([e8a7e7e](https://github.com/okou-ai/okou/commit/e8a7e7e2127e2321a7c9919b04fe25ef47f0e6ac))
* **app:** add in-app halloween quiz and participant review ([#43223](https://github.com/okou-ai/okou/issues/43223)) ([7311d2f](https://github.com/okou-ai/okou/commit/7311d2fa1557cd8eb079a7f73b388dd489c94f31))
* **artifacts:** add deletion from catalog and chat previews ([#43708](https://github.com/okou-ai/okou/issues/43708)) ([61f19e3](https://github.com/okou-ai/okou/commit/61f19e3b89855ddcdcdfa2e6635c5b6224c237f1))
* **browser:** integrate shared owner browser consumers ([#43563](https://github.com/okou-ai/okou/issues/43563)) ([219d686](https://github.com/okou-ai/okou/commit/219d6860ce0e31ace746aea7eb88c1298c67fe09))
* **connector:** support http custom api connectors ([#43736](https://github.com/okou-ai/okou/issues/43736)) ([78bcdb5](https://github.com/okou-ai/okou/commit/78bcdb51732ba11746f1807da98189458f7aa5ab))
* introduce discord in the feature guide ([#43734](https://github.com/okou-ai/okou/issues/43734)) ([2495c4c](https://github.com/okou-ai/okou/commit/2495c4c82ccca5a82bb1261615c8822d5795a92e))
* prepare feature guide data and modal framework ([#43663](https://github.com/okou-ai/okou/issues/43663)) ([529e7dc](https://github.com/okou-ai/okou/commit/529e7dcdda27f1262f281ea399df57741f317152))
* support outlook mail review in chat ([#43751](https://github.com/okou-ai/okou/issues/43751)) ([d4a01db](https://github.com/okou-ai/okou/commit/d4a01dbac178e4d112e2e88aeb9a515aeb5560d9))
* **teams:** separate account identity from bot installation ([#43730](https://github.com/okou-ai/okou/issues/43730)) ([9a65fcc](https://github.com/okou-ai/okou/commit/9a65fcc9237e91f7e05213bfc5d37d9572098454))


### Bug Fixes

* align agentphone connection flow with slack ([#43735](https://github.com/okou-ai/okou/issues/43735)) ([8981509](https://github.com/okou-ai/okou/commit/898150923631a8d1e5ccac17e5eb76819391fafe))
* **api:** accept ancestor mcp oauth resources ([#43732](https://github.com/okou-ai/okou/issues/43732)) ([df7028c](https://github.com/okou-ai/okou/commit/df7028c5d9fbc487ebe28371ef1643a59a636db4))
* **api:** add phone account switching and workspace-aware credit errors ([#43704](https://github.com/okou-ai/okou/issues/43704)) ([e1178d4](https://github.com/okou-ai/okou/commit/e1178d447c3757ea95b91a454e1f7521ae9f95b3))
* **api:** bind dcr reauthorization credentials to their issuer ([#43750](https://github.com/okou-ai/okou/issues/43750)) ([c0b14df](https://github.com/okou-ai/okou/commit/c0b14df56dc8f03a6ce45c4c6334dfa9d773132e))
* **artifacts:** preserve web upload creating threads ([#43741](https://github.com/okou-ai/okou/issues/43741)) ([4e088a8](https://github.com/okou-ai/okou/commit/4e088a84978f3410eeb9876e9ea734ffec4d31c3))
* **runner:** unify predecessor home discovery and bounded routing ([#43655](https://github.com/okou-ai/okou/issues/43655)) ([2c512a7](https://github.com/okou-ai/okou/commit/2c512a7542a0adbf22d72e278dc8acdd52a10a6c))


### Refactoring

* **api:** commit workflow inputs atomically ([#43757](https://github.com/okou-ai/okou/issues/43757)) ([66b3ab1](https://github.com/okou-ai/okou/commit/66b3ab1d6ffa9200e5b90eb1f02c29e5db47ed9b))
* **api:** initialize chat threads atomically ([#43699](https://github.com/okou-ai/okou/issues/43699)) ([3c30893](https://github.com/okou-ai/okou/commit/3c30893572d8839de3e5856f94b8d8b0e790bad9))
* **api:** localize chat event retention ownership ([#43779](https://github.com/okou-ai/okou/issues/43779)) ([199dd2c](https://github.com/okou-ai/okou/commit/199dd2ca88f1c53814b4a5d3c6f66371db6801f4))
* **api:** localize per-thread snapshot archive reads ([#43700](https://github.com/okou-ai/okou/issues/43700)) ([016244e](https://github.com/okou-ai/okou/commit/016244ee5ee239bf90e1babde828fbb0dee726dd))
* **api:** localize sidebar snapshot candidate and prune ownership ([#43786](https://github.com/okou-ai/okou/issues/43786)) ([fbb11ec](https://github.com/okou-ai/okou/commit/fbb11ec5c406ff514eb39935d73ad02388aabe8c))
* **api:** localize sidebar snapshot projection and publication ownership ([#43792](https://github.com/okou-ai/okou/issues/43792)) ([9d05442](https://github.com/okou-ai/okou/commit/9d05442e56a4e4469f398120ed5e31e916b827e2))
* **api:** localize snapshot candidate scan ownership ([#43766](https://github.com/okou-ai/okou/issues/43766)) ([ac91112](https://github.com/okou-ai/okou/commit/ac91112a945a7d6b32bec853f473729a7b99f0ea))
* **api:** publish pending launches atomically ([#43793](https://github.com/okou-ai/okou/issues/43793)) ([3663851](https://github.com/okou-ai/okou/commit/366385132053a10d6367ec65ddbf34146fb5cb1a))
* **api:** reserve phone verification cooldowns atomically ([#43778](https://github.com/okou-ai/okou/issues/43778)) ([930260b](https://github.com/okou-ai/okou/commit/930260bfba06e8ab06d5d7843172886d2717e2c1))
* remove expired deployment compatibility ([#43797](https://github.com/okou-ai/okou/issues/43797)) ([94389e2](https://github.com/okou-ai/okou/commit/94389e2203aaa62408b780156c2cf8f9a9cc5414))
* remove slack workspace identity feature switch ([#43717](https://github.com/okou-ai/okou/issues/43717)) ([63323e7](https://github.com/okou-ai/okou/commit/63323e79be903c6316e5052d9c3c54cc9f543db9))


### Performance Improvements

* prepare metadata-only workflow claims and downloads ([#43667](https://github.com/okou-ai/okou/issues/43667)) ([6fd2905](https://github.com/okou-ai/okou/commit/6fd29050029b5a521f75d0500e9876a11649afe6)) [#43642](https://github.com/okou-ai/okou/issues/43642)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.16.0
    * @okouai/core bumped to 8.797.0
    * @okouai/db bumped to 2.9.0
    * @okouai/pi-agent-runtime bumped to 1.51.13

## [2.20.3](https://github.com/okou-ai/okou/compare/api-v2.20.2...api-v2.20.3) (2026-10-28)


### Refactoring

* **api:** localize terminal delivery callback registration ([#43673](https://github.com/okou-ai/okou/issues/43673)) ([4f09fc6](https://github.com/okou-ai/okou/commit/4f09fc66da38072bd2ac33ed9fd8fad319ec8dcf))
* **browser:** roll out okou viewer and remove feature switch ([#43671](https://github.com/okou-ai/okou/issues/43671)) ([97e8ca7](https://github.com/okou-ai/okou/commit/97e8ca71f4d6ac0cd015de589eb5d8179a96bddd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.796.2
    * @okouai/db bumped to 2.8.6
    * @okouai/pi-agent-runtime bumped to 1.51.12

## [2.20.2](https://github.com/okou-ai/okou/compare/api-v2.20.1...api-v2.20.2) (2026-10-28)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.15.0
    * @okouai/core bumped to 8.796.1
    * @okouai/db bumped to 2.8.5
    * @okouai/pi-agent-runtime bumped to 1.51.11

## [2.20.1](https://github.com/okou-ai/okou/compare/api-v2.20.0...api-v2.20.1) (2026-10-28)


### Refactoring

* **api:** localize run lifecycle marker projection ([#43648](https://github.com/okou-ai/okou/issues/43648)) ([ef3665e](https://github.com/okou-ai/okou/commit/ef3665e53ac8a554cc6adb05d2b68889aaccf163))
* **api:** remove tx-0096 connector selection savepoints ([#43658](https://github.com/okou-ai/okou/issues/43658)) ([c2e2d6b](https://github.com/okou-ai/okou/commit/c2e2d6b3ccbb70874d8d8fd5f27b413cb810cfd9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.796.0
    * @okouai/db bumped to 2.8.4
    * @okouai/pi-agent-runtime bumped to 1.51.10

## [2.20.0](https://github.com/okou-ai/okou/compare/api-v2.19.0...api-v2.20.0) (2026-10-28)


### Features

* **mcp:** support catalog-owned static request headers ([#43626](https://github.com/okou-ai/okou/issues/43626)) ([e145904](https://github.com/okou-ai/okou/commit/e145904a15970ef0072eff84c990cf2cc24f6212))


### Bug Fixes

* **pi:** classify opaque codex bad requests ([#43630](https://github.com/okou-ai/okou/issues/43630)) ([fd956ef](https://github.com/okou-ai/okou/commit/fd956ef072e4118fdc15a39febed4e286f479b5d))


### Refactoring

* **api:** localize assistant error event projection ([#43627](https://github.com/okou-ai/okou/issues/43627)) ([3f000f0](https://github.com/okou-ai/okou/commit/3f000f09ced4ddb2e0a49ea5926879a6e8ac2909))
* **api:** localize delivery source callback resolution ([#43637](https://github.com/okou-ai/okou/issues/43637)) ([31fc0ce](https://github.com/okou-ai/okou/commit/31fc0ce9d7647c18af2296ef0700fd365276fd4d))
* **api:** publish workflow copies atomically ([#43614](https://github.com/okou-ai/okou/issues/43614)) ([16d2f50](https://github.com/okou-ai/okou/commit/16d2f50d68f7013791dbb75000d0f4428fdb7d38))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.14.2
    * @okouai/connectors bumped to 3.18.0
    * @okouai/core bumped to 8.795.1
    * @okouai/db bumped to 2.8.3
    * @okouai/pi-agent-runtime bumped to 1.51.9

## [2.19.0](https://github.com/okou-ai/okou/compare/api-v2.18.0...api-v2.19.0) (2026-10-28)


### Features

* prepare dav support and icloud connector rollout ([#43517](https://github.com/okou-ai/okou/issues/43517)) ([c8de621](https://github.com/okou-ai/okou/commit/c8de6212dc54a5aae0d4658acf1afa6a35f939ab))


### Refactoring

* **api:** keep queued run preparation free of database handles ([#43579](https://github.com/okou-ai/okou/issues/43579)) ([5567656](https://github.com/okou-ai/okou/commit/556765662765a03e4b132d71e4268825c3625bf0))
* **api:** localize account deletion automation projections ([#43544](https://github.com/okou-ai/okou/issues/43544)) ([50541a9](https://github.com/okou-ai/okou/commit/50541a95e8f75809fb39696dfa1f56bfd9e98240))
* **api:** localize conversation history deletion execution ([#43587](https://github.com/okou-ai/okou/issues/43587)) ([7c8332c](https://github.com/okou-ai/okou/commit/7c8332cb609613c2fce64440bf0584e592744ddf))
* **api:** localize lifecycle delivery event preparation ([#43613](https://github.com/okou-ai/okou/issues/43613)) ([61bd97f](https://github.com/okou-ai/okou/commit/61bd97f041df6a9983aaa882bdb6513378d11505))
* **api:** localize lifecycle marker replay reads ([#43596](https://github.com/okou-ai/okou/issues/43596)) ([eab1de1](https://github.com/okou-ai/okou/commit/eab1de14b2b681b0d711d51e1f3eb283ae5fc6f6))
* **api:** localize permission grant apply and wakeup ownership ([#43559](https://github.com/okou-ai/okou/issues/43559)) ([924088f](https://github.com/okou-ai/okou/commit/924088ffff73b3283e2776975b268d8026ba1567))
* **api:** localize template preview cache ownership ([#43572](https://github.com/okou-ai/okou/issues/43572)) ([833a746](https://github.com/okou-ai/okou/commit/833a746f14494d6fe502f8f9a87e8aa21305f44a))
* **api:** publish builtin token connections atomically ([#43588](https://github.com/okou-ai/okou/issues/43588)) ([d7ab25a](https://github.com/okou-ai/okou/commit/d7ab25a028124c068673985c44f7aad91f232691))
* **api:** publish custom oauth connections atomically ([#43591](https://github.com/okou-ai/okou/issues/43591)) ([9ad932e](https://github.com/okou-ai/okou/commit/9ad932ed6f41b660462310cc3a1f4614a228593f))
* **api:** publish device oauth completion atomically ([#43593](https://github.com/okou-ai/okou/issues/43593)) ([b1daff6](https://github.com/okou-ai/okou/commit/b1daff632c5524bb868cd901944b6b79c04a76f8))
* **api:** publish hosted allocation without a transaction ([#43567](https://github.com/okou-ai/okou/issues/43567)) ([a94e99a](https://github.com/okou-ai/okou/commit/a94e99a59a59bbc0135f317d467a7e9683f19770)) [#43566](https://github.com/okou-ai/okou/issues/43566)
* **api:** publish legacy subscription projection atomically ([#43581](https://github.com/okou-ai/okou/issues/43581)) ([88d9673](https://github.com/okou-ai/okou/commit/88d9673aedd11ef487ca9d6e9d9d5dc813af73df)) [#43580](https://github.com/okou-ai/okou/issues/43580)
* **app:** read the data router catalog with stateless mcp 2026-07-28 ([#43560](https://github.com/okou-ai/okou/issues/43560)) ([ad90edc](https://github.com/okou-ai/okou/commit/ad90edca2c9121002e169d146fafa8262d947fe7))
* **browser:** simplify cli window attachment ([#43545](https://github.com/okou-ai/okou/issues/43545)) ([e541aab](https://github.com/okou-ai/okou/commit/e541aabc44a2af1e4c8c68cee90ddee789dca45e))


### Performance Improvements

* **api:** select auto directly for mute test setup ([#43568](https://github.com/okou-ai/okou/issues/43568)) ([abd3ee1](https://github.com/okou-ai/okou/commit/abd3ee1978545a41db0d166e8ed9cbf2d492308f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.14.1
    * @okouai/connectors bumped to 3.17.0
    * @okouai/core bumped to 8.795.0
    * @okouai/db bumped to 2.8.2
    * @okouai/pi-agent-runtime bumped to 1.51.8

## [2.18.0](https://github.com/okou-ai/okou/compare/api-v2.17.0...api-v2.18.0) (2026-10-27)


### Features

* **browser:** admit native chat windows through owner control ([#43515](https://github.com/okou-ai/okou/issues/43515)) ([14a00b2](https://github.com/okou-ai/okou/commit/14a00b26dfa03f5b7dd79b8f8c5b4d61a684aa27))


### Refactoring

* **api:** localize terminal chat callback identity reads ([#43527](https://github.com/okou-ai/okou/issues/43527)) ([c53b8be](https://github.com/okou-ai/okou/commit/c53b8be3b0be116424fb6eaa532af19d896ef06d))
* **api:** publish feishu oauth connection in one statement ([#43522](https://github.com/okou-ai/okou/issues/43522)) ([acf40ec](https://github.com/okou-ai/okou/commit/acf40ec7a4b9884ee95f139468a030532e9bc44f))
* **api:** publish workspace bootstrap in one statement ([#43540](https://github.com/okou-ai/okou/issues/43540)) ([58b59ce](https://github.com/okou-ai/okou/commit/58b59ce4337ba0acc78aa021b660edc5b2b90bdb))
* **api:** retire the agent configuration transaction ([#42953](https://github.com/okou-ai/okou/issues/42953)) ([35cf0db](https://github.com/okou-ai/okou/commit/35cf0db6b6559ef5d3fde51569019a0d9fdaf8f7))


### Performance Improvements

* preserve headroom in browser and credit tests ([#43501](https://github.com/okou-ai/okou/issues/43501)) ([366046d](https://github.com/okou-ai/okou/commit/366046dea52dc5c6f0f546df313df654a8545400))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.14.0
    * @okouai/core bumped to 8.794.1
    * @okouai/db bumped to 2.8.1
    * @okouai/pi-agent-runtime bumped to 1.51.7

## [2.17.0](https://github.com/okou-ai/okou/compare/api-v2.16.0...api-v2.17.0) (2026-10-27)


### Features

* **browser:** bind cli tools to chat windows ([#43449](https://github.com/okou-ai/okou/issues/43449)) ([a591c65](https://github.com/okou-ai/okou/commit/a591c65fb21156ab71f7d3f20584a1632f247f89))
* **cli:** add connector account disconnect command ([#43475](https://github.com/okou-ai/okou/issues/43475)) ([f1ebfa9](https://github.com/okou-ai/okou/commit/f1ebfa965b91f329ab91398bc311531b51a09e3a))
* release website controls and thread email manager ([#43476](https://github.com/okou-ai/okou/issues/43476)) ([e9989fb](https://github.com/okou-ai/okou/commit/e9989fbe0eceec17fe7d0ede926236d729b299cd))
* remove the x share quest from get started ([#43455](https://github.com/okou-ai/okou/issues/43455)) ([3059ea2](https://github.com/okou-ai/okou/commit/3059ea2c584b81e069c750e0e9f2f2e531f03e83))


### Bug Fixes

* **api:** include failure reasons in chat-run-finished automations ([#43448](https://github.com/okou-ai/okou/issues/43448)) ([0f0b749](https://github.com/okou-ai/okou/commit/0f0b7499a85823450ea7e949ee20136007099636))
* **app:** restrict agent self-management to custom agents ([#43481](https://github.com/okou-ai/okou/issues/43481)) ([c9c00ca](https://github.com/okou-ai/okou/commit/c9c00ca806f8fbfcd2cc451ffac6c8aa1a61d908))


### Refactoring

* **api:** handle feishu disconnect commands atomically ([#43424](https://github.com/okou-ai/okou/issues/43424)) ([8f01de7](https://github.com/okou-ai/okou/commit/8f01de7254470f7fabedd76b2b646b405e6a28b2))
* **api:** localize completed-run follow-up publication ([#43498](https://github.com/okou-ai/okou/issues/43498)) ([7b25d5c](https://github.com/okou-ai/okou/commit/7b25d5cd3fe3f75326f48051a05372332f752884))
* **api:** localize completed-run output reads ([#43471](https://github.com/okou-ai/okou/issues/43471)) ([effed9b](https://github.com/okou-ai/okou/commit/effed9bf6420a93054005cf4111efb6a2934f1da))
* **data:** speak only stateless mcp 2026-07-28 to data router ([#43447](https://github.com/okou-ai/okou/issues/43447)) ([bb57027](https://github.com/okou-ai/okou/commit/bb57027eaa3a6a1856cfa35c5f6b87cf0a2a6549))
* let data router own its tool catalog ([#43457](https://github.com/okou-ai/okou/issues/43457)) ([5152b2d](https://github.com/okou-ai/okou/commit/5152b2d43e1cdefe15cf338cd43abdaf19f84504))


### Performance Improvements

* **api:** checkpoint isolated database baselines before publishing ([#43443](https://github.com/okou-ai/okou/issues/43443)) ([c7b41d5](https://github.com/okou-ai/okou/commit/c7b41d5b61d1af847aeecc1512482a3100fe3882))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.13.0
    * @okouai/core bumped to 8.794.0
    * @okouai/db bumped to 2.8.0
    * @okouai/pi-agent-runtime bumped to 1.51.6

## [2.16.0](https://github.com/okou-ai/okou/compare/api-v2.15.0...api-v2.16.0) (2026-10-27)


### Features

* **api:** add read-only run settlement audit ([#43437](https://github.com/okou-ai/okou/issues/43437)) ([4f0a695](https://github.com/okou-ai/okou/commit/4f0a695df855b52176fcc85506b456d10fad95ae))


### Bug Fixes

* expire stale suggestions without blocking cached choices ([#43401](https://github.com/okou-ai/okou/issues/43401)) ([683f3b7](https://github.com/okou-ai/okou/commit/683f3b71885993682d583b32c51f1cd998a1860b))


### Refactoring

* **api:** localize completed-run output timing ownership ([#43410](https://github.com/okou-ai/okou/issues/43410)) ([decd8c1](https://github.com/okou-ai/okou/commit/decd8c19e644ffb356165d116ce7e4eb437e5dd9))
* keep shared error and token modules off heavy dependencies ([#43439](https://github.com/okou-ai/okou/issues/43439)) ([ca70c33](https://github.com/okou-ai/okou/commit/ca70c33b2ce91a0065a3d2f76e409724d7bd50e9))


### Performance Improvements

* **api:** remove sentry from the worker and keep esm package builds ([#43402](https://github.com/okou-ai/okou/issues/43402)) ([e72c853](https://github.com/okou-ai/okou/commit/e72c853c55d352bd342ba087e9bef33879704005))
* **api:** validate environment before deployment instead of at startup ([#43411](https://github.com/okou-ai/okou/issues/43411)) ([c372473](https://github.com/okou-ai/okou/commit/c372473f8ce7b9e6dfc6934ad3f90e79b843811a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.12.0
    * @okouai/core bumped to 8.793.4
    * @okouai/db bumped to 2.7.1
    * @okouai/pi-agent-runtime bumped to 1.51.5

## [2.15.0](https://github.com/okou-ai/okou/compare/api-v2.14.3...api-v2.15.0) (2026-10-27)


### Features

* add custom directions to homepage suggestions ([#43407](https://github.com/okou-ai/okou/issues/43407)) ([062b543](https://github.com/okou-ai/okou/commit/062b54351f76fc65f05a02b7ff74d102e3874a6f))
* **browser:** configure browser use extension ids ([#43400](https://github.com/okou-ai/okou/issues/43400)) ([646c39a](https://github.com/okou-ai/okou/commit/646c39a755d440a2a2179fd554eb18425616a595))
* **ios:** prefetch notification content through a service extension ([#43364](https://github.com/okou-ai/okou/issues/43364)) ([28aeca6](https://github.com/okou-ai/okou/commit/28aeca6140c499cc17746d4d15c29eb69c478382))
* prepare 4096-entry home cache readers ([#43397](https://github.com/okou-ai/okou/issues/43397)) ([edb4852](https://github.com/okou-ai/okou/commit/edb4852fb0217f4e8a2bf0bdf481fc4037a1d5a1))


### Refactoring

* **api:** disconnect feishu members atomically ([#43399](https://github.com/okou-ai/okou/issues/43399)) ([6730b2c](https://github.com/okou-ai/okou/commit/6730b2ce2206f8593fd460a096a6e676dfa649d1))


### Performance Improvements

* **api:** exclude vercel packages from the worker bundle ([#43405](https://github.com/okou-ai/okou/issues/43405)) ([87bc4be](https://github.com/okou-ai/okou/commit/87bc4be34f36c762165219b3dd4029de28f89bfc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.11.0
    * @okouai/core bumped to 8.793.3
    * @okouai/db bumped to 2.7.0
    * @okouai/pi-agent-runtime bumped to 1.51.4

## [2.14.3](https://github.com/okou-ai/okou/compare/api-v2.14.2...api-v2.14.3) (2026-10-27)


### Bug Fixes

* **ios:** make notification prefetch independent of view startup ([#43351](https://github.com/okou-ai/okou/issues/43351)) ([31755af](https://github.com/okou-ai/okou/commit/31755af2464549923535e305a545ab1cf5618fd0))
* **slack:** preserve receiving workspace during ingress status reconciliation ([#43345](https://github.com/okou-ai/okou/issues/43345)) ([8772664](https://github.com/okou-ai/okou/commit/8772664ecc18c29da2fe5e6ceea0a3aa6e994757)) [#43286](https://github.com/okou-ai/okou/issues/43286)


### Refactoring

* **api:** publish no-auth connector accounts atomically ([#43371](https://github.com/okou-ai/okou/issues/43371)) ([d10c0e5](https://github.com/okou-ai/okou/commit/d10c0e5cec9745765701f150cda6d01e1b79b713))


### Performance Improvements

* **api:** streamline low-credit alert scenario preparation ([#43370](https://github.com/okou-ai/okou/issues/43370)) ([d57eeba](https://github.com/okou-ai/okou/commit/d57eeba4ee87ceb2e295a07b123d535c35126175))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.10.2
    * @okouai/core bumped to 8.793.2
    * @okouai/db bumped to 2.6.10
    * @okouai/pi-agent-runtime bumped to 1.51.3

## [2.14.2](https://github.com/okou-ai/okou/compare/api-v2.14.1...api-v2.14.2) (2026-10-27)


### Refactoring

* **api:** publish manual connector grants atomically ([#43348](https://github.com/okou-ai/okou/issues/43348)) ([8ca4477](https://github.com/okou-ai/okou/commit/8ca447774340526a7ed93fc7b6c5946a979cfa30))


### Performance Improvements

* **api:** split WeChat owner file delivery from native history ([#43354](https://github.com/okou-ai/okou/issues/43354)) ([ae2d02b](https://github.com/okou-ai/okou/commit/ae2d02bdbfd472e4ab3b9060b687d304be3107a1))

## [2.14.1](https://github.com/okou-ai/okou/compare/api-v2.14.0...api-v2.14.1) (2026-10-27)


### Bug Fixes

* **api:** unwrap settlement callback result types ([#43335](https://github.com/okou-ai/okou/issues/43335)) ([5813e04](https://github.com/okou-ai/okou/commit/5813e04980ba84191177732eb8a13eaf571f3d34))
* classify all-endpoint model guardrail refusals ([#43337](https://github.com/okou-ai/okou/issues/43337)) ([c2a90f0](https://github.com/okou-ai/okou/commit/c2a90f0c2bf594775579b7b00c27e3cad6d87a19))


### Refactoring

* **api:** localize thread storage snapshot database ownership ([#43340](https://github.com/okou-ai/okou/issues/43340)) ([c424a1a](https://github.com/okou-ai/okou/commit/c424a1a8d4ea1046c4b9fa5fb5b886a4ff0c155a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.10.1
    * @okouai/core bumped to 8.793.1
    * @okouai/db bumped to 2.6.9
    * @okouai/pi-agent-runtime bumped to 1.51.2

## [2.14.0](https://github.com/okou-ai/okou/compare/api-v2.13.5...api-v2.14.0) (2026-10-27)


### Features

* **api:** honor claim response budgets before accepting jobs ([#43296](https://github.com/okou-ai/okou/issues/43296)) ([fbe7f30](https://github.com/okou-ai/okou/commit/fbe7f30e1bc1e3379069bda30fe73b12e103439a))


### Bug Fixes

* **chat:** preserve drafts when selected connector accounts disappear ([#43293](https://github.com/okou-ai/okou/issues/43293)) ([351b13f](https://github.com/okou-ai/okou/commit/351b13f0f371eeae1f968a57887595b25b7762dc))
* prepare workflow claim readers for document contexts ([#43310](https://github.com/okou-ai/okou/issues/43310)) ([9adf103](https://github.com/okou-ai/okou/commit/9adf103d18ed8987942777df4b79fddebdcc9778))


### Refactoring

* **api:** localize runner output projection database ownership ([#43311](https://github.com/okou-ai/okou/issues/43311)) ([17d8e57](https://github.com/okou-ai/okou/commit/17d8e57903e61fcb0a4ee5179767993349273322))
* **api:** settle morning brief schedules atomically ([#43305](https://github.com/okou-ai/okou/issues/43305)) ([bb7bb3e](https://github.com/okou-ai/okou/commit/bb7bb3e24c2c12302e2b841aeda7b00f9233c7df))
* **browser:** remove unused runner cdp access apis ([#43301](https://github.com/okou-ai/okou/issues/43301)) ([5bc0e69](https://github.com/okou-ai/okou/commit/5bc0e697dc50b1f623f56c4c943bd28808d132c8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.10.0
    * @okouai/core bumped to 8.793.0
    * @okouai/db bumped to 2.6.8
    * @okouai/pi-agent-runtime bumped to 1.51.1

## [2.13.5](https://github.com/okou-ai/okou/compare/api-v2.13.4...api-v2.13.5) (2026-10-27)


### Bug Fixes

* **ios:** synchronize notification read state and icon badges ([#43254](https://github.com/okou-ai/okou/issues/43254)) ([3f5d6fc](https://github.com/okou-ai/okou/commit/3f5d6fcaf6de5148ea3266d0e0eec538f136df94))


### Refactoring

* **api:** publish custom connector values atomically ([#43278](https://github.com/okou-ai/okou/issues/43278)) ([9dc07c0](https://github.com/okou-ai/okou/commit/9dc07c0cc0e633716f58a2c65b0040054699bbc6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.9.0
    * @okouai/core bumped to 8.792.0
    * @okouai/db bumped to 2.6.7
    * @okouai/pi-agent-runtime bumped to 1.51.0

## [2.13.4](https://github.com/okou-ai/okou/compare/api-v2.13.3...api-v2.13.4) (2026-10-27)


### Bug Fixes

* **api:** follow browser provider redirects for runner connections ([#43224](https://github.com/okou-ai/okou/issues/43224)) ([6772298](https://github.com/okou-ai/okou/commit/6772298db63272c15a438c89a2b4b0b51312040a))
* **workflows:** handle unavailable gmail labels in forms ([#43245](https://github.com/okou-ai/okou/issues/43245)) ([a2a522b](https://github.com/okou-ai/okou/commit/a2a522b7a13dee40a5f86af51bf9490db4c77496))


### Refactoring

* **api:** activate usage-pack plans atomically ([#43236](https://github.com/okou-ai/okou/issues/43236)) ([afb0cc0](https://github.com/okou-ai/okou/commit/afb0cc0e55e74576cdb0124b61fc7f8180e82a74))
* **api:** disconnect personal accounts atomically ([#43178](https://github.com/okou-ai/okou/issues/43178)) ([057c4d7](https://github.com/okou-ai/okou/commit/057c4d7347d0a1777a45df50803a00c22b30e06b))
* **api:** fulfill subscription change invoices atomically ([#43255](https://github.com/okou-ai/okou/issues/43255)) ([7e84bf0](https://github.com/okou-ai/okou/commit/7e84bf0a313eb905536f62c7bb6f23fcc25dbd7e))
* **api:** localize automation thread model writes ([#43252](https://github.com/okou-ai/okou/issues/43252)) ([4239612](https://github.com/okou-ai/okou/commit/42396125bc1699e54ed77f8095f119511b3a10ed))
* **api:** localize queue monitor database reads ([#43270](https://github.com/okou-ai/okou/issues/43270)) ([6b5487c](https://github.com/okou-ai/okou/commit/6b5487cc190b51d8113ed2c7c730d817dd9e61cd))
* **api:** localize run-slot release sql ([#43206](https://github.com/okou-ai/okou/issues/43206)) ([1c7c17f](https://github.com/okou-ai/okou/commit/1c7c17f481957c8116df4744c28d0a130281d6ea))
* **api:** localize sandbox maintenance database ownership ([#43275](https://github.com/okou-ai/okou/issues/43275)) ([568d22a](https://github.com/okou-ai/okou/commit/568d22ab4dacef09a3a4aa0b186185fa42622ee5))
* **api:** localize steerable pending-input reads ([#43262](https://github.com/okou-ai/okou/issues/43262)) ([3722262](https://github.com/okou-ai/okou/commit/3722262fb0be015cfd3dcf6d821ab3ff40d24c2c))
* **api:** localize storage base-index reads ([#43232](https://github.com/okou-ai/okou/issues/43232)) ([905ba0e](https://github.com/okou-ai/okou/commit/905ba0e57029a59c99ba510b822710748a0fda26))
* **api:** localize storage prefix-version reads ([#43238](https://github.com/okou-ai/okou/issues/43238)) ([080183b](https://github.com/okou-ai/okou/commit/080183b4cd3e9b101402461dd22d79fb776702cc))
* **api:** publish automatic no-auth connections atomically ([#43273](https://github.com/okou-ai/okou/issues/43273)) ([bf71ca7](https://github.com/okou-ai/okou/commit/bf71ca7de210e3b22c63e0b9e9d509f50bd41931))
* **api:** publish normal chat input atomically ([#43267](https://github.com/okou-ai/okou/issues/43267)) ([e0a7fde](https://github.com/okou-ai/okou/commit/e0a7fded0a1d3262d5acc0b8917b7a3996eb77e7))
* **api:** publish personal subscription accounts atomically ([#43230](https://github.com/okou-ai/okou/issues/43230)) ([b44e7af](https://github.com/okou-ai/okou/commit/b44e7af6eac65c6abdf769f79d351aef428094b9))
* **api:** publish Run completion atomically ([#43263](https://github.com/okou-ai/okou/issues/43263)) ([8634dc3](https://github.com/okou-ai/okou/commit/8634dc3aa6fedbeb598c81786a79ff2094da9d35))
* **api:** publish workflow visibility atomically ([#43271](https://github.com/okou-ai/okou/issues/43271)) ([f96edeb](https://github.com/okou-ai/okou/commit/f96edebe2969bbe959b775ba3326573c5b4db1aa))
* **api:** reserve member removal atomically ([#43259](https://github.com/okou-ai/okou/issues/43259)) ([2e0c202](https://github.com/okou-ai/okou/commit/2e0c202fa3f8aae326b19c919ae0f9158a3bd761))
* **api:** revoke member run authority atomically ([#43244](https://github.com/okou-ai/okou/issues/43244)) ([434c599](https://github.com/okou-ai/okou/commit/434c599ba587c258cd98c22e846ae4b65374a1e0))
* **app:** remove retry and manual refresh paths ([#43134](https://github.com/okou-ai/okou/issues/43134)) ([6332129](https://github.com/okou-ai/okou/commit/63321296c59e981b70b8431211dd0d64ece04303))
* **chat:** remove citation processing and reduce history rendering ([#43148](https://github.com/okou-ai/okou/issues/43148)) ([26bacab](https://github.com/okou-ai/okou/commit/26bacab4693d32e4a4453dce5c84e565d7129b9c))
* remove discord integration switch ([#43183](https://github.com/okou-ai/okou/issues/43183)) ([721475a](https://github.com/okou-ai/okou/commit/721475a60a8ee46afd39e4bb112e1ffd08880eb6))
* remove hosted site title editing switch ([#43172](https://github.com/okou-ai/okou/issues/43172)) ([6ccbf0c](https://github.com/okou-ai/okou/commit/6ccbf0c46160029d7cf45d4f76d40b382f90f774))
* remove remote connection diagnostics feature switch ([#43208](https://github.com/okou-ai/okou/issues/43208)) ([e2abf5a](https://github.com/okou-ai/okou/commit/e2abf5ade9bb1322e519d839b47c66d2ec58a16c))
* remove vnc access feature switch ([#43184](https://github.com/okou-ai/okou/issues/43184)) ([7caac90](https://github.com/okou-ai/okou/commit/7caac9058cd8740c5288ef0c560e723d562120a8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.8.3
    * @okouai/core bumped to 8.791.4
    * @okouai/db bumped to 2.6.6
    * @okouai/pi-agent-runtime bumped to 1.50.81

## [2.13.3](https://github.com/okou-ai/okou/compare/api-v2.13.2...api-v2.13.3) (2026-10-26)


### Refactoring

* remove built-in document templates feature switch ([#43158](https://github.com/okou-ai/okou/issues/43158)) ([af5a4ce](https://github.com/okou-ai/okou/commit/af5a4ce2a1a33fb1d706ec262617eeda0316642a))
* require named zod imports and route-owned http policies ([#43155](https://github.com/okou-ai/okou/issues/43155)) ([20685b6](https://github.com/okou-ai/okou/commit/20685b655da844b5df38384a136deec14037fe76))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.8.2
    * @okouai/connectors bumped to 3.16.14
    * @okouai/core bumped to 8.791.3
    * @okouai/db bumped to 2.6.5
    * @okouai/pi-agent-runtime bumped to 1.50.80

## [2.13.2](https://github.com/okou-ai/okou/compare/api-v2.13.1...api-v2.13.2) (2026-10-26)


### Refactoring

* remove chat resource panel feature switch ([#43157](https://github.com/okou-ai/okou/issues/43157)) ([4b47789](https://github.com/okou-ai/okou/commit/4b477894060640e8ea0a5ef50a23a56f8f83fe2a))
* remove custom templates feature switch ([#43162](https://github.com/okou-ai/okou/issues/43162)) ([6909a01](https://github.com/okou-ai/okou/commit/6909a011d4b2d60d5afc3fe6f5f0698d269aad28))
* remove google docs and sheets conversion switch ([#43154](https://github.com/okou-ai/okou/issues/43154)) ([be0a3ca](https://github.com/okou-ai/okou/commit/be0a3ca522cd5edd2748912bcbecf4c07d76ff38))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.791.2
    * @okouai/db bumped to 2.6.4
    * @okouai/pi-agent-runtime bumped to 1.50.79

## [2.13.1](https://github.com/okou-ai/okou/compare/api-v2.13.0...api-v2.13.1) (2026-10-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.8.1
    * @okouai/core bumped to 8.791.1
    * @okouai/db bumped to 2.6.3
    * @okouai/pi-agent-runtime bumped to 1.50.78

## [2.13.0](https://github.com/okou-ai/okou/compare/api-v2.12.0...api-v2.13.0) (2026-10-26)


### Features

* **slack:** enable workspace identity by default ([#43130](https://github.com/okou-ai/okou/issues/43130)) ([8973aac](https://github.com/okou-ai/okou/commit/8973aacb5a62e2a072b9dcd7669135813960110d))


### Refactoring

* decouple suggestions from proactive agent ([#43143](https://github.com/okou-ai/okou/issues/43143)) ([dc2aa55](https://github.com/okou-ai/okou/commit/dc2aa5555eb6930828b7dd4ddf47d8e3b8379da2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.791.0
    * @okouai/db bumped to 2.6.2
    * @okouai/pi-agent-runtime bumped to 1.50.77

## [2.12.0](https://github.com/okou-ai/okou/compare/api-v2.11.0...api-v2.12.0) (2026-10-26)


### Features

* add expanded action options to homepage suggestions ([#43104](https://github.com/okou-ai/okou/issues/43104)) ([fdf92c5](https://github.com/okou-ai/okou/commit/fdf92c5beea97015267ae6dbb74e7db58ce0a344))


### Bug Fixes

* **api:** prevent runner usage publication deadlocks ([#43117](https://github.com/okou-ai/okou/issues/43117)) ([423e716](https://github.com/okou-ai/okou/commit/423e71638493dac434aaf645bafda0ac17f8f1bb))
* **api:** return conflict for competing expired usage pack previews ([#43102](https://github.com/okou-ai/okou/issues/43102)) ([56826ea](https://github.com/okou-ai/okou/commit/56826eae800835f13959846e54691425cd8bbe86))


### CI

* **api:** deploy an auxiliary production worker during releases ([#43073](https://github.com/okou-ai/okou/issues/43073)) ([df5501e](https://github.com/okou-ai/okou/commit/df5501ecbfbde69111c9067cdbe77c2ed0e0203e))
* retire github desktop manifest mirror ([#43097](https://github.com/okou-ai/okou/issues/43097)) ([7b91141](https://github.com/okou-ai/okou/commit/7b91141956c5bb4581f5e422144f34e1d3971243))


### Refactoring

* **api:** own runner claim transition writes ([#43101](https://github.com/okou-ai/okou/issues/43101)) ([713d396](https://github.com/okou-ai/okou/commit/713d396bf5901781d8278a07c2b35ca4cbb30a76))
* **api:** read native predecessors from thread state ([#43106](https://github.com/okou-ai/okou/issues/43106)) ([158c2bd](https://github.com/okou-ai/okou/commit/158c2bd59b402738e501a1dc1b82c93c4af41061))
* **data:** drop retired managed data storage ([#42942](https://github.com/okou-ai/okou/issues/42942)) ([c9b25eb](https://github.com/okou-ai/okou/commit/c9b25eb26d18dab6cb01c60453fa4729fdd50247))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.8.0
    * @okouai/core bumped to 8.790.3
    * @okouai/db bumped to 2.6.1
    * @okouai/pi-agent-runtime bumped to 1.50.76

## [2.11.0](https://github.com/okou-ai/okou/compare/api-v2.10.0...api-v2.11.0) (2026-10-26)


### Features

* **ios:** add native push notifications and background chat sync ([#43061](https://github.com/okou-ai/okou/issues/43061)) ([bf9afc5](https://github.com/okou-ai/okou/commit/bf9afc5c36eb41eb67a9be3e7f8ec99fcbaad217))


### Bug Fixes

* **api:** expose preview access denials to allowed app origins ([#43060](https://github.com/okou-ai/okou/issues/43060)) ([327e72f](https://github.com/okou-ai/okou/commit/327e72f4088421ad1e4d927607a93a4bd2353344))


### Refactoring

* **api:** simplify outbound http and request lifetimes ([#43014](https://github.com/okou-ai/okou/issues/43014)) ([747df24](https://github.com/okou-ai/okou/commit/747df241cd867a5d56fae3be119bb6c14b3b23a6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.7.0
    * @okouai/connectors bumped to 3.16.13
    * @okouai/core bumped to 8.790.2
    * @okouai/db bumped to 2.6.0
    * @okouai/pi-agent-runtime bumped to 1.50.75

## [2.10.0](https://github.com/okou-ai/okou/compare/api-v2.9.1...api-v2.10.0) (2026-10-26)


### Features

* **browser:** create and reuse owner provider profiles ([#43019](https://github.com/okou-ai/okou/issues/43019)) ([42d685e](https://github.com/okou-ai/okou/commit/42d685e6f3ac2319bedec1a10d90e25df9ae1409))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.6.0
    * @okouai/core bumped to 8.790.1
    * @okouai/db bumped to 2.5.2
    * @okouai/pi-agent-runtime bumped to 1.50.74

## [2.9.1](https://github.com/okou-ai/okou/compare/api-v2.9.0...api-v2.9.1) (2026-10-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.5.1

## [2.9.0](https://github.com/okou-ai/okou/compare/api-v2.8.0...api-v2.9.0) (2026-10-26)


### Features

* **api:** authenticate workers to google with certificate federation ([#43020](https://github.com/okou-ai/okou/issues/43020)) ([3b4c49c](https://github.com/okou-ai/okou/commit/3b4c49cf1ae93bf640d00da44069890c7b1d9d22))


### Bug Fixes

* publish desktop update manifests atomically from r2 ([#43047](https://github.com/okou-ai/okou/issues/43047)) ([2cb8694](https://github.com/okou-ai/okou/commit/2cb8694d3a9a6172219e515bc47981329e707ca5))


### Refactoring

* **api:** localize connected automation reprojection ([#43037](https://github.com/okou-ai/okou/issues/43037)) ([1a42597](https://github.com/okou-ai/okou/commit/1a425971e2597fb91e648fd190f3307caa931717))

## [2.8.0](https://github.com/okou-ai/okou/compare/api-v2.7.0...api-v2.8.0) (2026-10-26)


### Features

* roll out tailscale setup and remove its feature switch ([#43012](https://github.com/okou-ai/okou/issues/43012)) ([78533ae](https://github.com/okou-ai/okou/commit/78533ae6f68a2ba6c58412e84c3e797646ec611f))
* unify proactive planning and action settings ([#43022](https://github.com/okou-ai/okou/issues/43022)) ([305115c](https://github.com/okou-ai/okou/commit/305115c9796cd4994f93e152391c2d815720b482))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.5.0
    * @okouai/core bumped to 8.790.0
    * @okouai/db bumped to 2.5.0
    * @okouai/pi-agent-runtime bumped to 1.50.73

## [2.7.0](https://github.com/okou-ai/okou/compare/api-v2.6.1...api-v2.7.0) (2026-10-26)


### Features

* **browser:** model owner sessions and chat primary windows ([#42938](https://github.com/okou-ai/okou/issues/42938)) ([5cd8ddb](https://github.com/okou-ai/okou/commit/5cd8ddb331eff41efb1504416ad0f2619e5ed62b))


### Refactoring

* **api:** publish deferred schedules atomically ([#42993](https://github.com/okou-ai/okou/issues/42993)) ([1ae5da7](https://github.com/okou-ai/okou/commit/1ae5da71f9242e3edc27836ffa86ed4dc4963bc6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.4.0
    * @okouai/core bumped to 8.789.0
    * @okouai/db bumped to 2.4.0
    * @okouai/pi-agent-runtime bumped to 1.50.72

## [2.6.1](https://github.com/okou-ai/okou/compare/api-v2.6.0...api-v2.6.1) (2026-10-26)


### Refactoring

* **api:** localize custom connector credential publication ([#42979](https://github.com/okou-ai/okou/issues/42979)) ([a14f41d](https://github.com/okou-ai/okou/commit/a14f41d174f00d7298057d59f9878d6efa5ba5c8))

## [2.6.0](https://github.com/okou-ai/okou/compare/api-v2.5.0...api-v2.6.0) (2026-10-26)


### Features

* **core:** enable custom templates for all users ([#42921](https://github.com/okou-ai/okou/issues/42921)) ([1cc417d](https://github.com/okou-ai/okou/commit/1cc417d66219754cfeefbdd01df557f84a245a02))


### Refactoring

* **api:** cancel banned user runs atomically ([#42969](https://github.com/okou-ai/okou/issues/42969)) ([9d916c2](https://github.com/okou-ai/okou/commit/9d916c208ba4ffb03205247cfa19522e5b84cc10))
* **api:** cancel single runs atomically ([#42973](https://github.com/okou-ai/okou/issues/42973)) ([343ad23](https://github.com/okou-ai/okou/commit/343ad2337ba36667101e6a2b83562a86e7553c5a))
* **api:** localize builtin token credential writes ([#42961](https://github.com/okou-ai/okou/issues/42961)) ([9e950cc](https://github.com/okou-ai/okou/commit/9e950cc613b1da4511b85d7d767c2c0d5ffce3aa))
* **api:** localize builtin token replacement cleanup ([#42971](https://github.com/okou-ai/okou/issues/42971)) ([759231c](https://github.com/okou-ai/okou/commit/759231cc025afd1fe06be772d0ad1ccea35595c3))
* **api:** localize connector connection metadata writes ([#42948](https://github.com/okou-ai/okou/issues/42948)) ([265b6d6](https://github.com/okou-ai/okou/commit/265b6d6d42a2f00436ea86df24a09cfc777d5e66))
* **api:** localize connector replacement credential writes ([#42925](https://github.com/okou-ai/okou/issues/42925)) ([437e8fe](https://github.com/okou-ai/okou/commit/437e8fefb9b50bd09a0cae4125bf76e6205f7858))
* **api:** publish allocation quotes atomically ([#42965](https://github.com/okou-ai/okou/issues/42965)) ([14593d3](https://github.com/okou-ai/okou/commit/14593d34464fd3e5046ac1eb7b4cb240acbcf3b7))
* **api:** publish managed feishu connectors atomically ([#42959](https://github.com/okou-ai/okou/issues/42959)) ([c062ae4](https://github.com/okou-ai/okou/commit/c062ae4366d157dc231f74e102d574f44afa19cf))
* **api:** publish official workflow catalogs atomically ([#42955](https://github.com/okou-ai/okou/issues/42955)) ([4ff25ad](https://github.com/okou-ai/okou/commit/4ff25ad198b37a12e79ecca7e3dc04b7e708313e))
* **api:** publish reflected usage pack allocations atomically ([#42941](https://github.com/okou-ai/okou/issues/42941)) ([3475d9e](https://github.com/okou-ai/okou/commit/3475d9e5a89704d66bbaecdc6bc51b910d195198))
* **api:** publish usage pack checkout state atomically ([#42917](https://github.com/okou-ai/okou/issues/42917)) ([41fcc19](https://github.com/okou-ai/okou/commit/41fcc193c2f1126494de788a0e3476c62bd0f7e6))
* **api:** remove managed feishu installations atomically ([#42963](https://github.com/okou-ai/okou/issues/42963)) ([935491e](https://github.com/okou-ai/okou/commit/935491e356aacad32f86e730831739e50f4ca6ea))
* **api:** retire reconciled usage pack snapshots atomically ([#42945](https://github.com/okou-ai/okou/issues/42945)) ([588e43c](https://github.com/okou-ai/okou/commit/588e43c65b7094ca3e378075673102d26c65cf28))
* **api:** time out stale runs atomically ([#42975](https://github.com/okou-ai/okou/issues/42975)) ([363d1a0](https://github.com/okou-ai/okou/commit/363d1a0e502d705985081c19e88cb164c412980a))
* **computer-use:** drop capability-empty Desktop host compatibility ([#42966](https://github.com/okou-ai/okou/issues/42966)) ([fe10614](https://github.com/okou-ai/okou/commit/fe106140ae2558594f7284ac7994eeee0c077b43))
* **data:** remove retired managed data runtime scaffolding ([#42935](https://github.com/okou-ai/okou/issues/42935)) ([b220a50](https://github.com/okou-ai/okou/commit/b220a504c5e633de162791f1216c4458188ffe72))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.3.1
    * @okouai/core bumped to 8.788.0
    * @okouai/db bumped to 2.3.1
    * @okouai/pi-agent-runtime bumped to 1.50.71

## [2.5.0](https://github.com/okou-ai/okou/compare/api-v2.4.2...api-v2.5.0) (2026-10-25)


### Features

* cut over data tools to dynamic router discovery ([#42695](https://github.com/okou-ai/okou/issues/42695)) ([28d1842](https://github.com/okou-ai/okou/commit/28d18426d6282b443344e3a3cabdec11ee13bc03))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.3.0
    * @okouai/core bumped to 8.787.1
    * @okouai/db bumped to 2.3.0
    * @okouai/pi-agent-runtime bumped to 1.50.70

## [2.4.2](https://github.com/okou-ai/okou/compare/api-v2.4.1...api-v2.4.2) (2026-10-25)


### Refactoring

* **api:** claim email outbox items without a transaction ([#42908](https://github.com/okou-ai/okou/issues/42908)) ([d6d32bc](https://github.com/okou-ai/okou/commit/d6d32bce5fd68f405e73dddf98d9c213b9609d3d))
* **api:** localize connector account insertion arbitration ([#42902](https://github.com/okou-ai/okou/issues/42902)) ([31cbb22](https://github.com/okou-ai/okou/commit/31cbb22d79e4b0651bd38f91e1e4b7466a1b5a49))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.787.0
    * @okouai/db bumped to 2.2.5
    * @okouai/pi-agent-runtime bumped to 1.50.69

## [2.4.1](https://github.com/okou-ai/okou/compare/api-v2.4.0...api-v2.4.1) (2026-10-25)


### Refactoring

* **api:** guard workflow callback publication without a transaction ([#42888](https://github.com/okou-ai/okou/issues/42888)) ([8bd8f19](https://github.com/okou-ai/okou/commit/8bd8f19f9827be7cd46cc75567bc0e0a572d75a7))
* **api:** publish phone identity and reward atomically ([#42880](https://github.com/okou-ai/okou/issues/42880)) ([97779e2](https://github.com/okou-ai/okou/commit/97779e23c6fd30b0444c026a6eb19f42b1dec0bd))

## [2.4.0](https://github.com/okou-ai/okou/compare/api-v2.3.3...api-v2.4.0) (2026-10-25)


### Features

* **core:** enable built-in document templates for everyone ([#42580](https://github.com/okou-ai/okou/issues/42580)) ([f61c808](https://github.com/okou-ai/okou/commit/f61c808adf249d8ef7767548df0893e99d0246ff))


### Refactoring

* **api:** localize permission grant agent preflight ([#42858](https://github.com/okou-ai/okou/issues/42858)) ([506e50b](https://github.com/okou-ai/okou/commit/506e50b97eb2d7715a5c6f1629630652b105a955))
* **api:** localize runner poison-job preflight ([#42878](https://github.com/okou-ai/okou/issues/42878)) ([97d2177](https://github.com/okou-ai/okou/commit/97d21771fcf186a088ee5b142f94a92e30560daa))
* **api:** publish prepared volumes atomically ([#42854](https://github.com/okou-ai/okou/issues/42854)) ([7e737d8](https://github.com/okou-ai/okou/commit/7e737d85d7f763583336bacf44b4c988a0bb8f40))
* **api:** publish webhook automation atomically ([#42866](https://github.com/okou-ai/okou/issues/42866)) ([e6728df](https://github.com/okou-ai/okou/commit/e6728df818d2352e17e3fa40cc2dd448d612fd32))


### Performance Improvements

* **api:** narrow catalog queries to consumer fields ([#42864](https://github.com/okou-ai/okou/issues/42864)) ([66854c5](https://github.com/okou-ai/okou/commit/66854c5fd1bd2b5109e1fbe25272fe693902bf99))
* reduce resource and workflow publication overhead ([#42783](https://github.com/okou-ai/okou/issues/42783)) ([efca2a9](https://github.com/okou-ai/okou/commit/efca2a9ee30dcb5bad41396943784b3714e9e69f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.786.0
    * @okouai/db bumped to 2.2.4
    * @okouai/pi-agent-runtime bumped to 1.50.68

## [2.3.3](https://github.com/okou-ai/okou/compare/api-v2.3.2...api-v2.3.3) (2026-10-25)


### Refactoring

* **api:** clear thread connector selections atomically ([#42832](https://github.com/okou-ai/okou/issues/42832)) ([e6c3a00](https://github.com/okou-ai/okou/commit/e6c3a0003b373eead51dfd04f3c31b2fb18720f6))
* **api:** localize personal logical provider identity ([#42844](https://github.com/okou-ai/okou/issues/42844)) ([bb9eba3](https://github.com/okou-ai/okou/commit/bb9eba3491b8a8fdea9f72ca73d5e52c3587bdee))
* **api:** publish custom connector updates atomically ([#42846](https://github.com/okou-ai/okou/issues/42846)) ([3ad0987](https://github.com/okou-ai/okou/commit/3ad0987736b58469849da60b7ab1470f9a27a12a))
* **api:** run nightly learning and planning independently ([#42833](https://github.com/okou-ai/okou/issues/42833)) ([d5840a7](https://github.com/okou-ai/okou/commit/d5840a77258b4daf6192534bd760adf1e8b8dcbb))
* **api:** update thread connector selections atomically ([#42840](https://github.com/okou-ai/okou/issues/42840)) ([13001fa](https://github.com/okou-ai/okou/commit/13001fab8a587944f9f3958b3a992af2d41d2817))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 2.2.3

## [2.3.2](https://github.com/okou-ai/okou/compare/api-v2.3.1...api-v2.3.2) (2026-10-25)


### Refactoring

* **api:** commit usage compaction atomically ([#42792](https://github.com/okou-ai/okou/issues/42792)) ([6bcc9cb](https://github.com/okou-ai/okou/commit/6bcc9cbd97fbc54c5fb37be30f5d876293a82c74))
* **api:** finalize canceled usage-pack batches atomically ([#42781](https://github.com/okou-ai/okou/issues/42781)) ([dfbf2a1](https://github.com/okou-ai/okou/commit/dfbf2a10473de5e6ef66e445a1e074add6087088))
* **api:** localize claude account identity hydration ([#42825](https://github.com/okou-ai/okou/issues/42825)) ([5fd106b](https://github.com/okou-ai/okou/commit/5fd106b95af51a70a19cced6d1494e67bff50d1f))
* **api:** localize connector credential deletion queries ([#42782](https://github.com/okou-ai/okou/issues/42782)) ([f53f48c](https://github.com/okou-ai/okou/commit/f53f48c3912141c69dcf3a052fa53464cf68adec))
* **api:** localize manual grant credential writes ([#42808](https://github.com/okou-ai/okou/issues/42808)) ([f785da0](https://github.com/okou-ai/okou/commit/f785da07c267102ed8536605701bb0dc9e482b80))
* **api:** localize previous token revoke snapshot reads ([#42798](https://github.com/okou-ai/okou/issues/42798)) ([193a602](https://github.com/okou-ai/okou/commit/193a6028532ce7b9dee0849e6350a87540ecf7fb))
* **api:** materialize migration allocations atomically ([#42796](https://github.com/okou-ai/okou/issues/42796)) ([9f53d2f](https://github.com/okou-ai/okou/commit/9f53d2f7d248f55b9643da9024dfb238c3f29338))
* **api:** publish managed usage atomically ([#42800](https://github.com/okou-ai/okou/issues/42800)) ([00f7ed3](https://github.com/okou-ai/okou/commit/00f7ed32f4c755ced096e9c83f0ebb69ecc0a689))
* **api:** publish paid invitation allocations atomically ([#42811](https://github.com/okou-ai/okou/issues/42811)) ([de80c3b](https://github.com/okou-ai/okou/commit/de80c3b3998ae5fc3a953f9088e827e515f6d89f))
* **api:** publish provider usage batches atomically ([#42803](https://github.com/okou-ai/okou/issues/42803)) ([fae8d73](https://github.com/okou-ai/okou/commit/fae8d73b0432e11c323477ade5e37da0c0299e39))
* **api:** publish runner usage batches atomically ([#42806](https://github.com/okou-ai/okou/issues/42806)) ([d8bd536](https://github.com/okou-ai/okou/commit/d8bd536ebb9a10a88327123ca00441cb6cbc5241))
* **api:** restore subscription state atomically ([#42819](https://github.com/okou-ai/okou/issues/42819)) ([fafbbca](https://github.com/okou-ai/okou/commit/fafbbcac180b68536ca2343fcb5b4ff4d55775f5))
* **api:** switch connector defaults atomically ([#42827](https://github.com/okou-ai/okou/issues/42827)) ([75866e1](https://github.com/okou-ai/okou/commit/75866e1b9e989558fda36b7942acf99001cb2c56))
* **api:** switch google forms default atomically ([#42823](https://github.com/okou-ai/okou/issues/42823)) ([178a477](https://github.com/okou-ai/okou/commit/178a477668232895afc55d2b1e1159271addc5c0))
* **cli:** accept only durable image generation receipts ([#42812](https://github.com/okou-ai/okou/issues/42812)) ([8069a85](https://github.com/okou-ai/okou/commit/8069a85e2f098112efee733f2b7bba0623270a10))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.2.2
    * @okouai/core bumped to 8.785.1
    * @okouai/db bumped to 2.2.2
    * @okouai/pi-agent-runtime bumped to 1.50.67

## [2.3.1](https://github.com/okou-ai/okou/compare/api-v2.3.0...api-v2.3.1) (2026-10-24)


### Bug Fixes

* **api:** define the proactive learning memory writing contract ([#42761](https://github.com/okou-ai/okou/issues/42761)) ([137d8e9](https://github.com/okou-ai/okou/commit/137d8e942617dde170230570fd24f2b0540a1e9a))
* **api:** leave two hours between nightly learning and planning ([#42749](https://github.com/okou-ai/okou/issues/42749)) ([161f48b](https://github.com/okou-ai/okou/commit/161f48bcb97206902cdcdf88af09010e2bc4d1ce))
* **pi:** restore personal memory recall for ordinary conversations ([#42763](https://github.com/okou-ai/okou/issues/42763)) ([ea40a8f](https://github.com/okou-ai/okou/commit/ea40a8f507b736cf2f2f04ea4d7614a1cacc2088))


### Refactoring

* **api:** admit discord messages atomically ([#42760](https://github.com/okou-ai/okou/issues/42760)) ([4f23c4d](https://github.com/okou-ai/okou/commit/4f23c4d9c2d994dc8b2ebb0a766138dcbe83d27f))
* **api:** admit mail notifications atomically ([#42742](https://github.com/okou-ai/okou/issues/42742)) ([d7339af](https://github.com/okou-ai/okou/commit/d7339afd962a69405a2ad055799d9a43336a2ff0))
* **api:** localize connector account resolution queries ([#42762](https://github.com/okou-ai/okou/issues/42762)) ([8c31ddd](https://github.com/okou-ai/okou/commit/8c31ddd0d2439a74ab044cce18cbab4a5c81da4c))
* **api:** publish Atom member credit grants atomically ([#42751](https://github.com/okou-ai/okou/issues/42751)) ([9ff8e20](https://github.com/okou-ai/okou/commit/9ff8e20f8f18583272fcea6ea2bbb4d01639f4c8))
* **api:** publish queued rejections atomically ([#42770](https://github.com/okou-ai/okou/issues/42770)) ([dacfc3b](https://github.com/okou-ai/okou/commit/dacfc3b88f5973e7c48cdef8a53e0f6eb08ad23e))
* **app:** keep async state in owned requests and server reads ([#42745](https://github.com/okou-ai/okou/issues/42745)) ([d24618e](https://github.com/okou-ai/okou/commit/d24618e29baf061b061b64454aa538e8ea8a74a3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.2.1
    * @okouai/core bumped to 8.785.0
    * @okouai/db bumped to 2.2.1
    * @okouai/pi-agent-runtime bumped to 1.50.66

## [2.3.0](https://github.com/okou-ai/okou/compare/api-v2.2.0...api-v2.3.0) (2026-10-24)


### Features

* add proactive agent learning and planning workflows ([#42724](https://github.com/okou-ai/okou/issues/42724)) ([3a23824](https://github.com/okou-ai/okou/commit/3a23824fb8b9ac3ffd76b65cd463bb687f15269e))


### Bug Fixes

* **api:** settle terminal amazon task responses ([#42687](https://github.com/okou-ai/okou/issues/42687)) ([6f2c982](https://github.com/okou-ai/okou/commit/6f2c98256851c0006c40c77a4d52a9bcdd7c59ee))


### Refactoring

* **api:** atomically publish automatic mcp accounts ([#42721](https://github.com/okou-ai/okou/issues/42721)) ([0a0111d](https://github.com/okou-ai/okou/commit/0a0111d54751b68120d9aaa9ba8520e87ae20274))
* **api:** localize custom firewall credential preparation ([#42676](https://github.com/okou-ai/okou/issues/42676)) ([9e11c4a](https://github.com/okou-ai/okou/commit/9e11c4a38fac9eb529f94a3d0188ce179d0da9e3))
* **api:** own current custom oauth firewall material ([#42722](https://github.com/okou-ai/okou/issues/42722)) ([c6b7721](https://github.com/okou-ai/okou/commit/c6b7721bd060558425c97ab99c840c3a8afeef99))
* **api:** publish custom oauth authorization attempts atomically ([#42729](https://github.com/okou-ai/okou/issues/42729)) ([275c962](https://github.com/okou-ai/okou/commit/275c9629aac5a1d26ce4a0a3ec62342a8da1f304))
* **api:** publish custom oauth refresh in one statement ([#42716](https://github.com/okou-ai/okou/issues/42716)) ([8f9b0ca](https://github.com/okou-ai/okou/commit/8f9b0ca3dc20624ab6fd58a91617c01a540329b4))
* **api:** publish discord ingress failures atomically ([#42735](https://github.com/okou-ai/okou/issues/42735)) ([c876aae](https://github.com/okou-ai/okou/commit/c876aae03923076e5bdedf00a403edce860a0fb5))
* **api:** publish official automation structure changes atomically ([#42709](https://github.com/okou-ai/okou/issues/42709)) ([19f996d](https://github.com/okou-ai/okou/commit/19f996d92b7e5acf31fff2b1be67239dabed452e))
* **api:** publish official reconfiguration patches atomically ([#42699](https://github.com/okou-ai/okou/issues/42699)) ([e070b60](https://github.com/okou-ai/okou/commit/e070b6056f0f261f936d437a44009d6721b19b0b))
* **api:** reserve dormant official automation identities atomically ([#42704](https://github.com/okou-ai/okou/issues/42704)) ([bcd2f00](https://github.com/okou-ai/okou/commit/bcd2f00520abff47614858a28cbfee73206cb5b7))
* **api:** restore official reconfiguration in one statement ([#42689](https://github.com/okou-ai/okou/issues/42689)) ([0ee4105](https://github.com/okou-ai/okou/commit/0ee41055f08e004a673028123ccd3edf46baaa2a))
* **api:** stage official transitions in one statement ([#42684](https://github.com/okou-ai/okou/issues/42684)) ([04ad289](https://github.com/okou-ai/okou/commit/04ad289d0361bb8fb397b01837c8a3653d4a3018))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.2.0
    * @okouai/core bumped to 8.784.0
    * @okouai/db bumped to 2.2.0
    * @okouai/pi-agent-runtime bumped to 1.50.65

## [2.2.0](https://github.com/okou-ai/okou/compare/api-v2.1.3...api-v2.2.0) (2026-10-23)


### Features

* **api:** export preview worker telemetry through native otel ([#42579](https://github.com/okou-ai/okou/issues/42579)) ([0dad423](https://github.com/okou-ai/okou/commit/0dad4239bc7035a3c4ed26afbccf91f31559386b))


### Refactoring

* **api:** activate official installations atomically ([#42642](https://github.com/okou-ai/okou/issues/42642)) ([c897378](https://github.com/okou-ai/okou/commit/c8973784eeaef356e8f74465938dcd9d00dcbeb5))
* **api:** admit export jobs atomically ([#42661](https://github.com/okou-ai/okou/issues/42661)) ([e1ef436](https://github.com/okou-ai/okou/commit/e1ef4368da4da7ad12b4fa091b439ed5664f3a08))
* **api:** commit export collection in one atomic statement ([#42653](https://github.com/okou-ai/okou/issues/42653)) ([e5bf313](https://github.com/okou-ai/okou/commit/e5bf31381575b78473beba53efc53ef1d2352429))
* **api:** create browser action requests atomically ([#42678](https://github.com/okou-ai/okou/issues/42678)) ([70fad9a](https://github.com/okou-ai/okou/commit/70fad9a627dd3029ac36e6119f5854a0f7dcb9f3))
* **api:** enable workflow automations in one statement ([#42657](https://github.com/okou-ai/okou/issues/42657)) ([98ec370](https://github.com/okou-ai/okou/commit/98ec370dbf39247fc9e09858fecaeb0bc4c3d443))
* **api:** enqueue integration inputs atomically ([#42664](https://github.com/okou-ai/okou/issues/42664)) ([f6df09b](https://github.com/okou-ai/okou/commit/f6df09bf383bc2bd95a6e7e40849dfa8f1a25975))
* **api:** finalize dormant official automations atomically ([#42649](https://github.com/okou-ai/okou/issues/42649)) ([5c0c306](https://github.com/okou-ai/okou/commit/5c0c306431cd1b74018b1bce69eee927867f77ea))
* **api:** localize automatic oauth refresh client reads ([#42639](https://github.com/okou-ai/okou/issues/42639)) ([280e85d](https://github.com/okou-ai/okou/commit/280e85de0e652c51544cac19a17a224013cf71a8))
* **api:** localize catalog runtime wakeup ownership ([#42651](https://github.com/okou-ai/okou/issues/42651)) ([1b7765c](https://github.com/okou-ai/okou/commit/1b7765c037bf550ee82d0f930d48ccf15b694a65))
* **api:** localize custom connector grant persistence ([#42665](https://github.com/okou-ai/okou/issues/42665)) ([92c45b4](https://github.com/okou-ai/okou/commit/92c45b4e9015180f5915ab0750bbd494b1930798))
* **api:** publish official forms reconfiguration atomically ([#42638](https://github.com/okou-ai/okou/issues/42638)) ([20c37fa](https://github.com/okou-ai/okou/commit/20c37fa2afc0b278a720db6e05d91b98b98c5ff1))
* **api:** publish storage commits in one statement ([#42674](https://github.com/okou-ai/okou/issues/42674)) ([2393470](https://github.com/okou-ai/okou/commit/23934706c1d2891b93f4e862c0a5eabbc5e35905))
* **api:** publish workflows in one atomic statement ([#42667](https://github.com/okou-ai/okou/issues/42667)) ([fabc408](https://github.com/okou-ai/okou/commit/fabc4086fba1e2d2e9e86f70c7619a3979047aa5))
* **api:** sync file artifact projections atomically ([#42655](https://github.com/okou-ai/okou/issues/42655)) ([e0b8035](https://github.com/okou-ai/okou/commit/e0b8035d2ce5a5d05a69adfc9e2ddcbf63f1c0ab))
* **api:** sync hosted artifact catalog in one statement ([#42670](https://github.com/okou-ai/okou/issues/42670)) ([df16274](https://github.com/okou-ai/okou/commit/df16274de31a1b9d794b532281ad4e0fa972fdf0))
* remove expired deployment compatibility ([#42668](https://github.com/okou-ai/okou/issues/42668)) ([84f655c](https://github.com/okou-ai/okou/commit/84f655c516454ae8e596de430cdcdd569db67b7f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.1.2
    * @okouai/core bumped to 8.783.3
    * @okouai/db bumped to 2.1.3
    * @okouai/pi-agent-runtime bumped to 1.50.64

## [2.1.3](https://github.com/okou-ai/okou/compare/api-v2.1.2...api-v2.1.3) (2026-10-23)


### Bug Fixes

* hide disabled managed tools in prompts and cli ([#42440](https://github.com/okou-ai/okou/issues/42440)) ([33b35f9](https://github.com/okou-ai/okou/commit/33b35f94cb80e9ad361d36b732250587f04bc79b))


### Refactoring

* **api:** attach official automation metadata atomically ([#42616](https://github.com/okou-ai/okou/issues/42616)) ([c2b46c2](https://github.com/okou-ai/okou/commit/c2b46c2af4755fe51070eefecd9528032b6bd106))
* **api:** delete custom connector selections atomically ([#42625](https://github.com/okou-ai/okou/issues/42625)) ([3daaff7](https://github.com/okou-ai/okou/commit/3daaff7418e5e9328285b9d6c27397aa4b0faaae))
* **api:** own custom automatic oauth authorization client reads ([#42614](https://github.com/okou-ai/okou/issues/42614)) ([1352f11](https://github.com/okou-ai/okou/commit/1352f116f2df2941f26efee14f5f089b8e0239cd))
* **api:** publish custom connector creation atomically ([#42632](https://github.com/okou-ai/okou/issues/42632)) ([24aceeb](https://github.com/okou-ai/okou/commit/24aceeb494c81526e365b849b7bc1cd47493f28c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.783.2
    * @okouai/db bumped to 2.1.2
    * @okouai/pi-agent-runtime bumped to 1.50.63

## [2.1.2](https://github.com/okou-ai/okou/compare/api-v2.1.1...api-v2.1.2) (2026-10-23)


### Bug Fixes

* **api:** require authenticated integration oauth completion ([#42592](https://github.com/okou-ai/okou/issues/42592)) ([91c48b0](https://github.com/okou-ai/okou/commit/91c48b09a6488aa3d218b36a9962030da27ef841))


### Refactoring

* **api:** atomically persist failed materialization ([#42611](https://github.com/okou-ai/okou/issues/42611)) ([837ab3e](https://github.com/okou-ai/okou/commit/837ab3efa59ec2a7907be085f3bb1156eeaa7604))

## [2.1.1](https://github.com/okou-ai/okou/compare/api-v2.1.0...api-v2.1.1) (2026-10-23)


### Bug Fixes

* **api:** support kms, stripe and axiom in workers ([#42605](https://github.com/okou-ai/okou/issues/42605)) ([56450ed](https://github.com/okou-ai/okou/commit/56450edb7afbc5368e386113d9855ff03d827b0e))


### Refactoring

* **slack:** retire identity-only oauth install and connect ([#42583](https://github.com/okou-ai/okou/issues/42583)) ([ab402e0](https://github.com/okou-ai/okou/commit/ab402e0c626ce072f66715a8ecdb5cca0b848c4c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.1.1
    * @okouai/core bumped to 8.783.1
    * @okouai/db bumped to 2.1.1
    * @okouai/pi-agent-runtime bumped to 1.50.62

## [2.1.0](https://github.com/okou-ai/okou/compare/api-v2.0.0...api-v2.1.0) (2026-10-23)


### Features

* **browser:** add feature-gated cdp viewer ([#42535](https://github.com/okou-ai/okou/issues/42535)) ([a489e1d](https://github.com/okou-ai/okou/commit/a489e1d3e2c492ed3a2c83f4eccf60ccf0349df0))
* **slack:** decouple connections and scope external channel access ([#42486](https://github.com/okou-ai/okou/issues/42486)) ([b82249e](https://github.com/okou-ai/okou/commit/b82249e6de08bb61974dc5503f2ee5adc85cd1ee))


### Refactoring

* **api:** delete failed dormant materializations atomically ([#42601](https://github.com/okou-ai/okou/issues/42601)) ([c010789](https://github.com/okou-ai/okou/commit/c01078912838d4eff4b8788817aa0143bc8c87d5))
* **api:** own custom connector agent grant orchestration ([#42595](https://github.com/okou-ai/okou/issues/42595)) ([e26910d](https://github.com/okou-ai/okou/commit/e26910d8b31449114cda81f323a9efa07cfeca54))
* **api:** publish benchmark runs and identities atomically ([#42460](https://github.com/okou-ai/okou/issues/42460)) ([c6017b4](https://github.com/okou-ai/okou/commit/c6017b48554833c4c62779ed641bde30a16eba86))
* **api:** retire official workflow cutover compatibility ([#42564](https://github.com/okou-ai/okou/issues/42564)) ([beb38c7](https://github.com/okou-ai/okou/commit/beb38c7a00af109c0da26128b7c6cac974b1b291))
* remove legacy job command alias ([#42569](https://github.com/okou-ai/okou/issues/42569)) ([ae62417](https://github.com/okou-ai/okou/commit/ae6241774c2095d22ada2dc048c4a8f6649516a1))
* retire durable openai image generation switch ([#42594](https://github.com/okou-ai/okou/issues/42594)) ([a5e1f4c](https://github.com/okou-ai/okou/commit/a5e1f4c35c9f3d7ef1824fe9fa47bd4ffbb472d7))
* retire stripe invoice-paid automation runtime ([#42572](https://github.com/okou-ai/okou/issues/42572)) ([190cdfb](https://github.com/okou-ai/okou/commit/190cdfba6440b50469117758156616447d707b81))
* **workflows:** prepare attachments outside storage ([#42563](https://github.com/okou-ai/okou/issues/42563)) ([c2d0e48](https://github.com/okou-ai/okou/commit/c2d0e488e938512e55dce8ab199046a7f16d7b1c))


### Performance Improvements

* download authorized files directly from providers ([#42546](https://github.com/okou-ai/okou/issues/42546)) ([1b0a44c](https://github.com/okou-ai/okou/commit/1b0a44c01821d2825c8022560b08b70c0f41130b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.1.0
    * @okouai/core bumped to 8.783.0
    * @okouai/db bumped to 2.1.0
    * @okouai/pi-agent-runtime bumped to 1.50.61

## [2.0.0](https://github.com/okou-ai/okou/compare/api-v1.767.0...api-v2.0.0) (2026-10-23)


### ⚠ BREAKING CHANGES

* **social:** Social downloads now return temporary direct links only. Remove artifact delivery, multipart media transfer, legacy response fields and the dedicated artifact column.

### Bug Fixes

* clarify background job execution ownership ([#42543](https://github.com/okou-ai/okou/issues/42543)) ([d9d77ca](https://github.com/okou-ai/okou/commit/d9d77cadca40ee84c77169d5b15c16b423f2eb73))


### Refactoring

* **api:** own custom oauth callback persistence ([#42538](https://github.com/okou-ai/okou/issues/42538)) ([8302663](https://github.com/okou-ai/okou/commit/83026630cb268488d361aa69f6a504d0f76bf76c))
* **api:** remove oauth refresh coordination ([#42540](https://github.com/okou-ai/okou/issues/42540)) ([06c955d](https://github.com/okou-ai/okou/commit/06c955d9b476af0cb2bca42258900df2d452a2d2))
* **connector:** retire legacy diagnostic responses ([#42533](https://github.com/okou-ai/okou/issues/42533)) ([1f7d802](https://github.com/okou-ai/okou/commit/1f7d802bfc784353bb9c22e18330175b007ac919))
* **social:** replace media artifact pipeline with direct download links ([#42520](https://github.com/okou-ai/okou/issues/42520)) ([0c84485](https://github.com/okou-ai/okou/commit/0c844853810a37c21caeb77730a98c23e82a60e7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.0.0
    * @okouai/core bumped to 8.782.1
    * @okouai/db bumped to 2.0.0
    * @okouai/pi-agent-runtime bumped to 1.50.60

## [1.767.0](https://github.com/okou-ai/okou/compare/api-v1.766.6...api-v1.767.0) (2026-10-23)


### Features

* add configurable branding banners to hosted sites ([#42516](https://github.com/okou-ai/okou/issues/42516)) ([d3a40c7](https://github.com/okou-ai/okou/commit/d3a40c7c422bd9c9ee678e59bb447f81bc927a69))


### Refactoring

* **api:** remove openai image webhook recovery ([#42514](https://github.com/okou-ai/okou/issues/42514)) ([f8e2c47](https://github.com/okou-ai/okou/commit/f8e2c477521f7ef1e0bd59f0580869f58cf654fa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.590.0
    * @okouai/core bumped to 8.782.0
    * @okouai/db bumped to 1.359.0
    * @okouai/pi-agent-runtime bumped to 1.50.59

## [1.766.6](https://github.com/okou-ai/okou/compare/api-v1.766.5...api-v1.766.6) (2026-10-23)


### Bug Fixes

* **billing:** remove built-in generation price markups ([#42517](https://github.com/okou-ai/okou/issues/42517)) ([b0d7399](https://github.com/okou-ai/okou/commit/b0d7399a62e951dfae0e055e465ee5b69742dcc1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.358.5

## [1.766.5](https://github.com/okou-ai/okou/compare/api-v1.766.4...api-v1.766.5) (2026-10-23)


### Refactoring

* **api:** return canonical connector diagnostic identities ([#42505](https://github.com/okou-ai/okou/issues/42505)) ([15814c4](https://github.com/okou-ai/okou/commit/15814c4181a88bb513d6fa12b80bfb530ce57ab0))
* **db:** retire pi memory tables after api cutover ([#42495](https://github.com/okou-ai/okou/issues/42495)) ([f7e221b](https://github.com/okou-ai/okou/commit/f7e221beddbd012c07790d6da3e2816825ccc205))
* retire proactive action ([#42515](https://github.com/okou-ai/okou/issues/42515)) ([8246bdc](https://github.com/okou-ai/okou/commit/8246bdc3e5e19309dac24dc68d846648afaa79e5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.589.3
    * @okouai/core bumped to 8.781.1
    * @okouai/db bumped to 1.358.4
    * @okouai/pi-agent-runtime bumped to 1.50.58

## [1.766.4](https://github.com/okou-ai/okou/compare/api-v1.766.3...api-v1.766.4) (2026-10-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.781.0
    * @okouai/db bumped to 1.358.3
    * @okouai/pi-agent-runtime bumped to 1.50.57

## [1.766.3](https://github.com/okou-ai/okou/compare/api-v1.766.2...api-v1.766.3) (2026-10-23)


### Bug Fixes

* authorize native integration cli destinations and files ([#42484](https://github.com/okou-ai/okou/issues/42484)) ([c529d76](https://github.com/okou-ai/okou/commit/c529d761b8218fb72762ad42fe1a2e6af5c217d0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.589.2
    * @okouai/core bumped to 8.780.2
    * @okouai/db bumped to 1.358.2
    * @okouai/pi-agent-runtime bumped to 1.50.56

## [1.766.2](https://github.com/okou-ai/okou/compare/api-v1.766.1...api-v1.766.2) (2026-10-23)


### Refactoring

* **api:** own custom connector oauth start persistence ([#42444](https://github.com/okou-ai/okou/issues/42444)) ([3d5fd65](https://github.com/okou-ai/okou/commit/3d5fd65bef7a119cb13491388cd611c74984d362))
* **api:** tighten financial transaction boundaries ([#42480](https://github.com/okou-ai/okou/issues/42480)) ([2add5b1](https://github.com/okou-ai/okou/commit/2add5b11778ca2a6f42b84dd9035e7de66fa8ae0))
* **connectors:** retire unused builtin read projections ([#42437](https://github.com/okou-ai/okou/issues/42437)) ([dfb4154](https://github.com/okou-ai/okou/commit/dfb4154505e4c5c10b9ff329f180a7b68753fc88))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.589.1
    * @okouai/core bumped to 8.780.1
    * @okouai/db bumped to 1.358.1
    * @okouai/pi-agent-runtime bumped to 1.50.55

## [1.766.1](https://github.com/okou-ai/okou/compare/api-v1.766.0...api-v1.766.1) (2026-10-23)


### Refactoring

* **api:** own shared personal subscription refresh queries ([#42473](https://github.com/okou-ai/okou/issues/42473)) ([cd6865a](https://github.com/okou-ai/okou/commit/cd6865acb9417775e56f9881d841d9240859c73c))


### Performance Improvements

* reduce sidebar menu and jobs fixture work ([#42462](https://github.com/okou-ai/okou/issues/42462)) ([284b4fd](https://github.com/okou-ai/okou/commit/284b4fd8d25ffde4908a7f94f0689daf3d6261dd))

## [1.766.0](https://github.com/okou-ai/okou/compare/api-v1.765.2...api-v1.766.0) (2026-10-23)


### Features

* add durable image generation jobs and cli status queries ([#42352](https://github.com/okou-ai/okou/issues/42352)) ([328c79f](https://github.com/okou-ai/okou/commit/328c79f29a81e44e454ff155cd2416e78ea7860d))
* add durable jobs and a proactive jobs loop ([#42404](https://github.com/okou-ai/okou/issues/42404)) ([c02f4b1](https://github.com/okou-ai/okou/commit/c02f4b14d603747e65b0ffb046dd10f3d0ade017))
* **api:** report request lifecycle red metrics to axiom ([#42402](https://github.com/okou-ai/okou/issues/42402)) ([259bec1](https://github.com/okou-ai/okou/commit/259bec18f3bb08ace52b8d3fb07169e35bbe1842))
* enable native codex images when managed generation is disabled ([#42419](https://github.com/okou-ai/okou/issues/42419)) ([3747be0](https://github.com/okou-ai/okou/commit/3747be078230f27e490e7e693fc6a02e75182787))


### Refactoring

* **api:** combine run admission counters ([#42394](https://github.com/okou-ai/okou/issues/42394)) ([0be2a4a](https://github.com/okou-ai/okou/commit/0be2a4ac149da11a82f28729ad6513cecf36e00a))
* **api:** own builtin deletion account resolution ([#42422](https://github.com/okou-ai/okou/issues/42422)) ([75aa0ac](https://github.com/okou-ai/okou/commit/75aa0ac917c40cdb594c1809723286a97bc622ab))
* **api:** own manual grant user credential cleanup ([#42403](https://github.com/okou-ai/okou/issues/42403)) ([1583615](https://github.com/okou-ai/okou/commit/1583615f2b0b2e0dddc027e8ef90915260fb4513))
* **api:** publish billing downgrades in one atomic statement ([#42457](https://github.com/okou-ai/okou/issues/42457)) ([4de3edc](https://github.com/okou-ai/okou/commit/4de3edcca2dfced59a12febea9729f7a98e930fa))
* **api:** publish browser starts in one atomic statement ([#42454](https://github.com/okou-ai/okou/issues/42454)) ([b924ae0](https://github.com/okou-ai/okou/commit/b924ae034217aea7be406e6683830d83eca73955))
* **api:** remove atom expiry reconciliation transaction ([#42421](https://github.com/okou-ai/okou/issues/42421)) ([478bc70](https://github.com/okou-ai/okou/commit/478bc7039116cd9be3ffe422e5911572af4e297d))
* **api:** remove canceled billing reconciliation transaction ([#42411](https://github.com/okou-ai/okou/issues/42411)) ([d420cb7](https://github.com/okou-ai/okou/commit/d420cb7865229ad8aac69a94320c2f92e034145f))
* **api:** remove concurrency invoice publication transaction ([#42451](https://github.com/okou-ai/okou/issues/42451)) ([6e65458](https://github.com/okou-ai/okou/commit/6e65458055185275a2548683fde45240bf1442a2)) [#42450](https://github.com/okou-ai/okou/issues/42450)
* **api:** remove nested credential deletion savepoint ([#42401](https://github.com/okou-ai/okou/issues/42401)) ([7b5446b](https://github.com/okou-ai/okou/commit/7b5446bd0bd09b94e4b59c2e521e3f8e193e38c7))
* **api:** remove payment-failed paid-through transaction ([#42449](https://github.com/okou-ai/okou/issues/42449)) ([ed816ac](https://github.com/okou-ai/okou/commit/ed816acf4c1dd931195e2a11d43a8aa90a475948)) [#42448](https://github.com/okou-ai/okou/issues/42448)
* **api:** remove payment-failed plan projection transaction ([#42439](https://github.com/okou-ai/okou/issues/42439)) ([648114e](https://github.com/okou-ai/okou/commit/648114ed4a3e0ac3aa07b5da499e43f46a001c68))
* **api:** remove recovered billing projection transaction ([#42443](https://github.com/okou-ai/okou/issues/42443)) ([f16cf8c](https://github.com/okou-ai/okou/commit/f16cf8ccb13b9abb070046ac2af0585e90f0d77d))
* **api:** remove schedule release transaction ([#42427](https://github.com/okou-ai/okou/issues/42427)) ([f809bab](https://github.com/okou-ai/okou/commit/f809babaecd4e25bce027407714eccfbc10cfc4a))
* **api:** remove sharp from image delivery ([#42379](https://github.com/okou-ai/okou/issues/42379)) ([34515b9](https://github.com/okou-ai/okou/commit/34515b93ce5500ddb352b3a4f4b7f4ec4d92e537))
* **connector:** activate canonical account status ([#42333](https://github.com/okou-ai/okou/issues/42333)) ([dc3fba8](https://github.com/okou-ai/okou/commit/dc3fba8d008ee10e4d65b9485a9fca63431face3))
* remove retired pi memory storage and compatibility ([#42397](https://github.com/okou-ai/okou/issues/42397)) ([3f7e13b](https://github.com/okou-ai/okou/commit/3f7e13b76f0ea1d4ac1ff39a1f240a7af19dc1ad))


### Performance Improvements

* reduce resource tooltip and workflow fixture work ([#42429](https://github.com/okou-ai/okou/issues/42429)) ([d6eb8c0](https://github.com/okou-ai/okou/commit/d6eb8c0251e68a4755cbe29dd5f1d34d90468773))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.589.0
    * @okouai/core bumped to 8.780.0
    * @okouai/db bumped to 1.358.0
    * @okouai/pi-agent-runtime bumped to 1.50.54

## [1.765.2](https://github.com/okou-ai/okou/compare/api-v1.765.1...api-v1.765.2) (2026-10-22)


### Bug Fixes

* **host:** show access recovery pages and static website covers ([#42371](https://github.com/okou-ai/okou/issues/42371)) ([e56611e](https://github.com/okou-ai/okou/commit/e56611ee7374ad6f62cba34a0382bdaad8f950b5))


### Refactoring

* **api:** batch agentphone verification cooldown updates ([#42363](https://github.com/okou-ai/okou/issues/42363)) ([50e1bfe](https://github.com/okou-ai/okou/commit/50e1bfee4a4ec365cf0e5aedca35de04ec08563c))
* **api:** record thread predecessor when execution starts ([#42384](https://github.com/okou-ai/okou/issues/42384)) ([317594c](https://github.com/okou-ai/okou/commit/317594cad4127d69bc31910a7714ea284b4ce9fb))
* **api:** shorten usage pack preview transaction ([#42388](https://github.com/okou-ai/okou/issues/42388)) ([c28b2a4](https://github.com/okou-ai/okou/commit/c28b2a4e8ab073770f328433fd90b16e6076dd04))


### Performance Improvements

* **platform:** shorten voice transcription windows to fifteen seconds ([#42351](https://github.com/okou-ai/okou/issues/42351)) ([d3438d7](https://github.com/okou-ai/okou/commit/d3438d7dc0941efd09106a785b1355e48a7c6144))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.588.1
    * @okouai/core bumped to 8.779.1
    * @okouai/db bumped to 1.357.2
    * @okouai/pi-agent-runtime bumped to 1.50.53

## [1.765.1](https://github.com/okou-ai/okou/compare/api-v1.765.0...api-v1.765.1) (2026-10-22)


### Bug Fixes

* **api:** align presentation template markers with runbook names ([#42336](https://github.com/okou-ai/okou/issues/42336)) ([02c0283](https://github.com/okou-ai/okou/commit/02c0283feadfa035b2f5ead515751d3ac4e58da0))
* **api:** limit email outbox drains to ten items ([#42338](https://github.com/okou-ai/okou/issues/42338)) ([4e12091](https://github.com/okou-ai/okou/commit/4e12091cee5abf3966d24548dd0c7ebac8cc8922))


### Refactoring

* **api:** compact discord ingress persistence ([#42354](https://github.com/okou-ai/okou/issues/42354)) ([1295fa9](https://github.com/okou-ai/okou/commit/1295fa969d7d8a870cb4ee735034edabb2f47844))
* **api:** make catalog cold loads request-owned ([#42343](https://github.com/okou-ai/okou/issues/42343)) ([0fbd2fb](https://github.com/okou-ai/okou/commit/0fbd2fb8a3d0140aa1048e0ad6dffa8fb9bfd303))
* **api:** own builtin connector token revocation input reads ([#42341](https://github.com/okou-ai/okou/issues/42341)) ([6eff341](https://github.com/okou-ai/okou/commit/6eff3418b9eda9a52291467d0b88031701bf4b15))
* **api:** remove custom dns rebinding and address guards ([#42349](https://github.com/okou-ai/okou/issues/42349)) ([d0991ca](https://github.com/okou-ai/okou/commit/d0991cac0df78193fa4f2c40562fa4e69bd2c818))
* **api:** shorten feishu installation cleanup transaction ([#42340](https://github.com/okou-ai/okou/issues/42340)) ([48abe2f](https://github.com/okou-ai/okou/commit/48abe2f0a4845c1f5ed5538fa75335307ccfeef8))
* narrow the pi phase2 digest import boundary ([#42348](https://github.com/okou-ai/okou/issues/42348)) ([3c43403](https://github.com/okou-ai/okou/commit/3c4340373b0b5042be45b95d0b01996b1acbb9c5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.779.0
    * @okouai/db bumped to 1.357.1
    * @okouai/pi-agent-runtime bumped to 1.50.52

## [1.765.0](https://github.com/okou-ai/okou/compare/api-v1.764.2...api-v1.765.0) (2026-10-22)


### Features

* add hourly proactive action workflow ([#42325](https://github.com/okou-ai/okou/issues/42325)) ([584988e](https://github.com/okou-ai/okou/commit/584988edb99d1d6cff61b67ee7fb67cbff1282e9))


### Refactoring

* remove bulk invoice receipt zip downloads ([#42329](https://github.com/okou-ai/okou/issues/42329)) ([7ca4cc0](https://github.com/okou-ai/okou/commit/7ca4cc036f4d99b14d7a742293bb715f7e42a875))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.588.0
    * @okouai/core bumped to 8.778.0
    * @okouai/db bumped to 1.357.0
    * @okouai/pi-agent-runtime bumped to 1.50.51

## [1.764.2](https://github.com/okou-ai/okou/compare/api-v1.764.1...api-v1.764.2) (2026-10-22)


### Refactoring

* retire pi memory producers before storage contraction ([#42316](https://github.com/okou-ai/okou/issues/42316)) ([d7b32fb](https://github.com/okou-ai/okou/commit/d7b32fb46d53ee8648e1a825d1533d887b16dbec))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.587.2
    * @okouai/core bumped to 8.777.7
    * @okouai/db bumped to 1.356.2
    * @okouai/pi-agent-runtime bumped to 1.50.50

## [1.764.1](https://github.com/okou-ai/okou/compare/api-v1.764.0...api-v1.764.1) (2026-10-22)


### Bug Fixes

* **api:** adapt live china social results and privacy errors ([#42283](https://github.com/okou-ai/okou/issues/42283)) ([fde53e3](https://github.com/okou-ai/okou/commit/fde53e370e47b6154b007c7c2b56634f8bba509d))
* **api:** commit agentphone cooldowns before sending verification texts ([#42309](https://github.com/okou-ai/okou/issues/42309)) ([ca9ce66](https://github.com/okou-ai/okou/commit/ca9ce663c0af041ae08b0210ea734e9e287c4508))
* **host:** enforce site policies and resolve restricted previews ([#42243](https://github.com/okou-ai/okou/issues/42243)) ([31a1a37](https://github.com/okou-ai/okou/commit/31a1a376b2c6597dd12b16d668bc940e69e09829))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.587.1
    * @okouai/core bumped to 8.777.6
    * @okouai/db bumped to 1.356.1
    * @okouai/pi-agent-runtime bumped to 1.50.49

## [1.764.0](https://github.com/okou-ai/okou/compare/api-v1.763.4...api-v1.764.0) (2026-10-22)


### Features

* **host:** gate cli visibility and default new sites to private ([#42294](https://github.com/okou-ai/okou/issues/42294)) ([0298226](https://github.com/okou-ai/okou/commit/0298226ebb177137ffada92fa03d4c0b40d24142))


### Refactoring

* **api:** localize stripe account projection queries ([#42292](https://github.com/okou-ai/okou/issues/42292)) ([782cfe6](https://github.com/okou-ai/okou/commit/782cfe6d79b54a70341794287690689864089caa))
* **api:** own custom oauth stored connection reads ([#42284](https://github.com/okou-ai/okou/issues/42284)) ([e6aa153](https://github.com/okou-ai/okou/commit/e6aa153e6566d56aceb74e976bd0d2f6fe0e3077))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.587.0
    * @okouai/core bumped to 8.777.5
    * @okouai/db bumped to 1.356.0
    * @okouai/pi-agent-runtime bumped to 1.50.48

## [1.763.4](https://github.com/okou-ai/okou/compare/api-v1.763.3...api-v1.763.4) (2026-10-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.586.3
    * @okouai/core bumped to 8.777.4
    * @okouai/db bumped to 1.355.5
    * @okouai/pi-agent-runtime bumped to 1.50.47

## [1.763.3](https://github.com/okou-ai/okou/compare/api-v1.763.2...api-v1.763.3) (2026-10-22)


### Refactoring

* retire storage cleanup worker and instruction marker ([#42250](https://github.com/okou-ai/okou/issues/42250)) ([43e8295](https://github.com/okou-ai/okou/commit/43e8295d49fc025a0172d9336185ad7839ba9eea))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.586.2
    * @okouai/core bumped to 8.777.3
    * @okouai/db bumped to 1.355.4
    * @okouai/pi-agent-runtime bumped to 1.50.46

## [1.763.2](https://github.com/okou-ai/okou/compare/api-v1.763.1...api-v1.763.2) (2026-10-22)


### Bug Fixes

* **api:** parse actual douyin and weibo search results ([#42231](https://github.com/okou-ai/okou/issues/42231)) ([b7822bf](https://github.com/okou-ai/okou/commit/b7822bfcc5bd0dfad3536efcefd240f10fcb7d83))
* **api:** return validation errors for rejected invitation emails ([#42227](https://github.com/okou-ai/okou/issues/42227)) ([58742c6](https://github.com/okou-ai/okou/commit/58742c6e410ece4e76dc6261826ddbb2a886c6d1))


### Refactoring

* remove social data expansion and commerce feature switches ([#42229](https://github.com/okou-ai/okou/issues/42229)) ([84b93c3](https://github.com/okou-ai/okou/commit/84b93c3e918dcaa700dc21d8b97f15317a499c0b))


### Performance Improvements

* **api:** consolidate dispatch preparation reads ([#42217](https://github.com/okou-ai/okou/issues/42217)) ([96be893](https://github.com/okou-ai/okou/commit/96be893b4ac31ef8bc0bc54baf19cb14efd24cdd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.777.2
    * @okouai/db bumped to 1.355.3
    * @okouai/pi-agent-runtime bumped to 1.50.45

## [1.763.1](https://github.com/okou-ai/okou/compare/api-v1.763.0...api-v1.763.1) (2026-10-22)


### Bug Fixes

* **api:** retain axiom sdk request diagnostics ([#42199](https://github.com/okou-ai/okou/issues/42199)) ([bc738bd](https://github.com/okou-ai/okou/commit/bc738bd58ec8f9ba45e999b1d0d87400bec10ac7))
* **api:** retain bounded axiom ingest error details ([#42202](https://github.com/okou-ai/okou/issues/42202)) ([79befdb](https://github.com/okou-ai/okou/commit/79befdb07d6296180ab63596d2bee78380b4af67))


### Refactoring

* **api:** localize subscription entitlement and grant ownership ([#42224](https://github.com/okou-ai/okou/issues/42224)) ([59b1bd3](https://github.com/okou-ai/okou/commit/59b1bd3291b54c948357074c42bae0b8bbfc891b))
* **api:** localize usage pack invoice fulfillment ownership ([#42197](https://github.com/okou-ai/okou/issues/42197)) ([a25ce7a](https://github.com/okou-ai/okou/commit/a25ce7a742f97f4b57cf8b6f7a3671a3ec09f5bd))
* **api:** localize usage pack removal and refund ownership ([#42213](https://github.com/okou-ai/okou/issues/42213)) ([a013054](https://github.com/okou-ai/okou/commit/a013054c72f8963b64a94479969eaeb03a6fc668))
* **api:** own custom oauth refresh reconnect writes ([#42223](https://github.com/okou-ai/okou/issues/42223)) ([3193169](https://github.com/okou-ai/okou/commit/319316902857ac9f03af5a10927e815a647de567))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.586.1
    * @okouai/core bumped to 8.777.1
    * @okouai/db bumped to 1.355.2
    * @okouai/pi-agent-runtime bumped to 1.50.44

## [1.763.0](https://github.com/okou-ai/okou/compare/api-v1.762.0...api-v1.763.0) (2026-10-22)


### Features

* **platform:** add a thread email manager behind a feature switch ([#42100](https://github.com/okou-ai/okou/issues/42100)) ([e566491](https://github.com/okou-ai/okou/commit/e566491c5b8dd39d16cd1b5a69f344b658b8082b))


### Refactoring

* **api:** localize usage pack migration database ownership ([#42176](https://github.com/okou-ai/okou/issues/42176)) ([cfe5dd1](https://github.com/okou-ai/okou/commit/cfe5dd1b25b0c0d52d8d73f56a4fc7bd88b40456))
* **api:** localize usage pack plan change database ownership ([#42195](https://github.com/okou-ai/okou/issues/42195)) ([13812a9](https://github.com/okou-ai/okou/commit/13812a9b804f6d72643bed0a8480802dce22f9ef))
* **platform:** read skill imports by session and invalidate over ably ([#42115](https://github.com/okou-ai/okou/issues/42115)) ([6d1488a](https://github.com/okou-ai/okou/commit/6d1488abf92ef2ae0def91226e3002f185f2eca4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.586.0
    * @okouai/core bumped to 8.777.0
    * @okouai/db bumped to 1.355.1
    * @okouai/pi-agent-runtime bumped to 1.50.43

## [1.762.0](https://github.com/okou-ai/okou/compare/api-v1.761.1...api-v1.762.0) (2026-10-22)


### Features

* add monid social collections and direct amazon commerce ([#42137](https://github.com/okou-ai/okou/issues/42137)) ([4b8e2c9](https://github.com/okou-ai/okou/commit/4b8e2c91497de9b7bc78c6f07f46fda0b02520d8))


### Bug Fixes

* **api:** avoid deadlocks in concurrent discord oauth binding ([#42102](https://github.com/okou-ai/okou/issues/42102)) ([20cafb0](https://github.com/okou-ai/okou/commit/20cafb07dbee6afabac614dd001592c37df6f9c4))
* **api:** bind integration oauth to authenticated actors ([#42113](https://github.com/okou-ai/okou/issues/42113)) ([c9c600b](https://github.com/okou-ai/okou/commit/c9c600bedfbe3463fa8e38e730dbba31df440a92))
* **api:** refresh api release marker comment ([#42169](https://github.com/okou-ai/okou/issues/42169)) ([8adffd3](https://github.com/okou-ai/okou/commit/8adffd36756232845564700c08bbfd6bf93ff8a6))
* **api:** retain safe openai image error diagnostics ([#42080](https://github.com/okou-ai/okou/issues/42080)) ([190795e](https://github.com/okou-ai/okou/commit/190795e83e6d064f73387bbf27dce35ac9966b94))
* **api:** use node-server v2 for prebuilt vercel functions ([#42105](https://github.com/okou-ai/okou/issues/42105)) ([2034829](https://github.com/okou-ai/okou/commit/2034829a41997bc737338977498bb61cc48a3479))
* **host:** isolate hosted browser sessions from clerk tokens ([#41850](https://github.com/okou-ai/okou/issues/41850)) ([3eb136c](https://github.com/okou-ai/okou/commit/3eb136cffafd07707533a96f047c5fd0ee97c522))


### Refactoring

* **api:** inline builtin connector secret reads ([#42128](https://github.com/okou-ai/okou/issues/42128)) ([9a61de2](https://github.com/okou-ai/okou/commit/9a61de21ae3ef791e02cbc9aa933ae21a60196fd))
* **api:** inline connector token secret writes ([#42160](https://github.com/okou-ai/okou/issues/42160)) ([21f235c](https://github.com/okou-ai/okou/commit/21f235c315f325d0e064f539c4fd02d90abab649)) [#42158](https://github.com/okou-ai/okou/issues/42158)
* **api:** inline connector token variable writes ([#42161](https://github.com/okou-ai/okou/issues/42161)) ([2e077c9](https://github.com/okou-ai/okou/commit/2e077c969cd47124e245039afe2e9877f7c0f276)) [#42159](https://github.com/okou-ai/okou/issues/42159)
* **api:** inline custom connector member lookup ([#42129](https://github.com/okou-ai/okou/issues/42129)) ([812bc5f](https://github.com/okou-ai/okou/commit/812bc5f47647209b36bd683d8670b80bc46cd032))
* **api:** inline matched builtin connector variable reads ([#42150](https://github.com/okou-ai/okou/issues/42150)) ([f389263](https://github.com/okou-ai/okou/commit/f389263cfdbbda3364f68124220cadd1cd8cac98))
* **api:** inline preview cache upsert in persist owner ([#42139](https://github.com/okou-ai/okou/issues/42139)) ([d89215e](https://github.com/okou-ai/okou/commit/d89215e89e25422e892f9e72a639586e1209f7a1))
* **api:** keep feishu database operations with their owners ([#42085](https://github.com/okou-ai/okou/issues/42085)) ([2dac33b](https://github.com/okou-ai/okou/commit/2dac33b32a73515a757d9328d1777a1f18be5f58))
* **api:** keep provider secret writes in the refresh owner ([#42101](https://github.com/okou-ai/okou/issues/42101)) ([d7150bd](https://github.com/okou-ai/okou/commit/d7150bd448d358d499c27f2dc5c2495d3017f2df))
* **api:** keep stored connector runtime queries with their owner ([#42133](https://github.com/okou-ai/okou/issues/42133)) ([9642bf5](https://github.com/okou-ai/okou/commit/9642bf5cedb85da841aa59ba7ddbf5be23759119)) [#42131](https://github.com/okou-ai/okou/issues/42131)
* **api:** localize agentphone database reads ([#42110](https://github.com/okou-ai/okou/issues/42110)) ([bfe6be7](https://github.com/okou-ai/okou/commit/bfe6be712568e92b5d2f198ab7eb27aa901a7d48))
* **api:** localize builtin account identity reconciliation ([#42157](https://github.com/okou-ai/okou/issues/42157)) ([834b002](https://github.com/okou-ai/okou/commit/834b0025e4d413fcedbb7ccb45fe3575cb3210f9))
* **api:** localize committed connector runtime wakeup discovery ([#42146](https://github.com/okou-ai/okou/issues/42146)) ([4e61cce](https://github.com/okou-ai/okou/commit/4e61cce66e36e387313dee7c7e9360280fe85be9))
* **api:** remove local membership coordination and summary deadline ([#42077](https://github.com/okou-ai/okou/issues/42077)) ([ceaa79a](https://github.com/okou-ai/okou/commit/ceaa79a6b91686917ce198893ebfb0d810ad2f7b))
* **api:** retire row-returning connector mutation adapters ([#42166](https://github.com/okou-ai/okou/issues/42166)) ([a89e660](https://github.com/okou-ai/okou/commit/a89e660199e31defe358312551d9cbf247cd4bdb))
* **api:** separate catalog display projections from database loading ([#42120](https://github.com/okou-ai/okou/issues/42120)) ([7442b51](https://github.com/okou-ai/okou/commit/7442b517dfb205bb1a25400d8f0a696f6a2682e0))
* **app:** derive async card state from operations and notifications ([#42092](https://github.com/okou-ai/okou/issues/42092)) ([f894504](https://github.com/okou-ai/okou/commit/f89450480538b26738dec1a05ae2833b2fdf3864))
* remove expired runner claim compatibility gates ([#42164](https://github.com/okou-ai/okou/issues/42164)) ([f71adde](https://github.com/okou-ai/okou/commit/f71addebfc1456142f31af439e6750f67e42e938))
* require builtin account projection results ([#42117](https://github.com/okou-ai/okou/issues/42117)) ([4acafcd](https://github.com/okou-ai/okou/commit/4acafcd5331379b2df8a63ebf80ec3dc5845a7da))


### Performance Improvements

* **api:** initialize isolated test databases on demand ([#42071](https://github.com/okou-ai/okou/issues/42071)) ([2559cc6](https://github.com/okou-ai/okou/commit/2559cc620128754304c79c78c57366c092a83655))
* **api:** optimize hosted conflict checks and sidebar snapshot scans ([#42084](https://github.com/okou-ai/okou/issues/42084)) ([af45198](https://github.com/okou-ai/okou/commit/af451988d579742f0038e36c2c2abbf713cdb262))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.585.0
    * @okouai/core bumped to 8.776.0
    * @okouai/db bumped to 1.355.0
    * @okouai/pi-agent-runtime bumped to 1.50.42

## [1.761.1](https://github.com/okou-ai/okou/compare/api-v1.761.0...api-v1.761.1) (2026-10-21)


### Refactoring

* **api:** keep telegram database operations with their owners ([#42043](https://github.com/okou-ai/okou/issues/42043)) ([be95b0a](https://github.com/okou-ai/okou/commit/be95b0a7ab52a046667e658f9b668024436f33bf))
* **api:** own duplicate initial plan queries in invoice handler ([#41533](https://github.com/okou-ai/okou/issues/41533)) ([28f9969](https://github.com/okou-ai/okou/commit/28f9969eaf94013c835eb7d30f8b8c29c5cf1d12)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* finish connector status retirement cleanup ([#42039](https://github.com/okou-ai/okou/issues/42039)) ([71a4cb7](https://github.com/okou-ai/okou/commit/71a4cb7efd16afc2ef4417ad876e58d8984cc8cc))
* **runner:** retire scheduling history generation identity ([#41998](https://github.com/okou-ai/okou/issues/41998)) ([39dbd2a](https://github.com/okou-ai/okou/commit/39dbd2a10242e3e1d9241d8b81c034258f10f842))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.584.1
    * @okouai/core bumped to 8.775.1
    * @okouai/db bumped to 1.354.1
    * @okouai/pi-agent-runtime bumped to 1.50.41

## [1.761.0](https://github.com/okou-ai/okou/compare/api-v1.760.4...api-v1.761.0) (2026-10-21)


### Features

* support independent hosted site titles ([#41997](https://github.com/okou-ai/okou/issues/41997)) ([87ae8c9](https://github.com/okou-ai/okou/commit/87ae8c9f3481e1fc8b193dd6076e55b21022c0b0))


### Refactoring

* **api:** inline model provider refresh row reads ([#42026](https://github.com/okou-ai/okou/issues/42026)) ([3731d81](https://github.com/okou-ai/okou/commit/3731d8167d8f11fae3075e6f34b24fdf6dc4116e))
* **api:** inline model provider source state reads ([#42010](https://github.com/okou-ai/okou/issues/42010)) ([bd4f516](https://github.com/okou-ai/okou/commit/bd4f516edcb591deacbe96b412de72150047d9b5))
* **api:** inline subscription runtime secret synchronization ([#42006](https://github.com/okou-ai/okou/issues/42006)) ([ea268d7](https://github.com/okou-ai/okou/commit/ea268d71603602c42bafd0029214e14bf6a1aadb))
* **api:** keep discord database operations with their owners ([#42007](https://github.com/okou-ai/okou/issues/42007)) ([82e4d11](https://github.com/okou-ai/okou/commit/82e4d11b6e13c842c32e91ea09f628bc81f4c696))
* **api:** keep teams database operations with their owners ([#42037](https://github.com/okou-ai/okou/issues/42037)) ([8727d2a](https://github.com/okou-ai/okou/commit/8727d2afca808c1c5cdaf106e1f8d7ce0893f8c8))
* **api:** localize accepted catalog runtime reads ([#42040](https://github.com/okou-ai/okou/issues/42040)) ([f91a91a](https://github.com/okou-ai/okou/commit/f91a91ac3aca8311abf28dae9e90f33d5b4baa7d))
* **connector:** retire status contracts after app reader preparation ([#41862](https://github.com/okou-ai/okou/issues/41862)) ([4ddecef](https://github.com/okou-ai/okou/commit/4ddecefcad0e97d13b75106bcc0bca13a0a45fa6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.584.0
    * @okouai/core bumped to 8.775.0
    * @okouai/db bumped to 1.354.0
    * @okouai/pi-agent-runtime bumped to 1.50.40

## [1.760.4](https://github.com/okou-ai/okou/compare/api-v1.760.3...api-v1.760.4) (2026-10-21)


### Bug Fixes

* **api:** match reusable resources to the previous chat run ([#41959](https://github.com/okou-ai/okou/issues/41959)) ([dc8dcb1](https://github.com/okou-ai/okou/commit/dc8dcb1953234778490929baa283a864da837aec))
* **api:** read null storage mounts from retained run snapshots ([#41995](https://github.com/okou-ai/okou/issues/41995)) ([2139c0c](https://github.com/okou-ai/okou/commit/2139c0c089cc785b68f0f23832431a668fea9e2a))
* **api:** reject declared fields on custom oauth definitions ([#41990](https://github.com/okou-ai/okou/issues/41990)) ([9fa152a](https://github.com/okou-ai/okou/commit/9fa152ad2f7263beb777c70828927b31e4c4c8e2))
* **wallet:** refresh authorization before loading wallet details ([#41971](https://github.com/okou-ai/okou/issues/41971)) ([27c40fb](https://github.com/okou-ai/okou/commit/27c40fb6e047a8f42d21ca9d8f8d43bc349fb1cc))


### Refactoring

* **api:** inline firewall auth catalog reader ([#41979](https://github.com/okou-ai/okou/issues/41979)) ([98f9a61](https://github.com/okou-ai/okou/commit/98f9a617f0f2e3b494739f2c13e054fd7089143f))
* **api:** inline subscription refresh state reads ([#41986](https://github.com/okou-ai/okou/issues/41986)) ([5c929d8](https://github.com/okou-ai/okou/commit/5c929d8ab4186f099c2925c9aacbff4e81b68d10))
* **api:** keep Slack webhook database handles local ([#41982](https://github.com/okou-ai/okou/issues/41982)) ([1874d7d](https://github.com/okou-ai/okou/commit/1874d7dcf422f99e5b0983a8bd40a4dc0ca19222))
* **api:** localize custom catalog permission wakeups ([#41926](https://github.com/okou-ai/okou/issues/41926)) ([63a9553](https://github.com/okou-ai/okou/commit/63a9553d4db11e75a02942892866722994503e8d))
* **api:** own slack callback and reward database operations ([#41989](https://github.com/okou-ai/okou/issues/41989)) ([1e9e067](https://github.com/okou-ai/okou/commit/1e9e06755a36ccecdf528ea344be1c352b33cb16))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.353.4

## [1.760.3](https://github.com/okou-ai/okou/compare/api-v1.760.2...api-v1.760.3) (2026-10-21)


### Refactoring

* **api:** inline terminal chat thread reader ([#41969](https://github.com/okou-ai/okou/issues/41969)) ([dab240f](https://github.com/okou-ai/okou/commit/dab240fa4afa9a3cf36ad6034a5bc204b6ae919b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.583.1
    * @okouai/core bumped to 8.774.9
    * @okouai/db bumped to 1.353.3
    * @okouai/pi-agent-runtime bumped to 1.50.39

## [1.760.2](https://github.com/okou-ai/okou/compare/api-v1.760.1...api-v1.760.2) (2026-10-21)


### Refactoring

* **api:** inline firewall run admission reads ([#41951](https://github.com/okou-ai/okou/issues/41951)) ([c626a26](https://github.com/okou-ai/okou/commit/c626a2602a368316e828b305523b656e2aa82f16))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.774.8
    * @okouai/db bumped to 1.353.2
    * @okouai/pi-agent-runtime bumped to 1.50.38

## [1.760.1](https://github.com/okou-ai/okou/compare/api-v1.760.0...api-v1.760.1) (2026-10-21)


### Refactoring

* remove linkwallet feature switch ([#41819](https://github.com/okou-ai/okou/issues/41819)) ([5b99811](https://github.com/okou-ai/okou/commit/5b99811378d267243e4a6c9603da8dcc1c2878ce))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.774.7
    * @okouai/db bumped to 1.353.1
    * @okouai/pi-agent-runtime bumped to 1.50.37

## [1.760.0](https://github.com/okou-ai/okou/compare/api-v1.759.4...api-v1.760.0) (2026-10-20)


### Features

* **ios:** add native chat connector authorization cards ([#41798](https://github.com/okou-ai/okou/issues/41798)) ([faeb0f9](https://github.com/okou-ai/okou/commit/faeb0f9992cf8d9750780a89538ea0d0aebc02c3))
* **runner:** track resource producers and prepare source matching ([#41900](https://github.com/okou-ai/okou/issues/41900)) ([f762cad](https://github.com/okou-ai/okou/commit/f762cada760922b815c9ad6d32012be39c5a3c08))


### Bug Fixes

* **api:** update markdown-it to 14.3.2 ([#41898](https://github.com/okou-ai/okou/issues/41898)) ([22ad19e](https://github.com/okou-ai/okou/commit/22ad19e8b22ab95355bd6b41a0aaab5c1d1c2360))
* drive browser action cards only from thread notifications ([#41834](https://github.com/okou-ai/okou/issues/41834)) ([41c8ae9](https://github.com/okou-ai/okou/commit/41c8ae9bc8eb4879f42873452e162380c3166c73))


### Refactoring

* **api:** inline the telegram reply footer at its delivery owner ([#41930](https://github.com/okou-ai/okou/issues/41930)) ([a288878](https://github.com/okou-ai/okou/commit/a288878830d5c9dd7aac54887e41538955f184f4))
* **api:** localize builtin catalog runtime wakeups ([#41909](https://github.com/okou-ai/okou/issues/41909)) ([81e089b](https://github.com/okou-ai/okou/commit/81e089b057415e78f4f9740a705a8b7ad84a85a0))
* **api:** localize discord run typing database reads ([#41925](https://github.com/okou-ai/okou/issues/41925)) ([c73ec12](https://github.com/okou-ai/okou/commit/c73ec121ac66289a8868aca0124b4869168d11ba))
* **api:** localize failed feishu ingress writes ([#41895](https://github.com/okou-ai/okou/issues/41895)) ([58ff5b8](https://github.com/okou-ai/okou/commit/58ff5b8fb5c7bf590a42671fbbf169ef6bf95795))
* **api:** localize post-commit budget expiry database ownership ([#41904](https://github.com/okou-ai/okou/issues/41904)) ([d9bef21](https://github.com/okou-ai/okou/commit/d9bef2170bb32ff3a04d02ee0ff77302115d2c5e))
* **api:** localize run output preparation reads ([#41918](https://github.com/okou-ai/okou/issues/41918)) ([8da0ea5](https://github.com/okou-ai/okou/commit/8da0ea54e2ed84bc4edbbce4aa952f5db9efe12f))
* **api:** localize slack app home database reads ([#41922](https://github.com/okou-ai/okou/issues/41922)) ([a60b820](https://github.com/okou-ai/okou/commit/a60b820d52e03f0cef4dd97055ba41b21c9fce10)) [#41920](https://github.com/okou-ai/okou/issues/41920)
* **api:** localize steering anchor reads ([#41886](https://github.com/okou-ai/okou/issues/41886)) ([24c9d36](https://github.com/okou-ai/okou/commit/24c9d3671057333d41139083f81acb1e4b71c5ab))
* **api:** localize telegram queued material reads ([#41912](https://github.com/okou-ai/okou/issues/41912)) ([d58f604](https://github.com/okou-ai/okou/commit/d58f604174642fb779c5e049cc5d3acdb06cc0e2)) [#41911](https://github.com/okou-ai/okou/issues/41911)
* retire telegram callback capability and teams completion marker ([#41927](https://github.com/okou-ai/okou/issues/41927)) ([0d2568c](https://github.com/okou-ai/okou/commit/0d2568c8b662d989146d468879cd757c433cdb8d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.583.0
    * @okouai/core bumped to 8.774.6
    * @okouai/db bumped to 1.353.0
    * @okouai/pi-agent-runtime bumped to 1.50.36

## [1.759.4](https://github.com/okou-ai/okou/compare/api-v1.759.3...api-v1.759.4) (2026-10-20)


### Bug Fixes

* **api:** revoke queued inputs when automations are deleted ([#41878](https://github.com/okou-ai/okou/issues/41878)) ([9b75e1c](https://github.com/okou-ai/okou/commit/9b75e1c3d0500d6c581fd882d5ecb6ebb0a5082b))
* update chat cards through owned realtime subscriptions ([#41829](https://github.com/okou-ai/okou/issues/41829)) ([18692b6](https://github.com/okou-ai/okou/commit/18692b6b59b22e9771aa87e64681b75d42efcab2))


### Refactoring

* **api:** keep discord queued launch database access local ([#41868](https://github.com/okou-ai/okou/issues/41868)) ([9595c91](https://github.com/okou-ai/okou/commit/9595c9132b6e9049485fe585aa95e10aa16eaf49))
* **api:** localize discord typing access reads ([#41865](https://github.com/okou-ai/okou/issues/41865)) ([26ab4bb](https://github.com/okou-ai/okou/commit/26ab4bb234848ffb6b20410e4ece50e49e441bd7))
* **api:** localize notion account projection ([#41859](https://github.com/okou-ai/okou/issues/41859)) ([87dcef2](https://github.com/okou-ai/okou/commit/87dcef201c052ac518bf874318c3a221f7ba1eab))
* **api:** localize slack queued launch reads ([#41869](https://github.com/okou-ai/okou/issues/41869)) ([0c1ffde](https://github.com/okou-ai/okou/commit/0c1ffde5492d8686dd1cf0275994d5859de63a97))
* retire agent instruction storage ([#41860](https://github.com/okou-ai/okou/issues/41860)) ([b4a90a6](https://github.com/okou-ai/okou/commit/b4a90a6b3f79527f91836df6a2bcc8fe81c622e8))
* **storage:** retire legacy guest completion snapshots ([#41842](https://github.com/okou-ai/okou/issues/41842)) ([5a9059b](https://github.com/okou-ai/okou/commit/5a9059b34f1190baeb2eeed71165e91009d2679f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.582.2
    * @okouai/core bumped to 8.774.5
    * @okouai/db bumped to 1.352.4
    * @okouai/pi-agent-runtime bumped to 1.50.35

## [1.759.3](https://github.com/okou-ai/okou/compare/api-v1.759.2...api-v1.759.3) (2026-10-20)


### Refactoring

* **app:** rely on shared async error handling ([#41838](https://github.com/okou-ai/okou/issues/41838)) ([23116d9](https://github.com/okou-ai/okou/commit/23116d989c109a46f398346802b3981a01b690d4))
* retire global connector account summaries ([#41847](https://github.com/okou-ai/okou/issues/41847)) ([2f6fdb8](https://github.com/okou-ai/okou/commit/2f6fdb830bf8d476e8a1c935b76896080dc15527))
* retire sandbox file debugging stack ([#41808](https://github.com/okou-ai/okou/issues/41808)) ([430cb92](https://github.com/okou-ai/okou/commit/430cb92b5431e1554d0a1dceed6d9cfb27762921))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.582.1
    * @okouai/core bumped to 8.774.4
    * @okouai/db bumped to 1.352.3
    * @okouai/pi-agent-runtime bumped to 1.50.34

## [1.759.2](https://github.com/okou-ai/okou/compare/api-v1.759.1...api-v1.759.2) (2026-10-20)


### Bug Fixes

* **api:** prefer same-host runners for draining predecessor homes ([#41799](https://github.com/okou-ai/okou/issues/41799)) ([ca63626](https://github.com/okou-ai/okou/commit/ca6362664686066960a89b36b4c99c2beee508d0))
* **api:** preserve text layout and weights in google slides imports ([#41818](https://github.com/okou-ai/okou/issues/41818)) ([da32537](https://github.com/okou-ai/okou/commit/da32537d3f8aecb5a8c3cde90ecd6aa69d76ef23))
* recover existing morning brief schedules from preferences ([#41806](https://github.com/okou-ai/okou/issues/41806)) ([f0f3ad2](https://github.com/okou-ai/okou/commit/f0f3ad29bc70943f5865b225e288e6d061cc217f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.582.0
    * @okouai/core bumped to 8.774.3
    * @okouai/db bumped to 1.352.2
    * @okouai/pi-agent-runtime bumped to 1.50.33

## [1.759.1](https://github.com/okou-ai/okou/compare/api-v1.759.0...api-v1.759.1) (2026-10-20)


### Bug Fixes

* **api:** select finalizing sources independently of native history ([#41730](https://github.com/okou-ai/okou/issues/41730)) ([9680638](https://github.com/okou-ai/okou/commit/968063848aea8cf54acd6f56facdf7cdcbd79051))


### Refactoring

* **api:** keep official telegram command db local ([#41795](https://github.com/okou-ai/okou/issues/41795)) ([192607e](https://github.com/okou-ai/okou/commit/192607e62e23393f80b0f2a4cea2e0fc23254a9e))
* **api:** retire delivery format guidance switch ([#41794](https://github.com/okou-ai/okou/issues/41794)) ([d013da9](https://github.com/okou-ai/okou/commit/d013da9a07294cb0f9f24e1fc15228baa55f5888))


### Performance Improvements

* load connector and remote directories on demand ([#41709](https://github.com/okou-ai/okou/issues/41709)) ([8e16d76](https://github.com/okou-ai/okou/commit/8e16d761b4f269b9a71c1a9c2d990ad6dbc55188))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.581.1
    * @okouai/core bumped to 8.774.2
    * @okouai/db bumped to 1.352.1
    * @okouai/pi-agent-runtime bumped to 1.50.32

## [1.759.0](https://github.com/okou-ai/okou/compare/api-v1.758.0...api-v1.759.0) (2026-10-20)


### Features

* **computer-use:** require one-hour chat approval for desktop shell ([#41768](https://github.com/okou-ai/okou/issues/41768)) ([d8f366b](https://github.com/okou-ai/okou/commit/d8f366bc5167781907f2a1b1bc8dc250bd380e0a))


### Bug Fixes

* **api:** make delivery format guidance neutral ([#41765](https://github.com/okou-ai/okou/issues/41765)) ([56afa30](https://github.com/okou-ai/okou/commit/56afa30e971e9ce6c84cee03689f0cca74b1f20d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.581.0
    * @okouai/core bumped to 8.774.1
    * @okouai/db bumped to 1.352.0
    * @okouai/pi-agent-runtime bumped to 1.50.31

## [1.758.0](https://github.com/okou-ai/okou/compare/api-v1.757.0...api-v1.758.0) (2026-10-20)


### Features

* **runner:** prepare owned peer home waits and hostname heartbeats ([#41747](https://github.com/okou-ai/okou/issues/41747)) ([61c7678](https://github.com/okou-ai/okou/commit/61c7678ee8630a0e3f15ec314eadbf4058bb4e54))


### Bug Fixes

* **host:** prepare okou.app visibility and clerk deployment ([#41745](https://github.com/okou-ai/okou/issues/41745)) ([5d1c5b6](https://github.com/okou-ai/okou/commit/5d1c5b667eafb9a95cb1bf96a2aa254add2a776a))


### Refactoring

* **api:** localize gmail account projection ([#41761](https://github.com/okou-ai/okou/issues/41761)) ([37de7ca](https://github.com/okou-ai/okou/commit/37de7cac4b8fddd0e08a9f9f012c75c6bd4f7b71))
* **api:** localize official telegram link database access ([#41759](https://github.com/okou-ai/okou/issues/41759)) ([1c5c055](https://github.com/okou-ai/okou/commit/1c5c055e5b7910e23760c2a78d5771219cd24216))
* **api:** resolve native continuation from thread bindings ([#41762](https://github.com/okou-ai/okou/issues/41762)) ([32986a1](https://github.com/okou-ai/okou/commit/32986a17a2469dfa758d8b6684c63943777e19b3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.580.0
    * @okouai/core bumped to 8.774.0
    * @okouai/db bumped to 1.351.0
    * @okouai/pi-agent-runtime bumped to 1.50.30

## [1.757.0](https://github.com/okou-ai/okou/compare/api-v1.756.0...api-v1.757.0) (2026-10-20)


### Features

* **api:** stagger morning brief starts per owner before 07:00 ([#41703](https://github.com/okou-ai/okou/issues/41703)) ([6f5b51f](https://github.com/okou-ai/okou/commit/6f5b51fd5c08f4065a66eeec687feb97efd0879c))
* **host:** enforce hosted site visibility in the delivery worker ([#41707](https://github.com/okou-ai/okou/issues/41707)) ([15308b6](https://github.com/okou-ai/okou/commit/15308b61db8a86f607f1400363c24449a3d233c2))
* route document generation through the office skill ([#41735](https://github.com/okou-ai/okou/issues/41735)) ([d5d8560](https://github.com/okou-ai/okou/commit/d5d85600d5beaf338b9d5580b5be0f733814a306))


### Bug Fixes

* **api:** resume bounded chat thread snapshot garbage collection ([#41711](https://github.com/okou-ai/okou/issues/41711)) ([f80becf](https://github.com/okou-ai/okou/commit/f80becf373467006e7cc2e48527ad0132bc0779c))


### Refactoring

* **api:** inline the slack command connection read ([#41733](https://github.com/okou-ai/okou/issues/41733)) ([60aa5ff](https://github.com/okou-ai/okou/commit/60aa5ff530f42f5162014ad92738dd6bd5ad22d4))
* **api:** localize calendar account projection ([#41696](https://github.com/okou-ai/okou/issues/41696)) ([a60f034](https://github.com/okou-ai/okou/commit/a60f0348713d62f45cc94e78d208a1114820f961))
* **api:** localize slack route compose reads ([#41736](https://github.com/okou-ai/okou/issues/41736)) ([89e2c7e](https://github.com/okou-ai/okou/commit/89e2c7ef9f4a91d88c78b46d95e6ead953109ac3))
* prepare connector projection and runtime readers ([#41715](https://github.com/okou-ai/okou/issues/41715)) ([7500d09](https://github.com/okou-ai/okou/commit/7500d0902eb219e3a2c190a8b0057308e3db8aa9))


### Performance Improvements

* **api:** optimize chat maintenance scans and simplify thread artifacts ([#41710](https://github.com/okou-ai/okou/issues/41710)) ([3b63fc5](https://github.com/okou-ai/okou/commit/3b63fc53448127fcb2fd559ae9589d79ad3b6913))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.579.0
    * @okouai/connectors bumped to 3.16.12
    * @okouai/core bumped to 8.773.0
    * @okouai/db bumped to 1.350.0
    * @okouai/pi-agent-runtime bumped to 1.50.29

## [1.756.0](https://github.com/okou-ai/okou/compare/api-v1.755.0...api-v1.756.0) (2026-10-20)


### Features

* **api:** cancel atom subscription grants ([#41692](https://github.com/okou-ai/okou/issues/41692)) ([099ca7e](https://github.com/okou-ai/okou/commit/099ca7e661dfd95436dda3d101ddfc2bc5d637eb))
* enable discord integration for all users ([#41619](https://github.com/okou-ai/okou/issues/41619)) ([d7ea540](https://github.com/okou-ai/okou/commit/d7ea54097c343c791f5373ce7df45f7c0687c212))
* **ios:** align chat model selection and personal subscriptions ([#41668](https://github.com/okou-ai/okou/issues/41668)) ([3c7a3cb](https://github.com/okou-ai/okou/commit/3c7a3cbda46f217ebedf178a6ea2083a24f08291))
* restore original document designs and add sidebar report ([#41464](https://github.com/okou-ai/okou/issues/41464)) ([d4a7eed](https://github.com/okou-ai/okou/commit/d4a7eedf3347eaa393954e3aeabc58247b68002e))


### Bug Fixes

* **api:** settle free official usage without a transaction ([#41662](https://github.com/okou-ai/okou/issues/41662)) ([3a6fee2](https://github.com/okou-ai/okou/commit/3a6fee2d52618726914c5f9a16a9681ac0f4553f))
* keep auto on pi when codex execution is enabled ([#41648](https://github.com/okou-ai/okou/issues/41648)) ([1a3d4c8](https://github.com/okou-ai/okou/commit/1a3d4c8229ffdd4175b5ac510d6421ea5ee60076))
* log provider image-size rejections as expected input failures ([#41635](https://github.com/okou-ai/okou/issues/41635)) ([d0bce92](https://github.com/okou-ai/okou/commit/d0bce92f6c403596f5f2210fe24051f452d53ecb))
* **maps:** distinguish unverified results from invalid citations ([#41644](https://github.com/okou-ai/okou/issues/41644)) ([a67d84c](https://github.com/okou-ai/okou/commit/a67d84c337e379278b959dec5788d42743102223))


### Refactoring

* activate account-scoped connector setup status ([#41531](https://github.com/okou-ai/okou/issues/41531)) ([ae50917](https://github.com/okou-ai/okou/commit/ae50917fdaa73697ac66badac03ca8b2abd6c2e8))
* **api:** capture terminal billing facts in the terminal statement ([#41670](https://github.com/okou-ai/okou/issues/41670)) ([b6d1b17](https://github.com/okou-ai/okou/commit/b6d1b17ea713c103a0d7de4292f252c81f32aecb))
* **api:** keep changed-migration failure writes in their owner ([#41552](https://github.com/okou-ai/okou/issues/41552)) ([52ff630](https://github.com/okou-ai/okou/commit/52ff6304f269c0d6e646ba472288d9820b32d251))
* **api:** keep discord ingress claim db local ([#41554](https://github.com/okou-ai/okou/issues/41554)) ([42a13ff](https://github.com/okou-ai/okou/commit/42a13ff39d7dc9c3e6b8a3a16d38c46932843297))
* **api:** keep pending recall read in its owning command ([#41515](https://github.com/okou-ai/okou/issues/41515)) ([3d4c98a](https://github.com/okou-ai/okou/commit/3d4c98a128d4b73e9b8a57234608f6526ddf0271))
* **api:** keep slack ingress claims in their owning command ([#41529](https://github.com/okou-ai/okou/issues/41529)) ([5bc23f3](https://github.com/okou-ai/okou/commit/5bc23f35f00eb26ed74dba887a85c09a2edf4421))
* **api:** keep threadless candidate reads in their owner ([#41561](https://github.com/okou-ai/okou/issues/41561)) ([a94375a](https://github.com/okou-ai/okou/commit/a94375a129781f271fedc4f08eb55d7c9f144fec))
* **api:** keep usage pack credit reads in their route owner ([#41537](https://github.com/okou-ai/okou/issues/41537)) ([7ec7c42](https://github.com/okou-ai/okou/commit/7ec7c4262e8ca334ef794b3b6d593bca4b4bd71c)) [#41534](https://github.com/okou-ai/okou/issues/41534)
* **api:** localize banned last-admin subscription cleanup ([#41562](https://github.com/okou-ai/okou/issues/41562)) ([fcd4ac8](https://github.com/okou-ai/okou/commit/fcd4ac832fc7c24bd0a8fb101be6bb61cbb6292e))
* **api:** localize billing reconcile candidate reads ([#41543](https://github.com/okou-ai/okou/issues/41543)) ([1b2640e](https://github.com/okou-ai/okou/commit/1b2640ee344910e42901c601c8d6f08b26ef70f7))
* **api:** localize claimed slack ingress reads ([#41576](https://github.com/okou-ai/okou/issues/41576)) ([3aaa5df](https://github.com/okou-ai/okou/commit/3aaa5dfc09a4e8ded003706de717f8ebf43745c0))
* **api:** localize connector diagnostic cleanup ([#41555](https://github.com/okou-ai/okou/issues/41555)) ([8a09f2c](https://github.com/okou-ai/okou/commit/8a09f2c6c49c39edc9b3df72db35cd3649998318))
* **api:** localize discord delivery receipt read ([#41521](https://github.com/okou-ai/okou/issues/41521)) ([e150e00](https://github.com/okou-ai/okou/commit/e150e0081a999c15434b20ffc1aef103978f4224))
* **api:** localize discord heartbeat typing cadence read ([#41566](https://github.com/okou-ai/okou/issues/41566)) ([f2fab24](https://github.com/okou-ai/okou/commit/f2fab248e7975d777d02769787c923f4e09acd99)) [#41564](https://github.com/okou-ai/okou/issues/41564)
* **api:** localize discord lost-claim delivery readback ([#41608](https://github.com/okou-ai/okou/issues/41608)) ([43e3f23](https://github.com/okou-ai/okou/commit/43e3f23c7c098384c12cf621d653ca0b4831fa8b))
* **api:** localize feishu callback message sends ([#41618](https://github.com/okou-ai/okou/issues/41618)) ([478774b](https://github.com/okou-ai/okou/commit/478774b5e915eb23f645c9b1cd2a5b96a202f8c7))
* **api:** localize integration footer model reads ([#41593](https://github.com/okou-ai/okou/issues/41593)) ([63a6767](https://github.com/okou-ai/okou/commit/63a6767ad16fd76a614e53c7d95c34bef7535f9a))
* **api:** localize slack disconnect writes ([#41598](https://github.com/okou-ai/okou/issues/41598)) ([c7fa5cc](https://github.com/okou-ai/okou/commit/c7fa5ccae599b774759bf5ef9ed7a51a5329a63d))
* **api:** localize slack ingress failure writes ([#41524](https://github.com/okou-ai/okou/issues/41524)) ([48ebdfa](https://github.com/okou-ai/okou/commit/48ebdfa2241709d17a8598c46c150054ed1d0c87))
* **api:** localize slack workspace installation reads ([#41621](https://github.com/okou-ai/okou/issues/41621)) ([9f796ff](https://github.com/okou-ai/okou/commit/9f796ff0a900750a3c0bc2a1fff1e2437ea8cfdc))
* **api:** localize steered input consumption ([#41573](https://github.com/okou-ai/okou/issues/41573)) ([50c2a65](https://github.com/okou-ai/okou/commit/50c2a6531a688c9188882d57ecfce5c1c8b92635))
* **api:** localize telegram connect agent reads ([#41569](https://github.com/okou-ai/okou/issues/41569)) ([893daf5](https://github.com/okou-ai/okou/commit/893daf5745def5931aa09084e056d8795327f131))
* **api:** own agentphone workspace-agent read ([#41601](https://github.com/okou-ai/okou/issues/41601)) ([5f89c37](https://github.com/okou-ai/okou/commit/5f89c37b8a5cff4da9565ffb20d91ebb74c98f87))
* **api:** own canonical slack reconciliation in preparation ([#41563](https://github.com/okou-ai/okou/issues/41563)) ([c4d25fc](https://github.com/okou-ai/okou/commit/c4d25fcf94f5badc175e6200583194c7c5f60f42)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own discord delivery readbacks ([#41585](https://github.com/okou-ai/okou/issues/41585)) ([b66ea3c](https://github.com/okou-ai/okou/commit/b66ea3c3f051ff15fa23ecbea9486386220098aa))
* **api:** own discord failure recording in send command ([#41578](https://github.com/okou-ai/okou/issues/41578)) ([6c91633](https://github.com/okou-ai/okou/commit/6c91633d9d512dc7a57d3555244a674f0f8ade16))
* **api:** own discord sticky route reads in commands ([#41581](https://github.com/okou-ai/okou/issues/41581)) ([65d5396](https://github.com/okou-ai/okou/commit/65d5396d9e7470ed74858618b99eb6f0a0aa48a8))
* **api:** own feishu connector id preflight ([#41589](https://github.com/okou-ai/okou/issues/41589)) ([bf6f91d](https://github.com/okou-ai/okou/commit/bf6f91de24e85bcf277d60d292426ff2a15f290f))
* **api:** own feishu ingress processed writes ([#41646](https://github.com/okou-ai/okou/issues/41646)) ([261ea53](https://github.com/okou-ai/okou/commit/261ea53d06352b0b82a2dcf2bfdf24c65b7d1872))
* **api:** own feishu message delivery in commands ([#41560](https://github.com/okou-ai/okou/issues/41560)) ([9a4ae1b](https://github.com/okou-ai/okou/commit/9a4ae1bee4b28c01468d8f124ec8d53e30f9432c))
* **api:** own feishu thinking reaction cleanup ([#41577](https://github.com/okou-ai/okou/issues/41577)) ([21b1ae3](https://github.com/okou-ai/okou/commit/21b1ae3fdb005eca77119bcb7f1c55d0d8ee4e5e))
* **api:** own slack command workspace context ([#41606](https://github.com/okou-ai/okou/issues/41606)) ([27930e9](https://github.com/okou-ai/okou/commit/27930e94b0caf9679475067bdba30cca0762e043))
* **api:** own teams callback mentioner-count reads ([#41603](https://github.com/okou-ai/okou/issues/41603)) ([53b82c4](https://github.com/okou-ai/okou/commit/53b82c43cc4cbac3beaab9931b8ff606cdd9e63c))
* **api:** own telegram context lookup ([#41582](https://github.com/okou-ai/okou/issues/41582)) ([172e7f6](https://github.com/okou-ai/okou/commit/172e7f6afd57a61c16d3020d1546c5ae06b95355)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own telegram unaddressed message storage ([#41548](https://github.com/okou-ai/okou/issues/41548)) ([1794fdd](https://github.com/okou-ai/okou/commit/1794fdd34b3f01beec78ae1a9e33ea3510d78321)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own the terminal callback run locator read ([#41590](https://github.com/okou-ai/okou/issues/41590)) ([3033a58](https://github.com/okou-ai/okou/commit/3033a582bb77dca964801b69ffa43230a6f410f9))
* **api:** own three slack connection reads ([#41686](https://github.com/okou-ai/okou/issues/41686)) ([3925912](https://github.com/okou-ai/okou/commit/392591209106eb16115dfc944b38761ef88fa6f4))
* **api:** own usage pack management context reads ([#41540](https://github.com/okou-ai/okou/issues/41540)) ([5a2cdb9](https://github.com/okou-ai/okou/commit/5a2cdb9480488a9ac6afcb687d5918a4661865fb))
* **api:** prepare storage-named run completion metadata ([#41656](https://github.com/okou-ai/okou/issues/41656)) ([89ed595](https://github.com/okou-ai/okou/commit/89ed595a100601fa615430b3f5aa9a828e68d1fa))
* **api:** read chat usage receipts from billing lifecycle ([#41655](https://github.com/okou-ai/okou/issues/41655)) ([01f53c2](https://github.com/okou-ai/okou/commit/01f53c2a2640227e2cbbecab62ee97581b21d9e9))
* remove expired teams install redirect and wallet spend compatibility ([#41583](https://github.com/okou-ai/okou/issues/41583)) ([bad6179](https://github.com/okou-ai/okou/commit/bad61790761ccd91d8dc1224f4ca43ad87ab1ba5))
* remove remote control cli management feature switch ([#41671](https://github.com/okou-ai/okou/issues/41671)) ([3e2cc22](https://github.com/okou-ai/okou/commit/3e2cc2296a0919f015a94f40035c39ef37355a95))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.578.0
    * @okouai/core bumped to 8.772.0
    * @okouai/db bumped to 1.349.0
    * @okouai/pi-agent-runtime bumped to 1.50.28

## [1.755.0](https://github.com/okou-ai/okou/compare/api-v1.754.0...api-v1.755.0) (2026-10-19)


### Features

* **api:** make official workflows free and platform controlled ([#41496](https://github.com/okou-ai/okou/issues/41496)) ([1673e0e](https://github.com/okou-ai/okou/commit/1673e0e6d1f2f2c95f515894430e348d73acc195))


### Bug Fixes

* **agentphone:** defer contact cards until after a successful conversation ([#41427](https://github.com/okou-ai/okou/issues/41427)) ([50f988e](https://github.com/okou-ai/okou/commit/50f988e6f08e2ebfd709ac0ad48c4e6e8caeae1d))
* **api:** preserve discovery rank for migrated mcp connectors ([#41450](https://github.com/okou-ai/okou/issues/41450)) ([3330068](https://github.com/okou-ai/okou/commit/33300689f87539baf927dcd38a7bb7d1888b9bd9))
* **api:** re-verify active suggestions for expiry in curation ([#41453](https://github.com/okou-ai/okou/issues/41453)) ([75041d2](https://github.com/okou-ai/okou/commit/75041d29bebbbf3b388e37b52eb790754b229f55))
* **remote:** prefer exact attempts in ssh and vnc diagnostic guidance ([#41479](https://github.com/okou-ai/okou/issues/41479)) ([81b763d](https://github.com/okou-ai/okou/commit/81b763de04dd2b1d9b34b15007fa147bd254f221))
* **runner:** reuse finalizing cancelled and failed predecessors ([#41492](https://github.com/okou-ai/okou/issues/41492)) ([204439c](https://github.com/okou-ai/okou/commit/204439c4147e9e1f68860ac0ba1000d6d7b4dd3b))


### Refactoring

* **api:** localize available log filter reads ([#41439](https://github.com/okou-ai/okou/issues/41439)) ([9cdb309](https://github.com/okou-ai/okou/commit/9cdb3096486c5129227169b7bfe27caf1f2d3948))
* **api:** localize canonical slack conflict reads ([#41504](https://github.com/okou-ai/okou/issues/41504)) ([426e380](https://github.com/okou-ai/okou/commit/426e38055777468a2b2e3c6747bbb205252c86bc)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** localize discord duplicate-message reads ([#41485](https://github.com/okou-ai/okou/issues/41485)) ([0db4103](https://github.com/okou-ai/okou/commit/0db410379eb495ccb17e516c1888908a333b344a))
* **api:** localize discord materialization loads ([#41434](https://github.com/okou-ai/okou/issues/41434)) ([e1ddb21](https://github.com/okou-ai/okou/commit/e1ddb214c7a193da065b5093c1e3a2aa8414e777))
* **api:** localize feishu conversation history ownership ([#41483](https://github.com/okou-ai/okou/issues/41483)) ([5894cb7](https://github.com/okou-ai/okou/commit/5894cb77115d44286f5301fcc041bc9d16d8ed17))
* **api:** own deferred subscription schedule reload ([#41455](https://github.com/okou-ai/okou/issues/41455)) ([b91cd40](https://github.com/okou-ai/okou/commit/b91cd40a7e7fa990d14e0836ca121b879b44995b)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own discord completion load and isolate history fixture ([#41482](https://github.com/okou-ai/okou/issues/41482)) ([3389cee](https://github.com/okou-ai/okou/commit/3389cee781aaedf07bdd013d108f38f351040457))
* **api:** own first subscription invoice reload ([#41497](https://github.com/okou-ai/okou/issues/41497)) ([49eb25d](https://github.com/okou-ai/okou/commit/49eb25da7e76e44fcecbc6a6fa92f8b7607a52fc)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own teams connection lookup in dispatch ([#41493](https://github.com/okou-ai/okou/issues/41493)) ([43c7d83](https://github.com/okou-ai/okou/commit/43c7d83d585f75d7697ca01bfd434891fcec6f29)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own telegram agent message store executor ([#41441](https://github.com/okou-ai/okou/issues/41441)) ([5f9c0e7](https://github.com/okou-ai/okou/commit/5f9c0e77bcdb901d3b68458306dcf936203c4b88))
* **api:** retire legacy disk telemetry ingestion ([#41380](https://github.com/okou-ai/okou/issues/41380)) ([ab96eac](https://github.com/okou-ai/okou/commit/ab96eaca320cbdf6fb46103d3de7a4207e948aba))
* **api:** retire provider-scoped canonical delivery index ([#41435](https://github.com/okou-ai/okou/issues/41435)) ([3f89a59](https://github.com/okou-ai/okou/commit/3f89a59ad3d4f28812b5f99c02697e65a599a7d2))
* prepare database-backed agent instructions ([#41393](https://github.com/okou-ai/okou/issues/41393)) ([da0dc9c](https://github.com/okou-ai/okou/commit/da0dc9cd1b21ecdd91200fb1cad8600ee5fdfd29))


### Performance Improvements

* streamline sql reads and thread artifact ownership ([#41240](https://github.com/okou-ai/okou/issues/41240)) ([859ae6d](https://github.com/okou-ai/okou/commit/859ae6d2be16afa00ec717ba3680f002ced8f235))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.577.0
    * @okouai/core bumped to 8.771.0
    * @okouai/db bumped to 1.348.0
    * @okouai/pi-agent-runtime bumped to 1.50.27

## [1.754.0](https://github.com/okou-ai/okou/compare/api-v1.753.0...api-v1.754.0) (2026-10-19)


### Features

* **api:** pin official workflows to auto and configure thread visibility ([#41404](https://github.com/okou-ai/okou/issues/41404)) ([a6fb382](https://github.com/okou-ai/okou/commit/a6fb382f4dc9f56f62813a5a1ff7378faffa859f))
* **wallet:** continue chats after link purchase approval ([#41375](https://github.com/okou-ai/okou/issues/41375)) ([43b3fb0](https://github.com/okou-ai/okou/commit/43b3fb081ff5be33d39c48b9896ddf86aa03ebba))


### Bug Fixes

* **api:** preserve chinese font choices in google docs imports ([#41344](https://github.com/okou-ai/okou/issues/41344)) ([dd23930](https://github.com/okou-ai/okou/commit/dd23930785a8b67547abe78b200f6da32365030e))
* **app:** keep model menu stable while subscription usage loads ([#41376](https://github.com/okou-ai/okou/issues/41376)) ([a5db54a](https://github.com/okou-ai/okou/commit/a5db54a2b085ae7d0950117155248a3d0be05a84))
* **connectors:** preserve custom mcp endpoint queries ([#41338](https://github.com/okou-ai/okou/issues/41338)) ([e45d0c3](https://github.com/okou-ai/okou/commit/e45d0c344252fa0830ec939dab9da39b1d8d187c))
* **host:** keep renamed site addresses current across artifacts ([#41405](https://github.com/okou-ai/okou/issues/41405)) ([14f3a65](https://github.com/okou-ai/okou/commit/14f3a65e91d3a93968ae4b1c4c375efde32d2baf))


### Refactoring

* **api:** keep logs total count in its computed ([#41416](https://github.com/okou-ai/okou/issues/41416)) ([4a49cc5](https://github.com/okou-ai/okou/commit/4a49cc53a6d1e5b2899d63f0cb92e3dc6f8f4258))
* **api:** keep run context ownership read inside its computed ([#41400](https://github.com/okou-ai/okou/issues/41400)) ([1163663](https://github.com/okou-ai/okou/commit/1163663a8cea06deb72e87a4ada97d3e6b90e570))
* **api:** localize catalog identity read ([#41133](https://github.com/okou-ai/okou/issues/41133)) ([34760bb](https://github.com/okou-ai/okou/commit/34760bbb6cedb9c5fecefc9c173beb6acd03de5d))
* **api:** localize discord delivery receipt ownership ([#41399](https://github.com/okou-ai/okou/issues/41399)) ([e7c48c9](https://github.com/okou-ai/okou/commit/e7c48c9495b2852348c62b2e65ca2f4cfd1f37f5))
* **api:** localize feishu thinking reaction ownership ([#41383](https://github.com/okou-ai/okou/issues/41383)) ([68830e3](https://github.com/okou-ai/okou/commit/68830e3fa0595b4783f4a89ec444649e871e70b9))
* **api:** localize schedule-ended billing update ([#41360](https://github.com/okou-ai/okou/issues/41360)) ([cc846df](https://github.com/okou-ai/okou/commit/cc846df180c5377f3f56a084b01f646a20876b9b))
* **api:** localize telegram workspace agent read ([#41352](https://github.com/okou-ai/okou/issues/41352)) ([9390b8c](https://github.com/okou-ai/okou/commit/9390b8c655bb0875bb1223fe6366ff98d03aecb5)) [#41343](https://github.com/okou-ai/okou/issues/41343)
* **api:** own slack success transition writes ([#41366](https://github.com/okou-ai/okou/issues/41366)) ([caa40bb](https://github.com/okou-ai/okou/commit/caa40bb4845894f9491585d11b8a64c9b2c7d7b0)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own teams compose reads in dispatch command ([#41365](https://github.com/okou-ai/okou/issues/41365)) ([3ea566b](https://github.com/okou-ai/okou/commit/3ea566bcd7df873092b76e41dd6c894d21823103)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** retire duplicate run artifact writes ([#41397](https://github.com/okou-ai/okou/issues/41397)) ([c42cf8b](https://github.com/okou-ai/okou/commit/c42cf8bc60dbe57fc817eb7e175961ee4fc6f1f5))
* **wallet:** retire legacy cli consent request modes ([#41415](https://github.com/okou-ai/okou/issues/41415)) ([bdcb8e9](https://github.com/okou-ai/okou/commit/bdcb8e91e912d18c18cb7b368a9ff5c0bd4c004c))
* **wechat:** retire the legacy polling bridge ([#41348](https://github.com/okou-ai/okou/issues/41348)) ([1af69ce](https://github.com/okou-ai/okou/commit/1af69ce9dd674fe4cce9f2388d434ca0b7d73427))


### Performance Improvements

* **api:** reduce chat startup sql planning overhead ([#41408](https://github.com/okou-ai/okou/issues/41408)) ([4527573](https://github.com/okou-ai/okou/commit/4527573cd5c28cd72b6b6f0307b4116f02292da5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.576.0
    * @okouai/connectors bumped to 3.16.11
    * @okouai/core bumped to 8.770.0
    * @okouai/db bumped to 1.347.0
    * @okouai/pi-agent-runtime bumped to 1.50.26

## [1.753.0](https://github.com/okou-ai/okou/compare/api-v1.752.0...api-v1.753.0) (2026-10-19)


### Features

* **wallet:** show saved cards with link management ([#41337](https://github.com/okou-ai/okou/issues/41337)) ([ad98740](https://github.com/okou-ai/okou/commit/ad98740b5d40ad6589f4b0ba03e3606ef08a8450))


### Refactoring

* **api:** capture billing run lifecycle facts ([#41321](https://github.com/okou-ai/okou/issues/41321)) ([94a4167](https://github.com/okou-ai/okou/commit/94a41674408cac9a8e27e02e10f513dd410ac686))
* **api:** localize agentphone typing read ownership ([#41096](https://github.com/okou-ai/okou/issues/41096)) ([7d27b85](https://github.com/okou-ai/okou/commit/7d27b85be3b16f2b05ce427914e90fb098bdf4da))
* **api:** localize official telegram default-agent read ([#41302](https://github.com/okou-ai/okou/issues/41302)) ([fca3e26](https://github.com/okou-ai/okou/commit/fca3e26fcdfe1a9b4047640e5902ce9e829c0e24))
* **api:** localize runtime catalog payload read ([#41130](https://github.com/okou-ai/okou/issues/41130)) ([069d1fe](https://github.com/okou-ai/okou/commit/069d1fefbc89a7490577cd5be23646ed537b78e7)) [#41129](https://github.com/okou-ai/okou/issues/41129)
* **api:** localize slack workspace-agent reads ([#41299](https://github.com/okou-ai/okou/issues/41299)) ([84259fa](https://github.com/okou-ai/okou/commit/84259faefece62cf37f56a607dffb5b386a9b882))
* **api:** own chat search matches read in existing computed ([#41200](https://github.com/okou-ai/okou/issues/41200)) ([e28449f](https://github.com/okou-ai/okou/commit/e28449f23ce7b4da1d167a21b392989564f43f9f))
* **api:** own slack reconciliation failure writes ([#41325](https://github.com/okou-ai/okou/issues/41325)) ([58b15d8](https://github.com/okou-ai/okou/commit/58b15d894ee09bd67f8a08e19bb68305eec0baa8)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** remove local catalog wakeup db carriers ([#41250](https://github.com/okou-ai/okou/issues/41250)) ([5f80d74](https://github.com/okou-ai/okou/commit/5f80d74e50b03f31eec571b52f691d4f6b8a4612))
* **api:** simplify run storage outputs and retire volume projections ([#41333](https://github.com/okou-ai/okou/issues/41333)) ([d43d7bf](https://github.com/okou-ai/okou/commit/d43d7bf9c153795627ef7f0e9d401f0d064a8f9d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.575.0
    * @okouai/core bumped to 8.769.3
    * @okouai/db bumped to 1.346.1
    * @okouai/pi-agent-runtime bumped to 1.50.25

## [1.752.0](https://github.com/okou-ai/okou/compare/api-v1.751.6...api-v1.752.0) (2026-10-19)


### Features

* **suggestions:** add opt-in hourly proactive suggestions ([#41251](https://github.com/okou-ai/okou/issues/41251)) ([154bc8a](https://github.com/okou-ai/okou/commit/154bc8acb035843ea47c99f6f56f5779698c6bbb))


### Bug Fixes

* load complete chat relationships before folding ([#41294](https://github.com/okou-ai/okou/issues/41294)) ([f54609b](https://github.com/okou-ai/okou/commit/f54609b895643b419e55321ebe25e0ef24057c08))


### Refactoring

* retire artifact preview wire compatibility ([#41305](https://github.com/okou-ai/okou/issues/41305)) ([9b8bf22](https://github.com/okou-ai/okou/commit/9b8bf22ebd17f157abd67822f65c8771b6e314d6))
* retire historical link wallet status compatibility ([#41303](https://github.com/okou-ai/okou/issues/41303)) ([353a229](https://github.com/okou-ai/okou/commit/353a229dc08f0691e37a48bcc0f3e9589c4889a9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.574.0
    * @okouai/core bumped to 8.769.2
    * @okouai/db bumped to 1.346.0
    * @okouai/pi-agent-runtime bumped to 1.50.24

## [1.751.6](https://github.com/okou-ai/okou/compare/api-v1.751.5...api-v1.751.6) (2026-10-19)


### Bug Fixes

* preserve saved connector accounts when defaults need reconnect ([#41254](https://github.com/okou-ai/okou/issues/41254)) ([24a1ff5](https://github.com/okou-ai/okou/commit/24a1ff50b8b8bff3a8baeae1ebc55de5caf1eab6))
* **wechat:** recover dm replies and improve conversation tools ([#41215](https://github.com/okou-ai/okou/issues/41215)) ([654e918](https://github.com/okou-ai/okou/commit/654e918b1962876fb33696475f836e5a9842cb27))


### Refactoring

* **api:** keep billing portal customer lookup local ([#41274](https://github.com/okou-ai/okou/issues/41274)) ([de80cc6](https://github.com/okou-ai/okou/commit/de80cc6ab44bf9fdcad84cd9de026cc5a8945be9)) [#41270](https://github.com/okou-ai/okou/issues/41270)
* **api:** own canonical slack completion failure writes ([#41262](https://github.com/okou-ai/okou/issues/41262)) ([789d0d6](https://github.com/okou-ai/okou/commit/789d0d6ee829d6f51f5ec0fe0268a58d63b5087b)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own canonical slack preparation failure writes ([#41278](https://github.com/okou-ai/okou/issues/41278)) ([49f3e5e](https://github.com/okou-ai/okou/commit/49f3e5ed60068241fce8545fc906b3a8e0ab9566)) [#37510](https://github.com/okou-ai/okou/issues/37510)


### Performance Improvements

* move wechat receiving to cloudflare workflows ([#41269](https://github.com/okou-ai/okou/issues/41269)) ([0c9a663](https://github.com/okou-ai/okou/commit/0c9a663d0c368cdbb489a0829a99642b12546905))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.573.4
    * @okouai/connectors bumped to 3.16.10
    * @okouai/core bumped to 8.769.1
    * @okouai/db bumped to 1.345.10
    * @okouai/pi-agent-runtime bumped to 1.50.23

## [1.751.5](https://github.com/okou-ai/okou/compare/api-v1.751.4...api-v1.751.5) (2026-10-19)


### Bug Fixes

* gate chat relationships with chat resources ([#41222](https://github.com/okou-ai/okou/issues/41222)) ([70fb95a](https://github.com/okou-ai/okou/commit/70fb95a14daf3ba4ce7995ab188f9a57e616a01d))
* send wechat welcome on connection and add reconnect page ([#41211](https://github.com/okou-ai/okou/issues/41211)) ([14f9545](https://github.com/okou-ai/okou/commit/14f95457d99c5b3dfa98918de4e888f94095217a))


### Refactoring

* **runtime:** remove retired session conversation code ([#41218](https://github.com/okou-ai/okou/issues/41218)) ([b88a27d](https://github.com/okou-ai/okou/commit/b88a27dd3bc4df3a11e4e8953547d9170421e804))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.573.3
    * @okouai/core bumped to 8.769.0
    * @okouai/db bumped to 1.345.9
    * @okouai/pi-agent-runtime bumped to 1.50.22

## [1.751.4](https://github.com/okou-ai/okou/compare/api-v1.751.3...api-v1.751.4) (2026-10-19)


### Bug Fixes

* **api:** preserve artifact previews before generic og lookup ([#40873](https://github.com/okou-ai/okou/issues/40873)) ([dce7cd9](https://github.com/okou-ai/okou/commit/dce7cd99621887541f3a71e26f403dd9ef23147e))


### Performance Improvements

* **wechat:** reuse send access and measure reply delivery ([#40713](https://github.com/okou-ai/okou/issues/40713)) ([191f4e4](https://github.com/okou-ai/okou/commit/191f4e4fc3b45f0127c9e028398fac24a79a8411))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.573.2
    * @okouai/core bumped to 8.768.0
    * @okouai/db bumped to 1.345.8
    * @okouai/pi-agent-runtime bumped to 1.50.21

## [1.751.3](https://github.com/okou-ai/okou/compare/api-v1.751.2...api-v1.751.3) (2026-10-19)


### Refactoring

* **api:** inline connector catalog discovery read ([#41180](https://github.com/okou-ai/okou/issues/41180)) ([8dcd72f](https://github.com/okou-ai/okou/commit/8dcd72f1ed01679256b7a7129588bf5b3f74183d))
* **api:** localize feishu first-message receipt ownership ([#41189](https://github.com/okou-ai/okou/issues/41189)) ([7bd2e6c](https://github.com/okou-ai/okou/commit/7bd2e6c1314e41a0694c95d36be6be0caaedbce0))

## [1.751.2](https://github.com/okou-ai/okou/compare/api-v1.751.1...api-v1.751.2) (2026-10-19)


### Refactoring

* **api:** localize catalog status forwarding ([#41143](https://github.com/okou-ai/okou/issues/41143)) ([c0412c0](https://github.com/okou-ai/okou/commit/c0412c082db5caa9a93ad8aa3cf047f8f747c09e))
* **api:** localize runtime wakeup discovery ([#41146](https://github.com/okou-ai/okou/issues/41146)) ([a08bbae](https://github.com/okou-ai/okou/commit/a08bbaeddfc0106b7abda0841b9a70a258be0d8e))

## [1.751.1](https://github.com/okou-ai/okou/compare/api-v1.751.0...api-v1.751.1) (2026-10-19)


### Bug Fixes

* **api:** anchor reuse protection to first discovery ([#41046](https://github.com/okou-ai/okou/issues/41046)) ([4b9d5e7](https://github.com/okou-ai/okou/commit/4b9d5e72be111ba1f61314f070913d96cf530981))
* **api:** authorize built-in model job claims ([#41038](https://github.com/okou-ai/okou/issues/41038)) ([21855e6](https://github.com/okou-ai/okou/commit/21855e68fb3030a6852f12891cb57e044b58c4b5))


### Refactoring

* **api:** localize account automation invalidation ([#41037](https://github.com/okou-ai/okou/issues/41037)) ([35a5855](https://github.com/okou-ai/okou/commit/35a58551cd406eca4c39adbfeca2ca8c7fb83a36))
* **api:** localize agent configuration existing row read ([#41081](https://github.com/okou-ai/okou/issues/41081)) ([7b82f3a](https://github.com/okou-ai/okou/commit/7b82f3a152c2cf3b9a73620a0bc30947bc204920))
* **api:** localize agent draft write ownership ([#41102](https://github.com/okou-ai/okou/issues/41102)) ([ac5e9c7](https://github.com/okou-ai/okou/commit/ac5e9c744edba0a91f367edc0ceb5aeb8ededa2b))
* **api:** localize agent metadata existing-row lookup ([#41088](https://github.com/okou-ai/okou/issues/41088)) ([d70636a](https://github.com/okou-ai/okou/commit/d70636afaf85f8a7021fca1908ba283bc6c55cd0))
* **api:** localize agent update response reads ([#41093](https://github.com/okou-ai/okou/issues/41093)) ([547a812](https://github.com/okou-ai/okou/commit/547a812be67773dd258bf8caef26fb12a3ba82b3)) [#41090](https://github.com/okou-ai/okou/issues/41090)
* **api:** localize cancellation recovery callback lookup ([#41106](https://github.com/okou-ai/okou/issues/41106)) ([8580c29](https://github.com/okou-ai/okou/commit/8580c29fde54bb6d3bace8c2580fc5fd4ecaebd1))
* **api:** localize catalog list forwarding ([#41138](https://github.com/okou-ai/okou/issues/41138)) ([c7f80c8](https://github.com/okou-ai/okou/commit/c7f80c832fa34d30f0e2a60ae29eeb9e86bd1d9b))
* **api:** localize catalog search forwarding ([#41141](https://github.com/okou-ai/okou/issues/41141)) ([5a7eee9](https://github.com/okou-ai/okou/commit/5a7eee9da3f47e57865e2265068dd0aeeeaf25d0))
* **api:** localize chat search projection sql ownership ([#41069](https://github.com/okou-ai/okou/issues/41069)) ([ffe5597](https://github.com/okou-ai/okou/commit/ffe55979015deeffaeee3dfa4d4631a78dbc7919))
* **api:** localize custom connector agent grant reads ([#41056](https://github.com/okou-ai/okou/issues/41056)) ([1bb6619](https://github.com/okou-ai/okou/commit/1bb6619fb42a34c689d765ebbdafe8794e18dbce))
* **api:** localize custom connector grant definitions read ([#41079](https://github.com/okou-ai/okou/issues/41079)) ([be7cb05](https://github.com/okou-ai/okou/commit/be7cb053d1cc65d57203c299a1b285d222ce0962)) [#41078](https://github.com/okou-ai/okou/issues/41078)
* **api:** localize custom connector member deletion ([#41075](https://github.com/okou-ai/okou/issues/41075)) ([212eb92](https://github.com/okou-ai/okou/commit/212eb92e03585975eff7664a3b9e91b5336cec6e))
* **api:** localize custom connector runtime reads ([#41016](https://github.com/okou-ai/okou/issues/41016)) ([2ee349d](https://github.com/okou-ai/okou/commit/2ee349d8bf3437552219f895fcfb9cc98a16501f))
* **api:** localize discord typing active run reads ([#41117](https://github.com/okou-ai/okou/issues/41117)) ([2c58144](https://github.com/okou-ai/okou/commit/2c58144bfefdd180bf4b04bf51ddd7f23682d336))
* **api:** localize feishu oauth connection resolution ([#40998](https://github.com/okou-ai/okou/issues/40998)) ([bce45e9](https://github.com/okou-ai/okou/commit/bce45e9c2d66e4d4a64a4e0fcd754c5a2cec190c))
* **api:** localize feishu oauth state write orchestration ([#41099](https://github.com/okou-ai/okou/issues/41099)) ([8be5823](https://github.com/okou-ai/okou/commit/8be5823f79ea34a882898ae644f330c4f42097cb))
* **api:** localize feishu request credential context ([#41128](https://github.com/okou-ai/okou/issues/41128)) ([04666eb](https://github.com/okou-ai/okou/commit/04666eb2ff2d72de204d3f0c1ee4700c1b5884bc))
* **api:** localize image model lookup with its original signal ([#41113](https://github.com/okou-ai/okou/issues/41113)) ([a29af25](https://github.com/okou-ai/okou/commit/a29af256c66bf0da25d47e3e1f01ad05d1d359e8))
* **api:** localize oauth credential contract checks ([#41028](https://github.com/okou-ai/okou/issues/41028)) ([fe06d81](https://github.com/okou-ai/okou/commit/fe06d81a02c4f0367f2894b7990d682524536ad3))
* **api:** localize persisted run source account read ([#41084](https://github.com/okou-ai/okou/issues/41084)) ([a59809a](https://github.com/okou-ai/okou/commit/a59809ad6ea0b285d6e4f74a8371b3e6e9231b6e))
* **api:** localize personal subscription credential bundle reads ([#41116](https://github.com/okou-ai/okou/issues/41116)) ([b997e50](https://github.com/okou-ai/okou/commit/b997e50bceb06ba1291ed24e53d9b393b54aaa0a))
* **api:** localize reconciled usage pack count publication ([#41067](https://github.com/okou-ai/okou/issues/41067)) ([0fd6659](https://github.com/okou-ai/okou/commit/0fd665941eae6c5bbfc692b874ad39ca440b7f7c))
* **api:** localize slack default compose metadata reads ([#41119](https://github.com/okou-ai/okou/issues/41119)) ([8649540](https://github.com/okou-ai/okou/commit/8649540cab5a768e43dd828a0181d409710d0753))
* **api:** localize storage presigned cache read ownership ([#41125](https://github.com/okou-ai/okou/issues/41125)) ([c508f52](https://github.com/okou-ai/okou/commit/c508f52db56e2298c25b46c75c2c808cb667d275)) [#41123](https://github.com/okou-ai/okou/issues/41123)
* **api:** localize usage pack activation org lookup ([#41071](https://github.com/okou-ai/okou/issues/41071)) ([09e06de](https://github.com/okou-ai/okou/commit/09e06decf6df5b9e5c62e2e16483b59951c9d8f5))
* **api:** localize usage pack fulfillment org lookup ([#41077](https://github.com/okou-ai/okou/issues/41077)) ([100b852](https://github.com/okou-ai/okou/commit/100b852f7dbe1406d7a655ecb05045bfb6a5011f))
* **api:** localize workflow automation account resolution ([#41003](https://github.com/okou-ai/okou/issues/41003)) ([222e46d](https://github.com/okou-ai/okou/commit/222e46d1717417535e96bf3e4f7eb3908ec25f2d))
* **api:** pause omitted official blueprints with one update ([#41035](https://github.com/okou-ai/okou/issues/41035)) ([85aa2bb](https://github.com/okou-ai/okou/commit/85aa2bbd21bbbc5c2e8d05aff871573105409d13))
* **api:** retain dormant official identities with one guarded upsert ([#41049](https://github.com/okou-ai/okou/issues/41049)) ([70d45a9](https://github.com/okou-ai/okou/commit/70d45a95b50cc800f747f678aae22e914f724ab2))
* **api:** retire tx-0206 reserved orphan transaction ([#41041](https://github.com/okou-ai/okou/issues/41041)) ([b7c8e00](https://github.com/okou-ai/okou/commit/b7c8e007c2caea5649744227ebad4ba01b2dcda5))
* remove expired teams and discord app compatibility ([#40999](https://github.com/okou-ai/okou/issues/40999)) ([c9de2e1](https://github.com/okou-ai/okou/commit/c9de2e178f18abcdb28ae8048cb8df09909d9b71))
* remove expired telegram legacy callback compatibility ([#41126](https://github.com/okou-ai/okou/issues/41126)) ([d9601cf](https://github.com/okou-ai/okou/commit/d9601cf97f8ff391308971b2706bc3966a202a47))


### Performance Improvements

* reduce sidebar rendering and account fixture setup ([#41061](https://github.com/okou-ai/okou/issues/41061)) ([4a9c48f](https://github.com/okou-ai/okou/commit/4a9c48f9045fb3e3d1cb09d6f08928fbee94e7b7))
* **ts:** reduce artifact preview and schedule fixture work ([#41064](https://github.com/okou-ai/okou/issues/41064)) ([3aae624](https://github.com/okou-ai/okou/commit/3aae624ceecfebef1440acf7b9c3f13bc2f0525c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.573.1
    * @okouai/core bumped to 8.767.1
    * @okouai/db bumped to 1.345.7
    * @okouai/pi-agent-runtime bumped to 1.50.20

## [1.751.0](https://github.com/okou-ai/okou/compare/api-v1.750.4...api-v1.751.0) (2026-10-17)


### Features

* **api:** force app.vm0.ai clients to upgrade to v0.1036.2 ([#40928](https://github.com/okou-ai/okou/issues/40928)) ([cc43b07](https://github.com/okou-ai/okou/commit/cc43b07fa90f7ffc30a689dcc4adc73db0f60f38))
* **vnc:** publish native network setup and canonical metadata ([#40923](https://github.com/okou-ai/okou/issues/40923)) ([5108add](https://github.com/okou-ai/okou/commit/5108add25e7a403e75d73157552d52df7d1e8da0))


### Refactoring

* **api:** build pending queue predicates without database handles ([#40947](https://github.com/okou-ai/okou/issues/40947)) ([a066df7](https://github.com/okou-ai/okou/commit/a066df7080d96c6a0114fe59997a94213dd63670))
* **api:** keep active input source reads with their owners ([#40953](https://github.com/okou-ai/okou/issues/40953)) ([6d28fd8](https://github.com/okou-ai/okou/commit/6d28fd87675d9620a26f5d4d8265b4d2bc63e118))
* **api:** localize chat search candidate and convergence reads ([#40987](https://github.com/okou-ai/okou/issues/40987)) ([f263652](https://github.com/okou-ai/okou/commit/f263652da13935371645b8df04468a7002983a3d)) [#40984](https://github.com/okou-ai/okou/issues/40984)
* **api:** localize discord delivery claim ([#40983](https://github.com/okou-ai/okou/issues/40983)) ([e19fc7b](https://github.com/okou-ai/okou/commit/e19fc7b2f99a2d77b7b427c9a34a88ef0761ca32))
* **api:** localize feishu effective agent reads ([#40925](https://github.com/okou-ai/okou/issues/40925)) ([ce920e1](https://github.com/okou-ai/okou/commit/ce920e1f56b861cc79ee5bab1e35caf8bfff0835))
* **api:** localize feishu installation configuration reads ([#40979](https://github.com/okou-ai/okou/issues/40979)) ([075cca0](https://github.com/okou-ai/okou/commit/075cca014ddbbd2160d97166c7d079f7a267fab8))
* **api:** localize feishu queued launch reads ([#40951](https://github.com/okou-ai/okou/issues/40951)) ([844d634](https://github.com/okou-ai/okou/commit/844d634e8c8afec1737d39970dc31dd6efe031f2))
* **api:** localize morning brief claim settlement ([#40964](https://github.com/okou-ai/okou/issues/40964)) ([c58c664](https://github.com/okou-ai/okou/commit/c58c66498ea29c8b4138a1c99620dec036fd2ad2)) [#40962](https://github.com/okou-ai/okou/issues/40962)
* **api:** localize owned social job reads ([#40970](https://github.com/okou-ai/okou/issues/40970)) ([f41632d](https://github.com/okou-ai/okou/commit/f41632ddd5e173681b2bcac5ce65c0f0cd1592cb))
* **api:** localize queue monitor orchestration ([#40976](https://github.com/okou-ai/okou/issues/40976)) ([043b47f](https://github.com/okou-ai/okou/commit/043b47fc1aa3d58a1755f830f75e624583ef3017))
* **api:** localize snapshot compaction orchestration ([#40982](https://github.com/okou-ai/okou/issues/40982)) ([15aaa59](https://github.com/okou-ai/okou/commit/15aaa599907d1631a4e6d27d34be7f5781410d88))
* **api:** localize thread connector selection upsert ([#40959](https://github.com/okou-ai/okou/issues/40959)) ([3d7d759](https://github.com/okou-ai/okou/commit/3d7d759244a828e18e79b628a83407b696e2006e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.573.0
    * @okouai/core bumped to 8.767.0
    * @okouai/db bumped to 1.345.6
    * @okouai/pi-agent-runtime bumped to 1.50.19

## [1.750.4](https://github.com/okou-ai/okou/compare/api-v1.750.3...api-v1.750.4) (2026-10-17)


### Refactoring

* **api:** localize feishu installation availability reads ([#40901](https://github.com/okou-ai/okou/issues/40901)) ([44163c9](https://github.com/okou-ai/okou/commit/44163c92c6104906b93575f6408541ed60510b4a))
* **api:** localize presigned cache prune ownership ([#40882](https://github.com/okou-ai/okou/issues/40882)) ([9ffbf27](https://github.com/okou-ai/okou/commit/9ffbf27cf0bfcf2978cca1178a2322c63bb8501f))
* **api:** localize skill import reads in existing owners ([#40890](https://github.com/okou-ai/okou/issues/40890)) ([29ad572](https://github.com/okou-ai/okou/commit/29ad572e0a0cb256ac709e46256a9d58c2bc71cf))
* **api:** pass ordinary values into storage input resolution ([#40906](https://github.com/okou-ai/okou/issues/40906)) ([a7fd4ab](https://github.com/okou-ai/okou/commit/a7fd4ab5f8887c35a974710386f4c54143165ec8))
* **api:** pass ordinary values into storage request resolution ([#40915](https://github.com/okou-ai/okou/issues/40915)) ([2a3931f](https://github.com/okou-ai/okou/commit/2a3931fee6a6ec80bbad8ce6407592151805592e))
* **api:** remove database capability from storage plan carriers ([#40909](https://github.com/okou-ai/okou/issues/40909)) ([64374b8](https://github.com/okou-ai/okou/commit/64374b890d460702d1deacb4fba214e0ca5a746e))
* **api:** remove unused database argument from model label helper ([#40894](https://github.com/okou-ai/okou/issues/40894)) ([4a09c86](https://github.com/okou-ai/okou/commit/4a09c86d8b8bef902d75af751b8da650efcac17f))
* **api:** remove unused db arguments from storage manifest helpers ([#40904](https://github.com/okou-ai/okou/issues/40904)) ([2f623ee](https://github.com/okou-ai/okou/commit/2f623ee2690ecb36c3c74961e6063743247b8d56)) [#40903](https://github.com/okou-ai/okou/issues/40903)


### Performance Improvements

* remove thread artifact list refresh paths ([#40912](https://github.com/okou-ai/okou/issues/40912)) ([432a2d9](https://github.com/okou-ai/okou/commit/432a2d9b83ba6770e66fa6d7714ed8bc6adac6e4))

## [1.750.3](https://github.com/okou-ai/okou/compare/api-v1.750.2...api-v1.750.3) (2026-10-17)


### Refactoring

* **db:** retire run credit-admission runtime references ([#40887](https://github.com/okou-ai/okou/issues/40887)) ([c7c05d0](https://github.com/okou-ai/okou/commit/c7c05d0e3c17f7dd4da0f50191983f8a48bb6818))


### Performance Improvements

* resolve chat card posters without thread artifact lists ([#40866](https://github.com/okou-ai/okou/issues/40866)) ([0f32ccb](https://github.com/okou-ai/okou/commit/0f32ccb082949a2af8694f443936d2a0cf32f3eb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.572.5
    * @okouai/core bumped to 8.766.1
    * @okouai/db bumped to 1.345.5
    * @okouai/pi-agent-runtime bumped to 1.50.18

## [1.750.2](https://github.com/okou-ai/okou/compare/api-v1.750.1...api-v1.750.2) (2026-10-17)


### Bug Fixes

* **api:** remove admitted-run credit exemptions ([#40868](https://github.com/okou-ai/okou/issues/40868)) ([57be294](https://github.com/okou-ai/okou/commit/57be2940bcd4fc2b24ad101fabc618c580bbff77))
* **api:** require prepared native vnc app versions ([#40797](https://github.com/okou-ai/okou/issues/40797)) ([d54dba7](https://github.com/okou-ai/okou/commit/d54dba790b8600fa6b834bc49875a5dc79b86560))


### Refactoring

* **api:** localize feishu organization notification reads ([#40869](https://github.com/okou-ai/okou/issues/40869)) ([d0ef659](https://github.com/okou-ai/okou/commit/d0ef6597bcc9c2e5cb1ef4abe844dc6c9bfc9fd9))
* **api:** own presentation template reads in route commands ([#40863](https://github.com/okou-ai/okou/issues/40863)) ([0d74572](https://github.com/okou-ai/okou/commit/0d74572e6676ff37144d0d121642e134f56c1416))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.766.0
    * @okouai/db bumped to 1.345.4
    * @okouai/pi-agent-runtime bumped to 1.50.17

## [1.750.1](https://github.com/okou-ai/okou/compare/api-v1.750.0...api-v1.750.1) (2026-10-17)


### Bug Fixes

* refresh runner platform api and cli release markers ([#40789](https://github.com/okou-ai/okou/issues/40789)) ([8473d96](https://github.com/okou-ai/okou/commit/8473d964e20c44952d93d8a5bf210e65c7d6a794))


### Refactoring

* **api:** keep banking reads in authorization action ([#40795](https://github.com/okou-ai/okou/issues/40795)) ([152dd59](https://github.com/okou-ai/okou/commit/152dd5913be090a566a78e573f07374198aaa706)) [#40793](https://github.com/okou-ai/okou/issues/40793)
* **api:** keep proactive phone identity reads in route commands ([#40779](https://github.com/okou-ai/okou/issues/40779)) ([5fdc1b4](https://github.com/okou-ai/okou/commit/5fdc1b481dbc14987250e8c30a342fd1465eb85b))
* **api:** keep raw row execution in owning units ([#40768](https://github.com/okou-ai/okou/issues/40768)) ([1c26c97](https://github.com/okou-ai/okou/commit/1c26c97926f803e5980f1c40deb988e1620ee6a5))
* **api:** keep telegram retention database ownership local ([#40805](https://github.com/okou-ai/okou/issues/40805)) ([d10f9aa](https://github.com/okou-ai/okou/commit/d10f9aa113efa2dbc44436695209ad1cd33d4ed0))
* **api:** own activity summary database access in commands ([#40799](https://github.com/okou-ai/okou/issues/40799)) ([ed33d81](https://github.com/okou-ai/okou/commit/ed33d8178fe3c0ecca1ce83819df795d2a83a895))
* **api:** own agentphone sender lookup in webhook ([#40776](https://github.com/okou-ai/okou/issues/40776)) ([399dc5b](https://github.com/okou-ai/okou/commit/399dc5b06e9094d35057350fbd43858233850413))
* **api:** own banking connection creation ([#40785](https://github.com/okou-ai/okou/issues/40785)) ([ddf9756](https://github.com/okou-ai/okou/commit/ddf97564051af4a0533feeb70e0891ebebc00225))
* **api:** own default-account runtime wakeups in the route ([#40814](https://github.com/okou-ai/okou/issues/40814)) ([fa5cffa](https://github.com/okou-ai/okou/commit/fa5cffada72e8a0fa0e6f85f8b43eadd17105ff9))
* **api:** own email complaint database access in commands ([#40801](https://github.com/okou-ai/okou/issues/40801)) ([332b2cd](https://github.com/okou-ai/okou/commit/332b2cd4da43a776dae0ce91039808111fcc9d0f))
* **api:** own model preference writes in a private command ([#40830](https://github.com/okou-ai/okou/issues/40830)) ([6e56b68](https://github.com/okou-ai/okou/commit/6e56b68363fa309f3b19e1216fb419f1189b7845)) [#40829](https://github.com/okou-ai/okou/issues/40829)
* **api:** own paid tool preference writes in a command ([#40818](https://github.com/okou-ai/okou/issues/40818)) ([bb82b9e](https://github.com/okou-ai/okou/commit/bb82b9ec9004a4c90cb84b4ec4a83f12cee82ef3))
* **api:** own preference initialization writes in a private command ([#40803](https://github.com/okou-ai/okou/issues/40803)) ([ad65f83](https://github.com/okou-ai/okou/commit/ad65f83b3ec7fb0e6d65f0cb276c66e5d91bd68c))
* **api:** own runner claim and runtime lookup reads ([#40808](https://github.com/okou-ai/okou/issues/40808)) ([d0245c6](https://github.com/okou-ai/okou/commit/d0245c6abf958b7002925903dcfaf0f7e7e2d58e))
* **api:** remove unused agentphone database arguments ([#40782](https://github.com/okou-ai/okou/issues/40782)) ([9aae276](https://github.com/okou-ai/okou/commit/9aae2767374571bcfea9dc0a3f45d799f477520c))
* **api:** remove unused failed chat callback database inputs ([#40827](https://github.com/okou-ai/okou/issues/40827)) ([4a7f4f5](https://github.com/okou-ai/okou/commit/4a7f4f5ad7904ee6e962fc3c4524c9fe42607a48))
* **api:** retire migrated link wallet grant compatibility ([#40783](https://github.com/okou-ai/okou/issues/40783)) ([f52d38a](https://github.com/okou-ai/okou/commit/f52d38a227d7b815b5ce7c5c25764ddf7fd71b0b))
* remove expired deployment compatibility ([#40811](https://github.com/okou-ai/okou/issues/40811)) ([b53e5a5](https://github.com/okou-ai/okou/commit/b53e5a5fc6437b2b15412d21a42d90344c18191f))
* remove remaining expired compatibility from the daily cleanup backlog ([#40820](https://github.com/okou-ai/okou/issues/40820)) ([9ef42db](https://github.com/okou-ai/okou/commit/9ef42db5a3c1c8bfe040a7e41b6aafa6941d4510))


### Performance Improvements

* avoid redundant preview updates and test connector grants ([#40822](https://github.com/okou-ai/okou/issues/40822)) ([60bb4b8](https://github.com/okou-ai/okou/commit/60bb4b86402b77a50cba81bcaa5a81a333c72377))
* defer unused chat context and stabilize ci fixtures ([#40794](https://github.com/okou-ai/okou/issues/40794)) ([302066c](https://github.com/okou-ai/okou/commit/302066cd123a9e02e6a323f983e35648011d5e11))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.572.4
    * @okouai/core bumped to 8.765.2
    * @okouai/db bumped to 1.345.3
    * @okouai/pi-agent-runtime bumped to 1.50.16

## [1.750.0](https://github.com/okou-ai/okou/compare/api-v1.749.2...api-v1.750.0) (2026-10-16)


### Features

* **api:** prepare native vnc private authority ([#40751](https://github.com/okou-ai/okou/issues/40751)) ([a54c5bc](https://github.com/okou-ai/okou/commit/a54c5bc6b847356855e3f99ac3c80ed1621cdd87))


### Bug Fixes

* **wallet:** decouple grant migration from production releases ([#40762](https://github.com/okou-ai/okou/issues/40762)) ([97021db](https://github.com/okou-ai/okou/commit/97021dbcf3994656c219a02139bcfde137904b26))
* **wechat:** resume polling after idle receive deadlines ([#40763](https://github.com/okou-ai/okou/issues/40763)) ([5ef9297](https://github.com/okou-ai/okou/commit/5ef9297f8ee8fd04b5b6b3fe03dfc28c4e4c73f7))


### Refactoring

* **api:** own banking webhook account synchronization ([#40686](https://github.com/okou-ai/okou/issues/40686)) ([49ec347](https://github.com/okou-ai/okou/commit/49ec3475c3dd4650fc233c58d3e98a6310225fff))
* **api:** own github installation deletion cleanup ([#40758](https://github.com/okou-ai/okou/issues/40758)) ([7e09248](https://github.com/okou-ai/okou/commit/7e092481c407dd0af8cd984ff0ec60aefe12397b))

## [1.749.2](https://github.com/okou-ai/okou/compare/api-v1.749.1...api-v1.749.2) (2026-10-16)


### Refactoring

* **api:** own github compose feature-context reads ([#40748](https://github.com/okou-ai/okou/issues/40748)) ([d5d4ef0](https://github.com/okou-ai/okou/commit/d5d4ef0fce0954e38d509c7d17b1307bc60bee8e))

## [1.749.1](https://github.com/okou-ai/okou/compare/api-v1.749.0...api-v1.749.1) (2026-10-16)


### Bug Fixes

* **db:** diagnose opted-in smoke batch timeouts ([#40734](https://github.com/okou-ai/okou/issues/40734)) ([5aa8912](https://github.com/okou-ai/okou/commit/5aa8912feb9790c21d95d74c3bf560ab53e50b67))


### Refactoring

* **api:** own canonical slack completion branches ([#40727](https://github.com/okou-ai/okou/issues/40727)) ([5c41526](https://github.com/okou-ai/okou/commit/5c41526e92d8d4da42f0324902ebeebeaf856a3e))
* **api:** own github user-linking database access ([#40733](https://github.com/okou-ai/okou/issues/40733)) ([f31ff98](https://github.com/okou-ai/okou/commit/f31ff98a23ce18734c3e940df9b798aac92828ff))
* **api:** own stripe bulk projection in its serial loop ([#40730](https://github.com/okou-ai/okou/issues/40730)) ([8a991ef](https://github.com/okou-ai/okou/commit/8a991ef07d510c604858b063d7a2c647b75289d7)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** publish chat model metadata and events atomically ([#40726](https://github.com/okou-ai/okou/issues/40726)) ([a35c72c](https://github.com/okou-ai/okou/commit/a35c72c2878e5cf3eee8ac279095563561c38c19))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.345.2

## [1.749.0](https://github.com/okou-ai/okou/compare/api-v1.748.0...api-v1.749.0) (2026-10-16)


### Features

* **observability:** anchor web chat api_to_* latency at request receipt ([#40705](https://github.com/okou-ai/okou/issues/40705)) ([f9b6521](https://github.com/okou-ai/okou/commit/f9b65211237386971a5e4a4b00c0b7da52b34ab6))


### Bug Fixes

* **api:** prefer public og with bounded slack previews and a personal switch ([#40683](https://github.com/okou-ai/okou/issues/40683)) ([fdaa8bd](https://github.com/okou-ai/okou/commit/fdaa8bdfd023f10eba503b63c099d17224b23c51))
* repair wechat media transfer and conversation context ([#40674](https://github.com/okou-ai/okou/issues/40674)) ([da2141f](https://github.com/okou-ai/okou/commit/da2141fcd53dff04ba8490d99397f3bcba6e7a84))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.572.3
    * @okouai/core bumped to 8.765.1
    * @okouai/db bumped to 1.345.1
    * @okouai/pi-agent-runtime bumped to 1.50.15

## [1.748.0](https://github.com/okou-ai/okou/compare/api-v1.747.1...api-v1.748.0) (2026-10-16)


### Features

* **api:** add wechat reconnect and welcome notices ([#40681](https://github.com/okou-ai/okou/issues/40681)) ([1ee59ba](https://github.com/okou-ai/okou/commit/1ee59ba30a0a33ecbb4d2c0f3362655b64c6a4fe))


### Bug Fixes

* **api:** align wechat reply footers and typing status ([#40679](https://github.com/okou-ai/okou/issues/40679)) ([0f56a28](https://github.com/okou-ai/okou/commit/0f56a28b157cf43b9770238ba1ff501f7fb77df7))


### Refactoring

* **api:** own browser user-action creation persistence ([#40701](https://github.com/okou-ai/okou/issues/40701)) ([a9801dd](https://github.com/okou-ai/okou/commit/a9801dd83cfe088ab97fb8cbb5874394e2ededcd))
* **api:** own canonical slack prepare read in its command ([#40695](https://github.com/okou-ai/okou/issues/40695)) ([7cf0612](https://github.com/okou-ai/okou/commit/7cf06121f2c2e7af9d3d81edb2b2523284485280))
* **api:** own connected teams user read in target command ([#40675](https://github.com/okou-ai/okou/issues/40675)) ([5b6076e](https://github.com/okou-ai/okou/commit/5b6076ee66b32eca7d1cb6a4bed44ead98ccf1ee))
* **api:** own subscription preview billing read ([#40697](https://github.com/okou-ai/okou/issues/40697)) ([dae07a4](https://github.com/okou-ai/okou/commit/dae07a44c1e37343ce2d1dca5163333ad7c687a2)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** retire tx-0230 prepared-work validation transaction ([#40687](https://github.com/okou-ai/okou/issues/40687)) ([4c26006](https://github.com/okou-ai/okou/commit/4c2600620a2743af42299698506467ba54f1119c)) [#40676](https://github.com/okou-ai/okou/issues/40676)
* **api:** use captured thread attribution for chat usage ([#40682](https://github.com/okou-ai/okou/issues/40682)) ([e6c4c5e](https://github.com/okou-ai/okou/commit/e6c4c5e4beed1c53bc03f3f5956ea6144b858d8d))
* **wallet:** migrate and require link grant metadata ([#40627](https://github.com/okou-ai/okou/issues/40627)) ([86adc57](https://github.com/okou-ai/okou/commit/86adc578e06477316a04b479d7c30043264f3e9c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.572.2
    * @okouai/core bumped to 8.765.0
    * @okouai/db bumped to 1.345.0
    * @okouai/pi-agent-runtime bumped to 1.50.14

## [1.747.1](https://github.com/okou-ai/okou/compare/api-v1.747.0...api-v1.747.1) (2026-10-16)


### Bug Fixes

* **wallet:** unify link consent and show actual transactions ([#40650](https://github.com/okou-ai/okou/issues/40650)) ([16fa1cc](https://github.com/okou-ai/okou/commit/16fa1cc1386dd8fcb6f32c789693b98af25f0d13))


### Refactoring

* **api:** own canonical slack completion read ([#40640](https://github.com/okou-ai/okou/issues/40640)) ([1b1f028](https://github.com/okou-ai/okou/commit/1b1f0288c221933d8057f4ec080dcaa7ecbc44ef)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own claude legacy account identity preparation ([#40635](https://github.com/okou-ai/okou/issues/40635)) ([99d1afb](https://github.com/okou-ai/okou/commit/99d1afb86781b6987be45c77fd90182872c8564a))
* **api:** own remote github installation association ([#40608](https://github.com/okou-ai/okou/issues/40608)) ([4207276](https://github.com/okou-ai/okou/commit/4207276a7292b3ad5a53d97d435f3dec44822324))
* **api:** own stripe projection account reads ([#40636](https://github.com/okou-ai/okou/issues/40636)) ([9ef7111](https://github.com/okou-ai/okou/commit/9ef71111d1ba7e0c094fc93fb36f95ed3d974de2)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** retire canceled plan projection transaction ([#40631](https://github.com/okou-ai/okou/issues/40631)) ([0c8b8be](https://github.com/okou-ai/okou/commit/0c8b8be01eb85e319241da270c1927d30713d302))
* **db:** release legacy history retains in committed batches ([#40632](https://github.com/okou-ai/okou/issues/40632)) ([f1b08e9](https://github.com/okou-ai/okou/commit/f1b08e9f97994ee535e7ab6e5d4d887889dce65b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.572.1
    * @okouai/connectors bumped to 3.16.9
    * @okouai/core bumped to 8.764.2
    * @okouai/db bumped to 1.344.1
    * @okouai/pi-agent-runtime bumped to 1.50.13

## [1.747.0](https://github.com/okou-ai/okou/compare/api-v1.746.0...api-v1.747.0) (2026-10-16)


### Features

* add wechat cli history and file delivery ([#40385](https://github.com/okou-ai/okou/issues/40385)) ([a1f8a0e](https://github.com/okou-ai/okou/commit/a1f8a0e02166de9dae893adbd2ce60e01704b633))


### Bug Fixes

* **api:** simplify pinned document template prompts ([#40574](https://github.com/okou-ai/okou/issues/40574)) ([7657e16](https://github.com/okou-ai/okou/commit/7657e16141fcb2950e60d39a176ba9e559432319))


### Refactoring

* **api:** own github installation lookup and callback linking ([#40581](https://github.com/okou-ai/okou/issues/40581)) ([74b4374](https://github.com/okou-ai/okou/commit/74b4374d119ccb25a4e34d4980a6ef775b71d7ea))
* **api:** own github installation status reads ([#40590](https://github.com/okou-ai/okou/issues/40590)) ([c12450f](https://github.com/okou-ai/okou/commit/c12450fa5c2bb0a7af48ad37af785730e17bced9))
* **api:** remove redundant ssh authority and retained config read fences ([#40559](https://github.com/okou-ai/okou/issues/40559)) ([2328ec5](https://github.com/okou-ai/okou/commit/2328ec5e765347cb5ac057467053604870660243))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.572.0
    * @okouai/core bumped to 8.764.1
    * @okouai/db bumped to 1.344.0
    * @okouai/pi-agent-runtime bumped to 1.50.12

## [1.746.0](https://github.com/okou-ai/okou/compare/api-v1.745.0...api-v1.746.0) (2026-10-16)


### Features

* **api-contracts:** compare non-2xx desktop response bodies in the contract gate ([#40556](https://github.com/okou-ai/okou/issues/40556)) ([57cee1c](https://github.com/okou-ai/okou/commit/57cee1ccc9fc950fae97e75664362d5539273ee0)) [#40554](https://github.com/okou-ai/okou/issues/40554)
* **cli:** explain ssh failures with runner-authored text ([#40458](https://github.com/okou-ai/okou/issues/40458)) ([bbe622b](https://github.com/okou-ai/okou/commit/bbe622bafeb596d96eb7009e21954d649c279377))


### Refactoring

* **api:** own github app installation activation ([#40558](https://github.com/okou-ai/okou/issues/40558)) ([bfe7a23](https://github.com/okou-ai/okou/commit/bfe7a23852dacdb20b2c73a1a564f8d4f9de6172))
* **api:** own subscription confirmation billing read ([#40567](https://github.com/okou-ai/okou/issues/40567)) ([5e621e4](https://github.com/okou-ai/okou/commit/5e621e4f1eee9e80c5c9a8b65281733a1cedd7cc)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **ci:** decouple api from cli package publication ([#40530](https://github.com/okou-ai/okou/issues/40530)) ([47a09bd](https://github.com/okou-ai/okou/commit/47a09bdbceef594fc874636b73c6b0446153677c))
* remove copper connector feature switch ([#40571](https://github.com/okou-ai/okou/issues/40571)) ([15c0034](https://github.com/okou-ai/okou/commit/15c003404a43e8a84da32110368cb89172f397e4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.571.0
    * @okouai/core bumped to 8.764.0
    * @okouai/db bumped to 1.343.1
    * @okouai/pi-agent-runtime bumped to 1.50.11

## [1.745.0](https://github.com/okou-ai/okou/compare/api-v1.744.0...api-v1.745.0) (2026-10-16)


### Features

* add workspace-scoped link wallets and transaction history ([#40192](https://github.com/okou-ai/okou/issues/40192)) ([12a55d1](https://github.com/okou-ai/okou/commit/12a55d1c8892076fbb608eb3116573e7011c060a))
* **vnc:** prepare additive native network storage ([#40524](https://github.com/okou-ai/okou/issues/40524)) ([4fa07c7](https://github.com/okou-ai/okou/commit/4fa07c7f092a0f1cae99d8297d58834cc1258ccf))


### Bug Fixes

* **api:** retry transient google sheets token refresh failures ([#40522](https://github.com/okou-ai/okou/issues/40522)) ([8f79d3c](https://github.com/okou-ai/okou/commit/8f79d3cb72a3773a8502e68ba3f437718a222dbf))
* **slack:** finish app home settings link migration ([#40541](https://github.com/okou-ai/okou/issues/40541)) ([03a4b0a](https://github.com/okou-ai/okou/commit/03a4b0a8f269e72e87e576762d87ab3f207c0cea))


### Refactoring

* **api:** own allocation confirmation billing read ([#40527](https://github.com/okou-ai/okou/issues/40527)) ([088c8e6](https://github.com/okou-ai/okou/commit/088c8e69bb01d0097e97229917dadfb7dc6819ac)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own banking connection management reads ([#40519](https://github.com/okou-ai/okou/issues/40519)) ([c559abc](https://github.com/okou-ai/okou/commit/c559abc8fd545b5efaf9026a4441a0ec8d39ac4b))
* **api:** remove billing thread run fallback ([#40534](https://github.com/okou-ai/okou/issues/40534)) ([fa2fb32](https://github.com/okou-ai/okou/commit/fa2fb32ab1bc227e6d000890f1826c6e2a7059b8))
* retire session history archive protocol ([#40528](https://github.com/okou-ai/okou/issues/40528)) ([1e9a4cf](https://github.com/okou-ai/okou/commit/1e9a4cf4fa6fb43dad8fad1caedc480df0ef7a41))


### Performance Improvements

* **api:** deduplicate discord prompt authorization reads ([#40359](https://github.com/okou-ai/okou/issues/40359)) ([3f70796](https://github.com/okou-ai/okou/commit/3f70796bc72458da61ee858d484c2ccaeba98b4d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.570.0
    * @okouai/core bumped to 8.763.0
    * @okouai/db bumped to 1.343.0
    * @okouai/pi-agent-runtime bumped to 1.50.10

## [1.744.0](https://github.com/okou-ai/okou/compare/api-v1.743.2...api-v1.744.0) (2026-10-16)


### Features

* add interactive desktop shell sessions ([#40349](https://github.com/okou-ai/okou/issues/40349)) ([6dda0aa](https://github.com/okou-ai/okou/commit/6dda0aad6903feb490f88cd11db2145b140dfd1d))


### Refactoring

* **api:** retire the stage 1 reconciliation transaction ([#40512](https://github.com/okou-ai/okou/issues/40512)) ([8cc8bda](https://github.com/okou-ai/okou/commit/8cc8bda30955144ae697d2ba8b8e5a967d7f212b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.569.0
    * @okouai/core bumped to 8.762.0
    * @okouai/db bumped to 1.342.3
    * @okouai/pi-agent-runtime bumped to 1.50.9

## [1.743.2](https://github.com/okou-ai/okou/compare/api-v1.743.1...api-v1.743.2) (2026-10-16)


### Refactoring

* **api:** own allocation preview billing read ([#40484](https://github.com/okou-ai/okou/issues/40484)) ([2efbad9](https://github.com/okou-ai/okou/commit/2efbad9ffe46cfd736224105bd1bbc330035cfba)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** retire tx-0212 removed automation transaction ([#40490](https://github.com/okou-ai/okou/issues/40490)) ([2b2cbb7](https://github.com/okou-ai/okou/commit/2b2cbb776bc9bd59b8e37247676cd52fcd0edac7))
* **api:** retire tx-0221 failed maintenance transaction ([#40486](https://github.com/okou-ai/okou/issues/40486)) ([05c2553](https://github.com/okou-ai/okou/commit/05c2553c8493f46c8e8ce1384516e93d22425ae3))
* own stripe delivery projection repair ([#40487](https://github.com/okou-ai/okou/issues/40487)) ([333851a](https://github.com/okou-ai/okou/commit/333851a6a6ed7490bb993a3080a6f01a37ad666e)) [#37510](https://github.com/okou-ai/okou/issues/37510)

## [1.743.1](https://github.com/okou-ai/okou/compare/api-v1.743.0...api-v1.743.1) (2026-10-15)


### Refactoring

* **api:** inline stripe ingress repair in its command owner ([#40473](https://github.com/okou-ai/okou/issues/40473)) ([e916b76](https://github.com/okou-ai/okou/commit/e916b760ab4f72205e5b5ac9059ee3893e5df356))
* **api:** keep usage pack purchase snapshot reads in their command ([#40479](https://github.com/okou-ai/okou/issues/40479)) ([a76d111](https://github.com/okou-ai/okou/commit/a76d1117faccf84124fdaf727184f30c80044661))
* **api:** own banking access authorization and audits ([#40463](https://github.com/okou-ai/okou/issues/40463)) ([80df87b](https://github.com/okou-ai/okou/commit/80df87b6aee35bfd35bbe3808c84852e16c56677))
* **api:** own chat thread connector selection clearing ([#40431](https://github.com/okou-ai/okou/issues/40431)) ([2e03abb](https://github.com/okou-ai/okou/commit/2e03abbfda7f9223ee3119f10af6dad0ae4e0ae6))
* **api:** own github installation id reads ([#40457](https://github.com/okou-ai/okou/issues/40457)) ([4932b2c](https://github.com/okou-ai/okou/commit/4932b2c99febbbcfc3f1905a28d636b5f871c7f3))
* **api:** own scheduled package reads in invoice command ([#40465](https://github.com/okou-ai/okou/issues/40465)) ([bd00c60](https://github.com/okou-ai/okou/commit/bd00c60f347bf75cbae9c94605acf9ddc40bca5c)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own telegram model read in computed ([#40478](https://github.com/okou-ai/okou/issues/40478)) ([d4b3517](https://github.com/okou-ai/okou/commit/d4b35175f0d24a3e1d6a797820026f2b29648046))
* **api:** separate runtime catalog snapshot materialization ([#40372](https://github.com/okou-ai/okou/issues/40372)) ([d2d4fb1](https://github.com/okou-ai/okou/commit/d2d4fb19ec4aa1bd4cb9a606d9ba5b96a822c640))


### Performance Improvements

* trim composer rendering and connector fixture work ([#40474](https://github.com/okou-ai/okou/issues/40474)) ([6e989ed](https://github.com/okou-ai/okou/commit/6e989ed0aa8beffbf9969284545dedfbd5aaeabc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.342.2

## [1.743.0](https://github.com/okou-ai/okou/compare/api-v1.742.0...api-v1.743.0) (2026-10-15)


### Features

* **cli:** retain same-run ssh and vnc failure diagnostics ([#40358](https://github.com/okou-ai/okou/issues/40358)) ([4e5cd58](https://github.com/okou-ai/okou/commit/4e5cd5836d1f051a85ca076d170cc2e30e3a8177))


### Bug Fixes

* **api:** send private telegram connect links to settings ([#40384](https://github.com/okou-ai/okou/issues/40384)) ([d48569c](https://github.com/okou-ai/okou/commit/d48569cbcb44041a9d368e3e818b40378d55edc5))
* **api:** use read dependencies for invoice preparation ([#40439](https://github.com/okou-ai/okou/issues/40439)) ([b01d7cc](https://github.com/okou-ai/okou/commit/b01d7ccf3dda207075f1ad73adcb218528c89676))
* **slack:** stage uninstalled app home links for compatible rollout ([#40389](https://github.com/okou-ai/okou/issues/40389)) ([655d20e](https://github.com/okou-ai/okou/commit/655d20e6a0708a83af97cbc6dcc14ea7f60dae69))


### Refactoring

* **api:** inline runtime slug catalog reads ([#40387](https://github.com/okou-ai/okou/issues/40387)) ([dfa3c05](https://github.com/okou-ai/okou/commit/dfa3c05b488b82a07e27f6853b9c6d6918480ee8))
* **api:** inline stripe projection owner lookup ([#40370](https://github.com/okou-ai/okou/issues/40370)) ([4cbe330](https://github.com/okou-ai/okou/commit/4cbe330e6c076a653e6d59ea0bc18e6c4530ac64))
* **api:** inline stripe reprojection credential reads ([#40398](https://github.com/okou-ai/okou/issues/40398)) ([df566d0](https://github.com/okou-ai/okou/commit/df566d04e71357ca1743957802d5a2b216823e20))
* **api:** keep plan replacement read in its transaction owner ([#40395](https://github.com/okou-ai/okou/issues/40395)) ([5663b52](https://github.com/okou-ai/okou/commit/5663b52d9238151c283a0b7375792df2e4096737))
* **api:** own connector connect-item catalog reads ([#40380](https://github.com/okou-ai/okou/issues/40380)) ([e47ca21](https://github.com/okou-ai/okou/commit/e47ca212140671344313b27f331f23c98c9fc735))
* **api:** own feishu account mutation intent reads ([#40402](https://github.com/okou-ai/okou/issues/40402)) ([97387cb](https://github.com/okou-ai/okou/commit/97387cb319918bbf5d612e3e8ee77a0894b81e98))
* **api:** own github active installation reads ([#40413](https://github.com/okou-ai/okou/issues/40413)) ([4462bd8](https://github.com/okou-ai/okou/commit/4462bd837ef188603555f8ea352b3c66b7679738))
* **api:** own github user oauth state creation ([#40424](https://github.com/okou-ai/okou/issues/40424)) ([e3aa419](https://github.com/okou-ai/okou/commit/e3aa419ac0847d9338e78f2b0e3bc9c66a10d787))
* **api:** own telegram agent label read in computed ([#40407](https://github.com/okou-ai/okou/issues/40407)) ([ec7c422](https://github.com/okou-ai/okou/commit/ec7c4225bcf6844d7582b6e01c132a0765b84eb2))
* **api:** publish connector refresh in one statement ([#40406](https://github.com/okou-ai/okou/issues/40406)) ([d26f430](https://github.com/okou-ai/okou/commit/d26f4303daf0e6adf0786b847478a830cd63132d))
* **api:** retire tx-0271 upgrade invoice transaction ([#40415](https://github.com/okou-ai/okou/issues/40415)) ([c8d3356](https://github.com/okou-ai/okou/commit/c8d3356ae343d0e5207aca54224664d5b6d6012e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.568.0
    * @okouai/core bumped to 8.761.0
    * @okouai/db bumped to 1.342.1
    * @okouai/pi-agent-runtime bumped to 1.50.8

## [1.742.0](https://github.com/okou-ai/okou/compare/api-v1.741.2...api-v1.742.0) (2026-10-15)


### Features

* connect wechat from works with qr pairing ([#40373](https://github.com/okou-ai/okou/issues/40373)) ([116a68f](https://github.com/okou-ai/okou/commit/116a68fc8f66048e7d80593c3bf303a7475f409a))
* **vnc:** prepare native network contracts and readers ([#40316](https://github.com/okou-ai/okou/issues/40316)) ([ea3aa10](https://github.com/okou-ai/okou/commit/ea3aa10c7fa4fce02f776752a904c4cca8b43f7e))


### Bug Fixes

* **app:** reconcile teams connection completion and entry flows ([#40366](https://github.com/okou-ai/okou/issues/40366)) ([6c2075b](https://github.com/okou-ai/okou/commit/6c2075b4f81a94c1ee22f4b67bbb25aff1d6bbe6)) [#40196](https://github.com/okou-ai/okou/issues/40196)
* expire computer use command data after three days ([#40356](https://github.com/okou-ai/okou/issues/40356)) ([da99c9b](https://github.com/okou-ai/okou/commit/da99c9b582347fdc4aaea9a17ff6f880dc6f46ac))
* **slack:** reconcile canonical connection journeys ([#40347](https://github.com/okou-ai/okou/issues/40347)) ([d521a3b](https://github.com/okou-ai/okou/commit/d521a3b4b5843220237c5676529904fb4f1c5c49))


### Refactoring

* **api:** inline connector account resolution queries ([#40335](https://github.com/okou-ai/okou/issues/40335)) ([035bd69](https://github.com/okou-ai/okou/commit/035bd69c8bf06219a2df1727e7ea98a44b55c038))
* **api:** inline custom connector credential upserts ([#40365](https://github.com/okou-ai/okou/issues/40365)) ([a8a1f5e](https://github.com/okou-ai/okou/commit/a8a1f5e3bac43a37f487b60c606fd2b51f5c656f))
* **api:** inline runtime authentication catalog reads ([#40343](https://github.com/okou-ai/okou/issues/40343)) ([eead57c](https://github.com/okou-ai/okou/commit/eead57c73de69e68ec179c1fd4fd0106818e2018))
* **api:** retire tx-0199 reconfiguration transaction ([#40354](https://github.com/okou-ai/okou/issues/40354)) ([9269bc4](https://github.com/okou-ai/okou/commit/9269bc48f327f1da17e2faa44668cf5fa62998b4))
* **api:** retire tx-0200 with atomic configuration pause ([#40362](https://github.com/okou-ai/okou/issues/40362)) ([1d23814](https://github.com/okou-ai/okou/commit/1d2381442a25bdbfa82e9dca9ad8a3831e0a0cc2))
* **api:** retire tx-0203 official failure projection transaction ([#40352](https://github.com/okou-ai/okou/issues/40352)) ([c852cac](https://github.com/okou-ai/okou/commit/c852cac0dd94c2444368b88d0d328bc7b02eea85))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.567.0
    * @okouai/core bumped to 8.760.0
    * @okouai/db bumped to 1.342.0
    * @okouai/pi-agent-runtime bumped to 1.50.7

## [1.741.2](https://github.com/okou-ai/okou/compare/api-v1.741.1...api-v1.741.2) (2026-10-15)


### Bug Fixes

* **api:** protect teams identity binding and prepare completion status ([#40308](https://github.com/okou-ai/okou/issues/40308)) ([182c50a](https://github.com/okou-ai/okou/commit/182c50abdb229c40c210199b7de2e4d948ade6ba))


### Refactoring

* **api:** inline connector storage cleanup ([#40323](https://github.com/okou-ai/okou/issues/40323)) ([f9f0aaf](https://github.com/okou-ai/okou/commit/f9f0aaff7b27c424ee3372024dccc0359423564c))
* **api:** inline connector-owned credential upserts ([#40307](https://github.com/okou-ai/okou/issues/40307)) ([00019cb](https://github.com/okou-ai/okou/commit/00019cbcc88564429621d5e9fce757e394587d2b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.566.2
    * @okouai/core bumped to 8.759.3
    * @okouai/db bumped to 1.341.2
    * @okouai/pi-agent-runtime bumped to 1.50.6

## [1.741.1](https://github.com/okou-ai/okou/compare/api-v1.741.0...api-v1.741.1) (2026-10-15)


### Refactoring

* **pi:** always use the runner-bundled cli ([#40232](https://github.com/okou-ai/okou/issues/40232)) ([dfff160](https://github.com/okou-ai/okou/commit/dfff1605013103371cd90962ee5b54c80fc93140))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.566.1
    * @okouai/core bumped to 8.759.2
    * @okouai/db bumped to 1.341.1
    * @okouai/pi-agent-runtime bumped to 1.50.5

## [1.741.0](https://github.com/okou-ai/okou/compare/api-v1.740.2...api-v1.741.0) (2026-10-15)


### Features

* **api:** prepare opt-in telegram callback bridge ([#40219](https://github.com/okou-ai/okou/issues/40219)) ([e4c5d37](https://github.com/okou-ai/okou/commit/e4c5d37ad3a84ff846f43a13c29f3078393874ff))
* **ssh:** support tailscale ssh with saved networks ([#40212](https://github.com/okou-ai/okou/issues/40212)) ([31db119](https://github.com/okou-ai/okou/commit/31db1195d86e33e52a576e0b50286312366d198e))


### Bug Fixes

* **api:** deduplicate discord ingress reads and start typing earlier ([#40256](https://github.com/okou-ai/okou/issues/40256)) ([b232713](https://github.com/okou-ai/okou/commit/b232713ddddd39a02e142b741d28a45e6fa5e6ee))
* **api:** use clerk m2m authorization for atom grants ([#40252](https://github.com/okou-ai/okou/issues/40252)) ([f837ead](https://github.com/okou-ai/okou/commit/f837ead8511336f568009e38924e01adfb351002))
* **chat:** give thread muting feedback, header entry points and a clean unmute ([#40253](https://github.com/okou-ai/okou/issues/40253)) ([59d7408](https://github.com/okou-ai/okou/commit/59d74089e1e28403b00b04f2aeef146a5f448333))
* **maps:** log citation validation failure reasons ([#40203](https://github.com/okou-ai/okou/issues/40203)) ([66b5dea](https://github.com/okou-ai/okou/commit/66b5dea710f3fe85e40a04282d8b1a5d693252b4))


### Refactoring

* **api:** narrow invitation payment publication transaction ([#40216](https://github.com/okou-ai/okou/issues/40216)) ([a44cee5](https://github.com/okou-ai/okou/commit/a44cee5a4133e6c3edaab212e3d9ae8b3e6707b6))
* **api:** own browser user-action maintenance in commands ([#40264](https://github.com/okou-ai/okou/issues/40264)) ([468bad3](https://github.com/okou-ai/okou/commit/468bad381bd1dd84a29ca0be0fc4b386f1fde428))
* **api:** own feishu connection status reads ([#40247](https://github.com/okou-ai/okou/issues/40247)) ([8f0d719](https://github.com/okou-ai/okou/commit/8f0d719e0de025aab5b0e026fc5344deea59ad2e))
* **api:** own management reads and diagnose preview build identity ([#39515](https://github.com/okou-ai/okou/issues/39515)) ([d66780f](https://github.com/okou-ai/okou/commit/d66780f2e6e74546791e45cb7177cbc1e3ac2e86))
* **api:** remove dead pi resume session plumbing ([#40257](https://github.com/okou-ai/okou/issues/40257)) ([8afbe4e](https://github.com/okou-ai/okou/commit/8afbe4e727a6c593b12abadc40fa54b1c6500a95))
* **api:** remove unused official workflow parameter overrides ([#40248](https://github.com/okou-ai/okou/issues/40248)) ([7932be8](https://github.com/okou-ai/okou/commit/7932be8124317db49285a683303b8a2fb507acf3))
* **api:** retire usage pack confirmation preparation transaction ([#40242](https://github.com/okou-ai/okou/issues/40242)) ([0981ebb](https://github.com/okou-ai/okou/commit/0981ebb46fdfc526636e83fd16167ae4405e093d))
* **runner:** consolidate home reuse observations ([#40207](https://github.com/okou-ai/okou/issues/40207)) ([2511826](https://github.com/okou-ai/okou/commit/25118260fc61ef6317a98dda0194b0fb9a11f5fa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.566.0
    * @okouai/core bumped to 8.759.1
    * @okouai/db bumped to 1.341.0
    * @okouai/pi-agent-runtime bumped to 1.50.4

## [1.740.2](https://github.com/okou-ai/okou/compare/api-v1.740.1...api-v1.740.2) (2026-10-15)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.565.0
    * @okouai/core bumped to 8.759.0
    * @okouai/db bumped to 1.340.4
    * @okouai/pi-agent-runtime bumped to 1.50.3

## [1.740.1](https://github.com/okou-ai/okou/compare/api-v1.740.0...api-v1.740.1) (2026-10-15)


### Refactoring

* **api:** retire concurrency projection transaction (tx-0328) ([#40202](https://github.com/okou-ai/okou/issues/40202)) ([588e07a](https://github.com/okou-ai/okou/commit/588e07a88bd8f0a6534453084febdc9ef337d0f0))

## [1.740.0](https://github.com/okou-ai/okou/compare/api-v1.739.0...api-v1.740.0) (2026-10-15)


### Features

* **api:** accept subscription grants from atom ([#40179](https://github.com/okou-ai/okou/issues/40179)) ([b4e4443](https://github.com/okou-ai/okou/commit/b4e444385ab8f7865b3a867db545308fe51e448b))


### Bug Fixes

* **db:** batch session runtime migration backfills ([#40197](https://github.com/okou-ai/okou/issues/40197)) ([3026e8b](https://github.com/okou-ai/okou/commit/3026e8bf4ce8bb45115425199a12ecc88282eb47))


### Refactoring

* **api:** own teams download reads and strict fixture cleanup ([#40120](https://github.com/okou-ai/okou/issues/40120)) ([6ab4cec](https://github.com/okou-ai/okou/commit/6ab4cec95799993f8f5f678c619bfc4670ecdd3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.564.0
    * @okouai/core bumped to 8.758.2
    * @okouai/db bumped to 1.340.3
    * @okouai/pi-agent-runtime bumped to 1.50.2

## [1.739.0](https://github.com/okou-ai/okou/compare/api-v1.738.1...api-v1.739.0) (2026-10-15)


### Features

* **runner:** record cache routing and inventory outcomes ([#40171](https://github.com/okou-ai/okou/issues/40171)) ([8d94f8f](https://github.com/okou-ai/okou/commit/8d94f8f0b601173b3fe6cb5431f48cb916959226))


### Refactoring

* **api:** decide native continuation once in the thread context ([#40187](https://github.com/okou-ai/okou/issues/40187)) ([9fac915](https://github.com/okou-ai/okou/commit/9fac915cc2fcaa3abd70af4581a3e602437cb90c))
* **api:** fold chat relation writes into atomic ctes ([#40174](https://github.com/okou-ai/okou/issues/40174)) ([378510b](https://github.com/okou-ai/okou/commit/378510be8524fe9b2f428f06a3786fb7523308c0))
* **api:** own feishu installation configuration writes ([#40183](https://github.com/okou-ai/okou/issues/40183)) ([91f69b9](https://github.com/okou-ai/okou/commit/91f69b937d0d22a2d3c12dff7f47a27348a15c23))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.563.0
    * @okouai/core bumped to 8.758.1
    * @okouai/db bumped to 1.340.2
    * @okouai/pi-agent-runtime bumped to 1.50.1

## [1.738.1](https://github.com/okou-ai/okou/compare/api-v1.738.0...api-v1.738.1) (2026-10-15)


### Bug Fixes

* **api:** retain safe snapshot download failure diagnostics ([#40169](https://github.com/okou-ai/okou/issues/40169)) ([2f36d58](https://github.com/okou-ai/okou/commit/2f36d58d23dc26c17283f1c22e746e755d526327))


### Refactoring

* **api:** own bundled connector skill registration ([#40168](https://github.com/okou-ai/okou/issues/40168)) ([803c583](https://github.com/okou-ai/okou/commit/803c583d71ca5b5aee6220bc26434b09542ab6e2))
* **api:** own personal subscription usage refresh actions ([#40163](https://github.com/okou-ai/okou/issues/40163)) ([1247252](https://github.com/okou-ai/okou/commit/1247252e8ab7efcd22849bf180c9c80bad06aaa1))
* **api:** replace clerk deletion erasure with scoped work stopping ([#40061](https://github.com/okou-ai/okou/issues/40061)) ([b559ee4](https://github.com/okou-ai/okou/commit/b559ee4c7134c903d035fa9f1d15ae75f74bef3d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.340.1

## [1.738.0](https://github.com/okou-ai/okou/compare/api-v1.737.0...api-v1.738.0) (2026-10-15)


### Features

* add built-in document templates ([#40052](https://github.com/okou-ai/okou/issues/40052)) ([987e011](https://github.com/okou-ai/okou/commit/987e0110410c5019842c26411306736b69fe4def))
* add google docs and sheets artifact conversion ([#40019](https://github.com/okou-ai/okou/issues/40019)) ([9d83ecd](https://github.com/okou-ai/okou/commit/9d83ecdba2060f7f121c00426259e01c82f659a2))
* continue threads through retained native sandbox history ([#40048](https://github.com/okou-ai/okou/issues/40048)) ([2b6ff73](https://github.com/okou-ai/okou/commit/2b6ff735fcfb0d4f5baf5fd131bcc10ae8a325d3))
* **runner:** record first-run context and actual home reuse ([#39955](https://github.com/okou-ai/okou/issues/39955)) ([f0577eb](https://github.com/okou-ai/okou/commit/f0577ebc54bdb82e28c225184a7a084080054afd))
* **runner:** record home outcomes through sandbox operations ([#40086](https://github.com/okou-ai/okou/issues/40086)) ([4118750](https://github.com/okou-ai/okou/commit/4118750fb48f30654288719da44c30ae8dc08a68))


### Bug Fixes

* **api:** enforce supplied ssh and vnc deletion versions ([#40082](https://github.com/okou-ai/okou/issues/40082)) ([9f319f1](https://github.com/okou-ai/okou/commit/9f319f1595f6137053de1a4a0d2244a18f7751f3))
* **api:** resolve concurrent discord oauth account connections ([#40076](https://github.com/okou-ai/okou/issues/40076)) ([f4aa6cb](https://github.com/okou-ai/okou/commit/f4aa6cb16b755902a7c5d52d2341fc2a2c5126e4))
* derive morning brief email keys from the automation event ([#40150](https://github.com/okou-ai/okou/issues/40150)) ([a21f35f](https://github.com/okou-ai/okou/commit/a21f35f72ad8d175d5c1a76b18ddf07a3b9b48ce))
* **workflows:** make official workflows internal-only and remove their switch ([#40056](https://github.com/okou-ai/okou/issues/40056)) ([6c9dc4e](https://github.com/okou-ai/okou/commit/6c9dc4e67ad60faf5ce6020c185899cb59a93bc9))


### Refactoring

* **api:** own builtin connector stored-detail reads ([#40064](https://github.com/okou-ai/okou/issues/40064)) ([2a970b8](https://github.com/okou-ai/okou/commit/2a970b81c0684a70b7092a5d5f9b27b4ff694faf))
* **api:** own connector account batch and thread reads ([#40081](https://github.com/okou-ai/okou/issues/40081)) ([f3e9688](https://github.com/okou-ai/okou/commit/f3e9688ab682fdfe46cff94d61c1631891f4cd33))
* **api:** own connector network-policy refresh reads ([#40093](https://github.com/okou-ai/okou/issues/40093)) ([8b85314](https://github.com/okou-ai/okou/commit/8b85314dd379986511f006d5e68adc2bf6bf14b1))
* **api:** own runner builtin firewall catalog reads ([#40130](https://github.com/okou-ai/okou/issues/40130)) ([a588385](https://github.com/okou-ai/okou/commit/a588385223593f149229dbf19c28621bb9396be9))
* **api:** own runtime connector account identity reads ([#40113](https://github.com/okou-ai/okou/issues/40113)) ([0100cec](https://github.com/okou-ai/okou/commit/0100cec285c44d2a26e53446605ba46d50e0278d))
* **api:** own stored connector cleanup reads ([#40105](https://github.com/okou-ai/okou/issues/40105)) ([bf474a7](https://github.com/okou-ai/okou/commit/bf474a74b287f0773d3483e03df2803789fd7335))
* **api:** own teams target resolution in a command ([#40072](https://github.com/okou-ai/okou/issues/40072)) ([848560b](https://github.com/okou-ai/okou/commit/848560b0d73f11a25b6c0d260aae302be00f0bfa))
* **api:** retire journaled activation metadata transaction ([#40123](https://github.com/okou-ai/okou/issues/40123)) ([dcc3524](https://github.com/okou-ai/okou/commit/dcc3524dca333ddd0293df77f929fbdb8ffa5d8d))
* retire legacy run reuse outcome metadata ([#40102](https://github.com/okou-ai/okou/issues/40102)) ([005af49](https://github.com/okou-ai/okou/commit/005af4965ced3ca60293140d6ede62ec5acaeaeb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.562.0
    * @okouai/core bumped to 8.758.0
    * @okouai/db bumped to 1.340.0
    * @okouai/pi-agent-runtime bumped to 1.50.0

## [1.737.0](https://github.com/okou-ai/okou/compare/api-v1.736.0...api-v1.737.0) (2026-10-14)


### Features

* log link wallet usage and enable general availability ([#40058](https://github.com/okou-ai/okou/issues/40058)) ([a74aa11](https://github.com/okou-ai/okou/commit/a74aa11ef6782fbd5d70513e95cb0352cf6409b4))
* persist sandbox startup path on agent runs ([#39972](https://github.com/okou-ai/okou/issues/39972)) ([db59569](https://github.com/okou-ai/okou/commit/db595699439f7f221fb5df8b9eba14a9a4faac73))


### Bug Fixes

* clarify when to use link wallet for purchases ([#40051](https://github.com/okou-ai/okou/issues/40051)) ([fde8e03](https://github.com/okou-ai/okou/commit/fde8e038215a1ec8d899e6318931e10a73fb179d))


### Refactoring

* **api:** own builtin connector scope-diff reads ([#40031](https://github.com/okou-ai/okou/issues/40031)) ([2013cfe](https://github.com/okou-ai/okou/commit/2013cfed9dfa6755cde82c1578d1cf668a73e2b7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.561.0
    * @okouai/core bumped to 8.757.0
    * @okouai/db bumped to 1.339.0
    * @okouai/pi-agent-runtime bumped to 1.49.36

## [1.736.0](https://github.com/okou-ai/okou/compare/api-v1.735.0...api-v1.736.0) (2026-10-14)


### Features

* add write-only connector and remote control cli management ([#40008](https://github.com/okou-ai/okou/issues/40008)) ([80c57de](https://github.com/okou-ai/okou/commit/80c57de957fa0f4b38fdd064181b54f0a0caa24f))


### Bug Fixes

* **api:** accept owned task cgroups in oom evidence ([#40033](https://github.com/okou-ai/okou/issues/40033)) ([ab32460](https://github.com/okou-ai/okou/commit/ab3246078499dc5268e12b0ffe3844c81d299a24))
* report billing models from captured usage providers ([#40036](https://github.com/okou-ai/okou/issues/40036)) ([72071ff](https://github.com/okou-ai/okou/commit/72071ff711d0f9452a1e44cf52302696f29bf31b))


### Refactoring

* **api:** own teams installation reads in connected computeds ([#40032](https://github.com/okou-ai/okou/issues/40032)) ([f31e613](https://github.com/okou-ai/okou/commit/f31e6130f6d5e7d6e06873ff5351de5dcf5a896c)) [#37510](https://github.com/okou-ai/okou/issues/37510)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.560.1
    * @okouai/core bumped to 8.756.0
    * @okouai/db bumped to 1.338.1
    * @okouai/pi-agent-runtime bumped to 1.49.35

## [1.735.0](https://github.com/okou-ai/okou/compare/api-v1.734.0...api-v1.735.0) (2026-10-14)


### Features

* **discord:** add server installation links ([#40009](https://github.com/okou-ai/okou/issues/40009)) ([6102c18](https://github.com/okou-ai/okou/commit/6102c18ebee5885a15cad8cc0a48b48371223249))
* show vnc failures and fence ssh and vnc diagnostics ([#39851](https://github.com/okou-ai/okou/issues/39851)) ([928d548](https://github.com/okou-ai/okou/commit/928d5485ce17f1fae3727a6dfb6b6432c2f5e46d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.560.0
    * @okouai/core bumped to 8.755.0
    * @okouai/db bumped to 1.338.0
    * @okouai/pi-agent-runtime bumped to 1.49.34

## [1.734.0](https://github.com/okou-ai/okou/compare/api-v1.733.5...api-v1.734.0) (2026-10-14)


### Features

* add link payment credential retrieval to wallet cli ([#40016](https://github.com/okou-ai/okou/issues/40016)) ([6844864](https://github.com/okou-ai/okou/commit/6844864ee67b12e4d95967214a6487f454fa82c2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.559.0
    * @okouai/core bumped to 8.754.0
    * @okouai/db bumped to 1.337.1
    * @okouai/pi-agent-runtime bumped to 1.49.33

## [1.733.5](https://github.com/okou-ai/okou/compare/api-v1.733.4...api-v1.733.5) (2026-10-14)


### Bug Fixes

* explain telegram readiness failures and add diagnostics ([#39984](https://github.com/okou-ai/okou/issues/39984)) ([098184f](https://github.com/okou-ai/okou/commit/098184f9b8dc998dbf95d5c6426b49675188de95))


### Refactoring

* **api:** own exact connector account reads and preflights ([#39969](https://github.com/okou-ai/okou/issues/39969)) ([d3c98c2](https://github.com/okou-ai/okou/commit/d3c98c29bb946b012e34d3d5a76968e06dec0f5f))
* **vnc:** align authority caching with ssh ([#39957](https://github.com/okou-ai/okou/issues/39957)) ([6a1f7f8](https://github.com/okou-ai/okou/commit/6a1f7f84d991c69d3824255a41a79188ae71ea75))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.558.3
    * @okouai/core bumped to 8.753.2
    * @okouai/db bumped to 1.337.0
    * @okouai/pi-agent-runtime bumped to 1.49.32

## [1.733.4](https://github.com/okou-ai/okou/compare/api-v1.733.3...api-v1.733.4) (2026-10-14)


### Bug Fixes

* **api:** use official link wallet sdk ([#39977](https://github.com/okou-ai/okou/issues/39977)) ([e75340c](https://github.com/okou-ai/okou/commit/e75340c2ae508d32045e2decd02ba9b4ecade8ff))

## [1.733.3](https://github.com/okou-ai/okou/compare/api-v1.733.2...api-v1.733.3) (2026-10-14)


### Bug Fixes

* **host:** accept legacy cross-member deployments in delivery authority ([#39973](https://github.com/okou-ai/okou/issues/39973)) ([bc45d1c](https://github.com/okou-ai/okou/commit/bc45d1c12945a3023034b824c2989ea0e8628f5e)) [#39885](https://github.com/okou-ai/okou/issues/39885)
* move morning brief suggestions into a gated official workflow ([#39960](https://github.com/okou-ai/okou/issues/39960)) ([c4fdbb2](https://github.com/okou-ai/okou/commit/c4fdbb29f25ee35fe2d8adc3b2c27133aa297477))
* refresh runner platform api and cli release markers ([#39966](https://github.com/okou-ai/okou/issues/39966)) ([1d331fc](https://github.com/okou-ai/okou/commit/1d331fcf527832ed096e9016bdb21588542dd642))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.558.2
    * @okouai/core bumped to 8.753.1
    * @okouai/db bumped to 1.336.3
    * @okouai/pi-agent-runtime bumped to 1.49.31

## [1.733.2](https://github.com/okou-ai/okou/compare/api-v1.733.1...api-v1.733.2) (2026-10-14)


### Bug Fixes

* **api:** prepare run-owned deletion for session retirement ([#39931](https://github.com/okou-ai/okou/issues/39931)) ([fbeb04c](https://github.com/okou-ai/okou/commit/fbeb04cd067359c20138eabd9010edbbb2ca1374))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.753.0
    * @okouai/db bumped to 1.336.2
    * @okouai/pi-agent-runtime bumped to 1.49.30

## [1.733.1](https://github.com/okou-ai/okou/compare/api-v1.733.0...api-v1.733.1) (2026-10-14)


### Bug Fixes

* align wallet authorization cards and resume chat after consent ([#39918](https://github.com/okou-ai/okou/issues/39918)) ([b8f5ba9](https://github.com/okou-ai/okou/commit/b8f5ba9616117089475b8aef8854808195ec09f4))
* **api:** preserve usage pack schedule phase boundaries ([#39934](https://github.com/okou-ai/okou/issues/39934)) ([2d4c9fb](https://github.com/okou-ai/okou/commit/2d4c9fb00b2c1d5ae21cec76f96db5849264839c))


### Refactoring

* remove abandoned home task recommendations ([#39928](https://github.com/okou-ai/okou/issues/39928)) ([334940b](https://github.com/okou-ai/okou/commit/334940bb4da2cf321bf65b6a376c4dc1ae12daa4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.558.1
    * @okouai/core bumped to 8.752.2
    * @okouai/db bumped to 1.336.1
    * @okouai/pi-agent-runtime bumped to 1.49.29

## [1.733.0](https://github.com/okou-ai/okou/compare/api-v1.732.6...api-v1.733.0) (2026-10-14)


### Features

* **api:** list linked agents and chat threads in the web run prompt ([#39929](https://github.com/okou-ai/okou/issues/39929)) ([4d71d2c](https://github.com/okou-ai/okou/commit/4d71d2ca4d36a4d0a73d6d4c54bfe957799d419f))
* unify discord account connections across servers ([#39915](https://github.com/okou-ai/okou/issues/39915)) ([4909db4](https://github.com/okou-ai/okou/commit/4909db42d809d2cdc358f56db539dc26971b6e00))


### Bug Fixes

* isolate vnc invalidation from ssh sessions ([#39843](https://github.com/okou-ai/okou/issues/39843)) ([0ec2680](https://github.com/okou-ai/okou/commit/0ec26807a5073e76d3b3fbbcb48c9452422d25cb))
* preserve link wallet failure diagnostics ([#39932](https://github.com/okou-ai/okou/issues/39932)) ([f43b528](https://github.com/okou-ai/okou/commit/f43b528f10ebb934d66baabbab074167b441097d))
* remove assistant history from voice input ([#39908](https://github.com/okou-ai/okou/issues/39908)) ([a785a4d](https://github.com/okou-ai/okou/commit/a785a4d4a5679c1451fb40b52878f593aea606fa))
* **runner:** distinguish blank and cold sandbox startup ([#39847](https://github.com/okou-ai/okou/issues/39847)) ([03a34c1](https://github.com/okou-ai/okou/commit/03a34c1f15dc5f0d807658b7687ad300bbfe90ec))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.558.0
    * @okouai/core bumped to 8.752.1
    * @okouai/db bumped to 1.336.0
    * @okouai/pi-agent-runtime bumped to 1.49.28

## [1.732.6](https://github.com/okou-ai/okou/compare/api-v1.732.5...api-v1.732.6) (2026-10-14)


### Refactoring

* **api:** own non-financial plan capability reads ([#39850](https://github.com/okou-ai/okou/issues/39850)) ([378c4de](https://github.com/okou-ai/okou/commit/378c4deada2b6790fb248c2812440aa84f04b296))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.557.0
    * @okouai/core bumped to 8.752.0
    * @okouai/db bumped to 1.335.6
    * @okouai/pi-agent-runtime bumped to 1.49.27

## [1.732.5](https://github.com/okou-ai/okou/compare/api-v1.732.4...api-v1.732.5) (2026-10-13)


### Bug Fixes

* **api:** serialize pi maintenance until run finalization ([#39860](https://github.com/okou-ai/okou/issues/39860)) ([5c61728](https://github.com/okou-ai/okou/commit/5c617286ca02f90c74d5a93fb65d2e47d5ff52f2))


### Refactoring

* **api:** retire tx-0326 stripe metadata binding transaction ([#39616](https://github.com/okou-ai/okou/issues/39616)) ([d896565](https://github.com/okou-ai/okou/commit/d89656505bd3c93f1fdff33322d1a439a85146be))
* remove expired deployment compatibility ([#39868](https://github.com/okou-ai/okou/issues/39868)) ([8421077](https://github.com/okou-ai/okou/commit/842107763e1167424d94abee6ed6fe716019104a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.556.2
    * @okouai/core bumped to 8.751.2
    * @okouai/db bumped to 1.335.5
    * @okouai/pi-agent-runtime bumped to 1.49.26

## [1.732.4](https://github.com/okou-ai/okou/compare/api-v1.732.3...api-v1.732.4) (2026-10-13)


### Bug Fixes

* **api:** erase ssh login resources when organization members leave ([#39813](https://github.com/okou-ai/okou/issues/39813)) ([cff6436](https://github.com/okou-ai/okou/commit/cff6436ffdfaa91cba63cffb5a984525dbbcd0f9))
* refresh runner platform api and cli release markers ([#39831](https://github.com/okou-ai/okou/issues/39831)) ([5640704](https://github.com/okou-ai/okou/commit/56407049fb5e47ab339bf478e0d7e78a7887b73f))


### Refactoring

* **api:** own personal subscription model reads and selection repair ([#39834](https://github.com/okou-ai/okou/issues/39834)) ([4ab70bf](https://github.com/okou-ai/okou/commit/4ab70bf7e817e68af21875c80ac44f8bcbfe9088))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.335.4

## [1.732.3](https://github.com/okou-ai/okou/compare/api-v1.732.2...api-v1.732.3) (2026-10-13)


### Refactoring

* **api:** localize browser reconciliation database ownership ([#39808](https://github.com/okou-ai/okou/issues/39808)) ([2b6e343](https://github.com/okou-ai/okou/commit/2b6e3431e0b01ba400d4575f2349e92d5f347075))
* **api:** own discord admission terminal writes ([#39811](https://github.com/okou-ai/okou/issues/39811)) ([bd7f153](https://github.com/okou-ai/okou/commit/bd7f15385fce612a96a6cd9f5c15f3118b78678e))
* **api:** remove unused teams persistence handle ([#39793](https://github.com/okou-ai/okou/issues/39793)) ([d437853](https://github.com/okou-ai/okou/commit/d437853427438f95cc3db83edfa7ac7101bf1332)) [#37510](https://github.com/okou-ai/okou/issues/37510)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.335.3

## [1.732.2](https://github.com/okou-ai/okou/compare/api-v1.732.1...api-v1.732.2) (2026-10-13)


### Bug Fixes

* refresh runner app and api release markers ([#39784](https://github.com/okou-ai/okou/issues/39784)) ([5ac9e98](https://github.com/okou-ai/okou/commit/5ac9e98778dcd2b0e4b3b262ad363b1cfa0c2891))


### Refactoring

* **api:** derive slack connect installation in a private read node ([#39786](https://github.com/okou-ai/okou/issues/39786)) ([119a587](https://github.com/okou-ai/okou/commit/119a58779e787c88cf850a8e718341503254ea2e))
* remove artifact previews feature switch ([#39760](https://github.com/okou-ai/okou/issues/39760)) ([07891eb](https://github.com/okou-ai/okou/commit/07891ebc7aaf9dce2561e1828b0d9b47f678a78d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.556.1
    * @okouai/core bumped to 8.751.1
    * @okouai/db bumped to 1.335.2
    * @okouai/pi-agent-runtime bumped to 1.49.25

## [1.732.1](https://github.com/okou-ai/okou/compare/api-v1.732.0...api-v1.732.1) (2026-10-13)


### Bug Fixes

* **api:** clarify mcp chat thread list tool ([#39770](https://github.com/okou-ai/okou/issues/39770)) ([b54382d](https://github.com/okou-ai/okou/commit/b54382da62ba606c1f1354adefa0c1762c26a430))
* **api:** request link wallet userinfo scope ([#39766](https://github.com/okou-ai/okou/issues/39766)) ([5f40223](https://github.com/okou-ai/okou/commit/5f4022305e42ebddee1b7c106632097fc1bb2dae))


### Refactoring

* **api:** atomically publish workflow automation disable ([#39750](https://github.com/okou-ai/okou/issues/39750)) ([32a7748](https://github.com/okou-ai/okou/commit/32a77485f1802ee8e543e8e40a0d908329355190))
* **api:** own browser run and viewer authorization reads ([#39736](https://github.com/okou-ai/okou/issues/39736)) ([5e92217](https://github.com/okou-ai/okou/commit/5e9221799515e9f6e528d78664de3f06ea584fdf))
* **api:** own teams finalization and welcome executors ([#39747](https://github.com/okou-ai/okou/issues/39747)) ([6dfd6a7](https://github.com/okou-ai/okou/commit/6dfd6a7c2a498406ad4a0692c9b10de382cd55b0))
* **api:** prepare run-owned native facts for session retirement ([#39772](https://github.com/okou-ai/okou/issues/39772)) ([8c11a97](https://github.com/okou-ai/okou/commit/8c11a971bc9e69877bad3d26ee1ebb9e3a4b91dc))
* **api:** retire cloudflare artifact screenshots ([#39753](https://github.com/okou-ai/okou/issues/39753)) ([b4e8c69](https://github.com/okou-ai/okou/commit/b4e8c69a08f536a2695e635273ff7ebc2afd1566))
* **api:** retire private artifact app compatibility ([#39752](https://github.com/okou-ai/okou/issues/39752)) ([08942bc](https://github.com/okou-ai/okou/commit/08942bc157a67649b1e70cbef90d9059e7e1ca44))
* remove slack link unfurls feature switch ([#39745](https://github.com/okou-ai/okou/issues/39745)) ([18435fb](https://github.com/okou-ai/okou/commit/18435fb32d76f20197f1f9174529bcf0c3215287))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.751.0
    * @okouai/db bumped to 1.335.1
    * @okouai/pi-agent-runtime bumped to 1.49.24

## [1.732.0](https://github.com/okou-ai/okou/compare/api-v1.731.0...api-v1.732.0) (2026-10-13)


### Features

* add agent-managed next-step suggestions ([#39632](https://github.com/okou-ai/okou/issues/39632)) ([dad6cd0](https://github.com/okou-ai/okou/commit/dad6cd007f63399ea88652e0a9fcb99123e5a87a))
* enable artifact previews and slack link unfurls for everyone ([#39701](https://github.com/okou-ai/okou/issues/39701)) ([e8018ca](https://github.com/okou-ai/okou/commit/e8018cab8f6008bafa6905432215399d5893eac5))


### Bug Fixes

* **api:** retain forms progress through system configuration pauses ([#39703](https://github.com/okou-ai/okou/issues/39703)) ([855a6cd](https://github.com/okou-ai/okou/commit/855a6cd832f0a3141dabf4573f2710c1a94e77cd))


### Refactoring

* **api:** drop duplicate reads in run preparation ([#39716](https://github.com/okou-ai/okou/issues/39716)) ([bc1a52d](https://github.com/okou-ai/okou/commit/bc1a52d75b607877b041fa7e2c3dff85bc53ff00))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.556.0
    * @okouai/core bumped to 8.750.0
    * @okouai/db bumped to 1.335.0
    * @okouai/pi-agent-runtime bumped to 1.49.23

## [1.731.0](https://github.com/okou-ai/okou/compare/api-v1.730.0...api-v1.731.0) (2026-10-13)


### Features

* **app:** add responsive chat resources behind the artifact button ([#39607](https://github.com/okou-ai/okou/issues/39607)) ([f2f1158](https://github.com/okou-ai/okou/commit/f2f1158a9328ab4c4e2b0d2569109f553501d724))


### Bug Fixes

* **api:** classify link wallet authentication error messages ([#39688](https://github.com/okou-ai/okou/issues/39688)) ([989e901](https://github.com/okou-ai/okou/commit/989e901e2e3dcefcbe4a63f045dbbd0447b96b1c))
* **api:** recognize official link authentication error formats ([#39705](https://github.com/okou-ai/okou/issues/39705)) ([eb04d96](https://github.com/okou-ai/okou/commit/eb04d96b19de4c9324e8d65172fe9942dbb93546))
* let agents select presentation delivery format ([#39650](https://github.com/okou-ai/okou/issues/39650)) ([264b178](https://github.com/okou-ai/okou/commit/264b17803dafe5243656a898078250880efe0a16))


### Refactoring

* **api:** own browser thread profile lifecycle ([#39691](https://github.com/okou-ai/okou/issues/39691)) ([c2b4eb9](https://github.com/okou-ai/okou/commit/c2b4eb95281beae95e11353f866785f817224c41))
* **api:** own current browser session reads ([#39668](https://github.com/okou-ai/okou/issues/39668)) ([b83e969](https://github.com/okou-ai/okou/commit/b83e9691463bdd1d4c7366335b8aeaf7c307bccb))
* **api:** own discord ingress notice reads ([#39689](https://github.com/okou-ai/okou/issues/39689)) ([7f0ec69](https://github.com/okou-ai/okou/commit/7f0ec69f3f99104ad00fbca49483e7dfc578fb9a)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own slack deletion executors locally ([#39704](https://github.com/okou-ai/okou/issues/39704)) ([1a6a282](https://github.com/okou-ai/okou/commit/1a6a2822a8f5ced13bafdbf8f8269c4397020fa4)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** remove legacy official result email consumer and storage ([#39605](https://github.com/okou-ai/okou/issues/39605)) ([cb8e9a4](https://github.com/okou-ai/okou/commit/cb8e9a478cba72e936732bb91ff85bac1b1dc4da)) [#39569](https://github.com/okou-ai/okou/issues/39569)
* finish retired checkpoint terminology cleanup ([#39682](https://github.com/okou-ai/okou/issues/39682)) ([c45c269](https://github.com/okou-ai/okou/commit/c45c2697daeb0c4dc825fbce66fcc89d888471ed))
* remove private artifacts feature switch ([#39694](https://github.com/okou-ai/okou/issues/39694)) ([c1bcf92](https://github.com/okou-ai/okou/commit/c1bcf9249b6cedec9d52fd0115e3348bf616af6b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.555.0
    * @okouai/core bumped to 8.749.0
    * @okouai/db bumped to 1.334.0
    * @okouai/pi-agent-runtime bumped to 1.49.22

## [1.730.0](https://github.com/okou-ai/okou/compare/api-v1.729.2...api-v1.730.0) (2026-10-13)


### Features

* **workflows:** allow ordinary and official workflows to share a name ([#39430](https://github.com/okou-ai/okou/issues/39430)) ([12e59dc](https://github.com/okou-ai/okou/commit/12e59dce01d61d3e7a5373e7dbaa90dc8c239d65))


### Bug Fixes

* **api:** start a fresh official forms interval on manual re-enable ([#39647](https://github.com/okou-ai/okou/issues/39647)) ([2b8454e](https://github.com/okou-ai/okou/commit/2b8454eac9a6684c80c802e58a498058d3540561))


### Refactoring

* **api:** own active browser instance reads ([#39646](https://github.com/okou-ai/okou/issues/39646)) ([fa290f3](https://github.com/okou-ai/okou/commit/fa290f34be207163bdc7e6252f8d5dbf936b9ee3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.554.0
    * @okouai/core bumped to 8.748.4
    * @okouai/db bumped to 1.333.0
    * @okouai/pi-agent-runtime bumped to 1.49.21

## [1.729.2](https://github.com/okou-ai/okou/compare/api-v1.729.1...api-v1.729.2) (2026-10-13)


### Bug Fixes

* **api:** align discord conversation history with slack ([#39567](https://github.com/okou-ai/okou/issues/39567)) ([fefc19c](https://github.com/okou-ai/okou/commit/fefc19c798ed9febdc2a5298a3e7ceef81a3f00a))
* **api:** allow cli wss bootstrap and add protocol e2e ([#39486](https://github.com/okou-ai/okou/issues/39486)) ([64e5e3a](https://github.com/okou-ai/okou/commit/64e5e3a5500d549c8a049cbae8b2c7bfb5608e8c))
* **api:** reduce slack preview image height without changing layout ([#39560](https://github.com/okou-ai/okou/issues/39560)) ([480ba61](https://github.com/okou-ai/okou/commit/480ba6149f7223a30b02c215d234e83104e4e73e))
* **api:** reject stale forms activation and retire departure transaction ([#39565](https://github.com/okou-ai/okou/issues/39565)) ([36a76d6](https://github.com/okou-ai/okou/commit/36a76d65151866e033af948ec1a312434428b967))
* apply artifact cover prompts to every html publication ([#39611](https://github.com/okou-ai/okou/issues/39611)) ([f8b01e9](https://github.com/okou-ai/okou/commit/f8b01e90332fd4fc9c06d85d61cfb01e0045bdf5))
* **discord:** defer thread creation until first output ([#39582](https://github.com/okou-ai/okou/issues/39582)) ([5870943](https://github.com/okou-ai/okou/commit/5870943e7ad9d4a0d5df0c9e7086413f9bbd4933))
* **maps:** explain citation validation failures ([#39575](https://github.com/okou-ai/okou/issues/39575)) ([0e5a5a6](https://github.com/okou-ai/okou/commit/0e5a5a6dba9ce3fd7fb0539e3bc72e29b96f31d3))
* show link wallet icon and extend connection window ([#39585](https://github.com/okou-ai/okou/issues/39585)) ([7020b23](https://github.com/okou-ai/okou/commit/7020b2381e3140824f6cc419b966f0af289e0322))


### Refactoring

* **api:** connect slack org installation request graphs ([#39631](https://github.com/okou-ai/okou/issues/39631)) ([5155fdd](https://github.com/okou-ai/okou/commit/5155fdda924bd30503b7760531c51e3d7bb985f0)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own browser session ownership reads ([#39600](https://github.com/okou-ai/okou/issues/39600)) ([1149418](https://github.com/okou-ai/okou/commit/11494180840f4c3ca4b3eea2793a906c1b5b9636))
* **api:** own browser user-action liveness reads ([#39502](https://github.com/okou-ai/okou/issues/39502)) ([d6fb7a0](https://github.com/okou-ai/okou/commit/d6fb7a0b4e05efbdf36e46136f2a4a64f1ddd820))
* **api:** own discord destination reads in the signal-aware command ([#39601](https://github.com/okou-ai/okou/issues/39601)) ([6e5210d](https://github.com/okou-ai/okou/commit/6e5210d6940245528e416684c0ef72b1fad26cda))
* **api:** own exact browser user-action request reads ([#39570](https://github.com/okou-ai/okou/issues/39570)) ([363e583](https://github.com/okou-ai/okou/commit/363e583f628ea5e43b58ba7b8de0c66813f4a908))
* **api:** own low-credit suppression query locally ([#39592](https://github.com/okou-ai/okou/issues/39592)) ([6ec1168](https://github.com/okou-ai/okou/commit/6ec1168a4550cc1a4edd172f28f3b3d4aee2f830))
* **api:** own the teams default agent id read ([#39572](https://github.com/okou-ai/okou/issues/39572)) ([4b57138](https://github.com/okou-ai/okou/commit/4b5713810133cbde1cff3d362d588cda44b02381))
* **api:** own the teams workspace agent reads ([#39615](https://github.com/okou-ai/okou/issues/39615)) ([fb0b1b0](https://github.com/okou-ai/okou/commit/fb0b1b01ee2548ee89b3a8955ed2334c15adcf93))
* **api:** retire tx-0286 unpaid plan quote transaction ([#39571](https://github.com/okou-ai/okou/issues/39571)) ([4ca908b](https://github.com/okou-ai/okou/commit/4ca908b2b72b0f77f06ad69dd9a3ce822c55c432))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.748.3
    * @okouai/db bumped to 1.332.2
    * @okouai/pi-agent-runtime bumped to 1.49.20

## [1.729.1](https://github.com/okou-ai/okou/compare/api-v1.729.0...api-v1.729.1) (2026-10-13)


### Bug Fixes

* **api:** drain legacy official result email callbacks in release 2 ([#39527](https://github.com/okou-ai/okou/issues/39527)) ([13caaad](https://github.com/okou-ai/okou/commit/13caaadf0b18776e434fab185a7bb5c4205d74ad))


### Refactoring

* **api:** certify tx-0174 invoice billing atomicity ([#39512](https://github.com/okou-ai/okou/issues/39512)) ([3e944fb](https://github.com/okou-ai/okou/commit/3e944fb5de7f35a084cf231fb4480d9129eb221c))
* **api:** connect slack user installation request graphs ([#39503](https://github.com/okou-ai/okou/issues/39503)) ([a2b4f5b](https://github.com/okou-ai/okou/commit/a2b4f5b4af9bffac9e6bb07c4c0c942f43a06640)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** inline discord reply delivery in its owner ([#39518](https://github.com/okou-ai/okou/issues/39518)) ([14ce908](https://github.com/okou-ai/okou/commit/14ce908ad98630c8894d58a79244ff0158a85c9f))
* **api:** keep low-credit organization name query in its owner ([#39495](https://github.com/okou-ai/okou/issues/39495)) ([9b21e0c](https://github.com/okou-ai/okou/commit/9b21e0c4c6b4fc138627abaf1a5451fc9e8c2a34))
* **api:** own browser stuck-application normalization ([#39454](https://github.com/okou-ai/okou/issues/39454)) ([9ec3b27](https://github.com/okou-ai/okou/commit/9ec3b273021699ff5334d5edcbce48288e69c03e))
* **api:** own browser user-action preparation ([#39488](https://github.com/okou-ai/okou/issues/39488)) ([7a3a4f6](https://github.com/okou-ai/okou/commit/7a3a4f65ca44690ebba8382405c221d817c70882))
* **api:** own teams dispatch installation fallback read ([#39465](https://github.com/okou-ai/okou/issues/39465)) ([1a88662](https://github.com/okou-ai/okou/commit/1a88662cee61b342890a619440a0b3bc079fcc18)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** retire official workflow result email runtime ([#39514](https://github.com/okou-ai/okou/issues/39514)) ([991bc6b](https://github.com/okou-ai/okou/commit/991bc6b7a73e34d079a42da3ecdb5e51bc94b3a8))
* **api:** retire tx-0074 expired browser transaction ([#39513](https://github.com/okou-ai/okou/issues/39513)) ([3bac3ea](https://github.com/okou-ai/okou/commit/3bac3ea72df0b3a974fae5703b399cba7647274a))
* **api:** retire tx-0120 coherent custom runtime transaction ([#39528](https://github.com/okou-ai/okou/issues/39528)) ([1992dd2](https://github.com/okou-ai/okou/commit/1992dd25d34db4a77adfaf3423a9bbc528d36f5c))
* **api:** retire tx-0121 membership cache transaction ([#39540](https://github.com/okou-ai/okou/issues/39540)) ([05ad364](https://github.com/okou-ai/okou/commit/05ad364653d3d5470365f7635afb41317d220315))
* **api:** retire tx-0207 dormant materialization read transaction ([#39510](https://github.com/okou-ai/okou/issues/39510)) ([f7fa9bc](https://github.com/okou-ai/okou/commit/f7fa9bc817a882ab57adca792f4e0b8c4d739d5e))
* **api:** retire tx-0288 deferred schedule transaction ([#39511](https://github.com/okou-ai/okou/issues/39511)) ([7bac97e](https://github.com/okou-ai/okou/commit/7bac97eb9170e9626ed2e46e92b007ac9294fa22))
* **api:** retire tx-0289 preview admission transaction ([#39525](https://github.com/okou-ai/okou/issues/39525)) ([ad84493](https://github.com/okou-ai/okou/commit/ad84493d53fb7ca082c4063668242cc2f5aafb7c))
* **api:** retire tx-0290 failure publication transaction ([#39520](https://github.com/okou-ai/okou/issues/39520)) ([b076a14](https://github.com/okou-ai/okou/commit/b076a14cf0cb28e8d5aaa234766a3d46a54d0d25))
* **api:** retire tx-0291 invoice publication transaction ([#39523](https://github.com/okou-ai/okou/issues/39523)) ([a797b97](https://github.com/okou-ai/okou/commit/a797b97c5cdc0de7f255e1119d60f8e799bbff4b))
* **api:** retire tx-0292 restoration completion transaction ([#39519](https://github.com/okou-ai/okou/issues/39519)) ([0f85a07](https://github.com/okou-ai/okou/commit/0f85a07e5abd0ae7a6e0aca185be8181464a1f1b))
* **api:** retire tx-0295 unpaid preview transaction ([#39553](https://github.com/okou-ai/okou/issues/39553)) ([10fac4b](https://github.com/okou-ai/okou/commit/10fac4b11c1ef0ac4b4a989b0e72a36919abe350))
* **api:** retire tx-0297 revision intent transaction ([#39538](https://github.com/okou-ai/okou/issues/39538)) ([b40a7e1](https://github.com/okou-ai/okou/commit/b40a7e151714dd9bdf80dda427347f9e6db4e348))
* **api:** retire tx-0300 migration confirmation wrapper ([#39535](https://github.com/okou-ai/okou/issues/39535)) ([7ec8398](https://github.com/okou-ai/okou/commit/7ec839830e34a924442085de049c9a8801e1754a))
* **api:** retire tx-0301 checkout correlation transaction ([#39533](https://github.com/okou-ai/okou/issues/39533)) ([172ce94](https://github.com/okou-ai/okou/commit/172ce9402c7b2cae3adb1ceb5d8e9a985f3a8509))
* **api:** retire tx-0302 unpaid purchase claim transaction ([#39534](https://github.com/okou-ai/okou/issues/39534)) ([cc0417b](https://github.com/okou-ai/okou/commit/cc0417bfa46813eca5df20d1c9c474af8884bc7e))
* **mcp:** use iso datetimes for search filters ([#39453](https://github.com/okou-ai/okou/issues/39453)) ([c09bcde](https://github.com/okou-ai/okou/commit/c09bcdee094b0a47e39850a4aa4d3ae3cb005396))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.553.1
    * @okouai/core bumped to 8.748.2
    * @okouai/db bumped to 1.332.1
    * @okouai/pi-agent-runtime bumped to 1.49.19

## [1.729.0](https://github.com/okou-ai/okou/compare/api-v1.728.2...api-v1.729.0) (2026-10-12)


### Features

* **vnc:** prepare owner kerberos api and runner admission ([#38816](https://github.com/okou-ai/okou/issues/38816)) ([738b20d](https://github.com/okou-ai/okou/commit/738b20de5c517c2008bcc5543cc0f55a439670cb))


### Documentation

* **mcp:** clarify chat search limits and completeness ([#39448](https://github.com/okou-ai/okou/issues/39448)) ([411368e](https://github.com/okou-ai/okou/commit/411368e37d5363f2125451520d3fba7a7d1f3fa5))
* **mcp:** publish unicode search and highlight semantics ([#39450](https://github.com/okou-ai/okou/issues/39450)) ([76197e7](https://github.com/okou-ai/okou/commit/76197e77788081316d24bcbfd7a02c1a6c538b34))


### Refactoring

* **api:** atomically disable ineligible workflow webhooks ([#39462](https://github.com/okou-ai/okou/issues/39462)) ([840440c](https://github.com/okou-ai/okou/commit/840440cd12fa2f32eb9dfb1cd834ed575f507716))
* **api:** connect slack status to request graph inputs ([#39444](https://github.com/okou-ai/okou/issues/39444)) ([043377b](https://github.com/okou-ai/okou/commit/043377b754621c6c548186d11c066a0278e704bc)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own browser user-action application claim ([#39441](https://github.com/okou-ai/okou/issues/39441)) ([09c1a97](https://github.com/okou-ai/okou/commit/09c1a97c7d105e9b0eae1bd0319a2c7f648bc467))
* **api:** own discord ingress notices locally ([#39469](https://github.com/okou-ai/okou/issues/39469)) ([20488b7](https://github.com/okou-ai/okou/commit/20488b7d807c67a60d704cd082024efdb5474169))
* **api:** preconnect billing status request graph ([#39459](https://github.com/okou-ai/okou/issues/39459)) ([3cbd47b](https://github.com/okou-ai/okou/commit/3cbd47b2bc2cc75890a9aa416452db980ce4a36c)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **mcp:** unify chat event identities ([#39452](https://github.com/okou-ai/okou/issues/39452)) ([da20e96](https://github.com/okou-ai/okou/commit/da20e96dc74e79aa3fab079beae064259906469e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.553.0
    * @okouai/core bumped to 8.748.1
    * @okouai/db bumped to 1.332.0
    * @okouai/pi-agent-runtime bumped to 1.49.18

## [1.728.2](https://github.com/okou-ai/okou/compare/api-v1.728.1...api-v1.728.2) (2026-10-12)


### Bug Fixes

* **api:** preserve telegram missing-winner error priority ([#39433](https://github.com/okou-ai/okou/issues/39433)) ([d4aa816](https://github.com/okou-ai/okou/commit/d4aa816d41692e73e037956ca90b953e88f333c0))


### Refactoring

* **api:** own billing status concurrency read ([#39426](https://github.com/okou-ai/okou/issues/39426)) ([3ab5196](https://github.com/okou-ai/okou/commit/3ab51967ee9eef21b79e2a59abebfb8a8c458485)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own browser user-action cancellation ([#39420](https://github.com/okou-ai/okou/issues/39420)) ([53251f6](https://github.com/okou-ai/okou/commit/53251f68bb3c377700109e67005d6f5723567164))
* **api:** preconnect conditional discord status reads ([#39438](https://github.com/okou-ai/okou/issues/39438)) ([c333a4d](https://github.com/okou-ai/okou/commit/c333a4dc6caa457440074aba934198a403e16bd0)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** preconnect teams status identity graph ([#39418](https://github.com/okou-ai/okou/issues/39418)) ([a4078d5](https://github.com/okou-ai/okou/commit/a4078d5824527ff72a16340157701a820305aa67)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** retire canonical slack admission transaction ([#39424](https://github.com/okou-ai/okou/issues/39424)) ([fdf2a84](https://github.com/okou-ai/okou/commit/fdf2a84ea4eb1dce9ec4da487401d4a7dd37dc82))
* **api:** review x resource billing atomicity ([#39436](https://github.com/okou-ai/okou/issues/39436)) ([a5458fc](https://github.com/okou-ai/okou/commit/a5458fc76438883db9ec99f8a1bbcd41ddb5e67f))
* **mcp:** unify thread and run identifiers ([#39431](https://github.com/okou-ai/okou/issues/39431)) ([c3c5c71](https://github.com/okou-ai/okou/commit/c3c5c7173474d6782a738da153be1a67c4432291))
* **ssh:** prepare needs_rebind storage retirement ([#39414](https://github.com/okou-ai/okou/issues/39414)) ([4e5e841](https://github.com/okou-ai/okou/commit/4e5e8416ff4badd8907f6a49e010422437f320e3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.552.4
    * @okouai/core bumped to 8.748.0
    * @okouai/db bumped to 1.331.10
    * @okouai/pi-agent-runtime bumped to 1.49.17

## [1.728.1](https://github.com/okou-ai/okou/compare/api-v1.728.0...api-v1.728.1) (2026-10-12)


### Bug Fixes

* **mcp:** return canonical agent identity in chat search ([#39356](https://github.com/okou-ai/okou/issues/39356)) ([3302fb3](https://github.com/okou-ai/okou/commit/3302fb33796b29889064f4c36f22fb5e67346d4d))


### Refactoring

* **api:** atomically commit workflow metadata and publication receipt ([#39412](https://github.com/okou-ai/okou/issues/39412)) ([761426b](https://github.com/okou-ai/okou/commit/761426b8f25e358a5954439b949eb5a9b9a70963))
* **api:** drop the unused client response transform injection option ([#39402](https://github.com/okou-ai/okou/issues/39402)) ([5205c14](https://github.com/okou-ai/okou/commit/5205c149a04e0cd8f09cdf7cb63a3cad2a4e327a))
* **api:** own slack user binding reads in computed ([#39369](https://github.com/okou-ai/okou/issues/39369)) ([5ab733e](https://github.com/okou-ai/okou/commit/5ab733eaf1276d0a9813d306517c522c9adf70ca))
* **api:** prepare official workflow readers for result email retirement ([#39410](https://github.com/okou-ai/okou/issues/39410)) ([a797a9f](https://github.com/okou-ai/okou/commit/a797a9f44861d14d5ca1021a36f276e5a57bd387))
* **api:** retire automatic oauth preflight transaction ([#39409](https://github.com/okou-ai/okou/issues/39409)) ([89f71c9](https://github.com/okou-ai/okou/commit/89f71c9bf469ecb817a679feaf493cd8eabf4c9e))
* **api:** retire stranded browser recovery transaction ([#39366](https://github.com/okou-ai/okou/issues/39366)) ([fadcae1](https://github.com/okou-ai/okou/commit/fadcae14df3e0346bc759126034c30451e0bfedf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.552.3
    * @okouai/core bumped to 8.747.1
    * @okouai/db bumped to 1.331.9
    * @okouai/pi-agent-runtime bumped to 1.49.16

## [1.728.0](https://github.com/okou-ai/okou/compare/api-v1.727.8...api-v1.728.0) (2026-10-12)


### Features

* **api:** show large slack previews for ordinary app pages ([#39279](https://github.com/okou-ai/okou/issues/39279)) ([b478b51](https://github.com/okou-ai/okou/commit/b478b5176f6570ef6261bceff152bd14209f451a))


### Bug Fixes

* **api:** skip cloudflare screenshots when artifact previews are enabled ([#39341](https://github.com/okou-ai/okou/issues/39341)) ([e7c5b33](https://github.com/okou-ai/okou/commit/e7c5b3323a9e7e112dfe64d24cc20a5d9293fb1d))


### Refactoring

* **api:** atomically create vnc connections and inline credentials ([#39334](https://github.com/okou-ai/okou/issues/39334)) ([b97c0a0](https://github.com/okou-ai/okou/commit/b97c0a083ed2b989b2825576c72842260cffa3a5))
* **api:** own billing status capability reads ([#39364](https://github.com/okou-ai/okou/issues/39364)) ([5fa464d](https://github.com/okou-ai/okou/commit/5fa464da40ef8b5556f6ef71f88483848626c2e8)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own browser user-action request reads ([#39328](https://github.com/okou-ai/okou/issues/39328)) ([80bb495](https://github.com/okou-ai/okou/commit/80bb495080ad08f7ee4ee12c088caace0cd4e1ac))
* **api:** own saved discord dm choice reads in org status ([#39347](https://github.com/okou-ai/okou/issues/39347)) ([6cffbb8](https://github.com/okou-ai/okou/commit/6cffbb8d880c4ea0e45434efaf867a17263c310b))
* **api:** own unclaimed teams installation binding ([#39354](https://github.com/okou-ai/okou/issues/39354)) ([947ad30](https://github.com/okou-ai/okou/commit/947ad30ba34d6d0050fbb2403a893ae054f916a5)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** retire session storage mount inputs ([#39325](https://github.com/okou-ai/okou/issues/39325)) ([daf64a5](https://github.com/okou-ai/okou/commit/daf64a5d70a101c531b713370a36c33dbaf072ee))


### Performance Improvements

* **runner:** restore sessions from verified zstd sources ([#39335](https://github.com/okou-ai/okou/issues/39335)) ([42f118d](https://github.com/okou-ai/okou/commit/42f118dd2aa86e9d22a732a67d9f46a053ca32e8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.552.2
    * @okouai/core bumped to 8.747.0
    * @okouai/db bumped to 1.331.8
    * @okouai/pi-agent-runtime bumped to 1.49.15

## [1.727.8](https://github.com/okou-ai/okou/compare/api-v1.727.7...api-v1.727.8) (2026-10-12)


### Bug Fixes

* **api:** align discord command copy with slack ([#39278](https://github.com/okou-ai/okou/issues/39278)) ([8177d57](https://github.com/okou-ai/okou/commit/8177d574285852f6bf7e21114633d345d2facc96))
* **desktop:** keep native update manifests free of electron releases ([#39302](https://github.com/okou-ai/okou/issues/39302)) ([147e765](https://github.com/okou-ai/okou/commit/147e76579e0029ef1db4b47708ac39995937da5e))


### Refactoring

* **api:** atomically complete email outbox and receipt ([#39290](https://github.com/okou-ai/okou/issues/39290)) ([a95b34a](https://github.com/okou-ai/okou/commit/a95b34a5f0c7ad39634e432fde0defd39e169c6d))
* **api:** atomically persist discord admission destination ([#39285](https://github.com/okou-ai/okou/issues/39285)) ([4d60633](https://github.com/okou-ai/okou/commit/4d6063367909cb3c4e68560691faab8f8a8dde3e))
* **api:** atomically publish slack routes and thread events ([#39269](https://github.com/okou-ai/okou/issues/39269)) ([77a8259](https://github.com/okou-ai/okou/commit/77a825974ca8008256463391167766bf2b8ef0ad))
* **api:** construct slack oauth resolver before command execution ([#39214](https://github.com/okou-ai/okou/issues/39214)) ([6948040](https://github.com/okou-ai/okou/commit/694804023fc7577dc17e2423aad4f062bd00205a)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** inline telegram owner binding reads ([#38897](https://github.com/okou-ai/okou/issues/38897)) ([95fb1f3](https://github.com/okou-ai/okou/commit/95fb1f35a390f097a6c612396f3cf178b79a36e5))
* **api:** own discord org status connection query ([#39078](https://github.com/okou-ai/okou/issues/39078)) ([924005a](https://github.com/okou-ai/okou/commit/924005a909e66ded363712eff82db83d0f6c11c6)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own screenshot download cancellation ([#39287](https://github.com/okou-ai/okou/issues/39287)) ([b38d421](https://github.com/okou-ai/okou/commit/b38d421ac22fe4e5400816b48ea740836b8eb988))
* **api:** own teams installation metadata writes in connect command ([#39234](https://github.com/okou-ai/okou/issues/39234)) ([087a4f4](https://github.com/okou-ai/okou/commit/087a4f4c2f574ef30fa6442f6746536b850f8220)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** reuse invitation capability read owner ([#39256](https://github.com/okou-ai/okou/issues/39256)) ([085c763](https://github.com/okou-ai/okou/commit/085c763de5aad6934915d0ab996c1df2af8bd905)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **db:** retire native morning brief transition scaffolding ([#39295](https://github.com/okou-ai/okou/issues/39295)) ([61996b2](https://github.com/okou-ai/okou/commit/61996b256b5ae4c2236a3196ac62467b0bd128dc))


### Performance Improvements

* **runner:** attribute host-side storage apply phases ([#39232](https://github.com/okou-ai/okou/issues/39232)) ([87699ec](https://github.com/okou-ai/okou/commit/87699ec74930a925c53aa653b48cc78ab63e634e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.552.1
    * @okouai/core bumped to 8.746.0
    * @okouai/db bumped to 1.331.7
    * @okouai/pi-agent-runtime bumped to 1.49.14

## [1.727.7](https://github.com/okou-ai/okou/compare/api-v1.727.6...api-v1.727.7) (2026-10-12)


### Bug Fixes

* **api:** retry optional agent traces within a shared deadline ([#39201](https://github.com/okou-ai/okou/issues/39201)) ([3bf199f](https://github.com/okou-ai/okou/commit/3bf199fd296ba7d796a9a51ef9ceac0aac3e9f26))


### Refactoring

* **api:** atomically publish teams routes and thread events ([#39253](https://github.com/okou-ai/okou/issues/39253)) ([2a667ee](https://github.com/okou-ai/okou/commit/2a667ee0cb24738bee5c1b8bf591fdb82b8a6b59))
* **api:** give screenshot completion explicit write ownership ([#39228](https://github.com/okou-ai/okou/issues/39228)) ([d4c9148](https://github.com/okou-ai/okou/commit/d4c91480673a4179341d3551bb7daa3ce3a278a0))
* **api:** publish agentphone routes and created events atomically ([#39252](https://github.com/okou-ai/okou/issues/39252)) ([c864200](https://github.com/okou-ai/okou/commit/c864200ab65c4e13844687ac7827ea65bc93c7c5))
* **api:** publish global skill cache in one statement ([#39233](https://github.com/okou-ai/okou/issues/39233)) ([7caf463](https://github.com/okou-ai/okou/commit/7caf463df08c950c9f38b29a6b257547ec9b52d7))
* **api:** retire legacy primary calendar migration transaction ([#39237](https://github.com/okou-ai/okou/issues/39237)) ([c11e5bc](https://github.com/okou-ai/okou/commit/c11e5bc9270443aa417d7b3d9298f8749ec9131c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.552.0
    * @okouai/core bumped to 8.745.0
    * @okouai/db bumped to 1.331.6
    * @okouai/pi-agent-runtime bumped to 1.49.13

## [1.727.6](https://github.com/okou-ai/okou/compare/api-v1.727.5...api-v1.727.6) (2026-10-12)


### Refactoring

* **api:** append run time budget input atomically ([#39207](https://github.com/okou-ai/okou/issues/39207)) ([7b8c9c9](https://github.com/okou-ai/okou/commit/7b8c9c9701576304a9a549a654edd94cf3f1473b))
* **api:** own connected teams status reads in its computed ([#39224](https://github.com/okou-ai/okou/issues/39224)) ([295423e](https://github.com/okou-ai/okou/commit/295423ecb6d31a4770ae3bbec307d67bc7152a77)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own credit alert membership cache refresh ([#38384](https://github.com/okou-ai/okou/issues/38384)) ([4cc71cd](https://github.com/okou-ai/okou/commit/4cc71cdf8615b4848627d846bde7e9a11425cc9c)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own invitation plan capability reads locally ([#39223](https://github.com/okou-ai/okou/issues/39223)) ([f40f1b2](https://github.com/okou-ai/okou/commit/f40f1b2443e9f14a31864a43bd49b2d266ea01eb)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** publish and renew gmail watches in one statement ([#39215](https://github.com/okou-ai/okou/issues/39215)) ([96fc6fe](https://github.com/okou-ai/okou/commit/96fc6fe8ae55d27182599b50bbc7b279db1b9977))
* **api:** remove official schedule failure transaction ([#39212](https://github.com/okou-ai/okou/issues/39212)) ([0f64ab7](https://github.com/okou-ai/okou/commit/0f64ab7236abecc15c306e49ef44789ee1b9e2a4))
* **api:** remove orphan skill cache rows atomically ([#39220](https://github.com/okou-ai/okou/issues/39220)) ([4cb57a1](https://github.com/okou-ai/okou/commit/4cb57a1899e963bbba66dbe65abde1aa41f57f6a))
* retire pi memory compatibility storage writes ([#39185](https://github.com/okou-ai/okou/issues/39185)) ([39d60bb](https://github.com/okou-ai/okou/commit/39d60bba6aa3a317948d653b4c1d09781719b466))
* **workflows:** separate ordinary and official name scopes ([#39213](https://github.com/okou-ai/okou/issues/39213)) ([2da1ce1](https://github.com/okou-ai/okou/commit/2da1ce113c330701b85e4baf5fe7bec613ec6b19))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.551.4
    * @okouai/core bumped to 8.744.0
    * @okouai/db bumped to 1.331.5
    * @okouai/pi-agent-runtime bumped to 1.49.12

## [1.727.5](https://github.com/okou-ai/okou/compare/api-v1.727.4...api-v1.727.5) (2026-10-12)


### Bug Fixes

* accept home startup telemetry and attribute rejections ([#39175](https://github.com/okou-ai/okou/issues/39175)) ([acda46d](https://github.com/okou-ai/okou/commit/acda46d74a3bd83fba38e0671cfd606f85ab8401))


### Refactoring

* **api:** capture shared thread history in one statement ([#39184](https://github.com/okou-ai/okou/issues/39184)) ([1be8464](https://github.com/okou-ai/okou/commit/1be8464dddc0f65d5d304956e72b1d1a59a6446d))
* **api:** own teams connection status read in its computed ([#38877](https://github.com/okou-ai/okou/issues/38877)) ([e19e596](https://github.com/okou-ai/okou/commit/e19e5962f73bcb5874d4f7605713db6f57353dd3))


### Performance Improvements

* **cli:** reuse ably notifications for computer-use results ([#38742](https://github.com/okou-ai/okou/issues/38742)) ([04d247b](https://github.com/okou-ai/okou/commit/04d247ba25adf0ff82f8afad51e1631200915450))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.551.3
    * @okouai/core bumped to 8.743.0
    * @okouai/db bumped to 1.331.4
    * @okouai/pi-agent-runtime bumped to 1.49.11

## [1.727.4](https://github.com/okou-ai/okou/compare/api-v1.727.3...api-v1.727.4) (2026-10-12)


### Refactoring

* **api:** clean expired email outbox in one statement ([#39172](https://github.com/okou-ai/okou/issues/39172)) ([10ad20f](https://github.com/okou-ai/okou/commit/10ad20f6fd0fe6f15bec2bbcd6d74e005faed1c5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.551.2
    * @okouai/core bumped to 8.742.3
    * @okouai/db bumped to 1.331.3
    * @okouai/pi-agent-runtime bumped to 1.49.10

## [1.727.3](https://github.com/okou-ai/okou/compare/api-v1.727.2...api-v1.727.3) (2026-10-12)


### Refactoring

* **api:** keep purchased credit expiration in its financial owner ([#39138](https://github.com/okou-ai/okou/issues/39138)) ([6a0135e](https://github.com/okou-ai/okou/commit/6a0135e81e392728046dcaf660c23d27f37ee588))
* **api:** keep usage expiration sql in its financial owner ([#39140](https://github.com/okou-ai/okou/issues/39140)) ([57590da](https://github.com/okou-ai/okou/commit/57590da43c002e632ef43a6c506f1ab596551915))
* **api:** own computer-use host authority in commands ([#39103](https://github.com/okou-ai/okou/issues/39103)) ([5d4f6d1](https://github.com/okou-ai/okou/commit/5d4f6d1e119fd1dc724ab5a39b0837e4121c1127))

## [1.727.2](https://github.com/okou-ai/okou/compare/api-v1.727.1...api-v1.727.2) (2026-10-12)


### Refactoring

* **api:** apply chat desktop authorization in one statement ([#39130](https://github.com/okou-ai/okou/issues/39130)) ([f01a33a](https://github.com/okou-ai/okou/commit/f01a33a88edd6da4c281b6542e52b2f7026ef4ef))
* **api:** capture export message pages in one bounded select ([#39128](https://github.com/okou-ai/okou/issues/39128)) ([2532ef5](https://github.com/okou-ai/okou/commit/2532ef5b6f3ee76af7ff971a24f63b07c4f43d78))
* **api:** initialize member memory in one atomic statement ([#39118](https://github.com/okou-ai/okou/issues/39118)) ([a5755f2](https://github.com/okou-ai/okou/commit/a5755f2935311ffb3fc78fb89017aecf130c5778))
* **api:** own computer use host directory reads ([#39081](https://github.com/okou-ai/okou/issues/39081)) ([b1f4a50](https://github.com/okou-ai/okou/commit/b1f4a50cb5384843623e12371a09160241aea3a7))
* **api:** own computer use screenshot reads ([#39096](https://github.com/okou-ai/okou/issues/39096)) ([884bcf7](https://github.com/okou-ai/okou/commit/884bcf7eb313ace7cc4d5142bbd266378bc00e01))
* **api:** own computer use timeout and audit actions ([#39075](https://github.com/okou-ai/okou/issues/39075)) ([c5942aa](https://github.com/okou-ai/okou/commit/c5942aa3612406a33cd2d9b61d65b739aa97b064))
* **api:** publish lazy workflow threads in one statement ([#39120](https://github.com/okou-ai/okou/issues/39120)) ([838b530](https://github.com/okou-ai/okou/commit/838b530b53ae076c6ea970a08f05f4fff25d1f7e))
* **api:** remove morning brief timezone transaction ([#39100](https://github.com/okou-ai/okou/issues/39100)) ([3ac0d32](https://github.com/okou-ai/okou/commit/3ac0d32df28d716caee53b97b40a35f7b02f5067))
* **api:** replace pending banking sessions in one statement ([#39133](https://github.com/okou-ai/okou/issues/39133)) ([78247bd](https://github.com/okou-ai/okou/commit/78247bd62dc7388936b63e29fa3717ce09673663))
* **api:** retire browser authorization transaction ([#39105](https://github.com/okou-ai/okou/issues/39105)) ([73a8f42](https://github.com/okou-ai/okou/commit/73a8f42c9c2e0bdfa2d944dd5698026415adc277)) [#39101](https://github.com/okou-ai/okou/issues/39101)
* **api:** retire browser profile ownership transaction ([#39111](https://github.com/okou-ai/okou/issues/39111)) ([4a7c873](https://github.com/okou-ai/okou/commit/4a7c8735ed8174fbd1d1043304da3fc8d74f4af1))
* **api:** retire migration state getter transaction ([#39113](https://github.com/okou-ai/okou/issues/39113)) ([f667435](https://github.com/okou-ai/okou/commit/f667435c439db3e3ad4284a283173ded1fe1fa68))
* **api:** retire teams computer-use authorization transaction ([#39131](https://github.com/okou-ai/okou/issues/39131)) ([6b3635c](https://github.com/okou-ai/okou/commit/6b3635c54233d5016fa479c61dca3a633af75758))
* **api:** retire tx-0009 instruction settlement transaction ([#39129](https://github.com/okou-ai/okou/issues/39129)) ([a17b042](https://github.com/okou-ai/okou/commit/a17b042ea43c4d83afbf0bcb2061189ce0fa4f7b))
* **api:** retire tx-0014 builtin oauth start transaction ([#39080](https://github.com/okou-ai/okou/issues/39080)) ([fd1f4c8](https://github.com/okou-ai/okou/commit/fd1f4c8fae4984333912ffdbed5847dfd7c2f8ed))
* **api:** retire tx-0015 builtin openid start transaction ([#39087](https://github.com/okou-ai/okou/issues/39087)) ([512c376](https://github.com/okou-ai/okou/commit/512c3764f17b3134755417e22c20986d6bf46215))
* **api:** retire tx-0070 fresh browser claim transaction ([#39104](https://github.com/okou-ai/okou/issues/39104)) ([d40e6ad](https://github.com/okou-ai/okou/commit/d40e6adb53a93715fa3e6a0cd333f38731d61d54))
* **api:** retire tx-0192 notion projection repair transaction ([#39095](https://github.com/okou-ai/okou/issues/39095)) ([d526d86](https://github.com/okou-ai/okou/commit/d526d86ac9092772d46ad6308519ee56c4ddbb18))
* **api:** retire tx-0217 bootstrap preparation transaction ([#39116](https://github.com/okou-ai/okou/issues/39116)) ([6cf72c0](https://github.com/okou-ai/okou/commit/6cf72c0201546acc56e255db843343cdcc8e55c5))
* **api:** retire workflow copy preparation transaction ([#39110](https://github.com/okou-ai/okou/issues/39110)) ([26a0536](https://github.com/okou-ai/okou/commit/26a05361b52bfa252e0266066f0ed5f6f21da3d8))
* **runner:** retire workspace protocol and application sql ([#38837](https://github.com/okou-ai/okou/issues/38837)) ([a932f1f](https://github.com/okou-ai/okou/commit/a932f1f86ae10eb624fa3ff3bccc851ba4809a7e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.551.1
    * @okouai/core bumped to 8.742.2
    * @okouai/db bumped to 1.331.2
    * @okouai/pi-agent-runtime bumped to 1.49.9

## [1.727.1](https://github.com/okou-ai/okou/compare/api-v1.727.0...api-v1.727.1) (2026-10-11)


### Refactoring

* **api:** own chat-thread account target reads ([#39035](https://github.com/okou-ai/okou/issues/39035)) ([6ef6b29](https://github.com/okou-ai/okou/commit/6ef6b29bbf188d567b02bf23edfc03751a780027))
* **api:** own computer use audit event reads ([#39068](https://github.com/okou-ai/okou/issues/39068)) ([69b00a2](https://github.com/okou-ai/okou/commit/69b00a2215933ebbbacbc97f46f4f51c42c7ca24))
* **api:** own connected connector brief reads ([#39045](https://github.com/okou-ai/okou/issues/39045)) ([9b920c1](https://github.com/okou-ai/okou/commit/9b920c1c5dbb8e84a99ae3e3f6be467e923810b5))
* **api:** own personal account management identity reads ([#39053](https://github.com/okou-ai/okou/issues/39053)) ([e741a4c](https://github.com/okou-ai/okou/commit/e741a4c1b66772cfe4e11e186e6685a9c1419cf3))
* **api:** prebuild discord dm selection binding graph ([#39048](https://github.com/okou-ai/okou/issues/39048)) ([c8a9cd7](https://github.com/okou-ai/okou/commit/c8a9cd7b9baba9af2f203e45fbebc6d72f2c099e)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** prebuild discord org status feature graph ([#39066](https://github.com/okou-ai/okou/issues/39066)) ([2a35b72](https://github.com/okou-ai/okou/commit/2a35b720378fcb6e8b70e7f78ac22b9917fa724f)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** retire calendar watch publication transaction ([#39064](https://github.com/okou-ai/okou/issues/39064)) ([648b42e](https://github.com/okou-ai/okou/commit/648b42e82e6e180d5bbeacac6ad978c5695582d9))
* **api:** retire disabled automation restoration transaction ([#39062](https://github.com/okou-ai/okou/issues/39062)) ([2aa74a3](https://github.com/okou-ai/okou/commit/2aa74a300f4af17e418d9ced27f544908748dd75))
* **api:** retire google forms activation transaction ([#39069](https://github.com/okou-ai/okou/issues/39069)) ([0522d8d](https://github.com/okou-ai/okou/commit/0522d8d61ab78b609c3bfdac7391da3d81e8b576))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.331.1

## [1.727.0](https://github.com/okou-ai/okou/compare/api-v1.726.0...api-v1.727.0) (2026-10-11)


### Features

* **runner:** add one-use ticket wss admission ([#37114](https://github.com/okou-ai/okou/issues/37114)) ([0eece1f](https://github.com/okou-ai/okou/commit/0eece1f399b9e1b357fa1b3c1b4a6d0699d21088))
* **runner:** complete home cache disk visibility ([#38775](https://github.com/okou-ai/okou/issues/38775)) ([30c5539](https://github.com/okou-ai/okou/commit/30c5539999b0a90dfb693f0cc92c2cd29e6882d2))


### Bug Fixes

* **api:** migrate people search to gpt-5.6-luna ([#38822](https://github.com/okou-ai/okou/issues/38822)) ([6f4dcb4](https://github.com/okou-ai/okou/commit/6f4dcb4a42f6eabc141d0affeedf2dd33410000b))
* **api:** remove negative capability assertions from agent prompts ([#38927](https://github.com/okou-ai/okou/issues/38927)) ([d59dbcc](https://github.com/okou-ai/okou/commit/d59dbcc9d2a6ff1a30fd5f3364b61c62f3d46627))
* **api:** replay completed pi maintenance outputs independently ([#38858](https://github.com/okou-ai/okou/issues/38858)) ([cf3f51b](https://github.com/okou-ai/okou/commit/cf3f51bc6d76aef11a87727cb1baf34a49cc15be))
* remove retired connector references from app and tests ([#38802](https://github.com/okou-ai/okou/issues/38802)) ([63a43d9](https://github.com/okou-ai/okou/commit/63a43d9219560c0dfe29048b023c7910417a9c50))


### Documentation

* **mcp:** clarify indicator lifecycle semantics ([#38828](https://github.com/okou-ai/okou/issues/38828)) ([d5379fb](https://github.com/okou-ai/okou/commit/d5379fb148af22e0d4216582bbc9f22856d0be59))
* **mcp:** clarify search freshness and history confirmation ([#38810](https://github.com/okou-ai/okou/issues/38810)) ([56490ac](https://github.com/okou-ai/okou/commit/56490acbd082f94c88cd200f0e4cf803a1e386e6))


### Refactoring

* **api:** archive outbound phone messages atomically ([#38792](https://github.com/okou-ai/okou/issues/38792)) ([bc08695](https://github.com/okou-ai/okou/commit/bc08695a68a3a2e34898cd6c0bfc4c9ac3b01976))
* **api:** atomically replace development model keys ([#38835](https://github.com/okou-ai/okou/issues/38835)) ([74fa716](https://github.com/okou-ai/okou/commit/74fa716c3cfe6e7e3f8d856b3b99530ccf4d176b))
* **api:** atomically seed metadata-only skills ([#38847](https://github.com/okou-ai/okou/issues/38847)) ([94483f7](https://github.com/okou-ai/okou/commit/94483f7b36749d6a96d14de868bef5f53d95c39b))
* **api:** bootstrap checkout plan in one atomic statement ([#38884](https://github.com/okou-ai/okou/issues/38884)) ([bd04d2e](https://github.com/okou-ai/okou/commit/bd04d2ee1a231b5e11e65a14972f0e9a6ff0e765))
* **api:** construct private discord binding dependencies in their factories ([#38987](https://github.com/okou-ai/okou/issues/38987)) ([201ebbe](https://github.com/okou-ai/okou/commit/201ebbea440005e2cb37dab90789e9f085dcfd7f)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** construct private discord status dependencies in their factories ([#39006](https://github.com/okou-ai/okou/issues/39006)) ([d47a97a](https://github.com/okou-ai/okou/commit/d47a97a76f52fbdda84b01bf30e76f589879896c)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** hoist discord ingress sender dependency ([#39014](https://github.com/okou-ai/okou/issues/39014)) ([ae6f034](https://github.com/okou-ai/okou/commit/ae6f0342b6a8004802eac229b8b343e9986bab09)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** hoist static discord status dependencies ([#39023](https://github.com/okou-ai/okou/issues/39023)) ([a8a517d](https://github.com/okou-ai/okou/commit/a8a517d4f743d5d75e7988b62cbaca4185a55f33)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** inline claimed discord ingress read in its owner ([#38870](https://github.com/okou-ai/okou/issues/38870)) ([cfdf395](https://github.com/okou-ai/okou/commit/cfdf395ec4c3b0f71164063f097bdf90281b608e)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** inline discord reply content in its owner ([#38867](https://github.com/okou-ai/okou/issues/38867)) ([5a3dc28](https://github.com/okou-ai/okou/commit/5a3dc2842af118fddf9ff8a8a262c50da162a0ce)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** inline telegram callback delivery claim ([#38866](https://github.com/okou-ai/okou/issues/38866)) ([1c10e8c](https://github.com/okou-ai/okou/commit/1c10e8c8baa2792770c364be360e9a25b78433c0)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** inline telegram callback route checks ([#38791](https://github.com/okou-ai/okou/issues/38791)) ([5d1a627](https://github.com/okou-ai/okou/commit/5d1a6273363e75adfc084394f0f53126d54289c6)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** inline telegram callback status updates ([#38874](https://github.com/okou-ai/okou/issues/38874)) ([577858e](https://github.com/okou-ai/okou/commit/577858eb54842bcefafc7a8b6f085fffe4eb5c7f))
* **api:** keep device-auth creation execution local ([#38840](https://github.com/okou-ai/okou/issues/38840)) ([cf27816](https://github.com/okou-ai/okou/commit/cf2781610e92aa614bd65c4f1e0ff2d2fbdbcbe4))
* **api:** keep external-code creation execution local ([#38831](https://github.com/okou-ai/okou/issues/38831)) ([600ff03](https://github.com/okou-ai/okou/commit/600ff0343dcdc8c47041074658b19bf4c83dbab3))
* **api:** keep official skill volume seeding with its cli owner ([#38846](https://github.com/okou-ai/okou/issues/38846)) ([d7902b9](https://github.com/okou-ai/okou/commit/d7902b9177e3707260bbe469702f033139e89ff6))
* **api:** keep slack agent name reads in their existing owners ([#38804](https://github.com/okou-ai/okou/issues/38804)) ([3148222](https://github.com/okou-ai/okou/commit/314822284ab77f15956850b82c4d0b56426c197c)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** keep teams callback status in its dispatcher ([#38871](https://github.com/okou-ai/okou/issues/38871)) ([e6e8916](https://github.com/okou-ai/okou/commit/e6e8916d350ceb898abfa82c86c9c7cb3b9d4558)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** keep teams delivery claim in its dispatcher ([#38869](https://github.com/okou-ai/okou/issues/38869)) ([bdd725c](https://github.com/okou-ai/okou/commit/bdd725c91ecdff2a2493f0a875b01cfc56c0b76b)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** keep teams route adoption in its transaction owner ([#38865](https://github.com/okou-ai/okou/issues/38865)) ([803bbc6](https://github.com/okou-ai/okou/commit/803bbc685472def6fd789fa0ee07eaf04b30428e)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** keep teams route reads in their transaction owner ([#38776](https://github.com/okou-ai/okou/issues/38776)) ([463d1f9](https://github.com/okou-ai/okou/commit/463d1f94cf10a9b8006c72dd25c56687a386a1f8)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** localize bound usage pack subscription reads ([#38863](https://github.com/okou-ai/okou/issues/38863)) ([aca943c](https://github.com/okou-ai/okou/commit/aca943c2f546b4709621653ded021783666f900a)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** localize invitation billing context reads ([#38898](https://github.com/okou-ai/okou/issues/38898)) ([f841abc](https://github.com/okou-ai/okou/commit/f841abcb01125d552f1eb19aa8047ba359907fe7)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** localize member usage pack entitlement reads ([#38868](https://github.com/okou-ai/okou/issues/38868)) ([ce69c81](https://github.com/okou-ai/okou/commit/ce69c8162d10a64fd1e3b2129b5c13ef78f419e6)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** localize usage pack metadata subscription reads ([#38728](https://github.com/okou-ai/okou/issues/38728)) ([8fa3429](https://github.com/okou-ai/okou/commit/8fa342934bc0fc939e316233bfef65ad0d33f236)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own automatic mcp credential reads ([#38857](https://github.com/okou-ai/okou/issues/38857)) ([ef09472](https://github.com/okou-ai/okou/commit/ef09472eec2395aeee46c9192d486de4eeb6a993))
* **api:** own chat-thread catalog membership reads ([#39011](https://github.com/okou-ai/okou/issues/39011)) ([19a5f93](https://github.com/okou-ai/okou/commit/19a5f935956bb0d894f220c22965983f3a2b1a85))
* **api:** own connector catalog permission-detail reads ([#38983](https://github.com/okou-ai/okou/issues/38983)) ([f630831](https://github.com/okou-ai/okou/commit/f630831d9198b90f1353fd5cf745dc4d8a8bfeb7))
* **api:** own device-auth retained-claim completion writes ([#38848](https://github.com/okou-ai/okou/issues/38848)) ([97dedb5](https://github.com/okou-ai/okou/commit/97dedb5b25ceb8d885b87fa143d1a6dc20f9bc42))
* **api:** own device-auth session creation and atomic supersession ([#38821](https://github.com/okou-ai/okou/issues/38821)) ([35e11b4](https://github.com/okou-ai/okou/commit/35e11b4f42451578468ac9b5492808523244aab0))
* **api:** own device-auth terminal and lost-claim outcomes ([#38834](https://github.com/okou-ai/okou/issues/38834)) ([7ad23f1](https://github.com/okou-ai/okou/commit/7ad23f13c2e37e8bc9b90cf183169023aac387e0))
* **api:** own discord model route reads in interactions ([#38787](https://github.com/okou-ai/okou/issues/38787)) ([74b17ae](https://github.com/okou-ai/okou/commit/74b17ae17f8285a95456829f813d2b1379b8b717)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own oauth state insertion boundaries ([#38928](https://github.com/okou-ai/okou/issues/38928)) ([1815c2d](https://github.com/okou-ai/okou/commit/1815c2d385621cb8be767b31ac0bd9a10812c118))
* **api:** own oauth state status and callback claims ([#38896](https://github.com/okou-ai/okou/issues/38896)) ([ba2b526](https://github.com/okou-ai/okou/commit/ba2b52643cacb0e3739e8dbd4e4eca5e616ce715))
* **api:** own permission-grant catalog membership reads ([#39004](https://github.com/okou-ai/okou/issues/39004)) ([d9fc10c](https://github.com/okou-ai/okou/commit/d9fc10c56384f4e190e57da14a6439935c5c69d0))
* **api:** own single-connector catalog status reads ([#39021](https://github.com/okou-ai/okou/issues/39021)) ([8cc9f49](https://github.com/okou-ai/okou/commit/8cc9f49e1fe7c54a86074d9a9dae1ad03ed4a457))
* **api:** persist finicity webhook outcomes atomically ([#38886](https://github.com/okou-ai/okou/issues/38886)) ([cd792f1](https://github.com/okou-ai/okou/commit/cd792f1730bc12a0979efed5fbd568755ccc56c0))
* **api:** publish durable exports with an atomic notify handoff ([#38827](https://github.com/okou-ai/okou/issues/38827)) ([96853f9](https://github.com/okou-ai/okou/commit/96853f9215141c21b94e4a7b32122e7f72432ee9))
* **api:** publish morning brief toggle choice in one statement ([#38854](https://github.com/okou-ai/okou/issues/38854)) ([16fc0cc](https://github.com/okou-ai/okou/commit/16fc0cc8393768087b3ddba36cafb8069131b472))
* **api:** publish uploaded files with an atomic catalog handoff ([#38808](https://github.com/okou-ai/okou/issues/38808)) ([872c9d9](https://github.com/okou-ai/okou/commit/872c9d9de98bfe05cf6d007236ae938c3a4a2c91))
* **api:** read run assembly inputs from the thread context ([#38873](https://github.com/okou-ai/okou/issues/38873)) ([efc15ac](https://github.com/okou-ai/okou/commit/efc15ac006b2fe2ae69a00343fc028b6a538ce25))
* **api:** read the run prompt once and issue the okou token as an environment ([#38754](https://github.com/okou-ai/okou/issues/38754)) ([b794364](https://github.com/okou-ai/okou/commit/b794364e31bd97c9d6e9df0958abc1c34b4d2b0f))
* **api:** retire atomic browser stop transaction ([#39003](https://github.com/okou-ai/okou/issues/39003)) ([f10bda1](https://github.com/okou-ai/okou/commit/f10bda109955895a2944b636435826cc3af2fce0))
* **api:** retire chat snapshot publication transaction ([#39002](https://github.com/okou-ai/okou/issues/39002)) ([7e4677b](https://github.com/okou-ai/okou/commit/7e4677b6792d83de4e916ad4e282554a10e420c3))
* **api:** retire clerk export cleanup transaction ([#38801](https://github.com/okou-ai/okou/issues/38801)) ([2184da3](https://github.com/okou-ai/okou/commit/2184da3821b4295d9e4c131a2c85f2f74f2310b2))
* **api:** retire custom dcr invalidation transactions ([#38945](https://github.com/okou-ai/okou/issues/38945)) ([fbe06ee](https://github.com/okou-ai/okou/commit/fbe06ee80e12a00b9e295bb11598d069fb555a82))
* **api:** retire external-code session creation transaction ([#38806](https://github.com/okou-ai/okou/issues/38806)) ([e033088](https://github.com/okou-ai/okou/commit/e0330882dad92c07f85c181ff0f40871e24bb34a))
* **api:** retire linked gmail draft transaction ([#39019](https://github.com/okou-ai/okou/issues/39019)) ([5bb400a](https://github.com/okou-ai/okou/commit/5bb400a2f591e66edf74549393415ac3b6693f52))
* **api:** retire onboarding completion transaction ([#39024](https://github.com/okou-ai/okou/issues/39024)) ([60a6f3f](https://github.com/okou-ai/okou/commit/60a6f3f04424e1f4505efd57da651153c0e2549b))
* **api:** retire tx-0296 migration revision read transaction ([#39008](https://github.com/okou-ai/okou/issues/39008)) ([310a295](https://github.com/okou-ai/okou/commit/310a295b13356d5cf414a776c9c0a909b8f210f3))
* **api:** retire tx-0311 thread export read transaction ([#39012](https://github.com/okou-ai/okou/issues/39012)) ([0f4c84a](https://github.com/okou-ai/okou/commit/0f4c84a071e895918693fe73032c01870bd0cedc))
* **api:** retire unreachable stage1 cost pricing transaction ([#38885](https://github.com/okou-ai/okou/issues/38885)) ([e087fa1](https://github.com/okou-ai/okou/commit/e087fa1030f2eb0e1bda0ab97736f7e32b31ed6a))


### Performance Improvements

* **api:** attribute persistence and claim lookup database waits ([#38841](https://github.com/okou-ai/okou/issues/38841)) ([2f94467](https://github.com/okou-ai/okou/commit/2f9446716d6e8690e3fb8f80f3f8f87e9fc8ad46))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.551.0
    * @okouai/connectors bumped to 3.16.8
    * @okouai/core bumped to 8.742.1
    * @okouai/db bumped to 1.331.0
    * @okouai/pi-agent-runtime bumped to 1.49.8

## [1.726.0](https://github.com/okou-ai/okou/compare/api-v1.725.1...api-v1.726.0) (2026-10-10)


### Features

* **api:** add minimal slack previews for artifact links ([#38715](https://github.com/okou-ai/okou/issues/38715)) ([6831e9c](https://github.com/okou-ai/okou/commit/6831e9c986d7d68f109785697032af8f4f2b9620))
* **api:** apply registered desktop response transforms for older clients ([#38766](https://github.com/okou-ai/okou/issues/38766)) ([8de4ba2](https://github.com/okou-ai/okou/commit/8de4ba2efcd136a557111acdcc235cc8c7eba93b)) [#38758](https://github.com/okou-ai/okou/issues/38758)
* **api:** scope official workflow injection to automatic runs ([#38714](https://github.com/okou-ai/okou/issues/38714)) ([444c939](https://github.com/okou-ai/okou/commit/444c939e8754018d14357be1353cbe4ba3b0c71f))
* **discord:** expose standalone slash commands ([#38736](https://github.com/okou-ai/okou/issues/38736)) ([c5c4a69](https://github.com/okou-ai/okou/commit/c5c4a69f9e2aa8e9f570faab9eff6ffe97e78e18))


### Bug Fixes

* **api:** bypass cached misses when reading run context ([#38724](https://github.com/okou-ai/okou/issues/38724)) ([76bb2c2](https://github.com/okou-ai/okou/commit/76bb2c2ae4ac0048cde550f5a07d521d565652d8))
* **api:** validate discord user oauth scopes separately from install scopes ([#38761](https://github.com/okou-ai/okou/issues/38761)) ([9d9bd4b](https://github.com/okou-ai/okou/commit/9d9bd4b50b2ab40d46e03630ec14feed3bbabd99))
* **browser:** reject claimed inputs before loading staged files ([#38713](https://github.com/okou-ai/okou/issues/38713)) ([8347869](https://github.com/okou-ai/okou/commit/834786915751b6a11cefdbac5d9ec7f375228661))
* **maps:** migrate to gemini 3.1 flash-lite on generatecontent ([#38600](https://github.com/okou-ai/okou/issues/38600)) ([58a13b0](https://github.com/okou-ai/okou/commit/58a13b0c511c91c19d1f1105e249b8107087aa32))
* **pi:** retain native checkpoints ending in assistant error ([#38668](https://github.com/okou-ai/okou/issues/38668)) ([6650955](https://github.com/okou-ai/okou/commit/6650955655b1a349cc9861e5a2bd1e64495a7c29))


### Refactoring

* **api:** atomically skip expired workflow schedules ([#38573](https://github.com/okou-ai/okou/issues/38573)) ([73b913d](https://github.com/okou-ai/okou/commit/73b913d58d735ef3e7a520888b3e97aedecb804f))
* **api:** freeze the electron to native migration hop ([#38710](https://github.com/okou-ai/okou/issues/38710)) ([afb6dea](https://github.com/okou-ai/okou/commit/afb6dea81928274239d4c11e3c5887da0b0b0bfd))
* **api:** inline telegram route lookups at their owners ([#38773](https://github.com/okou-ai/okou/issues/38773)) ([a0f8a30](https://github.com/okou-ai/okou/commit/a0f8a3047e396198974f132e6a80e8ae240e47a4))
* **api:** keep slack default agent reads in their existing owners ([#38662](https://github.com/okou-ai/okou/issues/38662)) ([7703b56](https://github.com/okou-ai/okou/commit/7703b560672e7b0de15bec2bedcdcb76f5f3451a)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own builtin device-auth completed replay ([#38739](https://github.com/okou-ai/okou/issues/38739)) ([6817a6a](https://github.com/okou-ai/okou/commit/6817a6adc18f3475dc31ec798cc54ce791352249))
* **api:** own builtin external-code claimed completion ([#38698](https://github.com/okou-ai/okou/issues/38698)) ([344e282](https://github.com/okou-ai/okou/commit/344e282d75a94e57f3254279063b77d68a9f2f9b))
* **api:** own builtin external-code completed replay ([#38768](https://github.com/okou-ai/okou/issues/38768)) ([80e8aac](https://github.com/okou-ai/okou/commit/80e8aac72ae7ed0a88b9403fe7859b7c918e3427))
* **api:** own discord message lookup in gateway ([#38734](https://github.com/okou-ai/okou/issues/38734)) ([cae23c3](https://github.com/okou-ai/okou/commit/cae23c3ce858b519ef8388b145b3a364da04d275)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own discord receipt lookup in gateway ([#38780](https://github.com/okou-ai/okou/issues/38780)) ([4e22cde](https://github.com/okou-ai/okou/commit/4e22cde17296c79c9007e236011c2d152578a2f9)) [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** persist inbound agentphone messages atomically ([#38747](https://github.com/okou-ai/okou/issues/38747)) ([06d4f43](https://github.com/okou-ai/okou/commit/06d4f4308b2dcdaacc76480f06926a33efd60019))
* **api:** prepare thread runs from bootstrap and thread context ([#38743](https://github.com/okou-ai/okou/issues/38743)) ([28d31f9](https://github.com/okou-ai/okou/commit/28d31f97114c42510fc7ca89aefeabce2d080a2c))
* **api:** publish automatic refresh credentials atomically ([#38697](https://github.com/okou-ai/okou/issues/38697)) ([ad3acff](https://github.com/okou-ai/okou/commit/ad3acff863a02165684a9ab03b3d9027bde3de08))
* **api:** publish connector catalog pointer without a transaction ([#38759](https://github.com/okou-ai/okou/issues/38759)) ([749c589](https://github.com/okou-ai/okou/commit/749c58982faf7716d254d40565fe28542004fc2d))
* **api:** publish stripe customers without a transaction ([#38783](https://github.com/okou-ai/okou/issues/38783)) ([50e76fb](https://github.com/okou-ai/okou/commit/50e76fb1cbe31313244febff728f819c7ad4a7af))
* **api:** remove preview catalog pointer transaction ([#38716](https://github.com/okou-ai/okou/issues/38716)) ([5a11075](https://github.com/okou-ai/okou/commit/5a11075ce745ce76b4fda3f08d59e0c49e3be67d))
* **api:** retire native morning brief member metadata mapping ([#38737](https://github.com/okou-ai/okou/issues/38737)) ([5f1cda2](https://github.com/okou-ai/okou/commit/5f1cda2faa2927ce8a393b4d4674abec5cc7f394))
* **api:** retire slack route lookup transaction ([#38763](https://github.com/okou-ai/okou/issues/38763)) ([52713b3](https://github.com/okou-ai/okou/commit/52713b324a090e6ea885d8eb4c611a476c9a02a0))
* **api:** retire zero desktop migration compatibility ([#38678](https://github.com/okou-ai/okou/issues/38678)) ([f0b72cc](https://github.com/okou-ai/okou/commit/f0b72ccc44b5771b8bb9c80af16ac67fbb4efa53))
* **api:** split thread claim run preparation signals ([#38496](https://github.com/okou-ai/okou/issues/38496)) ([4c83447](https://github.com/okou-ai/okou/commit/4c8344736615619622128f6a7f4e0e928c251deb))
* **mcp:** make tools thin adapters over web apis ([#38723](https://github.com/okou-ai/okou/issues/38723)) ([32cd45c](https://github.com/okou-ai/okou/commit/32cd45c2c10f40b50a47239e5dce72ee8a01d4fa))
* name native history and pi memory publications explicitly ([#38679](https://github.com/okou-ai/okou/issues/38679)) ([e5b1d4e](https://github.com/okou-ai/okou/commit/e5b1d4ed7bd2f8b54e01352e762e1f9eec5c3a39))
* simplify pi memory results and finalization diagnostics ([#38765](https://github.com/okou-ai/okou/issues/38765)) ([cdd6a0a](https://github.com/okou-ai/okou/commit/cdd6a0abe3f5880e98a02da8df5143232d7632e1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.550.0
    * @okouai/core bumped to 8.742.0
    * @okouai/db bumped to 1.330.4
    * @okouai/pi-agent-runtime bumped to 1.49.7

## [1.725.1](https://github.com/okou-ai/okou/compare/api-v1.725.0...api-v1.725.1) (2026-10-10)


### Refactoring

* **api:** own builtin device-auth awaiting restoration ([#38655](https://github.com/okou-ai/okou/issues/38655)) ([cdb5fef](https://github.com/okou-ai/okou/commit/cdb5fef32849d3b4d831e15a7a949c169e799749))
* **api:** remove automatic dcr refresh retirement transaction ([#38667](https://github.com/okou-ai/okou/issues/38667)) ([ba896c8](https://github.com/okou-ai/okou/commit/ba896c8bf58671c1aaaeaa101d5627a7bdca3b84))
* **api:** retire tx-0233 private artifact completion transaction ([#38652](https://github.com/okou-ai/okou/issues/38652)) ([eac7c26](https://github.com/okou-ai/okou/commit/eac7c264465a9905726144d65bbb9d44a352f81e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.549.1
    * @okouai/core bumped to 8.741.1
    * @okouai/db bumped to 1.330.3
    * @okouai/pi-agent-runtime bumped to 1.49.6

## [1.725.0](https://github.com/okou-ai/okou/compare/api-v1.724.0...api-v1.725.0) (2026-10-10)


### Features

* **morning-brief:** let agents choose email delivery ([#38612](https://github.com/okou-ai/okou/issues/38612)) ([0f93208](https://github.com/okou-ai/okou/commit/0f93208a3ab70effb1b4bea0a9c3fd8b20dc6ee0))


### Bug Fixes

* restore inline artifact previews ([#38579](https://github.com/okou-ai/okou/issues/38579)) ([4b9ce32](https://github.com/okou-ai/okou/commit/4b9ce32d5a84048aba394dd6f4297303002bdf0f))


### Refactoring

* **api:** erase vnc owner resources in one atomic statement ([#38625](https://github.com/okou-ai/okou/issues/38625)) ([b630116](https://github.com/okou-ai/okou/commit/b630116f5808cc0b6df6d766970d202e3f8a83b9))
* **api:** retire builtin dcr registration transaction ([#38640](https://github.com/okou-ai/okou/issues/38640)) ([fe1b76a](https://github.com/okou-ai/okou/commit/fe1b76a3b1696799a6488064437abfe582d50bfd))
* **api:** retire custom dcr registration in one statement ([#38637](https://github.com/okou-ai/okou/issues/38637)) ([e78027b](https://github.com/okou-ai/okou/commit/e78027b99b18c44fdb52c3c435da489f79b3e067))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.741.0
    * @okouai/db bumped to 1.330.2
    * @okouai/pi-agent-runtime bumped to 1.49.5

## [1.724.0](https://github.com/okou-ai/okou/compare/api-v1.723.0...api-v1.724.0) (2026-10-10)


### Features

* **api:** add the ios client compatibility floor ([#38609](https://github.com/okou-ai/okou/issues/38609)) ([4c78da8](https://github.com/okou-ai/okou/commit/4c78da863a4546dce0cf69d916c64ae84d4953fb)), closes [#38587](https://github.com/okou-ai/okou/issues/38587)
* **slack:** adopt agent sessions and native stop ([#38560](https://github.com/okou-ai/okou/issues/38560)) ([efdc848](https://github.com/okou-ai/okou/commit/efdc848c58e111f566aa02d29c705dcb136baa8d))


### Bug Fixes

* **api:** retry transient google token acquisition failures ([#38567](https://github.com/okou-ai/okou/issues/38567)) ([74fa095](https://github.com/okou-ai/okou/commit/74fa0950649dbf54b9bc9f7d67b74e2b9cb960ab))
* use hosted og credentials and restore the okou brand cover ([#38510](https://github.com/okou-ai/okou/issues/38510)) ([2d2ec67](https://github.com/okou-ai/okou/commit/2d2ec676fbf7ab4bc0db3cd5439715869ff2d6b9))


### Refactoring

* **api:** claim invitation activation in one atomic statement ([#38574](https://github.com/okou-ai/okou/issues/38574)) ([a06edd7](https://github.com/okou-ai/okou/commit/a06edd77e8b9064577114e42b6a9cf410c6635b5))
* **api:** keep slack connect status reads in their owning graph ([#38556](https://github.com/okou-ai/okou/issues/38556)) ([8bf148b](https://github.com/okou-ai/okou/commit/8bf148bf9db8c1bf6e4028e703270290a3735458)), closes [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** keep slack route reads in their transaction owner ([#38580](https://github.com/okou-ai/okou/issues/38580)) ([b78baa8](https://github.com/okou-ai/okou/commit/b78baa84b22371e0e8ee983e756adf6c22a19947))
* **api:** make allocation source predicate a pure builder ([#38606](https://github.com/okou-ai/okou/issues/38606)) ([7d6e9bd](https://github.com/okou-ai/okou/commit/7d6e9bdf0c1d26447c9e33ecca5859444d60a9c2)), closes [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own builtin device-auth session expiration ([#38517](https://github.com/okou-ai/okou/issues/38517)) ([ad1b8d4](https://github.com/okou-ai/okou/commit/ad1b8d498cb3da601a7c583f7e9ac6edea340d56))
* **api:** own discord assigned route reads ([#38613](https://github.com/okou-ai/okou/issues/38613)) ([1c2cdd6](https://github.com/okou-ai/okou/commit/1c2cdd6c7f44338191a8c3fc607b5e40792b4454)), closes [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** own discord route attachment writes ([#38570](https://github.com/okou-ai/okou/issues/38570)) ([9302c1e](https://github.com/okou-ai/okou/commit/9302c1e4d8b540aad9e894e315cbd8b68110484c)), closes [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** publish fresh telegram threads in one statement ([#38598](https://github.com/okou-ai/okou/issues/38598)) ([bcbb100](https://github.com/okou-ai/okou/commit/bcbb100d44de954a374607fb9f7a5ef2383e9945))
* **api:** publish notion verification tokens atomically ([#38616](https://github.com/okou-ai/okou/issues/38616)) ([922cec1](https://github.com/okou-ai/okou/commit/922cec10600e4be732e549afd7348ff987d9f54a))
* **api:** remove ordinary billing restore transaction ([#38557](https://github.com/okou-ai/okou/issues/38557)) ([c3996f0](https://github.com/okou-ai/okou/commit/c3996f02c381e07067fb7fad6faac7471d9994d7)), closes [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** remove session history prepare transaction ([#38518](https://github.com/okou-ai/okou/issues/38518)) ([cbb009a](https://github.com/okou-ai/okou/commit/cbb009aaba53a132af79f763df361217626901c5))
* **api:** retire legacy computer-use host tokens ([#38559](https://github.com/okou-ai/okou/issues/38559)) ([829d10f](https://github.com/okou-ai/okou/commit/829d10ffe05819dca15432cee1d392cf56847cf7))
* **api:** revoke runner wss tickets in one statement ([#38558](https://github.com/okou-ai/okou/issues/38558)) ([0530733](https://github.com/okou-ai/okou/commit/05307331c91ebae224e2800c1f433965161ef1ab))
* remove notify mail feature switch ([#38561](https://github.com/okou-ai/okou/issues/38561)) ([7f40f95](https://github.com/okou-ai/okou/commit/7f40f954492838ac72a4d291848b2ef24266a9a7))


### Performance Improvements

* **computer-use:** replace desktop command polling with ably wakeups ([#38610](https://github.com/okou-ai/okou/issues/38610)) ([ff8cd53](https://github.com/okou-ai/okou/commit/ff8cd536be6edd610413923204b26c35e76b9ec4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.549.0
    * @okouai/core bumped to 8.740.1
    * @okouai/db bumped to 1.330.1
    * @okouai/pi-agent-runtime bumped to 1.49.4

## [1.723.0](https://github.com/okou-ai/okou/compare/api-v1.722.0...api-v1.723.0) (2026-10-10)


### Features

* **notify:** enable mail notifications for everyone ([#38513](https://github.com/okou-ai/okou/issues/38513)) ([90da609](https://github.com/okou-ai/okou/commit/90da609107a1612fa3d9039862f02c09f2ed09d2))
* **ssh:** add tailscale configuration and current authority ([#37651](https://github.com/okou-ai/okou/issues/37651)) ([00b9386](https://github.com/okou-ai/okou/commit/00b93867968c441677ecb76962c0c251358a15ae))


### Refactoring

* **api:** finalize invitation refunds in one atomic statement ([#38501](https://github.com/okou-ai/okou/issues/38501)) ([21a5419](https://github.com/okou-ai/okou/commit/21a5419582f7bf619f60a8a20e9ea668eee78c1c))
* **api:** own builtin device-auth session claims ([#38495](https://github.com/okou-ai/okou/issues/38495)) ([eac5e80](https://github.com/okou-ai/okou/commit/eac5e80c13cc39576be73eeb88c80b49348908de))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.548.0
    * @okouai/core bumped to 8.740.0
    * @okouai/db bumped to 1.330.0
    * @okouai/pi-agent-runtime bumped to 1.49.3

## [1.722.0](https://github.com/okou-ai/okou/compare/api-v1.721.1...api-v1.722.0) (2026-10-10)


### Features

* **discord:** complete oauth onboarding and slack conversation parity ([#37968](https://github.com/okou-ai/okou/issues/37968)) ([ccc74ac](https://github.com/okou-ai/okou/commit/ccc74ac9b9c74d70654fd0a0a547018cde7d55ed))


### Bug Fixes

* **api:** resume bounded chat event snapshot garbage collection ([#38424](https://github.com/okou-ai/okou/issues/38424)) ([8c424ef](https://github.com/okou-ai/okou/commit/8c424ef5ea95ccf438d3cd5e7bcd281ea4a6c20d))
* finalize model identity writers and prepare bounded history repair ([#38477](https://github.com/okou-ai/okou/issues/38477)) ([b691971](https://github.com/okou-ai/okou/commit/b6919718b6d856dfa3a7c500b6e899dd3fde7674)), closes [#38114](https://github.com/okou-ai/okou/issues/38114)


### Refactoring

* **api:** activate personal accounts with atomic sql ([#38466](https://github.com/okou-ai/okou/issues/38466)) ([6938a74](https://github.com/okou-ai/okou/commit/6938a74c3941e71405ba5d905d8384d6d4fa8ab1))
* **api:** own builtin device-auth session reads ([#38465](https://github.com/okou-ai/okou/issues/38465)) ([4935d23](https://github.com/okou-ai/okou/commit/4935d231376b7c40db912b1dc2451e71da673489))
* **api:** own builtin external-code session claims ([#38483](https://github.com/okou-ai/okou/issues/38483)) ([bf223ca](https://github.com/okou-ai/okou/commit/bf223ca7fa9cc52888658e5699192728473db406))
* **api:** own builtin external-code session reads ([#38472](https://github.com/okou-ai/okou/issues/38472)) ([ce53eea](https://github.com/okou-ai/okou/commit/ce53eea0e7f5a831716825f3c63a1a781189a683))
* **api:** retire discord dm selection transaction ([#38488](https://github.com/okou-ai/okou/issues/38488)) ([381e809](https://github.com/okou-ai/okou/commit/381e809f7e7b1ff68d783eb8937a5c530aab94c7))
* **api:** retire final clerk publication cleanup transaction ([#38487](https://github.com/okou-ai/okou/issues/38487)) ([7368f89](https://github.com/okou-ai/okou/commit/7368f89dd6f1df5eb528f1a1c986d0298a0ee847))
* **api:** retire mcp agent discovery transaction ([#38468](https://github.com/okou-ai/okou/issues/38468)) ([4feb0b9](https://github.com/okou-ai/okou/commit/4feb0b93d1e2753b669c185fe46c6fd823b3062c))
* **api:** retire ssh credential rotation transaction ([#38485](https://github.com/okou-ai/okou/issues/38485)) ([4e8f5a8](https://github.com/okou-ai/okou/commit/4e8f5a898d75bb2680f149127b2b8525b25c22c9))
* **api:** retire tx-0182 thread metadata transaction ([#38470](https://github.com/okou-ai/okou/issues/38470)) ([9d6be5b](https://github.com/okou-ai/okou/commit/9d6be5b8903d0aefa3b56fd28e1c248c24364da9))
* **api:** retire vnc credential update transaction ([#38490](https://github.com/okou-ai/okou/issues/38490)) ([9d45902](https://github.com/okou-ai/okou/commit/9d45902e5bdf6dbe38c452cbd1908a2419386b3c))
* **api:** separate identity and thread preparation signals ([#38459](https://github.com/okou-ai/okou/issues/38459)) ([4483285](https://github.com/okou-ai/okou/commit/44832858d98d8d30c89fa52d1ecab1649e51a040))
* **pi:** retire unversioned model config execution ([#38449](https://github.com/okou-ai/okou/issues/38449)) ([c628473](https://github.com/okou-ai/okou/commit/c62847319cb3ebbd41259d662f47905a1cb39863))
* remove generic checkpoint persistence and protocols ([#38399](https://github.com/okou-ai/okou/issues/38399)) ([0c926e3](https://github.com/okou-ai/okou/commit/0c926e34ca09edaf2840ffcbfa56f3dc07a4588d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.547.0
    * @okouai/core bumped to 8.739.2
    * @okouai/db bumped to 1.329.0
    * @okouai/pi-agent-runtime bumped to 1.49.2

## [1.721.1](https://github.com/okou-ai/okou/compare/api-v1.721.0...api-v1.721.1) (2026-10-09)


### Documentation

* reorganize engineering guides and align testing policies ([#38421](https://github.com/okou-ai/okou/issues/38421)) ([60f5783](https://github.com/okou-ai/okou/commit/60f57836b2877b5e065bf27b7adf75c2f633b95d))


### Refactoring

* **api:** extract prompt and skill preparation factories ([#38367](https://github.com/okou-ai/okou/issues/38367)) ([10449a5](https://github.com/okou-ai/okou/commit/10449a5252a831ec40127dd38118e96da9401a48))
* **api:** own connected connector agent resolution ([#38433](https://github.com/okou-ai/okou/issues/38433)) ([5e26e9b](https://github.com/okou-ai/okou/commit/5e26e9b9bb3dba915412ba8a33ba84ccce9fd548))
* **api:** read stored connector diagnostics in one statement ([#38458](https://github.com/okou-ai/okou/issues/38458)) ([6ea7ed1](https://github.com/okou-ai/okou/commit/6ea7ed14c1b88377c38dfd3bd6b08cc94dd67b15))
* **api:** remove cloudflare access creation transaction ([#38443](https://github.com/okou-ai/okou/issues/38443)) ([139d5cf](https://github.com/okou-ai/okou/commit/139d5cfcd2dbd947d1a1d3ef773bb1c488475bdb))
* **api:** remove connector account rename transaction ([#38452](https://github.com/okou-ai/okou/issues/38452)) ([d791969](https://github.com/okou-ai/okou/commit/d791969aec0763e83a86233e76d3f4dd92ace5a1))
* **api:** remove discord preview deletion transaction ([#38445](https://github.com/okou-ai/okou/issues/38445)) ([03c79d9](https://github.com/okou-ai/okou/commit/03c79d9a11fa49dab3f4ddf755a969452a82fe2d))
* **api:** remove invitation creation claim transaction ([#38447](https://github.com/okou-ai/okou/issues/38447)) ([a0eca50](https://github.com/okou-ai/okou/commit/a0eca5092d174ae91f178cf981c837dc4d4eecc7))
* **api:** remove late invitation acceptance transaction ([#38457](https://github.com/okou-ai/okou/issues/38457)) ([3051ccf](https://github.com/okou-ai/okou/commit/3051ccf67a27b042a712f729dd82605df07450ad))
* **api:** remove queued automation launch revalidation ([#38429](https://github.com/okou-ai/okou/issues/38429)) ([0cd4407](https://github.com/okou-ai/okou/commit/0cd44075ce114059e644713562e1fc3aca6e6710))
* **api:** remove unreachable legacy desktop manifest reader ([#38441](https://github.com/okou-ai/okou/issues/38441)) ([b6ce3d8](https://github.com/okou-ai/okou/commit/b6ce3d830f65c026632f5058e514e5653ce90763))
* **api:** retire chat thread provenance from runtime sql ([#38431](https://github.com/okou-ai/okou/issues/38431)) ([9fa8da0](https://github.com/okou-ai/okou/commit/9fa8da0d3d25e75e0dcfdd3292e1e2bbe6fe262f))
* **api:** save ssh connection edits atomically without a transaction ([#38434](https://github.com/okou-ai/okou/issues/38434)) ([d40df43](https://github.com/okou-ai/okou/commit/d40df43bed417d3a76abe077c4869594094c1ec9))
* canonicalize historical model selections and constrain runtime captures ([#38389](https://github.com/okou-ai/okou/issues/38389)) ([1ab1fc2](https://github.com/okou-ai/okou/commit/1ab1fc21a3aabe940ee044cc6f4226faee2a668f))


### Performance Improvements

* **api:** use firecrawl default scrape caching ([#38451](https://github.com/okou-ai/okou/issues/38451)) ([79ae38f](https://github.com/okou-ai/okou/commit/79ae38f82141678c93c881c6bdf6cccbc82de442))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.739.1
    * @okouai/db bumped to 1.328.1
    * @okouai/pi-agent-runtime bumped to 1.49.1

## [1.721.0](https://github.com/okou-ai/okou/compare/api-v1.720.1...api-v1.721.0) (2026-10-09)


### Features

* add permission-aware artifact og previews ([#38361](https://github.com/okou-ai/okou/issues/38361)) ([2ef5d4e](https://github.com/okou-ai/okou/commit/2ef5d4ec8c2aedc9217e669f110f8c68fb9b65f3))
* add sandbox covers for hosted artifacts ([#38149](https://github.com/okou-ai/okou/issues/38149)) ([f4a3140](https://github.com/okou-ai/okou/commit/f4a3140275a8c3334135080ed2427e837bc9fc89))
* add subscription controls and user-confirmed reset cards ([#37763](https://github.com/okou-ai/okou/issues/37763)) ([d9a0b29](https://github.com/okou-ai/okou/commit/d9a0b29aeb0866740540f5e970fcbf80709342d7))
* allow debug admins to clear organization openrouter presets ([#38407](https://github.com/okou-ai/okou/issues/38407)) ([a1464ca](https://github.com/okou-ai/okou/commit/a1464ca1752a1aa3247485b1582604ef10a276d1))
* allow debug admins to switch organization openrouter presets ([#38327](https://github.com/okou-ai/okou/issues/38327)) ([3ab4dfc](https://github.com/okou-ai/okou/commit/3ab4dfc68ffdf7afe085c52e3cf9040354c117d9))
* **api:** prepare home cache affinity and runner state ([#38314](https://github.com/okou-ai/okou/issues/38314)) ([21ce097](https://github.com/okou-ai/okou/commit/21ce0978ad9a5bc7eddb94bc9d2bc25f1897095f))
* **api:** prepare immutable catalog before hash-cas activation ([#37701](https://github.com/okou-ai/okou/issues/37701)) ([b8da8bd](https://github.com/okou-ai/okou/commit/b8da8bd6292a3a436f3f501316d2fa05770ec436))
* **api:** require desktop 0.51.0 for computer use admission ([#38390](https://github.com/okou-ai/okou/issues/38390)) ([97be706](https://github.com/okou-ai/okou/commit/97be706f45fc34d0ae9f9f408b9c48a58da03b19))
* **api:** support organization openrouter preset overrides ([#37799](https://github.com/okou-ai/okou/issues/37799)) ([dacd31d](https://github.com/okou-ai/okou/commit/dacd31d031d98d45ccb3c6bd134f55b5f76063f4))
* **api:** switch auto writers to captured runtime billing ([#38270](https://github.com/okou-ai/okou/issues/38270)) ([e34e331](https://github.com/okou-ai/okou/commit/e34e3319db818fa89f928b7c8dc21e3536714c86))
* **core:** release eleven staff feature switches to all users ([#37818](https://github.com/okou-ai/okou/issues/37818)) ([8d05119](https://github.com/okou-ai/okou/commit/8d051194184d595b67f78f5d6f7ec728ed6cc31d))
* **db:** add immutable catalog tables and a shared test catalog ([#37697](https://github.com/okou-ai/okou/issues/37697)) ([f24c015](https://github.com/okou-ai/okou/commit/f24c0158fb5d44fe002399bea74aaec8822bf2c0))
* **debug:** add morning brief test emails ([#38411](https://github.com/okou-ai/okou/issues/38411)) ([ce2f1d5](https://github.com/okou-ai/okou/commit/ce2f1d5b3ce2cad351d5515e38dee95d05d148c9))
* **desktop:** enforce minimum versions with automatic required upgrades ([#38115](https://github.com/okou-ai/okou/issues/38115)) ([ae3a5b2](https://github.com/okou-ai/okou/commit/ae3a5b291a085bd900c21689563c74240c4123cb))
* **desktop:** replace electron with native swift desktop ([#37889](https://github.com/okou-ai/okou/issues/37889)) ([303d7bc](https://github.com/okou-ai/okou/commit/303d7bc2e3176b02c66ca3ef1c9c9b0eb2bb7700))
* **desktop:** use clerk session tokens for native computer use ([#37965](https://github.com/okou-ai/okou/issues/37965)) ([fccd4a9](https://github.com/okou-ai/okou/commit/fccd4a98bb370bdaf9c8dd312988f5ba267bbb2c))
* enable phone group history, message sharing and social jobs globally ([#37716](https://github.com/okou-ai/okou/issues/37716)) ([b1ec157](https://github.com/okou-ai/okou/commit/b1ec157db9ded38688563e0f153df0ab8364802e))
* enable private artifacts for all users ([#37951](https://github.com/okou-ai/okou/issues/37951)) ([91e19d1](https://github.com/okou-ai/okou/commit/91e19d1e55e49ffb5822aa2a9d7fcb336b9cb9cf))
* make pi memory free with an openrouter preset ([#38290](https://github.com/okou-ai/okou/issues/38290)) ([5768ad5](https://github.com/okou-ai/okou/commit/5768ad5ef7ce0808c6cde85a9eb628be7e8aeb57))
* materialize connector catalog entry query columns ([#37816](https://github.com/okou-ai/okou/issues/37816)) ([a032281](https://github.com/okou-ai/okou/commit/a032281cb085da66d271087211c94955748cb803))
* **mcp:** track chat inputs by their original event id ([#37759](https://github.com/okou-ai/okou/issues/37759)) ([1375385](https://github.com/okou-ai/okou/commit/137538594d42aa2942187acee4ac713c6c308112))
* **notify:** add agent-controlled mail notifications ([#38093](https://github.com/okou-ai/okou/issues/38093)) ([702c270](https://github.com/okou-ai/okou/commit/702c270169c8de738aa9f47ed5480ed377edcfda))
* **notify:** add morning brief notification kind ([#38308](https://github.com/okou-ai/okou/issues/38308)) ([31d9036](https://github.com/okou-ai/okou/commit/31d9036dcb2e6a005ebbdb250a3b216ce713c51c))
* **pi:** route openrouter through chat completions behind a switch ([#37987](https://github.com/okou-ai/okou/issues/37987)) ([df136ee](https://github.com/okou-ai/okou/commit/df136ee82546c76d79575e203c7257371ea5b3cb))
* prepare model identity compatibility without switching writes ([#38092](https://github.com/okou-ai/okou/issues/38092)) ([21177df](https://github.com/okou-ai/okou/commit/21177dfd37bc19114098a628a094adb67fb60db0))


### Bug Fixes

* **api:** allow sandbox tokens to read the model catalog ([#37773](https://github.com/okou-ai/okou/issues/37773)) ([936ccb3](https://github.com/okou-ai/okou/commit/936ccb30e40aa238c19f7045462f5709099ec079))
* **api:** bind stripe customers with an atomic upsert ([#38126](https://github.com/okou-ai/okou/issues/38126)) ([282b045](https://github.com/okou-ai/okou/commit/282b045539de6636eea6691581f5cff0626ff235))
* **api:** consume unread state for external notification delivery ([#37751](https://github.com/okou-ai/okou/issues/37751)) ([caba8a3](https://github.com/okou-ai/okou/commit/caba8a39eea743b843142046f5d5ba588afdc710))
* **api:** default organization model mode to auto ([#37745](https://github.com/okou-ai/okou/issues/37745)) ([0d679ea](https://github.com/okou-ai/okou/commit/0d679eacd13a934d407b7ed19bb9c138d04859e5))
* **api:** exclude inline-only agentphone callbacks ([#37996](https://github.com/okou-ai/okou/issues/37996)) ([a9ca48e](https://github.com/okou-ai/okou/commit/a9ca48ebfca4c9222052ccaa4268f1f513e921e9))
* **api:** grant onboarding credits as personal usage packs ([#38059](https://github.com/okou-ai/okou/issues/38059)) ([6798f0a](https://github.com/okou-ai/okou/commit/6798f0a0a233331d18f384ec9d81608c3bd060f1))
* **api:** handle attached schedules in billing previews ([#38065](https://github.com/okou-ai/okou/issues/38065)) ([f590586](https://github.com/okou-ai/okou/commit/f5905861eb85c3492d072255ee2fea35118ba48f))
* **api:** ignore non-completed workflow job webhooks ([#38395](https://github.com/okou-ai/okou/issues/38395)) ([adbed2f](https://github.com/okou-ai/okou/commit/adbed2f709d35cae7273789ce098569f32421eba))
* **api:** keep successful schedule expiry below warning ([#37998](https://github.com/okou-ai/okou/issues/37998)) ([e2bb3de](https://github.com/okou-ai/okou/commit/e2bb3de9bfc8a59202a9572264e8010d3e065a7b))
* **api:** keep usage pack webhook reads in one snapshot ([#38286](https://github.com/okou-ai/okou/issues/38286)) ([5712d95](https://github.com/okou-ai/okou/commit/5712d9550317d811e0e2e66f2611f835a619ec7b))
* **api:** name agent in connector authorization error ([#38005](https://github.com/okou-ai/okou/issues/38005)) ([52d5fd1](https://github.com/okou-ai/okou/commit/52d5fd130fd02857522b7a95f06f5dc8bb331e86))
* **api:** omit agent-enabled connectors missing from the catalog instead of rejecting the run ([#37893](https://github.com/okou-ai/okou/issues/37893)) ([3ff1f40](https://github.com/okou-ai/okou/commit/3ff1f404e2b2908ddc3a39dff60abe1e12177d90))
* **api:** persist initial file share revocations ([#38015](https://github.com/okou-ai/okou/issues/38015)) ([61b9112](https://github.com/okou-ai/okou/commit/61b91126a88149de8aaa3dd196e1d4af092a91c1))
* **api:** prepare memory revision writes for checkpoint contraction ([#38380](https://github.com/okou-ai/okou/issues/38380)) ([6389016](https://github.com/okou-ai/okou/commit/6389016d7baa395df1fe1d3587adb36c30dd4217))
* **api:** raise autonomous delegation budget to 32 ([#37737](https://github.com/okou-ai/okou/issues/37737)) ([f57a13f](https://github.com/okou-ai/okou/commit/f57a13f44233adb5b8469d0a039cb4befda9cf32))
* **api:** refresh archive urls with less than four hours remaining ([#37735](https://github.com/okou-ai/okou/issues/37735)) ([b6e6d02](https://github.com/okou-ai/okou/commit/b6e6d02418c07f713a95c29313671a65f3a82643))
* **api:** remove chat input and auxiliary write latency warnings ([#38318](https://github.com/okou-ai/okou/issues/38318)) ([7a61cc2](https://github.com/okou-ai/okou/commit/7a61cc21582c21782ac307a7a945941d334bcf65))
* **api:** remove cloudflare mutation transaction retries ([#38282](https://github.com/okou-ai/okou/issues/38282)) ([d99e140](https://github.com/okou-ai/okou/commit/d99e140bd25233b4e009b8a074aaf9b63e8b164a))
* **api:** stop warning on expected queued input rejections ([#37974](https://github.com/okou-ai/okou/issues/37974)) ([2443e7b](https://github.com/okou-ai/okou/commit/2443e7b20d23d60dddd9cf9613f3242a113d7d33))
* **api:** suppress web push for channel-triggered chat runs ([#37726](https://github.com/okou-ai/okou/issues/37726)) ([6e471ef](https://github.com/okou-ai/okou/commit/6e471efd37b31b216bfa35ea0ad5681142f087bb))
* **api:** treat connectors missing from the catalog as unauthorized everywhere ([#37898](https://github.com/okou-ai/okou/issues/37898)) ([d281779](https://github.com/okou-ai/okou/commit/d28177961e86fd7cc41c62a0c0749e61a1859867))
* **api:** use luna with current memory owner credentials ([#38129](https://github.com/okou-ai/okou/issues/38129)) ([77357ab](https://github.com/okou-ai/okou/commit/77357abdb29ce96b2caf9ee679299602757844dc))
* **app:** scope account connections and release multiple subscriptions ([#37714](https://github.com/okou-ai/okou/issues/37714)) ([db0d2ad](https://github.com/okou-ai/okou/commit/db0d2adf4400029a95f1a07fd6c50e48a7e4417e))
* **billing:** keep member usage packs nonnegative ([#38071](https://github.com/okou-ai/okou/issues/38071)) ([532c7f8](https://github.com/okou-ai/okou/commit/532c7f813cc2e824ff4fa487f251786848b8d752))
* distinguish shared instructions from personal memory ([#38072](https://github.com/okou-ai/okou/issues/38072)) ([ce08549](https://github.com/okou-ai/okou/commit/ce085495f43d88f6d6197532e6c15ca634889ae2))
* **host:** prepare canonical deployment delivery authority ([#38212](https://github.com/okou-ai/okou/issues/38212)) ([bd8b130](https://github.com/okou-ai/okou/commit/bd8b13065d6b8ce406c3c7659f6634528f794913))
* **integrations:** hide auto model attribution in message footers ([#37959](https://github.com/okou-ai/okou/issues/37959)) ([46a2d1a](https://github.com/okou-ai/okou/commit/46a2d1a044c0d48829d2879c689539ccfea64a65))
* **maps:** explain oversized grounding responses ([#38046](https://github.com/okou-ai/okou/issues/38046)) ([9ea9cde](https://github.com/okou-ai/okou/commit/9ea9cde34b01d89bb258b44250ce4b17260cf37c)), closes [#36791](https://github.com/okou-ai/okou/issues/36791)
* rewrite retired thread models to their replacement ([#37906](https://github.com/okou-ai/okou/issues/37906)) ([eb98c63](https://github.com/okou-ai/okou/commit/eb98c63635aa78f7c9c79ef8e24a382e9c2d1077))
* **seo:** preserve dataforseo partial serp results ([#37961](https://github.com/okou-ai/okou/issues/37961)) ([b5d9654](https://github.com/okou-ai/okou/commit/b5d96542a902d7cad11325c86966f49746e41172))
* **ssh:** fence cloudflare bindings with host-first mutations ([#37955](https://github.com/okou-ai/okou/issues/37955)) ([42935d1](https://github.com/okou-ai/okou/commit/42935d1cc0181aa3bfa6a571ceb8059282d292ae))
* stop reporting handled clerk ui and invalid workflow payload errors ([#38299](https://github.com/okou-ai/okou/issues/38299)) ([d138629](https://github.com/okou-ai/okou/commit/d13862990122a1309790326f956e5b093faa73ad))
* suppress pwa push while the user is foreground in the same org ([#38091](https://github.com/okou-ai/okou/issues/38091)) ([22f89a5](https://github.com/okou-ai/okou/commit/22f89a5c8b69990bb3834c7678acb25f00d1c823))
* **voice:** separate segment transcription from final polish ([#38082](https://github.com/okou-ai/okou/issues/38082)) ([1c7cb86](https://github.com/okou-ai/okou/commit/1c7cb86855d50504a57a6fcb86b9357a5965e3de))


### CI

* remove production release catalog sync ([#38230](https://github.com/okou-ai/okou/issues/38230)) ([1a51a67](https://github.com/okou-ai/okou/commit/1a51a6731107a55a1adc4d34160860f186c96758))


### Documentation

* consolidate official morning brief contracts ([#38297](https://github.com/okou-ai/okou/issues/38297)) ([1b853f2](https://github.com/okou-ai/okou/commit/1b853f27e087c5e3e5ba7a8d6607333079760826))
* keep reusable engineering standards and remove feature records ([#38387](https://github.com/okou-ai/okou/issues/38387)) ([6507d86](https://github.com/okou-ai/okou/commit/6507d86c83ca37e7a8790e4efd66eb6a84267295))
* remove morning brief feature documentation ([#38378](https://github.com/okou-ai/okou/issues/38378)) ([2fcd479](https://github.com/okou-ai/okou/commit/2fcd479e176f6ce6fbb8c27950a72c0643eb0e2b))


### Refactoring

* **api:** atomically fail pi memory phase2 leases ([#38014](https://github.com/okou-ai/okou/issues/38014)) ([93231f6](https://github.com/okou-ai/okou/commit/93231f634b4145feb48dc93daa74da0864e63667))
* **api:** build pi cleanup predicates without db handles ([#38333](https://github.com/okou-ai/okou/issues/38333)) ([9f09dc5](https://github.com/okou-ai/okou/commit/9f09dc556b34a95eaae3668436274da8ec0cc40f))
* **api:** claim official workflow work atomically ([#38041](https://github.com/okou-ai/okou/issues/38041)) ([b6befac](https://github.com/okou-ai/okou/commit/b6befacb367f900e0da9c1159bfa60e66a34d6f9))
* **api:** derive connector prompts from bootstrap authorization ([#38228](https://github.com/okou-ai/okou/issues/38228)) ([4c016da](https://github.com/okou-ai/okou/commit/4c016da6694e286c9a471536b020f0dcd6ace8cd))
* **api:** encapsulate continuation and template preparation ([#38155](https://github.com/okou-ai/okou/issues/38155)) ([207088f](https://github.com/okou-ai/okou/commit/207088f19c5df05553c233d8a0ccbaf195fb0314))
* **api:** extract integration and session rotation prompts ([#38119](https://github.com/okou-ai/okou/issues/38119)) ([8418b0d](https://github.com/okou-ai/okou/commit/8418b0d73d57b2e6f2d18234e262f9527ed9e006))
* **api:** finish storage worker and timestamp ownership ([#38194](https://github.com/okou-ai/okou/issues/38194)) ([4729e51](https://github.com/okou-ai/okou/commit/4729e51f8cc5261e1badcd7cd96b14b82b1918d7))
* **api:** give catalog commands database ownership ([#38037](https://github.com/okou-ai/okou/issues/38037)) ([6f7b47c](https://github.com/okou-ai/okou/commit/6f7b47c2bd8892d2ea82908114a5e36bf0597819))
* **api:** inline clerk lifecycle transaction ownership ([#38171](https://github.com/okou-ai/okou/issues/38171)) ([50f91be](https://github.com/okou-ai/okou/commit/50f91befb0bacd4d7c166ace839251a648bd4bf9)), closes [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** inline web input transaction writes ([#38183](https://github.com/okou-ai/okou/issues/38183)) ([4d6305f](https://github.com/okou-ai/okou/commit/4d6305f2693f022cc05f6d4d3d9c02086cfbd443))
* **api:** localize billing checkout database ownership ([#38090](https://github.com/okou-ai/okou/issues/38090)) ([75f4a8c](https://github.com/okou-ai/okou/commit/75f4a8ca5f1cd5aaee8c6016650f7c900460b22d))
* **api:** localize credit checkout database ownership ([#38133](https://github.com/okou-ai/okou/issues/38133)) ([c903605](https://github.com/okou-ai/okou/commit/c903605cc80af3f68c9896ccf65203a53adcd9ec)), closes [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** make plan purchase exclusion a pure sql builder ([#38151](https://github.com/okou-ai/okou/issues/38151)) ([669d03a](https://github.com/okou-ai/okou/commit/669d03a9cb7ad9b8db0f8c936dbef3a4c7b2f823)), closes [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** migrate auxiliary gemini generation to vertex ai ([#37792](https://github.com/okou-ai/okou/issues/37792)) ([7d5660d](https://github.com/okou-ai/okou/commit/7d5660d2fabe4497b352b4a74e77ac0ab67ffa3c))
* **api:** migrate projection readers to slug-first current entries ([#37808](https://github.com/okou-ai/okou/issues/37808)) ([8850112](https://github.com/okou-ai/okou/commit/88501125e1390528e09386d3148028c32c82ba65))
* **api:** migrate scoped connector selections to immutable entries ([#37699](https://github.com/okou-ai/okou/issues/37699)) ([f413782](https://github.com/okou-ai/okou/commit/f4137823742879fcc8f74b476734d18e8480e15c))
* **api:** move desktop version policy into source control ([#38372](https://github.com/okou-ai/okou/issues/38372)) ([0d20c41](https://github.com/okou-ai/okou/commit/0d20c414e1cefa1642d8eed98f2eb15fc5a97499))
* **api:** own agent builtin connector configuration writes ([#37729](https://github.com/okou-ai/okou/issues/37729)) ([2edb8d8](https://github.com/okou-ai/okou/commit/2edb8d8f0bde8bcf1ebb89388c08e31bcecdc9de))
* **api:** own agent instruction lifecycle transactions ([#38172](https://github.com/okou-ai/okou/issues/38172)) ([e15eeea](https://github.com/okou-ai/okou/commit/e15eeeac9ea25d50335d408ccec3572072e3e6e1))
* **api:** own atomic pi memory stage1 result commits ([#38202](https://github.com/okou-ai/okou/issues/38202)) ([bf452e6](https://github.com/okou-ai/okou/commit/bf452e611c290a8284fb44dcbfcb8f213529df8d))
* **api:** own automation watch source queries ([#38203](https://github.com/okou-ai/okou/issues/38203)) ([5a9c95d](https://github.com/okou-ai/okou/commit/5a9c95daa2ae539adb63ba12f2213e40fd2023f7))
* **api:** own canonical asset state and input registration ([#38052](https://github.com/okou-ai/okou/issues/38052)) ([93f9439](https://github.com/okou-ai/okou/commit/93f9439fe1c9a4425710825265d76df539a93623))
* **api:** own chat-run-finished budget and receipt reads ([#38271](https://github.com/okou-ai/okou/issues/38271)) ([424678d](https://github.com/okou-ai/okou/commit/424678d61fb1c53c073df6ea7d07f30796a0d25e))
* **api:** own completion initial run read ([#37732](https://github.com/okou-ai/okou/issues/37732)) ([6f073f9](https://github.com/okou-ai/okou/commit/6f073f9cf22637cceaa7715ed206f7014e511e64))
* **api:** own completion postcommit callback read ([#37717](https://github.com/okou-ai/okou/issues/37717)) ([caddf45](https://github.com/okou-ai/okou/commit/caddf459b1af9dedd4ab9ecc99d96bf228b720b0))
* **api:** own connector account default-transition writes ([#38276](https://github.com/okou-ai/okou/issues/38276)) ([9aae815](https://github.com/okou-ai/okou/commit/9aae815c4a30cea1f89ae133c54d5ed9922a3dac))
* **api:** own connector account deletion-impact reads ([#37743](https://github.com/okou-ai/okou/issues/37743)) ([fb850a0](https://github.com/okou-ai/okou/commit/fb850a0aa034404f573a778563a97d39312453c5))
* **api:** own connector account rename transaction queries ([#37704](https://github.com/okou-ai/okou/issues/37704)) ([0751216](https://github.com/okou-ai/okou/commit/075121653b2d7b1ab8d8a172b86ac287076f90b1))
* **api:** own connector authorization-target reads ([#38394](https://github.com/okou-ai/okou/issues/38394)) ([9d97dd2](https://github.com/okou-ai/okou/commit/9d97dd2090a9c5190093efb942f3090765a17206))
* **api:** own custom connector connected-account reads ([#37815](https://github.com/okou-ai/okou/issues/37815)) ([1094540](https://github.com/okou-ai/okou/commit/1094540ade0b2613c7b7c2fd364049a04cb4a9d2))
* **api:** own custom connector current-value marker reads ([#37753](https://github.com/okou-ai/okou/issues/37753)) ([4085a06](https://github.com/okou-ai/okou/commit/4085a06a91b5355b656e4d8d37e39172a8342a28))
* **api:** own custom oauth state preview reads ([#38189](https://github.com/okou-ai/okou/issues/38189)) ([91a7384](https://github.com/okou-ai/okou/commit/91a7384611dc0fc6d09fe30462e0a6674ca4100f))
* **api:** own discord cleanup and gateway lifecycle writes ([#38087](https://github.com/okou-ai/okou/issues/38087)) ([b73d44a](https://github.com/okou-ai/okou/commit/b73d44a9a9e52185c50f968ced4f5cfb12584093))
* **api:** own discord preview history writes ([#38417](https://github.com/okou-ai/okou/issues/38417)) ([b4e236f](https://github.com/okou-ai/okou/commit/b4e236fe839aa0e1c302a61054e875c61f68f961))
* **api:** own exact personal subscription response reads ([#38001](https://github.com/okou-ai/okou/issues/38001)) ([43a459d](https://github.com/okou-ai/okou/commit/43a459d7515045560e47ccb0abf66e35dce16274))
* **api:** own failed-run subscription recovery identity reads ([#38076](https://github.com/okou-ai/okou/issues/38076)) ([34fb156](https://github.com/okou-ai/okou/commit/34fb156b989d01cd6c1d382351db8957bab96e20))
* **api:** own google meet database access in signals ([#38040](https://github.com/okou-ai/okou/issues/38040)) ([eddec23](https://github.com/okou-ai/okou/commit/eddec239bfe6ae428d33800996f4286ace06bc06))
* **api:** own guarded sandbox storage replay version reads ([#37760](https://github.com/okou-ai/okou/issues/37760)) ([2521e92](https://github.com/okou-ai/okou/commit/2521e9231ef2dff5bc147580d93bea8405f8c874))
* **api:** own hosted-site reads and allocation queries ([#38218](https://github.com/okou-ai/okou/issues/38218)) ([2c1f7e7](https://github.com/okou-ai/okou/commit/2c1f7e7477a5ad5a72e2346bc78df2153c499d1c))
* **api:** own initial agent deletion read ([#37783](https://github.com/okou-ai/okou/issues/37783)) ([c0e8f66](https://github.com/okou-ai/okou/commit/c0e8f661e10f5d464cc271d97d95df904b13c196))
* **api:** own initial checkpoint run reads ([#37738](https://github.com/okou-ai/okou/issues/37738)) ([126a395](https://github.com/okou-ai/okou/commit/126a3957d91de7872daeaf892a8acb604b0ba0f6))
* **api:** own initial sandbox storage receipt reads ([#37748](https://github.com/okou-ai/okou/issues/37748)) ([1fc92ce](https://github.com/okou-ai/okou/commit/1fc92ce471a5700c6eb4bae9cb144f435e3e60c2))
* **api:** own morning brief preference reads ([#38211](https://github.com/okou-ai/okou/issues/38211)) ([e421739](https://github.com/okou-ai/okou/commit/e42173971274448bcc8afb541cc4b7208bfe80e2))
* **api:** own oauth completion receipt reads ([#38302](https://github.com/okou-ai/okou/issues/38302)) ([bcbdb54](https://github.com/okou-ai/okou/commit/bcbdb54cd47bb83e43e4738097724c9c2ebc47d5))
* **api:** own oauth completion receipt writes ([#38349](https://github.com/okou-ai/okou/issues/38349)) ([d73778c](https://github.com/okou-ai/okou/commit/d73778c30b09c35fcd6ae4d7bef943e19872bdac))
* **api:** own official catalog execution reads ([#38195](https://github.com/okou-ai/okou/issues/38195)) ([7fad614](https://github.com/okou-ai/okou/commit/7fad61491780e3eb0d1be79353e6ec1ef056160f))
* **api:** own official result email callback sources ([#38220](https://github.com/okou-ai/okou/issues/38220)) ([21abaa2](https://github.com/okou-ai/okou/commit/21abaa2843c193c4928ce7e907f16feb529d2db2))
* **api:** own official workflow catalog publication ([#38033](https://github.com/okou-ai/okou/issues/38033)) ([11e3830](https://github.com/okou-ai/okou/commit/11e383050897d7d63f36d0aaf8bb1796e73ec018))
* **api:** own official workflow installation writes ([#38050](https://github.com/okou-ai/okou/issues/38050)) ([cfe934c](https://github.com/okou-ai/okou/commit/cfe934c79e7220da9c9a7913186ebd8ccbc5036a))
* **api:** own official workflow reconciliation commands ([#38056](https://github.com/okou-ai/okou/issues/38056)) ([1f88668](https://github.com/okou-ai/okou/commit/1f8866885baf48dcbfbf11cca37def52529cfc49))
* **api:** own official workflow reconciliation transactions ([#38170](https://github.com/okou-ai/okou/issues/38170)) ([7fdd681](https://github.com/okou-ai/okou/commit/7fdd6812fb11c08d244b3eca9ee18d7edf067112))
* **api:** own parallel agent connector scope reads ([#38117](https://github.com/okou-ai/okou/issues/38117)) ([7fe8278](https://github.com/okou-ai/okou/commit/7fe8278fb7dc3581f50bf8d77d7cd19fbb9db8e0))
* **api:** own permission-grant list database reads ([#37910](https://github.com/okou-ai/okou/issues/37910)) ([1a4cbda](https://github.com/okou-ai/okou/commit/1a4cbda1d901006994149202b74d5135d8b74f6d))
* **api:** own personal subscription account activation queries ([#37949](https://github.com/okou-ai/okou/issues/37949)) ([9206b1c](https://github.com/okou-ai/okou/commit/9206b1cff0529de4f84d6283823c8658df0a57f6))
* **api:** own personal subscription account-list reads ([#37923](https://github.com/okou-ai/okou/issues/37923)) ([0588672](https://github.com/okou-ai/okou/commit/0588672c5341c997f3074eab210c640329fa6a9e))
* **api:** own pi maintenance preparation snapshots ([#38205](https://github.com/okou-ai/okou/issues/38205)) ([eb2214d](https://github.com/okou-ai/okou/commit/eb2214d14903c83b68e06518debf70dabad82b3b))
* **api:** own pi memory maintenance admission transactions ([#38214](https://github.com/okou-ai/okou/issues/38214)) ([aa2cbc3](https://github.com/okou-ai/okou/commit/aa2cbc3700fbad19a43f3eef1492bca094e7523a))
* **api:** own pi memory phase2 claim transaction ([#38055](https://github.com/okou-ai/okou/issues/38055)) ([b917942](https://github.com/okou-ai/okou/commit/b91794262fa14780372d3cc5bb5c1b1fddbf18b7))
* **api:** own pi memory phase2 terminal observation ([#38054](https://github.com/okou-ai/okou/issues/38054)) ([e84363a](https://github.com/okou-ai/okou/commit/e84363a75b9e0236edf8e96c27f1b9a1d938cb08))
* **api:** own pi memory provider admission ([#38292](https://github.com/okou-ai/okou/issues/38292)) ([37d4265](https://github.com/okou-ai/okou/commit/37d426591dcb5d7aff864044468ea2148d89b6d1))
* **api:** own pi memory quota reads ([#38061](https://github.com/okou-ai/okou/issues/38061)) ([e75dacd](https://github.com/okou-ai/okou/commit/e75dacdb59c2bdc019b28f8742c3d19c7824bde8))
* **api:** own pi memory scheduling and claim transactions ([#38269](https://github.com/okou-ai/okou/issues/38269)) ([cdeec87](https://github.com/okou-ai/okou/commit/cdeec8712c65b885ed8b9c8e62c50a0127d6783f))
* **api:** own pi memory stage 1 preflight queries ([#38226](https://github.com/okou-ai/okou/issues/38226)) ([1cd9eff](https://github.com/okou-ai/okou/commit/1cd9eff56f912f5c177c6fe63e6ab19f2ee3693a))
* **api:** own pi memory stage1 accounting ([#38053](https://github.com/okou-ai/okou/issues/38053)) ([2371910](https://github.com/okou-ai/okou/commit/2371910b887fca12b4220ae7941d84a588e3c656))
* **api:** own pi memory stage1 credential commands ([#38210](https://github.com/okou-ai/okou/issues/38210)) ([9ee013b](https://github.com/okou-ai/okou/commit/9ee013bab9e2f3a53e2d063816955b84c6d66fb5))
* **api:** own pi phase2 recovery reads ([#37710](https://github.com/okou-ai/okou/issues/37710)) ([1931f04](https://github.com/okou-ai/okou/commit/1931f04221f64f604ccb1c6791c94bef111c94ed))
* **api:** own private artifact preview cache operations ([#38156](https://github.com/okou-ai/okou/issues/38156)) ([b2d4bb3](https://github.com/okou-ai/okou/commit/b2d4bb32f4c1c3915edb2608998711c4b3a68bb1))
* **api:** own private artifact reads and reference resolution ([#38078](https://github.com/okou-ai/okou/issues/38078)) ([88d0941](https://github.com/okou-ai/okou/commit/88d0941e21a956a49efe69e8d7cf5b88b21de381))
* **api:** own remaining hosted-site transaction queries ([#38225](https://github.com/okou-ai/okou/issues/38225)) ([7982faf](https://github.com/okou-ai/okou/commit/7982faf50f4936909ccc6d0c107d371e74c613d4))
* **api:** own required terminal chat callback reads ([#37707](https://github.com/okou-ai/okou/issues/37707)) ([b190ff1](https://github.com/okou-ai/okou/commit/b190ff107eb5d387ee9b4eab6b42136b335a720d))
* **api:** own resource projection worker transactions ([#38012](https://github.com/okou-ai/okou/issues/38012)) ([0157b0f](https://github.com/okou-ai/okou/commit/0157b0fce6ffd2bab89704aa188a3be93f60d6f8))
* **api:** own runner notification preference reads ([#38222](https://github.com/okou-ai/okou/issues/38222)) ([8048b62](https://github.com/okou-ai/okou/commit/8048b6290029e27a1f1fd36a0dd04d24e8e5eb85))
* **api:** own skill storage publication transactions ([#38060](https://github.com/okou-ai/okou/issues/38060)) ([36ca5da](https://github.com/okou-ai/okou/commit/36ca5da3245592c9c3c422311458d6ccf24340a2))
* **api:** own storage commit publication ([#38154](https://github.com/okou-ai/okou/issues/38154)) ([bcc9507](https://github.com/okou-ai/okou/commit/bcc9507ad9b444b85abd45634642a452c10b328b))
* **api:** own storage preparation admission reads ([#38039](https://github.com/okou-ai/okou/issues/38039)) ([d6a2727](https://github.com/okou-ai/okou/commit/d6a27272a7406aa8aca409aed4ecc23a855b1f7e))
* **api:** own stripe deauthorization ingress ([#38142](https://github.com/okou-ai/okou/issues/38142)) ([5d0324c](https://github.com/okou-ai/okou/commit/5d0324c25bfd050409a0694d98d820b58252c5e0))
* **api:** own stripe delivery claim and outcome commands ([#38086](https://github.com/okou-ai/okou/issues/38086)) ([297d230](https://github.com/okou-ai/okou/commit/297d230fec2f460e55b301e5e409f82e7f0da2ef))
* **api:** own stripe invoice fanout transaction ([#38305](https://github.com/okou-ai/okou/issues/38305)) ([0826bc3](https://github.com/okou-ai/okou/commit/0826bc32f2787c00bec30e1f0e6b86a18c27c04e))
* **api:** own stripe pending delivery reads ([#38325](https://github.com/okou-ai/okou/issues/38325)) ([2e7b4eb](https://github.com/okou-ai/okou/commit/2e7b4ebcd7c8fb5d2150f08fc188630aac35bff3))
* **api:** own terminal sandbox storage lineage reads ([#37789](https://github.com/okou-ai/okou/issues/37789)) ([a1a3e19](https://github.com/okou-ai/okou/commit/a1a3e19104a04a226a5916ef61e745e20ea15f4b))
* **api:** own terminal sandbox storage version reads ([#37782](https://github.com/okou-ai/okou/issues/37782)) ([2fe6f11](https://github.com/okou-ai/okou/commit/2fe6f11be34ab296e93ad4193d18dd4a192bb4fa))
* **api:** own uploaded-file writes and catalog handoffs ([#38016](https://github.com/okou-ai/okou/issues/38016)) ([d953cf8](https://github.com/okou-ai/okou/commit/d953cf8f2c8d1848d26c280a16c350c3b401609b))
* **api:** own volume preparation and instruction publication ([#38028](https://github.com/okou-ai/okou/issues/38028)) ([401ba2d](https://github.com/okou-ai/okou/commit/401ba2d4565f9d3aaac6fa7f50009ec7f7075890))
* **api:** own volume publication fences and cleanup ([#38042](https://github.com/okou-ai/okou/issues/38042)) ([8b2e3d0](https://github.com/okou-ai/okou/commit/8b2e3d09603ee6c56c6e62a64f86cc4720b0ba1f))
* **api:** own workflow automation creation commits ([#38036](https://github.com/okou-ai/okou/issues/38036)) ([98b19e3](https://github.com/okou-ai/okou/commit/98b19e30b9b52955eabb45296fa7186712bb7483))
* **api:** own workflow automation enable and stripe commits ([#38191](https://github.com/okou-ai/okou/issues/38191)) ([b07bc3a](https://github.com/okou-ai/okou/commit/b07bc3a54c75efe9205afc7614d3c8f936a32d67))
* **api:** own workflow automation reads ([#38048](https://github.com/okou-ai/okou/issues/38048)) ([a01abf6](https://github.com/okou-ai/okou/commit/a01abf616a49a15fb23b7fdbaeceeb548c5f9521))
* **api:** own workflow catalog list and deletion queries ([#38216](https://github.com/okou-ai/okou/issues/38216)) ([774706e](https://github.com/okou-ai/okou/commit/774706e3d0b05ff5358c06ed6bc41df2824185c6))
* **api:** own workflow copy publication ([#38223](https://github.com/okou-ai/okou/issues/38223)) ([b4c06fd](https://github.com/okou-ai/okou/commit/b4c06fde2d6d95b129f63b83661e488e49dd71f2))
* **api:** own workflow creation and visibility transactions ([#38229](https://github.com/okou-ai/okou/issues/38229)) ([2de5358](https://github.com/okou-ai/okou/commit/2de53581b7fac3059e31c58ffe8aae392b58dc8d))
* **api:** own workflow metadata commits and simplify gmail updates ([#38011](https://github.com/okou-ai/okou/issues/38011)) ([4824eff](https://github.com/okou-ai/okou/commit/4824eff35f768456096b89ac19bfb287056d1243))
* **api:** own workflow visibility, profile and thread reads ([#38237](https://github.com/okou-ai/okou/issues/38237)) ([1fec562](https://github.com/okou-ai/okou/commit/1fec56212453e7e84125f20336924138551ad793))
* **api:** own workflow webhook dispatch reads ([#38280](https://github.com/okou-ai/okou/issues/38280)) ([3dcf096](https://github.com/okou-ai/okou/commit/3dcf096997cdd5448a74df524afba9a2ac46df91))
* **api:** prebuild billing restore auth wrapper ([#38173](https://github.com/okou-ai/okou/issues/38173)) ([7f53c7a](https://github.com/okou-ai/okou/commit/7f53c7a44fbec83ba15cf7fa4356376258ffca92)), closes [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** publish artifact shares outside database transactions ([#38038](https://github.com/okou-ai/okou/issues/38038)) ([1a317a4](https://github.com/okou-ai/okou/commit/1a317a4964ad8906894e150b13b21b3373871040))
* **api:** read chat projections without historical runs ([#37765](https://github.com/okou-ai/okou/issues/37765)) ([dc7a9e7](https://github.com/okou-ai/okou/commit/dc7a9e7ef8b3c30ee3b1c828228bdd25b78e23c5))
* **api:** read member usage in one statement ([#38425](https://github.com/okou-ai/okou/issues/38425)) ([b48cdb3](https://github.com/okou-ai/okou/commit/b48cdb3d1745971ce2fd0f70fbb7791eb74f0938))
* **api:** remove mcp input snapshot transaction ([#38287](https://github.com/okou-ai/okou/issues/38287)) ([803ede6](https://github.com/okou-ai/okou/commit/803ede641fb73f38a56c8d799d25bbe14d4def6a))
* **api:** remove oauth contract hash bindings ([#38190](https://github.com/okou-ai/okou/issues/38190)) ([3e0f689](https://github.com/okou-ai/okou/commit/3e0f689475709a63a8ed534d11f34e583e8ac3f6))
* **api:** remove retired native morning brief guards ([#38404](https://github.com/okou-ai/okou/issues/38404)) ([f22b41a](https://github.com/okou-ai/okou/commit/f22b41ab59d91859c61a7c12a9a9814aac7970d4))
* **api:** remove stripe deauthorization transaction ([#38413](https://github.com/okou-ai/okou/issues/38413)) ([5ce389e](https://github.com/okou-ai/okou/commit/5ce389edded62e26ac57bad4aee56af7103559a5))
* **api:** remove unused pi stable-context and report delisted connectors absent ([#37905](https://github.com/okou-ai/okou/issues/37905)) ([c339e73](https://github.com/okou-ai/okou/commit/c339e73f0fb5d0ca0a8f4a4e80c67331ea9fb79d))
* **api:** resolve queued connector permissions from current catalog ([#38066](https://github.com/okou-ai/okou/issues/38066)) ([865afb7](https://github.com/okou-ai/okou/commit/865afb7a05d413c9db56713035a373ebaa767672))
* **api:** retain artifacts independently of run deletion ([#37772](https://github.com/okou-ai/okou/issues/37772)) ([3921e38](https://github.com/okou-ai/okou/commit/3921e386f222a169e97c10046156758cc4e510b0))
* **api:** retire automatic morning brief enrollment ([#38095](https://github.com/okou-ai/okou/issues/38095)) ([d1076b6](https://github.com/okou-ai/okou/commit/d1076b64322892d680dce0ef9ed835d53ebf57e3))
* **api:** retire batch 017 private test fixtures ([#38235](https://github.com/okou-ai/okou/issues/38235)) ([a218941](https://github.com/okou-ai/okou/commit/a2189418b48f7dab6b8d5b9237f7d4c6bfd20d4e))
* **api:** retire native morning brief storage dependencies ([#37874](https://github.com/okou-ai/okou/issues/37874)) ([094ef4c](https://github.com/okou-ai/okou/commit/094ef4c402089b1acdcafede8af8f7e081506d2f))
* **api:** retire official workflow queue markers ([#38365](https://github.com/okou-ai/okou/issues/38365)) ([1b0d4ec](https://github.com/okou-ai/okou/commit/1b0d4ec16fa782e6a5b0e01d899ce339acb6aa6a))
* **api:** retire workflow automation worker test endpoints ([#37904](https://github.com/okou-ai/okou/issues/37904)) ([1375381](https://github.com/okou-ai/okou/commit/13753817e6507ac8b71315166dac807a87711c4c))
* **api:** separate automation lifecycle from event dispatch ([#38199](https://github.com/okou-ai/okou/issues/38199)) ([d0e80d5](https://github.com/okou-ai/okou/commit/d0e80d56313dbbfb5a1c11d72c1e44eb3b0a357b))
* **api:** simplify member onboarding activity check ([#38419](https://github.com/okou-ai/okou/issues/38419)) ([2c56120](https://github.com/okou-ai/okou/commit/2c56120d5792b42c74c96bb7898eed5f6c1fa490))
* **api:** statically own official workflow reconciliation ([#38208](https://github.com/okou-ai/okou/issues/38208)) ([628d2e8](https://github.com/okou-ai/okou/commit/628d2e83be3dcf21b7806bb482c75bcb73f904e3))
* **api:** unify run prompts and skill volumes ([#38332](https://github.com/okou-ai/okou/issues/38332)) ([8d665ee](https://github.com/okou-ai/okou/commit/8d665ee2524394819205c6f3d69888f6436addb8))
* **api:** unify test projects with per-case database isolation ([#37896](https://github.com/okou-ai/okou/issues/37896)) ([28c0ec4](https://github.com/okou-ai/okou/commit/28c0ec43505f5032b005505d92c5e7c6d74d8a03))
* **api:** use bounded s3 command for stage1 history ([#38316](https://github.com/okou-ai/okou/issues/38316)) ([6bd5cc8](https://github.com/okou-ai/okou/commit/6bd5cc8ca6e6e6613c84f8791a0b5144f30426de))
* **api:** use canonical official workflow queue contexts ([#38049](https://github.com/okou-ai/okou/issues/38049)) ([76c17bc](https://github.com/okou-ai/okou/commit/76c17bcc4048d9aff4907477012172c364a66e5c))
* **api:** use client-only platform realtime token exchange ([#38105](https://github.com/okou-ai/okou/issues/38105)) ([0fdfb57](https://github.com/okou-ai/okou/commit/0fdfb57b88d655219e84f18050a88362071cdd41))
* **api:** use fixed commands for canonical input imports ([#38062](https://github.com/okou-ai/okou/issues/38062)) ([f8299d6](https://github.com/okou-ai/okou/commit/f8299d6a5d49657caf7ba1c033f1b33cb52c1ffb))
* **api:** use static bounded reads for memory summaries ([#38204](https://github.com/okou-ai/okou/issues/38204)) ([13d9bc2](https://github.com/okou-ai/okou/commit/13d9bc248c60f520893f145c9e5ed38617f89e56))
* **artifacts:** remove video poster extraction ([#38146](https://github.com/okou-ai/okou/issues/38146)) ([641cf0d](https://github.com/okou-ai/okou/commit/641cf0ddff6c631cf94386e6c3d26c78395c63aa))
* **artifacts:** use artifact identity for google drive uploads ([#38300](https://github.com/okou-ai/okou/issues/38300)) ([e223f5e](https://github.com/okou-ai/okou/commit/e223f5e45fd22cdd729f84f075686ec5afb24b6e))
* assemble current run inputs without agent configuration ([#38004](https://github.com/okou-ai/okou/issues/38004)) ([22efd4b](https://github.com/okou-ai/okou/commit/22efd4b6b34872c0585a0d4c3778cb3b59d9d100))
* clean up released switch leftovers and drop legacy chat thread provider pins ([#37851](https://github.com/okou-ai/okou/issues/37851)) ([066e9c3](https://github.com/okou-ai/okou/commit/066e9c32c2bbd5e3d48783fb0028f8dcfbaeaf06))
* **computer-use:** remove retired desktop plugins ([#37980](https://github.com/okou-ai/okou/issues/37980)) ([8b8928c](https://github.com/okou-ai/okou/commit/8b8928cdf85d4fb2243a9326194d7cfb3936d53c))
* contract connector catalog storage to pointer and immutable entries ([#37886](https://github.com/okou-ai/okou/issues/37886)) ([baf302f](https://github.com/okou-ai/okou/commit/baf302f5373a000999dfde0abf521752a779e29c))
* **discord:** derive message content from application grants ([#38377](https://github.com/okou-ai/okou/issues/38377)) ([a69a248](https://github.com/okou-ai/okou/commit/a69a2485e449109886f80bf37d49ece61f750230))
* finish connector catalog release 2 follow-up cleanup ([#37895](https://github.com/okou-ai/okou/issues/37895)) ([013d37d](https://github.com/okou-ai/okou/commit/013d37d5513f5ff071097621e4436109742f6dc8))
* graduate fully rolled out feature switches ([#37721](https://github.com/okou-ai/okou/issues/37721)) ([62e6dd4](https://github.com/okou-ai/okou/commit/62e6dd43c07ccfd77517d6f653ab123a37aff89f))
* move release 1 connector catalog consumers off legacy storage ([#37861](https://github.com/okou-ai/okou/issues/37861)) ([e664957](https://github.com/okou-ai/okou/commit/e664957caa2056a336595e55f475001b81247fd0))
* prepare payload-independent connector catalog api ([#38099](https://github.com/okou-ai/okou/issues/38099)) ([9d3a1b4](https://github.com/okou-ai/okou/commit/9d3a1b406f1f44b224c33046162df01a77e035f8))
* read connector catalogs from immutable entries ([#37820](https://github.com/okou-ai/okou/issues/37820)) ([562e53f](https://github.com/okou-ai/okou/commit/562e53fdeb02c8feb1f131f0f8629bc84bf1f2d0))
* remove abandoned langfuse trace feature ([#38010](https://github.com/okou-ai/okou/issues/38010)) ([5080d02](https://github.com/okou-ai/okou/commit/5080d026e68f10f41285570f52a9b655fb562052))
* remove agent responsibility setup feature switch ([#38069](https://github.com/okou-ai/okou/issues/38069)) ([bbb313e](https://github.com/okou-ai/okou/commit/bbb313e561cf6904565d5b91e7e227e2016557ee))
* remove all remaining custom model mode awareness ([#37856](https://github.com/okou-ai/okou/issues/37856)) ([f383835](https://github.com/okou-ai/okou/commit/f3838353ba0455ec7d57dfa2d0974e34a44796ff))
* remove connector catalog diagnostics endpoint and cron response fields ([#37907](https://github.com/okou-ai/okou/issues/37907)) ([0d2b5d1](https://github.com/okou-ai/okou/commit/0d2b5d1a7bae269f2fcac0bf23f7ae377df07244))
* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))
* remove eleven released feature switches ([#37848](https://github.com/okou-ai/okou/issues/37848)) ([53255d6](https://github.com/okou-ai/okou/commit/53255d66854676285dad37eb13b3266ebe578031))
* remove expired deployment compatibility ([#38219](https://github.com/okou-ai/okou/issues/38219)) ([303f42b](https://github.com/okou-ai/okou/commit/303f42bafd0d70928c477dc87a5f25fdc00db6d7))
* remove monday connector feature switch ([#38334](https://github.com/okou-ai/okou/issues/38334)) ([fb8f2d3](https://github.com/okou-ai/okou/commit/fb8f2d3b1474385d7fb0d44594b883919c33c62e))
* remove pi openrouter chat completions feature switch ([#38096](https://github.com/okou-ai/okou/issues/38096)) ([a635ec3](https://github.com/okou-ai/okou/commit/a635ec3afa20cdb5df9c8125afe6cec24ef53e16))
* remove plaud connector feature switch ([#38412](https://github.com/okou-ai/okou/issues/38412)) ([b9fccfb](https://github.com/okou-ai/okou/commit/b9fccfbae83bf7f61da74832a19287c8e964ffde))
* remove remaining model provider residue ([#37870](https://github.com/okou-ai/okou/issues/37870)) ([a93133b](https://github.com/okou-ai/okou/commit/a93133b0493858a39924a1206ff5a5677e43cad6))
* remove retired per-agent ssh access traces ([#37876](https://github.com/okou-ai/okou/issues/37876)) ([dc33264](https://github.com/okou-ai/okou/commit/dc332649051e79460f1075a294ba8d3707f8504f))
* represent auto model selection as null ([#37901](https://github.com/okou-ai/okou/issues/37901)) ([d0e0b71](https://github.com/okou-ai/okou/commit/d0e0b7191fe168e8935e1abf3df1fa1806efea2a))
* retire claude code manual usage reset ([#37755](https://github.com/okou-ai/okou/issues/37755)) ([1855ed7](https://github.com/okou-ai/okou/commit/1855ed7f5d58c7aa931a6acc27f2fa375edc395f))
* retire cooldown, ultrafast, us routing and model provider leftovers ([#37884](https://github.com/okou-ai/okou/issues/37884)) ([a9c3270](https://github.com/okou-ai/okou/commit/a9c3270099034c0f7ee73f6c730b07efa7d1d733))
* retire deepseek memory execution route ([#38193](https://github.com/okou-ai/okou/issues/38193)) ([dd70bd4](https://github.com/okou-ai/okou/commit/dd70bd4b01bd2ee0dbfbe748940544e5e072bf5a))
* retire generic run checkpoints from completion ([#38147](https://github.com/okou-ai/okou/issues/38147)) ([e8002cf](https://github.com/okou-ai/okou/commit/e8002cfcc9995e2b245947dbf25a9f9dd73f1ca0))
* retire organization custom model configuration ([#37746](https://github.com/okou-ai/okou/issues/37746)) ([014fe18](https://github.com/okou-ai/okou/commit/014fe1867c6d1830fd35b03c3d77491da5aaa36a))
* retire organization usage allowance ([#37971](https://github.com/okou-ai/okou/issues/37971)) ([2659878](https://github.com/okou-ai/okou/commit/26598788903fb817edd71d82ccbdfcd66cfa3a0a))
* **ssh:** make metadata rename an atomic statement ([#38284](https://github.com/okou-ai/okou/issues/38284)) ([9da771d](https://github.com/okou-ai/okou/commit/9da771dd0928a7a83f81a418ec3a93cc3da17f0d))


### Performance Improvements

* **api:** avoid eager full catalog reads during run bootstrap ([#37769](https://github.com/okou-ai/okou/issues/37769)) ([c1c2d77](https://github.com/okou-ai/okou/commit/c1c2d77ab51b38acf91008b2c60937ac2c29cda3))
* **api:** consolidate global and identity context reads before enqueue ([#37885](https://github.com/okou-ai/okou/issues/37885)) ([3a37588](https://github.com/okou-ai/okou/commit/3a375883212f6264b4ef133faae1ae92d7d4b5bb))
* **api:** isolate declaration-heavy typecheck stages ([#37722](https://github.com/okou-ai/okou/issues/37722)) ([2f0d4c2](https://github.com/okou-ai/okou/commit/2f0d4c25f7935c88f362192a38dffb622e197686))
* **api:** read connector catalog entries by slug on runtime hot paths ([#37903](https://github.com/okou-ai/okou/issues/37903)) ([f8a3a9b](https://github.com/okou-ai/okou/commit/f8a3a9b1f0bb44a30c5f443273439069332903a3))
* **api:** read connector catalog from purpose-specific columns ([#37900](https://github.com/okou-ai/okou/issues/37900)) ([8c38a39](https://github.com/okou-ai/okou/commit/8c38a399d41d0786e6450e78a897d1de01892a58))
* **api:** reduce mcp input observation reads ([#37921](https://github.com/okou-ai/okou/issues/37921)) ([b4497cd](https://github.com/okou-ai/okou/commit/b4497cd5a05367fd6ee6fde0d5a4d2c98bfb3ae9))
* **ci:** bound api preview connector catalog initialization ([#37790](https://github.com/okou-ai/okou/issues/37790)) ([d6300c1](https://github.com/okou-ai/okou/commit/d6300c15d49be1602c846acfc82b96f60caed4ea))
* **ssh:** narrow cloudflare rename locks and reference reloads ([#38003](https://github.com/okou-ai/okou/issues/38003)) ([191ca92](https://github.com/okou-ai/okou/commit/191ca92a931d80acc4a55b750b3b5275863e08df))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.546.0
    * @okouai/core bumped to 8.739.0
    * @okouai/db bumped to 1.328.0
    * @okouai/pi-agent-runtime bumped to 1.49.0

## [1.720.1](https://github.com/okou-ai/okou/compare/api-v1.720.0...api-v1.720.1) (2026-10-09)


### Refactoring

* **discord:** derive message content from application grants ([#38377](https://github.com/okou-ai/okou/issues/38377)) ([a69a248](https://github.com/okou-ai/okou/commit/a69a2485e449109886f80bf37d49ece61f750230))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.545.1
    * @okouai/core bumped to 8.738.1
    * @okouai/db bumped to 1.327.1
    * @okouai/pi-agent-runtime bumped to 1.48.3

## [1.720.0](https://github.com/okou-ai/okou/compare/api-v1.719.0...api-v1.720.0) (2026-10-09)


### Features

* add sandbox covers for hosted artifacts ([#38149](https://github.com/okou-ai/okou/issues/38149)) ([f4a3140](https://github.com/okou-ai/okou/commit/f4a3140275a8c3334135080ed2427e837bc9fc89))
* **api:** prepare home cache affinity and runner state ([#38314](https://github.com/okou-ai/okou/issues/38314)) ([21ce097](https://github.com/okou-ai/okou/commit/21ce0978ad9a5bc7eddb94bc9d2bc25f1897095f))


### Refactoring

* **api:** build pi cleanup predicates without db handles ([#38333](https://github.com/okou-ai/okou/issues/38333)) ([9f09dc5](https://github.com/okou-ai/okou/commit/9f09dc556b34a95eaae3668436274da8ec0cc40f))
* **api:** inline clerk lifecycle transaction ownership ([#38171](https://github.com/okou-ai/okou/issues/38171)) ([50f91be](https://github.com/okou-ai/okou/commit/50f91befb0bacd4d7c166ace839251a648bd4bf9)), closes [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** move desktop version policy into source control ([#38372](https://github.com/okou-ai/okou/issues/38372)) ([0d20c41](https://github.com/okou-ai/okou/commit/0d20c414e1cefa1642d8eed98f2eb15fc5a97499))
* **api:** own discord cleanup and gateway lifecycle writes ([#38087](https://github.com/okou-ai/okou/issues/38087)) ([b73d44a](https://github.com/okou-ai/okou/commit/b73d44a9a9e52185c50f968ced4f5cfb12584093))
* **api:** own oauth completion receipt writes ([#38349](https://github.com/okou-ai/okou/issues/38349)) ([d73778c](https://github.com/okou-ai/okou/commit/d73778c30b09c35fcd6ae4d7bef943e19872bdac))
* **api:** prebuild billing restore auth wrapper ([#38173](https://github.com/okou-ai/okou/issues/38173)) ([7f53c7a](https://github.com/okou-ai/okou/commit/7f53c7a44fbec83ba15cf7fa4356376258ffca92)), closes [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** retire official workflow queue markers ([#38365](https://github.com/okou-ai/okou/issues/38365)) ([1b0d4ec](https://github.com/okou-ai/okou/commit/1b0d4ec16fa782e6a5b0e01d899ce339acb6aa6a))
* **api:** unify run prompts and skill volumes ([#38332](https://github.com/okou-ai/okou/issues/38332)) ([8d665ee](https://github.com/okou-ai/okou/commit/8d665ee2524394819205c6f3d69888f6436addb8))
* remove monday connector feature switch ([#38334](https://github.com/okou-ai/okou/issues/38334)) ([fb8f2d3](https://github.com/okou-ai/okou/commit/fb8f2d3b1474385d7fb0d44594b883919c33c62e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.545.0
    * @okouai/core bumped to 8.738.0
    * @okouai/db bumped to 1.327.0
    * @okouai/pi-agent-runtime bumped to 1.48.2

## [1.719.0](https://github.com/okou-ai/okou/compare/api-v1.718.0...api-v1.719.0) (2026-10-09)


### Features

* allow debug admins to switch organization openrouter presets ([#38327](https://github.com/okou-ai/okou/issues/38327)) ([3ab4dfc](https://github.com/okou-ai/okou/commit/3ab4dfc68ffdf7afe085c52e3cf9040354c117d9))


### Refactoring

* **api:** own oauth completion receipt reads ([#38302](https://github.com/okou-ai/okou/issues/38302)) ([bcbdb54](https://github.com/okou-ai/okou/commit/bcbdb54cd47bb83e43e4738097724c9c2ebc47d5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.544.0
    * @okouai/core bumped to 8.737.3
    * @okouai/db bumped to 1.326.3
    * @okouai/pi-agent-runtime bumped to 1.48.1

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
