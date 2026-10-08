struct ThreadModelSelection: Sendable {
  let model: String?
  let serviceTier: String?
  let reasoningEffort: String?
}

/// Resolves saved preferences into settings for a new thread without side effects.
func resolveThreadModelSelection(
  preference: ModelPreference,
  availableModels: AvailableRunModels,
  catalog: ModelCatalog
) -> ThreadModelSelection {
  // A saved selection of a retired model resolves to its active replacement.
  let savedModel = preference.selectedModel.flatMap { catalog.resolve($0) }
  // Without a usable saved selection, the thread uses Auto (a nil model).
  let model = savedModel.flatMap { model in
    availableModels.models.contains { $0.model == model && $0.hasUsableRoute() }
      ? model : nil
  }
  let serviceTier = preference.serviceTier.flatMap { tier in
    model != nil
      && availableModels.models.contains {
        $0.model == model && $0.supportsServiceTier(tier)
      }
      ? tier : nil
  }
  return ThreadModelSelection(
    model: model,
    serviceTier: serviceTier,
    reasoningEffort: model.flatMap { preference.modelSettings?[$0]?.effort })
}
