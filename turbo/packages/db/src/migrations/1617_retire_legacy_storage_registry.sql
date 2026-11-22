-- Break the HEAD cycle explicitly. RESTRICT keeps unrelated dependencies intact.
ALTER TABLE public.storages DROP CONSTRAINT storages_head_version_id_storage_versions_id_fk;
--> statement-breakpoint
DROP TABLE public.storage_version_lineage RESTRICT;
--> statement-breakpoint
DROP TABLE public.storage_versions RESTRICT;
--> statement-breakpoint
DROP TABLE public.storages RESTRICT;
