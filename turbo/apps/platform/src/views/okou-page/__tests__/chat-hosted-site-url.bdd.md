# Chat hosted site url

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-hosted-site-url.test.tsx](chat-hosted-site-url.test.tsx).

## chat-hosted-site-url-001

Original test `owners see visibility and banner settings from chat deployment links (sidebar=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-url.test.tsx#L242).

- **Given** I am the owner of a hosted site opened from a chat deployment link, with the artifact sidebar disabled.
- **When** I open the site's Share settings.
- **Then** The Show Okou banner switch is enabled and on, and Anyone with the link is the enabled visibility setting.

## chat-hosted-site-url-002

Original test `owners see visibility and banner settings from chat deployment links (sidebar=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-url.test.tsx#L242).

- **Given** I am the owner of a hosted site opened from a chat deployment link, with the artifact sidebar enabled.
- **When** I open the site's Share settings.
- **Then** The Show Okou banner switch is enabled and on, and Anyone with the link is the enabled visibility setting.

## chat-hosted-site-url-003

Original test `consecutive site renames preserve the title, link and Share/Resources copy addresses (sidebar=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-url.test.tsx#L260).

- **Given** A hosted site titled Quarterly launch report is open from a chat deployment link, with the artifact sidebar disabled.
- **When** I rename it first to renamed-site and then to final-site, copying its link after each rename and later copying it from Resources.
- **Then** The title stays Quarterly launch report. The title link and Share copy address change to each saved address in order, and the Resources copy address is https://final-site.okou.app.

## chat-hosted-site-url-004

Original test `consecutive site renames preserve the title, link and Share/Resources copy addresses (sidebar=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-url.test.tsx#L260).

- **Given** A hosted site titled Quarterly launch report is open from a chat deployment link, with the artifact sidebar enabled.
- **When** I rename it first to renamed-site and then to final-site, copying its link after each rename and later copying it from Resources.
- **Then** The title stays Quarterly launch report. The title link and Share copy address change to each saved address in order, and the Resources copy address is https://final-site.okou.app.

## chat-hosted-site-url-005

Original test `a reopened chat shows the catalog title and copies the current site address`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-url.test.tsx#L302).

- **Given** I reopen a chat containing a hosted site already renamed to already-renamed.
- **When** I open the site preview, close it, and copy the site address from Resources.
- **Then** The preview shows the catalog title Quarterly launch report and links to https://already-renamed.okou.app/. Resources copies https://already-renamed.okou.app.

## chat-hosted-site-url-006

Original test `Share directly copies legacy website links without URL customization (sidebar=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-url.test.tsx#L320).

- **Given** A hosted site titled Quarterly launch report uses the legacy sites.vm0.io address, with the artifact sidebar disabled.
- **When** I select Share.
- **Then** The legacy address https://legacy-site.sites.vm0.io is copied directly, and no Share dialog is shown for URL customization.

## chat-hosted-site-url-007

Original test `Share directly copies legacy website links without URL customization (sidebar=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-url.test.tsx#L320).

- **Given** A hosted site titled Quarterly launch report uses the legacy sites.vm0.io address, with the artifact sidebar enabled.
- **When** I select Share.
- **Then** The legacy address https://legacy-site.sites.vm0.io is copied directly, and no Share dialog is shown for URL customization.
