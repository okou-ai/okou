package ai.okou.android.state

import ai.okou.android.artifacts.ArtifactFilter
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableIntState
import androidx.compose.runtime.MutableState
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
    ReturnOnBack,
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
internal fun rememberUpdateWorkspaceState(): SaveableStateHolder = rememberSaveableStateHolder()

@Composable
internal fun rememberEarlierRepliesExpanded() = rememberSaveable { mutableStateOf(false) }

private const val MAX_SAVED_SEARCH_QUERY_CHARS = 256

internal data class SearchResultAnchor(val chatId: String, val offset: Int)

internal class ChatSearchState(
    query: TextFieldValue = TextFieldValue(),
    anchor: SearchResultAnchor? = null,
) {
    var query by mutableStateOf(query)
        private set

    val position = LazyListState()
    var pendingAnchor by mutableStateOf(anchor)
        private set

    fun edit(value: TextFieldValue) {
        if (query.text != value.text) {
            pendingAnchor = null
            position.requestScrollToItem(0)
        }
        query = value
    }

    fun reset() {
        pendingAnchor = null
        position.requestScrollToItem(0)
        query = TextFieldValue()
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

@Composable
internal fun rememberChatSearchState(): ChatSearchState =
    rememberSaveable(
        saver =
            listSaver<ChatSearchState, Any>(
                save = {
                    val query = it.query
                    if (query.text.length <= MAX_SAVED_SEARCH_QUERY_CHARS) {
                        val anchor = it.savedAnchor()
                        listOf(
                            query.text,
                            query.selection.start,
                            query.selection.end,
                            anchor?.chatId.orEmpty(),
                            anchor?.offset ?: 0,
                        )
                    } else emptyList()
                },
                restore = { (text, start, end, chatId, offset) ->
                    ChatSearchState(
                        TextFieldValue(text as String, TextRange(start as Int, end as Int)),
                        (chatId as String)
                            .takeIf { it.isNotEmpty() }
                            ?.let { SearchResultAnchor(it, offset as Int) },
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
)

internal data class ArtifactsDestination(val sourceId: String? = null)

@Composable
internal fun rememberWorkspaceNavigation(): MutableState<WorkspaceNavigation> =
    rememberSaveable(
        stateSaver =
            listSaver<WorkspaceNavigation, Any>(
                save = { navigation ->
                    val (kind, id) =
                        when (val target = navigation.target) {
                            WorkspaceTarget.List -> "list" to ""
                            is WorkspaceTarget.Chat -> "chat" to target.id
                            is WorkspaceTarget.NewChat -> "new" to target.projectId.orEmpty()
                        }
                    listOf(
                        kind,
                        id,
                        navigation.settings?.name.orEmpty(),
                        navigation.search.name,
                        navigation.artifacts != null,
                        navigation.artifacts?.sourceId.orEmpty(),
                    )
                },
                restore = { fields ->
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
                            ArtifactsDestination((fields.getOrNull(5) as? String)?.ifEmpty { null })
                        } else null
                    WorkspaceNavigation(
                        target,
                        destination,
                        search ?: SearchRoute.Closed,
                        artifacts,
                    )
                },
            )
    ) {
        mutableStateOf(WorkspaceNavigation())
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
