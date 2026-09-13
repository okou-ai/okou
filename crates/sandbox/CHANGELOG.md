# Changelog

## [0.22.6](https://github.com/vm0-ai/vm0/compare/sandbox-v0.22.5...sandbox-v0.22.6) (2026-09-12)


### Bug Fixes

* **ssh:** release guest park protection when rpc closes ([#33534](https://github.com/vm0-ai/vm0/issues/33534)) ([1fb21f7](https://github.com/vm0-ai/vm0/commit/1fb21f794131078cdfc87c970eaf7f2c5d9f1c6f))

## [0.22.5](https://github.com/vm0-ai/vm0/compare/sandbox-v0.22.4...sandbox-v0.22.5) (2026-09-10)


### Documentation

* **rust:** correct snapshot socket-id listener limits ([#33273](https://github.com/vm0-ai/vm0/issues/33273)) ([e36f6c7](https://github.com/vm0-ai/vm0/commit/e36f6c7cdba31e96ec284d1063286a14e05f9d37))

## [0.22.4](https://github.com/vm0-ai/vm0/compare/sandbox-v0.22.3...sandbox-v0.22.4) (2026-09-09)


### Refactoring

* finish vm0 residual brand cleanup ([#32891](https://github.com/vm0-ai/vm0/issues/32891)) ([0453123](https://github.com/vm0-ai/vm0/commit/04531239c7e796799f1dca20ab36f7af1d075f85))

## [0.22.3](https://github.com/vm0-ai/vm0/compare/sandbox-v0.22.2...sandbox-v0.22.3) (2026-09-09)


### Bug Fixes

* **runner:** classify recovered cooperative cancellation races ([#32812](https://github.com/vm0-ai/vm0/issues/32812)) ([4e6a603](https://github.com/vm0-ai/vm0/commit/4e6a603da4241cfcb81e6329c91df828696ce89f))
* **runner:** defer blank memory reclamation until agent readiness ([#32824](https://github.com/vm0-ai/vm0/issues/32824)) ([29040ac](https://github.com/vm0-ai/vm0/commit/29040ac3b52f14bfb415bc5eeb0adcb7383b17d5))

## [0.22.2](https://github.com/vm0-ai/vm0/compare/sandbox-v0.22.1...sandbox-v0.22.2) (2026-09-09)


### Bug Fixes

* **runner:** classify cancelled workspace promotion skips ([#32793](https://github.com/vm0-ai/vm0/issues/32793)) ([5b45464](https://github.com/vm0-ai/vm0/commit/5b4546424e912fee5831a284ea9a54ead5311c1b))
* **runner:** classify expected catalog prefetch timeouts ([#32791](https://github.com/vm0-ai/vm0/issues/32791)) ([b508e1b](https://github.com/vm0-ai/vm0/commit/b508e1b63883c0fb4519330ca0070e10e61e231e))

## [0.22.1](https://github.com/vm0-ai/vm0/compare/sandbox-v0.22.0...sandbox-v0.22.1) (2026-09-08)


### Bug Fixes

* **runner:** attribute guest dns readiness attempts ([#32697](https://github.com/vm0-ai/vm0/issues/32697)) ([7558632](https://github.com/vm0-ai/vm0/commit/7558632c0eea9bded6c831fdba33a76c369677aa)), closes [#32445](https://github.com/vm0-ai/vm0/issues/32445)


### Performance Improvements

* **runner:** attribute guest connection startup phases ([#32705](https://github.com/vm0-ai/vm0/issues/32705)) ([176ca98](https://github.com/vm0-ai/vm0/commit/176ca98235eee2d021f23448aef8158d51ecb43f))

## [0.22.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.21.2...sandbox-v0.22.0) (2026-09-08)


### Features

* **runner:** add bounded host-owned ssh execution ([#32526](https://github.com/vm0-ai/vm0/issues/32526)) ([7c84eb2](https://github.com/vm0-ai/vm0/commit/7c84eb254233ad62f4482f7213e1b297cc7e8692))

## [0.21.2](https://github.com/vm0-ai/vm0/compare/sandbox-v0.21.1...sandbox-v0.21.2) (2026-09-07)


### Bug Fixes

* **runner:** retire codex prefetch sandboxes after partial writes ([#32358](https://github.com/vm0-ai/vm0/issues/32358)) ([dd0454e](https://github.com/vm0-ai/vm0/commit/dd0454e8707ecb068cf839c76d04c315427d6783))

## [0.21.1](https://github.com/vm0-ai/vm0/compare/sandbox-v0.21.0...sandbox-v0.21.1) (2026-09-07)


### Bug Fixes

* **runner:** retire sandbox after prefetch start timeout ([#32308](https://github.com/vm0-ai/vm0/issues/32308)) ([984a47b](https://github.com/vm0-ai/vm0/commit/984a47b8744fea46ceb63c03d43fcd19970ef31d))


### Performance Improvements

* **runner:** streamline terminal idle finalization ([#32321](https://github.com/vm0-ai/vm0/issues/32321)) ([a49be00](https://github.com/vm0-ai/vm0/commit/a49be00e2242007a1510b464f994cf0b2157074f))

## [0.21.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.20.0...sandbox-v0.21.0) (2026-09-07)


### Features

* **rpc:** add generic guest-to-runner transport and sandbox fencing ([#32161](https://github.com/vm0-ai/vm0/issues/32161)) ([847d733](https://github.com/vm0-ai/vm0/commit/847d733315462a73b0aae20f992737b9df289bf9))

## [0.20.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.63...sandbox-v0.20.0) (2026-09-02)


### Features

* **runner:** isolate firecracker guests in weighted cgroups ([#31057](https://github.com/vm0-ai/vm0/issues/31057)) ([615235d](https://github.com/vm0-ai/vm0/commit/615235d8dd5475cdaafec5eead7209bb28ba18fc))

## [0.19.63](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.62...sandbox-v0.19.63) (2026-09-02)


### Performance Improvements

* **runner:** specialize fresh workspace mount lifecycle ([#30939](https://github.com/vm0-ai/vm0/issues/30939)) ([c3f783c](https://github.com/vm0-ai/vm0/commit/c3f783cd17c8e732c5bb3edfcd6e0fb867ea3bd7))

## [0.19.62](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.61...sandbox-v0.19.62) (2026-09-01)


### Performance Improvements

* **runner:** specialize reused codex cleanup lifecycle ([#30888](https://github.com/vm0-ai/vm0/issues/30888)) ([5941c94](https://github.com/vm0-ai/vm0/commit/5941c9474fb6f1389a6ca9d3c92e99a3af59b98a))

## [0.19.61](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.60...sandbox-v0.19.61) (2026-09-01)


### Performance Improvements

* **runner:** launch reuse identity verifier without shell ([#30644](https://github.com/vm0-ai/vm0/issues/30644)) ([3ea790e](https://github.com/vm0-ai/vm0/commit/3ea790e5a8bca85854debfe537a89a66c4520445))

## [0.19.60](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.59...sandbox-v0.19.60) (2026-08-29)


### Refactoring

* **runner:** finish vm-to-sandbox terminology cleanup ([#30171](https://github.com/vm0-ai/vm0/issues/30171)) ([22d9b2e](https://github.com/vm0-ai/vm0/commit/22d9b2ebfdb9f9d3910eb8b30f8d2679aaed3081))

## [0.19.59](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.58...sandbox-v0.19.59) (2026-08-28)


### Performance Improvements

* **runner:** launch guest agent without shell bootstrap ([#30153](https://github.com/vm0-ai/vm0/issues/30153)) ([b2409fe](https://github.com/vm0-ai/vm0/commit/b2409fed8caa794a4e7d604f7d4c64559a385737))

## [0.19.58](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.57...sandbox-v0.19.58) (2026-08-28)


### Bug Fixes

* **sandbox:** preserve process handle must-use diagnostics ([#30094](https://github.com/vm0-ai/vm0/issues/30094)) ([4db19fd](https://github.com/vm0-ai/vm0/commit/4db19fdc7ceffb7ddba056888c1851c82b2a09a6))

## [0.19.57](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.56...sandbox-v0.19.57) (2026-08-28)


### Performance Improvements

* **runner:** batch required private guest writes ([#29943](https://github.com/vm0-ai/vm0/issues/29943)) ([97414e6](https://github.com/vm0-ai/vm0/commit/97414e6c34b2241df1cbcf87fa85fa6248cf41d6))

## [0.19.56](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.55...sandbox-v0.19.56) (2026-08-27)


### Documentation

* **rust:** make SandboxId contract provider-neutral ([#29852](https://github.com/vm0-ai/vm0/issues/29852)) ([74114a7](https://github.com/vm0-ai/vm0/commit/74114a7a29b92fa61a47b378a27b43b07163e4ac))

## [0.19.55](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.54...sandbox-v0.19.55) (2026-08-27)


### Refactoring

* **runner:** establish guest agent readiness ([#29748](https://github.com/vm0-ai/vm0/issues/29748)) ([8eaafa1](https://github.com/vm0-ai/vm0/commit/8eaafa13bc280f08033fded17e7c3fd5c9822804))
* **rust:** avoid duplicating process stream capacity ([#29784](https://github.com/vm0-ai/vm0/issues/29784)) ([30918ec](https://github.com/vm0-ai/vm0/commit/30918ec96e76b1498fded4d16943fa6f005ae1bb))

## [0.19.54](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.53...sandbox-v0.19.54) (2026-08-26)


### Refactoring

* **runner:** make guest process roles explicit ([#29679](https://github.com/vm0-ai/vm0/issues/29679)) ([fe5d663](https://github.com/vm0-ai/vm0/commit/fe5d663d192a9838dfdf4aecc2ffc8c7a22d24fa))

## [0.19.53](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.52...sandbox-v0.19.53) (2026-08-26)


### Bug Fixes

* **vsock:** bound file write response waits ([#29455](https://github.com/vm0-ai/vm0/issues/29455)) ([f9d9692](https://github.com/vm0-ai/vm0/commit/f9d9692d06e8f9574d2888397e0ab38ec2adc029))

## [0.19.52](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.51...sandbox-v0.19.52) (2026-08-26)


### Performance Improvements

* **runner:** specialize guest state restore operation ([#29398](https://github.com/vm0-ai/vm0/issues/29398)) ([89521f7](https://github.com/vm0-ai/vm0/commit/89521f769af74c43034f04e5f7decc537ebff628))

## [0.19.51](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.50...sandbox-v0.19.51) (2026-08-24)


### Documentation

* **rust:** document SandboxControlError variant semantics ([#28869](https://github.com/vm0-ai/vm0/issues/28869)) ([6a8caef](https://github.com/vm0-ai/vm0/commit/6a8caefc2c9542161219300f309cc6f55ac8215a))

## [0.19.50](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.49...sandbox-v0.19.50) (2026-08-24)


### Performance Improvements

* **runner:** specialize guest storage manifest invocation ([#28734](https://github.com/vm0-ai/vm0/issues/28734)) ([0255e57](https://github.com/vm0-ai/vm0/commit/0255e57603d27fe97ac342c97af98921dabf2ae9))

## [0.19.49](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.48...sandbox-v0.19.49) (2026-08-20)


### Documentation

* **sandbox:** document firecracker snapshot id constraints ([#28325](https://github.com/vm0-ai/vm0/issues/28325)) ([3f5ff12](https://github.com/vm0-ai/vm0/commit/3f5ff12c79dd4702d50bcb1b6f761ae2631c94d2))

## [0.19.48](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.47...sandbox-v0.19.48) (2026-08-20)


### Refactoring

* **rust:** centralize process output validation ([#28277](https://github.com/vm0-ai/vm0/issues/28277)) ([8e6e25c](https://github.com/vm0-ai/vm0/commit/8e6e25c954c7b4a90d3ba9d9cca7eb87090581e9))

## [0.19.47](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.46...sandbox-v0.19.47) (2026-08-19)


### Performance Improvements

* **runner:** hand off finalizing sandboxes before idle compaction ([#28063](https://github.com/vm0-ai/vm0/issues/28063)) ([543aae3](https://github.com/vm0-ai/vm0/commit/543aae384b1d6311d0bcceef487ab37bea3f3147))

## [0.19.46](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.45...sandbox-v0.19.46) (2026-08-18)


### Performance Improvements

* **runner:** attribute workspace mount guest duration ([#28059](https://github.com/vm0-ai/vm0/issues/28059)) ([7b94559](https://github.com/vm0-ai/vm0/commit/7b94559e3942ebbcfb88e7d287b59cc777386977))

## [0.19.45](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.44...sandbox-v0.19.45) (2026-08-18)


### Documentation

* **rust:** document workspace seed image size contract ([#27969](https://github.com/vm0-ai/vm0/issues/27969)) ([8af4053](https://github.com/vm0-ai/vm0/commit/8af4053a44e7867c6a7110aa6ecade1d5f8f1ba8))

## [0.19.44](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.43...sandbox-v0.19.44) (2026-08-16)


### Performance Improvements

* **runner:** expose physical park substage telemetry ([#27561](https://github.com/vm0-ai/vm0/issues/27561)) ([98c8737](https://github.com/vm0-ai/vm0/commit/98c873732d2d71f0840561dfcb2931751c31a037))

## [0.19.43](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.42...sandbox-v0.19.43) (2026-08-10)


### Refactoring

* **runner:** preserve process-control outcomes ([#26178](https://github.com/vm0-ai/vm0/issues/26178)) ([23ccd10](https://github.com/vm0-ai/vm0/commit/23ccd10daa8552532ebc1a355c89087c2e72656b))

## [0.19.42](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.41...sandbox-v0.19.42) (2026-08-10)


### Bug Fixes

* **runner:** attribute severe balloon retention ([#26038](https://github.com/vm0-ai/vm0/issues/26038)) ([d996ab7](https://github.com/vm0-ai/vm0/commit/d996ab715ff06c03dee96b82f683e577c7e52b89))

## [0.19.41](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.40...sandbox-v0.19.41) (2026-08-10)


### Performance Improvements

* **rust:** restore 64 kib guest output drains ([#26006](https://github.com/vm0-ai/vm0/issues/26006)) ([a54ade4](https://github.com/vm0-ai/vm0/commit/a54ade4ad15ed3031cd0b6b9c33cd00999687fb0))

## [0.19.40](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.39...sandbox-v0.19.40) (2026-08-07)


### Performance Improvements

* **rust:** eliminate exec-control payload copies ([#25608](https://github.com/vm0-ai/vm0/issues/25608)) ([3f71e3b](https://github.com/vm0-ai/vm0/commit/3f71e3b491c2fb66e3c964494565aa9a9bcd4166))

## [0.19.39](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.38...sandbox-v0.19.39) (2026-08-06)


### Refactoring

* **runner:** remove resolved dns diagnostics ([#25426](https://github.com/vm0-ai/vm0/issues/25426)) ([a301c42](https://github.com/vm0-ai/vm0/commit/a301c42affa3da95dc3cec1b0c456acf16af2a5c))

## [0.19.38](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.37...sandbox-v0.19.38) (2026-08-05)


### Documentation

* **sandbox:** document remote exec timeout normalization ([#25214](https://github.com/vm0-ai/vm0/issues/25214)) ([6138e94](https://github.com/vm0-ai/vm0/commit/6138e94533b3a0d23ccb7fb040b9ff6621c0db29))

## [0.19.37](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.36...sandbox-v0.19.37) (2026-08-04)


### Performance Improvements

* measure pre-park successor handoff ([#24938](https://github.com/vm0-ai/vm0/issues/24938)) ([6e7c0aa](https://github.com/vm0-ai/vm0/commit/6e7c0aa73c51d7916efaa354f6ce1ba32b83090f))

## [0.19.36](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.35...sandbox-v0.19.36) (2026-08-04)


### Bug Fixes

* **runner:** guard run controls across sandbox reuse ([#24849](https://github.com/vm0-ai/vm0/issues/24849)) ([bb1d90c](https://github.com/vm0-ai/vm0/commit/bb1d90c15df373b43a8653dcd85f9a47e3fb6042))

## [0.19.35](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.34...sandbox-v0.19.35) (2026-08-03)


### Documentation

* **rust:** clarify read_file non-regular path semantics ([#24600](https://github.com/vm0-ai/vm0/issues/24600)) ([47d9046](https://github.com/vm0-ai/vm0/commit/47d90465e1ed8403d5855e514182b855a4204517))

## [0.19.34](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.33...sandbox-v0.19.34) (2026-07-31)


### Documentation

* **rust:** correct run and sandbox identity contract ([#24250](https://github.com/vm0-ai/vm0/issues/24250)) ([49ab7e5](https://github.com/vm0-ai/vm0/commit/49ab7e5c1ef9ba45957a68a159c7ad45cffddf47))

## [0.19.33](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.32...sandbox-v0.19.33) (2026-07-31)


### Documentation

* **sandbox:** clarify workspace seed ownership ([#24210](https://github.com/vm0-ai/vm0/issues/24210)) ([0c38adc](https://github.com/vm0-ai/vm0/commit/0c38adc08bbedcb7e18bb93f061df83446971b17))

## [0.19.32](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.31...sandbox-v0.19.32) (2026-07-27)


### Bug Fixes

* **runner:** trace guest dns through root netfilter ([#23311](https://github.com/vm0-ai/vm0/issues/23311)) ([ca05dd0](https://github.com/vm0-ai/vm0/commit/ca05dd0a296ac2b1634aceba5ca1a64adcbd601a))

## [0.19.31](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.30...sandbox-v0.19.31) (2026-07-27)


### Bug Fixes

* **runner:** distinguish dns readiness timeouts ([#23282](https://github.com/vm0-ai/vm0/issues/23282)) ([1593bf9](https://github.com/vm0-ai/vm0/commit/1593bf9ddbce0c4b022ed7d772b845bbcd86be1b))

## [0.19.30](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.29...sandbox-v0.19.30) (2026-07-23)


### Performance Improvements

* **runner:** preconnect one-shot nbd cow slots ([#22683](https://github.com/vm0-ai/vm0/issues/22683)) ([1d02f4a](https://github.com/vm0-ai/vm0/commit/1d02f4a9e5df3d981da9fbf99606bd10d31b1a16))

## [0.19.29](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.28...sandbox-v0.19.29) (2026-07-23)


### Performance Improvements

* **runner:** move reused mount validation to idle admission ([#22610](https://github.com/vm0-ai/vm0/issues/22610)) ([710f9da](https://github.com/vm0-ai/vm0/commit/710f9da64fbb6d86a1588df02da2077dfb7c938a))

## [0.19.28](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.27...sandbox-v0.19.28) (2026-07-22)


### Performance Improvements

* **runner:** attribute sandbox start phases ([#22523](https://github.com/vm0-ai/vm0/issues/22523)) ([cd8f6a4](https://github.com/vm0-ai/vm0/commit/cd8f6a40c109d7b04bd991067fdf2b5ad1c77ca8))

## [0.19.27](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.26...sandbox-v0.19.27) (2026-07-19)


### Bug Fixes

* **sandbox:** align copy file publication contract ([#22120](https://github.com/vm0-ai/vm0/issues/22120)) ([715edec](https://github.com/vm0-ai/vm0/commit/715edecda445be930c12c5e5c54e053752dc0ebf))

## [0.19.26](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.25...sandbox-v0.19.26) (2026-07-16)


### Bug Fixes

* **runner:** classify oversized sidecars as unavailable ([#21877](https://github.com/vm0-ai/vm0/issues/21877)) ([d9fde61](https://github.com/vm0-ai/vm0/commit/d9fde61a0cce1579c4cf841e3e721aaf016eb537))
* **runner:** recover from guest dns readiness failures ([#21879](https://github.com/vm0-ai/vm0/issues/21879)) ([38a6647](https://github.com/vm0-ai/vm0/commit/38a664712e595a88a482df90ef8012f976c3f128))
* **runner:** reject severe balloon retention from idle reuse ([#21878](https://github.com/vm0-ai/vm0/issues/21878)) ([069b871](https://github.com/vm0-ai/vm0/commit/069b8713f5a9f073ab97671b92e71bd4574faeca))

## [0.19.25](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.24...sandbox-v0.19.25) (2026-07-16)


### Bug Fixes

* describe zero scrape capabilities in agent context ([#21574](https://github.com/vm0-ai/vm0/issues/21574)) ([5d5b298](https://github.com/vm0-ai/vm0/commit/5d5b298b1396f2e4c1ee6873d429987fcb9df4cc))

## [0.19.24](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.23...sandbox-v0.19.24) (2026-07-15)


### Bug Fixes

* **runner:** gate namespace pooling on dns readiness ([#21297](https://github.com/vm0-ai/vm0/issues/21297)) ([438da71](https://github.com/vm0-ai/vm0/commit/438da712d55f28ec1aa9134a792b3f43a8dc1a59))
* **sandbox-mock:** align write input semantics ([#21630](https://github.com/vm0-ai/vm0/issues/21630)) ([cb7590b](https://github.com/vm0-ai/vm0/commit/cb7590bf9e3fe690f083e6927d160371f02cbfb8))


### Documentation

* **rust:** define create observer semantics ([#21590](https://github.com/vm0-ai/vm0/issues/21590)) ([14199e1](https://github.com/vm0-ai/vm0/commit/14199e11ee1e8241fd832d1a0214949628cf1f3a))
* **sandbox:** document process supervision handles ([#21427](https://github.com/vm0-ai/vm0/issues/21427)) ([2e1f81f](https://github.com/vm0-ai/vm0/commit/2e1f81ffedebdcc6c08c92d291611f2b4e554300))


### Performance Improvements

* attribute nbd netlink connect latency ([#21121](https://github.com/vm0-ai/vm0/issues/21121)) ([7ff85a6](https://github.com/vm0-ai/vm0/commit/7ff85a6d10e757e24534f5f9a00a1cab1342eb4d))
* **runner:** attribute nbd cow creation latency ([#21065](https://github.com/vm0-ai/vm0/issues/21065)) ([7d97c9a](https://github.com/vm0-ai/vm0/commit/7d97c9a0e83e09645f97675c2594fad08b54bfc7))

## [0.19.23](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.22...sandbox-v0.19.23) (2026-07-15)


### Bug Fixes

* **sandbox-mock:** align write input semantics ([#21630](https://github.com/vm0-ai/vm0/issues/21630)) ([cb7590b](https://github.com/vm0-ai/vm0/commit/cb7590bf9e3fe690f083e6927d160371f02cbfb8))

## [0.19.22](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.21...sandbox-v0.19.22) (2026-07-15)


### Documentation

* **rust:** define create observer semantics ([#21590](https://github.com/vm0-ai/vm0/issues/21590)) ([14199e1](https://github.com/vm0-ai/vm0/commit/14199e11ee1e8241fd832d1a0214949628cf1f3a))

## [0.19.21](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.20...sandbox-v0.19.21) (2026-07-14)


### Documentation

* **sandbox:** document process supervision handles ([#21427](https://github.com/vm0-ai/vm0/issues/21427)) ([2e1f81f](https://github.com/vm0-ai/vm0/commit/2e1f81ffedebdcc6c08c92d291611f2b4e554300))

## [0.19.20](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.19...sandbox-v0.19.20) (2026-07-14)


### Bug Fixes

* **runner:** gate namespace pooling on dns readiness ([#21297](https://github.com/vm0-ai/vm0/issues/21297)) ([438da71](https://github.com/vm0-ai/vm0/commit/438da712d55f28ec1aa9134a792b3f43a8dc1a59))

## [0.19.19](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.18...sandbox-v0.19.19) (2026-07-12)


### Performance Improvements

* attribute nbd netlink connect latency ([#21121](https://github.com/vm0-ai/vm0/issues/21121)) ([7ff85a6](https://github.com/vm0-ai/vm0/commit/7ff85a6d10e757e24534f5f9a00a1cab1342eb4d))

## [0.19.18](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.17...sandbox-v0.19.18) (2026-07-11)


### Performance Improvements

* **runner:** attribute nbd cow creation latency ([#21065](https://github.com/vm0-ai/vm0/issues/21065)) ([7d97c9a](https://github.com/vm0-ai/vm0/commit/7d97c9a0e83e09645f97675c2594fad08b54bfc7))

## [0.19.17](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.16...sandbox-v0.19.17) (2026-07-09)


### Documentation

* remove duplicate sandbox lifecycle docs ([#20793](https://github.com/vm0-ai/vm0/issues/20793)) ([8453218](https://github.com/vm0-ai/vm0/commit/84532189b6c375752982738f0287548ebdb27505))

## [0.19.16](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.15...sandbox-v0.19.16) (2026-07-08)


### Performance Improvements

* add fresh sandbox factory stage telemetry ([#20689](https://github.com/vm0-ai/vm0/issues/20689)) ([d33d7cb](https://github.com/vm0-ai/vm0/commit/d33d7cb235410c3080092de8ee2117d081b19308))

## [0.19.15](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.14...sandbox-v0.19.15) (2026-07-06)


### Refactoring

* clarify sandbox process pid naming ([#20372](https://github.com/vm0-ai/vm0/issues/20372)) ([c32d846](https://github.com/vm0-ai/vm0/commit/c32d846f655bd32dea0fde2a561a34eb014128dd))

## [0.19.14](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.13...sandbox-v0.19.14) (2026-06-26)


### Performance Improvements

* batch storage cache warm-hit staging ([#19077](https://github.com/vm0-ai/vm0/issues/19077)) ([3f6743f](https://github.com/vm0-ai/vm0/commit/3f6743f9fd4a6c8fa0cdc5e6c1e50ef2042c924c))

## [0.19.13](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.12...sandbox-v0.19.13) (2026-06-26)


### Bug Fixes

* add agent exit 126 diagnostics ([#19032](https://github.com/vm0-ai/vm0/issues/19032)) ([b894039](https://github.com/vm0-ai/vm0/commit/b894039c617722da0ab4a9dd1fa2f188e552c7c7))

## [0.19.12](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.11...sandbox-v0.19.12) (2026-06-25)


### Bug Fixes

* harden guest runtime private file writes ([#18797](https://github.com/vm0-ai/vm0/issues/18797)) ([f334139](https://github.com/vm0-ai/vm0/commit/f334139eec67ff4bb64d2a47c3028505bd068cdd))

## [0.19.11](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.10...sandbox-v0.19.11) (2026-06-23)


### Bug Fixes

* make slow exec terminal warnings actionable ([#18619](https://github.com/vm0-ai/vm0/issues/18619)) ([ab0ce71](https://github.com/vm0-ai/vm0/commit/ab0ce71380d416da28156f15e80def1a24dd3bef))

## [0.19.10](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.9...sandbox-v0.19.10) (2026-06-22)


### Refactoring

* remove legacy exec result projections ([#18429](https://github.com/vm0-ai/vm0/issues/18429)) ([19b22fb](https://github.com/vm0-ai/vm0/commit/19b22fbde865689860394e2e9e9f699347f633b3))

## [0.19.9](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.8...sandbox-v0.19.9) (2026-06-21)


### Refactoring

* expose structured remote exec termination ([#18382](https://github.com/vm0-ai/vm0/issues/18382)) ([7f1dfa6](https://github.com/vm0-ai/vm0/commit/7f1dfa6f58379465d770d0fcf0c43fc7e91d9473))

## [0.19.8](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.7...sandbox-v0.19.8) (2026-06-19)


### Bug Fixes

* restrict runner dnsmasq listener ([#18292](https://github.com/vm0-ai/vm0/issues/18292)) ([dacb3fb](https://github.com/vm0-ai/vm0/commit/dacb3fb70df2812c3e2e790e01f588c8f8f8a4f0))

## [0.19.7](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.6...sandbox-v0.19.7) (2026-06-18)


### Refactoring

* carry sandbox exec termination state ([#18252](https://github.com/vm0-ai/vm0/issues/18252)) ([85f17cb](https://github.com/vm0-ai/vm0/commit/85f17cb86af25411fabf798f4c2e061a2c04b9c6))

## [0.19.6](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.5...sandbox-v0.19.6) (2026-06-17)


### Bug Fixes

* **runner:** validate benchmark env keys before startup ([#17999](https://github.com/vm0-ai/vm0/issues/17999)) ([4e6b823](https://github.com/vm0-ai/vm0/commit/4e6b823eba479c95cc7dbc8e377621f99b7ea5bf))

## [0.19.5](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.4...sandbox-v0.19.5) (2026-06-17)


### Documentation

* document sandbox factory contract ([#17997](https://github.com/vm0-ai/vm0/issues/17997)) ([a0623cc](https://github.com/vm0-ai/vm0/commit/a0623cce1bbbbfd4ff37205c51e3167f87e3781e))

## [0.19.4](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.3...sandbox-v0.19.4) (2026-06-15)


### Performance Improvements

* **runner:** move workspace cache hits into sandboxes ([#17629](https://github.com/vm0-ai/vm0/issues/17629)) ([3ec0448](https://github.com/vm0-ai/vm0/commit/3ec04481481f46589b219dfbf08d80555e86ed95))

## [0.19.3](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.2...sandbox-v0.19.3) (2026-06-09)


### Bug Fixes

* clarify runner job timeout logs ([#16823](https://github.com/vm0-ai/vm0/issues/16823)) ([77edf47](https://github.com/vm0-ai/vm0/commit/77edf47a4f3c43978ea9339209d370061ec3f474))


### Documentation

* document copy file semantics ([#16788](https://github.com/vm0-ai/vm0/issues/16788)) ([57223b3](https://github.com/vm0-ai/vm0/commit/57223b35d45d50b088ac6b35d1c69d59e3c39a1a))

## [0.19.2](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.1...sandbox-v0.19.2) (2026-06-07)


### Bug Fixes

* prevent runner kill from signaling reused pids ([#16296](https://github.com/vm0-ai/vm0/issues/16296)) ([5b6c483](https://github.com/vm0-ai/vm0/commit/5b6c48301845c9267a7437b63014fcd6d75bc331))


### Documentation

* document snapshot publish cleanup semantics ([#16419](https://github.com/vm0-ai/vm0/issues/16419)) ([a0e1cf3](https://github.com/vm0-ai/vm0/commit/a0e1cf3e4f95ac6b6221728ce2c6f6fe52e9ddcd))

## [0.19.1](https://github.com/vm0-ai/vm0/compare/sandbox-v0.19.0...sandbox-v0.19.1) (2026-06-03)


### Documentation

* document sandbox process api ([#15955](https://github.com/vm0-ai/vm0/issues/15955)) ([b61bad2](https://github.com/vm0-ai/vm0/commit/b61bad225f549a42e49d2f1e6e28252eca7f300f))

## [0.19.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.18.0...sandbox-v0.19.0) (2026-06-02)


### Features

* add session workspace image cache rollout ([#15780](https://github.com/vm0-ai/vm0/issues/15780)) ([3fb331b](https://github.com/vm0-ai/vm0/commit/3fb331ba6457c9d3247e0eac03f2629ab5102d89))

## [0.18.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.17.5...sandbox-v0.18.0) (2026-06-01)


### Features

* add canonical workspace drive foundation ([#15688](https://github.com/vm0-ai/vm0/issues/15688)) ([593460a](https://github.com/vm0-ai/vm0/commit/593460ab818768ae75d1fd658a7211a2120a956b))

## [0.17.5](https://github.com/vm0-ai/vm0/compare/sandbox-v0.17.4...sandbox-v0.17.5) (2026-05-28)


### Bug Fixes

* label sandbox file operation errors ([#15303](https://github.com/vm0-ai/vm0/issues/15303)) ([dbc2ec3](https://github.com/vm0-ai/vm0/commit/dbc2ec33f982d1413f93307e933a1b48268a65a4))

## [0.17.4](https://github.com/vm0-ai/vm0/compare/sandbox-v0.17.3...sandbox-v0.17.4) (2026-05-25)


### Bug Fixes

* pass guest reseed entropy over exec stdin ([#14758](https://github.com/vm0-ai/vm0/issues/14758)) ([6f9a4aa](https://github.com/vm0-ai/vm0/commit/6f9a4aac941effcad301911f5dfec055bb758667))

## [0.17.3](https://github.com/vm0-ai/vm0/compare/sandbox-v0.17.2...sandbox-v0.17.3) (2026-05-22)


### Bug Fixes

* cancel guest process before runner cleanup ([#14537](https://github.com/vm0-ai/vm0/issues/14537)) ([55b3ab7](https://github.com/vm0-ai/vm0/commit/55b3ab78eb113e7665c6d097f5e2fdbef8b30193))

## [0.17.2](https://github.com/vm0-ai/vm0/compare/sandbox-v0.17.1...sandbox-v0.17.2) (2026-05-21)


### Refactoring

* remove legacy spawn process protocol ([#14315](https://github.com/vm0-ai/vm0/issues/14315)) ([eecb69f](https://github.com/vm0-ai/vm0/commit/eecb69fbba0b5a16b0cd804698613303655dcb7e))

## [0.17.1](https://github.com/vm0-ai/vm0/compare/sandbox-v0.17.0...sandbox-v0.17.1) (2026-05-20)


### Refactoring

* migrate sandbox runner processes to supervised exec ([#14231](https://github.com/vm0-ai/vm0/issues/14231)) ([7781715](https://github.com/vm0-ai/vm0/commit/77817154bd0b4aad08d58fc6f41dc2643f07c76c))

## [0.17.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.16.1...sandbox-v0.17.0) (2026-05-20)


### Features

* **runner:** add firecracker io limiters ([#13585](https://github.com/vm0-ai/vm0/issues/13585)) ([653b854](https://github.com/vm0-ai/vm0/commit/653b854613580861d503848a3eeffff98fe75095))

## [0.16.1](https://github.com/vm0-ai/vm0/compare/sandbox-v0.16.0...sandbox-v0.16.1) (2026-05-19)


### Refactoring

* gate process control requests ([#13845](https://github.com/vm0-ai/vm0/issues/13845)) ([9dc1d33](https://github.com/vm0-ai/vm0/commit/9dc1d33ddb9fb1e2d479c574ebf85afd61cb45b8))

## [0.16.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.15.1...sandbox-v0.16.0) (2026-05-17)


### Features

* wire operation-bound process control to guest-agent ([#13538](https://github.com/vm0-ai/vm0/issues/13538)) ([3bc2ee1](https://github.com/vm0-ai/vm0/commit/3bc2ee1dda51d68c6825a1a71bf44edbc9692a0d))

## [0.15.1](https://github.com/vm0-ai/vm0/compare/sandbox-v0.15.0...sandbox-v0.15.1) (2026-05-15)


### Refactoring

* rename spawn watch to spawn process ([#13369](https://github.com/vm0-ai/vm0/issues/13369)) ([e007f30](https://github.com/vm0-ai/vm0/commit/e007f30a2610056a6905e4a38bcc2d894895ffa4))

## [0.15.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.14.4...sandbox-v0.15.0) (2026-05-15)


### Features

* gate sandbox park with ReadyForPark ([#13346](https://github.com/vm0-ai/vm0/issues/13346)) ([dd87143](https://github.com/vm0-ai/vm0/commit/dd87143a9b2955ff93820b5efa3d32d01f857f63))

## [0.14.4](https://github.com/vm0-ai/vm0/compare/sandbox-v0.14.3...sandbox-v0.14.4) (2026-05-14)


### Documentation

* document sandbox creation config ([#13290](https://github.com/vm0-ai/vm0/issues/13290)) ([89076cb](https://github.com/vm0-ai/vm0/commit/89076cbedd1cc61df4d410bf9d1f63a93a50c234))


### Refactoring

* type factory lifecycle resources ([#13293](https://github.com/vm0-ai/vm0/issues/13293)) ([0b533c7](https://github.com/vm0-ai/vm0/commit/0b533c76f86e651b09d662cb9c85a8c3a3d06ad5))

## [0.14.3](https://github.com/vm0-ai/vm0/compare/sandbox-v0.14.2...sandbox-v0.14.3) (2026-05-14)


### Bug Fixes

* **vsock:** route spawn_watch lifecycle by sequence ([#13220](https://github.com/vm0-ai/vm0/issues/13220)) ([373d2ab](https://github.com/vm0-ai/vm0/commit/373d2ab0c2312e9f888c2d9780bcef71386f42cd))

## [0.14.2](https://github.com/vm0-ai/vm0/compare/sandbox-v0.14.1...sandbox-v0.14.2) (2026-05-13)


### Refactoring

* route sandbox exec through command operations ([#13018](https://github.com/vm0-ai/vm0/issues/13018)) ([0e5f862](https://github.com/vm0-ai/vm0/commit/0e5f862ee8e2182e23a88df6187f194171004b1f))

## [0.14.1](https://github.com/vm0-ai/vm0/compare/sandbox-v0.14.0...sandbox-v0.14.1) (2026-05-10)


### Documentation

* document bounded exec preference ([#12599](https://github.com/vm0-ai/vm0/issues/12599)) ([70aa4eb](https://github.com/vm0-ai/vm0/commit/70aa4eb5444809dc49132cc003278eb2bd504a39))


### Refactoring

* **runner:** stream exec over bounded exec ([#12518](https://github.com/vm0-ai/vm0/issues/12518)) ([ee551da](https://github.com/vm0-ai/vm0/commit/ee551dabe2c464564a576580a9d8811453ffd08d))

## [0.14.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.13.0...sandbox-v0.14.0) (2026-05-09)


### Features

* add bounded exec output policies ([#12292](https://github.com/vm0-ai/vm0/issues/12292)) ([71f6ad9](https://github.com/vm0-ai/vm0/commit/71f6ad9aaadaa9bf6589a5915c51ab4c092547eb))

## [0.13.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.15...sandbox-v0.13.0) (2026-05-08)


### Features

* **sandbox:** wire bounded exec through host and firecracker sandbox ([#12203](https://github.com/vm0-ai/vm0/issues/12203)) ([71602f2](https://github.com/vm0-ai/vm0/commit/71602f22f27413438b63fb6f830b1653497189b1))

## [0.12.15](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.14...sandbox-v0.12.15) (2026-05-08)


### Performance Improvements

* add guest write-file helper ([#12136](https://github.com/vm0-ai/vm0/issues/12136)) ([8795398](https://github.com/vm0-ai/vm0/commit/8795398ddd54bb6f7e4cade4c1d3a67a11bebd1b))

## [0.12.14](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.13...sandbox-v0.12.14) (2026-05-07)


### Refactoring

* **runner:** split snapshot publish boundary ([#12044](https://github.com/vm0-ai/vm0/issues/12044)) ([b01e205](https://github.com/vm0-ai/vm0/commit/b01e205e530cb9a6ed5353294077d9a80b70da62))

## [0.12.13](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.12...sandbox-v0.12.13) (2026-05-07)


### Documentation

* **sandbox:** add crate-level docs ([#12011](https://github.com/vm0-ai/vm0/issues/12011)) ([cdbb13d](https://github.com/vm0-ai/vm0/commit/cdbb13d1b68b4f3f8ae5b63c6e1166e6bc0f8f65))

## [0.12.12](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.11...sandbox-v0.12.12) (2026-05-06)


### Bug Fixes

* **sandbox-fc:** require snapshot publish marker ([#11867](https://github.com/vm0-ai/vm0/issues/11867)) ([023ae4d](https://github.com/vm0-ai/vm0/commit/023ae4d86570157504a176372727cab05f5b1483))

## [0.12.11](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.10...sandbox-v0.12.11) (2026-05-05)


### Documentation

* **sandbox:** document runtime module ([#11804](https://github.com/vm0-ai/vm0/issues/11804)) ([b20407e](https://github.com/vm0-ai/vm0/commit/b20407e748feb70cb0a1fc2f7eecd1071d881bc4))

## [0.12.10](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.9...sandbox-v0.12.10) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.12.9](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.8...sandbox-v0.12.9) (2026-04-29)


### Documentation

* **sandbox-fc:** document snapshot error variants ([#11535](https://github.com/vm0-ai/vm0/issues/11535)) ([f9d5625](https://github.com/vm0-ai/vm0/commit/f9d5625227abb29245b0048e4052d9a6f7592157))

## [0.12.8](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.7...sandbox-v0.12.8) (2026-04-29)


### Bug Fixes

* **runner:** clean up outer job panic bookkeeping ([#11393](https://github.com/vm0-ai/vm0/issues/11393)) ([4ecf0b6](https://github.com/vm0-ai/vm0/commit/4ecf0b65e25c66a86eec0151a29dd4f0fa0deeb0))

## [0.12.7](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.6...sandbox-v0.12.7) (2026-04-27)


### Bug Fixes

* make guest-agent own system log writes ([#11238](https://github.com/vm0-ai/vm0/issues/11238)) ([5041a49](https://github.com/vm0-ai/vm0/commit/5041a49416701955915962bc13aed07e5618db3e))

## [0.12.6](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.5...sandbox-v0.12.6) (2026-04-27)


### Refactoring

* **sandbox:** clarify error taxonomy ([#11178](https://github.com/vm0-ai/vm0/issues/11178)) ([f766059](https://github.com/vm0-ai/vm0/commit/f7660591f6866336a78803225653fd738667c036))

## [0.12.5](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.4...sandbox-v0.12.5) (2026-04-26)


### Documentation

* **sandbox:** document runtime provider contract ([#11163](https://github.com/vm0-ai/vm0/issues/11163)) ([276de81](https://github.com/vm0-ai/vm0/commit/276de8114fa99e2cf3247a6fe5b803bdf73d5028))
* **sandbox:** document sandbox error taxonomy ([#11171](https://github.com/vm0-ai/vm0/issues/11171)) ([ebbca10](https://github.com/vm0-ai/vm0/commit/ebbca104243dc628bef3f701af6dbd1a321c4baa))

## [0.12.4](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.3...sandbox-v0.12.4) (2026-04-23)


### Documentation

* document sandbox trait surface (closes [#10774](https://github.com/vm0-ai/vm0/issues/10774)) ([#10804](https://github.com/vm0-ai/vm0/issues/10804)) ([5d3db1d](https://github.com/vm0-ai/vm0/commit/5d3db1d17be27b239f6baac1d65fed7c5cc43753))

## [0.12.3](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.2...sandbox-v0.12.3) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.12.2](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.1...sandbox-v0.12.2) (2026-04-18)


### Bug Fixes

* **sandbox-fc:** fail snapshot when destroy_keep_cow retries exhaust ([#9870](https://github.com/vm0-ai/vm0/issues/9870)) ([c0c4120](https://github.com/vm0-ai/vm0/commit/c0c41201de5362b982295b498476bcfbffe5bebc))

## [0.12.1](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.0...sandbox-v0.12.1) (2026-04-16)


### Refactoring

* **runner:** make sandbox_id a first-class identity distinct from run_id ([#9555](https://github.com/vm0-ai/vm0/issues/9555)) ([9cfd2a8](https://github.com/vm0-ai/vm0/commit/9cfd2a8d239f1c54c3c8e25c9adb2759d9b12efa))

## [0.12.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.11.0...sandbox-v0.12.0) (2026-04-14)


### Features

* **sandbox-fc:** pause vcpus while sandbox is parked in idle pool ([#9306](https://github.com/vm0-ai/vm0/issues/9306)) ([b7f322e](https://github.com/vm0-ai/vm0/commit/b7f322e247cddb12a061c8639f64efa0fb81f619))

## [0.11.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.10.0...sandbox-v0.11.0) (2026-04-13)


### Features

* **runner:** inflate sandbox balloon when parked in idle pool ([#9118](https://github.com/vm0-ai/vm0/issues/9118)) ([628032d](https://github.com/vm0-ai/vm0/commit/628032dbf3543d3387b6559263c31ee273f24986))

## [0.10.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.9.0...sandbox-v0.10.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.9.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.8.2...sandbox-v0.9.0) (2026-04-03)


### Features

* add dns proxy for sandbox vms using dnsmasq ([#8020](https://github.com/vm0-ai/vm0/issues/8020)) ([5699f8d](https://github.com/vm0-ai/vm0/commit/5699f8dbb9008422dfe1753a2b127a6f9c100f59))

## [0.8.2](https://github.com/vm0-ai/vm0/compare/sandbox-v0.8.1...sandbox-v0.8.2) (2026-03-30)


### Refactoring

* **sandbox:** introduce runtime provider trait and consolidate sandbox-fc construction ([#7173](https://github.com/vm0-ai/vm0/issues/7173)) ([6cb7c3c](https://github.com/vm0-ai/vm0/commit/6cb7c3c8ed57b4d7eb949986046d68226dc0672a)), closes [#7119](https://github.com/vm0-ai/vm0/issues/7119)

## [0.8.1](https://github.com/vm0-ai/vm0/compare/sandbox-v0.8.0...sandbox-v0.8.1) (2026-03-30)


### Refactoring

* **sandbox:** introduce sandbox control trait and decouple exec/kill from sandbox-fc ([#7150](https://github.com/vm0-ai/vm0/issues/7150)) ([4615d15](https://github.com/vm0-ai/vm0/commit/4615d1571c6dbc2ba249070654112d390e83a395)), closes [#7122](https://github.com/vm0-ai/vm0/issues/7122)
* **sandbox:** introduce sandbox runtime trait and internalize shared resources ([#7125](https://github.com/vm0-ai/vm0/issues/7125)) ([43a2ba0](https://github.com/vm0-ai/vm0/commit/43a2ba0d6ee9df1022e6238913597dd4d1c11e2a))
* **sandbox:** introduce snapshot provider trait and decouple snapshot operations ([#7142](https://github.com/vm0-ai/vm0/issues/7142)) ([9a864bf](https://github.com/vm0-ai/vm0/commit/9a864bfd4ec551ead8115f4fdb30df7c5570b5fe))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.7.0...sandbox-v0.8.0) (2026-03-25)


### Features

* **runner:** detect host-side cgroup oom kill of firecracker process ([#6630](https://github.com/vm0-ai/vm0/issues/6630)) ([34fa116](https://github.com/vm0-ai/vm0/commit/34fa11698b8e1c83f2cb93d82e281c099d114a49))

## [0.7.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.6.1...sandbox-v0.7.0) (2026-03-20)


### Features

* **vsock:** add real-time stdout streaming from guest to host ([#5574](https://github.com/vm0-ai/vm0/issues/5574)) ([2afc093](https://github.com/vm0-ai/vm0/commit/2afc0930657f6bbf1e1f4947383345d33de46819))

## [0.6.1](https://github.com/vm0-ai/vm0/compare/sandbox-v0.6.0...sandbox-v0.6.1) (2026-03-19)


### Refactoring

* **sandbox:** remove dead use_proxy field from sandbox config ([#5483](https://github.com/vm0-ai/vm0/issues/5483)) ([97c8db8](https://github.com/vm0-ai/vm0/commit/97c8db89235175ba41f45817413b671c3d39fe3e)), closes [#5481](https://github.com/vm0-ai/vm0/issues/5481)

## [0.6.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.5.0...sandbox-v0.6.0) (2026-02-23)


### Features

* **crates:** add sandbox crate with core traits and types ([#2527](https://github.com/vm0-ai/vm0/issues/2527)) ([a7571b4](https://github.com/vm0-ai/vm0/commit/a7571b4ae61b41825eee3b73a59cc2d4f1f6ecb0))
* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.4.0...sandbox-v0.5.0) (2026-02-23)


### Features

* **crates:** add sandbox crate with core traits and types ([#2527](https://github.com/vm0-ai/vm0/issues/2527)) ([a7571b4](https://github.com/vm0-ai/vm0/commit/a7571b4ae61b41825eee3b73a59cc2d4f1f6ecb0))
* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.3.0...sandbox-v0.4.0) (2026-02-22)


### Features

* **crates:** add sandbox crate with core traits and types ([#2527](https://github.com/vm0-ai/vm0/issues/2527)) ([a7571b4](https://github.com/vm0-ai/vm0/commit/a7571b4ae61b41825eee3b73a59cc2d4f1f6ecb0))
* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.2.0...sandbox-v0.3.0) (2026-02-22)


### Features

* **crates:** add sandbox crate with core traits and types ([#2527](https://github.com/vm0-ai/vm0/issues/2527)) ([a7571b4](https://github.com/vm0-ai/vm0/commit/a7571b4ae61b41825eee3b73a59cc2d4f1f6ecb0))
* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.1.0...sandbox-v0.2.0) (2026-02-22)


### Features

* **crates:** add sandbox crate with core traits and types ([#2527](https://github.com/vm0-ai/vm0/issues/2527)) ([a7571b4](https://github.com/vm0-ai/vm0/commit/a7571b4ae61b41825eee3b73a59cc2d4f1f6ecb0))
* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
