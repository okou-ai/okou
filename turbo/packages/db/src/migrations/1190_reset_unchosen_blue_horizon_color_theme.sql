-- Withdraw the Blue horizon palette from members who never chose it.
--
-- Between #30051 (2026-08-28), which began persisting appearance preferences,
-- and #34556 (2026-09-16), which added Default to the picker, the App's
-- fallback palette was `blue-horizon`, and bootstrap wrote that fallback into
-- `color_theme` whenever the column was null. The write was not gated on
-- `gradientColorThemes`, which stood at `enabled: false` for every
-- organization -- staff included -- until #35645 released it on 2026-09-20.
-- So members who could not open the picker had a palette recorded for them,
-- and the release turned that record into what they see: a blue-tinted
-- interface, and Blue horizon ticked in a picker they had never used.
--
-- Cleared rather than set to 'default'. Null is the state the App reads as
-- "no palette chosen", and the same change that ships this migration stops
-- the fallback from being written back, so a member who never chooses one
-- keeps a null column and follows the product default instead of being pinned
-- to whichever palette is the default today.
--
-- `gradientColorThemes` is user-scoped -- `ORG_SENTINEL_USER_ID` rows carry
-- only the org-scoped keys -- so during that window the one way to reach the
-- picker was a member's own Lab override. A member whose
-- `user_feature_switches` row carries that key is left alone: they could see
-- the picker, so their Blue horizon may be a deliberate choice. It is the
-- conservative side of the one edge this cannot resolve -- a member who
-- chose the palette and later cleared the override is indistinguishable from
-- a member who never had one, and keeping a real choice matters more than
-- withdrawing the last few automatic ones.
--
-- Every other palette is untouched, and so is every Blue horizon chosen after
-- the release: those members have no override row, but their column was
-- written by a click, not by bootstrap, and a click after 2026-09-20 cannot
-- be told apart from one before it. The window's automatic writes dominate --
-- the picker was invisible for all of it -- which is why the sweep is by
-- predicate and runs once.
--
-- The masked production gateway does not expose `color_theme`, so the
-- affected row count cannot be measured in advance. The statement is a single
-- pass over the member table with an index lookup per row against the
-- `user_feature_switches` primary key; the transactional default of 10s is
-- raised to leave headroom for that pass rather than because it is expected
-- to need it.
--
-- The inverse is not a revert: a cleared column cannot be told from one that
-- was never written. Restoring the palettes would mean restoring the bug.
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
UPDATE "org_members_metadata" AS m
SET "color_theme" = NULL
WHERE m."color_theme" = 'blue-horizon'
  AND NOT EXISTS (
    SELECT 1
    FROM "user_feature_switches" AS s
    WHERE s."org_id" = m."org_id"
      AND s."user_id" = m."user_id"
      AND jsonb_exists(s."switches", 'gradientColorThemes')
  );
