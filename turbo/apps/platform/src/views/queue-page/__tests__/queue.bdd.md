# Queue

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [queue.test.tsx](queue.test.tsx).

## queue-001

Original test `The queue deep link opens a drawer that can be closed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/queue-page/__tests__/queue.test.tsx#L77).

- **Given** A Team queue is full and the user opens the queue deep link.
- **When** The user closes the queue drawer.
- **Then** The drawer closes.

## queue-002

Original test `Team administrators can buy additional concurrency without changing plans`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/queue-page/__tests__/queue.test.tsx#L99).

- **Given** A Team administrator has a concurrency limit of 5, with 3 slots in use and 2 available; additional concurrency costs $42 per month.
- **When** The administrator opens the queue drawer.
- **Then** The drawer shows Team, 3 of 5 slots in use, and Additional concurrency. Buy $42/month is enabled, and no plan upgrade is offered.

## queue-003

Original test `Queue billing actions appear only for authorized administrators and supported plans`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/queue-page/__tests__/queue.test.tsx#L127).

- **Given** A non-admin member is on Team with all 10 slots in use; the billing status does not authorize concurrency purchases.
- **When** The member opens the queue drawer.
- **Then** The drawer shows Team, 10 of 10 slots in use, 0 slots available, and no concurrency purchase or plan upgrade actions.

## queue-004

Original test `The queue labels the limited-free tier as Free`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/queue-page/__tests__/queue.test.tsx#L157).

- **Given** A member is on the limited-free-1 tier with one slot in use.
- **When** The member opens the queue drawer.
- **Then** The tier is labeled Free.

## queue-005

Original test `A Team administrator reviews and pays for an existing concurrency change`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/queue-page/__tests__/queue.test.tsx#L180).

- **Given** A Team administrator has an existing concurrency subscription for 2 units and can change it; the queue has no available slots.
- **When** The administrator increases the quantity to 4, selects Buy $200/month, reviews the change, and pays.
- **Then** The review shows quantity 4, $43.21 due now, and $400.00/month recurring. The change is confirmed for quantity 4 and the browser navigates to the hosted invoice.

## queue-006

Original test `A Team administrator reviews a first concurrency purchase before checkout`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/queue-page/__tests__/queue.test.tsx#L266).

- **Given** A Team administrator can buy concurrency through a reviewed first purchase, and the queue has no available slots.
- **When** The administrator clears the quantity, then enters 5, reviews the purchase, and selects Pay and add slots.
- **Then** A zero quantity displays $0/month and cannot be purchased. The review for quantity 5 shows $70.00 due now and $220.00/month recurring; checkout is created for 5 and reports that concurrency was added.

## queue-007

Original test `The queue shows active slot usage for each member`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/queue-page/__tests__/queue.test.tsx#L348).

- **Given** A Team queue has a limit of 80, with 17 active slots: Bingjie Zang uses 7, You Liang 5, Ethan Zhang 3, and Linghan Hu 2.
- **When** The user opens the queue drawer.
- **Then** The drawer shows 17 of 80 slots in use, each member with their respective slot count, and 63 slots available.

## queue-008

Original test `The queue drawer follows a run queue refresh of slot availability`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/queue-page/__tests__/queue.test.tsx#L381).

- **Given** A Team queue has 2 of 4 slots in use and initially reports 0 available slots.
- **When** The run queue refreshes to report 1 available slot.
- **Then** The drawer updates Available now from 0 slots to 1 slot.

## queue-009

Original test `A full queue offers the next appropriate plan upgrade`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/queue-page/__tests__/queue.test.tsx#L423).

- **Given** A full limited-free queue has 2 of 2 slots in use.
- **When** The user opens the queue, then billing and queue status change to a full Pro plan with 3 of 3 slots in use.
- **Then** The queue first offers Upgrade to Pro; after the change it displays Pro and offers Upgrade to Team.
