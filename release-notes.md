:robot: I have created a release *beep* *boop*
---


<details><summary>api-contracts: 2.91.0</summary>

## [2.91.0](https://github.com/okou-ai/okou/compare/api-contracts-v2.90.2...api-contracts-v2.91.0) (2026-11-19)


### Features

* add for you source preferences and unread indicators ([#47771](https://github.com/okou-ai/okou/issues/47771)) ([5d3bca3](https://github.com/okou-ai/okou/commit/5d3bca33002b020ebed8d8a0d379777fb1c542b8))
* add independent project sorting ([#48352](https://github.com/okou-ai/okou/issues/48352)) ([5ace277](https://github.com/okou-ai/okou/commit/5ace277384c9a3e0da65abdbf87a89fea3311d85))
* add isolated official lark bot connections ([#48638](https://github.com/okou-ai/okou/issues/48638)) ([d349625](https://github.com/okou-ai/okou/commit/d349625708f8b61b15be9abf1a7c766dd4c1bc80))
* add ultrafast for codex subscriptions ([#48736](https://github.com/okou-ai/okou/issues/48736)) ([c352dad](https://github.com/okou-ai/okou/commit/c352dadadbbec10cea8cf77adccfac8462ecdb94))
* **android:** add chat rename, pin and scoped ordering ([#48851](https://github.com/okou-ai/okou/issues/48851)) ([b2d3b9a](https://github.com/okou-ai/okou/commit/b2d3b9a592ed76451a3c5114eba21f61d55985e4))
* **android:** add chat row mute and archive actions ([#48768](https://github.com/okou-ai/okou/issues/48768)) ([f74ed61](https://github.com/okou-ai/okou/commit/f74ed61ce0b1c050375aa96e01b47a8ff7bb732d))
* **android:** add chat row read actions ([#48753](https://github.com/okou-ai/okou/issues/48753)) ([feff7f3](https://github.com/okou-ai/okou/commit/feff7f3e6cca99b946b91f974c654e2104703050))
* **android:** align conversation reads and history warming with web ([#47910](https://github.com/okou-ai/okou/issues/47910)) ([8e92fed](https://github.com/okou-ai/okou/commit/8e92fedbb8a32f2360f6093247c469398758b026))
* **android:** recover current assistant failures ([#48167](https://github.com/okou-ai/okou/issues/48167)) ([d94db12](https://github.com/okou-ai/okou/commit/d94db123ec646331a1171085c281b2fa8d8b650b))
* **android:** stream active-run output with web data semantics ([#47766](https://github.com/okou-ai/okou/issues/47766)) ([7ab9764](https://github.com/okou-ai/okou/commit/7ab9764c662ec7ea5d8d261cdc714334aa4973d4))
* **android:** sync composer drafts with web ([#48409](https://github.com/okou-ai/okou/issues/48409)) ([9c4533e](https://github.com/okou-ai/okou/commit/9c4533e1759c94add85742779eb169793038a1a9))
* **api:** add dedicated reward receipt lookup ([#47848](https://github.com/okou-ai/okou/issues/47848)) ([fcc0ab8](https://github.com/okou-ai/okou/commit/fcc0ab87f7cdde80581b8b496f1689585f5c0ac9))
* **api:** add read-only reward history export ([#47764](https://github.com/okou-ai/okou/issues/47764)) ([3a0c748](https://github.com/okou-ai/okou/commit/3a0c748549d997794f364d03486610476f60881e))
* **api:** durably refresh confirmed marketing rewards ([#48139](https://github.com/okou-ai/okou/issues/48139)) ([6d68129](https://github.com/okou-ai/okou/commit/6d68129031a759c9a2cc232d4c365021e6b820be))
* **api:** durably refresh marketing reward progress ([#48264](https://github.com/okou-ai/okou/issues/48264)) ([f0eddb0](https://github.com/okou-ai/okou/commit/f0eddb06ec314725bc198c2bbbde7c5bb31a00c2))
* **api:** expose read-only invitation source facts ([#48225](https://github.com/okou-ai/okou/issues/48225)) ([2ef7440](https://github.com/okou-ai/okou/commit/2ef744094b871e889eb74c4d50c5ee475ef6baab))
* **api:** expose read-only workflow source observations ([#48211](https://github.com/okou-ai/okou/issues/48211)) ([165957f](https://github.com/okou-ai/okou/commit/165957f2b71fb10144cd8a042086528a92262b91))
* **api:** expose retained invitation claim source facts ([#48242](https://github.com/okou-ai/okou/issues/48242)) ([489c76e](https://github.com/okou-ai/okou/commit/489c76e8081331c365025ff3fceabf0aafbe1e27))
* **api:** gate feature guide items by optional feature switches ([#48056](https://github.com/okou-ai/okou/issues/48056)) ([289c793](https://github.com/okou-ai/okou/commit/289c79330d548748176ff23e803a036175ea435e))
* **api:** prepare controlled marketing reward routing ([#48235](https://github.com/okou-ai/okou/issues/48235)) ([850096b](https://github.com/okou-ai/okou/commit/850096b648aa3d77b198e18cfb69baa6cdf3dff9))
* **api:** retain source-proven daily check-in requests ([#48157](https://github.com/okou-ai/okou/issues/48157)) ([2685448](https://github.com/okou-ai/okou/commit/26854487b208b5123e9c9e03f84d4154f12c6475))
* **api:** settle source-proven marketing rewards ([#48079](https://github.com/okou-ai/okou/issues/48079)) ([95e2816](https://github.com/okou-ai/okou/commit/95e2816dd55eef02f025b55699e01bc0b1f16f8f))
* **api:** target feature guide editions by organization and member ([#48067](https://github.com/okou-ai/okou/issues/48067)) ([14b58ff](https://github.com/okou-ai/okou/commit/14b58ff87fef1f59b45d9278835f0dc0768d8583))
* **app:** enable feature guides with the my okou redesign ([#47733](https://github.com/okou-ai/okou/issues/47733)) ([0e9387d](https://github.com/okou-ai/okou/commit/0e9387d6ef081ec765f9c1392e1158ac95bc6da0))
* drive phone use through realtime notifications ([#48253](https://github.com/okou-ai/okou/issues/48253)) ([7a71cfe](https://github.com/okou-ai/okou/commit/7a71cfe71674871cae66ddee7d0d12cd0a7f2760))
* **ios:** refresh home screen widgets when chats change elsewhere ([#47010](https://github.com/okou-ai/okou/issues/47010)) ([a3459ce](https://github.com/okou-ai/okou/commit/a3459ce8b0a9e90434e1b2ae3d1791108e7eebd1))
* **onboarding:** persist drafts across devices ([#48816](https://github.com/okou-ai/okou/issues/48816)) ([368d3dd](https://github.com/okou-ai/okou/commit/368d3dd31744833319c9cffce3c17191a5c327d7))
* replace the notification bell with platform feed events ([#47711](https://github.com/okou-ai/okou/issues/47711)) ([b5aac15](https://github.com/okou-ai/okou/commit/b5aac15af841802f580b268f27cfce7539cb9269))
* route presentation templates by output format ([#47842](https://github.com/okou-ai/okou/issues/47842)) ([b342805](https://github.com/okou-ai/okou/commit/b342805293be679b34781d7ff4811669feccbb77))
* **telemetry:** aggregate run phases from axiom logs ([#47841](https://github.com/okou-ai/okou/issues/47841)) ([1d55067](https://github.com/okou-ai/okou/commit/1d55067a6cb379e06e6f0f5bbab85113c2daa85e))


### Bug Fixes

* align phone availability with usable native control ([#48135](https://github.com/okou-ai/okou/issues/48135)) ([1744a58](https://github.com/okou-ai/okou/commit/1744a58d3f33923f71a34d07e85a87eeb86d03c1))
* **api:** classify malformed outlook draft ids ([#48794](https://github.com/okou-ai/okou/issues/48794)) ([4cfd459](https://github.com/okou-ai/okou/commit/4cfd45983a517e8975e1e5021f7eeb7a37ad41b7))
* **api:** deliver canonical slack file bytes on the server ([#48047](https://github.com/okou-ai/okou/issues/48047)) ([b94750b](https://github.com/okou-ai/okou/commit/b94750b39f87264646854948b0cfac50f1585a14))
* **api:** record artifact success separately from run completion ([#48245](https://github.com/okou-ai/okou/issues/48245)) ([d9940ef](https://github.com/okou-ai/okou/commit/d9940efa398db348d91044a76fda715abc5f1dce))
* **app:** clarify paused automation feed cards ([#48887](https://github.com/okou-ai/okou/issues/48887)) ([4b72b66](https://github.com/okou-ai/okou/commit/4b72b660f8279424182640658aa21773cc49ccd4))
* automatically continue integration chats after model recovery ([#48152](https://github.com/okou-ai/okou/issues/48152)) ([70b6624](https://github.com/okou-ai/okou/commit/70b6624fcc16a0197b0dceb88fc587ac694c1c86))
* classify codex terminal failures and agent oom ([#48521](https://github.com/okou-ai/okou/issues/48521)) ([00075f2](https://github.com/okou-ai/okou/commit/00075f2f8a0d64e6aa8c3cecc8dc7bdc6cccde5f))
* generate semantic filenames for message pdf downloads ([#48262](https://github.com/okou-ai/okou/issues/48262)) ([d311fd8](https://github.com/okou-ai/okou/commit/d311fd8ca02dc9b2c555e52c2e8112a0fbab002b))
* **ios:** restore app-driven widget updates ([#48918](https://github.com/okou-ai/okou/issues/48918)) ([d850651](https://github.com/okou-ai/okou/commit/d8506517c032a16c88be5a9b77b46b0741060dfe))
* make system updates configurable ([#47882](https://github.com/okou-ai/okou/issues/47882)) ([f1bf918](https://github.com/okou-ai/okou/commit/f1bf918e9c3d2033a956b51a8bcb3ee0ad77cb3c))
* **native:** cover every public run failure reason ([#48612](https://github.com/okou-ai/okou/issues/48612)) ([c1416bf](https://github.com/okou-ai/okou/commit/c1416bf15801f329cb95d836b1b66a722fb6a543))
* **runner:** allow additional dispatch envelope fields ([#48869](https://github.com/okou-ai/okou/issues/48869)) ([debde7f](https://github.com/okou-ai/okou/commit/debde7f0cdde00c191deb4b9a512fc8f0e3c397f))


### Documentation

* align runner descriptions with direct execution ([#48085](https://github.com/okou-ai/okou/issues/48085)) ([f3707aa](https://github.com/okou-ai/okou/commit/f3707aa037153905e98bfaa81d62db0b7feaa934))


### Refactoring

* activate structured run failures with retained storage ([#47844](https://github.com/okou-ai/okou/issues/47844)) ([fdb91d8](https://github.com/okou-ai/okou/commit/fdb91d8fea44a0be90036ebd9d6c25210eb5baa2))
* **api-contracts:** define complete execution preparation directly ([#48267](https://github.com/okou-ai/okou/issues/48267)) ([f390fa2](https://github.com/okou-ai/okou/commit/f390fa2bfa955081fc8a910812b2160340b10f86))
* **api:** consolidate execution admission facts ([#47899](https://github.com/okou-ai/okou/issues/47899)) ([270a932](https://github.com/okou-ai/okou/commit/270a932913e030a8d3628889d04d7a11ff213761))
* **api:** publish invitation facts and retire marketing read bridges ([#48630](https://github.com/okou-ai/okou/issues/48630)) ([fd53dd1](https://github.com/okou-ai/okou/commit/fd53dd1e7c58e7fdb39bb6f2d97b70ce8c53e162))
* **api:** remove legacy project sort event transforms ([#48850](https://github.com/okou-ai/okou/issues/48850)) ([8cef6d3](https://github.com/okou-ai/okou/commit/8cef6d31698d1c28d26aa47f769b9f52ea2e5da9))
* **api:** require complete run preparation facts ([#47955](https://github.com/okou-ai/okou/issues/47955)) ([b916d05](https://github.com/okou-ai/okou/commit/b916d05c76c4412d29b3dce3d9eb702dab89a29b))
* **api:** retire legacy reward campaign orchestration ([#48939](https://github.com/okou-ai/okou/issues/48939)) ([d1739be](https://github.com/okou-ai/okou/commit/d1739bed31dcde34fead64d82e54489fda10549f))
* **api:** retire marketing reward read callbacks ([#48553](https://github.com/okou-ai/okou/issues/48553)) ([0e0b6a9](https://github.com/okou-ai/okou/commit/0e0b6a982616cf1641df58b3412c3dc7b87331e2))
* **api:** unify marketing reward notifications ([#48668](https://github.com/okou-ai/okou/issues/48668)) ([20e7c48](https://github.com/okou-ai/okou/commit/20e7c4853f65e4cb6d6a841876a713e3a8870dfb))
* **api:** use three-point axiom artifact timing ([#48854](https://github.com/okou-ai/okou/issues/48854)) ([d930e21](https://github.com/okou-ai/okou/commit/d930e21f8d3d93278613fcef287ae7b58febdf72))
* define client run and activity read models ([#48165](https://github.com/okou-ai/okou/issues/48165)) ([9be7072](https://github.com/okou-ai/okou/commit/9be7072fcdb23c781cc0d68a93dc88fc7b86f8da))
* **firewall:** retire legacy resolver and envelope compatibility ([#48739](https://github.com/okou-ai/okou/issues/48739)) ([7dcd7ca](https://github.com/okou-ai/okou/commit/7dcd7cac45f2b26e253703533fc7f1097609c0f6))
* **firewall:** separate host resolver authority from guest identity ([#48459](https://github.com/okou-ai/okou/issues/48459)) ([949de84](https://github.com/okou-ai/okou/commit/949de843f47dd8152058c7d7e2ca8a418305f0fc))
* **memory:** retire legacy memory compatibility runtime ([#48363](https://github.com/okou-ai/okou/issues/48363)) ([7a30ea0](https://github.com/okou-ai/okou/commit/7a30ea0ee45da9dabdda7167d9c60e5b91496b7e))
* prepare structured run failure clients ([#48006](https://github.com/okou-ai/okou/issues/48006)) ([4839506](https://github.com/okou-ai/okou/commit/483950651b69db523f06a72f7cf2490c913ff8ab))
* prepare structured run failures and recovery ([#47749](https://github.com/okou-ai/okou/issues/47749)) ([fca7335](https://github.com/okou-ai/okou/commit/fca73354c6b5b0aa4f122e78947565b274323991))
* **runner:** remove unused execution overrides ([#48162](https://github.com/okou-ai/okou/issues/48162)) ([1f0afc6](https://github.com/okou-ai/okou/commit/1f0afc6aa21f773b54c1d64b540280698e58f699))
* **wallet:** remove saved-card expiry compatibility ([#48003](https://github.com/okou-ai/okou/issues/48003)) ([2fb6aae](https://github.com/okou-ai/okou/commit/2fb6aaeb8bfb812d596e578c5a4eabd718dedf24))


### Performance Improvements

* **api:** remove execution-startup secret encryption ([#48677](https://github.com/okou-ai/okou/issues/48677)) ([ffad11e](https://github.com/okou-ai/okou/commit/ffad11eaaca4de2da2218225794d16f39c2b7796))
* **api:** retire debug-only run fields from application sql ([#48082](https://github.com/okou-ai/okou/issues/48082)) ([a40cf00](https://github.com/okou-ai/okou/commit/a40cf00d2f9e5c63fcb2dfa6ea68485b13be4f13))
* **runner:** attribute archive staging writes ([#48338](https://github.com/okou-ai/okou/issues/48338)) ([1aeffbc](https://github.com/okou-ai/okou/commit/1aeffbc8c757415acb407157dba177305ed1b210))
</details>

<details><summary>app: 0.1150.0</summary>

## [0.1150.0](https://github.com/okou-ai/okou/compare/app-v0.1149.3...app-v0.1150.0) (2026-11-19)


### Features

* add for you source preferences and unread indicators ([#47771](https://github.com/okou-ai/okou/issues/47771)) ([5d3bca3](https://github.com/okou-ai/okou/commit/5d3bca33002b020ebed8d8a0d379777fb1c542b8))
* add independent project sorting ([#48352](https://github.com/okou-ai/okou/issues/48352)) ([5ace277](https://github.com/okou-ai/okou/commit/5ace277384c9a3e0da65abdbf87a89fea3311d85))
* add isolated official lark bot connections ([#48638](https://github.com/okou-ai/okou/issues/48638)) ([d349625](https://github.com/okou-ai/okou/commit/d349625708f8b61b15be9abf1a7c766dd4c1bc80))
* add markdown-first document exports ([#48734](https://github.com/okou-ai/okou/issues/48734)) ([2a6cc5d](https://github.com/okou-ai/okou/commit/2a6cc5d7ec9690cbdde76c8b31593fd10449390f))
* add ultrafast for codex subscriptions ([#48736](https://github.com/okou-ai/okou/issues/48736)) ([c352dad](https://github.com/okou-ai/okou/commit/c352dadadbbec10cea8cf77adccfac8462ecdb94))
* **android:** stream active-run output with web data semantics ([#47766](https://github.com/okou-ai/okou/issues/47766)) ([7ab9764](https://github.com/okou-ai/okou/commit/7ab9764c662ec7ea5d8d261cdc714334aa4973d4))
* **api:** prepare controlled marketing reward routing ([#48235](https://github.com/okou-ai/okou/issues/48235)) ([850096b](https://github.com/okou-ai/okou/commit/850096b648aa3d77b198e18cfb69baa6cdf3dff9))
* **app:** enable feature guides with the my okou redesign ([#47733](https://github.com/okou-ai/okou/issues/47733)) ([0e9387d](https://github.com/okou-ai/okou/commit/0e9387d6ef081ec765f9c1392e1158ac95bc6da0))
* **app:** preselect multiple output formats from onboarding links ([#48433](https://github.com/okou-ai/okou/issues/48433)) ([293ff03](https://github.com/okou-ai/okou/commit/293ff03824b50f184a72b666db25a44725229eca))
* **app:** release share audience descriptions and website share rows ([#48544](https://github.com/okou-ai/okou/issues/48544)) ([60461e9](https://github.com/okou-ai/okou/commit/60461e9da15d190d7e34e633ce0e2a61d195026f))
* **core:** enable home capabilities for everyone ([#48000](https://github.com/okou-ai/okou/issues/48000)) ([5df5fc2](https://github.com/okou-ai/okou/commit/5df5fc264b933fdb4aa8210740221f921e6232d7))
* **core:** enable presentation output format for staff ([#48524](https://github.com/okou-ai/okou/issues/48524)) ([af156ca](https://github.com/okou-ai/okou/commit/af156ca8c7dea3483e14ae37a058890dd57581d0))
* drive phone use through realtime notifications ([#48253](https://github.com/okou-ai/okou/issues/48253)) ([7a71cfe](https://github.com/okou-ai/okou/commit/7a71cfe71674871cae66ddee7d0d12cd0a7f2760))
* **my-okou:** preserve initialized members and enable new-member defaults ([#47051](https://github.com/okou-ai/okou/issues/47051)) ([cf1c9e5](https://github.com/okou-ai/okou/commit/cf1c9e53c2076c58bd6bb85d51dedbd62c30b6d1))
* **onboarding:** persist drafts across devices ([#48816](https://github.com/okou-ai/okou/issues/48816)) ([368d3dd](https://github.com/okou-ai/okou/commit/368d3dd31744833319c9cffce3c17191a5c327d7))
* **platform:** open capability cards from anywhere on the card ([#47831](https://github.com/okou-ai/okou/issues/47831)) ([38cf58d](https://github.com/okou-ai/okou/commit/38cf58da6c3f786c1024837bdafa75da446ddf72))
* **platform:** step through new chat and for you with chat navigation keys ([#47906](https://github.com/okou-ai/okou/issues/47906)) ([ae36c94](https://github.com/okou-ai/okou/commit/ae36c9477fc58ba9fc2bf66b1388430e30b43ff3))
* replace the notification bell with platform feed events ([#47711](https://github.com/okou-ai/okou/issues/47711)) ([b5aac15](https://github.com/okou-ai/okou/commit/b5aac15af841802f580b268f27cfce7539cb9269))
* roll out free plan artifact paywall ([#48265](https://github.com/okou-ai/okou/issues/48265)) ([a8c6d85](https://github.com/okou-ai/okou/commit/a8c6d85e09610d0268362ec7db53d7ec8f031fb6))
* route presentation templates by output format ([#47842](https://github.com/okou-ai/okou/issues/47842)) ([b342805](https://github.com/okou-ai/okou/commit/b342805293be679b34781d7ff4811669feccbb77))
* support automatic onboarding from opt-in entry links ([#47757](https://github.com/okou-ai/okou/issues/47757)) ([56e28d4](https://github.com/okou-ai/okou/commit/56e28d455427e09e5511cf59868bfbc5a07626a6))


### Bug Fixes

* align phone availability with usable native control ([#48135](https://github.com/okou-ai/okou/issues/48135)) ([1744a58](https://github.com/okou-ai/okou/commit/1744a58d3f33923f71a34d07e85a87eeb86d03c1))
* **app:** add spacing between sidebar entry rows ([#47826](https://github.com/okou-ai/okou/issues/47826)) ([69ff7c2](https://github.com/okou-ai/okou/commit/69ff7c2df43b559b3b5a5a29d26b161d948b3cfb))
* **app:** align artifact close button hover shape ([#48846](https://github.com/okou-ai/okou/issues/48846)) ([e74770e](https://github.com/okou-ai/okou/commit/e74770e52f002811f5800f8de1c171021b22ed22))
* **app:** align billing surveys with the design system ([#48563](https://github.com/okou-ai/okou/issues/48563)) ([9cd4717](https://github.com/okou-ai/okou/commit/9cd4717e58d0bd85dc23d49744c87f8e8c7c697b))
* **app:** align connector controls and manage accounts in chat ([#48477](https://github.com/okou-ai/okou/issues/48477)) ([ba2b3f1](https://github.com/okou-ai/okou/commit/ba2b3f19374b2ffa88adfcd0fdc66f51e0ee4e27))
* **app:** align project editor dialog with form conventions ([#48617](https://github.com/okou-ai/okou/issues/48617)) ([ac630bd](https://github.com/okou-ai/okou/commit/ac630bd3c64469128e24ecda075258092b1bfb34))
* **app:** anchor variable-height dialogs to the top ([#48771](https://github.com/okou-ai/okou/issues/48771)) ([312092f](https://github.com/okou-ai/okou/commit/312092f8a3da89890bc8f7a8d6de0ca80b12ac01))
* **app:** authorize connectors directly for default Okou ([#48625](https://github.com/okou-ai/okou/issues/48625)) ([5d91b9b](https://github.com/okou-ai/okou/commit/5d91b9b7fc1c8b7f0218368d4acc1f5cf54f3c91))
* **app:** clarify local voice recording errors ([#48847](https://github.com/okou-ai/okou/issues/48847)) ([4e512b1](https://github.com/okou-ai/okou/commit/4e512b1d6177b678ab55a07afed0cab69161ce67))
* **app:** clarify paused automation feed cards ([#48887](https://github.com/okou-ai/okou/issues/48887)) ([4b72b66](https://github.com/okou-ai/okou/commit/4b72b660f8279424182640658aa21773cc49ccd4))
* **app:** defer feature guide requests until workspace switches load ([#48813](https://github.com/okou-ai/okou/issues/48813)) ([89e6b4c](https://github.com/okou-ai/okou/commit/89e6b4c0cb69754a6271de4d7968d974d34f2c09))
* **app:** distinguish artifact link icons by content type ([#48216](https://github.com/okou-ai/okou/issues/48216)) ([dd08f1c](https://github.com/okou-ai/okou/commit/dd08f1c6fe291959f56255c3980ad7cfb99abc3e))
* **app:** hide artifact preview actions without a loading skeleton ([#48540](https://github.com/okou-ai/okou/issues/48540)) ([fd212b3](https://github.com/okou-ai/okou/commit/fd212b3c1fa1705e94e977779e09bf6fca470edd))
* **app:** highlight tools button while its panel is open ([#48002](https://github.com/okou-ai/okou/issues/48002)) ([f1896f1](https://github.com/okou-ai/okou/commit/f1896f1330d52a223f36c06f0204b0dea43db4db))
* **app:** keep artifact categories visible and group pptx presentations ([#48154](https://github.com/okou-ai/okou/issues/48154)) ([ff91500](https://github.com/okou-ai/okou/commit/ff915007aee99db02847333166b8f4bd2962b0f3))
* **app:** keep chart selections inline and clear accepted drafts ([#48045](https://github.com/okou-ai/okou/issues/48045)) ([70d643f](https://github.com/okou-ai/okou/commit/70d643faea0dd89455eb79c9bc3258c55c7ceaaf))
* **app:** keep home avatar entrance on its resting pixel grid ([#48810](https://github.com/okou-ai/okou/issues/48810)) ([9048d14](https://github.com/okou-ai/okou/commit/9048d14fda63282087c50084cf7ed32b7bb5be23))
* **app:** keep the capability greeting stable when opening cards ([#48138](https://github.com/okou-ai/okou/issues/48138)) ([3224f05](https://github.com/okou-ai/okou/commit/3224f0541759ef408cd7c0313fd2981002a05223))
* **app:** keep website sharing anchored during permission refresh ([#48665](https://github.com/okou-ai/okou/issues/48665)) ([e431efb](https://github.com/okou-ai/okou/commit/e431efb3c35614c29763437b9f9c7d5a009dc5c5))
* **app:** match project titles to thread overflow behavior ([#48220](https://github.com/okou-ai/okou/issues/48220)) ([96b2fc7](https://github.com/okou-ai/okou/commit/96b2fc71b22699ef6cd56c3229a762aa2887e19b))
* **app:** persist appearance choices to user preferences ([#48471](https://github.com/okou-ai/okou/issues/48471)) ([d50bf59](https://github.com/okou-ai/okou/commit/d50bf59769d26b5574115749bad08872b4c537d2))
* **app:** place artifact fullscreen after toolbar divider ([#48919](https://github.com/okou-ai/okou/issues/48919)) ([8a2029a](https://github.com/okou-ai/okou/commit/8a2029a4899dd8032955e0e0b102272bd94ad26f))
* **app:** preload for you feed with ably updates ([#47977](https://github.com/okou-ai/okou/issues/47977)) ([37e9143](https://github.com/okou-ai/okou/commit/37e9143ee0af84a84e3cf33463c4afdd12588015))
* **app:** redirect unavailable workflows with a toast ([#47825](https://github.com/okou-ai/okou/issues/47825)) ([41d40d8](https://github.com/okou-ai/okou/commit/41d40d822060b0c2813c986616727f3da22136cc))
* **app:** refine the for you completion transition ([#48145](https://github.com/okou-ai/okou/issues/48145)) ([dd61df6](https://github.com/okou-ai/okou/commit/dd61df6eca4dca0907cf5ecc180de5ebd65204be))
* **app:** refine visualization selection chips ([#47888](https://github.com/okou-ai/okou/issues/47888)) ([c64cef6](https://github.com/okou-ai/okou/commit/c64cef650edd4ad914514bb20f5a87c8431edff2))
* **app:** refresh pro and team plan capability copy ([#48328](https://github.com/okou-ai/okou/issues/48328)) ([0b43fc2](https://github.com/okou-ai/okou/commit/0b43fc29ddbcbbea8111f6cfacc518df4a1162fa))
* **app:** remove first-task upgrade panel from chat ([#48163](https://github.com/okou-ai/okou/issues/48163)) ([acd0576](https://github.com/okou-ai/okou/commit/acd0576df543974a76c650512f025e82a489cba1))
* **app:** remove shared chat deletion from artifact list ([#48159](https://github.com/okou-ai/okou/issues/48159)) ([ed49f47](https://github.com/okou-ai/okou/commit/ed49f47efed3c99f2354a1c91d74f43c7a645538))
* **app:** render heic photos in full image previews ([#48043](https://github.com/okou-ai/okou/issues/48043)) ([e42c4a4](https://github.com/okou-ai/okou/commit/e42c4a4d759cc86ef5c380721d9a099930c13988))
* **app:** replace empty state icons with brand scenes ([#48856](https://github.com/okou-ai/okou/issues/48856)) ([4d82887](https://github.com/okou-ai/okou/commit/4d82887c52325b7ab7876150807fd87e133043f1))
* **app:** resolve feature switches before mounting ([#48834](https://github.com/okou-ai/okou/issues/48834)) ([65206e8](https://github.com/okou-ai/okou/commit/65206e8e543d5ce23699fd8d2feea21e94e33413))
* **app:** restore bounded search tool controls in the composer ([#47860](https://github.com/okou-ai/okou/issues/47860)) ([d25a226](https://github.com/okou-ai/okou/commit/d25a2263333aa7e0a107dbcddb2062b6754ccba5))
* **app:** restore clerk automatic social button layout ([#48229](https://github.com/okou-ai/okou/issues/48229)) ([fd38783](https://github.com/okou-ai/okou/commit/fd38783a06afebe51cdaa6f29a16cdf6bd6da792))
* **app:** show checkout survey after restored billing closes ([#48228](https://github.com/okou-ai/okou/issues/48228)) ([f460a8b](https://github.com/okou-ai/okou/commit/f460a8bfd34c99173d96f31541d84fad34e0226c))
* **app:** simplify per-chat connector account controls ([#48208](https://github.com/okou-ai/okou/issues/48208)) ([acc7927](https://github.com/okou-ai/okou/commit/acc79270e25d7d1d93487bba6e56a905a9ad5ad6))
* **app:** smooth for you card pagination ([#47847](https://github.com/okou-ai/okou/issues/47847)) ([5044cf1](https://github.com/okou-ai/okou/commit/5044cf149c0fbe0866df11e12193f7e5b77cc75f))
* **app:** stabilize chat notice and media card geometry ([#48209](https://github.com/okou-ai/okou/issues/48209)) ([982d717](https://github.com/okou-ai/okou/commit/982d7172dd2d929e18ba40dd2fd906d3f5fec312))
* **app:** stabilize lark and feishu setup guide layout ([#48076](https://github.com/okou-ai/okou/issues/48076)) ([ce218a7](https://github.com/okou-ai/okou/commit/ce218a75fb5d45c1f0549a1874c2c4449cdb8c82))
* **artifacts:** reduce visibility update latency ([#48652](https://github.com/okou-ai/okou/issues/48652)) ([7f50485](https://github.com/okou-ai/okou/commit/7f50485e293fab339942a621798bd35ae9464bc2))
* **browser:** drain original input before viewer shutdown ([#48044](https://github.com/okou-ai/okou/issues/48044)) ([361c5d6](https://github.com/okou-ai/okou/commit/361c5d6aa4c71b15b004bd48a67bd3fb9ee66404))
* **chat:** dismiss archived reminders without marking chats read ([#48560](https://github.com/okou-ai/okou/issues/48560)) ([d3d69ae](https://github.com/okou-ai/okou/commit/d3d69ae2e7738d8b0b02450dde04399c91641a54))
* classify codex terminal failures and agent oom ([#48521](https://github.com/okou-ai/okou/issues/48521)) ([00075f2](https://github.com/okou-ai/okou/commit/00075f2f8a0d64e6aa8c3cecc8dc7bdc6cccde5f))
* generate semantic filenames for message pdf downloads ([#48262](https://github.com/okou-ai/okou/issues/48262)) ([d311fd8](https://github.com/okou-ai/okou/commit/d311fd8ca02dc9b2c555e52c2e8112a0fbab002b))
* make projects follow the single agent switch ([#48142](https://github.com/okou-ai/okou/issues/48142)) ([c8c181a](https://github.com/okou-ai/okou/commit/c8c181a5d258306463622a74129e8f770ba00fd7))
* make system updates configurable ([#47882](https://github.com/okou-ai/okou/issues/47882)) ([f1bf918](https://github.com/okou-ai/okou/commit/f1bf918e9c3d2033a956b51a8bcb3ee0ad77cb3c))
* open a new chat after deleting the current thread ([#48066](https://github.com/okou-ai/okou/issues/48066)) ([6466813](https://github.com/okou-ai/okou/commit/6466813cde734dc6e1c774da9214c787fb2bc30c))
* **platform:** capability tablet art without the dark rim ([#47832](https://github.com/okou-ai/okou/issues/47832)) ([4d6f945](https://github.com/okou-ai/okou/commit/4d6f94533f7626417500bd23c87916de96c74ce2))
* **platform:** close project deletion dialog before chat sync ([#47837](https://github.com/okou-ai/okou/issues/47837)) ([614ecba](https://github.com/okou-ai/okou/commit/614ecba0e56b94ac7c0af4e217eba69d28ebb4bb))
* **platform:** compact batch permission cards and stabilize loading ([#48213](https://github.com/okou-ai/okou/issues/48213)) ([ff507fb](https://github.com/okou-ai/okou/commit/ff507fbafe1be0db00cdf321109deab1e658e67a))
* **platform:** compact paused run notice cards ([#48645](https://github.com/okou-ai/okou/issues/48645)) ([22843ff](https://github.com/okou-ai/okou/commit/22843ffa1c4e5e50fe9d22c72c6bf3f162a2e283))
* **platform:** reveal preview actions together and keep downloads visible ([#48340](https://github.com/okou-ai/okou/issues/48340)) ([f8ae254](https://github.com/okou-ai/okou/commit/f8ae254298f87d0d514f3625ea6bf63ed59ecd22))
* **platform:** size the feature guide dialog to its content ([#48627](https://github.com/okou-ai/okou/issues/48627)) ([9696c89](https://github.com/okou-ai/okou/commit/9696c892614faaf6930a6f7b3e5f63d0e2fd8459))


### Refactoring

* activate structured run failures with retained storage ([#47844](https://github.com/okou-ai/okou/issues/47844)) ([fdb91d8](https://github.com/okou-ai/okou/commit/fdb91d8fea44a0be90036ebd9d6c25210eb5baa2))
* **app:** frame the chat list and workspace as one sheet ([#48445](https://github.com/okou-ai/okou/issues/48445)) ([49fa2ae](https://github.com/okou-ai/okou/commit/49fa2ae03ef16d6413ecf7609ae87be3d5c52825))
* **app:** refresh device lists when opening the connector menu ([#48849](https://github.com/okou-ai/okou/issues/48849)) ([81e93c7](https://github.com/okou-ai/okou/commit/81e93c76a220f826e3b340b5465fe1db06efde10))
* **app:** retire home capability and visualization summary switches ([#48151](https://github.com/okou-ai/okou/issues/48151)) ([b702121](https://github.com/okou-ai/okou/commit/b7021210adfafc0abd5a9f7c74a14f67d6e5b3b2))
* **app:** use a single async feature switch source ([#48862](https://github.com/okou-ai/okou/issues/48862)) ([60b272c](https://github.com/okou-ai/okou/commit/60b272ce6f1087359500c7d8d5ec75e7f3050b30))
* define client run and activity read models ([#48165](https://github.com/okou-ai/okou/issues/48165)) ([9be7072](https://github.com/okou-ai/okou/commit/9be7072fcdb23c781cc0d68a93dc88fc7b86f8da))
* **platform:** bound onboarding suffix stripping by its match ([#48636](https://github.com/okou-ai/okou/issues/48636)) ([8e1ce85](https://github.com/okou-ai/okou/commit/8e1ce859655e45112628de6c4502def1bbd1c3a3))
* **platform:** remove pasted text attachments feature switch ([#48148](https://github.com/okou-ai/okou/issues/48148)) ([5a278f0](https://github.com/okou-ai/okou/commit/5a278f0c51cd4c8ac0939f973ce47f9c873fa0fb))
* **platform:** simplify pdf, auth and browser close timing ([#48840](https://github.com/okou-ai/okou/issues/48840)) ([85c641e](https://github.com/okou-ai/okou/commit/85c641e01017caf8b3b6d830521cc62c242b57da))
* **platform:** use ccstate to reload credit balances ([#48843](https://github.com/okou-ai/okou/issues/48843)) ([9d67f10](https://github.com/okou-ai/okou/commit/9d67f101309b6ee9de61553eff42bc1f14901787))
* prepare structured run failure clients ([#48006](https://github.com/okou-ai/okou/issues/48006)) ([4839506](https://github.com/okou-ai/okou/commit/483950651b69db523f06a72f7cf2490c913ff8ab))
* prepare structured run failures and recovery ([#47749](https://github.com/okou-ai/okou/issues/47749)) ([fca7335](https://github.com/okou-ai/okou/commit/fca73354c6b5b0aa4f122e78947565b274323991))
* remove composer media previews feature switch ([#47816](https://github.com/okou-ai/okou/issues/47816)) ([b8da733](https://github.com/okou-ai/okou/commit/b8da733bdd33fce4c0c652fa8e8dd7939b5f7cd1))
* remove for you sources feature switch ([#48074](https://github.com/okou-ai/okou/issues/48074)) ([335f7b5](https://github.com/okou-ai/okou/commit/335f7b5c0410626867316382e92753d219e1e937))
* remove friend referrals feature switch ([#47818](https://github.com/okou-ai/okou/issues/47818)) ([adf9bb5](https://github.com/okou-ai/okou/commit/adf9bb562d3e568286b6ef682b43a2d5f0a3cefd))
* **wallet:** remove saved-card expiry compatibility ([#48003](https://github.com/okou-ai/okou/issues/48003)) ([2fb6aae](https://github.com/okou-ai/okou/commit/2fb6aaeb8bfb812d596e578c5a4eabd718dedf24))


### Performance Improvements

* **api:** retire debug-only run fields from application sql ([#48082](https://github.com/okou-ai/okou/issues/48082)) ([a40cf00](https://github.com/okou-ai/okou/commit/a40cf00d2f9e5c63fcb2dfa6ea68485b13be4f13))
* **app:** adopt the rebuilt sidebar chat registry ([#48782](https://github.com/okou-ai/okou/issues/48782)) ([340ce34](https://github.com/okou-ai/okou/commit/340ce34bcca3d89481c09b0ad8023046ba61cca8))
* **app:** defer subscription reset tooltip preparation ([#48330](https://github.com/okou-ai/okou/issues/48330)) ([828f4da](https://github.com/okou-ai/okou/commit/828f4da6545b8e6499a9e1d96cb833abdaf87b35))
* **app:** keep vnc subscriptions with vnc controls ([#48343](https://github.com/okou-ai/okou/issues/48343)) ([e4282cd](https://github.com/okou-ai/okou/commit/e4282cd8fa2ea61022cd83761695fc14a555a018))
* **app:** prepare referral content when its dialog mounts ([#48161](https://github.com/okou-ai/okou/issues/48161)) ([1519693](https://github.com/okou-ai/okou/commit/1519693b067555c9c7c6f6b2780475d538a29435))
* **app:** restore home lcp and load only the capability art on screen ([#48785](https://github.com/okou-ai/okou/issues/48785)) ([8451248](https://github.com/okou-ai/okou/commit/8451248be534efa0786da6df0fa1b1203c93f866))
* **app:** reuse confirmed user preference writes ([#48940](https://github.com/okou-ai/okou/issues/48940)) ([ec30a96](https://github.com/okou-ai/okou/commit/ec30a968b5fca542bb979aeebbc0a50b5e917a3a))
* **app:** reuse the chat artifact catalog across views ([#48933](https://github.com/okou-ai/okou/issues/48933)) ([03698f7](https://github.com/okou-ai/okou/commit/03698f76c291f312c82beb556ff7f6e32ef8369d))
* **app:** translate only consumed visualization labels ([#48424](https://github.com/okou-ai/okou/issues/48424)) ([2b07447](https://github.com/okou-ai/okou/commit/2b074478b4c7dc647afa68188a223b8bda600af2))
* **test:** avoid missing-title dumps during browser regrant waits ([#48647](https://github.com/okou-ai/okou/issues/48647)) ([1e84fc5](https://github.com/okou-ai/okou/commit/1e84fc50bf39e6a6b202cc94ff89b602bce9a0f2))
* **test:** narrow connector account readiness queries ([#48747](https://github.com/okou-ai/okou/issues/48747)) ([c596d5d](https://github.com/okou-ai/okou/commit/c596d5d82c02fab6155681fd86153ce4311b113a))
* **test:** open the custom template shelf directly ([#48920](https://github.com/okou-ai/okou/issues/48920)) ([59fce0b](https://github.com/okou-ai/okou/commit/59fce0b2203f27e682b4a522e4e7d6f713ec8338))
* **test:** reuse account manager title matches ([#48777](https://github.com/okou-ai/okou/issues/48777)) ([1cb70ce](https://github.com/okou-ai/okou/commit/1cb70ce79ff71bfea7e88899a60e1131847d2cb3))
* **test:** scope fork and forward success toast waits ([#48709](https://github.com/okou-ai/okou/issues/48709)) ([9a8c6c8](https://github.com/okou-ai/okou/commit/9a8c6c8c2ec09c2fc6e8347ea9e07149b41d7ff0))
* **test:** scope subscription reset tooltip text checks ([#48757](https://github.com/okou-ai/okou/issues/48757)) ([9e11c62](https://github.com/okou-ai/okou/commit/9e11c62ea74263555197b0d23515b9282f19584b))
* **test:** skip preparatory hover in account manager transfer tests ([#48722](https://github.com/okou-ai/okou/issues/48722)) ([96fbaf5](https://github.com/okou-ai/okou/commit/96fbaf5bc9c8c20fc3cdd6b84a4fead4a85d97af))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.91.0
    * @okouai/core bumped to 8.855.0
    * @okouai/ui bumped to 1.21.63
</details>

<details><summary>app-worker: 1.10.233</summary>

## [1.10.233](https://github.com/okou-ai/okou/compare/app-worker-v1.10.232...app-worker-v1.10.233) (2026-11-19)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.91.0
    * @okouai/core bumped to 8.855.0
</details>

<details><summary>cli: 10.35.0</summary>

## [10.35.0](https://github.com/okou-ai/okou/compare/cli-v10.34.5...cli-v10.35.0) (2026-11-19)


### Features

* add isolated official lark bot connections ([#48638](https://github.com/okou-ai/okou/issues/48638)) ([d349625](https://github.com/okou-ai/okou/commit/d349625708f8b61b15be9abf1a7c766dd4c1bc80))
* add ultrafast for codex subscriptions ([#48736](https://github.com/okou-ai/okou/issues/48736)) ([c352dad](https://github.com/okou-ai/okou/commit/c352dadadbbec10cea8cf77adccfac8462ecdb94))
* **cli:** read shared conversations with run authentication ([#48543](https://github.com/okou-ai/okou/issues/48543)) ([601fc43](https://github.com/okou-ai/okou/commit/601fc433efb5bb46f3ca6213c3ea140a407bd5b5))
* **cli:** save data responses and reuse identical calls ([#48466](https://github.com/okou-ai/okou/issues/48466)) ([cfd8171](https://github.com/okou-ai/okou/commit/cfd8171f6c0268b617f212d32802cb4ca20cfb74))
* drive phone use through realtime notifications ([#48253](https://github.com/okou-ai/okou/issues/48253)) ([7a71cfe](https://github.com/okou-ai/okou/commit/7a71cfe71674871cae66ddee7d0d12cd0a7f2760))
* replace the notification bell with platform feed events ([#47711](https://github.com/okou-ai/okou/issues/47711)) ([b5aac15](https://github.com/okou-ai/okou/commit/b5aac15af841802f580b268f27cfce7539cb9269))
* route presentation templates by output format ([#47842](https://github.com/okou-ai/okou/issues/47842)) ([b342805](https://github.com/okou-ai/okou/commit/b342805293be679b34781d7ff4811669feccbb77))
* **telemetry:** aggregate run phases from axiom logs ([#47841](https://github.com/okou-ai/okou/issues/47841)) ([1d55067](https://github.com/okou-ai/okou/commit/1d55067a6cb379e06e6f0f5bbab85113c2daa85e))


### Bug Fixes

* align phone availability with usable native control ([#48135](https://github.com/okou-ai/okou/issues/48135)) ([1744a58](https://github.com/okou-ai/okou/commit/1744a58d3f33923f71a34d07e85a87eeb86d03c1))
* **chat:** dismiss archived reminders without marking chats read ([#48560](https://github.com/okou-ai/okou/issues/48560)) ([d3d69ae](https://github.com/okou-ai/okou/commit/d3d69ae2e7738d8b0b02450dde04399c91641a54))
* **cli:** route canonical slack uploads through the server ([#48052](https://github.com/okou-ai/okou/issues/48052)) ([7715b47](https://github.com/okou-ai/okou/commit/7715b471fa140d34861d42fc9836f1a38fa58355))
* **cli:** share the browser proxy cdp connection ([#47648](https://github.com/okou-ai/okou/issues/47648)) ([0e9dbbc](https://github.com/okou-ai/okou/commit/0e9dbbcae8aaf3d0e3aa9842219b5470a477be5d))
* **phone-use:** remove local action review guidance ([#48248](https://github.com/okou-ai/okou/issues/48248)) ([72ef73a](https://github.com/okou-ai/okou/commit/72ef73aec992722ecd4b4173a02113a3e4f48327))
* **subagent:** flatten run ownership and compact streaming logs ([#48558](https://github.com/okou-ai/okou/issues/48558)) ([66b812c](https://github.com/okou-ai/okou/commit/66b812c94ae58b4d8a75aa26a5c4f3f90a1ebd40))
* use registry guide for presentation templates ([#47810](https://github.com/okou-ai/okou/issues/47810)) ([c38e98e](https://github.com/okou-ai/okou/commit/c38e98ea3b0f4527f492d42a6c342399e803ba4e))


### Refactoring

* **wallet:** remove saved-card expiry compatibility ([#48003](https://github.com/okou-ai/okou/issues/48003)) ([2fb6aae](https://github.com/okou-ai/okou/commit/2fb6aaeb8bfb812d596e578c5a4eabd718dedf24))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @okouai/api-contracts bumped to 2.91.0
    * @okouai/core bumped to 8.855.0
    * @okouai/pi-agent-runtime bumped to 1.53.0
</details>

<details><summary>core: 8.855.0</summary>

## [8.855.0](https://github.com/okou-ai/okou/compare/core-v8.854.5...core-v8.855.0) (2026-11-19)


### Features

* add for you source preferences and unread indicators ([#47771](https://github.com/okou-ai/okou/issues/47771)) ([5d3bca3](https://github.com/okou-ai/okou/commit/5d3bca33002b020ebed8d8a0d379777fb1c542b8))
* add independent project sorting ([#48352](https://github.com/okou-ai/okou/issues/48352)) ([5ace277](https://github.com/okou-ai/okou/commit/5ace277384c9a3e0da65abdbf87a89fea3311d85))
* add isolated official lark bot connections ([#48638](https://github.com/okou-ai/okou/issues/48638)) ([d349625](https://github.com/okou-ai/okou/commit/d349625708f8b61b15be9abf1a7c766dd4c1bc80))
* add markdown-first document exports ([#48734](https://github.com/okou-ai/okou/issues/48734)) ([2a6cc5d](https://github.com/okou-ai/okou/commit/2a6cc5d7ec9690cbdde76c8b31593fd10449390f))
* add ultrafast for codex subscriptions ([#48736](https://github.com/okou-ai/okou/issues/48736)) ([c352dad](https://github.com/okou-ai/okou/commit/c352dadadbbec10cea8cf77adccfac8462ecdb94))
* **app:** enable feature guides with the my okou redesign ([#47733](https://github.com/okou-ai/okou/issues/47733)) ([0e9387d](https://github.com/okou-ai/okou/commit/0e9387d6ef081ec765f9c1392e1158ac95bc6da0))
* **app:** preselect multiple output formats from onboarding links ([#48433](https://github.com/okou-ai/okou/issues/48433)) ([293ff03](https://github.com/okou-ai/okou/commit/293ff03824b50f184a72b666db25a44725229eca))
* **app:** release share audience descriptions and website share rows ([#48544](https://github.com/okou-ai/okou/issues/48544)) ([60461e9](https://github.com/okou-ai/okou/commit/60461e9da15d190d7e34e633ce0e2a61d195026f))
* **core:** enable artifact generation timing by default ([#48626](https://github.com/okou-ai/okou/issues/48626)) ([f3c43bf](https://github.com/okou-ai/okou/commit/f3c43bf0cb414043f36623cc451d12d8ce223bae))
* **core:** enable home capabilities for everyone ([#48000](https://github.com/okou-ai/okou/issues/48000)) ([5df5fc2](https://github.com/okou-ai/okou/commit/5df5fc264b933fdb4aa8210740221f921e6232d7))
* **core:** enable presentation output format for staff ([#48524](https://github.com/okou-ai/okou/issues/48524)) ([af156ca](https://github.com/okou-ai/okou/commit/af156ca8c7dea3483e14ae37a058890dd57581d0))
* **my-okou:** preserve initialized members and enable new-member defaults ([#47051](https://github.com/okou-ai/okou/issues/47051)) ([cf1c9e5](https://github.com/okou-ai/okou/commit/cf1c9e53c2076c58bd6bb85d51dedbd62c30b6d1))
* replace the notification bell with platform feed events ([#47711](https://github.com/okou-ai/okou/issues/47711)) ([b5aac15](https://github.com/okou-ai/okou/commit/b5aac15af841802f580b268f27cfce7539cb9269))
* roll out free plan artifact paywall ([#48265](https://github.com/okou-ai/okou/issues/48265)) ([a8c6d85](https://github.com/okou-ai/okou/commit/a8c6d85e09610d0268362ec7db53d7ec8f031fb6))
* route presentation templates by output format ([#47842](https://github.com/okou-ai/okou/issues/47842)) ([b342805](https://github.com/okou-ai/okou/commit/b342805293be679b34781d7ff4811669feccbb77))


### Bug Fixes

* **api:** support attachments on inactive single agent workflow copies ([#48624](https://github.com/okou-ai/okou/issues/48624)) ([f41a05a](https://github.com/okou-ai/okou/commit/f41a05a04f254ecc6e4e614db921fef94b44ace1))
* **app:** match project titles to thread overflow behavior ([#48220](https://github.com/okou-ai/okou/issues/48220)) ([96b2fc7](https://github.com/okou-ai/okou/commit/96b2fc71b22699ef6cd56c3229a762aa2887e19b))
* **app:** refine visualization selection chips ([#47888](https://github.com/okou-ai/okou/issues/47888)) ([c64cef6](https://github.com/okou-ai/okou/commit/c64cef650edd4ad914514bb20f5a87c8431edff2))
* make projects follow the single agent switch ([#48142](https://github.com/okou-ai/okou/issues/48142)) ([c8c181a](https://github.com/okou-ai/okou/commit/c8c181a5d258306463622a74129e8f770ba00fd7))
* **platform:** reveal preview actions together and keep downloads visible ([#48340](https://github.com/okou-ai/okou/issues/48340)) ([f8ae254](https://github.com/okou-ai/okou/commit/f8ae254298f87d0d514f3625ea6bf63ed59ecd22))
* use registry guide for presentation templates ([#47810](https://github.com/okou-ai/okou/issues/47810)) ([c38e98e](https://github.com/okou-ai/okou/commit/c38e98ea3b0f4527f492d42a6c342399e803ba4e))


### Refactoring

* **api:** consolidate execution admission facts ([#47899](https://github.com/okou-ai/okou/issues/47899)) ([270a932](https://github.com/okou-ai/okou/commit/270a932913e030a8d3628889d04d7a11ff213761))
* **api:** prepare built-in skills catalog ([#48931](https://github.com/okou-ai/okou/issues/48931)) ([68e9859](https://github.com/okou-ai/okou/commit/68e9859823b1be6ae83c2422a09dc75e9dbd0ab1))
* **api:** remove workflow storage launch remnants ([#47913](https://github.com/okou-ai/okou/issues/47913)) ([5093a7d](https://github.com/okou-ai/okou/commit/5093a7d563b2290b988726b3ef4bdb5ac1459e08))
* **api:** use three-point axiom artifact timing ([#48854](https://github.com/okou-ai/okou/issues/48854)) ([d930e21](https://github.com/okou-ai/okou/commit/d930e21f8d3d93278613fcef287ae7b58febdf72))
* **app:** retire home capability and visualization summary switches ([#48151](https://github.com/okou-ai/okou/issues/48151)) ([b702121](https://github.com/okou-ai/okou/commit/b7021210adfafc0abd5a9f7c74a14f67d6e5b3b2))
* **app:** use a single async feature switch source ([#48862](https://github.com/okou-ai/okou/issues/48862)) ([60b272c](https://github.com/okou-ai/okou/commit/60b272ce6f1087359500c7d8d5ec75e7f3050b30))
* **core:** simplify default instructions ([#48457](https://github.com/okou-ai/okou/issues/48457)) ([c4bc8b3](https://github.com/okou-ai/okou/commit/c4bc8b3079b8c38c3323e11ecaa445b5cf30837a))
* **platform:** remove pasted text attachments feature switch ([#48148](https://github.com/okou-ai/okou/issues/48148)) ([5a278f0](https://github.com/okou-ai/okou/commit/5a278f0c51cd4c8ac0939f973ce47f9c873fa0fb))
* remove chat action followups feature switch ([#47820](https://github.com/okou-ai/okou/issues/47820)) ([9b09da6](https://github.com/okou-ai/okou/commit/9b09da6d6de84b19146606ff34b81d9b0f0232c5))
* remove composer media previews feature switch ([#47816](https://github.com/okou-ai/okou/issues/47816)) ([b8da733](https://github.com/okou-ai/okou/commit/b8da733bdd33fce4c0c652fa8e8dd7939b5f7cd1))
* remove for you sources feature switch ([#48074](https://github.com/okou-ai/okou/issues/48074)) ([335f7b5](https://github.com/okou-ai/okou/commit/335f7b5c0410626867316382e92753d219e1e937))
* remove friend referrals feature switch ([#47818](https://github.com/okou-ai/okou/issues/47818)) ([adf9bb5](https://github.com/okou-ai/okou/commit/adf9bb562d3e568286b6ef682b43a2d5f0a3cefd))
* remove integration model recovery feature switch ([#47814](https://github.com/okou-ai/okou/issues/47814)) ([42f602a](https://github.com/okou-ai/okou/commit/42f602a3099b330cd59ef01fc389c43d3f067840))
* remove ios settings credits feature switch ([#47822](https://github.com/okou-ai/okou/issues/47822)) ([051dbad](https://github.com/okou-ai/okou/commit/051dbad9a13dba24291a9adf76b7665e6208a18f))
* remove ssh chat approval feature switch ([#47815](https://github.com/okou-ai/okou/issues/47815)) ([d02807d](https://github.com/okou-ai/okou/commit/d02807db93eea5e76032aeb2eb0783de31b38014))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.91.0
</details>

<details><summary>db: 2.52.0</summary>

## [2.52.0](https://github.com/okou-ai/okou/compare/db-v2.51.1...db-v2.52.0) (2026-11-19)


### Features

* add for you source preferences and unread indicators ([#47771](https://github.com/okou-ai/okou/issues/47771)) ([5d3bca3](https://github.com/okou-ai/okou/commit/5d3bca33002b020ebed8d8a0d379777fb1c542b8))
* add independent project sorting ([#48352](https://github.com/okou-ai/okou/issues/48352)) ([5ace277](https://github.com/okou-ai/okou/commit/5ace277384c9a3e0da65abdbf87a89fea3311d85))
* add isolated official lark bot connections ([#48638](https://github.com/okou-ai/okou/issues/48638)) ([d349625](https://github.com/okou-ai/okou/commit/d349625708f8b61b15be9abf1a7c766dd4c1bc80))
* add ultrafast for codex subscriptions ([#48736](https://github.com/okou-ai/okou/issues/48736)) ([c352dad](https://github.com/okou-ai/okou/commit/c352dadadbbec10cea8cf77adccfac8462ecdb94))
* **api:** target feature guide editions by organization and member ([#48067](https://github.com/okou-ai/okou/issues/48067)) ([14b58ff](https://github.com/okou-ai/okou/commit/14b58ff87fef1f59b45d9278835f0dc0768d8583))
* **db:** activate single agent for active default-agent workspaces ([#48783](https://github.com/okou-ai/okou/issues/48783)) ([6615e67](https://github.com/okou-ai/okou/commit/6615e672e196a5933085f89dd8b6be971012d978))
* **db:** enable my okou for morning brief and empty workspaces ([#48915](https://github.com/okou-ai/okou/issues/48915)) ([a895e63](https://github.com/okou-ai/okou/commit/a895e639d143463089f65332c1f5e5411cb27232))
* **db:** migrate active multi-agent workspaces and target my okou guide ([#48807](https://github.com/okou-ai/okou/issues/48807)) ([a33fdd9](https://github.com/okou-ai/okou/commit/a33fdd90867d3f5f2df6474c7ab231dd362c6dce))
* **db:** migrate inactive legacy workspaces to single agent ([#48522](https://github.com/okou-ai/okou/issues/48522)) ([0ca84a9](https://github.com/okou-ai/okou/commit/0ca84a96783c4065b5a8ac36f8928c11cb4f52e1))
* **db:** migrate quiet workspaces to my okou ([#48881](https://github.com/okou-ai/okou/issues/48881)) ([040839e](https://github.com/okou-ai/okou/commit/040839eca8628df64ed2d9e53c914d3b1e8ccfda))
* **db:** migrate three inactive workspaces to single agent ([#48331](https://github.com/okou-ai/okou/issues/48331)) ([66e28d0](https://github.com/okou-ai/okou/commit/66e28d0e72baf9275e880a57b5fdce6671971493))
* **ios:** refresh home screen widgets when chats change elsewhere ([#47010](https://github.com/okou-ai/okou/issues/47010)) ([a3459ce](https://github.com/okou-ai/okou/commit/a3459ce8b0a9e90434e1b2ae3d1791108e7eebd1))
* **my-okou:** preserve initialized members and enable new-member defaults ([#47051](https://github.com/okou-ai/okou/issues/47051)) ([cf1c9e5](https://github.com/okou-ai/okou/commit/cf1c9e53c2076c58bd6bb85d51dedbd62c30b6d1))
* **onboarding:** persist drafts across devices ([#48816](https://github.com/okou-ai/okou/issues/48816)) ([368d3dd](https://github.com/okou-ai/okou/commit/368d3dd31744833319c9cffce3c17191a5c327d7))
* publish native pptx presentation template archives ([#48078](https://github.com/okou-ai/okou/issues/48078)) ([334f3f0](https://github.com/okou-ai/okou/commit/334f3f0bc24533b396dc0bc3ea8c05f9363c026c))
* replace the notification bell with platform feed events ([#47711](https://github.com/okou-ai/okou/issues/47711)) ([b5aac15](https://github.com/okou-ai/okou/commit/b5aac15af841802f580b268f27cfce7539cb9269))
* route presentation templates by output format ([#47842](https://github.com/okou-ai/okou/issues/47842)) ([b342805](https://github.com/okou-ai/okou/commit/b342805293be679b34781d7ff4811669feccbb77))


### Bug Fixes

* **api:** record artifact success separately from run completion ([#48245](https://github.com/okou-ai/okou/issues/48245)) ([d9940ef](https://github.com/okou-ai/okou/commit/d9940efa398db348d91044a76fda715abc5f1dce))
* **api:** scope committed work to owners and reduce test isolation ([#48329](https://github.com/okou-ai/okou/issues/48329)) ([af5863f](https://github.com/okou-ai/okou/commit/af5863fc181e298829cd5f1ea2a4bc4dc63d89fa))
* **api:** support attachments on inactive single agent workflow copies ([#48624](https://github.com/okou-ai/okou/issues/48624)) ([f41a05a](https://github.com/okou-ai/okou/commit/f41a05a04f254ecc6e4e614db921fef94b44ace1))
* **db:** bound the inactive batch late chat check ([#48703](https://github.com/okou-ai/okou/issues/48703)) ([28e4cdf](https://github.com/okou-ai/okou/commit/28e4cdfd86d923e6f63db981b708c2e997aa9797))
* **db:** drop retired ios widget push columns ([#48956](https://github.com/okou-ai/okou/issues/48956)) ([d18d687](https://github.com/okou-ai/okou/commit/d18d6871bd8ebca73e559cbabb73f5b95850d056))
* **ios:** restore app-driven widget updates ([#48918](https://github.com/okou-ai/okou/issues/48918)) ([d850651](https://github.com/okou-ai/okou/commit/d8506517c032a16c88be5a9b77b46b0741060dfe))
* make system updates configurable ([#47882](https://github.com/okou-ai/okou/issues/47882)) ([f1bf918](https://github.com/okou-ai/okou/commit/f1bf918e9c3d2033a956b51a8bcb3ee0ad77cb3c))


### Refactoring

* activate structured run failures with retained storage ([#47844](https://github.com/okou-ai/okou/issues/47844)) ([fdb91d8](https://github.com/okou-ai/okou/commit/fdb91d8fea44a0be90036ebd9d6c25210eb5baa2))
* **api:** activate member memory authority ([#48232](https://github.com/okou-ai/okou/issues/48232)) ([91ce356](https://github.com/okou-ai/okou/commit/91ce3565d08415a9133200504e26708d4d78db10))
* **api:** prepare built-in skills catalog ([#48931](https://github.com/okou-ai/okou/issues/48931)) ([68e9859](https://github.com/okou-ai/okou/commit/68e9859823b1be6ae83c2422a09dc75e9dbd0ab1))
* **api:** use three-point axiom artifact timing ([#48854](https://github.com/okou-ai/okou/issues/48854)) ([d930e21](https://github.com/okou-ai/okou/commit/d930e21f8d3d93278613fcef287ae7b58febdf72))
* **db:** remove legacy run phase timing storage ([#47889](https://github.com/okou-ai/okou/issues/47889)) ([6832b60](https://github.com/okou-ai/okou/commit/6832b606f9cfe1ed40038443504737e7b77f28e8))
* **memory:** prepare member-owned persistence ([#47918](https://github.com/okou-ai/okou/issues/47918)) ([ae54ad4](https://github.com/okou-ai/okou/commit/ae54ad44b0650b497e9e272349498571c0235ba2))
* **memory:** retire legacy memory compatibility runtime ([#48363](https://github.com/okou-ai/okou/issues/48363)) ([7a30ea0](https://github.com/okou-ai/okou/commit/7a30ea0ee45da9dabdda7167d9c60e5b91496b7e))


### Performance Improvements

* **api:** retire debug-only run fields from application sql ([#48082](https://github.com/okou-ai/okou/issues/48082)) ([a40cf00](https://github.com/okou-ai/okou/commit/a40cf00d2f9e5c63fcb2dfa6ea68485b13be4f13))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.91.0
    * @okouai/core bumped to 8.855.0
</details>

<details><summary>host-worker: 1.9.156</summary>

## [1.9.156](https://github.com/okou-ai/okou/compare/host-worker-v1.9.155...host-worker-v1.9.156) (2026-11-19)


### Bug Fixes

* **app:** align artifact close button hover shape ([#48846](https://github.com/okou-ai/okou/issues/48846)) ([e74770e](https://github.com/okou-ai/okou/commit/e74770e52f002811f5800f8de1c171021b22ed22))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.91.0
    * @okouai/core bumped to 8.855.0
    * @okouai/ui bumped to 1.21.63
</details>

<details><summary>pi-agent-runtime: 1.53.0</summary>

## [1.53.0](https://github.com/okou-ai/okou/compare/pi-agent-runtime-v1.52.5...pi-agent-runtime-v1.53.0) (2026-11-19)


### Features

* add ultrafast for codex subscriptions ([#48736](https://github.com/okou-ai/okou/issues/48736)) ([c352dad](https://github.com/okou-ai/okou/commit/c352dadadbbec10cea8cf77adccfac8462ecdb94))


### Bug Fixes

* bound pi tool image history across requests and runs ([#48536](https://github.com/okou-ai/okou/issues/48536)) ([f7d4dcf](https://github.com/okou-ai/okou/commit/f7d4dcf2661c5ba1598509dac239fed6d74c8f8c))
* **pi:** compact auto sessions above 721k tokens ([#48628](https://github.com/okou-ai/okou/issues/48628)) ([e94a8d7](https://github.com/okou-ai/okou/commit/e94a8d7b6150021e9443842368658dd5a9cf20e8))
* **pi:** preserve rpc input ownership through settlement ([#48564](https://github.com/okou-ai/okou/issues/48564)) ([cf45a8a](https://github.com/okou-ai/okou/commit/cf45a8a087521126c8fe79e8e3bae4f39d62eb37))
* **subagent:** flatten run ownership and compact streaming logs ([#48558](https://github.com/okou-ai/okou/issues/48558)) ([66b812c](https://github.com/okou-ai/okou/commit/66b812c94ae58b4d8a75aa26a5c4f3f90a1ebd40))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.91.0
  * devDependencies
    * @okouai/core bumped to 8.855.0
</details>

<details><summary>ui: 1.21.63</summary>

## [1.21.63](https://github.com/okou-ai/okou/compare/ui-v1.21.62...ui-v1.21.63) (2026-11-19)


### Bug Fixes

* **app:** align artifact close button hover shape ([#48846](https://github.com/okou-ai/okou/issues/48846)) ([e74770e](https://github.com/okou-ai/okou/commit/e74770e52f002811f5800f8de1c171021b22ed22))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.855.0
</details>

<details><summary>api: 2.95.0</summary>

## [2.95.0](https://github.com/okou-ai/okou/compare/api-v2.94.3...api-v2.95.0) (2026-11-19)


### Features

* add for you source preferences and unread indicators ([#47771](https://github.com/okou-ai/okou/issues/47771)) ([5d3bca3](https://github.com/okou-ai/okou/commit/5d3bca33002b020ebed8d8a0d379777fb1c542b8))
* add independent project sorting ([#48352](https://github.com/okou-ai/okou/issues/48352)) ([5ace277](https://github.com/okou-ai/okou/commit/5ace277384c9a3e0da65abdbf87a89fea3311d85))
* add isolated official lark bot connections ([#48638](https://github.com/okou-ai/okou/issues/48638)) ([d349625](https://github.com/okou-ai/okou/commit/d349625708f8b61b15be9abf1a7c766dd4c1bc80))
* add markdown-first document exports ([#48734](https://github.com/okou-ai/okou/issues/48734)) ([2a6cc5d](https://github.com/okou-ai/okou/commit/2a6cc5d7ec9690cbdde76c8b31593fd10449390f))
* add ultrafast for codex subscriptions ([#48736](https://github.com/okou-ai/okou/issues/48736)) ([c352dad](https://github.com/okou-ai/okou/commit/c352dadadbbec10cea8cf77adccfac8462ecdb94))
* **api:** add dedicated reward receipt lookup ([#47848](https://github.com/okou-ai/okou/issues/47848)) ([fcc0ab8](https://github.com/okou-ai/okou/commit/fcc0ab87f7cdde80581b8b496f1689585f5c0ac9))
* **api:** add read-only reward history export ([#47764](https://github.com/okou-ai/okou/issues/47764)) ([3a0c748](https://github.com/okou-ai/okou/commit/3a0c748549d997794f364d03486610476f60881e))
* **api:** allow scoped native oauth companion access ([#48263](https://github.com/okou-ai/okou/issues/48263)) ([6c27338](https://github.com/okou-ai/okou/commit/6c273389fcde806f2b8067941a4fb3750c6375ac))
* **api:** durably refresh confirmed marketing rewards ([#48139](https://github.com/okou-ai/okou/issues/48139)) ([6d68129](https://github.com/okou-ai/okou/commit/6d68129031a759c9a2cc232d4c365021e6b820be))
* **api:** durably refresh marketing reward progress ([#48264](https://github.com/okou-ai/okou/issues/48264)) ([f0eddb0](https://github.com/okou-ai/okou/commit/f0eddb06ec314725bc198c2bbbde7c5bb31a00c2))
* **api:** expose read-only invitation source facts ([#48225](https://github.com/okou-ai/okou/issues/48225)) ([2ef7440](https://github.com/okou-ai/okou/commit/2ef744094b871e889eb74c4d50c5ee475ef6baab))
* **api:** expose read-only workflow source observations ([#48211](https://github.com/okou-ai/okou/issues/48211)) ([165957f](https://github.com/okou-ai/okou/commit/165957f2b71fb10144cd8a042086528a92262b91))
* **api:** expose retained invitation claim source facts ([#48242](https://github.com/okou-ai/okou/issues/48242)) ([489c76e](https://github.com/okou-ai/okou/commit/489c76e8081331c365025ff3fceabf0aafbe1e27))
* **api:** gate feature guide items by optional feature switches ([#48056](https://github.com/okou-ai/okou/issues/48056)) ([289c793](https://github.com/okou-ai/okou/commit/289c79330d548748176ff23e803a036175ea435e))
* **api:** persist marketing reward invitation source events ([#48038](https://github.com/okou-ai/okou/issues/48038)) ([1a0090d](https://github.com/okou-ai/okou/commit/1a0090dd00ee6cc9e53f8768f8be30b317ba888d))
* **api:** persist marketing reward link source events ([#47991](https://github.com/okou-ai/okou/issues/47991)) ([599e4df](https://github.com/okou-ai/okou/commit/599e4dfd4d619cd6921157c14cd0d52133cbe1e6))
* **api:** persist marketing reward oauth source events ([#47894](https://github.com/okou-ai/okou/issues/47894)) ([2a9ec88](https://github.com/okou-ai/okou/commit/2a9ec88aa67e09cd12bec71ac18b6379682fd2e3))
* **api:** persist marketing reward workflow source events ([#48063](https://github.com/okou-ai/okou/issues/48063)) ([e3e8008](https://github.com/okou-ai/okou/commit/e3e8008f9c903e8d9c58c448141c7bca3b8df4ed))
* **api:** prepare controlled marketing reward routing ([#48235](https://github.com/okou-ai/okou/issues/48235)) ([850096b](https://github.com/okou-ai/okou/commit/850096b648aa3d77b198e18cfb69baa6cdf3dff9))
* **api:** retain source-proven daily check-in requests ([#48157](https://github.com/okou-ai/okou/issues/48157)) ([2685448](https://github.com/okou-ai/okou/commit/26854487b208b5123e9c9e03f84d4154f12c6475))
* **api:** settle source-proven marketing rewards ([#48079](https://github.com/okou-ai/okou/issues/48079)) ([95e2816](https://github.com/okou-ai/okou/commit/95e2816dd55eef02f025b55699e01bc0b1f16f8f))
* **api:** target feature guide editions by organization and member ([#48067](https://github.com/okou-ai/okou/issues/48067)) ([14b58ff](https://github.com/okou-ai/okou/commit/14b58ff87fef1f59b45d9278835f0dc0768d8583))
* **app:** enable feature guides with the my okou redesign ([#47733](https://github.com/okou-ai/okou/issues/47733)) ([0e9387d](https://github.com/okou-ai/okou/commit/0e9387d6ef081ec765f9c1392e1158ac95bc6da0))
* **cli:** save data responses and reuse identical calls ([#48466](https://github.com/okou-ai/okou/issues/48466)) ([cfd8171](https://github.com/okou-ai/okou/commit/cfd8171f6c0268b617f212d32802cb4ca20cfb74))
* **core:** enable artifact generation timing by default ([#48626](https://github.com/okou-ai/okou/issues/48626)) ([f3c43bf](https://github.com/okou-ai/okou/commit/f3c43bf0cb414043f36623cc451d12d8ce223bae))
* **core:** enable presentation output format for staff ([#48524](https://github.com/okou-ai/okou/issues/48524)) ([af156ca](https://github.com/okou-ai/okou/commit/af156ca8c7dea3483e14ae37a058890dd57581d0))
* drive phone use through realtime notifications ([#48253](https://github.com/okou-ai/okou/issues/48253)) ([7a71cfe](https://github.com/okou-ai/okou/commit/7a71cfe71674871cae66ddee7d0d12cd0a7f2760))
* **ios:** refresh home screen widgets when chats change elsewhere ([#47010](https://github.com/okou-ai/okou/issues/47010)) ([a3459ce](https://github.com/okou-ai/okou/commit/a3459ce8b0a9e90434e1b2ae3d1791108e7eebd1))
* **my-okou:** preserve initialized members and enable new-member defaults ([#47051](https://github.com/okou-ai/okou/issues/47051)) ([cf1c9e5](https://github.com/okou-ai/okou/commit/cf1c9e53c2076c58bd6bb85d51dedbd62c30b6d1))
* **onboarding:** persist drafts across devices ([#48816](https://github.com/okou-ai/okou/issues/48816)) ([368d3dd](https://github.com/okou-ai/okou/commit/368d3dd31744833319c9cffce3c17191a5c327d7))
* replace the notification bell with platform feed events ([#47711](https://github.com/okou-ai/okou/issues/47711)) ([b5aac15](https://github.com/okou-ai/okou/commit/b5aac15af841802f580b268f27cfce7539cb9269))
* roll out free plan artifact paywall ([#48265](https://github.com/okou-ai/okou/issues/48265)) ([a8c6d85](https://github.com/okou-ai/okou/commit/a8c6d85e09610d0268362ec7db53d7ec8f031fb6))
* route presentation templates by output format ([#47842](https://github.com/okou-ai/okou/issues/47842)) ([b342805](https://github.com/okou-ai/okou/commit/b342805293be679b34781d7ff4811669feccbb77))
* **telemetry:** aggregate run phases from axiom logs ([#47841](https://github.com/okou-ai/okou/issues/47841)) ([1d55067](https://github.com/okou-ai/okou/commit/1d55067a6cb379e06e6f0f5bbab85113c2daa85e))


### Bug Fixes

* align phone availability with usable native control ([#48135](https://github.com/okou-ai/okou/issues/48135)) ([1744a58](https://github.com/okou-ai/okou/commit/1744a58d3f33923f71a34d07e85a87eeb86d03c1))
* **api:** accept slack processed file sizes in delivery receipts ([#48083](https://github.com/okou-ai/okou/issues/48083)) ([bb96560](https://github.com/okou-ai/okou/commit/bb96560de6ca1fa02a6a0eb26e4b6ab9fdf957ef))
* **api:** authorize OAuth by route scopes ([#48878](https://github.com/okou-ai/okou/issues/48878)) ([34d574a](https://github.com/okou-ai/okou/commit/34d574a25f2bb3f096829e94b7a53d7608545245))
* **api:** classify malformed outlook draft ids ([#48794](https://github.com/okou-ai/okou/issues/48794)) ([4cfd459](https://github.com/okou-ai/okou/commit/4cfd45983a517e8975e1e5021f7eeb7a37ad41b7))
* **api:** deliver canonical slack file bytes on the server ([#48047](https://github.com/okou-ai/okou/issues/48047)) ([b94750b](https://github.com/okou-ai/okou/commit/b94750b39f87264646854948b0cfac50f1585a14))
* **api:** handle phone use authority read timeouts ([#48681](https://github.com/okou-ai/okou/issues/48681)) ([1b1b28f](https://github.com/okou-ai/okou/commit/1b1b28fef198b6e6548542691746291740cac9fc))
* **api:** include integration context in chat title generation ([#48616](https://github.com/okou-ai/okou/issues/48616)) ([9a33655](https://github.com/okou-ai/okou/commit/9a33655d9402d053fa0c9828bd7375b1a4429c81))
* **api:** log gmail draft send rejection reasons ([#48635](https://github.com/okou-ai/okou/issues/48635)) ([4a6f238](https://github.com/okou-ai/okou/commit/4a6f2387ebaae98bea339631ee11fe5a87466780))
* **api:** preserve custom connector execution network bindings ([#47836](https://github.com/okou-ai/okou/issues/47836)) ([627c2f0](https://github.com/okou-ai/okou/commit/627c2f06e0b3cd65b8c12c33827ccd94a2796460))
* **api:** read android release manifest directly from r2 ([#47755](https://github.com/okou-ai/okou/issues/47755)) ([5baac71](https://github.com/okou-ai/okou/commit/5baac71439dde57bde5d4608c30ed716d05beaa4))
* **api:** record artifact success separately from run completion ([#48245](https://github.com/okou-ai/okou/issues/48245)) ([d9940ef](https://github.com/okou-ai/okou/commit/d9940efa398db348d91044a76fda715abc5f1dce))
* **api:** remove outdated model guidance from welcome messages ([#48237](https://github.com/okou-ai/okou/issues/48237)) ([3f547ff](https://github.com/okou-ai/okou/commit/3f547ffdd411027959a59b207f7c968dc649b9c7))
* **api:** require web 0.1141.3 for unified projects ([#48149](https://github.com/okou-ai/okou/issues/48149)) ([145f898](https://github.com/okou-ai/okou/commit/145f898d2110cb13e6d2bcd50ad412a7ec959707))
* **api:** restore worker chat contract boundary ([#48831](https://github.com/okou-ai/okou/issues/48831)) ([eaa5345](https://github.com/okou-ai/okou/commit/eaa534508cd90d369ce240cd754aaf98ecb4e289))
* **api:** scope committed work to owners and reduce test isolation ([#48329](https://github.com/okou-ai/okou/issues/48329)) ([af5863f](https://github.com/okou-ai/okou/commit/af5863fc181e298829cd5f1ea2a4bc4dc63d89fa))
* **api:** support attachments on inactive single agent workflow copies ([#48624](https://github.com/okou-ai/okou/issues/48624)) ([f41a05a](https://github.com/okou-ai/okou/commit/f41a05a04f254ecc6e4e614db921fef94b44ace1))
* **app:** clarify paused automation feed cards ([#48887](https://github.com/okou-ai/okou/issues/48887)) ([4b72b66](https://github.com/okou-ai/okou/commit/4b72b660f8279424182640658aa21773cc49ccd4))
* **app:** keep artifact categories visible and group pptx presentations ([#48154](https://github.com/okou-ai/okou/issues/48154)) ([ff91500](https://github.com/okou-ai/okou/commit/ff915007aee99db02847333166b8f4bd2962b0f3))
* **artifacts:** reduce visibility update latency ([#48652](https://github.com/okou-ai/okou/issues/48652)) ([7f50485](https://github.com/okou-ai/okou/commit/7f50485e293fab339942a621798bd35ae9464bc2))
* automatically continue integration chats after model recovery ([#48152](https://github.com/okou-ai/okou/issues/48152)) ([70b6624](https://github.com/okou-ai/okou/commit/70b6624fcc16a0197b0dceb88fc587ac694c1c86))
* **browser:** retain native cdp connection diagnostics ([#47833](https://github.com/okou-ai/okou/issues/47833)) ([9b6aa42](https://github.com/okou-ai/okou/commit/9b6aa42b138c34b2ccef2044be78443dd4e4b602))
* **chat:** dismiss archived reminders without marking chats read ([#48560](https://github.com/okou-ai/okou/issues/48560)) ([d3d69ae](https://github.com/okou-ai/okou/commit/d3d69ae2e7738d8b0b02450dde04399c91641a54))
* classify codex terminal failures and agent oom ([#48521](https://github.com/okou-ai/okou/issues/48521)) ([00075f2](https://github.com/okou-ai/okou/commit/00075f2f8a0d64e6aa8c3cecc8dc7bdc6cccde5f))
* **db:** drop retired ios widget push columns ([#48956](https://github.com/okou-ai/okou/issues/48956)) ([d18d687](https://github.com/okou-ai/okou/commit/d18d6871bd8ebca73e559cbabb73f5b95850d056))
* generate semantic filenames for message pdf downloads ([#48262](https://github.com/okou-ai/okou/issues/48262)) ([d311fd8](https://github.com/okou-ai/okou/commit/d311fd8ca02dc9b2c555e52c2e8112a0fbab002b))
* **ios:** restore app-driven widget updates ([#48918](https://github.com/okou-ai/okou/issues/48918)) ([d850651](https://github.com/okou-ai/okou/commit/d8506517c032a16c88be5a9b77b46b0741060dfe))
* make projects follow the single agent switch ([#48142](https://github.com/okou-ai/okou/issues/48142)) ([c8c181a](https://github.com/okou-ai/okou/commit/c8c181a5d258306463622a74129e8f770ba00fd7))
* make system updates configurable ([#47882](https://github.com/okou-ai/okou/issues/47882)) ([f1bf918](https://github.com/okou-ai/okou/commit/f1bf918e9c3d2033a956b51a8bcb3ee0ad77cb3c))
* **phone-use:** remove local action review guidance ([#48248](https://github.com/okou-ai/okou/issues/48248)) ([72ef73a](https://github.com/okou-ai/okou/commit/72ef73aec992722ecd4b4173a02113a3e4f48327))
* **suggestions:** verify user identity in third-party sources ([#47812](https://github.com/okou-ai/okou/issues/47812)) ([3dcd0c8](https://github.com/okou-ai/okou/commit/3dcd0c8e27b7ae1dbce309bf71c943d613b3f89f))
* use registry guide for presentation templates ([#47810](https://github.com/okou-ai/okou/issues/47810)) ([c38e98e](https://github.com/okou-ai/okou/commit/c38e98ea3b0f4527f492d42a6c342399e803ba4e))


### Refactoring

* activate structured run failures with retained storage ([#47844](https://github.com/okou-ai/okou/issues/47844)) ([fdb91d8](https://github.com/okou-ai/okou/commit/fdb91d8fea44a0be90036ebd9d6c25210eb5baa2))
* **api:** activate member memory authority ([#48232](https://github.com/okou-ai/okou/issues/48232)) ([91ce356](https://github.com/okou-ai/okou/commit/91ce3565d08415a9133200504e26708d4d78db10))
* **api:** build complete execution requests in publication ([#48065](https://github.com/okou-ai/okou/issues/48065)) ([bba6568](https://github.com/okou-ai/okou/commit/bba65683295e470256cba42f0ce6c8457972fd98))
* **api:** carry pinned model selection through thread launch ([#47920](https://github.com/okou-ai/okou/issues/47920)) ([bce1ee8](https://github.com/okou-ai/okou/commit/bce1ee89e973cd00fec9327392a6c9db21b196b1))
* **api:** carry the accepted official workflow mounts into dispatch ([#48857](https://github.com/okou-ai/okou/issues/48857)) ([47c480b](https://github.com/okou-ai/okou/commit/47c480bc3f4ab7f99722a823f512261d10e8040d))
* **api:** consolidate execution admission facts ([#47899](https://github.com/okou-ai/okou/issues/47899)) ([270a932](https://github.com/okou-ai/okou/commit/270a932913e030a8d3628889d04d7a11ff213761))
* **api:** consolidate execution context ownership ([#48005](https://github.com/okou-ai/okou/issues/48005)) ([6df7b59](https://github.com/okou-ai/okou/commit/6df7b59d7243059eaf8bfc21d3cc5c086d3aa6ee))
* **api:** consume captured execution inputs directly ([#47885](https://github.com/okou-ai/okou/issues/47885)) ([e761a45](https://github.com/okou-ai/okou/commit/e761a45ea5a1569151e19169b0ab3e0b2accf761))
* **api:** delegate mcp token verification to clerk ([#48863](https://github.com/okou-ai/okou/issues/48863)) ([bbf2529](https://github.com/okou-ai/okou/commit/bbf25298b7e7127fe90a41dabdf82c84b942ae46))
* **api:** dispatch official connector credentials as placeholders ([#48269](https://github.com/okou-ai/okou/issues/48269)) ([260b237](https://github.com/okou-ai/okou/commit/260b237806d0bb6e4f000355adfa1adb9e46e0e1))
* **api:** make direct execution thread-bound ([#47827](https://github.com/okou-ai/okou/issues/47827)) ([814d333](https://github.com/okou-ai/okou/commit/814d3333573251f72d46132bb58d3606276c845e))
* **api:** pass effective queued model selection to routing ([#48912](https://github.com/okou-ai/okou/issues/48912)) ([4843b38](https://github.com/okou-ai/okou/commit/4843b38b94cf7777598a16287a8d559136bc695c))
* **api:** prepare built-in skills catalog ([#48931](https://github.com/okou-ai/okou/issues/48931)) ([68e9859](https://github.com/okou-ai/okou/commit/68e9859823b1be6ae83c2422a09dc75e9dbd0ab1))
* **api:** publish invitation facts and retire marketing read bridges ([#48630](https://github.com/okou-ai/okou/issues/48630)) ([fd53dd1](https://github.com/okou-ai/okou/commit/fd53dd1e7c58e7fdb39bb6f2d97b70ce8c53e162))
* **api:** remove legacy project sort event transforms ([#48850](https://github.com/okou-ai/okou/issues/48850)) ([8cef6d3](https://github.com/okou-ai/okou/commit/8cef6d31698d1c28d26aa47f769b9f52ea2e5da9))
* **api:** remove legacy storage export authorization ([#48732](https://github.com/okou-ai/okou/issues/48732)) ([ad521c5](https://github.com/okou-ai/okou/commit/ad521c515f25954f1cc271eceab18da4f2bb2789))
* **api:** remove workflow storage launch remnants ([#47913](https://github.com/okou-ai/okou/issues/47913)) ([5093a7d](https://github.com/okou-ai/okou/commit/5093a7d563b2290b988726b3ef4bdb5ac1459e08))
* **api:** require captured thread continuation for launch ([#47754](https://github.com/okou-ai/okou/issues/47754)) ([ad8cca4](https://github.com/okou-ai/okou/commit/ad8cca4bb9a3d3db47bd8852201b8d6c3cfd17e7))
* **api:** require complete run preparation facts ([#47955](https://github.com/okou-ai/okou/issues/47955)) ([b916d05](https://github.com/okou-ai/okou/commit/b916d05c76c4412d29b3dce3d9eb702dab89a29b))
* **api:** resolve data router token at firewall auth ([#48427](https://github.com/okou-ai/okou/issues/48427)) ([f63c8b6](https://github.com/okou-ai/okou/commit/f63c8b6ac4617ea3cbe93c61a38410ed2c33546e))
* **api:** resolve direct run mounts from member memory ([#48641](https://github.com/okou-ai/okou/issues/48641)) ([831b2cb](https://github.com/okou-ai/okou/commit/831b2cb7c1bbc8f25f0fb6fae2b3b6f044a51ba9))
* **api:** resolve managed model keys at firewall auth ([#48410](https://github.com/okou-ai/okou/issues/48410)) ([7b9fc81](https://github.com/okou-ai/okou/commit/7b9fc81233caa9800f895d3df38ea9f65bf69454))
* **api:** retire generic storage writeback ([#48673](https://github.com/okou-ai/okou/issues/48673)) ([a357e01](https://github.com/okou-ai/okou/commit/a357e018a228f4f2e3880015f9c4cc921c52b766))
* **api:** retire legacy reward campaign orchestration ([#48939](https://github.com/okou-ai/okou/issues/48939)) ([d1739be](https://github.com/okou-ai/okou/commit/d1739bed31dcde34fead64d82e54489fda10549f))
* **api:** retire marketing reward read callbacks ([#48553](https://github.com/okou-ai/okou/issues/48553)) ([0e0b6a9](https://github.com/okou-ai/okou/commit/0e0b6a982616cf1641df58b3412c3dc7b87331e2))
* **api:** reuse resolved skill mounts during dispatch ([#48883](https://github.com/okou-ai/okou/issues/48883)) ([1d13675](https://github.com/okou-ai/okou/commit/1d136754b73d395b3b1a587ee9a947e745a2b2b0))
* **api:** separate verified firewall and sandbox authority ([#48761](https://github.com/okou-ai/okou/issues/48761)) ([f642984](https://github.com/okou-ai/okou/commit/f64298411819eea46a8dc3ff7d570f3794f43214))
* **api:** share integration launch context reads ([#48944](https://github.com/okou-ai/okou/issues/48944)) ([62a8980](https://github.com/okou-ai/okou/commit/62a89800437cb0ebfd0ae87453ca5c9ec55eebed))
* **api:** share Teams launch context and delivery ([#48937](https://github.com/okou-ai/okou/issues/48937)) ([d972a61](https://github.com/okou-ai/okou/commit/d972a6163eca6ac35450d990345cfd33cc42ba82))
* **api:** simplify accepted run startup handoffs ([#48929](https://github.com/okou-ai/okou/issues/48929)) ([bd16ff2](https://github.com/okou-ai/okou/commit/bd16ff2d7f3cf7393147ba1fa9f86b614a25b503))
* **api:** unify marketing reward notifications ([#48668](https://github.com/okou-ai/okou/issues/48668)) ([20e7c48](https://github.com/okou-ai/okou/commit/20e7c4853f65e4cb6d6a841876a713e3a8870dfb))
* **api:** use three-point axiom artifact timing ([#48854](https://github.com/okou-ai/okou/issues/48854)) ([d930e21](https://github.com/okou-ai/okou/commit/d930e21f8d3d93278613fcef287ae7b58febdf72))
* **firewall:** retire legacy resolver and envelope compatibility ([#48739](https://github.com/okou-ai/okou/issues/48739)) ([7dcd7ca](https://github.com/okou-ai/okou/commit/7dcd7cac45f2b26e253703533fc7f1097609c0f6))
* **firewall:** separate host resolver authority from guest identity ([#48459](https://github.com/okou-ai/okou/issues/48459)) ([949de84](https://github.com/okou-ai/okou/commit/949de843f47dd8152058c7d7e2ca8a418305f0fc))
* **memory:** prepare member-owned persistence ([#47918](https://github.com/okou-ai/okou/issues/47918)) ([ae54ad4](https://github.com/okou-ai/okou/commit/ae54ad44b0650b497e9e272349498571c0235ba2))
* **memory:** retire legacy memory compatibility runtime ([#48363](https://github.com/okou-ai/okou/issues/48363)) ([7a30ea0](https://github.com/okou-ai/okou/commit/7a30ea0ee45da9dabdda7167d9c60e5b91496b7e))
* prepare structured run failures and recovery ([#47749](https://github.com/okou-ai/okou/issues/47749)) ([fca7335](https://github.com/okou-ai/okou/commit/fca73354c6b5b0aa4f122e78947565b274323991))
* remove chat action followups feature switch ([#47820](https://github.com/okou-ai/okou/issues/47820)) ([9b09da6](https://github.com/okou-ai/okou/commit/9b09da6d6de84b19146606ff34b81d9b0f0232c5))
* remove for you sources feature switch ([#48074](https://github.com/okou-ai/okou/issues/48074)) ([335f7b5](https://github.com/okou-ai/okou/commit/335f7b5c0410626867316382e92753d219e1e937))
* remove friend referrals feature switch ([#47818](https://github.com/okou-ai/okou/issues/47818)) ([adf9bb5](https://github.com/okou-ai/okou/commit/adf9bb562d3e568286b6ef682b43a2d5f0a3cefd))
* remove integration model recovery feature switch ([#47814](https://github.com/okou-ai/okou/issues/47814)) ([42f602a](https://github.com/okou-ai/okou/commit/42f602a3099b330cd59ef01fc389c43d3f067840))
* remove ssh chat approval feature switch ([#47815](https://github.com/okou-ai/okou/issues/47815)) ([d02807d](https://github.com/okou-ai/okou/commit/d02807db93eea5e76032aeb2eb0783de31b38014))
* **wallet:** remove saved-card expiry compatibility ([#48003](https://github.com/okou-ai/okou/issues/48003)) ([2fb6aae](https://github.com/okou-ai/okou/commit/2fb6aaeb8bfb812d596e578c5a4eabd718dedf24))


### Performance Improvements

* **api:** advance chat read cursors in one write ([#48932](https://github.com/okou-ai/okou/issues/48932)) ([39d40e3](https://github.com/okou-ai/okou/commit/39d40e3eaa0f20f87eaaeebd8df994d805ff3bcf))
* **api:** capture thread and fifo head in one pick query ([#48897](https://github.com/okou-ai/okou/issues/48897)) ([9c9183b](https://github.com/okou-ai/okou/commit/9c9183b4015b9c8b363e56fd68124ac972bb5baa))
* **api:** defer codex subscription recovery until authorization completes ([#48935](https://github.com/okou-ai/okou/issues/48935)) ([ee65216](https://github.com/okou-ai/okou/commit/ee6521690304375a8a97480de0a506386c987360))
* **api:** overlap bundle url cache reads with storage signing ([#48801](https://github.com/okou-ai/okou/issues/48801)) ([c732cf0](https://github.com/okou-ai/okou/commit/c732cf0bb6f00c5f2db1f9881c9f18ade1f48a4d))
* **api:** overlap package selection with runtime preparation ([#47997](https://github.com/okou-ai/okou/issues/47997)) ([ac83c22](https://github.com/okou-ai/okou/commit/ac83c220322c3342e117d4020899dcda56e466aa))
* **api:** prefetch chat attachment metadata once ([#48725](https://github.com/okou-ai/okou/issues/48725)) ([f688f4a](https://github.com/okou-ai/okou/commit/f688f4aa48b0d85c248529a701c82492b618a041))
* **api:** prefetch execution packages from picked sources ([#48743](https://github.com/okou-ai/okou/issues/48743)) ([ed12b4c](https://github.com/okou-ai/okou/commit/ed12b4c17134868df08762d0c64142a4c4eb9a8f))
* **api:** publish queued inputs from the picked snapshot ([#48845](https://github.com/okou-ai/okou/issues/48845)) ([c0c358f](https://github.com/okou-ai/okou/commit/c0c358ff8fd784fba0c86b3e4d7eebe7fda1f061))
* **api:** publish signed url cache outside runner delivery ([#47999](https://github.com/okou-ai/okou/issues/47999)) ([1977242](https://github.com/okou-ai/okou/commit/1977242528586fefd74eb8541bf1ff6b149473fc))
* **api:** remove execution-startup secret encryption ([#48677](https://github.com/okou-ai/okou/issues/48677)) ([ffad11e](https://github.com/okou-ai/okou/commit/ffad11eaaca4de2da2218225794d16f39c2b7796))
* **api:** remove redundant workflow reads from run startup ([#48693](https://github.com/okou-ai/okou/issues/48693)) ([d9e8999](https://github.com/okou-ai/okou/commit/d9e89992f9a754faccc7d2c88cd39da8ec970339))
* **api:** remove unused runtime preparation work ([#47775](https://github.com/okou-ai/okou/issues/47775)) ([61305ba](https://github.com/okou-ai/okou/commit/61305bacbf5293ab0e579eb104a5df183c7eef8d))
* **api:** retire debug-only run fields from application sql ([#48082](https://github.com/okou-ai/okou/issues/48082)) ([a40cf00](https://github.com/okou-ai/okou/commit/a40cf00d2f9e5c63fcb2dfa6ea68485b13be4f13))
* **api:** reuse accepted connector preparation ([#48634](https://github.com/okou-ai/okou/issues/48634)) ([2f150ac](https://github.com/okou-ai/okou/commit/2f150acc7c4f7b6861e101bebe82c2f5220d3cba))
* **api:** reuse accepted execution package sources ([#48671](https://github.com/okou-ai/okou/issues/48671)) ([23abb62](https://github.com/okou-ai/okou/commit/23abb6281382fed7c525e61da173c7619fbee81a))
* **api:** reuse accepted memory metadata in direct dispatch ([#48735](https://github.com/okou-ai/okou/issues/48735)) ([c3ceff1](https://github.com/okou-ai/okou/commit/c3ceff1935ba73b29a0b6962ceb69562295f3802))
* **api:** reuse accepted template contributions ([#48470](https://github.com/okou-ai/okou/issues/48470)) ([9c0a027](https://github.com/okou-ai/okou/commit/9c0a027fbdbf74fd130e2758bb0894cfd5a827ed))
* **api:** reuse admitted timezone and seed skill contributions ([#48425](https://github.com/okou-ai/okou/issues/48425)) ([ecd1e72](https://github.com/okou-ai/okou/commit/ecd1e722ba816f9a046be353035ab1bb6df227fb))
* **api:** reuse browser health connections within bounded sweeps ([#48474](https://github.com/okou-ai/okou/issues/48474)) ([5110f7e](https://github.com/okou-ai/okou/commit/5110f7ef309c5df996cb35b517bdaf89f2a2d887))
* **api:** reuse custom connector runtime builds and narrow execution fields ([#47828](https://github.com/okou-ai/okou/issues/47828)) ([d728e34](https://github.com/okou-ai/okou/commit/d728e349bddd5c4f5e991a7c9403034a4067d8fa))
* **api:** reuse resolved pi config during run startup ([#48752](https://github.com/okou-ai/okou/issues/48752)) ([c4acfaa](https://github.com/okou-ai/okou/commit/c4acfaaf5f34d3df2dd4d1bf72fbd46f70170d4d))
* **api:** reuse the first accepted model source ([#48568](https://github.com/okou-ai/okou/issues/48568)) ([e0a42f9](https://github.com/okou-ai/okou/commit/e0a42f9498c18331db0a718b2539696079cfb1e4))
* **api:** reuse the picked input when rejecting a chat queue head ([#48873](https://github.com/okou-ai/okou/issues/48873)) ([6a663c9](https://github.com/okou-ai/okou/commit/6a663c942ad3ce0aa2726c65962880b68b875f0e))
* **api:** reuse verified attachment metadata before run startup ([#48060](https://github.com/okou-ai/okou/issues/48060)) ([7d07058](https://github.com/okou-ai/okou/commit/7d07058516fdda719b73804a2cc108613e6492d2))
* **api:** skip unused conditional run preparation reads ([#47919](https://github.com/okou-ai/okou/issues/47919)) ([2e87907](https://github.com/okou-ai/okou/commit/2e879078228fab6f73ace6cd935056aa85a3af62))
* **api:** start input prefetch from minimum dependencies ([#48266](https://github.com/okou-ai/okou/issues/48266)) ([cf2e300](https://github.com/okou-ai/okou/commit/cf2e3002da39bba2419fb7811e60323baea66458))
* **api:** trim redundant run preparation projections ([#47903](https://github.com/okou-ai/okou/issues/47903)) ([75554a2](https://github.com/okou-ai/okou/commit/75554a2485cb2a0a4ebab9935be1d211db2610f5))
* **api:** trim run preparation credential and template projections ([#47886](https://github.com/okou-ai/okou/issues/47886)) ([7daca56](https://github.com/okou-ai/okou/commit/7daca560b2b79e6d1722b9b599fa715c4d71764d))
* **runner:** attribute archive staging writes ([#48338](https://github.com/okou-ai/okou/issues/48338)) ([1aeffbc](https://github.com/okou-ai/okou/commit/1aeffbc8c757415acb407157dba177305ed1b210))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 2.91.0
    * @okouai/core bumped to 8.855.0
    * @okouai/db bumped to 2.52.0
    * @okouai/pi-agent-runtime bumped to 1.53.0
</details>

<details><summary>runner-rs: 0.249.62</summary>

## [0.249.62](https://github.com/okou-ai/okou/compare/runner-rs-v0.249.61...runner-rs-v0.249.62) (2026-11-19)


### Bug Fixes

* **python:** retire eagerly completed firewall auth fetches ([#47901](https://github.com/okou-ai/okou/issues/47901)) ([1f7235a](https://github.com/okou-ai/okou/commit/1f7235ad5981a9e5f225a761fbe7852d8a9d181b))
* **runner:** finish response inspection before native connection close ([#48224](https://github.com/okou-ai/okou/issues/48224)) ([ef207eb](https://github.com/okou-ai/okou/commit/ef207eba3382b061c414d118a0cf81b293a9e9af))
* **subagent:** flatten run ownership and compact streaming logs ([#48558](https://github.com/okou-ai/okou/issues/48558)) ([66b812c](https://github.com/okou-ai/okou/commit/66b812c94ae58b4d8a75aa26a5c4f3f90a1ebd40))


### Documentation

* align runner descriptions with direct execution ([#48085](https://github.com/okou-ai/okou/issues/48085)) ([f3707aa](https://github.com/okou-ai/okou/commit/f3707aa037153905e98bfaa81d62db0b7feaa934))


### Refactoring

* **firewall:** retire legacy resolver and envelope compatibility ([#48739](https://github.com/okou-ai/okou/issues/48739)) ([7dcd7ca](https://github.com/okou-ai/okou/commit/7dcd7cac45f2b26e253703533fc7f1097609c0f6))
* **firewall:** separate host resolver authority from guest identity ([#48459](https://github.com/okou-ai/okou/issues/48459)) ([949de84](https://github.com/okou-ai/okou/commit/949de843f47dd8152058c7d7e2ca8a418305f0fc))
* **python:** centralize http network log publication ([#48418](https://github.com/okou-ai/okou/issues/48418)) ([5f3a362](https://github.com/okou-ai/okou/commit/5f3a36229fe7175964b75e9c1e3964be3cb432c8))
* **python:** centralize logged string metadata reads ([#48432](https://github.com/okou-ai/okou/issues/48432)) ([640143e](https://github.com/okou-ai/okou/commit/640143ed18ba665013b5f283308229d45ccbc953))
* **python:** centralize original-inode stat metadata projection ([#48453](https://github.com/okou-ai/okou/issues/48453)) ([186c689](https://github.com/okou-ai/okou/commit/186c6897ba8c87d930b1bf4cd14a1d8b819355c9))
* **python:** centralize request-time response encoding policy ([#48233](https://github.com/okou-ai/okou/issues/48233)) ([b28c01f](https://github.com/okou-ai/okou/commit/b28c01f1b3b09086f5c27cd5bba90d817c1a69a9))
* **python:** centralize response auth recovery ([#48339](https://github.com/okou-ai/okou/issues/48339)) ([977d3c5](https://github.com/okou-ai/okou/commit/977d3c553b448c0e4af284bb81910363e7915059))
* **python:** centralize symbolic path segment encoding ([#48441](https://github.com/okou-ai/okou/issues/48441)) ([ae62349](https://github.com/okou-ai/okou/commit/ae6234943088eea66e3105a3d203683c334851ec))
* **python:** give streamed body capture one state owner ([#48215](https://github.com/okou-ai/okou/issues/48215)) ([135a178](https://github.com/okou-ai/okou/commit/135a178e3ad4fa1893dd4764fb7b712df2c6cdc4))
* **python:** guard thread-pool bootstrap release before publication ([#47972](https://github.com/okou-ai/okou/issues/47972)) ([2cb765b](https://github.com/okou-ai/okou/commit/2cb765b07a978dfc1c9f6a443414c4bb6028c0d7))
* **python:** keep diagnostic auth hints in the typed candidate ([#48358](https://github.com/okou-ai/okou/issues/48358)) ([14efdab](https://github.com/okou-ai/okou/commit/14efdab6b01626879c3ae5483f72536f0685a48b))
* **python:** own connector diagnostic response streaming state ([#48057](https://github.com/okou-ai/okou/issues/48057)) ([3198f21](https://github.com/okou-ai/okou/commit/3198f2155caf11b154f9544cc198d0b7eb11b8c8))
* **python:** retain canonical captured connector intent ([#48131](https://github.com/okou-ai/okou/issues/48131)) ([31495dd](https://github.com/okou-ai/okou/commit/31495dd2fd8fb265cf53f8e19cf4d9c7a9cad5b6))
* **python:** unify metadata match pattern analysis ([#48788](https://github.com/okou-ai/okou/issues/48788)) ([2787e00](https://github.com/okou-ai/okou/commit/2787e00171be56c603d19b3412af022d84e91ce0))
* **runner:** centralize exact native receipt comparison ([#48945](https://github.com/okou-ai/okou/issues/48945)) ([cadf499](https://github.com/okou-ai/okou/commit/cadf4997761a1699b926df059d876cb9cca13b43))
* **runner:** centralize native pressure policy shape validation ([#48742](https://github.com/okou-ai/okou/issues/48742)) ([6de7061](https://github.com/okou-ai/okou/commit/6de7061ded8a72209a0edb56a324f4d4f5cd9423))
* **runner:** keep buffered response start with its inspector ([#48663](https://github.com/okou-ai/okou/issues/48663)) ([38a5680](https://github.com/okou-ai/okou/commit/38a5680d8d15ed7d2fdbdec6889be558883adc3f))
* **runner:** keep interruption reporting with the connector finalizer ([#48675](https://github.com/okou-ai/okou/issues/48675)) ([16c80f1](https://github.com/okou-ai/okou/commit/16c80f1f3ae26087444ad8f39da77b42b115d1ee))
* **runner:** separate shared platform http transport from firewall auth ([#48769](https://github.com/okou-ai/okou/issues/48769)) ([83a3416](https://github.com/okou-ai/okou/commit/83a3416344f874b5968541c37c769378a8f0efe8))
* **runner:** share bounded compressed input traversal ([#48555](https://github.com/okou-ai/okou/issues/48555)) ([c07773e](https://github.com/okou-ai/okou/commit/c07773eb16b278eff9896dd560b2e3ad11843305))
* **runner:** share canonical uuid checks in native reports ([#48779](https://github.com/okou-ai/okou/issues/48779)) ([447d84d](https://github.com/okou-ai/okou/commit/447d84dc01de62b238b698e77b2470bafd60b663))
* **runner:** share guarded idle phase clock validation ([#48875](https://github.com/okou-ai/okou/issues/48875)) ([9948ab1](https://github.com/okou-ai/okou/commit/9948ab169373f95aae48250130f5dbc0ff01aa95))
* **runner:** share original evidence stream ownership ([#48727](https://github.com/okou-ai/okou/issues/48727)) ([280030d](https://github.com/okou-ai/okou/commit/280030d05d8ea88752d6eefac4bc41664c1284e5))
* **runner:** share original pressure policy decoding ([#48799](https://github.com/okou-ai/okou/issues/48799)) ([6beacab](https://github.com/okou-ai/okou/commit/6beacab3dc8adf04400c38f9eaeb2dfbb3f52d34))
* **runner:** share the bounded snapshot evidence reader ([#48695](https://github.com/okou-ai/okou/issues/48695)) ([3851f07](https://github.com/okou-ai/okou/commit/3851f07037bd46cb7ab0bf98f8726048d3666168))
* use typed fallible native clock queries ([#48072](https://github.com/okou-ai/okou/issues/48072)) ([4b16d0b](https://github.com/okou-ai/okou/commit/4b16d0b56361a1f955133d6a161ff21eb8083394))


### Performance Improvements

* **runner:** pool python auth connections and retire reset generations ([#48526](https://github.com/okou-ai/okou/issues/48526)) ([e269355](https://github.com/okou-ai/okou/commit/e269355d7d6dc8bd36b133de434420a1626ff9ce))

### Release Dependencies

* Release of `turbo/apps/cli`
</details>

---
This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).