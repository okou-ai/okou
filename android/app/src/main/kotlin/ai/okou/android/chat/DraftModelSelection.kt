package ai.okou.android.chat

import ai.okou.android.api.generated.CanonicalOptional
import ai.okou.android.api.generated.CreateThreadRequest
import ai.okou.android.api.generated.CreateThreadRequestReasoningEffort
import ai.okou.android.api.generated.CreateThreadRequestServiceTier
import ai.okou.android.settings.DefaultModelOptions
import ai.okou.android.settings.DefaultModelState
import ai.okou.android.settings.ModelEffort
import ai.okou.android.settings.isAutoDefaultModel
import kotlinx.serialization.Serializable

/** A null selection inherits the server default. A selection with a null model pins Auto. */
@Serializable
data class DraftModelSelection(
    val model: String?,
    val efforts: Map<String, CreateThreadRequestReasoningEffort> = emptyMap(),
    val fast: Boolean = false,
)

internal fun DefaultModelState.draftDefaults(): DraftModelSelection {
    val confirmed = record?.confirmed
    val model = confirmed?.selectedModel?.takeUnless(::isAutoDefaultModel)
    return DraftModelSelection(
        options?.resolve(model) ?: model,
        confirmed
            ?.modelSettings
            .orEmpty()
            .mapNotNull { (id, settings) ->
                settings.effort?.let {
                    (options?.resolve(id) ?: id) to
                        CreateThreadRequestReasoningEffort.valueOf(it.name)
                }
            }
            .toMap(),
        confirmed?.serviceTier != null,
    )
}

internal fun DraftModelSelection.withEffort(model: String, effort: ModelEffort) =
    copy(efforts = efforts + (model to CreateThreadRequestReasoningEffort.valueOf(effort.name)))

internal fun DraftModelSelection.applyTo(
    request: CreateThreadRequest,
    options: DefaultModelOptions?,
): CreateThreadRequest {
    val selected = options?.resolve(model) ?: model
    val capability = options?.choices?.firstOrNull { it.id == selected && it.canSelect }
    val effort =
        efforts[selected]?.takeIf { value ->
            options == null || capability?.efforts?.any { it.name == value.name } == true
        } ?: capability?.defaultEffort?.let { CreateThreadRequestReasoningEffort.valueOf(it.name) }
    return request.copy(
        model = CanonicalOptional.Present(selected),
        serviceTier =
            CanonicalOptional.Present(
                CreateThreadRequestServiceTier.PRIORITY.takeIf {
                    selected != null &&
                        fast &&
                        (options == null || capability?.fastMultiplier != null)
                },
            ),
        reasoningEffort = effort,
    )
}
