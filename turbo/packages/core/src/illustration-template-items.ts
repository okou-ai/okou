const ILLUSTRATION_ASSET_BASE =
  "https://static.vm0.io/vm0/artifact-templates/illustration/assets";

/**
 * Maps each illustration asset's logical path (e.g. `images/<file>` or
 * `refs/<slug>/<file>`) to its object path under {@link ILLUSTRATION_ASSET_BASE}
 * on the static asset mirror. Static objects keep their content-addressed
 * object path, so the logical path cannot be derived from the URL; resolve with
 * {@link illustrationAssetUrl}.
 */
const ILLUSTRATION_ASSET_PATHS: Record<string, string> = {
  "refs/emboss-deboss/ref-sleeping-cat-ivory.jpg":
    "a02bb092-3077-4912-a5be-58d940a0e993/ref-sleeping-cat-ivory.jpg",
  "refs/emboss-deboss/ref-beyond-ivory.jpg":
    "7d58d19d-7af8-40bb-8fc6-d0e19854ae77/ref-beyond-ivory.jpg",
  "refs/emboss-deboss/ref-wind-space-blush.jpg":
    "8e2f9926-14bd-459d-b2b1-5b06569b4f9e/ref-wind-space-blush.jpg",
  "images/editorial-flatfolk.png":
    "5ccf0d60-b59e-4fe8-8388-1cdb8c5e57d9/editorial-flatfolk.png",
  "images/endpaper.png": "0712c960-8336-4ef5-b6bf-9a6bea30ee6a/endpaper.png",
  "images/flat-poster.png":
    "6e67ff2b-bafb-4ae8-b9f5-ac810e156cad/flat-poster.png",
  "images/folk-muse.png": "ab19110c-bdca-4342-b4ea-81bc9da7f992/folk-muse.png",
  "images/folk-storybook.png":
    "8a061600-29d3-4c1b-a7f8-ed534bb068bb/folk-storybook.png",
  "images/grain-poster.png":
    "b782b0a8-8fc4-4f1a-a5d9-fc8be7cd5eae/grain-poster.png",
  "images/grainy-duotone.png":
    "94e6a6bf-545a-4579-b1ab-672d9ebaadf0/grainy-duotone.png",
  "images/ink-mascot.png":
    "3a32149b-beed-468a-ab95-d7c66161b056/ink-mascot.png",
  "images/inkdab.png": "52f4536c-8bcb-459a-bd9e-db122b587c5a/inkdab.png",
  "images/inkstomp.png": "b4374019-26c4-43dc-ac72-738119dd8aed/inkstomp.png",
  "images/iso-scene.png": "a5584c98-8d92-43f7-a3ce-36d3a50dee70/iso-scene.png",
  "images/light-pop-portrait.png":
    "9380ec74-934d-4a30-a7c4-6b331141ba68/light-pop-portrait.png",
  "images/loose-contour.png":
    "39072bd9-f829-461c-ba9b-df09d0a6536a/loose-contour.png",
  "images/mellow-pop.png":
    "3b032b04-9fa0-4833-a77f-4d583f076cfc/mellow-pop.png",
  "images/mosaic-still-life.png":
    "1c9ac1aa-3b52-4278-a0b5-c9a0b0420fc9/mosaic-still-life.png",
  "images/notion-illustration.png":
    "d99d73e6-55f3-48d8-8382-f1f780839f2f/notion-illustration.png",
  "images/op-ed-cover.png":
    "627e3b90-fdb3-4b2a-a082-0106ebf2f4a0/op-ed-cover.png",
  "images/painterly-botanical.png":
    "d6c7d725-194d-4014-b016-adb6f222ce2a/painterly-botanical.png",
  "images/papernook.png": "7c5403b8-66b8-4767-bf9e-741994fd2d52/papernook.png",
  "images/postcard-illustration.png":
    "ee24ef09-ae82-4dac-b6a0-cf0506498936/postcard-illustration.png",
  "images/riso-relic.png":
    "e7fa57b9-c322-4caa-8dd7-cea841a63c1e/riso-relic.png",
  "images/sticker-sheet.png":
    "a4dcdc0b-a08a-4996-bc13-d7c1a6e4beb2/sticker-sheet.png",
  "images/sunlit-gouache.png":
    "e1479a4d-be2b-4aeb-bfac-5db0fc5d5b88/sunlit-gouache.png",
  "refs/cozy-parlor/ref-frog-letters.jpg":
    "03982053-3118-403a-88db-7888b76dca20/ref-frog-letters.jpg",
  "refs/cozy-parlor/ref-hedgehog-records.jpg":
    "2467a4e3-7ae7-4fa7-8afd-94816ef138f7/ref-hedgehog-records.jpg",
  "refs/cozy-parlor/ref-mouse-baker.jpg":
    "ea8c05d3-5b8f-4f15-9df6-b9a922e39fcd/ref-mouse-baker.jpg",
  "refs/cozy-parlor/ref-otter-painter.jpg":
    "b6436d4e-6b77-4ca4-8b34-018ad82c543b/ref-otter-painter.jpg",
  "refs/crowd-ink/anchor.png":
    "d7c41a80-d95e-46f2-b4df-40a6fbd51881/anchor.png",
  "refs/crowd-ink/sample-cafe.png":
    "a6b49737-91a2-404c-bb3a-74acb588efd8/sample-cafe.png",
  "refs/crowd-ink/sample-office.png":
    "524fd8ba-66eb-4da8-8c82-a184affe3960/sample-office.png",
  "refs/crowd-ink/sample-picnic.png":
    "3ed9f72f-fb70-433f-9b58-675eb592767e/sample-picnic.png",
  "refs/crowd-ink/sample-subway.png":
    "5614f816-0524-437f-a5f8-4966cec2929b/sample-subway.png",
  "refs/editorial-flatfolk/ref-alpine.png":
    "34acbd1a-8633-478c-ac6c-a4cee0a26324/ref-alpine.png",
  "refs/editorial-flatfolk/ref-harbor.png":
    "0e91e2f6-2147-4b33-a034-2efb3d834cf4/ref-harbor.png",
  "refs/editorial-flatfolk/ref-park.png":
    "d1e7603c-66ad-4f42-94b4-d3eff6660061/ref-park.png",
  "refs/endpaper/ref-butter-birds-l3.png":
    "ce707dcb-7a69-46d2-be8f-2e78d6eaded7/ref-butter-birds-l3.png",
  "refs/endpaper/ref-cobalt-sea-l3.png":
    "4f98961a-643a-4bea-bafd-6f4ed24cb71f/ref-cobalt-sea-l3.png",
  "refs/endpaper/ref-mossy-teal-cats-l2.png":
    "e78941dc-c179-44e7-b118-2d7c1b5cf214/ref-mossy-teal-cats-l2.png",
  "refs/endpaper/ref-plum-foxes-l2.png":
    "f06ba5e9-5ef0-4274-be56-dcc8995ec103/ref-plum-foxes-l2.png",
  "refs/endpaper/ref-slate-houseplants-l2.png":
    "4ab546ed-7fbf-4888-add3-9d6aac92d7d0/ref-slate-houseplants-l2.png",
  "refs/flat-poster/ref-lightbulb-sky-thinkbigger.png":
    "cbd54115-c2c3-492d-aefc-dfcd2954e3b7/ref-lightbulb-sky-thinkbigger.png",
  "refs/flat-poster/ref-magnifier-mustard-lookcloser.png":
    "af37f430-5bde-40a8-8d81-8733eb3462c9/ref-magnifier-mustard-lookcloser.png",
  "refs/flat-poster/ref-mountain-rose-reachhigher.png":
    "e4842d84-8c94-4e67-a0b0-d1b49841f609/ref-mountain-rose-reachhigher.png",
  "refs/flat-poster/ref-robot-yellow-aiteammate.png":
    "dbcd0941-0066-4ce1-92b9-f59477d72a05/ref-robot-yellow-aiteammate.png",
  "refs/flat-poster/ref-rocket-coral-shipfaster.png":
    "58b8a1f3-0ab2-4937-a7b3-8b3c4f14ae22/ref-rocket-coral-shipfaster.png",
  "refs/flat-poster/ref-shield-sage-alwayson.png":
    "ac81f77b-9e0a-427b-830b-f6769899b9bc/ref-shield-sage-alwayson.png",
  "refs/flat-poster/ref-teacup-lavender-takeabeat.png":
    "4074e795-dde6-4a2d-a47c-454f2e497f31/ref-teacup-lavender-takeabeat.png",
  "refs/folk-muse/ref-canonical.png":
    "ae0b2abc-a73f-4ebb-a3f1-74aece4a3819/ref-canonical.png",
  "refs/folk-muse/ref-sunset-dove.png":
    "7ecd9aef-7ae1-46cc-a883-f1966ad11357/ref-sunset-dove.png",
  "refs/folk-muse/ref-tropical-butterfly.png":
    "4738899c-de7c-43b9-8e02-58ff668abfb2/ref-tropical-butterfly.png",
  "refs/folk-muse/ref-winter-cat.png":
    "d2d649cf-06f4-4572-8789-7fc543660507/ref-winter-cat.png",
  "refs/folk-storybook/ref-chill-tussle.jpg":
    "db4d4ae6-2e10-4b8e-86c6-8fdc2d9d45dc/ref-chill-tussle.jpg",
  "refs/folk-storybook/ref-puzzle.jpg":
    "6825058e-9a8b-465d-9b59-3d4bd36349b9/ref-puzzle.jpg",
  "refs/folk-storybook/ref-reading-nook.jpg":
    "045ba54a-8a7e-452f-9b5a-96fa727bd46a/ref-reading-nook.jpg",
  "refs/grain-poster/ref-bench-sunsetcoral-l2-pair.png":
    "303ce995-e8a0-4916-8aff-af2a269af9be/ref-bench-sunsetcoral-l2-pair.png",
  "refs/grain-poster/ref-cafe-cooldawn-l2-solo.png":
    "a356e5b4-5aa4-47e1-bb03-63c7c939db3d/ref-cafe-cooldawn-l2-solo.png",
  "refs/grain-poster/ref-dogwalker-forestgreen-l1-solo.png":
    "a24cfc2d-072e-4045-9d9b-7cd103e144c1/ref-dogwalker-forestgreen-l1-solo.png",
  "refs/grain-poster/ref-guitar-twilight-l1-solo.png":
    "fe1fcd12-afd8-4199-8b6b-39e307160f10/ref-guitar-twilight-l1-solo.png",
  "refs/grain-poster/ref-skateboard-cooldawn-l1-solo.png":
    "06e37fc6-9a6a-467d-b4b5-88abafd95fb6/ref-skateboard-cooldawn-l1-solo.png",
  "refs/grain-poster/ref-sunhat-sunsetcoral-l1-solo.png":
    "e97eda11-aeb5-4f97-8e21-b7368fe78b32/ref-sunhat-sunsetcoral-l1-solo.png",
  "refs/grain-poster/ref-twilightdesk-twilight-l3-solo.png":
    "fd69b40d-b616-48e9-88e1-20fa75d098f8/ref-twilightdesk-twilight-l3-solo.png",
  "refs/grainy-duotone/ref-balloons-navy-peach-l3.png":
    "d02b846f-2c93-44b6-a5bb-aa92a38d187d/ref-balloons-navy-peach-l3.png",
  "refs/grainy-duotone/ref-ladder-burgundy-pink-l2.png":
    "ff9caf48-1ce2-4d0e-b0b4-7a182c29e05f/ref-ladder-burgundy-pink-l2.png",
  "refs/grainy-duotone/ref-launch-pennant-1.png":
    "80cc238d-e265-4572-821e-55de056f86b8/ref-launch-pennant-1.png",
  "refs/grainy-duotone/ref-launch-pennant-2.png":
    "455c76d4-6bde-48ab-b09b-ee515820842c/ref-launch-pennant-2.png",
  "refs/grainy-duotone/ref-launch-pennant-3.png":
    "d1f61bf6-ca9d-47da-99f0-ecca26e98e60/ref-launch-pennant-3.png",
  "refs/grainy-duotone/ref-magnifier-lavender-mustard-l2.png":
    "4014cc28-4c70-40ce-b064-273110d755d0/ref-magnifier-lavender-mustard-l2.png",
  "refs/grainy-duotone/ref-sprout-sage-coral-l1.png":
    "45bc11dd-e170-4648-9da1-9b857b9ba580/ref-sprout-sage-coral-l1.png",
  "refs/iberian-vignette/ref-l1-manana.png":
    "f2468abc-cc1f-400e-904f-51c347d6d6a9/ref-l1-manana.png",
  "refs/iberian-vignette/ref-l2-cafe.png":
    "62dae763-a448-4633-a8db-5f0dcf7275d7/ref-l2-cafe.png",
  "refs/iberian-vignette/ref-l2-ritmo.png":
    "11a11d62-1c25-4878-960f-516c50000f3c/ref-l2-ritmo.png",
  "refs/iberian-vignette/ref-l3-familia.png":
    "2a924927-8fdc-4206-a248-c58f8f62005f/ref-l3-familia.png",
  "refs/ink-mascot/ref-branding-mint.png":
    "a16903ff-ba02-40d9-b31e-2d71982dbe5e/ref-branding-mint.png",
  "refs/ink-mascot/ref-content-terracotta.png":
    "45a3afef-123f-4814-96b5-bedb5d6c19e5/ref-content-terracotta.png",
  "refs/ink-mascot/ref-conversion-sage.png":
    "fe2841d0-3be1-4a1e-8a70-8352a070ef92/ref-conversion-sage.png",
  "refs/ink-mascot/ref-email-lavender.png":
    "6f4ad9da-9af3-4b70-a811-518817cbc03e/ref-email-lavender.png",
  "refs/ink-mascot/ref-growth-forest.png":
    "10f34cdf-de0d-4c1f-acaf-cd9c25c17a27/ref-growth-forest.png",
  "refs/ink-mascot/ref-launch-tangerine.png":
    "75f29fd8-4ac4-446f-8ba6-e48edb82473d/ref-launch-tangerine.png",
  "refs/ink-mascot/ref-loyalty-plum.png":
    "4c9f2530-1efe-4026-a9ce-8213f27c987b/ref-loyalty-plum.png",
  "refs/ink-mascot/ref-seo-coral.png":
    "5c75119b-da55-4528-8ff7-53bc7616bfc4/ref-seo-coral.png",
  "refs/ink-storefront/ref-l1-lupo.png":
    "6723fa07-1951-428e-a961-6ea5f8498776/ref-l1-lupo.png",
  "refs/ink-storefront/ref-l1-petit-pain.png":
    "0990f996-ca32-4c1e-b086-cf66d6d35ea6/ref-l1-petit-pain.png",
  "refs/ink-storefront/ref-l2-fleur-fern.png":
    "4638ab2a-7540-4938-9342-6a96785c39b6/ref-l2-fleur-fern.png",
  "refs/inkdab/ref-brainstorm-butter-cream-rich.png":
    "69b51b63-6f35-4065-94f5-b6399f42e779/ref-brainstorm-butter-cream-rich.png",
  "refs/inkdab/ref-calling-blue-light.png":
    "74316ebe-505d-4dc0-94a6-f0c0280fd934/ref-calling-blue-light.png",
  "refs/inkdab/ref-handoff-dusty-pink.png":
    "52911b07-baf9-4777-82c6-1b723ae8daae/ref-handoff-dusty-pink.png",
  "refs/inkdab/ref-pitch-blue.png":
    "308fbe8e-051b-414a-9be3-40dd5174fc3e/ref-pitch-blue.png",
  "refs/inkdab/ref-reading-lavender-rich.png":
    "7a9351df-62fe-410d-8938-572742ab1fbe/ref-reading-lavender-rich.png",
  "refs/inkstomp/ref-climb-climb.png":
    "bd18e3ee-5f17-47b1-885d-71c9a4eb8770/ref-climb-climb.png",
  "refs/inkstomp/ref-crunchy-cricket.png":
    "a04f61d7-56fb-4213-b587-501d23bf0cea/ref-crunchy-cricket.png",
  "refs/inkstomp/ref-greasy-griddle.png":
    "5d49301d-3dc6-4298-8dea-1c1129ebdeef/ref-greasy-griddle.png",
  "refs/inkstomp/ref-jolly-jalapeno.png":
    "dabaab5f-d480-4dd5-aa12-59c29185062f/ref-jolly-jalapeno.png",
  "refs/inkstomp/ref-pocket-plum.png":
    "280e2782-50b4-42d7-8d64-8e17c63d8ef9/ref-pocket-plum.png",
  "refs/inkstomp/ref-quiet-quitter.png":
    "928239cf-52a1-41f3-a01c-d19ba0f9d628/ref-quiet-quitter.png",
  "refs/inkstomp/ref-rocket-roach.png":
    "2b7b8ce1-5cc3-42c6-b699-b73a12172b24/ref-rocket-roach.png",
  "refs/inkstomp/ref-turbo-tofu.png":
    "5ee79599-3e9f-466c-904a-695b37abe14f/ref-turbo-tofu.png",
  "refs/iso-scene/blue-city-construction.png":
    "0ba14b24-74fa-4953-98ec-1bf0d6326705/blue-city-construction.png",
  "refs/iso-scene/coral-hanging-garden.png":
    "eff3b4d8-1279-4540-a23c-72ab74ff60a7/coral-hanging-garden.png",
  "refs/iso-scene/sky-castle.png":
    "1604e46a-2bf9-4664-85c1-9991f634901d/sky-castle.png",
  "refs/iso-scene/yellow-floating-island-park.png":
    "3ebb7c87-5411-41ea-89cd-8a49cc676dec/yellow-floating-island-park.png",
  "refs/jade-blockprint/ref-cobalt-ship-l2.png":
    "105b7927-8114-4537-b3eb-6b5afed28751/ref-cobalt-ship-l2.png",
  "refs/jade-blockprint/ref-coral-turntable-l1.png":
    "7f049e9f-351f-4e57-923a-80fadf320d47/ref-coral-turntable-l1.png",
  "refs/jade-blockprint/ref-mustard-monstera-l1.png":
    "b73af11f-17c5-4392-9c0d-3f065ab3a7cd/ref-mustard-monstera-l1.png",
  "refs/jade-blockprint/ref-rose-perfume-l2.png":
    "5af0b018-e607-4a78-9c20-bedadbe2a562/ref-rose-perfume-l2.png",
  "refs/jade-blockprint/ref-sage-sprout-l1.png":
    "a1ce6abf-3823-4b00-9fbd-f03b0a1f338f/ref-sage-sprout-l1.png",
  "refs/jade-blockprint/ref-sage-teapot-l1.png":
    "7622f65a-6ef2-4a80-af36-df929b0bcc07/ref-sage-teapot-l1.png",
  "refs/jade-blockprint/ref-slate-pen-notebook-l2.png":
    "0e62d94c-93ef-4d3a-93c0-8740107c844a/ref-slate-pen-notebook-l2.png",
  "refs/jade-blockprint/ref-terracotta-pitcher-l2.png":
    "686886ff-a72b-447a-8027-d9fb396438be/ref-terracotta-pitcher-l2.png",
  "refs/light-pop-portrait/ref-laughing-girl-braids-magenta.png":
    "d5e3be91-b682-417c-b2fa-a2d9d7930d29/ref-laughing-girl-braids-magenta.png",
  "refs/light-pop-portrait/ref-sleepy-girl-bunny-peach.png":
    "50061e64-b43f-4a80-84ff-08460b997db3/ref-sleepy-girl-bunny-peach.png",
  "refs/light-pop-portrait/ref-sly-boy-popsicle-lavender.png":
    "40347905-7f67-48a5-b52c-5b1f0c140c97/ref-sly-boy-popsicle-lavender.png",
  "refs/light-pop-portrait/ref-surprised-boy-frog-mint.png":
    "8838de52-83fa-417f-b0ed-958086792f8c/ref-surprised-boy-frog-mint.png",
  "refs/light-pop-portrait/ref-yellowhat-mushroom-cobalt.png":
    "d1046fdb-418f-4c98-9308-bb96f0063bb0/ref-yellowhat-mushroom-cobalt.png",
  "refs/light-pop-portrait/ref-zen-kid-bird-teal.png":
    "4de21e05-47b8-4b5e-8385-993d616fb1dc/ref-zen-kid-bird-teal.png",
  "refs/loose-contour/ref-l1-mustard-hand.png":
    "e0ef3f95-d7db-4034-97e3-63fbf4586e42/ref-l1-mustard-hand.png",
  "refs/loose-contour/ref-l2-blue-laptop.png":
    "ff8a4838-974e-497c-91a5-2ce6d9fe61f6/ref-l2-blue-laptop.png",
  "refs/loose-contour/ref-l2-coral-envelope.png":
    "11f1cd73-7771-4963-a33c-eaf37528f413/ref-l2-coral-envelope.png",
  "refs/loose-contour/ref-l2-coral-twohands.png":
    "803e3715-c86f-4390-a1e0-a600acaf9b2e/ref-l2-coral-twohands.png",
  "refs/loose-contour/ref-l3-balanced-vignette.png":
    "970da081-2817-491b-91e9-faa2ce18e73b/ref-l3-balanced-vignette.png",
  "refs/mellow-pop/ref-coral-leaf-hug.png":
    "2d04dac1-6c3d-4d28-a369-846373695eb7/ref-coral-leaf-hug.png",
  "refs/mellow-pop/ref-coral-lilypad-path-l3.png":
    "fc588265-b9ca-43fc-8672-65351701b410/ref-coral-lilypad-path-l3.png",
  "refs/mellow-pop/ref-indigo-sticky-moon-l3.png":
    "37c75806-951a-411c-8fe9-e20b2988b5ca/ref-indigo-sticky-moon-l3.png",
  "refs/mellow-pop/ref-lavender-shell-soundwaves-l3.png":
    "fc512536-b370-4af7-906a-4e590aacaa0a/ref-lavender-shell-soundwaves-l3.png",
  "refs/mellow-pop/ref-lavender-tulip-l2.png":
    "8e8ac32f-ca81-43ac-839c-4d6ae72036de/ref-lavender-tulip-l2.png",
  "refs/mellow-pop/ref-mint-open-book-l2.png":
    "487d5b3c-ef63-4e5f-8af1-3d4a849a9091/ref-mint-open-book-l2.png",
  "refs/mellow-pop/ref-periwinkle-phone-l1.png":
    "215178df-bca9-4c99-8451-5a5f53e279c4/ref-periwinkle-phone-l1.png",
  "refs/mellow-pop/ref-yellow-garden-butterflies-l3.png":
    "7e71b281-eb87-4bfe-bb96-cf0a3f66d33a/ref-yellow-garden-butterflies-l3.png",
  "refs/mellow-pop/ref-yellow-lightbulb-l1.png":
    "89e40858-4023-4210-b222-413a2717511d/ref-yellow-lightbulb-l1.png",
  "refs/mosaic-still-life/ref-art-studio.jpg":
    "86d48554-7ce6-420f-9cf1-27767d7d6767/ref-art-studio.jpg",
  "refs/mosaic-still-life/ref-autumn-cottage.jpg":
    "9d129b9b-dd84-40d1-b387-2effe4f6a8bc/ref-autumn-cottage.jpg",
  "refs/mosaic-still-life/ref-beach-picnic.jpg":
    "4afcc2db-c81b-42f0-94db-37b40b2aa786/ref-beach-picnic.jpg",
  "refs/mosaic-still-life/ref-kitchen.jpg":
    "f642e532-972e-4ed2-94bc-66754fa2da95/ref-kitchen.jpg",
  "refs/mosaic-still-life/ref-mediterranean.jpg":
    "87cee726-b222-42c8-b23d-b9e33742f2a9/ref-mediterranean.jpg",
  "refs/mosaic-still-life/ref-moonlit-garden.jpg":
    "76f45eab-66be-4f51-816c-34e1494dce46/ref-moonlit-garden.jpg",
  "refs/mosaic-still-life/ref-reading-nook.jpg":
    "2d9fb866-3b5e-47e4-8f45-28210ef3fd7d/ref-reading-nook.jpg",
  "refs/mosaic-still-life/ref-workshop.jpg":
    "ee358efe-c9f9-44eb-bfb3-d8d7f14ed1c4/ref-workshop.jpg",
  "refs/notion-illustration/ref-candle-lighting.png":
    "31fbcae8-98a6-4f9d-aec1-0fa4c0103e6e/ref-candle-lighting.png",
  "refs/notion-illustration/ref-evening-sketching.png":
    "6a34c410-d6c3-41ec-aea2-961fa51ddb10/ref-evening-sketching.png",
  "refs/notion-illustration/ref-evening-stretch.png":
    "c74fffa1-bc09-4ad8-91d2-180f2d1bc71a/ref-evening-stretch.png",
  "refs/notion-illustration/ref-pouring-tea.png":
    "17788881-068a-42a4-af93-62cbc5667275/ref-pouring-tea.png",
  "refs/notion-illustration/ref-reading-windowseat.png":
    "07127865-ed13-4a04-99e9-b2cbfc89e25f/ref-reading-windowseat.png",
  "refs/op-ed-cover/ref-mind-eye-contact.png":
    "f4728ea8-436c-44be-8aa9-296bc3b57334/ref-mind-eye-contact.png",
  "refs/op-ed-cover/ref-pastrami-full-volume.png":
    "216c9ad3-9d9e-4a16-82b7-0e879a5033f3/ref-pastrami-full-volume.png",
  "refs/op-ed-cover/ref-slowest-bowl.png":
    "4a65356c-2b0d-4256-a09c-9075aba644cf/ref-slowest-bowl.png",
  "refs/painterly-botanical/ref-child-wildflower-sage.png":
    "881e47a0-602f-48ca-9c2e-1423795745db/ref-child-wildflower-sage.png",
  "refs/painterly-botanical/ref-curled-up-peach-coral.png":
    "15aad0c4-3a85-4cbb-ba74-095d806760a5/ref-curled-up-peach-coral.png",
  "refs/painterly-botanical/ref-from-behind-sepia.png":
    "f9d7bbdc-5449-4d7d-a0c3-5dfd337bd6c5/ref-from-behind-sepia.png",
  "refs/painterly-botanical/ref-lotus-dusty-blue.png":
    "b4acaf29-4193-4e1f-acd4-397458b230df/ref-lotus-dusty-blue.png",
  "refs/painterly-botanical/ref-magnolia-emerald-ivory.png":
    "c5da2dff-3352-4da8-951d-eca639fb1569/ref-magnolia-emerald-ivory.png",
  "refs/painterly-botanical/ref-sunflower-sand.png":
    "4f0860dc-19fe-4497-97c4-72f1cdffa1b1/ref-sunflower-sand.png",
  "refs/painterly-botanical/ref-wisteria-lavender.png":
    "d080f0d3-f9da-431b-ba83-88eadba89d1b/ref-wisteria-lavender.png",
  "refs/painterly-botanical/ref-young-man-monstera.png":
    "ecf33b75-1068-4be9-9064-b14a48042320/ref-young-man-monstera.png",
  "refs/papernook/ref-anchor.png":
    "abb8aa87-304f-42bd-a9e5-8bf3817d6a69/ref-anchor.png",
  "refs/papernook/ref-barista.png":
    "17ce8e66-15b0-4ac0-bced-45b73a75dcc1/ref-barista.png",
  "refs/papernook/ref-engineer.png":
    "6ca628ba-4c7e-40fc-82d4-5c128f91f65d/ref-engineer.png",
  "refs/papernook/ref-meditation.png":
    "e3a39662-1710-4aa1-b805-598bc8d890d1/ref-meditation.png",
  "refs/papernook/ref-researcher.png":
    "a99ec11e-f707-497a-bebb-63cdb4c4a30f/ref-researcher.png",
  "refs/postcard-illustration/ref-sensoji.png":
    "c253d888-dc7a-4640-8383-79bef9343f23/ref-sensoji.png",
  "refs/postcard-illustration/ref-shibuya.png":
    "42971230-1487-4f61-af41-ba0c9a64c70e/ref-shibuya.png",
  "refs/riso-relic/ref-alarm-clock-tomato-wakeup.png":
    "c021c710-677b-4673-a1ee-ab168b8eb668/ref-alarm-clock-tomato-wakeup.png",
  "refs/riso-relic/ref-boombox-magenta-playloud.png":
    "8382e4e9-6e75-4fe4-8b6d-0fb7fad6e3a1/ref-boombox-magenta-playloud.png",
  "refs/riso-relic/ref-cassette-violet-mixtape.png":
    "78c5f7f2-f9bc-45c6-b917-67313c3b2f74/ref-cassette-violet-mixtape.png",
  "refs/riso-relic/ref-polaroid-sky-saycheese.png":
    "a24b583b-a545-4473-8a3e-23f301571e5c/ref-polaroid-sky-saycheese.png",
  "refs/riso-relic/ref-rotary-phone-mustard-ringring.png":
    "442b660f-ba80-47db-a98c-8322d7be2294/ref-rotary-phone-mustard-ringring.png",
  "refs/shadow-pop/ref-berry-record-l1.png":
    "634c126f-b21f-4d61-a97f-583bd5d0226c/ref-berry-record-l1.png",
  "refs/shadow-pop/ref-citrus-coffee-l3.png":
    "a4bc8084-ed7a-4acd-8ee7-949db18db919/ref-citrus-coffee-l3.png",
  "refs/shadow-pop/ref-citrus-suitcase-l3-transparent.png":
    "07a92c62-6133-4757-98ca-277c1f72184a/ref-citrus-suitcase-l3-transparent.png",
  "refs/shadow-pop/ref-default-mail-l2.png":
    "e02fe878-5702-4a68-8b4c-82acaba3a8b2/ref-default-mail-l2.png",
  "refs/shadow-pop/ref-tropical-plant-l2.png":
    "9ebb37dd-3500-4af0-9688-fe5a1901b4b5/ref-tropical-plant-l2.png",
  "refs/soft-vector/ref-bike-lime.png":
    "22708177-11bf-487c-b7d2-27f58f1523c9/ref-bike-lime.png",
  "refs/soft-vector/ref-desk-violet.png":
    "db4c7752-d7de-4b90-ad1e-caa00b3a348f/ref-desk-violet.png",
  "refs/soft-vector/ref-mug-mustard.png":
    "dc49674a-dfc3-42e5-a7a5-15a1d5c5758e/ref-mug-mustard.png",
  "refs/sticker-sheet/ref-desk.jpg":
    "3f7e4ef5-4b6b-44ed-8705-1aaf04f5a22a/ref-desk.jpg",
  "refs/sticker-sheet/ref-kitchen.jpg":
    "725ad48d-831a-4f6b-9fc0-a6a8b419610d/ref-kitchen.jpg",
  "refs/sticker-sheet/ref-plants.jpg":
    "37971d40-21b9-4427-b4cf-e139aa462783/ref-plants.jpg",
  "refs/sticker-sheet/ref-travel.jpg":
    "dc8fb342-a90a-4511-8954-1598b175e34a/ref-travel.jpg",
  "refs/sunlit-gouache/ref-bookshop-interior.jpg":
    "bb2f13d1-f849-4a5c-a493-524bc0eda5c2/ref-bookshop-interior.jpg",
  "refs/sunlit-gouache/ref-cafe-terrace.jpg":
    "5ccf8eca-3f37-4598-ae00-045e4ed7532c/ref-cafe-terrace.jpg",
  "refs/sunlit-gouache/ref-market-arcade.jpg":
    "0739d94c-0b6e-465c-9f53-9cc9a74296ec/ref-market-arcade.jpg",
  "refs/sunlit-gouache/ref-temple-courtyard.jpg":
    "d03acdc5-8bd5-41d0-8574-801fbbbb4af4/ref-temple-courtyard.jpg",
  "refs/sunlit-gouache/ref-tram-stop.jpg":
    "33e80135-0bca-4f22-9682-60a3803f5939/ref-tram-stop.jpg",
  "refs/tiny-wanderer/varA.jpg":
    "d27f7982-f692-4724-9a68-f0c796b9d271/varA.jpg",
  "refs/tiny-wanderer/varB.jpg":
    "7807e3f5-0239-4996-ba14-90e434c6e124/varB.jpg",
  "refs/tiny-wanderer/varC.jpg":
    "695a67ad-099c-4262-ab36-bacebc37e8c1/varC.jpg",
  "refs/tiny-wanderer/varD.jpg":
    "11f9046a-4245-4988-a6e7-93545f69c1db/varD.jpg",
};

/** Resolve an illustration asset's logical path to its full CDN URL. */
function illustrationAssetUrl(path: string): string {
  const objectPath = ILLUSTRATION_ASSET_PATHS[path];
  if (!objectPath) {
    throw new Error(`Unknown illustration asset path: ${path}`);
  }
  return `${ILLUSTRATION_ASSET_BASE}/${objectPath}`;
}

interface IllustrationStyle {
  slug: string;
  title: string;
  image: string;
  /** Optional path under ASSET_BASE used as the card cover, e.g. "refs/<slug>/<file>". */
  cover?: string;
  width: number;
  height: number;
  refs: readonly string[];
}

const ILLUSTRATION_STYLES: readonly IllustrationStyle[] = [
  {
    slug: "emboss-deboss",
    title: "Emboss & Deboss",
    image: "emboss-deboss.jpg",
    cover: "refs/emboss-deboss/ref-sleeping-cat-ivory.jpg",
    width: 1024,
    height: 1536,
    refs: [
      "ref-sleeping-cat-ivory.jpg",
      "ref-beyond-ivory.jpg",
      "ref-wind-space-blush.jpg",
    ],
  },
  {
    slug: "ink-storefront",
    title: "Ink Storefront",
    image: "ink-storefront.png",
    cover: "refs/ink-storefront/ref-l1-lupo.png",
    width: 1024,
    height: 1536,
    refs: ["ref-l1-lupo.png", "ref-l1-petit-pain.png", "ref-l2-fleur-fern.png"],
  },
  {
    slug: "tiny-wanderer",
    title: "Tiny Wanderer",
    image: "tiny-wanderer.jpg",
    cover: "refs/tiny-wanderer/varA.jpg",
    width: 512,
    height: 768,
    refs: ["varA.jpg", "varB.jpg", "varC.jpg", "varD.jpg"],
  },
  {
    slug: "crowd-ink",
    title: "Crowd Ink",
    image: "crowd-ink.png",
    cover: "refs/crowd-ink/anchor.png",
    width: 1536,
    height: 1024,
    refs: [
      "anchor.png",
      "sample-cafe.png",
      "sample-office.png",
      "sample-picnic.png",
      "sample-subway.png",
    ],
  },
  {
    slug: "cozy-parlor",
    title: "Cozy Parlor",
    image: "cozy-parlor.jpg",
    cover: "refs/cozy-parlor/ref-otter-painter.jpg",
    width: 512,
    height: 768,
    refs: [
      "ref-frog-letters.jpg",
      "ref-hedgehog-records.jpg",
      "ref-mouse-baker.jpg",
      "ref-otter-painter.jpg",
    ],
  },
  {
    slug: "iberian-vignette",
    title: "Iberian Vignette",
    image: "iberian-vignette.png",
    cover: "refs/iberian-vignette/ref-l1-manana.png",
    width: 848,
    height: 1264,
    refs: [
      "ref-l1-manana.png",
      "ref-l2-cafe.png",
      "ref-l2-ritmo.png",
      "ref-l3-familia.png",
    ],
  },
  {
    slug: "shadow-pop",
    title: "Shadow Pop",
    image: "shadow-pop.png",
    cover: "refs/shadow-pop/ref-default-mail-l2.png",
    width: 1024,
    height: 1024,
    refs: [
      "ref-berry-record-l1.png",
      "ref-citrus-coffee-l3.png",
      "ref-citrus-suitcase-l3-transparent.png",
      "ref-default-mail-l2.png",
      "ref-tropical-plant-l2.png",
    ],
  },
  {
    slug: "jade-blockprint",
    title: "Jade Blockprint",
    image: "jade-blockprint.png",
    cover: "refs/jade-blockprint/ref-sage-sprout-l1.png",
    width: 1024,
    height: 1024,
    refs: [
      "ref-cobalt-ship-l2.png",
      "ref-coral-turntable-l1.png",
      "ref-mustard-monstera-l1.png",
      "ref-rose-perfume-l2.png",
      "ref-sage-sprout-l1.png",
      "ref-sage-teapot-l1.png",
      "ref-slate-pen-notebook-l2.png",
      "ref-terracotta-pitcher-l2.png",
    ],
  },
  {
    slug: "loose-contour",
    title: "Loose Contour",
    image: "loose-contour.png",
    width: 1024,
    height: 1024,
    refs: [
      "ref-l1-mustard-hand.png",
      "ref-l2-blue-laptop.png",
      "ref-l2-coral-envelope.png",
      "ref-l2-coral-twohands.png",
      "ref-l3-balanced-vignette.png",
    ],
  },
  {
    slug: "soft-vector",
    title: "Soft Vector",
    image: "soft-vector.png",
    cover: "refs/soft-vector/ref-bike-lime.png",
    width: 1024,
    height: 1024,
    refs: ["ref-bike-lime.png", "ref-desk-violet.png", "ref-mug-mustard.png"],
  },
  {
    slug: "grain-poster",
    title: "Grain Poster",
    image: "grain-poster.png",
    width: 704,
    height: 1472,
    refs: [
      "ref-bench-sunsetcoral-l2-pair.png",
      "ref-cafe-cooldawn-l2-solo.png",
      "ref-dogwalker-forestgreen-l1-solo.png",
      "ref-guitar-twilight-l1-solo.png",
      "ref-skateboard-cooldawn-l1-solo.png",
      "ref-sunhat-sunsetcoral-l1-solo.png",
      "ref-twilightdesk-twilight-l3-solo.png",
    ],
  },
  {
    slug: "sunlit-gouache",
    title: "Sunlit Gouache",
    image: "sunlit-gouache.png",
    width: 1024,
    height: 1536,
    refs: [
      "ref-bookshop-interior.jpg",
      "ref-cafe-terrace.jpg",
      "ref-market-arcade.jpg",
      "ref-temple-courtyard.jpg",
      "ref-tram-stop.jpg",
    ],
  },
  {
    slug: "folk-muse",
    title: "Folk Muse",
    image: "folk-muse.png",
    width: 1024,
    height: 1536,
    refs: [
      "ref-canonical.png",
      "ref-sunset-dove.png",
      "ref-tropical-butterfly.png",
      "ref-winter-cat.png",
    ],
  },
  {
    slug: "light-pop-portrait",
    title: "Light Pop Portrait",
    image: "light-pop-portrait.png",
    width: 1024,
    height: 1024,
    refs: [
      "ref-laughing-girl-braids-magenta.png",
      "ref-sleepy-girl-bunny-peach.png",
      "ref-sly-boy-popsicle-lavender.png",
      "ref-surprised-boy-frog-mint.png",
      "ref-yellowhat-mushroom-cobalt.png",
      "ref-zen-kid-bird-teal.png",
    ],
  },
  {
    slug: "postcard-illustration",
    title: "Postcard Illustration",
    image: "postcard-illustration.png",
    width: 1024,
    height: 1536,
    refs: ["ref-sensoji.png", "ref-shibuya.png"],
  },
  {
    slug: "mosaic-still-life",
    title: "Mosaic Still Life",
    image: "mosaic-still-life.png",
    width: 1024,
    height: 1536,
    refs: [
      "ref-art-studio.jpg",
      "ref-autumn-cottage.jpg",
      "ref-beach-picnic.jpg",
      "ref-kitchen.jpg",
      "ref-mediterranean.jpg",
      "ref-moonlit-garden.jpg",
      "ref-reading-nook.jpg",
      "ref-workshop.jpg",
    ],
  },
  {
    slug: "painterly-botanical",
    title: "Painterly Botanical",
    image: "painterly-botanical.png",
    width: 1024,
    height: 1536,
    refs: [
      "ref-child-wildflower-sage.png",
      "ref-curled-up-peach-coral.png",
      "ref-from-behind-sepia.png",
      "ref-lotus-dusty-blue.png",
      "ref-magnolia-emerald-ivory.png",
      "ref-sunflower-sand.png",
      "ref-wisteria-lavender.png",
      "ref-young-man-monstera.png",
    ],
  },
  {
    slug: "op-ed-cover",
    title: "Op-Ed Cover",
    image: "op-ed-cover.png",
    width: 896,
    height: 1152,
    refs: [
      "ref-mind-eye-contact.png",
      "ref-pastrami-full-volume.png",
      "ref-slowest-bowl.png",
    ],
  },
  {
    slug: "endpaper",
    title: "Endpaper",
    image: "endpaper.png",
    width: 1024,
    height: 1536,
    refs: [
      "ref-butter-birds-l3.png",
      "ref-cobalt-sea-l3.png",
      "ref-mossy-teal-cats-l2.png",
      "ref-plum-foxes-l2.png",
      "ref-slate-houseplants-l2.png",
    ],
  },
  {
    slug: "inkstomp",
    title: "Inkstomp",
    image: "inkstomp.png",
    width: 1024,
    height: 1536,
    refs: [
      "ref-climb-climb.png",
      "ref-crunchy-cricket.png",
      "ref-greasy-griddle.png",
      "ref-jolly-jalapeno.png",
      "ref-pocket-plum.png",
      "ref-quiet-quitter.png",
      "ref-rocket-roach.png",
      "ref-turbo-tofu.png",
    ],
  },
  {
    slug: "mellow-pop",
    title: "Mellow Pop",
    image: "mellow-pop.png",
    width: 1024,
    height: 1536,
    refs: [
      "ref-coral-leaf-hug.png",
      "ref-coral-lilypad-path-l3.png",
      "ref-indigo-sticky-moon-l3.png",
      "ref-lavender-shell-soundwaves-l3.png",
      "ref-lavender-tulip-l2.png",
      "ref-mint-open-book-l2.png",
      "ref-periwinkle-phone-l1.png",
      "ref-yellow-garden-butterflies-l3.png",
      "ref-yellow-lightbulb-l1.png",
    ],
  },
  {
    slug: "papernook",
    title: "Papernook",
    image: "papernook.png",
    width: 1024,
    height: 1536,
    refs: [
      "ref-anchor.png",
      "ref-barista.png",
      "ref-engineer.png",
      "ref-meditation.png",
      "ref-researcher.png",
    ],
  },
  {
    slug: "ink-mascot",
    title: "Ink Mascot",
    image: "ink-mascot.png",
    width: 1024,
    height: 1536,
    refs: [
      "ref-branding-mint.png",
      "ref-content-terracotta.png",
      "ref-conversion-sage.png",
      "ref-email-lavender.png",
      "ref-growth-forest.png",
      "ref-launch-tangerine.png",
      "ref-loyalty-plum.png",
      "ref-seo-coral.png",
    ],
  },
  {
    slug: "riso-relic",
    title: "Riso Relic",
    image: "riso-relic.png",
    width: 1024,
    height: 1536,
    refs: [
      "ref-alarm-clock-tomato-wakeup.png",
      "ref-boombox-magenta-playloud.png",
      "ref-cassette-violet-mixtape.png",
      "ref-polaroid-sky-saycheese.png",
      "ref-rotary-phone-mustard-ringring.png",
    ],
  },
  {
    slug: "editorial-flatfolk",
    title: "Editorial Flatfolk",
    image: "editorial-flatfolk.png",
    width: 1024,
    height: 1024,
    refs: ["ref-alpine.png", "ref-harbor.png", "ref-park.png"],
  },
  {
    slug: "flat-poster",
    title: "Flat Poster",
    image: "flat-poster.png",
    width: 1024,
    height: 1536,
    refs: [
      "ref-lightbulb-sky-thinkbigger.png",
      "ref-magnifier-mustard-lookcloser.png",
      "ref-mountain-rose-reachhigher.png",
      "ref-robot-yellow-aiteammate.png",
      "ref-rocket-coral-shipfaster.png",
      "ref-shield-sage-alwayson.png",
      "ref-teacup-lavender-takeabeat.png",
    ],
  },
  {
    slug: "grainy-duotone",
    title: "Grainy Duotone",
    image: "grainy-duotone.png",
    width: 1056,
    height: 992,
    refs: [
      "ref-balloons-navy-peach-l3.png",
      "ref-ladder-burgundy-pink-l2.png",
      "ref-launch-pennant-1.png",
      "ref-launch-pennant-2.png",
      "ref-launch-pennant-3.png",
      "ref-magnifier-lavender-mustard-l2.png",
      "ref-sprout-sage-coral-l1.png",
    ],
  },
  {
    slug: "sticker-sheet",
    title: "Sticker Sheet",
    image: "sticker-sheet.png",
    width: 848,
    height: 1264,
    refs: [
      "ref-desk.jpg",
      "ref-kitchen.jpg",
      "ref-plants.jpg",
      "ref-travel.jpg",
    ],
  },
  {
    slug: "folk-storybook",
    title: "Folk Storybook",
    image: "folk-storybook.png",
    width: 1024,
    height: 1024,
    refs: ["ref-chill-tussle.jpg", "ref-puzzle.jpg", "ref-reading-nook.jpg"],
  },
  {
    slug: "inkdab",
    title: "Inkdab",
    image: "inkdab.png",
    width: 1024,
    height: 1024,
    refs: [
      "ref-brainstorm-butter-cream-rich.png",
      "ref-calling-blue-light.png",
      "ref-handoff-dusty-pink.png",
      "ref-pitch-blue.png",
      "ref-reading-lavender-rich.png",
    ],
  },
  {
    slug: "iso-scene",
    title: "Iso Scene",
    image: "iso-scene.png",
    width: 1024,
    height: 1024,
    refs: [
      "blue-city-construction.png",
      "coral-hanging-garden.png",
      "sky-castle.png",
      "yellow-floating-island-park.png",
    ],
  },
  {
    slug: "notion-illustration",
    title: "Notion Illustration",
    image: "notion-illustration.png",
    width: 1088,
    height: 960,
    refs: [
      "ref-candle-lighting.png",
      "ref-evening-sketching.png",
      "ref-evening-stretch.png",
      "ref-pouring-tea.png",
      "ref-reading-windowseat.png",
    ],
  },
];

const ILLUSTRATION_TEMPLATE_CARD_PREVIEW_IMAGES: Readonly<
  Record<string, string>
> = {
  "emboss-deboss":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/b64dc676-337a-4b38-9f13-fba4290e33dd/template-card-illustration-emboss-deboss-512.jpg",
  "ink-storefront":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/d3633cfc-bb66-4cf1-9a9b-0c2ac53f12e4/template-card-illustration-ink-storefront-512.jpg",
  "tiny-wanderer":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/139cd332-fe89-4326-aa8f-f7052b745bdf/template-card-illustration-tiny-wanderer-512.jpg",
  "crowd-ink":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/c4a91b62-96b1-42d2-bf87-30065da6e5b9/template-card-illustration-crowd-ink-512.jpg",
  "cozy-parlor":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/aa7daace-8fa8-4319-a31a-bb55c8804382/template-card-illustration-cozy-parlor-512.jpg",
  "iberian-vignette":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/952a2f34-9148-49d4-8640-0fd9b6cbdf20/template-card-illustration-iberian-vignette-512.jpg",
  "shadow-pop":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/1ee7e63c-d7fd-4755-a22a-d5be45237afc/template-card-illustration-shadow-pop-512.jpg",
  "jade-blockprint":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/e4d790c1-c249-4dc0-8820-1366caaa3546/template-card-illustration-jade-blockprint-512.jpg",
  "loose-contour":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/fcfc3279-938d-4a5a-842d-c82bd19e96fa/template-card-illustration-loose-contour-512.jpg",
  "soft-vector":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/a3b7eab7-7db1-4630-a441-98a1b3ab7b3e/template-card-illustration-soft-vector-512.jpg",
  "grain-poster":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/696913c7-8743-4033-95ea-203ba6faf294/template-card-illustration-grain-poster-512.jpg",
  "sunlit-gouache":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/ed2d0fe9-5f5c-4aae-bb46-faf132215426/template-card-illustration-sunlit-gouache-512.jpg",
  "folk-muse":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/17eddd70-ef01-4d39-8d70-a0a0393b6eb8/template-card-illustration-folk-muse-512.jpg",
  "light-pop-portrait":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/0ec684e9-2e98-4905-9a25-a32c1de06f22/template-card-illustration-light-pop-portrait-512.jpg",
  "postcard-illustration":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/221efbba-3ed6-4d86-be6e-e6cf6c3d5d57/template-card-illustration-postcard-illustration-512.jpg",
  "mosaic-still-life":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/20c33b1f-66aa-4ceb-89cd-10458e93a086/template-card-illustration-mosaic-still-life-512.jpg",
  "painterly-botanical":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/e054f277-e76c-429e-b88f-a205e8728375/template-card-illustration-painterly-botanical-512.jpg",
  "op-ed-cover":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/6f93b734-20f9-4704-9d32-a5a1229b94a1/template-card-illustration-op-ed-cover-512.jpg",
  endpaper:
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/8e17040a-a5f7-4184-b473-04b55546cbd0/template-card-illustration-endpaper-512.jpg",
  inkstomp:
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/3f873461-5166-43f8-86d9-25d1d6e7cc1f/template-card-illustration-inkstomp-512.jpg",
  "mellow-pop":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/16e05916-3e40-4890-a9a8-5ee968427305/template-card-illustration-mellow-pop-512.jpg",
  papernook:
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/fb7b6c2f-0a5c-4e87-93f9-74a0bdc1533d/template-card-illustration-papernook-512.jpg",
  "ink-mascot":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/13ad3bce-e719-4fa9-93a4-0e44c744091c/template-card-illustration-ink-mascot-512.jpg",
  "riso-relic":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/a1b7f915-b993-4faa-a37e-d870bc8918ab/template-card-illustration-riso-relic-512.jpg",
  "editorial-flatfolk":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/f37b65f3-9db8-4b57-b500-b686596649cf/template-card-illustration-editorial-flatfolk-512.jpg",
  "flat-poster":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/88738b99-22b1-4e3b-8660-a0291c3e8e86/template-card-illustration-flat-poster-512.jpg",
  "grainy-duotone":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/ce3fc7c4-55fe-4edf-8d9a-6b65554ab2bd/template-card-illustration-grainy-duotone-512.jpg",
  "sticker-sheet":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/cc1b556a-afe3-4410-a46a-74431de1c976/template-card-illustration-sticker-sheet-512.jpg",
  "folk-storybook":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/003c7de6-4409-46ec-b6c7-53005e877c7b/template-card-illustration-folk-storybook-512.jpg",
  inkdab:
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/b0f5c0e3-c827-4008-8eee-26b5117051be/template-card-illustration-inkdab-512.jpg",
  "iso-scene":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/2d9fe8aa-637a-4364-b035-cc42052da270/template-card-illustration-iso-scene-512.jpg",
  "notion-illustration":
    "https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/c1faa987-4b22-4594-80ab-0a2335bc6698/template-card-illustration-notion-illustration-512.jpg",
};

export interface IllustrationTemplateItem {
  readonly slug: string;
  readonly title: string;
  readonly illustrationStyleId: string;
  readonly previewImage: string;
  readonly previewImages: readonly string[];
  readonly cardPreviewImage?: string;
  /** Intrinsic pixel dimensions of the style's reference frame, used to reserve
   * the card's aspect ratio so the full illustration renders without cropping,
   * letterboxing, or layout shift. */
  readonly width: number;
  readonly height: number;
}

function illustrationPreviewImage(style: IllustrationStyle): string {
  const cover = style.cover ?? `images/${style.image}`;
  return illustrationAssetUrl(cover);
}

function illustrationTemplateCardPreviewImage(
  style: IllustrationStyle,
): string {
  const cardPreviewImage =
    ILLUSTRATION_TEMPLATE_CARD_PREVIEW_IMAGES[style.slug];
  if (!cardPreviewImage) {
    throw new Error(
      `Missing illustration template card preview image: ${style.slug}`,
    );
  }
  return cardPreviewImage;
}

export const ILLUSTRATION_TEMPLATE_ITEMS: readonly IllustrationTemplateItem[] =
  ILLUSTRATION_STYLES.map((style) => {
    return {
      slug: style.slug,
      title: style.title,
      illustrationStyleId: `image-style:${style.slug}`,
      previewImage: illustrationPreviewImage(style),
      cardPreviewImage: illustrationTemplateCardPreviewImage(style),
      previewImages: style.refs.map((ref) => {
        return illustrationAssetUrl(`refs/${style.slug}/${ref}`);
      }),
      width: style.width,
      height: style.height,
    };
  });
