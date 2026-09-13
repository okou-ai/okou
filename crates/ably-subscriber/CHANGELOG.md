# Changelog

## [1.1.2](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.1.1...ably-subscriber-v1.1.2) (2026-09-11)


### Bug Fixes

* **ably-subscriber:** bound smoke-test publish duration ([#33541](https://github.com/vm0-ai/vm0/issues/33541)) ([ae77664](https://github.com/vm0-ai/vm0/commit/ae77664960d0074905f2d10be7c06f7ea29ad584))

## [1.1.1](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.1.0...ably-subscriber-v1.1.1) (2026-09-09)


### Bug Fixes

* **api:** batch connector runtime sync wakeups ([#32798](https://github.com/vm0-ai/vm0/issues/32798)) ([8db8218](https://github.com/vm0-ai/vm0/commit/8db8218568b4735afc314b1ce4a5ba9b5498eee5))

## [1.1.0](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.21...ably-subscriber-v1.1.0) (2026-09-08)


### Features

* **runner:** add bounded host-owned ssh execution ([#32526](https://github.com/vm0-ai/vm0/issues/32526)) ([7c84eb2](https://github.com/vm0-ai/vm0/commit/7c84eb254233ad62f4482f7213e1b297cc7e8692))

## [1.0.21](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.20...ably-subscriber-v1.0.21) (2026-09-08)


### Bug Fixes

* **ably-subscriber:** keep subscribe logs off stdout ([#32552](https://github.com/vm0-ai/vm0/issues/32552)) ([97367e4](https://github.com/vm0-ai/vm0/commit/97367e4a420913227406e6c31c9a325abb86cd7f))

## [1.0.20](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.19...ably-subscriber-v1.0.20) (2026-08-28)


### Refactoring

* **rust:** forbid path attributes ([#30129](https://github.com/vm0-ai/vm0/issues/30129)) ([c46da3e](https://github.com/vm0-ai/vm0/commit/c46da3ea8fb48b7595bc582036a1f28a0d676f5f))

## [1.0.19](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.18...ably-subscriber-v1.0.19) (2026-08-28)


### Performance Improvements

* **ably-subscriber:** reuse tokens across reconnect failures ([#30042](https://github.com/vm0-ai/vm0/issues/30042)) ([a7aa6a1](https://github.com/vm0-ai/vm0/commit/a7aa6a198654157e6691720436c030418621aceb))

## [1.0.18](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.17...ably-subscriber-v1.0.18) (2026-08-25)


### Bug Fixes

* **ably-subscriber:** bound token exchange responses ([#29218](https://github.com/vm0-ai/vm0/issues/29218)) ([723cae9](https://github.com/vm0-ai/vm0/commit/723cae9fffd97b08f325c577e95d789bc2979bfb))

## [1.0.17](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.16...ably-subscriber-v1.0.17) (2026-08-25)


### Bug Fixes

* **ably-subscriber:** space short-lived token renewals ([#29129](https://github.com/vm0-ai/vm0/issues/29129)) ([b7ec813](https://github.com/vm0-ai/vm0/commit/b7ec8136c26d04d693bda315a73a5e7790d11ba3))

## [1.0.16](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.15...ably-subscriber-v1.0.16) (2026-08-20)


### Bug Fixes

* **ably-subscriber:** refresh expired token before reconnect ([#28272](https://github.com/vm0-ai/vm0/issues/28272)) ([d63324b](https://github.com/vm0-ai/vm0/commit/d63324bf7ce7242f3b3a48df4b344ed8b62c73ed))

## [1.0.15](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.14...ably-subscriber-v1.0.15) (2026-08-07)


### Documentation

* **ably-subscriber:** document messagepack decoder contract ([#25658](https://github.com/vm0-ai/vm0/issues/25658)) ([876bf2e](https://github.com/vm0-ai/vm0/commit/876bf2e5a3e7f9e8da9fc00492c77f4afe8a570e))

## [1.0.14](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.13...ably-subscriber-v1.0.14) (2026-08-07)


### Bug Fixes

* **ably-subscriber:** treat cleanup broken pipe as closed ([#25578](https://github.com/vm0-ai/vm0/issues/25578)) ([a5be4a4](https://github.com/vm0-ai/vm0/commit/a5be4a4cdbd69135984aade0d44111ed21c66ca4))

## [1.0.13](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.12...ably-subscriber-v1.0.13) (2026-08-06)


### Documentation

* **ably-subscriber:** clarify reconnect timeout scope ([#25481](https://github.com/vm0-ai/vm0/issues/25481)) ([c8fb351](https://github.com/vm0-ai/vm0/commit/c8fb35128b7ed786657e3d5a2489e9adf190153f))

## [1.0.12](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.11...ably-subscriber-v1.0.12) (2026-08-05)


### Documentation

* **ably-subscriber:** document status event backpressure ([#25243](https://github.com/vm0-ai/vm0/issues/25243)) ([06e5e9c](https://github.com/vm0-ai/vm0/commit/06e5e9cd4b1f8e2293d5266aa11b33c8a769dd5c))

## [1.0.11](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.10...ably-subscriber-v1.0.11) (2026-08-05)


### Bug Fixes

* **ably-subscriber:** await graceful shutdown completion ([#25155](https://github.com/vm0-ai/vm0/issues/25155)) ([a54deb6](https://github.com/vm0-ai/vm0/commit/a54deb69811cc546fc94d8c1be547eef16784256))

## [1.0.10](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.9...ably-subscriber-v1.0.10) (2026-08-02)


### Bug Fixes

* **ably-subscriber:** bound messagepack decoder depth ([#24536](https://github.com/vm0-ai/vm0/issues/24536)) ([ca77d14](https://github.com/vm0-ai/vm0/commit/ca77d14a70968ab0704cf1b17f1d833f7b412fa9))

## [1.0.9](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.8...ably-subscriber-v1.0.9) (2026-07-17)


### Bug Fixes

* **ably-subscriber:** redact credentials from debug output ([#21943](https://github.com/vm0-ai/vm0/issues/21943)) ([a1b6164](https://github.com/vm0-ai/vm0/commit/a1b61647dcc0d6b043a8ae0ad6d79108eaf37b23))

## [1.0.8](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.7...ably-subscriber-v1.0.8) (2026-07-16)


### Bug Fixes

* describe zero scrape capabilities in agent context ([#21574](https://github.com/vm0-ai/vm0/issues/21574)) ([5d5b298](https://github.com/vm0-ai/vm0/commit/5d5b298b1396f2e4c1ee6873d429987fcb9df4cc))

## [1.0.7](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.6...ably-subscriber-v1.0.7) (2026-07-15)


### Bug Fixes

* **ably-subscriber:** stop accepting api keys in argv ([#21554](https://github.com/vm0-ai/vm0/issues/21554)) ([09adc87](https://github.com/vm0-ai/vm0/commit/09adc878ac9e5fda49541af26cf06e038f326b6b))

## [1.0.6](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.5...ably-subscriber-v1.0.6) (2026-07-15)

## [1.0.5](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.4...ably-subscriber-v1.0.5) (2026-07-14)


### Bug Fixes

* **ably-subscriber:** enforce clean websocket shutdown ([#21399](https://github.com/vm0-ai/vm0/issues/21399)) ([cf8031e](https://github.com/vm0-ai/vm0/commit/cf8031e425122c0fc5eff333c6d717211045ba6b))

## [1.0.4](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.3...ably-subscriber-v1.0.4) (2026-07-13)


### Performance Improvements

* **ably-subscriber:** bound drop warning emission ([#21202](https://github.com/vm0-ai/vm0/issues/21202)) ([d0e2e87](https://github.com/vm0-ai/vm0/commit/d0e2e879ec4fa8f78e9a74617f774310164dc3bb))

## [1.0.3](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.2...ably-subscriber-v1.0.3) (2026-07-11)


### Documentation

* **ably-subscriber:** remove obsolete integration test numbering ([#21039](https://github.com/vm0-ai/vm0/issues/21039)) ([29e99ad](https://github.com/vm0-ai/vm0/commit/29e99adf55e2e386f96e9d3083008c9d4b2bfc6c))

## [1.0.2](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.1...ably-subscriber-v1.0.2) (2026-06-25)


### Performance Improvements

* avoid ably protocol json decode round trip ([#18886](https://github.com/vm0-ai/vm0/issues/18886)) ([9cd5cd4](https://github.com/vm0-ai/vm0/commit/9cd5cd4c10b28c99c7f0da0f4623c0a995fb3761))

## [1.0.1](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.0...ably-subscriber-v1.0.1) (2026-06-22)


### Bug Fixes

* separate ably attach resume state from channel serial ([#18508](https://github.com/vm0-ai/vm0/issues/18508)) ([e04534e](https://github.com/vm0-ai/vm0/commit/e04534ea758a735ecfccfe6f7501d419b28ae2b7))

## [1.0.0](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.23...ably-subscriber-v1.0.0) (2026-06-19)


### ⚠ BREAKING CHANGES

* **ably-subscriber:** TimingConfig no longer exposes initial_retry_interval, max_retry_interval, max_retry_attempts, or reattach_window. Use disconnected_retry_timeout, suspended_retry_timeout, channel_retry_timeout, min_reconnect_interval, and realtime_request_timeout for active retry behavior.

### Refactoring

* **ably-subscriber:** remove legacy timing config fields ([#18291](https://github.com/vm0-ai/vm0/issues/18291)) ([fc6c3a3](https://github.com/vm0-ai/vm0/commit/fc6c3a39002b2465f3f1551bceceb2b35c6b0eb7)), closes [#18275](https://github.com/vm0-ai/vm0/issues/18275)

## [0.7.23](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.22...ably-subscriber-v0.7.23) (2026-06-18)


### Documentation

* document ably subscriber event fields ([#18150](https://github.com/vm0-ai/vm0/issues/18150)) ([cbf1ef8](https://github.com/vm0-ai/vm0/commit/cbf1ef8fb4d3ebad1acf2846f074fe6b292b29d8))

## [0.7.22](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.21...ably-subscriber-v0.7.22) (2026-06-16)


### Bug Fixes

* **ably-subscriber:** track heartbeat from inbound activity ([#17873](https://github.com/vm0-ai/vm0/issues/17873)) ([8b79b22](https://github.com/vm0-ai/vm0/commit/8b79b222be09e886ef13b9dfc681ffa5fc1089bf))

## [0.7.21](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.20...ably-subscriber-v0.7.21) (2026-06-11)


### Refactoring

* **ably-subscriber:** share example token request signing ([#17314](https://github.com/vm0-ai/vm0/issues/17314)) ([49c0088](https://github.com/vm0-ai/vm0/commit/49c00889cf49a052d7f08532e5476ae870b34e77))

## [0.7.20](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.19...ably-subscriber-v0.7.20) (2026-06-11)


### Bug Fixes

* avoid expanding ably base64 payloads ([#17122](https://github.com/vm0-ai/vm0/issues/17122)) ([2d3de6b](https://github.com/vm0-ai/vm0/commit/2d3de6beadf1a30d37ca06c93c9bfb7c517236c9))

## [0.7.19](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.18...ably-subscriber-v0.7.19) (2026-06-10)


### Documentation

* document ably session state invariants ([#17056](https://github.com/vm0-ai/vm0/issues/17056)) ([e7cd299](https://github.com/vm0-ai/vm0/commit/e7cd2998dc476ef5ba06d05168795a5e294c47c3))

## [0.7.18](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.17...ably-subscriber-v0.7.18) (2026-06-10)


### Refactoring

* split ably session state from event loop ([#16999](https://github.com/vm0-ai/vm0/issues/16999)) ([1482a8f](https://github.com/vm0-ai/vm0/commit/1482a8fff07ac693e468d0c5606dc12291478b4c))

## [0.7.17](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.16...ably-subscriber-v0.7.17) (2026-06-04)


### Bug Fixes

* avoid ably retry counter overflow ([#16167](https://github.com/vm0-ai/vm0/issues/16167)) ([2b84fb4](https://github.com/vm0-ai/vm0/commit/2b84fb4889fa30730edd1dcec8585959c403e52f))

## [0.7.16](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.15...ably-subscriber-v0.7.16) (2026-05-28)


### Bug Fixes

* harden ably protocol frame decoding ([#15255](https://github.com/vm0-ai/vm0/issues/15255)) ([ee6adca](https://github.com/vm0-ai/vm0/commit/ee6adcad45e08e3204fdd1cc3eb0c3130b3f4475))

## [0.7.15](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.14...ably-subscriber-v0.7.15) (2026-05-27)


### Bug Fixes

* harden ably endpoint url construction ([#15111](https://github.com/vm0-ai/vm0/issues/15111)) ([c29a319](https://github.com/vm0-ai/vm0/commit/c29a319d9f4ac4405cbb2cbcb0a121070da8a4c0))

## [0.7.14](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.13...ably-subscriber-v0.7.14) (2026-05-22)


### Refactoring

* merge msgpack binary match arms ([#14548](https://github.com/vm0-ai/vm0/issues/14548)) ([fa416b4](https://github.com/vm0-ai/vm0/commit/fa416b425c65def7346bd0b6d498284428af32a2))

## [0.7.13](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.12...ably-subscriber-v0.7.13) (2026-05-20)


### Bug Fixes

* preserve disconnected event for reattach reconnects ([#14301](https://github.com/vm0-ai/vm0/issues/14301)) ([e49afd8](https://github.com/vm0-ai/vm0/commit/e49afd85b9152d6da44f967a240b3d8c9fe108e1))

## [0.7.12](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.11...ably-subscriber-v0.7.12) (2026-05-19)


### Refactoring

* split ably connection module ([#14010](https://github.com/vm0-ai/vm0/issues/14010)) ([7d07b67](https://github.com/vm0-ai/vm0/commit/7d07b6767ba8151b440c965e109c6d53a2f47c36))

## [0.7.11](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.10...ably-subscriber-v0.7.11) (2026-05-15)


### Bug Fixes

* **ably-subscriber:** avoid overflowing channel deadlines ([#13440](https://github.com/vm0-ai/vm0/issues/13440)) ([f1be9b2](https://github.com/vm0-ai/vm0/commit/f1be9b270ed9b09b962395baffe2e7bd77ef6593))

## [0.7.10](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.9...ably-subscriber-v0.7.10) (2026-05-14)


### Bug Fixes

* align Ably timing deadlines ([#13297](https://github.com/vm0-ai/vm0/issues/13297)) ([0629233](https://github.com/vm0-ai/vm0/commit/06292339aacf79cfe8670a689172aecfa0a56441))


### Documentation

* document ably-subscriber error variants ([#13311](https://github.com/vm0-ai/vm0/issues/13311)) ([779125d](https://github.com/vm0-ai/vm0/commit/779125dd4a7bff16df94d8110fb4e8e785d6e65d))

## [0.7.9](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.8...ably-subscriber-v0.7.9) (2026-05-07)


### Bug Fixes

* **ably-subscriber:** require exact localhost match ([#12074](https://github.com/vm0-ai/vm0/issues/12074)) ([9195e5d](https://github.com/vm0-ai/vm0/commit/9195e5d47688054235b7b6acd5d0ebb1a11fb4f9))

## [0.7.8](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.7...ably-subscriber-v0.7.8) (2026-05-07)


### Documentation

* **ably-subscriber:** document token fields ([#12012](https://github.com/vm0-ai/vm0/issues/12012)) ([a4f4671](https://github.com/vm0-ai/vm0/commit/a4f4671fe969048fbce4cf77cb0cbc7a378dee71))

## [0.7.7](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.6...ably-subscriber-v0.7.7) (2026-05-05)


### Bug Fixes

* **runner:** escalate prolonged ably disconnects ([#11839](https://github.com/vm0-ai/vm0/issues/11839)) ([40b7d97](https://github.com/vm0-ai/vm0/commit/40b7d979c02f820a85950f0cb449fddc47461af7))

## [0.7.6](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.5...ably-subscriber-v0.7.6) (2026-05-03)


### Refactoring

* model ably subscriber lifecycle states ([#11672](https://github.com/vm0-ai/vm0/issues/11672)) ([c663ee4](https://github.com/vm0-ai/vm0/commit/c663ee49c6ed92a815e704496e793f3d76949a0d))


### Performance Improvements

* **ably-subscriber:** avoid cloning rmpv strings ([#11695](https://github.com/vm0-ai/vm0/issues/11695)) ([1523da8](https://github.com/vm0-ai/vm0/commit/1523da837cd954e7134e31ddd85f9979e4c05342))

## [0.7.5](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.4...ably-subscriber-v0.7.5) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.7.4](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.3...ably-subscriber-v0.7.4) (2026-05-01)


### Bug Fixes

* harden ably disconnect handling ([#11656](https://github.com/vm0-ai/vm0/issues/11656)) ([c0c50d8](https://github.com/vm0-ai/vm0/commit/c0c50d88154f7ad74af791fc2df9e5a8db609418))

## [0.7.3](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.2...ably-subscriber-v0.7.3) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.7.2](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.1...ably-subscriber-v0.7.2) (2026-04-16)


### Bug Fixes

* **ably-subscriber:** reset last_reattach_at after successful reconnect ([#9660](https://github.com/vm0-ai/vm0/issues/9660)) ([57a18fd](https://github.com/vm0-ai/vm0/commit/57a18fd25cec4179c85f6666b40b7b1593709792)), closes [#9654](https://github.com/vm0-ai/vm0/issues/9654)

## [0.7.1](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.0...ably-subscriber-v0.7.1) (2026-04-13)

## [0.7.0](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.6.5...ably-subscriber-v0.7.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.6.5](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.6.4...ably-subscriber-v0.6.5) (2026-03-29)


### Bug Fixes

* **crates:** update sha2/hmac usage for digest 0.11 compatibility ([#7101](https://github.com/vm0-ai/vm0/issues/7101)) ([cbded46](https://github.com/vm0-ai/vm0/commit/cbded46e78c8d3ed060e96f79f15cd38ee1cf9dc))

## [0.6.4](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.6.3...ably-subscriber-v0.6.4) (2026-03-17)


### Refactoring

* **rust:** replace inline crate:: paths with top-level use imports ([#5061](https://github.com/vm0-ai/vm0/issues/5061)) ([149aaa0](https://github.com/vm0-ai/vm0/commit/149aaa09ca2bf69ffb1bc35471ba813e5884e534)), closes [#5038](https://github.com/vm0-ai/vm0/issues/5038)

## [0.6.3](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.6.2...ably-subscriber-v0.6.3) (2026-02-27)


### Bug Fixes

* **ably-subscriber:** align protocol handling with ably-js sdk ([#3275](https://github.com/vm0-ai/vm0/issues/3275)) ([7b01abf](https://github.com/vm0-ai/vm0/commit/7b01abf76b978416aaf7f6c7ccc3ee6efb94e1c3)), closes [#3274](https://github.com/vm0-ai/vm0/issues/3274)

## [0.6.2](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.6.1...ably-subscriber-v0.6.2) (2026-02-27)


### Bug Fixes

* **ably-subscriber:** always re-attach channel after reconnect to prevent zombie subscriptions ([#3271](https://github.com/vm0-ai/vm0/issues/3271)) ([0e449cb](https://github.com/vm0-ai/vm0/commit/0e449cb1ef1cb2e54fc05675f6634a0659923497))

## [0.6.1](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.6.0...ably-subscriber-v0.6.1) (2026-02-26)


### Bug Fixes

* **ably-subscriber:** handle close frames and skip backoff on clean disconnect ([#3263](https://github.com/vm0-ai/vm0/issues/3263)) ([caddb21](https://github.com/vm0-ai/vm0/commit/caddb213b4df4dada54f8d368083ada6a6d9a287)), closes [#3262](https://github.com/vm0-ai/vm0/issues/3262)

## [0.6.0](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.5.0...ably-subscriber-v0.6.0) (2026-02-23)


### Features

* **ably-subscriber:** add dropped message counter for backpressure observability ([#2913](https://github.com/vm0-ai/vm0/issues/2913)) ([94325b9](https://github.com/vm0-ai/vm0/commit/94325b9481f84026e046b04a96ca7878702c8080)), closes [#2909](https://github.com/vm0-ai/vm0/issues/2909)
* **ably-subscriber:** add rust ably realtime subscribe-only sdk ([#2790](https://github.com/vm0-ai/vm0/issues/2790)) ([d1f630c](https://github.com/vm0-ai/vm0/commit/d1f630cb2d30aab52e46a7aba20f9495da00d2cd))
* **ably-subscriber:** extract timing constants into configurable struct ([#2938](https://github.com/vm0-ai/vm0/issues/2938)) ([0ac4072](https://github.com/vm0-ai/vm0/commit/0ac407272ac166f134d2ca61874f58214a966849))


### Bug Fixes

* **crates:** use system tls certificates instead of bundled webpki-roots ([#2824](https://github.com/vm0-ai/vm0/issues/2824)) ([aa95e93](https://github.com/vm0-ai/vm0/commit/aa95e9328dc99d77215d30e8545de11211a12792))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.4.0...ably-subscriber-v0.5.0) (2026-02-23)


### Features

* **ably-subscriber:** add dropped message counter for backpressure observability ([#2913](https://github.com/vm0-ai/vm0/issues/2913)) ([94325b9](https://github.com/vm0-ai/vm0/commit/94325b9481f84026e046b04a96ca7878702c8080)), closes [#2909](https://github.com/vm0-ai/vm0/issues/2909)
* **ably-subscriber:** add rust ably realtime subscribe-only sdk ([#2790](https://github.com/vm0-ai/vm0/issues/2790)) ([d1f630c](https://github.com/vm0-ai/vm0/commit/d1f630cb2d30aab52e46a7aba20f9495da00d2cd))
* **ably-subscriber:** extract timing constants into configurable struct ([#2938](https://github.com/vm0-ai/vm0/issues/2938)) ([0ac4072](https://github.com/vm0-ai/vm0/commit/0ac407272ac166f134d2ca61874f58214a966849))


### Bug Fixes

* **crates:** use system tls certificates instead of bundled webpki-roots ([#2824](https://github.com/vm0-ai/vm0/issues/2824)) ([aa95e93](https://github.com/vm0-ai/vm0/commit/aa95e9328dc99d77215d30e8545de11211a12792))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.3.0...ably-subscriber-v0.4.0) (2026-02-22)


### Features

* **ably-subscriber:** add dropped message counter for backpressure observability ([#2913](https://github.com/vm0-ai/vm0/issues/2913)) ([94325b9](https://github.com/vm0-ai/vm0/commit/94325b9481f84026e046b04a96ca7878702c8080)), closes [#2909](https://github.com/vm0-ai/vm0/issues/2909)
* **ably-subscriber:** add rust ably realtime subscribe-only sdk ([#2790](https://github.com/vm0-ai/vm0/issues/2790)) ([d1f630c](https://github.com/vm0-ai/vm0/commit/d1f630cb2d30aab52e46a7aba20f9495da00d2cd))
* **ably-subscriber:** extract timing constants into configurable struct ([#2938](https://github.com/vm0-ai/vm0/issues/2938)) ([0ac4072](https://github.com/vm0-ai/vm0/commit/0ac407272ac166f134d2ca61874f58214a966849))


### Bug Fixes

* **crates:** use system tls certificates instead of bundled webpki-roots ([#2824](https://github.com/vm0-ai/vm0/issues/2824)) ([aa95e93](https://github.com/vm0-ai/vm0/commit/aa95e9328dc99d77215d30e8545de11211a12792))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.2.0...ably-subscriber-v0.3.0) (2026-02-22)


### Features

* **ably-subscriber:** add dropped message counter for backpressure observability ([#2913](https://github.com/vm0-ai/vm0/issues/2913)) ([94325b9](https://github.com/vm0-ai/vm0/commit/94325b9481f84026e046b04a96ca7878702c8080)), closes [#2909](https://github.com/vm0-ai/vm0/issues/2909)
* **ably-subscriber:** add rust ably realtime subscribe-only sdk ([#2790](https://github.com/vm0-ai/vm0/issues/2790)) ([d1f630c](https://github.com/vm0-ai/vm0/commit/d1f630cb2d30aab52e46a7aba20f9495da00d2cd))
* **ably-subscriber:** extract timing constants into configurable struct ([#2938](https://github.com/vm0-ai/vm0/issues/2938)) ([0ac4072](https://github.com/vm0-ai/vm0/commit/0ac407272ac166f134d2ca61874f58214a966849))


### Bug Fixes

* **crates:** use system tls certificates instead of bundled webpki-roots ([#2824](https://github.com/vm0-ai/vm0/issues/2824)) ([aa95e93](https://github.com/vm0-ai/vm0/commit/aa95e9328dc99d77215d30e8545de11211a12792))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.1.0...ably-subscriber-v0.2.0) (2026-02-22)


### Features

* **ably-subscriber:** add dropped message counter for backpressure observability ([#2913](https://github.com/vm0-ai/vm0/issues/2913)) ([94325b9](https://github.com/vm0-ai/vm0/commit/94325b9481f84026e046b04a96ca7878702c8080)), closes [#2909](https://github.com/vm0-ai/vm0/issues/2909)
* **ably-subscriber:** add rust ably realtime subscribe-only sdk ([#2790](https://github.com/vm0-ai/vm0/issues/2790)) ([d1f630c](https://github.com/vm0-ai/vm0/commit/d1f630cb2d30aab52e46a7aba20f9495da00d2cd))
* **ably-subscriber:** extract timing constants into configurable struct ([#2938](https://github.com/vm0-ai/vm0/issues/2938)) ([0ac4072](https://github.com/vm0-ai/vm0/commit/0ac407272ac166f134d2ca61874f58214a966849))


### Bug Fixes

* **crates:** use system tls certificates instead of bundled webpki-roots ([#2824](https://github.com/vm0-ai/vm0/issues/2824)) ([aa95e93](https://github.com/vm0-ai/vm0/commit/aa95e9328dc99d77215d30e8545de11211a12792))
