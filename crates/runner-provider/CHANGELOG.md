# Changelog

## [0.14.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.13.9...runner-provider-v0.14.0) (2026-11-01)


### Features

* **runner:** preserve api transport evidence in local info logs ([#44501](https://github.com/okou-ai/okou/issues/44501)) ([64cd33a](https://github.com/okou-ai/okou/commit/64cd33aa3319cc1089b1029a72aadbdf97fe3237))


### Refactoring

* **rust:** consolidate remaining test modules ([#44510](https://github.com/okou-ai/okou/issues/44510)) ([118202f](https://github.com/okou-ai/okou/commit/118202f39eea0d0872205d09a1ef19f90882fad9))

## [0.13.9](https://github.com/okou-ai/okou/compare/runner-provider-v0.13.8...runner-provider-v0.13.9) (2026-11-01)

## [0.13.8](https://github.com/okou-ai/okou/compare/runner-provider-v0.13.7...runner-provider-v0.13.8) (2026-11-01)

## [0.13.7](https://github.com/okou-ai/okou/compare/runner-provider-v0.13.6...runner-provider-v0.13.7) (2026-10-31)

## [0.13.6](https://github.com/okou-ai/okou/compare/runner-provider-v0.13.5...runner-provider-v0.13.6) (2026-10-31)

## [0.13.5](https://github.com/okou-ai/okou/compare/runner-provider-v0.13.4...runner-provider-v0.13.5) (2026-10-31)

## [0.13.4](https://github.com/okou-ai/okou/compare/runner-provider-v0.13.3...runner-provider-v0.13.4) (2026-10-31)


### Refactoring

* **runner:** retire legacy content delivery ([#44383](https://github.com/okou-ai/okou/issues/44383)) ([aa52387](https://github.com/okou-ai/okou/commit/aa52387e9a4e19abdae3d5ab7a7be54f6b10fafd))

## [0.13.3](https://github.com/okou-ai/okou/compare/runner-provider-v0.13.2...runner-provider-v0.13.3) (2026-10-31)

## [0.13.2](https://github.com/okou-ai/okou/compare/runner-provider-v0.13.1...runner-provider-v0.13.2) (2026-10-30)

## [0.13.1](https://github.com/okou-ai/okou/compare/runner-provider-v0.13.0...runner-provider-v0.13.1) (2026-10-30)

## [0.13.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.12.4...runner-provider-v0.13.0) (2026-10-30)


### Features

* activate hash-addressed content bundle claims ([#44319](https://github.com/okou-ai/okou/issues/44319)) ([8c5dde4](https://github.com/okou-ai/okou/commit/8c5dde4aba9158e9bb946c391923e8a2b666cd44))

## [0.12.4](https://github.com/okou-ai/okou/compare/runner-provider-v0.12.3...runner-provider-v0.12.4) (2026-10-30)

## [0.12.3](https://github.com/okou-ai/okou/compare/runner-provider-v0.12.2...runner-provider-v0.12.3) (2026-10-30)

## [0.12.2](https://github.com/okou-ai/okou/compare/runner-provider-v0.12.1...runner-provider-v0.12.2) (2026-10-30)

## [0.12.1](https://github.com/okou-ai/okou/compare/runner-provider-v0.12.0...runner-provider-v0.12.1) (2026-10-30)

## [0.12.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.35...runner-provider-v0.12.0) (2026-10-30)


### Features

* prepare content-addressed instruction and workflow bundles ([#44189](https://github.com/okou-ai/okou/issues/44189)) ([fc8f994](https://github.com/okou-ai/okou/commit/fc8f99468cc7946843620ff655ae22c09f9cb2ae))

## [0.11.35](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.34...runner-provider-v0.11.35) (2026-10-30)

## [0.11.34](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.33...runner-provider-v0.11.34) (2026-10-29)


### Bug Fixes

* **runner:** retire invalidated local queue watches ([#43966](https://github.com/okou-ai/okou/issues/43966)) ([6e98e29](https://github.com/okou-ai/okou/commit/6e98e293ecf62ccadf7ee0e4507e8ff25e22986b))

## [0.11.33](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.32...runner-provider-v0.11.33) (2026-10-29)


### Documentation

* **runner-provider:** clarify claim scheduling and ownership ([#43908](https://github.com/okou-ai/okou/issues/43908)) ([3f20d0b](https://github.com/okou-ai/okou/commit/3f20d0be050dc977f73ad2dc682ae346d7290800))

## [0.11.32](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.31...runner-provider-v0.11.32) (2026-10-29)

## [0.11.31](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.30...runner-provider-v0.11.31) (2026-10-29)


### Bug Fixes

* **runner:** unify predecessor home discovery and bounded routing ([#43655](https://github.com/okou-ai/okou/issues/43655)) ([2c512a7](https://github.com/okou-ai/okou/commit/2c512a7542a0adbf22d72e278dc8acdd52a10a6c))


### Refactoring

* **runner-host:** share lock-retaining state publication ([#43715](https://github.com/okou-ai/okou/issues/43715)) ([0529b89](https://github.com/okou-ai/okou/commit/0529b89aef1a46d8b9b0e31445bbc8e9bff549b7))


### Performance Improvements

* prepare metadata-only workflow claims and downloads ([#43667](https://github.com/okou-ai/okou/issues/43667)) ([6fd2905](https://github.com/okou-ai/okou/commit/6fd29050029b5a521f75d0500e9876a11649afe6)) [#43642](https://github.com/okou-ai/okou/issues/43642)

## [0.11.30](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.29...runner-provider-v0.11.30) (2026-10-28)


### Bug Fixes

* **runner-provider:** retain ably connect task custody ([#43635](https://github.com/okou-ai/okou/issues/43635)) ([ca7e2c4](https://github.com/okou-ai/okou/commit/ca7e2c43a90837015d5448b5648fed49711d363e))

## [0.11.29](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.28...runner-provider-v0.11.29) (2026-10-28)

## [0.11.28](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.27...runner-provider-v0.11.28) (2026-10-27)

## [0.11.27](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.26...runner-provider-v0.11.27) (2026-10-27)


### Bug Fixes

* **runner-provider:** retain catalog lock through physical publication ([#43502](https://github.com/okou-ai/okou/issues/43502)) ([f474ce2](https://github.com/okou-ai/okou/commit/f474ce2cc2f05903b532ac9bb59b1a0913862478))
* **runner:** retain newer pending connector sync generations ([#43454](https://github.com/okou-ai/okou/issues/43454)) ([b5c327c](https://github.com/okou-ai/okou/commit/b5c327cda684d35511abb22494a840d102d0048c))

## [0.11.26](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.25...runner-provider-v0.11.26) (2026-10-27)

## [0.11.25](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.24...runner-provider-v0.11.25) (2026-10-27)


### Refactoring

* **runner-provider:** share retained worker joins ([#43368](https://github.com/okou-ai/okou/issues/43368)) ([49c76d3](https://github.com/okou-ai/okou/commit/49c76d37f4c59c8119ed6005463c54bd2aa7916e))

## [0.11.24](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.23...runner-provider-v0.11.24) (2026-10-27)

## [0.11.23](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.22...runner-provider-v0.11.23) (2026-10-27)


### Bug Fixes

* **runner-provider:** retain api shutdown worker custody ([#43234](https://github.com/okou-ai/okou/issues/43234)) ([cf1747d](https://github.com/okou-ai/okou/commit/cf1747dbffeed580afd6d9fb2f083aa410aa6a31))
* **runner-provider:** retain local watcher shutdown custody ([#43201](https://github.com/okou-ai/okou/issues/43201)) ([8255f46](https://github.com/okou-ai/okou/commit/8255f4602118ae7e97976d89c4afb53f4c2c5882))
* **runner-provider:** retain runtime sync dispatcher shutdown custody ([#43227](https://github.com/okou-ai/okou/issues/43227)) ([6c9872d](https://github.com/okou-ai/okou/commit/6c9872d5e42b197456d14df7681d711a46fca323))


### Refactoring

* **runner-provider:** reuse cancellation mode for ably notifications ([#43257](https://github.com/okou-ai/okou/issues/43257)) ([758c422](https://github.com/okou-ai/okou/commit/758c422693b6d581660a07770c1988b5667ebf03))

## [0.11.22](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.21...runner-provider-v0.11.22) (2026-10-26)


### Performance Improvements

* **runner-provider:** compact fragmented claim response chunks ([#43145](https://github.com/okou-ai/okou/issues/43145)) ([f5032f7](https://github.com/okou-ai/okou/commit/f5032f73745f55855280d0604a541228f064599a))

## [0.11.21](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.20...runner-provider-v0.11.21) (2026-10-26)


### Refactoring

* **runner-provider:** own exclusive ably connection phases ([#43108](https://github.com/okou-ai/okou/issues/43108)) ([4f6b00f](https://github.com/okou-ai/okou/commit/4f6b00f0a10cb562ad96d0508b8f96e33469cd43))

## [0.11.20](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.19...runner-provider-v0.11.20) (2026-10-26)


### Bug Fixes

* **runner:** back off local poison jobs when result publication fails ([#43081](https://github.com/okou-ai/okou/issues/43081)) ([405285d](https://github.com/okou-ai/okou/commit/405285d5cc8a63548e4259ddfd953ea1a65e8d8f))

## [0.11.19](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.18...runner-provider-v0.11.19) (2026-10-26)

## [0.11.18](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.17...runner-provider-v0.11.18) (2026-10-26)

## [0.11.17](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.16...runner-provider-v0.11.17) (2026-10-26)


### Performance Improvements

* **runner-provider:** coalesce successful claim bodies once ([#42951](https://github.com/okou-ai/okou/issues/42951)) ([690ed56](https://github.com/okou-ai/okou/commit/690ed562676243da24aa5a1d481d4e3e83afe2e6))

## [0.11.16](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.15...runner-provider-v0.11.16) (2026-10-26)

## [0.11.15](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.14...runner-provider-v0.11.15) (2026-10-25)


### Bug Fixes

* **runner-provider:** bound shared api error diagnostics ([#42907](https://github.com/okou-ai/okou/issues/42907)) ([a361cd1](https://github.com/okou-ai/okou/commit/a361cd17f5fc369e156347e6340dd57ef02a5181))

## [0.11.14](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.13...runner-provider-v0.11.14) (2026-10-25)

## [0.11.13](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.12...runner-provider-v0.11.13) (2026-10-25)

## [0.11.12](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.11...runner-provider-v0.11.12) (2026-10-25)

## [0.11.11](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.10...runner-provider-v0.11.11) (2026-10-23)

## [0.11.10](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.9...runner-provider-v0.11.10) (2026-10-23)

## [0.11.9](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.8...runner-provider-v0.11.9) (2026-10-23)

## [0.11.8](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.7...runner-provider-v0.11.8) (2026-10-23)

## [0.11.7](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.6...runner-provider-v0.11.7) (2026-10-23)

## [0.11.6](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.5...runner-provider-v0.11.6) (2026-10-22)


### Refactoring

* **rust:** retire native continuation claim advertisement ([#42287](https://github.com/okou-ai/okou/issues/42287)) ([67a9608](https://github.com/okou-ai/okou/commit/67a9608c675eaa99eb19323b5c6fd3033955baaa))

## [0.11.5](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.4...runner-provider-v0.11.5) (2026-10-22)

## [0.11.4](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.3...runner-provider-v0.11.4) (2026-10-22)


### Refactoring

* remove expired runner claim compatibility gates ([#42164](https://github.com/okou-ai/okou/issues/42164)) ([f71adde](https://github.com/okou-ai/okou/commit/f71addebfc1456142f31af439e6750f67e42e938))

## [0.11.3](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.2...runner-provider-v0.11.3) (2026-10-21)


### Refactoring

* **runner:** retire scheduling history generation identity ([#41998](https://github.com/okou-ai/okou/issues/41998)) ([39dbd2a](https://github.com/okou-ai/okou/commit/39dbd2a10242e3e1d9241d8b81c034258f10f842))

## [0.11.2](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.1...runner-provider-v0.11.2) (2026-10-21)

## [0.11.1](https://github.com/okou-ai/okou/compare/runner-provider-v0.11.0...runner-provider-v0.11.1) (2026-10-21)

## [0.11.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.10.2...runner-provider-v0.11.0) (2026-10-20)


### Features

* **runner:** track resource producers and prepare source matching ([#41900](https://github.com/okou-ai/okou/issues/41900)) ([f762cad](https://github.com/okou-ai/okou/commit/f762cada760922b815c9ad6d32012be39c5a3c08))


### Refactoring

* **runner-provider:** converge catalog refresh cancellation completion ([#41899](https://github.com/okou-ai/okou/issues/41899)) ([6c63f17](https://github.com/okou-ai/okou/commit/6c63f175ba93c0b7b1f13357e42cd4ea5d2b8b06))

## [0.10.2](https://github.com/okou-ai/okou/compare/runner-provider-v0.10.1...runner-provider-v0.10.2) (2026-10-20)


### Refactoring

* **runner-provider:** converge local completion cleanup ([#41870](https://github.com/okou-ai/okou/issues/41870)) ([12efe2a](https://github.com/okou-ai/okou/commit/12efe2aeb72a20ca0284c13b3e126e589be2a6f0))

## [0.10.1](https://github.com/okou-ai/okou/compare/runner-provider-v0.10.0...runner-provider-v0.10.1) (2026-10-20)


### Refactoring

* retire sandbox file debugging stack ([#41808](https://github.com/okou-ai/okou/issues/41808)) ([430cb92](https://github.com/okou-ai/okou/commit/430cb92b5431e1554d0a1dceed6d9cfb27762921))
* **runner:** require explicit finalizing resource sources ([#41825](https://github.com/okou-ai/okou/issues/41825)) ([52e13a4](https://github.com/okou-ai/okou/commit/52e13a4346eb63d84ef247820acd8f09c709619c))

## [0.10.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.9.1...runner-provider-v0.10.0) (2026-10-20)


### Features

* **runner:** prepare owned peer home waits and hostname heartbeats ([#41747](https://github.com/okou-ai/okou/issues/41747)) ([61c7678](https://github.com/okou-ai/okou/commit/61c7678ee8630a0e3f15ec314eadbf4058bb4e54))

## [0.9.1](https://github.com/okou-ai/okou/compare/runner-provider-v0.9.0...runner-provider-v0.9.1) (2026-10-20)


### Refactoring

* **runner-provider:** own ordinary runtime registration retirement ([#41732](https://github.com/okou-ai/okou/issues/41732)) ([fd843da](https://github.com/okou-ai/okou/commit/fd843dad1317261c35419c425cd3f1d9d578e94a))

## [0.9.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.21...runner-provider-v0.9.0) (2026-10-20)


### Features

* **runner:** prepare independent finalizing source admission ([#41683](https://github.com/okou-ai/okou/issues/41683)) ([b610ff6](https://github.com/okou-ai/okou/commit/b610ff61043274157618e3925b13a66dc56ef84b))


### Bug Fixes

* **runner-provider:** include heartbeat http 520 in degradation episodes ([#41629](https://github.com/okou-ai/okou/issues/41629)) ([680226d](https://github.com/okou-ai/okou/commit/680226dfdb07c29b2d97ba450850d9d631f76710))
* **runner-provider:** retain unsuccessful claim request attribution ([#41649](https://github.com/okou-ai/okou/issues/41649)) ([fa80470](https://github.com/okou-ai/okou/commit/fa804702a095129e6c0bae79cc037180b530f1a5))
* **runner:** report initial cache inventory before running ([#41556](https://github.com/okou-ai/okou/issues/41556)) ([2b4d023](https://github.com/okou-ai/okou/commit/2b4d023eb3b6d97269d2bbe71a5d8395ae5c2763))

## [0.8.21](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.20...runner-provider-v0.8.21) (2026-10-19)


### Refactoring

* prepare database-backed agent instructions ([#41393](https://github.com/okou-ai/okou/issues/41393)) ([da0dc9c](https://github.com/okou-ai/okou/commit/da0dc9cd1b21ecdd91200fb1cad8600ee5fdfd29))

## [0.8.20](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.19...runner-provider-v0.8.20) (2026-10-19)

## [0.8.19](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.18...runner-provider-v0.8.19) (2026-10-19)


### Refactoring

* **runner:** share connector registry command values ([#41271](https://github.com/okou-ai/okou/issues/41271)) ([e3346f3](https://github.com/okou-ai/okou/commit/e3346f3c0448090e9c4a00fa12745f248d051233))

## [0.8.18](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.17...runner-provider-v0.8.18) (2026-10-19)

## [0.8.17](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.16...runner-provider-v0.8.17) (2026-10-19)

## [0.8.16](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.15...runner-provider-v0.8.16) (2026-10-19)


### Refactoring

* **runner-provider:** remove unused finite retry mode ([#41182](https://github.com/okou-ai/okou/issues/41182)) ([c6b6f6d](https://github.com/okou-ai/okou/commit/c6b6f6dd33f2fc959d5b9b6fb5a21258242d3049))

## [0.8.15](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.14...runner-provider-v0.8.15) (2026-10-19)


### Refactoring

* **runner-provider:** remove redundant inbox overflow state ([#41086](https://github.com/okou-ai/okou/issues/41086)) ([dff8b90](https://github.com/okou-ai/okou/commit/dff8b908ba24d57fc725de71111b483e69b4e40d))
* **runner-provider:** share successful poll wakeup completion ([#41112](https://github.com/okou-ai/okou/issues/41112)) ([bd2208e](https://github.com/okou-ai/okou/commit/bd2208e003fc0022257fbbb3e9be08340d421be6))

## [0.8.14](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.13...runner-provider-v0.8.14) (2026-10-17)


### Refactoring

* **runner-provider:** own local queue staging cleanup ([#40943](https://github.com/okou-ai/okou/issues/40943)) ([1097b2c](https://github.com/okou-ai/okou/commit/1097b2c150ad5921c0fa90e4a1f4ecbd502e5d5e))

## [0.8.13](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.12...runner-provider-v0.8.13) (2026-10-17)


### Bug Fixes

* **runner:** enforce captured openrouter presets before auth ([#40884](https://github.com/okou-ai/okou/issues/40884)) ([1d2a780](https://github.com/okou-ai/okou/commit/1d2a780d35d7a8b2b5ceab760321470d8e06c489))

## [0.8.12](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.11...runner-provider-v0.8.12) (2026-10-17)

## [0.8.11](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.10...runner-provider-v0.8.11) (2026-10-17)


### Refactoring

* remove expired deployment compatibility ([#40811](https://github.com/okou-ai/okou/issues/40811)) ([b53e5a5](https://github.com/okou-ai/okou/commit/b53e5a5fc6437b2b15412d21a42d90344c18191f))
* remove remaining expired compatibility from the daily cleanup backlog ([#40820](https://github.com/okou-ai/okou/issues/40820)) ([9ef42db](https://github.com/okou-ai/okou/commit/9ef42db5a3c1c8bfe040a7e41b6aafa6941d4510))

## [0.8.10](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.9...runner-provider-v0.8.10) (2026-10-16)


### Refactoring

* **runner-provider:** own ably disconnect episodes ([#40742](https://github.com/okou-ai/okou/issues/40742)) ([eaec130](https://github.com/okou-ai/okou/commit/eaec1301db7352859f5c6eccc03d38960e0173fb))

## [0.8.9](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.8...runner-provider-v0.8.9) (2026-10-16)


### Refactoring

* **runner-provider:** centralize current connector sync identity checks ([#40716](https://github.com/okou-ai/okou/issues/40716)) ([e2e886c](https://github.com/okou-ai/okou/commit/e2e886cf7a73409b3534eba274b1a9e6068def5b))

## [0.8.8](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.7...runner-provider-v0.8.8) (2026-10-16)


### Refactoring

* **runner-provider:** own abandoned local result marker custody ([#40667](https://github.com/okou-ai/okou/issues/40667)) ([a9a257c](https://github.com/okou-ai/okou/commit/a9a257c329ed81cf41582e1900443c4af35a5798))

## [0.8.7](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.6...runner-provider-v0.8.7) (2026-10-16)


### Bug Fixes

* **runner:** accept numeric dns labels in parameterized firewall hosts ([#40639](https://github.com/okou-ai/okou/issues/40639)) ([3cb77fa](https://github.com/okou-ai/okou/commit/3cb77fa3561e260cc2aecc30ce51f9349eaee5a3))

## [0.8.6](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.5...runner-provider-v0.8.6) (2026-10-16)


### Refactoring

* retire session history archive protocol ([#40528](https://github.com/okou-ai/okou/issues/40528)) ([1e9a4cf](https://github.com/okou-ai/okou/commit/1e9a4cf4fa6fb43dad8fad1caedc480df0ef7a41))
* **runner-provider:** keep sync timers with registered targets ([#40525](https://github.com/okou-ai/okou/issues/40525)) ([87b5ab0](https://github.com/okou-ai/okou/commit/87b5ab058e03bd9c49b6efff75c3502f3d347e46))
* **runner-provider:** own capped deferred poll windows ([#40529](https://github.com/okou-ai/okou/issues/40529)) ([d4ad4ca](https://github.com/okou-ai/okou/commit/d4ad4caae19506ab0ca998f31d48c0dfc954df77))

## [0.8.5](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.4...runner-provider-v0.8.5) (2026-10-15)

## [0.8.4](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.3...runner-provider-v0.8.4) (2026-10-15)


### Refactoring

* **pi:** always use the runner-bundled cli ([#40232](https://github.com/okou-ai/okou/issues/40232)) ([dfff160](https://github.com/okou-ai/okou/commit/dfff1605013103371cd90962ee5b54c80fc93140))

## [0.8.3](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.2...runner-provider-v0.8.3) (2026-10-15)


### Documentation

* **rust:** correct completion reuse metadata documentation ([#40278](https://github.com/okou-ai/okou/issues/40278)) ([2534320](https://github.com/okou-ai/okou/commit/25343206017d857cb6dc473d15f7a0be3ec48a61))

## [0.8.2](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.1...runner-provider-v0.8.2) (2026-10-15)

## [0.8.1](https://github.com/okou-ai/okou/compare/runner-provider-v0.8.0...runner-provider-v0.8.1) (2026-10-15)

## [0.8.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.21...runner-provider-v0.8.0) (2026-10-15)


### Features

* continue threads through retained native sandbox history ([#40048](https://github.com/okou-ai/okou/issues/40048)) ([2b6ff73](https://github.com/okou-ai/okou/commit/2b6ff735fcfb0d4f5baf5fd131bcc10ae8a325d3))
* **runner:** record first-run context and actual home reuse ([#39955](https://github.com/okou-ai/okou/issues/39955)) ([f0577eb](https://github.com/okou-ai/okou/commit/f0577ebc54bdb82e28c225184a7a084080054afd))


### Refactoring

* retire legacy run reuse outcome metadata ([#40102](https://github.com/okou-ai/okou/issues/40102)) ([005af49](https://github.com/okou-ai/okou/commit/005af4965ced3ca60293140d6ede62ec5acaeaeb))

## [0.7.21](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.20...runner-provider-v0.7.21) (2026-10-14)

## [0.7.20](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.19...runner-provider-v0.7.20) (2026-10-14)

## [0.7.19](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.18...runner-provider-v0.7.19) (2026-10-14)


### Refactoring

* **rust:** share raw http fixtures across runner domains ([#40010](https://github.com/okou-ai/okou/issues/40010)) ([bc8950d](https://github.com/okou-ai/okou/commit/bc8950d2cb9217419e0fce358dccf2d028b25076))

## [0.7.18](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.17...runner-provider-v0.7.18) (2026-10-14)

## [0.7.17](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.16...runner-provider-v0.7.17) (2026-10-14)


### Bug Fixes

* **runner:** extend firewall catalog download timeout ([#39910](https://github.com/okou-ai/okou/issues/39910)) ([33803f4](https://github.com/okou-ai/okou/commit/33803f4d00fe3f6ef0f1672f90ac3a89306cfab7))
* **runner:** log completion retries at info ([#39913](https://github.com/okou-ai/okou/issues/39913)) ([b757880](https://github.com/okou-ai/okou/commit/b7578800e9d0c3a80c830f60425dac05fd344436))

## [0.7.16](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.15...runner-provider-v0.7.16) (2026-10-14)

## [0.7.15](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.14...runner-provider-v0.7.15) (2026-10-13)

## [0.7.14](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.13...runner-provider-v0.7.14) (2026-10-13)

## [0.7.13](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.12...runner-provider-v0.7.13) (2026-10-13)

## [0.7.12](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.11...runner-provider-v0.7.12) (2026-10-13)

## [0.7.11](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.10...runner-provider-v0.7.11) (2026-10-13)

## [0.7.10](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.9...runner-provider-v0.7.10) (2026-10-12)

## [0.7.9](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.8...runner-provider-v0.7.9) (2026-10-12)

## [0.7.8](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.7...runner-provider-v0.7.8) (2026-10-12)

## [0.7.7](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.6...runner-provider-v0.7.7) (2026-10-12)

## [0.7.6](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.5...runner-provider-v0.7.6) (2026-10-12)

## [0.7.5](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.4...runner-provider-v0.7.5) (2026-10-12)


### Refactoring

* **runner:** retire workspace protocol and application sql ([#38837](https://github.com/okou-ai/okou/issues/38837)) ([a932f1f](https://github.com/okou-ai/okou/commit/a932f1f86ae10eb624fa3ff3bccc851ba4809a7e))

## [0.7.4](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.3...runner-provider-v0.7.4) (2026-10-11)

## [0.7.3](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.2...runner-provider-v0.7.3) (2026-10-11)


### Performance Improvements

* **ci:** exclude audited test modules from runner binary inputs ([#38755](https://github.com/okou-ai/okou/issues/38755)) ([6ca9649](https://github.com/okou-ai/okou/commit/6ca96493c23cbe8d983a0bab2d237900258f57b0))

## [0.7.2](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.1...runner-provider-v0.7.2) (2026-10-10)

## [0.7.1](https://github.com/okou-ai/okou/compare/runner-provider-v0.7.0...runner-provider-v0.7.1) (2026-10-10)

## [0.7.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.6.5...runner-provider-v0.7.0) (2026-10-10)


### Features

* **runner:** retain home images with verified history ([#38498](https://github.com/okou-ai/okou/issues/38498)) ([8b100e4](https://github.com/okou-ai/okou/commit/8b100e433e5933242c418dbfe1c1f3efd15a9b87))

## [0.6.5](https://github.com/okou-ai/okou/compare/runner-provider-v0.6.4...runner-provider-v0.6.5) (2026-10-10)

## [0.6.4](https://github.com/okou-ai/okou/compare/runner-provider-v0.6.3...runner-provider-v0.6.4) (2026-10-10)

## [0.6.3](https://github.com/okou-ai/okou/compare/runner-provider-v0.6.2...runner-provider-v0.6.3) (2026-10-10)


### Refactoring

* **pi:** retire unversioned model config execution ([#38449](https://github.com/okou-ai/okou/issues/38449)) ([c628473](https://github.com/okou-ai/okou/commit/c62847319cb3ebbd41259d662f47905a1cb39863))

## [0.6.2](https://github.com/okou-ai/okou/compare/runner-provider-v0.6.1...runner-provider-v0.6.2) (2026-10-09)

## [0.6.1](https://github.com/okou-ai/okou/compare/runner-provider-v0.6.0...runner-provider-v0.6.1) (2026-10-09)


### Refactoring

* **runner:** move runtime reactor into runner-supervisor ([#38393](https://github.com/okou-ai/okou/issues/38393)) ([a5a1dd3](https://github.com/okou-ai/okou/commit/a5a1dd3ae25f19d65baed071cb15fa2a456cfb0a))

## [0.6.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.13...runner-provider-v0.6.0) (2026-10-09)


### Features

* **api:** prepare home cache affinity and runner state ([#38314](https://github.com/okou-ai/okou/issues/38314)) ([21ce097](https://github.com/okou-ai/okou/commit/21ce0978ad9a5bc7eddb94bc9d2bc25f1897095f))

## [0.5.13](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.12...runner-provider-v0.5.13) (2026-10-09)


### Bug Fixes

* **runner:** defer incomplete response alerts until degradation ([#38281](https://github.com/okou-ai/okou/issues/38281)) ([c3e28db](https://github.com/okou-ai/okou/commit/c3e28db3f0d5292c821a496522b854aba4286429))

## [0.5.12](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.11...runner-provider-v0.5.12) (2026-10-09)

## [0.5.11](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.10...runner-provider-v0.5.11) (2026-10-08)

## [0.5.10](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.9...runner-provider-v0.5.10) (2026-10-08)


### Refactoring

* assemble current run inputs without agent configuration ([#38004](https://github.com/okou-ai/okou/issues/38004)) ([22efd4b](https://github.com/okou-ai/okou/commit/22efd4b6b34872c0585a0d4c3778cb3b59d9d100))

## [0.5.9](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.8...runner-provider-v0.5.9) (2026-10-08)

## [0.5.8](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.7...runner-provider-v0.5.8) (2026-10-07)


### Refactoring

* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))

## [0.5.7](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.6...runner-provider-v0.5.7) (2026-10-07)

## [0.5.6](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.5...runner-provider-v0.5.6) (2026-10-07)


### Refactoring

* remove all remaining custom model mode awareness ([#37856](https://github.com/okou-ai/okou/issues/37856)) ([f383835](https://github.com/okou-ai/okou/commit/f3838353ba0455ec7d57dfa2d0974e34a44796ff))

## [0.5.5](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.4...runner-provider-v0.5.5) (2026-10-03)


### Bug Fixes

* **runner:** track cached firewall catalog connection resets ([#37587](https://github.com/okou-ai/okou/issues/37587)) ([1ac40a6](https://github.com/okou-ai/okou/commit/1ac40a63b5787c5aacaafde47ada7a4eb6298f9c))

## [0.5.4](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.3...runner-provider-v0.5.4) (2026-10-03)


### Bug Fixes

* **runner:** allow three total completion reporting attempts ([#37584](https://github.com/okou-ai/okou/issues/37584)) ([70bf078](https://github.com/okou-ai/okou/commit/70bf0780ba916bffc8ab1ac23ef04cfaaa2e9ffa))

## [0.5.3](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.2...runner-provider-v0.5.3) (2026-10-02)

## [0.5.2](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.1...runner-provider-v0.5.2) (2026-10-01)

## [0.5.1](https://github.com/okou-ai/okou/compare/runner-provider-v0.5.0...runner-provider-v0.5.1) (2026-10-01)


### Documentation

* **rust:** correct builtin firewall catalog validator path ([#37433](https://github.com/okou-ai/okou/issues/37433)) ([bee3673](https://github.com/okou-ai/okou/commit/bee3673a65726f4bb12b3735112b52b44adca943))

## [0.5.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.4.6...runner-provider-v0.5.0) (2026-09-30)


### Features

* make the database model catalog the model authority ([#37416](https://github.com/okou-ai/okou/issues/37416)) ([7a8cf4d](https://github.com/okou-ai/okou/commit/7a8cf4d005dea492e0375b91ac46bcf3201d902d))

## [0.4.6](https://github.com/okou-ai/okou/compare/runner-provider-v0.4.5...runner-provider-v0.4.6) (2026-09-30)

## [0.4.5](https://github.com/okou-ai/okou/compare/runner-provider-v0.4.4...runner-provider-v0.4.5) (2026-09-30)


### Refactoring

* **chat:** complete chat event v8 transition cleanup ([#37411](https://github.com/okou-ai/okou/issues/37411)) ([cd4aac5](https://github.com/okou-ai/okou/commit/cd4aac5fa635dd7f71eb82756529c5643c552cc9))

## [0.4.4](https://github.com/okou-ai/okou/compare/runner-provider-v0.4.3...runner-provider-v0.4.4) (2026-09-30)

## [0.4.3](https://github.com/okou-ai/okou/compare/runner-provider-v0.4.2...runner-provider-v0.4.3) (2026-09-29)

## [0.4.2](https://github.com/okou-ai/okou/compare/runner-provider-v0.4.1...runner-provider-v0.4.2) (2026-09-29)

## [0.4.1](https://github.com/okou-ai/okou/compare/runner-provider-v0.4.0...runner-provider-v0.4.1) (2026-09-28)


### Bug Fixes

* **runner:** read steerable input only on start, push, and ably reconnect ([#37232](https://github.com/okou-ai/okou/issues/37232)) ([5a4713a](https://github.com/okou-ai/okou/commit/5a4713ab3fbd39ee99a5a6067880ab7538ab359a))

## [0.4.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.15...runner-provider-v0.4.0) (2026-09-28)


### Features

* **runner:** gate wss tickets on host ingress heartbeat ([#37192](https://github.com/okou-ai/okou/issues/37192)) ([00b5a33](https://github.com/okou-ai/okou/commit/00b5a334dceacc63b97978c57108d736822fd230))

## [0.3.15](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.14...runner-provider-v0.3.15) (2026-09-28)


### Refactoring

* **runner:** chat queue release 6 - steer endpoints and sandbox-first pi ([#37175](https://github.com/okou-ai/okou/issues/37175)) ([2ccafb0](https://github.com/okou-ai/okou/commit/2ccafb0e9add22ecefebd62785e7ecafe05a8ea7))

## [0.3.14](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.13...runner-provider-v0.3.14) (2026-09-28)

## [0.3.13](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.12...runner-provider-v0.3.13) (2026-09-27)

## [0.3.12](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.11...runner-provider-v0.3.12) (2026-09-26)


### Refactoring

* remove expired deployment compatibility ([#37056](https://github.com/okou-ai/okou/issues/37056)) ([736f701](https://github.com/okou-ai/okou/commit/736f70167be41d6d99cf07d842071cbd9b2fa68c))

## [0.3.11](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.10...runner-provider-v0.3.11) (2026-09-25)

## [0.3.10](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.9...runner-provider-v0.3.10) (2026-09-25)


### Bug Fixes

* retain runner affinity for active predecessor producers ([#36866](https://github.com/okou-ai/okou/issues/36866)) ([d90ba1e](https://github.com/okou-ai/okou/commit/d90ba1e7d4a7bc36c2c5f1abf168c1b1e83e657a))

## [0.3.9](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.8...runner-provider-v0.3.9) (2026-09-25)

## [0.3.8](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.7...runner-provider-v0.3.8) (2026-09-25)

## [0.3.7](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.6...runner-provider-v0.3.7) (2026-09-24)


### Performance Improvements

* **runner:** attribute first claim body chunk wait ([#36747](https://github.com/okou-ai/okou/issues/36747)) ([bb22f6a](https://github.com/okou-ai/okou/commit/bb22f6a8bf717c1b104567028a4d35e4648229b9))

## [0.3.6](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.5...runner-provider-v0.3.6) (2026-09-24)

## [0.3.5](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.4...runner-provider-v0.3.5) (2026-09-24)


### Performance Improvements

* **runner:** attribute claim response size on both sides ([#36582](https://github.com/okou-ai/okou/issues/36582)) ([954136f](https://github.com/okou-ai/okou/commit/954136fe0a41a917ac49cdb76095075ee6b4f3a4))

## [0.3.4](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.3...runner-provider-v0.3.4) (2026-09-24)


### Bug Fixes

* **runner:** defer poll reset errors until fallback degrades ([#36499](https://github.com/okou-ai/okou/issues/36499)) ([27f936e](https://github.com/okou-ai/okou/commit/27f936edcb4cb68c93f8acc5a9ae9387766fd852))

## [0.3.3](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.2...runner-provider-v0.3.3) (2026-09-24)


### Bug Fixes

* **runner:** log transient ably connection retries at info ([#36488](https://github.com/okou-ai/okou/issues/36488)) ([8d3dcb2](https://github.com/okou-ai/okou/commit/8d3dcb23e4a6496c667a13ca42e1ec16048dcdb7))


### Refactoring

* **runner:** consolidate shared API transport in provider ([#36447](https://github.com/okou-ai/okou/issues/36447)) ([193d460](https://github.com/okou-ai/okou/commit/193d460a94a242db4958f4a90631800cd9eed3e4))

## [0.3.2](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.1...runner-provider-v0.3.2) (2026-09-23)

## [0.3.1](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.0...runner-provider-v0.3.1) (2026-09-23)

## [0.3.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.2.0...runner-provider-v0.3.0) (2026-09-23)


### Features

* **pi:** enable session-construction digest parity ([#36201](https://github.com/okou-ai/okou/issues/36201)) ([00b1434](https://github.com/okou-ai/okou/commit/00b14343e69073fdc87f42d378deab55e8c232ba)), closes [#35967](https://github.com/okou-ai/okou/issues/35967)

## [0.2.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.1.1...runner-provider-v0.2.0) (2026-09-23)


### Features

* **models:** add Claude Opus 5.5 ([#36168](https://github.com/okou-ai/okou/issues/36168)) ([e0fc624](https://github.com/okou-ai/okou/commit/e0fc62414d039c9e0dfda36145c2e62edfcf79a2))

## [0.1.1](https://github.com/okou-ai/okou/compare/runner-provider-v0.1.0...runner-provider-v0.1.1) (2026-09-23)


### Refactoring

* **runner:** extract provider coordination crate ([#36148](https://github.com/okou-ai/okou/issues/36148)) ([789a24f](https://github.com/okou-ai/okou/commit/789a24f6632566071af38533d4df58a0ef0c0c75))

## 0.1.0

- Extract API and local Runner job-provider coordination from the Runner binary crate.
