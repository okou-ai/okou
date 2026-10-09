:robot: I have created a release *beep* *boop*
---


<details><summary>ios: 0.7.3</summary>

## [0.7.3](https://github.com/okou-ai/okou/compare/ios-v0.7.2...ios-v0.7.3) (2026-10-09)


### Refactoring

* **ios:** centralize conversation scroll intent ([#38385](https://github.com/okou-ai/okou/issues/38385)) ([34f6c4c](https://github.com/okou-ai/okou/commit/34f6c4c0e63b72d0f310ba223a0a8c4711bd60f4))
* **ios:** isolate chat data in a local swift package ([#38409](https://github.com/okou-ai/okou/issues/38409)) ([f66592e](https://github.com/okou-ai/okou/commit/f66592e7aecdb983341d5b8ce9ec25c064dcdb69))
</details>

<details><summary>desktop: 0.52.1</summary>

## [0.52.1](https://github.com/okou-ai/okou/compare/desktop-v0.52.0...desktop-v0.52.1) (2026-10-09)


### Documentation

* keep reusable engineering standards and remove feature records ([#38387](https://github.com/okou-ai/okou/issues/38387)) ([6507d86](https://github.com/okou-ai/okou/commit/6507d86c83ca37e7a8790e4efd66eb6a84267295))
</details>

<details><summary>api-contracts: 1.546.0</summary>

## [1.546.0](https://github.com/okou-ai/okou/compare/api-contracts-v1.545.1...api-contracts-v1.546.0) (2026-10-09)


### Features

* add permission-aware artifact og previews ([#38361](https://github.com/okou-ai/okou/issues/38361)) ([2ef5d4e](https://github.com/okou-ai/okou/commit/2ef5d4ec8c2aedc9217e669f110f8c68fb9b65f3))
* add sandbox covers for hosted artifacts ([#38149](https://github.com/okou-ai/okou/issues/38149)) ([f4a3140](https://github.com/okou-ai/okou/commit/f4a3140275a8c3334135080ed2427e837bc9fc89))
* add subscription controls and user-confirmed reset cards ([#37763](https://github.com/okou-ai/okou/issues/37763)) ([d9a0b29](https://github.com/okou-ai/okou/commit/d9a0b29aeb0866740540f5e970fcbf80709342d7))
* allow debug admins to clear organization openrouter presets ([#38407](https://github.com/okou-ai/okou/issues/38407)) ([a1464ca](https://github.com/okou-ai/okou/commit/a1464ca1752a1aa3247485b1582604ef10a276d1))
* allow debug admins to switch organization openrouter presets ([#38327](https://github.com/okou-ai/okou/issues/38327)) ([3ab4dfc](https://github.com/okou-ai/okou/commit/3ab4dfc68ffdf7afe085c52e3cf9040354c117d9))
* **api:** prepare home cache affinity and runner state ([#38314](https://github.com/okou-ai/okou/issues/38314)) ([21ce097](https://github.com/okou-ai/okou/commit/21ce0978ad9a5bc7eddb94bc9d2bc25f1897095f))
* **debug:** add morning brief test emails ([#38411](https://github.com/okou-ai/okou/issues/38411)) ([ce2f1d5](https://github.com/okou-ai/okou/commit/ce2f1d5b3ce2cad351d5515e38dee95d05d148c9))
* **desktop:** enforce minimum versions with automatic required upgrades ([#38115](https://github.com/okou-ai/okou/issues/38115)) ([ae3a5b2](https://github.com/okou-ai/okou/commit/ae3a5b291a085bd900c21689563c74240c4123cb))
* **desktop:** replace electron with native swift desktop ([#37889](https://github.com/okou-ai/okou/issues/37889)) ([303d7bc](https://github.com/okou-ai/okou/commit/303d7bc2e3176b02c66ca3ef1c9c9b0eb2bb7700))
* **desktop:** use clerk session tokens for native computer use ([#37965](https://github.com/okou-ai/okou/issues/37965)) ([fccd4a9](https://github.com/okou-ai/okou/commit/fccd4a98bb370bdaf9c8dd312988f5ba267bbb2c))
* **mcp:** track chat inputs by their original event id ([#37759](https://github.com/okou-ai/okou/issues/37759)) ([1375385](https://github.com/okou-ai/okou/commit/137538594d42aa2942187acee4ac713c6c308112))
* **notify:** add agent-controlled mail notifications ([#38093](https://github.com/okou-ai/okou/issues/38093)) ([702c270](https://github.com/okou-ai/okou/commit/702c270169c8de738aa9f47ed5480ed377edcfda))
* **notify:** add morning brief notification kind ([#38308](https://github.com/okou-ai/okou/issues/38308)) ([31d9036](https://github.com/okou-ai/okou/commit/31d9036dcb2e6a005ebbdb250a3b216ce713c51c))
* **pi:** route openrouter through chat completions behind a switch ([#37987](https://github.com/okou-ai/okou/issues/37987)) ([df136ee](https://github.com/okou-ai/okou/commit/df136ee82546c76d79575e203c7257371ea5b3cb))
* **platform:** prepare tailscale-aware ssh and vnc readers ([#37814](https://github.com/okou-ai/okou/issues/37814)) ([a648388](https://github.com/okou-ai/okou/commit/a648388f2dd47531d577fe4e68205c505335a9c3))
* prepare model identity compatibility without switching writes ([#38092](https://github.com/okou-ai/okou/issues/38092)) ([21177df](https://github.com/okou-ai/okou/commit/21177dfd37bc19114098a628a094adb67fb60db0))


### Bug Fixes

* **api:** raise autonomous delegation budget to 32 ([#37737](https://github.com/okou-ai/okou/issues/37737)) ([f57a13f](https://github.com/okou-ai/okou/commit/f57a13f44233adb5b8469d0a039cb4befda9cf32))
* **api:** refresh archive urls with less than four hours remaining ([#37735](https://github.com/okou-ai/okou/issues/37735)) ([b6e6d02](https://github.com/okou-ai/okou/commit/b6e6d02418c07f713a95c29313671a65f3a82643))
* classify codex cybersecurity safety refusals ([#37945](https://github.com/okou-ai/okou/issues/37945)) ([5693b80](https://github.com/okou-ai/okou/commit/5693b806ad5a55154a8e9f3d7b3bb5de727624e2))
* **host:** prepare canonical deployment delivery authority ([#38212](https://github.com/okou-ai/okou/issues/38212)) ([bd8b130](https://github.com/okou-ai/okou/commit/bd8b13065d6b8ce406c3c7659f6634528f794913))
* rewrite retired thread models to their replacement ([#37906](https://github.com/okou-ai/okou/issues/37906)) ([eb98c63](https://github.com/okou-ai/okou/commit/eb98c63635aa78f7c9c79ef8e24a382e9c2d1077))
* **seo:** preserve dataforseo partial serp results ([#37961](https://github.com/okou-ai/okou/issues/37961)) ([b5d9654](https://github.com/okou-ai/okou/commit/b5d96542a902d7cad11325c86966f49746e41172))
* suppress pwa push while the user is foreground in the same org ([#38091](https://github.com/okou-ai/okou/issues/38091)) ([22f89a5](https://github.com/okou-ai/okou/commit/22f89a5c8b69990bb3834c7678acb25f00d1c823))
* **voice:** separate segment transcription from final polish ([#38082](https://github.com/okou-ai/okou/issues/38082)) ([1c7cb86](https://github.com/okou-ai/okou/commit/1c7cb86855d50504a57a6fcb86b9357a5965e3de))


### Documentation

* align captured long-context threshold contract ([#37989](https://github.com/okou-ai/okou/issues/37989)) ([30eabca](https://github.com/okou-ai/okou/commit/30eabca061a6479a5b4fc40e7d6be0cc99da3f93))


### Refactoring

* **api-contracts:** remove unimplemented morning brief preview contracts ([#37960](https://github.com/okou-ai/okou/issues/37960)) ([02e75e6](https://github.com/okou-ai/okou/commit/02e75e6a483702698ce23f940a64f21831e9f71b))
* **api:** own official workflow reconciliation transactions ([#38170](https://github.com/okou-ai/okou/issues/38170)) ([7fdd681](https://github.com/okou-ai/okou/commit/7fdd6812fb11c08d244b3eca9ee18d7edf067112))
* **api:** remove unused pi stable-context and report delisted connectors absent ([#37905](https://github.com/okou-ai/okou/issues/37905)) ([c339e73](https://github.com/okou-ai/okou/commit/c339e73f0fb5d0ca0a8f4a4e80c67331ea9fb79d))
* **api:** resolve queued connector permissions from current catalog ([#38066](https://github.com/okou-ai/okou/issues/38066)) ([865afb7](https://github.com/okou-ai/okou/commit/865afb7a05d413c9db56713035a373ebaa767672))
* **api:** retire automatic morning brief enrollment ([#38095](https://github.com/okou-ai/okou/issues/38095)) ([d1076b6](https://github.com/okou-ai/okou/commit/d1076b64322892d680dce0ef9ed835d53ebf57e3))
* **api:** retire batch 017 private test fixtures ([#38235](https://github.com/okou-ai/okou/issues/38235)) ([a218941](https://github.com/okou-ai/okou/commit/a2189418b48f7dab6b8d5b9237f7d4c6bfd20d4e))
* **api:** retire native morning brief storage dependencies ([#37874](https://github.com/okou-ai/okou/issues/37874)) ([094ef4c](https://github.com/okou-ai/okou/commit/094ef4c402089b1acdcafede8af8f7e081506d2f))
* **api:** retire workflow automation worker test endpoints ([#37904](https://github.com/okou-ai/okou/issues/37904)) ([1375381](https://github.com/okou-ai/okou/commit/13753817e6507ac8b71315166dac807a87711c4c))
* **api:** unify test projects with per-case database isolation ([#37896](https://github.com/okou-ai/okou/issues/37896)) ([28c0ec4](https://github.com/okou-ai/okou/commit/28c0ec43505f5032b005505d92c5e7c6d74d8a03))
* **api:** use client-only platform realtime token exchange ([#38105](https://github.com/okou-ai/okou/issues/38105)) ([0fdfb57](https://github.com/okou-ai/okou/commit/0fdfb57b88d655219e84f18050a88362071cdd41))
* **artifacts:** remove video poster extraction ([#38146](https://github.com/okou-ai/okou/issues/38146)) ([641cf0d](https://github.com/okou-ai/okou/commit/641cf0ddff6c631cf94386e6c3d26c78395c63aa))
* **artifacts:** use artifact identity for google drive uploads ([#38300](https://github.com/okou-ai/okou/issues/38300)) ([e223f5e](https://github.com/okou-ai/okou/commit/e223f5e45fd22cdd729f84f075686ec5afb24b6e))
* assemble current run inputs without agent configuration ([#38004](https://github.com/okou-ai/okou/issues/38004)) ([22efd4b](https://github.com/okou-ai/okou/commit/22efd4b6b34872c0585a0d4c3778cb3b59d9d100))
* clean up released switch leftovers and drop legacy chat thread provider pins ([#37851](https://github.com/okou-ai/okou/issues/37851)) ([066e9c3](https://github.com/okou-ai/okou/commit/066e9c32c2bbd5e3d48783fb0028f8dcfbaeaf06))
* **computer-use:** remove retired desktop plugins ([#37980](https://github.com/okou-ai/okou/issues/37980)) ([8b8928c](https://github.com/okou-ai/okou/commit/8b8928cdf85d4fb2243a9326194d7cfb3936d53c))
* contract connector catalog storage to pointer and immutable entries ([#37886](https://github.com/okou-ai/okou/issues/37886)) ([baf302f](https://github.com/okou-ai/okou/commit/baf302f5373a000999dfde0abf521752a779e29c))
* **contracts:** remove unused avatar video contracts ([#37948](https://github.com/okou-ai/okou/issues/37948)) ([7c1d818](https://github.com/okou-ai/okou/commit/7c1d8185424e8f21d31c854c6d2df91dd84e84d5))
* **discord:** derive message content from application grants ([#38377](https://github.com/okou-ai/okou/issues/38377)) ([a69a248](https://github.com/okou-ai/okou/commit/a69a2485e449109886f80bf37d49ece61f750230))
* finish connector catalog release 2 follow-up cleanup ([#37895](https://github.com/okou-ai/okou/issues/37895)) ([013d37d](https://github.com/okou-ai/okou/commit/013d37d5513f5ff071097621e4436109742f6dc8))
* move release 1 connector catalog consumers off legacy storage ([#37861](https://github.com/okou-ai/okou/issues/37861)) ([e664957](https://github.com/okou-ai/okou/commit/e664957caa2056a336595e55f475001b81247fd0))
* remove abandoned langfuse trace feature ([#38010](https://github.com/okou-ai/okou/issues/38010)) ([5080d02](https://github.com/okou-ai/okou/commit/5080d026e68f10f41285570f52a9b655fb562052))
* remove all remaining custom model mode awareness ([#37856](https://github.com/okou-ai/okou/issues/37856)) ([f383835](https://github.com/okou-ai/okou/commit/f3838353ba0455ec7d57dfa2d0974e34a44796ff))
* remove connector catalog diagnostics endpoint and cron response fields ([#37907](https://github.com/okou-ai/okou/issues/37907)) ([0d2b5d1](https://github.com/okou-ai/okou/commit/0d2b5d1a7bae269f2fcac0bf23f7ae377df07244))
* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))
* remove eleven released feature switches ([#37848](https://github.com/okou-ai/okou/issues/37848)) ([53255d6](https://github.com/okou-ai/okou/commit/53255d66854676285dad37eb13b3266ebe578031))
* remove expired deployment compatibility ([#37845](https://github.com/okou-ai/okou/issues/37845)) ([ada585f](https://github.com/okou-ai/okou/commit/ada585fdc70a1fc5c26e70e0ec53bbef893c4f4c))
* remove expired deployment compatibility ([#38219](https://github.com/okou-ai/okou/issues/38219)) ([303f42b](https://github.com/okou-ai/okou/commit/303f42bafd0d70928c477dc87a5f25fdc00db6d7))
* remove remaining model provider residue ([#37870](https://github.com/okou-ai/okou/issues/37870)) ([a93133b](https://github.com/okou-ai/okou/commit/a93133b0493858a39924a1206ff5a5677e43cad6))
* represent auto model selection as null ([#37901](https://github.com/okou-ai/okou/issues/37901)) ([d0e0b71](https://github.com/okou-ai/okou/commit/d0e0b7191fe168e8935e1abf3df1fa1806efea2a))
* retire cooldown, ultrafast, us routing and model provider leftovers ([#37884](https://github.com/okou-ai/okou/issues/37884)) ([a9c3270](https://github.com/okou-ai/okou/commit/a9c3270099034c0f7ee73f6c730b07efa7d1d733))
* retire generic run checkpoints from completion ([#38147](https://github.com/okou-ai/okou/issues/38147)) ([e8002cf](https://github.com/okou-ai/okou/commit/e8002cfcc9995e2b245947dbf25a9f9dd73f1ca0))
* retire organization custom model configuration ([#37746](https://github.com/okou-ai/okou/issues/37746)) ([014fe18](https://github.com/okou-ai/okou/commit/014fe1867c6d1830fd35b03c3d77491da5aaa36a))
* retire organization usage allowance ([#37971](https://github.com/okou-ai/okou/issues/37971)) ([2659878](https://github.com/okou-ai/okou/commit/26598788903fb817edd71d82ccbdfcd66cfa3a0a))


### Performance Improvements

* **ci:** bound api preview connector catalog initialization ([#37790](https://github.com/okou-ai/okou/issues/37790)) ([d6300c1](https://github.com/okou-ai/okou/commit/d6300c15d49be1602c846acfc82b96f60caed4ea))
</details>

<details><summary>app: 0.1007.0</summary>

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
* **platform:** keep standalone authorization cards safe and scrollable ([#38376](https://github.com/okou-ai/okou/issues/38376)) ([fb07ec7](https://github.com/okou-ai/okou/commit/fb07ec7d6556a453bbeb226b666cf8bc63db5c01))
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
* **platform:** vertically center rewards note button label ([#38427](https://github.com/okou-ai/okou/issues/38427)) ([8637145](https://github.com/okou-ai/okou/commit/86371455a9f25240f47cb3c344b6a87668be3795))
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
</details>

<details><summary>app-worker: 1.9.0</summary>

## [1.9.0](https://github.com/okou-ai/okou/compare/app-worker-v1.8.209...app-worker-v1.9.0) (2026-10-09)


### Features

* add permission-aware artifact og previews ([#38361](https://github.com/okou-ai/okou/issues/38361)) ([2ef5d4e](https://github.com/okou-ai/okou/commit/2ef5d4ec8c2aedc9217e669f110f8c68fb9b65f3))


### Refactoring

* retire organization custom model configuration ([#37746](https://github.com/okou-ai/okou/issues/37746)) ([014fe18](https://github.com/okou-ai/okou/commit/014fe1867c6d1830fd35b03c3d77491da5aaa36a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.546.0
    * @okouai/core bumped to 8.739.0
</details>

<details><summary>cli: 9.383.0</summary>

## [9.383.0](https://github.com/okou-ai/okou/compare/cli-v9.382.1...cli-v9.383.0) (2026-10-09)


### Features

* add sandbox covers for hosted artifacts ([#38149](https://github.com/okou-ai/okou/issues/38149)) ([f4a3140](https://github.com/okou-ai/okou/commit/f4a3140275a8c3334135080ed2427e837bc9fc89))
* add subscription controls and user-confirmed reset cards ([#37763](https://github.com/okou-ai/okou/issues/37763)) ([d9a0b29](https://github.com/okou-ai/okou/commit/d9a0b29aeb0866740540f5e970fcbf80709342d7))
* make pi memory free with an openrouter preset ([#38290](https://github.com/okou-ai/okou/issues/38290)) ([5768ad5](https://github.com/okou-ai/okou/commit/5768ad5ef7ce0808c6cde85a9eb628be7e8aeb57))
* **notify:** add agent-controlled mail notifications ([#38093](https://github.com/okou-ai/okou/issues/38093)) ([702c270](https://github.com/okou-ai/okou/commit/702c270169c8de738aa9f47ed5480ed377edcfda))
* **notify:** add morning brief notification kind ([#38308](https://github.com/okou-ai/okou/issues/38308)) ([31d9036](https://github.com/okou-ai/okou/commit/31d9036dcb2e6a005ebbdb250a3b216ce713c51c))
* **pi:** route openrouter through chat completions behind a switch ([#37987](https://github.com/okou-ai/okou/issues/37987)) ([df136ee](https://github.com/okou-ai/okou/commit/df136ee82546c76d79575e203c7257371ea5b3cb))
* prepare model identity compatibility without switching writes ([#38092](https://github.com/okou-ai/okou/issues/38092)) ([21177df](https://github.com/okou-ai/okou/commit/21177dfd37bc19114098a628a094adb67fb60db0))


### Bug Fixes

* **cli:** preserve saved service tier in okou model select ([#37887](https://github.com/okou-ai/okou/issues/37887)) ([8fd1b1c](https://github.com/okou-ai/okou/commit/8fd1b1c9205501fcb518d101b1fe7c03ef6b1d4c))
* **maps:** explain oversized grounding responses ([#38046](https://github.com/okou-ai/okou/issues/38046)) ([9ea9cde](https://github.com/okou-ai/okou/commit/9ea9cde34b01d89bb258b44250ce4b17260cf37c)), closes [#36791](https://github.com/okou-ai/okou/issues/36791)
* **seo:** preserve dataforseo partial serp results ([#37961](https://github.com/okou-ai/okou/issues/37961)) ([b5d9654](https://github.com/okou-ai/okou/commit/b5d96542a902d7cad11325c86966f49746e41172))


### Refactoring

* **api:** unify test projects with per-case database isolation ([#37896](https://github.com/okou-ai/okou/issues/37896)) ([28c0ec4](https://github.com/okou-ai/okou/commit/28c0ec43505f5032b005505d92c5e7c6d74d8a03))
* **computer-use:** remove retired desktop plugins ([#37980](https://github.com/okou-ai/okou/issues/37980)) ([8b8928c](https://github.com/okou-ai/okou/commit/8b8928cdf85d4fb2243a9326194d7cfb3936d53c))
* remove abandoned langfuse trace feature ([#38010](https://github.com/okou-ai/okou/issues/38010)) ([5080d02](https://github.com/okou-ai/okou/commit/5080d026e68f10f41285570f52a9b655fb562052))
* remove all remaining custom model mode awareness ([#37856](https://github.com/okou-ai/okou/issues/37856)) ([f383835](https://github.com/okou-ai/okou/commit/f3838353ba0455ec7d57dfa2d0974e34a44796ff))
* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))
* remove remaining model provider residue ([#37870](https://github.com/okou-ai/okou/issues/37870)) ([a93133b](https://github.com/okou-ai/okou/commit/a93133b0493858a39924a1206ff5a5677e43cad6))
* remove retired per-agent ssh access traces ([#37876](https://github.com/okou-ai/okou/issues/37876)) ([dc33264](https://github.com/okou-ai/okou/commit/dc332649051e79460f1075a294ba8d3707f8504f))
* represent auto model selection as null ([#37901](https://github.com/okou-ai/okou/issues/37901)) ([d0e0b71](https://github.com/okou-ai/okou/commit/d0e0b7191fe168e8935e1abf3df1fa1806efea2a))
* retire cooldown, ultrafast, us routing and model provider leftovers ([#37884](https://github.com/okou-ai/okou/issues/37884)) ([a9c3270](https://github.com/okou-ai/okou/commit/a9c3270099034c0f7ee73f6c730b07efa7d1d733))
* retire organization custom model configuration ([#37746](https://github.com/okou-ai/okou/issues/37746)) ([014fe18](https://github.com/okou-ai/okou/commit/014fe1867c6d1830fd35b03c3d77491da5aaa36a))
* **runner:** bind cli identity to package bytes for rootfs hashing ([#37967](https://github.com/okou-ai/okou/issues/37967)) ([3698acc](https://github.com/okou-ai/okou/commit/3698acc28545e383a9357ea354ac1db8c51523dc))


### Performance Improvements

* **ci:** reduce runner image prepare startup overhead ([#38200](https://github.com/okou-ai/okou/issues/38200)) ([0f05acd](https://github.com/okou-ai/okou/commit/0f05acd51d6acb3080d3b09144537bdfef74e80f))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @okouai/api-contracts bumped to 1.546.0
    * @okouai/core bumped to 8.739.0
    * @okouai/pi-agent-runtime bumped to 1.49.0
</details>

<details><summary>core: 8.739.0</summary>

## [8.739.0](https://github.com/okou-ai/okou/compare/core-v8.738.1...core-v8.739.0) (2026-10-09)


### Features

* add permission-aware artifact og previews ([#38361](https://github.com/okou-ai/okou/issues/38361)) ([2ef5d4e](https://github.com/okou-ai/okou/commit/2ef5d4ec8c2aedc9217e669f110f8c68fb9b65f3))
* add sandbox covers for hosted artifacts ([#38149](https://github.com/okou-ai/okou/issues/38149)) ([f4a3140](https://github.com/okou-ai/okou/commit/f4a3140275a8c3334135080ed2427e837bc9fc89))
* add subscription controls and user-confirmed reset cards ([#37763](https://github.com/okou-ai/okou/issues/37763)) ([d9a0b29](https://github.com/okou-ai/okou/commit/d9a0b29aeb0866740540f5e970fcbf80709342d7))
* **api:** switch auto writers to captured runtime billing ([#38270](https://github.com/okou-ai/okou/issues/38270)) ([e34e331](https://github.com/okou-ai/okou/commit/e34e3319db818fa89f928b7c8dc21e3536714c86))
* **app:** add opt-in responsive mobile navigation ([#37713](https://github.com/okou-ai/okou/issues/37713)) ([507bc00](https://github.com/okou-ai/okou/commit/507bc00e3fd3570b866c66d21c47871512938859))
* **core:** release eleven staff feature switches to all users ([#37818](https://github.com/okou-ai/okou/issues/37818)) ([8d05119](https://github.com/okou-ai/okou/commit/8d051194184d595b67f78f5d6f7ec728ed6cc31d))
* enable phone group history, message sharing and social jobs globally ([#37716](https://github.com/okou-ai/okou/issues/37716)) ([b1ec157](https://github.com/okou-ai/okou/commit/b1ec157db9ded38688563e0f153df0ab8364802e))
* enable private artifacts for all users ([#37951](https://github.com/okou-ai/okou/issues/37951)) ([91e19d1](https://github.com/okou-ai/okou/commit/91e19d1e55e49ffb5822aa2a9d7fcb336b9cb9cf))
* enable pwa navigation for staff organizations ([#37787](https://github.com/okou-ai/okou/issues/37787)) ([f150ca6](https://github.com/okou-ai/okou/commit/f150ca60dc652e273d114e7523acd48fac0a2491))
* **notify:** add agent-controlled mail notifications ([#38093](https://github.com/okou-ai/okou/issues/38093)) ([702c270](https://github.com/okou-ai/okou/commit/702c270169c8de738aa9f47ed5480ed377edcfda))
* **pi:** route openrouter through chat completions behind a switch ([#37987](https://github.com/okou-ai/okou/issues/37987)) ([df136ee](https://github.com/okou-ai/okou/commit/df136ee82546c76d79575e203c7257371ea5b3cb))
* **platform:** add a feature-gated last-read divider and entry positioning ([#37740](https://github.com/okou-ai/okou/issues/37740)) ([52fbc35](https://github.com/okou-ai/okou/commit/52fbc351e258b79ac0e9a104a46247d695ac959e))
* **platform:** gate composer-anchored suggestion menus ([#38331](https://github.com/okou-ai/okou/issues/38331)) ([80aee42](https://github.com/okou-ai/okou/commit/80aee42a4cf92772b0d8b193df68089588a3b39f))
* prepare model identity compatibility without switching writes ([#38092](https://github.com/okou-ai/okou/issues/38092)) ([21177df](https://github.com/okou-ai/okou/commit/21177dfd37bc19114098a628a094adb67fb60db0))
* promote composer image annotation to beta ([#37761](https://github.com/okou-ai/okou/issues/37761)) ([da041e4](https://github.com/okou-ai/okou/commit/da041e4cb11814975e354c75decb720afba05512))
* **ui:** add a top-to-bottom wave to running chat indicators ([#37657](https://github.com/okou-ai/okou/issues/37657)) ([cfeeb01](https://github.com/okou-ai/okou/commit/cfeeb01c713cb8c44365f23448b418789ad712e8))


### Bug Fixes

* **app:** scope account connections and release multiple subscriptions ([#37714](https://github.com/okou-ai/okou/issues/37714)) ([db0d2ad](https://github.com/okou-ai/okou/commit/db0d2adf4400029a95f1a07fd6c50e48a7e4417e))
* **core:** limit presentation conversion rollout to bingjie ([#38044](https://github.com/okou-ai/okou/issues/38044)) ([9894737](https://github.com/okou-ai/okou/commit/98947373070ad1d5b14595d716c217dca0fd28ac))
* **integrations:** hide auto model attribution in message footers ([#37959](https://github.com/okou-ai/okou/issues/37959)) ([46a2d1a](https://github.com/okou-ai/okou/commit/46a2d1a044c0d48829d2879c689539ccfea64a65))
* **platform:** gate anchored composer layout for initial rollout ([#37976](https://github.com/okou-ai/okou/issues/37976)) ([80770f9](https://github.com/okou-ai/okou/commit/80770f9736da88ef673a21eba968bdb7349874a6))


### Refactoring

* **api:** encapsulate continuation and template preparation ([#38155](https://github.com/okou-ai/okou/issues/38155)) ([207088f](https://github.com/okou-ai/okou/commit/207088f19c5df05553c233d8a0ccbaf195fb0314))
* clean up released switch leftovers and drop legacy chat thread provider pins ([#37851](https://github.com/okou-ai/okou/issues/37851)) ([066e9c3](https://github.com/okou-ai/okou/commit/066e9c32c2bbd5e3d48783fb0028f8dcfbaeaf06))
* **computer-use:** remove retired desktop plugins ([#37980](https://github.com/okou-ai/okou/issues/37980)) ([8b8928c](https://github.com/okou-ai/okou/commit/8b8928cdf85d4fb2243a9326194d7cfb3936d53c))
* graduate fully rolled out feature switches ([#37721](https://github.com/okou-ai/okou/issues/37721)) ([62e6dd4](https://github.com/okou-ai/okou/commit/62e6dd43c07ccfd77517d6f653ab123a37aff89f))
* **platform:** remove abandoned chat last-read marker ([#37966](https://github.com/okou-ai/okou/issues/37966)) ([d85fdca](https://github.com/okou-ai/okou/commit/d85fdcad049428b366f892a181c69e7ab61a8523))
* **platform:** remove realtime connection diagnostics ([#38324](https://github.com/okou-ai/okou/issues/38324)) ([d301ace](https://github.com/okou-ai/okou/commit/d301ace84cc169d8d0565a97a77902e812995ab9))
* remove abandoned langfuse trace feature ([#38010](https://github.com/okou-ai/okou/issues/38010)) ([5080d02](https://github.com/okou-ai/okou/commit/5080d026e68f10f41285570f52a9b655fb562052))
* remove agent responsibility setup feature switch ([#38069](https://github.com/okou-ai/okou/issues/38069)) ([bbb313e](https://github.com/okou-ai/okou/commit/bbb313e561cf6904565d5b91e7e227e2016557ee))
* remove all remaining custom model mode awareness ([#37856](https://github.com/okou-ai/okou/issues/37856)) ([f383835](https://github.com/okou-ai/okou/commit/f3838353ba0455ec7d57dfa2d0974e34a44796ff))
* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))
* remove eleven released feature switches ([#37848](https://github.com/okou-ai/okou/issues/37848)) ([53255d6](https://github.com/okou-ai/okou/commit/53255d66854676285dad37eb13b3266ebe578031))
* remove monday connector feature switch ([#38334](https://github.com/okou-ai/okou/issues/38334)) ([fb8f2d3](https://github.com/okou-ai/okou/commit/fb8f2d3b1474385d7fb0d44594b883919c33c62e))
* remove pi openrouter chat completions feature switch ([#38096](https://github.com/okou-ai/okou/issues/38096)) ([a635ec3](https://github.com/okou-ai/okou/commit/a635ec3afa20cdb5df9c8125afe6cec24ef53e16))
* remove plaud connector feature switch ([#38412](https://github.com/okou-ai/okou/issues/38412)) ([b9fccfb](https://github.com/okou-ai/okou/commit/b9fccfbae83bf7f61da74832a19287c8e964ffde))
* remove remaining model provider residue ([#37870](https://github.com/okou-ai/okou/issues/37870)) ([a93133b](https://github.com/okou-ai/okou/commit/a93133b0493858a39924a1206ff5a5677e43cad6))
* retire claude code manual usage reset ([#37755](https://github.com/okou-ai/okou/issues/37755)) ([1855ed7](https://github.com/okou-ai/okou/commit/1855ed7f5d58c7aa931a6acc27f2fa375edc395f))
* retire cooldown, ultrafast, us routing and model provider leftovers ([#37884](https://github.com/okou-ai/okou/issues/37884)) ([a9c3270](https://github.com/okou-ai/okou/commit/a9c3270099034c0f7ee73f6c730b07efa7d1d733))
* retire deepseek memory execution route ([#38193](https://github.com/okou-ai/okou/issues/38193)) ([dd70bd4](https://github.com/okou-ai/okou/commit/dd70bd4b01bd2ee0dbfbe748940544e5e072bf5a))
* retire organization custom model configuration ([#37746](https://github.com/okou-ai/okou/issues/37746)) ([014fe18](https://github.com/okou-ai/okou/commit/014fe1867c6d1830fd35b03c3d77491da5aaa36a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.546.0
</details>

<details><summary>db: 1.328.0</summary>

## [1.328.0](https://github.com/okou-ai/okou/compare/db-v1.327.1...db-v1.328.0) (2026-10-09)


### Features

* add sandbox covers for hosted artifacts ([#38149](https://github.com/okou-ai/okou/issues/38149)) ([f4a3140](https://github.com/okou-ai/okou/commit/f4a3140275a8c3334135080ed2427e837bc9fc89))
* **api:** prepare home cache affinity and runner state ([#38314](https://github.com/okou-ai/okou/issues/38314)) ([21ce097](https://github.com/okou-ai/okou/commit/21ce0978ad9a5bc7eddb94bc9d2bc25f1897095f))
* **api:** support organization openrouter preset overrides ([#37799](https://github.com/okou-ai/okou/issues/37799)) ([dacd31d](https://github.com/okou-ai/okou/commit/dacd31d031d98d45ccb3c6bd134f55b5f76063f4))
* **db:** add immutable catalog tables and a shared test catalog ([#37697](https://github.com/okou-ai/okou/issues/37697)) ([f24c015](https://github.com/okou-ai/okou/commit/f24c0158fb5d44fe002399bea74aaec8822bf2c0))
* **debug:** add morning brief test emails ([#38411](https://github.com/okou-ai/okou/issues/38411)) ([ce2f1d5](https://github.com/okou-ai/okou/commit/ce2f1d5b3ce2cad351d5515e38dee95d05d148c9))
* **desktop:** use clerk session tokens for native computer use ([#37965](https://github.com/okou-ai/okou/issues/37965)) ([fccd4a9](https://github.com/okou-ai/okou/commit/fccd4a98bb370bdaf9c8dd312988f5ba267bbb2c))
* materialize connector catalog entry query columns ([#37816](https://github.com/okou-ai/okou/issues/37816)) ([a032281](https://github.com/okou-ai/okou/commit/a032281cb085da66d271087211c94955748cb803))
* **notify:** add agent-controlled mail notifications ([#38093](https://github.com/okou-ai/okou/issues/38093)) ([702c270](https://github.com/okou-ai/okou/commit/702c270169c8de738aa9f47ed5480ed377edcfda))
* prepare model identity compatibility without switching writes ([#38092](https://github.com/okou-ai/okou/issues/38092)) ([21177df](https://github.com/okou-ai/okou/commit/21177dfd37bc19114098a628a094adb67fb60db0))


### Bug Fixes

* **api:** default organization model mode to auto ([#37745](https://github.com/okou-ai/okou/issues/37745)) ([0d679ea](https://github.com/okou-ai/okou/commit/0d679eacd13a934d407b7ed19bb9c138d04859e5))
* **api:** prepare memory revision writes for checkpoint contraction ([#38380](https://github.com/okou-ai/okou/issues/38380)) ([6389016](https://github.com/okou-ai/okou/commit/6389016d7baa395df1fe1d3587adb36c30dd4217))
* **api:** raise autonomous delegation budget to 32 ([#37737](https://github.com/okou-ai/okou/issues/37737)) ([f57a13f](https://github.com/okou-ai/okou/commit/f57a13f44233adb5b8469d0a039cb4befda9cf32))
* **api:** use luna with current memory owner credentials ([#38129](https://github.com/okou-ai/okou/issues/38129)) ([77357ab](https://github.com/okou-ai/okou/commit/77357abdb29ce96b2caf9ee679299602757844dc))
* **billing:** keep member usage packs nonnegative ([#38071](https://github.com/okou-ai/okou/issues/38071)) ([532c7f8](https://github.com/okou-ai/okou/commit/532c7f813cc2e824ff4fa487f251786848b8d752))


### Documentation

* keep reusable engineering standards and remove feature records ([#38387](https://github.com/okou-ai/okou/issues/38387)) ([6507d86](https://github.com/okou-ai/okou/commit/6507d86c83ca37e7a8790e4efd66eb6a84267295))
* prune feature records from deployment compatibility ([#38392](https://github.com/okou-ai/okou/issues/38392)) ([f2fae49](https://github.com/okou-ai/okou/commit/f2fae4953a98305d33373bae5a1d4a14de7c8e41))


### Refactoring

* **api:** migrate scoped connector selections to immutable entries ([#37699](https://github.com/okou-ai/okou/issues/37699)) ([f413782](https://github.com/okou-ai/okou/commit/f4137823742879fcc8f74b476734d18e8480e15c))
* **api:** read chat projections without historical runs ([#37765](https://github.com/okou-ai/okou/issues/37765)) ([dc7a9e7](https://github.com/okou-ai/okou/commit/dc7a9e7ef8b3c30ee3b1c828228bdd25b78e23c5))
* **api:** remove oauth contract hash bindings ([#38190](https://github.com/okou-ai/okou/issues/38190)) ([3e0f689](https://github.com/okou-ai/okou/commit/3e0f689475709a63a8ed534d11f34e583e8ac3f6))
* **api:** remove unused pi stable-context and report delisted connectors absent ([#37905](https://github.com/okou-ai/okou/issues/37905)) ([c339e73](https://github.com/okou-ai/okou/commit/c339e73f0fb5d0ca0a8f4a4e80c67331ea9fb79d))
* **api:** resolve queued connector permissions from current catalog ([#38066](https://github.com/okou-ai/okou/issues/38066)) ([865afb7](https://github.com/okou-ai/okou/commit/865afb7a05d413c9db56713035a373ebaa767672))
* **api:** retain artifacts independently of run deletion ([#37772](https://github.com/okou-ai/okou/issues/37772)) ([3921e38](https://github.com/okou-ai/okou/commit/3921e386f222a169e97c10046156758cc4e510b0))
* clean up released switch leftovers and drop legacy chat thread provider pins ([#37851](https://github.com/okou-ai/okou/issues/37851)) ([066e9c3](https://github.com/okou-ai/okou/commit/066e9c32c2bbd5e3d48783fb0028f8dcfbaeaf06))
* contract connector catalog storage to pointer and immutable entries ([#37886](https://github.com/okou-ai/okou/issues/37886)) ([baf302f](https://github.com/okou-ai/okou/commit/baf302f5373a000999dfde0abf521752a779e29c))
* **db:** drop retired native morning brief storage ([#37911](https://github.com/okou-ai/okou/issues/37911)) ([5531756](https://github.com/okou-ai/okou/commit/553175615d0b2f58508a4d437ae4a92b553e1e56))
* **db:** retire connector catalog payload column ([#38177](https://github.com/okou-ai/okou/issues/38177)) ([555f68c](https://github.com/okou-ai/okou/commit/555f68ce0c0f9d368dd922c0f17c3b8522f2ed16))
* prepare payload-independent connector catalog api ([#38099](https://github.com/okou-ai/okou/issues/38099)) ([9d3a1b4](https://github.com/okou-ai/okou/commit/9d3a1b406f1f44b224c33046162df01a77e035f8))
* remove abandoned langfuse trace feature ([#38010](https://github.com/okou-ai/okou/issues/38010)) ([5080d02](https://github.com/okou-ai/okou/commit/5080d026e68f10f41285570f52a9b655fb562052))
* remove all remaining custom model mode awareness ([#37856](https://github.com/okou-ai/okou/issues/37856)) ([f383835](https://github.com/okou-ai/okou/commit/f3838353ba0455ec7d57dfa2d0974e34a44796ff))
* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))
* remove remaining model provider residue ([#37870](https://github.com/okou-ai/okou/issues/37870)) ([a93133b](https://github.com/okou-ai/okou/commit/a93133b0493858a39924a1206ff5a5677e43cad6))
* represent auto model selection as null ([#37901](https://github.com/okou-ai/okou/issues/37901)) ([d0e0b71](https://github.com/okou-ai/okou/commit/d0e0b7191fe168e8935e1abf3df1fa1806efea2a))
* retire cooldown, ultrafast, us routing and model provider leftovers ([#37884](https://github.com/okou-ai/okou/issues/37884)) ([a9c3270](https://github.com/okou-ai/okou/commit/a9c3270099034c0f7ee73f6c730b07efa7d1d733))
* retire deepseek memory execution route ([#38193](https://github.com/okou-ai/okou/issues/38193)) ([dd70bd4](https://github.com/okou-ai/okou/commit/dd70bd4b01bd2ee0dbfbe748940544e5e072bf5a))
* retire generic run checkpoints from completion ([#38147](https://github.com/okou-ai/okou/issues/38147)) ([e8002cf](https://github.com/okou-ai/okou/commit/e8002cfcc9995e2b245947dbf25a9f9dd73f1ca0))
* retire organization custom model configuration ([#37746](https://github.com/okou-ai/okou/issues/37746)) ([014fe18](https://github.com/okou-ai/okou/commit/014fe1867c6d1830fd35b03c3d77491da5aaa36a))
* retire organization usage allowance ([#37971](https://github.com/okou-ai/okou/issues/37971)) ([2659878](https://github.com/okou-ai/okou/commit/26598788903fb817edd71d82ccbdfcd66cfa3a0a))


### Performance Improvements

* **api:** read connector catalog from purpose-specific columns ([#37900](https://github.com/okou-ai/okou/issues/37900)) ([8c38a39](https://github.com/okou-ai/okou/commit/8c38a399d41d0786e6450e78a897d1de01892a58))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.546.0
    * @okouai/core bumped to 8.739.0
</details>

<details><summary>host-worker: 1.6.0</summary>

## [1.6.0](https://github.com/okou-ai/okou/compare/host-worker-v1.5.130...host-worker-v1.6.0) (2026-10-09)


### Features

* add permission-aware artifact og previews ([#38361](https://github.com/okou-ai/okou/issues/38361)) ([2ef5d4e](https://github.com/okou-ai/okou/commit/2ef5d4ec8c2aedc9217e669f110f8c68fb9b65f3))


### Bug Fixes

* **host:** prepare canonical deployment delivery authority ([#38212](https://github.com/okou-ai/okou/issues/38212)) ([bd8b130](https://github.com/okou-ai/okou/commit/bd8b13065d6b8ce406c3c7659f6634528f794913))


### Refactoring

* **artifacts:** remove video poster extraction ([#38146](https://github.com/okou-ai/okou/issues/38146)) ([641cf0d](https://github.com/okou-ai/okou/commit/641cf0ddff6c631cf94386e6c3d26c78395c63aa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.546.0
    * @okouai/core bumped to 8.739.0
</details>

<details><summary>pi-agent-runtime: 1.49.0</summary>

## [1.49.0](https://github.com/okou-ai/okou/compare/pi-agent-runtime-v1.48.3...pi-agent-runtime-v1.49.0) (2026-10-09)


### Features

* make pi memory free with an openrouter preset ([#38290](https://github.com/okou-ai/okou/issues/38290)) ([5768ad5](https://github.com/okou-ai/okou/commit/5768ad5ef7ce0808c6cde85a9eb628be7e8aeb57))
* **pi:** route openrouter through chat completions behind a switch ([#37987](https://github.com/okou-ai/okou/issues/37987)) ([df136ee](https://github.com/okou-ai/okou/commit/df136ee82546c76d79575e203c7257371ea5b3cb))
* prepare model identity compatibility without switching writes ([#38092](https://github.com/okou-ai/okou/issues/38092)) ([21177df](https://github.com/okou-ai/okou/commit/21177dfd37bc19114098a628a094adb67fb60db0))


### Bug Fixes

* **api:** use luna with current memory owner credentials ([#38129](https://github.com/okou-ai/okou/issues/38129)) ([77357ab](https://github.com/okou-ai/okou/commit/77357abdb29ce96b2caf9ee679299602757844dc))
* classify codex cybersecurity safety refusals ([#37945](https://github.com/okou-ai/okou/issues/37945)) ([5693b80](https://github.com/okou-ai/okou/commit/5693b806ad5a55154a8e9f3d7b3bb5de727624e2))
* distinguish shared instructions from personal memory ([#38072](https://github.com/okou-ai/okou/issues/38072)) ([ce08549](https://github.com/okou-ai/okou/commit/ce085495f43d88f6d6197532e6c15ca634889ae2))
* **pi:** bound duplicate turn-end stdout records ([#37963](https://github.com/okou-ai/okou/issues/37963)) ([77bae8a](https://github.com/okou-ai/okou/commit/77bae8a42fbda3957404b26210c57f73861c182b))


### Documentation

* keep reusable engineering standards and remove feature records ([#38387](https://github.com/okou-ai/okou/issues/38387)) ([6507d86](https://github.com/okou-ai/okou/commit/6507d86c83ca37e7a8790e4efd66eb6a84267295))
* prune feature records from deployment compatibility ([#38392](https://github.com/okou-ai/okou/issues/38392)) ([f2fae49](https://github.com/okou-ai/okou/commit/f2fae4953a98305d33373bae5a1d4a14de7c8e41))


### Refactoring

* **api:** own pi memory provider admission ([#38292](https://github.com/okou-ai/okou/issues/38292)) ([37d4265](https://github.com/okou-ai/okou/commit/37d426591dcb5d7aff864044468ea2148d89b6d1))
* remove abandoned langfuse trace feature ([#38010](https://github.com/okou-ai/okou/issues/38010)) ([5080d02](https://github.com/okou-ai/okou/commit/5080d026e68f10f41285570f52a9b655fb562052))
* remove all remaining custom model mode awareness ([#37856](https://github.com/okou-ai/okou/issues/37856)) ([f383835](https://github.com/okou-ai/okou/commit/f3838353ba0455ec7d57dfa2d0974e34a44796ff))
* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))
* remove remaining model provider residue ([#37870](https://github.com/okou-ai/okou/issues/37870)) ([a93133b](https://github.com/okou-ai/okou/commit/a93133b0493858a39924a1206ff5a5677e43cad6))
* retire cooldown, ultrafast, us routing and model provider leftovers ([#37884](https://github.com/okou-ai/okou/issues/37884)) ([a9c3270](https://github.com/okou-ai/okou/commit/a9c3270099034c0f7ee73f6c730b07efa7d1d733))
* retire deepseek memory execution route ([#38193](https://github.com/okou-ai/okou/issues/38193)) ([dd70bd4](https://github.com/okou-ai/okou/commit/dd70bd4b01bd2ee0dbfbe748940544e5e072bf5a))
* retire organization custom model configuration ([#37746](https://github.com/okou-ai/okou/issues/37746)) ([014fe18](https://github.com/okou-ai/okou/commit/014fe1867c6d1830fd35b03c3d77491da5aaa36a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.546.0
  * devDependencies
    * @okouai/core bumped to 8.739.0
</details>

<details><summary>api: 1.721.0</summary>

## [1.721.0](https://github.com/okou-ai/okou/compare/api-v1.720.1...api-v1.721.0) (2026-10-09)


### Features

* add permission-aware artifact og previews ([#38361](https://github.com/okou-ai/okou/issues/38361)) ([2ef5d4e](https://github.com/okou-ai/okou/commit/2ef5d4ec8c2aedc9217e669f110f8c68fb9b65f3))
* add sandbox covers for hosted artifacts ([#38149](https://github.com/okou-ai/okou/issues/38149)) ([f4a3140](https://github.com/okou-ai/okou/commit/f4a3140275a8c3334135080ed2427e837bc9fc89))
* add subscription controls and user-confirmed reset cards ([#37763](https://github.com/okou-ai/okou/issues/37763)) ([d9a0b29](https://github.com/okou-ai/okou/commit/d9a0b29aeb0866740540f5e970fcbf80709342d7))
* allow debug admins to clear organization openrouter presets ([#38407](https://github.com/okou-ai/okou/issues/38407)) ([a1464ca](https://github.com/okou-ai/okou/commit/a1464ca1752a1aa3247485b1582604ef10a276d1))
* allow debug admins to switch organization openrouter presets ([#38327](https://github.com/okou-ai/okou/issues/38327)) ([3ab4dfc](https://github.com/okou-ai/okou/commit/3ab4dfc68ffdf7afe085c52e3cf9040354c117d9))
* **api:** prepare home cache affinity and runner state ([#38314](https://github.com/okou-ai/okou/issues/38314)) ([21ce097](https://github.com/okou-ai/okou/commit/21ce0978ad9a5bc7eddb94bc9d2bc25f1897095f))
* **api:** prepare immutable catalog before hash-cas activation ([#37701](https://github.com/okou-ai/okou/issues/37701)) ([b8da8bd](https://github.com/okou-ai/okou/commit/b8da8bd6292a3a436f3f501316d2fa05770ec436))
* **api:** require desktop 0.51.0 for computer use admission ([#38390](https://github.com/okou-ai/okou/issues/38390)) ([97be706](https://github.com/okou-ai/okou/commit/97be706f45fc34d0ae9f9f408b9c48a58da03b19))
* **api:** support organization openrouter preset overrides ([#37799](https://github.com/okou-ai/okou/issues/37799)) ([dacd31d](https://github.com/okou-ai/okou/commit/dacd31d031d98d45ccb3c6bd134f55b5f76063f4))
* **api:** switch auto writers to captured runtime billing ([#38270](https://github.com/okou-ai/okou/issues/38270)) ([e34e331](https://github.com/okou-ai/okou/commit/e34e3319db818fa89f928b7c8dc21e3536714c86))
* **core:** release eleven staff feature switches to all users ([#37818](https://github.com/okou-ai/okou/issues/37818)) ([8d05119](https://github.com/okou-ai/okou/commit/8d051194184d595b67f78f5d6f7ec728ed6cc31d))
* **db:** add immutable catalog tables and a shared test catalog ([#37697](https://github.com/okou-ai/okou/issues/37697)) ([f24c015](https://github.com/okou-ai/okou/commit/f24c0158fb5d44fe002399bea74aaec8822bf2c0))
* **debug:** add morning brief test emails ([#38411](https://github.com/okou-ai/okou/issues/38411)) ([ce2f1d5](https://github.com/okou-ai/okou/commit/ce2f1d5b3ce2cad351d5515e38dee95d05d148c9))
* **desktop:** enforce minimum versions with automatic required upgrades ([#38115](https://github.com/okou-ai/okou/issues/38115)) ([ae3a5b2](https://github.com/okou-ai/okou/commit/ae3a5b291a085bd900c21689563c74240c4123cb))
* **desktop:** replace electron with native swift desktop ([#37889](https://github.com/okou-ai/okou/issues/37889)) ([303d7bc](https://github.com/okou-ai/okou/commit/303d7bc2e3176b02c66ca3ef1c9c9b0eb2bb7700))
* **desktop:** use clerk session tokens for native computer use ([#37965](https://github.com/okou-ai/okou/issues/37965)) ([fccd4a9](https://github.com/okou-ai/okou/commit/fccd4a98bb370bdaf9c8dd312988f5ba267bbb2c))
* enable phone group history, message sharing and social jobs globally ([#37716](https://github.com/okou-ai/okou/issues/37716)) ([b1ec157](https://github.com/okou-ai/okou/commit/b1ec157db9ded38688563e0f153df0ab8364802e))
* enable private artifacts for all users ([#37951](https://github.com/okou-ai/okou/issues/37951)) ([91e19d1](https://github.com/okou-ai/okou/commit/91e19d1e55e49ffb5822aa2a9d7fcb336b9cb9cf))
* make pi memory free with an openrouter preset ([#38290](https://github.com/okou-ai/okou/issues/38290)) ([5768ad5](https://github.com/okou-ai/okou/commit/5768ad5ef7ce0808c6cde85a9eb628be7e8aeb57))
* materialize connector catalog entry query columns ([#37816](https://github.com/okou-ai/okou/issues/37816)) ([a032281](https://github.com/okou-ai/okou/commit/a032281cb085da66d271087211c94955748cb803))
* **mcp:** track chat inputs by their original event id ([#37759](https://github.com/okou-ai/okou/issues/37759)) ([1375385](https://github.com/okou-ai/okou/commit/137538594d42aa2942187acee4ac713c6c308112))
* **notify:** add agent-controlled mail notifications ([#38093](https://github.com/okou-ai/okou/issues/38093)) ([702c270](https://github.com/okou-ai/okou/commit/702c270169c8de738aa9f47ed5480ed377edcfda))
* **notify:** add morning brief notification kind ([#38308](https://github.com/okou-ai/okou/issues/38308)) ([31d9036](https://github.com/okou-ai/okou/commit/31d9036dcb2e6a005ebbdb250a3b216ce713c51c))
* **pi:** route openrouter through chat completions behind a switch ([#37987](https://github.com/okou-ai/okou/issues/37987)) ([df136ee](https://github.com/okou-ai/okou/commit/df136ee82546c76d79575e203c7257371ea5b3cb))
* prepare model identity compatibility without switching writes ([#38092](https://github.com/okou-ai/okou/issues/38092)) ([21177df](https://github.com/okou-ai/okou/commit/21177dfd37bc19114098a628a094adb67fb60db0))


### Bug Fixes

* **api:** allow sandbox tokens to read the model catalog ([#37773](https://github.com/okou-ai/okou/issues/37773)) ([936ccb3](https://github.com/okou-ai/okou/commit/936ccb30e40aa238c19f7045462f5709099ec079))
* **api:** bind stripe customers with an atomic upsert ([#38126](https://github.com/okou-ai/okou/issues/38126)) ([282b045](https://github.com/okou-ai/okou/commit/282b045539de6636eea6691581f5cff0626ff235))
* **api:** consume unread state for external notification delivery ([#37751](https://github.com/okou-ai/okou/issues/37751)) ([caba8a3](https://github.com/okou-ai/okou/commit/caba8a39eea743b843142046f5d5ba588afdc710))
* **api:** default organization model mode to auto ([#37745](https://github.com/okou-ai/okou/issues/37745)) ([0d679ea](https://github.com/okou-ai/okou/commit/0d679eacd13a934d407b7ed19bb9c138d04859e5))
* **api:** exclude inline-only agentphone callbacks ([#37996](https://github.com/okou-ai/okou/issues/37996)) ([a9ca48e](https://github.com/okou-ai/okou/commit/a9ca48ebfca4c9222052ccaa4268f1f513e921e9))
* **api:** grant onboarding credits as personal usage packs ([#38059](https://github.com/okou-ai/okou/issues/38059)) ([6798f0a](https://github.com/okou-ai/okou/commit/6798f0a0a233331d18f384ec9d81608c3bd060f1))
* **api:** handle attached schedules in billing previews ([#38065](https://github.com/okou-ai/okou/issues/38065)) ([f590586](https://github.com/okou-ai/okou/commit/f5905861eb85c3492d072255ee2fea35118ba48f))
* **api:** ignore non-completed workflow job webhooks ([#38395](https://github.com/okou-ai/okou/issues/38395)) ([adbed2f](https://github.com/okou-ai/okou/commit/adbed2f709d35cae7273789ce098569f32421eba))
* **api:** keep successful schedule expiry below warning ([#37998](https://github.com/okou-ai/okou/issues/37998)) ([e2bb3de](https://github.com/okou-ai/okou/commit/e2bb3de9bfc8a59202a9572264e8010d3e065a7b))
* **api:** keep usage pack webhook reads in one snapshot ([#38286](https://github.com/okou-ai/okou/issues/38286)) ([5712d95](https://github.com/okou-ai/okou/commit/5712d9550317d811e0e2e66f2611f835a619ec7b))
* **api:** name agent in connector authorization error ([#38005](https://github.com/okou-ai/okou/issues/38005)) ([52d5fd1](https://github.com/okou-ai/okou/commit/52d5fd130fd02857522b7a95f06f5dc8bb331e86))
* **api:** omit agent-enabled connectors missing from the catalog instead of rejecting the run ([#37893](https://github.com/okou-ai/okou/issues/37893)) ([3ff1f40](https://github.com/okou-ai/okou/commit/3ff1f404e2b2908ddc3a39dff60abe1e12177d90))
* **api:** persist initial file share revocations ([#38015](https://github.com/okou-ai/okou/issues/38015)) ([61b9112](https://github.com/okou-ai/okou/commit/61b91126a88149de8aaa3dd196e1d4af092a91c1))
* **api:** prepare memory revision writes for checkpoint contraction ([#38380](https://github.com/okou-ai/okou/issues/38380)) ([6389016](https://github.com/okou-ai/okou/commit/6389016d7baa395df1fe1d3587adb36c30dd4217))
* **api:** raise autonomous delegation budget to 32 ([#37737](https://github.com/okou-ai/okou/issues/37737)) ([f57a13f](https://github.com/okou-ai/okou/commit/f57a13f44233adb5b8469d0a039cb4befda9cf32))
* **api:** refresh archive urls with less than four hours remaining ([#37735](https://github.com/okou-ai/okou/issues/37735)) ([b6e6d02](https://github.com/okou-ai/okou/commit/b6e6d02418c07f713a95c29313671a65f3a82643))
* **api:** remove chat input and auxiliary write latency warnings ([#38318](https://github.com/okou-ai/okou/issues/38318)) ([7a61cc2](https://github.com/okou-ai/okou/commit/7a61cc21582c21782ac307a7a945941d334bcf65))
* **api:** remove cloudflare mutation transaction retries ([#38282](https://github.com/okou-ai/okou/issues/38282)) ([d99e140](https://github.com/okou-ai/okou/commit/d99e140bd25233b4e009b8a074aaf9b63e8b164a))
* **api:** stop warning on expected queued input rejections ([#37974](https://github.com/okou-ai/okou/issues/37974)) ([2443e7b](https://github.com/okou-ai/okou/commit/2443e7b20d23d60dddd9cf9613f3242a113d7d33))
* **api:** suppress web push for channel-triggered chat runs ([#37726](https://github.com/okou-ai/okou/issues/37726)) ([6e471ef](https://github.com/okou-ai/okou/commit/6e471efd37b31b216bfa35ea0ad5681142f087bb))
* **api:** treat connectors missing from the catalog as unauthorized everywhere ([#37898](https://github.com/okou-ai/okou/issues/37898)) ([d281779](https://github.com/okou-ai/okou/commit/d28177961e86fd7cc41c62a0c0749e61a1859867))
* **api:** use luna with current memory owner credentials ([#38129](https://github.com/okou-ai/okou/issues/38129)) ([77357ab](https://github.com/okou-ai/okou/commit/77357abdb29ce96b2caf9ee679299602757844dc))
* **app:** scope account connections and release multiple subscriptions ([#37714](https://github.com/okou-ai/okou/issues/37714)) ([db0d2ad](https://github.com/okou-ai/okou/commit/db0d2adf4400029a95f1a07fd6c50e48a7e4417e))
* **billing:** keep member usage packs nonnegative ([#38071](https://github.com/okou-ai/okou/issues/38071)) ([532c7f8](https://github.com/okou-ai/okou/commit/532c7f813cc2e824ff4fa487f251786848b8d752))
* distinguish shared instructions from personal memory ([#38072](https://github.com/okou-ai/okou/issues/38072)) ([ce08549](https://github.com/okou-ai/okou/commit/ce085495f43d88f6d6197532e6c15ca634889ae2))
* **host:** prepare canonical deployment delivery authority ([#38212](https://github.com/okou-ai/okou/issues/38212)) ([bd8b130](https://github.com/okou-ai/okou/commit/bd8b13065d6b8ce406c3c7659f6634528f794913))
* **integrations:** hide auto model attribution in message footers ([#37959](https://github.com/okou-ai/okou/issues/37959)) ([46a2d1a](https://github.com/okou-ai/okou/commit/46a2d1a044c0d48829d2879c689539ccfea64a65))
* **maps:** explain oversized grounding responses ([#38046](https://github.com/okou-ai/okou/issues/38046)) ([9ea9cde](https://github.com/okou-ai/okou/commit/9ea9cde34b01d89bb258b44250ce4b17260cf37c)), closes [#36791](https://github.com/okou-ai/okou/issues/36791)
* rewrite retired thread models to their replacement ([#37906](https://github.com/okou-ai/okou/issues/37906)) ([eb98c63](https://github.com/okou-ai/okou/commit/eb98c63635aa78f7c9c79ef8e24a382e9c2d1077))
* **seo:** preserve dataforseo partial serp results ([#37961](https://github.com/okou-ai/okou/issues/37961)) ([b5d9654](https://github.com/okou-ai/okou/commit/b5d96542a902d7cad11325c86966f49746e41172))
* **ssh:** fence cloudflare bindings with host-first mutations ([#37955](https://github.com/okou-ai/okou/issues/37955)) ([42935d1](https://github.com/okou-ai/okou/commit/42935d1cc0181aa3bfa6a571ceb8059282d292ae))
* stop reporting handled clerk ui and invalid workflow payload errors ([#38299](https://github.com/okou-ai/okou/issues/38299)) ([d138629](https://github.com/okou-ai/okou/commit/d13862990122a1309790326f956e5b093faa73ad))
* suppress pwa push while the user is foreground in the same org ([#38091](https://github.com/okou-ai/okou/issues/38091)) ([22f89a5](https://github.com/okou-ai/okou/commit/22f89a5c8b69990bb3834c7678acb25f00d1c823))
* **voice:** separate segment transcription from final polish ([#38082](https://github.com/okou-ai/okou/issues/38082)) ([1c7cb86](https://github.com/okou-ai/okou/commit/1c7cb86855d50504a57a6fcb86b9357a5965e3de))


### CI

* remove production release catalog sync ([#38230](https://github.com/okou-ai/okou/issues/38230)) ([1a51a67](https://github.com/okou-ai/okou/commit/1a51a6731107a55a1adc4d34160860f186c96758))


### Documentation

* consolidate official morning brief contracts ([#38297](https://github.com/okou-ai/okou/issues/38297)) ([1b853f2](https://github.com/okou-ai/okou/commit/1b853f27e087c5e3e5ba7a8d6607333079760826))
* keep reusable engineering standards and remove feature records ([#38387](https://github.com/okou-ai/okou/issues/38387)) ([6507d86](https://github.com/okou-ai/okou/commit/6507d86c83ca37e7a8790e4efd66eb6a84267295))
* remove morning brief feature documentation ([#38378](https://github.com/okou-ai/okou/issues/38378)) ([2fcd479](https://github.com/okou-ai/okou/commit/2fcd479e176f6ce6fbb8c27950a72c0643eb0e2b))


### Refactoring

* **api:** atomically fail pi memory phase2 leases ([#38014](https://github.com/okou-ai/okou/issues/38014)) ([93231f6](https://github.com/okou-ai/okou/commit/93231f634b4145feb48dc93daa74da0864e63667))
* **api:** build pi cleanup predicates without db handles ([#38333](https://github.com/okou-ai/okou/issues/38333)) ([9f09dc5](https://github.com/okou-ai/okou/commit/9f09dc556b34a95eaae3668436274da8ec0cc40f))
* **api:** claim official workflow work atomically ([#38041](https://github.com/okou-ai/okou/issues/38041)) ([b6befac](https://github.com/okou-ai/okou/commit/b6befacb367f900e0da9c1159bfa60e66a34d6f9))
* **api:** derive connector prompts from bootstrap authorization ([#38228](https://github.com/okou-ai/okou/issues/38228)) ([4c016da](https://github.com/okou-ai/okou/commit/4c016da6694e286c9a471536b020f0dcd6ace8cd))
* **api:** encapsulate continuation and template preparation ([#38155](https://github.com/okou-ai/okou/issues/38155)) ([207088f](https://github.com/okou-ai/okou/commit/207088f19c5df05553c233d8a0ccbaf195fb0314))
* **api:** extract integration and session rotation prompts ([#38119](https://github.com/okou-ai/okou/issues/38119)) ([8418b0d](https://github.com/okou-ai/okou/commit/8418b0d73d57b2e6f2d18234e262f9527ed9e006))
* **api:** finish storage worker and timestamp ownership ([#38194](https://github.com/okou-ai/okou/issues/38194)) ([4729e51](https://github.com/okou-ai/okou/commit/4729e51f8cc5261e1badcd7cd96b14b82b1918d7))
* **api:** give catalog commands database ownership ([#38037](https://github.com/okou-ai/okou/issues/38037)) ([6f7b47c](https://github.com/okou-ai/okou/commit/6f7b47c2bd8892d2ea82908114a5e36bf0597819))
* **api:** inline clerk lifecycle transaction ownership ([#38171](https://github.com/okou-ai/okou/issues/38171)) ([50f91be](https://github.com/okou-ai/okou/commit/50f91befb0bacd4d7c166ace839251a648bd4bf9)), closes [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** inline web input transaction writes ([#38183](https://github.com/okou-ai/okou/issues/38183)) ([4d6305f](https://github.com/okou-ai/okou/commit/4d6305f2693f022cc05f6d4d3d9c02086cfbd443))
* **api:** localize billing checkout database ownership ([#38090](https://github.com/okou-ai/okou/issues/38090)) ([75f4a8c](https://github.com/okou-ai/okou/commit/75f4a8ca5f1cd5aaee8c6016650f7c900460b22d))
* **api:** localize credit checkout database ownership ([#38133](https://github.com/okou-ai/okou/issues/38133)) ([c903605](https://github.com/okou-ai/okou/commit/c903605cc80af3f68c9896ccf65203a53adcd9ec)), closes [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** make plan purchase exclusion a pure sql builder ([#38151](https://github.com/okou-ai/okou/issues/38151)) ([669d03a](https://github.com/okou-ai/okou/commit/669d03a9cb7ad9b8db0f8c936dbef3a4c7b2f823)), closes [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** migrate auxiliary gemini generation to vertex ai ([#37792](https://github.com/okou-ai/okou/issues/37792)) ([7d5660d](https://github.com/okou-ai/okou/commit/7d5660d2fabe4497b352b4a74e77ac0ab67ffa3c))
* **api:** migrate projection readers to slug-first current entries ([#37808](https://github.com/okou-ai/okou/issues/37808)) ([8850112](https://github.com/okou-ai/okou/commit/88501125e1390528e09386d3148028c32c82ba65))
* **api:** migrate scoped connector selections to immutable entries ([#37699](https://github.com/okou-ai/okou/issues/37699)) ([f413782](https://github.com/okou-ai/okou/commit/f4137823742879fcc8f74b476734d18e8480e15c))
* **api:** move desktop version policy into source control ([#38372](https://github.com/okou-ai/okou/issues/38372)) ([0d20c41](https://github.com/okou-ai/okou/commit/0d20c414e1cefa1642d8eed98f2eb15fc5a97499))
* **api:** own agent builtin connector configuration writes ([#37729](https://github.com/okou-ai/okou/issues/37729)) ([2edb8d8](https://github.com/okou-ai/okou/commit/2edb8d8f0bde8bcf1ebb89388c08e31bcecdc9de))
* **api:** own agent instruction lifecycle transactions ([#38172](https://github.com/okou-ai/okou/issues/38172)) ([e15eeea](https://github.com/okou-ai/okou/commit/e15eeeac9ea25d50335d408ccec3572072e3e6e1))
* **api:** own atomic pi memory stage1 result commits ([#38202](https://github.com/okou-ai/okou/issues/38202)) ([bf452e6](https://github.com/okou-ai/okou/commit/bf452e611c290a8284fb44dcbfcb8f213529df8d))
* **api:** own automation watch source queries ([#38203](https://github.com/okou-ai/okou/issues/38203)) ([5a9c95d](https://github.com/okou-ai/okou/commit/5a9c95daa2ae539adb63ba12f2213e40fd2023f7))
* **api:** own canonical asset state and input registration ([#38052](https://github.com/okou-ai/okou/issues/38052)) ([93f9439](https://github.com/okou-ai/okou/commit/93f9439fe1c9a4425710825265d76df539a93623))
* **api:** own chat-run-finished budget and receipt reads ([#38271](https://github.com/okou-ai/okou/issues/38271)) ([424678d](https://github.com/okou-ai/okou/commit/424678d61fb1c53c073df6ea7d07f30796a0d25e))
* **api:** own completion initial run read ([#37732](https://github.com/okou-ai/okou/issues/37732)) ([6f073f9](https://github.com/okou-ai/okou/commit/6f073f9cf22637cceaa7715ed206f7014e511e64))
* **api:** own completion postcommit callback read ([#37717](https://github.com/okou-ai/okou/issues/37717)) ([caddf45](https://github.com/okou-ai/okou/commit/caddf459b1af9dedd4ab9ecc99d96bf228b720b0))
* **api:** own connector account default-transition writes ([#38276](https://github.com/okou-ai/okou/issues/38276)) ([9aae815](https://github.com/okou-ai/okou/commit/9aae815c4a30cea1f89ae133c54d5ed9922a3dac))
* **api:** own connector account deletion-impact reads ([#37743](https://github.com/okou-ai/okou/issues/37743)) ([fb850a0](https://github.com/okou-ai/okou/commit/fb850a0aa034404f573a778563a97d39312453c5))
* **api:** own connector authorization-target reads ([#38394](https://github.com/okou-ai/okou/issues/38394)) ([9d97dd2](https://github.com/okou-ai/okou/commit/9d97dd2090a9c5190093efb942f3090765a17206))
* **api:** own custom connector connected-account reads ([#37815](https://github.com/okou-ai/okou/issues/37815)) ([1094540](https://github.com/okou-ai/okou/commit/1094540ade0b2613c7b7c2fd364049a04cb4a9d2))
* **api:** own custom connector current-value marker reads ([#37753](https://github.com/okou-ai/okou/issues/37753)) ([4085a06](https://github.com/okou-ai/okou/commit/4085a06a91b5355b656e4d8d37e39172a8342a28))
* **api:** own custom oauth state preview reads ([#38189](https://github.com/okou-ai/okou/issues/38189)) ([91a7384](https://github.com/okou-ai/okou/commit/91a7384611dc0fc6d09fe30462e0a6674ca4100f))
* **api:** own discord cleanup and gateway lifecycle writes ([#38087](https://github.com/okou-ai/okou/issues/38087)) ([b73d44a](https://github.com/okou-ai/okou/commit/b73d44a9a9e52185c50f968ced4f5cfb12584093))
* **api:** own discord preview history writes ([#38417](https://github.com/okou-ai/okou/issues/38417)) ([b4e236f](https://github.com/okou-ai/okou/commit/b4e236fe839aa0e1c302a61054e875c61f68f961))
* **api:** own exact personal subscription response reads ([#38001](https://github.com/okou-ai/okou/issues/38001)) ([43a459d](https://github.com/okou-ai/okou/commit/43a459d7515045560e47ccb0abf66e35dce16274))
* **api:** own failed-run subscription recovery identity reads ([#38076](https://github.com/okou-ai/okou/issues/38076)) ([34fb156](https://github.com/okou-ai/okou/commit/34fb156b989d01cd6c1d382351db8957bab96e20))
* **api:** own google meet database access in signals ([#38040](https://github.com/okou-ai/okou/issues/38040)) ([eddec23](https://github.com/okou-ai/okou/commit/eddec239bfe6ae428d33800996f4286ace06bc06))
* **api:** own guarded sandbox storage replay version reads ([#37760](https://github.com/okou-ai/okou/issues/37760)) ([2521e92](https://github.com/okou-ai/okou/commit/2521e9231ef2dff5bc147580d93bea8405f8c874))
* **api:** own hosted-site reads and allocation queries ([#38218](https://github.com/okou-ai/okou/issues/38218)) ([2c1f7e7](https://github.com/okou-ai/okou/commit/2c1f7e7477a5ad5a72e2346bc78df2153c499d1c))
* **api:** own initial agent deletion read ([#37783](https://github.com/okou-ai/okou/issues/37783)) ([c0e8f66](https://github.com/okou-ai/okou/commit/c0e8f661e10f5d464cc271d97d95df904b13c196))
* **api:** own initial checkpoint run reads ([#37738](https://github.com/okou-ai/okou/issues/37738)) ([126a395](https://github.com/okou-ai/okou/commit/126a3957d91de7872daeaf892a8acb604b0ba0f6))
* **api:** own initial sandbox storage receipt reads ([#37748](https://github.com/okou-ai/okou/issues/37748)) ([1fc92ce](https://github.com/okou-ai/okou/commit/1fc92ce471a5700c6eb4bae9cb144f435e3e60c2))
* **api:** own morning brief preference reads ([#38211](https://github.com/okou-ai/okou/issues/38211)) ([e421739](https://github.com/okou-ai/okou/commit/e42173971274448bcc8afb541cc4b7208bfe80e2))
* **api:** own oauth completion receipt reads ([#38302](https://github.com/okou-ai/okou/issues/38302)) ([bcbdb54](https://github.com/okou-ai/okou/commit/bcbdb54cd47bb83e43e4738097724c9c2ebc47d5))
* **api:** own oauth completion receipt writes ([#38349](https://github.com/okou-ai/okou/issues/38349)) ([d73778c](https://github.com/okou-ai/okou/commit/d73778c30b09c35fcd6ae4d7bef943e19872bdac))
* **api:** own official catalog execution reads ([#38195](https://github.com/okou-ai/okou/issues/38195)) ([7fad614](https://github.com/okou-ai/okou/commit/7fad61491780e3eb0d1be79353e6ec1ef056160f))
* **api:** own official result email callback sources ([#38220](https://github.com/okou-ai/okou/issues/38220)) ([21abaa2](https://github.com/okou-ai/okou/commit/21abaa2843c193c4928ce7e907f16feb529d2db2))
* **api:** own official workflow catalog publication ([#38033](https://github.com/okou-ai/okou/issues/38033)) ([11e3830](https://github.com/okou-ai/okou/commit/11e383050897d7d63f36d0aaf8bb1796e73ec018))
* **api:** own official workflow installation writes ([#38050](https://github.com/okou-ai/okou/issues/38050)) ([cfe934c](https://github.com/okou-ai/okou/commit/cfe934c79e7220da9c9a7913186ebd8ccbc5036a))
* **api:** own official workflow reconciliation commands ([#38056](https://github.com/okou-ai/okou/issues/38056)) ([1f88668](https://github.com/okou-ai/okou/commit/1f8866885baf48dcbfbf11cca37def52529cfc49))
* **api:** own official workflow reconciliation transactions ([#38170](https://github.com/okou-ai/okou/issues/38170)) ([7fdd681](https://github.com/okou-ai/okou/commit/7fdd6812fb11c08d244b3eca9ee18d7edf067112))
* **api:** own parallel agent connector scope reads ([#38117](https://github.com/okou-ai/okou/issues/38117)) ([7fe8278](https://github.com/okou-ai/okou/commit/7fe8278fb7dc3581f50bf8d77d7cd19fbb9db8e0))
* **api:** own permission-grant list database reads ([#37910](https://github.com/okou-ai/okou/issues/37910)) ([1a4cbda](https://github.com/okou-ai/okou/commit/1a4cbda1d901006994149202b74d5135d8b74f6d))
* **api:** own personal subscription account activation queries ([#37949](https://github.com/okou-ai/okou/issues/37949)) ([9206b1c](https://github.com/okou-ai/okou/commit/9206b1cff0529de4f84d6283823c8658df0a57f6))
* **api:** own personal subscription account-list reads ([#37923](https://github.com/okou-ai/okou/issues/37923)) ([0588672](https://github.com/okou-ai/okou/commit/0588672c5341c997f3074eab210c640329fa6a9e))
* **api:** own pi maintenance preparation snapshots ([#38205](https://github.com/okou-ai/okou/issues/38205)) ([eb2214d](https://github.com/okou-ai/okou/commit/eb2214d14903c83b68e06518debf70dabad82b3b))
* **api:** own pi memory maintenance admission transactions ([#38214](https://github.com/okou-ai/okou/issues/38214)) ([aa2cbc3](https://github.com/okou-ai/okou/commit/aa2cbc3700fbad19a43f3eef1492bca094e7523a))
* **api:** own pi memory phase2 claim transaction ([#38055](https://github.com/okou-ai/okou/issues/38055)) ([b917942](https://github.com/okou-ai/okou/commit/b91794262fa14780372d3cc5bb5c1b1fddbf18b7))
* **api:** own pi memory phase2 terminal observation ([#38054](https://github.com/okou-ai/okou/issues/38054)) ([e84363a](https://github.com/okou-ai/okou/commit/e84363a75b9e0236edf8e96c27f1b9a1d938cb08))
* **api:** own pi memory provider admission ([#38292](https://github.com/okou-ai/okou/issues/38292)) ([37d4265](https://github.com/okou-ai/okou/commit/37d426591dcb5d7aff864044468ea2148d89b6d1))
* **api:** own pi memory quota reads ([#38061](https://github.com/okou-ai/okou/issues/38061)) ([e75dacd](https://github.com/okou-ai/okou/commit/e75dacdb59c2bdc019b28f8742c3d19c7824bde8))
* **api:** own pi memory scheduling and claim transactions ([#38269](https://github.com/okou-ai/okou/issues/38269)) ([cdeec87](https://github.com/okou-ai/okou/commit/cdeec8712c65b885ed8b9c8e62c50a0127d6783f))
* **api:** own pi memory stage 1 preflight queries ([#38226](https://github.com/okou-ai/okou/issues/38226)) ([1cd9eff](https://github.com/okou-ai/okou/commit/1cd9eff56f912f5c177c6fe63e6ab19f2ee3693a))
* **api:** own pi memory stage1 accounting ([#38053](https://github.com/okou-ai/okou/issues/38053)) ([2371910](https://github.com/okou-ai/okou/commit/2371910b887fca12b4220ae7941d84a588e3c656))
* **api:** own pi memory stage1 credential commands ([#38210](https://github.com/okou-ai/okou/issues/38210)) ([9ee013b](https://github.com/okou-ai/okou/commit/9ee013bab9e2f3a53e2d063816955b84c6d66fb5))
* **api:** own pi phase2 recovery reads ([#37710](https://github.com/okou-ai/okou/issues/37710)) ([1931f04](https://github.com/okou-ai/okou/commit/1931f04221f64f604ccb1c6791c94bef111c94ed))
* **api:** own private artifact preview cache operations ([#38156](https://github.com/okou-ai/okou/issues/38156)) ([b2d4bb3](https://github.com/okou-ai/okou/commit/b2d4bb32f4c1c3915edb2608998711c4b3a68bb1))
* **api:** own private artifact reads and reference resolution ([#38078](https://github.com/okou-ai/okou/issues/38078)) ([88d0941](https://github.com/okou-ai/okou/commit/88d0941e21a956a49efe69e8d7cf5b88b21de381))
* **api:** own remaining hosted-site transaction queries ([#38225](https://github.com/okou-ai/okou/issues/38225)) ([7982faf](https://github.com/okou-ai/okou/commit/7982faf50f4936909ccc6d0c107d371e74c613d4))
* **api:** own required terminal chat callback reads ([#37707](https://github.com/okou-ai/okou/issues/37707)) ([b190ff1](https://github.com/okou-ai/okou/commit/b190ff107eb5d387ee9b4eab6b42136b335a720d))
* **api:** own resource projection worker transactions ([#38012](https://github.com/okou-ai/okou/issues/38012)) ([0157b0f](https://github.com/okou-ai/okou/commit/0157b0fce6ffd2bab89704aa188a3be93f60d6f8))
* **api:** own runner notification preference reads ([#38222](https://github.com/okou-ai/okou/issues/38222)) ([8048b62](https://github.com/okou-ai/okou/commit/8048b6290029e27a1f1fd36a0dd04d24e8e5eb85))
* **api:** own skill storage publication transactions ([#38060](https://github.com/okou-ai/okou/issues/38060)) ([36ca5da](https://github.com/okou-ai/okou/commit/36ca5da3245592c9c3c422311458d6ccf24340a2))
* **api:** own storage commit publication ([#38154](https://github.com/okou-ai/okou/issues/38154)) ([bcc9507](https://github.com/okou-ai/okou/commit/bcc9507ad9b444b85abd45634642a452c10b328b))
* **api:** own storage preparation admission reads ([#38039](https://github.com/okou-ai/okou/issues/38039)) ([d6a2727](https://github.com/okou-ai/okou/commit/d6a27272a7406aa8aca409aed4ecc23a855b1f7e))
* **api:** own stripe deauthorization ingress ([#38142](https://github.com/okou-ai/okou/issues/38142)) ([5d0324c](https://github.com/okou-ai/okou/commit/5d0324c25bfd050409a0694d98d820b58252c5e0))
* **api:** own stripe delivery claim and outcome commands ([#38086](https://github.com/okou-ai/okou/issues/38086)) ([297d230](https://github.com/okou-ai/okou/commit/297d230fec2f460e55b301e5e409f82e7f0da2ef))
* **api:** own stripe invoice fanout transaction ([#38305](https://github.com/okou-ai/okou/issues/38305)) ([0826bc3](https://github.com/okou-ai/okou/commit/0826bc32f2787c00bec30e1f0e6b86a18c27c04e))
* **api:** own stripe pending delivery reads ([#38325](https://github.com/okou-ai/okou/issues/38325)) ([2e7b4eb](https://github.com/okou-ai/okou/commit/2e7b4ebcd7c8fb5d2150f08fc188630aac35bff3))
* **api:** own terminal sandbox storage lineage reads ([#37789](https://github.com/okou-ai/okou/issues/37789)) ([a1a3e19](https://github.com/okou-ai/okou/commit/a1a3e19104a04a226a5916ef61e745e20ea15f4b))
* **api:** own terminal sandbox storage version reads ([#37782](https://github.com/okou-ai/okou/issues/37782)) ([2fe6f11](https://github.com/okou-ai/okou/commit/2fe6f11be34ab296e93ad4193d18dd4a192bb4fa))
* **api:** own uploaded-file writes and catalog handoffs ([#38016](https://github.com/okou-ai/okou/issues/38016)) ([d953cf8](https://github.com/okou-ai/okou/commit/d953cf8f2c8d1848d26c280a16c350c3b401609b))
* **api:** own volume preparation and instruction publication ([#38028](https://github.com/okou-ai/okou/issues/38028)) ([401ba2d](https://github.com/okou-ai/okou/commit/401ba2d4565f9d3aaac6fa7f50009ec7f7075890))
* **api:** own volume publication fences and cleanup ([#38042](https://github.com/okou-ai/okou/issues/38042)) ([8b2e3d0](https://github.com/okou-ai/okou/commit/8b2e3d09603ee6c56c6e62a64f86cc4720b0ba1f))
* **api:** own workflow automation creation commits ([#38036](https://github.com/okou-ai/okou/issues/38036)) ([98b19e3](https://github.com/okou-ai/okou/commit/98b19e30b9b52955eabb45296fa7186712bb7483))
* **api:** own workflow automation enable and stripe commits ([#38191](https://github.com/okou-ai/okou/issues/38191)) ([b07bc3a](https://github.com/okou-ai/okou/commit/b07bc3a54c75efe9205afc7614d3c8f936a32d67))
* **api:** own workflow automation reads ([#38048](https://github.com/okou-ai/okou/issues/38048)) ([a01abf6](https://github.com/okou-ai/okou/commit/a01abf616a49a15fb23b7fdbaeceeb548c5f9521))
* **api:** own workflow catalog list and deletion queries ([#38216](https://github.com/okou-ai/okou/issues/38216)) ([774706e](https://github.com/okou-ai/okou/commit/774706e3d0b05ff5358c06ed6bc41df2824185c6))
* **api:** own workflow copy publication ([#38223](https://github.com/okou-ai/okou/issues/38223)) ([b4c06fd](https://github.com/okou-ai/okou/commit/b4c06fde2d6d95b129f63b83661e488e49dd71f2))
* **api:** own workflow creation and visibility transactions ([#38229](https://github.com/okou-ai/okou/issues/38229)) ([2de5358](https://github.com/okou-ai/okou/commit/2de53581b7fac3059e31c58ffe8aae392b58dc8d))
* **api:** own workflow metadata commits and simplify gmail updates ([#38011](https://github.com/okou-ai/okou/issues/38011)) ([4824eff](https://github.com/okou-ai/okou/commit/4824eff35f768456096b89ac19bfb287056d1243))
* **api:** own workflow visibility, profile and thread reads ([#38237](https://github.com/okou-ai/okou/issues/38237)) ([1fec562](https://github.com/okou-ai/okou/commit/1fec56212453e7e84125f20336924138551ad793))
* **api:** own workflow webhook dispatch reads ([#38280](https://github.com/okou-ai/okou/issues/38280)) ([3dcf096](https://github.com/okou-ai/okou/commit/3dcf096997cdd5448a74df524afba9a2ac46df91))
* **api:** prebuild billing restore auth wrapper ([#38173](https://github.com/okou-ai/okou/issues/38173)) ([7f53c7a](https://github.com/okou-ai/okou/commit/7f53c7a44fbec83ba15cf7fa4356376258ffca92)), closes [#37510](https://github.com/okou-ai/okou/issues/37510)
* **api:** publish artifact shares outside database transactions ([#38038](https://github.com/okou-ai/okou/issues/38038)) ([1a317a4](https://github.com/okou-ai/okou/commit/1a317a4964ad8906894e150b13b21b3373871040))
* **api:** read chat projections without historical runs ([#37765](https://github.com/okou-ai/okou/issues/37765)) ([dc7a9e7](https://github.com/okou-ai/okou/commit/dc7a9e7ef8b3c30ee3b1c828228bdd25b78e23c5))
* **api:** read member usage in one statement ([#38425](https://github.com/okou-ai/okou/issues/38425)) ([b48cdb3](https://github.com/okou-ai/okou/commit/b48cdb3d1745971ce2fd0f70fbb7791eb74f0938))
* **api:** remove mcp input snapshot transaction ([#38287](https://github.com/okou-ai/okou/issues/38287)) ([803ede6](https://github.com/okou-ai/okou/commit/803ede641fb73f38a56c8d799d25bbe14d4def6a))
* **api:** remove oauth contract hash bindings ([#38190](https://github.com/okou-ai/okou/issues/38190)) ([3e0f689](https://github.com/okou-ai/okou/commit/3e0f689475709a63a8ed534d11f34e583e8ac3f6))
* **api:** remove retired native morning brief guards ([#38404](https://github.com/okou-ai/okou/issues/38404)) ([f22b41a](https://github.com/okou-ai/okou/commit/f22b41ab59d91859c61a7c12a9a9814aac7970d4))
* **api:** remove stripe deauthorization transaction ([#38413](https://github.com/okou-ai/okou/issues/38413)) ([5ce389e](https://github.com/okou-ai/okou/commit/5ce389edded62e26ac57bad4aee56af7103559a5))
* **api:** remove unused pi stable-context and report delisted connectors absent ([#37905](https://github.com/okou-ai/okou/issues/37905)) ([c339e73](https://github.com/okou-ai/okou/commit/c339e73f0fb5d0ca0a8f4a4e80c67331ea9fb79d))
* **api:** resolve queued connector permissions from current catalog ([#38066](https://github.com/okou-ai/okou/issues/38066)) ([865afb7](https://github.com/okou-ai/okou/commit/865afb7a05d413c9db56713035a373ebaa767672))
* **api:** retain artifacts independently of run deletion ([#37772](https://github.com/okou-ai/okou/issues/37772)) ([3921e38](https://github.com/okou-ai/okou/commit/3921e386f222a169e97c10046156758cc4e510b0))
* **api:** retire automatic morning brief enrollment ([#38095](https://github.com/okou-ai/okou/issues/38095)) ([d1076b6](https://github.com/okou-ai/okou/commit/d1076b64322892d680dce0ef9ed835d53ebf57e3))
* **api:** retire batch 017 private test fixtures ([#38235](https://github.com/okou-ai/okou/issues/38235)) ([a218941](https://github.com/okou-ai/okou/commit/a2189418b48f7dab6b8d5b9237f7d4c6bfd20d4e))
* **api:** retire native morning brief storage dependencies ([#37874](https://github.com/okou-ai/okou/issues/37874)) ([094ef4c](https://github.com/okou-ai/okou/commit/094ef4c402089b1acdcafede8af8f7e081506d2f))
* **api:** retire official workflow queue markers ([#38365](https://github.com/okou-ai/okou/issues/38365)) ([1b0d4ec](https://github.com/okou-ai/okou/commit/1b0d4ec16fa782e6a5b0e01d899ce339acb6aa6a))
* **api:** retire workflow automation worker test endpoints ([#37904](https://github.com/okou-ai/okou/issues/37904)) ([1375381](https://github.com/okou-ai/okou/commit/13753817e6507ac8b71315166dac807a87711c4c))
* **api:** separate automation lifecycle from event dispatch ([#38199](https://github.com/okou-ai/okou/issues/38199)) ([d0e80d5](https://github.com/okou-ai/okou/commit/d0e80d56313dbbfb5a1c11d72c1e44eb3b0a357b))
* **api:** simplify member onboarding activity check ([#38419](https://github.com/okou-ai/okou/issues/38419)) ([2c56120](https://github.com/okou-ai/okou/commit/2c56120d5792b42c74c96bb7898eed5f6c1fa490))
* **api:** statically own official workflow reconciliation ([#38208](https://github.com/okou-ai/okou/issues/38208)) ([628d2e8](https://github.com/okou-ai/okou/commit/628d2e83be3dcf21b7806bb482c75bcb73f904e3))
* **api:** unify run prompts and skill volumes ([#38332](https://github.com/okou-ai/okou/issues/38332)) ([8d665ee](https://github.com/okou-ai/okou/commit/8d665ee2524394819205c6f3d69888f6436addb8))
* **api:** unify test projects with per-case database isolation ([#37896](https://github.com/okou-ai/okou/issues/37896)) ([28c0ec4](https://github.com/okou-ai/okou/commit/28c0ec43505f5032b005505d92c5e7c6d74d8a03))
* **api:** use bounded s3 command for stage1 history ([#38316](https://github.com/okou-ai/okou/issues/38316)) ([6bd5cc8](https://github.com/okou-ai/okou/commit/6bd5cc8ca6e6e6613c84f8791a0b5144f30426de))
* **api:** use canonical official workflow queue contexts ([#38049](https://github.com/okou-ai/okou/issues/38049)) ([76c17bc](https://github.com/okou-ai/okou/commit/76c17bcc4048d9aff4907477012172c364a66e5c))
* **api:** use client-only platform realtime token exchange ([#38105](https://github.com/okou-ai/okou/issues/38105)) ([0fdfb57](https://github.com/okou-ai/okou/commit/0fdfb57b88d655219e84f18050a88362071cdd41))
* **api:** use fixed commands for canonical input imports ([#38062](https://github.com/okou-ai/okou/issues/38062)) ([f8299d6](https://github.com/okou-ai/okou/commit/f8299d6a5d49657caf7ba1c033f1b33cb52c1ffb))
* **api:** use static bounded reads for memory summaries ([#38204](https://github.com/okou-ai/okou/issues/38204)) ([13d9bc2](https://github.com/okou-ai/okou/commit/13d9bc248c60f520893f145c9e5ed38617f89e56))
* **artifacts:** remove video poster extraction ([#38146](https://github.com/okou-ai/okou/issues/38146)) ([641cf0d](https://github.com/okou-ai/okou/commit/641cf0ddff6c631cf94386e6c3d26c78395c63aa))
* **artifacts:** use artifact identity for google drive uploads ([#38300](https://github.com/okou-ai/okou/issues/38300)) ([e223f5e](https://github.com/okou-ai/okou/commit/e223f5e45fd22cdd729f84f075686ec5afb24b6e))
* assemble current run inputs without agent configuration ([#38004](https://github.com/okou-ai/okou/issues/38004)) ([22efd4b](https://github.com/okou-ai/okou/commit/22efd4b6b34872c0585a0d4c3778cb3b59d9d100))
* clean up released switch leftovers and drop legacy chat thread provider pins ([#37851](https://github.com/okou-ai/okou/issues/37851)) ([066e9c3](https://github.com/okou-ai/okou/commit/066e9c32c2bbd5e3d48783fb0028f8dcfbaeaf06))
* **computer-use:** remove retired desktop plugins ([#37980](https://github.com/okou-ai/okou/issues/37980)) ([8b8928c](https://github.com/okou-ai/okou/commit/8b8928cdf85d4fb2243a9326194d7cfb3936d53c))
* contract connector catalog storage to pointer and immutable entries ([#37886](https://github.com/okou-ai/okou/issues/37886)) ([baf302f](https://github.com/okou-ai/okou/commit/baf302f5373a000999dfde0abf521752a779e29c))
* **discord:** derive message content from application grants ([#38377](https://github.com/okou-ai/okou/issues/38377)) ([a69a248](https://github.com/okou-ai/okou/commit/a69a2485e449109886f80bf37d49ece61f750230))
* finish connector catalog release 2 follow-up cleanup ([#37895](https://github.com/okou-ai/okou/issues/37895)) ([013d37d](https://github.com/okou-ai/okou/commit/013d37d5513f5ff071097621e4436109742f6dc8))
* graduate fully rolled out feature switches ([#37721](https://github.com/okou-ai/okou/issues/37721)) ([62e6dd4](https://github.com/okou-ai/okou/commit/62e6dd43c07ccfd77517d6f653ab123a37aff89f))
* move release 1 connector catalog consumers off legacy storage ([#37861](https://github.com/okou-ai/okou/issues/37861)) ([e664957](https://github.com/okou-ai/okou/commit/e664957caa2056a336595e55f475001b81247fd0))
* prepare payload-independent connector catalog api ([#38099](https://github.com/okou-ai/okou/issues/38099)) ([9d3a1b4](https://github.com/okou-ai/okou/commit/9d3a1b406f1f44b224c33046162df01a77e035f8))
* read connector catalogs from immutable entries ([#37820](https://github.com/okou-ai/okou/issues/37820)) ([562e53f](https://github.com/okou-ai/okou/commit/562e53fdeb02c8feb1f131f0f8629bc84bf1f2d0))
* remove abandoned langfuse trace feature ([#38010](https://github.com/okou-ai/okou/issues/38010)) ([5080d02](https://github.com/okou-ai/okou/commit/5080d026e68f10f41285570f52a9b655fb562052))
* remove agent responsibility setup feature switch ([#38069](https://github.com/okou-ai/okou/issues/38069)) ([bbb313e](https://github.com/okou-ai/okou/commit/bbb313e561cf6904565d5b91e7e227e2016557ee))
* remove all remaining custom model mode awareness ([#37856](https://github.com/okou-ai/okou/issues/37856)) ([f383835](https://github.com/okou-ai/okou/commit/f3838353ba0455ec7d57dfa2d0974e34a44796ff))
* remove connector catalog diagnostics endpoint and cron response fields ([#37907](https://github.com/okou-ai/okou/issues/37907)) ([0d2b5d1](https://github.com/okou-ai/okou/commit/0d2b5d1a7bae269f2fcac0bf23f7ae377df07244))
* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))
* remove eleven released feature switches ([#37848](https://github.com/okou-ai/okou/issues/37848)) ([53255d6](https://github.com/okou-ai/okou/commit/53255d66854676285dad37eb13b3266ebe578031))
* remove expired deployment compatibility ([#38219](https://github.com/okou-ai/okou/issues/38219)) ([303f42b](https://github.com/okou-ai/okou/commit/303f42bafd0d70928c477dc87a5f25fdc00db6d7))
* remove monday connector feature switch ([#38334](https://github.com/okou-ai/okou/issues/38334)) ([fb8f2d3](https://github.com/okou-ai/okou/commit/fb8f2d3b1474385d7fb0d44594b883919c33c62e))
* remove pi openrouter chat completions feature switch ([#38096](https://github.com/okou-ai/okou/issues/38096)) ([a635ec3](https://github.com/okou-ai/okou/commit/a635ec3afa20cdb5df9c8125afe6cec24ef53e16))
* remove plaud connector feature switch ([#38412](https://github.com/okou-ai/okou/issues/38412)) ([b9fccfb](https://github.com/okou-ai/okou/commit/b9fccfbae83bf7f61da74832a19287c8e964ffde))
* remove remaining model provider residue ([#37870](https://github.com/okou-ai/okou/issues/37870)) ([a93133b](https://github.com/okou-ai/okou/commit/a93133b0493858a39924a1206ff5a5677e43cad6))
* remove retired per-agent ssh access traces ([#37876](https://github.com/okou-ai/okou/issues/37876)) ([dc33264](https://github.com/okou-ai/okou/commit/dc332649051e79460f1075a294ba8d3707f8504f))
* represent auto model selection as null ([#37901](https://github.com/okou-ai/okou/issues/37901)) ([d0e0b71](https://github.com/okou-ai/okou/commit/d0e0b7191fe168e8935e1abf3df1fa1806efea2a))
* retire claude code manual usage reset ([#37755](https://github.com/okou-ai/okou/issues/37755)) ([1855ed7](https://github.com/okou-ai/okou/commit/1855ed7f5d58c7aa931a6acc27f2fa375edc395f))
* retire cooldown, ultrafast, us routing and model provider leftovers ([#37884](https://github.com/okou-ai/okou/issues/37884)) ([a9c3270](https://github.com/okou-ai/okou/commit/a9c3270099034c0f7ee73f6c730b07efa7d1d733))
* retire deepseek memory execution route ([#38193](https://github.com/okou-ai/okou/issues/38193)) ([dd70bd4](https://github.com/okou-ai/okou/commit/dd70bd4b01bd2ee0dbfbe748940544e5e072bf5a))
* retire generic run checkpoints from completion ([#38147](https://github.com/okou-ai/okou/issues/38147)) ([e8002cf](https://github.com/okou-ai/okou/commit/e8002cfcc9995e2b245947dbf25a9f9dd73f1ca0))
* retire organization custom model configuration ([#37746](https://github.com/okou-ai/okou/issues/37746)) ([014fe18](https://github.com/okou-ai/okou/commit/014fe1867c6d1830fd35b03c3d77491da5aaa36a))
* retire organization usage allowance ([#37971](https://github.com/okou-ai/okou/issues/37971)) ([2659878](https://github.com/okou-ai/okou/commit/26598788903fb817edd71d82ccbdfcd66cfa3a0a))
* **ssh:** make metadata rename an atomic statement ([#38284](https://github.com/okou-ai/okou/issues/38284)) ([9da771d](https://github.com/okou-ai/okou/commit/9da771dd0928a7a83f81a418ec3a93cc3da17f0d))


### Performance Improvements

* **api:** avoid eager full catalog reads during run bootstrap ([#37769](https://github.com/okou-ai/okou/issues/37769)) ([c1c2d77](https://github.com/okou-ai/okou/commit/c1c2d77ab51b38acf91008b2c60937ac2c29cda3))
* **api:** consolidate global and identity context reads before enqueue ([#37885](https://github.com/okou-ai/okou/issues/37885)) ([3a37588](https://github.com/okou-ai/okou/commit/3a375883212f6264b4ef133faae1ae92d7d4b5bb))
* **api:** isolate declaration-heavy typecheck stages ([#37722](https://github.com/okou-ai/okou/issues/37722)) ([2f0d4c2](https://github.com/okou-ai/okou/commit/2f0d4c25f7935c88f362192a38dffb622e197686))
* **api:** read connector catalog entries by slug on runtime hot paths ([#37903](https://github.com/okou-ai/okou/issues/37903)) ([f8a3a9b](https://github.com/okou-ai/okou/commit/f8a3a9b1f0bb44a30c5f443273439069332903a3))
* **api:** read connector catalog from purpose-specific columns ([#37900](https://github.com/okou-ai/okou/issues/37900)) ([8c38a39](https://github.com/okou-ai/okou/commit/8c38a399d41d0786e6450e78a897d1de01892a58))
* **api:** reduce mcp input observation reads ([#37921](https://github.com/okou-ai/okou/issues/37921)) ([b4497cd](https://github.com/okou-ai/okou/commit/b4497cd5a05367fd6ee6fde0d5a4d2c98bfb3ae9))
* **ci:** bound api preview connector catalog initialization ([#37790](https://github.com/okou-ai/okou/issues/37790)) ([d6300c1](https://github.com/okou-ai/okou/commit/d6300c15d49be1602c846acfc82b96f60caed4ea))
* **ssh:** narrow cloudflare rename locks and reference reloads ([#38003](https://github.com/okou-ai/okou/issues/38003)) ([191ca92](https://github.com/okou-ai/okou/commit/191ca92a931d80acc4a55b750b3b5275863e08df))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.546.0
    * @okouai/core bumped to 8.739.0
    * @okouai/db bumped to 1.328.0
    * @okouai/pi-agent-runtime bumped to 1.49.0
</details>

<details><summary>guest-agent: 0.104.11</summary>

## [0.104.11](https://github.com/okou-ai/okou/compare/guest-agent-v0.104.10...guest-agent-v0.104.11) (2026-10-09)


### Documentation

* keep reusable engineering standards and remove feature records ([#38387](https://github.com/okou-ai/okou/issues/38387)) ([6507d86](https://github.com/okou-ai/okou/commit/6507d86c83ca37e7a8790e4efd66eb6a84267295))


### Performance Improvements

* **test:** borrow delivery and rejection fixture inputs ([#38415](https://github.com/okou-ai/okou/issues/38415)) ([59b9052](https://github.com/okou-ai/okou/commit/59b9052e0bb52a2be4f743fef4ee9ebf37ca0dcf))
* **test:** move owned json into large delivery fixtures ([#38379](https://github.com/okou-ai/okou/issues/38379)) ([f036aad](https://github.com/okou-ai/okou/commit/f036aad60540ea2c2e114a74dac57836b85ab52c))
</details>

<details><summary>guest-control-client: 0.22.32</summary>

## [0.22.32](https://github.com/okou-ai/okou/compare/guest-control-client-v0.22.31...guest-control-client-v0.22.32) (2026-10-09)
</details>

<details><summary>guest-control-proto: 0.21.56</summary>

## [0.21.56](https://github.com/okou-ai/okou/compare/guest-control-proto-v0.21.55...guest-control-proto-v0.21.56) (2026-10-09)


### Documentation

* keep reusable engineering standards and remove feature records ([#38387](https://github.com/okou-ai/okou/issues/38387)) ([6507d86](https://github.com/okou-ai/okou/commit/6507d86c83ca37e7a8790e4efd66eb6a84267295))
</details>

<details><summary>guest-control-server: 0.22.12</summary>

## [0.22.12](https://github.com/okou-ai/okou/compare/guest-control-server-v0.22.11...guest-control-server-v0.22.12) (2026-10-09)
</details>

<details><summary>guest-control-tests: 0.12.47</summary>

## [0.12.47](https://github.com/okou-ai/okou/compare/guest-control-tests-v0.12.46...guest-control-tests-v0.12.47) (2026-10-09)
</details>

<details><summary>guest-init: 0.17.12</summary>

## [0.17.12](https://github.com/okou-ai/okou/compare/guest-init-v0.17.11...guest-init-v0.17.12) (2026-10-09)
</details>

<details><summary>guest-write-file: 0.1.210</summary>

## [0.1.210](https://github.com/okou-ai/okou/compare/guest-write-file-v0.1.209...guest-write-file-v0.1.210) (2026-10-09)
</details>

<details><summary>nbd-cow: 0.5.4</summary>

## [0.5.4](https://github.com/okou-ai/okou/compare/nbd-cow-v0.5.3...nbd-cow-v0.5.4) (2026-10-09)


### Bug Fixes

* **nbd-cow:** defer cleanup after connect outcome consumption ([#38405](https://github.com/okou-ai/okou/issues/38405)) ([8e7881c](https://github.com/okou-ai/okou/commit/8e7881cd26c8d6facf741911a512125d099b3a17))
</details>

<details><summary>rfb-client: 0.21.4</summary>

## [0.21.4](https://github.com/okou-ai/okou/compare/rfb-client-v0.21.3...rfb-client-v0.21.4) (2026-10-09)


### Documentation

* keep reusable engineering standards and remove feature records ([#38387](https://github.com/okou-ai/okou/issues/38387)) ([6507d86](https://github.com/okou-ai/okou/commit/6507d86c83ca37e7a8790e4efd66eb6a84267295))
</details>

<details><summary>runner-rs: 0.222.0</summary>

## [0.222.0](https://github.com/okou-ai/okou/compare/runner-rs-v0.221.5...runner-rs-v0.222.0) (2026-10-09)


### Features

* prepare model identity compatibility without switching writes ([#38092](https://github.com/okou-ai/okou/issues/38092)) ([21177df](https://github.com/okou-ai/okou/commit/21177dfd37bc19114098a628a094adb67fb60db0))


### Bug Fixes

* **python:** bound request capture zlib member traversal ([#38343](https://github.com/okou-ai/okou/issues/38343)) ([ae3a5bf](https://github.com/okou-ai/okou/commit/ae3a5bffc597a34537945a0cc301ed9f303f1cd9))
* **python:** detect metadata keys through nested mapping constructors ([#38112](https://github.com/okou-ai/okou/issues/38112)) ([c6ef07b](https://github.com/okou-ai/okou/commit/c6ef07b3845d26216b9c0c79e270a705e431d3a0))
* **python:** preserve aliases across optional comprehension walrus bindings ([#38067](https://github.com/okou-ai/okou/issues/38067)) ([da7304f](https://github.com/okou-ai/okou/commit/da7304f9eff8b2bfb403cf0097bf94b9649e3b08))
* **runner:** accept scheme-relative firewall auth proxies ([#38355](https://github.com/okou-ai/okou/issues/38355)) ([139db6b](https://github.com/okou-ai/okou/commit/139db6bed5cd08fe1bbe31677226eaa1c9a9960a))
* **runner:** reconcile retained state and scrub terminal private files ([#38153](https://github.com/okou-ai/okou/issues/38153)) ([9824493](https://github.com/okou-ai/okou/commit/9824493f88b89ad219b243438d635e6cd085514b))
* **runner:** reject uninspectable responses before diagnostics ([#38352](https://github.com/okou-ai/okou/issues/38352)) ([2a41db0](https://github.com/okou-ai/okou/commit/2a41db0dcba3c3f4be50e6ea61e03104caebb563))


### Documentation

* align captured long-context threshold contract ([#37989](https://github.com/okou-ai/okou/issues/37989)) ([30eabca](https://github.com/okou-ai/okou/commit/30eabca061a6479a5b4fc40e7d6be0cc99da3f93))
* clarify custom connector eligibility before route precedence ([#38141](https://github.com/okou-ai/okou/issues/38141)) ([9342f47](https://github.com/okou-ai/okou/commit/9342f470f5fb73437977fd5b9b7854268363bfce))


### Refactoring

* assemble current run inputs without agent configuration ([#38004](https://github.com/okou-ai/okou/issues/38004)) ([22efd4b](https://github.com/okou-ai/okou/commit/22efd4b6b34872c0585a0d4c3778cb3b59d9d100))
* **python:** retire firewall api-id base fallback ([#38344](https://github.com/okou-ai/okou/issues/38344)) ([ad4790d](https://github.com/okou-ai/okou/commit/ad4790d632163c7897d733e5912563071880003f))
* remove all remaining custom model mode awareness ([#37856](https://github.com/okou-ai/okou/issues/37856)) ([f383835](https://github.com/okou-ai/okou/commit/f3838353ba0455ec7d57dfa2d0974e34a44796ff))
* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))
* remove remaining model provider residue ([#37870](https://github.com/okou-ai/okou/issues/37870)) ([a93133b](https://github.com/okou-ai/okou/commit/a93133b0493858a39924a1206ff5a5677e43cad6))
* remove retired per-agent ssh access traces ([#37876](https://github.com/okou-ai/okou/issues/37876)) ([dc33264](https://github.com/okou-ai/okou/commit/dc332649051e79460f1075a294ba8d3707f8504f))
* retire cooldown, ultrafast, us routing and model provider leftovers ([#37884](https://github.com/okou-ai/okou/issues/37884)) ([a9c3270](https://github.com/okou-ai/okou/commit/a9c3270099034c0f7ee73f6c730b07efa7d1d733))
* **runner:** bind cli identity to package bytes for rootfs hashing ([#37967](https://github.com/okou-ai/okou/issues/37967)) ([3698acc](https://github.com/okou-ai/okou/commit/3698acc28545e383a9357ea354ac1db8c51523dc))
* **runner:** move runtime reactor into runner-supervisor ([#38393](https://github.com/okou-ai/okou/issues/38393)) ([a5a1dd3](https://github.com/okou-ai/okou/commit/a5a1dd3ae25f19d65baed071cb15fa2a456cfb0a))
* **runner:** move storage-cache gc into runner-storage ([#38285](https://github.com/okou-ai/okou/issues/38285)) ([ed47c2a](https://github.com/okou-ai/okou/commit/ed47c2aabb22c37ac87804de7f7c8206f8995794))
* **runner:** move systemd primitives into runner-host ([#38150](https://github.com/okou-ai/okou/issues/38150)) ([25c7696](https://github.com/okou-ai/okou/commit/25c769652370465956b95c3fd98f94911557823c))


### Performance Improvements

* **ci:** reduce mitm-addon test logging overhead ([#38274](https://github.com/okou-ai/okou/issues/38274)) ([602d9cb](https://github.com/okou-ai/okou/commit/602d9cb62a85374eac02fb10b3b660ca12c3153c))
* **ci:** shard mitm-addon tests without reducing coverage ([#38315](https://github.com/okou-ai/okou/issues/38315)) ([ce1af07](https://github.com/okou-ai/okou/commit/ce1af073c4925132514b3166407c1a0de2ca3065))
* **mitm-addon:** remove polling and redundant heap scans from tests ([#38289](https://github.com/okou-ai/okou/issues/38289)) ([261e7df](https://github.com/okou-ai/okou/commit/261e7dfaca310b1a3e1e2fa6ec99965e2cf3c232))
* **runner:** bound aggregate x ndjson stream inspection ([#38414](https://github.com/okou-ai/okou/issues/38414)) ([fa535a5](https://github.com/okou-ai/okou/commit/fa535a5cb7ab4830a4b96d102e2bfd60b42a6ec3))
* **runner:** keep routine cache scans off the capacity lock ([#37952](https://github.com/okou-ai/okou/issues/37952)) ([f53d1e8](https://github.com/okou-ai/okou/commit/f53d1e8ea334ecc4414489a8d9471673557090a1))
* **runner:** reuse failed registry snapshots after catalog retries ([#38357](https://github.com/okou-ai/okou/issues/38357)) ([4e15b3d](https://github.com/okou-ai/okou/commit/4e15b3d7e246de83025a2c64663a2ea6a1748bf4))

### Release Dependencies

* Release of `turbo/apps/cli`
</details>

<details><summary>runner-executor: 0.7.0</summary>

## [0.7.0](https://github.com/okou-ai/okou/compare/runner-executor-v0.6.3...runner-executor-v0.7.0) (2026-10-09)


### Features

* **pi:** route openrouter through chat completions behind a switch ([#37987](https://github.com/okou-ai/okou/issues/37987)) ([df136ee](https://github.com/okou-ai/okou/commit/df136ee82546c76d79575e203c7257371ea5b3cb))
* prepare model identity compatibility without switching writes ([#38092](https://github.com/okou-ai/okou/issues/38092)) ([21177df](https://github.com/okou-ai/okou/commit/21177dfd37bc19114098a628a094adb67fb60db0))


### Bug Fixes

* **guest-storage-apply:** fail run preparation on injection errors ([#38070](https://github.com/okou-ai/okou/issues/38070)) ([496599f](https://github.com/okou-ai/okou/commit/496599f7faf42b8c0ae425c7af3eea457a571fd0))
* **runner:** reconcile retained state and scrub terminal private files ([#38153](https://github.com/okou-ai/okou/issues/38153)) ([9824493](https://github.com/okou-ai/okou/commit/9824493f88b89ad219b243438d635e6cd085514b))


### Refactoring

* assemble current run inputs without agent configuration ([#38004](https://github.com/okou-ai/okou/issues/38004)) ([22efd4b](https://github.com/okou-ai/okou/commit/22efd4b6b34872c0585a0d4c3778cb3b59d9d100))
* remove all remaining custom model mode awareness ([#37856](https://github.com/okou-ai/okou/issues/37856)) ([f383835](https://github.com/okou-ai/okou/commit/f3838353ba0455ec7d57dfa2d0974e34a44796ff))
* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))
* remove remaining model provider residue ([#37870](https://github.com/okou-ai/okou/issues/37870)) ([a93133b](https://github.com/okou-ai/okou/commit/a93133b0493858a39924a1206ff5a5677e43cad6))
</details>

<details><summary>runner-host: 0.2.18</summary>

## [0.2.18](https://github.com/okou-ai/okou/compare/runner-host-v0.2.17...runner-host-v0.2.18) (2026-10-09)


### Refactoring

* **runner:** move runtime reactor into runner-supervisor ([#38393](https://github.com/okou-ai/okou/issues/38393)) ([a5a1dd3](https://github.com/okou-ai/okou/commit/a5a1dd3ae25f19d65baed071cb15fa2a456cfb0a))
</details>

<details><summary>runner-lifecycle: 0.1.41</summary>

## [0.1.41](https://github.com/okou-ai/okou/compare/runner-lifecycle-v0.1.40...runner-lifecycle-v0.1.41) (2026-10-09)
</details>

<details><summary>runner-network: 0.2.15</summary>

## [0.2.15](https://github.com/okou-ai/okou/compare/runner-network-v0.2.14...runner-network-v0.2.15) (2026-10-09)


### Refactoring

* assemble current run inputs without agent configuration ([#38004](https://github.com/okou-ai/okou/issues/38004)) ([22efd4b](https://github.com/okou-ai/okou/commit/22efd4b6b34872c0585a0d4c3778cb3b59d9d100))
* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))
* retire cooldown, ultrafast, us routing and model provider leftovers ([#37884](https://github.com/okou-ai/okou/issues/37884)) ([a9c3270](https://github.com/okou-ai/okou/commit/a9c3270099034c0f7ee73f6c730b07efa7d1d733))


### Performance Improvements

* **test:** reduce remaining crates fixture overhead ([#38283](https://github.com/okou-ai/okou/issues/38283)) ([80ea1e5](https://github.com/okou-ai/okou/commit/80ea1e5381b35f4ca152d4ffbf387915d8f3d1cc))
* **test:** remove redundant http fixture body work ([#38320](https://github.com/okou-ai/okou/issues/38320)) ([b3e8b7c](https://github.com/okou-ai/okou/commit/b3e8b7c95fe75585247a972177e22d04d7f7639c))
</details>

<details><summary>runner-provider: 0.6.1</summary>

## [0.6.1](https://github.com/okou-ai/okou/compare/runner-provider-v0.6.0...runner-provider-v0.6.1) (2026-10-09)


### Refactoring

* **runner:** move runtime reactor into runner-supervisor ([#38393](https://github.com/okou-ai/okou/issues/38393)) ([a5a1dd3](https://github.com/okou-ai/okou/commit/a5a1dd3ae25f19d65baed071cb15fa2a456cfb0a))
</details>

<details><summary>runner-remote: 0.10.14</summary>

## [0.10.14](https://github.com/okou-ai/okou/compare/runner-remote-v0.10.13...runner-remote-v0.10.14) (2026-10-09)


### Documentation

* keep reusable engineering standards and remove feature records ([#38387](https://github.com/okou-ai/okou/issues/38387)) ([6507d86](https://github.com/okou-ai/okou/commit/6507d86c83ca37e7a8790e4efd66eb6a84267295))
</details>

<details><summary>runner-storage: 0.2.11</summary>

## [0.2.11](https://github.com/okou-ai/okou/compare/runner-storage-v0.2.10...runner-storage-v0.2.11) (2026-10-09)


### Documentation

* keep reusable engineering standards and remove feature records ([#38387](https://github.com/okou-ai/okou/issues/38387)) ([6507d86](https://github.com/okou-ai/okou/commit/6507d86c83ca37e7a8790e4efd66eb6a84267295))


### Performance Improvements

* **test:** borrow delivery and rejection fixture inputs ([#38415](https://github.com/okou-ai/okou/issues/38415)) ([59b9052](https://github.com/okou-ai/okou/commit/59b9052e0bb52a2be4f743fef4ee9ebf37ca0dcf))
</details>

<details><summary>runner-supervisor: 0.4.0</summary>

## [0.4.0](https://github.com/okou-ai/okou/compare/runner-supervisor-v0.3.1...runner-supervisor-v0.4.0) (2026-10-09)


### Features

* **api:** prepare home cache affinity and runner state ([#38314](https://github.com/okou-ai/okou/issues/38314)) ([21ce097](https://github.com/okou-ai/okou/commit/21ce0978ad9a5bc7eddb94bc9d2bc25f1897095f))


### Bug Fixes

* **runner:** reconcile retained state and scrub terminal private files ([#38153](https://github.com/okou-ai/okou/issues/38153)) ([9824493](https://github.com/okou-ai/okou/commit/9824493f88b89ad219b243438d635e6cd085514b))


### CI

* use 20261008 toolchain images ([#37988](https://github.com/okou-ai/okou/issues/37988)) ([367fd6b](https://github.com/okou-ai/okou/commit/367fd6b83334f5b8f0f833e255854e1a3927c6bb))


### Refactoring

* assemble current run inputs without agent configuration ([#38004](https://github.com/okou-ai/okou/issues/38004)) ([22efd4b](https://github.com/okou-ai/okou/commit/22efd4b6b34872c0585a0d4c3778cb3b59d9d100))
* **runner:** move runtime reactor into runner-supervisor ([#38393](https://github.com/okou-ai/okou/issues/38393)) ([a5a1dd3](https://github.com/okou-ai/okou/commit/a5a1dd3ae25f19d65baed071cb15fa2a456cfb0a))
</details>

<details><summary>runner-types: 0.5.1</summary>

## [0.5.1](https://github.com/okou-ai/okou/compare/runner-types-v0.5.0...runner-types-v0.5.1) (2026-10-09)
</details>

<details><summary>sandbox: 0.24.1</summary>

## [0.24.1](https://github.com/okou-ai/okou/compare/sandbox-v0.24.0...sandbox-v0.24.1) (2026-10-09)


### Refactoring

* **runner:** move runtime reactor into runner-supervisor ([#38393](https://github.com/okou-ai/okou/issues/38393)) ([a5a1dd3](https://github.com/okou-ai/okou/commit/a5a1dd3ae25f19d65baed071cb15fa2a456cfb0a))
</details>

<details><summary>sandbox-firecracker: 0.44.14</summary>

## [0.44.14](https://github.com/okou-ai/okou/compare/sandbox-firecracker-v0.44.13...sandbox-firecracker-v0.44.14) (2026-10-09)


### Refactoring

* **ci:** rename runner image waiter to test prepare ([#38382](https://github.com/okou-ai/okou/issues/38382)) ([0955640](https://github.com/okou-ai/okou/commit/095564075558fc1deed004294f398fcddcac1163))
</details>

<details><summary>sandbox-mock: 0.11.45</summary>

## [0.11.45](https://github.com/okou-ai/okou/compare/sandbox-mock-v0.11.44...sandbox-mock-v0.11.45) (2026-10-09)
</details>

---
This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).