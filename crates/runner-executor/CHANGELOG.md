# Changelog

## [0.15.1](https://github.com/okou-ai/okou/compare/runner-executor-v0.15.0...runner-executor-v0.15.1) (2026-10-21)

## [0.15.0](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.22...runner-executor-v0.15.0) (2026-10-20)


### Features

* **runner:** track resource producers and prepare source matching ([#41900](https://github.com/okou-ai/okou/issues/41900)) ([f762cad](https://github.com/okou-ai/okou/commit/f762cada760922b815c9ad6d32012be39c5a3c08))

## [0.14.22](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.21...runner-executor-v0.14.22) (2026-10-20)


### Refactoring

* retire agent instruction storage ([#41860](https://github.com/okou-ai/okou/issues/41860)) ([b4a90a6](https://github.com/okou-ai/okou/commit/b4a90a6b3f79527f91836df6a2bcc8fe81c622e8))

## [0.14.21](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.20...runner-executor-v0.14.21) (2026-10-20)


### Refactoring

* retire sandbox file debugging stack ([#41808](https://github.com/okou-ai/okou/issues/41808)) ([430cb92](https://github.com/okou-ai/okou/commit/430cb92b5431e1554d0a1dceed6d9cfb27762921))

## [0.14.20](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.19...runner-executor-v0.14.20) (2026-10-20)

## [0.14.19](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.18...runner-executor-v0.14.19) (2026-10-20)

## [0.14.18](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.17...runner-executor-v0.14.18) (2026-10-20)

## [0.14.17](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.16...runner-executor-v0.14.17) (2026-10-20)


### Bug Fixes

* **runner:** attribute nested codex child oom kills ([#41641](https://github.com/okou-ai/okou/issues/41641)) ([ff587f5](https://github.com/okou-ai/okou/commit/ff587f591fbf75370f90ab510b7e1dea03a16df0))

## [0.14.16](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.15...runner-executor-v0.14.16) (2026-10-19)


### Refactoring

* prepare database-backed agent instructions ([#41393](https://github.com/okou-ai/okou/issues/41393)) ([da0dc9c](https://github.com/okou-ai/okou/commit/da0dc9cd1b21ecdd91200fb1cad8600ee5fdfd29))

## [0.14.15](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.14...runner-executor-v0.14.15) (2026-10-19)


### Refactoring

* **runner-executor:** share pre-spawn cancellation reporting ([#41401](https://github.com/okou-ai/okou/issues/41401)) ([9774313](https://github.com/okou-ai/okou/commit/97743130583b526f819a02ba0390a49b469a7a23))

## [0.14.14](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.13...runner-executor-v0.14.14) (2026-10-19)

## [0.14.13](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.12...runner-executor-v0.14.13) (2026-10-19)

## [0.14.12](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.11...runner-executor-v0.14.12) (2026-10-19)


### Bug Fixes

* **runner:** preserve codex subscription reconnect outcomes ([#41201](https://github.com/okou-ai/okou/issues/41201)) ([f359e10](https://github.com/okou-ai/okou/commit/f359e10a52ad666904a28c2c0641fba175a22631))

## [0.14.11](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.10...runner-executor-v0.14.11) (2026-10-19)

## [0.14.10](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.9...runner-executor-v0.14.10) (2026-10-19)

## [0.14.9](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.8...runner-executor-v0.14.9) (2026-10-19)


### Refactoring

* **runner-executor:** converge fallback storage failure cleanup ([#41065](https://github.com/okou-ai/okou/issues/41065)) ([7866dd8](https://github.com/okou-ai/okou/commit/7866dd85f436bdadd3c2563b823415eeaf139a40))
* **runner-executor:** converge fresh post-start failure cleanup ([#41033](https://github.com/okou-ai/okou/issues/41033)) ([ba50bf6](https://github.com/okou-ai/okou/commit/ba50bf63c4588d1a44bb11b32b27ef0ce1b7dfdb))

## [0.14.8](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.7...runner-executor-v0.14.8) (2026-10-17)

## [0.14.7](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.6...runner-executor-v0.14.7) (2026-10-17)


### Bug Fixes

* **runner:** enforce captured openrouter presets before auth ([#40884](https://github.com/okou-ai/okou/issues/40884)) ([1d2a780](https://github.com/okou-ai/okou/commit/1d2a780d35d7a8b2b5ceab760321470d8e06c489))

## [0.14.6](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.5...runner-executor-v0.14.6) (2026-10-17)

## [0.14.5](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.4...runner-executor-v0.14.5) (2026-10-17)


### Refactoring

* **runner-executor:** own stdout drain stop lifetime ([#40837](https://github.com/okou-ai/okou/issues/40837)) ([6bb408e](https://github.com/okou-ai/okou/commit/6bb408e346532034320fe4e37f98ed776d6bcff2))

## [0.14.4](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.3...runner-executor-v0.14.4) (2026-10-17)


### Refactoring

* remove expired deployment compatibility ([#40811](https://github.com/okou-ai/okou/issues/40811)) ([b53e5a5](https://github.com/okou-ai/okou/commit/b53e5a5fc6437b2b15412d21a42d90344c18191f))
* **runner-executor:** retain active-input task custody ([#40821](https://github.com/okou-ai/okou/issues/40821)) ([f612914](https://github.com/okou-ai/okou/commit/f6129144ffb614fde97a27fcd0db9620ac3700f1))

## [0.14.3](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.2...runner-executor-v0.14.3) (2026-10-16)

## [0.14.2](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.1...runner-executor-v0.14.2) (2026-10-16)

## [0.14.1](https://github.com/okou-ai/okou/compare/runner-executor-v0.14.0...runner-executor-v0.14.1) (2026-10-16)

## [0.14.0](https://github.com/okou-ai/okou/compare/runner-executor-v0.13.12...runner-executor-v0.14.0) (2026-10-16)


### Features

* **remote:** explain vnc failures with retained source evidence ([#40669](https://github.com/okou-ai/okou/issues/40669)) ([07b1a90](https://github.com/okou-ai/okou/commit/07b1a902af74b7a3ebde6434b86e4efb35b1de7e))

## [0.13.12](https://github.com/okou-ai/okou/compare/runner-executor-v0.13.11...runner-executor-v0.13.12) (2026-10-16)


### Refactoring

* **runner-executor:** share executor start telemetry initialization ([#40613](https://github.com/okou-ai/okou/issues/40613)) ([5f98eac](https://github.com/okou-ai/okou/commit/5f98eac805c2e74d2f3c5c69787a11f62ea16ecf))

## [0.13.11](https://github.com/okou-ai/okou/compare/runner-executor-v0.13.10...runner-executor-v0.13.11) (2026-10-16)

## [0.13.10](https://github.com/okou-ai/okou/compare/runner-executor-v0.13.9...runner-executor-v0.13.10) (2026-10-16)


### Refactoring

* **runner-executor:** pair codex prefetch process custody ([#40562](https://github.com/okou-ai/okou/issues/40562)) ([c2d2847](https://github.com/okou-ai/okou/commit/c2d2847f99c7b8427b2df5b66fd61a7debb0dffd))

## [0.13.9](https://github.com/okou-ai/okou/compare/runner-executor-v0.13.8...runner-executor-v0.13.9) (2026-10-16)


### Refactoring

* retire session history archive protocol ([#40528](https://github.com/okou-ai/okou/issues/40528)) ([1e9a4cf](https://github.com/okou-ai/okou/commit/1e9a4cf4fa6fb43dad8fad1caedc480df0ef7a41))

## [0.13.8](https://github.com/okou-ai/okou/compare/runner-executor-v0.13.7...runner-executor-v0.13.8) (2026-10-16)


### Bug Fixes

* **runner:** preserve unused home cache until seed handoff ([#40467](https://github.com/okou-ai/okou/issues/40467)) ([3af329d](https://github.com/okou-ai/okou/commit/3af329d2001560a53ec2525e6c4cc9e9c375c6ae))

## [0.13.7](https://github.com/okou-ai/okou/compare/runner-executor-v0.13.6...runner-executor-v0.13.7) (2026-10-15)

## [0.13.6](https://github.com/okou-ai/okou/compare/runner-executor-v0.13.5...runner-executor-v0.13.6) (2026-10-15)

## [0.13.5](https://github.com/okou-ai/okou/compare/runner-executor-v0.13.4...runner-executor-v0.13.5) (2026-10-15)

## [0.13.4](https://github.com/okou-ai/okou/compare/runner-executor-v0.13.3...runner-executor-v0.13.4) (2026-10-15)

## [0.13.3](https://github.com/okou-ai/okou/compare/runner-executor-v0.13.2...runner-executor-v0.13.3) (2026-10-15)


### Refactoring

* **pi:** always use the runner-bundled cli ([#40232](https://github.com/okou-ai/okou/issues/40232)) ([dfff160](https://github.com/okou-ai/okou/commit/dfff1605013103371cd90962ee5b54c80fc93140))

## [0.13.2](https://github.com/okou-ai/okou/compare/runner-executor-v0.13.1...runner-executor-v0.13.2) (2026-10-15)


### Documentation

* **rust:** correct completion reuse metadata documentation ([#40278](https://github.com/okou-ai/okou/issues/40278)) ([2534320](https://github.com/okou-ai/okou/commit/25343206017d857cb6dc473d15f7a0be3ec48a61))


### Refactoring

* **remote:** share assignment-owned native network resources ([#40243](https://github.com/okou-ai/okou/issues/40243)) ([4cbbd49](https://github.com/okou-ai/okou/commit/4cbbd4991faf6a1771c2f4cab6e187cc3e544e17))
* **runner:** consolidate home reuse observations ([#40207](https://github.com/okou-ai/okou/issues/40207)) ([2511826](https://github.com/okou-ai/okou/commit/25118260fc61ef6317a98dda0194b0fb9a11f5fa))

## [0.13.1](https://github.com/okou-ai/okou/compare/runner-executor-v0.13.0...runner-executor-v0.13.1) (2026-10-15)

## [0.13.0](https://github.com/okou-ai/okou/compare/runner-executor-v0.12.0...runner-executor-v0.13.0) (2026-10-15)


### Features

* **runner:** record cache routing and inventory outcomes ([#40171](https://github.com/okou-ai/okou/issues/40171)) ([8d94f8f](https://github.com/okou-ai/okou/commit/8d94f8f0b601173b3fe6cb5431f48cb916959226))

## [0.12.0](https://github.com/okou-ai/okou/compare/runner-executor-v0.11.0...runner-executor-v0.12.0) (2026-10-15)


### Features

* continue threads through retained native sandbox history ([#40048](https://github.com/okou-ai/okou/issues/40048)) ([2b6ff73](https://github.com/okou-ai/okou/commit/2b6ff735fcfb0d4f5baf5fd131bcc10ae8a325d3))
* **runner:** record first-run context and actual home reuse ([#39955](https://github.com/okou-ai/okou/issues/39955)) ([f0577eb](https://github.com/okou-ai/okou/commit/f0577ebc54bdb82e28c225184a7a084080054afd))
* **runner:** record home outcomes through sandbox operations ([#40086](https://github.com/okou-ai/okou/issues/40086)) ([4118750](https://github.com/okou-ai/okou/commit/4118750fb48f30654288719da44c30ae8dc08a68))


### Bug Fixes

* **runner:** align task oom priority and correct runtime attribution ([#40068](https://github.com/okou-ai/okou/issues/40068)) ([b94851a](https://github.com/okou-ai/okou/commit/b94851a584b74d0edfbd53e46576cb66ff753c64))


### Refactoring

* retire legacy run reuse outcome metadata ([#40102](https://github.com/okou-ai/okou/issues/40102)) ([005af49](https://github.com/okou-ai/okou/commit/005af4965ced3ca60293140d6ede62ec5acaeaeb))

## [0.11.0](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.23...runner-executor-v0.11.0) (2026-10-14)


### Features

* persist sandbox startup path on agent runs ([#39972](https://github.com/okou-ai/okou/issues/39972)) ([db59569](https://github.com/okou-ai/okou/commit/db595699439f7f221fb5df8b9eba14a9a4faac73))

## [0.10.23](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.22...runner-executor-v0.10.23) (2026-10-14)

## [0.10.22](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.21...runner-executor-v0.10.22) (2026-10-14)


### Refactoring

* **rust:** share raw http fixtures across runner domains ([#40010](https://github.com/okou-ai/okou/issues/40010)) ([bc8950d](https://github.com/okou-ai/okou/commit/bc8950d2cb9217419e0fce358dccf2d028b25076))

## [0.10.21](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.20...runner-executor-v0.10.21) (2026-10-14)

## [0.10.20](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.19...runner-executor-v0.10.20) (2026-10-14)


### Bug Fixes

* **runner:** attribute guest-control closure after cancellation ([#39958](https://github.com/okou-ai/okou/issues/39958)) ([dfe813b](https://github.com/okou-ai/okou/commit/dfe813bc829a208cb75225488173fac39e0ac0a7))

## [0.10.19](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.18...runner-executor-v0.10.19) (2026-10-14)

## [0.10.18](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.17...runner-executor-v0.10.18) (2026-10-14)

## [0.10.17](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.16...runner-executor-v0.10.17) (2026-10-14)


### Bug Fixes

* **runner:** distinguish blank and cold sandbox startup ([#39847](https://github.com/okou-ai/okou/issues/39847)) ([03a34c1](https://github.com/okou-ai/okou/commit/03a34c1f15dc5f0d807658b7687ad300bbfe90ec))

## [0.10.16](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.15...runner-executor-v0.10.16) (2026-10-14)

## [0.10.15](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.14...runner-executor-v0.10.15) (2026-10-13)

## [0.10.14](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.13...runner-executor-v0.10.14) (2026-10-13)

## [0.10.13](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.12...runner-executor-v0.10.13) (2026-10-13)

## [0.10.12](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.11...runner-executor-v0.10.12) (2026-10-13)

## [0.10.11](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.10...runner-executor-v0.10.11) (2026-10-13)


### Refactoring

* finish retired checkpoint terminology cleanup ([#39682](https://github.com/okou-ai/okou/issues/39682)) ([c45c269](https://github.com/okou-ai/okou/commit/c45c2697daeb0c4dc825fbce66fcc89d888471ed))


### Performance Improvements

* **runner:** keep home cache checkout responsive under disk pressure ([#39686](https://github.com/okou-ai/okou/issues/39686)) ([fd23875](https://github.com/okou-ai/okou/commit/fd23875657a8480aa01b7bd6af22da60d5d7a26d))

## [0.10.10](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.9...runner-executor-v0.10.10) (2026-10-13)

## [0.10.9](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.8...runner-executor-v0.10.9) (2026-10-13)

## [0.10.8](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.7...runner-executor-v0.10.8) (2026-10-13)

## [0.10.7](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.6...runner-executor-v0.10.7) (2026-10-12)


### Performance Improvements

* **runner:** address home caches independently of rootfs ([#39421](https://github.com/okou-ai/okou/issues/39421)) ([01c57b8](https://github.com/okou-ai/okou/commit/01c57b82a8fd464599460502ae2fd012909792e9))

## [0.10.6](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.5...runner-executor-v0.10.6) (2026-10-12)


### Refactoring

* **runner-executor:** converge terminal agent-preparation cleanup ([#39405](https://github.com/okou-ai/okou/issues/39405)) ([9c04a88](https://github.com/okou-ai/okou/commit/9c04a88a8b6d2b5001ab762ad06623b468ffbdf6))

## [0.10.5](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.4...runner-executor-v0.10.5) (2026-10-12)


### Performance Improvements

* **runner:** restore sessions from verified zstd sources ([#39335](https://github.com/okou-ai/okou/issues/39335)) ([42f118d](https://github.com/okou-ai/okou/commit/42f118dd2aa86e9d22a732a67d9f46a053ca32e8))

## [0.10.4](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.3...runner-executor-v0.10.4) (2026-10-12)


### Performance Improvements

* **runner:** attribute host-side storage apply phases ([#39232](https://github.com/okou-ai/okou/issues/39232)) ([87699ec](https://github.com/okou-ai/okou/commit/87699ec74930a925c53aa653b48cc78ab63e634e))

## [0.10.3](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.2...runner-executor-v0.10.3) (2026-10-12)

## [0.10.2](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.1...runner-executor-v0.10.2) (2026-10-12)

## [0.10.1](https://github.com/okou-ai/okou/compare/runner-executor-v0.10.0...runner-executor-v0.10.1) (2026-10-12)


### Bug Fixes

* accept home startup telemetry and attribute rejections ([#39175](https://github.com/okou-ai/okou/issues/39175)) ([acda46d](https://github.com/okou-ai/okou/commit/acda46d74a3bd83fba38e0671cfd606f85ab8401))

## [0.10.0](https://github.com/okou-ai/okou/compare/runner-executor-v0.9.1...runner-executor-v0.10.0) (2026-10-12)


### Features

* **ssh:** integrate native tailscale saved-host transport ([#39018](https://github.com/okou-ai/okou/issues/39018)) ([e8f8c83](https://github.com/okou-ai/okou/commit/e8f8c83186b0d6881c546048b7198f6dd2d96181))


### Refactoring

* **runner-executor:** converge pre-spawn exit cleanup ([#39083](https://github.com/okou-ai/okou/issues/39083)) ([a877797](https://github.com/okou-ai/okou/commit/a877797d84fe928b7314ee2dda31ec94c35084ec))
* **runner:** retire workspace protocol and application sql ([#38837](https://github.com/okou-ai/okou/issues/38837)) ([a932f1f](https://github.com/okou-ai/okou/commit/a932f1f86ae10eb624fa3ff3bccc851ba4809a7e))

## [0.9.1](https://github.com/okou-ai/okou/compare/runner-executor-v0.9.0...runner-executor-v0.9.1) (2026-10-11)

## [0.9.0](https://github.com/okou-ai/okou/compare/runner-executor-v0.8.2...runner-executor-v0.9.0) (2026-10-11)


### Features

* **runner:** complete home cache disk visibility ([#38775](https://github.com/okou-ai/okou/issues/38775)) ([30c5539](https://github.com/okou-ai/okou/commit/30c5539999b0a90dfb693f0cc92c2cd29e6882d2))


### Bug Fixes

* remove retired connector references from app and tests ([#38802](https://github.com/okou-ai/okou/issues/38802)) ([63a43d9](https://github.com/okou-ai/okou/commit/63a43d9219560c0dfe29048b023c7910417a9c50))


### Performance Improvements

* **ci:** exclude audited test modules from runner binary inputs ([#38755](https://github.com/okou-ai/okou/issues/38755)) ([6ca9649](https://github.com/okou-ai/okou/commit/6ca96493c23cbe8d983a0bab2d237900258f57b0))

## [0.8.2](https://github.com/okou-ai/okou/compare/runner-executor-v0.8.1...runner-executor-v0.8.2) (2026-10-10)


### Refactoring

* name native history and pi memory publications explicitly ([#38679](https://github.com/okou-ai/okou/issues/38679)) ([e5b1d4e](https://github.com/okou-ai/okou/commit/e5b1d4ed7bd2f8b54e01352e762e1f9eec5c3a39))
* **runner-storage:** centralize bounded object-download retry scheduling ([#38730](https://github.com/okou-ai/okou/issues/38730)) ([1e78c25](https://github.com/okou-ai/okou/commit/1e78c25bde7f27f07c062f28021f8e656d4dfebb))

## [0.8.1](https://github.com/okou-ai/okou/compare/runner-executor-v0.8.0...runner-executor-v0.8.1) (2026-10-10)

## [0.8.0](https://github.com/okou-ai/okou/compare/runner-executor-v0.7.4...runner-executor-v0.8.0) (2026-10-10)


### Features

* **runner:** retain home images with verified history ([#38498](https://github.com/okou-ai/okou/issues/38498)) ([8b100e4](https://github.com/okou-ai/okou/commit/8b100e433e5933242c418dbfe1c1f3efd15a9b87))


### Bug Fixes

* **runner:** bound active-input shutdown under guest backpressure ([#38591](https://github.com/okou-ai/okou/issues/38591)) ([648671b](https://github.com/okou-ai/okou/commit/648671bd07f959e25864029a81dbab13edef83c7))

## [0.7.4](https://github.com/okou-ai/okou/compare/runner-executor-v0.7.3...runner-executor-v0.7.4) (2026-10-10)

## [0.7.3](https://github.com/okou-ai/okou/compare/runner-executor-v0.7.2...runner-executor-v0.7.3) (2026-10-10)

## [0.7.2](https://github.com/okou-ai/okou/compare/runner-executor-v0.7.1...runner-executor-v0.7.2) (2026-10-10)


### Refactoring

* **pi:** retire unversioned model config execution ([#38449](https://github.com/okou-ai/okou/issues/38449)) ([c628473](https://github.com/okou-ai/okou/commit/c62847319cb3ebbd41259d662f47905a1cb39863))


### Performance Improvements

* **test:** avoid rebuilding owned fixture buffers ([#38450](https://github.com/okou-ai/okou/issues/38450)) ([f5ad1ba](https://github.com/okou-ai/okou/commit/f5ad1ba1e2b4d6745ed80c869bf4fb9b222cfafc))

## [0.7.1](https://github.com/okou-ai/okou/compare/runner-executor-v0.7.0...runner-executor-v0.7.1) (2026-10-09)

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

## [0.6.3](https://github.com/okou-ai/okou/compare/runner-executor-v0.6.2...runner-executor-v0.6.3) (2026-10-09)

## [0.6.2](https://github.com/okou-ai/okou/compare/runner-executor-v0.6.1...runner-executor-v0.6.2) (2026-10-09)

## [0.6.1](https://github.com/okou-ai/okou/compare/runner-executor-v0.6.0...runner-executor-v0.6.1) (2026-10-09)


### Bug Fixes

* **runner:** reconcile retained state and scrub terminal private files ([#38153](https://github.com/okou-ai/okou/issues/38153)) ([9824493](https://github.com/okou-ai/okou/commit/9824493f88b89ad219b243438d635e6cd085514b))

## [0.6.0](https://github.com/okou-ai/okou/compare/runner-executor-v0.5.7...runner-executor-v0.6.0) (2026-10-09)


### Features

* prepare model identity compatibility without switching writes ([#38092](https://github.com/okou-ai/okou/issues/38092)) ([21177df](https://github.com/okou-ai/okou/commit/21177dfd37bc19114098a628a094adb67fb60db0))

## [0.5.7](https://github.com/okou-ai/okou/compare/runner-executor-v0.5.6...runner-executor-v0.5.7) (2026-10-08)

## [0.5.6](https://github.com/okou-ai/okou/compare/runner-executor-v0.5.5...runner-executor-v0.5.6) (2026-10-08)


### Bug Fixes

* **guest-storage-apply:** fail run preparation on injection errors ([#38070](https://github.com/okou-ai/okou/issues/38070)) ([496599f](https://github.com/okou-ai/okou/commit/496599f7faf42b8c0ae425c7af3eea457a571fd0))

## [0.5.5](https://github.com/okou-ai/okou/compare/runner-executor-v0.5.4...runner-executor-v0.5.5) (2026-10-08)


### Refactoring

* assemble current run inputs without agent configuration ([#38004](https://github.com/okou-ai/okou/issues/38004)) ([22efd4b](https://github.com/okou-ai/okou/commit/22efd4b6b34872c0585a0d4c3778cb3b59d9d100))

## [0.5.4](https://github.com/okou-ai/okou/compare/runner-executor-v0.5.3...runner-executor-v0.5.4) (2026-10-08)

## [0.5.3](https://github.com/okou-ai/okou/compare/runner-executor-v0.5.2...runner-executor-v0.5.3) (2026-10-07)


### Refactoring

* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))

## [0.5.2](https://github.com/okou-ai/okou/compare/runner-executor-v0.5.1...runner-executor-v0.5.2) (2026-10-07)


### Refactoring

* remove remaining model provider residue ([#37870](https://github.com/okou-ai/okou/issues/37870)) ([a93133b](https://github.com/okou-ai/okou/commit/a93133b0493858a39924a1206ff5a5677e43cad6))

## [0.5.1](https://github.com/okou-ai/okou/compare/runner-executor-v0.5.0...runner-executor-v0.5.1) (2026-10-07)


### Refactoring

* remove all remaining custom model mode awareness ([#37856](https://github.com/okou-ai/okou/issues/37856)) ([f383835](https://github.com/okou-ai/okou/commit/f3838353ba0455ec7d57dfa2d0974e34a44796ff))

## [0.5.0](https://github.com/okou-ai/okou/compare/runner-executor-v0.4.10...runner-executor-v0.5.0) (2026-10-04)


### Features

* **observability:** log r2 keys only in runner-local info ([#37687](https://github.com/okou-ai/okou/issues/37687)) ([193f547](https://github.com/okou-ai/okou/commit/193f5472860eab1725897d976f25f6b70f3cb1c4))

## [0.4.10](https://github.com/okou-ai/okou/compare/runner-executor-v0.4.9...runner-executor-v0.4.10) (2026-10-03)

## [0.4.9](https://github.com/okou-ai/okou/compare/runner-executor-v0.4.8...runner-executor-v0.4.9) (2026-10-03)

## [0.4.8](https://github.com/okou-ai/okou/compare/runner-executor-v0.4.7...runner-executor-v0.4.8) (2026-10-02)


### Bug Fixes

* **runner-storage:** retry transient archive download failures ([#37557](https://github.com/okou-ai/okou/issues/37557)) ([353e71f](https://github.com/okou-ai/okou/commit/353e71fd9f0c29bbc7718382d49f40f62484e05b))

## [0.4.7](https://github.com/okou-ai/okou/compare/runner-executor-v0.4.6...runner-executor-v0.4.7) (2026-10-02)

## [0.4.6](https://github.com/okou-ai/okou/compare/runner-executor-v0.4.5...runner-executor-v0.4.6) (2026-10-01)


### Bug Fixes

* **runner:** restore bounded session history download retries ([#37504](https://github.com/okou-ai/okou/issues/37504)) ([7b5e240](https://github.com/okou-ai/okou/commit/7b5e240ed1fdaaa14755c364c667218d373c9250))

## [0.4.5](https://github.com/okou-ai/okou/compare/runner-executor-v0.4.4...runner-executor-v0.4.5) (2026-10-01)

## [0.4.4](https://github.com/okou-ai/okou/compare/runner-executor-v0.4.3...runner-executor-v0.4.4) (2026-10-01)

## [0.4.3](https://github.com/okou-ai/okou/compare/runner-executor-v0.4.2...runner-executor-v0.4.3) (2026-10-01)

## [0.4.2](https://github.com/okou-ai/okou/compare/runner-executor-v0.4.1...runner-executor-v0.4.2) (2026-10-01)

## [0.4.1](https://github.com/okou-ai/okou/compare/runner-executor-v0.4.0...runner-executor-v0.4.1) (2026-10-01)

## [0.4.0](https://github.com/okou-ai/okou/compare/runner-executor-v0.3.0...runner-executor-v0.4.0) (2026-09-30)


### Features

* make the database model catalog the model authority ([#37416](https://github.com/okou-ai/okou/issues/37416)) ([7a8cf4d](https://github.com/okou-ai/okou/commit/7a8cf4d005dea492e0375b91ac46bcf3201d902d))

## [0.3.0](https://github.com/okou-ai/okou/compare/runner-executor-v0.2.7...runner-executor-v0.3.0) (2026-09-30)


### Features

* **runner:** add private run-scoped guest duplex channel ([#37113](https://github.com/okou-ai/okou/issues/37113)) ([5487cfc](https://github.com/okou-ai/okou/commit/5487cfce060b5072409b8a0d944a7d1528ffbd91))

## [0.2.7](https://github.com/okou-ai/okou/compare/runner-executor-v0.2.6...runner-executor-v0.2.7) (2026-09-30)

## [0.2.6](https://github.com/okou-ai/okou/compare/runner-executor-v0.2.5...runner-executor-v0.2.6) (2026-09-30)

## [0.2.5](https://github.com/okou-ai/okou/compare/runner-executor-v0.2.4...runner-executor-v0.2.5) (2026-09-30)

## [0.2.4](https://github.com/okou-ai/okou/compare/runner-executor-v0.2.3...runner-executor-v0.2.4) (2026-09-30)

## [0.2.3](https://github.com/okou-ai/okou/compare/runner-executor-v0.2.2...runner-executor-v0.2.3) (2026-09-29)


### Refactoring

* remove retired terra and okou model variants ([#37368](https://github.com/okou-ai/okou/issues/37368)) ([e9a6e7a](https://github.com/okou-ai/okou/commit/e9a6e7a92cf3a408831a392afbc882e714037e22))

## [0.2.2](https://github.com/okou-ai/okou/compare/runner-executor-v0.2.1...runner-executor-v0.2.2) (2026-09-29)

## [0.2.1](https://github.com/okou-ai/okou/compare/runner-executor-v0.2.0...runner-executor-v0.2.1) (2026-09-29)

## [0.2.0](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.20...runner-executor-v0.2.0) (2026-09-28)


### Features

* finish the unified chat queue release 7 ([#37200](https://github.com/okou-ai/okou/issues/37200)) ([987a08b](https://github.com/okou-ai/okou/commit/987a08b7ac4b8220c3acc7d9b8fc8a9b4ddb46c8))


### Bug Fixes

* **runner:** read steerable input only on start, push, and ably reconnect ([#37232](https://github.com/okou-ai/okou/issues/37232)) ([5a4713a](https://github.com/okou-ai/okou/commit/5a4713ab3fbd39ee99a5a6067880ab7538ab359a))

## [0.1.20](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.19...runner-executor-v0.1.20) (2026-09-28)

## [0.1.19](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.18...runner-executor-v0.1.19) (2026-09-28)


### Refactoring

* **runner:** chat queue release 6 - steer endpoints and sandbox-first pi ([#37175](https://github.com/okou-ai/okou/issues/37175)) ([2ccafb0](https://github.com/okou-ai/okou/commit/2ccafb0e9add22ecefebd62785e7ecafe05a8ea7))

## [0.1.18](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.17...runner-executor-v0.1.18) (2026-09-28)

## [0.1.17](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.16...runner-executor-v0.1.17) (2026-09-27)

## [0.1.16](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.15...runner-executor-v0.1.16) (2026-09-26)

## [0.1.15](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.14...runner-executor-v0.1.15) (2026-09-25)

## [0.1.14](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.13...runner-executor-v0.1.14) (2026-09-25)

## [0.1.13](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.12...runner-executor-v0.1.13) (2026-09-25)

## [0.1.12](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.11...runner-executor-v0.1.12) (2026-09-25)

## [0.1.11](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.10...runner-executor-v0.1.11) (2026-09-25)

## [0.1.10](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.9...runner-executor-v0.1.10) (2026-09-25)

## [0.1.9](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.8...runner-executor-v0.1.9) (2026-09-24)


### Performance Improvements

* **runner:** attribute first claim body chunk wait ([#36747](https://github.com/okou-ai/okou/issues/36747)) ([bb22f6a](https://github.com/okou-ai/okou/commit/bb22f6a8bf717c1b104567028a4d35e4648229b9))

## [0.1.8](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.7...runner-executor-v0.1.8) (2026-09-24)


### Bug Fixes

* **runner:** reject codex backfill timeout sandbox reuse ([#36666](https://github.com/okou-ai/okou/issues/36666)) ([c26dd10](https://github.com/okou-ai/okou/commit/c26dd1068f4f1f6264253014100cff096492246f))

## [0.1.7](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.6...runner-executor-v0.1.7) (2026-09-24)


### Performance Improvements

* **runner:** attribute guest storage batch server time ([#36600](https://github.com/okou-ai/okou/issues/36600)) ([8019ca6](https://github.com/okou-ai/okou/commit/8019ca6775d5873d8fcaa7ee4fbd71de37d79f56))
* **test:** reduce rust coverage fixture overhead ([#36597](https://github.com/okou-ai/okou/issues/36597)) ([b89d4c3](https://github.com/okou-ai/okou/commit/b89d4c3688a8b2f14b03a2dd14a9e6792ae113c0))

## [0.1.6](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.5...runner-executor-v0.1.6) (2026-09-24)


### Performance Improvements

* **runner:** attribute claim response size on both sides ([#36582](https://github.com/okou-ai/okou/issues/36582)) ([954136f](https://github.com/okou-ai/okou/commit/954136fe0a41a917ac49cdb76095075ee6b4f3a4))

## [0.1.5](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.4...runner-executor-v0.1.5) (2026-09-24)

## [0.1.4](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.3...runner-executor-v0.1.4) (2026-09-24)

## [0.1.3](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.2...runner-executor-v0.1.3) (2026-09-24)

## [0.1.2](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.1...runner-executor-v0.1.2) (2026-09-24)


### Refactoring

* **runner:** consolidate shared API transport in provider ([#36447](https://github.com/okou-ai/okou/issues/36447)) ([193d460](https://github.com/okou-ai/okou/commit/193d460a94a242db4958f4a90631800cd9eed3e4))

## [0.1.1](https://github.com/okou-ai/okou/compare/runner-executor-v0.1.0...runner-executor-v0.1.1) (2026-09-23)


### Refactoring

* **runner:** extract runner-executor crate ([#36407](https://github.com/okou-ai/okou/issues/36407)) ([c7f9671](https://github.com/okou-ai/okou/commit/c7f967101042e43b12b244cc1e5de5a15402dad3))


### Performance Improvements

* **runner:** avoid redundant storage payload copy ([#36413](https://github.com/okou-ai/okou/issues/36413)) ([cf8de50](https://github.com/okou-ai/okou/commit/cf8de509095c36bdd1f3ac86a2388b675488a228))
