# Changelog

## [0.1.7](https://github.com/okou-ai/okou/compare/process-launch-v0.1.6...process-launch-v0.1.7) (2026-11-14)


### Refactoring

* **rust:** type owned blocking-mode updates ([#47120](https://github.com/okou-ai/okou/issues/47120)) ([5006b06](https://github.com/okou-ai/okou/commit/5006b0632614308a23d1368980b502aedfc11e29))

## [0.1.6](https://github.com/okou-ai/okou/compare/process-launch-v0.1.5...process-launch-v0.1.6) (2026-11-13)


### Refactoring

* **rust:** use safe pidfd acquisition across remaining owners ([#46912](https://github.com/okou-ai/okou/issues/46912)) ([eb43993](https://github.com/okou-ai/okou/commit/eb43993f436261b2850e87ebf5e87e1a6ebc6947))

## [0.1.5](https://github.com/okou-ai/okou/compare/process-launch-v0.1.4...process-launch-v0.1.5) (2026-11-06)


### Performance Improvements

* **sandbox:** prepare snapshot mounts before native exec ([#45523](https://github.com/okou-ai/okou/issues/45523)) ([1d8f092](https://github.com/okou-ai/okou/commit/1d8f092366e802638db3402cd9e21d4d261d78ee))

## [0.1.4](https://github.com/okou-ai/okou/compare/process-launch-v0.1.3...process-launch-v0.1.4) (2026-11-02)


### Refactoring

* **process-launch:** use owned descriptor cloning ([#44709](https://github.com/okou-ai/okou/issues/44709)) ([7797eb8](https://github.com/okou-ai/okou/commit/7797eb84b73714f027c5cde9550b5107b4cade02))

## [0.1.3](https://github.com/okou-ai/okou/compare/process-launch-v0.1.2...process-launch-v0.1.3) (2026-11-01)


### Refactoring

* **rust:** consolidate remaining test modules ([#44510](https://github.com/okou-ai/okou/issues/44510)) ([118202f](https://github.com/okou-ai/okou/commit/118202f39eea0d0872205d09a1ef19f90882fad9))
* **rust:** use native owned blocking pipes ([#44536](https://github.com/okou-ai/okou/issues/44536)) ([a6c71bd](https://github.com/okou-ai/okou/commit/a6c71bd5e2ac41228ab4d704a43de9715bfbb67d))

## [0.1.2](https://github.com/vm0-ai/vm0/compare/process-launch-v0.1.1...process-launch-v0.1.2) (2026-09-14)


### Bug Fixes

* **rust:** reuse managed child pidfds for firecracker monitoring ([#34061](https://github.com/vm0-ai/vm0/issues/34061)) ([7112251](https://github.com/vm0-ai/vm0/commit/7112251220aa4268e6b0b1e154bff401eb2d09d1))

## [0.1.1](https://github.com/vm0-ai/vm0/compare/process-launch-v0.1.0...process-launch-v0.1.1) (2026-09-10)


### Performance Improvements

* **sandbox-firecracker:** share direct cgroup process launches ([#33141](https://github.com/vm0-ai/vm0/issues/33141)) ([61f225c](https://github.com/vm0-ai/vm0/commit/61f225cf47679330cd2be973addd8723b9e3fbf9))
