package ai.okou.android.artifacts

import kotlinx.serialization.Serializable

@Serializable
internal data class RelatedChatResource(
    val threadId: String,
    val title: String?,
    val lastActivityAt: String,
    val available: Boolean,
)

@Serializable
internal data class ConfirmedRelatedChatRead(
    val items: List<RelatedChatResource>,
    val confirmedAt: Long,
)

@Serializable
internal data class ConfirmedRelatedChats(
    val created: ConfirmedRelatedChatRead? = null,
    val communicating: ConfirmedRelatedChatRead? = null,
) {
    val oldestConfirmation: Long?
        get() = listOfNotNull(created?.confirmedAt, communicating?.confirmedAt).minOrNull()

    fun rows(): List<RelatedChatResource> {
        val grouped =
            (created?.items.orEmpty() + communicating?.items.orEmpty()).groupBy { it.threadId }
        return grouped.values
            .mapNotNull { entries ->
                if (entries.any { !it.available }) null else entries.maxBy { it.lastActivityAt }
            }
            .sortedWith(
                compareByDescending<RelatedChatResource> { it.lastActivityAt }
                    .thenBy { it.threadId },
            )
    }
}

internal data class RelatedChatResourcesState(
    val confirmed: ConfirmedRelatedChats? = null,
    val failure: RelatedChatReadFailure? = null,
    val checking: Boolean = false,
    val syncingStale: Boolean = false,
)

internal enum class RelatedChatReadFailure {
    Temporary,
    AccessLost,
}
