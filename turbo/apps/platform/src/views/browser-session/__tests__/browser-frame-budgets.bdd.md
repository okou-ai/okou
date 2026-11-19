# Browser frame budgets

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-frame-budgets.test.tsx](browser-frame-budgets.test.tsx).

## browser-frame-budgets-01

Original test `A %s viewer accepts a 48 MiB first image and enables remote input`.

- **Given** The viewer is waiting for the first image.
- **When** A 48 MiB image arrives.
- **Then** The picture renders, the current address is retained, and remote input becomes available.

Examples

- `browser-frame-budgets-01.01` Shared image and control connection
  Registered test `A shared viewer accepts a 48 MiB first image and enables remote input`.
- `browser-frame-budgets-01.02` Separate image connection
  Registered test `A split viewer accepts a 48 MiB first image and enables remote input`.

## browser-frame-budgets-02

Original test `A frame above its budget retains the connection and recovers its image automatically`.

Registered test `A frame above its budget retains the connection and recovers its image automatically`.

- **Given** The viewer is open and usable.
- **When** An image exceeds its size limit.
- **Then** The viewer shows reconnecting and temporarily disables input. The picture and input recover automatically.

## browser-frame-budgets-03

Original test `A message above its budget disconnects and supports explicit reconnect`.

Registered test `A message above its budget disconnects and supports explicit reconnect`.

- **Given** The viewer is open and usable.
- **When** An oversized transport message arrives, then the user chooses Reconnect.
- **Then** The viewer reports disconnection and disables input until Reconnect restores it.
