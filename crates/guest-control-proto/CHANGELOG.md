# Changelog

## [0.21.3](https://github.com/vm0-ai/vm0/compare/guest-control-proto-v0.21.2...guest-control-proto-v0.21.3) (2026-09-15)


### Performance Improvements

* **runner:** persist extracted storage files for cache-hit delivery ([#33976](https://github.com/vm0-ai/vm0/issues/33976)) ([b961911](https://github.com/vm0-ai/vm0/commit/b961911d0516fbdc06d3e8387bedb0653eee5ea9))

## [0.21.2](https://github.com/vm0-ai/vm0/compare/guest-control-proto-v0.21.1...guest-control-proto-v0.21.2) (2026-09-14)


### Documentation

* **rust:** clarify dns readiness output truncation semantics ([#33931](https://github.com/vm0-ai/vm0/issues/33931)) ([35603a2](https://github.com/vm0-ai/vm0/commit/35603a2ed5c3773a326642219080f08d541c2c28))


### Refactoring

* **rust:** centralize exec process diagnostic labels ([#33938](https://github.com/vm0-ai/vm0/issues/33938)) ([cd8acd3](https://github.com/vm0-ai/vm0/commit/cd8acd3a7019ece7f5ba031529e508d929b0a1b1))

## [0.21.1](https://github.com/vm0-ai/vm0/compare/guest-control-proto-v0.21.0...guest-control-proto-v0.21.1) (2026-09-11)


### Bug Fixes

* **rust:** unify guest restore timezone validation ([#33458](https://github.com/vm0-ai/vm0/issues/33458)) ([4bba414](https://github.com/vm0-ai/vm0/commit/4bba414be2b0c16aee4f67fcf7a72d3771dc9135))

## [0.21.0](https://github.com/vm0-ai/vm0/compare/guest-control-proto-v0.20.1...guest-control-proto-v0.21.0) (2026-09-09)


### Features

* **guest-control:** attribute storage apply resource usage ([#32907](https://github.com/vm0-ai/vm0/issues/32907)) ([65cd810](https://github.com/vm0-ai/vm0/commit/65cd810030c0eac6a5e8e1a377f4562f2cb58c48))

## [0.20.1](https://github.com/vm0-ai/vm0/compare/guest-control-proto-v0.20.0...guest-control-proto-v0.20.1) (2026-09-09)


### Bug Fixes

* **runner:** classify recovered cooperative cancellation races ([#32812](https://github.com/vm0-ai/vm0/issues/32812)) ([4e6a603](https://github.com/vm0-ai/vm0/commit/4e6a603da4241cfcb81e6329c91df828696ce89f))

## [0.20.0](https://github.com/vm0-ai/vm0/compare/guest-control-proto-v0.19.0...guest-control-proto-v0.20.0) (2026-09-08)


### Features

* **runner:** add bounded host-owned ssh execution ([#32526](https://github.com/vm0-ai/vm0/issues/32526)) ([7c84eb2](https://github.com/vm0-ai/vm0/commit/7c84eb254233ad62f4482f7213e1b297cc7e8692))

## [0.19.0](https://github.com/vm0-ai/vm0/compare/guest-control-proto-v0.18.49...guest-control-proto-v0.19.0) (2026-09-08)


### Features

* **runner:** diagnose private-write terminal response timeouts ([#32539](https://github.com/vm0-ai/vm0/issues/32539)) ([d4af301](https://github.com/vm0-ai/vm0/commit/d4af3011d8636ffc06a5d0bf21c1a12608795e94))

## [0.18.49](https://github.com/vm0-ai/vm0/compare/guest-control-proto-v0.18.48...guest-control-proto-v0.18.49) (2026-09-07)


### Refactoring

* **rust:** align workspace crate names with responsibilities ([#32307](https://github.com/vm0-ai/vm0/issues/32307)) ([39d81ce](https://github.com/vm0-ai/vm0/commit/39d81cedeb3c324ea48c3190e47ffb6c63bb28d9))

## [0.18.48](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.47...vsock-proto-v0.18.48) (2026-09-07)


### Documentation

* **vsock-proto:** document workspace drive messages ([#32246](https://github.com/vm0-ai/vm0/issues/32246)) ([40a3e98](https://github.com/vm0-ai/vm0/commit/40a3e98ef4b5ec3b61bd1570b1d08aed79d9afe4))

## [0.18.47](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.46...vsock-proto-v0.18.47) (2026-09-02)


### Performance Improvements

* **runner:** specialize fresh workspace mount lifecycle ([#30939](https://github.com/vm0-ai/vm0/issues/30939)) ([c3f783c](https://github.com/vm0-ai/vm0/commit/c3f783cd17c8e732c5bb3edfcd6e0fb867ea3bd7))

## [0.18.46](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.45...vsock-proto-v0.18.46) (2026-09-01)


### Performance Improvements

* **runner:** specialize reused codex cleanup lifecycle ([#30888](https://github.com/vm0-ai/vm0/issues/30888)) ([5941c94](https://github.com/vm0-ai/vm0/commit/5941c9474fb6f1389a6ca9d3c92e99a3af59b98a))

## [0.18.45](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.44...vsock-proto-v0.18.45) (2026-09-01)


### Documentation

* **vsock-proto:** correct message allocation range ([#30689](https://github.com/vm0-ai/vm0/issues/30689)) ([67a437d](https://github.com/vm0-ai/vm0/commit/67a437d4d65f2893b5b0e3cd559911af98ef7463))

## [0.18.44](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.43...vsock-proto-v0.18.44) (2026-09-01)


### Performance Improvements

* **runner:** launch reuse identity verifier without shell ([#30644](https://github.com/vm0-ai/vm0/issues/30644)) ([3ea790e](https://github.com/vm0-ai/vm0/commit/3ea790e5a8bca85854debfe537a89a66c4520445))

## [0.18.43](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.42...vsock-proto-v0.18.43) (2026-08-31)


### Performance Improvements

* **vsock-proto:** encode storage results directly ([#30553](https://github.com/vm0-ai/vm0/issues/30553)) ([fc1a863](https://github.com/vm0-ai/vm0/commit/fc1a8634de0cd471b6fffca0ab324d420f0a45a3))

## [0.18.42](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.41...vsock-proto-v0.18.42) (2026-08-31)


### Documentation

* **vsock-proto:** document guest storage manifest request constraints ([#30456](https://github.com/vm0-ai/vm0/issues/30456)) ([f1a688a](https://github.com/vm0-ai/vm0/commit/f1a688ade7bbe5d7de975147f2521a4676357ee6))

## [0.18.41](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.40...vsock-proto-v0.18.41) (2026-08-28)


### Documentation

* **rust:** document exec-start process contracts ([#30083](https://github.com/vm0-ai/vm0/issues/30083)) ([598b61b](https://github.com/vm0-ai/vm0/commit/598b61b22a54af2f711ab05c7ed09431d0924ceb))

## [0.18.40](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.39...vsock-proto-v0.18.40) (2026-08-28)


### Performance Improvements

* **runner:** batch required private guest writes ([#29943](https://github.com/vm0-ai/vm0/issues/29943)) ([97414e6](https://github.com/vm0-ai/vm0/commit/97414e6c34b2241df1cbcf87fa85fa6248cf41d6))

## [0.18.39](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.38...vsock-proto-v0.18.39) (2026-08-27)


### Refactoring

* **runner:** establish guest agent readiness ([#29748](https://github.com/vm0-ai/vm0/issues/29748)) ([8eaafa1](https://github.com/vm0-ai/vm0/commit/8eaafa13bc280f08033fded17e7c3fd5c9822804))

## [0.18.38](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.37...vsock-proto-v0.18.38) (2026-08-26)


### Refactoring

* **runner:** make guest process roles explicit ([#29679](https://github.com/vm0-ai/vm0/issues/29679)) ([fe5d663](https://github.com/vm0-ai/vm0/commit/fe5d663d192a9838dfdf4aecc2ffc8c7a22d24fa))

## [0.18.37](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.36...vsock-proto-v0.18.37) (2026-08-26)


### Performance Improvements

* **runner:** specialize guest state restore operation ([#29398](https://github.com/vm0-ai/vm0/issues/29398)) ([89521f7](https://github.com/vm0-ai/vm0/commit/89521f769af74c43034f04e5f7decc537ebff628))

## [0.18.36](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.35...vsock-proto-v0.18.36) (2026-08-25)


### Documentation

* **rust:** document encode_exec_result error conditions ([#29302](https://github.com/vm0-ai/vm0/issues/29302)) ([ce9c119](https://github.com/vm0-ai/vm0/commit/ce9c119be404e55d69db7b5613ee37ff8f0d1714))

## [0.18.35](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.34...vsock-proto-v0.18.35) (2026-08-24)


### Refactoring

* **rust:** centralize process termination codec ([#28973](https://github.com/vm0-ai/vm0/issues/28973)) ([6c15cd8](https://github.com/vm0-ai/vm0/commit/6c15cd8f5056d98f40d751cbe445840e4248445e))

## [0.18.34](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.33...vsock-proto-v0.18.34) (2026-08-24)


### Bug Fixes

* **rust:** make payload-too-large diagnostics unit-accurate ([#28806](https://github.com/vm0-ai/vm0/issues/28806)) ([d2c2ab3](https://github.com/vm0-ai/vm0/commit/d2c2ab316045c28a3b8726847c3b5c9a14831d09))

## [0.18.33](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.32...vsock-proto-v0.18.33) (2026-08-24)


### Performance Improvements

* **runner:** specialize guest storage manifest invocation ([#28734](https://github.com/vm0-ai/vm0/issues/28734)) ([0255e57](https://github.com/vm0-ai/vm0/commit/0255e57603d27fe97ac342c97af98921dabf2ae9))

## [0.18.32](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.31...vsock-proto-v0.18.32) (2026-08-21)


### Documentation

* **rust:** specify vsock frame buffer state on encode errors ([#28537](https://github.com/vm0-ai/vm0/issues/28537)) ([28b5965](https://github.com/vm0-ai/vm0/commit/28b596527eaff3854a5dd6c03fae3a9a5b6b5006))

## [0.18.31](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.30...vsock-proto-v0.18.31) (2026-08-21)


### Documentation

* **vsock-proto:** document decoder protocol-error recovery ([#28482](https://github.com/vm0-ai/vm0/issues/28482)) ([5a6748f](https://github.com/vm0-ai/vm0/commit/5a6748fa27000bd654cb00f06039d75f82d1201c))

## [0.18.30](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.29...vsock-proto-v0.18.30) (2026-08-14)


### Performance Improvements

* **runner:** reduce guest dns readiness latency ([#27184](https://github.com/vm0-ai/vm0/issues/27184)) ([0752a72](https://github.com/vm0-ai/vm0/commit/0752a72e452aedcf40cca5bb8d177a3850592d1e))

## [0.18.29](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.28...vsock-proto-v0.18.29) (2026-08-13)


### Documentation

* **rust:** document batch write result truncation ([#26901](https://github.com/vm0-ai/vm0/issues/26901)) ([f27b7f2](https://github.com/vm0-ai/vm0/commit/f27b7f22ef7e3bb51e4fe06d19473f2b76334558))

## [0.18.28](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.27...vsock-proto-v0.18.28) (2026-08-10)


### Bug Fixes

* **runner:** attribute severe balloon retention ([#26038](https://github.com/vm0-ai/vm0/issues/26038)) ([d996ab7](https://github.com/vm0-ai/vm0/commit/d996ab715ff06c03dee96b82f683e577c7e52b89))

## [0.18.27](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.26...vsock-proto-v0.18.27) (2026-08-10)


### Documentation

* **vsock-proto:** clarify message type invariants ([#26001](https://github.com/vm0-ai/vm0/issues/26001)) ([ecdb01a](https://github.com/vm0-ai/vm0/commit/ecdb01a6d8e8e9e7eac7bda3e96e76d5a4c6b21c))

## [0.18.26](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.25...vsock-proto-v0.18.26) (2026-08-07)


### Performance Improvements

* **rust:** eliminate exec-control payload copies ([#25608](https://github.com/vm0-ai/vm0/issues/25608)) ([3f71e3b](https://github.com/vm0-ai/vm0/commit/3f71e3b491c2fb66e3c964494565aa9a9bcd4166))

## [0.18.25](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.24...vsock-proto-v0.18.25) (2026-08-03)


### Performance Improvements

* **vsock:** encode exec results into one frame buffer ([#24754](https://github.com/vm0-ai/vm0/issues/24754)) ([eb7bd3a](https://github.com/vm0-ai/vm0/commit/eb7bd3a5947dc39748f96cd430f4283e2be1962e))

## [0.18.24](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.23...vsock-proto-v0.18.24) (2026-07-25)


### Refactoring

* **rust:** collapse exec-control codec layer ([#22988](https://github.com/vm0-ai/vm0/issues/22988)) ([a923713](https://github.com/vm0-ai/vm0/commit/a923713089a5b42abc3004a1c280320f58c91885))

## [0.18.23](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.22...vsock-proto-v0.18.23) (2026-07-20)


### Documentation

* **rust:** document write_files entry limit ([#22179](https://github.com/vm0-ai/vm0/issues/22179)) ([b5c5338](https://github.com/vm0-ai/vm0/commit/b5c53388fbf9c6addf37d9ace08c60047d5679d0))

## [0.18.22](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.21...vsock-proto-v0.18.22) (2026-07-16)


### Bug Fixes

* describe zero scrape capabilities in agent context ([#21574](https://github.com/vm0-ai/vm0/issues/21574)) ([5d5b298](https://github.com/vm0-ai/vm0/commit/5d5b298b1396f2e4c1ee6873d429987fcb9df4cc))

## [0.18.21](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.20...vsock-proto-v0.18.21) (2026-06-30)


### Performance Improvements

* reduce host write-file frame copies ([#19524](https://github.com/vm0-ai/vm0/issues/19524)) ([6f60605](https://github.com/vm0-ai/vm0/commit/6f6060531fe3b0d15a60f223b636edec310358ee))

## [0.18.20](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.19...vsock-proto-v0.18.20) (2026-06-30)


### Performance Improvements

* release oversized vsock decoder buffers ([#19519](https://github.com/vm0-ai/vm0/issues/19519)) ([3d78004](https://github.com/vm0-ai/vm0/commit/3d780043010943bf0946f11da2b32edafea9d6d8))

## [0.18.19](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.18...vsock-proto-v0.18.19) (2026-06-26)


### Performance Improvements

* batch storage cache warm-hit staging ([#19077](https://github.com/vm0-ai/vm0/issues/19077)) ([3f6743f](https://github.com/vm0-ai/vm0/commit/3f6743f9fd4a6c8fa0cdc5e6c1e50ef2042c924c))

## [0.18.18](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.17...vsock-proto-v0.18.18) (2026-06-26)


### Performance Improvements

* write exec stream chunks directly ([#19023](https://github.com/vm0-ai/vm0/issues/19023)) ([cc35233](https://github.com/vm0-ai/vm0/commit/cc3523354f8702d8fbfe47e9da77e7c2cd53e45f))

## [0.18.17](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.16...vsock-proto-v0.18.17) (2026-06-25)


### Bug Fixes

* harden guest runtime private file writes ([#18797](https://github.com/vm0-ai/vm0/issues/18797)) ([f334139](https://github.com/vm0-ai/vm0/commit/f334139eec67ff4bb64d2a47c3028505bd068cdd))

## [0.18.16](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.15...vsock-proto-v0.18.16) (2026-06-20)


### Documentation

* expand vsock exec wire schemas ([#18386](https://github.com/vm0-ai/vm0/issues/18386)) ([d296dea](https://github.com/vm0-ai/vm0/commit/d296deaedbf0f4f0408e631303b4ba3663e84cc3))

## [0.18.15](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.14...vsock-proto-v0.18.15) (2026-06-15)


### Documentation

* document vsock protocol public api ([#17668](https://github.com/vm0-ai/vm0/issues/17668)) ([4cf6102](https://github.com/vm0-ai/vm0/commit/4cf61029ab5193a70850100b54c39a98c8a87702))


### Refactoring

* split exec operation payload codec ([#17663](https://github.com/vm0-ai/vm0/issues/17663)) ([e311881](https://github.com/vm0-ai/vm0/commit/e311881c404c54770aa42d2bdd4a8d1dca8759e3))

## [0.18.14](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.13...vsock-proto-v0.18.14) (2026-06-11)


### Bug Fixes

* **vsock-guest:** reject zero-sequence write_file requests ([#17312](https://github.com/vm0-ai/vm0/issues/17312)) ([2a6e915](https://github.com/vm0-ai/vm0/commit/2a6e915de25051dbaec6e07fa6e996e96a608947))

## [0.18.13](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.12...vsock-proto-v0.18.13) (2026-06-11)


### Documentation

* clarify exec control payload rustdoc ([#17272](https://github.com/vm0-ai/vm0/issues/17272)) ([c45cd12](https://github.com/vm0-ai/vm0/commit/c45cd12d3770dc052c002ea1560f7c9f098f416e))

## [0.18.12](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.11...vsock-proto-v0.18.12) (2026-06-09)


### Bug Fixes

* **vsock-proto:** reject non-canonical legacy payloads ([#16789](https://github.com/vm0-ai/vm0/issues/16789)) ([d3ae83a](https://github.com/vm0-ai/vm0/commit/d3ae83ab251eb254768ef9d3d3ec65c3c04bc882))

## [0.18.11](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.10...vsock-proto-v0.18.11) (2026-06-07)


### Refactoring

* centralize exec operation test layouts ([#16409](https://github.com/vm0-ai/vm0/issues/16409)) ([dea53c0](https://github.com/vm0-ai/vm0/commit/dea53c0f77e93007c81d81509dd9b69433899bf1))


### Performance Improvements

* preallocate exec env vector while decoding ([#16401](https://github.com/vm0-ai/vm0/issues/16401)) ([34395f8](https://github.com/vm0-ai/vm0/commit/34395f8ca957e7e768cc8c26c12610db5a10584d))

## [0.18.10](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.9...vsock-proto-v0.18.10) (2026-06-04)


### Performance Improvements

* avoid exec output payload copy ([#16081](https://github.com/vm0-ai/vm0/issues/16081)) ([3611818](https://github.com/vm0-ai/vm0/commit/3611818fcd7d15583dde5113ace28918395858cb))

## [0.18.9](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.8...vsock-proto-v0.18.9) (2026-05-28)


### Refactoring

* share exec control identity codec helpers ([#15288](https://github.com/vm0-ai/vm0/issues/15288)) ([040e4eb](https://github.com/vm0-ai/vm0/commit/040e4eb3bfc19cd289a5866aec2f2dc1ceb48dc6))

## [0.18.8](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.7...vsock-proto-v0.18.8) (2026-05-27)


### Refactoring

* centralize exec output chunk validation ([#15050](https://github.com/vm0-ai/vm0/issues/15050)) ([171d55d](https://github.com/vm0-ai/vm0/commit/171d55d3cb7752e4ae37f87473e29322acbca78e))

## [0.18.7](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.6...vsock-proto-v0.18.7) (2026-05-25)


### Documentation

* **vsock-proto:** document exec control status api ([#14861](https://github.com/vm0-ai/vm0/issues/14861)) ([23a6640](https://github.com/vm0-ai/vm0/commit/23a66404f8c7cf6fc7db18b93441984773282498))

## [0.18.6](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.5...vsock-proto-v0.18.6) (2026-05-25)


### Bug Fixes

* pass guest reseed entropy over exec stdin ([#14758](https://github.com/vm0-ai/vm0/issues/14758)) ([6f9a4aa](https://github.com/vm0-ai/vm0/commit/6f9a4aac941effcad301911f5dfec055bb758667))

## [0.18.5](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.4...vsock-proto-v0.18.5) (2026-05-21)


### Refactoring

* **vsock-proto:** compact message type ids ([#14444](https://github.com/vm0-ai/vm0/issues/14444)) ([e04d036](https://github.com/vm0-ai/vm0/commit/e04d0367080afa277b770ede370449b6f2416e0e))
* **vsock-proto:** group message type ids ([#14460](https://github.com/vm0-ai/vm0/issues/14460)) ([45906ed](https://github.com/vm0-ai/vm0/commit/45906ed1d43839558e8721455c443dc747b22501))

## [0.18.4](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.3...vsock-proto-v0.18.4) (2026-05-21)


### Refactoring

* remove legacy spawn process protocol ([#14315](https://github.com/vm0-ai/vm0/issues/14315)) ([eecb69f](https://github.com/vm0-ai/vm0/commit/eecb69fbba0b5a16b0cd804698613303655dcb7e))

## [0.18.3](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.2...vsock-proto-v0.18.3) (2026-05-19)


### Refactoring

* upgrade exec start protocol schema ([#13841](https://github.com/vm0-ai/vm0/issues/13841)) ([6790751](https://github.com/vm0-ai/vm0/commit/67907514ba9f7372a4de7e0351cf5c724b997087))

## [0.18.2](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.1...vsock-proto-v0.18.2) (2026-05-19)


### Documentation

* document vsock protocol wire constants ([#13926](https://github.com/vm0-ai/vm0/issues/13926)) ([d232c21](https://github.com/vm0-ai/vm0/commit/d232c212ceb1e897dc44db641f69b75d775e6ea3))

## [0.18.1](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.0...vsock-proto-v0.18.1) (2026-05-18)


### Bug Fixes

* preserve utf-8 boundaries in vsock error payloads ([#13687](https://github.com/vm0-ai/vm0/issues/13687)) ([3af6a5d](https://github.com/vm0-ai/vm0/commit/3af6a5d481b411688fbc208adea1621517f3a8f7))


### Refactoring

* align process control timeout semantics ([#13598](https://github.com/vm0-ai/vm0/issues/13598)) ([9f56eae](https://github.com/vm0-ai/vm0/commit/9f56eae01348c91ec3df805d0a3c0566aacc9dbf))

## [0.18.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.17.0...vsock-proto-v0.18.0) (2026-05-17)


### Features

* wire operation-bound process control to guest-agent ([#13538](https://github.com/vm0-ai/vm0/issues/13538)) ([3bc2ee1](https://github.com/vm0-ai/vm0/commit/3bc2ee1dda51d68c6825a1a71bf44edbc9692a0d))

## [0.17.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.16.2...vsock-proto-v0.17.0) (2026-05-15)


### Features

* add spawn process control plane ([#13482](https://github.com/vm0-ai/vm0/issues/13482)) ([a315a3a](https://github.com/vm0-ai/vm0/commit/a315a3ac3cd61e5ed42e642eb88f44fb943631a1))

## [0.16.2](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.16.1...vsock-proto-v0.16.2) (2026-05-15)


### Refactoring

* rename vsock command operation ([#13465](https://github.com/vm0-ai/vm0/issues/13465)) ([bd1742b](https://github.com/vm0-ai/vm0/commit/bd1742b001bec3edf81cd5daf410294f722315e6))

## [0.16.1](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.16.0...vsock-proto-v0.16.1) (2026-05-15)


### Refactoring

* rename spawn watch to spawn process ([#13369](https://github.com/vm0-ai/vm0/issues/13369)) ([e007f30](https://github.com/vm0-ai/vm0/commit/e007f30a2610056a6905e4a38bcc2d894895ffa4))

## [0.16.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.15.6...vsock-proto-v0.16.0) (2026-05-14)


### Features

* add vsock operation quiesce protocol ([#13343](https://github.com/vm0-ai/vm0/issues/13343)) ([d1738c7](https://github.com/vm0-ai/vm0/commit/d1738c7d9665769411c2d99f4b3c116d6e132df9))

## [0.15.6](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.15.5...vsock-proto-v0.15.6) (2026-05-14)


### Documentation

* update command start wire format ([#13332](https://github.com/vm0-ai/vm0/issues/13332)) ([559963b](https://github.com/vm0-ai/vm0/commit/559963bd3c394a59af5f655e80085c7d2dddcf6c))

## [0.15.5](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.15.4...vsock-proto-v0.15.5) (2026-05-14)


### Bug Fixes

* suppress expected command exits ([#13270](https://github.com/vm0-ai/vm0/issues/13270)) ([2132288](https://github.com/vm0-ai/vm0/commit/213228850c442d9ba480acb31810a940687e572f))
* **vsock:** route spawn_watch lifecycle by sequence ([#13220](https://github.com/vm0-ai/vm0/issues/13220)) ([373d2ab](https://github.com/vm0-ai/vm0/commit/373d2ab0c2312e9f888c2d9780bcef71386f42cd))

## [0.15.4](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.15.3...vsock-proto-v0.15.4) (2026-05-14)


### Refactoring

* clean up vsock proto command tests ([#13204](https://github.com/vm0-ai/vm0/issues/13204)) ([1e231b5](https://github.com/vm0-ai/vm0/commit/1e231b588f90906c58e23b418c70311be27b3d7f))

## [0.15.3](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.15.2...vsock-proto-v0.15.3) (2026-05-13)


### Refactoring

* split remaining vsock payload modules ([#13183](https://github.com/vm0-ai/vm0/issues/13183)) ([16910fb](https://github.com/vm0-ai/vm0/commit/16910fbe2581e5d01cbd7d176096848636ac3166))
* **vsock-proto:** split command payload module ([#13175](https://github.com/vm0-ai/vm0/issues/13175)) ([6ae69ff](https://github.com/vm0-ai/vm0/commit/6ae69ff38bba443320c3949c631607a7f02a2465))

## [0.15.2](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.15.1...vsock-proto-v0.15.2) (2026-05-13)


### Refactoring

* split vsock-proto frame infrastructure ([#13169](https://github.com/vm0-ai/vm0/issues/13169)) ([df3e8e3](https://github.com/vm0-ai/vm0/commit/df3e8e3a439250225073c18ba5dedebc902d1369))

## [0.15.1](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.15.0...vsock-proto-v0.15.1) (2026-05-13)


### Refactoring

* compact vsock message types ([#13079](https://github.com/vm0-ai/vm0/issues/13079)) ([09ef60c](https://github.com/vm0-ai/vm0/commit/09ef60c6348d31adf94ab8e04a959a38f5b83ec9))
* remove legacy vsock exec protocol ([#13064](https://github.com/vm0-ai/vm0/issues/13064)) ([318c177](https://github.com/vm0-ai/vm0/commit/318c177b451a8f2f700fca02f6ee41f98beb751f))

## [0.15.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.14.0...vsock-proto-v0.15.0) (2026-05-12)


### Features

* **vsock-host:** add command operation router ([#12782](https://github.com/vm0-ai/vm0/issues/12782)) ([e1ad973](https://github.com/vm0-ai/vm0/commit/e1ad97343e41c441d3539de961f44c91bbad9309))

## [0.14.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.13.0...vsock-proto-v0.14.0) (2026-05-12)


### Features

* **vsock:** add command operation protocol surface ([#12707](https://github.com/vm0-ai/vm0/issues/12707)) ([67fff74](https://github.com/vm0-ai/vm0/commit/67fff74d52d5b2357c42a2888dcddc97c38b749d))

## [0.13.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.12.0...vsock-proto-v0.13.0) (2026-05-10)


### Features

* add host-initiated vsock control handshake ([#12543](https://github.com/vm0-ai/vm0/issues/12543)) ([de17089](https://github.com/vm0-ai/vm0/commit/de17089191b001b3ed6f33487b62a3360bf81174))


### Documentation

* document bounded exec preference ([#12599](https://github.com/vm0-ai/vm0/issues/12599)) ([70aa4eb](https://github.com/vm0-ai/vm0/commit/70aa4eb5444809dc49132cc003278eb2bd504a39))


### Refactoring

* **runner:** stream exec over bounded exec ([#12518](https://github.com/vm0-ai/vm0/issues/12518)) ([ee551da](https://github.com/vm0-ai/vm0/commit/ee551dabe2c464564a576580a9d8811453ffd08d))

## [0.12.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.11.0...vsock-proto-v0.12.0) (2026-05-09)


### Features

* add bounded exec output policies ([#12292](https://github.com/vm0-ai/vm0/issues/12292)) ([71f6ad9](https://github.com/vm0-ai/vm0/commit/71f6ad9aaadaa9bf6589a5915c51ab4c092547eb))

## [0.11.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.10.0...vsock-proto-v0.11.0) (2026-05-08)


### Features

* **vsock-guest:** implement bounded exec ([#12164](https://github.com/vm0-ai/vm0/issues/12164)) ([f2b85dd](https://github.com/vm0-ai/vm0/commit/f2b85dd4f73a0f4ba0032340b37e92857bd74e71))

## [0.10.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.9.7...vsock-proto-v0.10.0) (2026-05-08)


### Features

* **vsock:** add bounded exec protocol messages ([#12119](https://github.com/vm0-ai/vm0/issues/12119)) ([2050fb2](https://github.com/vm0-ai/vm0/commit/2050fb27348cbccfbdd8747b26772c907b55cbc8))

## [0.9.7](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.9.6...vsock-proto-v0.9.7) (2026-05-05)


### Refactoring

* **vsock-proto:** dedupe output payload codec ([#11809](https://github.com/vm0-ai/vm0/issues/11809)) ([03bc395](https://github.com/vm0-ai/vm0/commit/03bc395366e299ddb481f6c548d26be350453bf0))

## [0.9.6](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.9.5...vsock-proto-v0.9.6) (2026-05-03)


### Refactoring

* **vsock-proto:** carry exec flags through decode ([#11712](https://github.com/vm0-ai/vm0/issues/11712)) ([0518e37](https://github.com/vm0-ai/vm0/commit/0518e37c7f8f7def316abd857be74201d5c268ed))

## [0.9.5](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.9.4...vsock-proto-v0.9.5) (2026-05-03)


### Documentation

* **vsock-proto:** fix decode_exec return docs ([#11694](https://github.com/vm0-ai/vm0/issues/11694)) ([5ae7202](https://github.com/vm0-ai/vm0/commit/5ae7202333860b36f5c94fc03a7eff2caf8ab490))

## [0.9.4](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.9.3...vsock-proto-v0.9.4) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.9.3](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.9.2...vsock-proto-v0.9.3) (2026-04-27)


### Bug Fixes

* make guest-agent own system log writes ([#11238](https://github.com/vm0-ai/vm0/issues/11238)) ([5041a49](https://github.com/vm0-ai/vm0/commit/5041a49416701955915962bc13aed07e5618db3e))

## [0.9.2](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.9.1...vsock-proto-v0.9.2) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.9.1](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.9.0...vsock-proto-v0.9.1) (2026-04-17)


### Bug Fixes

* **vsock-proto:** avoid unbounded allocation from untrusted env_count ([#9764](https://github.com/vm0-ai/vm0/issues/9764)) ([b6a16fe](https://github.com/vm0-ai/vm0/commit/b6a16fe877217b74b5f361c6e27a6445cd814519))

## [0.9.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.8.0...vsock-proto-v0.9.0) (2026-04-14)


### Features

* **vsock:** chunked write_file with append flag for large files ([#9335](https://github.com/vm0-ai/vm0/issues/9335)) ([16f128d](https://github.com/vm0-ai/vm0/commit/16f128d5e28e43c869a9e4bcc8993b1637175f93))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.7.0...vsock-proto-v0.8.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.7.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.6.0...vsock-proto-v0.7.0) (2026-03-20)


### Features

* **vsock:** add real-time stdout streaming from guest to host ([#5574](https://github.com/vm0-ai/vm0/issues/5574)) ([2afc093](https://github.com/vm0-ai/vm0/commit/2afc0930657f6bbf1e1f4947383345d33de46819))

## [0.6.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.5.0...vsock-proto-v0.6.0) (2026-02-23)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)

## [0.5.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.4.0...vsock-proto-v0.5.0) (2026-02-23)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)

## [0.4.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.3.0...vsock-proto-v0.4.0) (2026-02-22)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)

## [0.3.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.2.0...vsock-proto-v0.3.0) (2026-02-22)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)

## [0.2.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.1.0...vsock-proto-v0.2.0) (2026-02-22)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)
