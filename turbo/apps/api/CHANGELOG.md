# Changelog

Releases before September 2026 are archived by month:

- [2026-08](changelog/2026-08/CHANGELOG.md)
- [2026-07](changelog/2026-07/CHANGELOG.md)
- [2026-06](changelog/2026-06/CHANGELOG.md)
- [2026-05](changelog/2026-05/CHANGELOG.md)
- [2026-04](changelog/2026-04/CHANGELOG.md)

## [1.598.0](https://github.com/vm0-ai/vm0/compare/api-v1.597.0...api-v1.598.0) (2026-09-14)


### Features

* **pi-memory:** tier evidence and cap complete stage 1 requests ([#34112](https://github.com/vm0-ai/vm0/issues/34112)) ([3f48ba3](https://github.com/vm0-ai/vm0/commit/3f48ba3f8d20e03b7ccd4fafd661cfcddfda5f1f))


### Bug Fixes

* **social:** align download billing and delivered media metadata ([#34070](https://github.com/vm0-ai/vm0/issues/34070)) ([9c55bc9](https://github.com/vm0-ai/vm0/commit/9c55bc983c52f37369576d36eb32fbb0aec94994))


### Refactoring

* **api:** prepare explicit pending usage-pack writes ([#34110](https://github.com/vm0-ai/vm0/issues/34110)) ([3c8b18e](https://github.com/vm0-ai/vm0/commit/3c8b18edd7ed9d696bbdeddfc3ceed98c84036f4))
* remove voice input v2 feature switch ([#33884](https://github.com/vm0-ai/vm0/issues/33884)) ([be1af01](https://github.com/vm0-ai/vm0/commit/be1af014b3329820ca167fec5238e02c73d6bc7d))
* **voice:** finish voice input v2 cleanup ([#34119](https://github.com/vm0-ai/vm0/issues/34119)) ([6958a1e](https://github.com/vm0-ai/vm0/commit/6958a1e767281f3a958ee0e853b159fe56525f7d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.438.1
    * @okouai/core bumped to 8.663.1
    * @okouai/db bumped to 1.256.1
    * @okouai/pi-agent-runtime bumped to 1.29.0

## [1.597.0](https://github.com/vm0-ai/vm0/compare/api-v1.596.0...api-v1.597.0) (2026-09-14)


### Features

* **api:** add dormant account erasure foundation ([#34015](https://github.com/vm0-ai/vm0/issues/34015)) ([41d4647](https://github.com/vm0-ai/vm0/commit/41d46475030705aff23e3c5a2a980d7b486a5e89)), closes [#34003](https://github.com/vm0-ai/vm0/issues/34003)
* **cli:** add youtube transcript and summary refresh ([#34064](https://github.com/vm0-ai/vm0/issues/34064)) ([0284de5](https://github.com/vm0-ai/vm0/commit/0284de5799f4f7417f3f0e8d0774800a4568297b))
* **cli:** expose custom social summary fields ([#34058](https://github.com/vm0-ai/vm0/issues/34058)) ([d801adf](https://github.com/vm0-ai/vm0/commit/d801adfd7b353b8de32fcb1b69f2a6be4f121072))
* **pi-memory:** bound stage 1 to daily startup batches ([#34087](https://github.com/vm0-ai/vm0/issues/34087)) ([0499f3b](https://github.com/vm0-ai/vm0/commit/0499f3bf8f1cd37c1ea8b28fb38d01a2c4b6cf16))


### Bug Fixes

* **api:** order subscription admission and terminal cleanup locks ([#34103](https://github.com/vm0-ai/vm0/issues/34103)) ([a650dc3](https://github.com/vm0-ai/vm0/commit/a650dc37ae2d3db8620a7136136c67f58e24f459))
* **api:** preserve feishu and lark rich message context ([#34099](https://github.com/vm0-ai/vm0/issues/34099)) ([2ccf14f](https://github.com/vm0-ai/vm0/commit/2ccf14feb35ac1189955168595e4103cecd37088))
* **db:** preserve account erasure receipts and replay identity ([#34108](https://github.com/vm0-ai/vm0/issues/34108)) ([a020bb9](https://github.com/vm0-ai/vm0/commit/a020bb9545a8fa0531a1112ad377fbdf955d257c)), closes [#34106](https://github.com/vm0-ai/vm0/issues/34106)
* preserve nullable instagram views and support strict lookup ([#34062](https://github.com/vm0-ai/vm0/issues/34062)) ([9f3dc06](https://github.com/vm0-ai/vm0/commit/9f3dc06e3d778115e935f22370daa18f34dc05f1))


### Refactoring

* **api:** prepare explicit custom connector oauth writes ([#34092](https://github.com/vm0-ai/vm0/issues/34092)) ([9939822](https://github.com/vm0-ai/vm0/commit/9939822ce8c568a4e6e679f3bd2720b8b238b4da))
* **api:** prepare explicit hosted-site ownership writes ([#34101](https://github.com/vm0-ai/vm0/issues/34101)) ([686866a](https://github.com/vm0-ai/vm0/commit/686866ae4e77af6912426379f85ad5f153a9f5f2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.438.0
    * @okouai/core bumped to 8.663.0
    * @okouai/db bumped to 1.256.0
    * @okouai/pi-agent-runtime bumped to 1.28.2

## [1.596.0](https://github.com/vm0-ai/vm0/compare/api-v1.595.0...api-v1.596.0) (2026-09-14)


### Features

* **social:** discover saved downloads and recover active conflicts ([#34066](https://github.com/vm0-ai/vm0/issues/34066)) ([bdececa](https://github.com/vm0-ai/vm0/commit/bdececa84c38692b1f32eacbb1a0735321e734af))


### Bug Fixes

* **api:** map deleted clerk identity to a controlled auth outcome ([#34052](https://github.com/vm0-ai/vm0/issues/34052)) ([2eb4292](https://github.com/vm0-ai/vm0/commit/2eb4292efa9b6419c3d85130218730dba77c91d9))


### Refactoring

* **pi:** retire the candidate blob reference trigger ([#34006](https://github.com/vm0-ai/vm0/issues/34006)) ([a76ec9c](https://github.com/vm0-ai/vm0/commit/a76ec9c2ca98644954859aa1fea2a8ef648f1f67))
* remove slack read feature switch ([#34060](https://github.com/vm0-ai/vm0/issues/34060)) ([b2337d3](https://github.com/vm0-ai/vm0/commit/b2337d3807cf8b85ae86f0e3de2ce6520bea5b22))


### Performance Improvements

* **pi:** overlap preparation with atomic run admission ([#34016](https://github.com/vm0-ai/vm0/issues/34016)) ([202cd60](https://github.com/vm0-ai/vm0/commit/202cd607b3cbb0be86a3cb8b0613338b06fd3fe9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.437.0
    * @okouai/core bumped to 8.662.2
    * @okouai/db bumped to 1.255.6
    * @okouai/pi-agent-runtime bumped to 1.28.1

## [1.595.0](https://github.com/vm0-ai/vm0/compare/api-v1.594.0...api-v1.595.0) (2026-09-14)


### Features

* **pi-memory:** admit stage 1 extraction only for human-interactive trigger sources ([#33974](https://github.com/vm0-ai/vm0/issues/33974)) ([737e752](https://github.com/vm0-ai/vm0/commit/737e752d859154f921d599412c5754ff262078e1)), closes [#33954](https://github.com/vm0-ai/vm0/issues/33954)
* **pi-memory:** align background extraction and consolidation with upstream models and reasoning ([#33969](https://github.com/vm0-ai/vm0/issues/33969)) ([967f004](https://github.com/vm0-ai/vm0/commit/967f004c7e158e70338a54ea6afbb064e8405766))


### Refactoring

* **api:** prepare explicit organization entitlement writes ([#33912](https://github.com/vm0-ai/vm0/issues/33912)) ([5914652](https://github.com/vm0-ai/vm0/commit/5914652e56c01ea535fc64d4e12b80c7b6aaafe6)), closes [#33747](https://github.com/vm0-ai/vm0/issues/33747)
* **pi:** retire the drained legacy api wire field ([#33980](https://github.com/vm0-ai/vm0/issues/33980)) ([edbbe29](https://github.com/vm0-ai/vm0/commit/edbbe29ae11760122eb444d73883ff4e88ee5b2a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.436.0
    * @okouai/core bumped to 8.662.1
    * @okouai/db bumped to 1.255.5
    * @okouai/pi-agent-runtime bumped to 1.28.0

## [1.594.0](https://github.com/vm0-ai/vm0/compare/api-v1.593.0...api-v1.594.0) (2026-09-14)


### Features

* **pi-memory:** add the pimemory feature switch gating admission, workers and recall ([#33927](https://github.com/vm0-ai/vm0/issues/33927)) ([121fb21](https://github.com/vm0-ai/vm0/commit/121fb21295cc188a89cd0534b66c34f851a5b885))


### Bug Fixes

* **api:** batch s3 object deletion within the provider limit ([#33900](https://github.com/vm0-ai/vm0/issues/33900)) ([85a61e9](https://github.com/vm0-ai/vm0/commit/85a61e938fd855fd2ca309ae1ca57fcb950abfcf))
* **api:** bind morning brief enrollment to its installation ([#33895](https://github.com/vm0-ai/vm0/issues/33895)) ([e8de2bc](https://github.com/vm0-ai/vm0/commit/e8de2bc2686ac02b0094dc972d9217e6108daff0))


### Performance Improvements

* **api:** split type checks at declaration boundaries ([#33871](https://github.com/vm0-ai/vm0/issues/33871)) ([e8deeab](https://github.com/vm0-ai/vm0/commit/e8deeab6653c31f0ea86c1bbc4fc9b914783b7d6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.435.1
    * @okouai/core bumped to 8.662.0
    * @okouai/db bumped to 1.255.4
    * @okouai/pi-agent-runtime bumped to 1.27.6

## [1.593.0](https://github.com/vm0-ai/vm0/compare/api-v1.592.0...api-v1.593.0) (2026-09-14)


### Features

* **slack:** add paginated thread reply reads ([#33882](https://github.com/vm0-ai/vm0/issues/33882)) ([d637f53](https://github.com/vm0-ai/vm0/commit/d637f53f81c5fd78abec9b27ff4c7136a25f56cb))


### Bug Fixes

* **api:** disable pi memory background workers by default ([#33875](https://github.com/vm0-ai/vm0/issues/33875)) ([4f8b16e](https://github.com/vm0-ai/vm0/commit/4f8b16eaadc33a317c87f21c9dc093fd41b5dc54))
* **api:** remove the morning brief data-source gate ([#33858](https://github.com/vm0-ai/vm0/issues/33858)) ([042e874](https://github.com/vm0-ai/vm0/commit/042e8744647369967585cb42b5c406f98290ca5d))


### Refactoring

* **api:** retire legacy pi citation materializer bridge ([#33877](https://github.com/vm0-ai/vm0/issues/33877)) ([76ba5bf](https://github.com/vm0-ai/vm0/commit/76ba5bf16de6cc134408e1c7dc21f2c5e165cfd3)), closes [#31964](https://github.com/vm0-ai/vm0/issues/31964)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.435.0
    * @okouai/core bumped to 8.661.1
    * @okouai/db bumped to 1.255.3
    * @okouai/pi-agent-runtime bumped to 1.27.5

## [1.592.0](https://github.com/vm0-ai/vm0/compare/api-v1.591.2...api-v1.592.0) (2026-09-14)


### Features

* **model-provider:** gate supported platform openrouter us routing ([#33768](https://github.com/vm0-ai/vm0/issues/33768)) ([a19d5ea](https://github.com/vm0-ai/vm0/commit/a19d5ea87246eac8595cb3a8163feae856f4835f))


### Bug Fixes

* **api:** clarify connector catalog rejection diagnostics ([#33835](https://github.com/vm0-ai/vm0/issues/33835)) ([97451c9](https://github.com/vm0-ai/vm0/commit/97451c95143853c2612f5b194721d88320dd9b53))


### Refactoring

* remove cal.com connector feature switch ([#33841](https://github.com/vm0-ai/vm0/issues/33841)) ([fa2e6e6](https://github.com/vm0-ai/vm0/commit/fa2e6e6212dee848c8d37d72551cc5d9b7887ac4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.434.0
    * @okouai/connectors bumped to 3.11.1
    * @okouai/core bumped to 8.661.0
    * @okouai/db bumped to 1.255.2
    * @okouai/pi-agent-runtime bumped to 1.27.4

## [1.591.2](https://github.com/vm0-ai/vm0/compare/api-v1.591.1...api-v1.591.2) (2026-09-13)


### Refactoring

* **api:** prepare explicit pi candidate blob accounting ([#33774](https://github.com/vm0-ai/vm0/issues/33774)) ([cfdc9cd](https://github.com/vm0-ai/vm0/commit/cfdc9cd3c36cede429281e6f97ddf35a9ead2bef))
* **runner:** remove legacy connector-intent header tolerance ([#33767](https://github.com/vm0-ai/vm0/issues/33767)) ([fbde4b7](https://github.com/vm0-ai/vm0/commit/fbde4b7330555badff700092cfa231cf3ee70c6b))
* **voice:** remove google cloud routing switch ([#33769](https://github.com/vm0-ai/vm0/issues/33769)) ([5745bbb](https://github.com/vm0-ai/vm0/commit/5745bbb60f5dee5ef875b70ba823755cba27348f))


### Performance Improvements

* **api:** overlap pi launch preparation with storage url materialization ([#33773](https://github.com/vm0-ai/vm0/issues/33773)) ([c8e2fac](https://github.com/vm0-ai/vm0/commit/c8e2facf15f8c24100b9baed6dc81033d1830d13))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.433.1
    * @okouai/core bumped to 8.660.3
    * @okouai/db bumped to 1.255.1
    * @okouai/pi-agent-runtime bumped to 1.27.3

## [1.591.1](https://github.com/vm0-ai/vm0/compare/api-v1.591.0...api-v1.591.1) (2026-09-13)


### Bug Fixes

* **api:** store intro video render inputs in user storage ([#33757](https://github.com/vm0-ai/vm0/issues/33757)) ([2afc1eb](https://github.com/vm0-ai/vm0/commit/2afc1ebb789ca627a26f67175b5139e6944e90f8))

## [1.591.0](https://github.com/vm0-ai/vm0/compare/api-v1.590.3...api-v1.591.0) (2026-09-13)


### Features

* add managed intro video cloud rendering ([#33702](https://github.com/vm0-ai/vm0/issues/33702)) ([379e4a3](https://github.com/vm0-ai/vm0/commit/379e4a34860834c72b7f4bf6f5d0fbe324537d72))


### Performance Improvements

* **pi:** instrument preparation before the first provider request ([#33733](https://github.com/vm0-ai/vm0/issues/33733)) ([ddd898d](https://github.com/vm0-ai/vm0/commit/ddd898dd332c843cdfd6987f0ba987472d89eed3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.433.0
    * @okouai/core bumped to 8.660.2
    * @okouai/db bumped to 1.255.0
    * @okouai/pi-agent-runtime bumped to 1.27.2

## [1.590.3](https://github.com/vm0-ai/vm0/compare/api-v1.590.2...api-v1.590.3) (2026-09-13)


### Bug Fixes

* **api:** remove audit links from slack messages ([#33723](https://github.com/vm0-ai/vm0/issues/33723)) ([9499882](https://github.com/vm0-ai/vm0/commit/94998821c526e5d7c2eb8e7dbea19dd5157e99cb))


### Refactoring

* **runner:** accept both connector-intent header names ([#33707](https://github.com/vm0-ai/vm0/issues/33707)) ([33e83ae](https://github.com/vm0-ai/vm0/commit/33e83ae7126fba27731120dbde3df8fff993ec96))


### Performance Improvements

* **api:** bound stale chat event queue scans ([#33708](https://github.com/vm0-ai/vm0/issues/33708)) ([f2e6794](https://github.com/vm0-ai/vm0/commit/f2e679411c25a7e497e1cd3cd811b7864e301a40))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.432.1
    * @okouai/core bumped to 8.660.1
    * @okouai/db bumped to 1.254.4
    * @okouai/pi-agent-runtime bumped to 1.27.1

## [1.590.2](https://github.com/vm0-ai/vm0/compare/api-v1.590.1...api-v1.590.2) (2026-09-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.660.0
    * @okouai/db bumped to 1.254.3

## [1.590.1](https://github.com/vm0-ai/vm0/compare/api-v1.590.0...api-v1.590.1) (2026-09-12)


### Refactoring

* **api:** rename the oauth web origin header to x-okou-web-origin ([#33700](https://github.com/vm0-ai/vm0/issues/33700)) ([b090bcc](https://github.com/vm0-ai/vm0/commit/b090bccfdb424775ac472b24ef5d95471cba3734))
* **api:** table-drive the per-channel delivery blocks in the chat run callback ([#33689](https://github.com/vm0-ai/vm0/issues/33689)) ([4f50f4a](https://github.com/vm0-ai/vm0/commit/4f50f4af3e12856b74865842236eeb8a2adfd440)), closes [#33655](https://github.com/vm0-ai/vm0/issues/33655)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.659.0
    * @okouai/db bumped to 1.254.2

## [1.590.0](https://github.com/vm0-ai/vm0/compare/api-v1.589.0...api-v1.590.0) (2026-09-12)


### Features

* **chat:** support model-aware reasoning effort in pi ([#33683](https://github.com/vm0-ai/vm0/issues/33683)) ([ab64ece](https://github.com/vm0-ai/vm0/commit/ab64ece13b139daa0ca67e4049273e4e79ba4e76))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.432.0
    * @okouai/core bumped to 8.658.0
    * @okouai/db bumped to 1.254.1
    * @okouai/pi-agent-runtime bumped to 1.27.0

## [1.589.0](https://github.com/vm0-ai/vm0/compare/api-v1.588.0...api-v1.589.0) (2026-09-12)


### Features

* **chat:** persist model-aware reasoning effort settings ([#33551](https://github.com/vm0-ai/vm0/issues/33551)) ([1aa1036](https://github.com/vm0-ai/vm0/commit/1aa10365da1d277a04b4968a5e4218fc5c74b2a1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.431.0
    * @okouai/core bumped to 8.657.0
    * @okouai/db bumped to 1.254.0
    * @okouai/pi-agent-runtime bumped to 1.26.5

## [1.588.0](https://github.com/vm0-ai/vm0/compare/api-v1.587.0...api-v1.588.0) (2026-09-12)


### Features

* enable cal.com oauth for everyone ([#33401](https://github.com/vm0-ai/vm0/issues/33401)) ([97212da](https://github.com/vm0-ai/vm0/commit/97212daa5f952c629308bca23962636407b48737))
* **ssh:** add managed sessions within a run ([#33674](https://github.com/vm0-ai/vm0/issues/33674)) ([45c6643](https://github.com/vm0-ai/vm0/commit/45c6643695cfd76617ae72e5fb4b42a437cd9a70))


### Refactoring

* **api:** delete dead fields and repeated guards in agent-run-create ([#33673](https://github.com/vm0-ai/vm0/issues/33673)) ([e4fa2ce](https://github.com/vm0-ai/vm0/commit/e4fa2ce2a572272968644271060418cf6926a24a))
* **api:** drop log-only dimensions from the image generation failure classifiers ([#33665](https://github.com/vm0-ai/vm0/issues/33665)) ([e10e4a3](https://github.com/vm0-ai/vm0/commit/e10e4a38c902d79f0454e1028667f70ba0bc5bfb)), closes [#33649](https://github.com/vm0-ai/vm0/issues/33649)
* **api:** reduce firewall-auth refresh-failure diagnostics to one rule ([#33668](https://github.com/vm0-ai/vm0/issues/33668)) ([7056f27](https://github.com/vm0-ai/vm0/commit/7056f27d56ec92c5056702f866b900a97d975dc1))
* **api:** remove telemetry-only computation from the custom-connector runtime build ([#33672](https://github.com/vm0-ai/vm0/issues/33672)) ([3f18fc9](https://github.com/vm0-ai/vm0/commit/3f18fc980a5f5c87f4446252450d380e4f98f2ac))
* **api:** rename restricted vm0 models to restricted built-in models ([#33670](https://github.com/vm0-ai/vm0/issues/33670)) ([c07f349](https://github.com/vm0-ai/vm0/commit/c07f349dd5bf75d500939daa87569e40905b0e18))
* **api:** slim the activity-summary contract to the fields the platform reads ([#33630](https://github.com/vm0-ai/vm0/issues/33630)) ([198d38f](https://github.com/vm0-ai/vm0/commit/198d38f7a6a674672aa66c0053f40e783c424793))
* remove graduated chat experience switches ([#33612](https://github.com/vm0-ai/vm0/issues/33612)) ([8e51714](https://github.com/vm0-ai/vm0/commit/8e517146fbe73026d88d0a3f508150ae6ddf04a2))
* remove inert retired-brand vm0 residue ([#33660](https://github.com/vm0-ai/vm0/issues/33660)) ([9c83c9b](https://github.com/vm0-ai/vm0/commit/9c83c9b87ac2f910145cd9f66c350dd7006fb23c))
* **runner:** rename sandbox-internal and preview-only x-vm0 headers ([#33663](https://github.com/vm0-ai/vm0/issues/33663)) ([9375cec](https://github.com/vm0-ai/vm0/commit/9375cec4abaa342c41b17cc54275f9cb59031b64))


### Performance Improvements

* **api:** precompute pi resource discovery indexes on write ([#33641](https://github.com/vm0-ai/vm0/issues/33641)) ([8ce31e8](https://github.com/vm0-ai/vm0/commit/8ce31e8254d2be1e1b080782e0d33a05bea4d3e4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.430.1
    * @okouai/connectors bumped to 3.11.0
    * @okouai/core bumped to 8.656.0
    * @okouai/db bumped to 1.253.3
    * @okouai/pi-agent-runtime bumped to 1.26.4

## [1.587.0](https://github.com/vm0-ai/vm0/compare/api-v1.586.1...api-v1.587.0) (2026-09-12)


### Features

* add deepseek v4.1 flash ([#33591](https://github.com/vm0-ai/vm0/issues/33591)) ([b7b8854](https://github.com/vm0-ai/vm0/commit/b7b885498764b690c4a194f86da198815daae4c9))
* **voice:** enable google cloud routing by default for staff ([#33571](https://github.com/vm0-ai/vm0/issues/33571)) ([e14e650](https://github.com/vm0-ai/vm0/commit/e14e650f944b25fd7b0b0b10f486e0a33354f567))


### Bug Fixes

* reduce clerk ci traffic and restore blocking e2e checks ([#33554](https://github.com/vm0-ai/vm0/issues/33554)) ([71712e4](https://github.com/vm0-ai/vm0/commit/71712e49f2382ab3e090a37c28162e30c0759252))


### Documentation

* **testing:** forbid log assertions in api tests and gate log-noise fixes ([#33610](https://github.com/vm0-ai/vm0/issues/33610)) ([fe93e0f](https://github.com/vm0-ai/vm0/commit/fe93e0f17fe52b01a36df435e30b2641a581a9e9))


### Refactoring

* **api:** delete the unreachable callbackroute hmac module ([#33590](https://github.com/vm0-ai/vm0/issues/33590)) ([656fc51](https://github.com/vm0-ai/vm0/commit/656fc515a0a523c535917c2beed6ddf7949299fa)), closes [#33585](https://github.com/vm0-ai/vm0/issues/33585)
* **api:** drop activity snapshot capture stage and failure classification ([#33611](https://github.com/vm0-ai/vm0/issues/33611)) ([89647d0](https://github.com/vm0-ai/vm0/commit/89647d09a8899a7a56636225e685ab85876f7fa9)), closes [#33596](https://github.com/vm0-ai/vm0/issues/33596)
* **api:** remove the retired zero desktop auth callback schemes ([#33615](https://github.com/vm0-ai/vm0/issues/33615)) ([60653a2](https://github.com/vm0-ai/vm0/commit/60653a23fdb82dbe96a1aa2affcafdad8a8a1388))
* **api:** remove the unreachable welcome thread replay path ([#33603](https://github.com/vm0-ai/vm0/issues/33603)) ([14922c4](https://github.com/vm0-ai/vm0/commit/14922c43abdffef73becad176b1898f7bae92cb5))
* **api:** route activity-summary generation through the shared auxiliary boundary ([#33604](https://github.com/vm0-ai/vm0/issues/33604)) ([d3b9e82](https://github.com/vm0-ai/vm0/commit/d3b9e825b6f8ca1147aa9f868faa55654dc0e576))
* **pi:** share model runtime bootstrap and document architecture ([#33593](https://github.com/vm0-ai/vm0/issues/33593)) ([02c63e7](https://github.com/vm0-ai/vm0/commit/02c63e73072c55003ee9f8106a4cff8ff4cf4da9))
* **test:** replace retired-brand bot-name fixtures in teams and feishu suites ([#33592](https://github.com/vm0-ai/vm0/issues/33592)) ([7ef1854](https://github.com/vm0-ai/vm0/commit/7ef1854745a0e838cfe8d0d80aef247caad2dd65)), closes [#33588](https://github.com/vm0-ai/vm0/issues/33588)
* **test:** replace the last retired-brand fixtures and close the chain ([#33605](https://github.com/vm0-ai/vm0/issues/33605)) ([c000d4b](https://github.com/vm0-ai/vm0/commit/c000d4bb342318e47ae3e5ba3186192d5cf890c3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.430.0
    * @okouai/core bumped to 8.655.0
    * @okouai/db bumped to 1.253.2
    * @okouai/pi-agent-runtime bumped to 1.26.3

## [1.586.1](https://github.com/vm0-ai/vm0/compare/api-v1.586.0...api-v1.586.1) (2026-09-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.429.1
    * @okouai/core bumped to 8.654.3
    * @okouai/db bumped to 1.253.1
    * @okouai/pi-agent-runtime bumped to 1.26.2

## [1.586.0](https://github.com/vm0-ai/vm0/compare/api-v1.585.1...api-v1.586.0) (2026-09-11)


### Features

* **connectors:** support posthog cimd oauth and regional accounts ([#33490](https://github.com/vm0-ai/vm0/issues/33490)) ([37967c7](https://github.com/vm0-ai/vm0/commit/37967c79fbe0658e97adfa1c1d3c2138e2469099))
* **ssh:** manage reusable key and password credentials ([#33553](https://github.com/vm0-ai/vm0/issues/33553)) ([c51d8ca](https://github.com/vm0-ai/vm0/commit/c51d8ca3cc39eb8aa1b82f3919fcc816846890c8))


### Bug Fixes

* **voice:** classify google failures and retain safe diagnostics ([#33566](https://github.com/vm0-ai/vm0/issues/33566)) ([dcf5447](https://github.com/vm0-ai/vm0/commit/dcf54470b4b4b2346faaaed1b0d040eaeacc7793))


### Refactoring

* **api:** emit x-okou signature headers and drop the legacy names ([#33561](https://github.com/vm0-ai/vm0/issues/33561)) ([2cdbdcf](https://github.com/vm0-ai/vm0/commit/2cdbdcf65cba3504828108a675056b4963cbe3a5))
* **api:** make pi api-first transitions explicit ([#33580](https://github.com/vm0-ai/vm0/issues/33580)) ([de15084](https://github.com/vm0-ai/vm0/commit/de15084436e6936d2a7338cd75d916f11cdd81e7))
* **pi:** canonicalize the internal execution route ([#33558](https://github.com/vm0-ai/vm0/issues/33558)) ([cc1178b](https://github.com/vm0-ai/vm0/commit/cc1178b92c62a403b6052768df40d7a04ea40933)), closes [#33556](https://github.com/vm0-ai/vm0/issues/33556)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.429.0
    * @okouai/connectors bumped to 3.10.0
    * @okouai/core bumped to 8.654.2
    * @okouai/db bumped to 1.253.0
    * @okouai/pi-agent-runtime bumped to 1.26.1

## [1.585.1](https://github.com/vm0-ai/vm0/compare/api-v1.585.0...api-v1.585.1) (2026-09-11)


### Bug Fixes

* **api:** absorb rate-limited activity summaries without a diagnostic ([#33522](https://github.com/vm0-ai/vm0/issues/33522)) ([034c2c2](https://github.com/vm0-ai/vm0/commit/034c2c2bd9b8c6d13e98cac330c76850eddd63c3))
* **api:** distinguish residual activity-summary completion outcomes ([#33515](https://github.com/vm0-ai/vm0/issues/33515)) ([0bab449](https://github.com/vm0-ai/vm0/commit/0bab4493a1237205175ce2d3df2dc66f9ba8034e))
* **api:** raise morning brief provisioning outcome logs to info ([#33540](https://github.com/vm0-ai/vm0/issues/33540)) ([31791a2](https://github.com/vm0-ai/vm0/commit/31791a2f38712a764967487fd86018230820cdff))
* **api:** report built-in capacity failures as errors ([#33520](https://github.com/vm0-ai/vm0/issues/33520)) ([6fd5177](https://github.com/vm0-ai/vm0/commit/6fd51770aa4c8e1e62e713677ed6de205e04dfa0))
* **api:** report unabsorbed activity-summary provider failures as errors ([#33530](https://github.com/vm0-ai/vm0/issues/33530)) ([9d7a5a4](https://github.com/vm0-ai/vm0/commit/9d7a5a4ce4cb50a429eaaad16ea4df7d9a8d6021))
* **api:** treat empty recommended followups as an expected omission ([#33517](https://github.com/vm0-ai/vm0/issues/33517)) ([d500252](https://github.com/vm0-ai/vm0/commit/d5002522d31ebf55f1759c95fd0d0712b63e1e39))
* **pi-memory:** publish full summaries with bounded prompt injection ([#33536](https://github.com/vm0-ai/vm0/issues/33536)) ([da440bf](https://github.com/vm0-ai/vm0/commit/da440bff4d7a03293bdce027bf09d938a4a58f9a))


### Refactoring

* **api:** accept x-okou signature headers alongside the legacy names ([#33508](https://github.com/vm0-ai/vm0/issues/33508)) ([6238e7d](https://github.com/vm0-ai/vm0/commit/6238e7d1cebdb56f2d89c45e5a1f0617c9a9703e))
* **pi-memory:** make phase two a local consolidation engine ([#33547](https://github.com/vm0-ai/vm0/issues/33547)) ([5d66823](https://github.com/vm0-ai/vm0/commit/5d66823659fa01a406a694bec0f26b94cb69b3aa)), closes [#33521](https://github.com/vm0-ai/vm0/issues/33521)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.428.2
    * @okouai/core bumped to 8.654.1
    * @okouai/db bumped to 1.252.3
    * @okouai/pi-agent-runtime bumped to 1.26.0

## [1.585.0](https://github.com/vm0-ai/vm0/compare/api-v1.584.1...api-v1.585.0) (2026-09-11)


### Features

* **voice:** add gated google cloud routing ([#33462](https://github.com/vm0-ai/vm0/issues/33462)) ([4ee7737](https://github.com/vm0-ai/vm0/commit/4ee773741a7ddaed8063e8f49a76791665584f69))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.654.0
    * @okouai/db bumped to 1.252.2

## [1.584.1](https://github.com/vm0-ai/vm0/compare/api-v1.584.0...api-v1.584.1) (2026-09-11)


### Bug Fixes

* **ssh:** allow multiple login configurations per endpoint ([#33473](https://github.com/vm0-ai/vm0/issues/33473)) ([54efc25](https://github.com/vm0-ai/vm0/commit/54efc258e9b0d6df4b9c49ed7cedb92fbe4fec44))


### Refactoring

* **test:** replace residual retired-brand fixtures and a missed comment ([#33489](https://github.com/vm0-ai/vm0/issues/33489)) ([5877266](https://github.com/vm0-ai/vm0/commit/58772661b6889713ed3b090f04adc22e0e28d711)), closes [#33475](https://github.com/vm0-ai/vm0/issues/33475)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.428.1
    * @okouai/core bumped to 8.653.0
    * @okouai/db bumped to 1.252.1
    * @okouai/pi-agent-runtime bumped to 1.25.1

## [1.584.0](https://github.com/vm0-ai/vm0/compare/api-v1.583.0...api-v1.584.0) (2026-09-11)


### Features

* **api:** activate shared deepseek and native claude pi routes ([#33397](https://github.com/vm0-ai/vm0/issues/33397)) ([f942995](https://github.com/vm0-ai/vm0/commit/f942995d317de177dd344a12577bb6e151c47a01))
* **api:** verify marketing delivery consent ([#33436](https://github.com/vm0-ai/vm0/issues/33436)) ([832dbe4](https://github.com/vm0-ai/vm0/commit/832dbe4b652792461633ad4e4bd92902e7dc4165))


### Bug Fixes

* **connectors:** add Mercury compliance disclosures ([#33381](https://github.com/vm0-ai/vm0/issues/33381)) ([c13be86](https://github.com/vm0-ai/vm0/commit/c13be861672a425555d9dffdf3d29da982131bd8))
* **voice:** recover completion-body provider failures ([#33403](https://github.com/vm0-ai/vm0/issues/33403)) ([1c005dd](https://github.com/vm0-ai/vm0/commit/1c005ddbb297aec5f576d4d9063f82c61d809be8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.428.0
    * @okouai/core bumped to 8.652.1
    * @okouai/db bumped to 1.252.0
    * @okouai/pi-agent-runtime bumped to 1.25.0

## [1.583.0](https://github.com/vm0-ai/vm0/compare/api-v1.582.3...api-v1.583.0) (2026-09-11)


### Features

* **chat:** add native reasoning effort controls ([#33016](https://github.com/vm0-ai/vm0/issues/33016)) ([f649925](https://github.com/vm0-ai/vm0/commit/f649925cbb81c11ee5b66d32bcc6072fc2fe80c2))


### Bug Fixes

* **billing:** remove routine reconciliation warnings ([#33399](https://github.com/vm0-ai/vm0/issues/33399)) ([2c47c7a](https://github.com/vm0-ai/vm0/commit/2c47c7a2001543f5c92dc67edad4b4307bd66099))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.427.0
    * @okouai/core bumped to 8.652.0
    * @okouai/db bumped to 1.251.5
    * @okouai/pi-agent-runtime bumped to 1.24.15

## [1.582.3](https://github.com/vm0-ai/vm0/compare/api-v1.582.2...api-v1.582.3) (2026-09-10)


### Refactoring

* remove expired deployment compatibility ([#33343](https://github.com/vm0-ai/vm0/issues/33343)) ([f670a02](https://github.com/vm0-ai/vm0/commit/f670a0233ae13a11d43f3a2ad72ff30831cab822))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.426.1
    * @okouai/core bumped to 8.651.2
    * @okouai/db bumped to 1.251.4
    * @okouai/pi-agent-runtime bumped to 1.24.14

## [1.582.2](https://github.com/vm0-ai/vm0/compare/api-v1.582.1...api-v1.582.2) (2026-09-10)


### Refactoring

* remove final obsolete goal source references ([#33336](https://github.com/vm0-ai/vm0/issues/33336)) ([8ae8492](https://github.com/vm0-ai/vm0/commit/8ae84922a0556340df38b0be2197f55614c0c4f4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.651.1
    * @okouai/db bumped to 1.251.3

## [1.582.1](https://github.com/vm0-ai/vm0/compare/api-v1.582.0...api-v1.582.1) (2026-09-10)


### Refactoring

* retire completed goal transition validation ([#33326](https://github.com/vm0-ai/vm0/issues/33326)) ([e7d8cc5](https://github.com/vm0-ai/vm0/commit/e7d8cc5fa0af14ccf84d931e3f3357f061aa6a22))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.251.2

## [1.582.0](https://github.com/vm0-ai/vm0/compare/api-v1.581.0...api-v1.582.0) (2026-09-10)


### Features

* **ssh:** enable access by default for staff ([#33304](https://github.com/vm0-ai/vm0/issues/33304)) ([5e019e4](https://github.com/vm0-ai/vm0/commit/5e019e4f0a8ee96c89df9f636e0749c8beda9828))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.651.0
    * @okouai/db bumped to 1.251.1

## [1.581.0](https://github.com/vm0-ai/vm0/compare/api-v1.580.0...api-v1.581.0) (2026-09-10)


### Features

* add calendly oauth support ([#33204](https://github.com/vm0-ai/vm0/issues/33204)) ([0dccd68](https://github.com/vm0-ai/vm0/commit/0dccd685a1435bab424e287dd2bb5d998e40b4a2))
* **api:** add reusable image reference catalog ([#33203](https://github.com/vm0-ai/vm0/issues/33203)) ([fefeaa0](https://github.com/vm0-ai/vm0/commit/fefeaa0e895e774b3ae35161476d30588d9dcfbc))
* **chat:** add atomic runless welcome thread creation ([#33279](https://github.com/vm0-ai/vm0/issues/33279)) ([68fd2e2](https://github.com/vm0-ai/vm0/commit/68fd2e2bd3d3c99ef0f09831a4475b0ccf3abdf1)), closes [#33252](https://github.com/vm0-ai/vm0/issues/33252)
* **lint:** prohibit nested ccstate commands ([#33166](https://github.com/vm0-ai/vm0/issues/33166)) ([fcab1ad](https://github.com/vm0-ai/vm0/commit/fcab1adf39a2157c21810604e94288455628a1fb))
* **ssh:** surface host connection failures and recovery ([#33165](https://github.com/vm0-ai/vm0/issues/33165)) ([f56df60](https://github.com/vm0-ai/vm0/commit/f56df6068d35f5591020a5bb61fb4197cb6cd820))
* support gated ramp oauth authentication ([#33267](https://github.com/vm0-ai/vm0/issues/33267)) ([e80de8f](https://github.com/vm0-ai/vm0/commit/e80de8f4562dd64898901236e573767c8742d012))


### Bug Fixes

* **agent:** protect default okou identity and visibility ([#33266](https://github.com/vm0-ai/vm0/issues/33266)) ([58e76a8](https://github.com/vm0-ai/vm0/commit/58e76a815bcdaa297f8ac6086b50cd10c55316eb))
* **api:** classify initial thinking rate limits as degraded ([#33241](https://github.com/vm0-ai/vm0/issues/33241)) ([5d915b9](https://github.com/vm0-ai/vm0/commit/5d915b9750079872f3c18dbfcc6bbc809d8e0250))
* **api:** classify on-demand activity-summary deadlines as optional degradation ([#33239](https://github.com/vm0-ai/vm0/issues/33239)) ([4f7b32c](https://github.com/vm0-ai/vm0/commit/4f7b32c45845802d1a854cadd3ad4e2220fa5c95)), closes [#33081](https://github.com/vm0-ai/vm0/issues/33081)
* **api:** classify openai image provider failures ([#33117](https://github.com/vm0-ai/vm0/issues/33117)) ([c879277](https://github.com/vm0-ai/vm0/commit/c87927703b2552e038988ce8db2c187e316b791d)), closes [#33080](https://github.com/vm0-ai/vm0/issues/33080)
* **api:** describe every category while browsing one of them ([#33292](https://github.com/vm0-ai/vm0/issues/33292)) ([1bc57b1](https://github.com/vm0-ai/vm0/commit/1bc57b173e6fdfb0ee8bacda13e4a552f2ef30c8))
* **api:** keep sandbox telemetry batches alive and name oom upload failures ([#33287](https://github.com/vm0-ai/vm0/issues/33287)) ([ff65e65](https://github.com/vm0-ai/vm0/commit/ff65e65da0231a4fcad15645c041cdd57a3d7d46))
* **api:** serve desktop update feeds through transient manifest 5xx ([#33237](https://github.com/vm0-ai/vm0/issues/33237)) ([3524c84](https://github.com/vm0-ai/vm0/commit/3524c84e6978bd15757f46c7459e0dd16a6b005c))
* **artifacts:** use a.okou.io for public file sharing ([#32959](https://github.com/vm0-ai/vm0/issues/32959)) ([50663a2](https://github.com/vm0-ai/vm0/commit/50663a2f204f55d9fe296c7767fdf7c63c4b61c7))
* **chat:** honor retained chat thread event cursors ([#33299](https://github.com/vm0-ai/vm0/issues/33299)) ([66b0c79](https://github.com/vm0-ai/vm0/commit/66b0c79b2c26ab059da034c89af3bb2982f85a3b))
* **chat:** make explicit thread creation safe for duplicate client ids ([#33236](https://github.com/vm0-ai/vm0/issues/33236)) ([239a1f0](https://github.com/vm0-ai/vm0/commit/239a1f022029b50274a9ee80d29c8bc0d68ebeb5))
* extend storage url lifetime and preserve download error details ([#33181](https://github.com/vm0-ai/vm0/issues/33181)) ([93ccb22](https://github.com/vm0-ai/vm0/commit/93ccb227278b0e384594abffea5d1244219164cf))
* **pi:** surface api first-turn recovery outcomes in production ([#33243](https://github.com/vm0-ai/vm0/issues/33243)) ([549ef35](https://github.com/vm0-ai/vm0/commit/549ef35a7ead8fa945edc71923a512d3acd732ca))


### Refactoring

* **db:** contract retired goal schema after verified preservation ([#33297](https://github.com/vm0-ai/vm0/issues/33297)) ([7c8539a](https://github.com/vm0-ai/vm0/commit/7c8539a0a26a6877da42a253ac5e0832c53943f0))


### Performance Improvements

* **api:** reuse trusted clerk organization identity ([#33286](https://github.com/vm0-ai/vm0/issues/33286)) ([250aff3](https://github.com/vm0-ai/vm0/commit/250aff33dfaa031b6ead698bc7e3602dd7dc1e07))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.426.0
    * @okouai/connectors bumped to 3.9.0
    * @okouai/core bumped to 8.650.0
    * @okouai/db bumped to 1.251.0
    * @okouai/pi-agent-runtime bumped to 1.24.13

## [1.580.0](https://github.com/vm0-ai/vm0/compare/api-v1.579.3...api-v1.580.0) (2026-09-10)


### Features

* **api:** answer a named category with the whole category ([#33112](https://github.com/vm0-ai/vm0/issues/33112)) ([04d3c7e](https://github.com/vm0-ai/vm0/commit/04d3c7e5b600b195e272e80b2bcef2b66ffc7c26))
* **api:** hand the intro-video skill its entry form and name it intro video everywhere ([#33119](https://github.com/vm0-ai/vm0/issues/33119)) ([850ec24](https://github.com/vm0-ai/vm0/commit/850ec247513051216bc44da4b246fd047fcb0ceb))


### Bug Fixes

* **api:** avoid unrelated archives for current chat writes ([#33175](https://github.com/vm0-ai/vm0/issues/33175)) ([077a9a6](https://github.com/vm0-ai/vm0/commit/077a9a644986e13bed4750796f91e55c4a876aad))
* **api:** classify transient provider failures from completion envelopes ([#33115](https://github.com/vm0-ai/vm0/issues/33115)) ([04a0686](https://github.com/vm0-ai/vm0/commit/04a0686614dc4e96d9e8276a7181061c9e98fdc4))
* **api:** reconcile intro videos when heygen session lookup fails ([#32988](https://github.com/vm0-ai/vm0/issues/32988)) ([00eed51](https://github.com/vm0-ai/vm0/commit/00eed51b3f7cc78fbb10fd52172eee3385cc17d6))
* **api:** record expected chat event snapshot timeouts without warn noise ([#33114](https://github.com/vm0-ai/vm0/issues/33114)) ([c6d8cee](https://github.com/vm0-ai/vm0/commit/c6d8cee88c8a8aa1a729ea8074310c3dbafd5a2e))
* **api:** retain safe causes for failed activity snapshot writes ([#33132](https://github.com/vm0-ai/vm0/issues/33132)) ([8bf5810](https://github.com/vm0-ai/vm0/commit/8bf5810b283571936daa288f349872409a6f1a0a))
* **api:** silence expected oauth refresh failures without stopping retries ([#33110](https://github.com/vm0-ai/vm0/issues/33110)) ([5c14cdc](https://github.com/vm0-ai/vm0/commit/5c14cdc5664aebebcc6e2cf4a951e3ae5609bae3))
* **guest-agent:** classify upstream content policy rejections ([#33180](https://github.com/vm0-ai/vm0/issues/33180)) ([f61db10](https://github.com/vm0-ai/vm0/commit/f61db105d0965c93bffb84f061d1027db8d79e36))
* recognize invalid claude oauth tokens ([#33113](https://github.com/vm0-ai/vm0/issues/33113)) ([4803ac0](https://github.com/vm0-ai/vm0/commit/4803ac067beffb4501a0b15160bd39a87430adf8))


### Refactoring

* **ads:** normalize okou attribution with rollout compatibility ([#33149](https://github.com/vm0-ai/vm0/issues/33149)) ([a222108](https://github.com/vm0-ai/vm0/commit/a222108b4eccfdab77fa3f6f3c08fa6ea2bdfac7))
* remove dropbox connector feature switch ([#33130](https://github.com/vm0-ai/vm0/issues/33130)) ([bd0f81c](https://github.com/vm0-ai/vm0/commit/bd0f81c3c9baddabf67a28f01c57d6a16b1f8f63))
* retire goal backend authority and application orm consumers ([#33105](https://github.com/vm0-ai/vm0/issues/33105)) ([2c23176](https://github.com/vm0-ai/vm0/commit/2c231766e383b651867893852cfb47dcc78af0bd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.425.0
    * @okouai/core bumped to 8.649.0
    * @okouai/db bumped to 1.250.5
    * @okouai/pi-agent-runtime bumped to 1.24.12

## [1.579.3](https://github.com/vm0-ai/vm0/compare/api-v1.579.2...api-v1.579.3) (2026-09-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.424.2
    * @okouai/connectors bumped to 3.8.9
    * @okouai/core bumped to 8.648.3
    * @okouai/db bumped to 1.250.4
    * @okouai/pi-agent-runtime bumped to 1.24.11

## [1.579.2](https://github.com/vm0-ai/vm0/compare/api-v1.579.1...api-v1.579.2) (2026-09-09)


### Refactoring

* remove expired deployment compatibility ([#33051](https://github.com/vm0-ai/vm0/issues/33051)) ([237549e](https://github.com/vm0-ai/vm0/commit/237549ecd842ab228f7e689af1f547757bed72dd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.424.1
    * @okouai/core bumped to 8.648.2
    * @okouai/db bumped to 1.250.3
    * @okouai/pi-agent-runtime bumped to 1.24.10

## [1.579.1](https://github.com/vm0-ai/vm0/compare/api-v1.579.0...api-v1.579.1) (2026-09-09)


### Bug Fixes

* remove obsolete brand tombstones ([#33049](https://github.com/vm0-ai/vm0/issues/33049)) ([0b757ba](https://github.com/vm0-ai/vm0/commit/0b757ba3de7fc497cbc8c9a02ad461a30314dc01))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.648.1
    * @okouai/db bumped to 1.250.2

## [1.579.0](https://github.com/vm0-ai/vm0/compare/api-v1.578.0...api-v1.579.0) (2026-09-09)


### Features

* **chat:** poll thinking summaries from thread subscriptions ([#33040](https://github.com/vm0-ai/vm0/issues/33040)) ([53d3529](https://github.com/vm0-ai/vm0/commit/53d3529abdb3adf52a464018fb1127f9149c391c))


### Bug Fixes

* **api:** record browser screenshot outcome metrics without warnings ([#33041](https://github.com/vm0-ai/vm0/issues/33041)) ([cd49667](https://github.com/vm0-ai/vm0/commit/cd496676846ef48e60a35426f48bc1404405a95e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.424.0
    * @okouai/core bumped to 8.648.0
    * @okouai/db bumped to 1.250.1
    * @okouai/pi-agent-runtime bumped to 1.24.9

## [1.578.0](https://github.com/vm0-ai/vm0/compare/api-v1.577.2...api-v1.578.0) (2026-09-09)


### Features

* **guest-agent:** prepare native chat effort consumers ([#32999](https://github.com/vm0-ai/vm0/issues/32999)) ([4a1e9e1](https://github.com/vm0-ai/vm0/commit/4a1e9e1a7c67de3d47ef0de86601f26819003d71))
* **ssh:** add owner controls and agent ssh commands ([#32722](https://github.com/vm0-ai/vm0/issues/32722)) ([0c27252](https://github.com/vm0-ai/vm0/commit/0c27252592810ab55baa97169773056a7453ab30))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.423.0
    * @okouai/core bumped to 8.647.0
    * @okouai/db bumped to 1.250.0
    * @okouai/pi-agent-runtime bumped to 1.24.8

## [1.577.2](https://github.com/vm0-ai/vm0/compare/api-v1.577.1...api-v1.577.2) (2026-09-09)


### Bug Fixes

* **artifacts:** register legacy writes before publishing files ([#32990](https://github.com/vm0-ai/vm0/issues/32990)) ([7cd7576](https://github.com/vm0-ai/vm0/commit/7cd757646de81fdda65546b4abd54ea8a35ae782))
* **artifacts:** renew private previews on demand ([#32977](https://github.com/vm0-ai/vm0/issues/32977)) ([bc0a009](https://github.com/vm0-ai/vm0/commit/bc0a009965fb966f60b78902003984751fb76f6a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.422.2
    * @okouai/core bumped to 8.646.1
    * @okouai/db bumped to 1.249.2
    * @okouai/pi-agent-runtime bumped to 1.24.7

## [1.577.1](https://github.com/vm0-ai/vm0/compare/api-v1.577.0...api-v1.577.1) (2026-09-09)


### Bug Fixes

* **api:** keep auxiliary generations from starving on a shared token budget ([#32979](https://github.com/vm0-ai/vm0/issues/32979)) ([44ff946](https://github.com/vm0-ai/vm0/commit/44ff946309d9cf9c35c22f4c4c41af314b29ff0d))
* **api:** retain activity diagnostics in production ([#32996](https://github.com/vm0-ai/vm0/issues/32996)) ([9221064](https://github.com/vm0-ai/vm0/commit/92210646cd7ac23e97607ca8920df8ddfcdbd024))
* **api:** skip intro video session polling after video id assignment ([#32989](https://github.com/vm0-ai/vm0/issues/32989)) ([aba3bd9](https://github.com/vm0-ai/vm0/commit/aba3bd9692db398472b6033432d802f94d0579cc))


### Refactoring

* **db:** stop reading and writing computer use host client product ([#32987](https://github.com/vm0-ai/vm0/issues/32987)) ([c501560](https://github.com/vm0-ai/vm0/commit/c5015603f16a7e601dc156f8bd6a24f1e261a846)), closes [#32966](https://github.com/vm0-ai/vm0/issues/32966)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.422.1
    * @okouai/connectors bumped to 3.8.8
    * @okouai/core bumped to 8.646.0
    * @okouai/db bumped to 1.249.1
    * @okouai/pi-agent-runtime bumped to 1.24.6

## [1.577.0](https://github.com/vm0-ai/vm0/compare/api-v1.576.0...api-v1.577.0) (2026-09-09)


### Features

* **api:** rank connector discovery and give every category a slice ([#32927](https://github.com/vm0-ai/vm0/issues/32927)) ([571b67f](https://github.com/vm0-ai/vm0/commit/571b67ff4bc5848abed2aa91061e33b0f517ae0a))
* **chat:** persist model-aware reasoning effort selections ([#32926](https://github.com/vm0-ai/vm0/issues/32926)) ([5802f5b](https://github.com/vm0-ai/vm0/commit/5802f5ba59d8d47865139dccd1f49acdf50a2a02))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.422.0
    * @okouai/core bumped to 8.645.0
    * @okouai/db bumped to 1.249.0
    * @okouai/pi-agent-runtime bumped to 1.24.5

## [1.576.0](https://github.com/vm0-ai/vm0/compare/api-v1.575.3...api-v1.576.0) (2026-09-09)


### Features

* add email subscription management to morning brief preferences ([#32933](https://github.com/vm0-ai/vm0/issues/32933)) ([e114cb8](https://github.com/vm0-ai/vm0/commit/e114cb8c9be99fbaf0513bece90d02736ce43b2e))


### Bug Fixes

* **pi:** hand off failed api model turns to sandbox ([#32948](https://github.com/vm0-ai/vm0/issues/32948)) ([26c896f](https://github.com/vm0-ai/vm0/commit/26c896fe39acf3b62837819d34dd38a4a77a9084))


### Refactoring

* **api:** retire the legacy zero teams command prefix ([#32947](https://github.com/vm0-ai/vm0/issues/32947)) ([b1692d8](https://github.com/vm0-ai/vm0/commit/b1692d895c8032853f7834ce5828c9350cfd0656)), closes [#32941](https://github.com/vm0-ai/vm0/issues/32941)
* **connectors:** require browser oauth attempt ids ([#32960](https://github.com/vm0-ai/vm0/issues/32960)) ([6e74f9a](https://github.com/vm0-ai/vm0/commit/6e74f9aca7e9e180c95cb5321b46cb641af6896e))
* **naming:** correct residual retired-brand copy and internal names ([#32946](https://github.com/vm0-ai/vm0/issues/32946)) ([c5e6ef9](https://github.com/vm0-ai/vm0/commit/c5e6ef9e41593c017fd2fd57222a40d123270db5)), closes [#32939](https://github.com/vm0-ai/vm0/issues/32939)


### Performance Improvements

* **api:** scope catalog reads for thread connector selections ([#32956](https://github.com/vm0-ai/vm0/issues/32956)) ([a8e237e](https://github.com/vm0-ai/vm0/commit/a8e237ede91c9d8c9543603121ed09178be1876f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.421.0
    * @okouai/core bumped to 8.644.0
    * @okouai/db bumped to 1.248.5
    * @okouai/pi-agent-runtime bumped to 1.24.4

## [1.575.3](https://github.com/vm0-ai/vm0/compare/api-v1.575.2...api-v1.575.3) (2026-09-09)


### Bug Fixes

* **ads:** route browser conversions by verified account ownership ([#32902](https://github.com/vm0-ai/vm0/issues/32902)) ([bb561b8](https://github.com/vm0-ai/vm0/commit/bb561b8ee07aa5c8ae4bcddfadc633e9900ad550))
* **voice:** recover transient provider capacity failures ([#32918](https://github.com/vm0-ai/vm0/issues/32918)) ([6600861](https://github.com/vm0-ai/vm0/commit/660086182f9ecf4a7f67eb8cf43166af2071dbf6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.420.3
    * @okouai/connectors bumped to 3.8.7
    * @okouai/core bumped to 8.643.0
    * @okouai/db bumped to 1.248.4
    * @okouai/pi-agent-runtime bumped to 1.24.3

## [1.575.2](https://github.com/vm0-ai/vm0/compare/api-v1.575.1...api-v1.575.2) (2026-09-09)


### Bug Fixes

* **api:** classify fal downstream service errors ([#32890](https://github.com/vm0-ai/vm0/issues/32890)) ([7a72b4e](https://github.com/vm0-ai/vm0/commit/7a72b4ea2a67fdf1826505f44231829b2e92af51))
* **connectors:** verify browser oauth completion by attempt ([#32880](https://github.com/vm0-ai/vm0/issues/32880)) ([b328433](https://github.com/vm0-ai/vm0/commit/b328433c0c4c17f3bd7e0a4dee9f349e9d6d6b1a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.420.2
    * @okouai/core bumped to 8.642.1
    * @okouai/db bumped to 1.248.3
    * @okouai/pi-agent-runtime bumped to 1.24.2

## [1.575.1](https://github.com/vm0-ai/vm0/compare/api-v1.575.0...api-v1.575.1) (2026-09-09)


### Bug Fixes

* **api:** quietly degrade codex expiry 503 responses ([#32876](https://github.com/vm0-ai/vm0/issues/32876)) ([4fb5bb9](https://github.com/vm0-ai/vm0/commit/4fb5bb99875c68b7ecf7314d653bce522c07cd93))
* **api:** validate dataforseo labs locations ([#32785](https://github.com/vm0-ai/vm0/issues/32785)) ([f2c8fff](https://github.com/vm0-ai/vm0/commit/f2c8fff24537303713047f2abe9a690d913046b0))
* preserve composer context as hidden additional info ([#32782](https://github.com/vm0-ai/vm0/issues/32782)) ([ff22c3b](https://github.com/vm0-ai/vm0/commit/ff22c3bedc2784c46bc6f9bcc3a3731a6f5b404f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.420.1
    * @okouai/core bumped to 8.642.0
    * @okouai/db bumped to 1.248.2
    * @okouai/pi-agent-runtime bumped to 1.24.1

## [1.575.0](https://github.com/vm0-ai/vm0/compare/api-v1.574.0...api-v1.575.0) (2026-09-09)


### Features

* **pi:** prepare native claude consumers and accounting ([#32835](https://github.com/vm0-ai/vm0/issues/32835)) ([31133fc](https://github.com/vm0-ai/vm0/commit/31133fc7ba5eeecbc1c8a0cda32f16f1ff2b4602))


### Bug Fixes

* **guest:** preserve bounded oom evidence before cleanup ([#32845](https://github.com/vm0-ai/vm0/issues/32845)) ([075ccba](https://github.com/vm0-ai/vm0/commit/075ccbaaf8f90231687267218ef1e77d05771d3a))
* preserve google ads first-touch attribution ([#32833](https://github.com/vm0-ai/vm0/issues/32833)) ([94b41ea](https://github.com/vm0-ai/vm0/commit/94b41ea4bdf9990eaebf7cc6cd9cceb54e92e9b5))
* preserve literal goal archives across historical readers ([#32852](https://github.com/vm0-ai/vm0/issues/32852)) ([cede9cb](https://github.com/vm0-ai/vm0/commit/cede9cbfb62872ddabb705de852dc6fd81a3cc6d))


### Refactoring

* **pi-memory:** stop maintenance journal production and forwarding ([#32805](https://github.com/vm0-ai/vm0/issues/32805)) ([46576db](https://github.com/vm0-ai/vm0/commit/46576dbbca793e345e9b20e56618b998c3a8b629))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.420.0
    * @okouai/core bumped to 8.641.1
    * @okouai/db bumped to 1.248.1
    * @okouai/pi-agent-runtime bumped to 1.24.0

## [1.574.0](https://github.com/vm0-ai/vm0/compare/api-v1.573.1...api-v1.574.0) (2026-09-09)


### Features

* **artifacts:** add explicit organization and public sharing ([#32721](https://github.com/vm0-ai/vm0/issues/32721)) ([0b1a54a](https://github.com/vm0-ai/vm0/commit/0b1a54a43889c361c4a47669923ca5c5c4d909bf))
* **db:** archive and settle retired okou goals ([#32813](https://github.com/vm0-ai/vm0/issues/32813)) ([3e1544d](https://github.com/vm0-ai/vm0/commit/3e1544d55ac0dc54a1cdb21d6aee72d651a6808d))


### Bug Fixes

* **api:** silence expected terminal codex reconnect failures ([#32808](https://github.com/vm0-ai/vm0/issues/32808)) ([67a7f6b](https://github.com/vm0-ai/vm0/commit/67a7f6b4c380f1715f7a0319fdf7f2be2064d41b))
* **api:** stop retrying expired aws sign-in refresh tokens ([#32806](https://github.com/vm0-ai/vm0/issues/32806)) ([7678fec](https://github.com/vm0-ai/vm0/commit/7678fec836b77198e5e9eda5ebe1995a1c6a1a70))
* **naming:** refresh remaining desktop and developer copy ([#32823](https://github.com/vm0-ai/vm0/issues/32823)) ([2271fe9](https://github.com/vm0-ai/vm0/commit/2271fe947f4df8e4925fe5a3d1d6889a13c6b953))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.419.0
    * @okouai/connectors bumped to 3.8.6
    * @okouai/core bumped to 8.641.0
    * @okouai/db bumped to 1.248.0
    * @okouai/pi-agent-runtime bumped to 1.23.8

## [1.573.1](https://github.com/vm0-ai/vm0/compare/api-v1.573.0...api-v1.573.1) (2026-09-09)


### Bug Fixes

* **api:** cap chat search at 25 and bound sparse keyword scans ([#32767](https://github.com/vm0-ai/vm0/issues/32767)) ([0e7fdb7](https://github.com/vm0-ai/vm0/commit/0e7fdb77c421152675528b82feeb698fd95b29d6))


### Refactoring

* finish brand retirement cleanup ([#32728](https://github.com/vm0-ai/vm0/issues/32728)) ([6254182](https://github.com/vm0-ai/vm0/commit/62541820a08410060d6cfde83887e17fa7a86429))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.418.2
    * @okouai/core bumped to 8.640.1
    * @okouai/db bumped to 1.247.4
    * @okouai/pi-agent-runtime bumped to 1.23.7

## [1.573.0](https://github.com/vm0-ai/vm0/compare/api-v1.572.2...api-v1.573.0) (2026-09-09)


### Features

* **api:** summarize connected slack activity in morning brief ([#32769](https://github.com/vm0-ai/vm0/issues/32769)) ([77a34fd](https://github.com/vm0-ai/vm0/commit/77a34fd2059b9834b9553e72950fbe5a75f0c3f4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.640.0
    * @okouai/db bumped to 1.247.3

## [1.572.2](https://github.com/vm0-ai/vm0/compare/api-v1.572.1...api-v1.572.2) (2026-09-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.639.0
    * @okouai/db bumped to 1.247.2

## [1.572.1](https://github.com/vm0-ai/vm0/compare/api-v1.572.0...api-v1.572.1) (2026-09-09)


### Bug Fixes

* **connectors:** send pkce and refresh scope on mercury oauth ([#32731](https://github.com/vm0-ai/vm0/issues/32731)) ([5723482](https://github.com/vm0-ai/vm0/commit/5723482876ea5340120b23a1e6c2df8749b6a0d5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.418.1
    * @okouai/connectors bumped to 3.8.5
    * @okouai/core bumped to 8.638.1
    * @okouai/db bumped to 1.247.1
    * @okouai/pi-agent-runtime bumped to 1.23.6

## [1.572.0](https://github.com/vm0-ai/vm0/compare/api-v1.571.2...api-v1.572.0) (2026-09-08)


### Features

* **artifacts:** add private html hosting and isolated previews ([#32716](https://github.com/vm0-ai/vm0/issues/32716)) ([168c385](https://github.com/vm0-ai/vm0/commit/168c385c6bf192250fb42f46abff72e53e0e8aed))
* **artifacts:** keep managed generation private behind shared rollout switch ([#32687](https://github.com/vm0-ai/vm0/issues/32687)) ([71f6608](https://github.com/vm0-ai/vm0/commit/71f66085b5c5d01fafb47e7ab3379fac0ccfd113))


### Bug Fixes

* finish okou brand cleanup ([#32684](https://github.com/vm0-ai/vm0/issues/32684)) ([7d239a4](https://github.com/vm0-ai/vm0/commit/7d239a41a5dd6dd41ed7c22cd9e5dae566fc1925))
* **runner:** attribute guest dns readiness attempts ([#32697](https://github.com/vm0-ai/vm0/issues/32697)) ([7558632](https://github.com/vm0-ai/vm0/commit/7558632c0eea9bded6c831fdba33a76c369677aa)), closes [#32445](https://github.com/vm0-ai/vm0/issues/32445)


### Refactoring

* remove expired deployment compatibility ([#32723](https://github.com/vm0-ai/vm0/issues/32723)) ([e8f389c](https://github.com/vm0-ai/vm0/commit/e8f389c25626a4e7ad5b15d71435dcc492859e76))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.418.0
    * @okouai/core bumped to 8.638.0
    * @okouai/db bumped to 1.247.0
    * @okouai/pi-agent-runtime bumped to 1.23.5

## [1.571.2](https://github.com/vm0-ai/vm0/compare/api-v1.571.1...api-v1.571.2) (2026-09-08)


### Bug Fixes

* **api:** restrict slack reads to shared conversations ([#32692](https://github.com/vm0-ai/vm0/issues/32692)) ([0e57607](https://github.com/vm0-ai/vm0/commit/0e57607c9d8c0ca163c9a4df015479c5f6014879))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.417.1
    * @okouai/core bumped to 8.637.2
    * @okouai/db bumped to 1.246.3
    * @okouai/pi-agent-runtime bumped to 1.23.4

## [1.571.1](https://github.com/vm0-ai/vm0/compare/api-v1.571.0...api-v1.571.1) (2026-09-08)


### Bug Fixes

* **api:** retire okou goal runtime execution ([#32677](https://github.com/vm0-ai/vm0/issues/32677)) ([6d39111](https://github.com/vm0-ai/vm0/commit/6d391117e4fead19e2105136fb2792a6e77801d8))


### Refactoring

* remove presentation templates feature switch ([#32664](https://github.com/vm0-ai/vm0/issues/32664)) ([136add4](https://github.com/vm0-ai/vm0/commit/136add49f199cc0df10e826ed15885fb4767dc87))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.637.1
    * @okouai/db bumped to 1.246.2

## [1.571.0](https://github.com/vm0-ai/vm0/compare/api-v1.570.0...api-v1.571.0) (2026-09-08)


### Features

* **app:** add creative and explainer video template categories ([#32613](https://github.com/vm0-ai/vm0/issues/32613)) ([9546d35](https://github.com/vm0-ai/vm0/commit/9546d35d6075efa635925c5ce37f54b3ef351032))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.417.0
    * @okouai/core bumped to 8.637.0
    * @okouai/db bumped to 1.246.1
    * @okouai/pi-agent-runtime bumped to 1.23.3

## [1.570.0](https://github.com/vm0-ai/vm0/compare/api-v1.569.1...api-v1.570.0) (2026-09-08)


### Features

* add usage pack visibility for pro and team plans ([#32595](https://github.com/vm0-ai/vm0/issues/32595)) ([65ac051](https://github.com/vm0-ai/vm0/commit/65ac0518bde2310887470cb0874aeae06c0c0397))
* **api:** extend pi execution and learning to automation and goals ([#32634](https://github.com/vm0-ai/vm0/issues/32634)) ([a304678](https://github.com/vm0-ai/vm0/commit/a304678ae3a93d9eb74bd465ad1d7bdc1bc170d3))


### Bug Fixes

* **api:** classify auxiliary generation outcomes ([#32636](https://github.com/vm0-ai/vm0/issues/32636)) ([f02a3b4](https://github.com/vm0-ai/vm0/commit/f02a3b43d5fa5d2adb7809c9852af5a85b96476e))
* **api:** prevent duplicate pi phase two charges ([#32639](https://github.com/vm0-ai/vm0/issues/32639)) ([c84981d](https://github.com/vm0-ai/vm0/commit/c84981db7355cc4f4ded6aff39891d9daed66747))
* **models:** classify provider cooldown report logs ([#32644](https://github.com/vm0-ai/vm0/issues/32644)) ([5d7012b](https://github.com/vm0-ai/vm0/commit/5d7012b020830583e4ba277e4b09054a2db7e586))
* **voice:** reject implausible transcription output ([#32638](https://github.com/vm0-ai/vm0/issues/32638)) ([95b6675](https://github.com/vm0-ai/vm0/commit/95b66759937670fd17077345c9e2a8fbf0f28383))


### Refactoring

* **pi:** stop legacy api writes while preserving wire readers ([#32632](https://github.com/vm0-ai/vm0/issues/32632)) ([c08d055](https://github.com/vm0-ai/vm0/commit/c08d0550f18aced7654548ac54f43d1c49f5355b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.416.0
    * @okouai/core bumped to 8.636.0
    * @okouai/db bumped to 1.246.0
    * @okouai/pi-agent-runtime bumped to 1.23.2

## [1.569.1](https://github.com/vm0-ai/vm0/compare/api-v1.569.0...api-v1.569.1) (2026-09-08)


### Refactoring

* **naming:** neutralize private constants and refresh developer branding ([#32619](https://github.com/vm0-ai/vm0/issues/32619)) ([9eb06e3](https://github.com/vm0-ai/vm0/commit/9eb06e348ade35a05771dff4209e0cb75ac6d6b8)), closes [#32601](https://github.com/vm0-ai/vm0/issues/32601)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.415.2
    * @okouai/connectors bumped to 3.8.4
    * @okouai/core bumped to 8.635.2
    * @okouai/db bumped to 1.245.18
    * @okouai/pi-agent-runtime bumped to 1.23.1

## [1.569.0](https://github.com/vm0-ai/vm0/compare/api-v1.568.0...api-v1.569.0) (2026-09-08)


### Features

* **pi:** support custom responses fast for terra sol and luna ([#32593](https://github.com/vm0-ai/vm0/issues/32593)) ([a030906](https://github.com/vm0-ai/vm0/commit/a030906361418347b6673a2af718270632a9e4d6))


### Refactoring

* serve only the okou.ai domain across platform, api, cli and desktop ([#32484](https://github.com/vm0-ai/vm0/issues/32484)) ([af545b4](https://github.com/vm0-ai/vm0/commit/af545b4bc4a892f60efc89c11aa3f54a73adc004))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.415.1
    * @okouai/connectors bumped to 3.8.3
    * @okouai/core bumped to 8.635.1
    * @okouai/db bumped to 1.245.17
    * @okouai/pi-agent-runtime bumped to 1.23.0

## [1.568.0](https://github.com/vm0-ai/vm0/compare/api-v1.567.1...api-v1.568.0) (2026-09-08)


### Features

* add slack bot channel discovery and history reads ([#32527](https://github.com/vm0-ai/vm0/issues/32527)) ([9873338](https://github.com/vm0-ai/vm0/commit/9873338effbfa71fa10e7fbf4c8a3508a9de1ba3))


### Bug Fixes

* **api:** retry transient backlinks summary failures ([#32519](https://github.com/vm0-ai/vm0/issues/32519)) ([4a276aa](https://github.com/vm0-ai/vm0/commit/4a276aaa5d6dddc6f42a282f414203b642056b15))


### Refactoring

* remove googleFormsWorkflowAutomations feature switch ([#32523](https://github.com/vm0-ai/vm0/issues/32523)) ([9f498b5](https://github.com/vm0-ai/vm0/commit/9f498b557f70cf3545a784cf53108f73302c24ec))
* remove notion workflow automation feature switch ([#32524](https://github.com/vm0-ai/vm0/issues/32524)) ([14a02ec](https://github.com/vm0-ai/vm0/commit/14a02ec10b944dc744b143c678ce2a60787e6284))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.415.0
    * @okouai/core bumped to 8.635.0
    * @okouai/db bumped to 1.245.16
    * @okouai/pi-agent-runtime bumped to 1.22.1

## [1.567.1](https://github.com/vm0-ai/vm0/compare/api-v1.567.0...api-v1.567.1) (2026-09-08)


### Refactoring

* remove followUpOptimize feature switch ([#32522](https://github.com/vm0-ai/vm0/issues/32522)) ([cd4d62b](https://github.com/vm0-ai/vm0/commit/cd4d62b5e072e6c9e32c9431338fb37ee4eeedef))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.634.6
    * @okouai/db bumped to 1.245.15

## [1.567.0](https://github.com/vm0-ai/vm0/compare/api-v1.566.4...api-v1.567.0) (2026-09-08)


### Features

* **pi:** route sol and luna with correct first-turn billing ([#32518](https://github.com/vm0-ai/vm0/issues/32518)) ([1ca1499](https://github.com/vm0-ai/vm0/commit/1ca1499be6c86b0a3faeb0d5e4bbf4f55c01e787))


### Bug Fixes

* include video options in agent prompts ([#32409](https://github.com/vm0-ai/vm0/issues/32409)) ([569314c](https://github.com/vm0-ai/vm0/commit/569314c1dba5f7a0aaa01cf9f42b3bc0f4cdc1ab))
* **pi:** hand slash input to native sandbox execution ([#32509](https://github.com/vm0-ai/vm0/issues/32509)) ([0a07340](https://github.com/vm0-ai/vm0/commit/0a073409de8a9fdd5ced97fc52cfae3e1129d430)), closes [#32453](https://github.com/vm0-ai/vm0/issues/32453)


### Refactoring

* **api:** prepare official workflow queue readers for canonical contexts ([#32533](https://github.com/vm0-ai/vm0/issues/32533)) ([81f3a47](https://github.com/vm0-ai/vm0/commit/81f3a47ffb1a59f7f3e38900c0ea94f1190fd2f2))
* **chat:** remove video model rollout fallbacks ([#32363](https://github.com/vm0-ai/vm0/issues/32363)) ([d23807b](https://github.com/vm0-ai/vm0/commit/d23807b1b0913312306777c23a7342c67b050487))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.414.3
    * @okouai/core bumped to 8.634.5
    * @okouai/db bumped to 1.245.14
    * @okouai/pi-agent-runtime bumped to 1.22.0

## [1.566.4](https://github.com/vm0-ai/vm0/compare/api-v1.566.3...api-v1.566.4) (2026-09-08)


### Bug Fixes

* **api:** handle DataForSEO SERP no-search-results responses ([#32499](https://github.com/vm0-ai/vm0/issues/32499)) ([2e64976](https://github.com/vm0-ai/vm0/commit/2e64976033a5e939248ff14af401f2ac715591e0))
* **connectors:** route quickbooks and stripe oauth callbacks to okou ([#32498](https://github.com/vm0-ai/vm0/issues/32498)) ([6a33845](https://github.com/vm0-ai/vm0/commit/6a338453a20c7bd268b0cae75093c9ee6d7e0ef0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.414.2
    * @okouai/connectors bumped to 3.8.2
    * @okouai/core bumped to 8.634.4
    * @okouai/db bumped to 1.245.13
    * @okouai/pi-agent-runtime bumped to 1.21.22

## [1.566.3](https://github.com/vm0-ai/vm0/compare/api-v1.566.2...api-v1.566.3) (2026-09-08)


### Bug Fixes

* **billing:** handle already-paid auto-recharge invoices ([#32489](https://github.com/vm0-ai/vm0/issues/32489)) ([b5f4b95](https://github.com/vm0-ai/vm0/commit/b5f4b95777cb0561f692ba1228ee2699804f0932))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.634.3
    * @okouai/db bumped to 1.245.12

## [1.566.2](https://github.com/vm0-ai/vm0/compare/api-v1.566.1...api-v1.566.2) (2026-09-08)


### Bug Fixes

* **api:** localize official workflow thread titles ([#32431](https://github.com/vm0-ai/vm0/issues/32431)) ([7912cb7](https://github.com/vm0-ai/vm0/commit/7912cb7484d2bda2994abbbbb2bf12c64b212822))
* **calendar:** support safe target reconfiguration ([#32441](https://github.com/vm0-ai/vm0/issues/32441)) ([f6f48c8](https://github.com/vm0-ai/vm0/commit/f6f48c8dff8c9a4a33e4312f77da9f8e1a36dc79))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.414.1
    * @okouai/core bumped to 8.634.2
    * @okouai/db bumped to 1.245.11
    * @okouai/pi-agent-runtime bumped to 1.21.21

## [1.566.1](https://github.com/vm0-ai/vm0/compare/api-v1.566.0...api-v1.566.1) (2026-09-08)


### Refactoring

* remove expired deployment compatibility ([#32419](https://github.com/vm0-ai/vm0/issues/32419)) ([2ccbbaf](https://github.com/vm0-ai/vm0/commit/2ccbbaf5e1baef45c40a1fedfff4259d151a7ff8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.634.1
    * @okouai/db bumped to 1.245.10

## [1.566.0](https://github.com/vm0-ai/vm0/compare/api-v1.565.0...api-v1.566.0) (2026-09-07)


### Features

* **api:** add runner ssh jit authority and atomic host-key pinning ([#32394](https://github.com/vm0-ai/vm0/issues/32394)) ([ca08d94](https://github.com/vm0-ai/vm0/commit/ca08d9466fc4de5581cd49b929767dfbca266ff2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.414.0
    * @okouai/core bumped to 8.634.0
    * @okouai/db bumped to 1.245.9
    * @okouai/pi-agent-runtime bumped to 1.21.20

## [1.565.0](https://github.com/vm0-ai/vm0/compare/api-v1.564.1...api-v1.565.0) (2026-09-07)


### Features

* **app:** stream authenticated api prefetch responses ([#32364](https://github.com/vm0-ai/vm0/issues/32364)) ([88eda06](https://github.com/vm0-ai/vm0/commit/88eda06641dcf5b239f6274540f55ecc53d468ee))
* **pi-memory:** learn from canonical connector chat threads ([#32390](https://github.com/vm0-ai/vm0/issues/32390)) ([fcbba63](https://github.com/vm0-ai/vm0/commit/fcbba6347c4b1c9d3daaf3772308e0489073065c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.413.0
    * @okouai/core bumped to 8.633.1
    * @okouai/db bumped to 1.245.8
    * @okouai/pi-agent-runtime bumped to 1.21.19

## [1.564.1](https://github.com/vm0-ai/vm0/compare/api-v1.564.0...api-v1.564.1) (2026-09-07)


### Refactoring

* **image-recognition:** remove legacy recognize compatibility ([#32381](https://github.com/vm0-ai/vm0/issues/32381)) ([82bfb2c](https://github.com/vm0-ai/vm0/commit/82bfb2c81b7c49442b4a9ed3f654a8b7de2f28be)), closes [#32371](https://github.com/vm0-ai/vm0/issues/32371)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.412.4
    * @okouai/core bumped to 8.633.0
    * @okouai/db bumped to 1.245.7
    * @okouai/pi-agent-runtime bumped to 1.21.18

## [1.564.0](https://github.com/vm0-ai/vm0/compare/api-v1.563.3...api-v1.564.0) (2026-09-07)


### Features

* **desktop:** add generation-owned cua command adapter ([#32360](https://github.com/vm0-ai/vm0/issues/32360)) ([b88375f](https://github.com/vm0-ai/vm0/commit/b88375f6c75f001e76dee446ada97ac1ad681e8b))


### Bug Fixes

* **pi-memory:** protect active maintenance from cleanup ([#32367](https://github.com/vm0-ai/vm0/issues/32367)) ([7e46f0c](https://github.com/vm0-ai/vm0/commit/7e46f0c9f2205853fe77ba7db67ea7acab2d9ab9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.632.0
    * @okouai/db bumped to 1.245.6

## [1.563.3](https://github.com/vm0-ai/vm0/compare/api-v1.563.2...api-v1.563.3) (2026-09-07)


### Bug Fixes

* **calendar:** persist watch action-required state ([#32332](https://github.com/vm0-ai/vm0/issues/32332)) ([59b0106](https://github.com/vm0-ai/vm0/commit/59b0106dbcc0510a944f8cf68fd54f4871719a56))
* **pi:** recover api first-turn deadlines in sandbox ([#32329](https://github.com/vm0-ai/vm0/issues/32329)) ([b701bf8](https://github.com/vm0-ai/vm0/commit/b701bf888ce2c4ad62e9cbf2dabbb763dbca8a4e))


### Refactoring

* remove presentationScreenshot feature switch ([#32349](https://github.com/vm0-ai/vm0/issues/32349)) ([ef1d8b4](https://github.com/vm0-ai/vm0/commit/ef1d8b4619552158928230379383b8ce3e00f0d6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.412.3
    * @okouai/core bumped to 8.631.5
    * @okouai/db bumped to 1.245.5
    * @okouai/pi-agent-runtime bumped to 1.21.17

## [1.563.2](https://github.com/vm0-ai/vm0/compare/api-v1.563.1...api-v1.563.2) (2026-09-07)


### Bug Fixes

* **api:** preserve mention context across chat integrations ([#32335](https://github.com/vm0-ai/vm0/issues/32335)) ([6158eb5](https://github.com/vm0-ai/vm0/commit/6158eb586bd781310547cc76c91174e68845a66c))


### Refactoring

* resolve connector diagnostics from active runtime state ([#32318](https://github.com/vm0-ai/vm0/issues/32318)) ([0445891](https://github.com/vm0-ai/vm0/commit/0445891e02f4bfd3e5db62a17e88fa877daa2cb8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.412.2
    * @okouai/core bumped to 8.631.4
    * @okouai/db bumped to 1.245.4
    * @okouai/pi-agent-runtime bumped to 1.21.16

## [1.563.1](https://github.com/vm0-ai/vm0/compare/api-v1.563.0...api-v1.563.1) (2026-09-07)


### Bug Fixes

* **api:** retain sanitized Fal webhook failure diagnostics ([#32322](https://github.com/vm0-ai/vm0/issues/32322)) ([216faf6](https://github.com/vm0-ai/vm0/commit/216faf6f93990752eae36e29c32dc67c3233ca46))
* **intro-video:** support managed native video agent generation ([#32305](https://github.com/vm0-ai/vm0/issues/32305)) ([f6c13bf](https://github.com/vm0-ai/vm0/commit/f6c13bf47c6995bd8c65f753741488231c6ae980))


### Refactoring

* **api:** rename residual observability values ([#32328](https://github.com/vm0-ai/vm0/issues/32328)) ([30dd5da](https://github.com/vm0-ai/vm0/commit/30dd5da77c569d6305fca05811fbf6d7a330a1bc)), closes [#32242](https://github.com/vm0-ai/vm0/issues/32242)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.412.1
    * @okouai/connectors bumped to 3.8.1
    * @okouai/core bumped to 8.631.3
    * @okouai/db bumped to 1.245.3
    * @okouai/pi-agent-runtime bumped to 1.21.15

## [1.563.0](https://github.com/vm0-ai/vm0/compare/api-v1.562.0...api-v1.563.0) (2026-09-07)


### Features

* add noyo client credentials provider ([#32095](https://github.com/vm0-ai/vm0/issues/32095)) ([f6f3d83](https://github.com/vm0-ai/vm0/commit/f6f3d83ad092a5144576d30a5955bfdff307b929))
* **api:** force app.vm0.ai clients to upgrade to v0.857.0 ([#32297](https://github.com/vm0-ai/vm0/issues/32297)) ([7949605](https://github.com/vm0-ai/vm0/commit/7949605c72b83863469b7ce8081caf650b15c686))
* **voice:** allow 60-minute voice input recordings ([#32316](https://github.com/vm0-ai/vm0/issues/32316)) ([9d8cce2](https://github.com/vm0-ai/vm0/commit/9d8cce23c35dd6bb9da84099a13a79949cfdc8d7))


### Bug Fixes

* **chat:** validate snapshot watermark cursors ([#32295](https://github.com/vm0-ai/vm0/issues/32295)) ([bcac973](https://github.com/vm0-ai/vm0/commit/bcac9738bf3975c857857c645b4f51d8cc2b659d))
* **video:** reject conflicting byteplus frame and reference inputs ([#32313](https://github.com/vm0-ai/vm0/issues/32313)) ([36bb143](https://github.com/vm0-ai/vm0/commit/36bb14328767cbb03c2b507be86d880d2dae7611))


### Refactoring

* **api:** neutralize built-in model test vocabulary ([#32273](https://github.com/vm0-ai/vm0/issues/32273)) ([fe8a5fc](https://github.com/vm0-ai/vm0/commit/fe8a5fc5287772f31e78ff1622fb4f8064152e3d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.412.0
    * @okouai/connectors bumped to 3.8.0
    * @okouai/core bumped to 8.631.2
    * @okouai/db bumped to 1.245.2
    * @okouai/pi-agent-runtime bumped to 1.21.14

## [1.562.0](https://github.com/vm0-ai/vm0/compare/api-v1.561.0...api-v1.562.0) (2026-09-07)


### Features

* **voice:** transcribe overlapping audio segments with resumable progress ([#32059](https://github.com/vm0-ai/vm0/issues/32059)) ([77a06e4](https://github.com/vm0-ai/vm0/commit/77a06e48dc6dbed124f690305b7f075350dd42a7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.411.0
    * @okouai/core bumped to 8.631.1
    * @okouai/db bumped to 1.245.1
    * @okouai/pi-agent-runtime bumped to 1.21.13

## [1.561.0](https://github.com/vm0-ai/vm0/compare/api-v1.560.1...api-v1.561.0) (2026-09-07)


### Features

* **api:** admit connector chat threads to pi ([#32222](https://github.com/vm0-ai/vm0/issues/32222)) ([b1e5195](https://github.com/vm0-ai/vm0/commit/b1e5195ab36f6735a9f3f431be8654dddb78fba9))
* persist active run connector diagnostic registrations ([#32181](https://github.com/vm0-ai/vm0/issues/32181)) ([87b3fef](https://github.com/vm0-ai/vm0/commit/87b3feff14b5b081ca642072142c97117792eead))


### Bug Fixes

* **billing:** reconcile already-refunded usage pack charges ([#32220](https://github.com/vm0-ai/vm0/issues/32220)) ([32217bf](https://github.com/vm0-ai/vm0/commit/32217bfb88413edc5aea54b24820410026df12bd))
* **ci:** sync catalog after production api deploy ([#32225](https://github.com/vm0-ai/vm0/issues/32225)) ([af108fe](https://github.com/vm0-ai/vm0/commit/af108fe9f4a4f306a64856b19708f1eac3adc947))
* **firewall:** attribute auth fetch deadlines ([#32195](https://github.com/vm0-ai/vm0/issues/32195)) ([c3c8778](https://github.com/vm0-ai/vm0/commit/c3c8778e1352786e8c21d868531656f79a9624a7))
* **workflows:** preserve recurring schedules across insufficient credits ([#32228](https://github.com/vm0-ai/vm0/issues/32228)) ([8ae8a3b](https://github.com/vm0-ai/vm0/commit/8ae8a3b0979cc331b43bbbd9a116e9c5b07a40b8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.410.0
    * @okouai/core bumped to 8.631.0
    * @okouai/db bumped to 1.245.0
    * @okouai/pi-agent-runtime bumped to 1.21.12

## [1.560.1](https://github.com/vm0-ai/vm0/compare/api-v1.560.0...api-v1.560.1) (2026-09-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.409.6
    * @okouai/core bumped to 8.630.1
    * @okouai/db bumped to 1.244.7
    * @okouai/pi-agent-runtime bumped to 1.21.11

## [1.560.0](https://github.com/vm0-ai/vm0/compare/api-v1.559.1...api-v1.560.0) (2026-09-07)


### Features

* enable presentation templates for all organizations ([#32089](https://github.com/vm0-ai/vm0/issues/32089)) ([7096061](https://github.com/vm0-ai/vm0/commit/7096061d5771379747e1da8d891b457f67a89850))


### Bug Fixes

* set terra reasoning effort to max ([#32194](https://github.com/vm0-ai/vm0/issues/32194)) ([bb60e20](https://github.com/vm0-ai/vm0/commit/bb60e2013f34f2d836a6839dda1c912091620ce5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.409.5
    * @okouai/connectors bumped to 3.7.0
    * @okouai/core bumped to 8.630.0
    * @okouai/db bumped to 1.244.6
    * @okouai/pi-agent-runtime bumped to 1.21.10

## [1.559.1](https://github.com/vm0-ai/vm0/compare/api-v1.559.0...api-v1.559.1) (2026-09-07)


### Refactoring

* **image-recognition:** add the canonical API route ([#32183](https://github.com/vm0-ai/vm0/issues/32183)) ([5ed8c24](https://github.com/vm0-ai/vm0/commit/5ed8c247e132d1c40698b03436bcf186b1924656))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.409.4
    * @okouai/core bumped to 8.629.2
    * @okouai/db bumped to 1.244.5
    * @okouai/pi-agent-runtime bumped to 1.21.9

## [1.559.0](https://github.com/vm0-ai/vm0/compare/api-v1.558.0...api-v1.559.0) (2026-09-07)


### Features

* **connectors:** add oto auth provider ([#32087](https://github.com/vm0-ai/vm0/issues/32087)) ([13fac04](https://github.com/vm0-ai/vm0/commit/13fac0448e15095aa9f13649cbee96ea2d92be14))
* **pi:** learn memory from agent chat threads ([#32177](https://github.com/vm0-ai/vm0/issues/32177)) ([6a0fedf](https://github.com/vm0-ai/vm0/commit/6a0fedf3804833fddfbe407e73d62189f790fb18))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.409.3
    * @okouai/connectors bumped to 3.6.0
    * @okouai/core bumped to 8.629.1
    * @okouai/db bumped to 1.244.4
    * @okouai/pi-agent-runtime bumped to 1.21.8

## [1.558.0](https://github.com/vm0-ai/vm0/compare/api-v1.557.1...api-v1.558.0) (2026-09-07)


### Features

* **core:** enable the compact model menu for staff ([#32068](https://github.com/vm0-ai/vm0/issues/32068)) ([13b4f23](https://github.com/vm0-ai/vm0/commit/13b4f2301cfb9af727edf63d99cdfd698b722a94))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.629.0
    * @okouai/db bumped to 1.244.3

## [1.557.1](https://github.com/vm0-ai/vm0/compare/api-v1.557.0...api-v1.557.1) (2026-09-07)


### Performance Improvements

* **api:** avoid duplicate global chat queue sweeps ([#32054](https://github.com/vm0-ai/vm0/issues/32054)) ([6bbfbe8](https://github.com/vm0-ai/vm0/commit/6bbfbe864b1a0c09759359aa2030795a5ce2f013))

## [1.557.0](https://github.com/vm0-ai/vm0/compare/api-v1.556.0...api-v1.557.0) (2026-09-07)


### Features

* **connectors:** add Procountor M2M token provider ([#32057](https://github.com/vm0-ai/vm0/issues/32057)) ([98c9ce9](https://github.com/vm0-ai/vm0/commit/98c9ce91c46d07b3732ded53af686553eb77f0b1))
* **connectors:** add reckon oauth refresh provider ([#32047](https://github.com/vm0-ai/vm0/issues/32047)) ([4ae3498](https://github.com/vm0-ai/vm0/commit/4ae3498b78b5929feaa40380ada13ca6471e9c7d))


### Refactoring

* remove expired deployment compatibility ([#32060](https://github.com/vm0-ai/vm0/issues/32060)) ([7a92520](https://github.com/vm0-ai/vm0/commit/7a9252039ee467efca9bdc1878e5bf7aa74c96cf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.409.2
    * @okouai/connectors bumped to 3.5.0
    * @okouai/core bumped to 8.628.0
    * @okouai/db bumped to 1.244.2
    * @okouai/pi-agent-runtime bumped to 1.21.7

## [1.556.0](https://github.com/vm0-ai/vm0/compare/api-v1.555.0...api-v1.556.0) (2026-09-06)


### Features

* add emboss and deboss illustration template ([#32010](https://github.com/vm0-ai/vm0/issues/32010)) ([e186381](https://github.com/vm0-ai/vm0/commit/e186381a7e441cf5168ae007ff15969a6260e43c))
* **connectors:** add resource guru oauth provider ([#32035](https://github.com/vm0-ai/vm0/issues/32035)) ([0efed4a](https://github.com/vm0-ai/vm0/commit/0efed4af768e106ba8bea91535c5b7299fa7d6ff))
* **core:** roll out follow-up optimization to all users ([#32037](https://github.com/vm0-ai/vm0/issues/32037)) ([60fa908](https://github.com/vm0-ai/vm0/commit/60fa908caced68e59f6a5ac0e441e77bb6ffb192))
* **platform:** add a compact composer model menu ([#32036](https://github.com/vm0-ai/vm0/issues/32036)) ([eb168c8](https://github.com/vm0-ai/vm0/commit/eb168c8a818b233d4c0dbeb37ee00a96f9eaeca4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.409.1
    * @okouai/connectors bumped to 3.4.0
    * @okouai/core bumped to 8.627.0
    * @okouai/db bumped to 1.244.1
    * @okouai/pi-agent-runtime bumped to 1.21.6

## [1.555.0](https://github.com/vm0-ai/vm0/compare/api-v1.554.1...api-v1.555.0) (2026-09-06)


### Features

* simplify intro video creation flow ([#31830](https://github.com/vm0-ai/vm0/issues/31830)) ([646a907](https://github.com/vm0-ai/vm0/commit/646a907e90dd9ffa0b7983a2d7d4dea77886893f))
* **ssh:** add standalone connection configuration api ([#32023](https://github.com/vm0-ai/vm0/issues/32023)) ([3e50b38](https://github.com/vm0-ai/vm0/commit/3e50b384d85a17b18b67a22a5af3dc59202b7f7f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.409.0
    * @okouai/core bumped to 8.626.0
    * @okouai/db bumped to 1.244.0
    * @okouai/pi-agent-runtime bumped to 1.21.5

## [1.554.1](https://github.com/vm0-ai/vm0/compare/api-v1.554.0...api-v1.554.1) (2026-09-06)


### Bug Fixes

* default voice input to gemini 3.1 flash-lite ([#32009](https://github.com/vm0-ai/vm0/issues/32009)) ([1ae6387](https://github.com/vm0-ai/vm0/commit/1ae638773aadb37a38f49ba0c825a22a13c06894))
* restore voice input cleanup prompt ([#32007](https://github.com/vm0-ai/vm0/issues/32007)) ([4e8bc21](https://github.com/vm0-ai/vm0/commit/4e8bc21b0b2c6ecd71c0e86189578fbec7230d4b))


### Documentation

* archive api and app changelogs by month ([#32006](https://github.com/vm0-ai/vm0/issues/32006)) ([1f11937](https://github.com/vm0-ai/vm0/commit/1f119373b286c53be5fedbe40a2c67b321f4e0dd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.408.1
    * @okouai/core bumped to 8.625.12
    * @okouai/db bumped to 1.243.1
    * @okouai/pi-agent-runtime bumped to 1.21.4

## [1.554.0](https://github.com/vm0-ai/vm0/compare/api-v1.553.1...api-v1.554.0) (2026-09-06)


### Features

* add voice input model preferences and honor lab overrides ([#31982](https://github.com/vm0-ai/vm0/issues/31982)) ([7b114d5](https://github.com/vm0-ai/vm0/commit/7b114d5b3b2683d2987daf09d651403f2951dc4c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.408.0
    * @okouai/core bumped to 8.625.11
    * @okouai/db bumped to 1.243.0
    * @okouai/pi-agent-runtime bumped to 1.21.3

## [1.553.1](https://github.com/vm0-ai/vm0/compare/api-v1.553.0...api-v1.553.1) (2026-09-06)


### Bug Fixes

* make pi memory citations safe across version skew ([#31976](https://github.com/vm0-ai/vm0/issues/31976)) ([63d4035](https://github.com/vm0-ai/vm0/commit/63d40353754fa03271b61b84d42ec3ee8cfe88f5))


### Refactoring

* **connectors:** remove single-account compatibility contract ([#31978](https://github.com/vm0-ai/vm0/issues/31978)) ([b0c87cb](https://github.com/vm0-ai/vm0/commit/b0c87cb69b860ef502e5722df642029ae9efd8f5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.407.1
    * @okouai/core bumped to 8.625.10
    * @okouai/db bumped to 1.242.2
    * @okouai/pi-agent-runtime bumped to 1.21.2

## [1.553.0](https://github.com/vm0-ai/vm0/compare/api-v1.552.0...api-v1.553.0) (2026-09-06)


### Features

* add cursor context and light polish to voice input ([#31968](https://github.com/vm0-ai/vm0/issues/31968)) ([12d0c92](https://github.com/vm0-ai/vm0/commit/12d0c9232684f9223ade010c40f3fad752b079df))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.407.0
    * @okouai/core bumped to 8.625.9
    * @okouai/db bumped to 1.242.1
    * @okouai/pi-agent-runtime bumped to 1.21.1

## [1.552.0](https://github.com/vm0-ai/vm0/compare/api-v1.551.9...api-v1.552.0) (2026-09-06)


### Features

* **pi-memory:** hide citation envelopes and preserve provenance ([#31965](https://github.com/vm0-ai/vm0/issues/31965)) ([5cecc7c](https://github.com/vm0-ai/vm0/commit/5cecc7cbcebb48899e4a9b251f209bbfb176f3f9))


### Performance Improvements

* avoid duplicate pinned reverse-template guide load ([#31969](https://github.com/vm0-ai/vm0/issues/31969)) ([e8843ea](https://github.com/vm0-ai/vm0/commit/e8843ea6642f706a2214569cbe4726164ae7a766))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.406.0
    * @okouai/core bumped to 8.625.8
    * @okouai/db bumped to 1.242.0
    * @okouai/pi-agent-runtime bumped to 1.21.0

## [1.551.9](https://github.com/vm0-ai/vm0/compare/api-v1.551.8...api-v1.551.9) (2026-09-06)


### Refactoring

* **db:** require explicit computer use host product identity ([#31961](https://github.com/vm0-ai/vm0/issues/31961)) ([af484c6](https://github.com/vm0-ai/vm0/commit/af484c62ebce6435e6382b9925d4a13107be877a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.625.7
    * @okouai/db bumped to 1.241.13

## [1.551.8](https://github.com/vm0-ai/vm0/compare/api-v1.551.7...api-v1.551.8) (2026-09-05)


### Bug Fixes

* settle private pi maintenance at the generic checkpoint boundary ([#31947](https://github.com/vm0-ai/vm0/issues/31947)) ([2db67fc](https://github.com/vm0-ai/vm0/commit/2db67fc8be4f1fa863c4faf8ed4905acfc65cdb5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.7
    * @okouai/core bumped to 8.625.6
    * @okouai/db bumped to 1.241.12
    * @okouai/pi-agent-runtime bumped to 1.20.6

## [1.551.7](https://github.com/vm0-ai/vm0/compare/api-v1.551.6...api-v1.551.7) (2026-09-05)


### Bug Fixes

* **api:** fail incomplete pi api-first no-tool output ([#31945](https://github.com/vm0-ai/vm0/issues/31945)) ([ea412a3](https://github.com/vm0-ai/vm0/commit/ea412a323b9c31290af23957387c9fd8b1cfebd4))

## [1.551.6](https://github.com/vm0-ai/vm0/compare/api-v1.551.5...api-v1.551.6) (2026-09-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.241.11

## [1.551.5](https://github.com/vm0-ai/vm0/compare/api-v1.551.4...api-v1.551.5) (2026-09-05)


### Bug Fixes

* finish voice input silently when no speech is detected ([#31933](https://github.com/vm0-ai/vm0/issues/31933)) ([b37822c](https://github.com/vm0-ai/vm0/commit/b37822c16ec7479dfc1fa1ecdefc85dd8ee53a6e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.6
    * @okouai/core bumped to 8.625.5
    * @okouai/db bumped to 1.241.10
    * @okouai/pi-agent-runtime bumped to 1.20.5

## [1.551.4](https://github.com/vm0-ai/vm0/compare/api-v1.551.3...api-v1.551.4) (2026-09-05)


### Bug Fixes

* **billing:** preserve managed allowance under shared debt ([#31851](https://github.com/vm0-ai/vm0/issues/31851)) ([eebda82](https://github.com/vm0-ai/vm0/commit/eebda828b10f54ee455826c3715222f6a3356d43))


### Refactoring

* **pi-memory:** publish phase 2 through sandbox checkpoints ([#31912](https://github.com/vm0-ai/vm0/issues/31912)) ([57ba1c3](https://github.com/vm0-ai/vm0/commit/57ba1c398f21dc34348bf0c6f20d12cd88283b7f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.5
    * @okouai/core bumped to 8.625.4
    * @okouai/db bumped to 1.241.9
    * @okouai/pi-agent-runtime bumped to 1.20.4

## [1.551.3](https://github.com/vm0-ai/vm0/compare/api-v1.551.2...api-v1.551.3) (2026-09-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/pi-agent-runtime bumped to 1.20.3

## [1.551.2](https://github.com/vm0-ai/vm0/compare/api-v1.551.1...api-v1.551.2) (2026-09-05)


### Bug Fixes

* **pi:** validate native session parent graphs before traversal ([#31910](https://github.com/vm0-ai/vm0/issues/31910)) ([9a84dc8](https://github.com/vm0-ai/vm0/commit/9a84dc87ccba2f12c6e8e7e16bbc6eea1d4c8501))


### Refactoring

* **platform:** rename browser globals and clerk bootstrap to okou ([#31904](https://github.com/vm0-ai/vm0/issues/31904)) ([d0e609d](https://github.com/vm0-ai/vm0/commit/d0e609d122cc970ebebad59a800836b311d4002b))
* rename module-scoped brand identifiers ([#31906](https://github.com/vm0-ai/vm0/issues/31906)) ([003db23](https://github.com/vm0-ai/vm0/commit/003db2336542de3fc504cbbc64e9ea26ec88a109))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.4
    * @okouai/connectors bumped to 3.3.6
    * @okouai/core bumped to 8.625.3
    * @okouai/db bumped to 1.241.8
    * @okouai/pi-agent-runtime bumped to 1.20.2

## [1.551.1](https://github.com/vm0-ai/vm0/compare/api-v1.551.0...api-v1.551.1) (2026-09-05)


### Bug Fixes

* **pi:** normalize native fast requests to priority ([#31895](https://github.com/vm0-ai/vm0/issues/31895)) ([0c910e8](https://github.com/vm0-ai/vm0/commit/0c910e8b80be2c91ead2bb04101b68f3b1d8647e)), closes [#31885](https://github.com/vm0-ai/vm0/issues/31885)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.625.2
    * @okouai/db bumped to 1.241.7
    * @okouai/pi-agent-runtime bumped to 1.20.1

## [1.551.0](https://github.com/vm0-ai/vm0/compare/api-v1.550.0...api-v1.551.0) (2026-09-05)


### Features

* **pi-memory:** add sandbox-local ad hoc notes ([#31878](https://github.com/vm0-ai/vm0/issues/31878)) ([1b70c02](https://github.com/vm0-ai/vm0/commit/1b70c028318063e0d90163eabb80f30868cd7dbb))


### Bug Fixes

* **api:** double connector catalog capacity ([#31882](https://github.com/vm0-ai/vm0/issues/31882)) ([647858d](https://github.com/vm0-ai/vm0/commit/647858d28bd4a8049b681305c168093fc3feca91))


### Refactoring

* unify voice input feature switches ([#31884](https://github.com/vm0-ai/vm0/issues/31884)) ([4537935](https://github.com/vm0-ai/vm0/commit/453793580a047239a98c91d92568b56898e58c25))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.3
    * @okouai/connectors bumped to 3.3.5
    * @okouai/core bumped to 8.625.1
    * @okouai/db bumped to 1.241.6
    * @okouai/pi-agent-runtime bumped to 1.20.0

## [1.550.0](https://github.com/vm0-ai/vm0/compare/api-v1.549.0...api-v1.550.0) (2026-09-05)


### Features

* **api:** route api-key Terra Fast through Pi ([#31868](https://github.com/vm0-ai/vm0/issues/31868)) ([32ee834](https://github.com/vm0-ai/vm0/commit/32ee834ce0466969e101ec75c24cda8f8068fb1f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/pi-agent-runtime bumped to 1.19.0

## [1.549.0](https://github.com/vm0-ai/vm0/compare/api-v1.548.1...api-v1.549.0) (2026-09-05)


### Features

* **api:** route subscription Terra Fast through Pi ([#31857](https://github.com/vm0-ai/vm0/issues/31857)) ([109ef62](https://github.com/vm0-ai/vm0/commit/109ef6256ba3e8c59eeb0f6754d71bd6536d75b7))


### Refactoring

* **voice:** remove draft compatibility and encoded audio fallback ([#31792](https://github.com/vm0-ai/vm0/issues/31792)) ([83979d4](https://github.com/vm0-ai/vm0/commit/83979d4a271483500bce0e63f837b5a9db279262))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.2
    * @okouai/core bumped to 8.625.0
    * @okouai/db bumped to 1.241.5
    * @okouai/pi-agent-runtime bumped to 1.18.0

## [1.548.1](https://github.com/vm0-ai/vm0/compare/api-v1.548.0...api-v1.548.1) (2026-09-05)


### Bug Fixes

* **api:** require account-explicit app bundles ([#31843](https://github.com/vm0-ai/vm0/issues/31843)) ([9ce1640](https://github.com/vm0-ai/vm0/commit/9ce1640f9357d8516fd3f4e97b1a3aea60c35f64))
* **api:** reuse sessions by runtime and model family ([#31796](https://github.com/vm0-ai/vm0/issues/31796)) ([6fd1c6f](https://github.com/vm0-ai/vm0/commit/6fd1c6ff18aa9bbeaf7d55c833bb1336d193be7a))


### Refactoring

* **api:** rename the zero dispatch telemetry action names to agent ([#31846](https://github.com/vm0-ai/vm0/issues/31846)) ([488bb99](https://github.com/vm0-ai/vm0/commit/488bb9902b1c4abace6024ad3611778f8fb59179)), closes [#31842](https://github.com/vm0-ai/vm0/issues/31842)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.1
    * @okouai/core bumped to 8.624.0
    * @okouai/db bumped to 1.241.4
    * @okouai/pi-agent-runtime bumped to 1.17.1

## [1.548.0](https://github.com/vm0-ai/vm0/compare/api-v1.547.1...api-v1.548.0) (2026-09-05)


### Features

* **pi:** add dialect-aware fast carrier compatibility ([#31839](https://github.com/vm0-ai/vm0/issues/31839)) ([444bfe5](https://github.com/vm0-ai/vm0/commit/444bfe5a6f04edb5ba3ccbc90a0895e7ca4a44d8))


### Refactoring

* **api:** rename the vm0 built-in model vocabulary to built-in ([#31834](https://github.com/vm0-ai/vm0/issues/31834)) ([1cfe7fc](https://github.com/vm0-ai/vm0/commit/1cfe7fccc9c89a46171f6aad08750cb6dab8865b)), closes [#31818](https://github.com/vm0-ai/vm0/issues/31818)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.0
    * @okouai/core bumped to 8.623.2
    * @okouai/db bumped to 1.241.3
    * @okouai/pi-agent-runtime bumped to 1.17.0

## [1.547.1](https://github.com/vm0-ai/vm0/compare/api-v1.547.0...api-v1.547.1) (2026-09-05)


### Bug Fixes

* **api:** honor active run credit admission in okou gates ([#31777](https://github.com/vm0-ai/vm0/issues/31777)) ([adeb43c](https://github.com/vm0-ai/vm0/commit/adeb43c245bbcdacd79d1619dc34cf6378921951))


### Refactoring

* **api:** retire the legacy zero run vocabulary ([#31811](https://github.com/vm0-ai/vm0/issues/31811)) ([45d2e0f](https://github.com/vm0-ai/vm0/commit/45d2e0fad1c557d5c05d16074322b52ddf1c508a)), closes [#26877](https://github.com/vm0-ai/vm0/issues/26877)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.404.1
    * @okouai/core bumped to 8.623.1
    * @okouai/db bumped to 1.241.2
    * @okouai/pi-agent-runtime bumped to 1.16.6

## [1.547.0](https://github.com/vm0-ai/vm0/compare/api-v1.546.0...api-v1.547.0) (2026-09-05)


### Features

* **cli:** support legacy ppt template sources ([#31755](https://github.com/vm0-ai/vm0/issues/31755)) ([6eeb085](https://github.com/vm0-ai/vm0/commit/6eeb0852534423737b6d14e0b2235cbbb3ed4ff0))


### Bug Fixes

* retire claude fable 5 from model selection ([#31790](https://github.com/vm0-ai/vm0/issues/31790)) ([86185af](https://github.com/vm0-ai/vm0/commit/86185affdd253f409dad6d217aa5b0f16ac5086c))


### Refactoring

* **chat:** remove prefixed timeout fallback ([#31778](https://github.com/vm0-ai/vm0/issues/31778)) ([3f8dad2](https://github.com/vm0-ai/vm0/commit/3f8dad2589c9eb19acd9fc3f00dffda12d20144f))
* **eslint:** rename the internal lint plugin namespace to okou ([#31806](https://github.com/vm0-ai/vm0/issues/31806)) ([314590e](https://github.com/vm0-ai/vm0/commit/314590ea8d2671714555db2a4cfeb035994eb779)), closes [#31799](https://github.com/vm0-ai/vm0/issues/31799)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.404.0
    * @okouai/connectors bumped to 3.3.4
    * @okouai/core bumped to 8.623.0
    * @okouai/db bumped to 1.241.1
    * @okouai/pi-agent-runtime bumped to 1.16.5

## [1.546.0](https://github.com/vm0-ai/vm0/compare/api-v1.545.2...api-v1.546.0) (2026-09-04)


### Features

* add intro video heygen renderer and voice services ([#31658](https://github.com/vm0-ai/vm0/issues/31658)) ([1917a5f](https://github.com/vm0-ai/vm0/commit/1917a5fa59ee61fdb44f0d1822804a256009ef88))


### Refactoring

* remove expired deployment compatibility ([#31781](https://github.com/vm0-ai/vm0/issues/31781)) ([fe72e06](https://github.com/vm0-ai/vm0/commit/fe72e065718d2caeea5b45dd71008b0ad777459e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.403.0
    * @okouai/core bumped to 8.622.0
    * @okouai/db bumped to 1.241.0
    * @okouai/pi-agent-runtime bumped to 1.16.4

## [1.545.2](https://github.com/vm0-ai/vm0/compare/api-v1.545.1...api-v1.545.2) (2026-09-04)


### Bug Fixes

* **agent:** align avatar edits with visibility permissions ([#31731](https://github.com/vm0-ai/vm0/issues/31731)) ([8cf8b09](https://github.com/vm0-ai/vm0/commit/8cf8b094a80ea861fbb366df0cc33323e1cf9846))
* **api:** preserve admitted run credit access ([#31726](https://github.com/vm0-ai/vm0/issues/31726)) ([c5f4085](https://github.com/vm0-ai/vm0/commit/c5f4085b83007baa097682f58fb47dfc647b923f))


### Refactoring

* **api:** remove legacy custom connector oauth readers ([#31751](https://github.com/vm0-ai/vm0/issues/31751)) ([3a13b3a](https://github.com/vm0-ai/vm0/commit/3a13b3ad6564d96d6a721287ed2e816c5b1a60f6))
* remove office preview response compatibility ([#31727](https://github.com/vm0-ai/vm0/issues/31727)) ([c598a28](https://github.com/vm0-ai/vm0/commit/c598a28d589959e971383a380691f80911c130e2))


### Performance Improvements

* move type checking to the typescript 7 native compiler ([#31716](https://github.com/vm0-ai/vm0/issues/31716)) ([aa41353](https://github.com/vm0-ai/vm0/commit/aa41353c983fbc0212ec1e06aa34b56a71bf2166))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.402.2
    * @okouai/connectors bumped to 3.3.3
    * @okouai/core bumped to 8.621.2
    * @okouai/db bumped to 1.240.7
    * @okouai/pi-agent-runtime bumped to 1.16.3

## [1.545.1](https://github.com/vm0-ai/vm0/compare/api-v1.545.0...api-v1.545.1) (2026-09-04)


### Refactoring

* **registry:** trim presentation download response ([#31707](https://github.com/vm0-ai/vm0/issues/31707)) ([98a36b7](https://github.com/vm0-ai/vm0/commit/98a36b7269d543f8009f8cbda307d678d391cda9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.402.1
    * @okouai/core bumped to 8.621.1
    * @okouai/db bumped to 1.240.6
    * @okouai/pi-agent-runtime bumped to 1.16.2

## [1.545.0](https://github.com/vm0-ai/vm0/compare/api-v1.544.0...api-v1.545.0) (2026-09-04)


### Features

* add gpt-6 astra support ([#31558](https://github.com/vm0-ai/vm0/issues/31558)) ([004ea48](https://github.com/vm0-ai/vm0/commit/004ea48590eba7c66af3a9b156e3daba7411793b))
* **app:** bootstrap first api responses in the app shell ([#31665](https://github.com/vm0-ai/vm0/issues/31665)) ([21e3a85](https://github.com/vm0-ai/vm0/commit/21e3a858cddd1489337cd47dc010dd93fee7cc6d))
* **pi:** activate Terra API-key routes ([#31717](https://github.com/vm0-ai/vm0/issues/31717)) ([9539c77](https://github.com/vm0-ai/vm0/commit/9539c777bf68f926cb29efc6a6e06e79f3bc1310))


### Bug Fixes

* **api:** classify Fal image generation failures ([#31690](https://github.com/vm0-ai/vm0/issues/31690)) ([0faf86b](https://github.com/vm0-ai/vm0/commit/0faf86b5bbd09d2b3480261936e8b3712d443181))
* **api:** give reasoning-enabled fast-path calls enough token budget ([#31715](https://github.com/vm0-ai/vm0/issues/31715)) ([4dbd97e](https://github.com/vm0-ai/vm0/commit/4dbd97e443a2999e13c4cbf9af31f6454b3dbac7))
* **chat:** preserve structured runner timeout recovery ([#31711](https://github.com/vm0-ai/vm0/issues/31711)) ([1a6f7d2](https://github.com/vm0-ai/vm0/commit/1a6f7d27e30421af781efa7ac3025e46e39286dd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.402.0
    * @okouai/core bumped to 8.621.0
    * @okouai/db bumped to 1.240.5
    * @okouai/pi-agent-runtime bumped to 1.16.1

## [1.544.0](https://github.com/vm0-ai/vm0/compare/api-v1.543.0...api-v1.544.0) (2026-09-04)


### Features

* add avatar composer v2 ([#31526](https://github.com/vm0-ai/vm0/issues/31526)) ([0812c8b](https://github.com/vm0-ai/vm0/commit/0812c8bfb4c4d8a8e416717573a3d5a6609347f8))
* add progressive artifact preview switch ([#31682](https://github.com/vm0-ai/vm0/issues/31682)) ([8aa24e8](https://github.com/vm0-ai/vm0/commit/8aa24e8b2decb7545ff6bc44c7575bbeac19c188))
* **core:** roll out connector accounts to all users ([#31608](https://github.com/vm0-ai/vm0/issues/31608)) ([aca7cf7](https://github.com/vm0-ai/vm0/commit/aca7cf7ea9e6a36a37cfedbfcd987394f977add5))
* **pi:** activate ChatGPT subscription Terra route ([#31586](https://github.com/vm0-ai/vm0/issues/31586)) ([722c869](https://github.com/vm0-ai/vm0/commit/722c869fe1f737b69c5197dee6aa1c005dd594d8))
* **registry:** pull current presentation templates ([#31614](https://github.com/vm0-ai/vm0/issues/31614)) ([0d9edac](https://github.com/vm0-ai/vm0/commit/0d9edacec1340f700362a7353564bab015c40cf6))


### Bug Fixes

* **api:** defer schedule automation threads ([#31601](https://github.com/vm0-ai/vm0/issues/31601)) ([21b99b0](https://github.com/vm0-ai/vm0/commit/21b99b0f115c21ab451c8f200f60c6998ef1c4d5))
* **api:** require useful recommended follow-ups ([#31611](https://github.com/vm0-ai/vm0/issues/31611)) ([753a510](https://github.com/vm0-ai/vm0/commit/753a510101be913734b267c423d4dac55431a3c9))
* **api:** retry transient clerk read failures ([#31615](https://github.com/vm0-ai/vm0/issues/31615)) ([9645a0d](https://github.com/vm0-ai/vm0/commit/9645a0d5e3242386bac9d4d2a4093818a6c155af))
* **api:** set limited-free onboarding credits to 1,000 ([#31622](https://github.com/vm0-ai/vm0/issues/31622)) ([29fd38d](https://github.com/vm0-ai/vm0/commit/29fd38d7d108fda3b27d058433c0f62f808da419))
* **ci:** repair app worker production promotion ([#31672](https://github.com/vm0-ai/vm0/issues/31672)) ([29317b9](https://github.com/vm0-ai/vm0/commit/29317b9ac9ccd4d72c2fc4da0a465e234acef032))
* **email:** use workflow display name as result subject ([#31578](https://github.com/vm0-ai/vm0/issues/31578)) ([3af69be](https://github.com/vm0-ai/vm0/commit/3af69be89f11ea6fac27cc52330f567439312bea))
* keep intro video guidance out of user prompts ([#31673](https://github.com/vm0-ai/vm0/issues/31673)) ([40a2a9d](https://github.com/vm0-ai/vm0/commit/40a2a9d5a99d27eef49fcab8547af52bd43055e0))
* localize automatic mcp oauth errors ([#31626](https://github.com/vm0-ai/vm0/issues/31626)) ([4420f93](https://github.com/vm0-ai/vm0/commit/4420f93d5ba7aba8c54ab46e0d5305674fb2588a))


### Refactoring

* **api:** consolidate openrouter fast-path callers onto the shared helper ([#31653](https://github.com/vm0-ai/vm0/issues/31653)) ([9611380](https://github.com/vm0-ai/vm0/commit/961138077f417c43ce1f23c43cc494b46c8fa3cd)), closes [#31619](https://github.com/vm0-ai/vm0/issues/31619)
* **api:** remove rollout oauth state fallbacks ([#31609](https://github.com/vm0-ai/vm0/issues/31609)) ([df9f44c](https://github.com/vm0-ai/vm0/commit/df9f44c98af3fa1e063f81bb4902642446b986df))
* **api:** switch custom oauth state discriminator ([#31547](https://github.com/vm0-ai/vm0/issues/31547)) ([f0cbf9d](https://github.com/vm0-ai/vm0/commit/f0cbf9d82d296bb6cb306c2e6b8942d014ee89af))


### Performance Improvements

* **api:** switch the fast-path llm to gemini-3.8-flash with pinned reasoning effort ([#31698](https://github.com/vm0-ai/vm0/issues/31698)) ([a849749](https://github.com/vm0-ai/vm0/commit/a849749df5c93d55c9da477359189d0e316aac97)), closes [#31694](https://github.com/vm0-ai/vm0/issues/31694)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.401.0
    * @okouai/core bumped to 8.620.0
    * @okouai/db bumped to 1.240.4
    * @okouai/pi-agent-runtime bumped to 1.16.0

## [1.543.0](https://github.com/vm0-ai/vm0/compare/api-v1.542.1...api-v1.543.0) (2026-09-04)


### Features

* **app:** enable production clerk edge sessions ([#31636](https://github.com/vm0-ai/vm0/issues/31636)) ([367559e](https://github.com/vm0-ai/vm0/commit/367559efb7c8ffeb8d1b9b7bfdd0e2d32b76095c))

## [1.542.1](https://github.com/vm0-ai/vm0/compare/api-v1.542.0...api-v1.542.1) (2026-09-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.400.1
    * @okouai/core bumped to 8.619.1
    * @okouai/db bumped to 1.240.3
    * @okouai/pi-agent-runtime bumped to 1.15.7

## [1.542.0](https://github.com/vm0-ai/vm0/compare/api-v1.541.1...api-v1.542.0) (2026-09-03)


### Features

* use chat context for voice draft cleanup ([#31517](https://github.com/vm0-ai/vm0/issues/31517)) ([c77f7ff](https://github.com/vm0-ai/vm0/commit/c77f7ff2fc4887a079700e3729bef1afcf5da863))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.400.0
    * @okouai/core bumped to 8.619.0
    * @okouai/db bumped to 1.240.2
    * @okouai/pi-agent-runtime bumped to 1.15.6

## [1.541.1](https://github.com/vm0-ai/vm0/compare/api-v1.541.0...api-v1.541.1) (2026-09-03)


### Bug Fixes

* **api:** refresh API release marker comment ([#31538](https://github.com/vm0-ai/vm0/issues/31538)) ([435603e](https://github.com/vm0-ai/vm0/commit/435603e8598dcf2e0c76c7d9fdc6ca6470826e31))


### Refactoring

* remove expired deployment compatibility ([#31524](https://github.com/vm0-ai/vm0/issues/31524)) ([2020321](https://github.com/vm0-ai/vm0/commit/202032117158dca3c445b5f6f6d5e0e2d5b660aa))


### Performance Improvements

* **api:** bound run context Axiom query by creation time ([#31509](https://github.com/vm0-ai/vm0/issues/31509)) ([18fa8fc](https://github.com/vm0-ai/vm0/commit/18fa8fcad7bd5023c11d69bd885a33fe2c4060e8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.399.1
    * @okouai/core bumped to 8.618.0
    * @okouai/db bumped to 1.240.1
    * @okouai/pi-agent-runtime bumped to 1.15.5

## [1.541.0](https://github.com/vm0-ai/vm0/compare/api-v1.540.0...api-v1.541.0) (2026-09-03)


### Features

* add cloud browser preference ([#31522](https://github.com/vm0-ai/vm0/issues/31522)) ([99b4589](https://github.com/vm0-ai/vm0/commit/99b4589022738a463640e019b97f31c150e50850))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.399.0
    * @okouai/core bumped to 8.617.0
    * @okouai/db bumped to 1.240.0
    * @okouai/pi-agent-runtime bumped to 1.15.4

## [1.540.0](https://github.com/vm0-ai/vm0/compare/api-v1.539.1...api-v1.540.0) (2026-09-03)


### Features

* **api:** show okou avatar in automation emails ([#31518](https://github.com/vm0-ai/vm0/issues/31518)) ([ae9d20f](https://github.com/vm0-ai/vm0/commit/ae9d20f90604814af0d5f4f800d4e93476455f88))
* **artifacts:** add short okou artifact urls ([#31483](https://github.com/vm0-ai/vm0/issues/31483)) ([9d20d76](https://github.com/vm0-ai/vm0/commit/9d20d76b88d3097f279084fcfb452d8b86e7ef55))


### Bug Fixes

* **api:** improve recommended follow-up choices ([#31527](https://github.com/vm0-ai/vm0/issues/31527)) ([06cc869](https://github.com/vm0-ai/vm0/commit/06cc86955be1685df879da6d37d8aa419beab549))
* **pi-memory:** promote terminal lifecycle telemetry ([#31512](https://github.com/vm0-ai/vm0/issues/31512)) ([35a2e51](https://github.com/vm0-ai/vm0/commit/35a2e51eebeed869c189609f49b5b4e46b630ae6))


### Refactoring

* **pi-memory:** make piloop the single product switch ([#31496](https://github.com/vm0-ai/vm0/issues/31496)) ([709e1a2](https://github.com/vm0-ai/vm0/commit/709e1a26703eac64d7501e777d802d80af19430c))
* **pi:** add dialect-aware credential runtime contract ([#31493](https://github.com/vm0-ai/vm0/issues/31493)) ([9464fb3](https://github.com/vm0-ai/vm0/commit/9464fb3e99138707f242b1fe789cf0e375602973))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.398.2
    * @okouai/core bumped to 8.616.0
    * @okouai/db bumped to 1.239.2
    * @okouai/pi-agent-runtime bumped to 1.15.3

## [1.539.1](https://github.com/vm0-ai/vm0/compare/api-v1.539.0...api-v1.539.1) (2026-09-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.398.1
    * @okouai/core bumped to 8.615.1
    * @okouai/db bumped to 1.239.1
    * @okouai/pi-agent-runtime bumped to 1.15.2

## [1.539.0](https://github.com/vm0-ai/vm0/compare/api-v1.538.2...api-v1.539.0) (2026-09-03)


### Features

* **chat:** persist v7 run failure reasons ([#31419](https://github.com/vm0-ai/vm0/issues/31419)) ([8739601](https://github.com/vm0-ai/vm0/commit/873960155fa9fd61c1e4db80f3e4275672696ee0))
* **cli:** redesign okou social around user intents ([#31333](https://github.com/vm0-ai/vm0/issues/31333)) ([1dafc7d](https://github.com/vm0-ai/vm0/commit/1dafc7d10900a2f1a5b7c6821090cc287b150093))
* **ui:** refresh the app palette onto the sand and amber scales ([#31081](https://github.com/vm0-ai/vm0/issues/31081)) ([eff8671](https://github.com/vm0-ai/vm0/commit/eff8671a6068d00502fad87e629409417e3ddd56))


### Performance Improvements

* **api:** skip unchanged chat event catch-up reads ([#31492](https://github.com/vm0-ai/vm0/issues/31492)) ([eac0955](https://github.com/vm0-ai/vm0/commit/eac09551e159c571114c1dbfc9039ddaba11eb56))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.615.0
    * @okouai/db bumped to 1.239.0

## [1.538.2](https://github.com/vm0-ai/vm0/compare/api-v1.538.1...api-v1.538.2) (2026-09-03)


### Bug Fixes

* **agent:** lock default agent name ([#31440](https://github.com/vm0-ai/vm0/issues/31440)) ([1c40b16](https://github.com/vm0-ai/vm0/commit/1c40b16066635e282d31752e6ce654b1422f5ecb))
* **cli:** make action url handoffs loss-resistant ([#31461](https://github.com/vm0-ai/vm0/issues/31461)) ([da3fa0d](https://github.com/vm0-ai/vm0/commit/da3fa0d9df45c76e052ff9d3c6a99e3cc7ffa040))
* **social:** classify mp4 downloads by media tracks ([#31418](https://github.com/vm0-ai/vm0/issues/31418)) ([23dd595](https://github.com/vm0-ai/vm0/commit/23dd5951c24da38ea4c8e3cbfaa839a1de974e42))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.614.2
    * @okouai/db bumped to 1.238.6

## [1.538.1](https://github.com/vm0-ai/vm0/compare/api-v1.538.0...api-v1.538.1) (2026-09-03)


### Bug Fixes

* **api:** bind mcp discovery to exact run accounts ([#31459](https://github.com/vm0-ai/vm0/issues/31459)) ([b021508](https://github.com/vm0-ai/vm0/commit/b0215087ca388de4ea1713b727617f74a4f686cf))
* **core:** return morning brief to gated beta ([#31463](https://github.com/vm0-ai/vm0/issues/31463)) ([8bc5f29](https://github.com/vm0-ai/vm0/commit/8bc5f295f68bf600f1b97cf044ccad29d465b700))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.614.1
    * @okouai/db bumped to 1.238.5

## [1.538.0](https://github.com/vm0-ai/vm0/compare/api-v1.537.0...api-v1.538.0) (2026-09-03)


### Features

* **api:** optimize recommended follow-up prompts ([#31394](https://github.com/vm0-ai/vm0/issues/31394)) ([5f1b1f9](https://github.com/vm0-ai/vm0/commit/5f1b1f9de657d89315f60f2d573fe19a2084b938))
* show when the soonest codex reset credit expires ([#31412](https://github.com/vm0-ai/vm0/issues/31412)) ([127bed8](https://github.com/vm0-ai/vm0/commit/127bed8e9ab803338c93fcb3ffaf5fa478cc0c6c))


### Bug Fixes

* **api:** explain BytePlus real-person image rejection ([#31416](https://github.com/vm0-ai/vm0/issues/31416)) ([0527941](https://github.com/vm0-ai/vm0/commit/0527941b660d29fe3a312cbd32e9e34a93de9cbb))
* **api:** log morning brief onboarding outcomes ([#31396](https://github.com/vm0-ai/vm0/issues/31396)) ([c8317a3](https://github.com/vm0-ai/vm0/commit/c8317a366010f42f9c7bbb2d351b88a150618af8))
* **api:** recover artifact preview navigation timeouts ([#31432](https://github.com/vm0-ai/vm0/issues/31432)) ([02c3df0](https://github.com/vm0-ai/vm0/commit/02c3df0adeeb309eed13de53b601e83fc43f06b3))
* **guest-agent:** classify oversized codex turn inputs ([#31404](https://github.com/vm0-ai/vm0/issues/31404)) ([8cf7f4b](https://github.com/vm0-ai/vm0/commit/8cf7f4b60fde6c4c8239ff27f27a9cc24e90f124))
* **pi-memory:** reject non-adjacent path collisions ([#31357](https://github.com/vm0-ai/vm0/issues/31357)) ([0aea850](https://github.com/vm0-ai/vm0/commit/0aea850c09d88dab810fa1941b21e738a774da08))


### Refactoring

* **api:** detach custom connectors from oauth setup persistence ([#31417](https://github.com/vm0-ai/vm0/issues/31417)) ([944b829](https://github.com/vm0-ai/vm0/commit/944b829570b4c69685f68d6dae159a75bd3c07f1))
* **api:** require exact connector ids for credential loading ([#31397](https://github.com/vm0-ai/vm0/issues/31397)) ([6c076fd](https://github.com/vm0-ai/vm0/commit/6c076fdb60f64ab27b1584c1525c17fe6e11c86b))
* remove obsolete vm0 migration tombstones ([#31401](https://github.com/vm0-ai/vm0/issues/31401)) ([7c530c6](https://github.com/vm0-ai/vm0/commit/7c530c63a3afc86db32a90757e155ed97dcf2dc0))


### Performance Improvements

* **api:** overlap attachment metadata resolution ([#31366](https://github.com/vm0-ai/vm0/issues/31366)) ([2081d93](https://github.com/vm0-ai/vm0/commit/2081d933272eb571065c80e37f04df2250f94509))
* **api:** overlap request and session storage preparation ([#31363](https://github.com/vm0-ai/vm0/issues/31363)) ([9839acf](https://github.com/vm0-ai/vm0/commit/9839acf1329f77de5a419bf6939c60cfeb9dccbe))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.398.0
    * @okouai/connectors bumped to 3.3.2
    * @okouai/core bumped to 8.614.0
    * @okouai/db bumped to 1.238.4
    * @okouai/pi-agent-runtime bumped to 1.15.1

## [1.537.0](https://github.com/vm0-ai/vm0/compare/api-v1.536.0...api-v1.537.0) (2026-09-03)


### Features

* **chat:** batch shared worker event catch-up ([#31261](https://github.com/vm0-ai/vm0/issues/31261)) ([127f8e8](https://github.com/vm0-ai/vm0/commit/127f8e8cfc5cc91750a5ca7a1ac90529f10d4ef9))
* **pi-memory:** compose bounded phase 2 archive worker ([#31335](https://github.com/vm0-ai/vm0/issues/31335)) ([c8662dc](https://github.com/vm0-ai/vm0/commit/c8662dccea14112a2b2038cb26f64336e22e8a1c))
* polish voice drafts before sending ([#31190](https://github.com/vm0-ai/vm0/issues/31190)) ([12b2532](https://github.com/vm0-ai/vm0/commit/12b2532a6400c7c62ba705a782e3e209f0440091))


### Bug Fixes

* **api:** avoid locking empty active-input polls ([#31329](https://github.com/vm0-ai/vm0/issues/31329)) ([38884ae](https://github.com/vm0-ai/vm0/commit/38884ae93f6fcf6ef6e00a356663f1276fa97050))
* **platform:** use selected drive account for artifact readiness ([#31316](https://github.com/vm0-ai/vm0/issues/31316)) ([65d4ac5](https://github.com/vm0-ai/vm0/commit/65d4ac58bb3df45a52c97658bde0f594f554b6ad))


### Refactoring

* **contracts:** accept forward-compatible failure reasons ([#31305](https://github.com/vm0-ai/vm0/issues/31305)) ([abf08e4](https://github.com/vm0-ai/vm0/commit/abf08e49f5d261b1197975b5fa2bc6c1e6a7fbca))


### Performance Improvements

* **api:** reuse persisted plan capabilities ([#31320](https://github.com/vm0-ai/vm0/issues/31320)) ([b0ebcef](https://github.com/vm0-ai/vm0/commit/b0ebcef5734e0f73672eb8c95780e8946fa53592))
* **api:** select goal from authoritative queue head ([#31327](https://github.com/vm0-ai/vm0/issues/31327)) ([9bd0c1a](https://github.com/vm0-ai/vm0/commit/9bd0c1a26eaecdbb995db99c14cf988517e7d10e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.397.0
    * @okouai/core bumped to 8.613.0
    * @okouai/db bumped to 1.238.3
    * @okouai/pi-agent-runtime bumped to 1.15.0

## [1.536.0](https://github.com/vm0-ai/vm0/compare/api-v1.535.1...api-v1.536.0) (2026-09-03)


### Features

* launch morning brief for future workspace creators ([#31289](https://github.com/vm0-ai/vm0/issues/31289)) ([8bf2a15](https://github.com/vm0-ai/vm0/commit/8bf2a154bdb38424d1e466280c86c123a3b89334))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.612.0
    * @okouai/db bumped to 1.238.2
    * @okouai/pi-agent-runtime bumped to 1.14.4

## [1.535.1](https://github.com/vm0-ai/vm0/compare/api-v1.535.0...api-v1.535.1) (2026-09-03)


### Bug Fixes

* **models:** remove claude fable 5 from new workspace defaults ([#31281](https://github.com/vm0-ai/vm0/issues/31281)) ([699e37f](https://github.com/vm0-ai/vm0/commit/699e37fdc9986b5ded7108d7aa46060b12cfa43f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.396.3
    * @okouai/core bumped to 8.611.6
    * @okouai/db bumped to 1.238.1
    * @okouai/pi-agent-runtime bumped to 1.14.3

## [1.535.0](https://github.com/vm0-ai/vm0/compare/api-v1.534.3...api-v1.535.0) (2026-09-03)


### Features

* **pi-memory:** add CAS-safe publication control plane ([#31267](https://github.com/vm0-ai/vm0/issues/31267)) ([300d105](https://github.com/vm0-ai/vm0/commit/300d105769122ccd06ad2f4e54a0bc8446f7a1f9))


### Bug Fixes

* surface paused goal context in thread runs ([#31265](https://github.com/vm0-ai/vm0/issues/31265)) ([35a1d9d](https://github.com/vm0-ai/vm0/commit/35a1d9d1e76a6b0135c4d73ea8b44a51531e1291))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.238.0

## [1.534.3](https://github.com/vm0-ai/vm0/compare/api-v1.534.2...api-v1.534.3) (2026-09-03)


### Bug Fixes

* **mail:** preserve exact reconnect account ([#31224](https://github.com/vm0-ai/vm0/issues/31224)) ([87a73d3](https://github.com/vm0-ai/vm0/commit/87a73d3f81fc8c7aa229a18d0c70c99a054bf121))
* target selected google drive account for artifact recovery ([#31227](https://github.com/vm0-ai/vm0/issues/31227)) ([90388e8](https://github.com/vm0-ai/vm0/commit/90388e854981ba1d0eca0783ca84f477422445ce))


### Refactoring

* **api:** remove model rankings statistics runtime ([#31230](https://github.com/vm0-ai/vm0/issues/31230)) ([f9e93f9](https://github.com/vm0-ai/vm0/commit/f9e93f98006afbe7038c94005ad700b9e6abe51c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.396.2
    * @okouai/core bumped to 8.611.5
    * @okouai/db bumped to 1.237.1
    * @okouai/pi-agent-runtime bumped to 1.14.2

## [1.534.2](https://github.com/vm0-ai/vm0/compare/api-v1.534.1...api-v1.534.2) (2026-09-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/pi-agent-runtime bumped to 1.14.1

## [1.534.1](https://github.com/vm0-ai/vm0/compare/api-v1.534.0...api-v1.534.1) (2026-09-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/pi-agent-runtime bumped to 1.14.0

## [1.534.0](https://github.com/vm0-ai/vm0/compare/api-v1.533.0...api-v1.534.0) (2026-09-02)


### Features

* **pi-memory:** add per-storage phase 2 control plane ([#31241](https://github.com/vm0-ai/vm0/issues/31241)) ([cca1c16](https://github.com/vm0-ai/vm0/commit/cca1c1660226fca72ed71bd2b02965f5aacd0167))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.396.1
    * @okouai/connectors bumped to 3.3.1
    * @okouai/core bumped to 8.611.4
    * @okouai/db bumped to 1.237.0

## [1.533.0](https://github.com/vm0-ai/vm0/compare/api-v1.532.0...api-v1.533.0) (2026-09-02)


### Features

* **app:** route production traffic through app worker ([#31207](https://github.com/vm0-ai/vm0/issues/31207)) ([64403f6](https://github.com/vm0-ai/vm0/commit/64403f63916b4d7efb2be46807fb8c5be7f17af9))
* **pi-memory:** add bounded stage1 worker ([#31217](https://github.com/vm0-ai/vm0/issues/31217)) ([8a2e79b](https://github.com/vm0-ai/vm0/commit/8a2e79bb7f8b82a766e39fcdffb880c2be3090d2))


### Bug Fixes

* **pi-memory:** preserve selection watermark semantics ([#31236](https://github.com/vm0-ai/vm0/issues/31236)) ([769a623](https://github.com/vm0-ai/vm0/commit/769a623f08e058881812d5b4fb11442417aea3b9))


### Refactoring

* **pi:** remove ownership transfer capability marker ([#31216](https://github.com/vm0-ai/vm0/issues/31216)) ([fb22db1](https://github.com/vm0-ai/vm0/commit/fb22db17eca15ebfcd5479388ff9a163be0ef500))


### Performance Improvements

* **api:** skip credit reads for external model admission ([#31225](https://github.com/vm0-ai/vm0/issues/31225)) ([c065434](https://github.com/vm0-ai/vm0/commit/c0654349d77038ff52def71ebb098e949969531d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.396.0
    * @okouai/core bumped to 8.611.3
    * @okouai/db bumped to 1.236.1
    * @okouai/pi-agent-runtime bumped to 1.13.0

## [1.532.0](https://github.com/vm0-ai/vm0/compare/api-v1.531.0...api-v1.532.0) (2026-09-02)


### Features

* **pi:** inject bounded memory summary recall ([#31203](https://github.com/vm0-ai/vm0/issues/31203)) ([e44155e](https://github.com/vm0-ai/vm0/commit/e44155e6786b92ca0ae13852cdab1d5817656ecd))
* **pi:** support custom responses gateways ([#31157](https://github.com/vm0-ai/vm0/issues/31157)) ([e8cd4db](https://github.com/vm0-ai/vm0/commit/e8cd4dba2e57c0258491859f2aedd66a7f5855e4))


### Bug Fixes

* **api:** preserve connector account on auth replay ([#31155](https://github.com/vm0-ai/vm0/issues/31155)) ([d645212](https://github.com/vm0-ai/vm0/commit/d6452122da2c1c3f45f5877e6de0df76d9c87f54)), closes [#31141](https://github.com/vm0-ai/vm0/issues/31141)
* **runner:** report authoritative provider failure reasons ([#31163](https://github.com/vm0-ai/vm0/issues/31163)) ([b84e233](https://github.com/vm0-ai/vm0/commit/b84e2334f9e370b59a299b00250fc037d90538dd))


### Refactoring

* **runtime:** remove retired API URL alias tombstones ([#31209](https://github.com/vm0-ai/vm0/issues/31209)) ([e57170e](https://github.com/vm0-ai/vm0/commit/e57170e30c73c68188ce035caba4176874e716c2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.395.0
    * @okouai/core bumped to 8.611.2
    * @okouai/db bumped to 1.236.0
    * @okouai/pi-agent-runtime bumped to 1.12.0

## [1.531.0](https://github.com/vm0-ai/vm0/compare/api-v1.530.0...api-v1.531.0) (2026-09-02)


### Features

* **api:** add Morning Brief default onboarding foundation ([#31183](https://github.com/vm0-ai/vm0/issues/31183)) ([2ca9dee](https://github.com/vm0-ai/vm0/commit/2ca9dee54342bc1556e1042b5a48ab8baee56923))
* **api:** resolve automatic mcp auth as none or oauth ([#31135](https://github.com/vm0-ai/vm0/issues/31135)) ([d84a7e0](https://github.com/vm0-ai/vm0/commit/d84a7e0cd556e91916858ea18cd5256efde6ed03))


### Refactoring

* **api:** rename model provider gateway runtime secret ([#31193](https://github.com/vm0-ai/vm0/issues/31193)) ([dfdbaf6](https://github.com/vm0-ai/vm0/commit/dfdbaf65f12ee9679403a6488efcf47c3e2f2729))


### Performance Improvements

* **api:** skip redundant drains for admitted goals ([#31171](https://github.com/vm0-ai/vm0/issues/31171)) ([bbb111a](https://github.com/vm0-ai/vm0/commit/bbb111ac83d53579633fc2f3826b34372b015b97))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.394.0
    * @okouai/core bumped to 8.611.1
    * @okouai/db bumped to 1.235.0
    * @okouai/pi-agent-runtime bumped to 1.11.1

## [1.530.0](https://github.com/vm0-ai/vm0/compare/api-v1.529.0...api-v1.530.0) (2026-09-02)


### Features

* **app:** add standalone worker previews ([#30987](https://github.com/vm0-ai/vm0/issues/30987)) ([7a4ce6a](https://github.com/vm0-ai/vm0/commit/7a4ce6ad45daa6c4cb823a9b7253340123dd98df))
* **memory:** materialize bounded summaries by storage version ([#31117](https://github.com/vm0-ai/vm0/issues/31117)) ([2cfd42a](https://github.com/vm0-ai/vm0/commit/2cfd42a36d3dcb947b30cea95cd05832316284a8))


### Bug Fixes

* **api:** converge connector account trigger lifecycle ([#31122](https://github.com/vm0-ai/vm0/issues/31122)) ([7a9b6ec](https://github.com/vm0-ai/vm0/commit/7a9b6ec42e36208e2837a38178123b15c278b301))
* **api:** self-heal renamed Calendar primary watches ([#31130](https://github.com/vm0-ai/vm0/issues/31130)) ([a2b06d6](https://github.com/vm0-ai/vm0/commit/a2b06d63a54309a504b8d8e60f688bab6e1b9374))
* **api:** stop logging echoed provider request input ([#31129](https://github.com/vm0-ai/vm0/issues/31129)) ([570bf61](https://github.com/vm0-ai/vm0/commit/570bf61917c79cdf2fe08b9c25fb1bccf654a4f1)), closes [#30960](https://github.com/vm0-ai/vm0/issues/30960)
* **api:** suppress repeated auth unavailability warnings ([#31128](https://github.com/vm0-ai/vm0/issues/31128)) ([03c37ce](https://github.com/vm0-ai/vm0/commit/03c37ce804316f1054202df724115d1b27d9de12))
* **github:** use branded official app callbacks ([#31109](https://github.com/vm0-ai/vm0/issues/31109)) ([bf8cdec](https://github.com/vm0-ai/vm0/commit/bf8cdec0c8016295208fae60bb63dd846c6f4f9d))
* project remaining public brand surfaces ([#31151](https://github.com/vm0-ai/vm0/issues/31151)) ([769b53e](https://github.com/vm0-ai/vm0/commit/769b53e654a275477750026201f55207dc13d839))
* **slack:** preserve dual-brand oauth domains ([#31063](https://github.com/vm0-ai/vm0/issues/31063)) ([54bce0d](https://github.com/vm0-ai/vm0/commit/54bce0db9fe56c579241c91c766ce4d428bc95de))
* **social:** file downloaded media by its actual container ([#30998](https://github.com/vm0-ai/vm0/issues/30998)) ([3752d3f](https://github.com/vm0-ai/vm0/commit/3752d3fea2e6f5dbd535693ad4346f58e943485a))


### Refactoring

* **api:** remove morning brief snapshot compatibility ([#31162](https://github.com/vm0-ai/vm0/issues/31162)) ([1f8a715](https://github.com/vm0-ai/vm0/commit/1f8a71577990f9b75bfe56760f63fb9285229ce2))
* **api:** remove terminal preview job-reference legacy reader ([#31168](https://github.com/vm0-ai/vm0/issues/31168)) ([e21b4f2](https://github.com/vm0-ai/vm0/commit/e21b4f2dd93fe797820f1ec09095db0e44487479))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.393.0
    * @okouai/core bumped to 8.611.0
    * @okouai/db bumped to 1.234.0

## [1.529.0](https://github.com/vm0-ai/vm0/compare/api-v1.528.0...api-v1.529.0) (2026-09-02)


### Features

* **api:** persist run failure reasons ([#31097](https://github.com/vm0-ai/vm0/issues/31097)) ([aa472b6](https://github.com/vm0-ai/vm0/commit/aa472b68528c7ab714f3f0bcf6c472475bfba2b0))
* **chat:** persist structured image annotations ([#31046](https://github.com/vm0-ai/vm0/issues/31046)) ([8e4b621](https://github.com/vm0-ai/vm0/commit/8e4b62131457161a5c9ceb7ec4003339a4b58eb5))
* **connectors:** route twelve ready oauth callbacks directly to okou ([#30562](https://github.com/vm0-ai/vm0/issues/30562)) ([78680f6](https://github.com/vm0-ai/vm0/commit/78680f6430bce28ec9ac1923dfcefdf551594364)), closes [#28381](https://github.com/vm0-ai/vm0/issues/28381)
* gate morning brief behind an independent switch ([#31110](https://github.com/vm0-ai/vm0/issues/31110)) ([2b69ef6](https://github.com/vm0-ai/vm0/commit/2b69ef6331471d09f88cae0548e6dd4ba15e4283))
* graduate custom connector no-auth ([#31075](https://github.com/vm0-ai/vm0/issues/31075)) ([5756edf](https://github.com/vm0-ai/vm0/commit/5756edf51498b88c6f06b0a43d02c7e632d6238c))
* **pi:** add feature-gated memory recall mount ([#31108](https://github.com/vm0-ai/vm0/issues/31108)) ([efe42ad](https://github.com/vm0-ai/vm0/commit/efe42ad75b466d70af92dc2db216435ac245c0f0))


### Bug Fixes

* **api:** deploy GitHub App slug cutover ([#31005](https://github.com/vm0-ai/vm0/issues/31005)) ([9c64bfb](https://github.com/vm0-ai/vm0/commit/9c64bfbe71a78ac16844e9f5df2e4d9462ef5c2f))
* **api:** use branded custom connector OAuth callbacks ([#31028](https://github.com/vm0-ai/vm0/issues/31028)) ([4546240](https://github.com/vm0-ai/vm0/commit/4546240924ce7db453f0fff19054da81eb09a8e0))
* **artifacts:** skip poster extraction for webm artifacts ([#30999](https://github.com/vm0-ai/vm0/issues/30999)) ([9a1348b](https://github.com/vm0-ai/vm0/commit/9a1348b56a75b3e259122df056d1894627447b0e))
* **feishu:** project oauth urls by public brand ([#31030](https://github.com/vm0-ai/vm0/issues/31030)) ([f6ce8bd](https://github.com/vm0-ai/vm0/commit/f6ce8bd0d6f8f4ab312a2340b716a035774d02ea))


### Refactoring

* **api:** drop the feishu events compatibility row ([#31069](https://github.com/vm0-ai/vm0/issues/31069)) ([dbce087](https://github.com/vm0-ai/vm0/commit/dbce0877440c3744fde0979b9af1ef9357594aed)), closes [#31068](https://github.com/vm0-ai/vm0/issues/31068)
* **api:** empty the branded compatibility table ([#31106](https://github.com/vm0-ai/vm0/issues/31106)) ([26e0aa1](https://github.com/vm0-ai/vm0/commit/26e0aa1a2872bc0fafccd0c3089466ea3653f7c5))
* **pi:** make ownership transfer v3-only ([#31045](https://github.com/vm0-ai/vm0/issues/31045)) ([1e99242](https://github.com/vm0-ai/vm0/commit/1e99242eabe418b4981216c0f6eb62e21edc015a))


### Performance Improvements

* **api:** attribute goal queue load phases ([#31077](https://github.com/vm0-ai/vm0/issues/31077)) ([24ba4ef](https://github.com/vm0-ai/vm0/commit/24ba4efc812f0da9237c461025e4aec6f0882f85))
* **api:** scope custom connector runtime sync catalog loads ([#31098](https://github.com/vm0-ai/vm0/issues/31098)) ([0de7c82](https://github.com/vm0-ai/vm0/commit/0de7c82df9b5a8cbebc494dcb7214c9c6d3da705))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.392.0
    * @okouai/connectors bumped to 3.3.0
    * @okouai/core bumped to 8.610.0
    * @okouai/db bumped to 1.233.0

## [1.528.0](https://github.com/vm0-ai/vm0/compare/api-v1.527.1...api-v1.528.0) (2026-09-02)


### Features

* add Claude Fable 5.1 support ([#30932](https://github.com/vm0-ai/vm0/issues/30932)) ([15f6717](https://github.com/vm0-ai/vm0/commit/15f6717327d927cc8bc61ff3af3cf17802aa4853))


### Bug Fixes

* **chat:** surface execution timeouts as recoverable ([#31014](https://github.com/vm0-ai/vm0/issues/31014)) ([97a794d](https://github.com/vm0-ai/vm0/commit/97a794d0dedcac24c2a7d3911a6cb85207964d16))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.391.0
    * @okouai/core bumped to 8.609.0
    * @okouai/db bumped to 1.232.0

## [1.527.1](https://github.com/vm0-ai/vm0/compare/api-v1.527.0...api-v1.527.1) (2026-09-02)


### Bug Fixes

* **api:** bind calendar triggers to thread account ([#30907](https://github.com/vm0-ai/vm0/issues/30907)) ([5fe9278](https://github.com/vm0-ai/vm0/commit/5fe92783e9dd836989628fd8c651f2c96bdce076))
* **platform:** make settings the only preferences surface ([#31039](https://github.com/vm0-ai/vm0/issues/31039)) ([1e2692c](https://github.com/vm0-ai/vm0/commit/1e2692cd5fd7173f3b691a180d4430bceab4ea6c))


### Refactoring

* remove workflow connector readiness ([#30996](https://github.com/vm0-ai/vm0/issues/30996)) ([94ec7af](https://github.com/vm0-ai/vm0/commit/94ec7afb7be4163a70f0f3fdea1d1c5579541c9b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.390.3
    * @okouai/core bumped to 8.608.3
    * @okouai/db bumped to 1.231.4

## [1.527.0](https://github.com/vm0-ai/vm0/compare/api-v1.526.2...api-v1.527.0) (2026-09-02)


### Features

* **pi:** align openrouter codex routes on responses api ([#31032](https://github.com/vm0-ai/vm0/issues/31032)) ([eff60e8](https://github.com/vm0-ai/vm0/commit/eff60e8be002ff2150fdd7da4281e5f5b10abe66))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.231.3
    * @okouai/pi-agent-runtime bumped to 1.11.0

## [1.526.2](https://github.com/vm0-ai/vm0/compare/api-v1.526.1...api-v1.526.2) (2026-09-02)


### Bug Fixes

* **api:** report no-auth connector accounts as connected ([#30972](https://github.com/vm0-ai/vm0/issues/30972)) ([dd4996f](https://github.com/vm0-ai/vm0/commit/dd4996f30ac06f0fa2b527a8837f78b09a944202))


### Refactoring

* remove Strapi integration feature switch ([#30965](https://github.com/vm0-ai/vm0/issues/30965)) ([603bbb7](https://github.com/vm0-ai/vm0/commit/603bbb7dafa7caa3619261d9b81047f96c763e38))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.390.2
    * @okouai/core bumped to 8.608.2
    * @okouai/db bumped to 1.231.2

## [1.526.1](https://github.com/vm0-ai/vm0/compare/api-v1.526.0...api-v1.526.1) (2026-09-02)


### Bug Fixes

* **api:** bind google meet triggers to selected account ([#30906](https://github.com/vm0-ai/vm0/issues/30906)) ([d567690](https://github.com/vm0-ai/vm0/commit/d567690ee7612f31b86e26657d1270d6ac099196))
* **api:** bound snapshot convergence ([#30929](https://github.com/vm0-ai/vm0/issues/30929)) ([8850bca](https://github.com/vm0-ai/vm0/commit/8850bca232d7c8f65ee29fc4e424c35116a348e8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.390.1
    * @okouai/core bumped to 8.608.1
    * @okouai/db bumped to 1.231.1

## [1.526.0](https://github.com/vm0-ai/vm0/compare/api-v1.525.6...api-v1.526.0) (2026-09-02)


### Features

* support no-auth custom connectors ([#30897](https://github.com/vm0-ai/vm0/issues/30897)) ([f6a4e7a](https://github.com/vm0-ai/vm0/commit/f6a4e7af74566f31c53c59035554aaf5f0c1076c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.390.0
    * @okouai/core bumped to 8.608.0
    * @okouai/db bumped to 1.231.0

## [1.525.6](https://github.com/vm0-ai/vm0/compare/api-v1.525.5...api-v1.525.6) (2026-09-02)


### Bug Fixes

* share attachments by their public artifacts url ([#30835](https://github.com/vm0-ai/vm0/issues/30835)) ([7aa3ac3](https://github.com/vm0-ai/vm0/commit/7aa3ac3843232909951bd81d1ee60bacf852a078))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.389.1
    * @okouai/core bumped to 8.607.1
    * @okouai/db bumped to 1.230.2

## [1.525.5](https://github.com/vm0-ai/vm0/compare/api-v1.525.4...api-v1.525.5) (2026-09-01)


### Bug Fixes

* **api:** repair direct morning brief snapshots ([#30919](https://github.com/vm0-ai/vm0/issues/30919)) ([0a202a6](https://github.com/vm0-ai/vm0/commit/0a202a6eb3f30ced777c942cbc785a3db87b7ff3))

## [1.525.4](https://github.com/vm0-ai/vm0/compare/api-v1.525.3...api-v1.525.4) (2026-09-01)


### Bug Fixes

* **api:** repair priority morning brief snapshot claims ([#30917](https://github.com/vm0-ai/vm0/issues/30917)) ([b21b3c6](https://github.com/vm0-ai/vm0/commit/b21b3c6571ca1d9a2d9b5f646257acd51da871d0))

## [1.525.3](https://github.com/vm0-ai/vm0/compare/api-v1.525.2...api-v1.525.3) (2026-09-01)


### Bug Fixes

* **api:** repair model-annotated legacy snapshots ([#30912](https://github.com/vm0-ai/vm0/issues/30912)) ([40e8aea](https://github.com/vm0-ai/vm0/commit/40e8aea0009937c60146f7caa7698cefcde95b43))

## [1.525.2](https://github.com/vm0-ai/vm0/compare/api-v1.525.1...api-v1.525.2) (2026-09-01)


### Bug Fixes

* **api:** repair retired morning brief snapshots ([#30909](https://github.com/vm0-ai/vm0/issues/30909)) ([8eb32b3](https://github.com/vm0-ai/vm0/commit/8eb32b3f050777150905808ecdde70aca45c7404))

## [1.525.1](https://github.com/vm0-ai/vm0/compare/api-v1.525.0...api-v1.525.1) (2026-09-01)


### Bug Fixes

* **api:** repair contextless legacy snapshots ([#30903](https://github.com/vm0-ai/vm0/issues/30903)) ([aa814d7](https://github.com/vm0-ai/vm0/commit/aa814d72263aa816bfdd43bce80508ea52540131))
* isolate google forms triggers by account ([#30798](https://github.com/vm0-ai/vm0/issues/30798)) ([2b74ba7](https://github.com/vm0-ai/vm0/commit/2b74ba7a6775fad0d8133165ee6e3e017d7ea770))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.230.1

## [1.525.0](https://github.com/vm0-ai/vm0/compare/api-v1.524.0...api-v1.525.0) (2026-09-01)


### Features

* **platform:** translate selected chat text ([#30818](https://github.com/vm0-ai/vm0/issues/30818)) ([37c2265](https://github.com/vm0-ai/vm0/commit/37c2265c1c600cbcc22b32224e376c5ae26cead3))
* use transparent avatar cutouts in the intro video picker ([#30873](https://github.com/vm0-ai/vm0/issues/30873)) ([b176b5b](https://github.com/vm0-ai/vm0/commit/b176b5b46f223dd26d44e976e2299ed3f5bbfa8c))


### Bug Fixes

* **api:** bind notion automations to workflow accounts ([#30854](https://github.com/vm0-ai/vm0/issues/30854)) ([93b2fb7](https://github.com/vm0-ai/vm0/commit/93b2fb776be6b6e4dedb18ee98f6bd2351ab0b4c))
* **api:** clean up unused google meet subscriptions ([#30874](https://github.com/vm0-ai/vm0/issues/30874)) ([c51ab2b](https://github.com/vm0-ai/vm0/commit/c51ab2b08ed8f2515bd6d77e93bcc98821f84b6d))
* **api:** reject reordered legacy snapshot chains ([#30895](https://github.com/vm0-ai/vm0/issues/30895)) ([5f1496c](https://github.com/vm0-ai/vm0/commit/5f1496c724382c7979070c31b9fc8624c609f178))


### Performance Improvements

* **guest-agent:** expose control-path scheduling metrics ([#30890](https://github.com/vm0-ai/vm0/issues/30890)) ([1e7a196](https://github.com/vm0-ai/vm0/commit/1e7a1966f15351fb5f8019ebd29c2ee5ad2b4f96))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.389.0
    * @okouai/core bumped to 8.607.0
    * @okouai/db bumped to 1.230.0

## [1.524.0](https://github.com/vm0-ai/vm0/compare/api-v1.523.0...api-v1.524.0) (2026-09-01)


### Features

* **connectors:** route github oauth callback directly to okou ([#30870](https://github.com/vm0-ai/vm0/issues/30870)) ([1afb5b8](https://github.com/vm0-ai/vm0/commit/1afb5b8246d5b19d6f6eb1c9aa65ee5cf81edb0d)), closes [#30867](https://github.com/vm0-ai/vm0/issues/30867)
* support automatic oauth for mcp connectors ([#30858](https://github.com/vm0-ai/vm0/issues/30858)) ([716e3b0](https://github.com/vm0-ai/vm0/commit/716e3b08c1d41a12f0686bb0363343650d194d89))


### Bug Fixes

* **api:** use workflow account for connector readiness ([#30853](https://github.com/vm0-ai/vm0/issues/30853)) ([1996ef4](https://github.com/vm0-ai/vm0/commit/1996ef4b0589eb6c7f7e3564be552348810c94f0))


### Refactoring

* **api:** remove unused connector endpoints ([#30848](https://github.com/vm0-ai/vm0/issues/30848)) ([e47044b](https://github.com/vm0-ai/vm0/commit/e47044b558f264448ed1793012e3e6ad63b8d8a8))
* remove built-in fallback rollout state ([#30876](https://github.com/vm0-ai/vm0/issues/30876)) ([ddab7f4](https://github.com/vm0-ai/vm0/commit/ddab7f4cf55cead3540347247d2ea0b0f156c01b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.388.0
    * @okouai/connectors bumped to 3.2.0
    * @okouai/core bumped to 8.606.1
    * @okouai/db bumped to 1.229.5

## [1.523.0](https://github.com/vm0-ai/vm0/compare/api-v1.522.2...api-v1.523.0) (2026-09-01)


### Features

* graduate built-in model provider fallback ([#30861](https://github.com/vm0-ai/vm0/issues/30861)) ([be446a6](https://github.com/vm0-ai/vm0/commit/be446a6678a6fe32d6df9788b2b17550ebddd8b4))


### Bug Fixes

* **api:** keep a committed delete successful when storage cleanup fails ([#30863](https://github.com/vm0-ai/vm0/issues/30863)) ([c256e81](https://github.com/vm0-ai/vm0/commit/c256e81be0509cab6a42872b5be44958cf6f0e91))
* **mail:** use thread gmail account for draft handoff ([#30846](https://github.com/vm0-ai/vm0/issues/30846)) ([99e2b42](https://github.com/vm0-ai/vm0/commit/99e2b42770617c62b57787973131d1002f0ebbbf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.387.0
    * @okouai/core bumped to 8.606.0
    * @okouai/db bumped to 1.229.4

## [1.522.2](https://github.com/vm0-ai/vm0/compare/api-v1.522.1...api-v1.522.2) (2026-09-01)


### Bug Fixes

* **official-workflows:** restore catalog schema cutovers ([#30834](https://github.com/vm0-ai/vm0/issues/30834)) ([4dc5580](https://github.com/vm0-ai/vm0/commit/4dc55802b7a9941a34515d48e81965f9975c6663))
* **social:** normalize TikTok collection semantics ([#30838](https://github.com/vm0-ai/vm0/issues/30838)) ([5720a7a](https://github.com/vm0-ai/vm0/commit/5720a7a38766172840802151fef77e73111d5d14))


### Refactoring

* **api:** drop the web and cli driven compatibility rows ([#30817](https://github.com/vm0-ai/vm0/issues/30817)) ([aa1276f](https://github.com/vm0-ai/vm0/commit/aa1276f5951bb83449286bbc83381355aa3ba692))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.386.1
    * @okouai/core bumped to 8.605.10
    * @okouai/db bumped to 1.229.3

## [1.522.1](https://github.com/vm0-ai/vm0/compare/api-v1.522.0...api-v1.522.1) (2026-09-01)


### Bug Fixes

* **api:** repair chained legacy snapshot revocations ([#30808](https://github.com/vm0-ai/vm0/issues/30808)) ([5458a54](https://github.com/vm0-ai/vm0/commit/5458a54c86bbb10b16db73cdd91d76585b6cc7ec))
* scope connector doctor to its host agent ([#30809](https://github.com/vm0-ai/vm0/issues/30809)) ([61495a2](https://github.com/vm0-ai/vm0/commit/61495a251cd71be80dc05d4438f24f85ae3bda15))


### Refactoring

* **api:** drop the computer-use and feature-switch compatibility rows ([#30814](https://github.com/vm0-ai/vm0/issues/30814)) ([07296e0](https://github.com/vm0-ai/vm0/commit/07296e0bf4bcc1d68f6695f3210440f346658df5)), closes [#30804](https://github.com/vm0-ai/vm0/issues/30804)
* **api:** drop the teams callback and slack connect compatibility rows ([#30821](https://github.com/vm0-ai/vm0/issues/30821)) ([60bad02](https://github.com/vm0-ai/vm0/commit/60bad025e87ad5fc048e3a579f13277d44a38e74)), closes [#30812](https://github.com/vm0-ai/vm0/issues/30812)

## [1.522.0](https://github.com/vm0-ai/vm0/compare/api-v1.521.0...api-v1.522.0) (2026-09-01)


### Features

* manage morning brief from preferences ([#30805](https://github.com/vm0-ai/vm0/issues/30805)) ([a95ce9e](https://github.com/vm0-ai/vm0/commit/a95ce9ec44cb77f06e05cd99c28f052ddcd6cff5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.386.0
    * @okouai/core bumped to 8.605.9
    * @okouai/db bumped to 1.229.2

## [1.521.0](https://github.com/vm0-ai/vm0/compare/api-v1.520.1...api-v1.521.0) (2026-09-01)


### Features

* **pi:** activate fast terra with exact billing ([#30781](https://github.com/vm0-ai/vm0/issues/30781)) ([f02a413](https://github.com/vm0-ai/vm0/commit/f02a4136c89233e98797f64e57455b7d3ae13bf4))

## [1.520.1](https://github.com/vm0-ai/vm0/compare/api-v1.520.0...api-v1.520.1) (2026-09-01)


### Bug Fixes

* **social:** make transcript errors truthful and provider-neutral ([#30732](https://github.com/vm0-ai/vm0/issues/30732)) ([f3c3e3d](https://github.com/vm0-ai/vm0/commit/f3c3e3daa7e4ccbb215a769fa5fb37489c325993))


### Performance Improvements

* **api:** attribute goal model-context latency ([#30773](https://github.com/vm0-ai/vm0/issues/30773)) ([d61595f](https://github.com/vm0-ai/vm0/commit/d61595f4cc014f96421f24f17b4e461bb5be1859))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.385.1
    * @okouai/core bumped to 8.605.8
    * @okouai/db bumped to 1.229.1

## [1.520.0](https://github.com/vm0-ai/vm0/compare/api-v1.519.4...api-v1.520.0) (2026-09-01)


### Features

* **api:** model automatic oauth for mcp connectors ([#30636](https://github.com/vm0-ai/vm0/issues/30636)) ([b33d6c2](https://github.com/vm0-ai/vm0/commit/b33d6c26e6df23aad23f9460124a203b11309a36))
* request connector account switches in chat ([#30602](https://github.com/vm0-ai/vm0/issues/30602)) ([4108626](https://github.com/vm0-ai/vm0/commit/4108626240e47072c6eeb3658a12fff649a57f87))


### Bug Fixes

* **api:** repair legacy snapshot revocation rows ([#30754](https://github.com/vm0-ai/vm0/issues/30754)) ([027642e](https://github.com/vm0-ai/vm0/commit/027642e96bb07f4290e8de1c2cd13b46219f6018))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.385.0
    * @okouai/core bumped to 8.605.7
    * @okouai/db bumped to 1.229.0

## [1.519.4](https://github.com/vm0-ai/vm0/compare/api-v1.519.3...api-v1.519.4) (2026-09-01)


### Refactoring

* **runtime:** require canonical platform environment ([#30728](https://github.com/vm0-ai/vm0/issues/30728)) ([aaf4999](https://github.com/vm0-ai/vm0/commit/aaf49990f7b94eca4615242555bbf131986373cb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.384.3
    * @okouai/core bumped to 8.605.6
    * @okouai/db bumped to 1.228.31
    * @okouai/pi-agent-runtime bumped to 1.10.0

## [1.519.3](https://github.com/vm0-ai/vm0/compare/api-v1.519.2...api-v1.519.3) (2026-09-01)


### Bug Fixes

* **email:** enforce Okou branding for product mail ([#30427](https://github.com/vm0-ai/vm0/issues/30427)) ([50b5a80](https://github.com/vm0-ai/vm0/commit/50b5a80ebefbb1c525ecdb12a0bdbf3bc481bfa4))
* repair stale Morning Brief chat snapshots ([#30716](https://github.com/vm0-ai/vm0/issues/30716)) ([d458669](https://github.com/vm0-ai/vm0/commit/d458669d7f3ba92c746947fe28787cc498a64100))
* **social:** report provider-limited collection pages ([#30704](https://github.com/vm0-ai/vm0/issues/30704)) ([2ad3efe](https://github.com/vm0-ai/vm0/commit/2ad3efe0a379aa42375041a971213c408c496c5b))


### Refactoring

* **api:** drop the console-driven slack compatibility rows ([#30688](https://github.com/vm0-ai/vm0/issues/30688)) ([085ed59](https://github.com/vm0-ai/vm0/commit/085ed5907f9c30867b4506cd1065e89f39000677))
* **db:** contract legacy vm0 provider compatibility ([#30708](https://github.com/vm0-ai/vm0/issues/30708)) ([7ab758f](https://github.com/vm0-ai/vm0/commit/7ab758fea24f304dd1bdd25ca7a24457e20419e8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.384.2
    * @okouai/core bumped to 8.605.5
    * @okouai/db bumped to 1.228.30

## [1.519.2](https://github.com/vm0-ai/vm0/compare/api-v1.519.1...api-v1.519.2) (2026-09-01)


### Bug Fixes

* **cli:** diagnose effective visible workflows ([#30696](https://github.com/vm0-ai/vm0/issues/30696)) ([af34735](https://github.com/vm0-ai/vm0/commit/af3473581a3c7a7eed432684f2c2ac206e6f0dda))
* **email:** link official workflow result footer to automation ([#30591](https://github.com/vm0-ai/vm0/issues/30591)) ([0e556c4](https://github.com/vm0-ai/vm0/commit/0e556c4e81749a8e4718f4ccbe1a2f151068c9f5))


### Refactoring

* **api:** unify the teams oauth callback and delete the legacy zero path map ([#30673](https://github.com/vm0-ai/vm0/issues/30673)) ([97bdd0c](https://github.com/vm0-ai/vm0/commit/97bdd0c0e5d2f36549e1c40d7bf11952eb02c8ba)), closes [#30667](https://github.com/vm0-ai/vm0/issues/30667)

## [1.519.1](https://github.com/vm0-ai/vm0/compare/api-v1.519.0...api-v1.519.1) (2026-09-01)


### Bug Fixes

* **pi:** keep one eligibility snapshot ([#30658](https://github.com/vm0-ai/vm0/issues/30658)) ([81b4bb3](https://github.com/vm0-ai/vm0/commit/81b4bb379d5e55eaaca473232ab486a339d12374))
