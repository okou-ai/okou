# Changelog

Older releases are archived by month:

- [2026-09](changelog/2026-09/CHANGELOG.md)
- [2026-08](changelog/2026-08/CHANGELOG.md)
- [2026-07](changelog/2026-07/CHANGELOG.md)
- [2026-06](changelog/2026-06/CHANGELOG.md)
- [2026-05](changelog/2026-05/CHANGELOG.md)
- [2026-04](changelog/2026-04/CHANGELOG.md)
- [2026-03](changelog/2026-03/CHANGELOG.md)
- [2026-02](changelog/2026-02/CHANGELOG.md)
- [2026-01](changelog/2026-01/CHANGELOG.md)

## [0.1009.0](https://github.com/okou-ai/okou/compare/app-v0.1008.2...app-v0.1009.0) (2026-10-10)


### Features

* add sidebar-first artifact previews behind a switch ([#38605](https://github.com/okou-ai/okou/issues/38605)) ([81341fb](https://github.com/okou-ai/okou/commit/81341fbbe6bd58b7a0e80823203a429e62e2887a))


### Bug Fixes

* **platform:** remove legacy fast model picker options ([#38619](https://github.com/okou-ai/okou/issues/38619)) ([7454454](https://github.com/okou-ai/okou/commit/745445415e26882f1ff09b1dd60fbe85adb5fbf8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.741.0

## [0.1008.2](https://github.com/okou-ai/okou/compare/app-v0.1008.1...app-v0.1008.2) (2026-10-10)


### Bug Fixes

* **app:** gate stable preview fullscreen layout ([#38444](https://github.com/okou-ai/okou/issues/38444)) ([dfa059a](https://github.com/okou-ai/okou/commit/dfa059a8d9a778ee720c3e744712dee718c3b8a7))
* **app:** retain artifact blobs during browser download handoff ([#38475](https://github.com/okou-ai/okou/issues/38475)) ([4122701](https://github.com/okou-ai/okou/commit/4122701f28a142ad0cd0876e2cacbcfee8848a58))
* **app:** use external-link icon for live browser open action ([#38583](https://github.com/okou-ai/okou/issues/38583)) ([2f5e522](https://github.com/okou-ai/okou/commit/2f5e522b6b9feb423f108e4af080810112b5d6ac))
* limit composer-anchored suggestions to chat threads ([#38575](https://github.com/okou-ai/okou/issues/38575)) ([f78ed44](https://github.com/okou-ai/okou/commit/f78ed443d2cb55aba7f34dbdba644acd85687d15))
* **platform:** record bootstrap and shared worker failures as telemetry ([#38581](https://github.com/okou-ai/okou/issues/38581)) ([6b19212](https://github.com/okou-ai/okou/commit/6b19212474d62ea17b72507c59c79be46e8548a5))
* show try again for safety policy refusals ([#38555](https://github.com/okou-ai/okou/issues/38555)) ([fb88a24](https://github.com/okou-ai/okou/commit/fb88a24dea118969c07fb2d2827c9fcf18f1a1a9))


### Refactoring

* **platform:** remove redundant standalone page z-index ([#38515](https://github.com/okou-ai/okou/issues/38515)) ([799c61c](https://github.com/okou-ai/okou/commit/799c61c30d213a870205bea2e7e32c79629cd3e4))
* remove notify mail feature switch ([#38561](https://github.com/okou-ai/okou/issues/38561)) ([7f40f95](https://github.com/okou-ai/okou/commit/7f40f954492838ac72a4d291848b2ef24266a9a7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.549.0
    * @okouai/core bumped to 8.740.1
    * @okouai/ui bumped to 1.13.2

## [0.1008.1](https://github.com/okou-ai/okou/compare/app-v0.1008.0...app-v0.1008.1) (2026-10-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.548.0
    * @okouai/core bumped to 8.740.0

## [0.1008.0](https://github.com/okou-ai/okou/compare/app-v0.1007.1...app-v0.1008.0) (2026-10-10)


### Features

* **discord:** complete oauth onboarding and slack conversation parity ([#37968](https://github.com/okou-ai/okou/issues/37968)) ([ccc74ac](https://github.com/okou-ai/okou/commit/ccc74ac9b9c74d70654fd0a0a547018cde7d55ed))


### Bug Fixes

* **platform:** align custom template picker with workflow layout ([#38401](https://github.com/okou-ai/okou/issues/38401)) ([c6386b8](https://github.com/okou-ai/okou/commit/c6386b84dd6c0ade208deb08e0e9e4747c7aa15c))
* **platform:** keep quest intro content during dialog exit ([#38464](https://github.com/okou-ai/okou/issues/38464)) ([01ea1bc](https://github.com/okou-ai/okou/commit/01ea1bc53052141955509b4e73aa9d1dd3b68c2e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.547.0
    * @okouai/core bumped to 8.739.2

## [0.1007.1](https://github.com/okou-ai/okou/compare/app-v0.1007.0...app-v0.1007.1) (2026-10-09)


### Documentation

* reorganize engineering guides and align testing policies ([#38421](https://github.com/okou-ai/okou/issues/38421)) ([60f5783](https://github.com/okou-ai/okou/commit/60f57836b2877b5e065bf27b7adf75c2f633b95d))


### Refactoring

* canonicalize historical model selections and constrain runtime captures ([#38389](https://github.com/okou-ai/okou/issues/38389)) ([1ab1fc2](https://github.com/okou-ai/okou/commit/1ab1fc21a3aabe940ee044cc6f4226faee2a668f))
* **platform:** remove redundant inner oauth consent z-index ([#38435](https://github.com/okou-ai/okou/issues/38435)) ([ce1f574](https://github.com/okou-ai/okou/commit/ce1f574b5cf11882de2bf92de2335712b309c567))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.739.1
    * @okouai/ui bumped to 1.13.1

## [0.1007.0](https://github.com/okou-ai/okou/compare/app-v0.1006.1...app-v0.1007.0) (2026-10-09)


### Features

* add sandbox covers for hosted artifacts ([#38149](https://github.com/okou-ai/okou/issues/38149)) ([f4a3140](https://github.com/okou-ai/okou/commit/f4a3140275a8c3334135080ed2427e837bc9fc89))
* add subscription controls and user-confirmed reset cards ([#37763](https://github.com/okou-ai/okou/issues/37763)) ([d9a0b29](https://github.com/okou-ai/okou/commit/d9a0b29aeb0866740540f5e970fcbf80709342d7))
* allow debug admins to clear organization openrouter presets ([#38407](https://github.com/okou-ai/okou/issues/38407)) ([a1464ca](https://github.com/okou-ai/okou/commit/a1464ca1752a1aa3247485b1582604ef10a276d1))
* allow debug admins to switch organization openrouter presets ([#38327](https://github.com/okou-ai/okou/issues/38327)) ([3ab4dfc](https://github.com/okou-ai/okou/commit/3ab4dfc68ffdf7afe085c52e3cf9040354c117d9))
* **app:** add opt-in responsive mobile navigation ([#37713](https://github.com/okou-ai/okou/issues/37713)) ([507bc00](https://github.com/okou-ai/okou/commit/507bc00e3fd3570b866c66d21c47871512938859))
* **core:** release eleven staff feature switches to all users ([#37818](https://github.com/okou-ai/okou/issues/37818)) ([8d05119](https://github.com/okou-ai/okou/commit/8d051194184d595b67f78f5d6f7ec728ed6cc31d))
* **db:** add immutable catalog tables and a shared test catalog ([#37697](https://github.com/okou-ai/okou/issues/37697)) ([f24c015](https://github.com/okou-ai/okou/commit/f24c0158fb5d44fe002399bea74aaec8822bf2c0))
* **debug:** add morning brief test emails ([#38411](https://github.com/okou-ai/okou/issues/38411)) ([ce2f1d5](https://github.com/okou-ai/okou/commit/ce2f1d5b3ce2cad351d5515e38dee95d05d148c9))
* enable phone group history, message sharing and social jobs globally ([#37716](https://github.com/okou-ai/okou/issues/37716)) ([b1ec157](https://github.com/okou-ai/okou/commit/b1ec157db9ded38688563e0f153df0ab8364802e))
* enable private artifacts for all users ([#37951](https://github.com/okou-ai/okou/issues/37951)) ([91e19d1](https://github.com/okou-ai/okou/commit/91e19d1e55e49ffb5822aa2a9d7fcb336b9cb9cf))
* **platform:** add a feature-gated last-read divider and entry positioning ([#37740](https://github.com/okou-ai/okou/issues/37740)) ([52fbc35](https://github.com/okou-ai/okou/commit/52fbc351e258b79ac0e9a104a46247d695ac959e))
* **platform:** add archive to mobile chat header ([#37805](https://github.com/okou-ai/okou/issues/37805)) ([949c258](https://github.com/okou-ai/okou/commit/949c258bdece47e14d6e1a7fc55a604f6feb71c1))
* **platform:** gate composer-anchored suggestion menus ([#38331](https://github.com/okou-ai/okou/issues/38331)) ([80aee42](https://github.com/okou-ai/okou/commit/80aee42a4cf92772b0d8b193df68089588a3b39f))
* **platform:** prepare tailscale-aware ssh and vnc readers ([#37814](https://github.com/okou-ai/okou/issues/37814)) ([a648388](https://github.com/okou-ai/okou/commit/a648388f2dd47531d577fe4e68205c505335a9c3))
* **platform:** slide pwa pages between tab roots and nested pages ([#37853](https://github.com/okou-ai/okou/issues/37853)) ([1d3fcca](https://github.com/okou-ai/okou/commit/1d3fccac2606c5a226b35b38a158b3c25b6da28a))
* prepare model identity compatibility without switching writes ([#38092](https://github.com/okou-ai/okou/issues/38092)) ([21177df](https://github.com/okou-ai/okou/commit/21177dfd37bc19114098a628a094adb67fb60db0))
* simplify mobile pwa chat list header ([#37728](https://github.com/okou-ai/okou/issues/37728)) ([4844ec7](https://github.com/okou-ai/okou/commit/4844ec7dd63b7854700dc2eb43f5fcf9ba9b41b3))
* **ui:** add a top-to-bottom wave to running chat indicators ([#37657](https://github.com/okou-ai/okou/issues/37657)) ([cfeeb01](https://github.com/okou-ai/okou/commit/cfeeb01c713cb8c44365f23448b418789ad712e8))


### Bug Fixes

* **app:** add native network log disclosure controls ([#38027](https://github.com/okou-ai/okou/issues/38027)) ([90be135](https://github.com/okou-ai/okou/commit/90be1356d1f97459f064e34d4b06ea550f8baf05))
* **app:** expose ideation category filter state ([#38023](https://github.com/okou-ai/okou/issues/38023)) ([5bff4a7](https://github.com/okou-ai/okou/commit/5bff4a703f1202249032822dea82a1507c6e9a0d))
* **app:** expose workflow filter selection state ([#38024](https://github.com/okou-ai/okou/issues/38024)) ([31a2ad7](https://github.com/okou-ai/okou/commit/31a2ad7fc108be956ae6c9c80a2753e709835401))
* **app:** keep billing pricing dialog stable across async loading ([#37801](https://github.com/okou-ai/okou/issues/37801)) ([3a62e63](https://github.com/okou-ai/okou/commit/3a62e6375801e96fa6378104c95f1818aad9eb32))
* **app:** keep the three-column chat list expanded ([#38182](https://github.com/okou-ai/okou/issues/38182)) ([f90c17d](https://github.com/okou-ai/okou/commit/f90c17d71c094490f5ac2992db542aec68e4e350))
* **app:** manage mobile sidebar focus with sheet ([#38034](https://github.com/okou-ai/okou/issues/38034)) ([c44c598](https://github.com/okou-ai/okou/commit/c44c598b9b9fbe549e2f088e0342d6527a391a41))
* **app:** preserve artifact reading state when expanding diagrams ([#38118](https://github.com/okou-ai/okou/issues/38118)) ([d2ce547](https://github.com/okou-ai/okou/commit/d2ce5471a31c238e2f45b4fc9f08246543114b0e))
* **app:** preserve image annotation ime input ([#38020](https://github.com/okou-ai/okou/issues/38020)) ([cada78c](https://github.com/okou-ai/okou/commit/cada78ceac3beb2a57195234dbc9c1393e7aa16a))
* **app:** preserve modified feishu icon download clicks ([#38026](https://github.com/okou-ai/okou/issues/38026)) ([d4f2a1f](https://github.com/okou-ai/okou/commit/d4f2a1f50c5135721d9eaedb34ccc79abfffb4ce))
* **app:** preserve safari ime confirmation in imported template titles ([#38022](https://github.com/okou-ai/okou/issues/38022)) ([2f87226](https://github.com/okou-ai/okou/commit/2f87226be63d2e54097ae75b5aa6f5060103ae5a))
* **app:** remove ppt template detail loading bar ([#38075](https://github.com/okou-ai/okou/issues/38075)) ([27cc202](https://github.com/okou-ai/okou/commit/27cc2027c516cac91ca57eb9bd893710a045699a))
* **app:** remove sidebar double-click rename ([#37775](https://github.com/okou-ai/okou/issues/37775)) ([2764bf6](https://github.com/okou-ai/okou/commit/2764bf6f755cb0f2e05cd98ff58cba51f247d53d))
* **app:** scope account connections and release multiple subscriptions ([#37714](https://github.com/okou-ai/okou/issues/37714)) ([db0d2ad](https://github.com/okou-ai/okou/commit/db0d2adf4400029a95f1a07fd6c50e48a7e4417e))
* **app:** use native links for ideation cards ([#38025](https://github.com/okou-ai/okou/issues/38025)) ([18c50ea](https://github.com/okou-ai/okou/commit/18c50eaf2c6edc265498331bc6b804bb845734fd))
* **app:** use native links for static navigation entries ([#38031](https://github.com/okou-ai/okou/issues/38031)) ([5a6ef9f](https://github.com/okou-ai/okou/commit/5a6ef9f8e3db3c2100dc83e0a8c8d41fa24769f0))
* **app:** use native spotlight search filters ([#37947](https://github.com/okou-ai/okou/issues/37947)) ([6766c12](https://github.com/okou-ai/okou/commit/6766c12541fa97b0ade1ef0e5cd956df8b8a7b34))
* **billing:** keep member usage packs nonnegative ([#38071](https://github.com/okou-ai/okou/issues/38071)) ([532c7f8](https://github.com/okou-ai/okou/commit/532c7f813cc2e824ff4fa487f251786848b8d752))
* fit composer-anchored mention menu to content ([#38418](https://github.com/okou-ai/okou/issues/38418)) ([6297b6f](https://github.com/okou-ai/okou/commit/6297b6f728d02d4b6f7461f99933bde9c1269fbf))
* let the model catalog decide which models accept reasoning effort ([#37958](https://github.com/okou-ai/okou/issues/37958)) ([abc2a1c](https://github.com/okou-ai/okou/commit/abc2a1c29edd2a840f109d36fd460aea6db3888a))
* **platform:** clarify searches and simplify connector focus ([#38084](https://github.com/okou-ai/okou/issues/38084)) ([8d385d7](https://github.com/okou-ai/okou/commit/8d385d71ad3b0ff11e3a2dd5e8304da23a016cc6))
* **platform:** drop credential source column from chat model picker ([#37924](https://github.com/okou-ai/okou/issues/37924)) ([3fbe719](https://github.com/okou-ai/okou/commit/3fbe719ec539bb68a51d0fb5deccfd9381b92989))
* **platform:** expose current workflow file as a menu radio selection ([#38029](https://github.com/okou-ai/okou/issues/38029)) ([2d7237a](https://github.com/okou-ai/okou/commit/2d7237a299393b10674f8638b686c4ff42373e80))
* **platform:** expose permission duration radio selection ([#38019](https://github.com/okou-ai/okou/issues/38019)) ([38c0321](https://github.com/okou-ai/okou/commit/38c03211c20d60e5889404cba53f48c0c3b6043c))
* **platform:** gate anchored composer layout for initial rollout ([#37976](https://github.com/okou-ai/okou/issues/37976)) ([80770f9](https://github.com/okou-ai/okou/commit/80770f9736da88ef673a21eba968bdb7349874a6))
* **platform:** keep completed followups opaque on thread entry ([#38231](https://github.com/okou-ai/okou/issues/38231)) ([d1cf638](https://github.com/okou-ai/okou/commit/d1cf638f579bc85348057ceadd8701b08b80c12c))
* **platform:** match template rail active state to shared hover layer ([#38397](https://github.com/okou-ai/okou/issues/38397)) ([497ca0d](https://github.com/okou-ai/okou/commit/497ca0db438805fbc8997eeb153b01acb0c2075b))
* **platform:** navigate immediately when archiving from the chat header ([#37938](https://github.com/okou-ai/okou/issues/37938)) ([367bc26](https://github.com/okou-ai/okou/commit/367bc268b77e01b0dafbe056fc81bfb5fea6fd98))
* **platform:** persist default connector account radio selection ([#38021](https://github.com/okou-ai/okou/issues/38021)) ([f2ec000](https://github.com/okou-ai/okou/commit/f2ec0006bf8d792dc9d20b5854c86e68f211f1c2))
* **platform:** preserve native pinned agent link activations ([#36523](https://github.com/okou-ai/okou/issues/36523)) ([ee36a55](https://github.com/okou-ai/okou/commit/ee36a5590a1ceca332ff1ef5d582c8e6a446507f))
* **platform:** preserve skill import on modified workflow link clicks ([#38017](https://github.com/okou-ai/okou/issues/38017)) ([5a4befc](https://github.com/okou-ai/okou/commit/5a4befc8551e7c16c3aa92f89a1c5283f63c8273))
* **platform:** register workflow file menu actions ([#38030](https://github.com/okou-ai/okou/issues/38030)) ([69bf326](https://github.com/okou-ai/okou/commit/69bf326e077760ed6e622b6c5ced1b242dd601f8))
* **platform:** reject silent voice uploads with a client vad gate ([#37784](https://github.com/okou-ai/okou/issues/37784)) ([4e9adf9](https://github.com/okou-ai/okou/commit/4e9adf9324b6d8f3c0c660bbde8ff8951215c50e))
* **platform:** remove model and byok plan highlights ([#37797](https://github.com/okou-ai/okou/issues/37797)) ([486298e](https://github.com/okou-ai/okou/commit/486298e628e544d65810cb37b0b7e2aec4b3fa49))
* **platform:** restore connector account rename focus ([#37939](https://github.com/okou-ai/okou/issues/37939)) ([c40583b](https://github.com/okou-ai/okou/commit/c40583b6a0e685fa2c8c58ab657779b0804a2005))
* **platform:** scope image navigation keys to the focused canvas ([#36527](https://github.com/okou-ai/okou/issues/36527)) ([fb921ee](https://github.com/okou-ai/okou/commit/fb921ee515fee951cfa8cc33664696f5b56c06bb))
* **platform:** skip the pwa slide after a browser swipe navigation ([#37880](https://github.com/okou-ai/okou/issues/37880)) ([90e4f4a](https://github.com/okou-ai/okou/commit/90e4f4acc7bdc8fdb2dd02a06904a1c57c77f0b2))
* **platform:** split the workflow detail dialog into sample and decision columns ([#38007](https://github.com/okou-ai/okou/issues/38007)) ([200b4e5](https://github.com/okou-ai/okou/commit/200b4e57ca7c36a13116fa128c80a4b2b5e33478))
* **platform:** stop retrying failed realtime handlers and use ably retry defaults ([#38375](https://github.com/okou-ai/okou/issues/38375)) ([9813db4](https://github.com/okou-ai/okou/commit/9813db4b51faa42c982dcfec1720caf5bd5b1b82))
* **platform:** submit chat events alongside read-status effects ([#37991](https://github.com/okou-ai/okou/issues/37991)) ([0fbd917](https://github.com/okou-ai/okou/commit/0fbd91781aa4f04bc8e6a41d6242fda959917d75))
* **platform:** submit feishu and lark wizard steps natively ([#38018](https://github.com/okou-ai/okou/issues/38018)) ([770ca24](https://github.com/okou-ai/okou/commit/770ca24ead6cd475bef8c1846d16f54d9859e1e2))
* **platform:** use filled icons for active pwa tabs ([#37749](https://github.com/okou-ai/okou/issues/37749)) ([7341256](https://github.com/okou-ai/okou/commit/7341256d123ca8583d5af1537afe80c5b827297c))
* **platform:** use native buttons for mobile sidebar disclosures ([#36514](https://github.com/okou-ai/okou/issues/36514)) ([df048aa](https://github.com/okou-ai/okou/commit/df048aa008484b05199a1606c4b68652ca1a41f7))
* **platform:** use native links for model approval pages ([#37756](https://github.com/okou-ai/okou/issues/37756)) ([73ddcf9](https://github.com/okou-ai/okou/commit/73ddcf90af7e260d331987c18b380970afb59590))
* **platform:** use neutral colors for chat reference chips ([#38311](https://github.com/okou-ai/okou/issues/38311)) ([9ca9bfe](https://github.com/okou-ai/okou/commit/9ca9bfee4e3c3f89de8059b0b1592999cccd60cf))
* simplify subscription reset card controls ([#37780](https://github.com/okou-ai/okou/issues/37780)) ([65338a1](https://github.com/okou-ai/okou/commit/65338a1201a4eed55bda1ed8a01dc91ac15bea4b))
* stop reporting handled clerk ui and invalid workflow payload errors ([#38299](https://github.com/okou-ai/okou/issues/38299)) ([d138629](https://github.com/okou-ai/okou/commit/d13862990122a1309790326f956e5b093faa73ad))
* suppress pwa push while the user is foreground in the same org ([#38091](https://github.com/okou-ai/okou/issues/38091)) ([22f89a5](https://github.com/okou-ai/okou/commit/22f89a5c8b69990bb3834c7678acb25f00d1c823))
* **voice:** separate segment transcription from final polish ([#38082](https://github.com/okou-ai/okou/issues/38082)) ([1c7cb86](https://github.com/okou-ai/okou/commit/1c7cb86855d50504a57a6fcb86b9357a5965e3de))


### Refactoring

* **api:** use client-only platform realtime token exchange ([#38105](https://github.com/okou-ai/okou/issues/38105)) ([0fdfb57](https://github.com/okou-ai/okou/commit/0fdfb57b88d655219e84f18050a88362071cdd41))
* **artifacts:** use artifact identity for google drive uploads ([#38300](https://github.com/okou-ai/okou/issues/38300)) ([e223f5e](https://github.com/okou-ai/okou/commit/e223f5e45fd22cdd729f84f075686ec5afb24b6e))
* clean up released switch leftovers and drop legacy chat thread provider pins ([#37851](https://github.com/okou-ai/okou/issues/37851)) ([066e9c3](https://github.com/okou-ai/okou/commit/066e9c32c2bbd5e3d48783fb0028f8dcfbaeaf06))
* finish connector catalog release 2 follow-up cleanup ([#37895](https://github.com/okou-ai/okou/issues/37895)) ([013d37d](https://github.com/okou-ai/okou/commit/013d37d5513f5ff071097621e4436109742f6dc8))
* graduate fully rolled out feature switches ([#37721](https://github.com/okou-ai/okou/issues/37721)) ([62e6dd4](https://github.com/okou-ai/okou/commit/62e6dd43c07ccfd77517d6f653ab123a37aff89f))
* move release 1 connector catalog consumers off legacy storage ([#37861](https://github.com/okou-ai/okou/issues/37861)) ([e664957](https://github.com/okou-ai/okou/commit/e664957caa2056a336595e55f475001b81247fd0))
* **platform:** give the pwa slide its own signal-owned command ([#37882](https://github.com/okou-ai/okou/issues/37882)) ([54fc41a](https://github.com/okou-ai/okou/commit/54fc41ad05bd241feaa3abc354a7818753ca27ac))
* **platform:** remove abandoned chat last-read marker ([#37966](https://github.com/okou-ai/okou/issues/37966)) ([d85fdca](https://github.com/okou-ai/okou/commit/d85fdcad049428b366f892a181c69e7ab61a8523))
* **platform:** remove page clearing and the react app skeleton ([#37857](https://github.com/okou-ai/okou/issues/37857)) ([7fbda7d](https://github.com/okou-ai/okou/commit/7fbda7de74bad50dad377ffe0d048c41fadc8a2f))
* **platform:** remove realtime connection diagnostics ([#38324](https://github.com/okou-ai/okou/issues/38324)) ([d301ace](https://github.com/okou-ai/okou/commit/d301ace84cc169d8d0565a97a77902e812995ab9))
* **platform:** remove redundant inner auth z-index ([#38416](https://github.com/okou-ai/okou/issues/38416)) ([0c78361](https://github.com/okou-ai/okou/commit/0c78361c9c40e0bd2b99cc38565f4c9783adfdfa)), closes [#35878](https://github.com/okou-ai/okou/issues/35878)
* **platform:** route account rename refresh through waitLoopUntil ([#38083](https://github.com/okou-ai/okou/issues/38083)) ([527a8df](https://github.com/okou-ai/okou/commit/527a8dfc46c4c1e37158dd3a8b66d7d407985bdb))
* **platform:** simplify transcript-local stacking ([#38360](https://github.com/okou-ai/okou/issues/38360)) ([e278a3e](https://github.com/okou-ai/okou/commit/e278a3e460f0f958a5607f7d935d465392bcb2e0))
* **platform:** start the pwa slide before the route moves ([#37868](https://github.com/okou-ai/okou/issues/37868)) ([892d17e](https://github.com/okou-ai/okou/commit/892d17e1f2096acbaf24e9c822c24f0a38db2f01))
* **platform:** use native file selection controls ([#38032](https://github.com/okou-ai/okou/issues/38032)) ([98c9a7f](https://github.com/okou-ai/okou/commit/98c9a7f25c4f2f46d30b8eaa479773a365270488))
* remove abandoned langfuse trace feature ([#38010](https://github.com/okou-ai/okou/issues/38010)) ([5080d02](https://github.com/okou-ai/okou/commit/5080d026e68f10f41285570f52a9b655fb562052))
* remove agent responsibility setup feature switch ([#38069](https://github.com/okou-ai/okou/issues/38069)) ([bbb313e](https://github.com/okou-ai/okou/commit/bbb313e561cf6904565d5b91e7e227e2016557ee))
* remove all remaining custom model mode awareness ([#37856](https://github.com/okou-ai/okou/issues/37856)) ([f383835](https://github.com/okou-ai/okou/commit/f3838353ba0455ec7d57dfa2d0974e34a44796ff))
* remove connector catalog diagnostics endpoint and cron response fields ([#37907](https://github.com/okou-ai/okou/issues/37907)) ([0d2b5d1](https://github.com/okou-ai/okou/commit/0d2b5d1a7bae269f2fcac0bf23f7ae377df07244))
* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))
* remove eleven released feature switches ([#37848](https://github.com/okou-ai/okou/issues/37848)) ([53255d6](https://github.com/okou-ai/okou/commit/53255d66854676285dad37eb13b3266ebe578031))
* remove expired deployment compatibility ([#37845](https://github.com/okou-ai/okou/issues/37845)) ([ada585f](https://github.com/okou-ai/okou/commit/ada585fdc70a1fc5c26e70e0ec53bbef893c4f4c))
* remove remaining model provider residue ([#37870](https://github.com/okou-ai/okou/issues/37870)) ([a93133b](https://github.com/okou-ai/okou/commit/a93133b0493858a39924a1206ff5a5677e43cad6))
* remove retired per-agent ssh access traces ([#37876](https://github.com/okou-ai/okou/issues/37876)) ([dc33264](https://github.com/okou-ai/okou/commit/dc332649051e79460f1075a294ba8d3707f8504f))
* represent auto model selection as null ([#37901](https://github.com/okou-ai/okou/issues/37901)) ([d0e0b71](https://github.com/okou-ai/okou/commit/d0e0b7191fe168e8935e1abf3df1fa1806efea2a))
* retire claude code manual usage reset ([#37755](https://github.com/okou-ai/okou/issues/37755)) ([1855ed7](https://github.com/okou-ai/okou/commit/1855ed7f5d58c7aa931a6acc27f2fa375edc395f))
* retire cooldown, ultrafast, us routing and model provider leftovers ([#37884](https://github.com/okou-ai/okou/issues/37884)) ([a9c3270](https://github.com/okou-ai/okou/commit/a9c3270099034c0f7ee73f6c730b07efa7d1d733))
* retire organization custom model configuration ([#37746](https://github.com/okou-ai/okou/issues/37746)) ([014fe18](https://github.com/okou-ai/okou/commit/014fe1867c6d1830fd35b03c3d77491da5aaa36a))
* retire organization usage allowance ([#37971](https://github.com/okou-ai/okou/issues/37971)) ([2659878](https://github.com/okou-ai/okou/commit/26598788903fb817edd71d82ccbdfcd66cfa3a0a))
* **ui:** use native network type checkbox menu items ([#36525](https://github.com/okou-ai/okou/issues/36525)) ([e9241d9](https://github.com/okou-ai/okou/commit/e9241d948e5a565afa081e2e44f533a545c9bb8a))


### Performance Improvements

* **ci:** build app once and remove deployment probes ([#37794](https://github.com/okou-ai/okou/issues/37794)) ([c0a3dfd](https://github.com/okou-ai/okou/commit/c0a3dfdbaa222244926ff14f6e50cdab5384acc4))
* **platform:** pin i18next-cli to 1.74.0 to fix quadratic i18n lint ([#37825](https://github.com/okou-ai/okou/issues/37825)) ([f5360e5](https://github.com/okou-ai/okou/commit/f5360e56a58748cd5c808a8b73943372315274ad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.546.0
    * @okouai/core bumped to 8.739.0

## [0.1006.1](https://github.com/okou-ai/okou/compare/app-v0.1006.0...app-v0.1006.1) (2026-10-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.545.1
    * @okouai/core bumped to 8.738.1

## [0.1006.0](https://github.com/okou-ai/okou/compare/app-v0.1005.0...app-v0.1006.0) (2026-10-09)


### Features

* add sandbox covers for hosted artifacts ([#38149](https://github.com/okou-ai/okou/issues/38149)) ([f4a3140](https://github.com/okou-ai/okou/commit/f4a3140275a8c3334135080ed2427e837bc9fc89))
* **platform:** gate composer-anchored suggestion menus ([#38331](https://github.com/okou-ai/okou/issues/38331)) ([80aee42](https://github.com/okou-ai/okou/commit/80aee42a4cf92772b0d8b193df68089588a3b39f))
* **ui:** add a top-to-bottom wave to running chat indicators ([#37657](https://github.com/okou-ai/okou/issues/37657)) ([cfeeb01](https://github.com/okou-ai/okou/commit/cfeeb01c713cb8c44365f23448b418789ad712e8))


### Bug Fixes

* **platform:** stop retrying failed realtime handlers and use ably retry defaults ([#38375](https://github.com/okou-ai/okou/issues/38375)) ([9813db4](https://github.com/okou-ai/okou/commit/9813db4b51faa42c982dcfec1720caf5bd5b1b82))


### Refactoring

* **platform:** simplify transcript-local stacking ([#38360](https://github.com/okou-ai/okou/issues/38360)) ([e278a3e](https://github.com/okou-ai/okou/commit/e278a3e460f0f958a5607f7d935d465392bcb2e0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.545.0
    * @okouai/core bumped to 8.738.0
    * @okouai/ui bumped to 1.13.0

## [0.1005.0](https://github.com/okou-ai/okou/compare/app-v0.1004.2...app-v0.1005.0) (2026-10-09)


### Features

* allow debug admins to switch organization openrouter presets ([#38327](https://github.com/okou-ai/okou/issues/38327)) ([3ab4dfc](https://github.com/okou-ai/okou/commit/3ab4dfc68ffdf7afe085c52e3cf9040354c117d9))


### Bug Fixes

* **platform:** gate anchored composer layout for initial rollout ([#37976](https://github.com/okou-ai/okou/issues/37976)) ([80770f9](https://github.com/okou-ai/okou/commit/80770f9736da88ef673a21eba968bdb7349874a6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.544.0
    * @okouai/core bumped to 8.737.3

## [0.1004.2](https://github.com/okou-ai/okou/compare/app-v0.1004.1...app-v0.1004.2) (2026-10-09)


### Bug Fixes

* **platform:** register workflow file menu actions ([#38030](https://github.com/okou-ai/okou/issues/38030)) ([69bf326](https://github.com/okou-ai/okou/commit/69bf326e077760ed6e622b6c5ced1b242dd601f8))
* stop reporting handled clerk ui and invalid workflow payload errors ([#38299](https://github.com/okou-ai/okou/issues/38299)) ([d138629](https://github.com/okou-ai/okou/commit/d13862990122a1309790326f956e5b093faa73ad))


### Refactoring

* **artifacts:** use artifact identity for google drive uploads ([#38300](https://github.com/okou-ai/okou/issues/38300)) ([e223f5e](https://github.com/okou-ai/okou/commit/e223f5e45fd22cdd729f84f075686ec5afb24b6e))
* retire organization usage allowance ([#37971](https://github.com/okou-ai/okou/issues/37971)) ([2659878](https://github.com/okou-ai/okou/commit/26598788903fb817edd71d82ccbdfcd66cfa3a0a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.543.0
    * @okouai/core bumped to 8.737.2

## [0.1004.1](https://github.com/okou-ai/okou/compare/app-v0.1004.0...app-v0.1004.1) (2026-10-09)


### Bug Fixes

* **platform:** keep completed followups opaque on thread entry ([#38231](https://github.com/okou-ai/okou/issues/38231)) ([d1cf638](https://github.com/okou-ai/okou/commit/d1cf638f579bc85348057ceadd8701b08b80c12c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.542.1
    * @okouai/core bumped to 8.737.1

## [0.1004.0](https://github.com/okou-ai/okou/compare/app-v0.1003.3...app-v0.1004.0) (2026-10-09)


### Features

* prepare model identity compatibility without switching writes ([#38092](https://github.com/okou-ai/okou/issues/38092)) ([21177df](https://github.com/okou-ai/okou/commit/21177dfd37bc19114098a628a094adb67fb60db0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.542.0
    * @okouai/core bumped to 8.737.0

## [0.1003.3](https://github.com/okou-ai/okou/compare/app-v0.1003.2...app-v0.1003.3) (2026-10-08)


### Bug Fixes

* **app:** keep the three-column chat list expanded ([#38182](https://github.com/okou-ai/okou/issues/38182)) ([f90c17d](https://github.com/okou-ai/okou/commit/f90c17d71c094490f5ac2992db542aec68e4e350))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.541.0
    * @okouai/core bumped to 8.736.0

## [0.1003.2](https://github.com/okou-ai/okou/compare/app-v0.1003.1...app-v0.1003.2) (2026-10-08)


### Bug Fixes

* **app:** preserve artifact reading state when expanding diagrams ([#38118](https://github.com/okou-ai/okou/issues/38118)) ([d2ce547](https://github.com/okou-ai/okou/commit/d2ce5471a31c238e2f45b4fc9f08246543114b0e))
* **billing:** keep member usage packs nonnegative ([#38071](https://github.com/okou-ai/okou/issues/38071)) ([532c7f8](https://github.com/okou-ai/okou/commit/532c7f813cc2e824ff4fa487f251786848b8d752))
* suppress pwa push while the user is foreground in the same org ([#38091](https://github.com/okou-ai/okou/issues/38091)) ([22f89a5](https://github.com/okou-ai/okou/commit/22f89a5c8b69990bb3834c7678acb25f00d1c823))
* **voice:** separate segment transcription from final polish ([#38082](https://github.com/okou-ai/okou/issues/38082)) ([1c7cb86](https://github.com/okou-ai/okou/commit/1c7cb86855d50504a57a6fcb86b9357a5965e3de))


### Refactoring

* **api:** use client-only platform realtime token exchange ([#38105](https://github.com/okou-ai/okou/issues/38105)) ([0fdfb57](https://github.com/okou-ai/okou/commit/0fdfb57b88d655219e84f18050a88362071cdd41))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.540.0
    * @okouai/core bumped to 8.735.2
    * @okouai/ui bumped to 1.12.5

## [0.1003.1](https://github.com/okou-ai/okou/compare/app-v0.1003.0...app-v0.1003.1) (2026-10-08)


### Bug Fixes

* **app:** add native network log disclosure controls ([#38027](https://github.com/okou-ai/okou/issues/38027)) ([90be135](https://github.com/okou-ai/okou/commit/90be1356d1f97459f064e34d4b06ea550f8baf05))
* **app:** expose workflow filter selection state ([#38024](https://github.com/okou-ai/okou/issues/38024)) ([31a2ad7](https://github.com/okou-ai/okou/commit/31a2ad7fc108be956ae6c9c80a2753e709835401))
* **app:** manage mobile sidebar focus with sheet ([#38034](https://github.com/okou-ai/okou/issues/38034)) ([c44c598](https://github.com/okou-ai/okou/commit/c44c598b9b9fbe549e2f088e0342d6527a391a41))
* **app:** preserve modified feishu icon download clicks ([#38026](https://github.com/okou-ai/okou/issues/38026)) ([d4f2a1f](https://github.com/okou-ai/okou/commit/d4f2a1f50c5135721d9eaedb34ccc79abfffb4ce))
* **app:** preserve safari ime confirmation in imported template titles ([#38022](https://github.com/okou-ai/okou/issues/38022)) ([2f87226](https://github.com/okou-ai/okou/commit/2f87226be63d2e54097ae75b5aa6f5060103ae5a))
* **app:** remove ppt template detail loading bar ([#38075](https://github.com/okou-ai/okou/issues/38075)) ([27cc202](https://github.com/okou-ai/okou/commit/27cc2027c516cac91ca57eb9bd893710a045699a))
* **app:** use native links for ideation cards ([#38025](https://github.com/okou-ai/okou/issues/38025)) ([18c50ea](https://github.com/okou-ai/okou/commit/18c50eaf2c6edc265498331bc6b804bb845734fd))
* **app:** use native links for static navigation entries ([#38031](https://github.com/okou-ai/okou/issues/38031)) ([5a6ef9f](https://github.com/okou-ai/okou/commit/5a6ef9f8e3db3c2100dc83e0a8c8d41fa24769f0))
* **platform:** expose current workflow file as a menu radio selection ([#38029](https://github.com/okou-ai/okou/issues/38029)) ([2d7237a](https://github.com/okou-ai/okou/commit/2d7237a299393b10674f8638b686c4ff42373e80))
* **platform:** preserve skill import on modified workflow link clicks ([#38017](https://github.com/okou-ai/okou/issues/38017)) ([5a4befc](https://github.com/okou-ai/okou/commit/5a4befc8551e7c16c3aa92f89a1c5283f63c8273))
* **platform:** submit feishu and lark wizard steps natively ([#38018](https://github.com/okou-ai/okou/issues/38018)) ([770ca24](https://github.com/okou-ai/okou/commit/770ca24ead6cd475bef8c1846d16f54d9859e1e2))


### Refactoring

* remove agent responsibility setup feature switch ([#38069](https://github.com/okou-ai/okou/issues/38069)) ([bbb313e](https://github.com/okou-ai/okou/commit/bbb313e561cf6904565d5b91e7e227e2016557ee))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.539.1
    * @okouai/core bumped to 8.735.1
    * @okouai/ui bumped to 1.12.4

## [0.1003.0](https://github.com/okou-ai/okou/compare/app-v0.1002.2...app-v0.1003.0) (2026-10-08)


### Features

* enable private artifacts for all users ([#37951](https://github.com/okou-ai/okou/issues/37951)) ([91e19d1](https://github.com/okou-ai/okou/commit/91e19d1e55e49ffb5822aa2a9d7fcb336b9cb9cf))


### Bug Fixes

* **platform:** restore connector account rename focus ([#37939](https://github.com/okou-ai/okou/issues/37939)) ([c40583b](https://github.com/okou-ai/okou/commit/c40583b6a0e685fa2c8c58ab657779b0804a2005))
* **platform:** scope image navigation keys to the focused canvas ([#36527](https://github.com/okou-ai/okou/issues/36527)) ([fb921ee](https://github.com/okou-ai/okou/commit/fb921ee515fee951cfa8cc33664696f5b56c06bb))
* **platform:** submit chat events alongside read-status effects ([#37991](https://github.com/okou-ai/okou/issues/37991)) ([0fbd917](https://github.com/okou-ai/okou/commit/0fbd91781aa4f04bc8e6a41d6242fda959917d75))


### Refactoring

* **platform:** remove abandoned chat last-read marker ([#37966](https://github.com/okou-ai/okou/issues/37966)) ([d85fdca](https://github.com/okou-ai/okou/commit/d85fdcad049428b366f892a181c69e7ab61a8523))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.539.0
    * @okouai/core bumped to 8.735.0

## [0.1002.2](https://github.com/okou-ai/okou/compare/app-v0.1002.1...app-v0.1002.2) (2026-10-08)


### Bug Fixes

* **app:** use native spotlight search filters ([#37947](https://github.com/okou-ai/okou/issues/37947)) ([6766c12](https://github.com/okou-ai/okou/commit/6766c12541fa97b0ade1ef0e5cd956df8b8a7b34))
* let the model catalog decide which models accept reasoning effort ([#37958](https://github.com/okou-ai/okou/issues/37958)) ([abc2a1c](https://github.com/okou-ai/okou/commit/abc2a1c29edd2a840f109d36fd460aea6db3888a))
* **platform:** preserve native pinned agent link activations ([#36523](https://github.com/okou-ai/okou/issues/36523)) ([ee36a55](https://github.com/okou-ai/okou/commit/ee36a5590a1ceca332ff1ef5d582c8e6a446507f))
* **platform:** use native buttons for mobile sidebar disclosures ([#36514](https://github.com/okou-ai/okou/issues/36514)) ([df048aa](https://github.com/okou-ai/okou/commit/df048aa008484b05199a1606c4b68652ca1a41f7))


### Refactoring

* **ui:** use native network type checkbox menu items ([#36525](https://github.com/okou-ai/okou/issues/36525)) ([e9241d9](https://github.com/okou-ai/okou/commit/e9241d948e5a565afa081e2e44f533a545c9bb8a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.538.1
    * @okouai/core bumped to 8.734.9
    * @okouai/ui bumped to 1.12.3

## [0.1002.1](https://github.com/okou-ai/okou/compare/app-v0.1002.0...app-v0.1002.1) (2026-10-08)


### Bug Fixes

* **platform:** navigate immediately when archiving from the chat header ([#37938](https://github.com/okou-ai/okou/issues/37938)) ([367bc26](https://github.com/okou-ai/okou/commit/367bc268b77e01b0dafbe056fc81bfb5fea6fd98))

## [0.1002.0](https://github.com/okou-ai/okou/compare/app-v0.1001.5...app-v0.1002.0) (2026-10-08)


### Features

* **platform:** prepare tailscale-aware ssh and vnc readers ([#37814](https://github.com/okou-ai/okou/issues/37814)) ([a648388](https://github.com/okou-ai/okou/commit/a648388f2dd47531d577fe4e68205c505335a9c3))


### Bug Fixes

* **platform:** drop credential source column from chat model picker ([#37924](https://github.com/okou-ai/okou/issues/37924)) ([3fbe719](https://github.com/okou-ai/okou/commit/3fbe719ec539bb68a51d0fb5deccfd9381b92989))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.538.0
    * @okouai/connectors bumped to 3.16.7
    * @okouai/core bumped to 8.734.8

## [0.1001.5](https://github.com/okou-ai/okou/compare/app-v0.1001.4...app-v0.1001.5) (2026-10-07)


### Refactoring

* represent auto model selection as null ([#37901](https://github.com/okou-ai/okou/issues/37901)) ([d0e0b71](https://github.com/okou-ai/okou/commit/d0e0b7191fe168e8935e1abf3df1fa1806efea2a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.14
    * @okouai/connectors bumped to 3.16.6
    * @okouai/core bumped to 8.734.7

## [0.1001.4](https://github.com/okou-ai/okou/compare/app-v0.1001.3...app-v0.1001.4) (2026-10-07)


### Refactoring

* finish connector catalog release 2 follow-up cleanup ([#37895](https://github.com/okou-ai/okou/issues/37895)) ([013d37d](https://github.com/okou-ai/okou/commit/013d37d5513f5ff071097621e4436109742f6dc8))
* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))
* retire cooldown, ultrafast, us routing and model provider leftovers ([#37884](https://github.com/okou-ai/okou/issues/37884)) ([a9c3270](https://github.com/okou-ai/okou/commit/a9c3270099034c0f7ee73f6c730b07efa7d1d733))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.13
    * @okouai/connectors bumped to 3.16.5
    * @okouai/core bumped to 8.734.6

## [0.1001.3](https://github.com/okou-ai/okou/compare/app-v0.1001.2...app-v0.1001.3) (2026-10-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.12
    * @okouai/connectors bumped to 3.16.4
    * @okouai/core bumped to 8.734.5

## [0.1001.2](https://github.com/okou-ai/okou/compare/app-v0.1001.1...app-v0.1001.2) (2026-10-07)


### Bug Fixes

* **platform:** skip the pwa slide after a browser swipe navigation ([#37880](https://github.com/okou-ai/okou/issues/37880)) ([90e4f4a](https://github.com/okou-ai/okou/commit/90e4f4acc7bdc8fdb2dd02a06904a1c57c77f0b2))


### Refactoring

* move release 1 connector catalog consumers off legacy storage ([#37861](https://github.com/okou-ai/okou/issues/37861)) ([e664957](https://github.com/okou-ai/okou/commit/e664957caa2056a336595e55f475001b81247fd0))
* **platform:** start the pwa slide before the route moves ([#37868](https://github.com/okou-ai/okou/issues/37868)) ([892d17e](https://github.com/okou-ai/okou/commit/892d17e1f2096acbaf24e9c822c24f0a38db2f01))
* remove remaining model provider residue ([#37870](https://github.com/okou-ai/okou/issues/37870)) ([a93133b](https://github.com/okou-ai/okou/commit/a93133b0493858a39924a1206ff5a5677e43cad6))
* remove retired per-agent ssh access traces ([#37876](https://github.com/okou-ai/okou/issues/37876)) ([dc33264](https://github.com/okou-ai/okou/commit/dc332649051e79460f1075a294ba8d3707f8504f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.11
    * @okouai/connectors bumped to 3.16.3
    * @okouai/core bumped to 8.734.4

## [0.1001.1](https://github.com/okou-ai/okou/compare/app-v0.1001.0...app-v0.1001.1) (2026-10-07)


### Refactoring

* clean up released switch leftovers and drop legacy chat thread provider pins ([#37851](https://github.com/okou-ai/okou/issues/37851)) ([066e9c3](https://github.com/okou-ai/okou/commit/066e9c32c2bbd5e3d48783fb0028f8dcfbaeaf06))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.10
    * @okouai/core bumped to 8.734.3

## [0.1001.0](https://github.com/okou-ai/okou/compare/app-v0.1000.1...app-v0.1001.0) (2026-10-07)


### Features

* **platform:** slide pwa pages between tab roots and nested pages ([#37853](https://github.com/okou-ai/okou/issues/37853)) ([1d3fcca](https://github.com/okou-ai/okou/commit/1d3fccac2606c5a226b35b38a158b3c25b6da28a))


### Refactoring

* **platform:** remove page clearing and the react app skeleton ([#37857](https://github.com/okou-ai/okou/issues/37857)) ([7fbda7d](https://github.com/okou-ai/okou/commit/7fbda7de74bad50dad377ffe0d048c41fadc8a2f))
* remove all remaining custom model mode awareness ([#37856](https://github.com/okou-ai/okou/issues/37856)) ([f383835](https://github.com/okou-ai/okou/commit/f3838353ba0455ec7d57dfa2d0974e34a44796ff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.9
    * @okouai/core bumped to 8.734.2

## [0.1000.1](https://github.com/okou-ai/okou/compare/app-v0.1000.0...app-v0.1000.1) (2026-10-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.8
    * @okouai/connectors bumped to 3.16.2
    * @okouai/core bumped to 8.734.1

## [0.1000.0](https://github.com/okou-ai/okou/compare/app-v0.999.2...app-v0.1000.0) (2026-10-06)


### Features

* **core:** release eleven staff feature switches to all users ([#37818](https://github.com/okou-ai/okou/issues/37818)) ([8d05119](https://github.com/okou-ai/okou/commit/8d051194184d595b67f78f5d6f7ec728ed6cc31d))


### Refactoring

* remove expired deployment compatibility ([#37845](https://github.com/okou-ai/okou/issues/37845)) ([ada585f](https://github.com/okou-ai/okou/commit/ada585fdc70a1fc5c26e70e0ec53bbef893c4f4c))


### Performance Improvements

* **platform:** pin i18next-cli to 1.74.0 to fix quadratic i18n lint ([#37825](https://github.com/okou-ai/okou/issues/37825)) ([f5360e5](https://github.com/okou-ai/okou/commit/f5360e56a58748cd5c808a8b73943372315274ad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.7
    * @okouai/core bumped to 8.734.0

## [0.999.2](https://github.com/okou-ai/okou/compare/app-v0.999.1...app-v0.999.2) (2026-10-06)


### Refactoring

* retire organization custom model configuration ([#37746](https://github.com/okou-ai/okou/issues/37746)) ([014fe18](https://github.com/okou-ai/okou/commit/014fe1867c6d1830fd35b03c3d77491da5aaa36a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.6
    * @okouai/core bumped to 8.733.3

## [0.999.1](https://github.com/okou-ai/okou/compare/app-v0.999.0...app-v0.999.1) (2026-10-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.5
    * @okouai/connectors bumped to 3.16.1
    * @okouai/core bumped to 8.733.2

## [0.999.0](https://github.com/okou-ai/okou/compare/app-v0.998.7...app-v0.999.0) (2026-10-06)


### Features

* **platform:** add archive to mobile chat header ([#37805](https://github.com/okou-ai/okou/issues/37805)) ([949c258](https://github.com/okou-ai/okou/commit/949c258bdece47e14d6e1a7fc55a604f6feb71c1))

## [0.998.7](https://github.com/okou-ai/okou/compare/app-v0.998.6...app-v0.998.7) (2026-10-06)


### Bug Fixes

* **app:** keep billing pricing dialog stable across async loading ([#37801](https://github.com/okou-ai/okou/issues/37801)) ([3a62e63](https://github.com/okou-ai/okou/commit/3a62e6375801e96fa6378104c95f1818aad9eb32))

## [0.998.6](https://github.com/okou-ai/okou/compare/app-v0.998.5...app-v0.998.6) (2026-10-06)


### Bug Fixes

* **platform:** remove model and byok plan highlights ([#37797](https://github.com/okou-ai/okou/issues/37797)) ([486298e](https://github.com/okou-ai/okou/commit/486298e628e544d65810cb37b0b7e2aec4b3fa49))

## [0.998.5](https://github.com/okou-ai/okou/compare/app-v0.998.4...app-v0.998.5) (2026-10-06)


### Performance Improvements

* **ci:** build app once and remove deployment probes ([#37794](https://github.com/okou-ai/okou/issues/37794)) ([c0a3dfd](https://github.com/okou-ai/okou/commit/c0a3dfdbaa222244926ff14f6e50cdab5384acc4))

## [0.998.4](https://github.com/okou-ai/okou/compare/app-v0.998.3...app-v0.998.4) (2026-10-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.4
    * @okouai/core bumped to 8.733.1

## [0.998.3](https://github.com/okou-ai/okou/compare/app-v0.998.2...app-v0.998.3) (2026-10-06)


### Bug Fixes

* **platform:** reject silent voice uploads with a client vad gate ([#37784](https://github.com/okou-ai/okou/issues/37784)) ([4e9adf9](https://github.com/okou-ai/okou/commit/4e9adf9324b6d8f3c0c660bbde8ff8951215c50e))
* simplify subscription reset card controls ([#37780](https://github.com/okou-ai/okou/issues/37780)) ([65338a1](https://github.com/okou-ai/okou/commit/65338a1201a4eed55bda1ed8a01dc91ac15bea4b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.733.0

## [0.998.2](https://github.com/okou-ai/okou/compare/app-v0.998.1...app-v0.998.2) (2026-10-06)


### Bug Fixes

* **app:** remove sidebar double-click rename ([#37775](https://github.com/okou-ai/okou/issues/37775)) ([2764bf6](https://github.com/okou-ai/okou/commit/2764bf6f755cb0f2e05cd98ff58cba51f247d53d))

## [0.998.1](https://github.com/okou-ai/okou/compare/app-v0.998.0...app-v0.998.1) (2026-10-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.3
    * @okouai/connectors bumped to 3.16.0
    * @okouai/core bumped to 8.732.1

## [0.998.0](https://github.com/okou-ai/okou/compare/app-v0.997.1...app-v0.998.0) (2026-10-05)


### Features

* **db:** add immutable catalog tables and a shared test catalog ([#37697](https://github.com/okou-ai/okou/issues/37697)) ([f24c015](https://github.com/okou-ai/okou/commit/f24c0158fb5d44fe002399bea74aaec8822bf2c0))

## [0.997.1](https://github.com/okou-ai/okou/compare/app-v0.997.0...app-v0.997.1) (2026-10-05)


### Bug Fixes

* **platform:** use filled icons for active pwa tabs ([#37749](https://github.com/okou-ai/okou/issues/37749)) ([7341256](https://github.com/okou-ai/okou/commit/7341256d123ca8583d5af1537afe80c5b827297c))
* **platform:** use native links for model approval pages ([#37756](https://github.com/okou-ai/okou/issues/37756)) ([73ddcf9](https://github.com/okou-ai/okou/commit/73ddcf90af7e260d331987c18b380970afb59590))


### Refactoring

* retire claude code manual usage reset ([#37755](https://github.com/okou-ai/okou/issues/37755)) ([1855ed7](https://github.com/okou-ai/okou/commit/1855ed7f5d58c7aa931a6acc27f2fa375edc395f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.732.0

## [0.997.0](https://github.com/okou-ai/okou/compare/app-v0.996.2...app-v0.997.0) (2026-10-05)


### Features

* **platform:** add a feature-gated last-read divider and entry positioning ([#37740](https://github.com/okou-ai/okou/issues/37740)) ([52fbc35](https://github.com/okou-ai/okou/commit/52fbc351e258b79ac0e9a104a46247d695ac959e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.2
    * @okouai/core bumped to 8.731.0

## [0.996.2](https://github.com/okou-ai/okou/compare/app-v0.996.1...app-v0.996.2) (2026-10-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.1
    * @okouai/core bumped to 8.730.2

## [0.996.1](https://github.com/okou-ai/okou/compare/app-v0.996.0...app-v0.996.1) (2026-10-05)


### Refactoring

* graduate fully rolled out feature switches ([#37721](https://github.com/okou-ai/okou/issues/37721)) ([62e6dd4](https://github.com/okou-ai/okou/commit/62e6dd43c07ccfd77517d6f653ab123a37aff89f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.730.1

## [0.996.0](https://github.com/okou-ai/okou/compare/app-v0.995.0...app-v0.996.0) (2026-10-05)


### Features

* simplify mobile pwa chat list header ([#37728](https://github.com/okou-ai/okou/issues/37728)) ([4844ec7](https://github.com/okou-ai/okou/commit/4844ec7dd63b7854700dc2eb43f5fcf9ba9b41b3))

## [0.995.0](https://github.com/okou-ai/okou/compare/app-v0.994.0...app-v0.995.0) (2026-10-05)


### Features

* enable phone group history, message sharing and social jobs globally ([#37716](https://github.com/okou-ai/okou/issues/37716)) ([b1ec157](https://github.com/okou-ai/okou/commit/b1ec157db9ded38688563e0f153df0ab8364802e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.730.0

## [0.994.0](https://github.com/okou-ai/okou/compare/app-v0.993.0...app-v0.994.0) (2026-10-05)


### Features

* **app:** add opt-in responsive mobile navigation ([#37713](https://github.com/okou-ai/okou/issues/37713)) ([507bc00](https://github.com/okou-ai/okou/commit/507bc00e3fd3570b866c66d21c47871512938859))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.729.0

## [0.993.0](https://github.com/okou-ai/okou/compare/app-v0.992.0...app-v0.993.0) (2026-10-04)


### Features

* **platform:** add muted chat list filter ([#37691](https://github.com/okou-ai/okou/issues/37691)) ([cf155ac](https://github.com/okou-ai/okou/commit/cf155ac9e19c1ce08a1a55fa43f97ff5da358d7f))


### Bug Fixes

* **platform:** show inbox filter when chat archiving is enabled ([#37692](https://github.com/okou-ai/okou/issues/37692)) ([fcc16bd](https://github.com/okou-ai/okou/commit/fcc16bd06b002909610f6e4319795f14e9ce7280))

## [0.992.0](https://github.com/okou-ai/okou/compare/app-v0.991.6...app-v0.992.0) (2026-10-04)


### Features

* add organization-gated thread muting ([#37681](https://github.com/okou-ai/okou/issues/37681)) ([267fa71](https://github.com/okou-ai/okou/commit/267fa71b3cf85592fcbb7b644cdfefc1f5d642ff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.537.0
    * @okouai/core bumped to 8.728.0

## [0.991.6](https://github.com/okou-ai/okou/compare/app-v0.991.5...app-v0.991.6) (2026-10-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.536.2
    * @okouai/core bumped to 8.727.2

## [0.991.5](https://github.com/okou-ai/okou/compare/app-v0.991.4...app-v0.991.5) (2026-10-04)


### Bug Fixes

* **app:** normalize slack icon size in onboarding ([#37676](https://github.com/okou-ai/okou/issues/37676)) ([0ffd6a2](https://github.com/okou-ai/okou/commit/0ffd6a2ee15480bfecbd7b4777a3556464733d7a))

## [0.991.4](https://github.com/okou-ai/okou/compare/app-v0.991.3...app-v0.991.4) (2026-10-03)


### Bug Fixes

* preserve pi length completion and cap luna effort at xhigh ([#37607](https://github.com/okou-ai/okou/issues/37607)) ([acb1094](https://github.com/okou-ai/okou/commit/acb10941881de41850f70ab3a4930f22041812b0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/ui bumped to 1.12.2

## [0.991.3](https://github.com/okou-ai/okou/compare/app-v0.991.2...app-v0.991.3) (2026-10-03)


### Bug Fixes

* **deps:** clear new high pnpm audit findings without patched releases ([#37601](https://github.com/okou-ai/okou/issues/37601)) ([47440e8](https://github.com/okou-ai/okou/commit/47440e804b57e7c00fde42cc14ffdd72ae593749))

## [0.991.2](https://github.com/okou-ai/okou/compare/app-v0.991.1...app-v0.991.2) (2026-10-02)


### Refactoring

* remove retired video generation entitlement ([#37580](https://github.com/okou-ai/okou/issues/37580)) ([d6fb17a](https://github.com/okou-ai/okou/commit/d6fb17af11171e4edd1e7a9b289e255db602a402))
* retire legacy free organization tier ([#37581](https://github.com/okou-ai/okou/issues/37581)) ([26691d8](https://github.com/okou-ai/okou/commit/26691d89ca363d22a9ed045b23fc02894a21d043))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.536.1
    * @okouai/core bumped to 8.727.1

## [0.991.1](https://github.com/okou-ai/okou/compare/app-v0.991.0...app-v0.991.1) (2026-10-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.536.0
    * @okouai/core bumped to 8.727.0

## [0.991.0](https://github.com/okou-ai/okou/compare/app-v0.990.7...app-v0.991.0) (2026-10-02)


### Features

* add owner-selected rsa-aes vnc profiles ([#37548](https://github.com/okou-ai/okou/issues/37548)) ([6716f9a](https://github.com/okou-ai/okou/commit/6716f9afed2943ab4c18f0c8aa435a20f2e7f47b))


### Bug Fixes

* **app:** align pro upgrade concurrency copy with plan limits ([#37565](https://github.com/okou-ai/okou/issues/37565)) ([5082528](https://github.com/okou-ai/okou/commit/50825281399fd2936139bfe7fceb5b544757b96d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.535.0
    * @okouai/core bumped to 8.726.1

## [0.990.7](https://github.com/okou-ai/okou/compare/app-v0.990.6...app-v0.990.7) (2026-10-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.534.0
    * @okouai/core bumped to 8.726.0

## [0.990.6](https://github.com/okou-ai/okou/compare/app-v0.990.5...app-v0.990.6) (2026-10-02)


### Refactoring

* **platform:** bind account search debounce to page lifecycle ([#37492](https://github.com/okou-ai/okou/issues/37492)) ([e072833](https://github.com/okou-ai/okou/commit/e07283388b6590bb222f8059b1ef29f298d89892))

## [0.990.5](https://github.com/okou-ai/okou/compare/app-v0.990.4...app-v0.990.5) (2026-10-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.725.7

## [0.990.4](https://github.com/okou-ai/okou/compare/app-v0.990.3...app-v0.990.4) (2026-10-02)


### Bug Fixes

* **platform:** throttle worker indicator refreshes ([#37538](https://github.com/okou-ai/okou/issues/37538)) ([142747e](https://github.com/okou-ai/okou/commit/142747eece04d8346b23764911c862f357a5658f))

## [0.990.3](https://github.com/okou-ai/okou/compare/app-v0.990.2...app-v0.990.3) (2026-10-01)


### Bug Fixes

* **app:** simplify auto model account connection states ([#37519](https://github.com/okou-ai/okou/issues/37519)) ([8385c05](https://github.com/okou-ai/okou/commit/8385c05827f8a34c32a599ebd48fb970825adf68))

## [0.990.2](https://github.com/okou-ai/okou/compare/app-v0.990.1...app-v0.990.2) (2026-10-01)


### Refactoring

* **api:** prepare advisory lock cleanup release 1 ([#37313](https://github.com/okou-ai/okou/issues/37313)) ([77b3c9f](https://github.com/okou-ai/okou/commit/77b3c9f855bb9cd434eefc68ab2cb2cb9eb11ab2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.533.2
    * @okouai/core bumped to 8.725.6

## [0.990.1](https://github.com/okou-ai/okou/compare/app-v0.990.0...app-v0.990.1) (2026-10-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.533.1
    * @okouai/core bumped to 8.725.5

## [0.990.0](https://github.com/okou-ai/okou/compare/app-v0.989.5...app-v0.990.0) (2026-10-01)


### Features

* **vnc:** add owner-selected qemu scram profile ([#37486](https://github.com/okou-ai/okou/issues/37486)) ([8562a7a](https://github.com/okou-ai/okou/commit/8562a7a241033ae023a588e9ead5643e93990957))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.533.0
    * @okouai/core bumped to 8.725.4

## [0.989.5](https://github.com/okou-ai/okou/compare/app-v0.989.4...app-v0.989.5) (2026-10-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.532.3
    * @okouai/connectors bumped to 3.15.6
    * @okouai/core bumped to 8.725.3

## [0.989.4](https://github.com/okou-ai/okou/compare/app-v0.989.3...app-v0.989.4) (2026-10-01)


### Bug Fixes

* **platform:** surface imessage onboarding and display numeric phone numbers ([#37478](https://github.com/okou-ai/okou/issues/37478)) ([706cc37](https://github.com/okou-ai/okou/commit/706cc37f73e9f00494cd07015422be92e20748ec))

## [0.989.3](https://github.com/okou-ai/okou/compare/app-v0.989.2...app-v0.989.3) (2026-10-01)


### Refactoring

* remove model catalog rollout compatibility ([#37457](https://github.com/okou-ai/okou/issues/37457)) ([bfdefb5](https://github.com/okou-ai/okou/commit/bfdefb56cc71e50764957c7f168584df7398c7b4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.532.2
    * @okouai/core bumped to 8.725.2

## [0.989.2](https://github.com/okou-ai/okou/compare/app-v0.989.1...app-v0.989.2) (2026-10-01)


### Documentation

* rotate api and app changelogs for 2026-10 ([#37446](https://github.com/okou-ai/okou/issues/37446)) ([a06ea1c](https://github.com/okou-ai/okou/commit/a06ea1c6a37ed97d74639b81dadc357fa3dc7a8f))

## [0.989.1](https://github.com/okou-ai/okou/compare/app-v0.989.0...app-v0.989.1) (2026-10-01)


### Refactoring

* remove expired deployment compatibility ([#37439](https://github.com/okou-ai/okou/issues/37439)) ([bc8e82f](https://github.com/okou-ai/okou/commit/bc8e82f9151022ce93cff17e29b4273752d61a1f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.532.1
    * @okouai/core bumped to 8.725.1
