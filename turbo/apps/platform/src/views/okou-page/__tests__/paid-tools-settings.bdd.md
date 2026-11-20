# Paid tools settings

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [paid-tools-settings.test.tsx](paid-tools-settings.test.tsx).

## paid-tools-settings-001

Original test `Members manage Paid tools in Tools`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L118).

- **Given** A signed-in member is viewing Settings on the Preference page in the Research team workspace.
- **When** They open Tools.
- **Then** The Web search switch is on, Financial data is listed, and the page says the settings apply only to the member in Research team. It also explains that already running or prepared tasks may be affected, and the URL selects Tools.

## paid-tools-settings-002

Original test `Paid tools toggles save inverted enabled state and can re-enable a tool`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L137).

- **Given** Web search is disabled.
- **When** The member turns it on and then turns it off again.
- **Then** The switch first turns on and then off. The saves report Web search as enabled, then disabled.

## paid-tools-settings-003

Original test `Saving Image generation preserves other controls while preferences refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L157).

- **Given** Image generation, Web search, Advanced data research, and People search are on; Financial data is off; the image model control is available.
- **When** The member switches off Image generation while preferences refresh after the save.
- **Then** During the refresh, Image generation is marked as saving and temporarily unavailable, while the other switches retain their states and remain usable; the image model remains available. After refresh, Image generation is off, the other switch states are unchanged, and the image model is disabled. Turning Image generation back on enables the model control.

## paid-tools-settings-004

Original test `Saving Web search preserves other controls while preferences refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L157).

- **Given** Image generation, Web search, Advanced data research, and People search are on; Financial data is off; the image model control is available.
- **When** The member switches off Web search while preferences refresh after the save.
- **Then** During the refresh, Web search is marked as saving and temporarily unavailable, while the other switches retain their states and remain usable; the image model remains available. After refresh, Web search is off, the other switch states are unchanged, and the image model remains available. Turning Web search back on leaves the image model available.

## paid-tools-settings-005

Original test `Saving Advanced data research preserves other controls while preferences refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L157).

- **Given** Image generation, Web search, Advanced data research, and People search are on; Financial data is off; the image model control is available.
- **When** The member switches off Advanced data research while preferences refresh after the save.
- **Then** During the refresh, Advanced data research is marked as saving and temporarily unavailable, while the other switches retain their states and remain usable; the image model remains available. After refresh, Advanced data research is off, the other switch states are unchanged, and the image model remains available. Turning Advanced data research back on leaves the image model available.

## paid-tools-settings-006

Original test `Advanced data research saves independently and retains preferences across Tools visits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L236).

- **Given** Advanced data research and People search are on in Tools.
- **When** The member turns off Advanced data research, visits Preference, returns to Tools, and turns Advanced data research back on.
- **Then** Only Advanced data research is disabled and later re-enabled; People search remains on across both visits. The saves identify Advanced data research, first disabled and then enabled.

## paid-tools-settings-007

Original test `Router families appear with Router text and toggle by their own IDs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L293).

- **Given** The Router catalog contains a web-search family, a future-family with a listed tool, and an empty family; the member views Tools in Chinese.
- **When** The member inspects and toggles the future family.
- **Then** The listed family appears under its Chinese title, with its English description, and is on by default. The built-in Web search appears once, not under the Router title; the empty family is absent. Turning off the future family saves its own family ID as disabled.

## paid-tools-settings-008

Original test `Router discovery is cancelled when you close Settings during its delayed first page and loads on a new visit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L357).

- **Given** Router discovery is waiting on its delayed first page while the member has opened Tools from Preference.
- **When** The member closes Settings and later opens Settings again, then visits Tools.
- **Then** Closing Settings cancels the pending discovery before the close animation completes, and the URL no longer selects a settings page. On the new visit, the fresh catalog title appears and its switch is off; the abandoned title is absent. Web search remains on.

## paid-tools-settings-009

Original test `Router discovery is cancelled when you close Settings during its delayed next page and loads on a new visit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L357).

- **Given** Router discovery is waiting on its delayed next page while the member has opened Tools from Preference.
- **When** The member closes Settings and later opens Settings again, then visits Tools.
- **Then** Closing Settings cancels the pending discovery before the close animation completes, and the URL no longer selects a settings page. On the new visit, the fresh catalog title appears and its switch is off; the abandoned title is absent. Web search remains on.

## paid-tools-settings-010

Original test `Router discovery is cancelled when you navigate back during its delayed first page and loads on a new visit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L357).

- **Given** Router discovery is waiting on its delayed first page while the member has opened Tools from Preference.
- **When** The member navigates back and then visits Tools again.
- **Then** Navigation back cancels the pending discovery, and the URL returns to Preference. On the new visit, the fresh catalog title appears and its switch is off; the abandoned title is absent. Web search remains on.

## paid-tools-settings-011

Original test `Router discovery is cancelled when you navigate back during its delayed next page and loads on a new visit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L357).

- **Given** Router discovery is waiting on its delayed next page while the member has opened Tools from Preference.
- **When** The member navigates back and then visits Tools again.
- **Then** Navigation back cancels the pending discovery, and the URL returns to Preference. On the new visit, the fresh catalog title appears and its switch is off; the abandoned title is absent. Web search remains on.

## paid-tools-settings-012

Original test `A failed Router catalog is reported while Okou tools stay manageable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L485).

- **Given** The Router catalog request fails with a service error.
- **When** The member opens Tools and tries Web search.
- **Then** A tool-settings load error is shown, and Financial data is not listed. Web search can still be turned off and saved, while Image generation remains on.

## paid-tools-settings-013

Original test `A failed load shows no assumed enabled tools`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L502).

- **Given** The paid-tools settings request fails with a service error.
- **When** The member opens Tools.
- **Then** A tool-settings load error is shown, and Web search is not listed rather than being assumed enabled.

## paid-tools-settings-014

Original test `A workspace switch while a save obtains its token prevents sending that save under the new workspace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L518).

- **Given** A Web search save is waiting for an access token in the Research team workspace.
- **When** The member switches to the Second workspace before the token is returned.
- **Then** The pending save is not sent under the new workspace. The page identifies the Second workspace, and Web search remains on.

## paid-tools-settings-015

Original test `The image model shows the system default when the member has none`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L550).

- **Given** The member has no stored image-model preference.
- **When** They open Tools.
- **Then** The image model control shows the system default, GPT Image 2.5 Flare, and is enabled.

## paid-tools-settings-016

Original test `The image model shows the member's stored model`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L561).

- **Given** The member's stored image model is FLUX.2 Pro.
- **When** They open Tools.
- **Then** The image model control shows FLUX.2 Pro.

## paid-tools-settings-017

Original test `The image model is locked but still shown while image generation is off`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L572).

- **Given** The stored image model is Ideogram 4 and Image generation is off.
- **When** The member opens Tools and turns Image generation on.
- **Then** Ideogram 4 remains shown while the control is disabled. Turning Image generation on enables the control without changing the displayed model.

## paid-tools-settings-018

Original test `Choosing an image model saves it with the stored run model`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L592).

- **Given** The stored run model is Claude Sonnet 5 with the priority service tier.
- **When** The member selects Ideogram 4 as the image model.
- **Then** Ideogram 4 is displayed and saved with the existing Claude Sonnet 5 run model and priority tier.

## paid-tools-settings-019

Original test `A failed image model save retains the unsaved choice`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L637).

- **Given** The image-model save service returns an error.
- **When** The member selects Nano Banana 2 Lite.
- **Then** A message says the image model was not saved, and the unsaved selection remains displayed.

## paid-tools-settings-020

Original test `An unsaved image model is discarded when you disable image generation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L662).

- **Given** The member selects Ideogram 4, but the save fails and the unsaved choice remains displayed.
- **When** They turn off Image generation.
- **Then** The unsaved choice is discarded, the system default GPT Image 2.5 Flare is displayed, the control is disabled, and the save-error message is gone.

## paid-tools-settings-021

Original test `An unsaved image model is discarded when you leave Tools`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L662).

- **Given** The member selects Ideogram 4, but the save fails and the unsaved choice remains displayed.
- **When** They leave Tools for Preference and then return to Tools.
- **Then** The unsaved choice is discarded, the system default GPT Image 2.5 Flare is displayed, the control is enabled, and the save-error message is gone.

## paid-tools-settings-022

Original test `An image model change from another session refreshes the displayed model`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L707).

- **Given** The image model control shows the system default, GPT Image 2.5 Flare.
- **When** An image-model preference changes in another session and the member's settings are refreshed.
- **Then** The control updates to GPT Image 2 and no longer shows GPT Image 2.5 Flare.

## paid-tools-settings-023

Original test `An image model save cannot cross workspaces while awaiting its preference read`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L732).

- **Given** An image-model save is waiting for its preference read in the current workspace.
- **When** The member switches to the Second workspace before that read completes.
- **Then** The old save is not sent; after the workspace changes, the image model control is available and no update was made.

## paid-tools-settings-024

Original test `An image model save cannot cross workspaces while awaiting its write token`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx#L732).

- **Given** An image-model save is waiting for a write token in the current workspace.
- **When** The member switches to the Second workspace before the token is returned.
- **Then** The old save is not sent; after the workspace changes, the image model control is available and no update was made.
