# Changelog

## [0.6.3](https://github.com/okou-ai/okou/compare/ios-v0.6.2...ios-v0.6.3) (2026-10-07)


### Refactoring

* remove custom provider and gateway traces ([#37890](https://github.com/okou-ai/okou/issues/37890)) ([f59490d](https://github.com/okou-ai/okou/commit/f59490d298d2c0b3c3b903d005846e13524bc59e))
* retire cooldown, ultrafast, us routing and model provider leftovers ([#37884](https://github.com/okou-ai/okou/issues/37884)) ([a9c3270](https://github.com/okou-ai/okou/commit/a9c3270099034c0f7ee73f6c730b07efa7d1d733))

## [0.6.2](https://github.com/okou-ai/okou/compare/ios-v0.6.1...ios-v0.6.2) (2026-10-07)


### Bug Fixes

* **ios:** restore sidebar gestures and stabilize chat rendering ([#37877](https://github.com/okou-ai/okou/issues/37877)) ([232e9c8](https://github.com/okou-ai/okou/commit/232e9c829a9fdc63f36042999f6fc405676c8dab))


### Refactoring

* remove remaining model provider residue ([#37870](https://github.com/okou-ai/okou/issues/37870)) ([a93133b](https://github.com/okou-ai/okou/commit/a93133b0493858a39924a1206ff5a5677e43cad6))

## [0.6.1](https://github.com/okou-ai/okou/compare/ios-v0.6.0...ios-v0.6.1) (2026-10-06)


### Refactoring

* retire organization custom model configuration ([#37746](https://github.com/okou-ai/okou/issues/37746)) ([014fe18](https://github.com/okou-ai/okou/commit/014fe1867c6d1830fd35b03c3d77491da5aaa36a))

## [0.6.0](https://github.com/okou-ai/okou/compare/ios-v0.5.0...ios-v0.6.0) (2026-10-03)


### Features

* **ios:** persist and replay chat threads from server events ([#37658](https://github.com/okou-ai/okou/issues/37658)) ([415824a](https://github.com/okou-ai/okou/commit/415824ab86f7f8842db67d9fd26f67652ff6325b))

## [0.5.0](https://github.com/okou-ai/okou/compare/ios-v0.4.1...ios-v0.5.0) (2026-09-30)


### Features

* make the database model catalog the model authority ([#37416](https://github.com/okou-ai/okou/issues/37416)) ([7a8cf4d](https://github.com/okou-ai/okou/commit/7a8cf4d005dea492e0375b91ac46bcf3201d902d))

## [0.4.1](https://github.com/okou-ai/okou/compare/ios-v0.4.0...ios-v0.4.1) (2026-09-30)


### Refactoring

* **chat:** complete chat event v8 transition cleanup ([#37411](https://github.com/okou-ai/okou/issues/37411)) ([cd4aac5](https://github.com/okou-ai/okou/commit/cd4aac5fa635dd7f71eb82756529c5643c552cc9))

## [0.4.0](https://github.com/okou-ai/okou/compare/ios-v0.3.1...ios-v0.4.0) (2026-09-28)


### Features

* **api:** enqueue once and pick in the background for every chat input ([#37116](https://github.com/okou-ai/okou/issues/37116)) ([a4aaee6](https://github.com/okou-ai/okou/commit/a4aaee679a34922e1069146d265190e43a627b31))

## [0.3.1](https://github.com/okou-ai/okou/compare/ios-v0.3.0...ios-v0.3.1) (2026-09-26)


### Bug Fixes

* **ios:** load remote chat snapshots and round sidebar shadow ([#36994](https://github.com/okou-ai/okou/issues/36994)) ([8a1af9b](https://github.com/okou-ai/okou/commit/8a1af9b1a3bbec1f8bea5ad5b903b9dd2d5a552e))

## [0.3.0](https://github.com/okou-ai/okou/compare/ios-v0.2.1...ios-v0.3.0) (2026-09-25)


### Features

* **ios:** add native chat sidebar and composer ([#36930](https://github.com/okou-ai/okou/issues/36930)) ([4e7b024](https://github.com/okou-ai/okou/commit/4e7b024bc3cef22aa8b4bb8e10eefa90ce1c59bd))

## [0.2.1](https://github.com/okou-ai/okou/compare/ios-v0.2.0...ios-v0.2.1) (2026-09-25)


### Bug Fixes

* **ios:** scope distribution profile to app target ([#36825](https://github.com/okou-ai/okou/issues/36825)) ([9f555df](https://github.com/okou-ai/okou/commit/9f555df0c099a6be762a735e36552c630ca6888f))

## [0.2.0](https://github.com/okou-ai/okou/compare/ios-v0.1.0...ios-v0.2.0) (2026-09-24)


### Features

* store chat thread archive state instead of title emoji ([#36480](https://github.com/okou-ai/okou/issues/36480)) ([f5a0de6](https://github.com/okou-ai/okou/commit/f5a0de65c0621ca58c35edd65fc257417becdaa3))


### CI

* **ios:** publish internal testflight builds through release-please ([#36638](https://github.com/okou-ai/okou/issues/36638)) ([b898db6](https://github.com/okou-ai/okou/commit/b898db69fd2e1c9a13b79171bf03cab656995caf))
