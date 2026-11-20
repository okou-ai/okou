# Chat composer vnc dependencies

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-vnc-dependencies.test.tsx](chat-composer-vnc-dependencies.test.tsx).

## chat-composer-vnc-dependencies-001

Original test `New-chat SSH choices preserve row order, keyboard focus and VNC dependency feedback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L249).

- **Given** The user is starting a new chat and the SSH host is off by default.
- **When** They use the keyboard to turn SSH MacinCloud on.
- **Then** The SSH and VNC choices remain in their original row order, the SSH choice retains focus, and the menu reports “SSH enabled: MacinCloud”.

## chat-composer-vnc-dependencies-002

Original test `New-chat VNC choices preserve row order, keyboard focus and VNC dependency feedback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L249).

- **Given** The user is starting a new chat and VNC is enabled by default while its SSH dependency is off.
- **When** They use the keyboard to turn VNC MacinCloud off.
- **Then** The SSH and VNC choices remain in their original row order, the VNC choice retains focus, and the menu reports “Requires SSH: MacinCloud”.

## chat-composer-vnc-dependencies-003

Original test `Saved-chat SSH keeps keyboard focus through a slow On save from default true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L306).

- **Given** In a saved chat, SSH is enabled by default and its save and access refresh are slow.
- **When** The user uses the keyboard to select On for SSH MacinCloud.
- **Then** The choice retains focus during the save and refresh, is read-only and busy while saving, and ultimately displays On with focus retained.

## chat-composer-vnc-dependencies-004

Original test `Saved-chat SSH keeps keyboard focus through a slow On save from default false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L306).

- **Given** In a saved chat, SSH is disabled by default and its save and access refresh are slow.
- **When** The user uses the keyboard to select On for SSH MacinCloud.
- **Then** The choice retains focus during the save and refresh, is read-only and busy while saving, and ultimately displays On with focus retained.

## chat-composer-vnc-dependencies-005

Original test `Saved-chat VNC keeps keyboard focus through a slow On save from default true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L306).

- **Given** In a saved chat, VNC is enabled by default and its save and access refresh are slow.
- **When** The user uses the keyboard to select On for VNC MacinCloud.
- **Then** The choice retains focus during the save and refresh, is read-only and busy while saving, and ultimately displays On with focus retained.

## chat-composer-vnc-dependencies-006

Original test `Saved-chat VNC keeps keyboard focus through a slow Off save from default true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L306).

- **Given** In a saved chat, VNC is enabled by default and its save and access refresh are slow.
- **When** The user uses the keyboard to select Off for VNC MacinCloud.
- **Then** The choice retains focus during the save and refresh, is read-only and busy while saving, and ultimately displays Off with focus retained.

## chat-composer-vnc-dependencies-007

Original test `A completed save preserves the user's new keyboard destination (failure: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L346).

- **Given** In a saved chat, SSH MacinCloud is enabled by default and a save is pending.
- **When** The user selects On for SSH MacinCloud, tabs to SSH Other tunnel, and selects On there before the first save completes; the save succeeds.
- **Then** SSH MacinCloud displays On, SSH Other tunnel displays On, and the keyboard remains on SSH Other tunnel throughout save completion.

## chat-composer-vnc-dependencies-008

Original test `A completed save preserves the user's new keyboard destination (failure: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L346).

- **Given** In a saved chat, SSH MacinCloud is enabled by default and a save is pending.
- **When** The user selects On for SSH MacinCloud, tabs to SSH Other tunnel, and selects On there before the first save completes; the save fails and the user reloads permissions.
- **Then** SSH MacinCloud returns to displaying Default (On), an uncertainty message appears, and SSH Other tunnel retains focus and can be changed to On after reload. Its display returns to Default (Off) after the later change attempt.

## chat-composer-vnc-dependencies-009

Original test `Dismissing Remote access during a save retains the connector trigger focus`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L399).

- **Given** Remote access is open in a saved chat and an SSH setting is being saved.
- **When** The user dismisses Remote access before the save completes, then the save and access refresh complete and they reopen the menu.
- **Then** The Connectors trigger receives focus when the dialog closes and again after the second dismissal; the reopened SSH MacinCloud choice displays On.

## chat-composer-vnc-dependencies-010

Original test `An unrelated SSH host does not satisfy an enabled VNC host's dependency`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L444).

- **Given** VNC MacinCloud is enabled, its SSH dependency MacinCloud is off, and another SSH host is available.
- **When** The user turns on SSH Other tunnel.
- **Then** SSH Other tunnel displays On, but the warning to enable SSH MacinCloud remains.

## chat-composer-vnc-dependencies-011

Original test `An enabled VNC host follows its exact SSH dependency`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L459).

- **Given** VNC MacinCloud is enabled and its SSH dependency MacinCloud is off.
- **When** The user turns SSH MacinCloud on and then off.
- **Then** The warning to enable SSH MacinCloud disappears while that dependency is on, a note says SSH is enabled, and the warning returns when it is turned off.

## chat-composer-vnc-dependencies-012

Original test `A disabled VNC host shows its SSH dependency without a warning`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L475).

- **Given** VNC MacinCloud is enabled and its SSH dependency MacinCloud is off.
- **When** The user turns VNC MacinCloud off.
- **Then** The menu shows that VNC requires SSH MacinCloud, without showing the enable-SSH warning.

## chat-composer-vnc-dependencies-013

Original test `VNC dependency feedback follows the chat override over default true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L487).

- **Given** SSH MacinCloud defaults on, but the saved chat overrides it to off; VNC is enabled.
- **When** The user opens Remote access and selects the default setting for SSH MacinCloud.
- **Then** Initially the menu warns to enable SSH MacinCloud; after selecting the default, it reports SSH enabled and the warning is absent.

## chat-composer-vnc-dependencies-014

Original test `VNC dependency feedback follows the chat override over default false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L487).

- **Given** SSH MacinCloud defaults off, but the saved chat overrides it to on; VNC is enabled.
- **When** The user opens Remote access and selects the default setting for SSH MacinCloud.
- **Then** Initially the menu reports SSH enabled and has no enable-SSH warning; after selecting the default, the warning to enable SSH MacinCloud appears.

## chat-composer-vnc-dependencies-015

Original test `A new chat updates VNC warnings from unsent host choices`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L511).

- **Given** In a new chat, SSH MacinCloud is on by default and VNC MacinCloud is off by default.
- **When** The user turns SSH off, turns VNC on, then restores SSH to its default.
- **Then** The dependency feedback changes from SSH enabled to a requires-SSH note; when VNC is turned on it warns to enable SSH, and restoring SSH to its default changes the feedback to SSH enabled and removes the warning.

## chat-composer-vnc-dependencies-016

Original test `VNC reports its transport and KDC SSH dependencies independently`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L535).

- **Given** Enabled VNC uses SSH MacinCloud for transport and SSH Directory tunnel for its KDC dependency; both SSH hosts are off.
- **When** The user enables SSH MacinCloud and then SSH Directory tunnel.
- **Then** Initially both SSH dependencies have separate warnings. Enabling MacinCloud removes only its warning; enabling Directory tunnel removes the KDC warning and reports SSH enabled for that host.

## chat-composer-vnc-dependencies-017

Original test `Direct VNC transport still explains an SSH-backed KDC dependency`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L562).

- **Given** VNC uses direct transport but has an SSH-backed KDC dependency on SSH Directory tunnel, which is off.
- **When** The user turns SSH Directory tunnel on.
- **Then** The menu warns only about the KDC SSH dependency before the change; afterward it reports SSH enabled for Directory tunnel and removes the KDC warning.

## chat-composer-vnc-dependencies-018

Original test `The same SSH host used for VNC and KDC is explained only once`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L576).

- **Given** Enabled VNC uses the same off SSH MacinCloud host for both transport and KDC.
- **When** The user opens Remote access.
- **Then** The warning to enable SSH MacinCloud appears exactly once.

## chat-composer-vnc-dependencies-019

Original test `A failed VNC configuration read leaves SSH choices available and can be reloaded`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L583).

- **Given** VNC configuration initially fails to load, while SSH choices are available in a saved chat.
- **When** The user turns SSH Other tunnel on and reloads the remote-access information.
- **Then** The VNC configuration error is shown, SSH Other tunnel remains available and displays On, and after reload the SSH dependency warning appears and the VNC choice is available for changes.

## chat-composer-vnc-dependencies-020

Original test `Pending VNC configuration is not interpreted as disabled SSH access`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L606).

- **Given** VNC configuration is still loading in a saved chat.
- **When** The user opens Remote access, then the configuration finishes loading.
- **Then** No SSH dependency warning is shown while configuration is pending; once it loads, the warning to enable SSH MacinCloud appears.

## chat-composer-vnc-dependencies-021

Original test `A failed access refresh reports its error without claiming dependency status`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.test.tsx#L617).

- **Given** VNC is initially off and its dependency feedback says it requires SSH MacinCloud.
- **When** The user turns VNC on, but the subsequent remote-access refresh fails.
- **Then** The menu reports that remote access could not be loaded and does not show the warning to enable SSH MacinCloud.
