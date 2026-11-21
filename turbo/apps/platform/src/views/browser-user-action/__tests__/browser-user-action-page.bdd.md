# Browser user action page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-user-action-page.test.tsx](browser-user-action-page.test.tsx).

Batch 39 accepted 001, 003, 007–019, 021, 026, 028, 034, 036, 039, 040, 041, 047, 049, 051 and 053. Selected 002 still lacks a separate fallback explanation. For 043 the editable form is present while preflight is pending, before the stale status replaces it. See the [batch evidence](../../../../test-rebuild-rework-checkpoint.md#batch-39-evidence).

## browser-user-action-page-001

Original test `The standalone route completes native input (task context: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L433).

- **Given** A pending browser request includes invoice sign-in context.
- **When** The user opens its standalone route and submits the required email address.
- **Then** The form shows the sign-in title, website reason, account guidance, and website origin. Submission sends the email and callback prompt, and the page reports that the agent was notified.

## browser-user-action-page-002

Original test `The standalone route completes native input (task context: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L433).

- **Given** A pending browser request has no task context.
- **When** The user opens its standalone route and submits the required email address.
- **Then** The form uses “Enter information in browser” as its title and explanation. Submission sends the email and callback prompt, and the page reports that the agent was notified.

## browser-user-action-page-003

Original test `Saved-password help preserves credential input and is scoped to username requests`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L510).

- **Given** A credential request contains a username field.
- **When** The user opens the request, enters an email address, and toggles “How to fill” on and off.
- **Then** Saved-password help is available; its instructions appear and disappear without clearing the entered email address.

## browser-user-action-page-004

Original test `Saved-password help preserves credential input and is scoped to password requests`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L510).

- **Given** A credential request contains a password field.
- **When** The user opens the request, enters a password, and toggles “How to fill” on and off.
- **Then** Saved-password help is available; its instructions appear and disappear without clearing the entered password.

## browser-user-action-page-005

Original test `Saved-password help preserves credential input and is scoped to one_time_code requests`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L510).

- **Given** A request contains only a one-time-code field.
- **When** The user opens the request.
- **Then** Saved-password help is not shown.

## browser-user-action-page-006

Original test `Saved-password help preserves credential input and is scoped to text requests`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L510).

- **Given** A request contains only a text field.
- **When** The user opens the request.
- **Then** Saved-password help is not shown.

## browser-user-action-page-007

Original test `A required native slider starts at the website position and needs deliberate confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L555).

- **Given** A required slider has website value 19, minimum 10, maximum 20, and step any.
- **When** The user opens the form, explicitly confirms the current value, and submits.
- **Then** The slider starts at 19 and submission is disabled until confirmation. Submission sends value 19 with the observed website value and constraints.

## browser-user-action-page-008

Original test `An optional native slider stays untouched unless the user changes it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L608).

- **Given** An optional slider has website value 19 and observed bounds 10 to 20.
- **When** The user changes it to 16, then restores 19 and submits.
- **Then** The displayed position follows the changes, but submission contains no slider value because the final value matches the website value.

## browser-user-action-page-009

Original test `An optional native slider submits a changed position with its observed snapshot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L652).

- **Given** An optional slider has website value 19 and observed bounds 10 to 20.
- **When** The user changes it to 16 and submits.
- **Then** Submission sends value 16 with the observed website value 19, minimum 10, maximum 20, and step any.

## browser-user-action-page-010

Original test `A required native color starts from the website and needs explicit confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L703).

- **Given** A required color field has website color #123abc.
- **When** The user opens the form, explicitly confirms the current color, and submits.
- **Then** The picker starts at #123abc and submission is disabled until confirmation. Submission sends #123abc with the observed website color.

## browser-user-action-page-011

Original test `An optional native color remains untouched or submits an explicit change`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L749).

- **Given** An optional color field has website color #123abc.
- **When** The user changes it to #00ff00, restores #123abc, and submits.
- **Then** The picker displays each changed color, but submission contains no color value because its final color matches the website value.

## browser-user-action-page-012

Original test `A changed native color submits its observed website snapshot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L793).

- **Given** An optional color field has website color #123abc.
- **When** The user changes it to #00ff00 and submits.
- **Then** Submission sends #00ff00 with observed website color #123abc.

## browser-user-action-page-013

Original test `A standalone native file input transfers chosen bytes only on confirmed submission`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L834).

- **Given** A required file field is empty and accepts multiple .txt files on the uploads website.
- **When** The user selects a 4-byte text file named note.txt and confirms submission.
- **Then** Selecting the file alone does not upload it. Submission starts a direct upload without credentials or a checksum header; while it is pending, submission, cancellation, and the file field are disabled. The upload completes before the file details are applied with the observed file-set fingerprint.

## browser-user-action-page-014

Original test `An optional file selection leaves existing website files untouched`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L939).

- **Given** An optional file field already contains old.txt on the website.
- **When** The user leaves the selection unchanged and submits.
- **Then** The existing website file remains represented in the form, and submission sends no file changes.

## browser-user-action-page-015

Original test `A required file field can retain already selected website files`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L977).

- **Given** A required file field already contains old.txt on the website.
- **When** The user keeps the existing file and submits.
- **Then** Submission sends a keep operation with no replacement files and the observed file-set fingerprint; the agent is notified.

## browser-user-action-page-016

Original test `The standalone form accepts input and submission while its background check is pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1023).

- **Given** A standalone request is available while its background check has started but not finished.
- **When** The user enters the required email and submits before the check is released.
- **Then** The form indicates the request is being checked but still permits input and submission. The email is applied and the agent is notified.

## browser-user-action-page-017

Original test `The standalone form uses preflight's observed multiline and email controls`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1074).

- **Given** Preflight reports a required multiple email input and an optional multiline text field with minimum length 3.
- **When** The user enters an email address and two lines of text, then submits.
- **Then** The form uses an email control that is required and accepts multiple values, plus a textarea with minimum length 3. Submission preserves the multiline value and the agent is notified.

## browser-user-action-page-018

Original test `The standalone form uses the existing input style with live number constraints`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1139).

- **Given** A required quantity field has minimum 10, maximum 20, and step 0.5.
- **When** The user enters 12.5 and submits.
- **Then** The number input exposes those live constraints and is required. Submission sends 12.5, and the agent is notified.

## browser-user-action-page-019

Original test `Optional number field can be untouched or cleared using its input (false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1184).

- **Given** An optional number field has minimum 10, maximum 20, and step 0.5.
- **When** The user leaves it untouched and submits.
- **Then** Submission contains no quantity value, and the agent is notified.

## browser-user-action-page-020

Original test `Optional number field can be untouched or cleared using its input (true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1184).

- **Given** An optional number field has minimum 10, maximum 20, and step 0.5.
- **When** The user enters 12.5, clears the field, and submits.
- **Then** Submission explicitly sends an empty quantity value, and the agent is notified.

## browser-user-action-page-021

Original test `A native date picker submits its local canonical string`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1231).

- **Given** An optional native date field is available.
- **When** The user selects September 25, 2026 and submits.
- **Then** The form uses a date picker and submits the canonical string 2026-09-25; the agent is notified.

## browser-user-action-page-022

Original test `A native time picker submits its local canonical string`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1231).

- **Given** An optional native time field is available.
- **When** The user selects 09:30 and submits.
- **Then** The form uses a time picker and submits the canonical string 09:30; the agent is notified.

## browser-user-action-page-023

Original test `A native datetime-local picker submits its local canonical string`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1231).

- **Given** An optional native datetime-local field is available.
- **When** The user selects September 25, 2026 at 09:30 and submits.
- **Then** The form uses a datetime-local picker and submits the canonical string 2026-09-25T09:30; the agent is notified.

## browser-user-action-page-024

Original test `A native month picker submits its local canonical string`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1231).

- **Given** An optional native month field is available.
- **When** The user selects September 2026 and submits.
- **Then** The form uses a month picker and submits the canonical string 2026-09; the agent is notified.

## browser-user-action-page-025

Original test `A native week picker submits its local canonical string`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1231).

- **Given** An optional native week field is available.
- **When** The user selects week 39 of 2026 and submits.
- **Then** The form uses a week picker and submits the canonical string 2026-W39; the agent is notified.

## browser-user-action-page-026

Original test `An optional date can be untouched or explicitly cleared (false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1272).

- **Given** An optional date field is initially empty.
- **When** The user leaves it untouched and submits.
- **Then** Submission contains no arrival value, and the agent is notified.

## browser-user-action-page-027

Original test `An optional date can be untouched or explicitly cleared (true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1272).

- **Given** An optional date field is initially empty.
- **When** The user enters 2026-09-25, clears it, and submits.
- **Then** Submission explicitly sends an empty arrival value, and the agent is notified.

## browser-user-action-page-028

Original test `An optional checkbox submits an explicit false rather than the website's true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1314).

- **Given** An optional consent checkbox is checked on the website.
- **When** The user unchecks it and submits.
- **Then** Submission sends false and reports the observed website state as checked; the agent is notified.

## browser-user-action-page-029

Original test `An optional checkbox submits an explicit true rather than the website's false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1314).

- **Given** An optional consent checkbox is unchecked on the website.
- **When** The user checks it and submits.
- **Then** Submission sends true and reports the observed website state as unchecked; the agent is notified.

## browser-user-action-page-030

Original test `An untouched optional checkbox preserves a checked website value`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1369).

- **Given** An optional consent checkbox is checked on the website.
- **When** The user leaves it unchanged and submits.
- **Then** The checkbox remains checked and submission contains no changes; the agent is notified.

## browser-user-action-page-031

Original test `A required checked checkbox submits its valid website state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1412).

- **Given** A required consent checkbox is already checked on the website.
- **When** The user submits without changing it.
- **Then** The checkbox is enabled and checked, and submission sends true with the observed website state checked; the agent is notified.

## browser-user-action-page-032

Original test `A radio group submits an indexed choice without its duplicate value`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1458).

- **Given** A radio group has three options with identical labels, the first selected, and the third disabled.
- **When** The user selects the second option and submits.
- **Then** The disabled option remains unavailable, and submission identifies the selected option by index 1 with observed selection index 0 and the group fingerprint, without sending a duplicate option value. The agent is notified.

## browser-user-action-page-033

Original test `An untouched optional radio group preserves the existing selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1512).

- **Given** An optional radio group has its first option selected on the website.
- **When** The user leaves the selection unchanged and submits.
- **Then** Submission contains no radio-group changes, and the agent is notified.

## browser-user-action-page-034

Original test `An Agent-required radio group submits its existing valid website choice`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1551).

- **Given** An Agent-required radio group already has its first option selected on the website.
- **When** The user submits without changing it.
- **Then** Submission sends member index 0 with observed selection index 0 and the group fingerprint; the agent is notified.

## browser-user-action-page-035

Original test `The standalone form selects a required native option by index, not its website value`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1598).

- **Given** A required single-select field has options Choose, First, Second, and a disabled Unavailable option.
- **When** The user selects Second and submits.
- **Then** Submission sends option index 2 with the option-set fingerprint, rather than the website option value; the agent is notified.

## browser-user-action-page-036

Original test `A required multiple select cannot keep a disabled website choice and drops it on change`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1651).

- **Given** A required multiple-select field has a website snapshot with its disabled “Unavailable” choice selected.
- **When** The user changes the selection to “Second” and submits.
- **Then** The form initially disables submission, then enables it after the change. The applied selection contains only “First” and “Second,” and the agent is notified.

## browser-user-action-page-037

Original test `An optional multiple select distinguishes untouched from an explicit clear`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1724).

- **Given** An optional multiple-select field has “First” selected in the website snapshot.
- **When** The user explicitly deselects “First” and submits.
- **Then** The applied value is an empty selection, and the agent is notified.

## browser-user-action-page-038

Original test `An optional single select clears its website selection through the native empty option`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1774).

- **Given** An optional single-select field has “First” selected in the website snapshot.
- **When** The user chooses the native empty option and submits.
- **Then** The applied value is an empty selection, and the agent is notified.

## browser-user-action-page-039

Original test `Leaving and returning to a standalone form clears password and code drafts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1846).

- **Given** A user has entered a password and verification code in a standalone browser-input form.
- **When** The user leaves the page and returns using browser history.
- **Then** The password and verification code fields are empty.

## browser-user-action-page-040

Original test `The standalone form records cancellation before notifying the agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1884).

- **Given** A standalone browser-input request is pending.
- **When** The user cancels it.
- **Then** The request is recorded as cancelled before the agent is notified, and the page shows “Agent notified.”

## browser-user-action-page-041

Original test `A completed Browser input clears sensitive values when its callback fails`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1917).

- **Given** A user has entered email, password, and verification code in a pending browser-input form.
- **When** Applying the input succeeds but sending the callback fails with a chat-unavailable error.
- **Then** The page shows both “Information added” and “Chat unavailable,” and all entered values are removed.

## browser-user-action-page-042

Original test `A fresh standalone action page reads accepted callback delivery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1964).

- **Given** A standalone action page loads a succeeded request whose callback has already been delivered.
- **When** The page displays the request status.
- **Then** It shows “Agent notified.”

## browser-user-action-page-043

Original test `Standalone preflight makes a confirmed changed target stale before showing fields`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L1978).

- **Given** A standalone pending request becomes stale during preflight because its target changed.
- **When** The page completes preflight.
- **Then** It shows “Fields changed” and guidance to ask the agent for a new request, without showing a form.

## browser-user-action-page-044

Original test `A thread change reconciles a lost apply response and clears sensitive drafts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L2001).

- **Given** A user has entered email, password, and verification code in a pending standalone form. Applying the input reaches succeeded on the server, but the response is lost and callback delivery initially fails.
- **When** The thread signals that the request changed.
- **Then** The page reconciles to “Information added” and removes the entered values.

## browser-user-action-page-045

Original test `A thread change reconciles a lost cancel response and clears sensitive drafts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L2001).

- **Given** A user has entered email, password, and verification code in a pending standalone form. Cancelling reaches cancelled on the server, but the response is lost and callback delivery initially fails.
- **When** The thread signals that the request changed.
- **Then** The page reconciles to “Request cancelled” and removes the entered values.

## browser-user-action-page-046

Original test `A populated standalone form removes sensitive inputs after stale feedback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L2075).

- **Given** A user has entered sensitive values in a pending standalone form.
- **When** Applying the request returns stale feedback.
- **Then** The page shows “Fields changed,” removes the form, and removes the password and verification code values.

## browser-user-action-page-047

Original test `A populated standalone form removes sensitive inputs after uncertain feedback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L2075).

- **Given** A user has entered sensitive values in a pending standalone form.
- **When** Applying the request returns uncertain feedback.
- **Then** The page shows “Check the browser,” removes the form, and removes the password and verification code values.

## browser-user-action-page-048

Original test `A populated standalone form removes sensitive inputs after expired feedback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L2075).

- **Given** A user has entered sensitive values in a pending standalone form.
- **When** Applying the request returns an expired response.
- **Then** The page shows “Request expired,” removes the form, and removes the password and verification code values.

## browser-user-action-page-049

Original test `An initially applying action reaches succeeded`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L2126).

- **Given** A standalone browser-input request is initially applying and then resolves as succeeded.
- **When** The page loads and checks the request status.
- **Then** It shows “Information added” without a form.

## browser-user-action-page-050

Original test `An initially applying action reaches cancelled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L2126).

- **Given** A standalone browser-input request is initially applying and then resolves as cancelled.
- **When** The page loads and checks the request status.
- **Then** It shows “Request cancelled” without a form.

## browser-user-action-page-051

Original test `An initially applying action reaches stale`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L2126).

- **Given** A standalone browser-input request is initially applying and then resolves as stale.
- **When** The page loads and checks the request status.
- **Then** It shows “Fields changed” without a form.

## browser-user-action-page-052

Original test `An initially applying action reaches uncertain`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L2126).

- **Given** A standalone browser-input request is initially applying and then resolves as uncertain.
- **When** The page loads and checks the request status.
- **Then** It shows “Check the browser” without a form.

## browser-user-action-page-053

Original test `An applying action settles when the thread signals a change`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L2147).

- **Given** A standalone browser-input request is applying and the page is checking its status.
- **When** The thread signals a change and the request is now uncertain.
- **Then** The page shows “Check the browser” without a form.

## browser-user-action-page-054

Original test `Projects the uncertain API state without a form`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L2173).

- **Given** A standalone browser-input request is in the uncertain API state.
- **When** The page loads the request.
- **Then** It shows “Check the browser” without a form.

## browser-user-action-page-055

Original test `Projects the cancelled API state without a form`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L2173).

- **Given** A standalone browser-input request is in the cancelled API state.
- **When** The page loads the request.
- **Then** It shows “Request cancelled” without a form.

## browser-user-action-page-056

Original test `Maps an expired API response to the inert expiry state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L2193).

- **Given** The standalone action endpoint reports that the request has expired.
- **When** The page loads the request.
- **Then** It shows “Request expired.”

## browser-user-action-page-057

Original test `Fails closed for a mismatched response`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-user-action/__tests__/browser-user-action-page.test.tsx#L2211).

- **Given** The standalone action endpoint returns a pending request for a different agent than the one in the page URL.
- **When** The page loads the response.
- **Then** It fails closed and shows “Request unavailable.”
