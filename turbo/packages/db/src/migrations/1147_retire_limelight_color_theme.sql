-- The Limelight palette is retired: it declared the same two colours as Citrus
-- spark with the anchor and companion swapped, so the two options were
-- indistinguishable in the picker. Members who selected it move to the palette
-- built from that identical pair; every other selection is untouched.
UPDATE "org_members_metadata"
SET "color_theme" = 'citrus-spark'
WHERE "color_theme" = 'limelight';
