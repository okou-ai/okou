# Changelog

## [0.41.9](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.41.8...sandbox-firecracker-v0.41.9) (2026-09-12)


### Bug Fixes

* **rust:** revalidate snapshot bind targets after concurrent cleanup ([#33634](https://github.com/vm0-ai/vm0/issues/33634)) ([929f1ae](https://github.com/vm0-ai/vm0/commit/929f1aece5d9c5c7892b7e16691849f3eb71b51c))
* **sandbox:** wait for firecracker exit before recycling resources ([#33644](https://github.com/vm0-ai/vm0/issues/33644)) ([a9ead38](https://github.com/vm0-ai/vm0/commit/a9ead38e66ee83ac4538d96bb4f7f3dcb31f9672))

## [0.41.8](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.41.7...sandbox-firecracker-v0.41.8) (2026-09-12)

## [0.41.7](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.41.6...sandbox-firecracker-v0.41.7) (2026-09-11)

## [0.41.6](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.41.5...sandbox-firecracker-v0.41.6) (2026-09-11)

## [0.41.5](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.41.4...sandbox-firecracker-v0.41.5) (2026-09-11)

## [0.41.4](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.41.3...sandbox-firecracker-v0.41.4) (2026-09-10)

## [0.41.3](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.41.2...sandbox-firecracker-v0.41.3) (2026-09-10)


### Bug Fixes

* **sandbox-firecracker:** bound incomplete control socket requests ([#33281](https://github.com/vm0-ai/vm0/issues/33281)) ([74df5b6](https://github.com/vm0-ai/vm0/commit/74df5b628e6ca3c4c6158e32ab41b3cfe377ffc7))


### Documentation

* **rust:** correct snapshot socket-id listener limits ([#33273](https://github.com/vm0-ai/vm0/issues/33273)) ([e36f6c7](https://github.com/vm0-ai/vm0/commit/e36f6c7cdba31e96ec284d1063286a14e05f9d37))


### Performance Improvements

* **sandbox-firecracker:** share direct cgroup process launches ([#33141](https://github.com/vm0-ai/vm0/issues/33141)) ([61f225c](https://github.com/vm0-ai/vm0/commit/61f225cf47679330cd2be973addd8723b9e3fbf9))

## [0.41.2](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.41.1...sandbox-firecracker-v0.41.2) (2026-09-10)


### Bug Fixes

* **rust:** preserve mountinfo path bytes across consumers ([#33131](https://github.com/vm0-ai/vm0/issues/33131)) ([137593b](https://github.com/vm0-ai/vm0/commit/137593b186149940e8d83550844c59553c044002))

## [0.41.1](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.41.0...sandbox-firecracker-v0.41.1) (2026-09-09)


### Documentation

* **rust:** correct balloon memory-pressure rationale ([#33008](https://github.com/vm0-ai/vm0/issues/33008)) ([deee43a](https://github.com/vm0-ai/vm0/commit/deee43a537f64f80bf37a1e64671a2f47497fe50))

## [0.41.0](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.40.7...sandbox-firecracker-v0.41.0) (2026-09-09)


### Features

* **guest-control:** attribute storage apply resource usage ([#32907](https://github.com/vm0-ai/vm0/issues/32907)) ([65cd810](https://github.com/vm0-ai/vm0/commit/65cd810030c0eac6a5e8e1a377f4562f2cb58c48))

## [0.40.7](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.40.6...sandbox-firecracker-v0.40.7) (2026-09-09)

## [0.40.6](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.40.5...sandbox-firecracker-v0.40.6) (2026-09-09)


### Bug Fixes

* **rpc:** dispatch complete request frames without waiting for eof ([#32821](https://github.com/vm0-ai/vm0/issues/32821)) ([cb025d6](https://github.com/vm0-ai/vm0/commit/cb025d643f9348b2f2a5f8ebc2725fb353c1524f))
* **runner:** classify recovered cooperative cancellation races ([#32812](https://github.com/vm0-ai/vm0/issues/32812)) ([4e6a603](https://github.com/vm0-ai/vm0/commit/4e6a603da4241cfcb81e6329c91df828696ce89f))
* **runner:** defer blank memory reclamation until agent readiness ([#32824](https://github.com/vm0-ai/vm0/issues/32824)) ([29040ac](https://github.com/vm0-ai/vm0/commit/29040ac3b52f14bfb415bc5eeb0adcb7383b17d5))


### Documentation

* **rust:** correct codex snapshot prewarm runtime claims ([#32850](https://github.com/vm0-ai/vm0/issues/32850)) ([ededc02](https://github.com/vm0-ai/vm0/commit/ededc0210e5c4b55e6bb03c75060d03d41091111))

## [0.40.5](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.40.4...sandbox-firecracker-v0.40.5) (2026-09-09)


### Bug Fixes

* **runner:** classify cancelled workspace promotion skips ([#32793](https://github.com/vm0-ai/vm0/issues/32793)) ([5b45464](https://github.com/vm0-ai/vm0/commit/5b4546424e912fee5831a284ea9a54ead5311c1b))
* **runner:** classify expected catalog prefetch timeouts ([#32791](https://github.com/vm0-ai/vm0/issues/32791)) ([b508e1b](https://github.com/vm0-ai/vm0/commit/b508e1b63883c0fb4519330ca0070e10e61e231e))

## [0.40.4](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.40.3...sandbox-firecracker-v0.40.4) (2026-09-08)


### Bug Fixes

* finish okou brand cleanup ([#32684](https://github.com/vm0-ai/vm0/issues/32684)) ([7d239a4](https://github.com/vm0-ai/vm0/commit/7d239a41a5dd6dd41ed7c22cd9e5dae566fc1925))
* **runner:** attribute guest dns readiness attempts ([#32697](https://github.com/vm0-ai/vm0/issues/32697)) ([7558632](https://github.com/vm0-ai/vm0/commit/7558632c0eea9bded6c831fdba33a76c369677aa)), closes [#32445](https://github.com/vm0-ai/vm0/issues/32445)


### Performance Improvements

* **runner:** attribute guest connection startup phases ([#32705](https://github.com/vm0-ai/vm0/issues/32705)) ([176ca98](https://github.com/vm0-ai/vm0/commit/176ca98235eee2d021f23448aef8158d51ecb43f))

## [0.40.3](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.40.2...sandbox-firecracker-v0.40.3) (2026-09-08)

## [0.40.2](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.40.1...sandbox-firecracker-v0.40.2) (2026-09-08)


### Bug Fixes

* **sandbox-firecracker:** retain pool index ownership through creation cleanup ([#32617](https://github.com/vm0-ai/vm0/issues/32617)) ([6ea0882](https://github.com/vm0-ai/vm0/commit/6ea088213e105b590ca7fa533e4eaf7e9a4e71fc))

## [0.40.1](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.40.0...sandbox-firecracker-v0.40.1) (2026-09-08)

## [0.40.0](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.39.6...sandbox-firecracker-v0.40.0) (2026-09-08)


### Features

* **runner:** diagnose private-write terminal response timeouts ([#32539](https://github.com/vm0-ai/vm0/issues/32539)) ([d4af301](https://github.com/vm0-ai/vm0/commit/d4af3011d8636ffc06a5d0bf21c1a12608795e94))

## [0.39.6](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.39.5...sandbox-firecracker-v0.39.6) (2026-09-08)

## [0.39.5](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.39.4...sandbox-firecracker-v0.39.5) (2026-09-07)


### Bug Fixes

* **runner:** retire codex prefetch sandboxes after partial writes ([#32358](https://github.com/vm0-ai/vm0/issues/32358)) ([dd0454e](https://github.com/vm0-ai/vm0/commit/dd0454e8707ecb068cf839c76d04c315427d6783))

## [0.39.4](https://github.com/vm0-ai/vm0/compare/sandbox-firecracker-v0.39.3...sandbox-firecracker-v0.39.4) (2026-09-07)


### Refactoring

* **rust:** align workspace crate names with responsibilities ([#32307](https://github.com/vm0-ai/vm0/issues/32307)) ([39d81ce](https://github.com/vm0-ai/vm0/commit/39d81cedeb3c324ea48c3190e47ffb6c63bb28d9))

## [0.39.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.39.2...sandbox-fc-v0.39.3) (2026-09-07)

## [0.39.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.39.1...sandbox-fc-v0.39.2) (2026-09-07)


### Bug Fixes

* **runner:** retire sandbox after prefetch start timeout ([#32308](https://github.com/vm0-ai/vm0/issues/32308)) ([984a47b](https://github.com/vm0-ai/vm0/commit/984a47b8744fea46ceb63c03d43fcd19970ef31d))


### Performance Improvements

* **runner:** streamline terminal idle finalization ([#32321](https://github.com/vm0-ai/vm0/issues/32321)) ([a49be00](https://github.com/vm0-ai/vm0/commit/a49be00e2242007a1510b464f994cf0b2157074f))

## [0.39.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.39.0...sandbox-fc-v0.39.1) (2026-09-07)

## [0.39.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.17...sandbox-fc-v0.39.0) (2026-09-07)


### Features

* **rpc:** add generic guest-to-runner transport and sandbox fencing ([#32161](https://github.com/vm0-ai/vm0/issues/32161)) ([847d733](https://github.com/vm0-ai/vm0/commit/847d733315462a73b0aae20f992737b9df289bf9))


### Bug Fixes

* **sandbox:** extend healthy balloon settling ([#32196](https://github.com/vm0-ai/vm0/issues/32196)) ([0d871eb](https://github.com/vm0-ai/vm0/commit/0d871ebefa1c9973b35ed2fa14cfac746cd8b3cf))

## [0.38.17](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.16...sandbox-fc-v0.38.17) (2026-09-05)

## [0.38.16](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.15...sandbox-fc-v0.38.16) (2026-09-05)

## [0.38.15](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.14...sandbox-fc-v0.38.15) (2026-09-05)

## [0.38.14](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.13...sandbox-fc-v0.38.14) (2026-09-04)

## [0.38.13](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.12...sandbox-fc-v0.38.13) (2026-09-04)


### Documentation

* **sandbox-fc:** clarify bounded balloon settling during park ([#31554](https://github.com/vm0-ai/vm0/issues/31554)) ([8055807](https://github.com/vm0-ai/vm0/commit/8055807e3763229d95eaef3bb27dd08f166c839e))

## [0.38.12](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.11...sandbox-fc-v0.38.12) (2026-09-04)

## [0.38.11](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.10...sandbox-fc-v0.38.11) (2026-09-04)


### Performance Improvements

* **sandbox-fc:** bound snapshot marker reads ([#31582](https://github.com/vm0-ai/vm0/issues/31582)) ([e72c363](https://github.com/vm0-ai/vm0/commit/e72c36312d49dbc6a73ed5a0f14d68583d9ed779))

## [0.38.10](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.9...sandbox-fc-v0.38.10) (2026-09-04)


### Performance Improvements

* **sandbox-fc:** preserve supported guest capacity ([#31594](https://github.com/vm0-ai/vm0/issues/31594)) ([920d77b](https://github.com/vm0-ai/vm0/commit/920d77b8d15682d69e4e9d9a89395ec8a45d4bbd))

## [0.38.9](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.8...sandbox-fc-v0.38.9) (2026-09-03)

## [0.38.8](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.7...sandbox-fc-v0.38.8) (2026-09-03)

## [0.38.7](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.6...sandbox-fc-v0.38.7) (2026-09-03)


### Documentation

* **sandbox-fc:** document runtime socket trust contract ([#31344](https://github.com/vm0-ai/vm0/issues/31344)) ([8fa8b69](https://github.com/vm0-ai/vm0/commit/8fa8b698b31be48279276b9542fb248f06b56369))

## [0.38.6](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.5...sandbox-fc-v0.38.6) (2026-09-03)


### Refactoring

* **rust:** centralize guest binary paths ([#31298](https://github.com/vm0-ai/vm0/issues/31298)) ([73e59f8](https://github.com/vm0-ai/vm0/commit/73e59f8d4d7337226d3143e2ca688e124878372f))

## [0.38.5](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.4...sandbox-fc-v0.38.5) (2026-09-03)

## [0.38.4](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.3...sandbox-fc-v0.38.4) (2026-09-02)

## [0.38.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.2...sandbox-fc-v0.38.3) (2026-09-02)

## [0.38.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.1...sandbox-fc-v0.38.2) (2026-09-02)

## [0.38.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.38.0...sandbox-fc-v0.38.1) (2026-09-02)

## [0.38.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.283...sandbox-fc-v0.38.0) (2026-09-02)


### Features

* **runner:** isolate firecracker guests in weighted cgroups ([#31057](https://github.com/vm0-ai/vm0/issues/31057)) ([615235d](https://github.com/vm0-ai/vm0/commit/615235d8dd5475cdaafec5eead7209bb28ba18fc))

## [0.37.283](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.282...sandbox-fc-v0.37.283) (2026-09-02)

## [0.37.282](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.281...sandbox-fc-v0.37.282) (2026-09-02)

## [0.37.281](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.280...sandbox-fc-v0.37.281) (2026-09-01)


### Performance Improvements

* **runner:** specialize reused codex cleanup lifecycle ([#30888](https://github.com/vm0-ai/vm0/issues/30888)) ([5941c94](https://github.com/vm0-ai/vm0/commit/5941c9474fb6f1389a6ca9d3c92e99a3af59b98a))

## [0.37.280](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.279...sandbox-fc-v0.37.280) (2026-09-01)

## [0.37.279](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.278...sandbox-fc-v0.37.279) (2026-09-01)

## [0.37.278](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.277...sandbox-fc-v0.37.278) (2026-09-01)

## [0.37.277](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.276...sandbox-fc-v0.37.277) (2026-09-01)

## [0.37.276](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.275...sandbox-fc-v0.37.276) (2026-09-01)


### Performance Improvements

* **runner:** launch reuse identity verifier without shell ([#30644](https://github.com/vm0-ai/vm0/issues/30644)) ([3ea790e](https://github.com/vm0-ai/vm0/commit/3ea790e5a8bca85854debfe537a89a66c4520445))

## [0.37.275](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.274...sandbox-fc-v0.37.275) (2026-08-31)

## [0.37.274](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.273...sandbox-fc-v0.37.274) (2026-08-31)


### Bug Fixes

* **runner:** validate dns readiness responses ([#30433](https://github.com/vm0-ai/vm0/issues/30433)) ([db27fae](https://github.com/vm0-ai/vm0/commit/db27faea984277ac6fad8dd35276d5b1cec81101))

## [0.37.273](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.272...sandbox-fc-v0.37.273) (2026-08-30)

## [0.37.272](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.271...sandbox-fc-v0.37.272) (2026-08-30)

## [0.37.271](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.270...sandbox-fc-v0.37.271) (2026-08-30)

## [0.37.270](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.269...sandbox-fc-v0.37.270) (2026-08-29)


### Bug Fixes

* **sandbox-fc:** release balloon fully under guest pressure ([#30227](https://github.com/vm0-ai/vm0/issues/30227)) ([3bb5c13](https://github.com/vm0-ai/vm0/commit/3bb5c13907716ad7a18e8848a2057420aa92edab))

## [0.37.269](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.268...sandbox-fc-v0.37.269) (2026-08-29)


### Refactoring

* **runner:** finish vm-to-sandbox terminology cleanup ([#30171](https://github.com/vm0-ai/vm0/issues/30171)) ([22d9b2e](https://github.com/vm0-ai/vm0/commit/22d9b2ebfdb9f9d3910eb8b30f8d2679aaed3081))

## [0.37.268](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.267...sandbox-fc-v0.37.268) (2026-08-28)


### Performance Improvements

* **runner:** launch guest agent without shell bootstrap ([#30153](https://github.com/vm0-ai/vm0/issues/30153)) ([b2409fe](https://github.com/vm0-ai/vm0/commit/b2409fed8caa794a4e7d604f7d4c64559a385737))

## [0.37.267](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.266...sandbox-fc-v0.37.267) (2026-08-28)

## [0.37.266](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.265...sandbox-fc-v0.37.266) (2026-08-28)

## [0.37.265](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.264...sandbox-fc-v0.37.265) (2026-08-28)

## [0.37.264](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.263...sandbox-fc-v0.37.264) (2026-08-28)

## [0.37.263](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.262...sandbox-fc-v0.37.263) (2026-08-28)

## [0.37.262](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.261...sandbox-fc-v0.37.262) (2026-08-28)

## [0.37.261](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.260...sandbox-fc-v0.37.261) (2026-08-28)


### Performance Improvements

* **runner:** batch required private guest writes ([#29943](https://github.com/vm0-ai/vm0/issues/29943)) ([97414e6](https://github.com/vm0-ai/vm0/commit/97414e6c34b2241df1cbcf87fa85fa6248cf41d6))

## [0.37.260](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.259...sandbox-fc-v0.37.260) (2026-08-28)

## [0.37.259](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.258...sandbox-fc-v0.37.259) (2026-08-27)

## [0.37.258](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.257...sandbox-fc-v0.37.258) (2026-08-27)

## [0.37.257](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.256...sandbox-fc-v0.37.257) (2026-08-27)

## [0.37.256](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.255...sandbox-fc-v0.37.256) (2026-08-27)


### Bug Fixes

* **sandbox-fc:** guard balloon deflation after unpark ([#29840](https://github.com/vm0-ai/vm0/issues/29840)) ([604d2f8](https://github.com/vm0-ai/vm0/commit/604d2f8c44c87ed576b63b12460c4176343fe994))

## [0.37.255](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.254...sandbox-fc-v0.37.255) (2026-08-27)

## [0.37.254](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.253...sandbox-fc-v0.37.254) (2026-08-27)


### Refactoring

* **runner:** establish guest agent readiness ([#29748](https://github.com/vm0-ai/vm0/issues/29748)) ([8eaafa1](https://github.com/vm0-ai/vm0/commit/8eaafa13bc280f08033fded17e7c3fd5c9822804))
* **rust:** avoid duplicating process stream capacity ([#29784](https://github.com/vm0-ai/vm0/issues/29784)) ([30918ec](https://github.com/vm0-ai/vm0/commit/30918ec96e76b1498fded4d16943fa6f005ae1bb))

## [0.37.253](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.252...sandbox-fc-v0.37.253) (2026-08-26)


### Refactoring

* **runner:** make guest process roles explicit ([#29679](https://github.com/vm0-ai/vm0/issues/29679)) ([fe5d663](https://github.com/vm0-ai/vm0/commit/fe5d663d192a9838dfdf4aecc2ffc8c7a22d24fa))

## [0.37.252](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.251...sandbox-fc-v0.37.252) (2026-08-26)


### Bug Fixes

* **sandbox-fc:** reset leak cleanup watchdog on progress ([#29621](https://github.com/vm0-ai/vm0/issues/29621)) ([6d49df4](https://github.com/vm0-ai/vm0/commit/6d49df40f0e62ad68369d9b871549fbc33c90209))

## [0.37.251](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.250...sandbox-fc-v0.37.251) (2026-08-26)

## [0.37.250](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.249...sandbox-fc-v0.37.250) (2026-08-26)


### Bug Fixes

* **vsock:** bound file write response waits ([#29455](https://github.com/vm0-ai/vm0/issues/29455)) ([f9d9692](https://github.com/vm0-ai/vm0/commit/f9d9692d06e8f9574d2888397e0ab38ec2adc029))

## [0.37.249](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.248...sandbox-fc-v0.37.249) (2026-08-26)


### Performance Improvements

* **runner:** specialize guest state restore operation ([#29398](https://github.com/vm0-ai/vm0/issues/29398)) ([89521f7](https://github.com/vm0-ai/vm0/commit/89521f769af74c43034f04e5f7decc537ebff628))

## [0.37.248](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.247...sandbox-fc-v0.37.248) (2026-08-25)

## [0.37.247](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.246...sandbox-fc-v0.37.247) (2026-08-25)

## [0.37.246](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.245...sandbox-fc-v0.37.246) (2026-08-25)

## [0.37.245](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.244...sandbox-fc-v0.37.245) (2026-08-25)

## [0.37.244](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.243...sandbox-fc-v0.37.244) (2026-08-25)

## [0.37.243](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.242...sandbox-fc-v0.37.243) (2026-08-24)

## [0.37.242](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.241...sandbox-fc-v0.37.242) (2026-08-24)

## [0.37.241](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.240...sandbox-fc-v0.37.241) (2026-08-24)

## [0.37.240](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.239...sandbox-fc-v0.37.240) (2026-08-24)


### Bug Fixes

* **sandbox-fc:** bound command cleanup after timeout ([#28975](https://github.com/vm0-ai/vm0/issues/28975)) ([13f87fd](https://github.com/vm0-ai/vm0/commit/13f87fd5c7967c5e09550418070b499917fc8c8c))

## [0.37.239](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.238...sandbox-fc-v0.37.239) (2026-08-24)

## [0.37.238](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.237...sandbox-fc-v0.37.238) (2026-08-24)


### Refactoring

* **rust:** unify runner exec capture limits ([#28812](https://github.com/vm0-ai/vm0/issues/28812)) ([25bfae0](https://github.com/vm0-ai/vm0/commit/25bfae001efedfcecc3b9d6aca5505ba5ab30263))

## [0.37.237](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.236...sandbox-fc-v0.37.237) (2026-08-24)


### Performance Improvements

* **runner:** specialize guest storage manifest invocation ([#28734](https://github.com/vm0-ai/vm0/issues/28734)) ([0255e57](https://github.com/vm0-ai/vm0/commit/0255e57603d27fe97ac342c97af98921dabf2ae9))

## [0.37.236](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.235...sandbox-fc-v0.37.236) (2026-08-23)

## [0.37.235](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.234...sandbox-fc-v0.37.235) (2026-08-23)


### Documentation

* **rust:** document the pre-reap contract of ChildExitNotifier ([#28690](https://github.com/vm0-ai/vm0/issues/28690)) ([eb4178f](https://github.com/vm0-ai/vm0/commit/eb4178f07909ea26cb6d05404a772e5a62ce5f83))

## [0.37.234](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.233...sandbox-fc-v0.37.234) (2026-08-21)

## [0.37.233](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.232...sandbox-fc-v0.37.233) (2026-08-21)

## [0.37.232](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.231...sandbox-fc-v0.37.232) (2026-08-21)

## [0.37.231](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.230...sandbox-fc-v0.37.231) (2026-08-20)


### Documentation

* **rust:** document namespace dns probe thread isolation ([#28396](https://github.com/vm0-ai/vm0/issues/28396)) ([6e1b085](https://github.com/vm0-ai/vm0/commit/6e1b085658665c839f93b85ac8277b146e4d1eac))
* **sandbox:** document firecracker snapshot id constraints ([#28325](https://github.com/vm0-ai/vm0/issues/28325)) ([3f5ff12](https://github.com/vm0-ai/vm0/commit/3f5ff12c79dd4702d50bcb1b6f761ae2631c94d2))

## [0.37.230](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.229...sandbox-fc-v0.37.230) (2026-08-20)


### Bug Fixes

* **sandbox-fc:** bound firecracker child file descriptor tables ([#28318](https://github.com/vm0-ai/vm0/issues/28318)) ([09e2cf9](https://github.com/vm0-ai/vm0/commit/09e2cf926dfe6718cb05b1bd1c3c57acd1f2bc70))


### Refactoring

* **rust:** centralize process output validation ([#28277](https://github.com/vm0-ai/vm0/issues/28277)) ([8e6e25c](https://github.com/vm0-ai/vm0/commit/8e6e25c954c7b4a90d3ba9d9cca7eb87090581e9))

## [0.37.229](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.228...sandbox-fc-v0.37.229) (2026-08-20)


### Bug Fixes

* **sandbox-fc:** bound cow pool sparse copies ([#28163](https://github.com/vm0-ai/vm0/issues/28163)) ([79b74d3](https://github.com/vm0-ai/vm0/commit/79b74d328679d37fbf029af7fb5fca1569213f5e))


### Refactoring

* **runner:** centralize sandbox command prerequisites ([#28246](https://github.com/vm0-ai/vm0/issues/28246)) ([8054bc6](https://github.com/vm0-ai/vm0/commit/8054bc6ecaa46dc80f6d2d5d75943af73a36a828))

## [0.37.228](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.227...sandbox-fc-v0.37.228) (2026-08-19)


### Performance Improvements

* **runner:** hand off finalizing sandboxes before idle compaction ([#28063](https://github.com/vm0-ai/vm0/issues/28063)) ([543aae3](https://github.com/vm0-ai/vm0/commit/543aae384b1d6311d0bcceef487ab37bea3f3147))

## [0.37.227](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.226...sandbox-fc-v0.37.227) (2026-08-18)


### Performance Improvements

* **runner:** attribute workspace mount guest duration ([#28059](https://github.com/vm0-ai/vm0/issues/28059)) ([7b94559](https://github.com/vm0-ai/vm0/commit/7b94559e3942ebbcfb88e7d287b59cc777386977))

## [0.37.226](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.225...sandbox-fc-v0.37.226) (2026-08-18)


### Documentation

* **rust:** document Firecracker API client construction semantics ([#28033](https://github.com/vm0-ai/vm0/issues/28033)) ([1d17809](https://github.com/vm0-ai/vm0/commit/1d17809fc781cf37ce042cdfefb0a22f296f5136))


### Performance Improvements

* **sandbox-fc:** remove redundant host memory sampling ([#28015](https://github.com/vm0-ai/vm0/issues/28015)) ([dd17fd3](https://github.com/vm0-ai/vm0/commit/dd17fd35644bb97b17621b75dbadd86969bf041d))

## [0.37.225](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.224...sandbox-fc-v0.37.225) (2026-08-18)

## [0.37.224](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.223...sandbox-fc-v0.37.224) (2026-08-17)

## [0.37.223](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.222...sandbox-fc-v0.37.223) (2026-08-17)


### Performance Improvements

* **sandbox-fc:** reduce balloon settle polling latency ([#27647](https://github.com/vm0-ai/vm0/issues/27647)) ([4553067](https://github.com/vm0-ai/vm0/commit/4553067a22a48cd9deb35d2808e237936fc17c53))

## [0.37.222](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.221...sandbox-fc-v0.37.222) (2026-08-17)


### Refactoring

* **sandbox-fc:** use upstream abort-on-drop handle ([#27638](https://github.com/vm0-ai/vm0/issues/27638)) ([a345549](https://github.com/vm0-ai/vm0/commit/a34554988eaebfc2c3a8646620263e5181f93498))

## [0.37.221](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.220...sandbox-fc-v0.37.221) (2026-08-16)


### Performance Improvements

* **runner:** expose physical park substage telemetry ([#27561](https://github.com/vm0-ai/vm0/issues/27561)) ([98c8737](https://github.com/vm0-ai/vm0/commit/98c873732d2d71f0840561dfcb2931751c31a037))

## [0.37.220](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.219...sandbox-fc-v0.37.220) (2026-08-16)


### Documentation

* **sandbox-fc:** document factory cleanup lifecycle ([#27560](https://github.com/vm0-ai/vm0/issues/27560)) ([f9640f2](https://github.com/vm0-ai/vm0/commit/f9640f2ed67c20c68a8006f6d9239a51438c72a6))

## [0.37.219](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.218...sandbox-fc-v0.37.219) (2026-08-15)


### Documentation

* **sandbox-fc:** refresh snapshot workflow documentation ([#27365](https://github.com/vm0-ai/vm0/issues/27365)) ([fdcefcb](https://github.com/vm0-ai/vm0/commit/fdcefcb0aca80a16a714d80541893d25e83a3a0f))

## [0.37.218](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.217...sandbox-fc-v0.37.218) (2026-08-14)

## [0.37.217](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.216...sandbox-fc-v0.37.217) (2026-08-14)


### Performance Improvements

* **runner:** reduce guest dns readiness latency ([#27184](https://github.com/vm0-ai/vm0/issues/27184)) ([0752a72](https://github.com/vm0-ai/vm0/commit/0752a72e452aedcf40cca5bb8d177a3850592d1e))

## [0.37.216](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.215...sandbox-fc-v0.37.216) (2026-08-14)

## [0.37.215](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.214...sandbox-fc-v0.37.215) (2026-08-14)

## [0.37.214](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.213...sandbox-fc-v0.37.214) (2026-08-14)


### Refactoring

* **sandbox-fc:** centralize firecracker boot configuration ([#27129](https://github.com/vm0-ai/vm0/issues/27129)) ([dfcfdc3](https://github.com/vm0-ai/vm0/commit/dfcfdc33db89cb9c2f94a4eae69c4e65a7a51049))

## [0.37.213](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.212...sandbox-fc-v0.37.213) (2026-08-14)

## [0.37.212](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.211...sandbox-fc-v0.37.212) (2026-08-13)

## [0.37.211](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.210...sandbox-fc-v0.37.211) (2026-08-13)

## [0.37.210](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.209...sandbox-fc-v0.37.210) (2026-08-13)


### Documentation

* **sandbox-fc:** correct prewarm credential comment ([#26927](https://github.com/vm0-ai/vm0/issues/26927)) ([63f3634](https://github.com/vm0-ai/vm0/commit/63f363433df8c4586fb4bbf4fde0b10d6a247227))

## [0.37.209](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.208...sandbox-fc-v0.37.209) (2026-08-13)


### Bug Fixes

* **runner:** preserve guest control headroom under workload pressure ([#26683](https://github.com/vm0-ai/vm0/issues/26683)) ([789adcd](https://github.com/vm0-ai/vm0/commit/789adcd9e7a35dc545ae660f4b5a55d802ea854f))
* **sandbox-fc:** reject symlinked snapshot markers ([#26870](https://github.com/vm0-ai/vm0/issues/26870)) ([af592c8](https://github.com/vm0-ai/vm0/commit/af592c83fd864a16f9faad0f9c36f4ae85bb6ff6))

## [0.37.208](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.207...sandbox-fc-v0.37.208) (2026-08-13)

## [0.37.207](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.206...sandbox-fc-v0.37.207) (2026-08-13)

## [0.37.206](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.205...sandbox-fc-v0.37.206) (2026-08-12)

## [0.37.205](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.204...sandbox-fc-v0.37.205) (2026-08-12)

## [0.37.204](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.203...sandbox-fc-v0.37.204) (2026-08-11)

## [0.37.203](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.202...sandbox-fc-v0.37.203) (2026-08-11)

## [0.37.202](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.201...sandbox-fc-v0.37.202) (2026-08-10)


### Refactoring

* **runner:** preserve process-control outcomes ([#26178](https://github.com/vm0-ai/vm0/issues/26178)) ([23ccd10](https://github.com/vm0-ai/vm0/commit/23ccd10daa8552532ebc1a355c89087c2e72656b))

## [0.37.201](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.200...sandbox-fc-v0.37.201) (2026-08-10)


### Bug Fixes

* **runner:** attribute severe balloon retention ([#26038](https://github.com/vm0-ai/vm0/issues/26038)) ([d996ab7](https://github.com/vm0-ai/vm0/commit/d996ab715ff06c03dee96b82f683e577c7e52b89))

## [0.37.200](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.199...sandbox-fc-v0.37.200) (2026-08-10)

## [0.37.199](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.198...sandbox-fc-v0.37.199) (2026-08-09)

## [0.37.198](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.197...sandbox-fc-v0.37.198) (2026-08-09)

## [0.37.197](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.196...sandbox-fc-v0.37.197) (2026-08-09)

## [0.37.196](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.195...sandbox-fc-v0.37.196) (2026-08-08)

## [0.37.195](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.194...sandbox-fc-v0.37.195) (2026-08-07)


### Performance Improvements

* **rust:** eliminate exec-control payload copies ([#25608](https://github.com/vm0-ai/vm0/issues/25608)) ([3f71e3b](https://github.com/vm0-ai/vm0/commit/3f71e3b491c2fb66e3c964494565aa9a9bcd4166))

## [0.37.194](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.193...sandbox-fc-v0.37.194) (2026-08-07)

## [0.37.193](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.192...sandbox-fc-v0.37.193) (2026-08-07)

## [0.37.192](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.191...sandbox-fc-v0.37.192) (2026-08-06)

## [0.37.191](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.190...sandbox-fc-v0.37.191) (2026-08-06)


### Refactoring

* **runner:** centralize firecracker snapshot validation ([#25469](https://github.com/vm0-ai/vm0/issues/25469)) ([2ff4c4e](https://github.com/vm0-ai/vm0/commit/2ff4c4ecbc54f1eb2d7a65664122e489b3afc362))

## [0.37.190](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.189...sandbox-fc-v0.37.190) (2026-08-06)


### Refactoring

* **runner:** remove resolved dns diagnostics ([#25426](https://github.com/vm0-ai/vm0/issues/25426)) ([a301c42](https://github.com/vm0-ai/vm0/commit/a301c42affa3da95dc3cec1b0c456acf16af2a5c))

## [0.37.189](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.188...sandbox-fc-v0.37.189) (2026-08-06)

## [0.37.188](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.187...sandbox-fc-v0.37.188) (2026-08-06)


### Refactoring

* **sandbox-fc:** retire balloon settle summary ([#25380](https://github.com/vm0-ai/vm0/issues/25380)) ([ec2b177](https://github.com/vm0-ai/vm0/commit/ec2b177f7908e4bf61a9eab9c7217257578b3872))

## [0.37.187](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.186...sandbox-fc-v0.37.187) (2026-08-06)

## [0.37.186](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.185...sandbox-fc-v0.37.186) (2026-08-05)


### Refactoring

* **sandbox-fc:** centralize snapshot spawn construction ([#25268](https://github.com/vm0-ai/vm0/issues/25268)) ([98a37c5](https://github.com/vm0-ai/vm0/commit/98a37c5f4127d46527e0a2d79be0d462ebedcbcd))

## [0.37.185](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.184...sandbox-fc-v0.37.185) (2026-08-05)


### Documentation

* **sandbox:** document remote exec timeout normalization ([#25214](https://github.com/vm0-ai/vm0/issues/25214)) ([6138e94](https://github.com/vm0-ai/vm0/commit/6138e94533b3a0d23ccb7fb040b9ff6621c0db29))

## [0.37.184](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.183...sandbox-fc-v0.37.184) (2026-08-05)


### Bug Fixes

* **sandbox-fc:** wait for progressing balloon reclaim ([#25194](https://github.com/vm0-ai/vm0/issues/25194)) ([c53cdcf](https://github.com/vm0-ai/vm0/commit/c53cdcf63d4fbc028407eea94399e95f53de23e3))

## [0.37.183](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.182...sandbox-fc-v0.37.183) (2026-08-05)

## [0.37.182](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.181...sandbox-fc-v0.37.182) (2026-08-05)


### Refactoring

* **rust:** use rustix for child exit pidfds ([#25122](https://github.com/vm0-ai/vm0/issues/25122)) ([85100f1](https://github.com/vm0-ai/vm0/commit/85100f174664559002a35778a73a3b4d9ec722ad))

## [0.37.181](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.180...sandbox-fc-v0.37.181) (2026-08-05)


### Bug Fixes

* **runner:** keep info logs out of axiom ([#25114](https://github.com/vm0-ai/vm0/issues/25114)) ([3c6d123](https://github.com/vm0-ai/vm0/commit/3c6d1235847d344b7e1a9bc8ee885b68d1fd8d5b))

## [0.37.180](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.179...sandbox-fc-v0.37.180) (2026-08-04)


### Bug Fixes

* **sandbox-fc:** stabilize root veth mac identity ([#25071](https://github.com/vm0-ai/vm0/issues/25071)) ([47af501](https://github.com/vm0-ai/vm0/commit/47af501b4e6ab409596fc07f5230b69b732ba06f))


### Performance Improvements

* **sandbox-fc:** reduce balloon settle detection latency ([#25069](https://github.com/vm0-ai/vm0/issues/25069)) ([16893fa](https://github.com/vm0-ai/vm0/commit/16893fa7ffa416a8859a112119a8082229da2d88))

## [0.37.179](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.178...sandbox-fc-v0.37.179) (2026-08-04)

## [0.37.178](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.177...sandbox-fc-v0.37.178) (2026-08-04)

## [0.37.177](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.176...sandbox-fc-v0.37.177) (2026-08-04)


### Documentation

* **sandbox-fc:** document partial cow checkout ownership ([#24977](https://github.com/vm0-ai/vm0/issues/24977)) ([7e22b79](https://github.com/vm0-ai/vm0/commit/7e22b79434813887928463e5d586c24a92d347b7))


### Performance Improvements

* measure pre-park successor handoff ([#24938](https://github.com/vm0-ai/vm0/issues/24938)) ([6e7c0aa](https://github.com/vm0-ai/vm0/commit/6e7c0aa73c51d7916efaa354f6ce1ba32b83090f))
* **sandbox-fc:** stream raw exec responses ([#24940](https://github.com/vm0-ai/vm0/issues/24940)) ([0d032fb](https://github.com/vm0-ai/vm0/commit/0d032fb3a2b22d78b32206e3b48577c97629a7d6))

## [0.37.176](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.175...sandbox-fc-v0.37.176) (2026-08-04)


### Bug Fixes

* **sandbox-fc:** verify conntrack reset outcomes ([#24933](https://github.com/vm0-ai/vm0/issues/24933)) ([d1f7711](https://github.com/vm0-ai/vm0/commit/d1f77112c4b11024fe1e8164a3f00141b6d288b4))


### Refactoring

* **runner:** centralize guest dns probe signature ([#24936](https://github.com/vm0-ai/vm0/issues/24936)) ([6fbb873](https://github.com/vm0-ai/vm0/commit/6fbb87342944fc9292ae4c6dfa99d7302caf8acc))

## [0.37.175](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.174...sandbox-fc-v0.37.175) (2026-08-04)


### Bug Fixes

* **runner:** guard run controls across sandbox reuse ([#24849](https://github.com/vm0-ai/vm0/issues/24849)) ([bb1d90c](https://github.com/vm0-ai/vm0/commit/bb1d90c15df373b43a8653dcd85f9a47e3fb6042))

## [0.37.174](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.173...sandbox-fc-v0.37.174) (2026-08-03)


### Bug Fixes

* **runner:** localize guest dns loss across veth ([#24791](https://github.com/vm0-ai/vm0/issues/24791)) ([32ff5f5](https://github.com/vm0-ai/vm0/commit/32ff5f5d305669d91d9459a7f4b8c359444201b7))
* **sandbox-fc:** surface namespace creation failures ([#24810](https://github.com/vm0-ai/vm0/issues/24810)) ([41a8207](https://github.com/vm0-ai/vm0/commit/41a8207b30858d63e7e85e98ede595a6af4ce243))

## [0.37.173](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.172...sandbox-fc-v0.37.173) (2026-08-03)

## [0.37.172](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.171...sandbox-fc-v0.37.172) (2026-08-03)

## [0.37.171](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.170...sandbox-fc-v0.37.171) (2026-08-03)

## [0.37.170](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.169...sandbox-fc-v0.37.170) (2026-08-02)

## [0.37.169](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.168...sandbox-fc-v0.37.169) (2026-08-02)

## [0.37.168](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.167...sandbox-fc-v0.37.168) (2026-08-01)

## [0.37.167](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.166...sandbox-fc-v0.37.167) (2026-07-31)


### Refactoring

* **sandbox-fc:** extract network pool firewall ([#24326](https://github.com/vm0-ai/vm0/issues/24326)) ([161af9d](https://github.com/vm0-ai/vm0/commit/161af9d52ddcec3ced28d36cf3d15ea43930fb17))

## [0.37.166](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.165...sandbox-fc-v0.37.166) (2026-07-31)

## [0.37.165](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.164...sandbox-fc-v0.37.165) (2026-07-31)

## [0.37.164](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.163...sandbox-fc-v0.37.164) (2026-07-30)

## [0.37.163](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.162...sandbox-fc-v0.37.163) (2026-07-30)

## [0.37.162](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.161...sandbox-fc-v0.37.162) (2026-07-30)


### Bug Fixes

* **sandbox-fc:** support cross-filesystem workspace seed moves ([#23876](https://github.com/vm0-ai/vm0/issues/23876)) ([9230b4d](https://github.com/vm0-ai/vm0/commit/9230b4dd9d7b834eb3d36a6dbec150c40060fbc4))

## [0.37.161](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.160...sandbox-fc-v0.37.161) (2026-07-29)

## [0.37.160](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.159...sandbox-fc-v0.37.160) (2026-07-29)


### Performance Improvements

* **sandbox-fc:** parallelize leaked sandbox cleanup ([#23689](https://github.com/vm0-ai/vm0/issues/23689)) ([f3b2b5c](https://github.com/vm0-ai/vm0/commit/f3b2b5cd0c677da566abb7cc7a3499ea3776c817))

## [0.37.159](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.158...sandbox-fc-v0.37.159) (2026-07-29)


### Documentation

* **runner:** document guest dns network evidence architecture ([#23624](https://github.com/vm0-ai/vm0/issues/23624)) ([573928a](https://github.com/vm0-ai/vm0/commit/573928ad414d4c10b535bc17d7e927495a465ce1))

## [0.37.158](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.157...sandbox-fc-v0.37.158) (2026-07-28)

## [0.37.157](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.156...sandbox-fc-v0.37.157) (2026-07-28)


### Bug Fixes

* **vsock-host:** bound exec start writes by host deadlines ([#23551](https://github.com/vm0-ai/vm0/issues/23551)) ([7b7822d](https://github.com/vm0-ai/vm0/commit/7b7822dbb2520442f78812db4fd290f5baa5ec56))

## [0.37.156](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.155...sandbox-fc-v0.37.156) (2026-07-28)


### Bug Fixes

* **sandbox-fc:** propagate firecracker transition errors ([#23413](https://github.com/vm0-ai/vm0/issues/23413)) ([a73a42c](https://github.com/vm0-ai/vm0/commit/a73a42ceaea91c3468406b939431436f2ea3dce2))

## [0.37.155](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.154...sandbox-fc-v0.37.155) (2026-07-28)

## [0.37.154](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.153...sandbox-fc-v0.37.154) (2026-07-27)


### Bug Fixes

* **runner:** trace guest dns through root netfilter ([#23311](https://github.com/vm0-ai/vm0/issues/23311)) ([ca05dd0](https://github.com/vm0-ai/vm0/commit/ca05dd0a296ac2b1634aceba5ca1a64adcbd601a))

## [0.37.153](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.152...sandbox-fc-v0.37.153) (2026-07-27)


### Bug Fixes

* **runner:** distinguish dns readiness timeouts ([#23282](https://github.com/vm0-ai/vm0/issues/23282)) ([1593bf9](https://github.com/vm0-ai/vm0/commit/1593bf9ddbce0c4b022ed7d772b845bbcd86be1b))

## [0.37.152](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.151...sandbox-fc-v0.37.152) (2026-07-27)


### Refactoring

* **sandbox-fc:** centralize dns probe deadline ([#23185](https://github.com/vm0-ai/vm0/issues/23185)) ([8c8d8f6](https://github.com/vm0-ai/vm0/commit/8c8d8f6c349fae3f27bec4b6012eeedc78881778))

## [0.37.151](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.150...sandbox-fc-v0.37.151) (2026-07-25)

## [0.37.150](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.149...sandbox-fc-v0.37.150) (2026-07-25)

## [0.37.149](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.148...sandbox-fc-v0.37.149) (2026-07-23)


### Bug Fixes

* **runner:** classify dns readiness network boundary ([#22724](https://github.com/vm0-ai/vm0/issues/22724)) ([628b0c8](https://github.com/vm0-ai/vm0/commit/628b0c83a0f7da5f02452b962d976aac42475cc0))

## [0.37.148](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.147...sandbox-fc-v0.37.148) (2026-07-23)


### Performance Improvements

* **runner:** preconnect one-shot nbd cow slots ([#22683](https://github.com/vm0-ai/vm0/issues/22683)) ([1d02f4a](https://github.com/vm0-ai/vm0/commit/1d02f4a9e5df3d981da9fbf99606bd10d31b1a16))

## [0.37.147](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.146...sandbox-fc-v0.37.147) (2026-07-23)

## [0.37.146](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.145...sandbox-fc-v0.37.146) (2026-07-23)


### Performance Improvements

* **runner:** move reused mount validation to idle admission ([#22610](https://github.com/vm0-ai/vm0/issues/22610)) ([710f9da](https://github.com/vm0-ai/vm0/commit/710f9da64fbb6d86a1588df02da2077dfb7c938a))

## [0.37.145](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.144...sandbox-fc-v0.37.145) (2026-07-23)

## [0.37.144](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.143...sandbox-fc-v0.37.144) (2026-07-22)


### Bug Fixes

* **runner:** classify guest dns readiness failures ([#22547](https://github.com/vm0-ai/vm0/issues/22547)) ([12fd057](https://github.com/vm0-ai/vm0/commit/12fd057dfb23604891fce86ca7c6f4915e896249))


### Performance Improvements

* **sandbox-fc:** batch firewall mutations ([#22589](https://github.com/vm0-ai/vm0/issues/22589)) ([8433c4c](https://github.com/vm0-ai/vm0/commit/8433c4c3057b08c4c548adc0c50125a118077719))
* **sandbox-fc:** bound namespace cleanup concurrency ([#22607](https://github.com/vm0-ai/vm0/issues/22607)) ([3d56c19](https://github.com/vm0-ai/vm0/commit/3d56c192c04c3ae7f66dfb63919ba05f841452f6))

## [0.37.143](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.142...sandbox-fc-v0.37.143) (2026-07-22)


### Refactoring

* **sandbox-fc:** encapsulate creation completions ([#22534](https://github.com/vm0-ai/vm0/issues/22534)) ([e4c1ae9](https://github.com/vm0-ai/vm0/commit/e4c1ae97b03bdec272a5e5c148b1a64069c1df0d))

## [0.37.142](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.141...sandbox-fc-v0.37.142) (2026-07-22)


### Performance Improvements

* **runner:** attribute sandbox start phases ([#22523](https://github.com/vm0-ai/vm0/issues/22523)) ([cd8f6a4](https://github.com/vm0-ai/vm0/commit/cd8f6a40c109d7b04bd991067fdf2b5ad1c77ca8))
* **sandbox-fc:** reconcile pool resources from one snapshot ([#22551](https://github.com/vm0-ai/vm0/issues/22551)) ([f2d29a5](https://github.com/vm0-ai/vm0/commit/f2d29a563c9f5dc225cd5ee822fb141a6c5ae215))

## [0.37.141](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.140...sandbox-fc-v0.37.141) (2026-07-22)


### Bug Fixes

* **sandbox-fc:** wait for legacy xtables lock ([#22484](https://github.com/vm0-ai/vm0/issues/22484)) ([8ec23c1](https://github.com/vm0-ai/vm0/commit/8ec23c14812cc77b0dba0c99b64bc938ca775ee3))

## [0.37.140](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.139...sandbox-fc-v0.37.140) (2026-07-21)


### Refactoring

* **sandbox-fc:** centralize startup orchestration ([#22427](https://github.com/vm0-ai/vm0/issues/22427)) ([db8d8f7](https://github.com/vm0-ai/vm0/commit/db8d8f74db3d09751d3944251e43ae44e2754e8c))

## [0.37.139](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.138...sandbox-fc-v0.37.139) (2026-07-21)

## [0.37.138](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.137...sandbox-fc-v0.37.138) (2026-07-21)

## [0.37.137](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.136...sandbox-fc-v0.37.137) (2026-07-20)

## [0.37.136](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.135...sandbox-fc-v0.37.136) (2026-07-20)

## [0.37.135](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.134...sandbox-fc-v0.37.135) (2026-07-19)

## [0.37.134](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.133...sandbox-fc-v0.37.134) (2026-07-19)

## [0.37.133](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.132...sandbox-fc-v0.37.133) (2026-07-18)


### Bug Fixes

* **sandbox-fc:** preserve graceful shutdown failure details ([#22073](https://github.com/vm0-ai/vm0/issues/22073)) ([50ad121](https://github.com/vm0-ai/vm0/commit/50ad1210ebd12c90f294bd0e16e208deb8c4366c))


### Refactoring

* **sandbox-fc:** isolate prerequisite probes ([#22079](https://github.com/vm0-ai/vm0/issues/22079)) ([ef58dab](https://github.com/vm0-ai/vm0/commit/ef58dab67a77da5a060d045295701f9f052fccbe))

## [0.37.132](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.131...sandbox-fc-v0.37.132) (2026-07-17)

## [0.37.131](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.130...sandbox-fc-v0.37.131) (2026-07-17)


### Documentation

* **sandbox-fc:** document snapshot completion marker contract ([#21984](https://github.com/vm0-ai/vm0/issues/21984)) ([e0e05ae](https://github.com/vm0-ai/vm0/commit/e0e05aeb016a3f1336b5b9f96c4e2e0c61bc284d))

## [0.37.130](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.129...sandbox-fc-v0.37.130) (2026-07-17)

## [0.37.129](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.128...sandbox-fc-v0.37.129) (2026-07-17)


### Documentation

* **sandbox-fc:** document outbound tcp proxy routing ([#21935](https://github.com/vm0-ai/vm0/issues/21935)) ([5ffa25b](https://github.com/vm0-ai/vm0/commit/5ffa25bb75a4df91a195de1b632e59ec0925274d))

## [0.37.128](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.127...sandbox-fc-v0.37.128) (2026-07-16)


### Bug Fixes

* **runner:** classify oversized sidecars as unavailable ([#21877](https://github.com/vm0-ai/vm0/issues/21877)) ([d9fde61](https://github.com/vm0-ai/vm0/commit/d9fde61a0cce1579c4cf841e3e721aaf016eb537))
* **runner:** recover from guest dns readiness failures ([#21879](https://github.com/vm0-ai/vm0/issues/21879)) ([38a6647](https://github.com/vm0-ai/vm0/commit/38a664712e595a88a482df90ef8012f976c3f128))

## [0.37.127](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.126...sandbox-fc-v0.37.127) (2026-07-16)


### Bug Fixes

* **runner:** prevent stale conntrack dns failures ([#21817](https://github.com/vm0-ai/vm0/issues/21817)) ([b6d0691](https://github.com/vm0-ai/vm0/commit/b6d0691437caf15deb5c9ac9ca1bcf1d8cc859e3))
* **runner:** reject spoofed sandbox source addresses ([#21838](https://github.com/vm0-ai/vm0/issues/21838)) ([f0888bf](https://github.com/vm0-ai/vm0/commit/f0888bfddb119701096de1eb6e0e8fc7ee79f174))

## [0.37.126](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.125...sandbox-fc-v0.37.126) (2026-07-16)

## [0.37.125](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.124...sandbox-fc-v0.37.125) (2026-07-16)


### Documentation

* **sandbox-fc:** document snapshot socket id constraints ([#21794](https://github.com/vm0-ai/vm0/issues/21794)) ([d211d78](https://github.com/vm0-ai/vm0/commit/d211d787ea7c714e9c2d335966889025d6efbb7b))

## [0.37.124](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.123...sandbox-fc-v0.37.124) (2026-07-16)


### Documentation

* **sandbox-fc:** clarify netns release semantics ([#21743](https://github.com/vm0-ai/vm0/issues/21743)) ([29ed84c](https://github.com/vm0-ai/vm0/commit/29ed84c9bb3fb16071ae5b6239a8e6d5067d88ac))

## [0.37.123](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.122...sandbox-fc-v0.37.123) (2026-07-16)


### Bug Fixes

* describe zero scrape capabilities in agent context ([#21574](https://github.com/vm0-ai/vm0/issues/21574)) ([5d5b298](https://github.com/vm0-ai/vm0/commit/5d5b298b1396f2e4c1ee6873d429987fcb9df4cc))

## [0.37.122](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.121...sandbox-fc-v0.37.122) (2026-07-15)

## [0.37.121](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.120...sandbox-fc-v0.37.121) (2026-07-15)

## [0.37.120](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.119...sandbox-fc-v0.37.120) (2026-07-15)

## [0.37.119](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.118...sandbox-fc-v0.37.119) (2026-07-15)


### Bug Fixes

* **sandbox-fc:** bound firecracker process log records ([#21596](https://github.com/vm0-ai/vm0/issues/21596)) ([dbc12a2](https://github.com/vm0-ai/vm0/commit/dbc12a27c0e105ee341788f2d17d97f59dc98d53))

## [0.37.118](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.117...sandbox-fc-v0.37.118) (2026-07-15)

## [0.37.117](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.116...sandbox-fc-v0.37.117) (2026-07-15)

## [0.37.116](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.115...sandbox-fc-v0.37.116) (2026-07-15)

## [0.37.115](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.114...sandbox-fc-v0.37.115) (2026-07-14)


### Bug Fixes

* **runner:** prevent dnsmasq stalls during namespace churn ([#21373](https://github.com/vm0-ai/vm0/issues/21373)) ([1fd0fea](https://github.com/vm0-ai/vm0/commit/1fd0fea74884c8a644edbf62aaffc6c8ea5da615))

## [0.37.114](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.113...sandbox-fc-v0.37.114) (2026-07-14)

## [0.37.113](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.112...sandbox-fc-v0.37.113) (2026-07-14)

## [0.37.112](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.111...sandbox-fc-v0.37.112) (2026-07-14)


### Refactoring

* **sandbox-fc:** isolate snapshot process lifecycle ([#21317](https://github.com/vm0-ai/vm0/issues/21317)) ([17f221a](https://github.com/vm0-ai/vm0/commit/17f221a436a27e948b80c293195aef606617e8e3))

## [0.37.111](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.110...sandbox-fc-v0.37.111) (2026-07-14)

## [0.37.110](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.109...sandbox-fc-v0.37.110) (2026-07-13)


### Bug Fixes

* **sandbox-fc:** route tcp dns through dnsmasq ([#21288](https://github.com/vm0-ai/vm0/issues/21288)) ([a95d872](https://github.com/vm0-ai/vm0/commit/a95d8720fff31fa3be49fabac532eb5543865c82))

## [0.37.109](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.108...sandbox-fc-v0.37.109) (2026-07-13)

## [0.37.108](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.107...sandbox-fc-v0.37.108) (2026-07-12)


### Performance Improvements

* attribute nbd netlink connect latency ([#21121](https://github.com/vm0-ai/vm0/issues/21121)) ([7ff85a6](https://github.com/vm0-ai/vm0/commit/7ff85a6d10e757e24534f5f9a00a1cab1342eb4d))

## [0.37.107](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.106...sandbox-fc-v0.37.107) (2026-07-11)


### Performance Improvements

* **runner:** attribute nbd cow creation latency ([#21065](https://github.com/vm0-ai/vm0/issues/21065)) ([7d97c9a](https://github.com/vm0-ai/vm0/commit/7d97c9a0e83e09645f97675c2594fad08b54bfc7))

## [0.37.106](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.105...sandbox-fc-v0.37.106) (2026-07-10)


### Performance Improvements

* **sandbox-fc:** reduce fresh workspace image writes ([#21004](https://github.com/vm0-ai/vm0/issues/21004)) ([332527c](https://github.com/vm0-ai/vm0/commit/332527c3949074d0a25a154549e3a995925e9738))

## [0.37.105](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.104...sandbox-fc-v0.37.105) (2026-07-10)


### Bug Fixes

* **sandbox-fc:** replace bespoke firecracker http codec ([#20969](https://github.com/vm0-ai/vm0/issues/20969)) ([a0e7072](https://github.com/vm0-ai/vm0/commit/a0e7072ff052a3b7219177601493a710fb3f02bf)), closes [#20908](https://github.com/vm0-ai/vm0/issues/20908)

## [0.37.104](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.103...sandbox-fc-v0.37.104) (2026-07-10)


### Refactoring

* **sandbox-fc:** move sandbox tests to external module ([#20947](https://github.com/vm0-ai/vm0/issues/20947)) ([2eb47f1](https://github.com/vm0-ai/vm0/commit/2eb47f1ea994c85fd1bc8aa34ef2478bc59f1c27))

## [0.37.103](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.102...sandbox-fc-v0.37.103) (2026-07-10)

## [0.37.102](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.101...sandbox-fc-v0.37.102) (2026-07-09)

## [0.37.101](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.100...sandbox-fc-v0.37.101) (2026-07-09)

## [0.37.100](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.99...sandbox-fc-v0.37.100) (2026-07-09)

## [0.37.99](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.98...sandbox-fc-v0.37.99) (2026-07-08)


### Performance Improvements

* add fresh sandbox factory stage telemetry ([#20689](https://github.com/vm0-ai/vm0/issues/20689)) ([d33d7cb](https://github.com/vm0-ai/vm0/commit/d33d7cb235410c3080092de8ee2117d081b19308))

## [0.37.98](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.97...sandbox-fc-v0.37.98) (2026-07-08)

## [0.37.97](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.96...sandbox-fc-v0.37.97) (2026-07-07)

## [0.37.96](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.95...sandbox-fc-v0.37.96) (2026-07-06)


### Refactoring

* clarify sandbox process pid naming ([#20372](https://github.com/vm0-ai/vm0/issues/20372)) ([c32d846](https://github.com/vm0-ai/vm0/commit/c32d846f655bd32dea0fde2a561a34eb014128dd))

## [0.37.95](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.94...sandbox-fc-v0.37.95) (2026-07-06)

## [0.37.94](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.93...sandbox-fc-v0.37.94) (2026-07-06)

## [0.37.93](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.92...sandbox-fc-v0.37.93) (2026-07-06)

## [0.37.92](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.91...sandbox-fc-v0.37.92) (2026-07-06)


### Documentation

* clarify netns pool idle retention policy ([#20282](https://github.com/vm0-ai/vm0/issues/20282)) ([b567c37](https://github.com/vm0-ai/vm0/commit/b567c3740d6a02551c1cc27f5c6b36c33e1a3ef8))

## [0.37.91](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.90...sandbox-fc-v0.37.91) (2026-07-05)

## [0.37.90](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.89...sandbox-fc-v0.37.90) (2026-07-05)


### Performance Improvements

* **sandbox-fc:** refill netns pool to buffer ([#20248](https://github.com/vm0-ai/vm0/issues/20248)) ([5cf9419](https://github.com/vm0-ai/vm0/commit/5cf9419a4d10dfcfed5cb4c2b8c664ffe1f90b92))

## [0.37.89](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.88...sandbox-fc-v0.37.89) (2026-07-05)

## [0.37.88](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.87...sandbox-fc-v0.37.88) (2026-07-03)

## [0.37.87](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.86...sandbox-fc-v0.37.87) (2026-07-01)


### Bug Fixes

* accept pressure-limited balloon settle ([#19662](https://github.com/vm0-ai/vm0/issues/19662)) ([6e57ce0](https://github.com/vm0-ai/vm0/commit/6e57ce0a39799d18e71c4e194fda398b4fc5aed7))

## [0.37.86](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.85...sandbox-fc-v0.37.86) (2026-07-01)

## [0.37.85](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.84...sandbox-fc-v0.37.85) (2026-07-01)

## [0.37.84](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.83...sandbox-fc-v0.37.84) (2026-07-01)

## [0.37.83](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.82...sandbox-fc-v0.37.83) (2026-06-30)

## [0.37.82](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.81...sandbox-fc-v0.37.82) (2026-06-30)

## [0.37.81](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.80...sandbox-fc-v0.37.81) (2026-06-30)

## [0.37.80](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.79...sandbox-fc-v0.37.80) (2026-06-30)

## [0.37.79](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.78...sandbox-fc-v0.37.79) (2026-06-30)

## [0.37.78](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.77...sandbox-fc-v0.37.78) (2026-06-30)

## [0.37.77](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.76...sandbox-fc-v0.37.77) (2026-06-29)


### Refactoring

* **sandbox-fc:** extract state and snapshot restore helpers ([#19343](https://github.com/vm0-ai/vm0/issues/19343)) ([e16fffa](https://github.com/vm0-ai/vm0/commit/e16fffa9e056194b0951cb2c0ce7569356ba3fb4))

## [0.37.76](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.75...sandbox-fc-v0.37.76) (2026-06-29)

## [0.37.75](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.74...sandbox-fc-v0.37.75) (2026-06-29)

## [0.37.74](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.73...sandbox-fc-v0.37.74) (2026-06-29)

## [0.37.73](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.72...sandbox-fc-v0.37.73) (2026-06-29)

## [0.37.72](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.71...sandbox-fc-v0.37.72) (2026-06-27)

## [0.37.71](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.70...sandbox-fc-v0.37.71) (2026-06-27)

## [0.37.70](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.69...sandbox-fc-v0.37.70) (2026-06-26)


### Bug Fixes

* saturate telemetry duration milliseconds ([#19139](https://github.com/vm0-ai/vm0/issues/19139)) ([4db715c](https://github.com/vm0-ai/vm0/commit/4db715c9ed4a6469519e84bb83ff1b33917f1162))

## [0.37.69](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.68...sandbox-fc-v0.37.69) (2026-06-26)

## [0.37.68](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.67...sandbox-fc-v0.37.68) (2026-06-26)


### Performance Improvements

* **sandbox-fc:** bound host command output capture ([#19097](https://github.com/vm0-ai/vm0/issues/19097)) ([3fbd964](https://github.com/vm0-ai/vm0/commit/3fbd964950ce06bb9b880e7915b6f117b8210457))

## [0.37.67](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.66...sandbox-fc-v0.37.67) (2026-06-26)

## [0.37.66](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.65...sandbox-fc-v0.37.66) (2026-06-26)

## [0.37.65](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.64...sandbox-fc-v0.37.65) (2026-06-26)


### Bug Fixes

* add agent exit 126 diagnostics ([#19032](https://github.com/vm0-ai/vm0/issues/19032)) ([b894039](https://github.com/vm0-ai/vm0/commit/b894039c617722da0ab4a9dd1fa2f188e552c7c7))

## [0.37.64](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.63...sandbox-fc-v0.37.64) (2026-06-26)

## [0.37.63](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.62...sandbox-fc-v0.37.63) (2026-06-25)

## [0.37.62](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.61...sandbox-fc-v0.37.62) (2026-06-25)


### Refactoring

* **sandbox-fc:** split create transaction tests ([#18903](https://github.com/vm0-ai/vm0/issues/18903)) ([e30b45f](https://github.com/vm0-ai/vm0/commit/e30b45f3cbd79b87b15f30d8a7c22eeb5114c038))
* split cow pool module ([#18888](https://github.com/vm0-ai/vm0/issues/18888)) ([82c88a5](https://github.com/vm0-ai/vm0/commit/82c88a55fd27bf8a4923efb095a7bc7ec21d258e))

## [0.37.61](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.60...sandbox-fc-v0.37.61) (2026-06-25)

## [0.37.60](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.59...sandbox-fc-v0.37.60) (2026-06-25)


### Bug Fixes

* harden guest runtime private file writes ([#18797](https://github.com/vm0-ai/vm0/issues/18797)) ([f334139](https://github.com/vm0-ai/vm0/commit/f334139eec67ff4bb64d2a47c3028505bd068cdd))

## [0.37.59](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.58...sandbox-fc-v0.37.59) (2026-06-24)

## [0.37.58](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.57...sandbox-fc-v0.37.58) (2026-06-23)

## [0.37.57](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.56...sandbox-fc-v0.37.57) (2026-06-23)

## [0.37.56](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.55...sandbox-fc-v0.37.56) (2026-06-23)


### Documentation

* **sandbox-fc:** clarify netns active queue docs ([#18634](https://github.com/vm0-ai/vm0/issues/18634)) ([ad32f8e](https://github.com/vm0-ai/vm0/commit/ad32f8e7db4683c299414a381918dc302b630d0b))

## [0.37.55](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.54...sandbox-fc-v0.37.55) (2026-06-23)


### Bug Fixes

* make slow exec terminal warnings actionable ([#18619](https://github.com/vm0-ai/vm0/issues/18619)) ([ab0ce71](https://github.com/vm0-ai/vm0/commit/ab0ce71380d416da28156f15e80def1a24dd3bef))


### Documentation

* **sandbox-fc:** document create transaction lifecycle ([#18603](https://github.com/vm0-ai/vm0/issues/18603)) ([238c097](https://github.com/vm0-ai/vm0/commit/238c097be9a0911eb3c30edb0a52cd5bc743e77c))


### Refactoring

* centralize sandbox create stage timing metadata ([#18606](https://github.com/vm0-ai/vm0/issues/18606)) ([2cf73ce](https://github.com/vm0-ai/vm0/commit/2cf73ce5c01143c51ff79f3fde70d48470c30587))

## [0.37.54](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.53...sandbox-fc-v0.37.54) (2026-06-22)

## [0.37.53](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.52...sandbox-fc-v0.37.53) (2026-06-22)


### Bug Fixes

* **sandbox-fc:** harden runtime socket namespace ([#18422](https://github.com/vm0-ai/vm0/issues/18422)) ([f3dda84](https://github.com/vm0-ai/vm0/commit/f3dda84fc1c2d1758cc29ee2aefb2c72ed351972))


### Refactoring

* remove legacy exec result projections ([#18429](https://github.com/vm0-ai/vm0/issues/18429)) ([19b22fb](https://github.com/vm0-ai/vm0/commit/19b22fbde865689860394e2e9e9f699347f633b3))

## [0.37.52](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.51...sandbox-fc-v0.37.52) (2026-06-21)


### Refactoring

* expose structured remote exec termination ([#18382](https://github.com/vm0-ai/vm0/issues/18382)) ([7f1dfa6](https://github.com/vm0-ai/vm0/commit/7f1dfa6f58379465d770d0fcf0c43fc7e91d9473))

## [0.37.51](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.50...sandbox-fc-v0.37.51) (2026-06-20)


### Refactoring

* move workspace drive image preparation ([#18388](https://github.com/vm0-ai/vm0/issues/18388)) ([322b837](https://github.com/vm0-ai/vm0/commit/322b8373be5f60d45d400cd2489d71bba8f51c52))

## [0.37.50](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.49...sandbox-fc-v0.37.50) (2026-06-19)


### Refactoring

* migrate sandbox-fc exec capture to structured results ([#18334](https://github.com/vm0-ai/vm0/issues/18334)) ([3a1c368](https://github.com/vm0-ai/vm0/commit/3a1c368156f7c2fa0b43d43bb0aeb68156d0a9cf))

## [0.37.49](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.48...sandbox-fc-v0.37.49) (2026-06-19)

## [0.37.48](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.47...sandbox-fc-v0.37.48) (2026-06-19)


### Bug Fixes

* restrict runner dnsmasq listener ([#18292](https://github.com/vm0-ai/vm0/issues/18292)) ([dacb3fb](https://github.com/vm0-ai/vm0/commit/dacb3fb70df2812c3e2e790e01f588c8f8f8a4f0))

## [0.37.47](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.46...sandbox-fc-v0.37.47) (2026-06-18)

## [0.37.46](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.45...sandbox-fc-v0.37.46) (2026-06-18)

## [0.37.45](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.44...sandbox-fc-v0.37.45) (2026-06-18)

## [0.37.44](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.43...sandbox-fc-v0.37.44) (2026-06-18)

## [0.37.43](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.42...sandbox-fc-v0.37.43) (2026-06-18)

## [0.37.42](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.41...sandbox-fc-v0.37.42) (2026-06-18)


### Refactoring

* **sandbox-fc:** deduplicate create timing success logging ([#18180](https://github.com/vm0-ai/vm0/issues/18180)) ([0e2b75b](https://github.com/vm0-ai/vm0/commit/0e2b75b0c4d435adf33a7222e35edc81593a9689))

## [0.37.41](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.40...sandbox-fc-v0.37.41) (2026-06-18)

## [0.37.40](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.39...sandbox-fc-v0.37.40) (2026-06-17)

## [0.37.39](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.38...sandbox-fc-v0.37.39) (2026-06-17)


### Bug Fixes

* **sandbox-fc:** tune balloon park settle policy ([#18053](https://github.com/vm0-ai/vm0/issues/18053)) ([3be3bc8](https://github.com/vm0-ai/vm0/commit/3be3bc8679a10af62e52908ed117ba360433985d))

## [0.37.38](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.37...sandbox-fc-v0.37.38) (2026-06-17)

## [0.37.37](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.36...sandbox-fc-v0.37.37) (2026-06-17)


### Bug Fixes

* **runner:** validate benchmark env keys before startup ([#17999](https://github.com/vm0-ai/vm0/issues/17999)) ([4e6b823](https://github.com/vm0-ai/vm0/commit/4e6b823eba479c95cc7dbc8e377621f99b7ea5bf))

## [0.37.36](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.35...sandbox-fc-v0.37.36) (2026-06-17)

## [0.37.35](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.34...sandbox-fc-v0.37.35) (2026-06-16)


### Bug Fixes

* **sandbox-fc:** add balloon settle diagnostics ([#17905](https://github.com/vm0-ai/vm0/issues/17905)) ([e1414de](https://github.com/vm0-ai/vm0/commit/e1414de87fde49cf11b8c08824a097a85e505124))

## [0.37.34](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.33...sandbox-fc-v0.37.34) (2026-06-16)


### Bug Fixes

* **sandbox-fc:** validate firecracker artifact prerequisites ([#17824](https://github.com/vm0-ai/vm0/issues/17824)) ([3b607ae](https://github.com/vm0-ai/vm0/commit/3b607aea95034e78b8d50577e371de83a5c9f9dd))

## [0.37.33](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.32...sandbox-fc-v0.37.33) (2026-06-16)


### Refactoring

* **sandbox-fc:** extract control server test fixtures ([#17854](https://github.com/vm0-ai/vm0/issues/17854)) ([ab068cd](https://github.com/vm0-ai/vm0/commit/ab068cdf879a8bbd95a00d7abb9a55e164819bd2))

## [0.37.32](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.31...sandbox-fc-v0.37.32) (2026-06-16)


### Performance Improvements

* offload create rollback filesystem cleanup ([#17845](https://github.com/vm0-ai/vm0/issues/17845)) ([0ad9766](https://github.com/vm0-ai/vm0/commit/0ad97663123ba90c1ecb4f9a175a59ab5c9140ac))

## [0.37.31](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.30...sandbox-fc-v0.37.31) (2026-06-16)

## [0.37.30](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.29...sandbox-fc-v0.37.30) (2026-06-15)

## [0.37.29](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.28...sandbox-fc-v0.37.29) (2026-06-15)

## [0.37.28](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.27...sandbox-fc-v0.37.28) (2026-06-15)

## [0.37.27](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.26...sandbox-fc-v0.37.27) (2026-06-15)


### Bug Fixes

* bound factory cleanup post-abort drain ([#17630](https://github.com/vm0-ai/vm0/issues/17630)) ([3a0b07a](https://github.com/vm0-ai/vm0/commit/3a0b07af9a1735348bda16ed25fc16ed744a36f0))


### Performance Improvements

* **runner:** move workspace cache hits into sandboxes ([#17629](https://github.com/vm0-ai/vm0/issues/17629)) ([3ec0448](https://github.com/vm0-ai/vm0/commit/3ec04481481f46589b219dfbf08d80555e86ed95))

## [0.37.26](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.25...sandbox-fc-v0.37.26) (2026-06-12)

## [0.37.25](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.24...sandbox-fc-v0.37.25) (2026-06-12)


### Refactoring

* **sandbox-fc:** split firecracker api client modules ([#17445](https://github.com/vm0-ai/vm0/issues/17445)) ([366ca04](https://github.com/vm0-ai/vm0/commit/366ca04ce6151a61513f4c92a2efadc2fcc27100))

## [0.37.24](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.23...sandbox-fc-v0.37.24) (2026-06-12)


### Documentation

* clarify sandbox-fc terminate protocol ([#17387](https://github.com/vm0-ai/vm0/issues/17387)) ([f3e83e2](https://github.com/vm0-ai/vm0/commit/f3e83e20757e29ebd9a0e5986e16cb9cb58c2194))

## [0.37.23](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.22...sandbox-fc-v0.37.23) (2026-06-11)

## [0.37.22](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.21...sandbox-fc-v0.37.22) (2026-06-11)


### Documentation

* document firecracker sandbox lifecycle ([#17335](https://github.com/vm0-ai/vm0/issues/17335)) ([cecf295](https://github.com/vm0-ai/vm0/commit/cecf2959a38c95bf301634ff97a3deecbda33c9a))

## [0.37.21](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.20...sandbox-fc-v0.37.21) (2026-06-11)


### Refactoring

* split snapshot attempt cleanup module ([#17279](https://github.com/vm0-ai/vm0/issues/17279)) ([c8d48d1](https://github.com/vm0-ai/vm0/commit/c8d48d113dbdda4a80b2eced2a171cb65b0ecf78))

## [0.37.20](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.19...sandbox-fc-v0.37.20) (2026-06-11)

## [0.37.19](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.18...sandbox-fc-v0.37.19) (2026-06-10)

## [0.37.18](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.17...sandbox-fc-v0.37.18) (2026-06-09)


### Bug Fixes

* avoid stale command process group cleanup ([#16937](https://github.com/vm0-ai/vm0/issues/16937)) ([d899ed8](https://github.com/vm0-ai/vm0/commit/d899ed886ed1f10791488984557863818318cc6a))

## [0.37.17](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.16...sandbox-fc-v0.37.17) (2026-06-09)


### Bug Fixes

* clarify runner job timeout logs ([#16823](https://github.com/vm0-ai/vm0/issues/16823)) ([77edf47](https://github.com/vm0-ai/vm0/commit/77edf47a4f3c43978ea9339209d370061ec3f474))

## [0.37.16](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.15...sandbox-fc-v0.37.16) (2026-06-09)

## [0.37.15](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.14...sandbox-fc-v0.37.15) (2026-06-08)

## [0.37.14](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.13...sandbox-fc-v0.37.14) (2026-06-08)


### Refactoring

* **sandbox-fc:** clarify cow cleanup outcome ([#16635](https://github.com/vm0-ai/vm0/issues/16635)) ([63fe471](https://github.com/vm0-ai/vm0/commit/63fe471bbb2ce746ea56d1bc409e192793cfcf0d))


### Performance Improvements

* offload snapshot filesystem critical sections ([#16634](https://github.com/vm0-ai/vm0/issues/16634)) ([813774e](https://github.com/vm0-ai/vm0/commit/813774eed4b4f592aaa21d2f84296a0fb3d5442f))

## [0.37.13](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.12...sandbox-fc-v0.37.13) (2026-06-07)


### Bug Fixes

* prevent runner kill from signaling reused pids ([#16296](https://github.com/vm0-ai/vm0/issues/16296)) ([5b6c483](https://github.com/vm0-ai/vm0/commit/5b6c48301845c9267a7437b63014fcd6d75bc331))


### Documentation

* document snapshot publish cleanup semantics ([#16419](https://github.com/vm0-ai/vm0/issues/16419)) ([a0e1cf3](https://github.com/vm0-ai/vm0/commit/a0e1cf3e4f95ac6b6221728ce2c6f6fe52e9ddcd))


### Refactoring

* **sandbox-fc:** split netns pool modules ([#16454](https://github.com/vm0-ai/vm0/issues/16454)) ([4b75eb3](https://github.com/vm0-ai/vm0/commit/4b75eb39a134466fd9fea22000b94fe96718b3b9))

## [0.37.12](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.11...sandbox-fc-v0.37.12) (2026-06-05)


### Bug Fixes

* offload nbd netlink critical sections ([#16246](https://github.com/vm0-ai/vm0/issues/16246)) ([0e25bae](https://github.com/vm0-ai/vm0/commit/0e25bae1f967857478a454ba7448653a8e7cf058))

## [0.37.11](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.10...sandbox-fc-v0.37.11) (2026-06-05)

## [0.37.10](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.9...sandbox-fc-v0.37.10) (2026-06-04)

## [0.37.9](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.8...sandbox-fc-v0.37.9) (2026-06-04)


### Refactoring

* extract snapshot provider test fixtures ([#16165](https://github.com/vm0-ai/vm0/issues/16165)) ([6a5ae0b](https://github.com/vm0-ai/vm0/commit/6a5ae0bf05ee765c5986dd56ab67bf28d86440d7))

## [0.37.8](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.7...sandbox-fc-v0.37.8) (2026-06-04)

## [0.37.7](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.6...sandbox-fc-v0.37.7) (2026-06-04)

## [0.37.6](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.5...sandbox-fc-v0.37.6) (2026-06-04)

## [0.37.5](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.4...sandbox-fc-v0.37.5) (2026-06-03)

## [0.37.4](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.3...sandbox-fc-v0.37.4) (2026-06-03)

## [0.37.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.2...sandbox-fc-v0.37.3) (2026-06-03)


### Performance Improvements

* avoid duplicate netns iptables cleanup ([#15971](https://github.com/vm0-ai/vm0/issues/15971)) ([5eaef3f](https://github.com/vm0-ai/vm0/commit/5eaef3f2ebf437826be911af4713df1c064b35bc))

## [0.37.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.1...sandbox-fc-v0.37.2) (2026-06-03)

## [0.37.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.37.0...sandbox-fc-v0.37.1) (2026-06-03)

## [0.37.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.36.3...sandbox-fc-v0.37.0) (2026-06-02)


### Features

* add session workspace image cache rollout ([#15780](https://github.com/vm0-ai/vm0/issues/15780)) ([3fb331b](https://github.com/vm0-ai/vm0/commit/3fb331ba6457c9d3247e0eac03f2629ab5102d89))

## [0.36.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.36.2...sandbox-fc-v0.36.3) (2026-06-02)


### Documentation

* clarify balloon deflate memory metric ([#15865](https://github.com/vm0-ai/vm0/issues/15865)) ([cc9bf49](https://github.com/vm0-ai/vm0/commit/cc9bf49d87f0c1ee4b3ca875cb37123410f8fd1e))

## [0.36.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.36.1...sandbox-fc-v0.36.2) (2026-06-02)


### Bug Fixes

* enforce snapshot artifact file integrity ([#15835](https://github.com/vm0-ai/vm0/issues/15835)) ([e69b584](https://github.com/vm0-ai/vm0/commit/e69b5840c39dc6aa73f9f30cb1753ef0dee36d36))

## [0.36.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.36.0...sandbox-fc-v0.36.1) (2026-06-02)

## [0.36.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.23...sandbox-fc-v0.36.0) (2026-06-01)


### Features

* add canonical workspace drive foundation ([#15688](https://github.com/vm0-ai/vm0/issues/15688)) ([593460a](https://github.com/vm0-ai/vm0/commit/593460ab818768ae75d1fd658a7211a2120a956b))


### Bug Fixes

* **sandbox-fc:** guard control exec timeout overflow ([#15748](https://github.com/vm0-ai/vm0/issues/15748)) ([b633b6a](https://github.com/vm0-ai/vm0/commit/b633b6a0d07c472b9ebaf6025863e4a21b92acd4))


### Refactoring

* **sandbox-fc:** centralize snapshot cleanup resources ([#15752](https://github.com/vm0-ai/vm0/issues/15752)) ([7240b03](https://github.com/vm0-ai/vm0/commit/7240b030fe0f02b3350bc48fd7c6fefafca7474a))

## [0.35.23](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.22...sandbox-fc-v0.35.23) (2026-05-31)


### Refactoring

* split sandbox-fc control module ([#15576](https://github.com/vm0-ai/vm0/issues/15576)) ([9ec3a2d](https://github.com/vm0-ai/vm0/commit/9ec3a2dd0787c1f9e35fb00fac9a54716596db30))

## [0.35.22](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.21...sandbox-fc-v0.35.22) (2026-05-31)

## [0.35.21](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.20...sandbox-fc-v0.35.21) (2026-05-28)


### Bug Fixes

* label sandbox file operation errors ([#15303](https://github.com/vm0-ai/vm0/issues/15303)) ([dbc2ec3](https://github.com/vm0-ai/vm0/commit/dbc2ec33f982d1413f93307e933a1b48268a65a4))
* **sandbox-fc:** surface control socket scan errors ([#15302](https://github.com/vm0-ai/vm0/issues/15302)) ([e56a434](https://github.com/vm0-ai/vm0/commit/e56a43414a9a89119a7be89c659ba9d4c477f719))

## [0.35.20](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.19...sandbox-fc-v0.35.20) (2026-05-28)

## [0.35.19](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.18...sandbox-fc-v0.35.19) (2026-05-27)


### Bug Fixes

* preserve existing snapshot complete marker ([#15143](https://github.com/vm0-ai/vm0/issues/15143)) ([06b7cbf](https://github.com/vm0-ai/vm0/commit/06b7cbf96c3f28014e752b398ad2a17bb4dd1229))

## [0.35.18](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.17...sandbox-fc-v0.35.18) (2026-05-27)

## [0.35.17](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.16...sandbox-fc-v0.35.17) (2026-05-26)

## [0.35.16](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.15...sandbox-fc-v0.35.16) (2026-05-25)

## [0.35.15](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.14...sandbox-fc-v0.35.15) (2026-05-25)

## [0.35.14](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.13...sandbox-fc-v0.35.14) (2026-05-25)

## [0.35.13](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.12...sandbox-fc-v0.35.13) (2026-05-25)

## [0.35.12](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.11...sandbox-fc-v0.35.12) (2026-05-25)


### Bug Fixes

* pass guest reseed entropy over exec stdin ([#14758](https://github.com/vm0-ai/vm0/issues/14758)) ([6f9a4aa](https://github.com/vm0-ai/vm0/commit/6f9a4aac941effcad301911f5dfec055bb758667))

## [0.35.11](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.10...sandbox-fc-v0.35.11) (2026-05-25)


### Refactoring

* **sandbox-fc:** share prepare park resolution ([#14737](https://github.com/vm0-ai/vm0/issues/14737)) ([937fe50](https://github.com/vm0-ai/vm0/commit/937fe50e169f0482e36021436153d79962eafe40))

## [0.35.10](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.9...sandbox-fc-v0.35.10) (2026-05-24)

## [0.35.9](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.8...sandbox-fc-v0.35.9) (2026-05-23)

## [0.35.8](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.7...sandbox-fc-v0.35.8) (2026-05-22)


### Bug Fixes

* cancel guest process before runner cleanup ([#14537](https://github.com/vm0-ai/vm0/issues/14537)) ([55b3ab7](https://github.com/vm0-ai/vm0/commit/55b3ab78eb113e7665c6d097f5e2fdbef8b30193))

## [0.35.7](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.6...sandbox-fc-v0.35.7) (2026-05-22)


### Refactoring

* split netns pool lifecycle state ([#14504](https://github.com/vm0-ai/vm0/issues/14504)) ([38b57ab](https://github.com/vm0-ai/vm0/commit/38b57ab7a02a0a75328ba13d0235278c72e0e1d2))
* unify netns pool queue selector ([#14492](https://github.com/vm0-ai/vm0/issues/14492)) ([a92cb95](https://github.com/vm0-ai/vm0/commit/a92cb95174ccb78e3f04fa9f65a5ff170808e67d))

## [0.35.6](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.5...sandbox-fc-v0.35.6) (2026-05-21)


### Bug Fixes

* prevent workspace leak during create rename ([#14461](https://github.com/vm0-ai/vm0/issues/14461)) ([a07062e](https://github.com/vm0-ai/vm0/commit/a07062ef3eca84864e7885334df6668ec89dbfc7))

## [0.35.5](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.4...sandbox-fc-v0.35.5) (2026-05-21)


### Refactoring

* split sandbox snapshot module ([#14449](https://github.com/vm0-ai/vm0/issues/14449)) ([f58f4a3](https://github.com/vm0-ai/vm0/commit/f58f4a34b203c0763de80e51c74a3aa66cea5323))

## [0.35.4](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.3...sandbox-fc-v0.35.4) (2026-05-21)

## [0.35.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.2...sandbox-fc-v0.35.3) (2026-05-21)


### Documentation

* document sandbox-fc rate limiter fields ([#14396](https://github.com/vm0-ai/vm0/issues/14396)) ([4bbf327](https://github.com/vm0-ai/vm0/commit/4bbf327fba386bb586f8fe3262ff384d40c019f6))


### Refactoring

* remove legacy spawn process protocol ([#14315](https://github.com/vm0-ai/vm0/issues/14315)) ([eecb69f](https://github.com/vm0-ai/vm0/commit/eecb69fbba0b5a16b0cd804698613303655dcb7e))
* share snapshot cleanup result handling ([#14398](https://github.com/vm0-ai/vm0/issues/14398)) ([8bdd8f8](https://github.com/vm0-ai/vm0/commit/8bdd8f8ad0bed994d61044934867d6652c7137e4))

## [0.35.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.1...sandbox-fc-v0.35.2) (2026-05-20)


### Refactoring

* migrate sandbox runner processes to supervised exec ([#14231](https://github.com/vm0-ai/vm0/issues/14231)) ([7781715](https://github.com/vm0-ai/vm0/commit/77817154bd0b4aad08d58fc6f41dc2643f07c76c))

## [0.35.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.35.0...sandbox-fc-v0.35.1) (2026-05-20)

## [0.35.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.34.5...sandbox-fc-v0.35.0) (2026-05-20)


### Features

* **runner:** add firecracker io limiters ([#13585](https://github.com/vm0-ai/vm0/issues/13585)) ([653b854](https://github.com/vm0-ai/vm0/commit/653b854613580861d503848a3eeffff98fe75095))

## [0.34.5](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.34.4...sandbox-fc-v0.34.5) (2026-05-19)

## [0.34.4](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.34.3...sandbox-fc-v0.34.4) (2026-05-19)


### Bug Fixes

* reject malformed firecracker netns names ([#13964](https://github.com/vm0-ai/vm0/issues/13964)) ([637aa3f](https://github.com/vm0-ai/vm0/commit/637aa3ff0b2f6e059d26445c6a6eec4e3858d695))


### Refactoring

* remove sandbox-fc operation lease mirror ([#13961](https://github.com/vm0-ai/vm0/issues/13961)) ([c175dc4](https://github.com/vm0-ai/vm0/commit/c175dc4d9ac88556deecbdc5193837ce28b2b0e5))

## [0.34.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.34.2...sandbox-fc-v0.34.3) (2026-05-19)


### Refactoring

* fence normal operations during sandbox park ([#13898](https://github.com/vm0-ai/vm0/issues/13898)) ([00358eb](https://github.com/vm0-ai/vm0/commit/00358ebbe2bce58f5081cb4b98c5e57958f947c3))

## [0.34.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.34.1...sandbox-fc-v0.34.2) (2026-05-19)


### Refactoring

* gate process control requests ([#13845](https://github.com/vm0-ai/vm0/issues/13845)) ([9dc1d33](https://github.com/vm0-ai/vm0/commit/9dc1d33ddb9fb1e2d479c574ebf85afd61cb45b8))

## [0.34.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.34.0...sandbox-fc-v0.34.1) (2026-05-18)


### Performance Improvements

* offload cow slot teardown ([#13677](https://github.com/vm0-ai/vm0/issues/13677)) ([4060d0d](https://github.com/vm0-ai/vm0/commit/4060d0d99f72139aa68d0ffb82ca5fcfee70b208))

## [0.34.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.33.5...sandbox-fc-v0.34.0) (2026-05-17)


### Features

* wire operation-bound process control to guest-agent ([#13538](https://github.com/vm0-ai/vm0/issues/13538)) ([3bc2ee1](https://github.com/vm0-ai/vm0/commit/3bc2ee1dda51d68c6825a1a71bf44edbc9692a0d))

## [0.33.5](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.33.4...sandbox-fc-v0.33.5) (2026-05-16)

## [0.33.4](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.33.3...sandbox-fc-v0.33.4) (2026-05-15)

## [0.33.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.33.2...sandbox-fc-v0.33.3) (2026-05-15)

## [0.33.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.33.1...sandbox-fc-v0.33.2) (2026-05-15)


### Refactoring

* rename vsock command operation ([#13465](https://github.com/vm0-ai/vm0/issues/13465)) ([bd1742b](https://github.com/vm0-ai/vm0/commit/bd1742b001bec3edf81cd5daf410294f722315e6))

## [0.33.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.33.0...sandbox-fc-v0.33.1) (2026-05-15)


### Refactoring

* rename spawn watch to spawn process ([#13369](https://github.com/vm0-ai/vm0/issues/13369)) ([e007f30](https://github.com/vm0-ai/vm0/commit/e007f30a2610056a6905e4a38bcc2d894895ffa4))

## [0.33.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.32.1...sandbox-fc-v0.33.0) (2026-05-15)


### Features

* gate sandbox park with ReadyForPark ([#13346](https://github.com/vm0-ai/vm0/issues/13346)) ([dd87143](https://github.com/vm0-ai/vm0/commit/dd87143a9b2955ff93820b5efa3d32d01f857f63))

## [0.32.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.32.0...sandbox-fc-v0.32.1) (2026-05-14)

## [0.32.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.31.0...sandbox-fc-v0.32.0) (2026-05-14)


### Features

* **sandbox-fc:** gate guest operations for park ([#13322](https://github.com/vm0-ai/vm0/issues/13322)) ([d0cf16d](https://github.com/vm0-ai/vm0/commit/d0cf16daaa47dbcfe7413a87b3b568b26ff5210a))


### Documentation

* **sandbox-fc:** document exec control payloads ([#13340](https://github.com/vm0-ai/vm0/issues/13340)) ([756b847](https://github.com/vm0-ai/vm0/commit/756b847e753898e6e4ea928187852a7d20948f21))

## [0.31.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.30.3...sandbox-fc-v0.31.0) (2026-05-14)


### Features

* add ReadyForPark coordinator skeleton ([#13294](https://github.com/vm0-ai/vm0/issues/13294)) ([eb1d67f](https://github.com/vm0-ai/vm0/commit/eb1d67f52b9af4aee976584c3b7bb931d5b35e16))


### Refactoring

* type factory lifecycle resources ([#13293](https://github.com/vm0-ai/vm0/issues/13293)) ([0b533c7](https://github.com/vm0-ai/vm0/commit/0b533c76f86e651b09d662cb9c85a8c3a3d06ad5))

## [0.30.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.30.2...sandbox-fc-v0.30.3) (2026-05-14)


### Bug Fixes

* suppress expected command exits ([#13270](https://github.com/vm0-ai/vm0/issues/13270)) ([2132288](https://github.com/vm0-ai/vm0/commit/213228850c442d9ba480acb31810a940687e572f))
* **vsock:** route spawn_watch lifecycle by sequence ([#13220](https://github.com/vm0-ai/vm0/issues/13220)) ([373d2ab](https://github.com/vm0-ai/vm0/commit/373d2ab0c2312e9f888c2d9780bcef71386f42cd))

## [0.30.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.30.1...sandbox-fc-v0.30.2) (2026-05-14)

## [0.30.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.30.0...sandbox-fc-v0.30.1) (2026-05-13)

## [0.30.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.29.8...sandbox-fc-v0.30.0) (2026-05-13)


### Features

* add bounded exec output policies ([#12292](https://github.com/vm0-ai/vm0/issues/12292)) ([71f6ad9](https://github.com/vm0-ai/vm0/commit/71f6ad9aaadaa9bf6589a5915c51ab4c092547eb))


### Bug Fixes

* avoid blocking concurrent COW slot acquisition ([#13036](https://github.com/vm0-ai/vm0/issues/13036)) ([79143ac](https://github.com/vm0-ai/vm0/commit/79143ac7edd164b026a2c894b3681ccb89f8ec50))


### Documentation

* document bounded exec preference ([#12599](https://github.com/vm0-ai/vm0/issues/12599)) ([70aa4eb](https://github.com/vm0-ai/vm0/commit/70aa4eb5444809dc49132cc003278eb2bd504a39))
* **sandbox-fc:** document path helpers ([#13110](https://github.com/vm0-ai/vm0/issues/13110)) ([b94343f](https://github.com/vm0-ai/vm0/commit/b94343f19ae249c459b2dd52087f46472fbacb70))


### Refactoring

* derive cow pool pipeline slot accounting ([#13057](https://github.com/vm0-ai/vm0/issues/13057)) ([467d3b8](https://github.com/vm0-ai/vm0/commit/467d3b88a768857f7158703e214834930ff56fbc))
* route sandbox exec through command operations ([#13018](https://github.com/vm0-ai/vm0/issues/13018)) ([0e5f862](https://github.com/vm0-ai/vm0/commit/0e5f862ee8e2182e23a88df6187f194171004b1f))
* **runner:** migrate internal execs to bounded exec ([#12322](https://github.com/vm0-ai/vm0/issues/12322)) ([f0b84b4](https://github.com/vm0-ai/vm0/commit/f0b84b4f09bad9abc16074af3f0190944bba3d04))
* **runner:** stream exec over bounded exec ([#12518](https://github.com/vm0-ai/vm0/issues/12518)) ([ee551da](https://github.com/vm0-ai/vm0/commit/ee551dabe2c464564a576580a9d8811453ffd08d))
* **sandbox-fc:** keep netns pool internals private ([#13119](https://github.com/vm0-ai/vm0/issues/13119)) ([15b09ec](https://github.com/vm0-ai/vm0/commit/15b09ec0bb44695613dc2de0013da6b0851c09e8))
* split Firecracker factory modules ([#13037](https://github.com/vm0-ai/vm0/issues/13037)) ([bc13e7c](https://github.com/vm0-ai/vm0/commit/bc13e7c5833ecc5ecf23216f5c8f808a5d97d752))

## [0.29.8](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.29.7...sandbox-fc-v0.29.8) (2026-05-13)

## [0.29.7](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.29.6...sandbox-fc-v0.29.7) (2026-05-13)


### Documentation

* **sandbox-fc:** document path helpers ([#13110](https://github.com/vm0-ai/vm0/issues/13110)) ([b94343f](https://github.com/vm0-ai/vm0/commit/b94343f19ae249c459b2dd52087f46472fbacb70))


### Refactoring

* **sandbox-fc:** keep netns pool internals private ([#13119](https://github.com/vm0-ai/vm0/issues/13119)) ([15b09ec](https://github.com/vm0-ai/vm0/commit/15b09ec0bb44695613dc2de0013da6b0851c09e8))

## [0.29.6](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.29.5...sandbox-fc-v0.29.6) (2026-05-13)


### Bug Fixes

* avoid blocking concurrent COW slot acquisition ([#13036](https://github.com/vm0-ai/vm0/issues/13036)) ([79143ac](https://github.com/vm0-ai/vm0/commit/79143ac7edd164b026a2c894b3681ccb89f8ec50))


### Refactoring

* derive cow pool pipeline slot accounting ([#13057](https://github.com/vm0-ai/vm0/issues/13057)) ([467d3b8](https://github.com/vm0-ai/vm0/commit/467d3b88a768857f7158703e214834930ff56fbc))
* route sandbox exec through command operations ([#13018](https://github.com/vm0-ai/vm0/issues/13018)) ([0e5f862](https://github.com/vm0-ai/vm0/commit/0e5f862ee8e2182e23a88df6187f194171004b1f))

## [0.29.5](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.29.4...sandbox-fc-v0.29.5) (2026-05-12)


### Refactoring

* split Firecracker factory modules ([#13037](https://github.com/vm0-ai/vm0/issues/13037)) ([bc13e7c](https://github.com/vm0-ai/vm0/commit/bc13e7c5833ecc5ecf23216f5c8f808a5d97d752))

## [0.29.4](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.29.3...sandbox-fc-v0.29.4) (2026-05-12)

## [0.29.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.29.2...sandbox-fc-v0.29.3) (2026-05-12)

## [0.29.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.29.1...sandbox-fc-v0.29.2) (2026-05-10)


### Documentation

* document bounded exec preference ([#12599](https://github.com/vm0-ai/vm0/issues/12599)) ([70aa4eb](https://github.com/vm0-ai/vm0/commit/70aa4eb5444809dc49132cc003278eb2bd504a39))


### Refactoring

* **runner:** stream exec over bounded exec ([#12518](https://github.com/vm0-ai/vm0/issues/12518)) ([ee551da](https://github.com/vm0-ai/vm0/commit/ee551dabe2c464564a576580a9d8811453ffd08d))

## [0.29.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.29.0...sandbox-fc-v0.29.1) (2026-05-09)


### Refactoring

* **runner:** migrate internal execs to bounded exec ([#12322](https://github.com/vm0-ai/vm0/issues/12322)) ([f0b84b4](https://github.com/vm0-ai/vm0/commit/f0b84b4f09bad9abc16074af3f0190944bba3d04))

## [0.29.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.28.2...sandbox-fc-v0.29.0) (2026-05-09)


### Features

* add bounded exec output policies ([#12292](https://github.com/vm0-ai/vm0/issues/12292)) ([71f6ad9](https://github.com/vm0-ai/vm0/commit/71f6ad9aaadaa9bf6589a5915c51ab4c092547eb))

## [0.28.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.28.1...sandbox-fc-v0.28.2) (2026-05-09)

## [0.28.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.28.0...sandbox-fc-v0.28.1) (2026-05-09)

## [0.28.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.22...sandbox-fc-v0.28.0) (2026-05-08)


### Features

* **sandbox:** wire bounded exec through host and firecracker sandbox ([#12203](https://github.com/vm0-ai/vm0/issues/12203)) ([71602f2](https://github.com/vm0-ai/vm0/commit/71602f22f27413438b63fb6f830b1653497189b1))

## [0.27.22](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.21...sandbox-fc-v0.27.22) (2026-05-08)


### Documentation

* **sandbox-fc:** document config types ([#12172](https://github.com/vm0-ai/vm0/issues/12172)) ([a63455e](https://github.com/vm0-ai/vm0/commit/a63455e6901742692e7b9ff3995e0094e71979f3))

## [0.27.21](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.20...sandbox-fc-v0.27.21) (2026-05-08)

## [0.27.20](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.19...sandbox-fc-v0.27.20) (2026-05-07)


### Refactoring

* **runner:** split snapshot publish boundary ([#12044](https://github.com/vm0-ai/vm0/issues/12044)) ([b01e205](https://github.com/vm0-ai/vm0/commit/b01e205e530cb9a6ed5353294077d9a80b70da62))

## [0.27.19](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.18...sandbox-fc-v0.27.19) (2026-05-07)


### Documentation

* **sandbox-fc:** document guest network invariant ([#12060](https://github.com/vm0-ai/vm0/issues/12060)) ([fc43716](https://github.com/vm0-ai/vm0/commit/fc437163ac6caed3a1d4edbe08159fb4868fa782))

## [0.27.18](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.17...sandbox-fc-v0.27.18) (2026-05-07)


### Documentation

* **sandbox:** add crate-level docs ([#12011](https://github.com/vm0-ai/vm0/issues/12011)) ([cdbb13d](https://github.com/vm0-ai/vm0/commit/cdbb13d1b68b4f3f8ae5b63c6e1166e6bc0f8f65))


### Refactoring

* **sandbox-fc:** add runtime handle owner ([#12000](https://github.com/vm0-ai/vm0/issues/12000)) ([2cf36c0](https://github.com/vm0-ai/vm0/commit/2cf36c0d70e43f63a9a49338293565b2b1b53344))
* **sandbox-fc:** wrap balloon controller handle ([#12013](https://github.com/vm0-ai/vm0/issues/12013)) ([8882df7](https://github.com/vm0-ai/vm0/commit/8882df7fca7b21db4781edb90a35b37141af435d))

## [0.27.17](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.16...sandbox-fc-v0.27.17) (2026-05-06)


### Refactoring

* **sandbox-fc:** own process log readers ([#11985](https://github.com/vm0-ai/vm0/issues/11985)) ([dcbbc6d](https://github.com/vm0-ai/vm0/commit/dcbbc6dc14fb766e170bd724c961db5dd6b2e5b1))

## [0.27.16](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.15...sandbox-fc-v0.27.16) (2026-05-06)


### Bug Fixes

* **sandbox-fc:** make snapshot publish cancellation-safe ([#11965](https://github.com/vm0-ai/vm0/issues/11965)) ([5dba364](https://github.com/vm0-ai/vm0/commit/5dba364d38a5492e522549ab381415bcb03487a7))

## [0.27.15](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.14...sandbox-fc-v0.27.15) (2026-05-06)


### Refactoring

* **sandbox-fc:** add factory cleanup task group ([#11922](https://github.com/vm0-ai/vm0/issues/11922)) ([9751119](https://github.com/vm0-ai/vm0/commit/9751119e3424a26046a5ca304e9d352a75ec7a04))

## [0.27.14](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.13...sandbox-fc-v0.27.14) (2026-05-06)

## [0.27.13](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.12...sandbox-fc-v0.27.13) (2026-05-06)


### Bug Fixes

* **sandbox-fc:** require snapshot publish marker ([#11867](https://github.com/vm0-ai/vm0/issues/11867)) ([023ae4d](https://github.com/vm0-ai/vm0/commit/023ae4d86570157504a176372727cab05f5b1483))

## [0.27.12](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.11...sandbox-fc-v0.27.12) (2026-05-05)


### Refactoring

* **sandbox-fc:** add snapshot cleanup Drop finalizer ([#11843](https://github.com/vm0-ai/vm0/issues/11843)) ([8c3bfdd](https://github.com/vm0-ai/vm0/commit/8c3bfdd257b592737d39eecf5c6eacb1ca2ee861))

## [0.27.11](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.10...sandbox-fc-v0.27.11) (2026-05-05)


### Refactoring

* **sandbox-fc:** dedupe pipe collection ([#11813](https://github.com/vm0-ai/vm0/issues/11813)) ([479117e](https://github.com/vm0-ai/vm0/commit/479117ea14d473805446e4364e69d047f90fb6b0))
* **sandbox-fc:** extract snapshot cleanup helpers ([#11821](https://github.com/vm0-ai/vm0/issues/11821)) ([65fe05b](https://github.com/vm0-ai/vm0/commit/65fe05b6fa896d9ddb063fae1c2bb9e40eebfa1d))
* **sandbox-fc:** introduce snapshot attempt owner ([#11829](https://github.com/vm0-ai/vm0/issues/11829)) ([93bec65](https://github.com/vm0-ai/vm0/commit/93bec65f3036a4816ba6d9dc16dc2ec22728cde3))

## [0.27.10](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.9...sandbox-fc-v0.27.10) (2026-05-03)


### Bug Fixes

* **nbd-cow:** lock NBD claims across runners ([#11732](https://github.com/vm0-ai/vm0/issues/11732)) ([16d716e](https://github.com/vm0-ai/vm0/commit/16d716e1f07a77c0d93649f52d077953dd62ff16))

## [0.27.9](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.8...sandbox-fc-v0.27.9) (2026-05-03)


### Documentation

* **sandbox-fc:** document network errors ([#11724](https://github.com/vm0-ai/vm0/issues/11724)) ([ab92ae8](https://github.com/vm0-ai/vm0/commit/ab92ae8c69d2c99cad1c204d3c569e909f7dfdc9))

## [0.27.8](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.7...sandbox-fc-v0.27.8) (2026-05-03)

## [0.27.7](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.6...sandbox-fc-v0.27.7) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.27.6](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.5...sandbox-fc-v0.27.6) (2026-05-01)


### Refactoring

* **sandbox-fc:** avoid shared netns pool lock waits ([#11598](https://github.com/vm0-ai/vm0/issues/11598)) ([2dc1c57](https://github.com/vm0-ai/vm0/commit/2dc1c57ff13d56c28ebcbe152d20a9f4ac1f0bd7))

## [0.27.5](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.4...sandbox-fc-v0.27.5) (2026-04-30)


### Refactoring

* **sandbox-fc:** introduce netns lease ownership ([#11560](https://github.com/vm0-ai/vm0/issues/11560)) ([6562e9d](https://github.com/vm0-ai/vm0/commit/6562e9db08189bf5216e0263a0700460a4892929))

## [0.27.4](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.3...sandbox-fc-v0.27.4) (2026-04-29)


### Refactoring

* **nbd-cow:** tie device pool leases to COW lifecycle ([#11480](https://github.com/vm0-ai/vm0/issues/11480)) ([b99a732](https://github.com/vm0-ai/vm0/commit/b99a732e7732af47b5837dc3937eeb3acdf71b2e))

## [0.27.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.2...sandbox-fc-v0.27.3) (2026-04-29)


### Documentation

* **sandbox-fc:** document public path helpers ([#11516](https://github.com/vm0-ai/vm0/issues/11516)) ([9af94e5](https://github.com/vm0-ai/vm0/commit/9af94e5365869b35109b79fa4aaebc491a0414f3))
* **sandbox-fc:** document snapshot error variants ([#11535](https://github.com/vm0-ai/vm0/issues/11535)) ([f9d5625](https://github.com/vm0-ai/vm0/commit/f9d5625227abb29245b0048e4052d9a6f7592157))

## [0.27.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.1...sandbox-fc-v0.27.2) (2026-04-29)


### Documentation

* **sandbox-fc:** document snapshot prewarm step ([#11513](https://github.com/vm0-ai/vm0/issues/11513)) ([2ae4231](https://github.com/vm0-ai/vm0/commit/2ae423120793b67bad9318253a10c200bd88de20))

## [0.27.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.27.0...sandbox-fc-v0.27.1) (2026-04-29)


### Bug Fixes

* **runner:** clean up outer job panic bookkeeping ([#11393](https://github.com/vm0-ai/vm0/issues/11393)) ([4ecf0b6](https://github.com/vm0-ai/vm0/commit/4ecf0b65e25c66a86eec0151a29dd4f0fa0deeb0))
* shut down control server with sandbox runtime ([#11443](https://github.com/vm0-ai/vm0/issues/11443)) ([6b5d0cf](https://github.com/vm0-ai/vm0/commit/6b5d0cf7cca922494a02c3790f57f2e8bf4421af))

## [0.27.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.26.14...sandbox-fc-v0.27.0) (2026-04-28)


### Features

* **rootfs:** install codex cli binary in sandbox image ([#11425](https://github.com/vm0-ai/vm0/issues/11425)) ([00914b9](https://github.com/vm0-ai/vm0/commit/00914b9c1d98027f8ca2901df58ce4e0653cfba6)), closes [#11416](https://github.com/vm0-ai/vm0/issues/11416)

## [0.26.14](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.26.13...sandbox-fc-v0.26.14) (2026-04-28)


### Bug Fixes

* bind control socket before sandbox running ([#11394](https://github.com/vm0-ai/vm0/issues/11394)) ([aa1f515](https://github.com/vm0-ai/vm0/commit/aa1f5154a1bf22e1ef46037c9f02b2ffe2c6a1a0))

## [0.26.13](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.26.12...sandbox-fc-v0.26.13) (2026-04-28)


### Refactoring

* **sandbox-fc:** centralize snapshot error adapter ([#11267](https://github.com/vm0-ai/vm0/issues/11267)) ([c62afd1](https://github.com/vm0-ai/vm0/commit/c62afd1ef028c3e56434469b29f4306dcd03497e))

## [0.26.12](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.26.11...sandbox-fc-v0.26.12) (2026-04-27)

## [0.26.11](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.26.10...sandbox-fc-v0.26.11) (2026-04-27)


### Documentation

* **sandbox-fc:** explain balloon tolerance scope ([#11217](https://github.com/vm0-ai/vm0/issues/11217)) ([f9f2e1b](https://github.com/vm0-ai/vm0/commit/f9f2e1b86900b3ac1bb2e7c7d0a885f3ca17f76d))


### Refactoring

* **sandbox-fc:** encapsulate leak cleanup task ([#11239](https://github.com/vm0-ai/vm0/issues/11239)) ([f1cd276](https://github.com/vm0-ai/vm0/commit/f1cd276e5e8927572acc11064e60eca896f65009))

## [0.26.10](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.26.9...sandbox-fc-v0.26.10) (2026-04-27)


### Bug Fixes

* **runner:** make idle vm budget release panic-safe ([#11191](https://github.com/vm0-ai/vm0/issues/11191)) ([52e085f](https://github.com/vm0-ai/vm0/commit/52e085fb6e53623b5920fbfee58ccc71d8d760ae))
* **sandbox-fc:** persist backend crash state ([#11192](https://github.com/vm0-ai/vm0/issues/11192)) ([57c4222](https://github.com/vm0-ai/vm0/commit/57c4222d68327eac25a3a96f8256c8cc2275fc24))


### Refactoring

* **sandbox-fc:** model prerequisites by capability ([#11180](https://github.com/vm0-ai/vm0/issues/11180)) ([a4cf47a](https://github.com/vm0-ai/vm0/commit/a4cf47a97ec8a3300e53647aacc3f0e380c03b7b))
* **sandbox:** clarify error taxonomy ([#11178](https://github.com/vm0-ai/vm0/issues/11178)) ([f766059](https://github.com/vm0-ai/vm0/commit/f7660591f6866336a78803225653fd738667c036))

## [0.26.9](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.26.8...sandbox-fc-v0.26.9) (2026-04-26)


### Refactoring

* **sandbox-fc:** remove unused prerequisite config ([#11173](https://github.com/vm0-ai/vm0/issues/11173)) ([e2acce9](https://github.com/vm0-ai/vm0/commit/e2acce90cc2d9c0d1021d7a0156c6a3d7e755218))

## [0.26.8](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.26.7...sandbox-fc-v0.26.8) (2026-04-25)


### Documentation

* **sandbox-fc:** refresh reconcile comment after [#10826](https://github.com/vm0-ai/vm0/issues/10826) closed ([#11073](https://github.com/vm0-ai/vm0/issues/11073)) ([09b6a9c](https://github.com/vm0-ai/vm0/commit/09b6a9c5ef3b0d4668f12218849182a127a111e8))

## [0.26.7](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.26.6...sandbox-fc-v0.26.7) (2026-04-24)


### Refactoring

* **sandbox-fc:** trim verbose panic boilerplate in api tests ([#10955](https://github.com/vm0-ai/vm0/issues/10955)) ([170ddde](https://github.com/vm0-ai/vm0/commit/170ddde1ffd2d503c679e33f8876a60f92899b4d))

## [0.26.6](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.26.5...sandbox-fc-v0.26.6) (2026-04-23)


### Bug Fixes

* **sandbox-fc:** reconcile orphan netns from idle pool indexes at startup ([#10841](https://github.com/vm0-ai/vm0/issues/10841)) ([cd3d6f9](https://github.com/vm0-ai/vm0/commit/cd3d6f91d18845b954689362e2cc30b4a5ec8463))

## [0.26.5](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.26.4...sandbox-fc-v0.26.5) (2026-04-23)

## [0.26.4](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.26.3...sandbox-fc-v0.26.4) (2026-04-23)

## [0.26.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.26.2...sandbox-fc-v0.26.3) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.26.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.26.1...sandbox-fc-v0.26.2) (2026-04-20)

## [0.26.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.26.0...sandbox-fc-v0.26.1) (2026-04-18)


### Bug Fixes

* **sandbox-fc:** fail snapshot when destroy_keep_cow retries exhaust ([#9870](https://github.com/vm0-ai/vm0/issues/9870)) ([c0c4120](https://github.com/vm0-ai/vm0/commit/c0c41201de5362b982295b498476bcfbffe5bebc))

## [0.26.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.25.8...sandbox-fc-v0.26.0) (2026-04-17)


### Features

* **runner:** inflate sandbox balloon when parked in idle pool ([#9118](https://github.com/vm0-ai/vm0/issues/9118)) ([628032d](https://github.com/vm0-ai/vm0/commit/628032dbf3543d3387b6559263c31ee273f24986))
* **sandbox-fc:** pause vcpus while sandbox is parked in idle pool ([#9306](https://github.com/vm0-ai/vm0/issues/9306)) ([b7f322e](https://github.com/vm0-ai/vm0/commit/b7f322e247cddb12a061c8639f64efa0fb81f619))


### Bug Fixes

* **sandbox-fc:** add drop impl to firecracker factory ([#8962](https://github.com/vm0-ai/vm0/issues/8962)) ([c641d97](https://github.com/vm0-ai/vm0/commit/c641d97b49d70427b977a2228a053d862efd78e3))
* **sandbox-fc:** fsync output directory after snapshot finalization ([#9839](https://github.com/vm0-ai/vm0/issues/9839)) ([3197baf](https://github.com/vm0-ai/vm0/commit/3197baf1de15f08b8c21d4ab79a47d96d7527542)), closes [#9825](https://github.com/vm0-ai/vm0/issues/9825)


### Documentation

* **sandbox-fc:** note firecracker v1.14.1 fsyncs snapshot files ([#9844](https://github.com/vm0-ai/vm0/issues/9844)) ([855e02d](https://github.com/vm0-ai/vm0/commit/855e02d1570d1f73a15909b0ccb115b62c7ea568))


### Refactoring

* **runner:** make sandbox_id a first-class identity distinct from run_id ([#9555](https://github.com/vm0-ai/vm0/issues/9555)) ([9cfd2a8](https://github.com/vm0-ai/vm0/commit/9cfd2a8d239f1c54c3c8e25c9adb2759d9b12efa))
* **runner:** split image hash into rootfs_hash and snapshot_hash ([#9622](https://github.com/vm0-ai/vm0/issues/9622)) ([bbeaa44](https://github.com/vm0-ai/vm0/commit/bbeaa44f59d3066caa78348c45f98617fda18b02))
* **sandbox-fc:** spawn snapshot-creation firecracker in unshare --mount ([#9506](https://github.com/vm0-ai/vm0/issues/9506)) ([9b40cec](https://github.com/vm0-ai/vm0/commit/9b40cec89aa5a987f0f9bc7b5f9ab1fde148bc21)), closes [#9494](https://github.com/vm0-ai/vm0/issues/9494)


### Performance Improvements

* **sandbox-fc:** skip plain namespace pre-warm when proxy is configured ([#9098](https://github.com/vm0-ai/vm0/issues/9098)) ([9e06657](https://github.com/vm0-ai/vm0/commit/9e066579779edf8af5242b3bfd0d83b5d2294584)), closes [#9065](https://github.com/vm0-ai/vm0/issues/9065)

## [0.25.8](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.25.7...sandbox-fc-v0.25.8) (2026-04-17)


### Bug Fixes

* **sandbox-fc:** fsync output directory after snapshot finalization ([#9839](https://github.com/vm0-ai/vm0/issues/9839)) ([3197baf](https://github.com/vm0-ai/vm0/commit/3197baf1de15f08b8c21d4ab79a47d96d7527542)), closes [#9825](https://github.com/vm0-ai/vm0/issues/9825)


### Documentation

* **sandbox-fc:** note firecracker v1.14.1 fsyncs snapshot files ([#9844](https://github.com/vm0-ai/vm0/issues/9844)) ([855e02d](https://github.com/vm0-ai/vm0/commit/855e02d1570d1f73a15909b0ccb115b62c7ea568))

## [0.25.7](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.25.6...sandbox-fc-v0.25.7) (2026-04-17)

## [0.25.6](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.25.5...sandbox-fc-v0.25.6) (2026-04-17)

## [0.25.5](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.25.4...sandbox-fc-v0.25.5) (2026-04-17)

## [0.25.4](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.25.3...sandbox-fc-v0.25.4) (2026-04-16)


### Refactoring

* **runner:** split image hash into rootfs_hash and snapshot_hash ([#9622](https://github.com/vm0-ai/vm0/issues/9622)) ([bbeaa44](https://github.com/vm0-ai/vm0/commit/bbeaa44f59d3066caa78348c45f98617fda18b02))

## [0.25.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.25.2...sandbox-fc-v0.25.3) (2026-04-16)


### Refactoring

* **runner:** make sandbox_id a first-class identity distinct from run_id ([#9555](https://github.com/vm0-ai/vm0/issues/9555)) ([9cfd2a8](https://github.com/vm0-ai/vm0/commit/9cfd2a8d239f1c54c3c8e25c9adb2759d9b12efa))

## [0.25.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.25.1...sandbox-fc-v0.25.2) (2026-04-15)


### Refactoring

* **sandbox-fc:** spawn snapshot-creation firecracker in unshare --mount ([#9506](https://github.com/vm0-ai/vm0/issues/9506)) ([9b40cec](https://github.com/vm0-ai/vm0/commit/9b40cec89aa5a987f0f9bc7b5f9ab1fde148bc21)), closes [#9494](https://github.com/vm0-ai/vm0/issues/9494)

## [0.25.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.25.0...sandbox-fc-v0.25.1) (2026-04-14)

## [0.25.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.24.0...sandbox-fc-v0.25.0) (2026-04-14)


### Features

* **sandbox-fc:** pause vcpus while sandbox is parked in idle pool ([#9306](https://github.com/vm0-ai/vm0/issues/9306)) ([b7f322e](https://github.com/vm0-ai/vm0/commit/b7f322e247cddb12a061c8639f64efa0fb81f619))

## [0.24.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.23.4...sandbox-fc-v0.24.0) (2026-04-13)


### Features

* **runner:** inflate sandbox balloon when parked in idle pool ([#9118](https://github.com/vm0-ai/vm0/issues/9118)) ([628032d](https://github.com/vm0-ai/vm0/commit/628032dbf3543d3387b6559263c31ee273f24986))

## [0.23.4](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.23.3...sandbox-fc-v0.23.4) (2026-04-13)


### Performance Improvements

* **sandbox-fc:** skip plain namespace pre-warm when proxy is configured ([#9098](https://github.com/vm0-ai/vm0/issues/9098)) ([9e06657](https://github.com/vm0-ai/vm0/commit/9e066579779edf8af5242b3bfd0d83b5d2294584)), closes [#9065](https://github.com/vm0-ai/vm0/issues/9065)

## [0.23.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.23.2...sandbox-fc-v0.23.3) (2026-04-12)

## [0.23.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.23.1...sandbox-fc-v0.23.2) (2026-04-11)


### Bug Fixes

* **sandbox-fc:** add drop impl to firecracker factory ([#8962](https://github.com/vm0-ai/vm0/issues/8962)) ([c641d97](https://github.com/vm0-ai/vm0/commit/c641d97b49d70427b977a2228a053d862efd78e3))

## [0.23.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.23.0...sandbox-fc-v0.23.1) (2026-04-10)


### Refactoring

* **runner:** unify rootfs and snapshot into single image artifact ([#8821](https://github.com/vm0-ai/vm0/issues/8821)) ([a549299](https://github.com/vm0-ai/vm0/commit/a549299c1c10179b49783288e869f82739b58033))

## [0.23.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.22.2...sandbox-fc-v0.23.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.22.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.22.1...sandbox-fc-v0.22.2) (2026-04-07)


### Bug Fixes

* **sandbox:** recover leaked resources when sandbox is dropped without destroy ([#8347](https://github.com/vm0-ai/vm0/issues/8347)) ([581d2e8](https://github.com/vm0-ai/vm0/commit/581d2e8dff40e2c379d2dff3b78822861da728e4))

## [0.22.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.22.0...sandbox-fc-v0.22.1) (2026-04-06)

## [0.22.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.21.2...sandbox-fc-v0.22.0) (2026-04-03)


### Features

* add dns proxy for sandbox vms using dnsmasq ([#8020](https://github.com/vm0-ai/vm0/issues/8020)) ([5699f8d](https://github.com/vm0-ai/vm0/commit/5699f8dbb9008422dfe1753a2b127a6f9c100f59))

## [0.21.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.21.1...sandbox-fc-v0.21.2) (2026-04-03)

## [0.21.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.21.0...sandbox-fc-v0.21.1) (2026-04-02)


### Bug Fixes

* use is_our_thread in bench cleanup and merge snapshot pool locks ([#7763](https://github.com/vm0-ai/vm0/issues/7763)) ([654d086](https://github.com/vm0-ai/vm0/commit/654d08604135e98a247b056413bf0c7e7d5065e0))

## [0.21.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.20.3...sandbox-fc-v0.21.0) (2026-04-02)


### Features

* add device pool for pre-validated nbd device index management ([#7695](https://github.com/vm0-ai/vm0/issues/7695)) ([aae067f](https://github.com/vm0-ai/vm0/commit/aae067febb127343ce4424ae78c3c312057479c9))

## [0.20.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.20.2...sandbox-fc-v0.20.3) (2026-04-02)

## [0.20.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.20.1...sandbox-fc-v0.20.2) (2026-04-01)

## [0.20.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.20.0...sandbox-fc-v0.20.1) (2026-04-01)

## [0.20.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.19.0...sandbox-fc-v0.20.0) (2026-04-01)


### Features

* **sandbox-fc:** replace dm-snapshot with nbd-cow ([#7406](https://github.com/vm0-ai/vm0/issues/7406)) ([bc60c4b](https://github.com/vm0-ai/vm0/commit/bc60c4b01eaac368f7434d367784855b0b50479b))

## [0.19.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.18.4...sandbox-fc-v0.19.0) (2026-04-01)


### Features

* **runner:** run runner as root, remove all sudo wrappers ([#7443](https://github.com/vm0-ai/vm0/issues/7443)) ([66e9af9](https://github.com/vm0-ai/vm0/commit/66e9af9846cfdc044ec4203b04e784bbc5ea305d))

## [0.18.4](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.18.3...sandbox-fc-v0.18.4) (2026-03-31)


### Refactoring

* **sandbox-fc:** merge trait adapters into their parent modules ([#7245](https://github.com/vm0-ai/vm0/issues/7245)) ([dddab9c](https://github.com/vm0-ai/vm0/commit/dddab9c39591c765ab05c815a7969bec0a3b4b9c))

## [0.18.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.18.2...sandbox-fc-v0.18.3) (2026-03-30)


### Bug Fixes

* **sandbox-fc:** do not delete workspace after deferred cow removal ([#7225](https://github.com/vm0-ai/vm0/issues/7225)) ([4338b56](https://github.com/vm0-ai/vm0/commit/4338b56c45c77f1822ba0fee096bd9163e5818f4))

## [0.18.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.18.1...sandbox-fc-v0.18.2) (2026-03-30)


### Refactoring

* **sandbox:** introduce runtime provider trait and consolidate sandbox-fc construction ([#7173](https://github.com/vm0-ai/vm0/issues/7173)) ([6cb7c3c](https://github.com/vm0-ai/vm0/commit/6cb7c3c8ed57b4d7eb949986046d68226dc0672a)), closes [#7119](https://github.com/vm0-ai/vm0/issues/7119)

## [0.18.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.18.0...sandbox-fc-v0.18.1) (2026-03-30)


### Refactoring

* **sandbox:** introduce sandbox control trait and decouple exec/kill from sandbox-fc ([#7150](https://github.com/vm0-ai/vm0/issues/7150)) ([4615d15](https://github.com/vm0-ai/vm0/commit/4615d1571c6dbc2ba249070654112d390e83a395)), closes [#7122](https://github.com/vm0-ai/vm0/issues/7122)
* **sandbox:** introduce sandbox runtime trait and internalize shared resources ([#7125](https://github.com/vm0-ai/vm0/issues/7125)) ([43a2ba0](https://github.com/vm0-ai/vm0/commit/43a2ba0d6ee9df1022e6238913597dd4d1c11e2a))
* **sandbox:** introduce snapshot provider trait and decouple snapshot operations ([#7142](https://github.com/vm0-ai/vm0/issues/7142)) ([9a864bf](https://github.com/vm0-ai/vm0/commit/9a864bfd4ec551ead8115f4fdb30df7c5570b5fe))

## [0.18.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.17.0...sandbox-fc-v0.18.0) (2026-03-29)


### Features

* **sandbox-fc:** add cow pool to pre-warm dm-snapshot resources ([#7116](https://github.com/vm0-ai/vm0/issues/7116)) ([c841e61](https://github.com/vm0-ai/vm0/commit/c841e61bfc653d143cd6a022f03ca638b2bf5a42))

## [0.17.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.16.0...sandbox-fc-v0.17.0) (2026-03-29)


### Features

* **guest-init:** use kernel root= boot arg instead of pivot_root ([#7106](https://github.com/vm0-ai/vm0/issues/7106)) ([b373849](https://github.com/vm0-ai/vm0/commit/b373849cb331296ae7665704edd400548d67c2a5))
* **sandbox-fc:** replace guest-side overlayfs with host-side dm-snapshot cow ([#6521](https://github.com/vm0-ai/vm0/issues/6521)) ([8f6a118](https://github.com/vm0-ai/vm0/commit/8f6a1185bfd6dd4604687662f3d03be6076ea71f))


### Bug Fixes

* **crates:** update sha2/hmac usage for digest 0.11 compatibility ([#7101](https://github.com/vm0-ai/vm0/issues/7101)) ([cbded46](https://github.com/vm0-ai/vm0/commit/cbded46e78c8d3ed060e96f79f15cd38ee1cf9dc))

## [0.16.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.15.0...sandbox-fc-v0.16.0) (2026-03-25)


### Features

* **runner:** detect host-side cgroup oom kill of firecracker process ([#6630](https://github.com/vm0-ai/vm0/issues/6630)) ([34fa116](https://github.com/vm0-ai/vm0/commit/34fa11698b8e1c83f2cb93d82e281c099d114a49))

## [0.15.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.14.1...sandbox-fc-v0.15.0) (2026-03-23)


### Features

* log non-tcp traffic from sandbox vms via iptables and /dev/kmsg ([#6060](https://github.com/vm0-ai/vm0/issues/6060)) ([ddf2a0c](https://github.com/vm0-ai/vm0/commit/ddf2a0c3c2c99928d4f12eda1f48a887cfd5533a))

## [0.14.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.14.0...sandbox-fc-v0.14.1) (2026-03-22)


### Bug Fixes

* **sandbox-fc:** prevent orphan firecracker processes during snapshot creation ([#5963](https://github.com/vm0-ai/vm0/issues/5963)) ([ec72353](https://github.com/vm0-ai/vm0/commit/ec72353dbbcc3c07edc560c7004c43350422c3c7))

## [0.14.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.13.2...sandbox-fc-v0.14.0) (2026-03-20)


### Features

* **vsock:** add real-time stdout streaming from guest to host ([#5574](https://github.com/vm0-ai/vm0/issues/5574)) ([2afc093](https://github.com/vm0-ai/vm0/commit/2afc0930657f6bbf1e1f4947383345d33de46819))

## [0.13.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.13.1...sandbox-fc-v0.13.2) (2026-03-19)


### Bug Fixes

* intercept all outbound tcp in mitmproxy, not just port 80/443 ([#5573](https://github.com/vm0-ai/vm0/issues/5573)) ([781aa8b](https://github.com/vm0-ai/vm0/commit/781aa8bc17ee14121fc76ef926f5f2c0688623b8))


### Refactoring

* merge browser profile into default, install chromium in base rootfs ([#5568](https://github.com/vm0-ai/vm0/issues/5568)) ([e014dd1](https://github.com/vm0-ai/vm0/commit/e014dd1d9778d739b66844f2d67871ba61af9107)), closes [#5554](https://github.com/vm0-ai/vm0/issues/5554)

## [0.13.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.13.0...sandbox-fc-v0.13.1) (2026-03-19)


### Refactoring

* **sandbox:** remove dead use_proxy field from sandbox config ([#5483](https://github.com/vm0-ai/vm0/issues/5483)) ([97c8db8](https://github.com/vm0-ai/vm0/commit/97c8db89235175ba41f45817413b671c3d39fe3e)), closes [#5481](https://github.com/vm0-ai/vm0/issues/5481)

## [0.13.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.12.1...sandbox-fc-v0.13.0) (2026-03-19)


### Features

* **runner:** add vm0/browser profile with dockerfile and ci integration ([#5311](https://github.com/vm0-ai/vm0/issues/5311)) ([a6b6077](https://github.com/vm0-ai/vm0/commit/a6b6077eb2e8a83f48bed456e4ee7d5e3323c192))


### Bug Fixes

* **sandbox-fc:** use per-profile overlay directories to prevent cross-deletion ([#5413](https://github.com/vm0-ai/vm0/issues/5413)) ([a5c1a56](https://github.com/vm0-ai/vm0/commit/a5c1a56e0cbbf7ce305bf34414981ef3a08f2841)), closes [#5405](https://github.com/vm0-ai/vm0/issues/5405)

## [0.12.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.12.0...sandbox-fc-v0.12.1) (2026-03-18)


### Refactoring

* **sandbox-fc:** enable api socket in fresh boot mode for balloon support ([#5237](https://github.com/vm0-ai/vm0/issues/5237)) ([d485d28](https://github.com/vm0-ai/vm0/commit/d485d284041ec7f17311b1aab3eaaa28aec596df))

## [0.12.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.11.6...sandbox-fc-v0.12.0) (2026-03-17)


### Features

* **runner:** profile-aware discovery, budget reservation, and per-profile factory ([#5224](https://github.com/vm0-ai/vm0/issues/5224)) ([05e3803](https://github.com/vm0-ai/vm0/commit/05e3803c7566ec70be92c1e313fa1c58d2b6c779))

## [0.11.6](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.11.5...sandbox-fc-v0.11.6) (2026-03-17)


### Refactoring

* **sandbox-fc:** replace target-size pool pre-warming with fixed buffer ([#5191](https://github.com/vm0-ai/vm0/issues/5191)) ([4ce60ac](https://github.com/vm0-ai/vm0/commit/4ce60ac8c1c5b0f60dae8169d71135b11ee3b968))

## [0.11.5](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.11.4...sandbox-fc-v0.11.5) (2026-03-17)


### Refactoring

* **rust:** replace inline crate:: paths with top-level use imports ([#5061](https://github.com/vm0-ai/vm0/issues/5061)) ([149aaa0](https://github.com/vm0-ai/vm0/commit/149aaa09ca2bf69ffb1bc35471ba813e5884e534)), closes [#5038](https://github.com/vm0-ai/vm0/issues/5038)

## [0.11.4](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.11.3...sandbox-fc-v0.11.4) (2026-03-15)


### Performance Improvements

* **sandbox-fc:** lazy initialization and batched replenishment for overlay pool ([#4603](https://github.com/vm0-ai/vm0/issues/4603)) ([862144b](https://github.com/vm0-ai/vm0/commit/862144bef70fa6e4f61b847bf41aa52ebddbeeb2))

## [0.11.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.11.2...sandbox-fc-v0.11.3) (2026-03-12)


### Refactoring

* remove balloon_reclaim flag and enable balloon reclaim unconditionally ([#4473](https://github.com/vm0-ai/vm0/issues/4473)) ([b386091](https://github.com/vm0-ai/vm0/commit/b38609140426569f3fe0c3cc3e56bf81ee477583))

## [0.11.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.11.1...sandbox-fc-v0.11.2) (2026-03-07)


### Bug Fixes

* **sandbox-fc:** flush conntrack entries on namespace release ([#3888](https://github.com/vm0-ai/vm0/issues/3888)) ([612c491](https://github.com/vm0-ai/vm0/commit/612c49176f6335297d262486b3968605b4539428)), closes [#3645](https://github.com/vm0-ai/vm0/issues/3645)

## [0.11.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.11.0...sandbox-fc-v0.11.1) (2026-03-06)

## [0.11.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.10.0...sandbox-fc-v0.11.0) (2026-03-06)


### Features

* **sandbox-fc:** add balloon controller observability for production monitoring ([#3767](https://github.com/vm0-ai/vm0/issues/3767)) ([ecc4c4a](https://github.com/vm0-ai/vm0/commit/ecc4c4a2d9599138ee5422c470a4a1576749c9fb))

## [0.10.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.9.0...sandbox-fc-v0.10.0) (2026-03-05)


### Features

* **runner:** balloon reclaim with per-tick inflate cap and full ci test ([#3711](https://github.com/vm0-ai/vm0/issues/3711)) ([7f7efc2](https://github.com/vm0-ai/vm0/commit/7f7efc2f845686899c62ce20cbf992cc9cc5c7df))

## [0.9.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.8.0...sandbox-fc-v0.9.0) (2026-03-05)


### Features

* **sandbox-fc:** add per-sandbox balloon memory reclaim controller ([#3700](https://github.com/vm0-ai/vm0/issues/3700)) ([10f121b](https://github.com/vm0-ai/vm0/commit/10f121bc06e87f23a48af9b4b971faacef620442)), closes [#3697](https://github.com/vm0-ai/vm0/issues/3697)


### Bug Fixes

* **ci:** limit runner test concurrency to avoid netns init timeout ([#3712](https://github.com/vm0-ai/vm0/issues/3712)) ([df4d163](https://github.com/vm0-ai/vm0/commit/df4d163bf0c3a9ae89a05e66cc976735815cfd76))
* **sandbox-fc:** fail fast when firecracker crashes during startup ([#3709](https://github.com/vm0-ai/vm0/issues/3709)) ([ad469b4](https://github.com/vm0-ai/vm0/commit/ad469b45110d59f8b5cfa210635012b9477de2a0))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.7.0...sandbox-fc-v0.8.0) (2026-03-05)


### Features

* **sandbox-fc:** enable balloon stats and add runtime balloon api ([#3694](https://github.com/vm0-ai/vm0/issues/3694)) ([b5918d6](https://github.com/vm0-ai/vm0/commit/b5918d6e7f7c82f79693b725bad2b5c547016655)), closes [#3688](https://github.com/vm0-ai/vm0/issues/3688)
* **sandbox-fc:** enable virtio-balloon with deflate_on_oom as safety net ([#3679](https://github.com/vm0-ai/vm0/issues/3679)) ([2ce2b62](https://github.com/vm0-ai/vm0/commit/2ce2b62c991a9e4bc077438630eb21267b618dc2)), closes [#3666](https://github.com/vm0-ai/vm0/issues/3666)

## [0.7.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.6.7...sandbox-fc-v0.7.0) (2026-03-03)


### Features

* **runner:** add exec command for live vm debugging ([#3502](https://github.com/vm0-ai/vm0/issues/3502)) ([0453c3b](https://github.com/vm0-ai/vm0/commit/0453c3bd7a32f9b9e2760ff30e4aea192a9b0836))

## [0.6.7](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.6.6...sandbox-fc-v0.6.7) (2026-03-02)


### Performance Improvements

* **sandbox-fc:** use full cli invocation for snapshot pre-warm ([#3395](https://github.com/vm0-ai/vm0/issues/3395)) ([318deaa](https://github.com/vm0-ai/vm0/commit/318deaa20216059e92c1702a10ef0203c98af00e))

## [0.6.6](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.6.5...sandbox-fc-v0.6.6) (2026-03-01)


### Performance Improvements

* **runner:** prefetch snapshot memory.bin via sequential read ([#3373](https://github.com/vm0-ai/vm0/issues/3373)) ([21289eb](https://github.com/vm0-ai/vm0/commit/21289ebcff774e6c763a350dbb57be23f1ebeed8)), closes [#3342](https://github.com/vm0-ai/vm0/issues/3342)

## [0.6.5](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.6.4...sandbox-fc-v0.6.5) (2026-03-01)


### Performance Improvements

* **sandbox-fc:** prefetch snapshot memory.bin on factory startup ([#3370](https://github.com/vm0-ai/vm0/issues/3370)) ([891041e](https://github.com/vm0-ai/vm0/commit/891041ee8cae18ddbd83864fb80e2c3e6f3dab2d))

## [0.6.4](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.6.3...sandbox-fc-v0.6.4) (2026-02-27)


### Performance Improvements

* **sandbox-fc:** pre-warm real claude execution path instead of --help ([#3272](https://github.com/vm0-ai/vm0/issues/3272)) ([5d95121](https://github.com/vm0-ai/vm0/commit/5d95121b69e9ac5dbe76cb0859cc90b4b48a3743)), closes [#3258](https://github.com/vm0-ai/vm0/issues/3258)

## [0.6.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.6.2...sandbox-fc-v0.6.3) (2026-02-27)


### Bug Fixes

* **sandbox-fc:** use deterministic mac on tap devices for snapshot arp stability ([#3269](https://github.com/vm0-ai/vm0/issues/3269)) ([4c73c27](https://github.com/vm0-ai/vm0/commit/4c73c275ae6ae6bb3fbea6b5ee93ee5b0b761418)), closes [#3268](https://github.com/vm0-ai/vm0/issues/3268)

## [0.6.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.6.1...sandbox-fc-v0.6.2) (2026-02-26)


### Bug Fixes

* **sandbox-fc:** remove double su wrapper from prewarm script ([#3265](https://github.com/vm0-ai/vm0/issues/3265)) ([3df62d1](https://github.com/vm0-ai/vm0/commit/3df62d1b9be9310e5112f3423edce504295f1775))


### Performance Improvements

* **sandbox-fc:** enable v8 compile cache for faster cli cold start ([#3267](https://github.com/vm0-ai/vm0/issues/3267)) ([6f1c8be](https://github.com/vm0-ai/vm0/commit/6f1c8be89cd5c7168326b5fa822d26eb2f9fa824))

## [0.6.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.6.0...sandbox-fc-v0.6.1) (2026-02-23)


### Performance Improvements

* **sandbox-fc:** pre-warm claude and codex in snapshot ([#3232](https://github.com/vm0-ai/vm0/issues/3232)) ([5534465](https://github.com/vm0-ai/vm0/commit/553446505f92aa30b1ac38b396f9238a6ff4c9ac))

## [0.6.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.5.0...sandbox-fc-v0.6.0) (2026-02-23)


### Features

* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add runner.yaml config file generated by build ([#2935](https://github.com/vm0-ai/vm0/issues/2935)) ([9b9577a](https://github.com/vm0-ai/vm0/commit/9b9577a3197b72f64866ff12769fa919c252a347))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** add network namespace pool and command execution ([#2576](https://github.com/vm0-ai/vm0/issues/2576)) ([cb97bca](https://github.com/vm0-ai/vm0/commit/cb97bca8e0ccf02e19c7f1dfe5423cde3d1a72f8))
* **sandbox-fc:** add overlay filesystem pool for pre-warmed vm images ([#2586](https://github.com/vm0-ai/vm0/issues/2586)) ([313c74e](https://github.com/vm0-ai/vm0/commit/313c74eb4ed061161b2e9901c323ba45adde0aa3))
* **sandbox-fc:** add test binary for manual lifecycle testing ([#2642](https://github.com/vm0-ai/vm0/issues/2642)) ([c4f9e22](https://github.com/vm0-ai/vm0/commit/c4f9e227a43421a890808b8c946391faa4eafaec))
* **sandbox-fc:** add unified prerequisites check to factory init ([#2651](https://github.com/vm0-ai/vm0/issues/2651)) ([a0a4868](https://github.com/vm0-ai/vm0/commit/a0a4868a6175e1022c8eb91fda2907fbe1dd6105))
* **sandbox-fc:** auto-allocate netns pool index via flock ([#2708](https://github.com/vm0-ai/vm0/issues/2708)) ([828ed61](https://github.com/vm0-ai/vm0/commit/828ed619217245d4a87a1afa27290ba175232143)), closes [#2704](https://github.com/vm0-ai/vm0/issues/2704)
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** implement snapshot creation workflow ([#2668](https://github.com/vm0-ai/vm0/issues/2668)) ([02d4418](https://github.com/vm0-ai/vm0/commit/02d441840260d6257e9e52cca72330cb1568fb41))
* **sandbox-fc:** implement snapshot restore via firecracker http api ([#2662](https://github.com/vm0-ai/vm0/issues/2662)) ([a622c08](https://github.com/vm0-ai/vm0/commit/a622c08eb897c2c0699dc08ea62079919aa33ab3))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **sandbox-fc:** proactive crash notification for firecracker sandbox ([#3087](https://github.com/vm0-ai/vm0/issues/3087)) ([ff6a795](https://github.com/vm0-ai/vm0/commit/ff6a795b77c42f389fc2b998dda9e262b1049c46))
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **runner:** add flock to prevent concurrent rootfs/snapshot builds ([#2980](https://github.com/vm0-ai/vm0/issues/2980)) ([96a8559](https://github.com/vm0-ai/vm0/commit/96a8559f03ebebc0833af97d7bfe5c3c1562cb24))
* **runner:** prevent vm process leak on executor task panic ([#3079](https://github.com/vm0-ai/vm0/issues/3079)) ([6677bb5](https://github.com/vm0-ai/vm0/commit/6677bb55aa95096988c634879b23a775c9d63352)), closes [#3078](https://github.com/vm0-ai/vm0/issues/3078)
* **sandbox-fc:** add prerequisite checks to create_snapshot ([#2971](https://github.com/vm0-ai/vm0/issues/2971)) ([f508fa2](https://github.com/vm0-ai/vm0/commit/f508fa2cfc6a70900670377f029b041b53ac8cdd))
* **sandbox-fc:** check /dev/kvm read-write permission in prerequisites ([#2657](https://github.com/vm0-ai/vm0/issues/2657)) ([0507615](https://github.com/vm0-ai/vm0/commit/0507615b626ec4754694547fd0bda79ceac10f48))
* **sandbox-fc:** move runtime sockets to /run/vm0 to fix sun_path limit ([#2951](https://github.com/vm0-ai/vm0/issues/2951)) ([#2966](https://github.com/vm0-ai/vm0/issues/2966)) ([4b91e0d](https://github.com/vm0-ai/vm0/commit/4b91e0d9ad2f677475afd768f95f19af852c9b46))
* **sandbox-fc:** redesign api error as enum to distinguish fatal from retryable errors ([#2700](https://github.com/vm0-ai/vm0/issues/2700)) ([dae4042](https://github.com/vm0-ai/vm0/commit/dae40421ec934018cfef485d73dabc5cdac33672))
* **sandbox-fc:** reject sudo invocation and clean stale work dir on snapshot ([#2698](https://github.com/vm0-ai/vm0/issues/2698)) ([f298633](https://github.com/vm0-ai/vm0/commit/f2986332cdc212167e5dd4323039ddaf554859e4)), closes [#2696](https://github.com/vm0-ai/vm0/issues/2696)


### Performance Improvements

* **sandbox-fc:** include prewarm script in snapshot hash computation ([#3004](https://github.com/vm0-ai/vm0/issues/3004)) ([3c27ac0](https://github.com/vm0-ai/vm0/commit/3c27ac0b4ffb8ab487fbea71cf62bf9681f31b0f)), closes [#3002](https://github.com/vm0-ai/vm0/issues/3002)
* **sandbox-fc:** pre-warm pam cache during snapshot creation ([#3000](https://github.com/vm0-ai/vm0/issues/3000)) ([8b95fcd](https://github.com/vm0-ai/vm0/commit/8b95fcdb9e33b1ea89b68d4ff6eef210f74cf91c)), closes [#2994](https://github.com/vm0-ai/vm0/issues/2994)

## [0.5.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.4.0...sandbox-fc-v0.5.0) (2026-02-23)


### Features

* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add runner.yaml config file generated by build ([#2935](https://github.com/vm0-ai/vm0/issues/2935)) ([9b9577a](https://github.com/vm0-ai/vm0/commit/9b9577a3197b72f64866ff12769fa919c252a347))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** add network namespace pool and command execution ([#2576](https://github.com/vm0-ai/vm0/issues/2576)) ([cb97bca](https://github.com/vm0-ai/vm0/commit/cb97bca8e0ccf02e19c7f1dfe5423cde3d1a72f8))
* **sandbox-fc:** add overlay filesystem pool for pre-warmed vm images ([#2586](https://github.com/vm0-ai/vm0/issues/2586)) ([313c74e](https://github.com/vm0-ai/vm0/commit/313c74eb4ed061161b2e9901c323ba45adde0aa3))
* **sandbox-fc:** add test binary for manual lifecycle testing ([#2642](https://github.com/vm0-ai/vm0/issues/2642)) ([c4f9e22](https://github.com/vm0-ai/vm0/commit/c4f9e227a43421a890808b8c946391faa4eafaec))
* **sandbox-fc:** add unified prerequisites check to factory init ([#2651](https://github.com/vm0-ai/vm0/issues/2651)) ([a0a4868](https://github.com/vm0-ai/vm0/commit/a0a4868a6175e1022c8eb91fda2907fbe1dd6105))
* **sandbox-fc:** auto-allocate netns pool index via flock ([#2708](https://github.com/vm0-ai/vm0/issues/2708)) ([828ed61](https://github.com/vm0-ai/vm0/commit/828ed619217245d4a87a1afa27290ba175232143)), closes [#2704](https://github.com/vm0-ai/vm0/issues/2704)
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** implement snapshot creation workflow ([#2668](https://github.com/vm0-ai/vm0/issues/2668)) ([02d4418](https://github.com/vm0-ai/vm0/commit/02d441840260d6257e9e52cca72330cb1568fb41))
* **sandbox-fc:** implement snapshot restore via firecracker http api ([#2662](https://github.com/vm0-ai/vm0/issues/2662)) ([a622c08](https://github.com/vm0-ai/vm0/commit/a622c08eb897c2c0699dc08ea62079919aa33ab3))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **sandbox-fc:** proactive crash notification for firecracker sandbox ([#3087](https://github.com/vm0-ai/vm0/issues/3087)) ([ff6a795](https://github.com/vm0-ai/vm0/commit/ff6a795b77c42f389fc2b998dda9e262b1049c46))
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **runner:** add flock to prevent concurrent rootfs/snapshot builds ([#2980](https://github.com/vm0-ai/vm0/issues/2980)) ([96a8559](https://github.com/vm0-ai/vm0/commit/96a8559f03ebebc0833af97d7bfe5c3c1562cb24))
* **runner:** prevent vm process leak on executor task panic ([#3079](https://github.com/vm0-ai/vm0/issues/3079)) ([6677bb5](https://github.com/vm0-ai/vm0/commit/6677bb55aa95096988c634879b23a775c9d63352)), closes [#3078](https://github.com/vm0-ai/vm0/issues/3078)
* **sandbox-fc:** add prerequisite checks to create_snapshot ([#2971](https://github.com/vm0-ai/vm0/issues/2971)) ([f508fa2](https://github.com/vm0-ai/vm0/commit/f508fa2cfc6a70900670377f029b041b53ac8cdd))
* **sandbox-fc:** check /dev/kvm read-write permission in prerequisites ([#2657](https://github.com/vm0-ai/vm0/issues/2657)) ([0507615](https://github.com/vm0-ai/vm0/commit/0507615b626ec4754694547fd0bda79ceac10f48))
* **sandbox-fc:** move runtime sockets to /run/vm0 to fix sun_path limit ([#2951](https://github.com/vm0-ai/vm0/issues/2951)) ([#2966](https://github.com/vm0-ai/vm0/issues/2966)) ([4b91e0d](https://github.com/vm0-ai/vm0/commit/4b91e0d9ad2f677475afd768f95f19af852c9b46))
* **sandbox-fc:** redesign api error as enum to distinguish fatal from retryable errors ([#2700](https://github.com/vm0-ai/vm0/issues/2700)) ([dae4042](https://github.com/vm0-ai/vm0/commit/dae40421ec934018cfef485d73dabc5cdac33672))
* **sandbox-fc:** reject sudo invocation and clean stale work dir on snapshot ([#2698](https://github.com/vm0-ai/vm0/issues/2698)) ([f298633](https://github.com/vm0-ai/vm0/commit/f2986332cdc212167e5dd4323039ddaf554859e4)), closes [#2696](https://github.com/vm0-ai/vm0/issues/2696)


### Performance Improvements

* **sandbox-fc:** include prewarm script in snapshot hash computation ([#3004](https://github.com/vm0-ai/vm0/issues/3004)) ([3c27ac0](https://github.com/vm0-ai/vm0/commit/3c27ac0b4ffb8ab487fbea71cf62bf9681f31b0f)), closes [#3002](https://github.com/vm0-ai/vm0/issues/3002)
* **sandbox-fc:** pre-warm pam cache during snapshot creation ([#3000](https://github.com/vm0-ai/vm0/issues/3000)) ([8b95fcd](https://github.com/vm0-ai/vm0/commit/8b95fcdb9e33b1ea89b68d4ff6eef210f74cf91c)), closes [#2994](https://github.com/vm0-ai/vm0/issues/2994)

## [0.4.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.3.0...sandbox-fc-v0.4.0) (2026-02-22)


### Features

* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add runner.yaml config file generated by build ([#2935](https://github.com/vm0-ai/vm0/issues/2935)) ([9b9577a](https://github.com/vm0-ai/vm0/commit/9b9577a3197b72f64866ff12769fa919c252a347))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** add network namespace pool and command execution ([#2576](https://github.com/vm0-ai/vm0/issues/2576)) ([cb97bca](https://github.com/vm0-ai/vm0/commit/cb97bca8e0ccf02e19c7f1dfe5423cde3d1a72f8))
* **sandbox-fc:** add overlay filesystem pool for pre-warmed vm images ([#2586](https://github.com/vm0-ai/vm0/issues/2586)) ([313c74e](https://github.com/vm0-ai/vm0/commit/313c74eb4ed061161b2e9901c323ba45adde0aa3))
* **sandbox-fc:** add test binary for manual lifecycle testing ([#2642](https://github.com/vm0-ai/vm0/issues/2642)) ([c4f9e22](https://github.com/vm0-ai/vm0/commit/c4f9e227a43421a890808b8c946391faa4eafaec))
* **sandbox-fc:** add unified prerequisites check to factory init ([#2651](https://github.com/vm0-ai/vm0/issues/2651)) ([a0a4868](https://github.com/vm0-ai/vm0/commit/a0a4868a6175e1022c8eb91fda2907fbe1dd6105))
* **sandbox-fc:** auto-allocate netns pool index via flock ([#2708](https://github.com/vm0-ai/vm0/issues/2708)) ([828ed61](https://github.com/vm0-ai/vm0/commit/828ed619217245d4a87a1afa27290ba175232143)), closes [#2704](https://github.com/vm0-ai/vm0/issues/2704)
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** implement snapshot creation workflow ([#2668](https://github.com/vm0-ai/vm0/issues/2668)) ([02d4418](https://github.com/vm0-ai/vm0/commit/02d441840260d6257e9e52cca72330cb1568fb41))
* **sandbox-fc:** implement snapshot restore via firecracker http api ([#2662](https://github.com/vm0-ai/vm0/issues/2662)) ([a622c08](https://github.com/vm0-ai/vm0/commit/a622c08eb897c2c0699dc08ea62079919aa33ab3))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **sandbox-fc:** proactive crash notification for firecracker sandbox ([#3087](https://github.com/vm0-ai/vm0/issues/3087)) ([ff6a795](https://github.com/vm0-ai/vm0/commit/ff6a795b77c42f389fc2b998dda9e262b1049c46))
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **runner:** add flock to prevent concurrent rootfs/snapshot builds ([#2980](https://github.com/vm0-ai/vm0/issues/2980)) ([96a8559](https://github.com/vm0-ai/vm0/commit/96a8559f03ebebc0833af97d7bfe5c3c1562cb24))
* **runner:** prevent vm process leak on executor task panic ([#3079](https://github.com/vm0-ai/vm0/issues/3079)) ([6677bb5](https://github.com/vm0-ai/vm0/commit/6677bb55aa95096988c634879b23a775c9d63352)), closes [#3078](https://github.com/vm0-ai/vm0/issues/3078)
* **sandbox-fc:** add prerequisite checks to create_snapshot ([#2971](https://github.com/vm0-ai/vm0/issues/2971)) ([f508fa2](https://github.com/vm0-ai/vm0/commit/f508fa2cfc6a70900670377f029b041b53ac8cdd))
* **sandbox-fc:** check /dev/kvm read-write permission in prerequisites ([#2657](https://github.com/vm0-ai/vm0/issues/2657)) ([0507615](https://github.com/vm0-ai/vm0/commit/0507615b626ec4754694547fd0bda79ceac10f48))
* **sandbox-fc:** move runtime sockets to /run/vm0 to fix sun_path limit ([#2951](https://github.com/vm0-ai/vm0/issues/2951)) ([#2966](https://github.com/vm0-ai/vm0/issues/2966)) ([4b91e0d](https://github.com/vm0-ai/vm0/commit/4b91e0d9ad2f677475afd768f95f19af852c9b46))
* **sandbox-fc:** redesign api error as enum to distinguish fatal from retryable errors ([#2700](https://github.com/vm0-ai/vm0/issues/2700)) ([dae4042](https://github.com/vm0-ai/vm0/commit/dae40421ec934018cfef485d73dabc5cdac33672))
* **sandbox-fc:** reject sudo invocation and clean stale work dir on snapshot ([#2698](https://github.com/vm0-ai/vm0/issues/2698)) ([f298633](https://github.com/vm0-ai/vm0/commit/f2986332cdc212167e5dd4323039ddaf554859e4)), closes [#2696](https://github.com/vm0-ai/vm0/issues/2696)


### Performance Improvements

* **sandbox-fc:** include prewarm script in snapshot hash computation ([#3004](https://github.com/vm0-ai/vm0/issues/3004)) ([3c27ac0](https://github.com/vm0-ai/vm0/commit/3c27ac0b4ffb8ab487fbea71cf62bf9681f31b0f)), closes [#3002](https://github.com/vm0-ai/vm0/issues/3002)
* **sandbox-fc:** pre-warm pam cache during snapshot creation ([#3000](https://github.com/vm0-ai/vm0/issues/3000)) ([8b95fcd](https://github.com/vm0-ai/vm0/commit/8b95fcdb9e33b1ea89b68d4ff6eef210f74cf91c)), closes [#2994](https://github.com/vm0-ai/vm0/issues/2994)

## [0.3.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.2.0...sandbox-fc-v0.3.0) (2026-02-22)


### Features

* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add runner.yaml config file generated by build ([#2935](https://github.com/vm0-ai/vm0/issues/2935)) ([9b9577a](https://github.com/vm0-ai/vm0/commit/9b9577a3197b72f64866ff12769fa919c252a347))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** add network namespace pool and command execution ([#2576](https://github.com/vm0-ai/vm0/issues/2576)) ([cb97bca](https://github.com/vm0-ai/vm0/commit/cb97bca8e0ccf02e19c7f1dfe5423cde3d1a72f8))
* **sandbox-fc:** add overlay filesystem pool for pre-warmed vm images ([#2586](https://github.com/vm0-ai/vm0/issues/2586)) ([313c74e](https://github.com/vm0-ai/vm0/commit/313c74eb4ed061161b2e9901c323ba45adde0aa3))
* **sandbox-fc:** add test binary for manual lifecycle testing ([#2642](https://github.com/vm0-ai/vm0/issues/2642)) ([c4f9e22](https://github.com/vm0-ai/vm0/commit/c4f9e227a43421a890808b8c946391faa4eafaec))
* **sandbox-fc:** add unified prerequisites check to factory init ([#2651](https://github.com/vm0-ai/vm0/issues/2651)) ([a0a4868](https://github.com/vm0-ai/vm0/commit/a0a4868a6175e1022c8eb91fda2907fbe1dd6105))
* **sandbox-fc:** auto-allocate netns pool index via flock ([#2708](https://github.com/vm0-ai/vm0/issues/2708)) ([828ed61](https://github.com/vm0-ai/vm0/commit/828ed619217245d4a87a1afa27290ba175232143)), closes [#2704](https://github.com/vm0-ai/vm0/issues/2704)
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** implement snapshot creation workflow ([#2668](https://github.com/vm0-ai/vm0/issues/2668)) ([02d4418](https://github.com/vm0-ai/vm0/commit/02d441840260d6257e9e52cca72330cb1568fb41))
* **sandbox-fc:** implement snapshot restore via firecracker http api ([#2662](https://github.com/vm0-ai/vm0/issues/2662)) ([a622c08](https://github.com/vm0-ai/vm0/commit/a622c08eb897c2c0699dc08ea62079919aa33ab3))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **sandbox-fc:** proactive crash notification for firecracker sandbox ([#3087](https://github.com/vm0-ai/vm0/issues/3087)) ([ff6a795](https://github.com/vm0-ai/vm0/commit/ff6a795b77c42f389fc2b998dda9e262b1049c46))
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **runner:** add flock to prevent concurrent rootfs/snapshot builds ([#2980](https://github.com/vm0-ai/vm0/issues/2980)) ([96a8559](https://github.com/vm0-ai/vm0/commit/96a8559f03ebebc0833af97d7bfe5c3c1562cb24))
* **runner:** prevent vm process leak on executor task panic ([#3079](https://github.com/vm0-ai/vm0/issues/3079)) ([6677bb5](https://github.com/vm0-ai/vm0/commit/6677bb55aa95096988c634879b23a775c9d63352)), closes [#3078](https://github.com/vm0-ai/vm0/issues/3078)
* **sandbox-fc:** add prerequisite checks to create_snapshot ([#2971](https://github.com/vm0-ai/vm0/issues/2971)) ([f508fa2](https://github.com/vm0-ai/vm0/commit/f508fa2cfc6a70900670377f029b041b53ac8cdd))
* **sandbox-fc:** check /dev/kvm read-write permission in prerequisites ([#2657](https://github.com/vm0-ai/vm0/issues/2657)) ([0507615](https://github.com/vm0-ai/vm0/commit/0507615b626ec4754694547fd0bda79ceac10f48))
* **sandbox-fc:** move runtime sockets to /run/vm0 to fix sun_path limit ([#2951](https://github.com/vm0-ai/vm0/issues/2951)) ([#2966](https://github.com/vm0-ai/vm0/issues/2966)) ([4b91e0d](https://github.com/vm0-ai/vm0/commit/4b91e0d9ad2f677475afd768f95f19af852c9b46))
* **sandbox-fc:** redesign api error as enum to distinguish fatal from retryable errors ([#2700](https://github.com/vm0-ai/vm0/issues/2700)) ([dae4042](https://github.com/vm0-ai/vm0/commit/dae40421ec934018cfef485d73dabc5cdac33672))
* **sandbox-fc:** reject sudo invocation and clean stale work dir on snapshot ([#2698](https://github.com/vm0-ai/vm0/issues/2698)) ([f298633](https://github.com/vm0-ai/vm0/commit/f2986332cdc212167e5dd4323039ddaf554859e4)), closes [#2696](https://github.com/vm0-ai/vm0/issues/2696)


### Performance Improvements

* **sandbox-fc:** include prewarm script in snapshot hash computation ([#3004](https://github.com/vm0-ai/vm0/issues/3004)) ([3c27ac0](https://github.com/vm0-ai/vm0/commit/3c27ac0b4ffb8ab487fbea71cf62bf9681f31b0f)), closes [#3002](https://github.com/vm0-ai/vm0/issues/3002)
* **sandbox-fc:** pre-warm pam cache during snapshot creation ([#3000](https://github.com/vm0-ai/vm0/issues/3000)) ([8b95fcd](https://github.com/vm0-ai/vm0/commit/8b95fcdb9e33b1ea89b68d4ff6eef210f74cf91c)), closes [#2994](https://github.com/vm0-ai/vm0/issues/2994)

## [0.2.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.1.0...sandbox-fc-v0.2.0) (2026-02-22)


### Features

* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add runner.yaml config file generated by build ([#2935](https://github.com/vm0-ai/vm0/issues/2935)) ([9b9577a](https://github.com/vm0-ai/vm0/commit/9b9577a3197b72f64866ff12769fa919c252a347))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** add network namespace pool and command execution ([#2576](https://github.com/vm0-ai/vm0/issues/2576)) ([cb97bca](https://github.com/vm0-ai/vm0/commit/cb97bca8e0ccf02e19c7f1dfe5423cde3d1a72f8))
* **sandbox-fc:** add overlay filesystem pool for pre-warmed vm images ([#2586](https://github.com/vm0-ai/vm0/issues/2586)) ([313c74e](https://github.com/vm0-ai/vm0/commit/313c74eb4ed061161b2e9901c323ba45adde0aa3))
* **sandbox-fc:** add test binary for manual lifecycle testing ([#2642](https://github.com/vm0-ai/vm0/issues/2642)) ([c4f9e22](https://github.com/vm0-ai/vm0/commit/c4f9e227a43421a890808b8c946391faa4eafaec))
* **sandbox-fc:** add unified prerequisites check to factory init ([#2651](https://github.com/vm0-ai/vm0/issues/2651)) ([a0a4868](https://github.com/vm0-ai/vm0/commit/a0a4868a6175e1022c8eb91fda2907fbe1dd6105))
* **sandbox-fc:** auto-allocate netns pool index via flock ([#2708](https://github.com/vm0-ai/vm0/issues/2708)) ([828ed61](https://github.com/vm0-ai/vm0/commit/828ed619217245d4a87a1afa27290ba175232143)), closes [#2704](https://github.com/vm0-ai/vm0/issues/2704)
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** implement snapshot creation workflow ([#2668](https://github.com/vm0-ai/vm0/issues/2668)) ([02d4418](https://github.com/vm0-ai/vm0/commit/02d441840260d6257e9e52cca72330cb1568fb41))
* **sandbox-fc:** implement snapshot restore via firecracker http api ([#2662](https://github.com/vm0-ai/vm0/issues/2662)) ([a622c08](https://github.com/vm0-ai/vm0/commit/a622c08eb897c2c0699dc08ea62079919aa33ab3))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **sandbox-fc:** proactive crash notification for firecracker sandbox ([#3087](https://github.com/vm0-ai/vm0/issues/3087)) ([ff6a795](https://github.com/vm0-ai/vm0/commit/ff6a795b77c42f389fc2b998dda9e262b1049c46))
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **runner:** add flock to prevent concurrent rootfs/snapshot builds ([#2980](https://github.com/vm0-ai/vm0/issues/2980)) ([96a8559](https://github.com/vm0-ai/vm0/commit/96a8559f03ebebc0833af97d7bfe5c3c1562cb24))
* **runner:** prevent vm process leak on executor task panic ([#3079](https://github.com/vm0-ai/vm0/issues/3079)) ([6677bb5](https://github.com/vm0-ai/vm0/commit/6677bb55aa95096988c634879b23a775c9d63352)), closes [#3078](https://github.com/vm0-ai/vm0/issues/3078)
* **sandbox-fc:** add prerequisite checks to create_snapshot ([#2971](https://github.com/vm0-ai/vm0/issues/2971)) ([f508fa2](https://github.com/vm0-ai/vm0/commit/f508fa2cfc6a70900670377f029b041b53ac8cdd))
* **sandbox-fc:** check /dev/kvm read-write permission in prerequisites ([#2657](https://github.com/vm0-ai/vm0/issues/2657)) ([0507615](https://github.com/vm0-ai/vm0/commit/0507615b626ec4754694547fd0bda79ceac10f48))
* **sandbox-fc:** move runtime sockets to /run/vm0 to fix sun_path limit ([#2951](https://github.com/vm0-ai/vm0/issues/2951)) ([#2966](https://github.com/vm0-ai/vm0/issues/2966)) ([4b91e0d](https://github.com/vm0-ai/vm0/commit/4b91e0d9ad2f677475afd768f95f19af852c9b46))
* **sandbox-fc:** redesign api error as enum to distinguish fatal from retryable errors ([#2700](https://github.com/vm0-ai/vm0/issues/2700)) ([dae4042](https://github.com/vm0-ai/vm0/commit/dae40421ec934018cfef485d73dabc5cdac33672))
* **sandbox-fc:** reject sudo invocation and clean stale work dir on snapshot ([#2698](https://github.com/vm0-ai/vm0/issues/2698)) ([f298633](https://github.com/vm0-ai/vm0/commit/f2986332cdc212167e5dd4323039ddaf554859e4)), closes [#2696](https://github.com/vm0-ai/vm0/issues/2696)


### Performance Improvements

* **sandbox-fc:** include prewarm script in snapshot hash computation ([#3004](https://github.com/vm0-ai/vm0/issues/3004)) ([3c27ac0](https://github.com/vm0-ai/vm0/commit/3c27ac0b4ffb8ab487fbea71cf62bf9681f31b0f)), closes [#3002](https://github.com/vm0-ai/vm0/issues/3002)
* **sandbox-fc:** pre-warm pam cache during snapshot creation ([#3000](https://github.com/vm0-ai/vm0/issues/3000)) ([8b95fcd](https://github.com/vm0-ai/vm0/commit/8b95fcdb9e33b1ea89b68d4ff6eef210f74cf91c)), closes [#2994](https://github.com/vm0-ai/vm0/issues/2994)
