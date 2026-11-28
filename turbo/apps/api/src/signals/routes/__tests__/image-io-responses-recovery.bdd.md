# image-io-responses-recovery

## image-io-responses-recovery-001

- Vitest: "durable image settlement recovery > resumes an interrupted debit through a fresh owner request without charging twice"
- Mode: run
- Given: A Run can submit an image generation with an organization balance of 20,000 credits. The image provider completes its one submission, and the original Run ends successfully while the image remains pending.
- When: The owner reconciles the pending image, then reconciliation is interrupted during terminal usage notification. The owner reads status and retries reconciliation twice from a fresh request.
- Then: The initial reconcile returns HTTP 200 with running status and no debit. The interrupted attempt returns HTTP 500, readback remains running and the balance has dropped by seven. The retry completes the same generation with nine credits charged in total. Repeating it returns the same result, does not debit again and does not submit another upstream generation.
