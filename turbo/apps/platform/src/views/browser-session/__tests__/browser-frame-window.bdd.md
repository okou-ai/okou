# Browser frame window

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-frame-window.test.tsx](browser-frame-window.test.tsx).

## browser-frame-window-01

Original test `Averaged RTT $samples allows $expected painted frames before ACKs return`.

- **Given** The viewer can measure latency before the first live image starts.
- **When** Frames arrive before their receipt acknowledgements return.
- **Then** The viewer paints a window sized to the measured latency.

Examples

- `browser-frame-window-01.01` 1, 2, 3 ms samples allow 3 frames
  Registered test `Averaged RTT [ 1, 2, 3 ] allows 3 painted frames before ACKs return`.
- `browser-frame-window-01.02` 100, 200, 300 ms samples allow 8 frames
  Registered test `Averaged RTT [ 100, 200, 300 ] allows 8 painted frames before ACKs return`.
- `browser-frame-window-01.03` 800, 1,000, 1,200 ms samples allow 24 frames
  Registered test `Averaged RTT [ 800, 1000, 1200 ] allows 24 painted frames before ACKs return`.

## browser-frame-window-02

Original test `A stalled optional probe does not delay a usable first image or input`.

Registered test `A stalled optional probe does not delay a usable first image or input`.

- **Given** An optional latency probe is stalled.
- **When** The user opens the viewer.
- **Then** The first image and input are usable and the viewer paints the default three-frame window.

## browser-frame-window-03

Original test `A rejected optional probe leaves the browser usable`.

Registered test `A rejected optional probe leaves the browser usable`.

- **Given** The optional latency probe fails.
- **When** The user opens the viewer.
- **Then** The viewer is usable and paints the default three-frame window.

## browser-frame-window-04

Original test `A late averaged estimate does not restart an already usable capture`.

Registered test `A late averaged estimate does not restart an already usable capture`.

- **Given** The viewer is already usable with the default frame window.
- **When** A late latency estimate arrives.
- **Then** The existing capture keeps displaying frames with the original three-frame window.

## browser-frame-window-05

Original test `A split image socket sizes its window independently of the retired shared socket`.

Registered test `A split image socket sizes its window independently of the retired shared socket`.

- **Given** The shared connection has a pending latency measurement.
- **When** The user switches to a separate image connection that measures 200 ms.
- **Then** The new viewer remains usable with an eight-frame window and ignores the old connection result.
