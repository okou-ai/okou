# Composer template recommendation previews

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [composer-template-recommendation-previews.test.tsx](composer-template-recommendation-previews.test.tsx).

## composer-template-recommendation-previews-001

Original test `A presentation recommendation previews slides and a theme before attaching it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-template-recommendation-previews.test.tsx#L148).

- **Given** The user has a draft and a recommended presentation template with three slides.
- **When** They preview it, move to slide two, choose the Deep dive theme, then attach and send it.
- **Then** The preview shows slide two of three and the selected theme; before attachment the draft remains and no template is attached. Attaching preserves the draft and focuses the editor, and sending includes the presentation template with the selected theme.

## composer-template-recommendation-previews-002

Original test `Direct presentation dismissal restores the Eye while View all still returns to its gallery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-template-recommendation-previews.test.tsx#L203).

- **Given** The user has a draft and a recommended two-slide presentation template.
- **When** They open and dismiss its preview using Close and Escape, then use View all to preview and dismiss it there.
- **Then** Each dismissal returns focus to the relevant preview control without attaching a template or changing the draft. View all opens with Presentation selected, and its preview can be dismissed back to the preview control.

## composer-template-recommendation-previews-003

Original test `The recommendation Eye is keyboard reachable and opens with Enter and Space`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-template-recommendation-previews.test.tsx#L266).

- **Given** The user is on the Presentation recommendation shelf and can focus a template title.
- **When** They tab to its preview control and open the preview using Enter and then Space in separate attempts.
- **Then** The preview control is keyboard reachable; each key opens the preview, and Escape dismisses it back to the control.

## composer-template-recommendation-previews-004

Original test `A report recommendation previews its sample pages, dismisses and attaches without sending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-template-recommendation-previews.test.tsx#L291).

- **Given** The user has a draft and a recommended report template with sample pages.
- **When** They preview page two, dismiss and reopen the preview, dismiss it again, then attach the template and send.
- **Then** The preview shows the description and sample pages, and its larger-preview link points to page two. Dismissal restores the preview control; attaching preserves the draft without sending, and sending includes the report template.

## composer-template-recommendation-previews-005

Original test `Deleting a custom presentation recommendation dismisses to a surviving shelf control only on success`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-template-recommendation-previews.test.tsx#L352).

- **Given** The user has a draft and a custom Presentation recommendation whose deletion initially fails.
- **When** They cancel one deletion confirmation, retry and receive a failure, then retry successfully.
- **Then** Cancel leaves the preview open; failure preserves it. On success the recommendation and preview disappear, focus moves to the surviving import control, and the draft remains with no template attached or message sent.

## composer-template-recommendation-previews-006

Original test `Deleting a custom document recommendation dismisses to a surviving shelf control only on success`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-template-recommendation-previews.test.tsx#L352).

- **Given** The user has a draft and a custom Document recommendation whose deletion initially fails.
- **When** They cancel one deletion confirmation, retry and receive a failure, then retry successfully.
- **Then** Cancel leaves the preview open; failure preserves it. On success the recommendation and preview disappear, focus moves to the surviving import control, and the draft remains with no template attached or message sent.

## composer-template-recommendation-previews-007

Original test `Pending custom deletion keeps its confirmation guarded and recovers after failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-template-recommendation-previews.test.tsx#L404).

- **Given** The user has opened the delete confirmation for a custom Presentation template, and deletion is pending.
- **When** They try Escape and Close while the request is pending, then the request fails.
- **Then** The pending confirmation cannot be dismissed, and Delete and Cancel are disabled. After failure, both controls are enabled and the failure is shown; canceling closes the confirmation but leaves the preview and shelf recommendation intact. Escape then dismisses the preview, with the draft preserved and no message sent.

## composer-template-recommendation-previews-008

Original test `A custom presentation recommendation opens its existing detail, dismisses to the Eye and can be used`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-template-recommendation-previews.test.tsx#L481).

- **Given** The user has a draft and an existing custom Presentation recommendation.
- **When** They open its details, dismiss the preview, reopen it, and use the template.
- **Then** The details allow renaming and show the second page; dismissal returns focus to the preview control. Using the template preserves the draft without sending, and a subsequent send includes the custom template.

## composer-template-recommendation-previews-009

Original test `A custom document recommendation opens its existing detail, dismisses to the Eye and can be used`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-template-recommendation-previews.test.tsx#L481).

- **Given** The user has a draft and an existing custom Document recommendation, and has opened the Invoice category in View all before returning to the shelf.
- **When** They open the template details, dismiss the preview, reopen it, and use the template.
- **Then** The details allow renaming and display the document through the Office viewer using its source URL; dismissal returns focus to the preview control. Using the template preserves the draft without sending, and a subsequent send includes the custom template.
