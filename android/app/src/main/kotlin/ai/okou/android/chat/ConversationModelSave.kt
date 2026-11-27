package ai.okou.android.chat

import ai.okou.android.FeedbackReceipt
import ai.okou.android.R
import ai.okou.android.api.generated.CanonicalOptional
import ai.okou.android.api.generated.ChatArchiveChatThreadsItemModelSettingsValue
import ai.okou.android.api.generated.ChatArchiveChatThreadsItemModelSettingsValueEffort
import ai.okou.android.api.generated.ChatArchiveChatThreadsItemServiceTier
import ai.okou.android.api.generated.CreateThreadRequestReasoningEffort
import ai.okou.android.api.generated.SetThreadModelRequest
import ai.okou.android.api.generated.SetThreadModelRequestCodexServiceTier
import ai.okou.android.settings.isAutoDefaultModel
import androidx.annotation.StringRes

internal enum class ConversationModelSave(
    @StringRes internal val message: Int,
) {
    Saving(R.string.settings_saving),
    Checking(R.string.instructions_checking),
    NeedsCheck(R.string.chat_model_check_required),
}

@ConsistentCopyVisibility
data class ConversationModelEdits
internal constructor(
    internal val pending: List<ConversationModelEdit> = emptyList(),
    internal val phase: ConversationModelSave? = null,
    internal val accepted: Boolean = false,
    internal val failures: List<FeedbackReceipt<Int>> = emptyList(),
)

internal data class ConversationModelEdit(
    val request: SetThreadModelRequest,
    val expectedModel: String?,
) {
    fun appliesTo(chat: ConfirmedChat): Boolean =
        expectedModel == null ||
            chat.selectedModel == expectedModel ||
            chat.selectedModel == request.model

    fun applyTo(chat: ConfirmedChat): ConfirmedChat {
        val model = request.model
        val effort = request.reasoningEffort
        val tier = request.codexServiceTier
        return chat.copy(
            selectedModel = model,
            modelSettings =
                if (model != null && effort != null)
                    chat.modelSettings.orEmpty() +
                        (model to
                            ChatArchiveChatThreadsItemModelSettingsValue(
                                ChatArchiveChatThreadsItemModelSettingsValueEffort.valueOf(
                                    effort.name,
                                ),
                            ))
                else chat.modelSettings,
            serviceTier =
                if (tier is CanonicalOptional.Present) tier.value.toChatServiceTier()
                else chat.serviceTier,
        )
    }
}

internal data class ConversationModelControls(
    val chats: ChatListModel,
    val confirmed: ConfirmedChat,
    val edits: ConversationModelEdits?,
)

internal fun ConfirmedChat.withModelEdits(edits: ConversationModelEdits?): ConfirmedChat =
    edits?.pending.orEmpty().fold(this) { chat, edit ->
        if (edit.appliesTo(chat)) edit.applyTo(chat) else chat
    }

internal fun List<ConversationModelEdit>.rebaseOn(
    confirmed: ConfirmedChat,
): List<ConversationModelEdit> {
    var chat = confirmed
    return filter { edit ->
        val applies = edit.appliesTo(chat)
        if (applies) chat = edit.applyTo(chat)
        applies
    }
}

internal fun SetThreadModelRequestCodexServiceTier?.toChatServiceTier() =
    when (this) {
        SetThreadModelRequestCodexServiceTier.FAST -> ChatArchiveChatThreadsItemServiceTier.PRIORITY
        SetThreadModelRequestCodexServiceTier.ULTRAFAST ->
            ChatArchiveChatThreadsItemServiceTier.ULTRAFAST
        null -> null
    }

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
