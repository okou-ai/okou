import type {
  HalloweenQuestion,
  HalloweenRound,
} from "@okouai/api-contracts/contracts/halloween";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import enUSCommon from "../../i18n/locales/en-US/common.json";

function useHalloweenMainCopy() {
  const { t } = useTranslation();
  return {
    brand: t(($) => {
      return $.halloween.copy.brand;
    }),
    campaign: t(($) => {
      return $.halloween.copy.campaign;
    }),
    tagline: t(($) => {
      return $.halloween.copy.tagline;
    }),
    language: t(($) => {
      return $.halloween.copy.language;
    }),
    climb: t(($) => {
      return $.halloween.copy.climb;
    }),
    rulesHeading: t(($) => {
      return $.halloween.copy.rulesHeading;
    }),
    rulesSub: t(($) => {
      return $.halloween.copy.rulesSub;
    }),
    rulesBrand: t(($) => {
      return $.halloween.copy.rulesBrand;
    }),
    rewardPrefix: t(($) => {
      return $.halloween.copy.rewardPrefix;
    }),
    rewardEmphasis: t(($) => {
      return $.halloween.copy.rewardEmphasis;
    }),
    resultRewardEmphasis: t(($) => {
      return $.halloween.copy.resultRewardEmphasis;
    }),
    resultRewardRest: t(($) => {
      return $.halloween.copy.resultRewardRest;
    }),
    title: t(($) => {
      return $.halloween.copy.title;
    }),
    subtitle: t(($) => {
      return $.halloween.copy.subtitle;
    }),
    review: t(($) => {
      return $.halloween.copy.review;
    }),
    hint: t(($) => {
      return $.halloween.copy.hint;
    }),
    start: t(($) => {
      return $.halloween.copy.start;
    }),
    back: t(($) => {
      return $.halloween.copy.back;
    }),
    rules: t(($) => {
      return $.halloween.copy.rules;
    }),
    leave: t(($) => {
      return $.halloween.copy.leave;
    }),
    next: t(($) => {
      return $.halloween.copy.next;
    }),
    result: t(($) => {
      return $.halloween.copy.result;
    }),
    again: t(($) => {
      return $.halloween.copy.again;
    }),
    correct: t(($) => {
      return $.halloween.copy.correct;
    }),
    questionProgress: (current: number, total: number) => {
      return t(
        ($) => {
          return $.halloween.copy.questionProgress;
        },
        { current, total },
      );
    },
    roundProgress: (current: string, title: string) => {
      return t(
        ($) => {
          return $.halloween.copy.roundProgress;
        },
        { current, title },
      );
    },
  } as const;
}

function useHalloweenResultCopy() {
  const { t } = useTranslation();
  return {
    soundOn: t(($) => {
      return $.halloween.copy.soundOn;
    }),
    soundOff: t(($) => {
      return $.halloween.copy.soundOff;
    }),
    won: t(($) => {
      return $.halloween.copy.won;
    }),
    wonSub: t(($) => {
      return $.halloween.copy.wonSub;
    }),
    lost: t(($) => {
      return $.halloween.copy.lost;
    }),
    lostSub: t(($) => {
      return $.halloween.copy.lostSub;
    }),
    taskTitle: t(($) => {
      return $.halloween.copy.taskTitle;
    }),
    taskSub: t(($) => {
      return $.halloween.copy.taskSub;
    }),
    optional: t(($) => {
      return $.halloween.copy.optional;
    }),
    magic: t(($) => {
      return $.halloween.copy.magic;
    }),
    footerBefore: t(($) => {
      return $.halloween.copy.footerBefore;
    }),
    footerLink: t(($) => {
      return $.halloween.copy.footerLink;
    }),
    footerAfter: t(($) => {
      return $.halloween.copy.footerAfter;
    }),
    unavailable: t(($) => {
      return $.halloween.copy.unavailable;
    }),
    unavailableSub: t(($) => {
      return $.halloween.copy.unavailableSub;
    }),
    error: t(($) => {
      return $.halloween.copy.error;
    }),
    backToGame: t(($) => {
      return $.halloween.copy.backToGame;
    }),
    nudgeLabel: t(($) => {
      return $.halloween.copy.nudgeLabel;
    }),
    boo: t(($) => {
      return $.halloween.copy.boo;
    }),
  } as const;
}

function useHalloweenCollections() {
  const { t } = useTranslation();
  return {
    roundTitles: [
      t(($) => {
        return $.halloween.roundTitles.one;
      }),
      t(($) => {
        return $.halloween.roundTitles.two;
      }),
      t(($) => {
        return $.halloween.roundTitles.three;
      }),
      t(($) => {
        return $.halloween.roundTitles.four;
      }),
      t(($) => {
        return $.halloween.roundTitles.five;
      }),
    ],
    levels: [
      t(($) => {
        return $.halloween.levels.one;
      }),
      t(($) => {
        return $.halloween.levels.two;
      }),
      t(($) => {
        return $.halloween.levels.three;
      }),
      t(($) => {
        return $.halloween.levels.four;
      }),
      t(($) => {
        return $.halloween.levels.five;
      }),
    ],
    nudges: [
      t(($) => {
        return $.halloween.nudges.one;
      }),
      t(($) => {
        return $.halloween.nudges.two;
      }),
      t(($) => {
        return $.halloween.nudges.three;
      }),
    ],
    tasks: [
      {
        title: t(($) => {
          return $.halloween.tasks.createImage.title;
        }),
        text: t(($) => {
          return $.halloween.tasks.createImage.text;
        }),
        prompt: t(($) => {
          return $.halloween.tasks.createImage.prompt;
        }),
      },
      {
        title: t(($) => {
          return $.halloween.tasks.connectTools.title;
        }),
        text: t(($) => {
          return $.halloween.tasks.connectTools.text;
        }),
        prompt: t(($) => {
          return $.halloween.tasks.connectTools.prompt;
        }),
      },
      {
        title: t(($) => {
          return $.halloween.tasks.explore.title;
        }),
        text: t(($) => {
          return $.halloween.tasks.explore.text;
        }),
        prompt: "",
      },
    ],
    ruleSections: [
      {
        title: t(($) => {
          return $.halloween.rules.availability.title;
        }),
        text: t(($) => {
          return $.halloween.rules.availability.text;
        }),
      },
      {
        title: t(($) => {
          return $.halloween.rules.play.title;
        }),
        text: t(($) => {
          return $.halloween.rules.play.text;
        }),
      },
      {
        title: t(($) => {
          return $.halloween.rules.reward.title;
        }),
        text: t(($) => {
          return $.halloween.rules.reward.text;
        }),
      },
      {
        title: t(($) => {
          return $.halloween.rules.support.title;
        }),
        text: t(($) => {
          return $.halloween.rules.support.text;
        }),
      },
    ],
  } as const;
}

export function useHalloweenCopy() {
  return {
    ...useHalloweenMainCopy(),
    ...useHalloweenResultCopy(),
    ...useHalloweenCollections(),
  } as const;
}

type HalloweenQuestionId = keyof typeof enUSCommon.halloween.questions;
type HalloweenOptionId = "A" | "B" | "C";

function isHalloweenQuestionId(value: string): value is HalloweenQuestionId {
  return Object.hasOwn(enUSCommon.halloween.questions, value);
}

function isHalloweenOptionId(value: string): value is HalloweenOptionId {
  return value === "A" || value === "B" || value === "C";
}

function assertHalloweenQuestionId(
  value: string,
): asserts value is HalloweenQuestionId {
  if (!isHalloweenQuestionId(value)) {
    throw new Error(`Unsupported Halloween question: ${value}`);
  }
}

function assertHalloweenOptionId(
  value: string,
): asserts value is HalloweenOptionId {
  if (!isHalloweenOptionId(value)) {
    throw new Error(`Unsupported Halloween answer option: ${value}`);
  }
}

function localizeQuestion(
  t: TFunction<"common">,
  question: HalloweenQuestion,
): HalloweenQuestion {
  assertHalloweenQuestionId(question.id);
  const questionId = question.id;
  return {
    ...question,
    text: t(($) => {
      return $.halloween.questions[questionId].text;
    }),
    options: question.options.map((option) => {
      assertHalloweenOptionId(option.id);
      const optionId = option.id;
      return {
        ...option,
        text: t(($) => {
          return $.halloween.questions[questionId].options[optionId];
        }),
      };
    }),
  };
}

export function useLocalizedHalloweenRound(
  round: HalloweenRound | null,
): HalloweenRound | null {
  const { t } = useTranslation();
  if (!round?.question) {
    return round;
  }
  assertHalloweenQuestionId(round.question.id);
  const questionId = round.question.id;
  return {
    ...round,
    question: localizeQuestion(t, round.question),
    feedback: round.feedback
      ? {
          ...round.feedback,
          explanation: round.feedback.correct
            ? t(($) => {
                return $.halloween.questions[questionId].explanation;
              })
            : t(($) => {
                return $.halloween.copy.lostSub;
              }),
        }
      : null,
  };
}
