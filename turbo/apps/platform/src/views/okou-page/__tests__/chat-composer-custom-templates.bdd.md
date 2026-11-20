# Chat composer custom templates

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-custom-templates.test.tsx](chat-composer-custom-templates.test.tsx).

## chat-composer-custom-templates-001

Original test `The Custom section lists owned and shared templates of the selected type`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L219).

- **Given** The presentation catalog contains an owned template and a colleague's shared template.
- **When** The user opens the template picker with Presentation selected.
- **Then** The Custom section lists both templates, and the Built-in section is also present.

## chat-composer-custom-templates-002

Original test `A template published while the panel is open appears in it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L246).

- **Given** The template picker is open and already lists a presentation template.
- **When** A new presentation template is published and the catalog changes notification arrives.
- **Then** The newly published template appears in the open Custom section.

## chat-composer-custom-templates-003

Original test `A colleague withdrawing a shared template removes it from the catalog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L282).

- **Given** The Custom section lists an owned template and a colleague's shared template.
- **When** The colleague withdraws the shared template and the catalog changes notification arrives.
- **Then** The shared template disappears, while the updated owned template remains listed.

## chat-composer-custom-templates-004

Original test `A colleague's template names its owner and offers no management`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L305).

- **Given** The catalog contains the user's own template and a colleague's template owned by Robin Ito.
- **When** The user views the Presentation category.
- **Then** The colleague's card identifies Robin Ito as its sharer and has no management actions; the user's own card has management actions.

## chat-composer-custom-templates-005

Original test `Search matches the source file name, not only the title`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L328).

- **Given** The catalog contains a template titled “Renewal deck” whose source filename is “partner-qbr-q3.pptx,” and another titled “Q3 board review.”
- **When** The user searches for “partner-qbr.”
- **Then** “Renewal deck” remains visible and “Q3 board review” is excluded.

## chat-composer-custom-templates-006

Original test `Content categories scope custom templates and reset their search`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L354).

- **Given** The catalog contains presentation, document, and image templates.
- **When** The user switches among Presentation, Document, and Image, searches for “brand-report.docx” under Image, then returns to Document.
- **Then** Each category shows only its own templates; Image reports no matches for the search, and returning to Document clears the search and shows “Brand report.”

## chat-composer-custom-templates-007

Original test `Every category names itself above its templates`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L388).

- **Given** The Custom catalog is empty.
- **When** The user visits Presentation, Document, Website, Image, and Workflow.
- **Then** Each category displays its own heading above the template area.

## chat-composer-custom-templates-008

Original test `An empty Custom section keeps the import tile and built-in styles usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L405).

- **Given** The catalog has a presentation template but no image templates.
- **When** The user selects Image, then returns to Presentation.
- **Then** The empty Image Custom section still offers an import tile accepting PNG, JPG, JPEG, WebP, and BMP files, and Built-in styles remain available; the presentation template is still listed after returning.

## chat-composer-custom-templates-009

Original test `Returning to a type retains the loaded custom catalog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L424).

- **Given** The Presentation catalog has loaded a template, and subsequent catalog requests do not return.
- **When** The user switches to Website and then back to Presentation.
- **Then** The previously loaded template is displayed again without waiting for another catalog response, and search remains available.

## chat-composer-custom-templates-010

Original test `A custom deck steps through its pages on the stage`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L458).

- **Given** The user owns a presentation template with two preview pages.
- **When** The user opens its preview and selects page 2.
- **Then** The preview starts on page 1 and shows “1 / 2” and “2 slides”; page 2 then appears with “2 / 2,” and the next-page control is disabled. The preview offers Rename and Use, but not a separate source-file preview.

## chat-composer-custom-templates-011

Original test `A template shared with you opens without the owner's controls`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L496).

- **Given** The user has access to a presentation template shared by Riley Park but cannot manage it.
- **When** The user opens the template preview.
- **Then** The preview identifies Riley Park as the sharer and offers Use, but no Rename, visibility change, or Delete controls.

## chat-composer-custom-templates-012

Original test `Using a custom template sends the row id and nothing about its kind`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L524).

- **Given** The Custom section lists the user's presentation template “Q3 board review,” which has a cover image.
- **When** The user selects Use.
- **Then** The picker closes and the composer shows a “Q3 board review” template attachment with its cover image. The request identifies the template by row ID and does not send its kind.

## chat-composer-custom-templates-013

Original test `A document template with no cover is tiled by its format`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L584).

- **Given** The catalog contains a DOCX document template with no cover page.
- **When** The user views the Document category.
- **Then** Its card shows “DOCX” and no document cover page.

## chat-composer-custom-templates-014

Original test `A document template with a cover is tiled by its first page over a stack`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L606).

- **Given** The catalog contains a DOCX document template with a cover page and additional pages.
- **When** The user views the Document category.
- **Then** The card displays the cover page instead of the DOCX label and shows two stacked sheets.

## chat-composer-custom-templates-015

Original test `Opening a Word template hands the source file to the Office viewer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L628).

- **Given** The catalog contains the Word template “Brand report” with a source file URL.
- **When** The user opens its preview.
- **Then** The source file is handed to the Office web viewer with the source URL as its src parameter; the preview offers Rename and Use, and the catalog remains visible behind it.

## chat-composer-custom-templates-016

Original test `A PDF template opens in the browser's own viewer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L655).

- **Given** The catalog contains the PDF template “Annual report” with a source file URL.
- **When** The user opens its preview.
- **Then** The browser's own viewer receives the source URL with “#toolbar=0&navpanes=0&view=FitH” appended.

## chat-composer-custom-templates-017

Original test `An image template is shown by the examples its style produced, not its source`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L738).

- **Given** The catalog contains an image template with multiple generated example images and a separate source file.
- **When** The user selects another example and then activates the main preview image.
- **Then** The main image changes to each selected example, including the next example on activation; the source file is not used as the displayed preview.

## chat-composer-custom-templates-018

Original test `An image template with one example has nothing to choose between`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L771).

- **Given** The catalog contains a private image template with exactly one generated example.
- **When** The user views the Image category.
- **Then** The example is displayed, no example choices are offered, and the card identifies the template as Private.

## chat-composer-custom-templates-019

Original test `Rename an image template from its card menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L784).

- **Given** The user owns the image template “Quiet UI mockup.”
- **When** The user chooses Rename from its card menu, enters “ Quiet UI kit ”, and saves.
- **Then** The template is renamed “Quiet UI kit,” the rename dialog closes, and Image remains selected.

## chat-composer-custom-templates-020

Original test `A rename the server refuses keeps the dialog and the typed name`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L815).

- **Given** The user owns “Quiet UI mockup,” and the server refuses a rename.
- **When** The user enters “Quiet UI kit” and saves.
- **Then** The dialog remains open with “Quiet UI kit” in the field, the error “Couldn't rename the template.” appears, and the card retains its original name.

## chat-composer-custom-templates-021

Original test `Clearing the title and leaving the field keeps the template named`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L860).

- **Given** The user's template is named “Q3 board review.”
- **When** The user clears its title field and leaves the field.
- **Then** The template remains named “Q3 board review.”

## chat-composer-custom-templates-022

Original test `Renaming a template updates its card in the panel`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L876).

- **Given** The user's template is named “Q3 board review.”
- **When** The user changes the title to “ Board review FY26 ” and leaves the field.
- **Then** The card displays “Board review FY26” with surrounding and repeated whitespace collapsed; the old title is absent.

## chat-composer-custom-templates-023

Original test `Confirming an IME candidate (composing) keeps the template name focused and unsaved`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L901).

- **Given** The user is editing “Q3 board review” and enters the IME candidate “季度 报告” with surrounding spaces while composition is active.
- **When** The user presses Enter during composition, then ends composition and presses Enter again to save.
- **Then** The first Enter leaves the field focused, enabled, and unchanged, and the old title remains visible. The later Enter saves “季度 报告.”

## chat-composer-custom-templates-024

Original test `Confirming an IME candidate (Safari final Enter) keeps the template name focused and unsaved`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L901).

- **Given** The user is editing “Q3 board review” and enters the IME candidate “四半期 レポート” with surrounding spaces in Safari's final-Enter composition event.
- **When** The user presses Enter with key code 229, then presses Enter again to save.
- **Then** The first Enter leaves the field focused, enabled, and unchanged, and the old title remains visible. The later Enter saves “四半期 レポート.”

## chat-composer-custom-templates-025

Original test `A rejected rename keeps the typed name`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L960).

- **Given** The user is editing “Q3 board review,” and the server refuses a rename.
- **When** The user changes the title to “Board review FY26” and leaves the field.
- **Then** The error “Couldn't rename the template.” appears, and the enabled field retains “Board review FY26.”

## chat-composer-custom-templates-026

Original test `Changing visibility updates the card's meta line`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L982).

- **Given** The user's template is private and its detail view is open.
- **When** The user changes its visibility to organization-wide and closes the detail view.
- **Then** The card shows “Organization” instead of “Private.”

## chat-composer-custom-templates-027

Original test `Deleting an image template keeps its category and other cards`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L997).

- **Given** The Image category contains “Quiet UI mockup” and “Renewal style.”
- **When** The user confirms deletion of “Quiet UI mockup.”
- **Then** That card disappears, “Renewal style” remains, and Image stays selected.

## chat-composer-custom-templates-028

Original test `Cancelling the delete confirmation keeps the template`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L1029).

- **Given** The user's template “Q3 board review” is listed.
- **When** The user opens its delete confirmation and cancels.
- **Then** The confirmation closes and the template remains listed.

## chat-composer-custom-templates-029

Original test `A failed deletion is not reported again on the next confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L1053).

- **Given** The first deletion attempt for “Q3 board review” fails, and its confirmation displays an error.
- **When** The user cancels that confirmation, opens a new one, and confirms deletion again successfully.
- **Then** The new confirmation has no stale deletion error, and the template is removed after the successful attempt.

## chat-composer-custom-templates-030

Original test `A failed visibility change keeps the template and reports the error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L1099).

- **Given** The user's template “Q3 board review” is private, and the server refuses a visibility change.
- **When** The user tries to share it with the organization.
- **Then** The request error is reported; the template remains named “Q3 board review,” its visibility remains Private, and the detail view still says only the user can see and use it.

## chat-composer-custom-templates-031

Original test `A failed deletion keeps the template and reports the error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L1099).

- **Given** The user's template “Q3 board review” is private, and the server refuses deletion.
- **When** The user confirms deletion.
- **Then** The request error is reported; the template remains listed and named “Q3 board review,” its visibility remains Private, and the detail view still says only the user can see and use it.

## chat-composer-custom-templates-032

Original test `Each content type offers a format-specific import tile with an empty catalog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L1134).

- **Given** The Custom catalog is empty.
- **When** The user visits Presentation, Document, and Image.
- **Then** The import tile accepts PPTX, PPT, and PDF for presentations; DOCX and DOC for documents; and PNG, JPG, JPEG, WebP, and BMP for images. Built-in styles are also available.

## chat-composer-custom-templates-033

Original test `Importing a document uses the custom template dispatcher`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L1155).

- **Given** The user is in the Document category and has a DOCX file to import.
- **When** The user imports the file to start a run.
- **Then** The run receives the request “Analyse this file and save it as a reusable template.” and additional guidance directing the dispatcher to the extract-template skill in okou-ai/okou-skills, follow its file-specific branch, and publish with the resulting kind so the template appears under Custom.

## chat-composer-custom-templates-034

Original test `Choosing a source leaves the picker for the thread it starts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L1192).

- **Given** The user is in an existing chat thread with the template picker open and a DOCX file to import.
- **When** The user chooses the file and the resulting run starts in that thread.
- **Then** The picker closes.

## chat-composer-custom-templates-035

Original test `Custom is a document filter beside All and the built-in purposes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L1230).

- **Given** The Document category contains the custom template “Brand report” and a built-in “Two-column report” style.
- **When** The user selects the Reports filter and then the Custom filter.
- **Then** Reports shows the built-in style without the Custom section; Custom shows “Brand report” without the Built-in section.

## chat-composer-custom-templates-036

Original test `A failed custom catalog leaves built-in templates available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.test.tsx#L1252).

- **Given** The template picker is open and the custom template catalog request fails.
- **When** The user views the Presentation category.
- **Then** The Custom region shows “Couldn't load templates.” and still offers an enabled “Import your own deck” control; the Built-in region remains available.
