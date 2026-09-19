# Changelog

Releases before September 2026 are archived by month:

- [2026-08](changelog/2026-08/CHANGELOG.md)
- [2026-07](changelog/2026-07/CHANGELOG.md)
- [2026-06](changelog/2026-06/CHANGELOG.md)
- [2026-05](changelog/2026-05/CHANGELOG.md)
- [2026-04](changelog/2026-04/CHANGELOG.md)
- [2026-03](changelog/2026-03/CHANGELOG.md)
- [2026-02](changelog/2026-02/CHANGELOG.md)
- [2026-01](changelog/2026-01/CHANGELOG.md)

## [0.923.0](https://github.com/vm0-ai/okou/compare/app-v0.922.0...app-v0.923.0) (2026-09-19)


### Features

* **api-contracts:** add gpt-6-sol run model ([#35391](https://github.com/vm0-ai/okou/issues/35391)) ([a1f2db4](https://github.com/vm0-ai/okou/commit/a1f2db4d50af3a79a6212f478c447b3d8ac6c6f9))
* **connectors:** add builtin mcp automatic authentication ([#35241](https://github.com/vm0-ai/okou/issues/35241)) ([095cfe8](https://github.com/vm0-ai/okou/commit/095cfe801e2b69165c0c33b1e36d42990b88b812))


### Bug Fixes

* **platform:** align vnc credential creation with ssh ([#35404](https://github.com/vm0-ai/okou/issues/35404)) ([e4607ee](https://github.com/vm0-ai/okou/commit/e4607ee6c49ee9bb74976f277e669097c666e575))
* **platform:** expose ssh discovery load recovery ([#35405](https://github.com/vm0-ai/okou/issues/35405)) ([ab6b3ff](https://github.com/vm0-ai/okou/commit/ab6b3ffb9dd82fd9e0b1dba81d58b08b859fe50d))
* **platform:** filter shared SSH access ([#35399](https://github.com/vm0-ai/okou/issues/35399)) ([c937583](https://github.com/vm0-ai/okou/commit/c9375839102071d35458e069412b22cc515d612b))
* **platform:** host oauth consent in the app ([#35410](https://github.com/vm0-ai/okou/issues/35410)) ([5035dc2](https://github.com/vm0-ai/okou/commit/5035dc21ac39e9def104119894bef7e6a5bee029))
* **platform:** recover ssh access after agent failures ([#35406](https://github.com/vm0-ai/okou/issues/35406)) ([9c08326](https://github.com/vm0-ai/okou/commit/9c08326ab0db46d3c33ed7cb54f7e052a5ca8807))
* **platform:** wait for the error recovery classification before offering it ([#35390](https://github.com/vm0-ai/okou/issues/35390)) ([47adc45](https://github.com/vm0-ai/okou/commit/47adc4557a6eb53fc10492a1fc4239c9666a7026))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.476.0
    * @okouai/connectors bumped to 3.14.0
    * @okouai/core bumped to 8.684.0
    * @okouai/ui bumped to 1.10.1

## [0.922.0](https://github.com/vm0-ai/okou/compare/app-v0.921.0...app-v0.922.0) (2026-09-19)


### Features

* move paid tools into chat settings ([#35381](https://github.com/vm0-ai/okou/issues/35381)) ([3ac2ba5](https://github.com/vm0-ai/okou/commit/3ac2ba574a056d26870db201d0d88dceccba6028))
* **platform:** add vnc settings and agent authorization ([#35310](https://github.com/vm0-ai/okou/issues/35310)) ([edf492a](https://github.com/vm0-ai/okou/commit/edf492aca6f667d87070511c1837ee3dc5c72145))
* **platform:** explain a get started quest before handing it off ([#35259](https://github.com/vm0-ai/okou/issues/35259)) ([0fe450b](https://github.com/vm0-ai/okou/commit/0fe450b6a61c244996b23573209f43c119bda89b))
* **platform:** spin beside user messages the server has not confirmed ([#35367](https://github.com/vm0-ai/okou/issues/35367)) ([0bb026f](https://github.com/vm0-ai/okou/commit/0bb026f1dbbb2cf76c39b4db38e2b2e750525826))
* **platform:** split github automations into their own picker category ([#35376](https://github.com/vm0-ai/okou/issues/35376)) ([0b960b4](https://github.com/vm0-ai/okou/commit/0b960b4d1b41a26c27516061eb0393ef850afff2))


### Bug Fixes

* **app:** size the composer's controls against the composer, not the window ([#35354](https://github.com/vm0-ai/okou/issues/35354)) ([0f2aaf0](https://github.com/vm0-ai/okou/commit/0f2aaf097d5d33b3bcc9dfe791de57c0c150aca9))
* **connectors:** complete mercury oauth compliance flow ([#35346](https://github.com/vm0-ai/okou/issues/35346)) ([ebbffbf](https://github.com/vm0-ai/okou/commit/ebbffbfad2da6af02b2ead54a0ff00a7f1ebda49))
* **platform:** filter expected Clerk WebAuthn rejections ([#35351](https://github.com/vm0-ai/okou/issues/35351)) ([fc6e4f2](https://github.com/vm0-ai/okou/commit/fc6e4f2d391687ca81f3c54d03d2c33fe489bcf9))
* **platform:** show every activity model route field ([#35379](https://github.com/vm0-ai/okou/issues/35379)) ([0da9f46](https://github.com/vm0-ai/okou/commit/0da9f463cc49d19db1e07f86ef2d7dfb7e8b5e21))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.475.0
    * @okouai/core bumped to 8.683.0

## [0.921.0](https://github.com/vm0-ai/okou/compare/app-v0.920.2...app-v0.921.0) (2026-09-18)


### Features

* **app:** align the 404 page with the marketing site ([#35314](https://github.com/vm0-ai/okou/issues/35314)) ([b6eee68](https://github.com/vm0-ai/okou/commit/b6eee68182edac78461ffe94a28b7c7ee5a9fdd0))


### Bug Fixes

* persist complete private artifact urls ([#35318](https://github.com/vm0-ai/okou/issues/35318)) ([40ba5df](https://github.com/vm0-ai/okou/commit/40ba5dfa253b8d5f3815f920d423e9452fbb4694))
* **platform:** place fullscreen action last ([#35302](https://github.com/vm0-ai/okou/issues/35302)) ([82024dd](https://github.com/vm0-ai/okou/commit/82024dd70a8cb2985d9e506ba605ff92afad4e57))
* remove artifact share save status copy ([#35306](https://github.com/vm0-ai/okou/issues/35306)) ([29fc6a0](https://github.com/vm0-ai/okou/commit/29fc6a0c7965ce5e59eed00cfc2fb7e4520032d5))
* remove retired video rendering paid-tool control ([#35334](https://github.com/vm0-ai/okou/issues/35334)) ([53fc6ab](https://github.com/vm0-ai/okou/commit/53fc6ab900151e2a67ecf260c98c41327ddf9940))
* say what the custom template import produces instead of listing extensions ([#35296](https://github.com/vm0-ai/okou/issues/35296)) ([94514a5](https://github.com/vm0-ai/okou/commit/94514a5445777cbdff510f4dffbc5afa98aa07d2))


### Refactoring

* remove expired deployment compatibility ([#35345](https://github.com/vm0-ai/okou/issues/35345)) ([7425652](https://github.com/vm0-ai/okou/commit/7425652d84818a4c4fddca24ce68faeb08bb7b06))
* remove the intro video product ([#35196](https://github.com/vm0-ai/okou/issues/35196)) ([75fccd3](https://github.com/vm0-ai/okou/commit/75fccd328813fd9e2b8b27b1075053b13ae7be50))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.474.0
    * @okouai/core bumped to 8.682.0

## [0.920.2](https://github.com/vm0-ai/okou/compare/app-v0.920.1...app-v0.920.2) (2026-09-18)


### Refactoring

* retire hosted version controls and audit historical publications ([#35281](https://github.com/vm0-ai/okou/issues/35281)) ([a8fed1e](https://github.com/vm0-ai/okou/commit/a8fed1e3bf69e3ab7133db0f6d08ada0419f42fb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.473.1
    * @okouai/core bumped to 8.681.4

## [0.920.1](https://github.com/vm0-ai/okou/compare/app-v0.920.0...app-v0.920.1) (2026-09-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.473.0
    * @okouai/core bumped to 8.681.3

## [0.920.0](https://github.com/vm0-ai/okou/compare/app-v0.919.0...app-v0.920.0) (2026-09-18)


### Features

* extend personal paid-tool controls to media generation ([#35264](https://github.com/vm0-ai/okou/issues/35264)) ([a686e46](https://github.com/vm0-ai/okou/commit/a686e46b0f2a149b0519582e066ec2d752f798de))
* **platform:** add fullscreen controls to the artifact viewer ([#35255](https://github.com/vm0-ai/okou/issues/35255)) ([2656106](https://github.com/vm0-ai/okou/commit/26561066a1ff0ae90cc69ea4e3c13ac2c2c673f8))
* publish immutable sites and reuse private previews ([#35244](https://github.com/vm0-ai/okou/issues/35244)) ([899075c](https://github.com/vm0-ai/okou/commit/899075caeca519ac9202fa17bc9177e18258a58c))


### Refactoring

* remove _fastModel feature switch ([#35221](https://github.com/vm0-ai/okou/issues/35221)) ([132088c](https://github.com/vm0-ai/okou/commit/132088c059db14747a82313b1f7a842ca63dd55e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.472.0
    * @okouai/core bumped to 8.681.2

## [0.919.0](https://github.com/vm0-ai/okou/compare/app-v0.918.0...app-v0.919.0) (2026-09-18)


### Features

* **templates:** offer image sources in the custom template picker ([#35258](https://github.com/vm0-ai/okou/issues/35258)) ([83dbdf0](https://github.com/vm0-ai/okou/commit/83dbdf0e9850e6c3a8d4e56a09e42ab67dded603))


### Refactoring

* remove the model picker flyout feature switch ([#35191](https://github.com/vm0-ai/okou/issues/35191)) ([4ef1c13](https://github.com/vm0-ai/okou/commit/4ef1c138fd7a337026383435491707e0392adeed))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.471.0
    * @okouai/core bumped to 8.681.1

## [0.918.0](https://github.com/vm0-ai/okou/compare/app-v0.917.1...app-v0.918.0) (2026-09-18)


### Features

* **app:** retire legacy advertising and attribution storage ([#35246](https://github.com/vm0-ai/okou/issues/35246)) ([4a9ca58](https://github.com/vm0-ai/okou/commit/4a9ca58c930903cb1fbf5cccf6c67d95610bc9c6))
* **templates:** add the illustration kind to custom templates ([#35248](https://github.com/vm0-ai/okou/issues/35248)) ([ebd7039](https://github.com/vm0-ai/okou/commit/ebd70395f808ff7bd21ddc453789c76d712d7fe6))


### Refactoring

* remove effort feature switch ([#35189](https://github.com/vm0-ai/okou/issues/35189)) ([9b0dff2](https://github.com/vm0-ai/okou/commit/9b0dff2c1cc1c4f8a2a10d4cbfb7fea263585bfe))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.470.0
    * @okouai/core bumped to 8.681.0

## [0.917.1](https://github.com/vm0-ai/okou/compare/app-v0.917.0...app-v0.917.1) (2026-09-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.469.1
    * @okouai/core bumped to 8.680.6

## [0.917.0](https://github.com/vm0-ai/okou/compare/app-v0.916.0...app-v0.917.0) (2026-09-18)


### Features

* **platform:** drop video from the slash panel and the task chips ([#35192](https://github.com/vm0-ai/okou/issues/35192)) ([5db7365](https://github.com/vm0-ai/okou/commit/5db7365a036798df6f7d7b9ea0ee7ee2e0cd5921))


### Bug Fixes

* resolve shared thread artifacts through full app references ([#35206](https://github.com/vm0-ai/okou/issues/35206)) ([afe3553](https://github.com/vm0-ai/okou/commit/afe355360b5c12e71446f3358fdf61f21f776de7))


### Refactoring

* remove custom connector mcp feature switch ([#35202](https://github.com/vm0-ai/okou/issues/35202)) ([2a24579](https://github.com/vm0-ai/okou/commit/2a24579fecd98b9933a2c75589d4502e7af0a298))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.469.0
    * @okouai/core bumped to 8.680.5

## [0.916.0](https://github.com/vm0-ai/okou/compare/app-v0.915.2...app-v0.916.0) (2026-09-18)


### Features

* **connectors:** execute builtin mcp through unified connector flows ([#35132](https://github.com/vm0-ai/okou/issues/35132)) ([fc30ccb](https://github.com/vm0-ai/okou/commit/fc30ccb62f1ee00b66379aa4dcf3dc3f97df1763))


### Bug Fixes

* **platform:** refresh native delivery read state ([#35179](https://github.com/vm0-ai/okou/issues/35179)) ([09999f9](https://github.com/vm0-ai/okou/commit/09999f93b4aab05b3f247a37b0602ee05ecb6dd1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.468.0
    * @okouai/connectors bumped to 3.13.0
    * @okouai/core bumped to 8.680.4

## [0.915.2](https://github.com/vm0-ai/okou/compare/app-v0.915.1...app-v0.915.2) (2026-09-18)


### Bug Fixes

* **app:** copy thread share link and show toast on creation ([#35175](https://github.com/vm0-ai/okou/issues/35175)) ([4ed16f2](https://github.com/vm0-ai/okou/commit/4ed16f2043dd6948ad86531e4f88a499a49f22ef))
* use the refreshed quick start deck in welcome threads ([#35181](https://github.com/vm0-ai/okou/issues/35181)) ([9065172](https://github.com/vm0-ai/okou/commit/9065172e555179e161d907cd9af4a6cc5e4feff0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.467.0
    * @okouai/core bumped to 8.680.3

## [0.915.1](https://github.com/vm0-ai/okou/compare/app-v0.915.0...app-v0.915.1) (2026-09-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.466.0
    * @okouai/core bumped to 8.680.2

## [0.915.0](https://github.com/vm0-ai/okou/compare/app-v0.914.1...app-v0.915.0) (2026-09-18)


### Features

* **templates:** preview a custom document template's source file ([#35031](https://github.com/vm0-ai/okou/issues/35031)) ([826b8d1](https://github.com/vm0-ai/okou/commit/826b8d1766fa5d97728ab1c776a6ade1e373d587))


### Bug Fixes

* log sandbox rootfs exhaustion at info ([#35141](https://github.com/vm0-ai/okou/issues/35141)) ([e015f06](https://github.com/vm0-ai/okou/commit/e015f0643c9d33d6ddb144b233845734bde075f5))
* **ssh:** mention file import in the private key hint ([#35142](https://github.com/vm0-ai/okou/issues/35142)) ([279e9a5](https://github.com/vm0-ai/okou/commit/279e9a5a0f1ac7f0beee86d11d5fad25df3567ff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.465.0
    * @okouai/core bumped to 8.680.1

## [0.914.1](https://github.com/vm0-ai/okou/compare/app-v0.914.0...app-v0.914.1) (2026-09-18)


### Bug Fixes

* **app:** keep archived current chat visible ([#35103](https://github.com/vm0-ai/okou/issues/35103)) ([8bcc69d](https://github.com/vm0-ai/okou/commit/8bcc69d9e52cb8ea2f9012002a23c39426a61cb9))


### Refactoring

* remove team usage breakdown feature switch ([#35098](https://github.com/vm0-ai/okou/issues/35098)) ([4939996](https://github.com/vm0-ai/okou/commit/49399969ea1bcc428000cfced32effa669ce74cf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.464.0
    * @okouai/core bumped to 8.680.0

## [0.914.0](https://github.com/vm0-ai/okou/compare/app-v0.913.0...app-v0.914.0) (2026-09-18)


### Features

* **connectors:** consume published v4 catalog for builtin mcp ([#34992](https://github.com/vm0-ai/okou/issues/34992)) ([3e2d169](https://github.com/vm0-ai/okou/commit/3e2d16947b51e3931cb07d31d332418e17230468))
* **mcp:** add oauth-authorized http entry and indicators ([#34954](https://github.com/vm0-ai/okou/issues/34954)) ([7999ce4](https://github.com/vm0-ai/okou/commit/7999ce41c17d7544b0f1da457d840fb2f0505b54))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.463.0
    * @okouai/connectors bumped to 3.12.0
    * @okouai/core bumped to 8.679.0

## [0.913.0](https://github.com/vm0-ai/okou/compare/app-v0.912.0...app-v0.913.0) (2026-09-17)


### Features

* **billing:** group usage by thread and show member breakdowns ([#35082](https://github.com/vm0-ai/okou/issues/35082)) ([6b7e3ae](https://github.com/vm0-ai/okou/commit/6b7e3ae71559d4c2ba8552c1fdb650054e4b41f6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.462.0
    * @okouai/core bumped to 8.678.0

## [0.912.0](https://github.com/vm0-ai/okou/compare/app-v0.911.3...app-v0.912.0) (2026-09-17)


### Features

* **app:** add chat thread archiving ([#35081](https://github.com/vm0-ai/okou/issues/35081)) ([c2c9e70](https://github.com/vm0-ai/okou/commit/c2c9e70124bf9457e69130566ab70d2e00cc06e5))


### Documentation

* **platform:** remove misleading source map comment ([#35085](https://github.com/vm0-ai/okou/issues/35085)) ([6e1b552](https://github.com/vm0-ai/okou/commit/6e1b552fddbbbe640f25d1fbfddff94b4fea0b15))


### Refactoring

* remove expired deployment compatibility ([#35084](https://github.com/vm0-ai/okou/issues/35084)) ([e94de40](https://github.com/vm0-ai/okou/commit/e94de408bfeaf7c5d21c5d3aa5de5f13908b1ea7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.461.1
    * @okouai/core bumped to 8.677.0

## [0.911.3](https://github.com/vm0-ai/okou/compare/app-v0.911.2...app-v0.911.3) (2026-09-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.461.0
    * @okouai/core bumped to 8.676.3

## [0.911.2](https://github.com/vm0-ai/okou/compare/app-v0.911.1...app-v0.911.2) (2026-09-17)


### Bug Fixes

* **app:** keep the failure card element across recovery ([#35037](https://github.com/vm0-ai/okou/issues/35037)) ([7f85682](https://github.com/vm0-ai/okou/commit/7f85682cd417308ba28397eba6b291e50cf1cb05))
* **platform:** stop overlapping template title saves on both picker surfaces ([#35007](https://github.com/vm0-ai/okou/issues/35007)) ([df90baa](https://github.com/vm0-ai/okou/commit/df90baa7b418eb4c64a5bc4026c6743c2a2242f3))
* retire gpt 5.5 from run models ([#34450](https://github.com/vm0-ai/okou/issues/34450)) ([d68750c](https://github.com/vm0-ai/okou/commit/d68750c8cfea642e0c94ab547ec1c683ecbab41e))


### Refactoring

* **platform:** remove marketing handoff diagnostics ([#35035](https://github.com/vm0-ai/okou/issues/35035)) ([e6f5875](https://github.com/vm0-ai/okou/commit/e6f5875c0bc785b36f919d37d8d4e080a68d4e27))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.460.0
    * @okouai/core bumped to 8.676.2

## [0.911.1](https://github.com/vm0-ai/okou/compare/app-v0.911.0...app-v0.911.1) (2026-09-17)


### Performance Improvements

* **platform:** skip the shelf layout a filtered catalog discards ([#35003](https://github.com/vm0-ai/okou/issues/35003)) ([bcc021f](https://github.com/vm0-ai/okou/commit/bcc021f782af496a10365e8b15fb01d959e7e07d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.459.0
    * @okouai/core bumped to 8.676.1

## [0.911.0](https://github.com/vm0-ai/okou/compare/app-v0.910.0...app-v0.911.0) (2026-09-17)


### Features

* **app:** give intro video styles the shared gallery tile ([#34905](https://github.com/vm0-ai/okou/issues/34905)) ([9935c55](https://github.com/vm0-ai/okou/commit/9935c553d4cd81b166f651e17c4e9923521c849f))
* **core:** enable the composer run controls and model picker flyout by default ([#34971](https://github.com/vm0-ai/okou/issues/34971)) ([7401411](https://github.com/vm0-ai/okou/commit/740141186365eec6d7fc5ac09cb4f4569313e60c))
* **core:** enable thread activity summaries for all users ([#34923](https://github.com/vm0-ai/okou/issues/34923)) ([4cd1b9a](https://github.com/vm0-ai/okou/commit/4cd1b9a0594a9b53c05c48f10d1ac343e6b1702b))
* make a custom template usable, not just publishable ([#34886](https://github.com/vm0-ai/okou/issues/34886)) ([f43f666](https://github.com/vm0-ai/okou/commit/f43f666c5fd1e0e83b9fc76906cd5b668aec1225))
* **platform:** add input hints to ssh configuration forms ([#34907](https://github.com/vm0-ai/okou/issues/34907)) ([c9102a1](https://github.com/vm0-ai/okou/commit/c9102a1378be00812be25b3ca4fac5ca3c93e519))
* **platform:** open the workflow task from the create workflow row ([#34969](https://github.com/vm0-ai/okou/issues/34969)) ([7040618](https://github.com/vm0-ai/okou/commit/7040618a8bff509dd75b8b1b6db3f009bd439d6e))
* **platform:** rebuild the intro video picker around one style gallery ([#34984](https://github.com/vm0-ai/okou/issues/34984)) ([a79e898](https://github.com/vm0-ai/okou/commit/a79e89827f4e1f78b0676ad4318cfb202d5e6e35))
* record onboarding and checkout starts in marketing ([#34944](https://github.com/vm0-ai/okou/issues/34944)) ([55f2137](https://github.com/vm0-ai/okou/commit/55f2137d24a2699adcbf847c6632528b58f36be3))
* reorder presentation templates newest first ([#34959](https://github.com/vm0-ai/okou/issues/34959)) ([bbf2ad6](https://github.com/vm0-ai/okou/commit/bbf2ad6c60092246d426cfba84927e2da32938ae))
* **ssh:** graduate access and remove the rollout switch ([#34967](https://github.com/vm0-ai/okou/issues/34967)) ([e2b3915](https://github.com/vm0-ai/okou/commit/e2b391588615f01f1bc5e5ff8239fbf5abf765bd))


### Bug Fixes

* add missing integration source links ([#34950](https://github.com/vm0-ai/okou/issues/34950)) ([5b2c750](https://github.com/vm0-ai/okou/commit/5b2c750697dffcc1da382a0ce7f6ee59005d0219))
* **platform:** allow cancelling pending connector authorization ([#34917](https://github.com/vm0-ai/okou/issues/34917)) ([add192c](https://github.com/vm0-ai/okou/commit/add192c6a1e569816b6a2a522149677a85bfc6a2))
* **platform:** consume the slash token when a panel cover is chosen ([#34974](https://github.com/vm0-ai/okou/issues/34974)) ([9d63a1b](https://github.com/vm0-ai/okou/commit/9d63a1be8e53f8bc7d95b7ad05ac0b126c93bc4a))
* **platform:** frame the public conversation as the app and stop prompting members to sign in ([#34679](https://github.com/vm0-ai/okou/issues/34679)) ([79ba3df](https://github.com/vm0-ai/okou/commit/79ba3dff03936a7b278b65675cc9c3045efedda2))
* **platform:** keep the slash panel's cover pane closed on a paneless row ([#34978](https://github.com/vm0-ai/okou/issues/34978)) ([64cd664](https://github.com/vm0-ai/okou/commit/64cd6643d85ecd45a2e54ca8c99cfa96259f9d83))
* **platform:** keep the whole template nav in a creative video draft ([#34953](https://github.com/vm0-ai/okou/issues/34953)) ([db63392](https://github.com/vm0-ai/okou/commit/db63392449c28c3bed3fc25eb45ff56616cc5844))
* **platform:** let the workspace canvas run under the chat composer ([#34988](https://github.com/vm0-ai/okou/issues/34988)) ([37dac94](https://github.com/vm0-ai/okou/commit/37dac94eb43a19238caa0d33da80398b2158e927))
* **platform:** open the presentation tab from the shelf's more templates link ([#34937](https://github.com/vm0-ai/okou/issues/34937)) ([81d99f8](https://github.com/vm0-ai/okou/commit/81d99f87087fd6f3790a156cfd2a7f35021bdf1d))
* **platform:** seat the connector toolbar on the workspace canvas ([#34916](https://github.com/vm0-ai/okou/issues/34916)) ([a7973da](https://github.com/vm0-ai/okou/commit/a7973da378be868dd980d6c45ddc3f5b4bb35f56))
* reserve sandbox capacity for waiting demand ([#34868](https://github.com/vm0-ai/okou/issues/34868)) ([db7a6c3](https://github.com/vm0-ai/okou/commit/db7a6c32b1d54ab629e0efdffb79a2984ab587cc))


### Performance Improvements

* **platform:** skip management reads for agent creator display ([#34957](https://github.com/vm0-ai/okou/issues/34957)) ([d8f92a8](https://github.com/vm0-ai/okou/commit/d8f92a8bef0e110145af1e471869fb0ab6d63bc9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.458.0
    * @okouai/core bumped to 8.676.0
    * @okouai/ui bumped to 1.10.0

## [0.910.0](https://github.com/vm0-ai/okou/compare/app-v0.909.0...app-v0.910.0) (2026-09-17)


### Features

* **platform:** lead an empty custom catalog with one drop zone ([#34879](https://github.com/vm0-ai/okou/issues/34879)) ([559f917](https://github.com/vm0-ai/okou/commit/559f9174e0a52280dce65177cc4fd864bea1dac0))


### Bug Fixes

* **api:** fence bulk agent read cursors and bound invalidations ([#34893](https://github.com/vm0-ai/okou/issues/34893)) ([e9001cd](https://github.com/vm0-ai/okou/commit/e9001cdc0e69e7246209e62e2995a388a82077b5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.457.0
    * @okouai/core bumped to 8.675.1

## [0.909.0](https://github.com/vm0-ai/okou/compare/app-v0.908.2...app-v0.909.0) (2026-09-17)


### Features

* **platform:** upload a document as a custom template without leaving the picker ([#34865](https://github.com/vm0-ai/okou/issues/34865)) ([68c606a](https://github.com/vm0-ai/okou/commit/68c606a7e5812e589b81b04053ce4d298b233f66))


### Bug Fixes

* **platform:** instrument marketing onboarding handoff ([#34825](https://github.com/vm0-ai/okou/issues/34825)) ([cf7e0d8](https://github.com/vm0-ai/okou/commit/cf7e0d8725129beee2d9db7fcad7d2601b62bac2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.456.0
    * @okouai/core bumped to 8.675.0

## [0.908.2](https://github.com/vm0-ai/okou/compare/app-v0.908.1...app-v0.908.2) (2026-09-17)


### Bug Fixes

* **app:** open onboarding after workspace creation ([#34836](https://github.com/vm0-ai/okou/issues/34836)) ([873ef60](https://github.com/vm0-ai/okou/commit/873ef60b227fd297181e986998edc6ab7a61d1dd))
* **chat:** preserve mail ids in forwarded prompts ([#34853](https://github.com/vm0-ai/okou/issues/34853)) ([2432506](https://github.com/vm0-ai/okou/commit/2432506926029d55e3f0a36d7aaa95da7a582a22))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.455.1
    * @okouai/core bumped to 8.674.2
    * @okouai/ui bumped to 1.9.4

## [0.908.1](https://github.com/vm0-ai/okou/compare/app-v0.908.0...app-v0.908.1) (2026-09-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.455.0
    * @okouai/core bumped to 8.674.1

## [0.908.0](https://github.com/vm0-ai/okou/compare/app-v0.907.2...app-v0.908.0) (2026-09-17)


### Features

* add owner-aware artifact sharing controls ([#34682](https://github.com/vm0-ai/okou/issues/34682)) ([a2fcba9](https://github.com/vm0-ai/okou/commit/a2fcba980a4a92c72678d031d9c85e4154b0bc09))
* **platform:** keep only oauth-connector workflow templates ([#34665](https://github.com/vm0-ai/okou/issues/34665)) ([558905e](https://github.com/vm0-ai/okou/commit/558905e519c9e6b2ae00cc5c03fac2769e66a3b4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.454.0
    * @okouai/core bumped to 8.674.0

## [0.907.2](https://github.com/vm0-ai/okou/compare/app-v0.907.1...app-v0.907.2) (2026-09-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.453.0
    * @okouai/core bumped to 8.673.2

## [0.907.1](https://github.com/vm0-ai/okou/compare/app-v0.907.0...app-v0.907.1) (2026-09-16)


### Bug Fixes

* **app:** label chat message sources as imessage ([#34746](https://github.com/vm0-ai/okou/issues/34746)) ([88a1de9](https://github.com/vm0-ai/okou/commit/88a1de9a5edba1538b2fd1f0c40b846f84d30536))
* **chat:** render multiple action links without losing prose ([#34688](https://github.com/vm0-ai/okou/issues/34688)) ([cc367e4](https://github.com/vm0-ai/okou/commit/cc367e411e0262ea6da0982b63c4d60e03cfaa9f))
* **cli:** include the app origin in private artifact urls ([#34743](https://github.com/vm0-ai/okou/issues/34743)) ([fc49a4c](https://github.com/vm0-ai/okou/commit/fc49a4cbaec88437e82fe3caec5e56670b4e1cf7))
* **platform:** move workflow message navigation to source label ([#34749](https://github.com/vm0-ai/okou/issues/34749)) ([9fb9ac6](https://github.com/vm0-ai/okou/commit/9fb9ac6fc7dbbd96c64914e970b9f7ce8216e1ef))
* **platform:** require manual get started check-in ([#34744](https://github.com/vm0-ai/okou/issues/34744)) ([89551da](https://github.com/vm0-ai/okou/commit/89551da94b9bd6b38e2c4166a572c91cb4ce61fa))


### Refactoring

* **app:** remove shared worker topic whitelist ([#34736](https://github.com/vm0-ai/okou/issues/34736)) ([39c8d35](https://github.com/vm0-ai/okou/commit/39c8d353ab496edaa471543970c5474bd9147213))
* require org model policy revision fields ([#34752](https://github.com/vm0-ai/okou/issues/34752)) ([0493242](https://github.com/vm0-ai/okou/commit/0493242c74f11006531e7e34ba665da6f4b5e1d1))


### Performance Improvements

* **platform:** split vendor dependencies into five acyclic chunks ([#34751](https://github.com/vm0-ai/okou/issues/34751)) ([f0df6e6](https://github.com/vm0-ai/okou/commit/f0df6e656f2da1826c268d16e2ba9af0689a9d1a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.452.1
    * @okouai/core bumped to 8.673.1

## [0.907.0](https://github.com/vm0-ai/okou/compare/app-v0.906.1...app-v0.907.0) (2026-09-16)


### Features

* **platform:** add a custom category to the template picker ([#34617](https://github.com/vm0-ai/okou/issues/34617)) ([a6d695b](https://github.com/vm0-ai/okou/commit/a6d695ba91197f5f2bd9483977506458fe423792))


### Bug Fixes

* **app:** size chat notice cards from their own rows ([#34685](https://github.com/vm0-ai/okou/issues/34685)) ([6e07fe4](https://github.com/vm0-ai/okou/commit/6e07fe4b421b57bd49caaf3282d3c53645eaeb06))
* **ui:** draw every menu and select row at 36px ([#34699](https://github.com/vm0-ai/okou/issues/34699)) ([34309b1](https://github.com/vm0-ai/okou/commit/34309b1610f5e2c0c8871e78ed259718b161bbdd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.452.0
    * @okouai/core bumped to 8.673.0
    * @okouai/ui bumped to 1.9.3

## [0.906.1](https://github.com/vm0-ai/okou/compare/app-v0.906.0...app-v0.906.1) (2026-09-16)


### Bug Fixes

* **api:** attribute required-output backpressure phases ([#34663](https://github.com/vm0-ai/okou/issues/34663)) ([a1e31af](https://github.com/vm0-ai/okou/commit/a1e31afbdd683ded91cb4b0343bfaa2505244b26))
* **app:** keep the composer's type in the footer and in the thread it opens ([#34660](https://github.com/vm0-ai/okou/issues/34660)) ([d5cff0a](https://github.com/vm0-ai/okou/commit/d5cff0a8edf0b237ad3085cbc877a4fd1c5f80b1))
* keep the model picker flyout focus ring inside its row ([#34664](https://github.com/vm0-ai/okou/issues/34664)) ([f419bc3](https://github.com/vm0-ai/okou/commit/f419bc3324e6244de5754b289821317400eb4824))


### Performance Improvements

* **app:** deduplicate retained attribution requests ([#34649](https://github.com/vm0-ai/okou/issues/34649)) ([2f007cc](https://github.com/vm0-ai/okou/commit/2f007ccb86ff61d279443552030e4107fce50200))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.451.0
    * @okouai/core bumped to 8.672.0

## [0.906.0](https://github.com/vm0-ai/okou/compare/app-v0.905.2...app-v0.906.0) (2026-09-16)


### Features

* **app:** offer the product's own palette in the color theme picker ([#34556](https://github.com/vm0-ai/okou/issues/34556)) ([c915c93](https://github.com/vm0-ai/okou/commit/c915c93abccb6448ccadd41f9dd1c893617928a7))
* **platform:** give each get started quest a press affordance ([#34551](https://github.com/vm0-ai/okou/issues/34551)) ([c5497ee](https://github.com/vm0-ai/okou/commit/c5497eeb9002e93d2fd8f13ef4d8369c1fb3d7f3))


### Bug Fixes

* **ssh:** prevent duplicate resources when retrying saves ([#34568](https://github.com/vm0-ai/okou/issues/34568)) ([c70d478](https://github.com/vm0-ai/okou/commit/c70d4789d1767a291991103a4db0c29a0788bfea))


### Refactoring

* **app:** drain the last two hairline selectors and the avatar injection ([#34632](https://github.com/vm0-ai/okou/issues/34632)) ([38de4e7](https://github.com/vm0-ai/okou/commit/38de4e7b3e52db6081a7b1bfda679778b386c8d2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.450.0
    * @okouai/core bumped to 8.671.0

## [0.905.2](https://github.com/vm0-ai/okou/compare/app-v0.905.1...app-v0.905.2) (2026-09-16)


### Bug Fixes

* **app:** add recovery page for unavailable artifacts ([#34565](https://github.com/vm0-ai/okou/issues/34565)) ([4670cc5](https://github.com/vm0-ai/okou/commit/4670cc5bb6acdaa2cefad6b46c1da7e4bdfae7a4))
* **app:** type-check shared worker realtime topics ([#34583](https://github.com/vm0-ai/okou/issues/34583)) ([93d4c2f](https://github.com/vm0-ai/okou/commit/93d4c2f7280a5ceb826c7ea55ea29e4227947feb))
* **platform:** stop user bubbles stacking on top of each other while sharing ([#34582](https://github.com/vm0-ai/okou/issues/34582)) ([bcebe14](https://github.com/vm0-ai/okou/commit/bcebe140c7d89c9dd17661764fe456262023f192))


### Documentation

* **styles:** keep the rules, drop the migration record ([#34522](https://github.com/vm0-ai/okou/issues/34522)) ([1c9510b](https://github.com/vm0-ai/okou/commit/1c9510b26bd225a80ebd259252d7fd89c9bf0bcc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.449.1
    * @okouai/core bumped to 8.670.2

## [0.905.1](https://github.com/vm0-ai/okou/compare/app-v0.905.0...app-v0.905.1) (2026-09-16)


### Bug Fixes

* **app:** allow get started reward notifications through shared worker ([#34563](https://github.com/vm0-ai/okou/issues/34563)) ([48a840e](https://github.com/vm0-ai/okou/commit/48a840ec4d2f56d8626c9c0cb4db99788fb98012))
* **app:** keep search category button widths stable ([#34564](https://github.com/vm0-ai/okou/issues/34564)) ([0566857](https://github.com/vm0-ai/okou/commit/0566857360ad4df2d78012dec7deb4f881ba3c08))
* **platform:** present embedded sites in a public conversation ([#34528](https://github.com/vm0-ai/okou/issues/34528)) ([7135839](https://github.com/vm0-ai/okou/commit/7135839d97aa9f336d5e4a3b9898b1dcd26433ea))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.449.0
    * @okouai/core bumped to 8.670.1

## [0.905.0](https://github.com/vm0-ai/okou/compare/app-v0.904.0...app-v0.905.0) (2026-09-16)


### Features

* **ssh:** unify credential and access management flows ([#34529](https://github.com/vm0-ai/okou/issues/34529)) ([68f3e49](https://github.com/vm0-ai/okou/commit/68f3e49fa62edcd14e3888180cbb7244d4a7f2b1))


### Refactoring

* remove the unreachable composer choose command ([#34547](https://github.com/vm0-ai/okou/issues/34547)) ([8003fbb](https://github.com/vm0-ai/okou/commit/8003fbb8d61cb77c3cdb13c81f59a69625d11662))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.448.0
    * @okouai/core bumped to 8.670.0

## [0.904.0](https://github.com/vm0-ai/okou/compare/app-v0.903.2...app-v0.904.0) (2026-09-16)


### Features

* add get started rewards with seven-day expiry ([#34404](https://github.com/vm0-ai/okou/issues/34404)) ([fb09ab0](https://github.com/vm0-ai/okou/commit/fb09ab0357f47181d1c6e38713b8a8d2dc959f6c))


### Refactoring

* remove composerCreateCommands feature switch ([#34527](https://github.com/vm0-ai/okou/issues/34527)) ([b3be0f4](https://github.com/vm0-ai/okou/commit/b3be0f414f149f23c3e33efc9161486268380c02))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.447.0
    * @okouai/core bumped to 8.669.0

## [0.903.2](https://github.com/vm0-ai/okou/compare/app-v0.903.1...app-v0.903.2) (2026-09-16)


### Bug Fixes

* complete lark and feishu setup permissions ([#34491](https://github.com/vm0-ai/okou/issues/34491)) ([13b706d](https://github.com/vm0-ai/okou/commit/13b706d293f61d6bd6f71b039baac2f54f19fdc7))
* **platform:** follow the color preset on the checked switch track ([#34506](https://github.com/vm0-ai/okou/issues/34506)) ([9be1044](https://github.com/vm0-ai/okou/commit/9be10442d6ef4762d792330a9f4ff97bea18f5a7))
* **platform:** weight the scale's dots per state, not once ([#34500](https://github.com/vm0-ai/okou/issues/34500)) ([f74f465](https://github.com/vm0-ai/okou/commit/f74f4651707da906bd4a18a119125680d0e0aeff))


### Refactoring

* **app:** remove the inert app shell class ([#34482](https://github.com/vm0-ai/okou/issues/34482)) ([b9c7da3](https://github.com/vm0-ai/okou/commit/b9c7da343512b84f20162b3bc6eaafb22b151686)), closes [#32402](https://github.com/vm0-ai/okou/issues/32402)
* **app:** replace impact iframe with one onboarding request ([#34403](https://github.com/vm0-ai/okou/issues/34403)) ([4f33be6](https://github.com/vm0-ai/okou/commit/4f33be6e54d54757a49c796e5bacd87d75d2b274))
* **ssh:** share rollout gating with cloudflare access ([#34489](https://github.com/vm0-ai/okou/issues/34489)) ([84a84fb](https://github.com/vm0-ai/okou/commit/84a84fba45ee6b5273b0ee5c6ade5a60a10b22c9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.446.1
    * @okouai/core bumped to 8.668.2

## [0.903.1](https://github.com/vm0-ai/okou/compare/app-v0.903.0...app-v0.903.1) (2026-09-16)


### Bug Fixes

* **app:** stop auto-opening the intro video template picker after a desktop recording ([#34330](https://github.com/vm0-ai/okou/issues/34330)) ([3576517](https://github.com/vm0-ai/okou/commit/3576517699e4a6df44e2b8daed03dc294a6304f7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.446.0
    * @okouai/core bumped to 8.668.1

## [0.903.0](https://github.com/vm0-ai/okou/compare/app-v0.902.3...app-v0.903.0) (2026-09-16)


### Features

* **platform:** collapse the composer toolbar into one add menu ([#34394](https://github.com/vm0-ai/okou/issues/34394)) ([a54f703](https://github.com/vm0-ai/okou/commit/a54f703655d94b3552f856783294efbe97484a6b))


### Bug Fixes

* **app:** preserve fixed chat card frames across state changes ([#34449](https://github.com/vm0-ai/okou/issues/34449)) ([bd39850](https://github.com/vm0-ai/okou/commit/bd39850fb9cf1057ce90bd68fb6b6b0debd578c1))
* **platform:** mark every effort stop, and let the dots recede ([#34455](https://github.com/vm0-ai/okou/issues/34455)) ([955469c](https://github.com/vm0-ai/okou/commit/955469c453af434d6d1b2e53d09d64a0a6a4522f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.668.0

## [0.902.3](https://github.com/vm0-ai/okou/compare/app-v0.902.2...app-v0.902.3) (2026-09-16)


### Bug Fixes

* **platform:** restore awaitable first page content boundary ([#34454](https://github.com/vm0-ai/okou/issues/34454)) ([abf0c90](https://github.com/vm0-ai/okou/commit/abf0c90d9a82dd9475bcb52fc03968ab87c4862c))


### Refactoring

* centralize mermaid rendering and remove fixed checkout paths ([#33878](https://github.com/vm0-ai/okou/issues/33878)) ([4e455ca](https://github.com/vm0-ai/okou/commit/4e455ca9e07705d9be5640e6b07c07fffe2ec5eb))
* fold session output streaming into piloop ([#34445](https://github.com/vm0-ai/okou/issues/34445)) ([9a641d1](https://github.com/vm0-ai/okou/commit/9a641d19a9776261fd549d21fbe225e08d3ad3df))
* **platform:** clarify chat thread event source semantics ([#34418](https://github.com/vm0-ai/okou/issues/34418)) ([fbededc](https://github.com/vm0-ai/okou/commit/fbededc38266747f4c75e01102b84815d4c7f0ec))
* **platform:** separate background loop startup from completion ([#34399](https://github.com/vm0-ai/okou/issues/34399)) ([8bf690c](https://github.com/vm0-ai/okou/commit/8bf690c29c8488f6c4f3987b1885718ee68a28d2))
* remove expired deployment compatibility ([#34452](https://github.com/vm0-ai/okou/issues/34452)) ([669012a](https://github.com/vm0-ai/okou/commit/669012a4802f76decbe32f881add2bad5bf07566))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.445.1
    * @okouai/core bumped to 8.667.1

## [0.902.2](https://github.com/vm0-ai/vm0/compare/app-v0.902.1...app-v0.902.2) (2026-09-15)


### Bug Fixes

* **app:** clear replaced replies from share selection ([#34406](https://github.com/vm0-ai/vm0/issues/34406)) ([cd3f756](https://github.com/vm0-ai/vm0/commit/cd3f756a99b03ce5f5ba88629e52b321fb7353d7))
* keep mermaid diagrams white across app themes ([#34410](https://github.com/vm0-ai/vm0/issues/34410)) ([0d60752](https://github.com/vm0-ai/vm0/commit/0d6075230195f1e52804f6eaed37ecfd01552a81))


### Refactoring

* **app:** delete the dead desktop shell selection rules ([#34388](https://github.com/vm0-ai/vm0/issues/34388)) ([3f72de6](https://github.com/vm0-ai/vm0/commit/3f72de62f13ed4cdfb259502a97a787bcbdae5ef))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.667.0

## [0.902.1](https://github.com/vm0-ai/vm0/compare/app-v0.902.0...app-v0.902.1) (2026-09-15)


### Bug Fixes

* **platform:** give the effort scale's dots enough weight to read ([#34341](https://github.com/vm0-ai/vm0/issues/34341)) ([5204958](https://github.com/vm0-ai/vm0/commit/52049588ce58cf9b7f7635e34e5268be1aa0422a))


### Refactoring

* **platform:** finish child abort ownership migration ([#34402](https://github.com/vm0-ai/vm0/issues/34402)) ([f4d8819](https://github.com/vm0-ai/vm0/commit/f4d8819d452ae325cbf76a2da318db84a4a5172f)), closes [#33860](https://github.com/vm0-ai/vm0/issues/33860)
* **platform:** own card tokens at the document root ([#34400](https://github.com/vm0-ai/vm0/issues/34400)) ([c96243b](https://github.com/vm0-ai/vm0/commit/c96243bd807481295e95824d4e9b0fdd9d8d8e65))
* **platform:** simplify dialog loading state ([#34408](https://github.com/vm0-ai/vm0/issues/34408)) ([7a4f632](https://github.com/vm0-ai/vm0/commit/7a4f632a353ceb22ee739dace2f0952920eeb7a6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.445.0
    * @okouai/core bumped to 8.666.7

## [0.902.0](https://github.com/vm0-ai/vm0/compare/app-v0.901.0...app-v0.902.0) (2026-09-15)


### Features

* **platform:** manage cloudflare access in ssh ([#34337](https://github.com/vm0-ai/vm0/issues/34337)) ([ba33b36](https://github.com/vm0-ai/vm0/commit/ba33b361378a00a815a6629fed67cd24dc20d646))


### Bug Fixes

* distinguish balance ownership and localize run errors ([#34251](https://github.com/vm0-ai/vm0/issues/34251)) ([0367d97](https://github.com/vm0-ai/vm0/commit/0367d976a87fe1251fcb9b6cfe545a8b24e4f2b6))


### Refactoring

* **app:** migrate chat and calendar cancellation ownership ([#34369](https://github.com/vm0-ai/vm0/issues/34369)) ([ef4e6fe](https://github.com/vm0-ai/vm0/commit/ef4e6fe9f70d124d941dff55c2a6d841e487eefc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.444.1
    * @okouai/core bumped to 8.666.6
    * @okouai/ui bumped to 1.9.2

## [0.901.0](https://github.com/vm0-ai/vm0/compare/app-v0.900.0...app-v0.901.0) (2026-09-15)


### Features

* complete personal subscription launch support ([#34263](https://github.com/vm0-ai/vm0/issues/34263)) ([f2731f5](https://github.com/vm0-ai/vm0/commit/f2731f57b6d9ff924ae87f7c5222aa78e5f1cce4))
* offer only intro video voices that can be auditioned ([#34331](https://github.com/vm0-ai/vm0/issues/34331)) ([3396db8](https://github.com/vm0-ai/vm0/commit/3396db842be8b37d4f21772baecd56d328830532))


### Bug Fixes

* **platform:** clear the connectors toolbar from the scroll edge ([#34349](https://github.com/vm0-ai/vm0/issues/34349)) ([ef5f750](https://github.com/vm0-ai/vm0/commit/ef5f750b8af6905d2ad4ada04563125f5c942d44))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.444.0
    * @okouai/core bumped to 8.666.5

## [0.900.0](https://github.com/vm0-ai/vm0/compare/app-v0.899.2...app-v0.900.0) (2026-09-15)


### Features

* **platform:** name the ends of the effort scale ([#34316](https://github.com/vm0-ai/vm0/issues/34316)) ([631e34c](https://github.com/vm0-ai/vm0/commit/631e34c12525161192f9271b16d38b4c1fcffd9e))


### Bug Fixes

* **app:** contain the catalog loading label inside its scroller ([#34297](https://github.com/vm0-ai/vm0/issues/34297)) ([7eee4f3](https://github.com/vm0-ai/vm0/commit/7eee4f347101eeb3bb0309d20499c6e73a76859d))
* **app:** drop the empty uploaded-template status message ([#34307](https://github.com/vm0-ai/vm0/issues/34307)) ([2660c02](https://github.com/vm0-ai/vm0/commit/2660c02c54c92dfcf1999ecfe6293a754c8a047b))
* **app:** merge the duplicated unsaved bars and localize their labels ([#34301](https://github.com/vm0-ai/vm0/issues/34301)) ([eaecc82](https://github.com/vm0-ai/vm0/commit/eaecc8296c2baa25d08137cd22f400ece90255d6))
* **app:** play intro video style previews on hover ([#34322](https://github.com/vm0-ai/vm0/issues/34322)) ([902a346](https://github.com/vm0-ai/vm0/commit/902a346566fc01104cf873e0946eec15fd325030))
* honor private artifact storage for attachments and integrations ([#34310](https://github.com/vm0-ai/vm0/issues/34310)) ([cb833bf](https://github.com/vm0-ai/vm0/commit/cb833bfcc55dca9e58a85bae4b4b1a0663febd0a))
* **platform:** give the intro video tab its own icon ([#34314](https://github.com/vm0-ai/vm0/issues/34314)) ([233a2d5](https://github.com/vm0-ai/vm0/commit/233a2d50d29334d6d5103f8fc3b39eca0c102123))
* use mime types for attachment thumbnails ([#34313](https://github.com/vm0-ai/vm0/issues/34313)) ([58685d3](https://github.com/vm0-ai/vm0/commit/58685d3dda2abe907742b0855631a7307098c681))


### Refactoring

* **ads:** retire browser account routing api compatibility ([#34312](https://github.com/vm0-ai/vm0/issues/34312)) ([7b1a7df](https://github.com/vm0-ai/vm0/commit/7b1a7df1b8091d79f326b17bd2bbde6298657d31))
* **app:** drain the shimmer text selector ([#34287](https://github.com/vm0-ai/vm0/issues/34287)) ([948a8ae](https://github.com/vm0-ai/vm0/commit/948a8ae636d7467ac80c0330e696694a536089a6))
* **platform:** retire the inert wmde-markdown-color class ([#34196](https://github.com/vm0-ai/vm0/issues/34196)) ([0309ec0](https://github.com/vm0-ai/vm0/commit/0309ec079765e29125df228a54e882c8fdeab50f))
* **slack:** retire oauth rollout compatibility ([#34306](https://github.com/vm0-ai/vm0/issues/34306)) ([ee68573](https://github.com/vm0-ai/vm0/commit/ee685730e7281057c0c6939a89e31d4716043ce9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.443.3
    * @okouai/core bumped to 8.666.4
    * @okouai/ui bumped to 1.9.1

## [0.899.2](https://github.com/vm0-ai/vm0/compare/app-v0.899.1...app-v0.899.2) (2026-09-15)


### Refactoring

* **app:** drain the fixed viewport shell and markdown card selectors ([#34233](https://github.com/vm0-ai/vm0/issues/34233)) ([c0e6c3f](https://github.com/vm0-ai/vm0/commit/c0e6c3f7438d92b699e0f80b57e7af390f101f11))
* give effort its own switch ([#34269](https://github.com/vm0-ai/vm0/issues/34269)) ([df5644a](https://github.com/vm0-ai/vm0/commit/df5644a8cb7e7905813ba4d1dc40aa9b98e4de92))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.443.2
    * @okouai/core bumped to 8.666.3

## [0.899.1](https://github.com/vm0-ai/vm0/compare/app-v0.899.0...app-v0.899.1) (2026-09-15)


### Bug Fixes

* align artifact viewer and shorten sharing urls ([#34249](https://github.com/vm0-ai/vm0/issues/34249)) ([f833361](https://github.com/vm0-ai/vm0/commit/f833361a484782b0d85ea6dd6d4929f0a6034d14))
* **app:** stabilize workflow hover author layout ([#34265](https://github.com/vm0-ai/vm0/issues/34265)) ([4829306](https://github.com/vm0-ai/vm0/commit/4829306b59c97df01f66d81dec4957be13376ba6))
* persist sidebar section collapse preferences ([#34257](https://github.com/vm0-ai/vm0/issues/34257)) ([ebdf3a4](https://github.com/vm0-ai/vm0/commit/ebdf3a425766e6f00da4e2cb5f59198d315682fc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.443.1
    * @okouai/core bumped to 8.666.2

## [0.899.0](https://github.com/vm0-ai/vm0/compare/app-v0.898.0...app-v0.899.0) (2026-09-15)


### Features

* **attribution:** keep impact data exclusively in marketing ([#33929](https://github.com/vm0-ai/vm0/issues/33929)) ([d72ff4b](https://github.com/vm0-ai/vm0/commit/d72ff4b88be43dbc571777858d4b688140d9835c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.443.0
    * @okouai/core bumped to 8.666.1

## [0.898.0](https://github.com/vm0-ai/vm0/compare/app-v0.897.0...app-v0.898.0) (2026-09-15)


### Features

* give intro video its own generation template type ([#34221](https://github.com/vm0-ai/vm0/issues/34221)) ([776735a](https://github.com/vm0-ai/vm0/commit/776735a14e2d2c8d3fe482b3c8b92b9dd66f5ce8))
* **platform:** pin the connectors scope and search while the page scrolls ([#34222](https://github.com/vm0-ai/vm0/issues/34222)) ([f3473d2](https://github.com/vm0-ai/vm0/commit/f3473d28ba2891d67d600b46db3e01dbb147c0a3))


### Bug Fixes

* **api:** include the project in langfuse trace links ([#34215](https://github.com/vm0-ai/vm0/issues/34215)) ([fda0a6e](https://github.com/vm0-ai/vm0/commit/fda0a6ef129d7c6edb21452c4f4660e52fc5b63d))
* **app:** replace the last idea prompt instead of stacking prompts ([#34217](https://github.com/vm0-ai/vm0/issues/34217)) ([5920b1d](https://github.com/vm0-ai/vm0/commit/5920b1d9163798afc0816587fb1b8b83b145aaca))
* **app:** reveal user message actions without opacity transitions ([#33785](https://github.com/vm0-ai/vm0/issues/33785)) ([634e340](https://github.com/vm0-ai/vm0/commit/634e340c6aff0f30bd0b9ea1ee3d557ce49c51e9))
* **app:** update lark integration guide creation image ([#34218](https://github.com/vm0-ai/vm0/issues/34218)) ([4af04bf](https://github.com/vm0-ai/vm0/commit/4af04bfc0a597a31d546ddaf9a7757d04c9503cc))
* **mail:** handle recognized gmail draft-send rejections ([#34210](https://github.com/vm0-ai/vm0/issues/34210)) ([9a09a5c](https://github.com/vm0-ai/vm0/commit/9a09a5c95e02784281bd3f92689f49a85811c1b3))
* **platform:** mark the effort scale with dots and bring the bar down ([#34216](https://github.com/vm0-ai/vm0/issues/34216)) ([74a9273](https://github.com/vm0-ai/vm0/commit/74a92733f712af438ff868aa39de607a08049e37))


### Refactoring

* **platform:** drain the language-mermaid legacy class from the mermaid fence ([#34226](https://github.com/vm0-ai/vm0/issues/34226)) ([7247fe0](https://github.com/vm0-ai/vm0/commit/7247fe035f88b8e5c59d0151c9a1ef44a411a238))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.442.0
    * @okouai/core bumped to 8.666.0

## [0.897.0](https://github.com/vm0-ai/vm0/compare/app-v0.896.2...app-v0.897.0) (2026-09-15)


### Features

* **app:** finish the composer's second level and quiet the chart picker ([#34161](https://github.com/vm0-ai/vm0/issues/34161)) ([2d18df5](https://github.com/vm0-ai/vm0/commit/2d18df55c4a751a296808d8393a2e77241b54641))
* **ssh:** add reusable cloudflare access configuration ([#34105](https://github.com/vm0-ai/vm0/issues/34105)) ([21f7e6a](https://github.com/vm0-ai/vm0/commit/21f7e6a3d2870791cb705ebd37217457d9118890))


### Bug Fixes

* **app:** let the pointer own the slash panel's row mark ([#34163](https://github.com/vm0-ai/vm0/issues/34163)) ([c9cf287](https://github.com/vm0-ai/vm0/commit/c9cf2878a655c9be71ff0b3de5167607bef1e930))
* report and label intro video as its own template kind ([#34096](https://github.com/vm0-ai/vm0/issues/34096)) ([8d01e1a](https://github.com/vm0-ai/vm0/commit/8d01e1a9832cd0e73330d85e55709abe515acfe7))


### Refactoring

* **app:** drain chat thinking-state legacy selectors ([#33843](https://github.com/vm0-ai/vm0/issues/33843)) ([e4a6743](https://github.com/vm0-ai/vm0/commit/e4a67435cedb4d8c57fcb99dc349b077c5c33dda))
* **app:** drain pwa safe-area cover legacy styles ([#33952](https://github.com/vm0-ai/vm0/issues/33952)) ([5b5de1c](https://github.com/vm0-ai/vm0/commit/5b5de1c241dafb9f21d1ee8520312ac2b68c308c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.441.0
    * @okouai/core bumped to 8.665.0

## [0.896.2](https://github.com/vm0-ai/vm0/compare/app-v0.896.1...app-v0.896.2) (2026-09-15)


### Refactoring

* **platform:** move transcript chat cards onto a shared card component ([#33964](https://github.com/vm0-ai/vm0/issues/33964)) ([1794ce2](https://github.com/vm0-ai/vm0/commit/1794ce2989368ab4a25fbe97fe3bd42b64961bd0))

## [0.896.1](https://github.com/vm0-ai/vm0/compare/app-v0.896.0...app-v0.896.1) (2026-09-15)


### Bug Fixes

* include prompt attachments in shared threads ([#34156](https://github.com/vm0-ai/vm0/issues/34156)) ([0dc6484](https://github.com/vm0-ai/vm0/commit/0dc64849580cca94d34130c6a8d232a940e8d8ac))


### Refactoring

* **platform:** retire the model picker's chat settings page ([#34160](https://github.com/vm0-ai/vm0/issues/34160)) ([4096576](https://github.com/vm0-ai/vm0/commit/4096576d4a18e8c117bfec0b4a59a38f7e4ad276))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.440.1
    * @okouai/core bumped to 8.664.2

## [0.896.0](https://github.com/vm0-ai/vm0/compare/app-v0.895.3...app-v0.896.0) (2026-09-14)


### Features

* add debug langfuse links to run actions ([#34148](https://github.com/vm0-ai/vm0/issues/34148)) ([b7ca117](https://github.com/vm0-ai/vm0/commit/b7ca1179ef140b045ed72cf4e857625678c0cb89))


### Bug Fixes

* default new workspaces to luna ([#34155](https://github.com/vm0-ai/vm0/issues/34155)) ([da449c9](https://github.com/vm0-ai/vm0/commit/da449c979a1a8efe95ba30d261746c4bf3ff3ff8))
* **platform:** unify chat scrollbars with shadcn styling ([#34150](https://github.com/vm0-ai/vm0/issues/34150)) ([b677eee](https://github.com/vm0-ai/vm0/commit/b677eee09365a6dd132e4cf7fef28054fb3ee26b))


### Refactoring

* remove expired deployment compatibility ([#34153](https://github.com/vm0-ai/vm0/issues/34153)) ([3eca7a9](https://github.com/vm0-ai/vm0/commit/3eca7a941b02a0da8254f79e671e22e697743040))
* use two-day presigned urls without renewal or retries ([#34149](https://github.com/vm0-ai/vm0/issues/34149)) ([a876fd2](https://github.com/vm0-ai/vm0/commit/a876fd28cd0a0fade04aa12fff33614ff156ba9b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.440.0
    * @okouai/core bumped to 8.664.1
    * @okouai/ui bumped to 1.9.0

## [0.895.3](https://github.com/vm0-ai/vm0/compare/app-v0.895.2...app-v0.895.3) (2026-09-14)


### Bug Fixes

* **platform:** notify thread indicators before chat warming ([#34147](https://github.com/vm0-ai/vm0/issues/34147)) ([1990ab3](https://github.com/vm0-ai/vm0/commit/1990ab34c4f62d5a79f10c6fa49bc1b0f7dda31f))

## [0.895.2](https://github.com/vm0-ai/vm0/compare/app-v0.895.1...app-v0.895.2) (2026-09-14)


### Bug Fixes

* **platform:** restore the effort control's agreed geometry and chrome ([#34120](https://github.com/vm0-ai/vm0/issues/34120)) ([76d7f69](https://github.com/vm0-ai/vm0/commit/76d7f69ba00d512c1f2d1810461f229ee59e54ef))
* **platform:** retain template preview errors during renewal ([#34082](https://github.com/vm0-ai/vm0/issues/34082)) ([ee5a07d](https://github.com/vm0-ai/vm0/commit/ee5a07d91e603cfeccb379075e86bb26558819b7))


### Refactoring

* unify model selection feature switches ([#34133](https://github.com/vm0-ai/vm0/issues/34133)) ([252e116](https://github.com/vm0-ai/vm0/commit/252e1163a515c7f212cd0b31c7c59b3d385f3a38))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.439.0
    * @okouai/core bumped to 8.664.0

## [0.895.1](https://github.com/vm0-ai/vm0/compare/app-v0.895.0...app-v0.895.1) (2026-09-14)


### Refactoring

* **app:** make the selected task chip one control ([#34116](https://github.com/vm0-ai/vm0/issues/34116)) ([cf2fd84](https://github.com/vm0-ai/vm0/commit/cf2fd84684f74d6439802e59d6fcd37ed4e52059))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.438.2
    * @okouai/core bumped to 8.663.2

## [0.895.0](https://github.com/vm0-ai/vm0/compare/app-v0.894.0...app-v0.895.0) (2026-09-14)


### Features

* **app:** give every create type one cover shelf under the composer ([#34122](https://github.com/vm0-ai/vm0/issues/34122)) ([ce77b40](https://github.com/vm0-ai/vm0/commit/ce77b404c09d05b9c32a6d1e165d68f34ea9f983))


### Bug Fixes

* **platform:** drop the custom scope's breadcrumb and move its create action ([#34118](https://github.com/vm0-ai/vm0/issues/34118)) ([aac0d27](https://github.com/vm0-ai/vm0/commit/aac0d27ed25f898d387ae18fe1b79adb34bf368b))


### Refactoring

* **app:** draw the task chips as the neutral button ([#34115](https://github.com/vm0-ai/vm0/issues/34115)) ([f52f92f](https://github.com/vm0-ai/vm0/commit/f52f92f14ac3de7bb14ac9cfaec035953f495cad))
* remove voice input v2 feature switch ([#33884](https://github.com/vm0-ai/vm0/issues/33884)) ([be1af01](https://github.com/vm0-ai/vm0/commit/be1af014b3329820ca167fec5238e02c73d6bc7d))
* **voice:** finish voice input v2 cleanup ([#34119](https://github.com/vm0-ai/vm0/issues/34119)) ([6958a1e](https://github.com/vm0-ai/vm0/commit/6958a1e767281f3a958ee0e853b159fe56525f7d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.438.1
    * @okouai/core bumped to 8.663.1
    * @okouai/ui bumped to 1.8.7

## [0.894.0](https://github.com/vm0-ai/vm0/compare/app-v0.893.12...app-v0.894.0) (2026-09-14)


### Features

* **app:** add a standalone artifact viewer ([#34088](https://github.com/vm0-ai/vm0/issues/34088)) ([c49b23f](https://github.com/vm0-ai/vm0/commit/c49b23f072d00dd9e51d2279ebd606f0b83556e2))
* **platform:** give custom connectors their own scope on the connectors page ([#34083](https://github.com/vm0-ai/vm0/issues/34083)) ([9866bc0](https://github.com/vm0-ai/vm0/commit/9866bc0c72322c5ca4ab02e22bb4363219e72b34))
* **platform:** redesign the chat reasoning-effort bar ([#34104](https://github.com/vm0-ai/vm0/issues/34104)) ([deec8ae](https://github.com/vm0-ai/vm0/commit/deec8aeeb647d3dede5182ce551d9c3d070ae767))


### Bug Fixes

* **app:** align lark app creation link with feishu ([#34094](https://github.com/vm0-ai/vm0/issues/34094)) ([b27dc6c](https://github.com/vm0-ai/vm0/commit/b27dc6c0437714290cf7d2e1f12cf4ebe8888c0a))
* **app:** refresh expired artifact previews on demand ([#34085](https://github.com/vm0-ai/vm0/issues/34085)) ([2bf1efd](https://github.com/vm0-ai/vm0/commit/2bf1efd3716e811f396e7b4abe58841fd3441bc3))


### Refactoring

* **platform:** retire the markdown code-fence copy contract ([#34059](https://github.com/vm0-ai/vm0/issues/34059)) ([2a91b89](https://github.com/vm0-ai/vm0/commit/2a91b894841c3de5d4834a0f1efac0519849b416))
* remove chat thinking spinner feature switch ([#34069](https://github.com/vm0-ai/vm0/issues/34069)) ([379454f](https://github.com/vm0-ai/vm0/commit/379454fc8965991e2898f6a9d8530db140c378b2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.438.0
    * @okouai/core bumped to 8.663.0

## [0.893.12](https://github.com/vm0-ai/vm0/compare/app-v0.893.11...app-v0.893.12) (2026-09-14)


### Bug Fixes

* **app:** handle artifact sharing on selection with toast feedback ([#34048](https://github.com/vm0-ai/vm0/issues/34048)) ([86d00b2](https://github.com/vm0-ai/vm0/commit/86d00b27446ecb0eaa204d11074cd96b9de9a8fd))


### Refactoring

* **app:** drop the category description in the slash template pane ([#34043](https://github.com/vm0-ai/vm0/issues/34043)) ([9756082](https://github.com/vm0-ai/vm0/commit/9756082f319752a35fc25a75b6849c9f0837a8ee))
* remove agentMessageMath feature switch ([#34051](https://github.com/vm0-ai/vm0/issues/34051)) ([66cd8df](https://github.com/vm0-ai/vm0/commit/66cd8df66d3e3231a71bebb00fe8e21fb8b2c1ba))
* remove composer workflow fuzzy search feature switch ([#34033](https://github.com/vm0-ai/vm0/issues/34033)) ([b812218](https://github.com/vm0-ai/vm0/commit/b8122187980a96ad51e376bca047f5e49479035a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.437.0
    * @okouai/core bumped to 8.662.2
    * @okouai/ui bumped to 1.8.6

## [0.893.11](https://github.com/vm0-ai/vm0/compare/app-v0.893.10...app-v0.893.11) (2026-09-14)


### Bug Fixes

* **app:** scope video controls to creative video drafts ([#33934](https://github.com/vm0-ai/vm0/issues/33934)) ([dc5ccdf](https://github.com/vm0-ai/vm0/commit/dc5ccdf653935b778d77fe120d62f3e20cc2b4e5))


### Refactoring

* **platform:** replace mermaid diagram selectors with utilities ([#33979](https://github.com/vm0-ai/vm0/issues/33979)) ([857cc5d](https://github.com/vm0-ai/vm0/commit/857cc5d3fdcd9e1a4eb041d8519f2612886e3f58))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.436.0
    * @okouai/core bumped to 8.662.1

## [0.893.10](https://github.com/vm0-ai/vm0/compare/app-v0.893.9...app-v0.893.10) (2026-09-14)


### Bug Fixes

* **app:** keep quote boundary navigation in editable text ([#33876](https://github.com/vm0-ai/vm0/issues/33876)) ([08a4b06](https://github.com/vm0-ai/vm0/commit/08a4b06c202c5e870cc4f2bc882314244cccb2e3))
* **app:** separate slash menu hover and keyboard selection ([#33837](https://github.com/vm0-ai/vm0/issues/33837)) ([c5567e5](https://github.com/vm0-ai/vm0/commit/c5567e5e04e1bb0e0dc80add3d52a36172138595))
* **platform:** load feature switches before routes ([#33893](https://github.com/vm0-ai/vm0/issues/33893)) ([1a02988](https://github.com/vm0-ai/vm0/commit/1a029885873904e1a0a1d197535a12c090327f04))


### Refactoring

* **app:** make clerk bootstrap own the runtime ([#33865](https://github.com/vm0-ai/vm0/issues/33865)) ([913086e](https://github.com/vm0-ai/vm0/commit/913086ee5a33ca0d0c35fe63e85ac5571b40cad9))
* **app:** make ssh clients lazy ([#33872](https://github.com/vm0-ai/vm0/issues/33872)) ([379a9f8](https://github.com/vm0-ai/vm0/commit/379a9f80f94419bd136ac494135cea2cdc805d9e))
* **app:** remove api client root signal fallback ([#33786](https://github.com/vm0-ai/vm0/issues/33786)) ([baf3981](https://github.com/vm0-ai/vm0/commit/baf39810cb9f0e025d73859e9b4820e383089592))
* **app:** remove viewport shell classes from existing layouts ([#33845](https://github.com/vm0-ai/vm0/issues/33845)) ([8f4bd1a](https://github.com/vm0-ai/vm0/commit/8f4bd1a94462c2aaf07a6bd90f0de0e2a62ab141))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.435.1
    * @okouai/core bumped to 8.662.0

## [0.893.9](https://github.com/vm0-ai/vm0/compare/app-v0.893.8...app-v0.893.9) (2026-09-14)


### Bug Fixes

* **api:** remove the morning brief data-source gate ([#33858](https://github.com/vm0-ai/vm0/issues/33858)) ([042e874](https://github.com/vm0-ai/vm0/commit/042e8744647369967585cb42b5c406f98290ca5d))


### Refactoring

* **app:** drain the live desktop titlebar declarations ([#33838](https://github.com/vm0-ai/vm0/issues/33838)) ([14451c7](https://github.com/vm0-ai/vm0/commit/14451c741c895b762d5d6af1636efb3adb179a3c))
* **platform:** prepare chat diagrams with the render window ([#33781](https://github.com/vm0-ai/vm0/issues/33781)) ([1aec195](https://github.com/vm0-ai/vm0/commit/1aec195c60332e14a96b4e112bef481cc081004a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.435.0
    * @okouai/core bumped to 8.661.1
    * @okouai/ui bumped to 1.8.5

## [0.893.8](https://github.com/vm0-ai/vm0/compare/app-v0.893.7...app-v0.893.8) (2026-09-14)


### Refactoring

* **app:** reuse platform API client for feature switches ([#33840](https://github.com/vm0-ai/vm0/issues/33840)) ([203ecd0](https://github.com/vm0-ai/vm0/commit/203ecd00d617e52193155f04258eba9a51256d8f))
* remove markdown time feature switch ([#33831](https://github.com/vm0-ai/vm0/issues/33831)) ([29c2fa6](https://github.com/vm0-ai/vm0/commit/29c2fa6d0de7ce9a391d594af7b3c252ef396471))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.434.0
    * @okouai/connectors bumped to 3.11.1
    * @okouai/core bumped to 8.661.0

## [0.893.7](https://github.com/vm0-ai/vm0/compare/app-v0.893.6...app-v0.893.7) (2026-09-13)


### Bug Fixes

* **app:** hide user message actions while sharing ([#33782](https://github.com/vm0-ai/vm0/issues/33782)) ([dcf5041](https://github.com/vm0-ai/vm0/commit/dcf504103ba465246750be8741f919a4abdf2cc1))
* **app:** share Clerk auth appearance with add-account dialog ([#33752](https://github.com/vm0-ai/vm0/issues/33752)) ([f993a0f](https://github.com/vm0-ai/vm0/commit/f993a0ff2abb4f7be9914cf31486d48e6650e9ae))

## [0.893.6](https://github.com/vm0-ai/vm0/compare/app-v0.893.5...app-v0.893.6) (2026-09-13)


### Refactoring

* remove expired deployment compatibility ([#33779](https://github.com/vm0-ai/vm0/issues/33779)) ([2e9ebba](https://github.com/vm0-ai/vm0/commit/2e9ebbaf3150cdcba6204ae11f294a6b8d094cfa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.433.1
    * @okouai/core bumped to 8.660.3

## [0.893.5](https://github.com/vm0-ai/vm0/compare/app-v0.893.4...app-v0.893.5) (2026-09-13)


### Bug Fixes

* **app:** simplify thread sharing while preserving reading position ([#33751](https://github.com/vm0-ai/vm0/issues/33751)) ([4522708](https://github.com/vm0-ai/vm0/commit/4522708a19896ebcb27eeb48c322d9d4ee4c15ab))


### Refactoring

* **app:** remove obsolete clerk drawer styles ([#33746](https://github.com/vm0-ai/vm0/issues/33746)) ([a9952cd](https://github.com/vm0-ai/vm0/commit/a9952cd950694871bd0bf64c0613f92b849333b8))
* **platform:** own the chat panel graph outside command execution ([#33583](https://github.com/vm0-ai/vm0/issues/33583)) ([3807171](https://github.com/vm0-ai/vm0/commit/38071713890d7b3b6049df033501e501946ea76f))

## [0.893.4](https://github.com/vm0-ai/vm0/compare/app-v0.893.3...app-v0.893.4) (2026-09-13)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.433.0
    * @okouai/core bumped to 8.660.2

## [0.893.3](https://github.com/vm0-ai/vm0/compare/app-v0.893.2...app-v0.893.3) (2026-09-13)


### Bug Fixes

* **app:** show chat header shortcut hints ([#33727](https://github.com/vm0-ai/vm0/issues/33727)) ([3025a87](https://github.com/vm0-ai/vm0/commit/3025a87b94af94a5e4ca08f4866d456d0f9e3d13))
* move banking rollout to alpha ([#33724](https://github.com/vm0-ai/vm0/issues/33724)) ([c3e7211](https://github.com/vm0-ai/vm0/commit/c3e7211fec24c53fae7b5d4e9d13e8dc5bc8be56))


### Refactoring

* **auth:** remove remaining v2 helper branches ([#33725](https://github.com/vm0-ai/vm0/issues/33725)) ([850c17b](https://github.com/vm0-ai/vm0/commit/850c17bcb85103b5003266346bdcb9b8cd5defd9))
* **auth:** remove unused v2 mocks and clerk environment type ([#33728](https://github.com/vm0-ai/vm0/issues/33728)) ([93d16f9](https://github.com/vm0-ai/vm0/commit/93d16f9861cfe4c670d234e48cbda139714b345e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.432.1
    * @okouai/core bumped to 8.660.1

## [0.893.2](https://github.com/vm0-ai/vm0/compare/app-v0.893.1...app-v0.893.2) (2026-09-12)


### Refactoring

* **auth:** replace auth v2 with hosted clerk ([#33450](https://github.com/vm0-ai/vm0/issues/33450)) ([3b1bca6](https://github.com/vm0-ai/vm0/commit/3b1bca622a808b130516b6d058050466a20369a9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.660.0

## [0.893.1](https://github.com/vm0-ai/vm0/compare/app-v0.893.0...app-v0.893.1) (2026-09-12)


### Bug Fixes

* **ssh:** show configured credential count ([#33696](https://github.com/vm0-ai/vm0/issues/33696)) ([9ac81fd](https://github.com/vm0-ai/vm0/commit/9ac81fd04b0950df3484348136e11582327f696b))


### Refactoring

* **app:** drain session list title legacy classes ([#33693](https://github.com/vm0-ai/vm0/issues/33693)) ([42d0e08](https://github.com/vm0-ai/vm0/commit/42d0e08f024389c97ac2b091f06ac23c76541a97))
* **app:** drop dead entrance-motion classes ([#33691](https://github.com/vm0-ai/vm0/issues/33691)) ([7489a1c](https://github.com/vm0-ai/vm0/commit/7489a1cdb49505c55376fa1086823868f26b66f2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.659.0

## [0.893.0](https://github.com/vm0-ai/vm0/compare/app-v0.892.0...app-v0.893.0) (2026-09-12)


### Features

* **chat:** support model-aware reasoning effort in pi ([#33683](https://github.com/vm0-ai/vm0/issues/33683)) ([ab64ece](https://github.com/vm0-ai/vm0/commit/ab64ece13b139daa0ca67e4049273e4e79ba4e76))


### Refactoring

* **ui:** move the sidebar nav copy tint to the variable layer ([#33302](https://github.com/vm0-ai/vm0/issues/33302)) ([73ab20c](https://github.com/vm0-ai/vm0/commit/73ab20c50c53a1f0e99bf46cb887b97bb41e733f)), closes [#32402](https://github.com/vm0-ai/vm0/issues/32402)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.432.0
    * @okouai/core bumped to 8.658.0

## [0.892.0](https://github.com/vm0-ai/vm0/compare/app-v0.891.0...app-v0.892.0) (2026-09-12)


### Features

* **chat:** persist model-aware reasoning effort settings ([#33551](https://github.com/vm0-ai/vm0/issues/33551)) ([1aa1036](https://github.com/vm0-ai/vm0/commit/1aa10365da1d277a04b4968a5e4218fc5c74b2a1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.431.0
    * @okouai/core bumped to 8.657.0

## [0.891.0](https://github.com/vm0-ai/vm0/compare/app-v0.890.0...app-v0.891.0) (2026-09-12)


### Features

* **app:** add visualization task options ([#33296](https://github.com/vm0-ai/vm0/issues/33296)) ([14e6b13](https://github.com/vm0-ai/vm0/commit/14e6b137590d53ce02c173ff99437f677410f724))


### Refactoring

* **api:** rename restricted vm0 models to restricted built-in models ([#33670](https://github.com/vm0-ai/vm0/issues/33670)) ([c07f349](https://github.com/vm0-ai/vm0/commit/c07f349dd5bf75d500939daa87569e40905b0e18))
* **api:** slim the activity-summary contract to the fields the platform reads ([#33630](https://github.com/vm0-ai/vm0/issues/33630)) ([198d38f](https://github.com/vm0-ai/vm0/commit/198d38f7a6a674672aa66c0053f40e783c424793))
* **app:** migrate the mic spinner and volume meter to utilities ([#33345](https://github.com/vm0-ai/vm0/issues/33345)) ([767110b](https://github.com/vm0-ai/vm0/commit/767110bf5c0f781dd909efd62707f6ecd960175b))
* remove graduated chat experience switches ([#33612](https://github.com/vm0-ai/vm0/issues/33612)) ([8e51714](https://github.com/vm0-ai/vm0/commit/8e517146fbe73026d88d0a3f508150ae6ddf04a2))
* remove inert retired-brand vm0 residue ([#33660](https://github.com/vm0-ai/vm0/issues/33660)) ([9c83c9b](https://github.com/vm0-ai/vm0/commit/9c83c9b87ac2f910145cd9f66c350dd7006fb23c))
* **runner:** rename sandbox-internal and preview-only x-vm0 headers ([#33663](https://github.com/vm0-ai/vm0/issues/33663)) ([9375cec](https://github.com/vm0-ai/vm0/commit/9375cec4abaa342c41b17cc54275f9cb59031b64))
* **ui:** use neutral button and select variants ([#33335](https://github.com/vm0-ai/vm0/issues/33335)) ([10212cb](https://github.com/vm0-ai/vm0/commit/10212cb80127aef11d0e12e12b0e4980e108fa98))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.430.1
    * @okouai/connectors bumped to 3.11.0
    * @okouai/core bumped to 8.656.0
    * @okouai/ui bumped to 1.8.4

## [0.890.0](https://github.com/vm0-ai/vm0/compare/app-v0.889.1...app-v0.890.0) (2026-09-12)


### Features

* add deepseek v4.1 flash ([#33591](https://github.com/vm0-ai/vm0/issues/33591)) ([b7b8854](https://github.com/vm0-ai/vm0/commit/b7b885498764b690c4a194f86da198815daae4c9))
* **artifacts:** share presigned thumbnails across composer and chat ([#33288](https://github.com/vm0-ai/vm0/issues/33288)) ([c21ce81](https://github.com/vm0-ai/vm0/commit/c21ce817535587b323a523abcef983f689365e9d))


### Bug Fixes

* **app:** show specific clerk authentication and password errors ([#33509](https://github.com/vm0-ai/vm0/issues/33509)) ([1088d9c](https://github.com/vm0-ai/vm0/commit/1088d9c6db489a743487ff3a751cdbebe18b324f))


### Refactoring

* **api:** remove the retired zero desktop auth callback schemes ([#33615](https://github.com/vm0-ai/vm0/issues/33615)) ([60653a2](https://github.com/vm0-ai/vm0/commit/60653a23fdb82dbe96a1aa2affcafdad8a8a1388))
* **platform:** remove the dead default-agent branch from the welcome thread card ([#33609](https://github.com/vm0-ai/vm0/issues/33609)) ([01eb73f](https://github.com/vm0-ai/vm0/commit/01eb73fc332a404f76ce802ab9cfb947186f98a2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.430.0
    * @okouai/core bumped to 8.655.0

## [0.889.1](https://github.com/vm0-ai/vm0/compare/app-v0.889.0...app-v0.889.1) (2026-09-12)


### Refactoring

* **platform:** route chat realtime invalidations directly ([#33586](https://github.com/vm0-ai/vm0/issues/33586)) ([a89a9b4](https://github.com/vm0-ai/vm0/commit/a89a9b45feb52774623ab2c2c9664ed5b18ccc7a))
* **platform:** simplify activity summary polling ([#33577](https://github.com/vm0-ai/vm0/issues/33577)) ([b2dc30a](https://github.com/vm0-ai/vm0/commit/b2dc30a0f22d263c4ad0a4d7f764932e38fa3aeb))
* remove expired deployment compatibility ([#33582](https://github.com/vm0-ai/vm0/issues/33582)) ([d5ae0e3](https://github.com/vm0-ai/vm0/commit/d5ae0e331d31465b7302bc63e1557420caf7358b))
* **test:** replace the remaining retired-brand agent fixtures ([#33587](https://github.com/vm0-ai/vm0/issues/33587)) ([fee7c56](https://github.com/vm0-ai/vm0/commit/fee7c56bfb3f3b62bda69a1409dbc2486e937003))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.429.1
    * @okouai/core bumped to 8.654.3

## [0.889.0](https://github.com/vm0-ai/vm0/compare/app-v0.888.0...app-v0.889.0) (2026-09-11)


### Features

* **ssh:** manage reusable key and password credentials ([#33553](https://github.com/vm0-ai/vm0/issues/33553)) ([c51d8ca](https://github.com/vm0-ai/vm0/commit/c51d8ca3cc39eb8aa1b82f3919fcc816846890c8))


### Bug Fixes

* **platform:** keep unread indicators readable when chat warming fails ([#33564](https://github.com/vm0-ai/vm0/issues/33564)) ([41842ae](https://github.com/vm0-ai/vm0/commit/41842ae3291ad9be710f540984a0f2cd53bcb88f))
* **platform:** let each chat thread list catch-up own its lifetime ([#33557](https://github.com/vm0-ai/vm0/issues/33557)) ([85b31f1](https://github.com/vm0-ai/vm0/commit/85b31f126553f3590e075ddef42d1f729ddd57a5))


### Refactoring

* **api:** emit x-okou signature headers and drop the legacy names ([#33561](https://github.com/vm0-ai/vm0/issues/33561)) ([2cdbdcf](https://github.com/vm0-ai/vm0/commit/2cdbdcf65cba3504828108a675056b4963cbe3a5))
* make activity summary polling thread-owned ([#33574](https://github.com/vm0-ai/vm0/issues/33574)) ([d568c0d](https://github.com/vm0-ai/vm0/commit/d568c0d26533336da14795d781490125da9f70bb))
* **platform:** stabilize oauth and prohibit child abort controllers ([#33573](https://github.com/vm0-ai/vm0/issues/33573)) ([ba5f919](https://github.com/vm0-ai/vm0/commit/ba5f919bcfd0c124a5633a17b8cee8cc35a86c1c))
* **platform:** stabilize workflow realtime handler ([#33333](https://github.com/vm0-ai/vm0/issues/33333)) ([65da1fc](https://github.com/vm0-ai/vm0/commit/65da1fcc06a0b2a2738cb164ce099c6a6a89a89c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.429.0
    * @okouai/connectors bumped to 3.10.0
    * @okouai/core bumped to 8.654.2

## [0.888.0](https://github.com/vm0-ai/vm0/compare/app-v0.887.1...app-v0.888.0) (2026-09-11)


### Features

* **app:** narrow the slash panel and scroll its index as one list ([#33544](https://github.com/vm0-ai/vm0/issues/33544)) ([15955e5](https://github.com/vm0-ai/vm0/commit/15955e559159871e588a068c30d922fc03f6599e))


### Bug Fixes

* **app:** write every annotation note on the image ([#33418](https://github.com/vm0-ai/vm0/issues/33418)) ([461ab76](https://github.com/vm0-ai/vm0/commit/461ab76a89de2b55b86f06f92a72afb93c6f085c))
* **guest-agent:** bound pi and codex event delivery ([#33532](https://github.com/vm0-ai/vm0/issues/33532)) ([c42da19](https://github.com/vm0-ai/vm0/commit/c42da19f700479f51954f2012106a211fe4f97c6))
* **platform:** let the composer focus veil fade past the scrollport ([#33514](https://github.com/vm0-ai/vm0/issues/33514)) ([b70d0a4](https://github.com/vm0-ai/vm0/commit/b70d0a4046487a8787b8d7b68507fa2fca717c6e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.428.2
    * @okouai/core bumped to 8.654.1

## [0.887.1](https://github.com/vm0-ai/vm0/compare/app-v0.887.0...app-v0.887.1) (2026-09-11)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.654.0

## [0.887.0](https://github.com/vm0-ai/vm0/compare/app-v0.886.0...app-v0.887.0) (2026-09-11)


### Features

* **app:** add the two-pane slash template panel behind a switch ([#33405](https://github.com/vm0-ai/vm0/issues/33405)) ([5a9d5e8](https://github.com/vm0-ai/vm0/commit/5a9d5e8022e17b4db5236c98e49e6ff7a8c7693a))
* **platform:** split the connectors page into discover and your-connectors scopes ([#33435](https://github.com/vm0-ai/vm0/issues/33435)) ([ef3a544](https://github.com/vm0-ai/vm0/commit/ef3a544e2aae690cb2b724b42a46d39896b77e77))


### Bug Fixes

* **app:** update primary buttons with the selected color theme ([#33466](https://github.com/vm0-ai/vm0/issues/33466)) ([5b41b64](https://github.com/vm0-ai/vm0/commit/5b41b6487c1c4d6d30a20453f56d1632b56d5400))
* **platform:** align pinned agent collars with okou ([#33453](https://github.com/vm0-ai/vm0/issues/33453)) ([3e4a5d0](https://github.com/vm0-ai/vm0/commit/3e4a5d0c1957d0673d3774dd585630bcde0f2833))
* **platform:** align workflow errors with recovery cards ([#33350](https://github.com/vm0-ai/vm0/issues/33350)) ([1cb0817](https://github.com/vm0-ai/vm0/commit/1cb0817c9227759e1dd04b208034f0a302f1a4bf))
* **platform:** let flyout rows clip at the panel's own edge ([#33480](https://github.com/vm0-ai/vm0/issues/33480)) ([f158889](https://github.com/vm0-ai/vm0/commit/f158889d9fc2bfbc9058eebf369753f9367b718c))
* **ssh:** allow multiple login configurations per endpoint ([#33473](https://github.com/vm0-ai/vm0/issues/33473)) ([54efc25](https://github.com/vm0-ai/vm0/commit/54efc258e9b0d6df4b9c49ed7cedb92fbe4fec44))


### Refactoring

* **test:** replace residual retired-brand fixtures and a missed comment ([#33489](https://github.com/vm0-ai/vm0/issues/33489)) ([5877266](https://github.com/vm0-ai/vm0/commit/58772661b6889713ed3b090f04adc22e0e28d711)), closes [#33475](https://github.com/vm0-ai/vm0/issues/33475)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.428.1
    * @okouai/core bumped to 8.653.0

## [0.886.0](https://github.com/vm0-ai/vm0/compare/app-v0.885.0...app-v0.886.0) (2026-09-11)


### Features

* **api:** activate shared deepseek and native claude pi routes ([#33397](https://github.com/vm0-ai/vm0/issues/33397)) ([f942995](https://github.com/vm0-ai/vm0/commit/f942995d317de177dd344a12577bb6e151c47a01))


### Bug Fixes

* **app:** contain long connector account names ([#33437](https://github.com/vm0-ai/vm0/issues/33437)) ([41fc47d](https://github.com/vm0-ai/vm0/commit/41fc47d0666cb4d694865c0bdce46657562df4bf))
* **app:** restore border contrast lost to the 0.5px hairline ([#33408](https://github.com/vm0-ai/vm0/issues/33408)) ([2ee706c](https://github.com/vm0-ai/vm0/commit/2ee706cd7e0b2e8b137aae2de8939152d4f5d308))
* **connectors:** add Mercury compliance disclosures ([#33381](https://github.com/vm0-ai/vm0/issues/33381)) ([c13be86](https://github.com/vm0-ai/vm0/commit/c13be861672a425555d9dffdf3d29da982131bd8))
* **connectors:** organize and search custom connectors in directory mode ([#33416](https://github.com/vm0-ai/vm0/issues/33416)) ([366a302](https://github.com/vm0-ai/vm0/commit/366a302f039ca55283d0d01f6f0235476cedde0a))
* **platform:** focus composer from empty input area ([#33415](https://github.com/vm0-ai/vm0/issues/33415)) ([69cdf6f](https://github.com/vm0-ai/vm0/commit/69cdf6fbdf197bfcb5f8424827c1c26b59e3a920))
* **platform:** replace onboarding avatar ([#33344](https://github.com/vm0-ai/vm0/issues/33344)) ([985f555](https://github.com/vm0-ai/vm0/commit/985f555d595866c095b4e93dc4ba9b46ce2d7a45))
* **voice:** recover completion-body provider failures ([#33403](https://github.com/vm0-ai/vm0/issues/33403)) ([1c005dd](https://github.com/vm0-ai/vm0/commit/1c005ddbb297aec5f576d4d9063f82c61d809be8))


### Refactoring

* **ui:** encapsulate dialog bodies and icon controls in components ([#33320](https://github.com/vm0-ai/vm0/issues/33320)) ([8c455be](https://github.com/vm0-ai/vm0/commit/8c455bee21f6ab9fe34e952741f62cc00bc0ce1b))
* **ui:** migrate color theme preview swatches to utilities ([#33063](https://github.com/vm0-ai/vm0/issues/33063)) ([2fe0502](https://github.com/vm0-ai/vm0/commit/2fe050253492f3df5c4546b8c54a705ecdb1f424))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.428.0
    * @okouai/core bumped to 8.652.1
    * @okouai/ui bumped to 1.8.3

## [0.885.0](https://github.com/vm0-ai/vm0/compare/app-v0.884.5...app-v0.885.0) (2026-09-11)


### Features

* **chat:** add native reasoning effort controls ([#33016](https://github.com/vm0-ai/vm0/issues/33016)) ([f649925](https://github.com/vm0-ai/vm0/commit/f649925cbb81c11ee5b66d32bcc6072fc2fe80c2))


### Bug Fixes

* **platform:** align the flyout panel's bottom with the rail card ([#33386](https://github.com/vm0-ai/vm0/issues/33386)) ([8aa8510](https://github.com/vm0-ai/vm0/commit/8aa8510f58204106578be37c9310b151466f40d3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.427.0
    * @okouai/core bumped to 8.652.0

## [0.884.5](https://github.com/vm0-ai/vm0/compare/app-v0.884.4...app-v0.884.5) (2026-09-10)


### Bug Fixes

* **platform:** restore hosted auth last-used badge ([#33334](https://github.com/vm0-ai/vm0/issues/33334)) ([f8ddf76](https://github.com/vm0-ai/vm0/commit/f8ddf76a38fd5bd0e909b6eaf462576359cfecce))


### Refactoring

* remove expired deployment compatibility ([#33343](https://github.com/vm0-ai/vm0/issues/33343)) ([f670a02](https://github.com/vm0-ai/vm0/commit/f670a0233ae13a11d43f3a2ad72ff30831cab822))


### Performance Improvements

* **platform:** unmount template gallery during previews ([#33339](https://github.com/vm0-ai/vm0/issues/33339)) ([75095c2](https://github.com/vm0-ai/vm0/commit/75095c26e72eb7deb40f5c15b920aa0764d94ceb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.426.1
    * @okouai/core bumped to 8.651.2

## [0.884.4](https://github.com/vm0-ai/vm0/compare/app-v0.884.3...app-v0.884.4) (2026-09-10)


### Refactoring

* **platform:** remove computed signal propagation ([#33330](https://github.com/vm0-ai/vm0/issues/33330)) ([c65658a](https://github.com/vm0-ai/vm0/commit/c65658aa52e160f594d799050037cc4827dfc37f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.651.1

## [0.884.3](https://github.com/vm0-ai/vm0/compare/app-v0.884.2...app-v0.884.3) (2026-09-10)


### Refactoring

* **platform:** own welcome thread creation by the settings action signal ([#33327](https://github.com/vm0-ai/vm0/issues/33327)) ([1cd0ae2](https://github.com/vm0-ai/vm0/commit/1cd0ae24f034db0360d0f43519131c1f1ea83c58))
* **platform:** restore DOM-owned chat container refs ([#33328](https://github.com/vm0-ai/vm0/issues/33328)) ([54618ed](https://github.com/vm0-ai/vm0/commit/54618ed11c8319eea57f6b657a48ac5467652ccb))

## [0.884.2](https://github.com/vm0-ai/vm0/compare/app-v0.884.1...app-v0.884.2) (2026-09-10)


### Bug Fixes

* **platform:** preserve welcome synchronization after settings dismissal ([#33306](https://github.com/vm0-ai/vm0/issues/33306)) ([4fb323c](https://github.com/vm0-ai/vm0/commit/4fb323c921126cd8bd829128989f926a6000e963))


### Refactoring

* **platform:** route voice draft observer through shared loop ([#33321](https://github.com/vm0-ai/vm0/issues/33321)) ([22005a5](https://github.com/vm0-ai/vm0/commit/22005a583bdaa308627884b07105922058710936))
* **platform:** stabilize realtime handlers ([#33325](https://github.com/vm0-ai/vm0/issues/33325)) ([d155ea2](https://github.com/vm0-ai/vm0/commit/d155ea25935ece634cb91fccf02a2333ab30e6eb))

## [0.884.1](https://github.com/vm0-ai/vm0/compare/app-v0.884.0...app-v0.884.1) (2026-09-10)


### Bug Fixes

* **auth:** restore hosted input boundaries ([#33301](https://github.com/vm0-ai/vm0/issues/33301)) ([4b4f5d4](https://github.com/vm0-ai/vm0/commit/4b4f5d498a2c024852cd7694f5f13a722d177432))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.651.0

## [0.884.0](https://github.com/vm0-ai/vm0/compare/app-v0.883.0...app-v0.884.0) (2026-09-10)


### Features

* **app:** show the template cover on the inline template chip behind a switch ([#33293](https://github.com/vm0-ai/vm0/issues/33293)) ([20d1c99](https://github.com/vm0-ai/vm0/commit/20d1c9967ec42823bf71b01366290880012dda09))
* **chat:** move selected task chips into the composer ([#33188](https://github.com/vm0-ai/vm0/issues/33188)) ([4900aee](https://github.com/vm0-ai/vm0/commit/4900aee045c28658175a01f42d25d08a78f624b5))
* enable mailchimp oauth with doppler credentials ([#33193](https://github.com/vm0-ai/vm0/issues/33193)) ([bb87ee9](https://github.com/vm0-ai/vm0/commit/bb87ee9e24001ea97fb270856cd6e010dcccf2e6))
* **lint:** prohibit nested ccstate commands ([#33166](https://github.com/vm0-ai/vm0/issues/33166)) ([fcab1ad](https://github.com/vm0-ai/vm0/commit/fcab1adf39a2157c21810604e94288455628a1fb))
* **platform:** add compact workflow result cards ([#33291](https://github.com/vm0-ai/vm0/issues/33291)) ([0f7500c](https://github.com/vm0-ai/vm0/commit/0f7500c195db2b49604535530a6dd049ec6d2513))
* **platform:** add debug welcome threads and official example previews ([#33295](https://github.com/vm0-ai/vm0/issues/33295)) ([999dc57](https://github.com/vm0-ai/vm0/commit/999dc5711d8bd7ac299a5efa30688ad542bd0b18))
* **ssh:** surface host connection failures and recovery ([#33165](https://github.com/vm0-ai/vm0/issues/33165)) ([f56df60](https://github.com/vm0-ai/vm0/commit/f56df6068d35f5591020a5bb61fb4197cb6cd820))


### Bug Fixes

* **agent:** protect default okou identity and visibility ([#33266](https://github.com/vm0-ai/vm0/issues/33266)) ([58e76a8](https://github.com/vm0-ai/vm0/commit/58e76a815bcdaa297f8ac6086b50cd10c55316eb))
* **api:** describe every category while browsing one of them ([#33292](https://github.com/vm0-ai/vm0/issues/33292)) ([1bc57b1](https://github.com/vm0-ai/vm0/commit/1bc57b173e6fdfb0ee8bacda13e4a552f2ef30c8))
* **app:** keep conversation locator interactions inside the gutter ([#33254](https://github.com/vm0-ai/vm0/issues/33254)) ([0ea0628](https://github.com/vm0-ai/vm0/commit/0ea06284d716ef9c047b46d81902883a87af3f52))
* **app:** rank compact workflow fuzzy matches first ([#33186](https://github.com/vm0-ai/vm0/issues/33186)) ([27d2b3e](https://github.com/vm0-ai/vm0/commit/27d2b3e050bce49da91532134240a929f3f9faa7))
* **app:** rework annotation notes and inline text editing ([#33006](https://github.com/vm0-ai/vm0/issues/33006)) ([57df8ac](https://github.com/vm0-ai/vm0/commit/57df8ac9e1b60d5c96b2543b593abbd4e3ef78e6))
* **app:** round permission expiry countdowns ([#33268](https://github.com/vm0-ai/vm0/issues/33268)) ([4e87038](https://github.com/vm0-ai/vm0/commit/4e87038ce61afa75b1de22ca2b48fa85f1698bb9))
* **app:** show installed status for official workflows ([#33247](https://github.com/vm0-ai/vm0/issues/33247)) ([8b2b78a](https://github.com/vm0-ai/vm0/commit/8b2b78a0b2b9daac574032aace5f313a53115aa9))
* **app:** show the whole category in the composer connector directory ([#33272](https://github.com/vm0-ai/vm0/issues/33272)) ([8b78070](https://github.com/vm0-ai/vm0/commit/8b780704d120bd80f42995a7eb4cc0cb1fe0f53a))
* **artifacts:** use a.okou.io for public file sharing ([#32959](https://github.com/vm0-ai/vm0/issues/32959)) ([50663a2](https://github.com/vm0-ai/vm0/commit/50663a2f204f55d9fe296c7767fdf7c63c4b61c7))
* **auth:** stabilize Clerk runtime binding ([#33155](https://github.com/vm0-ai/vm0/issues/33155)) ([7d58a96](https://github.com/vm0-ai/vm0/commit/7d58a96709f6d8aa8062547b0dca15be04af7c4e))
* **platform:** align recovery card icons with titles ([#33229](https://github.com/vm0-ai/vm0/issues/33229)) ([875944b](https://github.com/vm0-ai/vm0/commit/875944bddb121e76dc435bad2e338cb3b1d8e7d0))
* **platform:** align thinking status scale ([#33014](https://github.com/vm0-ai/vm0/issues/33014)) ([43bd7ed](https://github.com/vm0-ai/vm0/commit/43bd7ed8bfca1721590ffa85bf930cf9988f9f79))
* **platform:** align voice transcription layout ([#33103](https://github.com/vm0-ai/vm0/issues/33103)) ([f12532c](https://github.com/vm0-ai/vm0/commit/f12532cfbfcf9892c09fb0e49348965f1280b698))
* **platform:** open a model type's panel only after the pointer settles ([#33290](https://github.com/vm0-ai/vm0/issues/33290)) ([0f61960](https://github.com/vm0-ai/vm0/commit/0f6196009c59fc8f69b737fb38905612bc459138))
* **platform:** recover realtime subscriptions after a connection gap ([#33134](https://github.com/vm0-ai/vm0/issues/33134)) ([fc05f14](https://github.com/vm0-ai/vm0/commit/fc05f140ec37bedaa679b832b88440b93b9bcae8))
* **platform:** remove floating pinned agent drag handles ([#33232](https://github.com/vm0-ai/vm0/issues/33232)) ([802ea1b](https://github.com/vm0-ai/vm0/commit/802ea1b0272e5ea4b99f25bebc9f746cc231319d))
* **platform:** remove sidebar shells from standalone pages ([#33182](https://github.com/vm0-ai/vm0/issues/33182)) ([c9be408](https://github.com/vm0-ai/vm0/commit/c9be408218e8863c2fa03a1421cc74a7d9047d7e))
* **platform:** reset add connectors browsing state on reopen ([#33248](https://github.com/vm0-ai/vm0/issues/33248)) ([766c289](https://github.com/vm0-ai/vm0/commit/766c2894f302bcac3826f5b0566b9dac7cbb5d97))
* **platform:** reset agent deletion attempts and preserve copied workflows ([#33230](https://github.com/vm0-ai/vm0/issues/33230)) ([d29651b](https://github.com/vm0-ai/vm0/commit/d29651bb927ddfc910a275602998de534ebc3b98))
* **platform:** reset workspace deletion confirmation between attempts ([#33242](https://github.com/vm0-ai/vm0/issues/33242)) ([a54fc2d](https://github.com/vm0-ai/vm0/commit/a54fc2d110a7ce56c38a99639eab24b43a0c002d))


### Refactoring

* **app:** give the product one border-width token ([#33269](https://github.com/vm0-ai/vm0/issues/33269)) ([e18b803](https://github.com/vm0-ai/vm0/commit/e18b8031c60cc90efb727267cbc18b4d17177d6b))
* **app:** simplify thinking summary demand ([#33170](https://github.com/vm0-ai/vm0/issues/33170)) ([985dad1](https://github.com/vm0-ai/vm0/commit/985dad1cab2eb8bbbbc5290790e99deeb659275e))
* **platform:** migrate chat emoji font styling ([#33233](https://github.com/vm0-ai/vm0/issues/33233)) ([8898a45](https://github.com/vm0-ai/vm0/commit/8898a4588bdee88e15db8ca0e78d412511ccfb23))
* **platform:** remove chat preference submission state ([#33162](https://github.com/vm0-ai/vm0/issues/33162)) ([91fa524](https://github.com/vm0-ai/vm0/commit/91fa5247a8a24dbe1f5975bcdcb5e9598f9b745a))
* **platform:** split attachment url signals ([#33171](https://github.com/vm0-ai/vm0/issues/33171)) ([6e595b5](https://github.com/vm0-ai/vm0/commit/6e595b53cad4f43fb8099e74c8409c902e66c268))
* **ui:** migrate settings select surfaces to utilities ([#33231](https://github.com/vm0-ai/vm0/issues/33231)) ([fc8dfd5](https://github.com/vm0-ai/vm0/commit/fc8dfd5b37c9312beece8ecdae02cfb550536bbd))
* **ui:** replace the badge, pill, and divider selectors with a shared badge component ([#33246](https://github.com/vm0-ai/vm0/issues/33246)) ([c3b8551](https://github.com/vm0-ai/vm0/commit/c3b85519e88af6b2af3eb854cd31ce1ba107903d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.426.0
    * @okouai/connectors bumped to 3.9.0
    * @okouai/core bumped to 8.650.0
    * @okouai/ui bumped to 1.8.2

## [0.883.0](https://github.com/vm0-ai/vm0/compare/app-v0.882.5...app-v0.883.0) (2026-09-10)


### Features

* **api:** answer a named category with the whole category ([#33112](https://github.com/vm0-ai/vm0/issues/33112)) ([04d3c7e](https://github.com/vm0-ai/vm0/commit/04d3c7e5b600b195e272e80b2bcef2b66ffc7c26))
* **api:** hand the intro-video skill its entry form and name it intro video everywhere ([#33119](https://github.com/vm0-ai/vm0/issues/33119)) ([850ec24](https://github.com/vm0-ai/vm0/commit/850ec247513051216bc44da4b246fd047fcb0ceb))
* **chat:** move create scene picker inside composer ([#33142](https://github.com/vm0-ai/vm0/issues/33142)) ([69ce756](https://github.com/vm0-ai/vm0/commit/69ce756134d89812981974944bf3399368434e0e))


### Bug Fixes

* **connectors:** place remote access before custom connectors ([#33106](https://github.com/vm0-ai/vm0/issues/33106)) ([e5e5207](https://github.com/vm0-ai/vm0/commit/e5e52075f4f2285ebaf93bd62b61465d91f05b9e))
* **platform:** exclude folded history from thread shares ([#33060](https://github.com/vm0-ai/vm0/issues/33060)) ([ded08cc](https://github.com/vm0-ai/vm0/commit/ded08cccea06e34792b3b6014685e91be1de119c))
* **platform:** match the flyout panel's surface and close it on selection ([#33102](https://github.com/vm0-ai/vm0/issues/33102)) ([96ec51e](https://github.com/vm0-ai/vm0/commit/96ec51e06505ea20e54ab89a5fc604aa41d56d61))
* **platform:** stop reporting webkit media-controls errors from chat pages ([#33109](https://github.com/vm0-ai/vm0/issues/33109)) ([d721acc](https://github.com/vm0-ai/vm0/commit/d721acc86bf4f96ff0cce69ab9116d231800791c))


### Refactoring

* **ads:** normalize okou attribution with rollout compatibility ([#33149](https://github.com/vm0-ai/vm0/issues/33149)) ([a222108](https://github.com/vm0-ai/vm0/commit/a222108b4eccfdab77fa3f6f3c08fa6ea2bdfac7))
* **app:** migrate monochrome icon filter to dark utility ([#33062](https://github.com/vm0-ai/vm0/issues/33062)) ([460ff68](https://github.com/vm0-ai/vm0/commit/460ff6855c77a5eba0ecf1c9966bb5bbc8d29885))
* **ui:** migrate tone preview surfaces to utilities ([#33133](https://github.com/vm0-ai/vm0/issues/33133)) ([80a4de0](https://github.com/vm0-ai/vm0/commit/80a4de051f55ccc890d99aaa1310cd7ed8e366b1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.425.0
    * @okouai/core bumped to 8.649.0

## [0.882.5](https://github.com/vm0-ai/vm0/compare/app-v0.882.4...app-v0.882.5) (2026-09-10)


### Bug Fixes

* **platform:** stabilize voice composer layout ([#33058](https://github.com/vm0-ai/vm0/issues/33058)) ([724dc63](https://github.com/vm0-ai/vm0/commit/724dc63d33064e66f8a41e0bef6ad54e345ef94a))


### Refactoring

* **ui:** share button foundation with toggle controls ([#32958](https://github.com/vm0-ai/vm0/issues/32958)) ([29dfab1](https://github.com/vm0-ai/vm0/commit/29dfab14531307e67d16322d5fa3972df9c42a99))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/ui bumped to 1.8.1

## [0.882.4](https://github.com/vm0-ai/vm0/compare/app-v0.882.3...app-v0.882.4) (2026-09-10)


### Refactoring

* **auth:** remove obsolete Clerk domain plumbing ([#33053](https://github.com/vm0-ai/vm0/issues/33053)) ([baa6e4c](https://github.com/vm0-ai/vm0/commit/baa6e4c1f12b712e6e50dcf13e24e84cc77c8ecd))

## [0.882.3](https://github.com/vm0-ai/vm0/compare/app-v0.882.2...app-v0.882.3) (2026-09-09)


### Refactoring

* **platform:** govern browser storage ([#33047](https://github.com/vm0-ai/vm0/issues/33047)) ([1ee4c10](https://github.com/vm0-ai/vm0/commit/1ee4c1063d0343fd22f424a95d3d93bf27713946))
* remove retired goal cli and completed recovery entry ([#33054](https://github.com/vm0-ai/vm0/issues/33054)) ([095f1b2](https://github.com/vm0-ai/vm0/commit/095f1b2733e1e01ccaac881d5636db4d262c8369))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.424.2
    * @okouai/connectors bumped to 3.8.9
    * @okouai/core bumped to 8.648.3

## [0.882.2](https://github.com/vm0-ai/vm0/compare/app-v0.882.1...app-v0.882.2) (2026-09-09)


### Bug Fixes

* **auth:** keep Clerk V1 path navigation in app ([#33046](https://github.com/vm0-ai/vm0/issues/33046)) ([ecf8518](https://github.com/vm0-ai/vm0/commit/ecf8518d8e98964f594174ceab7186c3862a14f4))
* **platform:** move mobile chat pin into menu ([#33048](https://github.com/vm0-ai/vm0/issues/33048)) ([28c0fcd](https://github.com/vm0-ai/vm0/commit/28c0fcd80102630cad15d7869c92875caf7714dd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.424.1
    * @okouai/core bumped to 8.648.2

## [0.882.1](https://github.com/vm0-ai/vm0/compare/app-v0.882.0...app-v0.882.1) (2026-09-09)


### Bug Fixes

* remove obsolete brand tombstones ([#33049](https://github.com/vm0-ai/vm0/issues/33049)) ([0b757ba](https://github.com/vm0-ai/vm0/commit/0b757ba3de7fc497cbc8c9a02ad461a30314dc01))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.648.1

## [0.882.0](https://github.com/vm0-ai/vm0/compare/app-v0.881.1...app-v0.882.0) (2026-09-09)


### Features

* **chat:** poll thinking summaries from thread subscriptions ([#33040](https://github.com/vm0-ai/vm0/issues/33040)) ([53d3529](https://github.com/vm0-ai/vm0/commit/53d3529abdb3adf52a464018fb1127f9149c391c))


### Bug Fixes

* **auth:** keep signup background pinned while scrolling ([#33037](https://github.com/vm0-ai/vm0/issues/33037)) ([0842cdc](https://github.com/vm0-ai/vm0/commit/0842cdcca59ab3b4a192026ac8679d572d8f6f00))
* **auth:** restore v1 email code styling ([#33038](https://github.com/vm0-ai/vm0/issues/33038)) ([0836a68](https://github.com/vm0-ai/vm0/commit/0836a68fbdf10e207768acb62bbd8ff0cb29aae0))
* **platform:** clear shortcut hints on window blur ([#33045](https://github.com/vm0-ai/vm0/issues/33045)) ([25cf060](https://github.com/vm0-ai/vm0/commit/25cf060d3210d30ae83ed827d8dbea87b8cab31b))
* **platform:** prompt refresh on shared worker failures ([#33043](https://github.com/vm0-ai/vm0/issues/33043)) ([c10e2cd](https://github.com/vm0-ai/vm0/commit/c10e2cda427ce8be0905ad5da6b34c335f11861f))


### Refactoring

* **platform:** replace shared worker locks with heartbeats ([#33044](https://github.com/vm0-ai/vm0/issues/33044)) ([5f20f42](https://github.com/vm0-ai/vm0/commit/5f20f424bca96d008ae498a19526d4e50a66a8a0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.424.0
    * @okouai/core bumped to 8.648.0
    * @okouai/ui bumped to 1.8.0

## [0.881.1](https://github.com/vm0-ai/vm0/compare/app-v0.881.0...app-v0.881.1) (2026-09-09)


### Bug Fixes

* **platform:** open the default agent from home ([#33033](https://github.com/vm0-ai/vm0/issues/33033)) ([13d77f6](https://github.com/vm0-ai/vm0/commit/13d77f6d022469f71e37350efc380536401f23ef))

## [0.881.0](https://github.com/vm0-ai/vm0/compare/app-v0.880.0...app-v0.881.0) (2026-09-09)


### Features

* **platform:** show chat menu shortcuts ([#33032](https://github.com/vm0-ai/vm0/issues/33032)) ([8b95a20](https://github.com/vm0-ai/vm0/commit/8b95a20d3d20a866def0152f8b9092cf156fa332))

## [0.880.0](https://github.com/vm0-ai/vm0/compare/app-v0.879.0...app-v0.880.0) (2026-09-09)


### Features

* **auth:** add clerk ui v1 comparison routes ([#32278](https://github.com/vm0-ai/vm0/issues/32278)) ([0c694da](https://github.com/vm0-ai/vm0/commit/0c694da01b1d49bc9a008bc79d64a91a30c28114))


### Bug Fixes

* **ssh:** restore chat directory setup and keyboard activation ([#33027](https://github.com/vm0-ai/vm0/issues/33027)) ([80d0069](https://github.com/vm0-ai/vm0/commit/80d006954fc26eb46d4175c20912874410b1805b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/ui bumped to 1.7.0

## [0.879.0](https://github.com/vm0-ai/vm0/compare/app-v0.878.0...app-v0.879.0) (2026-09-09)


### Features

* **app:** make the connectors page a directory with a category filter ([#33020](https://github.com/vm0-ai/vm0/issues/33020)) ([35ebec4](https://github.com/vm0-ai/vm0/commit/35ebec41dd725706b66bd057ae146a5123b83206))
* enable intro video for the team ([#32984](https://github.com/vm0-ai/vm0/issues/32984)) ([a6ddc2c](https://github.com/vm0-ai/vm0/commit/a6ddc2c48d050ab204d37dcb7515f2ee8722a4bd))
* **ssh:** add owner controls and agent ssh commands ([#32722](https://github.com/vm0-ai/vm0/issues/32722)) ([0c27252](https://github.com/vm0-ai/vm0/commit/0c27252592810ab55baa97169773056a7453ab30))


### Bug Fixes

* **app:** keep the image annotation editor the size of the preview it replaces ([#32975](https://github.com/vm0-ai/vm0/issues/32975)) ([1780b61](https://github.com/vm0-ai/vm0/commit/1780b61b36fc478bd3ca123f5167db471841919a))
* **app:** name and count connector category chips from discovery ([#33015](https://github.com/vm0-ai/vm0/issues/33015)) ([1957bea](https://github.com/vm0-ai/vm0/commit/1957bea6fecf1c66f2e7b64f50c9bd6661919171))
* **app:** simplify error recovery card layout ([#32993](https://github.com/vm0-ai/vm0/issues/32993)) ([fe357e0](https://github.com/vm0-ai/vm0/commit/fe357e0069f51375b9632b9b2283ca4ee982ff63))
* **platform:** refine voice input footer ([#32925](https://github.com/vm0-ai/vm0/issues/32925)) ([dfc4f6e](https://github.com/vm0-ai/vm0/commit/dfc4f6e4d6c03490b1c5882c7c353cf85c81d2d7))
* **platform:** use the popover surface and keep the flyout panel on screen ([#33018](https://github.com/vm0-ai/vm0/issues/33018)) ([19187de](https://github.com/vm0-ai/vm0/commit/19187deea42dd6a3f6e86d7c1f241cc463faccad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.423.0
    * @okouai/core bumped to 8.647.0

## [0.878.0](https://github.com/vm0-ai/vm0/compare/app-v0.877.0...app-v0.878.0) (2026-09-09)


### Features

* **app:** put the connector shelves on cards and drop the yours tab ([#33003](https://github.com/vm0-ai/vm0/issues/33003)) ([768f745](https://github.com/vm0-ai/vm0/commit/768f745c7647760dede6492beb30965eea7bee69))


### Bug Fixes

* **artifacts:** renew private previews on demand ([#32977](https://github.com/vm0-ai/vm0/issues/32977)) ([bc0a009](https://github.com/vm0-ai/vm0/commit/bc0a009965fb966f60b78902003984751fb76f6a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.422.2
    * @okouai/core bumped to 8.646.1

## [0.877.0](https://github.com/vm0-ai/vm0/compare/app-v0.876.0...app-v0.877.0) (2026-09-09)


### Features

* **app:** browse connectors as shelves in the directory and the connectors page ([#32997](https://github.com/vm0-ai/vm0/issues/32997)) ([f4556fb](https://github.com/vm0-ai/vm0/commit/f4556fb19e9ed6678259d7e7a333d047cf19c567))
* **platform:** add built-in welcome thread ([#30147](https://github.com/vm0-ai/vm0/issues/30147)) ([85ca994](https://github.com/vm0-ai/vm0/commit/85ca9949a4589e12b48f0d9fda565c3748c998ba))


### Bug Fixes

* **app:** use one thinking fallback for activity summaries ([#33000](https://github.com/vm0-ai/vm0/issues/33000)) ([bf1f9eb](https://github.com/vm0-ai/vm0/commit/bf1f9ebcd4c3fc98da52961d546b3a7672aedec1)), closes [#32998](https://github.com/vm0-ai/vm0/issues/32998) [#32819](https://github.com/vm0-ai/vm0/issues/32819)
* **platform:** align assistant response layout ([#32879](https://github.com/vm0-ai/vm0/issues/32879)) ([b148b3b](https://github.com/vm0-ai/vm0/commit/b148b3ba3d78190b7c79b9668b3edc1ca0da3a38))
* **platform:** preserve pinned agent drag feedback ([#32938](https://github.com/vm0-ai/vm0/issues/32938)) ([45affe8](https://github.com/vm0-ai/vm0/commit/45affe86370781e7b202e4998923eaf3fb57cbf5))


### Refactoring

* **db:** stop reading and writing computer use host client product ([#32987](https://github.com/vm0-ai/vm0/issues/32987)) ([c501560](https://github.com/vm0-ai/vm0/commit/c5015603f16a7e601dc156f8bd6a24f1e261a846)), closes [#32966](https://github.com/vm0-ai/vm0/issues/32966)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.422.1
    * @okouai/connectors bumped to 3.8.8
    * @okouai/core bumped to 8.646.0

## [0.876.0](https://github.com/vm0-ai/vm0/compare/app-v0.875.0...app-v0.876.0) (2026-09-09)


### Features

* **api:** rank connector discovery and give every category a slice ([#32927](https://github.com/vm0-ai/vm0/issues/32927)) ([571b67f](https://github.com/vm0-ai/vm0/commit/571b67ff4bc5848abed2aa91061e33b0f517ae0a))
* **chat:** persist model-aware reasoning effort selections ([#32926](https://github.com/vm0-ai/vm0/issues/32926)) ([5802f5b](https://github.com/vm0-ai/vm0/commit/5802f5ba59d8d47865139dccd1f49acdf50a2a02))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.422.0
    * @okouai/core bumped to 8.645.0

## [0.875.0](https://github.com/vm0-ai/vm0/compare/app-v0.874.0...app-v0.875.0) (2026-09-09)


### Features

* add email subscription management to morning brief preferences ([#32933](https://github.com/vm0-ai/vm0/issues/32933)) ([e114cb8](https://github.com/vm0-ai/vm0/commit/e114cb8c9be99fbaf0513bece90d02736ce43b2e))
* display automation times in agent and browser timezones ([#32899](https://github.com/vm0-ai/vm0/issues/32899)) ([98d2ec1](https://github.com/vm0-ai/vm0/commit/98d2ec14f6f36170b904ebfd40204d58050e252d))
* support fuzzy workflow command matching ([#32930](https://github.com/vm0-ai/vm0/issues/32930)) ([550b15a](https://github.com/vm0-ai/vm0/commit/550b15a978b97e0715f48304361679169f2bd87e))


### Bug Fixes

* **platform:** lazy-load katex from the app bundle ([#32809](https://github.com/vm0-ai/vm0/issues/32809)) ([8f0440c](https://github.com/vm0-ai/vm0/commit/8f0440ca0009ddbfae9bb03968e011538407999c))


### Refactoring

* **connectors:** require browser oauth attempt ids ([#32960](https://github.com/vm0-ai/vm0/issues/32960)) ([6e74f9a](https://github.com/vm0-ai/vm0/commit/6e74f9aca7e9e180c95cb5321b46cb641af6896e))
* **platform:** remove desktop product badge from computer use host rows ([#32952](https://github.com/vm0-ai/vm0/issues/32952)) ([36e8ec7](https://github.com/vm0-ai/vm0/commit/36e8ec7929cde580326559715a36e651a4b2a03d)), closes [#32949](https://github.com/vm0-ai/vm0/issues/32949)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.421.0
    * @okouai/core bumped to 8.644.0

## [0.874.0](https://github.com/vm0-ai/vm0/compare/app-v0.873.0...app-v0.874.0) (2026-09-09)


### Features

* **web-chat:** lay out mobile follow-ups as a horizontal quick reply rail ([#32916](https://github.com/vm0-ai/vm0/issues/32916)) ([2a0245c](https://github.com/vm0-ai/vm0/commit/2a0245c5bfe062996a15400df5f625570f29c0db))


### Bug Fixes

* **ads:** route browser conversions by verified account ownership ([#32902](https://github.com/vm0-ai/vm0/issues/32902)) ([bb561b8](https://github.com/vm0-ai/vm0/commit/bb561b8ee07aa5c8ae4bcddfadc633e9900ad550))
* lighten chat header pin controls ([#32922](https://github.com/vm0-ai/vm0/issues/32922)) ([5f07dad](https://github.com/vm0-ai/vm0/commit/5f07dadccb8706e707eab4be8ca069a4b85edf13))
* **voice:** recover transient provider capacity failures ([#32918](https://github.com/vm0-ai/vm0/issues/32918)) ([6600861](https://github.com/vm0-ai/vm0/commit/660086182f9ecf4a7f67eb8cf43166af2071dbf6))


### Refactoring

* **app:** migrate agent tone choices to shared control ([#32873](https://github.com/vm0-ai/vm0/issues/32873)) ([cd00125](https://github.com/vm0-ai/vm0/commit/cd0012572ce91c992d330c1599961e4248207303))
* **platform:** remove page visibility and reconnect recovery ([#32861](https://github.com/vm0-ai/vm0/issues/32861)) ([ed4e519](https://github.com/vm0-ai/vm0/commit/ed4e5193b70610b70a4fc1a15ef0370882a853af))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.420.3
    * @okouai/connectors bumped to 3.8.7
    * @okouai/core bumped to 8.643.0
    * @okouai/ui bumped to 1.6.9

## [0.873.0](https://github.com/vm0-ai/vm0/compare/app-v0.872.0...app-v0.873.0) (2026-09-09)


### Features

* send presentation slide counts in additional info ([#32887](https://github.com/vm0-ai/vm0/issues/32887)) ([6a0746b](https://github.com/vm0-ai/vm0/commit/6a0746bb167dfc693674cdc5eed8e850933e8812))


### Bug Fixes

* **app:** rename slides task chip to presentation ([#32905](https://github.com/vm0-ai/vm0/issues/32905)) ([eaf0fbf](https://github.com/vm0-ai/vm0/commit/eaf0fbfa49920d5eda5f9c86bb2c72c8f758b1a7))
* **connectors:** verify browser oauth completion by attempt ([#32880](https://github.com/vm0-ai/vm0/issues/32880)) ([b328433](https://github.com/vm0-ai/vm0/commit/b328433c0c4c17f3bd7e0a4dee9f349e9d6d6b1a))
* **platform:** add opt-in custom touch selection in chat ([#32045](https://github.com/vm0-ai/vm0/issues/32045)) ([4d4f6b7](https://github.com/vm0-ai/vm0/commit/4d4f6b78893a82caa720a150b5416eed105e709b))
* **platform:** isolate markdown display parsing ([#32662](https://github.com/vm0-ai/vm0/issues/32662)) ([8383ab2](https://github.com/vm0-ai/vm0/commit/8383ab277064340fac9256f9bf3a691f01a56968))
* **platform:** show minutes in chat run durations over an hour ([#32882](https://github.com/vm0-ai/vm0/issues/32882)) ([fd6bae7](https://github.com/vm0-ai/vm0/commit/fd6bae7e1d4b0ada9308bc051e71bff65b6772d3)), closes [#32881](https://github.com/vm0-ai/vm0/issues/32881)


### Refactoring

* **app:** replace legacy card styles with typed surfaces ([#32604](https://github.com/vm0-ai/vm0/issues/32604)) ([a4abff8](https://github.com/vm0-ai/vm0/commit/a4abff8ecd382a0051d5ccaace5de4d76ed899f9))
* remove chat desktop selection feature switch ([#32894](https://github.com/vm0-ai/vm0/issues/32894)) ([2bd3fc5](https://github.com/vm0-ai/vm0/commit/2bd3fc51412b398b1214c31b4a45d190aa375ac3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.420.2
    * @okouai/core bumped to 8.642.1
    * @okouai/ui bumped to 1.6.8

## [0.872.0](https://github.com/vm0-ai/vm0/compare/app-v0.871.0...app-v0.872.0) (2026-09-09)


### Features

* add pin controls to chat thread headers ([#32867](https://github.com/vm0-ai/vm0/issues/32867)) ([6e36691](https://github.com/vm0-ai/vm0/commit/6e3669108941cbc17fbeb41865d82fd4d8454029))
* **app:** add lightweight composer task chips behind a switch ([#32698](https://github.com/vm0-ai/vm0/issues/32698)) ([b95ee8c](https://github.com/vm0-ai/vm0/commit/b95ee8c26bccebccc7ee8b113e837dbfbd535523))


### Bug Fixes

* **app:** connector directory chip metrics and footer ([#32794](https://github.com/vm0-ai/vm0/issues/32794)) ([b2d6e43](https://github.com/vm0-ai/vm0/commit/b2d6e43aa259351c7a26906b3039be88a9f1aee9))
* **platform:** illustrate empty credit balance ([#32866](https://github.com/vm0-ai/vm0/issues/32866)) ([9da8218](https://github.com/vm0-ai/vm0/commit/9da8218db8b78940c71c675a3004b9ba7cfe4734))
* **platform:** move avatar heads to the chin baseline instead of resizing them ([#32825](https://github.com/vm0-ai/vm0/issues/32825)) ([45ea514](https://github.com/vm0-ai/vm0/commit/45ea514eb8700e1997acfe521037d50f445ec0d0))
* preserve composer context as hidden additional info ([#32782](https://github.com/vm0-ai/vm0/issues/32782)) ([ff22c3b](https://github.com/vm0-ai/vm0/commit/ff22c3bedc2784c46bc6f9bcc3a3731a6f5b404f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.420.1
    * @okouai/core bumped to 8.642.0

## [0.871.0](https://github.com/vm0-ai/vm0/compare/app-v0.870.0...app-v0.871.0) (2026-09-09)


### Features

* add presentation slide count picker ui ([#32781](https://github.com/vm0-ai/vm0/issues/32781)) ([4c7f710](https://github.com/vm0-ai/vm0/commit/4c7f7109123b37efe236b48c7a3c5c9c6cca479d))


### Bug Fixes

* preserve google ads first-touch attribution ([#32833](https://github.com/vm0-ai/vm0/issues/32833)) ([94b41ea](https://github.com/vm0-ai/vm0/commit/94b41ea4bdf9990eaebf7cc6cd9cceb54e92e9b5))
* preserve literal goal archives across historical readers ([#32852](https://github.com/vm0-ai/vm0/issues/32852)) ([cede9cb](https://github.com/vm0-ai/vm0/commit/cede9cbfb62872ddabb705de852dc6fd81a3cc6d))


### Refactoring

* **ui:** migrate settings choices to shared utilities ([#32843](https://github.com/vm0-ai/vm0/issues/32843)) ([afe297e](https://github.com/vm0-ai/vm0/commit/afe297e93dea741a95527536db8f9c16a36110e6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.420.0
    * @okouai/core bumped to 8.641.1
    * @okouai/ui bumped to 1.6.7

## [0.870.0](https://github.com/vm0-ai/vm0/compare/app-v0.869.1...app-v0.870.0) (2026-09-09)


### Features

* **artifacts:** add explicit organization and public sharing ([#32721](https://github.com/vm0-ai/vm0/issues/32721)) ([0b1a54a](https://github.com/vm0-ai/vm0/commit/0b1a54a43889c361c4a47669923ca5c5c4d909bf))
* **web-chat:** render mobile follow-ups as quick replies ([#32817](https://github.com/vm0-ai/vm0/issues/32817)) ([ff05a2e](https://github.com/vm0-ai/vm0/commit/ff05a2e71c346d460c74166d497b057b3c8f264f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.419.0
    * @okouai/connectors bumped to 3.8.6
    * @okouai/core bumped to 8.641.0

## [0.869.1](https://github.com/vm0-ai/vm0/compare/app-v0.869.0...app-v0.869.1) (2026-09-09)


### Bug Fixes

* **api:** cap chat search at 25 and bound sparse keyword scans ([#32767](https://github.com/vm0-ai/vm0/issues/32767)) ([0e7fdb7](https://github.com/vm0-ai/vm0/commit/0e7fdb77c421152675528b82feeb698fd95b29d6))
* **platform:** align composer focus and connector borders ([#32701](https://github.com/vm0-ai/vm0/issues/32701)) ([8dfdc75](https://github.com/vm0-ai/vm0/commit/8dfdc75666353ff056b155c5ebc257f8c7b2b7f2))


### Refactoring

* finish brand retirement cleanup ([#32728](https://github.com/vm0-ai/vm0/issues/32728)) ([6254182](https://github.com/vm0-ai/vm0/commit/62541820a08410060d6cfde83887e17fa7a86429))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.418.2
    * @okouai/core bumped to 8.640.1
    * @okouai/ui bumped to 1.6.6

## [0.869.0](https://github.com/vm0-ai/vm0/compare/app-v0.868.1...app-v0.869.0) (2026-09-09)


### Features

* **platform:** frame every avatar to one size in its box ([#32766](https://github.com/vm0-ai/vm0/issues/32766)) ([90c14bb](https://github.com/vm0-ai/vm0/commit/90c14bb0f0374714cf14ecb1b41762eabb940708))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.640.0

## [0.868.1](https://github.com/vm0-ai/vm0/compare/app-v0.868.0...app-v0.868.1) (2026-09-09)


### Bug Fixes

* **platform:** drop the dashed outline on a selected freehand stroke ([#32735](https://github.com/vm0-ai/vm0/issues/32735)) ([79896cd](https://github.com/vm0-ai/vm0/commit/79896cde1145c44abdba9ae62b13e94f791f7c51))

## [0.868.0](https://github.com/vm0-ai/vm0/compare/app-v0.867.1...app-v0.868.0) (2026-09-09)


### Features

* **app:** add the connector directory behind a feature switch ([#32703](https://github.com/vm0-ai/vm0/issues/32703)) ([b671bb4](https://github.com/vm0-ai/vm0/commit/b671bb4ad7e3fba6e154a66b2cce71323a4c4d82))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.639.0

## [0.867.1](https://github.com/vm0-ai/vm0/compare/app-v0.867.0...app-v0.867.1) (2026-09-09)


### Refactoring

* **platform:** remove chat run work folding switch ([#32727](https://github.com/vm0-ai/vm0/issues/32727)) ([1357f20](https://github.com/vm0-ai/vm0/commit/1357f20a71a4ddfad029682d776826593492f0cc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.418.1
    * @okouai/connectors bumped to 3.8.5
    * @okouai/core bumped to 8.638.1

## [0.867.0](https://github.com/vm0-ai/vm0/compare/app-v0.866.1...app-v0.867.0) (2026-09-08)


### Features

* **artifacts:** add private html hosting and isolated previews ([#32716](https://github.com/vm0-ai/vm0/issues/32716)) ([168c385](https://github.com/vm0-ai/vm0/commit/168c385c6bf192250fb42f46abff72e53e0e8aed))


### Bug Fixes

* **app:** reset agent instructions editor on discard ([#32674](https://github.com/vm0-ai/vm0/issues/32674)) ([7f52d90](https://github.com/vm0-ai/vm0/commit/7f52d90aee56e895c55bb79d176a6e296ad04409))
* finish okou brand cleanup ([#32684](https://github.com/vm0-ai/vm0/issues/32684)) ([7d239a4](https://github.com/vm0-ai/vm0/commit/7d239a41a5dd6dd41ed7c22cd9e5dae566fc1925))
* **platform:** show connector progress only when feedback is missing ([#32602](https://github.com/vm0-ai/vm0/issues/32602)) ([9f6cc7c](https://github.com/vm0-ai/vm0/commit/9f6cc7cff0a3837627da0a1839454e8108a99460))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.418.0
    * @okouai/core bumped to 8.638.0

## [0.866.1](https://github.com/vm0-ai/vm0/compare/app-v0.866.0...app-v0.866.1) (2026-09-08)


### Bug Fixes

* **platform:** collapse nonempty chat work history by default ([#32690](https://github.com/vm0-ai/vm0/issues/32690)) ([c6894cb](https://github.com/vm0-ai/vm0/commit/c6894cba3b4678d6f6523ec19c243e6dd4611ff3))
* **platform:** keep sidebar scrolling stable and reorder pins through menus ([#32688](https://github.com/vm0-ai/vm0/issues/32688)) ([232704f](https://github.com/vm0-ai/vm0/commit/232704f8fa63267630e296810a3b31e0d9b6b37c))
* **ui:** unify base ui popup transitions ([#32669](https://github.com/vm0-ai/vm0/issues/32669)) ([c46e160](https://github.com/vm0-ai/vm0/commit/c46e160427dbf8bdd29d81a08cf7177843542f2a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.417.1
    * @okouai/core bumped to 8.637.2
    * @okouai/ui bumped to 1.6.5

## [0.866.0](https://github.com/vm0-ai/vm0/compare/app-v0.865.0...app-v0.866.0) (2026-09-08)


### Features

* **platform:** show the run framework in runner diagnostics ([#32671](https://github.com/vm0-ai/vm0/issues/32671)) ([8fe8e5b](https://github.com/vm0-ai/vm0/commit/8fe8e5bbabecc843edfb6d69d65da53e8ec720d9))


### Bug Fixes

* **ui:** use native base ui focus and image preview lifecycle ([#32574](https://github.com/vm0-ai/vm0/issues/32574)) ([712ce89](https://github.com/vm0-ai/vm0/commit/712ce890d2a8ff515b01b044f3ee489e9e5d5b9e))


### Refactoring

* remove presentation templates feature switch ([#32664](https://github.com/vm0-ai/vm0/issues/32664)) ([136add4](https://github.com/vm0-ai/vm0/commit/136add49f199cc0df10e826ed15885fb4767dc87))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.637.1
    * @okouai/ui bumped to 1.6.4

## [0.865.0](https://github.com/vm0-ai/vm0/compare/app-v0.864.0...app-v0.865.0) (2026-09-08)


### Features

* **app:** add creative and explainer video template categories ([#32613](https://github.com/vm0-ai/vm0/issues/32613)) ([9546d35](https://github.com/vm0-ai/vm0/commit/9546d35d6075efa635925c5ce37f54b3ef351032))


### Bug Fixes

* **platform:** align connector account rename controls ([#32679](https://github.com/vm0-ai/vm0/issues/32679)) ([edac9ff](https://github.com/vm0-ai/vm0/commit/edac9ffa0440d927c5bd64a9a43b93b0fdf07fd5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.417.0
    * @okouai/core bumped to 8.637.0
    * @okouai/ui bumped to 1.6.3

## [0.864.0](https://github.com/vm0-ai/vm0/compare/app-v0.863.1...app-v0.864.0) (2026-09-08)


### Features

* add usage pack visibility for pro and team plans ([#32595](https://github.com/vm0-ai/vm0/issues/32595)) ([65ac051](https://github.com/vm0-ai/vm0/commit/65ac0518bde2310887470cb0874aeae06c0c0397))
* **platform:** add okou locale fallbacks ([#31606](https://github.com/vm0-ai/vm0/issues/31606)) ([2c9c5f4](https://github.com/vm0-ai/vm0/commit/2c9c5f46687a8b7671f3d00e4371194714c30989))
* **platform:** render agent message math ([#32362](https://github.com/vm0-ai/vm0/issues/32362)) ([e227a45](https://github.com/vm0-ai/vm0/commit/e227a458753ada578e5d51b40dc30f1fd496959f))


### Bug Fixes

* **platform:** align run work history presentation ([#32630](https://github.com/vm0-ai/vm0/issues/32630)) ([1f6b47a](https://github.com/vm0-ai/vm0/commit/1f6b47a97c9d2b6c82c4397efd125aa5bb951794))
* **platform:** make annotation arrows and strokes editable ([#32624](https://github.com/vm0-ai/vm0/issues/32624)) ([cc207f9](https://github.com/vm0-ai/vm0/commit/cc207f98fdb1c6d5d82156d586bfcb6f49c931da))


### Refactoring

* remove shared worker realtime feature switch ([#32616](https://github.com/vm0-ai/vm0/issues/32616)) ([38cc9cf](https://github.com/vm0-ai/vm0/commit/38cc9cf1a2d19a3290c7b9fcc3500c8b5df14680))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.416.0
    * @okouai/core bumped to 8.636.0

## [0.863.1](https://github.com/vm0-ai/vm0/compare/app-v0.863.0...app-v0.863.1) (2026-09-08)


### Refactoring

* **naming:** neutralize private constants and refresh developer branding ([#32619](https://github.com/vm0-ai/vm0/issues/32619)) ([9eb06e3](https://github.com/vm0-ai/vm0/commit/9eb06e348ade35a05771dff4209e0cb75ac6d6b8)), closes [#32601](https://github.com/vm0-ai/vm0/issues/32601)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.415.2
    * @okouai/connectors bumped to 3.8.4
    * @okouai/core bumped to 8.635.2
    * @okouai/ui bumped to 1.6.2

## [0.863.0](https://github.com/vm0-ai/vm0/compare/app-v0.862.8...app-v0.863.0) (2026-09-08)


### Features

* **platform:** add related artifacts dialog ([#32505](https://github.com/vm0-ai/vm0/issues/32505)) ([b47a771](https://github.com/vm0-ai/vm0/commit/b47a771269cc545c8f6dc216903e943930795272))


### Bug Fixes

* **platform:** clean up abort listeners in polling delays ([#32566](https://github.com/vm0-ai/vm0/issues/32566)) ([fe57f9e](https://github.com/vm0-ai/vm0/commit/fe57f9eb1df389c1e4d1e396e96f29f9114a4d90))


### Refactoring

* serve only the okou.ai domain across platform, api, cli and desktop ([#32484](https://github.com/vm0-ai/vm0/issues/32484)) ([af545b4](https://github.com/vm0-ai/vm0/commit/af545b4bc4a892f60efc89c11aa3f54a73adc004))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.415.1
    * @okouai/connectors bumped to 3.8.3
    * @okouai/core bumped to 8.635.1

## [0.862.8](https://github.com/vm0-ai/vm0/compare/app-v0.862.7...app-v0.862.8) (2026-09-08)


### Bug Fixes

* **platform:** converge calendar recovery after reconnect ([#32549](https://github.com/vm0-ai/vm0/issues/32549)) ([26c387f](https://github.com/vm0-ai/vm0/commit/26c387f49b2858be89eb130a859a2e3999f9cbf1))


### Refactoring

* remove googleFormsWorkflowAutomations feature switch ([#32523](https://github.com/vm0-ai/vm0/issues/32523)) ([9f498b5](https://github.com/vm0-ai/vm0/commit/9f498b557f70cf3545a784cf53108f73302c24ec))
* remove notion workflow automation feature switch ([#32524](https://github.com/vm0-ai/vm0/issues/32524)) ([14a02ec](https://github.com/vm0-ai/vm0/commit/14a02ec10b944dc744b143c678ce2a60787e6284))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.415.0
    * @okouai/core bumped to 8.635.0

## [0.862.7](https://github.com/vm0-ai/vm0/compare/app-v0.862.6...app-v0.862.7) (2026-09-08)


### Bug Fixes

* **platform:** keep browser card height stable ([#32535](https://github.com/vm0-ai/vm0/issues/32535)) ([a85c01f](https://github.com/vm0-ai/vm0/commit/a85c01feeaef9863ed8d97639e091ef22ccb1695))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.634.6

## [0.862.6](https://github.com/vm0-ai/vm0/compare/app-v0.862.5...app-v0.862.6) (2026-09-08)


### Bug Fixes

* **platform:** align legacy chat response rows ([#32497](https://github.com/vm0-ai/vm0/issues/32497)) ([dfa2458](https://github.com/vm0-ai/vm0/commit/dfa2458727ab156d3f5e7af52f621e0d35be8159))
* **platform:** authorize visible agents on the first connector account ([#32502](https://github.com/vm0-ai/vm0/issues/32502)) ([6169424](https://github.com/vm0-ai/vm0/commit/6169424485d472e98a27a55cb9626fa27548f207))

## [0.862.5](https://github.com/vm0-ai/vm0/compare/app-v0.862.4...app-v0.862.5) (2026-09-08)


### Refactoring

* **chat:** remove video model rollout fallbacks ([#32363](https://github.com/vm0-ai/vm0/issues/32363)) ([d23807b](https://github.com/vm0-ai/vm0/commit/d23807b1b0913312306777c23a7342c67b050487))
* **platform:** separate sidebar list readiness ([#32520](https://github.com/vm0-ai/vm0/issues/32520)) ([f41aea7](https://github.com/vm0-ai/vm0/commit/f41aea7a861814d4c04f0569b023e7addb39299b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.414.3
    * @okouai/core bumped to 8.634.5

## [0.862.4](https://github.com/vm0-ai/vm0/compare/app-v0.862.3...app-v0.862.4) (2026-09-08)


### Bug Fixes

* **platform:** align chat avatars without work folding ([#32487](https://github.com/vm0-ai/vm0/issues/32487)) ([7a19f0a](https://github.com/vm0-ai/vm0/commit/7a19f0ae376461b990b6fe3351a6fb52e4c72bc8))
* **platform:** remove optimistic directed authorization state ([#32493](https://github.com/vm0-ai/vm0/issues/32493)) ([45e1053](https://github.com/vm0-ai/vm0/commit/45e10539dffbd49c47e49c115e28dc78d10d5bb4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.414.2
    * @okouai/connectors bumped to 3.8.2
    * @okouai/core bumped to 8.634.4

## [0.862.3](https://github.com/vm0-ai/vm0/compare/app-v0.862.2...app-v0.862.3) (2026-09-08)


### Bug Fixes

* **platform:** align pinned chat move menu labels ([#32486](https://github.com/vm0-ai/vm0/issues/32486)) ([e911359](https://github.com/vm0-ai/vm0/commit/e9113596224b785a9f7108f2d0ddc66e5e527283))
* **platform:** normalize feature switch maintainer emails ([#32439](https://github.com/vm0-ai/vm0/issues/32439)) ([16d1e9a](https://github.com/vm0-ai/vm0/commit/16d1e9a9b2bcd80e20ae37dfd64584814c46b531))
* **platform:** stop transcript card border blink ([#32430](https://github.com/vm0-ai/vm0/issues/32430)) ([18b4cf2](https://github.com/vm0-ai/vm0/commit/18b4cf2354b57ffc5debdda58f1397519f961021))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.634.3

## [0.862.2](https://github.com/vm0-ai/vm0/compare/app-v0.862.1...app-v0.862.2) (2026-09-08)


### Bug Fixes

* **calendar:** support safe target reconfiguration ([#32441](https://github.com/vm0-ai/vm0/issues/32441)) ([f6f48c8](https://github.com/vm0-ai/vm0/commit/f6f48c8dff8c9a4a33e4312f77da9f8e1a36dc79))
* **platform:** bypass opaque cache for annotated images ([#32478](https://github.com/vm0-ai/vm0/issues/32478)) ([3d3f761](https://github.com/vm0-ai/vm0/commit/3d3f7612e6ee11480caf558c8ef3159cc09e2ff9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.414.1
    * @okouai/core bumped to 8.634.2

## [0.862.1](https://github.com/vm0-ai/vm0/compare/app-v0.862.0...app-v0.862.1) (2026-09-08)


### Bug Fixes

* **platform:** align chat response icon rails ([#32412](https://github.com/vm0-ai/vm0/issues/32412)) ([9e30d72](https://github.com/vm0-ai/vm0/commit/9e30d72ee785027123dcf1694c6a6ad2d0fca004))
* **platform:** align sidebar scrollbar with workspace edge ([#32400](https://github.com/vm0-ai/vm0/issues/32400)) ([03a305e](https://github.com/vm0-ai/vm0/commit/03a305e4cd2986d94634ad031db679d94418478b))


### Refactoring

* remove artifact link kind icon feature switch ([#32423](https://github.com/vm0-ai/vm0/issues/32423)) ([ceb9ffe](https://github.com/vm0-ai/vm0/commit/ceb9ffee01c289ece4cc0e2c08bb281cc78e6dba))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.634.1

## [0.862.0](https://github.com/vm0-ai/vm0/compare/app-v0.861.0...app-v0.862.0) (2026-09-07)


### Features

* **platform:** add artifact link kind icons ([#32384](https://github.com/vm0-ai/vm0/issues/32384)) ([f3090b0](https://github.com/vm0-ai/vm0/commit/f3090b04e14bc6d3bfd8b65a8b7577a3c209e6c0))


### Bug Fixes

* **platform:** show thread identity in mobile chat headers ([#32373](https://github.com/vm0-ai/vm0/issues/32373)) ([fc38d72](https://github.com/vm0-ai/vm0/commit/fc38d72fc4cc4330db7d657b0104bb84c6b0afd5))


### Refactoring

* **platform:** canonicalize image recognition usage naming ([#32417](https://github.com/vm0-ai/vm0/issues/32417)) ([6303439](https://github.com/vm0-ai/vm0/commit/630343907b93980f2db85f2a3cac0583868af19d)), closes [#32410](https://github.com/vm0-ai/vm0/issues/32410)
* remove chat thread pin shortcut feature switch ([#32407](https://github.com/vm0-ai/vm0/issues/32407)) ([bae37fd](https://github.com/vm0-ai/vm0/commit/bae37fde00af760986261b8cd5499e59a6dc9131))
* remove pinned agent avatar feature switch ([#32405](https://github.com/vm0-ai/vm0/issues/32405)) ([a3e3f9a](https://github.com/vm0-ai/vm0/commit/a3e3f9ad89acb8581c3d241c1936a98fcab56eb9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.414.0
    * @okouai/core bumped to 8.634.0

## [0.861.0](https://github.com/vm0-ai/vm0/compare/app-v0.860.0...app-v0.861.0) (2026-09-07)


### Features

* **app:** stream authenticated api prefetch responses ([#32364](https://github.com/vm0-ai/vm0/issues/32364)) ([88eda06](https://github.com/vm0-ai/vm0/commit/88eda06641dcf5b239f6274540f55ecc53d468ee))


### Bug Fixes

* **platform:** read annotated images through public urls ([#32356](https://github.com/vm0-ai/vm0/issues/32356)) ([8154ea3](https://github.com/vm0-ai/vm0/commit/8154ea36eb0625e909228d2d34e01b57e5286507))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.413.0
    * @okouai/core bumped to 8.633.1

## [0.860.0](https://github.com/vm0-ai/vm0/compare/app-v0.859.0...app-v0.860.0) (2026-09-07)


### Features

* **platform:** refine chat work history ([#32369](https://github.com/vm0-ai/vm0/issues/32369)) ([12e41b0](https://github.com/vm0-ai/vm0/commit/12e41b0e8c7455c53e1e26906f47e7ce7b8eb012))
* **platform:** route app realtime through shared worker ([#32366](https://github.com/vm0-ai/vm0/issues/32366)) ([02b8739](https://github.com/vm0-ai/vm0/commit/02b87392dba2e9d2c61ad34734ad3f091110d461))


### Refactoring

* **platform:** mount settings only while open ([#32374](https://github.com/vm0-ai/vm0/issues/32374)) ([b56cad8](https://github.com/vm0-ai/vm0/commit/b56cad81f87e15f42db67d44bdf7ec250fd2a846))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.412.4
    * @okouai/core bumped to 8.633.0

## [0.859.0](https://github.com/vm0-ai/vm0/compare/app-v0.858.3...app-v0.859.0) (2026-09-07)


### Features

* **app:** add create commands to the chat composer ([#32296](https://github.com/vm0-ai/vm0/issues/32296)) ([d821b1b](https://github.com/vm0-ai/vm0/commit/d821b1b1f56934f51a7a99adb45bfd1d813d32d9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.632.0

## [0.858.3](https://github.com/vm0-ai/vm0/compare/app-v0.858.2...app-v0.858.3) (2026-09-07)


### Bug Fixes

* **platform:** expand desktop selection within ai replies ([#32338](https://github.com/vm0-ai/vm0/issues/32338)) ([c9f6e05](https://github.com/vm0-ai/vm0/commit/c9f6e05544a950b9df4e7734a32f7335cd210512))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.412.3
    * @okouai/core bumped to 8.631.5

## [0.858.2](https://github.com/vm0-ai/vm0/compare/app-v0.858.1...app-v0.858.2) (2026-09-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.412.2
    * @okouai/core bumped to 8.631.4

## [0.858.1](https://github.com/vm0-ai/vm0/compare/app-v0.858.0...app-v0.858.1) (2026-09-07)


### Bug Fixes

* **auth:** complete invitations and required session tasks ([#32301](https://github.com/vm0-ai/vm0/issues/32301)) ([9e2c887](https://github.com/vm0-ai/vm0/commit/9e2c88767508d1a41c6bf8b7d7ed13f4c3f8bc60))
* **intro-video:** support managed native video agent generation ([#32305](https://github.com/vm0-ai/vm0/issues/32305)) ([f6c13bf](https://github.com/vm0-ai/vm0/commit/f6c13bf47c6995bd8c65f753741488231c6ae980))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.412.1
    * @okouai/connectors bumped to 3.8.1
    * @okouai/core bumped to 8.631.3

## [0.858.0](https://github.com/vm0-ai/vm0/compare/app-v0.857.0...app-v0.858.0) (2026-09-07)


### Features

* **platform:** add recent and all work history views ([#32250](https://github.com/vm0-ai/vm0/issues/32250)) ([bbecb35](https://github.com/vm0-ai/vm0/commit/bbecb355397440b13e3f00aa7fcde510ff54c2e6))
* **platform:** group intro video styles by heygen tags ([#32209](https://github.com/vm0-ai/vm0/issues/32209)) ([e888e8d](https://github.com/vm0-ai/vm0/commit/e888e8dd852aac537f3a03b1a818f72c0b4da00b))


### Bug Fixes

* **app:** prevent microphone dimming when switching chat threads ([#32265](https://github.com/vm0-ai/vm0/issues/32265)) ([3e09554](https://github.com/vm0-ai/vm0/commit/3e09554e775fa577bb0e8e1e64e297e969b41b5b))
* **platform:** keep the microphone button stable when switching conversations ([#32284](https://github.com/vm0-ai/vm0/issues/32284)) ([d0f1333](https://github.com/vm0-ai/vm0/commit/d0f1333ecaadd89b82f7100241315e8cf9877998)), closes [#32255](https://github.com/vm0-ai/vm0/issues/32255)
* **platform:** reveal thread shortcuts on modifier hold ([#32262](https://github.com/vm0-ai/vm0/issues/32262)) ([e068f45](https://github.com/vm0-ai/vm0/commit/e068f4512ba61b694f5651676eedb43170f58374))
* **platform:** simplify model picker settings and focus ([#32238](https://github.com/vm0-ai/vm0/issues/32238)) ([c365403](https://github.com/vm0-ai/vm0/commit/c3654039e0eb81100f4a040c259fc45c08235e43))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.412.0
    * @okouai/connectors bumped to 3.8.0
    * @okouai/core bumped to 8.631.2

## [0.857.0](https://github.com/vm0-ai/vm0/compare/app-v0.856.0...app-v0.857.0) (2026-09-07)


### Features

* **voice:** transcribe overlapping audio segments with resumable progress ([#32059](https://github.com/vm0-ai/vm0/issues/32059)) ([77a06e4](https://github.com/vm0-ai/vm0/commit/77a06e48dc6dbed124f690305b7f075350dd42a7))


### Bug Fixes

* **platform:** preserve markdown artifact link presentation ([#32236](https://github.com/vm0-ai/vm0/issues/32236)) ([e26bf23](https://github.com/vm0-ai/vm0/commit/e26bf239d93ad89a64b8deabd8434728c9d54e50))
* share debounce and throttle command scheduling ([#32086](https://github.com/vm0-ai/vm0/issues/32086)) ([22f9b37](https://github.com/vm0-ai/vm0/commit/22f9b377b6201d539d5645dfcfa906d333ad05f7))


### Refactoring

* **platform:** rename remaining internal brand identifiers ([#32247](https://github.com/vm0-ai/vm0/issues/32247)) ([8aec76c](https://github.com/vm0-ai/vm0/commit/8aec76c897feed2f412467cef2b61a0bc4884f9d)), closes [#32240](https://github.com/vm0-ai/vm0/issues/32240)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.411.0
    * @okouai/core bumped to 8.631.1

## [0.856.0](https://github.com/vm0-ai/vm0/compare/app-v0.855.1...app-v0.856.0) (2026-09-07)


### Features

* **platform:** find agents by name in workspace search ([#32208](https://github.com/vm0-ai/vm0/issues/32208)) ([d64a34e](https://github.com/vm0-ai/vm0/commit/d64a34e75a1a1429922679d32905b2c1d6519f10))


### Bug Fixes

* **auth:** support second-factor verification in custom sign-in ([#32216](https://github.com/vm0-ai/vm0/issues/32216)) ([a9edf50](https://github.com/vm0-ai/vm0/commit/a9edf5029c0c6ba6f06d0fa1609f11371f3f3d0e))
* **platform:** align composer shortcut tooltips ([#32217](https://github.com/vm0-ai/vm0/issues/32217)) ([d76bd97](https://github.com/vm0-ai/vm0/commit/d76bd975004e7b03fe9b992df00ffcf87d0a009f))
* **platform:** handle expected client failures and unsupported browsers ([#32227](https://github.com/vm0-ai/vm0/issues/32227)) ([c438eb7](https://github.com/vm0-ai/vm0/commit/c438eb7dfeaf10ae9876ab51de1af92fb82dda07))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.410.0
    * @okouai/core bumped to 8.631.0

## [0.855.1](https://github.com/vm0-ai/vm0/compare/app-v0.855.0...app-v0.855.1) (2026-09-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.409.6
    * @okouai/core bumped to 8.630.1

## [0.855.0](https://github.com/vm0-ai/vm0/compare/app-v0.854.2...app-v0.855.0) (2026-09-07)


### Features

* enable presentation templates for all organizations ([#32089](https://github.com/vm0-ai/vm0/issues/32089)) ([7096061](https://github.com/vm0-ai/vm0/commit/7096061d5771379747e1da8d891b457f67a89850))


### Bug Fixes

* derive chat preference progress from shared invocations ([#32189](https://github.com/vm0-ai/vm0/issues/32189)) ([b8b8331](https://github.com/vm0-ai/vm0/commit/b8b8331aec0727c7fba8ef36148ae1c88fd440e3))


### Refactoring

* **platform:** drop legacy data-vm0 readers ([#32187](https://github.com/vm0-ai/vm0/issues/32187)) ([5e65ca1](https://github.com/vm0-ai/vm0/commit/5e65ca1da74e6216f0be7dc68286a65006296cfa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.409.5
    * @okouai/connectors bumped to 3.7.0
    * @okouai/core bumped to 8.630.0
    * @okouai/ui bumped to 1.6.1

## [0.854.2](https://github.com/vm0-ai/vm0/compare/app-v0.854.1...app-v0.854.2) (2026-09-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.409.4
    * @okouai/core bumped to 8.629.2

## [0.854.1](https://github.com/vm0-ai/vm0/compare/app-v0.854.0...app-v0.854.1) (2026-09-07)


### Bug Fixes

* **platform:** wait for skeleton before page readiness ([#32175](https://github.com/vm0-ai/vm0/issues/32175)) ([f68a10c](https://github.com/vm0-ai/vm0/commit/f68a10cf2ee61699911aba45781deb2b5c4dc194))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.409.3
    * @okouai/connectors bumped to 3.6.0
    * @okouai/core bumped to 8.629.1

## [0.854.0](https://github.com/vm0-ai/vm0/compare/app-v0.853.0...app-v0.854.0) (2026-09-07)


### Features

* **platform:** enlarge pinned agent avatars behind a feature switch ([#32067](https://github.com/vm0-ai/vm0/issues/32067)) ([ea29038](https://github.com/vm0-ai/vm0/commit/ea29038571b77c7dda8c95c8e500599c33db984c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.629.0

## [0.853.0](https://github.com/vm0-ai/vm0/compare/app-v0.852.0...app-v0.853.0) (2026-09-07)


### Features

* **app:** add a chat thread pin shortcut ([#32046](https://github.com/vm0-ai/vm0/issues/32046)) ([31977ef](https://github.com/vm0-ai/vm0/commit/31977ef5d4475edfd8bfb6dcc0de87f856ed22aa))
* **platform:** add dedicated chat preferences ([#32041](https://github.com/vm0-ai/vm0/issues/32041)) ([e4c4768](https://github.com/vm0-ai/vm0/commit/e4c4768a8e24bac790a0a09333ddae80bee8f3d2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.409.2
    * @okouai/connectors bumped to 3.5.0
    * @okouai/core bumped to 8.628.0

## [0.852.0](https://github.com/vm0-ai/vm0/compare/app-v0.851.0...app-v0.852.0) (2026-09-06)


### Features

* add emboss and deboss illustration template ([#32010](https://github.com/vm0-ai/vm0/issues/32010)) ([e186381](https://github.com/vm0-ai/vm0/commit/e186381a7e441cf5168ae007ff15969a6260e43c))
* **platform:** add a compact composer model menu ([#32036](https://github.com/vm0-ai/vm0/issues/32036)) ([eb168c8](https://github.com/vm0-ai/vm0/commit/eb168c8a818b233d4c0dbeb37ee00a96f9eaeca4))


### Bug Fixes

* **platform:** support long-press pin reordering on touch screens ([#32032](https://github.com/vm0-ai/vm0/issues/32032)) ([93f3152](https://github.com/vm0-ai/vm0/commit/93f3152e39d2a3600de9d7759bfd05f21cc0fbe2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.409.1
    * @okouai/connectors bumped to 3.4.0
    * @okouai/core bumped to 8.627.0

## [0.851.0](https://github.com/vm0-ai/vm0/compare/app-v0.850.0...app-v0.851.0) (2026-09-06)


### Features

* simplify intro video creation flow ([#31830](https://github.com/vm0-ai/vm0/issues/31830)) ([646a907](https://github.com/vm0-ai/vm0/commit/646a907e90dd9ffa0b7983a2d7d4dea77886893f))


### Bug Fixes

* **platform:** open legacy avatars in the new composer ([#32020](https://github.com/vm0-ai/vm0/issues/32020)) ([8144a93](https://github.com/vm0-ai/vm0/commit/8144a9396f40ca600bec2fef162277cd3bb429a8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.409.0
    * @okouai/core bumped to 8.626.0

## [0.850.0](https://github.com/vm0-ai/vm0/compare/app-v0.849.1...app-v0.850.0) (2026-09-06)


### Features

* show global keyboard shortcut hints on modifier hold ([#32004](https://github.com/vm0-ai/vm0/issues/32004)) ([1a44eea](https://github.com/vm0-ai/vm0/commit/1a44eeaf461039a838aad9e59813c1e0d8f6f47a))


### Bug Fixes

* **platform:** align pinned chat tab order with visual layout ([#32016](https://github.com/vm0-ai/vm0/issues/32016)) ([beb16df](https://github.com/vm0-ai/vm0/commit/beb16dfceeca55a088d72c47f9fe9c7fa60f515e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/ui bumped to 1.6.0

## [0.849.1](https://github.com/vm0-ai/vm0/compare/app-v0.849.0...app-v0.849.1) (2026-09-06)


### Bug Fixes

* default voice input to gemini 3.1 flash-lite ([#32009](https://github.com/vm0-ai/vm0/issues/32009)) ([1ae6387](https://github.com/vm0-ai/vm0/commit/1ae638773aadb37a38f49ba0c825a22a13c06894))
* derive voice draft progress and wait for captured audio ([#31983](https://github.com/vm0-ai/vm0/issues/31983)) ([98628ec](https://github.com/vm0-ai/vm0/commit/98628ecad55c2356eb3e474d334c53699b1bdcb6))


### Documentation

* archive api and app changelogs by month ([#32006](https://github.com/vm0-ai/vm0/issues/32006)) ([1f11937](https://github.com/vm0-ai/vm0/commit/1f119373b286c53be5fedbe40a2c67b321f4e0dd))


### Refactoring

* **platform:** use shadcn primitives in the selection toolbar ([#32008](https://github.com/vm0-ai/vm0/issues/32008)) ([00ff9a3](https://github.com/vm0-ai/vm0/commit/00ff9a324dec8b381843f673378f47ff0e586c26))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.408.1
    * @okouai/core bumped to 8.625.12
    * @okouai/ui bumped to 1.5.5

## [0.849.0](https://github.com/vm0-ai/vm0/compare/app-v0.848.1...app-v0.849.0) (2026-09-06)


### Features

* add voice input model preferences and honor lab overrides ([#31982](https://github.com/vm0-ai/vm0/issues/31982)) ([7b114d5](https://github.com/vm0-ai/vm0/commit/7b114d5b3b2683d2987daf09d651403f2951dc4c))


### Bug Fixes

* place chat shortcut hints after row actions ([#31994](https://github.com/vm0-ai/vm0/issues/31994)) ([a0bc24a](https://github.com/vm0-ai/vm0/commit/a0bc24a59d24f8215165e8e2cce4976d46272721))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.408.0
    * @okouai/core bumped to 8.625.11

## [0.848.1](https://github.com/vm0-ai/vm0/compare/app-v0.848.0...app-v0.848.1) (2026-09-06)


### Bug Fixes

* handle thread number shortcuts in safari web apps ([#31987](https://github.com/vm0-ai/vm0/issues/31987)) ([9482af4](https://github.com/vm0-ai/vm0/commit/9482af45d227bc8df673855f960fa775f3208131))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.407.1
    * @okouai/core bumped to 8.625.10

## [0.848.0](https://github.com/vm0-ai/vm0/compare/app-v0.847.0...app-v0.848.0) (2026-09-06)


### Features

* add cursor context and light polish to voice input ([#31968](https://github.com/vm0-ai/vm0/issues/31968)) ([12d0c92](https://github.com/vm0-ai/vm0/commit/12d0c9232684f9223ade010c40f3fad752b079df))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.407.0
    * @okouai/core bumped to 8.625.9

## [0.847.0](https://github.com/vm0-ai/vm0/compare/app-v0.846.0...app-v0.847.0) (2026-09-06)


### Features

* **platform:** add pwa thread navigation hints ([#31938](https://github.com/vm0-ai/vm0/issues/31938)) ([e5cbf8b](https://github.com/vm0-ai/vm0/commit/e5cbf8b3fff605d41581d511fc890a6d87a9bdbe))


### Bug Fixes

* **platform:** keep incompatible hairstyle previews stable ([#31966](https://github.com/vm0-ai/vm0/issues/31966)) ([854b91e](https://github.com/vm0-ai/vm0/commit/854b91e89bbf20a41458b6c8f7f0dcb025d6f2f9)), closes [#31935](https://github.com/vm0-ai/vm0/issues/31935)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.406.0
    * @okouai/core bumped to 8.625.8

## [0.846.0](https://github.com/vm0-ai/vm0/compare/app-v0.845.8...app-v0.846.0) (2026-09-06)


### Features

* **platform:** add desktop authentication bridge routes ([#31960](https://github.com/vm0-ai/vm0/issues/31960)) ([f1e3d4b](https://github.com/vm0-ai/vm0/commit/f1e3d4b7284d5c0fdae40887d0f24a3d08d5d824))


### Bug Fixes

* **ui:** follow base ui popup transitions and positioning ([#31942](https://github.com/vm0-ai/vm0/issues/31942)) ([38edfa5](https://github.com/vm0-ai/vm0/commit/38edfa57f3e1318ec0bfdd13a1fd840ab8929203))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.625.7
    * @okouai/ui bumped to 1.5.4

## [0.845.8](https://github.com/vm0-ai/vm0/compare/app-v0.845.7...app-v0.845.8) (2026-09-05)


### Bug Fixes

* persist voice recordings for transcription retry ([#31845](https://github.com/vm0-ai/vm0/issues/31845)) ([2360162](https://github.com/vm0-ai/vm0/commit/2360162954630496be2b8b597af6b8aa7b0d3b72))


### Refactoring

* remove expired deployment compatibility ([#31954](https://github.com/vm0-ai/vm0/issues/31954)) ([8733345](https://github.com/vm0-ai/vm0/commit/8733345cc9d02379fc7a22c2525509b87833c46b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.7
    * @okouai/core bumped to 8.625.6

## [0.845.7](https://github.com/vm0-ai/vm0/compare/app-v0.845.6...app-v0.845.7) (2026-09-05)


### Bug Fixes

* finish voice input silently when no speech is detected ([#31933](https://github.com/vm0-ai/vm0/issues/31933)) ([b37822c](https://github.com/vm0-ai/vm0/commit/b37822c16ec7479dfc1fa1ecdefc85dd8ee53a6e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.6
    * @okouai/core bumped to 8.625.5

## [0.845.6](https://github.com/vm0-ai/vm0/compare/app-v0.845.5...app-v0.845.6) (2026-09-05)


### Bug Fixes

* restore the search dialog chat result limit ([#31928](https://github.com/vm0-ai/vm0/issues/31928)) ([96bb60e](https://github.com/vm0-ai/vm0/commit/96bb60ed942feae6d12b1cf3b8586503b60d1675))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.5
    * @okouai/core bumped to 8.625.4

## [0.845.5](https://github.com/vm0-ai/vm0/compare/app-v0.845.4...app-v0.845.5) (2026-09-05)


### Bug Fixes

* **platform:** preserve connector account card layout while loading ([#31914](https://github.com/vm0-ai/vm0/issues/31914)) ([aed13b2](https://github.com/vm0-ai/vm0/commit/aed13b2c13a2cbff2fd03503a14f7c315764ad73))

## [0.845.4](https://github.com/vm0-ai/vm0/compare/app-v0.845.3...app-v0.845.4) (2026-09-05)


### Refactoring

* **platform:** rename browser globals and clerk bootstrap to okou ([#31904](https://github.com/vm0-ai/vm0/issues/31904)) ([d0e609d](https://github.com/vm0-ai/vm0/commit/d0e609d122cc970ebebad59a800836b311d4002b))
* rename module-scoped brand identifiers ([#31906](https://github.com/vm0-ai/vm0/issues/31906)) ([003db23](https://github.com/vm0-ai/vm0/commit/003db2336542de3fc504cbbc64e9ea26ec88a109))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.4
    * @okouai/connectors bumped to 3.3.6
    * @okouai/core bumped to 8.625.3

## [0.845.3](https://github.com/vm0-ai/vm0/compare/app-v0.845.2...app-v0.845.3) (2026-09-05)


### Bug Fixes

* **platform:** fail closed to the okou clerk primary domain ([#31894](https://github.com/vm0-ai/vm0/issues/31894)) ([596394f](https://github.com/vm0-ai/vm0/commit/596394facaf413a41fd850ac441df020c905edb3))


### Refactoring

* **platform:** fully roll out batch chat event catch-up ([#31890](https://github.com/vm0-ai/vm0/issues/31890)) ([523f917](https://github.com/vm0-ai/vm0/commit/523f917203f26c95e91ef1e94df04d439a82f1f7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.625.2

## [0.845.2](https://github.com/vm0-ai/vm0/compare/app-v0.845.1...app-v0.845.2) (2026-09-05)


### Refactoring

* unify voice input feature switches ([#31884](https://github.com/vm0-ai/vm0/issues/31884)) ([4537935](https://github.com/vm0-ai/vm0/commit/453793580a047239a98c91d92568b56898e58c25))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.3
    * @okouai/connectors bumped to 3.3.5
    * @okouai/core bumped to 8.625.1

## [0.845.1](https://github.com/vm0-ai/vm0/compare/app-v0.845.0...app-v0.845.1) (2026-09-05)


### Bug Fixes

* improve voice draft input feedback ([#31866](https://github.com/vm0-ai/vm0/issues/31866)) ([1328223](https://github.com/vm0-ai/vm0/commit/1328223b2fe4f8cc63fe1a0716686ea2095dde9a))
* **platform:** align account usage rings and show reset counts ([#31870](https://github.com/vm0-ai/vm0/issues/31870)) ([ca9d7ab](https://github.com/vm0-ai/vm0/commit/ca9d7abd334b82e51e9d148e54f1e7895b19b28e))

## [0.845.0](https://github.com/vm0-ai/vm0/compare/app-v0.844.1...app-v0.845.0) (2026-09-05)


### Features

* **platform:** add indexeddb storage diagnostics ([#31794](https://github.com/vm0-ai/vm0/issues/31794)) ([6cc3703](https://github.com/vm0-ai/vm0/commit/6cc370306a9289b3b85c4e5f85fb9527b63869cb))
* **platform:** stabilize pinned chats and add numbered search navigation ([#31833](https://github.com/vm0-ai/vm0/issues/31833)) ([6040bad](https://github.com/vm0-ai/vm0/commit/6040bada98116cff9254300136962e5080c03021))


### Bug Fixes

* **platform:** center avatar options and keep selections on the current step ([#31852](https://github.com/vm0-ai/vm0/issues/31852)) ([c260908](https://github.com/vm0-ai/vm0/commit/c260908955bad080ced59fae9723b26dc639a85b))


### Refactoring

* **voice:** remove draft compatibility and encoded audio fallback ([#31792](https://github.com/vm0-ai/vm0/issues/31792)) ([83979d4](https://github.com/vm0-ai/vm0/commit/83979d4a271483500bce0e63f837b5a9db279262))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.2
    * @okouai/core bumped to 8.625.0

## [0.844.1](https://github.com/vm0-ai/vm0/compare/app-v0.844.0...app-v0.844.1) (2026-09-05)


### Bug Fixes

* **app:** unify chat response layout and status lifecycle ([#31791](https://github.com/vm0-ai/vm0/issues/31791)) ([796dcb7](https://github.com/vm0-ai/vm0/commit/796dcb7b4e3d00a9066b78cd2c1c7a022cf4dbfd))

## [0.844.0](https://github.com/vm0-ai/vm0/compare/app-v0.843.2...app-v0.844.0) (2026-09-05)


### Features

* expose heygen presenters and voices in intro video ([#31668](https://github.com/vm0-ai/vm0/issues/31668)) ([0a10020](https://github.com/vm0-ai/vm0/commit/0a1002047c76815573418d5af8c774d137b948c0))


### Bug Fixes

* **platform:** assign pwa bottom safe areas to content ([#31734](https://github.com/vm0-ai/vm0/issues/31734)) ([2bde699](https://github.com/vm0-ai/vm0/commit/2bde6994874e55f7caa936844fb839e17b5ffaa9))


### Refactoring

* **platform:** classify and retire the residual zero-* platform names ([#31844](https://github.com/vm0-ai/vm0/issues/31844)) ([5fcd876](https://github.com/vm0-ai/vm0/commit/5fcd876c6ebad5753a58d79f111a6e55b903f108))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.1
    * @okouai/core bumped to 8.624.0
    * @okouai/ui bumped to 1.5.3

## [0.843.2](https://github.com/vm0-ai/vm0/compare/app-v0.843.1...app-v0.843.2) (2026-09-05)


### Bug Fixes

* open the sidebar chat menu from the row state indicator ([#31831](https://github.com/vm0-ai/vm0/issues/31831)) ([65a0a31](https://github.com/vm0-ai/vm0/commit/65a0a319d53662f14fb701414ae2f9f9f405338d))
* **platform:** remove shared worker timeouts and automatic reloads ([#31809](https://github.com/vm0-ai/vm0/issues/31809)) ([8cbf53e](https://github.com/vm0-ai/vm0/commit/8cbf53e0829416e6e606f33ae4213da71011a1fa))


### Refactoring

* **api:** rename the vm0 built-in model vocabulary to built-in ([#31834](https://github.com/vm0-ai/vm0/issues/31834)) ([1cfe7fc](https://github.com/vm0-ai/vm0/commit/1cfe7fccc9c89a46171f6aad08750cb6dab8865b)), closes [#31818](https://github.com/vm0-ai/vm0/issues/31818)
* **platform:** rename data-vm0-* dom attributes to data-okou-* ([#31821](https://github.com/vm0-ai/vm0/issues/31821)) ([5555a53](https://github.com/vm0-ai/vm0/commit/5555a535cd2ffed1d2fdf9d79c315e5756c554e3))
* **platform:** roll out base ui sidebar scroll area ([#31822](https://github.com/vm0-ai/vm0/issues/31822)) ([eae726c](https://github.com/vm0-ai/vm0/commit/eae726c7761929845a30c58286dd8a28af3f0622))
* **platform:** roll out markdown hex color previews ([#31826](https://github.com/vm0-ai/vm0/issues/31826)) ([82f7578](https://github.com/vm0-ai/vm0/commit/82f7578886827deb17f678c0e90c7d7d977ebee2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.0
    * @okouai/core bumped to 8.623.2

## [0.843.1](https://github.com/vm0-ai/vm0/compare/app-v0.843.0...app-v0.843.1) (2026-09-05)


### Bug Fixes

* **platform:** measure sidebar virtualization after styles and layout updates ([#31789](https://github.com/vm0-ai/vm0/issues/31789)) ([75a7f8b](https://github.com/vm0-ai/vm0/commit/75a7f8b95007012a618362d0abef063fbaaab2a3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.404.1
    * @okouai/core bumped to 8.623.1

## [0.843.0](https://github.com/vm0-ai/vm0/compare/app-v0.842.1...app-v0.843.0) (2026-09-05)


### Features

* **platform:** give composer avatars a neck and sweater ([#31740](https://github.com/vm0-ai/vm0/issues/31740)) ([26067de](https://github.com/vm0-ai/vm0/commit/26067de1c1cf4378675cb31b5c30b6fae7efb5df))


### Bug Fixes

* **platform:** preserve focus during agent connector updates ([#31797](https://github.com/vm0-ai/vm0/issues/31797)) ([31fa206](https://github.com/vm0-ai/vm0/commit/31fa206779d382b4069857b8d5ffb4856a71be32))
* **platform:** scope avatar operations to dialog sessions ([#31798](https://github.com/vm0-ai/vm0/issues/31798)) ([b0b7c53](https://github.com/vm0-ai/vm0/commit/b0b7c531d25b925f1e433698cd12cdf7347c24d5))
* retire claude fable 5 from model selection ([#31790](https://github.com/vm0-ai/vm0/issues/31790)) ([86185af](https://github.com/vm0-ai/vm0/commit/86185affdd253f409dad6d217aa5b0f16ac5086c))
* **ui:** restore amber primary and align toggle tracks ([#31785](https://github.com/vm0-ai/vm0/issues/31785)) ([560d86a](https://github.com/vm0-ai/vm0/commit/560d86a414b460fe64bf8c18f6f0368b17b91a2f))


### Refactoring

* **chat:** remove prefixed timeout fallback ([#31778](https://github.com/vm0-ai/vm0/issues/31778)) ([3f8dad2](https://github.com/vm0-ai/vm0/commit/3f8dad2589c9eb19acd9fc3f00dffda12d20144f))
* **eslint:** rename the internal lint plugin namespace to okou ([#31806](https://github.com/vm0-ai/vm0/issues/31806)) ([314590e](https://github.com/vm0-ai/vm0/commit/314590ea8d2671714555db2a4cfeb035994eb779)), closes [#31799](https://github.com/vm0-ai/vm0/issues/31799)
* **platform:** remove dead paths and duplicated ui logic ([#31795](https://github.com/vm0-ai/vm0/issues/31795)) ([8b8eb33](https://github.com/vm0-ai/vm0/commit/8b8eb334b3cf5748e329109a61540be6109be252))
* **platform:** remove obsolete attachment gates and share automation logic ([#31786](https://github.com/vm0-ai/vm0/issues/31786)) ([d6deafd](https://github.com/vm0-ai/vm0/commit/d6deafdd7e3c7872a93e88df512558d69ec0772c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.404.0
    * @okouai/connectors bumped to 3.3.4
    * @okouai/core bumped to 8.623.0
    * @okouai/ui bumped to 1.5.2

## [0.842.1](https://github.com/vm0-ai/vm0/compare/app-v0.842.0...app-v0.842.1) (2026-09-05)


### Bug Fixes

* **platform:** derive run work folding from output events ([#31779](https://github.com/vm0-ai/vm0/issues/31779)) ([2c7c890](https://github.com/vm0-ai/vm0/commit/2c7c8906aa780b246974b5af4e25a7b537eb3c8a))

## [0.842.0](https://github.com/vm0-ai/vm0/compare/app-v0.841.1...app-v0.842.0) (2026-09-04)


### Features

* add heygen intro video foundations ([#31648](https://github.com/vm0-ai/vm0/issues/31648)) ([87394e8](https://github.com/vm0-ai/vm0/commit/87394e8f07d62d1394742db09f0cfd206b1b3ff8))
* add intro video heygen renderer and voice services ([#31658](https://github.com/vm0-ai/vm0/issues/31658)) ([1917a5f](https://github.com/vm0-ai/vm0/commit/1917a5fa59ee61fdb44f0d1822804a256009ef88))
* **platform:** report indexeddb setup telemetry ([#31772](https://github.com/vm0-ai/vm0/issues/31772)) ([cd13281](https://github.com/vm0-ai/vm0/commit/cd13281ca93050178ff59aeb56b374017a009fd2))


### Bug Fixes

* **platform:** load the current avatar when opening the avatar maker ([#31742](https://github.com/vm0-ai/vm0/issues/31742)) ([f2b6d9c](https://github.com/vm0-ai/vm0/commit/f2b6d9c2d4982bea26e4a615cb461880d1123681))
* **platform:** request worker tokens from the first tab ([#31748](https://github.com/vm0-ai/vm0/issues/31748)) ([67405db](https://github.com/vm0-ai/vm0/commit/67405db486e677be320b95e99a87774a98de04c1))
* **platform:** show standalone upgrade as one dialog ([#31737](https://github.com/vm0-ai/vm0/issues/31737)) ([edefd23](https://github.com/vm0-ai/vm0/commit/edefd23804f274d81440a1566edc8ac1a78bac09))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.403.0
    * @okouai/core bumped to 8.622.0

## [0.841.1](https://github.com/vm0-ai/vm0/compare/app-v0.841.0...app-v0.841.1) (2026-09-04)


### Bug Fixes

* **agent:** align avatar edits with visibility permissions ([#31731](https://github.com/vm0-ai/vm0/issues/31731)) ([8cf8b09](https://github.com/vm0-ai/vm0/commit/8cf8b094a80ea861fbb366df0cc33323e1cf9846))
* **platform:** hide composer placeholder after a newline ([#31752](https://github.com/vm0-ai/vm0/issues/31752)) ([0ebbb7c](https://github.com/vm0-ai/vm0/commit/0ebbb7c0c163503d8888be22b0d4a13ca8acd3e9))
* **platform:** restore clerk satellite auth navigation ([#31741](https://github.com/vm0-ai/vm0/issues/31741)) ([ed45e20](https://github.com/vm0-ai/vm0/commit/ed45e20e93af40f4ced60816506bdf79f9f9df75))
* **platform:** stabilize pinned agent label transition ([#31736](https://github.com/vm0-ai/vm0/issues/31736)) ([c8de880](https://github.com/vm0-ai/vm0/commit/c8de880b88d153eb559f656e1daa01b16fe924fa))
* **ui:** deduplicate slash workflow suggestions ([#31757](https://github.com/vm0-ai/vm0/issues/31757)) ([c1aafce](https://github.com/vm0-ai/vm0/commit/c1aafce488fc22601ff67249c0b5a0bbec27510c))
* **ui:** lift new-ui track and bubble off the page and neutralise body copy ([#31640](https://github.com/vm0-ai/vm0/issues/31640)) ([024c27b](https://github.com/vm0-ai/vm0/commit/024c27b2ea5a5dce6a43747e1ee4049bc3a2bc56))


### Refactoring

* **api:** remove legacy custom connector oauth readers ([#31751](https://github.com/vm0-ai/vm0/issues/31751)) ([3a13b3a](https://github.com/vm0-ai/vm0/commit/3a13b3ad6564d96d6a721287ed2e816c5b1a60f6))


### Performance Improvements

* move type checking to the typescript 7 native compiler ([#31716](https://github.com/vm0-ai/vm0/issues/31716)) ([aa41353](https://github.com/vm0-ai/vm0/commit/aa41353c983fbc0212ec1e06aa34b56a71bf2166))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.402.2
    * @okouai/connectors bumped to 3.3.3
    * @okouai/core bumped to 8.621.2
    * @okouai/ui bumped to 1.5.1

## [0.841.0](https://github.com/vm0-ai/vm0/compare/app-v0.840.0...app-v0.841.0) (2026-09-04)


### Features

* **platform:** add client red telemetry ([#31656](https://github.com/vm0-ai/vm0/issues/31656)) ([7abbd22](https://github.com/vm0-ai/vm0/commit/7abbd22abd2ea690664569fc616236dc913a06ab))


### Bug Fixes

* **platform:** align goal ui with work folding ([#31659](https://github.com/vm0-ai/vm0/issues/31659)) ([2c31b59](https://github.com/vm0-ai/vm0/commit/2c31b591d8349ab5de267ea88bb6ab7081a4aeaf))


### Refactoring

* consolidate desktop recording under intro video switch ([#31730](https://github.com/vm0-ai/vm0/issues/31730)) ([262f6db](https://github.com/vm0-ai/vm0/commit/262f6db498a4d2951d538b9af723bb199a21f311))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.402.1
    * @okouai/core bumped to 8.621.1

## [0.840.0](https://github.com/vm0-ai/vm0/compare/app-v0.839.0...app-v0.840.0) (2026-09-04)


### Features

* add gpt-6 astra support ([#31558](https://github.com/vm0-ai/vm0/issues/31558)) ([004ea48](https://github.com/vm0-ai/vm0/commit/004ea48590eba7c66af3a9b156e3daba7411793b))
* **app:** bootstrap first api responses in the app shell ([#31665](https://github.com/vm0-ai/vm0/issues/31665)) ([21e3a85](https://github.com/vm0-ai/vm0/commit/21e3a858cddd1489337cd47dc010dd93fee7cc6d))
* **platform:** preview recent run messages when collapsed ([#31687](https://github.com/vm0-ai/vm0/issues/31687)) ([7ba50ee](https://github.com/vm0-ai/vm0/commit/7ba50eebe75cc1d9cf6785e143aa408854405757))
* **ui:** move the new ui primary to cobalt ([#31680](https://github.com/vm0-ai/vm0/issues/31680)) ([f4393f0](https://github.com/vm0-ai/vm0/commit/f4393f057b98c5d9a3aca3e92c2eb7c8dc9c0fae))


### Bug Fixes

* **chat:** preserve structured runner timeout recovery ([#31711](https://github.com/vm0-ai/vm0/issues/31711)) ([1a6f7d2](https://github.com/vm0-ai/vm0/commit/1a6f7d27e30421af781efa7ac3025e46e39286dd))
* **chat:** skip empty event tails in batch catch-up ([#31718](https://github.com/vm0-ai/vm0/issues/31718)) ([289d858](https://github.com/vm0-ai/vm0/commit/289d858a4b2a3b5f43e906b7efe961e785b71aed))


### Refactoring

* **platform:** consolidate app lifecycle and sidebar cleanup ([#31585](https://github.com/vm0-ai/vm0/issues/31585)) ([8a58754](https://github.com/vm0-ai/vm0/commit/8a58754c07930b35ddabf326d8fd91f31a19bc03))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.402.0
    * @okouai/core bumped to 8.621.0
    * @okouai/ui bumped to 1.5.0

## [0.839.0](https://github.com/vm0-ai/vm0/compare/app-v0.838.0...app-v0.839.0) (2026-09-04)


### Features

* add avatar composer v2 ([#31526](https://github.com/vm0-ai/vm0/issues/31526)) ([0812c8b](https://github.com/vm0-ai/vm0/commit/0812c8bfb4c4d8a8e416717573a3d5a6609347f8))
* **app:** track chat work history expansion ([#31588](https://github.com/vm0-ai/vm0/issues/31588)) ([20393d9](https://github.com/vm0-ai/vm0/commit/20393d9c404f6e4f3596319cf60aac5b64fb7aba))
* **core:** roll out connector accounts to all users ([#31608](https://github.com/vm0-ai/vm0/issues/31608)) ([aca7cf7](https://github.com/vm0-ai/vm0/commit/aca7cf7ea9e6a36a37cfedbfcd987394f977add5))


### Bug Fixes

* **app:** hide activity log link outside debug mode ([#31592](https://github.com/vm0-ai/vm0/issues/31592)) ([0949da3](https://github.com/vm0-ai/vm0/commit/0949da33461d293773b09bddc3efd6d14d5303e6))
* **app:** hide cancel while deleting agents ([#31581](https://github.com/vm0-ai/vm0/issues/31581)) ([1eaeaeb](https://github.com/vm0-ai/vm0/commit/1eaeaebe825a34cab9480c3f5f050834f704e597))
* **app:** match the chat list's right inset to the workspace card gutter ([#31623](https://github.com/vm0-ai/vm0/issues/31623)) ([7b59b54](https://github.com/vm0-ai/vm0/commit/7b59b543c3e622a4647125832b161ab4398fb612))
* keep intro video guidance out of user prompts ([#31673](https://github.com/vm0-ai/vm0/issues/31673)) ([40a2a9d](https://github.com/vm0-ai/vm0/commit/40a2a9d5a99d27eef49fcab8547af52bd43055e0))
* localize automatic mcp oauth errors ([#31626](https://github.com/vm0-ai/vm0/issues/31626)) ([4420f93](https://github.com/vm0-ai/vm0/commit/4420f93d5ba7aba8c54ab46e0d5305674fb2588a))
* **platform:** align pinned loading with shared worker lifecycle ([#31685](https://github.com/vm0-ai/vm0/issues/31685)) ([f503f4f](https://github.com/vm0-ai/vm0/commit/f503f4fed9d1ba6083ae8fbcfe766b74cdb03e30))
* **platform:** buffer selection toolbar scroll dismissal ([#31639](https://github.com/vm0-ai/vm0/issues/31639)) ([2531bce](https://github.com/vm0-ai/vm0/commit/2531bceb336a28ce764d2b6a69a93ff60a7ba90c))
* **platform:** clarify cloud browser setting is a new-chat default ([#31657](https://github.com/vm0-ai/vm0/issues/31657)) ([19c2fd1](https://github.com/vm0-ai/vm0/commit/19c2fd156c88deb76b3630be21af3f1e19a7b56a))
* **platform:** distinguish shared worker unavailable reasons ([#31543](https://github.com/vm0-ai/vm0/issues/31543)) ([2d11c4d](https://github.com/vm0-ai/vm0/commit/2d11c4d315865e621e973b9e4f7c25cd940918eb))
* **platform:** stabilize connector popover placement ([#31474](https://github.com/vm0-ai/vm0/issues/31474)) ([6e4b8a5](https://github.com/vm0-ai/vm0/commit/6e4b8a534911d1f74e6c10dc8c92454fc3c3df91))
* **platform:** stop the thinking shimmer shifting the status text ([#31649](https://github.com/vm0-ai/vm0/issues/31649)) ([a371d46](https://github.com/vm0-ai/vm0/commit/a371d4693dd150ccd986d272c084904d03e85a6d)), closes [#31625](https://github.com/vm0-ai/vm0/issues/31625)
* **ui:** give the pause button its own coral fill ([#31644](https://github.com/vm0-ai/vm0/issues/31644)) ([ef3fbba](https://github.com/vm0-ai/vm0/commit/ef3fbba190faccf939b0ae731397b5be53402181))
* **ui:** rebuild new-ui neutral gray palette ([#31537](https://github.com/vm0-ai/vm0/issues/31537)) ([3acbaf5](https://github.com/vm0-ai/vm0/commit/3acbaf566cb2360a7db7aa7f9f52c0672aa3adea))
* use the standard inset focus ring on emoji picker emoji ([#31643](https://github.com/vm0-ai/vm0/issues/31643)) ([bcf20d4](https://github.com/vm0-ai/vm0/commit/bcf20d43d2e5c63686bce282511002a0fb8a7e10))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.401.0
    * @okouai/core bumped to 8.620.0
    * @okouai/ui bumped to 1.4.1

## [0.838.0](https://github.com/vm0-ai/vm0/compare/app-v0.837.0...app-v0.838.0) (2026-09-04)


### Features

* **app:** enable production clerk edge sessions ([#31636](https://github.com/vm0-ai/vm0/issues/31636)) ([367559e](https://github.com/vm0-ai/vm0/commit/367559efb7c8ffeb8d1b9b7bfdd0e2d32b76095c))

## [0.837.0](https://github.com/vm0-ai/vm0/compare/app-v0.836.0...app-v0.837.0) (2026-09-04)


### Features

* **platform:** merge goal continuations into triggering run work ([#31515](https://github.com/vm0-ai/vm0/issues/31515)) ([1d60ff7](https://github.com/vm0-ai/vm0/commit/1d60ff7a8877c996ddd9b56cadbc5935d84a4371))


### Bug Fixes

* **app:** keep voice drafts recording through silence ([#31559](https://github.com/vm0-ai/vm0/issues/31559)) ([0ba3421](https://github.com/vm0-ai/vm0/commit/0ba342178d4c5119fbfd54e14c806c94e903fa45))
* **platform:** align sidebar scrollbar with Base UI layout ([#31564](https://github.com/vm0-ai/vm0/issues/31564)) ([5eae694](https://github.com/vm0-ai/vm0/commit/5eae6943caf38bfec71dd7ce163add224074d6a8))


### Refactoring

* remove expired deployment compatibility ([#31557](https://github.com/vm0-ai/vm0/issues/31557)) ([6e158f2](https://github.com/vm0-ai/vm0/commit/6e158f23952e2b19dccedda6921043779630e543))


### Performance Improvements

* **platform:** cache pinned agent previews ([#31506](https://github.com/vm0-ai/vm0/issues/31506)) ([044fe5b](https://github.com/vm0-ai/vm0/commit/044fe5b7b22d59dd4062ed7fafaa31b4ef723338))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.400.1
    * @okouai/core bumped to 8.619.1

## [0.836.0](https://github.com/vm0-ai/vm0/compare/app-v0.835.0...app-v0.836.0) (2026-09-03)


### Features

* **app:** add composer voice input shortcut ([#31541](https://github.com/vm0-ai/vm0/issues/31541)) ([7f01748](https://github.com/vm0-ai/vm0/commit/7f017487956ca49793aa82a1d41b634f642c285c))
* **app:** replace talk to with universal search ([#31533](https://github.com/vm0-ai/vm0/issues/31533)) ([0784aa5](https://github.com/vm0-ai/vm0/commit/0784aa5dde51005083193a0c23201f803b0561f8))
* **platform:** preview inline HEX code colors ([#31540](https://github.com/vm0-ai/vm0/issues/31540)) ([205e107](https://github.com/vm0-ai/vm0/commit/205e10797e76c5b8a9fde17aefaf7f7dc1e7d852))
* use chat context for voice draft cleanup ([#31517](https://github.com/vm0-ai/vm0/issues/31517)) ([c77f7ff](https://github.com/vm0-ai/vm0/commit/c77f7ff2fc4887a079700e3729bef1afcf5da863))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.400.0
    * @okouai/core bumped to 8.619.0

## [0.835.0](https://github.com/vm0-ai/vm0/compare/app-v0.834.0...app-v0.835.0) (2026-09-03)


### Features

* **platform:** add draggable sidebar scrollbar behind switch ([#31532](https://github.com/vm0-ai/vm0/issues/31532)) ([72e1f7e](https://github.com/vm0-ai/vm0/commit/72e1f7e12c865bffa3679a6374eccbdba4ad324e))


### Bug Fixes

* **platform:** scroll voice draft level history ([#31539](https://github.com/vm0-ai/vm0/issues/31539)) ([1fdf333](https://github.com/vm0-ai/vm0/commit/1fdf333f129c0308c4437e99776277027a164055))


### Refactoring

* remove expired deployment compatibility ([#31524](https://github.com/vm0-ai/vm0/issues/31524)) ([2020321](https://github.com/vm0-ai/vm0/commit/202032117158dca3c445b5f6f6d5e0e2d5b660aa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.399.1
    * @okouai/core bumped to 8.618.0

## [0.834.0](https://github.com/vm0-ai/vm0/compare/app-v0.833.0...app-v0.834.0) (2026-09-03)


### Features

* add cloud browser preference ([#31522](https://github.com/vm0-ai/vm0/issues/31522)) ([99b4589](https://github.com/vm0-ai/vm0/commit/99b4589022738a463640e019b97f31c150e50850))
* **platform:** preview hex colors in markdown ([#31511](https://github.com/vm0-ai/vm0/issues/31511)) ([cfa6740](https://github.com/vm0-ai/vm0/commit/cfa67403943362e9a5b46fef7f8a9cc64aaab0d3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.399.0
    * @okouai/core bumped to 8.617.0

## [0.833.0](https://github.com/vm0-ai/vm0/compare/app-v0.832.1...app-v0.833.0) (2026-09-03)


### Features

* **artifacts:** add short okou artifact urls ([#31483](https://github.com/vm0-ai/vm0/issues/31483)) ([9d20d76](https://github.com/vm0-ai/vm0/commit/9d20d76b88d3097f279084fcfb452d8b86e7ef55))
* **platform:** add voice draft recording footer ([#31514](https://github.com/vm0-ai/vm0/issues/31514)) ([6c695a1](https://github.com/vm0-ai/vm0/commit/6c695a1b2f32b8acb57972bcd7b54547f8482a96))
* **platform:** gate chat thinking spinner for staff ([#31485](https://github.com/vm0-ai/vm0/issues/31485)) ([9f30e52](https://github.com/vm0-ai/vm0/commit/9f30e521cbfaa8fd23f9a12e31b13997d15fd0fe))
* **ui:** put the sand and amber palette behind the new-ui switch ([#31521](https://github.com/vm0-ai/vm0/issues/31521)) ([2d7c27d](https://github.com/vm0-ai/vm0/commit/2d7c27dbc469ee93d6b7d0b10470f3eebdba4f84))


### Bug Fixes

* **auth:** redirect satellite auth routes to primary ([#31392](https://github.com/vm0-ai/vm0/issues/31392)) ([7b9d6a6](https://github.com/vm0-ai/vm0/commit/7b9d6a62b31bf7a256eb24d3314ed9a8af0002b1))
* **platform:** preserve composer line breaks on copy ([#31513](https://github.com/vm0-ai/vm0/issues/31513)) ([b6ee3a5](https://github.com/vm0-ai/vm0/commit/b6ee3a56b858015c433a3d42ca0545e023a2372c))
* **platform:** remove shortcut hints from sidebar tooltips ([#31503](https://github.com/vm0-ai/vm0/issues/31503)) ([9d5d9f2](https://github.com/vm0-ai/vm0/commit/9d5d9f28e46ed0aec352e1860837c75b9892f628))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.398.2
    * @okouai/core bumped to 8.616.0
    * @okouai/ui bumped to 1.4.0

## [0.832.1](https://github.com/vm0-ai/vm0/compare/app-v0.832.0...app-v0.832.1) (2026-09-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.398.1
    * @okouai/core bumped to 8.615.1

## [0.832.0](https://github.com/vm0-ai/vm0/compare/app-v0.831.2...app-v0.832.0) (2026-09-03)


### Features

* **ui:** refresh the app palette onto the sand and amber scales ([#31081](https://github.com/vm0-ai/vm0/issues/31081)) ([eff8671](https://github.com/vm0-ai/vm0/commit/eff8671a6068d00502fad87e629409417e3ddd56))


### Bug Fixes

* **auth:** prevent decorative overflow from scrolling ([#31494](https://github.com/vm0-ai/vm0/issues/31494)) ([b13c2b2](https://github.com/vm0-ai/vm0/commit/b13c2b224df84165d74ea3e898ed6b68212bc931))
* **platform:** hide account manager empty state for a single account ([#31453](https://github.com/vm0-ai/vm0/issues/31453)) ([0716f7b](https://github.com/vm0-ai/vm0/commit/0716f7b85d810f61186743c75388de969197a059))
* **platform:** replace app skeleton illustration ([#31477](https://github.com/vm0-ai/vm0/issues/31477)) ([00930ff](https://github.com/vm0-ai/vm0/commit/00930ff193ac0e04eb4f3326d1bb07a1552982a5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.615.0
    * @okouai/ui bumped to 1.3.0

## [0.831.2](https://github.com/vm0-ai/vm0/compare/app-v0.831.1...app-v0.831.2) (2026-09-03)


### Bug Fixes

* **agent:** lock default agent name ([#31440](https://github.com/vm0-ai/vm0/issues/31440)) ([1c40b16](https://github.com/vm0-ai/vm0/commit/1c40b16066635e282d31752e6ce654b1422f5ecb))
* **platform:** prevent unsolicited video openings and endings ([#31484](https://github.com/vm0-ai/vm0/issues/31484)) ([9d237ab](https://github.com/vm0-ai/vm0/commit/9d237ab0d976d3a73278effb9a700f881d2bfe30))
* **platform:** remove new chat from chat list menu ([#31473](https://github.com/vm0-ai/vm0/issues/31473)) ([4c05cd1](https://github.com/vm0-ai/vm0/commit/4c05cd11de063ed34f172572ae1ee2553103c1a9))
* **platform:** use adaptive favicon ([#31451](https://github.com/vm0-ai/vm0/issues/31451)) ([4a4a164](https://github.com/vm0-ai/vm0/commit/4a4a16434653b58a5ee32a00f7a6ccb8409f1d1b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.614.2

## [0.831.1](https://github.com/vm0-ai/vm0/compare/app-v0.831.0...app-v0.831.1) (2026-09-03)


### Bug Fixes

* stabilize pending goal run layout ([#31455](https://github.com/vm0-ai/vm0/issues/31455)) ([408975b](https://github.com/vm0-ai/vm0/commit/408975b3ecea67454883277ef13ada0f57b480ea))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.614.1

## [0.831.0](https://github.com/vm0-ai/vm0/compare/app-v0.830.0...app-v0.831.0) (2026-09-03)


### Features

* **platform:** add elapsed run work folding ([#31321](https://github.com/vm0-ai/vm0/issues/31321)) ([134b069](https://github.com/vm0-ai/vm0/commit/134b0696c6fd26cc3e24234a7d0b433dff9241c9))
* **platform:** use okou wordmarks across branded surfaces ([#31395](https://github.com/vm0-ai/vm0/issues/31395)) ([ff7b7e4](https://github.com/vm0-ai/vm0/commit/ff7b7e448c8dc0cbe03d04e94ad5985d22bdb6f9))
* show when the soonest codex reset credit expires ([#31412](https://github.com/vm0-ai/vm0/issues/31412)) ([127bed8](https://github.com/vm0-ai/vm0/commit/127bed8e9ab803338c93fcb3ffaf5fa478cc0c6c))


### Bug Fixes

* **platform:** align intro video camera review instructions ([#31413](https://github.com/vm0-ai/vm0/issues/31413)) ([5629612](https://github.com/vm0-ai/vm0/commit/562961205485e5e46e47fa25828e5cc265b7dd87))
* **platform:** derive ios startup images from skeleton layout ([#31204](https://github.com/vm0-ai/vm0/issues/31204)) ([d65a7b3](https://github.com/vm0-ai/vm0/commit/d65a7b3f4f6274e3ef432be14283ecd6044bcffa))
* **platform:** keep the lightbox open when a drag ends on the backdrop ([#31374](https://github.com/vm0-ai/vm0/issues/31374)) ([62f5d27](https://github.com/vm0-ai/vm0/commit/62f5d27778894f81d3992f71bd11618493710b1e)), closes [#27173](https://github.com/vm0-ai/vm0/issues/27173)
* **platform:** limit okou mark change to favicon ([#31428](https://github.com/vm0-ai/vm0/issues/31428)) ([aa6bf81](https://github.com/vm0-ai/vm0/commit/aa6bf812a0e39387de986ddea96a3a51ee809d2a))
* **platform:** preserve selection menu during automatic scroll ([#31437](https://github.com/vm0-ai/vm0/issues/31437)) ([b94c65b](https://github.com/vm0-ai/vm0/commit/b94c65b4b6f439d1bf66f6c8e017699b5dead17f))
* **platform:** rate-limit shared database reloads ([#31398](https://github.com/vm0-ai/vm0/issues/31398)) ([ef98200](https://github.com/vm0-ai/vm0/commit/ef982001164a89e08aae07cc3c330bf422b4571c))
* **platform:** replace favicons with black okou mark ([#31400](https://github.com/vm0-ai/vm0/issues/31400)) ([0e6d79b](https://github.com/vm0-ai/vm0/commit/0e6d79bf8ae7e9101596b55c171b84614aa43b2a))
* **platform:** stop one tap from blocking auth skeleton ([#31409](https://github.com/vm0-ai/vm0/issues/31409)) ([d240caf](https://github.com/vm0-ai/vm0/commit/d240caf2a3640e1a98256302e37bda895e22b980))
* **platform:** use inbound agentphone connection flow ([#31308](https://github.com/vm0-ai/vm0/issues/31308)) ([2aacef1](https://github.com/vm0-ai/vm0/commit/2aacef15330f63d6391ac5e05febaceebe586d57))


### Refactoring

* **api:** detach custom connectors from oauth setup persistence ([#31417](https://github.com/vm0-ai/vm0/issues/31417)) ([944b829](https://github.com/vm0-ai/vm0/commit/944b829570b4c69685f68d6dae159a75bd3c07f1))
* **platform:** route instatus status polling through the shared loop helper ([#31415](https://github.com/vm0-ai/vm0/issues/31415)) ([7bdcdf7](https://github.com/vm0-ai/vm0/commit/7bdcdf7fc590b4b0c8d808c509981fc198c33768))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.398.0
    * @okouai/connectors bumped to 3.3.2
    * @okouai/core bumped to 8.614.0
    * @okouai/ui bumped to 1.2.0

## [0.830.0](https://github.com/vm0-ai/vm0/compare/app-v0.829.5...app-v0.830.0) (2026-09-03)


### Features

* **chat:** batch shared worker event catch-up ([#31261](https://github.com/vm0-ai/vm0/issues/31261)) ([127f8e8](https://github.com/vm0-ai/vm0/commit/127f8e8cfc5cc91750a5ca7a1ac90529f10d4ef9))
* **platform:** expose custom mcp automatic authorization ([#31307](https://github.com/vm0-ai/vm0/issues/31307)) ([c71fc16](https://github.com/vm0-ai/vm0/commit/c71fc16cc227bcd1fc4f2389bbc7992a4d95df0c))
* polish voice drafts before sending ([#31190](https://github.com/vm0-ai/vm0/issues/31190)) ([12b2532](https://github.com/vm0-ai/vm0/commit/12b2532a6400c7c62ba705a782e3e209f0440091))


### Bug Fixes

* **platform:** sync okou theme across subdomains ([#31310](https://github.com/vm0-ai/vm0/issues/31310)) ([8154e0a](https://github.com/vm0-ai/vm0/commit/8154e0adc989f5e2119908888ef4bc3b9c2445c5))
* **platform:** use selected drive account for artifact readiness ([#31316](https://github.com/vm0-ai/vm0/issues/31316)) ([65d4ac5](https://github.com/vm0-ai/vm0/commit/65d4ac58bb3df45a52c97658bde0f594f554b6ad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.397.0
    * @okouai/core bumped to 8.613.0

## [0.829.5](https://github.com/vm0-ai/vm0/compare/app-v0.829.4...app-v0.829.5) (2026-09-03)


### Bug Fixes

* **connectors:** rework account manager dialog and drop opaque account names ([#31181](https://github.com/vm0-ai/vm0/issues/31181)) ([5706ac3](https://github.com/vm0-ai/vm0/commit/5706ac352dcad40e52c3a18827bf0f5a3ea253b8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.612.0
    * @okouai/ui bumped to 1.1.1

## [0.829.4](https://github.com/vm0-ai/vm0/compare/app-v0.829.3...app-v0.829.4) (2026-09-03)


### Bug Fixes

* **platform:** restore lab maintainer filters ([#31293](https://github.com/vm0-ai/vm0/issues/31293)) ([db97b7b](https://github.com/vm0-ai/vm0/commit/db97b7b3b95c66528d16206d0d1ec335eda16c31))
* **platform:** stop hidden uploaded cover preloading ([#31284](https://github.com/vm0-ai/vm0/issues/31284)) ([1a41ae6](https://github.com/vm0-ai/vm0/commit/1a41ae663bc4ae1ed8cccbb0f47d93af308aba8c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.396.3
    * @okouai/core bumped to 8.611.6

## [0.829.3](https://github.com/vm0-ai/vm0/compare/app-v0.829.2...app-v0.829.3) (2026-09-03)


### Bug Fixes

* **mail:** preserve exact reconnect account ([#31224](https://github.com/vm0-ai/vm0/issues/31224)) ([87a73d3](https://github.com/vm0-ai/vm0/commit/87a73d3f81fc8c7aa229a18d0c70c99a054bf121))
* target selected google drive account for artifact recovery ([#31227](https://github.com/vm0-ai/vm0/issues/31227)) ([90388e8](https://github.com/vm0-ai/vm0/commit/90388e854981ba1d0eca0783ca84f477422445ce))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.396.2
    * @okouai/core bumped to 8.611.5

## [0.829.2](https://github.com/vm0-ai/vm0/compare/app-v0.829.1...app-v0.829.2) (2026-09-03)


### Bug Fixes

* **platform:** restore lab feature switch controls ([#31195](https://github.com/vm0-ai/vm0/issues/31195)) ([28d0924](https://github.com/vm0-ai/vm0/commit/28d092431268d2f2e9369ed14ceb147ab2a6174d))

## [0.829.1](https://github.com/vm0-ai/vm0/compare/app-v0.829.0...app-v0.829.1) (2026-09-03)


### Bug Fixes

* **platform:** send shared worker clerk requests to the frontend api host ([#31254](https://github.com/vm0-ai/vm0/issues/31254)) ([b954bd9](https://github.com/vm0-ai/vm0/commit/b954bd96b27ef3c5372af97de91a795719554eba))

## [0.829.0](https://github.com/vm0-ai/vm0/compare/app-v0.828.0...app-v0.829.0) (2026-09-02)


### Features

* **platform:** give each intro video source entry its own hidden workflow ([#31139](https://github.com/vm0-ai/vm0/issues/31139)) ([d9e28d8](https://github.com/vm0-ai/vm0/commit/d9e28d847648795fb9af5c3e777cee679ae77fe0))


### Refactoring

* remove expired deployment compatibility ([#31245](https://github.com/vm0-ai/vm0/issues/31245)) ([fd5bddf](https://github.com/vm0-ai/vm0/commit/fd5bddff5b967a67e226076dea2d391467b12a8e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.396.1
    * @okouai/connectors bumped to 3.3.1
    * @okouai/core bumped to 8.611.4

## [0.828.0](https://github.com/vm0-ai/vm0/compare/app-v0.827.0...app-v0.828.0) (2026-09-02)


### Features

* **platform:** send timezone on onboarding completion ([#31233](https://github.com/vm0-ai/vm0/issues/31233)) ([00b7296](https://github.com/vm0-ai/vm0/commit/00b7296dfd4bac4dfb840d3871b9767ac3139f35))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.396.0
    * @okouai/core bumped to 8.611.3

## [0.827.0](https://github.com/vm0-ai/vm0/compare/app-v0.826.0...app-v0.827.0) (2026-09-02)


### Features

* **platform:** expose shared worker connection diagnostics to the app ([#31194](https://github.com/vm0-ai/vm0/issues/31194)) ([79b72bd](https://github.com/vm0-ai/vm0/commit/79b72bd4fcc9bc7a3294397f3d2298380641cce0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.395.0
    * @okouai/core bumped to 8.611.2

## [0.826.0](https://github.com/vm0-ai/vm0/compare/app-v0.825.0...app-v0.826.0) (2026-09-02)


### Features

* **api:** resolve automatic mcp auth as none or oauth ([#31135](https://github.com/vm0-ai/vm0/issues/31135)) ([d84a7e0](https://github.com/vm0-ai/vm0/commit/d84a7e0cd556e91916858ea18cd5256efde6ed03))


### Bug Fixes

* **platform:** let clerk own shared worker authentication ([#31037](https://github.com/vm0-ai/vm0/issues/31037)) ([6ba1dbe](https://github.com/vm0-ai/vm0/commit/6ba1dbeb842c60a8b5c8f014bcfc7a624b2a7817))
* **platform:** prevent custom credit amount layout shift ([#31175](https://github.com/vm0-ai/vm0/issues/31175)) ([a3a6300](https://github.com/vm0-ai/vm0/commit/a3a6300676d4fec516868f695d63d1de8d5650e1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.394.0
    * @okouai/core bumped to 8.611.1

## [0.825.0](https://github.com/vm0-ai/vm0/compare/app-v0.824.0...app-v0.825.0) (2026-09-02)


### Features

* **app:** add standalone worker previews ([#30987](https://github.com/vm0-ai/vm0/issues/30987)) ([7a4ce6a](https://github.com/vm0-ai/vm0/commit/7a4ce6ad45daa6c4cb823a9b7253340123dd98df))
* **platform:** add internal Lab switch category ([#31177](https://github.com/vm0-ai/vm0/issues/31177)) ([996361b](https://github.com/vm0-ai/vm0/commit/996361bb352b5b94ec0852dbaa7ddc7086d7116e))
* **platform:** group lab switches by rollout stage ([#31121](https://github.com/vm0-ai/vm0/issues/31121)) ([f23ecec](https://github.com/vm0-ai/vm0/commit/f23ecec9f8582cdd9a90281af7833266d7fb84ca))
* **platform:** preview supported office file formats ([#31013](https://github.com/vm0-ai/vm0/issues/31013)) ([5f5cf9e](https://github.com/vm0-ai/vm0/commit/5f5cf9ebb7a737439660e274efc1d6f094f29773))


### Bug Fixes

* **platform:** align iOS startup image handoff ([#31174](https://github.com/vm0-ai/vm0/issues/31174)) ([4ca361b](https://github.com/vm0-ai/vm0/commit/4ca361bda768db6441d6ef3fbf00eb0fc21db202))
* **platform:** align model recovery card with the app card and button language ([#31072](https://github.com/vm0-ai/vm0/issues/31072)) ([330236c](https://github.com/vm0-ai/vm0/commit/330236cf9046140c54b8398bc9c0321ef800597d))
* **platform:** count share selections by message group ([#31126](https://github.com/vm0-ai/vm0/issues/31126)) ([74fb353](https://github.com/vm0-ai/vm0/commit/74fb35396e9c734e63a17d142f9345bd7c343ce7))
* **platform:** highlight pinned agents for chat threads ([#31125](https://github.com/vm0-ai/vm0/issues/31125)) ([08255dc](https://github.com/vm0-ai/vm0/commit/08255dc889faf77224deaa4cbdc0fffed945a84c))
* **platform:** prevent desktop viewport pinch zoom ([#31137](https://github.com/vm0-ai/vm0/issues/31137)) ([3cd64e6](https://github.com/vm0-ai/vm0/commit/3cd64e646ee868eca2f6329a2b331b1c057d223f))
* **platform:** update chat sidebar navigation ([#31099](https://github.com/vm0-ai/vm0/issues/31099)) ([44a87b5](https://github.com/vm0-ai/vm0/commit/44a87b5c24314251273323c3f875e45fd12c4b51))
* project remaining public brand surfaces ([#31151](https://github.com/vm0-ai/vm0/issues/31151)) ([769b53e](https://github.com/vm0-ai/vm0/commit/769b53e654a275477750026201f55207dc13d839))


### Refactoring

* **platform:** simplify Geist font stack ([#31158](https://github.com/vm0-ai/vm0/issues/31158)) ([4349067](https://github.com/vm0-ai/vm0/commit/43490673b124826f3cc7e0fafc241133bca8c0d0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.393.0
    * @okouai/core bumped to 8.611.0

## [0.824.0](https://github.com/vm0-ai/vm0/compare/app-v0.823.0...app-v0.824.0) (2026-09-02)


### Features

* **chat:** persist structured image annotations ([#31046](https://github.com/vm0-ai/vm0/issues/31046)) ([8e4b621](https://github.com/vm0-ai/vm0/commit/8e4b62131457161a5c9ceb7ec4003339a4b58eb5))
* gate morning brief behind an independent switch ([#31110](https://github.com/vm0-ai/vm0/issues/31110)) ([2b69ef6](https://github.com/vm0-ai/vm0/commit/2b69ef6331471d09f88cae0548e6dd4ba15e4283))
* graduate custom connector no-auth ([#31075](https://github.com/vm0-ai/vm0/issues/31075)) ([5756edf](https://github.com/vm0-ai/vm0/commit/5756edf51498b88c6f06b0a43d02c7e632d6238c))
* **platform:** generate ios pwa startup images ([#30926](https://github.com/vm0-ai/vm0/issues/30926)) ([66d375b](https://github.com/vm0-ai/vm0/commit/66d375b2921b40761e9334eae46e8a5993f9b387))
* **platform:** preview docx and pptx files ([#30937](https://github.com/vm0-ai/vm0/issues/30937)) ([70e4b60](https://github.com/vm0-ai/vm0/commit/70e4b60bc195f23592c952cff1e15472eed227a4))
* **platform:** simplify the intro video source step around slides and desktop recording ([#31093](https://github.com/vm0-ai/vm0/issues/31093)) ([edd444e](https://github.com/vm0-ai/vm0/commit/edd444e6fb04a295f637d8580c2a6181b275d338))
* **ui:** gate the geist typeface behind a feature switch ([#31050](https://github.com/vm0-ai/vm0/issues/31050)) ([6a4c38d](https://github.com/vm0-ai/vm0/commit/6a4c38dd1d1dbb86347541d203a3261405c0dcf3))


### Bug Fixes

* **api:** use branded custom connector OAuth callbacks ([#31028](https://github.com/vm0-ai/vm0/issues/31028)) ([4546240](https://github.com/vm0-ai/vm0/commit/4546240924ce7db453f0fff19054da81eb09a8e0))
* **platform:** inject prod clerk key into local env template ([#31101](https://github.com/vm0-ai/vm0/issues/31101)) ([34c5a43](https://github.com/vm0-ai/vm0/commit/34c5a4357d5f4130a4713e3bd5e3793fb027c755))
* **platform:** replace Feishu review guide icon ([#31019](https://github.com/vm0-ai/vm0/issues/31019)) ([b99140a](https://github.com/vm0-ai/vm0/commit/b99140a76559e1750ca0e62e9baf802b2e5259f7))


### Refactoring

* rename internal feature switch keys ([#30955](https://github.com/vm0-ai/vm0/issues/30955)) ([b0670b4](https://github.com/vm0-ai/vm0/commit/b0670b464a105432aaa08b3bd340a07a5b32654e))


### Performance Improvements

* **platform:** unmount inactive sidebar layout ([#30988](https://github.com/vm0-ai/vm0/issues/30988)) ([45f384a](https://github.com/vm0-ai/vm0/commit/45f384a543a1f12e161e8fcc042c4a2cc3840adf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.392.0
    * @okouai/connectors bumped to 3.3.0
    * @okouai/core bumped to 8.610.0
    * @okouai/ui bumped to 1.1.0

## [0.823.0](https://github.com/vm0-ai/vm0/compare/app-v0.822.4...app-v0.823.0) (2026-09-02)


### Features

* add Claude Fable 5.1 support ([#30932](https://github.com/vm0-ai/vm0/issues/30932)) ([15f6717](https://github.com/vm0-ai/vm0/commit/15f6717327d927cc8bc61ff3af3cf17802aa4853))
* replace visual balance with presenter placement ([#30892](https://github.com/vm0-ai/vm0/issues/30892)) ([52277bb](https://github.com/vm0-ai/vm0/commit/52277bbc0fff5f1b9e07822a2b536a064ac1ed99))


### Bug Fixes

* **chat:** surface execution timeouts as recoverable ([#31014](https://github.com/vm0-ai/vm0/issues/31014)) ([97a794d](https://github.com/vm0-ai/vm0/commit/97a794d0dedcac24c2a7d3911a6cb85207964d16))


### Refactoring

* **platform:** scope image canvas state to owners ([#31010](https://github.com/vm0-ai/vm0/issues/31010)) ([01095bd](https://github.com/vm0-ai/vm0/commit/01095bd3b06ba6f85921057638669efa1dfb6d7b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.391.0
    * @okouai/core bumped to 8.609.0

## [0.822.4](https://github.com/vm0-ai/vm0/compare/app-v0.822.3...app-v0.822.4) (2026-09-02)


### Bug Fixes

* **platform:** make settings the only preferences surface ([#31039](https://github.com/vm0-ai/vm0/issues/31039)) ([1e2692c](https://github.com/vm0-ai/vm0/commit/1e2692cd5fd7173f3b691a180d4430bceab4ea6c))


### Refactoring

* remove concurrency member usage feature switch ([#30934](https://github.com/vm0-ai/vm0/issues/30934)) ([e211986](https://github.com/vm0-ai/vm0/commit/e2119869809f7b50614d1367d2fbdc7c1517e4f6))
* remove workflow connector readiness ([#30996](https://github.com/vm0-ai/vm0/issues/30996)) ([94ec7af](https://github.com/vm0-ai/vm0/commit/94ec7afb7be4163a70f0f3fdea1d1c5579541c9b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.390.3
    * @okouai/core bumped to 8.608.3

## [0.822.3](https://github.com/vm0-ai/vm0/compare/app-v0.822.2...app-v0.822.3) (2026-09-02)


### Bug Fixes

* **platform:** update app icons ([#31026](https://github.com/vm0-ai/vm0/issues/31026)) ([a5c3746](https://github.com/vm0-ai/vm0/commit/a5c374658d889ec6af7a13f3f888d280b55259d0))

## [0.822.2](https://github.com/vm0-ai/vm0/compare/app-v0.822.1...app-v0.822.2) (2026-09-02)


### Bug Fixes

* **platform:** close member balances with settings session ([#30986](https://github.com/vm0-ai/vm0/issues/30986)) ([cbfdd38](https://github.com/vm0-ai/vm0/commit/cbfdd38d4a58155c1ceb8201d743577299816b53))
* **platform:** keep translation menu open while scrolling ([#30971](https://github.com/vm0-ai/vm0/issues/30971)) ([ed5762e](https://github.com/vm0-ai/vm0/commit/ed5762e96b913ba74fd606103b8a43290dc4c5b6))
* **platform:** reset connector credential forms on open ([#30967](https://github.com/vm0-ai/vm0/issues/30967)) ([6a2ae64](https://github.com/vm0-ai/vm0/commit/6a2ae642d770457f2896641354055c63875858e6))
* **platform:** reset intro video wizard on open ([#30978](https://github.com/vm0-ai/vm0/issues/30978)) ([ed484bf](https://github.com/vm0-ai/vm0/commit/ed484bfa97e01a5365ecbb51bc7a56e462e6c7d6))
* **platform:** show translation loading for shortcuts ([#30968](https://github.com/vm0-ai/vm0/issues/30968)) ([e4a668d](https://github.com/vm0-ai/vm0/commit/e4a668d0dfdd2cf55ebee65dad77a3c688b4b3ef))


### Refactoring

* remove emoji rail and conversation locator feature switches ([#30981](https://github.com/vm0-ai/vm0/issues/30981)) ([fc04a10](https://github.com/vm0-ai/vm0/commit/fc04a10dd9147a16cc883414704bc3e11458627d))
* remove expired official metadata rollout fallbacks ([#30976](https://github.com/vm0-ai/vm0/issues/30976)) ([f013dbf](https://github.com/vm0-ai/vm0/commit/f013dbf1f850128cefdc96798aea400ed4681366)), closes [#29991](https://github.com/vm0-ai/vm0/issues/29991)
* remove Strapi integration feature switch ([#30965](https://github.com/vm0-ai/vm0/issues/30965)) ([603bbb7](https://github.com/vm0-ai/vm0/commit/603bbb7dafa7caa3619261d9b81047f96c763e38))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.390.2
    * @okouai/core bumped to 8.608.2

## [0.822.1](https://github.com/vm0-ai/vm0/compare/app-v0.822.0...app-v0.822.1) (2026-09-02)


### Refactoring

* **platform:** move queue data into shared worker ([#30933](https://github.com/vm0-ai/vm0/issues/30933)) ([2584031](https://github.com/vm0-ai/vm0/commit/2584031276636c504f534f93c330c01e2cb8ac61))
* remove connectorCatalogCount feature switch ([#30935](https://github.com/vm0-ai/vm0/issues/30935)) ([531a1cc](https://github.com/vm0-ai/vm0/commit/531a1ccf20b2f4c5e33adf143ec0284a8911e3f2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.390.1
    * @okouai/core bumped to 8.608.1

## [0.822.0](https://github.com/vm0-ai/vm0/compare/app-v0.821.2...app-v0.822.0) (2026-09-02)


### Features

* support no-auth custom connectors ([#30897](https://github.com/vm0-ai/vm0/issues/30897)) ([f6a4e7a](https://github.com/vm0-ai/vm0/commit/f6a4e7af74566f31c53c59035554aaf5f0c1076c))


### Bug Fixes

* **platform:** catch up active threads after indicator reload ([#30927](https://github.com/vm0-ai/vm0/issues/30927)) ([8342677](https://github.com/vm0-ai/vm0/commit/83426770cd04e75d78a77f34cea9feb6414a3888))


### Performance Improvements

* **platform:** simplify index resource loading ([#30921](https://github.com/vm0-ai/vm0/issues/30921)) ([0dee441](https://github.com/vm0-ai/vm0/commit/0dee441cddfa3e523d2846127674972f788eb11b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.390.0
    * @okouai/core bumped to 8.608.0

## [0.821.2](https://github.com/vm0-ai/vm0/compare/app-v0.821.1...app-v0.821.2) (2026-09-02)


### Bug Fixes

* share attachments by their public artifacts url ([#30835](https://github.com/vm0-ai/vm0/issues/30835)) ([7aa3ac3](https://github.com/vm0-ai/vm0/commit/7aa3ac3843232909951bd81d1ee60bacf852a078))


### Performance Improvements

* **app:** start application before Google Ads ([#30924](https://github.com/vm0-ai/vm0/issues/30924)) ([4e77d33](https://github.com/vm0-ai/vm0/commit/4e77d33443d862020727b3cb709d942f2d44b718))
* **platform:** keep auth skeleton until auth is ready ([#30922](https://github.com/vm0-ai/vm0/issues/30922)) ([ecbf4cc](https://github.com/vm0-ai/vm0/commit/ecbf4cc91c5f112470cb1222e8dd5152efcbeac2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.389.1
    * @okouai/core bumped to 8.607.1

## [0.821.1](https://github.com/vm0-ai/vm0/compare/app-v0.821.0...app-v0.821.1) (2026-09-01)


### Bug Fixes

* **platform:** open chat file cards in preview dialog ([#30889](https://github.com/vm0-ai/vm0/issues/30889)) ([4d9b0aa](https://github.com/vm0-ai/vm0/commit/4d9b0aa53a9d9032bef3f66a6e17457854780424))

## [0.821.0](https://github.com/vm0-ai/vm0/compare/app-v0.820.1...app-v0.821.0) (2026-09-01)


### Features

* **platform:** translate selected chat text ([#30818](https://github.com/vm0-ai/vm0/issues/30818)) ([37c2265](https://github.com/vm0-ai/vm0/commit/37c2265c1c600cbcc22b32224e376c5ae26cead3))
* use transparent avatar cutouts in the intro video picker ([#30873](https://github.com/vm0-ai/vm0/issues/30873)) ([b176b5b](https://github.com/vm0-ai/vm0/commit/b176b5b46f223dd26d44e976e2299ed3f5bbfa8c))


### Bug Fixes

* **app:** remove instatus widget ([#30886](https://github.com/vm0-ai/vm0/issues/30886)) ([e9f7d38](https://github.com/vm0-ai/vm0/commit/e9f7d387d8a42f8eac1fd0b720f7d27fdea38bfe))
* **platform:** recover shared worker authentication ([#30797](https://github.com/vm0-ai/vm0/issues/30797)) ([d684395](https://github.com/vm0-ai/vm0/commit/d684395ce4ab6af0e25b72a20f0c68cc36cb31ec))


### Refactoring

* **platform:** load google ads from app entry ([#30881](https://github.com/vm0-ai/vm0/issues/30881)) ([d2fe263](https://github.com/vm0-ai/vm0/commit/d2fe263990f92b5c45517d2deb34e0f17c130854))


### Performance Improvements

* **platform:** preload main stylesheet without blocking paint ([#30883](https://github.com/vm0-ai/vm0/issues/30883)) ([280bf3e](https://github.com/vm0-ai/vm0/commit/280bf3e5d3523c759bd5116bf5be01dcedd0a5f7))
* **platform:** prune unused global styles ([#30887](https://github.com/vm0-ai/vm0/issues/30887)) ([ae07bec](https://github.com/vm0-ai/vm0/commit/ae07becadf08eaf208add28b7503e8d192252fef))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.389.0
    * @okouai/core bumped to 8.607.0

## [0.820.1](https://github.com/vm0-ai/vm0/compare/app-v0.820.0...app-v0.820.1) (2026-09-01)


### Bug Fixes

* **auth:** send default sign-ups directly to onboarding ([#30811](https://github.com/vm0-ai/vm0/issues/30811)) ([44c8160](https://github.com/vm0-ai/vm0/commit/44c8160fc5d123c83b3ca4194b480bbee2ac68f7))
* **platform:** update favicon artwork ([#30865](https://github.com/vm0-ai/vm0/issues/30865)) ([24dae57](https://github.com/vm0-ai/vm0/commit/24dae571be202452dac203d3c2f835e34fd1bcd3))


### Refactoring

* **platform:** move onboarding guard into bootstrap ([#30841](https://github.com/vm0-ai/vm0/issues/30841)) ([588fec9](https://github.com/vm0-ai/vm0/commit/588fec9d20aee8a075adeec4d72c4355b1c60723))
* remove built-in fallback rollout state ([#30876](https://github.com/vm0-ai/vm0/issues/30876)) ([ddab7f4](https://github.com/vm0-ai/vm0/commit/ddab7f4cf55cead3540347247d2ea0b0f156c01b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.388.0
    * @okouai/connectors bumped to 3.2.0
    * @okouai/core bumped to 8.606.1

## [0.820.0](https://github.com/vm0-ai/vm0/compare/app-v0.819.1...app-v0.820.0) (2026-09-01)


### Features

* graduate built-in model provider fallback ([#30861](https://github.com/vm0-ai/vm0/issues/30861)) ([be446a6](https://github.com/vm0-ai/vm0/commit/be446a6678a6fe32d6df9788b2b17550ebddd8b4))


### Bug Fixes

* **platform:** retry recoverable indexeddb transactions ([#30856](https://github.com/vm0-ai/vm0/issues/30856)) ([40afc95](https://github.com/vm0-ai/vm0/commit/40afc95afdd206ba78cfff193e9f26f127dd789a))


### Refactoring

* **platform:** simplify authenticated bootstrap ([#30840](https://github.com/vm0-ai/vm0/issues/30840)) ([eb30f9c](https://github.com/vm0-ai/vm0/commit/eb30f9c0aff0eeacdb01836f964fd79fa9c0925b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.387.0
    * @okouai/core bumped to 8.606.0

## [0.819.1](https://github.com/vm0-ai/vm0/compare/app-v0.819.0...app-v0.819.1) (2026-09-01)


### Bug Fixes

* **app:** use Okou status page for Instatus widget ([#30850](https://github.com/vm0-ai/vm0/issues/30850)) ([60060e6](https://github.com/vm0-ai/vm0/commit/60060e6ec616b48fe76eb6a42997ce00fe126cc8))


### Performance Improvements

* **platform:** prioritize bootstrap resources for first paint ([#30819](https://github.com/vm0-ai/vm0/issues/30819)) ([b975002](https://github.com/vm0-ai/vm0/commit/b975002c4d52073de866c9ef1ba5d08c5bcfb276))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.386.1
    * @okouai/core bumped to 8.605.10

## [0.819.0](https://github.com/vm0-ai/vm0/compare/app-v0.818.0...app-v0.819.0) (2026-09-01)


### Features

* **video:** add click-driven desktop camera workflow ([#30801](https://github.com/vm0-ai/vm0/issues/30801)) ([89d135a](https://github.com/vm0-ai/vm0/commit/89d135aaac7429a70dd77680af4adf6c9c60897a))


### Bug Fixes

* **platform:** reveal full pinned agent name on hover ([#30799](https://github.com/vm0-ai/vm0/issues/30799)) ([530c47d](https://github.com/vm0-ai/vm0/commit/530c47df5d33367961b4ed7537b23d2b3c3483f0))


### Refactoring

* **platform:** simplify bootstrap monitoring ([#30762](https://github.com/vm0-ai/vm0/issues/30762)) ([d20dca5](https://github.com/vm0-ai/vm0/commit/d20dca525001914cdfc7cb8a141e638cb38bf744))

## [0.818.0](https://github.com/vm0-ai/vm0/compare/app-v0.817.1...app-v0.818.0) (2026-09-01)


### Features

* manage morning brief from preferences ([#30805](https://github.com/vm0-ai/vm0/issues/30805)) ([a95ce9e](https://github.com/vm0-ai/vm0/commit/a95ce9ec44cb77f06e05cd99c28f052ddcd6cff5))
* **platform:** print mark notes on the image and slim the selection ([#30719](https://github.com/vm0-ai/vm0/issues/30719)) ([4e4d77f](https://github.com/vm0-ai/vm0/commit/4e4d77f12fdff0c5438c26294fb6c5749f17f68b))


### Bug Fixes

* **auth:** drive clerk cutover from primary app domain ([#30735](https://github.com/vm0-ai/vm0/issues/30735)) ([0fa7957](https://github.com/vm0-ai/vm0/commit/0fa795722080d2123e0564ba9006f8718b46e03d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.386.0
    * @okouai/core bumped to 8.605.9

## [0.817.1](https://github.com/vm0-ai/vm0/compare/app-v0.817.0...app-v0.817.1) (2026-09-01)


### Bug Fixes

* **platform:** scope chat scroll preload to locator jumps ([#30782](https://github.com/vm0-ai/vm0/issues/30782)) ([0f8218d](https://github.com/vm0-ai/vm0/commit/0f8218d6e76c536356f01859baa51ffca39ade93))

## [0.817.0](https://github.com/vm0-ai/vm0/compare/app-v0.816.0...app-v0.817.0) (2026-09-01)


### Features

* **platform:** log shared worker bridge messages ([#30749](https://github.com/vm0-ai/vm0/issues/30749)) ([e053b72](https://github.com/vm0-ai/vm0/commit/e053b7255641238380928a414d8276c0426d556c))


### Bug Fixes

* tidy emoji picker spacing onto one rail ([#30755](https://github.com/vm0-ai/vm0/issues/30755)) ([c349d96](https://github.com/vm0-ai/vm0/commit/c349d963726e900ef92a4500224372c13aeed355))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.385.1
    * @okouai/core bumped to 8.605.8

## [0.816.0](https://github.com/vm0-ai/vm0/compare/app-v0.815.4...app-v0.816.0) (2026-09-01)


### Features

* **api:** model automatic oauth for mcp connectors ([#30636](https://github.com/vm0-ai/vm0/issues/30636)) ([b33d6c2](https://github.com/vm0-ai/vm0/commit/b33d6c26e6df23aad23f9460124a203b11309a36))
* request connector account switches in chat ([#30602](https://github.com/vm0-ai/vm0/issues/30602)) ([4108626](https://github.com/vm0-ai/vm0/commit/4108626240e47072c6eeb3658a12fff649a57f87))


### Bug Fixes

* **api:** repair legacy snapshot revocation rows ([#30754](https://github.com/vm0-ai/vm0/issues/30754)) ([027642e](https://github.com/vm0-ai/vm0/commit/027642e96bb07f4290e8de1c2cd13b46219f6018))
* **platform:** include root turbo jsonc in eslint cache key ([#30746](https://github.com/vm0-ai/vm0/issues/30746)) ([6941eaf](https://github.com/vm0-ai/vm0/commit/6941eafded66b53f713f45253b7bee1a9989e8fb))


### Performance Improvements

* **platform:** cache repeated eslint runs ([#30711](https://github.com/vm0-ai/vm0/issues/30711)) ([e49160b](https://github.com/vm0-ai/vm0/commit/e49160b41afcf045098d29399dad96a7ab48d734))
* **platform:** reuse i18n extraction during lint ([#30720](https://github.com/vm0-ai/vm0/issues/30720)) ([458f16d](https://github.com/vm0-ai/vm0/commit/458f16d985756b6149249a6d86f1d2d2c11c4cdc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.385.0
    * @okouai/core bumped to 8.605.7

## [0.815.4](https://github.com/vm0-ai/vm0/compare/app-v0.815.3...app-v0.815.4) (2026-09-01)


### Performance Improvements

* **platform:** inline the bootstrap avatar ([#30718](https://github.com/vm0-ai/vm0/issues/30718)) ([1d51f40](https://github.com/vm0-ai/vm0/commit/1d51f40ce7f710b50873ab0700e3c5f924863885))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.384.3
    * @okouai/core bumped to 8.605.6

## [0.815.3](https://github.com/vm0-ai/vm0/compare/app-v0.815.2...app-v0.815.3) (2026-09-01)


### Bug Fixes

* **platform:** silently handle one tap load failures ([#30695](https://github.com/vm0-ai/vm0/issues/30695)) ([006ca53](https://github.com/vm0-ai/vm0/commit/006ca53a42c799154227daf2975967892e3d5f68))
* repair stale Morning Brief chat snapshots ([#30716](https://github.com/vm0-ai/vm0/issues/30716)) ([d458669](https://github.com/vm0-ai/vm0/commit/d458669d7f3ba92c746947fe28787cc498a64100))


### Refactoring

* **db:** contract legacy vm0 provider compatibility ([#30708](https://github.com/vm0-ai/vm0/issues/30708)) ([7ab758f](https://github.com/vm0-ai/vm0/commit/7ab758fea24f304dd1bdd25ca7a24457e20419e8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.384.2
    * @okouai/core bumped to 8.605.5

## [0.815.2](https://github.com/vm0-ai/vm0/compare/app-v0.815.1...app-v0.815.2) (2026-09-01)


### Bug Fixes

* **email:** link official workflow result footer to automation ([#30591](https://github.com/vm0-ai/vm0/issues/30591)) ([0e556c4](https://github.com/vm0-ai/vm0/commit/0e556c4e81749a8e4718f4ccbe1a2f151068c9f5))
* **platform:** restore smooth conversation locator jumps ([#30657](https://github.com/vm0-ai/vm0/issues/30657)) ([bc2c5d7](https://github.com/vm0-ai/vm0/commit/bc2c5d72c0cb0a130bb9cf1dfbe5067d7a41a004))

## [0.815.1](https://github.com/vm0-ai/vm0/compare/app-v0.815.0...app-v0.815.1) (2026-09-01)


### Bug Fixes

* **locator:** drop the preview counter and widen the band with its ticks ([#30662](https://github.com/vm0-ai/vm0/issues/30662)) ([96a4aa5](https://github.com/vm0-ai/vm0/commit/96a4aa5301b97d485ed81caaf295dfa370c56d5f))


### Performance Improvements

* **platform:** load clerk before app bootstrap ([#30628](https://github.com/vm0-ai/vm0/issues/30628)) ([c47e857](https://github.com/vm0-ai/vm0/commit/c47e8576b7669457018bca010e2d35d7ecafc669))
* **platform:** start shared worker before auth handshake ([#30661](https://github.com/vm0-ai/vm0/issues/30661)) ([e873720](https://github.com/vm0-ai/vm0/commit/e87372019a934192ae717cc6fb5b51693882b1f0))
