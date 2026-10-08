import type { AvailableRunModel } from "./model-providers";

export function isMemberRunModelAvailable(model: AvailableRunModel): boolean {
  return model.memberEffective.availability === "available";
}

export function isMemberRunModelConfigurable(
  model: AvailableRunModel,
): boolean {
  const { availability } = model.memberEffective;
  return availability === "available" || availability === "reconnect_required";
}
