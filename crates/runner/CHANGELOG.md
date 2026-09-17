# Changelog

## [0.197.0](https://github.com/vm0-ai/okou/compare/runner-rs-v0.196.2...runner-rs-v0.197.0) (2026-09-17)


### Features

* **runner:** expose history transfer measurements ([#34805](https://github.com/vm0-ai/okou/issues/34805)) ([445a170](https://github.com/vm0-ai/okou/commit/445a170a81a2fac9b1d42f361866c2ea70cfb7e7))


### Bug Fixes

* **runner:** downgrade successful slow storage downloads ([#34799](https://github.com/vm0-ai/okou/issues/34799)) ([79e19b6](https://github.com/vm0-ai/okou/commit/79e19b689fbba9e18f8074bb4dd194dc4a99e832))

## [0.196.2](https://github.com/vm0-ai/okou/compare/runner-rs-v0.196.1...runner-rs-v0.196.2) (2026-09-17)


### Performance Improvements

* **runner:** retain decoded cache hits in large storage plans ([#34747](https://github.com/vm0-ai/okou/issues/34747)) ([d170bf9](https://github.com/vm0-ai/okou/commit/d170bf9b7b92f028bf6803e4912d2176798dab42))

## [0.196.1](https://github.com/vm0-ai/okou/compare/runner-rs-v0.196.0...runner-rs-v0.196.1) (2026-09-16)


### Performance Improvements

* **runner:** overlap bounded archive classification with sandbox startup ([#34608](https://github.com/vm0-ai/okou/issues/34608)) ([aa488bf](https://github.com/vm0-ai/okou/commit/aa488bfdd3c783483ef43ae9b09db4e05c33e2be))

## [0.196.0](https://github.com/vm0-ai/okou/compare/runner-rs-v0.195.3...runner-rs-v0.196.0) (2026-09-16)


### Features

* **runner:** expose cumulative mitm token usage per run ([#34687](https://github.com/vm0-ai/okou/issues/34687)) ([3cbba0e](https://github.com/vm0-ai/okou/commit/3cbba0e6a5bb70fac04130bf26a64fdd168a9e1d))


### Bug Fixes

* block direct gmail sends and guide agents to draft review ([#34684](https://github.com/vm0-ai/okou/issues/34684)) ([dbe9107](https://github.com/vm0-ai/okou/commit/dbe9107196583b25d63db499290e02951dff09a5))
* **runner:** fairly drain deferred releases ([#34705](https://github.com/vm0-ai/okou/issues/34705)) ([cfb147f](https://github.com/vm0-ai/okou/commit/cfb147f636c01278232aeebe50f8aa98f2402794))

## [0.195.3](https://github.com/vm0-ai/okou/compare/runner-rs-v0.195.2...runner-rs-v0.195.3) (2026-09-16)


### Bug Fixes

* **api:** attribute required-output backpressure phases ([#34663](https://github.com/vm0-ai/okou/issues/34663)) ([a1e31af](https://github.com/vm0-ai/okou/commit/a1e31afbdd683ded91cb4b0343bfaa2505244b26))

## [0.195.2](https://github.com/vm0-ai/okou/compare/runner-rs-v0.195.1...runner-rs-v0.195.2) (2026-09-16)


### Bug Fixes

* **api:** close deferred sandbox release, fairness and payload gaps ([#34595](https://github.com/vm0-ai/okou/issues/34595)) ([c8b0471](https://github.com/vm0-ai/okou/commit/c8b0471c07e9ec0b897e8e0caf4f0050225e9dcf))
* **runner:** reconcile cancellation after successful claims ([#34580](https://github.com/vm0-ai/okou/issues/34580)) ([435944a](https://github.com/vm0-ai/okou/commit/435944a392ca774cdcfe7be13e37733cdbf52bb5))


### Performance Improvements

* **runner:** stream compressed session history with caller-owned policy ([#34603](https://github.com/vm0-ai/okou/issues/34603)) ([1376434](https://github.com/vm0-ai/okou/commit/1376434b697f5e39be6d569c6b20a4e33ed12342))

## [0.195.1](https://github.com/vm0-ai/okou/compare/runner-rs-v0.195.0...runner-rs-v0.195.1) (2026-09-16)


### Refactoring

* **runner:** separate guest rpc ownership from ssh dispatch ([#34589](https://github.com/vm0-ai/okou/issues/34589)) ([1d4d031](https://github.com/vm0-ai/okou/commit/1d4d0319b66dcb0dab55180a618ad301a10fa0ea))

## [0.195.0](https://github.com/vm0-ai/okou/compare/runner-rs-v0.194.10...runner-rs-v0.195.0) (2026-09-16)


### Features

* add durable deferred pi sandbox consumer ([#34412](https://github.com/vm0-ai/okou/issues/34412)) ([7462236](https://github.com/vm0-ai/okou/commit/74622367fb4d6fb3ad6f12fc71ea1e526efe406b))

## [0.194.10](https://github.com/vm0-ai/okou/compare/runner-rs-v0.194.9...runner-rs-v0.194.10) (2026-09-16)


### Documentation

* correct connector diagnostic metadata lifecycle ([#34533](https://github.com/vm0-ai/okou/issues/34533)) ([82c8379](https://github.com/vm0-ai/okou/commit/82c83791c62380f25d2179a985805dee7c3c46d4))

## [0.194.9](https://github.com/vm0-ai/okou/compare/runner-rs-v0.194.8...runner-rs-v0.194.9) (2026-09-16)


### Bug Fixes

* **runner:** revalidate orphan mitmdump identity ([#34540](https://github.com/vm0-ai/okou/issues/34540)) ([da059b5](https://github.com/vm0-ai/okou/commit/da059b51cbf068790482b632efee5366b60229c0))

## [0.194.8](https://github.com/vm0-ai/okou/compare/runner-rs-v0.194.7...runner-rs-v0.194.8) (2026-09-16)


### Bug Fixes

* **pi:** preserve causal transport failure diagnostics ([#34505](https://github.com/vm0-ai/okou/issues/34505)) ([9ae5a27](https://github.com/vm0-ai/okou/commit/9ae5a2748353914dce8bcf983dac554f7ae5a4af))
* **runner:** classify contained tool oom as informational ([#34520](https://github.com/vm0-ai/okou/issues/34520)) ([02e789d](https://github.com/vm0-ai/okou/commit/02e789d0129298079e23570bc319c5c0557a2d77))
* **runner:** preserve bounded rootfs usage diagnostics ([#34496](https://github.com/vm0-ai/okou/issues/34496)) ([29bec8e](https://github.com/vm0-ai/okou/commit/29bec8e1c81e2a675d0b9821136954c6097bf29f))
* **runner:** treat expected connector unavailability as info ([#34516](https://github.com/vm0-ai/okou/issues/34516)) ([a3a608f](https://github.com/vm0-ai/okou/commit/a3a608fb34c13c1497c19759d918569c9b89fb97))


### Documentation

* **runner:** qualify optional failure-message overflow guarantees ([#34504](https://github.com/vm0-ai/okou/issues/34504)) ([dfe2b6f](https://github.com/vm0-ai/okou/commit/dfe2b6f884615b01d1dbad8c268c4b618ba87b2b))

## [0.194.7](https://github.com/vm0-ai/okou/compare/runner-rs-v0.194.6...runner-rs-v0.194.7) (2026-09-16)


### Bug Fixes

* **runner:** clean skills beneath cached instruction homes ([#34429](https://github.com/vm0-ai/okou/issues/34429)) ([24f4fea](https://github.com/vm0-ai/okou/commit/24f4fea3f60e92686b1771ba9a77ae0100d8d7af))


### Refactoring

* **runner:** acknowledge addon registry and catalog application ([#34422](https://github.com/vm0-ai/okou/issues/34422)) ([15d3e39](https://github.com/vm0-ai/okou/commit/15d3e393884256ff8f80cbbe5692b7dee51a8b32))

## [0.194.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.194.5...runner-rs-v0.194.6) (2026-09-15)


### Bug Fixes

* **runner:** admit decoded skills beside staged instructions ([#34425](https://github.com/vm0-ai/vm0/issues/34425)) ([a889f9e](https://github.com/vm0-ai/vm0/commit/a889f9e9156c7c3f073e1cdedf313bb37bc1d7e3))
* **runner:** bound access websocket messages for origin reads ([#34424](https://github.com/vm0-ai/vm0/issues/34424)) ([d7d62c1](https://github.com/vm0-ai/vm0/commit/d7d62c188bbea55a3a14b68c331f6a656f582bd8))

## [0.194.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.194.4...runner-rs-v0.194.5) (2026-09-15)


### Bug Fixes

* **runner:** protect native runtime memory from tool reclaim ([#34398](https://github.com/vm0-ai/vm0/issues/34398)) ([756b6bc](https://github.com/vm0-ai/vm0/commit/756b6bce47a0a4b341359971ebc7ae9a4c24c62e))

## [0.194.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.194.3...runner-rs-v0.194.4) (2026-09-15)


### Bug Fixes

* distinguish balance ownership and localize run errors ([#34251](https://github.com/vm0-ai/vm0/issues/34251)) ([0367d97](https://github.com/vm0-ai/vm0/commit/0367d976a87fe1251fcb9b6cfe545a8b24e4f2b6))

## [0.194.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.194.2...runner-rs-v0.194.3) (2026-09-15)


### Bug Fixes

* **runner:** prevent addon stderr backpressure from blocking proxy hooks ([#34351](https://github.com/vm0-ai/vm0/issues/34351)) ([2119c7c](https://github.com/vm0-ai/vm0/commit/2119c7c6d465c35c1dd2b283931c298505d441fb))

## [0.194.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.194.1...runner-rs-v0.194.2) (2026-09-15)


### Bug Fixes

* **pi:** preserve codex rate-limit diagnostics ([#34266](https://github.com/vm0-ai/vm0/issues/34266)) ([48cb88f](https://github.com/vm0-ai/vm0/commit/48cb88fe5c6a70dd6519565211de55b710fee3af))


### Refactoring

* **runner:** replace addon readiness marker with private control socket ([#34308](https://github.com/vm0-ai/vm0/issues/34308)) ([0035c91](https://github.com/vm0-ai/vm0/commit/0035c91324113ccec6a31d26db35533af619ff9f))


### Performance Improvements

* **runner:** persist extracted storage files for cache-hit delivery ([#33976](https://github.com/vm0-ai/vm0/issues/33976)) ([b961911](https://github.com/vm0-ai/vm0/commit/b961911d0516fbdc06d3e8387bedb0653eee5ea9))

## [0.194.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.194.0...runner-rs-v0.194.1) (2026-09-15)


### Bug Fixes

* **runner:** clean up quiet ignored-child descendants ([#34261](https://github.com/vm0-ai/vm0/issues/34261)) ([92923ba](https://github.com/vm0-ai/vm0/commit/92923ba9eb5b0c0593362b6702b0fd3775c9c28f))

## [0.194.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.193.0...runner-rs-v0.194.0) (2026-09-15)


### Features

* **runner:** carry ssh over native cloudflare access websockets ([#34235](https://github.com/vm0-ai/vm0/issues/34235)) ([d0e77ab](https://github.com/vm0-ai/vm0/commit/d0e77ab1325582bc095e6895f678cd7c99b0cf10))

## [0.193.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.192.6...runner-rs-v0.193.0) (2026-09-15)


### Features

* **ssh:** add reusable cloudflare access configuration ([#34105](https://github.com/vm0-ai/vm0/issues/34105)) ([21f7e6a](https://github.com/vm0-ai/vm0/commit/21f7e6a3d2870791cb705ebd37217457d9118890))

## [0.192.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.192.5...runner-rs-v0.192.6) (2026-09-14)


### Refactoring

* use two-day presigned urls without renewal or retries ([#34149](https://github.com/vm0-ai/vm0/issues/34149)) ([a876fd2](https://github.com/vm0-ai/vm0/commit/a876fd28cd0a0fade04aa12fff33614ff156ba9b))

## [0.192.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.192.4...runner-rs-v0.192.5) (2026-09-14)

## [0.192.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.192.3...runner-rs-v0.192.4) (2026-09-14)


### Documentation

* **python:** clarify brotli trailing-data fallback ([#34049](https://github.com/vm0-ai/vm0/issues/34049)) ([dd61073](https://github.com/vm0-ai/vm0/commit/dd610736476b821b9caa39239f67432bcea7c516))

## [0.192.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.192.2...runner-rs-v0.192.3) (2026-09-14)


### Bug Fixes

* **python:** reject truncated buffered json usage responses ([#33972](https://github.com/vm0-ai/vm0/issues/33972)) ([aba8e15](https://github.com/vm0-ai/vm0/commit/aba8e159c3ac4607977b462193632908131eaac4))
* **runner:** preserve firecracker discovery uncertainty on stat errors ([#33988](https://github.com/vm0-ai/vm0/issues/33988)) ([8e8829f](https://github.com/vm0-ai/vm0/commit/8e8829fe1a2b6bb01312973f9f40e82a13f95f76))
* **runner:** reject overlong integers in flush markers ([#33999](https://github.com/vm0-ai/vm0/issues/33999)) ([d214b89](https://github.com/vm0-ai/vm0/commit/d214b89961eff646fa1a1910d398b688bcda272e))
* **runner:** terminate oversized header names before body buffering ([#33962](https://github.com/vm0-ai/vm0/issues/33962)) ([0326351](https://github.com/vm0-ai/vm0/commit/0326351d39a9e79bd9d0c6a0085b84a18d177b81))


### Documentation

* **python:** correct idle websocket failure-observer contract ([#33991](https://github.com/vm0-ai/vm0/issues/33991)) ([4a4be18](https://github.com/vm0-ai/vm0/commit/4a4be185ef2b420dd1bd2674deb309a25702afa6))

## [0.192.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.192.1...runner-rs-v0.192.2) (2026-09-14)


### Bug Fixes

* **python:** detect loop-carried metadata aliases ([#33890](https://github.com/vm0-ai/vm0/issues/33890)) ([ae04c7e](https://github.com/vm0-ai/vm0/commit/ae04c7e09f883569f77fba159d88d930629b5aaf))
* **runner:** unify resolved auth header case handling ([#33937](https://github.com/vm0-ai/vm0/issues/33937)) ([a4588ed](https://github.com/vm0-ai/vm0/commit/a4588ed0307713cb2bff6b16937e45935ca618fa))


### Performance Improvements

* **runner:** release completed jsonl batches before idle ([#33935](https://github.com/vm0-ai/vm0/issues/33935)) ([b26d24d](https://github.com/vm0-ai/vm0/commit/b26d24d6bc759e51917d7ae4fb7cbc918d05a841))

## [0.192.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.192.0...runner-rs-v0.192.1) (2026-09-14)


### Performance Improvements

* **runner:** bound capture header dependency traversal ([#33885](https://github.com/vm0-ai/vm0/issues/33885)) ([ad39560](https://github.com/vm0-ai/vm0/commit/ad39560e1e84e67bf5a8f46795cbc037f74a554c))

## [0.192.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.191.3...runner-rs-v0.192.0) (2026-09-14)


### Features

* **model-provider:** gate supported platform openrouter us routing ([#33768](https://github.com/vm0-ai/vm0/issues/33768)) ([a19d5ea](https://github.com/vm0-ai/vm0/commit/a19d5ea87246eac8595cb3a8163feae856f4835f))

## [0.191.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.191.2...runner-rs-v0.191.3) (2026-09-13)


### Bug Fixes

* **python:** invalidate chat usage after sse event discard ([#33771](https://github.com/vm0-ai/vm0/issues/33771)) ([26953c4](https://github.com/vm0-ai/vm0/commit/26953c471ebfba8e1857832cc4f36360c1e647ae))
* **runner:** include origin port in firewall auth proxy tunnels ([#33770](https://github.com/vm0-ai/vm0/issues/33770)) ([66e1b39](https://github.com/vm0-ai/vm0/commit/66e1b39831a3e89473d5a7edf0ba518d625fc5fb))


### Refactoring

* **runner:** remove legacy connector-intent header tolerance ([#33767](https://github.com/vm0-ai/vm0/issues/33767)) ([fbde4b7](https://github.com/vm0-ai/vm0/commit/fbde4b7330555badff700092cfa231cf3ee70c6b))

## [0.191.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.191.1...runner-rs-v0.191.2) (2026-09-13)


### Refactoring

* **runner:** accept both connector-intent header names ([#33707](https://github.com/vm0-ai/vm0/issues/33707)) ([33e83ae](https://github.com/vm0-ai/vm0/commit/33e83ae7126fba27731120dbde3df8fff993ec96))

## [0.191.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.191.0...runner-rs-v0.191.1) (2026-09-12)


### Performance Improvements

* **runner:** reuse idle ssh connections within a run ([#33690](https://github.com/vm0-ai/vm0/issues/33690)) ([17e9259](https://github.com/vm0-ai/vm0/commit/17e9259583f7682ccbc69214bd5da9442a3b6a21))

## [0.191.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.190.8...runner-rs-v0.191.0) (2026-09-12)


### Features

* **ssh:** add managed sessions within a run ([#33674](https://github.com/vm0-ai/vm0/issues/33674)) ([45c6643](https://github.com/vm0-ai/vm0/commit/45c6643695cfd76617ae72e5fb4b42a437cd9a70))


### Bug Fixes

* **runner:** own usage retry delivery through shutdown ([#33675](https://github.com/vm0-ai/vm0/issues/33675)) ([f2016a4](https://github.com/vm0-ai/vm0/commit/f2016a4f77d3c783f0bc847ddf4cfa9ff0da043a))
* **ssh:** wait for private key decoding capacity ([#33646](https://github.com/vm0-ai/vm0/issues/33646)) ([8451ce0](https://github.com/vm0-ai/vm0/commit/8451ce0e82e70cfeb16bb83441892c4022e38014))


### Refactoring

* **runner:** rename sandbox-internal and preview-only x-vm0 headers ([#33663](https://github.com/vm0-ai/vm0/issues/33663)) ([9375cec](https://github.com/vm0-ai/vm0/commit/9375cec4abaa342c41b17cc54275f9cb59031b64))
* **ssh:** scope admission to eight requests per run ([#33631](https://github.com/vm0-ai/vm0/issues/33631)) ([13d35da](https://github.com/vm0-ai/vm0/commit/13d35da64779aa788565f075242278f8eee5cda0))


### Performance Improvements

* **runner:** bound connector diagnostic auth-header inspection ([#33676](https://github.com/vm0-ai/vm0/issues/33676)) ([65501ea](https://github.com/vm0-ai/vm0/commit/65501eaee44650b3a2c613464776b24c3a5acc5d))

## [0.190.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.190.7...runner-rs-v0.190.8) (2026-09-12)


### Bug Fixes

* **ssh:** release guest park protection when rpc closes ([#33534](https://github.com/vm0-ai/vm0/issues/33534)) ([1fb21f7](https://github.com/vm0-ai/vm0/commit/1fb21f794131078cdfc87c970eaf7f2c5d9f1c6f))


### Refactoring

* **runner:** share finalizing reservation activation ([#33550](https://github.com/vm0-ai/vm0/issues/33550)) ([94937b7](https://github.com/vm0-ai/vm0/commit/94937b79b1990bb2fe3a650ec8bf43e98a5c7533))


### Performance Improvements

* **runner:** refill doctor io slots independently of result order ([#33575](https://github.com/vm0-ai/vm0/issues/33575)) ([620dbb4](https://github.com/vm0-ai/vm0/commit/620dbb477e06fabb378e8b09c2d59484ade0d52e))

## [0.190.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.190.6...runner-rs-v0.190.7) (2026-09-11)

## [0.190.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.190.5...runner-rs-v0.190.6) (2026-09-11)


### Bug Fixes

* **runner:** bound proxy flush filesystem waits ([#33549](https://github.com/vm0-ai/vm0/issues/33549)) ([4ad60dc](https://github.com/vm0-ai/vm0/commit/4ad60dcfb79c4bae323a4a4d9cea0aec92bd2e9b))
* **runner:** keep local cancellation scans responsive ([#33513](https://github.com/vm0-ai/vm0/issues/33513)) ([9a5676e](https://github.com/vm0-ai/vm0/commit/9a5676e8eacebc58e2fad416a4deff8db48ec4da))


### Documentation

* **python:** correct buffered pending-state counter semantics ([#33533](https://github.com/vm0-ai/vm0/issues/33533)) ([df04dea](https://github.com/vm0-ai/vm0/commit/df04dea683cbfcf2b35d2e0a3917c7c11b374ff7))


### Refactoring

* **runner:** rename the vm0-prefixed mitm addon options ([#33546](https://github.com/vm0-ai/vm0/issues/33546)) ([b1507ec](https://github.com/vm0-ai/vm0/commit/b1507ec2a083b67ef55a76bc7f78bd977cb03c66)), closes [#33492](https://github.com/vm0-ai/vm0/issues/33492)

## [0.190.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.190.4...runner-rs-v0.190.5) (2026-09-11)

## [0.190.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.190.3...runner-rs-v0.190.4) (2026-09-11)


### Bug Fixes

* **runner:** retry transient builtin catalog read failures ([#33461](https://github.com/vm0-ai/vm0/issues/33461)) ([6c7314b](https://github.com/vm0-ai/vm0/commit/6c7314bd8e8ac780fb24141f4dce0e442fed07dd))


### Documentation

* **runner:** clarify oversized background fill failure boundary ([#33454](https://github.com/vm0-ai/vm0/issues/33454)) ([266e707](https://github.com/vm0-ai/vm0/commit/266e707f5f7fc26892ccf6541166098ccd41a96c))


### Performance Improvements

* **python:** bound json nesting guard string scanning ([#33460](https://github.com/vm0-ai/vm0/issues/33460)) ([f222d69](https://github.com/vm0-ai/vm0/commit/f222d6930ff95ac74739f877566366f29fc3c36a))
* **runner:** bound retry-after header inspection ([#33455](https://github.com/vm0-ai/vm0/issues/33455)) ([9ada863](https://github.com/vm0-ai/vm0/commit/9ada86363d7e1606c625b4caf1a6e9976d7fd4c9))

## [0.190.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.190.2...runner-rs-v0.190.3) (2026-09-11)


### Bug Fixes

* **runner:** classify cached firewall refresh send timeouts ([#33422](https://github.com/vm0-ai/vm0/issues/33422)) ([1bb8ae8](https://github.com/vm0-ai/vm0/commit/1bb8ae869215f01310b759779070773c93a6252c))
* **runner:** extend bounded network-log upload budget to 30 seconds ([#33419](https://github.com/vm0-ai/vm0/issues/33419)) ([b71a6a0](https://github.com/vm0-ai/vm0/commit/b71a6a0e2ddda9756ea5a7e48a9cdaae733ce169))

## [0.190.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.190.1...runner-rs-v0.190.2) (2026-09-11)


### Bug Fixes

* **runner:** preserve connector diagnostic base specificity ([#33394](https://github.com/vm0-ai/vm0/issues/33394)) ([5074692](https://github.com/vm0-ai/vm0/commit/5074692946531bc240499a7c5f908c1de0607ade))

## [0.190.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.190.0...runner-rs-v0.190.1) (2026-09-10)

## [0.190.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.189.7...runner-rs-v0.190.0) (2026-09-10)


### Features

* **ssh:** surface host connection failures and recovery ([#33165](https://github.com/vm0-ai/vm0/issues/33165)) ([f56df60](https://github.com/vm0-ai/vm0/commit/f56df6068d35f5591020a5bb61fb4197cb6cd820))


### Bug Fixes

* **api:** keep sandbox telemetry batches alive and name oom upload failures ([#33287](https://github.com/vm0-ai/vm0/issues/33287)) ([ff65e65](https://github.com/vm0-ai/vm0/commit/ff65e65da0231a4fcad15645c041cdd57a3d7d46))
* extend storage url lifetime and preserve download error details ([#33181](https://github.com/vm0-ai/vm0/issues/33181)) ([93ccb22](https://github.com/vm0-ai/vm0/commit/93ccb227278b0e384594abffea5d1244219164cf))
* **guest-control:** classify oom metadata apart from terminal diagnostics ([#33238](https://github.com/vm0-ai/vm0/issues/33238)) ([7e0a677](https://github.com/vm0-ai/vm0/commit/7e0a67723010f1088d5365e8dcce1801217e772c))
* **pi:** keep model failures actionable when an upstream returns a document ([#33249](https://github.com/vm0-ai/vm0/issues/33249)) ([76eb46f](https://github.com/vm0-ai/vm0/commit/76eb46f0b78b846fc5a1f3a8a3e6a18a2b327aab))
* **runner:** create workspace metadata with private permissions ([#33284](https://github.com/vm0-ai/vm0/issues/33284)) ([dacc7f4](https://github.com/vm0-ai/vm0/commit/dacc7f47c4c8d071e4762cd4d149dfc18f4cbab5))
* **runner:** ignore systemd comments before continuation handling ([#33201](https://github.com/vm0-ai/vm0/issues/33201)) ([10627c5](https://github.com/vm0-ai/vm0/commit/10627c5205c685d64c5302f7f5a6226175d561b2))
* **runner:** preserve hostname label boundaries in catalog templates ([#33260](https://github.com/vm0-ai/vm0/issues/33260)) ([a01e4de](https://github.com/vm0-ai/vm0/commit/a01e4de47bc5da58d46bf9b30ad95a906bd92dc7))
* **runner:** report the real termination reason for oom-killed agent runs ([#33240](https://github.com/vm0-ai/vm0/issues/33240)) ([f695c77](https://github.com/vm0-ai/vm0/commit/f695c77cd45566553f8b01d0c2f484909cebfc70))


### Documentation

* **python:** correct permanent delivery failure logging guidance ([#33270](https://github.com/vm0-ai/vm0/issues/33270)) ([496b660](https://github.com/vm0-ai/vm0/commit/496b660ca5408c2b64693ab936de68a61e674f40))


### Refactoring

* **python:** share payload-free thread-pool startup ([#33274](https://github.com/vm0-ai/vm0/issues/33274)) ([95e594f](https://github.com/vm0-ai/vm0/commit/95e594fa3ee9f6e14622a1814c8e0812b730cfb5))

## [0.189.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.189.6...runner-rs-v0.189.7) (2026-09-10)


### Bug Fixes

* **guest-agent:** classify upstream content policy rejections ([#33180](https://github.com/vm0-ai/vm0/issues/33180)) ([f61db10](https://github.com/vm0-ai/vm0/commit/f61db105d0965c93bffb84f061d1027db8d79e36))
* **python:** bound webhook tasks after worker startup failure ([#33124](https://github.com/vm0-ai/vm0/issues/33124)) ([2a7efd4](https://github.com/vm0-ai/vm0/commit/2a7efd4d585f59bbe0694a90d342dd2f93c2da30))
* **runner:** classify transient active-input read recovery ([#33116](https://github.com/vm0-ai/vm0/issues/33116)) ([6b3e05a](https://github.com/vm0-ai/vm0/commit/6b3e05a6bfb0844e7349cc112e3abd9fb0551ef2))


### Documentation

* **python:** correct jsonl flush warning transport ([#33118](https://github.com/vm0-ai/vm0/issues/33118)) ([c2713d8](https://github.com/vm0-ai/vm0/commit/c2713d8536f25fc5246bc0e0a3c4a58e8545a3b4))


### Refactoring

* retire goal backend authority and application orm consumers ([#33105](https://github.com/vm0-ai/vm0/issues/33105)) ([2c23176](https://github.com/vm0-ai/vm0/commit/2c231766e383b651867893852cfb47dcc78af0bd))

## [0.189.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.189.5...runner-rs-v0.189.6) (2026-09-09)


### Bug Fixes

* **python:** prevent sigv4 body retention on worker-start failure ([#33021](https://github.com/vm0-ai/vm0/issues/33021)) ([04084b9](https://github.com/vm0-ai/vm0/commit/04084b97b6fbaecadfa6733a022a4c567b169714))


### Documentation

* **python:** clarify process-event size and error contract ([#33007](https://github.com/vm0-ai/vm0/issues/33007)) ([27c93a8](https://github.com/vm0-ai/vm0/commit/27c93a80a09d09f12aba7c94379f9667ff1c5433))
* **runner:** clarify idle pool admission and cleanup ([#33005](https://github.com/vm0-ai/vm0/issues/33005)) ([cc25e83](https://github.com/vm0-ai/vm0/commit/cc25e83cccfe32da6fa50a89a18cc81a1d34b0d2))

## [0.189.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.189.4...runner-rs-v0.189.5) (2026-09-09)


### Refactoring

* **runner:** delete retired mitmdump runtime marker tombstone tests ([#32973](https://github.com/vm0-ai/vm0/issues/32973)) ([011e6f0](https://github.com/vm0-ai/vm0/commit/011e6f0c62582cc594ff51655ac4a84143bc356a)), closes [#32937](https://github.com/vm0-ai/vm0/issues/32937)

## [0.189.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.189.3...runner-rs-v0.189.4) (2026-09-09)


### Bug Fixes

* **runner:** bound codex timestamp parsing across history encodings ([#32945](https://github.com/vm0-ai/vm0/issues/32945)) ([c625c2e](https://github.com/vm0-ai/vm0/commit/c625c2e0b216d5ac5641f2ed69f6a13e30b5bb5e))


### Refactoring

* **naming:** correct residual retired-brand copy and internal names ([#32946](https://github.com/vm0-ai/vm0/issues/32946)) ([c5e6ef9](https://github.com/vm0-ai/vm0/commit/c5e6ef9e41593c017fd2fd57222a40d123270db5)), closes [#32939](https://github.com/vm0-ai/vm0/issues/32939)

## [0.189.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.189.2...runner-rs-v0.189.3) (2026-09-09)


### Bug Fixes

* **pi-memory:** preserve unchanged files and safe failure diagnostics ([#32911](https://github.com/vm0-ai/vm0/issues/32911)) ([dcf5e10](https://github.com/vm0-ai/vm0/commit/dcf5e10bb749b56b091ad0d0de6770928195db23)), closes [#32744](https://github.com/vm0-ai/vm0/issues/32744)
* **runner:** preserve jsonl framing after partial append failures ([#32928](https://github.com/vm0-ai/vm0/issues/32928)) ([6de90ea](https://github.com/vm0-ai/vm0/commit/6de90eacb2d78ff367384723ef2097e37628b387))

## [0.189.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.189.1...runner-rs-v0.189.2) (2026-09-09)


### Bug Fixes

* **runner:** preserve websocket pricing after tier-cache eviction ([#32896](https://github.com/vm0-ai/vm0/issues/32896)) ([7fd49fb](https://github.com/vm0-ai/vm0/commit/7fd49fb183e4db0add47a730f2280b359788a5d8))


### Documentation

* **python:** document terminal model usage tier failures ([#32893](https://github.com/vm0-ai/vm0/issues/32893)) ([136bef5](https://github.com/vm0-ai/vm0/commit/136bef58606b779ef9c2969481bec8ba0d3dd2bb))


### Performance Improvements

* **runner:** bound codex catalog accept-encoding inspection ([#32897](https://github.com/vm0-ai/vm0/issues/32897)) ([85b25be](https://github.com/vm0-ai/vm0/commit/85b25be4b45686ee99acc0019f0814fe30524c2a))

## [0.189.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.189.0...runner-rs-v0.189.1) (2026-09-09)


### Bug Fixes

* **runner:** isolate codex timing across websocket flows ([#32874](https://github.com/vm0-ai/vm0/issues/32874)) ([22af62b](https://github.com/vm0-ai/vm0/commit/22af62b889e097ed05c3be9d95a723ccb44c8e69))
* **runner:** own catalog validation work after thread startup failures ([#32862](https://github.com/vm0-ai/vm0/issues/32862)) ([98ae7da](https://github.com/vm0-ai/vm0/commit/98ae7daf58fab723e1dfb6383e9401c61b7d6ad5))
* **runner:** recover blank runs after unsafe codex prefetch start ([#32865](https://github.com/vm0-ai/vm0/issues/32865)) ([594d907](https://github.com/vm0-ai/vm0/commit/594d907ca844e845f674c04640a58ae8cebcdc8a))
* **runner:** reject local input when forwarding is disabled ([#32863](https://github.com/vm0-ai/vm0/issues/32863)) ([5a82c53](https://github.com/vm0-ai/vm0/commit/5a82c5384c047d91976fce66f889944b1ba5bd91))

## [0.189.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.19...runner-rs-v0.189.0) (2026-09-09)


### Features

* **pi:** prepare native claude consumers and accounting ([#32835](https://github.com/vm0-ai/vm0/issues/32835)) ([31133fc](https://github.com/vm0-ai/vm0/commit/31133fc7ba5eeecbc1c8a0cda32f16f1ff2b4602))


### Bug Fixes

* **guest:** preserve bounded oom evidence before cleanup ([#32845](https://github.com/vm0-ai/vm0/issues/32845)) ([075ccba](https://github.com/vm0-ai/vm0/commit/075ccbaaf8f90231687267218ef1e77d05771d3a))
* **rpc:** dispatch complete request frames without waiting for eof ([#32821](https://github.com/vm0-ai/vm0/issues/32821)) ([cb025d6](https://github.com/vm0-ai/vm0/commit/cb025d643f9348b2f2a5f8ebc2725fb353c1524f))
* **runner:** classify recovered cooperative cancellation races ([#32812](https://github.com/vm0-ai/vm0/issues/32812)) ([4e6a603](https://github.com/vm0-ai/vm0/commit/4e6a603da4241cfcb81e6329c91df828696ce89f))
* **runner:** defer blank memory reclamation until agent readiness ([#32824](https://github.com/vm0-ai/vm0/issues/32824)) ([29040ac](https://github.com/vm0-ai/vm0/commit/29040ac3b52f14bfb415bc5eeb0adcb7383b17d5))

## [0.188.19](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.18...runner-rs-v0.188.19) (2026-09-09)

## [0.188.18](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.17...runner-rs-v0.188.18) (2026-09-09)


### Bug Fixes

* **runner:** classify cancelled workspace promotion skips ([#32793](https://github.com/vm0-ai/vm0/issues/32793)) ([5b45464](https://github.com/vm0-ai/vm0/commit/5b4546424e912fee5831a284ea9a54ead5311c1b))
* **runner:** classify expected catalog prefetch timeouts ([#32791](https://github.com/vm0-ai/vm0/issues/32791)) ([b508e1b](https://github.com/vm0-ai/vm0/commit/b508e1b63883c0fb4519330ca0070e10e61e231e))
* **runner:** classify firewall catalog refresh degradation ([#32778](https://github.com/vm0-ai/vm0/issues/32778)) ([e0d4a64](https://github.com/vm0-ai/vm0/commit/e0d4a6479033e1013617c2902f52e73e65f210ed))

## [0.188.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.16...runner-rs-v0.188.17) (2026-09-08)


### Bug Fixes

* finish okou brand cleanup ([#32684](https://github.com/vm0-ai/vm0/issues/32684)) ([7d239a4](https://github.com/vm0-ai/vm0/commit/7d239a41a5dd6dd41ed7c22cd9e5dae566fc1925))
* **runner:** attribute guest dns readiness attempts ([#32697](https://github.com/vm0-ai/vm0/issues/32697)) ([7558632](https://github.com/vm0-ai/vm0/commit/7558632c0eea9bded6c831fdba33a76c369677aa)), closes [#32445](https://github.com/vm0-ai/vm0/issues/32445)


### Performance Improvements

* **runner:** attribute guest connection startup phases ([#32705](https://github.com/vm0-ai/vm0/issues/32705)) ([176ca98](https://github.com/vm0-ai/vm0/commit/176ca98235eee2d021f23448aef8158d51ecb43f))
* **runner:** reduce workspace mount helper process fanout ([#32704](https://github.com/vm0-ai/vm0/issues/32704)) ([6948274](https://github.com/vm0-ai/vm0/commit/69482746ed271dfbce548e7a32ec86869d144172))

## [0.188.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.15...runner-rs-v0.188.16) (2026-09-08)

## [0.188.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.14...runner-rs-v0.188.15) (2026-09-08)


### Bug Fixes

* **runner:** bind orphan group signals to verified process identity ([#32563](https://github.com/vm0-ai/vm0/issues/32563)) ([60915a0](https://github.com/vm0-ai/vm0/commit/60915a0fc006981dc47a0660b550e0607a12495a))


### Performance Improvements

* **python:** bound raw websocket handshake header inspection ([#32618](https://github.com/vm0-ai/vm0/issues/32618)) ([4996a0f](https://github.com/vm0-ai/vm0/commit/4996a0fd9e4fb073934700cb47d24360fe1a61b5))

## [0.188.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.13...runner-rs-v0.188.14) (2026-09-08)

## [0.188.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.12...runner-rs-v0.188.13) (2026-09-08)

## [0.188.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.11...runner-rs-v0.188.12) (2026-09-08)


### Refactoring

* **mitm-addon:** initialize policy reduction with the selected base ([#32562](https://github.com/vm0-ai/vm0/issues/32562)) ([c7ee676](https://github.com/vm0-ai/vm0/commit/c7ee67610e856cbbed07f1e8d6fc2d66b4e0c076))


### Performance Improvements

* **runner:** batch required connector context with agent private files ([#32545](https://github.com/vm0-ai/vm0/issues/32545)) ([a297e80](https://github.com/vm0-ai/vm0/commit/a297e80b989a3d11b3b26a5bc93939d69a996318))

## [0.188.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.10...runner-rs-v0.188.11) (2026-09-08)

## [0.188.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.9...runner-rs-v0.188.10) (2026-09-08)


### Bug Fixes

* **runner:** allow api cold starts in http timeout budgets ([#32517](https://github.com/vm0-ai/vm0/issues/32517)) ([041a420](https://github.com/vm0-ai/vm0/commit/041a420f4e44a8d648945c6fc817cd9b571e4a88))

## [0.188.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.8...runner-rs-v0.188.9) (2026-09-08)


### Bug Fixes

* **runner:** remove legacy model provider failure report retry ([#32521](https://github.com/vm0-ai/vm0/issues/32521)) ([dc2942a](https://github.com/vm0-ai/vm0/commit/dc2942a3bec447353e4816af373fdfba3b9bdefc)), closes [#29882](https://github.com/vm0-ai/vm0/issues/29882)

## [0.188.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.7...runner-rs-v0.188.8) (2026-09-08)


### Documentation

* **python:** correct HTTP error log destination ([#32474](https://github.com/vm0-ai/vm0/issues/32474)) ([84d62e4](https://github.com/vm0-ai/vm0/commit/84d62e4d6b9d869fb33bf024e8d758e79e2c2dd2))

## [0.188.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.6...runner-rs-v0.188.7) (2026-09-08)

## [0.188.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.5...runner-rs-v0.188.6) (2026-09-08)


### Bug Fixes

* **runner:** retain rootfs locks until worker teardown ([#32416](https://github.com/vm0-ai/vm0/issues/32416)) ([e71291a](https://github.com/vm0-ai/vm0/commit/e71291a1c1ab12b49c9704b4e50485782d40d6d0))

## [0.188.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.4...runner-rs-v0.188.5) (2026-09-07)


### Bug Fixes

* **runner:** prevent premature network log drain acknowledgement ([#32388](https://github.com/vm0-ai/vm0/issues/32388)) ([9f6e74d](https://github.com/vm0-ai/vm0/commit/9f6e74d5b2a133a9f37ba9403efb29c42882bf34))


### Refactoring

* **runner:** retire legacy blank status readers ([#32385](https://github.com/vm0-ai/vm0/issues/32385)) ([61e1e61](https://github.com/vm0-ai/vm0/commit/61e1e61be1cd22759672773f3f7cd46571fd568b))

## [0.188.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.3...runner-rs-v0.188.4) (2026-09-07)


### Bug Fixes

* **runner:** retire codex prefetch sandboxes after partial writes ([#32358](https://github.com/vm0-ai/vm0/issues/32358)) ([dd0454e](https://github.com/vm0-ai/vm0/commit/dd0454e8707ecb068cf839c76d04c315427d6783))

## [0.188.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.2...runner-rs-v0.188.3) (2026-09-07)


### Refactoring

* **rust:** align workspace crate names with responsibilities ([#32307](https://github.com/vm0-ai/vm0/issues/32307)) ([39d81ce](https://github.com/vm0-ai/vm0/commit/39d81cedeb3c324ea48c3190e47ffb6c63bb28d9))

## [0.188.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.1...runner-rs-v0.188.2) (2026-09-07)

## [0.188.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.188.0...runner-rs-v0.188.1) (2026-09-07)


### Bug Fixes

* **runner:** retire sandbox after prefetch start timeout ([#32308](https://github.com/vm0-ai/vm0/issues/32308)) ([984a47b](https://github.com/vm0-ai/vm0/commit/984a47b8744fea46ceb63c03d43fcd19970ef31d))

## [0.188.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.187.1...runner-rs-v0.188.0) (2026-09-07)


### Features

* **runner:** publish explicit blank sandbox inventory ([#32269](https://github.com/vm0-ai/vm0/issues/32269)) ([bd9cddc](https://github.com/vm0-ai/vm0/commit/bd9cddcf6719c90848ed4ec497baca8cfd3191ea))


### Bug Fixes

* **pi:** enable thread active input forwarding ([#32298](https://github.com/vm0-ai/vm0/issues/32298)) ([bb0b432](https://github.com/vm0-ai/vm0/commit/bb0b432f4a226344b390412f56306101471b5e8f))


### Refactoring

* **runner:** share api degradation episode transitions ([#32248](https://github.com/vm0-ai/vm0/issues/32248)) ([818bce5](https://github.com/vm0-ai/vm0/commit/818bce52538a5598347edcd9d1ced997e9624a20))
* **runtime:** neutralize private test markers ([#32270](https://github.com/vm0-ai/vm0/issues/32270)) ([b1a3e6f](https://github.com/vm0-ai/vm0/commit/b1a3e6f80100113525c2b38c3a9dd1583d03cfe5))

## [0.187.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.187.0...runner-rs-v0.187.1) (2026-09-07)


### Bug Fixes

* **runner:** bound resumed idle workspace reclamation ([#32232](https://github.com/vm0-ai/vm0/issues/32232)) ([f6b6134](https://github.com/vm0-ai/vm0/commit/f6b613497178855d93a23f4727809a722adc4947))

## [0.187.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.186.15...runner-rs-v0.187.0) (2026-09-07)


### Features

* **rpc:** add generic guest-to-runner transport and sandbox fencing ([#32161](https://github.com/vm0-ai/vm0/issues/32161)) ([847d733](https://github.com/vm0-ai/vm0/commit/847d733315462a73b0aae20f992737b9df289bf9))
* **runner:** distinguish blank sandboxes in doctor and monitoring ([#32092](https://github.com/vm0-ai/vm0/issues/32092)) ([febec8a](https://github.com/vm0-ai/vm0/commit/febec8a3399be74b0f14a89cb9f42e39dd5ce69f))


### Bug Fixes

* **firewall:** attribute auth fetch deadlines ([#32195](https://github.com/vm0-ai/vm0/issues/32195)) ([c3c8778](https://github.com/vm0-ai/vm0/commit/c3c8778e1352786e8c21d868531656f79a9624a7))
* **runner:** expose api transport failure causes ([#32188](https://github.com/vm0-ai/vm0/issues/32188)) ([ecbe1ff](https://github.com/vm0-ai/vm0/commit/ecbe1ff6cacdb9b251aff1e37217eab41366b158))

## [0.186.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.186.14...runner-rs-v0.186.15) (2026-09-07)

## [0.186.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.186.13...runner-rs-v0.186.14) (2026-09-07)

## [0.186.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.186.12...runner-rs-v0.186.13) (2026-09-07)


### Bug Fixes

* **python:** reject non-utf-8 catalog response headers ([#32135](https://github.com/vm0-ai/vm0/issues/32135)) ([f154925](https://github.com/vm0-ai/vm0/commit/f154925669183ea8a6c5679256122d5da4e81657))


### Performance Improvements

* **mitm-addon:** bulk-validate discarded utf-8 strings ([#32166](https://github.com/vm0-ai/vm0/issues/32166)) ([c0137f0](https://github.com/vm0-ai/vm0/commit/c0137f0ed0e1d6613929c604e71f28fe156f594d))

## [0.186.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.186.11...runner-rs-v0.186.12) (2026-09-07)


### Bug Fixes

* **runner:** keep shared reactor work independently scheduled ([#32055](https://github.com/vm0-ai/vm0/issues/32055)) ([7b89f33](https://github.com/vm0-ai/vm0/commit/7b89f334da0b1cd8b14eeee723761f88ee9962bb))
* **runner:** warn on unacknowledged promotion drains ([#32058](https://github.com/vm0-ai/vm0/issues/32058)) ([132e942](https://github.com/vm0-ai/vm0/commit/132e94205bc0e182d6c5696f3b1c6aff86318b9f))

## [0.186.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.186.10...runner-rs-v0.186.11) (2026-09-07)


### Performance Improvements

* **runner:** prewarm capacity-scaled blank sandboxes ([#31970](https://github.com/vm0-ai/vm0/issues/31970)) ([681ea1d](https://github.com/vm0-ai/vm0/commit/681ea1d05a48494ea838304365219fd428169e55))

## [0.186.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.186.9...runner-rs-v0.186.10) (2026-09-06)


### Bug Fixes

* **python:** keep resolved auth header bytes consistent ([#32022](https://github.com/vm0-ai/vm0/issues/32022)) ([b3535a2](https://github.com/vm0-ai/vm0/commit/b3535a26f15f04cf8639c2f7765eadcd36a5be8a))

## [0.186.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.186.8...runner-rs-v0.186.9) (2026-09-06)


### Bug Fixes

* **mitm-addon:** redact whitespace-separated url userinfo ([#32024](https://github.com/vm0-ai/vm0/issues/32024)) ([83462e3](https://github.com/vm0-ai/vm0/commit/83462e3b47192bfddf30340f61ba9cf6b1b30c1a))
* **python:** track set and dict display hashing failures ([#32027](https://github.com/vm0-ai/vm0/issues/32027)) ([982724a](https://github.com/vm0-ai/vm0/commit/982724ad05aa9f373fe6858d217f8a4ef873993b))


### Performance Improvements

* **python:** bound accept-encoding negotiation work ([#32026](https://github.com/vm0-ai/vm0/issues/32026)) ([02a358f](https://github.com/vm0-ai/vm0/commit/02a358fc5303b146e8645982be195c8fa0d8b8c8))
* **runner:** back off active input retries ([#32028](https://github.com/vm0-ai/vm0/issues/32028)) ([7e7e055](https://github.com/vm0-ai/vm0/commit/7e7e0551b8cc787637f0d780d06581bd34001aaa))

## [0.186.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.186.7...runner-rs-v0.186.8) (2026-09-06)

## [0.186.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.186.6...runner-rs-v0.186.7) (2026-09-06)

## [0.186.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.186.5...runner-rs-v0.186.6) (2026-09-06)

## [0.186.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.186.4...runner-rs-v0.186.5) (2026-09-05)

## [0.186.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.186.3...runner-rs-v0.186.4) (2026-09-05)

## [0.186.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.186.2...runner-rs-v0.186.3) (2026-09-05)


### Bug Fixes

* **runner:** preserve literal systemd service paths ([#31916](https://github.com/vm0-ai/vm0/issues/31916)) ([90002fa](https://github.com/vm0-ai/vm0/commit/90002fa6beb4402428b2bd75cef85ee1e7cb7270))
* **runner:** reject non-http pi model base urls ([#31875](https://github.com/vm0-ai/vm0/issues/31875)) ([99e7d8a](https://github.com/vm0-ai/vm0/commit/99e7d8a78d65f9be528b400b005a9cd9329e3786))


### Refactoring

* **pi-memory:** publish phase 2 through sandbox checkpoints ([#31912](https://github.com/vm0-ai/vm0/issues/31912)) ([57ba1c3](https://github.com/vm0-ai/vm0/commit/57ba1c398f21dc34348bf0c6f20d12cd88283b7f))

## [0.186.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.186.1...runner-rs-v0.186.2) (2026-09-05)


### Bug Fixes

* **presentation:** make fresh screenshots fast and distinct ([#31921](https://github.com/vm0-ai/vm0/issues/31921)) ([62abfd8](https://github.com/vm0-ai/vm0/commit/62abfd86489bc2c969fcb7d175ca456d69c7764a))

## [0.186.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.186.0...runner-rs-v0.186.1) (2026-09-05)


### Performance Improvements

* **python:** bound zstd frame validation work ([#31874](https://github.com/vm0-ai/vm0/issues/31874)) ([276a68e](https://github.com/vm0-ai/vm0/commit/276a68e7956fd354f3812da92e77a1d02c7d30e7))

## [0.186.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.185.3...runner-rs-v0.186.0) (2026-09-05)


### Features

* **pi:** add dialect-aware fast carrier compatibility ([#31839](https://github.com/vm0-ai/vm0/issues/31839)) ([444bfe5](https://github.com/vm0-ai/vm0/commit/444bfe5a6f04edb5ba3ccbc90a0895e7ca4a44d8))

## [0.185.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.185.2...runner-rs-v0.185.3) (2026-09-05)


### Bug Fixes

* **python:** retry auth.base socket creation failures ([#31774](https://github.com/vm0-ai/vm0/issues/31774)) ([047e57c](https://github.com/vm0-ai/vm0/commit/047e57c3857a9c796b82402f1014378d617a5003))


### Performance Improvements

* **python:** bound request header field count ([#31775](https://github.com/vm0-ai/vm0/issues/31775)) ([f853951](https://github.com/vm0-ai/vm0/commit/f85395197437a514b1c7da21de4276a5edc3b02b))

## [0.185.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.185.1...runner-rs-v0.185.2) (2026-09-04)


### Bug Fixes

* **runner:** apply late fast tier to split websocket usage ([#31766](https://github.com/vm0-ai/vm0/issues/31766)) ([17fef7c](https://github.com/vm0-ai/vm0/commit/17fef7c4e9d315661628a21a1899a94c47281329))
* **runner:** require connector account context at startup ([#31770](https://github.com/vm0-ai/vm0/issues/31770)) ([85edfaf](https://github.com/vm0-ai/vm0/commit/85edfafc9923227b10830e3e77103d4984822701))


### Refactoring

* **agent:** centralize cli framework selector parsing ([#31768](https://github.com/vm0-ai/vm0/issues/31768)) ([b98056f](https://github.com/vm0-ai/vm0/commit/b98056feab6c029fc4de1e61e4dcaf6e4d9fda94))

## [0.185.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.185.0...runner-rs-v0.185.1) (2026-09-04)


### Refactoring

* **python:** centralize runner state marker publication ([#31552](https://github.com/vm0-ai/vm0/issues/31552)) ([69f17fc](https://github.com/vm0-ai/vm0/commit/69f17fcf19f5017a60191a0edafc40dc6ea951ba))

## [0.185.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.184.16...runner-rs-v0.185.0) (2026-09-04)


### Features

* add gpt-6 astra support ([#31558](https://github.com/vm0-ai/vm0/issues/31558)) ([004ea48](https://github.com/vm0-ai/vm0/commit/004ea48590eba7c66af3a9b156e3daba7411793b))


### Bug Fixes

* **chat:** preserve structured runner timeout recovery ([#31711](https://github.com/vm0-ai/vm0/issues/31711)) ([1a6f7d2](https://github.com/vm0-ai/vm0/commit/1a6f7d27e30421af781efa7ac3025e46e39286dd))
* **python:** detect mapping keys in starred calls ([#31584](https://github.com/vm0-ai/vm0/issues/31584)) ([abd4c00](https://github.com/vm0-ai/vm0/commit/abd4c0008fff1890fbc306b36ff2ad35041d06e9))


### Performance Improvements

* **python:** bound resolved auth base validation work ([#31587](https://github.com/vm0-ai/vm0/issues/31587)) ([edba27b](https://github.com/vm0-ai/vm0/commit/edba27bf0926b978b6327b3ec078d2f591d98118))

## [0.184.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.184.15...runner-rs-v0.184.16) (2026-09-04)


### Bug Fixes

* **runner:** centralize gc serialization ([#31671](https://github.com/vm0-ai/vm0/issues/31671)) ([c3dbc79](https://github.com/vm0-ai/vm0/commit/c3dbc79ae6f3c5f11f359621efc4591bffa4c678))
* **runner:** validate shared pi model constraints ([#31604](https://github.com/vm0-ai/vm0/issues/31604)) ([64eddf2](https://github.com/vm0-ai/vm0/commit/64eddf256934747393a2d98636560ca2fad45a6c))

## [0.184.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.184.14...runner-rs-v0.184.15) (2026-09-04)

## [0.184.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.184.13...runner-rs-v0.184.14) (2026-09-03)


### Performance Improvements

* **runner:** expose finalizing reuse miss reasons ([#31490](https://github.com/vm0-ai/vm0/issues/31490)) ([84aed28](https://github.com/vm0-ai/vm0/commit/84aed288b4a36396a53eaaced6bd41e876b8cf96))

## [0.184.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.184.12...runner-rs-v0.184.13) (2026-09-03)


### Refactoring

* **pi:** add dialect-aware credential runtime contract ([#31493](https://github.com/vm0-ai/vm0/issues/31493)) ([9464fb3](https://github.com/vm0-ai/vm0/commit/9464fb3e99138707f242b1fe789cf0e375602973))

## [0.184.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.184.11...runner-rs-v0.184.12) (2026-09-03)


### Performance Improvements

* **runner:** overlap reused archive delivery ([#31480](https://github.com/vm0-ai/vm0/issues/31480)) ([9f7e0d2](https://github.com/vm0-ai/vm0/commit/9f7e0d232cead371148717413f08e0d07b2e9da4))

## [0.184.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.184.10...runner-rs-v0.184.11) (2026-09-03)


### Refactoring

* **python:** centralize platform API URL parsing ([#31467](https://github.com/vm0-ai/vm0/issues/31467)) ([6f4de0a](https://github.com/vm0-ai/vm0/commit/6f4de0a4283aba741648f691092ab84a669d8a35))


### Performance Improvements

* **mitm-addon:** skip parsing canonical chat completion deltas ([#31460](https://github.com/vm0-ai/vm0/issues/31460)) ([7ec84cd](https://github.com/vm0-ai/vm0/commit/7ec84cd49cbf5fc1632c7d65e0f4c48df10717aa))
* **runner:** skip futile finalizing workspace lock wait ([#31479](https://github.com/vm0-ai/vm0/issues/31479)) ([0337ade](https://github.com/vm0-ai/vm0/commit/0337ade98cd47dadc7ce4ab52356e1e69f8439e9))

## [0.184.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.184.9...runner-rs-v0.184.10) (2026-09-03)


### Refactoring

* **runner:** reuse shared gc lock removal ([#31444](https://github.com/vm0-ai/vm0/issues/31444)) ([555d557](https://github.com/vm0-ai/vm0/commit/555d557849b4ba8a46ad7df9005b7b2a1146669e))

## [0.184.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.184.8...runner-rs-v0.184.9) (2026-09-03)


### Bug Fixes

* **guest-agent:** classify oversized codex turn inputs ([#31404](https://github.com/vm0-ai/vm0/issues/31404)) ([8cf7f4b](https://github.com/vm0-ai/vm0/commit/8cf7f4b60fde6c4c8239ff27f27a9cc24e90f124))
* **python:** detect dict constructor pair keys ([#31391](https://github.com/vm0-ai/vm0/issues/31391)) ([b7e93eb](https://github.com/vm0-ai/vm0/commit/b7e93ebb7d3b40f66b86b4343bb831c9d79ac81b))
* **runner:** preserve claimed cancel markers ([#31353](https://github.com/vm0-ai/vm0/issues/31353)) ([0c802aa](https://github.com/vm0-ai/vm0/commit/0c802aae2f7000522665acf9daec33af3a9ee4be))


### CI

* **runner:** synchronize process containment pressure completion ([#31375](https://github.com/vm0-ai/vm0/issues/31375)) ([df32def](https://github.com/vm0-ai/vm0/commit/df32def6943fadc20e18c98888c8cc3f2a709350))


### Documentation

* **mitm-addon:** document SSE end-of-stream callbacks ([#31380](https://github.com/vm0-ai/vm0/issues/31380)) ([d5096da](https://github.com/vm0-ai/vm0/commit/d5096da7ccd23700ecf400a117670c738b9b5996))


### Performance Improvements

* **mitm-addon:** stream oversized firewall path matching ([#31390](https://github.com/vm0-ai/vm0/issues/31390)) ([e57d06d](https://github.com/vm0-ai/vm0/commit/e57d06dd13326f18057786a1a6595cd43483d11e))

## [0.184.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.184.7...runner-rs-v0.184.8) (2026-09-03)

## [0.184.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.184.6...runner-rs-v0.184.7) (2026-09-03)


### Bug Fixes

* **runner:** include legacy timezone links in guest images ([#31295](https://github.com/vm0-ai/vm0/issues/31295)) ([6aa441c](https://github.com/vm0-ai/vm0/commit/6aa441c1d7da92128d98a6d5f95364c7e69cb57b))


### Refactoring

* **rust:** centralize guest binary paths ([#31298](https://github.com/vm0-ai/vm0/issues/31298)) ([73e59f8](https://github.com/vm0-ai/vm0/commit/73e59f8d4d7337226d3143e2ca688e124878372f))

## [0.184.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.184.5...runner-rs-v0.184.6) (2026-09-03)


### Refactoring

* **runtime:** retire vm0 environment ownership wildcard ([#31251](https://github.com/vm0-ai/vm0/issues/31251)) ([0a13b76](https://github.com/vm0-ai/vm0/commit/0a13b762139fbaccae9a3324aab1baed71ca7b22))

## [0.184.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.184.4...runner-rs-v0.184.5) (2026-09-02)


### Refactoring

* **runtime:** reclassify run payload field identifiers ([#31244](https://github.com/vm0-ai/vm0/issues/31244)) ([3b475f2](https://github.com/vm0-ai/vm0/commit/3b475f25121716295b2edcfefe3d4c9143c6d671))
* **runtime:** remove retired working-directory environment tombstone ([#31239](https://github.com/vm0-ai/vm0/issues/31239)) ([9fbce0e](https://github.com/vm0-ai/vm0/commit/9fbce0e91a45dda92802f927d8a31539876d3f97))

## [0.184.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.184.3...runner-rs-v0.184.4) (2026-09-02)


### Refactoring

* **pi:** remove ownership transfer capability marker ([#31216](https://github.com/vm0-ai/vm0/issues/31216)) ([fb22db1](https://github.com/vm0-ai/vm0/commit/fb22db17eca15ebfcd5479388ff9a163be0ef500))

## [0.184.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.184.2...runner-rs-v0.184.3) (2026-09-02)


### Bug Fixes

* **runner:** report authoritative provider failure reasons ([#31163](https://github.com/vm0-ai/vm0/issues/31163)) ([b84e233](https://github.com/vm0-ai/vm0/commit/b84e2334f9e370b59a299b00250fc037d90538dd))


### Refactoring

* **runtime:** remove retired API URL alias tombstones ([#31209](https://github.com/vm0-ai/vm0/issues/31209)) ([e57170e](https://github.com/vm0-ai/vm0/commit/e57170e30c73c68188ce035caba4176874e716c2))

## [0.184.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.184.1...runner-rs-v0.184.2) (2026-09-02)


### Documentation

* **mitm-addon:** clarify Anthropic SSE callback gating ([#31146](https://github.com/vm0-ai/vm0/issues/31146)) ([7918adb](https://github.com/vm0-ai/vm0/commit/7918adba36c3ae21d85ad412ee61f0ea3924c293))


### Refactoring

* **rust:** share run artifact payload contract ([#31153](https://github.com/vm0-ai/vm0/issues/31153)) ([16c79bb](https://github.com/vm0-ai/vm0/commit/16c79bb75648f4b2def7b28ae0b1aadff326941c))


### Performance Improvements

* **runner:** batch idle pressure eviction ([#31165](https://github.com/vm0-ai/vm0/issues/31165)) ([aefdda8](https://github.com/vm0-ai/vm0/commit/aefdda825cc0b70e97386a2d17eb8d99f0bbc882))

## [0.184.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.184.0...runner-rs-v0.184.1) (2026-09-02)


### Bug Fixes

* **python:** stop starred tails changing fixed first arguments ([#31131](https://github.com/vm0-ai/vm0/issues/31131)) ([6839ddc](https://github.com/vm0-ai/vm0/commit/6839ddc43e8ad32d5f71278cb1dce435558e7eec))


### Refactoring

* **runner:** remove model usage observation reporting ([#31091](https://github.com/vm0-ai/vm0/issues/31091)) ([54cc2d9](https://github.com/vm0-ai/vm0/commit/54cc2d9f2c38fb3f9fb7d4715b1f869d78561488))


### Performance Improvements

* **python:** scan proxy connect headers incrementally ([#31120](https://github.com/vm0-ai/vm0/issues/31120)) ([cb2ae6d](https://github.com/vm0-ai/vm0/commit/cb2ae6d2ba9d5c9e24929e899d1ac741e4aa72f5))
* **runner:** bound session history sidecar exports ([#31115](https://github.com/vm0-ai/vm0/issues/31115)) ([b5bf5b9](https://github.com/vm0-ai/vm0/commit/b5bf5b9154ac85edf3b928bd9a1f627fe2b07a6a))
* **runner:** expand fresh delivery scan to 64 ([#31127](https://github.com/vm0-ai/vm0/issues/31127)) ([2440591](https://github.com/vm0-ai/vm0/commit/2440591c9e338e8dfd96e5729e9b46d495788146))

## [0.184.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.183.4...runner-rs-v0.184.0) (2026-09-02)


### Features

* **runner:** isolate firecracker guests in weighted cgroups ([#31057](https://github.com/vm0-ai/vm0/issues/31057)) ([615235d](https://github.com/vm0-ai/vm0/commit/615235d8dd5475cdaafec5eead7209bb28ba18fc))


### Bug Fixes

* **python:** enforce inline firewall api lists ([#31089](https://github.com/vm0-ai/vm0/issues/31089)) ([fc1a3a0](https://github.com/vm0-ai/vm0/commit/fc1a3a0c57e2b90ca3c8c10ba548bad37c41d9d9))
* **runner:** classify peer certificate serial warning as info ([#31082](https://github.com/vm0-ai/vm0/issues/31082)) ([513e421](https://github.com/vm0-ai/vm0/commit/513e421230e08ed665d0c9295e08637bf73a9713))


### Refactoring

* **python:** centralize model-provider usage reporting fixtures ([#31070](https://github.com/vm0-ai/vm0/issues/31070)) ([ef6365d](https://github.com/vm0-ai/vm0/commit/ef6365d70544dcd62145d6df246bc35e72b5224c))

## [0.183.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.183.3...runner-rs-v0.183.4) (2026-09-02)

## [0.183.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.183.2...runner-rs-v0.183.3) (2026-09-02)


### Documentation

* **runner:** document job discovery admission ownership ([#31029](https://github.com/vm0-ai/vm0/issues/31029)) ([29e82e5](https://github.com/vm0-ai/vm0/commit/29e82e53a22e3a8b41ea7c5600c3c90c6f063ecb))
* **runner:** document the run cancellation protocol ([#31035](https://github.com/vm0-ai/vm0/issues/31035)) ([1e27593](https://github.com/vm0-ai/vm0/commit/1e27593c4c9cc849989e11378207fbd45d718d8a))


### Refactoring

* **runner:** make firecracker process identity canonical ([#31024](https://github.com/vm0-ai/vm0/issues/31024)) ([36e5fdc](https://github.com/vm0-ai/vm0/commit/36e5fdcb8ec4ad9d853150071953a85d3eba4887))

## [0.183.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.183.1...runner-rs-v0.183.2) (2026-09-02)

## [0.183.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.183.0...runner-rs-v0.183.1) (2026-09-02)


### Bug Fixes

* **python:** reject invalid utf-8 catalog versions ([#30979](https://github.com/vm0-ai/vm0/issues/30979)) ([c76170d](https://github.com/vm0-ai/vm0/commit/c76170d52b7f96015d8b6c7223c8d54ab0f6764f))


### Documentation

* **python:** correct the connector parser Brotli contract ([#30977](https://github.com/vm0-ai/vm0/issues/30977)) ([8d3e0e2](https://github.com/vm0-ai/vm0/commit/8d3e0e23123386fc0f0772812870d92fda931408))

## [0.183.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.182.13...runner-rs-v0.183.0) (2026-09-02)


### Features

* **runner:** reserve cpu admission headroom ([#30905](https://github.com/vm0-ai/vm0/issues/30905)) ([59a9cd5](https://github.com/vm0-ai/vm0/commit/59a9cd534c1ab122b6c6332c8db9f4e0462a76a2))


### Bug Fixes

* **runner:** fail closed on unavailable mountinfo ([#30904](https://github.com/vm0-ai/vm0/issues/30904)) ([0296ae5](https://github.com/vm0-ai/vm0/commit/0296ae5067276d4c37d1a4c0076c403a576f338d))

## [0.182.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.182.12...runner-rs-v0.182.13) (2026-09-01)


### Performance Improvements

* **runner:** specialize reused codex cleanup lifecycle ([#30888](https://github.com/vm0-ai/vm0/issues/30888)) ([5941c94](https://github.com/vm0-ai/vm0/commit/5941c9474fb6f1389a6ca9d3c92e99a3af59b98a))

## [0.182.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.182.11...runner-rs-v0.182.12) (2026-09-01)


### Bug Fixes

* **runner:** fail closed on incomplete config image refs ([#30864](https://github.com/vm0-ai/vm0/issues/30864)) ([12c40b1](https://github.com/vm0-ai/vm0/commit/12c40b1007d66e3dd7fc0584a82091fa1f754c03))

## [0.182.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.182.10...runner-rs-v0.182.11) (2026-09-01)


### Bug Fixes

* retain heartbeat control-path diagnostics ([#30849](https://github.com/vm0-ai/vm0/issues/30849)) ([8ee4d2d](https://github.com/vm0-ai/vm0/commit/8ee4d2d6043a5e15173ace032347366645c254b1))


### Refactoring

* **python:** share bounded zlib member decoding ([#30859](https://github.com/vm0-ai/vm0/issues/30859)) ([77c59e3](https://github.com/vm0-ai/vm0/commit/77c59e30ff45033fbc7e537a55dc491ca3f25d6d))

## [0.182.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.182.9...runner-rs-v0.182.10) (2026-09-01)


### Bug Fixes

* **runner:** recheck firecracker warnings by stable identity ([#30844](https://github.com/vm0-ai/vm0/issues/30844)) ([77ab680](https://github.com/vm0-ai/vm0/commit/77ab6800c311aef9d3b207346ce987be7ff8b02b))


### Documentation

* **mitm-addon:** document flow metadata key linter ([#30836](https://github.com/vm0-ai/vm0/issues/30836)) ([4193c47](https://github.com/vm0-ai/vm0/commit/4193c4773e5088d795bc8281ffa975ff940c5b1d))

## [0.182.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.182.8...runner-rs-v0.182.9) (2026-09-01)


### Refactoring

* **runner:** remove legacy rootfs lock bridge ([#30815](https://github.com/vm0-ai/vm0/issues/30815)) ([6630ad1](https://github.com/vm0-ai/vm0/commit/6630ad14ec0dab594b8744fca483e35fc2941925))

## [0.182.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.182.7...runner-rs-v0.182.8) (2026-09-01)

## [0.182.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.182.6...runner-rs-v0.182.7) (2026-09-01)


### Bug Fixes

* **python:** report zstd model json failures ([#30780](https://github.com/vm0-ai/vm0/issues/30780)) ([75ca6c4](https://github.com/vm0-ai/vm0/commit/75ca6c4ad4c99e112ba77d9fc3c2578f25bde72f))

## [0.182.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.182.5...runner-rs-v0.182.6) (2026-09-01)


### Documentation

* **python:** document confirmed WebSocket response validation ([#30737](https://github.com/vm0-ai/vm0/issues/30737)) ([18c1f56](https://github.com/vm0-ai/vm0/commit/18c1f56367b0d2199aa6cada97decfcdf3e67ac7))
* **python:** document WebSocket framing bounds and lifecycle contract ([#30738](https://github.com/vm0-ai/vm0/issues/30738)) ([f05213b](https://github.com/vm0-ai/vm0/commit/f05213b4127b10ef285b096b22d23b20f7975a64))


### Refactoring

* **rust:** share environment-key diagnostic sanitizer ([#30750](https://github.com/vm0-ai/vm0/issues/30750)) ([d7d08f2](https://github.com/vm0-ai/vm0/commit/d7d08f2b128021bf9ee3a6d352fffc1c344c5f5d))

## [0.182.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.182.4...runner-rs-v0.182.5) (2026-09-01)


### Refactoring

* **runtime:** require canonical platform environment ([#30728](https://github.com/vm0-ai/vm0/issues/30728)) ([aaf4999](https://github.com/vm0-ai/vm0/commit/aaf49990f7b94eca4615242555bbf131986373cb))

## [0.182.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.182.3...runner-rs-v0.182.4) (2026-09-01)


### Bug Fixes

* **python:** reject malformed platform api urls ([#30691](https://github.com/vm0-ai/vm0/issues/30691)) ([2e41afd](https://github.com/vm0-ai/vm0/commit/2e41afd6a2d32bc03d526a602840c624f7ff295a))

## [0.182.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.182.2...runner-rs-v0.182.3) (2026-09-01)


### Performance Improvements

* **runner:** launch reuse identity verifier without shell ([#30644](https://github.com/vm0-ai/vm0/issues/30644)) ([3ea790e](https://github.com/vm0-ai/vm0/commit/3ea790e5a8bca85854debfe537a89a66c4520445))

## [0.182.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.182.1...runner-rs-v0.182.2) (2026-09-01)


### Refactoring

* **runner:** retire operator environment aliases ([#30615](https://github.com/vm0-ai/vm0/issues/30615)) ([3e19b65](https://github.com/vm0-ai/vm0/commit/3e19b65f258ea31fcf143e84fdb81c67726f190c))

## [0.182.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.182.0...runner-rs-v0.182.1) (2026-08-31)


### Bug Fixes

* **runner:** treat systemd daemon-reload notice as advisory ([#30649](https://github.com/vm0-ai/vm0/issues/30649)) ([1efe6ba](https://github.com/vm0-ai/vm0/commit/1efe6ba13679f181a41caea9c52e7926695220d8))

## [0.182.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.181.0...runner-rs-v0.182.0) (2026-08-31)


### Features

* **runner:** attribute resource budget occupancy ([#30625](https://github.com/vm0-ai/vm0/issues/30625)) ([8a47886](https://github.com/vm0-ai/vm0/commit/8a478861b73da1995caf8e24dbb54c130c156970))

## [0.181.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.180.0...runner-rs-v0.181.0) (2026-08-31)


### Features

* **pi:** add versioned sandbox ownership transfers ([#30607](https://github.com/vm0-ai/vm0/issues/30607)) ([dbc4e02](https://github.com/vm0-ai/vm0/commit/dbc4e02e9360749162d2bcf3fd1726f12a8e521f))


### Performance Improvements

* **runner:** measure session identity reuse verification ([#30619](https://github.com/vm0-ai/vm0/issues/30619)) ([a982b33](https://github.com/vm0-ai/vm0/commit/a982b33938dd7c44a1471006d8e0afadc3f8dd27))

## [0.180.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.179.2...runner-rs-v0.180.0) (2026-08-31)


### Features

* **runner:** attribute claim response headers ([#30511](https://github.com/vm0-ai/vm0/issues/30511)) ([bdc7c7a](https://github.com/vm0-ai/vm0/commit/bdc7c7a9d6c77008dff6b078087ab2aad9e53ffb))


### Bug Fixes

* **python:** lint unbound metadata bulk updates ([#30543](https://github.com/vm0-ai/vm0/issues/30543)) ([fcf0954](https://github.com/vm0-ai/vm0/commit/fcf09545e41688e435edc66feeab9e9501e3dc5d))
* **python:** lint unbound metadata membership calls ([#30512](https://github.com/vm0-ai/vm0/issues/30512)) ([dfb7dd4](https://github.com/vm0-ai/vm0/commit/dfb7dd4486846bbd96c6b540f9324755be463aa0))
* **python:** preserve capture fields on connection errors ([#30496](https://github.com/vm0-ai/vm0/issues/30496)) ([a02f39b](https://github.com/vm0-ai/vm0/commit/a02f39b737c84ee1f8d37cf6ea8a1d4c37e862ca))
* **runner:** retry unpublished status snapshots ([#30500](https://github.com/vm0-ai/vm0/issues/30500)) ([2e4287c](https://github.com/vm0-ai/vm0/commit/2e4287c67325191e37e11dc2563319cac7fa2461))


### Refactoring

* **runner:** bridge legacy and canonical rootfs locks ([#30515](https://github.com/vm0-ai/vm0/issues/30515)) ([3fa8c35](https://github.com/vm0-ai/vm0/commit/3fa8c35d0caff25b270b84a1a9e2f250264b990b))

## [0.179.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.179.1...runner-rs-v0.179.2) (2026-08-31)


### Bug Fixes

* **runner:** preserve exact-reuse timezone outcomes ([#30470](https://github.com/vm0-ai/vm0/issues/30470)) ([e5a37ee](https://github.com/vm0-ai/vm0/commit/e5a37ee36ae946feb2f606d868b5de64e6e49180))
* **runner:** reject unrepresentable wait-running timeouts ([#30465](https://github.com/vm0-ai/vm0/issues/30465)) ([3d07b64](https://github.com/vm0-ai/vm0/commit/3d07b64b39dce87f13e6cd774690b72b8b9da28c))

## [0.179.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.179.0...runner-rs-v0.179.1) (2026-08-31)


### Bug Fixes

* **runner:** reject cleartext remote api urls ([#30430](https://github.com/vm0-ai/vm0/issues/30430)) ([197a456](https://github.com/vm0-ai/vm0/commit/197a4560f15f274fddaaf53336238dee327385aa))


### Documentation

* **python:** update stale model-provider usage integration path ([#30424](https://github.com/vm0-ai/vm0/issues/30424)) ([5e356f8](https://github.com/vm0-ai/vm0/commit/5e356f88a12d1478581793fd655fe69db816fcc6))
* **runner:** document best-effort GC directory stats ([#30439](https://github.com/vm0-ai/vm0/issues/30439)) ([6da865a](https://github.com/vm0-ai/vm0/commit/6da865a894763042b9d6e043e7f74df70c15622a))


### Performance Improvements

* **python:** avoid duplicate metadata contract scan ([#30459](https://github.com/vm0-ai/vm0/issues/30459)) ([ef201e0](https://github.com/vm0-ai/vm0/commit/ef201e07c15a20156a995e6db8080d7e36919ba8))

## [0.179.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.178.14...runner-rs-v0.179.0) (2026-08-31)


### Features

* **runner:** report operator environment alias states ([#30428](https://github.com/vm0-ai/vm0/issues/30428)) ([e2ea6c3](https://github.com/vm0-ai/vm0/commit/e2ea6c38eaab2a9eb67d2f61ee4b674ffa4a8d38))

## [0.178.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.178.13...runner-rs-v0.178.14) (2026-08-31)


### Bug Fixes

* **runner:** report only fail-closed response encoding risk ([#30385](https://github.com/vm0-ai/vm0/issues/30385)) ([de3e772](https://github.com/vm0-ai/vm0/commit/de3e7722b447ff4f0f9831ac43cb9dd6582c6cc6))

## [0.178.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.178.12...runner-rs-v0.178.13) (2026-08-31)


### Performance Improvements

* **python:** avoid omitted connector union allocation ([#30371](https://github.com/vm0-ai/vm0/issues/30371)) ([1e4a29d](https://github.com/vm0-ai/vm0/commit/1e4a29dc1433797553a968e4b4a2526a154b41c9))

## [0.178.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.178.11...runner-rs-v0.178.12) (2026-08-30)

## [0.178.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.178.10...runner-rs-v0.178.11) (2026-08-30)


### Bug Fixes

* **mitm-addon:** accept zero-digit qvalue fractions ([#30343](https://github.com/vm0-ai/vm0/issues/30343)) ([3692cc8](https://github.com/vm0-ai/vm0/commit/3692cc86acf5b11b2313d73280b53dfa15a67ccc))

## [0.178.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.178.9...runner-rs-v0.178.10) (2026-08-30)

## [0.178.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.178.8...runner-rs-v0.178.9) (2026-08-30)


### Refactoring

* **guest:** retire api token legacy reader ([#30292](https://github.com/vm0-ai/vm0/issues/30292)) ([7d0c3ad](https://github.com/vm0-ai/vm0/commit/7d0c3ad45d1361c0ee6463f8cc46feb00780e8f4))
* **guest:** retire execution timeout legacy reader ([#30301](https://github.com/vm0-ai/vm0/issues/30301)) ([e5fba4b](https://github.com/vm0-ai/vm0/commit/e5fba4b8fa0ed5c1a769e71ac40053798c08abd7)), closes [#30289](https://github.com/vm0-ai/vm0/issues/30289) [#28914](https://github.com/vm0-ai/vm0/issues/28914)
* **guest:** retire private payload legacy readers ([#30307](https://github.com/vm0-ai/vm0/issues/30307)) ([1059893](https://github.com/vm0-ai/vm0/commit/10598930135c5e6def894ae799064a5ef794d2c1))

## [0.178.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.178.7...runner-rs-v0.178.8) (2026-08-30)


### Documentation

* **runner:** document DNS readiness log observation semantics ([#30260](https://github.com/vm0-ai/vm0/issues/30260)) ([bb1a3d0](https://github.com/vm0-ai/vm0/commit/bb1a3d0e74e42dd40585ad4fe9826b5af42206cf))
* **runner:** document workspace image cache path scoping ([#30259](https://github.com/vm0-ai/vm0/issues/30259)) ([9730128](https://github.com/vm0-ai/vm0/commit/9730128f7b480b926f1411b6713e9d93d0fd9a39))


### Refactoring

* **runner:** retire legacy host tuning aliases ([#30288](https://github.com/vm0-ai/vm0/issues/30288)) ([70cf673](https://github.com/vm0-ai/vm0/commit/70cf673d14daf635722134724ad281b6224e068b))

## [0.178.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.178.6...runner-rs-v0.178.7) (2026-08-29)


### Bug Fixes

* **runner:** fail closed on unit state query errors ([#30254](https://github.com/vm0-ai/vm0/issues/30254)) ([2659674](https://github.com/vm0-ai/vm0/commit/26596740185c3ba13f7c02036a202f887d262307))
* **runner:** resolve service state from selected config ([#30242](https://github.com/vm0-ai/vm0/issues/30242)) ([04103da](https://github.com/vm0-ai/vm0/commit/04103da93c682e0793c03a0496a1b2338740389e))


### Refactoring

* **runner:** retire legacy service lock compatibility ([#30255](https://github.com/vm0-ai/vm0/issues/30255)) ([cd750bb](https://github.com/vm0-ai/vm0/commit/cd750bb3adb8eb080ccf8579bc80ce034a3e0abe))

## [0.178.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.178.5...runner-rs-v0.178.6) (2026-08-29)


### Performance Improvements

* **runner:** aggregate model observations across jobs ([#30183](https://github.com/vm0-ai/vm0/issues/30183)) ([3a4b21b](https://github.com/vm0-ai/vm0/commit/3a4b21b1e0039aa6f3b26da9520cc0d1ba7d7854))

## [0.178.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.178.4...runner-rs-v0.178.5) (2026-08-29)


### Refactoring

* **runner:** separate addon process logging ([#30206](https://github.com/vm0-ai/vm0/issues/30206)) ([768c48b](https://github.com/vm0-ai/vm0/commit/768c48b7eda2385bf299d2d10eebc42bfe87e2fa))

## [0.178.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.178.3...runner-rs-v0.178.4) (2026-08-29)

## [0.178.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.178.2...runner-rs-v0.178.3) (2026-08-29)


### Refactoring

* **runner:** finish vm-to-sandbox terminology cleanup ([#30171](https://github.com/vm0-ai/vm0/issues/30171)) ([22d9b2e](https://github.com/vm0-ai/vm0/commit/22d9b2ebfdb9f9d3910eb8b30f8d2679aaed3081))
* **runner:** remove legacy mitmdump runtime reader ([#30166](https://github.com/vm0-ai/vm0/issues/30166)) ([45e9dad](https://github.com/vm0-ai/vm0/commit/45e9dad1fa23af2e2645a9b1141fabdaec6cdb2d))

## [0.178.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.178.1...runner-rs-v0.178.2) (2026-08-28)


### Bug Fixes

* **runner:** recover stalled exact-reuse activation ([#30152](https://github.com/vm0-ai/vm0/issues/30152)) ([6ec9789](https://github.com/vm0-ai/vm0/commit/6ec978965ad26902ca425e6eb665c819a8f61477))


### Performance Improvements

* **runner:** launch guest agent without shell bootstrap ([#30153](https://github.com/vm0-ai/vm0/issues/30153)) ([b2409fe](https://github.com/vm0-ai/vm0/commit/b2409fed8caa794a4e7d604f7d4c64559a385737))

## [0.178.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.178.0...runner-rs-v0.178.1) (2026-08-28)


### Documentation

* **runner:** document lock helper semantics ([#30148](https://github.com/vm0-ai/vm0/issues/30148)) ([e9cb031](https://github.com/vm0-ai/vm0/commit/e9cb0311ea76799d8d61df9642735f029dfc4a64))
* **runner:** document storage baseline telemetry semantics ([#30145](https://github.com/vm0-ai/vm0/issues/30145)) ([7389b5c](https://github.com/vm0-ai/vm0/commit/7389b5c4ab12f94b06485b802a255e318ea2d4b8))


### Refactoring

* **rust:** forbid path attributes ([#30129](https://github.com/vm0-ai/vm0/issues/30129)) ([c46da3e](https://github.com/vm0-ai/vm0/commit/c46da3ea8fb48b7595bc582036a1f28a0d676f5f))

## [0.178.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.177.8...runner-rs-v0.178.0) (2026-08-28)


### Features

* **runner:** report host env alias sources ([#30115](https://github.com/vm0-ai/vm0/issues/30115)) ([c186d6b](https://github.com/vm0-ai/vm0/commit/c186d6b93698a43a7510e02e92e8747314cd6e01))
* **runner:** report mitmdump reconciliation sources at startup ([#30133](https://github.com/vm0-ai/vm0/issues/30133)) ([877af7f](https://github.com/vm0-ai/vm0/commit/877af7fc5477a32a58c1aff22d0c2d45a99a8f5d))


### Bug Fixes

* **python:** omit encoding for empty streamed request bodies ([#30139](https://github.com/vm0-ai/vm0/issues/30139)) ([a94e9d8](https://github.com/vm0-ai/vm0/commit/a94e9d8e0bcce0fa42683dec3f3f2be65af0f32d))
* **runner:** handle procfs exit race in mitmdump cleanup ([#30111](https://github.com/vm0-ai/vm0/issues/30111)) ([cb6e740](https://github.com/vm0-ai/vm0/commit/cb6e74099bc60ccc887895714dab1c277f53f1cb))


### Documentation

* **python:** qualify X endpoint pricing mapping guidance ([#30098](https://github.com/vm0-ai/vm0/issues/30098)) ([d5367b4](https://github.com/vm0-ai/vm0/commit/d5367b438887682f832ea0ae75ca248a0bec57cf))


### Refactoring

* **runner:** cut guest API URL writer to canonical alias ([#30105](https://github.com/vm0-ai/vm0/issues/30105)) ([f3bb3c5](https://github.com/vm0-ai/vm0/commit/f3bb3c589879d6782f7942afff00b8e9af242706))


### Performance Improvements

* **runner:** bound snapshot memory prefetch ([#30142](https://github.com/vm0-ai/vm0/issues/30142)) ([f9b9aa2](https://github.com/vm0-ai/vm0/commit/f9b9aa2581f7406ee1d650977c5b5e4cff97798f))

## [0.177.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.177.7...runner-rs-v0.177.8) (2026-08-28)

## [0.177.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.177.6...runner-rs-v0.177.7) (2026-08-28)


### Bug Fixes

* **mitm-addon:** reject uninspectable billable responses ([#30065](https://github.com/vm0-ai/vm0/issues/30065)) ([8ddd437](https://github.com/vm0-ai/vm0/commit/8ddd437fd792b4886231d08b962848b8a420ba7d))


### Refactoring

* **runner:** cut sandbox metadata writers to canonical aliases ([#30066](https://github.com/vm0-ai/vm0/issues/30066)) ([237f6a8](https://github.com/vm0-ai/vm0/commit/237f6a84c78087d2fe9a446f3c9c3d040a3f6365))
* **runner:** translate timing tuning writers to canonical aliases ([#30060](https://github.com/vm0-ai/vm0/issues/30060)) ([44f18e2](https://github.com/vm0-ai/vm0/commit/44f18e290973d5ea8c7cc5f34857e67091c4293b))


### Performance Improvements

* **mitm-addon:** bound x billing unicode label work ([#30059](https://github.com/vm0-ai/vm0/issues/30059)) ([3d8161d](https://github.com/vm0-ai/vm0/commit/3d8161dee6f29f74d4723ee6f535ea0ffeaac004))

## [0.177.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.177.5...runner-rs-v0.177.6) (2026-08-28)


### Refactoring

* **runner:** cut private payload writers to canonical aliases ([#30055](https://github.com/vm0-ai/vm0/issues/30055)) ([edbdda3](https://github.com/vm0-ai/vm0/commit/edbdda3db6a2553bdf047181becbf2f9a170b997))


### Performance Improvements

* **runner:** bound gc service discovery ([#30046](https://github.com/vm0-ai/vm0/issues/30046)) ([0786169](https://github.com/vm0-ai/vm0/commit/0786169689bb80470ff1ea77e9ac3fac02d5ac30))

## [0.177.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.177.4...runner-rs-v0.177.5) (2026-08-28)


### Refactoring

* **runner:** cut api token writer to canonical alias ([#30025](https://github.com/vm0-ai/vm0/issues/30025)) ([0f1af83](https://github.com/vm0-ai/vm0/commit/0f1af83895de4965396672276f0b709f77190f64))
* **runner:** cut execution timeout writer to canonical alias ([#30020](https://github.com/vm0-ai/vm0/issues/30020)) ([89628c1](https://github.com/vm0-ai/vm0/commit/89628c1f22e6441c025a846859036281751776bd))

## [0.177.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.177.3...runner-rs-v0.177.4) (2026-08-28)


### Performance Improvements

* **runner:** batch required private guest writes ([#29943](https://github.com/vm0-ai/vm0/issues/29943)) ([97414e6](https://github.com/vm0-ai/vm0/commit/97414e6c34b2241df1cbcf87fa85fa6248cf41d6))

## [0.177.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.177.2...runner-rs-v0.177.3) (2026-08-28)


### Refactoring

* **guest:** remove legacy mock binary path readers ([#29977](https://github.com/vm0-ai/vm0/issues/29977)) ([95df1fc](https://github.com/vm0-ai/vm0/commit/95df1fce63080ef61656f9d5e76b2c763fd2afdc)), closes [#29973](https://github.com/vm0-ai/vm0/issues/29973) [#28914](https://github.com/vm0-ai/vm0/issues/28914)
* **runner:** cut mitmdump runtime marker writer to canonical alias ([#29944](https://github.com/vm0-ai/vm0/issues/29944)) ([5c160a8](https://github.com/vm0-ai/vm0/commit/5c160a8e361e06cf6587f37ba9c4ae061dc2f139))

## [0.177.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.177.1...runner-rs-v0.177.2) (2026-08-27)


### Bug Fixes

* **runner:** enforce wait-running deadline ([#29920](https://github.com/vm0-ai/vm0/issues/29920)) ([cd0b6fe](https://github.com/vm0-ai/vm0/commit/cd0b6fe6d1315617f0f1af381a33643cd04bd1aa))


### Performance Improvements

* **python:** bound codex catalog query parsing ([#29918](https://github.com/vm0-ai/vm0/issues/29918)) ([a0a061c](https://github.com/vm0-ai/vm0/commit/a0a061c7ffce34599c7a93d11a7997e6bff9d173))

## [0.177.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.177.0...runner-rs-v0.177.1) (2026-08-27)


### Documentation

* **runner:** clarify storage cache GC accounting ([#29904](https://github.com/vm0-ai/vm0/issues/29904)) ([32b1012](https://github.com/vm0-ai/vm0/commit/32b10126b087b293d13f4afdba04d93fb5e66564))


### Refactoring

* **runner:** remove legacy config name contract ([#29893](https://github.com/vm0-ai/vm0/issues/29893)) ([eace6a3](https://github.com/vm0-ai/vm0/commit/eace6a3e439043f31c35dd4f48b85891107c423c))
* **runtime:** cut guest runtime writers to canonical alias ([#29913](https://github.com/vm0-ai/vm0/issues/29913)) ([9a84d60](https://github.com/vm0-ai/vm0/commit/9a84d60ec8d14061f9f17d57e5fda48988b62753)), closes [#29909](https://github.com/vm0-ai/vm0/issues/29909) [#28914](https://github.com/vm0-ai/vm0/issues/28914)
* **rust:** make shared jsonl cli state backend-neutral ([#29895](https://github.com/vm0-ai/vm0/issues/29895)) ([0e0bc69](https://github.com/vm0-ai/vm0/commit/0e0bc69214f2717f37aa27064c1a1f5a1c8ae311))


### Performance Improvements

* **runner:** bound doctor service discovery ([#29902](https://github.com/vm0-ai/vm0/issues/29902)) ([864931b](https://github.com/vm0-ai/vm0/commit/864931b67e3eda88440674c503acedf89d1194bf))

## [0.177.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.176.6...runner-rs-v0.177.0) (2026-08-27)


### Features

* expose agent run execution limit ([#29894](https://github.com/vm0-ai/vm0/issues/29894)) ([25013c9](https://github.com/vm0-ai/vm0/commit/25013c9b24785967397a652765ccea8c866c22b7))


### Bug Fixes

* **python:** report model provider connection sources ([#29889](https://github.com/vm0-ai/vm0/issues/29889)) ([e1c3877](https://github.com/vm0-ai/vm0/commit/e1c3877c8f3a8989f2fdd43d8a1553ed3365c5a5))
* **runner:** bound legacy report retry deadline ([#29892](https://github.com/vm0-ai/vm0/issues/29892)) ([3ca5a65](https://github.com/vm0-ai/vm0/commit/3ca5a65196a7e7a3267a7b7afb794d1e0e03e0d4))
* **rust:** fail closed on nbd owner lookup errors ([#29897](https://github.com/vm0-ai/vm0/issues/29897)) ([96f4511](https://github.com/vm0-ai/vm0/commit/96f451182cd012db06b0c615ee13fd2de0657a33))


### Refactoring

* **runner:** centralize service lock identity ([#29888](https://github.com/vm0-ai/vm0/issues/29888)) ([78f912b](https://github.com/vm0-ai/vm0/commit/78f912b86bedecbc82ae6acd719552e2bf1eb74f))

## [0.176.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.176.5...runner-rs-v0.176.6) (2026-08-27)


### Bug Fixes

* **runner:** await multipart upload cancellation ([#29863](https://github.com/vm0-ai/vm0/issues/29863)) ([29c46bb](https://github.com/vm0-ai/vm0/commit/29c46bb8fbac252a78f30399106a8c8372541789))


### Performance Improvements

* **python:** reuse bounded aws request classification ([#29868](https://github.com/vm0-ai/vm0/issues/29868)) ([325fe42](https://github.com/vm0-ai/vm0/commit/325fe42a89b9425afbb528f562a476f72d740e71))
* **runner:** observe default seed baseline stability ([#29862](https://github.com/vm0-ai/vm0/issues/29862)) ([eca3635](https://github.com/vm0-ai/vm0/commit/eca36351ec7cf90aea1368f025bef26e1500714c))
* **runner:** reuse workspace cache snapshot for heartbeats ([#29864](https://github.com/vm0-ai/vm0/issues/29864)) ([40f5b99](https://github.com/vm0-ai/vm0/commit/40f5b99ac7c2f1651531f9c8769d4e6db9fd2d82))

## [0.176.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.176.4...runner-rs-v0.176.5) (2026-08-27)


### Documentation

* **runner:** document firewall auth cache ownership generations ([#29853](https://github.com/vm0-ai/vm0/issues/29853)) ([5f21b13](https://github.com/vm0-ai/vm0/commit/5f21b13adf3b11f9d119007d13c4fcb1eff835b9))

## [0.176.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.176.3...runner-rs-v0.176.4) (2026-08-27)

## [0.176.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.176.2...runner-rs-v0.176.3) (2026-08-27)


### Bug Fixes

* **python:** reject incomplete zstd capture bodies ([#29713](https://github.com/vm0-ai/vm0/issues/29713)) ([afceba9](https://github.com/vm0-ai/vm0/commit/afceba9e79c878e7492eb4fff38934e5b75019f1))
* **runner:** preserve records on inconclusive procfs reads ([#29760](https://github.com/vm0-ai/vm0/issues/29760)) ([9801832](https://github.com/vm0-ai/vm0/commit/9801832251802aa48b56408f0c2626566a6c0d55))


### Documentation

* **mitm-addon:** document auth.base worker shutdown contract ([#29712](https://github.com/vm0-ai/vm0/issues/29712)) ([f39c657](https://github.com/vm0-ai/vm0/commit/f39c6577d222c273bb49685bb5405f89b896a612))
* **mitm-addon:** document Chat Completions benchmark usage ([#29755](https://github.com/vm0-ai/vm0/issues/29755)) ([cdd7fd2](https://github.com/vm0-ai/vm0/commit/cdd7fd2f750e927cfc2fdd89ad9af9de15e2e015))
* **python:** document shared model json inspection contract ([#29793](https://github.com/vm0-ai/vm0/issues/29793)) ([0bbf2b9](https://github.com/vm0-ai/vm0/commit/0bbf2b93720fb8ad5829bd2240b4ec5d63ad6d6a))


### Refactoring

* **runner:** decouple local identity from config name ([#29797](https://github.com/vm0-ai/vm0/issues/29797)) ([482c364](https://github.com/vm0-ai/vm0/commit/482c364db4b7c816dddad4de51bac72a196b5d05))
* **runner:** establish guest agent readiness ([#29748](https://github.com/vm0-ai/vm0/issues/29748)) ([8eaafa1](https://github.com/vm0-ai/vm0/commit/8eaafa13bc280f08033fded17e7c3fd5c9822804))
* **rust:** avoid duplicating process stream capacity ([#29784](https://github.com/vm0-ai/vm0/issues/29784)) ([30918ec](https://github.com/vm0-ai/vm0/commit/30918ec96e76b1498fded4d16943fa6f005ae1bb))


### Performance Improvements

* **python:** avoid repeated unicode hostname normalization ([#29715](https://github.com/vm0-ai/vm0/issues/29715)) ([05c6ef5](https://github.com/vm0-ai/vm0/commit/05c6ef506b4aeb65ea9f2200741d6ffa22ca079c))
* **python:** cache normalized platform api destination ([#29780](https://github.com/vm0-ai/vm0/issues/29780)) ([f7c8bea](https://github.com/vm0-ai/vm0/commit/f7c8bea65b355f7e9d3f13123e8d2e416476b2ef))
* **python:** retry only pending provider timing states ([#29795](https://github.com/vm0-ai/vm0/issues/29795)) ([9e1da45](https://github.com/vm0-ai/vm0/commit/9e1da455a5f9affbbde9f2ee1366dfcc9b16a18b))

## [0.176.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.176.1...runner-rs-v0.176.2) (2026-08-27)


### Refactoring

* **runner:** stop emitting legacy runner name ([#29680](https://github.com/vm0-ai/vm0/issues/29680)) ([e8bec5e](https://github.com/vm0-ai/vm0/commit/e8bec5ebcecd3e2e3b4b7af5a89cfb9aed804b60))

## [0.176.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.176.0...runner-rs-v0.176.1) (2026-08-26)


### Refactoring

* **runner:** make guest process roles explicit ([#29679](https://github.com/vm0-ai/vm0/issues/29679)) ([fe5d663](https://github.com/vm0-ai/vm0/commit/fe5d663d192a9838dfdf4aecc2ffc8c7a22d24fa))

## [0.176.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.175.1...runner-rs-v0.176.0) (2026-08-26)


### Features

* **pi:** accept dynamic handoff sequence boundaries ([#29636](https://github.com/vm0-ai/vm0/issues/29636)) ([d52059f](https://github.com/vm0-ai/vm0/commit/d52059fb35108354d70078edd84404eae7008647))

## [0.175.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.175.0...runner-rs-v0.175.1) (2026-08-26)


### Documentation

* **runner:** document bounded Axiom shutdown semantics ([#29625](https://github.com/vm0-ai/vm0/issues/29625)) ([b2f6c39](https://github.com/vm0-ai/vm0/commit/b2f6c39e19862e68f33d7b70401611cad9410ff9))

## [0.175.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.174.1...runner-rs-v0.175.0) (2026-08-26)


### Features

* **runner:** publish canonical host attribution ([#29613](https://github.com/vm0-ai/vm0/issues/29613)) ([e023ea6](https://github.com/vm0-ai/vm0/commit/e023ea652c0812574e112ac1cdc6101bc0590022))


### Bug Fixes

* **python:** detect dict.fromkeys keys composed with zip ([#29603](https://github.com/vm0-ai/vm0/issues/29603)) ([9e51c8b](https://github.com/vm0-ai/vm0/commit/9e51c8b0b51ec095457318dcd1a572b4e022d952))
* **python:** preserve jsonl cleanup after reporter failure ([#29601](https://github.com/vm0-ai/vm0/issues/29601)) ([69382ff](https://github.com/vm0-ai/vm0/commit/69382ff125b16d87237d438f1bad2390a65f192e))
* **python:** roll back firewall auth task startup state ([#29604](https://github.com/vm0-ai/vm0/issues/29604)) ([d22e7db](https://github.com/vm0-ai/vm0/commit/d22e7dba65a21353200b9280b467eb765f6802fe))
* **runner:** apply parent-death setup to kmsg monitor ([#29609](https://github.com/vm0-ai/vm0/issues/29609)) ([ddc9ea5](https://github.com/vm0-ai/vm0/commit/ddc9ea589f605fc79a40398f468632a110385395))


### Documentation

* **python:** document buffered response capture decode policy ([#29602](https://github.com/vm0-ai/vm0/issues/29602)) ([30dc571](https://github.com/vm0-ai/vm0/commit/30dc5714d7b9e7a9cef49bafe1d6d64197d65792))

## [0.174.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.174.0...runner-rs-v0.174.1) (2026-08-26)


### Bug Fixes

* **python:** protect refreshed auth cache entries from late 401s ([#29558](https://github.com/vm0-ai/vm0/issues/29558)) ([93385d4](https://github.com/vm0-ai/vm0/commit/93385d438bbf8255655df9acccda12e74c607afc))
* **runner:** report unavailable best-effort timezones ([#29568](https://github.com/vm0-ai/vm0/issues/29568)) ([db27c70](https://github.com/vm0-ai/vm0/commit/db27c7048a1146dcaf02d363f86d5da7833df543))


### Documentation

* **python:** document firewall rule specificity ordering ([#29554](https://github.com/vm0-ai/vm0/issues/29554)) ([59824da](https://github.com/vm0-ai/vm0/commit/59824dae7a6c95cb6f7747989502dcd3c0a44d0f))


### Refactoring

* **python:** avoid caching resolved auth base urls ([#29570](https://github.com/vm0-ai/vm0/issues/29570)) ([eefb22f](https://github.com/vm0-ai/vm0/commit/eefb22fec3eec66d587725be23db419d739ab038))


### Performance Improvements

* **runner:** bound mitmdump log record buffering ([#29560](https://github.com/vm0-ai/vm0/issues/29560)) ([12d6dd6](https://github.com/vm0-ai/vm0/commit/12d6dd6616c22a340a89904314b13f489ba81dc4))

## [0.174.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.173.12...runner-rs-v0.174.0) (2026-08-26)


### Features

* **cli:** show connector accounts used by current run ([#29523](https://github.com/vm0-ai/vm0/issues/29523)) ([3d1ce4e](https://github.com/vm0-ai/vm0/commit/3d1ce4e549aa7a2405aa83d76e6794a0f4f4f587))


### Documentation

* **python:** document network-log capture sanitization contract ([#29520](https://github.com/vm0-ai/vm0/issues/29520)) ([d045922](https://github.com/vm0-ai/vm0/commit/d04592238dab57c39fcaf70e946234c482b6bb71))


### Performance Improvements

* **runner:** bound axiom textual fields before queueing ([#29522](https://github.com/vm0-ai/vm0/issues/29522)) ([65cc652](https://github.com/vm0-ai/vm0/commit/65cc65243f9d49f689e51ee7ccc61dfabdd6dfb6))

## [0.173.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.173.11...runner-rs-v0.173.12) (2026-08-26)


### Bug Fixes

* **runner:** reconcile cache watches past irrelevant entries ([#29499](https://github.com/vm0-ai/vm0/issues/29499)) ([403a2a5](https://github.com/vm0-ai/vm0/commit/403a2a5a93ff7ecfce40b202389d092759921d0b))
* **runner:** reject stale host oom evidence ([#29501](https://github.com/vm0-ai/vm0/issues/29501)) ([1110a2b](https://github.com/vm0-ai/vm0/commit/1110a2b176a46bd56deb3fd7b8a7cdd7ce811756))


### Documentation

* **python:** document connector runtime ownership resolution ([#29493](https://github.com/vm0-ai/vm0/issues/29493)) ([99356a9](https://github.com/vm0-ai/vm0/commit/99356a975a9a90da28eec2af3d74beea1979cb0d))
* **python:** document state-file validation boundaries ([#29500](https://github.com/vm0-ai/vm0/issues/29500)) ([ff03706](https://github.com/vm0-ai/vm0/commit/ff03706effb990006f8aebaf699d8b36e2465383))

## [0.173.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.173.10...runner-rs-v0.173.11) (2026-08-26)


### Performance Improvements

* scope connector runtime refresh catalog loads ([#29471](https://github.com/vm0-ai/vm0/issues/29471)) ([d8ebf8a](https://github.com/vm0-ai/vm0/commit/d8ebf8a06a25ced82d02bfed54baf230ff17e72c))

## [0.173.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.173.9...runner-rs-v0.173.10) (2026-08-26)


### Bug Fixes

* **vsock:** bound file write response waits ([#29455](https://github.com/vm0-ai/vm0/issues/29455)) ([f9d9692](https://github.com/vm0-ai/vm0/commit/f9d9692d06e8f9574d2888397e0ab38ec2adc029))

## [0.173.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.173.8...runner-rs-v0.173.9) (2026-08-26)


### Bug Fixes

* **python:** fail closed on request hook exceptions ([#29452](https://github.com/vm0-ai/vm0/issues/29452)) ([efe7776](https://github.com/vm0-ai/vm0/commit/efe77769fac19ae1296c4f83a6050c6196e5c90f))
* **runner:** increase default rootfs headroom ([#29445](https://github.com/vm0-ai/vm0/issues/29445)) ([10d3864](https://github.com/vm0-ai/vm0/commit/10d38642697e25f45ede5b024d778d20af5f19d8))


### Documentation

* **python:** document model-observation buffer semantics ([#29426](https://github.com/vm0-ai/vm0/issues/29426)) ([fea30c2](https://github.com/vm0-ai/vm0/commit/fea30c27192abef62cfff0a8978a690e15424760))


### Performance Improvements

* **runner:** stop commands on semantic stdout overflow ([#29450](https://github.com/vm0-ai/vm0/issues/29450)) ([e15ed04](https://github.com/vm0-ai/vm0/commit/e15ed04ea1cb274a9c63eacc526895db4d838318))

## [0.173.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.173.7...runner-rs-v0.173.8) (2026-08-26)


### Performance Improvements

* **runner:** specialize guest state restore operation ([#29398](https://github.com/vm0-ai/vm0/issues/29398)) ([89521f7](https://github.com/vm0-ai/vm0/commit/89521f769af74c43034f04e5f7decc537ebff628))

## [0.173.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.173.6...runner-rs-v0.173.7) (2026-08-25)

## [0.173.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.173.5...runner-rs-v0.173.6) (2026-08-25)

## [0.173.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.173.4...runner-rs-v0.173.5) (2026-08-25)


### Refactoring

* **guest-agent:** dual-read api backend url aliases ([#29369](https://github.com/vm0-ai/vm0/issues/29369)) ([84295ac](https://github.com/vm0-ai/vm0/commit/84295ac0c3d66185b90d59fc6afa3f79903aac9a))

## [0.173.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.173.3...runner-rs-v0.173.4) (2026-08-25)


### Bug Fixes

* **mitm-addon:** preserve path base precedence ([#29352](https://github.com/vm0-ai/vm0/issues/29352)) ([19a1657](https://github.com/vm0-ai/vm0/commit/19a16573e9fbd2cd1860eaf032a1edaad511b74a))
* **python:** settle websocket prewarm after usage errors ([#29347](https://github.com/vm0-ai/vm0/issues/29347)) ([2680f20](https://github.com/vm0-ai/vm0/commit/2680f2078be89e365bd5ba7fd9a2894649fd1746))


### Refactoring

* **guest-agent:** dual-read tuning environment aliases ([#29329](https://github.com/vm0-ai/vm0/issues/29329)) ([d5dbae8](https://github.com/vm0-ai/vm0/commit/d5dbae8abbb4141eb10bb22ab3a8d588628b1e7c))
* **python:** centralize upstream binding resolution ([#29345](https://github.com/vm0-ai/vm0/issues/29345)) ([3444174](https://github.com/vm0-ai/vm0/commit/3444174fbb9cc5c60ad9337751944fa8c6d8d40a))

## [0.173.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.173.2...runner-rs-v0.173.3) (2026-08-25)


### Performance Improvements

* **runner:** aggregate routine gc logs ([#29328](https://github.com/vm0-ai/vm0/issues/29328)) ([d26c53e](https://github.com/vm0-ai/vm0/commit/d26c53e7767c5444961cd67c79950b34e6e240a2))
* **runner:** expand fresh archive delivery scan ([#29313](https://github.com/vm0-ai/vm0/issues/29313)) ([fbb7a4a](https://github.com/vm0-ai/vm0/commit/fbb7a4a7a8907254b9b98592cd4f5c8f18051edf))

## [0.173.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.173.1...runner-rs-v0.173.2) (2026-08-25)


### Bug Fixes

* **runner:** tolerate missing physical cpu topology ([#29275](https://github.com/vm0-ai/vm0/issues/29275)) ([c49f7a2](https://github.com/vm0-ai/vm0/commit/c49f7a22f456287043ad69c4169761112d2968d8))


### Documentation

* **python:** clarify bounded JSON probe prefix contract ([#29284](https://github.com/vm0-ai/vm0/issues/29284)) ([#29300](https://github.com/vm0-ai/vm0/issues/29300)) ([6d9b1c1](https://github.com/vm0-ai/vm0/commit/6d9b1c122b667a49ce1b9c6c1637bd3358fff329))
* **python:** document HTTP header helper contracts ([#29298](https://github.com/vm0-ai/vm0/issues/29298)) ([f4c9c67](https://github.com/vm0-ai/vm0/commit/f4c9c67713c3a0ff588123b805f5afb3207f81e7))


### Performance Improvements

* **python:** batch resolved auth header injection ([#29301](https://github.com/vm0-ai/vm0/issues/29301)) ([5cd1219](https://github.com/vm0-ai/vm0/commit/5cd1219e314cf2dc1b2b851f967bb173f9a76b74))

## [0.173.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.173.0...runner-rs-v0.173.1) (2026-08-25)


### Refactoring

* **python:** centralize positive-wins model usage updates ([#29236](https://github.com/vm0-ai/vm0/issues/29236)) ([8c77617](https://github.com/vm0-ai/vm0/commit/8c77617894ee95a6977fb24914070392d76dc4e7))
* **python:** reuse shared http server in x tld redirect test ([#29252](https://github.com/vm0-ai/vm0/issues/29252)) ([c26835d](https://github.com/vm0-ai/vm0/commit/c26835df8e932fb7616d82a97fe05f404e4f7c8b))
* **runner:** reuse raw http fixture in storage tests ([#29245](https://github.com/vm0-ai/vm0/issues/29245)) ([9c6dcb0](https://github.com/vm0-ai/vm0/commit/9c6dcb02a99d3b7726d70e214e1eb9dd70eba91a))

## [0.173.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.172.0...runner-rs-v0.173.0) (2026-08-25)


### Features

* **api:** add strict pi api first-turn handoff ([#28664](https://github.com/vm0-ai/vm0/issues/28664)) ([4bc9ef0](https://github.com/vm0-ai/vm0/commit/4bc9ef063e244a3f3af8dbc9ab94fd173208b93c))
* **runner:** report trusted model provider failures ([#28532](https://github.com/vm0-ai/vm0/issues/28532)) ([95a6ecd](https://github.com/vm0-ai/vm0/commit/95a6ecd44582d3bedf35b97f6874a01f2d7c6a34))


### Bug Fixes

* **events:** preserve timeout and connect observations ([#28397](https://github.com/vm0-ai/vm0/issues/28397)) ([c3d536e](https://github.com/vm0-ai/vm0/commit/c3d536eab61fca8e2006a7664a982b993537db00))
* **guest-agent:** classify mid-response failures ([#28393](https://github.com/vm0-ai/vm0/issues/28393)) ([4ca21bd](https://github.com/vm0-ai/vm0/commit/4ca21bdbe47a2ce99f34c343b074f83c45775483))
* **guest-agent:** keep claude appended prompts out of argv ([#28838](https://github.com/vm0-ai/vm0/issues/28838)) ([0bd96d6](https://github.com/vm0-ai/vm0/commit/0bd96d69d6b9121e37232080a35111550f709424))
* **guest:** isolate managed claude config from user home ([#28324](https://github.com/vm0-ai/vm0/issues/28324)) ([c6a20ba](https://github.com/vm0-ai/vm0/commit/c6a20babf5f75ffac7ac97f69c570ba1ddb2ef23))
* **python:** bound request header name work ([#28342](https://github.com/vm0-ai/vm0/issues/28342)) ([ffcd0fa](https://github.com/vm0-ai/vm0/commit/ffcd0fa83312ab7f20ed517ba717ee01721fca28))
* **python:** clamp managed provider retry-after delays ([#28652](https://github.com/vm0-ai/vm0/issues/28652)) ([525dd58](https://github.com/vm0-ai/vm0/commit/525dd588b1cef082c5ced8e419e07e73c469b1de))
* **python:** classify openrouter 500 responses by body ([#28644](https://github.com/vm0-ai/vm0/issues/28644)) ([16bd0b2](https://github.com/vm0-ai/vm0/commit/16bd0b2bca552eee731b7d53cfedf5475b9b5bf3))
* **python:** drain retained diagnostics after webhook shutdown ([#28981](https://github.com/vm0-ai/vm0/issues/28981)) ([6eae21b](https://github.com/vm0-ai/vm0/commit/6eae21bde1096293028cf6a6d1161a2e0e6ae7dd))
* **python:** lint unbound metadata mutation calls ([#29124](https://github.com/vm0-ai/vm0/issues/29124)) ([c906c06](https://github.com/vm0-ai/vm0/commit/c906c067e2ba16777e0a1d5b1a9ce815f4196f3f))
* **python:** reject negative x response counts ([#28985](https://github.com/vm0-ai/vm0/issues/28985)) ([f6d0ec2](https://github.com/vm0-ai/vm0/commit/f6d0ec2054fa004fffef60619afd1466eac61876))
* **python:** reject oversized firewall auth expiries ([#28390](https://github.com/vm0-ai/vm0/issues/28390)) ([424cefa](https://github.com/vm0-ai/vm0/commit/424cefa243b6045847ac53cfc6bc831ae4187311))
* **python:** retain multiple prewarm response ids ([#28401](https://github.com/vm0-ai/vm0/issues/28401)) ([dbc7222](https://github.com/vm0-ai/vm0/commit/dbc722260de69a3124d8981e6cb3bb1b56c1ef25))
* **python:** share model response classification ([#28633](https://github.com/vm0-ai/vm0/issues/28633)) ([e129ab0](https://github.com/vm0-ai/vm0/commit/e129ab06050e0c71da083fe3afdeb0c294a75c81))
* **python:** track nested break exits in metadata linter ([#28907](https://github.com/vm0-ai/vm0/issues/28907)) ([93164bb](https://github.com/vm0-ai/vm0/commit/93164bb7165f8ce5978c8b2be5de832cee61b87c))
* **runner:** bound firewall catalog response bodies ([#28399](https://github.com/vm0-ai/vm0/issues/28399)) ([1732568](https://github.com/vm0-ai/vm0/commit/17325687f4950e089ce565d1e33737b5822b19be))
* **runner:** continue cleanup after bounded stop errors ([#28947](https://github.com/vm0-ai/vm0/issues/28947)) ([4b0161f](https://github.com/vm0-ai/vm0/commit/4b0161f361f512444e8a532cf9bdac8d1f13e8da))
* **runner:** defer connector diagnostics until upstream auth errors ([#28445](https://github.com/vm0-ai/vm0/issues/28445)) ([ff31fcd](https://github.com/vm0-ai/vm0/commit/ff31fcdb6195ce9ab0c5f8977156c446e6ad2117))
* **runner:** guard connector runtime publications ([#28495](https://github.com/vm0-ai/vm0/issues/28495)) ([641136f](https://github.com/vm0-ai/vm0/commit/641136ff637c4436f6f55871faee2647c675edf2))
* **runner:** isolate shell tool oom cleanup ([#28391](https://github.com/vm0-ai/vm0/issues/28391)) ([ffb0332](https://github.com/vm0-ai/vm0/commit/ffb03327e60854d4e5e541b34a2f3423cfcee6f2))
* **runner:** keep cancellation waits off ably supervisor loop ([#29184](https://github.com/vm0-ai/vm0/issues/29184)) ([4639a0d](https://github.com/vm0-ai/vm0/commit/4639a0d109bf50975c9e74db3c1ea5d547bf4c09))
* **runner:** log execution time limit at info ([#28750](https://github.com/vm0-ai/vm0/issues/28750)) ([9823447](https://github.com/vm0-ai/vm0/commit/9823447ca397e8ea7d15de12d6de725091987a6c))
* **runner:** prevent pid reuse during mitmdump cleanup ([#28834](https://github.com/vm0-ai/vm0/issues/28834)) ([504690c](https://github.com/vm0-ai/vm0/commit/504690c1a68d03e074fabb20eb02db2bcdacbbc9))
* **runner:** reconcile stale drain override cleanup ([#28363](https://github.com/vm0-ai/vm0/issues/28363)) ([6e631e3](https://github.com/vm0-ai/vm0/commit/6e631e340efd2084a5a174487e901d0982ddd4fb))
* **runner:** recover evicted websocket usage pricing ([#28584](https://github.com/vm0-ai/vm0/issues/28584)) ([6d677e5](https://github.com/vm0-ai/vm0/commit/6d677e500ee8f952a1350db74336ae0e8de5581b))
* **runner:** recover mitmdump startup port collisions ([#28846](https://github.com/vm0-ai/vm0/issues/28846)) ([9aa1984](https://github.com/vm0-ai/vm0/commit/9aa198463d2b731ce69f12b75487b9ca7a82db31))
* **runner:** treat reuse capacity rejection as informational ([#28789](https://github.com/vm0-ai/vm0/issues/28789)) ([13456e3](https://github.com/vm0-ai/vm0/commit/13456e3bb2cc1bdd3cbb10df49bb7dc4ccbcd087))
* **rust:** align mock codex rollout paths ([#28692](https://github.com/vm0-ai/vm0/issues/28692)) ([59ecfdb](https://github.com/vm0-ai/vm0/commit/59ecfdbbf4a1402dc5fc85ee460ef88cb0a26e55))
* **usage:** bound model usage quantities ([#28351](https://github.com/vm0-ai/vm0/issues/28351)) ([d91265c](https://github.com/vm0-ai/vm0/commit/d91265c8761b3c40eb7e91a8ac6bcfaa0bdad4f8))


### Documentation

* **python:** clarify model-provider failure shutdown delivery semantics ([#28843](https://github.com/vm0-ai/vm0/issues/28843)) ([8924f63](https://github.com/vm0-ai/vm0/commit/8924f63dade934b3caa6d5629013447a6c70fc3c))
* **python:** define invalid registry sandbox diagnostic contract ([#29219](https://github.com/vm0-ai/vm0/issues/29219)) ([1722111](https://github.com/vm0-ai/vm0/commit/1722111341447bb9d708a86d2ded7f28ff1be2fe))
* **python:** define proxy registry unavailability reason contract ([#29156](https://github.com/vm0-ai/vm0/issues/29156)) ([c31a72a](https://github.com/vm0-ai/vm0/commit/c31a72a0c68e5435179097d73e498b60b6de0bd4))
* **python:** define the shared model http failure evidence contract ([#29123](https://github.com/vm0-ai/vm0/issues/29123)) ([2adbb0f](https://github.com/vm0-ai/vm0/commit/2adbb0f7abcc40a9ef6a5e6f35b583dc519b3728))
* **python:** distinguish expired firewall auth entries from eviction ([#28867](https://github.com/vm0-ai/vm0/issues/28867)) ([5d67c3c](https://github.com/vm0-ai/vm0/commit/5d67c3ce28a43d15f13b20c37ba0c27238a1a93b))
* **python:** document percent-decoded host contract ([#28901](https://github.com/vm0-ai/vm0/issues/28901)) ([be56585](https://github.com/vm0-ai/vm0/commit/be565851b852545c7cf90ac30707dc9ff8bb1ef8))
* **python:** document provider timing store locking and retention contract ([#28394](https://github.com/vm0-ai/vm0/issues/28394)) ([7bbaf7d](https://github.com/vm0-ai/vm0/commit/7bbaf7d410c1b7ac0b7d21ede9a08973c367861b))
* **python:** document selective JSON duplicate-key semantics ([#29007](https://github.com/vm0-ai/vm0/issues/29007)) ([0a05d54](https://github.com/vm0-ai/vm0/commit/0a05d54320d3ffc8494fc28bcbdddb4e9651cd2d))
* **runner:** document host directory trust modes ([#28403](https://github.com/vm0-ai/vm0/issues/28403)) ([7ab2b8c](https://github.com/vm0-ai/vm0/commit/7ab2b8c355988177272860bb04d9a6b86f21d8cb))
* **runner:** document wait-running stdout contract ([#29003](https://github.com/vm0-ai/vm0/issues/29003)) ([1c98e0a](https://github.com/vm0-ai/vm0/commit/1c98e0a5dfe057e981593970cb04716f38cb7401))
* **runner:** remove retired compose contract reference ([#29013](https://github.com/vm0-ai/vm0/issues/29013)) ([8e85227](https://github.com/vm0-ai/vm0/commit/8e852273c1d008c8a8a4d7fe08b92c2cc73ee200))
* **rust:** document drain override cleanup invariants ([#29227](https://github.com/vm0-ai/vm0/issues/29227)) ([37e2220](https://github.com/vm0-ai/vm0/commit/37e222072b498e3c097652c86fb1b2e4905046a5))
* **rust:** document session history probe telemetry semantics ([#28581](https://github.com/vm0-ai/vm0/issues/28581)) ([79f3c94](https://github.com/vm0-ai/vm0/commit/79f3c94be735383764b6ce464326865cbb6d7e73))
* **rust:** document session-history CPU pool invariants ([#29025](https://github.com/vm0-ai/vm0/issues/29025)) ([21a07e5](https://github.com/vm0-ai/vm0/commit/21a07e53497f3b1d89ffd0fdbb330f8c8652529a))


### Refactoring

* **python:** centralize buffered auth body framing ([#28752](https://github.com/vm0-ai/vm0/issues/28752)) ([91c4e5d](https://github.com/vm0-ai/vm0/commit/91c4e5d91fb3ae3cd6caf6853df81f22ec68328e))
* **python:** centralize client peer validation ([#28868](https://github.com/vm0-ai/vm0/issues/28868)) ([038fa22](https://github.com/vm0-ai/vm0/commit/038fa226f3e035d75dec571e98656e37ad7754ec))
* **python:** centralize openai responses event taxonomy ([#28530](https://github.com/vm0-ai/vm0/issues/28530)) ([1a9c18b](https://github.com/vm0-ai/vm0/commit/1a9c18b0756c1439d83640dc1177f4e585e4544c))
* **python:** centralize streaming encoding capabilities ([#28526](https://github.com/vm0-ai/vm0/issues/28526)) ([4928434](https://github.com/vm0-ai/vm0/commit/4928434db79ca61bc8db5c058d67c26071c7993f))
* **python:** centralize websocket handshake header parsing ([#28405](https://github.com/vm0-ai/vm0/issues/28405)) ([d4ea49c](https://github.com/vm0-ai/vm0/commit/d4ea49c389eb40a43521cfea74a9118072d8d1c7))
* **python:** consolidate model-provider flow metadata setup ([#29126](https://github.com/vm0-ai/vm0/issues/29126)) ([82bb2ab](https://github.com/vm0-ai/vm0/commit/82bb2abf5bb68c9962f40352ad39bb68c670d27c))
* **python:** reuse shared usage-event assertions ([#29170](https://github.com/vm0-ai/vm0/issues/29170)) ([eb0b817](https://github.com/vm0-ai/vm0/commit/eb0b817c4a6ddbf23025d46a4e9e5f28a084029c))
* **runner:** centralize gc lock probes ([#28493](https://github.com/vm0-ai/vm0/issues/28493)) ([14a8359](https://github.com/vm0-ai/vm0/commit/14a83594b6f01730b6a53561cac801f686d1fcbd))
* **runner:** centralize idle sandbox activation ([#28630](https://github.com/vm0-ai/vm0/issues/28630)) ([f1ac1d9](https://github.com/vm0-ai/vm0/commit/f1ac1d991d29248de4f55cdfad38962d0e711a78))
* **runner:** centralize procfs process generation ([#28576](https://github.com/vm0-ai/vm0/issues/28576)) ([e35d103](https://github.com/vm0-ai/vm0/commit/e35d1031e8ffcb860e317a4b101831a4d72cdade))
* **runner:** consolidate mock provider operation gates ([#29203](https://github.com/vm0-ai/vm0/issues/29203)) ([e76130d](https://github.com/vm0-ai/vm0/commit/e76130d84211d65eb2ed29cae1d1b33ea1ae016a))
* **runner:** dual-read and dual-write mitmdump runtime markers ([#29030](https://github.com/vm0-ai/vm0/issues/29030)) ([29b82dd](https://github.com/vm0-ai/vm0/commit/29b82dd28d8693471db0a7a00800be0830650ae3))
* **runner:** dual-read canonical host tuning environment aliases ([#28964](https://github.com/vm0-ai/vm0/issues/28964)) ([88cf421](https://github.com/vm0-ai/vm0/commit/88cf42132c3150a1f116d888049f083010fd598f))
* **runner:** dual-read runner token environment aliases ([#28977](https://github.com/vm0-ai/vm0/issues/28977)) ([a9164f6](https://github.com/vm0-ai/vm0/commit/a9164f6aa4129610eb268c90773879b4d4af4b17))
* **runner:** generate firewall cache contract constants ([#28842](https://github.com/vm0-ai/vm0/issues/28842)) ([04a15da](https://github.com/vm0-ai/vm0/commit/04a15daa1c14a7196038fa573ebf2be2ec49791f))
* **runner:** migrate status to sandbox terminology ([#29010](https://github.com/vm0-ai/vm0/issues/29010)) ([6bead98](https://github.com/vm0-ai/vm0/commit/6bead98eb35336befe162e76e862da608d1fb1b6))
* **runner:** reject reserved OKOU keys in local user environment ([#28971](https://github.com/vm0-ai/vm0/issues/28971)) ([3bff5c4](https://github.com/vm0-ai/vm0/commit/3bff5c4998d0a692212ef2abc44513e09c0ba3f1))
* **runner:** remove legacy idle status mirror ([#29072](https://github.com/vm0-ai/vm0/issues/29072)) ([3677fcf](https://github.com/vm0-ai/vm0/commit/3677fcf6f9a4fb92105e5c97d15b92775e6236e0))
* **runner:** rename embedded mitm credential key ([#28952](https://github.com/vm0-ai/vm0/issues/28952)) ([fecae1b](https://github.com/vm0-ai/vm0/commit/fecae1b8917fc01eec9afe9b4395b002ea016c5c))
* **runner:** rename private codex cleanup environment keys ([#28959](https://github.com/vm0-ai/vm0/issues/28959)) ([4e8fec7](https://github.com/vm0-ai/vm0/commit/4e8fec7512e82f44ddc683d30f7014a600fea002)), closes [#28922](https://github.com/vm0-ai/vm0/issues/28922)
* **runner:** rename proxy registry and mitm-addon sandbox contract ([#28967](https://github.com/vm0-ai/vm0/issues/28967)) ([cdc2220](https://github.com/vm0-ai/vm0/commit/cdc2220859e38b82058424e3b7cd05d846cfb2ca))
* **runtime:** add a trusted platform environment channel ([#28970](https://github.com/vm0-ai/vm0/issues/28970)) ([7d6e40b](https://github.com/vm0-ai/vm0/commit/7d6e40b7a8da820582587d96479f4da9f02932b6))
* **runtime:** dual-read guest runtime directory aliases ([#29101](https://github.com/vm0-ai/vm0/issues/29101)) ([3bb5b28](https://github.com/vm0-ai/vm0/commit/3bb5b2807090c3cf48650b917ccca00bdb44f370))
* **runtime:** dual-read private payload file env aliases ([#29082](https://github.com/vm0-ai/vm0/issues/29082)) ([e400e00](https://github.com/vm0-ai/vm0/commit/e400e0058cd63cc18b478ad807da42f9b5bb5e74))
* **runtime:** dual-read resume session environment aliases ([#29069](https://github.com/vm0-ai/vm0/issues/29069)) ([6dd54e9](https://github.com/vm0-ai/vm0/commit/6dd54e909a8607421344e758adcb887f72f8f0de))
* **runtime:** dual-read run metadata env aliases ([#29022](https://github.com/vm0-ai/vm0/issues/29022)) ([928d53b](https://github.com/vm0-ai/vm0/commit/928d53b17819c1c82f76da3aa8e4e672c69431d1))
* **runtime:** reserve okou namespace in cloud execution ([#29040](https://github.com/vm0-ai/vm0/issues/29040)) ([233bc7e](https://github.com/vm0-ai/vm0/commit/233bc7eb29e9c03b4391e91f1fe15ce48d576de6))
* **rust:** enforce exec-control payload limit parity ([#28825](https://github.com/vm0-ai/vm0/issues/28825)) ([6202aee](https://github.com/vm0-ai/vm0/commit/6202aeed5db6e25b6fb845267a20dc4503dfbb79))
* **rust:** generate pi runtime config dtos ([#28928](https://github.com/vm0-ai/vm0/issues/28928)) ([1ae995e](https://github.com/vm0-ai/vm0/commit/1ae995e88763e37f6659581dea03f8aa97c840ad))


### Performance Improvements

* **mitm-addon:** reuse chat completions extractor across sse events ([#28629](https://github.com/vm0-ai/vm0/issues/28629)) ([3ca0aea](https://github.com/vm0-ai/vm0/commit/3ca0aea8b5ff3ed249064c7422f18bd16e5fa290))
* **mitm-addon:** reuse x unicode label classification ([#28983](https://github.com/vm0-ai/vm0/issues/28983)) ([49fd493](https://github.com/vm0-ai/vm0/commit/49fd493137938781ddadd667ad2707a426d7b8cc))
* **python:** avoid duplicate responses sse probes ([#28851](https://github.com/vm0-ai/vm0/issues/28851)) ([85adf1e](https://github.com/vm0-ai/vm0/commit/85adf1eab49d6af3342cdc897c48f675d5fc32c3))
* **python:** reduce x tld redirect test shutdown latency ([#28865](https://github.com/vm0-ai/vm0/issues/28865)) ([b18d95a](https://github.com/vm0-ai/vm0/commit/b18d95ac8f2a043d9cc8a38ea419824ba93876b5))
* **python:** resolve jsonl flush paths once per watcher ([#28349](https://github.com/vm0-ai/vm0/issues/28349)) ([7e730de](https://github.com/vm0-ai/vm0/commit/7e730dec29d40eaf539ad17362bfdaf1f4540e25))
* **python:** share model http response parsing ([#28822](https://github.com/vm0-ai/vm0/issues/28822)) ([242af40](https://github.com/vm0-ai/vm0/commit/242af400b657a717258692557e93d1d19aec280e))
* **python:** share responses websocket parsing ([#28757](https://github.com/vm0-ai/vm0/issues/28757)) ([8671c2b](https://github.com/vm0-ai/vm0/commit/8671c2bc617aeb0e4aab3318b992524d437e1929))
* **python:** skip irrelevant websocket client parsing ([#29127](https://github.com/vm0-ai/vm0/issues/29127)) ([2131e63](https://github.com/vm0-ai/vm0/commit/2131e63052fd57131942d4f76522ff3d09da3f7e))
* **runner:** attribute pre-spawn concurrency ([#28839](https://github.com/vm0-ai/vm0/issues/28839)) ([5e11ce3](https://github.com/vm0-ai/vm0/commit/5e11ce3b6aedbd502c94dd07ff68a5209cb4e101))
* **runner:** bound burst pre-spawn concurrency ([#28882](https://github.com/vm0-ai/vm0/issues/28882)) ([97bcd42](https://github.com/vm0-ai/vm0/commit/97bcd42706fb53c60d6dd101fb69a96362bc6b14))
* **runner:** bound command output capture ([#28909](https://github.com/vm0-ai/vm0/issues/28909)) ([5279ac7](https://github.com/vm0-ai/vm0/commit/5279ac7a4707242d4566127133fc72dde43179d6))
* **runner:** bound local queue job reads ([#28395](https://github.com/vm0-ai/vm0/issues/28395)) ([bf6499b](https://github.com/vm0-ai/vm0/commit/bf6499bebd8d138a75f1bae1547e96178b50c750))
* **runner:** coordinate routine cache gc per host ([#28373](https://github.com/vm0-ai/vm0/issues/28373)) ([ab154d5](https://github.com/vm0-ai/vm0/commit/ab154d56a6545cbd716661d9c57e407d6838bfb5))
* **runner:** reduce workspace cache path allocations ([#28498](https://github.com/vm0-ai/vm0/issues/28498)) ([d08a325](https://github.com/vm0-ai/vm0/commit/d08a3255808888a2962d1ba9737f5f2a1ddff43f))
* **runner:** skip codex cleanup in fresh sandboxes ([#29183](https://github.com/vm0-ai/vm0/issues/29183)) ([126fc49](https://github.com/vm0-ai/vm0/commit/126fc499fb949f47f8b3be823f2e120ab0b4f46f))
* **runner:** specialize guest storage manifest invocation ([#28734](https://github.com/vm0-ai/vm0/issues/28734)) ([0255e57](https://github.com/vm0-ai/vm0/commit/0255e57603d27fe97ac342c97af98921dabf2ae9))

## [0.172.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.171.12...runner-rs-v0.172.0) (2026-08-25)


### Features

* **api:** add strict pi api first-turn handoff ([#28664](https://github.com/vm0-ai/vm0/issues/28664)) ([4bc9ef0](https://github.com/vm0-ai/vm0/commit/4bc9ef063e244a3f3af8dbc9ab94fd173208b93c))
* **runner:** report trusted model provider failures ([#28532](https://github.com/vm0-ai/vm0/issues/28532)) ([95a6ecd](https://github.com/vm0-ai/vm0/commit/95a6ecd44582d3bedf35b97f6874a01f2d7c6a34))


### Bug Fixes

* **events:** preserve timeout and connect observations ([#28397](https://github.com/vm0-ai/vm0/issues/28397)) ([c3d536e](https://github.com/vm0-ai/vm0/commit/c3d536eab61fca8e2006a7664a982b993537db00))
* **guest-agent:** classify mid-response failures ([#28393](https://github.com/vm0-ai/vm0/issues/28393)) ([4ca21bd](https://github.com/vm0-ai/vm0/commit/4ca21bdbe47a2ce99f34c343b074f83c45775483))
* **guest-agent:** keep claude appended prompts out of argv ([#28838](https://github.com/vm0-ai/vm0/issues/28838)) ([0bd96d6](https://github.com/vm0-ai/vm0/commit/0bd96d69d6b9121e37232080a35111550f709424))
* **guest:** isolate managed claude config from user home ([#28324](https://github.com/vm0-ai/vm0/issues/28324)) ([c6a20ba](https://github.com/vm0-ai/vm0/commit/c6a20babf5f75ffac7ac97f69c570ba1ddb2ef23))
* **python:** bound request header name work ([#28342](https://github.com/vm0-ai/vm0/issues/28342)) ([ffcd0fa](https://github.com/vm0-ai/vm0/commit/ffcd0fa83312ab7f20ed517ba717ee01721fca28))
* **python:** clamp managed provider retry-after delays ([#28652](https://github.com/vm0-ai/vm0/issues/28652)) ([525dd58](https://github.com/vm0-ai/vm0/commit/525dd588b1cef082c5ced8e419e07e73c469b1de))
* **python:** classify openrouter 500 responses by body ([#28644](https://github.com/vm0-ai/vm0/issues/28644)) ([16bd0b2](https://github.com/vm0-ai/vm0/commit/16bd0b2bca552eee731b7d53cfedf5475b9b5bf3))
* **python:** drain retained diagnostics after webhook shutdown ([#28981](https://github.com/vm0-ai/vm0/issues/28981)) ([6eae21b](https://github.com/vm0-ai/vm0/commit/6eae21bde1096293028cf6a6d1161a2e0e6ae7dd))
* **python:** handle x tld snapshot write failures ([#28340](https://github.com/vm0-ai/vm0/issues/28340)) ([9493c43](https://github.com/vm0-ai/vm0/commit/9493c4391e159d3a59bc8c27c73bdb347344bb0d))
* **python:** lint unbound metadata mutation calls ([#29124](https://github.com/vm0-ai/vm0/issues/29124)) ([c906c06](https://github.com/vm0-ai/vm0/commit/c906c067e2ba16777e0a1d5b1a9ce815f4196f3f))
* **python:** reject negative x response counts ([#28985](https://github.com/vm0-ai/vm0/issues/28985)) ([f6d0ec2](https://github.com/vm0-ai/vm0/commit/f6d0ec2054fa004fffef60619afd1466eac61876))
* **python:** reject oversized firewall auth expiries ([#28390](https://github.com/vm0-ai/vm0/issues/28390)) ([424cefa](https://github.com/vm0-ai/vm0/commit/424cefa243b6045847ac53cfc6bc831ae4187311))
* **python:** retain multiple prewarm response ids ([#28401](https://github.com/vm0-ai/vm0/issues/28401)) ([dbc7222](https://github.com/vm0-ai/vm0/commit/dbc722260de69a3124d8981e6cb3bb1b56c1ef25))
* **python:** share model response classification ([#28633](https://github.com/vm0-ai/vm0/issues/28633)) ([e129ab0](https://github.com/vm0-ai/vm0/commit/e129ab06050e0c71da083fe3afdeb0c294a75c81))
* **python:** track nested break exits in metadata linter ([#28907](https://github.com/vm0-ai/vm0/issues/28907)) ([93164bb](https://github.com/vm0-ai/vm0/commit/93164bb7165f8ce5978c8b2be5de832cee61b87c))
* **runner:** bound firewall catalog response bodies ([#28399](https://github.com/vm0-ai/vm0/issues/28399)) ([1732568](https://github.com/vm0-ai/vm0/commit/17325687f4950e089ce565d1e33737b5822b19be))
* **runner:** continue cleanup after bounded stop errors ([#28947](https://github.com/vm0-ai/vm0/issues/28947)) ([4b0161f](https://github.com/vm0-ai/vm0/commit/4b0161f361f512444e8a532cf9bdac8d1f13e8da))
* **runner:** defer connector diagnostics until upstream auth errors ([#28445](https://github.com/vm0-ai/vm0/issues/28445)) ([ff31fcd](https://github.com/vm0-ai/vm0/commit/ff31fcdb6195ce9ab0c5f8977156c446e6ad2117))
* **runner:** guard connector runtime publications ([#28495](https://github.com/vm0-ai/vm0/issues/28495)) ([641136f](https://github.com/vm0-ai/vm0/commit/641136ff637c4436f6f55871faee2647c675edf2))
* **runner:** isolate shell tool oom cleanup ([#28391](https://github.com/vm0-ai/vm0/issues/28391)) ([ffb0332](https://github.com/vm0-ai/vm0/commit/ffb03327e60854d4e5e541b34a2f3423cfcee6f2))
* **runner:** keep cancellation waits off ably supervisor loop ([#29184](https://github.com/vm0-ai/vm0/issues/29184)) ([4639a0d](https://github.com/vm0-ai/vm0/commit/4639a0d109bf50975c9e74db3c1ea5d547bf4c09))
* **runner:** log execution time limit at info ([#28750](https://github.com/vm0-ai/vm0/issues/28750)) ([9823447](https://github.com/vm0-ai/vm0/commit/9823447ca397e8ea7d15de12d6de725091987a6c))
* **runner:** prevent pid reuse during mitmdump cleanup ([#28834](https://github.com/vm0-ai/vm0/issues/28834)) ([504690c](https://github.com/vm0-ai/vm0/commit/504690c1a68d03e074fabb20eb02db2bcdacbbc9))
* **runner:** reconcile stale drain override cleanup ([#28363](https://github.com/vm0-ai/vm0/issues/28363)) ([6e631e3](https://github.com/vm0-ai/vm0/commit/6e631e340efd2084a5a174487e901d0982ddd4fb))
* **runner:** recover evicted websocket usage pricing ([#28584](https://github.com/vm0-ai/vm0/issues/28584)) ([6d677e5](https://github.com/vm0-ai/vm0/commit/6d677e500ee8f952a1350db74336ae0e8de5581b))
* **runner:** recover mitmdump startup port collisions ([#28846](https://github.com/vm0-ai/vm0/issues/28846)) ([9aa1984](https://github.com/vm0-ai/vm0/commit/9aa198463d2b731ce69f12b75487b9ca7a82db31))
* **runner:** treat reuse capacity rejection as informational ([#28789](https://github.com/vm0-ai/vm0/issues/28789)) ([13456e3](https://github.com/vm0-ai/vm0/commit/13456e3bb2cc1bdd3cbb10df49bb7dc4ccbcd087))
* **rust:** align mock codex rollout paths ([#28692](https://github.com/vm0-ai/vm0/issues/28692)) ([59ecfdb](https://github.com/vm0-ai/vm0/commit/59ecfdbbf4a1402dc5fc85ee460ef88cb0a26e55))
* surface claude terms acceptance failures ([#28314](https://github.com/vm0-ai/vm0/issues/28314)) ([dc0674c](https://github.com/vm0-ai/vm0/commit/dc0674cd33b9b5ec44e592814c4f7b0c3d952575))
* **usage:** bound model usage quantities ([#28351](https://github.com/vm0-ai/vm0/issues/28351)) ([d91265c](https://github.com/vm0-ai/vm0/commit/d91265c8761b3c40eb7e91a8ac6bcfaa0bdad4f8))


### Documentation

* **python:** clarify model-provider failure shutdown delivery semantics ([#28843](https://github.com/vm0-ai/vm0/issues/28843)) ([8924f63](https://github.com/vm0-ai/vm0/commit/8924f63dade934b3caa6d5629013447a6c70fc3c))
* **python:** define proxy registry unavailability reason contract ([#29156](https://github.com/vm0-ai/vm0/issues/29156)) ([c31a72a](https://github.com/vm0-ai/vm0/commit/c31a72a0c68e5435179097d73e498b60b6de0bd4))
* **python:** define the shared model http failure evidence contract ([#29123](https://github.com/vm0-ai/vm0/issues/29123)) ([2adbb0f](https://github.com/vm0-ai/vm0/commit/2adbb0f7abcc40a9ef6a5e6f35b583dc519b3728))
* **python:** distinguish expired firewall auth entries from eviction ([#28867](https://github.com/vm0-ai/vm0/issues/28867)) ([5d67c3c](https://github.com/vm0-ai/vm0/commit/5d67c3ce28a43d15f13b20c37ba0c27238a1a93b))
* **python:** document percent-decoded host contract ([#28901](https://github.com/vm0-ai/vm0/issues/28901)) ([be56585](https://github.com/vm0-ai/vm0/commit/be565851b852545c7cf90ac30707dc9ff8bb1ef8))
* **python:** document provider timing store locking and retention contract ([#28394](https://github.com/vm0-ai/vm0/issues/28394)) ([7bbaf7d](https://github.com/vm0-ai/vm0/commit/7bbaf7d410c1b7ac0b7d21ede9a08973c367861b))
* **python:** document selective JSON duplicate-key semantics ([#29007](https://github.com/vm0-ai/vm0/issues/29007)) ([0a05d54](https://github.com/vm0-ai/vm0/commit/0a05d54320d3ffc8494fc28bcbdddb4e9651cd2d))
* **runner:** document host directory trust modes ([#28403](https://github.com/vm0-ai/vm0/issues/28403)) ([7ab2b8c](https://github.com/vm0-ai/vm0/commit/7ab2b8c355988177272860bb04d9a6b86f21d8cb))
* **runner:** document wait-running stdout contract ([#29003](https://github.com/vm0-ai/vm0/issues/29003)) ([1c98e0a](https://github.com/vm0-ai/vm0/commit/1c98e0a5dfe057e981593970cb04716f38cb7401))
* **runner:** remove retired compose contract reference ([#29013](https://github.com/vm0-ai/vm0/issues/29013)) ([8e85227](https://github.com/vm0-ai/vm0/commit/8e852273c1d008c8a8a4d7fe08b92c2cc73ee200))
* **rust:** document session history probe telemetry semantics ([#28581](https://github.com/vm0-ai/vm0/issues/28581)) ([79f3c94](https://github.com/vm0-ai/vm0/commit/79f3c94be735383764b6ce464326865cbb6d7e73))
* **rust:** document session-history CPU pool invariants ([#29025](https://github.com/vm0-ai/vm0/issues/29025)) ([21a07e5](https://github.com/vm0-ai/vm0/commit/21a07e53497f3b1d89ffd0fdbb330f8c8652529a))


### Refactoring

* **python:** centralize buffered auth body framing ([#28752](https://github.com/vm0-ai/vm0/issues/28752)) ([91c4e5d](https://github.com/vm0-ai/vm0/commit/91c4e5d91fb3ae3cd6caf6853df81f22ec68328e))
* **python:** centralize catalog cache fixtures ([#28339](https://github.com/vm0-ai/vm0/issues/28339)) ([787480b](https://github.com/vm0-ai/vm0/commit/787480b043d6369c245f430e85a130dcec246871))
* **python:** centralize client peer validation ([#28868](https://github.com/vm0-ai/vm0/issues/28868)) ([038fa22](https://github.com/vm0-ai/vm0/commit/038fa226f3e035d75dec571e98656e37ad7754ec))
* **python:** centralize openai responses event taxonomy ([#28530](https://github.com/vm0-ai/vm0/issues/28530)) ([1a9c18b](https://github.com/vm0-ai/vm0/commit/1a9c18b0756c1439d83640dc1177f4e585e4544c))
* **python:** centralize streaming encoding capabilities ([#28526](https://github.com/vm0-ai/vm0/issues/28526)) ([4928434](https://github.com/vm0-ai/vm0/commit/4928434db79ca61bc8db5c058d67c26071c7993f))
* **python:** centralize websocket handshake header parsing ([#28405](https://github.com/vm0-ai/vm0/issues/28405)) ([d4ea49c](https://github.com/vm0-ai/vm0/commit/d4ea49c389eb40a43521cfea74a9118072d8d1c7))
* **python:** consolidate model-provider flow metadata setup ([#29126](https://github.com/vm0-ai/vm0/issues/29126)) ([82bb2ab](https://github.com/vm0-ai/vm0/commit/82bb2abf5bb68c9962f40352ad39bb68c670d27c))
* **python:** reuse shared usage-event assertions ([#29170](https://github.com/vm0-ai/vm0/issues/29170)) ([eb0b817](https://github.com/vm0-ai/vm0/commit/eb0b817c4a6ddbf23025d46a4e9e5f28a084029c))
* **runner:** centralize gc lock probes ([#28493](https://github.com/vm0-ai/vm0/issues/28493)) ([14a8359](https://github.com/vm0-ai/vm0/commit/14a83594b6f01730b6a53561cac801f686d1fcbd))
* **runner:** centralize idle sandbox activation ([#28630](https://github.com/vm0-ai/vm0/issues/28630)) ([f1ac1d9](https://github.com/vm0-ai/vm0/commit/f1ac1d991d29248de4f55cdfad38962d0e711a78))
* **runner:** centralize procfs process generation ([#28576](https://github.com/vm0-ai/vm0/issues/28576)) ([e35d103](https://github.com/vm0-ai/vm0/commit/e35d1031e8ffcb860e317a4b101831a4d72cdade))
* **runner:** consolidate mock provider operation gates ([#29203](https://github.com/vm0-ai/vm0/issues/29203)) ([e76130d](https://github.com/vm0-ai/vm0/commit/e76130d84211d65eb2ed29cae1d1b33ea1ae016a))
* **runner:** dual-read and dual-write mitmdump runtime markers ([#29030](https://github.com/vm0-ai/vm0/issues/29030)) ([29b82dd](https://github.com/vm0-ai/vm0/commit/29b82dd28d8693471db0a7a00800be0830650ae3))
* **runner:** dual-read canonical host tuning environment aliases ([#28964](https://github.com/vm0-ai/vm0/issues/28964)) ([88cf421](https://github.com/vm0-ai/vm0/commit/88cf42132c3150a1f116d888049f083010fd598f))
* **runner:** dual-read runner token environment aliases ([#28977](https://github.com/vm0-ai/vm0/issues/28977)) ([a9164f6](https://github.com/vm0-ai/vm0/commit/a9164f6aa4129610eb268c90773879b4d4af4b17))
* **runner:** generate firewall cache contract constants ([#28842](https://github.com/vm0-ai/vm0/issues/28842)) ([04a15da](https://github.com/vm0-ai/vm0/commit/04a15daa1c14a7196038fa573ebf2be2ec49791f))
* **runner:** migrate status to sandbox terminology ([#29010](https://github.com/vm0-ai/vm0/issues/29010)) ([6bead98](https://github.com/vm0-ai/vm0/commit/6bead98eb35336befe162e76e862da608d1fb1b6))
* **runner:** reject reserved OKOU keys in local user environment ([#28971](https://github.com/vm0-ai/vm0/issues/28971)) ([3bff5c4](https://github.com/vm0-ai/vm0/commit/3bff5c4998d0a692212ef2abc44513e09c0ba3f1))
* **runner:** remove legacy idle status mirror ([#29072](https://github.com/vm0-ai/vm0/issues/29072)) ([3677fcf](https://github.com/vm0-ai/vm0/commit/3677fcf6f9a4fb92105e5c97d15b92775e6236e0))
* **runner:** rename embedded mitm credential key ([#28952](https://github.com/vm0-ai/vm0/issues/28952)) ([fecae1b](https://github.com/vm0-ai/vm0/commit/fecae1b8917fc01eec9afe9b4395b002ea016c5c))
* **runner:** rename private codex cleanup environment keys ([#28959](https://github.com/vm0-ai/vm0/issues/28959)) ([4e8fec7](https://github.com/vm0-ai/vm0/commit/4e8fec7512e82f44ddc683d30f7014a600fea002)), closes [#28922](https://github.com/vm0-ai/vm0/issues/28922)
* **runner:** rename proxy registry and mitm-addon sandbox contract ([#28967](https://github.com/vm0-ai/vm0/issues/28967)) ([cdc2220](https://github.com/vm0-ai/vm0/commit/cdc2220859e38b82058424e3b7cd05d846cfb2ca))
* **runtime:** add a trusted platform environment channel ([#28970](https://github.com/vm0-ai/vm0/issues/28970)) ([7d6e40b](https://github.com/vm0-ai/vm0/commit/7d6e40b7a8da820582587d96479f4da9f02932b6))
* **runtime:** dual-read guest runtime directory aliases ([#29101](https://github.com/vm0-ai/vm0/issues/29101)) ([3bb5b28](https://github.com/vm0-ai/vm0/commit/3bb5b2807090c3cf48650b917ccca00bdb44f370))
* **runtime:** dual-read private payload file env aliases ([#29082](https://github.com/vm0-ai/vm0/issues/29082)) ([e400e00](https://github.com/vm0-ai/vm0/commit/e400e0058cd63cc18b478ad807da42f9b5bb5e74))
* **runtime:** dual-read resume session environment aliases ([#29069](https://github.com/vm0-ai/vm0/issues/29069)) ([6dd54e9](https://github.com/vm0-ai/vm0/commit/6dd54e909a8607421344e758adcb887f72f8f0de))
* **runtime:** dual-read run metadata env aliases ([#29022](https://github.com/vm0-ai/vm0/issues/29022)) ([928d53b](https://github.com/vm0-ai/vm0/commit/928d53b17819c1c82f76da3aa8e4e672c69431d1))
* **runtime:** reserve okou namespace in cloud execution ([#29040](https://github.com/vm0-ai/vm0/issues/29040)) ([233bc7e](https://github.com/vm0-ai/vm0/commit/233bc7eb29e9c03b4391e91f1fe15ce48d576de6))
* **rust:** enforce exec-control payload limit parity ([#28825](https://github.com/vm0-ai/vm0/issues/28825)) ([6202aee](https://github.com/vm0-ai/vm0/commit/6202aeed5db6e25b6fb845267a20dc4503dfbb79))
* **rust:** generate pi runtime config dtos ([#28928](https://github.com/vm0-ai/vm0/issues/28928)) ([1ae995e](https://github.com/vm0-ai/vm0/commit/1ae995e88763e37f6659581dea03f8aa97c840ad))


### Performance Improvements

* **mitm-addon:** reuse chat completions extractor across sse events ([#28629](https://github.com/vm0-ai/vm0/issues/28629)) ([3ca0aea](https://github.com/vm0-ai/vm0/commit/3ca0aea8b5ff3ed249064c7422f18bd16e5fa290))
* **mitm-addon:** reuse x unicode label classification ([#28983](https://github.com/vm0-ai/vm0/issues/28983)) ([49fd493](https://github.com/vm0-ai/vm0/commit/49fd493137938781ddadd667ad2707a426d7b8cc))
* **python:** avoid duplicate responses sse probes ([#28851](https://github.com/vm0-ai/vm0/issues/28851)) ([85adf1e](https://github.com/vm0-ai/vm0/commit/85adf1eab49d6af3342cdc897c48f675d5fc32c3))
* **python:** reduce x tld redirect test shutdown latency ([#28865](https://github.com/vm0-ai/vm0/issues/28865)) ([b18d95a](https://github.com/vm0-ai/vm0/commit/b18d95ac8f2a043d9cc8a38ea419824ba93876b5))
* **python:** resolve jsonl flush paths once per watcher ([#28349](https://github.com/vm0-ai/vm0/issues/28349)) ([7e730de](https://github.com/vm0-ai/vm0/commit/7e730dec29d40eaf539ad17362bfdaf1f4540e25))
* **python:** share model http response parsing ([#28822](https://github.com/vm0-ai/vm0/issues/28822)) ([242af40](https://github.com/vm0-ai/vm0/commit/242af400b657a717258692557e93d1d19aec280e))
* **python:** share responses websocket parsing ([#28757](https://github.com/vm0-ai/vm0/issues/28757)) ([8671c2b](https://github.com/vm0-ai/vm0/commit/8671c2bc617aeb0e4aab3318b992524d437e1929))
* **python:** skip irrelevant websocket client parsing ([#29127](https://github.com/vm0-ai/vm0/issues/29127)) ([2131e63](https://github.com/vm0-ai/vm0/commit/2131e63052fd57131942d4f76522ff3d09da3f7e))
* **runner:** attribute pre-spawn concurrency ([#28839](https://github.com/vm0-ai/vm0/issues/28839)) ([5e11ce3](https://github.com/vm0-ai/vm0/commit/5e11ce3b6aedbd502c94dd07ff68a5209cb4e101))
* **runner:** bound burst pre-spawn concurrency ([#28882](https://github.com/vm0-ai/vm0/issues/28882)) ([97bcd42](https://github.com/vm0-ai/vm0/commit/97bcd42706fb53c60d6dd101fb69a96362bc6b14))
* **runner:** bound command output capture ([#28909](https://github.com/vm0-ai/vm0/issues/28909)) ([5279ac7](https://github.com/vm0-ai/vm0/commit/5279ac7a4707242d4566127133fc72dde43179d6))
* **runner:** bound local queue job reads ([#28395](https://github.com/vm0-ai/vm0/issues/28395)) ([bf6499b](https://github.com/vm0-ai/vm0/commit/bf6499bebd8d138a75f1bae1547e96178b50c750))
* **runner:** coordinate routine cache gc per host ([#28373](https://github.com/vm0-ai/vm0/issues/28373)) ([ab154d5](https://github.com/vm0-ai/vm0/commit/ab154d56a6545cbd716661d9c57e407d6838bfb5))
* **runner:** reduce workspace cache path allocations ([#28498](https://github.com/vm0-ai/vm0/issues/28498)) ([d08a325](https://github.com/vm0-ai/vm0/commit/d08a3255808888a2962d1ba9737f5f2a1ddff43f))
* **runner:** skip codex cleanup in fresh sandboxes ([#29183](https://github.com/vm0-ai/vm0/issues/29183)) ([126fc49](https://github.com/vm0-ai/vm0/commit/126fc499fb949f47f8b3be823f2e120ab0b4f46f))
* **runner:** specialize guest storage manifest invocation ([#28734](https://github.com/vm0-ai/vm0/issues/28734)) ([0255e57](https://github.com/vm0-ai/vm0/commit/0255e57603d27fe97ac342c97af98921dabf2ae9))

## [0.171.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.171.11...runner-rs-v0.171.12) (2026-08-25)


### Bug Fixes

* **python:** lint unbound metadata mutation calls ([#29124](https://github.com/vm0-ai/vm0/issues/29124)) ([c906c06](https://github.com/vm0-ai/vm0/commit/c906c067e2ba16777e0a1d5b1a9ce815f4196f3f))


### Documentation

* **python:** define proxy registry unavailability reason contract ([#29156](https://github.com/vm0-ai/vm0/issues/29156)) ([c31a72a](https://github.com/vm0-ai/vm0/commit/c31a72a0c68e5435179097d73e498b60b6de0bd4))
* **python:** define the shared model http failure evidence contract ([#29123](https://github.com/vm0-ai/vm0/issues/29123)) ([2adbb0f](https://github.com/vm0-ai/vm0/commit/2adbb0f7abcc40a9ef6a5e6f35b583dc519b3728))


### Refactoring

* **python:** consolidate model-provider flow metadata setup ([#29126](https://github.com/vm0-ai/vm0/issues/29126)) ([82bb2ab](https://github.com/vm0-ai/vm0/commit/82bb2abf5bb68c9962f40352ad39bb68c670d27c))


### Performance Improvements

* **python:** skip irrelevant websocket client parsing ([#29127](https://github.com/vm0-ai/vm0/issues/29127)) ([2131e63](https://github.com/vm0-ai/vm0/commit/2131e63052fd57131942d4f76522ff3d09da3f7e))

## [0.171.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.171.10...runner-rs-v0.171.11) (2026-08-24)


### Refactoring

* **runner:** remove legacy idle status mirror ([#29072](https://github.com/vm0-ai/vm0/issues/29072)) ([3677fcf](https://github.com/vm0-ai/vm0/commit/3677fcf6f9a4fb92105e5c97d15b92775e6236e0))
* **runtime:** dual-read guest runtime directory aliases ([#29101](https://github.com/vm0-ai/vm0/issues/29101)) ([3bb5b28](https://github.com/vm0-ai/vm0/commit/3bb5b2807090c3cf48650b917ccca00bdb44f370))
* **runtime:** dual-read private payload file env aliases ([#29082](https://github.com/vm0-ai/vm0/issues/29082)) ([e400e00](https://github.com/vm0-ai/vm0/commit/e400e0058cd63cc18b478ad807da42f9b5bb5e74))
* **runtime:** dual-read resume session environment aliases ([#29069](https://github.com/vm0-ai/vm0/issues/29069)) ([6dd54e9](https://github.com/vm0-ai/vm0/commit/6dd54e909a8607421344e758adcb887f72f8f0de))

## [0.171.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.171.9...runner-rs-v0.171.10) (2026-08-24)

## [0.171.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.171.8...runner-rs-v0.171.9) (2026-08-24)


### Documentation

* **runner:** document wait-running stdout contract ([#29003](https://github.com/vm0-ai/vm0/issues/29003)) ([1c98e0a](https://github.com/vm0-ai/vm0/commit/1c98e0a5dfe057e981593970cb04716f38cb7401))
* **runner:** remove retired compose contract reference ([#29013](https://github.com/vm0-ai/vm0/issues/29013)) ([8e85227](https://github.com/vm0-ai/vm0/commit/8e852273c1d008c8a8a4d7fe08b92c2cc73ee200))
* **rust:** document session-history CPU pool invariants ([#29025](https://github.com/vm0-ai/vm0/issues/29025)) ([21a07e5](https://github.com/vm0-ai/vm0/commit/21a07e53497f3b1d89ffd0fdbb330f8c8652529a))


### Refactoring

* **runner:** dual-read and dual-write mitmdump runtime markers ([#29030](https://github.com/vm0-ai/vm0/issues/29030)) ([29b82dd](https://github.com/vm0-ai/vm0/commit/29b82dd28d8693471db0a7a00800be0830650ae3))
* **runner:** migrate status to sandbox terminology ([#29010](https://github.com/vm0-ai/vm0/issues/29010)) ([6bead98](https://github.com/vm0-ai/vm0/commit/6bead98eb35336befe162e76e862da608d1fb1b6))
* **runtime:** dual-read run metadata env aliases ([#29022](https://github.com/vm0-ai/vm0/issues/29022)) ([928d53b](https://github.com/vm0-ai/vm0/commit/928d53b17819c1c82f76da3aa8e4e672c69431d1))
* **runtime:** reserve okou namespace in cloud execution ([#29040](https://github.com/vm0-ai/vm0/issues/29040)) ([233bc7e](https://github.com/vm0-ai/vm0/commit/233bc7eb29e9c03b4391e91f1fe15ce48d576de6))

## [0.171.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.171.7...runner-rs-v0.171.8) (2026-08-24)


### Bug Fixes

* **python:** drain retained diagnostics after webhook shutdown ([#28981](https://github.com/vm0-ai/vm0/issues/28981)) ([6eae21b](https://github.com/vm0-ai/vm0/commit/6eae21bde1096293028cf6a6d1161a2e0e6ae7dd))
* **python:** reject negative x response counts ([#28985](https://github.com/vm0-ai/vm0/issues/28985)) ([f6d0ec2](https://github.com/vm0-ai/vm0/commit/f6d0ec2054fa004fffef60619afd1466eac61876))
* **runner:** continue cleanup after bounded stop errors ([#28947](https://github.com/vm0-ai/vm0/issues/28947)) ([4b0161f](https://github.com/vm0-ai/vm0/commit/4b0161f361f512444e8a532cf9bdac8d1f13e8da))


### Refactoring

* **runner:** dual-read canonical host tuning environment aliases ([#28964](https://github.com/vm0-ai/vm0/issues/28964)) ([88cf421](https://github.com/vm0-ai/vm0/commit/88cf42132c3150a1f116d888049f083010fd598f))
* **runner:** dual-read runner token environment aliases ([#28977](https://github.com/vm0-ai/vm0/issues/28977)) ([a9164f6](https://github.com/vm0-ai/vm0/commit/a9164f6aa4129610eb268c90773879b4d4af4b17))
* **runner:** reject reserved OKOU keys in local user environment ([#28971](https://github.com/vm0-ai/vm0/issues/28971)) ([3bff5c4](https://github.com/vm0-ai/vm0/commit/3bff5c4998d0a692212ef2abc44513e09c0ba3f1))
* **runner:** rename embedded mitm credential key ([#28952](https://github.com/vm0-ai/vm0/issues/28952)) ([fecae1b](https://github.com/vm0-ai/vm0/commit/fecae1b8917fc01eec9afe9b4395b002ea016c5c))
* **runner:** rename private codex cleanup environment keys ([#28959](https://github.com/vm0-ai/vm0/issues/28959)) ([4e8fec7](https://github.com/vm0-ai/vm0/commit/4e8fec7512e82f44ddc683d30f7014a600fea002)), closes [#28922](https://github.com/vm0-ai/vm0/issues/28922)
* **runner:** rename proxy registry and mitm-addon sandbox contract ([#28967](https://github.com/vm0-ai/vm0/issues/28967)) ([cdc2220](https://github.com/vm0-ai/vm0/commit/cdc2220859e38b82058424e3b7cd05d846cfb2ca))
* **runtime:** add a trusted platform environment channel ([#28970](https://github.com/vm0-ai/vm0/issues/28970)) ([7d6e40b](https://github.com/vm0-ai/vm0/commit/7d6e40b7a8da820582587d96479f4da9f02932b6))


### Performance Improvements

* **mitm-addon:** reuse x unicode label classification ([#28983](https://github.com/vm0-ai/vm0/issues/28983)) ([49fd493](https://github.com/vm0-ai/vm0/commit/49fd493137938781ddadd667ad2707a426d7b8cc))
* **runner:** bound burst pre-spawn concurrency ([#28882](https://github.com/vm0-ai/vm0/issues/28882)) ([97bcd42](https://github.com/vm0-ai/vm0/commit/97bcd42706fb53c60d6dd101fb69a96362bc6b14))

## [0.171.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.171.6...runner-rs-v0.171.7) (2026-08-24)


### Bug Fixes

* **python:** track nested break exits in metadata linter ([#28907](https://github.com/vm0-ai/vm0/issues/28907)) ([93164bb](https://github.com/vm0-ai/vm0/commit/93164bb7165f8ce5978c8b2be5de832cee61b87c))


### Documentation

* **python:** document percent-decoded host contract ([#28901](https://github.com/vm0-ai/vm0/issues/28901)) ([be56585](https://github.com/vm0-ai/vm0/commit/be565851b852545c7cf90ac30707dc9ff8bb1ef8))


### Performance Improvements

* **runner:** bound command output capture ([#28909](https://github.com/vm0-ai/vm0/issues/28909)) ([5279ac7](https://github.com/vm0-ai/vm0/commit/5279ac7a4707242d4566127133fc72dde43179d6))

## [0.171.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.171.5...runner-rs-v0.171.6) (2026-08-24)


### Documentation

* **python:** distinguish expired firewall auth entries from eviction ([#28867](https://github.com/vm0-ai/vm0/issues/28867)) ([5d67c3c](https://github.com/vm0-ai/vm0/commit/5d67c3ce28a43d15f13b20c37ba0c27238a1a93b))


### Refactoring

* **python:** centralize client peer validation ([#28868](https://github.com/vm0-ai/vm0/issues/28868)) ([038fa22](https://github.com/vm0-ai/vm0/commit/038fa226f3e035d75dec571e98656e37ad7754ec))


### Performance Improvements

* **python:** reduce x tld redirect test shutdown latency ([#28865](https://github.com/vm0-ai/vm0/issues/28865)) ([b18d95a](https://github.com/vm0-ai/vm0/commit/b18d95ac8f2a043d9cc8a38ea419824ba93876b5))

## [0.171.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.171.4...runner-rs-v0.171.5) (2026-08-24)


### Bug Fixes

* **guest-agent:** keep claude appended prompts out of argv ([#28838](https://github.com/vm0-ai/vm0/issues/28838)) ([0bd96d6](https://github.com/vm0-ai/vm0/commit/0bd96d69d6b9121e37232080a35111550f709424))
* **runner:** prevent pid reuse during mitmdump cleanup ([#28834](https://github.com/vm0-ai/vm0/issues/28834)) ([504690c](https://github.com/vm0-ai/vm0/commit/504690c1a68d03e074fabb20eb02db2bcdacbbc9))
* **runner:** recover mitmdump startup port collisions ([#28846](https://github.com/vm0-ai/vm0/issues/28846)) ([9aa1984](https://github.com/vm0-ai/vm0/commit/9aa198463d2b731ce69f12b75487b9ca7a82db31))


### Documentation

* **python:** clarify model-provider failure shutdown delivery semantics ([#28843](https://github.com/vm0-ai/vm0/issues/28843)) ([8924f63](https://github.com/vm0-ai/vm0/commit/8924f63dade934b3caa6d5629013447a6c70fc3c))


### Refactoring

* **runner:** generate firewall cache contract constants ([#28842](https://github.com/vm0-ai/vm0/issues/28842)) ([04a15da](https://github.com/vm0-ai/vm0/commit/04a15daa1c14a7196038fa573ebf2be2ec49791f))
* **rust:** enforce exec-control payload limit parity ([#28825](https://github.com/vm0-ai/vm0/issues/28825)) ([6202aee](https://github.com/vm0-ai/vm0/commit/6202aeed5db6e25b6fb845267a20dc4503dfbb79))


### Performance Improvements

* **python:** share model http response parsing ([#28822](https://github.com/vm0-ai/vm0/issues/28822)) ([242af40](https://github.com/vm0-ai/vm0/commit/242af400b657a717258692557e93d1d19aec280e))
* **runner:** attribute pre-spawn concurrency ([#28839](https://github.com/vm0-ai/vm0/issues/28839)) ([5e11ce3](https://github.com/vm0-ai/vm0/commit/5e11ce3b6aedbd502c94dd07ff68a5209cb4e101))

## [0.171.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.171.3...runner-rs-v0.171.4) (2026-08-24)


### Bug Fixes

* **runner:** treat reuse capacity rejection as informational ([#28789](https://github.com/vm0-ai/vm0/issues/28789)) ([13456e3](https://github.com/vm0-ai/vm0/commit/13456e3bb2cc1bdd3cbb10df49bb7dc4ccbcd087))


### Performance Improvements

* **python:** share responses websocket parsing ([#28757](https://github.com/vm0-ai/vm0/issues/28757)) ([8671c2b](https://github.com/vm0-ai/vm0/commit/8671c2bc617aeb0e4aab3318b992524d437e1929))

## [0.171.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.171.2...runner-rs-v0.171.3) (2026-08-24)


### Bug Fixes

* **runner:** log execution time limit at info ([#28750](https://github.com/vm0-ai/vm0/issues/28750)) ([9823447](https://github.com/vm0-ai/vm0/commit/9823447ca397e8ea7d15de12d6de725091987a6c))


### Refactoring

* **python:** centralize buffered auth body framing ([#28752](https://github.com/vm0-ai/vm0/issues/28752)) ([91c4e5d](https://github.com/vm0-ai/vm0/commit/91c4e5d91fb3ae3cd6caf6853df81f22ec68328e))


### Performance Improvements

* **runner:** specialize guest storage manifest invocation ([#28734](https://github.com/vm0-ai/vm0/issues/28734)) ([0255e57](https://github.com/vm0-ai/vm0/commit/0255e57603d27fe97ac342c97af98921dabf2ae9))

## [0.171.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.171.1...runner-rs-v0.171.2) (2026-08-23)


### Bug Fixes

* **rust:** align mock codex rollout paths ([#28692](https://github.com/vm0-ai/vm0/issues/28692)) ([59ecfdb](https://github.com/vm0-ai/vm0/commit/59ecfdbbf4a1402dc5fc85ee460ef88cb0a26e55))

## [0.171.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.171.0...runner-rs-v0.171.1) (2026-08-23)

## [0.171.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.170.2...runner-rs-v0.171.0) (2026-08-23)


### Features

* **api:** add strict pi api first-turn handoff ([#28664](https://github.com/vm0-ai/vm0/issues/28664)) ([4bc9ef0](https://github.com/vm0-ai/vm0/commit/4bc9ef063e244a3f3af8dbc9ab94fd173208b93c))

## [0.170.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.170.1...runner-rs-v0.170.2) (2026-08-22)


### Bug Fixes

* **python:** clamp managed provider retry-after delays ([#28652](https://github.com/vm0-ai/vm0/issues/28652)) ([525dd58](https://github.com/vm0-ai/vm0/commit/525dd588b1cef082c5ced8e419e07e73c469b1de))
* **python:** classify openrouter 500 responses by body ([#28644](https://github.com/vm0-ai/vm0/issues/28644)) ([16bd0b2](https://github.com/vm0-ai/vm0/commit/16bd0b2bca552eee731b7d53cfedf5475b9b5bf3))

## [0.170.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.170.0...runner-rs-v0.170.1) (2026-08-22)


### Bug Fixes

* **python:** share model response classification ([#28633](https://github.com/vm0-ai/vm0/issues/28633)) ([e129ab0](https://github.com/vm0-ai/vm0/commit/e129ab06050e0c71da083fe3afdeb0c294a75c81))


### Refactoring

* **runner:** centralize idle sandbox activation ([#28630](https://github.com/vm0-ai/vm0/issues/28630)) ([f1ac1d9](https://github.com/vm0-ai/vm0/commit/f1ac1d991d29248de4f55cdfad38962d0e711a78))


### Performance Improvements

* **mitm-addon:** reuse chat completions extractor across sse events ([#28629](https://github.com/vm0-ai/vm0/issues/28629)) ([3ca0aea](https://github.com/vm0-ai/vm0/commit/3ca0aea8b5ff3ed249064c7422f18bd16e5fa290))

## [0.170.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.22...runner-rs-v0.170.0) (2026-08-22)


### Features

* **runner:** report trusted model provider failures ([#28532](https://github.com/vm0-ai/vm0/issues/28532)) ([95a6ecd](https://github.com/vm0-ai/vm0/commit/95a6ecd44582d3bedf35b97f6874a01f2d7c6a34))

## [0.169.22](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.21...runner-rs-v0.169.22) (2026-08-22)


### Bug Fixes

* **runner:** recover evicted websocket usage pricing ([#28584](https://github.com/vm0-ai/vm0/issues/28584)) ([6d677e5](https://github.com/vm0-ai/vm0/commit/6d677e500ee8f952a1350db74336ae0e8de5581b))


### Documentation

* **rust:** document session history probe telemetry semantics ([#28581](https://github.com/vm0-ai/vm0/issues/28581)) ([79f3c94](https://github.com/vm0-ai/vm0/commit/79f3c94be735383764b6ce464326865cbb6d7e73))


### Refactoring

* **runner:** centralize procfs process generation ([#28576](https://github.com/vm0-ai/vm0/issues/28576)) ([e35d103](https://github.com/vm0-ai/vm0/commit/e35d1031e8ffcb860e317a4b101831a4d72cdade))

## [0.169.21](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.20...runner-rs-v0.169.21) (2026-08-21)

## [0.169.20](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.19...runner-rs-v0.169.20) (2026-08-21)

## [0.169.19](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.18...runner-rs-v0.169.19) (2026-08-21)


### Bug Fixes

* **runner:** isolate shell tool oom cleanup ([#28391](https://github.com/vm0-ai/vm0/issues/28391)) ([ffb0332](https://github.com/vm0-ai/vm0/commit/ffb03327e60854d4e5e541b34a2f3423cfcee6f2))


### Refactoring

* **python:** centralize openai responses event taxonomy ([#28530](https://github.com/vm0-ai/vm0/issues/28530)) ([1a9c18b](https://github.com/vm0-ai/vm0/commit/1a9c18b0756c1439d83640dc1177f4e585e4544c))
* **python:** centralize streaming encoding capabilities ([#28526](https://github.com/vm0-ai/vm0/issues/28526)) ([4928434](https://github.com/vm0-ai/vm0/commit/4928434db79ca61bc8db5c058d67c26071c7993f))

## [0.169.18](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.17...runner-rs-v0.169.18) (2026-08-21)


### Bug Fixes

* **runner:** guard connector runtime publications ([#28495](https://github.com/vm0-ai/vm0/issues/28495)) ([641136f](https://github.com/vm0-ai/vm0/commit/641136ff637c4436f6f55871faee2647c675edf2))


### Refactoring

* **runner:** centralize gc lock probes ([#28493](https://github.com/vm0-ai/vm0/issues/28493)) ([14a8359](https://github.com/vm0-ai/vm0/commit/14a83594b6f01730b6a53561cac801f686d1fcbd))


### Performance Improvements

* **runner:** reduce workspace cache path allocations ([#28498](https://github.com/vm0-ai/vm0/issues/28498)) ([d08a325](https://github.com/vm0-ai/vm0/commit/d08a3255808888a2962d1ba9737f5f2a1ddff43f))

## [0.169.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.16...runner-rs-v0.169.17) (2026-08-20)


### Bug Fixes

* **runner:** bound firewall catalog response bodies ([#28399](https://github.com/vm0-ai/vm0/issues/28399)) ([1732568](https://github.com/vm0-ai/vm0/commit/17325687f4950e089ce565d1e33737b5822b19be))

## [0.169.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.15...runner-rs-v0.169.16) (2026-08-20)


### Bug Fixes

* **events:** preserve timeout and connect observations ([#28397](https://github.com/vm0-ai/vm0/issues/28397)) ([c3d536e](https://github.com/vm0-ai/vm0/commit/c3d536eab61fca8e2006a7664a982b993537db00))
* **guest-agent:** classify mid-response failures ([#28393](https://github.com/vm0-ai/vm0/issues/28393)) ([4ca21bd](https://github.com/vm0-ai/vm0/commit/4ca21bdbe47a2ce99f34c343b074f83c45775483))
* **guest:** isolate managed claude config from user home ([#28324](https://github.com/vm0-ai/vm0/issues/28324)) ([c6a20ba](https://github.com/vm0-ai/vm0/commit/c6a20babf5f75ffac7ac97f69c570ba1ddb2ef23))
* **python:** bound request header name work ([#28342](https://github.com/vm0-ai/vm0/issues/28342)) ([ffcd0fa](https://github.com/vm0-ai/vm0/commit/ffcd0fa83312ab7f20ed517ba717ee01721fca28))
* **python:** handle x tld snapshot write failures ([#28340](https://github.com/vm0-ai/vm0/issues/28340)) ([9493c43](https://github.com/vm0-ai/vm0/commit/9493c4391e159d3a59bc8c27c73bdb347344bb0d))
* **python:** reject oversized firewall auth expiries ([#28390](https://github.com/vm0-ai/vm0/issues/28390)) ([424cefa](https://github.com/vm0-ai/vm0/commit/424cefa243b6045847ac53cfc6bc831ae4187311))
* **python:** retain multiple prewarm response ids ([#28401](https://github.com/vm0-ai/vm0/issues/28401)) ([dbc7222](https://github.com/vm0-ai/vm0/commit/dbc722260de69a3124d8981e6cb3bb1b56c1ef25))
* **runner:** reconcile stale drain override cleanup ([#28363](https://github.com/vm0-ai/vm0/issues/28363)) ([6e631e3](https://github.com/vm0-ai/vm0/commit/6e631e340efd2084a5a174487e901d0982ddd4fb))
* surface claude terms acceptance failures ([#28314](https://github.com/vm0-ai/vm0/issues/28314)) ([dc0674c](https://github.com/vm0-ai/vm0/commit/dc0674cd33b9b5ec44e592814c4f7b0c3d952575))
* **usage:** bound model usage quantities ([#28351](https://github.com/vm0-ai/vm0/issues/28351)) ([d91265c](https://github.com/vm0-ai/vm0/commit/d91265c8761b3c40eb7e91a8ac6bcfaa0bdad4f8))


### Documentation

* **python:** document conditional authority IPv6 predicate ([#28323](https://github.com/vm0-ai/vm0/issues/28323)) ([c32cbcd](https://github.com/vm0-ai/vm0/commit/c32cbcdb1f02ef7ecc3fc5e4296c2f9faa04609c))
* **python:** document provider timing store locking and retention contract ([#28394](https://github.com/vm0-ai/vm0/issues/28394)) ([7bbaf7d](https://github.com/vm0-ai/vm0/commit/7bbaf7d410c1b7ac0b7d21ede9a08973c367861b))
* **rust:** correct runner gc keep-latest help ([#28336](https://github.com/vm0-ai/vm0/issues/28336)) ([7d457c7](https://github.com/vm0-ai/vm0/commit/7d457c7ba7084e2293e600055cb4056505fecca9))


### Refactoring

* **python:** centralize catalog cache fixtures ([#28339](https://github.com/vm0-ai/vm0/issues/28339)) ([787480b](https://github.com/vm0-ai/vm0/commit/787480b043d6369c245f430e85a130dcec246871))


### Performance Improvements

* **python:** resolve jsonl flush paths once per watcher ([#28349](https://github.com/vm0-ai/vm0/issues/28349)) ([7e730de](https://github.com/vm0-ai/vm0/commit/7e730dec29d40eaf539ad17362bfdaf1f4540e25))
* **runner:** bound local queue job reads ([#28395](https://github.com/vm0-ai/vm0/issues/28395)) ([bf6499b](https://github.com/vm0-ai/vm0/commit/bf6499bebd8d138a75f1bae1547e96178b50c750))
* **runner:** coordinate routine cache gc per host ([#28373](https://github.com/vm0-ai/vm0/issues/28373)) ([ab154d5](https://github.com/vm0-ai/vm0/commit/ab154d56a6545cbd716661d9c57e407d6838bfb5))

## [0.169.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.14...runner-rs-v0.169.15) (2026-08-20)


### Bug Fixes

* **guest:** isolate managed codex home from user home ([#28264](https://github.com/vm0-ai/vm0/issues/28264)) ([d4274c2](https://github.com/vm0-ai/vm0/commit/d4274c2ab1236f0be82390a7598798961b6b0a57))
* **python:** bound iana tld updater response reads ([#28268](https://github.com/vm0-ai/vm0/issues/28268)) ([3b01513](https://github.com/vm0-ai/vm0/commit/3b01513fa02e4b9732c29d5a843d70350ee49c29))


### Documentation

* **python:** correct Anthropic SSE skip recovery test description ([#28263](https://github.com/vm0-ai/vm0/issues/28263)) ([9290f71](https://github.com/vm0-ai/vm0/commit/9290f71c711b58cb28341f696890e3bc1ecde7c4))


### Performance Improvements

* **runner:** reuse serialized firewall auth request ([#28247](https://github.com/vm0-ai/vm0/issues/28247)) ([3143d58](https://github.com/vm0-ai/vm0/commit/3143d58ad457f9ff2b7f58eb32d609a7732f3e94))
* **runner:** share network log path ownership ([#28267](https://github.com/vm0-ai/vm0/issues/28267)) ([437dbb7](https://github.com/vm0-ai/vm0/commit/437dbb7bc47850a00b387fe59debca5ebe91433d))

## [0.169.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.13...runner-rs-v0.169.14) (2026-08-20)


### Bug Fixes

* **runner:** allow large proxied websocket messages ([#28213](https://github.com/vm0-ai/vm0/issues/28213)) ([e77ab8c](https://github.com/vm0-ai/vm0/commit/e77ab8c13fd28b23d060f4ab9c9beb36bcfbe060))
* **runner:** reject pre-tls proxy bytes in firewall auth ([#28223](https://github.com/vm0-ai/vm0/issues/28223)) ([d8b98f0](https://github.com/vm0-ai/vm0/commit/d8b98f0ed46e49162b77a4def9389444de5ef36c))


### Refactoring

* **runner:** centralize sandbox command prerequisites ([#28246](https://github.com/vm0-ai/vm0/issues/28246)) ([8054bc6](https://github.com/vm0-ai/vm0/commit/8054bc6ecaa46dc80f6d2d5d75943af73a36a828))


### Performance Improvements

* **python:** bound firewall auth identity ownership ([#28162](https://github.com/vm0-ai/vm0/issues/28162)) ([08dbfdf](https://github.com/vm0-ai/vm0/commit/08dbfdfabb4837f1c79bf1ea0cee86825dc1a764))
* **runner:** attribute claim response read and decode latency ([#28175](https://github.com/vm0-ai/vm0/issues/28175)) ([f4420d7](https://github.com/vm0-ai/vm0/commit/f4420d74a7cb9dfff9d18833f8321d2484570023))
* **runner:** bound axiom debug field formatting ([#28158](https://github.com/vm0-ai/vm0/issues/28158)) ([3786a98](https://github.com/vm0-ai/vm0/commit/3786a989714d618c77bdcc60c7c17d14ce5d9373))
* **runner:** reserve axiom channel before serialization ([#28161](https://github.com/vm0-ai/vm0/issues/28161)) ([5016d20](https://github.com/vm0-ai/vm0/commit/5016d20e3311571f219f24be77e42df69a8415c2))

## [0.169.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.12...runner-rs-v0.169.13) (2026-08-19)


### Performance Improvements

* **runner:** hand off finalizing sandboxes before idle compaction ([#28063](https://github.com/vm0-ai/vm0/issues/28063)) ([543aae3](https://github.com/vm0-ai/vm0/commit/543aae384b1d6311d0bcceef487ab37bea3f3147))

## [0.169.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.11...runner-rs-v0.169.12) (2026-08-19)


### Refactoring

* **runner:** route host oom probe through bounded commands ([#28119](https://github.com/vm0-ai/vm0/issues/28119)) ([ef5d2cd](https://github.com/vm0-ai/vm0/commit/ef5d2cd3fc414c55acc67162835f3403d0c0db2a))

## [0.169.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.10...runner-rs-v0.169.11) (2026-08-19)


### Bug Fixes

* **python:** track generator advancement failures ([#28107](https://github.com/vm0-ai/vm0/issues/28107)) ([c56f8d5](https://github.com/vm0-ai/vm0/commit/c56f8d5cc628c754880c27dc690d5704cf493df0))


### Documentation

* **runner:** document workspace image cache GC policy ([#28104](https://github.com/vm0-ai/vm0/issues/28104)) ([e178040](https://github.com/vm0-ai/vm0/commit/e178040179027bea9f2863aa5bea3332f3f25016))

## [0.169.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.9...runner-rs-v0.169.10) (2026-08-19)


### Documentation

* **python:** document webhook delivery callback lifecycle ([#28096](https://github.com/vm0-ai/vm0/issues/28096)) ([e94991b](https://github.com/vm0-ai/vm0/commit/e94991becd85d9b350a804ff011b9369b8488791))

## [0.169.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.8...runner-rs-v0.169.9) (2026-08-18)

## [0.169.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.7...runner-rs-v0.169.8) (2026-08-18)


### Performance Improvements

* **runner:** attribute workspace mount guest duration ([#28059](https://github.com/vm0-ai/vm0/issues/28059)) ([7b94559](https://github.com/vm0-ai/vm0/commit/7b94559e3942ebbcfb88e7d287b59cc777386977))

## [0.169.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.6...runner-rs-v0.169.7) (2026-08-18)


### Documentation

* **python:** clarify Anthropic JSON metadata-only results ([#28012](https://github.com/vm0-ai/vm0/issues/28012)) ([bfcb999](https://github.com/vm0-ai/vm0/commit/bfcb999669fa226f88bc26a89fa27edc94d885d1))
* **python:** clarify X tweet body refinement conditions ([#27968](https://github.com/vm0-ai/vm0/issues/27968)) ([bd19e2d](https://github.com/vm0-ai/vm0/commit/bd19e2dbdc3554420b05d665008d9039c005aca3))


### Refactoring

* **runner:** centralize private file validation ([#28019](https://github.com/vm0-ai/vm0/issues/28019)) ([2f7f7da](https://github.com/vm0-ai/vm0/commit/2f7f7dafe3c2801e270d2d6baf07e6c6fd105c08))
* **rust:** generate codex runtime config ([#28035](https://github.com/vm0-ai/vm0/issues/28035)) ([de3d53b](https://github.com/vm0-ai/vm0/commit/de3d53ba1c521a9a623552fe33e71e61da37b145))


### Performance Improvements

* **runner:** defer workspace cache gc to routine maintenance ([#28026](https://github.com/vm0-ai/vm0/issues/28026)) ([c408e32](https://github.com/vm0-ai/vm0/commit/c408e32f4e09d1c6484e4df8744f6d351fff7166))
* **runner:** measure claim http duration ([#28029](https://github.com/vm0-ai/vm0/issues/28029)) ([974ba54](https://github.com/vm0-ai/vm0/commit/974ba54e70dbf7e6f12a9516d62d61e17f7c88cd))

## [0.169.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.5...runner-rs-v0.169.6) (2026-08-18)


### Bug Fixes

* **python:** fail closed on unsafe platform api paths ([#27944](https://github.com/vm0-ai/vm0/issues/27944)) ([490b2f5](https://github.com/vm0-ai/vm0/commit/490b2f5ab57211c277f295f48a8dab9b6144973b))


### Performance Improvements

* **python:** batch firewall auth query injection ([#27932](https://github.com/vm0-ai/vm0/issues/27932)) ([d46487f](https://github.com/vm0-ai/vm0/commit/d46487f9911378c1ea7dff89c4bc08b3d04f30ee))

## [0.169.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.4...runner-rs-v0.169.5) (2026-08-18)


### Bug Fixes

* **python:** bound body capture dependency headers ([#27869](https://github.com/vm0-ai/vm0/issues/27869)) ([60911fa](https://github.com/vm0-ai/vm0/commit/60911fa460886c2c2b9f073aedb632dbcfdf1362))


### Documentation

* **rust:** align pi launch contract docs with schema v2 ([#27851](https://github.com/vm0-ai/vm0/issues/27851)) ([b42e81c](https://github.com/vm0-ai/vm0/commit/b42e81ca8080bbffc3d2d79a4566b8b2d766eceb))


### Refactoring

* **python:** share builtin base url template layout ([#27864](https://github.com/vm0-ai/vm0/issues/27864)) ([2f62b71](https://github.com/vm0-ai/vm0/commit/2f62b712b78ff8722c0e6b547f2958f3efc1a608))
* **rust:** neutralize session-history identity type names ([#27895](https://github.com/vm0-ai/vm0/issues/27895)) ([fff9b30](https://github.com/vm0-ai/vm0/commit/fff9b3074cc4e590b2fdb4318da515fcc4605a70))

## [0.169.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.3...runner-rs-v0.169.4) (2026-08-18)


### Bug Fixes

* **runner:** preserve valid network logs around invalid UTF-8 lines ([#27874](https://github.com/vm0-ai/vm0/issues/27874)) ([eedc460](https://github.com/vm0-ai/vm0/commit/eedc460c1f93f60602caba66376226d42733dd86))

## [0.169.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.2...runner-rs-v0.169.3) (2026-08-18)


### Documentation

* **python:** clarify unconnected destination match semantics ([#27845](https://github.com/vm0-ai/vm0/issues/27845)) ([fb3f882](https://github.com/vm0-ai/vm0/commit/fb3f8829b2e03f2eabf16c2c9f5beb222b1c391b))


### Refactoring

* **runner:** canonicalize restored session identity enums ([#27862](https://github.com/vm0-ai/vm0/issues/27862)) ([6d1b233](https://github.com/vm0-ai/vm0/commit/6d1b23334818f9bf6efb1b7a3983256964af7005))

## [0.169.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.1...runner-rs-v0.169.2) (2026-08-18)


### Performance Improvements

* **runner:** make idle vm reclamation capacity-driven ([#27778](https://github.com/vm0-ai/vm0/issues/27778)) ([84f0e1f](https://github.com/vm0-ai/vm0/commit/84f0e1f649e6c75595bd4514252b6a4752c832e0))

## [0.169.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.169.0...runner-rs-v0.169.1) (2026-08-18)

## [0.169.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.26...runner-rs-v0.169.0) (2026-08-17)


### Features

* preserve exact connector source identity ([#27754](https://github.com/vm0-ai/vm0/issues/27754)) ([9421173](https://github.com/vm0-ai/vm0/commit/9421173e27901f8e0d892290e806accb31138a95))

## [0.168.26](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.25...runner-rs-v0.168.26) (2026-08-17)


### Bug Fixes

* **python:** retain prewarm ids across terminal frames ([#27755](https://github.com/vm0-ai/vm0/issues/27755)) ([b0fb20e](https://github.com/vm0-ai/vm0/commit/b0fb20e04461854068c133be7088714ef5f04702))


### Refactoring

* **python:** make metadata visitor own statement flow ([#27740](https://github.com/vm0-ai/vm0/issues/27740)) ([508b6a7](https://github.com/vm0-ai/vm0/commit/508b6a701d6f6303c0925be6a48c67793bb162bd))
* **runner:** centralize raw http test fixture ([#27682](https://github.com/vm0-ai/vm0/issues/27682)) ([f2405f5](https://github.com/vm0-ai/vm0/commit/f2405f560cd4f5944b6b435569735912188c58ff))

## [0.168.25](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.24...runner-rs-v0.168.25) (2026-08-17)


### Bug Fixes

* **python:** bound codex prefetch marker parsing ([#27725](https://github.com/vm0-ai/vm0/issues/27725)) ([44934b3](https://github.com/vm0-ai/vm0/commit/44934b36f181518713f0ed2ff86bb2967d0ab45c))


### Documentation

* **python:** correct connector module ownership guidance ([#27723](https://github.com/vm0-ai/vm0/issues/27723)) ([c77e793](https://github.com/vm0-ai/vm0/commit/c77e7937ca6c78d208eb0c25a79156832cc60e88))

## [0.168.24](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.23...runner-rs-v0.168.24) (2026-08-17)


### Refactoring

* **python:** extract model websocket usage lifecycle ([#27684](https://github.com/vm0-ai/vm0/issues/27684)) ([2b83830](https://github.com/vm0-ai/vm0/commit/2b83830a2b06b6b38e3a2c550f723bd4a703794d))

## [0.168.23](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.22...runner-rs-v0.168.23) (2026-08-17)

## [0.168.22](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.21...runner-rs-v0.168.22) (2026-08-17)


### Performance Improvements

* **python:** bound connector-intent header capture ([#27649](https://github.com/vm0-ai/vm0/issues/27649)) ([9c60e64](https://github.com/vm0-ai/vm0/commit/9c60e64ce8ca7d63b4a80b7125fef72b583e6fda))

## [0.168.21](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.20...runner-rs-v0.168.21) (2026-08-17)


### Refactoring

* **python:** split runner flush tests by protocol lifecycle ([#27631](https://github.com/vm0-ai/vm0/issues/27631)) ([16dd3fb](https://github.com/vm0-ai/vm0/commit/16dd3fbf3ecb160336de737d487abac1da53d5d9))
* **runner:** centralize process identity ([#27642](https://github.com/vm0-ai/vm0/issues/27642)) ([9b04c94](https://github.com/vm0-ai/vm0/commit/9b04c942804459bc408ccd0586a6008e7b263c06))


### Performance Improvements

* **python:** bound browser user-agent classification work ([#27639](https://github.com/vm0-ai/vm0/issues/27639)) ([7a008ec](https://github.com/vm0-ai/vm0/commit/7a008ec753aa66731385f4dcbd4410040355cf84))

## [0.168.20](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.19...runner-rs-v0.168.20) (2026-08-16)


### Bug Fixes

* **runner:** fail open on overlapping websocket prewarm correlation ([#27584](https://github.com/vm0-ai/vm0/issues/27584)) ([fc52c8b](https://github.com/vm0-ai/vm0/commit/fc52c8b5b57cf47c8170b4e4db622d1fdc6abdb2))

## [0.168.19](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.18...runner-rs-v0.168.19) (2026-08-16)


### Performance Improvements

* **runner:** expose physical park substage telemetry ([#27561](https://github.com/vm0-ai/vm0/issues/27561)) ([98c8737](https://github.com/vm0-ai/vm0/commit/98c873732d2d71f0840561dfcb2931751c31a037))

## [0.168.18](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.17...runner-rs-v0.168.18) (2026-08-16)


### Refactoring

* **runner:** split trusted authority and auth base rewriting ([#27565](https://github.com/vm0-ai/vm0/issues/27565)) ([0c65a9f](https://github.com/vm0-ai/vm0/commit/0c65a9f223647008ae5c4c514c54020c5e678634))
* **runner:** unify reuse-preparation exit status ownership ([#27559](https://github.com/vm0-ai/vm0/issues/27559)) ([54c4459](https://github.com/vm0-ai/vm0/commit/54c44592c0f9936f227d0e10a493085230f77350))
* **rust:** centralize bounded object-download retry policy ([#27557](https://github.com/vm0-ai/vm0/issues/27557)) ([6b90ae3](https://github.com/vm0-ai/vm0/commit/6b90ae350361c662e88470fc1c8cbac0e31bc8ee))

## [0.168.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.16...runner-rs-v0.168.17) (2026-08-16)


### Performance Improvements

* **runner:** attribute sandbox telemetry by runner name ([#27464](https://github.com/vm0-ai/vm0/issues/27464)) ([70b634b](https://github.com/vm0-ai/vm0/commit/70b634b39f2c1a71ce8c82855fb512e583b85668))

## [0.168.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.15...runner-rs-v0.168.16) (2026-08-15)


### Bug Fixes

* **guest-agent:** remove session history marker authority ([#27284](https://github.com/vm0-ai/vm0/issues/27284)) ([1bf8617](https://github.com/vm0-ai/vm0/commit/1bf8617d3a04b6beccba5f81795d57476e728ffe))


### Refactoring

* **runner:** centralize human-readable byte formatting ([#27372](https://github.com/vm0-ai/vm0/issues/27372)) ([960b374](https://github.com/vm0-ai/vm0/commit/960b374d2e708d4ae35195a291faa89b2d5aa47e))
* **runner:** make storage cache background fills runner-owned ([#27387](https://github.com/vm0-ai/vm0/issues/27387)) ([d9e8990](https://github.com/vm0-ai/vm0/commit/d9e8990c50ec69cba14bdd7b7b5926fdc75a8ee4))

## [0.168.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.14...runner-rs-v0.168.15) (2026-08-15)


### Bug Fixes

* **runner:** start workspace cache lock timeout after contention ([#27312](https://github.com/vm0-ai/vm0/issues/27312)) ([cdc2a57](https://github.com/vm0-ai/vm0/commit/cdc2a572d74b719cd1fd78623459ea2c2f289d55))

## [0.168.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.13...runner-rs-v0.168.14) (2026-08-14)


### Refactoring

* **pi:** use official resources and jsonl sessions ([#27288](https://github.com/vm0-ai/vm0/issues/27288)) ([b287f72](https://github.com/vm0-ai/vm0/commit/b287f7270f0fd0613adff61ab91289b73e39e7f6))

## [0.168.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.12...runner-rs-v0.168.13) (2026-08-14)

## [0.168.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.11...runner-rs-v0.168.12) (2026-08-14)

## [0.168.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.10...runner-rs-v0.168.11) (2026-08-14)

## [0.168.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.9...runner-rs-v0.168.10) (2026-08-14)


### Bug Fixes

* **runner:** canonicalize credential endpoint hostnames ([#27140](https://github.com/vm0-ai/vm0/issues/27140)) ([735a12a](https://github.com/vm0-ai/vm0/commit/735a12a73e6bfa2b137cde1a0a4c8a6b618ca7a7))


### Performance Improvements

* **runner:** scan procfs in one blocking task ([#27164](https://github.com/vm0-ai/vm0/issues/27164)) ([dc83f3d](https://github.com/vm0-ai/vm0/commit/dc83f3dbcaa6aad572258cb34dad52cf1ddeb5ee))

## [0.168.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.8...runner-rs-v0.168.9) (2026-08-14)


### Bug Fixes

* **python:** require platform api scheme match ([#27134](https://github.com/vm0-ai/vm0/issues/27134)) ([2e1bd6f](https://github.com/vm0-ai/vm0/commit/2e1bd6fc6d7c476af46bbab85fc51136af811efd))


### Refactoring

* **mitm-addon:** split sse usage tests by provider lifecycle ([#27123](https://github.com/vm0-ai/vm0/issues/27123)) ([080ee37](https://github.com/vm0-ai/vm0/commit/080ee3729eea2d5aea2403689da99f1fd1bc003b))

## [0.168.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.7...runner-rs-v0.168.8) (2026-08-14)


### Refactoring

* **pi:** build the pi prompt inside the sandbox ([#27036](https://github.com/vm0-ai/vm0/issues/27036)) ([1e248af](https://github.com/vm0-ai/vm0/commit/1e248afd1118468a8950f81c668d65b27fe6f429))


### Performance Improvements

* **runner:** skip idempotent connector registry writes ([#27073](https://github.com/vm0-ai/vm0/issues/27073)) ([6d110bc](https://github.com/vm0-ai/vm0/commit/6d110bc15e33d46288292d1b8e54aea03900c479))

## [0.168.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.6...runner-rs-v0.168.7) (2026-08-14)

## [0.168.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.5...runner-rs-v0.168.6) (2026-08-13)


### Performance Improvements

* **runner:** publish shared workspace cache changes promptly ([#26743](https://github.com/vm0-ai/vm0/issues/26743)) ([720569c](https://github.com/vm0-ai/vm0/commit/720569cbf6102160e77a67e688a1dc8c57470843))

## [0.168.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.4...runner-rs-v0.168.5) (2026-08-13)

## [0.168.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.3...runner-rs-v0.168.4) (2026-08-13)


### Refactoring

* **python:** require cli agent type in proxy registry ([#26933](https://github.com/vm0-ai/vm0/issues/26933)) ([ba18bf4](https://github.com/vm0-ai/vm0/commit/ba18bf4bd7b430842d42da3de522f6d29860918a))
* **runner:** generate contract-owned decode paths ([#26931](https://github.com/vm0-ai/vm0/issues/26931)) ([8145f56](https://github.com/vm0-ai/vm0/commit/8145f56bcaf853c3709141ca02dfc735901b0b7a))
* **rust:** share active-input control payload contract ([#26950](https://github.com/vm0-ai/vm0/issues/26950)) ([403bfd8](https://github.com/vm0-ai/vm0/commit/403bfd8f08fcd272d7c39df9149b1aa9124dca42))

## [0.168.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.2...runner-rs-v0.168.3) (2026-08-13)


### Performance Improvements

* **runner:** reduce gc tree walk task handoffs ([#26920](https://github.com/vm0-ai/vm0/issues/26920)) ([2133a7f](https://github.com/vm0-ai/vm0/commit/2133a7f016b8eac193943e8195d07cc0b740ea41))

## [0.168.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.1...runner-rs-v0.168.2) (2026-08-13)


### Bug Fixes

* **runner:** preserve guest control headroom under workload pressure ([#26683](https://github.com/vm0-ai/vm0/issues/26683)) ([789adcd](https://github.com/vm0-ai/vm0/commit/789adcd9e7a35dc545ae660f4b5a55d802ea854f))


### Documentation

* **runner:** correct JobProvider shutdown contract ([#26867](https://github.com/vm0-ai/vm0/issues/26867)) ([9eb6d8b](https://github.com/vm0-ai/vm0/commit/9eb6d8b6bcc2a2ae01118dd0ad9de823b50726ca))


### Refactoring

* **python:** separate x response inspection ([#26872](https://github.com/vm0-ai/vm0/issues/26872)) ([3013216](https://github.com/vm0-ai/vm0/commit/30132164b6b4f89b0ec25551302ec2ef9e6e8553))
* remove sandbox presentation import pipeline ([#26646](https://github.com/vm0-ai/vm0/issues/26646)) ([54601f1](https://github.com/vm0-ai/vm0/commit/54601f1aedeb78825f2e8c63760b9c94b41009c0))
* **rust:** centralize nbd orphan cleanup ownership ([#26880](https://github.com/vm0-ai/vm0/issues/26880)) ([0690874](https://github.com/vm0-ai/vm0/commit/069087456bdaf89f4ee8586ee1f5c1497c956f94))


### Performance Improvements

* **mitm-addon:** bound path validation work ([#26855](https://github.com/vm0-ai/vm0/issues/26855)) ([0db7ccc](https://github.com/vm0-ai/vm0/commit/0db7cccccff216be2869cb7561ac37a8114751cd))

## [0.168.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.168.0...runner-rs-v0.168.1) (2026-08-13)


### Bug Fixes

* **connectors:** require pinned custom runtime registrations ([#26854](https://github.com/vm0-ai/vm0/issues/26854)) ([7a80c6c](https://github.com/vm0-ai/vm0/commit/7a80c6c506db436956c7a8e23dafa7d6c9014955))
* **runner:** avoid world-writable kvm access ([#26797](https://github.com/vm0-ai/vm0/issues/26797)) ([ad737ac](https://github.com/vm0-ai/vm0/commit/ad737ac997fcfb2cfa27de69caf1e74efc0e629d))


### Documentation

* **python:** document content-length parse result semantics ([#26837](https://github.com/vm0-ai/vm0/issues/26837)) ([3964241](https://github.com/vm0-ai/vm0/commit/39642416f57ccea56d79afc67127c595adb94067))
* **runner:** explain drain and resume invariants ([#26821](https://github.com/vm0-ai/vm0/issues/26821)) ([11896de](https://github.com/vm0-ai/vm0/commit/11896de8ed8f8be484463d24cbc3f3083715c769))


### Refactoring

* **python:** separate auth.base transport ([#26847](https://github.com/vm0-ai/vm0/issues/26847)) ([08c823d](https://github.com/vm0-ai/vm0/commit/08c823d462dda5c8105081ce72ae06607d6dc288))


### Performance Improvements

* **python:** stagger firewall auth address attempts ([#26787](https://github.com/vm0-ai/vm0/issues/26787)) ([6f87d56](https://github.com/vm0-ai/vm0/commit/6f87d567dfe68b738a005a1c01bd568e6a33959f))

## [0.168.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.167.0...runner-rs-v0.168.0) (2026-08-13)


### Features

* **runner:** migrate pi child environment to okou ([#26810](https://github.com/vm0-ai/vm0/issues/26810)) ([9c54e70](https://github.com/vm0-ai/vm0/commit/9c54e70777750b608dad06fde2a44a5a08f9796b))


### Refactoring

* rename workspace packages to [@okouai](https://github.com/okouai) ([#26817](https://github.com/vm0-ai/vm0/issues/26817)) ([ae9c867](https://github.com/vm0-ai/vm0/commit/ae9c8678eb06686dcaaeda2e923f487df8250e5d))

## [0.167.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.166.0...runner-rs-v0.167.0) (2026-08-13)


### Features

* **runner:** migrate run identity env to okou ([#26796](https://github.com/vm0-ai/vm0/issues/26796)) ([88850c3](https://github.com/vm0-ai/vm0/commit/88850c33b9bb20018d9e0fd12097cc5eb7fb2bde))


### Refactoring

* **python:** centralize stream capture metadata validation ([#26784](https://github.com/vm0-ai/vm0/issues/26784)) ([cda9f38](https://github.com/vm0-ai/vm0/commit/cda9f38e3369601248c2a2f8201f82368eb0bfc8))

## [0.166.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.165.3...runner-rs-v0.166.0) (2026-08-13)


### Features

* **api:** retire chat event reads and force app upgrade ([#26755](https://github.com/vm0-ai/vm0/issues/26755)) ([7be323f](https://github.com/vm0-ai/vm0/commit/7be323f3f555183be738a3ee0fe158d3d4327e0a))

## [0.165.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.165.2...runner-rs-v0.165.3) (2026-08-12)


### Refactoring

* **pi:** persist sandbox sessions in native sqlite ([#26555](https://github.com/vm0-ai/vm0/issues/26555)) ([9ed505e](https://github.com/vm0-ai/vm0/commit/9ed505e1c567ff019d521fac167700c2b390cffe))

## [0.165.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.165.1...runner-rs-v0.165.2) (2026-08-12)


### Refactoring

* **runner:** remove immediate successor observation ([#26690](https://github.com/vm0-ai/vm0/issues/26690)) ([b4c2791](https://github.com/vm0-ai/vm0/commit/b4c27913f4bf26cfd23c933cc47c6560d4da0bb8))

## [0.165.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.165.0...runner-rs-v0.165.1) (2026-08-12)


### Bug Fixes

* **python:** preserve unbalanced base literal scope ([#26638](https://github.com/vm0-ai/vm0/issues/26638)) ([5417209](https://github.com/vm0-ai/vm0/commit/5417209967ad103cf9bb3b8f6b1e51203c5b5d52))


### Refactoring

* **chat:** remove active input rollout compatibility ([#26625](https://github.com/vm0-ai/vm0/issues/26625)) ([8d1be07](https://github.com/vm0-ai/vm0/commit/8d1be07f2d1665a02d86cb2ef550fa9a1f1e212a))
* **python:** centralize model json usage protocol dispatch ([#26641](https://github.com/vm0-ai/vm0/issues/26641)) ([122a18f](https://github.com/vm0-ai/vm0/commit/122a18f98550bfc5f658c35ce1db1b3b353fad36))


### Performance Improvements

* **python:** bound auth.base trusted query rewrites ([#26618](https://github.com/vm0-ai/vm0/issues/26618)) ([5af78da](https://github.com/vm0-ai/vm0/commit/5af78da6e1bb77b715a0182a752de987a5d40529))
* **runner:** avoid connector runtime sync head-of-line blocking ([#26539](https://github.com/vm0-ai/vm0/issues/26539)) ([67c483b](https://github.com/vm0-ai/vm0/commit/67c483b15c4ee9846e790891bc0ad9504d63b044))

## [0.165.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.164.6...runner-rs-v0.165.0) (2026-08-12)


### Features

* **protocol:** cut first-party clients over to okou ([#26549](https://github.com/vm0-ai/vm0/issues/26549)) ([8b1670c](https://github.com/vm0-ai/vm0/commit/8b1670c218fc1a1f326f720368eaa3a65b137ffa))


### Refactoring

* **rust:** centralize pre-sandbox run payload validation ([#26552](https://github.com/vm0-ai/vm0/issues/26552)) ([be7cf76](https://github.com/vm0-ai/vm0/commit/be7cf76888a94e7487ca6a849905234af1e212c0))


### Performance Improvements

* **python:** bound connector diagnostic query inspection ([#26607](https://github.com/vm0-ai/vm0/issues/26607)) ([8371053](https://github.com/vm0-ai/vm0/commit/8371053ed6bd3a90c9e8936c7e14e10771dfe7f8))

## [0.164.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.164.5...runner-rs-v0.164.6) (2026-08-12)


### Refactoring

* **python:** centralize billable model categories ([#26529](https://github.com/vm0-ai/vm0/issues/26529)) ([64b5b42](https://github.com/vm0-ai/vm0/commit/64b5b4285c7035d3d0173bf8a6aca88f3068e45e))


### Performance Improvements

* **python:** bound sigv4 query-pair cardinality ([#26534](https://github.com/vm0-ai/vm0/issues/26534)) ([1db44b9](https://github.com/vm0-ai/vm0/commit/1db44b9d4a41427fc2c635b75ed2e01bb9aab9e8))
* **runner:** batch terminal connector fail-close ([#26538](https://github.com/vm0-ai/vm0/issues/26538)) ([8a25ecc](https://github.com/vm0-ai/vm0/commit/8a25ecc412bcaa3facbcd05d886421836d094a0a))

## [0.164.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.164.4...runner-rs-v0.164.5) (2026-08-12)


### Refactoring

* **python:** use bounded reads for runner flush markers ([#26527](https://github.com/vm0-ai/vm0/issues/26527)) ([f60e02c](https://github.com/vm0-ai/vm0/commit/f60e02cd5539ab1e3f43a0181acbef2b6f4c22ae))

## [0.164.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.164.3...runner-rs-v0.164.4) (2026-08-12)

## [0.164.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.164.2...runner-rs-v0.164.3) (2026-08-12)

## [0.164.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.164.1...runner-rs-v0.164.2) (2026-08-12)


### Bug Fixes

* **python:** centralize firewall permission name validation ([#26469](https://github.com/vm0-ai/vm0/issues/26469)) ([050cfa5](https://github.com/vm0-ai/vm0/commit/050cfa5ca8240a61188730edd455846950d7f8cb))
* **python:** preserve malformed base literal scope ([#26471](https://github.com/vm0-ai/vm0/issues/26471)) ([9a7ddfa](https://github.com/vm0-ai/vm0/commit/9a7ddfa9c07363b506be03c42613c4ed92ed8f0e))

## [0.164.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.164.0...runner-rs-v0.164.1) (2026-08-12)


### Documentation

* **python:** clarify firewall auth error contract ([#26447](https://github.com/vm0-ai/vm0/issues/26447)) ([7e4536e](https://github.com/vm0-ai/vm0/commit/7e4536e33bb7f419568d3b69ef69de252c9ac83b))


### Refactoring

* **runner:** centralize setup directory trust walking ([#26452](https://github.com/vm0-ai/vm0/issues/26452)) ([8bad407](https://github.com/vm0-ai/vm0/commit/8bad407c14ff99234da695cef441bd34d5a9e41c))

## [0.164.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.163.6...runner-rs-v0.164.0) (2026-08-11)


### Features

* **runner:** enable durable active-input delivery ([#26392](https://github.com/vm0-ai/vm0/issues/26392)) ([6225b5e](https://github.com/vm0-ai/vm0/commit/6225b5e85da2833f011830d21498744893b2f625))


### Refactoring

* remove retired model rollout compatibility ([#26413](https://github.com/vm0-ai/vm0/issues/26413)) ([42dfddf](https://github.com/vm0-ai/vm0/commit/42dfddfd80d393d7794868c0469c8e843f09660f))

## [0.163.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.163.5...runner-rs-v0.163.6) (2026-08-11)


### Bug Fixes

* **runner:** preserve completion telemetry timestamp ([#26395](https://github.com/vm0-ai/vm0/issues/26395)) ([434bdad](https://github.com/vm0-ai/vm0/commit/434bdad7a497168f023e8a5040dad3987c15f2ab))

## [0.163.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.163.4...runner-rs-v0.163.5) (2026-08-11)


### Bug Fixes

* **runner:** validate h1 absolute-form authorities ([#26323](https://github.com/vm0-ai/vm0/issues/26323)) ([1c7edb2](https://github.com/vm0-ai/vm0/commit/1c7edb237e43afeb838c8478004333c7467bc39d))


### Refactoring

* **python:** centralize counter underbilling emission ([#26336](https://github.com/vm0-ai/vm0/issues/26336)) ([da94429](https://github.com/vm0-ai/vm0/commit/da94429af94c1c2ec8ab7c0069d85dd569bcdab2))

## [0.163.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.163.3...runner-rs-v0.163.4) (2026-08-11)


### Bug Fixes

* **runner:** bound workspace copy subprocess cleanup ([#26306](https://github.com/vm0-ai/vm0/issues/26306)) ([090deab](https://github.com/vm0-ai/vm0/commit/090deab41074cd464cc8cb85eb33628c2cf711f5))
* **runner:** require exact dnsmasq executable matching ([#26296](https://github.com/vm0-ai/vm0/issues/26296)) ([8141bfa](https://github.com/vm0-ai/vm0/commit/8141bfa77796ea7d7f1c7c10049ec077ce6c0c4b))


### Refactoring

* **connectors:** remove runtime candidate readers ([#26307](https://github.com/vm0-ai/vm0/issues/26307)) ([72a8548](https://github.com/vm0-ai/vm0/commit/72a8548767d4bcb4c147a717ead50fa6cc4e58e2))

## [0.163.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.163.2...runner-rs-v0.163.3) (2026-08-11)

## [0.163.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.163.1...runner-rs-v0.163.2) (2026-08-11)


### Bug Fixes

* **connectors:** reconcile custom and builtin firewall candidates ([#26186](https://github.com/vm0-ai/vm0/issues/26186)) ([53ce4b8](https://github.com/vm0-ai/vm0/commit/53ce4b865a2e15de2941591051ffc4e7c4a3e8c9))


### Performance Improvements

* **runner:** observe immediate successor intent ([#26150](https://github.com/vm0-ai/vm0/issues/26150)) ([b70479b](https://github.com/vm0-ai/vm0/commit/b70479b296eccd27dc51f7c6acaf9635e4eba094))

## [0.163.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.163.0...runner-rs-v0.163.1) (2026-08-11)


### Refactoring

* **connectors:** narrow runtime sync states ([#26194](https://github.com/vm0-ai/vm0/issues/26194)) ([0f5b3cf](https://github.com/vm0-ai/vm0/commit/0f5b3cf64a4837c89d87c6b04cc18a860b442963))

## [0.163.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.162.14...runner-rs-v0.163.0) (2026-08-10)


### Features

* add priority inheritance and gpt-5.6 fast billing ([#26147](https://github.com/vm0-ai/vm0/issues/26147)) ([3350fbb](https://github.com/vm0-ai/vm0/commit/3350fbbec7afa95483d0b051e6580fa969a50b10))

## [0.162.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.162.13...runner-rs-v0.162.14) (2026-08-10)

## [0.162.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.162.12...runner-rs-v0.162.13) (2026-08-10)


### Bug Fixes

* **runner:** accept valid templated firewall catalog bases ([#26168](https://github.com/vm0-ai/vm0/issues/26168)) ([3d97908](https://github.com/vm0-ai/vm0/commit/3d97908f90ab5ecf8ab58b685f419529a3ccb46d))

## [0.162.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.162.11...runner-rs-v0.162.12) (2026-08-10)


### Refactoring

* **connectors:** unify runtime wakeup discovery ([#26156](https://github.com/vm0-ai/vm0/issues/26156)) ([5ef4127](https://github.com/vm0-ai/vm0/commit/5ef41272d6ee5ecf1b7898e6fa6a743e83ccd922))

## [0.162.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.162.10...runner-rs-v0.162.11) (2026-08-10)


### Bug Fixes

* install noto fonts in sandbox images ([#26113](https://github.com/vm0-ai/vm0/issues/26113)) ([d561785](https://github.com/vm0-ai/vm0/commit/d56178597c6afa8149336c924196836a58ad5898))


### Performance Improvements

* **python:** bound and reuse sigv4 request inspection ([#26141](https://github.com/vm0-ai/vm0/issues/26141)) ([7c1d422](https://github.com/vm0-ai/vm0/commit/7c1d42257d37c9b213d4ed25cee57de0aeb87617))

## [0.162.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.162.9...runner-rs-v0.162.10) (2026-08-10)


### Bug Fixes

* **mitm-addon:** distinguish repeated-slash diagnostic bases ([#26100](https://github.com/vm0-ai/vm0/issues/26100)) ([0a8bb82](https://github.com/vm0-ai/vm0/commit/0a8bb821545d23bede3ae075e711baa1c648dccb))
* **runner:** frame rootfs hash inputs ([#26122](https://github.com/vm0-ai/vm0/issues/26122)) ([8c38ec3](https://github.com/vm0-ai/vm0/commit/8c38ec3dbd7d48d04e4e5b06607393305c82d850))


### Refactoring

* **python:** centralize synthetic json framing ([#26117](https://github.com/vm0-ai/vm0/issues/26117)) ([b5e9b13](https://github.com/vm0-ai/vm0/commit/b5e9b13e9bc887836faf617eff3887070428b317))

## [0.162.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.162.8...runner-rs-v0.162.9) (2026-08-10)


### Bug Fixes

* **mitm-addon:** reject non-list custom connector apis ([#26114](https://github.com/vm0-ai/vm0/issues/26114)) ([cb75f7e](https://github.com/vm0-ai/vm0/commit/cb75f7e81a13ee39e7ca4603509ba6a6e61b63a9))

## [0.162.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.162.7...runner-rs-v0.162.8) (2026-08-10)


### Bug Fixes

* **mitm-addon:** reject partial firewall auth success ([#26064](https://github.com/vm0-ai/vm0/issues/26064)) ([b584c72](https://github.com/vm0-ai/vm0/commit/b584c72bd0059ac3ef931bc648b78f4627e05bba))


### Documentation

* **mitm-addon:** document usage buffer state transitions ([#26053](https://github.com/vm0-ai/vm0/issues/26053)) ([9295685](https://github.com/vm0-ai/vm0/commit/9295685e1da68866fad050f3ee82fc32b1f84865))


### Refactoring

* **python:** centralize firewall auth phase policy ([#26057](https://github.com/vm0-ai/vm0/issues/26057)) ([666403c](https://github.com/vm0-ai/vm0/commit/666403ca496452cf7d3364cf4ebf68dc953442a0))

## [0.162.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.162.6...runner-rs-v0.162.7) (2026-08-10)


### Refactoring

* **runner:** centralize workspace cache entry paths ([#26047](https://github.com/vm0-ai/vm0/issues/26047)) ([9b8832f](https://github.com/vm0-ai/vm0/commit/9b8832f1b780b05a3f649596934d44dbee66fc26))

## [0.162.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.162.5...runner-rs-v0.162.6) (2026-08-10)


### Bug Fixes

* **runner:** attribute severe balloon retention ([#26038](https://github.com/vm0-ai/vm0/issues/26038)) ([d996ab7](https://github.com/vm0-ai/vm0/commit/d996ab715ff06c03dee96b82f683e577c7e52b89))

## [0.162.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.162.4...runner-rs-v0.162.5) (2026-08-10)


### Bug Fixes

* **python:** lint annotation-only metadata subscripts ([#26004](https://github.com/vm0-ai/vm0/issues/26004)) ([3ef3077](https://github.com/vm0-ai/vm0/commit/3ef307722af77d85af87ea21fe03cf1796670fdc))
* **runner:** preserve sidecar export failure causes ([#25999](https://github.com/vm0-ai/vm0/issues/25999)) ([76c5c0a](https://github.com/vm0-ai/vm0/commit/76c5c0a8470eecbce17615134b3a6f6c306a98a9))

## [0.162.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.162.3...runner-rs-v0.162.4) (2026-08-10)


### Documentation

* **python:** document catalog cache lifecycle ([#25988](https://github.com/vm0-ai/vm0/issues/25988)) ([56acb90](https://github.com/vm0-ai/vm0/commit/56acb90b0b3cd796186859ff3c2085c0805f6734))


### Refactoring

* **python:** centralize usage counter ownership ([#25987](https://github.com/vm0-ai/vm0/issues/25987)) ([bde3f23](https://github.com/vm0-ai/vm0/commit/bde3f23548737c9293bc8c4697db1c5059a1d74f))

## [0.162.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.162.2...runner-rs-v0.162.3) (2026-08-10)


### Bug Fixes

* **runner:** publish finalizing sandbox before completion ([#25961](https://github.com/vm0-ai/vm0/issues/25961)) ([5dd0213](https://github.com/vm0-ai/vm0/commit/5dd021336942d5407b241b8d449ae884636925ed))

## [0.162.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.162.1...runner-rs-v0.162.2) (2026-08-09)


### Bug Fixes

* **mitm-addon:** track chat completions usage ([#25946](https://github.com/vm0-ai/vm0/issues/25946)) ([b933ace](https://github.com/vm0-ai/vm0/commit/b933acebbde6a7707e07db17af50cac114a37a27))

## [0.162.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.162.0...runner-rs-v0.162.1) (2026-08-09)


### Refactoring

* **connectors:** remove legacy runtime compatibility ([#25941](https://github.com/vm0-ai/vm0/issues/25941)) ([e2cd0fe](https://github.com/vm0-ai/vm0/commit/e2cd0fe886dd0c903ba7322fabd93dca38d80ba0))

## [0.162.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.161.7...runner-rs-v0.162.0) (2026-08-09)


### Features

* persist and display runner reuse outcomes ([#25942](https://github.com/vm0-ai/vm0/issues/25942)) ([90f8d8f](https://github.com/vm0-ai/vm0/commit/90f8d8ffb713f7f99acd8377b8cba26a91504d0b))


### Bug Fixes

* **mitm-addon:** retain aliases across context target unpacking ([#25937](https://github.com/vm0-ai/vm0/issues/25937)) ([91eee65](https://github.com/vm0-ai/vm0/commit/91eee6520a0092154799811582da758aa8a30ca1))

## [0.161.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.161.6...runner-rs-v0.161.7) (2026-08-09)

## [0.161.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.161.5...runner-rs-v0.161.6) (2026-08-09)


### Bug Fixes

* **runner:** preserve codex catalog identity responses ([#25889](https://github.com/vm0-ai/vm0/issues/25889)) ([14d67f8](https://github.com/vm0-ai/vm0/commit/14d67f884a698a4a69ef9136e300d985a20bf48e))
* **runner:** recheck active input after dropped wakeup ([#25888](https://github.com/vm0-ai/vm0/issues/25888)) ([43206a3](https://github.com/vm0-ai/vm0/commit/43206a300a494de7bcd85a65a11c6f54a1f759a1))


### Refactoring

* **connectors:** share public destination address policy ([#25914](https://github.com/vm0-ai/vm0/issues/25914)) ([27f6260](https://github.com/vm0-ai/vm0/commit/27f6260b2f2430f7c7e86d5cab130d077311ef7e))
* **pi:** replace handoff fallbacks with session polling ([#25906](https://github.com/vm0-ai/vm0/issues/25906)) ([66cbcad](https://github.com/vm0-ai/vm0/commit/66cbcada1c224b1c7541b6d7c90696d3733e53f8))

## [0.161.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.161.4...runner-rs-v0.161.5) (2026-08-09)


### Bug Fixes

* **connectors:** align active-run auth variable semantics ([#25839](https://github.com/vm0-ai/vm0/issues/25839)) ([9bd1638](https://github.com/vm0-ai/vm0/commit/9bd1638358794f39aaa09445a0f14c9911f44536))
* **runner:** skip reuse refresh for non-reusable runs ([#25867](https://github.com/vm0-ai/vm0/issues/25867)) ([c61b9c1](https://github.com/vm0-ai/vm0/commit/c61b9c1ddc6591278d771451799316626c5d6b86))

## [0.161.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.161.3...runner-rs-v0.161.4) (2026-08-08)

## [0.161.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.161.2...runner-rs-v0.161.3) (2026-08-08)


### Bug Fixes

* **runner:** wait briefly for workspace cache lock ([#25812](https://github.com/vm0-ai/vm0/issues/25812)) ([87a3ece](https://github.com/vm0-ai/vm0/commit/87a3ece7e19c8a24bff80a60136c4dba50bc1efc))

## [0.161.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.161.1...runner-rs-v0.161.2) (2026-08-08)


### Bug Fixes

* **mitm-addon:** track decorator application exceptions ([#25801](https://github.com/vm0-ai/vm0/issues/25801)) ([7f0aa4b](https://github.com/vm0-ai/vm0/commit/7f0aa4bcf22512646002e9a65a7b357466540460))
* **python:** skip usage parsers for bodyless responses ([#25799](https://github.com/vm0-ai/vm0/issues/25799)) ([137afd6](https://github.com/vm0-ai/vm0/commit/137afd62d517e5819befb4cc164dcc8e7598716e))

## [0.161.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.161.0...runner-rs-v0.161.1) (2026-08-08)


### Bug Fixes

* **runner:** reject mismatched local result identities ([#25792](https://github.com/vm0-ai/vm0/issues/25792)) ([80cb44a](https://github.com/vm0-ai/vm0/commit/80cb44a8acc3047025de8a3369cb2169d1303114))


### Refactoring

* **runner:** centralize org name validation ([#25791](https://github.com/vm0-ai/vm0/issues/25791)) ([ec215ce](https://github.com/vm0-ai/vm0/commit/ec215cec3f7d9387a8aaa9a7a01847c1a322a34d))
* **runner:** remove runner preference migration bridge ([#25796](https://github.com/vm0-ai/vm0/issues/25796)) ([bde4228](https://github.com/vm0-ai/vm0/commit/bde4228117d5f4dfd43040feb9eec41c9af09337))

## [0.161.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.160.9...runner-rs-v0.161.0) (2026-08-08)


### Features

* **runner:** pin custom connector routing inputs ([#25756](https://github.com/vm0-ai/vm0/issues/25756)) ([22fa4c4](https://github.com/vm0-ai/vm0/commit/22fa4c4392e20449f49c44e1362008f3cdab6556))


### Documentation

* **python:** document buffered report lease ownership ([#25788](https://github.com/vm0-ai/vm0/issues/25788)) ([1cc74a1](https://github.com/vm0-ai/vm0/commit/1cc74a1570a8fdbdd1e347565e5a37765d08cc01))

## [0.160.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.160.8...runner-rs-v0.160.9) (2026-08-08)


### Bug Fixes

* **runner:** preserve exact reuse generation on rollback ([#25753](https://github.com/vm0-ai/vm0/issues/25753)) ([5b7191c](https://github.com/vm0-ai/vm0/commit/5b7191cdc389da31a23a5ffbefd196c0a510e53a))


### Refactoring

* **runner:** migrate to canonical preference contract ([#25757](https://github.com/vm0-ai/vm0/issues/25757)) ([92d09d9](https://github.com/vm0-ai/vm0/commit/92d09d9b55d79a31543f38693412f38e3ec52d1a))

## [0.160.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.160.7...runner-rs-v0.160.8) (2026-08-07)


### Bug Fixes

* **runner:** consume explicit pi execution mode ([#25738](https://github.com/vm0-ai/vm0/issues/25738)) ([d1af021](https://github.com/vm0-ai/vm0/commit/d1af0212e7e74fcd7563bdfcd83ddb3c336e4829))

## [0.160.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.160.6...runner-rs-v0.160.7) (2026-08-07)


### Refactoring

* **runner:** remove preference compatibility bridge ([#25734](https://github.com/vm0-ai/vm0/issues/25734)) ([5e2edaf](https://github.com/vm0-ai/vm0/commit/5e2edafe9ca7958f4c37566566762f34f5fffd01))

## [0.160.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.160.5...runner-rs-v0.160.6) (2026-08-07)


### Bug Fixes

* **api:** account for pi edge model usage ([#25668](https://github.com/vm0-ai/vm0/issues/25668)) ([ec55732](https://github.com/vm0-ai/vm0/commit/ec55732fa303284e24b119ac8210438c650024d8))

## [0.160.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.160.4...runner-rs-v0.160.5) (2026-08-07)


### Performance Improvements

* **runner:** claim finalizing successors early ([#25685](https://github.com/vm0-ai/vm0/issues/25685)) ([9692323](https://github.com/vm0-ai/vm0/commit/969232302fd2fa66186fbdb05a845aaee23c879b))

## [0.160.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.160.3...runner-rs-v0.160.4) (2026-08-07)

## [0.160.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.160.2...runner-rs-v0.160.3) (2026-08-07)


### Performance Improvements

* **runner:** avoid rewalking unchanged storage cache entries ([#25662](https://github.com/vm0-ai/vm0/issues/25662)) ([b7e071d](https://github.com/vm0-ai/vm0/commit/b7e071d30d8b64fe6c38232c43213196dc7ff061))

## [0.160.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.160.1...runner-rs-v0.160.2) (2026-08-07)


### Bug Fixes

* **connectors:** preserve firewall without credentials ([#25564](https://github.com/vm0-ai/vm0/issues/25564)) ([9a423f0](https://github.com/vm0-ai/vm0/commit/9a423f0231495c12c50da29c7bf5ca08a5f4bf0a))
* **python:** classify sse from exact media type ([#25627](https://github.com/vm0-ai/vm0/issues/25627)) ([97cdc74](https://github.com/vm0-ai/vm0/commit/97cdc745c32641a11cdad35f3caa3f0c321d23a7))
* **python:** revalidate auth.base authorization after auth waits ([#25633](https://github.com/vm0-ai/vm0/issues/25633)) ([7b94627](https://github.com/vm0-ai/vm0/commit/7b94627e68e7da040bd2f46591177a33770c1f73))
* **runner:** isolate pi standby notifications by run ([#25629](https://github.com/vm0-ai/vm0/issues/25629)) ([d1d2d41](https://github.com/vm0-ai/vm0/commit/d1d2d4161e16c36680ab7674c59baa510ec6cdb8))


### Refactoring

* **python:** clarify model token category ownership ([#25635](https://github.com/vm0-ai/vm0/issues/25635)) ([0a8d0f2](https://github.com/vm0-ai/vm0/commit/0a8d0f2c71d7b4c9f46aeef0f70236163a6788c4))
* **runner:** enforce unique pi standby subscriptions ([#25648](https://github.com/vm0-ai/vm0/issues/25648)) ([b18c5ad](https://github.com/vm0-ai/vm0/commit/b18c5ad34e8fa717d9541f9d9b03c44c71b97b45))


### Performance Improvements

* **runner:** enforce rank-aware resource admission ([#25626](https://github.com/vm0-ai/vm0/issues/25626)) ([333fa02](https://github.com/vm0-ai/vm0/commit/333fa02b3d60e2038abcd35b38c0bce56fa85634))

## [0.160.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.160.0...runner-rs-v0.160.1) (2026-08-07)


### Bug Fixes

* **runner:** preserve drain override across repeated rollback ([#25621](https://github.com/vm0-ai/vm0/issues/25621)) ([48382ee](https://github.com/vm0-ai/vm0/commit/48382ee364afe215c694363a6e6efedb013efab4))


### Performance Improvements

* **rust:** eliminate exec-control payload copies ([#25608](https://github.com/vm0-ai/vm0/issues/25608)) ([3f71e3b](https://github.com/vm0-ai/vm0/commit/3f71e3b491c2fb66e3c964494565aa9a9bcd4166))

## [0.160.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.159.2...runner-rs-v0.160.0) (2026-08-07)


### Features

* complete pi agent handoff end to end ([#25489](https://github.com/vm0-ai/vm0/issues/25489)) ([feeb1cb](https://github.com/vm0-ai/vm0/commit/feeb1cbc8e838b844945cf5efc3ed7e9820c10a4))


### Bug Fixes

* **runner:** materialize prune-eligible codex zstd history ([#25582](https://github.com/vm0-ai/vm0/issues/25582)) ([44df9f2](https://github.com/vm0-ai/vm0/commit/44df9f2c4dc9ec5640cc54316c944a8164f54a3f))

## [0.159.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.159.1...runner-rs-v0.159.2) (2026-08-07)


### Bug Fixes

* **runner:** clarify execution time limit log ([#25555](https://github.com/vm0-ai/vm0/issues/25555)) ([ba61979](https://github.com/vm0-ai/vm0/commit/ba619790878fed48edd284cf208701af995a68fe))
* **runner:** prevent drain from missing service restarts ([#25569](https://github.com/vm0-ai/vm0/issues/25569)) ([af1c12a](https://github.com/vm0-ai/vm0/commit/af1c12afa585284f0eb1dc672c67289f2c69e2b1))

## [0.159.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.159.0...runner-rs-v0.159.1) (2026-08-07)

## [0.159.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.22...runner-rs-v0.159.0) (2026-08-07)


### Features

* **connectors:** sync active run connector state ([#25420](https://github.com/vm0-ai/vm0/issues/25420)) ([87e716c](https://github.com/vm0-ai/vm0/commit/87e716cdf766fb3a1af51cdd20b7833717fe1133))

## [0.158.22](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.21...runner-rs-v0.158.22) (2026-08-06)


### Refactoring

* **mitm-addon:** share threaded http test server ([#25487](https://github.com/vm0-ai/vm0/issues/25487)) ([1295edc](https://github.com/vm0-ai/vm0/commit/1295edcf4d31beb55cb1c77ddd993f93cde696f1))
* **runner:** use codex app-server exclusively ([#25460](https://github.com/vm0-ai/vm0/issues/25460)) ([61b623a](https://github.com/vm0-ai/vm0/commit/61b623adffb6da6d16dd01355773ea342258b894))

## [0.158.21](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.20...runner-rs-v0.158.21) (2026-08-06)


### Documentation

* **python:** document addon load initialization contract ([#25480](https://github.com/vm0-ai/vm0/issues/25480)) ([ccac1ed](https://github.com/vm0-ai/vm0/commit/ccac1ed7bbd31cb494cd538d82f756cdcf79f04c))

## [0.158.20](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.19...runner-rs-v0.158.20) (2026-08-06)


### Refactoring

* **runner:** centralize firecracker snapshot validation ([#25469](https://github.com/vm0-ai/vm0/issues/25469)) ([2ff4c4e](https://github.com/vm0-ai/vm0/commit/2ff4c4ecbc54f1eb2d7a65664122e489b3afc362))

## [0.158.19](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.18...runner-rs-v0.158.19) (2026-08-06)


### Performance Improvements

* **runner:** correlate preference reuse outcomes ([#25443](https://github.com/vm0-ai/vm0/issues/25443)) ([1314003](https://github.com/vm0-ai/vm0/commit/1314003df53a575df0b20a1c4c67cc3304486199))

## [0.158.18](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.17...runner-rs-v0.158.18) (2026-08-06)


### Bug Fixes

* **runner:** retry active input after source read failure ([#25438](https://github.com/vm0-ai/vm0/issues/25438)) ([fac4b4a](https://github.com/vm0-ai/vm0/commit/fac4b4afcb92c90a177a1e71917bd774eb053870))

## [0.158.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.16...runner-rs-v0.158.17) (2026-08-06)


### Refactoring

* **runner:** remove resolved dns diagnostics ([#25426](https://github.com/vm0-ai/vm0/issues/25426)) ([a301c42](https://github.com/vm0-ai/vm0/commit/a301c42affa3da95dc3cec1b0c456acf16af2a5c))

## [0.158.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.15...runner-rs-v0.158.16) (2026-08-06)


### Documentation

* **python:** document server-connect prebinding contract ([#25406](https://github.com/vm0-ai/vm0/issues/25406)) ([9e37d23](https://github.com/vm0-ai/vm0/commit/9e37d230db7b4921ac7f8334b474756c43b10fe7))


### Refactoring

* remove chat steer feature switch ([#25369](https://github.com/vm0-ai/vm0/issues/25369)) ([7ef396a](https://github.com/vm0-ai/vm0/commit/7ef396a972b1937b2d345921d98bfca0051e3277))

## [0.158.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.14...runner-rs-v0.158.15) (2026-08-06)


### Refactoring

* **runner:** retire pre-park handoff observation ([#25379](https://github.com/vm0-ai/vm0/issues/25379)) ([2ef8c8c](https://github.com/vm0-ai/vm0/commit/2ef8c8cb338e0951667d86f8014e1373cab1ea54))
* **sandbox-fc:** retire balloon settle summary ([#25380](https://github.com/vm0-ai/vm0/issues/25380)) ([ec2b177](https://github.com/vm0-ai/vm0/commit/ec2b177f7908e4bf61a9eab9c7217257578b3872))


### Performance Improvements

* **runner:** bound codex zstd timestamp buffering ([#25383](https://github.com/vm0-ai/vm0/issues/25383)) ([1cd62f8](https://github.com/vm0-ai/vm0/commit/1cd62f8733310973339c7549d4e28a0cd0e21275))

## [0.158.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.13...runner-rs-v0.158.14) (2026-08-06)


### Performance Improvements

* **python:** bound network log url serialization ([#25362](https://github.com/vm0-ai/vm0/issues/25362)) ([287c719](https://github.com/vm0-ai/vm0/commit/287c7195a97e4381ae8a15ce2555ec30c8a67177))

## [0.158.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.12...runner-rs-v0.158.13) (2026-08-06)


### Bug Fixes

* **python:** accept trailing authority-fragment base url variables ([#25339](https://github.com/vm0-ai/vm0/issues/25339)) ([46fdc70](https://github.com/vm0-ai/vm0/commit/46fdc7052407228e21856a8b47e43ef31060cd87))


### Documentation

* **python:** document auth base rewrite validation ([#25337](https://github.com/vm0-ai/vm0/issues/25337)) ([228bb70](https://github.com/vm0-ai/vm0/commit/228bb706ec45dfb23142f2786ed92d64919669a7))


### Refactoring

* **runner:** centralize private atomic file publication ([#25342](https://github.com/vm0-ai/vm0/issues/25342)) ([3b3293d](https://github.com/vm0-ai/vm0/commit/3b3293d941e76f2f406a199c360e95b99144b64b))

## [0.158.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.11...runner-rs-v0.158.12) (2026-08-05)


### Bug Fixes

* **runner:** treat removed catalog connectors as absent ([#25307](https://github.com/vm0-ai/vm0/issues/25307)) ([603597b](https://github.com/vm0-ai/vm0/commit/603597bc0c1774807f66b5976f1b56d2a468f3e8))

## [0.158.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.10...runner-rs-v0.158.11) (2026-08-05)


### Performance Improvements

* **runner:** overlap exact reuse restore with claim ([#25286](https://github.com/vm0-ai/vm0/issues/25286)) ([bb4463d](https://github.com/vm0-ai/vm0/commit/bb4463d2d86e77b9bae948b367ee60fddc52fb83))

## [0.158.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.9...runner-rs-v0.158.10) (2026-08-05)


### Bug Fixes

* **runner:** preserve network policies across refresh failures ([#25274](https://github.com/vm0-ai/vm0/issues/25274)) ([adb7dd2](https://github.com/vm0-ai/vm0/commit/adb7dd2378f0b63111cdf61d85a106da8b6d2422))

## [0.158.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.8...runner-rs-v0.158.9) (2026-08-05)


### Bug Fixes

* **runner:** retain anthropic accounting telemetry ([#25252](https://github.com/vm0-ai/vm0/issues/25252)) ([3cd1bf7](https://github.com/vm0-ai/vm0/commit/3cd1bf7ba468f993e734d1709d36b6c2c669e676))


### Documentation

* **python:** document network-log target helpers ([#25244](https://github.com/vm0-ai/vm0/issues/25244)) ([ad2a9f8](https://github.com/vm0-ai/vm0/commit/ad2a9f81491b80761fd560132ba3f3d337f2f9ee))


### Performance Improvements

* **runner:** split codex agent and upstream latency ([#25256](https://github.com/vm0-ai/vm0/issues/25256)) ([b654936](https://github.com/vm0-ai/vm0/commit/b654936c10c59650d8d9079b0350887bb1d354a2))

## [0.158.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.7...runner-rs-v0.158.8) (2026-08-05)


### Bug Fixes

* **runner:** secure workspace cache publications ([#25224](https://github.com/vm0-ai/vm0/issues/25224)) ([b682d63](https://github.com/vm0-ai/vm0/commit/b682d63d878baaea4ba22b1b358ed23e9492f66e))


### Refactoring

* **rust:** consolidate sandbox test proxies ([#25223](https://github.com/vm0-ai/vm0/issues/25223)) ([f2cc0f9](https://github.com/vm0-ai/vm0/commit/f2cc0f92a5c0ef64a21e5e5b8f18e8da204d7c36))


### Performance Improvements

* **mitm-addon:** stop decoding after json inspection terminates ([#25221](https://github.com/vm0-ai/vm0/issues/25221)) ([39dff80](https://github.com/vm0-ai/vm0/commit/39dff80fc4f8d8c81c0b2a97fda7d40c010194e3))

## [0.158.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.6...runner-rs-v0.158.7) (2026-08-05)


### Bug Fixes

* **runner:** recover anthropic usage from interrupted compressed streams ([#25171](https://github.com/vm0-ai/vm0/issues/25171)) ([4a7affe](https://github.com/vm0-ai/vm0/commit/4a7affead44cb0a3a2721f422a0f243dce55d92c))


### Refactoring

* **python:** share runner flush marker envelope parsing ([#25216](https://github.com/vm0-ai/vm0/issues/25216)) ([a384287](https://github.com/vm0-ai/vm0/commit/a384287d897b74b68b09547605352e95b576f11a))
* remove obsolete cli release bookkeeping ([#25217](https://github.com/vm0-ai/vm0/issues/25217)) ([de04988](https://github.com/vm0-ai/vm0/commit/de0498849576522e622687fe07b630fa8b519847))

## [0.158.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.5...runner-rs-v0.158.6) (2026-08-05)


### Bug Fixes

* **runner:** clean setup temps after cancellation ([#25145](https://github.com/vm0-ai/vm0/issues/25145)) ([c279ec5](https://github.com/vm0-ai/vm0/commit/c279ec5db9d53fa76ef215f00e282a8e01a9f0b3))


### Documentation

* **python:** document responses websocket inspection contract ([#25196](https://github.com/vm0-ai/vm0/issues/25196)) ([10d97f5](https://github.com/vm0-ai/vm0/commit/10d97f5a468df9111bd2af94eaf60890698700e1))

## [0.158.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.4...runner-rs-v0.158.5) (2026-08-05)


### Bug Fixes

* **python:** keep connector diagnostics bodyless for head ([#25167](https://github.com/vm0-ai/vm0/issues/25167)) ([005a633](https://github.com/vm0-ai/vm0/commit/005a6333c81afaad013a5908bafc439fe1d1d9c4))

## [0.158.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.3...runner-rs-v0.158.4) (2026-08-05)


### Bug Fixes

* **runner:** clean up cancelled setup artifact temps ([#25138](https://github.com/vm0-ai/vm0/issues/25138)) ([8cbc510](https://github.com/vm0-ai/vm0/commit/8cbc51072bc488e3d96dedd8668ecfe43fedb6aa))


### Documentation

* **python:** document x json truncation contract ([#25153](https://github.com/vm0-ai/vm0/issues/25153)) ([645f14c](https://github.com/vm0-ai/vm0/commit/645f14c1adb25e7c1371c2ca2a0b6aaee9324a28))


### Refactoring

* **rust:** centralize epoch-millisecond validation ([#25159](https://github.com/vm0-ai/vm0/issues/25159)) ([4780d82](https://github.com/vm0-ai/vm0/commit/4780d82181ac10f4f7bfaafc6b16e448f89f2860))

## [0.158.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.2...runner-rs-v0.158.3) (2026-08-05)


### Bug Fixes

* **python:** preserve auth base representation lengths ([#25135](https://github.com/vm0-ai/vm0/issues/25135)) ([8c70774](https://github.com/vm0-ai/vm0/commit/8c70774539a77c52148354e49a485b3c5c60be61))


### Documentation

* **python:** document catalog response-header continuation contract ([#25134](https://github.com/vm0-ai/vm0/issues/25134)) ([f0e55c4](https://github.com/vm0-ai/vm0/commit/f0e55c4f136323477f881c716061185ec6b79fa2))

## [0.158.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.1...runner-rs-v0.158.2) (2026-08-05)

## [0.158.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.158.0...runner-rs-v0.158.1) (2026-08-05)


### Bug Fixes

* **runner:** keep info logs out of axiom ([#25114](https://github.com/vm0-ai/vm0/issues/25114)) ([3c6d123](https://github.com/vm0-ai/vm0/commit/3c6d1235847d344b7e1a9bc8ee885b68d1fd8d5b))


### Performance Improvements

* **runner:** measure reserved reuse claims ([#25078](https://github.com/vm0-ai/vm0/issues/25078)) ([4c2a7fa](https://github.com/vm0-ai/vm0/commit/4c2a7fac17bac1b83689b3f1a31cd8a6f5375cc0))

## [0.158.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.157.2...runner-rs-v0.158.0) (2026-08-04)


### Features

* annotate cross-thread agent prompts and bound autonomous delegation depth ([#24934](https://github.com/vm0-ai/vm0/issues/24934)) ([2f2c72a](https://github.com/vm0-ai/vm0/commit/2f2c72af84481a07844bda1eb78fc73612cec3f2))

## [0.157.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.157.1...runner-rs-v0.157.2) (2026-08-04)


### Performance Improvements

* **sandbox-fc:** reduce balloon settle detection latency ([#25069](https://github.com/vm0-ai/vm0/issues/25069)) ([16893fa](https://github.com/vm0-ai/vm0/commit/16893fa7ffa416a8859a112119a8082229da2d88))

## [0.157.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.157.0...runner-rs-v0.157.1) (2026-08-04)


### Bug Fixes

* **runner:** report unavailable status in doctor ([#25051](https://github.com/vm0-ai/vm0/issues/25051)) ([c5b3cc8](https://github.com/vm0-ai/vm0/commit/c5b3cc8618e9ada1c986d7afd1307e9582a46085))


### Refactoring

* canonicalize deepseek model provider ([#25030](https://github.com/vm0-ai/vm0/issues/25030)) ([c19ea0f](https://github.com/vm0-ai/vm0/commit/c19ea0fa2d196143ab899db3953904c814e2b016))

## [0.157.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.156.2...runner-rs-v0.157.0) (2026-08-04)


### Features

* **chat:** add feature-gated inline steering ([#24941](https://github.com/vm0-ai/vm0/issues/24941)) ([f705e9d](https://github.com/vm0-ai/vm0/commit/f705e9d8d1a1038055d62839ce0bb3725edbd2e3))

## [0.156.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.156.1...runner-rs-v0.156.2) (2026-08-04)


### Performance Improvements

* **runner:** move codex catalog validation off event loop ([#25038](https://github.com/vm0-ai/vm0/issues/25038)) ([432f466](https://github.com/vm0-ai/vm0/commit/432f4664bbf6b0877c0d00ed3910793648ed72a1))

## [0.156.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.156.0...runner-rs-v0.156.1) (2026-08-04)

## [0.156.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.155.1...runner-rs-v0.156.0) (2026-08-04)

### Bug Fixes

* **python:** revalidate firewall authorization after auth waits ([#24973](https://github.com/vm0-ai/vm0/issues/24973)) ([2437299](https://github.com/vm0-ai/vm0/commit/2437299c9af55cceaf1048ed7c2c4d07df75f5ec))

## [0.155.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.155.0...runner-rs-v0.155.1) (2026-08-04)


### Bug Fixes

* **python:** revalidate buffered requests before dispatch ([#24966](https://github.com/vm0-ai/vm0/issues/24966)) ([4cf228b](https://github.com/vm0-ai/vm0/commit/4cf228bd3fcf2e8ecc23a72fabec4a78fe16403b))


### Performance Improvements

* measure pre-park successor handoff ([#24938](https://github.com/vm0-ai/vm0/issues/24938)) ([6e7c0aa](https://github.com/vm0-ai/vm0/commit/6e7c0aa73c51d7916efaa354f6ce1ba32b83090f))

## [0.155.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.154.3...runner-rs-v0.155.0) (2026-08-04)

### Bug Fixes

* **runner:** fail closed on unreadable resume status ([#24947](https://github.com/vm0-ai/vm0/issues/24947)) ([570362c](https://github.com/vm0-ai/vm0/commit/570362c4e1a357bfb43f1913cbcd86c25b2dd6b4))


### Documentation

* **runner:** document fail-closed run prefix resolution ([#24931](https://github.com/vm0-ai/vm0/issues/24931)) ([282b1cb](https://github.com/vm0-ai/vm0/commit/282b1cb7218df6b6e17dd16f6c05427862099569))


### Refactoring

* **runner:** centralize guest dns probe signature ([#24936](https://github.com/vm0-ai/vm0/issues/24936)) ([6fbb873](https://github.com/vm0-ai/vm0/commit/6fbb87342944fc9292ae4c6dfa99d7302caf8acc))


### Performance Improvements

* **python:** offload sigv4 body hashing ([#24926](https://github.com/vm0-ai/vm0/issues/24926)) ([38863a8](https://github.com/vm0-ai/vm0/commit/38863a8ad23e9354b8507150561d1223b8d94eff))
* **runner:** retain healthy failed and cancelled sandboxes ([#24919](https://github.com/vm0-ai/vm0/issues/24919)) ([c8069ce](https://github.com/vm0-ai/vm0/commit/c8069ce992bb7e79f10d025147c10269556ed329))

## [0.154.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.154.2...runner-rs-v0.154.3) (2026-08-04)


### Performance Improvements

* **python:** bound anthropic json usage inspection ([#24918](https://github.com/vm0-ai/vm0/issues/24918)) ([e1630b9](https://github.com/vm0-ai/vm0/commit/e1630b93fa79206dd0bd0b6c1f9760e548389bee))

## [0.154.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.154.1...runner-rs-v0.154.2) (2026-08-04)


### Bug Fixes

* **runner:** clear removed namespaces during doctor rechecks ([#24859](https://github.com/vm0-ai/vm0/issues/24859)) ([873fa85](https://github.com/vm0-ai/vm0/commit/873fa85ccd18d251025a879760896048b8b11619))
* **runner:** guard run controls across sandbox reuse ([#24849](https://github.com/vm0-ai/vm0/issues/24849)) ([bb1d90c](https://github.com/vm0-ai/vm0/commit/bb1d90c15df373b43a8653dcd85f9a47e3fb6042))


### Documentation

* **python:** clarify request stream ownership contract ([#24853](https://github.com/vm0-ai/vm0/issues/24853)) ([8ff1a83](https://github.com/vm0-ai/vm0/commit/8ff1a831d20251a45dda92c811bdb14b77e36f37))


### Refactoring

* **runner:** centralize network log process lifecycle ([#24861](https://github.com/vm0-ai/vm0/issues/24861)) ([ae01c93](https://github.com/vm0-ai/vm0/commit/ae01c9340a2673fb370c7df41e51465286b31dfe))


### Performance Improvements

* **mitm-addon:** avoid quadratic x url candidate scanning ([#24854](https://github.com/vm0-ai/vm0/issues/24854)) ([08e9a07](https://github.com/vm0-ai/vm0/commit/08e9a07217d906cae130668bdebb2a7573eedcb4))

## [0.154.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.154.0...runner-rs-v0.154.1) (2026-08-04)


### Documentation

* **python:** clarify binding refresh trust contract ([#24827](https://github.com/vm0-ai/vm0/issues/24827)) ([7b032b8](https://github.com/vm0-ai/vm0/commit/7b032b8057e09aa97ad1ecf2f4255fd94ebd59ad))


### Refactoring

* **runner:** rename affinity internals to reuse terminology ([#24841](https://github.com/vm0-ai/vm0/issues/24841)) ([8bf2594](https://github.com/vm0-ai/vm0/commit/8bf2594f6f00fb8ee9bff85ac544bc72f1908577))


### Performance Improvements

* **python:** rate-limit jsonl append warnings ([#24835](https://github.com/vm0-ai/vm0/issues/24835)) ([6054435](https://github.com/vm0-ai/vm0/commit/60544352eef3491a8600a7e51a71b2f6c109c1c8))

## [0.154.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.153.1...runner-rs-v0.154.0) (2026-08-03)


### Features

* **api:** prefer finalizing predecessor ([#24811](https://github.com/vm0-ai/vm0/issues/24811)) ([3bbf0f5](https://github.com/vm0-ai/vm0/commit/3bbf0f5b5662863a9e805f7122a2828e41b9e501))


### Bug Fixes

* **python:** align connector template reference grammar ([#24807](https://github.com/vm0-ai/vm0/issues/24807)) ([720ce85](https://github.com/vm0-ai/vm0/commit/720ce857af1ba555366d7da103d07c72132515ca))
* **runner:** enforce shared firewall url contract ([#24808](https://github.com/vm0-ai/vm0/issues/24808)) ([0568bc4](https://github.com/vm0-ai/vm0/commit/0568bc4b580f7e0d1be7695904053918b27de6b4))
* **runner:** localize guest dns loss across veth ([#24791](https://github.com/vm0-ai/vm0/issues/24791)) ([32ff5f5](https://github.com/vm0-ai/vm0/commit/32ff5f5d305669d91d9459a7f4b8c359444201b7))


### Documentation

* **mitm-addon:** document catalog wait revalidation ([#24797](https://github.com/vm0-ai/vm0/issues/24797)) ([2350806](https://github.com/vm0-ai/vm0/commit/23508065d7b0c986e500d2d2cf4e39d6d31efc91))
* **runner:** clarify sandbox finalization ownership ([#24798](https://github.com/vm0-ai/vm0/issues/24798)) ([a69ccee](https://github.com/vm0-ai/vm0/commit/a69ccee8d8c5a21e2792bb76b40c735bf0899d66))

## [0.153.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.153.0...runner-rs-v0.153.1) (2026-08-03)


### Refactoring

* **runner:** unify runner preference admission ([#24792](https://github.com/vm0-ai/vm0/issues/24792)) ([baf4026](https://github.com/vm0-ai/vm0/commit/baf40262d03d595fa7c7e2d82df78d6928dda3a5))


### Performance Improvements

* **python:** enforce firewall auth fetch deadline ([#24752](https://github.com/vm0-ai/vm0/issues/24752)) ([0ad635e](https://github.com/vm0-ai/vm0/commit/0ad635e706fcc691e2d70b5d9ee3b402b73aadf2))

## [0.153.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.152.0...runner-rs-v0.153.0) (2026-08-03)


### Features

* **chat:** steer queued messages into active runs ([#24768](https://github.com/vm0-ai/vm0/issues/24768)) ([20e5855](https://github.com/vm0-ai/vm0/commit/20e5855c729bea0db9f7f4a2e3914b2adf4c26dd))

## [0.152.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.18...runner-rs-v0.152.0) (2026-08-03)


### Features

* **api:** publish canonical runner reuse preference ([#24738](https://github.com/vm0-ai/vm0/issues/24738)) ([8c2db7b](https://github.com/vm0-ai/vm0/commit/8c2db7b17d97d01de5beef22823935bb86af2f06))


### Bug Fixes

* **mitm-addon:** recognize .web in x billing ([#24725](https://github.com/vm0-ai/vm0/issues/24725)) ([004c376](https://github.com/vm0-ai/vm0/commit/004c3769521e0af70d991c31484e597a2281d849))
* **mitm-addon:** reject truncated auth.base responses ([#24766](https://github.com/vm0-ai/vm0/issues/24766)) ([3b09261](https://github.com/vm0-ai/vm0/commit/3b092614efd7179a99b430ceb8a55ffa766fbce7))
* **mitm-addon:** release usage tracking when requestheaders is cancelled ([#24734](https://github.com/vm0-ai/vm0/issues/24734)) ([844488e](https://github.com/vm0-ai/vm0/commit/844488edff02b853a7c3b50cc04958d532d3971f))
* **mitm-addon:** revalidate admission after catalog waits ([#24769](https://github.com/vm0-ai/vm0/issues/24769)) ([3a4acb8](https://github.com/vm0-ai/vm0/commit/3a4acb8640124c0809355c992fdfe08f75e76bdf))
* **runner:** mark incomplete stdout drains ([#24722](https://github.com/vm0-ai/vm0/issues/24722)) ([d3e6572](https://github.com/vm0-ai/vm0/commit/d3e65723899591d311de1d9dd572c6096346b1fa))


### Refactoring

* **python:** centralize content-length parsing ([#24758](https://github.com/vm0-ai/vm0/issues/24758)) ([abf84cf](https://github.com/vm0-ai/vm0/commit/abf84cf13f925948e593cd367bb12c511d7fcc5f))
* **python:** share firewall prefix trie primitives ([#24723](https://github.com/vm0-ai/vm0/issues/24723)) ([6122d17](https://github.com/vm0-ai/vm0/commit/6122d17d67564c7796edf67a90da8e1e45babbc0))
* **python:** share provider timing delivery state ([#24724](https://github.com/vm0-ai/vm0/issues/24724)) ([9eb5262](https://github.com/vm0-ai/vm0/commit/9eb5262c57dc1343ec11ec0482d3c838cb362866))
* **python:** share request-body admission leases ([#24756](https://github.com/vm0-ai/vm0/issues/24756)) ([f12f850](https://github.com/vm0-ai/vm0/commit/f12f8503edd9927b29481bbadd40998bfd251413))
* **python:** split firewall auth tests by production owner ([#24705](https://github.com/vm0-ai/vm0/issues/24705)) ([bbdddd6](https://github.com/vm0-ai/vm0/commit/bbdddd6d19a3d1a5fa79a7a410245090fdad88ec))
* **rust:** centralize base cli agent session id validation ([#24759](https://github.com/vm0-ai/vm0/issues/24759)) ([da34435](https://github.com/vm0-ai/vm0/commit/da34435c6747be672914e4651c29d0abd2b47936))


### Performance Improvements

* **python:** bound firewall auth fetch admission ([#24732](https://github.com/vm0-ai/vm0/issues/24732)) ([bc37894](https://github.com/vm0-ai/vm0/commit/bc378943ee88b58f95803cf3c957e3be207f6923))

## [0.151.18](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.17...runner-rs-v0.151.18) (2026-08-03)


### Bug Fixes

* **mitm-addon:** support leading bom in sse usage streams ([#24716](https://github.com/vm0-ai/vm0/issues/24716)) ([216d0d8](https://github.com/vm0-ai/vm0/commit/216d0d87a87853a0c346b922465f97b0cd0ba337))
* **python:** preserve x fallback counts across empty repeated selectors ([#24680](https://github.com/vm0-ai/vm0/issues/24680)) ([b173f42](https://github.com/vm0-ai/vm0/commit/b173f42450a676ac2dd28622dd3c94e4ce4cf67c))
* **runner:** arm sigint before publishing local jobs ([#24678](https://github.com/vm0-ai/vm0/issues/24678)) ([994df9a](https://github.com/vm0-ai/vm0/commit/994df9a6c61f421f11490f38f7836f5d65d4c518))


### Documentation

* **python:** document tls clienthello admission states ([#24702](https://github.com/vm0-ai/vm0/issues/24702)) ([b200a6f](https://github.com/vm0-ai/vm0/commit/b200a6f1697f2e305a70e973431b94fd679d2ec6))
* **runner:** document agent execution lifecycle ([#24695](https://github.com/vm0-ai/vm0/issues/24695)) ([a8c9f76](https://github.com/vm0-ai/vm0/commit/a8c9f7647bae8d9b1585ee46bfa869efa2e92abe))


### Refactoring

* **runner:** extract session history telemetry ([#24679](https://github.com/vm0-ai/vm0/issues/24679)) ([8a5b1fd](https://github.com/vm0-ai/vm0/commit/8a5b1fd555e62ad5cb58033f18853f37488826d9))
* **runner:** separate kill command responsibilities ([#24699](https://github.com/vm0-ai/vm0/issues/24699)) ([cdf33ec](https://github.com/vm0-ai/vm0/commit/cdf33ecf2b9b4f1dd28601a2ae24547c70803793))


### Performance Improvements

* **python:** skip no-op auth.base query tokenization ([#24715](https://github.com/vm0-ai/vm0/issues/24715)) ([222eee8](https://github.com/vm0-ai/vm0/commit/222eee8e735629a4c837f2dc575958951703c547))
* **runner:** reuse ca test identities ([#24698](https://github.com/vm0-ai/vm0/issues/24698)) ([4db9e50](https://github.com/vm0-ai/vm0/commit/4db9e50000865885588106bdb794968d58b4fd3d))

## [0.151.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.16...runner-rs-v0.151.17) (2026-08-03)


### Bug Fixes

* **mitm-addon:** prevent late 401 auth state resurrection ([#24668](https://github.com/vm0-ai/vm0/issues/24668)) ([1b8a731](https://github.com/vm0-ai/vm0/commit/1b8a7313c5fe79cb9b124e3f916582ff26dbee4e))

## [0.151.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.15...runner-rs-v0.151.16) (2026-08-03)


### Performance Improvements

* **runner:** prestart workspace sidecar materialization ([#24660](https://github.com/vm0-ai/vm0/issues/24660)) ([bad2db3](https://github.com/vm0-ai/vm0/commit/bad2db3b3b974308b899e75baec4a052dbbb9cc8))

## [0.151.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.14...runner-rs-v0.151.15) (2026-08-03)


### Documentation

* **runner:** document firewall catalog boundary ([#24630](https://github.com/vm0-ai/vm0/issues/24630)) ([de5c053](https://github.com/vm0-ai/vm0/commit/de5c0533fbd09d0314f81ad424a4de5ba2faf5c5))

## [0.151.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.13...runner-rs-v0.151.14) (2026-08-03)


### Bug Fixes

* **python:** reject superseded catalog owners ([#24603](https://github.com/vm0-ai/vm0/issues/24603)) ([d54cab8](https://github.com/vm0-ai/vm0/commit/d54cab803fa7d4d034a3a6672f859dcc98a5d74a))


### Documentation

* **runner:** document session-history sidecar contract ([#24605](https://github.com/vm0-ai/vm0/issues/24605)) ([65df99a](https://github.com/vm0-ai/vm0/commit/65df99aa6e733d5aa665da960bd7a023f97afa56))


### Refactoring

* **runner:** split idle pool lifecycle modules ([#24609](https://github.com/vm0-ai/vm0/issues/24609)) ([d2328f2](https://github.com/vm0-ai/vm0/commit/d2328f28d2c15fc61330ee5ff81bee32c2272305))


### Performance Improvements

* **python:** avoid duplicate connector auth query parsing ([#24582](https://github.com/vm0-ai/vm0/issues/24582)) ([62da4e5](https://github.com/vm0-ai/vm0/commit/62da4e54f6f74bc21352dde436d0b461f98f7f95))
* **python:** avoid parsing discarded local-response queries ([#24604](https://github.com/vm0-ai/vm0/issues/24604)) ([a69e16e](https://github.com/vm0-ai/vm0/commit/a69e16ee44ac8e235e55299b766c7172769235f7))

## [0.151.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.12...runner-rs-v0.151.13) (2026-08-02)

## [0.151.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.11...runner-rs-v0.151.12) (2026-08-02)


### Bug Fixes

* **runner:** distinguish sandbox reuse result causes ([#24562](https://github.com/vm0-ai/vm0/issues/24562)) ([3988072](https://github.com/vm0-ai/vm0/commit/3988072cba1e7e821f976598b1de7da3a6a22ee1))


### Refactoring

* **runner:** treat invalid resume sessions as pre-reuse failures ([#24568](https://github.com/vm0-ai/vm0/issues/24568)) ([a3e789f](https://github.com/vm0-ai/vm0/commit/a3e789f626155acb7f3fe280aa4fe60f4579f103))

## [0.151.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.10...runner-rs-v0.151.11) (2026-08-02)


### Bug Fixes

* **runner:** preserve full network log urls ([#24554](https://github.com/vm0-ai/vm0/issues/24554)) ([283bd1f](https://github.com/vm0-ai/vm0/commit/283bd1f74902e804b8e88acafe53e50adfbf04e2))


### Performance Improvements

* **python:** strip discarded log query before parsing ([#24548](https://github.com/vm0-ai/vm0/issues/24548)) ([f05235b](https://github.com/vm0-ai/vm0/commit/f05235b1092e99a2e4e72146cbe2807d6e73e36a))

## [0.151.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.9...runner-rs-v0.151.10) (2026-08-02)


### Documentation

* **runner:** document service unit identity forms ([#24533](https://github.com/vm0-ai/vm0/issues/24533)) ([66c754f](https://github.com/vm0-ai/vm0/commit/66c754f2cb8f383e2afa5b7f0bbf52cf9352a83a))

## [0.151.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.8...runner-rs-v0.151.9) (2026-08-01)


### Refactoring

* **runner:** decouple idle parking from cli session identity ([#24492](https://github.com/vm0-ai/vm0/issues/24492)) ([2cdd0f6](https://github.com/vm0-ai/vm0/commit/2cdd0f6f3024e6076c9493c6e034d3ea9e3ac163))

## [0.151.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.7...runner-rs-v0.151.8) (2026-08-01)


### Refactoring

* **runner:** finish workspace image cache cutover ([#24474](https://github.com/vm0-ai/vm0/issues/24474)) ([ae59d2d](https://github.com/vm0-ai/vm0/commit/ae59d2d1af1620d68ea28dfa1825d3619c8081e2))

## [0.151.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.6...runner-rs-v0.151.7) (2026-08-01)


### Refactoring

* **connectors:** finish local slug terminology cleanup ([#24472](https://github.com/vm0-ai/vm0/issues/24472)) ([c3000d8](https://github.com/vm0-ai/vm0/commit/c3000d888cf153dc57208c91e69097bdea400a56))

## [0.151.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.5...runner-rs-v0.151.6) (2026-08-01)


### Bug Fixes

* **runner:** reap timed-out host oom diagnostics ([#24438](https://github.com/vm0-ai/vm0/issues/24438)) ([497fc38](https://github.com/vm0-ai/vm0/commit/497fc38c5db12e041891b70cddd7bad612821b20))


### Documentation

* **python:** clarify parsed empty x stream contract ([#24449](https://github.com/vm0-ai/vm0/issues/24449)) ([1f3a15c](https://github.com/vm0-ai/vm0/commit/1f3a15cb2f0b7109f316885f5b4f8b9192b7c2b3))


### Refactoring

* make chat threads the sole runner reuse key ([#24440](https://github.com/vm0-ai/vm0/issues/24440)) ([61dc78f](https://github.com/vm0-ai/vm0/commit/61dc78fd9b32e0a154285e12fc7f6434cc86122c))
* **python:** split auth base forwarder tests by contract ([#24451](https://github.com/vm0-ai/vm0/issues/24451)) ([ec67485](https://github.com/vm0-ai/vm0/commit/ec67485ab3f5680caeaa0ad584f48de47ab86c7f))
* **runner:** emit exact heartbeat capabilities ([#24456](https://github.com/vm0-ai/vm0/issues/24456)) ([bedd684](https://github.com/vm0-ai/vm0/commit/bedd684ac763f7405851e0b40dec2bcd72ff4071))
* **runner:** split agent run tests by contract ([#24439](https://github.com/vm0-ai/vm0/issues/24439)) ([2164dff](https://github.com/vm0-ai/vm0/commit/2164dff4323ab34852db70f22cc5b35c2300216d))


### Performance Improvements

* **python:** skip unconnected client binding scans ([#24452](https://github.com/vm0-ai/vm0/issues/24452)) ([3412278](https://github.com/vm0-ai/vm0/commit/3412278416e0e55eb6e44d1780a1b9cdff5d086d))

## [0.151.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.4...runner-rs-v0.151.5) (2026-08-01)


### Bug Fixes

* trigger api platform and runner releases ([#24389](https://github.com/vm0-ai/vm0/issues/24389)) ([5e32b07](https://github.com/vm0-ai/vm0/commit/5e32b07956572689916ff1348deab37be627ab0f))

## [0.151.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.3...runner-rs-v0.151.4) (2026-07-31)


### Bug Fixes

* **runner:** preserve workspace cache across session rotation ([#24364](https://github.com/vm0-ai/vm0/issues/24364)) ([98eaba8](https://github.com/vm0-ai/vm0/commit/98eaba8df7c4dc5a26cd32ef8c5dbafd23fe94f9))

## [0.151.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.2...runner-rs-v0.151.3) (2026-07-31)


### Refactoring

* **connectors:** finish slug terminology cleanup ([#24361](https://github.com/vm0-ai/vm0/issues/24361)) ([084ee2d](https://github.com/vm0-ai/vm0/commit/084ee2d7d0c17dc1b5c126ea65e768cb595a8154))


### Performance Improvements

* **python:** avoid caching request urls ([#24354](https://github.com/vm0-ai/vm0/issues/24354)) ([1246a8c](https://github.com/vm0-ai/vm0/commit/1246a8cdfa220e71cb57224b1089ee1f1a0aa98b))

## [0.151.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.1...runner-rs-v0.151.2) (2026-07-31)


### Bug Fixes

* apply context-tiered pricing to managed models ([#24266](https://github.com/vm0-ai/vm0/issues/24266)) ([0f487e5](https://github.com/vm0-ai/vm0/commit/0f487e5b7631b4dbfde8c7bc3f706b829d74e364))
* **runner:** retry network policy refresh transport failures ([#24323](https://github.com/vm0-ai/vm0/issues/24323)) ([bf87328](https://github.com/vm0-ai/vm0/commit/bf87328fcdb95e39e423d3e1ddf7f1fd7b3afc3e))

## [0.151.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.151.0...runner-rs-v0.151.1) (2026-07-31)


### Bug Fixes

* preserve app URL through runner environment ([#24213](https://github.com/vm0-ai/vm0/issues/24213)) ([4171443](https://github.com/vm0-ai/vm0/commit/41714431c6f035a8fb551e57804d92cbb1f71954))


### Documentation

* **runner:** document restored session identity contracts ([#24295](https://github.com/vm0-ai/vm0/issues/24295)) ([d7c6be8](https://github.com/vm0-ai/vm0/commit/d7c6be8e303597ad7ac4c4e7ef95ef687c77bb9e))


### Refactoring

* **mitm-addon:** split catalog cache tests by contract ([#24293](https://github.com/vm0-ai/vm0/issues/24293)) ([6667f89](https://github.com/vm0-ai/vm0/commit/6667f8950ffe31f0ffaea7582d7505e5408c4b3d))
* **runner:** remove cancellation recovery capability ([#24318](https://github.com/vm0-ai/vm0/issues/24318)) ([065a83d](https://github.com/vm0-ai/vm0/commit/065a83d12e68176a84fef19bfd415b32c686897d))

## [0.151.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.150.7...runner-rs-v0.151.0) (2026-07-31)


### Features

* reuse runner sandboxes by chat thread ([#24285](https://github.com/vm0-ai/vm0/issues/24285)) ([181eb2f](https://github.com/vm0-ai/vm0/commit/181eb2f6741ed448fcebf7d8108bbc1438e366ef))


### Documentation

* **mitm-addon:** document websocket retention contract ([#24288](https://github.com/vm0-ai/vm0/issues/24288)) ([1383eb6](https://github.com/vm0-ai/vm0/commit/1383eb6932a2814dd77be8e42728177acd3cb46d))


### Performance Improvements

* **mitm-addon:** bypass decoding for plain ascii paths ([#24286](https://github.com/vm0-ai/vm0/issues/24286)) ([5313946](https://github.com/vm0-ai/vm0/commit/53139469894073488e3d55de4552483b1533ecbf))

## [0.150.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.150.6...runner-rs-v0.150.7) (2026-07-31)


### Bug Fixes

* **mitm-addon:** support multi-member gzip billing bodies ([#24278](https://github.com/vm0-ai/vm0/issues/24278)) ([5d63984](https://github.com/vm0-ai/vm0/commit/5d639845e10a7fbfd2dfe7da9af5adc18745e101))

## [0.150.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.150.5...runner-rs-v0.150.6) (2026-07-31)


### Documentation

* **rust:** correct run and sandbox identity contract ([#24250](https://github.com/vm0-ai/vm0/issues/24250)) ([49ab7e5](https://github.com/vm0-ai/vm0/commit/49ab7e5c1ef9ba45957a68a159c7ad45cffddf47))


### Refactoring

* **runner:** separate lifecycle state from signal handling ([#24255](https://github.com/vm0-ai/vm0/issues/24255)) ([df2effa](https://github.com/vm0-ai/vm0/commit/df2effa492b0a0c50430c435a4751a730ce02d17))

## [0.150.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.150.4...runner-rs-v0.150.5) (2026-07-31)


### Bug Fixes

* **runner:** distinguish cancellation intent ([#24217](https://github.com/vm0-ai/vm0/issues/24217)) ([ce76a6d](https://github.com/vm0-ai/vm0/commit/ce76a6d1fc3c332da622f390be9119f58275cc30))


### Performance Improvements

* **python:** bound x ndjson row inspection work ([#24227](https://github.com/vm0-ai/vm0/issues/24227)) ([e182d2c](https://github.com/vm0-ai/vm0/commit/e182d2c7a869f8bab849c71c8312019111c648aa))

## [0.150.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.150.3...runner-rs-v0.150.4) (2026-07-31)


### Bug Fixes

* **runner:** activate cooperative cancellation recovery ([#24200](https://github.com/vm0-ai/vm0/issues/24200)) ([69710c6](https://github.com/vm0-ai/vm0/commit/69710c639bfc0f6645c94df634dd277fe2a8b0e3))
* **runner:** stop when dnsmasq exits ([#24197](https://github.com/vm0-ai/vm0/issues/24197)) ([33d5952](https://github.com/vm0-ai/vm0/commit/33d5952c61c0981ae9632f88d044cd4c882451d4))


### Documentation

* **python:** document public destination denial response modes ([#24190](https://github.com/vm0-ai/vm0/issues/24190)) ([c484213](https://github.com/vm0-ai/vm0/commit/c484213df65c6f057b8596c1d9d8ae9cc2503384))


### Refactoring

* **runner:** split idle reuse tests by behavior ([#24195](https://github.com/vm0-ai/vm0/issues/24195)) ([23d0a1d](https://github.com/vm0-ai/vm0/commit/23d0a1dd1877cc16d7fceab0d197b37066111d2c))

## [0.150.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.150.2...runner-rs-v0.150.3) (2026-07-31)


### Refactoring

* **observability:** remove legacy connector debug dimensions ([#24137](https://github.com/vm0-ai/vm0/issues/24137)) ([77c077f](https://github.com/vm0-ai/vm0/commit/77c077f8d2e514ad1c2611d742700c3c5a5b2ae6))

## [0.150.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.150.1...runner-rs-v0.150.2) (2026-07-30)

## [0.150.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.150.0...runner-rs-v0.150.1) (2026-07-30)


### Bug Fixes

* **runner:** preserve upstream bindings across flows ([#24122](https://github.com/vm0-ai/vm0/issues/24122)) ([fbc643c](https://github.com/vm0-ai/vm0/commit/fbc643cc1f9663833abff68435fe44250a477e92))


### Performance Improvements

* **runner:** prevent concurrent systemd daemon-reload storms ([#24109](https://github.com/vm0-ai/vm0/issues/24109)) ([681b3e4](https://github.com/vm0-ai/vm0/commit/681b3e49d0da6d8859b659c9db3d4fa05b6ac86c))

## [0.150.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.149.4...runner-rs-v0.150.0) (2026-07-30)


### Features

* add admin-defined model gateway connections ([#23807](https://github.com/vm0-ai/vm0/issues/23807)) ([0632cb4](https://github.com/vm0-ai/vm0/commit/0632cb4e4dfda2c844a2531d6c13a3dd74b86e29))

## [0.149.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.149.3...runner-rs-v0.149.4) (2026-07-30)


### Documentation

* **mitm-addon:** document anthropic sse callbacks ([#24051](https://github.com/vm0-ai/vm0/issues/24051)) ([a32f31e](https://github.com/vm0-ai/vm0/commit/a32f31edf47e762dbb817c9e6a85ebdf74d12f04))
* **python:** update auth.base fake socket contract ([#24069](https://github.com/vm0-ai/vm0/issues/24069)) ([2b44e44](https://github.com/vm0-ai/vm0/commit/2b44e44ebd66b83d6483a0b374f472a3b776710c))


### Refactoring

* **runner:** isolate terminal job logging ([#24055](https://github.com/vm0-ai/vm0/issues/24055)) ([ccf7fe2](https://github.com/vm0-ai/vm0/commit/ccf7fe23189feba1eb1d1f0a7ee9ebbb99d975d9))

## [0.149.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.149.2...runner-rs-v0.149.3) (2026-07-30)


### Bug Fixes

* **mitm-addon:** validate firewall auth success metadata ([#24025](https://github.com/vm0-ai/vm0/issues/24025)) ([099050f](https://github.com/vm0-ai/vm0/commit/099050f999b88a38c1a0e75e0108170542476788))

## [0.149.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.149.1...runner-rs-v0.149.2) (2026-07-30)


### Documentation

* **python:** correct mathematical final sigma test label ([#24021](https://github.com/vm0-ai/vm0/issues/24021)) ([d75d36b](https://github.com/vm0-ai/vm0/commit/d75d36bdecb37be32f4833cea8651dbaa4624ad8))

## [0.149.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.149.0...runner-rs-v0.149.1) (2026-07-30)


### Bug Fixes

* **runner:** cancel blocked network policy fail-close waits ([#23979](https://github.com/vm0-ai/vm0/issues/23979)) ([ef31f52](https://github.com/vm0-ai/vm0/commit/ef31f5298e115790af66f3b0fff37eb9e8fd5c01))
* **runner:** reconcile terminal network policy refreshes ([#23975](https://github.com/vm0-ai/vm0/issues/23975)) ([5c57871](https://github.com/vm0-ai/vm0/commit/5c5787153a35882762ef786b734555a85243739d))
* **runner:** treat ancestry depth cutoff as unknown ([#24006](https://github.com/vm0-ai/vm0/issues/24006)) ([930726c](https://github.com/vm0-ai/vm0/commit/930726c1243c1015ce6b9936f7a6185508b08594))

## [0.149.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.39...runner-rs-v0.149.0) (2026-07-30)


### Features

* **events:** report structured guest event delivery failures ([#23974](https://github.com/vm0-ai/vm0/issues/23974)) ([ebdf828](https://github.com/vm0-ai/vm0/commit/ebdf8280b7b961ebf8404790a15696a7338ecd6e))

## [0.148.39](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.38...runner-rs-v0.148.39) (2026-07-30)


### Bug Fixes

* **runner:** retain network log request correlation on timeout ([#23906](https://github.com/vm0-ai/vm0/issues/23906)) ([568e534](https://github.com/vm0-ai/vm0/commit/568e5344061fad3558766529851c3903e0406ede))


### Refactoring

* **observability:** migrate connector diagnostics to slug ([#23907](https://github.com/vm0-ai/vm0/issues/23907)) ([ce77eaa](https://github.com/vm0-ai/vm0/commit/ce77eaa374b8c2f6975c3550e8c76c15ccb224ce))

## [0.148.38](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.37...runner-rs-v0.148.38) (2026-07-30)


### Bug Fixes

* remove legacy network policy connector fields ([#23866](https://github.com/vm0-ai/vm0/issues/23866)) ([8c5bd04](https://github.com/vm0-ai/vm0/commit/8c5bd0436863535ad36baa9c22b1f849657fb8ac))

## [0.148.37](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.36...runner-rs-v0.148.37) (2026-07-30)

## [0.148.36](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.35...runner-rs-v0.148.36) (2026-07-30)


### Refactoring

* **observability:** add canonical connector slug dimensions ([#23846](https://github.com/vm0-ai/vm0/issues/23846)) ([4a6483a](https://github.com/vm0-ai/vm0/commit/4a6483aa21fb45b84ce7d05d72511ebd5d683558))

## [0.148.35](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.34...runner-rs-v0.148.35) (2026-07-29)


### Bug Fixes

* bridge network policy connector slug fields ([#23828](https://github.com/vm0-ai/vm0/issues/23828)) ([ce1a3bb](https://github.com/vm0-ai/vm0/commit/ce1a3bb8d32e5049e3916af9f7233447ed3f5790))


### Refactoring

* retire signed model pricing protocol ([#23811](https://github.com/vm0-ai/vm0/issues/23811)) ([918a5ef](https://github.com/vm0-ai/vm0/commit/918a5ef92aeccf84ebfbf78a745d1f6062a4d55e))


### Performance Improvements

* **python:** bound websocket json inspection work ([#23768](https://github.com/vm0-ai/vm0/issues/23768)) ([7a673c4](https://github.com/vm0-ai/vm0/commit/7a673c4e48fa96ecf2fe6bc7d23a907cc7975bab))
* **runner:** move workspace images into cache ([#23817](https://github.com/vm0-ai/vm0/issues/23817)) ([80eb14e](https://github.com/vm0-ai/vm0/commit/80eb14e065a3dfda9a709d80cb80eb8e8cfaee11))

## [0.148.34](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.33...runner-rs-v0.148.34) (2026-07-29)


### Refactoring

* **python:** retire auto model routing exception ([#23805](https://github.com/vm0-ai/vm0/issues/23805)) ([dacbaee](https://github.com/vm0-ai/vm0/commit/dacbaee367d03939e811a52bfbafa4870fac5927))

## [0.148.33](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.32...runner-rs-v0.148.33) (2026-07-29)


### Bug Fixes

* **runner:** bound aws sigv4 request body buffering ([#23751](https://github.com/vm0-ai/vm0/issues/23751)) ([cdb3c0d](https://github.com/vm0-ai/vm0/commit/cdb3c0d67ff00d76c51be1a41a99694d95c46b29))
* **runner:** checkpoint sessions before job timeout ([#23734](https://github.com/vm0-ai/vm0/issues/23734)) ([15f44cc](https://github.com/vm0-ai/vm0/commit/15f44cc68e1387d5b18f604fea9c964a1557561d))
* **runner:** clarify locked workspace cache inspection totals ([#23747](https://github.com/vm0-ai/vm0/issues/23747)) ([b6ecaa8](https://github.com/vm0-ai/vm0/commit/b6ecaa80678bec63c37a0da5066f3aea5991dd5d))
* **runner:** drain retained provider timings before shutdown ([#23782](https://github.com/vm0-ai/vm0/issues/23782)) ([ffd34ef](https://github.com/vm0-ai/vm0/commit/ffd34ef64f3efb66346f90dcc5e0279aef24705f))

## [0.148.32](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.31...runner-rs-v0.148.32) (2026-07-29)


### Refactoring

* **connectors:** adopt slug terminology internally ([#23697](https://github.com/vm0-ai/vm0/issues/23697)) ([ffa2a39](https://github.com/vm0-ai/vm0/commit/ffa2a39c3624c85ceed4d3b6bed32bc652ed4feb))
* **runner:** retire legacy template warm naming ([#23708](https://github.com/vm0-ai/vm0/issues/23708)) ([2e71090](https://github.com/vm0-ai/vm0/commit/2e71090edebd5e2d6077e54276e2e2b74c877bc6))


### Performance Improvements

* **python:** reuse connected endpoint ip evidence ([#23710](https://github.com/vm0-ai/vm0/issues/23710)) ([920f35e](https://github.com/vm0-ai/vm0/commit/920f35e8474e56571a8d5d3011a03fe39d286aca))

## [0.148.31](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.30...runner-rs-v0.148.31) (2026-07-29)


### Bug Fixes

* **runner:** separate mitmdump discovery from exit wait ([#23677](https://github.com/vm0-ai/vm0/issues/23677)) ([e6c7696](https://github.com/vm0-ai/vm0/commit/e6c7696c778dedac3ea02ba07489d64d9055e950))


### Refactoring

* **runner:** retire legacy unit staging formats ([#23691](https://github.com/vm0-ai/vm0/issues/23691)) ([18fd293](https://github.com/vm0-ai/vm0/commit/18fd2938b8cf382ba58c2da32a01da2746367341))
* **runner:** split test fixtures by responsibility ([#23681](https://github.com/vm0-ai/vm0/issues/23681)) ([431a8fc](https://github.com/vm0-ai/vm0/commit/431a8fcb45946b7b7a6f30abe0f1bd97140f792c))


### Performance Improvements

* **python:** fast-path ascii hostname labels ([#23671](https://github.com/vm0-ai/vm0/issues/23671)) ([d13ba3d](https://github.com/vm0-ai/vm0/commit/d13ba3d72c17d77997a0ca40f1b7fb323aabe616))

## [0.148.30](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.29...runner-rs-v0.148.30) (2026-07-29)


### Bug Fixes

* **mitm-addon:** report retained counts after failed flushes ([#23663](https://github.com/vm0-ai/vm0/issues/23663)) ([8c63675](https://github.com/vm0-ai/vm0/commit/8c6367586e0c6e19dbfa32328df345e62c2da6f2))

## [0.148.29](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.28...runner-rs-v0.148.29) (2026-07-29)


### Bug Fixes

* **runner:** bound decoded websocket messages ([#23652](https://github.com/vm0-ai/vm0/issues/23652)) ([79c3534](https://github.com/vm0-ai/vm0/commit/79c3534187a23cd73f770832ec280d731301791e))
* **runner:** prevent jsonl flush acknowledgement starvation ([#23643](https://github.com/vm0-ai/vm0/issues/23643)) ([50757f1](https://github.com/vm0-ai/vm0/commit/50757f1fc1d9245fc7063a83fa7178f278f2c975))

## [0.148.28](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.27...runner-rs-v0.148.28) (2026-07-29)


### Documentation

* **python:** correct x includes fallback contract ([#23597](https://github.com/vm0-ai/vm0/issues/23597)) ([6bfa077](https://github.com/vm0-ai/vm0/commit/6bfa07708fc868ed5494afd178787bb8e0f45d07))

## [0.148.27](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.26...runner-rs-v0.148.27) (2026-07-29)

## [0.148.26](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.25...runner-rs-v0.148.26) (2026-07-29)


### Documentation

* **runner:** document storage plan action semantics ([#23610](https://github.com/vm0-ai/vm0/issues/23610)) ([a28aac0](https://github.com/vm0-ai/vm0/commit/a28aac07e0d63502e1db1a53ac9f5591f63c9560))

## [0.148.25](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.24...runner-rs-v0.148.25) (2026-07-29)


### Documentation

* **runner:** correct host oom probe contract ([#23599](https://github.com/vm0-ai/vm0/issues/23599)) ([d30400a](https://github.com/vm0-ai/vm0/commit/d30400a670d92885654982ce6c3af3c08ceff245))

## [0.148.24](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.23...runner-rs-v0.148.24) (2026-07-28)


### Refactoring

* **runner:** require canonical storage manifests ([#23550](https://github.com/vm0-ai/vm0/issues/23550)) ([cedc736](https://github.com/vm0-ai/vm0/commit/cedc736c5d46390ba0d145df5274359aff5330a6))

## [0.148.23](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.22...runner-rs-v0.148.23) (2026-07-28)


### Bug Fixes

* **runner:** preserve drain override removal after cleanup error ([#23548](https://github.com/vm0-ai/vm0/issues/23548)) ([8bd51ed](https://github.com/vm0-ai/vm0/commit/8bd51edfdfaa6d9bd628ce272f1407782faa51ad))
* trigger api platform and runner releases ([#23559](https://github.com/vm0-ai/vm0/issues/23559)) ([bc61816](https://github.com/vm0-ai/vm0/commit/bc61816360ad9ebe814198d3bd41cff38eeff116))


### Documentation

* **mitm-addon:** document diagnostic candidate selection ([#23536](https://github.com/vm0-ai/vm0/issues/23536)) ([821063e](https://github.com/vm0-ai/vm0/commit/821063e8a59d216a7ba2ca710ccf06c1051fb5c7))

## [0.148.22](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.21...runner-rs-v0.148.22) (2026-07-28)


### Documentation

* **python:** document credential-authority admission contract ([#23537](https://github.com/vm0-ai/vm0/issues/23537)) ([309bbdd](https://github.com/vm0-ai/vm0/commit/309bbdd88512875dc0670dd7456e4d2e7168fe6e))
* **runner:** document claim cooldown rediscovery ([#23538](https://github.com/vm0-ai/vm0/issues/23538)) ([746e5c4](https://github.com/vm0-ai/vm0/commit/746e5c4823ae0ec43dfb9401f81bc8f2a39ce882))


### Refactoring

* **python:** retire raw server binding recorder ([#23520](https://github.com/vm0-ai/vm0/issues/23520)) ([5356139](https://github.com/vm0-ai/vm0/commit/5356139694cea89cb8da6dceea0f329622dcc7a5))


### Performance Improvements

* **runner:** skip no-op private directory chmod ([#23544](https://github.com/vm0-ai/vm0/issues/23544)) ([ee7a54a](https://github.com/vm0-ai/vm0/commit/ee7a54a03c41ebba8804baeee4e700fc8f8beadc))

## [0.148.21](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.20...runner-rs-v0.148.21) (2026-07-28)


### Bug Fixes

* **mitm-addon:** ignore literal auth text in connector diagnostics ([#23488](https://github.com/vm0-ai/vm0/issues/23488)) ([98044a7](https://github.com/vm0-ai/vm0/commit/98044a733fb507a8b0b34f20449f1538932a6b63))

## [0.148.20](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.19...runner-rs-v0.148.20) (2026-07-28)


### Documentation

* **mitm-addon:** align usage facade overview ([#23450](https://github.com/vm0-ai/vm0/issues/23450)) ([9410c4d](https://github.com/vm0-ai/vm0/commit/9410c4dfe83c63040850f2575d9499c0e4ba8a10))
* **mitm-addon:** document codex timing lifecycle ([#23472](https://github.com/vm0-ai/vm0/issues/23472)) ([2e90614](https://github.com/vm0-ai/vm0/commit/2e90614843b930fbba691c902635fec1eb442bdc))


### Refactoring

* **runner:** isolate service drain and resume orchestration ([#23469](https://github.com/vm0-ai/vm0/issues/23469)) ([13fd0e1](https://github.com/vm0-ai/vm0/commit/13fd0e130607ff5f7b58fd98389f2e7013d1d9cb))


### Performance Improvements

* **python:** reuse upstream admission targets ([#23476](https://github.com/vm0-ai/vm0/issues/23476)) ([8998ee8](https://github.com/vm0-ai/vm0/commit/8998ee8d303b719c042e25bb9ae184681b28a00f))
* **runner:** overlap codex model prefetch with workspace mount ([#23448](https://github.com/vm0-ai/vm0/issues/23448)) ([f3eaa96](https://github.com/vm0-ai/vm0/commit/f3eaa96ef69f0af487c1e4c46a76c61916bc6a49))

## [0.148.19](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.18...runner-rs-v0.148.19) (2026-07-28)


### Refactoring

* **python:** require typed network log targets ([#23427](https://github.com/vm0-ai/vm0/issues/23427)) ([2897f24](https://github.com/vm0-ai/vm0/commit/2897f24908ca1486ff9f20ee95672c7f30beb13d))

## [0.148.18](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.17...runner-rs-v0.148.18) (2026-07-28)


### Documentation

* **python:** document request stream billing contract ([#23422](https://github.com/vm0-ai/vm0/issues/23422)) ([bdc72a2](https://github.com/vm0-ai/vm0/commit/bdc72a259f0233e36c1d00eb91f31da87a2d840f))

## [0.148.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.16...runner-rs-v0.148.17) (2026-07-28)


### Bug Fixes

* **runner:** classify codex safety policy refusals ([#23391](https://github.com/vm0-ai/vm0/issues/23391)) ([a1d9986](https://github.com/vm0-ai/vm0/commit/a1d9986f1183067249dc168ba3643acdf05f79ca))
* **runner:** discover first-run session ids after failures ([#23408](https://github.com/vm0-ai/vm0/issues/23408)) ([fa69041](https://github.com/vm0-ai/vm0/commit/fa690416e2c18ed4487ade152bf455233724b8c8))

## [0.148.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.15...runner-rs-v0.148.16) (2026-07-28)


### Refactoring

* **mitm-addon:** retire responses event json wrapper ([#23375](https://github.com/vm0-ai/vm0/issues/23375)) ([c9e6863](https://github.com/vm0-ai/vm0/commit/c9e68635d796f03f8ea57ae4f77a8aae17d0fe1d))
* **runner:** canonicalize profile discovery contract ([#23387](https://github.com/vm0-ai/vm0/issues/23387)) ([b2fb830](https://github.com/vm0-ai/vm0/commit/b2fb830a6c4d656d35ca95f23ee877b652aa8599))
* **runner:** require session history claim encoding ([#23385](https://github.com/vm0-ai/vm0/issues/23385)) ([c4e9a36](https://github.com/vm0-ai/vm0/commit/c4e9a36b2647866fc401b8e4ae335b6429739e6b))

## [0.148.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.14...runner-rs-v0.148.15) (2026-07-27)


### Bug Fixes

* **runner:** trace guest dns through root netfilter ([#23311](https://github.com/vm0-ai/vm0/issues/23311)) ([ca05dd0](https://github.com/vm0-ai/vm0/commit/ca05dd0a296ac2b1634aceba5ca1a64adcbd601a))


### Refactoring

* **mitm-addon:** retire original url compatibility wrapper ([#23312](https://github.com/vm0-ai/vm0/issues/23312)) ([57c4604](https://github.com/vm0-ai/vm0/commit/57c4604e8b4ce6804d18ff93804aeb2236b0efc6))

## [0.148.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.13...runner-rs-v0.148.14) (2026-07-27)


### Bug Fixes

* **runner:** enforce auth.base forwarding deadline ([#23304](https://github.com/vm0-ai/vm0/issues/23304)) ([e2281cc](https://github.com/vm0-ai/vm0/commit/e2281cce09b32062a5149d1c5f58ffcfe692f87d))


### Refactoring

* **mitm-addon:** retire silent usage wrappers ([#23305](https://github.com/vm0-ai/vm0/issues/23305)) ([d22f885](https://github.com/vm0-ai/vm0/commit/d22f885ee86f1090729498c4589084a7e8e3cd29))
* **mitm-addon:** retire stream decoder feed wrapper ([#23302](https://github.com/vm0-ai/vm0/issues/23302)) ([5fcc5ba](https://github.com/vm0-ai/vm0/commit/5fcc5ba79576cdfcc91b1796787740fedb21a66e))

## [0.148.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.12...runner-rs-v0.148.13) (2026-07-27)


### Bug Fixes

* **runner:** distinguish dns readiness timeouts ([#23282](https://github.com/vm0-ai/vm0/issues/23282)) ([1593bf9](https://github.com/vm0-ai/vm0/commit/1593bf9ddbce0c4b022ed7d772b845bbcd86be1b))
* **runner:** revalidate connector admission after auth waits ([#23245](https://github.com/vm0-ai/vm0/issues/23245)) ([0f22b78](https://github.com/vm0-ai/vm0/commit/0f22b788c878faf2bb36afd3f359af95ee1e9614))
* **runner:** stop on unexpected kmsg monitor exit ([#23249](https://github.com/vm0-ai/vm0/issues/23249)) ([e4ec0b5](https://github.com/vm0-ai/vm0/commit/e4ec0b5f0ee8693d39c2c04d4cf45e074c7f5469))


### Documentation

* **mitm-addon:** document base url template safety contract ([#23275](https://github.com/vm0-ai/vm0/issues/23275)) ([594d78a](https://github.com/vm0-ai/vm0/commit/594d78a32ef45a4421e4875e1cfd12d3c099e735))
* **python:** clarify observable flow drain contract ([#23252](https://github.com/vm0-ai/vm0/issues/23252)) ([f9472b4](https://github.com/vm0-ai/vm0/commit/f9472b44fc6abf09bf713c1f4ab857226478916f))


### Performance Improvements

* **mitm-addon:** cache selective json key matching ([#23279](https://github.com/vm0-ai/vm0/issues/23279)) ([097713c](https://github.com/vm0-ai/vm0/commit/097713c556a59964a243846eec676d76fefdd73e))
* **python:** reuse sigv4 url state ([#23284](https://github.com/vm0-ai/vm0/issues/23284)) ([a8922b7](https://github.com/vm0-ai/vm0/commit/a8922b7501d779976b2a0128a396608750c1de32))

## [0.148.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.11...runner-rs-v0.148.12) (2026-07-27)


### Bug Fixes

* **mitm-addon:** track implicit exception aliases ([#23191](https://github.com/vm0-ai/vm0/issues/23191)) ([f1c562b](https://github.com/vm0-ai/vm0/commit/f1c562be79547cdfb4391c001e67a1d94865efbe))
* **runner:** reject ambiguous host authorities ([#23194](https://github.com/vm0-ai/vm0/issues/23194)) ([2810583](https://github.com/vm0-ai/vm0/commit/28105839cb41b02d45d4a78a9fa71b62551b8f12))


### Documentation

* **runner:** document fresh archive delivery lifecycle ([#23205](https://github.com/vm0-ai/vm0/issues/23205)) ([86ed1c8](https://github.com/vm0-ai/vm0/commit/86ed1c8238449e34b855ee51028c4d782cbdfb94))


### Refactoring

* **connectors:** remove static catalog authority ([#23201](https://github.com/vm0-ai/vm0/issues/23201)) ([590a2ff](https://github.com/vm0-ai/vm0/commit/590a2ff16caf5ca5534954be53a0e7bf4b61376e))


### Performance Improvements

* **mitm-addon:** share websocket event type probing ([#23230](https://github.com/vm0-ai/vm0/issues/23230)) ([d71de68](https://github.com/vm0-ai/vm0/commit/d71de68e04f2d90ef3269a420ba9cd39797f62cd))
* **python:** reuse public destination host classifications ([#23203](https://github.com/vm0-ai/vm0/issues/23203)) ([2a31839](https://github.com/vm0-ai/vm0/commit/2a318395e1009b1bef8f340d5db8985f74ac4f3a))
* **runner:** bound network log upload lifecycle ([#23219](https://github.com/vm0-ai/vm0/issues/23219)) ([f9a6f20](https://github.com/vm0-ai/vm0/commit/f9a6f2095b24a4bbab46866be5ff5b126eb2bf9d))

## [0.148.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.10...runner-rs-v0.148.11) (2026-07-27)


### Documentation

* **mitm-addon:** clarify authoritative endpoint tuple projection ([#23166](https://github.com/vm0-ai/vm0/issues/23166)) ([d24fa5b](https://github.com/vm0-ai/vm0/commit/d24fa5b7616ee20bddfe7f4daba455cbb4fd8aa6))
* **runner:** document held-session snapshot concurrency ([#23168](https://github.com/vm0-ai/vm0/issues/23168)) ([e2a5f7c](https://github.com/vm0-ai/vm0/commit/e2a5f7cce6db3199777874753b1a45679bce81a6))

## [0.148.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.9...runner-rs-v0.148.10) (2026-07-26)

## [0.148.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.8...runner-rs-v0.148.9) (2026-07-26)

## [0.148.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.7...runner-rs-v0.148.8) (2026-07-26)


### Bug Fixes

* **mitm-addon:** preserve usage when diagnostic type overflows ([#23115](https://github.com/vm0-ai/vm0/issues/23115)) ([bde3c3a](https://github.com/vm0-ai/vm0/commit/bde3c3ab5c210677df510c11639813907d898bdf))


### Documentation

* **python:** describe firewall allow auth handling ([#23113](https://github.com/vm0-ai/vm0/issues/23113)) ([74955f5](https://github.com/vm0-ai/vm0/commit/74955f580da930ee6eda1849624dbf4007f94d29))


### Performance Improvements

* **mitm-addon:** avoid duplicate public destination validation ([#23117](https://github.com/vm0-ai/vm0/issues/23117)) ([362e539](https://github.com/vm0-ai/vm0/commit/362e53955ec91226c1ddd85809ca9b854e2d2ae1))

## [0.148.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.6...runner-rs-v0.148.7) (2026-07-26)

## [0.148.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.5...runner-rs-v0.148.6) (2026-07-26)


### Documentation

* **mitm-addon:** clarify decompress_body test contract ([#23108](https://github.com/vm0-ai/vm0/issues/23108)) ([f0e39ab](https://github.com/vm0-ai/vm0/commit/f0e39abf0779bfdb390feecd5dd86d7d9e7ee077))

## [0.148.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.4...runner-rs-v0.148.5) (2026-07-26)


### Bug Fixes

* trigger api platform and runner releases ([#23091](https://github.com/vm0-ai/vm0/issues/23091)) ([100f6fe](https://github.com/vm0-ai/vm0/commit/100f6fe7fbb9fd8d84044bf12f1c6633c1c0b025))

## [0.148.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.3...runner-rs-v0.148.4) (2026-07-25)


### Refactoring

* **storage:** require canonical runner claim manifests ([#23059](https://github.com/vm0-ai/vm0/issues/23059)) ([2c8b7d3](https://github.com/vm0-ai/vm0/commit/2c8b7d3cfe190c762cd7d6559d057fa6d189b092))

## [0.148.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.2...runner-rs-v0.148.3) (2026-07-25)


### Performance Improvements

* **runner:** instrument claude output lifecycle timings ([#23044](https://github.com/vm0-ai/vm0/issues/23044)) ([9220364](https://github.com/vm0-ai/vm0/commit/92203640174897f8558880e3dca974c2ca489bb1))

## [0.148.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.1...runner-rs-v0.148.2) (2026-07-25)


### Bug Fixes

* **guest-agent:** classify no-chunks stream timeouts ([#23041](https://github.com/vm0-ai/vm0/issues/23041)) ([f3a9714](https://github.com/vm0-ai/vm0/commit/f3a97146f04c2b883c00f174f05a2ead14ec5342))

## [0.148.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.148.0...runner-rs-v0.148.1) (2026-07-25)


### Bug Fixes

* **mitm-addon:** reject null host policy fields ([#23013](https://github.com/vm0-ai/vm0/issues/23013)) ([8178a3f](https://github.com/vm0-ai/vm0/commit/8178a3f642924f3d64cc7ca68abab78819767219))
* **runner:** reject forbidden provider host characters ([#23015](https://github.com/vm0-ai/vm0/issues/23015)) ([a0397d6](https://github.com/vm0-ai/vm0/commit/a0397d65a2642c4910411b62c349e0c042ee8815))


### Documentation

* **mitm-addon:** fix proxy registry source reference ([#23012](https://github.com/vm0-ai/vm0/issues/23012)) ([6b074eb](https://github.com/vm0-ai/vm0/commit/6b074ebc62a6c1bba9c0c99c4f672b13f5633655))
* **python:** clarify path pattern validation boundary ([#23011](https://github.com/vm0-ai/vm0/issues/23011)) ([4d10854](https://github.com/vm0-ai/vm0/commit/4d10854f7b48c206a5db084d5035eeb8817b75ca))


### Performance Improvements

* **mitm-addon:** avoid zstd frame-tail copies ([#23016](https://github.com/vm0-ai/vm0/issues/23016)) ([fe0c95f](https://github.com/vm0-ai/vm0/commit/fe0c95ffa070d194c7a617096958a986cb7c4aaf))

## [0.148.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.19...runner-rs-v0.148.0) (2026-07-25)


### Features

* **zero:** add managed browsers with shared user profiles ([#22940](https://github.com/vm0-ai/vm0/issues/22940)) ([a56eeac](https://github.com/vm0-ai/vm0/commit/a56eeac6a74f30fae2fcfb2d69fa8b0840da6764))


### Bug Fixes

* **runner:** honor systemd-selected service config ([#23002](https://github.com/vm0-ai/vm0/issues/23002)) ([00d487e](https://github.com/vm0-ai/vm0/commit/00d487e6639cb54b27a0ad793091151c08721d9a))


### Documentation

* **mitm-addon:** document x tld snapshot updates ([#23005](https://github.com/vm0-ai/vm0/issues/23005)) ([eecac65](https://github.com/vm0-ai/vm0/commit/eecac65a99f5bc7118aaeeaf86b32aaa13db91ef))
* **runner:** clarify gc command cleanup scope ([#22985](https://github.com/vm0-ai/vm0/issues/22985)) ([9067178](https://github.com/vm0-ai/vm0/commit/90671783978da24278d8eddac2e75ad30ca1d3b6))


### Refactoring

* **mitm-addon:** centralize diagnostic candidate metadata ([#22966](https://github.com/vm0-ai/vm0/issues/22966)) ([4e344ab](https://github.com/vm0-ai/vm0/commit/4e344ab729c8d57bbe271b492761af0f5fe2887a))
* **runner:** encapsulate cancellation registrations ([#22945](https://github.com/vm0-ai/vm0/issues/22945)) ([267e12c](https://github.com/vm0-ai/vm0/commit/267e12cf7213309e120d907f31555315a6bd2b68))


### Performance Improvements

* **runner:** instrument codex provider output timing ([#22996](https://github.com/vm0-ai/vm0/issues/22996)) ([78ff42e](https://github.com/vm0-ai/vm0/commit/78ff42e1809f4044850447536d6f2155abcf80ac))

## [0.147.19](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.18...runner-rs-v0.147.19) (2026-07-25)

## [0.147.18](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.17...runner-rs-v0.147.18) (2026-07-25)


### Refactoring

* **db:** remove legacy model observation storage ([#22907](https://github.com/vm0-ai/vm0/issues/22907)) ([ee4895e](https://github.com/vm0-ai/vm0/commit/ee4895e77f921cccbfd44c422763652120e2de82))

## [0.147.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.16...runner-rs-v0.147.17) (2026-07-24)


### Bug Fixes

* **runner:** make version config gc retryable ([#22889](https://github.com/vm0-ai/vm0/issues/22889)) ([324a425](https://github.com/vm0-ai/vm0/commit/324a42529b537637f93385f286b31f479006b27c))

## [0.147.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.15...runner-rs-v0.147.16) (2026-07-24)


### Bug Fixes

* **python:** normalize X billing method casing ([#22882](https://github.com/vm0-ai/vm0/issues/22882)) ([e43a2ab](https://github.com/vm0-ai/vm0/commit/e43a2ab9e9959471fc27d8dfc945982adde97413))
* **runner:** trigger patch release ([#22876](https://github.com/vm0-ai/vm0/issues/22876)) ([24d9daa](https://github.com/vm0-ai/vm0/commit/24d9daaf4e7595b952d709bbd638da88262cf5d4))

## [0.147.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.14...runner-rs-v0.147.15) (2026-07-24)


### Performance Improvements

* compact model usage observations ([#22848](https://github.com/vm0-ai/vm0/issues/22848)) ([80d3241](https://github.com/vm0-ai/vm0/commit/80d3241799f4a710e9fc942f5a5685e7cabd7498))

## [0.147.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.13...runner-rs-v0.147.14) (2026-07-24)


### Bug Fixes

* **mitm-addon:** remove stale ruff suppression ([#22817](https://github.com/vm0-ai/vm0/issues/22817)) ([6817ce8](https://github.com/vm0-ai/vm0/commit/6817ce8a4e233d8600abffb5b9436a6775d4d5f5))


### Refactoring

* **api:** remove checkpoint resume and read api ([#22815](https://github.com/vm0-ai/vm0/issues/22815)) ([ad0d0b3](https://github.com/vm0-ai/vm0/commit/ad0d0b39655d1dd4bafeabe0e8a8bbb32247db47))

## [0.147.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.12...runner-rs-v0.147.13) (2026-07-23)


### Bug Fixes

* **runner:** preserve reused codex rollout paths ([#22783](https://github.com/vm0-ai/vm0/issues/22783)) ([0413bda](https://github.com/vm0-ai/vm0/commit/0413bdaba888f5c5432dfbdf2b889f2d4a219e5c))

## [0.147.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.11...runner-rs-v0.147.12) (2026-07-23)

## [0.147.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.10...runner-rs-v0.147.11) (2026-07-23)


### Bug Fixes

* **runner:** scope platform api auto-allow to configured port ([#22746](https://github.com/vm0-ai/vm0/issues/22746)) ([7c0babf](https://github.com/vm0-ai/vm0/commit/7c0babfe551f715104345e9a5048e331b972e6ad))

## [0.147.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.9...runner-rs-v0.147.10) (2026-07-23)

## [0.147.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.8...runner-rs-v0.147.9) (2026-07-23)


### Bug Fixes

* **runner:** recover failed usage timer starts ([#22732](https://github.com/vm0-ai/vm0/issues/22732)) ([30a2a42](https://github.com/vm0-ai/vm0/commit/30a2a42680f513eebcd613df2a70d65af6b943b2))

## [0.147.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.7...runner-rs-v0.147.8) (2026-07-23)

## [0.147.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.6...runner-rs-v0.147.7) (2026-07-23)


### Bug Fixes

* **runner:** preserve session history cancellation ([#22705](https://github.com/vm0-ai/vm0/issues/22705)) ([2a968e3](https://github.com/vm0-ai/vm0/commit/2a968e3dd063c4436ad8218ed55f110494c29b9c))

## [0.147.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.5...runner-rs-v0.147.6) (2026-07-23)


### Refactoring

* **runner:** split workspace cache tests by behavior ([#22698](https://github.com/vm0-ai/vm0/issues/22698)) ([6e08cd5](https://github.com/vm0-ai/vm0/commit/6e08cd5f50f1c8d87f710a55120187291ae92b06))

## [0.147.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.4...runner-rs-v0.147.5) (2026-07-23)


### Documentation

* **runner:** document public destination classifier contract ([#22681](https://github.com/vm0-ai/vm0/issues/22681)) ([509e2ac](https://github.com/vm0-ai/vm0/commit/509e2ac7e46f374568e8dfa05a931c656ce9c832))

## [0.147.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.3...runner-rs-v0.147.4) (2026-07-23)


### Bug Fixes

* **runner:** restore sandbox Codex CLI to 0.144.6 ([#22639](https://github.com/vm0-ai/vm0/issues/22639)) ([79ccf8d](https://github.com/vm0-ai/vm0/commit/79ccf8d5071cab30c7f72a45da0f3fc1b3c6c798))


### Performance Improvements

* **runner:** move reused mount validation to idle admission ([#22610](https://github.com/vm0-ai/vm0/issues/22610)) ([710f9da](https://github.com/vm0-ai/vm0/commit/710f9da64fbb6d86a1588df02da2077dfb7c938a))

## [0.147.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.2...runner-rs-v0.147.3) (2026-07-23)

## [0.147.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.1...runner-rs-v0.147.2) (2026-07-22)


### Bug Fixes

* **runner:** classify guest dns readiness failures ([#22547](https://github.com/vm0-ai/vm0/issues/22547)) ([12fd057](https://github.com/vm0-ai/vm0/commit/12fd057dfb23604891fce86ca7c6f4915e896249))


### Performance Improvements

* **sandbox-fc:** batch firewall mutations ([#22589](https://github.com/vm0-ai/vm0/issues/22589)) ([8433c4c](https://github.com/vm0-ai/vm0/commit/8433c4c3057b08c4c548adc0c50125a118077719))

## [0.147.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.147.0...runner-rs-v0.147.1) (2026-07-22)

## [0.147.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.29...runner-rs-v0.147.0) (2026-07-22)


### Features

* **runner:** accept canonical storage mount manifests ([#22546](https://github.com/vm0-ai/vm0/issues/22546)) ([d9cea3a](https://github.com/vm0-ai/vm0/commit/d9cea3a2f56de399b38ef9d1f004da740b699bbc))


### Performance Improvements

* **runner:** attribute sandbox start phases ([#22523](https://github.com/vm0-ai/vm0/issues/22523)) ([cd8f6a4](https://github.com/vm0-ai/vm0/commit/cd8f6a40c109d7b04bd991067fdf2b5ad1c77ca8))

## [0.146.29](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.28...runner-rs-v0.146.29) (2026-07-22)


### Bug Fixes

* **firewall:** enforce ports for parameterized bases ([#22489](https://github.com/vm0-ai/vm0/issues/22489)) ([d520ba9](https://github.com/vm0-ai/vm0/commit/d520ba90e6eeb842eaf8182594147be3c6e91317))
* **runner:** bound streaming zlib expansion ([#22449](https://github.com/vm0-ai/vm0/issues/22449)) ([3c01b04](https://github.com/vm0-ai/vm0/commit/3c01b044dad77fc9ba3610743a8331be629545fd))

## [0.146.28](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.27...runner-rs-v0.146.28) (2026-07-22)


### Performance Improvements

* **runner:** deliver bounded cold archives while fresh sandboxes start ([#22409](https://github.com/vm0-ai/vm0/issues/22409)) ([bc9a4c1](https://github.com/vm0-ai/vm0/commit/bc9a4c1718410a928ff4cb0859fc9367f63fee44))

## [0.146.27](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.26...runner-rs-v0.146.27) (2026-07-21)


### Bug Fixes

* **runner:** avoid signal reentrant flush deadlock ([#22448](https://github.com/vm0-ai/vm0/issues/22448)) ([221989f](https://github.com/vm0-ai/vm0/commit/221989f453153f541ae2a7f362c8d1b001b09423))


### Performance Improvements

* **runner:** stop scanning r2 cache during gc ([#22440](https://github.com/vm0-ai/vm0/issues/22440)) ([51cb14f](https://github.com/vm0-ai/vm0/commit/51cb14faddadc9191fcc1ad61001e8cb404650b1))

## [0.146.26](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.25...runner-rs-v0.146.26) (2026-07-21)


### Performance Improvements

* align session-history sidecar capacity with resume limit ([#22392](https://github.com/vm0-ai/vm0/issues/22392)) ([6eee854](https://github.com/vm0-ai/vm0/commit/6eee8548718c69c4d46afe9b1ddcd8c7babcca59))

## [0.146.25](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.24...runner-rs-v0.146.25) (2026-07-21)

## [0.146.24](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.23...runner-rs-v0.146.24) (2026-07-21)


### Refactoring

* **runner:** centralize session history telemetry fields ([#22373](https://github.com/vm0-ai/vm0/issues/22373)) ([c5ae2f7](https://github.com/vm0-ai/vm0/commit/c5ae2f71e02d6e02b4677bb9d168c4396c10c46f))

## [0.146.23](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.22...runner-rs-v0.146.23) (2026-07-21)


### Documentation

* **runner:** clarify name validation lifecycle ([#22352](https://github.com/vm0-ai/vm0/issues/22352)) ([a21cdb9](https://github.com/vm0-ai/vm0/commit/a21cdb97ac7ac2072b0b1093477bd32ac91b28c3))

## [0.146.22](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.21...runner-rs-v0.146.22) (2026-07-21)


### Bug Fixes

* **connectors:** use permissionless api as routing fallback ([#22330](https://github.com/vm0-ai/vm0/issues/22330)) ([222d852](https://github.com/vm0-ai/vm0/commit/222d852615a507c03375b3aedcf50a3094b5fdcf))

## [0.146.21](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.20...runner-rs-v0.146.21) (2026-07-21)


### Documentation

* **mitm-addon:** clarify usage buffer close contract ([#22288](https://github.com/vm0-ai/vm0/issues/22288)) ([3339719](https://github.com/vm0-ai/vm0/commit/3339719db4cd2471a30ee4627ac2c40c2642eb56))
* **runner:** update storage cache gc documentation ([#22298](https://github.com/vm0-ai/vm0/issues/22298)) ([dfed3a1](https://github.com/vm0-ai/vm0/commit/dfed3a1ae354197bff6e3aad59d6873123aaf010))


### Performance Improvements

* **runner:** avoid duplicate live runner registry scans ([#22306](https://github.com/vm0-ai/vm0/issues/22306)) ([571db03](https://github.com/vm0-ai/vm0/commit/571db035fe34f358c539095e3e13de5ba922ee23))

## [0.146.20](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.19...runner-rs-v0.146.20) (2026-07-21)

## [0.146.19](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.18...runner-rs-v0.146.19) (2026-07-21)


### Bug Fixes

* **runner:** prevent claim rejection rediscovery loops ([#22250](https://github.com/vm0-ai/vm0/issues/22250)) ([068c509](https://github.com/vm0-ai/vm0/commit/068c509eb9b9e864fb4665c1bc8450a3d9bfbd37))

## [0.146.18](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.17...runner-rs-v0.146.18) (2026-07-20)


### Bug Fixes

* **runner:** fail local cancel on incomplete claim scan ([#22234](https://github.com/vm0-ai/vm0/issues/22234)) ([e3db740](https://github.com/vm0-ai/vm0/commit/e3db7405dfea92464ff019781771ce30a8ac22b4))


### Documentation

* **mitm-addon:** document signed pricing protocol ([#22236](https://github.com/vm0-ai/vm0/issues/22236)) ([d5e07cc](https://github.com/vm0-ai/vm0/commit/d5e07cca5c8118afab4f8df609534f2ceadd06ce))

## [0.146.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.16...runner-rs-v0.146.17) (2026-07-20)


### Refactoring

* **runner:** remove claim resource telemetry ([#22230](https://github.com/vm0-ai/vm0/issues/22230)) ([cbb2bf1](https://github.com/vm0-ai/vm0/commit/cbb2bf1b10c9b2364d7f13b2b8d7409f35c2f360))

## [0.146.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.15...runner-rs-v0.146.16) (2026-07-20)


### Refactoring

* **runner:** extract session history restore planning ([#22215](https://github.com/vm0-ai/vm0/issues/22215)) ([f4c6f20](https://github.com/vm0-ai/vm0/commit/f4c6f2059e1d45128b280cb3a4d68513419282be))
* **runner:** remove generation claim attribution ([#22201](https://github.com/vm0-ai/vm0/issues/22201)) ([5f0d316](https://github.com/vm0-ai/vm0/commit/5f0d316ccb916fd575b0fe93f23061cb88dc4df7))


### Performance Improvements

* **mitm-addon:** avoid repeated idna normalization in x billing ([#22199](https://github.com/vm0-ai/vm0/issues/22199)) ([fd2c921](https://github.com/vm0-ai/vm0/commit/fd2c921da2e10a213eb645cfca08033d8db805b8))
* **runner:** inventory workspace cache once per gc ([#22202](https://github.com/vm0-ai/vm0/issues/22202)) ([c7e1a1e](https://github.com/vm0-ai/vm0/commit/c7e1a1e5ff09c46171a036b57cd3630ee9d415f1))

## [0.146.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.14...runner-rs-v0.146.15) (2026-07-20)


### Refactoring

* **runner:** remove sidecar allocated bytes ([#22153](https://github.com/vm0-ai/vm0/issues/22153)) ([a1262bf](https://github.com/vm0-ai/vm0/commit/a1262bf971717df6bbdd719bae8d8730f92557d4))

## [0.146.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.13...runner-rs-v0.146.14) (2026-07-19)


### Performance Improvements

* **storage:** propagate encoded archive sizes ([#22142](https://github.com/vm0-ai/vm0/issues/22142)) ([10fc760](https://github.com/vm0-ai/vm0/commit/10fc7608fdd82ab064da0dfc280667bba0cd64a8))

## [0.146.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.12...runner-rs-v0.146.13) (2026-07-19)


### Bug Fixes

* **runner:** block managed credentials on track requests ([#22131](https://github.com/vm0-ai/vm0/issues/22131)) ([d5ab2e3](https://github.com/vm0-ai/vm0/commit/d5ab2e3cf937a85ee2f6adc72de83b1c41a09e06))
* **runner:** wait for orphan exit before cleanup ([#22119](https://github.com/vm0-ai/vm0/issues/22119)) ([57c35f1](https://github.com/vm0-ai/vm0/commit/57c35f10bc7464af009b0c7217b1c91660ae8dca))


### Documentation

* **mitm-addon:** define shared-base ownership status contract ([#22117](https://github.com/vm0-ai/vm0/issues/22117)) ([76455e1](https://github.com/vm0-ai/vm0/commit/76455e132cb84b395aeead621f9541668dc9bcdd))


### Performance Improvements

* **mitm-addon:** skip documented responses non-usage events ([#22129](https://github.com/vm0-ai/vm0/issues/22129)) ([802432e](https://github.com/vm0-ai/vm0/commit/802432e55de35e037c3a88b5122299a0a9339563))

## [0.146.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.11...runner-rs-v0.146.12) (2026-07-19)


### Bug Fixes

* **runner:** accept sidecar metadata without allocated bytes ([#22096](https://github.com/vm0-ai/vm0/issues/22096)) ([2ccbc39](https://github.com/vm0-ai/vm0/commit/2ccbc39806bbe286bfff04390e4252b15eae5beb))

## [0.146.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.10...runner-rs-v0.146.11) (2026-07-18)


### Bug Fixes

* **mitm-addon:** drain retained usage after executor shutdown ([#22071](https://github.com/vm0-ai/vm0/issues/22071)) ([541764e](https://github.com/vm0-ai/vm0/commit/541764eb57a94e5cb68ce107f01029276cf7b692))
* **mitm-addon:** report x ndjson row failures ([#22067](https://github.com/vm0-ai/vm0/issues/22067)) ([6455d60](https://github.com/vm0-ai/vm0/commit/6455d60b1af7d29f89e8fc2dd85e2f38652dc32e))
* **runner:** reject stale heartbeat snapshots ([#22076](https://github.com/vm0-ai/vm0/issues/22076)) ([d91617a](https://github.com/vm0-ai/vm0/commit/d91617a24c17a394a9836033548808350dcc05db))


### Refactoring

* **mitm-addon:** make catalog snapshot identity explicit ([#22066](https://github.com/vm0-ai/vm0/issues/22066)) ([cfd9bf3](https://github.com/vm0-ai/vm0/commit/cfd9bf33635c66aa09ca26a5a6a737a860283df4))


### Performance Improvements

* **mitm-addon:** bound starred argument expansion ([#22070](https://github.com/vm0-ai/vm0/issues/22070)) ([489da2c](https://github.com/vm0-ai/vm0/commit/489da2c719d4b36caf4041bd1b3ccb9d47262fee))

## [0.146.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.9...runner-rs-v0.146.10) (2026-07-18)


### Refactoring

* **runner:** remove affinity rollout compatibility ([#22021](https://github.com/vm0-ai/vm0/issues/22021)) ([8cc7c76](https://github.com/vm0-ai/vm0/commit/8cc7c76552a1f0bbf9361b0b26721fc36867dc12))

## [0.146.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.8...runner-rs-v0.146.9) (2026-07-17)


### Bug Fixes

* **mitm-addon:** preserve explicit port zero in network logs ([#22010](https://github.com/vm0-ai/vm0/issues/22010)) ([4940def](https://github.com/vm0-ai/vm0/commit/4940def63f892e8b10f500a9db979ce669f06304))
* **runner:** reject unbounded auth.base h2 request bodies ([#22019](https://github.com/vm0-ai/vm0/issues/22019)) ([19fff6d](https://github.com/vm0-ai/vm0/commit/19fff6de49fa4ea2cbdc48d728a38e9e51a167a1))


### Documentation

* **python:** document tcp message byte accounting ([#22007](https://github.com/vm0-ai/vm0/issues/22007)) ([67dd6b8](https://github.com/vm0-ai/vm0/commit/67dd6b8ccfa9990e2ecea919b59ff1f13922246e))


### Refactoring

* **mitm-addon:** centralize model usage pricing contract ([#22016](https://github.com/vm0-ai/vm0/issues/22016)) ([427e17d](https://github.com/vm0-ai/vm0/commit/427e17d15fb6e7b83e72692072ec0b2c1521f4eb))


### Performance Improvements

* **mitm-addon:** avoid jsonl backlog copies ([#22017](https://github.com/vm0-ai/vm0/issues/22017)) ([edd27ed](https://github.com/vm0-ai/vm0/commit/edd27ed7e0afaf4ac9e13afa1b7a9a8c731f14de))

## [0.146.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.7...runner-rs-v0.146.8) (2026-07-17)


### Bug Fixes

* **mitm-addon:** avoid api authority binding from shared ips ([#22004](https://github.com/vm0-ai/vm0/issues/22004)) ([3f42bd9](https://github.com/vm0-ai/vm0/commit/3f42bd9f07a7f96ddb3192109ac8ca8730b800ef))

## [0.146.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.6...runner-rs-v0.146.7) (2026-07-17)


### Bug Fixes

* **mitm-addon:** detect unbound metadata key access ([#21993](https://github.com/vm0-ai/vm0/issues/21993)) ([b576de6](https://github.com/vm0-ai/vm0/commit/b576de61241c47db045b47b0fcc0a6847e941f30))
* **runner:** delegate service signals to systemd ([#21981](https://github.com/vm0-ai/vm0/issues/21981)) ([2ed47da](https://github.com/vm0-ai/vm0/commit/2ed47da8d62d4b98b159407d298896fac2b4fd55))


### Documentation

* **mitm-addon:** clarify jsonl flush completion semantics ([#21982](https://github.com/vm0-ai/vm0/issues/21982)) ([ab74d23](https://github.com/vm0-ai/vm0/commit/ab74d230fc50eea4a2c86c08b3a9e3686d181894))

## [0.146.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.5...runner-rs-v0.146.6) (2026-07-17)


### Performance Improvements

* **runner:** attribute generation-specific workspace sidecars ([#21972](https://github.com/vm0-ai/vm0/issues/21972)) ([315f271](https://github.com/vm0-ai/vm0/commit/315f27174d6a759204e378a793acf03ed89bddd8))
* **runner:** release status lock before persistence ([#21976](https://github.com/vm0-ai/vm0/issues/21976)) ([38da2d0](https://github.com/vm0-ai/vm0/commit/38da2d0ce4e7fc0623dfd30a9beeb145781aa6f8))

## [0.146.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.4...runner-rs-v0.146.5) (2026-07-17)


### Bug Fixes

* **mitm-addon:** avoid stale bytecode in tld snapshot checks ([#21948](https://github.com/vm0-ai/vm0/issues/21948)) ([78c511b](https://github.com/vm0-ai/vm0/commit/78c511bec86c587a2a7dabfb0658bff41b264bab))
* **runner:** validate brotli tails at decode limit ([#21961](https://github.com/vm0-ai/vm0/issues/21961)) ([786172a](https://github.com/vm0-ai/vm0/commit/786172ac3c3493ad5cde0c21e63ff2308f4ae3ec))

## [0.146.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.3...runner-rs-v0.146.4) (2026-07-17)


### Bug Fixes

* **runner:** scope interception certificates to tls sni ([#21939](https://github.com/vm0-ai/vm0/issues/21939)) ([7f2ca7a](https://github.com/vm0-ai/vm0/commit/7f2ca7a811ad68f38153a9fe5b9052d671b8de92))


### Refactoring

* **mitm-addon:** split websocket tests by responsibility ([#21942](https://github.com/vm0-ai/vm0/issues/21942)) ([a60ae85](https://github.com/vm0-ai/vm0/commit/a60ae85500311dfaf70b1056049c41cf68dea9ee))

## [0.146.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.2...runner-rs-v0.146.3) (2026-07-17)

## [0.146.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.1...runner-rs-v0.146.2) (2026-07-17)


### Refactoring

* **runner:** add generic workspace affinity resource classes ([#21888](https://github.com/vm0-ai/vm0/issues/21888)) ([92bf6af](https://github.com/vm0-ai/vm0/commit/92bf6af909f9aa3666a256edbfdad016b94947a6))

## [0.146.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.146.0...runner-rs-v0.146.1) (2026-07-16)


### Bug Fixes

* **runner:** classify oversized sidecars as unavailable ([#21877](https://github.com/vm0-ai/vm0/issues/21877)) ([d9fde61](https://github.com/vm0-ai/vm0/commit/d9fde61a0cce1579c4cf841e3e721aaf016eb537))
* **runner:** recover from guest dns readiness failures ([#21879](https://github.com/vm0-ai/vm0/issues/21879)) ([38a6647](https://github.com/vm0-ai/vm0/commit/38a664712e595a88a482df90ef8012f976c3f128))


### Refactoring

* **runner:** publish profile-qualified workspace cache state ([#21874](https://github.com/vm0-ai/vm0/issues/21874)) ([68b399b](https://github.com/vm0-ai/vm0/commit/68b399b571023b63db4a2f4f625eef1c9ded9b48))

## [0.146.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.145.6...runner-rs-v0.146.0) (2026-07-16)


### Features

* bill model usage from signed proxy price schedules ([#21696](https://github.com/vm0-ai/vm0/issues/21696)) ([e4c9fc7](https://github.com/vm0-ai/vm0/commit/e4c9fc72ec4004b8ff6db197c6e4ee1a888e9d30))


### Bug Fixes

* **mitm-addon:** preserve x url prefixes at valid boundaries ([#21852](https://github.com/vm0-ai/vm0/issues/21852)) ([c9f4352](https://github.com/vm0-ai/vm0/commit/c9f4352db18a431bc78abe3f2bd374c75b386d33))
* **runner:** extend cancel terminal grace for containment ([#21840](https://github.com/vm0-ai/vm0/issues/21840)) ([2f29ee1](https://github.com/vm0-ai/vm0/commit/2f29ee111a7efaba1cf30ea818be2d1723a8cc51))
* **runner:** freeze workspace before cache promotion ([#21766](https://github.com/vm0-ai/vm0/issues/21766)) ([4828529](https://github.com/vm0-ai/vm0/commit/4828529d91370061e0da065c7082bada5b426e21))


### Documentation

* **mitm-addon:** clarify firewall api id resolution ([#21847](https://github.com/vm0-ai/vm0/issues/21847)) ([5cfec09](https://github.com/vm0-ai/vm0/commit/5cfec093d3870056337c8b9d6ab7135007ce168c))


### Refactoring

* **mitm-addon:** expose websocket test helper api ([#21842](https://github.com/vm0-ai/vm0/issues/21842)) ([59a3f1b](https://github.com/vm0-ai/vm0/commit/59a3f1b8b4f15fcd661360c19dfe42090c63144e))
* **mitm-addon:** share sync and async loop traversal ([#21848](https://github.com/vm0-ai/vm0/issues/21848)) ([fd99c6f](https://github.com/vm0-ai/vm0/commit/fd99c6f96141b1dcccf771026553cc784fae6da7))

## [0.145.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.145.5...runner-rs-v0.145.6) (2026-07-16)


### Bug Fixes

* **runner:** contain supervised run descendants ([#21780](https://github.com/vm0-ai/vm0/issues/21780)) ([23e961c](https://github.com/vm0-ai/vm0/commit/23e961ce1b30f45ec9786e30289d870f5f436762))

## [0.145.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.145.4...runner-rs-v0.145.5) (2026-07-16)


### Bug Fixes

* **runner:** bound image gc lock descriptors ([#21811](https://github.com/vm0-ai/vm0/issues/21811)) ([f4fe116](https://github.com/vm0-ai/vm0/commit/f4fe1161f73d0db7a59aec543dd0123d7f8ad729))
* **runner:** isolate heartbeat requests from reactor ([#21804](https://github.com/vm0-ai/vm0/issues/21804)) ([775dc63](https://github.com/vm0-ai/vm0/commit/775dc631c94f62e9a496591399afdfe9f846cf19))

## [0.145.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.145.3...runner-rs-v0.145.4) (2026-07-16)


### Bug Fixes

* **runner:** block managed credentials on trace requests ([#21809](https://github.com/vm0-ai/vm0/issues/21809)) ([a566343](https://github.com/vm0-ai/vm0/commit/a566343639a826255c224bfaa7fbbda64145b76e))
* support dynamic vm0 model routing ([#21693](https://github.com/vm0-ai/vm0/issues/21693)) ([80d0dca](https://github.com/vm0-ai/vm0/commit/80d0dca1f3e198f7c83ed28783da740d2215675f))

## [0.145.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.145.2...runner-rs-v0.145.3) (2026-07-16)


### Bug Fixes

* **runner:** fail closed on incomplete image gc scans ([#21749](https://github.com/vm0-ai/vm0/issues/21749)) ([df65c9c](https://github.com/vm0-ai/vm0/commit/df65c9c846856e3ec8956b98bf6229f832841872))
* **runner:** protect sidecar staging from cache gc ([#21768](https://github.com/vm0-ai/vm0/issues/21768)) ([8cb2c6e](https://github.com/vm0-ai/vm0/commit/8cb2c6edd019ec693de467a2e592fa7820fd0645))

## [0.145.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.145.1...runner-rs-v0.145.2) (2026-07-16)


### Bug Fixes

* **mitm-addon:** validate empty zlib tails at decode limit ([#21750](https://github.com/vm0-ai/vm0/issues/21750)) ([8acba08](https://github.com/vm0-ai/vm0/commit/8acba0859c99cb39dec9113317b16ce88326fc22))
* **runner:** close workspace gc ownership race ([#21754](https://github.com/vm0-ai/vm0/issues/21754)) ([e198e65](https://github.com/vm0-ai/vm0/commit/e198e6590e3fd2814451993b7210f261734bb1fd))


### Documentation

* **mitm-addon:** align request hook classification contract ([#21742](https://github.com/vm0-ai/vm0/issues/21742)) ([8c17d00](https://github.com/vm0-ai/vm0/commit/8c17d00b783bc4ed9d24c26942c2b0735ac845ec))

## [0.145.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.145.0...runner-rs-v0.145.1) (2026-07-16)


### Documentation

* **mitm-addon:** clarify force-refresh cooldown start ([#21717](https://github.com/vm0-ai/vm0/issues/21717)) ([3cb10d3](https://github.com/vm0-ai/vm0/commit/3cb10d32285b1171dbcaed15406d48e53f1bd918))

## [0.145.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.26...runner-rs-v0.145.0) (2026-07-16)


### Features

* route vm0-auto through signed usage proxy ([#21437](https://github.com/vm0-ai/vm0/issues/21437)) ([cdb5bee](https://github.com/vm0-ai/vm0/commit/cdb5beeb3617f207570635e1497d57a4f796e329))


### Bug Fixes

* describe zero scrape capabilities in agent context ([#21574](https://github.com/vm0-ai/vm0/issues/21574)) ([5d5b298](https://github.com/vm0-ai/vm0/commit/5d5b298b1396f2e4c1ee6873d429987fcb9df4cc))
* **runner:** bound r2 template archive extraction ([#21680](https://github.com/vm0-ai/vm0/issues/21680)) ([8860bb8](https://github.com/vm0-ai/vm0/commit/8860bb808995889be734dd115165c272b46f3c52))
* **runner:** reject invalid parameterized firewall authorities ([#21690](https://github.com/vm0-ai/vm0/issues/21690)) ([419599c](https://github.com/vm0-ai/vm0/commit/419599c7e97dade82464a391a3e00cc9633e1e1d))


### CI

* cap runner behavior tests at two concurrent lanes ([#21695](https://github.com/vm0-ai/vm0/issues/21695)) ([696194b](https://github.com/vm0-ai/vm0/commit/696194bf0e1fbb7a3a639b3d965622e09cd7167c))


### Documentation

* **python:** clarify usage flush semantics ([#21677](https://github.com/vm0-ai/vm0/issues/21677)) ([d16766c](https://github.com/vm0-ai/vm0/commit/d16766caa81e2e8270d51099180de2f8b1885408))

## [0.144.26](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.25...runner-rs-v0.144.26) (2026-07-15)


### Bug Fixes

* **runner:** reject firewall auth redirects ([#21659](https://github.com/vm0-ai/vm0/issues/21659)) ([9f2423b](https://github.com/vm0-ai/vm0/commit/9f2423bf945f14db27555c89494a7c78aa4b3c1f))

## [0.144.25](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.24...runner-rs-v0.144.25) (2026-07-15)


### Documentation

* **mitm-addon:** correct request capture test comment ([#21650](https://github.com/vm0-ai/vm0/issues/21650)) ([b612869](https://github.com/vm0-ai/vm0/commit/b612869daf6b03d15308d16def1e847f15711dd9))

## [0.144.24](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.23...runner-rs-v0.144.24) (2026-07-15)

## [0.144.23](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.22...runner-rs-v0.144.23) (2026-07-15)


### Bug Fixes

* **mitm-addon:** prevent binding after client disconnect ([#21617](https://github.com/vm0-ai/vm0/issues/21617)) ([07e44af](https://github.com/vm0-ai/vm0/commit/07e44af0967872fd1d2f80879f08728d18432853))

## [0.144.22](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.21...runner-rs-v0.144.22) (2026-07-15)

## [0.144.21](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.20...runner-rs-v0.144.21) (2026-07-15)


### Refactoring

* **runner:** split local submit tests by responsibility ([#21592](https://github.com/vm0-ai/vm0/issues/21592)) ([c7e8b5b](https://github.com/vm0-ai/vm0/commit/c7e8b5b2efd739f0c8d6f45ff53ed5c03064a52c))

## [0.144.20](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.19...runner-rs-v0.144.20) (2026-07-15)


### Bug Fixes

* **runner:** enforce firewalls for options asterisk requests ([#21572](https://github.com/vm0-ai/vm0/issues/21572)) ([7c98fe1](https://github.com/vm0-ai/vm0/commit/7c98fe1a675d98366f936c974d36cc9a984f329a))

## [0.144.19](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.18...runner-rs-v0.144.19) (2026-07-15)


### Refactoring

* **runner:** centralize reused workspace promotion resolution ([#21551](https://github.com/vm0-ai/vm0/issues/21551)) ([b3ff245](https://github.com/vm0-ai/vm0/commit/b3ff2454e7f5a8e9a485548cdbec5f86a48c9516))


### Performance Improvements

* **mitm-addon:** avoid quadratic json literal probing ([#21553](https://github.com/vm0-ai/vm0/issues/21553)) ([e54388b](https://github.com/vm0-ai/vm0/commit/e54388b154cc5baa4f2b970ef249411f2e2cbebd))
* **runner:** attribute session history generation claims ([#21550](https://github.com/vm0-ai/vm0/issues/21550)) ([2a2a348](https://github.com/vm0-ai/vm0/commit/2a2a348de2359fe1bae15fd0c03273449565dc51))

## [0.144.18](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.17...runner-rs-v0.144.18) (2026-07-15)


### Documentation

* **mitm-addon:** document metadata visitor invariants ([#21541](https://github.com/vm0-ai/vm0/issues/21541)) ([8a545c2](https://github.com/vm0-ai/vm0/commit/8a545c2bcbf6ec1c9d017a3891e7addcc7d3d683))

## [0.144.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.16...runner-rs-v0.144.17) (2026-07-14)


### Bug Fixes

* **runner:** observe cancellation before process spawn ([#21490](https://github.com/vm0-ai/vm0/issues/21490)) ([8bbabed](https://github.com/vm0-ai/vm0/commit/8bbabed6a5d8631b0bf31b7b125c9c60a8c52ef3))
* **runner:** prevent dnsmasq stalls during namespace churn ([#21373](https://github.com/vm0-ai/vm0/issues/21373)) ([1fd0fea](https://github.com/vm0-ai/vm0/commit/1fd0fea74884c8a644edbf62aaffc6c8ea5da615))


### Refactoring

* **mitm-addon:** extract runner flush lifecycle owner ([#21477](https://github.com/vm0-ai/vm0/issues/21477)) ([2c101ba](https://github.com/vm0-ai/vm0/commit/2c101ba3d08a9443bb401397b5b78aadd3f402c6))
* **runner:** split gc command into focused modules ([#21492](https://github.com/vm0-ai/vm0/issues/21492)) ([4e3317a](https://github.com/vm0-ai/vm0/commit/4e3317a7dd18e6d3f92ee2e88381fa8136af1d3c))

## [0.144.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.15...runner-rs-v0.144.16) (2026-07-14)


### Bug Fixes

* **runner:** make gc summary activity-aware ([#21469](https://github.com/vm0-ai/vm0/issues/21469)) ([8253a09](https://github.com/vm0-ai/vm0/commit/8253a09a7d323611b9938f60b59f534e3e8c6a4c))

## [0.144.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.14...runner-rs-v0.144.15) (2026-07-14)


### Bug Fixes

* **mitm-addon:** preserve original error for invalid utf-8 bodies ([#21441](https://github.com/vm0-ai/vm0/issues/21441)) ([071830a](https://github.com/vm0-ai/vm0/commit/071830ad7eba883ff289fa7d2a92eed0713783f7))
* **mitm-addon:** stop linting after terminal exhaustive matches ([#21460](https://github.com/vm0-ai/vm0/issues/21460)) ([2a369a2](https://github.com/vm0-ai/vm0/commit/2a369a2546a3e671137c1edcba58d2f2c30f6905))
* **runner:** avoid signaling reaped rootfs scripts ([#21476](https://github.com/vm0-ai/vm0/issues/21476)) ([2af0c09](https://github.com/vm0-ai/vm0/commit/2af0c09dc1d5087dd8b7e04b8d02faa85a5254cb))


### Refactoring

* **runner:** test storage cache through production fill path ([#21468](https://github.com/vm0-ai/vm0/issues/21468)) ([50ae892](https://github.com/vm0-ai/vm0/commit/50ae892cbdd9710655b51ecd787688538fd998d5))

## [0.144.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.13...runner-rs-v0.144.14) (2026-07-14)


### Documentation

* **mitm-addon:** document connected endpoint contract ([#21433](https://github.com/vm0-ai/vm0/issues/21433)) ([94fa7ca](https://github.com/vm0-ai/vm0/commit/94fa7ca9ec207abd9af7d77704be583b5b896912))

## [0.144.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.12...runner-rs-v0.144.13) (2026-07-14)


### Performance Improvements

* **runner:** copy guest logs concurrently ([#21421](https://github.com/vm0-ai/vm0/issues/21421)) ([db338e5](https://github.com/vm0-ai/vm0/commit/db338e51748e9728d6d947b5deb6c2e8d77d45b9))

## [0.144.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.11...runner-rs-v0.144.12) (2026-07-14)


### Documentation

* **mitm-addon:** document registry lookup failure semantics ([#21411](https://github.com/vm0-ai/vm0/issues/21411)) ([37f2792](https://github.com/vm0-ai/vm0/commit/37f2792bfac8e24e2e2d3e99931dee68576f1da2))
* **runner:** clarify job budget and parking lifecycle ([#21410](https://github.com/vm0-ai/vm0/issues/21410)) ([24da677](https://github.com/vm0-ai/vm0/commit/24da677b275c88c79c44e533b46ae28bac350621))
* **runner:** document deferred cache fill contract ([#21414](https://github.com/vm0-ai/vm0/issues/21414)) ([e6acc5a](https://github.com/vm0-ai/vm0/commit/e6acc5a4582fcb4a988c463fba39c75f1683e130))
* **runner:** record active-input forwarding invariants ([#21416](https://github.com/vm0-ai/vm0/issues/21416)) ([c99f3fa](https://github.com/vm0-ai/vm0/commit/c99f3fa50743d428c0ebba2f6b95ab0117ccdfb6))


### Performance Improvements

* **runner:** measure session history append lineage ([#21417](https://github.com/vm0-ai/vm0/issues/21417)) ([f653bec](https://github.com/vm0-ai/vm0/commit/f653bec6793e2d3889cc8323e3699502b7eccea1))

## [0.144.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.10...runner-rs-v0.144.11) (2026-07-14)


### Bug Fixes

* **mitm-addon:** preserve with item binding order ([#21331](https://github.com/vm0-ai/vm0/issues/21331)) ([c317751](https://github.com/vm0-ai/vm0/commit/c317751b18f8a5de2279ef2c947251c41d47f10c))
* **runner:** reject conflicting build modes ([#21327](https://github.com/vm0-ai/vm0/issues/21327)) ([1470ec3](https://github.com/vm0-ai/vm0/commit/1470ec3c82a0154787ff159e68c4bf6cfd88d836))


### Documentation

* **mitm-addon:** document anthropic sse extractor lifecycle ([#21402](https://github.com/vm0-ai/vm0/issues/21402)) ([704b14e](https://github.com/vm0-ai/vm0/commit/704b14e8b14386268ede8492a6d6889c1f2ad2fc))

## [0.144.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.9...runner-rs-v0.144.10) (2026-07-14)


### Bug Fixes

* **mitm-addon:** preserve suppressed exception metadata paths ([#21367](https://github.com/vm0-ai/vm0/issues/21367)) ([d349831](https://github.com/vm0-ai/vm0/commit/d349831af7b16ffeab7079e1349f75617e1c9aec))


### Performance Improvements

* **mitm-addon:** stop buffering firewall rule matches ([#21372](https://github.com/vm0-ai/vm0/issues/21372)) ([0f1e1fe](https://github.com/vm0-ai/vm0/commit/0f1e1fe52b218504baa536c650ef927814aea400))
* **python:** index credentialed firewall authorities for tls admission ([#21371](https://github.com/vm0-ai/vm0/issues/21371)) ([7a80716](https://github.com/vm0-ai/vm0/commit/7a8071658178050280487a7d4fb0e0549bf5bada))
* **runner:** attribute history hash transitions ([#21369](https://github.com/vm0-ai/vm0/issues/21369)) ([2da9192](https://github.com/vm0-ai/vm0/commit/2da9192f6100a4c834298bff559ec758905435bd))

## [0.144.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.8...runner-rs-v0.144.9) (2026-07-14)

## [0.144.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.7...runner-rs-v0.144.8) (2026-07-14)


### Performance Improvements

* **runner:** bound network log ready-line drain work ([#21337](https://github.com/vm0-ai/vm0/issues/21337)) ([56f6e5e](https://github.com/vm0-ai/vm0/commit/56f6e5e08587c6a57aeb996e2a0d71ac30970f42))

## [0.144.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.6...runner-rs-v0.144.7) (2026-07-14)

## [0.144.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.5...runner-rs-v0.144.6) (2026-07-14)


### Bug Fixes

* **runner:** drop stale sidecar identity after failed reuse ([#21300](https://github.com/vm0-ai/vm0/issues/21300)) ([4222c87](https://github.com/vm0-ai/vm0/commit/4222c87e65bf12337173acb5eac48b1e3b4b3aef))

## [0.144.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.4...runner-rs-v0.144.5) (2026-07-13)


### Bug Fixes

* **mitm-addon:** preserve auth fetch across cancellation ([#21246](https://github.com/vm0-ai/vm0/issues/21246)) ([6eba99b](https://github.com/vm0-ai/vm0/commit/6eba99be0f63cab5664dee37944c400ab1d7ecbe))
* **mitm-addon:** redact userinfo from malformed log urls ([#21289](https://github.com/vm0-ai/vm0/issues/21289)) ([8dc1850](https://github.com/vm0-ai/vm0/commit/8dc1850853ea87d1044577cd4a6e4268a10253d3))
* **runner:** bound setup artifact resources ([#21240](https://github.com/vm0-ai/vm0/issues/21240)) ([600acc8](https://github.com/vm0-ai/vm0/commit/600acc8fde24aaa2c2770125b33d0232efdb30b1))
* **runner:** recover inconsistent proxy ca state ([#21281](https://github.com/vm0-ai/vm0/issues/21281)) ([03b288d](https://github.com/vm0-ai/vm0/commit/03b288dc2b2badd43d80d6d348750ba4c3250990))
* **sandbox-fc:** route tcp dns through dnsmasq ([#21288](https://github.com/vm0-ai/vm0/issues/21288)) ([a95d872](https://github.com/vm0-ai/vm0/commit/a95d8720fff31fa3be49fabac532eb5543865c82))


### Documentation

* **mitm-addon:** document openai extractor contracts ([#21271](https://github.com/vm0-ai/vm0/issues/21271)) ([98f834e](https://github.com/vm0-ai/vm0/commit/98f834e8cc622e78c63b3538bb05842d7e49b68e))
* **runner:** document private filesystem contract ([#21274](https://github.com/vm0-ai/vm0/issues/21274)) ([10241a1](https://github.com/vm0-ai/vm0/commit/10241a195466eb9e19564aeb7f76fdc4af619ab5))


### Refactoring

* **mitm-addon:** make request classifications valid by construction ([#21283](https://github.com/vm0-ai/vm0/issues/21283)) ([114f961](https://github.com/vm0-ai/vm0/commit/114f961443c24bc00a90e3b355e53221e148b92a))


### Performance Improvements

* **mitm-addon:** avoid eager catalog identity checks ([#21247](https://github.com/vm0-ai/vm0/issues/21247)) ([3f6e0bd](https://github.com/vm0-ai/vm0/commit/3f6e0bddfe467b471e05e91fa2a5bbdabb615076))
* **mitm-addon:** reuse parsed built-in host policies ([#21290](https://github.com/vm0-ai/vm0/issues/21290)) ([1210784](https://github.com/vm0-ai/vm0/commit/1210784d3a49067bcbddc1342ad1ab5c784a412b))

## [0.144.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.3...runner-rs-v0.144.4) (2026-07-13)


### Refactoring

* remove vm0 api url env ([#21215](https://github.com/vm0-ai/vm0/issues/21215)) ([6f0d6a9](https://github.com/vm0-ai/vm0/commit/6f0d6a9bdf80c0437d3ef529fd06eacd62a0c412))

## [0.144.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.2...runner-rs-v0.144.3) (2026-07-13)


### Bug Fixes

* **runner:** verify failed-start service disablement ([#21205](https://github.com/vm0-ai/vm0/issues/21205)) ([a706d21](https://github.com/vm0-ai/vm0/commit/a706d213dde0d9cb2c82942501c94ec82999d538))


### Refactoring

* **runner:** centralize failure log fields ([#21208](https://github.com/vm0-ai/vm0/issues/21208)) ([24e24e8](https://github.com/vm0-ai/vm0/commit/24e24e84afd1a5188b19585161930754bfdfadf8))

## [0.144.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.1...runner-rs-v0.144.2) (2026-07-13)


### Performance Improvements

* **runner:** defer cold cache fill until agent spawn ([#21190](https://github.com/vm0-ai/vm0/issues/21190)) ([e8f3f95](https://github.com/vm0-ai/vm0/commit/e8f3f950f773c0be73efea3ca9e0fff18e2b7c9f))

## [0.144.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.144.0...runner-rs-v0.144.1) (2026-07-13)


### Bug Fixes

* **mitm-addon:** report non-streamable usage responses ([#21172](https://github.com/vm0-ai/vm0/issues/21172)) ([269da9f](https://github.com/vm0-ai/vm0/commit/269da9f4c622e042889e0810ce02699df9c114e8))

## [0.144.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.143.13...runner-rs-v0.144.0) (2026-07-12)


### Features

* **runner:** make session affinity admission-aware ([#21111](https://github.com/vm0-ai/vm0/issues/21111)) ([ecf0021](https://github.com/vm0-ai/vm0/commit/ecf00216864b70cc5cea5fb0c148aa4f14705b90))


### Bug Fixes

* **mitm-addon:** fail closed on ambiguous connector owners ([#21109](https://github.com/vm0-ai/vm0/issues/21109)) ([19bc1ca](https://github.com/vm0-ai/vm0/commit/19bc1ca3694afd1ee0b1814c099d8575e1a08534))
* **mitm-addon:** hand off runner flushes during shutdown ([#21106](https://github.com/vm0-ai/vm0/issues/21106)) ([7eb8820](https://github.com/vm0-ai/vm0/commit/7eb882076a81bfa07ce2954cea02ce2936724d8c))
* **mitm-addon:** preserve invalid bytes at capture boundary ([#21127](https://github.com/vm0-ai/vm0/issues/21127)) ([8e02192](https://github.com/vm0-ai/vm0/commit/8e021929a40ea740241f5b069e95627a13e3f652))
* **runner:** bound doctor api probe concurrency ([#21117](https://github.com/vm0-ai/vm0/issues/21117)) ([522e9f0](https://github.com/vm0-ai/vm0/commit/522e9f01cf0c050b7a77eb76939180ae92468eb0))
* **runner:** reject duplicate atomic usage member keys ([#21125](https://github.com/vm0-ai/vm0/issues/21125)) ([4ed3f54](https://github.com/vm0-ai/vm0/commit/4ed3f54aa3cd07564a95ad4f4894eca08f029b74))


### Documentation

* **runner:** correct mitm_ctx fixture description ([#21131](https://github.com/vm0-ai/vm0/issues/21131)) ([0ab6686](https://github.com/vm0-ai/vm0/commit/0ab66868220741b4f746484671e4bb24fd8cd205))


### Refactoring

* **mitm-addon:** centralize connected endpoint validation ([#21103](https://github.com/vm0-ai/vm0/issues/21103)) ([46a9231](https://github.com/vm0-ai/vm0/commit/46a9231d047f6a258d1f6cf7f37dbe8aa191b199))


### Performance Improvements

* attribute nbd netlink connect latency ([#21121](https://github.com/vm0-ai/vm0/issues/21121)) ([7ff85a6](https://github.com/vm0-ai/vm0/commit/7ff85a6d10e757e24534f5f9a00a1cab1342eb4d))
* **mitm-addon:** aggregate jsonl batch completion ([#21126](https://github.com/vm0-ai/vm0/issues/21126)) ([f9925b4](https://github.com/vm0-ai/vm0/commit/f9925b435d8f1d1f396c9ebfa60cbc50f90cc7dc))
* **mitm-addon:** avoid rescanning responses sse prefixes ([#21104](https://github.com/vm0-ai/vm0/issues/21104)) ([fb9e5a1](https://github.com/vm0-ai/vm0/commit/fb9e5a178b1fde66942360b60fe204053a14976a))

## [0.143.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.143.12...runner-rs-v0.143.13) (2026-07-12)


### Documentation

* **mitm-addon:** document connector diagnostic lifecycle ([#21077](https://github.com/vm0-ai/vm0/issues/21077)) ([0af4542](https://github.com/vm0-ai/vm0/commit/0af4542fea0a12f6133f73e2bf194915a8d8bd7f))
* **mitm-addon:** document flow metadata linter helpers ([#21089](https://github.com/vm0-ai/vm0/issues/21089)) ([f4665a6](https://github.com/vm0-ai/vm0/commit/f4665a64c4bb4e2ec829ac7e9bf59565a1e56547))

## [0.143.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.143.11...runner-rs-v0.143.12) (2026-07-11)


### Bug Fixes

* log denied firewall permission ([#21055](https://github.com/vm0-ai/vm0/issues/21055)) ([4452546](https://github.com/vm0-ai/vm0/commit/445254636ee824f5630d93feb6c2834cfd13f7d7))
* **runner:** enforce guest binary inventory completeness ([#21066](https://github.com/vm0-ai/vm0/issues/21066)) ([32af65b](https://github.com/vm0-ai/vm0/commit/32af65bddde9534477ba49ae0082e5c1fe9e6b90))
* **runner:** preserve proxy registry capacity ([#21073](https://github.com/vm0-ai/vm0/issues/21073)) ([53044a6](https://github.com/vm0-ai/vm0/commit/53044a6ad9d0e1999775186f74e1204bfae347ec))


### Documentation

* **mitm-addon:** document upstream admission contract ([#21063](https://github.com/vm0-ai/vm0/issues/21063)) ([de65ddf](https://github.com/vm0-ai/vm0/commit/de65ddfd79e6d7f610ea25bba5ece1e454a04607))


### Refactoring

* **mitm-addon:** derive metadata key diagnostic path ([#21062](https://github.com/vm0-ai/vm0/issues/21062)) ([c703488](https://github.com/vm0-ai/vm0/commit/c7034882e78c372a3cb15896d6216ad1815bfaed))
* **runner:** remove bundled python firewall catalog ([#21051](https://github.com/vm0-ai/vm0/issues/21051)) ([4ffaeed](https://github.com/vm0-ai/vm0/commit/4ffaeed60806d48bcad8b7b0bbcffdc19ee8bed9))


### Performance Improvements

* **runner:** attribute nbd cow creation latency ([#21065](https://github.com/vm0-ai/vm0/issues/21065)) ([7d97c9a](https://github.com/vm0-ai/vm0/commit/7d97c9a0e83e09645f97675c2594fad08b54bfc7))

## [0.143.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.143.10...runner-rs-v0.143.11) (2026-07-11)


### Bug Fixes

* classify completion failures before retrying ([#21041](https://github.com/vm0-ai/vm0/issues/21041)) ([d28ccb6](https://github.com/vm0-ai/vm0/commit/d28ccb60eafbaa3aac279160c5f8fb2a76fa8e3e)), closes [#21006](https://github.com/vm0-ai/vm0/issues/21006)

## [0.143.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.143.9...runner-rs-v0.143.10) (2026-07-11)


### Refactoring

* **runner:** make execution context a tolerant claim consumer ([#21015](https://github.com/vm0-ai/vm0/issues/21015)) ([d3f39e7](https://github.com/vm0-ai/vm0/commit/d3f39e758f6ae3e1b9a57a1bf9247f6b5e62f917))

## [0.143.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.143.8...runner-rs-v0.143.9) (2026-07-11)

## [0.143.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.143.7...runner-rs-v0.143.8) (2026-07-10)


### Bug Fixes

* reject unsafe firewall base paths ([#20973](https://github.com/vm0-ai/vm0/issues/20973)) ([1e21453](https://github.com/vm0-ai/vm0/commit/1e214530b5e89891da46cb562ac49283f995d7fe))


### Refactoring

* source connector diagnostics from server catalog cache ([#21005](https://github.com/vm0-ai/vm0/issues/21005)) ([84fbf6b](https://github.com/vm0-ai/vm0/commit/84fbf6b84d8d4242e5dae73dc58e33b9f3e2fb51))

## [0.143.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.143.6...runner-rs-v0.143.7) (2026-07-10)


### Refactoring

* enforce fresh auth.base request boundary ([#20970](https://github.com/vm0-ai/vm0/issues/20970)) ([94ba688](https://github.com/vm0-ai/vm0/commit/94ba6881c664bf3804039494f13d00f725169a0c))

## [0.143.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.143.5...runner-rs-v0.143.6) (2026-07-10)

## [0.143.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.143.4...runner-rs-v0.143.5) (2026-07-10)

## [0.143.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.143.3...runner-rs-v0.143.4) (2026-07-10)


### Refactoring

* **runner:** introduce explicit storage plan and guest wire contract ([#20912](https://github.com/vm0-ai/vm0/issues/20912)) ([07f275c](https://github.com/vm0-ai/vm0/commit/07f275c8e04a9dcd6148f7d3075258b683e4ba2e))

## [0.143.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.143.2...runner-rs-v0.143.3) (2026-07-10)


### Bug Fixes

* **runner:** bill openai cache write tokens ([#20874](https://github.com/vm0-ai/vm0/issues/20874)) ([884f74e](https://github.com/vm0-ai/vm0/commit/884f74e0428e2ab46d11f227114824f616c2f985))

## [0.143.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.143.1...runner-rs-v0.143.2) (2026-07-10)


### Refactoring

* remove bundled builtin firewall fallback ([#20820](https://github.com/vm0-ai/vm0/issues/20820)) ([2d1d645](https://github.com/vm0-ai/vm0/commit/2d1d64573699169211736e3a9b91947ebb05d1e3))

## [0.143.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.143.0...runner-rs-v0.143.1) (2026-07-10)


### Bug Fixes

* **runner:** add template rebuild marker comment to force image rebuild ([#20863](https://github.com/vm0-ai/vm0/issues/20863)) ([db1f989](https://github.com/vm0-ai/vm0/commit/db1f989ce2e49469a7bc21456a837070396b31d5))

## [0.143.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.142.0...runner-rs-v0.143.0) (2026-07-09)


### Features

* add nintendo store connector ([#20768](https://github.com/vm0-ai/vm0/issues/20768)) ([a84b0e0](https://github.com/vm0-ai/vm0/commit/a84b0e04ba6382380a6b81331aed372d2abe1149))

## [0.142.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.141.1...runner-rs-v0.142.0) (2026-07-09)


### Features

* **runner:** add service unit-state command ([#20816](https://github.com/vm0-ai/vm0/issues/20816)) ([224fd38](https://github.com/vm0-ai/vm0/commit/224fd387ac0b55913a3247e0cb727ab940d1af74))


### Performance Improvements

* **runner:** reduce direct candidate claim delay ([#20826](https://github.com/vm0-ai/vm0/issues/20826)) ([1991b80](https://github.com/vm0-ai/vm0/commit/1991b80d3ee9f0d6a7ce8f7ae156e5defac912ba))

## [0.141.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.141.0...runner-rs-v0.141.1) (2026-07-09)


### Performance Improvements

* preallocate storage cache body buffers ([#20810](https://github.com/vm0-ai/vm0/issues/20810)) ([1db13a2](https://github.com/vm0-ai/vm0/commit/1db13a209cf54ebb08ad9a5f976e9cc904ad7567))

## [0.141.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.140.2...runner-rs-v0.141.0) (2026-07-09)


### Features

* **runner:** add service stop cleanup policies ([#20769](https://github.com/vm0-ai/vm0/issues/20769)) ([e499917](https://github.com/vm0-ai/vm0/commit/e49991791d96e70bcb909a6b57ccda9669316e99))


### Bug Fixes

* parse runner service cgroups robustly ([#20792](https://github.com/vm0-ai/vm0/issues/20792)) ([53ecb3e](https://github.com/vm0-ai/vm0/commit/53ecb3e6bb7f741df1410d739779e7a1bd338d11))

## [0.140.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.140.1...runner-rs-v0.140.2) (2026-07-09)


### Refactoring

* split runner executor diagnostics ([#20783](https://github.com/vm0-ai/vm0/issues/20783)) ([0d02016](https://github.com/vm0-ai/vm0/commit/0d02016d478208bb35dea0a8602614ab85c18b02))

## [0.140.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.140.0...runner-rs-v0.140.1) (2026-07-09)


### Bug Fixes

* retry transient session history blob downloads ([#20760](https://github.com/vm0-ai/vm0/issues/20760)) ([fd7e2d2](https://github.com/vm0-ai/vm0/commit/fd7e2d2434e77c7b1709c24a5d4005165f7170fa))

## [0.140.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.139.5...runner-rs-v0.140.0) (2026-07-09)


### Features

* gate runner readiness on starting mode ([#20720](https://github.com/vm0-ai/vm0/issues/20720)) ([2d07aec](https://github.com/vm0-ai/vm0/commit/2d07aec8042eeabeff3b316b246b29fbbdba3c99))


### Performance Improvements

* cache session history with workspace images ([#20733](https://github.com/vm0-ai/vm0/issues/20733)) ([d588e5a](https://github.com/vm0-ai/vm0/commit/d588e5a9aa6e67ca18199cd74cadfa7dd4d66418))

## [0.139.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.139.4...runner-rs-v0.139.5) (2026-07-08)


### Bug Fixes

* bound zstd usage validation ([#20708](https://github.com/vm0-ai/vm0/issues/20708)) ([ba4069e](https://github.com/vm0-ai/vm0/commit/ba4069e87f9cc56e1fad5168fe6c9750141d69fc))


### Documentation

* clarify runner active run status schema ([#20686](https://github.com/vm0-ai/vm0/issues/20686)) ([1849808](https://github.com/vm0-ai/vm0/commit/18498089b25834157327be0142ed89637bedc6c0))


### Refactoring

* expose auth cache test hooks ([#20705](https://github.com/vm0-ai/vm0/issues/20705)) ([bfaceb4](https://github.com/vm0-ai/vm0/commit/bfaceb452d465411cceb39fd5beab4db3955dbe3))

## [0.139.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.139.3...runner-rs-v0.139.4) (2026-07-08)


### Documentation

* **runner:** document network policy refresh safety contract ([#20695](https://github.com/vm0-ai/vm0/issues/20695)) ([ac6d18c](https://github.com/vm0-ai/vm0/commit/ac6d18c9b3733f429fa1fe3805100d4bfb752793))


### Refactoring

* **mitm-addon:** extract upstream admission owner ([#20677](https://github.com/vm0-ai/vm0/issues/20677)) ([fedd3e4](https://github.com/vm0-ai/vm0/commit/fedd3e4cd6a13c016658f0d973ceb531c80f6f7d))

## [0.139.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.139.2...runner-rs-v0.139.3) (2026-07-08)

## [0.139.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.139.1...runner-rs-v0.139.2) (2026-07-08)


### Bug Fixes

* add runner api transport diagnostics ([#20648](https://github.com/vm0-ai/vm0/issues/20648)) ([73243b9](https://github.com/vm0-ai/vm0/commit/73243b94d15d23d161b99807c2f4f0cf3374632d))

## [0.139.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.139.0...runner-rs-v0.139.1) (2026-07-08)


### Bug Fixes

* prune stale runner direct candidates ([#20649](https://github.com/vm0-ai/vm0/issues/20649)) ([191387f](https://github.com/vm0-ai/vm0/commit/191387fcdb094faae15cb83c940d463bcf5d580a))

## [0.139.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.138.2...runner-rs-v0.139.0) (2026-07-08)


### Features

* add desktop client request headers ([#20622](https://github.com/vm0-ai/vm0/issues/20622)) ([00a66b8](https://github.com/vm0-ai/vm0/commit/00a66b894644a59f4646c31799a918e6ceafa19a))


### Refactoring

* **mitm-addon:** extract connector diagnostic owner ([#20624](https://github.com/vm0-ai/vm0/issues/20624)) ([96ec313](https://github.com/vm0-ai/vm0/commit/96ec313c48ccba2f838c642b353bbfb1fdb3d5c7))

## [0.138.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.138.1...runner-rs-v0.138.2) (2026-07-08)


### Performance Improvements

* add session history fetch response telemetry ([#20605](https://github.com/vm0-ai/vm0/issues/20605)) ([146fc5b](https://github.com/vm0-ai/vm0/commit/146fc5b39f9697ebb318bf01ca086506e7c0bc66))

## [0.138.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.138.0...runner-rs-v0.138.1) (2026-07-08)


### Bug Fixes

* add builtin firewall fallback telemetry ([#20603](https://github.com/vm0-ai/vm0/issues/20603)) ([8c99cfb](https://github.com/vm0-ai/vm0/commit/8c99cfbe7327e0e50bad252fdf773d7ff7c8f000))


### Refactoring

* **mitm-addon:** extract request classification owner ([#20587](https://github.com/vm0-ai/vm0/issues/20587)) ([a571d98](https://github.com/vm0-ai/vm0/commit/a571d98dd8d4a3a456306fa41edf710f877ec176))

## [0.138.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.137.0...runner-rs-v0.138.0) (2026-07-08)


### Features

* add platform client headers to runner requests ([#20577](https://github.com/vm0-ai/vm0/issues/20577)) ([dee5306](https://github.com/vm0-ai/vm0/commit/dee53066bbc014e302a85aa085136b408e2df833))
* preload runner builtin firewall catalog ([#20535](https://github.com/vm0-ai/vm0/issues/20535)) ([72eec90](https://github.com/vm0-ai/vm0/commit/72eec90baafa5c7600c59184ee3746249154a0dc))


### Bug Fixes

* **mitm-addon:** detach auth base forwards from executor shutdown ([#20529](https://github.com/vm0-ai/vm0/issues/20529)) ([323833a](https://github.com/vm0-ai/vm0/commit/323833af1318279b31062d044cecae21d229bfd3))


### Refactoring

* **mitm-addon:** add flow metadata boundaries ([#20552](https://github.com/vm0-ai/vm0/issues/20552)) ([9787277](https://github.com/vm0-ai/vm0/commit/97872771829f96ec3daf03868d6905b32038d6ee))
* **mitm-addon:** extract local response construction ([#20554](https://github.com/vm0-ai/vm0/issues/20554)) ([9495f55](https://github.com/vm0-ai/vm0/commit/9495f55419face681f2a63c7cb8e9e3bb87e10e6))


### Performance Improvements

* add direct ably claim timing telemetry ([#20579](https://github.com/vm0-ai/vm0/issues/20579)) ([3167db5](https://github.com/vm0-ai/vm0/commit/3167db5f5a44b4c72fd07ebf6b162d2e41b1cad9))

## [0.137.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.136.6...runner-rs-v0.137.0) (2026-07-07)


### Features

* add playstation connector ([#20459](https://github.com/vm0-ai/vm0/issues/20459)) ([588ee8b](https://github.com/vm0-ai/vm0/commit/588ee8b242242277e752c91f64a1b9698b6d3afd))


### Bug Fixes

* **runner:** prevent service drain restarts ([#20496](https://github.com/vm0-ai/vm0/issues/20496)) ([1a250e4](https://github.com/vm0-ai/vm0/commit/1a250e4d8e01157eb14d7fc4b35a6a63e916d43f))


### Refactoring

* accept empty artifact manifests without archive urls ([#20525](https://github.com/vm0-ai/vm0/issues/20525)) ([1ce8bfd](https://github.com/vm0-ai/vm0/commit/1ce8bfd954a2c9c0d963dd0a46e34b31fdceb73f))
* **mitm-addon:** extract tcp logging owner ([#20543](https://github.com/vm0-ai/vm0/issues/20543)) ([deb5fbc](https://github.com/vm0-ai/vm0/commit/deb5fbc86cf29ae4dc0b56cb870858a8090a88a3))
* **mitm-addon:** split flow metadata key linter ([#20545](https://github.com/vm0-ai/vm0/issues/20545)) ([9b51a50](https://github.com/vm0-ai/vm0/commit/9b51a50a180c1e3ac62ab4357e11b9359e863b43))

## [0.136.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.136.5...runner-rs-v0.136.6) (2026-07-07)


### Refactoring

* document mitm hook state ownership ([#20517](https://github.com/vm0-ai/vm0/issues/20517)) ([695971e](https://github.com/vm0-ai/vm0/commit/695971e09a8e4c4e2552e659e4ace4bae7a8ad29))
* **mitm-addon:** extract flow metadata key linter ([#20503](https://github.com/vm0-ai/vm0/issues/20503)) ([0c0e806](https://github.com/vm0-ai/vm0/commit/0c0e80694a4cc010dcac437de735eb27af8c1a0c))


### Performance Improvements

* add session history attribution telemetry ([#20497](https://github.com/vm0-ai/vm0/issues/20497)) ([2daa651](https://github.com/vm0-ai/vm0/commit/2daa6519837d9f2ca3bbc640e2f1d8e8cc135630))

## [0.136.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.136.4...runner-rs-v0.136.5) (2026-07-07)


### Documentation

* **mitm-addon:** document usage buffer flush signals ([#20500](https://github.com/vm0-ai/vm0/issues/20500)) ([1f1c0c3](https://github.com/vm0-ai/vm0/commit/1f1c0c317730654db43e49ed97ab2bbd2640d596))

## [0.136.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.136.3...runner-rs-v0.136.4) (2026-07-07)

## [0.136.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.136.2...runner-rs-v0.136.3) (2026-07-07)

## [0.136.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.136.1...runner-rs-v0.136.2) (2026-07-07)


### Refactoring

* **runner:** split network log manager ownership ([#20454](https://github.com/vm0-ai/vm0/issues/20454)) ([c7a7c0b](https://github.com/vm0-ai/vm0/commit/c7a7c0bac780febd0e2631056d54b3a183b64f24))


### Performance Improvements

* reuse codex zstd session history ([#20450](https://github.com/vm0-ai/vm0/issues/20450)) ([e9b1a48](https://github.com/vm0-ai/vm0/commit/e9b1a48e0e36b8ae75bceab667fd8d6f70fd2ede))

## [0.136.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.136.0...runner-rs-v0.136.1) (2026-07-07)

## [0.136.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.135.0...runner-rs-v0.136.0) (2026-07-06)


### Features

* add steam player connector ([#20359](https://github.com/vm0-ai/vm0/issues/20359)) ([830096d](https://github.com/vm0-ai/vm0/commit/830096d68b93cd490769ed98c0c91090bcde6f31))

## [0.135.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.134.0...runner-rs-v0.135.0) (2026-07-06)


### Features

* allow maskdb connection replacement through firewall ([#20376](https://github.com/vm0-ai/vm0/issues/20376)) ([193489f](https://github.com/vm0-ai/vm0/commit/193489f270fb447c1c114ef0480fb97e13f5f992))


### Bug Fixes

* stabilize codex zero byok polling ([#20381](https://github.com/vm0-ai/vm0/issues/20381)) ([b5cf0b4](https://github.com/vm0-ai/vm0/commit/b5cf0b49a3823ab467bafbe73c475d614730db81))


### Refactoring

* clarify sandbox process pid naming ([#20372](https://github.com/vm0-ai/vm0/issues/20372)) ([c32d846](https://github.com/vm0-ai/vm0/commit/c32d846f655bd32dea0fde2a561a34eb014128dd))


### Performance Improvements

* stage agent instructions before guest download ([#20353](https://github.com/vm0-ai/vm0/issues/20353)) ([14f3236](https://github.com/vm0-ai/vm0/commit/14f32364245d047fb3b77058800513f902deaba2))

## [0.134.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.133.8...runner-rs-v0.134.0) (2026-07-06)


### Features

* support zstd session history blobs ([#20341](https://github.com/vm0-ai/vm0/issues/20341)) ([c4188fa](https://github.com/vm0-ai/vm0/commit/c4188fa5b28587f197998421ac5032c228913c25))

## [0.133.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.133.7...runner-rs-v0.133.8) (2026-07-06)

## [0.133.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.133.6...runner-rs-v0.133.7) (2026-07-06)

## [0.133.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.133.5...runner-rs-v0.133.6) (2026-07-06)

## [0.133.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.133.4...runner-rs-v0.133.5) (2026-07-06)


### Bug Fixes

* snapshot runner service activation config ([#20284](https://github.com/vm0-ai/vm0/issues/20284)) ([2eb26b5](https://github.com/vm0-ai/vm0/commit/2eb26b585fdfbe2e1e6aa71d1a1bba5994016afe))


### Performance Improvements

* **runner:** reduce local queue discovery churn ([#20285](https://github.com/vm0-ai/vm0/issues/20285)) ([6aecc89](https://github.com/vm0-ai/vm0/commit/6aecc8979aa6c20bf57e82a2a3c24c3f7bceb7fa))

## [0.133.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.133.3...runner-rs-v0.133.4) (2026-07-05)

## [0.133.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.133.2...runner-rs-v0.133.3) (2026-07-05)


### Refactoring

* remove runner profile compatibility fields ([#20255](https://github.com/vm0-ai/vm0/issues/20255)) ([7972fa3](https://github.com/vm0-ai/vm0/commit/7972fa3a2aa317e99ba40503b5d6dae35e0d6df8))

## [0.133.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.133.1...runner-rs-v0.133.2) (2026-07-05)


### Performance Improvements

* **runner:** adapt active input idle polling ([#20250](https://github.com/vm0-ai/vm0/issues/20250)) ([bbe0608](https://github.com/vm0-ai/vm0/commit/bbe0608afc5f90d874b5d71eaba1cf431a576952))
* **runner:** avoid sorting local queue discovery ([#20251](https://github.com/vm0-ai/vm0/issues/20251)) ([9eea0de](https://github.com/vm0-ai/vm0/commit/9eea0deca3e4ab64e2b827c76d3c9065959fb2a3))

## [0.133.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.133.0...runner-rs-v0.133.1) (2026-07-05)


### Bug Fixes

* **runner:** guard service activation image artifacts ([#20227](https://github.com/vm0-ai/vm0/issues/20227)) ([90b5196](https://github.com/vm0-ai/vm0/commit/90b519609f54f32970a1342c97d2520b3d03c93e))


### Refactoring

* centralize run payload field validation ([#20225](https://github.com/vm0-ai/vm0/issues/20225)) ([8a293a7](https://github.com/vm0-ai/vm0/commit/8a293a762a48b4828780e8e99ca59e48ca915415))
* **runner:** centralize workspace cache gc traversal ([#20226](https://github.com/vm0-ai/vm0/issues/20226)) ([23d52a6](https://github.com/vm0-ai/vm0/commit/23d52a65d63e3c10463fc2d9cfbe63e7c9144a50))

## [0.133.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.132.14...runner-rs-v0.133.0) (2026-07-05)


### Features

* refresh active connector permission policies ([#20035](https://github.com/vm0-ai/vm0/issues/20035)) ([8d7cec2](https://github.com/vm0-ai/vm0/commit/8d7cec2537cd512d12bd3e550abc43c07cb2026a))


### Bug Fixes

* **runner:** protect retained config image refs during gc ([#20172](https://github.com/vm0-ai/vm0/issues/20172)) ([07e35c2](https://github.com/vm0-ai/vm0/commit/07e35c23262ca656ad5390fca9535a95a514ecb1))


### Performance Improvements

* add storage miss attribution telemetry ([#20200](https://github.com/vm0-ai/vm0/issues/20200)) ([606892b](https://github.com/vm0-ai/vm0/commit/606892bc50a64df8e93208e5946a9aecd373c26a))

## [0.132.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.132.13...runner-rs-v0.132.14) (2026-07-05)


### Refactoring

* clarify runner profile availability contract ([#20171](https://github.com/vm0-ai/vm0/issues/20171)) ([ef94c04](https://github.com/vm0-ai/vm0/commit/ef94c04b34a0eacb9a3ddc7ffd1cabc419c19113))

## [0.132.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.132.12...runner-rs-v0.132.13) (2026-07-04)


### Bug Fixes

* **mitm-addon:** suppress ambiguous shared-base diagnostics ([#20169](https://github.com/vm0-ai/vm0/issues/20169)) ([ff9177d](https://github.com/vm0-ai/vm0/commit/ff9177d0abf6896ad49ba871f7287c8139a26e50))

## [0.132.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.132.11...runner-rs-v0.132.12) (2026-07-04)


### Performance Improvements

* **runner:** avoid preflight guest payload materialization ([#20165](https://github.com/vm0-ai/vm0/issues/20165)) ([6094b05](https://github.com/vm0-ai/vm0/commit/6094b0566638303a687fdc7c178eef50841d3610))

## [0.132.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.132.10...runner-rs-v0.132.11) (2026-07-04)


### Performance Improvements

* add guarded storage cache miss passthrough ([#20094](https://github.com/vm0-ai/vm0/issues/20094)) ([7d14271](https://github.com/vm0-ai/vm0/commit/7d14271aa51f9d47ead4e2ac4f289ca326cbea20))

## [0.132.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.132.9...runner-rs-v0.132.10) (2026-07-03)


### Bug Fixes

* validate runner config image artifacts under locks ([#20095](https://github.com/vm0-ai/vm0/issues/20095)) ([3d2adce](https://github.com/vm0-ai/vm0/commit/3d2adce2dcf933ad4c4fd7deb1e4f45a857cf61f))

## [0.132.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.132.8...runner-rs-v0.132.9) (2026-07-03)


### Refactoring

* share runner status file reader ([#20096](https://github.com/vm0-ai/vm0/issues/20096)) ([df6d7d6](https://github.com/vm0-ai/vm0/commit/df6d7d62c1dfbd3a6ff5fe11179f25f47b1006b2))

## [0.132.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.132.7...runner-rs-v0.132.8) (2026-07-03)


### Refactoring

* centralize firewall base url malformed checks ([#20090](https://github.com/vm0-ai/vm0/issues/20090)) ([2aab7f4](https://github.com/vm0-ai/vm0/commit/2aab7f43daf38d0a86a2a8bcff99f12e18cb873a))
* **runner:** centralize job candidate defaults ([#20092](https://github.com/vm0-ai/vm0/issues/20092)) ([bfa917c](https://github.com/vm0-ai/vm0/commit/bfa917c064ca5599ebd35ee78264b665a66a0e27))

## [0.132.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.132.6...runner-rs-v0.132.7) (2026-07-03)


### Bug Fixes

* allow maskdb aggregate queries through firewall ([#20083](https://github.com/vm0-ai/vm0/issues/20083)) ([18ab86f](https://github.com/vm0-ai/vm0/commit/18ab86f8e78ada958f1a2f94cbc940dc51227212))

## [0.132.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.132.5...runner-rs-v0.132.6) (2026-07-03)


### Documentation

* clarify auth base forwarder test helpers ([#20052](https://github.com/vm0-ai/vm0/issues/20052)) ([1d48da3](https://github.com/vm0-ai/vm0/commit/1d48da3d204818fd11d4f23ba60c0dd960cd5bc9))

## [0.132.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.132.4...runner-rs-v0.132.5) (2026-07-03)


### Bug Fixes

* diagnose shared-base connector ownership before auth ([#19964](https://github.com/vm0-ai/vm0/issues/19964)) ([d87b6ea](https://github.com/vm0-ai/vm0/commit/d87b6ea41b76b65960f0c9949d1e03bd85d9a1bb))

## [0.132.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.132.3...runner-rs-v0.132.4) (2026-07-03)


### Bug Fixes

* move runner bootstrap payloads out of env ([#19989](https://github.com/vm0-ai/vm0/issues/19989)) ([847d8d2](https://github.com/vm0-ai/vm0/commit/847d8d24372d84568133007db87c44a0ebd72b95))

## [0.132.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.132.2...runner-rs-v0.132.3) (2026-07-03)

## [0.132.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.132.1...runner-rs-v0.132.2) (2026-07-03)


### Bug Fixes

* coalesce runner direct candidate bursts ([#19969](https://github.com/vm0-ai/vm0/issues/19969)) ([1135a51](https://github.com/vm0-ai/vm0/commit/1135a514c5e5ca21bb0b929885e98e9061fe581b))


### Performance Improvements

* **mitm-addon:** negotiate safe response encodings ([#19951](https://github.com/vm0-ai/vm0/issues/19951)) ([c80fdba](https://github.com/vm0-ai/vm0/commit/c80fdbabe57e88312280782a180710b2b4eb333e))

## [0.132.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.132.0...runner-rs-v0.132.1) (2026-07-03)


### Performance Improvements

* add session history telemetry buckets ([#19953](https://github.com/vm0-ai/vm0/issues/19953)) ([27309a2](https://github.com/vm0-ai/vm0/commit/27309a250f9374e3e8a1d46fa4476d57b248522d))

## [0.132.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.20...runner-rs-v0.132.0) (2026-07-03)


### Features

* add Google Meet transcript-generated workflow trigger ([#19789](https://github.com/vm0-ai/vm0/issues/19789)) ([91aef71](https://github.com/vm0-ai/vm0/commit/91aef711953cb2107c62ae7d2d3a7f9da38a071f))

## [0.131.20](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.19...runner-rs-v0.131.20) (2026-07-02)


### Bug Fixes

* prioritize direct workspace holder cleanup ([#19881](https://github.com/vm0-ai/vm0/issues/19881)) ([a381f6c](https://github.com/vm0-ai/vm0/commit/a381f6c787f395339ca9d6abdb9f655182cb2713))


### Performance Improvements

* split fresh sandbox preparation telemetry ([#19898](https://github.com/vm0-ai/vm0/issues/19898)) ([c55b78d](https://github.com/vm0-ai/vm0/commit/c55b78dceeb2c7671fb8f30906f0ab9f9010a442))

## [0.131.19](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.18...runner-rs-v0.131.19) (2026-07-02)

## [0.131.18](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.17...runner-rs-v0.131.18) (2026-07-02)


### Bug Fixes

* protect same-session runner affinity claims ([#19764](https://github.com/vm0-ai/vm0/issues/19764)) ([5bbd286](https://github.com/vm0-ai/vm0/commit/5bbd2862e2eceb51a71ba681a24d64b87894d712))

## [0.131.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.16...runner-rs-v0.131.17) (2026-07-02)

## [0.131.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.15...runner-rs-v0.131.16) (2026-07-02)


### Refactoring

* **mitm-addon:** separate body decode policies ([#19818](https://github.com/vm0-ai/vm0/issues/19818)) ([2cceb77](https://github.com/vm0-ai/vm0/commit/2cceb77c50ae250bdce23e6ff652d51a43789ea5))


### Performance Improvements

* **mitm-addon:** adapt zstd stream input chunks ([#19856](https://github.com/vm0-ai/vm0/issues/19856)) ([7be6db8](https://github.com/vm0-ai/vm0/commit/7be6db8324af2bae96ac78c10d73317a59271edb))

## [0.131.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.14...runner-rs-v0.131.15) (2026-07-02)


### Refactoring

* **mitm-addon:** factor sigv4 firewall auth tests ([#19822](https://github.com/vm0-ai/vm0/issues/19822)) ([ff28409](https://github.com/vm0-ai/vm0/commit/ff28409deb61751273b5a6f207234d159ddc8519))


### Performance Improvements

* add session history encoding telemetry ([#19812](https://github.com/vm0-ai/vm0/issues/19812)) ([7c0814a](https://github.com/vm0-ai/vm0/commit/7c0814af703af9ad89cd34dc0fd131db0916fec7))

## [0.131.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.13...runner-rs-v0.131.14) (2026-07-02)


### Refactoring

* **mitm-addon:** separate body decode policies ([#19783](https://github.com/vm0-ai/vm0/issues/19783)) ([ba4480a](https://github.com/vm0-ai/vm0/commit/ba4480aa0483bcfde78c9b7dc74cafe8353e48a9))

## [0.131.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.12...runner-rs-v0.131.13) (2026-07-02)


### Bug Fixes

* expose runner session ids in diagnostics ([#19755](https://github.com/vm0-ai/vm0/issues/19755)) ([e4c62e1](https://github.com/vm0-ai/vm0/commit/e4c62e17ed7de8743f89dacf9edc62f7042307d6))


### Refactoring

* **runner:** simplify proxy registry test setup ([#19784](https://github.com/vm0-ai/vm0/issues/19784)) ([e2a77fc](https://github.com/vm0-ai/vm0/commit/e2a77fcfa15a819deaed1d4e9b6dd1f8313ff559))


### Performance Improvements

* add compressed resume session history transport ([#19667](https://github.com/vm0-ai/vm0/issues/19667)) ([ee23c32](https://github.com/vm0-ai/vm0/commit/ee23c326ccf794228d2c4f9dd6d8844cd032fc49))

## [0.131.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.11...runner-rs-v0.131.12) (2026-07-02)

## [0.131.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.10...runner-rs-v0.131.11) (2026-07-01)

## [0.131.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.9...runner-rs-v0.131.10) (2026-07-01)


### Bug Fixes

* retry transient runner storage cache fetches ([#19674](https://github.com/vm0-ai/vm0/issues/19674)) ([315adfb](https://github.com/vm0-ai/vm0/commit/315adfb04fac9a2dce50d75dab5438f47e6de3b8))
* sanitize runner api urls in webhook logs ([#19681](https://github.com/vm0-ai/vm0/issues/19681)) ([85c95f8](https://github.com/vm0-ai/vm0/commit/85c95f8d66ecdd6253b84c0c60ea1ff19cc584b0))

## [0.131.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.8...runner-rs-v0.131.9) (2026-07-01)


### Bug Fixes

* apply sandbox io limiters from host capacity ([#19668](https://github.com/vm0-ai/vm0/issues/19668)) ([8baa893](https://github.com/vm0-ai/vm0/commit/8baa893dbbae076adbde5e31f467103a0c06179e))
* surface usage pending counter underflows ([#19654](https://github.com/vm0-ai/vm0/issues/19654)) ([9ca1bc4](https://github.com/vm0-ai/vm0/commit/9ca1bc435a820df109ccc85441dada51a5eb42e8))


### Performance Improvements

* reduce artifact storage manifest presigning ([#19650](https://github.com/vm0-ai/vm0/issues/19650)) ([0672271](https://github.com/vm0-ai/vm0/commit/0672271c090e1a5431ac762c566328125958a218))

## [0.131.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.7...runner-rs-v0.131.8) (2026-07-01)

## [0.131.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.6...runner-rs-v0.131.7) (2026-07-01)


### Bug Fixes

* classify codex context window failures ([#19607](https://github.com/vm0-ai/vm0/issues/19607)) ([34ed0ac](https://github.com/vm0-ai/vm0/commit/34ed0ac9d29d81ffda52c5ccd6bf69915d5cc80c))


### Refactoring

* strip firewall runtime permission descriptions ([#19584](https://github.com/vm0-ai/vm0/issues/19584)) ([7ea1dcb](https://github.com/vm0-ai/vm0/commit/7ea1dcb93739a189d4acbecb6f36428d0a6a5006))


### Performance Improvements

* **runner:** attribute session history fallback ([#19588](https://github.com/vm0-ai/vm0/issues/19588)) ([7d94c23](https://github.com/vm0-ai/vm0/commit/7d94c238d862f8650112490928097380ed3089b1))

## [0.131.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.5...runner-rs-v0.131.6) (2026-07-01)


### Refactoring

* centralize usage reporting context ([#19555](https://github.com/vm0-ai/vm0/issues/19555)) ([4aee069](https://github.com/vm0-ai/vm0/commit/4aee069753fa9e57129ac2e1250e7a60c4cf3013))

## [0.131.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.4...runner-rs-v0.131.5) (2026-07-01)


### Refactoring

* generate resume history limit for rust ([#19512](https://github.com/vm0-ai/vm0/issues/19512)) ([152a190](https://github.com/vm0-ai/vm0/commit/152a1908da298b0892bac4749b92ee0ea1ad48d0))


### Performance Improvements

* add storage cache populate attribution telemetry ([#19532](https://github.com/vm0-ai/vm0/issues/19532)) ([d256484](https://github.com/vm0-ai/vm0/commit/d256484e3828f81d9b26ff9d5fbcade38d24b361))

## [0.131.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.3...runner-rs-v0.131.4) (2026-06-30)

## [0.131.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.2...runner-rs-v0.131.3) (2026-06-30)

## [0.131.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.1...runner-rs-v0.131.2) (2026-06-30)


### Performance Improvements

* split runner storage manifest telemetry ([#19518](https://github.com/vm0-ai/vm0/issues/19518)) ([cd0cc9e](https://github.com/vm0-ai/vm0/commit/cd0cc9ec1b11239b294c9b569f61fa20115c3a0b))

## [0.131.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.131.0...runner-rs-v0.131.1) (2026-06-30)

## [0.131.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.130.14...runner-rs-v0.131.0) (2026-06-30)


### Features

* enable codex local active input ([#19463](https://github.com/vm0-ai/vm0/issues/19463)) ([5a34420](https://github.com/vm0-ai/vm0/commit/5a34420314311d9a290c195f33539d8359303660))


### Documentation

* **runner:** document session history materializer contract ([#19493](https://github.com/vm0-ai/vm0/issues/19493)) ([dac914a](https://github.com/vm0-ai/vm0/commit/dac914ab5ceb017e38addc3c065f82f12d28ee2e))

## [0.130.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.130.13...runner-rs-v0.130.14) (2026-06-30)


### Documentation

* document runner snapshot publish contract ([#19477](https://github.com/vm0-ai/vm0/issues/19477)) ([7412194](https://github.com/vm0-ai/vm0/commit/74121940890576935986994d6691efbc82d8e68f))

## [0.130.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.130.12...runner-rs-v0.130.13) (2026-06-30)


### Documentation

* document Ably supervisor discovery contract ([#19433](https://github.com/vm0-ai/vm0/issues/19433)) ([83f686e](https://github.com/vm0-ai/vm0/commit/83f686e8a32de4dd4edd7dcf416421b78756ffca))

## [0.130.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.130.11...runner-rs-v0.130.12) (2026-06-30)


### Bug Fixes

* add youtube batch stats firewall route ([#19436](https://github.com/vm0-ai/vm0/issues/19436)) ([65f41cc](https://github.com/vm0-ai/vm0/commit/65f41cc4df675880b47f99e65e6d946add16708a))


### Performance Improvements

* avoid quadratic mitm firewall prefix lookup ([#19435](https://github.com/vm0-ai/vm0/issues/19435)) ([432c902](https://github.com/vm0-ai/vm0/commit/432c902ede6c4ac8d1072a1c40489fbc46e86d97))

## [0.130.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.130.10...runner-rs-v0.130.11) (2026-06-30)

## [0.130.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.130.9...runner-rs-v0.130.10) (2026-06-30)


### Bug Fixes

* enforce runtime builtin host policies ([#19385](https://github.com/vm0-ai/vm0/issues/19385)) ([89c05a9](https://github.com/vm0-ai/vm0/commit/89c05a908553736cb903a7fb4ad7fa8697acf1a8))

## [0.130.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.130.8...runner-rs-v0.130.9) (2026-06-30)

## [0.130.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.130.7...runner-rs-v0.130.8) (2026-06-29)


### Bug Fixes

* **cli:** make permission-deny base-aware ([#19330](https://github.com/vm0-ai/vm0/issues/19330)) ([3e2c7f6](https://github.com/vm0-ai/vm0/commit/3e2c7f64f81518f36df41d81521201dc8bff51ff))

## [0.130.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.130.6...runner-rs-v0.130.7) (2026-06-29)


### Performance Improvements

* **runner:** add session history identity reason telemetry ([#19352](https://github.com/vm0-ai/vm0/issues/19352)) ([4a29190](https://github.com/vm0-ai/vm0/commit/4a29190916173ad04bd9613c717dfb8947a2289b))

## [0.130.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.130.5...runner-rs-v0.130.6) (2026-06-29)

## [0.130.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.130.4...runner-rs-v0.130.5) (2026-06-29)


### Refactoring

* **mitm-addon:** split registry firewall resolution ([#19316](https://github.com/vm0-ai/vm0/issues/19316)) ([3239f0c](https://github.com/vm0-ai/vm0/commit/3239f0cf87250934fdf8988aa760a1a5ec9fa58d))

## [0.130.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.130.3...runner-rs-v0.130.4) (2026-06-29)


### Bug Fixes

* cover youtube upload media put firewall routes ([#19325](https://github.com/vm0-ai/vm0/issues/19325)) ([a5e6829](https://github.com/vm0-ai/vm0/commit/a5e6829848c743e9be7698d71c640fddcb680f27))
* **runner:** verify sandbox runtime commands in rootfs ([#19295](https://github.com/vm0-ai/vm0/issues/19295)) ([6724b4f](https://github.com/vm0-ai/vm0/commit/6724b4feb90c14a992a1c430200fec6e39f8c021))


### Refactoring

* merge agent diagnostics into guest contracts ([#19317](https://github.com/vm0-ai/vm0/issues/19317)) ([e36a711](https://github.com/vm0-ai/vm0/commit/e36a71168939a1b692a1ab80005d984697a77fe4))


### Performance Improvements

* **mitm-addon:** offload server_connect dns lookups ([#19313](https://github.com/vm0-ai/vm0/issues/19313)) ([3c6d3bd](https://github.com/vm0-ai/vm0/commit/3c6d3bdf73514fc35525f5f58100bb7fb71361d8))

## [0.130.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.130.2...runner-rs-v0.130.3) (2026-06-29)

## [0.130.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.130.1...runner-rs-v0.130.2) (2026-06-29)


### Performance Improvements

* park checkpointed session history identity ([#19270](https://github.com/vm0-ai/vm0/issues/19270)) ([e21745b](https://github.com/vm0-ai/vm0/commit/e21745be11c34b09052a27182971d4c48ab881c1))

## [0.130.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.130.0...runner-rs-v0.130.1) (2026-06-29)


### Bug Fixes

* bind mitm credential upstream destinations ([#19195](https://github.com/vm0-ai/vm0/issues/19195)) ([63cd505](https://github.com/vm0-ai/vm0/commit/63cd505775d743b23c839617d51455e8d38f61e9))
* bound codex session cleanup traversal ([#19265](https://github.com/vm0-ai/vm0/issues/19265)) ([0ad8dd7](https://github.com/vm0-ai/vm0/commit/0ad8dd7cc4a2ba0e4d1f0e3732b7cc2596b5b38f))


### Documentation

* document fake auth endpoint helper contract ([#19274](https://github.com/vm0-ai/vm0/issues/19274)) ([07e4d7e](https://github.com/vm0-ai/vm0/commit/07e4d7ef4ec0436814a053be9f6988eac91e4df0))


### Refactoring

* split local provider tests ([#19264](https://github.com/vm0-ai/vm0/issues/19264)) ([9b57df8](https://github.com/vm0-ai/vm0/commit/9b57df8026dcebdb8fa7823a7e0af87fb12c6786))

## [0.130.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.42...runner-rs-v0.130.0) (2026-06-29)


### Features

* add Data Manager scope to Google Ads connector ([#19266](https://github.com/vm0-ai/vm0/issues/19266)) ([68eac5f](https://github.com/vm0-ai/vm0/commit/68eac5fad5a50253641f97db301b120908bc35f8))


### Documentation

* clarify runner image hash identity ([#19262](https://github.com/vm0-ai/vm0/issues/19262)) ([442c1ad](https://github.com/vm0-ai/vm0/commit/442c1adb06a39617a7ce9bff85ed7b35135e9b7c))

## [0.129.42](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.41...runner-rs-v0.129.42) (2026-06-28)


### Performance Improvements

* add session history identity telemetry ([#19236](https://github.com/vm0-ai/vm0/issues/19236)) ([0963504](https://github.com/vm0-ai/vm0/commit/0963504370133cc323f1bf97af5a8b027f8f0423))

## [0.129.41](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.40...runner-rs-v0.129.41) (2026-06-27)


### Performance Improvements

* rename runner storage manifest metric ([#19205](https://github.com/vm0-ai/vm0/issues/19205)) ([8523b1e](https://github.com/vm0-ai/vm0/commit/8523b1eb13186a5b2513028c15447f9d2ed78619))

## [0.129.40](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.39...runner-rs-v0.129.40) (2026-06-27)


### Performance Improvements

* skip verified idle resume restore ([#19187](https://github.com/vm0-ai/vm0/issues/19187)) ([e59143c](https://github.com/vm0-ai/vm0/commit/e59143c3105988cb2416aa2853b3581d839334e1))

## [0.129.39](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.38...runner-rs-v0.129.39) (2026-06-27)


### Bug Fixes

* map Cloudflare permissions-required operations ([#19192](https://github.com/vm0-ai/vm0/issues/19192)) ([747d1a4](https://github.com/vm0-ai/vm0/commit/747d1a4b503eb7e85439f35721cd80ef96dc00c8))
* **mitm-addon:** use monotonic force-refresh cooldown ([#19193](https://github.com/vm0-ai/vm0/issues/19193)) ([ca151bf](https://github.com/vm0-ai/vm0/commit/ca151bf51899ef58843c8849afe2656b83f30281))
* stream connector diagnostic response fallback ([#19183](https://github.com/vm0-ai/vm0/issues/19183)) ([988375f](https://github.com/vm0-ai/vm0/commit/988375fa8823aeb870ae478c9aac7ce253bab8c8))

## [0.129.38](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.37...runner-rs-v0.129.38) (2026-06-27)


### Bug Fixes

* preserve Cloudflare upload authorization ([#19175](https://github.com/vm0-ai/vm0/issues/19175)) ([f2b2dd0](https://github.com/vm0-ai/vm0/commit/f2b2dd09d70093a1d14bf5cc38da2a87a2638373))
* **runner:** avoid host archive validation in storage cache ([#19182](https://github.com/vm0-ai/vm0/issues/19182)) ([058fbf7](https://github.com/vm0-ai/vm0/commit/058fbf726513d176a3be9aafee25bad900fdf206))


### Performance Improvements

* split runner claim timing spans ([#19174](https://github.com/vm0-ai/vm0/issues/19174)) ([3d21101](https://github.com/vm0-ai/vm0/commit/3d211010ead27c689566da699414708f3a8c9fcc))

## [0.129.37](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.36...runner-rs-v0.129.37) (2026-06-27)


### Refactoring

* split runner service command module ([#19165](https://github.com/vm0-ai/vm0/issues/19165)) ([8c97aa6](https://github.com/vm0-ai/vm0/commit/8c97aa6ed38079621776473634bda7177a0524e7))

## [0.129.36](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.35...runner-rs-v0.129.36) (2026-06-27)


### Bug Fixes

* add ScrapeNinja RapidAPI host header ([#19138](https://github.com/vm0-ai/vm0/issues/19138)) ([5bd367c](https://github.com/vm0-ai/vm0/commit/5bd367cff031a467dcb15cd01aa00636add12c12))
* restrict credentialed dynamic firewall hosts ([#19137](https://github.com/vm0-ai/vm0/issues/19137)) ([9801134](https://github.com/vm0-ai/vm0/commit/9801134aede293f0fd3c1f11c386bf4483fff78d))
* **runner:** key firewall auth cache by identity ([#19144](https://github.com/vm0-ai/vm0/issues/19144)) ([ab773e8](https://github.com/vm0-ai/vm0/commit/ab773e88aa376274683895228ea53b3ab67fb1a1))


### Performance Improvements

* add storage cache staging telemetry ([#19149](https://github.com/vm0-ai/vm0/issues/19149)) ([69bc147](https://github.com/vm0-ai/vm0/commit/69bc14720fbe3612222313798e9ae06b9972d5c7))

## [0.129.35](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.34...runner-rs-v0.129.35) (2026-06-26)


### Bug Fixes

* **runner:** disable inactive units during service drain ([#19140](https://github.com/vm0-ai/vm0/issues/19140)) ([e5a3376](https://github.com/vm0-ai/vm0/commit/e5a33768c6271ba38b65446a6d3cd8296ea4986d))
* saturate telemetry duration milliseconds ([#19139](https://github.com/vm0-ai/vm0/issues/19139)) ([4db715c](https://github.com/vm0-ai/vm0/commit/4db715c9ed4a6469519e84bb83ff1b33917f1162))


### Refactoring

* centralize auth base admission ownership ([#19143](https://github.com/vm0-ai/vm0/issues/19143)) ([bd2b026](https://github.com/vm0-ai/vm0/commit/bd2b02634bd74ecebd128b6c32c433ba6bd8c9b8))


### Performance Improvements

* start resume history downloads earlier ([#19128](https://github.com/vm0-ai/vm0/issues/19128)) ([653e788](https://github.com/vm0-ai/vm0/commit/653e788c4490f6726155ea2bfe8035b8e287415b))

## [0.129.34](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.33...runner-rs-v0.129.34) (2026-06-26)


### Refactoring

* **mitm-addon:** clarify body limit semantics ([#19125](https://github.com/vm0-ai/vm0/issues/19125)) ([4539b49](https://github.com/vm0-ai/vm0/commit/4539b4936a64197009c7b78224afbaedd5d1a285))

## [0.129.33](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.32...runner-rs-v0.129.33) (2026-06-26)

## [0.129.32](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.31...runner-rs-v0.129.32) (2026-06-26)


### Documentation

* add axiom firewall permission descriptions ([#19074](https://github.com/vm0-ai/vm0/issues/19074)) ([31667a3](https://github.com/vm0-ai/vm0/commit/31667a3496c6e703b2ff1ed920f449cf7c642cbb))
* document proxy log sanitization contract ([#19093](https://github.com/vm0-ai/vm0/issues/19093)) ([e17446b](https://github.com/vm0-ai/vm0/commit/e17446b04a024ca9a599505427351a37da5a22bc))
* explain workspace mount lifecycle ([#19094](https://github.com/vm0-ai/vm0/issues/19094)) ([e77e898](https://github.com/vm0-ai/vm0/commit/e77e8987611c9268346be56ad777a560ffb92497))

## [0.129.31](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.30...runner-rs-v0.129.31) (2026-06-26)

## [0.129.30](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.29...runner-rs-v0.129.30) (2026-06-26)


### Bug Fixes

* correct dropbox custom quota permission ([#19070](https://github.com/vm0-ai/vm0/issues/19070)) ([140f635](https://github.com/vm0-ai/vm0/commit/140f63556682d8e93aeadae3ab3bf24d087053fa))

## [0.129.29](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.28...runner-rs-v0.129.29) (2026-06-26)


### Bug Fixes

* add agent exit 126 diagnostics ([#19032](https://github.com/vm0-ai/vm0/issues/19032)) ([b894039](https://github.com/vm0-ai/vm0/commit/b894039c617722da0ab4a9dd1fa2f188e552c7c7))


### Performance Improvements

* move resume history download to runner ([#19025](https://github.com/vm0-ai/vm0/issues/19025)) ([7296964](https://github.com/vm0-ai/vm0/commit/729696498963ef377697681f49c597fc28180e02))

## [0.129.28](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.27...runner-rs-v0.129.28) (2026-06-26)


### Bug Fixes

* **mitm-addon:** bound jsonl shutdown control waits ([#19024](https://github.com/vm0-ai/vm0/issues/19024)) ([6c862d1](https://github.com/vm0-ai/vm0/commit/6c862d1a45c947d5f757a523154b851f7fb7c822))
* **runner:** treat duplicate drain signals as idempotent ([#19026](https://github.com/vm0-ai/vm0/issues/19026)) ([270f616](https://github.com/vm0-ai/vm0/commit/270f616112016f75870050f0d879db1a5746286c))
* silence jsonl writes after shutdown ([#19029](https://github.com/vm0-ai/vm0/issues/19029)) ([ed601d9](https://github.com/vm0-ai/vm0/commit/ed601d9b38183ac60fbf226d10852ce6610d7799))


### Performance Improvements

* **runner:** restore ably direct candidates ([#19028](https://github.com/vm0-ai/vm0/issues/19028)) ([b148317](https://github.com/vm0-ai/vm0/commit/b1483176ef8f1cb5b29347a4b13e4effb6fce1b9))

## [0.129.27](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.26...runner-rs-v0.129.27) (2026-06-26)

## [0.129.26](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.25...runner-rs-v0.129.26) (2026-06-26)


### Performance Improvements

* **runner:** add pre-spawn phase timing ([#19001](https://github.com/vm0-ai/vm0/issues/19001)) ([73cd372](https://github.com/vm0-ai/vm0/commit/73cd372420e29f7d261377760896361bb93728d4))

## [0.129.25](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.24...runner-rs-v0.129.25) (2026-06-25)


### Performance Improvements

* **mitm-addon:** short-circuit connector diagnostics ([#18937](https://github.com/vm0-ai/vm0/issues/18937)) ([a6e1bea](https://github.com/vm0-ai/vm0/commit/a6e1beac6319fde73c5e7b4eed6803b87feb02cd))

## [0.129.24](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.23...runner-rs-v0.129.24) (2026-06-25)


### Performance Improvements

* bound auth base forwarding admission ([#18954](https://github.com/vm0-ai/vm0/issues/18954)) ([e4a7a0e](https://github.com/vm0-ai/vm0/commit/e4a7a0eabb581a16d92b6080d369a4f8d3980b76))

## [0.129.23](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.22...runner-rs-v0.129.23) (2026-06-25)


### Bug Fixes

* use figma api token header in builtin firewall ([#18953](https://github.com/vm0-ai/vm0/issues/18953)) ([81dad4e](https://github.com/vm0-ai/vm0/commit/81dad4e7685ae21c7f6a3df863934adb6d44207c))


### Documentation

* **mitm-addon:** update billable connector guidance ([#18948](https://github.com/vm0-ai/vm0/issues/18948)) ([b8d6f52](https://github.com/vm0-ai/vm0/commit/b8d6f52331901865812f7cf24d3a7d6325bfffd1))


### Performance Improvements

* bound firewalled request body capture ([#18939](https://github.com/vm0-ai/vm0/issues/18939)) ([1381816](https://github.com/vm0-ai/vm0/commit/1381816cefb707179d1a2fef0ed7024b5db4942b))
* **runner:** batch local cancel job lookup ([#18949](https://github.com/vm0-ai/vm0/issues/18949)) ([9575105](https://github.com/vm0-ai/vm0/commit/9575105c0cdb84681efa4630a30445051389e623))

## [0.129.22](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.21...runner-rs-v0.129.22) (2026-06-25)


### Performance Improvements

* add runner queue-to-claim timing ([#18940](https://github.com/vm0-ai/vm0/issues/18940)) ([ae6564c](https://github.com/vm0-ai/vm0/commit/ae6564cd58f595ec239d6f1c1f4155911ded8655))

## [0.129.21](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.20...runner-rs-v0.129.21) (2026-06-25)


### Bug Fixes

* classify claude stream idle timeout failures ([#18941](https://github.com/vm0-ai/vm0/issues/18941)) ([2f30e00](https://github.com/vm0-ai/vm0/commit/2f30e005ce1d4d85d55674c7f384d51c701fb0bf))


### Refactoring

* move firewall registry to generator manifest ([#18930](https://github.com/vm0-ai/vm0/issues/18930)) ([2e4271b](https://github.com/vm0-ai/vm0/commit/2e4271b120828ac2ed0137e30e3ab9df5ea19f56))

## [0.129.20](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.19...runner-rs-v0.129.20) (2026-06-25)


### Refactoring

* **runner:** centralize idle pool test builders ([#18916](https://github.com/vm0-ai/vm0/issues/18916)) ([c04c100](https://github.com/vm0-ai/vm0/commit/c04c100614f9d05347f184ada2726dc8835ff136))
* **runner:** deduplicate idle-pool expiration eviction ([#18912](https://github.com/vm0-ai/vm0/issues/18912)) ([d5bcd1c](https://github.com/vm0-ai/vm0/commit/d5bcd1c19e8d7131ee7802190bd69e8079e72bbf))

## [0.129.19](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.18...runner-rs-v0.129.19) (2026-06-25)


### Refactoring

* **mitm-addon:** centralize webhook retry handling ([#18901](https://github.com/vm0-ai/vm0/issues/18901)) ([a0c096f](https://github.com/vm0-ai/vm0/commit/a0c096fe40b67864d24d38851f2e22f65267ce6b))

## [0.129.18](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.17...runner-rs-v0.129.18) (2026-06-25)


### Bug Fixes

* **runner:** downgrade claude overload result logs ([#18890](https://github.com/vm0-ai/vm0/issues/18890)) ([2751ac3](https://github.com/vm0-ai/vm0/commit/2751ac3631d328965a032a20e6b51dd0a8e358cb))


### Refactoring

* **runner:** split proxy module by boundary ([#18885](https://github.com/vm0-ai/vm0/issues/18885)) ([f6b45b1](https://github.com/vm0-ai/vm0/commit/f6b45b190c2e8c13d802910197bc6226fe66b5ad))

## [0.129.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.16...runner-rs-v0.129.17) (2026-06-25)


### Bug Fixes

* reject invalid aws sigv4 header text ([#18866](https://github.com/vm0-ai/vm0/issues/18866)) ([5a14b21](https://github.com/vm0-ai/vm0/commit/5a14b215b29a71f3a30afec9f0a86c47fd8b1159))

## [0.129.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.15...runner-rs-v0.129.16) (2026-06-25)


### Refactoring

* centralize rust shell quoting ([#18833](https://github.com/vm0-ai/vm0/issues/18833)) ([d4f8878](https://github.com/vm0-ai/vm0/commit/d4f88785000474267e3462a44afea99759768e77))

## [0.129.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.14...runner-rs-v0.129.15) (2026-06-25)


### Bug Fixes

* harden guest runtime private file writes ([#18797](https://github.com/vm0-ai/vm0/issues/18797)) ([f334139](https://github.com/vm0-ai/vm0/commit/f334139eec67ff4bb64d2a47c3028505bd068cdd))
* require model usage provider for model observations ([#18800](https://github.com/vm0-ai/vm0/issues/18800)) ([92609b6](https://github.com/vm0-ai/vm0/commit/92609b62d6073d8c9c93167dac68c02f508df150))
* stabilize multi-architecture runner image builds ([#18843](https://github.com/vm0-ai/vm0/issues/18843)) ([7717811](https://github.com/vm0-ai/vm0/commit/77178117b8b53498c567a26853ced5a22eae15f1))


### Refactoring

* move builtin firewall generation ownership ([#18840](https://github.com/vm0-ai/vm0/issues/18840)) ([dc84829](https://github.com/vm0-ai/vm0/commit/dc84829ebe26c2716b6f2c935366dcb888f326b2))


### Performance Improvements

* **runner:** fold timezone sync into guest restore ([#18815](https://github.com/vm0-ai/vm0/issues/18815)) ([b1267e2](https://github.com/vm0-ai/vm0/commit/b1267e27df9d4a961cecf9780cf5498a71f97604))

## [0.129.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.13...runner-rs-v0.129.14) (2026-06-24)


### Refactoring

* compose builtin firewall catalog in generator ([#18821](https://github.com/vm0-ai/vm0/issues/18821)) ([a5a32b5](https://github.com/vm0-ai/vm0/commit/a5a32b59fe54f5182360c2ec45934be4f48ffe85))

## [0.129.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.12...runner-rs-v0.129.13) (2026-06-24)


### Bug Fixes

* classify deel custom field patch as write ([#18794](https://github.com/vm0-ai/vm0/issues/18794)) ([6e54807](https://github.com/vm0-ai/vm0/commit/6e5480751b9477cfa9bbb6c73eeb8fe858ebfb73))


### Refactoring

* move builtin firewall renderer to generator ([#18788](https://github.com/vm0-ai/vm0/issues/18788)) ([1b91859](https://github.com/vm0-ai/vm0/commit/1b918597991e115e7f1a13e1f1bd03b64891d66f))


### Performance Improvements

* stream storage manifest through stdin ([#18787](https://github.com/vm0-ai/vm0/issues/18787)) ([7667dda](https://github.com/vm0-ai/vm0/commit/7667dda4552a4471a12c9558108b03c7844bcb50))

## [0.129.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.11...runner-rs-v0.129.12) (2026-06-24)


### Bug Fixes

* require auth write for deel magic links ([#18795](https://github.com/vm0-ai/vm0/issues/18795)) ([e87ea3e](https://github.com/vm0-ai/vm0/commit/e87ea3eed415c040852ea62c70b064acec12d8f9))
* **runner:** classify Claude provider server errors ([#18781](https://github.com/vm0-ai/vm0/issues/18781)) ([c150950](https://github.com/vm0-ai/vm0/commit/c150950445346a61c63cb696adfa71b184c1e297))


### Refactoring

* **runner:** centralize workspace promotion eligibility ([#18790](https://github.com/vm0-ai/vm0/issues/18790)) ([f3e89e1](https://github.com/vm0-ai/vm0/commit/f3e89e1605bcf89e0d5a72ef1ae33d2ab4f0d2d8))


### Performance Improvements

* **mitm-addon:** share builtin firewall static payloads ([#18791](https://github.com/vm0-ai/vm0/issues/18791)) ([7b6f3bc](https://github.com/vm0-ai/vm0/commit/7b6f3bc9b6f0a166d64f6d49e3156214496bfa20))

## [0.129.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.10...runner-rs-v0.129.11) (2026-06-24)


### Bug Fixes

* bound zero-usage websocket sources ([#18755](https://github.com/vm0-ai/vm0/issues/18755)) ([b8ecc71](https://github.com/vm0-ai/vm0/commit/b8ecc71a95621bbc0cefc5511611b04d55c3c115))


### Performance Improvements

* reduce user env pre-spawn round trips ([#18775](https://github.com/vm0-ai/vm0/issues/18775)) ([e59f00e](https://github.com/vm0-ai/vm0/commit/e59f00e521f616a7e7619a3c43cb9a659b4b24d5))

## [0.129.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.9...runner-rs-v0.129.10) (2026-06-24)


### Documentation

* **mitm-addon:** clarify browser passthrough tradeoff ([#18745](https://github.com/vm0-ai/vm0/issues/18745)) ([4d84d1b](https://github.com/vm0-ai/vm0/commit/4d84d1b4af5c0bf6edab16598661e267529a1a9e))


### Refactoring

* encapsulate network log upload batching ([#18743](https://github.com/vm0-ai/vm0/issues/18743)) ([08518b6](https://github.com/vm0-ai/vm0/commit/08518b660274f38abe064a40ddacc4b515d8f1fa))

## [0.129.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.8...runner-rs-v0.129.9) (2026-06-24)


### Bug Fixes

* deduplicate clerk firewall route permissions ([#18731](https://github.com/vm0-ai/vm0/issues/18731)) ([d90b4dc](https://github.com/vm0-ai/vm0/commit/d90b4dc8a9da04f0cb1d374ea490d64025c6c6ec))
* deduplicate vercel firewall route permissions ([#18741](https://github.com/vm0-ai/vm0/issues/18741)) ([ac07b31](https://github.com/vm0-ai/vm0/commit/ac07b31e83a31860e3a00a5a84872a3d5cde74d1))


### Performance Improvements

* reduce guest state restore startup execs ([#18739](https://github.com/vm0-ai/vm0/issues/18739)) ([1fcfe7c](https://github.com/vm0-ai/vm0/commit/1fcfe7caf4c7f1589ac4d2684cff2fec61669d21))

## [0.129.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.7...runner-rs-v0.129.8) (2026-06-24)


### Bug Fixes

* deduplicate stripe firewall route permissions ([#18715](https://github.com/vm0-ai/vm0/issues/18715)) ([1dd0238](https://github.com/vm0-ai/vm0/commit/1dd0238bd82fc9fcf7953dc9bb8e1adf4f933567))

## [0.129.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.6...runner-rs-v0.129.7) (2026-06-23)


### Bug Fixes

* use resource permissions for Strava firewall ([#18700](https://github.com/vm0-ai/vm0/issues/18700)) ([045ae46](https://github.com/vm0-ai/vm0/commit/045ae462afcd25d23ce07e511289e89ad5fafe1b))

## [0.129.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.5...runner-rs-v0.129.6) (2026-06-23)


### Bug Fixes

* deduplicate Slack firewall route owners ([#18675](https://github.com/vm0-ai/vm0/issues/18675)) ([fdccc38](https://github.com/vm0-ai/vm0/commit/fdccc38bbd5b6cacac21926e233dec8f649e087b))
* **mitm-addon:** ignore invalid utf-8 flush markers ([#18690](https://github.com/vm0-ai/vm0/issues/18690)) ([cf9dcb9](https://github.com/vm0-ai/vm0/commit/cf9dcb90d42a0285e2dc49a5f53e4dcedaf05fc3))
* reject malformed AWS SigV4 content hash headers ([#18688](https://github.com/vm0-ai/vm0/issues/18688)) ([4407c3a](https://github.com/vm0-ai/vm0/commit/4407c3aa349fbf252e16d07f0972f62c6341b5c5))


### Refactoring

* **runner:** clarify new sandbox test helpers ([#18689](https://github.com/vm0-ai/vm0/issues/18689)) ([b84bc44](https://github.com/vm0-ai/vm0/commit/b84bc44da78ab4c01bb09cb1234b93feb41b14bc))

## [0.129.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.4...runner-rs-v0.129.5) (2026-06-23)


### Bug Fixes

* reject non-ascii authority port digits ([#18669](https://github.com/vm0-ai/vm0/issues/18669)) ([73c402a](https://github.com/vm0-ai/vm0/commit/73c402a7c237b93eecd6fcb266ecb54d6909ce69))


### Documentation

* clarify storage cache file url contract ([#18662](https://github.com/vm0-ai/vm0/issues/18662)) ([708fcd5](https://github.com/vm0-ai/vm0/commit/708fcd5e76de843cbb2c1375447be77d7758aa4b))


### Refactoring

* **runner:** split dns module by responsibility ([#18673](https://github.com/vm0-ai/vm0/issues/18673)) ([959c682](https://github.com/vm0-ai/vm0/commit/959c682ff689140f0f1efd1d5b7300905fd6096e))

## [0.129.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.3...runner-rs-v0.129.4) (2026-06-23)


### Bug Fixes

* deduplicate deel firewall route owners ([#18631](https://github.com/vm0-ai/vm0/issues/18631)) ([0a219eb](https://github.com/vm0-ai/vm0/commit/0a219ebba2ce16707cedfb37fa3bb7aad75d74fe))
* deduplicate figma firewall route owners ([#18639](https://github.com/vm0-ai/vm0/issues/18639)) ([4389f72](https://github.com/vm0-ai/vm0/commit/4389f72b67f082698c3852b7e0ad9e88902277ce))
* drain runner telemetry auto flushes ([#18636](https://github.com/vm0-ai/vm0/issues/18636)) ([7ceec80](https://github.com/vm0-ai/vm0/commit/7ceec80ef299ed0fe0425abb9f27b9ea5baae5d8))

## [0.129.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.2...runner-rs-v0.129.3) (2026-06-23)


### Bug Fixes

* deduplicate sentry firewall route owners ([#18620](https://github.com/vm0-ai/vm0/issues/18620)) ([21f9f3b](https://github.com/vm0-ai/vm0/commit/21f9f3bc6b5c3fec803824e292247721c64b6baf))


### Performance Improvements

* avoid active input validation allocation ([#18624](https://github.com/vm0-ai/vm0/issues/18624)) ([4b0cd9c](https://github.com/vm0-ai/vm0/commit/4b0cd9cac8ffe9855503d675d7f0320809ac49e7))
* index mitm firewall matching ([#18621](https://github.com/vm0-ai/vm0/issues/18621)) ([8893680](https://github.com/vm0-ai/vm0/commit/8893680a262a377ac7e029a5f06d64571b54b23c))
* **runner:** reduce procfs stat parsing overhead ([#18626](https://github.com/vm0-ai/vm0/issues/18626)) ([3922056](https://github.com/vm0-ai/vm0/commit/39220562e2d1f9e66142d8ba22e5ab48183c3690))

## [0.129.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.1...runner-rs-v0.129.2) (2026-06-23)


### Bug Fixes

* deduplicate xero firewall route owners ([#18598](https://github.com/vm0-ai/vm0/issues/18598)) ([c5e833d](https://github.com/vm0-ai/vm0/commit/c5e833d699b10daf210cc832e893973c26e9a924))
* make slow exec terminal warnings actionable ([#18619](https://github.com/vm0-ai/vm0/issues/18619)) ([ab0ce71](https://github.com/vm0-ai/vm0/commit/ab0ce71380d416da28156f15e80def1a24dd3bef))


### Documentation

* **mitm-addon:** clarify x usage billing test docstrings ([#18607](https://github.com/vm0-ai/vm0/issues/18607)) ([137280e](https://github.com/vm0-ai/vm0/commit/137280ecb71d0d341668a41de15a1d7afa061370))


### Performance Improvements

* **mitm-addon:** cache compiled builtin firewall cores ([#18597](https://github.com/vm0-ai/vm0/issues/18597)) ([251c7dc](https://github.com/vm0-ai/vm0/commit/251c7dc481283c1b43f673ca45b547f47487b64c))
* **runner:** coalesce network log batch writes ([#18604](https://github.com/vm0-ai/vm0/issues/18604)) ([acc9054](https://github.com/vm0-ai/vm0/commit/acc9054b688e3861e2793cc31226c8287f0337d4))

## [0.129.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.129.0...runner-rs-v0.129.1) (2026-06-23)


### Bug Fixes

* classify claude output token limits ([#18579](https://github.com/vm0-ai/vm0/issues/18579)) ([2b43740](https://github.com/vm0-ai/vm0/commit/2b437408b03be9c6413705dd1b633cbc33a2a62a))
* select single cloudflare firewall permission ([#18554](https://github.com/vm0-ai/vm0/issues/18554)) ([bf31571](https://github.com/vm0-ai/vm0/commit/bf31571649ef8dee8018214a255af036ddd5d775))

## [0.129.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.128.0...runner-rs-v0.129.0) (2026-06-22)


### Features

* add youtube manifest firewall ([#18533](https://github.com/vm0-ai/vm0/issues/18533)) ([95239f6](https://github.com/vm0-ai/vm0/commit/95239f67dc35ab55b9fe400917317b93e91fed37))


### Bug Fixes

* separate Claude post-result cleanup lifecycle ([#18524](https://github.com/vm0-ai/vm0/issues/18524)) ([6dcad82](https://github.com/vm0-ai/vm0/commit/6dcad82ea6241cc2197e577867ba8bee00e13525))


### Refactoring

* centralize codex thread id contract ([#18499](https://github.com/vm0-ai/vm0/issues/18499)) ([9cecc84](https://github.com/vm0-ai/vm0/commit/9cecc8421f4073ce32b6529fff89049779a7c13e))


### Performance Improvements

* defer connector diagnostic catalog lookup ([#18504](https://github.com/vm0-ai/vm0/issues/18504)) ([d101ba7](https://github.com/vm0-ai/vm0/commit/d101ba7f70c40c2a097ccc68a3af9263258a6811))

## [0.128.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.127.1...runner-rs-v0.128.0) (2026-06-22)


### Features

* add google search console manifest firewall ([#18489](https://github.com/vm0-ai/vm0/issues/18489)) ([e77a78f](https://github.com/vm0-ai/vm0/commit/e77a78f27238f87230a394210e61676c01f5b254))

## [0.127.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.127.0...runner-rs-v0.127.1) (2026-06-22)


### Refactoring

* **runner:** split codex session restore cleanup ([#18501](https://github.com/vm0-ai/vm0/issues/18501)) ([9e3b2cf](https://github.com/vm0-ai/vm0/commit/9e3b2cf805e936435a1079abd769d0d46df364f4))

## [0.127.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.126.0...runner-rs-v0.127.0) (2026-06-22)


### Features

* add google sheets manifest firewall ([#18502](https://github.com/vm0-ai/vm0/issues/18502)) ([ef3ad04](https://github.com/vm0-ai/vm0/commit/ef3ad044651ff554754dea6b54e095ea2da1802a))

## [0.126.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.125.5...runner-rs-v0.126.0) (2026-06-22)


### Features

* add google meet manifest firewall ([#18475](https://github.com/vm0-ai/vm0/issues/18475)) ([0e72804](https://github.com/vm0-ai/vm0/commit/0e728042c42ee7402f701549b738a794df3aefc5))


### Bug Fixes

* **runner:** abandon unpublished workspace promotions ([#18466](https://github.com/vm0-ai/vm0/issues/18466)) ([9c967c5](https://github.com/vm0-ai/vm0/commit/9c967c5d28ae9062b58aeaaf5d1c076e880c488a))
* validate workspace promotion identity on reuse ([#18458](https://github.com/vm0-ai/vm0/issues/18458)) ([a570d5a](https://github.com/vm0-ai/vm0/commit/a570d5a2d738ff7c7eb19e1c3c36475f52f2e339))


### Performance Improvements

* **mitm-addon:** reuse auth base tls context ([#18494](https://github.com/vm0-ai/vm0/issues/18494)) ([03cd4a9](https://github.com/vm0-ai/vm0/commit/03cd4a944ce5441408859de3df17a882f279a4a1))

## [0.125.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.125.4...runner-rs-v0.125.5) (2026-06-22)


### Bug Fixes

* add resource-based Gmail firewall permissions ([#18425](https://github.com/vm0-ai/vm0/issues/18425)) ([66c2735](https://github.com/vm0-ai/vm0/commit/66c273569d7b5f6086dd56848c403aa7d4ae282b))
* add resource-based google analytics firewall permissions ([#18435](https://github.com/vm0-ai/vm0/issues/18435)) ([9046498](https://github.com/vm0-ai/vm0/commit/90464980fd89298a46934a19cd1efa6addc5c5d4))
* add resource-based google calendar firewall permissions ([#18437](https://github.com/vm0-ai/vm0/issues/18437)) ([67525c7](https://github.com/vm0-ai/vm0/commit/67525c72a12e72857ef2701a173d0a39832195ae))


### Refactoring

* remove legacy exec result projections ([#18429](https://github.com/vm0-ai/vm0/issues/18429)) ([19b22fb](https://github.com/vm0-ai/vm0/commit/19b22fbde865689860394e2e9e9f699347f633b3))

## [0.125.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.125.3...runner-rs-v0.125.4) (2026-06-21)


### Refactoring

* **mitm-addon:** consolidate failed flush retention handling ([#18423](https://github.com/vm0-ai/vm0/issues/18423)) ([8b6fb2f](https://github.com/vm0-ai/vm0/commit/8b6fb2f42b9b896cc7c569268437904393442e3c))
* **runner:** share proxy flush protocol invariants ([#18421](https://github.com/vm0-ai/vm0/issues/18421)) ([33cc904](https://github.com/vm0-ai/vm0/commit/33cc9043825119e58de4282c0a08d533be9d6688))

## [0.125.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.125.2...runner-rs-v0.125.3) (2026-06-21)


### Bug Fixes

* replace google drive firewall scope permissions ([#18417](https://github.com/vm0-ai/vm0/issues/18417)) ([4b55d13](https://github.com/vm0-ai/vm0/commit/4b55d1381db08ec31b307c0d4010c6e0c3ab3462))


### Documentation

* **runner:** document executor diagnostics contract ([#18419](https://github.com/vm0-ai/vm0/issues/18419)) ([971ce06](https://github.com/vm0-ai/vm0/commit/971ce06f376fb9fbd8e27fd80882c5fce160be46))

## [0.125.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.125.1...runner-rs-v0.125.2) (2026-06-21)


### Refactoring

* expose structured remote exec termination ([#18382](https://github.com/vm0-ai/vm0/issues/18382)) ([7f1dfa6](https://github.com/vm0-ai/vm0/commit/7f1dfa6f58379465d770d0fcf0c43fc7e91d9473))

## [0.125.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.125.0...runner-rs-v0.125.1) (2026-06-20)


### Refactoring

* **mitm-addon:** consolidate firewall auth request inputs ([#18387](https://github.com/vm0-ai/vm0/issues/18387)) ([98c7bac](https://github.com/vm0-ai/vm0/commit/98c7bacdaeefbbb18f66490850122a3723c15cbd))
* **runner:** model workspace image lease identity ([#18389](https://github.com/vm0-ai/vm0/issues/18389)) ([ba1b945](https://github.com/vm0-ai/vm0/commit/ba1b9454845e1dd529aee79999dc4bb4e53f8416))

## [0.125.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.124.3...runner-rs-v0.125.0) (2026-06-19)


### Features

* add runner local active input forwarding ([#18286](https://github.com/vm0-ai/vm0/issues/18286)) ([a798b1a](https://github.com/vm0-ai/vm0/commit/a798b1abc04cfaa960d63bee7ce8d52b8300737a))


### Bug Fixes

* **runner:** avoid following symlinked gc cache dirs ([#18333](https://github.com/vm0-ai/vm0/issues/18333)) ([c1adb14](https://github.com/vm0-ai/vm0/commit/c1adb1433f5388887b5acb3078a0bc9b8bcc44f5))

## [0.124.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.124.2...runner-rs-v0.124.3) (2026-06-19)

## [0.124.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.124.1...runner-rs-v0.124.2) (2026-06-19)

## [0.124.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.124.0...runner-rs-v0.124.1) (2026-06-19)


### Bug Fixes

* restrict runner dnsmasq listener ([#18292](https://github.com/vm0-ai/vm0/issues/18292)) ([dacb3fb](https://github.com/vm0-ai/vm0/commit/dacb3fb70df2812c3e2e790e01f588c8f8f8a4f0))

## [0.124.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.123.0...runner-rs-v0.124.0) (2026-06-19)


### Features

* add maskdb connector ([#18320](https://github.com/vm0-ai/vm0/issues/18320)) ([c7b5ae4](https://github.com/vm0-ai/vm0/commit/c7b5ae4f44579fb9b166022e858dbe7c920078aa))


### Bug Fixes

* **runner:** validate storage cache content range probe ([#18282](https://github.com/vm0-ai/vm0/issues/18282)) ([3d78919](https://github.com/vm0-ai/vm0/commit/3d789199dfb29d84a3522b8a3d9d28a7243e3a35))


### Refactoring

* classify runner helper exec termination ([#18287](https://github.com/vm0-ai/vm0/issues/18287)) ([e3ed049](https://github.com/vm0-ai/vm0/commit/e3ed0499d16606a74909e06e31337a9b9232285a))

## [0.123.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.122.0...runner-rs-v0.123.0) (2026-06-18)


### Features

* add Box OAuth connector ([#18270](https://github.com/vm0-ai/vm0/issues/18270)) ([b9806d5](https://github.com/vm0-ai/vm0/commit/b9806d5b496c53520c34cda130f5b6ed219957ac))
* add Microsoft 365 OAuth connector ([#18271](https://github.com/vm0-ai/vm0/issues/18271)) ([ae3d80d](https://github.com/vm0-ai/vm0/commit/ae3d80da3d0bd11ecb79bb1617714e4d1428e0d0))
* add QuickBooks OAuth connector ([#18273](https://github.com/vm0-ai/vm0/issues/18273)) ([6f4aa42](https://github.com/vm0-ai/vm0/commit/6f4aa424c5311f4a36326ec81279dbd937d366e6))


### Refactoring

* **runner:** split main loop tests by behavior ([#18261](https://github.com/vm0-ai/vm0/issues/18261)) ([5deb4df](https://github.com/vm0-ai/vm0/commit/5deb4df2e95503f066f0f7985d6a07c15531f05b))
* split runner build snapshot and scripts ([#18293](https://github.com/vm0-ai/vm0/issues/18293)) ([7d215f5](https://github.com/vm0-ai/vm0/commit/7d215f5ad7432680e9498b678f77461a2a0304ed))

## [0.122.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.121.1...runner-rs-v0.122.0) (2026-06-18)


### Features

* **connectors:** give InsForge a firewall with user-entered backend URL ([#18229](https://github.com/vm0-ai/vm0/issues/18229)) ([e1f702c](https://github.com/vm0-ai/vm0/commit/e1f702cb7000fa9290fcb5812cec2df76f886b85))


### Bug Fixes

* run guest download for cached instruction normalization ([#18260](https://github.com/vm0-ai/vm0/issues/18260)) ([acbbfe2](https://github.com/vm0-ai/vm0/commit/acbbfe21d14d828c50194f59b6ee858c47cf6506))
* **runner:** guard local submit timeout ([#18264](https://github.com/vm0-ai/vm0/issues/18264)) ([9d648e6](https://github.com/vm0-ai/vm0/commit/9d648e6da78019d93bb9438c8d71b548d07abc87))


### Refactoring

* split runner build leaf modules ([#18268](https://github.com/vm0-ai/vm0/issues/18268)) ([d4efe3a](https://github.com/vm0-ai/vm0/commit/d4efe3a9a7c376d843dd8716f10eca8127d51178))

## [0.121.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.121.0...runner-rs-v0.121.1) (2026-06-18)


### Bug Fixes

* **mitm-addon:** report eventless OpenAI SSE parse errors ([#18227](https://github.com/vm0-ai/vm0/issues/18227)) ([e15be71](https://github.com/vm0-ai/vm0/commit/e15be71db99cb21cdab9586d33c9a11c809937de))


### Refactoring

* clarify agent and cli session ids ([#18232](https://github.com/vm0-ai/vm0/issues/18232)) ([18fa8d6](https://github.com/vm0-ai/vm0/commit/18fa8d6e5740b7121b3985a19b5082a637f9d39b))

## [0.121.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.120.4...runner-rs-v0.121.0) (2026-06-18)


### Features

* add Render connector ([#18202](https://github.com/vm0-ai/vm0/issues/18202)) ([d391830](https://github.com/vm0-ai/vm0/commit/d391830ac2006f8c6c9281f3aeeddce2fed14e96))


### Refactoring

* **mitm-addon:** centralize responses event prefilter ([#18213](https://github.com/vm0-ai/vm0/issues/18213)) ([ed43d9f](https://github.com/vm0-ai/vm0/commit/ed43d9fe67cfd3c9c3dad86e0d223f5fb363e286))

## [0.120.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.120.3...runner-rs-v0.120.4) (2026-06-18)

## [0.120.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.120.2...runner-rs-v0.120.3) (2026-06-18)


### Bug Fixes

* remove legacy google maps firewall host ([#18168](https://github.com/vm0-ai/vm0/issues/18168)) ([39600b4](https://github.com/vm0-ai/vm0/commit/39600b4b605526defa5ce16929c7ddb67ab3f280))

## [0.120.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.120.1...runner-rs-v0.120.2) (2026-06-18)

## [0.120.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.120.0...runner-rs-v0.120.1) (2026-06-18)


### Bug Fixes

* **mitm-addon:** release unreportable websocket usage sources ([#18087](https://github.com/vm0-ai/vm0/issues/18087)) ([45c3c26](https://github.com/vm0-ai/vm0/commit/45c3c26934b635707d93ab0e7675a0aaeb958e21))

## [0.120.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.119.3...runner-rs-v0.120.0) (2026-06-18)


### Features

* add profound connector ([#18121](https://github.com/vm0-ai/vm0/issues/18121)) ([e9fb4c6](https://github.com/vm0-ai/vm0/commit/e9fb4c6b565a662c7697f1eca0b7a2c25e95f7c9))

## [0.119.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.119.2...runner-rs-v0.119.3) (2026-06-17)


### Bug Fixes

* **mitm-addon:** preserve underbilling fallback context ([#18075](https://github.com/vm0-ai/vm0/issues/18075)) ([cc8fd8b](https://github.com/vm0-ai/vm0/commit/cc8fd8ba40c619d8dd8f329e0a503a6cecf6cbee))
* **runner:** make local queue files private ([#18052](https://github.com/vm0-ai/vm0/issues/18052)) ([e482b43](https://github.com/vm0-ai/vm0/commit/e482b43ec36868f2c45c40ad55a31713415faf7d))


### Refactoring

* remove stale feature switches and dead code ([#18090](https://github.com/vm0-ai/vm0/issues/18090)) ([9406838](https://github.com/vm0-ai/vm0/commit/940683865a2256f83b2d92d36cf102e0fb06e131))

## [0.119.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.119.1...runner-rs-v0.119.2) (2026-06-17)


### Bug Fixes

* **mitm-addon:** require complete compressed usage streams ([#18089](https://github.com/vm0-ai/vm0/issues/18089)) ([bfc30eb](https://github.com/vm0-ai/vm0/commit/bfc30ebdcbb54dc5174de84301a6c3969319d799))

## [0.119.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.119.0...runner-rs-v0.119.1) (2026-06-17)


### Bug Fixes

* **runner:** redact session ids from diagnostics ([#18002](https://github.com/vm0-ai/vm0/issues/18002)) ([326365b](https://github.com/vm0-ai/vm0/commit/326365b25d11f6c5d5bb957171223ec810f24c34))


### Documentation

* **mitm-addon:** clarify browser passthrough heuristic ([#18058](https://github.com/vm0-ai/vm0/issues/18058)) ([4be2b60](https://github.com/vm0-ai/vm0/commit/4be2b60bc63cf53a42cbe9ed79807b18abbe2c38))


### Refactoring

* **mitm-addon:** generate readable builtin firewall modules ([#18035](https://github.com/vm0-ai/vm0/issues/18035)) ([b0eeca8](https://github.com/vm0-ai/vm0/commit/b0eeca8a508f78b5e3140192744c9ce00a63b37e))
* **mitm-addon:** split firewall auth boundaries ([#18033](https://github.com/vm0-ai/vm0/issues/18033)) ([4ac325c](https://github.com/vm0-ai/vm0/commit/4ac325cbfb85d087a2d93d2fe75c049b9869dc23))

## [0.119.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.118.11...runner-rs-v0.119.0) (2026-06-17)


### Features

* **runner:** add local submit env overrides ([#17930](https://github.com/vm0-ai/vm0/issues/17930)) ([5c2c63c](https://github.com/vm0-ai/vm0/commit/5c2c63cdde42a7951e3af80dad7c892cdeca4de9))

## [0.118.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.118.10...runner-rs-v0.118.11) (2026-06-17)


### Bug Fixes

* **runner:** validate benchmark env keys before startup ([#17999](https://github.com/vm0-ai/vm0/issues/17999)) ([4e6b823](https://github.com/vm0-ai/vm0/commit/4e6b823eba479c95cc7dbc8e377621f99b7ea5bf))


### Performance Improvements

* **runner:** avoid cloned idle eviction keys ([#17998](https://github.com/vm0-ai/vm0/issues/17998)) ([49f87a9](https://github.com/vm0-ai/vm0/commit/49f87a964c3e136fb04b8013acbc0715b781babe))

## [0.118.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.118.9...runner-rs-v0.118.10) (2026-06-17)

## [0.118.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.118.8...runner-rs-v0.118.9) (2026-06-16)


### Bug Fixes

* add Google Maps OAuth firewall hosts ([#17926](https://github.com/vm0-ai/vm0/issues/17926)) ([03e786e](https://github.com/vm0-ai/vm0/commit/03e786eeb2dc1fadade13cb6058d319f9ac73cc6))


### Refactoring

* **runner:** clarify firecracker discovery state ([#17923](https://github.com/vm0-ai/vm0/issues/17923)) ([2e6c582](https://github.com/vm0-ai/vm0/commit/2e6c582d8c9db60ceae54c805cf2e9e600bc415f))
* **runner:** split workspace image cache module ([#17916](https://github.com/vm0-ai/vm0/issues/17916)) ([208652f](https://github.com/vm0-ai/vm0/commit/208652fa8b444b45a121d7340c1ccc1d7324b5bb))
* split r2 cache tests by behavior ([#17922](https://github.com/vm0-ai/vm0/issues/17922)) ([9e2c775](https://github.com/vm0-ai/vm0/commit/9e2c775d10c13a0e6bb098bd6d4c7aa741ad824c))

## [0.118.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.118.7...runner-rs-v0.118.8) (2026-06-16)


### Bug Fixes

* preserve guest logs after runner timeout ([#17909](https://github.com/vm0-ai/vm0/issues/17909)) ([741ea2c](https://github.com/vm0-ai/vm0/commit/741ea2cee65a007fab5b574e3e371a73d20ea842))

## [0.118.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.118.6...runner-rs-v0.118.7) (2026-06-16)


### Bug Fixes

* **mitm-addon:** block cleartext firewall credential injection ([#17864](https://github.com/vm0-ai/vm0/issues/17864)) ([cf9e4fa](https://github.com/vm0-ai/vm0/commit/cf9e4fa26cc46368c37c3df5fc42a62ea26748c7))

## [0.118.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.118.5...runner-rs-v0.118.6) (2026-06-16)


### Refactoring

* split runner r2 cache module ([#17883](https://github.com/vm0-ai/vm0/issues/17883)) ([65f08eb](https://github.com/vm0-ai/vm0/commit/65f08eb0bc146ab6760ab7f1d4ce79acb3df53de))

## [0.118.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.118.4...runner-rs-v0.118.5) (2026-06-16)


### Bug Fixes

* handle blocked network log uploads ([#17822](https://github.com/vm0-ai/vm0/issues/17822)) ([19b1b37](https://github.com/vm0-ai/vm0/commit/19b1b373a3669064fb7ddc1067692f820f34cdb6))

## [0.118.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.118.3...runner-rs-v0.118.4) (2026-06-16)


### Bug Fixes

* classify runner rootfs exhaustion ([#17844](https://github.com/vm0-ai/vm0/issues/17844)) ([ff4698a](https://github.com/vm0-ai/vm0/commit/ff4698ac751934d9464be6f2ba21d83fa1b610c0))

## [0.118.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.118.2...runner-rs-v0.118.3) (2026-06-16)


### Bug Fixes

* log claude provider overloads as info ([#17813](https://github.com/vm0-ai/vm0/issues/17813)) ([b13b8a6](https://github.com/vm0-ai/vm0/commit/b13b8a69fea42d20ea45b1ab87e5048fda3661de))

## [0.118.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.118.1...runner-rs-v0.118.2) (2026-06-16)


### Bug Fixes

* update axiom firewall specs ([#17775](https://github.com/vm0-ai/vm0/issues/17775)) ([066b01d](https://github.com/vm0-ai/vm0/commit/066b01d1c770753654e2164000430aa5f6888f05))
* update clerk firewall specs ([#17779](https://github.com/vm0-ai/vm0/issues/17779)) ([041cec1](https://github.com/vm0-ai/vm0/commit/041cec11a91134a312b654479b4d4db7dcfd4134))
* update cloudflare firewall specs ([#17789](https://github.com/vm0-ai/vm0/issues/17789)) ([d9ecd29](https://github.com/vm0-ai/vm0/commit/d9ecd29b9e615a92aed0d19e10a0dfb07f78e98b))


### Refactoring

* centralize runner execution context test fixtures ([#17825](https://github.com/vm0-ai/vm0/issues/17825)) ([e9b2194](https://github.com/vm0-ai/vm0/commit/e9b2194ada7d163e1f4eea89010d722a8e06b739))
* split runner builtin firewall catalog ([#17778](https://github.com/vm0-ai/vm0/issues/17778)) ([c72d98a](https://github.com/vm0-ai/vm0/commit/c72d98ab6e68605b7880c6f97f93b4698d27694e))

## [0.118.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.118.0...runner-rs-v0.118.1) (2026-06-15)


### Refactoring

* **mitm-addon:** split compiled firewall precedence tests ([#17760](https://github.com/vm0-ai/vm0/issues/17760)) ([97c6bbd](https://github.com/vm0-ai/vm0/commit/97c6bbd60570fdac156ca775c0e6d95ab0dba274))

## [0.118.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.117.2...runner-rs-v0.118.0) (2026-06-15)


### Features

* add google maps oauth connector ([#17351](https://github.com/vm0-ai/vm0/issues/17351)) ([c89bd02](https://github.com/vm0-ai/vm0/commit/c89bd0254903898ce5cdc7df4859ba7497364cc7))


### Performance Improvements

* **mitm-addon:** stream firewall rule decisions ([#17766](https://github.com/vm0-ai/vm0/issues/17766)) ([c218798](https://github.com/vm0-ai/vm0/commit/c2187982dc6b225229d22d65bc2692632d9c5646))

## [0.117.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.117.1...runner-rs-v0.117.2) (2026-06-15)


### Bug Fixes

* add usage underbilling alert signals ([#17691](https://github.com/vm0-ai/vm0/issues/17691)) ([4edf467](https://github.com/vm0-ai/vm0/commit/4edf467d84ec10bcd7138ba90d44330e94083f35))

## [0.117.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.117.0...runner-rs-v0.117.1) (2026-06-15)


### Refactoring

* centralize model-provider metadata test setup ([#17722](https://github.com/vm0-ai/vm0/issues/17722)) ([e6c880f](https://github.com/vm0-ai/vm0/commit/e6c880f7b3900b0de7a61378e2ed03f77ed64d3f))

## [0.117.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.116.7...runner-rs-v0.117.0) (2026-06-15)


### Features

* replace YouTube API key auth with OAuth ([#17661](https://github.com/vm0-ai/vm0/issues/17661)) ([c548213](https://github.com/vm0-ai/vm0/commit/c54821371703d3be2c996db429630b36b1404e67))


### Bug Fixes

* bound websocket model usage sources ([#17639](https://github.com/vm0-ai/vm0/issues/17639)) ([499347c](https://github.com/vm0-ai/vm0/commit/499347cc6551b413b50fdc925049bfcb45340332))


### Documentation

* **mitm-addon:** clarify x stream buffering ([#17634](https://github.com/vm0-ai/vm0/issues/17634)) ([2bc2930](https://github.com/vm0-ai/vm0/commit/2bc2930c9d4227d2604b5c8931b8616f7f8dfe80))


### Refactoring

* centralize guest env key names ([#17626](https://github.com/vm0-ai/vm0/issues/17626)) ([476546d](https://github.com/vm0-ai/vm0/commit/476546de9d385733c481558b422511b30b1cc45a))


### Performance Improvements

* **runner:** move workspace cache hits into sandboxes ([#17629](https://github.com/vm0-ai/vm0/issues/17629)) ([3ec0448](https://github.com/vm0-ai/vm0/commit/3ec04481481f46589b219dfbf08d80555e86ed95))

## [0.116.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.116.6...runner-rs-v0.116.7) (2026-06-14)

## [0.116.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.116.5...runner-rs-v0.116.6) (2026-06-14)


### Bug Fixes

* **mitm-addon:** cap auth base bodies before buffering ([#17594](https://github.com/vm0-ai/vm0/issues/17594)) ([4d0ccd7](https://github.com/vm0-ai/vm0/commit/4d0ccd7e4af24a5c6846d096b5876c00b0f182ae))
* wrap malformed sigv4 urls in signing errors ([#17572](https://github.com/vm0-ai/vm0/issues/17572)) ([5dcfdfb](https://github.com/vm0-ai/vm0/commit/5dcfdfb8bb2fd0a40d055a74c2d06cb8477c8564))


### Documentation

* document auth base header trust boundaries ([#17581](https://github.com/vm0-ai/vm0/issues/17581)) ([e73cf83](https://github.com/vm0-ai/vm0/commit/e73cf8367b1667659ba4201152068f167df81148))


### Refactoring

* **mitm-addon:** split usage buffer internals ([#17591](https://github.com/vm0-ai/vm0/issues/17591)) ([b9a603e](https://github.com/vm0-ai/vm0/commit/b9a603e9540057362fb33c9218b77812171d691e))

## [0.116.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.116.4...runner-rs-v0.116.5) (2026-06-13)


### Bug Fixes

* reserve usage webhook errors for final loss ([#17578](https://github.com/vm0-ai/vm0/issues/17578)) ([d4212a5](https://github.com/vm0-ai/vm0/commit/d4212a5920202fc6c39b822060134008000127bf))


### Performance Improvements

* **mitm-addon:** skip eventless responses delta parsing ([#17574](https://github.com/vm0-ai/vm0/issues/17574)) ([6446fc2](https://github.com/vm0-ai/vm0/commit/6446fc2f3b15397bd14270392231a461d35e7f27))

## [0.116.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.116.3...runner-rs-v0.116.4) (2026-06-13)


### Bug Fixes

* **runner:** reject non-file r2 templates ([#17573](https://github.com/vm0-ai/vm0/issues/17573)) ([eaa764f](https://github.com/vm0-ai/vm0/commit/eaa764f7b4fa5dac5dea987ed500363be9ac771f))

## [0.116.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.116.2...runner-rs-v0.116.3) (2026-06-13)


### Bug Fixes

* surface connector diagnostics for failed requests ([#17457](https://github.com/vm0-ai/vm0/issues/17457)) ([52a3083](https://github.com/vm0-ai/vm0/commit/52a308358d08bb30dd1e87e11747cfe13743a444))

## [0.116.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.116.1...runner-rs-v0.116.2) (2026-06-13)


### Documentation

* document model usage observation gates ([#17533](https://github.com/vm0-ai/vm0/issues/17533)) ([bec1ee0](https://github.com/vm0-ai/vm0/commit/bec1ee0de023f580554aef14949bddba2cc83892))

## [0.116.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.116.0...runner-rs-v0.116.1) (2026-06-13)


### Refactoring

* **mitm-addon:** split x connector usage tests ([#17530](https://github.com/vm0-ai/vm0/issues/17530)) ([22b1abf](https://github.com/vm0-ai/vm0/commit/22b1abfaff9fc4461c6b8f1af3455e361ddcb6d3))

## [0.116.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.115.0...runner-rs-v0.116.0) (2026-06-12)


### Features

* add google cloud firewall permissions ([#17476](https://github.com/vm0-ai/vm0/issues/17476)) ([f117e1a](https://github.com/vm0-ai/vm0/commit/f117e1a38bdda1e7bde6acabaf816ae65ac2549a))

## [0.115.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.114.10...runner-rs-v0.115.0) (2026-06-12)


### Features

* stream assistant text deltas to web chat ([#17370](https://github.com/vm0-ai/vm0/issues/17370)) ([cbfdf74](https://github.com/vm0-ai/vm0/commit/cbfdf74761771d0142603030ca764d1f33d61479))

## [0.114.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.114.9...runner-rs-v0.114.10) (2026-06-12)

## [0.114.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.114.8...runner-rs-v0.114.9) (2026-06-12)


### Bug Fixes

* bound retained usage webhook retries ([#17477](https://github.com/vm0-ai/vm0/issues/17477)) ([0b6b7c3](https://github.com/vm0-ai/vm0/commit/0b6b7c3d2b5672709a10f283f0c1b7780a8ab294))
* distinguish preparing runner jobs from running sandboxes ([#17482](https://github.com/vm0-ai/vm0/issues/17482)) ([90ec9bc](https://github.com/vm0-ai/vm0/commit/90ec9bc40be26ac4a7d9f5128fc092e09d23c00a))

## [0.114.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.114.7...runner-rs-v0.114.8) (2026-06-12)


### Bug Fixes

* reject parent host file paths before walking ([#17487](https://github.com/vm0-ai/vm0/issues/17487)) ([a32fd21](https://github.com/vm0-ai/vm0/commit/a32fd21228c1e6196f300df59519feea69718e07))
* stop publishing runner running status during startup ([#17475](https://github.com/vm0-ai/vm0/issues/17475)) ([aabbc1e](https://github.com/vm0-ai/vm0/commit/aabbc1e935847e57c10dd0c1c5b84c599285bf93))

## [0.114.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.114.6...runner-rs-v0.114.7) (2026-06-12)


### Refactoring

* **runner:** remove argv-derived runner identity ([#17418](https://github.com/vm0-ai/vm0/issues/17418)) ([f25341e](https://github.com/vm0-ai/vm0/commit/f25341ea7b4f4b69250a4332e50697558d360513))

## [0.114.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.114.5...runner-rs-v0.114.6) (2026-06-12)


### Bug Fixes

* classify non-code runner job failures ([#17438](https://github.com/vm0-ai/vm0/issues/17438)) ([dcae0a6](https://github.com/vm0-ai/vm0/commit/dcae0a69924bbf34c4a31cea9fee74cbca9aa16d))
* **runner:** enforce global workspace cache budget ([#17437](https://github.com/vm0-ai/vm0/issues/17437)) ([c2e9a49](https://github.com/vm0-ai/vm0/commit/c2e9a49801481150acf73ad31eeb6e5edb08aa33))

## [0.114.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.114.4...runner-rs-v0.114.5) (2026-06-12)


### Bug Fixes

* retain saturated usage webhook batches ([#17411](https://github.com/vm0-ai/vm0/issues/17411)) ([5592584](https://github.com/vm0-ai/vm0/commit/5592584fd684d3797f7666a2ca7dd7abd4eaa03f))

## [0.114.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.114.3...runner-rs-v0.114.4) (2026-06-12)


### Bug Fixes

* **runner:** resolve runs from live registry status ([#17392](https://github.com/vm0-ai/vm0/issues/17392)) ([3bfd39b](https://github.com/vm0-ai/vm0/commit/3bfd39b4aa2fa918485f36bc9b05a4657a4c10c9))

## [0.114.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.114.2...runner-rs-v0.114.3) (2026-06-12)


### Bug Fixes

* bound skipped json number tokens ([#17389](https://github.com/vm0-ai/vm0/issues/17389)) ([c618820](https://github.com/vm0-ai/vm0/commit/c618820016db52d08a3bd479c5c84fa10adaeeb4))


### Documentation

* document aws sigv4 re-signing contract ([#17386](https://github.com/vm0-ai/vm0/issues/17386)) ([72be756](https://github.com/vm0-ai/vm0/commit/72be756462e472c883b7a4e76910320d11ef1669))

## [0.114.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.114.1...runner-rs-v0.114.2) (2026-06-12)


### Bug Fixes

* **runner:** use live registry for doctor reports ([#17348](https://github.com/vm0-ai/vm0/issues/17348)) ([1f06b34](https://github.com/vm0-ai/vm0/commit/1f06b3406eb9b5248ca128cb5a84072ad02c83b9))

## [0.114.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.114.0...runner-rs-v0.114.1) (2026-06-11)


### Bug Fixes

* **mitm-addon:** strip client credentials from auth.base forwarding ([#17347](https://github.com/vm0-ai/vm0/issues/17347)) ([cb762d3](https://github.com/vm0-ai/vm0/commit/cb762d3dbebfeb56681de00e72a52b8756a88d3f))


### Refactoring

* remove legacy execution firewall compatibility ([#17349](https://github.com/vm0-ai/vm0/issues/17349)) ([385ea93](https://github.com/vm0-ai/vm0/commit/385ea9345fb9613b0041eefb2ed7557f2af62beb))


### Performance Improvements

* batch rust network log appends ([#17339](https://github.com/vm0-ai/vm0/issues/17339)) ([d92d930](https://github.com/vm0-ai/vm0/commit/d92d930a8d406d2162fc6fb648bb30629a350b97))

## [0.114.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.113.1...runner-rs-v0.114.0) (2026-06-11)


### Features

* add cloudflare firewall permissions ([#17284](https://github.com/vm0-ai/vm0/issues/17284)) ([74d4165](https://github.com/vm0-ai/vm0/commit/74d4165e373251359d4d1e101390793958e00254))


### Refactoring

* **mitm-addon:** split firewall request matching tests ([#17333](https://github.com/vm0-ai/vm0/issues/17333)) ([f9fabb9](https://github.com/vm0-ai/vm0/commit/f9fabb9c49b78fe2a318cde7dfb36a3bf9a22862))

## [0.113.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.113.0...runner-rs-v0.113.1) (2026-06-11)


### Bug Fixes

* **runner:** add live runner instances ([#17278](https://github.com/vm0-ai/vm0/issues/17278)) ([6d40873](https://github.com/vm0-ai/vm0/commit/6d40873f6691c8cf35fcb2aaa881ecd441ca2c64))


### Refactoring

* **mitm-addon:** split stream usage tests ([#17289](https://github.com/vm0-ai/vm0/issues/17289)) ([98246a4](https://github.com/vm0-ai/vm0/commit/98246a4c01de092483527d62a89453f5e947ee78))

## [0.113.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.112.1...runner-rs-v0.113.0) (2026-06-11)


### Features

* send compact builtin firewall refs to runner ([#17252](https://github.com/vm0-ai/vm0/issues/17252)) ([e65864a](https://github.com/vm0-ai/vm0/commit/e65864afdea65f6ded9b9de7c3bcc057184852aa))


### Bug Fixes

* **mitm-addon:** validate X fallback query hints ([#17263](https://github.com/vm0-ai/vm0/issues/17263)) ([92bda16](https://github.com/vm0-ai/vm0/commit/92bda16ac194f6b5a66bdc3f801eb291f330d160))


### Performance Improvements

* **mitm-addon:** skip non-terminal responses websocket usage scans ([#17283](https://github.com/vm0-ai/vm0/issues/17283)) ([e1bb5a9](https://github.com/vm0-ai/vm0/commit/e1bb5a992a537a01fd1e0f8815fff8a2a9f2ea21))

## [0.112.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.112.0...runner-rs-v0.112.1) (2026-06-11)


### Performance Improvements

* avoid serializing storage cache hit writes ([#17271](https://github.com/vm0-ai/vm0/issues/17271)) ([0f1864d](https://github.com/vm0-ai/vm0/commit/0f1864d71e3eb41d549b3c083bca0509605983d0))

## [0.112.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.111.3...runner-rs-v0.112.0) (2026-06-11)


### Features

* add runner claim pickup telemetry ([#17268](https://github.com/vm0-ai/vm0/issues/17268)) ([270d94e](https://github.com/vm0-ai/vm0/commit/270d94ed8ca7820d4c097c38484871e8373b104b))

## [0.111.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.111.2...runner-rs-v0.111.3) (2026-06-11)


### Bug Fixes

* **mitm-addon:** block runner usage flush ownership ([#17230](https://github.com/vm0-ai/vm0/issues/17230)) ([53e5555](https://github.com/vm0-ai/vm0/commit/53e55556d580a7afdc20a665b202746b0d97cd55))


### Refactoring

* **runner:** name storage fingerprint entries ([#17231](https://github.com/vm0-ai/vm0/issues/17231)) ([d2ead29](https://github.com/vm0-ai/vm0/commit/d2ead29d04278670853472900735a8a254143cfb))

## [0.111.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.111.1...runner-rs-v0.111.2) (2026-06-11)


### Documentation

* document runner proxy architecture ([#17227](https://github.com/vm0-ai/vm0/issues/17227)) ([78e3676](https://github.com/vm0-ai/vm0/commit/78e36764b427a64fdce76cb57f1f498d0c738d77))

## [0.111.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.111.0...runner-rs-v0.111.1) (2026-06-11)


### Documentation

* **mitm-addon:** clarify x request metadata docs ([#17207](https://github.com/vm0-ai/vm0/issues/17207)) ([111072a](https://github.com/vm0-ai/vm0/commit/111072a5f907e794dc7c53f4f04bf4b79552db79))


### Performance Improvements

* **mitm-addon:** cache unsafe path scans ([#17212](https://github.com/vm0-ai/vm0/issues/17212)) ([f3c78e6](https://github.com/vm0-ai/vm0/commit/f3c78e62d88d827e278cbdc156f445ac6d3d2e4f))

## [0.111.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.110.4...runner-rs-v0.111.0) (2026-06-11)


### Features

* add runner claim timing telemetry ([#17137](https://github.com/vm0-ai/vm0/issues/17137)) ([5f7e3db](https://github.com/vm0-ai/vm0/commit/5f7e3db4225e403a498fc916b5bf1c183c3f9532))


### Bug Fixes

* block stale mitm tls admissions ([#17141](https://github.com/vm0-ai/vm0/issues/17141)) ([45dc93f](https://github.com/vm0-ai/vm0/commit/45dc93faeb40225aedfdb1dce52e3158723bd2d5))
* **mitm-addon:** handle malformed x tld sources ([#17134](https://github.com/vm0-ai/vm0/issues/17134)) ([447a77f](https://github.com/vm0-ai/vm0/commit/447a77fe28dcb4559d27bacbab61899f4c1cb243))
* preserve model websocket usage sources ([#17128](https://github.com/vm0-ai/vm0/issues/17128)) ([55e730c](https://github.com/vm0-ai/vm0/commit/55e730c6282103c08beecece0824b217b0133cfd))
* wait for workspace holders before unmount retry ([#17131](https://github.com/vm0-ai/vm0/issues/17131)) ([f7f7ac1](https://github.com/vm0-ai/vm0/commit/f7f7ac1b9b4a1c010be50f8160ae8646ab68608f))

## [0.110.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.110.3...runner-rs-v0.110.4) (2026-06-10)


### Bug Fixes

* bound runner dirname length ([#17080](https://github.com/vm0-ai/vm0/issues/17080)) ([e9026ee](https://github.com/vm0-ai/vm0/commit/e9026ee122d63ab76f70c6bb24eac84dce95d09c))
* clean orphaned version service locks ([#17067](https://github.com/vm0-ai/vm0/issues/17067)) ([8229e47](https://github.com/vm0-ai/vm0/commit/8229e47d4851cc98d24082708a947a114de583c3))
* **runner:** redact command output before excerpting ([#17079](https://github.com/vm0-ai/vm0/issues/17079)) ([7ac5423](https://github.com/vm0-ai/vm0/commit/7ac5423d7334b3d9cf055d6e41358bfa6d257eec))


### Performance Improvements

* avoid ably job notification string clones ([#17050](https://github.com/vm0-ai/vm0/issues/17050)) ([72b30ee](https://github.com/vm0-ai/vm0/commit/72b30ee335de848423a58fdf0ae7d0bb3310e952))

## [0.110.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.110.2...runner-rs-v0.110.3) (2026-06-10)


### Bug Fixes

* filter unsafe resolved auth headers ([#17053](https://github.com/vm0-ai/vm0/issues/17053)) ([53ae1aa](https://github.com/vm0-ai/vm0/commit/53ae1aa5f89acb05f3399c0c47e25d5c0e0f788a))

## [0.110.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.110.1...runner-rs-v0.110.2) (2026-06-10)


### Refactoring

* move storage fingerprints out of idle pool ([#17051](https://github.com/vm0-ai/vm0/issues/17051)) ([1e6fb39](https://github.com/vm0-ai/vm0/commit/1e6fb3923f9f9a481e5741813dc413c5a9325cd2))

## [0.110.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.110.0...runner-rs-v0.110.1) (2026-06-10)


### Refactoring

* split firewall auth hook orchestration ([#17002](https://github.com/vm0-ai/vm0/issues/17002)) ([f042a66](https://github.com/vm0-ai/vm0/commit/f042a66aa0769d1992ded2a324dc91b36382f333))

## [0.110.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.109.0...runner-rs-v0.110.0) (2026-06-10)


### Features

* roll out workspace image cache ([#16990](https://github.com/vm0-ai/vm0/issues/16990)) ([420f20b](https://github.com/vm0-ai/vm0/commit/420f20b1288d217e456432290f57d29efeebef37))

## [0.109.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.25...runner-rs-v0.109.0) (2026-06-10)


### Features

* add aws sigv4 firewall auth runtime ([#16876](https://github.com/vm0-ai/vm0/issues/16876)) ([1be4dfc](https://github.com/vm0-ai/vm0/commit/1be4dfc3b764a38a2759c0b0164ebb158f2ffe86))

## [0.108.25](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.24...runner-rs-v0.108.25) (2026-06-09)


### Bug Fixes

* bound auth base forwarding workers ([#16912](https://github.com/vm0-ai/vm0/issues/16912)) ([1620c9a](https://github.com/vm0-ai/vm0/commit/1620c9ac419ad9a315e1fc23aa00ebf37ffbb20b))
* **mitm-addon:** handle registry json parser failures ([#16903](https://github.com/vm0-ai/vm0/issues/16903)) ([28a7fcd](https://github.com/vm0-ai/vm0/commit/28a7fcd102a5efca3f7b52adac37e39a5dc1d290))
* release usage tracking on request cancellation ([#16907](https://github.com/vm0-ai/vm0/issues/16907)) ([f61340e](https://github.com/vm0-ai/vm0/commit/f61340e6c0c6b04e82cd55c67db07d52649da7b4))

## [0.108.24](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.23...runner-rs-v0.108.24) (2026-06-09)


### Bug Fixes

* clarify runner job timeout logs ([#16823](https://github.com/vm0-ai/vm0/issues/16823)) ([77edf47](https://github.com/vm0-ai/vm0/commit/77edf47a4f3c43978ea9339209d370061ec3f474))


### Documentation

* document copy file semantics ([#16788](https://github.com/vm0-ai/vm0/issues/16788)) ([57223b3](https://github.com/vm0-ai/vm0/commit/57223b35d45d50b088ac6b35d1c69d59e3c39a1a))

## [0.108.23](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.22...runner-rs-v0.108.23) (2026-06-09)


### Bug Fixes

* **mitm-addon:** encode connector usage idempotency keys ([#16833](https://github.com/vm0-ai/vm0/issues/16833)) ([09fa9b2](https://github.com/vm0-ai/vm0/commit/09fa9b2e59b10645464b35fda404df8bc28c853c))
* **runner:** preserve local results during submit abandon ([#16832](https://github.com/vm0-ai/vm0/issues/16832)) ([86c9060](https://github.com/vm0-ai/vm0/commit/86c9060a627537ae4937a3dd16d200607c1d13af))

## [0.108.22](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.21...runner-rs-v0.108.22) (2026-06-09)


### Refactoring

* **runner:** share network log drain loop ([#16768](https://github.com/vm0-ai/vm0/issues/16768)) ([a399e57](https://github.com/vm0-ai/vm0/commit/a399e57e7b81b85d93e4adf80fdc73776e326357))
* split mitm matching pattern tests ([#16790](https://github.com/vm0-ai/vm0/issues/16790)) ([3bbac7a](https://github.com/vm0-ai/vm0/commit/3bbac7a5ec5a9cb7f2159ef86a0b82046c5fb648))

## [0.108.21](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.20...runner-rs-v0.108.21) (2026-06-09)


### Bug Fixes

* harden runner setup artifact installs ([#16764](https://github.com/vm0-ai/vm0/issues/16764)) ([a38fb37](https://github.com/vm0-ai/vm0/commit/a38fb37f2439d506f19583a965118dd065825def))

## [0.108.20](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.19...runner-rs-v0.108.20) (2026-06-08)


### Bug Fixes

* harden runner lock and log files ([#16707](https://github.com/vm0-ai/vm0/issues/16707)) ([2c18cef](https://github.com/vm0-ai/vm0/commit/2c18cefaedb8333369a52c17c0f26314aeebb7a0))

## [0.108.19](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.18...runner-rs-v0.108.19) (2026-06-08)


### Bug Fixes

* coordinate run cancellation with idle pool transfer ([#16692](https://github.com/vm0-ai/vm0/issues/16692)) ([e4b432e](https://github.com/vm0-ai/vm0/commit/e4b432ed93981c7dd3bdf6fb6fda889dfe6158d2))

## [0.108.18](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.17...runner-rs-v0.108.18) (2026-06-08)


### Bug Fixes

* **runner:** harden proxy and workspace state files ([#16668](https://github.com/vm0-ai/vm0/issues/16668)) ([7bf9851](https://github.com/vm0-ai/vm0/commit/7bf985137af718d843c086fc74f8c90a3f720783))
* **runner:** serialize service unit installs ([#16539](https://github.com/vm0-ai/vm0/issues/16539)) ([453e1ef](https://github.com/vm0-ai/vm0/commit/453e1ef7ce3a2061de1536e3302e322d6651b0a3))


### Refactoring

* **runner:** split executor test support harness ([#16666](https://github.com/vm0-ai/vm0/issues/16666)) ([965d370](https://github.com/vm0-ai/vm0/commit/965d370563b2491ff9b8341e903c831509847cf1))


### Performance Improvements

* **runner:** avoid dns parser token allocation ([#16664](https://github.com/vm0-ai/vm0/issues/16664)) ([7274f04](https://github.com/vm0-ai/vm0/commit/7274f04f9ed5388bcc0b461209368f22c2326d11))

## [0.108.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.16...runner-rs-v0.108.17) (2026-06-08)


### Bug Fixes

* default redact captured header values ([#16456](https://github.com/vm0-ai/vm0/issues/16456)) ([bad2803](https://github.com/vm0-ai/vm0/commit/bad2803f0accee54b96ccdc4e430e4c2ac4d8b7d))
* harden runner private state files ([#16584](https://github.com/vm0-ai/vm0/issues/16584)) ([d399316](https://github.com/vm0-ai/vm0/commit/d399316c0333015029ccaa6b34545083dc23bbc0))
* **mitm-addon:** bound tcp message retention ([#16648](https://github.com/vm0-ai/vm0/issues/16648)) ([166f3c9](https://github.com/vm0-ai/vm0/commit/166f3c9595ab705bcca3f143248460d72a7633c9))
* serialize runner service unit updates ([#16505](https://github.com/vm0-ai/vm0/issues/16505)) ([1c6a723](https://github.com/vm0-ai/vm0/commit/1c6a723e528dd8166873be7bb5996e3c8b805df8))


### Refactoring

* share mitm authority primitives ([#16642](https://github.com/vm0-ai/vm0/issues/16642)) ([eb3a89c](https://github.com/vm0-ai/vm0/commit/eb3a89c305947d28ce1ac21401e7e07128a8635b))


### Performance Improvements

* **runner:** offload mitm jsonl log writes ([#16601](https://github.com/vm0-ai/vm0/issues/16601)) ([9028927](https://github.com/vm0-ai/vm0/commit/9028927ea210478982b5c40d774b10fcf17cdff4))

## [0.108.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.15...runner-rs-v0.108.16) (2026-06-08)


### Bug Fixes

* handle concatenated zlib bodies ([#16578](https://github.com/vm0-ai/vm0/issues/16578)) ([9c86ca8](https://github.com/vm0-ai/vm0/commit/9c86ca81217c8931abd21179f936a944ef3a7ea4))


### Refactoring

* **runner:** consolidate finalization destroy bookkeeping ([#16554](https://github.com/vm0-ai/vm0/issues/16554)) ([f5fe9e1](https://github.com/vm0-ai/vm0/commit/f5fe9e183dda646494fdce8bb4f7f6d181cb923a))

## [0.108.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.14...runner-rs-v0.108.15) (2026-06-08)


### Bug Fixes

* **runner:** clean workspace holders before unmount retry ([#16523](https://github.com/vm0-ai/vm0/issues/16523)) ([493ec5b](https://github.com/vm0-ai/vm0/commit/493ec5b00fe0771ae208cfa26be9e4a0f041b7ba))

## [0.108.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.13...runner-rs-v0.108.14) (2026-06-08)


### Bug Fixes

* **runner:** preserve systemctl service query errors ([#16508](https://github.com/vm0-ai/vm0/issues/16508)) ([230822c](https://github.com/vm0-ai/vm0/commit/230822cd5c0ef4207379b3a4ef4facc565d6dc8d))

## [0.108.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.12...runner-rs-v0.108.13) (2026-06-07)


### Bug Fixes

* surface service logs journalctl failures ([#16499](https://github.com/vm0-ai/vm0/issues/16499)) ([e564257](https://github.com/vm0-ai/vm0/commit/e56425769e08dd6fc91d385e4db49bf299d0eaed))

## [0.108.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.11...runner-rs-v0.108.12) (2026-06-07)


### Bug Fixes

* make nbd orphan detection lock-aware ([#16388](https://github.com/vm0-ai/vm0/issues/16388)) ([6def1ff](https://github.com/vm0-ai/vm0/commit/6def1ff8df4f45c7154e428d52ae97fbf9a7bf29))
* **mitm-addon:** harden x billing json parser failures ([#16426](https://github.com/vm0-ai/vm0/issues/16426)) ([80c7315](https://github.com/vm0-ai/vm0/commit/80c73157dbbf5fa32922e1241e9f23ab2be5e745))
* prevent runner kill from signaling reused pids ([#16296](https://github.com/vm0-ai/vm0/issues/16296)) ([5b6c483](https://github.com/vm0-ai/vm0/commit/5b6c48301845c9267a7437b63014fcd6d75bc331))
* restore workspace image cache staff switch ([#16410](https://github.com/vm0-ai/vm0/issues/16410)) ([e78f7ad](https://github.com/vm0-ai/vm0/commit/e78f7ad24b2469854f1fdd43cf2422d915715f58))


### Documentation

* **mitm-addon:** document flow metadata contract ([#16423](https://github.com/vm0-ai/vm0/issues/16423)) ([ad9ed9e](https://github.com/vm0-ai/vm0/commit/ad9ed9e1d95748babc06045d7fe78405d5c30701))


### Refactoring

* **runner:** split executor into focused modules ([#16458](https://github.com/vm0-ai/vm0/issues/16458)) ([8ac3405](https://github.com/vm0-ai/vm0/commit/8ac3405705b7bef8a02c59b3b1125715bcbbbd3e))

## [0.108.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.10...runner-rs-v0.108.11) (2026-06-05)


### Bug Fixes

* **mitm-addon:** reject nested encoded unsafe paths ([#16309](https://github.com/vm0-ai/vm0/issues/16309)) ([2533197](https://github.com/vm0-ai/vm0/commit/2533197d15212008784285d19e36167a1335dbd4))
* **runner:** split guest-agent bootstrap env ([#16295](https://github.com/vm0-ai/vm0/issues/16295)) ([b77e7c7](https://github.com/vm0-ai/vm0/commit/b77e7c7c2dfd54e7c97596fee8ca371654e7c7b7))

## [0.108.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.9...runner-rs-v0.108.10) (2026-06-05)

## [0.108.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.8...runner-rs-v0.108.9) (2026-06-05)


### Bug Fixes

* **mitm-addon:** handle tld updater fetch failures ([#16293](https://github.com/vm0-ai/vm0/issues/16293)) ([901cb7e](https://github.com/vm0-ai/vm0/commit/901cb7ed48660db25ec92b05a2da7226b2f5fa30))

## [0.108.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.7...runner-rs-v0.108.8) (2026-06-05)


### Bug Fixes

* move guest runtime files out of tmp ([#16263](https://github.com/vm0-ai/vm0/issues/16263)) ([dc87ac5](https://github.com/vm0-ai/vm0/commit/dc87ac5f4f11ada3306d4061a845de5f592d09b2))

## [0.108.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.6...runner-rs-v0.108.7) (2026-06-05)


### Documentation

* **mitm-addon:** document url syntax helper semantics ([#16250](https://github.com/vm0-ai/vm0/issues/16250)) ([ff6d2cb](https://github.com/vm0-ai/vm0/commit/ff6d2cb3c290b72af2ae28dd0d939775587bf67b))

## [0.108.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.5...runner-rs-v0.108.6) (2026-06-04)


### Bug Fixes

* drain usage flushes during shutdown ([#16181](https://github.com/vm0-ai/vm0/issues/16181)) ([6ba3593](https://github.com/vm0-ai/vm0/commit/6ba35934834c1d82e4ddac85f959a5e5bfdd666c))
* **runner:** document and harden mitm matcher malformed inputs ([#16164](https://github.com/vm0-ai/vm0/issues/16164)) ([b839b76](https://github.com/vm0-ai/vm0/commit/b839b76fc640b668ec5051348b2b325dd562b618))

## [0.108.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.4...runner-rs-v0.108.5) (2026-06-04)


### Performance Improvements

* avoid cloning workspace image cache list entries ([#16177](https://github.com/vm0-ai/vm0/issues/16177)) ([0d190b6](https://github.com/vm0-ai/vm0/commit/0d190b693d21ab16b3d332388d52c1e824eea64e))

## [0.108.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.3...runner-rs-v0.108.4) (2026-06-04)


### Bug Fixes

* bound model websocket retention ([#16182](https://github.com/vm0-ai/vm0/issues/16182)) ([ff822d9](https://github.com/vm0-ai/vm0/commit/ff822d9c222b4b1b7439ef37e6e59753493993a1))
* share X billing IDNA normalization ([#16162](https://github.com/vm0-ai/vm0/issues/16162)) ([16d3d59](https://github.com/vm0-ai/vm0/commit/16d3d592a396f15a7430282941ba5b861b29df46))


### Refactoring

* make firewall auth ownership explicit ([#16161](https://github.com/vm0-ai/vm0/issues/16161)) ([9832ae3](https://github.com/vm0-ai/vm0/commit/9832ae33d48503dc3e705d4c1e33b240fc3b177e))

## [0.108.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.2...runner-rs-v0.108.3) (2026-06-04)


### Bug Fixes

* **runner:** restore codex sessions with rollout filenames ([#16144](https://github.com/vm0-ai/vm0/issues/16144)) ([1adf687](https://github.com/vm0-ai/vm0/commit/1adf687fcfcf39c06a11e3b995918f8c46e8f611))

## [0.108.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.1...runner-rs-v0.108.2) (2026-06-04)


### Bug Fixes

* **mitm-addon:** guard content length response size fallback ([#16104](https://github.com/vm0-ai/vm0/issues/16104)) ([95d44d6](https://github.com/vm0-ai/vm0/commit/95d44d6801868530954bc262497525e4421e370e))
* reject invalid registry vm entries before auth ([#16108](https://github.com/vm0-ai/vm0/issues/16108)) ([238ffc2](https://github.com/vm0-ai/vm0/commit/238ffc239283aaf1bdeac808bbbdfbe9abda3f67))


### Refactoring

* clarify idle pool lifecycle state ([#16135](https://github.com/vm0-ai/vm0/issues/16135)) ([a5e63e6](https://github.com/vm0-ai/vm0/commit/a5e63e6b5e19c6ac99f49549d42d2238dcab06d6))

## [0.108.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.0...runner-rs-v0.108.1) (2026-06-04)


### Bug Fixes

* **mitm-addon:** bound X includes usage categories ([#16100](https://github.com/vm0-ai/vm0/issues/16100)) ([a5dcb25](https://github.com/vm0-ai/vm0/commit/a5dcb25c2ce73842e928c7b241d1e35798bb9caa))
* tolerate invalid response content length ([#16088](https://github.com/vm0-ai/vm0/issues/16088)) ([6ab7225](https://github.com/vm0-ai/vm0/commit/6ab72256f2d2dee06d31423f0db2e81ab03377af))


### Documentation

* **mitm-addon:** document anthropic json usage extractor ([#16085](https://github.com/vm0-ai/vm0/issues/16085)) ([59cb7b4](https://github.com/vm0-ai/vm0/commit/59cb7b45f0a2ccf36b78a925e5df24de7fa39bc3))

## [0.108.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.10...runner-rs-v0.108.0) (2026-06-04)


### Features

* add workspace image cache inspection ([#15941](https://github.com/vm0-ai/vm0/issues/15941)) ([7cf129c](https://github.com/vm0-ai/vm0/commit/7cf129c0193c716f2a3d20eb9b12ea1d3937be4e))


### Bug Fixes

* materialize cached artifact mount roots ([#16083](https://github.com/vm0-ai/vm0/issues/16083)) ([d6a4ed3](https://github.com/vm0-ai/vm0/commit/d6a4ed307b5c4aeac8edb400aec1f65369d5f781))
* **mitm-addon:** avoid quadratic sse line scans ([#16082](https://github.com/vm0-ai/vm0/issues/16082)) ([1230752](https://github.com/vm0-ai/vm0/commit/1230752fddb62c60f26554bcdf0a47de1ae48e20))


### Refactoring

* clarify local queue job lookup ([#16074](https://github.com/vm0-ai/vm0/issues/16074)) ([2483cd4](https://github.com/vm0-ai/vm0/commit/2483cd44526cbe74363dd054f0bc121c89966558))

## [0.107.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.9...runner-rs-v0.107.10) (2026-06-04)


### Bug Fixes

* include byok model usage in rankings ([#15979](https://github.com/vm0-ai/vm0/issues/15979)) ([09e8919](https://github.com/vm0-ai/vm0/commit/09e8919abf68a3c5d2662ff061b7892a54d29c29))

## [0.107.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.8...runner-rs-v0.107.9) (2026-06-03)


### Bug Fixes

* cache workspace images only on destroy ([#15974](https://github.com/vm0-ai/vm0/issues/15974)) ([8423fd5](https://github.com/vm0-ai/vm0/commit/8423fd583bc96329b04da13b66be6975e932de91))
* guard malformed firewall metadata in usage paths ([#16038](https://github.com/vm0-ai/vm0/issues/16038)) ([65bcc9b](https://github.com/vm0-ai/vm0/commit/65bcc9b661fd2d42d4466c1006875e5526b9bf32))
* **mitm-addon:** require original url for connector usage ([#16023](https://github.com/vm0-ai/vm0/issues/16023)) ([e99e382](https://github.com/vm0-ai/vm0/commit/e99e3820d4d3b6fd9b0418e2036350fab538876d))


### Performance Improvements

* avoid X query parsing on billable responses ([#16028](https://github.com/vm0-ai/vm0/issues/16028)) ([52a166b](https://github.com/vm0-ai/vm0/commit/52a166bf511fcc80926152458040fa07fb3ecf3a))

## [0.107.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.7...runner-rs-v0.107.8) (2026-06-03)

## [0.107.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.6...runner-rs-v0.107.7) (2026-06-03)


### Bug Fixes

* count final x ndjson stream line ([#16000](https://github.com/vm0-ai/vm0/issues/16000)) ([71c9bab](https://github.com/vm0-ai/vm0/commit/71c9bab4c6654e0133363645204236ce375f681a))
* **mitm-addon:** sanitize proxy log url fields ([#16002](https://github.com/vm0-ai/vm0/issues/16002)) ([fb046d4](https://github.com/vm0-ai/vm0/commit/fb046d436ec69dfeae9f82107433c6cb18229237))

## [0.107.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.5...runner-rs-v0.107.6) (2026-06-03)


### Bug Fixes

* preserve missing auto memory artifact checkpoints ([#15964](https://github.com/vm0-ai/vm0/issues/15964)) ([020dc4a](https://github.com/vm0-ai/vm0/commit/020dc4a62cd90237639396419ccee1ba85d7d4d0))

## [0.107.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.4...runner-rs-v0.107.5) (2026-06-03)


### Bug Fixes

* **mitm-addon:** bound usage webhook delivery queue ([#15959](https://github.com/vm0-ai/vm0/issues/15959)) ([dc36c62](https://github.com/vm0-ai/vm0/commit/dc36c62f4ad4f22354f8ec21811c97993d11408d))

## [0.107.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.3...runner-rs-v0.107.4) (2026-06-03)

## [0.107.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.2...runner-rs-v0.107.3) (2026-06-03)


### Bug Fixes

* cap firewall auth response reads ([#15942](https://github.com/vm0-ai/vm0/issues/15942)) ([1177be1](https://github.com/vm0-ai/vm0/commit/1177be1f5ad0ebc858491c0ae41f9ef7a167040c))


### Refactoring

* split runner spawn job phases ([#15943](https://github.com/vm0-ai/vm0/issues/15943)) ([a7d5290](https://github.com/vm0-ai/vm0/commit/a7d52907feb13fc1c6adf1d7981568aaedd30021))

## [0.107.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.1...runner-rs-v0.107.2) (2026-06-02)


### Refactoring

* extract local queue protocol from provider ([#15913](https://github.com/vm0-ai/vm0/issues/15913)) ([abd8a3d](https://github.com/vm0-ai/vm0/commit/abd8a3da10ab5a473ff753046b2bc8b4f9acfc15))

## [0.107.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.0...runner-rs-v0.107.1) (2026-06-02)


### Bug Fixes

* block private auth.base rewrite destinations ([#15889](https://github.com/vm0-ai/vm0/issues/15889)) ([efc6115](https://github.com/vm0-ai/vm0/commit/efc6115bb1501df09b299f690f6d3ecf68387ff7))


### Refactoring

* split compiled firewall matcher tests ([#15885](https://github.com/vm0-ai/vm0/issues/15885)) ([bdf3939](https://github.com/vm0-ai/vm0/commit/bdf3939956c8a378dde9b11080a5be79feb55fcd))

## [0.107.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.106.7...runner-rs-v0.107.0) (2026-06-02)


### Features

* add session workspace image cache rollout ([#15780](https://github.com/vm0-ai/vm0/issues/15780)) ([3fb331b](https://github.com/vm0-ai/vm0/commit/3fb331ba6457c9d3247e0eac03f2629ab5102d89))


### Documentation

* **runner:** correct storage cache hash guidance ([#15887](https://github.com/vm0-ai/vm0/issues/15887)) ([57b4b5d](https://github.com/vm0-ai/vm0/commit/57b4b5da234afaca78aec909463bfb9d28dc8b1b))

## [0.106.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.106.6...runner-rs-v0.106.7) (2026-06-02)


### Bug Fixes

* handle concatenated zlib stream members ([#15873](https://github.com/vm0-ai/vm0/issues/15873)) ([1d40f14](https://github.com/vm0-ai/vm0/commit/1d40f14f8bb1f10b1305ce1f3e418352cc0a671b))

## [0.106.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.106.5...runner-rs-v0.106.6) (2026-06-02)


### Bug Fixes

* require https for auth base rewrites ([#15858](https://github.com/vm0-ai/vm0/issues/15858)) ([22d5d41](https://github.com/vm0-ai/vm0/commit/22d5d41b26b19da9f723974a6837822df06a0fe0))

## [0.106.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.106.4...runner-rs-v0.106.5) (2026-06-02)


### Bug Fixes

* add guest-agent abnormal exit diagnostics ([#15829](https://github.com/vm0-ai/vm0/issues/15829)) ([6803f8f](https://github.com/vm0-ai/vm0/commit/6803f8ff73c6d845ea96a80442fb4e08f5562a5a))


### Documentation

* clarify browser ua passthrough semantics ([#15848](https://github.com/vm0-ai/vm0/issues/15848)) ([c0c6fa1](https://github.com/vm0-ai/vm0/commit/c0c6fa1b7ff581e7c9f55fd1bd6cdf5fd2232e1a))


### Refactoring

* consolidate compiled path traversal ([#15845](https://github.com/vm0-ai/vm0/issues/15845)) ([5604e93](https://github.com/vm0-ai/vm0/commit/5604e93addf767b1f475d8b921f6903ae55898e6))
* **mitm-addon:** name firewall matcher decision state ([#15847](https://github.com/vm0-ai/vm0/issues/15847)) ([b8c8982](https://github.com/vm0-ai/vm0/commit/b8c8982680725267f640a539773d4fdd6051d2e8))

## [0.106.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.106.3...runner-rs-v0.106.4) (2026-06-02)


### Bug Fixes

* bound streaming usage decompression output ([#15831](https://github.com/vm0-ai/vm0/issues/15831)) ([25128d0](https://github.com/vm0-ai/vm0/commit/25128d05e9407c782ffe727f30d0dd97f1586aa1))

## [0.106.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.106.2...runner-rs-v0.106.3) (2026-06-02)


### Refactoring

* **runner:** centralize pre-claim admission rollback ([#15821](https://github.com/vm0-ai/vm0/issues/15821)) ([8a6936f](https://github.com/vm0-ai/vm0/commit/8a6936f7207a7d55d5263332ca2ac3af610ec020))

## [0.106.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.106.1...runner-rs-v0.106.2) (2026-06-02)

## [0.106.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.106.0...runner-rs-v0.106.1) (2026-06-02)


### Bug Fixes

* **runner:** preserve streamed system logs separately ([#15797](https://github.com/vm0-ai/vm0/issues/15797)) ([dd3ce60](https://github.com/vm0-ai/vm0/commit/dd3ce6077557911e505825954858e2b48ed31567))

## [0.106.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.15...runner-rs-v0.106.0) (2026-06-01)


### Features

* add canonical workspace drive foundation ([#15688](https://github.com/vm0-ai/vm0/issues/15688)) ([593460a](https://github.com/vm0-ai/vm0/commit/593460ab818768ae75d1fd658a7211a2120a956b))


### Bug Fixes

* block encoded backslash firewall paths ([#15738](https://github.com/vm0-ai/vm0/issues/15738)) ([957e298](https://github.com/vm0-ai/vm0/commit/957e29807717b6e40215e3f1aab191ca67a3b42a))
* classify x dm deep links as with-url posts ([#15757](https://github.com/vm0-ai/vm0/issues/15757)) ([d5f85f1](https://github.com/vm0-ai/vm0/commit/d5f85f1e03944f4e3a139d3f10ae3441d9cb5aea))
* **mitm-addon:** bill x counts from total tweet count ([#15756](https://github.com/vm0-ai/vm0/issues/15756)) ([ae3b32d](https://github.com/vm0-ai/vm0/commit/ae3b32dbcdad2afa23f701c1c7965b6e9afec308))
* **mitm-addon:** bound request capture decoding ([#15729](https://github.com/vm0-ai/vm0/issues/15729)) ([13392a0](https://github.com/vm0-ai/vm0/commit/13392a0858b0208a5081d5560afe2b0858137eb9))
* **mitm-addon:** bound x billing request body decoding ([#15731](https://github.com/vm0-ai/vm0/issues/15731)) ([ac1b5b9](https://github.com/vm0-ai/vm0/commit/ac1b5b9581318ba4b4ab411af726fba3991d981b))
* **mitm-addon:** keep websocket usage flows tracked ([#15722](https://github.com/vm0-ai/vm0/issues/15722)) ([9605293](https://github.com/vm0-ai/vm0/commit/9605293c0e0f32961ec40a42ed916039a4777c10))
* **mitm-addon:** stop logging webhook payload bodies ([#15717](https://github.com/vm0-ai/vm0/issues/15717)) ([75b73a6](https://github.com/vm0-ai/vm0/commit/75b73a617f07c8c905c34dc0cd689127b3061c2d))
* **runner:** skip unclaimed jobs during soft drain ([#15745](https://github.com/vm0-ai/vm0/issues/15745)) ([b12aea2](https://github.com/vm0-ai/vm0/commit/b12aea21c7ca019089c03609ae44236552023dc1))
* sanitize captured network log headers ([#15758](https://github.com/vm0-ai/vm0/issues/15758)) ([da717a5](https://github.com/vm0-ai/vm0/commit/da717a582e20826834fd9169cf2fcd627c6cb4a0))


### Documentation

* document mitm usage flush lifecycle ([#15744](https://github.com/vm0-ai/vm0/issues/15744)) ([f0fdc84](https://github.com/vm0-ai/vm0/commit/f0fdc842bcc8673578f2bbc4b98c64b765b6efbc))
* **mitm-addon:** document event-less sse capture ([#15733](https://github.com/vm0-ai/vm0/issues/15733)) ([8e56540](https://github.com/vm0-ai/vm0/commit/8e56540281db516a2e170d1eec44d00564235ff9))


### Refactoring

* **mitm-addon:** centralize x body refinement buckets ([#15706](https://github.com/vm0-ai/vm0/issues/15706)) ([44a45b7](https://github.com/vm0-ai/vm0/commit/44a45b7a1dbc2c6bfdf3594b5d0a9873afdd286e))
* **mitm-addon:** unify firewall auth cache payload shape ([#15725](https://github.com/vm0-ai/vm0/issues/15725)) ([0d40dc4](https://github.com/vm0-ai/vm0/commit/0d40dc44230517678cd4308e0d2f0a95c4e63a01))

## [0.105.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.14...runner-rs-v0.105.15) (2026-06-01)


### Bug Fixes

* **mitm-addon:** require keyword auth options ([#15694](https://github.com/vm0-ai/vm0/issues/15694)) ([d97034d](https://github.com/vm0-ai/vm0/commit/d97034d35bc870c84cc22815dc87bde27ec6b88e))
* **mitm-addon:** scope registry cache state by path ([#15683](https://github.com/vm0-ai/vm0/issues/15683)) ([157164b](https://github.com/vm0-ai/vm0/commit/157164b7c65e68d7de28fa368c3d03bfc277f8c6))
* **mitm-addon:** validate firewall auth success responses ([#15695](https://github.com/vm0-ai/vm0/issues/15695)) ([0584be6](https://github.com/vm0-ai/vm0/commit/0584be6eb1f7b21efef75005c5341a76819b85fb))

## [0.105.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.13...runner-rs-v0.105.14) (2026-06-01)


### Bug Fixes

* **mitm-addon:** validate platform api urls ([#15630](https://github.com/vm0-ai/vm0/issues/15630)) ([5161d39](https://github.com/vm0-ai/vm0/commit/5161d399a919e2071149e6d05b7314716367c1e5))


### Refactoring

* deduplicate mitm matcher segments ([#15622](https://github.com/vm0-ai/vm0/issues/15622)) ([5d78a1b](https://github.com/vm0-ai/vm0/commit/5d78a1b941f704ebced670640ceeb3943a51ffc6))
* hardcode runner working directory ([#15606](https://github.com/vm0-ai/vm0/issues/15606)) ([132296d](https://github.com/vm0-ai/vm0/commit/132296da082953e4cdeb796c8a4432e07cd38c20))
* retire legacy firewall matcher ([#15291](https://github.com/vm0-ai/vm0/issues/15291)) ([a288950](https://github.com/vm0-ai/vm0/commit/a2889506f42f55331238d928a64e0c85b69e9ff0))

## [0.105.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.12...runner-rs-v0.105.13) (2026-06-01)


### Bug Fixes

* skip firewall auth mutation for browser requests ([#15593](https://github.com/vm0-ai/vm0/issues/15593)) ([529f593](https://github.com/vm0-ai/vm0/commit/529f5934d40adb5ebb2b591504f2237dd8320594))


### Performance Improvements

* skip no-op json observation clears ([#15584](https://github.com/vm0-ai/vm0/issues/15584)) ([79578d2](https://github.com/vm0-ai/vm0/commit/79578d25d32391b0c92f62abf23365666e024d08))

## [0.105.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.11...runner-rs-v0.105.12) (2026-05-31)


### Refactoring

* clarify x parser internals ([#15580](https://github.com/vm0-ai/vm0/issues/15580)) ([8514cef](https://github.com/vm0-ai/vm0/commit/8514cef79680410406c207ced7ec83fe8aac536e))


### Performance Improvements

* **mitm-addon:** avoid json loads for string decoding ([#15581](https://github.com/vm0-ai/vm0/issues/15581)) ([f69794a](https://github.com/vm0-ai/vm0/commit/f69794a6dbaf857103fdea5aaf47b55f56cc3faa))

## [0.105.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.10...runner-rs-v0.105.11) (2026-05-31)


### Bug Fixes

* **mitm-addon:** distinguish log failure diagnostics ([#15572](https://github.com/vm0-ai/vm0/issues/15572)) ([75bbdf0](https://github.com/vm0-ai/vm0/commit/75bbdf0f5fe5292af4c68aa1c9eada089fb9725b))
* **mitm-addon:** normalize firewall metadata logs ([#15566](https://github.com/vm0-ai/vm0/issues/15566)) ([df40acb](https://github.com/vm0-ai/vm0/commit/df40acba0a49f2d8db42ca343810536671b12577))


### Refactoring

* deduplicate x response field extraction ([#15573](https://github.com/vm0-ai/vm0/issues/15573)) ([3bcedac](https://github.com/vm0-ai/vm0/commit/3bcedacee5f18292d9cf3feb3f5f0920c55fb18a))

## [0.105.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.9...runner-rs-v0.105.10) (2026-05-31)


### Bug Fixes

* block unsafe firewall dot-segment paths ([#15550](https://github.com/vm0-ai/vm0/issues/15550)) ([d19c076](https://github.com/vm0-ai/vm0/commit/d19c076ef187e86a067492d15c09fb54957be572))
* redact query strings from mitm logs ([#15549](https://github.com/vm0-ai/vm0/issues/15549)) ([22a5a69](https://github.com/vm0-ai/vm0/commit/22a5a69aca62082b10b705e61c34336db5e8c1f4))
* skip non-billable connector response parsers ([#15543](https://github.com/vm0-ai/vm0/issues/15543)) ([daa2732](https://github.com/vm0-ai/vm0/commit/daa2732c913bccf630e1a80ec2eaa5212fedc076))


### Refactoring

* **mitm-addon:** store HTTP timing on flows ([#15547](https://github.com/vm0-ai/vm0/issues/15547)) ([3bf5cb0](https://github.com/vm0-ai/vm0/commit/3bf5cb00a42f959b454ef9724fac6d31f3a6794c))

## [0.105.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.8...runner-rs-v0.105.9) (2026-05-31)


### Bug Fixes

* add firewall auth failure reason ([#15386](https://github.com/vm0-ai/vm0/issues/15386)) ([6c7e09c](https://github.com/vm0-ai/vm0/commit/6c7e09c76e9a184478fddbcb1a9ceefdc94bb3f2))

## [0.105.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.7...runner-rs-v0.105.8) (2026-05-30)


### Documentation

* document connector response parser lifecycle ([#15444](https://github.com/vm0-ai/vm0/issues/15444)) ([49a9cfe](https://github.com/vm0-ai/vm0/commit/49a9cfe723bbf54ece885c0dbaa7d3ca24a2b337))

## [0.105.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.6...runner-rs-v0.105.7) (2026-05-29)


### Bug Fixes

* clarify mitm body capture invariant error ([#15429](https://github.com/vm0-ai/vm0/issues/15429)) ([c563be6](https://github.com/vm0-ai/vm0/commit/c563be6669217266490bbf1008a89ba6b3364fe0))


### Documentation

* document mitm registry cache fallback ([#15428](https://github.com/vm0-ai/vm0/issues/15428)) ([04c23a9](https://github.com/vm0-ai/vm0/commit/04c23a9c6cfa02f5d379eaebc4c62e0e6588d2bf))


### Refactoring

* move connector response parser dispatch ([#15431](https://github.com/vm0-ai/vm0/issues/15431)) ([f0411d6](https://github.com/vm0-ai/vm0/commit/f0411d65034678e8acc6e8db22d16dba1d1df55f))

## [0.105.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.5...runner-rs-v0.105.6) (2026-05-29)


### Refactoring

* resolve connector access from selected auth method ([#15355](https://github.com/vm0-ai/vm0/issues/15355)) ([1c24b75](https://github.com/vm0-ai/vm0/commit/1c24b7553c4f86cbd70082ed454efb4853ac7cb2))

## [0.105.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.4...runner-rs-v0.105.5) (2026-05-29)

## [0.105.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.3...runner-rs-v0.105.4) (2026-05-29)


### Documentation

* document mitm pending helper counts ([#15349](https://github.com/vm0-ai/vm0/issues/15349)) ([b63c75f](https://github.com/vm0-ai/vm0/commit/b63c75fa8272523fa62db7702d581730c2ee5beb))


### Refactoring

* group runner start state by lifecycle ([#15362](https://github.com/vm0-ai/vm0/issues/15362)) ([b327825](https://github.com/vm0-ai/vm0/commit/b3278258f35bc74115bde10a249280bfbdd2ba03))
* **runner:** centralize per-run log patterns ([#15363](https://github.com/vm0-ai/vm0/issues/15363)) ([609f08a](https://github.com/vm0-ai/vm0/commit/609f08a487b2807f9aa5b2a4643debb67d973ac5))


### Performance Improvements

* **mitm-addon:** transfer usage webhook payload ownership ([#15351](https://github.com/vm0-ai/vm0/issues/15351)) ([d5738ee](https://github.com/vm0-ai/vm0/commit/d5738ee93df402482287171dda7377276cfb5714))

## [0.105.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.2...runner-rs-v0.105.3) (2026-05-28)

## [0.105.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.1...runner-rs-v0.105.2) (2026-05-28)

## [0.105.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.0...runner-rs-v0.105.1) (2026-05-28)


### Refactoring

* make runner http client config explicit ([#15299](https://github.com/vm0-ai/vm0/issues/15299)) ([28c9d4f](https://github.com/vm0-ai/vm0/commit/28c9d4f7a3ee8be6e23291ec8d4abc28545b4036))

## [0.105.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.17...runner-rs-v0.105.0) (2026-05-28)


### Features

* add generation-aware runner session affinity ([#15246](https://github.com/vm0-ai/vm0/issues/15246)) ([141473b](https://github.com/vm0-ai/vm0/commit/141473b3e36af6392d0fd8fc6734ee223e6729e4))


### Bug Fixes

* log malformed data-only anthropic sse events ([#15287](https://github.com/vm0-ai/vm0/issues/15287)) ([3960fd4](https://github.com/vm0-ai/vm0/commit/3960fd4495636b06c503e41d947b2fa3843beea0))


### Refactoring

* remove orphan active run count duplication ([#15259](https://github.com/vm0-ai/vm0/issues/15259)) ([4908240](https://github.com/vm0-ai/vm0/commit/4908240c5edb406b90c69305d3229942f2f73ee7))

## [0.104.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.16...runner-rs-v0.104.17) (2026-05-28)


### Bug Fixes

* prefer specific firewall path matches ([#15223](https://github.com/vm0-ai/vm0/issues/15223)) ([24c6d2e](https://github.com/vm0-ai/vm0/commit/24c6d2ed4ddcfab5f6bfd4e41329d672e45699d7))

## [0.104.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.15...runner-rs-v0.104.16) (2026-05-28)

## [0.104.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.14...runner-rs-v0.104.15) (2026-05-27)


### Refactoring

* centralize mitm flow metadata keys ([#15171](https://github.com/vm0-ai/vm0/issues/15171)) ([b378ac8](https://github.com/vm0-ai/vm0/commit/b378ac800ecd70a09fc7d8d27cd2b0c1fee1cc6f))
* unify mitm network log target handling ([#15174](https://github.com/vm0-ai/vm0/issues/15174)) ([2316d5d](https://github.com/vm0-ai/vm0/commit/2316d5ddbb4ec46e8fbd07df85e3b472266c416e))

## [0.104.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.13...runner-rs-v0.104.14) (2026-05-27)

## [0.104.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.12...runner-rs-v0.104.13) (2026-05-27)

## [0.104.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.11...runner-rs-v0.104.12) (2026-05-27)


### Bug Fixes

* validate claude tool list entries ([#15092](https://github.com/vm0-ai/vm0/issues/15092)) ([7f48d58](https://github.com/vm0-ai/vm0/commit/7f48d5836cd891200f3b0a4159aad9d0ad59726f))

## [0.104.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.10...runner-rs-v0.104.11) (2026-05-27)


### Bug Fixes

* classify invalid billable auth expiry ([#15088](https://github.com/vm0-ai/vm0/issues/15088)) ([f08b100](https://github.com/vm0-ai/vm0/commit/f08b100859047b8cb5670fd97e12924fd9c42302))
* harden runner claim lifecycle ([#15091](https://github.com/vm0-ai/vm0/issues/15091)) ([6de4d34](https://github.com/vm0-ai/vm0/commit/6de4d340fd951702c7e4dc2b8149f61c66ad27a6))

## [0.104.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.9...runner-rs-v0.104.10) (2026-05-27)


### Bug Fixes

* **mitm-addon:** bound auth base forwarded responses ([#15074](https://github.com/vm0-ai/vm0/issues/15074)) ([a97163e](https://github.com/vm0-ai/vm0/commit/a97163e40262d65820a2183f86fd0aa0e8a5b8ae))

## [0.104.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.8...runner-rs-v0.104.9) (2026-05-27)


### Documentation

* **mitm-addon:** explain usage zero-clobber guard ([#15067](https://github.com/vm0-ai/vm0/issues/15067)) ([6acacff](https://github.com/vm0-ai/vm0/commit/6acacff24db92eea0a2d356e69bca7f8f54bc78f))


### Refactoring

* remove sse usage parser wrapper ([#15056](https://github.com/vm0-ai/vm0/issues/15056)) ([b1fde4a](https://github.com/vm0-ai/vm0/commit/b1fde4ad5bb942576ef71061ccc9df542368dc36))
* split mitm request handler tests ([#15068](https://github.com/vm0-ai/vm0/issues/15068)) ([f428c91](https://github.com/vm0-ai/vm0/commit/f428c910a6d918c3fbc2c8914291ccb22fcbe4bb))

## [0.104.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.7...runner-rs-v0.104.8) (2026-05-27)


### Documentation

* **mitm-addon:** document model provider usage gates ([#15054](https://github.com/vm0-ai/vm0/issues/15054)) ([aebc623](https://github.com/vm0-ai/vm0/commit/aebc62312ce714c5923515697e63af66ceb57c89))

## [0.104.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.6...runner-rs-v0.104.7) (2026-05-26)


### Bug Fixes

* validate model provider env placeholders in runner ([#15002](https://github.com/vm0-ai/vm0/issues/15002)) ([44177d8](https://github.com/vm0-ai/vm0/commit/44177d8d154bfa727ee9500a9dc1d221ff21da29))

## [0.104.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.5...runner-rs-v0.104.6) (2026-05-26)


### Refactoring

* **runner:** model local submit queue entry ([#14988](https://github.com/vm0-ai/vm0/issues/14988)) ([37b90e6](https://github.com/vm0-ai/vm0/commit/37b90e60b63352cb3a13ca7dedc5ec2a841c928a))

## [0.104.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.4...runner-rs-v0.104.5) (2026-05-26)


### Refactoring

* **mitm-addon:** centralize usage idempotency helpers ([#14968](https://github.com/vm0-ai/vm0/issues/14968)) ([f804857](https://github.com/vm0-ai/vm0/commit/f80485717a148d6ee3bd462d2f02013f9d832cb0))

## [0.104.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.3...runner-rs-v0.104.4) (2026-05-26)


### Documentation

* **mitm-addon:** document usage buffer contract ([#14956](https://github.com/vm0-ai/vm0/issues/14956)) ([c4b3a27](https://github.com/vm0-ai/vm0/commit/c4b3a27a3bcd23119be444cf0c20020e9d150bbf))

## [0.104.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.2...runner-rs-v0.104.3) (2026-05-26)


### Refactoring

* **runner:** deduplicate completion retry call ([#14946](https://github.com/vm0-ai/vm0/issues/14946)) ([cdb3989](https://github.com/vm0-ai/vm0/commit/cdb398987be187a306161acdf39868ff96dd658a))
* **runner:** split local submit flow ([#14940](https://github.com/vm0-ai/vm0/issues/14940)) ([9d973ba](https://github.com/vm0-ai/vm0/commit/9d973baa76c8a03545a8eb86ddf883846e773b5e))

## [0.104.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.1...runner-rs-v0.104.2) (2026-05-26)


### Bug Fixes

* improve usage buffer flush shutdown ([#14918](https://github.com/vm0-ai/vm0/issues/14918)) ([5bed24f](https://github.com/vm0-ai/vm0/commit/5bed24f62322eeb37282b97478d2e16cf0062f91))

## [0.104.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.0...runner-rs-v0.104.1) (2026-05-26)


### Performance Improvements

* **runner:** snapshot usage pending on flush request ([#14896](https://github.com/vm0-ai/vm0/issues/14896)) ([13044ce](https://github.com/vm0-ai/vm0/commit/13044ced03ccf4819932f09092d3efaa86387b25))

## [0.104.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.22...runner-rs-v0.104.0) (2026-05-25)


### Features

* buffer usage-event webhook uploads ([#14855](https://github.com/vm0-ai/vm0/issues/14855)) ([4fa3981](https://github.com/vm0-ai/vm0/commit/4fa3981fd4e138f4ff321cb414181569c36d43cc))


### Bug Fixes

* move guest exec exit warnings to callers ([#14889](https://github.com/vm0-ai/vm0/issues/14889)) ([c58dc82](https://github.com/vm0-ai/vm0/commit/c58dc827e11a9a5d6dc70c8e2d07a588983da9d7))

## [0.103.22](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.21...runner-rs-v0.103.22) (2026-05-25)

## [0.103.21](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.20...runner-rs-v0.103.21) (2026-05-25)

## [0.103.20](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.19...runner-rs-v0.103.20) (2026-05-25)

## [0.103.19](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.18...runner-rs-v0.103.19) (2026-05-25)

## [0.103.18](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.17...runner-rs-v0.103.18) (2026-05-25)


### Refactoring

* **mitm-addon:** centralize authority validation error context ([#14751](https://github.com/vm0-ai/vm0/issues/14751)) ([63e8d3c](https://github.com/vm0-ai/vm0/commit/63e8d3c0636eb6bc5d156f838d2276f9c2d1a727))
* share executor sandbox run finalization ([#14787](https://github.com/vm0-ai/vm0/issues/14787)) ([f63d971](https://github.com/vm0-ai/vm0/commit/f63d971ff6957de3db3e7695f6e51036b5d4c6a0))

## [0.103.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.16...runner-rs-v0.103.17) (2026-05-25)


### Bug Fixes

* **mitm-addon:** use streamed byte count for response size ([#14752](https://github.com/vm0-ai/vm0/issues/14752)) ([5e02546](https://github.com/vm0-ai/vm0/commit/5e025467b59de2e6ef4f2ff7b07e31f3cdea4e13))


### Refactoring

* **mitm-addon:** structure firewall allow results ([#14772](https://github.com/vm0-ai/vm0/issues/14772)) ([4edcabc](https://github.com/vm0-ai/vm0/commit/4edcabc3d6d124ef627143ea8a767cf444a4f825))

## [0.103.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.15...runner-rs-v0.103.16) (2026-05-24)

## [0.103.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.14...runner-rs-v0.103.15) (2026-05-24)


### Bug Fixes

* guard mitm addon firewall auth error envelope ([#14657](https://github.com/vm0-ai/vm0/issues/14657)) ([df6964e](https://github.com/vm0-ai/vm0/commit/df6964e5fe99c68d69c7d5f8615693b7ee936dbe))

## [0.103.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.13...runner-rs-v0.103.14) (2026-05-24)


### Bug Fixes

* **mitm-addon:** filter empty x fallback id segments ([#14658](https://github.com/vm0-ai/vm0/issues/14658)) ([db9cbee](https://github.com/vm0-ai/vm0/commit/db9cbee1fb8e97b4e6a587291564aeeb33acf3ff))

## [0.103.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.12...runner-rs-v0.103.13) (2026-05-24)


### Bug Fixes

* **mitm-addon:** capture terminal OpenAI Responses usage ([#14598](https://github.com/vm0-ai/vm0/issues/14598)) ([d1939ea](https://github.com/vm0-ai/vm0/commit/d1939ea546adc4bb2ee6d98c01adec5925f93cce))

## [0.103.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.11...runner-rs-v0.103.12) (2026-05-24)

## [0.103.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.10...runner-rs-v0.103.11) (2026-05-23)


### Refactoring

* **mitm-addon:** extract auth base forwarder test helper ([#14603](https://github.com/vm0-ai/vm0/issues/14603)) ([337d456](https://github.com/vm0-ai/vm0/commit/337d4566d366bc05e0a5bcf46b45f1b8698b7f57))
* **mitm-addon:** split handler tests by subsystem ([#14597](https://github.com/vm0-ai/vm0/issues/14597)) ([ae64e4c](https://github.com/vm0-ai/vm0/commit/ae64e4c4aae2ce5001aa398503fb797c74f13c0c))

## [0.103.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.9...runner-rs-v0.103.10) (2026-05-23)

## [0.103.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.8...runner-rs-v0.103.9) (2026-05-23)


### Bug Fixes

* **mitm-addon:** preserve auth base request headers ([#14508](https://github.com/vm0-ai/vm0/issues/14508)) ([c251138](https://github.com/vm0-ai/vm0/commit/c2511386377c75d252bbb6cf62bb3968433fad22))
* preserve openai websocket usage across frames ([#14554](https://github.com/vm0-ai/vm0/issues/14554)) ([784465b](https://github.com/vm0-ai/vm0/commit/784465b75fce7c37e541d8b05cdcb79cb05f84b4))


### Refactoring

* **mitm-addon:** consolidate firewall failure responses ([#14563](https://github.com/vm0-ai/vm0/issues/14563)) ([4eabba6](https://github.com/vm0-ai/vm0/commit/4eabba60e61fe7ed3b19f4bdd256a517a4aa08fe))
* **mitm-addon:** simplify response parser state ([#14559](https://github.com/vm0-ai/vm0/issues/14559)) ([9b70539](https://github.com/vm0-ai/vm0/commit/9b70539d8f503ade2919ba79b86124a53147148c))

## [0.103.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.7...runner-rs-v0.103.8) (2026-05-22)


### Bug Fixes

* cancel guest process before runner cleanup ([#14537](https://github.com/vm0-ai/vm0/issues/14537)) ([55b3ab7](https://github.com/vm0-ai/vm0/commit/55b3ab78eb113e7665c6d097f5e2fdbef8b30193))
* **mitm-addon:** prevent rewrite query shadowing ([#14544](https://github.com/vm0-ai/vm0/issues/14544)) ([fb1cae4](https://github.com/vm0-ai/vm0/commit/fb1cae4c9a77e7df38cd7759ee7a8d9e59aaad53))


### Documentation

* **mitm-addon:** fix firewall fixture reference ([#14549](https://github.com/vm0-ai/vm0/issues/14549)) ([9edd0cd](https://github.com/vm0-ai/vm0/commit/9edd0cd55918a172f05fa88ee3c9bf985e6ddf13))


### Refactoring

* make runner completion auth lifecycle explicit ([#14522](https://github.com/vm0-ai/vm0/issues/14522)) ([cd2a0dd](https://github.com/vm0-ai/vm0/commit/cd2a0dd0608ceb21f0ad3c2df7f269bbb23040ee))

## [0.103.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.6...runner-rs-v0.103.7) (2026-05-22)


### Bug Fixes

* **mitm-addon:** emit utc log timestamps ([#14498](https://github.com/vm0-ai/vm0/issues/14498)) ([b2ba913](https://github.com/vm0-ai/vm0/commit/b2ba9136ebf2568332d6d8493992e094abfb76a5))
* **mitm-addon:** preserve rewritten response headers ([#14491](https://github.com/vm0-ai/vm0/issues/14491)) ([b724e48](https://github.com/vm0-ai/vm0/commit/b724e48961b94c3fa3d29a1888e46d8f355bb44f))


### Refactoring

* rename mitm usage counter helpers ([#14493](https://github.com/vm0-ai/vm0/issues/14493)) ([ba45a51](https://github.com/vm0-ai/vm0/commit/ba45a51b8310ed65d144d95e9bd771c801f66c19))

## [0.103.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.5...runner-rs-v0.103.6) (2026-05-21)

## [0.103.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.4...runner-rs-v0.103.5) (2026-05-21)

## [0.103.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.3...runner-rs-v0.103.4) (2026-05-21)


### Bug Fixes

* **mitm-addon:** filter malformed registry vm entries ([#14434](https://github.com/vm0-ai/vm0/issues/14434)) ([1123ceb](https://github.com/vm0-ai/vm0/commit/1123cebe80005c0435f24a6ff219ce0017aadd8d))
* **mitm-addon:** reject spoofed host authority ([#14432](https://github.com/vm0-ai/vm0/issues/14432)) ([1ec6e5c](https://github.com/vm0-ai/vm0/commit/1ec6e5c894b757d29a4a044a87207ae69fd178c1))
* **mitm-addon:** skip empty decoded request body capture ([#14421](https://github.com/vm0-ai/vm0/issues/14421)) ([fa3faf6](https://github.com/vm0-ai/vm0/commit/fa3faf67034fe0248de77d505db77da9213faf81))
* reject json trailing commas in mitm parser ([#14411](https://github.com/vm0-ai/vm0/issues/14411)) ([c863b19](https://github.com/vm0-ai/vm0/commit/c863b1976cf4a61a5242d84c2126434cb8474661))


### Documentation

* **mitm-addon:** document openai responses usage entry points ([#14417](https://github.com/vm0-ai/vm0/issues/14417)) ([d95d180](https://github.com/vm0-ai/vm0/commit/d95d18027a6a3cd86fbef78f105bbabe1f768c41))


### Refactoring

* centralize runner log filename patterns ([#14400](https://github.com/vm0-ai/vm0/issues/14400)) ([b24ebce](https://github.com/vm0-ai/vm0/commit/b24ebce2edeb1a978c1a840d6a6a3a00db4ff6ce))


### Performance Improvements

* **mitm-addon:** adapt brotli decompression chunk size ([#14418](https://github.com/vm0-ai/vm0/issues/14418)) ([ba9151e](https://github.com/vm0-ai/vm0/commit/ba9151ee894e617ab312047de12cae7a944cf12c))

## [0.103.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.2...runner-rs-v0.103.3) (2026-05-21)


### Bug Fixes

* avoid stale firewall auth cache writes ([#14336](https://github.com/vm0-ai/vm0/issues/14336)) ([f69c8ce](https://github.com/vm0-ai/vm0/commit/f69c8ceef246ff11747129cff1100a67aebc34e3))
* **mitm-addon:** expose firewall block reasons ([#14379](https://github.com/vm0-ai/vm0/issues/14379)) ([21eb63c](https://github.com/vm0-ai/vm0/commit/21eb63ceded10532642a9ba23c4a3b263439b6bc))
* **mitm-addon:** harden logging writes ([#14388](https://github.com/vm0-ai/vm0/issues/14388)) ([a0958d5](https://github.com/vm0-ai/vm0/commit/a0958d57a43c5564c7bcb368942547c2804a2f67))
* prevent webhook log payload collisions ([#14378](https://github.com/vm0-ai/vm0/issues/14378)) ([6a84ac8](https://github.com/vm0-ai/vm0/commit/6a84ac8f800dc371b800af4b4db59f270a37bc8f))
* show runner stdout stream loss in system log ([#14384](https://github.com/vm0-ai/vm0/issues/14384)) ([bf52cbc](https://github.com/vm0-ai/vm0/commit/bf52cbc10bd7de14a09d32d099b53df64d03fc28))


### Refactoring

* **mitm-addon:** split openai response input tokens directly ([#14376](https://github.com/vm0-ai/vm0/issues/14376)) ([9243f08](https://github.com/vm0-ai/vm0/commit/9243f08abb17f4288a16bae260e75b9cf2ace203)), closes [#14367](https://github.com/vm0-ai/vm0/issues/14367)

## [0.103.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.1...runner-rs-v0.103.2) (2026-05-20)


### Documentation

* document json selective extractor contract ([#14311](https://github.com/vm0-ai/vm0/issues/14311)) ([89c8588](https://github.com/vm0-ai/vm0/commit/89c8588f23be33263c606e4c0b11fb45a43a4d80))


### Refactoring

* consolidate mitm auth state ([#14303](https://github.com/vm0-ai/vm0/issues/14303)) ([35a122a](https://github.com/vm0-ai/vm0/commit/35a122ab580b09a524b2c9586bfaa682db0be287))
* deduplicate storage cache entry handling ([#14261](https://github.com/vm0-ai/vm0/issues/14261)) ([86ceff4](https://github.com/vm0-ai/vm0/commit/86ceff473517c20f5b8dd509eabec1b4f546da78))
* migrate sandbox runner processes to supervised exec ([#14231](https://github.com/vm0-ai/vm0/issues/14231)) ([7781715](https://github.com/vm0-ai/vm0/commit/77817154bd0b4aad08d58fc6f41dc2643f07c76c))
* unify guest binary chmod finalization ([#14269](https://github.com/vm0-ai/vm0/issues/14269)) ([c86c879](https://github.com/vm0-ai/vm0/commit/c86c879111835f6f7a9fbe432a678ff95c78e44a))
* use template cache policy for remote resolution ([#14267](https://github.com/vm0-ai/vm0/issues/14267)) ([6142bb5](https://github.com/vm0-ai/vm0/commit/6142bb53f1f7eab538af77fe9150029e315bc9cb))


### Performance Improvements

* **mitm-addon:** compile firewall matcher artifacts ([#14305](https://github.com/vm0-ai/vm0/issues/14305)) ([0e53812](https://github.com/vm0-ai/vm0/commit/0e53812a9ec6acd180e6e798e1fb9135e7d86b4f))

## [0.103.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.0...runner-rs-v0.103.1) (2026-05-20)


### Bug Fixes

* preserve Claude failure diagnostics ([#14174](https://github.com/vm0-ai/vm0/issues/14174)) ([7cd9971](https://github.com/vm0-ai/vm0/commit/7cd99711b6ded65520acbfbe74f12d90a0f391c6))

## [0.103.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.102.5...runner-rs-v0.103.0) (2026-05-20)


### Features

* **runner:** add firecracker io limiters ([#13585](https://github.com/vm0-ai/vm0/issues/13585)) ([653b854](https://github.com/vm0-ai/vm0/commit/653b854613580861d503848a3eeffff98fe75095))


### Bug Fixes

* install pnpm in sandbox image ([#14099](https://github.com/vm0-ai/vm0/issues/14099)) ([75ac682](https://github.com/vm0-ai/vm0/commit/75ac68262f75cbfbae57a1a107cd346f429d45d9))

## [0.102.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.102.4...runner-rs-v0.102.5) (2026-05-19)

## [0.102.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.102.3...runner-rs-v0.102.4) (2026-05-19)


### Bug Fixes

* enforce api start time milliseconds ([#13963](https://github.com/vm0-ai/vm0/issues/13963)) ([847d7a2](https://github.com/vm0-ai/vm0/commit/847d7a2054778457d0c65da5e75439b71b78d965))
* reject malformed firecracker netns names ([#13964](https://github.com/vm0-ai/vm0/issues/13964)) ([637aa3f](https://github.com/vm0-ai/vm0/commit/637aa3ff0b2f6e059d26445c6a6eec4e3858d695))

## [0.102.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.102.2...runner-rs-v0.102.3) (2026-05-19)

## [0.102.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.102.1...runner-rs-v0.102.2) (2026-05-19)


### Bug Fixes

* add runner failure diagnostics ([#13880](https://github.com/vm0-ai/vm0/issues/13880)) ([3fc6515](https://github.com/vm0-ai/vm0/commit/3fc6515e53564de4668ae551ce4caaebcb943d74))

## [0.102.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.102.0...runner-rs-v0.102.1) (2026-05-18)


### Bug Fixes

* manage runner memory prefetch lifecycle ([#13719](https://github.com/vm0-ai/vm0/issues/13719)) ([462dda5](https://github.com/vm0-ai/vm0/commit/462dda5e4af14a62569a2b84add4e899aa879c94))
* preserve codex jsonl failure diagnostics ([#13713](https://github.com/vm0-ai/vm0/issues/13713)) ([7fe2ece](https://github.com/vm0-ai/vm0/commit/7fe2ece7cb75ee6606e4cfb522cc28a19117acf3))

## [0.102.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.101.6...runner-rs-v0.102.0) (2026-05-17)


### Features

* wire operation-bound process control to guest-agent ([#13538](https://github.com/vm0-ai/vm0/issues/13538)) ([3bc2ee1](https://github.com/vm0-ai/vm0/commit/3bc2ee1dda51d68c6825a1a71bf44edbc9692a0d))

## [0.101.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.101.5...runner-rs-v0.101.6) (2026-05-16)


### Performance Improvements

* **runner:** chunk network log uploads ([#13549](https://github.com/vm0-ai/vm0/issues/13549)) ([ae90576](https://github.com/vm0-ai/vm0/commit/ae90576082ef03efa78d5438af17afa0ce08b1b8))

## [0.101.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.101.4...runner-rs-v0.101.5) (2026-05-16)

## [0.101.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.101.3...runner-rs-v0.101.4) (2026-05-15)

## [0.101.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.101.2...runner-rs-v0.101.3) (2026-05-15)

## [0.101.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.101.1...runner-rs-v0.101.2) (2026-05-15)

## [0.101.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.101.0...runner-rs-v0.101.1) (2026-05-15)


### Refactoring

* **mitm-addon:** centralize firewall billing state ([#13463](https://github.com/vm0-ai/vm0/issues/13463)) ([4681a45](https://github.com/vm0-ai/vm0/commit/4681a4553ffa30a2091b72a3071f170f53796383))

## [0.101.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.45...runner-rs-v0.101.0) (2026-05-15)


### Features

* gate billable firewall auth on credits ([#13433](https://github.com/vm0-ai/vm0/issues/13433)) ([235587d](https://github.com/vm0-ai/vm0/commit/235587df8efd5539d87e3fddda72c9726e231a9e))


### Bug Fixes

* **runner:** supervise signal handler lifecycle ([#13390](https://github.com/vm0-ai/vm0/issues/13390)) ([1237dc6](https://github.com/vm0-ai/vm0/commit/1237dc6ab8e28f09ec283b45c33ecb96c3eeb5fb))


### Refactoring

* **runner:** encode idle park ownership state ([#13415](https://github.com/vm0-ai/vm0/issues/13415)) ([9613924](https://github.com/vm0-ai/vm0/commit/9613924249bd8f98536635cb3c04197a1c6886e6))

## [0.100.45](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.44...runner-rs-v0.100.45) (2026-05-15)


### Refactoring

* rename spawn watch to spawn process ([#13369](https://github.com/vm0-ai/vm0/issues/13369)) ([e007f30](https://github.com/vm0-ai/vm0/commit/e007f30a2610056a6905e4a38bcc2d894895ffa4))

## [0.100.44](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.43...runner-rs-v0.100.44) (2026-05-15)

## [0.100.43](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.42...runner-rs-v0.100.43) (2026-05-14)

## [0.100.42](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.41...runner-rs-v0.100.42) (2026-05-14)


### Bug Fixes

* **runner:** close network log source before upload flush ([#13336](https://github.com/vm0-ai/vm0/issues/13336)) ([c8440eb](https://github.com/vm0-ai/vm0/commit/c8440eb2ab1b05175cd30e0200a5d11687b5226f))

## [0.100.41](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.40...runner-rs-v0.100.41) (2026-05-14)


### Bug Fixes

* **runner:** copy guest sandbox ops logs ([#13309](https://github.com/vm0-ai/vm0/issues/13309)) ([39ce8f9](https://github.com/vm0-ai/vm0/commit/39ce8f98d2f5780bd8fd66b1aa10160b67691138))


### Refactoring

* type factory lifecycle resources ([#13293](https://github.com/vm0-ai/vm0/issues/13293)) ([0b533c7](https://github.com/vm0-ai/vm0/commit/0b533c76f86e651b09d662cb9c85a8c3a3d06ad5))

## [0.100.40](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.39...runner-rs-v0.100.40) (2026-05-14)


### Bug Fixes

* handle claude zero-turn no-history runs ([#13246](https://github.com/vm0-ai/vm0/issues/13246)) ([41db91a](https://github.com/vm0-ai/vm0/commit/41db91ac41352fd0e7c2f8c5a77563d4dffd35d7))


### Refactoring

* dedupe job spawn panic cleanup tests ([#13272](https://github.com/vm0-ai/vm0/issues/13272)) ([b7f600a](https://github.com/vm0-ai/vm0/commit/b7f600a142963e2b0bc237acef3a9aa1a1e9c916))
* **runner:** dedupe finalization test setup ([#13271](https://github.com/vm0-ai/vm0/issues/13271)) ([e309a7b](https://github.com/vm0-ai/vm0/commit/e309a7b41601a26f1ced4be93ab6619762f1be18))

## [0.100.39](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.38...runner-rs-v0.100.39) (2026-05-14)


### Bug Fixes

* **runner:** keep local cancel watcher live ([#13218](https://github.com/vm0-ai/vm0/issues/13218)) ([f0dad8c](https://github.com/vm0-ai/vm0/commit/f0dad8cd435f25d95efc35518f9bb1dcaf224940))

## [0.100.38](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.37...runner-rs-v0.100.38) (2026-05-14)

## [0.100.37](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.36...runner-rs-v0.100.37) (2026-05-13)


### Bug Fixes

* enable built-in openai codex billing ([#13193](https://github.com/vm0-ai/vm0/issues/13193)) ([616ad30](https://github.com/vm0-ai/vm0/commit/616ad30f79a0e046ece9a62ea8b195d1bfe6b407))

## [0.100.36](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.35...runner-rs-v0.100.36) (2026-05-13)

## [0.100.35](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.34...runner-rs-v0.100.35) (2026-05-13)


### Bug Fixes

* **runner:** partition local queue by profile ([#13143](https://github.com/vm0-ai/vm0/issues/13143)) ([c0f8835](https://github.com/vm0-ai/vm0/commit/c0f8835ba5779664d58ce7ab06e0fe8d4ec18ba7))

## [0.100.34](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.33...runner-rs-v0.100.34) (2026-05-13)


### Bug Fixes

* normalize instructions filename by runtime framework ([#12245](https://github.com/vm0-ai/vm0/issues/12245)) ([55b4846](https://github.com/vm0-ai/vm0/commit/55b484668ed1b559e2bf16f74ad3fcc4b4559c1f))
* **runner:** validate setup artifacts before reporting installed ([#13075](https://github.com/vm0-ai/vm0/issues/13075)) ([cd68236](https://github.com/vm0-ai/vm0/commit/cd68236acea7bf7002be282cabe68b96c533fe10))


### Documentation

* clarify status run replacement semantics ([#12287](https://github.com/vm0-ai/vm0/issues/12287)) ([09c4eb2](https://github.com/vm0-ai/vm0/commit/09c4eb255c566fcd03f14c79c3328eeeae95a2a4))
* document runner path layout ([#12289](https://github.com/vm0-ai/vm0/issues/12289)) ([e37c3b9](https://github.com/vm0-ai/vm0/commit/e37c3b908114949c320ab72c379c80ee15909624))
* **runner:** document network log drain producers ([#13058](https://github.com/vm0-ai/vm0/issues/13058)) ([9325b1a](https://github.com/vm0-ai/vm0/commit/9325b1ac1988c78fc4018e39d3620873dab48adb))


### Refactoring

* route sandbox exec through command operations ([#13018](https://github.com/vm0-ai/vm0/issues/13018)) ([0e5f862](https://github.com/vm0-ai/vm0/commit/0e5f862ee8e2182e23a88df6187f194171004b1f))
* **runner:** include bounded exec diagnostics ([#12368](https://github.com/vm0-ai/vm0/issues/12368)) ([41d5d12](https://github.com/vm0-ai/vm0/commit/41d5d12ced60e34731d78bea2ef172eed5fbdc77))
* **runner:** migrate internal execs to bounded exec ([#12322](https://github.com/vm0-ai/vm0/issues/12322)) ([f0b84b4](https://github.com/vm0-ai/vm0/commit/f0b84b4f09bad9abc16074af3f0190944bba3d04))
* **runner:** stream exec over bounded exec ([#12518](https://github.com/vm0-ai/vm0/issues/12518)) ([ee551da](https://github.com/vm0-ai/vm0/commit/ee551dabe2c464564a576580a9d8811453ffd08d))
* split start test support modules ([#13078](https://github.com/vm0-ai/vm0/issues/13078)) ([53c010a](https://github.com/vm0-ai/vm0/commit/53c010aa730b8ad4d5c3f285b18e81c30f317b6f))


### Performance Improvements

* avoid downloading warmed runner templates ([#12731](https://github.com/vm0-ai/vm0/issues/12731)) ([eb5df7a](https://github.com/vm0-ai/vm0/commit/eb5df7aa28493373ce5ec734924e80d34fd372b4))
* preserve axiom batch capacity ([#13094](https://github.com/vm0-ai/vm0/issues/13094)) ([72bb92e](https://github.com/vm0-ai/vm0/commit/72bb92ebb56c365907c536fb289e1c3873a1b680))
* **runner:** stream guest log copies ([#12418](https://github.com/vm0-ai/vm0/issues/12418)) ([a842925](https://github.com/vm0-ai/vm0/commit/a8429251f3554335ace57e1a78c105cf881c193b))

## [0.100.33](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.32...runner-rs-v0.100.33) (2026-05-13)

## [0.100.32](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.31...runner-rs-v0.100.32) (2026-05-13)


### Performance Improvements

* preserve axiom batch capacity ([#13094](https://github.com/vm0-ai/vm0/issues/13094)) ([72bb92e](https://github.com/vm0-ai/vm0/commit/72bb92ebb56c365907c536fb289e1c3873a1b680))

## [0.100.31](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.30...runner-rs-v0.100.31) (2026-05-13)


### Bug Fixes

* **runner:** validate setup artifacts before reporting installed ([#13075](https://github.com/vm0-ai/vm0/issues/13075)) ([cd68236](https://github.com/vm0-ai/vm0/commit/cd68236acea7bf7002be282cabe68b96c533fe10))


### Documentation

* **runner:** document network log drain producers ([#13058](https://github.com/vm0-ai/vm0/issues/13058)) ([9325b1a](https://github.com/vm0-ai/vm0/commit/9325b1ac1988c78fc4018e39d3620873dab48adb))


### Refactoring

* route sandbox exec through command operations ([#13018](https://github.com/vm0-ai/vm0/issues/13018)) ([0e5f862](https://github.com/vm0-ai/vm0/commit/0e5f862ee8e2182e23a88df6187f194171004b1f))
* split start test support modules ([#13078](https://github.com/vm0-ai/vm0/issues/13078)) ([53c010a](https://github.com/vm0-ai/vm0/commit/53c010aa730b8ad4d5c3f285b18e81c30f317b6f))

## [0.100.30](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.29...runner-rs-v0.100.30) (2026-05-12)

## [0.100.29](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.28...runner-rs-v0.100.29) (2026-05-12)

## [0.100.28](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.27...runner-rs-v0.100.28) (2026-05-12)

## [0.100.27](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.26...runner-rs-v0.100.27) (2026-05-12)


### Performance Improvements

* avoid downloading warmed runner templates ([#12731](https://github.com/vm0-ai/vm0/issues/12731)) ([eb5df7a](https://github.com/vm0-ai/vm0/commit/eb5df7aa28493373ce5ec734924e80d34fd372b4))

## [0.100.26](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.25...runner-rs-v0.100.26) (2026-05-11)

## [0.100.25](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.24...runner-rs-v0.100.25) (2026-05-10)


### Refactoring

* **runner:** stream exec over bounded exec ([#12518](https://github.com/vm0-ai/vm0/issues/12518)) ([ee551da](https://github.com/vm0-ai/vm0/commit/ee551dabe2c464564a576580a9d8811453ffd08d))

## [0.100.24](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.23...runner-rs-v0.100.24) (2026-05-10)


### Performance Improvements

* **runner:** stream guest log copies ([#12418](https://github.com/vm0-ai/vm0/issues/12418)) ([a842925](https://github.com/vm0-ai/vm0/commit/a8429251f3554335ace57e1a78c105cf881c193b))

## [0.100.23](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.22...runner-rs-v0.100.23) (2026-05-09)


### Refactoring

* **runner:** include bounded exec diagnostics ([#12368](https://github.com/vm0-ai/vm0/issues/12368)) ([41d5d12](https://github.com/vm0-ai/vm0/commit/41d5d12ced60e34731d78bea2ef172eed5fbdc77))

## [0.100.22](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.21...runner-rs-v0.100.22) (2026-05-09)


### Refactoring

* **runner:** migrate internal execs to bounded exec ([#12322](https://github.com/vm0-ai/vm0/issues/12322)) ([f0b84b4](https://github.com/vm0-ai/vm0/commit/f0b84b4f09bad9abc16074af3f0190944bba3d04))

## [0.100.21](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.20...runner-rs-v0.100.21) (2026-05-09)

## [0.100.20](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.19...runner-rs-v0.100.20) (2026-05-09)

## [0.100.19](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.18...runner-rs-v0.100.19) (2026-05-09)


### Documentation

* clarify status run replacement semantics ([#12287](https://github.com/vm0-ai/vm0/issues/12287)) ([09c4eb2](https://github.com/vm0-ai/vm0/commit/09c4eb255c566fcd03f14c79c3328eeeae95a2a4))
* document runner path layout ([#12289](https://github.com/vm0-ai/vm0/issues/12289)) ([e37c3b9](https://github.com/vm0-ai/vm0/commit/e37c3b908114949c320ab72c379c80ee15909624))

## [0.100.18](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.17...runner-rs-v0.100.18) (2026-05-09)

## [0.100.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.16...runner-rs-v0.100.17) (2026-05-09)

## [0.100.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.15...runner-rs-v0.100.16) (2026-05-09)

## [0.100.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.14...runner-rs-v0.100.15) (2026-05-09)


### Bug Fixes

* normalize instructions filename by runtime framework ([#12245](https://github.com/vm0-ai/vm0/issues/12245)) ([55b4846](https://github.com/vm0-ai/vm0/commit/55b484668ed1b559e2bf16f74ad3fcc4b4559c1f))

## [0.100.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.13...runner-rs-v0.100.14) (2026-05-08)

## [0.100.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.12...runner-rs-v0.100.13) (2026-05-08)


### Documentation

* **runner:** document http client constructor ([#12171](https://github.com/vm0-ai/vm0/issues/12171)) ([a31e828](https://github.com/vm0-ai/vm0/commit/a31e8282936e2378397deb81326b78c777424ee3))


### Performance Improvements

* add guest write-file helper ([#12136](https://github.com/vm0-ai/vm0/issues/12136)) ([8795398](https://github.com/vm0-ai/vm0/commit/8795398ddd54bb6f7e4cade4c1d3a67a11bebd1b))

## [0.100.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.11...runner-rs-v0.100.12) (2026-05-08)

## [0.100.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.10...runner-rs-v0.100.11) (2026-05-08)


### Bug Fixes

* restore codex sessions as jsonl ([#12137](https://github.com/vm0-ai/vm0/issues/12137)) ([ab3dc5b](https://github.com/vm0-ai/vm0/commit/ab3dc5b5f35105709cc22d7caf9e571c59ec5a39))

## [0.100.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.9...runner-rs-v0.100.10) (2026-05-08)


### Bug Fixes

* refresh personal codex oauth providers ([#12120](https://github.com/vm0-ai/vm0/issues/12120)) ([b4e727d](https://github.com/vm0-ai/vm0/commit/b4e727da0dc4a1fbb0df6d8ef3aececa9460b5a7))

## [0.100.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.8...runner-rs-v0.100.9) (2026-05-07)


### Refactoring

* **runner:** clarify r2 template materialization ([#12104](https://github.com/vm0-ai/vm0/issues/12104)) ([6649d63](https://github.com/vm0-ai/vm0/commit/6649d63b2f58ab29ee7c150e1d055529e0888de5))
* **runner:** shield snapshot publish cancellation ([#12101](https://github.com/vm0-ai/vm0/issues/12101)) ([ecc38a4](https://github.com/vm0-ai/vm0/commit/ecc38a414a24c72d654d049f6eb38906ce24b734))

## [0.100.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.7...runner-rs-v0.100.8) (2026-05-07)


### Refactoring

* **runner:** split snapshot publish boundary ([#12044](https://github.com/vm0-ai/vm0/issues/12044)) ([b01e205](https://github.com/vm0-ai/vm0/commit/b01e205e530cb9a6ed5353294077d9a80b70da62))

## [0.100.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.6...runner-rs-v0.100.7) (2026-05-07)

## [0.100.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.5...runner-rs-v0.100.6) (2026-05-07)


### Refactoring

* **runner:** dedupe network log drain warnings ([#12065](https://github.com/vm0-ai/vm0/issues/12065)) ([902113f](https://github.com/vm0-ai/vm0/commit/902113f2af2265322c71d3e435818ffbfc0e0cd5))

## [0.100.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.4...runner-rs-v0.100.5) (2026-05-07)


### Refactoring

* **runner:** centralize ownership transitions ([#12034](https://github.com/vm0-ai/vm0/issues/12034)) ([03cd98f](https://github.com/vm0-ai/vm0/commit/03cd98f32d2a42fd02d6fa1cdb1c34e4bea70ca0))

## [0.100.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.3...runner-rs-v0.100.4) (2026-05-07)


### Bug Fixes

* **runner:** select usage parser from cli agent type ([#12030](https://github.com/vm0-ai/vm0/issues/12030)) ([6cdd8ef](https://github.com/vm0-ai/vm0/commit/6cdd8ef2e777139fdef56d8e36c589a38be64e58))

## [0.100.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.2...runner-rs-v0.100.3) (2026-05-07)


### Documentation

* **runner:** document local command entrypoints ([#12010](https://github.com/vm0-ai/vm0/issues/12010)) ([26851da](https://github.com/vm0-ai/vm0/commit/26851daf16b347ae75491aa5907f186868ca8cb8))

## [0.100.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.1...runner-rs-v0.100.2) (2026-05-06)


### Bug Fixes

* **runner:** disable r2 response checksum warnings ([#11975](https://github.com/vm0-ai/vm0/issues/11975)) ([18a5ffd](https://github.com/vm0-ai/vm0/commit/18a5ffd955372b33f5af6db6deecaef964fe194c))

## [0.100.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.0...runner-rs-v0.100.1) (2026-05-06)


### Refactoring

* **runner:** share bounded sse usage scanner ([#11961](https://github.com/vm0-ai/vm0/issues/11961)) ([cfbd94d](https://github.com/vm0-ai/vm0/commit/cfbd94dc757b340dd5aa04f94e8b6e980c10eb40))

## [0.100.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.14...runner-rs-v0.100.0) (2026-05-06)


### Features

* **runner:** add OpenAI Responses usage billing ([#11950](https://github.com/vm0-ai/vm0/issues/11950)) ([467cdc8](https://github.com/vm0-ai/vm0/commit/467cdc8fc88897c16b0b21365c70a1786e5fda3e))

## [0.99.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.13...runner-rs-v0.99.14) (2026-05-06)

## [0.99.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.12...runner-rs-v0.99.13) (2026-05-06)


### Bug Fixes

* **sandbox-fc:** require snapshot publish marker ([#11867](https://github.com/vm0-ai/vm0/issues/11867)) ([023ae4d](https://github.com/vm0-ai/vm0/commit/023ae4d86570157504a176372727cab05f5b1483))


### Documentation

* **runner:** restore start loop comments ([#11896](https://github.com/vm0-ai/vm0/issues/11896)) ([ebb0521](https://github.com/vm0-ai/vm0/commit/ebb0521fd38c8ff09f8fee296cc5de0e458bc9eb))


### Refactoring

* **runner:** split start test harness ([#11870](https://github.com/vm0-ai/vm0/issues/11870)) ([085d91f](https://github.com/vm0-ai/vm0/commit/085d91fd68f2569aae8703dc8e781a65cce4cf32))

## [0.99.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.11...runner-rs-v0.99.12) (2026-05-05)


### Refactoring

* **runner:** split ably control plane from discovery ([#11856](https://github.com/vm0-ai/vm0/issues/11856)) ([b1468f1](https://github.com/vm0-ai/vm0/commit/b1468f1ae6085e13ebb34e4a53bc33270471bb58))
* **runner:** split start job discovery ([#11859](https://github.com/vm0-ai/vm0/issues/11859)) ([6139fc4](https://github.com/vm0-ai/vm0/commit/6139fc4e74e28ead4aac2784e582ca49290a8758))
* **runner:** split start job spawn ([#11862](https://github.com/vm0-ai/vm0/issues/11862)) ([89e78e8](https://github.com/vm0-ai/vm0/commit/89e78e89f39949ab25cb5237431881439d0d0acc))
* **runner:** split start sandbox finalization ([#11854](https://github.com/vm0-ai/vm0/issues/11854)) ([afd5117](https://github.com/vm0-ai/vm0/commit/afd51176d3d6d92cf0daa65999ad1140d88de9a4))
* **sandbox-fc:** add snapshot cleanup Drop finalizer ([#11843](https://github.com/vm0-ai/vm0/issues/11843)) ([8c3bfdd](https://github.com/vm0-ai/vm0/commit/8c3bfdd257b592737d39eecf5c6eacb1ca2ee861))

## [0.99.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.10...runner-rs-v0.99.11) (2026-05-05)


### Bug Fixes

* mark truncated decompressed network bodies ([#11793](https://github.com/vm0-ai/vm0/issues/11793)) ([bd2efd7](https://github.com/vm0-ai/vm0/commit/bd2efd759baf04a8bb789b224f8f9dca84864bc2))
* **runner:** escalate prolonged ably disconnects ([#11839](https://github.com/vm0-ai/vm0/issues/11839)) ([40b7d97](https://github.com/vm0-ai/vm0/commit/40b7d979c02f820a85950f0cb449fddc47461af7))


### Documentation

* document runner exec entry points ([#11812](https://github.com/vm0-ai/vm0/issues/11812)) ([2f8d87f](https://github.com/vm0-ai/vm0/commit/2f8d87faf2c9019f1fd14c675288dda8f73d0393))
* **runner:** document setup command ([#11810](https://github.com/vm0-ai/vm0/issues/11810)) ([35b5f2e](https://github.com/vm0-ai/vm0/commit/35b5f2ecf275b7a4a8feb32d634414ce32ad0f23))


### Refactoring

* **runner:** split start factory lifecycle ([#11828](https://github.com/vm0-ai/vm0/issues/11828)) ([e8e88c0](https://github.com/vm0-ai/vm0/commit/e8e88c0296b50f8ee4cc2d6c0b1b7144ebacb9de))
* **runner:** split start heartbeat module ([#11801](https://github.com/vm0-ai/vm0/issues/11801)) ([19ad6d4](https://github.com/vm0-ai/vm0/commit/19ad6d4d7af13fe45f50fe568dac279ee210c8bb))
* **runner:** split start idle lifecycle ([#11835](https://github.com/vm0-ai/vm0/issues/11835)) ([4e99ccb](https://github.com/vm0-ai/vm0/commit/4e99ccbec568b4b9186b32ab0c37bf9d1078d0e7))
* **runner:** split start orphan reaper ([#11820](https://github.com/vm0-ai/vm0/issues/11820)) ([71a4bec](https://github.com/vm0-ai/vm0/commit/71a4bec7963be662c15a90868373808dd4951302))


### Performance Improvements

* bound brotli body capture decompression ([#11799](https://github.com/vm0-ai/vm0/issues/11799)) ([92af5b4](https://github.com/vm0-ai/vm0/commit/92af5b4d73095bef1b5b40c3af8b1e0ff8e49b1b))

## [0.99.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.9...runner-rs-v0.99.10) (2026-05-03)


### Bug Fixes

* stabilize teardown timer tracing test ([#11767](https://github.com/vm0-ai/vm0/issues/11767)) ([ae279fc](https://github.com/vm0-ai/vm0/commit/ae279fc2786df436f6a41019610e162f6b6334d8))

## [0.99.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.8...runner-rs-v0.99.9) (2026-05-03)


### Bug Fixes

* **nbd-cow:** lock NBD claims across runners ([#11732](https://github.com/vm0-ai/vm0/issues/11732)) ([16d716e](https://github.com/vm0-ai/vm0/commit/16d716e1f07a77c0d93649f52d077953dd62ff16))

## [0.99.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.7...runner-rs-v0.99.8) (2026-05-03)


### Bug Fixes

* suppress runner debug logs ([#11727](https://github.com/vm0-ai/vm0/issues/11727)) ([2c47f5c](https://github.com/vm0-ai/vm0/commit/2c47f5cc1cd1b4906984adb3f0615f7edb622979))


### Refactoring

* dedupe guest download manifest conversion ([#11731](https://github.com/vm0-ai/vm0/issues/11731)) ([e1f5cb4](https://github.com/vm0-ai/vm0/commit/e1f5cb464bb4d9fdb6352ff9d3de20896536b471))
* **runner:** share api client response handling ([#11725](https://github.com/vm0-ai/vm0/issues/11725)) ([006e356](https://github.com/vm0-ai/vm0/commit/006e356bdf484bb9321a47330abac7dd168943c2))

## [0.99.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.6...runner-rs-v0.99.7) (2026-05-03)


### Documentation

* **runner:** document doctor entry points ([#11699](https://github.com/vm0-ai/vm0/issues/11699)) ([e431dc0](https://github.com/vm0-ai/vm0/commit/e431dc02d3d5f2b27ee3ad676f1d1d524f5c6b93))


### Performance Improvements

* **runner:** cache rootfs templates in r2 ([#11597](https://github.com/vm0-ai/vm0/issues/11597)) ([136382c](https://github.com/vm0-ai/vm0/commit/136382cbfa2fc1ed8230145edf13ec72f712e770))

## [0.99.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.5...runner-rs-v0.99.6) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.99.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.4...runner-rs-v0.99.5) (2026-05-01)


### Bug Fixes

* harden ably disconnect handling ([#11656](https://github.com/vm0-ai/vm0/issues/11656)) ([c0c50d8](https://github.com/vm0-ai/vm0/commit/c0c50d88154f7ad74af791fc2df9e5a8db609418))

## [0.99.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.3...runner-rs-v0.99.4) (2026-05-01)


### Documentation

* document runner executor module ([#11608](https://github.com/vm0-ai/vm0/issues/11608)) ([9838b83](https://github.com/vm0-ai/vm0/commit/9838b8395a9dddd523fb37e366210c64ee2b1cfe))

## [0.99.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.2...runner-rs-v0.99.3) (2026-04-30)


### Refactoring

* **runner:** clarify build orchestration ([#11580](https://github.com/vm0-ai/vm0/issues/11580)) ([60926e3](https://github.com/vm0-ai/vm0/commit/60926e366abaf11c4430e08eac6903262038152c))

## [0.99.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.1...runner-rs-v0.99.2) (2026-04-29)


### Bug Fixes

* **runner:** drain network logs before source release ([#11552](https://github.com/vm0-ai/vm0/issues/11552)) ([b297e3c](https://github.com/vm0-ai/vm0/commit/b297e3c20afb94c2796311111fd60ed732c9d1e9))

## [0.99.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.0...runner-rs-v0.99.1) (2026-04-29)


### Bug Fixes

* bound runner storage cache cardinality ([#11554](https://github.com/vm0-ai/vm0/issues/11554)) ([1950c8b](https://github.com/vm0-ai/vm0/commit/1950c8b97ae9deacd61a971af90b2c84ba16fd69))

## [0.99.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.98.7...runner-rs-v0.99.0) (2026-04-29)


### Features

* **runner:** log teardown phase timings ([#11548](https://github.com/vm0-ai/vm0/issues/11548)) ([0cc9974](https://github.com/vm0-ai/vm0/commit/0cc9974742bf745c53476c662dc8f663943a4a6b))

## [0.98.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.98.6...runner-rs-v0.98.7) (2026-04-29)


### Bug Fixes

* **runner:** compare axiom timeouts precisely ([#11536](https://github.com/vm0-ai/vm0/issues/11536)) ([6c751d4](https://github.com/vm0-ai/vm0/commit/6c751d47dc24fe7277beafbd475cb229001d74b9))

## [0.98.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.98.5...runner-rs-v0.98.6) (2026-04-29)

## [0.98.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.98.4...runner-rs-v0.98.5) (2026-04-29)


### Documentation

* **runner:** document resource budget accessors ([#11505](https://github.com/vm0-ai/vm0/issues/11505)) ([7d7ded9](https://github.com/vm0-ai/vm0/commit/7d7ded9f5b3268bc8d4a221381d58120ba890e7e))

## [0.98.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.98.3...runner-rs-v0.98.4) (2026-04-29)


### Refactoring

* extract mitm registry cache ([#11492](https://github.com/vm0-ai/vm0/issues/11492)) ([a184fff](https://github.com/vm0-ai/vm0/commit/a184fff36e741d2c16cb7f28cc9ad13425da6a42))

## [0.98.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.98.2...runner-rs-v0.98.3) (2026-04-29)


### Refactoring

* extract mitm response streaming state ([#11488](https://github.com/vm0-ai/vm0/issues/11488)) ([3e6a471](https://github.com/vm0-ai/vm0/commit/3e6a471ff4ce1c802b36e610e6e51a6a91ff8fe5))
* split runner storage manifest boundaries ([#11487](https://github.com/vm0-ai/vm0/issues/11487)) ([7bfc3f8](https://github.com/vm0-ai/vm0/commit/7bfc3f86717495cf2ed8d72c796fb1e3b6a98f30))

## [0.98.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.98.1...runner-rs-v0.98.2) (2026-04-29)

## [0.98.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.98.0...runner-rs-v0.98.1) (2026-04-29)


### Bug Fixes

* **runner:** clean up outer job panic bookkeeping ([#11393](https://github.com/vm0-ai/vm0/issues/11393)) ([4ecf0b6](https://github.com/vm0-ai/vm0/commit/4ecf0b65e25c66a86eec0151a29dd4f0fa0deeb0))

## [0.98.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.97.3...runner-rs-v0.98.0) (2026-04-28)


### Features

* **rootfs:** install codex cli binary in sandbox image ([#11425](https://github.com/vm0-ai/vm0/issues/11425)) ([00914b9](https://github.com/vm0-ai/vm0/commit/00914b9c1d98027f8ca2901df58ce4e0653cfba6)), closes [#11416](https://github.com/vm0-ai/vm0/issues/11416)
* **runner:** framework-aware restore_session for codex ([#11429](https://github.com/vm0-ai/vm0/issues/11429)) ([6e10fcd](https://github.com/vm0-ai/vm0/commit/6e10fcdee3ab50f02f3771cd32aacc7d59dd184b))

## [0.97.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.97.2...runner-rs-v0.97.3) (2026-04-28)

## [0.97.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.97.1...runner-rs-v0.97.2) (2026-04-28)

## [0.97.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.97.0...runner-rs-v0.97.1) (2026-04-28)


### Refactoring

* **runner:** model spawn job lifecycle ownership ([#11354](https://github.com/vm0-ai/vm0/issues/11354)) ([3d6c156](https://github.com/vm0-ai/vm0/commit/3d6c156304b24e7967137e8411f38baaafa52ef7))

## [0.97.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.96.6...runner-rs-v0.97.0) (2026-04-28)


### Features

* **runner:** record dns query results in network logs ([#11351](https://github.com/vm0-ai/vm0/issues/11351)) ([96755e6](https://github.com/vm0-ai/vm0/commit/96755e69c58de5e0ca2b13a6be3693b6276cee7a))

## [0.96.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.96.5...runner-rs-v0.96.6) (2026-04-28)


### Bug Fixes

* align telegram typing and markdown responses ([#11312](https://github.com/vm0-ai/vm0/issues/11312)) ([eb4b88e](https://github.com/vm0-ai/vm0/commit/eb4b88eca4db66fedd20eead881a1691408688f4))

## [0.96.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.96.4...runner-rs-v0.96.5) (2026-04-28)


### Bug Fixes

* **runner:** isolate axiom tracing filter ([#11300](https://github.com/vm0-ai/vm0/issues/11300)) ([d999241](https://github.com/vm0-ai/vm0/commit/d9992419e3c93628ee6ed15aefa60c889ee40f0c))


### Refactoring

* **runner:** require leases for budget reservations ([#11301](https://github.com/vm0-ai/vm0/issues/11301)) ([d48d3d3](https://github.com/vm0-ai/vm0/commit/d48d3d3e4106f97531b41049fe30956289bb8738))

## [0.96.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.96.3...runner-rs-v0.96.4) (2026-04-28)


### Bug Fixes

* **runner:** cap storage cache downloads ([#11254](https://github.com/vm0-ai/vm0/issues/11254)) ([8c0764f](https://github.com/vm0-ai/vm0/commit/8c0764f7454d22f4afd891854833e6ee15735840))
* **runner:** gate parking during soft drain transitions ([#11272](https://github.com/vm0-ai/vm0/issues/11272)) ([ccfe41b](https://github.com/vm0-ai/vm0/commit/ccfe41b4c9aa7334623119b679807592588cd703))

## [0.96.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.96.2...runner-rs-v0.96.3) (2026-04-27)


### Refactoring

* centralize guest system log path ([#11246](https://github.com/vm0-ai/vm0/issues/11246)) ([b93fc42](https://github.com/vm0-ai/vm0/commit/b93fc42833815fd843f073044b4e872505812025))

## [0.96.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.96.1...runner-rs-v0.96.2) (2026-04-27)

## [0.96.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.96.0...runner-rs-v0.96.1) (2026-04-27)


### Bug Fixes

* **mitm-addon:** harden static firewall host matching ([#11231](https://github.com/vm0-ai/vm0/issues/11231)) ([36eb7d1](https://github.com/vm0-ai/vm0/commit/36eb7d14959328ec8beca105a12685290b6e4f63))


### Documentation

* **runner:** clarify benchmark profile lookup ([#11237](https://github.com/vm0-ai/vm0/issues/11237)) ([c159474](https://github.com/vm0-ai/vm0/commit/c159474be7cddaa47f19f9300d571f890fbf9d2a))

## [0.96.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.95.5...runner-rs-v0.96.0) (2026-04-27)


### Features

* support batched usage event webhooks ([#11204](https://github.com/vm0-ai/vm0/issues/11204)) ([cc46707](https://github.com/vm0-ai/vm0/commit/cc467077cc79126df30c6b101543780e7bd49bc8))


### Bug Fixes

* **runner:** add active cleanup panic context ([#11212](https://github.com/vm0-ai/vm0/issues/11212)) ([d0f2804](https://github.com/vm0-ai/vm0/commit/d0f2804cc481ffc1e8164d04c23b856e3d2d6ec0)), closes [#11194](https://github.com/vm0-ai/vm0/issues/11194)
* **runner:** make idle vm budget release panic-safe ([#11191](https://github.com/vm0-ai/vm0/issues/11191)) ([52e085f](https://github.com/vm0-ai/vm0/commit/52e085fb6e53623b5920fbfee58ccc71d8d760ae))


### Refactoring

* **mitm-addon:** validate x tweet urls with iana tlds ([#11186](https://github.com/vm0-ai/vm0/issues/11186)) ([bd13484](https://github.com/vm0-ai/vm0/commit/bd13484d5ceaa8fc9fc28cbe2efd22bc10d6d76b))
* **sandbox:** clarify error taxonomy ([#11178](https://github.com/vm0-ai/vm0/issues/11178)) ([f766059](https://github.com/vm0-ai/vm0/commit/f7660591f6866336a78803225653fd738667c036))

## [0.95.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.95.4...runner-rs-v0.95.5) (2026-04-26)


### Bug Fixes

* **mitm-addon:** detect x tweet urls conservatively ([#11176](https://github.com/vm0-ai/vm0/issues/11176)) ([cf8fb08](https://github.com/vm0-ai/vm0/commit/cf8fb08a270e1f887f78272dd8bb5b34f6adfe5e))
* **runner:** reap completed jobs while running ([#11167](https://github.com/vm0-ai/vm0/issues/11167)) ([1355c20](https://github.com/vm0-ai/vm0/commit/1355c206bc638b7e5c65764992f57df9990b6a36))
* **runner:** reclaim expired idle VMs under pressure ([#11172](https://github.com/vm0-ai/vm0/issues/11172)) ([28855b9](https://github.com/vm0-ai/vm0/commit/28855b980d66b77d869ba5b37d6055b29676ca43))


### Refactoring

* **runner:** consolidate flock acquisition ([#11155](https://github.com/vm0-ai/vm0/issues/11155)) ([cd013fc](https://github.com/vm0-ai/vm0/commit/cd013fcc037efd50001c0525c9c11202e5c959f1))
* **runner:** consolidate gc read dir handling ([#11153](https://github.com/vm0-ai/vm0/issues/11153)) ([c07593c](https://github.com/vm0-ai/vm0/commit/c07593ce164289f102ec050594a2ba62570d9b60))
* **runner:** split start leaf modules ([#11136](https://github.com/vm0-ai/vm0/issues/11136)) ([9bc7995](https://github.com/vm0-ai/vm0/commit/9bc7995a0ef28c05e7eea326d0233325221d2016))
* **runner:** unify start loop reactor ([#11159](https://github.com/vm0-ai/vm0/issues/11159)) ([aa85eb6](https://github.com/vm0-ai/vm0/commit/aa85eb61e06c82f36a594c4852c4f0dbcd5b84e5))

## [0.95.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.95.3...runner-rs-v0.95.4) (2026-04-26)


### Refactoring

* extract connectors package ([#11132](https://github.com/vm0-ai/vm0/issues/11132)) ([15bf0fa](https://github.com/vm0-ai/vm0/commit/15bf0faa80ccd294fcfd0a1ce51fac9ea6285449))

## [0.95.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.95.2...runner-rs-v0.95.3) (2026-04-25)


### Bug Fixes

* **runner:** unify error log for claimed-but-failed job ([#11093](https://github.com/vm0-ai/vm0/issues/11093)) ([30138c5](https://github.com/vm0-ai/vm0/commit/30138c5d231fe122cfd7180e98ed1d53a1fae76a))


### Refactoring

* split db and api contracts packages ([#11092](https://github.com/vm0-ai/vm0/issues/11092)) ([f4767d9](https://github.com/vm0-ai/vm0/commit/f4767d987af373d17d93d5ca8fb00864c18bc15b))

## [0.95.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.95.1...runner-rs-v0.95.2) (2026-04-25)

## [0.95.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.95.0...runner-rs-v0.95.1) (2026-04-25)

## [0.95.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.94.2...runner-rs-v0.95.0) (2026-04-24)


### Features

* **runner:** log axiom telemetry enabled/disabled at startup ([#11040](https://github.com/vm0-ai/vm0/issues/11040)) ([7528e66](https://github.com/vm0-ai/vm0/commit/7528e66045d690c2372ad1b0ef41bd33d3c5afe2))


### Bug Fixes

* **runner:** treat claim 404 as race-lost, not api error (closes [#11041](https://github.com/vm0-ai/vm0/issues/11041)) ([#11045](https://github.com/vm0-ai/vm0/issues/11045)) ([83815d2](https://github.com/vm0-ai/vm0/commit/83815d22670be1553082c6a9398c78cdcfa8547d))

## [0.94.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.94.1...runner-rs-v0.94.2) (2026-04-24)


### Bug Fixes

* **runner:** make rootfs assembly atomic via staging + rename ([#11013](https://github.com/vm0-ai/vm0/issues/11013)) ([ab3c249](https://github.com/vm0-ai/vm0/commit/ab3c249f5c4a4684d7aa3cf0dc736fe8e5f6eac3))


### Performance Improvements

* **guest-agent:** skip vas snapshot for unchanged artifacts (part 2 of [#10967](https://github.com/vm0-ai/vm0/issues/10967)) ([#10989](https://github.com/vm0-ai/vm0/issues/10989)) ([4d4b18e](https://github.com/vm0-ai/vm0/commit/4d4b18ede0f7f13c767cb8d50726d9ea1e69c780))

## [0.94.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.94.0...runner-rs-v0.94.1) (2026-04-24)


### Bug Fixes

* **mitm-addon:** retarget seed-consistency test at usage_pricing + trigger on dev-seed.ts ([#11000](https://github.com/vm0-ai/vm0/issues/11000)) ([a436db1](https://github.com/vm0-ai/vm0/commit/a436db14325c0292b5038d83eaad5cab9fedfc98))

## [0.94.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.9...runner-rs-v0.94.0) (2026-04-24)


### Features

* thread storage id from web to guest-agent (part 1 of [#10967](https://github.com/vm0-ai/vm0/issues/10967)) ([#10978](https://github.com/vm0-ai/vm0/issues/10978)) ([85f2193](https://github.com/vm0-ai/vm0/commit/85f219383d3cf7b81ca6f41358276d5388acb8c0))

## [0.93.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.8...runner-rs-v0.93.9) (2026-04-24)


### Bug Fixes

* **mitm-addon:** guard flow.request.content against bad content-encoding ([#10968](https://github.com/vm0-ai/vm0/issues/10968)) ([a90e863](https://github.com/vm0-ai/vm0/commit/a90e86331ccf4455ef14f288430962583f7d54cf))

## [0.93.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.7...runner-rs-v0.93.8) (2026-04-24)

## [0.93.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.6...runner-rs-v0.93.7) (2026-04-23)


### Refactoring

* **runner:** dedupe early-return timing blocks in benchmark ([#10901](https://github.com/vm0-ai/vm0/issues/10901)) ([8c81ec7](https://github.com/vm0-ai/vm0/commit/8c81ec7ce58ce01bfd312d4539f7b3779f5524ea))

## [0.93.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.5...runner-rs-v0.93.6) (2026-04-23)


### Performance Improvements

* **runner:** parallelize idle pool drain ([#10864](https://github.com/vm0-ai/vm0/issues/10864)) ([4db1306](https://github.com/vm0-ai/vm0/commit/4db1306de073f588a1b5d57aa642b5104d8f8550))
* **runner:** post /complete from guest-agent after checkpoint lands ([#10787](https://github.com/vm0-ai/vm0/issues/10787)) ([69e00f0](https://github.com/vm0-ai/vm0/commit/69e00f0540348aaab547b13c7533bd97af88ad23))

## [0.93.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.4...runner-rs-v0.93.5) (2026-04-23)


### Bug Fixes

* **runner:** probe storage archive size via get range instead of head ([#10850](https://github.com/vm0-ai/vm0/issues/10850)) ([5456d37](https://github.com/vm0-ai/vm0/commit/5456d376d3adf9a471f649fdd9c853c238df413c))


### Refactoring

* **runner:** move statustracker port setters into constructor (closes [#10651](https://github.com/vm0-ai/vm0/issues/10651)) ([#10836](https://github.com/vm0-ai/vm0/issues/10836)) ([898710c](https://github.com/vm0-ai/vm0/commit/898710ccf51047685b4312eaae3ef7500f67b572))

## [0.93.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.3...runner-rs-v0.93.4) (2026-04-23)


### Documentation

* document public statustracker methods (closes [#10635](https://github.com/vm0-ai/vm0/issues/10635)) ([#10811](https://github.com/vm0-ai/vm0/issues/10811)) ([559b65b](https://github.com/vm0-ai/vm0/commit/559b65b8f78d2754888315108b40498d42f15f13))

## [0.93.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.2...runner-rs-v0.93.3) (2026-04-23)


### Bug Fixes

* **voice-chat-candidate:** adaptive echo cancellation and server-side session config ([#10795](https://github.com/vm0-ai/vm0/issues/10795)) ([2782e42](https://github.com/vm0-ai/vm0/commit/2782e42e8a562a4c20ecebbd5630de0f6ae21cf3))


### Documentation

* document runner config schema (closes [#10775](https://github.com/vm0-ai/vm0/issues/10775)) ([#10801](https://github.com/vm0-ai/vm0/issues/10801)) ([70808d4](https://github.com/vm0-ai/vm0/commit/70808d4625fc21433b711d580610004ee6c07f0b))

## [0.93.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.1...runner-rs-v0.93.2) (2026-04-23)


### Documentation

* **runner:** fix misleading comments in resolve_ambiguous test ([#10791](https://github.com/vm0-ai/vm0/issues/10791)) ([2da48bb](https://github.com/vm0-ai/vm0/commit/2da48bbbeb2ca824789551e4980656c560b31350))

## [0.93.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.0...runner-rs-v0.93.1) (2026-04-23)


### Bug Fixes

* **runner:** reject benchmark --env values without '=' ([#10712](https://github.com/vm0-ai/vm0/issues/10712)) ([cf57891](https://github.com/vm0-ai/vm0/commit/cf57891b34f276e4f2a6a7027bbc5f392bd8d201))

## [0.93.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.92.0...runner-rs-v0.93.0) (2026-04-22)


### Features

* **billing:** unify connector_billing into usage_event table ([#10704](https://github.com/vm0-ai/vm0/issues/10704)) ([6f9c462](https://github.com/vm0-ai/vm0/commit/6f9c4622a47619404b31adb3c980e80546094528))


### Refactoring

* drop residual memory plumbing, legacy snapshot columns, and vm0 memory cli ([#10707](https://github.com/vm0-ai/vm0/issues/10707)) ([08f3ce8](https://github.com/vm0-ai/vm0/commit/08f3ce81273faf8ea7e2e4df67b69e774bcb963e))
* emit memory as artifacts[] entry and delete guest-agent symlink bootstrap ([#10700](https://github.com/vm0-ai/vm0/issues/10700)) ([e3f0120](https://github.com/vm0-ai/vm0/commit/e3f0120fbd90d9b9fb750e13440a9f21ea809d3a))
* **runner:** collapse duplicated wire/info struct pairs in doctor.rs ([#10711](https://github.com/vm0-ai/vm0/issues/10711)) ([05628c2](https://github.com/vm0-ai/vm0/commit/05628c29b574caea5992bee6170e5533cf258182)), closes [#10654](https://github.com/vm0-ai/vm0/issues/10654)
* **runner:** simplify extract_field to single-line iterator chain ([#10682](https://github.com/vm0-ai/vm0/issues/10682)) ([89fcbdd](https://github.com/vm0-ai/vm0/commit/89fcbdd609c7803f8f0e7eaf52b7a63ef6039f32)), closes [#10656](https://github.com/vm0-ai/vm0/issues/10656)

## [0.92.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.91.1...runner-rs-v0.92.0) (2026-04-22)


### Features

* multi-mount artifact backend + checkpoint schema ([#10629](https://github.com/vm0-ai/vm0/issues/10629)) ([0f8af96](https://github.com/vm0-ai/vm0/commit/0f8af96cd55dedd89534ff430765cc34661a55fc))

## [0.91.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.91.0...runner-rs-v0.91.1) (2026-04-22)


### Refactoring

* **firewall:** remove graphql-specific rule support ([#10622](https://github.com/vm0-ai/vm0/issues/10622)) ([7654336](https://github.com/vm0-ai/vm0/commit/7654336d644fe7bdae7e9fcc49777c0f9aa4216b))

## [0.91.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.90.0...runner-rs-v0.91.0) (2026-04-22)


### Features

* **runner:** ship error logs to axiom via tracing layer ([#10576](https://github.com/vm0-ai/vm0/issues/10576)) ([4abb780](https://github.com/vm0-ai/vm0/commit/4abb780656c2423cd66791423128885aa9e7f053))


### Bug Fixes

* **mitm-addon:** stop load_registry log spam on sustained failure ([#10572](https://github.com/vm0-ai/vm0/issues/10572)) ([1d946a1](https://github.com/vm0-ai/vm0/commit/1d946a1b9074ac8e1116463c94191470ad065621))

## [0.90.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.89.3...runner-rs-v0.90.0) (2026-04-22)


### Features

* **mitm-addon:** vendor ijson pure-python backend ([#10533](https://github.com/vm0-ai/vm0/issues/10533)) ([fec03b3](https://github.com/vm0-ai/vm0/commit/fec03b31ec0766baff9d4e4b200d1d37f03a80a7))


### Documentation

* **mitm-addon:** clarify firewall_action vs firewall_error semantics ([#10540](https://github.com/vm0-ai/vm0/issues/10540)) ([c48046d](https://github.com/vm0-ai/vm0/commit/c48046d52203593a6e4f5e432a55a79660c74062))


### Refactoring

* **mitm-addon:** surface one-shot warnings for best-effort failures ([#10525](https://github.com/vm0-ai/vm0/issues/10525)) ([136cf1f](https://github.com/vm0-ai/vm0/commit/136cf1fa0ac2d9e4079015a26bc9103c3f3e7b49))
* **mitm-addon:** unify urllib cleanup on `with` blocks ([#10543](https://github.com/vm0-ai/vm0/issues/10543)) ([f319b55](https://github.com/vm0-ai/vm0/commit/f319b55a470d2460395e84042859063685b964dd)), closes [#10491](https://github.com/vm0-ai/vm0/issues/10491)

## [0.89.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.89.2...runner-rs-v0.89.3) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.89.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.89.1...runner-rs-v0.89.2) (2026-04-22)


### Bug Fixes

* **runner:** close urllib response in firewall auth fetch ([#10489](https://github.com/vm0-ai/vm0/issues/10489)) ([30a80ca](https://github.com/vm0-ai/vm0/commit/30a80caf4b598eb84dc39547b11378c56c6b5412))

## [0.89.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.89.0...runner-rs-v0.89.1) (2026-04-22)


### Bug Fixes

* **mitm-addon:** close urllib response and error in _forward_request_sync ([#10490](https://github.com/vm0-ai/vm0/issues/10490)) ([f65241b](https://github.com/vm0-ai/vm0/commit/f65241bb88d0dc333327685b25cc3b243db64406)), closes [#10476](https://github.com/vm0-ai/vm0/issues/10476)


### Refactoring

* **mitm-addon:** split usage.py into package with per-connector dispatch ([#10478](https://github.com/vm0-ai/vm0/issues/10478)) ([a9d9f14](https://github.com/vm0-ai/vm0/commit/a9d9f14b47de14a3c255b76e1d59e91cf4b2fe37))
* **runner:** make image gc top-n global across rootfs ([#10480](https://github.com/vm0-ai/vm0/issues/10480)) ([3ab0924](https://github.com/vm0-ai/vm0/commit/3ab09242f143ddbc62ad32ebbb2517ee3f0c5f9d))

## [0.89.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.88.6...runner-rs-v0.89.0) (2026-04-21)


### Features

* **runner:** emit vm_reuse telemetry for every reuse decision ([#10441](https://github.com/vm0-ai/vm0/issues/10441)) ([ac947c3](https://github.com/vm0-ai/vm0/commit/ac947c30e57b90312dfba90a2f8fd95a66e91ebe))


### Refactoring

* **billing:** unify connector billing gate on firewall_billable ([#10446](https://github.com/vm0-ai/vm0/issues/10446)) ([d8e23b9](https://github.com/vm0-ai/vm0/commit/d8e23b9b110b3979322ba44869a7cffe6cf289cf))

## [0.88.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.88.5...runner-rs-v0.88.6) (2026-04-21)

## [0.88.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.88.4...runner-rs-v0.88.5) (2026-04-21)


### Bug Fixes

* **billing:** gate model-provider proxy usage to vm0 meta-provider only ([#10406](https://github.com/vm0-ai/vm0/issues/10406)) ([8370578](https://github.com/vm0-ai/vm0/commit/8370578496b91bbaf3a79c0ae6f4c824aabf887c))

## [0.88.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.88.3...runner-rs-v0.88.4) (2026-04-21)


### Bug Fixes

* **runner:** pre-register signal handlers before slow startup ([#10419](https://github.com/vm0-ai/vm0/issues/10419)) ([9c3ec4d](https://github.com/vm0-ai/vm0/commit/9c3ec4daea8fc3f0843655a6b4bfd72519da8629)), closes [#10416](https://github.com/vm0-ai/vm0/issues/10416)

## [0.88.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.88.2...runner-rs-v0.88.3) (2026-04-21)


### Refactoring

* **firewalls:** drop redundant ref field, use name everywhere ([#10353](https://github.com/vm0-ai/vm0/issues/10353)) ([87cd67e](https://github.com/vm0-ai/vm0/commit/87cd67e6a1c47a0bf69f388907f317f4cdf52246))

## [0.88.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.88.1...runner-rs-v0.88.2) (2026-04-20)


### Bug Fixes

* **mitm-addon:** return after url rewrite forward failure ([#10351](https://github.com/vm0-ai/vm0/issues/10351)) ([143baf2](https://github.com/vm0-ai/vm0/commit/143baf210c2a255f9633fbe86411596a5d8a7a68)), closes [#10341](https://github.com/vm0-ai/vm0/issues/10341)

## [0.88.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.88.0...runner-rs-v0.88.1) (2026-04-20)


### Bug Fixes

* **firewall:** force-refresh oauth token when provider returns 401 ([#9860](https://github.com/vm0-ai/vm0/issues/9860)) ([#10294](https://github.com/vm0-ai/vm0/issues/10294)) ([96fcb01](https://github.com/vm0-ai/vm0/commit/96fcb01248e71bf5ce2ed24d7b6bfafd3ba1394f))

## [0.88.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.87.2...runner-rs-v0.88.0) (2026-04-20)


### Features

* **runner:** emit sandbox id and reuse result in completion payload ([#10303](https://github.com/vm0-ai/vm0/issues/10303)) ([a5699ac](https://github.com/vm0-ai/vm0/commit/a5699ac69c35971f6c419f21799a30caf9017893))


### Bug Fixes

* **runner:** tolerate runner-exit race in service drain/resume ([#10302](https://github.com/vm0-ai/vm0/issues/10302)) ([4e0be4c](https://github.com/vm0-ai/vm0/commit/4e0be4c01218fc143f01845f2370b1d40945537c))

## [0.87.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.87.1...runner-rs-v0.87.2) (2026-04-20)


### Bug Fixes

* **mitm-addon:** return decompressed bytes for empty-body frames ([#10293](https://github.com/vm0-ai/vm0/issues/10293)) ([d68f78f](https://github.com/vm0-ai/vm0/commit/d68f78f4b1973bd9d40d9725477b63801bc73582))
* **runner:** clean up stale .tmp file when systemd unit rename fails ([#10295](https://github.com/vm0-ai/vm0/issues/10295)) ([0bf5dcf](https://github.com/vm0-ai/vm0/commit/0bf5dcfb91e5778857a81deafca7a1e942ce8343))

## [0.87.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.87.0...runner-rs-v0.87.1) (2026-04-20)


### Bug Fixes

* **runner:** clarify stderr tracing init doc comment ([#10280](https://github.com/vm0-ai/vm0/issues/10280)) ([3e4f553](https://github.com/vm0-ai/vm0/commit/3e4f5531716430384f15910bfe55fbda43d1e283))

## [0.87.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.86.4...runner-rs-v0.87.0) (2026-04-20)


### Features

* **observability:** add startup and wrap-up latency telemetry ([#10257](https://github.com/vm0-ai/vm0/issues/10257)) ([33028a1](https://github.com/vm0-ai/vm0/commit/33028a10e8ad6218d0255ed69c9af8ba88f41f1a)), closes [#9936](https://github.com/vm0-ai/vm0/issues/9936)


### Bug Fixes

* **mitm-addon:** narrow webhook retry catch to retryable errors ([#10228](https://github.com/vm0-ai/vm0/issues/10228)) ([03ee3c8](https://github.com/vm0-ai/vm0/commit/03ee3c8be82672a545aae9cab9266df51715f9f4))
* **runner:** count dry-run bytes in gc_nested_images ([#10232](https://github.com/vm0-ai/vm0/issues/10232)) ([79910d7](https://github.com/vm0-ai/vm0/commit/79910d7272e954b04532fc6573276839c91f2f0b))
* **runner:** delay first interval tick to avoid racing discover_fut ([#10219](https://github.com/vm0-ai/vm0/issues/10219)) ([a7a3006](https://github.com/vm0-ai/vm0/commit/a7a30068caa0265e4572f0c81ade09465cfeaae1))

## [0.86.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.86.3...runner-rs-v0.86.4) (2026-04-20)

## [0.86.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.86.2...runner-rs-v0.86.3) (2026-04-20)


### Bug Fixes

* **mitm-addon:** use flow.request.scheme for original url ([#10180](https://github.com/vm0-ai/vm0/issues/10180)) ([4d01162](https://github.com/vm0-ai/vm0/commit/4d01162b0b8b00c644c52f99f1825d8e39a23859))


### Refactoring

* **mitm-addon:** tighten original_url invariant in response/error ([#10189](https://github.com/vm0-ai/vm0/issues/10189)) ([bf230ad](https://github.com/vm0-ai/vm0/commit/bf230add14c1d3b59ee96eb628c31c9822c123a9))

## [0.86.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.86.1...runner-rs-v0.86.2) (2026-04-19)


### Bug Fixes

* **mitm-addon:** enforce decompress_body memory cap for zstd ([#10144](https://github.com/vm0-ai/vm0/issues/10144)) ([8f77ac8](https://github.com/vm0-ai/vm0/commit/8f77ac8bd0420a95672485a862393c41db38df86))
* **mitm-addon:** log and short-circuit broken stream decompressors ([#10132](https://github.com/vm0-ai/vm0/issues/10132)) ([c82afd2](https://github.com/vm0-ai/vm0/commit/c82afd2b1ffdb9b09cdf62635995372476f680a2))

## [0.86.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.86.0...runner-rs-v0.86.1) (2026-04-19)


### Refactoring

* **mitm-addon:** remove remaining private-entry test sites ([#10101](https://github.com/vm0-ai/vm0/issues/10101)) ([#10112](https://github.com/vm0-ai/vm0/issues/10112)) ([9aadbed](https://github.com/vm0-ai/vm0/commit/9aadbedff1f8a7435a8bf2cb4addf03efe376f30))

## [0.86.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.85.4...runner-rs-v0.86.0) (2026-04-19)


### Features

* **firewall:** accept mixed {param}{literal} segments in url patterns ([#10081](https://github.com/vm0-ai/vm0/issues/10081)) ([2b58902](https://github.com/vm0-ai/vm0/commit/2b589020d004ed7a99b461ee32609534d02cda18))


### Refactoring

* **mitm-addon:** push usage tests from internal stubs to _opener ([#9991](https://github.com/vm0-ai/vm0/issues/9991)) ([#10097](https://github.com/vm0-ai/vm0/issues/10097)) ([c4f0f6a](https://github.com/vm0-ai/vm0/commit/c4f0f6ae88d859938946ad6ad0f48be8075f6da5))

## [0.85.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.85.3...runner-rs-v0.85.4) (2026-04-19)


### Refactoring

* **mitm-addon:** delete redundant tests and annotate kept assertions ([#9991](https://github.com/vm0-ai/vm0/issues/9991)) ([#10079](https://github.com/vm0-ai/vm0/issues/10079)) ([beaba54](https://github.com/vm0-ai/vm0/commit/beaba5468a40d64d7af2b8f7af8e6a637a926784))
* **mitm-addon:** promote shared fixtures and drop test-local flow mocks ([#10011](https://github.com/vm0-ai/vm0/issues/10011)) ([0eef5d9](https://github.com/vm0-ai/vm0/commit/0eef5d978d8cd39b06154f2618b62cda51b2a0a6))
* **mitm-addon:** rewrite dispatcher and usage-report tests with outcome assertions ([#9991](https://github.com/vm0-ai/vm0/issues/9991)) ([#10080](https://github.com/vm0-ai/vm0/issues/10080)) ([3015a32](https://github.com/vm0-ai/vm0/commit/3015a32fbf6e182c579ae068942b982a06d19d46))

## [0.85.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.85.2...runner-rs-v0.85.3) (2026-04-18)


### Bug Fixes

* **mitm-addon:** warn on log_proxy_entry write failure ([#10009](https://github.com/vm0-ai/vm0/issues/10009)) ([1ed578f](https://github.com/vm0-ai/vm0/commit/1ed578fc209a03eec76bd46ad53030fd74399eaf)), closes [#9932](https://github.com/vm0-ai/vm0/issues/9932)

## [0.85.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.85.1...runner-rs-v0.85.2) (2026-04-18)


### Bug Fixes

* **runner:** tighten ca file and directory permissions ([#9994](https://github.com/vm0-ai/vm0/issues/9994)) ([26f493a](https://github.com/vm0-ai/vm0/commit/26f493ab7ca585d18c46d160b61a8caf5e2a4ff0))


### Refactoring

* **mitm-addon:** use real mitmproxy fixtures in test_body_capture ([#9987](https://github.com/vm0-ai/vm0/issues/9987)) ([5389082](https://github.com/vm0-ai/vm0/commit/5389082069ab4443d0bcde85b40aa33797525a08))

## [0.85.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.85.0...runner-rs-v0.85.1) (2026-04-18)

## [0.85.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.84.0...runner-rs-v0.85.0) (2026-04-18)


### Features

* add test-oauth connector for end-to-end oauth testing ([#9878](https://github.com/vm0-ai/vm0/issues/9878)) ([e8be957](https://github.com/vm0-ai/vm0/commit/e8be957b65578f32d6ca87a6f1eb248ee5737726))


### Refactoring

* **ansible:** split deploy-runner.yml into build and promote ([#9890](https://github.com/vm0-ai/vm0/issues/9890)) ([5239678](https://github.com/vm0-ai/vm0/commit/5239678391428f9107436d40bbff8c5bb12af8c7))


### Performance Improvements

* **runner:** defer best-effort telemetry past provider.complete ([#9828](https://github.com/vm0-ai/vm0/issues/9828)) ([14fd7ae](https://github.com/vm0-ai/vm0/commit/14fd7ae194e6672535f3076527ed5f4ed0ba7aa8))

## [0.84.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.83.0...runner-rs-v0.84.0) (2026-04-17)


### Features

* **runner:** split drain and stop with stopping state and service resume ([#9817](https://github.com/vm0-ai/vm0/issues/9817)) ([148d5ea](https://github.com/vm0-ai/vm0/commit/148d5ea463e973494a1fb9a95659b70744c7569a))

## [0.83.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.82.4...runner-rs-v0.83.0) (2026-04-17)


### Features

* add auth.query support to firewall schema for query-parameter authentication ([#9583](https://github.com/vm0-ai/vm0/issues/9583)) ([c39727a](https://github.com/vm0-ai/vm0/commit/c39727abd12ddd86271294324cf352fe86f96658))
* add feature flag to control sandbox reuse logic ([#8987](https://github.com/vm0-ai/vm0/issues/8987)) ([e77a8a0](https://github.com/vm0-ai/vm0/commit/e77a8a0c2974d91786f11d7119d87ba8fe07a6dd))
* **runner:** inflate sandbox balloon when parked in idle pool ([#9118](https://github.com/vm0-ai/vm0/issues/9118)) ([628032d](https://github.com/vm0-ai/vm0/commit/628032dbf3543d3387b6559263c31ee273f24986))
* **runner:** observe per-call x api connector usage in mitmproxy addon ([#9511](https://github.com/vm0-ai/vm0/issues/9511)) ([1cf4a59](https://github.com/vm0-ai/vm0/commit/1cf4a595a8789b86d9ed5c2f29cba433a99f7dde))
* **runner:** parse x ndjson streams incrementally and bound buffer ([#9551](https://github.com/vm0-ai/vm0/issues/9551)) ([f82b20d](https://github.com/vm0-ai/vm0/commit/f82b20d50575ba3ea45651fcdde5732348a8bada))
* **runner:** per-job mitmproxy proxy log files ([#9239](https://github.com/vm0-ai/vm0/issues/9239)) ([1ea7fa4](https://github.com/vm0-ai/vm0/commit/1ea7fa4d2efc1418dc3ac3e6364793f35b8d0ff6)), closes [#9227](https://github.com/vm0-ai/vm0/issues/9227)
* **runner:** require --force for service stop/uninstall with active jobs ([#9093](https://github.com/vm0-ai/vm0/issues/9093)) ([399164e](https://github.com/vm0-ai/vm0/commit/399164e015d366fec791f1df7542387bb4c7c703))
* store connector billing in database via webhook ([#9678](https://github.com/vm0-ai/vm0/issues/9678)) ([105724f](https://github.com/vm0-ai/vm0/commit/105724f670637fdc16022907a97d0ab57b0b607c))


### Bug Fixes

* **billing:** trust parsed response counts for x connector billing ([#9644](https://github.com/vm0-ai/vm0/issues/9644)) ([321cbf0](https://github.com/vm0-ai/vm0/commit/321cbf0adeb46fa0943be991a0b4652fcf399e77)), closes [#9620](https://github.com/vm0-ai/vm0/issues/9620)
* **chat:** regenerate chat_messages migration and add eslint exceptions ([a5ee0da](https://github.com/vm0-ai/vm0/commit/a5ee0da96c7588faa573bbe7466b1d5ec516f4af))
* inject firewall for enabled connectors regardless of secret availability ([#9656](https://github.com/vm0-ai/vm0/issues/9656)) ([3f10868](https://github.com/vm0-ai/vm0/commit/3f108689ff2a595498d27c388726253085270bc6))
* kill child process on error paths to prevent orphans ([#9267](https://github.com/vm0-ai/vm0/issues/9267)) ([16b1686](https://github.com/vm0-ai/vm0/commit/16b1686449c1913184dba9c93195baff74d107b8))
* log directory iteration errors in gc instead of silently swallowing ([#9036](https://github.com/vm0-ai/vm0/issues/9036)) ([da6af3c](https://github.com/vm0-ai/vm0/commit/da6af3c67e7beaf4e9fdef5d28958f09cba62e56))
* log directory iteration errors instead of silently swallowing ([#9333](https://github.com/vm0-ai/vm0/issues/9333)) ([a48fdde](https://github.com/vm0-ai/vm0/commit/a48fdde6bfd523dd1593e23870eb8ea82f40d6b0)), closes [#9037](https://github.com/vm0-ai/vm0/issues/9037)
* **proxy:** add structured logging for model provider usage report lifecycle ([#9666](https://github.com/vm0-ai/vm0/issues/9666)) ([196d85a](https://github.com/vm0-ai/vm0/commit/196d85a0f1a31f0324ccded23593c8e2b66293ac))
* rely on keytool rpath for libjli.so in chroot invocations ([#9533](https://github.com/vm0-ai/vm0/issues/9533)) ([3b950af](https://github.com/vm0-ai/vm0/commit/3b950af12bd9dfd98d22123d57a4dc0affef9289)), closes [#9483](https://github.com/vm0-ai/vm0/issues/9483)
* **runner:** abort stdout drain task on wait_exit timeout or crash ([#9021](https://github.com/vm0-ai/vm0/issues/9021)) ([d6b021e](https://github.com/vm0-ai/vm0/commit/d6b021e5f97b432006e969efd45f3b29debb4909)), closes [#8970](https://github.com/vm0-ai/vm0/issues/8970)
* **runner:** add --protect-version flag to prevent gc from deleting deployed version ([#9260](https://github.com/vm0-ai/vm0/issues/9260)) ([40de60a](https://github.com/vm0-ai/vm0/commit/40de60afd78b0806d08650f80a5b2269b86df661))
* **runner:** add cached field to storage manifest for correct cleanup preservation ([#8993](https://github.com/vm0-ai/vm0/issues/8993)) ([d9db456](https://github.com/vm0-ai/vm0/commit/d9db4569ef6f86fdf46063d65a9aad34ca7a6b2a)), closes [#8982](https://github.com/vm0-ai/vm0/issues/8982)
* **runner:** add drop impl to kmsg handle to prevent task leak on early return ([#8958](https://github.com/vm0-ai/vm0/issues/8958)) ([64c26e6](https://github.com/vm0-ai/vm0/commit/64c26e6adf0785f74ff9217bfde1267a721d3b83))
* **runner:** add missing doc comment on init_tracing_stderr ([#9553](https://github.com/vm0-ai/vm0/issues/9553)) ([ba44fd4](https://github.com/vm0-ai/vm0/commit/ba44fd497e8d2bb51f721ea7fdbd69a6863e874a))
* **runner:** add upper-bound validation for profile resource limits ([#9015](https://github.com/vm0-ai/vm0/issues/9015)) ([d774aca](https://github.com/vm0-ai/vm0/commit/d774aca8bb1fa71635fdb15692378e634edc2d10)), closes [#9009](https://github.com/vm0-ai/vm0/issues/9009)
* **runner:** escape % in systemd values to prevent specifier expansion ([#9499](https://github.com/vm0-ai/vm0/issues/9499)) ([5eb4e12](https://github.com/vm0-ai/vm0/commit/5eb4e12fbe3fb652a0969c163357875ac1c25766))
* **runner:** escape quotes and backslashes in systemd env values ([#9467](https://github.com/vm0-ai/vm0/issues/9467)) ([b7b5f51](https://github.com/vm0-ai/vm0/commit/b7b5f5155e0e4dfadb16dfc74358d94c4dac9ff1))
* **runner:** handle quoted paths with spaces in parse_unit_config_path ([#9242](https://github.com/vm0-ai/vm0/issues/9242)) ([53cd507](https://github.com/vm0-ai/vm0/commit/53cd5070285654944ccb661f5f2d916a0cb6cf5e))
* **runner:** harden mitmproxy usage report flush during shutdown ([#9234](https://github.com/vm0-ai/vm0/issues/9234)) ([08e65c7](https://github.com/vm0-ai/vm0/commit/08e65c76b45358b387a48078320ceb5f19c19e32)), closes [#9228](https://github.com/vm0-ai/vm0/issues/9228)
* **runner:** include host kernel version in image hash ([#9305](https://github.com/vm0-ai/vm0/issues/9305)) ([b30bc7d](https://github.com/vm0-ai/vm0/commit/b30bc7d447bc88c5753f9d8c30b90c873ccb993d))
* **runner:** invalidate image cache and skip remote cache on deploy ([#9300](https://github.com/vm0-ai/vm0/issues/9300)) ([67ce548](https://github.com/vm0-ai/vm0/commit/67ce548f3f7a5feff97ba7f882562f5bfef200c6))
* **runner:** make build-rootfs.sh cleanup safe against umount failure ([#9528](https://github.com/vm0-ai/vm0/issues/9528)) ([7bf8952](https://github.com/vm0-ai/vm0/commit/7bf89529febd1cded732e7c388af1cfd5af17f66))
* **runner:** narrow is_lock_free error handling to avoid false-positive orphan warnings ([#9268](https://github.com/vm0-ai/vm0/issues/9268)) ([6806c8b](https://github.com/vm0-ai/vm0/commit/6806c8b30d83662636d695b51b259a28626120b6))
* **runner:** only count successfully removed locks in gc_orphaned_locks ([#9645](https://github.com/vm0-ai/vm0/issues/9645)) ([e364fa0](https://github.com/vm0-ai/vm0/commit/e364fa0150e38926c7a63d2f227f529c3fae1e99)), closes [#9585](https://github.com/vm0-ai/vm0/issues/9585)
* **runner:** remove claim file when job read or parse fails ([#9740](https://github.com/vm0-ai/vm0/issues/9740)) ([c5df0f6](https://github.com/vm0-ai/vm0/commit/c5df0f6c36b168f823b2fb2af4c708695731dabc)), closes [#9689](https://github.com/vm0-ai/vm0/issues/9689)
* **runner:** retry dnsmasq startup on port conflict ([#9257](https://github.com/vm0-ai/vm0/issues/9257)) ([3db33df](https://github.com/vm0-ai/vm0/commit/3db33df21828764734f5f0b2b30dbc6ee5303745)), closes [#9250](https://github.com/vm0-ai/vm0/issues/9250)
* **runner:** shell-quote exec arguments before joining ([#9052](https://github.com/vm0-ai/vm0/issues/9052)) ([44e0d4d](https://github.com/vm0-ai/vm0/commit/44e0d4d0c29146259acce856c3d6642a90441f6c))
* **runner:** stop poison job loop and unblock submitter on invalid job json ([#9748](https://github.com/vm0-ai/vm0/issues/9748)) ([4d4de58](https://github.com/vm0-ai/vm0/commit/4d4de5897dfc715b0b555c2c4e49a5f6c999b1d1))
* **runner:** switch log timestamps from elapsed-since-startup to wall-clock utc ([#9232](https://github.com/vm0-ai/vm0/issues/9232)) ([216f251](https://github.com/vm0-ai/vm0/commit/216f251989445c06e0b0b9e3335370bd2622cbd5))
* **runner:** use continue instead of break on /proc entry read error ([#9661](https://github.com/vm0-ai/vm0/issues/9661)) ([96fa8b5](https://github.com/vm0-ai/vm0/commit/96fa8b53199fa50ecc962cf9cbd8ac7d8574d1dd)), closes [#9657](https://github.com/vm0-ai/vm0/issues/9657)
* **runner:** use proper url parsing for .test tld check in doctor ([#9237](https://github.com/vm0-ai/vm0/issues/9237)) ([6f5dd87](https://github.com/vm0-ai/vm0/commit/6f5dd8707f850a4d1b0766ce3bd9b0ab83b0ca78))
* **runner:** validate --concurrency-factor in run_config before writing config ([#9653](https://github.com/vm0-ai/vm0/issues/9653)) ([4b5d0bb](https://github.com/vm0-ai/vm0/commit/4b5d0bbaf78219feceb2d55b492611825af76769)), closes [#9650](https://github.com/vm0-ai/vm0/issues/9650)
* **runner:** validate --group name to prevent path traversal ([#9104](https://github.com/vm0-ai/vm0/issues/9104)) ([b7e75dc](https://github.com/vm0-ai/vm0/commit/b7e75dc2f74419c441c6e62eda3db1bd3cf93f87)), closes [#9099](https://github.com/vm0-ai/vm0/issues/9099)
* **runner:** validate --runner-dirname to prevent path traversal ([#9134](https://github.com/vm0-ai/vm0/issues/9134)) ([b511508](https://github.com/vm0-ai/vm0/commit/b51150884503ecc81e3180737ea11ca12b46f127))
* **runner:** validate image_hash to prevent path traversal ([#9178](https://github.com/vm0-ai/vm0/issues/9178)) ([2e4d3e2](https://github.com/vm0-ai/vm0/commit/2e4d3e2adce1076161346f244ad00b8f8d308353))
* **runner:** verify ca landed in system bundle after inject-ca ([#9530](https://github.com/vm0-ai/vm0/issues/9530)) ([951aa87](https://github.com/vm0-ai/vm0/commit/951aa87ff5862db4e8df710677b6d61e9257bcec))
* **runner:** wait for proxy usage reports to flush before stopping mitmdump ([#9687](https://github.com/vm0-ai/vm0/issues/9687)) ([3518dcd](https://github.com/vm0-ai/vm0/commit/3518dcdfaf3f69fe16a618fa2b9069f9dfeabcab))
* **runner:** write systemd unit file atomically via tmp + rename ([#9503](https://github.com/vm0-ai/vm0/issues/9503)) ([c113be1](https://github.com/vm0-ai/vm0/commit/c113be117bce16402574be59a5073f3d2c650f50)), closes [#9471](https://github.com/vm0-ai/vm0/issues/9471)
* **security:** scope anthropic firewall to /v1/messages path prefix ([#9566](https://github.com/vm0-ai/vm0/issues/9566)) ([8e94112](https://github.com/vm0-ai/vm0/commit/8e9411224f069fa690edf6fb899e0679359d907a)), closes [#9560](https://github.com/vm0-ai/vm0/issues/9560)
* split r2 image cache to rootfs only with local snapshot creation ([#9461](https://github.com/vm0-ai/vm0/issues/9461)) ([417b864](https://github.com/vm0-ai/vm0/commit/417b864287b05d84295c5f6e28ce3f75e6289469))
* upgrade debug-level log to warn in gc read_to_string failure ([#9345](https://github.com/vm0-ai/vm0/issues/9345)) ([8a0813e](https://github.com/vm0-ai/vm0/commit/8a0813eb79ec673c22c0881bfec66e75986869c3)), closes [#9334](https://github.com/vm0-ai/vm0/issues/9334)


### Refactoring

* **chat:** decouple chat threads from runs with dedicated chat_messages table ([#9296](https://github.com/vm0-ai/vm0/issues/9296)) ([a5ee0da](https://github.com/vm0-ai/vm0/commit/a5ee0da96c7588faa573bbe7466b1d5ec516f4af))
* **firewalls:** make auth.headers optional in firewall schema ([#9617](https://github.com/vm0-ai/vm0/issues/9617)) ([657b74f](https://github.com/vm0-ai/vm0/commit/657b74fcb19080e58a61ec7d1005eec89a617627))
* **proxy:** return connector types instead of missing secret names in 424 response ([#9676](https://github.com/vm0-ai/vm0/issues/9676)) ([1de69bb](https://github.com/vm0-ai/vm0/commit/1de69bbc9648daf8447bb99027ffbf4b264b720f))
* **runner:** deduplicate guest state restore in executor ([#9289](https://github.com/vm0-ai/vm0/issues/9289)) ([fea8ef2](https://github.com/vm0-ai/vm0/commit/fea8ef2055cec702bd72bf488f711c4bafc20754))
* **runner:** make sandbox_id a first-class identity distinct from run_id ([#9555](https://github.com/vm0-ai/vm0/issues/9555)) ([9cfd2a8](https://github.com/vm0-ai/vm0/commit/9cfd2a8d239f1c54c3c8e25c9adb2759d9b12efa))
* **runner:** split image hash into rootfs_hash and snapshot_hash ([#9622](https://github.com/vm0-ai/vm0/issues/9622)) ([bbeaa44](https://github.com/vm0-ai/vm0/commit/bbeaa44f59d3066caa78348c45f98617fda18b02))
* **runner:** split mitm_addon.py into usage.py and body_utils.py ([#9478](https://github.com/vm0-ai/vm0/issues/9478)) ([7be4518](https://github.com/vm0-ai/vm0/commit/7be4518db26eeccad810c4d18b13f1b81c109975))
* **runner:** surface r2 gc pagination invariant violations as errors ([#9200](https://github.com/vm0-ai/vm0/issues/9200)) ([186405a](https://github.com/vm0-ai/vm0/commit/186405af8df8ceeba22cee0295e7cc6657d7d652))
* **runner:** unify runner-dirname and service-name validators ([#9319](https://github.com/vm0-ai/vm0/issues/9319)) ([4ffa81f](https://github.com/vm0-ai/vm0/commit/4ffa81f15546b49735cb58fd1aa55c9a862351a2)), closes [#9145](https://github.com/vm0-ai/vm0/issues/9145)
* use proxy-reported usage as billing source of truth ([#9064](https://github.com/vm0-ai/vm0/issues/9064)) ([b655964](https://github.com/vm0-ai/vm0/commit/b65596423f8655117ebd67c38731eb5f35c332b7))


### Performance Improvements

* **runner:** cache built images on r2 ([#9120](https://github.com/vm0-ai/vm0/issues/9120)) ([bf2f2cd](https://github.com/vm0-ai/vm0/commit/bf2f2cdeb2956cee5fc5f7466e147d1c4351d3d0))
* **runner:** offload dns and kmsg_log file i/o to blocking pool ([#9741](https://github.com/vm0-ai/vm0/issues/9741)) ([4858807](https://github.com/vm0-ai/vm0/commit/48588070b96a00256857abb90d790c5f43fdaa75))

## [0.82.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.82.3...runner-rs-v0.82.4) (2026-04-17)

## [0.82.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.82.2...runner-rs-v0.82.3) (2026-04-17)

## [0.82.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.82.1...runner-rs-v0.82.2) (2026-04-17)


### Bug Fixes

* **runner:** stop poison job loop and unblock submitter on invalid job json ([#9748](https://github.com/vm0-ai/vm0/issues/9748)) ([4d4de58](https://github.com/vm0-ai/vm0/commit/4d4de5897dfc715b0b555c2c4e49a5f6c999b1d1))

## [0.82.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.82.0...runner-rs-v0.82.1) (2026-04-17)


### Bug Fixes

* **runner:** remove claim file when job read or parse fails ([#9740](https://github.com/vm0-ai/vm0/issues/9740)) ([c5df0f6](https://github.com/vm0-ai/vm0/commit/c5df0f6c36b168f823b2fb2af4c708695731dabc)), closes [#9689](https://github.com/vm0-ai/vm0/issues/9689)


### Performance Improvements

* **runner:** offload dns and kmsg_log file i/o to blocking pool ([#9741](https://github.com/vm0-ai/vm0/issues/9741)) ([4858807](https://github.com/vm0-ai/vm0/commit/48588070b96a00256857abb90d790c5f43fdaa75))

## [0.82.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.81.4...runner-rs-v0.82.0) (2026-04-16)


### Features

* store connector billing in database via webhook ([#9678](https://github.com/vm0-ai/vm0/issues/9678)) ([105724f](https://github.com/vm0-ai/vm0/commit/105724f670637fdc16022907a97d0ab57b0b607c))


### Bug Fixes

* inject firewall for enabled connectors regardless of secret availability ([#9656](https://github.com/vm0-ai/vm0/issues/9656)) ([3f10868](https://github.com/vm0-ai/vm0/commit/3f108689ff2a595498d27c388726253085270bc6))
* **runner:** wait for proxy usage reports to flush before stopping mitmdump ([#9687](https://github.com/vm0-ai/vm0/issues/9687)) ([3518dcd](https://github.com/vm0-ai/vm0/commit/3518dcdfaf3f69fe16a618fa2b9069f9dfeabcab))


### Refactoring

* **proxy:** return connector types instead of missing secret names in 424 response ([#9676](https://github.com/vm0-ai/vm0/issues/9676)) ([1de69bb](https://github.com/vm0-ai/vm0/commit/1de69bbc9648daf8447bb99027ffbf4b264b720f))

## [0.81.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.81.3...runner-rs-v0.81.4) (2026-04-16)


### Bug Fixes

* **runner:** use continue instead of break on /proc entry read error ([#9661](https://github.com/vm0-ai/vm0/issues/9661)) ([96fa8b5](https://github.com/vm0-ai/vm0/commit/96fa8b53199fa50ecc962cf9cbd8ac7d8574d1dd)), closes [#9657](https://github.com/vm0-ai/vm0/issues/9657)
* **runner:** validate --concurrency-factor in run_config before writing config ([#9653](https://github.com/vm0-ai/vm0/issues/9653)) ([4b5d0bb](https://github.com/vm0-ai/vm0/commit/4b5d0bbaf78219feceb2d55b492611825af76769)), closes [#9650](https://github.com/vm0-ai/vm0/issues/9650)

## [0.81.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.81.2...runner-rs-v0.81.3) (2026-04-16)


### Bug Fixes

* **billing:** trust parsed response counts for x connector billing ([#9644](https://github.com/vm0-ai/vm0/issues/9644)) ([321cbf0](https://github.com/vm0-ai/vm0/commit/321cbf0adeb46fa0943be991a0b4652fcf399e77)), closes [#9620](https://github.com/vm0-ai/vm0/issues/9620)
* **runner:** only count successfully removed locks in gc_orphaned_locks ([#9645](https://github.com/vm0-ai/vm0/issues/9645)) ([e364fa0](https://github.com/vm0-ai/vm0/commit/e364fa0150e38926c7a63d2f227f529c3fae1e99)), closes [#9585](https://github.com/vm0-ai/vm0/issues/9585)

## [0.81.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.81.1...runner-rs-v0.81.2) (2026-04-16)


### Refactoring

* **firewalls:** make auth.headers optional in firewall schema ([#9617](https://github.com/vm0-ai/vm0/issues/9617)) ([657b74f](https://github.com/vm0-ai/vm0/commit/657b74fcb19080e58a61ec7d1005eec89a617627))
* **runner:** split image hash into rootfs_hash and snapshot_hash ([#9622](https://github.com/vm0-ai/vm0/issues/9622)) ([bbeaa44](https://github.com/vm0-ai/vm0/commit/bbeaa44f59d3066caa78348c45f98617fda18b02))

## [0.81.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.81.0...runner-rs-v0.81.1) (2026-04-16)


### Refactoring

* **runner:** make sandbox_id a first-class identity distinct from run_id ([#9555](https://github.com/vm0-ai/vm0/issues/9555)) ([9cfd2a8](https://github.com/vm0-ai/vm0/commit/9cfd2a8d239f1c54c3c8e25c9adb2759d9b12efa))

## [0.81.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.80.1...runner-rs-v0.81.0) (2026-04-16)


### Features

* add auth.query support to firewall schema for query-parameter authentication ([#9583](https://github.com/vm0-ai/vm0/issues/9583)) ([c39727a](https://github.com/vm0-ai/vm0/commit/c39727abd12ddd86271294324cf352fe86f96658))

## [0.80.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.80.0...runner-rs-v0.80.1) (2026-04-16)


### Bug Fixes

* **security:** scope anthropic firewall to /v1/messages path prefix ([#9566](https://github.com/vm0-ai/vm0/issues/9566)) ([8e94112](https://github.com/vm0-ai/vm0/commit/8e9411224f069fa690edf6fb899e0679359d907a)), closes [#9560](https://github.com/vm0-ai/vm0/issues/9560)

## [0.80.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.13...runner-rs-v0.80.0) (2026-04-16)


### Features

* **runner:** parse x ndjson streams incrementally and bound buffer ([#9551](https://github.com/vm0-ai/vm0/issues/9551)) ([f82b20d](https://github.com/vm0-ai/vm0/commit/f82b20d50575ba3ea45651fcdde5732348a8bada))

## [0.79.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.12...runner-rs-v0.79.13) (2026-04-15)


### Bug Fixes

* **runner:** add missing doc comment on init_tracing_stderr ([#9553](https://github.com/vm0-ai/vm0/issues/9553)) ([ba44fd4](https://github.com/vm0-ai/vm0/commit/ba44fd497e8d2bb51f721ea7fdbd69a6863e874a))

## [0.79.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.11...runner-rs-v0.79.12) (2026-04-15)


### Bug Fixes

* rely on keytool rpath for libjli.so in chroot invocations ([#9533](https://github.com/vm0-ai/vm0/issues/9533)) ([3b950af](https://github.com/vm0-ai/vm0/commit/3b950af12bd9dfd98d22123d57a4dc0affef9289)), closes [#9483](https://github.com/vm0-ai/vm0/issues/9483)
* **runner:** make build-rootfs.sh cleanup safe against umount failure ([#9528](https://github.com/vm0-ai/vm0/issues/9528)) ([7bf8952](https://github.com/vm0-ai/vm0/commit/7bf89529febd1cded732e7c388af1cfd5af17f66))

## [0.79.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.10...runner-rs-v0.79.11) (2026-04-15)


### Bug Fixes

* **runner:** verify ca landed in system bundle after inject-ca ([#9530](https://github.com/vm0-ai/vm0/issues/9530)) ([951aa87](https://github.com/vm0-ai/vm0/commit/951aa87ff5862db4e8df710677b6d61e9257bcec))

## [0.79.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.9...runner-rs-v0.79.10) (2026-04-15)


### Bug Fixes

* **runner:** escape % in systemd values to prevent specifier expansion ([#9499](https://github.com/vm0-ai/vm0/issues/9499)) ([5eb4e12](https://github.com/vm0-ai/vm0/commit/5eb4e12fbe3fb652a0969c163357875ac1c25766))

## [0.79.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.8...runner-rs-v0.79.9) (2026-04-15)


### Refactoring

* **runner:** split mitm_addon.py into usage.py and body_utils.py ([#9478](https://github.com/vm0-ai/vm0/issues/9478)) ([7be4518](https://github.com/vm0-ai/vm0/commit/7be4518db26eeccad810c4d18b13f1b81c109975))

## [0.79.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.7...runner-rs-v0.79.8) (2026-04-15)


### Bug Fixes

* **runner:** escape quotes and backslashes in systemd env values ([#9467](https://github.com/vm0-ai/vm0/issues/9467)) ([b7b5f51](https://github.com/vm0-ai/vm0/commit/b7b5f5155e0e4dfadb16dfc74358d94c4dac9ff1))
* split r2 image cache to rootfs only with local snapshot creation ([#9461](https://github.com/vm0-ai/vm0/issues/9461)) ([417b864](https://github.com/vm0-ai/vm0/commit/417b864287b05d84295c5f6e28ce3f75e6289469))

## [0.79.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.6...runner-rs-v0.79.7) (2026-04-14)


### Bug Fixes

* log directory iteration errors instead of silently swallowing ([#9333](https://github.com/vm0-ai/vm0/issues/9333)) ([a48fdde](https://github.com/vm0-ai/vm0/commit/a48fdde6bfd523dd1593e23870eb8ea82f40d6b0)), closes [#9037](https://github.com/vm0-ai/vm0/issues/9037)
* **runner:** include host kernel version in image hash ([#9305](https://github.com/vm0-ai/vm0/issues/9305)) ([b30bc7d](https://github.com/vm0-ai/vm0/commit/b30bc7d447bc88c5753f9d8c30b90c873ccb993d))
* upgrade debug-level log to warn in gc read_to_string failure ([#9345](https://github.com/vm0-ai/vm0/issues/9345)) ([8a0813e](https://github.com/vm0-ai/vm0/commit/8a0813eb79ec673c22c0881bfec66e75986869c3)), closes [#9334](https://github.com/vm0-ai/vm0/issues/9334)

## [0.79.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.5...runner-rs-v0.79.6) (2026-04-14)

## [0.79.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.4...runner-rs-v0.79.5) (2026-04-14)

## [0.79.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.3...runner-rs-v0.79.4) (2026-04-14)


### Bug Fixes

* kill child process on error paths to prevent orphans ([#9267](https://github.com/vm0-ai/vm0/issues/9267)) ([16b1686](https://github.com/vm0-ai/vm0/commit/16b1686449c1913184dba9c93195baff74d107b8))
* **runner:** invalidate image cache and skip remote cache on deploy ([#9300](https://github.com/vm0-ai/vm0/issues/9300)) ([67ce548](https://github.com/vm0-ai/vm0/commit/67ce548f3f7a5feff97ba7f882562f5bfef200c6))


### Refactoring

* **runner:** deduplicate guest state restore in executor ([#9289](https://github.com/vm0-ai/vm0/issues/9289)) ([fea8ef2](https://github.com/vm0-ai/vm0/commit/fea8ef2055cec702bd72bf488f711c4bafc20754))

## [0.79.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.2...runner-rs-v0.79.3) (2026-04-14)

## [0.79.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.1...runner-rs-v0.79.2) (2026-04-14)


### Bug Fixes

* **runner:** add --protect-version flag to prevent gc from deleting deployed version ([#9260](https://github.com/vm0-ai/vm0/issues/9260)) ([40de60a](https://github.com/vm0-ai/vm0/commit/40de60afd78b0806d08650f80a5b2269b86df661))

## [0.79.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.0...runner-rs-v0.79.1) (2026-04-14)


### Bug Fixes

* **runner:** retry dnsmasq startup on port conflict ([#9257](https://github.com/vm0-ai/vm0/issues/9257)) ([3db33df](https://github.com/vm0-ai/vm0/commit/3db33df21828764734f5f0b2b30dbc6ee5303745)), closes [#9250](https://github.com/vm0-ai/vm0/issues/9250)

## [0.79.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.78.3...runner-rs-v0.79.0) (2026-04-14)


### Features

* **runner:** per-job mitmproxy proxy log files ([#9239](https://github.com/vm0-ai/vm0/issues/9239)) ([1ea7fa4](https://github.com/vm0-ai/vm0/commit/1ea7fa4d2efc1418dc3ac3e6364793f35b8d0ff6)), closes [#9227](https://github.com/vm0-ai/vm0/issues/9227)


### Bug Fixes

* **runner:** harden mitmproxy usage report flush during shutdown ([#9234](https://github.com/vm0-ai/vm0/issues/9234)) ([08e65c7](https://github.com/vm0-ai/vm0/commit/08e65c76b45358b387a48078320ceb5f19c19e32)), closes [#9228](https://github.com/vm0-ai/vm0/issues/9228)

## [0.78.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.78.2...runner-rs-v0.78.3) (2026-04-14)


### Bug Fixes

* **runner:** switch log timestamps from elapsed-since-startup to wall-clock utc ([#9232](https://github.com/vm0-ai/vm0/issues/9232)) ([216f251](https://github.com/vm0-ai/vm0/commit/216f251989445c06e0b0b9e3335370bd2622cbd5))
* **runner:** use proper url parsing for .test tld check in doctor ([#9237](https://github.com/vm0-ai/vm0/issues/9237)) ([6f5dd87](https://github.com/vm0-ai/vm0/commit/6f5dd8707f850a4d1b0766ce3bd9b0ab83b0ca78))

## [0.78.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.78.1...runner-rs-v0.78.2) (2026-04-13)


### Refactoring

* **runner:** surface r2 gc pagination invariant violations as errors ([#9200](https://github.com/vm0-ai/vm0/issues/9200)) ([186405a](https://github.com/vm0-ai/vm0/commit/186405af8df8ceeba22cee0295e7cc6657d7d652))

## [0.78.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.78.0...runner-rs-v0.78.1) (2026-04-13)


### Bug Fixes

* **runner:** validate image_hash to prevent path traversal ([#9178](https://github.com/vm0-ai/vm0/issues/9178)) ([2e4d3e2](https://github.com/vm0-ai/vm0/commit/2e4d3e2adce1076161346f244ad00b8f8d308353))

## [0.78.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.77.1...runner-rs-v0.78.0) (2026-04-13)


### Features

* **runner:** inflate sandbox balloon when parked in idle pool ([#9118](https://github.com/vm0-ai/vm0/issues/9118)) ([628032d](https://github.com/vm0-ai/vm0/commit/628032dbf3543d3387b6559263c31ee273f24986))


### Bug Fixes

* **runner:** validate --runner-dirname to prevent path traversal ([#9134](https://github.com/vm0-ai/vm0/issues/9134)) ([b511508](https://github.com/vm0-ai/vm0/commit/b51150884503ecc81e3180737ea11ca12b46f127))


### Performance Improvements

* **runner:** cache built images on r2 ([#9120](https://github.com/vm0-ai/vm0/issues/9120)) ([bf2f2cd](https://github.com/vm0-ai/vm0/commit/bf2f2cdeb2956cee5fc5f7466e147d1c4351d3d0))

## [0.77.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.77.0...runner-rs-v0.77.1) (2026-04-13)


### Bug Fixes

* **runner:** validate --group name to prevent path traversal ([#9104](https://github.com/vm0-ai/vm0/issues/9104)) ([b7e75dc](https://github.com/vm0-ai/vm0/commit/b7e75dc2f74419c441c6e62eda3db1bd3cf93f87)), closes [#9099](https://github.com/vm0-ai/vm0/issues/9099)

## [0.77.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.76.4...runner-rs-v0.77.0) (2026-04-13)


### Features

* **runner:** require --force for service stop/uninstall with active jobs ([#9093](https://github.com/vm0-ai/vm0/issues/9093)) ([399164e](https://github.com/vm0-ai/vm0/commit/399164e015d366fec791f1df7542387bb4c7c703))

## [0.76.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.76.3...runner-rs-v0.76.4) (2026-04-13)


### Bug Fixes

* **runner:** shell-quote exec arguments before joining ([#9052](https://github.com/vm0-ai/vm0/issues/9052)) ([44e0d4d](https://github.com/vm0-ai/vm0/commit/44e0d4d0c29146259acce856c3d6642a90441f6c))


### Refactoring

* use proxy-reported usage as billing source of truth ([#9064](https://github.com/vm0-ai/vm0/issues/9064)) ([b655964](https://github.com/vm0-ai/vm0/commit/b65596423f8655117ebd67c38731eb5f35c332b7))

## [0.76.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.76.2...runner-rs-v0.76.3) (2026-04-13)

## [0.76.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.76.1...runner-rs-v0.76.2) (2026-04-12)


### Bug Fixes

* log directory iteration errors in gc instead of silently swallowing ([#9036](https://github.com/vm0-ai/vm0/issues/9036)) ([da6af3c](https://github.com/vm0-ai/vm0/commit/da6af3c67e7beaf4e9fdef5d28958f09cba62e56))

## [0.76.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.76.0...runner-rs-v0.76.1) (2026-04-12)


### Bug Fixes

* **runner:** abort stdout drain task on wait_exit timeout or crash ([#9021](https://github.com/vm0-ai/vm0/issues/9021)) ([d6b021e](https://github.com/vm0-ai/vm0/commit/d6b021e5f97b432006e969efd45f3b29debb4909)), closes [#8970](https://github.com/vm0-ai/vm0/issues/8970)

## [0.76.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.75.2...runner-rs-v0.76.0) (2026-04-12)


### Features

* add feature flag to control sandbox reuse logic ([#8987](https://github.com/vm0-ai/vm0/issues/8987)) ([e77a8a0](https://github.com/vm0-ai/vm0/commit/e77a8a0c2974d91786f11d7119d87ba8fe07a6dd))


### Bug Fixes

* **runner:** add cached field to storage manifest for correct cleanup preservation ([#8993](https://github.com/vm0-ai/vm0/issues/8993)) ([d9db456](https://github.com/vm0-ai/vm0/commit/d9db4569ef6f86fdf46063d65a9aad34ca7a6b2a)), closes [#8982](https://github.com/vm0-ai/vm0/issues/8982)
* **runner:** add upper-bound validation for profile resource limits ([#9015](https://github.com/vm0-ai/vm0/issues/9015)) ([d774aca](https://github.com/vm0-ai/vm0/commit/d774aca8bb1fa71635fdb15692378e634edc2d10)), closes [#9009](https://github.com/vm0-ai/vm0/issues/9009)

## [0.75.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.75.1...runner-rs-v0.75.2) (2026-04-11)


### Bug Fixes

* **runner:** add drop impl to kmsg handle to prevent task leak on early return ([#8958](https://github.com/vm0-ai/vm0/issues/8958)) ([64c26e6](https://github.com/vm0-ai/vm0/commit/64c26e6adf0785f74ff9217bfde1267a721d3b83))

## [0.75.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.75.0...runner-rs-v0.75.1) (2026-04-11)


### Bug Fixes

* align mitmproxy permission matching with frontend contract ([#8943](https://github.com/vm0-ai/vm0/issues/8943)) ([e4273a0](https://github.com/vm0-ai/vm0/commit/e4273a0fa8b7a06ffd1ef208ed15bd164e15bf31))

## [0.75.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.74.2...runner-rs-v0.75.0) (2026-04-10)


### Features

* **credit:** record anthropic message id in proxy_credit_usage ([#8919](https://github.com/vm0-ai/vm0/issues/8919)) ([7bfe376](https://github.com/vm0-ai/vm0/commit/7bfe376274a4702cb116c90c9fa816307fee6f02)), closes [#8909](https://github.com/vm0-ai/vm0/issues/8909)


### Refactoring

* **mitm-addon:** extract shared api request builder for platform calls ([#8913](https://github.com/vm0-ai/vm0/issues/8913)) ([dd9a683](https://github.com/vm0-ai/vm0/commit/dd9a68382a4f012ab532838e4bdce931fab13cb8)), closes [#8885](https://github.com/vm0-ai/vm0/issues/8885)
* **runner:** unify rootfs and snapshot into single image artifact ([#8821](https://github.com/vm0-ai/vm0/issues/8821)) ([a549299](https://github.com/vm0-ai/vm0/commit/a549299c1c10179b49783288e869f82739b58033))

## [0.74.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.74.1...runner-rs-v0.74.2) (2026-04-10)


### Bug Fixes

* **mitm-addon:** decompress sse stream before usage extraction ([#8903](https://github.com/vm0-ai/vm0/issues/8903)) ([28fd00c](https://github.com/vm0-ai/vm0/commit/28fd00ce66339d0b50854628dd4b5049a5b02ce5))
* **mitm-addon:** replace --quiet with flow_detail=0 + termlog_verbosity=warn ([#8896](https://github.com/vm0-ai/vm0/issues/8896)) ([7d95d9c](https://github.com/vm0-ai/vm0/commit/7d95d9cb6672d579b7b76710b899c0a79a53607a)), closes [#8882](https://github.com/vm0-ai/vm0/issues/8882)
* **runner:** drop discover future before shutdown to prevent mutex deadlock ([#8898](https://github.com/vm0-ai/vm0/issues/8898)) ([54460c1](https://github.com/vm0-ai/vm0/commit/54460c11249d009b06e50ced82ce45b5086932c5))

## [0.74.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.74.0...runner-rs-v0.74.1) (2026-04-10)


### Refactoring

* **firewalls:** cache graphql field coverage check per api entry ([#8839](https://github.com/vm0-ai/vm0/issues/8839)) ([f716aef](https://github.com/vm0-ai/vm0/commit/f716aefcfd219856adf314b1fa836771760624f5)), closes [#8816](https://github.com/vm0-ai/vm0/issues/8816)

## [0.74.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.73.0...runner-rs-v0.74.0) (2026-04-10)


### Features

* **firewalls:** include denied permission names in firewall block response ([#8815](https://github.com/vm0-ai/vm0/issues/8815)) ([b276ebf](https://github.com/vm0-ai/vm0/commit/b276ebfc0b06bf816d6b3ba250e400ba574182b0))

## [0.73.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.72.1...runner-rs-v0.73.0) (2026-04-10)


### Features

* **runner:** clean stale files on vm reuse before downloading storages ([#8800](https://github.com/vm0-ai/vm0/issues/8800)) ([4725751](https://github.com/vm0-ai/vm0/commit/4725751f5ff9b6f4b7b1c1294b6efbc48bc005b1)), closes [#8757](https://github.com/vm0-ai/vm0/issues/8757)
* **runner:** pass feature switch states through execution context ([#8778](https://github.com/vm0-ai/vm0/issues/8778)) ([edbe85c](https://github.com/vm0-ai/vm0/commit/edbe85ca3f0fb81821aeeb609a0a700fcbd137e8))


### Bug Fixes

* **runner:** pin discover future to prevent heartbeat cancellation ([#8747](https://github.com/vm0-ai/vm0/issues/8747)) ([#8783](https://github.com/vm0-ai/vm0/issues/8783)) ([31603cd](https://github.com/vm0-ai/vm0/commit/31603cd3db27475a94d2cdd2f4272e8cc5ed403b))
* **runner:** prevent message_delta from overwriting proxy usage with zeros ([#8805](https://github.com/vm0-ai/vm0/issues/8805)) ([3e143a4](https://github.com/vm0-ai/vm0/commit/3e143a476b31ae972fb3079316a3c28855ac79e5)), closes [#8796](https://github.com/vm0-ai/vm0/issues/8796)
* **runner:** prevent proxy billing data loss from error flows and shutdown ([#8772](https://github.com/vm0-ai/vm0/issues/8772)) ([4fd963d](https://github.com/vm0-ai/vm0/commit/4fd963d88add04850674522f635e2540dbad3953))

## [0.72.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.72.0...runner-rs-v0.72.1) (2026-04-10)

## [0.72.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.71.0...runner-rs-v0.72.0) (2026-04-09)


### Features

* **firewalls:** add deny and ask lists to granted permissions schema ([#8719](https://github.com/vm0-ai/vm0/issues/8719)) ([5a02f38](https://github.com/vm0-ai/vm0/commit/5a02f389160a6cbf961656798fe353ca029c2ece))
* **runner:** read guest session id for first-run vm parking ([#8731](https://github.com/vm0-ai/vm0/issues/8731)) ([9bdcda9](https://github.com/vm0-ai/vm0/commit/9bdcda9c5e2bb5af853696c19661862ab0f000b6))


### Refactoring

* **firewalls:** change allow-unknown from boolean to policy value ([#8733](https://github.com/vm0-ai/vm0/issues/8733)) ([4e2bea3](https://github.com/vm0-ai/vm0/commit/4e2bea3758707b157bf28162ee815da2129c5f32))
* **firewalls:** rename granted-permissions to network-policies ([#8740](https://github.com/vm0-ai/vm0/issues/8740)) ([2ad2c5c](https://github.com/vm0-ai/vm0/commit/2ad2c5ce175d98304adcb5a43770df3d9d5ee9d2)), closes [#8738](https://github.com/vm0-ai/vm0/issues/8738)


### Performance Improvements

* **runner:** skip storage re-download when artifact version unchanged ([#8743](https://github.com/vm0-ai/vm0/issues/8743)) ([8b8175c](https://github.com/vm0-ai/vm0/commit/8b8175c72da3b5e71911fe072aa5c70bba0e0e46))

## [0.71.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.70.2...runner-rs-v0.71.0) (2026-04-09)


### Features

* **firewalls:** add granted permissions for three-level matching ([#8621](https://github.com/vm0-ai/vm0/issues/8621)) ([534ec85](https://github.com/vm0-ai/vm0/commit/534ec85c209f52c7388bd9819b72017bb8be6cd9))

## [0.70.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.70.1...runner-rs-v0.70.2) (2026-04-09)

## [0.70.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.70.0...runner-rs-v0.70.1) (2026-04-09)


### Bug Fixes

* **firewalls:** skip __typename in graphql field coverage check ([#8642](https://github.com/vm0-ai/vm0/issues/8642)) ([306f85b](https://github.com/vm0-ai/vm0/commit/306f85b60edec8b2dec1823c67f85b4554956369))
* **runner:** clean up residual transient systemd units before service start ([#8645](https://github.com/vm0-ai/vm0/issues/8645)) ([a14b1db](https://github.com/vm0-ai/vm0/commit/a14b1db39b56657b0108475f6da95827345f0152)), closes [#8640](https://github.com/vm0-ai/vm0/issues/8640)

## [0.70.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.69.0...runner-rs-v0.70.0) (2026-04-09)


### Features

* **billing:** add proxy-side usage extraction for billing verification ([#8581](https://github.com/vm0-ai/vm0/issues/8581)) ([87f5049](https://github.com/vm0-ai/vm0/commit/87f5049ab3eb8e4aaa26537f412b628d0f687bc6))
* **firewalls:** support comma-separated field values in graphql rules ([#8549](https://github.com/vm0-ai/vm0/issues/8549)) ([e9cda88](https://github.com/vm0-ai/vm0/commit/e9cda88fbb87f4df7a47922e2e63b2c55f7e2de2))


### Bug Fixes

* **firewalls:** require all graphql fields to be covered by permissions ([#8599](https://github.com/vm0-ai/vm0/issues/8599)) ([7f8c21b](https://github.com/vm0-ai/vm0/commit/7f8c21b4a0d77a19e05fe18175f9b77fd4949ce6))
* **runner:** send immediate heartbeat after vm park and exclude idle vms from running count ([#8626](https://github.com/vm0-ai/vm0/issues/8626)) ([71d340d](https://github.com/vm0-ai/vm0/commit/71d340d540f546ef008671830aca970eaf00158d))

## [0.69.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.68.0...runner-rs-v0.69.0) (2026-04-08)


### Features

* **firewall:** add graphql field path parser with nested selection support ([#8520](https://github.com/vm0-ai/vm0/issues/8520)) ([7665bee](https://github.com/vm0-ai/vm0/commit/7665bee9864a351c1298e42066a2fe7019c0bcec))


### Refactoring

* **proxy:** replace blind streaming with buffered stream callback ([#8514](https://github.com/vm0-ai/vm0/issues/8514)) ([552cd0c](https://github.com/vm0-ai/vm0/commit/552cd0ceb3de240f97c0ffa5013e7da32b80857b))

## [0.68.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.67.1...runner-rs-v0.68.0) (2026-04-08)


### Features

* **firewalls:** add graphql field modifier for rule matching ([#8476](https://github.com/vm0-ai/vm0/issues/8476)) ([82b2049](https://github.com/vm0-ai/vm0/commit/82b20493e48325cbc75ecc431a74e8254096e46a))
* **platform:** capture response headers and mark binary bodies in network logs ([#8481](https://github.com/vm0-ai/vm0/issues/8481)) ([6a778f8](https://github.com/vm0-ai/vm0/commit/6a778f8ebbd88e2bd95a4d79a5e4ed1e4c3f4f26))
* **runner:** add smart dispatch with session affinity and targeted ably push ([#8474](https://github.com/vm0-ai/vm0/issues/8474)) ([65dbe3a](https://github.com/vm0-ai/vm0/commit/65dbe3af2795aa2730a3df28e84e3572fc8a46cc)), closes [#8368](https://github.com/vm0-ai/vm0/issues/8368)


### Bug Fixes

* **proxy:** remove firewall terminology from error responses ([#8486](https://github.com/vm0-ai/vm0/issues/8486)) ([a8292d5](https://github.com/vm0-ai/vm0/commit/a8292d585528abecfb03d7bfa15ca33e31b319cb)), closes [#8483](https://github.com/vm0-ai/vm0/issues/8483)
* **slack:** skip channel context fetch for dm conversations ([#8475](https://github.com/vm0-ai/vm0/issues/8475)) ([07a3321](https://github.com/vm0-ai/vm0/commit/07a33216d0a47047b341a0784324cb71b596a7f4))

## [0.67.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.67.0...runner-rs-v0.67.1) (2026-04-08)

## [0.67.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.66.0...runner-rs-v0.67.0) (2026-04-07)


### Features

* **runner:** add runner state reporting via heartbeat ([#8367](https://github.com/vm0-ai/vm0/issues/8367)) ([#8380](https://github.com/vm0-ai/vm0/issues/8380)) ([2dea967](https://github.com/vm0-ai/vm0/commit/2dea96701d28d963e74816908517519d1b55c939))

## [0.66.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.65.1...runner-rs-v0.66.0) (2026-04-07)


### Features

* **proxy:** add opt-in http body capture to mitmproxy addon ([#8349](https://github.com/vm0-ai/vm0/issues/8349)) ([95709fb](https://github.com/vm0-ai/vm0/commit/95709fb721befedd489025c39124b3663226d3f9))

## [0.65.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.65.0...runner-rs-v0.65.1) (2026-04-07)


### Bug Fixes

* **runner:** clean up stale guest log files on keep-alive vm reuse ([#8308](https://github.com/vm0-ai/vm0/issues/8308)) ([#8333](https://github.com/vm0-ai/vm0/issues/8333)) ([775f09b](https://github.com/vm0-ai/vm0/commit/775f09b0577fe17d1cbc39e58ba93d45277be60a))

## [0.65.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.64.0...runner-rs-v0.65.0) (2026-04-07)


### Features

* **runner:** keep-alive sandbox across conversation turns ([#8314](https://github.com/vm0-ai/vm0/issues/8314)) ([867a830](https://github.com/vm0-ai/vm0/commit/867a83056cd893988780aed3d8d6d49836e12e29))

## [0.64.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.63.1...runner-rs-v0.64.0) (2026-04-07)


### Features

* **gc:** add orphaned workspace cleanup to runner gc ([#8272](https://github.com/vm0-ai/vm0/issues/8272)) ([5614af3](https://github.com/vm0-ai/vm0/commit/5614af3febcd7a49a0f84aa8023c9a56046346bd))

## [0.63.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.63.0...runner-rs-v0.63.1) (2026-04-06)


### Refactoring

* **nbd:** deduplicate nbds_max, add concurrent test and bitmap assertion ([#8228](https://github.com/vm0-ai/vm0/issues/8228)) ([c0b98df](https://github.com/vm0-ai/vm0/commit/c0b98df3eb69ec81b26373d23d093a9526839752))

## [0.63.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.62.2...runner-rs-v0.63.0) (2026-04-06)


### Features

* **crates:** add guest-reseed for post-snapshot entropy injection ([#8215](https://github.com/vm0-ai/vm0/issues/8215)) ([c9a9005](https://github.com/vm0-ai/vm0/commit/c9a9005a05398f787d7e9dbe2f591b51b44bbab9))

## [0.62.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.62.1...runner-rs-v0.62.2) (2026-04-06)


### Bug Fixes

* **runner:** flush tokio file in drain_stdout_to_file to prevent data loss ([#8216](https://github.com/vm0-ai/vm0/issues/8216)) ([b19f692](https://github.com/vm0-ai/vm0/commit/b19f692c39046a3c0614e0c1c23de82b5af9a8b7))

## [0.62.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.62.0...runner-rs-v0.62.1) (2026-04-04)


### Bug Fixes

* add dnsmasq to system dependency check and doctor diagnostics ([#8065](https://github.com/vm0-ai/vm0/issues/8065)) ([6a7a0f8](https://github.com/vm0-ai/vm0/commit/6a7a0f8fa8939671d7b4d678df4aea49dd7fcbbe))


### Performance Improvements

* **runner:** replace docker build with debootstrap for rootfs creation ([#8042](https://github.com/vm0-ai/vm0/issues/8042)) ([41e932a](https://github.com/vm0-ai/vm0/commit/41e932aacb06a8a10234b1eb5219f90e84135917))

## [0.62.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.61.4...runner-rs-v0.62.0) (2026-04-03)


### Features

* add dns proxy for sandbox vms using dnsmasq ([#8020](https://github.com/vm0-ai/vm0/issues/8020)) ([5699f8d](https://github.com/vm0-ai/vm0/commit/5699f8dbb9008422dfe1753a2b127a6f9c100f59))


### Bug Fixes

* inject /etc/hosts and fix postgresql socket dir in sandbox rootfs ([#8012](https://github.com/vm0-ai/vm0/issues/8012)) ([6ba0f2f](https://github.com/vm0-ai/vm0/commit/6ba0f2fff333c57c85c90d1a7dad57dcc65f338b))

## [0.61.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.61.3...runner-rs-v0.61.4) (2026-04-03)


### Bug Fixes

* ensure python, java, and rust trust proxy ca in sandbox rootfs ([#7890](https://github.com/vm0-ai/vm0/issues/7890)) ([c697dca](https://github.com/vm0-ai/vm0/commit/c697dca25e38610ff83629c326170b110bfa678f))

## [0.61.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.61.2...runner-rs-v0.61.3) (2026-04-03)


### Performance Improvements

* **runner:** consolidate dockerfile apt-get update calls ([#7858](https://github.com/vm0-ai/vm0/issues/7858)) ([ab41e8e](https://github.com/vm0-ai/vm0/commit/ab41e8ecf8c21b45f701ffbe8260ec6fcf2af5cc))

## [0.61.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.61.1...runner-rs-v0.61.2) (2026-04-03)


### Refactoring

* centralize /etc/environment in build-rootfs.sh ([#7825](https://github.com/vm0-ai/vm0/issues/7825)) ([fbe263b](https://github.com/vm0-ai/vm0/commit/fbe263bcdbb5eac69be6583711589be82830af32))

## [0.61.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.61.0...runner-rs-v0.61.1) (2026-04-03)


### Bug Fixes

* **runner:** warn instead of failing when gc cannot remove snapshot ([#7808](https://github.com/vm0-ai/vm0/issues/7808)) ([c349213](https://github.com/vm0-ai/vm0/commit/c349213828a6ebe80a116e5a75b265dca4168f18))

## [0.61.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.60.0...runner-rs-v0.61.0) (2026-04-03)


### Features

* upgrade sandbox rootfs to ubuntu 24.04 with expanded runtime support ([#7741](https://github.com/vm0-ai/vm0/issues/7741)) ([8f8eba2](https://github.com/vm0-ai/vm0/commit/8f8eba24ef811741525b4040f6955e23d0fa99b3))


### Bug Fixes

* **runner:** also write tz to /etc/environment for system-wide inheritance ([#7762](https://github.com/vm0-ai/vm0/issues/7762)) ([70fb861](https://github.com/vm0-ai/vm0/commit/70fb861daef84cd7085ccd7259d3386cf15371b4)), closes [#7744](https://github.com/vm0-ai/vm0/issues/7744)

## [0.60.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.59.1...runner-rs-v0.60.0) (2026-04-02)


### Features

* **runner:** log rootfs logical and disk size after build ([#7784](https://github.com/vm0-ai/vm0/issues/7784)) ([225cca9](https://github.com/vm0-ai/vm0/commit/225cca9aba32163c13e866ca8bc4c77d53b25506))
* support graphql operation-level firewall rules ([#7719](https://github.com/vm0-ai/vm0/issues/7719)) ([ff23d7f](https://github.com/vm0-ai/vm0/commit/ff23d7f8717ee7fcb39546a1c8e20d8a091f9df4))

## [0.59.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.59.0...runner-rs-v0.59.1) (2026-04-02)

## [0.59.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.58.0...runner-rs-v0.59.0) (2026-04-02)


### Features

* **runner:** sync system timezone files in guest before agent start ([#7716](https://github.com/vm0-ai/vm0/issues/7716)) ([64e2484](https://github.com/vm0-ai/vm0/commit/64e2484503a0061955335dbe3a77b4caa3e98638))

## [0.58.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.57.0...runner-rs-v0.58.0) (2026-04-02)


### Features

* **runner:** increase default vm resources and add configurable disk size ([#7691](https://github.com/vm0-ai/vm0/issues/7691)) ([b928eb1](https://github.com/vm0-ai/vm0/commit/b928eb1a51e7759ba87c52577f323e0004bd4c8f))


### Refactoring

* split mitm_addon.py into focused modules with build.rs auto-scan ([#7688](https://github.com/vm0-ai/vm0/issues/7688)) ([aed758d](https://github.com/vm0-ai/vm0/commit/aed758dc817024a874531fbc2d99b2a58ffdded2)), closes [#7671](https://github.com/vm0-ai/vm0/issues/7671)

## [0.57.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.56.3...runner-rs-v0.57.0) (2026-04-02)


### Features

* add auth.base url rewriting for webhook-url firewall connectors ([#7618](https://github.com/vm0-ai/vm0/issues/7618)) ([55585ac](https://github.com/vm0-ai/vm0/commit/55585ac37db6938508ca957f83725389157c55da))

## [0.56.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.56.2...runner-rs-v0.56.3) (2026-04-02)

## [0.56.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.56.1...runner-rs-v0.56.2) (2026-04-01)


### Bug Fixes

* **nbd-cow:** guard disconnect against device index recycling by other runners ([#7581](https://github.com/vm0-ai/vm0/issues/7581)) ([ed9e572](https://github.com/vm0-ai/vm0/commit/ed9e572a80514236aada53eb68b2e9ad069ec7d2))

## [0.56.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.56.0...runner-rs-v0.56.1) (2026-04-01)


### Bug Fixes

* **nbd-cow:** advertise flush/trim flags and harden i/o paths ([#7539](https://github.com/vm0-ai/vm0/issues/7539)) ([6410e3e](https://github.com/vm0-ai/vm0/commit/6410e3ebc7652ba6f2da8edf14928346e70b7fb2))


### Refactoring

* rename experimental firewalls to firewalls ([#7553](https://github.com/vm0-ai/vm0/issues/7553)) ([e3c35a9](https://github.com/vm0-ai/vm0/commit/e3c35a95bd0dbfd1d68aef910db6089e38d6a0bb))

## [0.56.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.55.0...runner-rs-v0.56.0) (2026-04-01)


### Features

* **sandbox-fc:** replace dm-snapshot with nbd-cow ([#7406](https://github.com/vm0-ai/vm0/issues/7406)) ([bc60c4b](https://github.com/vm0-ai/vm0/commit/bc60c4b01eaac368f7434d367784855b0b50479b))

## [0.55.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.54.0...runner-rs-v0.55.0) (2026-04-01)


### Features

* **runner:** run runner as root, remove all sudo wrappers ([#7443](https://github.com/vm0-ai/vm0/issues/7443)) ([66e9af9](https://github.com/vm0-ai/vm0/commit/66e9af9846cfdc044ec4203b04e784bbc5ea305d))

## [0.54.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.53.0...runner-rs-v0.54.0) (2026-04-01)


### Features

* **firewalls:** support vars templates in firewall auth headers ([#7445](https://github.com/vm0-ai/vm0/issues/7445)) ([c06b9a0](https://github.com/vm0-ai/vm0/commit/c06b9a027bf1ae757b2f09393fee658d891bcf5f))

## [0.53.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.52.2...runner-rs-v0.53.0) (2026-03-31)


### Features

* **runner:** add xurl cli to rootfs ([#7397](https://github.com/vm0-ai/vm0/issues/7397)) ([1474ef3](https://github.com/vm0-ai/vm0/commit/1474ef34cb060a96d5af47e3aae7d626a4b5e319)), closes [#7124](https://github.com/vm0-ai/vm0/issues/7124)

## [0.52.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.52.1...runner-rs-v0.52.2) (2026-03-31)


### Bug Fixes

* **firewalls:** replace placeholder tokens with realistic fill pattern ([#7332](https://github.com/vm0-ai/vm0/issues/7332)) ([237916e](https://github.com/vm0-ai/vm0/commit/237916e4d424b924ed8ac603d20da4813b969b40))

## [0.52.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.52.0...runner-rs-v0.52.1) (2026-03-31)

## [0.52.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.51.1...runner-rs-v0.52.0) (2026-03-31)


### Features

* **firewalls:** support path and host parameter matching in base urls ([#7256](https://github.com/vm0-ai/vm0/issues/7256)) ([d9d3a15](https://github.com/vm0-ai/vm0/commit/d9d3a15fc91c5db88a18730b5d8d8aea67238c95))


### Bug Fixes

* **mitm:** add network logging to error() hook for connection failures ([#7300](https://github.com/vm0-ai/vm0/issues/7300)) ([6fec94a](https://github.com/vm0-ai/vm0/commit/6fec94a9f4fef7994477fdd53f87f82147d5be03))
* **mitm:** add per-key lock to coalesce concurrent firewall header fetches ([#7264](https://github.com/vm0-ai/vm0/issues/7264)) ([ab4787c](https://github.com/vm0-ai/vm0/commit/ab4787cb659b362592d4f8b5bd2f5aeb053d219b))

## [0.51.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.51.0...runner-rs-v0.51.1) (2026-03-30)

## [0.51.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.50.2...runner-rs-v0.51.0) (2026-03-30)


### Features

* **sandbox:** add sandbox-mock crate for testing ([#7177](https://github.com/vm0-ai/vm0/issues/7177)) ([d643020](https://github.com/vm0-ai/vm0/commit/d643020b2ac0059996ebeaef128b79945d9e072c))

## [0.50.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.50.1...runner-rs-v0.50.2) (2026-03-30)


### Refactoring

* **sandbox:** introduce runtime provider trait and consolidate sandbox-fc construction ([#7173](https://github.com/vm0-ai/vm0/issues/7173)) ([6cb7c3c](https://github.com/vm0-ai/vm0/commit/6cb7c3c8ed57b4d7eb949986046d68226dc0672a)), closes [#7119](https://github.com/vm0-ai/vm0/issues/7119)

## [0.50.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.50.0...runner-rs-v0.50.1) (2026-03-30)


### Refactoring

* **sandbox:** introduce sandbox control trait and decouple exec/kill from sandbox-fc ([#7150](https://github.com/vm0-ai/vm0/issues/7150)) ([4615d15](https://github.com/vm0-ai/vm0/commit/4615d1571c6dbc2ba249070654112d390e83a395)), closes [#7122](https://github.com/vm0-ai/vm0/issues/7122)
* **sandbox:** introduce sandbox runtime trait and internalize shared resources ([#7125](https://github.com/vm0-ai/vm0/issues/7125)) ([43a2ba0](https://github.com/vm0-ai/vm0/commit/43a2ba0d6ee9df1022e6238913597dd4d1c11e2a))
* **sandbox:** introduce snapshot provider trait and decouple snapshot operations ([#7142](https://github.com/vm0-ai/vm0/issues/7142)) ([9a864bf](https://github.com/vm0-ai/vm0/commit/9a864bfd4ec551ead8115f4fdb30df7c5570b5fe))

## [0.50.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.49.0...runner-rs-v0.50.0) (2026-03-29)


### Features

* **sandbox-fc:** add cow pool to pre-warm dm-snapshot resources ([#7116](https://github.com/vm0-ai/vm0/issues/7116)) ([c841e61](https://github.com/vm0-ai/vm0/commit/c841e61bfc653d143cd6a022f03ca638b2bf5a42))

## [0.49.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.48.2...runner-rs-v0.49.0) (2026-03-29)


### Features

* **guest-init:** use kernel root= boot arg instead of pivot_root ([#7106](https://github.com/vm0-ai/vm0/issues/7106)) ([b373849](https://github.com/vm0-ai/vm0/commit/b373849cb331296ae7665704edd400548d67c2a5))
* **runner:** detect orphan firecracker processes with --name filter ([#7113](https://github.com/vm0-ai/vm0/issues/7113)) ([8fcfc79](https://github.com/vm0-ai/vm0/commit/8fcfc79a812f273fd2ea2b2b9febffe3ab34b858))
* **runner:** detect orphaned dm-snapshot and loop devices in doctor ([#7107](https://github.com/vm0-ai/vm0/issues/7107)) ([c76a18f](https://github.com/vm0-ai/vm0/commit/c76a18f60a4538d410ac4976329c97f7b5d52448))
* **sandbox-fc:** replace guest-side overlayfs with host-side dm-snapshot cow ([#6521](https://github.com/vm0-ai/vm0/issues/6521)) ([8f6a118](https://github.com/vm0-ai/vm0/commit/8f6a1185bfd6dd4604687662f3d03be6076ea71f))


### Bug Fixes

* **crates:** update sha2/hmac usage for digest 0.11 compatibility ([#7101](https://github.com/vm0-ai/vm0/issues/7101)) ([cbded46](https://github.com/vm0-ai/vm0/commit/cbded46e78c8d3ed060e96f79f15cd38ee1cf9dc))

## [0.48.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.48.1...runner-rs-v0.48.2) (2026-03-26)

## [0.48.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.48.0...runner-rs-v0.48.1) (2026-03-26)


### Bug Fixes

* redact sandbox token in logs via secret values list ([#6838](https://github.com/vm0-ai/vm0/issues/6838)) ([56e0c1f](https://github.com/vm0-ai/vm0/commit/56e0c1f319c391dabac9088e7bccc3ff467ec33f))

## [0.48.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.47.0...runner-rs-v0.48.0) (2026-03-25)


### Features

* install @googleworkspace/cli in docker image ([#6751](https://github.com/vm0-ai/vm0/issues/6751)) ([32a45c3](https://github.com/vm0-ai/vm0/commit/32a45c3f2c56a587f001b55d545e02c2823c80ab))

## [0.47.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.46.0...runner-rs-v0.47.0) (2026-03-25)


### Features

* **runner:** add cache version seeds to rootfs and snapshot hash computation ([#6769](https://github.com/vm0-ai/vm0/issues/6769)) ([59b4ce5](https://github.com/vm0-ai/vm0/commit/59b4ce5fbf80f027e89374239e6e36ce4997a656))


### Bug Fixes

* **runner:** add rerun-if-changed for embedded files in build.rs ([#6758](https://github.com/vm0-ai/vm0/issues/6758)) ([814d66c](https://github.com/vm0-ai/vm0/commit/814d66cc1d9601ea1a92342fc9697ec7694e4569))

## [0.46.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.8...runner-rs-v0.46.0) (2026-03-25)


### Features

* **runner:** detect host-side cgroup oom kill of firecracker process ([#6630](https://github.com/vm0-ai/vm0/issues/6630)) ([34fa116](https://github.com/vm0-ai/vm0/commit/34fa11698b8e1c83f2cb93d82e281c099d114a49))

## [0.45.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.7...runner-rs-v0.45.8) (2026-03-25)


### Bug Fixes

* remove hardcoded memorymax=2g from runner systemd service ([#6632](https://github.com/vm0-ai/vm0/issues/6632)) ([c091eb7](https://github.com/vm0-ai/vm0/commit/c091eb7f6e71098a05dc5da0aadde69ebceace83)), closes [#6631](https://github.com/vm0-ai/vm0/issues/6631)

## [0.45.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.6...runner-rs-v0.45.7) (2026-03-25)


### Refactoring

* remove experimental_capabilities and make vm0_token injection unconditional ([#6573](https://github.com/vm0-ai/vm0/issues/6573)) ([#6579](https://github.com/vm0-ai/vm0/issues/6579)) ([1fb7df0](https://github.com/vm0-ai/vm0/commit/1fb7df0201d70223d486c91b536cad93a78c23a3))

## [0.45.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.5...runner-rs-v0.45.6) (2026-03-24)


### Refactoring

* unify agent identity fields across all zero api endpoints ([#6302](https://github.com/vm0-ai/vm0/issues/6302)) ([83a0e5d](https://github.com/vm0-ai/vm0/commit/83a0e5d5b5981b709b1dd8e8e318946b6330d2c7))

## [0.45.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.4...runner-rs-v0.45.5) (2026-03-23)


### Bug Fixes

* **runner:** skip proxy warning for stopped/draining runners in doctor ([#6233](https://github.com/vm0-ai/vm0/issues/6233)) ([7da7c00](https://github.com/vm0-ai/vm0/commit/7da7c00e5271e751dd37f8d3ee6d7da9a76407b8)), closes [#6198](https://github.com/vm0-ai/vm0/issues/6198)
* **runner:** stop kmsg monitor on shutdown to prevent process hang ([#6206](https://github.com/vm0-ai/vm0/issues/6206)) ([f871fb1](https://github.com/vm0-ai/vm0/commit/f871fb1cda90e45773226896926f92911a123975)), closes [#6197](https://github.com/vm0-ai/vm0/issues/6197)

## [0.45.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.3...runner-rs-v0.45.4) (2026-03-23)

## [0.45.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.2...runner-rs-v0.45.3) (2026-03-23)

## [0.45.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.1...runner-rs-v0.45.2) (2026-03-23)


### Refactoring

* **runner:** remove stale dead_code allows from execution context ([#6148](https://github.com/vm0-ai/vm0/issues/6148)) ([c053ce6](https://github.com/vm0-ai/vm0/commit/c053ce6e7594d901fa511d4f4341ce8709ad88e8))

## [0.45.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.0...runner-rs-v0.45.1) (2026-03-23)


### Bug Fixes

* add missing libc dependency to runner crate ([#6092](https://github.com/vm0-ai/vm0/issues/6092)) ([5ba363c](https://github.com/vm0-ai/vm0/commit/5ba363c94e1fb094c339fc4982f93880f52b6503))
* unify pr and mq job-ref and add job-level concurrency groups ([#6086](https://github.com/vm0-ai/vm0/issues/6086)) ([e25f45a](https://github.com/vm0-ai/vm0/commit/e25f45aa5cbcde73a3cf850b67df550a8626885c))

## [0.45.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.44.1...runner-rs-v0.45.0) (2026-03-23)


### Features

* **runner:** add cancel support to local provider via .cancel files ([#6048](https://github.com/vm0-ai/vm0/issues/6048)) ([d065887](https://github.com/vm0-ai/vm0/commit/d065887510d08b06d138a8d3dba30984e5aa4da9))

## [0.44.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.44.0...runner-rs-v0.44.1) (2026-03-23)


### Refactoring

* **runner:** move `runner submit` under `runner local` subcommand ([#5990](https://github.com/vm0-ai/vm0/issues/5990)) ([568fb4c](https://github.com/vm0-ai/vm0/commit/568fb4ce73fa05f6dd0eee05c47c76ffe21e5c5e))

## [0.44.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.43.0...runner-rs-v0.44.0) (2026-03-22)


### Features

* **runner:** add job cancellation via ably real-time notifications ([#5949](https://github.com/vm0-ai/vm0/issues/5949)) ([e157f92](https://github.com/vm0-ai/vm0/commit/e157f925312c50ff8de62e986d7bc7afac0a3d53)), closes [#5762](https://github.com/vm0-ai/vm0/issues/5762)

## [0.43.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.42.1...runner-rs-v0.43.0) (2026-03-21)


### Features

* add tcp connection logging and network log type field ([#5786](https://github.com/vm0-ai/vm0/issues/5786)) ([12d6ddb](https://github.com/vm0-ai/vm0/commit/12d6ddbefa61a83e7e50e6ae4e5fc904b6965678)), closes [#5592](https://github.com/vm0-ai/vm0/issues/5592)

## [0.42.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.42.0...runner-rs-v0.42.1) (2026-03-21)

## [0.42.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.41.0...runner-rs-v0.42.0) (2026-03-20)


### Features

* **runner:** add sentry panic reporting for crash observability ([#5747](https://github.com/vm0-ai/vm0/issues/5747)) ([0e28602](https://github.com/vm0-ai/vm0/commit/0e28602620d8e6e87e5801a587d48829910becd5)), closes [#5680](https://github.com/vm0-ai/vm0/issues/5680)
* support --settings flag for vm0 run ([#5663](https://github.com/vm0-ai/vm0/issues/5663)) ([#5753](https://github.com/vm0-ai/vm0/issues/5753)) ([d0aad87](https://github.com/vm0-ai/vm0/commit/d0aad87539c31ae4664d41b1cca46b556b3de66e))
* support --tools cli parameter across full pipeline ([#5752](https://github.com/vm0-ai/vm0/issues/5752)) ([b0cf364](https://github.com/vm0-ai/vm0/commit/b0cf364a8598dcd36ed1a6ffffdb8c1e03d1841c))


### Refactoring

* separate auth error from firewall action in network logs ([#5756](https://github.com/vm0-ai/vm0/issues/5756)) ([7b56aed](https://github.com/vm0-ai/vm0/commit/7b56aedb93ba323a4076af6ca19fb43a520aa6e1)), closes [#5754](https://github.com/vm0-ai/vm0/issues/5754)

## [0.41.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.40.0...runner-rs-v0.41.0) (2026-03-20)


### Features

* add firewall fields to network logs and improve action handling ([#5745](https://github.com/vm0-ai/vm0/issues/5745)) ([ff2d271](https://github.com/vm0-ai/vm0/commit/ff2d271d7040f6367dd19a7f0e6f21fdd35a19c1))

## [0.40.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.39.0...runner-rs-v0.40.0) (2026-03-20)


### Features

* **vsock:** add real-time stdout streaming from guest to host ([#5574](https://github.com/vm0-ai/vm0/issues/5574)) ([2afc093](https://github.com/vm0-ai/vm0/commit/2afc0930657f6bbf1e1f4947383345d33de46819))


### Performance Improvements

* **mitm-addon:** use asyncio.to_thread for blocking firewall auth requests ([#5638](https://github.com/vm0-ai/vm0/issues/5638)) ([e7a29b9](https://github.com/vm0-ai/vm0/commit/e7a29b9f94692400fd9ac592cefd30640b116199)), closes [#5635](https://github.com/vm0-ai/vm0/issues/5635)

## [0.39.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.38.1...runner-rs-v0.39.0) (2026-03-19)


### Features

* add disallowed_tools to vm0.yaml schema and server pipeline ([#5576](https://github.com/vm0-ai/vm0/issues/5576)) ([6ac49d7](https://github.com/vm0-ai/vm0/commit/6ac49d7434b456e01df4d3fa6bf918923b07b2f5))
* add zero agents rest api and remove compose jobs ([#5594](https://github.com/vm0-ai/vm0/issues/5594)) ([8e428bb](https://github.com/vm0-ai/vm0/commit/8e428bb40c663b50bb481928f708e004601ee1af))
* **runner:** pass disallowed tools from execution context to claude cli ([#5577](https://github.com/vm0-ai/vm0/issues/5577)) ([cdc557a](https://github.com/vm0-ai/vm0/commit/cdc557a4ccb873b37b5df3cc3eb550d6f0849e79)), closes [#5564](https://github.com/vm0-ai/vm0/issues/5564)


### Bug Fixes

* override mitmproxy bundled certificate store with system ca bundle ([#5529](https://github.com/vm0-ai/vm0/issues/5529)) ([b4e665f](https://github.com/vm0-ai/vm0/commit/b4e665f1f34e2d51c9dc9bbc45e8df3ffba3a603)), closes [#5524](https://github.com/vm0-ai/vm0/issues/5524)
* register vm in proxy before sandbox start to prevent missing network logs ([#5537](https://github.com/vm0-ai/vm0/issues/5537)) ([ebe67ba](https://github.com/vm0-ai/vm0/commit/ebe67ba9c895cd11915511c4c7d120916c78f5a7)), closes [#5535](https://github.com/vm0-ai/vm0/issues/5535)
* **runner:** add user-agent to mitmproxy firewall auth requests ([#5632](https://github.com/vm0-ai/vm0/issues/5632)) ([a9d25c9](https://github.com/vm0-ai/vm0/commit/a9d25c9ea81d9a61a167f3210c8d83e926a8859a)), closes [#5630](https://github.com/vm0-ai/vm0/issues/5630)
* **runner:** include runner log files in gc cleanup ([#5559](https://github.com/vm0-ai/vm0/issues/5559)) ([19f2985](https://github.com/vm0-ai/vm0/commit/19f29853615887101bb8dd0d8e5dff6da679fb0c)), closes [#5555](https://github.com/vm0-ai/vm0/issues/5555)
* **runner:** remove duplicate disallowed_tools field in execution context ([#5608](https://github.com/vm0-ai/vm0/issues/5608)) ([efed47a](https://github.com/vm0-ai/vm0/commit/efed47aaff3d010763a3af1120de8326cb37e2b8))


### Refactoring

* merge browser profile into default, install chromium in base rootfs ([#5568](https://github.com/vm0-ai/vm0/issues/5568)) ([e014dd1](https://github.com/vm0-ai/vm0/commit/e014dd1d9778d739b66844f2d67871ba61af9107)), closes [#5554](https://github.com/vm0-ai/vm0/issues/5554)

## [0.38.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.38.0...runner-rs-v0.38.1) (2026-03-19)


### Refactoring

* **sandbox:** remove dead use_proxy field from sandbox config ([#5483](https://github.com/vm0-ai/vm0/issues/5483)) ([97c8db8](https://github.com/vm0-ai/vm0/commit/97c8db89235175ba41f45817413b671c3d39fe3e)), closes [#5481](https://github.com/vm0-ai/vm0/issues/5481)

## [0.38.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.37.0...runner-rs-v0.38.0) (2026-03-19)


### Features

* **runner:** always register vms in proxy for network logging ([#5465](https://github.com/vm0-ai/vm0/issues/5465)) ([5508b23](https://github.com/vm0-ai/vm0/commit/5508b2326891cd4294a12ed392dc7e296611462d))

## [0.37.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.36.0...runner-rs-v0.37.0) (2026-03-19)


### Features

* inject agent identity env vars and add whoami command ([#5461](https://github.com/vm0-ai/vm0/issues/5461)) ([76ceb92](https://github.com/vm0-ai/vm0/commit/76ceb92d5559ed2987abbacc24fcf422ebad2753))

## [0.36.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.35.0...runner-rs-v0.36.0) (2026-03-19)


### Features

* **runner:** add vm0/browser profile with dockerfile and ci integration ([#5311](https://github.com/vm0-ai/vm0/issues/5311)) ([a6b6077](https://github.com/vm0-ai/vm0/commit/a6b6077eb2e8a83f48bed456e4ee7d5e3323c192))


### Bug Fixes

* **sandbox-fc:** use per-profile overlay directories to prevent cross-deletion ([#5413](https://github.com/vm0-ai/vm0/issues/5413)) ([a5c1a56](https://github.com/vm0-ai/vm0/commit/a5c1a56e0cbbf7ce305bf34414981ef3a08f2841)), closes [#5405](https://github.com/vm0-ai/vm0/issues/5405)

## [0.35.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.34.0...runner-rs-v0.35.0) (2026-03-18)


### Features

* add append-system-prompt support to runner and guest-agent ([#5384](https://github.com/vm0-ai/vm0/issues/5384)) ([37aaa76](https://github.com/vm0-ai/vm0/commit/37aaa76b7acdf8c24f2928590de54317870c3a21)), closes [#5375](https://github.com/vm0-ai/vm0/issues/5375)

## [0.34.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.33.0...runner-rs-v0.34.0) (2026-03-18)


### Features

* **runner:** add minimum age protection to runner gc ([#5347](https://github.com/vm0-ai/vm0/issues/5347)) ([e7cc167](https://github.com/vm0-ai/vm0/commit/e7cc167f44b64dc3b866c8de78b7e36fae1e503b)), closes [#5345](https://github.com/vm0-ai/vm0/issues/5345)

## [0.33.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.32.0...runner-rs-v0.33.0) (2026-03-18)


### Features

* **runner:** add profile support to local provider and submit command ([#5234](https://github.com/vm0-ai/vm0/issues/5234)) ([296dc94](https://github.com/vm0-ai/vm0/commit/296dc94707b5de7ca8113893b48c445765d69e37))

## [0.32.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.31.3...runner-rs-v0.32.0) (2026-03-17)


### Features

* **runner:** profile-aware discovery, budget reservation, and per-profile factory ([#5224](https://github.com/vm0-ai/vm0/issues/5224)) ([05e3803](https://github.com/vm0-ai/vm0/commit/05e3803c7566ec70be92c1e313fa1c58d2b6c779))

## [0.31.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.31.2...runner-rs-v0.31.3) (2026-03-17)


### Refactoring

* **sandbox-fc:** replace target-size pool pre-warming with fixed buffer ([#5191](https://github.com/vm0-ai/vm0/issues/5191)) ([4ce60ac](https://github.com/vm0-ai/vm0/commit/4ce60ac8c1c5b0f60dae8169d71135b11ee3b968))

## [0.31.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.31.1...runner-rs-v0.31.2) (2026-03-17)

## [0.31.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.31.0...runner-rs-v0.31.1) (2026-03-17)

## [0.31.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.30.0...runner-rs-v0.31.0) (2026-03-17)


### Features

* **runner:** add experimental profile passthrough from compose to runner ([#5100](https://github.com/vm0-ai/vm0/issues/5100)) ([5eb8dd4](https://github.com/vm0-ai/vm0/commit/5eb8dd44baaa24ea40baf2804ec022a3d006528a)), closes [#5037](https://github.com/vm0-ai/vm0/issues/5037)

## [0.30.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.29.3...runner-rs-v0.30.0) (2026-03-17)


### Features

* support {param*} wildcard for zero-or-more path segments ([#5114](https://github.com/vm0-ai/vm0/issues/5114)) ([408c637](https://github.com/vm0-ai/vm0/commit/408c637b37ed74ce20c9ac48b778f1a363dbe842))

## [0.29.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.29.2...runner-rs-v0.29.3) (2026-03-17)


### Bug Fixes

* {param+} path matching should require one or more segments ([#5106](https://github.com/vm0-ai/vm0/issues/5106)) ([b05ecd5](https://github.com/vm0-ai/vm0/commit/b05ecd5599e6c9a09232cdcef097f53d8d15161e))

## [0.29.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.29.1...runner-rs-v0.29.2) (2026-03-17)


### Refactoring

* **rust:** replace inline crate:: paths with top-level use imports ([#5061](https://github.com/vm0-ai/vm0/issues/5061)) ([149aaa0](https://github.com/vm0-ai/vm0/commit/149aaa09ca2bf69ffb1bc35471ba813e5884e534)), closes [#5038](https://github.com/vm0-ai/vm0/issues/5038)

## [0.29.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.29.0...runner-rs-v0.29.1) (2026-03-16)


### Bug Fixes

* return detailed json error on firewall 403 responses ([#5053](https://github.com/vm0-ai/vm0/issues/5053)) ([285cc4c](https://github.com/vm0-ai/vm0/commit/285cc4c6b79366fe6aedaeaeff4291a3fc584f1e))


### Refactoring

* align experimental_capabilities with resource model ([#5063](https://github.com/vm0-ai/vm0/issues/5063)) ([9d025ce](https://github.com/vm0-ai/vm0/commit/9d025ce6e43570242af0604181adb3047fe81370))
* rename firewall array fields to plural form ([#5034](https://github.com/vm0-ai/vm0/issues/5034)) ([79bd167](https://github.com/vm0-ai/vm0/commit/79bd1675288e6a5a92acb6ef9c199099b9dd11bf))

## [0.29.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.28.2...runner-rs-v0.29.0) (2026-03-16)


### Features

* **runner:** add profile definitions and multi-profile build pipeline ([#4952](https://github.com/vm0-ai/vm0/issues/4952)) ([0263ddd](https://github.com/vm0-ai/vm0/commit/0263ddd26ff25bf3c3e82ca66242b5bfa73e2466)), closes [#4941](https://github.com/vm0-ai/vm0/issues/4941)

## [0.28.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.28.1...runner-rs-v0.28.2) (2026-03-16)


### Refactoring

* **runner:** decouple ca generation from rootfs build ([#4968](https://github.com/vm0-ai/vm0/issues/4968)) ([0ef9a58](https://github.com/vm0-ai/vm0/commit/0ef9a5895005b46fa3ce209e1155a2b9703d2893)), closes [#4962](https://github.com/vm0-ai/vm0/issues/4962)

## [0.28.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.28.0...runner-rs-v0.28.1) (2026-03-16)


### Refactoring

* merge volume/artifact/memory capabilities into storage:read and storage:write ([#4959](https://github.com/vm0-ai/vm0/issues/4959)) ([cc0c3b4](https://github.com/vm0-ai/vm0/commit/cc0c3b40c3c6a5a8a6167a46531fb1db16191341)), closes [#4956](https://github.com/vm0-ai/vm0/issues/4956)

## [0.28.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.27.0...runner-rs-v0.28.0) (2026-03-16)


### Features

* **runner:** replace semaphore with resource-budget concurrency control ([#4928](https://github.com/vm0-ai/vm0/issues/4928)) ([48f674f](https://github.com/vm0-ai/vm0/commit/48f674fad4a567d9d8158b0e3fde65535366a71b))

## [0.27.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.26.2...runner-rs-v0.27.0) (2026-03-16)


### Features

* conditionally inject cli env vars in sandbox when capabilities present ([#4902](https://github.com/vm0-ai/vm0/issues/4902)) ([4b89998](https://github.com/vm0-ai/vm0/commit/4b899988768c0edc9781fb1ffefedec90de044e5)), closes [#4899](https://github.com/vm0-ai/vm0/issues/4899)


### Refactoring

* rename service to firewall across entire codebase ([#4877](https://github.com/vm0-ai/vm0/issues/4877)) ([#4895](https://github.com/vm0-ai/vm0/issues/4895)) ([d40192b](https://github.com/vm0-ai/vm0/commit/d40192b6df5672d525dd39b9215a167ba42a3722))

## [0.26.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.26.1...runner-rs-v0.26.2) (2026-03-16)


### Refactoring

* **services:** unify secret template syntax to ${{ }} ([#4862](https://github.com/vm0-ai/vm0/issues/4862)) ([607e8e9](https://github.com/vm0-ai/vm0/commit/607e8e9be8eb83b60895898686ca94f711f6debb)), closes [#4806](https://github.com/vm0-ai/vm0/issues/4806)

## [0.26.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.26.0...runner-rs-v0.26.1) (2026-03-15)

## [0.26.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.25.0...runner-rs-v0.26.0) (2026-03-15)


### Features

* **services:** add oauth token refresh and ttl caching to auth endpoint ([#4802](https://github.com/vm0-ai/vm0/issues/4802)) ([eab1747](https://github.com/vm0-ai/vm0/commit/eab17475db94fbbc8e5a4d8317851fb09fef28a9))

## [0.25.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.24.1...runner-rs-v0.25.0) (2026-03-14)


### Features

* **runner:** plumb secret-connector map from build to proxy addon ([#4764](https://github.com/vm0-ai/vm0/issues/4764)) ([dcde11d](https://github.com/vm0-ai/vm0/commit/dcde11dd12a1484e4050370848e51f8bd4a14946))

## [0.24.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.24.0...runner-rs-v0.24.1) (2026-03-14)


### Bug Fixes

* **services:** allow same permission name across different api_entries ([#4754](https://github.com/vm0-ai/vm0/issues/4754)) ([2b84536](https://github.com/vm0-ai/vm0/commit/2b845369ead0589dfc6e26dded933b75f94f2ab0))

## [0.24.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.23.0...runner-rs-v0.24.0) (2026-03-13)


### Features

* **services:** permission-based request matching in mitm_addon ([#4721](https://github.com/vm0-ai/vm0/issues/4721)) ([98267dd](https://github.com/vm0-ai/vm0/commit/98267ddeb6d01e7b9b1c4599ead7a9c173b67130))


### Refactoring

* change experimental services from flat apis to nested service entries ([#4711](https://github.com/vm0-ai/vm0/issues/4711)) ([a7dbfc8](https://github.com/vm0-ai/vm0/commit/a7dbfc8a18e65350ef701628f1b3e6ed6837d282))
* eliminate remaining scope references ([#4703](https://github.com/vm0-ai/vm0/issues/4703)) ([fd85a3b](https://github.com/vm0-ai/vm0/commit/fd85a3b6b4f4fe10eb0ff36a1f5140888d9a57f1))
* rename remaining scope references to org in contracts ([#4695](https://github.com/vm0-ai/vm0/issues/4695)) ([9d4a05e](https://github.com/vm0-ai/vm0/commit/9d4a05e89cd28a98f3496149bdaf5f19e93207eb)), closes [#4688](https://github.com/vm0-ai/vm0/issues/4688)

## [0.23.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.8...runner-rs-v0.23.0) (2026-03-13)


### Features

* **services:** add permission type definitions ([#4659](https://github.com/vm0-ai/vm0/issues/4659)) ([5c7e96a](https://github.com/vm0-ai/vm0/commit/5c7e96ab41040602ca40a55fd966e2ba2b5dab7d))

## [0.22.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.7...runner-rs-v0.22.8) (2026-03-12)


### Refactoring

* reorder mitm-addon request handling to enforce firewall before services ([#4625](https://github.com/vm0-ai/vm0/issues/4625)) ([28ea3a5](https://github.com/vm0-ai/vm0/commit/28ea3a50e5598c293cb920cbe67ded089829d653)), closes [#4624](https://github.com/vm0-ai/vm0/issues/4624)
* **services:** addon encrypted-secrets passthrough and auth endpoint rewrite ([#4613](https://github.com/vm0-ai/vm0/issues/4613)) ([3f19c4c](https://github.com/vm0-ai/vm0/commit/3f19c4c87102a69aeb75ed2f3102904c9479d7e9))

## [0.22.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.6...runner-rs-v0.22.7) (2026-03-12)


### Refactoring

* **services:** forward encryptedSecrets through proxy registry ([#4604](https://github.com/vm0-ai/vm0/issues/4604)) ([21ca7a1](https://github.com/vm0-ai/vm0/commit/21ca7a138f7633c2204ae38a82ce6b1a9c9c1193))

## [0.22.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.5...runner-rs-v0.22.6) (2026-03-12)


### Refactoring

* remove experimental_mitm and always enable mitm when proxy is active ([#4568](https://github.com/vm0-ai/vm0/issues/4568)) ([34e1257](https://github.com/vm0-ai/vm0/commit/34e1257a96ceb70a50c07fa258a442c940b5ef95))
* remove sni mode dead code from network logging ([#4592](https://github.com/vm0-ai/vm0/issues/4592)) ([20a55a8](https://github.com/vm0-ai/vm0/commit/20a55a8cc7cfd5284b072ec945c23185a58d1d8f))
* **runner:** rename secrets variable to match field name ([#4588](https://github.com/vm0-ai/vm0/issues/4588)) ([5a1413d](https://github.com/vm0-ai/vm0/commit/5a1413dabecf8a3c5966c7c860cb6a93f9f21ad6))
* **services:** pass encrypted-secrets blob in claim response to runner ([#4599](https://github.com/vm0-ai/vm0/issues/4599)) ([ffdfe6e](https://github.com/vm0-ai/vm0/commit/ffdfe6e617cceb1823e700f3754aa55dde3d5def))

## [0.22.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.4...runner-rs-v0.22.5) (2026-03-12)


### Refactoring

* remove proxy rewrite endpoint and seal secrets ([#4539](https://github.com/vm0-ai/vm0/issues/4539)) ([f7af830](https://github.com/vm0-ai/vm0/commit/f7af8301f67b87f4615dad8e9b8a00adb449aeba))

## [0.22.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.3...runner-rs-v0.22.4) (2026-03-12)


### Refactoring

* remove balloon_reclaim flag and enable balloon reclaim unconditionally ([#4473](https://github.com/vm0-ai/vm0/issues/4473)) ([b386091](https://github.com/vm0-ai/vm0/commit/b38609140426569f3fe0c3cc3e56bf81ee477583))
* remove secret names from execution context ([#4489](https://github.com/vm0-ai/vm0/issues/4489)) ([bc70477](https://github.com/vm0-ai/vm0/commit/bc704775200d97dac742f730cb93350609636006))
* **runner:** stop injecting vars directly as environment variables ([#4482](https://github.com/vm0-ai/vm0/issues/4482)) ([c47674a](https://github.com/vm0-ai/vm0/commit/c47674acb4d22d929b7d98c237947192e89b1f61))

## [0.22.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.2...runner-rs-v0.22.3) (2026-03-11)


### Bug Fixes

* **runner:** log response headers in network logs for zlib error debugging ([#4400](https://github.com/vm0-ai/vm0/issues/4400)) ([47207fa](https://github.com/vm0-ai/vm0/commit/47207fa18c72b204219a9171418ed5dc21f19e8e))


### Refactoring

* decouple service proxy config from connector concept ([#4388](https://github.com/vm0-ai/vm0/issues/4388)) ([b970b33](https://github.com/vm0-ai/vm0/commit/b970b33d97fc4f1cf825215e4b94ed182110c31f))

## [0.22.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.1...runner-rs-v0.22.2) (2026-03-11)


### Bug Fixes

* **mitm-addon:** stream all responses to prevent zlib error ([#4350](https://github.com/vm0-ai/vm0/issues/4350)) ([fd72f46](https://github.com/vm0-ai/vm0/commit/fd72f46af290c13cba9f655995265eb6269776ac))

## [0.22.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.0...runner-rs-v0.22.1) (2026-03-11)


### Bug Fixes

* enable selective streaming in mitm proxy to avoid zliberror ([#4223](https://github.com/vm0-ai/vm0/issues/4223)) ([9d89bd3](https://github.com/vm0-ai/vm0/commit/9d89bd3c3a3f39f54a319bd81b040bd4081206aa))

## [0.22.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.21.1...runner-rs-v0.22.0) (2026-03-10)


### Features

* **connectors:** implement proxy-side auth header injection for experimental connectors ([#4072](https://github.com/vm0-ai/vm0/issues/4072)) ([dabc986](https://github.com/vm0-ai/vm0/commit/dabc986158c0d98068a06599724da3307a4904f7))


### Bug Fixes

* remove overly broad "killed process" pattern from oom detection ([#4127](https://github.com/vm0-ai/vm0/issues/4127)) ([42b8acf](https://github.com/vm0-ai/vm0/commit/42b8acf959b9d29909e7944f0048320f3215843a))
* remove overly broad killed process pattern from oom detection ([#4147](https://github.com/vm0-ai/vm0/issues/4147)) ([8766dd9](https://github.com/vm0-ai/vm0/commit/8766dd98ba36113be183d666ec661e99177406b5))

## [0.21.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.21.0...runner-rs-v0.21.1) (2026-03-10)

## [0.21.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.20.4...runner-rs-v0.21.0) (2026-03-09)


### Features

* **connectors:** add experimental connectors data pipeline ([#4048](https://github.com/vm0-ai/vm0/issues/4048)) ([f3ad976](https://github.com/vm0-ai/vm0/commit/f3ad976c82d86300636b545aa8b5b23c6ebfc744))

## [0.20.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.20.3...runner-rs-v0.20.4) (2026-03-09)


### Bug Fixes

* ensure system env vars take precedence over user-provided variables ([#3921](https://github.com/vm0-ai/vm0/issues/3921)) ([fcfa1f2](https://github.com/vm0-ai/vm0/commit/fcfa1f2ac77f31648dd655c61cc3030518400df1))

## [0.20.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.20.2...runner-rs-v0.20.3) (2026-03-09)


### Bug Fixes

* **storage:** unify memory storage auto-creation with artifact pattern ([#3944](https://github.com/vm0-ai/vm0/issues/3944)) ([e2af883](https://github.com/vm0-ai/vm0/commit/e2af88330c3bf305c1586ffd4315dff19a4e7504))


### Refactoring

* **runner:** make runner doctor tolerant of transient states ([#3943](https://github.com/vm0-ai/vm0/issues/3943)) ([f0c0dbf](https://github.com/vm0-ai/vm0/commit/f0c0dbfbcc3581ba8f1e157b871358dfe5632fab))

## [0.20.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.20.1...runner-rs-v0.20.2) (2026-03-08)

## [0.20.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.20.0...runner-rs-v0.20.1) (2026-03-07)


### Bug Fixes

* **runner:** use proper shell escaping in executor guest commands ([#3902](https://github.com/vm0-ai/vm0/issues/3902)) ([f5b5031](https://github.com/vm0-ai/vm0/commit/f5b5031be43a8fe814da676c472d586fb25ce29e))
* use correct storage type in memory dedup path and propagate checkpoint errors ([#3906](https://github.com/vm0-ai/vm0/issues/3906)) ([9abe586](https://github.com/vm0-ai/vm0/commit/9abe586d92126cef4fc9f7c2fa4319c7448e86dd))

## [0.20.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.19.4...runner-rs-v0.20.0) (2026-03-07)


### Features

* add --memory flag for agent long-term memory ([#3424](https://github.com/vm0-ai/vm0/issues/3424)) ([9e0279f](https://github.com/vm0-ai/vm0/commit/9e0279f618efe5396dda9e1aaac43a72bba70bfe))


### Bug Fixes

* **guest-init:** set correct env vars for sudo and user sessions ([#3892](https://github.com/vm0-ai/vm0/issues/3892)) ([a1f46e3](https://github.com/vm0-ai/vm0/commit/a1f46e3204f6f897f793118f97a3731d2b370bb3))

## [0.19.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.19.3...runner-rs-v0.19.4) (2026-03-07)

## [0.19.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.19.2...runner-rs-v0.19.3) (2026-03-06)

## [0.19.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.19.1...runner-rs-v0.19.2) (2026-03-06)

## [0.19.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.19.0...runner-rs-v0.19.1) (2026-03-06)

## [0.19.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.18.0...runner-rs-v0.19.0) (2026-03-05)


### Features

* **runner:** balloon reclaim with per-tick inflate cap and full ci test ([#3711](https://github.com/vm0-ai/vm0/issues/3711)) ([7f7efc2](https://github.com/vm0-ai/vm0/commit/7f7efc2f845686899c62ce20cbf992cc9cc5c7df))

## [0.18.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.17.0...runner-rs-v0.18.0) (2026-03-05)


### Features

* **sandbox-fc:** add per-sandbox balloon memory reclaim controller ([#3700](https://github.com/vm0-ai/vm0/issues/3700)) ([10f121b](https://github.com/vm0-ai/vm0/commit/10f121bc06e87f23a48af9b4b971faacef620442)), closes [#3697](https://github.com/vm0-ai/vm0/issues/3697)


### Bug Fixes

* set api start time inside create-run for e2e telemetry ([#3707](https://github.com/vm0-ai/vm0/issues/3707)) ([e902696](https://github.com/vm0-ai/vm0/commit/e902696adb72414e5b248552379ee59c9cbbabd0)), closes [#3706](https://github.com/vm0-ai/vm0/issues/3706)

## [0.17.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.16.0...runner-rs-v0.17.0) (2026-03-05)


### Features

* **sandbox-fc:** enable balloon stats and add runtime balloon api ([#3694](https://github.com/vm0-ai/vm0/issues/3694)) ([b5918d6](https://github.com/vm0-ai/vm0/commit/b5918d6e7f7c82f79693b725bad2b5c547016655)), closes [#3688](https://github.com/vm0-ai/vm0/issues/3688)
* **sandbox-fc:** enable virtio-balloon with deflate_on_oom as safety net ([#3679](https://github.com/vm0-ai/vm0/issues/3679)) ([2ce2b62](https://github.com/vm0-ai/vm0/commit/2ce2b62c991a9e4bc077438630eb21267b618dc2)), closes [#3666](https://github.com/vm0-ai/vm0/issues/3666)

## [0.16.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.15.1...runner-rs-v0.16.0) (2026-03-05)


### Features

* **runner:** add concurrency-factor parameter for cpu overcommit ([#3669](https://github.com/vm0-ai/vm0/issues/3669)) ([528afa4](https://github.com/vm0-ai/vm0/commit/528afa4c9d6670abcfef0ce412ba12568e196295))

## [0.15.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.15.0...runner-rs-v0.15.1) (2026-03-04)


### Bug Fixes

* **runner:** remove trigger comment and bump for release ([#3654](https://github.com/vm0-ai/vm0/issues/3654)) ([fadb62c](https://github.com/vm0-ai/vm0/commit/fadb62c3b89cd978c280fe046b23b708cdad4db4))

## [0.15.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.14.0...runner-rs-v0.15.0) (2026-03-04)


### Features

* **runner:** add --name filter to runner doctor ([#3615](https://github.com/vm0-ai/vm0/issues/3615)) ([4e8597c](https://github.com/vm0-ai/vm0/commit/4e8597cf8f0f1f6339841abcb066590768bef84a))

## [0.14.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.13.0...runner-rs-v0.14.0) (2026-03-04)


### Features

* **runner:** auto-calculate max_concurrent from host resources ([#3528](https://github.com/vm0-ai/vm0/issues/3528)) ([eee7ead](https://github.com/vm0-ai/vm0/commit/eee7ead8925bfdfd51269b116041a745df0564a6))

## [0.13.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.12.3...runner-rs-v0.13.0) (2026-03-03)


### Features

* **runner:** add exec command for live vm debugging ([#3502](https://github.com/vm0-ai/vm0/issues/3502)) ([0453c3b](https://github.com/vm0-ai/vm0/commit/0453c3bd7a32f9b9e2760ff30e4aea192a9b0836))

## [0.12.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.12.2...runner-rs-v0.12.3) (2026-03-02)


### Miscellaneous Chores

* **runner-rs:** Synchronize runner-guest versions

## [0.12.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.12.1...runner-rs-v0.12.2) (2026-03-02)


### Performance Improvements

* **sandbox-fc:** use full cli invocation for snapshot pre-warm ([#3395](https://github.com/vm0-ai/vm0/issues/3395)) ([318deaa](https://github.com/vm0-ai/vm0/commit/318deaa20216059e92c1702a10ef0203c98af00e))

## [0.12.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.12.0...runner-rs-v0.12.1) (2026-03-01)


### Performance Improvements

* **runner:** prefetch snapshot memory.bin via sequential read ([#3373](https://github.com/vm0-ai/vm0/issues/3373)) ([21289eb](https://github.com/vm0-ai/vm0/commit/21289ebcff774e6c763a350dbb57be23f1ebeed8)), closes [#3342](https://github.com/vm0-ai/vm0/issues/3342)

## [0.12.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.11.0...runner-rs-v0.12.0) (2026-03-01)


### Features

* **runner:** add --env flag to benchmark command ([#3335](https://github.com/vm0-ai/vm0/issues/3335)) ([25683a5](https://github.com/vm0-ai/vm0/commit/25683a5049ae80a3644a065d4f401f8ca1887052))

## [0.11.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.10.0...runner-rs-v0.11.0) (2026-03-01)


### Features

* **runner:** copy guest system log to host after job ([#3329](https://github.com/vm0-ai/vm0/issues/3329)) ([e1fc90b](https://github.com/vm0-ai/vm0/commit/e1fc90ba7f5f8b555a93028e05086ffac6c3c003))
* **runner:** redirect guest-download output to system log file ([#3328](https://github.com/vm0-ai/vm0/issues/3328)) ([68ba78d](https://github.com/vm0-ai/vm0/commit/68ba78dcb0e931aae14c74d1cd809b4f6d5924d1))

## [0.10.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.9.0...runner-rs-v0.10.0) (2026-03-01)


### Miscellaneous Chores

* **runner-rs:** Synchronize runner-guest versions

## [0.9.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.5...runner-rs-v0.9.0) (2026-03-01)


### Features

* **runner:** embed guest binaries via build.rs ([#3319](https://github.com/vm0-ai/vm0/issues/3319)) ([acacb39](https://github.com/vm0-ai/vm0/commit/acacb39e6861d04853f148be090367f6de0e8f8a))

## [0.8.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.4...runner-rs-v0.8.5) (2026-02-28)


### Bug Fixes

* **runner:** deterministic active_run_ids order in status.json ([#3290](https://github.com/vm0-ai/vm0/issues/3290)) ([b87e8a2](https://github.com/vm0-ai/vm0/commit/b87e8a28d6bd1e8adf1d7ce9dfc133c2aa8f9893))

## [0.8.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.3...runner-rs-v0.8.4) (2026-02-27)


### Performance Improvements

* **rootfs:** install claude code as standalone binary for faster cold-start ([#3278](https://github.com/vm0-ai/vm0/issues/3278)) ([e8cbefa](https://github.com/vm0-ai/vm0/commit/e8cbefad6e5d3f6ea91d0eefd07baac743db8ab1))

## [0.8.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.2...runner-rs-v0.8.3) (2026-02-27)


### Performance Improvements

* **sandbox-fc:** pre-warm real claude execution path instead of --help ([#3272](https://github.com/vm0-ai/vm0/issues/3272)) ([5d95121](https://github.com/vm0-ai/vm0/commit/5d95121b69e9ac5dbe76cb0859cc90b4b48a3743)), closes [#3258](https://github.com/vm0-ai/vm0/issues/3258)

## [0.8.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.1...runner-rs-v0.8.2) (2026-02-27)


### Bug Fixes

* **sandbox-fc:** use deterministic mac on tap devices for snapshot arp stability ([#3269](https://github.com/vm0-ai/vm0/issues/3269)) ([4c73c27](https://github.com/vm0-ai/vm0/commit/4c73c275ae6ae6bb3fbea6b5ee93ee5b0b761418)), closes [#3268](https://github.com/vm0-ai/vm0/issues/3268)

## [0.8.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.0...runner-rs-v0.8.1) (2026-02-26)


### Bug Fixes

* **sandbox-fc:** remove double su wrapper from prewarm script ([#3265](https://github.com/vm0-ai/vm0/issues/3265)) ([3df62d1](https://github.com/vm0-ai/vm0/commit/3df62d1b9be9310e5112f3423edce504295f1775))


### Performance Improvements

* **sandbox-fc:** enable v8 compile cache for faster cli cold start ([#3267](https://github.com/vm0-ai/vm0/issues/3267)) ([6f1c8be](https://github.com/vm0-ai/vm0/commit/6f1c8be89cd5c7168326b5fa822d26eb2f9fa824))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.7.0...runner-rs-v0.8.0) (2026-02-25)


### Miscellaneous Chores

* **runner-rs:** Synchronize runner-guest versions

## [0.7.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.3.4...runner-rs-v0.7.0) (2026-02-25)


### Miscellaneous Chores

* **runner-rs:** Synchronize runner-guest versions

## [0.3.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.3.3...runner-rs-v0.3.4) (2026-02-23)


### Performance Improvements

* **sandbox-fc:** pre-warm claude and codex in snapshot ([#3232](https://github.com/vm0-ai/vm0/issues/3232)) ([5534465](https://github.com/vm0-ai/vm0/commit/553446505f92aa30b1ac38b396f9238a6ff4c9ac))

## [0.3.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.3.2...runner-rs-v0.3.3) (2026-02-23)

## [0.3.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.3.1...runner-rs-v0.3.2) (2026-02-23)

## [0.3.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.3.0...runner-rs-v0.3.1) (2026-02-22)

## [0.3.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.2.0...runner-rs-v0.3.0) (2026-02-22)


### Features

* **runner:** extend gc to clean up old deployment versions ([#3201](https://github.com/vm0-ai/vm0/issues/3201)) ([09f2d1c](https://github.com/vm0-ai/vm0/commit/09f2d1cabac6089daf4bb2365abb88d95e1065c4))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.1.0...runner-rs-v0.2.0) (2026-02-22)


### Features

* allow users to set timezone preference for sandbox and scheduling ([#2866](https://github.com/vm0-ai/vm0/issues/2866)) ([89437c7](https://github.com/vm0-ai/vm0/commit/89437c733b4e34eee46009b20c99f455c5963289))
* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **runner:** add --dry-run flag to rootfs, snapshot, and build commands ([#3169](https://github.com/vm0-ai/vm0/issues/3169)) ([62b62e3](https://github.com/vm0-ai/vm0/commit/62b62e3cf2931ae14a67ed8d481f702131a4e323)), closes [#3168](https://github.com/vm0-ai/vm0/issues/3168)
* **runner:** add --env flag to runner service start/install ([#3112](https://github.com/vm0-ai/vm0/issues/3112)) ([d2f8ec8](https://github.com/vm0-ai/vm0/commit/d2f8ec85ca4591ac4f4aa12ffebc073bd1f6ed9f))
* **runner:** add `runner doctor` command for runtime health diagnostics ([#3138](https://github.com/vm0-ai/vm0/issues/3138)) ([e075414](https://github.com/vm0-ai/vm0/commit/e075414291d0aa313af2f903f2f46d75ab0f92b8))
* **runner:** add `runner gc` command to clean up unused rootfs and snapshots ([#3128](https://github.com/vm0-ai/vm0/issues/3128)) ([d4e6235](https://github.com/vm0-ai/vm0/commit/d4e6235c40a63d4f1411ce982ab1800d905d6fe7))
* **runner:** add `setup` command to download firecracker and kernel ([#2825](https://github.com/vm0-ai/vm0/issues/2825)) ([f5ba977](https://github.com/vm0-ai/vm0/commit/f5ba9773e0c4ed54c56cad26d30abc3dafa1bfda))
* **runner:** add ably realtime subscription to start command ([#3048](https://github.com/vm0-ai/vm0/issues/3048)) ([553ba2d](https://github.com/vm0-ai/vm0/commit/553ba2d1727466fd30683a4dd690036df995d7e9))
* **runner:** add benchmark subcommand for single-shot vm execution ([#2982](https://github.com/vm0-ai/vm0/issues/2982)) ([a4ee02a](https://github.com/vm0-ai/vm0/commit/a4ee02ad56e2c86b6a4bbbc9f03fa6ebe99c474c))
* **runner:** add build command combining rootfs + snapshot ([#2914](https://github.com/vm0-ai/vm0/issues/2914)) ([305c038](https://github.com/vm0-ai/vm0/commit/305c03867368a44f30d2421e9f23490ec91e960f))
* **runner:** add build-rootfs command to replace bash script ([#2858](https://github.com/vm0-ai/vm0/issues/2858)) ([3a298f6](https://github.com/vm0-ai/vm0/commit/3a298f6a29941e14e062cfb4301ea112c69ccad4))
* **runner:** add execution telemetry for sandbox operations ([#3068](https://github.com/vm0-ai/vm0/issues/3068)) ([4e7fbb3](https://github.com/vm0-ai/vm0/commit/4e7fbb3545f1d548a8e6345d120b560a0a3439a2))
* **runner:** add firewall rules and seal secrets to proxy registry ([#3028](https://github.com/vm0-ai/vm0/issues/3028)) ([752f9b5](https://github.com/vm0-ai/vm0/commit/752f9b549447dde65c23bd81bcc9e805796d441d))
* **runner:** add kill command to terminate running sandboxes ([#3153](https://github.com/vm0-ai/vm0/issues/3153)) ([26d4e7d](https://github.com/vm0-ai/vm0/commit/26d4e7d1763eaa55166e243ecc96052ceba15c7c))
* **runner:** add local job provider and submit command ([#3158](https://github.com/vm0-ai/vm0/issues/3158)) ([4d300cb](https://github.com/vm0-ai/vm0/commit/4d300cb95baa0713866d7332a050e4b5b32c6ac1))
* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add proxy support to start command ([#3045](https://github.com/vm0-ai/vm0/issues/3045)) ([5a7016f](https://github.com/vm0-ai/vm0/commit/5a7016f20e698c616728d42bca481c8c87338623))
* **runner:** add runner.yaml config file generated by build ([#2935](https://github.com/vm0-ai/vm0/issues/2935)) ([9b9577a](https://github.com/vm0-ai/vm0/commit/9b9577a3197b72f64866ff12769fa919c252a347))
* **runner:** add service subcommand for systemd lifecycle management ([#3098](https://github.com/vm0-ai/vm0/issues/3098)) ([9686c65](https://github.com/vm0-ai/vm0/commit/9686c659797f53c58333903968a4b3b62d3523ef))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** add version flag to cli ([#3038](https://github.com/vm0-ai/vm0/issues/3038)) ([0afc49a](https://github.com/vm0-ai/vm0/commit/0afc49a163e76d6f999fb9c94ff3067109f0ff8e))
* **runner:** auto-restart mitmproxy on crash ([#3083](https://github.com/vm0-ai/vm0/issues/3083)) ([2261025](https://github.com/vm0-ai/vm0/commit/2261025f85537333b76299903748be96c5c9dfb5))
* **runner:** detect oom kills and return clear error message ([#3093](https://github.com/vm0-ai/vm0/issues/3093)) ([38718c9](https://github.com/vm0-ai/vm0/commit/38718c9a00485e33a623954778e41cdfda89ec0f))
* **runner:** download and install mitmdump in setup command ([#2838](https://github.com/vm0-ai/vm0/issues/2838)) ([d171672](https://github.com/vm0-ai/vm0/commit/d171672409b0cdd1b850dc3db07d1ecbc5592364))
* **runner:** gc stale network log files older than 7 days ([#3137](https://github.com/vm0-ai/vm0/issues/3137)) ([43bb9c1](https://github.com/vm0-ai/vm0/commit/43bb9c1ec457b208005333bcdd570c2860fbc429))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **runner:** log snapshot file sizes (logical and disk) ([#2997](https://github.com/vm0-ai/vm0/issues/2997)) ([671cbad](https://github.com/vm0-ai/vm0/commit/671cbad4d55594dbc5df4858fa6acbfffcbee57b))
* **runner:** replace socket-based local provider with file queue ([#3166](https://github.com/vm0-ai/vm0/issues/3166)) ([658c007](https://github.com/vm0-ai/vm0/commit/658c007f30a633934d4d691791b46361ddf236fc))
* **runner:** upload mitmproxy network logs to telemetry endpoint ([#3071](https://github.com/vm0-ai/vm0/issues/3071)) ([80023b0](https://github.com/vm0-ai/vm0/commit/80023b0f627d6b3b57bd1aa9a46cd4244118710e))
* **runner:** use service install/drain in ci upgrade test ([#3167](https://github.com/vm0-ai/vm0/issues/3167)) ([4ebb1d7](https://github.com/vm0-ai/vm0/commit/4ebb1d73afd5405cdbe21d0c4aa88280606f386b))
* **runner:** write logs to file in addition to stderr ([#3101](https://github.com/vm0-ai/vm0/issues/3101)) ([fa4000b](https://github.com/vm0-ai/vm0/commit/fa4000bec7db04abcc040076121c43caecbf3354))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **crates:** use system tls certificates instead of bundled webpki-roots ([#2824](https://github.com/vm0-ai/vm0/issues/2824)) ([aa95e93](https://github.com/vm0-ai/vm0/commit/aa95e9328dc99d77215d30e8545de11211a12792))
* **runner:** add exclusive lock on base_dir to prevent silent data corruption ([#3126](https://github.com/vm0-ai/vm0/issues/3126)) ([61ac8b7](https://github.com/vm0-ai/vm0/commit/61ac8b7e9121465d934f77c9dd8fb47acbc883ab)), closes [#3125](https://github.com/vm0-ai/vm0/issues/3125)
* **runner:** add flock to prevent concurrent rootfs/snapshot builds ([#2980](https://github.com/vm0-ai/vm0/issues/2980)) ([96a8559](https://github.com/vm0-ai/vm0/commit/96a8559f03ebebc0833af97d7bfe5c3c1562cb24))
* **runner:** add path validation and ci hash guards ([#3161](https://github.com/vm0-ai/vm0/issues/3161)) ([c5313ff](https://github.com/vm0-ai/vm0/commit/c5313ffdaee030c5fb3d48b950c8d7b6e36e90ae))
* **runner:** clean up request_start_times on flow error in mitm-addon ([#3076](https://github.com/vm0-ai/vm0/issues/3076)) ([a6e8cb1](https://github.com/vm0-ai/vm0/commit/a6e8cb1d9b9dece53f66aea35b8c32627bf4270e)), closes [#3073](https://github.com/vm0-ai/vm0/issues/3073)
* **runner:** exclude network log upload from cleanup telemetry metric ([#3075](https://github.com/vm0-ai/vm0/issues/3075)) ([5b1beb1](https://github.com/vm0-ai/vm0/commit/5b1beb1a06cf19ebc67ba435a03ada529ef47f22)), closes [#3072](https://github.com/vm0-ai/vm0/issues/3072)
* **runner:** forward mock-claude env var to guest ([#3089](https://github.com/vm0-ai/vm0/issues/3089)) ([2978851](https://github.com/vm0-ai/vm0/commit/297885167fb36a2fcd1b3a5566a4c00bf4a571cb)), closes [#3088](https://github.com/vm0-ai/vm0/issues/3088)
* **runner:** gc removes unused lock files with safe inode recheck ([#3132](https://github.com/vm0-ai/vm0/issues/3132)) ([1e9d234](https://github.com/vm0-ai/vm0/commit/1e9d2345cb3209ade7b8f17f221f3621e9915172)), closes [#3131](https://github.com/vm0-ai/vm0/issues/3131)
* **runner:** prevent vm process leak on executor task panic ([#3079](https://github.com/vm0-ai/vm0/issues/3079)) ([6677bb5](https://github.com/vm0-ai/vm0/commit/6677bb55aa95096988c634879b23a775c9d63352)), closes [#3078](https://github.com/vm0-ai/vm0/issues/3078)
* **runner:** re-establish ably subscription after fatal error ([#3077](https://github.com/vm0-ai/vm0/issues/3077)) ([be681ca](https://github.com/vm0-ai/vm0/commit/be681cada26167aa8ebe1809edb326621902085b)), closes [#3074](https://github.com/vm0-ai/vm0/issues/3074)
* **runner:** sanitize runner name used in log file prefix ([#3103](https://github.com/vm0-ai/vm0/issues/3103)) ([b028b89](https://github.com/vm0-ai/vm0/commit/b028b89440019c077c0a0fc8cfced3178f74d797))
* **runner:** set node ca certs env var for mitm mode ([#3091](https://github.com/vm0-ai/vm0/issues/3091)) ([8626d58](https://github.com/vm0-ai/vm0/commit/8626d58b203a6fdbabea21aa21cb228ddc9cff78))
* **runner:** sort gc artifacts by last-used time instead of creation time ([#3130](https://github.com/vm0-ai/vm0/issues/3130)) ([42efcb2](https://github.com/vm0-ai/vm0/commit/42efcb29da6ef4d96fe6fb640953354f12bda516))
* **runner:** use run_id as sandbox_id instead of random uuid ([#3151](https://github.com/vm0-ai/vm0/issues/3151)) ([3e13c72](https://github.com/vm0-ai/vm0/commit/3e13c727b7a972c76b0f96c56e59ef2e65eca864))
* **runner:** walk ppid chain for orphan detection instead of checking immediate parent ([#3154](https://github.com/vm0-ai/vm0/issues/3154)) ([c377a54](https://github.com/vm0-ai/vm0/commit/c377a544643cd1908b32e505d533448ed73bc98c))
* **sandbox-fc:** move runtime sockets to /run/vm0 to fix sun_path limit ([#2951](https://github.com/vm0-ai/vm0/issues/2951)) ([#2966](https://github.com/vm0-ai/vm0/issues/2966)) ([4b91e0d](https://github.com/vm0-ai/vm0/commit/4b91e0d9ad2f677475afd768f95f19af852c9b46))


### Performance Improvements

* **sandbox-fc:** include prewarm script in snapshot hash computation ([#3004](https://github.com/vm0-ai/vm0/issues/3004)) ([3c27ac0](https://github.com/vm0-ai/vm0/commit/3c27ac0b4ffb8ab487fbea71cf62bf9681f31b0f)), closes [#3002](https://github.com/vm0-ai/vm0/issues/3002)
