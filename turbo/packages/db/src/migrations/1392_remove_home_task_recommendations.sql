-- The default-off homeTaskRecommendations feature is abandoned. Its cache is
-- disposable; RESTRICT keeps an unexpected dependent object from being dropped.
DROP TABLE "home_task_recommendations";
--> statement-breakpoint
UPDATE "user_feature_switches"
SET "switches" = "switches" - 'homeTaskRecommendations',
    "updated_at" = now()
WHERE "switches" ? 'homeTaskRecommendations';
