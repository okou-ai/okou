-- Activate the reviewed remaining My Okou workspace cohort.
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
[["02199372305552f6dc00d917176e64b6b8490f1930bc3375cf94ce4b0c0d14a0","f71f9922289e1fab22647a393a501a7d00b7acf64f6d2f5664474c2f6d508793"],
["06c28e9dca1e66e8162dc082a42fb9729260f7429b9e1bf4d436f95f2b527f7b","7e7afd1937d3681912583cff5da4d0182a66fcfaf49455909faf9e6515b81ac7"],
["0eb93b379519efea4332814c179223f3c72a412d5acdfa17245e66aaa68466b9","b42d5212d42afaa45489287b66981e66dfe4e09cedb8bdcf7b46884f492316ff"],
["11c5882b5b1bff7941073230b54ea68c6547fbe638434a8921b802402ede486a","e958ca22962d080a0e502af4bc5705bc876996d6d7cadb856bd35674a149b329"],
["133d23aa73699f8f057704e503a18844b908d382dd87607d3c051bdff6d930f7","b904c2ed850cd979beb543781c0d8fb08ab6f07db4df85d1bc7b4bc065ab85cb"],
["155b4df3eb7f56aced8d7cc3e0259fed3de2cf30a2596f2d66c0ce2b73e42a3f","6dabbd8f31bf4a3bb0aa459cd081d1655dccffaa0e86a3d7f129f4116b435423"],
["1bdc3660b55aa92b1f963ec0291b896b9f8d754c8c43abad4e23b3bc7d3d1976","87359ac8a5640e3043c6afe29de836de079abd52f34da967f7d531a2136fd552"],
["1d3fe60a42ca8618bb7f90800fdac81fe355c91ea68ce3ffc2df056c480233fb","2d8d68a3fd4b11a60301a69b7efd4d0e3d54eb2600c2c9a92198b4be7e45e77c"],
["1eb68fa1213049f66ab1dcd6566843244831a1c1773fb9c13d9165ff8000e030","4bb8f85c728c430b4a3dd3a891914a4b174889c9e5b04be5bd75d937457fe03f"],
["211b39dcddd8c8ba604e8adb3d67957506b6dbc23dcfd498d5c0b40f54de061b","315b39ad94f14875f488b4c6e09a788980924c2658898b9ebace4f3cbaef0461"],
["21fa2dab5a62605141dafc442f85d179ab7c3b75209bc657f99b83ad5eb61a96","0b1b06fb9c41a2bda52021011c4ef5b94e5f41e1b7b8489e1a86ed184c58e4a4"],
["25a493876bee78547586edd0ba524e513d6c35f37b64c0289100fadb53d0ce6d","8da545322ba9bd8263a40de92cbc3e419869ba098f08a3f853258e565be12b72"],
["260267ced3dac8de9db4346e33c33b4c4e36feb9a6efa3f1f787136882bf1109","9af90226e3e4dc1f0fdc8895a9c4ebdfacab171f47ae0421e586981159bbebc2"],
["27c07a3882c750daa42b2247cb16ef17f79377b734ecccad8592430f7666e8eb","dec150426c4b48c387afa2856e352a43188353f97ecaad61e3394fc574c41493"],
["28a55f6fb00db0c7f4e73e5fb8ba89958fcb730a7523bec4e14120be4970cd11","0ef99728df5a625b0710cdf897483f18ed79ae9f0622f23cc52b2266539168dd"],
["2967a095b8e5822227fb2adb08074af0b4698fb9efe036b5f5d5ce6b4283d488","a617c8e4f3c027789ef0024737383154ad043945ee11427c73947d5c8fe113d5"],
["2c4b9f4aae58d7cd17de456730a76b568b71686bcc66cf721a4b68db386602b5","a389ad89931361fa7e00f7535382b3a9bc5ac1705fcd7acd99942b6ba23830ba"],
["2d17ab9281148f1e499d31882d8494a5ba3311b3142c05a9b4eea8af79b4fb25","a005c029199b017b9911564b38401cca4d5b19f1110cca5c3d5674c5153219b3"],
["2df0117186708527c8a2d0317ee30db5ed78f4a9a4603169f8f9cafe967fc14b","aafd282dd6ece7155c173da27d394a7e5e310119cfd315f5951d25d015a29260"],
["2f2017381a9c08983a95e3e0de59e9163de6cda5bda3a79b89d426248feb07de","e593f59ab62cf6e879c549b318ace662c194d704b0fd3d27584c1aa35ff74722"],
["316f86f45c2dd77bb66ef833998cb2023876d0cd7915bbb2de4c1780b9c8fb0e","080050ec9bbe2167271236acd33aa4ee9c6003981c1fcaefe1ab3210e583644a"],
["323556811862f54f485fe74257fcb2e6d92210b0998d8a8c34c20c8f62b3b34f","34277c393b1c56405d681dc54d566c4fc87da1ffba22482813e9a85020c64b26"],
["33bc60e5645490031c083a9d70c9cf1481e5c401e640040e7bb34f0693316ee2","0523f3180b8d778cc39c8c7af959179cf4e57299fd58862c540c9308046f5169"],
["3400390a9f23257fea26199aa238853a790db7070a8b671ee1d38c9feb3c29f3","99459dcffaae84a2185ebcd3d79b0644e39936c388ee5755d218064891516048"],
["391e9c71eb58eebcf624f60c10dd72b171c9f27d9d70213b3a6cfc4d9cbfb1ee","3698490a81d60dd846f79265ae9e13387b2f33d8571128876df5f8607a2d4a56"],
["3e92c49981eb17eff6468e345bdda159673d26bc69355a0d8d69f61b72b783b6","0c1e5a02acda3070ef3f286aec9d54f4821d4673561a3802808616e3a15f465a"],
["3fc7b4fc41b77cd1545adcc46c167c32ed40ad0cd96a3a8fcfca26652c9bc6ef","4bc75ceda6df3f5676f3c228950b1a49488363f95def6f86ee46de9f86cb1f13"],
["424a3e1105835f7f6e4b3cc878b4b6ed50b2efd8a4ea0efa9123f6cf96dc1a9b","0fa538b4ee5ee6eef0bfe800d23d24858c3e2a3e281e7a6fb315b14274eb0fce"],
["4484a6dc8d9541923f59fb4b1ed4ed4a6d8e6ffb75ffc7bd328aed7e74d5647f","12fab6d107a8e5fdbfcf8b72d58429286e3f315cd85aa1ff3f6cb934a3ffda3f"],
["4bd5199c10b4c362eb3f20dbdc92e7e73a1634b672b82f057ad2778081b17083","e3e0bc9158b438d7b3e79a0dbd8471d370d009bf7731dff2d8b0cdfba1ffc214"],
["4d878d9bb4ba79d1d71b8c8610854ebf6b2b142f7ee7750b77943213a90ad2cc","7a5bce5941310cadb6e46e202dbc31c341066e1a1d06900598cd2b0a9d31c040"],
["4def27b84fea68cba257a8a01c8997708f30e1d6ea52ad0b9e3618065d79cdcf","9d3ad0305a42325975975af692cf0684930ea373b3be9c2b1fe924fd0a6b263b"],
["5036ce9e29e1e3b3708fbf48f2036fe5c3937998f4609bfd0408ec98229ea54f","340564d1c6f0244324f1f9731b8228036d26353003be0ebe84b6b815824f6be3"],
["50b760fc7f57b3889d149cf23c8ba377f95736f18a2892545484731c5db68073","1d40b2c924a33217fa22611579728c6c3847b97ac5c3e581d0dce01870e2d733"],
["515e87dc87a55194afa8467b7173b273b36f68e6ee019570ebe97cfd75ebc209","420cbac223cc546d94ffa11ccebd894045d2e9cd0c0d979916ce95b1784a6338"],
["5c754b0f55fc63315b960a68e462946f598737c306f4d250c046ba063262ce51","290e41219de6acc23cccb8035de7c7bd4cff7d707fd5c003381c3c4786ad6944"],
["5e483a59d5bbed3cfcfef7df7ad5903c7706da50188b4ae20f6cf7f183508068","badc00d4a51f697a8c818c93033aa2e265efe2220d22d90e5d23dcda8e07445d"],
["60bd74e0c38df5a09a6be8947cc2dfeb6b96d72d60edf274bea75e1640948a09","14739993259c5fbb12d2c4fc6de65ffb1ffd76c1b50445851516d7d9fe59a1cb"],
["60cf5e6223a79410eae2076166f11781b5b56218a4c52d8ecc4291b055c4eb8f","64f8933ccbfc81aaae8f72aaab065d725eb257f9b6371cf6709fa64f4064f865"],
["61711020ce223fc66287cf5a828c748b1d0df4ff81738591da448adadc5cbac0","80941b19a841af79b442bcb41ac75501d99240724f625ab9f5f83732f0c8ef4b"],
["61b32a5dc8f4d1175c36d61fcc1c560f397994790a56926df3840008b242a773","7dbbb7dd38cc0b01be8552cc875c308f1071adf92469285c8b6d2a9c3d092808"],
["637e7fe52b6b1ec179210a4339355e9dcfd2567526a30ef1adb3c065f3785ded","83f32cac15783c83de032228468e5a3f76d0d8d247bfbfab9912571da9aea957"],
["64dc370f783218ef7fa93437c40b7b00e0a722e45f8b8cfad558908204aa7694","46969975794f3a7af5bec9153242df43563ba884027ba6c61bc84bfe17603a47"],
["669d8feefd9ca046c3eac292f8a675175f3d18faff325237bc3c943b9cc37309","ac1a041625aed8287aa87d084ffae70f0e3c4a6dea5311ba7cefac51d1077e25"],
["66fe08070af93aa12f86de5ca28631fb8dffbf29c1d601f98479525bedf007ec","0935d7c640ed5013ec2e12fbeb1d6cc9482e1a8188653cac391e068b35d4e891"],
["677d091efa00e0b63d92d7e8ccb71de16783c49044a6844198826dbfd8e836a9","ea1dd909fcefb9dba62edd8211b70d01667863c33186c998c39c747b1df26586"],
["6a6354ed4701d548b269547efd830f80f74c561864f034782d9fe1f8450bf502","61aacf65abc457669f2a806813115a393322964837a1642d4362793a54fc7d65"],
["6c425147337308025cf647886fb20db006645193278462667d32c135e4e97ce4","a887ece469cf594ace23885f04856baa7ec786151bcbf3eea73a1e7da8de4ec2"],
["6da466ad62cb90e01f24f60fe24b8ba7ea9911364573cebb78e1e72b4f7e694b","55e294c6e65fd8f3892dc0d8b86aeade4a365d59ae2b5ef8885e8ed5f2dcadd9"],
["6f5bd2e086e5c2911b030bcb5b59f528cd1e9e92cfa2676d43eca82808f6a51d","d8e5b0723203adb11b44c10bac4a10e7d285a48a6c234b9ce090525aa9bcac69"],
["718ebe99b1c7f68b884d62849f8105ef97fb339f26b4d6aaebaf16fd43494640","fc996a3f66b772a7025549b17bcfd8aa484fc6b3ec6c01acab7033a23d7a4ad3"],
["7ac7c99db8c1ef9acfe1ad66eba1bde5a407709e89b981961365b90b3bc35de7","fd19cb33fa44c70c78b24a39a4573d89162d226ad6c5cd869e73cc6707f302fa"],
["7b5ed0c0f53a980360a4d06607c34c4008457c8de8082dce09d3a36d0d1f25fb","4a30c74c8a1b79f4e0e40d1c3031fda34e91a350fa63f054965a54d2c1872227"],
["7d8531050bf4499023e6f1c72ae2d6a8eefa5b54dbc92d77c2644ad0c6ad5cb8","1eaa1c090a5b89f3cc72900ee48c97d3958d514a0b8bf2dcd5d669424b3826f3"],
["82dea827b6e8fcd0eceee72059cb05f538daa9494ba84bea05b0a824c56a748d","3ed6a30b6a869bc881091a1f4efe4424ab95b118c67600e9a63fb39bb9909930"],
["84f27a3c7b2045ee46b9194420d0c56c6d5bb1a31243038855ca46e9e7ff581b","6c85d09e969c6ce8759490b71ff005014b23b32dc07144225f9580acaa4e5603"],
["8919b079f5209f89ba40c9679a301894a886b120e80b004df04a5dcdc3b99bcd","0bd4287fb27d100d2398f907a20e4609488600f21e05c5bb2b8beca2a8060fcf"],
["89915f1981e5b0f052aa3bfe7fe02d04aa52af104814c4076846366579f1bb1a","2f7b64afd6bf957e44678dba4ec2e5cf8f01bff2acd064045ec9b865b8e12df4"],
["8a7dc028337f583cf7f8c12f6d3a6c318fb44fcfd6588ad854702aa981eb3f97","0fa6c1b40de5efcbf40ba9ff7d2f1ba62a41858bfaa7562cbc4b1ee3f6c7ddda"],
["8ac16b3eb7d14f6b12a9e9eda12a87ad27aec420016013df824742e42c368c56","60ccce36ad6ad331e919bf5fb11eca41d26dc738a6991ae7be0249222b7d5820"],
["8d333c0b45a1e0aa141ea1b4b0ac9341077930c88d652bf36578412fa731dc99","2a9426cb558bad9806e9305847b52eb6d1974d7ef6718240c7df02368cb0affb"],
["8f801cefb9a6b9bafa18dacd49ba140e89c8f8559b45e994961fe5240001757e","66fcb6c8e8123ff97d275e300f0cdb56cdb1469857242bb2834822c505921b09"],
["93758e6f34eb57ce991c7f3bdeecabaefea26e6b027732d7aca8d35981484606","955e02035e5e322614beb48c5ae6ecd03704b34704c03380a03595860e09f967"],
["978678650e3735b594570abe544523d7a497919cc70d8ca1bd43b194731ebaae","fbd08fe8bcb46ae2542a4d640e0bca81404f0127444517468e34cc022cb85edd"],
["982ac7b6e98e36b44d1ab920f75acfa688a9baa0cf8064f44f20b9bcc5b6e685","adae75f6b43102ac7027505a6bd87242ac76ded7e069db9becd7a926ae0124a2"],
["98c9c76c0851c7e37731fbf001da27732fa36dc9486f8b9a30023f82494ccaea","a672faf74431e41c7388fea66f685a116cd34ec591ca56bcebf7111c3faa1807"],
["9a2e629d8e68cf023faa12a434d8dbcf60371e5c1ae448d2784e845015d6e0a7","3679e383f44107099dd2c9f3dbd719b55540b335e715e8fcfba12d9f7bdd9252"],
["9bb8e565a8440dc3f76339f35c319af8c5f0ded4c57753ebbddc095346400c99","4d54964151b53f5e2981b76e0d08e39c0be81f7d428a03eef059e017a0ea2d8b"],
["9ddd815f1c3be32202230d2a78b56a4ca6a8b4486bd234db42d00c2e3918f6b8","16bb873b5139d1e75ce5b8f89cc93a531796efcd72ad16f8733ea2c8a007126b"],
["9e1f119ef4f4f35f9bb47529cf04da52e60b11948b5d67fee2ec4b3a13c1b51c","4e662133359b6602bed0061be0f9a67cad5877a48e0fcf568105b170f2dce9e9"],
["9e320d4638bb9b34d943c36a7755904ff4ce8598c0d332c1361c972b5f16101c","2205da7d0b8466f7c857eaf6ef540048372904eb66699dfb41c5e675d2128d7c"],
["9fe180c575147edc3f037dd0c2b8edb0ebd3c7cd4bb51307f260a185cbfc597a","66d39ef19a16a8abd963e18eadfabc3851bb266ed60ced7df9da81ed6c8afc4e"],
["a188b7130010faeb6efe071d3968069465093d835146a02722c9c79b9af7bb92","e21efae3c666f1776892323aae048db13f76645f0261ec17b0a2da60e51e6159"],
["a2012c09ed65dd4623528d2767c291a92a1164fa2b7dc43674a35a44b606953e","21094b3761fffe3ff571a979f22e5e43b193be753bed800417f172220d22a1e8"],
["a44c4497e0da114ca576961ac327c0bc79ed65d8942bc57d2b4c1fdbcbb5094e","bb00959a63926a075b4166f902fa1ddad11d6eb27cae9f2950e4822aedb648e9"],
["a633b5556c9365a5ff6e36b8a82679ff338270987ff403847ef227791b54f4ca","66102acf490b1062e76f0f3d176e114f92b9bedaa6dbfc2aa82e28bdd5155677"],
["a99cc96a6be72e4412e3061490b771e3d68ec59b7216882821c1d2c7b7b7f938","48add54da623f5cd6c9b08f26ecf1566bc7dd49513e46862ed58f23502d9ac27"],
["adf97ca54edbdbc7c6c288db9b2989f42ece64c842511c391515410eb99b6337","001b13a39e38400203ce4547e845214ad75f3c2627f3e7c3e76169bcafde5392"],
["b094d67cc2731218d98f3c6eb826af85e7446c2da3079c06d03a6eb223229862","2ac0596f7bb4fc42d881c6f642c4caa33b7ecf43a0024143e8ac77c93145a37e"],
["b37ca6b668082df07b0a4f3c53cc5f258c665417b39f4e26c79eeb5259424e37","f53438b122b5e60272bdf4b915ff768b215853dbacffab5ddf546029d1a4ed7e"],
["b7763dd17071d5d51c0180e670f6c5b4f5bdc6b550062ab5e9f26e1de7a641bd","b1ead116b65d7dbcbebe6ca0e803c76f1ccc8bc43edda5d67f2f7c74defa7aa0"],
["bb6a36e92a7325af93ac14dea0638596bac874d7f87b80513b173ef8d30f9d79","45e78bf05076775635b92b31e68eec75f44d843d4bc2bf3c9f5da855e9f48924"],
["bbb4990da93df6fc1698e9feef416ac4182c5cee1d416b6834157004ef203e7f","d3c1548acb64b50b2f91ca8739d322834d72d10d682c77b4dac31287abe347fb"],
["bc8e44404ebb95e1b97b33a3fc30bdc0726017c211d758b29094cfc02a5a3572","1d2e1207c60fbe8b0d1e7a33aa2fa95a22296fdb4726835ba7626eabbc3452dd"],
["c246cd8927412ca6fdb09280cdd17ea74bba0b9dbc8e66790173425f89023ec4","02254e71d8415e01722a061b4debe9e40c6f92f32759ce3413b516dc975b7549"],
["c3483ef5efd050757d792be1e8883d43a36f19983ec8f7cb2f508f9195aca11a","5b82f1dd3041517682756ff9c56e2b8eedd6bd8b47ee28d2f5c99160b0418320"],
["cc227b0e7ade1b53d734a384d55e4d4e95d695db5a8a8627428d9dca19ade8b6","a2f1b7bb6052c105ed03a63be3cd8b55895d25f4c2147b3cd7b5b42db736d59b"],
["cd096cb0d24cb71fa13e53efccd1300fe0372fdcf1daef43504e48ca1d679bfd","55522549bda824f68a40ecf8c5f904d5ab301d6de05975b9378cd366af15ec72"],
["d06b9b1cc45fdfe24acf6a57e21d037369332a0003bb54bb67ac2edfcb998ad3","0db0de9d2454d12382e990da117e0ef2469cca42024456d890e950e0fef2f5c9"],
["d0d7cf192f36bc3087188ff879e0dd9f20059a93c11b73581a74796b8a78f669","2aa0dafc5e3932f1f073aa8e757bae27db059d463f4beefa537230eaca08b7d0"],
["d3b6fd2f1db552aa552830f65a828b887845142be643a5a748d57ddaaf0c2918","7091314d7a0649ea900a2a3e6cb4b01899f746729d3dbf8a25196de104d65457"],
["d3f374c09352a793cda9aa23576491cd7cd4da5ae49c83baec7081297cae3f3c","65451df92fdd7150b465fa25872de7efb76e9b08f8758f677e8550eb8d66906d"],
["d808cc718f6df20d437875967170180052fae2fb4ac960d236d3e2b83e3b0f39","6b96a6cb4f88d1b8c93e3dd8eaf484e651c17ec0b2b9ed929f030c72fcfa4a94"],
["da823c13d90284c2ab196452e9b4fe508506cabfc078ca8c71cb7687bb5d76b9","00c1d3e80dc25d10bfb88865189e9eaca2cd155128f8fc6fb9427080cf257f6e"],
["dc1fa21cf92e9aba5caa80a777b73e80819aabaa063221541b0056803b50844f","c520cfb9200cdf55a3412bd1ab995da6a9188c630670bcdb5918beeff72673e7"],
["e24448751d7d0800f7d007a6439ce922639016987943ce42aa0a88e49096dcb8","44e8863d84f633dfeca64d85d23a3068ad0a823065193049c9f91f21dab9097d"],
["e49375406fde306c7aac171304917ce5e40af153d7d44733ab559bb58df66794","37bf3e2ca0ec127c4fd41390ccf83caf3a6a740e088335269ec6817a9cdf27f5"],
["e7c7918619e015c1759d6991e314aef510776a4accdba46b9eae0284c6221943","547b7160dd71a2293fdb90c1e462a47c253b15d4ce1be67e3844f533218b5cde"],
["ea82ae79aba5e904693d7b2781b5572b8f93a62be9915b9d5ca85c18e4954dcc","8b41a1442886f545d59fdcc34055ea7851c2ae0f01dd9cda5df5471de3bb7295"],
["ef985316121c24bcf160f77a0bfb3fbeb574b47ea1ec5ca565c13813fd02f657","5c88f555ab5cc5fbeeabaf5e259f01ce910c7ed6ddc8b2439827146975871271"],
["f00f09f93733dc2b17074978d97f40d2fbdffdc4d57a20f21c0f8f6cb9695b96","6a4af83219b96a7dbb937407d619d4d3679d79abea730f0c3c1ba93cd1a669fb"],
["f10e3c67b43d4475e47eca4bb0567f85a734d76d76919e0f6b73aa14469281fa","fe81ed55a060db5e9cb45457397be9d698b815b6dacc9715ece334b0c01a2290"],
["f1666064507c370c0f91204ec84b188f18084223f71c7087e78f1f7dda578437","2a61f40448cb7636bda411afca804564d10ab4600c5521e4fd36303ec9e803cb"],
["f373c64f49a703665c9b61439dcd46ea6af2048550e2481d2d4a8479cc0b2f5d","2dcae3caa3b05e0c256a50853c7ec3a143e44e9369d7c64545a620e07c0c2d0d"],
["f6a96e1c8c642e4e82e10825585423c5efb32f8260b40aae6fe3af350685eb12","c95194050b0edde7b9063dd2f341d1f055c9823c00108e429a06f68ab2afab44"],
["fb79f626a95290a2069d975a5e0e852efc995ed52046e9951aff177738be65a8","e5519b1254f4b5d0d4b4e0d58a190efa75f608f04810b1524dcbb23933c2be7f"],
["fc4c6bc59389ee74553629e921a6344df211eb9824f773b52db8107684141feb","b222e2b9368b97af60667cc00e7697edb681edbe92fea7eebcba0ea73bf299ca"],
["ffb29e4cf7bec22ea76993edba56c5b47cc5b9fb051f6d2c67234eec0e86905f","d06062d4c29588b3428a7482a832cea364ca0efa94300a8b3a0330ce65071e43"]]
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
  AND a.visibility='public' AND a.owner=ANY(c.members) AND a.instructions_bundle IS NOT NULL
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
  WHERE x.org_id=c.org_id AND (x.owner<>ALL(c.members) OR x.instructions_bundle IS NULL
    OR x.visibility NOT IN ('public','private'))
)
AND NOT EXISTS (
  SELECT 1 FROM chat_threads x JOIN agents source ON source.id=x.agent_id
  WHERE source.org_id=c.org_id AND source.id<>c.default_agent_id
    AND (x.project_id IS NOT NULL
      OR (x.user_id=ANY(c.members) AND source.visibility='private' AND x.user_id<>source.owner))
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
    RAISE EXCEPTION 'Remaining My Okou trigger association changed before cutover';
  END IF;
END $$;
CREATE TEMP TABLE remaining_automation_thread_source ON COMMIT DROP AS
SELECT b.id,b.org_id,b.workflow_id,to_jsonb(b) AS original_row
FROM inactive_copy_target t JOIN workflow_user_automation_threads b USING(org_id)
JOIN workflows w ON w.id=b.workflow_id AND w.org_id=b.org_id
WHERE w.agent_id<>t.default_agent_id AND w.owner_user_id=ANY(t.members)
ORDER BY b.id FOR NO KEY UPDATE OF b;
--> statement-breakpoint
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
JOIN inactive_copy_target t ON t.org_id=a.org_id AND c.user_id=ANY(t.members);
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
    RAISE EXCEPTION 'Remaining My Okou source changed during cutover';
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
    RAISE EXCEPTION 'Remaining My Okou member state changed during cutover';
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
  VALUES (edition.id,content_json::jsonb,revision_hash,revision.starts_at,revision.expires_at,'migration:1590')
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
DROP FUNCTION pg_temp.inactive_batch_uuid(text);
