# Changelog

## [0.71.1](https://github.com/okou-ai/okou/compare/android-v0.71.0...android-v0.71.1) (2026-11-28)


### Bug Fixes

* **android:** fit images on the first viewer frame ([#51692](https://github.com/okou-ai/okou/issues/51692)) ([9a904dc](https://github.com/okou-ai/okou/commit/9a904dc88202e2324430a338b4eddca63f57f029))
* **android:** preserve interrupted content read fades ([#51693](https://github.com/okou-ai/okou/issues/51693)) ([26e211c](https://github.com/okou-ai/okou/commit/26e211c2f4fb852041aa4a19c1ace5380f81de1d))
* **android:** show uploaded and named workspace avatars ([#51672](https://github.com/okou-ai/okou/issues/51672)) ([8fb98a2](https://github.com/okou-ai/okou/commit/8fb98a21022efe6afb4fc399d8ec5044468577e5))
* **android:** unify the read failure illustration ([#51691](https://github.com/okou-ai/okou/issues/51691)) ([f4bbb36](https://github.com/okou-ai/okou/commit/f4bbb36a12f2a35e8c6f566c3dbddc628bcae824))


### Performance Improvements

* **android:** narrow workspace shell observation ([#51687](https://github.com/okou-ai/okou/issues/51687)) ([59d6aee](https://github.com/okou-ai/okou/commit/59d6aeef1d6b8fd9788949a0cf401286b047f41f))

## [0.71.0](https://github.com/okou-ai/okou/compare/android-v0.70.0...android-v0.71.0) (2026-11-28)


### Features

* **android:** complete workflow commands in the chat composer ([#51650](https://github.com/okou-ai/okou/issues/51650)) ([7bd7e62](https://github.com/okou-ai/okou/commit/7bd7e6285ad4e16db7c4d6206d74d8631008c5a4))


### Bug Fixes

* **android:** align artifact preview action feedback with the pane snackbar ([#51648](https://github.com/okou-ai/okou/issues/51648)) ([070b4ad](https://github.com/okou-ai/okou/commit/070b4adcac5c84e0f4032fd372a6c94c8385ab5a))
* **android:** publish connector authorization after exact account confirmation ([#51654](https://github.com/okou-ai/okou/issues/51654)) ([69ff8ac](https://github.com/okou-ai/okou/commit/69ff8accedd1a46057fe67a151743ccbccd188fc))
* **android:** settle ambiguous settings saves without readback ([#51652](https://github.com/okou-ai/okou/issues/51652)) ([5270891](https://github.com/okou-ai/okou/commit/527089135ec5ee7842379789ece85c2575261451))

## [0.70.0](https://github.com/okou-ai/okou/compare/android-v0.69.2...android-v0.70.0) (2026-11-28)


### Features

* **artifacts:** cut over to files and unified artifact access and retire legacy routes ([#51627](https://github.com/okou-ai/okou/issues/51627)) ([d5b57bd](https://github.com/okou-ai/okou/commit/d5b57bd1003bbe1aabd0d56b27efa8dbcfa96087))


### Bug Fixes

* **android:** align chat and project rename failure feedback ([#51640](https://github.com/okou-ai/okou/issues/51640)) ([4d7d58a](https://github.com/okou-ai/okou/commit/4d7d58a93d0ef2270c0cfac8fbee7d0d6a868aac))
* **android:** align chat error and stopped feedback with design ([#51573](https://github.com/okou-ai/okou/issues/51573)) ([15c0e96](https://github.com/okou-ai/okou/commit/15c0e9668a0701ffa0c71491f3d6b6b378c99803))
* **android:** align project deletion with chat list feedback ([#51599](https://github.com/okou-ai/okou/issues/51599)) ([188ca6a](https://github.com/okou-ai/okou/commit/188ca6a7cb4736710bbc34b2cda426f37116d0e4))
* **android:** align retry handling for throttled settings writes ([#51632](https://github.com/okou-ai/okou/issues/51632)) ([800bb4e](https://github.com/okou-ai/okou/commit/800bb4e4da893c8476331761e3692dade897ceff))
* **android:** keep wrapped chat link decoration within text ([#51638](https://github.com/okou-ai/okou/issues/51638)) ([4b672aa](https://github.com/okou-ai/okou/commit/4b672aaad6a1ba06dc423affdb994af06619d8f2))
* **android:** preserve workflow and connector feedback order ([#51601](https://github.com/okou-ai/okou/issues/51601)) ([a2ad16b](https://github.com/okou-ai/okou/commit/a2ad16be5c63b4d4735dbe0981ccaf5440139ffa))

## [0.69.2](https://github.com/okou-ai/okou/compare/android-v0.69.1...android-v0.69.2) (2026-11-28)


### Bug Fixes

* **android:** preserve workspace search focus after find back ([#51612](https://github.com/okou-ai/okou/issues/51612)) ([73bb45d](https://github.com/okou-ai/okou/commit/73bb45dc23f222b9f9a8eb6ad3d106cb36af86e8))

## [0.69.1](https://github.com/okou-ai/okou/compare/android-v0.69.0...android-v0.69.1) (2026-11-27)


### Refactoring

* **platform:** remove shared worker and move chat database to main thread ([#51617](https://github.com/okou-ai/okou/issues/51617)) ([28b4617](https://github.com/okou-ai/okou/commit/28b46179ab594879c6500dce635118be837fd576))

## [0.69.0](https://github.com/okou-ai/okou/compare/android-v0.68.1...android-v0.69.0) (2026-11-27)


### Features

* **artifacts:** add unified artifact access api, files dual-write, and client migration ([#51416](https://github.com/okou-ai/okou/issues/51416)) ([2980f4b](https://github.com/okou-ai/okou/commit/2980f4b5f176b0fa5cd871b71a1c5a9a90717eb5))

## [0.68.1](https://github.com/okou-ai/okou/compare/android-v0.68.0...android-v0.68.1) (2026-11-27)


### Bug Fixes

* **android:** align connector member policies with design ([#51563](https://github.com/okou-ai/okou/issues/51563)) ([1bbec76](https://github.com/okou-ai/okou/commit/1bbec76f953068aa17f88a2fed81144d4d5168bc))
* **android:** align model account and credit settings feedback ([#51587](https://github.com/okou-ai/okou/issues/51587)) ([4f45923](https://github.com/okou-ai/okou/commit/4f45923a49a6bca012ed459cd476a20f508c7c61))
* **android:** align model settings with the current design ([#51544](https://github.com/okou-ai/okou/issues/51544)) ([134888d](https://github.com/okou-ai/okou/commit/134888d8407562405fa645b19dd9f7d13a5715f7))
* **android:** match update toolbar height to workspace search ([#51581](https://github.com/okou-ai/okou/issues/51581)) ([f1711d9](https://github.com/okou-ai/okou/commit/f1711d9041efe52b478ca6802f5e8a099a1feb8f))
* **android:** roll back unconfirmed chat list writes ([#51561](https://github.com/okou-ai/okou/issues/51561)) ([ae9dedb](https://github.com/okou-ai/okou/commit/ae9dedb5f860c67c988d10d259d9dd57c0a843dd))
* **android:** show terminal search failures after an empty result ([#51598](https://github.com/okou-ai/okou/issues/51598)) ([22de7b8](https://github.com/okou-ai/okou/commit/22de7b835766f79344a079f70c55d79fdd8d7d21))
* **android:** stabilize tall bottom sheet swipe dismissal ([#51564](https://github.com/okou-ai/okou/issues/51564)) ([d6e060c](https://github.com/okou-ai/okou/commit/d6e060c1a7673e07ea03ad7bd2c0d7f06bfec012))
* **android:** use native sizing in artifact toolbars ([#51590](https://github.com/okou-ai/okou/issues/51590)) ([17aa68e](https://github.com/okou-ai/okou/commit/17aa68e2d1274bcd7f2a4bd3970488cd93b2a3bc))

## [0.68.0](https://github.com/okou-ai/okou/compare/android-v0.67.0...android-v0.68.0) (2026-11-27)


### Features

* **android:** browse inline images within an assistant reply ([#51529](https://github.com/okou-ai/okou/issues/51529)) ([a60ec17](https://github.com/okou-ai/okou/commit/a60ec17e3fb343ffc63d63d5c256104309994b1e))


### Bug Fixes

* **android:** align app update states and controls with current design ([#51526](https://github.com/okou-ai/okou/issues/51526)) ([b48c60e](https://github.com/okou-ai/okou/commit/b48c60ec6f9ed27a0cc7e92b002d0faed5bdab23))
* **android:** align artifact catalog headings and empty actions ([#51523](https://github.com/okou-ai/okou/issues/51523)) ([3941398](https://github.com/okou-ai/okou/commit/394139890ce2de8dfb888ac0cf0d623a39b5c0c1))
* **android:** align connector directory and chat picker ([#51519](https://github.com/okou-ai/okou/issues/51519)) ([d917871](https://github.com/okou-ai/okou/commit/d917871391338812685659d46d80e09b1ec81e20))
* **android:** align personal instructions saving and form geometry ([#51506](https://github.com/okou-ai/okou/issues/51506)) ([0ee1fe4](https://github.com/okou-ai/okou/commit/0ee1fe43634b775317c0a1ed38ad0eaaf9654c90))
* **android:** align workflow tool buttons with material defaults ([#51528](https://github.com/okou-ai/okou/issues/51528)) ([65beed4](https://github.com/okou-ai/okou/commit/65beed4c4883e61d41b5e8f89b9349c297a2b0ee))
* **android:** animate shared content read progress ([#51530](https://github.com/okou-ai/okou/issues/51530)) ([9590392](https://github.com/okou-ai/okou/commit/9590392813c3571bd03ac285b978f34b614aa148))
* **android:** keep workspace search capsules at the same height ([#51525](https://github.com/okou-ai/okou/issues/51525)) ([b6ea517](https://github.com/okou-ai/okou/commit/b6ea517ebbbcf8c331404dda618e66ea169ed8fa))
* **android:** order snackbar feedback within each pane ([#51493](https://github.com/okou-ai/okou/issues/51493)) ([2d23f54](https://github.com/okou-ai/okou/commit/2d23f54922a04a8ce6be8ad76544b0c2c3e6c8c5))
* **android:** prevent workspace entry crashes and preserve retries ([#51531](https://github.com/okou-ai/okou/issues/51531)) ([70ca6ed](https://github.com/okou-ai/okou/commit/70ca6ed694686f4900032c092609e312b3271841))
* **android:** share the elapsed clock for memory snapshots ([#51540](https://github.com/okou-ai/okou/issues/51540)) ([3fe97fa](https://github.com/okou-ai/okou/commit/3fe97faa94130a376a1485e36edcd78b5e2590f4))


### Refactoring

* **android:** use material 3 chat and project rows ([#51504](https://github.com/okou-ai/okou/issues/51504)) ([e012aa6](https://github.com/okou-ai/okou/commit/e012aa692e9b2fc4a7efbeb5f1e97a92e7da9e30))

## [0.67.0](https://github.com/okou-ai/okou/compare/android-v0.66.4...android-v0.67.0) (2026-11-27)


### Features

* **android:** browse draft and sent chat images in the shared viewer ([#51484](https://github.com/okou-ai/okou/issues/51484)) ([e382375](https://github.com/okou-ai/okou/commit/e382375726d5a5d0491469de504d13c695b8a885))


### Bug Fixes

* **android:** align artifact catalog rows, preview actions, and return focus ([#51456](https://github.com/okou-ai/okou/issues/51456)) ([9734b0f](https://github.com/okou-ai/okou/commit/9734b0f3f1c9511734b97f38dc3c9c24fc51857c))
* **android:** align workflow history with material list items ([#51507](https://github.com/okou-ai/okou/issues/51507)) ([26ae576](https://github.com/okou-ai/okou/commit/26ae5762277826d4c169050427415b382493aa4f))
* **android:** align workspace search rows and feedback with design ([#51509](https://github.com/okou-ai/okou/issues/51509)) ([b32b72c](https://github.com/okou-ai/okou/commit/b32b72c169bb1bdc60016ede6d35e09e85275285))
* **android:** use leading-icon padding in artifact previews ([#51502](https://github.com/okou-ai/okou/issues/51502)) ([e790f73](https://github.com/okou-ai/okou/commit/e790f73296fe7dd9b981a4ed0e9a19b23ff8610c))

## [0.66.4](https://github.com/okou-ai/okou/compare/android-v0.66.3...android-v0.66.4) (2026-11-27)


### Bug Fixes

* **android:** scope loading feedback to the active read round ([#51483](https://github.com/okou-ai/okou/issues/51483)) ([6a7331e](https://github.com/okou-ai/okou/commit/6a7331ee6a4c57bc67dd102fa55e5983b2c3df1a))

## [0.66.3](https://github.com/okou-ai/okou/compare/android-v0.66.2...android-v0.66.3) (2026-11-27)


### Bug Fixes

* **android:** keep workflow names visible when display names are blank ([#51417](https://github.com/okou-ai/okou/issues/51417)) ([63a47f6](https://github.com/okou-ai/okou/commit/63a47f68d5de6b20e1ec4b897f0552e22eb20e61))

## [0.66.2](https://github.com/okou-ai/okou/compare/android-v0.66.1...android-v0.66.2) (2026-11-27)


### Bug Fixes

* **android:** align connector account forms with shared design ([#51434](https://github.com/okou-ai/okou/issues/51434)) ([7bf19b0](https://github.com/okou-ai/okou/commit/7bf19b0a95514a626b9c83a9800900e5403855a3))
* **android:** keep email subscription controls in place ([#51430](https://github.com/okou-ai/okou/issues/51430)) ([9b19266](https://github.com/okou-ai/okou/commit/9b192667bb1b83edf8a5eb2a62b15f67f6bd94d7))
* **android:** keep the workspace palette behind system bars ([#51436](https://github.com/okou-ai/okou/issues/51436)) ([378b740](https://github.com/okou-ai/okou/commit/378b740a51d18cf4df388aad9dbe14c8951330fd))
* **android:** preserve hosted artifact scroll during preview loading ([#51425](https://github.com/okou-ai/okou/issues/51425)) ([cc9d43f](https://github.com/okou-ai/okou/commit/cc9d43fd57593daba3a1cd0a9a61b88d92b07662))
* **android:** share originals from chat file previews ([#51450](https://github.com/okou-ai/okou/issues/51450)) ([1cbc36a](https://github.com/okou-ai/okou/commit/1cbc36ac10712d010a3168558e09970799fe0bc6))

## [0.66.1](https://github.com/okou-ai/okou/compare/android-v0.66.0...android-v0.66.1) (2026-11-27)


### Bug Fixes

* **android:** align chat connector read feedback ([#51373](https://github.com/okou-ai/okou/issues/51373)) ([a03b3fd](https://github.com/okou-ai/okou/commit/a03b3fd79976c909577422ed14741b0ff5dadbfd))
* **android:** align update presentation with design v411 ([#51408](https://github.com/okou-ai/okou/issues/51408)) ([a4f9229](https://github.com/okou-ai/okou/commit/a4f922994bc60c54d1b638c4354a6072a55269c8))
* **android:** preserve newer settings choices during readback ([#51404](https://github.com/okou-ai/okou/issues/51404)) ([9ef436a](https://github.com/okou-ai/okou/commit/9ef436afa3a2ac2fe5587dd32ef31e13b1391ce0))
* **android:** restore chat list changes immediately on undo ([#51390](https://github.com/okou-ai/okou/issues/51390)) ([97d52f9](https://github.com/okou-ai/okou/commit/97d52f9cd50dce2db946c9aadde28b1c58b13c4a))
* **android:** restore workflow introductions with their search query ([#51375](https://github.com/okou-ai/okou/issues/51375)) ([d54cc31](https://github.com/okou-ai/okou/commit/d54cc313ad18b0518cd03019f1edd7f94d17dcf5))

## [0.66.0](https://github.com/okou-ai/okou/compare/android-v0.65.5...android-v0.66.0) (2026-11-27)


### Features

* **android:** adopt the v409 adaptive launcher icon ([#51403](https://github.com/okou-ai/okou/issues/51403)) ([f60a532](https://github.com/okou-ai/okou/commit/f60a5325036fd559976ecb031c0d10e2a6ba9137))


### Bug Fixes

* **android:** show workflow purpose matches in workspace search ([#51392](https://github.com/okou-ai/okou/issues/51392)) ([3d719a2](https://github.com/okou-ai/okou/commit/3d719a226e394a3627929ad8036d7cc07e5e9a4e))

## [0.65.5](https://github.com/okou-ai/okou/compare/android-v0.65.4...android-v0.65.5) (2026-11-27)


### Bug Fixes

* **android:** align artifact catalog and hosted preview loading ([#51363](https://github.com/okou-ai/okou/issues/51363)) ([cd92668](https://github.com/okou-ai/okou/commit/cd92668bd984b35536ea8c2464f1afecebf30503))
* **android:** align settings sync and fast mode ([#51323](https://github.com/okou-ai/okou/issues/51323)) ([c544757](https://github.com/okou-ai/okou/commit/c5447578549200f84162117bdfeac281447274ea))
* **android:** keep update actions reachable in short windows ([#51361](https://github.com/okou-ai/okou/issues/51361)) ([332ed02](https://github.com/okou-ai/okou/commit/332ed027ec517f427aa4cb0edfd06c7fe684b105))

## [0.65.4](https://github.com/okou-ai/okou/compare/android-v0.65.3...android-v0.65.4) (2026-11-27)


### Bug Fixes

* **android:** retain selected workflow through search refreshes ([#51357](https://github.com/okou-ai/okou/issues/51357)) ([956b75e](https://github.com/okou-ai/okou/commit/956b75e133cb232d1534bf223998deec90b25542))
* **android:** stabilize chat image, model, and connector states ([#51350](https://github.com/okou-ai/okou/issues/51350)) ([3698deb](https://github.com/okou-ai/okou/commit/3698deb182c634aece5e3d1df41181f139170a43))

## [0.65.3](https://github.com/okou-ai/okou/compare/android-v0.65.2...android-v0.65.3) (2026-11-27)


### Bug Fixes

* **android:** align workflow loading states with the design ([#51338](https://github.com/okou-ai/okou/issues/51338)) ([3d3af39](https://github.com/okou-ai/okou/commit/3d3af392dae5856fccd3bdf7704d0b84b7199695))

## [0.65.2](https://github.com/okou-ai/okou/compare/android-v0.65.1...android-v0.65.2) (2026-11-27)


### Bug Fixes

* **android:** align artifact image viewer with design ([#51236](https://github.com/okou-ai/okou/issues/51236)) ([ff1dd7d](https://github.com/okou-ai/okou/commit/ff1dd7d7415bb9e1f8a39e8572e711475a7f5428))
* **android:** align update failure and install status feedback ([#51317](https://github.com/okou-ai/okou/issues/51317)) ([c0439eb](https://github.com/okou-ai/okou/commit/c0439eba58e3559a754cb53875124dd82fd0da7e))
* **android:** show readable workspace message search excerpts ([#51280](https://github.com/okou-ai/okou/issues/51280)) ([fcc8c39](https://github.com/okou-ai/okou/commit/fcc8c3916b3dd2008bab48e22ba5ec8c9931e2c7))

## [0.65.1](https://github.com/okou-ai/okou/compare/android-v0.65.0...android-v0.65.1) (2026-11-27)


### Bug Fixes

* **android:** keep chat list position during dependency failures ([#51294](https://github.com/okou-ai/okou/issues/51294)) ([3ed7148](https://github.com/okou-ai/okou/commit/3ed71485c3a11907d2ec41de69655bb16e64bbfb))

## [0.65.0](https://github.com/okou-ai/okou/compare/android-v0.64.1...android-v0.65.0) (2026-11-27)


### Features

* **android:** browse chat connectors before loading accounts ([#51274](https://github.com/okou-ai/okou/issues/51274)) ([0b24058](https://github.com/okou-ai/okou/commit/0b24058401d53466f9b2d05b53feffbc5c8526fe))


### Bug Fixes

* **android:** show settings defaults before workspace preferences arrive ([#51273](https://github.com/okou-ai/okou/issues/51273)) ([51ee95a](https://github.com/okou-ai/okou/commit/51ee95ab69678b86b6c6f550c1b2c7488c7efa6f))


### Refactoring

* **android:** share bounded retry timing in settings ([#51233](https://github.com/okou-ai/okou/issues/51233)) ([c704636](https://github.com/okou-ai/okou/commit/c704636ff92a460d595ed2cf567da96cf3e24843))

## [0.64.1](https://github.com/okou-ai/okou/compare/android-v0.64.0...android-v0.64.1) (2026-11-27)


### Bug Fixes

* **android:** align chat list terminal read feedback ([#51272](https://github.com/okou-ai/okou/issues/51272)) ([adace51](https://github.com/okou-ai/okou/commit/adace5196aed90e2d263a0ac14bbc3f5ab8a05f6))

## [0.64.0](https://github.com/okou-ai/okou/compare/android-v0.63.0...android-v0.64.0) (2026-11-27)


### Features

* **artifacts:** add visual browsing to library ([#51115](https://github.com/okou-ai/okou/issues/51115)) ([d11e612](https://github.com/okou-ai/okou/commit/d11e6120de54a6d91addd74541361e0497d5ae0a))

## [0.63.0](https://github.com/okou-ai/okou/compare/android-v0.62.1...android-v0.63.0) (2026-11-26)


### Features

* **android:** align reply headers and stop controls with design ([#51224](https://github.com/okou-ai/okou/issues/51224)) ([d9de7cf](https://github.com/okou-ai/okou/commit/d9de7cf480729ca06431e688f51680d227714e82))
* **android:** share artifact links and manage access ([#51204](https://github.com/okou-ai/okou/issues/51204)) ([6724356](https://github.com/okou-ai/okou/commit/6724356a5c14f25068ca31247b344fc3e6a62e4c))


### Bug Fixes

* **android:** retain loaded chat images on foreground ([#51196](https://github.com/okou-ai/okou/issues/51196)) ([fb355ee](https://github.com/okou-ai/okou/commit/fb355eefb97764032a5a651a2eff032c42d5afed))
* **android:** reveal chat swipe labels continuously ([#51215](https://github.com/okou-ai/okou/issues/51215)) ([91dcfc7](https://github.com/okou-ai/okou/commit/91dcfc72b9a6730c7272f2838045db67597b7d09))
* **android:** reveal the matched block from workspace search ([#51205](https://github.com/okou-ai/okou/issues/51205)) ([6bd96d6](https://github.com/okou-ai/okou/commit/6bd96d6aac095e5b23083656f117465a8a30ba37))
* **android:** show accurate model account quota windows ([#51213](https://github.com/okou-ai/okou/issues/51213)) ([71c79f2](https://github.com/okou-ai/okou/commit/71c79f261c29dd787f2d14f7e552ab69302bd257))


### Refactoring

* **android:** share directory return focus ([#51165](https://github.com/okou-ai/okou/issues/51165)) ([190bc42](https://github.com/okou-ai/okou/commit/190bc42a9f817002dd5a8abfe0342edc1be06df1))

## [0.62.1](https://github.com/okou-ai/okou/compare/android-v0.62.0...android-v0.62.1) (2026-11-26)


### Bug Fixes

* **android:** align search read feedback and group actions ([#51194](https://github.com/okou-ai/okou/issues/51194)) ([1eb2d12](https://github.com/okou-ai/okou/commit/1eb2d1250f9cd405532be0e17bc821787c9a1d68))
* **android:** align update installation handoff with design ([#51182](https://github.com/okou-ai/okou/issues/51182)) ([797b075](https://github.com/okou-ai/okou/commit/797b075d9f3fdedea06b701181a7f280ea57a725))
* **android:** end chat list reads with their foreground scope ([#51175](https://github.com/okou-ai/okou/issues/51175)) ([7729309](https://github.com/okou-ai/okou/commit/7729309653cc736d26fc1765f962b6d4a54362c3))
* **android:** keep the model picker stable on refresh failure ([#51192](https://github.com/okou-ai/okou/issues/51192)) ([c173f4a](https://github.com/okou-ai/okou/commit/c173f4a26361f15b07666b297eb9463f4810f741))
* **android:** stabilize workflow loading and pending controls ([#51174](https://github.com/okou-ai/okou/issues/51174)) ([d11e96c](https://github.com/okou-ai/okou/commit/d11e96c084cd6fb13e8ca9cf82f7896c31f37e60))

## [0.62.0](https://github.com/okou-ai/okou/compare/android-v0.61.1...android-v0.62.0) (2026-11-26)


### Features

* **android:** share authorized artifact originals ([#51167](https://github.com/okou-ai/okou/issues/51167)) ([e032b8b](https://github.com/okou-ai/okou/commit/e032b8bdc923214ef42c2cf1f15d82248e987656))


### Bug Fixes

* **android:** align search focus and retain artifact pages ([#51138](https://github.com/okou-ai/okou/issues/51138)) ([0960de9](https://github.com/okou-ai/okou/commit/0960de99534726404ee8e4d4ff7eb586bf0683c3))
* **android:** keep connector account refresh feedback in the active surface ([#51161](https://github.com/okou-ai/okou/issues/51161)) ([05cc659](https://github.com/okou-ai/okou/commit/05cc659fad7fa17db7cb4cbb9c78fe9abaae29fb))
* **android:** let unavailable default models reset to auto ([#51183](https://github.com/okou-ai/okou/issues/51183)) ([3197413](https://github.com/okou-ai/okou/commit/31974138f441e2ba817f4ba7757f684b4bc03d5b))
* **android:** retain chat queue position across layout changes ([#51155](https://github.com/okou-ai/okou/issues/51155)) ([c7ddc41](https://github.com/okou-ai/okou/commit/c7ddc418167181360f2eb29701c540286db9eb41))

## [0.61.1](https://github.com/okou-ai/okou/compare/android-v0.61.0...android-v0.61.1) (2026-11-26)


### Bug Fixes

* **android:** keep update failures attached to their package ([#51152](https://github.com/okou-ai/okou/issues/51152)) ([e8382c8](https://github.com/okou-ai/okou/commit/e8382c8a7e30eb653e8c4de47f8d32167e6cd556))

## [0.61.0](https://github.com/okou-ai/okou/compare/android-v0.60.1...android-v0.61.0) (2026-11-26)


### Features

* **android:** open image artifacts in the shared viewer ([#51124](https://github.com/okou-ai/okou/issues/51124)) ([2092614](https://github.com/okou-ai/okou/commit/209261422df27b190d0ee4239c119b5508cde42a))


### Bug Fixes

* **android:** align artifact pagination feedback with design ([#51096](https://github.com/okou-ai/okou/issues/51096)) ([f15099b](https://github.com/okou-ai/okou/commit/f15099b5aac8a4d2c667f0bf1a6f2c310aa21754))
* **android:** align workflow actions and menus with material defaults ([#51122](https://github.com/okou-ai/okou/issues/51122)) ([9dc8e99](https://github.com/okou-ai/okou/commit/9dc8e999f49ed57d985b4dffc45d395dbd6ccd6e))
* **android:** continue chat indicator retries across filters ([#51134](https://github.com/okou-ai/okou/issues/51134)) ([3b5ce58](https://github.com/okou-ai/okou/commit/3b5ce58793e8f34bb22525b79f0a7221448aed97))
* **android:** include sent attachments in conversation find ([#51130](https://github.com/okou-ai/okou/issues/51130)) ([5575234](https://github.com/okou-ai/okou/commit/5575234b7e58f1368611ca67d9e331736fcc5e82))
* **android:** restore focus and clarify update toolbar actions ([#51129](https://github.com/okou-ai/okou/issues/51129)) ([1420819](https://github.com/okou-ai/okou/commit/14208194c0d88f162079f0172875183531914334))
* **android:** scope cached credit balance refresh feedback ([#51120](https://github.com/okou-ai/okou/issues/51120)) ([6bb106f](https://github.com/okou-ai/okou/commit/6bb106f06d39c471697108c99d41d1abc1774dba))
* **android:** settle search metadata after skipped list snapshots ([#51118](https://github.com/okou-ai/okou/issues/51118)) ([051ac99](https://github.com/okou-ai/okou/commit/051ac9984f4cfbdcf5abceeafd7766abffc2ec4b))
* **android:** show cold connector account errors in their section ([#51125](https://github.com/okou-ai/okou/issues/51125)) ([dbce6b5](https://github.com/okou-ai/okou/commit/dbce6b53c9ee75a42db26c70212c7dd7948f52c7))


### Refactoring

* **android:** share confirmed form adoption rules ([#51119](https://github.com/okou-ai/okou/issues/51119)) ([067eac8](https://github.com/okou-ai/okou/commit/067eac81dc0319d3041cc18cca96735c2eb01b99))

## [0.60.1](https://github.com/okou-ai/okou/compare/android-v0.60.0...android-v0.60.1) (2026-11-26)


### Bug Fixes

* **android:** align connector directory and read feedback ([#51029](https://github.com/okou-ai/okou/issues/51029)) ([d7eba2b](https://github.com/okou-ai/okou/commit/d7eba2bbfac929fcd60ad80d8e02d5bb2161077b))


### Refactoring

* **android:** share terminal read feedback lifecycle ([#51097](https://github.com/okou-ai/okou/issues/51097)) ([f3efe59](https://github.com/okou-ai/okou/commit/f3efe5923a192a4979206c0746ba0a9d705d45d8))

## [0.60.0](https://github.com/okou-ai/okou/compare/android-v0.59.0...android-v0.60.0) (2026-11-26)


### Features

* **android:** send attachments from the chat composer ([#51035](https://github.com/okou-ai/okou/issues/51035)) ([f57b998](https://github.com/okou-ai/okou/commit/f57b9987c2b7dfb21f36a0d4e07455f2ad07cda3))


### Bug Fixes

* **android:** align workflow read failure feedback ([#51021](https://github.com/okou-ai/okou/issues/51021)) ([5078727](https://github.com/okou-ai/okou/commit/507872777a1d9a3dc2fb87a7f0c1a94e7d863b13))

## [0.59.0](https://github.com/okou-ai/okou/compare/android-v0.58.2...android-v0.59.0) (2026-11-26)


### Features

* **ios:** authorize supported connectors through installed apps ([#50975](https://github.com/okou-ai/okou/issues/50975)) ([a105bd9](https://github.com/okou-ai/okou/commit/a105bd92a24247370daf3b932a7d20fc7ab61d87))


### Bug Fixes

* **android:** align settings first-read failure feedback ([#51062](https://github.com/okou-ai/okou/issues/51062)) ([3f87e23](https://github.com/okou-ai/okou/commit/3f87e23b88d3165835b3b5c7ecca62c85f3d212a))
* **android:** recheck on reopening update details without a compatible release ([#51046](https://github.com/okou-ai/okou/issues/51046)) ([a901f5e](https://github.com/okou-ai/okou/commit/a901f5e839ad57514709e9db4dd04a1c73cc852d))

## [0.58.2](https://github.com/okou-ai/okou/compare/android-v0.58.1...android-v0.58.2) (2026-11-26)


### Bug Fixes

* **android:** open settings selectors at the current option ([#51016](https://github.com/okou-ai/okou/issues/51016)) ([6bfbe17](https://github.com/okou-ai/okou/commit/6bfbe1798210522f745176f81c824dac6581b492))

## [0.58.1](https://github.com/okou-ai/okou/compare/android-v0.58.0...android-v0.58.1) (2026-11-26)


### Bug Fixes

* **android:** align chat list row hover and keyboard focus ([#51018](https://github.com/okou-ai/okou/issues/51018)) ([1a253c4](https://github.com/okou-ai/okou/commit/1a253c4798571c05b131d1ab095e23651013d755))
* **android:** show shared feedback for cold artifact read failures ([#51014](https://github.com/okou-ai/okou/issues/51014)) ([8b46e8b](https://github.com/okou-ai/okou/commit/8b46e8b58b50bc4afdf694896213188d3c12ab70))

## [0.58.0](https://github.com/okou-ai/okou/compare/android-v0.57.4...android-v0.58.0) (2026-11-26)


### Features

* **android:** choose the model in existing conversations ([#50963](https://github.com/okou-ai/okou/issues/50963)) ([f9ba765](https://github.com/okou-ai/okou/commit/f9ba7657cf3535b3bd6030e347caabbc7ba7458d))


### Bug Fixes

* **android:** align connector tabs and external code verification ([#50972](https://github.com/okou-ai/okou/issues/50972)) ([f714cb3](https://github.com/okou-ai/okou/commit/f714cb3144332263492376fcf17b0bc8731c6764))
* **android:** align the workspace entry list surface ([#50999](https://github.com/okou-ai/okou/issues/50999)) ([4016b07](https://github.com/okou-ai/okou/commit/4016b0780e0abb9eb228be70d634d8a5752f6972))
* **android:** align update toolbar and progress styles ([#51006](https://github.com/okou-ai/okou/issues/51006)) ([66ef929](https://github.com/okou-ai/okou/commit/66ef929e506148b455e26940214ab685b29e49d8))
* **android:** revalidate workspace credit visibility ([#51000](https://github.com/okou-ai/okou/issues/51000)) ([b663e2a](https://github.com/okou-ai/okou/commit/b663e2a325503408f35b05309a767fc16ffbe39d))

## [0.57.4](https://github.com/okou-ai/okou/compare/android-v0.57.3...android-v0.57.4) (2026-11-26)


### Bug Fixes

* **android:** align chat list action controls with design ([#50953](https://github.com/okou-ai/okou/issues/50953)) ([5d8eb5c](https://github.com/okou-ai/okou/commit/5d8eb5c70fae4e998e1f6d59376af3e02a2afe23))
* **android:** align settings feedback and native controls ([#50958](https://github.com/okou-ai/okou/issues/50958)) ([986b9fe](https://github.com/okou-ai/okou/commit/986b9fe0c60aa7f1af40b26d4948f62afe0bd839))
* **android:** align workflow tabs and outlined form controls ([#50965](https://github.com/okou-ai/okou/issues/50965)) ([ce66edb](https://github.com/okou-ai/okou/commit/ce66edbc01afe82fcdf41e3953d96f061872fe39))
* **android:** align workspace search read feedback with design ([#50966](https://github.com/okou-ai/okou/issues/50966)) ([3b1592a](https://github.com/okou-ai/okou/commit/3b1592a3aa4123a520abd87a5674fef48cfe1710))

## [0.57.3](https://github.com/okou-ai/okou/compare/android-v0.57.2...android-v0.57.3) (2026-11-26)


### Bug Fixes

* **android:** align settings, editors, and theme colors ([#50772](https://github.com/okou-ai/okou/issues/50772)) ([54379d9](https://github.com/okou-ai/okou/commit/54379d93c4016e4025b8a2f0bdada2b7fabe5c0e))
* **android:** use Material disabled colors for workspace entry checks ([#50942](https://github.com/okou-ai/okou/issues/50942)) ([6b87ade](https://github.com/okou-ai/okou/commit/6b87ade618e0720cb1905e5fb0c123c881f90299))
* **android:** use native colors for artifact preview actions ([#50954](https://github.com/okou-ai/okou/issues/50954)) ([e2123a5](https://github.com/okou-ai/okou/commit/e2123a5f80c20d6dca2b3c150c53f9ded41fe8f7))

## [0.57.2](https://github.com/okou-ai/okou/compare/android-v0.57.1...android-v0.57.2) (2026-11-26)


### Refactoring

* **api:** retire official workflow catalog and automation identities ([#50902](https://github.com/okou-ai/okou/issues/50902)) ([1edc731](https://github.com/okou-ai/okou/commit/1edc731cfb612688e2c648ce00f4fd7f1da98e45))

## [0.57.1](https://github.com/okou-ai/okou/compare/android-v0.57.0...android-v0.57.1) (2026-11-25)


### Bug Fixes

* **android:** align workflow text fields with the shared form ([#50815](https://github.com/okou-ai/okou/issues/50815)) ([64421aa](https://github.com/okou-ai/okou/commit/64421aa7089aa8492362d980d555ebcfb287d742))
* **android:** render markdown before the first content layout ([#50875](https://github.com/okou-ai/okou/issues/50875)) ([0797b30](https://github.com/okou-ai/okou/commit/0797b30b16f1c2dbe0c07fd4fa17a4cd8dabd989))
* **android:** show update progress at download start ([#50869](https://github.com/okou-ai/okou/issues/50869)) ([725ad76](https://github.com/okou-ai/okou/commit/725ad7697459c4dbd43e378f1a9d0960942b0a1f))

## [0.57.0](https://github.com/okou-ai/okou/compare/android-v0.56.5...android-v0.57.0) (2026-11-25)


### Features

* **android:** choose model settings for new chat drafts ([#50818](https://github.com/okou-ai/okou/issues/50818)) ([209fadc](https://github.com/okou-ai/okou/commit/209fadcc132361e5f1b1e78a0ac5e52f620b4a13))


### Refactoring

* **android:** share native search field interactions ([#50823](https://github.com/okou-ai/okou/issues/50823)) ([a819f8f](https://github.com/okou-ai/okou/commit/a819f8feaa4e6cb1ef1b517af681f9ce2142dc2c))

## [0.56.5](https://github.com/okou-ai/okou/compare/android-v0.56.4...android-v0.56.5) (2026-11-25)


### Bug Fixes

* **ios:** return all connector oauth attempts to the app ([#50773](https://github.com/okou-ai/okou/issues/50773)) ([e683a88](https://github.com/okou-ai/okou/commit/e683a886bb389afe4671e7eca49a100d485137eb))

## [0.56.4](https://github.com/okou-ai/okou/compare/android-v0.56.3...android-v0.56.4) (2026-11-25)


### Bug Fixes

* **android:** refresh device-local artifact dates ([#50805](https://github.com/okou-ai/okou/issues/50805)) ([359605f](https://github.com/okou-ai/okou/commit/359605f55f80ca2ab0bf6cde70480c7146a6489c))

## [0.56.3](https://github.com/okou-ai/okou/compare/android-v0.56.2...android-v0.56.3) (2026-11-25)


### Bug Fixes

* **android:** align connector authorization choices with the shared form ([#50765](https://github.com/okou-ai/okou/issues/50765)) ([1aae76c](https://github.com/okou-ai/okou/commit/1aae76cd35ff59093e6d73234631b01fd345516b))
* **android:** align localized copy spacing ([#50768](https://github.com/okou-ai/okou/issues/50768)) ([6c7e7c7](https://github.com/okou-ai/okou/commit/6c7e7c774d29c63759fa85f6d4e7fa51f256ab86))
* **android:** preserve workspace search position after result removal ([#50804](https://github.com/okou-ai/okou/issues/50804)) ([3b39830](https://github.com/okou-ai/okou/commit/3b39830ce0f8288a619ea5a28ec4da502fedcc8f))
* **android:** publish chat and project renames on confirmation ([#50703](https://github.com/okou-ai/okou/issues/50703)) ([3865e7c](https://github.com/okou-ai/okou/commit/3865e7c4de336da4283ce38b69c27ade907df4ec))


### Refactoring

* **android:** share workspace tool directory rows ([#50769](https://github.com/okou-ai/okou/issues/50769)) ([c48b9ce](https://github.com/okou-ai/okou/commit/c48b9ce0cd578ddada967461a421bb0b45bae5a4))

## [0.56.2](https://github.com/okou-ai/okou/compare/android-v0.56.1...android-v0.56.2) (2026-11-25)


### Bug Fixes

* **android:** copy inline images safely from replies ([#50766](https://github.com/okou-ai/okou/issues/50766)) ([630309e](https://github.com/okou-ai/okou/commit/630309e8c9aaa2bc73be7ae9e58a34171e960e14))

## [0.56.1](https://github.com/okou-ai/okou/compare/android-v0.56.0...android-v0.56.1) (2026-11-25)


### Bug Fixes

* **android:** align artifact preview states and retry timing ([#50720](https://github.com/okou-ai/okou/issues/50720)) ([3c357d0](https://github.com/okou-ai/okou/commit/3c357d0408b73820553d34f8e1cbaae830558185))
* **android:** align workflow editor menus and discard confirmation ([#50719](https://github.com/okou-ai/okou/issues/50719)) ([7f899b2](https://github.com/okou-ai/okou/commit/7f899b23276053d1082da888b0fcf9e15b2a2f38))
* **android:** honor server retry delays in workspace search ([#50764](https://github.com/okou-ai/okou/issues/50764)) ([29a9f87](https://github.com/okou-ai/okou/commit/29a9f87d62aa235b3e828e791ec6690d27d9966f))


### Refactoring

* **android:** remove system connectivity gating ([#50724](https://github.com/okou-ai/okou/issues/50724)) ([ffe1a09](https://github.com/okou-ai/okou/commit/ffe1a09a86a4fe141e40b5ad7c1f0569fe797815))
* **android:** share bounded read retries ([#50716](https://github.com/okou-ai/okou/issues/50716)) ([664aaae](https://github.com/okou-ai/okou/commit/664aaae57687fd215f44f0ec600f3f4a9d63aa15))
* graduate suggestions into the shared morning brief ([#50746](https://github.com/okou-ai/okou/issues/50746)) ([3a296b9](https://github.com/okou-ai/okou/commit/3a296b93fe3b031bfcf1cb30ce189841198b825f))

## [0.56.0](https://github.com/okou-ai/okou/compare/android-v0.55.6...android-v0.56.0) (2026-11-25)


### Features

* **android:** render inline markdown images in conversations ([#50662](https://github.com/okou-ai/okou/issues/50662)) ([b67f49d](https://github.com/okou-ai/okou/commit/b67f49d764028747d763e795a72d9904328bcd8a))

## [0.55.6](https://github.com/okou-ai/okou/compare/android-v0.55.5...android-v0.55.6) (2026-11-25)


### Bug Fixes

* **android:** align connector read feedback and detail spacing ([#50707](https://github.com/okou-ai/okou/issues/50707)) ([f43d1fb](https://github.com/okou-ai/okou/commit/f43d1fb924dabb66bf0cde9244e666fd84c3703e))
* **android:** align personal instructions editor with settings design ([#50602](https://github.com/okou-ai/okou/issues/50602)) ([3a121ab](https://github.com/okou-ai/okou/commit/3a121ab6b4996e1ba4d2c42c6b57ff8b09daedd0))

## [0.55.5](https://github.com/okou-ai/okou/compare/android-v0.55.4...android-v0.55.5) (2026-11-25)


### Refactoring

* **android:** share content read feedback timing ([#50649](https://github.com/okou-ai/okou/issues/50649)) ([042ae13](https://github.com/okou-ai/okou/commit/042ae135dbe3c6d917f9e8ec828de4bf834f9c3b))

## [0.55.4](https://github.com/okou-ai/okou/compare/android-v0.55.3...android-v0.55.4) (2026-11-24)


### Bug Fixes

* **android:** align chat composer and conversation interactions ([#50624](https://github.com/okou-ai/okou/issues/50624)) ([5094420](https://github.com/okou-ai/okou/commit/509442037de291e3732c4ac6614d3a798504d090))

## [0.55.3](https://github.com/okou-ai/okou/compare/android-v0.55.2...android-v0.55.3) (2026-11-24)


### Bug Fixes

* **android:** align artifact catalog filters and keyboard navigation ([#50608](https://github.com/okou-ai/okou/issues/50608)) ([a969f0d](https://github.com/okou-ai/okou/commit/a969f0d2ec7227136192da380298f17b535d3058))
* **android:** align conversation artifact cards with the design ([#50633](https://github.com/okou-ai/okou/issues/50633)) ([723a7f0](https://github.com/okou-ai/okou/commit/723a7f06c48781bb2136eca5f3a75c586ec7b9da))
* **android:** align incompatible update recovery with design ([#50630](https://github.com/okou-ai/okou/issues/50630)) ([5aa1d8b](https://github.com/okou-ai/okou/commit/5aa1d8ba12cdb0646c38a8428a136c36fed0f191))
* **android:** align workflow automation editing with the design ([#50610](https://github.com/okou-ai/okou/issues/50610)) ([cefee69](https://github.com/okou-ai/okou/commit/cefee69cfcca1158eda91c74eb0fef7ce315a64c))
* **android:** keep connector detail and return focus stable ([#50609](https://github.com/okou-ai/okou/issues/50609)) ([47c825a](https://github.com/okou-ai/okou/commit/47c825ac8ab9f3191c0697b579ee1f0f695c0512))


### CI

* **android:** combine release and change detection ([#50639](https://github.com/okou-ai/okou/issues/50639)) ([9ee5820](https://github.com/okou-ai/okou/commit/9ee5820917c21c1dad79a3a3900a3675e48e9a75))


### Performance Improvements

* **android:** bound Room history read and write batches ([#50616](https://github.com/okou-ai/okou/issues/50616)) ([76b3262](https://github.com/okou-ai/okou/commit/76b32628b43ca1af37287805d3a34c202a4c9019))
* **android:** show cached chats before online verification ([#50589](https://github.com/okou-ai/okou/issues/50589)) ([126d0af](https://github.com/okou-ai/okou/commit/126d0af973036e3d17e09d03ad7b84e7cba00749))

## [0.55.2](https://github.com/okou-ai/okou/compare/android-v0.55.1...android-v0.55.2) (2026-11-24)


### Refactoring

* **android:** share rename form behavior ([#50603](https://github.com/okou-ai/okou/issues/50603)) ([40612fc](https://github.com/okou-ai/okou/commit/40612fc8e5b64953367f02b51a71531f352f7560))

## [0.55.1](https://github.com/okou-ai/okou/compare/android-v0.55.0...android-v0.55.1) (2026-11-24)


### Performance Improvements

* **android:** bound concurrent history snapshot warming ([#50548](https://github.com/okou-ai/okou/issues/50548)) ([07da7e2](https://github.com/okou-ai/okou/commit/07da7e260519967a920c94ac508559d3b165ea4c))

## [0.55.0](https://github.com/okou-ai/okou/compare/android-v0.54.1...android-v0.55.0) (2026-11-24)


### Features

* **android:** align conversation turn feedback with design ([#50540](https://github.com/okou-ai/okou/issues/50540)) ([f26d10e](https://github.com/okou-ai/okou/commit/f26d10e72b824696e9cf80000e7069a63afad08b))


### Bug Fixes

* **android:** align update progress and required entry spacing ([#50547](https://github.com/okou-ai/okou/issues/50547)) ([2534248](https://github.com/okou-ai/okou/commit/2534248c6d06e3b120d9ae91b9e1c71370800e6a))
* **android:** align workflow browsing and automation feedback ([#50539](https://github.com/okou-ai/okou/issues/50539)) ([440a72d](https://github.com/okou-ai/okou/commit/440a72da019c525427aa1220d96d5d137dc239d4))
* **android:** align workspace search fallback feedback ([#50567](https://github.com/okou-ai/okou/issues/50567)) ([48394a2](https://github.com/okou-ai/okou/commit/48394a2ca0df27d4b7d4f8c37dbc02ef7da87d01))
* **android:** restore settings after a failed sign-out ([#50565](https://github.com/okou-ai/okou/issues/50565)) ([3d00e6f](https://github.com/okou-ai/okou/commit/3d00e6ff63bbc8040aa35249739bcdb0bf700473))

## [0.54.1](https://github.com/okou-ai/okou/compare/android-v0.54.0...android-v0.54.1) (2026-11-24)


### Bug Fixes

* **android:** align artifact browsing and previews with design ([#50533](https://github.com/okou-ai/okou/issues/50533)) ([6648ee0](https://github.com/okou-ai/okou/commit/6648ee0ebee90280c3afefe05989a4605efef71a))
* **android:** prioritize chat list errors and preserve undo ([#50414](https://github.com/okou-ai/okou/issues/50414)) ([2a51cbd](https://github.com/okou-ai/okou/commit/2a51cbde0790a3be5a9681ea9a00d5407c0d4b65))
* **android:** retain the workspace chooser through activation ([#50536](https://github.com/okou-ai/okou/issues/50536)) ([cb42b2b](https://github.com/okou-ai/okou/commit/cb42b2b65b1dff0242f27d83fadc5c404069443a))
* **android:** show keyboard focus across workspace search ([#50526](https://github.com/okou-ai/okou/issues/50526)) ([eb70b20](https://github.com/okou-ai/okou/commit/eb70b20e003db58625e905daf0b9c859f5a60ee1))
* **android:** verify uncertain connector device authorization after expiry ([#50528](https://github.com/okou-ai/okou/issues/50528)) ([03cdd2c](https://github.com/okou-ai/okou/commit/03cdd2cb87ce32f0da678ff4b9d752c073a80c22))

## [0.54.0](https://github.com/okou-ai/okou/compare/android-v0.53.0...android-v0.54.0) (2026-11-24)


### Features

* **android:** add built-in tool settings ([#50488](https://github.com/okou-ai/okou/issues/50488)) ([728e8ce](https://github.com/okou-ai/okou/commit/728e8ce2a260f26018932353d8c973a552fd6cf7))


### Bug Fixes

* **android:** use neutral focus color in confirmation dialogs ([#50515](https://github.com/okou-ai/okou/issues/50515)) ([115553a](https://github.com/okou-ai/okou/commit/115553a8f2105d71357e178a585992814a1b574e))

## [0.53.0](https://github.com/okou-ai/okou/compare/android-v0.52.2...android-v0.53.0) (2026-11-24)


### Features

* **native:** manage member-wide connector account access ([#50496](https://github.com/okou-ai/okou/issues/50496)) ([eda9b10](https://github.com/okou-ai/okou/commit/eda9b103a4531c6c23058180f5150e11a3a986e9))

## [0.52.2](https://github.com/okou-ai/okou/compare/android-v0.52.1...android-v0.52.2) (2026-11-24)


### Bug Fixes

* **android:** align shared settings saves with native feedback ([#50454](https://github.com/okou-ai/okou/issues/50454)) ([90d2208](https://github.com/okou-ai/okou/commit/90d2208b245fefaea7da9abb9d7ae9272e6a9ff2))
* **android:** align sign-in and entry screens with design ([#50425](https://github.com/okou-ai/okou/issues/50425)) ([0ae68ee](https://github.com/okou-ai/okou/commit/0ae68eebe6c97b8f269536fcdd5bd4b046c449b6))
* **android:** align stop and queue operation states ([#50482](https://github.com/okou-ai/okou/issues/50482)) ([d200d87](https://github.com/okou-ai/okou/commit/d200d87a95324561feadd6ff91846a374625b2ce))
* **android:** align workspace search presentation with design ([#50419](https://github.com/okou-ai/okou/issues/50419)) ([dc8a902](https://github.com/okou-ai/okou/commit/dc8a902b0c14fe21497527ffc84dcf8ec6c13a0d))

## [0.52.1](https://github.com/okou-ai/okou/compare/android-v0.52.0...android-v0.52.1) (2026-11-24)


### Refactoring

* remove artifact name sorting ([#50428](https://github.com/okou-ai/okou/issues/50428)) ([b693ca5](https://github.com/okou-ai/okou/commit/b693ca5a66bab74587596b3971fdc5163f47f352))

## [0.52.0](https://github.com/okou-ai/okou/compare/android-v0.51.1...android-v0.52.0) (2026-11-24)


### Features

* **android:** show chat origins and automation workflows in chat resources ([#50381](https://github.com/okou-ai/okou/issues/50381)) ([1785657](https://github.com/okou-ai/okou/commit/17856573d60e67c60d6c870dcdc5f556c8ae5556))


### Bug Fixes

* **android:** show workflow editor save progress in place ([#50360](https://github.com/okou-ai/okou/issues/50360)) ([23fe8cc](https://github.com/okou-ai/okou/commit/23fe8ccfb1c372236bfd3237c4b55f06099be4b0))

## [0.51.1](https://github.com/okou-ai/okou/compare/android-v0.51.0...android-v0.51.1) (2026-11-24)


### Bug Fixes

* **android:** align failed-reply recovery feedback with design ([#50278](https://github.com/okou-ai/okou/issues/50278)) ([aba089d](https://github.com/okou-ai/okou/commit/aba089dae5167ce904fbc13ccb9dc858f5ee827b))
* **android:** align update recovery and compact details ([#50309](https://github.com/okou-ai/okou/issues/50309)) ([34bcce9](https://github.com/okou-ai/okou/commit/34bcce92b6d0023509e6c4908704935834776590))
* **android:** explain terminal connector device authorization results ([#50364](https://github.com/okou-ai/okou/issues/50364)) ([d1b812f](https://github.com/okou-ai/okou/commit/d1b812f636d36d67a8a29e7fc7b6a8b811a95c2b))
* **android:** sort and expand settings time zones ([#50270](https://github.com/okou-ai/okou/issues/50270)) ([cca10d5](https://github.com/okou-ai/okou/commit/cca10d52d8117b084b2f4903cac9185c95758619))

## [0.51.0](https://github.com/okou-ai/okou/compare/android-v0.50.1...android-v0.51.0) (2026-11-24)


### Features

* **artifacts:** add a gated searchable artifact library list ([#50231](https://github.com/okou-ai/okou/issues/50231)) ([2bb0a85](https://github.com/okou-ai/okou/commit/2bb0a8587efb1fc8abc513dba5c50109406226ed))


### Bug Fixes

* **android:** keep search progress below the filters ([#50362](https://github.com/okou-ai/okou/issues/50362)) ([d2a61ad](https://github.com/okou-ai/okou/commit/d2a61ad3b2f7d8a241ee089124639ce608e0ecd6))
* **android:** retain chat list rename forms through save failures ([#50302](https://github.com/okou-ai/okou/issues/50302)) ([6958795](https://github.com/okou-ai/okou/commit/695879543d6a6b057a784ef392c32dc03a1af516))

## [0.50.1](https://github.com/okou-ai/okou/compare/android-v0.50.0...android-v0.50.1) (2026-11-24)


### Bug Fixes

* **android:** align chat stop and queue action feedback ([#50289](https://github.com/okou-ai/okou/issues/50289)) ([adc0cde](https://github.com/okou-ai/okou/commit/adc0cded8702f8988b1187645d85a90c8ef11d22))
* **android:** preserve workflow action focus on return ([#50296](https://github.com/okou-ai/okou/issues/50296)) ([3a97bb5](https://github.com/okou-ai/okou/commit/3a97bb50e4b4249086ad36880c334de50f410f52))

## [0.50.0](https://github.com/okou-ai/okou/compare/android-v0.49.0...android-v0.50.0) (2026-11-23)


### Features

* archive projects in the chat sidebar ([#50306](https://github.com/okou-ai/okou/issues/50306)) ([8c9f004](https://github.com/okou-ai/okou/commit/8c9f004ac760d95f3f47e8e3fa83d470f2de28c6))

## [0.49.0](https://github.com/okou-ai/okou/compare/android-v0.48.0...android-v0.49.0) (2026-11-23)


### Features

* **android:** align chat list drafts and wide bottom controls ([#50256](https://github.com/okou-ai/okou/issues/50256)) ([18ad5d8](https://github.com/okou-ai/okou/commit/18ad5d8f9ba476b1a0400caef510d680929169f0))
* **android:** show related chats in chat resources ([#50295](https://github.com/okou-ai/okou/issues/50295)) ([e9c83d6](https://github.com/okou-ai/okou/commit/e9c83d638bb2e6a56f2c915ba0128017971f0f1f))


### Bug Fixes

* **android:** align workspace entry focus and checking feedback ([#50284](https://github.com/okou-ai/okou/issues/50284)) ([d3ced66](https://github.com/okou-ai/okou/commit/d3ced66b762fc4fad17b1cf8acec6fa75c1d722d))
* **android:** keep connector authorization visible while reading methods ([#50294](https://github.com/okou-ai/okou/issues/50294)) ([9012db7](https://github.com/okou-ai/okou/commit/9012db748061a8b1b78ad761d162f4da18fd3ee7))
* **android:** keep workspace search feedback and position stable ([#50275](https://github.com/okou-ai/okou/issues/50275)) ([34f4b5a](https://github.com/okou-ai/okou/commit/34f4b5a25731e43c17fcccfde5acde63d87561ac))
* **android:** recover workflow results in workspace search ([#50297](https://github.com/okou-ai/okou/issues/50297)) ([705de92](https://github.com/okou-ai/okou/commit/705de92bea2ba697f3fe396bd4fa757d8b6e56f0))

## [0.48.0](https://github.com/okou-ai/okou/compare/android-v0.47.0...android-v0.48.0) (2026-11-23)


### Features

* **android:** add email updates and settings action feedback ([#50223](https://github.com/okou-ai/okou/issues/50223)) ([6faf333](https://github.com/okou-ai/okou/commit/6faf333aee0332d6d744ecfcf6f91c4ba79879c1))
* **android:** add native proactive service settings ([#50250](https://github.com/okou-ai/okou/issues/50250)) ([3c962bf](https://github.com/okou-ai/okou/commit/3c962bf9bfb8ed665f9904436eb1cebd6c49449d))
* **android:** choose connector accounts in chat options ([#50186](https://github.com/okou-ai/okou/issues/50186)) ([d70f73e](https://github.com/okou-ai/okou/commit/d70f73ea643c4fcf04e8d37936398d52a1c4bbd4))
* persist presentation output format preference ([#50220](https://github.com/okou-ai/okou/issues/50220)) ([c68256f](https://github.com/okou-ai/okou/commit/c68256fc724a9baf19e9c099443be1a2d86b513e))


### Bug Fixes

* **android:** align artifact catalog reads with design ([#50240](https://github.com/okou-ai/okou/issues/50240)) ([680e490](https://github.com/okou-ai/okou/commit/680e490d2ad89b003a60f2037e43670bbdb2ddd7))
* **android:** align chat list read recovery with design ([#50197](https://github.com/okou-ai/okou/issues/50197)) ([ef44d56](https://github.com/okou-ai/okou/commit/ef44d562f065b85ae8c920d7193fd4547734fa90))
* **android:** align connector first-read feedback ([#50261](https://github.com/okou-ai/okou/issues/50261)) ([73a9249](https://github.com/okou-ai/okou/commit/73a924951b736fed27ed53d7c00ede1968e5eea8))
* **android:** align sign-in and workspace entry recovery ([#50205](https://github.com/okou-ai/okou/issues/50205)) ([9905594](https://github.com/okou-ai/okou/commit/9905594ef6b46ce92e4aa8ebb8d3085369cd08db))
* **android:** allow member automations on shared workflows ([#50217](https://github.com/okou-ai/okou/issues/50217)) ([19966e8](https://github.com/okou-ai/okou/commit/19966e8a567f0895ddb1b680db11ffd39e926bd3))
* **android:** recover conversation history reads automatically ([#50209](https://github.com/okou-ai/okou/issues/50209)) ([cf2caac](https://github.com/okou-ai/okou/commit/cf2caacaf435779acf001f9ed0585d42b50e049a))
* **android:** recover workspace reads after transient authentication failures ([#50230](https://github.com/okou-ai/okou/issues/50230)) ([f4763bd](https://github.com/okou-ai/okou/commit/f4763bd47f5e667833b5b8b9b28d1e674fee3ad6))
* **android:** restore focus when workflow editors close ([#50257](https://github.com/okou-ai/okou/issues/50257)) ([5ee5ef5](https://github.com/okou-ai/okou/commit/5ee5ef569f298a632dad54cb1b0ea4d664d3726e))

## [0.47.0](https://github.com/okou-ai/okou/compare/android-v0.46.1...android-v0.47.0) (2026-11-23)


### Features

* **ios:** authorize strava through the installed app ([#50179](https://github.com/okou-ai/okou/issues/50179)) ([f98f068](https://github.com/okou-ai/okou/commit/f98f068841b3ff663dcf250beec2267eb5122f66))


### CI

* **android:** shard debug jvm and instrumentation tests ([#50162](https://github.com/okou-ai/okou/issues/50162)) ([95dc02a](https://github.com/okou-ai/okou/commit/95dc02a356934d3be75ec6003e68e36962bbaf2a))

## [0.46.1](https://github.com/okou-ai/okou/compare/android-v0.46.0...android-v0.46.1) (2026-11-23)


### Bug Fixes

* **android:** align app update surfaces with design ([#50122](https://github.com/okou-ai/okou/issues/50122)) ([99f3aa6](https://github.com/okou-ai/okou/commit/99f3aa67b5ba71a324b309efeb18d4313d5dd481))
* **android:** restore cached model accounts and credit balances ([#50120](https://github.com/okou-ai/okou/issues/50120)) ([b17e345](https://github.com/okou-ai/okou/commit/b17e34584e42a8908be4b202287f7fe3a28953be))

## [0.46.0](https://github.com/okou-ai/okou/compare/android-v0.45.2...android-v0.46.0) (2026-11-23)


### Features

* **app:** track suggestion card impressions and outcomes ([#50158](https://github.com/okou-ai/okou/issues/50158)) ([d1cb596](https://github.com/okou-ai/okou/commit/d1cb596036a9079ecd0eb85072610dce8d44f5fb))


### Bug Fixes

* **android:** recover chat list actions and reorder filtered pins ([#50016](https://github.com/okou-ai/okou/issues/50016)) ([0a63489](https://github.com/okou-ai/okou/commit/0a634898d4de6ff3c8f27de5506c1ccd447bd6d1))

## [0.45.2](https://github.com/okou-ai/okou/compare/android-v0.45.1...android-v0.45.2) (2026-11-23)


### CI

* **android:** parallelize debug jvm tests in build-test ([#50134](https://github.com/okou-ai/okou/issues/50134)) ([bacc350](https://github.com/okou-ai/okou/commit/bacc350f7f4bbc1f51ef8dc27073af0035973020))

## [0.45.1](https://github.com/okou-ai/okou/compare/android-v0.45.0...android-v0.45.1) (2026-11-23)


### Bug Fixes

* **android:** align conversation delivery and transcript with design ([#50053](https://github.com/okou-ai/okou/issues/50053)) ([a0ab8aa](https://github.com/okou-ai/okou/commit/a0ab8aaca80561aeeeb43f9a94b2eebe4856beeb))
* **android:** render catalog brand icons in connectors ([#50095](https://github.com/okou-ai/okou/issues/50095)) ([5541a99](https://github.com/okou-ai/okou/commit/5541a99fad08b32eabb253a6d2c65e921a2462c1))

## [0.45.0](https://github.com/okou-ai/okou/compare/android-v0.44.1...android-v0.45.0) (2026-11-23)


### Features

* **android:** show confirmed workflow run history ([#50055](https://github.com/okou-ai/okou/issues/50055)) ([a3c5ba1](https://github.com/okou-ai/okou/commit/a3c5ba1c7418d75fa58233da2de637380ed1814b))

## [0.44.1](https://github.com/okou-ai/okou/compare/android-v0.44.0...android-v0.44.1) (2026-11-23)


### Bug Fixes

* persist for you cover preferences in the database ([#50069](https://github.com/okou-ai/okou/issues/50069)) ([c912fc4](https://github.com/okou-ai/okou/commit/c912fc4a238d3558ab6053520a1a63caf02f0ed5))

## [0.44.0](https://github.com/okou-ai/okou/compare/android-v0.43.0...android-v0.44.0) (2026-11-23)


### Features

* **android:** add the default model settings panel ([#49942](https://github.com/okou-ai/okou/issues/49942)) ([70f788d](https://github.com/okou-ai/okou/commit/70f788db14707e4db546a03614c557d4d0d82d9b))
* **android:** add the native workflows destination ([#49862](https://github.com/okou-ai/okou/issues/49862)) ([5573408](https://github.com/okou-ai/okou/commit/55734083ff40c46c586f5330dd9fbfda7820a1ce))
* **android:** align the session entry ui with design ([#50015](https://github.com/okou-ai/okou/issues/50015)) ([6b5c890](https://github.com/okou-ai/okou/commit/6b5c890ad05834301cfb77f929f55675aff0d1ac))
* **android:** keep connector directory reads fresh across visits ([#50013](https://github.com/okou-ai/okou/issues/50013)) ([1dd26be](https://github.com/okou-ai/okou/commit/1dd26be83ebf1ea6a30d88dbae3ced6512f4b555))


### Bug Fixes

* **android:** align artifact preview recovery and catalog return with design ([#50014](https://github.com/okou-ai/okou/issues/50014)) ([b545afb](https://github.com/okou-ai/okou/commit/b545afbbd3966fe6814389dc04255a4ee3c838a1))

## [0.43.0](https://github.com/okou-ai/okou/compare/android-v0.42.0...android-v0.43.0) (2026-11-22)


### Features

* **android:** find messages within a conversation ([#49937](https://github.com/okou-ai/okou/issues/49937)) ([00d7c77](https://github.com/okou-ai/okou/commit/00d7c77e2d035c2b339a13df536c75477cce7ddf))
* **android:** move chats and delete projects ([#49950](https://github.com/okou-ai/okou/issues/49950)) ([066d2a8](https://github.com/okou-ai/okou/commit/066d2a8581d58f57425abb367194c34861b183cc))
* **android:** open inline conversation message links ([#50001](https://github.com/okou-ai/okou/issues/50001)) ([93203dc](https://github.com/okou-ai/okou/commit/93203dc4eb74c0dba9b577dfcbebac7efc80f936))


### Bug Fixes

* **android:** align connector account actions and panels with design ([#50004](https://github.com/okou-ai/okou/issues/50004)) ([eb09e80](https://github.com/okou-ai/okou/commit/eb09e80a6a6748199fc28b6c46ef839146d5fa20))
* **android:** evict idle tls sockets off the main thread ([#49974](https://github.com/okou-ai/okou/issues/49974)) ([de8458d](https://github.com/okou-ai/okou/commit/de8458d8da114dff694c5d9a973530d05ead9515))
* **android:** keep chat list actions available through connection changes ([#50002](https://github.com/okou-ai/okou/issues/50002)) ([222b1fa](https://github.com/okou-ai/okou/commit/222b1fa3010f6e911e36861324416580b958ce9c))
* **android:** preserve artifact website previews across reconnect ([#50000](https://github.com/okou-ai/okou/issues/50000)) ([f7ef903](https://github.com/okou-ai/okou/commit/f7ef903399fa0cf0d45a65ff6f841ab3240eb6f5))
* **android:** retain connector filter and service results ([#49969](https://github.com/okou-ai/okou/issues/49969)) ([02b0605](https://github.com/okou-ai/okou/commit/02b0605d15256b92f093dfae69703af089b84d57))


### Refactoring

* **android:** narrow workspace chat state observation ([#49999](https://github.com/okou-ai/okou/issues/49999)) ([0012f32](https://github.com/okou-ai/okou/commit/0012f32ec508cd52ac3869f05204a36d0c573478))
* **android:** separate chat list grouping from indicators ([#49987](https://github.com/okou-ai/okou/issues/49987)) ([541a590](https://github.com/okou-ai/okou/commit/541a590e84bae28ae6348a2ef641dbd52460106e))

## [0.42.0](https://github.com/okou-ai/okou/compare/android-v0.41.0...android-v0.42.0) (2026-11-22)


### Features

* **android:** add native connector discovery and account management ([#49863](https://github.com/okou-ai/okou/issues/49863)) ([bbfdbac](https://github.com/okou-ai/okou/commit/bbfdbacd8edeec26260da989aa2d7cdc8e377d62))
* **android:** open inline chat artifacts in the shared preview ([#49954](https://github.com/okou-ai/okou/issues/49954)) ([5fd1984](https://github.com/okou-ai/okou/commit/5fd1984c7314f246f7b4812ba8f2dfdd85a16f3a))

## [0.41.0](https://github.com/okou-ai/okou/compare/android-v0.40.0...android-v0.41.0) (2026-11-22)


### Features

* **android:** browse artifacts from chat resources ([#49935](https://github.com/okou-ai/okou/issues/49935)) ([244c925](https://github.com/okou-ai/okou/commit/244c9252789612154376d21ddc924fad62830583))


### Bug Fixes

* **android:** align chat list motion and swipe feedback ([#49945](https://github.com/okou-ai/okou/issues/49945)) ([415b071](https://github.com/okou-ai/okou/commit/415b071c0d59356639a0e09f43b0fa55095d2946))


### Refactoring

* retire product agent apis and use member identity across clients ([#49933](https://github.com/okou-ai/okou/issues/49933)) ([1d34e53](https://github.com/okou-ai/okou/commit/1d34e531ac4c777d6df6236fa871ce6c834f5380))


### Performance Improvements

* **android:** show cached chats and workspace controls on startup ([#49919](https://github.com/okou-ai/okou/issues/49919)) ([8eb9218](https://github.com/okou-ai/okou/commit/8eb921883ef475dbafa346a862a9be220d7de83d))

## [0.40.0](https://github.com/okou-ai/okou/compare/android-v0.39.1...android-v0.40.0) (2026-11-22)


### Features

* **android:** refine the native conversation page ([#49852](https://github.com/okou-ai/okou/issues/49852)) ([60ea18b](https://github.com/okou-ai/okou/commit/60ea18b1a30ea38fe2e36bd12414170e62c775ff))
* **android:** show model accounts and credit balances in settings ([#49923](https://github.com/okou-ai/okou/issues/49923)) ([2c95e9e](https://github.com/okou-ai/okou/commit/2c95e9e4b8d7a6cc6f0355c5406779465e7de022))


### Bug Fixes

* **android:** align the chat list and retire the update banner ([#49912](https://github.com/okou-ai/okou/issues/49912)) ([a319487](https://github.com/okou-ai/okou/commit/a319487fed13bc07af0c364d0a9522467ccf00da))

## [0.39.1](https://github.com/okou-ai/okou/compare/android-v0.39.0...android-v0.39.1) (2026-11-22)


### Refactoring

* **app:** retire agent prerequisites from member flows ([#49854](https://github.com/okou-ai/okou/issues/49854)) ([6eea61b](https://github.com/okou-ai/okou/commit/6eea61b4a4f5c7a3e218bb027b148f10c3d4dab7))

## [0.39.0](https://github.com/okou-ai/okou/compare/android-v0.38.0...android-v0.39.0) (2026-11-22)


### Features

* **android:** add the workspace artifacts page ([#49864](https://github.com/okou-ai/okou/issues/49864)) ([f0babd9](https://github.com/okou-ai/okou/commit/f0babd9a5b1d68fef595bc35d6944d3859e593f2))
* **android:** show workspace tool entries on the chat list ([#49853](https://github.com/okou-ai/okou/issues/49853)) ([61df008](https://github.com/okou-ai/okou/commit/61df0086f9d6672a46ceaf8ec4eaaf70009a7fdf))

## [0.38.0](https://github.com/okou-ai/okou/compare/android-v0.37.2...android-v0.38.0) (2026-11-22)


### Features

* transcribe ordered voice messages with model credits ([#49901](https://github.com/okou-ai/okou/issues/49901)) ([10fb53e](https://github.com/okou-ai/okou/commit/10fb53e67b9ae25cd3bcb984e8dca394e5682a94))

## [0.37.2](https://github.com/okou-ai/okou/compare/android-v0.37.1...android-v0.37.2) (2026-11-22)


### Bug Fixes

* **mobile:** prepare native clients for workspace apis without agent ids ([#49889](https://github.com/okou-ai/okou/issues/49889)) ([acc1180](https://github.com/okou-ai/okou/commit/acc1180b74cc5401511eb40984f43c64db058604))

## [0.37.1](https://github.com/okou-ai/okou/compare/android-v0.37.0...android-v0.37.1) (2026-11-21)


### Refactoring

* contract legacy chat and run agent storage ([#49868](https://github.com/okou-ai/okou/issues/49868)) ([abbf9f8](https://github.com/okou-ai/okou/commit/abbf9f8e672ac56f0f98583cfb0b536e9225e905))

## [0.37.0](https://github.com/okou-ai/okou/compare/android-v0.36.0...android-v0.37.0) (2026-11-21)


### Features

* **android:** align settings and timezone with the current design ([#49845](https://github.com/okou-ai/okou/issues/49845)) ([a472a5f](https://github.com/okou-ai/okou/commit/a472a5f0d17863f992676460b8df1a762f2d008d))


### Bug Fixes

* **android:** align chat-list undo with adaptive snackbar design ([#49819](https://github.com/okou-ai/okou/issues/49819)) ([3332b52](https://github.com/okou-ai/okou/commit/3332b52f8303e4ba0705300ac6bed8cccfbc1d67))
* **android:** roll back rejected chat row edits immediately ([#49835](https://github.com/okou-ai/okou/issues/49835)) ([546fbd2](https://github.com/okou-ai/okou/commit/546fbd26756051d2df68141c76dff2b476e3415b))
* **android:** stabilize project grouping during cached chat startup ([#49836](https://github.com/okou-ai/okou/issues/49836)) ([f5c1347](https://github.com/okou-ai/okou/commit/f5c13476bc33d151d12bdc86756dadfc1927fced))


### Refactoring

* stage retirement of chat and run agent identity ([#49839](https://github.com/okou-ai/okou/issues/49839)) ([01b34f9](https://github.com/okou-ai/okou/commit/01b34f9b9f1a7f7b117739ad834931fa646a1b8b))


### Performance Improvements

* **android:** reuse confirmed project rows on unchanged sync ([#49833](https://github.com/okou-ai/okou/issues/49833)) ([61d27f3](https://github.com/okou-ai/okou/commit/61d27f33c1d7f29cc9996a3c485d8bffc52890c0))

## [0.36.0](https://github.com/okou-ai/okou/compare/android-v0.35.0...android-v0.36.0) (2026-11-21)


### Features

* **android:** render markdown while editing personal instructions ([#49812](https://github.com/okou-ai/okou/issues/49812)) ([cb9be3d](https://github.com/okou-ai/okou/commit/cb9be3d9d81b7abeeed5bcbc79aed452babad37c))


### Bug Fixes

* **android:** reconcile late project rename receipts ([#49834](https://github.com/okou-ai/okou/issues/49834)) ([9dc177f](https://github.com/okou-ai/okou/commit/9dc177f8d225420baf21aa15c75871a0febd74b9))


### Performance Improvements

* **android:** reuse confirmed conversation transcripts on refresh ([#49840](https://github.com/okou-ai/okou/issues/49840)) ([bb23642](https://github.com/okou-ai/okou/commit/bb236428139a326d4587635fc4bcf789833dc008))

## [0.35.0](https://github.com/okou-ai/okou/compare/android-v0.34.2...android-v0.35.0) (2026-11-21)


### Features

* **android:** align settings and its destinations with the native design ([#49795](https://github.com/okou-ai/okou/issues/49795)) ([ff5de73](https://github.com/okou-ai/okou/commit/ff5de730df469cabb23a8fc8dbe45820001b3ef8))


### Bug Fixes

* **android:** align workspace search and stabilize chat loading ([#49787](https://github.com/okou-ai/okou/issues/49787)) ([2b7974e](https://github.com/okou-ai/okou/commit/2b7974e8f7cc4d1ef51aac89751c0b40db6d7a69))
* **android:** prevent running wave rendering from crashing ([#49786](https://github.com/okou-ai/okou/issues/49786)) ([c50f99e](https://github.com/okou-ai/okou/commit/c50f99eba8af31b92d2a9fb4f9c6f6878ef12074))
* **android:** separate project rename rejection from uncertain delivery ([#49800](https://github.com/okou-ai/okou/issues/49800)) ([4d85fd7](https://github.com/okou-ai/okou/commit/4d85fd731287dd7af3c66a414ea09ce86bda7d73))


### Performance Improvements

* **android:** enable project rename from authorized cached rows ([#49814](https://github.com/okou-ai/okou/issues/49814)) ([bec9852](https://github.com/okou-ai/okou/commit/bec9852c506227cccf7a80a1aed45f067b90f9c9))
* **android:** prepare chat cache during workspace authorization ([#49791](https://github.com/okou-ai/okou/issues/49791)) ([acd9ba1](https://github.com/okou-ai/okou/commit/acd9ba151c5d44dc9105697a8298ab9ede6a884a))

## [0.34.2](https://github.com/okou-ai/okou/compare/android-v0.34.1...android-v0.34.2) (2026-11-21)


### Bug Fixes

* **android:** align chat list context menus with v118 ([#49771](https://github.com/okou-ai/okou/issues/49771)) ([ea37fd8](https://github.com/okou-ai/okou/commit/ea37fd80936220810b3926476893545f5c497493))

## [0.34.1](https://github.com/okou-ai/okou/compare/android-v0.34.0...android-v0.34.1) (2026-11-21)


### Performance Improvements

* **android:** reuse decoded history after a verified cache write ([#49763](https://github.com/okou-ai/okou/issues/49763)) ([5263acf](https://github.com/okou-ai/okou/commit/5263acfe5142e7b0e584d1eaa7587b73a2540f79))

## [0.34.0](https://github.com/okou-ai/okou/compare/android-v0.33.0...android-v0.34.0) (2026-11-21)


### Features

* **android:** align project row menu and rename ([#49761](https://github.com/okou-ai/okou/issues/49761)) ([5d48523](https://github.com/okou-ai/okou/commit/5d48523b748c6d0ab74b796305fbf00e3469d8ba))


### Bug Fixes

* **android:** align chat header and update screens with v114 ([#49750](https://github.com/okou-ai/okou/issues/49750)) ([a3a6703](https://github.com/okou-ai/okou/commit/a3a67031782a38ee6ffe39162ffcfc92a55907ef))
* **android:** keep running chats eligible for unread actions ([#49730](https://github.com/okou-ai/okou/issues/49730)) ([7a9953d](https://github.com/okou-ai/okou/commit/7a9953ddcdf16cbea66610f40345d504d6f5c058))
* **android:** retain send-order reconciliation through retries ([#49737](https://github.com/okou-ai/okou/issues/49737)) ([fe8cd30](https://github.com/okou-ai/okou/commit/fe8cd30ff5d23394a1597fb8cd3e34f53ebf8876))
* **android:** verify accepted chat previews after snapshot replacement ([#49744](https://github.com/okou-ai/okou/issues/49744)) ([a7bef1e](https://github.com/okou-ai/okou/commit/a7bef1e4c8bdf68795900760a12e854c08f1cd25))


### Refactoring

* **android:** centralize optimistic chat list reconciliation ([#49752](https://github.com/okou-ai/okou/issues/49752)) ([dfc9248](https://github.com/okou-ai/okou/commit/dfc924814c2e30a1f8f75194d59a99c0edbb20d6))


### Performance Improvements

* **android:** restore pending chat rows before preferences ([#49758](https://github.com/okou-ai/okou/issues/49758)) ([157d8fa](https://github.com/okou-ai/okou/commit/157d8fafdaf00ac9d1b6dca23653267e4846cd87))
* **android:** show outgoing messages in the chat list immediately ([#49696](https://github.com/okou-ai/okou/issues/49696)) ([f2d593c](https://github.com/okou-ai/okou/commit/f2d593cfa2853ff2dcafe6cc9199f5cd30314123))

## [0.33.0](https://github.com/okou-ai/okou/compare/android-v0.32.6...android-v0.33.0) (2026-11-21)


### Features

* **android:** add chat row swipe actions and undo ([#49625](https://github.com/okou-ai/okou/issues/49625)) ([19e7a95](https://github.com/okou-ai/okou/commit/19e7a955d1aeb05c5e815e83968d20b2bc74bcdb))
* **android:** add optimistic chat deletion ([#49706](https://github.com/okou-ai/okou/issues/49706)) ([4375917](https://github.com/okou-ai/okou/commit/437591750cd6953237fd3e7e185ce92aefeda8ac))


### Bug Fixes

* **android:** persist project expansion locally ([#49667](https://github.com/okou-ai/okou/issues/49667)) ([0895f10](https://github.com/okou-ai/okou/commit/0895f10a66429d203d74cb13b340e78f93a05d98))
* **ci:** bound android release stack retracing ([#49688](https://github.com/okou-ai/okou/issues/49688)) ([aabe345](https://github.com/okou-ai/okou/commit/aabe345c74d1344a89265367d4e96e1c4de7f296))


### Performance Improvements

* **android:** scope shallow dependency verification ([#49710](https://github.com/okou-ai/okou/issues/49710)) ([98e7b30](https://github.com/okou-ai/okou/commit/98e7b306c78fcc7f25b8b87e0cb79c4db29750e8))

## [0.32.6](https://github.com/okou-ai/okou/compare/android-v0.32.5...android-v0.32.6) (2026-11-21)


### Bug Fixes

* **android:** remove retired chat strings ([#49678](https://github.com/okou-ai/okou/issues/49678)) ([fdc44df](https://github.com/okou-ai/okou/commit/fdc44dfbf5b6d2edc02dcb7c226d88a3b89d9129))


### Refactoring

* **api:** require member-scoped chat clients for run creation ([#49676](https://github.com/okou-ai/okou/issues/49676)) ([8ed0c41](https://github.com/okou-ai/okou/commit/8ed0c41efd72d4ddd1f6b9cc6c90d103cde20eb3))


### Performance Improvements

* **android:** restore recent unread status at startup ([#49627](https://github.com/okou-ai/okou/issues/49627)) ([84d9dec](https://github.com/okou-ai/okou/commit/84d9decad596d74879c85e6c4c29fef23bdc12a0))

## [0.32.5](https://github.com/okou-ai/okou/compare/android-v0.32.4...android-v0.32.5) (2026-11-21)


### Bug Fixes

* **android:** fail ci on android lint warnings ([#49614](https://github.com/okou-ai/okou/issues/49614)) ([87e6e01](https://github.com/okou-ai/okou/commit/87e6e012a2ffabc0c5d80b152d5aed8ee7512a84))
* **android:** make dependency version lint advisory ([#49674](https://github.com/okou-ai/okou/issues/49674)) ([2341cc7](https://github.com/okou-ai/okou/commit/2341cc7a27769dede049aec6719e9acd8a8cb92a))


### Refactoring

* scope chat run admission to workspace members ([#49637](https://github.com/okou-ai/okou/issues/49637)) ([30c1941](https://github.com/okou-ai/okou/commit/30c1941239202722c767b1190718538a5c0b00d3))

## [0.32.4](https://github.com/okou-ai/okou/compare/android-v0.32.3...android-v0.32.4) (2026-11-20)


### Refactoring

* **android:** remove retired my okou bindings and cache flag ([#49604](https://github.com/okou-ai/okou/issues/49604)) ([0b2fbcd](https://github.com/okou-ai/okou/commit/0b2fbcde7569cad9b28111cb16bc55644fa59166))

## [0.32.3](https://github.com/okou-ai/okou/compare/android-v0.32.2...android-v0.32.3) (2026-11-20)


### Bug Fixes

* **android:** align the chat composer with the current design ([#49523](https://github.com/okou-ai/okou/issues/49523)) ([4d5c851](https://github.com/okou-ai/okou/commit/4d5c851335ef8a3a9bc4569160519c8863f8d783))


### Refactoring

* **android:** retire my okou feature gates ([#49579](https://github.com/okou-ai/okou/issues/49579)) ([579c32b](https://github.com/okou-ai/okou/commit/579c32b870d1ec776fe619b04210b07825f9c051))


### Performance Improvements

* **android:** reduce chat list replay and readback ([#49554](https://github.com/okou-ai/okou/issues/49554)) ([f30bc38](https://github.com/okou-ai/okou/commit/f30bc38d0801794f4e34a96e0cc0f96c0547fa0e))
* **android:** show pending chat messages immediately ([#49585](https://github.com/okou-ai/okou/issues/49585)) ([af686ab](https://github.com/okou-ai/okou/commit/af686ab2ac5ba89b84a5b82c47cce1c8fab3eee3))
* **android:** update chat read state optimistically ([#49565](https://github.com/okou-ai/okou/issues/49565)) ([a69066c](https://github.com/okou-ai/okou/commit/a69066cefdc34f71bb935619b1a7816dea5b7905))

## [0.32.2](https://github.com/okou-ai/okou/compare/android-v0.32.1...android-v0.32.2) (2026-11-20)


### Bug Fixes

* **android:** match theme swatches to the design ([#49532](https://github.com/okou-ai/okou/issues/49532)) ([663342e](https://github.com/okou-ai/okou/commit/663342e61b05f2969cf4712c54cc55dd86ce1537))


### Performance Improvements

* **android:** coalesce chat list catch-up requests ([#49538](https://github.com/okou-ai/okou/issues/49538)) ([fa8e56c](https://github.com/okou-ai/okou/commit/fa8e56c291927a0576a024eaab69e811c96f2fd2))

## [0.32.1](https://github.com/okou-ai/okou/compare/android-v0.32.0...android-v0.32.1) (2026-11-20)


### Performance Improvements

* **android:** enable authorized chat interactions during startup ([#49514](https://github.com/okou-ai/okou/issues/49514)) ([f94cfdb](https://github.com/okou-ai/okou/commit/f94cfdb0f906c69b6132c0dcb0de43b4e48da7f0))

## [0.32.0](https://github.com/okou-ai/okou/compare/android-v0.31.1...android-v0.32.0) (2026-11-20)


### Features

* **android:** refine the app update flow ([#49373](https://github.com/okou-ai/okou/issues/49373)) ([7e5f217](https://github.com/okou-ai/okou/commit/7e5f217014ed860f896cc0c52c2057d0f133a6ec))


### Bug Fixes

* **android:** derive adaptive layouts from current window bounds ([#49506](https://github.com/okou-ai/okou/issues/49506)) ([96ffeee](https://github.com/okou-ai/okou/commit/96ffeee19e932079c7f2247f02ff68512a9dc787))


### Performance Improvements

* **android:** shorten authorized chat cache startup ([#49495](https://github.com/okou-ai/okou/issues/49495)) ([5a94fd7](https://github.com/okou-ai/okou/commit/5a94fd7cbb2d465eafc2765e6cd04b9c72ef69f9))

## [0.31.1](https://github.com/okou-ai/okou/compare/android-v0.31.0...android-v0.31.1) (2026-11-20)


### Performance Improvements

* **android:** show chat row changes optimistically ([#49480](https://github.com/okou-ai/okou/issues/49480)) ([a11f1cf](https://github.com/okou-ai/okou/commit/a11f1cf6a41655d478ddbbf833c9032d136976c9))

## [0.31.0](https://github.com/okou-ai/okou/compare/android-v0.30.1...android-v0.31.0) (2026-11-20)


### Features

* **android:** align inbox filters and mark all chats as read ([#49116](https://github.com/okou-ai/okou/issues/49116)) ([c608545](https://github.com/okou-ai/okou/commit/c60854550138bb109e01586abcebc5a08f64c4c6))


### Refactoring

* **api:** retire agent connector execution grants ([#49268](https://github.com/okou-ai/okou/issues/49268)) ([596e8ca](https://github.com/okou-ai/okou/commit/596e8ca5d65c2ba7d7b447816042a9bc48fa8b44))

## [0.30.1](https://github.com/okou-ai/okou/compare/android-v0.30.0...android-v0.30.1) (2026-11-20)


### Bug Fixes

* **mobile:** use chat bubble icons for mark read and unread ([#49277](https://github.com/okou-ai/okou/issues/49277)) ([745cfcf](https://github.com/okou-ai/okou/commit/745cfcfc47b9c05ba40031ab4af73765385a3c5d))

## [0.30.0](https://github.com/okou-ai/okou/compare/android-v0.29.0...android-v0.30.0) (2026-11-19)


### Features

* **android:** add workspace chat title search ([#49021](https://github.com/okou-ai/okou/issues/49021)) ([d363f5b](https://github.com/okou-ai/okou/commit/d363f5b7f09179ad469429497eeb01dd52290f45))


### Bug Fixes

* **android:** open the chat list before workspace startup completes ([#49036](https://github.com/okou-ai/okou/issues/49036)) ([c49b85a](https://github.com/okou-ai/okou/commit/c49b85a980a8545742cfddf4373bad51fa4515e5))

## [0.29.0](https://github.com/okou-ai/okou/compare/android-v0.28.0...android-v0.29.0) (2026-11-19)


### Features

* **android:** adopt material symbols for interface actions ([#48977](https://github.com/okou-ai/okou/issues/48977)) ([8c7c7a2](https://github.com/okou-ai/okou/commit/8c7c7a2b65753e3e005b02cda24126578ae26ade))

## [0.28.0](https://github.com/okou-ai/okou/compare/android-v0.27.1...android-v0.28.0) (2026-11-19)


### Features

* **android:** refine settings and sync display mode with web ([#48892](https://github.com/okou-ai/okou/issues/48892)) ([d8bf4f3](https://github.com/okou-ai/okou/commit/d8bf4f304697b69a4a283226315cc72c02d84275))

## [0.27.1](https://github.com/okou-ai/okou/compare/android-v0.27.0...android-v0.27.1) (2026-11-19)


### CI

* **android:** speed up manual screenshot captures ([#48904](https://github.com/okou-ai/okou/issues/48904)) ([b74b455](https://github.com/okou-ai/okou/commit/b74b455460204b56d5f6ca33498e3e0245cdf85c))

## [0.27.0](https://github.com/okou-ai/okou/compare/android-v0.26.0...android-v0.27.0) (2026-11-19)


### Features

* **android:** add chat rename, pin and scoped ordering ([#48851](https://github.com/okou-ai/okou/issues/48851)) ([b2d3b9a](https://github.com/okou-ai/okou/commit/b2d3b9a592ed76451a3c5114eba21f61d55985e4))


### Performance Improvements

* **android:** shorten ci validation ([#48835](https://github.com/okou-ai/okou/issues/48835)) ([f319d49](https://github.com/okou-ai/okou/commit/f319d494feb0fe0ab29f762f5f22085a3300f6f9))

## [0.26.0](https://github.com/okou-ai/okou/compare/android-v0.25.0...android-v0.26.0) (2026-11-19)


### Features

* **android:** add chat row mute and archive actions ([#48768](https://github.com/okou-ai/okou/issues/48768)) ([f74ed61](https://github.com/okou-ai/okou/commit/f74ed61ce0b1c050375aa96e01b47a8ff7bb732d))

## [0.25.0](https://github.com/okou-ai/okou/compare/android-v0.24.0...android-v0.25.0) (2026-11-18)


### Features

* add ultrafast for codex subscriptions ([#48736](https://github.com/okou-ai/okou/issues/48736)) ([c352dad](https://github.com/okou-ai/okou/commit/c352dadadbbec10cea8cf77adccfac8462ecdb94))
* **android:** add chat row read actions ([#48753](https://github.com/okou-ai/okou/issues/48753)) ([feff7f3](https://github.com/okou-ai/okou/commit/feff7f3e6cca99b946b91f974c654e2104703050))
* **android:** animate the chat list running indicators ([#48728](https://github.com/okou-ai/okou/issues/48728)) ([c8e2f5b](https://github.com/okou-ai/okou/commit/c8e2f5ba16ae4da481e6eb5bae576c68abf2c28b))
* **android:** refine workspace list toolbar and filters ([#48740](https://github.com/okou-ai/okou/issues/48740)) ([36a450c](https://github.com/okou-ai/okou/commit/36a450c21413c751116d92d0ecf60e654d991aa6))

## [0.24.0](https://github.com/okou-ai/okou/compare/android-v0.23.0...android-v0.24.0) (2026-11-18)


### Features

* **android:** refine chat and project list rows ([#48706](https://github.com/okou-ai/okou/issues/48706)) ([0aab5ca](https://github.com/okou-ai/okou/commit/0aab5ca9058da249e600bf628badadda90cf7c65))

## [0.23.0](https://github.com/okou-ai/okou/compare/android-v0.22.0...android-v0.23.0) (2026-11-18)


### Features

* **android:** adapt workspace to wide windows ([#48685](https://github.com/okou-ai/okou/issues/48685)) ([95b66b3](https://github.com/okou-ai/okou/commit/95b66b38c36968c65dcdd0e9156d0487bf4bf4f4))

## [0.22.0](https://github.com/okou-ai/okou/compare/android-v0.21.1...android-v0.22.0) (2026-11-18)


### Features

* **android:** unify compact workspace navigation ([#48676](https://github.com/okou-ai/okou/issues/48676)) ([e9d5d0c](https://github.com/okou-ai/okou/commit/e9d5d0c4bae85b380fb7ae37a8ef03b6ef4d466b))

## [0.21.1](https://github.com/okou-ai/okou/compare/android-v0.21.0...android-v0.21.1) (2026-11-18)


### Bug Fixes

* **native:** cover every public run failure reason ([#48612](https://github.com/okou-ai/okou/issues/48612)) ([c1416bf](https://github.com/okou-ai/okou/commit/c1416bf15801f329cb95d836b1b66a722fb6a543))

## [0.21.0](https://github.com/okou-ai/okou/compare/android-v0.20.0...android-v0.21.0) (2026-11-18)


### Features

* **android:** sync composer drafts with web ([#48409](https://github.com/okou-ai/okou/issues/48409)) ([9c4533e](https://github.com/okou-ai/okou/commit/9c4533e1759c94add85742779eb169793038a1a9))

## [0.20.0](https://github.com/okou-ai/okou/compare/android-v0.19.1...android-v0.20.0) (2026-11-17)


### Features

* add independent project sorting ([#48352](https://github.com/okou-ai/okou/issues/48352)) ([5ace277](https://github.com/okou-ai/okou/commit/5ace277384c9a3e0da65abdbf87a89fea3311d85))

## [0.19.1](https://github.com/okou-ai/okou/compare/android-v0.19.0...android-v0.19.1) (2026-11-17)


### Refactoring

* define client run and activity read models ([#48165](https://github.com/okou-ai/okou/issues/48165)) ([9be7072](https://github.com/okou-ai/okou/commit/9be7072fcdb23c781cc0d68a93dc88fc7b86f8da))

## [0.19.0](https://github.com/okou-ai/okou/compare/android-v0.18.1...android-v0.19.0) (2026-11-17)


### Features

* **android:** recover current assistant failures ([#48167](https://github.com/okou-ai/okou/issues/48167)) ([d94db12](https://github.com/okou-ai/okou/commit/d94db123ec646331a1171085c281b2fa8d8b650b))

## [0.18.1](https://github.com/okou-ai/okou/compare/android-v0.18.0...android-v0.18.1) (2026-11-17)


### Refactoring

* prepare structured run failure clients ([#48006](https://github.com/okou-ai/okou/issues/48006)) ([4839506](https://github.com/okou-ai/okou/commit/483950651b69db523f06a72f7cf2490c913ff8ab))

## [0.18.0](https://github.com/okou-ai/okou/compare/android-v0.17.0...android-v0.18.0) (2026-11-17)


### Features

* **android:** add target-bound run and queue controls ([#47921](https://github.com/okou-ai/okou/issues/47921)) ([c33e87f](https://github.com/okou-ai/okou/commit/c33e87f4e15b7e4adb5936c9ba2df7b97b87646a))


### Performance Improvements

* **ci:** skip android validation for release-please ([#48080](https://github.com/okou-ai/okou/issues/48080)) ([7b303ed](https://github.com/okou-ai/okou/commit/7b303edbf70e271950f1c3140241a6024bb6538c))

## [0.17.0](https://github.com/okou-ai/okou/compare/android-v0.16.0...android-v0.17.0) (2026-11-17)


### Features

* **android:** align conversation reads and history warming with web ([#47910](https://github.com/okou-ai/okou/issues/47910)) ([8e92fed](https://github.com/okou-ai/okou/commit/8e92fedbb8a32f2360f6093247c469398758b026))


### Bug Fixes

* **android:** reject unversioned composer journals ([#47962](https://github.com/okou-ai/okou/issues/47962)) ([48323f3](https://github.com/okou-ai/okou/commit/48323f361f67379838d2f58df219980cd57a83f5))

## [0.16.0](https://github.com/okou-ai/okou/compare/android-v0.15.0...android-v0.16.0) (2026-11-16)


### Features

* route presentation templates by output format ([#47842](https://github.com/okou-ai/okou/issues/47842)) ([b342805](https://github.com/okou-ai/okou/commit/b342805293be679b34781d7ff4811669feccbb77))

## [0.15.0](https://github.com/okou-ai/okou/compare/android-v0.14.2...android-v0.15.0) (2026-11-16)


### Features

* **android:** stream active-run output with web data semantics ([#47766](https://github.com/okou-ai/okou/issues/47766)) ([7ab9764](https://github.com/okou-ai/okou/commit/7ab9764c662ec7ea5d8d261cdc714334aa4973d4))


### Bug Fixes

* **android:** route realtime refreshes to affected chat resources ([#47838](https://github.com/okou-ai/okou/issues/47838)) ([1ebe4df](https://github.com/okou-ai/okou/commit/1ebe4df021265aaf617a84e3d6f73da553839288))

## [0.14.2](https://github.com/okou-ai/okou/compare/android-v0.14.1...android-v0.14.2) (2026-11-16)


### Bug Fixes

* **android:** defer git version code until metadata is needed ([#47763](https://github.com/okou-ai/okou/issues/47763)) ([e27dfaa](https://github.com/okou-ai/okou/commit/e27dfaabb5f3ecfd4e3a54f5c207522433b19b2e))

## [0.14.1](https://github.com/okou-ai/okou/compare/android-v0.14.0...android-v0.14.1) (2026-11-16)


### Performance Improvements

* **android:** shrink release apk code and resources ([#47534](https://github.com/okou-ai/okou/issues/47534)) ([9ef8d65](https://github.com/okou-ai/okou/commit/9ef8d652eeadc6e481a86e9f3ae8159c957ed026))

## [0.14.0](https://github.com/okou-ai/okou/compare/android-v0.13.0...android-v0.14.0) (2026-11-16)


### Features

* **android:** refresh chats from foreground realtime ([#47513](https://github.com/okou-ai/okou/issues/47513)) ([fbfbd14](https://github.com/okou-ai/okou/commit/fbfbd14d336aaa49fc887093b4c90886ce83eff7))

## [0.13.0](https://github.com/okou-ai/okou/compare/android-v0.12.0...android-v0.13.0) (2026-11-15)


### Features

* **android:** add native apk update and recovery flows ([#47331](https://github.com/okou-ai/okou/issues/47331)) ([c9d9bdb](https://github.com/okou-ai/okou/commit/c9d9bdb0c7a3affbfc4f0a3910a1eb22cbeddf21))

## [0.12.0](https://github.com/okou-ai/okou/compare/android-v0.11.0...android-v0.12.0) (2026-11-14)


### Features

* **android:** add durable text drafts and sending ([#47239](https://github.com/okou-ai/okou/issues/47239)) ([23db870](https://github.com/okou-ai/okou/commit/23db8702960c836e9119fbeca27fad1cfe9283c3))


### Refactoring

* **api:** stop accepting the retired chat resources preference write ([#47299](https://github.com/okou-ai/okou/issues/47299)) ([c2fbb97](https://github.com/okou-ai/okou/commit/c2fbb97cd4c674b73720b375573bd592e7ee7f77))

## [0.11.0](https://github.com/okou-ai/okou/compare/android-v0.10.0...android-v0.11.0) (2026-11-14)


### Features

* **android:** add personal instructions editing and recovery ([#47183](https://github.com/okou-ai/okou/issues/47183)) ([e0e425a](https://github.com/okou-ai/okou/commit/e0e425a3aaa6ba7ea21ccddcdba51f88ba922e83))

## [0.10.0](https://github.com/okou-ai/okou/compare/android-v0.9.0...android-v0.10.0) (2026-11-14)


### Features

* **android:** prove canonical text-send bindings ([#47161](https://github.com/okou-ai/okou/issues/47161)) ([3c87809](https://github.com/okou-ai/okou/commit/3c87809234c9baf4d28117cca368e726b0945371))

## [0.9.0](https://github.com/okou-ai/okou/compare/android-v0.8.0...android-v0.9.0) (2026-11-14)


### Features

* **android:** add commit-addressed screenshot acceptance ([#47136](https://github.com/okou-ai/okou/issues/47136)) ([336d2a4](https://github.com/okou-ai/okou/commit/336d2a4ea9bf158919a5d7f932f50d29770a59d8))

## [0.8.0](https://github.com/okou-ai/okou/compare/android-v0.7.0...android-v0.8.0) (2026-11-14)


### Features

* **android:** add native conversation history ([#47084](https://github.com/okou-ai/okou/issues/47084)) ([ceff05b](https://github.com/okou-ai/okou/commit/ceff05bf314bda810b8fd0203f50bba4ead15048))

## [0.7.0](https://github.com/okou-ai/okou/compare/android-v0.6.0...android-v0.7.0) (2026-11-13)


### Features

* **android:** prove canonical conversation history bindings ([#47058](https://github.com/okou-ai/okou/issues/47058)) ([d62e358](https://github.com/okou-ai/okou/commit/d62e3581fa036a5b330c76bdd053e773bc0ac5bd))

## [0.6.0](https://github.com/okou-ai/okou/compare/android-v0.5.0...android-v0.6.0) (2026-11-13)


### Features

* **android:** add the confirmed native chat list ([#46918](https://github.com/okou-ai/okou/issues/46918)) ([e0745ae](https://github.com/okou-ai/okou/commit/e0745ae12d3248abc3eefb7484eaa48b94ea3e6b))

## [0.5.0](https://github.com/okou-ai/okou/compare/android-v0.4.0...android-v0.5.0) (2026-11-13)


### Features

* **android:** support canonical chat list read bindings ([#46899](https://github.com/okou-ai/okou/issues/46899)) ([86010cf](https://github.com/okou-ai/okou/commit/86010cfa9689050362ac487304f027bbe4b4c2e0))

## [0.4.0](https://github.com/okou-ai/okou/compare/android-v0.3.0...android-v0.4.0) (2026-11-12)


### Features

* **android:** sync workspace color and language preferences ([#46863](https://github.com/okou-ai/okou/issues/46863)) ([bfb5317](https://github.com/okou-ai/okou/commit/bfb531737a1fc8df43516ebb4077c5222989c410))

## [0.3.0](https://github.com/okou-ai/okou/compare/android-v0.2.1...android-v0.3.0) (2026-11-12)


### Features

* **android:** add native clerk authentication and workspace sessions ([#46827](https://github.com/okou-ai/okou/issues/46827)) ([fe65105](https://github.com/okou-ai/okou/commit/fe65105104384bd537a3305312b29b8f46495844))

## [0.2.1](https://github.com/okou-ai/okou/compare/android-v0.2.0...android-v0.2.1) (2026-11-12)


### Bug Fixes

* **android:** preserve signing identity across releases ([#46768](https://github.com/okou-ai/okou/issues/46768)) ([4f7e733](https://github.com/okou-ai/okou/commit/4f7e733e7e672614ca18a6065f580a38c4d47c11))

## [0.2.0](https://github.com/okou-ai/okou/compare/android-v0.1.0...android-v0.2.0) (2026-11-12)


### Features

* **android:** add generated api transport and release compatibility ([#46666](https://github.com/okou-ai/okou/issues/46666)) ([2898887](https://github.com/okou-ai/okou/commit/2898887d268ba4efdec8b7bbffdf6a93a9de7490))
* **android:** add native client and state foundation ([#46526](https://github.com/okou-ai/okou/issues/46526)) ([89de7d9](https://github.com/okou-ai/okou/commit/89de7d9a1d22e4515515eb4f8049f78f5f91937e))
* **android:** add native home and appearance settings ([#46630](https://github.com/okou-ai/okou/issues/46630)) ([b019ca0](https://github.com/okou-ai/okou/commit/b019ca06e8b0099541448a2139c2e3e7e013194b))
