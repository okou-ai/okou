# Changelog

## [0.5.2](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.5.1...nbd-cow-v0.5.2) (2026-09-15)


### Documentation

* **nbd-cow:** clarify device flush and persistence behavior ([#34279](https://github.com/vm0-ai/vm0/issues/34279)) ([21e18cf](https://github.com/vm0-ai/vm0/commit/21e18cff8d8318c6eef18b797a736ef20c5854b6))

## [0.5.1](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.5.0...nbd-cow-v0.5.1) (2026-09-10)


### Bug Fixes

* **nbd-cow:** derive buffered bytes from retained blocks ([#33244](https://github.com/vm0-ai/vm0/issues/33244)) ([b637ee5](https://github.com/vm0-ai/vm0/commit/b637ee50e364b0c4b064801603ce6902e06abb53))
* **nbd-cow:** offload unobserved connect cleanup from async workers ([#33250](https://github.com/vm0-ai/vm0/issues/33250)) ([b5de2de](https://github.com/vm0-ai/vm0/commit/b5de2de96a35ca9eeb5c903830641e12d743c7e8))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.85...nbd-cow-v0.5.0) (2026-09-08)


### Features

* **runner:** add bounded host-owned ssh execution ([#32526](https://github.com/vm0-ai/vm0/issues/32526)) ([7c84eb2](https://github.com/vm0-ai/vm0/commit/7c84eb254233ad62f4482f7213e1b297cc7e8692))

## [0.4.85](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.84...nbd-cow-v0.4.85) (2026-09-07)


### Documentation

* **nbd-cow:** document error variant semantics ([#32245](https://github.com/vm0-ai/vm0/issues/32245)) ([d51935d](https://github.com/vm0-ai/vm0/commit/d51935dd66488b269f866ecbe5d3e09b15451ac0))

## [0.4.84](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.83...nbd-cow-v0.4.84) (2026-09-03)


### Documentation

* **nbd-cow:** describe cooldown claim reuse ([#31441](https://github.com/vm0-ai/vm0/issues/31441)) ([982a70e](https://github.com/vm0-ai/vm0/commit/982a70eb10c0b6192a58a34278f876b5af9700ba))

## [0.4.83](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.82...nbd-cow-v0.4.83) (2026-09-02)


### Performance Improvements

* **nbd-cow:** send read replies with vectored writes ([#30983](https://github.com/vm0-ai/vm0/issues/30983)) ([0f1970d](https://github.com/vm0-ai/vm0/commit/0f1970de83b0ffeec68a1cb8865524bddeec3e96))

## [0.4.82](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.81...nbd-cow-v0.4.82) (2026-08-28)


### Refactoring

* **rust:** forbid path attributes ([#30129](https://github.com/vm0-ai/vm0/issues/30129)) ([c46da3e](https://github.com/vm0-ai/vm0/commit/c46da3ea8fb48b7595bc582036a1f28a0d676f5f))

## [0.4.81](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.80...nbd-cow-v0.4.81) (2026-08-28)


### Documentation

* **nbd-cow:** clarify host disk benchmark attribution ([#30031](https://github.com/vm0-ai/vm0/issues/30031)) ([df7a764](https://github.com/vm0-ai/vm0/commit/df7a7646389f1b4937dfbdfd5c9b6faa04a7ffda))

## [0.4.80](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.79...nbd-cow-v0.4.80) (2026-08-27)


### Bug Fixes

* **rust:** fail closed on nbd owner lookup errors ([#29897](https://github.com/vm0-ai/vm0/issues/29897)) ([96f4511](https://github.com/vm0-ai/vm0/commit/96f451182cd012db06b0c615ee13fd2de0657a33))

## [0.4.79](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.78...nbd-cow-v0.4.79) (2026-08-27)


### Documentation

* **nbd-cow:** clarify relocation ordering contract ([#29714](https://github.com/vm0-ai/vm0/issues/29714)) ([f94ec05](https://github.com/vm0-ai/vm0/commit/f94ec05d3c16e0368c885a52ee2cdf904633a518))

## [0.4.78](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.77...nbd-cow-v0.4.78) (2026-08-21)


### Bug Fixes

* **nbd-cow:** prevent stale disconnects after tid reuse ([#28541](https://github.com/vm0-ai/vm0/issues/28541)) ([4a8bf0c](https://github.com/vm0-ai/vm0/commit/4a8bf0cba369d67b648f888a55c554eb3bbd27cd))


### Performance Improvements

* **nbd-cow:** share scans across acquire waiters ([#28539](https://github.com/vm0-ai/vm0/issues/28539)) ([02a08ae](https://github.com/vm0-ai/vm0/commit/02a08ae4bbe4418bbec825d4a07e3baaf6c72bd7))

## [0.4.77](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.76...nbd-cow-v0.4.77) (2026-08-20)


### Documentation

* **nbd-cow:** qualify abandoned device cleanup ([#28157](https://github.com/vm0-ai/vm0/issues/28157)) ([b3e7f17](https://github.com/vm0-ai/vm0/commit/b3e7f17f58671009243a9604ff39a7f8ef801d3d))

## [0.4.76](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.75...nbd-cow-v0.4.76) (2026-08-18)


### Bug Fixes

* **nbd-cow:** observe detached owned disconnect results ([#27977](https://github.com/vm0-ai/vm0/issues/27977)) ([340195f](https://github.com/vm0-ai/vm0/commit/340195f5be5819807f38fccd40dd4e1867a8ebb2))

## [0.4.75](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.74...nbd-cow-v0.4.75) (2026-08-14)


### Bug Fixes

* **nbd-cow:** remove benchmark dependency on which executable ([#27119](https://github.com/vm0-ai/vm0/issues/27119)) ([d7f6f38](https://github.com/vm0-ai/vm0/commit/d7f6f38660606d777f3d17d0d0a5c91d00510685))

## [0.4.74](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.73...nbd-cow-v0.4.74) (2026-08-13)


### Refactoring

* **rust:** centralize nbd orphan cleanup ownership ([#26880](https://github.com/vm0-ai/vm0/issues/26880)) ([0690874](https://github.com/vm0-ai/vm0/commit/069087456bdaf89f4ee8586ee1f5c1497c956f94))


### Performance Improvements

* **nbd-cow:** coalesce contiguous flush writes ([#26875](https://github.com/vm0-ai/vm0/issues/26875)) ([b574968](https://github.com/vm0-ai/vm0/commit/b5749682d32a907238135d83f4bc8de4015a560b))

## [0.4.73](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.72...nbd-cow-v0.4.73) (2026-08-06)


### Documentation

* **nbd-cow:** document pooled snapshot restore ([#25407](https://github.com/vm0-ai/vm0/issues/25407)) ([70e168a](https://github.com/vm0-ai/vm0/commit/70e168adb652e259bb727feb7b0e45c92adcb951))

## [0.4.72](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.71...nbd-cow-v0.4.72) (2026-08-06)


### Documentation

* **nbd-cow:** document cow io cancellation semantics ([#25338](https://github.com/vm0-ai/vm0/issues/25338)) ([51502fb](https://github.com/vm0-ai/vm0/commit/51502fbe14b0fc76a5dbce4b369aa5c06d8316f5))

## [0.4.71](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.70...nbd-cow-v0.4.71) (2026-08-03)


### Performance Improvements

* **nbd-cow:** decode bitmaps in chunks ([#24727](https://github.com/vm0-ai/vm0/issues/24727)) ([0280a52](https://github.com/vm0-ai/vm0/commit/0280a52383a7002aad480b0f3d34305adaaba31d))

## [0.4.70](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.69...nbd-cow-v0.4.70) (2026-07-31)


### Documentation

* **rust:** align cow layer threshold and restore contracts ([#24251](https://github.com/vm0-ai/vm0/issues/24251)) ([022c237](https://github.com/vm0-ai/vm0/commit/022c237491bd53852a9c7e67219e2a54fc8f8e25))

## [0.4.69](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.68...nbd-cow-v0.4.69) (2026-07-23)


### Performance Improvements

* **runner:** preconnect one-shot nbd cow slots ([#22683](https://github.com/vm0-ai/vm0/issues/22683)) ([1d02f4a](https://github.com/vm0-ai/vm0/commit/1d02f4a9e5df3d981da9fbf99606bd10d31b1a16))

## [0.4.68](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.67...nbd-cow-v0.4.68) (2026-07-23)


### Documentation

* **nbd-cow:** clarify request length semantics ([#22629](https://github.com/vm0-ai/vm0/issues/22629)) ([14e590f](https://github.com/vm0-ai/vm0/commit/14e590f48819d74003d8a7483e7834cbfeaed593))

## [0.4.67](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.66...nbd-cow-v0.4.67) (2026-07-20)


### Documentation

* **rust:** run nbd-cow integration binary as root ([#22180](https://github.com/vm0-ai/vm0/issues/22180)) ([401ae9e](https://github.com/vm0-ai/vm0/commit/401ae9e9eebe5a2918801fded8d74bba45ab5ef6))

## [0.4.66](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.65...nbd-cow-v0.4.66) (2026-07-16)


### Bug Fixes

* describe zero scrape capabilities in agent context ([#21574](https://github.com/vm0-ai/vm0/issues/21574)) ([5d5b298](https://github.com/vm0-ai/vm0/commit/5d5b298b1396f2e4c1ee6873d429987fcb9df4cc))

## [0.4.65](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.64...nbd-cow-v0.4.65) (2026-07-15)


### Documentation

* **nbd-cow:** clarify destroy retry boundary ([#21660](https://github.com/vm0-ai/vm0/issues/21660)) ([609bfba](https://github.com/vm0-ai/vm0/commit/609bfba27dc30fc4c0bb9c211c9008b2d17a9ef6))

## [0.4.64](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.63...nbd-cow-v0.4.64) (2026-07-15)


### Documentation

* **nbd-cow:** document detailed destroy runtime contract ([#21652](https://github.com/vm0-ai/vm0/issues/21652)) ([4b58ead](https://github.com/vm0-ai/vm0/commit/4b58ead42b3ff9f168db65dac94205f452ef5554))

## [0.4.63](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.62...nbd-cow-v0.4.63) (2026-07-15)


### Documentation

* **nbd-cow:** clarify device pool cleanup contract ([#21624](https://github.com/vm0-ai/vm0/issues/21624)) ([0fa15ae](https://github.com/vm0-ai/vm0/commit/0fa15aeebdead8a594abe67b3a5545c431a65821))

## [0.4.62](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.61...nbd-cow-v0.4.62) (2026-07-15)


### Documentation

* **rust:** define create observer semantics ([#21590](https://github.com/vm0-ai/vm0/issues/21590)) ([14199e1](https://github.com/vm0-ai/vm0/commit/14199e11ee1e8241fd832d1a0214949628cf1f3a))

## [0.4.61](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.60...nbd-cow-v0.4.61) (2026-07-13)


### Performance Improvements

* **nbd-cow:** reduce default connection count ([#21232](https://github.com/vm0-ai/vm0/issues/21232)) ([ecadce2](https://github.com/vm0-ai/vm0/commit/ecadce247ec1997c8df6c95bb18c0a25bf720d9c))

## [0.4.60](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.59...nbd-cow-v0.4.60) (2026-07-12)


### Performance Improvements

* attribute nbd netlink connect latency ([#21121](https://github.com/vm0-ai/vm0/issues/21121)) ([7ff85a6](https://github.com/vm0-ai/vm0/commit/7ff85a6d10e757e24534f5f9a00a1cab1342eb4d))

## [0.4.59](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.58...nbd-cow-v0.4.59) (2026-07-11)


### Performance Improvements

* **runner:** attribute nbd cow creation latency ([#21065](https://github.com/vm0-ai/vm0/issues/21065)) ([7d97c9a](https://github.com/vm0-ai/vm0/commit/7d97c9a0e83e09645f97675c2594fad08b54bfc7))

## [0.4.58](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.57...nbd-cow-v0.4.58) (2026-07-09)


### Documentation

* **nbd-cow:** clarify device lock contract ([#20797](https://github.com/vm0-ai/vm0/issues/20797)) ([97afffd](https://github.com/vm0-ai/vm0/commit/97afffddfa0942da27809a12e98813e8959dcc1f))

## [0.4.57](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.56...nbd-cow-v0.4.57) (2026-07-06)


### Performance Improvements

* **nbd-cow:** stream bitmap serialization ([#20317](https://github.com/vm0-ai/vm0/issues/20317)) ([3a02a98](https://github.com/vm0-ai/vm0/commit/3a02a9842cc34eb9323662e4588f7c539eaa1566))

## [0.4.56](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.55...nbd-cow-v0.4.56) (2026-07-05)


### Bug Fixes

* **nbd-cow:** harden device lock files ([#20249](https://github.com/vm0-ai/vm0/issues/20249)) ([dc76129](https://github.com/vm0-ai/vm0/commit/dc76129c9ce603ec597af310038aa188dbd388ce))

## [0.4.55](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.54...nbd-cow-v0.4.55) (2026-07-01)


### Performance Improvements

* move nbd cow io off dispatch workers ([#19624](https://github.com/vm0-ai/vm0/issues/19624)) ([35673e6](https://github.com/vm0-ai/vm0/commit/35673e6e05da221fa3f6ce1e6ccd78ba07d98083))

## [0.4.54](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.53...nbd-cow-v0.4.54) (2026-07-01)


### Documentation

* document nbd-cow pool handle lifecycle ([#19585](https://github.com/vm0-ai/vm0/issues/19585)) ([94ee14d](https://github.com/vm0-ai/vm0/commit/94ee14deb32c25ff6d127cac6dd69a70c5428d23))

## [0.4.53](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.52...nbd-cow-v0.4.53) (2026-06-30)


### Refactoring

* centralize fio section selection ([#19432](https://github.com/vm0-ai/vm0/issues/19432)) ([d8bd416](https://github.com/vm0-ai/vm0/commit/d8bd4161dc8c63b2f40738c953be2b6c23ce45b2))

## [0.4.52](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.51...nbd-cow-v0.4.52) (2026-06-30)


### Bug Fixes

* **nbd-cow:** coalesce contiguous cow reads ([#19380](https://github.com/vm0-ai/vm0/issues/19380)) ([6fbfef3](https://github.com/vm0-ai/vm0/commit/6fbfef39c78451fe52ec1fae80fdf8cd298305e5))

## [0.4.51](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.50...nbd-cow-v0.4.51) (2026-06-29)


### Bug Fixes

* guard netlink errno parsing ([#19261](https://github.com/vm0-ai/vm0/issues/19261)) ([cca95ba](https://github.com/vm0-ai/vm0/commit/cca95baaa9ca97f50545f96c9620419fd1132325))

## [0.4.50](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.49...nbd-cow-v0.4.50) (2026-06-27)


### Performance Improvements

* **nbd-cow:** avoid redundant pid stat during scans ([#19162](https://github.com/vm0-ai/vm0/issues/19162)) ([6b23b2b](https://github.com/vm0-ai/vm0/commit/6b23b2b4f836adcb34259ca95ac3bf21322d49be))

## [0.4.49](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.48...nbd-cow-v0.4.49) (2026-06-26)


### Refactoring

* **nbd-cow:** simplify dispatch wire helpers ([#19124](https://github.com/vm0-ai/vm0/issues/19124)) ([34a778a](https://github.com/vm0-ai/vm0/commit/34a778a6f1b8df0be01ab049c8f82206d361aead))

## [0.4.48](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.47...nbd-cow-v0.4.48) (2026-06-26)


### Refactoring

* **nbd-cow:** split create transaction phases ([#19071](https://github.com/vm0-ai/vm0/issues/19071)) ([1f75431](https://github.com/vm0-ai/vm0/commit/1f7543124e35e9c6acbbb6dcacaf01627f6a725a))

## [0.4.47](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.46...nbd-cow-v0.4.47) (2026-06-25)


### Refactoring

* **nbd-cow:** hide protocol internals ([#18935](https://github.com/vm0-ai/vm0/issues/18935)) ([d4770c1](https://github.com/vm0-ai/vm0/commit/d4770c122e875f82fdcdc136fcc73c14f324eb0a))

## [0.4.46](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.45...nbd-cow-v0.4.46) (2026-06-25)


### Refactoring

* **nbd-cow:** clarify create cleanup policy ([#18902](https://github.com/vm0-ai/vm0/issues/18902)) ([b88a1ac](https://github.com/vm0-ai/vm0/commit/b88a1acc99033cd9154f36ce60975699ae045e2c))

## [0.4.45](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.44...nbd-cow-v0.4.45) (2026-06-23)


### Documentation

* document pooled nbd cow lifecycle ([#18687](https://github.com/vm0-ai/vm0/issues/18687)) ([4256f9e](https://github.com/vm0-ai/vm0/commit/4256f9e41ddb5efa46e15ce6879b098412462a26))

## [0.4.44](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.43...nbd-cow-v0.4.44) (2026-06-23)


### Refactoring

* **nbd-cow:** simplify protocol header codec ([#18671](https://github.com/vm0-ai/vm0/issues/18671)) ([6d4a349](https://github.com/vm0-ai/vm0/commit/6d4a34912fe37ad2ed8f750de87dbf46b23f4953))

## [0.4.43](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.42...nbd-cow-v0.4.43) (2026-06-18)


### Refactoring

* split nbd-cow benchmark modules ([#18294](https://github.com/vm0-ai/vm0/issues/18294)) ([250dc50](https://github.com/vm0-ai/vm0/commit/250dc502a38c51900dcea793fbafe11a8c9e53c5))

## [0.4.42](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.41...nbd-cow-v0.4.42) (2026-06-18)


### Refactoring

* **nbd-cow:** split device lifecycle internals ([#18214](https://github.com/vm0-ai/vm0/issues/18214)) ([11d7c56](https://github.com/vm0-ai/vm0/commit/11d7c567192a25e8ae27ca87f8722682dedd1631))

## [0.4.41](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.40...nbd-cow-v0.4.41) (2026-06-18)


### Refactoring

* **nbd-cow:** split cow bitmap internals ([#18190](https://github.com/vm0-ai/vm0/issues/18190)) ([9361d16](https://github.com/vm0-ai/vm0/commit/9361d16c5b8869c2521cd214d472ca845c8ab74f))

## [0.4.40](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.39...nbd-cow-v0.4.40) (2026-06-16)


### Bug Fixes

* **sandbox-fc:** validate firecracker artifact prerequisites ([#17824](https://github.com/vm0-ai/vm0/issues/17824)) ([3b607ae](https://github.com/vm0-ai/vm0/commit/3b607aea95034e78b8d50577e371de83a5c9f9dd))

## [0.4.39](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.38...nbd-cow-v0.4.39) (2026-06-15)


### Bug Fixes

* guard nbd cooldown deadline overflow ([#17740](https://github.com/vm0-ai/vm0/issues/17740)) ([56e6826](https://github.com/vm0-ai/vm0/commit/56e6826569514eb8e98df69dd00eead4ba19a962))


### Refactoring

* **nbd-cow:** rebuild netlink wire messages by append ([#17741](https://github.com/vm0-ai/vm0/issues/17741)) ([c658603](https://github.com/vm0-ai/vm0/commit/c658603d2db8328a00f444243002b39e1d3f0972))

## [0.4.38](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.37...nbd-cow-v0.4.38) (2026-06-15)


### Performance Improvements

* **nbd-cow:** avoid zero-filling full-block writes ([#17700](https://github.com/vm0-ai/vm0/issues/17700)) ([f15d99c](https://github.com/vm0-ai/vm0/commit/f15d99cfd6cf76591aaae175a773186b66e02ae7))

## [0.4.37](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.36...nbd-cow-v0.4.37) (2026-06-12)


### Refactoring

* **nbd-cow:** split device pool actor and state ([#17446](https://github.com/vm0-ai/vm0/issues/17446)) ([789fc5d](https://github.com/vm0-ai/vm0/commit/789fc5d4c10cd1ef366bd859cc858dbffd080010))

## [0.4.36](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.35...nbd-cow-v0.4.36) (2026-06-11)


### Refactoring

* split nbd cow integration fixtures ([#17332](https://github.com/vm0-ai/vm0/issues/17332)) ([f175775](https://github.com/vm0-ai/vm0/commit/f1757750f1b3bb9962dfcac767793325fcb8f278))

## [0.4.35](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.34...nbd-cow-v0.4.35) (2026-06-07)


### Performance Improvements

* **nbd-cow:** avoid blocking fio benchmark wait ([#16453](https://github.com/vm0-ai/vm0/issues/16453)) ([1f1b3eb](https://github.com/vm0-ai/vm0/commit/1f1b3eb8424215c8e16c5ec8cedc852e48c9dcb6))

## [0.4.34](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.33...nbd-cow-v0.4.34) (2026-06-05)


### Bug Fixes

* offload nbd netlink critical sections ([#16246](https://github.com/vm0-ai/vm0/issues/16246)) ([0e25bae](https://github.com/vm0-ai/vm0/commit/0e25bae1f967857478a454ba7448653a8e7cf058))

## [0.4.33](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.32...nbd-cow-v0.4.33) (2026-06-05)


### Refactoring

* **nbd-cow:** use safe netlink socket wrappers ([#16249](https://github.com/vm0-ai/vm0/issues/16249)) ([ed5848b](https://github.com/vm0-ai/vm0/commit/ed5848becef1c9f86d362b54194d2007954d2521))

## [0.4.32](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.31...nbd-cow-v0.4.32) (2026-06-04)


### Refactoring

* extract nbd cow dispatch test harness ([#16140](https://github.com/vm0-ai/vm0/issues/16140)) ([280d6ca](https://github.com/vm0-ai/vm0/commit/280d6cae22a379ff4ed2c611eb532202c8fd0efa))

## [0.4.31](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.30...nbd-cow-v0.4.31) (2026-06-04)


### Refactoring

* share nbd cow block spans ([#16076](https://github.com/vm0-ai/vm0/issues/16076)) ([4532704](https://github.com/vm0-ai/vm0/commit/45327045e27dc8545dfa42a2051d054d722d47f5))

## [0.4.30](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.29...nbd-cow-v0.4.30) (2026-06-03)


### Bug Fixes

* **nbd-cow:** bound netlink reply attrs by message length ([#16017](https://github.com/vm0-ai/vm0/issues/16017)) ([aaf48f2](https://github.com/vm0-ai/vm0/commit/aaf48f2ebf91420fc17827c7ba4342236523f0de))

## [0.4.29](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.28...nbd-cow-v0.4.29) (2026-06-03)


### Refactoring

* separate nbd netlink wire handling ([#15944](https://github.com/vm0-ai/vm0/issues/15944)) ([9c337fe](https://github.com/vm0-ai/vm0/commit/9c337fe8f4c8e6e4dad9fe1fca196d00010f362e))

## [0.4.28](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.27...nbd-cow-v0.4.28) (2026-06-02)


### Performance Improvements

* **nbd-cow:** avoid linear scan exclusions ([#15810](https://github.com/vm0-ai/vm0/issues/15810)) ([e914e4a](https://github.com/vm0-ai/vm0/commit/e914e4a1d6a4ac278cf9e99cef888b384462a620))

## [0.4.27](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.26...nbd-cow-v0.4.27) (2026-05-31)


### Bug Fixes

* allow nbd dispatch shutdown during socket io ([#15561](https://github.com/vm0-ai/vm0/issues/15561)) ([da1959e](https://github.com/vm0-ai/vm0/commit/da1959e2bf736f9ab56f1cf07dc12501ed5b3bbf))
* validate cowlayer constructor invariants ([#15565](https://github.com/vm0-ai/vm0/issues/15565)) ([4555f68](https://github.com/vm0-ai/vm0/commit/4555f689ab30fcd8ce1414943276604626dc8865))

## [0.4.26](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.25...nbd-cow-v0.4.26) (2026-05-31)


### Performance Improvements

* **nbd-cow:** reuse dispatch payload buffers ([#15557](https://github.com/vm0-ai/vm0/issues/15557)) ([10a236e](https://github.com/vm0-ai/vm0/commit/10a236ee7d5e0d70ba05ef5a8cdcc50ca6f6885c))

## [0.4.25](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.24...nbd-cow-v0.4.25) (2026-05-25)


### Performance Improvements

* **nbd-cow:** skip read-before-write for full-block writes ([#14847](https://github.com/vm0-ai/vm0/issues/14847)) ([b370b57](https://github.com/vm0-ai/vm0/commit/b370b5751589f7afd9dd2c10c4259bf27328f679))

## [0.4.24](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.23...nbd-cow-v0.4.24) (2026-05-25)


### Performance Improvements

* **nbd-cow:** avoid try_clone fcntl syscall in flush() ([#14841](https://github.com/vm0-ai/vm0/issues/14841)) ([0ba1623](https://github.com/vm0-ai/vm0/commit/0ba16239e16bf3d402205675473812ad3d21a71b))

## [0.4.23](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.22...nbd-cow-v0.4.23) (2026-05-24)


### Refactoring

* **nbd-cow:** deduplicate destroy retry loop ([#14670](https://github.com/vm0-ai/vm0/issues/14670)) ([229a05c](https://github.com/vm0-ai/vm0/commit/229a05cc2c219fe8c688afdc23e5b8bf9957c064))

## [0.4.22](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.21...nbd-cow-v0.4.22) (2026-05-16)


### Refactoring

* deduplicate nbd-cow nla builders ([#13547](https://github.com/vm0-ai/vm0/issues/13547)) ([71ea676](https://github.com/vm0-ai/vm0/commit/71ea6762f139009f6fae4433dd6c1d75dc74db1c))

## [0.4.21](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.20...nbd-cow-v0.4.21) (2026-05-14)


### Performance Improvements

* **nbd-cow:** avoid flush buffer allocation ([#13308](https://github.com/vm0-ai/vm0/issues/13308)) ([8c9e685](https://github.com/vm0-ai/vm0/commit/8c9e6854454b6a791c146056e88066a8ebd084ee))

## [0.4.20](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.19...nbd-cow-v0.4.20) (2026-05-12)


### Bug Fixes

* report workload fio metrics in nbd-cow bench ([#12947](https://github.com/vm0-ai/vm0/issues/12947)) ([e3d34d2](https://github.com/vm0-ai/vm0/commit/e3d34d2bb2510ef11f6d0ed2af5ff2a13ab8cc19))

## [0.4.19](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.18...nbd-cow-v0.4.19) (2026-05-12)


### Bug Fixes

* **nbd-cow:** clean up ambiguous connect failures ([#12753](https://github.com/vm0-ai/vm0/issues/12753)) ([b0b342f](https://github.com/vm0-ai/vm0/commit/b0b342fc01460575c13705fb60d2c3b61299cb69))

## [0.4.18](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.17...nbd-cow-v0.4.18) (2026-05-09)


### Bug Fixes

* match nbd netlink completions by sequence ([#12298](https://github.com/vm0-ai/vm0/issues/12298)) ([a225c28](https://github.com/vm0-ai/vm0/commit/a225c28aa1b2171ea4f77f1feaed9e3920ef6030))

## [0.4.17](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.16...nbd-cow-v0.4.17) (2026-05-07)


### Documentation

* document nbd-cow error types ([#12062](https://github.com/vm0-ai/vm0/issues/12062)) ([d54e524](https://github.com/vm0-ai/vm0/commit/d54e5241ba64eff1c596d6e61b3015d25c59cdef))

## [0.4.16](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.15...nbd-cow-v0.4.16) (2026-05-07)


### Refactoring

* **nbd-cow:** collapse device pool actor select ([#12015](https://github.com/vm0-ai/vm0/issues/12015)) ([c6e2552](https://github.com/vm0-ai/vm0/commit/c6e2552ed723b4ae537637a99ead8d49ce504f8f))

## [0.4.15](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.14...nbd-cow-v0.4.15) (2026-05-06)


### Refactoring

* **nbd-cow:** deduplicate lease return commands ([#11914](https://github.com/vm0-ai/vm0/issues/11914)) ([4350a70](https://github.com/vm0-ai/vm0/commit/4350a70475fb519268608bbcefefffc441a1bedd))

## [0.4.14](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.13...nbd-cow-v0.4.14) (2026-05-06)


### Refactoring

* **nbd-cow:** dedupe success replies ([#11902](https://github.com/vm0-ai/vm0/issues/11902)) ([9f31d0d](https://github.com/vm0-ai/vm0/commit/9f31d0dcb2f83b4b5bfd794d7541a3d07187f56f))

## [0.4.13](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.12...nbd-cow-v0.4.13) (2026-05-05)


### Documentation

* **nbd-cow:** clarify device lease authority ([#11864](https://github.com/vm0-ai/vm0/issues/11864)) ([56c40a8](https://github.com/vm0-ai/vm0/commit/56c40a85cbfeb026b485426f464dbdeecc9a44ff))

## [0.4.12](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.11...nbd-cow-v0.4.12) (2026-05-03)


### Bug Fixes

* **nbd-cow:** lock NBD claims across runners ([#11732](https://github.com/vm0-ai/vm0/issues/11732)) ([16d716e](https://github.com/vm0-ai/vm0/commit/16d716e1f07a77c0d93649f52d077953dd62ff16))

## [0.4.11](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.10...nbd-cow-v0.4.11) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.4.10](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.9...nbd-cow-v0.4.10) (2026-04-29)


### Refactoring

* **nbd-cow:** tie device pool leases to COW lifecycle ([#11480](https://github.com/vm0-ai/vm0/issues/11480)) ([b99a732](https://github.com/vm0-ai/vm0/commit/b99a732e7732af47b5837dc3937eeb3acdf71b2e))

## [0.4.9](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.8...nbd-cow-v0.4.9) (2026-04-27)


### Bug Fixes

* **runner:** make idle vm budget release panic-safe ([#11191](https://github.com/vm0-ai/vm0/issues/11191)) ([52e085f](https://github.com/vm0-ai/vm0/commit/52e085fb6e53623b5920fbfee58ccc71d8d760ae))

## [0.4.8](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.7...nbd-cow-v0.4.8) (2026-04-26)


### Documentation

* **nbd-cow:** add crate module documentation ([#11164](https://github.com/vm0-ai/vm0/issues/11164)) ([845c276](https://github.com/vm0-ai/vm0/commit/845c276217fb4e76e289f98f48af1a4340759e06))

## [0.4.7](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.6...nbd-cow-v0.4.7) (2026-04-23)


### Documentation

* document nbd request and reply fields (closes [#10645](https://github.com/vm0-ai/vm0/issues/10645)) ([#10810](https://github.com/vm0-ai/vm0/issues/10810)) ([c0f87a5](https://github.com/vm0-ai/vm0/commit/c0f87a543fef33ef6d96a12a6cf12b67636623c3))

## [0.4.6](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.5...nbd-cow-v0.4.6) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.4.5](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.4...nbd-cow-v0.4.5) (2026-04-18)


### Bug Fixes

* **sandbox-fc:** fail snapshot when destroy_keep_cow retries exhaust ([#9870](https://github.com/vm0-ai/vm0/issues/9870)) ([c0c4120](https://github.com/vm0-ai/vm0/commit/c0c41201de5362b982295b498476bcfbffe5bebc))

## [0.4.4](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.3...nbd-cow-v0.4.4) (2026-04-17)


### Bug Fixes

* **nbd-cow:** fsync parent directory after bitmap rename ([#9827](https://github.com/vm0-ai/vm0/issues/9827)) ([b04f40b](https://github.com/vm0-ai/vm0/commit/b04f40bd39b0a92a776f79205b86e8ef78aca857))
* **nbd-cow:** track in-flight device indices to prevent duplicate allocation ([#9033](https://github.com/vm0-ai/vm0/issues/9033)) ([4f43ab5](https://github.com/vm0-ai/vm0/commit/4f43ab5b5647d1c1ad61a37c3517b9419270259c)), closes [#9016](https://github.com/vm0-ai/vm0/issues/9016)


### Performance Improvements

* **nbd-cow:** drop lock guard before sending error replies ([#9742](https://github.com/vm0-ai/vm0/issues/9742)) ([ea3568c](https://github.com/vm0-ai/vm0/commit/ea3568c567db437b37b3bd9a7b6251f37d5205b2))

## [0.4.3](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.2...nbd-cow-v0.4.3) (2026-04-17)


### Bug Fixes

* **nbd-cow:** fsync parent directory after bitmap rename ([#9827](https://github.com/vm0-ai/vm0/issues/9827)) ([b04f40b](https://github.com/vm0-ai/vm0/commit/b04f40bd39b0a92a776f79205b86e8ef78aca857))

## [0.4.2](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.1...nbd-cow-v0.4.2) (2026-04-17)


### Performance Improvements

* **nbd-cow:** drop lock guard before sending error replies ([#9742](https://github.com/vm0-ai/vm0/issues/9742)) ([ea3568c](https://github.com/vm0-ai/vm0/commit/ea3568c567db437b37b3bd9a7b6251f37d5205b2))

## [0.4.1](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.0...nbd-cow-v0.4.1) (2026-04-12)


### Bug Fixes

* **nbd-cow:** track in-flight device indices to prevent duplicate allocation ([#9033](https://github.com/vm0-ai/vm0/issues/9033)) ([4f43ab5](https://github.com/vm0-ai/vm0/commit/4f43ab5b5647d1c1ad61a37c3517b9419270259c)), closes [#9016](https://github.com/vm0-ai/vm0/issues/9016)

## [0.4.0](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.3.4...nbd-cow-v0.4.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.3.4](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.3.3...nbd-cow-v0.3.4) (2026-04-06)


### Refactoring

* **nbd:** deduplicate nbds_max, add concurrent test and bitmap assertion ([#8228](https://github.com/vm0-ai/vm0/issues/8228)) ([c0b98df](https://github.com/vm0-ai/vm0/commit/c0b98df3eb69ec81b26373d23d093a9526839752))

## [0.3.3](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.3.2...nbd-cow-v0.3.3) (2026-04-03)


### Bug Fixes

* **nbd-cow:** fix device leak when connecting worker thread exits ([#8064](https://github.com/vm0-ai/vm0/issues/8064)) ([25ed885](https://github.com/vm0-ai/vm0/commit/25ed885f1e646b6c1742e6b8d00cf0ca8a4ccf03))

## [0.3.2](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.3.1...nbd-cow-v0.3.2) (2026-04-03)


### Bug Fixes

* **nbd:** set disconnected flag only after successful disconnect ([#7870](https://github.com/vm0-ai/vm0/issues/7870)) ([6ffe3d4](https://github.com/vm0-ai/vm0/commit/6ffe3d483f1bdd70327b2e1303c541d600d127fe))

## [0.3.1](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.3.0...nbd-cow-v0.3.1) (2026-04-02)


### Bug Fixes

* use is_our_thread in bench cleanup and merge snapshot pool locks ([#7763](https://github.com/vm0-ai/vm0/issues/7763)) ([654d086](https://github.com/vm0-ai/vm0/commit/654d08604135e98a247b056413bf0c7e7d5065e0))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.2.3...nbd-cow-v0.3.0) (2026-04-02)


### Features

* add device pool for pre-validated nbd device index management ([#7695](https://github.com/vm0-ai/vm0/issues/7695)) ([aae067f](https://github.com/vm0-ai/vm0/commit/aae067febb127343ce4424ae78c3c312057479c9))

## [0.2.3](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.2.2...nbd-cow-v0.2.3) (2026-04-02)


### Bug Fixes

* **nbd-cow:** address review findings and randomize device scan ([#7603](https://github.com/vm0-ai/vm0/issues/7603)) ([8475b9e](https://github.com/vm0-ai/vm0/commit/8475b9eb110300393da0dffa482778a9bda5422d))

## [0.2.2](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.2.1...nbd-cow-v0.2.2) (2026-04-01)


### Bug Fixes

* **nbd-cow:** guard disconnect against device index recycling by other runners ([#7581](https://github.com/vm0-ai/vm0/issues/7581)) ([ed9e572](https://github.com/vm0-ai/vm0/commit/ed9e572a80514236aada53eb68b2e9ad069ec7d2))

## [0.2.1](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.2.0...nbd-cow-v0.2.1) (2026-04-01)


### Bug Fixes

* **nbd-cow:** advertise flush/trim flags and harden i/o paths ([#7539](https://github.com/vm0-ai/vm0/issues/7539)) ([6410e3e](https://github.com/vm0-ai/vm0/commit/6410e3ebc7652ba6f2da8edf14928346e70b7fb2))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.1.0...nbd-cow-v0.2.0) (2026-04-01)


### Features

* **nbd-cow:** add api surface for sandbox-fc integration ([#7307](https://github.com/vm0-ai/vm0/issues/7307)) ([042a3f6](https://github.com/vm0-ai/vm0/commit/042a3f6f3a21944565158ee87ae079185d5a89ec))
* **nbd-cow:** add minimal nbd server prototype with cow write buffer ([#7251](https://github.com/vm0-ai/vm0/issues/7251)) ([15498b7](https://github.com/vm0-ai/vm0/commit/15498b79a378b5661e5fd2ac05eaae64d81683c1))
* **sandbox-fc:** replace dm-snapshot with nbd-cow ([#7406](https://github.com/vm0-ai/vm0/issues/7406)) ([bc60c4b](https://github.com/vm0-ai/vm0/commit/bc60c4b01eaac368f7434d367784855b0b50479b))
