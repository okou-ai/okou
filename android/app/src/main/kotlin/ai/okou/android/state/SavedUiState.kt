package ai.okou.android.state

import ai.okou.android.artifacts.ArtifactFilter
import ai.okou.android.chat.ConversationAnchor
import ai.okou.android.chat.ConversationFindTarget
import ai.okou.android.chat.ConversationLinkPosition
import ai.okou.android.chat.ConversationLinkSource
import ai.okou.android.chat.WorkspaceSearchType
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableIntState
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.SaveableStateHolder
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue

/**
 * Saved values are restoration metadata. Documents and pending writes belong to their data owner.
 */
internal sealed interface WorkspaceTarget {
    data object List : WorkspaceTarget

    data class Chat(val id: String) : WorkspaceTarget

    data class NewChat(val projectId: String?) : WorkspaceTarget
}

internal enum class SettingsDestination {
    Overview,
    Instructions,
    ModelAccounts,
    CreditBalance,
    Account,
}

internal enum class SearchRoute {
    Closed,
    Open,
    OpenBeforeLink,
    ReturnOnBack;

    val isOpen: Boolean
        get() = this == Open || this == OpenBeforeLink
}

@Composable
internal fun rememberUpdateDetailsOpen(): MutableState<Boolean> = rememberSaveable {
    mutableStateOf(false)
}

@Composable
internal fun rememberSettingsFlag(): MutableState<Boolean> = rememberSaveable {
    mutableStateOf(false)
}

@Composable
internal fun rememberSettingsReturnFocus(): MutableState<SettingsDestination?> = rememberSaveable {
    mutableStateOf(null)
}

@Composable
internal fun rememberWorkspaceSwitchTarget(): MutableState<String?> = rememberSaveable {
    mutableStateOf(null)
}

@Composable
internal fun rememberConnectorsOpen(): MutableState<Boolean> = rememberSaveable {
    mutableStateOf(false)
}

internal class ConnectorDirectoryState(
    slug: String? = null,
    category: String? = null,
    connected: Boolean = false,
    query: TextFieldValue = TextFieldValue(),
) {
    var slug by mutableStateOf(slug)
    var category by mutableStateOf(category)
    var connected by mutableStateOf(connected)
    var query by mutableStateOf(query)
        private set

    var committedQuery by mutableStateOf(query)
        private set

    val hasPendingSearchInput: Boolean
        get() = query.composition != null && query.text != committedQuery.text

    fun editQuery(value: TextFieldValue) {
        query = value
        if (value.composition == null) committedQuery = value
    }
}

@Composable
internal fun rememberConnectorDirectory(): ConnectorDirectoryState =
    rememberSaveable(
        saver =
            listSaver<ConnectorDirectoryState, Any>(
                save = {
                    val query =
                        it.committedQuery.takeIf { value ->
                            value.text.length <= MAX_SAVED_SEARCH_QUERY_CHARS
                        } ?: TextFieldValue()
                    listOf(
                        it.slug.orEmpty(),
                        it.category.orEmpty(),
                        it.connected,
                        query.text,
                        query.selection.start,
                        query.selection.end,
                    )
                },
                restore = {
                    ConnectorDirectoryState(
                        (it[0] as String).ifEmpty { null },
                        (it[1] as String).ifEmpty { null },
                        it[2] as Boolean,
                        TextFieldValue(it[3] as String, TextRange(it[4] as Int, it[5] as Int)),
                    )
                },
            )
    ) {
        ConnectorDirectoryState()
    }

@Composable
internal fun rememberUpdateWorkspaceState(): SaveableStateHolder = rememberSaveableStateHolder()

@Composable
internal fun rememberEarlierRepliesExpanded() = rememberSaveable { mutableStateOf(false) }

@Composable
internal fun rememberSearchWorkflowId(): MutableState<String?> = rememberSaveable {
    mutableStateOf(null)
}

private const val MAX_SAVED_SEARCH_QUERY_CHARS = 256

internal data class SearchResultAnchor(val key: String, val offset: Int)

internal class ChatSearchState(
    query: TextFieldValue = TextFieldValue(),
    anchor: SearchResultAnchor? = null,
    type: WorkspaceSearchType = WorkspaceSearchType.All,
    focusedResult: String? = null,
) {
    private var committed = query
    var query by mutableStateOf(query)
        private set

    var keyword by mutableStateOf(query.text.trim())
        private set

    var type by mutableStateOf(type)
        private set

    val position = LazyListState()
    var pendingAnchor by mutableStateOf(anchor)
        private set

    var pendingFocus by mutableStateOf(focusedResult)
        private set

    fun edit(value: TextFieldValue) {
        query = value
        if (value.composition != null) return
        committed = value
        if (keyword != value.text.trim()) {
            keyword = value.text.trim()
            resetPosition()
        }
    }

    fun selectType(value: WorkspaceSearchType) {
        if (type == value) return
        type = value
        resetPosition()
    }

    fun clearQuery() = edit(TextFieldValue())

    fun returnToResult(key: String) {
        query = committed
        pendingAnchor = savedAnchor()
        pendingFocus = key
    }

    fun restoreFocus() {
        pendingFocus = null
    }

    fun savedQuery(): TextFieldValue = committed

    fun reset() {
        type = WorkspaceSearchType.All
        clearQuery()
        resetPosition()
    }

    private fun resetPosition() {
        pendingAnchor = null
        pendingFocus = null
        position.requestScrollToItem(0)
    }

    fun cancelComposition() {
        query = committed
    }

    fun restorePosition(index: Int?) {
        val anchor = pendingAnchor ?: return
        if (index != null) position.requestScrollToItem(index, anchor.offset)
        pendingAnchor = null
    }

    fun savedAnchor(): SearchResultAnchor? {
        pendingAnchor?.let {
            return it
        }
        return position.layoutInfo.visibleItemsInfo
            .firstOrNull { it.index == position.firstVisibleItemIndex }
            ?.let { item ->
                (item.key as? String)?.let {
                    SearchResultAnchor(it, position.firstVisibleItemScrollOffset)
                }
            }
    }
}

private class DisplayedSearchValue<T>(var value: T)

@Composable
internal fun <T> ChatSearchState.retainWhileComposing(value: T): T {
    val displayed = remember(this) { DisplayedSearchValue(value) }
    if (query.composition != null) return displayed.value
    // Keep the last rendered results if a refresh arrives in the same frame as an IME edit.
    SideEffect { displayed.value = value }
    return value
}

@Composable
internal fun rememberChatSearchState(): ChatSearchState =
    rememberSaveable(
        saver =
            listSaver<ChatSearchState, Any>(
                save = {
                    val query = it.savedQuery()
                    if (query.text.length <= MAX_SAVED_SEARCH_QUERY_CHARS) {
                        val anchor = it.savedAnchor()
                        listOf(
                            query.text,
                            query.selection.start,
                            query.selection.end,
                            anchor?.key.orEmpty(),
                            anchor?.offset ?: 0,
                            it.type.name,
                            it.pendingFocus.orEmpty(),
                        )
                    } else emptyList()
                },
                restore = { fields ->
                    val (text, start, end, key, offset) = fields
                    ChatSearchState(
                        TextFieldValue(text as String, TextRange(start as Int, end as Int)),
                        (key as String)
                            .takeIf { it.isNotEmpty() }
                            ?.let { SearchResultAnchor(it, offset as Int) },
                        WorkspaceSearchType.entries.firstOrNull { it.name == fields.getOrNull(5) }
                            ?: WorkspaceSearchType.All,
                        (fields.getOrNull(6) as? String)?.ifEmpty { null },
                    )
                },
            )
    ) {
        ChatSearchState()
    }

internal data class WorkspaceNavigation(
    val target: WorkspaceTarget = WorkspaceTarget.List,
    val settings: SettingsDestination? = null,
    val search: SearchRoute = SearchRoute.Closed,
    val artifacts: ArtifactsDestination? = null,
    val chatResourcesId: String? = null,
    val chatArtifactLink: String? = null,
    val chatArtifactFocusKey: String? = null,
    val messageSequence: Long? = null,
)

internal data class ArtifactsDestination(
    val sourceId: String? = null,
    val searchResultId: String? = null,
)

internal data class ConversationLinkReturn(
    val navigation: WorkspaceNavigation,
    val threadId: String,
    val source: ConversationLinkSource,
)

@Composable
internal fun rememberWorkspaceNavigation(): MutableState<WorkspaceNavigation> =
    rememberSaveable(
        stateSaver =
            listSaver<WorkspaceNavigation, Any>(
                save = { it.savedFields() },
                restore = ::restoreWorkspaceNavigation,
            )
    ) {
        mutableStateOf(WorkspaceNavigation())
    }

private fun WorkspaceNavigation.savedFields(): List<Any> {
    val (kind, id) =
        when (val destination = target) {
            WorkspaceTarget.List -> "list" to ""
            is WorkspaceTarget.Chat -> "chat" to destination.id
            is WorkspaceTarget.NewChat -> "new" to destination.projectId.orEmpty()
        }
    return listOf(
        kind,
        id,
        settings?.name.orEmpty(),
        search.name,
        artifacts != null,
        artifacts?.sourceId.orEmpty(),
        chatResourcesId.orEmpty(),
        chatArtifactLink.orEmpty(),
        chatArtifactFocusKey.orEmpty(),
        messageSequence ?: 0L,
        artifacts?.searchResultId.orEmpty(),
    )
}

private fun restoreWorkspaceNavigation(fields: List<Any?>): WorkspaceNavigation {
    val (kind, id, settings) = fields
    val target =
        when (kind) {
            "chat" -> WorkspaceTarget.Chat(id as String)
            "new" -> WorkspaceTarget.NewChat((id as String).ifEmpty { null })
            else -> WorkspaceTarget.List
        }
    // Earlier versions saved only whether Settings was open.
    val destination =
        if (settings == true) SettingsDestination.Overview
        else SettingsDestination.entries.firstOrNull { it.name == settings }
    val search = SearchRoute.entries.firstOrNull { it.name == fields.getOrNull(3) }
    val artifacts =
        if (fields.getOrNull(4) == true) {
            ArtifactsDestination(
                sourceId = (fields.getOrNull(5) as? String)?.ifEmpty { null },
                searchResultId = (fields.getOrNull(10) as? String)?.ifEmpty { null },
            )
        } else null
    return WorkspaceNavigation(
        target,
        destination,
        search ?: SearchRoute.Closed,
        artifacts,
        (fields.getOrNull(6) as? String)?.ifEmpty { null },
        (fields.getOrNull(7) as? String)?.ifEmpty { null },
        (fields.getOrNull(8) as? String)?.ifEmpty { null },
        (fields.getOrNull(9) as? Long)?.takeIf { it > 0 },
    )
}

@Composable
internal fun rememberConversationLinkReturns(): MutableState<List<ConversationLinkReturn>> =
    rememberSaveable(
        stateSaver =
            listSaver<List<ConversationLinkReturn>, Any>(
                save = { returns ->
                    returns.map { entry ->
                        arrayListOf(
                            ArrayList(entry.navigation.savedFields()),
                            entry.threadId,
                            entry.source.key,
                            entry.source.anchor?.eventId.orEmpty(),
                            entry.source.anchor?.offsetDp ?: 0f,
                        )
                    }
                },
                restore = { returns ->
                    returns.map { saved ->
                        val (navigation, threadId, key, anchorId, offset) = saved as List<*>
                        ConversationLinkReturn(
                            restoreWorkspaceNavigation(navigation as List<*>),
                            threadId as String,
                            ConversationLinkSource(
                                key as String,
                                (anchorId as String).takeIf(String::isNotEmpty)?.let {
                                    ConversationAnchor(it, offset as Float)
                                },
                            ),
                        )
                    }
                },
            )
    ) {
        mutableStateOf(emptyList())
    }

private const val MAX_SAVED_CONVERSATION_EVENT_ID_CHARS = 36

@Composable
internal fun rememberConversationLinkPosition(): MutableState<ConversationLinkPosition?> =
    rememberSaveable(
        stateSaver =
            listSaver<ConversationLinkPosition?, Any>(
                save = { position ->
                    val target = position?.destination
                    // Chat event and run IDs are UUIDs. Link fragments arrive as text.
                    if (
                        target == null ||
                            target.positioned ||
                            target.id.length > MAX_SAVED_CONVERSATION_EVENT_ID_CHARS
                    ) {
                        emptyList()
                    } else listOf(target.id, target.isRun)
                },
                restore = { (eventId, isRun) ->
                    ConversationLinkPosition(
                        destination =
                            ConversationFindTarget(eventId as String, null, isRun as Boolean)
                    )
                },
            )
    ) {
        mutableStateOf(null)
    }

internal class ArtifactPageState(
    filter: ArtifactFilter = ArtifactFilter.All,
    selectedId: String? = null,
    restoreRow: String? = null,
    restoreSource: Boolean = false,
    pickerArtifactId: String? = null,
) {
    var filter by mutableStateOf(filter)
    var selectedId by mutableStateOf(selectedId)
    var restoreRow by mutableStateOf(restoreRow)
    var restoreSource by mutableStateOf(restoreSource)
    var pickerArtifactId by mutableStateOf(pickerArtifactId)
}

@Composable
internal fun rememberArtifactPageState(): ArtifactPageState =
    rememberSaveable(
        saver =
            listSaver<ArtifactPageState, Any>(
                save = {
                    listOf(
                        it.filter.name,
                        it.selectedId.orEmpty(),
                        it.restoreRow.orEmpty(),
                        it.restoreSource,
                        it.pickerArtifactId.orEmpty(),
                    )
                },
                restore = { (filter, selectedId, restoreRow, restoreSource, pickerArtifactId) ->
                    ArtifactPageState(
                        ArtifactFilter.entries.firstOrNull { it.name == filter }
                            ?: ArtifactFilter.All,
                        (selectedId as String).ifEmpty { null },
                        (restoreRow as String).ifEmpty { null },
                        restoreSource as Boolean,
                        (pickerArtifactId as String).ifEmpty { null },
                    )
                },
            )
    ) {
        ArtifactPageState()
    }

@Composable
internal fun rememberArtifactPageHolder(): SaveableStateHolder = rememberSaveableStateHolder()

@Composable
internal fun rememberArtifactWebScroll(): MutableIntState = rememberSaveable {
    mutableIntStateOf(0)
}

internal enum class WorkflowsMode {
    Closed,
    Directory,
    Chat,
}

internal enum class WorkflowTab {
    Instructions,
    Automations,
    History,
}

internal enum class WorkflowScope {
    All,
    Private,
    Shared,
}

internal data class WorkflowsRoute(
    val mode: WorkflowsMode = WorkflowsMode.Closed,
    val id: String? = null,
    val tab: WorkflowTab = WorkflowTab.Instructions,
    val scope: WorkflowScope = WorkflowScope.All,
)

@Composable
internal fun rememberWorkflowsRoute(): MutableState<WorkflowsRoute> =
    rememberSaveable(
        stateSaver =
            listSaver<WorkflowsRoute, String>(
                save = { listOf(it.mode.name, it.id.orEmpty(), it.tab.name, it.scope.name) },
                restore = { (mode, id, tab, scope) ->
                    WorkflowsRoute(
                        WorkflowsMode.valueOf(mode),
                        id.ifEmpty { null },
                        WorkflowTab.valueOf(tab),
                        WorkflowScope.valueOf(scope),
                    )
                },
            )
    ) {
        mutableStateOf(WorkflowsRoute())
    }

@Composable
internal fun rememberWorkflowDiscardConfirmation(
    workflowId: String?,
    editing: Boolean,
): MutableState<Boolean> = rememberSaveable(workflowId, editing) { mutableStateOf(false) }

internal class SavedUiIds(private val state: MutableState<List<String>>, private val limit: Int) {
    fun record(id: String): List<String> {
        val next = (state.value - id) + id
        val evicted = next.dropLast(limit)
        state.value = next.takeLast(limit)
        return evicted
    }
}

@Composable
private fun rememberUiIds(limit: Int): SavedUiIds {
    val state = rememberSaveable { mutableStateOf(emptyList<String>()) }
    return remember(state, limit) { SavedUiIds(state, limit) }
}

internal class ConversationUiState(
    private val holder: SaveableStateHolder,
    private val recent: SavedUiIds,
) {
    fun open(id: String) {
        recent.record(id).forEach(holder::removeState)
    }

    @Composable
    fun Content(id: String, content: @Composable () -> Unit) {
        holder.SaveableStateProvider(id, content)
    }
}

@Composable
internal fun rememberConversationUiState(): ConversationUiState {
    val holder = rememberSaveableStateHolder()
    val recent = rememberUiIds(SavedStatePolicy.CONVERSATION_STATES)
    return remember(holder, recent) { ConversationUiState(holder, recent) }
}

internal class JournalEditor(val value: TextFieldValue, val edit: (TextFieldValue) -> Unit)

/** Wait for journal hydration before consuming the restored native selection. */
@Composable
internal fun rememberJournalEditor(
    text: String?,
    target: Any = Unit,
    replacementSelection: TextRange = TextRange(text?.length ?: 0),
): JournalEditor {
    if (text == null) return JournalEditor(TextFieldValue(), {})
    var native by
        rememberSaveable(
            target,
            stateSaver =
                listSaver<TextFieldValue, Int>(
                    save = {
                        val selection = if (it.text == text) it.selection else TextRange.Zero
                        listOf(selection.start, selection.end)
                    },
                    restore = { TextFieldValue(text, TextRange(it[0], it[1])) },
                ),
        ) {
            mutableStateOf(TextFieldValue(text, replacementSelection))
        }
    val presented = if (native.text == text) native else TextFieldValue(text, replacementSelection)
    return JournalEditor(presented) { native = it }
}
