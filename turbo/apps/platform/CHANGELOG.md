# Changelog

Older releases are archived by month:

- [2026-10](changelog/2026-10/CHANGELOG.md)
- [2026-09](changelog/2026-09/CHANGELOG.md)
- [2026-08](changelog/2026-08/CHANGELOG.md)
- [2026-07](changelog/2026-07/CHANGELOG.md)
- [2026-06](changelog/2026-06/CHANGELOG.md)
- [2026-05](changelog/2026-05/CHANGELOG.md)
- [2026-04](changelog/2026-04/CHANGELOG.md)
- [2026-03](changelog/2026-03/CHANGELOG.md)
- [2026-02](changelog/2026-02/CHANGELOG.md)
- [2026-01](changelog/2026-01/CHANGELOG.md)

## [0.1094.0](https://github.com/okou-ai/okou/compare/app-v0.1093.0...app-v0.1094.0) (2026-11-04)


### Features

* **app:** add invitation code signup and gift entry ([#45113](https://github.com/okou-ai/okou/issues/45113)) ([e3a5087](https://github.com/okou-ai/okou/commit/e3a50872ffd66edfc312105fa3f8202869451324))
* **app:** lay out the website share menu settings as menu rows behind a switch ([#45194](https://github.com/okou-ai/okou/issues/45194)) ([99fc106](https://github.com/okou-ai/okou/commit/99fc1069313e3edc6abc5d93dd20d4486869cb9e))
* **app:** show subscription usage in the sidebar ring ([#45141](https://github.com/okou-ai/okou/issues/45141)) ([a7352b0](https://github.com/okou-ai/okou/commit/a7352b0be3b77f5f1e15d804aeb49cd2f5efea18))
* **app:** support inline project renaming ([#45200](https://github.com/okou-ai/okou/issues/45200)) ([96cb0bd](https://github.com/okou-ai/okou/commit/96cb0bd3647768946e5ea09881fe8a62515e866d))
* roll out marketing content handoff to all users ([#45187](https://github.com/okou-ai/okou/issues/45187)) ([58c27f0](https://github.com/okou-ai/okou/commit/58c27f02dfc1a8b171752cb634184b9318f89871))


### Bug Fixes

* **app:** keep subscription preview closed after dialog dismissal ([#45179](https://github.com/okou-ai/okou/issues/45179)) ([c7e872e](https://github.com/okou-ai/okou/commit/c7e872e209afb8fd584fd8fd447d6706a15b8ae9))
* **app:** simplify shell authorization cards ([#45197](https://github.com/okou-ai/okou/issues/45197)) ([d9e6a3d](https://github.com/okou-ai/okou/commit/d9e6a3d28470df08f1ca63ee05864e8c5167e8e8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.41.0
    * @okouai/core bumped to 8.817.0

## [0.1093.0](https://github.com/okou-ai/okou/compare/app-v0.1092.0...app-v0.1093.0) (2026-11-04)


### Features

* enable cjk markdown emphasis for all users ([#45132](https://github.com/okou-ai/okou/issues/45132)) ([f8fbf51](https://github.com/okou-ai/okou/commit/f8fbf5178c22f72686b37549bb5d1a87293d07c0))


### Bug Fixes

* **app:** preserve connector popover layout with chat accounts ([#45137](https://github.com/okou-ai/okou/issues/45137)) ([fa06464](https://github.com/okou-ai/okou/commit/fa064641cc49710b17a66a7019cb766bcd4c0baa))
* **app:** refine chat home compliance footer hierarchy ([#44151](https://github.com/okou-ai/okou/issues/44151)) ([1d1d273](https://github.com/okou-ai/okou/commit/1d1d273e38cedf2df6f05b163d4020a4e1f30f4e))
* **browser:** avoid unavailable flashes during capture resizing ([#45153](https://github.com/okou-ai/okou/issues/45153)) ([b0c822a](https://github.com/okou-ai/okou/commit/b0c822a8a9488bf80a1a282274c98916f836a7b2))


### Refactoring

* **app:** remove homepage task discovery ([#45136](https://github.com/okou-ai/okou/issues/45136)) ([221db9b](https://github.com/okou-ai/okou/commit/221db9bb5b9739e0d9bd295afe7cf232ce5b97aa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.40.1
    * @okouai/core bumped to 8.816.0

## [0.1092.0](https://github.com/okou-ai/okou/compare/app-v0.1091.0...app-v0.1092.0) (2026-11-04)


### Features

* **browser:** recover viewer resources with bounded retries ([#45051](https://github.com/okou-ai/okou/issues/45051)) ([12d04ed](https://github.com/okou-ai/okou/commit/12d04edfec0737589b7e8a666128980e185ec008))
* **browser:** retain viewer frames during recovery ([#45109](https://github.com/okou-ai/okou/issues/45109)) ([93c1920](https://github.com/okou-ai/okou/commit/93c1920310bd4caeecea736a33322cdb475a67c9))


### Bug Fixes

* **app:** create projects optimistically ([#45134](https://github.com/okou-ai/okou/issues/45134)) ([4c4da6f](https://github.com/okou-ai/okou/commit/4c4da6fadb3c73950b94bfe865c110018e757159))
* **app:** hydrate project cache alongside chat list ([#45090](https://github.com/okou-ai/okou/issues/45090)) ([84b58ab](https://github.com/okou-ai/okou/commit/84b58ab4d52cba0c8aca2164afd160ff00cf4c0e))
* **app:** open models from sidebar subscription usage ([#45086](https://github.com/okou-ai/okou/issues/45086)) ([db178ee](https://github.com/okou-ai/okou/commit/db178eee3e803f70b76dac5242e6d9e4eae4095b))
* **app:** preserve header appearance while loading ([#45099](https://github.com/okou-ai/okou/issues/45099)) ([6c30252](https://github.com/okou-ai/okou/commit/6c302526da25835c64aa844eb1a4d79797746e5a))
* **app:** smooth chat list collapse and center divider hit targets ([#45008](https://github.com/okou-ai/okou/issues/45008)) ([7b08927](https://github.com/okou-ai/okou/commit/7b0892753efdcda688f539dae0ac2178b257063d))
* **platform:** unify project and chat thread indexeddb caching ([#45102](https://github.com/okou-ai/okou/issues/45102)) ([02679d7](https://github.com/okou-ai/okou/commit/02679d7fe2fea27283b57bc38681532c7c42fd02))

## [0.1091.0](https://github.com/okou-ai/okou/compare/app-v0.1090.0...app-v0.1091.0) (2026-11-04)


### Features

* **core:** enable projects for staff ([#45012](https://github.com/okou-ai/okou/issues/45012)) ([1c4dff2](https://github.com/okou-ai/okou/commit/1c4dff2cbb485abfce7e587bf91e411b79a7336a))


### Bug Fixes

* **app:** preserve header actions while switching chats ([#45030](https://github.com/okou-ai/okou/issues/45030)) ([b2cab5b](https://github.com/okou-ai/okou/commit/b2cab5b32b2e23a86754f2096de4c53fd62d9f0b))
* **browser:** unify recovery ownership and usable readiness ([#44959](https://github.com/okou-ai/okou/issues/44959)) ([3aa45d9](https://github.com/okou-ai/okou/commit/3aa45d97a28c68749580a0a3e5d24ce8dfade705))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.40.0
    * @okouai/core bumped to 8.815.0

## [0.1090.0](https://github.com/okou-ai/okou/compare/app-v0.1089.0...app-v0.1090.0) (2026-11-03)


### Features

* add chat connector account controls to web ([#44897](https://github.com/okou-ai/okou/issues/44897)) ([5127205](https://github.com/okou-ai/okou/commit/512720518384529c210da187393419d31920b132))
* add friend referrals with expiring credit rewards ([#44961](https://github.com/okou-ai/okou/issues/44961)) ([beaff0e](https://github.com/okou-ai/okou/commit/beaff0e0ddf72f5d2fcd835314f14d6661e721af))
* **app:** add a compact sidebar subscription usage entry ([#44989](https://github.com/okou-ai/okou/issues/44989)) ([91a9aa7](https://github.com/okou-ai/okou/commit/91a9aa7b74dc003b9277c4a25d70e2b5e914368d))
* shorten marketing handoff links to twelve characters ([#44980](https://github.com/okou-ai/okou/issues/44980)) ([046a7ba](https://github.com/okou-ai/okou/commit/046a7bac03cc5f5a94cc67394756f69be2eaf111))


### Bug Fixes

* **app:** match project chat row spacing to chat history ([#45000](https://github.com/okou-ai/okou/issues/45000)) ([f98b3c9](https://github.com/okou-ai/okou/commit/f98b3c9b82200bf2cfd4453a469b892ee96ccb8f))
* **app:** open model settings from account menu subscriptions ([#45009](https://github.com/okou-ai/okou/issues/45009)) ([4d88fbd](https://github.com/okou-ai/okou/commit/4d88fbd3e77a62fea8b3a8c16af04a5ae1c6e375))
* **app:** share capability icons between tools and onboarding ([#44977](https://github.com/okou-ai/okou/issues/44977)) ([33f7195](https://github.com/okou-ai/okou/commit/33f7195c708e82384730e2b5806d025646df4d56))
* preserve project folders during chat navigation ([#45001](https://github.com/okou-ai/okou/issues/45001)) ([acc41bd](https://github.com/okou-ai/okou/commit/acc41bd16eb0edc770aacf8ab0a3e2018fa51766))


### Refactoring

* **platform:** centralize async utility helpers ([#44996](https://github.com/okou-ai/okou/issues/44996)) ([8adf870](https://github.com/okou-ai/okou/commit/8adf87014b3f6ffc58fd63ef8e14047be762a159))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.39.0
    * @okouai/connectors bumped to 3.21.2
    * @okouai/core bumped to 8.814.0

## [0.1089.0](https://github.com/okou-ai/okou/compare/app-v0.1088.0...app-v0.1089.0) (2026-11-03)


### Features

* **platform:** drag chats into project groups ([#44950](https://github.com/okou-ai/okou/issues/44950)) ([be6bf0e](https://github.com/okou-ai/okou/commit/be6bf0e7f7e9f63d95f24805bf17a34b4ce297ec))


### Bug Fixes

* **app:** keep tools popover above its trigger with bounded scrolling ([#44936](https://github.com/okou-ai/okou/issues/44936)) ([16737ff](https://github.com/okou-ai/okou/commit/16737ff6f95cec83f63ff237c6eef481f799a7c3))
* **app:** match sidebar chat title font weight ([#44929](https://github.com/okou-ai/okou/issues/44929)) ([58f7c36](https://github.com/okou-ai/okou/commit/58f7c36297499fefe27d90950154ab9e993d8120))
* **app:** remove standalone chat header pin button ([#44927](https://github.com/okou-ai/okou/issues/44927)) ([ed06b4e](https://github.com/okou-ai/okou/commit/ed06b4ec35178b2c2fa5a13027b2f3ded7940af5))
* **app:** use the connector icon in catalog debug settings ([#44966](https://github.com/okou-ai/okou/issues/44966)) ([9b94677](https://github.com/okou-ai/okou/commit/9b946777b44fcec4377e0963e8bb98124c5eae34))
* **browser:** isolate viewer read and discovery failures ([#44917](https://github.com/okou-ai/okou/issues/44917)) ([cd26945](https://github.com/okou-ai/okou/commit/cd2694576ccede5adc986647528efe195f3340d6))
* **platform:** apply project chat actions optimistically ([#44926](https://github.com/okou-ai/okou/issues/44926)) ([19d9217](https://github.com/okou-ai/okou/commit/19d92170439a89d19535759cfbef0c7a2419d355))
* **platform:** point cloudinary media ideation at asset management mcp ([#44955](https://github.com/okou-ai/okou/issues/44955)) ([d77091b](https://github.com/okou-ai/okou/commit/d77091bc251b96d15c20632178f58a05c04afa52))
* show folder icons for project mention suggestions ([#44940](https://github.com/okou-ai/okou/issues/44940)) ([66befdb](https://github.com/okou-ai/okou/commit/66befdb7c790eb4b32b6889980ce59b17abc9272))


### Refactoring

* **platform:** bound markdown math and project event loops by their conditions ([#44948](https://github.com/okou-ai/okou/issues/44948)) ([070611b](https://github.com/okou-ai/okou/commit/070611be96321c60c8dfa5befd838e2f47b3b33f))
* retire project wire preparation adapters ([#44956](https://github.com/okou-ai/okou/issues/44956)) ([babbf94](https://github.com/okou-ai/okou/commit/babbf9431679a767b0e6e8221d99a3c50b094293))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.38.1
    * @okouai/browser-extension-client bumped to 0.4.4
    * @okouai/core bumped to 8.813.1
    * @okouai/ui bumped to 1.19.0

## [0.1088.0](https://github.com/okou-ai/okou/compare/app-v0.1087.4...app-v0.1088.0) (2026-11-03)


### Features

* **api:** show active connector catalog version in debug settings ([#44900](https://github.com/okou-ai/okou/issues/44900)) ([2e3fd47](https://github.com/okou-ai/okou/commit/2e3fd47a9993bfee38cba6607954b37e4ff1222c))
* **platform:** show router capability families as published in onboarding ([#44914](https://github.com/okou-ai/okou/issues/44914)) ([2bf7b9b](https://github.com/okou-ai/okou/commit/2bf7b9b981609ab046ff167743ff949bddefe344))


### Bug Fixes

* **app:** preserve focus while saving remote host access ([#44896](https://github.com/okou-ai/okou/issues/44896)) ([a63393a](https://github.com/okou-ai/okou/commit/a63393a163ba7072ec32f692412e46be49cb1d93))
* **app:** simplify markdown table footer actions ([#44911](https://github.com/okou-ai/okou/issues/44911)) ([6624aa7](https://github.com/okou-ai/okou/commit/6624aa77a3e85464a8573cbb524c13060f768683))
* **app:** tighten spacing between projects and chats ([#44916](https://github.com/okou-ai/okou/issues/44916)) ([d16ecd5](https://github.com/okou-ai/okou/commit/d16ecd5a3abc7546cb4366647b79743da9e3171b))
* **app:** use singular chart task label ([#44915](https://github.com/okou-ai/okou/issues/44915)) ([7c39d82](https://github.com/okou-ai/okou/commit/7c39d827ee9e32245c24387d94bb2f6dd8f6b2d8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.38.0
    * @okouai/connectors bumped to 3.21.1
    * @okouai/core bumped to 8.813.0

## [0.1087.4](https://github.com/okou-ai/okou/compare/app-v0.1087.3...app-v0.1087.4) (2026-11-03)


### Bug Fixes

* **app:** group remote access hosts by protocol and enabled state ([#44870](https://github.com/okou-ai/okou/issues/44870)) ([b5ac4bc](https://github.com/okou-ai/okou/commit/b5ac4bc7c0211eb00690f231ae93849f889d097b))


### Refactoring

* **browser:** centralize viewer recovery and narrow dependencies ([#44871](https://github.com/okou-ai/okou/issues/44871)) ([9a92576](https://github.com/okou-ai/okou/commit/9a92576dbe083f3afb96c9dfbc4debf8209600b6))
* retire shared-chat link, site title and telegram bot list compatibility ([#44887](https://github.com/okou-ai/okou/issues/44887)) ([d8f4e29](https://github.com/okou-ai/okou/commit/d8f4e29836f9a70ea4f1c2ee54de79c2380a37f9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.37.1
    * @okouai/core bumped to 8.812.2

## [0.1087.3](https://github.com/okou-ai/okou/compare/app-v0.1087.2...app-v0.1087.3) (2026-11-03)


### Bug Fixes

* **app:** align project sidebar with chat navigation ([#44839](https://github.com/okou-ai/okou/issues/44839)) ([7aa9fee](https://github.com/okou-ai/okou/commit/7aa9fee9aca40a016a019fe587b2421eeb4551bb))

## [0.1087.2](https://github.com/okou-ai/okou/compare/app-v0.1087.1...app-v0.1087.2) (2026-11-03)


### Bug Fixes

* attribute local firewall auth failures through run completion ([#44847](https://github.com/okou-ai/okou/issues/44847)) ([d672c61](https://github.com/okou-ai/okou/commit/d672c6141ad26b6f19522363841b7659a7c38673))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.37.0
    * @okouai/core bumped to 8.812.1

## [0.1087.1](https://github.com/okou-ai/okou/compare/app-v0.1087.0...app-v0.1087.1) (2026-11-03)


### Bug Fixes

* **app:** rename visualization task label to charts ([#44830](https://github.com/okou-ai/okou/issues/44830)) ([53bf130](https://github.com/okou-ai/okou/commit/53bf13017bdddb74d3a4c13e598b3145b59287ba))
* **app:** stabilize homepage discovery icons in safari ([#44832](https://github.com/okou-ai/okou/issues/44832)) ([017ff41](https://github.com/okou-ai/okou/commit/017ff4168b73f75145c07a1b74665667468fab15))
* **browser:** attribute native navigation rejections safely ([#44836](https://github.com/okou-ai/okou/issues/44836)) ([c40af58](https://github.com/okou-ai/okou/commit/c40af58d91481b3ce3a3696de642d5dba61ee930))
* **browser:** recover crashed page renderers without stale readiness ([#44805](https://github.com/okou-ai/okou/issues/44805)) ([7d8d433](https://github.com/okou-ai/okou/commit/7d8d43385447609e2f8f918e95f28bfa2935722f))
* keep feed feedback in the original card position ([#44843](https://github.com/okou-ai/okou/issues/44843)) ([f6d7913](https://github.com/okou-ai/okou/commit/f6d79138acf010b3364fcba03465cfd9771c5716))
* **platform:** classify owned browser input cancellations as aborts ([#44835](https://github.com/okou-ai/okou/issues/44835)) ([dd02549](https://github.com/okou-ai/okou/commit/dd02549e38443c14c1dc1f47510e5972cd4ef772))
* use chat consistently in interface copy ([#44841](https://github.com/okou-ai/okou/issues/44841)) ([cab1f61](https://github.com/okou-ai/okou/commit/cab1f617736d9918070fae7060b92f01f7d7e1b1))


### Refactoring

* **browser:** derive presentation from owned resource state ([#44846](https://github.com/okou-ai/okou/issues/44846)) ([59a09de](https://github.com/okou-ai/okou/commit/59a09deb49960f01d76915963ba7b12af9e7674d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.36.1
    * @okouai/connectors bumped to 3.21.0
    * @okouai/core bumped to 8.812.0

## [0.1087.0](https://github.com/okou-ai/okou/compare/app-v0.1086.0...app-v0.1087.0) (2026-11-03)


### Features

* use chat connector accounts for runs and cli switching ([#44778](https://github.com/okou-ai/okou/issues/44778)) ([9eb2bcb](https://github.com/okou-ai/okou/commit/9eb2bcba1f9804a86b338b63eb0c05d20852962f))


### Bug Fixes

* **browser:** continue lease renewal after gateway failures ([#44800](https://github.com/okou-ai/okou/issues/44800)) ([ecaad07](https://github.com/okou-ai/okou/commit/ecaad07edba38b6dbdf455a4b6d671b8127d749d))
* **browser:** isolate frames connection loss from viewer control ([#44802](https://github.com/okou-ai/okou/issues/44802)) ([d043458](https://github.com/okou-ai/okou/commit/d043458b7b6d19afaff42a9d6e21548ff2e7a77e))
* **platform:** bound unanswered browser requests and expose recovery ([#44801](https://github.com/okou-ai/okou/issues/44801)) ([47f22ca](https://github.com/okou-ai/okou/commit/47f22ca434f6cbf2069ab919286d6050033f5a42))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.36.0
    * @okouai/browser-extension-client bumped to 0.4.3
    * @okouai/core bumped to 8.811.1

## [0.1086.0](https://github.com/okou-ai/okou/compare/app-v0.1085.0...app-v0.1086.0) (2026-11-03)


### Features

* **app:** add homepage task discovery ([#44734](https://github.com/okou-ai/okou/issues/44734)) ([9a61c65](https://github.com/okou-ai/okou/commit/9a61c65def6f53af57ed38f9272a61d612bf6999))


### Bug Fixes

* **app:** group subscription usage and surface recovery when needed ([#44761](https://github.com/okou-ai/okou/issues/44761)) ([156d007](https://github.com/okou-ai/okou/commit/156d0079d730401b1af49e5229d2f966b4eeec37))
* **browser:** recover scoped targets across selection phases ([#44688](https://github.com/okou-ai/okou/issues/44688)) ([2563c30](https://github.com/okou-ai/okou/commit/2563c30f45698ee02848ed3749cc30e23edca37d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.35.0
    * @okouai/core bumped to 8.811.0

## [0.1085.0](https://github.com/okou-ai/okou/compare/app-v0.1084.1...app-v0.1085.0) (2026-11-02)


### Features

* **app:** organize projects as chat sidebar folders ([#44751](https://github.com/okou-ai/okou/issues/44751)) ([e2c0304](https://github.com/okou-ai/okou/commit/e2c03040852a6eebd24921e9dc75529ad58a83c1))


### Bug Fixes

* **browser:** keep new tabs blank during preparation ([#44738](https://github.com/okou-ai/okou/issues/44738)) ([661d1a9](https://github.com/okou-ai/okou/commit/661d1a96f5f2198d2c42c6657187c862a4111a50))
* unify chat filter actions without icons ([#44717](https://github.com/okou-ai/okou/issues/44717)) ([9286fc4](https://github.com/okou-ai/okou/commit/9286fc46885823d472ed15365a0ae148f9d4d905))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.34.0
    * @okouai/core bumped to 8.810.0

## [0.1084.1](https://github.com/okou-ai/okou/compare/app-v0.1084.0...app-v0.1084.1) (2026-11-02)


### Bug Fixes

* use high-resolution okou sharing artwork ([#44721](https://github.com/okou-ai/okou/issues/44721)) ([4ebff22](https://github.com/okou-ai/okou/commit/4ebff22651c042d5de49e298c4a255cdd121e350))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.809.1

## [0.1084.0](https://github.com/okou-ai/okou/compare/app-v0.1083.6...app-v0.1084.0) (2026-11-02)


### Features

* **chat:** quote email contacts from inline mail icons ([#44620](https://github.com/okou-ai/okou/issues/44620)) ([e855924](https://github.com/okou-ai/okou/commit/e855924e6fabe9c22d67b73858e640183d4ff285))
* implement private cross-agent projects behind release gate ([#44617](https://github.com/okou-ai/okou/issues/44617)) ([428f461](https://github.com/okou-ai/okou/commit/428f46154beb1a11cdf09f150650c388826e539c))


### Bug Fixes

* **app:** move markdown table export to footer ([#44618](https://github.com/okou-ai/okou/issues/44618)) ([66c8873](https://github.com/okou-ai/okou/commit/66c88739620676718f77d7eaa1837279686b9ba2))
* **app:** stabilize composer task icons in safari ([#44685](https://github.com/okou-ai/okou/issues/44685)) ([8a58467](https://github.com/okou-ai/okou/commit/8a584679b9c727bbf7ccf7a45f6c444b5b43022a))
* **browser:** preserve mounted heartbeat after transient lease failures ([#44680](https://github.com/okou-ai/okou/issues/44680)) ([70dcba0](https://github.com/okou-ai/okou/commit/70dcba080dac5dbfe1c2831e2ffd0996f6037987))
* **browser:** report established viewer disconnects once ([#44682](https://github.com/okou-ai/okou/issues/44682)) ([460f2e6](https://github.com/okou-ai/okou/commit/460f2e6b2a35b971b1deb96300af9cde3bd27ce2))
* **browser:** retain safe bridge failure diagnostics ([#44683](https://github.com/okou-ai/okou/issues/44683)) ([05cb9a7](https://github.com/okou-ai/okou/commit/05cb9a723e071d2be7877fb19c7fac2e65ad1e19))
* **browser:** unblock reconnect from unacknowledged cleanup ([#44676](https://github.com/okou-ai/okou/issues/44676)) ([8a18bc7](https://github.com/okou-ai/okou/commit/8a18bc77877df1005a40b9471e23b4d4ac06de1b))
* gate cjk markdown emphasis rendering behind a lab switch ([#44653](https://github.com/okou-ai/okou/issues/44653)) ([aa7c978](https://github.com/okou-ai/okou/commit/aa7c9787430bc29a8b59587bf42a51d49b4a8429))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.33.0
    * @okouai/browser-extension-client bumped to 0.4.2
    * @okouai/core bumped to 8.809.0

## [0.1083.6](https://github.com/okou-ai/okou/compare/app-v0.1083.5...app-v0.1083.6) (2026-11-02)


### Bug Fixes

* **browser:** end native input focus on remote navigation ([#44655](https://github.com/okou-ai/okou/issues/44655)) ([b9653cc](https://github.com/okou-ai/okou/commit/b9653ccec674b02b6c40a206a483b12097d36afd))


### Refactoring

* remove artifact deletion feature switch ([#44649](https://github.com/okou-ai/okou/issues/44649)) ([6fdcb0e](https://github.com/okou-ai/okou/commit/6fdcb0e11da48286252c8277d54c8fcf23d0abf3))
* remove chat thread timeline feature switch ([#44651](https://github.com/okou-ai/okou/issues/44651)) ([9fa275a](https://github.com/okou-ai/okou/commit/9fa275ac619738a90345e866425fa3dfdeb4dd14))
* remove shared thread visibility feature switch ([#44658](https://github.com/okou-ai/okou/issues/44658)) ([5578cdb](https://github.com/okou-ai/okou/commit/5578cdb5b540607a66f7c8d2de52a287ecd8ee09))
* **teams:** remove workspace identity feature switch ([#44660](https://github.com/okou-ai/okou/issues/44660)) ([e77bc14](https://github.com/okou-ai/okou/commit/e77bc14635c0b1f8b8420aa1f8b5fb4fc9f01db5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.32.0
    * @okouai/core bumped to 8.808.1
    * @okouai/ui bumped to 1.18.8

## [0.1083.5](https://github.com/okou-ai/okou/compare/app-v0.1083.4...app-v0.1083.5) (2026-11-02)


### Bug Fixes

* **app:** confirm message shares immediately ([#44636](https://github.com/okou-ai/okou/issues/44636)) ([2443df9](https://github.com/okou-ai/okou/commit/2443df9417d4ebd4634b18f5c36da8cb3b745727))
* **app:** remove screenshots from paused browser panels ([#44585](https://github.com/okou-ai/okou/issues/44585)) ([602b616](https://github.com/okou-ai/okou/commit/602b616e40a9f0b3287cd0193f29a71435220865))
* **billing:** turn off auto-recharge after consecutive failures ([#44587](https://github.com/okou-ai/okou/issues/44587)) ([5881a17](https://github.com/okou-ai/okou/commit/5881a17e5c332bef9ff4efe94f96048deef82962))
* **browser:** acquire coherent viewer bindings on reconnect ([#44606](https://github.com/okou-ai/okou/issues/44606)) ([03444af](https://github.com/okou-ai/okou/commit/03444afe60a11dec7134c1e8872f72519ccef099))
* handle invalid feishu bot connection links ([#44619](https://github.com/okou-ai/okou/issues/44619)) ([7801052](https://github.com/okou-ai/okou/commit/78010527837678d7e7f5e4bfc338c1d577de88f7))


### Refactoring

* **app:** remove artifact quick actions ([#44615](https://github.com/okou-ai/okou/issues/44615)) ([17a4d1e](https://github.com/okou-ai/okou/commit/17a4d1e2b224595281cbeb98ab45a97c0a2fc701))
* remove released first task halloween and onboarding switches ([#44575](https://github.com/okou-ai/okou/issues/44575)) ([4571899](https://github.com/okou-ai/okou/commit/4571899bd04a73a9e13591326ad0f9b21f9612fd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.31.1
    * @okouai/core bumped to 8.808.0

## [0.1083.4](https://github.com/okou-ai/okou/compare/app-v0.1083.3...app-v0.1083.4) (2026-11-02)


### Bug Fixes

* **browser:** restore native windows before display calibration ([#44580](https://github.com/okou-ai/okou/issues/44580)) ([c59be2a](https://github.com/okou-ai/okou/commit/c59be2a623bc46bec18bc1238ac2605a8e4e644c))

## [0.1083.3](https://github.com/okou-ai/okou/compare/app-v0.1083.2...app-v0.1083.3) (2026-11-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.31.0
    * @okouai/core bumped to 8.807.4

## [0.1083.2](https://github.com/okou-ai/okou/compare/app-v0.1083.1...app-v0.1083.2) (2026-11-02)


### Bug Fixes

* **app:** keep markdown table exports repeatable ([#44584](https://github.com/okou-ai/okou/issues/44584)) ([6976833](https://github.com/okou-ai/okou/commit/6976833d83a549c278964b9546433deb8fba63ff))

## [0.1083.1](https://github.com/okou-ai/okou/compare/app-v0.1083.0...app-v0.1083.1) (2026-11-02)


### Bug Fixes

* **browser:** copy selected text from focusable page content ([#44582](https://github.com/okou-ai/okou/issues/44582)) ([e7625c9](https://github.com/okou-ai/okou/commit/e7625c9d0f8841ea71a49e3be90d98723dd26456))
* **platform:** retain native browser close diagnostics ([#44558](https://github.com/okou-ai/okou/issues/44558)) ([878108c](https://github.com/okou-ai/okou/commit/878108cd25993c75be642e768ee3c59e45deb8ba))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.807.3

## [0.1083.0](https://github.com/okou-ai/okou/compare/app-v0.1082.5...app-v0.1083.0) (2026-11-02)


### Features

* **browser:** mirror remote keyboard hints and native enter ([#44505](https://github.com/okou-ai/okou/issues/44505)) ([1b12658](https://github.com/okou-ai/okou/commit/1b12658c367894d6d68909c241503db69519a05f))


### Bug Fixes

* align app connector introductions with 4,000+ catalog ([#44375](https://github.com/okou-ai/okou/issues/44375)) ([9b974cf](https://github.com/okou-ai/okou/commit/9b974cf48403e6daf872459231ad0d6a4e3ed8df))
* **app:** retain cdp response diagnostics in sentry ([#44557](https://github.com/okou-ai/okou/issues/44557)) ([01b26ea](https://github.com/okou-ai/okou/commit/01b26eab2624f3d8bb6fe74fff09ada3b7c1778f))
* **platform:** retain native browser websocket failure observations ([#44560](https://github.com/okou-ai/okou/issues/44560)) ([d05fd2a](https://github.com/okou-ai/okou/commit/d05fd2a3c85421ae7fd958ffe7ceca6317bf01c5))
* **platform:** retain original browser input cleanup failures ([#44562](https://github.com/okou-ai/okou/issues/44562)) ([c95f580](https://github.com/okou-ai/okou/commit/c95f580b90493922b787aca3ce1a70926017fbbd))

## [0.1082.5](https://github.com/okou-ai/okou/compare/app-v0.1082.4...app-v0.1082.5) (2026-11-01)


### Bug Fixes

* **app:** limit halloween entry clicks to the ghost ([#44513](https://github.com/okou-ai/okou/issues/44513)) ([5fe8b3b](https://github.com/okou-ai/okou/commit/5fe8b3b04f3f10fc959886b164cc7e18f84f6d39))
* **platform:** forward soft-keyboard backward deletion ([#44497](https://github.com/okou-ai/okou/issues/44497)) ([2047e61](https://github.com/okou-ai/okou/commit/2047e61f55909f7e2f2d173fe744bc69c45a33d2))


### Refactoring

* **platform:** bind landing file transfer deadlines to their owners ([#44509](https://github.com/okou-ai/okou/issues/44509)) ([b2c15b7](https://github.com/okou-ai/okou/commit/b2c15b724e4570ae695799016ca9e790c0b4bd98))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.30.0
    * @okouai/core bumped to 8.807.2

## [0.1082.4](https://github.com/okou-ai/okou/compare/app-v0.1082.3...app-v0.1082.4) (2026-11-01)


### Bug Fixes

* **browser:** seed new viewer windows from the target display ([#44486](https://github.com/okou-ai/okou/issues/44486)) ([c544f6f](https://github.com/okou-ai/okou/commit/c544f6f2b7b41015b290cb6bec04758b765ac558))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.29.1
    * @okouai/core bumped to 8.807.1

## [0.1082.3](https://github.com/okou-ai/okou/compare/app-v0.1082.2...app-v0.1082.3) (2026-11-01)


### Bug Fixes

* **app:** start landing attachment tasks directly in chat ([#44479](https://github.com/okou-ai/okou/issues/44479)) ([566d375](https://github.com/okou-ai/okou/commit/566d375771134a61c1f112205338d53bc0de286c))

## [0.1082.2](https://github.com/okou-ai/okou/compare/app-v0.1082.1...app-v0.1082.2) (2026-11-01)


### Bug Fixes

* **app:** deliver onboarding documents as artifacts ([#44472](https://github.com/okou-ai/okou/issues/44472)) ([c22d0ce](https://github.com/okou-ai/okou/commit/c22d0cecc62e6a28bcf12959ea40b11e1a0daf0f))
* **app:** guide onboarding toward a useful first task ([#44482](https://github.com/okou-ai/okou/issues/44482)) ([b2ca36d](https://github.com/okou-ai/okou/commit/b2ca36dddce0cac9545095243291ff616dc917ec))
* **platform:** support android browser address submission ([#44437](https://github.com/okou-ai/okou/issues/44437)) ([df6aad0](https://github.com/okou-ai/okou/commit/df6aad0584984ae072a10ca6fbabf328a0b8868c))
* **platform:** support browser touch taps and swipe scrolling ([#44483](https://github.com/okou-ai/okou/issues/44483)) ([bb033ff](https://github.com/okou-ai/okou/commit/bb033ff74555e70ce677735864722eb2aeb0f054))


### Documentation

* rotate api and app changelogs for 2026-11 ([#44468](https://github.com/okou-ai/okou/issues/44468)) ([54bceeb](https://github.com/okou-ai/okou/commit/54bceeba4112484172af0e8ff3b9dd75cc679a4e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.29.0
    * @okouai/core bumped to 8.807.0

## [0.1082.1](https://github.com/okou-ai/okou/compare/app-v0.1082.0...app-v0.1082.1) (2026-11-01)


### Performance Improvements

* **platform:** ignore lease-only browser panel updates ([#44460](https://github.com/okou-ai/okou/issues/44460)) ([98ae36c](https://github.com/okou-ai/okou/commit/98ae36c0a5a2db3ac4d5885ac1af0827e8eb2c07))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.28.0
    * @okouai/core bumped to 8.806.1

## [0.1082.0](https://github.com/okou-ai/okou/compare/app-v0.1081.3...app-v0.1082.0) (2026-10-31)


### Features

* **app:** preserve landing page files through onboarding ([#44425](https://github.com/okou-ai/okou/issues/44425)) ([5ae758c](https://github.com/okou-ai/okou/commit/5ae758cf6bb113218c9a0247354bbe60cc1f85f8))


### Refactoring

* **platform:** remove browser async wrappers and defensive timeouts ([#44416](https://github.com/okou-ai/okou/issues/44416)) ([1db5a82](https://github.com/okou-ai/okou/commit/1db5a82d3f6b8b0bfd07ad3b47bc2df5dd861091))


### Performance Improvements

* **api-contracts:** split send/data contracts and use zod 4 top-level string formats ([#44419](https://github.com/okou-ai/okou/issues/44419)) ([381bd6b](https://github.com/okou-ai/okou/commit/381bd6be3712a60db5135c776f3e6aa4bb7b94cf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.27.1
    * @okouai/connectors bumped to 3.20.2
    * @okouai/core bumped to 8.806.0
    * @okouai/ui bumped to 1.18.7
