-- Activate the final reviewed My Okou cohort: every workspace that still has a
-- current member opted out, and clear the opt-out left by departed memberships.
-- The roster and resource associations are hash-bound to the reviewed inventory.
-- Preserve the prior Agent source rows, personal edits and delivery identities.
SET LOCAL TIME ZONE 'UTC';
--> statement-breakpoint
CREATE FUNCTION pg_temp.inactive_batch_uuid(value text) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT overlay(overlay(md5(value) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid
$fn$;
--> statement-breakpoint
CREATE TEMP TABLE inactive_batch_cohort ON COMMIT DROP AS
WITH frozen AS (
  SELECT value->>0 AS scope_key,value->>1 AS inventory_key
  FROM jsonb_array_elements($cohort$
[["02cd4331ac9666930c7c38f2e6c6cbafef5d31244d47d5fbff1a78bfa5c5678d","bc1a5693fcf002dd7251d99c741084df7d0257e4f638e053e5c9728446b74bfd"],
["03dc00b99e5e664ef69fcea2e16c4331c0620bf3d5d3b80c3223edb38623a2f1","8fce58cd2f2b772680b977b597ea17fd8942ae6b822d01f36a02d66cb6fc7313"],
["05242d533c49e0d2a3dc86e87ed583e0e19f1c1b6a53fd6827d5a5cfcd8b8d91","e498e481df9349ebb4cb0fa5f1088f01c9823e78c71b6cb0fba6a7449fe3d3ae"],
["058df36fcbba8ace5c7ce0d33e074ba5386512832f3bf528391853381562607e","83de1c5d3d170068c36a5b592a24c2f965565f51b7d9cb7ac71a3d905d5fa41a"],
["0e436bb6735710a13a8f41412087541d6734d4825167a174e0a815eabeb58bc8","3903b5a311a22694cfe92967e61fbcd63ae9ab57347422e5ada134cd2528380b"],
["106f38e8fd0bd265e9dae076caef421f5606803cb8572eddff4d886d22e6515c","6d5905f5b3b7b2535b6ceee0ad519611366d03727f87ea65dd5499c6c8e1e330"],
["1467f48f9b79b6bc7c468acfb58c5c1351f6cb110dc85d00eeebaacc6646768e","7aa3d3445bddbfeba693adf59c5ddaefa293df1cb46d03381a3077e48644cf98"],
["16e6fb21286e6313c8ccaa727fe5c96633b000ce1c0e43c729686dda55c6d72c","c9d749d9238e5a76b9ea7ef5fdcf1bcda188ed187397a3f1e73d3a0ba21539bb"],
["22b42e7f715284520f932a17744108dafb176ca84d1d7a506c15ebccc383ea0a","c7adb3de1cb67feefb530241f19c678fbcca847f8119a56f396b345e25ab3b43"],
["2575f8fa97fce8958b2fdbeab4102e46790dc8d8d2ee88fdf7240ffdf1ae289f","2c609c0290a375f2abf6353e369c919cb99cd88b7f7a42bfa8ced8ba1da038b5"],
["265945d732fe537e70388bb7bc44743a2a3ba23d166b75a866ec69888ef63e8f","0f4f0de24bf69daaedbc79c86cc3fbaa4c39ff913f3d6ec96a8e1a489293022b"],
["27b2ca4df3d536b1d998196b2a6455e5b9e3839b76a1370254b61f2836115eef","e5d9790b56a4a2d655239152652f5f3abe4cfa814b2fc182074080f2b1498367"],
["2951ce8946b7ab11f3a7256c5fe4c4645d2fd4deb5a076babf42630f015acb6c","bdc4f14f47d293dae647268ce2506724ce5420f5cee6d48c85058ba16e8f1b52"],
["2bd7bdaeae07dd0bf858121e5a5ccbc5412425b67851e87fa10f36247ace949b","3c62749445a9c91d7d464dd7ba43e5703a25700ff078efaee1f8d0fe16e332bc"],
["2fe5173c6e44e8c200c8f12effa9657597b034fd3ba5ebfe08dac3c6e1b795af","a26df99f42e1d4aebaa9d9a959c319e686d2d92bf4ff46f8f25f6172e1bdd2db"],
["31e898847834124e2fc1f50f60e842c2060a8d07dcb72878c64a46dc36cbe0f6","b39b05b5089dc1232598393577e5774e18afe3c2d3006fa6bbf4da506ce2f044"],
["33a0b1bb2259c827e7e3d0af24f3d71beb14f5438bbdf2499700206a7b9dbaa9","f60e08a81df4e50d127ec3086b09789405f9ea12a63120059a9bf20c2b532459"],
["389d8ebb4479833a7da5275ecf51386c10f8f25c6abb1750f077939dc04471dd","4c2405fdb5084c83f513c78747cbb2c1a99ef7d2bfd9a1115380604fa96c23f4"],
["3cab46f138051ce7b6b421252cff78ff80502186a18218830f5cec045b10a70b","23d0bccced47100c35221c6e8cf972e513b1d48c905ee481d88f6e9efcd53458"],
["3dab513659b8a05a3c1f437b336db78bc762cb602fb193a9179871690e03b7ba","59c5f19f26f6e70b00fc61e27d708500172c5c0749fef0978f0c46924a8d11a3"],
["40ee31085580b246641c11c99580ac96d72e6c342f0d54f443ede097c0737024","bbaff5cbce8815acc75dc3d8574fa9980fa283374e6281903318539790cb9a52"],
["45129f6db6efcf0d456dd7fd36ffc6a799319be0706a3189f1bebdf6ef49ca66","e129dbe8a5857cba3a11a326f62b079db14ca69e32c6c60e1de36adda8303ad9"],
["45c03c0b0f0f77916ea27506cc6d69069fab5231e2a155e27d1591c7d0634714","6336e7b87c0fb47aa656d178d9849f93a136f4bf125cdccaa098322857ce6341"],
["4672f7f92d4b30e879b6e1b15c00e7d673300c30b57a680fe7a0e212a623d6cd","7b93844a15cc233d734daa0e4499507a3fd5fb3b11af8f99a3885350d4bcee4f"],
["53762f44d4e7e26eaa0b1812a4b573d6bfe1b49a42cfd8d3b22725cc618b1a6c","a00474c28bec3c28380d38ae6b079d57e4d57f3dec5506d2f058127a3de8ab8e"],
["589a90fe70109f33aba09ed0a5c64a84bdb1648dd777435158f4ee0cc8b3d756","03fff2b317fe412ac721d740570dec9ec5555e02703ed5b6f01edd1ae0f6a124"],
["5c3f1fae4a0ae412904ea12e14a94f5e9693c7416af1e13e9ca5d851aa953260","890881f5edeac6aefb6b8aa70b188112b0471d6ade697f1f0a51ab998535696b"],
["68222be843d8cbc6f29bbda55a81ddbd79572dd5df9203ca90aea907ed3c796b","182af7dd24cce29d57b42c286bf2a3dcbaaa6cb7082e8642da15359a4db40dcc"],
["6b613aee19c8b65019f2e9830ca4b61f22a79cbf700c0ddbc678c632442f9a3b","5e5b62d52520ad3f6791fa3259ababd4947080b0a77774ee3adb998ac36a1479"],
["6c3088c24c70f070f0841f246e675546e98987a98a9fca41bb3c89160f016d29","ec73ec88848a814c3bcaec2ece79745d32716b3838d8262917dc6329090a6e3f"],
["6d9a096dece25d391b2177c09c2016caf00ecb3c334dd2f7a0b17ea8a2156a78","b4d322048a3680444903f3f56366fc56f8defeda75f6e24475317698993b60e0"],
["750e927678511fda82fb4f27d7a63840ca4bd498b7da9fada36994071023ddb6","445f6e84bc1cf87b6ab089e0e4b2c861b51e6c2871f40a835cb2dd7a8642fc25"],
["7b4c1290b4d83b788b6d18dd21d2c8a024ab5bbf9afe49d9c98a285355a6f75a","e12a2e0aa50c2cfdaa93ca1a0f69e869cd3025f69071bd5bf9d94cea97e67b4c"],
["7faab47faefcd30a254ee0a97862891cd2861874b6d4ecb80ad89da22e5ac84c","b098df1b8764c5e040da0380d94c2996f8f7ac4bbe4426bee27c54e418e245be"],
["808d53e91c518de3f29950b81862e8e91bf62af758f28dfbc974101d520ef77a","e933dc19220271211040d8e0ba56ff1938fec46139b2f2ed64161698d67cb60b"],
["86a466a623227d95d35c2c222c667371a812d1dab9c8c581da5cd7d28d5da944","be5dadfa3fcd61635d733283331832da6adf08abe5309fd6d5003b6cc70e496d"],
["9020e1d2cb8eb1fd60d0d31520aed48548e50d9827a4ca888361bc8f52179626","9f61554432c30faede09478b9a7d4274894149a20a9b9d6b90f7409333b5a0ae"],
["930db99c0f6f1adc5e93e049feba0719c56b4ab6c22903e4163f65e9e9b96b3b","3a5366957884ae23400af70b3a105da8b5e562f290cfd8c2b3c7b30a91d4877e"],
["9755bafebc76b2eb28230c9e5fe06ab99e1ba08ea149ce0db686b2fbdc217b9a","067ec77f69e5480996058cfa291bbfaf9d13186d9d424cf384a7bd31ac343efb"],
["a15257a505beef95e4a7fe1901788eea9b669d946e6029ec1a32053fd6b3fce9","28ae07d5eff4d1931cbe9c65bc86fe61c01f3145a4f4e53b262c6c19e4e321cd"],
["a355694e63e9e0f0cddda330328c8f5d216b16ec5f34001bf93dc5b029599df7","eaaf1e2fad7fafac397ef32fd2ca6ce042b55b4b69200ff811d5e67068a407f3"],
["a6542d24ad45312059722746f46cba215f665eef7fd90c2a0c077297ecacac66","c6ccbb9b1decf6875b1dee2eddb9f73cd8c3ff3ca21119d46a3c8d7c90b82a35"],
["adc97b7ca7a0b39e959f50f5d8ef82abbab847a36b79cb6f0a909aeea571d628","94e67dd3e6cd60549956886a12aa4df45b41607140974ffc4270043e43e3d64d"],
["b34234a5ae15acab74a45f838e365fee02587c7cec6f885549fc81a2545bc417","382d18ab3513d5b4d6d5c73537ca05f2942c002d39265fbd3ee1fa1e2de57010"],
["b99493e1af445c2acbf2d13ca34663d35d34e814be8f46fecc8931f103509b07","ae4a1f274866d2d3825e3215b1042fa3f7aaa425fac57c217be8ba371059909c"],
["bda23cfaa42675cf15d74d07859065afb6ee60f167f401f9205e9e39dcba7c42","6385ab9fefee549c716799dd532e86f3467a67c7eaf3f1b63fc417a37a2d7945"],
["befc0f56417cc20691778e4e2b89976fb7dc06c2b21d4e50bb129a4a9a569898","a1271e348ca942981834aff9a8332a8f6883904feb0aa5b391ec7cdda4b95976"],
["bfa5fa8fddcf9d73979787a181dac2723e9129fc866242363a93bb97c5336a39","e928416a73b715856c8a25abc158c9cb16785bcfc70975404db21ac3ee351be7"],
["c21c61c6c5d4003fb579ec637031014b42d21d4418f61f478e8f6dbdfa0c2c89","7fe9bdd5037ebc49d417956d81f23d723bca346f3a64ca1318ab7467c3ac6235"],
["ce6c964d08ca1cbb2ac2db984c8bbf9437223d5808888a395dafb0158624417b","c523df8eb214271a0bb05a09e1a51b9f2e65609379794d3b0505125990dabaf2"],
["d109b9f9a8dce26500385e65ba91f38ac0a616f27014b0f5145ef5065cf51e5d","269692b4f06c6012efe526efcbdf739d2ef9299e209e5ad6845a56b45a0e70bc"],
["d53cb9fe54af215fdad1ad64a9a10de467c3948434affb940657d9416b6aca7e","90c0a114f52305375d753e0c8e5a59738a9dd9ca07c37791d9d2786522eccc8c"],
["d8c875f4052b436044192383b733ed78ecc96771fa4de7c3ca94a934cd0a8cdb","8fdb19053a2ede18c0d2590e4025a6b5be4f5e733c3746437948586b32f65b8f"],
["dcc08708b977b48515c3015f7e559625bbb73c038c2d686af2e9527316224858","2da5c8d7e017638f2541079dacb86110f791e3c97c513262e220635a2832d0a7"],
["df0dca4e9482b96328042f2f662a47a2b96dfd3c024248cf7d4b064551da966d","28793abe68b734676885202f362311cb77bdd7bc0a3fea6fea3341606ea45c03"],
["df27b538762bce0e1c17618eb5115f57892038420554748cf00d555658ecca1a","87d76b4796736cd87b567d67a2b10d81e013d49072c1e038915f03bb8cceac87"],
["e4c1a8314b2b0c38ee7cecd2fe0432152ee2d3a225c592ddae1efd1ff47df008","a4f8180cea983584af569c23d1cc04e470f5989e1f0d19b01f9ad51560ae034f"],
["e51b88173a2281eafd9231069614d3249e6d4d3ebc68d20533a97b8dd1f5b445","6eb2318320f4332fb90a8be48038ce286c56300acfef6cf27608bfa99955c701"],
["e70100d5b7af4ba48929d19e93fb8337564f4a11542d61fd75a19bd28def14f8","7ddd99ef5f76cb8b0c0f524136c2cac869a7aa59d13442732d0a111814feff37"],
["eba2561afa0d1bec7b46d2e72605d64307780c55b6d03b11a317aa28d7e74aba","c6106dafde612e8eba2c5dc7390a9dcad675409ec3c63377b2b388fcad113685"],
["edc402cd01952d7e8eb7ee6834401d0e2a72dd83269fd05de4f1366e97b3d2ac","33c449149ab65d83343e9ed7d216e9c9f5deb6ac3ee032cf7819e525d7e009b2"],
["ee774f3f1e725c2fa6a7aeb7176b89faa8afef970889660c26d16a4d3de0b799","96942d3774f2a541183ebbed3f2280fde77584d69ea1651daaa1e91b3e8b3e4a"],
["f05da44f767baee0ac62a4e478749dd4a018fe65dffe7a1e8d91a544d53fa1fe","1d0f474ac7cd5e15f391bad76da4773b94bc4e25cc98bc43c83ac5e855a4274e"],
["f1bbdbe23b07fbf22cbf5064cb48fb147899e17aa1764a2efddc7da4f86ba343","5e1bc5a2f9582e6329bd35cfd56d7b080898e3a8a1dd3dd43f0dd211e794680b"],
["f3094a775b9d2f3876b5ece3ce2ad97023caaef27b85001a59c4d08969a8a4df","9bd611834c15f31304a0d12b067c91c23c4675ec7f243d0a0284bfb9a8f8b1fd"],
["f55d73254e6968027c5da109d0d9a4d8aa2a3f80214e688344c13f7f02c7901b","56e993317f66bf4f042a94acab0e17b160b6fb0a86d86bd0e52394e97630ff45"],
["f90b4f65e4940d4c22cddf720bc82e78e25ac30fd6614496ced17e38cfc3695c","00e8173a30d530f533c6c3769fea6bbcc628246d97dae64b59c4edbd773aef32"],
["f9340e0538b997c46e61f05b21061c37f1d95f8b6f8c62af8f1e592d382bed18","02ca88d588cbb47114c14ae309afd030f734f87a961bb812c318cdae31a5d273"],
["fc176ea8e2ca20b391e1f264d6eaa7bad8f74cf16d71fe248984a60873b9c367","8c27cb5809c5edce082305008e2d024b038a0ca8f93812f77f41c97de1312317"],
["fd0d5653dff68d75bc5ab26d5e2054f6a57962c01bd4ce423552d9a76aa3b798","13bddf335c82ddf7a5faeffbc9969000a4aaa49d84e082bdfacbd5de0e92b2d9"],
["fdc4b9f8d278947424fcfdb0f9895a6359e5067307d9e4951bf9f7281d9d6abd","6575858b4dde0468310e3339ee9ab8dbeec04e47f070df90d3fdafeac2238596"]]
$cohort$::jsonb)
), resolved AS MATERIALIZED (
  SELECT o.org_id,o.default_agent_id,f.inventory_key
  FROM org_metadata o JOIN frozen f
    ON f.scope_key=encode(sha256(convert_to(o.org_id||':'||o.default_agent_id::text,'UTF8')),'hex')
), legacy_chat AS MATERIALIZED (
  SELECT a.org_id,array_agg(c.id ORDER BY c.id) AS chats,
    string_agg(c.id::text||':'||c.agent_id::text||':'||c.user_id,',' ORDER BY c.id) AS associations
  FROM resolved r JOIN agents a ON a.org_id=r.org_id AND a.id<>r.default_agent_id
  JOIN chat_threads c ON c.agent_id=a.id GROUP BY a.org_id
), inventory AS (
  SELECT r.*,
    ARRAY(SELECT m.user_id FROM org_members_metadata m WHERE m.org_id=r.org_id ORDER BY m.user_id COLLATE "C") AS members,
    ARRAY(SELECT m.user_id FROM org_members_cache m WHERE m.org_id=r.org_id ORDER BY m.user_id COLLATE "C") AS cached_members,
    ARRAY(SELECT a.id FROM agents a WHERE a.org_id=r.org_id ORDER BY a.id) AS agents,
    (SELECT string_agg(a.id::text||':'||a.owner||':'||a.visibility,',' ORDER BY a.id)
      FROM agents a WHERE a.org_id=r.org_id) AS agent_associations,
    ARRAY(SELECT w.id FROM workflows w WHERE w.org_id=r.org_id ORDER BY w.id) AS workflows,
    (SELECT string_agg(w.id::text||':'||w.agent_id::text||':'||w.owner_user_id||':'||w.visibility,',' ORDER BY w.id)
      FROM workflows w WHERE w.org_id=r.org_id) AS workflow_associations,
    ARRAY(SELECT a.id FROM workflow_automations a WHERE a.org_id=r.org_id ORDER BY a.id) AS automations,
    (SELECT string_agg(a.id::text||':'||a.workflow_id::text||':'||a.owner_user_id||':'||a.enabled::text||':'||a.kind,',' ORDER BY a.id)
      FROM workflow_automations a WHERE a.org_id=r.org_id) AS automation_associations,
    coalesce(c.chats,'{}'::uuid[]) AS chats,coalesce(c.associations,'') AS chat_associations
  FROM resolved r LEFT JOIN legacy_chat c USING(org_id)
)
SELECT * FROM inventory i
WHERE cardinality(members)>0 AND cached_members<@members
  AND inventory_key=encode(sha256(convert_to(concat_ws('|',
    coalesce(array_to_string(members,','),''),
    coalesce(array_to_string(cached_members,','),''),
    coalesce(agent_associations,''),coalesce(workflow_associations,''),
    coalesce(automation_associations,''),chat_associations),'UTF8')),'hex');
ALTER TABLE inactive_batch_cohort ADD PRIMARY KEY (org_id);
ANALYZE inactive_batch_cohort;
--> statement-breakpoint
CREATE TEMP TABLE inactive_copy_target ON COMMIT DROP AS
SELECT c.*,a.instructions,a.instructions_bundle,a.xmin::text||':'||a.ctid::text AS default_row_version
FROM inactive_batch_cohort c
JOIN org_metadata o ON o.org_id=c.org_id AND o.default_agent_id=c.default_agent_id
JOIN agents a ON a.id=c.default_agent_id AND a.org_id=c.org_id
  AND a.visibility='public' AND a.instructions_bundle IS NOT NULL
  -- One reviewed workspace kept its public default Agent after the creator left.
  AND (a.owner=ANY(c.members)
    OR encode(sha256(convert_to(a.org_id||':'||a.id::text||':'||a.owner,'UTF8')),'hex')
      ='c188ad2e2a5213fb599d6c5f006b9dcb8e75550817bfb841cebc7f2c2f6bf4db')
WHERE NOT EXISTS (
  SELECT 1 FROM unnest(c.members) m(user_id) LEFT JOIN user_feature_switches f
    ON f.org_id=c.org_id AND f.user_id=m.user_id
  WHERE f.switches->'singleAgent' IS DISTINCT FROM 'false'::jsonb
    OR (cardinality(c.agents)>1 AND f.switches->'featureGuides'='false'::jsonb)
)
AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.org_id=c.org_id)
AND NOT EXISTS (SELECT 1 FROM queued_chat_threads q WHERE q.org_id=c.org_id)
AND NOT EXISTS (SELECT 1 FROM active_agent_runs r WHERE r.org_id=c.org_id)
AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.org_id=c.org_id AND r.status IN ('pending','running'))
AND NOT EXISTS (
  SELECT 1 FROM workflow_automations x
  WHERE x.org_id=c.org_id AND x.official_blueprint_key='daily-delivery' AND x.enabled
    AND (SELECT claim.settlement FROM morning_brief_schedule_claims claim
         WHERE claim.automation_id=x.id ORDER BY claim.claim_sequence DESC LIMIT 1)='unsettled'
)
AND NOT EXISTS (
  SELECT 1 FROM agents x
  WHERE x.org_id=c.org_id AND ((x.owner<>ALL(c.members)
      AND encode(sha256(convert_to(x.org_id||':'||x.id::text||':'||x.owner,'UTF8')),'hex')
        <>'c188ad2e2a5213fb599d6c5f006b9dcb8e75550817bfb841cebc7f2c2f6bf4db')
    OR x.instructions_bundle IS NULL
    OR x.visibility NOT IN ('public','private'))
)
AND NOT EXISTS (
  SELECT 1 FROM chat_threads x JOIN agents source ON source.id=x.agent_id
  WHERE source.org_id=c.org_id AND source.id<>c.default_agent_id
    AND (x.project_id IS NOT NULL
      OR (x.user_id=ANY(c.members) AND source.visibility='private' AND x.user_id<>source.owner
        AND encode(sha256(convert_to(x.id::text||':'||x.agent_id::text||':'||x.user_id,'UTF8')),'hex')
          <>'33a63720e65cf5a21c7d72bc57e3ac353f231c0ea06a9a813afaf714da9ddcca'))
)
AND NOT EXISTS (
  SELECT 1 FROM workflows w LEFT JOIN agents source ON source.id=w.agent_id
  WHERE w.org_id=c.org_id AND (source.org_id IS DISTINCT FROM c.org_id
    OR (source.id<>c.default_agent_id AND w.owner_user_id=ANY(c.members)
      AND (w.official_definition_name IS NOT NULL OR w.instruction IS NULL OR w.content_bundle IS NULL
        OR w.attachments IS NULL OR w.visibility NOT IN ('public','private')
        OR (source.visibility='private' AND w.owner_user_id<>source.owner)))
    OR (w.owner_user_id<>ALL(c.members) AND (w.visibility<>'private'
      OR EXISTS (SELECT 1 FROM workflow_automations x WHERE x.workflow_id=w.id)
      OR EXISTS (SELECT 1 FROM workflow_user_automation_threads b WHERE b.workflow_id=w.id))))
)
AND NOT EXISTS (
  SELECT 1 FROM workflow_automations x LEFT JOIN workflows w ON w.id=x.workflow_id
  LEFT JOIN agents source ON source.id=w.agent_id
  WHERE x.org_id=c.org_id AND (w.org_id IS DISTINCT FROM c.org_id OR x.owner_user_id<>ALL(c.members)
    OR (source.id<>c.default_agent_id AND (w.owner_user_id<>ALL(c.members)
      OR (source.visibility='private' AND x.owner_user_id<>source.owner)
      OR x.official_blueprint_key IS NOT NULL
      OR (x.enabled AND x.kind='schedule' AND (x.next_run_at IS NULL OR x.next_run_at<=now())))))
)
AND NOT EXISTS (
  SELECT 1 FROM workflow_user_automation_threads b JOIN workflows w ON w.id=b.workflow_id
  JOIN agents source ON source.id=w.agent_id LEFT JOIN chat_threads x ON x.id=b.chat_thread_id
  LEFT JOIN agents chat_agent ON chat_agent.id=x.agent_id
  WHERE w.org_id=c.org_id AND source.id<>c.default_agent_id
    AND (b.org_id<>c.org_id OR b.user_id<>ALL(c.members) OR w.owner_user_id<>ALL(c.members)
      OR (source.visibility='private' AND b.user_id<>source.owner)
      OR (x.id IS NOT NULL AND (x.user_id<>b.user_id OR chat_agent.org_id<>c.org_id)))
)
AND (cardinality(c.agents)>1 OR NOT EXISTS (
  SELECT 1 FROM unnest(c.members) m(user_id)
  JOIN user_feature_switches f ON f.org_id=c.org_id AND f.user_id=m.user_id
  CROSS JOIN feature_guide_editions e
  JOIN feature_guide_revisions r ON r.edition_id=e.id AND r.id=e.published_revision_id
  WHERE f.switches->'featureGuides' IS DISTINCT FROM 'false'::jsonb AND e.published_at IS NOT NULL
    AND (r.expires_at IS NULL OR r.expires_at>now())
    AND r.content->'items' @> '[{"featureSwitch":"singleAgent"}]'::jsonb
    AND (r.content->'audience' IS NULL OR r.content->'audience'->'orgIds' @> jsonb_build_array(c.org_id)
         OR r.content->'audience'->'users' @> jsonb_build_array(jsonb_build_object('orgId',c.org_id,'userId',m.user_id)))
    AND NOT EXISTS (SELECT 1 FROM feature_guide_receipts seen WHERE seen.edition_id=e.id AND seen.user_id=m.user_id)
));
ALTER TABLE inactive_copy_target ADD PRIMARY KEY (org_id);
ANALYZE inactive_copy_target;
--> statement-breakpoint
-- Pin the exact trigger and delivery Chat rows through the cutover.
CREATE TEMP TABLE remaining_automation_source ON COMMIT DROP AS
SELECT x.id,x.org_id,x.workflow_id,to_jsonb(x) AS original_row
FROM inactive_copy_target t JOIN workflow_automations x USING(org_id)
ORDER BY x.id FOR NO KEY UPDATE OF x;
CREATE UNIQUE INDEX ON remaining_automation_source(id);
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM inactive_copy_target t
    WHERE t.automation_associations IS DISTINCT FROM (
      SELECT string_agg(x.id::text||':'||x.workflow_id::text||':'||x.owner_user_id||':'||x.enabled::text||':'||x.kind,',' ORDER BY x.id)
      FROM workflow_automations x JOIN remaining_automation_source s ON s.id=x.id
      WHERE x.org_id=t.org_id
    )
  ) THEN
    RAISE EXCEPTION 'Final My Okou trigger association changed before cutover';
  END IF;
END $$;
CREATE TEMP TABLE remaining_automation_thread_source ON COMMIT DROP AS
SELECT b.id,b.org_id,b.workflow_id,to_jsonb(b) AS original_row
FROM inactive_copy_target t JOIN workflow_user_automation_threads b USING(org_id)
JOIN workflows w ON w.id=b.workflow_id AND w.org_id=b.org_id
WHERE w.agent_id<>t.default_agent_id AND w.owner_user_id=ANY(t.members)
ORDER BY b.id FOR NO KEY UPDATE OF b;
--> statement-breakpoint
-- A member's Chat on another member's private Agent stays with its retained source.
CREATE TEMP TABLE final_retained_chats ON COMMIT DROP AS
SELECT x.id,to_jsonb(x) AS original_row
FROM inactive_copy_target t JOIN agents source ON source.org_id=t.org_id AND source.id<>t.default_agent_id
JOIN chat_threads x ON x.agent_id=source.id
WHERE x.user_id=ANY(t.members) AND source.visibility='private' AND x.user_id<>source.owner
ORDER BY x.id FOR NO KEY UPDATE OF x;
-- Canonical Agent slugs supply the same bounded prefix namespace as the staff
-- planner. Project labels retain the authored display name, including non-ASCII.
CREATE TEMP TABLE inactive_copy_agents ON COMMIT DROP AS
WITH named AS (
  SELECT a.*, a.xmin::text || ':' || a.ctid::text AS source_row_version,t.default_agent_id AS target_agent_id,
    coalesce(nullif(btrim(a.display_name),''),a.name) AS project_label,
    coalesce(nullif(rtrim(left(trim(both '-' from regexp_replace(lower(a.name),'[^a-z0-9]+','-','g')),12),'-'),''),
      'a-' || left(replace(a.id::text,'-',''),8)) AS proposed_prefix
  FROM agents a JOIN inactive_copy_target t ON t.org_id=a.org_id AND a.id<>t.default_agent_id
), ranked AS (
  SELECT named.*, count(*) OVER (PARTITION BY org_id,proposed_prefix) AS prefix_count,
    count(*) OVER (PARTITION BY org_id,lower(project_label)) AS label_count FROM named
)
SELECT ranked.*, CASE WHEN prefix_count>1
  THEN rtrim(left(proposed_prefix,3),'-') || '-' || left(replace(id::text,'-',''),8)
  ELSE proposed_prefix END AS prefix FROM ranked;
CREATE TEMP TABLE inactive_copy_workflows ON COMMIT DROP AS
SELECT w.*, w.xmin::text || ':' || w.ctid::text AS source_row_version,
  pg_temp.inactive_batch_uuid('inactive-batch-workflow-v1:' || w.id::text) AS copy_id,
  a.target_agent_id, a.visibility AS source_agent_visibility, a.owner AS source_agent_owner,
  CASE WHEN a.visibility='private' THEN 'private' ELSE w.visibility END AS copy_visibility,
  CASE WHEN length(a.prefix || '--wf-' || w.name)<=64 THEN a.prefix || '--wf-' || w.name
    ELSE a.prefix || '--wf-' || rtrim(left(w.name,64-length(a.prefix)-5-9),'-') || '-' ||
      left(encode(sha256(convert_to('["' || a.id::text || '","' || w.name || '"]','UTF8')),'hex'),8)
  END AS copy_name
FROM workflows w JOIN inactive_copy_agents a ON a.id=w.agent_id AND a.org_id=w.org_id
JOIN inactive_copy_target t ON t.org_id=w.org_id AND w.owner_user_id=ANY(t.members);
CREATE TEMP TABLE inactive_copy_chat_routes ON COMMIT DROP AS
SELECT c.id,c.user_id,c.agent_id AS source_agent_id,a.org_id,a.target_agent_id,
  pg_temp.inactive_batch_uuid('inactive-batch-project-v1:' || a.org_id || ':' || c.user_id || ':' || a.id::text) AS project_id,
  CASE WHEN a.label_count>1 THEN a.project_label || ' (' || left(a.id::text,8) || ')'
    ELSE a.project_label END AS project_name
FROM chat_threads c JOIN inactive_copy_agents a ON a.id=c.agent_id
JOIN inactive_copy_target t ON t.org_id=a.org_id AND c.user_id=ANY(t.members)
WHERE NOT EXISTS (SELECT 1 FROM final_retained_chats k WHERE k.id=c.id);
ANALYZE inactive_copy_agents;
ANALYZE inactive_copy_workflows;
ANALYZE inactive_copy_chat_routes;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM inactive_copy_agents WHERE prefix !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(prefix)>12)
    OR EXISTS (SELECT 1 FROM inactive_copy_agents GROUP BY org_id,prefix HAVING count(*)>1)
    OR EXISTS (SELECT 1 FROM inactive_copy_workflows WHERE copy_name !~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$')
    OR EXISTS (SELECT 1 FROM inactive_copy_chat_routes WHERE length(btrim(project_name)) NOT BETWEEN 1 AND 120) THEN
    RAISE EXCEPTION 'Inactive batch target names require review';
  END IF;
  IF EXISTS (SELECT 1 FROM inactive_copy_workflows s JOIN workflows w
    ON w.org_id=s.org_id AND w.agent_id=s.target_agent_id AND w.name=s.copy_name)
    OR EXISTS (SELECT 1 FROM inactive_copy_agents a JOIN workflows w
      ON w.org_id=a.org_id AND w.agent_id=a.target_agent_id AND w.name=a.prefix || '--instruction') THEN
    RAISE EXCEPTION 'Inactive batch target Workflow namespace collision';
  END IF;
END $$;
--> statement-breakpoint
-- Source definitions remain available to historical Runs. Copies share immutable
-- descriptors and preserve authored content, attachments, ownership and attribution.
INSERT INTO workflows (id,org_id,agent_id,name,visibility,instruction,attachments,content_bundle,
  owner_user_id,display_name,description,official_definition_name,official_installation_state,
  import_source,import_session_id,created_by,updated_by,created_at,updated_at)
SELECT copy_id,org_id,target_agent_id,copy_name,copy_visibility,instruction,attachments,content_bundle,
  owner_user_id,display_name,description,NULL,NULL,import_source,import_session_id,
  created_by,updated_by,created_at,now()
FROM inactive_copy_workflows ON CONFLICT (id) DO NOTHING;
INSERT INTO workflows (id,org_id,agent_id,name,visibility,instruction,attachments,content_bundle,
  owner_user_id,created_by,updated_by,created_at,updated_at)
SELECT pg_temp.inactive_batch_uuid('inactive-batch-instruction-v1:' || a.id::text),
  a.org_id,a.target_agent_id,a.prefix || '--instruction',a.visibility,a.instructions,
  '{"kind":"empty"}'::jsonb,a.instructions_bundle,a.owner,a.owner,a.owner,a.created_at,now()
FROM inactive_copy_agents a ON CONFLICT (id) DO NOTHING;
INSERT INTO instructions (org_id,user_id,content,bundle)
SELECT t.org_id,m.user_id,t.instructions,t.instructions_bundle
FROM inactive_copy_target t CROSS JOIN LATERAL unnest(t.members) AS m(user_id)
ON CONFLICT (org_id,user_id) DO NOTHING;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM inactive_copy_workflows s LEFT JOIN workflows w ON w.id=s.copy_id
    WHERE w.id IS NULL OR w.org_id<>s.org_id OR w.agent_id<>s.target_agent_id
      OR w.name<>s.copy_name OR w.owner_user_id<>s.owner_user_id OR w.visibility<>s.copy_visibility
      OR w.instruction IS DISTINCT FROM s.instruction OR w.attachments IS DISTINCT FROM s.attachments
      OR w.content_bundle IS DISTINCT FROM s.content_bundle
      OR w.display_name IS DISTINCT FROM s.display_name OR w.description IS DISTINCT FROM s.description
      OR w.import_source IS DISTINCT FROM s.import_source OR w.import_session_id IS DISTINCT FROM s.import_session_id
      OR w.created_by<>s.created_by OR w.updated_by<>s.updated_by OR w.created_at<>s.created_at
      OR w.official_definition_name IS NOT NULL OR w.official_installation_state IS NOT NULL)
    OR EXISTS (SELECT 1 FROM inactive_copy_agents a LEFT JOIN workflows w
      ON w.id=pg_temp.inactive_batch_uuid('inactive-batch-instruction-v1:' || a.id::text)
      WHERE w.id IS NULL OR w.org_id<>a.org_id OR w.agent_id<>a.target_agent_id
        OR w.name<>a.prefix || '--instruction' OR w.owner_user_id<>a.owner OR w.visibility<>a.visibility
        OR w.instruction IS DISTINCT FROM a.instructions OR w.content_bundle IS DISTINCT FROM a.instructions_bundle
        OR w.attachments IS DISTINCT FROM '{"kind":"empty"}'::jsonb) THEN
    RAISE EXCEPTION 'Inactive batch Workflow copy identity collision';
  END IF;
END $$;
--> statement-breakpoint
-- Keep existing trigger and Chat-binding identities and modify only the definition association.
UPDATE workflow_automations x SET workflow_id=s.copy_id
FROM remaining_automation_source original JOIN inactive_copy_workflows s ON s.id=original.workflow_id
WHERE x.id=original.id AND x.org_id=original.org_id AND to_jsonb(x)=original.original_row;
UPDATE workflow_user_automation_threads b SET workflow_id=s.copy_id
FROM remaining_automation_thread_source original JOIN inactive_copy_workflows s ON s.id=original.workflow_id
WHERE b.id=original.id AND b.org_id=original.org_id AND to_jsonb(b)=original.original_row;
--> statement-breakpoint
WITH groups AS (
  SELECT DISTINCT project_id,user_id,org_id,project_name FROM inactive_copy_chat_routes
), inserted AS (
  INSERT INTO projects (id,user_id,org_id,name,sort_order)
  SELECT project_id,user_id,org_id,project_name,
    'a0' || lpad(row_number() OVER (PARTITION BY user_id,org_id ORDER BY project_id)::text,17,'0') || '1'
  FROM groups ON CONFLICT (id) DO NOTHING RETURNING *
), counts AS (
  SELECT user_id,org_id,count(*)::bigint AS total FROM inserted GROUP BY user_id,org_id
), reserved AS (
  INSERT INTO project_event_sequences (user_id,org_id,last_seq_id)
  SELECT user_id,org_id,total FROM counts
  ON CONFLICT (user_id,org_id) DO UPDATE SET last_seq_id=project_event_sequences.last_seq_id+EXCLUDED.last_seq_id
  RETURNING user_id,org_id,last_seq_id
)
INSERT INTO project_events (id,user_id,org_id,seq_id,project_id,kind,name,sort_order)
SELECT gen_random_uuid(),p.user_id,p.org_id,
  r.last_seq_id-c.total+row_number() OVER (PARTITION BY p.user_id,p.org_id ORDER BY p.id),
  p.id,'created',p.name,p.sort_order
FROM inserted p JOIN counts c USING(user_id,org_id) JOIN reserved r USING(user_id,org_id);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM inactive_copy_chat_routes r LEFT JOIN projects p ON p.id=r.project_id
    WHERE p.id IS NULL OR p.org_id<>r.org_id OR p.user_id<>r.user_id OR p.name<>r.project_name
      OR p.sort_order IS NULL) THEN
    RAISE EXCEPTION 'Inactive batch Project copy identity collision';
  END IF;
END $$;
--> statement-breakpoint
WITH updated AS (
  UPDATE chat_threads c SET agent_id=r.target_agent_id,project_id=r.project_id,updated_at=now()
  FROM inactive_copy_chat_routes r
  WHERE c.id=r.id AND c.user_id=r.user_id AND c.agent_id=r.source_agent_id AND c.project_id IS NULL
  RETURNING c.*
), scoped AS (
  SELECT u.*,r.org_id FROM updated u JOIN inactive_copy_chat_routes r ON r.id=u.id
), counts AS (
  SELECT user_id,org_id,2*count(*)::bigint AS total FROM scoped GROUP BY user_id,org_id
), reserved AS (
  INSERT INTO chat_thread_event_sequences (user_id,org_id,last_seq_id)
  SELECT user_id,org_id,total FROM counts
  ON CONFLICT (user_id,org_id) DO UPDATE SET last_seq_id=chat_thread_event_sequences.last_seq_id+EXCLUDED.last_seq_id
  RETURNING user_id,org_id,last_seq_id
)
INSERT INTO chat_thread_events (id,user_id,org_id,seq_id,chat_thread_id,kind,agent_id,
  reassigned_agent_id,project_id,pin_order,created_at)
SELECT gen_random_uuid(),p.user_id,p.org_id,
  r.last_seq_id-c.total+row_number() OVER (PARTITION BY p.user_id,p.org_id ORDER BY p.id,event.ordinal),
  p.id,CASE WHEN event.ordinal=1 THEN 'project_updated' ELSE 'sort_touched' END::chat_thread_event_kind,
  p.agent_id,CASE WHEN event.ordinal=2 THEN p.agent_id ELSE NULL END,
  CASE WHEN event.ordinal=1 THEN p.project_id ELSE NULL END,
  CASE WHEN event.ordinal=2 THEN p.pin_order ELSE NULL END,
  CASE WHEN event.ordinal=1 THEN p.updated_at ELSE p.last_message_at END
FROM scoped p JOIN counts c USING(user_id,org_id) JOIN reserved r USING(user_id,org_id)
CROSS JOIN (VALUES (1),(2)) event(ordinal);
--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM inactive_copy_chat_routes r LEFT JOIN chat_threads c ON c.id=r.id
    WHERE c.id IS NULL OR c.user_id<>r.user_id OR c.agent_id<>r.target_agent_id OR c.project_id IS DISTINCT FROM r.project_id
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_target t JOIN queued_chat_threads q USING(org_id)
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_target t JOIN active_agent_runs a USING(org_id)
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_target t JOIN agent_runs r USING(org_id) WHERE r.status IN ('pending','running')
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_target t LEFT JOIN org_metadata o USING(org_id)
    LEFT JOIN agents a ON a.id=t.default_agent_id
    WHERE o.default_agent_id IS DISTINCT FROM t.default_agent_id OR a.id IS NULL
      OR a.xmin::text||':'||a.ctid::text IS DISTINCT FROM t.default_row_version
      OR ARRAY(SELECT x.id FROM agents x WHERE x.org_id=t.org_id ORDER BY x.id)<>t.agents
      OR ARRAY(SELECT m.user_id FROM org_members_metadata m WHERE m.org_id=t.org_id ORDER BY m.user_id COLLATE "C")<>t.members
      OR ARRAY(SELECT m.user_id FROM org_members_cache m WHERE m.org_id=t.org_id ORDER BY m.user_id COLLATE "C")<>t.cached_members
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_agents s LEFT JOIN agents a ON a.id=s.id
    WHERE a.xmin::text||':'||a.ctid::text IS DISTINCT FROM s.source_row_version
  ) OR EXISTS (
    SELECT 1 FROM workflows w JOIN inactive_copy_agents a ON a.id=w.agent_id
    JOIN inactive_copy_target t ON t.org_id=a.org_id AND w.owner_user_id=ANY(t.members)
    LEFT JOIN inactive_copy_workflows s ON s.id=w.id
    WHERE w.xmin::text||':'||w.ctid::text IS DISTINCT FROM s.source_row_version
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_workflows s LEFT JOIN workflows w ON w.id=s.id WHERE w.id IS NULL
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_agents a JOIN inactive_copy_target t ON t.org_id=a.org_id
    JOIN chat_threads x ON x.agent_id=a.id WHERE x.user_id=ANY(t.members)
      AND NOT EXISTS (SELECT 1 FROM final_retained_chats k WHERE k.id=x.id)
  ) OR EXISTS (
    SELECT 1 FROM final_retained_chats k LEFT JOIN chat_threads x ON x.id=k.id
    WHERE to_jsonb(x) IS DISTINCT FROM k.original_row
  ) OR EXISTS (
    SELECT 1 FROM remaining_automation_source original LEFT JOIN workflow_automations x ON x.id=original.id
    LEFT JOIN inactive_copy_workflows s ON s.id=original.workflow_id
    WHERE x.workflow_id IS DISTINCT FROM coalesce(s.copy_id,original.workflow_id)
      OR to_jsonb(x)-'workflow_id' IS DISTINCT FROM original.original_row-'workflow_id'
      OR (s.id IS NOT NULL AND x.enabled AND x.kind='schedule'
        AND (x.next_run_at IS NULL OR x.next_run_at<=clock_timestamp()))
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_target t JOIN workflow_automations x USING(org_id)
    LEFT JOIN remaining_automation_source original ON original.id=x.id WHERE original.id IS NULL
  ) OR EXISTS (
    SELECT 1 FROM remaining_automation_thread_source original
    LEFT JOIN workflow_user_automation_threads b ON b.id=original.id
    JOIN inactive_copy_workflows s ON s.id=original.workflow_id
    WHERE b.workflow_id IS DISTINCT FROM s.copy_id
      OR to_jsonb(b)-'workflow_id' IS DISTINCT FROM original.original_row-'workflow_id'
  ) OR EXISTS (
    SELECT 1 FROM workflow_user_automation_threads b JOIN inactive_copy_workflows s ON s.id=b.workflow_id
  ) THEN
    RAISE EXCEPTION 'Final My Okou source changed during cutover';
  END IF;
END $$;
--> statement-breakpoint
-- Activate the same pairs used by the Guide revision and preserve unrelated switches.
DO $$
DECLARE
  activated integer;
BEGIN
  UPDATE user_feature_switches f
    SET switches=f.switches || '{"singleAgent":true}'::jsonb,updated_at=now()
    FROM inactive_copy_target t
    WHERE f.org_id=t.org_id AND f.user_id=ANY(t.members)
      AND f.switches->'singleAgent'='false'::jsonb
      AND (cardinality(t.agents)=1 OR f.switches->'featureGuides' IS DISTINCT FROM 'false'::jsonb);
  GET DIAGNOSTICS activated = ROW_COUNT;
  IF activated <> (SELECT coalesce(sum(cardinality(members)),0) FROM inactive_copy_target) THEN
    RAISE EXCEPTION 'Final My Okou member state changed during cutover';
  END IF;
END $$;
--> statement-breakpoint
-- Keep the published edition and receipts. Append the successfully migrated
-- member pairs to a new immutable revision without changing edition precedence.
DO $$
DECLARE
  edition feature_guide_editions%ROWTYPE;
  revision feature_guide_revisions%ROWTYPE;
  updated_revision uuid;
  prior_audience jsonb;
  users jsonb;
  new_users jsonb;
  audience_json text;
  orgs_json text;
  users_json text;
  content_json text;
  revision_hash text;
  approved_content constant text := $guide${"schemaVersion":1,"title":"My Okou","description":"One Okou, personal Instructions, reusable Workflows.","items":[{"featureId":"my-okou","featureSwitch":"singleAgent","title":"One Okou. Your subagents, now projects","description":"Start any task with your own Okou. Your former subagents are now projects, organized in the chat sidebar.","media":{"type":"illustration","alt":"Illustrated example: Okou beside Writing and Research project cards in Chat → Projects, with Market overview and Customer insights conversations.","characterUrl":"https://static.okou.io/platform/feature-guides/my-okou/okou-multitask-356bc36cc3.webp","scene":{"type":"projects","location":["Chat","Projects"],"title":"Research","subtitle":"Project","backTitle":"Writing","conversations":["Market overview","Customer insights"]}}},{"featureId":"personal-instructions","featureSwitch":"singleAgent","title":"Your instructions are now in Settings","description":"Find and edit your Okou's instructions in Settings → Personal → My Okou.","media":{"type":"illustration","alt":"Illustrated example: Okou beside the personal instructions editor in Settings → Personal → My Okou, with a selected line and formatting toolbar.","characterUrl":"https://static.okou.io/platform/feature-guides/my-okou/okou-instructions-3c85f9896b.webp","scene":{"type":"instructions","location":["Settings","Personal","My Okou"],"title":"My Okou","subtitle":"Personal instructions","lines":["Keep answers concise.","Use clear headings.","End with next steps."]}}},{"featureId":"workspace-workflows","featureSwitch":"singleAgent","title":"Your workflows, in one place","description":"Keep repeatable task steps in Workflows. Use them yourself or share them with your workspace.","media":{"type":"illustration","alt":"Illustrated example: Okou carrying a folder beside a shared Research brief and a private Weekly report workflow with reusable steps.","characterUrl":"https://static.okou.io/platform/feature-guides/my-okou/okou-workflows-5842643b2b.webp","scene":{"type":"workflows","location":["Workflows"],"title":"Weekly report","subtitle":"Reusable instructions","steps":["Review the week","Summarize progress","Outline next steps"],"command":"/weekly-report","privateLabel":"Private","backTitle":"Research brief","backCommand":"/research-brief","sharedLabel":"Shared"}}}]}$guide$;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inactive_copy_target WHERE cardinality(agents)>1) THEN
    RETURN;
  END IF;

  SELECT e.* INTO edition FROM feature_guide_editions e
    WHERE e.id='single-agent-2026-11-16' FOR NO KEY UPDATE;
  SELECT r.* INTO revision FROM feature_guide_revisions r
    WHERE r.edition_id=edition.id AND r.id=edition.published_revision_id;
  IF edition.published_at IS NULL OR revision.id IS NULL OR revision.starts_at>now()
    OR (revision.expires_at IS NOT NULL AND revision.expires_at<=now())
    OR revision.content-'audience' IS DISTINCT FROM approved_content::jsonb THEN
    RAISE EXCEPTION 'Published My Okou Guide requires revalidation before cutover';
  END IF;

  -- Publishing an audience delta must not replace another edition that the
  -- current Guide selector prefers for a member who has yet to see My Okou.
  IF EXISTS (
    SELECT 1 FROM inactive_copy_target t CROSS JOIN LATERAL unnest(t.members) m(user_id)
    JOIN feature_guide_editions e ON (e.published_at,e.id)>(edition.published_at,edition.id)
    JOIN feature_guide_revisions r ON r.id=e.published_revision_id AND r.edition_id=e.id
    WHERE cardinality(t.agents)>1 AND r.starts_at<=now() AND (r.expires_at IS NULL OR r.expires_at>now())
      AND (r.content->'audience' IS NULL
        OR r.content->'audience'->'orgIds' @> jsonb_build_array(t.org_id)
        OR r.content->'audience'->'users' @> jsonb_build_array(jsonb_build_object('orgId',t.org_id,'userId',m.user_id)))
      AND NOT EXISTS (SELECT 1 FROM feature_guide_receipts seen WHERE seen.edition_id=edition.id AND seen.user_id=m.user_id)
  ) THEN
    RAISE EXCEPTION 'A newer Guide takes precedence for a cutover member';
  END IF;

  prior_audience := revision.content->'audience';
  -- An unrestricted edition already covers every cutover member.
  IF prior_audience IS NULL THEN
    RETURN;
  END IF;

  SELECT jsonb_agg(jsonb_build_object('orgId',t.org_id,'userId',m.user_id) ORDER BY t.org_id,m.user_id)
    INTO new_users
  FROM inactive_copy_target t CROSS JOIN LATERAL unnest(t.members) m(user_id)
  WHERE cardinality(t.agents)>1
    AND NOT coalesce(prior_audience->'orgIds' @> jsonb_build_array(t.org_id),false)
    AND NOT coalesce(prior_audience->'users' @> jsonb_build_array(jsonb_build_object('orgId',t.org_id,'userId',m.user_id)),false);
  IF new_users IS NULL THEN
    RETURN;
  END IF;

  users := coalesce(prior_audience->'users','[]'::jsonb) || new_users;
  IF jsonb_array_length(users)>1000 THEN
    RAISE EXCEPTION 'My Okou Guide audience exceeds the supported limit';
  END IF;

  -- Match the existing import service's JSON.stringify field order and ISO
  -- timestamps so re-importing this exact revision resolves to the same row.
  SELECT string_agg(to_json(value)::text,',' ORDER BY ordinal) INTO orgs_json
    FROM jsonb_array_elements_text(prior_audience->'orgIds') WITH ORDINALITY AS org(value,ordinal);
  SELECT string_agg('{"orgId":'||to_json(value->>'orgId')::text||',"userId":'||to_json(value->>'userId')::text||'}',
      ',' ORDER BY ordinal) INTO users_json
    FROM jsonb_array_elements(users) WITH ORDINALITY AS member(value,ordinal);
  audience_json := '{'||coalesce('"orgIds":['||orgs_json||'],','')||'"users":['||users_json||']}';
  content_json := left(approved_content,-1)||',"audience":'||audience_json||'}';
  revision_hash := encode(sha256(convert_to(
    '{"editionId":'||to_json(edition.id)::text||',"content":'||content_json
    ||',"startsAt":'||to_json(to_char(revision.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
    ||',"expiresAt":'||coalesce(to_json(to_char(revision.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text,'null')||'}',
    'UTF8')),'hex');

  INSERT INTO feature_guide_revisions (edition_id,content,content_hash,starts_at,expires_at,created_by)
  VALUES (edition.id,content_json::jsonb,revision_hash,revision.starts_at,revision.expires_at,'migration:1596')
  ON CONFLICT (edition_id,content_hash) DO NOTHING;

  SELECT id INTO updated_revision FROM feature_guide_revisions
    WHERE edition_id=edition.id AND content_hash=revision_hash
      AND content=content_json::jsonb AND starts_at=revision.starts_at
      AND expires_at IS NOT DISTINCT FROM revision.expires_at;
  IF updated_revision IS NULL THEN
    RAISE EXCEPTION 'My Okou Guide revision hash collision';
  END IF;
  UPDATE feature_guide_editions SET published_revision_id=updated_revision WHERE id=edition.id;
END $$;
--> statement-breakpoint
-- These memberships ended before departure began clearing the rollout opt-out.
-- Remove only that stale override; their retained workspace rows stay untouched.
UPDATE user_feature_switches f SET switches=f.switches-'singleAgent',updated_at=now()
WHERE f.switches->'singleAgent'='false'::jsonb
  AND encode(sha256(convert_to(f.org_id||':'||f.user_id,'UTF8')),'hex')=ANY(ARRAY[
  '0b13a4f9369a0c9f2b97b24879f4928f0c33bcaa4521b7ddb5fe4f35b7fee553',
  '16bcb2505bc08311e777604c27167a31f07760a34d8c905c8fdaca303de0bd30',
  '23e764c7118fb145d59b7ae50c64478010b1932fd5d6cc15c8fbee81389598ce',
  '271e7dc583ffd1a9b0d282ea5587927f60c936477632f134a20e303c056f7c1a',
  '2cc297a766ee2215c54ec508d4b248f7ff6f96a36cb73ac3575a49ea5d1fde40',
  '47ce496b2715cd95e609a99944ec6542f375a237ba8b6736b1d05dd85a2ce3d0',
  '51ba0e32a781b3e0fd71507a1490339c3afb5f1d1913397ff10cf487c811144d',
  '5238e2f042bfcdd0a357cd8e1c3fbd7e7db44c937d5d147f391d434765bbc94f',
  '5a7d731eb6e843aa58fad74b9062e5e039b3e25035b77dd694efd59d2d05c2fc',
  '664d272a8da16dc9f6aba9f7fc73cd59fe2c612763f8b6a9827be63a3a26144b',
  '6bfa12d6bf294c12a078584e1fe8fde711dc5b8831916d0276b2a463b30413cc',
  '6c78c579badab4409ea841ff49475d4620357ca23ce64a29696515a2027742cf',
  '75c30e023294b0e97caffae95a089986dcdf9e2fd2a8eec15f2445603bd2b5da',
  '7fc84c2d0bca8d5224f34c29de2476b55722388b7f81a6125779fafb29dd583e',
  'a228158a4b86087ae40ae8d28730e53047a2e2815a8a41bdebaa5bb1c47c7e9d',
  'cc8ec1b53cf1fac3d227ca9814bc0f7fd3572fb12e100dcb75bd482f0851334f',
  'd928496932358b41385ecdbb244a9fbe487d9445d1e6d3d15cae776c1a216de9',
  'e334d2ed9dbdf375072844de6a72e2281d38dd9c48a9b76fb5bb9535c2ac5f10',
  'f0c4e9734b9cf6dc287d3634f55aaa8c45cb306c2339c7b15be51dd8e9d7c8bb'
  ])
  AND NOT EXISTS (SELECT 1 FROM queued_chat_threads q WHERE q.org_id=f.org_id)
  AND NOT EXISTS (SELECT 1 FROM active_agent_runs r WHERE r.org_id=f.org_id)
  AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.org_id=f.org_id AND r.status IN ('pending','running'));
--> statement-breakpoint
DROP FUNCTION pg_temp.inactive_batch_uuid(text);
