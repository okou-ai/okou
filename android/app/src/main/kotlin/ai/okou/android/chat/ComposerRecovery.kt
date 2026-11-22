package ai.okou.android.chat

import ai.okou.android.api.generated.CanonicalInteger1
import ai.okou.android.api.generated.ResetSubscriptionResultOutcome
import ai.okou.android.api.generated.SendRequestVariant1
import ai.okou.android.api.generated.SendRequestVariant1RunOptions
import ai.okou.android.api.generated.SendRequestVariant1RunOptionsCodexServiceTier
import ai.okou.android.api.generated.SendRequestVariant1UserMessage
import ai.okou.android.api.generated.SendRequestVariant1UserMessagePartsItem
import ai.okou.android.api.generated.SendRequestVariant1UserMessagePartsItemVariant1
import ai.okou.android.api.generated.SendRequestVariant1UserMessagePartsItemVariant11
import ai.okou.android.api.generated.SendRequestVariant1UserMessagePartsItemVariant11ServiceTier
import ai.okou.android.api.generated.SendRequestVariant1UserMessagePartsItemVariant11Type
import ai.okou.android.api.generated.SendRequestVariant1UserMessagePartsItemVariant1Type
import java.util.UUID
import kotlinx.serialization.Serializable

@Serializable
data class RecoveryReset(
    val accountId: String,
    val idempotencyKey: String,
    val windows: List<String>,
)

/** One frozen new input and, optionally, the reset that must finish before it. No editable text. */
@Serializable
data class ComposerRecovery(
    val selection: RecoverySelection,
    val send: SendRequestVariant1,
    val reset: RecoveryReset? = null,
    val outcome: ResetSubscriptionResultOutcome? = null,
    val submitted: Boolean = false,
)

internal fun newRecoveryReset(data: FailureRecoveryData) =
    RecoveryReset(checkNotNull(data.resetAccount).id, UUID.randomUUID().toString(), data.resetTimes)

internal fun newRecovery(data: FailureRecoveryData, reset: Boolean): ComposerRecovery {
    val selected = data.selection
    val fast =
        selected.priority &&
            selected.model?.let { model ->
                model == "auto" || data.catalog?.models?.any { it.model == model } == true
            } == true
    val parts =
        buildList<SendRequestVariant1UserMessagePartsItem> {
            add(
                SendRequestVariant1UserMessagePartsItemVariant1(
                    SendRequestVariant1UserMessagePartsItemVariant1Type.TEXT,
                    "continue",
                )
            )
            selected.model?.let {
                add(
                    SendRequestVariant1UserMessagePartsItemVariant11(
                        SendRequestVariant1UserMessagePartsItemVariant11Type.MODEL,
                        it,
                        if (fast)
                            SendRequestVariant1UserMessagePartsItemVariant11ServiceTier.PRIORITY
                        else null,
                    )
                )
            }
        }
    return ComposerRecovery(
        selected,
        SendRequestVariant1(
            threadId = selected.threadId,
            prompt = "continue",
            clientEventId = UUID.randomUUID().toString(),
            chatThreadSortEventId = UUID.randomUUID().toString(),
            hasTextContent = true,
            userMessage = SendRequestVariant1UserMessage(CanonicalInteger1, parts),
            runOptions =
                if (fast)
                    SendRequestVariant1RunOptions(
                        codexServiceTier = SendRequestVariant1RunOptionsCodexServiceTier.FAST
                    )
                else null,
        ),
        if (reset) newRecoveryReset(data) else null,
    )
}
