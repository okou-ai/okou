import type {
  HalloweenQuestion,
  HalloweenRound,
} from "@okouai/api-contracts/contracts/halloween";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type enUSHalloween from "../../i18n/locales/en-US/halloween.json";

export function useHalloweenCopy() {
  const { t } = useTranslation("halloween");
  const copy = t(
    ($) => {
      return $.copy;
    },
    { returnObjects: true },
  );
  const levels = t(
    ($) => {
      return $.levels;
    },
    { returnObjects: true },
  );
  const nudges = t(
    ($) => {
      return $.nudges;
    },
    { returnObjects: true },
  );
  const tasks = t(
    ($) => {
      return $.tasks;
    },
    { returnObjects: true },
  );
  const rules = t(
    ($) => {
      return $.rules;
    },
    { returnObjects: true },
  );
  return {
    ...copy,
    questionProgress: (current: number, total: number) => {
      return t(
        ($) => {
          return $.copy.questionProgress;
        },
        { current, total },
      );
    },
    levels: [levels.one, levels.two, levels.three, levels.four, levels.five],
    nudges: [nudges.one, nudges.two, nudges.three],
    tasks: [
      {
        ...tasks.createImage,
      },
      {
        ...tasks.connectTools,
      },
      {
        ...tasks.explore,
        prompt: "",
      },
    ],
    ruleSections: [rules.availability, rules.play, rules.reward, rules.support],
  } as const;
}

type HalloweenQuestionId = keyof typeof enUSHalloween.questions;
type HalloweenOptionId = "A" | "B" | "C";
const HALLOWEEN_QUESTION_ID = /^QUIZ-(?:0[1-9]|[1-4][0-9]|5[0-3])$/u;

function isHalloweenQuestionId(value: string): value is HalloweenQuestionId {
  return HALLOWEEN_QUESTION_ID.test(value);
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
  t: TFunction<"halloween">,
  question: HalloweenQuestion,
): HalloweenQuestion {
  assertHalloweenQuestionId(question.id);
  const questionId = question.id;
  return {
    ...question,
    text: t(($) => {
      return $.questions[questionId].text;
    }),
    options: question.options.map((option) => {
      assertHalloweenOptionId(option.id);
      const optionId = option.id;
      return {
        ...option,
        text: t(($) => {
          return $.questions[questionId].options[optionId];
        }),
      };
    }),
  };
}

export function useLocalizedHalloweenRound(
  round: HalloweenRound | null,
): HalloweenRound | null {
  const { t } = useTranslation("halloween");
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
                return $.questions[questionId].explanation;
              })
            : t(($) => {
                return $.copy.lostSub;
              }),
        }
      : null,
  };
}
