package ai.okou.android.state

import ai.okou.android.DirectoryReturnFocus
import ai.okou.android.ReadFailureAnnouncement
import ai.okou.android.artifacts.ArtifactFilter
import ai.okou.android.artifacts.ExternalImagePreviewPrefix
import ai.okou.android.chat.ConversationAnchor
import ai.okou.android.chat.ConversationCodeTarget
import ai.okou.android.chat.ConversationCodeVisit
import ai.okou.android.chat.ConversationFindTarget
import ai.okou.android.chat.ConversationLinkPosition
import ai.okou.android.chat.ConversationLinkSource
import ai.okou.android.chat.SearchMessageAnchor
import ai.okou.android.chat.WorkspaceSearchType
import ai.okou.android.hasPendingSearchText
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableIntState
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.SaveableStateHolder
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.platform.LocalInputModeManager
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
    ProactiveServices,
    BuiltInTools,
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
internal fun rememberSettingsChoiceFocus(): MutableState<String?> = rememberSaveable {
    mutableStateOf(null)
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
internal fun rememberWorkspacePresentationState(): SaveableStateHolder =
    rememberSaveableStateHolder()

@Composable
internal fun rememberConnectorsOpen(): MutableState<Boolean> = rememberSaveable {
    mutableStateOf(false)
}

@Composable
internal fun rememberConversationQueueFlag(threadId: String?): MutableState<Boolean> =
    key(threadId) { rememberSaveable { mutableStateOf(false) } }

internal data class AttachmentPickerSelection(
    val draftKey: String,
    val targetKey: String,
    val replacing: String?,
)

@Composable
internal fun rememberAttachmentPickerSelection(): MutableState<AttachmentPickerSelection?> =
    rememberSaveable(
        stateSaver =
            listSaver<AttachmentPickerSelection?, String>(
                save = { selection ->
                    if (selection == null) emptyList()
                    else
                        listOf(
                            selection.draftKey,
                            selection.targetKey,
                            selection.replacing.orEmpty(),
                        )
                },
                restore = { values ->
                    values.firstOrNull()?.let {
                        AttachmentPickerSelection(it, values[1], values[2].ifEmpty { null })
                    }
                },
            ),
    ) {
        mutableStateOf(null)
    }

@Composable
internal fun rememberDraftAttachmentPreview(): MutableState<String?> = rememberSaveable {
    mutableStateOf(null)
}

@Composable
internal fun rememberDraftImageSaveTarget(): MutableState<String?> = rememberSaveable {
    mutableStateOf(null)
}

@Composable
internal fun rememberDraftAttachmentsOpen(): MutableState<Boolean> = rememberSaveable {
    mutableStateOf(false)
}

internal data class ChatConnectorVisit(
    val composerKey: String,
    val slug: String?,
    val accountId: String?,
)

@Composable
internal fun rememberChatConnectorVisit(): MutableState<ChatConnectorVisit?> =
    rememberSaveable(
        stateSaver =
            listSaver<ChatConnectorVisit?, String>(
                save = { visit ->
                    if (visit == null) emptyList()
                    else listOf(visit.composerKey, visit.slug.orEmpty(), visit.accountId.orEmpty())
                },
                restore = { values ->
                    values.firstOrNull()?.let {
                        ChatConnectorVisit(
                            it,
                            values[1].ifEmpty { null },
                            values[2].ifEmpty { null },
                        )
                    }
                },
            ),
    ) {
        mutableStateOf(null)
    }

internal enum class ComposerOptionsPage {
    Closed,
    Options,
    Connectors,
    ConnectorAccounts,
    Model,
    Workflow,
}

internal data class ComposerOptionsPresentation(
    val page: ComposerOptionsPage = ComposerOptionsPage.Closed,
    val restoreEditor: Boolean = false,
    val restoreKeyboard: Boolean = false,
    val returnAccount: String? = null,
    val connectorSlug: String? = null,
)

@Composable
internal fun rememberComposerOptions(targetKey: String): MutableState<ComposerOptionsPresentation> =
    rememberSaveable(
        targetKey,
        stateSaver =
            listSaver<ComposerOptionsPresentation, Any>(
                save = { value ->
                    listOf(
                        value.page.name,
                        value.restoreEditor,
                        value.restoreKeyboard,
                        value.returnAccount ?: "-",
                        value.connectorSlug.orEmpty(),
                    )
                },
                restore = { values ->
                    ComposerOptionsPresentation(
                        ComposerOptionsPage.valueOf(values[0] as String),
                        values[1] as Boolean,
                        values[2] as Boolean,
                        (values[3] as String).takeIf { it != "-" },
                        (values.getOrNull(4) as? String)?.takeIf { it.isNotEmpty() },
                    )
                },
            ),
    ) {
        mutableStateOf(ComposerOptionsPresentation())
    }

internal data class WorkflowConnectorVisit(val slug: String, val ruleId: String?)

@Composable
internal fun rememberWorkflowConnectorVisit(): MutableState<WorkflowConnectorVisit?> =
    rememberSaveable(
        stateSaver =
            listSaver<WorkflowConnectorVisit?, String>(
                save = { visit ->
                    if (visit == null) emptyList() else listOf(visit.slug, visit.ruleId.orEmpty())
                },
                restore = { values ->
                    values.firstOrNull()?.let {
                        WorkflowConnectorVisit(it, values[1].ifEmpty { null })
                    }
                },
            ),
    ) {
        mutableStateOf(null)
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

    fun editQuery(value: TextFieldValue) {
        query = value
        if (value.composition == null) committedQuery = value
    }
}

@Composable
internal fun rememberConnectorDirectory(initialSlug: String?): ConnectorDirectoryState =
    rememberSaveable(
        initialSlug,
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
            ),
    ) {
        ConnectorDirectoryState(slug = initialSlug)
    }

@Composable
internal fun rememberUpdateWorkspaceState(): SaveableStateHolder = rememberSaveableStateHolder()

@Composable
internal fun rememberWorkflowPageState(): SaveableStateHolder = rememberSaveableStateHolder()

@Composable
internal fun rememberWorkflowEditorReturnFocus(
    workflowId: String?,
    tab: WorkflowTab,
): MutableState<String?> = rememberSaveable(workflowId, tab) { mutableStateOf(null) }

@Composable
internal fun rememberEarlierRepliesExpanded() = rememberSaveable { mutableStateOf(false) }

@Composable
internal fun rememberSearchWorkflowId(search: ChatSearchState): MutableState<String?> =
    rememberSaveable(
        stateSaver =
            Saver<String?, String>(
                save = { it },
                restore = { id -> id.takeIf { search.keyword.isNotEmpty() } },
            ),
    ) {
        mutableStateOf(null)
    }

private const val MAX_SAVED_SEARCH_QUERY_CHARS = 256

internal data class SearchResultAnchor(val key: String, val offset: Int, val index: Int)

internal class ChatSearchState(
    query: TextFieldValue = TextFieldValue(),
    anchor: SearchResultAnchor? = null,
    type: WorkspaceSearchType = WorkspaceSearchType.All,
) {
    private var committed = query
    var query by mutableStateOf(query)
        private set

    var keyword by mutableStateOf(query.text.trim())
        private set

    val hasPendingInput: Boolean
        get() = hasPendingSearchText(query.text, query.composition, keyword)

    var type by mutableStateOf(type)
        private set

    val position = LazyListState()
    var pendingAnchor by mutableStateOf(anchor)
        private set

    val returnFocus = DirectoryReturnFocus()

    val readFailureAnnouncement = ReadFailureAnnouncement()

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

    fun returnToResult(key: String, inputMode: InputMode) {
        query = committed
        pendingAnchor = savedAnchor()
        returnFocus.returningFrom(key, inputMode, keyboardOnly = false)
    }

    fun savedQuery(): TextFieldValue = committed

    fun reset() {
        type = WorkspaceSearchType.All
        clearQuery()
        readFailureAnnouncement.reset()
        resetPosition()
    }

    private fun resetPosition() {
        pendingAnchor = null
        returnFocus.cancel()
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
                    SearchResultAnchor(it, position.firstVisibleItemScrollOffset, item.index)
                }
            }
    }
}

@Composable
internal fun rememberChatSearchState(): ChatSearchState {
    val inputMode = LocalInputModeManager.current
    return rememberSaveable(
        saver =
            listSaver<ChatSearchState, Any>(
                save = {
                    val query = it.savedQuery()
                    if (query.text.length <= MAX_SAVED_SEARCH_QUERY_CHARS) {
                        val anchor = it.savedAnchor()
                        val request = it.returnFocus.pending
                        listOf(
                            query.text,
                            query.selection.start,
                            query.selection.end,
                            anchor?.key.orEmpty(),
                            anchor?.offset ?: 0,
                            it.type.name,
                            request?.rowKey.orEmpty(),
                            anchor?.index ?: 0,
                            request?.inputMode == InputMode.Keyboard,
                        )
                    } else emptyList()
                },
                restore = { fields ->
                    val (text, start, end, key, offset) = fields
                    ChatSearchState(
                            TextFieldValue(text as String, TextRange(start as Int, end as Int)),
                            (key as String)
                                .takeIf { it.isNotEmpty() }
                                ?.let {
                                    SearchResultAnchor(
                                        it,
                                        offset as Int,
                                        fields.getOrNull(7) as? Int ?: 0,
                                    )
                                },
                            WorkspaceSearchType.entries.firstOrNull {
                                it.name == fields.getOrNull(5)
                            } ?: WorkspaceSearchType.All,
                        )
                        .also { search ->
                            val mode =
                                when (fields.getOrNull(8) as? Boolean) {
                                    true -> InputMode.Keyboard
                                    false -> InputMode.Touch
                                    null -> inputMode.inputMode
                                }
                            val target = (fields.getOrNull(6) as? String)?.ifEmpty { null }
                            search.returnFocus.returningFrom(target, mode, keyboardOnly = false)
                        }
                },
            ),
    ) {
        ChatSearchState()
    }
}

internal data class WorkspaceNavigation(
    val target: WorkspaceTarget = WorkspaceTarget.List,
    val settings: SettingsDestination? = null,
    val search: SearchRoute = SearchRoute.Closed,
    val artifacts: ArtifactsDestination? = null,
    val chatResourcesId: String? = null,
    val chatArtifactLink: String? = null,
    val chatArtifactFocusKey: String? = null,
    val searchMessageAnchor: SearchMessageAnchor? = null,
)

internal const val RetainedExternalImagePreview = "external-image"

// Only the in-memory preview owner retains the external URL across recreation.
private fun String.restorableArtifactLink() =
    if (startsWith(ExternalImagePreviewPrefix)) RetainedExternalImagePreview else this

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
            ),
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
        chatArtifactLink?.restorableArtifactLink().orEmpty(),
        chatArtifactFocusKey.orEmpty(),
        searchMessageAnchor?.sequence ?: 0L,
        artifacts?.searchResultId.orEmpty(),
        searchMessageAnchor?.range?.first ?: -1,
        searchMessageAnchor?.range?.last ?: -1,
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
    val searchMessageAnchor =
        (fields.getOrNull(9) as? Long)
            ?.takeIf { it > 0 }
            ?.let { sequence ->
                val start = fields.getOrNull(11) as? Int ?: -1
                val end = fields.getOrNull(12) as? Int ?: -1
                SearchMessageAnchor(sequence, if (start >= 0 && end >= start) start..end else null)
            }
    return WorkspaceNavigation(
        target,
        destination,
        search ?: SearchRoute.Closed,
        artifacts,
        (fields.getOrNull(6) as? String)?.ifEmpty { null },
        (fields.getOrNull(7) as? String)?.ifEmpty { null }?.restorableArtifactLink(),
        (fields.getOrNull(8) as? String)?.ifEmpty { null },
        searchMessageAnchor,
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
            ),
    ) {
        mutableStateOf(emptyList())
    }

private const val MAX_SAVED_CONVERSATION_EVENT_ID_CHARS = 36

@Composable
internal fun rememberConversationCodeVisit(): MutableState<ConversationCodeVisit?> =
    rememberSaveable(
        stateSaver =
            listSaver<ConversationCodeVisit?, Any>(
                save = { visit ->
                    val target = visit?.target
                    if (
                        visit == null ||
                            target == null ||
                            target.messageId.length > MAX_SAVED_CONVERSATION_EVENT_ID_CHARS ||
                            target.path.length > 512
                    ) {
                        emptyList()
                    } else
                        listOf(
                            visit.threadId,
                            target.messageId,
                            target.bodyIndex,
                            target.path,
                            visit.anchor?.eventId.orEmpty(),
                            visit.anchor?.offsetDp ?: 0f,
                            visit.previewOffsetPx,
                            visit.expanded,
                        )
                },
                restore = { fields ->
                    ConversationCodeVisit(
                        fields[0] as String,
                        ConversationCodeTarget(
                            fields[1] as String,
                            fields[2] as Int,
                            fields[3] as String,
                        ),
                        (fields[4] as String).takeIf(String::isNotEmpty)?.let {
                            ConversationAnchor(it, fields[5] as Float)
                        },
                        fields[6] as Int,
                        fields[7] as Boolean,
                    )
                },
            ),
    ) {
        mutableStateOf(null)
    }

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
                            ConversationFindTarget(eventId as String, null, isRun as Boolean),
                    )
                },
            ),
    ) {
        mutableStateOf(null)
    }

internal class ArtifactPageState(
    filter: ArtifactFilter = ArtifactFilter.All,
    selectedId: String? = null,
    restoreSource: Boolean = false,
    pickerArtifactId: String? = null,
    selectedRowIndex: Int? = null,
) {
    var filter by mutableStateOf(filter)
    var selectedId by mutableStateOf(selectedId)
    var restoreSource by mutableStateOf(restoreSource)
    var pickerArtifactId by mutableStateOf(pickerArtifactId)
    var selectedRowIndex by mutableStateOf(selectedRowIndex)
}

@Composable
internal fun rememberArtifactPageState(): ArtifactPageState =
    rememberSaveable(
        saver =
            listSaver<ArtifactPageState, Any>(
                save = {
                    listOfNotNull(
                        it.filter.name,
                        it.selectedId.orEmpty(),
                        "", // Former pending row slot. Keep the following fields at their saved
                        // indices.
                        it.restoreSource,
                        it.pickerArtifactId.orEmpty(),
                        it.selectedRowIndex,
                    )
                },
                restore = { saved ->
                    val (filter, selectedId, _, restoreSource, pickerArtifactId) = saved
                    ArtifactPageState(
                        ArtifactFilter.entries.firstOrNull { it.name == filter }
                            ?: ArtifactFilter.All,
                        (selectedId as String).ifEmpty { null },
                        restoreSource as Boolean,
                        (pickerArtifactId as String).ifEmpty { null },
                        selectedRowIndex = saved.getOrNull(5) as Int?,
                    )
                },
            ),
    ) {
        ArtifactPageState()
    }

@Composable
internal fun rememberArtifactPageHolder(): SaveableStateHolder = rememberSaveableStateHolder()

@Composable
internal fun rememberImageViewerExpanded(): MutableState<Boolean> = rememberSaveable {
    mutableStateOf(false)
}

@Composable
internal fun rememberArtifactImageViewerState(
    currentViewpoint: () -> ArtifactImageViewpoint?,
): ArtifactImageViewerState =
    rememberSaveable(
        saver =
            listSaver<ArtifactImageViewerState, Any>(
                save = { view ->
                    val point = view.pendingViewpoint ?: currentViewpoint()
                    if (point == null) listOf(view.expanded)
                    else listOf(view.expanded, point.scale, point.centerX, point.centerY)
                },
                restore = { values ->
                    val expanded = values.first() as? Boolean
                    if (expanded == null) {
                        // Earlier builds saved scale and translation before the expanded flag.
                        ArtifactImageViewerState(
                            expanded = values.getOrNull(3) as? Boolean ?: false,
                        )
                    } else {
                        val point =
                            if (values.size == 4)
                                ArtifactImageViewpoint(
                                    values[1] as Float,
                                    values[2] as Float,
                                    values[3] as Float,
                                )
                            else null
                        ArtifactImageViewerState(expanded, point)
                    }
                },
            ),
    ) {
        ArtifactImageViewerState()
    }

internal data class ArtifactImageViewpoint(val scale: Float, val centerX: Float, val centerY: Float)

internal class ArtifactImageViewerState(
    expanded: Boolean = false,
    pendingViewpoint: ArtifactImageViewpoint? = null,
) {
    var expanded by mutableStateOf(expanded)
    var pendingViewpoint by mutableStateOf(pendingViewpoint)
}

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

internal enum class WorkflowDraftAction {
    Create,
    Use,
}

internal data class WorkflowDraftReturn(val action: WorkflowDraftAction, val restoreFocus: Boolean)

internal data class WorkflowsRoute(
    val mode: WorkflowsMode = WorkflowsMode.Closed,
    val id: String? = null,
    val tab: WorkflowTab = WorkflowTab.Instructions,
    val scope: WorkflowScope = WorkflowScope.All,
    val draftReturn: WorkflowDraftReturn? = null,
    val resourceReturnRow: String? = null,
)

@Composable
internal fun rememberWorkflowsRoute(): MutableState<WorkflowsRoute> =
    rememberSaveable(
        stateSaver =
            listSaver<WorkflowsRoute, String>(
                save = {
                    listOf(
                        it.mode.name,
                        it.id.orEmpty(),
                        it.tab.name,
                        it.scope.name,
                        it.draftReturn?.action?.name.orEmpty(),
                        (it.draftReturn?.restoreFocus == true).toString(),
                        it.resourceReturnRow.orEmpty(),
                    )
                },
                restore = { saved ->
                    val (mode, id, tab, scope) = saved
                    WorkflowsRoute(
                        WorkflowsMode.valueOf(mode),
                        id.ifEmpty { null },
                        WorkflowTab.valueOf(tab),
                        WorkflowScope.valueOf(scope),
                        saved.getOrNull(4)?.takeIf(String::isNotEmpty)?.let { action ->
                            WorkflowDraftReturn(
                                WorkflowDraftAction.valueOf(action),
                                saved.getOrNull(5).toBoolean(),
                            )
                        },
                        resourceReturnRow = saved.getOrNull(6)?.ifEmpty { null },
                    )
                },
            ),
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

internal class JournalEditor(
    val value: TextFieldValue,
    private val updateNative: (TextFieldValue) -> Unit,
) {
    private var lastInputText = value.text

    fun edit(input: TextFieldValue): Boolean {
        // Several input events can arrive before the next composition.
        val changed = input.text != lastInputText
        lastInputText = input.text
        updateNative(input)
        return changed
    }
}

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

@Composable
internal fun rememberJournalTextField(text: String): TextFieldState =
    rememberSaveable(
        saver =
            listSaver(
                save = { listOf(it.selection.start, it.selection.end) },
                restore = {
                    TextFieldState(
                        text,
                        TextRange(it[0].coerceIn(0, text.length), it[1].coerceIn(0, text.length)),
                    )
                },
            ),
    ) {
        TextFieldState(text, TextRange.Zero)
    }
