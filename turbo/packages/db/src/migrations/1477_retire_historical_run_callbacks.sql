-- #37796: explicitly abandon the 95 audited historical Runs and their callbacks.
-- This fixed manifest is not an age-based retention policy. Keep Chat, files,
-- Thread bindings, Storage lineage and independent billing facts unchanged.
DO $$
DECLARE
  run_ids constant uuid[] := ARRAY[
    'e89fe7fd-15f3-4ccd-a44b-870572c30d7b',
    '075c38cb-12da-4849-8e01-b31a3f7d7d3c',
    'eaf06b97-fdc9-4818-ab28-0271ffef526b',
    '7e638b19-811d-4123-9dc2-515b1228fae5',
    '1149dc87-08eb-4af7-9762-fba7d4875c01',
    '8b29839f-f4ee-4659-a3c1-a2adfbcc7b22',
    'bc7c52c8-8d1b-449b-8ebc-db531a38ea91',
    '7152a9c1-0397-45db-af3b-00ec6e8a314b',
    'b5fd8f7d-704a-4bc8-9cde-f45c7c655309',
    '1562cf73-e815-4949-bcb1-25d8edeff5ac',
    '877b657f-388d-4ecb-b7e3-287557fc705d',
    'f0785242-6541-4690-8b7e-71b34f2bfaeb',
    '82cc46db-67ff-4cde-8cd5-ab57fde8c013',
    '4cbe6a9a-c3c7-4401-ad3d-17a746de9222',
    '5dcb5c3f-62ba-4825-9393-9536edf98093',
    '6b3a80ca-fc2e-49e7-a97d-515573589b75',
    '50659f78-333d-43ac-a860-255075762c56',
    'c61708eb-d460-468a-a039-6ec1ffecf757',
    'be566a5a-8ebe-4707-8c40-024e78dac6c2',
    '077d97cc-e09a-4d69-b9f0-c3165059763d',
    '1d8a7fb5-8001-4e46-9a5d-fd1581ea4c0d',
    '22b8fabf-277c-4285-817a-e8184e90b226',
    'f7a69641-7347-48ab-b9ac-872bbf53eb03',
    'c242800b-a7ac-42fd-b542-d2cdcba94bd7',
    'b2d0e948-55e6-45f9-afa8-2606e162af57',
    'e65d1df6-2d39-4e31-a120-32d3b12127ad',
    'ff0f82f1-b22b-4702-827d-8eac45686ec1',
    '23b323e5-31ad-4805-8338-53b3c6114439',
    '56f23014-2169-42aa-9bbb-6547f88f8f6d',
    'dc9abe7e-3324-48ec-8be4-3573cc944881',
    'e3d8f2b2-b6b9-4fd3-808c-833d3b828f92',
    'c84b099b-65cb-468d-88ac-e70efc609da9',
    'bed32393-9bd5-4720-952a-5cd717411cdc',
    '53919ddd-8fad-4a0e-b34d-9321c426fb0b',
    'b171cfe5-0566-483a-b8ad-f6c82f73a382',
    '8982874f-fb9a-4e85-844d-4b90e7fd7536',
    '3e668c2e-338a-405c-bf59-29f37824c910',
    'fda5ee38-0199-4cd4-9ba8-5522a691497b',
    'f9bb6eb1-9b16-4f7b-955c-9ab7d46e2842',
    '28e02bf0-9cee-415a-919b-e78acb0d9a56',
    '73a985cf-582e-4a68-b5b6-02be56c7ec31',
    'f3a34136-cd4d-45cd-b743-2d13111e2e12',
    '4b9dd419-6325-49ad-a1eb-35d446b72f0b',
    'a7994610-f941-4d02-a7e3-24b5754af027',
    '4745a678-7591-4ed4-9684-1b0e99f6864f',
    '5343b495-c95e-4cb1-99de-c5356566cea4',
    'af6dbb1f-7678-4274-99c4-e8f1f5462da0',
    '404f4377-6819-4968-b7c8-99a949c2277d',
    '1b962b4d-0333-4f29-b354-c219d59a49db',
    'a20d8c9f-1ba3-4afb-bc49-878244fcaac0',
    'a500c71f-397e-4d71-b9f8-ce5243157346',
    '28cd2165-4e93-4c9c-9784-9c6a9dd5672f',
    '64e56287-82ef-4a32-9b28-6ab152ef6856',
    'fb323993-de84-4b39-9646-753cda4041e5',
    '5fa59a41-f64e-4611-aa38-261e2b41b43c',
    '6b54df84-0b3f-4074-b9f3-61791ced047f',
    '7a96edf6-a70e-4e2b-9512-87411afb2533',
    'de96d8ba-1c5e-49d6-ba01-118d3ad279b6',
    '2ee05ed4-3d0a-4651-b1a1-0003b8eaf528',
    '83cd2068-eddd-4b09-8320-3cfd0ae766c5',
    '19b27f5b-5f75-4bb0-9281-8c3876500372',
    'fcd13d8c-19fc-41f5-9980-de915d43ff54',
    '4605ac0a-11b9-4b2c-9633-93384cbcca0c',
    '0d091e53-93bb-4192-ad0a-f5b096b20231',
    '7d9f9ccf-1f39-43e4-9a8c-e466c5f10e45',
    '11de2305-fdc6-496d-9e5f-d897c2cb4329',
    'dcb4978a-27c6-477d-8e4e-41473d220f78',
    '95b4edd1-04f4-4428-b008-6c1c396abe74',
    'd6a5070c-c6e8-41fe-8561-22777e6a4ac6',
    '44d51a82-3d9f-4a41-a433-c17335bdc08c',
    '08d1f95f-5c90-4168-a774-63ce763e5505',
    '949ecc8f-3e21-4dca-b72c-b2389b9ab882',
    'd0b33480-5fed-4831-a921-5638c29d1c2b',
    '6fca9f95-d55c-4f7f-8742-6da8a26f6365',
    '4da35ce7-71f2-412b-826b-fdd38c09fa4a',
    '0c9cf749-5483-4dd2-89e5-26628dc018b7',
    'fd4d8f7b-684a-42a1-a6b8-258e2ce84517',
    '8f20f98e-6336-4742-b17f-69b7dc1df419',
    'b6429231-ca55-4909-8f9d-637d5f190e13',
    '44a3a69a-e665-4c2b-b5b7-9a25b54a3d1f',
    'bd65557e-387d-4a82-8b3e-c67bf01d21d9',
    'a5d8ca2f-c466-44a9-befb-20713f364e06',
    '42307505-93dd-47b3-801d-991912e9dd54',
    '4e47a509-6d06-41be-ac56-ad62db789c0b',
    'f217eaa7-0987-481b-a0eb-b56f453e389d',
    '93d0ec41-685d-41a4-908c-281d2f7ec4cc',
    '64575646-ae5e-4023-96bd-f5629b8065da',
    'e614bff0-f2b5-4597-9cb1-78c4ca70244d',
    '6bd5e559-081d-4f5a-9a2b-618bc735923d',
    '51ddbe0f-fc3e-4b5c-85cb-f70496899a17',
    '878836c4-0bd3-4e03-81f2-e9efa7f78434',
    '3d3b7c4e-893a-4c65-9843-8079db84e3a3',
    'dd9c349c-ccdb-49db-a092-e7345bb8f6ce',
    'ee0d706a-565f-4c9c-af7a-00c02e278d4b',
    'ccf84a90-dd0f-4856-b99e-b20e296cb672'
  ]::uuid[];
BEGIN
  -- Capture only the audited completed image Job, while its original Run and
  -- independently retained billing owner still prove the same identity.
  UPDATE built_in_generation_jobs j
  SET billing_run_id = j.run_id, billing_context = 'run'
  FROM agent_runs r, billing_run_attribution b
  WHERE j.id = '913d017a-8abe-4124-9377-0861c9ce9e66'::uuid
    AND j.run_id = 'bed32393-9bd5-4720-952a-5cd717411cdc'::uuid
    AND j.status = 'completed' AND j.completed_at IS NOT NULL
    AND j.billing_run_id IS NULL AND j.billing_context = 'legacy_unknown'
    AND r.id = j.run_id AND b.run_id = r.id
    AND r.org_id = j.org_id AND r.user_id = j.user_id
    AND b.org_id = j.org_id AND b.user_id = j.user_id;

  -- Pending/failed callbacks are intentionally abandoned for these IDs only.
  -- Normal callback dispatch and retry rules do not change. Callback and old
  -- output projections cascade; usage run_id links SET NULL, preserving their
  -- immutable billing_run_id, ownership, prices, quantities and charged credits.
  DELETE FROM agent_runs r
  WHERE r.id = ANY(run_ids)
    AND r.created_at < timestamp '2026-09-19'
    AND r.status IN ('completed', 'failed', 'cancelled', 'timeout')
    -- One audited legacy cancelled Run has no completed_at. No timestamp is
    -- fabricated, but explicit started cancellation recovery must be finished.
    AND NOT (r.status = 'cancelled' AND r.started_at IS NOT NULL
      AND r.cancellation_recovery_completed IS FALSE)
    AND r.legacy_conversation_history_hash IS NULL
    AND NOT EXISTS (SELECT 1 FROM active_agent_runs a WHERE a.run_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM runner_job_queue q WHERE q.run_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM claimed_workflow_attachments a WHERE a.run_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM data_router_requests d WHERE d.run_id = r.id)
    AND NOT EXISTS (
      SELECT 1 FROM run_built_in_admissions a
      WHERE a.run_id = r.id AND a.status = 'active'
    )
    AND NOT EXISTS (
      SELECT 1 FROM built_in_generation_jobs j WHERE j.run_id = r.id AND (
        j.id <> '913d017a-8abe-4124-9377-0861c9ce9e66'::uuid
        OR j.status <> 'completed' OR j.completed_at IS NULL
        OR j.billing_run_id IS DISTINCT FROM r.id OR j.billing_context <> 'run'
        OR j.org_id <> r.org_id OR j.user_id <> r.user_id
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM usage_event u
      LEFT JOIN billing_run_attribution b ON b.run_id = u.billing_run_id
      WHERE (u.run_id = r.id OR u.billing_run_id = r.id) AND (
        u.status = 'pending' OR u.billing_run_id IS DISTINCT FROM r.id
        OR u.billing_context <> 'run' OR u.billing_anchor_at IS NULL
        OR b.run_id IS NULL OR b.org_id <> u.org_id OR b.user_id <> u.user_id
        OR u.org_id <> r.org_id OR u.user_id <> r.user_id
        OR u.billing_anchor_at IS DISTINCT FROM b.run_started_at
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM usage_event_hourly_rollup u
      LEFT JOIN billing_run_attribution b ON b.run_id = u.billing_run_id
      WHERE (u.run_id = r.id OR u.billing_run_id = r.id) AND (
        u.billing_run_id IS DISTINCT FROM r.id OR u.billing_context <> 'run'
        OR u.billing_anchor_at IS NULL OR b.run_id IS NULL
        OR b.org_id <> u.org_id OR b.user_id <> u.user_id
        OR u.org_id <> r.org_id OR u.user_id <> r.user_id
        OR u.billing_anchor_at IS DISTINCT FROM b.run_started_at
      )
    );

  -- A changed prerequisite aborts this whole statement, including the Job
  -- repair and all cascades. Missing/already-erased IDs make replay a no-op.
  IF EXISTS (SELECT 1 FROM agent_runs WHERE id = ANY(run_ids)) THEN
    RAISE EXCEPTION 'Audited historical Run cleanup prerequisites changed'
      USING ERRCODE = '23514';
  END IF;
END
$$;
