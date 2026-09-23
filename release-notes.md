:robot: I have created a release *beep* *boop*
---


<details><summary>api-contracts: 1.497.1</summary>

## [1.497.1](https://github.com/okou-ai/okou/compare/api-contracts-v1.497.0...api-contracts-v1.497.1) (2026-09-23)


### Refactoring

* retire chat thread unreads get endpoint ([#36271](https://github.com/okou-ai/okou/issues/36271)) ([125f010](https://github.com/okou-ai/okou/commit/125f010e0c056b8051f04a5be40049dd5cafc2c6))
</details>

<details><summary>app: 0.950.0</summary>

## [0.950.0](https://github.com/okou-ai/okou/compare/app-v0.949.0...app-v0.950.0) (2026-09-23)


### Features

* add manual usage reset for claude code subscriptions ([#36165](https://github.com/okou-ai/okou/issues/36165)) ([741e209](https://github.com/okou-ai/okou/commit/741e2092ecb9b944dc41e155cb58787d3316673b))
* add saved social data jobs and platform usage ([#35700](https://github.com/okou-ai/okou/issues/35700)) ([ec286d8](https://github.com/okou-ai/okou/commit/ec286d84ccbd1bab235c1baa1cc66f35d1f96ba1))
* add show all link to unread chat empty state ([#35922](https://github.com/okou-ai/okou/issues/35922)) ([f309328](https://github.com/okou-ai/okou/commit/f3093288df75faebf7e1aa94f41d1d29d88b32cc))
* **api-contracts:** add gpt-6-luna run model ([#36164](https://github.com/okou-ai/okou/issues/36164)) ([c86fa91](https://github.com/okou-ai/okou/commit/c86fa91e4a13f42951502f19208277d9b71241e9))
* **api:** add standalone cloudflare access management boundary ([#36057](https://github.com/okou-ai/okou/issues/36057)) ([c6df88a](https://github.com/okou-ai/okou/commit/c6df88aeb90ffe3d6f563a1028ffec5a41cc0b45))
* **api:** default new organizations to gpt-6 luna ([#36166](https://github.com/okou-ai/okou/issues/36166)) ([a202943](https://github.com/okou-ai/okou/commit/a20294342f008216e87fc242b0e03ff32ea30124))
* **api:** trigger a native morning brief on demand from settings debug ([#35596](https://github.com/okou-ai/okou/issues/35596)) ([c09e95b](https://github.com/okou-ai/okou/commit/c09e95bf7b724e7a32dfa6cdb01303b840c8fde6))
* **app:** centre the home greeting and frame the agent avatar ([#35587](https://github.com/okou-ai/okou/issues/35587)) ([e9ef0df](https://github.com/okou-ai/okou/commit/e9ef0dfc8d5e2d968ff95bf8ea055ba873dbdfe5))
* **app:** give composer starting ideas a card and more air ([#35494](https://github.com/okou-ai/okou/issues/35494)) ([04be54b](https://github.com/okou-ai/okou/commit/04be54b1ad94864f0c98d7c6c1c6d48d70e04774))
* **app:** recommend personalized tasks on the agent home page ([#35881](https://github.com/okou-ai/okou/issues/35881)) ([26dfde0](https://github.com/okou-ai/okou/commit/26dfde0a42e1a45d191508ffcde7348f00925303))
* **app:** refine custom template browsing and empty states ([#35788](https://github.com/okou-ai/okou/issues/35788)) ([202ace9](https://github.com/okou-ai/okou/commit/202ace9e31a0b5d18b2070aec841ab6f08e82c3f))
* **app:** remove the deck import from the slash panel ([#35570](https://github.com/okou-ai/okou/issues/35570)) ([3908906](https://github.com/okou-ai/okou/commit/3908906ccd5f5fb183012da0448538272178db7d))
* **app:** remove the workflow type row from the slash panel ([#35556](https://github.com/okou-ai/okou/issues/35556)) ([4354578](https://github.com/okou-ai/okou/commit/4354578ff5a21e48fb57120a0ca51d66a810448f))
* **app:** spell the shared phone number with its vanity letters ([#35641](https://github.com/okou-ai/okou/issues/35641)) ([976c92d](https://github.com/okou-ai/okou/commit/976c92d41257235820becf31136fb51c4b9fcf99))
* **browser:** preflight native input before form entry ([#36193](https://github.com/okou-ai/okou/issues/36193)) ([3e07303](https://github.com/okou-ai/okou/commit/3e073031e7f3fa38be4178d14ce657db40ceef9c))
* connect agentphone with one-time codes ([#35582](https://github.com/okou-ai/okou/issues/35582)) ([d2ebce8](https://github.com/okou-ai/okou/commit/d2ebce8a2944f417a0ca7c2583e95b2fdd02dce0))
* **connectors:** add standalone cloudflare access settings ([#36136](https://github.com/okou-ai/okou/issues/36136)) ([4f0c4f5](https://github.com/okou-ai/okou/commit/4f0c4f52bfee15cc5d43dcb1e5911582539eb57b))
* consolidate chat unread reads into indicators ([#36171](https://github.com/okou-ai/okou/issues/36171)) ([1ca25a4](https://github.com/okou-ai/okou/commit/1ca25a41379780bb0d6add1a086ea359251eea18))
* **core:** release the welcome thread to every workspace ([#35586](https://github.com/okou-ai/okou/issues/35586)) ([6bb62d1](https://github.com/okou-ai/okou/commit/6bb62d1157a83b416d91f77705bb448182196f64))
* **core:** release user message links to every reader ([#36021](https://github.com/okou-ai/okou/issues/36021)) ([a0adec6](https://github.com/okou-ai/okou/commit/a0adec6432eff599d2e7da0740a1216416e2deb1))
* expand free byok and plan concurrency ([#35610](https://github.com/okou-ai/okou/issues/35610)) ([5430b89](https://github.com/okou-ai/okou/commit/5430b89a8c88a976e4ca90bd1d9b8ee67c526466))
* expose and verify x509plain vnc access ([#35792](https://github.com/okou-ai/okou/issues/35792)) ([e5dfe16](https://github.com/okou-ai/okou/commit/e5dfe16de48753642c81558877bba57cb1f90dce))
* expose ssh-backed vnc access ([#36116](https://github.com/okou-ai/okou/issues/36116)) ([05910d3](https://github.com/okou-ai/okou/commit/05910d386aebd37b12637adf5dea4a935c9a0198))
* **model-provider:** add feature-gated okou 1.0 models ([#35884](https://github.com/okou-ai/okou/issues/35884)) ([b996e92](https://github.com/okou-ai/okou/commit/b996e92cc31d3038fd0a403decf66736597e5ce0))
* **models:** add Claude Opus 5.5 ([#36168](https://github.com/okou-ai/okou/issues/36168)) ([e0fc624](https://github.com/okou-ai/okou/commit/e0fc62414d039c9e0dfda36145c2e62edfcf79a2))
* **models:** gate new workspace model policies ([#35871](https://github.com/okou-ai/okou/issues/35871)) ([f76ce1d](https://github.com/okou-ai/okou/commit/f76ce1dc9789c75c6c23cf70f1d5378e16721d68))
* **onboarding:** finish the source-first flow and keep its answers ([#35812](https://github.com/okou-ai/okou/issues/35812)) ([83a08f0](https://github.com/okou-ai/okou/commit/83a08f0a4b676cff845b23a4e24cc8676065f42c))
* **onboarding:** generate context-aware recommendations ([#36108](https://github.com/okou-ai/okou/issues/36108)) ([0023929](https://github.com/okou-ai/okou/commit/0023929d062c6acea2396dd4f2a1f7ae8bb1872e))
* **onboarding:** wire the chat-channel step to real slack and teams installs ([#35809](https://github.com/okou-ai/okou/issues/35809)) ([e6e4723](https://github.com/okou-ai/okou/commit/e6e47239e64da9ffc948c43359a0601408f8d789))
* **platform:** add browser handoff controls ([#36143](https://github.com/okou-ai/okou/issues/36143)) ([47da746](https://github.com/okou-ai/okou/commit/47da7469a70c0bffe1103640a5380f6051682cd4))
* **platform:** add native browser input actions ([#35964](https://github.com/okou-ai/okou/issues/35964)) ([90c4d1f](https://github.com/okou-ai/okou/commit/90c4d1f0bdea10c8094eabb79d7778cce5540ab1))
* **platform:** add remote control and private network connector scopes ([#36209](https://github.com/okou-ai/okou/issues/36209)) ([4340730](https://github.com/okou-ai/okou/commit/4340730c12d7f666baabd3b3d1f64a3364e30c05))
* **platform:** add simplified and traditional chinese ui locales ([#35832](https://github.com/okou-ai/okou/issues/35832)) ([2c227d7](https://github.com/okou-ai/okou/commit/2c227d748b9e82987d2e50ee4d8cbb621314f6a6))
* **platform:** add source-first onboarding screens behind a switch ([#34927](https://github.com/okou-ai/okou/issues/34927)) ([1605bf4](https://github.com/okou-ai/okou/commit/1605bf46bdeaf2ffbde64c697ebfeb3e24e710ec))
* **platform:** add unread-only chat shortcut ([#35898](https://github.com/okou-ai/okou/issues/35898)) ([1ee024b](https://github.com/okou-ai/okou/commit/1ee024b30118b50892db99d13fee1b9d0747d63c))
* **platform:** always include archived chats in unread only ([#35804](https://github.com/okou-ai/okou/issues/35804)) ([2f55fcb](https://github.com/okou-ai/okou/commit/2f55fcbee429e5567535aec25d15d715ec6a53d3))
* **platform:** back the chat home avatar with a brand texture ([#35783](https://github.com/okou-ai/okou/issues/35783)) ([8a1366d](https://github.com/okou-ai/okou/commit/8a1366da03ad829f7af1be96365983abcb849a35))
* **platform:** connect a real subscription from the onboarding step ([#35808](https://github.com/okou-ai/okou/issues/35808)) ([d706cf3](https://github.com/okou-ai/okou/commit/d706cf36967f16f5f82329b7608a0d29b7c5ef0d))
* **platform:** draw the quest steps with the brand illustrations ([#35907](https://github.com/okou-ai/okou/issues/35907)) ([7f542a8](https://github.com/okou-ai/okou/commit/7f542a8a3754f7ebb5f5a89f46dabbdfd019342e))
* **platform:** drop the growth entry from the get started corner ([#35482](https://github.com/okou-ai/okou/issues/35482)) ([5258c8b](https://github.com/okou-ai/okou/commit/5258c8b6dfa97abd26582a17fe8a7d9550c1c9b8))
* **platform:** give the connector step a search box and demote its exit ([#36039](https://github.com/okou-ai/okou/issues/36039)) ([9f93d23](https://github.com/okou-ai/okou/commit/9f93d23bac242715ae19a5251a346fea07b2930e))
* **platform:** give the default agent avatar its own texture ([#35901](https://github.com/okou-ai/okou/issues/35901)) ([b503a49](https://github.com/okou-ai/okou/commit/b503a49b709681dae650d0ca46a08243da39c6a2))
* **platform:** give the quest steps two panels and one width ([#35954](https://github.com/okou-ai/okou/issues/35954)) ([f7eb439](https://github.com/okou-ai/okou/commit/f7eb439d3a5df1ba4cd3d3297b62bf9738b5ea3a))
* **platform:** group the quest connector picker by connection state ([#35546](https://github.com/okou-ai/okou/issues/35546)) ([f370eea](https://github.com/okou-ai/okou/commit/f370eea61f68d38fd8210c7513f30becbb0c5848))
* **platform:** hide video discovery entries for new accounts ([#35790](https://github.com/okou-ai/okou/issues/35790)) ([c8dd8ba](https://github.com/okou-ai/okou/commit/c8dd8ba9e605f13c97a011728fb881834b9f343e))
* **platform:** import real skills from the onboarding skills step ([#35843](https://github.com/okou-ai/okou/issues/35843)) ([974f7b4](https://github.com/okou-ai/okou/commit/974f7b4230bddcd07004ee3d0b74a3f23b00636d))
* **platform:** link plain urls in user messages ([#35564](https://github.com/okou-ai/okou/issues/35564)) ([3d8a17a](https://github.com/okou-ai/okou/commit/3d8a17a1633ece078a943ae0ad99c39cf5b4e62a))
* **platform:** make the daily check-in a step in the get started panel ([#36018](https://github.com/okou-ai/okou/issues/36018)) ([7c100b5](https://github.com/okou-ai/okou/commit/7c100b5829686fadeb10597eca64088f80480e29))
* **platform:** make the get started steps say and do the right thing ([#35835](https://github.com/okou-ai/okou/issues/35835)) ([901acfa](https://github.com/okou-ai/okou/commit/901acfa51fc1779661e0c9954dce02c4cf88004d))
* **platform:** make the share step two steps and give review a screen ([#36076](https://github.com/okou-ai/okou/issues/36076)) ([d7c6996](https://github.com/okou-ai/okou/commit/d7c69963051d28469c38b9cfc011689f39fa6dd2))
* **platform:** move paid tool settings into tools tab ([#36170](https://github.com/okou-ai/okou/issues/36170)) ([1eda981](https://github.com/okou-ai/okou/commit/1eda981b213f20ae18920a3ba1c9a9eb23d2dc08))
* **platform:** move the get started reward onto its own line and give the row a button ([#35778](https://github.com/okou-ai/okou/issues/35778)) ([3da8d1d](https://github.com/okou-ai/okou/commit/3da8d1d05db00a7409a8999b4c860949fdc091a4))
* **platform:** parse pasted cloudflare access headers ([#36122](https://github.com/okou-ai/okou/issues/36122)) ([4446147](https://github.com/okou-ai/okou/commit/4446147d87f92b5e646c51bb8fc05c69956ce8f5))
* **platform:** rebuild the get started panel around one grid ([#35659](https://github.com/okou-ai/okou/issues/35659)) ([6906e1a](https://github.com/okou-ai/okou/commit/6906e1a9c9c77235d6ee872c6e384bfae1324332))
* **platform:** redesign personal provider accounts ([#36031](https://github.com/okou-ai/okou/issues/36031)) ([ee3ac38](https://github.com/okou-ai/okou/commit/ee3ac386a243222710a2067e6a36995a835777f9))
* **platform:** report source-first onboarding funnel events ([#35802](https://github.com/okou-ai/okou/issues/35802)) ([b1d1e6d](https://github.com/okou-ai/okou/commit/b1d1e6d1bfe8623bc3e32dc6f5db98bdca463715))
* **platform:** reveal the chat greeting one word at a time ([#35992](https://github.com/okou-ai/okou/issues/35992)) ([0ec6b40](https://github.com/okou-ai/okou/commit/0ec6b40bd66a507195156a28520cf459ee42ad2e))
* **platform:** send real invitations from the onboarding team step ([#35810](https://github.com/okou-ai/okou/issues/35810)) ([5321d99](https://github.com/okou-ai/okou/commit/5321d99197da6cb7df2d75ca5e99631d4d2c4ccf))
* **platform:** shelve workflow recommendations behind connector covers ([#36060](https://github.com/okou-ai/okou/issues/36060)) ([336facf](https://github.com/okou-ai/okou/commit/336facf1e5d3dd09d2b69eb7fd9929b9c35353f4))
* **platform:** start the workflow quest from the recommendations ([#36192](https://github.com/okou-ai/okou/issues/36192)) ([192889f](https://github.com/okou-ai/okou/commit/192889f72db0c3669edeb101b8ec8784e78fc59c))
* **platform:** toggle unread chats from pinned agents ([#35923](https://github.com/okou-ai/okou/issues/35923)) ([1d63e4e](https://github.com/okou-ai/okou/commit/1d63e4e0a4a1e1461e29fdfc860bb9786f680e58))
* redeploy hosted sites under one stable address ([#35803](https://github.com/okou-ai/okou/issues/35803)) ([acb5c21](https://github.com/okou-ai/okou/commit/acb5c21eed43ddcd65439fd3b14f47c7671fe1d2))
* refine home task recommendations ([#36238](https://github.com/okou-ai/okou/issues/36238)) ([9e49b9c](https://github.com/okou-ai/okou/commit/9e49b9c9a2c50d449c478b8b9be17f7bff4a0a7c))
* retire the fal-ai/qwen-image image model ([#35581](https://github.com/okou-ai/okou/issues/35581)) ([86aca4f](https://github.com/okou-ai/okou/commit/86aca4fee17614ab8743b990fe214df6ce98259d))
* streamline source-first onboarding ([#36078](https://github.com/okou-ai/okou/issues/36078)) ([3ea7b47](https://github.com/okou-ai/okou/commit/3ea7b472711d7c76f80bbe1d0b48472ad9005c7d))
* **templates:** show a document template's first page in the catalog ([#35723](https://github.com/okou-ai/okou/issues/35723)) ([0d07c92](https://github.com/okou-ai/okou/commit/0d07c92b8719a472b61be04574ba87a9527cf5ba))
* **vnc:** add x509plain configuration ([#35653](https://github.com/okou-ai/okou/issues/35653)) ([6ed63da](https://github.com/okou-ai/okou/commit/6ed63da7dcca337b6b7cac91752e9df1319c0aac))


### Bug Fixes

* align cloudflare access naming ([#35632](https://github.com/okou-ai/okou/issues/35632)) ([708ac2e](https://github.com/okou-ai/okou/commit/708ac2e7cec6250eef99bdae13ce272ea2fff6e9))
* **api:** map Clerk invitation conflicts ([#35991](https://github.com/okou-ai/okou/issues/35991)) ([b052a84](https://github.com/okou-ai/okou/commit/b052a841d0c194a14174374b84dd8f8ea1550d70))
* **app:** delegate composer selections to base ui primitives ([#36135](https://github.com/okou-ai/okou/issues/36135)) ([a425c95](https://github.com/okou-ai/okou/commit/a425c95edc6d0cc058cfd9de3f8a759dd10e4494))
* **app:** draw the starting-idea card without a tint ([#35585](https://github.com/okou-ai/okou/issues/35585)) ([fa9e0df](https://github.com/okou-ai/okou/commit/fa9e0df7465f6275fdab9b1b96b67deabd2e4e55))
* **app:** give the artifact share menu the app's own menu row ([#35837](https://github.com/okou-ai/okou/issues/35837)) ([9e7fe98](https://github.com/okou-ai/okou/commit/9e7fe98a2cba69eaadb691472913b7b06adcc15a))
* **app:** keep the custom template catalog current over realtime ([#35609](https://github.com/okou-ai/okou/issues/35609)) ([bca1e9e](https://github.com/okou-ai/okou/commit/bca1e9e72b6fdbe8245e700a5d1c31e777c79e99))
* **app:** let fullscreen own its backdrop and drop it where there is nothing to enlarge ([#35579](https://github.com/okou-ai/okou/issues/35579)) ([81c51f3](https://github.com/okou-ai/okou/commit/81c51f32d3c7c2e4bb82a1d0d29ac94be8da958c))
* **app:** let the composer editor fill its input area ([#35849](https://github.com/okou-ai/okou/issues/35849)) ([b17de6c](https://github.com/okou-ai/okou/commit/b17de6c71c06760b1f4cc624229469e75aacff7d))
* **app:** open the slash panel's detail pane as a flyout beside the index ([#35558](https://github.com/okou-ai/okou/issues/35558)) ([8099ce4](https://github.com/okou-ai/okou/commit/8099ce4725305fde2706a1d1431895e802f15028))
* **app:** preserve explicit actions in template and model controls ([#36102](https://github.com/okou-ai/okou/issues/36102)) ([22d4182](https://github.com/okou-ai/okou/commit/22d4182cc6ab6d81a94b3fb7b9a0b17494ba0ce2))
* **app:** remove rename from custom template menu ([#35776](https://github.com/okou-ai/okou/issues/35776)) ([bd8c1c6](https://github.com/okou-ai/okou/commit/bd8c1c6715a2af9375d26b37c126f3a99f61fc89))
* **app:** retain slash category highlight in template flyout ([#35963](https://github.com/okou-ai/okou/issues/35963)) ([95d25a5](https://github.com/okou-ai/okou/commit/95d25a5596e5d4fed4fac1a61aeda61498055ebd))
* **app:** separate webhook labels from copy buttons ([#36129](https://github.com/okou-ai/okou/issues/36129)) ([47c7739](https://github.com/okou-ai/okou/commit/47c7739ec3089609de1bd59b41568aaef6803dff))
* **app:** settle the viewer's terminal states, fullscreen corner and visibility ([#35597](https://github.com/okou-ai/okou/issues/35597)) ([e8d51d2](https://github.com/okou-ai/okou/commit/e8d51d2e26aa80a6bf9a876906dcac3350fcc119))
* **app:** simplify slash template flyout headers ([#35814](https://github.com/okou-ai/okou/issues/35814)) ([800a878](https://github.com/okou-ai/okou/commit/800a8785291540a11177da73dd79b3dc300e22c9))
* **app:** state the composer's task with one chip for both rollouts ([#35897](https://github.com/okou-ai/okou/issues/35897)) ([d7f7df7](https://github.com/okou-ai/okou/commit/d7f7df79ddddccc6d463febeeeebd02e8fe8a31c))
* **app:** use native activation for catalog cards ([#36110](https://github.com/okou-ai/okou/issues/36110)) ([aa4b22d](https://github.com/okou-ai/okou/commit/aa4b22d174e5caaffdf0c26fd81538e7e2b2a0d3))
* **app:** use native labels for computer access rows ([#36237](https://github.com/okou-ai/okou/issues/36237)) ([191eb09](https://github.com/okou-ai/okou/commit/191eb0900d9f8cbf2b076a241d08a2097fe415e1))
* **app:** use official cloudflare access icon ([#36186](https://github.com/okou-ai/okou/issues/36186)) ([33161ca](https://github.com/okou-ai/okou/commit/33161cab0bdc06ac1b3ea39f12da6265b6ea0bf1))
* **app:** withdraw the color theme nobody chose ([#35830](https://github.com/okou-ai/okou/issues/35830)) ([ebfc60a](https://github.com/okou-ai/okou/commit/ebfc60a9ff22ae2d94e034512dee21c13c015cb5))
* **artifacts:** cover blank catalog tiles with their artifact kind ([#35648](https://github.com/okou-ai/okou/issues/35648)) ([fc0da37](https://github.com/okou-ai/okou/commit/fc0da3721b0117dfe166cbc4899c82ade507e8a5))
* **artifacts:** download hosted publications with their member files ([#35664](https://github.com/okou-ai/okou/issues/35664)) ([512f914](https://github.com/okou-ai/okou/commit/512f914a9b6d3908275c2e3a0a9a35e19a8a3c6e))
* **artifacts:** keep chat attachments out of the artifact catalog ([#35655](https://github.com/okou-ai/okou/issues/35655)) ([670a649](https://github.com/okou-ai/okou/commit/670a6496664335866abc0ea78b47975054c8c1ff))
* **browser:** reconcile action callback delivery from chat events ([#36277](https://github.com/okou-ai/okou/issues/36277)) ([4389e4d](https://github.com/okou-ai/okou/commit/4389e4da65310d09eb9eeac6be8115368adf087a))
* **chat:** recognize actions after unambiguous delimiters ([#36059](https://github.com/okou-ai/okou/issues/36059)) ([ca6e855](https://github.com/okou-ai/okou/commit/ca6e8552106d63049c4bde2b203a0d89a8f22a01))
* classify codex access-program rejections ([#35512](https://github.com/okou-ai/okou/issues/35512)) ([fc5e3a2](https://github.com/okou-ai/okou/commit/fc5e3a213970835ae0a5108f4943c0f34d1cadd2))
* export core user data with resumable background jobs ([#35486](https://github.com/okou-ai/okou/issues/35486)) ([e68c5ce](https://github.com/okou-ai/okou/commit/e68c5ce0cf7f07a64eb6397214e177e9226b7429))
* **platform:** activate editor actions through native clicks ([#36034](https://github.com/okou-ai/okou/issues/36034)) ([624c77b](https://github.com/okou-ai/okou/commit/624c77b033f5b95b9972e5760fbf11fe44f7e3b7))
* **platform:** align provider connection rows with models ([#36009](https://github.com/okou-ai/okou/issues/36009)) ([800714f](https://github.com/okou-ai/okou/commit/800714f546187cea1308ea2ac650809dc949583b))
* **platform:** align remote access copy ([#35553](https://github.com/okou-ai/okou/issues/35553)) ([5456ab5](https://github.com/okou-ai/okou/commit/5456ab5305eceddb3d665600ca8bb6dbf6ab90df))
* **platform:** align the artifact catalog error icon with its message row ([#36228](https://github.com/okou-ai/okou/issues/36228)) ([1fbe9ee](https://github.com/okou-ai/okou/commit/1fbe9ee7001a1e5114cb62374bc6fdab3744d903))
* **platform:** align the quest connector list with the dialog it sits in ([#36169](https://github.com/okou-ai/okou/issues/36169)) ([bfef2ab](https://github.com/okou-ai/okou/commit/bfef2ab763519ca6ebe8edaaaa8bdabd32cd1bd4))
* **platform:** align visualization panel with the other task shelves ([#36094](https://github.com/okou-ai/okou/issues/36094)) ([5edd967](https://github.com/okou-ai/okou/commit/5edd967350385555441b155063862ce73049bf00))
* **platform:** anchor conversation previews to expanded ticks ([#35668](https://github.com/okou-ai/okou/issues/35668)) ([11aa4d0](https://github.com/okou-ai/okou/commit/11aa4d00a24d82c5067d5b3b34cb5c7933838fd1))
* **platform:** avoid redundant chat scroll writes ([#36079](https://github.com/okou-ai/okou/issues/36079)) ([a75b075](https://github.com/okou-ai/okou/commit/a75b075d403629dc9f190c7bdab947823d930e0a))
* **platform:** center the compact composer model icon ([#35846](https://github.com/okou-ai/okou/issues/35846)) ([fe0a66a](https://github.com/okou-ai/okou/commit/fe0a66a87248caff0404d53c2a3711b76c8f7c54))
* **platform:** centralize Codex usage reset ([#35920](https://github.com/okou-ai/okou/issues/35920)) ([d16d892](https://github.com/okou-ai/okou/commit/d16d8927bbcd07b009f193cb9e91b8dfed50672f))
* **platform:** clarify email subscription controls ([#36017](https://github.com/okou-ai/okou/issues/36017)) ([5e7bbd1](https://github.com/okou-ai/okou/commit/5e7bbd1c34c72ae40f446196477ab7d0b25cffe6))
* **platform:** clip office preview hover borders ([#36070](https://github.com/okou-ai/okou/issues/36070)) ([c29a185](https://github.com/okou-ai/okou/commit/c29a18588666b3472ee5be77ed77ef45f694da2d))
* **platform:** dock the home composer at the bottom on phones ([#35674](https://github.com/okou-ai/okou/issues/35674)) ([20ac28b](https://github.com/okou-ai/okou/commit/20ac28bd53c79f790c903f185cef483140c49521))
* **platform:** drop the redundant permission card details dialog ([#35862](https://github.com/okou-ai/okou/issues/35862)) ([89fedb2](https://github.com/okou-ai/okou/commit/89fedb22212b6888348f00f62a10c8501d4f53a5))
* **platform:** drop the source filename from a custom template's column ([#35842](https://github.com/okou-ai/okou/issues/35842)) ([3938412](https://github.com/okou-ai/okou/commit/393841246e297f11bde46a1497181e8a3ce66759))
* **platform:** exclude Slack and Teams pages from onboarding ([#36096](https://github.com/okou-ai/okou/issues/36096)) ([7e96f9b](https://github.com/okou-ai/okou/commit/7e96f9bded16c497cd834ad6afb9eee350e1471e))
* **platform:** expand shared conversation diagrams in the page they belong to ([#35636](https://github.com/okou-ai/okou/issues/35636)) ([478a948](https://github.com/okou-ai/okou/commit/478a9486985570a90698e5a4dbe6a8ac897ceaa2))
* **platform:** expose contextual actions to keyboard and touch ([#36128](https://github.com/okou-ai/okou/issues/36128)) ([4a52187](https://github.com/okou-ai/okou/commit/4a52187b5948476e28b406d8dbae4befb4eade8a))
* **platform:** expose localized chat states to screen readers ([#36218](https://github.com/okou-ai/okou/issues/36218)) ([a5246c8](https://github.com/okou-ai/okou/commit/a5246c8b77acf91f839f9c4667eabcc490c868fb))
* **platform:** expose onboarding make cards as action buttons ([#36103](https://github.com/okou-ai/okou/issues/36103)) ([62ec636](https://github.com/okou-ai/okou/commit/62ec636d2abb36c4790bb49757fe09181ec902ee))
* **platform:** hide the template gallery while a template is open over it ([#35593](https://github.com/okou-ai/okou/issues/35593)) ([1307f7c](https://github.com/okou-ai/okou/commit/1307f7cc581f7042a71917eb839d6980dc00d37f))
* **platform:** highlight credit rewards in onboarding entry ([#36112](https://github.com/okou-ai/okou/issues/36112)) ([9085125](https://github.com/okou-ai/okou/commit/9085125c2bf364799c56347fba984b5d764f8ef0))
* **platform:** honor chat filters for the current thread ([#35911](https://github.com/okou-ai/okou/issues/35911)) ([ae9cd83](https://github.com/okou-ai/okou/commit/ae9cd83d86e7924048d76f499e323cd8e045a1ab))
* **platform:** inset the workspace sheet beside the bare nav rail ([#35571](https://github.com/okou-ai/okou/issues/35571)) ([4d8c957](https://github.com/okou-ai/okou/commit/4d8c95714536ba5d048720bb32f07d4de0e2b81b))
* **platform:** isolate complete connector card layers ([#36231](https://github.com/okou-ai/okou/issues/36231)) ([c8918e5](https://github.com/okou-ai/okou/commit/c8918e5db6862d451ae7bf45724dd05f56b1b4f7))
* **platform:** keep a rail's fade after a dialog hands focus back ([#36086](https://github.com/okou-ai/okou/issues/36086)) ([e27df6f](https://github.com/okou-ai/okou/commit/e27df6f451fffbef773f8e36dcef703f21289c2e))
* **platform:** keep show all chats at filter list end ([#36117](https://github.com/okou-ai/okou/issues/36117)) ([a5889eb](https://github.com/okou-ai/okou/commit/a5889eb5454c37bf49264c0809863d267925fa29))
* **platform:** keep the passage toolbar through its own gesture ([#35716](https://github.com/okou-ai/okou/issues/35716)) ([1986050](https://github.com/okou-ai/okou/commit/1986050e6bd3a47415be8fa5d96aad23ed450eda))
* **platform:** label select fields and section navigation ([#36133](https://github.com/okou-ai/okou/issues/36133)) ([ef61a30](https://github.com/okou-ai/okou/commit/ef61a307730d4119a0dfc49e7f0b8f84e0ea1c1a))
* **platform:** let video previews fill the dialog ([#36120](https://github.com/okou-ai/okou/issues/36120)) ([c50c7b0](https://github.com/okou-ai/okou/commit/c50c7b005fdb54de25a9bd6c1bdd05e07fa956b7))
* **platform:** link a url written straight after an ordinal ([#35703](https://github.com/okou-ai/okou/issues/35703)) ([7bc0c7c](https://github.com/okou-ai/okou/commit/7bc0c7cba481e41156c17618231401b7b452bbf7))
* **platform:** make archived a dedicated chat filter ([#35999](https://github.com/okou-ai/okou/issues/35999)) ([6ff9462](https://github.com/okou-ai/okou/commit/6ff94623c0730df7888dc9c425ce33dfe978061c))
* **platform:** make chat list title keyboard accessible ([#36105](https://github.com/okou-ai/okou/issues/36105)) ([ca283c9](https://github.com/okou-ai/okou/commit/ca283c9d8b1fa9f333002cb4bddc2be44f6e9feb))
* **platform:** move Codex reset control into usage header ([#35961](https://github.com/okou-ai/okou/issues/35961)) ([22f085a](https://github.com/okou-ai/okou/commit/22f085a14ce8fe7d7bb467645aed1979bdf223b7))
* **platform:** name debug capture and feishu url controls ([#36131](https://github.com/okou-ai/okou/issues/36131)) ([f38e5f9](https://github.com/okou-ai/okou/commit/f38e5f9cf3aa5b5723d3afa1ee07b64dcc48eb6c))
* **platform:** name the connector directory dialog in detail view ([#36197](https://github.com/okou-ai/okou/issues/36197)) ([0feb143](https://github.com/okou-ai/okou/commit/0feb1436ebfed1922f71e3bb34e3a837def2b977))
* **platform:** offer continue after replacing an unsupported model ([#35583](https://github.com/okou-ai/okou/issues/35583)) ([7bd196f](https://github.com/okou-ai/okou/commit/7bd196fca07d5610e75c4fcdf7f37b87bb7fc630))
* **platform:** place the permission card info icon beside its title ([#35665](https://github.com/okou-ai/okou/issues/35665)) ([451f0e3](https://github.com/okou-ai/okou/commit/451f0e38544dd2b142329c180fc21eb2145fb269))
* **platform:** play chat greeting only on first entry ([#36107](https://github.com/okou-ai/okou/issues/36107)) ([e680b28](https://github.com/okou-ai/okou/commit/e680b2811b5cf824845a04c90d7f0db286aa94e1))
* **platform:** point custom template import at the dispatcher ([#35613](https://github.com/okou-ai/okou/issues/35613)) ([e7e590e](https://github.com/okou-ai/okou/commit/e7e590e22134d1d3c36315d7ac8a9c6a7c7caad0))
* **platform:** present shared conversation artifacts in the page's own viewer ([#35606](https://github.com/okou-ai/okou/issues/35606)) ([27a9108](https://github.com/okou-ai/okou/commit/27a9108bc8138046ebcd8ec325856e85ec64ffc6))
* **platform:** preserve custom templates during catalog refresh ([#35779](https://github.com/okou-ai/okou/issues/35779)) ([df7622c](https://github.com/okou-ai/okou/commit/df7622ca27ad9a781ab86a56cc6b6b76e5d3349e))
* **platform:** preserve popover positioning during composer scrolls ([#36054](https://github.com/okou-ai/okou/issues/36054)) ([44ff06e](https://github.com/okou-ai/okou/commit/44ff06e864880bd9976c71f2c03c02119ecc1479))
* **platform:** preserve preview access for oauth starts ([#35965](https://github.com/okou-ai/okou/issues/35965)) ([f2e669a](https://github.com/okou-ai/okou/commit/f2e669a4293eab3fec0ca39a412ecce67c1ae3c5))
* **platform:** preserve workspace gradients during chat loading ([#35831](https://github.com/okou-ai/okou/issues/35831)) ([f58eceb](https://github.com/okou-ai/okou/commit/f58ecebbcf5497c7b6c718cd2819088e88841fae))
* **platform:** prevent dropdown menu shortcut conflicts ([#35945](https://github.com/okou-ai/okou/issues/35945)) ([a8fc533](https://github.com/okou-ai/okou/commit/a8fc533bf24118381f053b5a8718c6ce49206e7d))
* **platform:** prevent selection toolbar flicker ([#36090](https://github.com/okou-ai/okou/issues/36090)) ([874a016](https://github.com/okou-ai/okou/commit/874a016ca41efe81f9d29d4c022a327378d578ee))
* **platform:** recover chat routes whose active agent is missing ([#35649](https://github.com/okou-ai/okou/issues/35649)) ([70b3fbb](https://github.com/okou-ai/okou/commit/70b3fbbde0285ec771110c46c9e67315bcdc3039))
* **platform:** remove chat filter separator ([#36085](https://github.com/okou-ai/okou/issues/36085)) ([d779698](https://github.com/okou-ai/okou/commit/d779698fbb1d195cdaae83856e5dfea625473d07))
* **platform:** remove connector authorization cancel buttons ([#35569](https://github.com/okou-ai/okou/issues/35569)) ([39cdd93](https://github.com/okou-ai/okou/commit/39cdd936e65536dd42ab8fc7ef8efc18b01e6eae))
* **platform:** remove redundant vnc refresh action ([#35493](https://github.com/okou-ai/okou/issues/35493)) ([668fc86](https://github.com/okou-ai/okou/commit/668fc86f75542cc92275868636e54b38b65b34cb))
* **platform:** render a runless assistant message in the chat transcript ([#35749](https://github.com/okou-ai/okou/issues/35749)) ([9db6557](https://github.com/okou-ai/okou/commit/9db655735490329181bee868ca87ce94aaca5440))
* **platform:** render greeting without agent details ([#36130](https://github.com/okou-ai/okou/issues/36130)) ([087c244](https://github.com/okou-ai/okou/commit/087c2447808863c1822c4335222a0d7b4b7462f8))
* **platform:** reopen slash suggestions after Escape pointer click ([#36185](https://github.com/okou-ai/okou/issues/36185)) ([bb0cea6](https://github.com/okou-ai/okou/commit/bb0cea672991b3c9b68661a26c3d46433efe7204))
* **platform:** resolve each attachment preview graph once per owner ([#35714](https://github.com/okou-ai/okou/issues/35714)) ([2d5d122](https://github.com/okou-ai/okou/commit/2d5d1228513776196161eeae12f2de4635681d87))
* **platform:** resolve optimistic file previews directly ([#36141](https://github.com/okou-ai/okou/issues/36141)) ([f7d300f](https://github.com/okou-ai/okou/commit/f7d300fb8d5a15bd67d5f5b882a92b41e9bdd8b3))
* **platform:** restore native focus for composer chip actions ([#36109](https://github.com/okou-ai/okou/issues/36109)) ([c1a5235](https://github.com/okou-ai/okou/commit/c1a5235fefc565b089d15657f1d39eb1479179a1))
* **platform:** restore native link form and file drop behavior ([#36005](https://github.com/okou-ai/okou/issues/36005)) ([9988495](https://github.com/okou-ai/okou/commit/9988495f370a44c2394fd6c5779bf4038311addf))
* **platform:** reuse resolved artifact identity for sharing ([#35595](https://github.com/okou-ai/okou/issues/35595)) ([52b66bc](https://github.com/okou-ai/okou/commit/52b66bcd8b3d0bc80d0c74db305d2f0a4e2269ef))
* **platform:** rework paid tool copy and the composer notice tray ([#35715](https://github.com/okou-ai/okou/issues/35715)) ([ddff5f1](https://github.com/okou-ai/okou/commit/ddff5f11ec2437826f90a553d3254d9282109122))
* **platform:** scope connector directory keyboard actions ([#35971](https://github.com/okou-ai/okou/issues/35971)) ([8b33098](https://github.com/okou-ai/okou/commit/8b33098582390e25734cc63620c92a236ebd8849))
* **platform:** scope connector directory loading ([#36099](https://github.com/okou-ai/okou/issues/36099)) ([a652869](https://github.com/okou-ai/okou/commit/a6528698ed0483b00c6f30645d9921339179918c))
* **platform:** scope template preview keyboard handling ([#35969](https://github.com/okou-ai/okou/issues/35969)) ([02664c7](https://github.com/okou-ai/okou/commit/02664c7788deca8d47b7d78fad5728f2820ecf0f))
* **platform:** separate template card primary and secondary actions ([#36073](https://github.com/okou-ai/okou/issues/36073)) ([22eb793](https://github.com/okou-ai/okou/commit/22eb793b3063832bb532a98c1fbf8cbc05b5600a))
* **platform:** separate template selection borders from focus rings ([#36241](https://github.com/okou-ai/okou/issues/36241)) ([48aac0e](https://github.com/okou-ai/okou/commit/48aac0e180f45195f0bc64c07af0b242e683370e))
* **platform:** settle the chat greeting avatar instead of snapping it ([#35663](https://github.com/okou-ai/okou/issues/35663)) ([117a4d8](https://github.com/okou-ai/okou/commit/117a4d8afaa7b5091f4839f8c14d7a66d60e11a3))
* **platform:** settle the home entry area on one 40px seam ([#36189](https://github.com/okou-ai/okou/issues/36189)) ([9a96f8f](https://github.com/okou-ai/okou/commit/9a96f8fdb59d0dda46ca38fffedcca5bcd3cc5e7))
* **platform:** show loading while image urls resolve ([#35616](https://github.com/okou-ai/okou/issues/35616)) ([d333248](https://github.com/okou-ai/okou/commit/d3332480e1ab01c7bc11cd8a9974d4d77c766995))
* **platform:** stack the check-in block so its streak track has width ([#35973](https://github.com/okou-ai/okou/issues/35973)) ([f254550](https://github.com/okou-ai/okou/commit/f2545503b045e41612891767edf5a6b9c61a7183))
* **platform:** unfold the chat greeting from the centered avatar ([#35675](https://github.com/okou-ai/okou/issues/35675)) ([c871d25](https://github.com/okou-ai/okou/commit/c871d2596d3cf4effec33150fc0101f4ebd70bde))
* **platform:** use filled foreground for subscription tooltip ([#35924](https://github.com/okou-ai/okou/issues/35924)) ([aa117e7](https://github.com/okou-ai/okou/commit/aa117e74ad4e2d3d6f7d988c2e44e42bfe2239f6))
* **platform:** warm chat caches after message notifications ([#36081](https://github.com/okou-ai/okou/issues/36081)) ([2b45125](https://github.com/okou-ai/okou/commit/2b45125803ab54f6934ff7fb1715f32d0fd36f02))
* refresh API, Platform, and Runner release markers ([#35602](https://github.com/okou-ai/okou/issues/35602)) ([15183dc](https://github.com/okou-ai/okou/commit/15183dc84e3200e177490012ab3a11a90ffb380a))
* refresh api, platform, and runner release markers ([#35702](https://github.com/okou-ai/okou/issues/35702)) ([8f8e88a](https://github.com/okou-ai/okou/commit/8f8e88a73d84e449e46befc07d74f8ee340a73f7))
* show disabled image tool notice when selecting image models ([#36011](https://github.com/okou-ai/okou/issues/36011)) ([4bc9aa0](https://github.com/okou-ai/okou/commit/4bc9aa01e9d174493c5f27e86964f0c7c9765d2e))
* **slack:** handle connection identity conflicts ([#35994](https://github.com/okou-ai/okou/issues/35994)) ([bcfc8f3](https://github.com/okou-ai/okou/commit/bcfc8f36a5b43b7fd1fe2c6c70de594f7d42160b))
* **templates:** name a shared template's owner instead of their account id ([#35774](https://github.com/okou-ai/okou/issues/35774)) ([2372dfd](https://github.com/okou-ai/okou/commit/2372dfdc21e8c2220571d43e5c56f9c7c5130c3f))
* **ui:** delay optimistic message spinner to 2000ms ([#35662](https://github.com/okou-ai/okou/issues/35662)) ([027566e](https://github.com/okou-ai/okou/commit/027566ec5a215905f9d406150df6177262748b46))
* **ui:** delay user message spinner by 500ms ([#35607](https://github.com/okou-ai/okou/issues/35607)) ([f3f85b2](https://github.com/okou-ai/okou/commit/f3f85b26001b30166019bb19deca38b6e7113834))
* **ui:** give floating layers structural safe-area insets ([#35591](https://github.com/okou-ai/okou/issues/35591)) ([41e8b72](https://github.com/okou-ai/okou/commit/41e8b72ef66e1adc87538a3965e4c5e5869a38ab))
* **ui:** make shared visual defaults overridable ([#36244](https://github.com/okou-ai/okou/issues/36244)) ([fcb1fc8](https://github.com/okou-ai/okou/commit/fcb1fc8d29d8e444f43f82cafd4caa5f50cb716c))
* **ui:** restore visible focus on select triggers ([#36020](https://github.com/okou-ai/okou/issues/36020)) ([f558a82](https://github.com/okou-ai/okou/commit/f558a8242b31d31c6cc5037f6662150d18a4f698))
* **ui:** use native autocomplete command interactions ([#36007](https://github.com/okou-ai/okou/issues/36007)) ([fffd27b](https://github.com/okou-ai/okou/commit/fffd27b6602d21c8f934623f6747c37539a1fa44))
* update active github organization references ([#35650](https://github.com/okou-ai/okou/issues/35650)) ([1b873ca](https://github.com/okou-ai/okou/commit/1b873ca87c511fa30284eeb3232b92f4001a2d57))
* update active skill repository references ([#35998](https://github.com/okou-ai/okou/issues/35998)) ([56ffd76](https://github.com/okou-ai/okou/commit/56ffd767f909c366293b8b992330d70ad89bfe09))
* **vnc:** align configuration count display ([#35629](https://github.com/okou-ai/okou/issues/35629)) ([bbe33b2](https://github.com/okou-ai/okou/commit/bbe33b25ab2658acd03a13baeb6471aa0a101594))


### Refactoring

* **app:** derive presentation template previews with computed ([#35449](https://github.com/okou-ai/okou/issues/35449)) ([5753733](https://github.com/okou-ai/okou/commit/57537338d1c12c02d643780e46b512574239f4f4))
* **app:** retire acquisition attribution ([#35324](https://github.com/okou-ai/okou/issues/35324)) ([61618b1](https://github.com/okou-ai/okou/commit/61618b151d9511f0317481976d35423072cf1dc8))
* **app:** use native menus for composer model picker ([#36036](https://github.com/okou-ai/okou/issues/36036)) ([1d029c7](https://github.com/okou-ai/okou/commit/1d029c76d63579440ba0224c98eb3a7958dbaab6))
* **billing:** retire pro-suspend tier ([#35608](https://github.com/okou-ai/okou/issues/35608)) ([9254973](https://github.com/okou-ai/okou/commit/9254973483b81dccfd14ec794fef083b6bfd8b3e))
* bind image navigation shortcuts to preview controls ([#35786](https://github.com/okou-ai/okou/issues/35786)) ([d6a109f](https://github.com/okou-ai/okou/commit/d6a109f4446379e0bd432bd1d0ecc77da92caf44))
* finalize chat and export feature switches ([#35987](https://github.com/okou-ai/okou/issues/35987)) ([4ff8c3b](https://github.com/okou-ai/okou/commit/4ff8c3b5351dab21891e633ee7ed51aaf7abe32f))
* own annotation editor shortcuts in a command ([#35748](https://github.com/okou-ai/okou/issues/35748)) ([d4839e5](https://github.com/okou-ai/okou/commit/d4839e5941ddc84b44e2f975e60d825c09991b56))
* **platform:** delete the orphaned queue waiting field ([#36030](https://github.com/okou-ai/okou/issues/36030)) ([4f2df74](https://github.com/okou-ai/okou/commit/4f2df7463d033c7badd77f157667c64e0fc9d82d)), closes [#34867](https://github.com/okou-ai/okou/issues/34867)
* **platform:** derive the conversation locator from sampled user turns ([#35377](https://github.com/okou-ai/okou/issues/35377)) ([e66063d](https://github.com/okou-ai/okou/commit/e66063d8d3270a971403d9f58c3cd7fa962a76d0))
* **platform:** move sentry noise filtering server-side ([#35993](https://github.com/okou-ai/okou/issues/35993)) ([37e919c](https://github.com/okou-ai/okou/commit/37e919cd7db519a8836911d1afca7143cd81337e))
* **platform:** remove ad hoc timers and completion guards ([#35615](https://github.com/okou-ai/okou/issues/35615)) ([a8ef2c3](https://github.com/okou-ai/okou/commit/a8ef2c340472481713d7dda3a90abb23a54d81f3))
* **platform:** remove duplicate cloudflare access tab ([#36152](https://github.com/okou-ai/okou/issues/36152)) ([416e0ab](https://github.com/okou-ai/okou/commit/416e0ab0ebc66d0746313e9ae6710af0279eb472))
* **platform:** retire the unsaved bar's portal anchors ([#35622](https://github.com/okou-ai/okou/issues/35622)) ([94604ed](https://github.com/okou-ai/okou/commit/94604edc06d17f65f253170256791afe0d494536))
* **platform:** simplify conversation locator rail ([#35918](https://github.com/okou-ai/okou/issues/35918)) ([1bfb6f4](https://github.com/okou-ai/okou/commit/1bfb6f46b5d6e884400ef7209315e7dd2243cc7f))
* **platform:** use css for agent row action visibility ([#35446](https://github.com/okou-ai/okou/issues/35446)) ([c3ce4b7](https://github.com/okou-ai/okou/commit/c3ce4b77511ece49cdcdc893a6fa8122b602e794))
* remove expired deployment compatibility ([#36161](https://github.com/okou-ai/okou/issues/36161)) ([b11509c](https://github.com/okou-ai/okou/commit/b11509c43b4cf1327eae5e40a7782df259e1ffb9))
* remove released chat feature switches ([#36144](https://github.com/okou-ai/okou/issues/36144)) ([3d77ae2](https://github.com/okou-ai/okou/commit/3d77ae255476951c7e7bd72dadf0723b74637c36))
* remove the personal subscription priority feature switch ([#36088](https://github.com/okou-ai/okou/issues/36088)) ([7e96c40](https://github.com/okou-ai/okou/commit/7e96c40b2433475689e64d437ca39c7129c3da1d))
* retire chat thread unreads get endpoint ([#36271](https://github.com/okou-ai/okou/issues/36271)) ([125f010](https://github.com/okou-ai/okou/commit/125f010e0c056b8051f04a5be40049dd5cafc2c6))
* **ui:** migrate overlay composition to native render ([#36013](https://github.com/okou-ai/okou/issues/36013)) ([0a59811](https://github.com/okou-ai/okou/commit/0a59811a9e1a79d5bd663593023287e84fee7dcc))
* **ui:** migrate tooltip triggers to render composition ([#36012](https://github.com/okou-ai/okou/issues/36012)) ([da647d2](https://github.com/okou-ai/okou/commit/da647d2620b92c670992286a13d4d515411f6b71)), closes [#35925](https://github.com/okou-ai/okou/issues/35925)
* **ui:** preserve semantic hosts without button aschild ([#36016](https://github.com/okou-ai/okou/issues/36016)) ([8ea0f44](https://github.com/okou-ai/okou/commit/8ea0f44bd6b8d66451a1b6a1607d4adff1c75e46)), closes [#35925](https://github.com/okou-ai/okou/issues/35925)
* **ui:** restore native select root contracts ([#36071](https://github.com/okou-ai/okou/issues/36071)) ([967855d](https://github.com/okou-ai/okou/commit/967855db91dd5e7f10573f00f4e5bf3876387ffc))
* **ui:** use native overlay timing and positioning parameters ([#36064](https://github.com/okou-ai/okou/issues/36064)) ([8888a3a](https://github.com/okou-ai/okou/commit/8888a3a4763a61a8d9371eb7367d8b24137a29b2))
* use extract-template for custom templates ([#35793](https://github.com/okou-ai/okou/issues/35793)) ([574e19d](https://github.com/okou-ai/okou/commit/574e19d336ef2f7e239c4b89053fa7042cf8ed17))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.497.1
    * @okouai/core bumped to 8.704.0
    * @okouai/ui bumped to 1.12.0
</details>

<details><summary>app-worker: 1.8.104</summary>

## [1.8.104](https://github.com/okou-ai/okou/compare/app-worker-v1.8.103...app-worker-v1.8.104) (2026-09-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.704.0
</details>

<details><summary>cli: 9.357.0</summary>

## [9.357.0](https://github.com/okou-ai/okou/compare/cli-v9.356.1...cli-v9.357.0) (2026-09-23)


### Features

* add saved social data jobs and platform usage ([#35700](https://github.com/okou-ai/okou/issues/35700)) ([ec286d8](https://github.com/okou-ai/okou/commit/ec286d84ccbd1bab235c1baa1cc66f35d1f96ba1))
* add threads and wechat saved social data jobs ([#35789](https://github.com/okou-ai/okou/issues/35789)) ([f753cf4](https://github.com/okou-ai/okou/commit/f753cf44d4f89d5d23be5905973987df8480255c))
* **cli:** add browser user-action requests ([#36065](https://github.com/okou-ai/okou/issues/36065)) ([fd85154](https://github.com/okou-ai/okou/commit/fd851548eb07acf939c8e15a411f8b894af6c2ad))
* **cli:** query current run usage ([#35541](https://github.com/okou-ai/okou/issues/35541)) ([2be9088](https://github.com/okou-ai/okou/commit/2be908850eb21a47c31b930b5f19e7991daf8ff9))
* consolidate chat unread reads into indicators ([#36171](https://github.com/okou-ai/okou/issues/36171)) ([1ca25a4](https://github.com/okou-ai/okou/commit/1ca25a41379780bb0d6add1a086ea359251eea18))
* expose and verify x509plain vnc access ([#35792](https://github.com/okou-ai/okou/issues/35792)) ([e5dfe16](https://github.com/okou-ai/okou/commit/e5dfe16de48753642c81558877bba57cb1f90dce))
* **maps:** replace managed maps apis with grounded search ([#36118](https://github.com/okou-ai/okou/issues/36118)) ([098cc04](https://github.com/okou-ai/okou/commit/098cc049bbb8b5da84be38b1b829b4b8b8522273))
* **pi:** key installed-CLI parity on a session-construction digest ([#36142](https://github.com/okou-ai/okou/issues/36142)) ([322efb6](https://github.com/okou-ai/okou/commit/322efb6d72508e15b90dc788100a776da1485751)), closes [#35967](https://github.com/okou-ai/okou/issues/35967)
* **platform:** move paid tool settings into tools tab ([#36170](https://github.com/okou-ai/okou/issues/36170)) ([1eda981](https://github.com/okou-ai/okou/commit/1eda981b213f20ae18920a3ba1c9a9eb23d2dc08))
* redeploy hosted sites under one stable address ([#35803](https://github.com/okou-ai/okou/issues/35803)) ([acb5c21](https://github.com/okou-ai/okou/commit/acb5c21eed43ddcd65439fd3b14f47c7671fe1d2))
* retire the fal-ai/qwen-image image model ([#35581](https://github.com/okou-ai/okou/issues/35581)) ([86aca4f](https://github.com/okou-ai/okou/commit/86aca4fee17614ab8743b990fe214df6ce98259d))
* **runner:** install the versioned okou cli into the rootfs and gate its use by runtime version ([#36000](https://github.com/okou-ai/okou/issues/36000)) ([8d8f3a3](https://github.com/okou-ai/okou/commit/8d8f3a3e14d23f7471e0773bd9acb988f59217af))
* **templates:** show a document template's first page in the catalog ([#35723](https://github.com/okou-ai/okou/issues/35723)) ([0d07c92](https://github.com/okou-ai/okou/commit/0d07c92b8719a472b61be04574ba87a9527cf5ba))


### Bug Fixes

* align cloudflare access naming ([#35632](https://github.com/okou-ai/okou/issues/35632)) ([708ac2e](https://github.com/okou-ai/okou/commit/708ac2e7cec6250eef99bdae13ce272ea2fff6e9))
* **cli:** limit callback prompts to keep action urls concise ([#35681](https://github.com/okou-ai/okou/issues/35681)) ([2ea078e](https://github.com/okou-ai/okou/commit/2ea078e04b5941c484045e6ec9021ed7829cde4a))
* **cli:** remove website visibility guidance for public hosting ([#36269](https://github.com/okou-ai/okou/issues/36269)) ([37f55ae](https://github.com/okou-ai/okou/commit/37f55ae04589b7080f304932b5137a68c65243b5))
* **cli:** repair presentation convert layout, tables, and hosted decks ([#35713](https://github.com/okou-ai/okou/issues/35713)) ([0e8ed9e](https://github.com/okou-ai/okou/commit/0e8ed9ee764b480d8c5dee1d45e272a7f97987ba))
* **cli:** stop adding private artifact delivery prompts to generation output ([#35720](https://github.com/okou-ai/okou/issues/35720)) ([b0b9997](https://github.com/okou-ai/okou/commit/b0b99976690882c00e27b411fb701eed774002c2))
* **cli:** surface failed mcp calls ([#35562](https://github.com/okou-ai/okou/issues/35562)) ([f92d366](https://github.com/okou-ai/okou/commit/f92d3665968bb3a9e03bb1a8d579c5b1405fb586))
* **pi:** upgrade the pinned runtime to 0.86.1 ([#35840](https://github.com/okou-ai/okou/issues/35840)) ([5a0e66c](https://github.com/okou-ai/okou/commit/5a0e66cbde8dbe2b3ed69f9c03fa8738b97bd0e5))
* update active github organization references ([#35650](https://github.com/okou-ai/okou/issues/35650)) ([1b873ca](https://github.com/okou-ai/okou/commit/1b873ca87c511fa30284eeb3232b92f4001a2d57))
* update active skill repository references ([#35998](https://github.com/okou-ai/okou/issues/35998)) ([56ffd76](https://github.com/okou-ai/okou/commit/56ffd767f909c366293b8b992330d70ad89bfe09))


### Documentation

* **cli:** clarify SERP language codes in help ([#36232](https://github.com/okou-ai/okou/issues/36232)) ([cd33f8d](https://github.com/okou-ai/okou/commit/cd33f8db28164f41c42d4b0fa7df855286900c00))


### Refactoring

* **api:** remove durable pi inference and its sandbox switch ([#35599](https://github.com/okou-ai/okou/issues/35599)) ([4ad646b](https://github.com/okou-ai/okou/commit/4ad646b42ead7c91fab8861220f1fef818071d99))
* **billing:** retire pro-suspend tier ([#35608](https://github.com/okou-ai/okou/issues/35608)) ([9254973](https://github.com/okou-ai/okou/commit/9254973483b81dccfd14ec794fef083b6bfd8b3e))
* remove expired deployment compatibility ([#35915](https://github.com/okou-ai/okou/issues/35915)) ([e9a08cf](https://github.com/okou-ai/okou/commit/e9a08cfb7946ad10b779b86603d08cfb9d08f6f5))
* remove run-usage feature switch ([#36138](https://github.com/okou-ai/okou/issues/36138)) ([9355b61](https://github.com/okou-ai/okou/commit/9355b61c1e61a1b747da8e69391f77217e22f19f))
* retire chat thread unreads get endpoint ([#36271](https://github.com/okou-ai/okou/issues/36271)) ([125f010](https://github.com/okou-ai/okou/commit/125f010e0c056b8051f04a5be40049dd5cafc2c6))
* use extract-template for custom templates ([#35793](https://github.com/okou-ai/okou/issues/35793)) ([574e19d](https://github.com/okou-ai/okou/commit/574e19d336ef2f7e239c4b89053fa7042cf8ed17))


### Performance Improvements

* **pi:** measure pi sandbox startup at parity with codex ([#35896](https://github.com/okou-ai/okou/issues/35896)) ([72604f0](https://github.com/okou-ai/okou/commit/72604f0ca4ea5785ce9be83f57c76a9a493df38f))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @okouai/api-contracts bumped to 1.497.1
    * @okouai/core bumped to 8.704.0
    * @okouai/pi-agent-runtime bumped to 1.40.0
</details>

<details><summary>core: 8.704.0</summary>

## [8.704.0](https://github.com/okou-ai/okou/compare/core-v8.703.0...core-v8.704.0) (2026-09-23)


### Features

* add manual usage reset for claude code subscriptions ([#36165](https://github.com/okou-ai/okou/issues/36165)) ([741e209](https://github.com/okou-ai/okou/commit/741e2092ecb9b944dc41e155cb58787d3316673b))
* add saved social data jobs and platform usage ([#35700](https://github.com/okou-ai/okou/issues/35700)) ([ec286d8](https://github.com/okou-ai/okou/commit/ec286d84ccbd1bab235c1baa1cc66f35d1f96ba1))
* **api-contracts:** add gpt-6-luna run model ([#36164](https://github.com/okou-ai/okou/issues/36164)) ([c86fa91](https://github.com/okou-ai/okou/commit/c86fa91e4a13f42951502f19208277d9b71241e9))
* **api:** add the token-authenticated skill import service ([#35813](https://github.com/okou-ai/okou/issues/35813)) ([8b54e49](https://github.com/okou-ai/okou/commit/8b54e494a7115ac3c5fa3125c7ef425d7bbf1f8e))
* **app:** recommend personalized tasks on the agent home page ([#35881](https://github.com/okou-ai/okou/issues/35881)) ([26dfde0](https://github.com/okou-ai/okou/commit/26dfde0a42e1a45d191508ffcde7348f00925303))
* **browser:** add native user-action request api ([#35845](https://github.com/okou-ai/okou/issues/35845)) ([90935db](https://github.com/okou-ai/okou/commit/90935db3145fb010d2055c207a2fd1275eeac2cb))
* **cli:** query current run usage ([#35541](https://github.com/okou-ai/okou/issues/35541)) ([2be9088](https://github.com/okou-ai/okou/commit/2be908850eb21a47c31b930b5f19e7991daf8ff9))
* **connectors:** gate monday mcp discovery ([#35525](https://github.com/okou-ai/okou/issues/35525)) ([a7384c6](https://github.com/okou-ai/okou/commit/a7384c6f34b5841a424676418e5f57178b21da06))
* **core:** admit every user export to the durable handler ([#35828](https://github.com/okou-ai/okou/issues/35828)) ([9967f71](https://github.com/okou-ai/okou/commit/9967f7191fdae596ba3d049052a345fe9ffe4b6a))
* **core:** enable custom templates for staff ([#35554](https://github.com/okou-ai/okou/issues/35554)) ([bb9baa6](https://github.com/okou-ai/okou/commit/bb9baa60842b5105e412242f468b6c176f6312ff))
* **core:** enable Monday connector for staff ([#35578](https://github.com/okou-ai/okou/issues/35578)) ([3858c60](https://github.com/okou-ai/okou/commit/3858c60deb3c05e8e2e3fba0f746aeb7f82f5598))
* **core:** enable okou models for staff ([#35986](https://github.com/okou-ai/okou/issues/35986)) ([aadef7c](https://github.com/okou-ai/okou/commit/aadef7cf19b0227dcd7e5d0b642fcf6697bcd457))
* **core:** enable pi loop for all users ([#36194](https://github.com/okou-ai/okou/issues/36194)) ([9599f34](https://github.com/okou-ai/okou/commit/9599f34492d19160fa56a0885618bded47c9e2dd))
* **core:** enable Plaud connector for staff ([#35580](https://github.com/okou-ai/okou/issues/35580)) ([8b421f5](https://github.com/okou-ai/okou/commit/8b421f5f28cdeea74da038cfc066b844c98e588c))
* **core:** enable presentation convert for staff ([#35557](https://github.com/okou-ai/okou/issues/35557)) ([94b826c](https://github.com/okou-ai/okou/commit/94b826c0fd7b5649b16e9fe3d0f256b3382cb432))
* **core:** enable run usage for staff ([#35631](https://github.com/okou-ai/okou/issues/35631)) ([cce6b0f](https://github.com/okou-ai/okou/commit/cce6b0f68412f17acf67db685671a0cdbef7a32d))
* **core:** enable simple morning brief for staff org ([#36208](https://github.com/okou-ai/okou/issues/36208)) ([193e7e7](https://github.com/okou-ai/okou/commit/193e7e747dcc611e4bf2f3f1cb5dc00d51e53e6a))
* **core:** enable social data jobs for staff org ([#36084](https://github.com/okou-ai/okou/issues/36084)) ([0e5b454](https://github.com/okou-ai/okou/commit/0e5b454a3b5261a5dc7ae6edf1cd3435032ee159))
* **core:** release color themes to every workspace ([#35645](https://github.com/okou-ai/okou/issues/35645)) ([95569a7](https://github.com/okou-ai/okou/commit/95569a7cdae3b6f6795f6b8ae545bb46a41375b0))
* **core:** release the welcome thread to every workspace ([#35586](https://github.com/okou-ai/okou/issues/35586)) ([6bb62d1](https://github.com/okou-ai/okou/commit/6bb62d1157a83b416d91f77705bb448182196f64))
* **core:** release user message links to every reader ([#36021](https://github.com/okou-ai/okou/issues/36021)) ([a0adec6](https://github.com/okou-ai/okou/commit/a0adec6432eff599d2e7da0740a1216416e2deb1))
* **model-provider:** add feature-gated okou 1.0 models ([#35884](https://github.com/okou-ai/okou/issues/35884)) ([b996e92](https://github.com/okou-ai/okou/commit/b996e92cc31d3038fd0a403decf66736597e5ce0))
* **model-provider:** gate alternative deepseek routing ([#35775](https://github.com/okou-ai/okou/issues/35775)) ([8cffdc6](https://github.com/okou-ai/okou/commit/8cffdc6ecfd86b58ac65c61c62d20bed6ece2d8b))
* **models:** add Claude Opus 5.5 ([#36168](https://github.com/okou-ai/okou/issues/36168)) ([e0fc624](https://github.com/okou-ai/okou/commit/e0fc62414d039c9e0dfda36145c2e62edfcf79a2))
* **onboarding:** finish the source-first flow and keep its answers ([#35812](https://github.com/okou-ai/okou/issues/35812)) ([83a08f0](https://github.com/okou-ai/okou/commit/83a08f0a4b676cff845b23a4e24cc8676065f42c))
* **onboarding:** generate context-aware recommendations ([#36108](https://github.com/okou-ai/okou/issues/36108)) ([0023929](https://github.com/okou-ai/okou/commit/0023929d062c6acea2396dd4f2a1f7ae8bb1872e))
* **pi-memory:** enable staff organization rollout ([#36272](https://github.com/okou-ai/okou/issues/36272)) ([342ab23](https://github.com/okou-ai/okou/commit/342ab23fe47e705bbb62b20494f20086e4408404))
* **pi:** keep the fable frontier line on the vendor harness ([#35908](https://github.com/okou-ai/okou/issues/35908)) ([c357b8e](https://github.com/okou-ai/okou/commit/c357b8ee446cc1bf47f8552d3f959b967069bc2f))
* **platform:** add remote control and private network connector scopes ([#36209](https://github.com/okou-ai/okou/issues/36209)) ([4340730](https://github.com/okou-ai/okou/commit/4340730c12d7f666baabd3b3d1f64a3364e30c05))
* **platform:** add source-first onboarding screens behind a switch ([#34927](https://github.com/okou-ai/okou/issues/34927)) ([1605bf4](https://github.com/okou-ai/okou/commit/1605bf46bdeaf2ffbde64c697ebfeb3e24e710ec))
* **platform:** add unread-only chat shortcut ([#35898](https://github.com/okou-ai/okou/issues/35898)) ([1ee024b](https://github.com/okou-ai/okou/commit/1ee024b30118b50892db99d13fee1b9d0747d63c))
* **platform:** back the chat home avatar with a brand texture ([#35783](https://github.com/okou-ai/okou/issues/35783)) ([8a1366d](https://github.com/okou-ai/okou/commit/8a1366da03ad829f7af1be96365983abcb849a35))
* **platform:** give the default agent avatar its own texture ([#35901](https://github.com/okou-ai/okou/issues/35901)) ([b503a49](https://github.com/okou-ai/okou/commit/b503a49b709681dae650d0ca46a08243da39c6a2))
* **platform:** hide video discovery entries for new accounts ([#35790](https://github.com/okou-ai/okou/issues/35790)) ([c8dd8ba](https://github.com/okou-ai/okou/commit/c8dd8ba9e605f13c97a011728fb881834b9f343e))
* **platform:** link plain urls in user messages ([#35564](https://github.com/okou-ai/okou/issues/35564)) ([3d8a17a](https://github.com/okou-ai/okou/commit/3d8a17a1633ece078a943ae0ad99c39cf5b4e62a))
* **platform:** move paid tool settings into tools tab ([#36170](https://github.com/okou-ai/okou/issues/36170)) ([1eda981](https://github.com/okou-ai/okou/commit/1eda981b213f20ae18920a3ba1c9a9eb23d2dc08))
* retire the fal-ai/qwen-image image model ([#35581](https://github.com/okou-ai/okou/issues/35581)) ([86aca4f](https://github.com/okou-ai/okou/commit/86aca4fee17614ab8743b990fe214df6ce98259d))


### Bug Fixes

* export core user data with resumable background jobs ([#35486](https://github.com/okou-ai/okou/issues/35486)) ([e68c5ce](https://github.com/okou-ai/okou/commit/e68c5ce0cf7f07a64eb6397214e177e9226b7429))
* keep deepseek openrouter routes global ([#35852](https://github.com/okou-ai/okou/issues/35852)) ([73d8915](https://github.com/okou-ai/okou/commit/73d891553ec6ba74f4a0786573dc45b01ab5e811))
* update active github organization references ([#35650](https://github.com/okou-ai/okou/issues/35650)) ([1b873ca](https://github.com/okou-ai/okou/commit/1b873ca87c511fa30284eeb3232b92f4001a2d57))
* update active skill repository references ([#35998](https://github.com/okou-ai/okou/issues/35998)) ([56ffd76](https://github.com/okou-ai/okou/commit/56ffd767f909c366293b8b992330d70ad89bfe09))


### CI

* prepare runtime references for okou-ai rename ([#35352](https://github.com/okou-ai/okou/issues/35352)) ([e0445aa](https://github.com/okou-ai/okou/commit/e0445aa875eae424817d932886e6de38895ce986))


### Refactoring

* **api:** remove durable pi inference and its sandbox switch ([#35599](https://github.com/okou-ai/okou/issues/35599)) ([4ad646b](https://github.com/okou-ai/okou/commit/4ad646b42ead7c91fab8861220f1fef818071d99))
* finalize chat and export feature switches ([#35987](https://github.com/okou-ai/okou/issues/35987)) ([4ff8c3b](https://github.com/okou-ai/okou/commit/4ff8c3b5351dab21891e633ee7ed51aaf7abe32f))
* **pi:** decide admission from an exhaustive model policy table ([#35893](https://github.com/okou-ai/okou/issues/35893)) ([97bde50](https://github.com/okou-ai/okou/commit/97bde504c506b16e583fb6a241eecc3d5a5eb516))
* remove internal prefixes from subscription switches ([#36246](https://github.com/okou-ai/okou/issues/36246)) ([0110bf6](https://github.com/okou-ai/okou/commit/0110bf61d79d2157cf89c2e75999bbc453d80f86))
* remove mcp server feature switch ([#35957](https://github.com/okou-ai/okou/issues/35957)) ([9cd2d93](https://github.com/okou-ai/okou/commit/9cd2d935892c86e50dfd39319ac75411f77f677e))
* remove released chat feature switches ([#36144](https://github.com/okou-ai/okou/issues/36144)) ([3d77ae2](https://github.com/okou-ai/okou/commit/3d77ae255476951c7e7bd72dadf0723b74637c36))
* remove run-usage feature switch ([#36138](https://github.com/okou-ai/okou/issues/36138)) ([9355b61](https://github.com/okou-ai/okou/commit/9355b61c1e61a1b747da8e69391f77217e22f19f))
* remove the personal subscription priority feature switch ([#36088](https://github.com/okou-ai/okou/issues/36088)) ([7e96c40](https://github.com/okou-ai/okou/commit/7e96c40b2433475689e64d437ca39c7129c3da1d))
* remove the stripe marketplace oauth feature switch ([#35623](https://github.com/okou-ai/okou/issues/35623)) ([cc48fcf](https://github.com/okou-ai/okou/commit/cc48fcf04b8972204e619837915a59316d4b2326))


### Performance Improvements

* **api:** attribute admission lock time by attempt ([#36280](https://github.com/okou-ai/okou/issues/36280)) ([2d2846b](https://github.com/okou-ai/okou/commit/2d2846bfcc33afaf5e6a66117d561906dec9a470))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.497.1
</details>

<details><summary>db: 1.291.0</summary>

## [1.291.0](https://github.com/okou-ai/okou/compare/db-v1.290.0...db-v1.291.0) (2026-09-23)


### Features

* add saved social data jobs and platform usage ([#35700](https://github.com/okou-ai/okou/issues/35700)) ([ec286d8](https://github.com/okou-ai/okou/commit/ec286d84ccbd1bab235c1baa1cc66f35d1f96ba1))
* **api:** add chat_thread_drafts and write it with the legacy draft columns ([#36254](https://github.com/okou-ai/okou/issues/36254)) ([7aa5683](https://github.com/okou-ai/okou/commit/7aa5683eb4d7e76f347e4610639314b831c7eb15))
* **api:** default new organizations to gpt-6 luna ([#36166](https://github.com/okou-ai/okou/issues/36166)) ([a202943](https://github.com/okou-ai/okou/commit/a20294342f008216e87fc242b0e03ff32ea30124))
* **app:** recommend personalized tasks on the agent home page ([#35881](https://github.com/okou-ai/okou/issues/35881)) ([26dfde0](https://github.com/okou-ai/okou/commit/26dfde0a42e1a45d191508ffcde7348f00925303))
* **browser:** add native user-action request api ([#35845](https://github.com/okou-ai/okou/issues/35845)) ([90935db](https://github.com/okou-ai/okou/commit/90935db3145fb010d2055c207a2fd1275eeac2cb))
* connect agentphone with one-time codes ([#35582](https://github.com/okou-ai/okou/issues/35582)) ([d2ebce8](https://github.com/okou-ai/okou/commit/d2ebce8a2944f417a0ca7c2583e95b2fdd02dce0))
* expand free byok and plan concurrency ([#35610](https://github.com/okou-ai/okou/issues/35610)) ([5430b89](https://github.com/okou-ai/okou/commit/5430b89a8c88a976e4ca90bd1d9b8ee67c526466))
* **maps:** replace managed maps apis with grounded search ([#36118](https://github.com/okou-ai/okou/issues/36118)) ([098cc04](https://github.com/okou-ai/okou/commit/098cc049bbb8b5da84be38b1b829b4b8b8522273))
* **model-provider:** add feature-gated okou 1.0 models ([#35884](https://github.com/okou-ai/okou/issues/35884)) ([b996e92](https://github.com/okou-ai/okou/commit/b996e92cc31d3038fd0a403decf66736597e5ce0))
* **models:** gate new workspace model policies ([#35871](https://github.com/okou-ai/okou/issues/35871)) ([f76ce1d](https://github.com/okou-ai/okou/commit/f76ce1dc9789c75c6c23cf70f1d5378e16721d68))
* **onboarding:** finish the source-first flow and keep its answers ([#35812](https://github.com/okou-ai/okou/issues/35812)) ([83a08f0](https://github.com/okou-ai/okou/commit/83a08f0a4b676cff845b23a4e24cc8676065f42c))
* refine home task recommendations ([#36238](https://github.com/okou-ai/okou/issues/36238)) ([9e49b9c](https://github.com/okou-ai/okou/commit/9e49b9c9a2c50d449c478b8b9be17f7bff4a0a7c))
* **templates:** show a document template's first page in the catalog ([#35723](https://github.com/okou-ai/okou/issues/35723)) ([0d07c92](https://github.com/okou-ai/okou/commit/0d07c92b8719a472b61be04574ba87a9527cf5ba))
* **vnc:** add typed ssh transport to saved connections ([#35910](https://github.com/okou-ai/okou/issues/35910)) ([79069cb](https://github.com/okou-ai/okou/commit/79069cbbc0f48136df9520306aa06a6990e056c2))
* **vnc:** add x509plain configuration ([#35653](https://github.com/okou-ai/okou/issues/35653)) ([6ed63da](https://github.com/okou-ai/okou/commit/6ed63da7dcca337b6b7cac91752e9df1319c0aac))


### Bug Fixes

* **api:** advertise current run usage to agents ([#35627](https://github.com/okou-ai/okou/issues/35627)) ([67a701c](https://github.com/okou-ai/okou/commit/67a701ca94c65fcd0bce202ceb3bbd2a8a60189a))
* **api:** drain chat search gin between projection transactions ([#35633](https://github.com/okou-ai/okou/issues/35633)) ([8e1fe5d](https://github.com/okou-ai/okou/commit/8e1fe5dbad87087d540d26f4ba7ff10589cd08b4))
* **api:** finalize a healthy multi-source morning brief collection ([#35669](https://github.com/okou-ai/okou/issues/35669)) ([94c366f](https://github.com/okou-ai/okou/commit/94c366fb7065eb4b1ca5fd4c3c6582fb36c86f46))
* **app:** withdraw the color theme nobody chose ([#35830](https://github.com/okou-ai/okou/issues/35830)) ([ebfc60a](https://github.com/okou-ai/okou/commit/ebfc60a9ff22ae2d94e034512dee21c13c015cb5))
* **artifacts:** keep chat attachments out of the artifact catalog ([#35655](https://github.com/okou-ai/okou/issues/35655)) ([670a649](https://github.com/okou-ai/okou/commit/670a6496664335866abc0ea78b47975054c8c1ff))
* **db:** track the dcr encrypted column in the kms recovery manifest ([#35639](https://github.com/okou-ai/okou/issues/35639)) ([0c4023e](https://github.com/okou-ai/okou/commit/0c4023e9cf140f0539e20822d84c210dddadf09a))
* export core user data with resumable background jobs ([#35486](https://github.com/okou-ai/okou/issues/35486)) ([e68c5ce](https://github.com/okou-ai/okou/commit/e68c5ce0cf7f07a64eb6397214e177e9226b7429))


### Refactoring

* **api:** decouple billing reads from deletable run data ([#35909](https://github.com/okou-ai/okou/issues/35909)) ([b154c81](https://github.com/okou-ai/okou/commit/b154c814a823599b17de086bccad894f7e39dc86))
* **api:** persist artifact catalog sync work explicitly ([#36258](https://github.com/okou-ai/okou/issues/36258)) ([3a31343](https://github.com/okou-ai/okou/commit/3a31343fd9a8222756235b464482dd084a72040a))
* **api:** remove durable pi inference and its sandbox switch ([#35599](https://github.com/okou-ai/okou/issues/35599)) ([4ad646b](https://github.com/okou-ai/okou/commit/4ad646b42ead7c91fab8861220f1fef818071d99))
* **billing:** retire pro-suspend tier ([#35608](https://github.com/okou-ai/okou/issues/35608)) ([9254973](https://github.com/okou-ai/okou/commit/9254973483b81dccfd14ec794fef083b6bfd8b3e))
* **db:** drop the durable pi inference tables and their schema ([#35666](https://github.com/okou-ai/okou/issues/35666)) ([fccfcd0](https://github.com/okou-ai/okou/commit/fccfcd045a86e1085244b7210bf0fb481e5186be))
* **db:** move the imported deck into user_templates ([#35718](https://github.com/okou-ai/okou/issues/35718)) ([955a964](https://github.com/okou-ai/okou/commit/955a964f8fdb884c13b2804d9c9b821c6b835f52))
* remove retired hosted publication version columns ([#35323](https://github.com/okou-ai/okou/issues/35323)) ([d2032e5](https://github.com/okou-ai/okou/commit/d2032e55ce1e25d8f438e488948e9fe9ccb88de5))
* remove run-usage feature switch ([#36138](https://github.com/okou-ai/okou/issues/36138)) ([9355b61](https://github.com/okou-ai/okou/commit/9355b61c1e61a1b747da8e69391f77217e22f19f))
* **slack:** retire the legacy failed ingress status ([#35658](https://github.com/okou-ai/okou/issues/35658)) ([e65ccab](https://github.com/okou-ai/okou/commit/e65ccab9cb25c15094fe87983b73bc88e0bf5408))


### Performance Improvements

* **api:** fold account-erasure admission and drop read-path locks ([#35743](https://github.com/okou-ai/okou/issues/35743)) ([1508239](https://github.com/okou-ai/okou/commit/1508239ac9df904bec8c01a981d535651a87c128))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.497.1
    * @okouai/core bumped to 8.704.0
</details>

<details><summary>desktop: 0.48.134</summary>

## [0.48.134](https://github.com/okou-ai/okou/compare/desktop-v0.48.133...desktop-v0.48.134) (2026-09-23)


### Bug Fixes

* **desktop:** abort the auth session lifetime on app quit ([#35719](https://github.com/okou-ai/okou/issues/35719)) ([84331a2](https://github.com/okou-ai/okou/commit/84331a2eff0e42be50a893a0bc3ba63e2d0921a3)), closes [#35717](https://github.com/okou-ai/okou/issues/35717)
* **desktop:** classify superseded auth teardown as cancelled ([#35858](https://github.com/okou-ai/okou/issues/35858)) ([b511045](https://github.com/okou-ai/okou/commit/b5110459543201bee995006e0f0e41726aac16c5))
* **desktop:** end the auth lifetime on the auto-update quit path ([#35958](https://github.com/okou-ai/okou/issues/35958)) ([e969bec](https://github.com/okou-ai/okou/commit/e969bec94d2aa1bf99f00fe7080c690c607bd8c1))
* **desktop:** recover a transient session restore without opening the window ([#35612](https://github.com/okou-ai/okou/issues/35612)) ([bcaf967](https://github.com/okou-ai/okou/commit/bcaf9679b99f3c3fd9f9ab946736c1b959c5cca8))
* **desktop:** split the auth deadline between sign-in and validation ([#36050](https://github.com/okou-ai/okou/issues/36050)) ([758715f](https://github.com/okou-ai/okou/commit/758715f1631345f9ac65f7a51f5595d8d2c4d9d9))
* update active github organization references ([#35650](https://github.com/okou-ai/okou/issues/35650)) ([1b873ca](https://github.com/okou-ai/okou/commit/1b873ca87c511fa30284eeb3232b92f4001a2d57))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.497.1
</details>

<details><summary>host-worker: 1.6.0</summary>

## [1.6.0](https://github.com/okou-ai/okou/compare/host-worker-v1.5.33...host-worker-v1.6.0) (2026-09-23)


### Features

* redeploy hosted sites under one stable address ([#35803](https://github.com/okou-ai/okou/issues/35803)) ([acb5c21](https://github.com/okou-ai/okou/commit/acb5c21eed43ddcd65439fd3b14f47c7671fe1d2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.497.1
</details>

<details><summary>pi-agent-runtime: 1.40.0</summary>

## [1.40.0](https://github.com/okou-ai/okou/compare/pi-agent-runtime-v1.39.2...pi-agent-runtime-v1.40.0) (2026-09-23)


### Features

* **api-contracts:** add gpt-6-luna run model ([#36164](https://github.com/okou-ai/okou/issues/36164)) ([c86fa91](https://github.com/okou-ai/okou/commit/c86fa91e4a13f42951502f19208277d9b71241e9))
* **api:** run built-in pi memory stages on deepseek flash models ([#35759](https://github.com/okou-ai/okou/issues/35759)) ([218259b](https://github.com/okou-ai/okou/commit/218259b3c99ecacb15fbd1bd63577096957ebf87))
* **model-provider:** add feature-gated okou 1.0 models ([#35884](https://github.com/okou-ai/okou/issues/35884)) ([b996e92](https://github.com/okou-ai/okou/commit/b996e92cc31d3038fd0a403decf66736597e5ce0))
* **models:** add Claude Opus 5.5 ([#36168](https://github.com/okou-ai/okou/issues/36168)) ([e0fc624](https://github.com/okou-ai/okou/commit/e0fc62414d039c9e0dfda36145c2e62edfcf79a2))
* **pi:** key installed-CLI parity on a session-construction digest ([#36142](https://github.com/okou-ai/okou/issues/36142)) ([322efb6](https://github.com/okou-ai/okou/commit/322efb6d72508e15b90dc788100a776da1485751)), closes [#35967](https://github.com/okou-ai/okou/issues/35967)
* **runner:** install the versioned okou cli into the rootfs and gate its use by runtime version ([#36000](https://github.com/okou-ai/okou/issues/36000)) ([8d8f3a3](https://github.com/okou-ai/okou/commit/8d8f3a3e14d23f7471e0773bd9acb988f59217af))


### Bug Fixes

* **api:** point built-in pi memory extraction at the served deepseek flash model ([#35800](https://github.com/okou-ai/okou/issues/35800)) ([e07fe0b](https://github.com/okou-ai/okou/commit/e07fe0b3f2e06d34b64abd84efd86d649319913e))
* **pi:** retry structurally diagnosed transient provider failures ([#35819](https://github.com/okou-ai/okou/issues/35819)) ([a426df6](https://github.com/okou-ai/okou/commit/a426df6a3b476abe28ce1edef12c5bb48d93fa30)), closes [#35577](https://github.com/okou-ai/okou/issues/35577)
* **pi:** upgrade the pinned runtime to 0.86.1 ([#35840](https://github.com/okou-ai/okou/issues/35840)) ([5a0e66c](https://github.com/okou-ai/okou/commit/5a0e66cbde8dbe2b3ed69f9c03fa8738b97bd0e5))


### Refactoring

* **pi:** decide admission from an exhaustive model policy table ([#35893](https://github.com/okou-ai/okou/issues/35893)) ([97bde50](https://github.com/okou-ai/okou/commit/97bde504c506b16e583fb6a241eecc3d5a5eb516))
* **pi:** limit api-first execution to strict first turns ([#36202](https://github.com/okou-ai/okou/issues/36202)) ([1d47a9c](https://github.com/okou-ai/okou/commit/1d47a9cae6d58a61e4cf86893abcb0f8447c48ad))
* **pi:** move intermediate commentary into the harness base prompt ([#35844](https://github.com/okou-ai/okou/issues/35844)) ([ec32935](https://github.com/okou-ai/okou/commit/ec32935bd4086e11698de7f25b42d3c31d5e7735))


### Performance Improvements

* **api:** instrument the unattributed pre-provider dispatch interval ([#36095](https://github.com/okou-ai/okou/issues/36095)) ([e6e3286](https://github.com/okou-ai/okou/commit/e6e32869d1b62ab65f7a3cf4a393191cfaf77782))
* **pi:** measure pi sandbox startup at parity with codex ([#35896](https://github.com/okou-ai/okou/issues/35896)) ([72604f0](https://github.com/okou-ai/okou/commit/72604f0ca4ea5785ce9be83f57c76a9a493df38f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.497.1
  * devDependencies
    * @okouai/core bumped to 8.704.0
</details>

<details><summary>ui: 1.12.0</summary>

## [1.12.0](https://github.com/okou-ai/okou/compare/ui-v1.11.8...ui-v1.12.0) (2026-09-23)


### Features

* **platform:** link plain urls in user messages ([#35564](https://github.com/okou-ai/okou/issues/35564)) ([3d8a17a](https://github.com/okou-ai/okou/commit/3d8a17a1633ece078a943ae0ad99c39cf5b4e62a))


### Bug Fixes

* **app:** give the artifact share menu the app's own menu row ([#35837](https://github.com/okou-ai/okou/issues/35837)) ([9e7fe98](https://github.com/okou-ai/okou/commit/9e7fe98a2cba69eaadb691472913b7b06adcc15a))
* **app:** preserve explicit actions in template and model controls ([#36102](https://github.com/okou-ai/okou/issues/36102)) ([22d4182](https://github.com/okou-ai/okou/commit/22d4182cc6ab6d81a94b3fb7b9a0b17494ba0ce2))
* **platform:** activate editor actions through native clicks ([#36034](https://github.com/okou-ai/okou/issues/36034)) ([624c77b](https://github.com/okou-ai/okou/commit/624c77b033f5b95b9972e5760fbf11fe44f7e3b7))
* **platform:** anchor conversation previews to expanded ticks ([#35668](https://github.com/okou-ai/okou/issues/35668)) ([11aa4d0](https://github.com/okou-ai/okou/commit/11aa4d00a24d82c5067d5b3b34cb5c7933838fd1))
* **platform:** expose localized chat states to screen readers ([#36218](https://github.com/okou-ai/okou/issues/36218)) ([a5246c8](https://github.com/okou-ai/okou/commit/a5246c8b77acf91f839f9c4667eabcc490c868fb))
* **platform:** hide the template gallery while a template is open over it ([#35593](https://github.com/okou-ai/okou/issues/35593)) ([1307f7c](https://github.com/okou-ai/okou/commit/1307f7cc581f7042a71917eb839d6980dc00d37f))
* **platform:** preserve popover positioning during composer scrolls ([#36054](https://github.com/okou-ai/okou/issues/36054)) ([44ff06e](https://github.com/okou-ai/okou/commit/44ff06e864880bd9976c71f2c03c02119ecc1479))
* **platform:** prevent dropdown menu shortcut conflicts ([#35945](https://github.com/okou-ai/okou/issues/35945)) ([a8fc533](https://github.com/okou-ai/okou/commit/a8fc533bf24118381f053b5a8718c6ce49206e7d))
* **ui:** delay optimistic message spinner to 2000ms ([#35662](https://github.com/okou-ai/okou/issues/35662)) ([027566e](https://github.com/okou-ai/okou/commit/027566ec5a215905f9d406150df6177262748b46))
* **ui:** delay user message spinner by 500ms ([#35607](https://github.com/okou-ai/okou/issues/35607)) ([f3f85b2](https://github.com/okou-ai/okou/commit/f3f85b26001b30166019bb19deca38b6e7113834))
* **ui:** give floating layers structural safe-area insets ([#35591](https://github.com/okou-ai/okou/issues/35591)) ([41e8b72](https://github.com/okou-ai/okou/commit/41e8b72ef66e1adc87538a3965e4c5e5869a38ab))
* **ui:** make shared visual defaults overridable ([#36244](https://github.com/okou-ai/okou/issues/36244)) ([fcb1fc8](https://github.com/okou-ai/okou/commit/fcb1fc8d29d8e444f43f82cafd4caa5f50cb716c))
* **ui:** restore visible focus on select triggers ([#36020](https://github.com/okou-ai/okou/issues/36020)) ([f558a82](https://github.com/okou-ai/okou/commit/f558a8242b31d31c6cc5037f6662150d18a4f698))
* **ui:** use native autocomplete command interactions ([#36007](https://github.com/okou-ai/okou/issues/36007)) ([fffd27b](https://github.com/okou-ai/okou/commit/fffd27b6602d21c8f934623f6747c37539a1fa44))


### Refactoring

* **app:** use native menus for composer model picker ([#36036](https://github.com/okou-ai/okou/issues/36036)) ([1d029c7](https://github.com/okou-ai/okou/commit/1d029c76d63579440ba0224c98eb3a7958dbaab6))
* **platform:** remove ad hoc timers and completion guards ([#35615](https://github.com/okou-ai/okou/issues/35615)) ([a8ef2c3](https://github.com/okou-ai/okou/commit/a8ef2c340472481713d7dda3a90abb23a54d81f3))
* **platform:** retire the unsaved bar's portal anchors ([#35622](https://github.com/okou-ai/okou/issues/35622)) ([94604ed](https://github.com/okou-ai/okou/commit/94604edc06d17f65f253170256791afe0d494536))
* **ui:** migrate overlay composition to native render ([#36013](https://github.com/okou-ai/okou/issues/36013)) ([0a59811](https://github.com/okou-ai/okou/commit/0a59811a9e1a79d5bd663593023287e84fee7dcc))
* **ui:** migrate tooltip triggers to render composition ([#36012](https://github.com/okou-ai/okou/issues/36012)) ([da647d2](https://github.com/okou-ai/okou/commit/da647d2620b92c670992286a13d4d515411f6b71)), closes [#35925](https://github.com/okou-ai/okou/issues/35925)
* **ui:** preserve semantic hosts without button aschild ([#36016](https://github.com/okou-ai/okou/issues/36016)) ([8ea0f44](https://github.com/okou-ai/okou/commit/8ea0f44bd6b8d66451a1b6a1607d4adff1c75e46)), closes [#35925](https://github.com/okou-ai/okou/issues/35925)
* **ui:** remove unused multi-select combobox ([#36067](https://github.com/okou-ai/okou/issues/36067)) ([a7f75a5](https://github.com/okou-ai/okou/commit/a7f75a5e045b7cf863929aaf159b57dcc073bdb9))
* **ui:** restore native select root contracts ([#36071](https://github.com/okou-ai/okou/issues/36071)) ([967855d](https://github.com/okou-ai/okou/commit/967855db91dd5e7f10573f00f4e5bf3876387ffc))
* **ui:** use native overlay timing and positioning parameters ([#36064](https://github.com/okou-ai/okou/issues/36064)) ([8888a3a](https://github.com/okou-ai/okou/commit/8888a3a4763a61a8d9371eb7367d8b24137a29b2))
</details>

<details><summary>api: 1.663.1</summary>

## [1.663.1](https://github.com/okou-ai/okou/compare/api-v1.663.0...api-v1.663.1) (2026-09-23)


### Refactoring

* retire chat thread unreads get endpoint ([#36271](https://github.com/okou-ai/okou/issues/36271)) ([125f010](https://github.com/okou-ai/okou/commit/125f010e0c056b8051f04a5be40049dd5cafc2c6))


### Performance Improvements

* **api:** attribute admission lock time by attempt ([#36280](https://github.com/okou-ai/okou/issues/36280)) ([2d2846b](https://github.com/okou-ai/okou/commit/2d2846bfcc33afaf5e6a66117d561906dec9a470))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.497.1
    * @okouai/core bumped to 8.704.0
    * @okouai/db bumped to 1.291.0
    * @okouai/pi-agent-runtime bumped to 1.40.0
</details>

<details><summary>guest-agent: 0.99.0</summary>

## [0.99.0](https://github.com/okou-ai/okou/compare/guest-agent-v0.98.1...guest-agent-v0.99.0) (2026-09-23)


### Features

* **api-contracts:** add gpt-6-luna run model ([#36164](https://github.com/okou-ai/okou/issues/36164)) ([c86fa91](https://github.com/okou-ai/okou/commit/c86fa91e4a13f42951502f19208277d9b71241e9))
* enable native web search fallback for byok runs ([#35827](https://github.com/okou-ai/okou/issues/35827)) ([02a6cc4](https://github.com/okou-ai/okou/commit/02a6cc450c2f93ecd143c13982b06f83ec23d124))
* **guest-agent:** name the record type on oversized and large cli stdout events ([#35865](https://github.com/okou-ai/okou/issues/35865)) ([23d2532](https://github.com/okou-ai/okou/commit/23d253227788d6588ff28288443a3decc4ab03a4))
* **models:** add Claude Opus 5.5 ([#36168](https://github.com/okou-ai/okou/issues/36168)) ([e0fc624](https://github.com/okou-ai/okou/commit/e0fc62414d039c9e0dfda36145c2e62edfcf79a2))
* **pi:** key installed-CLI parity on a session-construction digest ([#36142](https://github.com/okou-ai/okou/issues/36142)) ([322efb6](https://github.com/okou-ai/okou/commit/322efb6d72508e15b90dc788100a776da1485751)), closes [#35967](https://github.com/okou-ai/okou/issues/35967)
* **runner:** install the versioned okou cli into the rootfs and gate its use by runtime version ([#36000](https://github.com/okou-ai/okou/issues/36000)) ([8d8f3a3](https://github.com/okou-ai/okou/commit/8d8f3a3e14d23f7471e0773bd9acb988f59217af))


### Bug Fixes

* classify codex access-program rejections ([#35512](https://github.com/okou-ai/okou/issues/35512)) ([fc5e3a2](https://github.com/okou-ai/okou/commit/fc5e3a213970835ae0a5108f4943c0f34d1cadd2))
* **guest-agent:** stop oversized pi agent_end records from losing a run ([#36119](https://github.com/okou-ai/okou/issues/36119)) ([f4bbaee](https://github.com/okou-ai/okou/commit/f4bbaee7ba5b81a95059ce31bd0e1915ee860da9))
* **guest-contracts:** derive exec log severity from the agent-domain kill ([#36077](https://github.com/okou-ai/okou/issues/36077)) ([0360058](https://github.com/okou-ai/okou/commit/03600589df8d44b36e58b1aefb97235598840a6e)), closes [#36027](https://github.com/okou-ai/okou/issues/36027)
* update active github organization references ([#35650](https://github.com/okou-ai/okou/issues/35650)) ([1b873ca](https://github.com/okou-ai/okou/commit/1b873ca87c511fa30284eeb3232b92f4001a2d57))


### Refactoring

* **api:** remove durable pi inference and its sandbox switch ([#35599](https://github.com/okou-ai/okou/issues/35599)) ([4ad646b](https://github.com/okou-ai/okou/commit/4ad646b42ead7c91fab8861220f1fef818071d99))
* **runner:** extract provider coordination crate ([#36148](https://github.com/okou-ai/okou/issues/36148)) ([789a24f](https://github.com/okou-ai/okou/commit/789a24f6632566071af38533d4df58a0ef0c0c75))


### Performance Improvements

* **pi:** measure pi sandbox startup at parity with codex ([#35896](https://github.com/okou-ai/okou/issues/35896)) ([72604f0](https://github.com/okou-ai/okou/commit/72604f0ca4ea5785ce9be83f57c76a9a493df38f))
</details>

<details><summary>guest-storage-apply: 0.24.17</summary>

## [0.24.17](https://github.com/okou-ai/okou/compare/guest-storage-apply-v0.24.16...guest-storage-apply-v0.24.17) (2026-09-23)


### Bug Fixes

* **runner:** use decoded files in mixed archive groups ([#36247](https://github.com/okou-ai/okou/issues/36247)) ([7a9f87e](https://github.com/okou-ai/okou/commit/7a9f87e4905e2127969b8822c93e043be7fc2389))


### Performance Improvements

* **runner:** deliver decoded artifact files ([#36134](https://github.com/okou-ai/okou/issues/36134)) ([7ab2f81](https://github.com/okou-ai/okou/commit/7ab2f81853148c9be700e6daf2f25ec48324347e))
* **runner:** observe storage history overlap eligibility ([#35567](https://github.com/okou-ai/okou/issues/35567)) ([14a43e3](https://github.com/okou-ai/okou/commit/14a43e3202e1f74771be2e88821982983c200e9f))
* **runner:** overlap workspace history restore ([#35766](https://github.com/okou-ai/okou/issues/35766)) ([022ac68](https://github.com/okou-ai/okou/commit/022ac688820391243d31429bbaeda7d423eacac5))
</details>

<details><summary>runner-rs: 0.214.0</summary>

## [0.214.0](https://github.com/okou-ai/okou/compare/runner-rs-v0.213.2...runner-rs-v0.214.0) (2026-09-23)


### Features

* **api-contracts:** add gpt-6-luna run model ([#36164](https://github.com/okou-ai/okou/issues/36164)) ([c86fa91](https://github.com/okou-ai/okou/commit/c86fa91e4a13f42951502f19208277d9b71241e9))
* **cli:** query current run usage ([#35541](https://github.com/okou-ai/okou/issues/35541)) ([2be9088](https://github.com/okou-ai/okou/commit/2be908850eb21a47c31b930b5f19e7991daf8ff9))
* **connectors:** support aws-aware firewall rules ([#35742](https://github.com/okou-ai/okou/issues/35742)) ([05a07b9](https://github.com/okou-ai/okou/commit/05a07b98e0ef6bfc04a29cb2e2603df19ea5a8c1))
* expose ssh-backed vnc access ([#36116](https://github.com/okou-ai/okou/issues/36116)) ([05910d3](https://github.com/okou-ai/okou/commit/05910d386aebd37b12637adf5dea4a935c9a0198))
* **model-provider:** add feature-gated okou 1.0 models ([#35884](https://github.com/okou-ai/okou/issues/35884)) ([b996e92](https://github.com/okou-ai/okou/commit/b996e92cc31d3038fd0a403decf66736597e5ce0))
* **models:** add Claude Opus 5.5 ([#36168](https://github.com/okou-ai/okou/issues/36168)) ([e0fc624](https://github.com/okou-ai/okou/commit/e0fc62414d039c9e0dfda36145c2e62edfcf79a2))
* **pi:** key installed-CLI parity on a session-construction digest ([#36142](https://github.com/okou-ai/okou/issues/36142)) ([322efb6](https://github.com/okou-ai/okou/commit/322efb6d72508e15b90dc788100a776da1485751)), closes [#35967](https://github.com/okou-ai/okou/issues/35967)
* **rfb-client:** add policy-driven x509 authentication ([#35626](https://github.com/okou-ai/okou/issues/35626)) ([dd6da89](https://github.com/okou-ai/okou/commit/dd6da89572b08a00884d2851f15b9c7efd7db3f3))
* **runner:** accept terminal absence for built-in connectors ([#35542](https://github.com/okou-ai/okou/issues/35542)) ([16f2397](https://github.com/okou-ai/okou/commit/16f239728d078d42f6847b8057ef5c1cbd6e9ee0))
* **runner:** add run-owned ssh direct-tcpip streams ([#35899](https://github.com/okou-ai/okou/issues/35899)) ([bd1327e](https://github.com/okou-ai/okou/commit/bd1327e146ed93210cedce07e8900be2929f4afe))
* **runner:** include uv in sandbox rootfs ([#35782](https://github.com/okou-ai/okou/issues/35782)) ([1b45b3a](https://github.com/okou-ai/okou/commit/1b45b3a9175554c217391bea47cfab5edb9d4050))
* **runner:** install the versioned okou cli into the rootfs and gate its use by runtime version ([#36000](https://github.com/okou-ai/okou/issues/36000)) ([8d8f3a3](https://github.com/okou-ai/okou/commit/8d8f3a3e14d23f7471e0773bd9acb988f59217af))
* **vnc:** execute sessions through ssh transport ([#36004](https://github.com/okou-ai/okou/issues/36004)) ([1c4fc60](https://github.com/okou-ai/okou/commit/1c4fc606c58ee8b9e721ea776a1b3f122ee5b6ed))
* **vnc:** execute x509plain runner sessions ([#35751](https://github.com/okou-ai/okou/issues/35751)) ([2bd8dde](https://github.com/okou-ai/okou/commit/2bd8dde2379f54ac53a7af5ca53a678af439f304))


### Bug Fixes

* classify codex access-program rejections ([#35512](https://github.com/okou-ai/okou/issues/35512)) ([fc5e3a2](https://github.com/okou-ai/okou/commit/fc5e3a213970835ae0a5108f4943c0f34d1cadd2))
* **guest-contracts:** derive exec log severity from the agent-domain kill ([#36077](https://github.com/okou-ai/okou/issues/36077)) ([0360058](https://github.com/okou-ai/okou/commit/03600589df8d44b36e58b1aefb97235598840a6e)), closes [#36027](https://github.com/okou-ai/okou/issues/36027)
* **python:** decode concatenated zstd capture frames ([#36114](https://github.com/okou-ai/okou/issues/36114)) ([6ad38eb](https://github.com/okou-ai/okou/commit/6ad38ebaa2fa21177bf5aa33139c99ccd3c37d13))
* **python:** preserve auth base abort socket ownership ([#35521](https://github.com/okou-ai/okou/issues/35521)) ([db151cf](https://github.com/okou-ai/okou/commit/db151cf53b9b9df4f8b3bbafd6b7d4e24698675c))
* refresh API, Platform, and Runner release markers ([#35602](https://github.com/okou-ai/okou/issues/35602)) ([15183dc](https://github.com/okou-ai/okou/commit/15183dc84e3200e177490012ab3a11a90ffb380a))
* refresh api, platform, and runner release markers ([#35702](https://github.com/okou-ai/okou/issues/35702)) ([8f8e88a](https://github.com/okou-ai/okou/commit/8f8e88a73d84e449e46befc07d74f8ee340a73f7))
* **runner:** accept aws-aware firewall catalog rules ([#36026](https://github.com/okou-ai/okou/issues/36026)) ([e9fb108](https://github.com/okou-ai/okou/commit/e9fb108269c25722d84fb7b2ddca71ee940a94c2))
* **runner:** aggregate network-log transport failures ([#35758](https://github.com/okou-ai/okou/issues/35758)) ([9ef05a4](https://github.com/okou-ai/okou/commit/9ef05a4a1a397980590fc74e6e5188cc5f3fcfca))
* **runner:** bound identity stream decode chunks ([#36113](https://github.com/okou-ai/okou/issues/36113)) ([4e4f82f](https://github.com/okou-ai/okou/commit/4e4f82f4618cd3cb6829fd95778c07cc1e2383ed))
* **runner:** classify heartbeat connection resets ([#35511](https://github.com/okou-ai/okou/issues/35511)) ([59bb98c](https://github.com/okou-ai/okou/commit/59bb98c6c7192f5cab127c736d82750eef21cc1a))
* **runner:** make cancellation reconciliation failures observable ([#35754](https://github.com/okou-ai/okou/issues/35754)) ([e83b568](https://github.com/okou-ai/okou/commit/e83b568a0dea7e944ad14a628e766a9a04dee1e1))
* **runner:** persist built-in omission-only updates ([#35635](https://github.com/okou-ai/okou/issues/35635)) ([c141d99](https://github.com/okou-ai/okou/commit/c141d99ef53c1beb6e0b2414e25c89f5530457e4))
* **runner:** release catalog ownership on overflow ([#35514](https://github.com/okou-ai/okou/issues/35514)) ([9c1d985](https://github.com/okou-ai/okou/commit/9c1d9857f134b7e99005b479b721acbf137187da))
* **runner:** use fresh memory evidence for balloon grace ([#35509](https://github.com/okou-ai/okou/issues/35509)) ([961efe6](https://github.com/okou-ai/okou/commit/961efe6ab002c6414844e65309e2df75fce4dba7))
* update active github organization references ([#35650](https://github.com/okou-ai/okou/issues/35650)) ([1b873ca](https://github.com/okou-ai/okou/commit/1b873ca87c511fa30284eeb3232b92f4001a2d57))


### Refactoring

* **api:** remove durable pi inference and its sandbox switch ([#35599](https://github.com/okou-ai/okou/issues/35599)) ([4ad646b](https://github.com/okou-ai/okou/commit/4ad646b42ead7c91fab8861220f1fef818071d99))
* remove run-usage feature switch ([#36138](https://github.com/okou-ai/okou/issues/36138)) ([9355b61](https://github.com/okou-ai/okou/commit/9355b61c1e61a1b747da8e69391f77217e22f19f))
* **runner:** accept inline builtin mcp firewalls ([#35630](https://github.com/okou-ai/okou/issues/35630)) ([05e69ca](https://github.com/okou-ai/okou/commit/05e69ca65119b7aba6d79af0ab58ed118b0953d8))
* **runner:** extract network domain crate ([#36253](https://github.com/okou-ai/okou/issues/36253)) ([af59b4b](https://github.com/okou-ai/okou/commit/af59b4bb863dbfa5760bcbb17c7f81894a4edbc4))
* **runner:** extract provider coordination crate ([#36148](https://github.com/okou-ai/okou/issues/36148)) ([789a24f](https://github.com/okou-ai/okou/commit/789a24f6632566071af38533d4df58a0ef0c0c75))
* **runner:** extract runner-storage domain crate ([#36190](https://github.com/okou-ai/okou/issues/36190)) ([25fdd3f](https://github.com/okou-ai/okou/commit/25fdd3f7c8116b3687074d1c0d4f02dbb9b973f3))
* **runner:** extract shared runner types ([#35988](https://github.com/okou-ai/okou/issues/35988)) ([91eeb09](https://github.com/okou-ai/okou/commit/91eeb0904bbbbcebcd05b0b31c8b42f71d12f5e0))
* **runner:** extract the runner-host domain crate ([#36075](https://github.com/okou-ai/okou/issues/36075)) ([2f27ce3](https://github.com/okou-ai/okou/commit/2f27ce3a29bfbd91118eb012ab1f0504a132ba38))


### Performance Improvements

* **ci:** virtualize long ssh coverage wait ([#35765](https://github.com/okou-ai/okou/issues/35765)) ([ea2d49c](https://github.com/okou-ai/okou/commit/ea2d49cae145a34b95d3b6cfc1fde7ad7155cf14))
* **runner:** attribute blank pool selection outcomes ([#35895](https://github.com/okou-ai/okou/issues/35895)) ([eb82d74](https://github.com/okou-ai/okou/commit/eb82d74e69e3a614d18de300a189618575d951a4))
* **runner:** attribute guest storage apply batches ([#36273](https://github.com/okou-ai/okou/issues/36273)) ([dc10f3f](https://github.com/okou-ai/okou/commit/dc10f3f84aa072e3d032f3b1d8f2a3364055fc2f))
* **runner:** bound sse parse diagnostics ([#35517](https://github.com/okou-ai/okou/issues/35517)) ([f2146ee](https://github.com/okou-ai/okou/commit/f2146eeacd252a357fc62ccf5c80b2fe0b715590))
* **runner:** deliver decoded artifact files ([#36134](https://github.com/okou-ai/okou/issues/36134)) ([7ab2f81](https://github.com/okou-ai/okou/commit/7ab2f81853148c9be700e6daf2f25ec48324347e))
* **runner:** observe host archive connection attempts ([#35568](https://github.com/okou-ai/okou/issues/35568)) ([81baee7](https://github.com/okou-ai/okou/commit/81baee7dcbcf41ff6422c9081479b3c9fba9e21b))
* **runner:** observe storage history overlap eligibility ([#35567](https://github.com/okou-ai/okou/issues/35567)) ([14a43e3](https://github.com/okou-ai/okou/commit/14a43e3202e1f74771be2e88821982983c200e9f))
* **runner:** overlap workspace history restore ([#35766](https://github.com/okou-ai/okou/issues/35766)) ([022ac68](https://github.com/okou-ai/okou/commit/022ac688820391243d31429bbaeda7d423eacac5))
</details>

<details><summary>runner-network: 0.1.2</summary>

## [0.1.2](https://github.com/okou-ai/okou/compare/runner-network-v0.1.1...runner-network-v0.1.2) (2026-09-23)


### Refactoring

* **runner:** extract network domain crate ([#36253](https://github.com/okou-ai/okou/issues/36253)) ([af59b4b](https://github.com/okou-ai/okou/commit/af59b4bb863dbfa5760bcbb17c7f81894a4edbc4))
</details>

<details><summary>runner-provider: 0.4.0</summary>

## [0.4.0](https://github.com/okou-ai/okou/compare/runner-provider-v0.3.0...runner-provider-v0.4.0) (2026-09-23)


### Features

* **models:** add Claude Opus 5.5 ([#36168](https://github.com/okou-ai/okou/issues/36168)) ([e0fc624](https://github.com/okou-ai/okou/commit/e0fc62414d039c9e0dfda36145c2e62edfcf79a2))
* **pi:** enable session-construction digest parity ([#36201](https://github.com/okou-ai/okou/issues/36201)) ([00b1434](https://github.com/okou-ai/okou/commit/00b14343e69073fdc87f42d378deab55e8c232ba)), closes [#35967](https://github.com/okou-ai/okou/issues/35967)


### Refactoring

* **runner:** extract provider coordination crate ([#36148](https://github.com/okou-ai/okou/issues/36148)) ([789a24f](https://github.com/okou-ai/okou/commit/789a24f6632566071af38533d4df58a0ef0c0c75))
</details>

<details><summary>runner-storage: 0.1.3</summary>

## [0.1.3](https://github.com/okou-ai/okou/compare/runner-storage-v0.1.2...runner-storage-v0.1.3) (2026-09-23)


### Bug Fixes

* **runner:** preserve absent storage archive sources ([#36279](https://github.com/okou-ai/okou/issues/36279)) ([fecee76](https://github.com/okou-ai/okou/commit/fecee764db9d950b9566c8543ab751ae4a1e9017))
* **runner:** use decoded files in mixed archive groups ([#36247](https://github.com/okou-ai/okou/issues/36247)) ([7a9f87e](https://github.com/okou-ai/okou/commit/7a9f87e4905e2127969b8822c93e043be7fc2389))


### Documentation

* **runner-storage:** clarify deferred cache work lifecycle ([#36225](https://github.com/okou-ai/okou/issues/36225)) ([0a3b00a](https://github.com/okou-ai/okou/commit/0a3b00a5619fcb3c259af3320cba9e1f5b203b12))


### Refactoring

* **runner:** extract runner-storage domain crate ([#36190](https://github.com/okou-ai/okou/issues/36190)) ([25fdd3f](https://github.com/okou-ai/okou/commit/25fdd3f7c8116b3687074d1c0d4f02dbb9b973f3))
</details>

---
This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).