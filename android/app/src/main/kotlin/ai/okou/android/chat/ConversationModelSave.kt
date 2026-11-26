package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.api.generated.ChatArchiveChatThreadsItemServiceTier
import ai.okou.android.api.generated.CreateThreadRequestReasoningEffort
import ai.okou.android.settings.isAutoDefaultModel
import androidx.annotation.StringRes

enum class ConversationModelSave(
    internal val blocksSend: Boolean,
    @StringRes internal val message: Int,
) {
    Saving(true, R.string.settings_saving),
    Checking(true, R.string.instructions_checking),
    NeedsCheck(true, R.string.chat_model_check_required),
    Rejected(false, R.string.chat_model_save_rejected),
    Unconfirmed(false, R.string.chat_model_save_unconfirmed),
}

internal data class ConversationModelControls(
    val chats: ChatListModel,
    val confirmed: ConfirmedChat,
    val save: ConversationModelSave?,
)

internal fun ConfirmedChat.modelSelection() =
    DraftModelSelection(
        selectedModel.takeUnless(::isAutoDefaultModel),
        modelSettings
            .orEmpty()
            .mapNotNull { (id, settings) ->
                settings.effort?.let { id to CreateThreadRequestReasoningEffort.valueOf(it.name) }
            }
            .toMap(),
        fast = serviceTier == ChatArchiveChatThreadsItemServiceTier.PRIORITY,
    )
