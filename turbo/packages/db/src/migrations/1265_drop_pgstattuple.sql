-- 1178 installed pgstattuple only for the chat search GIN pending-list check.
-- 1263 turned fastupdate off and #36990 removed every pgstatginindex call; the
-- API rollback floor excludes older artifacts that still call it.
DROP EXTENSION IF EXISTS pgstattuple;
