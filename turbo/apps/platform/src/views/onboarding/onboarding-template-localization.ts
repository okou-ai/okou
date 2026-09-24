import {
  type IllustrationTemplateItem,
  ILLUSTRATION_TEMPLATE_ITEMS,
} from "@okouai/core/illustration-template-items";
import {
  type PresentationTemplateItem,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
} from "@okouai/core/presentation-template-items";
import type { TFunction } from "i18next";
import enUSCommon from "../../i18n/locales/en-US/common.json";

const PRESENTATION_TITLES = enUSCommon.onboarding.templates.presentation;
const ILLUSTRATION_TITLES = enUSCommon.onboarding.templates.illustration;

function hasOwnKey<ObjectType extends object>(
  object: ObjectType,
  key: PropertyKey,
): key is keyof ObjectType {
  return Object.hasOwn(object, key);
}

export function localizedPresentationTemplates(
  t: TFunction<"common">,
): readonly PresentationTemplateItem[] {
  return PRESENTATION_TEMPLATE_PICKER_ITEMS.slice(0, 11).map((template) => {
    const slug = template.slug;
    if (!hasOwnKey(PRESENTATION_TITLES, slug)) {
      throw new Error(`Missing presentation template localization: ${slug}`);
    }
    return {
      ...template,
      title: t(($) => {
        return $.onboarding.templates.presentation[slug];
      }),
    };
  });
}

export function localizedIllustrationTemplates(
  t: TFunction<"common">,
): readonly IllustrationTemplateItem[] {
  return ILLUSTRATION_TEMPLATE_ITEMS.map((template) => {
    const slug = template.slug;
    if (!hasOwnKey(ILLUSTRATION_TITLES, slug)) {
      throw new Error(`Missing illustration template localization: ${slug}`);
    }
    return {
      ...template,
      title: t(($) => {
        return $.onboarding.templates.illustration[slug];
      }),
    };
  });
}
