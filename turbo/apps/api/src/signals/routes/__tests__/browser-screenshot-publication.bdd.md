# browser-screenshot-publication

## browser-screenshot-publication-001

- Vitest: "keeps the accepted screenshot downloadable after the shared provider retires"
- Mode: run
- Given: A signed-in owner has opened a chat Browser and closes it, publishing a screenshot. Its shared provider then retires the instance.
- When: The owner tries to renew the old lease, then reads the Browser view and asks for the screenshot’s download URL.
- Then: The lease returns HTTP 409 and the inactive view no longer contains a window. It retains the exact published screenshot URL and captured preview bytes. The owner’s file URL request returns HTTP 200.

## browser-screenshot-publication-002

- Vitest: "deletes retired sibling previews without losing the surviving Browser recovery"
- Mode: run
- Given: The owner has three closed chat Browsers with separate accepted previews and visited URLs on a shared provider, which retires its instance.
- When: The owner checks the retired lease and views, deletes two chats while checking the surviving lease, then reopens the surviving Browser.
- Then: The first retired lease returns HTTP 409 and each view stays suspended with its original preview. The surviving lease returns HTTP 404 and the two deleted previews are removed from the provider storage while the surviving screenshot and bytes remain. Reopening returns HTTP 200 and restores the survivor’s original URL in its primary window.
