# WeChat gateway operations

This Cloudflare Durable Object worker schedules authenticated polls through the API.
The API owns provider credentials and canonical Chat/Run processing.

## Deployment for an internal scan test

1. Deploy the schema migration and API/app changes with the feature disabled.
2. Provision two distinct random secrets of at least 32 characters:
   `WECHAT_GATEWAY_SECRET` (worker-to-API HMAC) and
   `WECHAT_GATEWAY_CONTROL_SECRET` (API-to-worker control authorization).
3. Configure the API with those secrets and `WECHAT_GATEWAY_URL` pointing to the
   receiver origin. Keep the values in the normal secret-management system.
4. The **Deploy WeChat Gateway** workflow reads the matching GitHub environment's
   two secrets, `CF_API_WORKER_DEPLOY_API_TOKEN`, `CF_ACCOUNT_ID`, and the
   `WECHAT_API_ORIGIN` variable (canonical HTTPS API origin). It deploys only
   from main. Choose the test environment first and explicitly enable the
   gateway when API configuration is ready. Startup otherwise stays disabled.
5. Enable `wechatIntegration` only for the internal tester. Open `/works`, click
   WeChat Connect, scan and confirm, then send two text turns. Close Works before
   the second turn to verify background receiving and session continuity.
6. Exercise an expired QR, verification challenge if Tencent requests it,
   reconnect, disconnect during an active run, and member departure. Confirm
   tokens are absent from browser responses and model-visible material.

The receiver requires Cloudflare SQLite Durable Objects. At scale, long polling
creates one outstanding provider/API request per active binding; evaluate
concurrency, provider limits and operating cost before widening rollout.
