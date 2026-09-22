import { command, computed, state } from "ccstate";

/** Request-owned lookup identities; production uses the canonical skill storage. */
export type SystemSkillStorageResolution = Readonly<
  Partial<Record<string, string>>
>;

const innerResolution$ = state<SystemSkillStorageResolution>({});

export const systemSkillStorageResolution$ = computed((get) => {
  return get(innerResolution$);
});

export const setSystemSkillStorageResolution$ = command(
  ({ set }, resolution: SystemSkillStorageResolution): void => {
    set(innerResolution$, resolution);
  },
);
