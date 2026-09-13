# Changelog

## [0.89.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.89.5...guest-agent-v0.89.6) (2026-09-12)

## [0.89.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.89.4...guest-agent-v0.89.5) (2026-09-11)


### Refactoring

* **api:** make pi api-first transitions explicit ([#33580](https://github.com/vm0-ai/vm0/issues/33580)) ([de15084](https://github.com/vm0-ai/vm0/commit/de15084436e6936d2a7338cd75d916f11cdd81e7))

## [0.89.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.89.3...guest-agent-v0.89.4) (2026-09-11)


### Bug Fixes

* **guest-agent:** bound pi and codex event delivery ([#33532](https://github.com/vm0-ai/vm0/issues/33532)) ([c42da19](https://github.com/vm0-ai/vm0/commit/c42da19f700479f51954f2012106a211fe4f97c6))

## [0.89.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.89.2...guest-agent-v0.89.3) (2026-09-11)

## [0.89.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.89.1...guest-agent-v0.89.2) (2026-09-11)

## [0.89.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.89.0...guest-agent-v0.89.1) (2026-09-11)


### Bug Fixes

* **guest-agent:** keep oom evidence waits off tokio workers ([#33396](https://github.com/vm0-ai/vm0/issues/33396)) ([0c7a535](https://github.com/vm0-ai/vm0/commit/0c7a535c995853acc1226a0c9815baecc3f0b870))

## [0.89.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.88.3...guest-agent-v0.89.0) (2026-09-11)


### Features

* **chat:** add native reasoning effort controls ([#33016](https://github.com/vm0-ai/vm0/issues/33016)) ([f649925](https://github.com/vm0-ai/vm0/commit/f649925cbb81c11ee5b66d32bcc6072fc2fe80c2))

## [0.88.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.88.2...guest-agent-v0.88.3) (2026-09-10)

## [0.88.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.88.1...guest-agent-v0.88.2) (2026-09-10)


### Bug Fixes

* **guest-agent:** handle closed telemetry incident channels ([#33276](https://github.com/vm0-ai/vm0/issues/33276)) ([055afa8](https://github.com/vm0-ai/vm0/commit/055afa8a6b78c32ea4b10ef4fe5735ae33a9118e))
* **pi:** keep model failures actionable when an upstream returns a document ([#33249](https://github.com/vm0-ai/vm0/issues/33249)) ([76eb46f](https://github.com/vm0-ai/vm0/commit/76eb46f0b78b846fc5a1f3a8a3e6a18a2b327aab))
* **runner:** report the real termination reason for oom-killed agent runs ([#33240](https://github.com/vm0-ai/vm0/issues/33240)) ([f695c77](https://github.com/vm0-ai/vm0/commit/f695c77cd45566553f8b01d0c2f484909cebfc70))

## [0.88.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.88.0...guest-agent-v0.88.1) (2026-09-10)


### Bug Fixes

* **guest-agent:** allow sequential pi inputs after settled handoff ([#33125](https://github.com/vm0-ai/vm0/issues/33125)) ([6143533](https://github.com/vm0-ai/vm0/commit/614353302507b8e3f9ab35aa25f5c5a121359679))
* **guest-agent:** classify upstream content policy rejections ([#33180](https://github.com/vm0-ai/vm0/issues/33180)) ([f61db10](https://github.com/vm0-ai/vm0/commit/f61db105d0965c93bffb84f061d1027db8d79e36))
* **pi:** preserve provider http status in opaque model failures ([#33129](https://github.com/vm0-ai/vm0/issues/33129)) ([28a9d76](https://github.com/vm0-ai/vm0/commit/28a9d7642e0b5c07fe09ef6cd93b80e92f6dd65a)), closes [#33071](https://github.com/vm0-ai/vm0/issues/33071)
* recognize invalid claude oauth tokens ([#33113](https://github.com/vm0-ai/vm0/issues/33113)) ([4803ac0](https://github.com/vm0-ai/vm0/commit/4803ac067beffb4501a0b15160bd39a87430adf8))


### Documentation

* **rust:** correct guest completion reporting order ([#33121](https://github.com/vm0-ai/vm0/issues/33121)) ([70c8a94](https://github.com/vm0-ai/vm0/commit/70c8a944dfe6c5dd61c1c5bf83fc6efb022cdcda))

## [0.88.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.87.1...guest-agent-v0.88.0) (2026-09-09)


### Features

* **guest-agent:** prepare native chat effort consumers ([#32999](https://github.com/vm0-ai/vm0/issues/32999)) ([4a1e9e1](https://github.com/vm0-ai/vm0/commit/4a1e9e1a7c67de3d47ef0de86601f26819003d71))

## [0.87.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.87.0...guest-agent-v0.87.1) (2026-09-09)


### Refactoring

* **naming:** correct residual retired-brand copy and internal names ([#32946](https://github.com/vm0-ai/vm0/issues/32946)) ([c5e6ef9](https://github.com/vm0-ai/vm0/commit/c5e6ef9e41593c017fd2fd57222a40d123270db5)), closes [#32939](https://github.com/vm0-ai/vm0/issues/32939)

## [0.87.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.23...guest-agent-v0.87.0) (2026-09-09)


### Features

* **guest-control:** attribute storage apply resource usage ([#32907](https://github.com/vm0-ai/vm0/issues/32907)) ([65cd810](https://github.com/vm0-ai/vm0/commit/65cd810030c0eac6a5e8e1a377f4562f2cb58c48))


### Bug Fixes

* **pi-memory:** preserve unchanged files and safe failure diagnostics ([#32911](https://github.com/vm0-ai/vm0/issues/32911)) ([dcf5e10](https://github.com/vm0-ai/vm0/commit/dcf5e10bb749b56b091ad0d0de6770928195db23)), closes [#32744](https://github.com/vm0-ai/vm0/issues/32744)

## [0.86.23](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.22...guest-agent-v0.86.23) (2026-09-09)

## [0.86.22](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.21...guest-agent-v0.86.22) (2026-09-09)


### Bug Fixes

* **guest:** preserve bounded oom evidence before cleanup ([#32845](https://github.com/vm0-ai/vm0/issues/32845)) ([075ccba](https://github.com/vm0-ai/vm0/commit/075ccbaaf8f90231687267218ef1e77d05771d3a))


### Refactoring

* **pi-memory:** stop maintenance journal production and forwarding ([#32805](https://github.com/vm0-ai/vm0/issues/32805)) ([46576db](https://github.com/vm0-ai/vm0/commit/46576dbbca793e345e9b20e56618b998c3a8b629))

## [0.86.21](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.20...guest-agent-v0.86.21) (2026-09-09)


### Bug Fixes

* **runner:** classify expected catalog prefetch timeouts ([#32791](https://github.com/vm0-ai/vm0/issues/32791)) ([b508e1b](https://github.com/vm0-ai/vm0/commit/b508e1b63883c0fb4519330ca0070e10e61e231e))


### Documentation

* **guest-agent:** correct pi configuration handoff documentation ([#32789](https://github.com/vm0-ai/vm0/issues/32789)) ([13b101e](https://github.com/vm0-ai/vm0/commit/13b101e5871985b0a34d5613468f7444960c4a9f))

## [0.86.20](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.19...guest-agent-v0.86.20) (2026-09-08)


### Bug Fixes

* finish okou brand cleanup ([#32684](https://github.com/vm0-ai/vm0/issues/32684)) ([7d239a4](https://github.com/vm0-ai/vm0/commit/7d239a41a5dd6dd41ed7c22cd9e5dae566fc1925))

## [0.86.19](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.18...guest-agent-v0.86.19) (2026-09-08)

## [0.86.18](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.17...guest-agent-v0.86.18) (2026-09-08)


### Bug Fixes

* **api:** prevent duplicate pi phase two charges ([#32639](https://github.com/vm0-ai/vm0/issues/32639)) ([c84981d](https://github.com/vm0-ai/vm0/commit/c84981db7355cc4f4ded6aff39891d9daed66747))
* **guest-agent:** bound masked JSON key collision resolution ([#32623](https://github.com/vm0-ai/vm0/issues/32623)) ([6b2c673](https://github.com/vm0-ai/vm0/commit/6b2c67342a417d6e408901de7dc48df968d10df2))
* **guest-agent:** handle short reads in streaming upload buffers ([#32555](https://github.com/vm0-ai/vm0/issues/32555)) ([fdc9511](https://github.com/vm0-ai/vm0/commit/fdc9511532d552ae1745185cee3e8445a187049f))

## [0.86.17](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.16...guest-agent-v0.86.17) (2026-09-08)


### Bug Fixes

* **runtime:** use okou and neutral runtime copy ([#32588](https://github.com/vm0-ai/vm0/issues/32588)) ([61d758c](https://github.com/vm0-ai/vm0/commit/61d758c9dd50358a8f787867637ca3edef1ea1cc))


### Documentation

* **guest-agent:** clarify Codex agent log representation ([#32609](https://github.com/vm0-ai/vm0/issues/32609)) ([de65fa5](https://github.com/vm0-ai/vm0/commit/de65fa54cc28aa03af6ff65058a17aa611cd55fd))

## [0.86.16](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.15...guest-agent-v0.86.16) (2026-09-08)

## [0.86.15](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.14...guest-agent-v0.86.15) (2026-09-08)

## [0.86.14](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.13...guest-agent-v0.86.14) (2026-09-08)


### Bug Fixes

* **runner:** allow api cold starts in http timeout budgets ([#32517](https://github.com/vm0-ai/vm0/issues/32517)) ([041a420](https://github.com/vm0-ai/vm0/commit/041a420f4e44a8d648945c6fc817cd9b571e4a88))

## [0.86.13](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.12...guest-agent-v0.86.13) (2026-09-08)

## [0.86.12](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.11...guest-agent-v0.86.12) (2026-09-07)


### Performance Improvements

* **guest-agent:** avoid per-character citation matching allocations ([#32348](https://github.com/vm0-ai/vm0/issues/32348)) ([7de3573](https://github.com/vm0-ai/vm0/commit/7de357333016948afe1c3452aa8a2fda2f03d964))

## [0.86.11](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.10...guest-agent-v0.86.11) (2026-09-07)


### Refactoring

* **rust:** align workspace crate names with responsibilities ([#32307](https://github.com/vm0-ai/vm0/issues/32307)) ([39d81ce](https://github.com/vm0-ai/vm0/commit/39d81cedeb3c324ea48c3190e47ffb6c63bb28d9))

## [0.86.10](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.9...guest-agent-v0.86.10) (2026-09-07)

## [0.86.9](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.8...guest-agent-v0.86.9) (2026-09-07)

## [0.86.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.7...guest-agent-v0.86.8) (2026-09-07)


### Refactoring

* **runtime:** neutralize private test markers ([#32270](https://github.com/vm0-ai/vm0/issues/32270)) ([b1a3e6f](https://github.com/vm0-ai/vm0/commit/b1a3e6f80100113525c2b38c3a9dd1583d03cfe5))

## [0.86.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.6...guest-agent-v0.86.7) (2026-09-07)

## [0.86.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.5...guest-agent-v0.86.6) (2026-09-07)

## [0.86.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.4...guest-agent-v0.86.5) (2026-09-07)


### Refactoring

* remove retired fable 5 runtime definitions ([#32210](https://github.com/vm0-ai/vm0/issues/32210)) ([785a8f8](https://github.com/vm0-ai/vm0/commit/785a8f86e9f531445c1c25ffc46509d59dbddc58))

## [0.86.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.3...guest-agent-v0.86.4) (2026-09-07)


### Bug Fixes

* set terra reasoning effort to max ([#32194](https://github.com/vm0-ai/vm0/issues/32194)) ([bb60e20](https://github.com/vm0-ai/vm0/commit/bb60e2013f34f2d836a6839dda1c912091620ce5))

## [0.86.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.2...guest-agent-v0.86.3) (2026-09-07)


### Documentation

* **rust:** correct HeartbeatStatus summary ([#32129](https://github.com/vm0-ai/vm0/issues/32129)) ([4777169](https://github.com/vm0-ai/vm0/commit/477716997ffd789b1cf19b370759445ef4f2bd34))
* **rust:** update stale guest-agent CLI entrypoint references ([#32159](https://github.com/vm0-ai/vm0/issues/32159)) ([1c29468](https://github.com/vm0-ai/vm0/commit/1c29468fc6c57c90555052aee734a0dd5027962d))


### Performance Improvements

* **guest-agent:** reuse maintenance content hash ([#32093](https://github.com/vm0-ai/vm0/issues/32093)) ([9774746](https://github.com/vm0-ai/vm0/commit/97747462008167a2a494bdfeeb4dbcd9ba83fadc))

## [0.86.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.1...guest-agent-v0.86.2) (2026-09-06)


### Performance Improvements

* **guest-agent:** persist runtime npx cache in workspace ([#31981](https://github.com/vm0-ai/vm0/issues/31981)) ([69b2150](https://github.com/vm0-ai/vm0/commit/69b2150a993f7e2f7d359f4d359352ffa542dba9))

## [0.86.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.86.0...guest-agent-v0.86.1) (2026-09-06)


### Bug Fixes

* make pi memory citations safe across version skew ([#31976](https://github.com/vm0-ai/vm0/issues/31976)) ([63d4035](https://github.com/vm0-ai/vm0/commit/63d40353754fa03271b61b84d42ec3ee8cfe88f5))

## [0.86.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.85.8...guest-agent-v0.86.0) (2026-09-06)


### Features

* **pi-memory:** hide citation envelopes and preserve provenance ([#31965](https://github.com/vm0-ai/vm0/issues/31965)) ([5cecc7c](https://github.com/vm0-ai/vm0/commit/5cecc7cbcebb48899e4a9b251f209bbfb176f3f9))

## [0.85.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.85.7...guest-agent-v0.85.8) (2026-09-05)


### Bug Fixes

* settle private pi maintenance at the generic checkpoint boundary ([#31947](https://github.com/vm0-ai/vm0/issues/31947)) ([2db67fc](https://github.com/vm0-ai/vm0/commit/2db67fc8be4f1fa863c4faf8ed4905acfc65cdb5))

## [0.85.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.85.6...guest-agent-v0.85.7) (2026-09-05)


### Bug Fixes

* **pi:** reconcile cancellation and input at native settlement ([#31934](https://github.com/vm0-ai/vm0/issues/31934)) ([5784c62](https://github.com/vm0-ai/vm0/commit/5784c629ebac08ffdd4087444e6318b2f857d70c))

## [0.85.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.85.5...guest-agent-v0.85.6) (2026-09-05)


### Refactoring

* **pi-memory:** publish phase 2 through sandbox checkpoints ([#31912](https://github.com/vm0-ai/vm0/issues/31912)) ([57ba1c3](https://github.com/vm0-ai/vm0/commit/57ba1c398f21dc34348bf0c6f20d12cd88283b7f))

## [0.85.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.85.4...guest-agent-v0.85.5) (2026-09-05)


### Bug Fixes

* **pi:** own pending-tool handoff through native settlement ([#31924](https://github.com/vm0-ai/vm0/issues/31924)) ([cdcbfcc](https://github.com/vm0-ai/vm0/commit/cdcbfccdb7e2e32cecfe1a7aff2829d32f28f675))

## [0.85.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.85.3...guest-agent-v0.85.4) (2026-09-05)


### Performance Improvements

* **guest-agent:** bound overlapping match ranges ([#31877](https://github.com/vm0-ai/vm0/issues/31877)) ([2e92d0e](https://github.com/vm0-ai/vm0/commit/2e92d0ef3aee22e455619eb3774eb9873fd71eec))

## [0.85.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.85.2...guest-agent-v0.85.3) (2026-09-05)

## [0.85.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.85.1...guest-agent-v0.85.2) (2026-09-04)


### Refactoring

* **agent:** centralize cli framework selector parsing ([#31768](https://github.com/vm0-ai/vm0/issues/31768)) ([b98056f](https://github.com/vm0-ai/vm0/commit/b98056feab6c029fc4de1e61e4dcaf6e4d9fda94))


### Performance Improvements

* **guest-agent:** bound pi rpc response buffering ([#31769](https://github.com/vm0-ai/vm0/issues/31769)) ([121d13d](https://github.com/vm0-ai/vm0/commit/121d13dd8de271c03168f93a18a2c522d6e7d567))

## [0.85.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.85.0...guest-agent-v0.85.1) (2026-09-04)

## [0.85.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.84.12...guest-agent-v0.85.0) (2026-09-04)


### Features

* add gpt-6 astra support ([#31558](https://github.com/vm0-ai/vm0/issues/31558)) ([004ea48](https://github.com/vm0-ai/vm0/commit/004ea48590eba7c66af3a9b156e3daba7411793b))


### Bug Fixes

* **chat:** preserve structured runner timeout recovery ([#31711](https://github.com/vm0-ai/vm0/issues/31711)) ([1a6f7d2](https://github.com/vm0-ai/vm0/commit/1a6f7d27e30421af781efa7ac3025e46e39286dd))

## [0.84.12](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.84.11...guest-agent-v0.84.12) (2026-09-04)


### Bug Fixes

* **guest-agent:** preserve success when history upload fails ([#31605](https://github.com/vm0-ai/vm0/issues/31605)) ([46a02eb](https://github.com/vm0-ai/vm0/commit/46a02ebc4385662eb3c5426abba1f9bfae1680ca))

## [0.84.11](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.84.10...guest-agent-v0.84.11) (2026-09-03)


### Refactoring

* **pi:** add dialect-aware credential runtime contract ([#31493](https://github.com/vm0-ai/vm0/issues/31493)) ([9464fb3](https://github.com/vm0-ai/vm0/commit/9464fb3e99138707f242b1fe789cf0e375602973))

## [0.84.10](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.84.9...guest-agent-v0.84.10) (2026-09-03)


### Bug Fixes

* **guest-agent:** classify oversized codex turn inputs ([#31404](https://github.com/vm0-ai/vm0/issues/31404)) ([8cf7f4b](https://github.com/vm0-ai/vm0/commit/8cf7f4b60fde6c4c8239ff27f27a9cc24e90f124))

## [0.84.9](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.84.8...guest-agent-v0.84.9) (2026-09-03)

## [0.84.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.84.7...guest-agent-v0.84.8) (2026-09-03)


### Refactoring

* **rust:** centralize guest binary paths ([#31298](https://github.com/vm0-ai/vm0/issues/31298)) ([73e59f8](https://github.com/vm0-ai/vm0/commit/73e59f8d4d7337226d3143e2ca688e124878372f))

## [0.84.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.84.6...guest-agent-v0.84.7) (2026-09-03)


### Refactoring

* **runtime:** retire vm0 environment ownership wildcard ([#31251](https://github.com/vm0-ai/vm0/issues/31251)) ([0a13b76](https://github.com/vm0-ai/vm0/commit/0a13b762139fbaccae9a3324aab1baed71ca7b22))

## [0.84.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.84.5...guest-agent-v0.84.6) (2026-09-02)


### Refactoring

* **runtime:** reclassify run payload field identifiers ([#31244](https://github.com/vm0-ai/vm0/issues/31244)) ([3b475f2](https://github.com/vm0-ai/vm0/commit/3b475f25121716295b2edcfefe3d4c9143c6d671))

## [0.84.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.84.4...guest-agent-v0.84.5) (2026-09-02)


### Refactoring

* **runtime:** remove retired process-containment alias tombstones ([#31231](https://github.com/vm0-ai/vm0/issues/31231)) ([6947bad](https://github.com/vm0-ai/vm0/commit/6947badf5b8d81c81d3795796d49abf708aa710e))

## [0.84.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.84.3...guest-agent-v0.84.4) (2026-09-02)


### Bug Fixes

* **runner:** report authoritative provider failure reasons ([#31163](https://github.com/vm0-ai/vm0/issues/31163)) ([b84e233](https://github.com/vm0-ai/vm0/commit/b84e2334f9e370b59a299b00250fc037d90538dd))


### Refactoring

* **runtime:** remove retired API URL alias tombstones ([#31209](https://github.com/vm0-ai/vm0/issues/31209)) ([e57170e](https://github.com/vm0-ai/vm0/commit/e57170e30c73c68188ce035caba4176874e716c2))

## [0.84.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.84.2...guest-agent-v0.84.3) (2026-09-02)


### Refactoring

* **rust:** share run artifact payload contract ([#31153](https://github.com/vm0-ai/vm0/issues/31153)) ([16c79bb](https://github.com/vm0-ai/vm0/commit/16c79bb75648f4b2def7b28ae0b1aadff326941c))

## [0.84.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.84.1...guest-agent-v0.84.2) (2026-09-02)


### Bug Fixes

* **guest-agent:** preserve checkpoint upload failure details ([#31113](https://github.com/vm0-ai/vm0/issues/31113)) ([6afd0e9](https://github.com/vm0-ai/vm0/commit/6afd0e9ba8bc4c9308b1523370f155a70a3720f6))

## [0.84.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.84.0...guest-agent-v0.84.1) (2026-09-02)


### Documentation

* **rust:** include Codex cleanup helper protocol ([#31051](https://github.com/vm0-ai/vm0/issues/31051)) ([f1b8e23](https://github.com/vm0-ai/vm0/commit/f1b8e23419a459b8632d343c5faa60f2678f2b22))


### Refactoring

* **pi:** make ownership transfer v3-only ([#31045](https://github.com/vm0-ai/vm0/issues/31045)) ([1e99242](https://github.com/vm0-ai/vm0/commit/1e99242eabe418b4981216c0f6eb62e21edc015a))

## [0.84.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.83.8...guest-agent-v0.84.0) (2026-09-02)


### Features

* add Claude Fable 5.1 support ([#30932](https://github.com/vm0-ai/vm0/issues/30932)) ([15f6717](https://github.com/vm0-ai/vm0/commit/15f6717327d927cc8bc61ff3af3cf17802aa4853))

## [0.83.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.83.7...guest-agent-v0.83.8) (2026-09-02)

## [0.83.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.83.6...guest-agent-v0.83.7) (2026-09-02)


### Refactoring

* **rust:** centralize cli stderr diagnostic policy ([#30984](https://github.com/vm0-ai/vm0/issues/30984)) ([7f3d97c](https://github.com/vm0-ai/vm0/commit/7f3d97cc84f939ba04be5d9242349fdccfaf368b))

## [0.83.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.83.5...guest-agent-v0.83.6) (2026-09-01)


### Performance Improvements

* **guest-agent:** expose control-path scheduling metrics ([#30890](https://github.com/vm0-ai/vm0/issues/30890)) ([1e7a196](https://github.com/vm0-ai/vm0/commit/1e7a1966f15351fb5f8019ebd29c2ee5ad2b4f96))
* **runner:** specialize reused codex cleanup lifecycle ([#30888](https://github.com/vm0-ai/vm0/issues/30888)) ([5941c94](https://github.com/vm0-ai/vm0/commit/5941c9474fb6f1389a6ca9d3c92e99a3af59b98a))

## [0.83.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.83.4...guest-agent-v0.83.5) (2026-09-01)


### Bug Fixes

* retain heartbeat control-path diagnostics ([#30849](https://github.com/vm0-ai/vm0/issues/30849)) ([8ee4d2d](https://github.com/vm0-ai/vm0/commit/8ee4d2d6043a5e15173ace032347366645c254b1))

## [0.83.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.83.3...guest-agent-v0.83.4) (2026-09-01)


### Documentation

* **guest-agent:** document GuestPaths accessors ([#30739](https://github.com/vm0-ai/vm0/issues/30739)) ([38f621d](https://github.com/vm0-ai/vm0/commit/38f621d5d176432080af367c5d3958ed4555ce69))


### Refactoring

* **rust:** share environment-key diagnostic sanitizer ([#30750](https://github.com/vm0-ai/vm0/issues/30750)) ([d7d08f2](https://github.com/vm0-ai/vm0/commit/d7d08f2b128021bf9ee3a6d352fffc1c344c5f5d))

## [0.83.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.83.2...guest-agent-v0.83.3) (2026-09-01)

## [0.83.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.83.1...guest-agent-v0.83.2) (2026-09-01)

## [0.83.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.83.0...guest-agent-v0.83.1) (2026-09-01)


### Performance Improvements

* **runner:** launch reuse identity verifier without shell ([#30644](https://github.com/vm0-ai/vm0/issues/30644)) ([3ea790e](https://github.com/vm0-ai/vm0/commit/3ea790e5a8bca85854debfe537a89a66c4520445))

## [0.83.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.27...guest-agent-v0.83.0) (2026-08-31)


### Features

* **codex:** preserve thread item semantics ([#30579](https://github.com/vm0-ai/vm0/issues/30579)) ([31b1be9](https://github.com/vm0-ai/vm0/commit/31b1be9fd870504252b4277e3480442170963426))
* **pi:** add versioned sandbox ownership transfers ([#30607](https://github.com/vm0-ai/vm0/issues/30607)) ([dbc4e02](https://github.com/vm0-ai/vm0/commit/dbc4e02e9360749162d2bcf3fd1726f12a8e521f))

## [0.82.27](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.26...guest-agent-v0.82.27) (2026-08-31)


### Documentation

* **guest-agent:** explain artifact checkpoint pipeline invariants ([#30497](https://github.com/vm0-ai/vm0/issues/30497)) ([b0a5845](https://github.com/vm0-ai/vm0/commit/b0a5845751afbf1e9a548b7baecb0e6df83cabe2))


### Refactoring

* **guest-agent:** remove retired bootstrap alias carrier ([#30517](https://github.com/vm0-ai/vm0/issues/30517)) ([c6df725](https://github.com/vm0-ai/vm0/commit/c6df725f46661ae72db0f4c9ef1d7703b43cc239))

## [0.82.26](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.25...guest-agent-v0.82.26) (2026-08-31)

## [0.82.25](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.24...guest-agent-v0.82.25) (2026-08-31)


### Bug Fixes

* **guest-agent:** atomically persist checkpoint completion ([#30384](https://github.com/vm0-ai/vm0/issues/30384)) ([f54e213](https://github.com/vm0-ai/vm0/commit/f54e213e05c57ae39beecc27fa706b98fc96b791))

## [0.82.24](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.23...guest-agent-v0.82.24) (2026-08-31)


### Bug Fixes

* **guest-agent:** classify structured codex errors ([#30377](https://github.com/vm0-ai/vm0/issues/30377)) ([b33d3f4](https://github.com/vm0-ai/vm0/commit/b33d3f402c7574605a292b11eb2db80e8b8f388e))

## [0.82.23](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.22...guest-agent-v0.82.23) (2026-08-30)


### Documentation

* **rust:** document GuestConfig field contracts ([#30359](https://github.com/vm0-ai/vm0/issues/30359)) ([d0ebfde](https://github.com/vm0-ai/vm0/commit/d0ebfde1ae2639216cb879841457e5d4b40a5664))

## [0.82.22](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.21...guest-agent-v0.82.22) (2026-08-30)


### Bug Fixes

* interrupt active codex turns before shutdown ([#30344](https://github.com/vm0-ai/vm0/issues/30344)) ([2270569](https://github.com/vm0-ai/vm0/commit/2270569209f12ec58078cee520878409b4f15041))
* preserve codex per-turn token usage ([#30337](https://github.com/vm0-ai/vm0/issues/30337)) ([c9ef6c1](https://github.com/vm0-ai/vm0/commit/c9ef6c1e407cf07ca71a1ac7bc0bfccfad3bf205))

## [0.82.21](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.20...guest-agent-v0.82.21) (2026-08-30)


### Refactoring

* **guest:** retire api url root legacy reader ([#30293](https://github.com/vm0-ai/vm0/issues/30293)) ([acf0976](https://github.com/vm0-ai/vm0/commit/acf09762659b1c0c112e51948b2dda9670fe5240))
* **guest:** retire timing tuning legacy readers ([#30303](https://github.com/vm0-ai/vm0/issues/30303)) ([27477c4](https://github.com/vm0-ai/vm0/commit/27477c4cea651fc86fbea0194bd438946e6581ad))

## [0.82.20](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.19...guest-agent-v0.82.20) (2026-08-30)


### Refactoring

* **guest:** retire api token legacy reader ([#30292](https://github.com/vm0-ai/vm0/issues/30292)) ([7d0c3ad](https://github.com/vm0-ai/vm0/commit/7d0c3ad45d1361c0ee6463f8cc46feb00780e8f4))
* **guest:** retire execution timeout legacy reader ([#30301](https://github.com/vm0-ai/vm0/issues/30301)) ([e5fba4b](https://github.com/vm0-ai/vm0/commit/e5fba4b8fa0ed5c1a769e71ac40053798c08abd7)), closes [#30289](https://github.com/vm0-ai/vm0/issues/30289) [#28914](https://github.com/vm0-ai/vm0/issues/28914)
* **guest:** retire private payload legacy readers ([#30307](https://github.com/vm0-ai/vm0/issues/30307)) ([1059893](https://github.com/vm0-ai/vm0/commit/10598930135c5e6def894ae799064a5ef794d2c1))

## [0.82.19](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.18...guest-agent-v0.82.19) (2026-08-30)


### Documentation

* **rust:** document Pi RPC lifecycle and event projection ([#30258](https://github.com/vm0-ai/vm0/issues/30258)) ([e8c2fc8](https://github.com/vm0-ai/vm0/commit/e8c2fc85f241138a17cf021108ad5e8163928464))


### Refactoring

* **guest:** cut managed CLI API URL writer to canonical alias ([#30285](https://github.com/vm0-ai/vm0/issues/30285)) ([a9a071e](https://github.com/vm0-ai/vm0/commit/a9a071e78fb317292b8c712f2b5543949dcb5982)), closes [#30277](https://github.com/vm0-ai/vm0/issues/30277) [#28914](https://github.com/vm0-ai/vm0/issues/28914)

## [0.82.18](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.17...guest-agent-v0.82.18) (2026-08-29)


### Refactoring

* remove chat tool activity ([#30215](https://github.com/vm0-ai/vm0/issues/30215)) ([c475f9e](https://github.com/vm0-ai/vm0/commit/c475f9e59935ec292acd8b35ceb66e1f59708866))

## [0.82.17](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.16...guest-agent-v0.82.17) (2026-08-29)

## [0.82.16](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.15...guest-agent-v0.82.16) (2026-08-28)


### Performance Improvements

* **runner:** launch guest agent without shell bootstrap ([#30153](https://github.com/vm0-ai/vm0/issues/30153)) ([b2409fe](https://github.com/vm0-ai/vm0/commit/b2409fed8caa794a4e7d604f7d4c64559a385737))

## [0.82.15](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.14...guest-agent-v0.82.15) (2026-08-28)


### Refactoring

* **rust:** forbid path attributes ([#30129](https://github.com/vm0-ai/vm0/issues/30129)) ([c46da3e](https://github.com/vm0-ai/vm0/commit/c46da3ea8fb48b7595bc582036a1f28a0d676f5f))

## [0.82.14](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.13...guest-agent-v0.82.14) (2026-08-28)


### Refactoring

* **guest-agent:** centralize codex startup policy fixture ([#30089](https://github.com/vm0-ai/vm0/issues/30089)) ([b656e9a](https://github.com/vm0-ai/vm0/commit/b656e9a4dc3d450b9c7bec511c79edd5c020b99e))
* **guest-agent:** remove legacy process-control endpoint reader ([#30130](https://github.com/vm0-ai/vm0/issues/30130)) ([57157de](https://github.com/vm0-ai/vm0/commit/57157de35208c779837373ce8cca6baf601d605b))
* **guest-agent:** remove legacy root cgroup readers ([#30112](https://github.com/vm0-ai/vm0/issues/30112)) ([8d594fa](https://github.com/vm0-ai/vm0/commit/8d594fa8ce223e5040a0c0edcfae2aacf1a03307)), closes [#30103](https://github.com/vm0-ai/vm0/issues/30103) [#28914](https://github.com/vm0-ai/vm0/issues/28914)
* **guest-agent:** reuse file-size limit guard ([#30135](https://github.com/vm0-ai/vm0/issues/30135)) ([1986eea](https://github.com/vm0-ai/vm0/commit/1986eea95d66a5e65a1f1022dee6b2f89502e099))
* **runner:** cut guest API URL writer to canonical alias ([#30105](https://github.com/vm0-ai/vm0/issues/30105)) ([f3bb3c5](https://github.com/vm0-ai/vm0/commit/f3bb3c589879d6782f7942afff00b8e9af242706))

## [0.82.13](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.12...guest-agent-v0.82.13) (2026-08-28)

## [0.82.12](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.11...guest-agent-v0.82.12) (2026-08-28)


### Performance Improvements

* **guest-agent:** reuse metrics log handle ([#30067](https://github.com/vm0-ai/vm0/issues/30067)) ([59c6902](https://github.com/vm0-ai/vm0/commit/59c6902e5185016fd49b51bc6609ea372380e501))

## [0.82.11](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.10...guest-agent-v0.82.11) (2026-08-28)

## [0.82.10](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.9...guest-agent-v0.82.10) (2026-08-28)

## [0.82.9](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.8...guest-agent-v0.82.9) (2026-08-28)


### Refactoring

* **guest:** cut managed tool placement writer to canonical alias ([#30001](https://github.com/vm0-ai/vm0/issues/30001)) ([e8e1294](https://github.com/vm0-ai/vm0/commit/e8e129417a3e77e507f2892854f8291d71d97d8e)), closes [#29995](https://github.com/vm0-ai/vm0/issues/29995) [#28914](https://github.com/vm0-ai/vm0/issues/28914)
* **test:** cut guest runtime directory writers to canonical alias ([#30000](https://github.com/vm0-ai/vm0/issues/30000)) ([89c3cdc](https://github.com/vm0-ai/vm0/commit/89c3cdc8c5c7abd4cade63cc0debe62cbd909ca4))
* **test:** cut process-control prerequisites to canonical alias ([#29997](https://github.com/vm0-ai/vm0/issues/29997)) ([366cc0b](https://github.com/vm0-ai/vm0/commit/366cc0b28080d9c67c5ba029f9686a362c8493e0))

## [0.82.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.7...guest-agent-v0.82.8) (2026-08-28)


### Refactoring

* **guest-agent:** remove legacy codex service-tier reader ([#29983](https://github.com/vm0-ai/vm0/issues/29983)) ([bdd382b](https://github.com/vm0-ai/vm0/commit/bdd382b86cef7a73142e4fe14732aa9d1c5dd33b))
* **guest:** remove legacy mock binary path readers ([#29977](https://github.com/vm0-ai/vm0/issues/29977)) ([95df1fc](https://github.com/vm0-ai/vm0/commit/95df1fce63080ef61656f9d5e76b2c763fd2afdc)), closes [#29973](https://github.com/vm0-ai/vm0/issues/29973) [#28914](https://github.com/vm0-ai/vm0/issues/28914)
* **runtime:** cut process-control writer to canonical alias ([#29915](https://github.com/vm0-ai/vm0/issues/29915)) ([d24888e](https://github.com/vm0-ai/vm0/commit/d24888e360664ac892d1be16788f5b75abd2a26a))
* **test:** cut API start-time writers to canonical alias ([#29957](https://github.com/vm0-ai/vm0/issues/29957)) ([6b1f6b3](https://github.com/vm0-ai/vm0/commit/6b1f6b328efc2a747fbac17abafae66c70379d19))
* **test:** cut API token writers to canonical alias ([#29969](https://github.com/vm0-ai/vm0/issues/29969)) ([e39f845](https://github.com/vm0-ai/vm0/commit/e39f845c8d6fa3932be90019dc6599c388a820d3))
* **test:** cut api url writers to canonical alias ([#29972](https://github.com/vm0-ai/vm0/issues/29972)) ([53c81cd](https://github.com/vm0-ai/vm0/commit/53c81cdc6b75067d88c6682ea6f1c65681631862))
* **test:** cut codex fast-mode writers to canonical alias ([#29971](https://github.com/vm0-ai/vm0/issues/29971)) ([1f8d334](https://github.com/vm0-ai/vm0/commit/1f8d3349a3c274c79495f1c8402da2de1fabc2dd))
* **test:** cut mock path writers to canonical aliases ([#29949](https://github.com/vm0-ai/vm0/issues/29949)) ([3941a98](https://github.com/vm0-ai/vm0/commit/3941a9832964c22b647213509376be0fccb70683))
* **test:** cut post-result timing writers to canonical aliases ([#29966](https://github.com/vm0-ai/vm0/issues/29966)) ([ca0592e](https://github.com/vm0-ai/vm0/commit/ca0592e4ddb23f7ddcc15a8f9a52f5bfb99444e3))
* **test:** cut private payload writers to canonical aliases ([#29975](https://github.com/vm0-ai/vm0/issues/29975)) ([d3aadd7](https://github.com/vm0-ai/vm0/commit/d3aadd74c482a682a198db736b331baf680730fc))
* **test:** cut resume-session writers to canonical alias ([#29955](https://github.com/vm0-ai/vm0/issues/29955)) ([086f2e1](https://github.com/vm0-ai/vm0/commit/086f2e1376400ef3feb818b896e751497bac0147)), closes [#29952](https://github.com/vm0-ai/vm0/issues/29952) [#29065](https://github.com/vm0-ai/vm0/issues/29065) [#28914](https://github.com/vm0-ai/vm0/issues/28914)
* **test:** cut sandbox metadata writers to canonical aliases ([#29962](https://github.com/vm0-ai/vm0/issues/29962)) ([6762647](https://github.com/vm0-ai/vm0/commit/67626477d495d55587405b39964a88acf1793f37)), closes [#29956](https://github.com/vm0-ai/vm0/issues/29956) [#28914](https://github.com/vm0-ai/vm0/issues/28914)
* **test:** cut stuck-tool timeout writers to canonical alias ([#29963](https://github.com/vm0-ai/vm0/issues/29963)) ([2bf4da0](https://github.com/vm0-ai/vm0/commit/2bf4da08395d98bc1538dcfcb95e355ff0a7d049))
* **test:** cut timeout writers to canonical alias ([#29959](https://github.com/vm0-ai/vm0/issues/29959)) ([38b93ad](https://github.com/vm0-ai/vm0/commit/38b93ad6b0be1c85e20a4d1ce3d69edd38772ea3))

## [0.82.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.6...guest-agent-v0.82.7) (2026-08-27)

## [0.82.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.5...guest-agent-v0.82.6) (2026-08-27)


### Refactoring

* **rust:** make shared jsonl cli state backend-neutral ([#29895](https://github.com/vm0-ai/vm0/issues/29895)) ([0e0bc69](https://github.com/vm0-ai/vm0/commit/0e0bc69214f2717f37aa27064c1a1f5a1c8ae311))

## [0.82.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.4...guest-agent-v0.82.5) (2026-08-27)

## [0.82.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.3...guest-agent-v0.82.4) (2026-08-27)

## [0.82.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.2...guest-agent-v0.82.3) (2026-08-27)

## [0.82.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.1...guest-agent-v0.82.2) (2026-08-27)

## [0.82.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.82.0...guest-agent-v0.82.1) (2026-08-27)


### Bug Fixes

* **guest-agent:** bound pi rpc writes on cancellation ([#29783](https://github.com/vm0-ai/vm0/issues/29783)) ([083255a](https://github.com/vm0-ai/vm0/commit/083255ab967c28674b3b103575444a9732074403))


### Documentation

* **guest-agent:** document ignored masker inputs ([#29761](https://github.com/vm0-ai/vm0/issues/29761)) ([9dda9e8](https://github.com/vm0-ai/vm0/commit/9dda9e80a019ffbd1d2fea575cf84385b4e318d1))


### Refactoring

* **runner:** establish guest agent readiness ([#29748](https://github.com/vm0-ai/vm0/issues/29748)) ([8eaafa1](https://github.com/vm0-ai/vm0/commit/8eaafa13bc280f08033fded17e7c3fd5c9822804))

## [0.82.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.81.0...guest-agent-v0.82.0) (2026-08-26)


### Features

* **pi:** materialize chat tool activity ([#29665](https://github.com/vm0-ai/vm0/issues/29665)) ([8467582](https://github.com/vm0-ai/vm0/commit/8467582c87e631932861b04cc519278527e482e3))


### Refactoring

* **runner:** make guest process roles explicit ([#29679](https://github.com/vm0-ai/vm0/issues/29679)) ([fe5d663](https://github.com/vm0-ai/vm0/commit/fe5d663d192a9838dfdf4aecc2ffc8c7a22d24fa))

## [0.81.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.80.0...guest-agent-v0.81.0) (2026-08-26)


### Features

* **pi:** accept dynamic handoff sequence boundaries ([#29636](https://github.com/vm0-ai/vm0/issues/29636)) ([d52059f](https://github.com/vm0-ai/vm0/commit/d52059fb35108354d70078edd84404eae7008647))

## [0.80.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.79.7...guest-agent-v0.80.0) (2026-08-26)


### Features

* **guest-agent:** normalize pi message blocks before sequencing ([#29624](https://github.com/vm0-ai/vm0/issues/29624)) ([80ef970](https://github.com/vm0-ai/vm0/commit/80ef97097b7a0fffaf34cf25ffc44af31b80ea37))

## [0.79.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.79.6...guest-agent-v0.79.7) (2026-08-26)

## [0.79.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.79.5...guest-agent-v0.79.6) (2026-08-26)

## [0.79.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.79.4...guest-agent-v0.79.5) (2026-08-26)


### Documentation

* **guest-agent:** clarify has_api capability semantics ([#29498](https://github.com/vm0-ai/vm0/issues/29498)) ([db74bdb](https://github.com/vm0-ai/vm0/commit/db74bdb81d8716f016bd9050c3aec39852a24c93))


### Performance Improvements

* **guest-agent:** reject oversized plain histories before reading ([#29494](https://github.com/vm0-ai/vm0/issues/29494)) ([207cc95](https://github.com/vm0-ai/vm0/commit/207cc95ad45f5216667264d8998ed48e0f8969e4))

## [0.79.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.79.3...guest-agent-v0.79.4) (2026-08-26)


### Bug Fixes

* **agent:** preserve original shell commands in tool events ([#29475](https://github.com/vm0-ai/vm0/issues/29475)) ([238051b](https://github.com/vm0-ai/vm0/commit/238051b2011fbd6d790c34b81e4f476d9a107830))

## [0.79.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.79.2...guest-agent-v0.79.3) (2026-08-26)

## [0.79.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.79.1...guest-agent-v0.79.2) (2026-08-25)


### Refactoring

* **guest:** rename unmanaged process-control test environment key ([#29394](https://github.com/vm0-ai/vm0/issues/29394)) ([22867f9](https://github.com/vm0-ai/vm0/commit/22867f948f207d267e16e47e98c86591500f6536))

## [0.79.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.79.0...guest-agent-v0.79.1) (2026-08-25)


### Refactoring

* **guest-agent:** rename debug http retry-delay key ([#29390](https://github.com/vm0-ai/vm0/issues/29390)) ([688fb07](https://github.com/vm0-ai/vm0/commit/688fb07a5429bdac8c4ddbd5c8f121ebc72c31a5))
* **guest:** dual-read mock binary path aliases ([#29385](https://github.com/vm0-ai/vm0/issues/29385)) ([15e79f4](https://github.com/vm0-ai/vm0/commit/15e79f42c3522856c4debe98c19af6b47bf54a30))

## [0.79.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.78.0...guest-agent-v0.79.0) (2026-08-25)


### Features

* materialize provider tool activity ([#29372](https://github.com/vm0-ai/vm0/issues/29372)) ([0383cb8](https://github.com/vm0-ai/vm0/commit/0383cb83c9d370a730c97dade61994165ab69023))


### Refactoring

* **guest-agent:** dual-read api backend url aliases ([#29369](https://github.com/vm0-ai/vm0/issues/29369)) ([84295ac](https://github.com/vm0-ai/vm0/commit/84295ac0c3d66185b90d59fc6afa3f79903aac9a))

## [0.78.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.77.2...guest-agent-v0.78.0) (2026-08-25)


### Features

* **guest-agent:** normalize provider events before sequencing ([#29353](https://github.com/vm0-ai/vm0/issues/29353)) ([3462eda](https://github.com/vm0-ai/vm0/commit/3462eda85bc1b4a384a5562a0e9de84d93341ee9))


### Refactoring

* **api-contracts:** centralize checkpoint webhook types ([#29332](https://github.com/vm0-ai/vm0/issues/29332)) ([d33aadd](https://github.com/vm0-ai/vm0/commit/d33aadde98ab495df30b32e81e51f9467b921b21))
* **guest-agent:** dual-read tuning environment aliases ([#29329](https://github.com/vm0-ai/vm0/issues/29329)) ([d5dbae8](https://github.com/vm0-ai/vm0/commit/d5dbae8abbb4141eb10bb22ab3a8d588628b1e7c))

## [0.77.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.77.1...guest-agent-v0.77.2) (2026-08-25)

## [0.77.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.77.0...guest-agent-v0.77.1) (2026-08-25)


### Bug Fixes

* **guest-agent:** bound api response bodies ([#29239](https://github.com/vm0-ai/vm0/issues/29239)) ([95cb00a](https://github.com/vm0-ai/vm0/commit/95cb00a74ad072ae78f975634050c3a068834eff))

## [0.77.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.76.0...guest-agent-v0.77.0) (2026-08-25)


### Features

* **api:** add strict pi api first-turn handoff ([#28664](https://github.com/vm0-ai/vm0/issues/28664)) ([4bc9ef0](https://github.com/vm0-ai/vm0/commit/4bc9ef063e244a3f3af8dbc9ab94fd173208b93c))


### Bug Fixes

* **events:** preserve timeout and connect observations ([#28397](https://github.com/vm0-ai/vm0/issues/28397)) ([c3d536e](https://github.com/vm0-ai/vm0/commit/c3d536eab61fca8e2006a7664a982b993537db00))
* **guest-agent:** classify mid-response failures ([#28393](https://github.com/vm0-ai/vm0/issues/28393)) ([4ca21bd](https://github.com/vm0-ai/vm0/commit/4ca21bdbe47a2ce99f34c343b074f83c45775483))
* **guest-agent:** ignore task notification results ([#28534](https://github.com/vm0-ai/vm0/issues/28534)) ([db3e953](https://github.com/vm0-ai/vm0/commit/db3e95327b14181d74456de8f00120bd1e186be0))
* **guest-agent:** keep claude appended prompts out of argv ([#28838](https://github.com/vm0-ai/vm0/issues/28838)) ([0bd96d6](https://github.com/vm0-ai/vm0/commit/0bd96d69d6b9121e37232080a35111550f709424))
* **guest-agent:** mask sandbox operation telemetry ([#28512](https://github.com/vm0-ai/vm0/issues/28512)) ([d81bf2d](https://github.com/vm0-ai/vm0/commit/d81bf2d0505e96a7e76efc5365c2275e271dca2f))
* **guest-agent:** redact multiline secrets in telemetry ([#28514](https://github.com/vm0-ai/vm0/issues/28514)) ([484c288](https://github.com/vm0-ai/vm0/commit/484c28853522c09be3eca6e9aa21726169dc0665))
* **guest-agent:** reject artifact roots with linked ancestors ([#28899](https://github.com/vm0-ai/vm0/issues/28899)) ([8923a95](https://github.com/vm0-ai/vm0/commit/8923a95def24f40702c333043b48b7c3cd83600d))
* **guest:** isolate managed claude config from user home ([#28324](https://github.com/vm0-ai/vm0/issues/28324)) ([c6a20ba](https://github.com/vm0-ai/vm0/commit/c6a20babf5f75ffac7ac97f69c570ba1ddb2ef23))
* handle revoked claude code oauth tokens ([#29181](https://github.com/vm0-ai/vm0/issues/29181)) ([fefb3c9](https://github.com/vm0-ai/vm0/commit/fefb3c9a1a46d6239f9646b2280054e1ee133687))
* **runner:** isolate shell tool oom cleanup ([#28391](https://github.com/vm0-ai/vm0/issues/28391)) ([ffb0332](https://github.com/vm0-ai/vm0/commit/ffb03327e60854d4e5e541b34a2f3423cfcee6f2))


### Documentation

* **rust:** document guest event preparation and posting boundaries ([#28918](https://github.com/vm0-ai/vm0/issues/28918)) ([4aaa4ee](https://github.com/vm0-ai/vm0/commit/4aaa4ee66ba3a54473ee1d34c3ef12e861894234))


### Refactoring

* **guest-agent:** dual-read api token environment aliases ([#29062](https://github.com/vm0-ai/vm0/issues/29062)) ([1f21af7](https://github.com/vm0-ai/vm0/commit/1f21af778ef9513a49ee40de8e6176aba08e80ac))
* **guest-agent:** dual-read codex service-tier environment aliases ([#29038](https://github.com/vm0-ai/vm0/issues/29038)) ([dc84c21](https://github.com/vm0-ai/vm0/commit/dc84c21c569fc9919321c27ee2af32209d319ee7))
* **runtime:** dual-read cgroup placement environment aliases ([#29081](https://github.com/vm0-ai/vm0/issues/29081)) ([7beb4d5](https://github.com/vm0-ai/vm0/commit/7beb4d545bef801b7dd0bd2c107829869cd022ed))
* **runtime:** dual-read guest runtime directory aliases ([#29101](https://github.com/vm0-ai/vm0/issues/29101)) ([3bb5b28](https://github.com/vm0-ai/vm0/commit/3bb5b2807090c3cf48650b917ccca00bdb44f370))
* **runtime:** dual-read private payload file env aliases ([#29082](https://github.com/vm0-ai/vm0/issues/29082)) ([e400e00](https://github.com/vm0-ai/vm0/commit/e400e0058cd63cc18b478ad807da42f9b5bb5e74))
* **runtime:** dual-read process-control environment aliases ([#29071](https://github.com/vm0-ai/vm0/issues/29071)) ([c9cde49](https://github.com/vm0-ai/vm0/commit/c9cde495a4ba6f43c409476a68733bdade8cb99c))
* **runtime:** dual-read resume session environment aliases ([#29069](https://github.com/vm0-ai/vm0/issues/29069)) ([6dd54e9](https://github.com/vm0-ai/vm0/commit/6dd54e909a8607421344e758adcb887f72f8f0de))
* **runtime:** dual-read run metadata env aliases ([#29022](https://github.com/vm0-ai/vm0/issues/29022)) ([928d53b](https://github.com/vm0-ai/vm0/commit/928d53b17819c1c82f76da3aa8e4e672c69431d1))


### Performance Improvements

* **guest-agent:** bound reuse cleanup memory ([#28593](https://github.com/vm0-ai/vm0/issues/28593)) ([23ac7ce](https://github.com/vm0-ai/vm0/commit/23ac7ce52340901becc277fa521dd649b8d23d59))
* **guest-agent:** buffer transcript writes ([#28881](https://github.com/vm0-ai/vm0/issues/28881)) ([a401186](https://github.com/vm0-ai/vm0/commit/a401186650c98a904bf4d4f435868f91239d20d1))
* **guest-agent:** retain compact pi terminal state ([#29179](https://github.com/vm0-ai/vm0/issues/29179)) ([6e5f64e](https://github.com/vm0-ai/vm0/commit/6e5f64ecdc9d0c0024ecd62fab55b9baccdf1fda))
* **rust:** bound generic codex completed-item fields ([#28876](https://github.com/vm0-ai/vm0/issues/28876)) ([b13d3d2](https://github.com/vm0-ai/vm0/commit/b13d3d21e2630ac4472083988f4ca2766fa1b3e1))

## [0.76.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.75.10...guest-agent-v0.76.0) (2026-08-25)


### Features

* **api:** add strict pi api first-turn handoff ([#28664](https://github.com/vm0-ai/vm0/issues/28664)) ([4bc9ef0](https://github.com/vm0-ai/vm0/commit/4bc9ef063e244a3f3af8dbc9ab94fd173208b93c))


### Bug Fixes

* **events:** preserve timeout and connect observations ([#28397](https://github.com/vm0-ai/vm0/issues/28397)) ([c3d536e](https://github.com/vm0-ai/vm0/commit/c3d536eab61fca8e2006a7664a982b993537db00))
* **guest-agent:** classify mid-response failures ([#28393](https://github.com/vm0-ai/vm0/issues/28393)) ([4ca21bd](https://github.com/vm0-ai/vm0/commit/4ca21bdbe47a2ce99f34c343b074f83c45775483))
* **guest-agent:** ignore task notification results ([#28534](https://github.com/vm0-ai/vm0/issues/28534)) ([db3e953](https://github.com/vm0-ai/vm0/commit/db3e95327b14181d74456de8f00120bd1e186be0))
* **guest-agent:** keep claude appended prompts out of argv ([#28838](https://github.com/vm0-ai/vm0/issues/28838)) ([0bd96d6](https://github.com/vm0-ai/vm0/commit/0bd96d69d6b9121e37232080a35111550f709424))
* **guest-agent:** mask sandbox operation telemetry ([#28512](https://github.com/vm0-ai/vm0/issues/28512)) ([d81bf2d](https://github.com/vm0-ai/vm0/commit/d81bf2d0505e96a7e76efc5365c2275e271dca2f))
* **guest-agent:** redact multiline secrets in telemetry ([#28514](https://github.com/vm0-ai/vm0/issues/28514)) ([484c288](https://github.com/vm0-ai/vm0/commit/484c28853522c09be3eca6e9aa21726169dc0665))
* **guest-agent:** reject artifact roots with linked ancestors ([#28899](https://github.com/vm0-ai/vm0/issues/28899)) ([8923a95](https://github.com/vm0-ai/vm0/commit/8923a95def24f40702c333043b48b7c3cd83600d))
* **guest:** isolate managed claude config from user home ([#28324](https://github.com/vm0-ai/vm0/issues/28324)) ([c6a20ba](https://github.com/vm0-ai/vm0/commit/c6a20babf5f75ffac7ac97f69c570ba1ddb2ef23))
* handle revoked claude code oauth tokens ([#29181](https://github.com/vm0-ai/vm0/issues/29181)) ([fefb3c9](https://github.com/vm0-ai/vm0/commit/fefb3c9a1a46d6239f9646b2280054e1ee133687))
* **runner:** isolate shell tool oom cleanup ([#28391](https://github.com/vm0-ai/vm0/issues/28391)) ([ffb0332](https://github.com/vm0-ai/vm0/commit/ffb03327e60854d4e5e541b34a2f3423cfcee6f2))
* surface claude terms acceptance failures ([#28314](https://github.com/vm0-ai/vm0/issues/28314)) ([dc0674c](https://github.com/vm0-ai/vm0/commit/dc0674cd33b9b5ec44e592814c4f7b0c3d952575))


### Documentation

* **rust:** document guest event preparation and posting boundaries ([#28918](https://github.com/vm0-ai/vm0/issues/28918)) ([4aaa4ee](https://github.com/vm0-ai/vm0/commit/4aaa4ee66ba3a54473ee1d34c3ef12e861894234))


### Refactoring

* **guest-agent:** dual-read api token environment aliases ([#29062](https://github.com/vm0-ai/vm0/issues/29062)) ([1f21af7](https://github.com/vm0-ai/vm0/commit/1f21af778ef9513a49ee40de8e6176aba08e80ac))
* **guest-agent:** dual-read codex service-tier environment aliases ([#29038](https://github.com/vm0-ai/vm0/issues/29038)) ([dc84c21](https://github.com/vm0-ai/vm0/commit/dc84c21c569fc9919321c27ee2af32209d319ee7))
* **runtime:** dual-read cgroup placement environment aliases ([#29081](https://github.com/vm0-ai/vm0/issues/29081)) ([7beb4d5](https://github.com/vm0-ai/vm0/commit/7beb4d545bef801b7dd0bd2c107829869cd022ed))
* **runtime:** dual-read guest runtime directory aliases ([#29101](https://github.com/vm0-ai/vm0/issues/29101)) ([3bb5b28](https://github.com/vm0-ai/vm0/commit/3bb5b2807090c3cf48650b917ccca00bdb44f370))
* **runtime:** dual-read private payload file env aliases ([#29082](https://github.com/vm0-ai/vm0/issues/29082)) ([e400e00](https://github.com/vm0-ai/vm0/commit/e400e0058cd63cc18b478ad807da42f9b5bb5e74))
* **runtime:** dual-read process-control environment aliases ([#29071](https://github.com/vm0-ai/vm0/issues/29071)) ([c9cde49](https://github.com/vm0-ai/vm0/commit/c9cde495a4ba6f43c409476a68733bdade8cb99c))
* **runtime:** dual-read resume session environment aliases ([#29069](https://github.com/vm0-ai/vm0/issues/29069)) ([6dd54e9](https://github.com/vm0-ai/vm0/commit/6dd54e909a8607421344e758adcb887f72f8f0de))
* **runtime:** dual-read run metadata env aliases ([#29022](https://github.com/vm0-ai/vm0/issues/29022)) ([928d53b](https://github.com/vm0-ai/vm0/commit/928d53b17819c1c82f76da3aa8e4e672c69431d1))


### Performance Improvements

* **guest-agent:** bound reuse cleanup memory ([#28593](https://github.com/vm0-ai/vm0/issues/28593)) ([23ac7ce](https://github.com/vm0-ai/vm0/commit/23ac7ce52340901becc277fa521dd649b8d23d59))
* **guest-agent:** buffer transcript writes ([#28881](https://github.com/vm0-ai/vm0/issues/28881)) ([a401186](https://github.com/vm0-ai/vm0/commit/a401186650c98a904bf4d4f435868f91239d20d1))
* **guest-agent:** retain compact pi terminal state ([#29179](https://github.com/vm0-ai/vm0/issues/29179)) ([6e5f64e](https://github.com/vm0-ai/vm0/commit/6e5f64ecdc9d0c0024ecd62fab55b9baccdf1fda))
* **rust:** bound generic codex completed-item fields ([#28876](https://github.com/vm0-ai/vm0/issues/28876)) ([b13d3d2](https://github.com/vm0-ai/vm0/commit/b13d3d21e2630ac4472083988f4ca2766fa1b3e1))

## [0.75.10](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.75.9...guest-agent-v0.75.10) (2026-08-25)

## [0.75.9](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.75.8...guest-agent-v0.75.9) (2026-08-24)


### Refactoring

* **runtime:** dual-read cgroup placement environment aliases ([#29081](https://github.com/vm0-ai/vm0/issues/29081)) ([7beb4d5](https://github.com/vm0-ai/vm0/commit/7beb4d545bef801b7dd0bd2c107829869cd022ed))
* **runtime:** dual-read guest runtime directory aliases ([#29101](https://github.com/vm0-ai/vm0/issues/29101)) ([3bb5b28](https://github.com/vm0-ai/vm0/commit/3bb5b2807090c3cf48650b917ccca00bdb44f370))
* **runtime:** dual-read private payload file env aliases ([#29082](https://github.com/vm0-ai/vm0/issues/29082)) ([e400e00](https://github.com/vm0-ai/vm0/commit/e400e0058cd63cc18b478ad807da42f9b5bb5e74))
* **runtime:** dual-read process-control environment aliases ([#29071](https://github.com/vm0-ai/vm0/issues/29071)) ([c9cde49](https://github.com/vm0-ai/vm0/commit/c9cde495a4ba6f43c409476a68733bdade8cb99c))
* **runtime:** dual-read resume session environment aliases ([#29069](https://github.com/vm0-ai/vm0/issues/29069)) ([6dd54e9](https://github.com/vm0-ai/vm0/commit/6dd54e909a8607421344e758adcb887f72f8f0de))

## [0.75.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.75.7...guest-agent-v0.75.8) (2026-08-24)


### Refactoring

* **guest-agent:** dual-read api token environment aliases ([#29062](https://github.com/vm0-ai/vm0/issues/29062)) ([1f21af7](https://github.com/vm0-ai/vm0/commit/1f21af778ef9513a49ee40de8e6176aba08e80ac))

## [0.75.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.75.6...guest-agent-v0.75.7) (2026-08-24)


### Refactoring

* **guest-agent:** dual-read codex service-tier environment aliases ([#29038](https://github.com/vm0-ai/vm0/issues/29038)) ([dc84c21](https://github.com/vm0-ai/vm0/commit/dc84c21c569fc9919321c27ee2af32209d319ee7))
* **runtime:** dual-read run metadata env aliases ([#29022](https://github.com/vm0-ai/vm0/issues/29022)) ([928d53b](https://github.com/vm0-ai/vm0/commit/928d53b17819c1c82f76da3aa8e4e672c69431d1))

## [0.75.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.75.5...guest-agent-v0.75.6) (2026-08-24)

## [0.75.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.75.4...guest-agent-v0.75.5) (2026-08-24)


### Bug Fixes

* **guest-agent:** reject artifact roots with linked ancestors ([#28899](https://github.com/vm0-ai/vm0/issues/28899)) ([8923a95](https://github.com/vm0-ai/vm0/commit/8923a95def24f40702c333043b48b7c3cd83600d))


### Documentation

* **rust:** document guest event preparation and posting boundaries ([#28918](https://github.com/vm0-ai/vm0/issues/28918)) ([4aaa4ee](https://github.com/vm0-ai/vm0/commit/4aaa4ee66ba3a54473ee1d34c3ef12e861894234))

## [0.75.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.75.3...guest-agent-v0.75.4) (2026-08-24)


### Performance Improvements

* **guest-agent:** buffer transcript writes ([#28881](https://github.com/vm0-ai/vm0/issues/28881)) ([a401186](https://github.com/vm0-ai/vm0/commit/a401186650c98a904bf4d4f435868f91239d20d1))
* **rust:** bound generic codex completed-item fields ([#28876](https://github.com/vm0-ai/vm0/issues/28876)) ([b13d3d2](https://github.com/vm0-ai/vm0/commit/b13d3d21e2630ac4472083988f4ca2766fa1b3e1))

## [0.75.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.75.2...guest-agent-v0.75.3) (2026-08-24)


### Bug Fixes

* **guest-agent:** keep claude appended prompts out of argv ([#28838](https://github.com/vm0-ai/vm0/issues/28838)) ([0bd96d6](https://github.com/vm0-ai/vm0/commit/0bd96d69d6b9121e37232080a35111550f709424))

## [0.75.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.75.1...guest-agent-v0.75.2) (2026-08-24)

## [0.75.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.75.0...guest-agent-v0.75.1) (2026-08-23)

## [0.75.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.22...guest-agent-v0.75.0) (2026-08-23)


### Features

* **api:** add strict pi api first-turn handoff ([#28664](https://github.com/vm0-ai/vm0/issues/28664)) ([4bc9ef0](https://github.com/vm0-ai/vm0/commit/4bc9ef063e244a3f3af8dbc9ab94fd173208b93c))

## [0.74.22](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.21...guest-agent-v0.74.22) (2026-08-22)


### Performance Improvements

* **guest-agent:** bound reuse cleanup memory ([#28593](https://github.com/vm0-ai/vm0/issues/28593)) ([23ac7ce](https://github.com/vm0-ai/vm0/commit/23ac7ce52340901becc277fa521dd649b8d23d59))

## [0.74.21](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.20...guest-agent-v0.74.21) (2026-08-21)

## [0.74.20](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.19...guest-agent-v0.74.20) (2026-08-21)

## [0.74.19](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.18...guest-agent-v0.74.19) (2026-08-21)


### Bug Fixes

* **guest-agent:** ignore task notification results ([#28534](https://github.com/vm0-ai/vm0/issues/28534)) ([db3e953](https://github.com/vm0-ai/vm0/commit/db3e95327b14181d74456de8f00120bd1e186be0))
* **guest-agent:** mask sandbox operation telemetry ([#28512](https://github.com/vm0-ai/vm0/issues/28512)) ([d81bf2d](https://github.com/vm0-ai/vm0/commit/d81bf2d0505e96a7e76efc5365c2275e271dca2f))
* **guest-agent:** redact multiline secrets in telemetry ([#28514](https://github.com/vm0-ai/vm0/issues/28514)) ([484c288](https://github.com/vm0-ai/vm0/commit/484c28853522c09be3eca6e9aa21726169dc0665))
* **runner:** isolate shell tool oom cleanup ([#28391](https://github.com/vm0-ai/vm0/issues/28391)) ([ffb0332](https://github.com/vm0-ai/vm0/commit/ffb03327e60854d4e5e541b34a2f3423cfcee6f2))

## [0.74.18](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.17...guest-agent-v0.74.18) (2026-08-21)

## [0.74.17](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.16...guest-agent-v0.74.17) (2026-08-20)

## [0.74.16](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.15...guest-agent-v0.74.16) (2026-08-20)


### Bug Fixes

* **events:** preserve timeout and connect observations ([#28397](https://github.com/vm0-ai/vm0/issues/28397)) ([c3d536e](https://github.com/vm0-ai/vm0/commit/c3d536eab61fca8e2006a7664a982b993537db00))
* **guest-agent:** classify mid-response failures ([#28393](https://github.com/vm0-ai/vm0/issues/28393)) ([4ca21bd](https://github.com/vm0-ai/vm0/commit/4ca21bdbe47a2ce99f34c343b074f83c45775483))
* **guest:** isolate managed claude config from user home ([#28324](https://github.com/vm0-ai/vm0/issues/28324)) ([c6a20ba](https://github.com/vm0-ai/vm0/commit/c6a20babf5f75ffac7ac97f69c570ba1ddb2ef23))
* surface claude terms acceptance failures ([#28314](https://github.com/vm0-ai/vm0/issues/28314)) ([dc0674c](https://github.com/vm0-ai/vm0/commit/dc0674cd33b9b5ec44e592814c4f7b0c3d952575))

## [0.74.15](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.14...guest-agent-v0.74.15) (2026-08-20)


### Bug Fixes

* **guest:** isolate managed codex home from user home ([#28264](https://github.com/vm0-ai/vm0/issues/28264)) ([d4274c2](https://github.com/vm0-ai/vm0/commit/d4274c2ab1236f0be82390a7598798961b6b0a57))


### Documentation

* **rust:** document guest-agent helper protocol ([#28271](https://github.com/vm0-ai/vm0/issues/28271)) ([19c84f4](https://github.com/vm0-ai/vm0/commit/19c84f4ee6c75d80aa875aa158fb2f2d3288f37f))

## [0.74.14](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.13...guest-agent-v0.74.14) (2026-08-20)


### Bug Fixes

* **guest-agent:** keep resource counters out of failure messages ([#28225](https://github.com/vm0-ai/vm0/issues/28225)) ([2ccc0d8](https://github.com/vm0-ai/vm0/commit/2ccc0d88072b231b68f6d852228317b3a65e8d4e))


### Documentation

* **guest-agent:** document heartbeat interval contract ([#28166](https://github.com/vm0-ai/vm0/issues/28166)) ([7d689f5](https://github.com/vm0-ai/vm0/commit/7d689f580d7478b41538f1b25280f2dc49a516df))


### Refactoring

* **guest-agent:** drop the legacy agent context env key ([#28177](https://github.com/vm0-ai/vm0/issues/28177)) ([0f16e8e](https://github.com/vm0-ai/vm0/commit/0f16e8ee08c718ffaaf59298efa0f71a93ea4a2f)), closes [#28170](https://github.com/vm0-ai/vm0/issues/28170)

## [0.74.13](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.12...guest-agent-v0.74.13) (2026-08-18)


### Bug Fixes

* **guest-agent:** report telemetry position persistence status ([#28040](https://github.com/vm0-ai/vm0/issues/28040)) ([112e8ad](https://github.com/vm0-ai/vm0/commit/112e8adfd0a3cef07222930d65f391169dc7073d))

## [0.74.12](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.11...guest-agent-v0.74.12) (2026-08-18)


### Refactoring

* **rust:** generate codex runtime config ([#28035](https://github.com/vm0-ai/vm0/issues/28035)) ([de3d53b](https://github.com/vm0-ai/vm0/commit/de3d53ba1c521a9a623552fe33e71e61da37b145))


### Performance Improvements

* **guest-agent:** avoid reparsing native history candidates ([#28034](https://github.com/vm0-ai/vm0/issues/28034)) ([c72e2ca](https://github.com/vm0-ai/vm0/commit/c72e2cabd608f46cc00b3522c0775c3904646e45))
* **guest:** isolate receipt journal fsyncs from tokio workers ([#27983](https://github.com/vm0-ai/vm0/issues/27983)) ([841c229](https://github.com/vm0-ai/vm0/commit/841c229bb7cb4b105bd1776a7a88a86171d72beb))

## [0.74.11](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.10...guest-agent-v0.74.11) (2026-08-18)


### Documentation

* **rust:** align pi launch contract docs with schema v2 ([#27851](https://github.com/vm0-ai/vm0/issues/27851)) ([b42e81c](https://github.com/vm0-ai/vm0/commit/b42e81ca8080bbffc3d2d79a4566b8b2d766eceb))


### Refactoring

* **rust:** neutralize session-history identity type names ([#27895](https://github.com/vm0-ai/vm0/issues/27895)) ([fff9b30](https://github.com/vm0-ai/vm0/commit/fff9b3074cc4e590b2fdb4318da515fcc4605a70))

## [0.74.10](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.9...guest-agent-v0.74.10) (2026-08-18)


### Bug Fixes

* **guest-agent:** preserve pi tool events ([#27795](https://github.com/vm0-ai/vm0/issues/27795)) ([fae456a](https://github.com/vm0-ai/vm0/commit/fae456a615fb2a955bbb62dc0b6c326dfdb75f92))

## [0.74.9](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.8...guest-agent-v0.74.9) (2026-08-17)

## [0.74.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.7...guest-agent-v0.74.8) (2026-08-17)


### Refactoring

* **rust:** centralize workload cgroup events ([#27747](https://github.com/vm0-ai/vm0/issues/27747)) ([e25a143](https://github.com/vm0-ai/vm0/commit/e25a1432fe660498f8a4de977c0c07a5ed969080))

## [0.74.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.6...guest-agent-v0.74.7) (2026-08-17)

## [0.74.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.5...guest-agent-v0.74.6) (2026-08-16)


### Documentation

* **rust:** correct Codex auth refresh reference ([#27566](https://github.com/vm0-ai/vm0/issues/27566)) ([1d9d6e7](https://github.com/vm0-ai/vm0/commit/1d9d6e725a302f044efed3662e8f29745e2c6b34))

## [0.74.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.4...guest-agent-v0.74.5) (2026-08-16)


### Refactoring

* **guest-agent:** remove checkpoint compatibility fallback ([#27511](https://github.com/vm0-ai/vm0/issues/27511)) ([d01eaf2](https://github.com/vm0-ai/vm0/commit/d01eaf22c7f9ead2b45602cefcec89153a318ec4))

## [0.74.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.3...guest-agent-v0.74.4) (2026-08-15)


### Bug Fixes

* **guest-agent:** bound claude tool tracking state ([#27374](https://github.com/vm0-ai/vm0/issues/27374)) ([8ea92c0](https://github.com/vm0-ai/vm0/commit/8ea92c05666a0f0ce10774a1a0efae57fc30a509))
* **guest-agent:** remove session history marker authority ([#27284](https://github.com/vm0-ai/vm0/issues/27284)) ([1bf8617](https://github.com/vm0-ai/vm0/commit/1bf8617d3a04b6beccba5f81795d57476e728ffe))
* **runner:** gate active-input smoke readiness ([#27389](https://github.com/vm0-ai/vm0/issues/27389)) ([79d358a](https://github.com/vm0-ai/vm0/commit/79d358a4a45bb3e4454156159813d23561af3e91))

## [0.74.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.2...guest-agent-v0.74.3) (2026-08-15)


### Bug Fixes

* **guest-agent:** preserve classified failure messages ([#27311](https://github.com/vm0-ai/vm0/issues/27311)) ([936474b](https://github.com/vm0-ai/vm0/commit/936474b06350f8a93c2d4f73b7d87c518eec389c))

## [0.74.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.1...guest-agent-v0.74.2) (2026-08-14)


### Refactoring

* **pi:** use official resources and jsonl sessions ([#27288](https://github.com/vm0-ai/vm0/issues/27288)) ([b287f72](https://github.com/vm0-ai/vm0/commit/b287f7270f0fd0613adff61ab91289b73e39e7f6))

## [0.74.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.74.0...guest-agent-v0.74.1) (2026-08-14)

## [0.74.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.73.9...guest-agent-v0.74.0) (2026-08-14)


### Features

* use official pi rpc lifecycle ([#27252](https://github.com/vm0-ai/vm0/issues/27252)) ([38051ff](https://github.com/vm0-ai/vm0/commit/38051ff9d3c2505c4ac133d196eeb881817249fe))


### Bug Fixes

* **guest-agent:** preserve descendant cleanup without pidfd ([#27185](https://github.com/vm0-ai/vm0/issues/27185)) ([097a91f](https://github.com/vm0-ai/vm0/commit/097a91f380ccff0e2033d52a800e3d2094467b3c))
* **runner:** preserve runs after tool process oom ([#27272](https://github.com/vm0-ai/vm0/issues/27272)) ([bdba0d6](https://github.com/vm0-ai/vm0/commit/bdba0d6cfb57fec9f7193a02ab93dbf7b7074ea9))

## [0.73.9](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.73.8...guest-agent-v0.73.9) (2026-08-14)


### Bug Fixes

* **runner:** let guest reclaim memory before workload oom ([#27206](https://github.com/vm0-ai/vm0/issues/27206)) ([d8bd1c7](https://github.com/vm0-ai/vm0/commit/d8bd1c7471c220f8595edcb64dde3e70840d4467))

## [0.73.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.73.7...guest-agent-v0.73.8) (2026-08-14)


### Bug Fixes

* **guest-agent:** make agent log persistence best effort ([#27135](https://github.com/vm0-ai/vm0/issues/27135)) ([28356db](https://github.com/vm0-ai/vm0/commit/28356db2c3d9701530700771be2220c19c474b5b))

## [0.73.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.73.6...guest-agent-v0.73.7) (2026-08-14)


### Bug Fixes

* **runner:** disable workload memory.high reclaim ([#27126](https://github.com/vm0-ai/vm0/issues/27126)) ([24743ab](https://github.com/vm0-ai/vm0/commit/24743ab1a9901f769ee07a40cffea63c2a516e37))

## [0.73.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.73.5...guest-agent-v0.73.6) (2026-08-14)


### Refactoring

* **pi:** build the pi prompt inside the sandbox ([#27036](https://github.com/vm0-ai/vm0/issues/27036)) ([1e248af](https://github.com/vm0-ai/vm0/commit/1e248afd1118468a8950f81c668d65b27fe6f429))

## [0.73.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.73.4...guest-agent-v0.73.5) (2026-08-14)


### Bug Fixes

* **guest:** terminate stuck codex steers after timeout ([#27044](https://github.com/vm0-ai/vm0/issues/27044)) ([9e713bb](https://github.com/vm0-ai/vm0/commit/9e713bb9e1c18fc53a351a29b4397bb2e6e25bb4))

## [0.73.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.73.3...guest-agent-v0.73.4) (2026-08-13)

## [0.73.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.73.2...guest-agent-v0.73.3) (2026-08-13)


### Refactoring

* **rust:** share active-input control payload contract ([#26950](https://github.com/vm0-ai/vm0/issues/26950)) ([403bfd8](https://github.com/vm0-ai/vm0/commit/403bfd8f08fcd272d7c39df9149b1aa9124dca42))

## [0.73.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.73.1...guest-agent-v0.73.2) (2026-08-13)


### Bug Fixes

* disable Codex image generation ([#26879](https://github.com/vm0-ai/vm0/issues/26879)) ([43fa6e1](https://github.com/vm0-ai/vm0/commit/43fa6e113f583f9d06768a043f9382a86423b050))
* **runner:** preserve guest control headroom under workload pressure ([#26683](https://github.com/vm0-ai/vm0/issues/26683)) ([789adcd](https://github.com/vm0-ai/vm0/commit/789adcd9e7a35dc545ae660f4b5a55d802ea854f))

## [0.73.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.73.0...guest-agent-v0.73.1) (2026-08-13)


### Bug Fixes

* **runner:** retire legacy pi run id compatibility ([#26830](https://github.com/vm0-ai/vm0/issues/26830)) ([8ad8821](https://github.com/vm0-ai/vm0/commit/8ad8821431080de674c4d83159e344a31d7877ca))

## [0.73.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.72.0...guest-agent-v0.73.0) (2026-08-13)


### Features

* **runner:** migrate pi child environment to okou ([#26810](https://github.com/vm0-ai/vm0/issues/26810)) ([9c54e70](https://github.com/vm0-ai/vm0/commit/9c54e70777750b608dad06fde2a44a5a08f9796b))


### Refactoring

* **guest:** centralize private file replacement ([#26786](https://github.com/vm0-ai/vm0/issues/26786)) ([b12cef8](https://github.com/vm0-ai/vm0/commit/b12cef89edbcdf0f9748dba40f3ebe99bfb3fbe5))


### Performance Improvements

* **guest-agent:** prevent overdue heartbeat replay ([#26792](https://github.com/vm0-ai/vm0/issues/26792)) ([8f03dfe](https://github.com/vm0-ai/vm0/commit/8f03dfef2cb09562767a4b9c2fa6b7865e06e489))

## [0.72.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.71.3...guest-agent-v0.72.0) (2026-08-13)


### Features

* **runner:** migrate run identity env to okou ([#26796](https://github.com/vm0-ai/vm0/issues/26796)) ([88850c3](https://github.com/vm0-ai/vm0/commit/88850c33b9bb20018d9e0fd12097cc5eb7fb2bde))

## [0.71.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.71.2...guest-agent-v0.71.3) (2026-08-12)


### Refactoring

* **pi:** persist sandbox sessions in native sqlite ([#26555](https://github.com/vm0-ai/vm0/issues/26555)) ([9ed505e](https://github.com/vm0-ai/vm0/commit/9ed505e1c567ff019d521fac167700c2b390cffe))

## [0.71.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.71.1...guest-agent-v0.71.2) (2026-08-12)


### Bug Fixes

* discard oversized session history at checkpoint ([#26635](https://github.com/vm0-ai/vm0/issues/26635)) ([b449da7](https://github.com/vm0-ai/vm0/commit/b449da711810bebde8cf12f9a1b6c7acceefe2c9))


### Refactoring

* **chat:** remove active input rollout compatibility ([#26625](https://github.com/vm0-ai/vm0/issues/26625)) ([8d1be07](https://github.com/vm0-ai/vm0/commit/8d1be07f2d1665a02d86cb2ef550fa9a1f1e212a))
* **cli:** remove zero migration compatibility ([#26640](https://github.com/vm0-ai/vm0/issues/26640)) ([fd1fa43](https://github.com/vm0-ai/vm0/commit/fd1fa43ac7b94af08ee21a85dfaf8c06dcdc2a98))
* **rust:** centralize guest stdout framing limits ([#26648](https://github.com/vm0-ai/vm0/issues/26648)) ([962e753](https://github.com/vm0-ai/vm0/commit/962e7532f4e8d319fb05b096bdbfca85431731ed))

## [0.71.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.71.0...guest-agent-v0.71.1) (2026-08-12)


### Bug Fixes

* **guest-agent:** bound oversized codex event delivery ([#26520](https://github.com/vm0-ai/vm0/issues/26520)) ([cf619b1](https://github.com/vm0-ai/vm0/commit/cf619b153ddae4fdb3c4b00065d737d1d9194bb0))

## [0.71.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.70.0...guest-agent-v0.71.0) (2026-08-12)


### Features

* **protocol:** accept okou environment names and token scope ([#26505](https://github.com/vm0-ai/vm0/issues/26505)) ([6d4b0c7](https://github.com/vm0-ai/vm0/commit/6d4b0c7b08179e5d816af6d53208248bf79d3cd4))

## [0.70.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.69.1...guest-agent-v0.70.0) (2026-08-12)


### Features

* cut first-party cli producers over to okou ([#26491](https://github.com/vm0-ai/vm0/issues/26491)) ([33c4c03](https://github.com/vm0-ai/vm0/commit/33c4c034b421249e220bb0f586a514d44ed78655))

## [0.69.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.69.0...guest-agent-v0.69.1) (2026-08-12)


### Documentation

* **guest-agent:** clarify secret length byte threshold ([#26448](https://github.com/vm0-ai/vm0/issues/26448)) ([274efbc](https://github.com/vm0-ai/vm0/commit/274efbca39310e71a0dc04e0f04374216ec03ef2))

## [0.69.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.68.0...guest-agent-v0.69.0) (2026-08-11)


### Features

* **runner:** enable durable active-input delivery ([#26392](https://github.com/vm0-ai/vm0/issues/26392)) ([6225b5e](https://github.com/vm0-ai/vm0/commit/6225b5e85da2833f011830d21498744893b2f625))

## [0.68.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.67.0...guest-agent-v0.68.0) (2026-08-11)


### Features

* **guest:** persist active-input acceptance receipts ([#26191](https://github.com/vm0-ai/vm0/issues/26191)) ([f6ede96](https://github.com/vm0-ai/vm0/commit/f6ede96f136515283ec1f76d380cc3c835f85420))

## [0.67.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.66.5...guest-agent-v0.67.0) (2026-08-10)


### Features

* add priority inheritance and gpt-5.6 fast billing ([#26147](https://github.com/vm0-ai/vm0/issues/26147)) ([3350fbb](https://github.com/vm0-ai/vm0/commit/3350fbbec7afa95483d0b051e6580fa969a50b10))

## [0.66.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.66.4...guest-agent-v0.66.5) (2026-08-10)

## [0.66.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.66.3...guest-agent-v0.66.4) (2026-08-10)


### Documentation

* **rust:** document pi standby current-run gate ([#26039](https://github.com/vm0-ai/vm0/issues/26039)) ([a1c13c7](https://github.com/vm0-ai/vm0/commit/a1c13c7ee2229ec2a5a74768f5c3e31cfae76ec2))

## [0.66.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.66.2...guest-agent-v0.66.3) (2026-08-10)


### Bug Fixes

* **runner:** preserve sidecar export failure causes ([#25999](https://github.com/vm0-ai/vm0/issues/25999)) ([76c5c0a](https://github.com/vm0-ai/vm0/commit/76c5c0a8470eecbce17615134b3a6f6c306a98a9))

## [0.66.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.66.1...guest-agent-v0.66.2) (2026-08-10)


### Bug Fixes

* **guest-agent:** disable codex native goals ([#25981](https://github.com/vm0-ai/vm0/issues/25981)) ([17338ff](https://github.com/vm0-ai/vm0/commit/17338ffd1ab2b28ab76ac463f76bade20d2dee72))

## [0.66.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.66.0...guest-agent-v0.66.1) (2026-08-09)

## [0.66.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.65.7...guest-agent-v0.66.0) (2026-08-09)


### Features

* persist and display runner reuse outcomes ([#25942](https://github.com/vm0-ai/vm0/issues/25942)) ([90f8d8f](https://github.com/vm0-ai/vm0/commit/90f8d8ffb713f7f99acd8377b8cba26a91504d0b))

## [0.65.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.65.6...guest-agent-v0.65.7) (2026-08-09)

## [0.65.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.65.5...guest-agent-v0.65.6) (2026-08-09)


### Documentation

* **rust:** document app-server cancellation semantics ([#25880](https://github.com/vm0-ai/vm0/issues/25880)) ([1b1d984](https://github.com/vm0-ai/vm0/commit/1b1d984b2c9ad2ad2a216ec678ec9bd1d26e2a87))


### Refactoring

* **pi:** replace handoff fallbacks with session polling ([#25906](https://github.com/vm0-ai/vm0/issues/25906)) ([66cbcad](https://github.com/vm0-ai/vm0/commit/66cbcada1c224b1c7541b6d7c90696d3733e53f8))


### Performance Improvements

* **guest-agent:** compact artifact manifests ([#25886](https://github.com/vm0-ai/vm0/issues/25886)) ([94ab439](https://github.com/vm0-ai/vm0/commit/94ab43970058094f4ffe095db41339a6354cc5b9))

## [0.65.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.65.4...guest-agent-v0.65.5) (2026-08-08)


### Bug Fixes

* snapshot writeback artifacts when a pi sandbox run completes ([#25831](https://github.com/vm0-ai/vm0/issues/25831)) ([ae814e0](https://github.com/vm0-ai/vm0/commit/ae814e004f35538ba8d6421b4ee9631c6ebbf44b)), closes [#25827](https://github.com/vm0-ai/vm0/issues/25827)

## [0.65.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.65.3...guest-agent-v0.65.4) (2026-08-08)

## [0.65.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.65.2...guest-agent-v0.65.3) (2026-08-08)


### Bug Fixes

* **runner:** preserve exact reuse generation on rollback ([#25753](https://github.com/vm0-ai/vm0/issues/25753)) ([5b7191c](https://github.com/vm0-ai/vm0/commit/5b7191cdc389da31a23a5ffbefd196c0a510e53a))

## [0.65.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.65.1...guest-agent-v0.65.2) (2026-08-07)


### Documentation

* **rust:** document pi standby lifecycle ([#25659](https://github.com/vm0-ai/vm0/issues/25659)) ([373a5b4](https://github.com/vm0-ai/vm0/commit/373a5b44a3cea5da393252623bf533ed8b0cf5fd))

## [0.65.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.65.0...guest-agent-v0.65.1) (2026-08-07)

## [0.65.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.64.9...guest-agent-v0.65.0) (2026-08-07)


### Features

* complete pi agent handoff end to end ([#25489](https://github.com/vm0-ai/vm0/issues/25489)) ([feeb1cb](https://github.com/vm0-ai/vm0/commit/feeb1cbc8e838b844945cf5efc3ed7e9820c10a4))


### Bug Fixes

* **guest-agent:** classify credit error envelopes ([#25580](https://github.com/vm0-ai/vm0/issues/25580)) ([61475bf](https://github.com/vm0-ai/vm0/commit/61475bf97e6750715d4db0115444219f16636fe5))
* **runner:** materialize prune-eligible codex zstd history ([#25582](https://github.com/vm0-ai/vm0/issues/25582)) ([44df9f2](https://github.com/vm0-ai/vm0/commit/44df9f2c4dc9ec5640cc54316c944a8164f54a3f))

## [0.64.9](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.64.8...guest-agent-v0.64.9) (2026-08-07)


### Refactoring

* **runner:** remove obsolete codex event fallbacks ([#25511](https://github.com/vm0-ai/vm0/issues/25511)) ([94e8703](https://github.com/vm0-ai/vm0/commit/94e87037eef09c503c7280070237483fafad69fa))

## [0.64.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.64.7...guest-agent-v0.64.8) (2026-08-07)

## [0.64.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.64.6...guest-agent-v0.64.7) (2026-08-06)


### Refactoring

* **runner:** use codex app-server exclusively ([#25460](https://github.com/vm0-ai/vm0/issues/25460)) ([61b623a](https://github.com/vm0-ai/vm0/commit/61b623adffb6da6d16dd01355773ea342258b894))

## [0.64.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.64.5...guest-agent-v0.64.6) (2026-08-06)

## [0.64.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.64.4...guest-agent-v0.64.5) (2026-08-05)


### Bug Fixes

* **guest-agent:** isolate api token from cli descendants ([#25205](https://github.com/vm0-ai/vm0/issues/25205)) ([b057140](https://github.com/vm0-ai/vm0/commit/b057140f03c25cfeeabaa1afc0ed91575f9371ab))

## [0.64.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.64.3...guest-agent-v0.64.4) (2026-08-05)

## [0.64.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.64.2...guest-agent-v0.64.3) (2026-08-05)


### Refactoring

* **rust:** centralize epoch-millisecond validation ([#25159](https://github.com/vm0-ai/vm0/issues/25159)) ([4780d82](https://github.com/vm0-ai/vm0/commit/4780d82181ac10f4f7bfaafc6b16e448f89f2860))

## [0.64.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.64.1...guest-agent-v0.64.2) (2026-08-05)


### Refactoring

* **rust:** use rustix for child exit pidfds ([#25122](https://github.com/vm0-ai/vm0/issues/25122)) ([85100f1](https://github.com/vm0-ai/vm0/commit/85100f174664559002a35778a73a3b4d9ec722ad))

## [0.64.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.64.0...guest-agent-v0.64.1) (2026-08-04)


### Refactoring

* canonicalize deepseek model provider ([#25030](https://github.com/vm0-ai/vm0/issues/25030)) ([c19ea0f](https://github.com/vm0-ai/vm0/commit/c19ea0fa2d196143ab899db3953904c814e2b016))

## [0.64.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.63.7...guest-agent-v0.64.0) (2026-08-04)


### Features

* **chat:** add feature-gated inline steering ([#24941](https://github.com/vm0-ai/vm0/issues/24941)) ([f705e9d](https://github.com/vm0-ai/vm0/commit/f705e9d8d1a1038055d62839ce0bb3725edbd2e3))

## [0.63.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.63.6...guest-agent-v0.63.7) (2026-08-04)

## [0.63.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.63.5...guest-agent-v0.63.6) (2026-08-04)


### Performance Improvements

* **guest-agent:** measure codex catalog setup ([#24996](https://github.com/vm0-ai/vm0/issues/24996)) ([8f78d8d](https://github.com/vm0-ai/vm0/commit/8f78d8dd548bf1d8ce547f6d0e571db0775e89fb))

## [0.63.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.63.4...guest-agent-v0.63.5) (2026-08-04)


### Refactoring

* **guest-agent:** hydrate codex catalogs structurally ([#24957](https://github.com/vm0-ai/vm0/issues/24957)) ([7520643](https://github.com/vm0-ai/vm0/commit/75206430a93a6f4fcdb1dfec1f43f93499ef85ba))

## [0.63.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.63.3...guest-agent-v0.63.4) (2026-08-04)


### Performance Improvements

* **guest-agent:** bound artifact checkpoint manifests ([#24914](https://github.com/vm0-ai/vm0/issues/24914)) ([27694a0](https://github.com/vm0-ai/vm0/commit/27694a095efd2d559c1a539a512970567946fb85))

## [0.63.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.63.2...guest-agent-v0.63.3) (2026-08-04)

## [0.63.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.63.1...guest-agent-v0.63.2) (2026-08-04)


### Documentation

* **guest-agent:** clarify raw config empty values ([#24830](https://github.com/vm0-ai/vm0/issues/24830)) ([a8756fa](https://github.com/vm0-ai/vm0/commit/a8756fa18e99a4026094f0ed64c73fb3f78b2c80))

## [0.63.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.63.0...guest-agent-v0.63.1) (2026-08-03)


### Bug Fixes

* **guest-agent:** use process-owned mock build locks ([#24801](https://github.com/vm0-ai/vm0/issues/24801)) ([a4065d7](https://github.com/vm0-ai/vm0/commit/a4065d78e488b2ba4c518c292db362db081f2c2c))


### Performance Improvements

* **guest-agent:** use statx for reuse identity ([#24806](https://github.com/vm0-ai/vm0/issues/24806)) ([d3bbc05](https://github.com/vm0-ai/vm0/commit/d3bbc0578c5a00f44b1dfc063a9ae55d3ac1f139))

## [0.63.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.62.7...guest-agent-v0.63.0) (2026-08-03)


### Features

* enable claude session pruning globally ([#24790](https://github.com/vm0-ai/vm0/issues/24790)) ([4798ff0](https://github.com/vm0-ai/vm0/commit/4798ff006f50e684214197f62e3ac3c29e66178a))

## [0.62.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.62.6...guest-agent-v0.62.7) (2026-08-03)

## [0.62.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.62.5...guest-agent-v0.62.6) (2026-08-03)


### Refactoring

* **rust:** centralize base cli agent session id validation ([#24759](https://github.com/vm0-ai/vm0/issues/24759)) ([da34435](https://github.com/vm0-ai/vm0/commit/da34435c6747be672914e4651c29d0abd2b47936))

## [0.62.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.62.4...guest-agent-v0.62.5) (2026-08-03)


### Documentation

* **rust:** clarify session history diagnostic semantics ([#24671](https://github.com/vm0-ai/vm0/issues/24671)) ([ecf6630](https://github.com/vm0-ai/vm0/commit/ecf6630d6185b03b6de7bc606259a730dff462b4))


### Performance Improvements

* **guest-agent:** bound checkpoint history test fixtures ([#24682](https://github.com/vm0-ai/vm0/issues/24682)) ([200df14](https://github.com/vm0-ai/vm0/commit/200df141579bdc53a742747ff9c0099cf310a849))

## [0.62.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.62.3...guest-agent-v0.62.4) (2026-08-03)


### Bug Fixes

* **guest-agent:** redact overlapping secret matches ([#24639](https://github.com/vm0-ai/vm0/issues/24639)) ([dc20d30](https://github.com/vm0-ai/vm0/commit/dc20d300941918f11f98738142bca5fabfff6301))


### Refactoring

* **guest-agent:** split checkpoint integration tests ([#24626](https://github.com/vm0-ai/vm0/issues/24626)) ([40a7e1f](https://github.com/vm0-ai/vm0/commit/40a7e1f137751a8aeab2e9d1def2fefd49940572))

## [0.62.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.62.2...guest-agent-v0.62.3) (2026-08-03)

## [0.62.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.62.1...guest-agent-v0.62.2) (2026-08-02)


### Documentation

* **guest-agent:** document app-server event policy ([#24581](https://github.com/vm0-ai/vm0/issues/24581)) ([d9a27da](https://github.com/vm0-ai/vm0/commit/d9a27dad6d414438ec8af864b6e80e0c712fce7c))

## [0.62.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.62.0...guest-agent-v0.62.1) (2026-08-02)

## [0.62.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.61.6...guest-agent-v0.62.0) (2026-08-01)


### Features

* **guest-agent:** set fable effort to max ([#24483](https://github.com/vm0-ai/vm0/issues/24483)) ([f6e92b9](https://github.com/vm0-ai/vm0/commit/f6e92b97b32aec30c26e9e10eb613874d8cc6fff))

## [0.61.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.61.5...guest-agent-v0.61.6) (2026-08-01)


### Bug Fixes

* **guest-agent:** ignore secondary codex thread events ([#24466](https://github.com/vm0-ai/vm0/issues/24466)) ([20ed365](https://github.com/vm0-ai/vm0/commit/20ed365bf6639fdce6c6b42cb64f5a45ed3d2562))

## [0.61.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.61.4...guest-agent-v0.61.5) (2026-08-01)

## [0.61.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.61.3...guest-agent-v0.61.4) (2026-07-31)

## [0.61.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.61.2...guest-agent-v0.61.3) (2026-07-31)


### Documentation

* **rust:** document session-history sidecar export contract ([#24224](https://github.com/vm0-ai/vm0/issues/24224)) ([05ab252](https://github.com/vm0-ai/vm0/commit/05ab252160536271300f46221a2f42211675d08b))

## [0.61.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.61.1...guest-agent-v0.61.2) (2026-07-31)

## [0.61.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.61.0...guest-agent-v0.61.1) (2026-07-30)

## [0.61.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.60.2...guest-agent-v0.61.0) (2026-07-30)


### Features

* add admin-defined model gateway connections ([#23807](https://github.com/vm0-ai/vm0/issues/23807)) ([0632cb4](https://github.com/vm0-ai/vm0/commit/0632cb4e4dfda2c844a2531d6c13a3dd74b86e29))

## [0.60.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.60.1...guest-agent-v0.60.2) (2026-07-30)

## [0.60.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.60.0...guest-agent-v0.60.1) (2026-07-30)

## [0.60.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.59.0...guest-agent-v0.60.0) (2026-07-30)


### Features

* **events:** report structured guest event delivery failures ([#23974](https://github.com/vm0-ai/vm0/issues/23974)) ([ebdf828](https://github.com/vm0-ai/vm0/commit/ebdf8280b7b961ebf8404790a15696a7338ecd6e))

## [0.59.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.11...guest-agent-v0.59.0) (2026-07-30)


### Features

* enable codex session pruning globally ([#23937](https://github.com/vm0-ai/vm0/issues/23937)) ([e186ffe](https://github.com/vm0-ai/vm0/commit/e186ffe85a92fe9a5b960e5e3174893d54526557))

## [0.58.11](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.10...guest-agent-v0.58.11) (2026-07-30)


### Bug Fixes

* **guest-agent:** checkpoint user cancellations before completion ([#23899](https://github.com/vm0-ai/vm0/issues/23899)) ([ba905f6](https://github.com/vm0-ai/vm0/commit/ba905f65bb5f99fac077c236b4ca57175708ead5))

## [0.58.10](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.9...guest-agent-v0.58.10) (2026-07-29)

## [0.58.9](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.8...guest-agent-v0.58.9) (2026-07-29)


### Bug Fixes

* **runner:** checkpoint sessions before job timeout ([#23734](https://github.com/vm0-ai/vm0/issues/23734)) ([15f44cc](https://github.com/vm0-ai/vm0/commit/15f44cc68e1387d5b18f604fea9c964a1557561d))

## [0.58.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.7...guest-agent-v0.58.8) (2026-07-29)


### Documentation

* **guest-agent:** document claude result status ([#23687](https://github.com/vm0-ai/vm0/issues/23687)) ([915e342](https://github.com/vm0-ai/vm0/commit/915e3422dc04d9729e5691c76147fa0dbdecf2fc))

## [0.58.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.6...guest-agent-v0.58.7) (2026-07-29)

## [0.58.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.5...guest-agent-v0.58.6) (2026-07-29)


### Refactoring

* **guest-agent:** split checkpoint pipelines ([#23600](https://github.com/vm0-ai/vm0/issues/23600)) ([859fb3b](https://github.com/vm0-ai/vm0/commit/859fb3b537a842d78b7bebb7dc483b3c1eaea160))

## [0.58.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.4...guest-agent-v0.58.5) (2026-07-28)

## [0.58.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.3...guest-agent-v0.58.4) (2026-07-28)

## [0.58.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.2...guest-agent-v0.58.3) (2026-07-28)


### Bug Fixes

* **runner:** classify codex safety policy refusals ([#23391](https://github.com/vm0-ai/vm0/issues/23391)) ([a1d9986](https://github.com/vm0-ai/vm0/commit/a1d9986f1183067249dc168ba3643acdf05f79ca))

## [0.58.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.1...guest-agent-v0.58.2) (2026-07-27)


### Refactoring

* **guest-agent:** retire checkpoint gzip downgrade ([#23314](https://github.com/vm0-ai/vm0/issues/23314)) ([7fe12c2](https://github.com/vm0-ai/vm0/commit/7fe12c206e8e0504da52a646527221359e7b94b7))

## [0.58.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.0...guest-agent-v0.58.1) (2026-07-27)


### Bug Fixes

* **guest-agent:** preserve codex fast mode in app server ([#23240](https://github.com/vm0-ai/vm0/issues/23240)) ([f108f48](https://github.com/vm0-ai/vm0/commit/f108f48e832d3d4d61de338bb698b6d782f1121e))


### Documentation

* **guest-agent:** document reuse preparation safety contract ([#23243](https://github.com/vm0-ai/vm0/issues/23243)) ([9437606](https://github.com/vm0-ai/vm0/commit/9437606dabaa1ae4f51bd4be04f388b66d9c0ab4))


### Refactoring

* **guest-agent:** narrow session metadata visibility ([#23244](https://github.com/vm0-ai/vm0/issues/23244)) ([fba8fff](https://github.com/vm0-ai/vm0/commit/fba8fff884be8030a1af16f5c1c108a3b28d5d22))


### Performance Improvements

* **guest-agent:** offload checkpoint history work ([#23260](https://github.com/vm0-ai/vm0/issues/23260)) ([41379e3](https://github.com/vm0-ai/vm0/commit/41379e381da2c29323f5e1e3f6a11031b81cea5e))

## [0.58.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.57.1...guest-agent-v0.58.0) (2026-07-26)


### Features

* prune oversized codex session history ([#23136](https://github.com/vm0-ai/vm0/issues/23136)) ([010d286](https://github.com/vm0-ai/vm0/commit/010d286e46b4b7035ef41e6417bdfca707688aa0))


### Refactoring

* **storage:** detach runtime from legacy storage type ([#23143](https://github.com/vm0-ai/vm0/issues/23143)) ([cc415c5](https://github.com/vm0-ai/vm0/commit/cc415c5c844343ab573c0d9de5a31d1fd378ad69))

## [0.57.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.57.0...guest-agent-v0.57.1) (2026-07-26)


### Performance Improvements

* disable unused codex plugin and apps startup work ([#23132](https://github.com/vm0-ai/vm0/issues/23132)) ([038cabe](https://github.com/vm0-ai/vm0/commit/038cabedd7e5b8adbe4926f94102affe8455ad14))

## [0.57.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.56.6...guest-agent-v0.57.0) (2026-07-26)


### Features

* prune compacted claude session history ([#23081](https://github.com/vm0-ai/vm0/issues/23081)) ([671dc1c](https://github.com/vm0-ai/vm0/commit/671dc1c3a1ffe14b3be6d7079afd6f2cc24f14b0))

## [0.56.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.56.5...guest-agent-v0.56.6) (2026-07-26)


### Refactoring

* **storage:** authorize writeback by storage id ([#23112](https://github.com/vm0-ai/vm0/issues/23112)) ([321117e](https://github.com/vm0-ai/vm0/commit/321117edaf5f2304b87a435748557ad47cf73ea3))

## [0.56.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.56.4...guest-agent-v0.56.5) (2026-07-26)


### Performance Improvements

* **guest-agent:** disable upstream codex analytics ([#23099](https://github.com/vm0-ai/vm0/issues/23099)) ([88ecf52](https://github.com/vm0-ai/vm0/commit/88ecf529e28c1a18f2ecd421d51f5d8023b25d8b))

## [0.56.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.56.3...guest-agent-v0.56.4) (2026-07-25)


### Bug Fixes

* **guest-agent:** classify no-chunks stream timeouts ([#23041](https://github.com/vm0-ai/vm0/issues/23041)) ([f3a9714](https://github.com/vm0-ai/vm0/commit/f3a97146f04c2b883c00f174f05a2ead14ec5342))

## [0.56.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.56.2...guest-agent-v0.56.3) (2026-07-25)


### Bug Fixes

* **guest-agent:** classify oversized session history failures ([#23020](https://github.com/vm0-ai/vm0/issues/23020)) ([13b74f3](https://github.com/vm0-ai/vm0/commit/13b74f3d501b1e2f3be539969d3a9eb3479c7d3e))

## [0.56.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.56.1...guest-agent-v0.56.2) (2026-07-25)


### Performance Improvements

* **guest-agent:** reuse verified mock builds across tests ([#22984](https://github.com/vm0-ai/vm0/issues/22984)) ([cfe1d4b](https://github.com/vm0-ai/vm0/commit/cfe1d4bd614b83a1191b635f1cd80ef23d6b97c2))

## [0.56.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.56.0...guest-agent-v0.56.1) (2026-07-25)


### Performance Improvements

* add first-output coverage and codex lifecycle timings ([#22946](https://github.com/vm0-ai/vm0/issues/22946)) ([12e1316](https://github.com/vm0-ai/vm0/commit/12e13160392117b0fbe950b51fb0edc986059b90))
* **guest-agent:** reuse serialized event bodies ([#22944](https://github.com/vm0-ai/vm0/issues/22944)) ([aade076](https://github.com/vm0-ai/vm0/commit/aade076d5570c98e5a575d6cb61734df4510c4cf))

## [0.56.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.55.0...guest-agent-v0.56.0) (2026-07-23)


### Features

* **zero:** enable managed web search for all users ([#22761](https://github.com/vm0-ai/vm0/issues/22761)) ([68f7cd0](https://github.com/vm0-ai/vm0/commit/68f7cd02c24a65ca7226541f83b21ca09c0923c6))

## [0.55.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.54.3...guest-agent-v0.55.0) (2026-07-23)


### Features

* make managed zero web search authoritative ([#22544](https://github.com/vm0-ai/vm0/issues/22544)) ([e8e66ce](https://github.com/vm0-ai/vm0/commit/e8e66ce625f8bde4673ed4846eecd8cda15c7fa9))


### Bug Fixes

* disable vm0 model reasoning summaries ([#22337](https://github.com/vm0-ai/vm0/issues/22337)) ([9d04a70](https://github.com/vm0-ai/vm0/commit/9d04a70c81bfb3e30ed8214b767a2eb9bbb64587))
* **guest-agent:** batch queued event delivery ([#22320](https://github.com/vm0-ai/vm0/issues/22320)) ([39dd251](https://github.com/vm0-ai/vm0/commit/39dd251f3b4c688a4550cc3ec15373672d3120d5))
* **guest-agent:** bound ordinary cli stdout ingestion ([#22095](https://github.com/vm0-ai/vm0/issues/22095)) ([4641dd5](https://github.com/vm0-ai/vm0/commit/4641dd5e1340bb204866e0433eb4adbe5eb955f2))
* **guest-agent:** bound stalled codex resume startup ([#22557](https://github.com/vm0-ai/vm0/issues/22557)) ([1bf198e](https://github.com/vm0-ai/vm0/commit/1bf198e0791884e807f70a2d08fff0b93b050698))
* **guest-agent:** raise cli event delivery queue to 512 ([#22265](https://github.com/vm0-ai/vm0/issues/22265)) ([30b0657](https://github.com/vm0-ai/vm0/commit/30b06579b766b6f1966c94688c9b84cc3e7066a5))
* **guest-agent:** set Luna reasoning effort to max ([#22394](https://github.com/vm0-ai/vm0/issues/22394)) ([badea1e](https://github.com/vm0-ai/vm0/commit/badea1ee91f45ddcf83c1d51e18a0df3e1f20b33))
* **guest-agent:** set sol reasoning effort to max ([#22506](https://github.com/vm0-ai/vm0/issues/22506)) ([94040e6](https://github.com/vm0-ai/vm0/commit/94040e656e85766c5357432ab60d540679cd11a5))
* log codex quota exhaustion at info ([#22490](https://github.com/vm0-ai/vm0/issues/22490)) ([c858cd8](https://github.com/vm0-ai/vm0/commit/c858cd818f548d7423a2ba9513cef8fbe3329f9a))
* log fable usage limits at info ([#22494](https://github.com/vm0-ai/vm0/issues/22494)) ([057d0d0](https://github.com/vm0-ai/vm0/commit/057d0d00fa0fda104fecff47ef2142691b844a13))
* **vsock:** replace descendant process-group cleanup with exec cgroups ([#22013](https://github.com/vm0-ai/vm0/issues/22013)) ([302bf21](https://github.com/vm0-ai/vm0/commit/302bf216fac511a8fd6bf9c0c778cf8643f2374b))


### Documentation

* **guest-agent:** make mock scenario docs authoritative ([#22210](https://github.com/vm0-ai/vm0/issues/22210)) ([a584642](https://github.com/vm0-ai/vm0/commit/a58464252a205b643ae48a9a32eb7d3985e0877a))
* **rust:** expose private path guarantees in guest-agent ([#22710](https://github.com/vm0-ai/vm0/issues/22710)) ([ef12e55](https://github.com/vm0-ai/vm0/commit/ef12e55e627b4e627c8efbcf30867bc493222785))


### Refactoring

* **api-contracts:** type guest checkpoint requests ([#22219](https://github.com/vm0-ai/vm0/issues/22219)) ([23ebfc5](https://github.com/vm0-ai/vm0/commit/23ebfc5c758d6b986cb3bb824fb748c6a8b6ec07))
* **guest-agent:** drop masker build patterns ([#21936](https://github.com/vm0-ai/vm0/issues/21936)) ([97501a7](https://github.com/vm0-ai/vm0/commit/97501a75824a060fd3bc20b20b5f068746899b6f))
* **rust:** extract guest-agent failure diagnostics from main ([#22203](https://github.com/vm0-ai/vm0/issues/22203)) ([88fd828](https://github.com/vm0-ai/vm0/commit/88fd828d9480fc7564b7d40d1901f0a47bae7bea))


### Performance Improvements

* align session-history sidecar capacity with resume limit ([#22392](https://github.com/vm0-ai/vm0/issues/22392)) ([6eee854](https://github.com/vm0-ai/vm0/commit/6eee8548718c69c4d46afe9b1ddcd8c7babcca59))
* **guest-agent:** bound cli event delivery buffering ([#22015](https://github.com/vm0-ai/vm0/issues/22015)) ([0bde876](https://github.com/vm0-ai/vm0/commit/0bde876b83ef7781a24deb495f68ebec5e78e1cf))
* **guest-agent:** overlap artifact checkpoint pipelines ([#22709](https://github.com/vm0-ai/vm0/issues/22709)) ([ed29a8a](https://github.com/vm0-ai/vm0/commit/ed29a8aafe5c809154aa78e366e427e106522cad))

## [0.54.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.54.2...guest-agent-v0.54.3) (2026-07-23)


### Performance Improvements

* **guest-agent:** overlap artifact checkpoint pipelines ([#22709](https://github.com/vm0-ai/vm0/issues/22709)) ([ed29a8a](https://github.com/vm0-ai/vm0/commit/ed29a8aafe5c809154aa78e366e427e106522cad))

## [0.54.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.54.1...guest-agent-v0.54.2) (2026-07-23)


### Documentation

* **rust:** expose private path guarantees in guest-agent ([#22710](https://github.com/vm0-ai/vm0/issues/22710)) ([ef12e55](https://github.com/vm0-ai/vm0/commit/ef12e55e627b4e627c8efbcf30867bc493222785))

## [0.54.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.54.0...guest-agent-v0.54.1) (2026-07-23)

## [0.54.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.23...guest-agent-v0.54.0) (2026-07-22)


### Features

* make managed zero web search authoritative ([#22544](https://github.com/vm0-ai/vm0/issues/22544)) ([e8e66ce](https://github.com/vm0-ai/vm0/commit/e8e66ce625f8bde4673ed4846eecd8cda15c7fa9))

## [0.53.23](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.22...guest-agent-v0.53.23) (2026-07-22)


### Bug Fixes

* **guest-agent:** bound stalled codex resume startup ([#22557](https://github.com/vm0-ai/vm0/issues/22557)) ([1bf198e](https://github.com/vm0-ai/vm0/commit/1bf198e0791884e807f70a2d08fff0b93b050698))
* **guest-agent:** set sol reasoning effort to max ([#22506](https://github.com/vm0-ai/vm0/issues/22506)) ([94040e6](https://github.com/vm0-ai/vm0/commit/94040e656e85766c5357432ab60d540679cd11a5))

## [0.53.22](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.21...guest-agent-v0.53.22) (2026-07-22)


### Bug Fixes

* log codex quota exhaustion at info ([#22490](https://github.com/vm0-ai/vm0/issues/22490)) ([c858cd8](https://github.com/vm0-ai/vm0/commit/c858cd818f548d7423a2ba9513cef8fbe3329f9a))

## [0.53.21](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.20...guest-agent-v0.53.21) (2026-07-21)


### Bug Fixes

* **guest-agent:** set Luna reasoning effort to max ([#22394](https://github.com/vm0-ai/vm0/issues/22394)) ([badea1e](https://github.com/vm0-ai/vm0/commit/badea1ee91f45ddcf83c1d51e18a0df3e1f20b33))


### Performance Improvements

* align session-history sidecar capacity with resume limit ([#22392](https://github.com/vm0-ai/vm0/issues/22392)) ([6eee854](https://github.com/vm0-ai/vm0/commit/6eee8548718c69c4d46afe9b1ddcd8c7babcca59))

## [0.53.20](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.19...guest-agent-v0.53.20) (2026-07-21)


### Bug Fixes

* disable vm0 model reasoning summaries ([#22337](https://github.com/vm0-ai/vm0/issues/22337)) ([9d04a70](https://github.com/vm0-ai/vm0/commit/9d04a70c81bfb3e30ed8214b767a2eb9bbb64587))

## [0.53.19](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.18...guest-agent-v0.53.19) (2026-07-21)


### Bug Fixes

* **guest-agent:** batch queued event delivery ([#22320](https://github.com/vm0-ai/vm0/issues/22320)) ([39dd251](https://github.com/vm0-ai/vm0/commit/39dd251f3b4c688a4550cc3ec15373672d3120d5))

## [0.53.18](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.17...guest-agent-v0.53.18) (2026-07-21)


### Bug Fixes

* **guest-agent:** raise cli event delivery queue to 512 ([#22265](https://github.com/vm0-ai/vm0/issues/22265)) ([30b0657](https://github.com/vm0-ai/vm0/commit/30b06579b766b6f1966c94688c9b84cc3e7066a5))

## [0.53.17](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.16...guest-agent-v0.53.17) (2026-07-21)

## [0.53.16](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.15...guest-agent-v0.53.16) (2026-07-20)

## [0.53.15](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.14...guest-agent-v0.53.15) (2026-07-20)


### Refactoring

* **api-contracts:** type guest checkpoint requests ([#22219](https://github.com/vm0-ai/vm0/issues/22219)) ([23ebfc5](https://github.com/vm0-ai/vm0/commit/23ebfc5c758d6b986cb3bb824fb748c6a8b6ec07))

## [0.53.14](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.13...guest-agent-v0.53.14) (2026-07-20)


### Documentation

* **guest-agent:** make mock scenario docs authoritative ([#22210](https://github.com/vm0-ai/vm0/issues/22210)) ([a584642](https://github.com/vm0-ai/vm0/commit/a58464252a205b643ae48a9a32eb7d3985e0877a))


### Refactoring

* **rust:** extract guest-agent failure diagnostics from main ([#22203](https://github.com/vm0-ai/vm0/issues/22203)) ([88fd828](https://github.com/vm0-ai/vm0/commit/88fd828d9480fc7564b7d40d1901f0a47bae7bea))

## [0.53.13](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.12...guest-agent-v0.53.13) (2026-07-19)

## [0.53.12](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.11...guest-agent-v0.53.12) (2026-07-19)

## [0.53.11](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.10...guest-agent-v0.53.11) (2026-07-19)


### Bug Fixes

* **guest-agent:** bound ordinary cli stdout ingestion ([#22095](https://github.com/vm0-ai/vm0/issues/22095)) ([4641dd5](https://github.com/vm0-ai/vm0/commit/4641dd5e1340bb204866e0433eb4adbe5eb955f2))

## [0.53.10](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.9...guest-agent-v0.53.10) (2026-07-18)

## [0.53.9](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.8...guest-agent-v0.53.9) (2026-07-17)


### Bug Fixes

* **vsock:** replace descendant process-group cleanup with exec cgroups ([#22013](https://github.com/vm0-ai/vm0/issues/22013)) ([302bf21](https://github.com/vm0-ai/vm0/commit/302bf216fac511a8fd6bf9c0c778cf8643f2374b))


### Performance Improvements

* **guest-agent:** bound cli event delivery buffering ([#22015](https://github.com/vm0-ai/vm0/issues/22015)) ([0bde876](https://github.com/vm0-ai/vm0/commit/0bde876b83ef7781a24deb495f68ebec5e78e1cf))

## [0.53.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.7...guest-agent-v0.53.8) (2026-07-17)

## [0.53.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.6...guest-agent-v0.53.7) (2026-07-17)

## [0.53.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.5...guest-agent-v0.53.6) (2026-07-17)

## [0.53.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.4...guest-agent-v0.53.5) (2026-07-17)


### Refactoring

* **guest-agent:** drop masker build patterns ([#21936](https://github.com/vm0-ai/vm0/issues/21936)) ([97501a7](https://github.com/vm0-ai/vm0/commit/97501a75824a060fd3bc20b20b5f068746899b6f))

## [0.53.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.3...guest-agent-v0.53.4) (2026-07-16)


### Bug Fixes

* **runner:** classify oversized sidecars as unavailable ([#21877](https://github.com/vm0-ai/vm0/issues/21877)) ([d9fde61](https://github.com/vm0-ai/vm0/commit/d9fde61a0cce1579c4cf841e3e721aaf016eb537))

## [0.53.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.2...guest-agent-v0.53.3) (2026-07-16)


### Bug Fixes

* **runner:** contain supervised run descendants ([#21780](https://github.com/vm0-ai/vm0/issues/21780)) ([23e961c](https://github.com/vm0-ai/vm0/commit/23e961ce1b30f45ec9786e30289d870f5f436762))

## [0.53.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.1...guest-agent-v0.53.2) (2026-07-16)


### Documentation

* **guest-agent:** clarify backend exit code semantics ([#21799](https://github.com/vm0-ai/vm0/issues/21799)) ([2592598](https://github.com/vm0-ai/vm0/commit/25925984aa59135335a3e187c19e560fe8821ce7))

## [0.53.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.0...guest-agent-v0.53.1) (2026-07-16)


### Documentation

* **guest-agent:** correct heartbeat failure threshold wording ([#21718](https://github.com/vm0-ai/vm0/issues/21718)) ([e940472](https://github.com/vm0-ai/vm0/commit/e940472337856cd0b24f0e406750e466afa0acee))

## [0.53.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.52.0...guest-agent-v0.53.0) (2026-07-16)


### Features

* route vm0-auto through signed usage proxy ([#21437](https://github.com/vm0-ai/vm0/issues/21437)) ([cdb5bee](https://github.com/vm0-ai/vm0/commit/cdb5beeb3617f207570635e1497d57a4f796e329))


### Bug Fixes

* describe zero scrape capabilities in agent context ([#21574](https://github.com/vm0-ai/vm0/issues/21574)) ([5d5b298](https://github.com/vm0-ai/vm0/commit/5d5b298b1396f2e4c1ee6873d429987fcb9df4cc))

## [0.52.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.51.7...guest-agent-v0.52.0) (2026-07-15)


### Features

* default new organizations to luna with ultra reasoning ([#21323](https://github.com/vm0-ai/vm0/issues/21323)) ([d42f4c3](https://github.com/vm0-ai/vm0/commit/d42f4c30743bcb6aa087fd2c077b348b519175ca))
* run gpt-5.6 sol with ultra reasoning by default ([#20869](https://github.com/vm0-ai/vm0/issues/20869)) ([6f0a851](https://github.com/vm0-ai/vm0/commit/6f0a85112091fe2dc6c6ff24b252396f59b0af24))


### Bug Fixes

* **guest-agent:** pass codex prompts through stdin ([#21548](https://github.com/vm0-ai/vm0/issues/21548)) ([3c5e277](https://github.com/vm0-ai/vm0/commit/3c5e2779872cf7e93de88f6b10be646e2ad06ba6))
* **guest-agent:** prevent stale app-server group signaling ([#21233](https://github.com/vm0-ai/vm0/issues/21233)) ([b0f59a4](https://github.com/vm0-ai/vm0/commit/b0f59a4a2fd97493117f66f1c40e8fd29ab9ed16))
* **guest-agent:** redact secrets from event object keys ([#21626](https://github.com/vm0-ai/vm0/issues/21626)) ([e42aa15](https://github.com/vm0-ai/vm0/commit/e42aa15170c108c2abba983420326ec942dd9d19))
* **guest-agent:** reduce gpt-5.6 sol reasoning effort to xhigh ([#20887](https://github.com/vm0-ai/vm0/issues/20887)) ([005812d](https://github.com/vm0-ai/vm0/commit/005812dff55e96145cf46d43e46a2af572d832bd))
* **guest-agent:** set terra reasoning effort to low ([#21020](https://github.com/vm0-ai/vm0/issues/21020)) ([79283c9](https://github.com/vm0-ai/vm0/commit/79283c9c40735662efcd330c52d70dd16a5daa52))
* **runner:** qualify guest rootfs before idle reuse ([#21563](https://github.com/vm0-ai/vm0/issues/21563)) ([b9230c3](https://github.com/vm0-ai/vm0/commit/b9230c3bd213fb95777e0b5f84b17bbbbc3dd2e8))


### Documentation

* **guest-agent:** document active-input payload schema ([#21661](https://github.com/vm0-ai/vm0/issues/21661)) ([9154d84](https://github.com/vm0-ai/vm0/commit/9154d8490fd09856152df1ec0313d7b02885e145))
* **rust:** fix stale session metadata integration-test path ([#21118](https://github.com/vm0-ai/vm0/issues/21118)) ([02786e0](https://github.com/vm0-ai/vm0/commit/02786e039826beee978efe8ca3a7c4f885057568))


### Refactoring

* **guest-agent:** clarify runtime bootstrap contract ([#20927](https://github.com/vm0-ai/vm0/issues/20927)) ([e4121b6](https://github.com/vm0-ai/vm0/commit/e4121b6a5ea0b4002abb0f5fad0a48add7d646d9))
* **guest-agent:** name http retry budget as attempts ([#21543](https://github.com/vm0-ai/vm0/issues/21543)) ([3e114ba](https://github.com/vm0-ai/vm0/commit/3e114baaad5ed42cce2c4bfd91c4031763e4dd99))
* **guest-agent:** share event sender worker ([#21430](https://github.com/vm0-ai/vm0/issues/21430)) ([ba504b6](https://github.com/vm0-ai/vm0/commit/ba504b63ffcedefc3c89c8ab119c0e60b8b7f7d6))
* remove vm0 api url env ([#21215](https://github.com/vm0-ai/vm0/issues/21215)) ([6f0d6a9](https://github.com/vm0-ai/vm0/commit/6f0d6a9bdf80c0437d3ef529fd06eacd62a0c412))


### Performance Improvements

* **guest-agent:** avoid directory probes for artifact files ([#21275](https://github.com/vm0-ai/vm0/issues/21275)) ([85db30c](https://github.com/vm0-ai/vm0/commit/85db30ce599dd9f0e4ac391649e43db1b23c08ce))
* **guest-agent:** export sidecars from one history snapshot ([#21236](https://github.com/vm0-ai/vm0/issues/21236)) ([497d8c1](https://github.com/vm0-ai/vm0/commit/497d8c1c4363909f1982b3e98dd7172eb24a7b07))
* **guest-agent:** move parsed app-server payloads ([#21198](https://github.com/vm0-ai/vm0/issues/21198)) ([d89b5ec](https://github.com/vm0-ai/vm0/commit/d89b5ec872f58efd31c99ae6c9986b3b1662ee21))

## [0.51.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.51.6...guest-agent-v0.51.7) (2026-07-15)


### Bug Fixes

* **guest-agent:** redact secrets from event object keys ([#21626](https://github.com/vm0-ai/vm0/issues/21626)) ([e42aa15](https://github.com/vm0-ai/vm0/commit/e42aa15170c108c2abba983420326ec942dd9d19))

## [0.51.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.51.5...guest-agent-v0.51.6) (2026-07-15)


### Bug Fixes

* **runner:** qualify guest rootfs before idle reuse ([#21563](https://github.com/vm0-ai/vm0/issues/21563)) ([b9230c3](https://github.com/vm0-ai/vm0/commit/b9230c3bd213fb95777e0b5f84b17bbbbc3dd2e8))

## [0.51.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.51.4...guest-agent-v0.51.5) (2026-07-15)

## [0.51.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.51.3...guest-agent-v0.51.4) (2026-07-15)


### Refactoring

* **guest-agent:** name http retry budget as attempts ([#21543](https://github.com/vm0-ai/vm0/issues/21543)) ([3e114ba](https://github.com/vm0-ai/vm0/commit/3e114baaad5ed42cce2c4bfd91c4031763e4dd99))

## [0.51.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.51.2...guest-agent-v0.51.3) (2026-07-14)

## [0.51.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.51.1...guest-agent-v0.51.2) (2026-07-14)


### Refactoring

* **guest-agent:** share event sender worker ([#21430](https://github.com/vm0-ai/vm0/issues/21430)) ([ba504b6](https://github.com/vm0-ai/vm0/commit/ba504b63ffcedefc3c89c8ab119c0e60b8b7f7d6))

## [0.51.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.51.0...guest-agent-v0.51.1) (2026-07-14)

## [0.51.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.50.7...guest-agent-v0.51.0) (2026-07-14)


### Features

* default new organizations to luna with ultra reasoning ([#21323](https://github.com/vm0-ai/vm0/issues/21323)) ([d42f4c3](https://github.com/vm0-ai/vm0/commit/d42f4c30743bcb6aa087fd2c077b348b519175ca))

## [0.50.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.50.6...guest-agent-v0.50.7) (2026-07-13)


### Performance Improvements

* **guest-agent:** avoid directory probes for artifact files ([#21275](https://github.com/vm0-ai/vm0/issues/21275)) ([85db30c](https://github.com/vm0-ai/vm0/commit/85db30ce599dd9f0e4ac391649e43db1b23c08ce))

## [0.50.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.50.5...guest-agent-v0.50.6) (2026-07-13)


### Refactoring

* remove vm0 api url env ([#21215](https://github.com/vm0-ai/vm0/issues/21215)) ([6f0d6a9](https://github.com/vm0-ai/vm0/commit/6f0d6a9bdf80c0437d3ef529fd06eacd62a0c412))

## [0.50.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.50.4...guest-agent-v0.50.5) (2026-07-13)

## [0.50.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.50.3...guest-agent-v0.50.4) (2026-07-12)


### Documentation

* **rust:** fix stale session metadata integration-test path ([#21118](https://github.com/vm0-ai/vm0/issues/21118)) ([02786e0](https://github.com/vm0-ai/vm0/commit/02786e039826beee978efe8ca3a7c4f885057568))

## [0.50.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.50.2...guest-agent-v0.50.3) (2026-07-11)


### Bug Fixes

* **guest-agent:** set terra reasoning effort to low ([#21020](https://github.com/vm0-ai/vm0/issues/21020)) ([79283c9](https://github.com/vm0-ai/vm0/commit/79283c9c40735662efcd330c52d70dd16a5daa52))

## [0.50.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.50.1...guest-agent-v0.50.2) (2026-07-10)


### Refactoring

* **guest-agent:** clarify runtime bootstrap contract ([#20927](https://github.com/vm0-ai/vm0/issues/20927)) ([e4121b6](https://github.com/vm0-ai/vm0/commit/e4121b6a5ea0b4002abb0f5fad0a48add7d646d9))

## [0.50.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.50.0...guest-agent-v0.50.1) (2026-07-10)


### Bug Fixes

* **guest-agent:** reduce gpt-5.6 sol reasoning effort to xhigh ([#20887](https://github.com/vm0-ai/vm0/issues/20887)) ([005812d](https://github.com/vm0-ai/vm0/commit/005812dff55e96145cf46d43e46a2af572d832bd))

## [0.50.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.49.6...guest-agent-v0.50.0) (2026-07-10)


### Features

* run gpt-5.6 sol with ultra reasoning by default ([#20869](https://github.com/vm0-ai/vm0/issues/20869)) ([6f0a851](https://github.com/vm0-ai/vm0/commit/6f0a85112091fe2dc6c6ff24b252396f59b0af24))

## [0.49.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.49.5...guest-agent-v0.49.6) (2026-07-09)

## [0.49.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.49.4...guest-agent-v0.49.5) (2026-07-09)


### Documentation

* document guest-agent active input api ([#20779](https://github.com/vm0-ai/vm0/issues/20779)) ([f350e32](https://github.com/vm0-ai/vm0/commit/f350e321ef38cfc23359af477cbd2b133b4ea579))

## [0.49.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.49.3...guest-agent-v0.49.4) (2026-07-09)


### Performance Improvements

* cache session history with workspace images ([#20733](https://github.com/vm0-ai/vm0/issues/20733)) ([d588e5a](https://github.com/vm0-ai/vm0/commit/d588e5a9aa6e67ca18199cd74cadfa7dd4d66418))

## [0.49.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.49.2...guest-agent-v0.49.3) (2026-07-08)


### Bug Fixes

* add runner exit signal diagnostics ([#20674](https://github.com/vm0-ai/vm0/issues/20674)) ([bf46c07](https://github.com/vm0-ai/vm0/commit/bf46c07f8a9954576040760dfcfb3bb81ee2d1ea))


### Refactoring

* centralize guest private runtime file handling ([#20671](https://github.com/vm0-ai/vm0/issues/20671)) ([24ca30c](https://github.com/vm0-ai/vm0/commit/24ca30c56b4c9b657a3aad8da2affac5a49e5b4b))

## [0.49.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.49.1...guest-agent-v0.49.2) (2026-07-08)

## [0.49.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.49.0...guest-agent-v0.49.1) (2026-07-08)


### Bug Fixes


## [0.49.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.48.0...guest-agent-v0.49.0) (2026-07-08)


### Features

* add desktop client request headers ([#20622](https://github.com/vm0-ai/vm0/issues/20622)) ([00a66b8](https://github.com/vm0-ai/vm0/commit/00a66b894644a59f4646c31799a918e6ceafa19a))

## [0.48.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.47.5...guest-agent-v0.48.0) (2026-07-08)


### Features

* add platform client headers to runner requests ([#20577](https://github.com/vm0-ai/vm0/issues/20577)) ([dee5306](https://github.com/vm0-ai/vm0/commit/dee53066bbc014e302a85aa085136b408e2df833))

## [0.47.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.47.4...guest-agent-v0.47.5) (2026-07-07)


### Documentation

* clarify codex app-server client contract ([#20541](https://github.com/vm0-ai/vm0/issues/20541)) ([4f1ff80](https://github.com/vm0-ai/vm0/commit/4f1ff80721e9effd8d8571b7ece4cb77a681c6de))

## [0.47.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.47.3...guest-agent-v0.47.4) (2026-07-07)

## [0.47.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.47.2...guest-agent-v0.47.3) (2026-07-07)

## [0.47.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.47.1...guest-agent-v0.47.2) (2026-07-07)


### Performance Improvements

* reuse codex zstd session history ([#20450](https://github.com/vm0-ai/vm0/issues/20450)) ([e9b1a48](https://github.com/vm0-ai/vm0/commit/e9b1a48e0e36b8ae75bceab667fd8d6f70fd2ede))

## [0.47.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.47.0...guest-agent-v0.47.1) (2026-07-07)


### Bug Fixes

* prevent compressed session history identity fallback ([#20434](https://github.com/vm0-ai/vm0/issues/20434)) ([8eba6a0](https://github.com/vm0-ai/vm0/commit/8eba6a07a04b47653e89d6a12c307cd16521ca69))

## [0.47.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.8...guest-agent-v0.47.0) (2026-07-06)


### Features

* write zstd session history blobs ([#20392](https://github.com/vm0-ai/vm0/issues/20392)) ([3e5215d](https://github.com/vm0-ai/vm0/commit/3e5215d916ca250c866480be2cb5e60382867ac6))


### Performance Improvements

* **guest-agent:** avoid buffering reasoning text twice ([#20373](https://github.com/vm0-ai/vm0/issues/20373)) ([a234c82](https://github.com/vm0-ai/vm0/commit/a234c829366b4c5ba2eeb1229b5a98498bada848))

## [0.46.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.7...guest-agent-v0.46.8) (2026-07-06)

## [0.46.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.6...guest-agent-v0.46.7) (2026-07-06)

## [0.46.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.5...guest-agent-v0.46.6) (2026-07-06)


### Refactoring

* unify session history source resolution ([#20320](https://github.com/vm0-ai/vm0/issues/20320)) ([c680f9e](https://github.com/vm0-ai/vm0/commit/c680f9ef8ccad70de72869ee56b519ebd9af6688))

## [0.46.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.4...guest-agent-v0.46.5) (2026-07-05)


### Refactoring

* centralize run payload field validation ([#20225](https://github.com/vm0-ai/vm0/issues/20225)) ([8a293a7](https://github.com/vm0-ai/vm0/commit/8a293a762a48b4828780e8e99ca59e48ca915415))

## [0.46.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.3...guest-agent-v0.46.4) (2026-07-05)

## [0.46.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.2...guest-agent-v0.46.3) (2026-07-04)

## [0.46.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.1...guest-agent-v0.46.2) (2026-07-03)


### Bug Fixes

* move runner bootstrap payloads out of env ([#19989](https://github.com/vm0-ai/vm0/issues/19989)) ([847d8d2](https://github.com/vm0-ai/vm0/commit/847d8d24372d84568133007db87c44a0ebd72b95))

## [0.46.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.0...guest-agent-v0.46.1) (2026-07-03)

## [0.46.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.45.3...guest-agent-v0.46.0) (2026-07-02)


### Features

* add Codex fast mode for ChatGPT subscription runs ([#19811](https://github.com/vm0-ai/vm0/issues/19811)) ([42e8e48](https://github.com/vm0-ai/vm0/commit/42e8e4883e548d497eb0b86a936b6be308ad1bed))


### Bug Fixes

* enforce session history read size cap ([#19878](https://github.com/vm0-ai/vm0/issues/19878)) ([efa2680](https://github.com/vm0-ai/vm0/commit/efa26801d6bdd96aa6e8522b4bfdb6c5e9944990))

## [0.45.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.45.2...guest-agent-v0.45.3) (2026-07-02)


### Bug Fixes

* **guest-agent:** compress non-utf8 session history uploads ([#19826](https://github.com/vm0-ai/vm0/issues/19826)) ([7b0d449](https://github.com/vm0-ai/vm0/commit/7b0d44977de5ba2b435ebbd3c9b4b557f0ca9ae3))

## [0.45.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.45.1...guest-agent-v0.45.2) (2026-07-02)


### Bug Fixes

* **guest-agent:** classify claude stalled streams ([#19865](https://github.com/vm0-ai/vm0/issues/19865)) ([6799682](https://github.com/vm0-ai/vm0/commit/679968254cadde4774a1082b533ccec1ca26ac74))

## [0.45.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.45.0...guest-agent-v0.45.1) (2026-07-02)


### Bug Fixes

* expose runner session ids in diagnostics ([#19755](https://github.com/vm0-ai/vm0/issues/19755)) ([e4c62e1](https://github.com/vm0-ai/vm0/commit/e4c62e17ed7de8743f89dacf9edc62f7042307d6))


### Performance Improvements

* add compressed resume session history transport ([#19667](https://github.com/vm0-ai/vm0/issues/19667)) ([ee23c32](https://github.com/vm0-ai/vm0/commit/ee23c326ccf794228d2c4f9dd6d8844cd032fc49))

## [0.45.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.44.2...guest-agent-v0.45.0) (2026-07-02)


### Features

* restore Claude Fable 5 support ([#19721](https://github.com/vm0-ai/vm0/issues/19721)) ([97a7753](https://github.com/vm0-ai/vm0/commit/97a775354429e1f3de625627e3fbeeaf01c2552d))


### Refactoring

* remove guest-common runtime path fallbacks ([#19717](https://github.com/vm0-ai/vm0/issues/19717)) ([2ce4fd7](https://github.com/vm0-ai/vm0/commit/2ce4fd76711d400408d340d4126b5224c716616b))

## [0.44.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.44.1...guest-agent-v0.44.2) (2026-07-01)


### Refactoring

* retire guest-agent env facade readers ([#19712](https://github.com/vm0-ai/vm0/issues/19712)) ([13cf0a8](https://github.com/vm0-ai/vm0/commit/13cf0a857fc2738671a0ec629e97ddc53ccc21ec))

## [0.44.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.44.0...guest-agent-v0.44.1) (2026-07-01)


### Refactoring

* remove guest-agent path facades ([#19687](https://github.com/vm0-ai/vm0/issues/19687)) ([e054c10](https://github.com/vm0-ai/vm0/commit/e054c10f91e6b91838770c1de324782a75182d9d))

## [0.44.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.43.6...guest-agent-v0.44.0) (2026-07-01)


### Features


## [0.43.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.43.5...guest-agent-v0.43.6) (2026-07-01)


### Bug Fixes

* classify codex context window failures ([#19607](https://github.com/vm0-ai/vm0/issues/19607)) ([34ed0ac](https://github.com/vm0-ai/vm0/commit/34ed0ac9d29d81ffda52c5ccd6bf69915d5cc80c))


### Refactoring

* pass guest diagnostics paths explicitly ([#19574](https://github.com/vm0-ai/vm0/issues/19574)) ([5913576](https://github.com/vm0-ai/vm0/commit/5913576079f9acde38845e9b8174ad76f4b82f10))

## [0.43.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.43.4...guest-agent-v0.43.5) (2026-07-01)


### Bug Fixes

* align session history verification cap ([#19561](https://github.com/vm0-ai/vm0/issues/19561)) ([657cc42](https://github.com/vm0-ai/vm0/commit/657cc422cfe1e929e921a82e7bbd7ceec0d7861d))


### Refactoring

* reuse codex test setup helpers ([#19556](https://github.com/vm0-ai/vm0/issues/19556)) ([f7cd596](https://github.com/vm0-ai/vm0/commit/f7cd596258dadd281c035314fbddf4d3844ada93))
* use guest runtime for checkpoint metadata ([#19550](https://github.com/vm0-ai/vm0/issues/19550)) ([18128ab](https://github.com/vm0-ai/vm0/commit/18128ab52ff14fd9b5545304b4d142b2eb2206f8))

## [0.43.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.43.3...guest-agent-v0.43.4) (2026-07-01)


### Refactoring

* migrate guest-agent CLI runtime inputs ([#19514](https://github.com/vm0-ai/vm0/issues/19514)) ([bee67d0](https://github.com/vm0-ai/vm0/commit/bee67d0bc1b5d2d90b7fe0e664dc0a6579c7e16f))

## [0.43.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.43.2...guest-agent-v0.43.3) (2026-06-30)

## [0.43.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.43.1...guest-agent-v0.43.2) (2026-06-30)

## [0.43.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.43.0...guest-agent-v0.43.1) (2026-06-30)


### Bug Fixes

* **guest-agent:** reconcile codex auth state locally ([#19487](https://github.com/vm0-ai/vm0/issues/19487)) ([30d3b65](https://github.com/vm0-ai/vm0/commit/30d3b65e43d77b6cebf47181363480d2b9c0d6db))

## [0.43.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.42.2...guest-agent-v0.43.0) (2026-06-30)


### Features

* enable codex local active input ([#19463](https://github.com/vm0-ai/vm0/issues/19463)) ([5a34420](https://github.com/vm0-ai/vm0/commit/5a34420314311d9a290c195f33539d8359303660))

## [0.42.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.42.1...guest-agent-v0.42.2) (2026-06-30)


### Refactoring

* **guest-agent:** add explicit run config and paths ([#19437](https://github.com/vm0-ai/vm0/issues/19437)) ([685db73](https://github.com/vm0-ai/vm0/commit/685db7388d2c935a518b5ca25b1e37bece8834c8))

## [0.42.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.42.0...guest-agent-v0.42.1) (2026-06-30)


### Performance Improvements

* verify large session histories in guest ([#19386](https://github.com/vm0-ai/vm0/issues/19386)) ([a3f62a1](https://github.com/vm0-ai/vm0/commit/a3f62a1bd2b649e6d5dfe0a694894d020d196925))

## [0.42.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.18...guest-agent-v0.42.0) (2026-06-30)


### Features

* add Codex app-server active input steering ([#19361](https://github.com/vm0-ai/vm0/issues/19361)) ([7a231a7](https://github.com/vm0-ai/vm0/commit/7a231a7e9069c817b314aeea7408859b496c60d2))

## [0.41.18](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.17...guest-agent-v0.41.18) (2026-06-29)


### Refactoring

* centralize guest-agent cli termination runtime ([#19342](https://github.com/vm0-ai/vm0/issues/19342)) ([fe032a9](https://github.com/vm0-ai/vm0/commit/fe032a9714a6d577bdba1c31c0001f5cac128954))

## [0.41.17](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.16...guest-agent-v0.41.17) (2026-06-29)


### Refactoring

* merge agent diagnostics into guest contracts ([#19317](https://github.com/vm0-ai/vm0/issues/19317)) ([e36a711](https://github.com/vm0-ai/vm0/commit/e36a71168939a1b692a1ab80005d984697a77fe4))

## [0.41.16](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.15...guest-agent-v0.41.16) (2026-06-29)

## [0.41.15](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.14...guest-agent-v0.41.15) (2026-06-29)


### Performance Improvements

* park checkpointed session history identity ([#19270](https://github.com/vm0-ai/vm0/issues/19270)) ([e21745b](https://github.com/vm0-ai/vm0/commit/e21745be11c34b09052a27182971d4c48ab881c1))

## [0.41.14](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.13...guest-agent-v0.41.14) (2026-06-29)

## [0.41.13](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.12...guest-agent-v0.41.13) (2026-06-27)


### Bug Fixes

* guard post-result cleanup deadlines ([#19179](https://github.com/vm0-ai/vm0/issues/19179)) ([e1d2779](https://github.com/vm0-ai/vm0/commit/e1d2779ab9b32e0d195e1d5bf4d3ae7745022b5d))

## [0.41.12](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.11...guest-agent-v0.41.12) (2026-06-26)

## [0.41.11](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.10...guest-agent-v0.41.11) (2026-06-26)

## [0.41.10](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.9...guest-agent-v0.41.10) (2026-06-26)

## [0.41.9](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.8...guest-agent-v0.41.9) (2026-06-26)

## [0.41.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.7...guest-agent-v0.41.8) (2026-06-26)


### Bug Fixes

* **guest-agent:** preserve non-UTF-8 success checkpoints ([#19009](https://github.com/vm0-ai/vm0/issues/19009)) ([46271a7](https://github.com/vm0-ai/vm0/commit/46271a7264be80e4d277e0687063787951a5f518))


### Refactoring

* centralize codex session history traversal ([#19022](https://github.com/vm0-ai/vm0/issues/19022)) ([02c3a2b](https://github.com/vm0-ai/vm0/commit/02c3a2bb16a233a4f6b4af9804ba368bb46464f3))

## [0.41.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.6...guest-agent-v0.41.7) (2026-06-25)


### Bug Fixes

* classify claude stream idle timeout failures ([#18941](https://github.com/vm0-ai/vm0/issues/18941)) ([2f30e00](https://github.com/vm0-ai/vm0/commit/2f30e005ce1d4d85d55674c7f384d51c701fb0bf))

## [0.41.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.5...guest-agent-v0.41.6) (2026-06-25)


### Bug Fixes

* **runner:** downgrade claude overload result logs ([#18890](https://github.com/vm0-ai/vm0/issues/18890)) ([2751ac3](https://github.com/vm0-ai/vm0/commit/2751ac3631d328965a032a20e6b51dd0a8e358cb))

## [0.41.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.4...guest-agent-v0.41.5) (2026-06-25)


### Documentation

* document guest-agent process control handle ([#18853](https://github.com/vm0-ai/vm0/issues/18853)) ([548841b](https://github.com/vm0-ai/vm0/commit/548841be1c92ddba8dc6ad107e3e86b50f72338f))

## [0.41.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.3...guest-agent-v0.41.4) (2026-06-25)


### Refactoring

* centralize rust shell quoting ([#18833](https://github.com/vm0-ai/vm0/issues/18833)) ([d4f8878](https://github.com/vm0-ai/vm0/commit/d4f88785000474267e3462a44afea99759768e77))

## [0.41.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.2...guest-agent-v0.41.3) (2026-06-25)


### Performance Improvements

* cache guest artifact content hash sort keys ([#18834](https://github.com/vm0-ai/vm0/issues/18834)) ([cef34c2](https://github.com/vm0-ai/vm0/commit/cef34c287824c193afcdf1457ecf05e7c68de5ed))

## [0.41.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.1...guest-agent-v0.41.2) (2026-06-24)

## [0.41.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.0...guest-agent-v0.41.1) (2026-06-24)


### Bug Fixes

* align storage hash sort with javascript ([#18783](https://github.com/vm0-ai/vm0/issues/18783)) ([1864d86](https://github.com/vm0-ai/vm0/commit/1864d86dd39340fab24b85855ea659fe61597b59))
* **guest-agent:** bound codex session lookup ([#18780](https://github.com/vm0-ai/vm0/issues/18780)) ([96c2142](https://github.com/vm0-ai/vm0/commit/96c214200019bcc99ace849def5af2d3fea036b2))
* **runner:** classify Claude provider server errors ([#18781](https://github.com/vm0-ai/vm0/issues/18781)) ([c150950](https://github.com/vm0-ai/vm0/commit/c150950445346a61c63cb696adfa71b184c1e297))


### Documentation

* document guest-agent active input contract ([#18779](https://github.com/vm0-ai/vm0/issues/18779)) ([9c2d65b](https://github.com/vm0-ai/vm0/commit/9c2d65bce9df85faee0e2fe50c8f82df8c5f2b0d))


### Refactoring

* **guest-agent:** centralize forced cli termination ([#18782](https://github.com/vm0-ai/vm0/issues/18782)) ([93bdd96](https://github.com/vm0-ai/vm0/commit/93bdd9675b598e02ca043f780d2172ddc9b0398b))

## [0.41.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.40.6...guest-agent-v0.41.0) (2026-06-24)


### Features

* add codex app-server event adapter ([#18716](https://github.com/vm0-ai/vm0/issues/18716)) ([c419e1f](https://github.com/vm0-ai/vm0/commit/c419e1f84cee76d2a374a038b0efa6b29fb5e4bf))

## [0.40.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.40.5...guest-agent-v0.40.6) (2026-06-23)


### Bug Fixes

* preserve codex app-server failure diagnostics ([#18682](https://github.com/vm0-ai/vm0/issues/18682)) ([b84ddfa](https://github.com/vm0-ai/vm0/commit/b84ddfa3eccf095c11e0ebd75a8e55ee743ead11))

## [0.40.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.40.4...guest-agent-v0.40.5) (2026-06-23)

## [0.40.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.40.3...guest-agent-v0.40.4) (2026-06-23)


### Bug Fixes

* reject non-utf8 artifact paths ([#18625](https://github.com/vm0-ai/vm0/issues/18625)) ([27173de](https://github.com/vm0-ai/vm0/commit/27173dee401a35e30edc2c99092f1fd96b969c51))

## [0.40.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.40.2...guest-agent-v0.40.3) (2026-06-23)


### Refactoring

* extract active input replay test harness ([#18605](https://github.com/vm0-ai/vm0/issues/18605)) ([be58da1](https://github.com/vm0-ai/vm0/commit/be58da14b91e4498a24fb96ee0397050f1d71227))

## [0.40.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.40.1...guest-agent-v0.40.2) (2026-06-23)


### Bug Fixes

* classify claude output token limits ([#18579](https://github.com/vm0-ai/vm0/issues/18579)) ([2b43740](https://github.com/vm0-ai/vm0/commit/2b437408b03be9c6413705dd1b633cbc33a2a62a))


### Refactoring

* centralize guest-agent process group signaling ([#18567](https://github.com/vm0-ai/vm0/issues/18567)) ([ba20395](https://github.com/vm0-ai/vm0/commit/ba20395de33b867bdcd2799254a5d1b31ef58573))

## [0.40.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.40.0...guest-agent-v0.40.1) (2026-06-22)


### Bug Fixes

* separate Claude post-result cleanup lifecycle ([#18524](https://github.com/vm0-ai/vm0/issues/18524)) ([6dcad82](https://github.com/vm0-ai/vm0/commit/6dcad82ea6241cc2197e577867ba8bee00e13525))


### Refactoring

* centralize codex thread id contract ([#18499](https://github.com/vm0-ai/vm0/issues/18499)) ([9cecc84](https://github.com/vm0-ai/vm0/commit/9cecc8421f4073ce32b6529fff89049779a7c13e))

## [0.40.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.39.3...guest-agent-v0.40.0) (2026-06-22)


### Features

* add Codex app-server JSON-RPC client ([#18428](https://github.com/vm0-ai/vm0/issues/18428)) ([8c49a61](https://github.com/vm0-ai/vm0/commit/8c49a6119ad8a6fe483d518ea7f4436114b18082))

## [0.39.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.39.2...guest-agent-v0.39.3) (2026-06-22)


### Bug Fixes

* **guest-agent:** classify repeated claude 529 overloads ([#18465](https://github.com/vm0-ai/vm0/issues/18465)) ([c30ecd1](https://github.com/vm0-ai/vm0/commit/c30ecd12ce74aa9c817653cdbab86cf190cdaa3d))

## [0.39.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.39.1...guest-agent-v0.39.2) (2026-06-22)

## [0.39.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.39.0...guest-agent-v0.39.1) (2026-06-20)

## [0.39.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.38.3...guest-agent-v0.39.0) (2026-06-19)


### Features

* add runner local active input forwarding ([#18286](https://github.com/vm0-ai/vm0/issues/18286)) ([a798b1a](https://github.com/vm0-ai/vm0/commit/a798b1abc04cfaa960d63bee7ce8d52b8300737a))

## [0.38.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.38.2...guest-agent-v0.38.3) (2026-06-19)

## [0.38.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.38.1...guest-agent-v0.38.2) (2026-06-19)


### Performance Improvements

* **guest-agent:** resolve session markers at checkpoint time ([#18295](https://github.com/vm0-ai/vm0/issues/18295)) ([6ed71a3](https://github.com/vm0-ai/vm0/commit/6ed71a319d804f5fc58c90fc250dab81875dc5b6))

## [0.38.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.38.0...guest-agent-v0.38.1) (2026-06-18)

## [0.38.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.37.5...guest-agent-v0.38.0) (2026-06-18)


### Features

* **guest-agent:** add claude active input support ([#18124](https://github.com/vm0-ai/vm0/issues/18124)) ([a62e604](https://github.com/vm0-ai/vm0/commit/a62e60404961eea9a1034c0abf6f82b25364cea0))


### Refactoring

* clarify agent and cli session ids ([#18232](https://github.com/vm0-ai/vm0/issues/18232)) ([18fa8d6](https://github.com/vm0-ai/vm0/commit/18fa8d6e5740b7121b3985a19b5082a637f9d39b))

## [0.37.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.37.4...guest-agent-v0.37.5) (2026-06-18)

## [0.37.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.37.3...guest-agent-v0.37.4) (2026-06-18)

## [0.37.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.37.2...guest-agent-v0.37.3) (2026-06-18)

## [0.37.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.37.1...guest-agent-v0.37.2) (2026-06-17)


### Refactoring

* remove stale feature switches and dead code ([#18090](https://github.com/vm0-ai/vm0/issues/18090)) ([9406838](https://github.com/vm0-ai/vm0/commit/940683865a2256f83b2d92d36cf102e0fb06e131))

## [0.37.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.37.0...guest-agent-v0.37.1) (2026-06-17)


### Bug Fixes

* **guest-agent:** classify codex model capacity failures ([#18086](https://github.com/vm0-ai/vm0/issues/18086)) ([3a91436](https://github.com/vm0-ai/vm0/commit/3a91436b86726dffb016ef246d7e8e423be1afb1))

## [0.37.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.36.7...guest-agent-v0.37.0) (2026-06-17)


### Features

* **runner:** add local submit env overrides ([#17930](https://github.com/vm0-ai/vm0/issues/17930)) ([5c2c63c](https://github.com/vm0-ai/vm0/commit/5c2c63cdde42a7951e3af80dad7c892cdeca4de9))


### Refactoring

* **guest-agent:** split session history reader tests ([#18041](https://github.com/vm0-ai/vm0/issues/18041)) ([d698fed](https://github.com/vm0-ai/vm0/commit/d698fed994d96d838eb7aa501bfb067c57cc9732))

## [0.36.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.36.6...guest-agent-v0.36.7) (2026-06-17)

## [0.36.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.36.5...guest-agent-v0.36.6) (2026-06-16)


### Bug Fixes

* guard guest metrics arithmetic overflow ([#17889](https://github.com/vm0-ai/vm0/issues/17889)) ([04d9256](https://github.com/vm0-ai/vm0/commit/04d9256f38804eb71f8f6d09c0b54a686d98acc3))

## [0.36.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.36.4...guest-agent-v0.36.5) (2026-06-16)

## [0.36.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.36.3...guest-agent-v0.36.4) (2026-06-16)


### Bug Fixes

* log claude provider overloads as info ([#17813](https://github.com/vm0-ai/vm0/issues/17813)) ([b13b8a6](https://github.com/vm0-ai/vm0/commit/b13b8a69fea42d20ea45b1ab87e5048fda3661de))


### Refactoring

* simplify telemetry delta test fixtures ([#17847](https://github.com/vm0-ai/vm0/issues/17847)) ([c21d04b](https://github.com/vm0-ai/vm0/commit/c21d04b7673c9659af13aedae96681dfa2c275b5))

## [0.36.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.36.2...guest-agent-v0.36.3) (2026-06-16)

## [0.36.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.36.1...guest-agent-v0.36.2) (2026-06-15)

## [0.36.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.36.0...guest-agent-v0.36.1) (2026-06-15)


### Bug Fixes

* increase stuck tool watchdog timeout ([#17734](https://github.com/vm0-ai/vm0/issues/17734)) ([5b4a76e](https://github.com/vm0-ai/vm0/commit/5b4a76e0ec1b81fb9a9f4817092b058e5d01d4a6))

## [0.36.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.35.6...guest-agent-v0.36.0) (2026-06-15)


### Features

* send Claude prompt over stream-json stdin ([#17710](https://github.com/vm0-ai/vm0/issues/17710)) ([857762b](https://github.com/vm0-ai/vm0/commit/857762b76ed511314e37b145fa879309fe955fee))

## [0.35.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.35.5...guest-agent-v0.35.6) (2026-06-15)


### Bug Fixes

* classify provider credit limit failures ([#17688](https://github.com/vm0-ai/vm0/issues/17688)) ([b967f1b](https://github.com/vm0-ai/vm0/commit/b967f1b2d3cf17ba15501022f2249423feaeb9ed))


### Refactoring

* centralize guest env key names ([#17626](https://github.com/vm0-ai/vm0/issues/17626)) ([476546d](https://github.com/vm0-ai/vm0/commit/476546de9d385733c481558b422511b30b1cc45a))
* share archive manifest verification ([#17705](https://github.com/vm0-ai/vm0/issues/17705)) ([a4e5ea1](https://github.com/vm0-ai/vm0/commit/a4e5ea1c2cfbaef7ff48b8ef59278cb5150d1ab2))

## [0.35.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.35.4...guest-agent-v0.35.5) (2026-06-14)


### Bug Fixes

* classify claude monthly spend limits ([#17627](https://github.com/vm0-ai/vm0/issues/17627)) ([1d33872](https://github.com/vm0-ai/vm0/commit/1d338727d1886ff129603bc3c808e83ed97c1bc5))

## [0.35.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.35.3...guest-agent-v0.35.4) (2026-06-14)


### Refactoring

* **guest-agent:** share system log test guard ([#17582](https://github.com/vm0-ai/vm0/issues/17582)) ([edcd791](https://github.com/vm0-ai/vm0/commit/edcd79197e44c4f16a4f8ab06f01d3523b181f77))

## [0.35.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.35.2...guest-agent-v0.35.3) (2026-06-13)

## [0.35.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.35.1...guest-agent-v0.35.2) (2026-06-13)


### Bug Fixes

* remove claude fable 5 model support ([#17567](https://github.com/vm0-ai/vm0/issues/17567)) ([63733bf](https://github.com/vm0-ai/vm0/commit/63733bf637ce02afe00d0f97a2439f988c59078d))


### Documentation

* document cli failure diagnostic fields ([#17571](https://github.com/vm0-ai/vm0/issues/17571)) ([d5f6bd8](https://github.com/vm0-ai/vm0/commit/d5f6bd8fac011d570520b50dac839cf9f453a2af))

## [0.35.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.35.0...guest-agent-v0.35.1) (2026-06-12)


### Bug Fixes

* mask runtime guest-agent session ids ([#17491](https://github.com/vm0-ai/vm0/issues/17491)) ([4f6308d](https://github.com/vm0-ai/vm0/commit/4f6308dc3fb70f5115cdfb0dd1318447250dc121))

## [0.35.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.34...guest-agent-v0.35.0) (2026-06-12)


### Features

* stream assistant text deltas to web chat ([#17370](https://github.com/vm0-ai/vm0/issues/17370)) ([cbfdf74](https://github.com/vm0-ai/vm0/commit/cbfdf74761771d0142603030ca764d1f33d61479))

## [0.34.34](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.33...guest-agent-v0.34.34) (2026-06-12)


### Bug Fixes

* set fable effort to low ([#17486](https://github.com/vm0-ai/vm0/issues/17486)) ([5a190d6](https://github.com/vm0-ai/vm0/commit/5a190d6b1c9c06f11f00437ef5110f51741b0f9a))

## [0.34.33](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.32...guest-agent-v0.34.33) (2026-06-12)

## [0.34.32](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.31...guest-agent-v0.34.32) (2026-06-12)


### Bug Fixes

* mask codex setup login diagnostics ([#17458](https://github.com/vm0-ai/vm0/issues/17458)) ([ed43b5a](https://github.com/vm0-ai/vm0/commit/ed43b5ab028c02472083c544495d563918352ca1))

## [0.34.31](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.30...guest-agent-v0.34.31) (2026-06-12)


### Bug Fixes

* classify non-code runner job failures ([#17438](https://github.com/vm0-ai/vm0/issues/17438)) ([dcae0a6](https://github.com/vm0-ai/vm0/commit/dcae0a69924bbf34c4a31cea9fee74cbca9aa16d))

## [0.34.30](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.29...guest-agent-v0.34.30) (2026-06-11)

## [0.34.29](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.28...guest-agent-v0.34.29) (2026-06-11)

## [0.34.28](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.27...guest-agent-v0.34.28) (2026-06-11)

## [0.34.27](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.26...guest-agent-v0.34.27) (2026-06-11)

## [0.34.26](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.25...guest-agent-v0.34.26) (2026-06-10)

## [0.34.25](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.24...guest-agent-v0.34.25) (2026-06-10)


### Bug Fixes

* harden mock codex session persistence ([#16940](https://github.com/vm0-ai/vm0/issues/16940)) ([39374df](https://github.com/vm0-ai/vm0/commit/39374df46e1f7e42e51cc00cab388c10d39107c4))

## [0.34.24](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.23...guest-agent-v0.34.24) (2026-06-09)


### Bug Fixes

* expose api url to sandbox cli child ([#16846](https://github.com/vm0-ai/vm0/issues/16846)) ([5906d51](https://github.com/vm0-ai/vm0/commit/5906d5101232bbebf8e2ae486a28fa9bd43f06e2))

## [0.34.23](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.22...guest-agent-v0.34.23) (2026-06-09)


### Bug Fixes

* mask lowercase percent-encoded secrets ([#16769](https://github.com/vm0-ai/vm0/issues/16769)) ([6e3a625](https://github.com/vm0-ai/vm0/commit/6e3a6253fcd1556225dc4f2f8f3ba8caddf677e9))

## [0.34.22](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.21...guest-agent-v0.34.22) (2026-06-09)


### Refactoring

* split telemetry delta reader ([#16765](https://github.com/vm0-ai/vm0/issues/16765)) ([7951c52](https://github.com/vm0-ai/vm0/commit/7951c525d2b7c8dccb8647d194ad2a91aeb72d79))

## [0.34.21](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.20...guest-agent-v0.34.21) (2026-06-08)

## [0.34.20](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.19...guest-agent-v0.34.20) (2026-06-08)


### Bug Fixes

* mask multiline cli stderr secrets ([#16669](https://github.com/vm0-ai/vm0/issues/16669)) ([7712ba4](https://github.com/vm0-ai/vm0/commit/7712ba4ae44820960f55e12103791db677b353d0))

## [0.34.19](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.18...guest-agent-v0.34.19) (2026-06-07)


### Bug Fixes

* bound guest telemetry delta reads ([#16455](https://github.com/vm0-ai/vm0/issues/16455)) ([122b447](https://github.com/vm0-ai/vm0/commit/122b447bcfc0d0c907596da44631549cbb3eec0e))

## [0.34.18](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.17...guest-agent-v0.34.18) (2026-06-05)


### Bug Fixes

* **runner:** split guest-agent bootstrap env ([#16295](https://github.com/vm0-ai/vm0/issues/16295)) ([b77e7c7](https://github.com/vm0-ai/vm0/commit/b77e7c7c2dfd54e7c97596fee8ca371654e7c7b7))

## [0.34.17](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.16...guest-agent-v0.34.17) (2026-06-05)


### Bug Fixes

* strip guest-agent reqwest urls from logs ([#16314](https://github.com/vm0-ai/vm0/issues/16314)) ([9f063de](https://github.com/vm0-ai/vm0/commit/9f063dec7ab44c8fb9584b6122ee6797ece645bf))

## [0.34.16](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.15...guest-agent-v0.34.16) (2026-06-05)


### Bug Fixes

* move guest runtime files out of tmp ([#16263](https://github.com/vm0-ai/vm0/issues/16263)) ([dc87ac5](https://github.com/vm0-ai/vm0/commit/dc87ac5f4f11ada3306d4061a845de5f592d09b2))

## [0.34.15](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.14...guest-agent-v0.34.15) (2026-06-05)


### Bug Fixes

* preserve missing auto-memory artifact roots ([#16245](https://github.com/vm0-ai/vm0/issues/16245)) ([44cd72a](https://github.com/vm0-ai/vm0/commit/44cd72a947c260572181cf6735e2ecbfe85624d8))

## [0.34.14](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.13...guest-agent-v0.34.14) (2026-06-04)

## [0.34.13](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.12...guest-agent-v0.34.13) (2026-06-04)


### Performance Improvements

* stream artifact manifest uploads ([#16178](https://github.com/vm0-ai/vm0/issues/16178)) ([68ffd1f](https://github.com/vm0-ai/vm0/commit/68ffd1fd8f4ee6e22e22145328a1beca8bd545ad))

## [0.34.12](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.11...guest-agent-v0.34.12) (2026-06-04)


### Bug Fixes

* log session metadata write results ([#16118](https://github.com/vm0-ai/vm0/issues/16118)) ([30587a4](https://github.com/vm0-ai/vm0/commit/30587a4f0d248920f3e0a7db60c3460e9e1017e4))


### Documentation

* document artifact archive validation invariants ([#16132](https://github.com/vm0-ai/vm0/issues/16132)) ([6ad9dbe](https://github.com/vm0-ai/vm0/commit/6ad9dbe0b5f103c99eb00693928701a3ed0a0fcb))

## [0.34.11](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.10...guest-agent-v0.34.11) (2026-06-04)

## [0.34.10](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.9...guest-agent-v0.34.10) (2026-06-04)


### Bug Fixes

* materialize cached artifact mount roots ([#16083](https://github.com/vm0-ai/vm0/issues/16083)) ([d6a4ed3](https://github.com/vm0-ai/vm0/commit/d6a4ed307b5c4aeac8edb400aec1f65369d5f781))

## [0.34.9](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.8...guest-agent-v0.34.9) (2026-06-04)


### Bug Fixes

* preserve canonical auto memory missing roots ([#16053](https://github.com/vm0-ai/vm0/issues/16053)) ([a3ea955](https://github.com/vm0-ai/vm0/commit/a3ea955d7e4d968d155cd70beed1a95a1a7d1109))

## [0.34.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.7...guest-agent-v0.34.8) (2026-06-03)

## [0.34.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.6...guest-agent-v0.34.7) (2026-06-03)


### Bug Fixes

* preserve missing auto memory artifact checkpoints ([#15964](https://github.com/vm0-ai/vm0/issues/15964)) ([020dc4a](https://github.com/vm0-ai/vm0/commit/020dc4a62cd90237639396419ccee1ba85d7d4d0))

## [0.34.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.5...guest-agent-v0.34.6) (2026-06-03)

## [0.34.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.4...guest-agent-v0.34.5) (2026-06-03)

## [0.34.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.3...guest-agent-v0.34.4) (2026-06-02)

## [0.34.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.2...guest-agent-v0.34.3) (2026-06-02)


### Bug Fixes

* **guest-agent:** fail checkpoint on unreadable artifact root ([#15886](https://github.com/vm0-ai/vm0/issues/15886)) ([8812f88](https://github.com/vm0-ai/vm0/commit/8812f887b4559f8b68f36a7f1824780eacb14bfa))

## [0.34.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.1...guest-agent-v0.34.2) (2026-06-02)


### Refactoring

* split guest-agent integration tests ([#15871](https://github.com/vm0-ai/vm0/issues/15871)) ([5c14f9e](https://github.com/vm0-ai/vm0/commit/5c14f9e68f60d9daab881d15568e0891893e44b5))

## [0.34.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.0...guest-agent-v0.34.1) (2026-06-02)


### Bug Fixes

* classify Claude Code session/weekly limits as usage limits ([#15854](https://github.com/vm0-ai/vm0/issues/15854)) ([140fcaa](https://github.com/vm0-ai/vm0/commit/140fcaae9e2d190c91746ee556174418acdcad04)), closes [#15852](https://github.com/vm0-ai/vm0/issues/15852)

## [0.34.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.33.5...guest-agent-v0.34.0) (2026-06-01)


### Features

* add canonical workspace drive foundation ([#15688](https://github.com/vm0-ai/vm0/issues/15688)) ([593460a](https://github.com/vm0-ai/vm0/commit/593460ab818768ae75d1fd658a7211a2120a956b))

## [0.33.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.33.4...guest-agent-v0.33.5) (2026-06-01)

## [0.33.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.33.3...guest-agent-v0.33.4) (2026-06-01)


### Refactoring

* hardcode runner working directory ([#15606](https://github.com/vm0-ai/vm0/issues/15606)) ([132296d](https://github.com/vm0-ai/vm0/commit/132296da082953e4cdeb796c8a4432e07cd38c20))

## [0.33.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.33.2...guest-agent-v0.33.3) (2026-05-31)

## [0.33.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.33.1...guest-agent-v0.33.2) (2026-05-31)


### Performance Improvements

* **guest-agent:** move event payloads without cloning ([#15558](https://github.com/vm0-ai/vm0/issues/15558)) ([9ebd3fa](https://github.com/vm0-ai/vm0/commit/9ebd3fa72143c81e2a8e5233227f96f51c26fb02))

## [0.33.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.33.0...guest-agent-v0.33.1) (2026-05-29)


### Bug Fixes

* classify codex session limits as usage limits ([#15371](https://github.com/vm0-ai/vm0/issues/15371)) ([f37823f](https://github.com/vm0-ai/vm0/commit/f37823f8e5d8bbb2f2a278bf3e85365b0a91ed52))

## [0.33.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.26...guest-agent-v0.33.0) (2026-05-28)


### Features

* **guest-agent:** default codex reasoning_effort to xhigh for gpt-5.5 ([#15310](https://github.com/vm0-ai/vm0/issues/15310)) ([0c895c7](https://github.com/vm0-ai/vm0/commit/0c895c794a70c389fe4f03e2142512bd23474a85))

## [0.32.26](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.25...guest-agent-v0.32.26) (2026-05-28)

## [0.32.25](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.24...guest-agent-v0.32.25) (2026-05-27)


### Refactoring

* split artifact snapshot phases ([#15146](https://github.com/vm0-ai/vm0/issues/15146)) ([5fa4ef4](https://github.com/vm0-ai/vm0/commit/5fa4ef48de916bb45e392be79e8fae25ee112325))

## [0.32.24](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.23...guest-agent-v0.32.24) (2026-05-27)


### Bug Fixes

* make guest-agent api http config explicit ([#15095](https://github.com/vm0-ai/vm0/issues/15095)) ([ec72581](https://github.com/vm0-ai/vm0/commit/ec725819f03cef9d5f713050307b0e92b36aba4c))
* validate claude tool list entries ([#15092](https://github.com/vm0-ai/vm0/issues/15092)) ([7f48d58](https://github.com/vm0-ai/vm0/commit/7f48d5836cd891200f3b0a4159aad9d0ad59726f))

## [0.32.23](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.22...guest-agent-v0.32.23) (2026-05-27)

## [0.32.22](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.21...guest-agent-v0.32.22) (2026-05-26)

## [0.32.21](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.20...guest-agent-v0.32.21) (2026-05-26)

## [0.32.20](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.19...guest-agent-v0.32.20) (2026-05-25)

## [0.32.19](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.18...guest-agent-v0.32.19) (2026-05-25)

## [0.32.18](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.17...guest-agent-v0.32.18) (2026-05-25)


### Bug Fixes

* downgrade expected runner job failures ([#14845](https://github.com/vm0-ai/vm0/issues/14845)) ([01e7044](https://github.com/vm0-ai/vm0/commit/01e7044031f4d998bce986e724b3329aba72ecf2))

## [0.32.17](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.16...guest-agent-v0.32.17) (2026-05-25)


### Bug Fixes

* pass guest reseed entropy over exec stdin ([#14758](https://github.com/vm0-ai/vm0/issues/14758)) ([6f9a4aa](https://github.com/vm0-ai/vm0/commit/6f9a4aac941effcad301911f5dfec055bb758667))

## [0.32.16](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.15...guest-agent-v0.32.16) (2026-05-25)


### Refactoring

* share storage request file dto ([#14739](https://github.com/vm0-ai/vm0/issues/14739)) ([55dcc8d](https://github.com/vm0-ai/vm0/commit/55dcc8d2190ff326f5d0bcba3c18c36b2846e3ce))

## [0.32.15](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.14...guest-agent-v0.32.15) (2026-05-24)

## [0.32.14](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.13...guest-agent-v0.32.14) (2026-05-24)

## [0.32.13](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.12...guest-agent-v0.32.13) (2026-05-23)

## [0.32.12](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.11...guest-agent-v0.32.12) (2026-05-22)

## [0.32.11](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.10...guest-agent-v0.32.11) (2026-05-22)

## [0.32.10](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.9...guest-agent-v0.32.10) (2026-05-21)

## [0.32.9](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.8...guest-agent-v0.32.9) (2026-05-21)

## [0.32.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.7...guest-agent-v0.32.8) (2026-05-21)


### Refactoring

* remove legacy spawn process protocol ([#14315](https://github.com/vm0-ai/vm0/issues/14315)) ([eecb69f](https://github.com/vm0-ai/vm0/commit/eecb69fbba0b5a16b0cd804698613303655dcb7e))

## [0.32.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.6...guest-agent-v0.32.7) (2026-05-20)

## [0.32.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.5...guest-agent-v0.32.6) (2026-05-20)


### Bug Fixes

* parse guest cpu stat fields strictly ([#14157](https://github.com/vm0-ai/vm0/issues/14157)) ([78f614a](https://github.com/vm0-ai/vm0/commit/78f614a3a059682798babd983b6ae9cbdd6bf7f2))
* preserve Claude failure diagnostics ([#14174](https://github.com/vm0-ai/vm0/issues/14174)) ([7cd9971](https://github.com/vm0-ai/vm0/commit/7cd99711b6ded65520acbfbe74f12d90a0f391c6))

## [0.32.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.4...guest-agent-v0.32.5) (2026-05-19)

## [0.32.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.3...guest-agent-v0.32.4) (2026-05-19)


### Bug Fixes

* enforce api start time milliseconds ([#13963](https://github.com/vm0-ai/vm0/issues/13963)) ([847d7a2](https://github.com/vm0-ai/vm0/commit/847d7a2054778457d0c65da5e75439b71b78d965))

## [0.32.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.2...guest-agent-v0.32.3) (2026-05-19)


### Bug Fixes

* disable imagegen skill for codex runner ([#13902](https://github.com/vm0-ai/vm0/issues/13902)) ([0d1d61d](https://github.com/vm0-ai/vm0/commit/0d1d61d7a323442dcd2d4d1d98404b6aaceabc0f))

## [0.32.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.1...guest-agent-v0.32.2) (2026-05-19)


### Bug Fixes

* add runner failure diagnostics ([#13880](https://github.com/vm0-ai/vm0/issues/13880)) ([3fc6515](https://github.com/vm0-ai/vm0/commit/3fc6515e53564de4668ae551ce4caaebcb943d74))

## [0.32.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.0...guest-agent-v0.32.1) (2026-05-18)


### Bug Fixes

* preserve codex jsonl failure diagnostics ([#13713](https://github.com/vm0-ai/vm0/issues/13713)) ([7fe2ece](https://github.com/vm0-ai/vm0/commit/7fe2ece7cb75ee6606e4cfb522cc28a19117acf3))
* preserve stderr for generic codex failures ([#13717](https://github.com/vm0-ai/vm0/issues/13717)) ([326145b](https://github.com/vm0-ai/vm0/commit/326145b4d1643757ff9a815d15ff71d3e4ec0729))


### Documentation

* document guest-agent http client constructors ([#13674](https://github.com/vm0-ai/vm0/issues/13674)) ([4ede9cc](https://github.com/vm0-ai/vm0/commit/4ede9cc0dffe19e7c6dc463dec870a03af0de0a3))

## [0.32.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.8...guest-agent-v0.32.0) (2026-05-17)


### Features

* wire operation-bound process control to guest-agent ([#13538](https://github.com/vm0-ai/vm0/issues/13538)) ([3bc2ee1](https://github.com/vm0-ai/vm0/commit/3bc2ee1dda51d68c6825a1a71bf44edbc9692a0d))


### Refactoring

* separate guest-agent session metadata capture ([#13550](https://github.com/vm0-ai/vm0/issues/13550)) ([8600e84](https://github.com/vm0-ai/vm0/commit/8600e844cdf87e0c72a717960538c6b704d65b97))

## [0.31.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.7...guest-agent-v0.31.8) (2026-05-16)


### Documentation

* **guest-agent:** document cli module boundaries ([#13531](https://github.com/vm0-ai/vm0/issues/13531)) ([5fdedd4](https://github.com/vm0-ai/vm0/commit/5fdedd493b951ddb83a2ccd18b26897e85e473e4))

## [0.31.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.6...guest-agent-v0.31.7) (2026-05-16)


### Refactoring

* **guest-agent:** extract cli termination fsm ([#13493](https://github.com/vm0-ai/vm0/issues/13493)) ([f35b86f](https://github.com/vm0-ai/vm0/commit/f35b86f3b070e089d6ede4ebe5f54328934538dc))

## [0.31.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.5...guest-agent-v0.31.6) (2026-05-15)


### Refactoring

* **guest-agent:** extract cli framework behavior ([#13481](https://github.com/vm0-ai/vm0/issues/13481)) ([0550ed2](https://github.com/vm0-ai/vm0/commit/0550ed2f6c27cc7799bdd7f8e9df32cc03796568))

## [0.31.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.4...guest-agent-v0.31.5) (2026-05-15)


### Refactoring

* **guest-agent:** extract cli event delivery state ([#13477](https://github.com/vm0-ai/vm0/issues/13477)) ([c17e528](https://github.com/vm0-ai/vm0/commit/c17e528867b79ca8cb5acb36d01aecca26f725fe))

## [0.31.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.3...guest-agent-v0.31.4) (2026-05-15)


### Refactoring

* **guest-agent:** extract cli command building ([#13460](https://github.com/vm0-ai/vm0/issues/13460)) ([fc3de78](https://github.com/vm0-ai/vm0/commit/fc3de78e4e9977623e03fb2b8aad39e24c77a943))
* **guest-agent:** extract cli stderr diagnostics ([#13467](https://github.com/vm0-ai/vm0/issues/13467)) ([4412206](https://github.com/vm0-ai/vm0/commit/4412206ad10e5bebcd77aead7e709a02f83e7ee7))

## [0.31.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.2...guest-agent-v0.31.3) (2026-05-14)


### Bug Fixes

* avoid symlink traversal in codex session lookup ([#13321](https://github.com/vm0-ai/vm0/issues/13321)) ([72f85e9](https://github.com/vm0-ai/vm0/commit/72f85e9d27b2e45d5a6981de4320096a220a039b))


### Refactoring

* share guest-agent no-follow fs helpers ([#13341](https://github.com/vm0-ai/vm0/issues/13341)) ([fc259af](https://github.com/vm0-ai/vm0/commit/fc259af7bc81253453decb672bf4583fdb0d5a14))

## [0.31.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.1...guest-agent-v0.31.2) (2026-05-14)


### Bug Fixes

* write codex auth atomically ([#13296](https://github.com/vm0-ai/vm0/issues/13296)) ([9ccf7dc](https://github.com/vm0-ai/vm0/commit/9ccf7dc7409339cf06c7aca8219915c8cf19f979))


### Refactoring

* **api-contracts:** generate codex oauth placeholders ([#13315](https://github.com/vm0-ai/vm0/issues/13315)) ([b9cd208](https://github.com/vm0-ai/vm0/commit/b9cd208dd81a1798b5e946b12581c3648bee0ddd))

## [0.31.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.0...guest-agent-v0.31.1) (2026-05-14)


### Bug Fixes

* handle claude zero-turn no-history runs ([#13246](https://github.com/vm0-ai/vm0/issues/13246)) ([41db91a](https://github.com/vm0-ai/vm0/commit/41db91ac41352fd0e7c2f8c5a77563d4dffd35d7))

## [0.31.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.30.4...guest-agent-v0.31.0) (2026-05-13)


### Features

* enable Codex memory mounting ([#12651](https://github.com/vm0-ai/vm0/issues/12651)) ([3646b72](https://github.com/vm0-ai/vm0/commit/3646b72ccafa675ff53895f797a99a1e754fd82e))
* **guest-agent:** record last event to cli exit metric ([#12272](https://github.com/vm0-ai/vm0/issues/12272)) ([dce7e82](https://github.com/vm0-ai/vm0/commit/dce7e82908b8bf8f5aff511a7995c0f8e20e66a5))


### Bug Fixes

* **guest-agent:** bound cli stderr diagnostics ([#12937](https://github.com/vm0-ai/vm0/issues/12937)) ([f640407](https://github.com/vm0-ai/vm0/commit/f64040738b75cc29b141bfa18960200fb30727f3))
* **guest-agent:** gate claude code event handling ([#12327](https://github.com/vm0-ai/vm0/issues/12327)) ([94a7634](https://github.com/vm0-ai/vm0/commit/94a7634254d9445f04bb3456d5c28e67bd15e189))
* log Codex JSONL failure diagnostics ([#13118](https://github.com/vm0-ai/vm0/issues/13118)) ([94686f0](https://github.com/vm0-ai/vm0/commit/94686f000b644c7c178dc1eb62976318cdfe006d))
* log masked cli stderr on failure ([#12786](https://github.com/vm0-ai/vm0/issues/12786)) ([0b7c456](https://github.com/vm0-ai/vm0/commit/0b7c456c731f194e7cb9165db91d4afcf7a7249a))


### Refactoring

* split guest artifact snapshot modules ([#13014](https://github.com/vm0-ai/vm0/issues/13014)) ([69d4ebc](https://github.com/vm0-ai/vm0/commit/69d4ebc10f4d72f485401640a66063e2243c115d))

## [0.30.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.30.3...guest-agent-v0.30.4) (2026-05-13)


### Bug Fixes

* log Codex JSONL failure diagnostics ([#13118](https://github.com/vm0-ai/vm0/issues/13118)) ([94686f0](https://github.com/vm0-ai/vm0/commit/94686f000b644c7c178dc1eb62976318cdfe006d))

## [0.30.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.30.2...guest-agent-v0.30.3) (2026-05-12)


### Refactoring

* split guest artifact snapshot modules ([#13014](https://github.com/vm0-ai/vm0/issues/13014)) ([69d4ebc](https://github.com/vm0-ai/vm0/commit/69d4ebc10f4d72f485401640a66063e2243c115d))

## [0.30.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.30.1...guest-agent-v0.30.2) (2026-05-12)


### Bug Fixes

* **guest-agent:** bound cli stderr diagnostics ([#12937](https://github.com/vm0-ai/vm0/issues/12937)) ([f640407](https://github.com/vm0-ai/vm0/commit/f64040738b75cc29b141bfa18960200fb30727f3))

## [0.30.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.30.0...guest-agent-v0.30.1) (2026-05-12)


### Bug Fixes

* log masked cli stderr on failure ([#12786](https://github.com/vm0-ai/vm0/issues/12786)) ([0b7c456](https://github.com/vm0-ai/vm0/commit/0b7c456c731f194e7cb9165db91d4afcf7a7249a))

## [0.30.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.29.1...guest-agent-v0.30.0) (2026-05-11)


### Features

* enable Codex memory mounting ([#12651](https://github.com/vm0-ai/vm0/issues/12651)) ([3646b72](https://github.com/vm0-ai/vm0/commit/3646b72ccafa675ff53895f797a99a1e754fd82e))

## [0.29.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.29.0...guest-agent-v0.29.1) (2026-05-09)


### Bug Fixes

* **guest-agent:** gate claude code event handling ([#12327](https://github.com/vm0-ai/vm0/issues/12327)) ([94a7634](https://github.com/vm0-ai/vm0/commit/94a7634254d9445f04bb3456d5c28e67bd15e189))

## [0.29.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.28.4...guest-agent-v0.29.0) (2026-05-09)


### Features

* **guest-agent:** record last event to cli exit metric ([#12272](https://github.com/vm0-ai/vm0/issues/12272)) ([dce7e82](https://github.com/vm0-ai/vm0/commit/dce7e82908b8bf8f5aff511a7995c0f8e20e66a5))

## [0.28.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.28.3...guest-agent-v0.28.4) (2026-05-09)

## [0.28.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.28.2...guest-agent-v0.28.3) (2026-05-08)


### Bug Fixes

* **cli:** drain terminal run events ([#12154](https://github.com/vm0-ai/vm0/issues/12154)) ([1795a3c](https://github.com/vm0-ai/vm0/commit/1795a3c1a08f1337aa47ce95495bcac472a11d83))

## [0.28.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.28.1...guest-agent-v0.28.2) (2026-05-08)


### Bug Fixes

* restore codex sessions as jsonl ([#12137](https://github.com/vm0-ai/vm0/issues/12137)) ([ab3dc5b](https://github.com/vm0-ai/vm0/commit/ab3dc5b5f35105709cc22d7caf9e571c59ec5a39))

## [0.28.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.28.0...guest-agent-v0.28.1) (2026-05-07)


### Bug Fixes

* preserve real codex stderr through complete + telemetry pipelines ([#12082](https://github.com/vm0-ai/vm0/issues/12082)) ([748c737](https://github.com/vm0-ai/vm0/commit/748c737a1622716107888dcd228c4eccb29bc6c1))

## [0.28.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.27.1...guest-agent-v0.28.0) (2026-05-07)


### Features

* pass codex append prompt as developer instructions ([#12063](https://github.com/vm0-ai/vm0/issues/12063)) ([8fb02a3](https://github.com/vm0-ai/vm0/commit/8fb02a3feab159db1fe5dfd35a50c481d267193b))


### Bug Fixes

* use lowercase codex auth mode ([#12075](https://github.com/vm0-ai/vm0/issues/12075)) ([0a1770e](https://github.com/vm0-ai/vm0/commit/0a1770e7b9cd27c298351c611b274c054dad8cd4))

## [0.27.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.27.0...guest-agent-v0.27.1) (2026-05-06)


### Bug Fixes

* **guest-agent:** checkpoint recoverable abnormal exits ([#11984](https://github.com/vm0-ai/vm0/issues/11984)) ([f4621f4](https://github.com/vm0-ai/vm0/commit/f4621f40f47229f364e0f82a2ca3b4a49b15b15c))


### Refactoring

* **guest-agent:** initialize http client explicitly ([#11966](https://github.com/vm0-ai/vm0/issues/11966)) ([d0984f2](https://github.com/vm0-ai/vm0/commit/d0984f2d66307cfd54320e117723e7a3cfdd77ab))
* rename chatgpt-oauth-token to codex-oauth-token ([#11990](https://github.com/vm0-ai/vm0/issues/11990)) ([0659786](https://github.com/vm0-ai/vm0/commit/06597865f129656105438bc99d4d308b6c9942b7))

## [0.27.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.5...guest-agent-v0.27.0) (2026-05-06)


### Features

* **guest-agent:** bootstrap codex chatgpt-oauth mode via fabricated auth.json ([#11881](https://github.com/vm0-ai/vm0/issues/11881)) ([d7f8127](https://github.com/vm0-ai/vm0/commit/d7f81275af55020f7de7d54a432e2d80b6a62902))

## [0.26.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.4...guest-agent-v0.26.5) (2026-05-05)

## [0.26.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.3...guest-agent-v0.26.4) (2026-05-03)


### Documentation

* document guest agent error variants ([#11735](https://github.com/vm0-ai/vm0/issues/11735)) ([5582bd2](https://github.com/vm0-ai/vm0/commit/5582bd29e15032f24f1f755a407c7824a276356d))

## [0.26.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.2...guest-agent-v0.26.3) (2026-05-03)


### Bug Fixes

* **guest-agent:** escalate forced CLI termination ([#11698](https://github.com/vm0-ai/vm0/issues/11698)) ([ad07a39](https://github.com/vm0-ai/vm0/commit/ad07a39afca3122eb73bd9092a48cbdd07d33766))


### Documentation

* **guest-agent:** document artifact env fields ([#11700](https://github.com/vm0-ai/vm0/issues/11700)) ([4fa1127](https://github.com/vm0-ai/vm0/commit/4fa1127ab2e5c189609a05e49abfd9130c6b2df8))
* **guest-agent:** document env accessors ([#11713](https://github.com/vm0-ai/vm0/issues/11713)) ([cd72661](https://github.com/vm0-ai/vm0/commit/cd726614df33729c72f601e73357ee31b3fa948e))

## [0.26.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.1...guest-agent-v0.26.2) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.26.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.0...guest-agent-v0.26.1) (2026-04-29)


### Bug Fixes

* **guest-agent:** disable claude background tasks ([#11533](https://github.com/vm0-ai/vm0/issues/11533)) ([1d85fa1](https://github.com/vm0-ai/vm0/commit/1d85fa121e26773eb1cf44b8d3f57cbf7e62c687))

## [0.26.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.25.0...guest-agent-v0.26.0) (2026-04-29)


### Features

* **api-contracts:** add rust dto generation for storage webhooks ([#11450](https://github.com/vm0-ai/vm0/issues/11450)) ([5e42002](https://github.com/vm0-ai/vm0/commit/5e42002fa5ed4aede5e0e4399913d8e0c6f51f8d))

## [0.25.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.8...guest-agent-v0.25.0) (2026-04-28)


### Features

* **guest-agent:** codex command path + framework dispatch ([#11423](https://github.com/vm0-ai/vm0/issues/11423)) ([520e73c](https://github.com/vm0-ai/vm0/commit/520e73c1e0a1d15cddd096bd3f0f7c0746605e05))
* **guest-agent:** codex session resume + checkpoint scan ([#11430](https://github.com/vm0-ai/vm0/issues/11430)) ([fd267b5](https://github.com/vm0-ai/vm0/commit/fd267b568eb9ae86b9f55d8357e486ed67285486))

## [0.24.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.7...guest-agent-v0.24.8) (2026-04-28)


### Refactoring

* deduplicate guest-agent http retries ([#11368](https://github.com/vm0-ai/vm0/issues/11368)) ([8c230e1](https://github.com/vm0-ai/vm0/commit/8c230e15592fd65892932a8b1bbffcc67562dfa1))

## [0.24.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.6...guest-agent-v0.24.7) (2026-04-27)


### Refactoring

* centralize guest system log path ([#11246](https://github.com/vm0-ai/vm0/issues/11246)) ([b93fc42](https://github.com/vm0-ai/vm0/commit/b93fc42833815fd843f073044b4e872505812025))

## [0.24.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.5...guest-agent-v0.24.6) (2026-04-27)

## [0.24.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.4...guest-agent-v0.24.5) (2026-04-27)


### Bug Fixes

* **guest-agent:** build artifact archives in-process ([#11216](https://github.com/vm0-ai/vm0/issues/11216)) ([d84a024](https://github.com/vm0-ai/vm0/commit/d84a0246d700a713c508ae5bee995131054127f9))
* **guest-agent:** delay initial telemetry tick ([#11235](https://github.com/vm0-ai/vm0/issues/11235)) ([fb8c855](https://github.com/vm0-ai/vm0/commit/fb8c855026c6fb160604f52846af7453db5f85f5))

## [0.24.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.3...guest-agent-v0.24.4) (2026-04-26)


### Bug Fixes

* **guest-agent:** reduce streaming upload allocations ([#11156](https://github.com/vm0-ai/vm0/issues/11156)) ([53cc666](https://github.com/vm0-ai/vm0/commit/53cc6663c89c41a50a754e34237ccf3eb61b0f27))
* stabilize run stdout event visibility ([#11149](https://github.com/vm0-ai/vm0/issues/11149)) ([479c57e](https://github.com/vm0-ai/vm0/commit/479c57e06f22ef706e3be087a21c4a7588bbea38))

## [0.24.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.2...guest-agent-v0.24.3) (2026-04-25)


### Refactoring

* **guest-agent:** serialize telemetry uploads via single-writer actor ([#11100](https://github.com/vm0-ai/vm0/issues/11100)) ([1a0a747](https://github.com/vm0-ai/vm0/commit/1a0a747d479e73676a87bb1cdeffaf844ebde3f4))

## [0.24.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.1...guest-agent-v0.24.2) (2026-04-24)


### Refactoring

* **guest-agent:** replace telemetry bool flag with an upload-mode enum ([#11030](https://github.com/vm0-ai/vm0/issues/11030)) ([93bbb5f](https://github.com/vm0-ai/vm0/commit/93bbb5fdf5c90d8b4fa04b986a4ae4d25143abfc))

## [0.24.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.0...guest-agent-v0.24.1) (2026-04-24)


### Bug Fixes

* **guest-agent:** align telemetry reads to newline boundary ([#11026](https://github.com/vm0-ai/vm0/issues/11026)) ([df5532c](https://github.com/vm0-ai/vm0/commit/df5532cadc03d52337bbccbba519f1ea20702e78))


### Performance Improvements

* **guest-agent:** skip vas snapshot for unchanged artifacts (part 2 of [#10967](https://github.com/vm0-ai/vm0/issues/10967)) ([#10989](https://github.com/vm0-ai/vm0/issues/10989)) ([4d4b18e](https://github.com/vm0-ai/vm0/commit/4d4b18ede0f7f13c767cb8d50726d9ea1e69c780))

## [0.24.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.23.1...guest-agent-v0.24.0) (2026-04-24)


### Features

* thread storage id from web to guest-agent (part 1 of [#10967](https://github.com/vm0-ai/vm0/issues/10967)) ([#10978](https://github.com/vm0-ai/vm0/issues/10978)) ([85f2193](https://github.com/vm0-ai/vm0/commit/85f219383d3cf7b81ca6f41358276d5388acb8c0))

## [0.23.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.23.0...guest-agent-v0.23.1) (2026-04-24)


### Performance Improvements

* **guest-agent:** parallelize session history upload and artifact snapshot ([#10962](https://github.com/vm0-ai/vm0/issues/10962)) ([27718e3](https://github.com/vm0-ai/vm0/commit/27718e39c2ff1870502dae16d72fc711c13a2cf0))

## [0.23.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.22.3...guest-agent-v0.23.0) (2026-04-24)


### Features

* **guest-agent:** emit mount path in artifact snapshots ([#10924](https://github.com/vm0-ai/vm0/issues/10924)) ([0db3944](https://github.com/vm0-ai/vm0/commit/0db3944a3291367d1324eba0a9101036ec58927f)), closes [#10911](https://github.com/vm0-ai/vm0/issues/10911) [#10906](https://github.com/vm0-ai/vm0/issues/10906)

## [0.22.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.22.2...guest-agent-v0.22.3) (2026-04-23)


### Bug Fixes

* **guest-agent:** reap cli process group after type=result ([#10879](https://github.com/vm0-ai/vm0/issues/10879)) ([#10897](https://github.com/vm0-ai/vm0/issues/10897)) ([1ac27f9](https://github.com/vm0-ai/vm0/commit/1ac27f9884d00d01ef072bef59c4b5389c053d1a))

## [0.22.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.22.1...guest-agent-v0.22.2) (2026-04-23)


### Performance Improvements

* **runner:** post /complete from guest-agent after checkpoint lands ([#10787](https://github.com/vm0-ai/vm0/issues/10787)) ([69e00f0](https://github.com/vm0-ai/vm0/commit/69e00f0540348aaab547b13c7533bd97af88ad23))

## [0.22.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.22.0...guest-agent-v0.22.1) (2026-04-22)


### Refactoring

* drop residual memory plumbing, legacy snapshot columns, and vm0 memory cli ([#10707](https://github.com/vm0-ai/vm0/issues/10707)) ([08f3ce8](https://github.com/vm0-ai/vm0/commit/08f3ce81273faf8ea7e2e4df67b69e774bcb963e))
* emit memory as artifacts[] entry and delete guest-agent symlink bootstrap ([#10700](https://github.com/vm0-ai/vm0/issues/10700)) ([e3f0120](https://github.com/vm0-ai/vm0/commit/e3f0120fbd90d9b9fb750e13440a9f21ea809d3a))
* **guest-agent:** simplify checkpoint session-read error handling ([#10710](https://github.com/vm0-ai/vm0/issues/10710)) ([ad9ee70](https://github.com/vm0-ai/vm0/commit/ad9ee701531c25c4ad3e7285e5a5a0d07d9d1431))

## [0.22.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.7...guest-agent-v0.22.0) (2026-04-22)


### Features

* multi-mount artifact backend + checkpoint schema ([#10629](https://github.com/vm0-ai/vm0/issues/10629)) ([0f8af96](https://github.com/vm0-ai/vm0/commit/0f8af96cd55dedd89534ff430765cc34661a55fc))

## [0.21.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.6...guest-agent-v0.21.7) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.21.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.5...guest-agent-v0.21.6) (2026-04-21)


### Bug Fixes

* **guest-agent:** bump stuck tool timeout from 60s to 180s ([#10453](https://github.com/vm0-ai/vm0/issues/10453)) ([ef2e832](https://github.com/vm0-ai/vm0/commit/ef2e832e15813203614c4a754dc67e3033fdb4bb)), closes [#10450](https://github.com/vm0-ai/vm0/issues/10450)

## [0.21.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.4...guest-agent-v0.21.5) (2026-04-19)


### Bug Fixes

* **guest-agent:** fail fast on empty session id before checkpoint ([#10147](https://github.com/vm0-ai/vm0/issues/10147)) ([42746f0](https://github.com/vm0-ai/vm0/commit/42746f0899575f43a1d9ec411c50feda29c24be6))
* **guest-agent:** record per-op durations for checkpoint session reads ([#10141](https://github.com/vm0-ai/vm0/issues/10141)) ([10d5a57](https://github.com/vm0-ai/vm0/commit/10d5a572e7cce65a0ac65fc3776626a1849ea6ff))

## [0.21.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.3...guest-agent-v0.21.4) (2026-04-18)


### Performance Improvements

* **guest-agent:** parallelize final telemetry upload with checkpoint ([#9894](https://github.com/vm0-ai/vm0/issues/9894)) ([d799d98](https://github.com/vm0-ai/vm0/commit/d799d981f153f4d09cabe60faae8fbc30e4732d3))
* **guest-agent:** skip storages api when memory unchanged since boot ([#9921](https://github.com/vm0-ai/vm0/issues/9921)) ([e33ec2c](https://github.com/vm0-ai/vm0/commit/e33ec2c6faf747b3d1e6c68796d35f501c4bc218))

## [0.21.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.2...guest-agent-v0.21.3) (2026-04-17)


### Bug Fixes

* **guest-agent:** mask substring secrets with aho-corasick leftmost-longest ([#9808](https://github.com/vm0-ai/vm0/issues/9808)) ([f1bcd8e](https://github.com/vm0-ai/vm0/commit/f1bcd8e1c61880d22e83f3cdf328318810f4123f))

## [0.21.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.1...guest-agent-v0.21.2) (2026-04-13)


### Performance Improvements

* **guest-agent:** stream artifact upload instead of buffering entire file ([#9043](https://github.com/vm0-ai/vm0/issues/9043)) ([fb0506b](https://github.com/vm0-ai/vm0/commit/fb0506b3df97f90fc8d01e2e522c0e44aad6c856))

## [0.21.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.0...guest-agent-v0.21.1) (2026-04-12)


### Bug Fixes

* **guest-agent:** add stdout drain deadline to prevent hanging on orphaned pipes ([#8980](https://github.com/vm0-ai/vm0/issues/8980)) ([8c7b8f1](https://github.com/vm0-ai/vm0/commit/8c7b8f15ea74fd95542568f15f6f0d0f7a9a0812))
* **guest-agent:** terminate heartbeat loop after consecutive failures ([#8992](https://github.com/vm0-ai/vm0/issues/8992)) ([1c6b658](https://github.com/vm0-ai/vm0/commit/1c6b6588ed2c6e0ccebd2ed30dd28ff09a2ed873))

## [0.21.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.20.0...guest-agent-v0.21.0) (2026-04-10)


### Features

* **runner:** pass feature switch states through execution context ([#8778](https://github.com/vm0-ai/vm0/issues/8778)) ([edbe85c](https://github.com/vm0-ai/vm0/commit/edbe85ca3f0fb81821aeeb609a0a700fcbd137e8))


### Bug Fixes

* **runner:** address feature switch review findings ([#8801](https://github.com/vm0-ai/vm0/issues/8801)) ([ae7eaba](https://github.com/vm0-ai/vm0/commit/ae7eabad66b72d38d16a4a01b97437bd5d962b3b))

## [0.20.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.5...guest-agent-v0.20.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.19.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.4...guest-agent-v0.19.5) (2026-04-08)


### Bug Fixes

* **checkpoint:** use presigned url for session history upload ([#8445](https://github.com/vm0-ai/vm0/issues/8445)) ([4a019bb](https://github.com/vm0-ai/vm0/commit/4a019bb53dc2323e2981f74d02e78f4eaf2e185c))

## [0.19.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.3...guest-agent-v0.19.4) (2026-03-31)


### Bug Fixes

* **guest-agent:** use explicit file list for tar to match manifest ([#7311](https://github.com/vm0-ai/vm0/issues/7311)) ([448f019](https://github.com/vm0-ai/vm0/commit/448f019d2ad0f2e061d6e924e31567dc02f36bfd))

## [0.19.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.2...guest-agent-v0.19.3) (2026-03-29)


### Bug Fixes

* **crates:** update sha2/hmac usage for digest 0.11 compatibility ([#7101](https://github.com/vm0-ai/vm0/issues/7101)) ([cbded46](https://github.com/vm0-ai/vm0/commit/cbded46e78c8d3ed060e96f79f15cd38ee1cf9dc))

## [0.19.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.1...guest-agent-v0.19.2) (2026-03-23)


### Bug Fixes

* use file_type() in walk_dir to avoid following symlinks ([#6184](https://github.com/vm0-ai/vm0/issues/6184)) ([b173f34](https://github.com/vm0-ai/vm0/commit/b173f34e8ed4edaf6bc169c8e18c9462c6aaa789))

## [0.19.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.0...guest-agent-v0.19.1) (2026-03-21)


### Bug Fixes

* **guest-agent:** add -- separator to prevent variadic flags from swallowing prompt ([#5789](https://github.com/vm0-ai/vm0/issues/5789)) ([b9b2fab](https://github.com/vm0-ai/vm0/commit/b9b2fabe509046af54776cb540b71deee0653c11))

## [0.19.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.18.0...guest-agent-v0.19.0) (2026-03-20)


### Features

* support --settings flag for vm0 run ([#5663](https://github.com/vm0-ai/vm0/issues/5663)) ([#5753](https://github.com/vm0-ai/vm0/issues/5753)) ([d0aad87](https://github.com/vm0-ai/vm0/commit/d0aad87539c31ae4664d41b1cca46b556b3de66e))
* support --tools cli parameter across full pipeline ([#5752](https://github.com/vm0-ai/vm0/issues/5752)) ([b0cf364](https://github.com/vm0-ai/vm0/commit/b0cf364a8598dcd36ed1a6ffffdb8c1e03d1841c))

## [0.18.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.17.0...guest-agent-v0.18.0) (2026-03-19)


### Features

* add storage version lineage table for artifact/memory parent tracking ([#5501](https://github.com/vm0-ai/vm0/issues/5501)) ([c2b3115](https://github.com/vm0-ai/vm0/commit/c2b311506f65889215730b27a4ad0d244c651747))
* **runner:** pass disallowed tools from execution context to claude cli ([#5577](https://github.com/vm0-ai/vm0/issues/5577)) ([cdc557a](https://github.com/vm0-ai/vm0/commit/cdc557a4ccb873b37b5df3cc3eb550d6f0849e79)), closes [#5564](https://github.com/vm0-ai/vm0/issues/5564)

## [0.17.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.4...guest-agent-v0.17.0) (2026-03-18)


### Features

* add append-system-prompt support to runner and guest-agent ([#5384](https://github.com/vm0-ai/vm0/issues/5384)) ([37aaa76](https://github.com/vm0-ai/vm0/commit/37aaa76b7acdf8c24f2928590de54317870c3a21)), closes [#5375](https://github.com/vm0-ai/vm0/issues/5375)

## [0.16.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.3...guest-agent-v0.16.4) (2026-03-17)


### Refactoring

* **rust:** replace inline crate:: paths with top-level use imports ([#5061](https://github.com/vm0-ai/vm0/issues/5061)) ([149aaa0](https://github.com/vm0-ai/vm0/commit/149aaa09ca2bf69ffb1bc35471ba813e5884e534)), closes [#5038](https://github.com/vm0-ai/vm0/issues/5038)

## [0.16.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.2...guest-agent-v0.16.3) (2026-03-15)


### Bug Fixes

* **guest-agent:** add stuck-tool watchdog for claude code network tool hang ([#4833](https://github.com/vm0-ai/vm0/issues/4833)) ([7b71fa7](https://github.com/vm0-ai/vm0/commit/7b71fa78f9d7155f08059118391416ecf785027f)), closes [#4785](https://github.com/vm0-ai/vm0/issues/4785)

## [0.16.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.1...guest-agent-v0.16.2) (2026-03-12)


### Bug Fixes

* add explicit file size limits to storage upload handlers ([#4586](https://github.com/vm0-ai/vm0/issues/4586)) ([d899fdb](https://github.com/vm0-ai/vm0/commit/d899fdbc23a30b5e586fa0755a22f0c4d6826d8b)), closes [#4576](https://github.com/vm0-ai/vm0/issues/4576)

## [0.16.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.0...guest-agent-v0.16.1) (2026-03-10)


### Bug Fixes

* skip retry on non-retriable 4xx errors in guest-agent ([#4121](https://github.com/vm0-ai/vm0/issues/4121)) ([713b5df](https://github.com/vm0-ai/vm0/commit/713b5df9ee89a7f893bae3940c7895dd3f24b4d7))

## [0.16.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.15.1...guest-agent-v0.16.0) (2026-03-08)


### Features

* **sandbox:** symlink vm0 memory to claude code auto-memory path ([#3928](https://github.com/vm0-ai/vm0/issues/3928)) ([9aaf0e4](https://github.com/vm0-ai/vm0/commit/9aaf0e4fc8a3b530693e939307b86e9db6514fef))


### Bug Fixes

* **guest-agent:** switch cpu measurement to delta-based tracking ([#3918](https://github.com/vm0-ai/vm0/issues/3918)) ([7adfee2](https://github.com/vm0-ai/vm0/commit/7adfee2664f408fe0b3a51e41aeafcf6293d7477))

## [0.15.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.15.0...guest-agent-v0.15.1) (2026-03-07)


### Bug Fixes

* use correct storage type in memory dedup path and propagate checkpoint errors ([#3906](https://github.com/vm0-ai/vm0/issues/3906)) ([9abe586](https://github.com/vm0-ai/vm0/commit/9abe586d92126cef4fc9f7c2fa4319c7448e86dd))

## [0.15.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.14.1...guest-agent-v0.15.0) (2026-03-07)


### Features

* add --memory flag for agent long-term memory ([#3424](https://github.com/vm0-ai/vm0/issues/3424)) ([9e0279f](https://github.com/vm0-ai/vm0/commit/9e0279f618efe5396dda9e1aaac43a72bba70bfe))


### Bug Fixes

* **guest-agent:** decouple event sending from stdout reading loop ([#3884](https://github.com/vm0-ai/vm0/issues/3884)) ([c27e8a1](https://github.com/vm0-ai/vm0/commit/c27e8a1daf8447b317aba356d127fdc9405a84d0))

## [0.14.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.14.0...guest-agent-v0.14.1) (2026-03-07)


### Bug Fixes

* **guest-agent:** defer event sends during stdout drain to prevent drops ([#3859](https://github.com/vm0-ai/vm0/issues/3859)) ([843fda1](https://github.com/vm0-ai/vm0/commit/843fda1a212d53ea424c2d28a09e8d7b09c2a5a7))

## [0.14.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.13.0...guest-agent-v0.14.0) (2026-03-04)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.13.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.12.3...guest-agent-v0.13.0) (2026-03-03)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.12.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.12.2...guest-agent-v0.12.3) (2026-03-02)


### Bug Fixes

* **guest-agent:** detect cli process exit to prevent hanging on orphaned pipes ([#3409](https://github.com/vm0-ai/vm0/issues/3409)) ([2381c50](https://github.com/vm0-ai/vm0/commit/2381c50ef76c889e8ab03ee37c994950fd0bd9e3))
* **guest-agent:** only set claude-specific env vars for claude-code cli ([#3416](https://github.com/vm0-ai/vm0/issues/3416)) ([df3f92c](https://github.com/vm0-ai/vm0/commit/df3f92cff9611b017b04d6adfc5a1d43d36376ee))


### Performance Improvements

* **guest-agent:** disable non-essential cli network traffic on startup ([#3407](https://github.com/vm0-ai/vm0/issues/3407)) ([4b45f77](https://github.com/vm0-ai/vm0/commit/4b45f773632adbb1d3323eeab7e7a4c95506842b))

## [0.12.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.12.1...guest-agent-v0.12.2) (2026-03-02)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.12.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.12.0...guest-agent-v0.12.1) (2026-03-01)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.12.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.11.0...guest-agent-v0.12.0) (2026-03-01)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.11.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.10.0...guest-agent-v0.11.0) (2026-03-01)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.10.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.9.0...guest-agent-v0.10.0) (2026-03-01)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.9.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.5...guest-agent-v0.9.0) (2026-03-01)


### Performance Improvements

* **guest-agent:** pre-warm dns cache before cli spawn ([#3298](https://github.com/vm0-ai/vm0/issues/3298)) ([b3e3fb2](https://github.com/vm0-ai/vm0/commit/b3e3fb268df1e3a3570070d81be3c6506277ed2d))

## [0.8.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.4...guest-agent-v0.8.5) (2026-02-28)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.8.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.3...guest-agent-v0.8.4) (2026-02-27)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.8.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.2...guest-agent-v0.8.3) (2026-02-27)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.8.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.1...guest-agent-v0.8.2) (2026-02-27)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.8.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.0...guest-agent-v0.8.1) (2026-02-26)


### Performance Improvements

* **sandbox-fc:** enable v8 compile cache for faster cli cold start ([#3267](https://github.com/vm0-ai/vm0/issues/3267)) ([6f1c8be](https://github.com/vm0-ai/vm0/commit/6f1c8be89cd5c7168326b5fa822d26eb2f9fa824))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.7.0...guest-agent-v0.8.0) (2026-02-25)


### Features

* add intermediate e2e telemetry metrics for cli cold-start diagnosis ([#3251](https://github.com/vm0-ai/vm0/issues/3251)) ([82121a9](https://github.com/vm0-ai/vm0/commit/82121a93edcca096cacc787283edbc7275b88f42)), closes [#3250](https://github.com/vm0-ai/vm0/issues/3250)

## [0.7.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.6.0...guest-agent-v0.7.0) (2026-02-25)


### Features

* **guest-agent:** add api_to_cli_init telemetry metric ([#3245](https://github.com/vm0-ai/vm0/issues/3245)) ([b1f78b6](https://github.com/vm0-ai/vm0/commit/b1f78b63fbf1da80dd37ee92c3602319cfd1ecdc)), closes [#3244](https://github.com/vm0-ai/vm0/issues/3244)

## [0.6.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.5.0...guest-agent-v0.6.0) (2026-02-23)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.4.0...guest-agent-v0.5.0) (2026-02-23)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.3.0...guest-agent-v0.4.0) (2026-02-22)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.2.0...guest-agent-v0.3.0) (2026-02-22)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.1.0...guest-agent-v0.2.0) (2026-02-22)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))
