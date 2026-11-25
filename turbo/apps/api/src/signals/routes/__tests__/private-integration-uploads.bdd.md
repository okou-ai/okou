# private-integration-uploads

## private-integration-uploads-001

- Vitest: "Feishu uploads stay private through completion"
- Mode: run
- Given: An authenticated member with the relevant integration enabled has a private 12-byte text file to upload through Feishu.
- When: The member initializes the Feishu upload, PUTs the bytes to the returned URL, completes it and resolves the preview. The same user tries resolving it again in another organization.
- Then: Initialization and PUT return HTTP 200 and the upload goes to private artifact storage. Completion returns HTTP 200 and retains the same artifact URL. Owner preview resolves HTTP 200 with null public URL and uses a signed private-bucket download. The other organization receives HTTP 404.

## private-integration-uploads-002

- Vitest: "Lark uploads stay private through completion"
- Mode: run
- Given: An authenticated member with the relevant integration enabled has a private 12-byte text file to upload through Lark.
- When: The member initializes the Lark upload, PUTs the bytes to the returned URL, completes it and resolves the preview. The same user tries resolving it again in another organization.
- Then: Initialization and PUT return HTTP 200 and the upload goes to private artifact storage. Completion returns HTTP 200 and retains the same artifact URL. Owner preview resolves HTTP 200 with null public URL and uses a signed private-bucket download. The other organization receives HTTP 404.

## private-integration-uploads-003

- Vitest: "GitHub uploads stay private through completion"
- Mode: run
- Given: An authenticated member with the relevant integration enabled has a private 12-byte text file to upload through GitHub.
- When: The member initializes the GitHub upload, PUTs the bytes to the returned URL, completes it and resolves the preview. The same user tries resolving it again in another organization.
- Then: Initialization and PUT return HTTP 200 and the upload goes to private artifact storage. Completion returns HTTP 200 and retains the same artifact URL. Owner preview resolves HTTP 200 with null public URL and uses a signed private-bucket download. The other organization receives HTTP 404.

## private-integration-uploads-004

- Vitest: "Phone uploads stay private through completion"
- Mode: run
- Given: An authenticated member with the relevant integration enabled has a private 12-byte text file to upload through Phone.
- When: The member initializes the Phone upload, PUTs the bytes to the returned URL, completes it and resolves the preview. The same user tries resolving it again in another organization.
- Then: Initialization and PUT return HTTP 200 and the upload goes to private artifact storage. Completion returns HTTP 200 and retains the same artifact URL. Owner preview resolves HTTP 200 with null public URL and uses a signed private-bucket download. The other organization receives HTTP 404.

## private-integration-uploads-005

- Vitest: "Telegram uploads stay private through completion"
- Mode: run
- Given: An authenticated member with the relevant integration enabled has a private 12-byte text file to upload through Telegram.
- When: The member initializes the Telegram upload, PUTs the bytes to the returned URL, completes it and resolves the preview. The same user tries resolving it again in another organization.
- Then: Initialization and PUT return HTTP 200 and the upload goes to private artifact storage. Completion returns HTTP 200 and retains the same artifact URL. Owner preview resolves HTTP 200 with null public URL and uses a signed private-bucket download. The other organization receives HTTP 404.
