# Composer custom template recommendations

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [composer-custom-template-recommendations.test.tsx](composer-custom-template-recommendations.test.tsx).

## composer-custom-template-recommendations-001

Original test `The Presentation homepage shelf orders import, custom templates and built-ins and uses the selected custom template`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx#L149).

- **Given** The user is creating a Presentation with a draft and the catalog contains an accessible private template and a shared organization template.
- **When** They open the Presentation shelf, select their custom template, and send the draft.
- **Then** Import appears before custom templates, and custom templates appear before built-ins. The selected custom template is used, and the original draft text remains.

## composer-custom-template-recommendations-002

Original test `The Image homepage shelf orders import, custom templates and built-ins and uses the selected custom template`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx#L149).

- **Given** The user is creating an Image with a draft and the catalog contains an accessible private template and a shared organization template.
- **When** They open the Image shelf, select their custom template, and send the draft.
- **Then** Import appears before custom templates, and custom templates appear before built-ins. The selected custom template is used, and the original draft text remains.

## composer-custom-template-recommendations-003

Original test `The Document homepage shelf orders import, custom templates and built-ins and uses the selected custom template`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx#L149).

- **Given** The user is creating a Document with a draft and the catalog contains an accessible private template and a shared organization template.
- **When** They open the Document shelf, select their custom template, and send the draft.
- **Then** Import appears before custom templates, and custom templates appear before built-ins. The selected custom template is used, and the original draft text remains.

## composer-custom-template-recommendations-004

Original test `Presentation shows accessible custom templates only of its kind`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx#L194).

- **Given** The user opens the Presentation shelf while the catalog contains templates for multiple kinds, including an accessible shared organization template.
- **When** They view the available templates.
- **Then** The shelf shows accessible presentation templates, the shared template, and built-ins, but no illustration or document templates. The custom template displays its cover image.

## composer-custom-template-recommendations-005

Original test `Image shows accessible custom templates only of its kind`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx#L194).

- **Given** The user opens the Image shelf while the catalog contains templates for multiple kinds, including an accessible shared organization template.
- **When** They view the available templates.
- **Then** The shelf shows accessible illustration templates, the shared template, and built-ins, but no presentation or document templates. The custom template displays its preview image.

## composer-custom-template-recommendations-006

Original test `Selecting a custom presentation template from another catalog updates the creation task`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx#L243).

- **Given** The user opens the Image shelf, but the catalog contains a custom presentation template.
- **When** They open the full template picker, switch to Presentation, select the template, and send the draft.
- **Then** The picker closes, the composer shows the template and preserves the draft, and the creation task updates to Presentation. Sending uses the selected custom template and includes the instruction to create a presentation.

## composer-custom-template-recommendations-007

Original test `Selecting a custom illustration template from another catalog updates the creation task`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx#L243).

- **Given** The user opens the Presentation shelf, but the catalog contains a custom illustration template.
- **When** They open the full template picker, switch to Image, select the template, and send the draft.
- **Then** The picker closes, the composer shows the template and preserves the draft, and the creation task updates to Image. Sending uses the selected custom template and includes the instruction to create an image.

## composer-custom-template-recommendations-008

Original test `Selecting a custom document template from another catalog updates the creation task`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx#L243).

- **Given** The user opens the Presentation shelf, but the catalog contains a custom document template.
- **When** They open the full template picker, switch to Document, select the template, and send the draft.
- **Then** The picker closes, the composer shows the template and preserves the draft, and the creation task updates to Document. Sending uses the selected custom template and includes the instruction to create a document.

## composer-custom-template-recommendations-009

Original test `The Image shelf imports a reusable style without requesting image generation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx#L303).

- **Given** The user has a draft in the Image composer and opens the Image shelf.
- **When** They paste an unsupported PDF, then import a valid WEBP image as a reusable style.
- **Then** The PDF is not attached and does not send a message; the draft remains and an Image removal control is present. The WEBP starts a reusable-template analysis and publish message containing the file, without selecting a generation template, and navigates to a chat.

## composer-custom-template-recommendations-010

Original test `Presentation refreshes published and removed custom templates while the shelf stays open`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx#L348).

- **Given** The user has the Presentation shelf open with a custom template in the catalog.
- **When** A catalog-change event occurs after the old template is removed and a new template is published.
- **Then** The shelf remains open, shows the newly published template, and no longer shows the removed template.

## composer-custom-template-recommendations-011

Original test `Image refreshes published and removed custom templates while the shelf stays open`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx#L348).

- **Given** The user has the Image shelf open with a custom template in the catalog.
- **When** A catalog-change event occurs after the old template is removed and a new template is published.
- **Then** The shelf remains open, shows the newly published template, and no longer shows the removed template.

## composer-custom-template-recommendations-012

Original test `Document refreshes published and removed custom templates while the shelf stays open`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx#L348).

- **Given** The user has the Document shelf open with a custom template in the catalog.
- **When** A catalog-change event occurs after the old template is removed and a new template is published.
- **Then** The shelf remains open, shows the newly published template, and no longer shows the removed template.

## composer-custom-template-recommendations-013

Original test `The Document shelf imports a reusable document without requesting document generation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx#L373).

- **Given** The user opens the Document shelf with no custom templates available.
- **When** They import a DOCX document as a reusable template.
- **Then** The file is sent for reusable-template analysis and publishing, with no document-generation instruction and no selected generation template.

## composer-custom-template-recommendations-014

Original test `The Document picker imports a reusable document without requesting document generation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx#L373).

- **Given** The user opens the Document picker, switches to Custom, and no custom templates are available.
- **When** They import a DOCX document as a reusable template.
- **Then** The file is sent for reusable-template analysis and publishing, with no document-generation instruction and no selected generation template.

## composer-custom-template-recommendations-015

Original test `A failed custom catalog still shows built-in document templates and import`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx#L430).

- **Given** The custom document-template catalog request fails.
- **When** The user opens the Document shelf.
- **Then** Built-in document templates, including Content brief, and the document import option remain available.
