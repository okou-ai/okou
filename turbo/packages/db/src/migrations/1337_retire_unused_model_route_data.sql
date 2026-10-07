-- Retire model-route data that no live reader uses.
--
-- * run_model_catalog.pi_route_class: only `gpt-codex` routes remain on Pi.
--   Clear the retired classes before the CHECK narrows in the following migration.
-- * chat_threads.selected_model: the DeepSeek v4 Pro pin is already rejected
--   on use. NULL is the thread's "no explicit pin" state, which resolves to
--   Auto like every other thread without a selection.
DO $$
DECLARE
  catalog_count bigint;
  thread_count bigint;
BEGIN
  UPDATE run_model_catalog
  SET pi_route_class = NULL
  WHERE pi_route_class IS NOT NULL
    AND pi_route_class <> 'gpt-codex';
  GET DIAGNOSTICS catalog_count = ROW_COUNT;

  UPDATE chat_threads
  SET selected_model = NULL
  WHERE selected_model = 'deepseek/deepseek-v4-pro';
  GET DIAGNOSTICS thread_count = ROW_COUNT;

  RAISE NOTICE 'Model route data retirement: catalog=%, threads=%',
    catalog_count, thread_count;
END $$;
