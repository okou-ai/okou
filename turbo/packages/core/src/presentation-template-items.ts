export interface PresentationTemplateItem {
  readonly slug: string;
  readonly title: string;
  readonly prompt: string;
  readonly embedUrl: string;
  readonly previewImage: string;
  readonly previewImages: readonly string[];
  readonly slideCount?: number;
  readonly cardPreviewImage?: string;
  readonly cardPreviewImagesByTheme?: Readonly<Record<string, string>>;
  readonly previewHtmls?: readonly string[];
  readonly colorSystemId?: string;
  readonly templateId: string;
}

export const PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_THEMES = [
  "prism",
  "carnival",
  "pop-art",
  "warm-sand",
  "bauhaus-primary",
  "nordic-frost",
  "forest-editorial",
  "coral-studio",
  "slate-corporate",
  "terracotta-clay",
  "berry-pop",
  "citrus-fresh",
  "mauve-dusk",
  "mono-ink",
  "sunset-maroon",
  "mint-tech",
  "midnight-mono",
  "ocean-deep",
  "gold-luxe",
] as const;

const PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES = {
  "playful-launch-presentation": {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/e516bfce-08dd-44c2-aeef-a7cab1ffb1f1/template-card-presentation-playful-launch-presentation-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/e96ec7bc-bc0c-432f-a617-69aac96dbd76/template-card-presentation-playful-launch-presentation-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/df5b4d27-0018-422a-9d16-e36969f5bc6a/template-card-presentation-playful-launch-presentation-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/42b9f430-fe8f-4d16-a49e-45f99ae8a059/template-card-presentation-playful-launch-presentation-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/01f032ec-30dd-41de-9d1f-405eb27cc308/template-card-presentation-playful-launch-presentation-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/46686b18-0e43-4563-a73a-f05bb4966084/template-card-presentation-playful-launch-presentation-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/ef757d22-ea0e-4581-9592-cf113c4216f0/template-card-presentation-playful-launch-presentation-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/711f48e7-d9fd-499d-9731-d40810c38492/template-card-presentation-playful-launch-presentation-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/62d80ba3-b008-44f5-bf04-4eb5a7893191/template-card-presentation-playful-launch-presentation-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/af1a6390-86b2-4800-8bc5-f1764ffbeb94/template-card-presentation-playful-launch-presentation-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/380de217-d30a-45af-8a12-b81a0a002cfd/template-card-presentation-playful-launch-presentation-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/c7c72f5e-8d28-4a49-a5c3-ea41e57c8c19/template-card-presentation-playful-launch-presentation-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/277b8cba-0a28-491b-b957-27362b8e902e/template-card-presentation-playful-launch-presentation-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/da108e93-faed-4d55-a992-a8b2e3347a66/template-card-presentation-playful-launch-presentation-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/2fef9c56-6730-42ea-a037-f9dd52cd1f74/template-card-presentation-playful-launch-presentation-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/f86ce9c2-8127-4903-847d-c9941986f3f1/template-card-presentation-playful-launch-presentation-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/3e9e3fbc-8ab6-466e-bd23-6cfaf6c4f471/template-card-presentation-playful-launch-presentation-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/21ab7eb6-f409-4143-8402-71e70b8cdbf0/template-card-presentation-playful-launch-presentation-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/6d5be839-0844-4632-95e7-c8307b994a81/template-card-presentation-playful-launch-presentation-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "botane-organic-deck": {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/9e19e33e-6c1a-4e3d-bb5d-9de1b154a61b/template-card-presentation-botane-organic-deck-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/d923c670-256d-427f-b720-dfa03f523090/template-card-presentation-botane-organic-deck-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9470f2f5-191f-4245-9494-c64b0f5e2acc/template-card-presentation-botane-organic-deck-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/65e100da-419a-4cbf-99dd-90ccbb1e6bd0/template-card-presentation-botane-organic-deck-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/99920d9a-a837-4554-9ed6-0c45371b2fea/template-card-presentation-botane-organic-deck-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/ee0b8ab9-1801-4a87-8973-f01da391273b/template-card-presentation-botane-organic-deck-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/d8679bb0-8b89-496c-8e85-9b95308fe79e/template-card-presentation-botane-organic-deck-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/b2bfb2e7-4418-4f6a-933e-8924885e3da2/template-card-presentation-botane-organic-deck-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/e13c87d6-ecb6-4e0b-a32a-25d3d70aab45/template-card-presentation-botane-organic-deck-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/1e936869-7aee-453e-b5c5-fd9792bdca5d/template-card-presentation-botane-organic-deck-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/b5a371cd-1972-42df-b6b9-afb23c10d321/template-card-presentation-botane-organic-deck-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/62e8e14d-5d40-43c8-ace5-e2cfa4447bc5/template-card-presentation-botane-organic-deck-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/59ac5cad-a182-4fe1-bf5f-84011d92caa7/template-card-presentation-botane-organic-deck-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/816202cb-5e4d-4e0a-a988-71e9861f0675/template-card-presentation-botane-organic-deck-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/50a496c0-cefc-4800-a926-54603b064d49/template-card-presentation-botane-organic-deck-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/4e9cb042-170c-4bb0-ae27-1170e665d696/template-card-presentation-botane-organic-deck-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/5e5588e4-28c0-49f3-8b41-a3051e7efcb2/template-card-presentation-botane-organic-deck-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/68275cfe-5d08-4347-8515-933c543daf98/template-card-presentation-botane-organic-deck-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/e515fa02-9789-476e-a0fa-9888864563cb/template-card-presentation-botane-organic-deck-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "business-data-presentation": {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/7422d136-aeba-4fb9-b2d2-001f6022ad7d/template-card-presentation-business-data-presentation-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/802d61cd-44c3-462b-8065-eb34f1c81fff/template-card-presentation-business-data-presentation-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9af0a230-679d-4b98-89d1-1634f3505dd3/template-card-presentation-business-data-presentation-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/36d944ce-548c-48ac-8d20-ef9789854cc9/template-card-presentation-business-data-presentation-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/1b0a0751-3157-423d-8359-11fa404c1388/template-card-presentation-business-data-presentation-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/69524f5b-e966-42fd-a2b2-f66cd73765d6/template-card-presentation-business-data-presentation-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/0bde4d93-1886-4c93-bcf1-063a1e69a86c/template-card-presentation-business-data-presentation-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/fd2284ea-0f30-4d15-8cde-63ae0edd3c0a/template-card-presentation-business-data-presentation-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/594f59da-1ae0-42e3-ac01-97af7f7ec88a/template-card-presentation-business-data-presentation-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/791304f7-952e-4862-8209-2dd8e6735253/template-card-presentation-business-data-presentation-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/93c20663-bbf8-4ae2-b587-0dc4a7c75292/template-card-presentation-business-data-presentation-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/914e3fb7-d6c3-4bec-90b2-52b510e63c5e/template-card-presentation-business-data-presentation-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/05dceaff-f3bd-4557-ac30-e7eda5443475/template-card-presentation-business-data-presentation-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/f82b2e6f-56de-486e-a05e-b13f3fa7617e/template-card-presentation-business-data-presentation-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/6d1c69b9-89ac-4d53-aedc-53d71987d190/template-card-presentation-business-data-presentation-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/06cccce3-0c62-4883-a6e1-6f53642b8267/template-card-presentation-business-data-presentation-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/be635b63-8ffc-43b6-b050-8327a57951bb/template-card-presentation-business-data-presentation-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/611b9af1-b28f-4bb1-9b59-0828081fee2d/template-card-presentation-business-data-presentation-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/bc89eaa4-71f4-4ea1-ac89-2b2fb8ba0d75/template-card-presentation-business-data-presentation-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "crayon-learning-deck": {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/573d3324-9c37-4766-85da-a1028b067558/template-card-presentation-crayon-learning-deck-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/5db0e73c-4312-4bcf-8b60-9094d2aafeac/template-card-presentation-crayon-learning-deck-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/7485a80b-eea3-46a4-a2be-507990a38b5f/template-card-presentation-crayon-learning-deck-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/7d6e15cb-91d9-4d72-8754-baa6ddb8085a/template-card-presentation-crayon-learning-deck-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/94734712-0cc3-4b4c-9003-84af1a2514af/template-card-presentation-crayon-learning-deck-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/007f3750-d7d9-4ac2-aa1c-62e384f320c3/template-card-presentation-crayon-learning-deck-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/56596bbb-dd78-4005-9f59-d95d8ae8f740/template-card-presentation-crayon-learning-deck-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/d033dbf6-7795-4657-ba57-036d54613ba6/template-card-presentation-crayon-learning-deck-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/f0f6c062-7004-4827-8278-8bcf0ac60c7c/template-card-presentation-crayon-learning-deck-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/1ac6347b-85f4-4309-b900-dc7b1938c899/template-card-presentation-crayon-learning-deck-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/b86464ef-6475-4d6c-a35c-b6f6a192864a/template-card-presentation-crayon-learning-deck-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/c9747d98-4680-471e-8bda-d17a7e781f32/template-card-presentation-crayon-learning-deck-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/bac65be5-5285-4b74-bd74-ac7c3625e62b/template-card-presentation-crayon-learning-deck-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/db4d73de-6ac9-4976-93f0-83003d2ca127/template-card-presentation-crayon-learning-deck-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/329b2c3a-443e-4300-9325-7fd9bcfc78e1/template-card-presentation-crayon-learning-deck-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/8f780748-e093-46d8-9ed5-014b5638d4ee/template-card-presentation-crayon-learning-deck-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/4df5908d-e971-4a00-b109-e148d8f1b9c9/template-card-presentation-crayon-learning-deck-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/78ab4a40-cace-424a-bf00-9856cbefc208/template-card-presentation-crayon-learning-deck-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/1e153a66-0c52-4986-a09f-33d0eafd4f3e/template-card-presentation-crayon-learning-deck-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "creative-agency-presentation": {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/f40c998e-8046-487c-9bbd-6de2cfcdc7c8/template-card-presentation-creative-agency-presentation-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/9ffc824b-516f-4187-b353-d3422b2d7436/template-card-presentation-creative-agency-presentation-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/d69583c5-773a-4b29-8319-040858da2451/template-card-presentation-creative-agency-presentation-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/87fb4345-ec2d-42ee-940f-b1b447fdf660/template-card-presentation-creative-agency-presentation-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/caf31c90-310b-4565-afbc-56417821d89b/template-card-presentation-creative-agency-presentation-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/8969312f-2959-4d7f-9d20-8a8e7086246d/template-card-presentation-creative-agency-presentation-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/f5cc7730-ea22-4c98-840c-97f24eb3c605/template-card-presentation-creative-agency-presentation-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9186e9b5-54e6-4074-a218-13dab23a9407/template-card-presentation-creative-agency-presentation-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/756ca741-5821-4d80-96eb-19d4c0e32676/template-card-presentation-creative-agency-presentation-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9a7a0379-0c46-4bc0-b0f4-68d58955b615/template-card-presentation-creative-agency-presentation-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9b5f41e4-ac6c-4196-8758-1bc3b8b3fc60/template-card-presentation-creative-agency-presentation-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/d178524d-c2ab-4f0d-89dd-39164f3928a5/template-card-presentation-creative-agency-presentation-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/bd33d969-516d-4de3-9341-959a917a7fa7/template-card-presentation-creative-agency-presentation-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/bbd6d782-d1d5-4fe5-9953-c96f8185e9be/template-card-presentation-creative-agency-presentation-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/94c2b0dd-f91a-45d7-a6e7-11d802ab23f9/template-card-presentation-creative-agency-presentation-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/ce8fbeb8-7147-45d0-87c3-8369a6431d21/template-card-presentation-creative-agency-presentation-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/7996a715-00f6-4e49-b7dd-1c8544917fa6/template-card-presentation-creative-agency-presentation-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/c9f67da1-e05f-4db2-aee2-d4346bdff8ca/template-card-presentation-creative-agency-presentation-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9cfb560f-a59a-4284-8f7d-97cf101a77fb/template-card-presentation-creative-agency-presentation-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "data-report-presentation": {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/f8aa6480-16c2-4c20-8921-d1f9374a5583/template-card-presentation-data-report-presentation-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/77be1b72-eb93-40a3-8092-5f00d4773cf3/template-card-presentation-data-report-presentation-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/6bea2f09-6981-48b9-96d2-32dc7c041c33/template-card-presentation-data-report-presentation-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/edb92e56-ec4f-4c68-9504-eab5a1c0d229/template-card-presentation-data-report-presentation-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/5c2dbc64-ac8d-4227-b77a-54e438c945b2/template-card-presentation-data-report-presentation-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/2103179a-6531-4d74-a783-f2a53d96db1c/template-card-presentation-data-report-presentation-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/a6b0b5a2-ffe4-4cd4-ac0a-5248771f58da/template-card-presentation-data-report-presentation-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/e3fde814-becf-4201-80de-c15ad28b9877/template-card-presentation-data-report-presentation-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/afc0eb94-05bb-45fe-8941-13345a43b530/template-card-presentation-data-report-presentation-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/627a0a57-4331-45c1-b85b-753748d32a49/template-card-presentation-data-report-presentation-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/e444ffa3-fbbe-46be-8bce-b82eb05185f0/template-card-presentation-data-report-presentation-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/c0657808-bbe4-421c-a539-73f29a88a9c9/template-card-presentation-data-report-presentation-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/777500cb-5c20-4ad4-80f1-b03fbabfafd9/template-card-presentation-data-report-presentation-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/75e4fd23-7e64-4a46-bf48-b56fe40d1e04/template-card-presentation-data-report-presentation-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/85e0270e-b8e0-4549-9361-9e809621fbc7/template-card-presentation-data-report-presentation-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9dddacc9-045a-4f59-9953-373f08fdbc33/template-card-presentation-data-report-presentation-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9b92dcbc-44b4-4b5d-ab9d-eea720a40f64/template-card-presentation-data-report-presentation-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/99b8df33-52d3-4f4e-8449-bb3c3cbdc1cc/template-card-presentation-data-report-presentation-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/17a13840-f70b-48c4-8ac7-9b541a4a034f/template-card-presentation-data-report-presentation-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "editorial-magazine-deck": {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/1551e99d-7620-49ec-bf1e-b578632a0358/template-card-presentation-editorial-magazine-deck-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/903c73a7-8b68-4f2d-8fde-b913b016ecf4/template-card-presentation-editorial-magazine-deck-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/e549b9eb-9b2e-476a-88d1-ca7bb0d8667f/template-card-presentation-editorial-magazine-deck-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/a020ced3-6b94-408c-9936-3f9addd6a386/template-card-presentation-editorial-magazine-deck-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/547d59dd-2c5d-4d67-b0dd-bc23d288ceb6/template-card-presentation-editorial-magazine-deck-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/41c954ab-40d3-450b-8224-12d8072e0a5f/template-card-presentation-editorial-magazine-deck-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/c7bf667b-c28e-41c9-8b3d-a05ecf28fd70/template-card-presentation-editorial-magazine-deck-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/32334be2-ab20-43f8-87b8-28a31777cacc/template-card-presentation-editorial-magazine-deck-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/12b85e98-ea95-4bb7-81d3-406560a37cd5/template-card-presentation-editorial-magazine-deck-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/b81decad-3717-4619-8f34-4cb9eae5c56d/template-card-presentation-editorial-magazine-deck-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/53d77993-878f-4a9f-a1fc-6739794660b6/template-card-presentation-editorial-magazine-deck-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/23fe637e-8bff-40f0-a9ec-1aff2cb3063a/template-card-presentation-editorial-magazine-deck-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/7e9a2615-eafb-4fbe-91be-1c50192cb42c/template-card-presentation-editorial-magazine-deck-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/6f725279-a3b0-4d30-b20f-4782d6301ec3/template-card-presentation-editorial-magazine-deck-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9d8ce4a9-5ecb-4220-af1b-ab4d020dbd6c/template-card-presentation-editorial-magazine-deck-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/8d1782b7-7ffe-46f2-9959-1401f8925f0b/template-card-presentation-editorial-magazine-deck-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/0f906828-9f9a-4511-b402-8eeaf76150eb/template-card-presentation-editorial-magazine-deck-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/edccdf1a-affc-426c-8477-b86947032d70/template-card-presentation-editorial-magazine-deck-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/3ed37006-a3a0-4347-adae-74ab5551972c/template-card-presentation-editorial-magazine-deck-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "landing-consulting-deck": {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/f98d416d-0c26-4442-a72f-f960321c0bca/template-card-presentation-landing-consulting-deck-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/4273d3e4-08de-4a0a-b1d4-03f620310ac5/template-card-presentation-landing-consulting-deck-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/b2d0970e-cdbe-406f-ae44-a544dc2058c9/template-card-presentation-landing-consulting-deck-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/41e46ea8-24f6-496e-834a-ea1f192024d7/template-card-presentation-landing-consulting-deck-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/c38f2446-4972-408b-8aa2-b870aac00c8c/template-card-presentation-landing-consulting-deck-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/54caa4f0-4db9-49ed-b94f-29610ee39844/template-card-presentation-landing-consulting-deck-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/915bfc6d-5fb8-48dd-8183-86794fc51680/template-card-presentation-landing-consulting-deck-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9805a606-0587-471d-9429-d9326dcfd31d/template-card-presentation-landing-consulting-deck-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/60db33cd-70cf-4d07-bd4a-5746b3fed10f/template-card-presentation-landing-consulting-deck-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/99eafab2-1abc-4841-a3fb-f3625ee29546/template-card-presentation-landing-consulting-deck-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/e24adc64-24d6-4a8d-9b64-cfed4face42e/template-card-presentation-landing-consulting-deck-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/e7f9ded5-98b3-4636-8c14-3aafb0ceb5b3/template-card-presentation-landing-consulting-deck-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/c2dc239f-52da-4468-9a55-82c7df87ebc5/template-card-presentation-landing-consulting-deck-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/7f94ec43-c3c4-4044-a5f9-84006d39fdbd/template-card-presentation-landing-consulting-deck-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/25479deb-9d31-4170-8827-77136e3c1d99/template-card-presentation-landing-consulting-deck-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/d94f2dae-e7d0-4d4f-a513-b2e89b9c61a6/template-card-presentation-landing-consulting-deck-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/e5ffec05-27f0-49c6-942e-1000cc95f818/template-card-presentation-landing-consulting-deck-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/dfbaabfd-287f-4dfe-a48e-003e9da5db0f/template-card-presentation-landing-consulting-deck-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/85a5bd66-c044-4898-8c33-e64b874acaf1/template-card-presentation-landing-consulting-deck-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "lumina-creative-studio": {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/a92421d1-e4b5-4485-94b8-ba503d4dc8f5/template-card-presentation-lumina-creative-studio-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/0ed47289-d3ce-4e60-b6dd-642090cc5130/template-card-presentation-lumina-creative-studio-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/78ce10cb-cb36-4c11-b8c7-e5ad59ef0249/template-card-presentation-lumina-creative-studio-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9958589a-2a37-46ee-bda8-fcd671b5be84/template-card-presentation-lumina-creative-studio-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/3ef8c102-83e2-4690-800a-ecdca149d84a/template-card-presentation-lumina-creative-studio-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/f865d013-fa34-43ad-9552-0cbc3ffdfad2/template-card-presentation-lumina-creative-studio-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/ca187a3a-e808-4eb3-9e34-e41856d52377/template-card-presentation-lumina-creative-studio-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/00c5d13f-9458-4d87-9ae6-637e896ebe62/template-card-presentation-lumina-creative-studio-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9de8dc58-dada-4807-bb42-9ddd2a67631d/template-card-presentation-lumina-creative-studio-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/d6224e63-2243-4fae-946a-53ee478ee818/template-card-presentation-lumina-creative-studio-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/991d9715-1fda-40bc-81ca-e1a0b6d53b34/template-card-presentation-lumina-creative-studio-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9d1b7289-aef4-404f-b00b-1471c29c6907/template-card-presentation-lumina-creative-studio-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/a7bfe0e9-3871-41f3-9e13-eb0c5cd81893/template-card-presentation-lumina-creative-studio-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/3dc4e053-5613-4212-af8b-5f3454188e9f/template-card-presentation-lumina-creative-studio-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/21a22d38-ae77-4ff0-b7cb-8eeddf03efc7/template-card-presentation-lumina-creative-studio-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/c89fa05a-f56a-48bb-b022-947fc09604e0/template-card-presentation-lumina-creative-studio-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/e7546735-b333-4dc8-a5f0-469043794f1e/template-card-presentation-lumina-creative-studio-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/2d4f6e59-80ed-492e-8763-6ce2bbf32796/template-card-presentation-lumina-creative-studio-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/2e043033-bda0-44ed-acd6-2d5eacd54104/template-card-presentation-lumina-creative-studio-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "mosaic-geometric-pitch": {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/75c14836-a2b8-4f8a-b191-485317971dd9/template-card-presentation-mosaic-geometric-pitch-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/9f6d4b35-3bc5-45be-aca3-18f6ec21530f/template-card-presentation-mosaic-geometric-pitch-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/014a0d17-b78a-48e7-b5cf-62d221204996/template-card-presentation-mosaic-geometric-pitch-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/14a7405a-25fe-4fe6-a05e-37e00fe78b2c/template-card-presentation-mosaic-geometric-pitch-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/20a6c016-082d-40c1-af47-a1a61c2f9e24/template-card-presentation-mosaic-geometric-pitch-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/125f9f28-64ec-4ec7-861b-7f508de7e1cf/template-card-presentation-mosaic-geometric-pitch-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/8c545c12-fa00-4928-9d10-03cb3aaa99c2/template-card-presentation-mosaic-geometric-pitch-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/a7f73d59-ea59-4b2f-a5b9-0482ddeed21e/template-card-presentation-mosaic-geometric-pitch-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/564b4bf7-ea19-4dd0-b320-2696db573aa9/template-card-presentation-mosaic-geometric-pitch-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/47350842-757c-4c4c-bf0f-ca8b14a3248a/template-card-presentation-mosaic-geometric-pitch-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/736c1ca8-0cd7-4832-87af-26ab7368252c/template-card-presentation-mosaic-geometric-pitch-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/b2a98f28-8e60-4125-be6d-55b57fb69761/template-card-presentation-mosaic-geometric-pitch-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/0d8eb614-f292-4992-b54e-917b35107446/template-card-presentation-mosaic-geometric-pitch-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/e17df1f3-5530-4049-88d0-7c1287c0919f/template-card-presentation-mosaic-geometric-pitch-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/4303dc0c-a8d6-45dc-80c0-18cbd993646f/template-card-presentation-mosaic-geometric-pitch-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/41557a1c-924f-4004-82e2-96689a341470/template-card-presentation-mosaic-geometric-pitch-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/91c4c7ec-bc83-4279-8d17-7bc918c83cc3/template-card-presentation-mosaic-geometric-pitch-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/f3a8270e-5b43-4dac-b1af-4594b8093a7c/template-card-presentation-mosaic-geometric-pitch-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/d889c78b-afae-494c-b912-8fd4fc79407d/template-card-presentation-mosaic-geometric-pitch-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "playful-pop-deck": {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/824ca947-243b-468d-b2f2-cca11ac2fc21/template-card-presentation-playful-pop-deck-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/7fd0063f-1782-41e7-beb6-8348b49b2854/template-card-presentation-playful-pop-deck-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9de5f4ed-f828-43ba-9817-059006bfae14/template-card-presentation-playful-pop-deck-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/35cd8145-7eb0-48f7-a125-031a9fb306d1/template-card-presentation-playful-pop-deck-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/8b43ed5f-49c6-4b02-a363-04df4f63fffb/template-card-presentation-playful-pop-deck-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/3cee34f8-ea65-4d88-8640-63e642d07115/template-card-presentation-playful-pop-deck-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/ff194e5b-df8c-49ae-9b85-f17b9015b73f/template-card-presentation-playful-pop-deck-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/982e5b49-3ed8-474e-8c36-448bcd4a6e80/template-card-presentation-playful-pop-deck-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/b27357bd-7424-41c6-bdf9-6b45af2f8976/template-card-presentation-playful-pop-deck-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/60ae9b9e-a4b6-4c7f-8890-98f838386af2/template-card-presentation-playful-pop-deck-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/38a1e94b-de28-4ec7-ad53-22d0f8fccfb6/template-card-presentation-playful-pop-deck-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/b0d43553-5c35-44fa-b34b-c3ea8617a09a/template-card-presentation-playful-pop-deck-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9e0f8f22-3078-4aec-bb6d-f759adc31524/template-card-presentation-playful-pop-deck-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/51d0681e-cbf3-4dcd-9072-359c8770c92b/template-card-presentation-playful-pop-deck-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/14ba252c-5e1a-4f2f-abcb-d62849b96ffd/template-card-presentation-playful-pop-deck-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/7e8c4886-9433-4336-92e6-8a518f3135dd/template-card-presentation-playful-pop-deck-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9fcb63ea-85cd-4347-8ad9-488d9a9db0d7/template-card-presentation-playful-pop-deck-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/18fa6a6b-faee-4f8f-bdf0-733d0580bf6e/template-card-presentation-playful-pop-deck-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/c7eb7646-65ae-463b-903e-4766f0721d70/template-card-presentation-playful-pop-deck-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "bloom-pitch": {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/35347eab-989d-46da-8cd4-6846e9e18ae9/template-card-presentation-bloom-pitch-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/230f3210-598c-40da-8fad-7d9542b81a4c/template-card-presentation-bloom-pitch-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/14a9175b-eef4-4e7d-bb60-460320f9218a/template-card-presentation-bloom-pitch-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/25c375ca-29a9-46a2-83f4-9c6fe1bbbd4f/template-card-presentation-bloom-pitch-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/301f42f0-6951-4a4d-ae7d-492698cc9258/template-card-presentation-bloom-pitch-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/33f0825f-7ee7-440b-963b-fa0d530d33fc/template-card-presentation-bloom-pitch-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/af105437-5b40-4aa4-a89c-d82af48c0f7e/template-card-presentation-bloom-pitch-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/31ca5d00-5892-4066-b86b-4ab0cb9a152f/template-card-presentation-bloom-pitch-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/905769f2-adc4-49d0-b4a5-d53a13b4dd2a/template-card-presentation-bloom-pitch-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/3a3324ce-31ee-4e27-9185-18af861e8a64/template-card-presentation-bloom-pitch-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/14ece89e-3cac-428a-afb8-a693a7eb6edf/template-card-presentation-bloom-pitch-berry-pop-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/54187934-28bb-45f9-99b2-85a87b393b68/template-card-presentation-bloom-pitch-mauve-dusk-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/bcbfde4e-8e65-4ac1-acf3-ee3f3af1c0bf/template-card-presentation-bloom-pitch-citrus-fresh-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/cc225486-a2bd-4914-8bff-490178ac69ad/template-card-presentation-bloom-pitch-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/a37df412-a08f-4a4f-9aa6-95fad92954e3/template-card-presentation-bloom-pitch-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/4276aab6-90fe-4ea8-8672-be653e59e062/template-card-presentation-bloom-pitch-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/207bbb3b-70a3-41ad-9680-4f80dd6c6d34/template-card-presentation-bloom-pitch-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/c07c402d-9dfc-4ccc-8eea-383fab53775c/template-card-presentation-bloom-pitch-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/99ca85e7-744d-4082-9cab-c0d274b1337d/template-card-presentation-bloom-pitch-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "blueprint-academy": {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/7d2e08a0-439f-46fe-a441-e39747de1212/template-card-presentation-blueprint-academy-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/ba862728-b489-4bb4-8f6b-2afb5be91001/template-card-presentation-blueprint-academy-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/efc7d153-29e9-4180-bff0-1c6fe42bf5e5/template-card-presentation-blueprint-academy-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/fac3c5c7-e87f-4482-9214-afbc37ee6135/template-card-presentation-blueprint-academy-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/beeee408-82cf-4965-bafe-2db5fb8602bd/template-card-presentation-blueprint-academy-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/3557bad1-2e19-4284-a263-eece873a07f8/template-card-presentation-blueprint-academy-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/96d87e06-aaaa-4b46-8547-1876f8f1c8a3/template-card-presentation-blueprint-academy-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/b6f8be0a-2ebc-4060-a6cb-f68a7640a514/template-card-presentation-blueprint-academy-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/599907b0-e101-4f73-93e6-14ed149d561a/template-card-presentation-blueprint-academy-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/87e2f57f-584c-46e4-b51c-a5549fd597c7/template-card-presentation-blueprint-academy-terracotta-clay-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/e2cd5cf4-ab78-4b96-8013-aea034087622/template-card-presentation-blueprint-academy-citrus-fresh-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9814e9c7-1b58-40a5-a341-e6dbc8a8be9f/template-card-presentation-blueprint-academy-berry-pop-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/93bb8ccf-477e-4859-9a80-4117664d2bf4/template-card-presentation-blueprint-academy-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/69e3e91b-eaa4-417c-9ad4-10c19e78a72c/template-card-presentation-blueprint-academy-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/a2b24f7b-ef4d-489d-a35e-42440a60417b/template-card-presentation-blueprint-academy-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/27b26028-107d-4574-975f-876a97580e15/template-card-presentation-blueprint-academy-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/a54294df-1162-47c8-9734-4e63fe3e2de8/template-card-presentation-blueprint-academy-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/11516e2b-644e-45be-b302-22482daa4578/template-card-presentation-blueprint-academy-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/277df515-a377-4689-8821-69cef46faa34/template-card-presentation-blueprint-academy-gold-luxe-iframe-viewport-480x270.jpg",
  },
  meridian: {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/de20bbf9-8e3a-4559-b973-8e5e8257a3ee/template-card-presentation-meridian-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/b567ed2a-93ce-491e-a57b-3695030d15de/template-card-presentation-meridian-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/0cda265e-dc6f-4155-a574-03738317ae25/template-card-presentation-meridian-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/77928d19-c357-4879-a4c4-4dcf73fa80fd/template-card-presentation-meridian-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/2294bc61-1f38-42f0-82d4-3161e63a6a81/template-card-presentation-meridian-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/139debec-2762-4f12-8b51-e6c81f6bed91/template-card-presentation-meridian-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/fd11cdd5-c52f-4944-a735-ac54a60788e5/template-card-presentation-meridian-forest-editorial-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9f44f1a6-8e86-48fd-9322-5e7f60cc2f9a/template-card-presentation-meridian-slate-corporate-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/766756ad-9abb-42a9-acd2-8b8d983bc001/template-card-presentation-meridian-coral-studio-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/093a5d56-c399-43a8-97eb-caa988f76a11/template-card-presentation-meridian-terracotta-clay-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/49f1dccc-8b0e-488c-813e-69db266bb7cb/template-card-presentation-meridian-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/0fcac9c7-b1e4-472f-9595-5b1969f69e8f/template-card-presentation-meridian-mauve-dusk-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9896d112-e859-494e-9750-d0126af2873d/template-card-presentation-meridian-berry-pop-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/acbbf029-1f2a-420f-b9fc-5c3e9eadc9a5/template-card-presentation-meridian-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/3bd1b7ec-6a88-4b4b-9622-4c844255b971/template-card-presentation-meridian-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/23eb2ed6-fc1f-4070-8b0d-693376592de6/template-card-presentation-meridian-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/8c38bdf2-674d-4d1c-8d58-4cb69607dfcb/template-card-presentation-meridian-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/5749c58a-6c4b-4b32-903f-7be7ae4a89c2/template-card-presentation-meridian-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/023b2be2-a37e-4c1c-8d88-19cea31a0cbc/template-card-presentation-meridian-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "neo-brutalism": {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/e5a46773-05fd-4924-91f2-b8c902d84958/template-card-presentation-neo-brutalism-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/d9c04806-8fbf-41c1-a669-e793522204d8/template-card-presentation-neo-brutalism-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/97ab3f21-3105-4fb9-b0e0-264d9865eef2/template-card-presentation-neo-brutalism-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/58accc81-eacc-4f8f-b02a-35b5d2acb742/template-card-presentation-neo-brutalism-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/c73c3b1a-0e68-4740-af75-614118574683/template-card-presentation-neo-brutalism-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9e3ddc73-36ad-4640-97c6-6420e3df5860/template-card-presentation-neo-brutalism-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/611711cc-b79f-4d02-a8e6-1ef2803797ff/template-card-presentation-neo-brutalism-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/1ce685e3-8f30-4f73-870a-5c33eb50c934/template-card-presentation-neo-brutalism-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/6ed0fe45-5cb1-4b5a-81a2-2cef5df8c765/template-card-presentation-neo-brutalism-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/079cb4aa-bec0-43ff-875b-4ffffa467901/template-card-presentation-neo-brutalism-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/96eb10dc-0658-43e0-88a9-4892d07d9f26/template-card-presentation-neo-brutalism-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/cd3e83ce-91f3-4149-b9ad-422d00579433/template-card-presentation-neo-brutalism-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/e76f1c4f-5ef7-474a-951c-0b7a4ef2898d/template-card-presentation-neo-brutalism-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/2e682f70-2dab-41cb-b8d5-cbcc663bcf5b/template-card-presentation-neo-brutalism-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/b8928393-4a58-4f9e-bc6b-3096c6fe51b4/template-card-presentation-neo-brutalism-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/379b03c0-17da-4aee-b790-1b516c9436ed/template-card-presentation-neo-brutalism-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/3e5b2200-2a4d-4dbf-9c7a-ed69ba9dbc3b/template-card-presentation-neo-brutalism-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/3a2141a4-f0fb-4610-8035-f17cd7562f5e/template-card-presentation-neo-brutalism-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/7f029831-8e6d-49ce-9bb4-3879d78a2bdc/template-card-presentation-neo-brutalism-gold-luxe-iframe-viewport-480x270.jpg",
  },
  nocturne: {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/47060ac2-2255-491b-822e-17e4879e8bb3/template-card-presentation-nocturne-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/86e393ee-3e0c-4a96-b15c-af1a6bf6421a/template-card-presentation-nocturne-carnival-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/6c55154a-a225-4239-8c4e-c3e2f8963597/template-card-presentation-nocturne-warm-sand-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/2c1d697a-5a5b-4745-8786-d4a200907259/template-card-presentation-nocturne-pop-art-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/0ad83df4-0749-4516-a917-fe8a0a246989/template-card-presentation-nocturne-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/fb54e933-d3c0-48ec-83ce-4878acc674ea/template-card-presentation-nocturne-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/c5188fd6-2cf8-4967-a527-a73455608ef6/template-card-presentation-nocturne-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/32dea48f-97b4-44fc-a32c-dbd30335e67d/template-card-presentation-nocturne-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/d60f2752-79e9-46d0-9f98-39f109529a2b/template-card-presentation-nocturne-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/193a67b0-1084-4b4d-a68f-ebd83cff3595/template-card-presentation-nocturne-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/bab7e049-8f49-4cbf-9084-77576c755218/template-card-presentation-nocturne-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/b7c2717f-cdf3-46af-8ffc-86a54d3cafd7/template-card-presentation-nocturne-citrus-fresh-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/696367c1-aee5-4c34-bc24-bdba10917111/template-card-presentation-nocturne-mono-ink-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/2e5415a3-27e7-4320-97db-bc5d9d684fc8/template-card-presentation-nocturne-mauve-dusk-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/28abedd2-b9e0-447f-a445-f0daa2235fae/template-card-presentation-nocturne-mint-tech-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/b84c2859-8c0e-4e9b-b997-d9ff24162e01/template-card-presentation-nocturne-sunset-maroon-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/b994d5c8-9601-4108-a80b-ed4cb88b3c18/template-card-presentation-nocturne-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9192f3e7-4ae4-4bf7-ac54-03d64834ce95/template-card-presentation-nocturne-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/ec854c97-62c3-4bdd-b820-cdf62fafa5ef/template-card-presentation-nocturne-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "pixel-glitch": {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/481b2398-8cbe-436b-a54d-6b277cb5c444/template-card-presentation-pixel-glitch-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/2480dd7a-16ca-41e7-9308-731a0a8ed3bf/template-card-presentation-pixel-glitch-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/522d8149-0bba-4cb3-87df-234d8e7c8119/template-card-presentation-pixel-glitch-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/fd49cd12-5fa9-41af-ac99-0a6a7553b89f/template-card-presentation-pixel-glitch-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/ee6cc1a9-a8a7-4a66-9876-2d227c5a5a22/template-card-presentation-pixel-glitch-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/51b7c1f4-6d8c-46d7-ab49-93562b316198/template-card-presentation-pixel-glitch-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/80d95fa9-436b-42ea-b8e0-910d498d55e6/template-card-presentation-pixel-glitch-forest-editorial-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/d18066ad-5876-46a4-9e2b-beabc6a38c87/template-card-presentation-pixel-glitch-slate-corporate-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/55e56b20-bef1-4d48-a84e-b1cafe758639/template-card-presentation-pixel-glitch-coral-studio-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/30a04cf3-a8c1-40ee-810c-20f743888c55/template-card-presentation-pixel-glitch-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/7337562e-a8ba-4fbb-8eb7-84d23d57ca8e/template-card-presentation-pixel-glitch-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/12b12048-c8e3-4db3-bb41-3a1cd52f36b4/template-card-presentation-pixel-glitch-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/89a13e2b-b065-4b37-bd7a-275fe81b0063/template-card-presentation-pixel-glitch-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/70351076-1fbd-4767-b21d-ee2948ce1655/template-card-presentation-pixel-glitch-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/ade9a11c-3b04-4a50-95e3-c30850eca22f/template-card-presentation-pixel-glitch-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/c85b5845-b940-477c-b612-7f3a6c8ee25f/template-card-presentation-pixel-glitch-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/2b38c57a-09d3-4edf-84f1-4280b35e2c2b/template-card-presentation-pixel-glitch-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/75243e50-5478-4b14-8d4b-9162ab26b63c/template-card-presentation-pixel-glitch-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/2e62a49a-5dda-4e37-b785-97627cda9db4/template-card-presentation-pixel-glitch-gold-luxe-iframe-viewport-480x270.jpg",
  },
  prospectus: {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/ee78696e-9a29-4988-b414-119e5bef18cf/template-card-presentation-prospectus-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/c7621b28-8739-48e5-9d09-ef31bbad67c4/template-card-presentation-prospectus-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/911ce6d0-c609-4104-80ad-ff804f6432c8/template-card-presentation-prospectus-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/681e8f71-ab41-433a-8fb5-2bc2c6524d68/template-card-presentation-prospectus-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/3d281372-94d7-494b-96a0-69d4d693fae1/template-card-presentation-prospectus-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/609ca9f6-6807-42f8-af02-64ec9abc699e/template-card-presentation-prospectus-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/6f753c56-9598-4605-afde-b526761176c9/template-card-presentation-prospectus-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9d2239e3-ce16-4072-83cd-9f64ecf01e29/template-card-presentation-prospectus-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/35b01a49-0f92-482d-b930-edde0cfdeea1/template-card-presentation-prospectus-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/7851aeb9-6adf-413e-97ce-d4159dcfaa75/template-card-presentation-prospectus-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/a3b54886-3891-4b92-b54d-ceeec40b9816/template-card-presentation-prospectus-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/d9b28cff-3f80-4ade-81b5-1fb198f9a268/template-card-presentation-prospectus-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/c4d91151-4df8-418e-8ed4-0ca7e3f90028/template-card-presentation-prospectus-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/e4d0c1fb-042f-4a67-93dd-318dd219e1d8/template-card-presentation-prospectus-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/5915d9b5-c2d8-4fe2-996b-486fd21cad27/template-card-presentation-prospectus-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/a8b70c7d-c3f1-435f-9df9-7cc48a65b015/template-card-presentation-prospectus-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/7a37e9f5-42de-43aa-8273-df89a7821464/template-card-presentation-prospectus-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/93c4d241-247d-45cc-ad8a-6dd8d66ee18b/template-card-presentation-prospectus-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/aeda0b75-44aa-4baf-bf45-c279aba63e81/template-card-presentation-prospectus-gold-luxe-iframe-viewport-480x270.jpg",
  },
  schoolhouse: {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/fd1bebe9-bc2b-4773-a437-969e5d820b43/template-card-presentation-schoolhouse-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/081c0721-fccd-4281-aae8-a690db56ce39/template-card-presentation-schoolhouse-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/1dabfea2-d93a-4cac-b18e-71c75385a768/template-card-presentation-schoolhouse-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/43b0eb05-5efa-4e98-a342-776aec5ccf1e/template-card-presentation-schoolhouse-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/d65c960e-2dce-4f6a-b8c8-c5b270df41c3/template-card-presentation-schoolhouse-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/eecf7cf5-bd26-435b-bbc9-b9e9fddf8f86/template-card-presentation-schoolhouse-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/821c23f9-46c4-4e6f-888c-80ff15250b7c/template-card-presentation-schoolhouse-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/4fc14c67-2280-4430-803b-a0046cfc09cf/template-card-presentation-schoolhouse-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/0d3047af-44ce-4f4c-92c9-463e9ba21b2f/template-card-presentation-schoolhouse-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/711a7c8e-dac2-459d-b751-0a016ee3763d/template-card-presentation-schoolhouse-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/bedee58f-4988-441a-b207-f894f03add4d/template-card-presentation-schoolhouse-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/e9301948-d620-4dee-a76b-ab2ebf228148/template-card-presentation-schoolhouse-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/f91d627a-644e-4872-90b3-6abd4b7fd209/template-card-presentation-schoolhouse-mauve-dusk-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/c0e50c3b-9e48-47d5-978f-5115d0094303/template-card-presentation-schoolhouse-sunset-maroon-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/50648f87-8f18-4646-ae36-2fd212e19158/template-card-presentation-schoolhouse-mono-ink-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/2780816a-434d-4203-b80a-67ebd79aa025/template-card-presentation-schoolhouse-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9d20120c-2920-4148-ad42-bdcfb4b799f1/template-card-presentation-schoolhouse-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/a43eebaa-911f-4c1a-823e-af4a6f797c91/template-card-presentation-schoolhouse-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/be9c0717-742d-4d41-a4e8-ead241124b6d/template-card-presentation-schoolhouse-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "sticker-scrapbook": {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/ca5c4a1c-eb36-4462-a6e8-e64453798c5b/template-card-presentation-sticker-scrapbook-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/336e9804-41cf-41d5-a2e3-ae127205f700/template-card-presentation-sticker-scrapbook-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/b43c91a7-dbc3-442f-9319-6d3d8c9dbddf/template-card-presentation-sticker-scrapbook-pop-art-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9cf18292-0ae1-4c00-bf36-552e44468ee2/template-card-presentation-sticker-scrapbook-nordic-frost-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/0eebc10c-16d4-4722-8483-157fbf4dc864/template-card-presentation-sticker-scrapbook-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/a020f7d4-0cab-466e-a344-5fbe832cf476/template-card-presentation-sticker-scrapbook-bauhaus-primary-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/210ea3dd-4298-468f-bef2-896f8dc20948/template-card-presentation-sticker-scrapbook-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/ab4ac022-0454-4c23-bcaa-a4258a2646aa/template-card-presentation-sticker-scrapbook-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9fed234f-eb63-4296-915f-1de54528a1ff/template-card-presentation-sticker-scrapbook-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/f3197cd0-0b7b-4fa6-aca1-7f4dc363084c/template-card-presentation-sticker-scrapbook-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/092bd74d-0b60-49b8-88d9-7a73241bf6cc/template-card-presentation-sticker-scrapbook-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/07656a02-12dc-49fc-a328-25a7d11ed13e/template-card-presentation-sticker-scrapbook-citrus-fresh-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/2d8b7b45-129b-4ace-a528-b4381f42175b/template-card-presentation-sticker-scrapbook-mono-ink-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/44e915f1-5fbc-4129-bc03-444be1beca68/template-card-presentation-sticker-scrapbook-mauve-dusk-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/72e91eab-542d-45f6-9cef-5989ab861fcc/template-card-presentation-sticker-scrapbook-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/75efce92-326a-44cf-b027-d5d265b087b1/template-card-presentation-sticker-scrapbook-mint-tech-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/4bd6781b-bd7f-459f-8e58-d76f33e96854/template-card-presentation-sticker-scrapbook-ocean-deep-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/2cae903b-0044-4255-9441-9b4e7d28c2eb/template-card-presentation-sticker-scrapbook-midnight-mono-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/a21b891a-76f7-4195-83dc-d4fbc363ae82/template-card-presentation-sticker-scrapbook-gold-luxe-iframe-viewport-480x270.jpg",
  },
  strata: {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/72a43438-0e3d-40af-95b3-5134e5dc3b4d/template-card-presentation-strata-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/67855d35-f892-49ce-a53f-a73e65c2ada5/template-card-presentation-strata-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/58623674-39cf-4535-817b-6bf57e0c0a01/template-card-presentation-strata-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/7d0ac85f-5d2d-4cb7-9390-38b8aea3da41/template-card-presentation-strata-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/18fad345-bc9e-4c43-974a-1103ee1f065e/template-card-presentation-strata-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/8a74e1a5-869d-49de-8871-479322a0d539/template-card-presentation-strata-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/ee51749d-c417-4ca1-b556-28176166d86d/template-card-presentation-strata-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/c6577050-4bdb-447d-bb0b-ce19a56fdb25/template-card-presentation-strata-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/11168bfc-57b8-49ce-8d9a-a38ecbe899d9/template-card-presentation-strata-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/861353d6-7c4c-45df-aec0-9ef4103694cd/template-card-presentation-strata-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/4f82d9b5-65e1-4af5-8abe-cb1bfc3394d3/template-card-presentation-strata-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/661a2367-2d7c-4f46-8235-2a940c22234d/template-card-presentation-strata-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/f8e12ed4-25f0-4c99-85a4-931aa56096c3/template-card-presentation-strata-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/1726673d-8581-42d0-a088-16c88ab396be/template-card-presentation-strata-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/80f52012-f15e-4c0e-85c7-a66255fad20f/template-card-presentation-strata-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/ae36aa15-edbd-4c21-8c52-e67e0006ab37/template-card-presentation-strata-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/7e96a8c7-e056-4eb6-a3d4-3b210fc0526c/template-card-presentation-strata-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/76dbc0dd-0eef-47f2-96ae-d1581cb056bf/template-card-presentation-strata-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/3d200d78-790c-4f75-863a-b164433363dd/template-card-presentation-strata-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "taped-consulting": {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/cc1fa0b4-4a80-4080-aa29-2e5e88fcedc1/template-card-presentation-taped-consulting-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/29a9f491-e529-4e25-a0fe-8bbad6292b5f/template-card-presentation-taped-consulting-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/0962b3db-ebff-409d-84d9-280f9d776c67/template-card-presentation-taped-consulting-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/a6e000f4-9495-4004-a4be-431fe3c2b1b7/template-card-presentation-taped-consulting-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/08e71cc7-b76d-465c-af0d-663f05f4e5d1/template-card-presentation-taped-consulting-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/eb1e00ad-835c-4dff-88c5-fca88e4b88c3/template-card-presentation-taped-consulting-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/ffee95a5-e561-419c-ac27-fdef4495d732/template-card-presentation-taped-consulting-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/7ccb111a-d790-4545-bc77-e19a0b0042bb/template-card-presentation-taped-consulting-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/0ca89f7a-bd0f-4085-b7dc-d70e0558fcb6/template-card-presentation-taped-consulting-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/37298c0c-3ecf-4d39-93b7-f01c0e156b4e/template-card-presentation-taped-consulting-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/d3b185af-6b45-437a-af60-ab671ceab6eb/template-card-presentation-taped-consulting-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/f586c683-ae54-4ff3-9ed8-24e989f7fe8b/template-card-presentation-taped-consulting-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/7aa6b6b7-2039-40d6-8d59-edbf4442ecc6/template-card-presentation-taped-consulting-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/2984e4fe-83c7-4a4a-9dd0-a49a9dcb2a5e/template-card-presentation-taped-consulting-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/72b5c577-251d-48c1-a429-096328ac8598/template-card-presentation-taped-consulting-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/b77bd363-c309-47f8-b226-074cbbbc233d/template-card-presentation-taped-consulting-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/fdb68a30-f335-49ad-bedb-fa7d8c61117b/template-card-presentation-taped-consulting-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/d4d3a17f-3a9d-4de0-b6ea-dcba7b86b5d7/template-card-presentation-taped-consulting-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/0a2d990b-8368-4b46-8c3b-47ddb5dc9f04/template-card-presentation-taped-consulting-gold-luxe-iframe-viewport-480x270.jpg",
  },
  vantage: {
    prism:
      "https://static.vm0.io/vm0/artifact-templates/presentation/536ace67-54c4-4bf2-a53e-1ff0f0062ffd/template-card-presentation-vantage-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://static.vm0.io/vm0/artifact-templates/presentation/fb021ec7-f6a0-4124-b096-d9ae2173e01d/template-card-presentation-vantage-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9df78d40-4ad9-4f07-ab09-b90dea758b19/template-card-presentation-vantage-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://static.vm0.io/vm0/artifact-templates/presentation/9a3372b6-4b7a-4bc7-85f3-172e16b8d370/template-card-presentation-vantage-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://static.vm0.io/vm0/artifact-templates/presentation/a67fd082-0300-48a2-8e06-76914aa59a34/template-card-presentation-vantage-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://static.vm0.io/vm0/artifact-templates/presentation/b1da8e2b-e23a-41dc-8aca-c36a66676b44/template-card-presentation-vantage-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://static.vm0.io/vm0/artifact-templates/presentation/66af2f92-353b-4d27-a12a-765e1186655e/template-card-presentation-vantage-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://static.vm0.io/vm0/artifact-templates/presentation/39c3bbd2-49e9-4254-847a-353aabd6b1ed/template-card-presentation-vantage-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://static.vm0.io/vm0/artifact-templates/presentation/71e1059c-b040-4a6d-a7eb-0ae10b57e41e/template-card-presentation-vantage-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://static.vm0.io/vm0/artifact-templates/presentation/70232c94-4890-4dea-9e86-3d480b62f83a/template-card-presentation-vantage-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://static.vm0.io/vm0/artifact-templates/presentation/2471901a-80ed-4006-81cd-432b6a1fe4f6/template-card-presentation-vantage-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://static.vm0.io/vm0/artifact-templates/presentation/2067e8c2-1d63-4764-8327-8b31a9313ba7/template-card-presentation-vantage-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://static.vm0.io/vm0/artifact-templates/presentation/87ebbe2c-2877-4133-8a5d-385b81a3068e/template-card-presentation-vantage-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://static.vm0.io/vm0/artifact-templates/presentation/1466a7a7-fb13-44db-8687-9c99d282dd8e/template-card-presentation-vantage-mono-ink-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://static.vm0.io/vm0/artifact-templates/presentation/f46edc1b-d119-4098-9b72-739227219258/template-card-presentation-vantage-mint-tech-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://static.vm0.io/vm0/artifact-templates/presentation/fc40f686-cf2a-41b4-b5d9-02568b6c25a4/template-card-presentation-vantage-sunset-maroon-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://static.vm0.io/vm0/artifact-templates/presentation/d1ee4993-9f2d-417e-a517-1db4fe580e21/template-card-presentation-vantage-midnight-mono-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://static.vm0.io/vm0/artifact-templates/presentation/583606ad-eaed-472e-8495-03c57b778db4/template-card-presentation-vantage-gold-luxe-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://static.vm0.io/vm0/artifact-templates/presentation/fbcc6ed8-6881-44d9-aedc-9478b6cd3eb8/template-card-presentation-vantage-ocean-deep-iframe-viewport-480x270.jpg",
  },
} as const satisfies Readonly<
  Record<
    string,
    Readonly<
      Record<
        (typeof PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_THEMES)[number],
        string
      >
    >
  >
>;

const BOTANE_ORGANIC_PREVIEW_IMAGES = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/64d1a85a-9347-48fb-860b-073180385b66/botane-organic-deck.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a43f103f-e4b3-40b0-a326-c37a2240e6b5/slide-02.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/576f05a7-2d2c-4963-876b-6eda1fe8f93e/slide-03.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/12a44151-de3a-465d-9631-df029387a922/slide-04.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/cc6d6522-6f49-4dd0-a122-903a2251f014/slide-05.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/2195f286-6e9e-4171-9240-90c03924b898/slide-06.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/889dd3cf-913c-4f79-99fc-c57f4346cef5/slide-07.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/b1116116-80a5-4d4c-bd74-43a66bed970b/slide-08.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/3d0f5b82-cb4d-4b5a-8c7b-de8941758cf8/slide-09.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/7a5835b1-9545-46e1-ac8b-4d33de6fca14/slide-10.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/72162ad3-7cda-4eb8-9bc3-9a986c06e120/slide-11.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/68e2256e-3872-45b5-bcc6-a7cedf6d3e8f/slide-12.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/2a7fd3d2-562f-4b49-8854-562b13fa7fbc/slide-13.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/ba0a9ade-6eba-4a63-8772-976b30ab17cf/slide-14.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/7da6a51c-4a78-4e50-9cbc-899879e72875/slide-15.png",
] as const satisfies readonly [string, ...string[]];

const PLAYFUL_LAUNCH_CDN_PREVIEW_IMAGES = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/774bdd46-ca62-40b5-b56b-95fd2ff2d302/playful-launch-presentation.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/dbb11b25-20e0-433e-94d5-9a094667d5a7/aplocoto-slide-02.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/d6a0800b-729e-4399-ba74-e3d56b4e9b00/aplocoto-slide-03.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/67781114-f6ff-45fd-bb74-bf65df1b75e9/aplocoto-slide-04.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/9860a2f5-512a-4f0c-a215-33ad6153ee66/aplocoto-slide-05.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/7c884040-00c0-4237-8560-44a78c9bc9df/aplocoto-slide-06.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/90905547-8551-46ee-91fe-cdf364a0a415/aplocoto-slide-07.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/13260433-b222-4561-a62f-273f2c275f4c/aplocoto-slide-08.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/f88b5182-4312-49a7-bd1c-3814405d5205/aplocoto-slide-09.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/060dafd9-d147-4a42-89dc-4b22fa92e880/aplocoto-slide-10.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/d104d1c5-c038-40b0-b7e2-078a9f93c062/aplocoto-slide-11.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/d51c10d0-fdba-41b3-b88f-1d4e118c7368/aplocoto-slide-12.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/e7e3ca86-846e-44f9-8eb0-637699168192/aplocoto-slide-13.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/ecc39ab1-0a68-4da5-9cf4-20b1e0b2eeb0/aplocoto-slide-14.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/f403f161-f63c-427f-ae15-401ede2672d9/aplocoto-slide-15.png",
] as const satisfies readonly [string, ...string[]];

const BUSINESS_DATA_CDN_PREVIEW_IMAGES = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/9aa42296-a49e-4128-a80a-e920637b1506/business-data-presentation.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/04a3765b-ef6a-4bbb-8ae4-b116941760cf/slide-02.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/1919e6e0-2adf-4727-825d-3470568733e7/slide-03.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/62d71bc2-9359-4a41-bde6-da6e4d9d0fd0/slide-04.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/9d587627-8f20-4aed-ad2b-0593f58c22d9/slide-05.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/b16f1790-05be-4a49-85cd-3417c51376c9/slide-06.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/de3b1bca-c6bf-4f45-ba6e-898ebb51c8ca/slide-07.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/f1fdaf81-3914-4882-89c1-eb2da901dfd8/slide-08.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/982833de-dd95-4560-81b5-8b006d7fe3c7/slide-09.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/15fbcdfa-fc5c-48a8-aa4b-4ea88550b1e2/slide-10.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/4a29b39a-97d0-4c26-892a-85e808f0a21f/slide-11.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/056c9f76-3ee0-4990-a445-72044cc84a66/slide-12.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a1a1fc29-4682-484e-b5eb-2e09c5b0c8d3/slide-13.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/7817bac4-9ecd-4e00-a532-d6ba2816c322/slide-14.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/37616a8a-7386-49f2-8e18-198a2a234d4a/slide-15.png",
] as const satisfies readonly [string, ...string[]];

// Batch presentation resources migrated from Google Drive to private R2.
const CRAYON_PREVIEW_IMAGES = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/c4d3f251-c143-4cb7-86f5-97042123ef90/crayon-learning-deck.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/8183eea0-8016-4680-82b8-8ad3a3b5ada2/slide-02.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/356c7e99-4895-44e1-a56d-d53dfb0d722e/slide-03.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/f81f04ee-f164-4d0b-abd2-1bec62637036/slide-04.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/2aace698-e937-4c5c-83b7-43b4ea6aa193/slide-05.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/db411e40-59c5-4428-b2fd-dc71846bbf32/slide-06.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/4cea2af8-cd7b-4446-a895-03e151591e9a/slide-07.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/1e500a83-2644-49b6-a7a7-dabb10025344/slide-08.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a6c157ad-644f-4dd8-be84-c04ad53e8eba/slide-09.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/abadaabc-a366-40b7-8cad-17e302e24cea/slide-10.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/810651dd-7c4e-4115-a9b4-8eb4e804e669/slide-11.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/52fac853-0a29-4215-951d-2d9780720119/slide-12.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/32876cfe-2e5e-4807-b308-06a9b617ac36/slide-13.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/6db8270e-31fb-4df6-9d8f-495dced6c2ed/slide-14.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/d82049a8-dbb6-4425-9043-058720a335a6/slide-15.png",
] as const satisfies readonly [string, ...string[]];

const CRAYON_PREVIEW_HTMLS = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/351717b6-5c48-42c5-a349-d8a815bc229f/slide-01.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/c4116423-38ef-48d9-9728-695bf265e510/slide-02.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/2cb2711a-0638-4673-a47b-69a51116e21d/slide-03.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/32f3a867-b29d-4b0e-ba32-073167892556/slide-04.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/e7e49363-33ae-48c6-998a-f911e51bf340/slide-05.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/0c005465-e491-4d84-915c-efc892bf6030/slide-06.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/3baf78ed-8cec-4da1-9734-3a8ca51a1d6c/slide-07.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/803373ba-fa20-4ebd-84ad-cb73f4e10dcd/slide-08.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/27ef439c-3dc2-49d2-b5ca-de98d20f2ca6/slide-09.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/c498a285-2d3f-4c76-9ebb-d26ad42f677c/slide-10.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/b79a2ac4-ef78-4a3c-b47e-6f1310756b7c/slide-11.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/e8dac0bc-f2a2-440c-ade3-c979d34b7459/slide-12.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/3f6c4cae-cac2-4cf1-93d8-d2d4609cad8e/slide-13.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/0742c906-1dcb-4bec-80e3-f0e5387e727d/slide-14.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/d13fd530-4917-4378-8e2b-8c0befd96119/slide-15.html",
] as const satisfies readonly [string, ...string[]];

const CREATIVE_AGENCY_PREVIEW_IMAGES = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/6494f661-c935-4ab2-9181-600097bde23b/creative-agency-presentation.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a1883f03-854f-4f31-9da5-5d1f80179ea9/slide-02.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/261165ff-ded6-4662-9b1a-62df42b234b0/slide-03.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a2e4e44e-1a6d-491f-903c-4e2188023d3c/slide-04.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/39871f71-1392-4911-8771-f22b715d7a9e/slide-05.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/f8b8651e-de6b-4adb-a733-c92dc0f859e6/slide-06.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/1d3342e3-e91f-48df-8302-1931423f7de6/slide-07.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/70e13d5b-d9df-4e39-a257-ded24b0fd2f8/slide-08.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/8280b48a-4c05-4022-ae9c-8b5073562b53/slide-09.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/efe70b44-2eaf-4094-8404-a2238e101d42/slide-10.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/6bc29f83-9a2f-4f9a-bf63-b7d30acc6941/slide-11.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/c6ca5fe0-1def-4eb2-a5fe-2e31fc60dac7/slide-12.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/7557bbcc-8502-43eb-8d91-fa2b8035e15d/slide-13.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/07fa40fd-5c73-4913-9ed2-a248e3e56865/slide-14.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/62403bf8-6aac-40af-b279-95239dc20139/slide-15.png",
] as const satisfies readonly [string, ...string[]];

const CREATIVE_AGENCY_PREVIEW_HTMLS = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/440dde23-496f-4e4c-9b78-226deda76c4c/slide-01.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/80de0f45-96af-4131-8cc8-9f6a058efe96/slide-02.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/5acb529d-e17a-4b7b-b418-1dc49f50bc53/slide-03.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/ebc56020-ec50-4125-8467-f6361648687b/slide-04.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/20d61d5a-a7d2-4cf5-a7ba-2d507e8df1d8/slide-05.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/8a89a5f5-af1c-4b64-941d-59fd55904c43/slide-06.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/152b7fb4-5619-4344-a714-0a29434f082c/slide-07.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/aa8de55e-a778-4a24-b530-9c76bcb85991/slide-08.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/afe9346a-de0f-4141-9434-e5bda6f09efe/slide-09.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/995f23c4-bda7-4f8c-80bb-cd5e4eda3f57/slide-10.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/de3d07df-083a-4218-8c86-fcff79251a47/slide-11.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a21f6ee8-f967-4415-9825-27c08a28cc09/slide-12.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/f25909ac-88d6-48eb-859c-488d5bbacd9f/slide-13.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/1bea8f97-d0e5-4240-bae5-c3bbe5cd5ba2/slide-14.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/188bdf52-0a5b-466a-8417-b8920e35fb5a/slide-15.html",
] as const satisfies readonly [string, ...string[]];

const DATA_REPORT_PREVIEW_IMAGES = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/26958aa5-8823-484f-8bce-6f60a8663a72/data-report-presentation.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/efa3e160-e608-4658-9395-9a4139899038/slide-02.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/edd27584-ef9f-4611-b8ab-59e3ac7247ad/slide-03.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a505694f-8511-45bb-94bd-0095b75e6028/slide-04.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/77cb14b3-aec9-4694-9a12-880eb0a11fc6/slide-05.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/02dffc66-0883-45bc-9567-a063368619b5/slide-06.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/c11f15e4-e164-4803-9d39-9b787e1b35c5/slide-07.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/6c426018-8ec4-43c6-8998-4b1ae1aff6d1/slide-08.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/19fceff3-2317-4e84-9918-600a66bf375a/slide-09.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/401c3f73-810b-4ebc-a448-7d9bd5ecc882/slide-10.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/8b97bb9b-667a-4596-bbf6-fba2c55eca5f/slide-11.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/dc80199e-4b44-4602-8b4b-6af9d65f1845/slide-12.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/95a0c217-421f-4a57-97db-700b076eed1a/slide-13.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/8e7c176a-7997-4b5d-9773-68cf0b307c8e/slide-14.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a0269c99-9d1b-44e2-b49a-0980820b3b90/slide-15.png",
] as const satisfies readonly [string, ...string[]];

const DATA_REPORT_PREVIEW_HTMLS = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/16310322-2d80-4142-a5f5-7bcff8c3eed0/slide-01.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/be665757-c3d0-4091-b957-9b2090d6523d/slide-02.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/38b3ce82-7212-44d1-a5ae-a9477ce5e086/slide-03.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/90d4ca26-8f11-413d-a9d5-611c3dfb7971/slide-04.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/b08266e5-92fe-45c8-82bd-a02a1921e780/slide-05.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/e958c1d0-9674-4149-94e5-23a6b78b7151/slide-06.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/99d8ebd7-fdc7-427a-a000-a24675b1a730/slide-07.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/04fc9197-1543-487c-82eb-0560cde0c17d/slide-08.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/f979bae9-63ad-49fb-81f1-f4149e244fe0/slide-09.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/eb896ae1-adf1-4681-948d-564c73a6ac82/slide-10.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/479c66d1-7999-43ef-a24c-e18399053105/slide-11.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/5e9763c0-7dfb-495c-af1d-9cf25bcfcb4c/slide-12.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a9f6fc70-1099-461a-be6b-a4bbabce5f4a/slide-13.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/be6017d7-be11-436c-b67a-050ebee5fdb7/slide-14.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/41099f41-7548-4a11-beb5-cebde83df691/slide-15.html",
] as const satisfies readonly [string, ...string[]];

const EDITORIAL_MAGAZINE_PREVIEW_IMAGES = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/adf552b2-53ed-4282-b08c-2359f3b124ff/editorial-magazine-deck.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/63b4c9a6-7f1a-4f49-af9b-dd93d9d9138a/slide-02.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/b7dc0361-f59a-4fdb-b350-f18bc99a422e/slide-03.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/4718eb4d-7672-4194-9710-f980a5e9d4a1/slide-04.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/26bc2e44-8975-48d2-a659-0364f148c835/slide-05.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/3b3e8dab-8f75-4773-a467-043e5525b491/slide-06.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/646d057e-f8d8-48e1-862e-db4095c2af28/slide-07.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/506d1159-c15f-4b63-ad09-3ab538036099/slide-08.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/9618e2b2-425e-43c3-9399-6c89ea8ab458/slide-09.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/5008900e-ebc8-4355-b07e-995624af5a52/slide-10.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/0a84ce72-1816-4f5e-8e17-9d9ed3f7d7a4/slide-11.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/9e80c360-a1ef-45d4-a0f2-fd18c1ce8f2a/slide-12.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/172f784b-3502-485f-9ab4-e4714afa7b22/slide-13.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/2897a88f-0b4c-4892-bb32-eb4545cc3acc/slide-14.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/c453a78d-8109-423b-ae0e-278123d38239/slide-15.png",
] as const satisfies readonly [string, ...string[]];

const EDITORIAL_MAGAZINE_PREVIEW_HTMLS = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/539b64b7-ba42-4f62-a54f-1427b2afddb3/slide-01.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/b1a544b4-a4a1-4292-ba63-61843a14c5b3/slide-02.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/d4880c62-7c63-4696-b80a-2bed0108a988/slide-03.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/84ddea62-a1eb-425f-8b09-450f104aa3a5/slide-04.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/02425e87-5b9f-4680-bc3d-2c58c7d2adc1/slide-05.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/85d7e4f9-31bc-4ba8-9b21-11be2342d135/slide-06.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/58c58583-41fb-4d78-be75-1c905a8776f1/slide-07.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/15c39a3c-05e0-41e5-b5b8-71ae03377232/slide-08.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a9decabb-f920-46b6-a5f9-a5ec3d12b962/slide-09.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/62965071-8c8d-4b14-970c-3e7903c85195/slide-10.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/8d81c8d4-c1d4-49e1-b9cf-60ee42b1c225/slide-11.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/1539da62-2481-4dfc-8b5b-5ca6118bc1f3/slide-12.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/326ebe33-8072-4a14-af18-70ec77f59360/slide-13.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/b45db466-6e73-418e-9e65-f86a3c17be8b/slide-14.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/512d2421-0d60-44ed-81b1-29620a93ed5c/slide-15.html",
] as const satisfies readonly [string, ...string[]];

const LANDING_CONSULTING_PREVIEW_IMAGES = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/fb94c9f1-8ab7-46cc-a08a-693e40337f06/landing-consulting-deck.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/ca96e383-1431-466c-8c3e-9fc13a91d2c5/slide-02.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/5a8a9671-68bd-4d07-9fb5-078bdb0199a6/slide-03.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/710c14c7-3dc6-4b10-b8d8-27fc4df2a0b0/slide-04.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/0eda445b-ed1d-4922-8a9e-ae8e39ff06e8/slide-05.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/e9e61546-3e5d-4307-ad97-7b5ddf92a960/slide-06.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/8646d1e2-4d3c-43c4-970a-df36476eec9c/slide-07.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/8dada9ca-9908-42c9-a010-ce42e431f108/slide-08.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/73fc1ea3-e10b-4151-b0fe-e2cdf4ec7e4c/slide-09.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/39f3b5b2-5cc9-409b-affd-f861460f1b8c/slide-10.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/3f241aa1-5cad-4030-a00b-cb6402390704/slide-11.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a79c9f31-d9cd-40c3-8cca-907599ee2a9a/slide-12.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/622ee524-2f19-44a0-9613-26036f4474e4/slide-13.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/e38718d5-1059-4df4-a322-e9d73369c57e/slide-14.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a5f1fff4-18f9-4eaa-860c-c9ce8b57922d/slide-15.png",
] as const satisfies readonly [string, ...string[]];

const LANDING_CONSULTING_PREVIEW_HTMLS = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/b02b4e7a-861d-4db3-af6f-a6e1f492a805/slide-01.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/512dda48-57e2-4264-aba7-21500b56e38c/slide-02.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a15f57d1-fbad-4a2a-ae3b-e02f97eef373/slide-03.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/45047a7b-242c-4cda-a8d1-98471d8bd8e7/slide-04.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a138a120-8d27-4bfe-8e9b-2dee7e8398ad/slide-05.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/8a2d4e51-7515-442b-9ff6-8ea1d74cbaed/slide-06.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a0d46684-2831-4653-80af-34e0e6492da7/slide-07.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/c43fff61-c6a6-4524-a222-9ccbfb25e82e/slide-08.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/e7016072-aada-44f8-93cf-15c2cf0bbcf9/slide-09.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/f4b22edf-cf10-4f7c-acbe-fbe5dab95f08/slide-10.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/100de24b-6e80-40c7-864c-2dece1e3fcef/slide-11.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/135a102e-1f28-4fc3-8d26-f57bc93ce1f9/slide-12.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/d5e42744-3bbc-4e85-9f6a-dae697986214/slide-13.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/4507a7cb-ac95-4363-96bb-03def14afbe3/slide-14.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/9b54f283-b5de-4d49-a525-d3ad1b2304e8/slide-15.html",
] as const satisfies readonly [string, ...string[]];

const LUMINA_PREVIEW_IMAGES = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/a9c9d0c7-726c-4013-802d-cde1feefd058/lumina-creative-studio.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/592fe965-5a74-4366-b8b9-e58605dcc16e/slide-02.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/fb9df939-ec5a-4949-980d-7300eee0def4/slide-03.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/dc1afd19-e772-4e27-baa0-5b0790b7b056/slide-04.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/abfe04fb-2f9e-42bd-b7da-9613676dee09/slide-05.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/71b059b8-e4b3-4aea-9210-10c0f321f827/slide-06.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/c91c081d-70a1-4a73-b7f9-2f2cce4c309f/slide-07.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/065462c6-ed5f-499a-adb8-fec17c468cb7/slide-08.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/9733dd6f-9aa3-440b-88c4-cfcb61676035/slide-09.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/7dbb64c1-0a07-4b36-b96f-b1a460503f68/slide-10.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/06a117bf-ca82-4a80-a282-3836a8079994/slide-11.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/ddbcb419-6eba-41d6-aa30-0677352a042c/slide-12.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/40783c03-36a1-40a7-91e4-f974d9aa8a58/slide-13.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/8a7c8c68-12e8-4500-ae37-5b7db7d782c7/slide-14.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a913f8f3-3aa4-47d6-b29b-fe39de18ebaa/slide-15.png",
] as const satisfies readonly [string, ...string[]];

const LUMINA_PREVIEW_HTMLS = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/77b00b14-0909-4e10-afea-3c39ae74db73/slide-01.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/01faf670-8355-43f4-bd87-a283eff2500b/slide-02.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/1721d052-b4d9-4c8e-be68-b9d433dcc504/slide-03.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/995dc4b4-929d-4788-9f42-6da9e37c7ffd/slide-04.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/c20a8bfb-4b85-4407-abc7-ac8b5e04f13d/slide-05.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/4c6d6b98-8f11-4afe-8d44-1d07f0fc52f6/slide-06.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/2f236399-80f4-48d9-aa92-9f5c4fb2d161/slide-07.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/e02a7dc9-1fe7-454b-82ea-5968d10d5d73/slide-08.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/5373c442-9cb4-4245-99c0-270fe449880c/slide-09.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/e3234608-ff95-4de6-84b4-50f077062609/slide-10.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/7779e5ca-9759-470c-abe2-3d9aa7e68e5c/slide-11.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/9e45d5c9-9b2d-4b28-95ad-965a8566d48b/slide-12.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/009219ba-4047-4e84-87d7-9d1295728751/slide-13.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/da94d8b8-375e-413f-91c0-8b84f631744e/slide-14.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/5c3ad467-780a-4a59-b95c-26379e13e598/slide-15.html",
] as const satisfies readonly [string, ...string[]];

const MOSAIC_GEOMETRIC_PREVIEW_IMAGES = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/0491adb1-f2a3-47d3-8075-509e036e913d/mosaic-geometric-pitch.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/22fd98ad-7ca0-4b08-8e9e-383da4ccbb49/slide-02.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a04cac03-384e-4e05-95a2-d345e95e1141/slide-03.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/5e3518b8-5077-467a-a2d5-612f754c8535/slide-04.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/cdbb1d16-dd0f-46a4-b43e-0963a4f2e7c3/slide-05.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/0c2632ed-2313-4286-9921-aa39e9472371/slide-06.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/cd4b3cbe-5287-4a8a-ae18-107f3bfd2419/slide-07.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/279d368b-4772-460f-9fe6-aea782745e70/slide-08.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/92acc27f-60fe-42e7-8960-8c95b3921986/slide-09.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/dd46a4b5-cff3-42a5-b39a-0add674c20c0/slide-10.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/0eca7af8-e188-4001-88d3-99b47fd49c2b/slide-11.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/c29e6151-c5c1-401a-9263-2949209e2a70/slide-12.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/f7132349-afea-44aa-8294-ca0e35a44210/slide-13.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/847e4eb8-6f15-4b18-9133-eb48da0a0e30/slide-14.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/5355056e-e86d-4a65-afa3-9e3be0d05a32/slide-15.png",
] as const satisfies readonly [string, ...string[]];

const MOSAIC_GEOMETRIC_PREVIEW_HTMLS = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/58a4dec5-db7a-4e03-835e-e49637dba964/slide-01.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/62d75fe7-4224-4943-a765-f558ab426bce/slide-02.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/b4482261-179a-4ca0-8a00-0186a51fcc1c/slide-03.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/af249477-c261-41cd-86d4-8e1aba376a32/slide-04.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/e7f1da55-2c8c-4858-aa13-33ab42d216ba/slide-05.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/2992c1ee-84db-4ab5-b251-a317a160de66/slide-06.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/35e0c6f8-f96e-4c67-8375-62ce1c47178f/slide-07.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/61a88e05-442b-4b25-9488-2f5e2df4dcf8/slide-08.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/140aac80-54d7-46bb-af05-40121cc85f0a/slide-09.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/60b1ad5d-631b-42fc-8b29-bedf3b4e2a6c/slide-10.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/3c3fd19a-8087-4177-bdd9-e7dde6109a2f/slide-11.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/0cc9cb46-0019-4d45-a33d-5fff36c2a754/slide-12.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/29123d43-c90a-48e4-9d1d-f1657f396a34/slide-13.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/23284bc3-078b-4cd2-a3e2-f207605e6ad1/slide-14.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/ac616f61-f1bc-44af-8862-c219f7f74bfe/slide-15.html",
] as const satisfies readonly [string, ...string[]];

const PLAYFUL_POP_PREVIEW_IMAGES = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/3b6e8fbf-15f4-46cc-a2a6-8d3ef33d9d32/playful-pop-deck.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/083b8e2c-ea0a-434b-93c9-69d129ed242c/slide-02.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/9d957db7-4449-4fe9-8adb-6eff201b0fcc/slide-03.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/25afe786-d2c6-4d49-acbc-d8c60fce5fb4/slide-04.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/b2c5cf99-65ec-49f1-861e-0a80905ae5e5/slide-05.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/e6a1d840-de51-4aec-a773-e3e8abe1ec1e/slide-06.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/dd4589bb-563e-44cf-bc26-f11b7db3a20c/slide-07.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/8a34076e-f629-4da3-a25b-68cf705cc788/slide-08.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/06757c76-66fb-4b6d-ac26-a6e0b50f9cd5/slide-09.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/60f90bbb-bdb0-4f17-9258-4e52e8e41d91/slide-10.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/17941998-dab8-48ee-bda2-f6d6a502ff98/slide-11.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/7cbb4445-e1ae-4876-8ac8-39d8bbb79df3/slide-12.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/82b45a46-b5f3-4a97-a480-e07cadac0a96/slide-13.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/85672b12-bd99-4748-9b56-ec39aae695f5/slide-14.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/805bd601-9e99-40b1-a66a-34251c70c787/slide-15.png",
] as const satisfies readonly [string, ...string[]];

const PLAYFUL_POP_PREVIEW_HTMLS = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/098f0ce4-c773-4479-ad85-221c9114881a/slide-01.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/009db4d7-19f9-4266-a08d-2eb827678fde/slide-02.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a143dba3-9e72-44c5-a105-0e5228125a1c/slide-03.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/b541db0e-322e-4604-9b13-ff117b5fcf7f/slide-04.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/3fa2f420-248a-4679-b76e-fb620fd67868/slide-05.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/859a88eb-5f9c-469b-b6c7-5987fe9e92f0/slide-06.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/23b1ec6d-ba39-41a6-923f-7c125c530f08/slide-07.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/b469c7a6-5151-488d-a59f-e38e091e376d/slide-08.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/46c96f07-8232-44fd-932e-e0a6e6abc0a0/slide-09.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/465fb0cb-18ff-4284-a184-d6a7cc8aa49c/slide-10.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a72c8c6c-c5d5-4fac-95bd-f299102d344e/slide-11.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/27203fae-eb0e-49eb-8077-e69f7a888382/slide-12.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/bde44218-8dfd-418e-863a-f6e99808b2b3/slide-13.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/f84b61fc-4775-4ee3-ab28-fa9762b602fe/slide-14.html",
  "https://static.vm0.io/vm0/artifact-templates/presentation/c3eaf388-6b9f-49b6-90af-ce27eedb87e2/slide-15.html",
] as const satisfies readonly [string, ...string[]];

const PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES = {
  "bloom-pitch": [
    "https://static.vm0.io/vm0/artifact-templates/presentation/4124c01a-a6c7-484c-9e22-8dd4d62a6c6c/bloom-pitch.png",
  ],
  "blueprint-academy": [
    "https://static.vm0.io/vm0/artifact-templates/presentation/ffa9f511-0e01-4191-99a6-3d6621b99661/blueprint-academy.png",
  ],
  meridian: [
    "https://static.vm0.io/vm0/artifact-templates/presentation/189d2344-ca5f-4dbf-86ce-04b1567c062f/meridian.png",
  ],
  "neo-brutalism": [
    "https://static.vm0.io/vm0/artifact-templates/presentation/a184e26a-c514-434e-9467-a19b2af1e979/neo-brutalism.png",
  ],
  nocturne: [
    "https://static.vm0.io/vm0/artifact-templates/presentation/fb660157-e71e-4064-8a96-0c707c7e6a1f/nocturne.png",
  ],
  "pixel-glitch": [
    "https://static.vm0.io/vm0/artifact-templates/presentation/dfcbf20f-9341-4f3f-a93d-4df159f6c4fd/pixel-glitch.png",
  ],
  prospectus: [
    "https://static.vm0.io/vm0/artifact-templates/presentation/5aad7d6c-4ca1-4041-985c-27674403c382/prospectus.png",
  ],
  schoolhouse: [
    "https://static.vm0.io/vm0/artifact-templates/presentation/b8cdd8b6-122d-461a-8dc4-d17a73ad09e5/schoolhouse.png",
  ],
  "sticker-scrapbook": [
    "https://static.vm0.io/vm0/artifact-templates/presentation/4a6c9374-be17-40f9-83e9-acd7d6461efc/sticker-scrapbook.png",
  ],
  strata: [
    "https://static.vm0.io/vm0/artifact-templates/presentation/f931d6b1-c44e-442a-bcd4-c23f60888a7d/strata.png",
  ],
  "taped-consulting": [
    "https://static.vm0.io/vm0/artifact-templates/presentation/fbf6d3b5-9a96-46a4-9fe6-6874b1bb5b63/taped-consulting.png",
  ],
  vantage: [
    "https://static.vm0.io/vm0/artifact-templates/presentation/6d1aea99-3215-41b6-9994-6a4613d64524/vantage.png",
  ],
} as const satisfies Readonly<Record<string, readonly [string, ...string[]]>>;

export const PRESENTATION_TEMPLATE_PICKER_ITEMS: readonly PresentationTemplateItem[] =
  [
    {
      slug: "data-report-presentation",
      title: "Candy charts",
      prompt:
        "/gen presentation, create a 15-slide research findings deck for MetroPulse, a city mobility study comparing bike-share, buses, rideshare, and commuter rail across 12 neighborhoods. Present it to urban planning stakeholders with cover, contents, study context, methodology, demand trends, neighborhood segments, mode comparison, peak-hour bottlenecks, equity impact, emissions estimate, 12-month forecast, recommendations, summary, and contact. Make it chart-led, sharp, vivid, and number-first.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/920c6119-1833-4902-bda9-327af1bd8f7f/data-report-presentation.html",
      previewImage: DATA_REPORT_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "data-report-presentation"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "data-report-presentation"
        ]["prism"],
      previewImages: DATA_REPORT_PREVIEW_IMAGES,
      slideCount: 15,
      previewHtmls: DATA_REPORT_PREVIEW_HTMLS,
      colorSystemId: "color-system:prism",
      templateId: "template:html-ppt-data-report",
    },
    {
      slug: "editorial-magazine-deck",
      title: "Paper magazine",
      prompt:
        "/gen presentation, create a 15-slide media kit for Field Notes Quarterly, an independent culture magazine pitching its autumn issue on craft, travel, food, and design to premium sponsors. Include cover, editor letter, issue theme, audience profile, editorial departments, contributor roster, feature previews, photography gallery, distribution plan, partnership formats, audience metrics, sponsor examples, rate card, production timeline, and contact. Make it restrained, paper-forward, serif, and magazine-like.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/85360bd6-8b80-43ba-9c9c-001b7d96f205/editorial-magazine-deck.html",
      previewImage: EDITORIAL_MAGAZINE_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "editorial-magazine-deck"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "editorial-magazine-deck"
        ]["warm-sand"],
      previewImages: EDITORIAL_MAGAZINE_PREVIEW_IMAGES,
      slideCount: 15,
      previewHtmls: EDITORIAL_MAGAZINE_PREVIEW_HTMLS,
      colorSystemId: "color-system:warm-sand",
      templateId: "template:html-ppt-editorial-magazine",
    },
    {
      slug: "vantage",
      title: "Numbered boardroom",
      prompt:
        "/gen presentation, create a 15-slide business proposal for Vantage Partners helping a robotics manufacturer launch a new service program. Present it to enterprise buyers with cover, agenda, market context, buyer pain points, proposed solution, service model, operating plan, proof metrics, roadmap, commercials, implementation timeline, team, and close. Make it business-focused, confident, structured, and modern.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/acada4b0-952c-4354-a382-56dcf49bb7e9/vantage.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["vantage"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["vantage"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["vantage"][
          "slate-corporate"
        ],
      previewImages: PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["vantage"],
      slideCount: 15,
      colorSystemId: "color-system:slate-corporate",
      templateId: "template:html-ppt-vantage",
    },
    {
      slug: "taped-consulting",
      title: "Polaroid wall",
      prompt:
        "/gen presentation, create a 15-slide transformation proposal for Clearpath Advisory helping a healthcare network improve patient intake operations. Present it to operations executives with cover, agenda, current-state diagnosis, opportunity, engagement model, workstreams, field research, process redesign, timeline, proof metrics, testimonials, pricing, and next steps. Make it consulting-focused, tactile, polished, and persuasive.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/ffa53ff0-36b0-4bd1-b44a-4c2d8d66aaa6/taped-consulting.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["taped-consulting"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["taped-consulting"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["taped-consulting"][
          "slate-corporate"
        ],
      previewImages:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["taped-consulting"],
      slideCount: 15,
      colorSystemId: "color-system:slate-corporate",
      templateId: "template:html-ppt-taped-consulting",
    },
    {
      slug: "strata",
      title: "Red staircase",
      prompt:
        "/gen presentation, create a 15-slide agency proposal for Strata Studio helping a fintech brand redesign its onboarding and lifecycle communications. Present it to the client leadership team with cover, agenda, business challenge, strategic principles, design direction, service scope, sprint process, sample work, measurement plan, timeline, investment, team, and next steps. Make it Swiss-minimal, precise, editorial, and agency-grade.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/040ddb5c-6819-436a-bd3a-87cb5de2be0e/strata.html",
      previewImage: PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["strata"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["strata"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["strata"]["mono-ink"],
      previewImages: PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["strata"],
      slideCount: 15,
      colorSystemId: "color-system:mono-ink",
      templateId: "template:html-ppt-strata",
    },
    {
      slug: "sticker-scrapbook",
      title: "Sticker notebook",
      prompt:
        "/gen presentation, create a 15-slide brand collaboration deck for Patch Party, a youth culture festival launching sponsor activations, creator booths, and collectible merch. Present it to brand partners with cover, agenda, audience story, event concept, activation zones, creator plan, media moments, sponsor packages, timeline, reach metrics, testimonials, budget, and contact. Make it vibrant, scrapbook-like, sticker-heavy, and celebratory.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/f15ccce7-90f1-4773-b4c8-c7eaf903ce76/sticker-scrapbook.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["sticker-scrapbook"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["sticker-scrapbook"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["sticker-scrapbook"][
          "prism"
        ],
      previewImages:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["sticker-scrapbook"],
      slideCount: 15,
      colorSystemId: "color-system:prism",
      templateId: "template:html-ppt-sticker-scrapbook",
    },
    {
      slug: "schoolhouse",
      title: "Kraft poster",
      prompt:
        "/gen presentation, create a 15-slide community education deck for Maple Hall launching a weekend skills program for families and local makers. Present it to city partners with cover, agenda, mission, audience needs, program tracks, sample day, instructor team, venue plan, safety approach, outcomes, testimonials, membership tiers, budget, and registration steps. Make it warm, retro, classroom-inspired, and approachable.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/cb03f77b-982d-4708-8781-2a0ab450a4fb/schoolhouse.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["schoolhouse"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["schoolhouse"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["schoolhouse"][
          "bauhaus-primary"
        ],
      previewImages:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["schoolhouse"],
      slideCount: 15,
      colorSystemId: "color-system:bauhaus-primary",
      templateId: "template:html-ppt-schoolhouse",
    },
    {
      slug: "prospectus",
      title: "Homepage pitch",
      prompt:
        "/gen presentation, create a 15-slide business plan for Atlas Harbor, a B2B logistics platform expanding into regional fulfillment. Present it to strategic partners with cover, agenda, market context, customer problem, solution, operating model, product experience, growth plan, financial model, implementation roadmap, risks, team, partnership terms, and next steps. Make it corporate, polished, structured, and proposal-ready.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/64a9b8c5-f89d-4379-998c-9da755f7ca62/prospectus.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["prospectus"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["prospectus"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["prospectus"][
          "slate-corporate"
        ],
      previewImages:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["prospectus"],
      slideCount: 15,
      colorSystemId: "color-system:slate-corporate",
      templateId: "template:html-ppt-prospectus",
    },
    {
      slug: "pixel-glitch",
      title: "Arcade pixels",
      prompt:
        "/gen presentation, create a 15-slide creative studio deck for Arcade Signal pitching a retro-futurist campaign for an indie game launch. Present it to the publisher team with cover, agenda, audience insight, campaign concept, visual world, channel plan, creator program, launch timeline, asset gallery, performance targets, budget, team, and next steps. Make it pixelated, energetic, digital, and sharp.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/274e4cc3-d811-40a1-a091-526db9a62734/pixel-glitch.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["pixel-glitch"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["pixel-glitch"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["pixel-glitch"][
          "bauhaus-primary"
        ],
      previewImages:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["pixel-glitch"],
      slideCount: 15,
      colorSystemId: "color-system:bauhaus-primary",
      templateId: "template:html-ppt-pixel-glitch",
    },
    {
      slug: "nocturne",
      title: "Midnight stage",
      prompt:
        "/gen presentation, create a 15-slide annual keynote for NightOps Cloud reviewing reliability, infrastructure scale, and the roadmap for autonomous operations. Present it to technical customers with cover, agenda, state of the platform, usage growth, reliability metrics, architecture, product updates, customer stories, roadmap, ecosystem, pricing changes, and closing call to action. Make it dark, data-rich, polished, and keynote-ready.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/dd4ecb89-b6b1-4ed0-bfca-4ebf3db3a664/nocturne.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["nocturne"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["nocturne"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["nocturne"][
          "midnight-mono"
        ],
      previewImages: PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["nocturne"],
      slideCount: 15,
      colorSystemId: "color-system:midnight-mono",
      templateId: "template:html-ppt-nocturne",
    },
    {
      slug: "neo-brutalism",
      title: "Shadow shop",
      prompt:
        "/gen presentation, create a 15-slide founder pitch for BlockForge, a developer tooling startup launching a collaborative build system. Present it to early-stage investors with cover, agenda, problem, product, technical edge, market, traction, customer proof, business model, go-to-market, competition, roadmap, team, funding ask, and next steps. Make it bold, direct, high-contrast, and brutalist.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/4d8a4052-b43d-498a-81cc-b4c743103ff2/neo-brutalism.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["neo-brutalism"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["neo-brutalism"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["neo-brutalism"][
          "mono-ink"
        ],
      previewImages:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["neo-brutalism"],
      slideCount: 15,
      colorSystemId: "color-system:mono-ink",
      templateId: "template:html-ppt-neo-brutalism",
    },
    {
      slug: "meridian",
      title: "Cobalt blocks",
      prompt:
        "/gen presentation, create a 15-slide agency capabilities deck for Meridian Works, a data strategy studio helping enterprise teams modernize analytics operations. Present it to a prospective client executive team with cover, agenda, market context, client challenges, service model, team, process, case studies, measurement plan, operating rhythm, timeline, commercial model, and contact. Make it professional, sharp, data-led, and executive-ready.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/58cc240d-7d84-49a7-92ba-57eea4168730/meridian.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["meridian"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["meridian"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["meridian"][
          "slate-corporate"
        ],
      previewImages: PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["meridian"],
      slideCount: 15,
      colorSystemId: "color-system:slate-corporate",
      templateId: "template:html-ppt-meridian",
    },
    {
      slug: "blueprint-academy",
      title: "Drafting campus",
      prompt:
        "/gen presentation, create a 15-slide curriculum proposal for Northline Academy launching an applied AI certificate for working professionals. Present it to academic leadership with cover, agenda, program context, learner needs, curriculum map, module sequence, faculty team, classroom experience, assessment model, outcomes, partnerships, enrollment plan, budget, and next steps. Make it academic, structured, blueprint-like, and credible.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/f64cd670-7565-483f-b872-117a18c0c414/blueprint-academy.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["blueprint-academy"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["blueprint-academy"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["blueprint-academy"][
          "forest-editorial"
        ],
      previewImages:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["blueprint-academy"],
      slideCount: 15,
      colorSystemId: "color-system:forest-editorial",
      templateId: "template:html-ppt-blueprint-academy",
    },
    {
      slug: "bloom-pitch",
      title: "Petal pitch",
      prompt:
        "/gen presentation, create a 15-slide investor pitch for PetalLoop, a climate-friendly flower delivery marketplace raising a seed round. Include cover, agenda, market shift, customer problem, solution, product flow, traction, business model, go-to-market, competitive position, roadmap, team, financial plan, ask, and next steps. Make it playful, optimistic, organic, and investor-ready.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/d29707fb-9b85-44bc-be55-cf3cf082f68d/bloom-pitch.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["bloom-pitch"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["bloom-pitch"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["bloom-pitch"][
          "carnival"
        ],
      previewImages:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["bloom-pitch"],
      slideCount: 15,
      colorSystemId: "color-system:carnival",
      templateId: "template:html-ppt-bloom-pitch",
    },
    {
      slug: "playful-pop-deck",
      title: "Neon candy",
      prompt:
        "/gen presentation, create a 15-slide campus launch deck for FizzPop, a sparkling tea brand planning a colorful back-to-school sampling tour, creator challenge, and limited-edition flavor drop. Present it to retail and student ambassador partners with cover, agenda, brand world, audience insight, campaign idea, flavor lineup, activation map, event flow, content plan, gallery, reach metrics, partner testimonials, budget, and contact. Make it neon, bouncy, rounded, and pop-art playful.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/6b2f388a-119f-4ecc-8638-5cc309779b67/playful-pop-deck.html",
      previewImage: PLAYFUL_POP_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["playful-pop-deck"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["playful-pop-deck"][
          "pop-art"
        ],
      previewImages: PLAYFUL_POP_PREVIEW_IMAGES,
      slideCount: 15,
      previewHtmls: PLAYFUL_POP_PREVIEW_HTMLS,
      colorSystemId: "color-system:pop-art",
      templateId: "template:html-ppt-playful-pop",
    },
    {
      slug: "mosaic-geometric-pitch",
      title: "Bauhaus tiles",
      prompt:
        "/gen presentation, create a 15-slide modular identity pitch for CivicLink, a new transit app unifying buses, bikes, scooters, and commuter rail under one visual system. Present it to city innovation leaders with cover, agenda, brand problem, design principles, logo grid, color and icon system, app moments, rollout process, station signage gallery, accessibility impact, pilot metrics, stakeholder quotes, implementation budget, and contact. Make it bold, modular, Bauhaus-geometric, and colourful.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/65f0f224-4bf0-4b11-9f3e-ddb1a11b1ec3/mosaic-geometric-pitch.html",
      previewImage: MOSAIC_GEOMETRIC_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "mosaic-geometric-pitch"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "mosaic-geometric-pitch"
        ]["carnival"],
      previewImages: MOSAIC_GEOMETRIC_PREVIEW_IMAGES,
      slideCount: 15,
      previewHtmls: MOSAIC_GEOMETRIC_PREVIEW_HTMLS,
      colorSystemId: "color-system:carnival",
      templateId: "template:html-ppt-mosaic-geometric",
    },
    {
      slug: "lumina-creative-studio",
      title: "Brush stickers",
      prompt:
        "/gen presentation, create a 15-slide portfolio deck for LensLab Studio, a photography and motion team pitching a beauty brand's global campaign shoot across studio sets, street casting, and social cutdowns. Include cover, agenda, studio point of view, campaign concept, team, production services, creative process, location plan, image gallery, motion deliverables, campaign metrics, client quotes, package options, and contact. Make it bold, sticker-tagged, sharp, and creative-studio oriented.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/08fe05a2-a7dd-4355-822d-14fb6a0987b3/lumina-creative-studio.html",
      previewImage: LUMINA_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "lumina-creative-studio"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "lumina-creative-studio"
        ]["prism"],
      previewImages: LUMINA_PREVIEW_IMAGES,
      slideCount: 15,
      previewHtmls: LUMINA_PREVIEW_HTMLS,
      colorSystemId: "color-system:prism",
      templateId: "template:html-ppt-lumina",
    },
    {
      slug: "landing-consulting-deck",
      title: "Neon browser",
      prompt:
        "/gen presentation, create a 15-slide growth proposal for ScaleBridge advising a B2B fintech SaaS team on reducing onboarding drop-off and improving trial-to-paid conversion. Present it to the revenue leadership team with cover, agenda, opportunity size, diagnosis, desired outcomes, engagement model, workstreams, sprint process, benchmark gallery, proof metrics, client testimonials, pricing tiers, decision timeline, and contact. Make it landing-page-like, sharp, high-contrast, and conversion-oriented.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/998aed16-60a1-4d84-b60e-1ab093de8fa6/landing-consulting-deck.html",
      previewImage: LANDING_CONSULTING_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "landing-consulting-deck"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "landing-consulting-deck"
        ]["pop-art"],
      previewImages: LANDING_CONSULTING_PREVIEW_IMAGES,
      slideCount: 15,
      previewHtmls: LANDING_CONSULTING_PREVIEW_HTMLS,
      colorSystemId: "color-system:pop-art",
      templateId: "template:html-ppt-landing-consulting",
    },
    {
      slug: "creative-agency-presentation",
      title: "Foliage gallery",
      prompt:
        "/gen presentation, create a 15-slide rebrand pitch for Northstar Studio proposing a new identity, website, and launch campaign for a boutique hotel group expanding into three coastal cities. Present it to the client board with cover, agenda, brand challenge, strategic insight, creative direction, visual territories, service scope, project process, case-study gallery, launch roadmap, impact metrics, client quotes, investment, and contact. Make it minimal, editorial, sharp, and agency-grade.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/527ad859-e0dd-4cfd-90a4-09e5030b71e1/creative-agency-presentation.html",
      previewImage: CREATIVE_AGENCY_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "creative-agency-presentation"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "creative-agency-presentation"
        ]["coral-studio"],
      previewImages: CREATIVE_AGENCY_PREVIEW_IMAGES,
      slideCount: 15,
      previewHtmls: CREATIVE_AGENCY_PREVIEW_HTMLS,
      colorSystemId: "color-system:coral-studio",
      templateId: "template:html-ppt-creative-agency",
    },
    {
      slug: "crayon-learning-deck",
      title: "Crayon doodle",
      prompt:
        "/gen presentation, create a 15-slide parent-night deck for Rainbow Lab, a summer art-and-science camp where kids build storybooks, cardboard cities, and tiny robots. Present it to families with cover, agenda, camp promise, learning goals, weekly themes, instructor team, sample day, workshop stations, student gallery, safety plan, progress metrics, parent quotes, pricing, and registration steps. Make it bright, rounded, joyful, and crayon-like.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/63af1d38-51e8-493e-b975-1728f4f796da/crayon-learning-deck.html",
      previewImage: CRAYON_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "crayon-learning-deck"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "crayon-learning-deck"
        ]["prism"],
      previewImages: CRAYON_PREVIEW_IMAGES,
      slideCount: 15,
      previewHtmls: CRAYON_PREVIEW_HTMLS,
      colorSystemId: "color-system:prism",
      templateId: "template:html-ppt-crayon",
    },
    {
      slug: "business-data-presentation",
      title: "Berry dashboard",
      prompt:
        "/gen presentation, create a 15-slide executive data readout for HarborCart, an omnichannel grocery retailer reviewing 2026 growth, loyalty behavior, basket mix, and store-to-delivery conversion. Present it to the leadership team with cover, agenda, business context, KPI scorecard, regional segments, channel comparison, customer cohorts, operational drivers, forecast, strategic bets, risks, recommendations, and appendix contact. Make it number-first, chart-led, confident, modern, and readable.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/95648bba-2a52-497e-b1b8-9cdd0cab9d93/business-data-presentation.html",
      previewImage: BUSINESS_DATA_CDN_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "business-data-presentation"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "business-data-presentation"
        ]["berry-pop"],
      previewImages: BUSINESS_DATA_CDN_PREVIEW_IMAGES,
      slideCount: 15,
      colorSystemId: "color-system:berry-pop",
      templateId: "template:html-ppt-business-data",
    },
    {
      slug: "botane-organic-deck",
      title: "Mauve garden",
      prompt:
        "/gen presentation, create a 15-slide brand story deck for Moss & Moon, a coastal wellness retreat launching a seasonal herb garden, tea bar, and slow-living membership program. Present it to hospitality partners with cover, agenda, origin story, guest philosophy, retreat spaces, treatment menu, garden-to-table process, photography gallery, sustainability metrics, member testimonials, packages, and contact. Make it calm, editorial, rounded, and organic.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/0babab92-7ad9-414e-b44f-7a060ed48bcc/botane-organic-deck.html",
      previewImage: BOTANE_ORGANIC_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["botane-organic-deck"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["botane-organic-deck"][
          "mauve-dusk"
        ],
      previewImages: BOTANE_ORGANIC_PREVIEW_IMAGES,
      slideCount: 15,
      colorSystemId: "color-system:mauve-dusk",
      templateId: "template:html-ppt-botane-organic",
    },
    {
      slug: "playful-launch-presentation",
      title: "Sunburst playroom",
      prompt:
        "/gen presentation, create a 15-slide launch deck for SproutPop, a playful habit-building app for remote teams introducing a shared 30-day wellness challenge. Present it to people and culture leaders with cover, agenda, launch story, audience pain points, product vision, feature tour, rollout timeline, activation moments, team, early metrics, testimonials, pricing, and next steps. Make it saturated, joyful, idea-led, and structured.",
      embedUrl:
        "https://static.vm0.io/vm0/artifact-templates/presentation/daf7c2d1-5195-4c09-ad4b-8d85778fc104/playful-launch-presentation.html",
      previewImage: PLAYFUL_LAUNCH_CDN_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "playful-launch-presentation"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "playful-launch-presentation"
        ]["carnival"],
      previewImages: PLAYFUL_LAUNCH_CDN_PREVIEW_IMAGES,
      slideCount: 15,
      colorSystemId: "color-system:carnival",
      templateId: "template:html-ppt-playful-launch",
    },
  ];
