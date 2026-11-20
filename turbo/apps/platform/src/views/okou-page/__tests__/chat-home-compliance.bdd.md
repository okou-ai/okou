# Chat home compliance

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-home-compliance.test.tsx](chat-home-compliance.test.tsx).

## chat-home-compliance-001

Original test `The chat home lists the compliance statuses`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-home-compliance.test.tsx#L33).

- **Given** The user is viewing the chat home for the public agent Nova.
- **When** The compliance status list loads.
- **Then** The list shows SOC 2 Type II as In progress, CCPA / CPRA and GDPR as Compliant, and HIPAA and ISO/IEC 27001 as Aligned; SOC 2 is not shown as certified.
