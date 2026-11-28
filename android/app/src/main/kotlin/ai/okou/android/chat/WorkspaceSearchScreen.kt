package ai.okou.android.chat

import ai.okou.android.ContentReadFailure
import ai.okou.android.ContentReadFeedbackDelayMillis
import ai.okou.android.ContentReadProgress
import ai.okou.android.R
import ai.okou.android.WorkspaceFeedbackHost
import ai.okou.android.WorkspaceFilterRow
import ai.okou.android.WorkspaceSearchGroupHeading
import ai.okou.android.WorkspaceSearchInput
import ai.okou.android.WorkspaceSearchToolbar
import ai.okou.android.artifacts.label
import ai.okou.android.observeReturnFocus
import ai.okou.android.rememberContentReadFeedbackAfter
import ai.okou.android.rememberReadFailureFeedback
import ai.okou.android.retainSearchResultsWhileComposing
import ai.okou.android.searchClearAction
import ai.okou.android.state.ChatSearchState
import ai.okou.android.workspaceSearchControlHeight
import ai.okou.android.workspaceSearchFocusOutline
import ai.okou.android.workspaceSearchSecondaryStyle
import androidx.annotation.StringRes
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

private val searchMatchWeight = FontWeight(650)

private data class SearchSources(
    val chats: ChatListUiState,
    val remote: WorkspaceSearchResults?,
    val workflows: SearchRead<SearchWorkflowHit>?,
    val workspacePreparation: SearchRead<Nothing>?,
    val recentlyOpened: List<String>,
)

@Composable
internal fun WorkspaceSearchScreen(
    state: ChatListUiState,
    search: ChatSearchState,
    widthDp: Int,
    listWidth: Int?,
    focusOnEntry: Boolean,
    onFocused: () -> Unit,
    onClose: () -> Unit,
    onOpen: (ConfirmedChat) -> Unit,
    resolveMessageChats: suspend (Set<String>) -> Set<String> = { it },
    remote: WorkspaceSearchResults? = null,
    workflowResults: SearchRead<SearchWorkflowHit>? = null,
    workspacePreparation: SearchRead<Nothing>? = null,
    recentlyOpened: List<String> = emptyList(),
    onOpenMessage: (SearchMessageHit) -> Unit = {},
    restoreResultFocus: Boolean = true,
    onOpenWorkflow: ((SearchWorkflowHit) -> Unit)? = null,
    onOpenArtifact: ((SearchArtifactHit) -> Unit)? = null,
    onMoreArtifacts: (String, String) -> Unit = { _, _ -> },
    onInputFocusGained: () -> Unit = {},
) {
    val query = search.query
    val incomingResults =
        SearchSources(state, remote, workflowResults, workspacePreparation, recentlyOpened)
    val (resultList, resultRemote, resultWorkflows, resultPreparation, resultRecents) =
        key(
            search,
            onOpenWorkflow != null,
            onOpenArtifact != null,
            remote?.messages == SearchRead.AccessLost,
            remote?.artifacts == SearchRead.AccessLost,
            workflowResults == SearchRead.AccessLost,
        ) {
            retainSearchResultsWhileComposing(incomingResults, search.hasPendingInput)
        }
    val colors = MaterialTheme.colorScheme
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    val inputFocus = remember { FocusRequester() }
    var inputFocused by remember { mutableStateOf(false) }
    LaunchedEffect(focusOnEntry) {
        if (focusOnEntry) {
            inputFocus.requestFocus()
            keyboard?.show()
            onFocused()
        }
    }
    val searchLabel = stringResource(R.string.chat_search_workspace)
    val contentWidth = Modifier.widthIn(max = 720.dp).fillMaxWidth()
    val typeFocus = remember { WorkspaceSearchType.entries.associateWith { FocusRequester() } }
    fun selectType(type: WorkspaceSearchType) {
        if (inputFocused) {
            focus.clearFocus()
            keyboard?.hide()
        }
        search.selectType(type)
    }

    Column(
        Modifier.fillMaxSize()
            .imePadding()
            .observeReturnFocus(search.returnFocus, active = restoreResultFocus)
            .testTag("chat_search"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        WorkspaceSearchToolbar(
            widthDp,
            listWidth,
            leading = {
                CompositionLocalProvider(
                    LocalMinimumInteractiveComponentSize provides workspaceSearchControlHeight(),
                ) {
                    IconButton(
                        onClick = onClose,
                        modifier = Modifier.workspaceSearchFocusOutline(CircleShape),
                    ) {
                        Icon(
                            painterResource(R.drawable.ic_arrow_back),
                            stringResource(R.string.back),
                            tint = colors.onSurface,
                        )
                    }
                }
            },
            field = { fieldModifier ->
                WorkspaceSearchInput(
                    value = query,
                    onValueChange = search::edit,
                    label = searchLabel,
                    onClear = searchClearAction(inputFocus, search::clearQuery),
                    modifier =
                        fieldModifier
                            .focusRequester(inputFocus)
                            .onFocusChanged {
                                inputFocused = it.isFocused
                                if (it.isFocused) onInputFocusGained()
                                else search.cancelComposition()
                            }
                            .testTag("chat_search_query"),
                )
            },
        )
        SearchTypes(search.type, typeFocus, contentWidth, ::selectType)
        SearchResults(
            resultList,
            search,
            resultRemote,
            resultWorkflows,
            resultPreparation,
            resultRecents,
            contentWidth.weight(1f),
            onOpen,
            onOpenMessage,
            onOpenWorkflow,
            onOpenArtifact,
            onMoreArtifacts,
            resolveMessageChats,
            restoreResultFocus,
            onSelectType = { type ->
                selectType(type)
                typeFocus.getValue(type).requestFocus()
            },
        )
    }
}

@Composable
private fun SearchTypes(
    selectedType: WorkspaceSearchType,
    typeFocus: Map<WorkspaceSearchType, FocusRequester>,
    modifier: Modifier,
    onSelect: (WorkspaceSearchType) -> Unit,
) =
    WorkspaceFilterRow(
        WorkspaceSearchType.entries,
        selectedType,
        Role.Tab,
        label = { stringResource(it.label) },
        modifier = modifier.padding(start = 16.dp, end = 16.dp, bottom = 6.dp),
        optionModifier = {
            Modifier.focusRequester(typeFocus.getValue(it)).testTag("search_type_${it.name}")
        },
        onSelect = onSelect,
    )

private const val GroupKeyPrefix = "group:"
private const val MessageKeyPrefix = "message:"
private const val WorkflowKeyPrefix = "workflow:"
private const val ArtifactKeyPrefix = "artifact:"

private fun searchResultType(key: String): WorkspaceSearchType =
    when {
        key.startsWith(GroupKeyPrefix) -> {
            val name = key.removePrefix(GroupKeyPrefix)
            WorkspaceSearchType.entries.firstOrNull { it.name == name } ?: WorkspaceSearchType.All
        }
        key.startsWith(MessageKeyPrefix) -> WorkspaceSearchType.Messages
        key.startsWith(WorkflowKeyPrefix) -> WorkspaceSearchType.Workflows
        key.startsWith(ArtifactKeyPrefix) -> WorkspaceSearchType.Artifacts
        else -> WorkspaceSearchType.Chats
    }

private val SearchRead<*>?.isReading: Boolean
    get() =
        this == SearchRead.Loading ||
            this == SearchRead.Retrying ||
            this is SearchRead.Ready && refresh == SearchRefresh.Reading

private val SearchRead<*>?.isPending: Boolean
    get() =
        isReading ||
            this == SearchRead.Scheduled ||
            this is SearchRead.Ready && refresh == SearchRefresh.Scheduled

private sealed interface SearchItem {
    val key: String
    val isResult
        get() = this !is Group

    data class Group(
        val type: WorkspaceSearchType,
        @StringRes val title: Int,
        val more: Boolean,
        val separated: Boolean,
    ) : SearchItem {
        override val key = "$GroupKeyPrefix${type.name}"
    }

    data class Chat(val chat: ConfirmedChat) : SearchItem {
        override val key
            get() = chat.id
    }

    data class Message(val message: SearchMessageHit, val chat: ConfirmedChat) : SearchItem {
        override val key = "$MessageKeyPrefix${message.threadId}:${message.seqId}"
    }

    data class Workflow(val workflow: SearchWorkflowHit) : SearchItem {
        override val key = "$WorkflowKeyPrefix${workflow.id}"
    }

    data class Artifact(val artifact: SearchArtifactHit) : SearchItem {
        override val key = "$ArtifactKeyPrefix${artifact.id}"
    }
}

private fun <T> MutableList<SearchItem>.addGroup(
    type: WorkspaceSearchType,
    title: Int,
    rows: List<T>,
    compact: Boolean,
    more: Boolean = false,
    item: (T) -> SearchItem,
) {
    if (rows.isEmpty()) return
    add(
        SearchItem.Group(
            type,
            title,
            more = compact && (more || rows.size > GroupedSearchResultLimit),
            separated = isNotEmpty(),
        ),
    )
    val count = if (compact) minOf(rows.size, GroupedSearchResultLimit) else rows.size
    for (index in 0 until count) add(item(rows[index]))
}

@Composable
private fun SearchResults(
    list: ChatListUiState,
    search: ChatSearchState,
    remote: WorkspaceSearchResults?,
    workflowResults: SearchRead<SearchWorkflowHit>?,
    workspacePreparation: SearchRead<Nothing>?,
    recentlyOpened: List<String>,
    modifier: Modifier,
    onOpen: (ConfirmedChat) -> Unit,
    onOpenMessage: (SearchMessageHit) -> Unit,
    onOpenWorkflow: ((SearchWorkflowHit) -> Unit)?,
    onOpenArtifact: ((SearchArtifactHit) -> Unit)?,
    onMoreArtifacts: (String, String) -> Unit,
    resolveMessageChats: suspend (Set<String>) -> Set<String>,
    restoreResultFocus: Boolean,
    onSelectType: (WorkspaceSearchType) -> Unit,
) {
    val keyword = search.keyword
    val type = search.type
    val untitled = stringResource(R.string.chat_untitled)
    val archived = stringResource(R.string.chat_archived)
    val visibleChats =
        remember(list.threadsByRecency) { list.threadsByRecency.filter { it.hidden != true } }
    val chatsById = remember(list.threadsByRecency) { list.threadsByRecency.associateBy { it.id } }
    val projectNames = remember(list.projects) { list.projects.associate { it.id to it.name } }
    val recent =
        remember(chatsById, recentlyOpened) {
            recentlyOpened.mapNotNull { id ->
                chatsById[id]?.takeUnless { it.hidden == true || it.archived }
            }
        }
    val showChats = type.includes(WorkspaceSearchType.Chats)
    val grouped = type == WorkspaceSearchType.All && keyword.isNotEmpty()
    val chats =
        remember(visibleChats, recent, keyword, untitled, showChats, grouped) {
            if (!showChats) return@remember emptyList()
            if (keyword.isEmpty()) {
                recent.ifEmpty {
                    visibleChats
                        .asSequence()
                        .filterNot { it.archived }
                        .take(RecentSearchChatLimit)
                        .toList()
                }
            } else {
                val matches =
                    visibleChats.asSequence().filter {
                        it.searchTitle(untitled).contains(keyword, ignoreCase = true)
                    }
                (if (grouped) matches.take(GroupedSearchResultLimit + 1) else matches).toList()
            }
        }
    val remoteActive = keyword.isNotEmpty() && remote != null
    val currentRemote = remote?.takeIf { it.keyword == keyword }
    val messageRead =
        when {
            keyword.isEmpty() || !type.includes(WorkspaceSearchType.Messages) -> null
            currentRemote != null -> currentRemote.messages
            remoteActive -> SearchRead.Scheduled
            else -> workspacePreparation
        }
    val workflowRead =
        (workspacePreparation ?: workflowResults.takeIf { onOpenWorkflow != null }).takeIf {
            keyword.isNotEmpty() && type.includes(WorkspaceSearchType.Workflows)
        }
    val artifactResults =
        (currentRemote?.artifacts ?: SearchRead.Scheduled).takeIf {
            remoteActive && onOpenArtifact != null
        }
    val artifactRead =
        (workspacePreparation ?: artifactResults).takeIf {
            keyword.isNotEmpty() && type.includes(WorkspaceSearchType.Artifacts)
        }
    val reads = listOf(messageRead, workflowRead, artifactRead)
    val messageHits = (messageRead as? SearchRead.Ready)?.rows.orEmpty()
    val messages =
        remember(messageHits, chatsById) {
            messageHits.mapNotNull { hit ->
                chatsById[hit.threadId]
                    ?.takeUnless { it.hidden == true }
                    ?.let { SearchItem.Message(hit, it) }
            }
        }
    val missingMessageChats =
        remember(messageHits, chatsById) {
            messageHits.asSequence().map { it.threadId }.filterNot(chatsById::containsKey).toSet()
        }
    var unresolvedChats by remember(keyword, messageHits) { mutableStateOf(emptySet<String>()) }
    val uncheckedChats = missingMessageChats - unresolvedChats
    if (missingMessageChats.isNotEmpty()) {
        val latestMissingChats by rememberUpdatedState(missingMessageChats)
        val latestListConfirmation by rememberUpdatedState(list.confirmedAt)
        LaunchedEffect(keyword, messageHits) {
            // Composition can hide a snapshot that briefly contained a matched chat.
            snapshotFlow { latestListConfirmation to (latestMissingChats - unresolvedChats) }
                .collect { (_, chats) ->
                    if (chats.isNotEmpty()) unresolvedChats += resolveMessageChats(chats)
                }
        }
    }
    val workflows = (workflowRead as? SearchRead.Ready)?.rows.orEmpty()
    val artifactPage = artifactRead as? SearchRead.Ready
    val artifacts = artifactPage?.rows.orEmpty()
    val artifactCursor = artifactPage?.nextCursor
    val artifactPaging = currentRemote?.artifactPaging
    val artifactPageFailed =
        type == WorkspaceSearchType.Artifacts && artifactPaging?.hasFailure == true
    val showArtifactPageFailure = artifactPageFailed && artifacts.isNotEmpty()
    val nextArtifactPage =
        artifactPage
            ?.takeIf {
                type == WorkspaceSearchType.Artifacts &&
                    artifactPaging != ArtifactSearchPaging.Failed &&
                    it.refresh == SearchRefresh.Idle
            }
            ?.nextCursor
    val waitingForArtifactPage =
        nextArtifactPage != null && (artifactPaging?.isLoading == true || artifacts.isEmpty())
    val items =
        remember(
            grouped,
            keyword,
            chats,
            messages,
            workflows,
            artifacts,
            artifactCursor,
            recent.isNotEmpty(),
        ) {
            buildList {
                val chatHeading =
                    when {
                        keyword.isNotEmpty() -> R.string.chat_list_title
                        recent.isNotEmpty() -> R.string.chat_search_recently_opened
                        else -> R.string.chat_search_recent
                    }
                addGroup(
                    WorkspaceSearchType.Chats,
                    chatHeading,
                    chats,
                    grouped,
                    item = { SearchItem.Chat(it) },
                )
                addGroup(
                    WorkspaceSearchType.Messages,
                    R.string.chat_search_messages,
                    messages,
                    grouped,
                    item = { it },
                )
                addGroup(
                    WorkspaceSearchType.Workflows,
                    R.string.chat_search_workflows,
                    workflows,
                    grouped,
                    item = { SearchItem.Workflow(it) },
                )
                addGroup(
                    WorkspaceSearchType.Artifacts,
                    R.string.chat_search_artifacts,
                    artifacts,
                    grouped,
                    more = artifactCursor != null,
                    item = { SearchItem.Artifact(it) },
                )
            }
        }
    val listFailure = list.listReadFailure
    val needsMessageChats = missingMessageChats.isNotEmpty()
    val needsChatList = showChats || needsMessageChats
    val listFailed = listFailure == ChatListReadFailure.NeedsRetry
    val waitingForList =
        needsChatList && list.confirmedAt == null && !listFailed ||
            needsMessageChats &&
                (uncheckedChats.isNotEmpty() ||
                    list.listPhase == ChatReadPhase.Loading ||
                    !listFailed && listFailure == ChatListReadFailure.Retrying)
    val waitingForMessageMetadata = needsMessageChats && waitingForList
    val remotePending =
        reads.any { it.isPending } || waitingForMessageMetadata || waitingForArtifactPage
    val pending = waitingForList || remotePending
    val reading = waitingForList || waitingForArtifactPage || reads.any { it.isReading }
    fun waitingForResult(key: String): Boolean =
        when (searchResultType(key)) {
            WorkspaceSearchType.Chats -> showChats && waitingForList
            WorkspaceSearchType.Messages -> messageRead.isPending || waitingForMessageMetadata
            WorkspaceSearchType.Workflows -> workflowRead.isPending
            WorkspaceSearchType.Artifacts -> artifactRead.isPending || waitingForArtifactPage
            WorkspaceSearchType.All -> pending
        }
    val confirmedChats = list.confirmedAt != null
    val chatRefreshFailed = needsChatList && listFailed
    val messageChatsUnavailable = needsMessageChats && !waitingForList
    val sourceUnavailable =
        keyword.isNotEmpty() &&
            workspacePreparation == null &&
            when (type) {
                WorkspaceSearchType.Workflows -> onOpenWorkflow == null
                WorkspaceSearchType.Artifacts -> onOpenArtifact == null
                else -> false
            }
    val readFailed =
        chatRefreshFailed ||
            messageChatsUnavailable ||
            artifactPageFailed && artifacts.isEmpty() ||
            sourceUnavailable ||
            reads.any { it.hasFailure }
    val confirmedEmpty =
        items.isEmpty() &&
            (!needsChatList || confirmedChats) &&
            !pending &&
            !readFailed &&
            reads.all { it == null || it is SearchRead.Ready }
    val showFailure = readFailed && !pending && items.isEmpty()
    // While refreshing, retain the empty state already presented for this query and tab.
    var hadConfirmedEmpty by remember(keyword, type) { mutableStateOf(false) }
    val canRetainEmpty =
        items.isEmpty() &&
            !showFailure &&
            !sourceUnavailable &&
            reads.none { it == SearchRead.AccessLost }
    val showEmpty = confirmedEmpty || canRetainEmpty && hadConfirmedEmpty
    SideEffect {
        hadConfirmedEmpty = showEmpty
    }
    val showDelayedFeedback =
        key(keyword, type) {
            rememberContentReadFeedbackAfter(
                ContentReadFeedbackDelayMillis.takeIf { pending },
                start = reading,
            )
        }
    val showSkeleton = showDelayedFeedback && items.isEmpty() && !showEmpty
    val showProgress =
        (items.isNotEmpty() || showEmpty) &&
            (showDelayedFeedback || needsChatList && list.listRetryProgressVisible)
    val failureLabel =
        if (chatRefreshFailed && showChats && !grouped) R.string.chat_search_chats_failed
        else R.string.chat_list_first_load_failed
    val accessFailure =
        when {
            type == WorkspaceSearchType.Messages && messageRead == SearchRead.AccessLost ->
                R.string.chat_search_messages_failed
            type == WorkspaceSearchType.Workflows && workflowRead == SearchRead.AccessLost ->
                R.string.chat_search_workflows_failed
            type == WorkspaceSearchType.Artifacts && artifactRead == SearchRead.AccessLost ->
                R.string.chat_search_artifacts_failed
            else -> null
        }
    val notice =
        if (readFailed && !pending && !showFailure) {
            val message =
                if (showChats && !grouped && chatRefreshFailed) R.string.chat_search_saved_chats
                else R.string.chat_search_unavailable
            stringResource(message)
        } else null
    val snackbar =
        rememberReadFailureFeedback(
            scope = keyword to type,
            failureRound = Unit.takeIf { notice != null },
            message = notice,
            announcement = search.readFailureAnnouncement,
        )
    val resultFocus = remember { FocusRequester() }
    val anchor = search.pendingAnchor
    val inputMode = LocalInputModeManager.current
    val request = search.returnFocus.pending.takeIf { restoreResultFocus }
    val pendingFocus = request?.rowKey
    val position = search.position
    val (wasAtTop, previousPosition, firstResult) =
        Snapshot.withoutReadObservation {
            val previous = search.savedAnchor()
            val atTop =
                position.firstVisibleItemIndex == 0 && position.firstVisibleItemScrollOffset == 0
            val result = position.layoutInfo.visibleItemsInfo.firstOrNull { it.contentType == true }
            Triple(atTop, previous, result)
        }
    LaunchedEffect(items) {
        if (anchor != null || pendingFocus != null || position.isScrollInProgress) {
            return@LaunchedEffect
        }
        if (items.isEmpty()) return@LaunchedEffect
        if (wasAtTop) {
            position.requestScrollToItem(0)
        } else if (previousPosition != null && firstResult != null) {
            val index = items.indexOfFirst { it.key == firstResult.key }
            when {
                index < 0 ->
                    position.requestScrollToItem(
                        previousPosition.index.coerceAtMost(items.lastIndex),
                        previousPosition.offset,
                    )
                // LazyColumn tracks the key of its first item, which can be a group heading.
                previousPosition.key != firstResult.key ->
                    position.requestScrollToItem(index, -firstResult.offset)
            }
        }
    }
    val waitingForAnchor = anchor?.let { waitingForResult(it.key) } == true
    LaunchedEffect(anchor, items, waitingForAnchor, pendingFocus) {
        if (anchor != null) {
            val index = items.indexOfFirst { it.key == anchor.key }.takeIf { it >= 0 }
            // Use the selected result as the position if its former anchor is still loading.
            if (
                index != null ||
                    !waitingForAnchor ||
                    pendingFocus != null && items.any { it.key == pendingFocus }
            ) {
                val fallback = anchor.index.coerceAtMost(items.lastIndex).takeIf { it >= 0 }
                search.restorePosition(index ?: fallback)
            }
        }
    }
    val waitingForFocus = pendingFocus?.let(::waitingForResult) == true
    LaunchedEffect(request, anchor, items, waitingForFocus) {
        if (request == null || !search.returnFocus.isCurrent(request, inputMode.inputMode)) {
            return@LaunchedEffect
        }
        val index = items.indexOfFirst { it.key == request.rowKey }
        if (index < 0 && !waitingForFocus) {
            if (resultFocus.requestFocus()) search.returnFocus.finish(request)
        } else if (index >= 0 && anchor == null) {
            if (search.position.layoutInfo.visibleItemsInfo.none { it.key == request.rowKey }) {
                search.position.scrollToItem(index)
            }
        }
    }
    BoxWithConstraints(modifier) {
        val viewportHeight = maxHeight
        LazyColumn(
            Modifier.fillMaxSize()
                .focusRequester(resultFocus)
                .workspaceSearchFocusOutline(RectangleShape)
                .focusable()
                .testTag("chat_search_results"),
            state = search.position,
            contentPadding =
                if (showFailure && accessFailure == null) PaddingValues(horizontal = 16.dp)
                else PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp),
        ) {
            items(items, key = { it.key }, contentType = { it.isResult }) { row ->
                when (row) {
                    is SearchItem.Group -> SearchGroup(row) { onSelectType(row.type) }
                    is SearchItem.Chat -> {
                        val chat = row.chat
                        val project = projectNames[chat.projectId]
                        val metadata =
                            listOfNotNull(project, archived.takeIf { chat.archived })
                                .joinToString(" · ")
                                .ifEmpty { null }
                        SearchResult(
                            search,
                            row.key,
                            restoreResultFocus,
                            highlightedSearchText(chat.searchTitle(untitled), keyword),
                            metadata = metadata,
                        ) {
                            search.returnToResult(row.key, inputMode.inputMode)
                            onOpen(chat)
                        }
                    }
                    is SearchItem.Message -> {
                        val hit = row.message
                        val chat = row.chat
                        val metadata =
                            listOfNotNull(
                                    projectNames[chat.projectId],
                                    archived.takeIf { chat.archived },
                                )
                                .joinToString(" · ")
                                .ifEmpty { null }
                        SearchResult(
                            search,
                            row.key,
                            restoreResultFocus,
                            highlightedSearchText(chat.searchTitle(untitled), keyword),
                            snippet =
                                if (hit.content.isBlank()) null
                                else {
                                    { SearchResultExcerpt(hit.content, hit.ranges) }
                                },
                            metadata = metadata,
                        ) {
                            search.returnToResult(row.key, inputMode.inputMode)
                            onOpenMessage(hit)
                        }
                    }
                    is SearchItem.Workflow -> {
                        val hit = row.workflow
                        SearchResult(
                            search,
                            row.key,
                            restoreResultFocus,
                            highlightedSearchText(hit.title, keyword),
                            snippet =
                                hit.description?.takeIf(String::isNotBlank)?.let { purpose ->
                                    {
                                        val match = purpose.searchMatch(keyword)
                                        if (match == null)
                                            SearchExcerptText(AnnotatedString(purpose))
                                        else SearchResultExcerpt(purpose, listOf(match))
                                    }
                                },
                        ) {
                            search.returnToResult(row.key, inputMode.inputMode)
                            onOpenWorkflow?.invoke(hit)
                        }
                    }
                    is SearchItem.Artifact -> {
                        val hit = row.artifact
                        SearchResult(
                            search,
                            row.key,
                            restoreResultFocus,
                            highlightedSearchText(hit.title, keyword),
                            metadata = stringResource(hit.kind.label()),
                        ) {
                            search.returnToResult(row.key, inputMode.inputMode)
                            onOpenArtifact?.invoke(hit)
                        }
                    }
                }
            }
            if (nextArtifactPage != null || showArtifactPageFailure) {
                item(key = "search_more_artifacts") {
                    if (nextArtifactPage != null) {
                        LaunchedEffect(keyword, nextArtifactPage) {
                            onMoreArtifacts(keyword, nextArtifactPage)
                        }
                    }
                    if (showArtifactPageFailure) {
                        ContentReadFeedback(
                            R.string.artifact_catalog_page_failed,
                            Modifier.padding(start = 12.dp, top = 12.dp, end = 12.dp),
                        )
                    }
                }
            }
            if (showSkeleton) {
                item(key = "search_loading") {
                    SearchResultSkeleton(
                        if (remotePending) R.string.chat_search_loading else R.string.chat_loading,
                        supporting = keyword.isNotEmpty() && type != WorkspaceSearchType.Chats,
                    )
                }
            }
            if (showFailure) {
                item(key = "search_status") {
                    if (accessFailure == null) {
                        ContentReadFailure(
                            failureLabel,
                            Modifier.fillMaxWidth().heightIn(min = viewportHeight),
                        )
                    } else {
                        ContentReadFeedback(
                            accessFailure,
                            Modifier.padding(horizontal = 16.dp, vertical = 24.dp),
                        )
                    }
                }
            } else if (showEmpty) {
                item(key = "search_empty") {
                    if (keyword.isEmpty()) {
                        Text(
                            stringResource(R.string.chat_search_enter_keyword),
                            Modifier.padding(16.dp),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = workspaceSearchSecondaryStyle(),
                        )
                    } else {
                        SearchEmpty(type, onSelectType)
                    }
                }
            }
        }
        key(keyword, type) {
            ContentReadProgress(R.string.chat_search_loading, visible = showProgress)
        }
        Box(Modifier.align(Alignment.BottomCenter)) {
            WorkspaceFeedbackHost(
                snackbar,
                Modifier.padding(bottom = 8.dp),
                manageTimeout = false,
                surfaceModifier = Modifier.testTag("chat_search_feedback"),
            )
        }
    }
}

@Composable
private fun SearchGroup(group: SearchItem.Group, onMore: () -> Unit) {
    val label = stringResource(group.title)
    val moreLabel = stringResource(R.string.chat_search_view_type, label)
    Row(
        Modifier.fillMaxWidth()
            .padding(
                start = 16.dp,
                end = 16.dp,
                top = if (group.separated) 16.dp else 0.dp,
            ),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WorkspaceSearchGroupHeading(label, Modifier.weight(1f))
        if (group.more) {
            TextButton(
                onClick = onMore,
                modifier =
                    Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp)
                        .workspaceSearchFocusOutline(ButtonDefaults.textShape)
                        .semantics { contentDescription = moreLabel },
            ) {
                Text(stringResource(R.string.chat_search_view_all))
            }
        }
    }
}

@Composable
private fun SearchResult(
    search: ChatSearchState,
    key: String,
    restoreResultFocus: Boolean,
    title: AnnotatedString,
    snippet: @Composable (() -> Unit)? = null,
    metadata: String? = null,
    onOpen: () -> Unit,
) {
    val rowFocus = remember { FocusRequester() }
    val inputMode = LocalInputModeManager.current
    val request =
        search.returnFocus.pending?.takeIf {
            restoreResultFocus && it.rowKey == key && search.pendingAnchor == null
        }
    LaunchedEffect(request) {
        if (
            request != null &&
                search.returnFocus.isCurrent(request, inputMode.inputMode) &&
                rowFocus.requestFocus(FocusDirection.Enter)
        ) {
            search.returnFocus.finish(request)
        }
    }
    val activeShape = MaterialTheme.shapes.extraLarge
    val shapes = ListItemDefaults.shapes(pressedShape = activeShape, focusedShape = activeShape)
    ListItem(
        onClick = onOpen,
        modifier =
            Modifier.fillMaxWidth()
                .focusRequester(rowFocus)
                .focusProperties { canFocus = true }
                .workspaceSearchFocusOutline(shapes.focusedShape)
                .semantics { role = Role.Button },
        shapes = shapes,
        supportingContent =
            when {
                metadata == null -> snippet
                snippet == null -> {
                    { Text(metadata, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
                else -> {
                    {
                        Column {
                            snippet()
                            Text(metadata, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            },
    ) {
        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun SearchResultSkeleton(@StringRes loadingLabel: Int, supporting: Boolean) {
    val label = stringResource(loadingLabel)
    val textMeasurer = rememberTextMeasurer()
    Column(Modifier.semantics { contentDescription = label }) {
        val widths = listOf(.56f, .70f, .44f)
        repeat(6) { index ->
            ListItem(
                modifier = Modifier.fillMaxWidth(),
                supportingContent =
                    if (supporting) {
                        { ListItemSkeletonLine(.4f, textMeasurer) }
                    } else null,
            ) {
                ListItemSkeletonLine(widths[index % widths.size], textMeasurer)
            }
        }
    }
}

@Composable
private fun SearchEmpty(
    type: WorkspaceSearchType,
    onSelectType: (WorkspaceSearchType) -> Unit,
) {
    Column(
        Modifier.padding(top = 24.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            stringResource(type.emptyLabel),
            Modifier.padding(horizontal = 16.dp).semantics {
                heading()
                liveRegion = LiveRegionMode.Polite
            },
            style = chatListTitleStyle().copy(fontWeight = FontWeight.SemiBold),
        )
        if (type != WorkspaceSearchType.All) {
            TextButton(
                onClick = { onSelectType(WorkspaceSearchType.All) },
                modifier =
                    Modifier.padding(start = 4.dp)
                        .sizeIn(minWidth = 48.dp, minHeight = 48.dp)
                        .workspaceSearchFocusOutline(ButtonDefaults.textShape),
            ) {
                Text(stringResource(R.string.chat_search_all_types))
            }
        }
    }
}

@get:StringRes
private val WorkspaceSearchType.label: Int
    get() =
        when (this) {
            WorkspaceSearchType.All -> R.string.chat_search_all
            WorkspaceSearchType.Chats -> R.string.chat_list_title
            WorkspaceSearchType.Messages -> R.string.chat_search_messages
            WorkspaceSearchType.Workflows -> R.string.chat_search_workflows
            WorkspaceSearchType.Artifacts -> R.string.chat_search_artifacts
        }

@get:StringRes
private val WorkspaceSearchType.emptyLabel: Int
    get() =
        when (this) {
            WorkspaceSearchType.All -> R.string.chat_search_no_results
            WorkspaceSearchType.Chats -> R.string.chat_search_empty
            WorkspaceSearchType.Messages -> R.string.chat_search_no_messages
            WorkspaceSearchType.Workflows -> R.string.chat_search_no_workflows
            WorkspaceSearchType.Artifacts -> R.string.chat_search_no_artifacts
        }

@Composable
private fun highlightedSearchText(text: String, keyword: String): AnnotatedString {
    val match = text.searchMatch(keyword)
    val matchStyle = searchMatchStyle()
    return buildAnnotatedString {
        append(text)
        if (match != null) addStyle(matchStyle, match.first, match.last + 1)
    }
}

private fun String.searchMatch(keyword: String): IntRange? {
    if (keyword.isEmpty()) return null
    val start = indexOf(keyword, ignoreCase = true)
    return if (start >= 0) start until start + keyword.length else null
}

@Composable
private fun searchMatchStyle() =
    SpanStyle(color = MaterialTheme.colorScheme.onSurface, fontWeight = searchMatchWeight)

@Composable
private fun SearchExcerptText(
    text: AnnotatedString,
    onTextLayout: (TextLayoutResult) -> Unit = {},
) {
    Text(
        text,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        onTextLayout = onTextLayout,
    )
}

@Composable
private fun SearchResultExcerpt(text: String, matches: List<IntRange>) {
    if (text.isBlank()) return
    val first = matches.minByOrNull { it.first }
    val matchStyle = searchMatchStyle()
    val density = LocalDensity.current
    val window = LocalWindowInfo.current.containerSize
    var startAtMatch by remember(text, matches, density, window) { mutableStateOf(false) }
    val leadingContext = if (startAtMatch) 0 else 20
    var from = ((first?.first ?: 0) - leadingContext).coerceIn(0, text.lastIndex)
    var to = ((first?.last?.plus(1) ?: from) + 54).coerceAtMost(text.length)
    if (from > 0 && text[from].isLowSurrogate()) from--
    if (to < text.length && text[to].isLowSurrogate()) to++
    val leading = if (from > 0 && !startAtMatch) 1 else 0
    val snippet = buildAnnotatedString {
        if (leading > 0) append('…')
        // Keep the two-line preview flowing without shifting its match offsets.
        for (index in from until to) {
            val character = text[index]
            append(if (character.isWhitespace()) ' ' else character)
        }
        for (range in matches) {
            val start = maxOf(range.first, from)
            val end = minOf(range.last + 1, to)
            if (start < end) {
                addStyle(
                    matchStyle,
                    start - from + leading,
                    end - from + leading,
                )
            }
        }
        if (to < text.length) append('…')
    }
    SearchExcerptText(snippet) { layout ->
        if (!startAtMatch && first != null && from < first.first && layout.lineCount > 0) {
            val matchEnd = minOf(first.last + 1, text.length) - from + leading
            if (layout.getLineEnd(layout.lineCount - 1, visibleEnd = true) < matchEnd)
                startAtMatch = true
        }
    }
}

private fun ConfirmedChat.searchTitle(untitled: String): String =
    title?.takeIf(String::isNotBlank) ?: untitled
