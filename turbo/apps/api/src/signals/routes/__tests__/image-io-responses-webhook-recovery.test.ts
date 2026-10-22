import { Buffer } from "node:buffer";
import { createHmac, randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { webhookOpenaiImagesContract } from "@okouai/api-contracts/contracts/webhooks";
import { HttpResponse } from "msw";

import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { webhooksOpenaiImagesRoutes } from "../webhooks-openai-images";
import { createDurableImageFixture } from "./helpers/durable-image-run";
import {
  completedImageResponseWithUsage,
  mockOpenAiImageResponses,
} from "./helpers/openai-image-responses";
import {
  orgCredits,
  readAcceptedGenerationId,
} from "./helpers/public-image-run";

const context = testContext();
const secretBytes = Buffer.from("openai-image-webhook-recovery-secret");

function signedHeaders(rawBody: string) {
  const id = `evt_${randomUUID()}`;
  const seconds = String(Math.floor(nowDate().getTime() / 1000));
  const signature = createHmac("sha256", secretBytes)
    .update(`${id}.${seconds}.${rawBody}`)
    .digest("base64");
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": seconds,
    "webhook-signature": `v1,${signature}`,
  };
}

describe("OpenAI image webhook recovery", () => {
  it("recovers an accepted submission with a lost response through a signed receipt and settles the original generation once", async () => {
    const fixture = await createDurableImageFixture(context);
    await fixture.actor.run(async () => {
      mockEnv(
        "OPENAI_IMAGE_WEBHOOK_SECRET",
        `whsec_${secretBytes.toString("base64")}`,
      );
      // The provider retains the real POST and its metadata, but the caller
      // receives no response ID: resubmission could create a second paid image.
      const provider = mockOpenAiImageResponses({
        submit: () => {
          return HttpResponse.json(
            { error: { code: "unavailable" } },
            { status: 503 },
          );
        },
      });
      const response = await fixture.generate();
      expect(response.status).toBe(202);
      const receipt: unknown = await response.json();
      expect(receipt).toMatchObject({ clientReconciliation: true });
      const generationId = readAcceptedGenerationId(
        receipt,
        "image",
        fixture.actor.userId,
      );
      const submission = provider.submission();
      expect(submission.generationId).toBe(generationId);
      expect(submission.body).toMatchObject({
        background: true,
        store: true,
        metadata: { generation_id: generationId },
      });
      provider.responses.set(
        submission.id,
        completedImageResponseWithUsage(submission),
      );

      // Observe the persisted uncertainty only through production endpoints:
      // neither reads nor cron can retrieve an identity lost with the POST.
      await fixture.reconcile();
      await fixture.reconcile();
      const uncertain = await fixture.status(generationId);
      expect(uncertain).toMatchObject({ generationId, status: "running" });
      expect(uncertain.result).toBeUndefined();
      expect(uncertain.error).toBeUndefined();
      expect(provider.submissions).toHaveLength(1);
      expect(provider.retrievals).toStrictEqual([]);
      expect(provider.deletions).toStrictEqual([]);
      expect(context.mocks.s3.send).not.toHaveBeenCalled();
      await expect(orgCredits(context, fixture.actor)).resolves.toBe(10_000);

      const body = JSON.stringify({
        id: `evt_${randomUUID()}`,
        type: "response.completed",
        data: { id: submission.id },
      });
      const headers = signedHeaders(body);
      const webhook = setupApp({
        context,
        routes: webhooksOpenaiImagesRoutes,
      })(webhookOpenaiImagesContract);
      async function deliverReceipt() {
        const delivered = await webhook.post({ extraHeaders: headers, body });
        expect(delivered.status).toBe(200);
        expect(delivered.body).toBe("OK");
      }
      await deliverReceipt();
      // A successful callback is durable ingress, not provider retrieval,
      // image materialization or financial settlement.
      await expect(fixture.status(generationId)).resolves.toStrictEqual(
        uncertain,
      );
      expect(provider.retrievals).toStrictEqual([]);
      expect(provider.deletions).toStrictEqual([]);
      expect(context.mocks.s3.send).not.toHaveBeenCalled();
      await expect(orgCredits(context, fixture.actor)).resolves.toBe(10_000);

      // The protected production cron first adopts the provider identity using
      // metadata.generation_id, then stores and settles in separate short tasks.
      await fixture.reconcile();
      expect(provider.retrievals).toStrictEqual([submission.id]);
      await expect(fixture.status(generationId)).resolves.toMatchObject({
        generationId,
        status: "running",
      });
      expect(context.mocks.s3.send).not.toHaveBeenCalled();
      await expect(orgCredits(context, fixture.actor)).resolves.toBe(10_000);

      await fixture.reconcile();
      const stored = await fixture.status(generationId);
      expect(stored).toMatchObject({ generationId, status: "running" });
      expect(stored.result).toBeUndefined();
      await expect(orgCredits(context, fixture.actor)).resolves.toBe(10_000);
      await fixture.reconcile();
      const completed = await fixture.status(generationId);
      expect(completed).toMatchObject({
        generationId,
        status: "completed",
        result: {
          id: expect.any(String),
          url: expect.stringMatching(/\/artifacts\//u),
          contentType: "image/png",
          size: Buffer.byteLength("generated image bytes"),
          model: "gpt-image-2.5-flare",
          provider: "openai",
          privateArtifacts: true,
          // Image text 1 + image output 6 + mainline input 1 + output 1.
          creditsCharged: 9,
        },
      });
      await expect(orgCredits(context, fixture.actor)).resolves.toBe(9991);
      // Let terminal provider cleanup finish before measuring replay stability.
      await fixture.reconcile();
      const retrievals = [...provider.retrievals];
      expect(retrievals).toStrictEqual([submission.id, submission.id]);
      expect(provider.deletions).toStrictEqual([submission.id]);

      for (let repeat = 0; repeat < 2; repeat += 1) {
        await deliverReceipt();
        await fixture.reconcile();
        await expect(fixture.status(generationId)).resolves.toStrictEqual(
          completed,
        );
        await expect(orgCredits(context, fixture.actor)).resolves.toBe(9991);
      }
      expect(provider.submissions).toHaveLength(1);
      expect(provider.retrievals).toStrictEqual(retrievals);
      expect(provider.deletions).toStrictEqual([submission.id]);
      const uploads = context.mocks.s3.send.mock.calls
        .map(([command]) => {
          return command;
        })
        .filter((command): command is PutObjectCommand => {
          return (
            command instanceof PutObjectCommand &&
            command.input.ContentType === "image/png"
          );
        });
      expect(uploads).toHaveLength(1);
      expect(uploads[0]?.input).toMatchObject({
        Body: Buffer.from("generated image bytes"),
        ContentType: "image/png",
        Key: expect.stringMatching(/^private-artifacts\//u),
      });
    });
  });
});
