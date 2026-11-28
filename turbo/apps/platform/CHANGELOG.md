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

## [0.1199.2](https://github.com/okou-ai/okou/compare/app-v0.1199.1...app-v0.1199.2) (2026-11-28)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.145.1
    * @okouai/connectors bumped to 3.29.0
    * @okouai/core bumped to 8.889.2
    * @okouai/ui bumped to 1.22.55

## [0.1199.1](https://github.com/okou-ai/okou/compare/app-v0.1199.0...app-v0.1199.1) (2026-11-28)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.145.0
    * @okouai/core bumped to 8.889.1
    * @okouai/ui bumped to 1.22.54

## [0.1199.0](https://github.com/okou-ai/okou/compare/app-v0.1198.1...app-v0.1199.0) (2026-11-28)


### Features

* **artifacts:** cut over to files and unified artifact access and retire legacy routes ([#51627](https://github.com/okou-ai/okou/issues/51627)) ([d5b57bd](https://github.com/okou-ai/okou/commit/d5b57bd1003bbe1aabd0d56b27efa8dbcfa96087))


### Refactoring

* **app:** retire browser onboarding draft imports ([#51383](https://github.com/okou-ai/okou/issues/51383)) ([19111bf](https://github.com/okou-ai/okou/commit/19111bf448db2d3153be8c723cb659b4e78d4fd0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.144.0
    * @okouai/connectors bumped to 3.28.0
    * @okouai/core bumped to 8.889.0
    * @okouai/ui bumped to 1.22.53

## [0.1198.1](https://github.com/okou-ai/okou/compare/app-v0.1198.0...app-v0.1198.1) (2026-11-27)


### Refactoring

* drop the pre-retirement official workflow list filters ([#51624](https://github.com/okou-ai/okou/issues/51624)) ([890ee9b](https://github.com/okou-ai/okou/commit/890ee9bc4aa296ab682131772bb972da561811e9))
* **platform:** remove shared worker and move chat database to main thread ([#51617](https://github.com/okou-ai/okou/issues/51617)) ([28b4617](https://github.com/okou-ai/okou/commit/28b46179ab594879c6500dce635118be837fd576))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.143.1
    * @okouai/core bumped to 8.888.1
    * @okouai/ui bumped to 1.22.52

## [0.1198.0](https://github.com/okou-ai/okou/compare/app-v0.1197.1...app-v0.1198.0) (2026-11-27)


### Features

* **artifacts:** add unified artifact access api, files dual-write, and client migration ([#51416](https://github.com/okou-ai/okou/issues/51416)) ([2980f4b](https://github.com/okou-ai/okou/commit/2980f4b5f176b0fa5cd871b71a1c5a9a90717eb5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.143.0
    * @okouai/core bumped to 8.888.0
    * @okouai/ui bumped to 1.22.51

## [0.1197.1](https://github.com/okou-ai/okou/compare/app-v0.1197.0...app-v0.1197.1) (2026-11-27)


### Bug Fixes

* **app:** remove the for you option action line ([#51614](https://github.com/okou-ai/okou/issues/51614)) ([ce9866b](https://github.com/okou-ai/okou/commit/ce9866b17e85d98cb6a1710c41e9f2db2fd3da67))

## [0.1197.0](https://github.com/okou-ai/okou/compare/app-v0.1196.3...app-v0.1197.0) (2026-11-27)


### Features

* **platform:** allow renaming remote devices ([#51545](https://github.com/okou-ai/okou/issues/51545)) ([da8e9a8](https://github.com/okou-ai/okou/commit/da8e9a8cf879e42a1a402c98d2b891a91703e404))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.142.0
    * @okouai/connectors bumped to 3.27.0
    * @okouai/core bumped to 8.887.11
    * @okouai/ui bumped to 1.22.50

## [0.1196.3](https://github.com/okou-ai/okou/compare/app-v0.1196.2...app-v0.1196.3) (2026-11-27)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.141.2
    * @okouai/core bumped to 8.887.10
    * @okouai/ui bumped to 1.22.49

## [0.1196.2](https://github.com/okou-ai/okou/compare/app-v0.1196.1...app-v0.1196.2) (2026-11-27)


### Bug Fixes

* **app:** remove chat list hover previews ([#51494](https://github.com/okou-ai/okou/issues/51494)) ([293676f](https://github.com/okou-ai/okou/commit/293676f9ca5cb441474efa709ca299179621c348))


### Refactoring

* remove markdown artifact quote feature switch ([#51490](https://github.com/okou-ai/okou/issues/51490)) ([cd97e8b](https://github.com/okou-ai/okou/commit/cd97e8bf30e977bf47f09c2ae2e1ee9cb36dd856))
* remove markdown-first output feature switch ([#51492](https://github.com/okou-ai/okou/issues/51492)) ([50510b8](https://github.com/okou-ai/okou/commit/50510b8e1d508dadfd4048f6ec16733edacafebb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.141.1
    * @okouai/core bumped to 8.887.9
    * @okouai/ui bumped to 1.22.48

## [0.1196.1](https://github.com/okou-ai/okou/compare/app-v0.1196.0...app-v0.1196.1) (2026-11-27)


### Bug Fixes

* **platform:** darken the composer follow-up tab keycap ([#51435](https://github.com/okou-ai/okou/issues/51435)) ([e80d58f](https://github.com/okou-ai/okou/commit/e80d58f227210f210934a41163babb1b31ad3ca2))


### Performance Improvements

* **artifacts:** batch covers behind the library switch ([#51464](https://github.com/okou-ai/okou/issues/51464)) ([3462fe6](https://github.com/okou-ai/okou/commit/3462fe66da1741d8902e7f846e852ecca1775756))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.141.0
    * @okouai/core bumped to 8.887.8
    * @okouai/ui bumped to 1.22.47

## [0.1196.0](https://github.com/okou-ai/okou/compare/app-v0.1195.2...app-v0.1196.0) (2026-11-27)


### Features

* **platform:** add remote device deletion with confirmation ([#51428](https://github.com/okou-ai/okou/issues/51428)) ([b09fbb2](https://github.com/okou-ai/okou/commit/b09fbb279a729ee9f57878dfcb798b7cfa930170))


### Refactoring

* **api:** retire official workflow admission for proactive runs ([#51409](https://github.com/okou-ai/okou/issues/51409)) ([7a23914](https://github.com/okou-ai/okou/commit/7a239141cfc683da184e8f42ff2456b294025b7d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.140.0
    * @okouai/core bumped to 8.887.7
    * @okouai/ui bumped to 1.22.46

## [0.1195.2](https://github.com/okou-ai/okou/compare/app-v0.1195.1...app-v0.1195.2) (2026-11-27)


### Refactoring

* **ui:** unify dropdown menu patterns and sidebar filter layout ([#51420](https://github.com/okou-ai/okou/issues/51420)) ([6e83b75](https://github.com/okou-ai/okou/commit/6e83b75cc9aab7e71339b00c2ce17b935a4004d4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.139.0
    * @okouai/core bumped to 8.887.6
    * @okouai/ui bumped to 1.22.45

## [0.1195.1](https://github.com/okou-ai/okou/compare/app-v0.1195.0...app-v0.1195.1) (2026-11-27)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.138.0
    * @okouai/core bumped to 8.887.5
    * @okouai/ui bumped to 1.22.44

## [0.1195.0](https://github.com/okou-ai/okou/compare/app-v0.1194.2...app-v0.1195.0) (2026-11-27)


### Features

* **platform:** add preset radio options to connector account name dialog ([#51381](https://github.com/okou-ai/okou/issues/51381)) ([0325542](https://github.com/okou-ai/okou/commit/0325542ca8441ef321df3f1c5d4134ca6f49a14f))


### Bug Fixes

* **app:** hide home compliance bar on narrow widths and remove dismiss control ([#51396](https://github.com/okou-ai/okou/issues/51396)) ([2609808](https://github.com/okou-ai/okou/commit/2609808a5f0d6652caf53208ebdea266d1f97057))

## [0.1194.2](https://github.com/okou-ai/okou/compare/app-v0.1194.1...app-v0.1194.2) (2026-11-27)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.137.3
    * @okouai/core bumped to 8.887.4
    * @okouai/ui bumped to 1.22.43

## [0.1194.1](https://github.com/okou-ai/okou/compare/app-v0.1194.0...app-v0.1194.1) (2026-11-27)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.137.2
    * @okouai/core bumped to 8.887.3
    * @okouai/ui bumped to 1.22.42

## [0.1194.0](https://github.com/okou-ai/okou/compare/app-v0.1193.3...app-v0.1194.0) (2026-11-27)


### Features

* **platform:** split composer voice finish into voice and text actions ([#51351](https://github.com/okou-ai/okou/issues/51351)) ([1ba0283](https://github.com/okou-ai/okou/commit/1ba02834e42d072d7385d97d57cb1c3a8fc780ec))


### Bug Fixes

* **platform:** align artifact library file metadata ([#51302](https://github.com/okou-ai/okou/issues/51302)) ([5115bac](https://github.com/okou-ai/okou/commit/5115baceb47b01c2448c092c1228d96ca3fb63de))
* **platform:** tint share header select-all and cancel with brand color ([#51337](https://github.com/okou-ai/okou/issues/51337)) ([733f343](https://github.com/okou-ai/okou/commit/733f3432e6a104d6e5b5d440bbfafb233eb97644))

## [0.1193.3](https://github.com/okou-ai/okou/compare/app-v0.1193.2...app-v0.1193.3) (2026-11-27)


### Bug Fixes

* **app:** balance for you card and feedback button corners ([#51287](https://github.com/okou-ai/okou/issues/51287)) ([5025add](https://github.com/okou-ai/okou/commit/5025add30cdbec4f0b46840086daa543273bb5d1))
* **platform:** constrain the chat remote device menu ([#51304](https://github.com/okou-ai/okou/issues/51304)) ([68433fc](https://github.com/okou-ai/okou/commit/68433fcfd5ca85af3dc6f34d1ac7403762abb01e))
* **platform:** hide for you card dismiss behind the simplified deck switch ([#51326](https://github.com/okou-ai/okou/issues/51326)) ([2a6ea55](https://github.com/okou-ai/okou/commit/2a6ea55e65fd027a425ddcdee4c1843cbe91779f))
* **ui:** hide native search clear button and use styled clear on workflows ([#51295](https://github.com/okou-ai/okou/issues/51295)) ([377e1d8](https://github.com/okou-ai/okou/commit/377e1d8dbac509ec4b582fa867ed1d9f7eaffc17))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.137.1
    * @okouai/core bumped to 8.887.2
    * @okouai/ui bumped to 1.22.41

## [0.1193.2](https://github.com/okou-ai/okou/compare/app-v0.1193.1...app-v0.1193.2) (2026-11-27)


### Bug Fixes

* **platform:** rename remote control to remote devices ([#51289](https://github.com/okou-ai/okou/issues/51289)) ([536a7d9](https://github.com/okou-ai/okou/commit/536a7d9383f1baee74d2c12050476a2a5c688e3d))

## [0.1193.1](https://github.com/okou-ai/okou/compare/app-v0.1193.0...app-v0.1193.1) (2026-11-27)


### Bug Fixes

* **app:** use arrow cursor for share selection rows ([#51275](https://github.com/okou-ai/okou/issues/51275)) ([c7bc7e4](https://github.com/okou-ai/okou/commit/c7bc7e49d62a11fb7f97f311467b709b45d3d129))

## [0.1193.0](https://github.com/okou-ai/okou/compare/app-v0.1192.0...app-v0.1193.0) (2026-11-27)


### Features

* **artifacts:** add visual browsing to library ([#51115](https://github.com/okou-ai/okou/issues/51115)) ([d11e612](https://github.com/okou-ai/okou/commit/d11e6120de54a6d91addd74541361e0497d5ae0a))


### Bug Fixes

* **lab:** show feature switch slugs and descriptions ([#51264](https://github.com/okou-ai/okou/issues/51264)) ([bdb24a5](https://github.com/okou-ai/okou/commit/bdb24a5be24c0a172d11b195a824cc6af0e637c5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.137.0
    * @okouai/core bumped to 8.887.1
    * @okouai/ui bumped to 1.22.40

## [0.1192.0](https://github.com/okou-ai/okou/compare/app-v0.1191.1...app-v0.1192.0) (2026-11-26)


### Features

* **app:** add unarchived and all chat filters for staff ([#51226](https://github.com/okou-ai/okou/issues/51226)) ([52a6fe8](https://github.com/okou-ai/okou/commit/52a6fe80fe66dbbef978f19e3a5e96fbbdb6b2f0))


### Bug Fixes

* **app:** center display formulas in pdf exports ([#51142](https://github.com/okou-ai/okou/issues/51142)) ([091e76c](https://github.com/okou-ai/okou/commit/091e76cb191e2eaa1114fde437a5cfcad7860129))
* **app:** hold finished chat avatars upright ([#51110](https://github.com/okou-ai/okou/issues/51110)) ([5d695fd](https://github.com/okou-ai/okou/commit/5d695fdd14cc7f34efeb6f541d271b3d2aff4c48))
* **app:** let readers retry hosted site access ([#51232](https://github.com/okou-ai/okou/issues/51232)) ([a113ae0](https://github.com/okou-ai/okou/commit/a113ae031b7e1e407f41321c5c1eac828f9f6701))


### Refactoring

* resolve message artifacts by url and navigate within their chat group ([#51081](https://github.com/okou-ai/okou/issues/51081)) ([fe23396](https://github.com/okou-ai/okou/commit/fe233968313c8ef91e51bd11ea6d75a4551ddf83))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.136.0
    * @okouai/core bumped to 8.887.0
    * @okouai/ui bumped to 1.22.39

## [0.1191.1](https://github.com/okou-ai/okou/compare/app-v0.1191.0...app-v0.1191.1) (2026-11-26)


### Bug Fixes

* **platform:** wrap workflows description beside header actions ([#51178](https://github.com/okou-ai/okou/issues/51178)) ([ed04cbc](https://github.com/okou-ai/okou/commit/ed04cbc473d1bef46379abb361ed3e9f53808949))
* refresh linked gmail drafts during active runs ([#51188](https://github.com/okou-ai/okou/issues/51188)) ([75d38ca](https://github.com/okou-ai/okou/commit/75d38ca957eed0354634ddd0f96797fb58d8dc14))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.135.0
    * @okouai/core bumped to 8.886.1
    * @okouai/ui bumped to 1.22.38

## [0.1191.0](https://github.com/okou-ai/okou/compare/app-v0.1190.0...app-v0.1191.0) (2026-11-26)


### Features

* **app:** for you corner radii, selectable option text and action labels ([#51148](https://github.com/okou-ai/okou/issues/51148)) ([d3a229a](https://github.com/okou-ai/okou/commit/d3a229a493ba204b298d182eeeaf60c735241d02))
* offer four feedback choices on suggestion cards ([#51173](https://github.com/okou-ai/okou/issues/51173)) ([4f89ea3](https://github.com/okou-ai/okou/commit/4f89ea375bdad29e8180bf76011733206f402fcf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.886.0
    * @okouai/ui bumped to 1.22.37

## [0.1190.0](https://github.com/okou-ai/okou/compare/app-v0.1189.4...app-v0.1190.0) (2026-11-26)


### Features

* prepare later feedback for suggestions ([#51159](https://github.com/okou-ai/okou/issues/51159)) ([938f9b2](https://github.com/okou-ai/okou/commit/938f9b2cc1c2c188316ed17f72ce06ec4edb42b8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.134.0
    * @okouai/core bumped to 8.885.4
    * @okouai/ui bumped to 1.22.36

## [0.1189.4](https://github.com/okou-ai/okou/compare/app-v0.1189.3...app-v0.1189.4) (2026-11-26)


### Bug Fixes

* copy canonical artifact links from chat resources ([#51107](https://github.com/okou-ai/okou/issues/51107)) ([efdb0d7](https://github.com/okou-ai/okou/commit/efdb0d71bc53873fad7531040fe3ebc5126c21b8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.133.1
    * @okouai/core bumped to 8.885.3
    * @okouai/ui bumped to 1.22.35

## [0.1189.3](https://github.com/okou-ai/okou/compare/app-v0.1189.2...app-v0.1189.3) (2026-11-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.885.2
    * @okouai/ui bumped to 1.22.34

## [0.1189.2](https://github.com/okou-ai/okou/compare/app-v0.1189.1...app-v0.1189.2) (2026-11-26)


### Bug Fixes

* **app:** clip the chat list divider to the workspace corners ([#51064](https://github.com/okou-ai/okou/issues/51064)) ([1f661e8](https://github.com/okou-ai/okou/commit/1f661e8094b9d0ea325b214fc5c46b6fc206a156))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.133.0
    * @okouai/core bumped to 8.885.1
    * @okouai/ui bumped to 1.22.33

## [0.1189.1](https://github.com/okou-ai/okou/compare/app-v0.1189.0...app-v0.1189.1) (2026-11-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.132.0
    * @okouai/connectors bumped to 3.26.0
    * @okouai/core bumped to 8.885.0
    * @okouai/ui bumped to 1.22.32

## [0.1189.0](https://github.com/okou-ai/okou/compare/app-v0.1188.3...app-v0.1189.0) (2026-11-26)


### Features

* **app:** simplify the for you deck behind a feature switch ([#51030](https://github.com/okou-ai/okou/issues/51030)) ([3764eac](https://github.com/okou-ai/okou/commit/3764eacaa0223b4c6a41934515f79149910b05a2))
* **platform:** show accept label and kbd on follow-up placeholder button ([#51002](https://github.com/okou-ai/okou/issues/51002)) ([44148df](https://github.com/okou-ai/okou/commit/44148df6c72030019bdd079427eb59a14ff50421))


### Bug Fixes

* **app:** make share message rows selectable ([#50969](https://github.com/okou-ai/okou/issues/50969)) ([ee57938](https://github.com/okou-ai/okou/commit/ee579380f2bdcb293d7b21e1c126948b4ee310bf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.884.0
    * @okouai/ui bumped to 1.22.31

## [0.1188.3](https://github.com/okou-ai/okou/compare/app-v0.1188.2...app-v0.1188.3) (2026-11-26)


### Bug Fixes

* **app:** separate domain setup from verification ([#50988](https://github.com/okou-ai/okou/issues/50988)) ([3bc4f64](https://github.com/okou-ai/okou/commit/3bc4f64619bdd3a20dfad2e975fc9ea7c1ca532e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.131.0
    * @okouai/core bumped to 8.883.2
    * @okouai/ui bumped to 1.22.30

## [0.1188.2](https://github.com/okou-ai/okou/compare/app-v0.1188.1...app-v0.1188.2) (2026-11-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.130.0
    * @okouai/core bumped to 8.883.1
    * @okouai/ui bumped to 1.22.29

## [0.1188.1](https://github.com/okou-ai/okou/compare/app-v0.1188.0...app-v0.1188.1) (2026-11-26)


### Bug Fixes

* **app:** restore workflow directory row dividers and lighten its toolbar ([#50939](https://github.com/okou-ai/okou/issues/50939)) ([c604c13](https://github.com/okou-ai/okou/commit/c604c1373c9354edd8fb462a25b5299fa3491f5a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.883.0
    * @okouai/ui bumped to 1.22.28

## [0.1188.0](https://github.com/okou-ai/okou/compare/app-v0.1187.0...app-v0.1188.0) (2026-11-26)


### Features

* **app:** hide empty for you entries and prefetch the feed summary ([#50950](https://github.com/okou-ai/okou/issues/50950)) ([4139476](https://github.com/okou-ai/okou/commit/4139476cc27e777a8e284f73ae732b584feb4392))
* **platform:** render formulas in markdown artifact previews ([#50934](https://github.com/okou-ai/okou/issues/50934)) ([3911eb6](https://github.com/okou-ai/okou/commit/3911eb69a5e3258a8e44f2a6918fb6acbeea418e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.882.0
    * @okouai/ui bumped to 1.22.27

## [0.1187.0](https://github.com/okou-ai/okou/compare/app-v0.1186.3...app-v0.1187.0) (2026-11-26)


### Features

* **app:** grow the for you direction from its entry and scroll the heading alone ([#50923](https://github.com/okou-ai/okou/issues/50923)) ([03357b5](https://github.com/okou-ai/okou/commit/03357b50ad3b93a93830317686a660efff4df4ae))

## [0.1186.3](https://github.com/okou-ai/okou/compare/app-v0.1186.2...app-v0.1186.3) (2026-11-26)


### Refactoring

* **api:** retire official workflow catalog and automation identities ([#50902](https://github.com/okou-ai/okou/issues/50902)) ([1edc731](https://github.com/okou-ai/okou/commit/1edc731cfb612688e2c648ce00f4fd7f1da98e45))


### Performance Improvements

* **app:** narrow home and chat subscriptions ([#50915](https://github.com/okou-ai/okou/issues/50915)) ([ef09be7](https://github.com/okou-ai/okou/commit/ef09be7f9ece42d6540ec32c690417e2a216dd73))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.129.1
    * @okouai/core bumped to 8.881.4
    * @okouai/ui bumped to 1.22.26

## [0.1186.2](https://github.com/okou-ai/okou/compare/app-v0.1186.1...app-v0.1186.2) (2026-11-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.129.0
    * @okouai/core bumped to 8.881.3
    * @okouai/ui bumped to 1.22.25

## [0.1186.1](https://github.com/okou-ai/okou/compare/app-v0.1186.0...app-v0.1186.1) (2026-11-25)


### Performance Improvements

* **app:** defer feed and recent workflow requests at startup ([#50893](https://github.com/okou-ai/okou/issues/50893)) ([48a1ed1](https://github.com/okou-ai/okou/commit/48a1ed18b82cb459328118d6790dc35f67e200cf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.128.4
    * @okouai/core bumped to 8.881.2
    * @okouai/ui bumped to 1.22.24

## [0.1186.0](https://github.com/okou-ai/okou/compare/app-v0.1185.1...app-v0.1186.0) (2026-11-25)


### Features

* **app:** redesign the for you deck on its cover's scene ([#50844](https://github.com/okou-ai/okou/issues/50844)) ([2fa8c1c](https://github.com/okou-ai/okou/commit/2fa8c1c14a0ec63105c01520de2d466dd7194bc8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.128.3
    * @okouai/core bumped to 8.881.1
    * @okouai/ui bumped to 1.22.23

## [0.1185.1](https://github.com/okou-ai/okou/compare/app-v0.1185.0...app-v0.1185.1) (2026-11-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.881.0
    * @okouai/ui bumped to 1.22.22

## [0.1185.0](https://github.com/okou-ai/okou/compare/app-v0.1184.1...app-v0.1185.0) (2026-11-25)


### Features

* **app:** organize workflow directory behind feature switch ([#50253](https://github.com/okou-ai/okou/issues/50253)) ([df2ee82](https://github.com/okou-ai/okou/commit/df2ee823b18568645240ab6ac095a1c1651525e5))
* **platform:** connect google ai antigravity accounts in models settings ([#50813](https://github.com/okou-ai/okou/issues/50813)) ([b1a4381](https://github.com/okou-ai/okou/commit/b1a438147708afa39cf955f2de1e2070beef77a4))


### Bug Fixes

* link welcome threads to the current get started guide ([#50853](https://github.com/okou-ai/okou/issues/50853)) ([4002fa4](https://github.com/okou-ai/okou/commit/4002fa48bfc0862b24a800b488cbdbca72c9ba4a))
* refresh welcome artifact addresses ([#50849](https://github.com/okou-ai/okou/issues/50849)) ([0f5ca8c](https://github.com/okou-ai/okou/commit/0f5ca8ce9028f78dd046658a5765e0758d78e44a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.128.2
    * @okouai/connectors bumped to 3.25.1
    * @okouai/core bumped to 8.880.0
    * @okouai/ui bumped to 1.22.21

## [0.1184.1](https://github.com/okou-ai/okou/compare/app-v0.1184.0...app-v0.1184.1) (2026-11-25)


### Bug Fixes

* **app:** own artifact action sessions in preview commands ([#50824](https://github.com/okou-ai/okou/issues/50824)) ([2b8ccf3](https://github.com/okou-ai/okou/commit/2b8ccf35da6d6fe2096f7ce51530f891393d3934))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.128.1
    * @okouai/core bumped to 8.879.1
    * @okouai/ui bumped to 1.22.20

## [0.1184.0](https://github.com/okou-ai/okou/compare/app-v0.1183.0...app-v0.1184.0) (2026-11-25)


### Features

* guide custom domain setup through verification and activation ([#50730](https://github.com/okou-ai/okou/issues/50730)) ([8846eae](https://github.com/okou-ai/okou/commit/8846eae8a6948dc3177e550be081b39857308062))
* show the workspace initial on default workspace logos ([#50380](https://github.com/okou-ai/okou/issues/50380)) ([1b432c5](https://github.com/okou-ai/okou/commit/1b432c5ccfdb04d7dcddb8ac26ff7f0ce471834a))


### Bug Fixes

* **app:** align project shortcuts and shorten thread menu labels ([#50826](https://github.com/okou-ai/okou/issues/50826)) ([ef31a2c](https://github.com/okou-ai/okou/commit/ef31a2c3b1d219e161bd20b4d7ea31f4b3c59c4d))
* **app:** bind shared database sync to its workspace member ([#50821](https://github.com/okou-ai/okou/issues/50821)) ([ab8b6ae](https://github.com/okou-ai/okou/commit/ab8b6aee88db92abb636759b2061eb45387fd958))
* **app:** clarify chat share selection states ([#50793](https://github.com/okou-ai/okou/issues/50793)) ([931369f](https://github.com/okou-ai/okou/commit/931369fd759101a33184564e63c4694418e00fff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.128.0
    * @okouai/core bumped to 8.879.0
    * @okouai/ui bumped to 1.22.19

## [0.1183.0](https://github.com/okou-ai/okou/compare/app-v0.1182.0...app-v0.1183.0) (2026-11-25)


### Features

* **app:** ask for the presentation default from send and point to settings ([#50799](https://github.com/okou-ai/okou/issues/50799)) ([c3e0b0d](https://github.com/okou-ai/okou/commit/c3e0b0d16c2f21b10807810f4704566690d1e190))
* **app:** refine the share popover audience and people layout ([#50788](https://github.com/okou-ai/okou/issues/50788)) ([c279cca](https://github.com/okou-ai/okou/commit/c279cca2c2b2fc8488b6f6e4a1e88f837f3dcaf9))


### Bug Fixes

* **billing:** unify feedback surveys and one-time rewards ([#50759](https://github.com/okou-ai/okou/issues/50759)) ([44c32b7](https://github.com/okou-ai/okou/commit/44c32b74189f160fe9d3035465970f9a512a5354))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.127.0
    * @okouai/core bumped to 8.878.1
    * @okouai/ui bumped to 1.22.18

## [0.1182.0](https://github.com/okou-ai/okou/compare/app-v0.1181.0...app-v0.1182.0) (2026-11-25)


### Features

* **app:** clarify free-plan top-ups and pro upgrades ([#50549](https://github.com/okou-ai/okou/issues/50549)) ([0f067b9](https://github.com/okou-ai/okou/commit/0f067b9d0642dba3e65c809978c30e44c690a7a0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.126.1
    * @okouai/connectors bumped to 3.25.0
    * @okouai/core bumped to 8.878.0
    * @okouai/ui bumped to 1.22.17

## [0.1181.0](https://github.com/okou-ai/okou/compare/app-v0.1180.1...app-v0.1181.0) (2026-11-25)


### Features

* receive computer use app state on the assigned runner ([#50745](https://github.com/okou-ai/okou/issues/50745)) ([9977243](https://github.com/okou-ai/okou/commit/99772436210306fef0b462d019a9fe57d118ff81))


### Bug Fixes

* **billing:** align feedback surveys and share one-time rewards ([#50566](https://github.com/okou-ai/okou/issues/50566)) ([ddf37fc](https://github.com/okou-ai/okou/commit/ddf37fc99d5ab9ee763a6299f597c56241c4224d))


### Refactoring

* graduate suggestions into the shared morning brief ([#50746](https://github.com/okou-ai/okou/issues/50746)) ([3a296b9](https://github.com/okou-ai/okou/commit/3a296b93fe3b031bfcf1cb30ce189841198b825f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.126.0
    * @okouai/core bumped to 8.877.0
    * @okouai/ui bumped to 1.22.16

## [0.1180.1](https://github.com/okou-ai/okou/compare/app-v0.1180.0...app-v0.1180.1) (2026-11-25)


### Bug Fixes

* **app:** render unicode superscripts and subscripts in pdf exports ([#50728](https://github.com/okou-ai/okou/issues/50728)) ([9f50564](https://github.com/okou-ai/okou/commit/9f50564faa70a9149bcc4099e974e3291ebf7bca))

## [0.1180.0](https://github.com/okou-ai/okou/compare/app-v0.1179.2...app-v0.1180.0) (2026-11-25)


### Features

* **core:** enable suggestions for everyone ([#50721](https://github.com/okou-ai/okou/issues/50721)) ([9f4acb1](https://github.com/okou-ai/okou/commit/9f4acb11dc613e04f11a2b69efc5a634a84b3f30))
* roll out content-aware document output to everyone ([#50706](https://github.com/okou-ai/okou/issues/50706)) ([d7d26cd](https://github.com/okou-ai/okou/commit/d7d26cd3922157848f7adf6d631a2c02f3d3a8fb))
* toggle project archive with a keyboard shortcut ([#50693](https://github.com/okou-ai/okou/issues/50693)) ([a6c307c](https://github.com/okou-ai/okou/commit/a6c307c8070ce7cc9d8dcfc0dfb632666ae6bbd6))


### Refactoring

* remove workflow recency sync feature switch ([#50708](https://github.com/okou-ai/okou/issues/50708)) ([edc8bb9](https://github.com/okou-ai/okou/commit/edc8bb96bba57f6e4390bfa3a8905924d1b4b88f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.876.0
    * @okouai/ui bumped to 1.22.15

## [0.1179.2](https://github.com/okou-ai/okou/compare/app-v0.1179.1...app-v0.1179.2) (2026-11-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.875.0
    * @okouai/ui bumped to 1.22.14

## [0.1179.1](https://github.com/okou-ai/okou/compare/app-v0.1179.0...app-v0.1179.1) (2026-11-24)


### Bug Fixes

* **lab:** show internal feature switches by key ([#50652](https://github.com/okou-ai/okou/issues/50652)) ([7261e03](https://github.com/okou-ai/okou/commit/7261e0395625c2600a56cde976f625ba4bfd3668))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.125.0
    * @okouai/connectors bumped to 3.24.0
    * @okouai/core bumped to 8.874.0
    * @okouai/ui bumped to 1.22.13

## [0.1179.0](https://github.com/okou-ai/okou/compare/app-v0.1178.0...app-v0.1179.0) (2026-11-24)


### Features

* add first-use presentation format setup ([#50150](https://github.com/okou-ai/okou/issues/50150)) ([0e802ee](https://github.com/okou-ai/okou/commit/0e802ee6b10be62579cc7a5e40f3fc21182a0b15))


### Bug Fixes

* **platform:** make project archive and restore optimistic ([#50475](https://github.com/okou-ai/okou/issues/50475)) ([b67b156](https://github.com/okou-ai/okou/commit/b67b1568a19ad0bdddcd9e3941e3cc11d229722c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.873.0
    * @okouai/ui bumped to 1.22.12

## [0.1178.0](https://github.com/okou-ai/okou/compare/app-v0.1177.0...app-v0.1178.0) (2026-11-24)


### Features

* add subscription-gated custom domains for hosted sites ([#50462](https://github.com/okou-ai/okou/issues/50462)) ([a898459](https://github.com/okou-ai/okou/commit/a8984599f91d9596a3721b0c6d8fa67274c9f985))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.124.0
    * @okouai/core bumped to 8.872.0
    * @okouai/ui bumped to 1.22.11

## [0.1177.0](https://github.com/okou-ai/okou/compare/app-v0.1176.1...app-v0.1177.0) (2026-11-24)


### Features

* bind internal antigravity sign-in to member profiles ([#50523](https://github.com/okou-ai/okou/issues/50523)) ([ab93ff8](https://github.com/okou-ai/okou/commit/ab93ff8c008746117d5d90211f58425c1f6a0ae8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.123.0
    * @okouai/core bumped to 8.871.0
    * @okouai/ui bumped to 1.22.10

## [0.1176.1](https://github.com/okou-ai/okou/compare/app-v0.1176.0...app-v0.1176.1) (2026-11-24)


### Bug Fixes

* hide billing feedback entry when survey is unavailable ([#50564](https://github.com/okou-ai/okou/issues/50564)) ([815ec15](https://github.com/okou-ai/okou/commit/815ec15ee790fd3d198ca6e349ac09db3ae90099))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.122.0
    * @okouai/core bumped to 8.870.2
    * @okouai/ui bumped to 1.22.9

## [0.1176.0](https://github.com/okou-ai/okou/compare/app-v0.1175.2...app-v0.1176.0) (2026-11-24)


### Features

* add member-wide connector account approval ([#50516](https://github.com/okou-ai/okou/issues/50516)) ([ff76d52](https://github.com/okou-ai/okou/commit/ff76d52e21a55cd8f3e34a513e7e5fcfd8ab1e1b))
* **billing:** allow free workspaces to buy credits ([#50532](https://github.com/okou-ai/okou/issues/50532)) ([f79cdfd](https://github.com/okou-ai/okou/commit/f79cdfde1673397bf7716c1411dd68e8c3020875))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.121.0
    * @okouai/core bumped to 8.870.1
    * @okouai/ui bumped to 1.22.8

## [0.1175.2](https://github.com/okou-ai/okou/compare/app-v0.1175.1...app-v0.1175.2) (2026-11-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.120.0
    * @okouai/core bumped to 8.870.0
    * @okouai/ui bumped to 1.22.7

## [0.1175.1](https://github.com/okou-ai/okou/compare/app-v0.1175.0...app-v0.1175.1) (2026-11-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.119.0
    * @okouai/core bumped to 8.869.1
    * @okouai/ui bumped to 1.22.6

## [0.1175.0](https://github.com/okou-ai/okou/compare/app-v0.1174.0...app-v0.1175.0) (2026-11-24)


### Features

* migrate billing feedback to posthog surveys ([#50412](https://github.com/okou-ai/okou/issues/50412)) ([b3c517c](https://github.com/okou-ai/okou/commit/b3c517cd416a26bda272000095c0aa1deafc332e))
* **platform:** manage member-wide connector account access ([#50442](https://github.com/okou-ai/okou/issues/50442)) ([550aab4](https://github.com/okou-ai/okou/commit/550aab4ff22583731225eaaa1e3b77c64fc2c341))
* use saved presentation format for generation ([#50260](https://github.com/okou-ai/okou/issues/50260)) ([ad98aaa](https://github.com/okou-ai/okou/commit/ad98aaa608c934f8eac3325ab079b3ee8fc50dd1))


### Bug Fixes

* **app:** reconnect chat oauth accounts in one click ([#50439](https://github.com/okou-ai/okou/issues/50439)) ([6e90467](https://github.com/okou-ai/okou/commit/6e90467f2cb87b13feff299b70d4cde5a5935bdf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.118.0
    * @okouai/core bumped to 8.869.0
    * @okouai/ui bumped to 1.22.5

## [0.1174.0](https://github.com/okou-ai/okou/compare/app-v0.1173.2...app-v0.1174.0) (2026-11-24)


### Features

* **runner:** log managed openrouter routing metadata ([#50392](https://github.com/okou-ai/okou/issues/50392)) ([637a49c](https://github.com/okou-ai/okou/commit/637a49cc6646031aa023c8a631863e88be17ee5d))


### Refactoring

* remove artifact name sorting ([#50428](https://github.com/okou-ai/okou/issues/50428)) ([b693ca5](https://github.com/okou-ai/okou/commit/b693ca5a66bab74587596b3971fdc5163f47f352))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.117.0
    * @okouai/core bumped to 8.868.1
    * @okouai/ui bumped to 1.22.4

## [0.1173.2](https://github.com/okou-ai/okou/compare/app-v0.1173.1...app-v0.1173.2) (2026-11-24)


### Bug Fixes

* **platform:** refresh markdown quote sources after artifact publication ([#50391](https://github.com/okou-ai/okou/issues/50391)) ([c9ee37c](https://github.com/okou-ai/okou/commit/c9ee37cf08dbc498d2e70d1af79da47ecc1f5616))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.116.0
    * @okouai/core bumped to 8.868.0
    * @okouai/ui bumped to 1.22.3

## [0.1173.1](https://github.com/okou-ai/okou/compare/app-v0.1173.0...app-v0.1173.1) (2026-11-24)


### Bug Fixes

* **app:** remove standalone template picker ([#50365](https://github.com/okou-ai/okou/issues/50365)) ([6a20b9e](https://github.com/okou-ai/okou/commit/6a20b9e686f663c0f71403cf4d52c6d77820e7a6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.867.1
    * @okouai/ui bumped to 1.22.2

## [0.1173.0](https://github.com/okou-ai/okou/compare/app-v0.1172.0...app-v0.1173.0) (2026-11-24)


### Features

* **artifacts:** add a gated searchable artifact library list ([#50231](https://github.com/okou-ai/okou/issues/50231)) ([2bb0a85](https://github.com/okou-ai/okou/commit/2bb0a8587efb1fc8abc513dba5c50109406226ed))


### Bug Fixes

* **app:** dismiss zip entry preview on repeat selection ([#50350](https://github.com/okou-ai/okou/issues/50350)) ([24d6ba2](https://github.com/okou-ai/okou/commit/24d6ba23250dd2b62ff95ac99687bdf403ab75ab))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.115.0
    * @okouai/core bumped to 8.867.0
    * @okouai/ui bumped to 1.22.1

## [0.1172.0](https://github.com/okou-ai/okou/compare/app-v0.1171.1...app-v0.1172.0) (2026-11-24)


### Features

* add recording chips to chat composers behind a switch ([#50334](https://github.com/okou-ai/okou/issues/50334)) ([7fa55b1](https://github.com/okou-ai/okou/commit/7fa55b15b8286465939af85fe2faeaa1d39a952e))


### Bug Fixes

* **platform:** remove the visible search result count row ([#50347](https://github.com/okou-ai/okou/issues/50347)) ([26bdcc2](https://github.com/okou-ai/okou/commit/26bdcc2844029158317bb8a7149bce3a744bb830))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.114.0
    * @okouai/core bumped to 8.866.0
    * @okouai/ui bumped to 1.22.0

## [0.1171.1](https://github.com/okou-ai/okou/compare/app-v0.1171.0...app-v0.1171.1) (2026-11-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.865.1
    * @okouai/ui bumped to 1.21.111

## [0.1171.0](https://github.com/okou-ai/okou/compare/app-v0.1170.1...app-v0.1171.0) (2026-11-23)


### Features

* archive projects in the chat sidebar ([#50306](https://github.com/okou-ai/okou/issues/50306)) ([8c9f004](https://github.com/okou-ai/okou/commit/8c9f004ac760d95f3f47e8e3fa83d470f2de28c6))


### Bug Fixes

* **platform:** close the batch permission dialog after approval ([#50322](https://github.com/okou-ai/okou/issues/50322)) ([f86223c](https://github.com/okou-ai/okou/commit/f86223c0465d43ad576333e524e4fa8ab31e3541))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.113.0
    * @okouai/connectors bumped to 3.23.3
    * @okouai/core bumped to 8.865.0
    * @okouai/ui bumped to 1.21.110

## [0.1170.1](https://github.com/okou-ai/okou/compare/app-v0.1170.0...app-v0.1170.1) (2026-11-23)


### Bug Fixes

* remove the Okou symbol from default workspace avatars ([#50313](https://github.com/okou-ai/okou/issues/50313)) ([caf7355](https://github.com/okou-ai/okou/commit/caf73558c2663ca0345dd35943f05379213c4c4f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.864.1
    * @okouai/ui bumped to 1.21.109

## [0.1170.0](https://github.com/okou-ai/okou/compare/app-v0.1169.0...app-v0.1170.0) (2026-11-23)


### Features

* **app:** group workspace search results by chats and messages ([#50305](https://github.com/okou-ai/okou/issues/50305)) ([7c905cd](https://github.com/okou-ai/okou/commit/7c905cdbc1f90c0b0cf533378c18d2bf4326bb15))
* **platform:** give the latest chat prompt room to scroll to the top ([#50151](https://github.com/okou-ai/okou/issues/50151)) ([a738388](https://github.com/okou-ai/okou/commit/a738388b05000a471c4b11d52081cc492abe2704))
* **workflows:** sync recent usage across devices ([#50189](https://github.com/okou-ai/okou/issues/50189)) ([6f67414](https://github.com/okou-ai/okou/commit/6f674143c8776b90c2fbc6410baebbfc02eb4443))


### Bug Fixes

* **app:** keep connector account panels fixed while scrolling ([#50239](https://github.com/okou-ai/okou/issues/50239)) ([b3b8f64](https://github.com/okou-ai/okou/commit/b3b8f64c0cac2d694f737238052a2edd97c2248f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.112.0
    * @okouai/core bumped to 8.864.0
    * @okouai/ui bumped to 1.21.108

## [0.1169.0](https://github.com/okou-ai/okou/compare/app-v0.1168.0...app-v0.1169.0) (2026-11-23)


### Features

* **app:** preview small zip artifacts ([#50234](https://github.com/okou-ai/okou/issues/50234)) ([4eacaf8](https://github.com/okou-ai/okou/commit/4eacaf86edc8ef2029a31605da1a0b7f78b75aa5))


### Bug Fixes

* **app:** preserve cover hover through empty card stack ([#50241](https://github.com/okou-ai/okou/issues/50241)) ([a312c90](https://github.com/okou-ai/okou/commit/a312c901bcc1e326dd7ece01db277286b1a02e2b))


### Refactoring

* **app:** remove artifact preview action group feature switch ([#50243](https://github.com/okou-ai/okou/issues/50243)) ([9a9aae7](https://github.com/okou-ai/okou/commit/9a9aae784b871bcbd4f9823252cdc8d0b183b241))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.111.0
    * @okouai/core bumped to 8.863.0
    * @okouai/ui bumped to 1.21.107

## [0.1168.0](https://github.com/okou-ai/okou/compare/app-v0.1167.0...app-v0.1168.0) (2026-11-23)


### Features

* **ios:** authorize strava through the installed app ([#50179](https://github.com/okou-ai/okou/issues/50179)) ([f98f068](https://github.com/okou-ai/okou/commit/f98f068841b3ff663dcf250beec2267eb5122f66))


### Bug Fixes

* simplify slash action hint copy ([#50215](https://github.com/okou-ai/okou/issues/50215)) ([c9ae929](https://github.com/okou-ai/okou/commit/c9ae92932b7da7fbfd74d0321cbc2f83957dcc95))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.110.0
    * @okouai/core bumped to 8.862.1
    * @okouai/ui bumped to 1.21.106

## [0.1167.0](https://github.com/okou-ai/okou/compare/app-v0.1166.0...app-v0.1167.0) (2026-11-23)


### Features

* share hosted websites with accounts and email invitations ([#50054](https://github.com/okou-ai/okou/issues/50054)) ([124f0fd](https://github.com/okou-ai/okou/commit/124f0fdba68d55c83ac0723181cc6d0a3041afec))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.109.0
    * @okouai/core bumped to 8.862.0
    * @okouai/ui bumped to 1.21.105

## [0.1166.0](https://github.com/okou-ai/okou/compare/app-v0.1165.5...app-v0.1166.0) (2026-11-23)


### Features

* **app:** track suggestion card impressions and outcomes ([#50158](https://github.com/okou-ai/okou/issues/50158)) ([d1cb596](https://github.com/okou-ai/okou/commit/d1cb596036a9079ecd0eb85072610dce8d44f5fb))
* **platform:** redraw for you completion fireworks in brand colors ([#50155](https://github.com/okou-ai/okou/issues/50155)) ([4a7e693](https://github.com/okou-ai/okou/commit/4a7e693bd21cd97365d9f5b5f90bfa0d67bce9d6))


### Bug Fixes

* **app:** refresh retained artifact previews after content updates ([#50176](https://github.com/okou-ai/okou/issues/50176)) ([df0ee6c](https://github.com/okou-ai/okou/commit/df0ee6c264c8b5a3090b5ee4b4b40324420e0a3e))


### Refactoring

* unify markdown document feature switches ([#50138](https://github.com/okou-ai/okou/issues/50138)) ([b47cda1](https://github.com/okou-ai/okou/commit/b47cda1efae2c75c66bc0131e3ee64e6d79d2599))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.108.0
    * @okouai/core bumped to 8.861.1
    * @okouai/ui bumped to 1.21.104

## [0.1165.5](https://github.com/okou-ai/okou/compare/app-v0.1165.4...app-v0.1165.5) (2026-11-23)


### Bug Fixes

* **app:** restore immediate check-in reward confirmation ([#50136](https://github.com/okou-ai/okou/issues/50136)) ([94eae58](https://github.com/okou-ai/okou/commit/94eae5820c46b6cb0660c23b586b001d93c56420))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.107.0
    * @okouai/core bumped to 8.861.0
    * @okouai/ui bumped to 1.21.103

## [0.1165.4](https://github.com/okou-ai/okou/compare/app-v0.1165.3...app-v0.1165.4) (2026-11-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.106.1
    * @okouai/core bumped to 8.860.4
    * @okouai/ui bumped to 1.21.102

## [0.1165.3](https://github.com/okou-ai/okou/compare/app-v0.1165.2...app-v0.1165.3) (2026-11-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.106.0
    * @okouai/core bumped to 8.860.3
    * @okouai/ui bumped to 1.21.101

## [0.1165.2](https://github.com/okou-ai/okou/compare/app-v0.1165.1...app-v0.1165.2) (2026-11-23)


### Bug Fixes

* **app:** require pro for markdown pdf and docx exports ([#50070](https://github.com/okou-ai/okou/issues/50070)) ([02fb537](https://github.com/okou-ai/okou/commit/02fb537c69a87e080de82e139597ea0bb20b1583))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.105.2
    * @okouai/core bumped to 8.860.2
    * @okouai/ui bumped to 1.21.100

## [0.1165.1](https://github.com/okou-ai/okou/compare/app-v0.1165.0...app-v0.1165.1) (2026-11-23)


### Bug Fixes

* persist for you cover preferences in the database ([#50069](https://github.com/okou-ai/okou/issues/50069)) ([c912fc4](https://github.com/okou-ai/okou/commit/c912fc4a238d3558ab6053520a1a63caf02f0ed5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.105.1
    * @okouai/core bumped to 8.860.1
    * @okouai/ui bumped to 1.21.99

## [0.1165.0](https://github.com/okou-ai/okou/compare/app-v0.1164.1...app-v0.1165.0) (2026-11-23)


### Features

* use the first follow-up as the composer placeholder behind a switch ([#50040](https://github.com/okou-ai/okou/issues/50040)) ([0d24270](https://github.com/okou-ai/okou/commit/0d24270d99eb810341fd81597c7c3e74ef718b07))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.860.0
    * @okouai/ui bumped to 1.21.98

## [0.1164.1](https://github.com/okou-ai/okou/compare/app-v0.1164.0...app-v0.1164.1) (2026-11-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.105.0
    * @okouai/core bumped to 8.859.10
    * @okouai/ui bumped to 1.21.97

## [0.1164.0](https://github.com/okou-ai/okou/compare/app-v0.1163.8...app-v0.1164.0) (2026-11-22)


### Features

* **app:** play voice messages in one inline bubble ([#50033](https://github.com/okou-ai/okou/issues/50033)) ([c5b014a](https://github.com/okou-ai/okou/commit/c5b014a0b8cda90db74fe9ce4c7031158f5c448c))
* **app:** restore paged rendering for long chat transcripts ([#50032](https://github.com/okou-ai/okou/issues/50032)) ([24f420e](https://github.com/okou-ai/okou/commit/24f420eec6d5d95bc56c1619df2e90c5c8b72889))


### Refactoring

* migrate run telemetry and runner callbacks ([#50027](https://github.com/okou-ai/okou/issues/50027)) ([08dc352](https://github.com/okou-ai/okou/commit/08dc352da3fda206528eaddfef6bb60efcf68db6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.104.1
    * @okouai/core bumped to 8.859.9
    * @okouai/ui bumped to 1.21.96

## [0.1163.8](https://github.com/okou-ai/okou/compare/app-v0.1163.7...app-v0.1163.8) (2026-11-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.104.0
    * @okouai/core bumped to 8.859.8
    * @okouai/ui bumped to 1.21.95

## [0.1163.7](https://github.com/okou-ai/okou/compare/app-v0.1163.6...app-v0.1163.7) (2026-11-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.103.1
    * @okouai/core bumped to 8.859.7
    * @okouai/ui bumped to 1.21.94

## [0.1163.6](https://github.com/okou-ai/okou/compare/app-v0.1163.5...app-v0.1163.6) (2026-11-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.103.0
    * @okouai/core bumped to 8.859.6
    * @okouai/ui bumped to 1.21.93

## [0.1163.5](https://github.com/okou-ai/okou/compare/app-v0.1163.4...app-v0.1163.5) (2026-11-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.102.0
    * @okouai/core bumped to 8.859.5
    * @okouai/ui bumped to 1.21.92

## [0.1163.4](https://github.com/okou-ai/okou/compare/app-v0.1163.3...app-v0.1163.4) (2026-11-22)


### Bug Fixes

* **platform:** use defringed take-a-breather illustration ([#49947](https://github.com/okou-ai/okou/issues/49947)) ([d969e75](https://github.com/okou-ai/okou/commit/d969e7590d36c2053258c6d62ec856b2593ab2e8))
* **platform:** use regenerated for you illustrations without dark-mode fringe ([#49951](https://github.com/okou-ai/okou/issues/49951)) ([8778e1d](https://github.com/okou-ai/okou/commit/8778e1d6623b74e0a566dc0a05d527a35eeb9c65))


### Refactoring

* retire product agent apis and use member identity across clients ([#49933](https://github.com/okou-ai/okou/issues/49933)) ([1d34e53](https://github.com/okou-ai/okou/commit/1d34e531ac4c777d6df6236fa871ce6c834f5380))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.101.1
    * @okouai/core bumped to 8.859.4
    * @okouai/ui bumped to 1.21.91

## [0.1163.3](https://github.com/okou-ai/okou/compare/app-v0.1163.2...app-v0.1163.3) (2026-11-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.101.0
    * @okouai/core bumped to 8.859.3
    * @okouai/ui bumped to 1.21.90

## [0.1163.2](https://github.com/okou-ai/okou/compare/app-v0.1163.1...app-v0.1163.2) (2026-11-22)


### Refactoring

* **app:** retire agent prerequisites from member flows ([#49854](https://github.com/okou-ai/okou/issues/49854)) ([6eea61b](https://github.com/okou-ai/okou/commit/6eea61b4a4f5c7a3e218bb027b148f10c3d4dab7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.100.1
    * @okouai/core bumped to 8.859.2
    * @okouai/ui bumped to 1.21.89

## [0.1163.1](https://github.com/okou-ai/okou/compare/app-v0.1163.0...app-v0.1163.1) (2026-11-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.100.0
    * @okouai/core bumped to 8.859.1
    * @okouai/ui bumped to 1.21.88

## [0.1163.0](https://github.com/okou-ai/okou/compare/app-v0.1162.6...app-v0.1163.0) (2026-11-22)


### Features

* transcribe ordered voice messages with model credits ([#49901](https://github.com/okou-ai/okou/issues/49901)) ([10fb53e](https://github.com/okou-ai/okou/commit/10fb53e67b9ae25cd3bcb984e8dca394e5682a94))


### Bug Fixes

* bound message preparation and rendering in long conversations ([#49882](https://github.com/okou-ai/okou/issues/49882)) ([075a292](https://github.com/okou-ai/okou/commit/075a292be95df156fb4434243b7c4b302956ba1b))
* **platform:** restore native scrolling for permission and connector flows ([#49896](https://github.com/okou-ai/okou/issues/49896)) ([c12849b](https://github.com/okou-ai/okou/commit/c12849b5ee95b2ce691de781df23517c4d978504))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.99.0
    * @okouai/core bumped to 8.859.0
    * @okouai/ui bumped to 1.21.87

## [0.1162.6](https://github.com/okou-ai/okou/compare/app-v0.1162.5...app-v0.1162.6) (2026-11-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.98.5
    * @okouai/core bumped to 8.858.10
    * @okouai/ui bumped to 1.21.86

## [0.1162.5](https://github.com/okou-ai/okou/compare/app-v0.1162.4...app-v0.1162.5) (2026-11-22)


### Bug Fixes

* **mobile:** prepare native clients for workspace apis without agent ids ([#49889](https://github.com/okou-ai/okou/issues/49889)) ([acc1180](https://github.com/okou-ai/okou/commit/acc1180b74cc5401511eb40984f43c64db058604))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.98.4
    * @okouai/core bumped to 8.858.9
    * @okouai/ui bumped to 1.21.85

## [0.1162.4](https://github.com/okou-ai/okou/compare/app-v0.1162.3...app-v0.1162.4) (2026-11-21)


### Bug Fixes

* **app:** shorten long url labels in chat ([#49870](https://github.com/okou-ai/okou/issues/49870)) ([e67322a](https://github.com/okou-ai/okou/commit/e67322a09416baaad1b15eb0bed206bd4518365d))


### Refactoring

* contract legacy chat and run agent storage ([#49868](https://github.com/okou-ai/okou/issues/49868)) ([abbf9f8](https://github.com/okou-ai/okou/commit/abbf9f8e672ac56f0f98583cfb0b536e9225e905))
* remove project thread deletion feature switch ([#49871](https://github.com/okou-ai/okou/issues/49871)) ([87a5dd0](https://github.com/okou-ai/okou/commit/87a5dd02dd9f35ce5a9fcc6775d63cf11547eaef))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.98.3
    * @okouai/core bumped to 8.858.8
    * @okouai/ui bumped to 1.21.84

## [0.1162.3](https://github.com/okou-ai/okou/compare/app-v0.1162.2...app-v0.1162.3) (2026-11-21)


### Refactoring

* **app:** retire legacy agent management and chat action ids ([#49838](https://github.com/okou-ai/okou/issues/49838)) ([c83928a](https://github.com/okou-ai/okou/commit/c83928ad6fc787a648fa6f2a71fbf5d98b3001cc))
* stage retirement of chat and run agent identity ([#49839](https://github.com/okou-ai/okou/issues/49839)) ([01b34f9](https://github.com/okou-ai/okou/commit/01b34f9b9f1a7f7b117739ad834931fa646a1b8b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.98.2
    * @okouai/core bumped to 8.858.7
    * @okouai/ui bumped to 1.21.83

## [0.1162.2](https://github.com/okou-ai/okou/compare/app-v0.1162.1...app-v0.1162.2) (2026-11-21)


### Bug Fixes

* **cli:** remove legacy agent ids from cli requests ([#49830](https://github.com/okou-ai/okou/issues/49830)) ([fad4dc9](https://github.com/okou-ai/okou/commit/fad4dc9a841aac86dcdaf62f17d07ff200c287e3))
* return 404 for unconfigured get started rewards ([#49832](https://github.com/okou-ai/okou/issues/49832)) ([b8b046f](https://github.com/okou-ai/okou/commit/b8b046f5daf43e740a8ed051e59ca7738ed327ad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.98.1
    * @okouai/core bumped to 8.858.6
    * @okouai/ui bumped to 1.21.82

## [0.1162.1](https://github.com/okou-ai/okou/compare/app-v0.1162.0...app-v0.1162.1) (2026-11-21)


### Bug Fixes

* **app:** support member-scoped connector permission approvals ([#49815](https://github.com/okou-ai/okou/issues/49815)) ([d264a98](https://github.com/okou-ai/okou/commit/d264a981e964c318ca2535b8e0651315c09fcf19))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.858.5
    * @okouai/ui bumped to 1.21.81

## [0.1162.0](https://github.com/okou-ai/okou/compare/app-v0.1161.3...app-v0.1162.0) (2026-11-21)


### Features

* **platform:** put the for you header on a cover-tinted banner ([#49652](https://github.com/okou-ai/okou/issues/49652)) ([a07fe3d](https://github.com/okou-ai/okou/commit/a07fe3d9b1a8645e0909e5357a9bd3a1a9299830))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.98.0
    * @okouai/core bumped to 8.858.4
    * @okouai/ui bumped to 1.21.80

## [0.1161.3](https://github.com/okou-ai/okou/compare/app-v0.1161.2...app-v0.1161.3) (2026-11-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.97.0
    * @okouai/core bumped to 8.858.3
    * @okouai/ui bumped to 1.21.79

## [0.1161.2](https://github.com/okou-ai/okou/compare/app-v0.1161.1...app-v0.1161.2) (2026-11-21)


### Refactoring

* **api:** remove redundant drive account readiness ([#49664](https://github.com/okou-ai/okou/issues/49664)) ([2a48ac4](https://github.com/okou-ai/okou/commit/2a48ac4e25abc2e34a780a2f6b28a9914082d315))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.96.2
    * @okouai/core bumped to 8.858.2
    * @okouai/ui bumped to 1.21.78

## [0.1161.1](https://github.com/okou-ai/okou/compare/app-v0.1161.0...app-v0.1161.1) (2026-11-21)


### Refactoring

* scope chat run admission to workspace members ([#49637](https://github.com/okou-ai/okou/issues/49637)) ([30c1941](https://github.com/okou-ai/okou/commit/30c1941239202722c767b1190718538a5c0b00d3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.96.1
    * @okouai/connectors bumped to 3.23.2
    * @okouai/core bumped to 8.858.1
    * @okouai/ui bumped to 1.21.77

## [0.1161.0](https://github.com/okou-ai/okou/compare/app-v0.1160.0...app-v0.1161.0) (2026-11-20)


### Features

* enable project thread deletion for all workspaces ([#49617](https://github.com/okou-ai/okou/issues/49617)) ([36f34d9](https://github.com/okou-ai/okou/commit/36f34d9c10a2706aea1577cef9d57ae28197def3))


### Bug Fixes

* **app:** simplify the suggestion composer ([#49618](https://github.com/okou-ai/okou/issues/49618)) ([e5077f3](https://github.com/okou-ai/okou/commit/e5077f395853dcb6ba6e9d943dd16f033640f068))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.96.0
    * @okouai/core bumped to 8.858.0
    * @okouai/ui bumped to 1.21.76

## [0.1160.0](https://github.com/okou-ai/okou/compare/app-v0.1159.0...app-v0.1160.0) (2026-11-20)


### Features

* **platform:** give the bottom capability cards room above their buttons ([#49558](https://github.com/okou-ai/okou/issues/49558)) ([069d88d](https://github.com/okou-ai/okou/commit/069d88d718e2bbdf2c9c876f086cec0e6784df8c))


### Refactoring

* **platform:** simplify project dialog closing ([#49593](https://github.com/okou-ai/okou/issues/49593)) ([7ff3bdc](https://github.com/okou-ai/okou/commit/7ff3bdc0e3606592e895f3545b62d4c1265640ca))
* retire the single-agent feature switch ([#49556](https://github.com/okou-ai/okou/issues/49556)) ([4e5707d](https://github.com/okou-ai/okou/commit/4e5707de3ea728c59038345c47399cd51510a499))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.95.3
    * @okouai/core bumped to 8.857.6
    * @okouai/ui bumped to 1.21.75

## [0.1159.0](https://github.com/okou-ai/okou/compare/app-v0.1158.0...app-v0.1159.0) (2026-11-20)


### Features

* **platform:** raise for you options and align them to the heading ([#49534](https://github.com/okou-ai/okou/issues/49534)) ([cf4f4ac](https://github.com/okou-ai/okou/commit/cf4f4acb49c63c2f5595c7f7a22755b9c905d371))
* **platform:** strengthen home capability card art in light and dark ([#49549](https://github.com/okou-ai/okou/issues/49549)) ([df44b2d](https://github.com/okou-ai/okou/commit/df44b2da186d260d34c5c23b95d628ee9f3a7de9))


### Bug Fixes

* **connectors:** align web and ios connection requests ([#49530](https://github.com/okou-ai/okou/issues/49530)) ([8343cc9](https://github.com/okou-ai/okou/commit/8343cc9e65b2da35c1a45fdf189d8cc91508461d))


### Refactoring

* **drive:** retire agent-scoped artifact exports ([#49545](https://github.com/okou-ai/okou/issues/49545)) ([8622b04](https://github.com/okou-ai/okou/commit/8622b04aa8c1c872e2dcb4fa52184072f6e6eda6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.95.2
    * @okouai/core bumped to 8.857.5
    * @okouai/ui bumped to 1.21.74

## [0.1158.0](https://github.com/okou-ai/okou/compare/app-v0.1157.0...app-v0.1158.0) (2026-11-20)


### Features

* **platform:** calm the for you finish and blend the header ([#49512](https://github.com/okou-ai/okou/issues/49512)) ([15aad19](https://github.com/okou-ai/okou/commit/15aad19327616ecf1d2fc89a10a51b69c3c0b9fd))


### Bug Fixes

* **platform:** even out the for you card's gaps and grays ([#49521](https://github.com/okou-ai/okou/issues/49521)) ([199de74](https://github.com/okou-ai/okou/commit/199de74529c8568f7ccf8d13bf83f1c822120ecf))
* **platform:** give the for you cover gallery room and drop reset ([#49508](https://github.com/okou-ai/okou/issues/49508)) ([b126e4c](https://github.com/okou-ai/okou/commit/b126e4ca50e5b80832239c3ddc955fe1d6f678bc))

## [0.1157.0](https://github.com/okou-ai/okou/compare/app-v0.1156.1...app-v0.1157.0) (2026-11-20)


### Features

* **platform:** redraw home capability cards as cut-paper collages ([#49494](https://github.com/okou-ai/okou/issues/49494)) ([a77891b](https://github.com/okou-ai/okou/commit/a77891b5bd4ca834962750ccc270e26730141c30))


### Bug Fixes

* **platform:** use hand-heart icon for the for-you sidebar entry ([#49510](https://github.com/okou-ai/okou/issues/49510)) ([457c2ef](https://github.com/okou-ai/okou/commit/457c2ef882312be0abdabc66bfae678f6095837a))


### Refactoring

* **drive:** authorize artifact and table exports with chat accounts ([#49430](https://github.com/okou-ai/okou/issues/49430)) ([efa10f0](https://github.com/okou-ai/okou/commit/efa10f0bb95b3f3c9c5d09aa3e1049c3c49163e7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.95.1
    * @okouai/core bumped to 8.857.4
    * @okouai/ui bumped to 1.21.73

## [0.1156.1](https://github.com/okou-ai/okou/compare/app-v0.1156.0...app-v0.1156.1) (2026-11-20)


### Bug Fixes

* **platform:** clarify markdown document preview hierarchy ([#49461](https://github.com/okou-ai/okou/issues/49461)) ([4411c56](https://github.com/okou-ai/okou/commit/4411c561192e7c85a6c8ecf89b9578c05f9c7f66))
* **platform:** map markdown titles to word title styles ([#49446](https://github.com/okou-ai/okou/issues/49446)) ([81238fb](https://github.com/okou-ai/okou/commit/81238fbf702ef4d41198ed807ab1139e3a0e14e4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.95.0
    * @okouai/core bumped to 8.857.3
    * @okouai/ui bumped to 1.21.72

## [0.1156.0](https://github.com/okou-ai/okou/compare/app-v0.1155.1...app-v0.1156.0) (2026-11-20)


### Features

* **platform:** use a colored email mark on the Email channel card ([#49475](https://github.com/okou-ai/okou/issues/49475)) ([c37e991](https://github.com/okou-ai/okou/commit/c37e9910acd2f376cd82e177bd549dba5a1d3cd4))


### Bug Fixes

* **app:** avoid duplicate startup project and thread reads ([#49440](https://github.com/okou-ai/okou/issues/49440)) ([23cd576](https://github.com/okou-ai/okou/commit/23cd576df69210cb535f8f819e27906c36d57dc6))
* **app:** keep check-in feedback in the rewards menu ([#49459](https://github.com/okou-ai/okou/issues/49459)) ([44fa0d5](https://github.com/okou-ai/okou/commit/44fa0d5b0f0081dbdbac2b89553831df76749907))
* **platform:** improve chat sharing selection controls ([#49038](https://github.com/okou-ai/okou/issues/49038)) ([ad72ee8](https://github.com/okou-ai/okou/commit/ad72ee8660d9450fa57e8df86389fe30c1e9abae))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.857.2
    * @okouai/ui bumped to 1.21.71

## [0.1155.1](https://github.com/okou-ai/okou/compare/app-v0.1155.0...app-v0.1155.1) (2026-11-20)


### Bug Fixes

* **platform:** retain safe document export failure phases ([#49388](https://github.com/okou-ai/okou/issues/49388)) ([18c9913](https://github.com/okou-ai/okou/commit/18c9913d10396c7e27679fecbb96aba52a7f80de))
* **platform:** use the suggestions switch for my okou proactive settings ([#49439](https://github.com/okou-ai/okou/issues/49439)) ([1d42e69](https://github.com/okou-ai/okou/commit/1d42e6994ad6d82a6678d34b955335765fc560b5))


### Refactoring

* remove feature guides feature switch ([#49441](https://github.com/okou-ai/okou/issues/49441)) ([e5642ea](https://github.com/okou-ai/okou/commit/e5642ea2ef0ea2ba7a6cd451d395c8329a855c88))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.94.1
    * @okouai/core bumped to 8.857.1
    * @okouai/ui bumped to 1.21.70

## [0.1155.0](https://github.com/okou-ai/okou/compare/app-v0.1154.2...app-v0.1155.0) (2026-11-20)


### Features

* **platform:** consolidate proactive settings in my okou ([#49401](https://github.com/okou-ai/okou/issues/49401)) ([9d20531](https://github.com/okou-ai/okou/commit/9d20531a9ad041abf15a8e5c1697b06475b563df))
* **platform:** polish for you suggestion card layout ([#49397](https://github.com/okou-ai/okou/issues/49397)) ([a33c4ea](https://github.com/okou-ai/okou/commit/a33c4eace1e4ddc482559ee2bc6c2d28884689db))


### Bug Fixes

* **app:** preserve artifact file cards in message pdf exports ([#49389](https://github.com/okou-ai/okou/issues/49389)) ([ae05e27](https://github.com/okou-ai/okou/commit/ae05e279c6158a6e3d014dfdaafcdf539f0e9ffe))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.94.0
    * @okouai/core bumped to 8.857.0
    * @okouai/ui bumped to 1.21.69

## [0.1154.2](https://github.com/okou-ai/okou/compare/app-v0.1154.1...app-v0.1154.2) (2026-11-20)


### Refactoring

* **app:** stop writing onboarding drafts to browser storage ([#49384](https://github.com/okou-ai/okou/issues/49384)) ([25d468f](https://github.com/okou-ai/okou/commit/25d468f63e71aef164ac83bf0b412e871256fc02))

## [0.1154.1](https://github.com/okou-ai/okou/compare/app-v0.1154.0...app-v0.1154.1) (2026-11-20)


### Refactoring

* **api:** retire agent connector execution grants ([#49268](https://github.com/okou-ai/okou/issues/49268)) ([596e8ca](https://github.com/okou-ai/okou/commit/596e8ca5d65c2ba7d7b447816042a9bc48fa8b44))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.93.2
    * @okouai/core bumped to 8.856.2
    * @okouai/ui bumped to 1.21.68

## [0.1154.0](https://github.com/okou-ai/okou/compare/app-v0.1153.2...app-v0.1154.0) (2026-11-20)


### Features

* **platform:** grow the for you custom direction into its composer ([#49279](https://github.com/okou-ai/okou/issues/49279)) ([1e7094d](https://github.com/okou-ai/okou/commit/1e7094d1fecfbaa2f711462f1200d089f0000ab1))

## [0.1153.2](https://github.com/okou-ai/okou/compare/app-v0.1153.1...app-v0.1153.2) (2026-11-19)


### Bug Fixes

* let each suggestion decide where its custom direction goes ([#49274](https://github.com/okou-ai/okou/issues/49274)) ([8ee03b2](https://github.com/okou-ai/okou/commit/8ee03b20a05e80b4cd1059f8dd55b72ff85df347))
* **platform:** redesign the browser input dialog ([#49272](https://github.com/okou-ai/okou/issues/49272)) ([9e40c6e](https://github.com/okou-ai/okou/commit/9e40c6e38102e657879bbfb5960dd8f68e980ab9))


### Refactoring

* remove expired deployment compatibility ([#49278](https://github.com/okou-ai/okou/issues/49278)) ([4338aee](https://github.com/okou-ai/okou/commit/4338aeeabfdb74ebee71a8e3c3c3862610b1262b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.93.1
    * @okouai/core bumped to 8.856.1
    * @okouai/ui bumped to 1.21.67

## [0.1153.1](https://github.com/okou-ai/okou/compare/app-v0.1153.0...app-v0.1153.1) (2026-11-19)


### Bug Fixes

* **platform:** expand the full composer inside for you cards ([#49200](https://github.com/okou-ai/okou/issues/49200)) ([a678cec](https://github.com/okou-ai/okou/commit/a678cec8667bc2fc6a9a5f8cf9f1bb9a334d465b))

## [0.1153.0](https://github.com/okou-ai/okou/compare/app-v0.1152.0...app-v0.1153.0) (2026-11-19)


### Features

* **app:** gate an okou rail entry behind a staff switch ([#49130](https://github.com/okou-ai/okou/issues/49130)) ([3ce54fd](https://github.com/okou-ai/okou/commit/3ce54fd46e6166a3b4cf828052e20a375f4ade08))
* **platform:** confirm deletion of project threads ([#49121](https://github.com/okou-ai/okou/issues/49121)) ([89d08cc](https://github.com/okou-ai/okou/commit/89d08ccd4ff5399208552bff0e1f3dbbf08414fb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.93.0
    * @okouai/core bumped to 8.856.0
    * @okouai/ui bumped to 1.21.66

## [0.1152.0](https://github.com/okou-ai/okou/compare/app-v0.1151.0...app-v0.1152.0) (2026-11-19)


### Features

* **platform:** refresh the for you illustrated card deck ([#49016](https://github.com/okou-ai/okou/issues/49016)) ([4bf10b8](https://github.com/okou-ai/okou/commit/4bf10b89e09adce4c9253418d2ad8de1937e3e9e))


### Bug Fixes

* **app:** compact works channels into a responsive grid ([#49001](https://github.com/okou-ai/okou/issues/49001)) ([978a7fb](https://github.com/okou-ai/okou/commit/978a7fb1b057df9ec03eca609a78c6b0dae34e66))


### Refactoring

* **api:** retire chat connector client compatibility ([#49047](https://github.com/okou-ai/okou/issues/49047)) ([3202044](https://github.com/okou-ai/okou/commit/3202044add225011588e98a5724cec7470c78cde))
* **app:** propagate async project switch dependencies ([#48925](https://github.com/okou-ai/okou/issues/48925)) ([71af7ce](https://github.com/okou-ai/okou/commit/71af7ce1e753cc71ce955f58f46c0a389cfa781d))
* **app:** remove redundant projects switch default ([#49058](https://github.com/okou-ai/okou/issues/49058)) ([b86b730](https://github.com/okou-ai/okou/commit/b86b730f2e3f6b6f01f751435cfdafd22f5c9ac5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.92.1
    * @okouai/core bumped to 8.855.1
    * @okouai/ui bumped to 1.21.65

## [0.1151.0](https://github.com/okou-ai/okou/compare/app-v0.1150.0...app-v0.1151.0) (2026-11-19)


### Features

* **api:** roll out chat connector accounts and retire the switch ([#48841](https://github.com/okou-ai/okou/issues/48841)) ([a5a153e](https://github.com/okou-ai/okou/commit/a5a153e20f5e7e9e3d3d7761772bd80720b3f684))


### Bug Fixes

* **app:** restore markdown pdf and docx downloads ([#48999](https://github.com/okou-ai/okou/issues/48999)) ([4aab3c5](https://github.com/okou-ai/okou/commit/4aab3c5123996c6f948f54475d2f581bf37cad89))


### Performance Improvements

* **app:** reuse saved proactive preferences ([#48985](https://github.com/okou-ai/okou/issues/48985)) ([9f88551](https://github.com/okou-ai/okou/commit/9f88551fada8578990f53d0ba6045e061d00e488))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.92.0
    * @okouai/core bumped to 8.855.0
    * @okouai/ui bumped to 1.21.64

## [0.1150.0](https://github.com/okou-ai/okou/compare/app-v0.1149.3...app-v0.1150.0) (2026-11-19)


### Features

* **android:** refine settings and sync display mode with web ([#48892](https://github.com/okou-ai/okou/issues/48892)) ([d8bf4f3](https://github.com/okou-ai/okou/commit/d8bf4f304697b69a4a283226315cc72c02d84275))


### Bug Fixes

* **app:** give each thread side panel its own remembered width ([#48965](https://github.com/okou-ai/okou/issues/48965)) ([ea3c6e6](https://github.com/okou-ai/okou/commit/ea3c6e6dbab1d95aa2085babdc8b0590715b0d27))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.91.0
    * @okouai/core bumped to 8.854.6
    * @okouai/ui bumped to 1.21.63

## [0.1149.3](https://github.com/okou-ai/okou/compare/app-v0.1149.2...app-v0.1149.3) (2026-11-19)


### Performance Improvements

* **app:** reuse confirmed user preference writes ([#48940](https://github.com/okou-ai/okou/issues/48940)) ([ec30a96](https://github.com/okou-ai/okou/commit/ec30a968b5fca542bb979aeebbc0a50b5e917a3a))
* **app:** reuse the chat artifact catalog across views ([#48933](https://github.com/okou-ai/okou/issues/48933)) ([03698f7](https://github.com/okou-ai/okou/commit/03698f76c291f312c82beb556ff7f6e32ef8369d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.90.2
    * @okouai/core bumped to 8.854.5
    * @okouai/ui bumped to 1.21.62

## [0.1149.2](https://github.com/okou-ai/okou/compare/app-v0.1149.1...app-v0.1149.2) (2026-11-19)


### Bug Fixes

* **app:** clarify paused automation feed cards ([#48887](https://github.com/okou-ai/okou/issues/48887)) ([4b72b66](https://github.com/okou-ai/okou/commit/4b72b660f8279424182640658aa21773cc49ccd4))


### Refactoring

* **app:** use a single async feature switch source ([#48862](https://github.com/okou-ai/okou/issues/48862)) ([60b272c](https://github.com/okou-ai/okou/commit/60b272ce6f1087359500c7d8d5ec75e7f3050b30))


### Performance Improvements

* **test:** open the custom template shelf directly ([#48920](https://github.com/okou-ai/okou/issues/48920)) ([59fce0b](https://github.com/okou-ai/okou/commit/59fce0b2203f27e682b4a522e4e7d6f713ec8338))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.90.1
    * @okouai/core bumped to 8.854.4
    * @okouai/ui bumped to 1.21.61

## [0.1149.1](https://github.com/okou-ai/okou/compare/app-v0.1149.0...app-v0.1149.1) (2026-11-19)


### Bug Fixes

* **app:** align artifact close button hover shape ([#48846](https://github.com/okou-ai/okou/issues/48846)) ([e74770e](https://github.com/okou-ai/okou/commit/e74770e52f002811f5800f8de1c171021b22ed22))
* **app:** replace empty state icons with brand scenes ([#48856](https://github.com/okou-ai/okou/issues/48856)) ([4d82887](https://github.com/okou-ai/okou/commit/4d82887c52325b7ab7876150807fd87e133043f1))
* **app:** resolve feature switches before mounting ([#48834](https://github.com/okou-ai/okou/issues/48834)) ([65206e8](https://github.com/okou-ai/okou/commit/65206e8e543d5ce23699fd8d2feea21e94e33413))


### Refactoring

* **app:** refresh device lists when opening the connector menu ([#48849](https://github.com/okou-ai/okou/issues/48849)) ([81e93c7](https://github.com/okou-ai/okou/commit/81e93c76a220f826e3b340b5465fe1db06efde10))


### Performance Improvements

* **app:** restore home lcp and load only the capability art on screen ([#48785](https://github.com/okou-ai/okou/issues/48785)) ([8451248](https://github.com/okou-ai/okou/commit/8451248be534efa0786da6df0fa1b1203c93f866))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.90.0
    * @okouai/core bumped to 8.854.3
    * @okouai/ui bumped to 1.21.60

## [0.1149.0](https://github.com/okou-ai/okou/compare/app-v0.1148.2...app-v0.1149.0) (2026-11-19)


### Features

* **onboarding:** persist drafts across devices ([#48816](https://github.com/okou-ai/okou/issues/48816)) ([368d3dd](https://github.com/okou-ai/okou/commit/368d3dd31744833319c9cffce3c17191a5c327d7))


### Refactoring

* **platform:** simplify pdf, auth and browser close timing ([#48840](https://github.com/okou-ai/okou/issues/48840)) ([85c641e](https://github.com/okou-ai/okou/commit/85c641e01017caf8b3b6d830521cc62c242b57da))
* **platform:** use ccstate to reload credit balances ([#48843](https://github.com/okou-ai/okou/issues/48843)) ([9d67f10](https://github.com/okou-ai/okou/commit/9d67f101309b6ee9de61553eff42bc1f14901787))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.89.0
    * @okouai/core bumped to 8.854.2
    * @okouai/ui bumped to 1.21.59

## [0.1148.2](https://github.com/okou-ai/okou/compare/app-v0.1148.1...app-v0.1148.2) (2026-11-19)


### Bug Fixes

* **app:** defer feature guide requests until workspace switches load ([#48813](https://github.com/okou-ai/okou/issues/48813)) ([89e6b4c](https://github.com/okou-ai/okou/commit/89e6b4c0cb69754a6271de4d7968d974d34f2c09))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.88.0
    * @okouai/core bumped to 8.854.1
    * @okouai/ui bumped to 1.21.58

## [0.1148.1](https://github.com/okou-ai/okou/compare/app-v0.1148.0...app-v0.1148.1) (2026-11-18)


### Bug Fixes

* **app:** anchor variable-height dialogs to the top ([#48771](https://github.com/okou-ai/okou/issues/48771)) ([312092f](https://github.com/okou-ai/okou/commit/312092f8a3da89890bc8f7a8d6de0ca80b12ac01))


### Performance Improvements

* **test:** reuse account manager title matches ([#48777](https://github.com/okou-ai/okou/issues/48777)) ([1cb70ce](https://github.com/okou-ai/okou/commit/1cb70ce79ff71bfea7e88899a60e1131847d2cb3))

## [0.1148.0](https://github.com/okou-ai/okou/compare/app-v0.1147.5...app-v0.1148.0) (2026-11-18)


### Features

* add ultrafast for codex subscriptions ([#48736](https://github.com/okou-ai/okou/issues/48736)) ([c352dad](https://github.com/okou-ai/okou/commit/c352dadadbbec10cea8cf77adccfac8462ecdb94))


### Performance Improvements

* **test:** narrow connector account readiness queries ([#48747](https://github.com/okou-ai/okou/issues/48747)) ([c596d5d](https://github.com/okou-ai/okou/commit/c596d5d82c02fab6155681fd86153ce4311b113a))
* **test:** scope subscription reset tooltip text checks ([#48757](https://github.com/okou-ai/okou/issues/48757)) ([9e11c62](https://github.com/okou-ai/okou/commit/9e11c62ea74263555197b0d23515b9282f19584b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.87.0
    * @okouai/core bumped to 8.854.0
    * @okouai/ui bumped to 1.21.57

## [0.1147.5](https://github.com/okou-ai/okou/compare/app-v0.1147.4...app-v0.1147.5) (2026-11-18)


### Performance Improvements

* **test:** scope fork and forward success toast waits ([#48709](https://github.com/okou-ai/okou/issues/48709)) ([9a8c6c8](https://github.com/okou-ai/okou/commit/9a8c6c8c2ec09c2fc6e8347ea9e07149b41d7ff0))
* **test:** skip preparatory hover in account manager transfer tests ([#48722](https://github.com/okou-ai/okou/issues/48722)) ([96fbaf5](https://github.com/okou-ai/okou/commit/96fbaf5bc9c8c20fc3cdd6b84a4fead4a85d97af))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.86.4
    * @okouai/core bumped to 8.853.2
    * @okouai/ui bumped to 1.21.56

## [0.1147.4](https://github.com/okou-ai/okou/compare/app-v0.1147.3...app-v0.1147.4) (2026-11-18)


### Bug Fixes

* **app:** keep website sharing anchored during permission refresh ([#48665](https://github.com/okou-ai/okou/issues/48665)) ([e431efb](https://github.com/okou-ai/okou/commit/e431efb3c35614c29763437b9f9c7d5a009dc5c5))
* **artifacts:** reduce visibility update latency ([#48652](https://github.com/okou-ai/okou/issues/48652)) ([7f50485](https://github.com/okou-ai/okou/commit/7f50485e293fab339942a621798bd35ae9464bc2))


### Performance Improvements

* **test:** avoid missing-title dumps during browser regrant waits ([#48647](https://github.com/okou-ai/okou/issues/48647)) ([1e84fc5](https://github.com/okou-ai/okou/commit/1e84fc50bf39e6a6b202cc94ff89b602bce9a0f2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.86.3
    * @okouai/core bumped to 8.853.1
    * @okouai/ui bumped to 1.21.55

## [0.1147.3](https://github.com/okou-ai/okou/compare/app-v0.1147.2...app-v0.1147.3) (2026-11-18)


### Bug Fixes

* **platform:** size the feature guide dialog to its content ([#48627](https://github.com/okou-ai/okou/issues/48627)) ([9696c89](https://github.com/okou-ai/okou/commit/9696c892614faaf6930a6f7b3e5f63d0e2fd8459))


### Refactoring

* **platform:** bound onboarding suffix stripping by its match ([#48636](https://github.com/okou-ai/okou/issues/48636)) ([8e1ce85](https://github.com/okou-ai/okou/commit/8e1ce859655e45112628de6c4502def1bbd1c3a3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.853.0
    * @okouai/ui bumped to 1.21.54

## [0.1147.2](https://github.com/okou-ai/okou/compare/app-v0.1147.1...app-v0.1147.2) (2026-11-18)


### Bug Fixes

* **app:** authorize connectors directly for default Okou ([#48625](https://github.com/okou-ai/okou/issues/48625)) ([5d91b9b](https://github.com/okou-ai/okou/commit/5d91b9b7fc1c8b7f0218368d4acc1f5cf54f3c91))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.86.2
    * @okouai/core bumped to 8.852.2
    * @okouai/ui bumped to 1.21.53

## [0.1147.1](https://github.com/okou-ai/okou/compare/app-v0.1147.0...app-v0.1147.1) (2026-11-18)


### Bug Fixes

* **app:** align project editor dialog with form conventions ([#48617](https://github.com/okou-ai/okou/issues/48617)) ([ac630bd](https://github.com/okou-ai/okou/commit/ac630bd3c64469128e24ecda075258092b1bfb34))
* **chat:** dismiss archived reminders without marking chats read ([#48560](https://github.com/okou-ai/okou/issues/48560)) ([d3d69ae](https://github.com/okou-ai/okou/commit/d3d69ae2e7738d8b0b02450dde04399c91641a54))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.86.1
    * @okouai/core bumped to 8.852.1
    * @okouai/ui bumped to 1.21.52

## [0.1147.0](https://github.com/okou-ai/okou/compare/app-v0.1146.1...app-v0.1147.0) (2026-11-18)


### Features

* **app:** enable feature guides with the my okou redesign ([#47733](https://github.com/okou-ai/okou/issues/47733)) ([0e9387d](https://github.com/okou-ai/okou/commit/0e9387d6ef081ec765f9c1392e1158ac95bc6da0))


### Bug Fixes

* **app:** align billing surveys with the design system ([#48563](https://github.com/okou-ai/okou/issues/48563)) ([9cd4717](https://github.com/okou-ai/okou/commit/9cd4717e58d0bd85dc23d49744c87f8e8c7c697b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.86.0
    * @okouai/core bumped to 8.852.0
    * @okouai/ui bumped to 1.21.51

## [0.1146.1](https://github.com/okou-ai/okou/compare/app-v0.1146.0...app-v0.1146.1) (2026-11-18)


### Bug Fixes

* classify codex terminal failures and agent oom ([#48521](https://github.com/okou-ai/okou/issues/48521)) ([00075f2](https://github.com/okou-ai/okou/commit/00075f2f8a0d64e6aa8c3cecc8dc7bdc6cccde5f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.85.2
    * @okouai/core bumped to 8.851.1
    * @okouai/ui bumped to 1.21.50

## [0.1146.0](https://github.com/okou-ai/okou/compare/app-v0.1145.2...app-v0.1146.0) (2026-11-18)


### Features

* **app:** release share audience descriptions and website share rows ([#48544](https://github.com/okou-ai/okou/issues/48544)) ([60461e9](https://github.com/okou-ai/okou/commit/60461e9da15d190d7e34e633ce0e2a61d195026f))
* **core:** enable presentation output format for staff ([#48524](https://github.com/okou-ai/okou/issues/48524)) ([af156ca](https://github.com/okou-ai/okou/commit/af156ca8c7dea3483e14ae37a058890dd57581d0))


### Bug Fixes

* **app:** align connector controls and manage accounts in chat ([#48477](https://github.com/okou-ai/okou/issues/48477)) ([ba2b3f1](https://github.com/okou-ai/okou/commit/ba2b3f19374b2ffa88adfcd0fdc66f51e0ee4e27))
* **app:** hide artifact preview actions without a loading skeleton ([#48540](https://github.com/okou-ai/okou/issues/48540)) ([fd212b3](https://github.com/okou-ai/okou/commit/fd212b3c1fa1705e94e977779e09bf6fca470edd))
* **app:** refresh pro and team plan capability copy ([#48328](https://github.com/okou-ai/okou/issues/48328)) ([0b43fc2](https://github.com/okou-ai/okou/commit/0b43fc29ddbcbbea8111f6cfacc518df4a1162fa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.85.1
    * @okouai/core bumped to 8.851.0
    * @okouai/ui bumped to 1.21.49

## [0.1145.2](https://github.com/okou-ai/okou/compare/app-v0.1145.1...app-v0.1145.2) (2026-11-18)


### Refactoring

* **app:** frame the chat list and workspace as one sheet ([#48445](https://github.com/okou-ai/okou/issues/48445)) ([49fa2ae](https://github.com/okou-ai/okou/commit/49fa2ae03ef16d6413ecf7609ae87be3d5c52825))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.850.2
    * @okouai/ui bumped to 1.21.48

## [0.1145.1](https://github.com/okou-ai/okou/compare/app-v0.1145.0...app-v0.1145.1) (2026-11-18)


### Bug Fixes

* **platform:** reveal preview actions together and keep downloads visible ([#48340](https://github.com/okou-ai/okou/issues/48340)) ([f8ae254](https://github.com/okou-ai/okou/commit/f8ae254298f87d0d514f3625ea6bf63ed59ecd22))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.85.0
    * @okouai/core bumped to 8.850.1
    * @okouai/ui bumped to 1.21.47

## [0.1145.0](https://github.com/okou-ai/okou/compare/app-v0.1144.0...app-v0.1145.0) (2026-11-17)


### Features

* **app:** preselect multiple output formats from onboarding links ([#48433](https://github.com/okou-ai/okou/issues/48433)) ([293ff03](https://github.com/okou-ai/okou/commit/293ff03824b50f184a72b666db25a44725229eca))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.850.0
    * @okouai/ui bumped to 1.21.46

## [0.1144.0](https://github.com/okou-ai/okou/compare/app-v0.1143.1...app-v0.1144.0) (2026-11-17)


### Features

* add independent project sorting ([#48352](https://github.com/okou-ai/okou/issues/48352)) ([5ace277](https://github.com/okou-ai/okou/commit/5ace277384c9a3e0da65abdbf87a89fea3311d85))


### Refactoring

* activate structured run failures with retained storage ([#47844](https://github.com/okou-ai/okou/issues/47844)) ([fdb91d8](https://github.com/okou-ai/okou/commit/fdb91d8fea44a0be90036ebd9d6c25210eb5baa2))


### Performance Improvements

* **app:** keep vnc subscriptions with vnc controls ([#48343](https://github.com/okou-ai/okou/issues/48343)) ([e4282cd](https://github.com/okou-ai/okou/commit/e4282cd8fa2ea61022cd83761695fc14a555a018))
* **app:** translate only consumed visualization labels ([#48424](https://github.com/okou-ai/okou/issues/48424)) ([2b07447](https://github.com/okou-ai/okou/commit/2b074478b4c7dc647afa68188a223b8bda600af2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.84.0
    * @okouai/core bumped to 8.849.0
    * @okouai/ui bumped to 1.21.45

## [0.1143.1](https://github.com/okou-ai/okou/compare/app-v0.1143.0...app-v0.1143.1) (2026-11-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.83.1
    * @okouai/core bumped to 8.848.1
    * @okouai/ui bumped to 1.21.44

## [0.1143.0](https://github.com/okou-ai/okou/compare/app-v0.1142.1...app-v0.1143.0) (2026-11-17)


### Features

* drive phone use through realtime notifications ([#48253](https://github.com/okou-ai/okou/issues/48253)) ([7a71cfe](https://github.com/okou-ai/okou/commit/7a71cfe71674871cae66ddee7d0d12cd0a7f2760))
* roll out free plan artifact paywall ([#48265](https://github.com/okou-ai/okou/issues/48265)) ([a8c6d85](https://github.com/okou-ai/okou/commit/a8c6d85e09610d0268362ec7db53d7ec8f031fb6))


### Bug Fixes

* generate semantic filenames for message pdf downloads ([#48262](https://github.com/okou-ai/okou/issues/48262)) ([d311fd8](https://github.com/okou-ai/okou/commit/d311fd8ca02dc9b2c555e52c2e8112a0fbab002b))


### Refactoring

* define client run and activity read models ([#48165](https://github.com/okou-ai/okou/issues/48165)) ([9be7072](https://github.com/okou-ai/okou/commit/9be7072fcdb23c781cc0d68a93dc88fc7b86f8da))


### Performance Improvements

* **app:** defer subscription reset tooltip preparation ([#48330](https://github.com/okou-ai/okou/issues/48330)) ([828f4da](https://github.com/okou-ai/okou/commit/828f4da6545b8e6499a9e1d96cb833abdaf87b35))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.83.0
    * @okouai/core bumped to 8.848.0
    * @okouai/ui bumped to 1.21.43

## [0.1142.1](https://github.com/okou-ai/okou/compare/app-v0.1142.0...app-v0.1142.1) (2026-11-17)


### Bug Fixes

* **app:** show checkout survey after restored billing closes ([#48228](https://github.com/okou-ai/okou/issues/48228)) ([f460a8b](https://github.com/okou-ai/okou/commit/f460a8bfd34c99173d96f31541d84fad34e0226c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.82.0
    * @okouai/core bumped to 8.847.6
    * @okouai/ui bumped to 1.21.42

## [0.1142.0](https://github.com/okou-ai/okou/compare/app-v0.1141.5...app-v0.1142.0) (2026-11-17)


### Features

* **api:** prepare controlled marketing reward routing ([#48235](https://github.com/okou-ai/okou/issues/48235)) ([850096b](https://github.com/okou-ai/okou/commit/850096b648aa3d77b198e18cfb69baa6cdf3dff9))


### Bug Fixes

* **app:** distinguish artifact link icons by content type ([#48216](https://github.com/okou-ai/okou/issues/48216)) ([dd08f1c](https://github.com/okou-ai/okou/commit/dd08f1c6fe291959f56255c3980ad7cfb99abc3e))
* **app:** match project titles to thread overflow behavior ([#48220](https://github.com/okou-ai/okou/issues/48220)) ([96b2fc7](https://github.com/okou-ai/okou/commit/96b2fc71b22699ef6cd56c3229a762aa2887e19b))
* **app:** simplify per-chat connector account controls ([#48208](https://github.com/okou-ai/okou/issues/48208)) ([acc7927](https://github.com/okou-ai/okou/commit/acc79270e25d7d1d93487bba6e56a905a9ad5ad6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.81.0
    * @okouai/core bumped to 8.847.5
    * @okouai/ui bumped to 1.21.41

## [0.1141.5](https://github.com/okou-ai/okou/compare/app-v0.1141.4...app-v0.1141.5) (2026-11-17)


### Bug Fixes

* align phone availability with usable native control ([#48135](https://github.com/okou-ai/okou/issues/48135)) ([1744a58](https://github.com/okou-ai/okou/commit/1744a58d3f33923f71a34d07e85a87eeb86d03c1))
* **app:** keep artifact categories visible and group pptx presentations ([#48154](https://github.com/okou-ai/okou/issues/48154)) ([ff91500](https://github.com/okou-ai/okou/commit/ff915007aee99db02847333166b8f4bd2962b0f3))
* **app:** restore clerk automatic social button layout ([#48229](https://github.com/okou-ai/okou/issues/48229)) ([fd38783](https://github.com/okou-ai/okou/commit/fd38783a06afebe51cdaa6f29a16cdf6bd6da792))
* **app:** stabilize chat notice and media card geometry ([#48209](https://github.com/okou-ai/okou/issues/48209)) ([982d717](https://github.com/okou-ai/okou/commit/982d7172dd2d929e18ba40dd2fd906d3f5fec312))
* **platform:** compact batch permission cards and stabilize loading ([#48213](https://github.com/okou-ai/okou/issues/48213)) ([ff507fb](https://github.com/okou-ai/okou/commit/ff507fbafe1be0db00cdf321109deab1e658e67a))


### Performance Improvements

* **api:** retire debug-only run fields from application sql ([#48082](https://github.com/okou-ai/okou/issues/48082)) ([a40cf00](https://github.com/okou-ai/okou/commit/a40cf00d2f9e5c63fcb2dfa6ea68485b13be4f13))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.80.0
    * @okouai/core bumped to 8.847.4
    * @okouai/ui bumped to 1.21.40

## [0.1141.4](https://github.com/okou-ai/okou/compare/app-v0.1141.3...app-v0.1141.4) (2026-11-17)


### Bug Fixes

* **app:** refine the for you completion transition ([#48145](https://github.com/okou-ai/okou/issues/48145)) ([dd61df6](https://github.com/okou-ai/okou/commit/dd61df6eca4dca0907cf5ecc180de5ebd65204be))
* **app:** remove first-task upgrade panel from chat ([#48163](https://github.com/okou-ai/okou/issues/48163)) ([acd0576](https://github.com/okou-ai/okou/commit/acd0576df543974a76c650512f025e82a489cba1))
* **app:** remove shared chat deletion from artifact list ([#48159](https://github.com/okou-ai/okou/issues/48159)) ([ed49f47](https://github.com/okou-ai/okou/commit/ed49f47efed3c99f2354a1c91d74f43c7a645538))


### Refactoring

* **platform:** remove pasted text attachments feature switch ([#48148](https://github.com/okou-ai/okou/issues/48148)) ([5a278f0](https://github.com/okou-ai/okou/commit/5a278f0c51cd4c8ac0939f973ce47f9c873fa0fb))


### Performance Improvements

* **app:** prepare referral content when its dialog mounts ([#48161](https://github.com/okou-ai/okou/issues/48161)) ([1519693](https://github.com/okou-ai/okou/commit/1519693b067555c9c7c6f6b2780475d538a29435))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.79.0
    * @okouai/core bumped to 8.847.3
    * @okouai/ui bumped to 1.21.39

## [0.1141.3](https://github.com/okou-ai/okou/compare/app-v0.1141.2...app-v0.1141.3) (2026-11-17)


### Bug Fixes

* **app:** keep the capability greeting stable when opening cards ([#48138](https://github.com/okou-ai/okou/issues/48138)) ([3224f05](https://github.com/okou-ai/okou/commit/3224f0541759ef408cd7c0313fd2981002a05223))
* **app:** stabilize lark and feishu setup guide layout ([#48076](https://github.com/okou-ai/okou/issues/48076)) ([ce218a7](https://github.com/okou-ai/okou/commit/ce218a75fb5d45c1f0549a1874c2c4449cdb8c82))
* make projects follow the single agent switch ([#48142](https://github.com/okou-ai/okou/issues/48142)) ([c8c181a](https://github.com/okou-ai/okou/commit/c8c181a5d258306463622a74129e8f770ba00fd7))


### Refactoring

* prepare structured run failure clients ([#48006](https://github.com/okou-ai/okou/issues/48006)) ([4839506](https://github.com/okou-ai/okou/commit/483950651b69db523f06a72f7cf2490c913ff8ab))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.78.0
    * @okouai/core bumped to 8.847.2
    * @okouai/ui bumped to 1.21.38

## [0.1141.2](https://github.com/okou-ai/okou/compare/app-v0.1141.1...app-v0.1141.2) (2026-11-17)


### Refactoring

* remove for you sources feature switch ([#48074](https://github.com/okou-ai/okou/issues/48074)) ([335f7b5](https://github.com/okou-ai/okou/commit/335f7b5c0410626867316382e92753d219e1e937))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.77.0
    * @okouai/core bumped to 8.847.1
    * @okouai/ui bumped to 1.21.37

## [0.1141.1](https://github.com/okou-ai/okou/compare/app-v0.1141.0...app-v0.1141.1) (2026-11-17)


### Bug Fixes

* **app:** keep chart selections inline and clear accepted drafts ([#48045](https://github.com/okou-ai/okou/issues/48045)) ([70d643f](https://github.com/okou-ai/okou/commit/70d643faea0dd89455eb79c9bc3258c55c7ceaaf))

## [0.1141.0](https://github.com/okou-ai/okou/compare/app-v0.1140.0...app-v0.1141.0) (2026-11-17)


### Features

* **core:** enable home capabilities for everyone ([#48000](https://github.com/okou-ai/okou/issues/48000)) ([5df5fc2](https://github.com/okou-ai/okou/commit/5df5fc264b933fdb4aa8210740221f921e6232d7))


### Bug Fixes

* **browser:** drain original input before viewer shutdown ([#48044](https://github.com/okou-ai/okou/issues/48044)) ([361c5d6](https://github.com/okou-ai/okou/commit/361c5d6aa4c71b15b004bd48a67bd3fb9ee66404))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.76.1
    * @okouai/core bumped to 8.847.0
    * @okouai/ui bumped to 1.21.36

## [0.1140.0](https://github.com/okou-ai/okou/compare/app-v0.1139.0...app-v0.1140.0) (2026-11-17)


### Features

* **my-okou:** preserve initialized members and enable new-member defaults ([#47051](https://github.com/okou-ai/okou/issues/47051)) ([cf1c9e5](https://github.com/okou-ai/okou/commit/cf1c9e53c2076c58bd6bb85d51dedbd62c30b6d1))


### Bug Fixes

* **app:** highlight tools button while its panel is open ([#48002](https://github.com/okou-ai/okou/issues/48002)) ([f1896f1](https://github.com/okou-ai/okou/commit/f1896f1330d52a223f36c06f0204b0dea43db4db))
* **app:** render heic photos in full image previews ([#48043](https://github.com/okou-ai/okou/issues/48043)) ([e42c4a4](https://github.com/okou-ai/okou/commit/e42c4a4d759cc86ef5c380721d9a099930c13988))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.76.0
    * @okouai/core bumped to 8.846.0
    * @okouai/ui bumped to 1.21.35

## [0.1139.0](https://github.com/okou-ai/okou/compare/app-v0.1138.0...app-v0.1139.0) (2026-11-17)


### Features

* **platform:** step through new chat and for you with chat navigation keys ([#47906](https://github.com/okou-ai/okou/issues/47906)) ([ae36c94](https://github.com/okou-ai/okou/commit/ae36c9477fc58ba9fc2bf66b1388430e30b43ff3))


### Bug Fixes

* **app:** preload for you feed with ably updates ([#47977](https://github.com/okou-ai/okou/issues/47977)) ([37e9143](https://github.com/okou-ai/okou/commit/37e9143ee0af84a84e3cf33463c4afdd12588015))

## [0.1138.0](https://github.com/okou-ai/okou/compare/app-v0.1137.1...app-v0.1138.0) (2026-11-16)


### Features

* route presentation templates by output format ([#47842](https://github.com/okou-ai/okou/issues/47842)) ([b342805](https://github.com/okou-ai/okou/commit/b342805293be679b34781d7ff4811669feccbb77))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.75.0
    * @okouai/core bumped to 8.845.0
    * @okouai/ui bumped to 1.21.34

## [0.1137.1](https://github.com/okou-ai/okou/compare/app-v0.1137.0...app-v0.1137.1) (2026-11-16)


### Bug Fixes

* **app:** refine visualization selection chips ([#47888](https://github.com/okou-ai/okou/issues/47888)) ([c64cef6](https://github.com/okou-ai/okou/commit/c64cef650edd4ad914514bb20f5a87c8431edff2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.844.3
    * @okouai/ui bumped to 1.21.33

## [0.1137.0](https://github.com/okou-ai/okou/compare/app-v0.1136.1...app-v0.1137.0) (2026-11-16)


### Features

* **android:** stream active-run output with web data semantics ([#47766](https://github.com/okou-ai/okou/issues/47766)) ([7ab9764](https://github.com/okou-ai/okou/commit/7ab9764c662ec7ea5d8d261cdc714334aa4973d4))


### Bug Fixes

* **app:** restore bounded search tool controls in the composer ([#47860](https://github.com/okou-ai/okou/issues/47860)) ([d25a226](https://github.com/okou-ai/okou/commit/d25a2263333aa7e0a107dbcddb2062b6754ccba5))
* **app:** smooth for you card pagination ([#47847](https://github.com/okou-ai/okou/issues/47847)) ([5044cf1](https://github.com/okou-ai/okou/commit/5044cf149c0fbe0866df11e12193f7e5b77cc75f))
* make system updates configurable ([#47882](https://github.com/okou-ai/okou/issues/47882)) ([f1bf918](https://github.com/okou-ai/okou/commit/f1bf918e9c3d2033a956b51a8bcb3ee0ad77cb3c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.74.0
    * @okouai/core bumped to 8.844.2
    * @okouai/ui bumped to 1.21.32

## [0.1136.1](https://github.com/okou-ai/okou/compare/app-v0.1136.0...app-v0.1136.1) (2026-11-16)


### Bug Fixes

* **app:** add spacing between sidebar entry rows ([#47826](https://github.com/okou-ai/okou/issues/47826)) ([69ff7c2](https://github.com/okou-ai/okou/commit/69ff7c2df43b559b3b5a5a29d26b161d948b3cfb))
* **app:** redirect unavailable workflows with a toast ([#47825](https://github.com/okou-ai/okou/issues/47825)) ([41d40d8](https://github.com/okou-ai/okou/commit/41d40d822060b0c2813c986616727f3da22136cc))
* **platform:** close project deletion dialog before chat sync ([#47837](https://github.com/okou-ai/okou/issues/47837)) ([614ecba](https://github.com/okou-ai/okou/commit/614ecba0e56b94ac7c0af4e217eba69d28ebb4bb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/browser-extension-client bumped to 0.4.5
    * @okouai/core bumped to 8.844.1
    * @okouai/ui bumped to 1.21.31

## [0.1136.0](https://github.com/okou-ai/okou/compare/app-v0.1135.0...app-v0.1136.0) (2026-11-16)


### Features

* add for you source preferences and unread indicators ([#47771](https://github.com/okou-ai/okou/issues/47771)) ([5d3bca3](https://github.com/okou-ai/okou/commit/5d3bca33002b020ebed8d8a0d379777fb1c542b8))
* support automatic onboarding from opt-in entry links ([#47757](https://github.com/okou-ai/okou/issues/47757)) ([56e28d4](https://github.com/okou-ai/okou/commit/56e28d455427e09e5511cf59868bfbc5a07626a6))


### Refactoring

* prepare structured run failures and recovery ([#47749](https://github.com/okou-ai/okou/issues/47749)) ([fca7335](https://github.com/okou-ai/okou/commit/fca73354c6b5b0aa4f122e78947565b274323991))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.73.0
    * @okouai/core bumped to 8.844.0
    * @okouai/ui bumped to 1.21.30

## [0.1135.0](https://github.com/okou-ai/okou/compare/app-v0.1134.1...app-v0.1135.0) (2026-11-16)


### Features

* replace the notification bell with platform feed events ([#47711](https://github.com/okou-ai/okou/issues/47711)) ([b5aac15](https://github.com/okou-ai/okou/commit/b5aac15af841802f580b268f27cfce7539cb9269))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.72.0
    * @okouai/core bumped to 8.843.0
    * @okouai/ui bumped to 1.21.29

## [0.1134.1](https://github.com/okou-ai/okou/compare/app-v0.1134.0...app-v0.1134.1) (2026-11-16)


### Bug Fixes

* **app:** show a skeleton only for credits progress ([#47706](https://github.com/okou-ai/okou/issues/47706)) ([769be8b](https://github.com/okou-ai/okou/commit/769be8b4f7533f76abcd2724cf6a8481d6df1e2e))
* **platform:** forward worker credential continuity gaps to tabs ([#47697](https://github.com/okou-ai/okou/issues/47697)) ([c514dae](https://github.com/okou-ai/okou/commit/c514dae7e111b29e03b14af579f73c9096b4475f))

## [0.1134.0](https://github.com/okou-ai/okou/compare/app-v0.1133.5...app-v0.1134.0) (2026-11-16)


### Features

* **platform:** capability art palette pass, desk bell, matte gears and live magnifier ([#47694](https://github.com/okou-ai/okou/issues/47694)) ([c272a2c](https://github.com/okou-ai/okou/commit/c272a2cc6aa5b6a23c374f9d0ea1d939cd0b6f4c))


### Bug Fixes

* cap connector rewards at ten per user ([#47699](https://github.com/okou-ai/okou/issues/47699)) ([8093612](https://github.com/okou-ai/okou/commit/8093612f536b8d3e8d5920fa9ed0a7583a29f80b))
* redeem onboarding codes for existing free workspaces ([#47701](https://github.com/okou-ai/okou/issues/47701)) ([92e7bd7](https://github.com/okou-ai/okou/commit/92e7bd7fdafe3afa458b39b57c148faf66cdebec))
* require phone use opt-in and authorize access from chat ([#47650](https://github.com/okou-ai/okou/issues/47650)) ([d99b85b](https://github.com/okou-ai/okou/commit/d99b85b2a06c635ca25fa93b9f6a0fc66b55b276))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.71.1
    * @okouai/core bumped to 8.842.1
    * @okouai/ui bumped to 1.21.28

## [0.1133.5](https://github.com/okou-ai/okou/compare/app-v0.1133.4...app-v0.1133.5) (2026-11-16)


### Performance Improvements

* **app:** defer unopened composer add-menu rows ([#47691](https://github.com/okou-ai/okou/issues/47691)) ([9ac5ddc](https://github.com/okou-ai/okou/commit/9ac5ddcba37efba101d44c02787e751eae740f49))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.71.0
    * @okouai/core bumped to 8.842.0
    * @okouai/ui bumped to 1.21.27

## [0.1133.4](https://github.com/okou-ai/okou/compare/app-v0.1133.3...app-v0.1133.4) (2026-11-16)


### Bug Fixes

* **platform:** recover detached browser hover without replay ([#47629](https://github.com/okou-ai/okou/issues/47629)) ([41c58f5](https://github.com/okou-ai/okou/commit/41c58f56993d3f45503ca3e0e4bdb2558b3e6970))


### Performance Improvements

* **app:** avoid preparing empty browser address hints ([#47658](https://github.com/okou-ai/okou/issues/47658)) ([aadb08e](https://github.com/okou-ai/okou/commit/aadb08ec17f2a01c93cd1644cbf24aa19db00f8b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.70.1
    * @okouai/core bumped to 8.841.1
    * @okouai/ui bumped to 1.21.26

## [0.1133.3](https://github.com/okou-ai/okou/compare/app-v0.1133.2...app-v0.1133.3) (2026-11-16)


### Bug Fixes

* **wallet:** accept saved cards without deprecated expiry ([#47627](https://github.com/okou-ai/okou/issues/47627)) ([7a14ea6](https://github.com/okou-ai/okou/commit/7a14ea67b62610689337040be952f906090dc589))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.70.0
    * @okouai/core bumped to 8.841.0
    * @okouai/ui bumped to 1.21.25

## [0.1133.2](https://github.com/okou-ai/okou/compare/app-v0.1133.1...app-v0.1133.2) (2026-11-16)


### Bug Fixes

* **app:** make image trackpad zoom continuous ([#47615](https://github.com/okou-ai/okou/issues/47615)) ([19eac05](https://github.com/okou-ai/okou/commit/19eac05c6e0d6930880b09201906418553cd6e61))
* **app:** move feishu and lark setup into the workspace pane ([#47004](https://github.com/okou-ai/okou/issues/47004)) ([b335319](https://github.com/okou-ai/okou/commit/b335319978a6bd0b9de466418b238b01b327ee64))


### Performance Improvements

* **app:** avoid translating empty browser operation notices ([#47614](https://github.com/okou-ai/okou/issues/47614)) ([da2c015](https://github.com/okou-ai/okou/commit/da2c015f29eaefc8dad2d4e5d3762bbe1f96fdc7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.69.0
    * @okouai/core bumped to 8.840.0
    * @okouai/ui bumped to 1.21.24

## [0.1133.1](https://github.com/okou-ai/okou/compare/app-v0.1133.0...app-v0.1133.1) (2026-11-16)


### Performance Improvements

* **app:** isolate browser history navigation consumers ([#47538](https://github.com/okou-ai/okou/issues/47538)) ([551df61](https://github.com/okou-ai/okou/commit/551df6159c5e059f1feaa16f3b7cf086bff30071))
* **app:** isolate vnc form rendering from wizard steps ([#47522](https://github.com/okou-ai/okou/issues/47522)) ([27fb093](https://github.com/okou-ai/okou/commit/27fb093874176ee7b237380d0a1342758a0ff41c))
* **app:** localize vnc profile subscriptions ([#47548](https://github.com/okou-ai/okou/issues/47548)) ([42d965a](https://github.com/okou-ai/okou/commit/42d965aefbe0b5f4020cd2d27b949a4c0f713647))
* **app:** narrow capability translation reads ([#47540](https://github.com/okou-ai/okou/issues/47540)) ([88339c4](https://github.com/okou-ai/okou/commit/88339c45d101fc25b97a5fe25f3a408882d12b56))
* **test:** avoid unrelated browser style proxies ([#47556](https://github.com/okou-ai/okou/issues/47556)) ([ef1d6a1](https://github.com/okou-ai/okou/commit/ef1d6a10a0fcaa744ba004e5b5ab855d5bf2826a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.68.0
    * @okouai/core bumped to 8.839.7
    * @okouai/ui bumped to 1.21.23

## [0.1133.0](https://github.com/okou-ai/okou/compare/app-v0.1132.2...app-v0.1133.0) (2026-11-15)


### Features

* **android:** add native apk update and recovery flows ([#47331](https://github.com/okou-ai/okou/issues/47331)) ([c9d9bdb](https://github.com/okou-ai/okou/commit/c9d9bdb0c7a3affbfc4f0a3910a1eb22cbeddf21))


### Bug Fixes

* **app:** highlight the whole browser tab on hover ([#47482](https://github.com/okou-ai/okou/issues/47482)) ([2102cce](https://github.com/okou-ai/okou/commit/2102cce0e41c384545a5cedca454c58a76b51104))
* **platform:** keep forks in their source project ([#47444](https://github.com/okou-ai/okou/issues/47444)) ([ecb5350](https://github.com/okou-ai/okou/commit/ecb53502c1fc05aaae4d7e79dbc9e8815fa2d10a))


### Performance Improvements

* **test:** trim ordinary invitation click simulation ([#47389](https://github.com/okou-ai/okou/issues/47389)) ([78a93f1](https://github.com/okou-ai/okou/commit/78a93f1506f4940f29b0d489f9d22c14b3cd85ba))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.67.0
    * @okouai/core bumped to 8.839.6
    * @okouai/ui bumped to 1.21.22

## [0.1132.2](https://github.com/okou-ai/okou/compare/app-v0.1132.1...app-v0.1132.2) (2026-11-14)


### Performance Improvements

* **app:** isolate browser new-tab availability updates ([#47257](https://github.com/okou-ai/okou/issues/47257)) ([cf064b9](https://github.com/okou-ai/okou/commit/cf064b983e51cc646821453f7487970fab9387d3))
* **app:** narrow native browser input subscription ([#47298](https://github.com/okou-ai/okou/issues/47298)) ([f9735a1](https://github.com/okou-ai/okou/commit/f9735a17f4c2a61f766e50af866db1bf78cad7d2))
* **app:** narrow remote-access dialog subscriptions ([#47262](https://github.com/okou-ai/okou/issues/47262)) ([d2318bb](https://github.com/okou-ai/okou/commit/d2318bb2f6022b91bc87fde4003d9f1504737fbb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.66.0
    * @okouai/core bumped to 8.839.5
    * @okouai/ui bumped to 1.21.21

## [0.1132.1](https://github.com/okou-ai/okou/compare/app-v0.1132.0...app-v0.1132.1) (2026-11-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.65.0
    * @okouai/core bumped to 8.839.4
    * @okouai/ui bumped to 1.21.20

## [0.1132.0](https://github.com/okou-ai/okou/compare/app-v0.1131.1...app-v0.1132.0) (2026-11-14)


### Features

* **platform:** animate project folds within virtual chat windows ([#47172](https://github.com/okou-ai/okou/issues/47172)) ([3ebfc3c](https://github.com/okou-ai/okou/commit/3ebfc3ca70613d52bb1d432f7085d47f739ed86b))


### Bug Fixes

* **app:** preserve reading position across narrow sidebar reveals ([#47192](https://github.com/okou-ai/okou/issues/47192)) ([ff3b21b](https://github.com/okou-ai/okou/commit/ff3b21bd9fcc80758340cee0a3a048b9aaf85960))


### Performance Improvements

* **browser:** size screencast windows from sampled cdp latency ([#47191](https://github.com/okou-ai/okou/issues/47191)) ([8af86d9](https://github.com/okou-ai/okou/commit/8af86d99a0c521c2c43df969c901737b60a59ca2))

## [0.1131.1](https://github.com/okou-ai/okou/compare/app-v0.1131.0...app-v0.1131.1) (2026-11-14)


### Performance Improvements

* **app:** narrow browser view subscriptions ([#47184](https://github.com/okou-ai/okou/issues/47184)) ([f2520eb](https://github.com/okou-ai/okou/commit/f2520eb57a3dc0407bd54014e87b96d6ebe8e632))

## [0.1131.0](https://github.com/okou-ai/okou/compare/app-v0.1130.2...app-v0.1131.0) (2026-11-14)


### Features

* **browser:** generate address and google search urls locally ([#47099](https://github.com/okou-ai/okou/issues/47099)) ([6be0c8e](https://github.com/okou-ai/okou/commit/6be0c8e4347ab15140b293b702d7029e742aa77d))
* **browser:** guide saved-password filling in native forms ([#47165](https://github.com/okou-ai/okou/issues/47165)) ([a32a809](https://github.com/okou-ai/okou/commit/a32a809515a18986dd6c172e70e549d244521636))


### Bug Fixes

* **app:** keep browser tab icons and close controls usable ([#47162](https://github.com/okou-ai/okou/issues/47162)) ([87c637e](https://github.com/okou-ai/okou/commit/87c637e61d7b8523da4b930cb5591279939f2a8c))


### Refactoring

* **platform:** stack virtual chat rows in a positioned window ([#47160](https://github.com/okou-ai/okou/issues/47160)) ([b64cc19](https://github.com/okou-ai/okou/commit/b64cc199ba7676cd6c351336f5d1ae9d27ed75d4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.64.0
    * @okouai/core bumped to 8.839.3
    * @okouai/ui bumped to 1.21.19

## [0.1130.2](https://github.com/okou-ai/okou/compare/app-v0.1130.1...app-v0.1130.2) (2026-11-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.63.2
    * @okouai/core bumped to 8.839.2
    * @okouai/ui bumped to 1.21.18

## [0.1130.1](https://github.com/okou-ai/okou/compare/app-v0.1130.0...app-v0.1130.1) (2026-11-14)


### Bug Fixes

* **ios:** match existing web chat sharing behavior ([#47105](https://github.com/okou-ai/okou/issues/47105)) ([e25ad70](https://github.com/okou-ai/okou/commit/e25ad705a20e4cf55d75ade9c6dd7c0a9d45d0e5))


### Refactoring

* **app:** continue layout work from owning commands ([#47085](https://github.com/okou-ai/okou/issues/47085)) ([13e8551](https://github.com/okou-ai/okou/commit/13e85512767faa1659f591b30c5e98f8a5134f36))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.63.1
    * @okouai/core bumped to 8.839.1
    * @okouai/ui bumped to 1.21.17

## [0.1130.0](https://github.com/okou-ai/okou/compare/app-v0.1129.0...app-v0.1130.0) (2026-11-14)


### Features

* **android:** add native conversation history ([#47084](https://github.com/okou-ai/okou/issues/47084)) ([ceff05b](https://github.com/okou-ai/okou/commit/ceff05bf314bda810b8fd0203f50bba4ead15048))
* **app:** add presentation output format preference ([#47056](https://github.com/okou-ai/okou/issues/47056)) ([0ade2b2](https://github.com/okou-ai/okou/commit/0ade2b212cae98fe96ece41f48f58e7d3b76005b))


### Refactoring

* **browser:** enforce native connections and retire viewer endpoint ([#47114](https://github.com/okou-ai/okou/issues/47114)) ([78e6915](https://github.com/okou-ai/okou/commit/78e6915a86aad95ad10b91b3552adc49328a2c42))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.63.0
    * @okouai/core bumped to 8.839.0
    * @okouai/ui bumped to 1.21.16

## [0.1129.0](https://github.com/okou-ai/okou/compare/app-v0.1128.0...app-v0.1129.0) (2026-11-13)


### Features

* **app:** animate the home capability tray open, close and tab switches ([#47082](https://github.com/okou-ai/okou/issues/47082)) ([4ba0e24](https://github.com/okou-ai/okou/commit/4ba0e24b989f5a02b49caa0628e6839fce8037eb))
* **app:** roll out the compact cloud browser header ([#47092](https://github.com/okou-ai/okou/issues/47092)) ([98ce97f](https://github.com/okou-ai/okou/commit/98ce97f96793753ad2276df83e96e8264d900d5c))


### Bug Fixes

* **app:** match project folding to the ios disclosure spring ([#47063](https://github.com/okou-ai/okou/issues/47063)) ([4e7eaaa](https://github.com/okou-ai/okou/commit/4e7eaaae0aca75c174cd62766c82d7e6ddfc7029))


### Refactoring

* **billing:** remove retired custom plan contracts ([#47020](https://github.com/okou-ai/okou/issues/47020)) ([84cfbb9](https://github.com/okou-ai/okou/commit/84cfbb9a93416818bc36ed5fa1645e1db3a31571))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.62.1
    * @okouai/core bumped to 8.838.0
    * @okouai/ui bumped to 1.21.15

## [0.1128.0](https://github.com/okou-ai/okou/compare/app-v0.1127.0...app-v0.1128.0) (2026-11-13)


### Features

* align web and ios chat message sharing ([#47059](https://github.com/okou-ai/okou/issues/47059)) ([971a42f](https://github.com/okou-ai/okou/commit/971a42fa47c06591adb653265a8ce4055c40b266))


### Bug Fixes

* **app:** hand image annotation off without a blink and attach marks at once ([#47054](https://github.com/okou-ai/okou/issues/47054)) ([8d3eaf7](https://github.com/okou-ai/okou/commit/8d3eaf711d9c61acd2bb5e842a6dd4eaed69614a))
* **app:** round the inset picture corners in the home capability art ([#47075](https://github.com/okou-ai/okou/issues/47075)) ([0c6f63b](https://github.com/okou-ai/okou/commit/0c6f63bbd239364d6b6385bd1778d518c8c0615e))
* **platform:** clarify project new chat tooltip ([#47079](https://github.com/okou-ai/okou/issues/47079)) ([57acb19](https://github.com/okou-ai/okou/commit/57acb193be149a36c2dff1069e7e6249c95a6f0f))
* **platform:** draw the sidebar draft pencil with the pin's ink and optical size ([#47076](https://github.com/okou-ai/okou/issues/47076)) ([13f8a27](https://github.com/okou-ai/okou/commit/13f8a27660312452457256ede0f65820672443a9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.62.0
    * @okouai/core bumped to 8.837.0
    * @okouai/ui bumped to 1.21.14

## [0.1127.0](https://github.com/okou-ai/okou/compare/app-v0.1126.0...app-v0.1127.0) (2026-11-13)


### Features

* introduce typed feed items under suggestions rollout ([#47053](https://github.com/okou-ai/okou/issues/47053)) ([e052b90](https://github.com/okou-ai/okou/commit/e052b90b3ed950ce46c7fc51235e87c1c3034164))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.61.0
    * @okouai/core bumped to 8.836.2
    * @okouai/ui bumped to 1.21.13

## [0.1126.0](https://github.com/okou-ai/okou/compare/app-v0.1125.0...app-v0.1126.0) (2026-11-13)


### Features

* **app:** add home capabilities to composer menus ([#47026](https://github.com/okou-ai/okou/issues/47026)) ([d94a2a0](https://github.com/okou-ai/okou/commit/d94a2a02ca5a35cfc41315bd0de9728564a0d245))


### Bug Fixes

* **app:** align approved error page layouts and credit icon ([#47027](https://github.com/okou-ai/okou/issues/47027)) ([a54050d](https://github.com/okou-ai/okou/commit/a54050da6ba63e410040130fcc92ee03cef6842e))
* **app:** prioritize unread project indicators over active chats ([#47052](https://github.com/okou-ai/okou/issues/47052)) ([cbfd8fb](https://github.com/okou-ai/okou/commit/cbfd8fb32d4920b8d012a21c109709674bb07d06))
* **platform:** separate project folding from home navigation ([#47047](https://github.com/okou-ai/okou/issues/47047)) ([7d877c5](https://github.com/okou-ai/okou/commit/7d877c54b7e57a97e5fe8aaa2cada23bcc7efe52))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.60.0
    * @okouai/core bumped to 8.836.1
    * @okouai/ui bumped to 1.21.12

## [0.1125.0](https://github.com/okou-ai/okou/compare/app-v0.1124.0...app-v0.1125.0) (2026-11-13)


### Features

* **app:** restyle the home capability cards with flat-lay objects and a texture ground ([#47021](https://github.com/okou-ai/okou/issues/47021)) ([22c29b0](https://github.com/okou-ai/okou/commit/22c29b01b8dcd6dd7e860fce36a487d0e07c4f35))
* **ios:** add plan and billing management to settings ([#47013](https://github.com/okou-ai/okou/issues/47013)) ([441cd8e](https://github.com/okou-ai/okou/commit/441cd8e0a323e3aa9b6f2b0863fed86b888c7de7))


### Refactoring

* **billing:** retire atom and custom plan issuance ([#47016](https://github.com/okou-ai/okou/issues/47016)) ([d193291](https://github.com/okou-ai/okou/commit/d193291916805888cf1f4952e249d65021f642b4))


### Performance Improvements

* **platform:** derive active vnc profile labels ([#47017](https://github.com/okou-ai/okou/issues/47017)) ([9f6d238](https://github.com/okou-ai/okou/commit/9f6d23810723e9f515b84495f41a1f8dee9a1a44))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.59.1
    * @okouai/core bumped to 8.836.0
    * @okouai/ui bumped to 1.21.11

## [0.1124.0](https://github.com/okou-ai/okou/compare/app-v0.1123.2...app-v0.1124.0) (2026-11-13)


### Features

* **app:** open my okou settings from home and chat avatars ([#47008](https://github.com/okou-ai/okou/issues/47008)) ([f8b13fd](https://github.com/okou-ai/okou/commit/f8b13fd951a278fbe88cdf72dec08cdda5b1764e))
* **app:** restore workflow shelf covers and scroll the home tray in a fixed window ([#46968](https://github.com/okou-ai/okou/issues/46968)) ([197f3e5](https://github.com/okou-ai/okou/commit/197f3e5bcd08d3aebf685a5d337acba0f022b90e))


### Bug Fixes

* **app:** unify home project and chat workspace layout ([#46999](https://github.com/okou-ai/okou/issues/46999)) ([37e65b4](https://github.com/okou-ai/okou/commit/37e65b47f9eeb8b1e58a3cf318b384dc0a63b6e6))


### Refactoring

* **api:** remove legacy browser country and screen fields ([#46995](https://github.com/okou-ai/okou/issues/46995)) ([d4e7cac](https://github.com/okou-ai/okou/commit/d4e7cac108098cbf988f7e6944f3f24054b5e5d9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.59.0
    * @okouai/core bumped to 8.835.2
    * @okouai/ui bumped to 1.21.10

## [0.1123.2](https://github.com/okou-ai/okou/compare/app-v0.1123.1...app-v0.1123.2) (2026-11-13)


### Performance Improvements

* **platform:** narrow vnc field editor subscriptions ([#46992](https://github.com/okou-ai/okou/issues/46992)) ([8267d6b](https://github.com/okou-ai/okou/commit/8267d6b1d1c9fc7ad10fdcb40821ebc5dc2e2bfe))

## [0.1123.1](https://github.com/okou-ai/okou/compare/app-v0.1123.0...app-v0.1123.1) (2026-11-13)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.58.1
    * @okouai/connectors bumped to 3.23.1
    * @okouai/core bumped to 8.835.1
    * @okouai/ui bumped to 1.21.9

## [0.1123.0](https://github.com/okou-ai/okou/compare/app-v0.1122.3...app-v0.1123.0) (2026-11-13)


### Features

* **app:** echo selected visualization preferences in chat ([#46849](https://github.com/okou-ai/okou/issues/46849)) ([a63f6b8](https://github.com/okou-ai/okou/commit/a63f6b83f1965d746f6de1f20993dbcd298094f6))


### Performance Improvements

* **browser:** narrow viewer control subscriptions ([#46966](https://github.com/okou-ai/okou/issues/46966)) ([80aea5b](https://github.com/okou-ai/okou/commit/80aea5bd21d7c42985ca82a6376d2fd94e92b93f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.835.0
    * @okouai/ui bumped to 1.21.8

## [0.1122.3](https://github.com/okou-ai/okou/compare/app-v0.1122.2...app-v0.1122.3) (2026-11-13)


### Bug Fixes

* **platform:** remove obsolete agent lists from project deletion copy ([#46956](https://github.com/okou-ai/okou/issues/46956)) ([39cae12](https://github.com/okou-ai/okou/commit/39cae1298e2c6e8e4117990743ba10f224605430))

## [0.1122.2](https://github.com/okou-ai/okou/compare/app-v0.1122.1...app-v0.1122.2) (2026-11-13)


### Performance Improvements

* **app:** narrow connector entry subscriptions ([#46934](https://github.com/okou-ai/okou/issues/46934)) ([c3d6e66](https://github.com/okou-ai/okou/commit/c3d6e66a7704c8b5572e16454a010e1eb7bfa466))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.58.0
    * @okouai/core bumped to 8.834.2
    * @okouai/ui bumped to 1.21.7

## [0.1122.1](https://github.com/okou-ai/okou/compare/app-v0.1122.0...app-v0.1122.1) (2026-11-13)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.57.0
    * @okouai/core bumped to 8.834.1
    * @okouai/ui bumped to 1.21.6

## [0.1122.0](https://github.com/okou-ai/okou/compare/app-v0.1121.0...app-v0.1122.0) (2026-11-12)


### Features

* **browser:** graduate shared browser and remove rollout switch ([#46833](https://github.com/okou-ai/okou/issues/46833)) ([e50e38e](https://github.com/okou-ai/okou/commit/e50e38e284b2e310198bf8f96cc0c44cd3752001))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.56.0
    * @okouai/core bumped to 8.834.0
    * @okouai/ui bumped to 1.21.5

## [0.1121.0](https://github.com/okou-ai/okou/compare/app-v0.1120.0...app-v0.1121.0) (2026-11-12)


### Features

* **connectors:** add gated cloudflare access authoring ([#46841](https://github.com/okou-ai/okou/issues/46841)) ([794e401](https://github.com/okou-ai/okou/commit/794e401d206b8ea4ff4793dd38ad59192588ff46))
* **remote-control:** approve vnc chat access from message cards ([#46844](https://github.com/okou-ai/okou/issues/46844)) ([068dd05](https://github.com/okou-ai/okou/commit/068dd0513427864c4469e7c4b05d4e42dacf5841))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.55.0
    * @okouai/core bumped to 8.833.0
    * @okouai/ui bumped to 1.21.4

## [0.1120.0](https://github.com/okou-ai/okou/compare/app-v0.1119.0...app-v0.1120.0) (2026-11-12)


### Features

* **app:** hang the capability tabs on a lighter home tray ([#46807](https://github.com/okou-ai/okou/issues/46807)) ([ffe9a03](https://github.com/okou-ai/okou/commit/ffe9a03074d4b3d6aa9e72797428464b21468d51))
* **connectors:** enforce cloudflare access for custom http and mcp ([#46635](https://github.com/okou-ai/okou/issues/46635)) ([e31b757](https://github.com/okou-ai/okou/commit/e31b757de380ca9e2a659dc5630872bd2d4e85c4))


### Bug Fixes

* **app:** add remote control list loading skeleton ([#46830](https://github.com/okou-ai/okou/issues/46830)) ([f5c2a16](https://github.com/okou-ai/okou/commit/f5c2a166b39919a93893e06b6694c10a9dc0ec7e))
* **app:** default chart output to report ([#46842](https://github.com/okou-ai/okou/issues/46842)) ([44fb1f8](https://github.com/okou-ai/okou/commit/44fb1f825ee43766380a083482b0ed9bf98020de))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.54.0
    * @okouai/connectors bumped to 3.23.0
    * @okouai/core bumped to 8.832.0
    * @okouai/ui bumped to 1.21.3

## [0.1119.0](https://github.com/okou-ai/okou/compare/app-v0.1118.0...app-v0.1119.0) (2026-11-12)


### Features

* **app:** move home compliance under the cards and settle the first home in ([#46782](https://github.com/okou-ai/okou/issues/46782)) ([20d176e](https://github.com/okou-ai/okou/commit/20d176eb7552739897d55330f334087963258803))


### Bug Fixes

* adapt welcome and connector copy to my okou ([#46760](https://github.com/okou-ai/okou/issues/46760)) ([369db8a](https://github.com/okou-ai/okou/commit/369db8a0df2e4546bc35a03cf9ec1ba701e4dc55))
* allow unlinking the login email integration ([#46749](https://github.com/okou-ai/okou/issues/46749)) ([d6f52fc](https://github.com/okou-ai/okou/commit/d6f52fcb2b01ba376fd83e41b4f2494a264f2567))
* **app:** hide unavailable credits in personal account status ([#46790](https://github.com/okou-ai/okou/issues/46790)) ([66d49b3](https://github.com/okou-ai/okou/commit/66d49b38e827b356691c49b56f4bd33e2162e0dd))
* **platform:** count projects when deciding inbox empty state ([#46764](https://github.com/okou-ai/okou/issues/46764)) ([00f749c](https://github.com/okou-ai/okou/commit/00f749c3f70e845e17eb142429bd49842499750c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.53.0
    * @okouai/core bumped to 8.831.1
    * @okouai/ui bumped to 1.21.2

## [0.1118.0](https://github.com/okou-ai/okou/compare/app-v0.1117.0...app-v0.1118.0) (2026-11-12)


### Features

* **billing:** ask one-question surveys at the paywall and abandoned checkout ([#46373](https://github.com/okou-ai/okou/issues/46373)) ([dba1a1b](https://github.com/okou-ai/okou/commit/dba1a1be581f3310df718f62f1b4813a96a3e780))


### Bug Fixes

* **app:** show inline inbox links in the email integration ([#46744](https://github.com/okou-ai/okou/issues/46744)) ([fd9fa90](https://github.com/okou-ai/okou/commit/fd9fa9028ddd126712e4dbb6e21fe3ea0db9f60d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.52.0
    * @okouai/core bumped to 8.831.0
    * @okouai/ui bumped to 1.21.1

## [0.1117.0](https://github.com/okou-ai/okou/compare/app-v0.1116.3...app-v0.1117.0) (2026-11-12)


### Features

* **app:** draw every okou avatar with the animated design-system avatar ([#46728](https://github.com/okou-ai/okou/issues/46728)) ([2b40ec0](https://github.com/okou-ai/okou/commit/2b40ec0063dc9b4f64a0cbe17c88978eff8c88e6))
* **app:** rotate home suggestions in the greeting and move explore to the corner ([#46721](https://github.com/okou-ai/okou/issues/46721)) ([3f0798a](https://github.com/okou-ai/okou/commit/3f0798a1790d117931743aa056350e7d2b72ff5b))


### Bug Fixes

* **app:** show a project's emoji on the composer's folder as the sidebar does ([#46731](https://github.com/okou-ai/okou/issues/46731)) ([c979329](https://github.com/okou-ai/okou/commit/c979329ac0f930b6813be7341f30169313b403a3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.51.0
    * @okouai/core bumped to 8.830.0
    * @okouai/ui bumped to 1.21.0

## [0.1116.3](https://github.com/okou-ai/okou/compare/app-v0.1116.2...app-v0.1116.3) (2026-11-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.829.3

## [0.1116.2](https://github.com/okou-ai/okou/compare/app-v0.1116.1...app-v0.1116.2) (2026-11-12)


### Bug Fixes

* **app:** keep composer steady when model notices appear ([#46707](https://github.com/okou-ai/okou/issues/46707)) ([f36fefd](https://github.com/okou-ai/okou/commit/f36fefdbc4778a40f433ba549424156cb3ae2016))
* **platform:** restore the my okou greeting texture and lead the home corner with its icons ([#46714](https://github.com/okou-ai/okou/issues/46714)) ([ca7efe7](https://github.com/okou-ai/okou/commit/ca7efe78fef4fd196f1662a904276b1e08397488))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.50.2
    * @okouai/core bumped to 8.829.2

## [0.1116.1](https://github.com/okou-ai/okou/compare/app-v0.1116.0...app-v0.1116.1) (2026-11-11)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.50.1
    * @okouai/core bumped to 8.829.1

## [0.1116.0](https://github.com/okou-ai/okou/compare/app-v0.1115.0...app-v0.1116.0) (2026-11-11)


### Features

* **app:** add help submenu to the account menu ([#46575](https://github.com/okou-ai/okou/issues/46575)) ([1363c14](https://github.com/okou-ai/okou/commit/1363c145ffbf8507f72e13f628c7d1fe2f4bc567))
* **app:** graduate the account help menu to general availability ([#46594](https://github.com/okou-ai/okou/issues/46594)) ([3f65aed](https://github.com/okou-ai/okou/commit/3f65aed5ceb7682d657950e002bb2e6bec27f46e))
* **connectors:** prepare organization cloudflare access bindings ([#46562](https://github.com/okou-ai/okou/issues/46562)) ([25ec802](https://github.com/okou-ai/okou/commit/25ec8029d50d1392c508fa4355fcbbbce439ad27))


### Bug Fixes

* **app:** attach safe diagnostics to terminal upload failures ([#46588](https://github.com/okou-ai/okou/issues/46588)) ([552e38c](https://github.com/okou-ai/okou/commit/552e38c77c6065d2f18b50e556698bd7f118c876))
* **app:** calm the capability home motion and close the gap above the composer ([#46582](https://github.com/okou-ai/okou/issues/46582)) ([a2c5b68](https://github.com/okou-ai/okou/commit/a2c5b683c56169e01d5ae3165ba371cfad60b01b))
* **app:** explain upstream model request rejections ([#46595](https://github.com/okou-ai/okou/issues/46595)) ([792e7dd](https://github.com/okou-ai/okou/commit/792e7ddbb742e91be84d388f5fefb942ff09807d))
* **platform:** keep the composer in place across home, chat and project ([#46579](https://github.com/okou-ai/okou/issues/46579)) ([b1bce63](https://github.com/okou-ai/okou/commit/b1bce630a6f7cd4b9d2aa6b37168c8ec4aec56b3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.50.0
    * @okouai/connectors bumped to 3.22.0
    * @okouai/core bumped to 8.829.0

## [0.1115.0](https://github.com/okou-ai/okou/compare/app-v0.1114.2...app-v0.1115.0) (2026-11-11)


### Features

* **app:** show a project name's emoji as a badge on its folder ([#46565](https://github.com/okou-ai/okou/issues/46565)) ([9402fdf](https://github.com/okou-ai/okou/commit/9402fdfb07cc2572870c243e7610c33451da7cb7))
* **platform:** align project chat list empty states, pin order and rename with its design ([#46568](https://github.com/okou-ai/okou/issues/46568)) ([e03d0a1](https://github.com/okou-ai/okou/commit/e03d0a180d1763ecfa30a75209b6db968e439b88))


### Refactoring

* **platform:** bound the notification membership scan by its pages ([#46572](https://github.com/okou-ai/okou/issues/46572)) ([6c809fc](https://github.com/okou-ai/okou/commit/6c809fc872bae541db9415d2cf32b7b0d0128b19))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.49.1
    * @okouai/core bumped to 8.828.1

## [0.1114.2](https://github.com/okou-ai/okou/compare/app-v0.1114.1...app-v0.1114.2) (2026-11-11)


### Bug Fixes

* **platform:** clarify remote access selection across connection states ([#46520](https://github.com/okou-ai/okou/issues/46520)) ([ff03d11](https://github.com/okou-ai/okou/commit/ff03d11c1f6a7a0d256c126481fbc1401b5d14a4))

## [0.1114.1](https://github.com/okou-ai/okou/compare/app-v0.1114.0...app-v0.1114.1) (2026-11-11)


### Bug Fixes

* **app:** simplify automation disablement notifications ([#46538](https://github.com/okou-ai/okou/issues/46538)) ([0471cae](https://github.com/okou-ai/okou/commit/0471cae5607a931c1798ea2728d4bcc875e18966))

## [0.1114.0](https://github.com/okou-ai/okou/compare/app-v0.1113.0...app-v0.1114.0) (2026-11-11)


### Features

* **ssh:** approve chat host access from message cards ([#46522](https://github.com/okou-ai/okou/issues/46522)) ([e2ffb56](https://github.com/okou-ai/okou/commit/e2ffb56490b707b96cd6af58b82aaa8e6bc7711c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.49.0
    * @okouai/core bumped to 8.828.0

## [0.1113.0](https://github.com/okou-ai/okou/compare/app-v0.1112.2...app-v0.1113.0) (2026-11-11)


### Features

* add meeting notes to document templates ([#46428](https://github.com/okou-ai/okou/issues/46428)) ([821606a](https://github.com/okou-ai/okou/commit/821606a3d093f8d51d0c39834acccc4a232329d2))
* **app:** redesign the capability home cards and choice tray ([#46432](https://github.com/okou-ai/okou/issues/46432)) ([590283f](https://github.com/okou-ai/okou/commit/590283f4984a42888949d15b00a3ad84ead3b221))


### Bug Fixes

* **platform:** keep connector scope counts stable during refresh ([#46506](https://github.com/okou-ai/okou/issues/46506)) ([1906e7c](https://github.com/okou-ai/okou/commit/1906e7c70193d78f61960c376f4516c3e1cf3e49))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.48.3
    * @okouai/core bumped to 8.827.0

## [0.1112.2](https://github.com/okou-ai/okou/compare/app-v0.1112.1...app-v0.1112.2) (2026-11-11)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.48.2
    * @okouai/core bumped to 8.826.2

## [0.1112.1](https://github.com/okou-ai/okou/compare/app-v0.1112.0...app-v0.1112.1) (2026-11-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.48.1
    * @okouai/core bumped to 8.826.1

## [0.1112.0](https://github.com/okou-ai/okou/compare/app-v0.1111.1...app-v0.1112.0) (2026-11-10)


### Features

* add workflow and email follow-up suggestions ([#46409](https://github.com/okou-ai/okou/issues/46409)) ([dcd6403](https://github.com/okou-ai/okou/commit/dcd6403fd62681e52300224fa020d8c7b9f443d2))
* **app:** classify artifact download intent by type ([#46396](https://github.com/okou-ai/okou/issues/46396)) ([d101cfa](https://github.com/okou-ai/okou/commit/d101cfa122a9424fdbfc24332faf1ae53af3cc78))
* **app:** show okou's tilted avatar in the okou row and move its shortcut to chat ([#46391](https://github.com/okou-ai/okou/issues/46391)) ([99d36de](https://github.com/okou-ai/okou/commit/99d36dedaa706ad13799e90ebb6df21fa7d1ada3))
* **email:** support multiple workspace sender connections ([#46296](https://github.com/okou-ai/okou/issues/46296)) ([f9761e3](https://github.com/okou-ai/okou/commit/f9761e3378b4a881a28d855962f8d87199b6a5d1))
* **notifications:** notify owners when schedules are auto-disabled ([#46353](https://github.com/okou-ai/okou/issues/46353)) ([dbe6412](https://github.com/okou-ai/okou/commit/dbe6412be838f46e3200b9998358fb120f386dbb))


### Bug Fixes

* **app:** hide chat mention avatars in single-agent mode ([#46389](https://github.com/okou-ai/okou/issues/46389)) ([3d173fb](https://github.com/okou-ai/okou/commit/3d173fb00f41dfebb9707f71780d1f95085c31df))
* **email:** clarify workspace connection and show success toast ([#46399](https://github.com/okou-ai/okou/issues/46399)) ([321c716](https://github.com/okou-ai/okou/commit/321c7160da2c7a4156d5151c1d1639e99ef984bd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.48.0
    * @okouai/core bumped to 8.826.0
    * @okouai/ui bumped to 1.20.0

## [0.1111.1](https://github.com/okou-ai/okou/compare/app-v0.1111.0...app-v0.1111.1) (2026-11-10)


### Bug Fixes

* **app:** remove redundant suggestion options label ([#46383](https://github.com/okou-ai/okou/issues/46383)) ([4170362](https://github.com/okou-ai/okou/commit/4170362335123a7fc260b4a5853274fe0e978490))
* **app:** replace the history entry when navigating to the open url ([#46384](https://github.com/okou-ai/okou/issues/46384)) ([909d488](https://github.com/okou-ai/okou/commit/909d488e9492e6f2799cfdc3cb5a978cf7befde7))

## [0.1111.0](https://github.com/okou-ai/okou/compare/app-v0.1110.0...app-v0.1111.0) (2026-11-10)


### Features

* **platform:** show running chats on folded projects ([#46334](https://github.com/okou-ai/okou/issues/46334)) ([f577d8e](https://github.com/okou-ai/okou/commit/f577d8e24d6671a10b2d6fc7ce7fd7018ca3dde2))


### Bug Fixes

* **app:** fold or unfold a project by clicking its name on its page ([#46332](https://github.com/okou-ai/okou/issues/46332)) ([ef37bc0](https://github.com/okou-ai/okou/commit/ef37bc0fca0f8247ae4a7acda5d62a23b2328ad9))
* **chat:** allow direct access to hidden chats without listing them ([#46322](https://github.com/okou-ai/okou/issues/46322)) ([2eba399](https://github.com/okou-ai/okou/commit/2eba399504c64b51bcce672f760712192b1cc21e))
* **email:** add thread context and message source labels ([#46348](https://github.com/okou-ai/okou/issues/46348)) ([c25e9f1](https://github.com/okou-ai/okou/commit/c25e9f1e62bfa7a1b557ac5bcc770ddbb5821ded))
* **platform:** return the chat list to the inbox from the Chat rail link ([#46342](https://github.com/okou-ai/okou/issues/46342)) ([471baa0](https://github.com/okou-ai/okou/commit/471baa0bbb0b9f3db367d39b309b9ceacfb6414b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.47.0
    * @okouai/core bumped to 8.825.5

## [0.1110.0](https://github.com/okou-ai/okou/compare/app-v0.1109.1...app-v0.1110.0) (2026-11-10)


### Features

* **app:** keep connector account selection internal ([#46315](https://github.com/okou-ai/okou/issues/46315)) ([ffa08a3](https://github.com/okou-ai/okou/commit/ffa08a3ffa9ada48ff12bf01a82549577a889aa6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.46.4
    * @okouai/core bumped to 8.825.4

## [0.1109.1](https://github.com/okou-ai/okou/compare/app-v0.1109.0...app-v0.1109.1) (2026-11-10)


### Bug Fixes

* preserve handoff session access and recover failed task entry ([#46268](https://github.com/okou-ai/okou/issues/46268)) ([f68a92e](https://github.com/okou-ai/okou/commit/f68a92e1d2838100fcaaa2d7601d1b0338bc7e2a))

## [0.1109.0](https://github.com/okou-ai/okou/compare/app-v0.1108.0...app-v0.1109.0) (2026-11-10)


### Features

* **browser:** add opt-in viewer fps overlay ([#46281](https://github.com/okou-ai/okou/issues/46281)) ([5de167e](https://github.com/okou-ai/okou/commit/5de167e7e5510cb136d8d32a12539ae6d749f40c))

## [0.1108.0](https://github.com/okou-ai/okou/compare/app-v0.1107.0...app-v0.1108.0) (2026-11-10)


### Features

* **platform:** open learning chat from debug settings ([#46265](https://github.com/okou-ai/okou/issues/46265)) ([0120b3c](https://github.com/okou-ai/okou/commit/0120b3cfa837ad38a96f0dba2189b966d5c6d6fa))
* track hosted site banner state on copy link ([#46255](https://github.com/okou-ai/okou/issues/46255)) ([1769258](https://github.com/okou-ai/okou/commit/1769258343e2649772511696575cb0b1bebffc58))


### Bug Fixes

* **app:** align mobile chat header action order and styling ([#46273](https://github.com/okou-ai/okou/issues/46273)) ([a0dcb44](https://github.com/okou-ai/okou/commit/a0dcb44ccff515bb27f1089bc3b9762de6389504))
* **app:** resolve hosted site settings from the owner site identity ([#46267](https://github.com/okou-ai/okou/issues/46267)) ([eff7ecc](https://github.com/okou-ai/okou/commit/eff7ecc8d7248b6a9c2c413891810a896a2310fa))
* discard whitespace-only web and ios drafts ([#46256](https://github.com/okou-ai/okou/issues/46256)) ([3b76330](https://github.com/okou-ai/okou/commit/3b763302427a8b0b75990dc31f07d466b80b4e83))

## [0.1107.0](https://github.com/okou-ai/okou/compare/app-v0.1106.1...app-v0.1107.0) (2026-11-10)


### Features

* **platform:** fold projects with mod+shift+left/right and from the project menu ([#46136](https://github.com/okou-ai/okou/issues/46136)) ([aa9cc73](https://github.com/okou-ai/okou/commit/aa9cc730404bb417047d86e13b2c0bf8ff4c56df))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.46.3
    * @okouai/connectors bumped to 3.21.7
    * @okouai/core bumped to 8.825.3

## [0.1106.1](https://github.com/okou-ai/okou/compare/app-v0.1106.0...app-v0.1106.1) (2026-11-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.46.2
    * @okouai/core bumped to 8.825.2

## [0.1106.0](https://github.com/okou-ai/okou/compare/app-v0.1105.0...app-v0.1106.0) (2026-11-09)


### Features

* **app:** track artifact download, drive sync, and banner intent ([#46185](https://github.com/okou-ai/okou/issues/46185)) ([2d4b454](https://github.com/okou-ai/okou/commit/2d4b454b4b25a8107cd1a26c0de2a997e9403b5c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.46.1
    * @okouai/core bumped to 8.825.1

## [0.1105.0](https://github.com/okou-ai/okou/compare/app-v0.1104.0...app-v0.1105.0) (2026-11-09)


### Features

* **app:** lead my okou chat list with new chat and new project rows ([#46159](https://github.com/okou-ai/okou/issues/46159)) ([1b5af70](https://github.com/okou-ai/okou/commit/1b5af7038f04cef3b637ffc1b11d8fdcf315e695))
* **platform:** pick a new chat's project from the composer ([#46147](https://github.com/okou-ai/okou/issues/46147)) ([42dac27](https://github.com/okou-ai/okou/commit/42dac27c6ea2320312d82b489111ed1cacf5f13a))


### Bug Fixes

* **app:** group secondary chat actions in an icon-only dropdown ([#46138](https://github.com/okou-ai/okou/issues/46138)) ([e92341f](https://github.com/okou-ai/okou/commit/e92341fddca02e6b9256c02c57b4716d5c8c6fda))

## [0.1104.0](https://github.com/okou-ai/okou/compare/app-v0.1103.1...app-v0.1104.0) (2026-11-09)


### Features

* **app:** show local media thumbnails while attachments upload ([#46135](https://github.com/okou-ai/okou/issues/46135)) ([939735c](https://github.com/okou-ai/okou/commit/939735cbddaa58b4a025235ad0392277df5c889a))
* **platform:** move my okou into settings ([#46131](https://github.com/okou-ai/okou/issues/46131)) ([fbc5e70](https://github.com/okou-ai/okou/commit/fbc5e7037ebd946fe38ad361f59246b9f26644d6))
* **platform:** refine homepage cards and suggestion review ([#46086](https://github.com/okou-ai/okou/issues/46086)) ([e623b9b](https://github.com/okou-ai/okou/commit/e623b9b2ad179812b5b38a98ff119188265311bf))
* **platform:** run personal learning from debug settings ([#46118](https://github.com/okou-ai/okou/issues/46118)) ([1e9afe0](https://github.com/okou-ai/okou/commit/1e9afe0c6b71ababbbc00133ef889ff956247731))


### Bug Fixes

* **app:** clear unchanged home prompts when dismissing guides ([#46099](https://github.com/okou-ai/okou/issues/46099)) ([11d1df0](https://github.com/okou-ai/okou/commit/11d1df03cf4235cc60b7faf71111d3148ece6548))
* **app:** move wallet to personal settings ([#46129](https://github.com/okou-ai/okou/issues/46129)) ([ed348e1](https://github.com/okou-ai/okou/commit/ed348e115d9b5097bead754830883c07e6bcbc38))
* **app:** use suggestion titles for new chats ([#46141](https://github.com/okou-ai/okou/issues/46141)) ([2dd19a9](https://github.com/okou-ai/okou/commit/2dd19a904d3a2ccba94537e809a37bd8b3cc2e23))
* **platform:** follow shadcn v4 dialog header and section spacing ([#46103](https://github.com/okou-ai/okou/issues/46103)) ([200c2c4](https://github.com/okou-ai/okou/commit/200c2c45d44a22f1c7de07ab806e63694f79504e))
* **platform:** upgrade tiptap to 3.32.2 so instructions keep plus signs literal ([#46109](https://github.com/okou-ai/okou/issues/46109)) ([8c29b5d](https://github.com/okou-ai/okou/commit/8c29b5d2c955e0bc5104a1bb59266b18c3515569))
* report live attachment upload progress ([#46095](https://github.com/okou-ai/okou/issues/46095)) ([85d0544](https://github.com/okou-ai/okou/commit/85d05449efca847f25a48e094ac57aef4eaa9b39))
* unify optional callbacks across computer access cards ([#46066](https://github.com/okou-ai/okou/issues/46066)) ([fbf9922](https://github.com/okou-ai/okou/commit/fbf9922703e4f61dfddf0e377092a3382d20fdf6))


### Refactoring

* remove automatic continuation for busy chats ([#46148](https://github.com/okou-ai/okou/issues/46148)) ([54073d0](https://github.com/okou-ai/okou/commit/54073d0594fac9acbd8a07208573cd24120b7b4f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.46.0
    * @okouai/core bumped to 8.825.0
    * @okouai/ui bumped to 1.19.5

## [0.1103.1](https://github.com/okou-ai/okou/compare/app-v0.1103.0...app-v0.1103.1) (2026-11-09)


### Bug Fixes

* **platform:** attach long pasted text and guard onboarding prompt size ([#46052](https://github.com/okou-ai/okou/issues/46052)) ([aa8b9da](https://github.com/okou-ai/okou/commit/aa8b9da4f253d3e899e37418ad9026303589e88b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.45.1
    * @okouai/core bumped to 8.824.5

## [0.1103.0](https://github.com/okou-ai/okou/compare/app-v0.1102.6...app-v0.1103.0) (2026-11-09)


### Features

* **app:** list suggestions on home and retire the feed page ([#46056](https://github.com/okou-ai/okou/issues/46056)) ([262cfc3](https://github.com/okou-ai/okou/commit/262cfc3466f5d208d8bd6a71d23cbae439669311))
* **platform:** redesign friend referral dialog ([#46065](https://github.com/okou-ai/okou/issues/46065)) ([b738439](https://github.com/okou-ai/okou/commit/b7384395d9c84aebfaf2f98e68fdac32a60edc06))


### Bug Fixes

* **app:** compact capability entries on mobile ([#46050](https://github.com/okou-ai/okou/issues/46050)) ([4db5b03](https://github.com/okou-ai/okou/commit/4db5b03b8fbe2e56425f873b3c6d7e1ab7fce2fc))
* **platform:** overlay markdown scrollbars so code blocks keep their height ([#46062](https://github.com/okou-ai/okou/issues/46062)) ([02f97c4](https://github.com/okou-ai/okou/commit/02f97c4502ad848fb34f2f136721e1ec34bef22a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.824.4

## [0.1102.6](https://github.com/okou-ai/okou/compare/app-v0.1102.5...app-v0.1102.6) (2026-11-09)


### Bug Fixes

* **core:** enable single agent for staff organizations ([#46046](https://github.com/okou-ai/okou/issues/46046)) ([7ac09ab](https://github.com/okou-ai/okou/commit/7ac09abc90aec538104dc0e0327fef8240ada955))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.824.3

## [0.1102.5](https://github.com/okou-ai/okou/compare/app-v0.1102.4...app-v0.1102.5) (2026-11-09)


### Bug Fixes

* **app:** announce new features in the force-upgrade dialog ([#46023](https://github.com/okou-ai/okou/issues/46023)) ([ded4a6a](https://github.com/okou-ai/okou/commit/ded4a6a42b4a9236e5c2f11da6341c7663d58d02))
* retire thread-list indicator refresh fallback ([#46009](https://github.com/okou-ai/okou/issues/46009)) ([3696606](https://github.com/okou-ai/okou/commit/36966068cf7f6465fddc6dde6fde2574b95f4c1c))

## [0.1102.4](https://github.com/okou-ai/okou/compare/app-v0.1102.3...app-v0.1102.4) (2026-11-08)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.824.2

## [0.1102.3](https://github.com/okou-ai/okou/compare/app-v0.1102.2...app-v0.1102.3) (2026-11-08)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.824.1

## [0.1102.2](https://github.com/okou-ai/okou/compare/app-v0.1102.1...app-v0.1102.2) (2026-11-08)


### Bug Fixes

* **app:** align browser floors and pdf worker polyfills ([#45939](https://github.com/okou-ai/okou/issues/45939)) ([0b39244](https://github.com/okou-ai/okou/commit/0b3924465055e62283bb8cb70a414b7f3339a12d))

## [0.1102.1](https://github.com/okou-ai/okou/compare/app-v0.1102.0...app-v0.1102.1) (2026-11-08)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.45.0
    * @okouai/core bumped to 8.824.0

## [0.1102.0](https://github.com/okou-ai/okou/compare/app-v0.1101.1...app-v0.1102.0) (2026-11-07)


### Features

* **platform:** add staff capability homepage and empty chat discovery ([#45863](https://github.com/okou-ai/okou/issues/45863)) ([b3bf2d5](https://github.com/okou-ai/okou/commit/b3bf2d520fe7f2aa2ada7162ed4be57f68b21ea6))


### Bug Fixes

* cap chat attachment uploads at 512 megabytes ([#45845](https://github.com/okou-ai/okou/issues/45845)) ([3936b03](https://github.com/okou-ai/okou/commit/3936b03aa991094a7417091344c17c5ff0287bf2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.44.5
    * @okouai/connectors bumped to 3.21.6
    * @okouai/core bumped to 8.823.0

## [0.1101.1](https://github.com/okou-ai/okou/compare/app-v0.1101.0...app-v0.1101.1) (2026-11-07)


### Bug Fixes

* **browser:** constrain viewer to its panel width ([#45828](https://github.com/okou-ai/okou/issues/45828)) ([0ed2726](https://github.com/okou-ai/okou/commit/0ed2726e47264e91680a7ef0db8050f0c53f6fde))


### Performance Improvements

* **browser:** defer paused viewer discovery reads ([#45770](https://github.com/okou-ai/okou/issues/45770)) ([ee7a1f8](https://github.com/okou-ai/okou/commit/ee7a1f86bbcebed125153b7bb3b897f78ad096b1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.44.4
    * @okouai/core bumped to 8.822.4

## [0.1101.0](https://github.com/okou-ai/okou/compare/app-v0.1100.0...app-v0.1101.0) (2026-11-07)


### Features

* **platform:** show the feed waiting count as a badge ([#45806](https://github.com/okou-ai/okou/issues/45806)) ([5406e96](https://github.com/okou-ai/okou/commit/5406e96ae364b0b6ca477765d1ac537d1d992561))

## [0.1100.0](https://github.com/okou-ai/okou/compare/app-v0.1099.2...app-v0.1100.0) (2026-11-07)


### Features

* **app:** lead the chat list with an okou row that opens the feed ([#45761](https://github.com/okou-ai/okou/issues/45761)) ([4c74b4a](https://github.com/okou-ai/okou/commit/4c74b4a617aea2a2e2002f1456413190babf70e4))


### Bug Fixes

* **browser:** preserve recovery ownership across resource handoffs ([#45696](https://github.com/okou-ai/okou/issues/45696)) ([811bc03](https://github.com/okou-ai/okou/commit/811bc03cdb20d3d146fde223965fc79e03d0df58))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.44.3
    * @okouai/core bumped to 8.822.3

## [0.1099.2](https://github.com/okou-ai/okou/compare/app-v0.1099.1...app-v0.1099.2) (2026-11-06)


### Refactoring

* remove four fully rolled-out feature switches ([#45747](https://github.com/okou-ai/okou/issues/45747)) ([0f03d03](https://github.com/okou-ai/okou/commit/0f03d03881ff81b8eb72e1ceca6a80619603873c))


### Performance Improvements

* **browser:** combine authorized viewer acquisition ([#45723](https://github.com/okou-ai/okou/issues/45723)) ([92a34a9](https://github.com/okou-ai/okou/commit/92a34a9767f5c87fb7413a88fafa7d6e9febddef))
* **browser:** retain initialized viewers across tab switches ([#45706](https://github.com/okou-ai/okou/issues/45706)) ([5287482](https://github.com/okou-ai/okou/commit/528748292b772700929c55c27f8688947e1106a3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.44.2
    * @okouai/core bumped to 8.822.2

## [0.1099.1](https://github.com/okou-ai/okou/compare/app-v0.1099.0...app-v0.1099.1) (2026-11-06)


### Bug Fixes

* refresh runner platform api and cli release markers ([#45745](https://github.com/okou-ai/okou/issues/45745)) ([47693c2](https://github.com/okou-ai/okou/commit/47693c2ed37fd90fa108346a36158d28c5c1c9ca))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.44.1
    * @okouai/core bumped to 8.822.1

## [0.1099.0](https://github.com/okou-ai/okou/compare/app-v0.1098.0...app-v0.1099.0) (2026-11-06)


### Features

* **app:** refine artifact preview toolbar behind a feature switch ([#45626](https://github.com/okou-ai/okou/issues/45626)) ([2e0cb82](https://github.com/okou-ai/okou/commit/2e0cb82cb278afaa08d03792e91dc70cc455acc1))
* **app:** serve my okou chat at / with a single chat list header ([#45656](https://github.com/okou-ai/okou/issues/45656)) ([c8064eb](https://github.com/okou-ai/okou/commit/c8064ebb73d0ff098cbaaec73788db396792c0f3))


### Bug Fixes

* **app:** allow dragging chats out of projects ([#45707](https://github.com/okou-ai/okou/issues/45707)) ([796a995](https://github.com/okou-ai/okou/commit/796a9950d144e93db03348b17bf873922e900b73))
* **app:** make chat header panels consistent and retire artifacts auto-open ([#45669](https://github.com/okou-ai/okou/issues/45669)) ([11b6837](https://github.com/okou-ai/okou/commit/11b6837e854dcd643e31ca309b450b7a15a5de37))
* **app:** use calmer colors for subscription usage states ([#45711](https://github.com/okou-ai/okou/issues/45711)) ([b4f3a87](https://github.com/okou-ai/okou/commit/b4f3a87fbed5f76e33e49a4208bceeca6221246b))


### Refactoring

* **app:** let signals own forward, annotation and permission drawer flows ([#45713](https://github.com/okou-ai/okou/issues/45713)) ([0102f6a](https://github.com/okou-ai/okou/commit/0102f6ace4dc2cda5eb5d021cc8f9c8c21edafa9))


### Performance Improvements

* refresh chat indicators only on run state changes ([#45712](https://github.com/okou-ai/okou/issues/45712)) ([ac06095](https://github.com/okou-ai/okou/commit/ac0609591b2a0a5f159afb50b7561df46a23f6a4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.44.0
    * @okouai/core bumped to 8.822.0

## [0.1098.0](https://github.com/okou-ai/okou/compare/app-v0.1097.5...app-v0.1098.0) (2026-11-06)


### Features

* **app:** fork selected content into personal chats ([#45682](https://github.com/okou-ai/okou/issues/45682)) ([e5b87ee](https://github.com/okou-ai/okou/commit/e5b87ee02c8c2fd14a491799a033b5b710f6a4d3))
* roll out message pdf export, pwa navigation and subscription usage to all users ([#45649](https://github.com/okou-ai/okou/issues/45649)) ([7dfca6c](https://github.com/okou-ai/okou/commit/7dfca6cb087e0337b3519a8ae72d1fefd271ff69))


### Bug Fixes

* **app:** stop enrolling marketing sessions during startup ([#45695](https://github.com/okou-ai/okou/issues/45695)) ([4923b42](https://github.com/okou-ai/okou/commit/4923b42635d7a4cc68af5b095fd9f0673579b76b)) [#45568](https://github.com/okou-ai/okou/issues/45568)
* **browser:** keep address editing independent of remote readiness ([#45592](https://github.com/okou-ai/okou/issues/45592)) ([f6c1f16](https://github.com/okou-ai/okou/commit/f6c1f16d432606645acc3d3d015f1034bdf8d656))
* synchronize instruction editors with external saves ([#45677](https://github.com/okou-ai/okou/issues/45677)) ([edce7e5](https://github.com/okou-ai/okou/commit/edce7e52437c912359603b4672b50300605b4fff))


### Refactoring

* **platform:** bound the initial frame tree read by its observation ([#45693](https://github.com/okou-ai/okou/issues/45693)) ([f923c98](https://github.com/okou-ai/okou/commit/f923c98923133c1efa8109495f61f613ce068241))
* remove chat thread archiving and muting feature switches ([#45680](https://github.com/okou-ai/okou/issues/45680)) ([4183b2f](https://github.com/okou-ai/okou/commit/4183b2f44fb472a38962c5ad3124939bb11b5cdc))
* remove ChatThreadInlineRename feature switch ([#45667](https://github.com/okou-ai/okou/issues/45667)) ([9d43b51](https://github.com/okou-ai/okou/commit/9d43b517bffb15108c0c0a96e7df808f2dd58bfe))


### Performance Improvements

* **platform:** stable transcript rows and pane panels that follow the thread on screen ([#45483](https://github.com/okou-ai/okou/issues/45483)) ([5627b62](https://github.com/okou-ai/okou/commit/5627b625a72759b799429df776657ce3798b886a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.43.3
    * @okouai/core bumped to 8.821.0

## [0.1097.5](https://github.com/okou-ai/okou/compare/app-v0.1097.4...app-v0.1097.5) (2026-11-06)


### Refactoring

* remove ChatHomeCompliance feature switch ([#45672](https://github.com/okou-ai/okou/issues/45672)) ([07785aa](https://github.com/okou-ai/okou/commit/07785aac2d8046b313af2e29f8fcd2104f1604ac))
* remove markdown cjk emphasis feature switch ([#45663](https://github.com/okou-ai/okou/issues/45663)) ([9b7dcae](https://github.com/okou-ai/okou/commit/9b7dcaeff9e1241b2b67d7499c65818a86080ded))
* remove marketing content handoff feature switch ([#45651](https://github.com/okou-ai/okou/issues/45651)) ([75493dc](https://github.com/okou-ai/okou/commit/75493dc2e0b68047d72fe961678f549c94ba9be5))


### Performance Improvements

* **browser:** preserve selected sessions across unrelated tab changes ([#45539](https://github.com/okou-ai/okou/issues/45539)) ([3c01d73](https://github.com/okou-ai/okou/commit/3c01d73360bb57dc073ee3ef6db3ec640c7d50fb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.820.1

## [0.1097.4](https://github.com/okou-ai/okou/compare/app-v0.1097.3...app-v0.1097.4) (2026-11-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.820.0

## [0.1097.3](https://github.com/okou-ai/okou/compare/app-v0.1097.2...app-v0.1097.3) (2026-11-06)


### Refactoring

* retire halloween campaign and restore the greeting avatar ([#45618](https://github.com/okou-ai/okou/issues/45618)) ([60127c6](https://github.com/okou-ai/okou/commit/60127c60e299ae35549f889340859cd758f78db5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.43.2
    * @okouai/core bumped to 8.819.2

## [0.1097.2](https://github.com/okou-ai/okou/compare/app-v0.1097.1...app-v0.1097.2) (2026-11-06)


### Refactoring

* **app:** replace the chat list resize observer with layout requests ([#45481](https://github.com/okou-ai/okou/issues/45481)) ([6ba0d4c](https://github.com/okou-ai/okou/commit/6ba0d4c4fccbba6f60d083879ea81b075ac9f645))

## [0.1097.1](https://github.com/okou-ai/okou/compare/app-v0.1097.0...app-v0.1097.1) (2026-11-06)


### Refactoring

* **app:** stop passing view callbacks into platform commands ([#45452](https://github.com/okou-ai/okou/issues/45452)) ([8725c3b](https://github.com/okou-ai/okou/commit/8725c3b15d76e1bdf76b1421d22e7803a6c405cb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.43.1
    * @okouai/core bumped to 8.819.1

## [0.1097.0](https://github.com/okou-ai/okou/compare/app-v0.1096.1...app-v0.1097.0) (2026-11-05)


### Features

* add personal my okou across web and ios ([#45501](https://github.com/okou-ai/okou/issues/45501)) ([0b7757b](https://github.com/okou-ai/okou/commit/0b7757b586be66bb28c08b014868b1d7159aa9bc))
* **app:** always show chat header actions with empty states ([#45469](https://github.com/okou-ai/okou/issues/45469)) ([6f351f4](https://github.com/okou-ai/okou/commit/6f351f4381e178a0b61f64d256726583d59e89a3))
* **app:** simplify shell access authorization cards ([#45502](https://github.com/okou-ai/okou/issues/45502)) ([ebbbacd](https://github.com/okou-ai/okou/commit/ebbbacdc7b75ea90e441560a2edcb558db9793e0))
* **workflow:** support personal workspace workflows in single-agent mode ([#45497](https://github.com/okou-ai/okou/issues/45497)) ([b74dd61](https://github.com/okou-ai/okou/commit/b74dd614ea04401617b27c9d07ce5562eae3743b))


### Bug Fixes

* **app:** keep rejected optimistic edits from overriding later confirmed ones ([#45463](https://github.com/okou-ai/okou/issues/45463)) ([bd65483](https://github.com/okou-ai/okou/commit/bd65483ccf3c56544af58e398fdb048b3801be5c))
* **app:** preserve shell authorization cards during refresh ([#45494](https://github.com/okou-ai/okou/issues/45494)) ([63c7a09](https://github.com/okou-ai/okou/commit/63c7a0998d5d5e75fb9e7291854f67ca07e2ccac))
* **app:** restore connector menu scroll positions ([#45393](https://github.com/okou-ai/okou/issues/45393)) ([9270811](https://github.com/okou-ai/okou/commit/92708118cf2b4806873660c3b3b3d38d69f37836))
* **app:** retain connector permission scope in my okou ([#45512](https://github.com/okou-ai/okou/issues/45512)) ([f857b02](https://github.com/okou-ai/okou/commit/f857b02ad3f732588219369613812441eb05a2ec))


### Refactoring

* **platform:** replace hook equality functions with primitive subscriptions ([#45477](https://github.com/okou-ai/okou/issues/45477)) ([eaeede1](https://github.com/okou-ai/okou/commit/eaeede19085ef0fc422c191877ed2740ee479b45))
* remove markdown table export feature switch ([#45503](https://github.com/okou-ai/okou/issues/45503)) ([6133b12](https://github.com/okou-ai/okou/commit/6133b128f347589a60882de7c14edb4f61436c8d))
* simplify suggestion feedback context ([#45493](https://github.com/okou-ai/okou/issues/45493)) ([f52030e](https://github.com/okou-ai/okou/commit/f52030ec40ee282a9f7de9d270ba4282639c26ab))


### Performance Improvements

* **browser:** overlap independent viewer domain enables ([#45486](https://github.com/okou-ai/okou/issues/45486)) ([421561e](https://github.com/okou-ai/okou/commit/421561e98fa7cb0e58fddc457987c6ec59ce1783))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.43.0
    * @okouai/connectors bumped to 3.21.5
    * @okouai/core bumped to 8.819.0

## [0.1096.1](https://github.com/okou-ai/okou/compare/app-v0.1096.0...app-v0.1096.1) (2026-11-05)


### Bug Fixes

* **app:** restore viewer compatibility on supported browsers ([#45458](https://github.com/okou-ai/okou/issues/45458)) ([b8760f4](https://github.com/okou-ai/okou/commit/b8760f41d2eaecfcd5d2a8c5d01b6251dd4f102d))
* **platform:** make text selection visible under colour palettes ([#45422](https://github.com/okou-ai/okou/issues/45422)) ([b0259ff](https://github.com/okou-ai/okou/commit/b0259ffa77afae2c9b6388f661fc2c1fd4a4af70))


### Refactoring

* remove zapier connector feature switch ([#45434](https://github.com/okou-ai/okou/issues/45434)) ([a0dffed](https://github.com/okou-ai/okou/commit/a0dffedcad6d1a71682fc099d55b9877156857b6))
* retire ahrefs oauth and remove feature switch ([#45430](https://github.com/okou-ai/okou/issues/45430)) ([385da3e](https://github.com/okou-ai/okou/commit/385da3e75b353bf977474131072c27ca2f1840c9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.42.5
    * @okouai/connectors bumped to 3.21.4
    * @okouai/core bumped to 8.818.7
    * @okouai/ui bumped to 1.19.4

## [0.1096.0](https://github.com/okou-ai/okou/compare/app-v0.1095.7...app-v0.1096.0) (2026-11-05)


### Features

* **platform:** merge projects into the chat list and give them their own page ([#45392](https://github.com/okou-ai/okou/issues/45392)) ([22a0b1b](https://github.com/okou-ai/okou/commit/22a0b1b41b633d64c816c775b8990805895f62ae))


### Bug Fixes

* **app:** make the ideas breadcrumb a link back to chat ([#45423](https://github.com/okou-ai/okou/issues/45423)) ([b6f77e5](https://github.com/okou-ai/okou/commit/b6f77e5f18a73c24ff398a2c352a9fafef676caa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.818.6

## [0.1095.7](https://github.com/okou-ai/okou/compare/app-v0.1095.6...app-v0.1095.7) (2026-11-05)


### Bug Fixes

* **app:** reserve the pointer cursor for links ([#45410](https://github.com/okou-ai/okou/issues/45410)) ([a362219](https://github.com/okou-ai/okou/commit/a3622192416bde93d9f063e5bc15f6451ee838cb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.42.4
    * @okouai/core bumped to 8.818.5
    * @okouai/ui bumped to 1.19.3

## [0.1095.6](https://github.com/okou-ai/okou/compare/app-v0.1095.5...app-v0.1095.6) (2026-11-05)


### Bug Fixes

* **app:** keep invitation code visible for returning signup visitors ([#45370](https://github.com/okou-ai/okou/issues/45370)) ([4e6ac29](https://github.com/okou-ai/okou/commit/4e6ac29b944f9cdeb27d481189261026698c5eb0))
* **app:** open sidebar usage on click only ([#45375](https://github.com/okou-ai/okou/issues/45375)) ([0dbb20b](https://github.com/okou-ai/okou/commit/0dbb20bba49ef03fedeab53e1cb3b1cb93c96673))
* **browser:** use server-authoritative session authorization ([#45332](https://github.com/okou-ai/okou/issues/45332)) ([5bec95a](https://github.com/okou-ai/okou/commit/5bec95a6c33f4989747094db13b56636fb8bc77d))


### Refactoring

* **app:** derive rail boundaries without observers ([#45355](https://github.com/okou-ai/okou/issues/45355)) ([b390ac7](https://github.com/okou-ai/okou/commit/b390ac7209c2cbc2c43bf07afb249096fe80e301))


### Performance Improvements

* **app:** isolate chat header refresh rendering ([#45373](https://github.com/okou-ai/okou/issues/45373)) ([453a5de](https://github.com/okou-ai/okou/commit/453a5de930be543f4d364a8e6a54d0b59bb017e9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.818.4
    * @okouai/ui bumped to 1.19.2

## [0.1095.5](https://github.com/okou-ai/okou/compare/app-v0.1095.4...app-v0.1095.5) (2026-11-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.42.3
    * @okouai/connectors bumped to 3.21.3
    * @okouai/core bumped to 8.818.3

## [0.1095.4](https://github.com/okou-ai/okou/compare/app-v0.1095.3...app-v0.1095.4) (2026-11-05)


### Bug Fixes

* **browser:** report recovery failures only after retries stop ([#45323](https://github.com/okou-ai/okou/issues/45323)) ([00ee1b8](https://github.com/okou-ai/okou/commit/00ee1b83a64c5cbe9c8fd597848c6f8246580cf0))

## [0.1095.3](https://github.com/okou-ai/okou/compare/app-v0.1095.2...app-v0.1095.3) (2026-11-05)


### Bug Fixes

* **app:** show the invitation code on ordinary signup ([#45329](https://github.com/okou-ai/okou/issues/45329)) ([bf51d83](https://github.com/okou-ai/okou/commit/bf51d83cc891f6d7ec34f5f9941425d7e110f27c))
* **browser:** expire operation failure notices after three seconds ([#45331](https://github.com/okou-ai/okou/issues/45331)) ([e5d43fd](https://github.com/okou-ai/okou/commit/e5d43fd0a12ad79f1dfc69e24c6ceb20e2d0be29))


### Refactoring

* **platform:** centralize async helpers with lint tracking ([#45326](https://github.com/okou-ai/okou/issues/45326)) ([1a5864b](https://github.com/okou-ai/okou/commit/1a5864be4fc4fb5415814c23d06de2b78ab7d310))


### Performance Improvements

* **app:** cache chat connector overview and refresh changed targets ([#45294](https://github.com/okou-ai/okou/issues/45294)) ([1b68448](https://github.com/okou-ai/okou/commit/1b684482eb01e7ff92d743ae140f7d6ea5932c1d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.42.2
    * @okouai/core bumped to 8.818.2
    * @okouai/ui bumped to 1.19.1

## [0.1095.2](https://github.com/okou-ai/okou/compare/app-v0.1095.1...app-v0.1095.2) (2026-11-05)


### Refactoring

* remove proactive planning and tasks ([#45210](https://github.com/okou-ai/okou/issues/45210)) ([222d861](https://github.com/okou-ai/okou/commit/222d8618346194b5af227c5e147a0076181ee3e0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.42.1
    * @okouai/core bumped to 8.818.1

## [0.1095.1](https://github.com/okou-ai/okou/compare/app-v0.1095.0...app-v0.1095.1) (2026-11-05)


### Bug Fixes

* **app:** add browser to the mobile chat more menu ([#45268](https://github.com/okou-ai/okou/issues/45268)) ([382b830](https://github.com/okou-ai/okou/commit/382b83068b0b91b0ca432d078504bf953c8cacf8))


### Refactoring

* **app:** reveal clipped titles without resize observers ([#45241](https://github.com/okou-ai/okou/issues/45241)) ([2b9d0ce](https://github.com/okou-ai/okou/commit/2b9d0ce4c3dc028403abb485f0f94106510d75b8))

## [0.1095.0](https://github.com/okou-ai/okou/compare/app-v0.1094.0...app-v0.1095.0) (2026-11-04)


### Features

* **app:** show unread indicators on collapsed projects ([#45208](https://github.com/okou-ai/okou/issues/45208)) ([edec2af](https://github.com/okou-ai/okou/commit/edec2af2a840a4f326fca982f139f34c3c8b6819))


### Bug Fixes

* refresh runner platform api and cli release markers ([#45244](https://github.com/okou-ai/okou/issues/45244)) ([a1933e5](https://github.com/okou-ai/okou/commit/a1933e593f4c66bce81c0ac201cd40c5826a07f9))


### Refactoring

* **app:** replace presentation viewport observer with css scaling ([#45240](https://github.com/okou-ai/okou/issues/45240)) ([1f8c8ef](https://github.com/okou-ai/okou/commit/1f8c8ef72e12872d61a8fceaa89d1fd0dd380419))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.42.0
    * @okouai/core bumped to 8.818.0

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
