# Org billing tab

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [org-billing-tab.test.tsx](org-billing-tab.test.tsx).

## org-billing-tab-001

Original test `The iOS billing management link opens Billing settings (My Okou=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L284).

- **Given** A user opens billing settings on iOS with My Okou disabled.
- **When** They visit the billing settings link.
- **Then** Billing settings opens with the Billing heading.

## org-billing-tab-002

Original test `The iOS billing management link opens Billing settings (My Okou=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L284).

- **Given** A user opens billing settings on iOS with My Okou enabled.
- **When** They visit the billing settings link.
- **Then** Billing settings opens with the Billing heading.

## org-billing-tab-003

Original test `Compare both usage-pack prices before choosing a plan`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L430).

- **Given** A workspace has no active plan and is choosing a plan for a usage-pack purchase.
- **When** The user compares Pro and Team plans.
- **Then** Pro shows 3 concurrent tasks, automations, and pricing from $20/month (a $0 plan plus $20–$200 member packages). Team shows pricing from $180/month (a $160 plan plus $20–$200 member packages). The user is told to choose a paid package for each member or no package in the next step, and member usage controls are not shown yet.

## org-billing-tab-004

Original test `Default new 'pro' member packages through 'checkout preview'`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L462).

- **Given** A workspace has no active plan and has two members and one pending invite.
- **When** The user starts a Pro plan checkout preview.
- **Then** All three members default to the $20 package with 21,234 credits and 6% off. The Pro upgrade can be submitted for review, and cancelling the review returns from it.

## org-billing-tab-005

Original test `Default new 'team' member packages through 'checkout preview'`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L462).

- **Given** A workspace has no active plan and has two members and one pending invite.
- **When** The user starts a Team plan checkout preview.
- **Then** All three members default to the $20 package with 21,234 credits and 6% off. The Team upgrade can be submitted for review, and cancelling the review returns from it.

## org-billing-tab-006

Original test `Configure member packages for a new workspace plan`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L525).

- **Given** A workspace with two members and one pending invite is choosing a new Team plan.
- **When** The user configures the members' packages, then changes Alex to $50 and the pending invite to $100.
- **Then** All three start with $20 packages; packages are optional, and overages use pay-as-you-go credits. Alex's change updates the total to $250/month, and the final total is 185,554 credits including 15,554 bonus credits at $330/month. Package selectors remain enabled and the Team upgrade can be confirmed.

## org-billing-tab-007

Original test `Add a package for a member without an allocation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L591).

- **Given** An active Pro workspace has Alex allocated a $20 package, Sam with no allocation, and a pending invite already assigned $100.
- **When** The admin assigns Sam a $50 package and confirms the package change.
- **Then** The pending invite remains at 109,999 credits and cannot be changed. Sam's $50 selection is previewed with Alex at $20, and a package-change review opens while the update is in progress.

## org-billing-tab-008

Original test `Gate legacy conversion eligibility before Pro configuration`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L802).

- **Given** A user is converting a legacy subscription and migration eligibility is still loading.
- **When** They wait for eligibility, then choose Pro.
- **Then** Plan selection is withheld while loading; once eligibility resolves, both Pro and Team can be selected. Choosing Pro opens package configuration at step 2 of 3, with a comparison showing the legacy Team plan against Pro and the monthly total.

## org-billing-tab-009

Original test `Prevent a second plan checkout when migration is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L864).

- **Given** An active Pro workspace has no usage-pack subscription and legacy migration is unavailable.
- **When** The admin compares plans.
- **Then** Starting a Team checkout is disabled, preventing a second plan checkout.

## org-billing-tab-010

Original test `Manage member packages on an Atom-granted plan`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L905).

- **Given** An Atom-granted Pro plan is shown as ending, with no regular usage-pack subscription or legacy migration available.
- **When** The admin compares plans and manages Pro member packages.
- **Then** The member's $20 package is shown and the package-configuration action is enabled, but no Pro upgrade action appears in the order summary.

## org-billing-tab-011

Original test `Compare legacy Team packages and review conversion totals`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L1252).

- **Given** A legacy Team subscription is being converted to the current Team plan with $70 in member packages.
- **When** The user reviews the conversion totals.
- **Then** The comparison shows plan Team Legacy to Team, member packages $0 to $70, 10 concurrent slots unchanged, purchased credits 120,000 to 70,000, bonus credits 0 to 5,555, and monthly totals $200 to $230. The conversion is scheduled for Sep 1, 2026; its review shows a $160 Team plan, $70 packages, 75,555 credits including 5,555 bonus, 10 concurrent runs, and a $229.50 monthly total, with confirmation available.

## org-billing-tab-012

Original test `Confirm a legacy Team conversion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L1348).

- **Given** A legacy Team conversion has been configured for Sep 1, 2026.
- **When** The user reviews and confirms the conversion.
- **Then** The app says the subscription change is confirmed and shows that it switches to Team on Sep 1, 2026. The legacy indicator remains, and no separate scheduled-conversion notice appears.

## org-billing-tab-013

Original test `Review and revise an already scheduled legacy Team conversion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L1369).

- **Given** A legacy Team conversion to Team is already scheduled for Sep 1, 2026.
- **When** The user reopens plan management, then backs out of unchanged Team package settings and selects a Pro downgrade for review and confirmation.
- **Then** Unchanged Team settings have no Current plan or Review conversion action. Revising the conversion opens package configuration and a final review; confirming shows that the plan switches to Pro on Sep 1, 2026.

## org-billing-tab-014

Original test `Upgrade a current member package in the app`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L1419).

- **Given** An active Pro workspace has Alex on a $20 package and an admin managing billing.
- **When** The admin changes Alex to $50 and confirms the in-app package change.
- **Then** The comparison shows package price $20 to $50, purchased credits 20,000 to 50,000, bonus credits 1,234 to 4,321, and monthly total $20 to $50. Review shows $15 due for the remainder of the period, a 16,100-credit grant expiring Apr 1, 2026, and 54,321 monthly credits with 4,321 bonus at $50/month. After confirmation, the selected package remains visible while processing and roster refreshes; the URL does not change, and the order actions disappear once the change is processing or applied.

## org-billing-tab-015

Original test `Hide retained package records for people who left the workspace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L1743).

- **Given** An active Pro workspace has Alex and a retained $50 package record for a person who left; that record is scheduled for removal.
- **When** The admin manages member packages and changes Alex to $50.
- **Then** Only Alex appears in the member list; the departed person and their package selector are hidden. The package change can be confirmed.

## org-billing-tab-016

Original test `Restore a member package scheduled to downgrade to $50`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L1847).

- **Given** Alex has a $100 package scheduled to downgrade to $50 on Apr 1, 2026.
- **When** The admin selects the $100 package and restores the scheduled package change.
- **Then** The scheduled downgrade and its notice are shown initially, with no change actions until a selection is made. The comparison shows $50 to $100, and restoring through package-change review leaves Alex at $100, removes the downgrade notice, and returns to a no-action state.

## org-billing-tab-017

Original test `Validate a member package downgrade to 100 (replacing: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L2034).

- **Given** Alex has a $200 package with an existing scheduled downgrade to $50 on Apr 1, 2026.
- **When** The admin selects $20, then replaces the scheduled change with $100 and confirms it.
- **Then** The notice updates to a $20 downgrade and then a $100 downgrade on Apr 1, 2026, replacing the old $50 target. The $100 change can be confirmed and is shown as scheduled for that date.

## org-billing-tab-018

Original test `Validate a member package downgrade to 0 (replacing: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L2034).

- **Given** Alex has a $200 package with no scheduled change.
- **When** The admin selects $20, then selects no package as the downgrade target.
- **Then** The notice updates to a removal effective Apr 1, 2026, replacing the earlier $20 target. Confirmation is disabled and the user is told at least one member must have a paid package; no review can proceed.

## org-billing-tab-019

Original test `Compare the initial Pro-to-Team plan, slots and monthly total`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L2309).

- **Given** An active Pro workspace is preparing to move to Team.
- **When** The user reviews the initial plan comparison.
- **Then** The comparison shows Pro at $0 versus Team at $160, concurrent slots increasing from 3 to 10, and monthly totals increasing from $20 to $180.

## org-billing-tab-020

Original test `Update Pro-to-Team pricing when increasing a member package`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L2358).

- **Given** An active Pro workspace is preparing to move to Team with member packages.
- **When** The user increases a member package and reviews the updated pricing.
- **Then** The Team change can be confirmed after the package increase.

## org-billing-tab-021

Original test `Confirm a Pro-to-Team upgrade without repurchasing existing packages`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L2363).

- **Given** An active Pro workspace is preparing to move to Team without changing existing packages.
- **When** The user opens and confirms the package-change review.
- **Then** The review shows $80 due and a $180 monthly total. Confirmation returns to package configuration without changing the browser URL.

## org-billing-tab-022

Original test `Require a paid member package before previewing a Team-to-Pro downgrade`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L2489).

- **Given** A Team workspace is preparing to downgrade to Pro and Alex is its only member.
- **When** The user selects no package, then selects a paid $20 package and proceeds to review.
- **Then** No package disables the downgrade and displays a requirement to keep at least one paid member package. Selecting $20 enables the action and removes the requirement; the review opens.

## org-billing-tab-023

Original test `Review and confirm a scheduled Team-to-Pro downgrade`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L2515).

- **Given** A Team-to-Pro downgrade is scheduled for Apr 1, 2026, with a $20 monthly target.
- **When** The user reviews and confirms the scheduled downgrade.
- **Then** The comparison shows monthly total dropping from $180 to $20, and the notice says the lower package starts Apr 1 while existing credits remain available until expiration. Review has no due-now charge and shows $20/month; confirmation preserves the URL and reports the change confirmed.

## org-billing-tab-024

Original test `Replace a Team cancellation with a Pro downgrade`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L2566).

- **Given** A Team plan cancellation is scheduled for May 1, 2026, and member packages are managed separately.
- **When** The admin selects Pro downgrade and confirms the plan downgrade.
- **Then** A plan-downgrade confirmation appears without opening member-package configuration or previewing package changes. The requested target is Pro.

## org-billing-tab-025

Original test `Open the Buy credits section from a billing deep link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L2663).

- **Given** A user opens billing settings with a deep link to credits on an active Pro plan.
- **When** Billing settings loads the linked section.
- **Then** The Buy credits heading and enabled Quick buy $20.00 action appear, and the section is scrolled into view smoothly at its start.

## org-billing-tab-026

Original test `Show billing controls according to plan capabilities`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L2689).

- **Given** A workspace has no active plan but can buy concurrency and credits, and is allowed automatic top-ups.
- **When** The user opens billing settings.
- **Then** Buy credits, Automatic top-ups, and Concurrency controls are shown according to those capabilities.

## org-billing-tab-027

Original test `Manage workspace payment methods in Stripe`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L2717).

- **Given** An active Pro workspace has payment methods available.
- **When** The user selects Manage for payment methods.
- **Then** The browser navigates to the Stripe customer portal.

## org-billing-tab-028

Original test `Manage paid concurrency while the Team plan is ending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L2748).

- **Given** A Team plan cancellation is scheduled for Jun 1, 2026, with five paid concurrency slots active until then.
- **When** The user previews increasing slots to six, cancels that dialog, and examines plan restoration; after a billing update schedules a reduction to three slots, they restore concurrency.
- **Then** The change dialog cannot reduce below the current five and does not offer cancellation of the whole subscription. Plan restoration explains that five paid slots continue renewing and does not disable slot management when cancelled. The scheduled three-slot reduction can be restored; the app confirms concurrency renewal is restored while the Team plan remains due to end Jun 1.

## org-billing-tab-029

Original test `Cancel and restore a paid concurrency subscription`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L2897).

- **Given** A Team workspace has 10 included and two paid concurrency slots, renewing Jun 1, 2026.
- **When** The user cancels the paid concurrency subscription, then restores it.
- **Then** The cancellation review says slots remain active through the current period. Confirmation reports cancellation with slots active until Jun 1; restoration confirms renewal resumes, without changing the plan.

## org-billing-tab-030

Original test `Increase an active paid concurrency subscription`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L3016).

- **Given** A Team workspace has 10 included and two paid concurrency slots, renewing Jun 1, 2026.
- **When** The user increases paid slots from two to four and pays through the reviewed change.
- **Then** The review shows four slots, $150 due today, and $400/month. Paying submits four slots and navigates to the hosted invoice.

## org-billing-tab-031

Original test `Buy paid concurrency with an in-app review`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L3116).

- **Given** A Team workspace can buy paid concurrency with an in-app price review.
- **When** The user enters five slots, reviews the purchase, and pays to add them.
- **Then** An empty quantity disables review. Five slots show $210/month; review shows $120 due today and $360/month. Payment submits five slots, reports that they become available after Stripe confirms the subscription, and closes the review.

## org-billing-tab-032

Original test `Buy concurrency when an in-app price preview is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L3201).

- **Given** A Team workspace can buy paid concurrency, but an in-app price preview is unavailable.
- **When** The user opens the purchase dialog and buys the default quantity.
- **Then** The price is displayed as unavailable, and buying submits one slot and navigates to hosted checkout for quantity one.

## org-billing-tab-033

Original test `Schedule and restore a paid-concurrency reduction`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L3242).

- **Given** A Team workspace has five paid concurrency slots and no scheduled quantity change.
- **When** The user schedules a reduction to three slots for Jun 1, then restores the subscription.
- **Then** The review says current slots remain active through the billing period, the lower quantity starts at renewal, and there is no refund or account credit; it shows $300/month and no due-today amount. Scheduling preserves the URL and displays the three-slot change date; restoration removes it and re-enables Change.

## org-billing-tab-034

Original test `Keep paid concurrency within supported quantity limits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L3393).

- **Given** A Team workspace has one paid concurrency slot and a supported maximum quantity of 1,000.
- **When** The user tries to decrease below one and increase above 1,000.
- **Then** The quantity stays at one when set to zero and at 1,000 when set to 1,001. Decrease is disabled at one, increase is disabled at 1,000, and 1,000 slots display $100,000/month.

## org-billing-tab-035

Original test `Confirm a plan cancellation in hosted checkout when required`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L3443).

- **Given** An active Pro workspace requires hosted checkout to confirm its cancellation.
- **When** The user confirms cancellation from the downgrade dialog.
- **Then** The browser is sent to Stripe checkout, the return URL includes the pending downgrade to limited-free-1, and the downgrade dialog closes.

## org-billing-tab-036

Original test `Confirm a scheduled cancellation after returning from hosted payment`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L3487).

- **Given** The user returns to Billing with a Pro plan cancellation scheduled to take effect on April 1, 2026.
- **When** They open Billing with the pending cancellation return marker.
- **Then** A cancellation-scheduled confirmation says the current plan remains active until then. The billing tab stays selected and the pending marker is removed from the URL.

## org-billing-tab-037

Original test `Restore a plan after hosted payment confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L3520).

- **Given** The user has an ending Pro plan that can be restored.
- **When** They choose Restore plan, confirm the restore, and are sent to hosted payment confirmation because a payment method is required.
- **Then** The app redirects to hosted checkout with a return URL marked for a pending restore. The confirmation dialog closes, and no success message appears until billing reports the restored plan; after that update, a plan-restored message appears.

## org-billing-tab-038

Original test `Confirm a restored plan after returning from hosted payment`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L3589).

- **Given** The user's plan has been restored, and they return to Billing with the pending restore marker.
- **When** The Billing page loads.
- **Then** A plan-restored confirmation appears, the billing tab stays selected, and the pending marker is removed from the URL.

## org-billing-tab-039

Original test `Hide Restore when an ending plan cannot be restored`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L3609).

- **Given** The user has an ending plan that cannot be restored.
- **When** They open Billing.
- **Then** The page says the plan was cancelled and will end on April 1, 2026, and does not show a Restore plan option.

## org-billing-tab-040

Original test `Buy credits with a saved payment method in the app`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L3640).

- **Given** The user can buy credits and has a saved payment method.
- **When** They quick-buy $20 in the app and confirm the one-time charge.
- **Then** The review shows $18 due today for 20,000 credits, with no monthly charge. The app does not redirect to hosted checkout; after confirmation, the review closes and the balance updates to 32,500 credits.

## org-billing-tab-041

Original test `Buy a custom credit amount in hosted checkout`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L3731).

- **Given** The user is on the Pro billing plan and can buy a custom credit amount.
- **When** They enter $35 and choose Quick buy $35.00.
- **Then** The app redirects to hosted checkout without showing an in-app review dialog, requesting 35,000 credits as a custom amount.

## org-billing-tab-042

Original test `Invalid automatic top-ups can be discarded while saving is disabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L3763).

- **Given** The user enables automatic top-ups and enters an invalid threshold of 0.
- **When** They discard the unsaved changes while saving is disabled.
- **Then** Automatic top-ups return to disabled, the unsaved-changes bar disappears, and the threshold field is removed.

## org-billing-tab-043

Original test `Re-enable automatic top-ups after repeated payment failures`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L3788).

- **Given** Automatic top-ups were enabled with a 2,000-credit threshold and a 10,000-credit amount, then disabled after repeated payment failures.
- **When** The user re-enables them and saves without changing those values.
- **Then** The existing threshold and amount are restored, the failure warning remains while the changes are unsaved, and after saving top-ups are enabled and the warning and unsaved-changes bar disappear.

## org-billing-tab-044

Original test `Save automatic credit top-ups`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx#L3832).

- **Given** The user is on the Pro billing plan with automatic top-ups disabled.
- **When** They enable top-ups, set a 2,000-credit threshold and a 10,000-credit amount, and save.
- **Then** The unsaved-changes bar shows a $10.00 top-up amount. After saving, the bar disappears and the enabled setting, threshold, amount, and $10.00 display remain.
