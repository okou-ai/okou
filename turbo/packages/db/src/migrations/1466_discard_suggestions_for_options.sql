-- Discard the disposable suggestion pool and receipts once for the options cutover.
-- The next curation run rebuilds the pool using the current format.
DELETE FROM "agent_suggestions";
