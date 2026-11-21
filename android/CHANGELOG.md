# Changelog

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
