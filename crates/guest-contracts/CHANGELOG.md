# Changelog

## [0.14.14](https://github.com/vm0-ai/okou/compare/guest-contracts-v0.14.13...guest-contracts-v0.14.14) (2026-09-16)

## [0.14.13](https://github.com/vm0-ai/okou/compare/guest-contracts-v0.14.12...guest-contracts-v0.14.13) (2026-09-16)


### Bug Fixes

* **pi:** stop retries after provider queue expiry ([#34531](https://github.com/vm0-ai/okou/issues/34531)) ([38285ac](https://github.com/vm0-ai/okou/commit/38285acb5a5aa77c2e31c81ef37235dfedc6e2b5))

## [0.14.12](https://github.com/vm0-ai/okou/compare/guest-contracts-v0.14.11...guest-contracts-v0.14.12) (2026-09-16)


### Bug Fixes

* **pi:** preserve causal transport failure diagnostics ([#34505](https://github.com/vm0-ai/okou/issues/34505)) ([9ae5a27](https://github.com/vm0-ai/okou/commit/9ae5a2748353914dce8bcf983dac554f7ae5a4af))
* **runner:** classify contained tool oom as informational ([#34520](https://github.com/vm0-ai/okou/issues/34520)) ([02e789d](https://github.com/vm0-ai/okou/commit/02e789d0129298079e23570bc319c5c0557a2d77))

## [0.14.11](https://github.com/vm0-ai/okou/compare/guest-contracts-v0.14.10...guest-contracts-v0.14.11) (2026-09-16)

## [0.14.10](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.14.9...guest-contracts-v0.14.10) (2026-09-15)


### Bug Fixes

* **runner:** admit decoded skills beside staged instructions ([#34425](https://github.com/vm0-ai/vm0/issues/34425)) ([a889f9e](https://github.com/vm0-ai/vm0/commit/a889f9e9156c7c3f073e1cdedf313bb37bc1d7e3))

## [0.14.9](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.14.8...guest-contracts-v0.14.9) (2026-09-15)


### Bug Fixes

* **runner:** protect native runtime memory from tool reclaim ([#34398](https://github.com/vm0-ai/vm0/issues/34398)) ([756b6bc](https://github.com/vm0-ai/vm0/commit/756b6bce47a0a4b341359971ebc7ae9a4c24c62e))

## [0.14.8](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.14.7...guest-contracts-v0.14.8) (2026-09-15)


### Bug Fixes

* distinguish balance ownership and localize run errors ([#34251](https://github.com/vm0-ai/vm0/issues/34251)) ([0367d97](https://github.com/vm0-ai/vm0/commit/0367d976a87fe1251fcb9b6cfe545a8b24e4f2b6))

## [0.14.7](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.14.6...guest-contracts-v0.14.7) (2026-09-15)


### Bug Fixes

* **pi:** preserve codex rate-limit diagnostics ([#34266](https://github.com/vm0-ai/vm0/issues/34266)) ([48cb88f](https://github.com/vm0-ai/vm0/commit/48cb88fe5c6a70dd6519565211de55b710fee3af))


### Performance Improvements

* **runner:** persist extracted storage files for cache-hit delivery ([#33976](https://github.com/vm0-ai/vm0/issues/33976)) ([b961911](https://github.com/vm0-ai/vm0/commit/b961911d0516fbdc06d3e8387bedb0653eee5ea9))

## [0.14.6](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.14.5...guest-contracts-v0.14.6) (2026-09-15)

## [0.14.5](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.14.4...guest-contracts-v0.14.5) (2026-09-14)


### Refactoring

* **rust:** unify http failure attempt diagnostics ([#33946](https://github.com/vm0-ai/vm0/issues/33946)) ([394a3c3](https://github.com/vm0-ai/vm0/commit/394a3c3615d2b2485646f50f718f6cb28fb48c71))

## [0.14.4](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.14.3...guest-contracts-v0.14.4) (2026-09-11)

## [0.14.3](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.14.2...guest-contracts-v0.14.3) (2026-09-11)


### Bug Fixes

* **guest-agent:** keep oom evidence waits off tokio workers ([#33396](https://github.com/vm0-ai/vm0/issues/33396)) ([0c7a535](https://github.com/vm0-ai/vm0/commit/0c7a535c995853acc1226a0c9815baecc3f0b870))

## [0.14.2](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.14.1...guest-contracts-v0.14.2) (2026-09-10)

## [0.14.1](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.14.0...guest-contracts-v0.14.1) (2026-09-10)


### Bug Fixes

* **guest-control:** classify oom metadata apart from terminal diagnostics ([#33238](https://github.com/vm0-ai/vm0/issues/33238)) ([7e0a677](https://github.com/vm0-ai/vm0/commit/7e0a67723010f1088d5365e8dcce1801217e772c))

## [0.14.0](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.13.8...guest-contracts-v0.14.0) (2026-09-09)


### Features

* **guest-control:** attribute storage apply resource usage ([#32907](https://github.com/vm0-ai/vm0/issues/32907)) ([65cd810](https://github.com/vm0-ai/vm0/commit/65cd810030c0eac6a5e8e1a377f4562f2cb58c48))

## [0.13.8](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.13.7...guest-contracts-v0.13.8) (2026-09-09)


### Documentation

* **rust:** correct memory_max_events counter semantics ([#32892](https://github.com/vm0-ai/vm0/issues/32892)) ([a3a0584](https://github.com/vm0-ai/vm0/commit/a3a0584bf74c850cfcfc6c64820030bf3ded4c11))

## [0.13.7](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.13.6...guest-contracts-v0.13.7) (2026-09-09)


### Bug Fixes

* **guest:** preserve bounded oom evidence before cleanup ([#32845](https://github.com/vm0-ai/vm0/issues/32845)) ([075ccba](https://github.com/vm0-ai/vm0/commit/075ccbaaf8f90231687267218ef1e77d05771d3a))

## [0.13.6](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.13.5...guest-contracts-v0.13.6) (2026-09-08)


### Performance Improvements

* **runner:** reduce workspace mount helper process fanout ([#32704](https://github.com/vm0-ai/vm0/issues/32704)) ([6948274](https://github.com/vm0-ai/vm0/commit/69482746ed271dfbce548e7a32ec86869d144172))

## [0.13.5](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.13.4...guest-contracts-v0.13.5) (2026-09-08)

## [0.13.4](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.13.3...guest-contracts-v0.13.4) (2026-09-08)

## [0.13.3](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.13.2...guest-contracts-v0.13.3) (2026-09-08)

## [0.13.2](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.13.1...guest-contracts-v0.13.2) (2026-09-08)


### Documentation

* **guest-contracts:** document read helper directory side effects ([#32476](https://github.com/vm0-ai/vm0/issues/32476)) ([1070d0e](https://github.com/vm0-ai/vm0/commit/1070d0e6e2cebebfd415d6618210fa83b1e91cd2))

## [0.13.1](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.13.0...guest-contracts-v0.13.1) (2026-09-07)


### Refactoring

* **rust:** align workspace crate names with responsibilities ([#32307](https://github.com/vm0-ai/vm0/issues/32307)) ([39d81ce](https://github.com/vm0-ai/vm0/commit/39d81cedeb3c324ea48c3190e47ffb6c63bb28d9))

## [0.13.0](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.35...guest-contracts-v0.13.0) (2026-09-07)


### Features

* **rpc:** add generic guest-to-runner transport and sandbox fencing ([#32161](https://github.com/vm0-ai/vm0/issues/32161)) ([847d733](https://github.com/vm0-ai/vm0/commit/847d733315462a73b0aae20f992737b9df289bf9))

## [0.12.35](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.34...guest-contracts-v0.12.35) (2026-09-05)

## [0.12.34](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.33...guest-contracts-v0.12.34) (2026-09-05)

## [0.12.33](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.32...guest-contracts-v0.12.33) (2026-09-05)

## [0.12.32](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.31...guest-contracts-v0.12.32) (2026-09-04)


### Refactoring

* **agent:** centralize cli framework selector parsing ([#31768](https://github.com/vm0-ai/vm0/issues/31768)) ([b98056f](https://github.com/vm0-ai/vm0/commit/b98056feab6c029fc4de1e61e4dcaf6e4d9fda94))

## [0.12.31](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.30...guest-contracts-v0.12.31) (2026-09-04)


### Bug Fixes

* **chat:** preserve structured runner timeout recovery ([#31711](https://github.com/vm0-ai/vm0/issues/31711)) ([1a6f7d2](https://github.com/vm0-ai/vm0/commit/1a6f7d27e30421af781efa7ac3025e46e39286dd))

## [0.12.30](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.29...guest-contracts-v0.12.30) (2026-09-04)


### Documentation

* **rust:** clarify optional storage id on writeback manifest entries ([#31583](https://github.com/vm0-ai/vm0/issues/31583)) ([0ec28e6](https://github.com/vm0-ai/vm0/commit/0ec28e6947bdb647d1ad80f734b99cf2e5ed14a6))

## [0.12.29](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.28...guest-contracts-v0.12.29) (2026-09-03)

## [0.12.28](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.27...guest-contracts-v0.12.28) (2026-09-03)


### Bug Fixes

* **guest-agent:** classify oversized codex turn inputs ([#31404](https://github.com/vm0-ai/vm0/issues/31404)) ([8cf7f4b](https://github.com/vm0-ai/vm0/commit/8cf7f4b60fde6c4c8239ff27f27a9cc24e90f124))

## [0.12.27](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.26...guest-contracts-v0.12.27) (2026-09-03)

## [0.12.26](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.25...guest-contracts-v0.12.26) (2026-09-03)


### Refactoring

* **rust:** centralize guest binary paths ([#31298](https://github.com/vm0-ai/vm0/issues/31298)) ([73e59f8](https://github.com/vm0-ai/vm0/commit/73e59f8d4d7337226d3143e2ca688e124878372f))

## [0.12.25](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.24...guest-contracts-v0.12.25) (2026-09-03)


### Refactoring

* **runtime:** retire vm0 environment ownership wildcard ([#31251](https://github.com/vm0-ai/vm0/issues/31251)) ([0a13b76](https://github.com/vm0-ai/vm0/commit/0a13b762139fbaccae9a3324aab1baed71ca7b22))

## [0.12.24](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.23...guest-contracts-v0.12.24) (2026-09-02)


### Refactoring

* **runtime:** reclassify run payload field identifiers ([#31244](https://github.com/vm0-ai/vm0/issues/31244)) ([3b475f2](https://github.com/vm0-ai/vm0/commit/3b475f25121716295b2edcfefe3d4c9143c6d671))
* **runtime:** remove retired working-directory environment tombstone ([#31239](https://github.com/vm0-ai/vm0/issues/31239)) ([9fbce0e](https://github.com/vm0-ai/vm0/commit/9fbce0e91a45dda92802f927d8a31539876d3f97))

## [0.12.23](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.22...guest-contracts-v0.12.23) (2026-09-02)


### Refactoring

* **runtime:** remove retired process-containment alias tombstones ([#31231](https://github.com/vm0-ai/vm0/issues/31231)) ([6947bad](https://github.com/vm0-ai/vm0/commit/6947badf5b8d81c81d3795796d49abf708aa710e))

## [0.12.22](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.21...guest-contracts-v0.12.22) (2026-09-02)


### Bug Fixes

* **runner:** report authoritative provider failure reasons ([#31163](https://github.com/vm0-ai/vm0/issues/31163)) ([b84e233](https://github.com/vm0-ai/vm0/commit/b84e2334f9e370b59a299b00250fc037d90538dd))


### Refactoring

* **runtime:** remove retired API URL alias tombstones ([#31209](https://github.com/vm0-ai/vm0/issues/31209)) ([e57170e](https://github.com/vm0-ai/vm0/commit/e57170e30c73c68188ce035caba4176874e716c2))

## [0.12.21](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.20...guest-contracts-v0.12.21) (2026-09-02)


### Refactoring

* **rust:** share run artifact payload contract ([#31153](https://github.com/vm0-ai/vm0/issues/31153)) ([16c79bb](https://github.com/vm0-ai/vm0/commit/16c79bb75648f4b2def7b28ae0b1aadff326941c))

## [0.12.20](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.19...guest-contracts-v0.12.20) (2026-09-02)


### Refactoring

* **rust:** centralize cli stderr diagnostic policy ([#30984](https://github.com/vm0-ai/vm0/issues/30984)) ([7f3d97c](https://github.com/vm0-ai/vm0/commit/7f3d97cc84f939ba04be5d9242349fdccfaf368b))

## [0.12.19](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.18...guest-contracts-v0.12.19) (2026-09-01)


### Performance Improvements

* **runner:** specialize reused codex cleanup lifecycle ([#30888](https://github.com/vm0-ai/vm0/issues/30888)) ([5941c94](https://github.com/vm0-ai/vm0/commit/5941c9474fb6f1389a6ca9d3c92e99a3af59b98a))

## [0.12.18](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.17...guest-contracts-v0.12.18) (2026-09-01)


### Bug Fixes

* retain heartbeat control-path diagnostics ([#30849](https://github.com/vm0-ai/vm0/issues/30849)) ([8ee4d2d](https://github.com/vm0-ai/vm0/commit/8ee4d2d6043a5e15173ace032347366645c254b1))

## [0.12.17](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.16...guest-contracts-v0.12.17) (2026-09-01)


### Refactoring

* **rust:** share environment-key diagnostic sanitizer ([#30750](https://github.com/vm0-ai/vm0/issues/30750)) ([d7d08f2](https://github.com/vm0-ai/vm0/commit/d7d08f2b128021bf9ee3a6d352fffc1c344c5f5d))

## [0.12.16](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.15...guest-contracts-v0.12.16) (2026-09-01)


### Refactoring

* **runtime:** require canonical platform environment ([#30728](https://github.com/vm0-ai/vm0/issues/30728)) ([aaf4999](https://github.com/vm0-ai/vm0/commit/aaf49990f7b94eca4615242555bbf131986373cb))

## [0.12.15](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.14...guest-contracts-v0.12.15) (2026-09-01)


### Performance Improvements

* **runner:** launch reuse identity verifier without shell ([#30644](https://github.com/vm0-ai/vm0/issues/30644)) ([3ea790e](https://github.com/vm0-ai/vm0/commit/3ea790e5a8bca85854debfe537a89a66c4520445))

## [0.12.14](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.13...guest-contracts-v0.12.14) (2026-08-30)


### Refactoring

* **guest:** retire api url root legacy reader ([#30293](https://github.com/vm0-ai/vm0/issues/30293)) ([acf0976](https://github.com/vm0-ai/vm0/commit/acf09762659b1c0c112e51948b2dda9670fe5240))
* **guest:** retire timing tuning legacy readers ([#30303](https://github.com/vm0-ai/vm0/issues/30303)) ([27477c4](https://github.com/vm0-ai/vm0/commit/27477c4cea651fc86fbea0194bd438946e6581ad))

## [0.12.13](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.12...guest-contracts-v0.12.13) (2026-08-30)


### Refactoring

* **guest:** retire api token legacy reader ([#30292](https://github.com/vm0-ai/vm0/issues/30292)) ([7d0c3ad](https://github.com/vm0-ai/vm0/commit/7d0c3ad45d1361c0ee6463f8cc46feb00780e8f4))
* **guest:** retire execution timeout legacy reader ([#30301](https://github.com/vm0-ai/vm0/issues/30301)) ([e5fba4b](https://github.com/vm0-ai/vm0/commit/e5fba4b8fa0ed5c1a769e71ac40053798c08abd7)), closes [#30289](https://github.com/vm0-ai/vm0/issues/30289) [#28914](https://github.com/vm0-ai/vm0/issues/28914)
* **guest:** retire private payload legacy readers ([#30307](https://github.com/vm0-ai/vm0/issues/30307)) ([1059893](https://github.com/vm0-ai/vm0/commit/10598930135c5e6def894ae799064a5ef794d2c1))

## [0.12.12](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.11...guest-contracts-v0.12.12) (2026-08-30)


### Refactoring

* **guest:** cut managed CLI API URL writer to canonical alias ([#30285](https://github.com/vm0-ai/vm0/issues/30285)) ([a9a071e](https://github.com/vm0-ai/vm0/commit/a9a071e78fb317292b8c712f2b5543949dcb5982)), closes [#30277](https://github.com/vm0-ai/vm0/issues/30277) [#28914](https://github.com/vm0-ai/vm0/issues/28914)
* **guest:** retire legacy tool cgroup reader ([#30278](https://github.com/vm0-ai/vm0/issues/30278)) ([416b413](https://github.com/vm0-ai/vm0/commit/416b41325cd6a19c62e4f006b7ef7a4af2aca4cb)), closes [#30276](https://github.com/vm0-ai/vm0/issues/30276) [#28914](https://github.com/vm0-ai/vm0/issues/28914)

## [0.12.11](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.10...guest-contracts-v0.12.11) (2026-08-29)


### Refactoring

* **runner:** finish vm-to-sandbox terminology cleanup ([#30171](https://github.com/vm0-ai/vm0/issues/30171)) ([22d9b2e](https://github.com/vm0-ai/vm0/commit/22d9b2ebfdb9f9d3910eb8b30f8d2679aaed3081))

## [0.12.10](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.9...guest-contracts-v0.12.10) (2026-08-28)


### Refactoring

* **guest-agent:** remove legacy root cgroup readers ([#30112](https://github.com/vm0-ai/vm0/issues/30112)) ([8d594fa](https://github.com/vm0-ai/vm0/commit/8d594fa8ce223e5040a0c0edcfae2aacf1a03307)), closes [#30103](https://github.com/vm0-ai/vm0/issues/30103) [#28914](https://github.com/vm0-ai/vm0/issues/28914)
* **runner:** cut guest API URL writer to canonical alias ([#30105](https://github.com/vm0-ai/vm0/issues/30105)) ([f3bb3c5](https://github.com/vm0-ai/vm0/commit/f3bb3c589879d6782f7942afff00b8e9af242706))

## [0.12.9](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.8...guest-contracts-v0.12.9) (2026-08-28)


### Documentation

* **rust:** document active-input payload size responsibility ([#30080](https://github.com/vm0-ai/vm0/issues/30080)) ([dbceaf5](https://github.com/vm0-ai/vm0/commit/dbceaf5c1617ffff16b5e0fdd43170e09853a7f4))

## [0.12.8](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.7...guest-contracts-v0.12.8) (2026-08-28)


### Refactoring

* **runner:** cut sandbox metadata writers to canonical aliases ([#30066](https://github.com/vm0-ai/vm0/issues/30066)) ([237f6a8](https://github.com/vm0-ai/vm0/commit/237f6a84c78087d2fe9a446f3c9c3d040a3f6365))
* **runner:** translate timing tuning writers to canonical aliases ([#30060](https://github.com/vm0-ai/vm0/issues/30060)) ([44f18e2](https://github.com/vm0-ai/vm0/commit/44f18e290973d5ea8c7cc5f34857e67091c4293b))

## [0.12.7](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.6...guest-contracts-v0.12.7) (2026-08-28)


### Refactoring

* **runner:** cut private payload writers to canonical aliases ([#30055](https://github.com/vm0-ai/vm0/issues/30055)) ([edbdda3](https://github.com/vm0-ai/vm0/commit/edbdda3db6a2553bdf047181becbf2f9a170b997))

## [0.12.6](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.5...guest-contracts-v0.12.6) (2026-08-28)


### Refactoring

* **runner:** cut api token writer to canonical alias ([#30025](https://github.com/vm0-ai/vm0/issues/30025)) ([0f1af83](https://github.com/vm0-ai/vm0/commit/0f1af83895de4965396672276f0b709f77190f64))
* **runner:** cut execution timeout writer to canonical alias ([#30020](https://github.com/vm0-ai/vm0/issues/30020)) ([89628c1](https://github.com/vm0-ai/vm0/commit/89628c1f22e6441c025a846859036281751776bd))

## [0.12.5](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.4...guest-contracts-v0.12.5) (2026-08-28)


### Refactoring

* **guest:** cut managed tool placement writer to canonical alias ([#30001](https://github.com/vm0-ai/vm0/issues/30001)) ([e8e1294](https://github.com/vm0-ai/vm0/commit/e8e129417a3e77e507f2892854f8291d71d97d8e)), closes [#29995](https://github.com/vm0-ai/vm0/issues/29995) [#28914](https://github.com/vm0-ai/vm0/issues/28914)

## [0.12.4](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.3...guest-contracts-v0.12.4) (2026-08-28)


### Refactoring

* **guest:** remove legacy mock binary path readers ([#29977](https://github.com/vm0-ai/vm0/issues/29977)) ([95df1fc](https://github.com/vm0-ai/vm0/commit/95df1fce63080ef61656f9d5e76b2c763fd2afdc)), closes [#29973](https://github.com/vm0-ai/vm0/issues/29973) [#28914](https://github.com/vm0-ai/vm0/issues/28914)
* **test:** cut mock path writers to canonical aliases ([#29949](https://github.com/vm0-ai/vm0/issues/29949)) ([3941a98](https://github.com/vm0-ai/vm0/commit/3941a9832964c22b647213509376be0fccb70683))

## [0.12.3](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.2...guest-contracts-v0.12.3) (2026-08-27)


### Refactoring

* **runtime:** cut root cgroup placement writers to canonical aliases ([#29917](https://github.com/vm0-ai/vm0/issues/29917)) ([ae935e6](https://github.com/vm0-ai/vm0/commit/ae935e632c1a1c1bee1bd3c014ca556370e59a4a))

## [0.12.2](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.1...guest-contracts-v0.12.2) (2026-08-27)


### Refactoring

* **rust:** make shared jsonl cli state backend-neutral ([#29895](https://github.com/vm0-ai/vm0/issues/29895)) ([0e0bc69](https://github.com/vm0-ai/vm0/commit/0e0bc69214f2717f37aa27064c1a1f5a1c8ae311))

## [0.12.1](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.12.0...guest-contracts-v0.12.1) (2026-08-27)

## [0.12.0](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.23...guest-contracts-v0.12.0) (2026-08-26)


### Features

* **cli:** show connector accounts used by current run ([#29523](https://github.com/vm0-ai/vm0/issues/29523)) ([3d1ce4e](https://github.com/vm0-ai/vm0/commit/3d1ce4e549aa7a2405aa83d76e6794a0f4f4f587))

## [0.11.23](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.22...guest-contracts-v0.11.23) (2026-08-26)


### Bug Fixes

* **agent:** preserve original shell commands in tool events ([#29475](https://github.com/vm0-ai/vm0/issues/29475)) ([238051b](https://github.com/vm0-ai/vm0/commit/238051b2011fbd6d790c34b81e4f476d9a107830))
* **vsock:** bound file write response waits ([#29455](https://github.com/vm0-ai/vm0/issues/29455)) ([f9d9692](https://github.com/vm0-ai/vm0/commit/f9d9692d06e8f9574d2888397e0ab38ec2adc029))

## [0.11.22](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.21...guest-contracts-v0.11.22) (2026-08-25)


### Refactoring

* **guest:** dual-read mock binary path aliases ([#29385](https://github.com/vm0-ai/vm0/issues/29385)) ([15e79f4](https://github.com/vm0-ai/vm0/commit/15e79f42c3522856c4debe98c19af6b47bf54a30))

## [0.11.21](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.20...guest-contracts-v0.11.21) (2026-08-25)


### Refactoring

* **guest-agent:** dual-read api backend url aliases ([#29369](https://github.com/vm0-ai/vm0/issues/29369)) ([84295ac](https://github.com/vm0-ai/vm0/commit/84295ac0c3d66185b90d59fc6afa3f79903aac9a))

## [0.11.20](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.19...guest-contracts-v0.11.20) (2026-08-25)


### Refactoring

* **guest-agent:** dual-read tuning environment aliases ([#29329](https://github.com/vm0-ai/vm0/issues/29329)) ([d5dbae8](https://github.com/vm0-ai/vm0/commit/d5dbae8abbb4141eb10bb22ab3a8d588628b1e7c))

## [0.11.19](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.18...guest-contracts-v0.11.19) (2026-08-25)


### Refactoring

* **guest-agent:** dual-read execution timeout aliases ([#29229](https://github.com/vm0-ai/vm0/issues/29229)) ([c27e3fa](https://github.com/vm0-ai/vm0/commit/c27e3fa6ca856a65ef8d4b195f7da91dbf86942a))

## [0.11.18](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.17...guest-contracts-v0.11.18) (2026-08-24)


### Refactoring

* **runtime:** dual-read cgroup placement environment aliases ([#29081](https://github.com/vm0-ai/vm0/issues/29081)) ([7beb4d5](https://github.com/vm0-ai/vm0/commit/7beb4d545bef801b7dd0bd2c107829869cd022ed))
* **runtime:** dual-read guest runtime directory aliases ([#29101](https://github.com/vm0-ai/vm0/issues/29101)) ([3bb5b28](https://github.com/vm0-ai/vm0/commit/3bb5b2807090c3cf48650b917ccca00bdb44f370))
* **runtime:** dual-read private payload file env aliases ([#29082](https://github.com/vm0-ai/vm0/issues/29082)) ([e400e00](https://github.com/vm0-ai/vm0/commit/e400e0058cd63cc18b478ad807da42f9b5bb5e74))
* **runtime:** dual-read resume session environment aliases ([#29069](https://github.com/vm0-ai/vm0/issues/29069)) ([6dd54e9](https://github.com/vm0-ai/vm0/commit/6dd54e909a8607421344e758adcb887f72f8f0de))

## [0.11.17](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.16...guest-contracts-v0.11.17) (2026-08-24)


### Refactoring

* **guest-agent:** dual-read api token environment aliases ([#29062](https://github.com/vm0-ai/vm0/issues/29062)) ([1f21af7](https://github.com/vm0-ai/vm0/commit/1f21af778ef9513a49ee40de8e6176aba08e80ac))

## [0.11.16](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.15...guest-contracts-v0.11.16) (2026-08-24)


### Refactoring

* **runtime:** dual-read run metadata env aliases ([#29022](https://github.com/vm0-ai/vm0/issues/29022)) ([928d53b](https://github.com/vm0-ai/vm0/commit/928d53b17819c1c82f76da3aa8e4e672c69431d1))
* **runtime:** reserve okou namespace in cloud execution ([#29040](https://github.com/vm0-ai/vm0/issues/29040)) ([233bc7e](https://github.com/vm0-ai/vm0/commit/233bc7eb29e9c03b4391e91f1fe15ce48d576de6))

## [0.11.15](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.14...guest-contracts-v0.11.15) (2026-08-24)


### Bug Fixes

* **guest-agent:** keep claude appended prompts out of argv ([#28838](https://github.com/vm0-ai/vm0/issues/28838)) ([0bd96d6](https://github.com/vm0-ai/vm0/commit/0bd96d69d6b9121e37232080a35111550f709424))

## [0.11.14](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.13...guest-contracts-v0.11.14) (2026-08-23)


### Bug Fixes

* **rust:** align mock codex rollout paths ([#28692](https://github.com/vm0-ai/vm0/issues/28692)) ([59ecfdb](https://github.com/vm0-ai/vm0/commit/59ecfdbbf4a1402dc5fc85ee460ef88cb0a26e55))

## [0.11.13](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.12...guest-contracts-v0.11.13) (2026-08-21)


### Bug Fixes

* **runner:** isolate shell tool oom cleanup ([#28391](https://github.com/vm0-ai/vm0/issues/28391)) ([ffb0332](https://github.com/vm0-ai/vm0/commit/ffb03327e60854d4e5e541b34a2f3423cfcee6f2))

## [0.11.12](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.11...guest-contracts-v0.11.12) (2026-08-20)


### Bug Fixes

* **events:** preserve timeout and connect observations ([#28397](https://github.com/vm0-ai/vm0/issues/28397)) ([c3d536e](https://github.com/vm0-ai/vm0/commit/c3d536eab61fca8e2006a7664a982b993537db00))
* **guest-agent:** classify mid-response failures ([#28393](https://github.com/vm0-ai/vm0/issues/28393)) ([4ca21bd](https://github.com/vm0-ai/vm0/commit/4ca21bdbe47a2ce99f34c343b074f83c45775483))
* surface claude terms acceptance failures ([#28314](https://github.com/vm0-ai/vm0/issues/28314)) ([dc0674c](https://github.com/vm0-ai/vm0/commit/dc0674cd33b9b5ec44e592814c4f7b0c3d952575))

## [0.11.11](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.10...guest-contracts-v0.11.11) (2026-08-18)


### Documentation

* **rust:** align pi launch contract docs with schema v2 ([#27851](https://github.com/vm0-ai/vm0/issues/27851)) ([b42e81c](https://github.com/vm0-ai/vm0/commit/b42e81ca8080bbffc3d2d79a4566b8b2d766eceb))


### Refactoring

* **rust:** neutralize session-history identity type names ([#27895](https://github.com/vm0-ai/vm0/issues/27895)) ([fff9b30](https://github.com/vm0-ai/vm0/commit/fff9b3074cc4e590b2fdb4318da515fcc4605a70))

## [0.11.10](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.9...guest-contracts-v0.11.10) (2026-08-17)


### Refactoring

* **rust:** centralize workload cgroup events ([#27747](https://github.com/vm0-ai/vm0/issues/27747)) ([e25a143](https://github.com/vm0-ai/vm0/commit/e25a1432fe660498f8a4de977c0c07a5ed969080))

## [0.11.9](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.8...guest-contracts-v0.11.9) (2026-08-16)


### Refactoring

* **runner:** unify reuse-preparation exit status ownership ([#27559](https://github.com/vm0-ai/vm0/issues/27559)) ([54c4459](https://github.com/vm0-ai/vm0/commit/54c44592c0f9936f227d0e10a493085230f77350))

## [0.11.8](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.7...guest-contracts-v0.11.8) (2026-08-15)


### Bug Fixes

* **guest-agent:** remove session history marker authority ([#27284](https://github.com/vm0-ai/vm0/issues/27284)) ([1bf8617](https://github.com/vm0-ai/vm0/commit/1bf8617d3a04b6beccba5f81795d57476e728ffe))

## [0.11.7](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.6...guest-contracts-v0.11.7) (2026-08-14)


### Refactoring

* **pi:** use official resources and jsonl sessions ([#27288](https://github.com/vm0-ai/vm0/issues/27288)) ([b287f72](https://github.com/vm0-ai/vm0/commit/b287f7270f0fd0613adff61ab91289b73e39e7f6))

## [0.11.6](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.5...guest-contracts-v0.11.6) (2026-08-14)


### Bug Fixes

* **runner:** preserve runs after tool process oom ([#27272](https://github.com/vm0-ai/vm0/issues/27272)) ([bdba0d6](https://github.com/vm0-ai/vm0/commit/bdba0d6cfb57fec9f7193a02ab93dbf7b7074ea9))

## [0.11.5](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.4...guest-contracts-v0.11.5) (2026-08-14)


### Bug Fixes

* **runner:** let guest reclaim memory before workload oom ([#27206](https://github.com/vm0-ai/vm0/issues/27206)) ([d8bd1c7](https://github.com/vm0-ai/vm0/commit/d8bd1c7471c220f8595edcb64dde3e70840d4467))

## [0.11.4](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.3...guest-contracts-v0.11.4) (2026-08-14)


### Bug Fixes

* **runner:** disable workload memory.high reclaim ([#27126](https://github.com/vm0-ai/vm0/issues/27126)) ([24743ab](https://github.com/vm0-ai/vm0/commit/24743ab1a9901f769ee07a40cffea63c2a516e37))

## [0.11.3](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.2...guest-contracts-v0.11.3) (2026-08-14)


### Refactoring

* **pi:** build the pi prompt inside the sandbox ([#27036](https://github.com/vm0-ai/vm0/issues/27036)) ([1e248af](https://github.com/vm0-ai/vm0/commit/1e248afd1118468a8950f81c668d65b27fe6f429))

## [0.11.2](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.1...guest-contracts-v0.11.2) (2026-08-13)


### Refactoring

* **rust:** share active-input control payload contract ([#26950](https://github.com/vm0-ai/vm0/issues/26950)) ([403bfd8](https://github.com/vm0-ai/vm0/commit/403bfd8f08fcd272d7c39df9149b1aa9124dca42))

## [0.11.1](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.11.0...guest-contracts-v0.11.1) (2026-08-13)


### Bug Fixes

* **runner:** preserve guest control headroom under workload pressure ([#26683](https://github.com/vm0-ai/vm0/issues/26683)) ([789adcd](https://github.com/vm0-ai/vm0/commit/789adcd9e7a35dc545ae660f4b5a55d802ea854f))

## [0.11.0](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.10.0...guest-contracts-v0.11.0) (2026-08-13)


### Features

* **runner:** migrate pi child environment to okou ([#26810](https://github.com/vm0-ai/vm0/issues/26810)) ([9c54e70](https://github.com/vm0-ai/vm0/commit/9c54e70777750b608dad06fde2a44a5a08f9796b))


### Refactoring

* **guest:** centralize private file replacement ([#26786](https://github.com/vm0-ai/vm0/issues/26786)) ([b12cef8](https://github.com/vm0-ai/vm0/commit/b12cef89edbcdf0f9748dba40f3ebe99bfb3fbe5))

## [0.10.0](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.9.2...guest-contracts-v0.10.0) (2026-08-13)


### Features

* **runner:** migrate run identity env to okou ([#26796](https://github.com/vm0-ai/vm0/issues/26796)) ([88850c3](https://github.com/vm0-ai/vm0/commit/88850c33b9bb20018d9e0fd12097cc5eb7fb2bde))

## [0.9.2](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.9.1...guest-contracts-v0.9.2) (2026-08-12)


### Refactoring

* **pi:** persist sandbox sessions in native sqlite ([#26555](https://github.com/vm0-ai/vm0/issues/26555)) ([9ed505e](https://github.com/vm0-ai/vm0/commit/9ed505e1c567ff019d521fac167700c2b390cffe))

## [0.9.1](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.9.0...guest-contracts-v0.9.1) (2026-08-12)


### Refactoring

* **rust:** centralize guest stdout framing limits ([#26648](https://github.com/vm0-ai/vm0/issues/26648)) ([962e753](https://github.com/vm0-ai/vm0/commit/962e7532f4e8d319fb05b096bdbfca85431731ed))

## [0.9.0](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.8.0...guest-contracts-v0.9.0) (2026-08-11)


### Features

* **runner:** enable durable active-input delivery ([#26392](https://github.com/vm0-ai/vm0/issues/26392)) ([6225b5e](https://github.com/vm0-ai/vm0/commit/6225b5e85da2833f011830d21498744893b2f625))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.7.1...guest-contracts-v0.8.0) (2026-08-11)


### Features

* **guest:** persist active-input acceptance receipts ([#26191](https://github.com/vm0-ai/vm0/issues/26191)) ([f6ede96](https://github.com/vm0-ai/vm0/commit/f6ede96f136515283ec1f76d380cc3c835f85420))

## [0.7.1](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.7.0...guest-contracts-v0.7.1) (2026-08-10)


### Bug Fixes

* **runner:** preserve sidecar export failure causes ([#25999](https://github.com/vm0-ai/vm0/issues/25999)) ([76c5c0a](https://github.com/vm0-ai/vm0/commit/76c5c0a8470eecbce17615134b3a6f6c306a98a9))

## [0.7.0](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.6.1...guest-contracts-v0.7.0) (2026-08-09)


### Features

* persist and display runner reuse outcomes ([#25942](https://github.com/vm0-ai/vm0/issues/25942)) ([90f8d8f](https://github.com/vm0-ai/vm0/commit/90f8d8ffb713f7f99acd8377b8cba26a91504d0b))

## [0.6.1](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.6.0...guest-contracts-v0.6.1) (2026-08-09)


### Refactoring

* **pi:** replace handoff fallbacks with session polling ([#25906](https://github.com/vm0-ai/vm0/issues/25906)) ([66cbcad](https://github.com/vm0-ai/vm0/commit/66cbcada1c224b1c7541b6d7c90696d3733e53f8))

## [0.6.0](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.5.9...guest-contracts-v0.6.0) (2026-08-07)


### Features

* complete pi agent handoff end to end ([#25489](https://github.com/vm0-ai/vm0/issues/25489)) ([feeb1cb](https://github.com/vm0-ai/vm0/commit/feeb1cbc8e838b844945cf5efc3ed7e9820c10a4))


### Bug Fixes

* **runner:** materialize prune-eligible codex zstd history ([#25582](https://github.com/vm0-ai/vm0/issues/25582)) ([44df9f2](https://github.com/vm0-ai/vm0/commit/44df9f2c4dc9ec5640cc54316c944a8164f54a3f))

## [0.5.9](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.5.8...guest-contracts-v0.5.9) (2026-08-07)


### Refactoring

* **runner:** remove obsolete codex event fallbacks ([#25511](https://github.com/vm0-ai/vm0/issues/25511)) ([94e8703](https://github.com/vm0-ai/vm0/commit/94e87037eef09c503c7280070237483fafad69fa))

## [0.5.8](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.5.7...guest-contracts-v0.5.8) (2026-08-06)


### Refactoring

* **runner:** use codex app-server exclusively ([#25460](https://github.com/vm0-ai/vm0/issues/25460)) ([61b623a](https://github.com/vm0-ai/vm0/commit/61b623adffb6da6d16dd01355773ea342258b894))

## [0.5.7](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.5.6...guest-contracts-v0.5.7) (2026-08-05)


### Refactoring

* **rust:** centralize epoch-millisecond validation ([#25159](https://github.com/vm0-ai/vm0/issues/25159)) ([4780d82](https://github.com/vm0-ai/vm0/commit/4780d82181ac10f4f7bfaafc6b16e448f89f2860))

## [0.5.6](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.5.5...guest-contracts-v0.5.6) (2026-08-04)


### Refactoring

* canonicalize deepseek model provider ([#25030](https://github.com/vm0-ai/vm0/issues/25030)) ([c19ea0f](https://github.com/vm0-ai/vm0/commit/c19ea0fa2d196143ab899db3953904c814e2b016))

## [0.5.5](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.5.4...guest-contracts-v0.5.5) (2026-08-04)


### Bug Fixes

* **rust:** distinguish direct sigkill from escalation ([#24976](https://github.com/vm0-ai/vm0/issues/24976)) ([6aa72d7](https://github.com/vm0-ai/vm0/commit/6aa72d7955c92e9c5dc475e6060a00b703e1da63))

## [0.5.4](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.5.3...guest-contracts-v0.5.4) (2026-08-03)


### Refactoring

* **rust:** centralize base cli agent session id validation ([#24759](https://github.com/vm0-ai/vm0/issues/24759)) ([da34435](https://github.com/vm0-ai/vm0/commit/da34435c6747be672914e4651c29d0abd2b47936))

## [0.5.3](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.5.2...guest-contracts-v0.5.3) (2026-08-03)


### Documentation

* **rust:** clarify session history diagnostic semantics ([#24671](https://github.com/vm0-ai/vm0/issues/24671)) ([ecf6630](https://github.com/vm0-ai/vm0/commit/ecf6630d6185b03b6de7bc606259a730dff462b4))

## [0.5.2](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.5.1...guest-contracts-v0.5.2) (2026-08-02)


### Bug Fixes

* **runner:** distinguish sandbox reuse result causes ([#24562](https://github.com/vm0-ai/vm0/issues/24562)) ([3988072](https://github.com/vm0-ai/vm0/commit/3988072cba1e7e821f976598b1de7da3a6a22ee1))


### Refactoring

* **runner:** treat invalid resume sessions as pre-reuse failures ([#24568](https://github.com/vm0-ai/vm0/issues/24568)) ([a3e789f](https://github.com/vm0-ai/vm0/commit/a3e789f626155acb7f3fe280aa4fe60f4579f103))

## [0.5.1](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.5.0...guest-contracts-v0.5.1) (2026-08-01)


### Documentation

* **rust:** document storage manifest wire invariants ([#24434](https://github.com/vm0-ai/vm0/issues/24434)) ([6f8b85c](https://github.com/vm0-ai/vm0/commit/6f8b85c4390cc3238b0b59133cc2fd33126322f6))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.4.7...guest-contracts-v0.5.0) (2026-07-30)


### Features

* **events:** report structured guest event delivery failures ([#23974](https://github.com/vm0-ai/vm0/issues/23974)) ([ebdf828](https://github.com/vm0-ai/vm0/commit/ebdf8280b7b961ebf8404790a15696a7338ecd6e))

## [0.4.7](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.4.6...guest-contracts-v0.4.7) (2026-07-30)


### Bug Fixes

* **guest-agent:** checkpoint user cancellations before completion ([#23899](https://github.com/vm0-ai/vm0/issues/23899)) ([ba905f6](https://github.com/vm0-ai/vm0/commit/ba905f65bb5f99fac077c236b4ca57175708ead5))

## [0.4.6](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.4.5...guest-contracts-v0.4.6) (2026-07-29)


### Bug Fixes

* **runner:** checkpoint sessions before job timeout ([#23734](https://github.com/vm0-ai/vm0/issues/23734)) ([15f44cc](https://github.com/vm0-ai/vm0/commit/15f44cc68e1387d5b18f604fea9c964a1557561d))

## [0.4.5](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.4.4...guest-contracts-v0.4.5) (2026-07-28)


### Refactoring

* **runner:** require canonical storage manifests ([#23550](https://github.com/vm0-ai/vm0/issues/23550)) ([cedc736](https://github.com/vm0-ai/vm0/commit/cedc736c5d46390ba0d145df5274359aff5330a6))

## [0.4.4](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.4.3...guest-contracts-v0.4.4) (2026-07-28)


### Bug Fixes

* **runner:** classify codex safety policy refusals ([#23391](https://github.com/vm0-ai/vm0/issues/23391)) ([a1d9986](https://github.com/vm0-ai/vm0/commit/a1d9986f1183067249dc168ba3643acdf05f79ca))

## [0.4.3](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.4.2...guest-contracts-v0.4.3) (2026-07-25)


### Bug Fixes

* **guest-agent:** classify oversized session history failures ([#23020](https://github.com/vm0-ai/vm0/issues/23020)) ([13b74f3](https://github.com/vm0-ai/vm0/commit/13b74f3d501b1e2f3be539969d3a9eb3479c7d3e))

## [0.4.2](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.4.1...guest-contracts-v0.4.2) (2026-07-25)


### Documentation

* **rust:** document private runtime file invariants ([#23000](https://github.com/vm0-ai/vm0/issues/23000)) ([200dd45](https://github.com/vm0-ai/vm0/commit/200dd45652429376a2729a09addb08dbc0167c1b))

## [0.4.1](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.4.0...guest-contracts-v0.4.1) (2026-07-23)


### Documentation

* **rust:** expose private path guarantees in guest-agent ([#22710](https://github.com/vm0-ai/vm0/issues/22710)) ([ef12e55](https://github.com/vm0-ai/vm0/commit/ef12e55e627b4e627c8efbcf30867bc493222785))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.17...guest-contracts-v0.4.0) (2026-07-22)


### Features

* **runner:** accept canonical storage mount manifests ([#22546](https://github.com/vm0-ai/vm0/issues/22546)) ([d9cea3a](https://github.com/vm0-ai/vm0/commit/d9cea3a2f56de399b38ef9d1f004da740b699bbc))


### Bug Fixes

* **guest-agent:** bound stalled codex resume startup ([#22557](https://github.com/vm0-ai/vm0/issues/22557)) ([1bf198e](https://github.com/vm0-ai/vm0/commit/1bf198e0791884e807f70a2d08fff0b93b050698))

## [0.3.17](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.16...guest-contracts-v0.3.17) (2026-07-21)


### Performance Improvements

* align session-history sidecar capacity with resume limit ([#22392](https://github.com/vm0-ai/vm0/issues/22392)) ([6eee854](https://github.com/vm0-ai/vm0/commit/6eee8548718c69c4d46afe9b1ddcd8c7babcca59))

## [0.3.16](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.15...guest-contracts-v0.3.16) (2026-07-19)


### Bug Fixes

* **guest-agent:** bound ordinary cli stdout ingestion ([#22095](https://github.com/vm0-ai/vm0/issues/22095)) ([4641dd5](https://github.com/vm0-ai/vm0/commit/4641dd5e1340bb204866e0433eb4adbe5eb955f2))

## [0.3.15](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.14...guest-contracts-v0.3.15) (2026-07-17)


### Bug Fixes

* **vsock:** replace descendant process-group cleanup with exec cgroups ([#22013](https://github.com/vm0-ai/vm0/issues/22013)) ([302bf21](https://github.com/vm0-ai/vm0/commit/302bf216fac511a8fd6bf9c0c778cf8643f2374b))


### Performance Improvements

* **guest-agent:** bound cli event delivery buffering ([#22015](https://github.com/vm0-ai/vm0/issues/22015)) ([0bde876](https://github.com/vm0-ai/vm0/commit/0bde876b83ef7781a24deb495f68ebec5e78e1cf))

## [0.3.14](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.13...guest-contracts-v0.3.14) (2026-07-17)


### Documentation

* **rust:** clarify stack-dependent execve budget ([#21974](https://github.com/vm0-ai/vm0/issues/21974)) ([fb75eff](https://github.com/vm0-ai/vm0/commit/fb75eff67f38b2778427efbf9e501708b0ed616e))

## [0.3.13](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.12...guest-contracts-v0.3.13) (2026-07-16)


### Bug Fixes

* **runner:** classify oversized sidecars as unavailable ([#21877](https://github.com/vm0-ai/vm0/issues/21877)) ([d9fde61](https://github.com/vm0-ai/vm0/commit/d9fde61a0cce1579c4cf841e3e721aaf016eb537))

## [0.3.12](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.11...guest-contracts-v0.3.12) (2026-07-16)


### Bug Fixes

* **runner:** contain supervised run descendants ([#21780](https://github.com/vm0-ai/vm0/issues/21780)) ([23e961c](https://github.com/vm0-ai/vm0/commit/23e961ce1b30f45ec9786e30289d870f5f436762))

## [0.3.11](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.10...guest-contracts-v0.3.11) (2026-07-16)


### Bug Fixes

* describe zero scrape capabilities in agent context ([#21574](https://github.com/vm0-ai/vm0/issues/21574)) ([5d5b298](https://github.com/vm0-ai/vm0/commit/5d5b298b1396f2e4c1ee6873d429987fcb9df4cc))

## [0.3.10](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.9...guest-contracts-v0.3.10) (2026-07-15)


### Bug Fixes

* **runner:** qualify guest rootfs before idle reuse ([#21563](https://github.com/vm0-ai/vm0/issues/21563)) ([b9230c3](https://github.com/vm0-ai/vm0/commit/b9230c3bd213fb95777e0b5f84b17bbbbc3dd2e8))

## [0.3.9](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.8...guest-contracts-v0.3.9) (2026-07-13)


### Refactoring

* remove vm0 api url env ([#21215](https://github.com/vm0-ai/vm0/issues/21215)) ([6f0d6a9](https://github.com/vm0-ai/vm0/commit/6f0d6a9bdf80c0437d3ef529fd06eacd62a0c412))

## [0.3.8](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.7...guest-contracts-v0.3.8) (2026-07-10)


### Refactoring

* **runner:** introduce explicit storage plan and guest wire contract ([#20912](https://github.com/vm0-ai/vm0/issues/20912)) ([07f275c](https://github.com/vm0-ai/vm0/commit/07f275c8e04a9dcd6148f7d3075258b683e4ba2e))

## [0.3.7](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.6...guest-contracts-v0.3.7) (2026-07-09)


### Performance Improvements

* cache session history with workspace images ([#20733](https://github.com/vm0-ai/vm0/issues/20733)) ([d588e5a](https://github.com/vm0-ai/vm0/commit/d588e5a9aa6e67ca18199cd74cadfa7dd4d66418))

## [0.3.6](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.5...guest-contracts-v0.3.6) (2026-07-08)


### Bug Fixes

* add runner exit signal diagnostics ([#20674](https://github.com/vm0-ai/vm0/issues/20674)) ([bf46c07](https://github.com/vm0-ai/vm0/commit/bf46c07f8a9954576040760dfcfb3bb81ee2d1ea))


### Refactoring

* centralize guest private runtime file handling ([#20671](https://github.com/vm0-ai/vm0/issues/20671)) ([24ca30c](https://github.com/vm0-ai/vm0/commit/24ca30c56b4c9b657a3aad8da2affac5a49e5b4b))

## [0.3.5](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.4...guest-contracts-v0.3.5) (2026-07-08)


### Bug Fixes


## [0.3.4](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.3...guest-contracts-v0.3.4) (2026-07-05)


### Refactoring

* centralize run payload field validation ([#20225](https://github.com/vm0-ai/vm0/issues/20225)) ([8a293a7](https://github.com/vm0-ai/vm0/commit/8a293a762a48b4828780e8e99ca59e48ca915415))

## [0.3.3](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.2...guest-contracts-v0.3.3) (2026-07-03)


### Bug Fixes

* move runner bootstrap payloads out of env ([#19989](https://github.com/vm0-ai/vm0/issues/19989)) ([847d8d2](https://github.com/vm0-ai/vm0/commit/847d8d24372d84568133007db87c44a0ebd72b95))

## [0.3.2](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.1...guest-contracts-v0.3.2) (2026-07-01)


### Bug Fixes

* classify codex context window failures ([#19607](https://github.com/vm0-ai/vm0/issues/19607)) ([34ed0ac](https://github.com/vm0-ai/vm0/commit/34ed0ac9d29d81ffda52c5ccd6bf69915d5cc80c))

## [0.3.1](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.0...guest-contracts-v0.3.1) (2026-07-01)


### Bug Fixes

* align session history verification cap ([#19561](https://github.com/vm0-ai/vm0/issues/19561)) ([657cc42](https://github.com/vm0-ai/vm0/commit/657cc422cfe1e929e921a82e7bbd7ceec0d7861d))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.10...guest-contracts-v0.3.0) (2026-06-30)


### Features

* enable codex local active input ([#19463](https://github.com/vm0-ai/vm0/issues/19463)) ([5a34420](https://github.com/vm0-ai/vm0/commit/5a34420314311d9a290c195f33539d8359303660))

## [0.2.10](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.9...guest-contracts-v0.2.10) (2026-06-30)


### Performance Improvements

* verify large session histories in guest ([#19386](https://github.com/vm0-ai/vm0/issues/19386)) ([a3f62a1](https://github.com/vm0-ai/vm0/commit/a3f62a1bd2b649e6d5dfe0a694894d020d196925))

## [0.2.9](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.8...guest-contracts-v0.2.9) (2026-06-29)


### Refactoring

* merge agent diagnostics into guest contracts ([#19317](https://github.com/vm0-ai/vm0/issues/19317)) ([e36a711](https://github.com/vm0-ai/vm0/commit/e36a71168939a1b692a1ab80005d984697a77fe4))

## [0.2.8](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.7...guest-contracts-v0.2.8) (2026-06-29)


### Bug Fixes

* declare guest-contracts serde dependencies ([#19291](https://github.com/vm0-ai/vm0/issues/19291)) ([8e739bc](https://github.com/vm0-ai/vm0/commit/8e739bc813a2eaa5dbeabbf24616a5ff0a3a34c9))

## [0.2.7](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.6...guest-contracts-v0.2.7) (2026-06-29)


### Performance Improvements

* park checkpointed session history identity ([#19270](https://github.com/vm0-ai/vm0/issues/19270)) ([e21745b](https://github.com/vm0-ai/vm0/commit/e21745be11c34b09052a27182971d4c48ab881c1))

## [0.2.6](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.5...guest-contracts-v0.2.6) (2026-06-27)


### Bug Fixes

* guard post-result cleanup deadlines ([#19179](https://github.com/vm0-ai/vm0/issues/19179)) ([e1d2779](https://github.com/vm0-ai/vm0/commit/e1d2779ab9b32e0d195e1d5bf4d3ae7745022b5d))

## [0.2.5](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.4...guest-contracts-v0.2.5) (2026-06-26)


### Documentation

* document guest contracts public api ([#19064](https://github.com/vm0-ai/vm0/issues/19064)) ([f3ba3d1](https://github.com/vm0-ai/vm0/commit/f3ba3d1dc215502eb38276246334d5260ac853ee))

## [0.2.4](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.3...guest-contracts-v0.2.4) (2026-06-25)


### Bug Fixes

* harden guest runtime private file writes ([#18797](https://github.com/vm0-ai/vm0/issues/18797)) ([f334139](https://github.com/vm0-ai/vm0/commit/f334139eec67ff4bb64d2a47c3028505bd068cdd))

## [0.2.3](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.2...guest-contracts-v0.2.3) (2026-06-22)


### Bug Fixes

* separate Claude post-result cleanup lifecycle ([#18524](https://github.com/vm0-ai/vm0/issues/18524)) ([6dcad82](https://github.com/vm0-ai/vm0/commit/6dcad82ea6241cc2197e577867ba8bee00e13525))


### Refactoring

* centralize codex thread id contract ([#18499](https://github.com/vm0-ai/vm0/issues/18499)) ([9cecc84](https://github.com/vm0-ai/vm0/commit/9cecc8421f4073ce32b6529fff89049779a7c13e))

## [0.2.2](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.1...guest-contracts-v0.2.2) (2026-06-19)


### Documentation

* document guest environment contract ([#18331](https://github.com/vm0-ai/vm0/issues/18331)) ([816b22f](https://github.com/vm0-ai/vm0/commit/816b22fe19ce042754266633c64b6e8d30824413))

## [0.2.1](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.0...guest-contracts-v0.2.1) (2026-06-17)


### Refactoring

* remove stale feature switches and dead code ([#18090](https://github.com/vm0-ai/vm0/issues/18090)) ([9406838](https://github.com/vm0-ai/vm0/commit/940683865a2256f83b2d92d36cf102e0fb06e131))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.1.2...guest-contracts-v0.2.0) (2026-06-17)


### Features

* **runner:** add local submit env overrides ([#17930](https://github.com/vm0-ai/vm0/issues/17930)) ([5c2c63c](https://github.com/vm0-ai/vm0/commit/5c2c63cdde42a7951e3af80dad7c892cdeca4de9))

## [0.1.2](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.1.1...guest-contracts-v0.1.2) (2026-06-17)


### Bug Fixes

* **runner:** validate benchmark env keys before startup ([#17999](https://github.com/vm0-ai/vm0/issues/17999)) ([4e6b823](https://github.com/vm0-ai/vm0/commit/4e6b823eba479c95cc7dbc8e377621f99b7ea5bf))

## [0.1.1](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.1.0...guest-contracts-v0.1.1) (2026-06-15)


### Refactoring

* centralize guest env key names ([#17626](https://github.com/vm0-ai/vm0/issues/17626)) ([476546d](https://github.com/vm0-ai/vm0/commit/476546de9d385733c481558b422511b30b1cc45a))
