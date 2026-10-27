ALTER TABLE "halloween_2026_exposures" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "halloween_2026_exposures" CASCADE;--> statement-breakpoint
DROP INDEX "halloween_2026_rounds_interrupted";--> statement-breakpoint
ALTER TABLE "halloween_2026_rounds" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "halloween_2026_rounds" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "halloween_2026_rounds" DROP COLUMN "token_hash";--> statement-breakpoint
ALTER TABLE "halloween_2026_rounds" DROP COLUMN "linked_at";--> statement-breakpoint
ALTER TABLE "halloween_2026_rounds" ADD CONSTRAINT "halloween_2026_rounds_outcome" CHECK ("halloween_2026_rounds"."outcome" in ('playing', 'success', 'wrong', 'left'));