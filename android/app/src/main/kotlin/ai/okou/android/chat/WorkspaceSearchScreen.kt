package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.WorkspaceSearchField
import ai.okou.android.WorkspaceSearchToolbar
import ai.okou.android.artifacts.label
import ai.okou.android.state.ChatSearchState
import ai.okou.android.workspaceSearchControlHeight
import ai.okou.android.workspaceSearchTextStyle
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun WorkspaceSearchScreen(
    state: ChatListUiState,
    search: ChatSearchState,
    widthDp: Int,
    listWidth: Int?,
    workspaceName: String?,
    focusOnEntry: Boolean,
    onFocused: () -> Unit,
    onClose: () -> Unit,
    onOpen: (ConfirmedChat) -> Unit,
    retry: () -> Unit,
    refreshChats: () -> Unit = {},
    remote: WorkspaceSearchResults? = null,
    recentlyOpened: List<String> = emptyList(),
    onOpenMessage: (SearchMessageHit) -> Unit = {},
    restoreResultFocus: Boolean = true,
    onOpenWorkflow: ((SearchWorkflowHit) -> Unit)? = null,
    onOpenArtifact: ((SearchArtifactHit) -> Unit)? = null,
    onMoreArtifacts: (String, String) -> Unit = { _, _ -> },
) {
    val query = search.query
    val incomingResults = Triple(state, remote, recentlyOpened)
    var presentedResults by
        remember(search, state.offline, onOpenWorkflow != null, onOpenArtifact != null) {
            mutableStateOf(incomingResults)
        }
    val composing = query.composition != null
    if (!composing) SideEffect { presentedResults = incomingResults }
    val (resultList, resultRemote, resultRecents) =
        if (composing) presentedResults else incomingResults
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
    val inputStyle = workspaceSearchTextStyle().copy(color = colors.onSurface)
    val contentWidth = Modifier.widthIn(max = 720.dp).fillMaxWidth()
    val allTabFocus = remember { FocusRequester() }
    fun selectType(type: WorkspaceSearchType) {
        if (inputFocused) {
            focus.clearFocus()
            keyboard?.hide()
        }
        search.selectType(type)
    }

    Column(
        Modifier.fillMaxSize().imePadding().testTag("chat_search"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        WorkspaceSearchToolbar(
            widthDp,
            listWidth,
            leading = {
                IconButton(
                    onClick = onClose,
                    modifier = Modifier.size(workspaceSearchControlHeight()),
                ) {
                    Icon(
                        painterResource(R.drawable.ic_arrow_back),
                        stringResource(R.string.back),
                        tint = colors.onSurface,
                    )
                }
            },
            field = { fieldModifier ->
                BasicTextField(
                    value = query,
                    onValueChange = search::edit,
                    modifier =
                        fieldModifier
                            .focusRequester(inputFocus)
                            .onFocusChanged { inputFocused = it.isFocused }
                            .testTag("chat_search_query")
                            .semantics {
                                contentDescription =
                                    workspaceName?.let { "$searchLabel, $it" } ?: searchLabel
                            },
                    textStyle = inputStyle,
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
                    cursorBrush = SolidColor(colors.onSurface),
                    decorationBox = { input ->
                        WorkspaceSearchField(
                            Modifier.fillMaxWidth(),
                            focused = inputFocused,
                            hasTrailingAction = query.text.isNotEmpty(),
                        ) {
                            Box(Modifier.weight(1f).padding(vertical = 8.dp)) {
                                if (query.text.isEmpty()) {
                                    Text(
                                        searchLabel,
                                        style = inputStyle,
                                        color = colors.onSurfaceVariant,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                input()
                            }
                            if (query.text.isNotEmpty()) {
                                IconButton(
                                    onClick = {
                                        search.clearQuery()
                                        inputFocus.requestFocus()
                                        keyboard?.show()
                                    }
                                ) {
                                    Icon(
                                        painterResource(R.drawable.ic_close),
                                        stringResource(R.string.chat_search_clear),
                                        modifier = Modifier.size(20.dp),
                                        tint = colors.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    },
                )
            },
        )
        if (workspaceName != null) {
            Text(
                workspaceName,
                contentWidth
                    .padding(start = 16.dp, end = 16.dp, bottom = 4.dp)
                    .clearAndSetSemantics {},
                color = colors.onSurfaceVariant,
                fontSize = 13.sp,
                lineHeight = 20.sp,
            )
        }
        SearchTypes(search.type, allTabFocus, contentWidth, ::selectType)
        SearchResults(
            resultList,
            search,
            resultRemote,
            resultRecents,
            contentWidth.weight(1f),
            onOpen,
            onOpenMessage,
            onOpenWorkflow,
            onOpenArtifact,
            onMoreArtifacts,
            retry,
            refreshChats,
            restoreResultFocus,
            onSelectType = ::selectType,
            onBroaden = {
                selectType(WorkspaceSearchType.All)
                allTabFocus.requestFocus()
            },
        )
    }
}

@Composable
private fun SearchTypes(
    selectedType: WorkspaceSearchType,
    allTabFocus: FocusRequester,
    modifier: Modifier,
    onSelect: (WorkspaceSearchType) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val scroll = rememberScrollState()
    Row(
        modifier
            .padding(start = 16.dp, end = 16.dp, bottom = 6.dp)
            .drawWithContent {
                drawContent()
                val rtl = layoutDirection == LayoutDirection.Rtl
                val fade = 16.dp.toPx()
                val background = colors.background
                val transparent = background.copy(alpha = 0f)
                if (if (rtl) scroll.canScrollForward else scroll.canScrollBackward) {
                    drawRect(
                        Brush.horizontalGradient(listOf(background, transparent), endX = fade),
                        size = Size(fade, size.height),
                    )
                }
                if (if (rtl) scroll.canScrollBackward else scroll.canScrollForward) {
                    val x = size.width - fade
                    drawRect(
                        Brush.horizontalGradient(listOf(transparent, background), startX = x),
                        topLeft = Offset(x, 0f),
                        size = Size(fade, size.height),
                    )
                }
            }
            .horizontalScroll(scroll)
            .selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for (type in WorkspaceSearchType.entries) {
            val selected = selectedType == type
            val reveal = remember { BringIntoViewRequester() }
            var focused by remember { mutableStateOf(false) }
            LaunchedEffect(selected, focused, scroll.maxValue) {
                if (selected || focused) reveal.bringIntoView()
            }
            Box(
                Modifier.widthIn(min = 48.dp)
                    .heightIn(min = 48.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .then(
                        if (type == WorkspaceSearchType.All)
                            Modifier.focusRequester(allTabFocus).focusProperties { canFocus = true }
                        else Modifier
                    )
                    .background(if (selected) colors.secondaryContainer else colors.background)
                    .bringIntoViewRequester(reveal)
                    .onFocusChanged { focused = it.isFocused }
                    .testTag("search_type_${type.name}")
                    .selectable(selected, role = Role.Tab) { onSelect(type) }
                    .padding(horizontal = 8.dp, vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    stringResource(type.label),
                    style = searchSecondaryStyle(),
                    color = if (selected) colors.onSecondaryContainer else colors.onSurface,
                )
            }
        }
    }
}

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

private val SearchRead<*>?.isPending: Boolean
    get() = this == SearchRead.Loading || this == SearchRead.Retrying

private sealed interface SearchItem {
    val key: String

    data class Group(
        val type: WorkspaceSearchType,
        @StringRes val title: Int,
        val more: Boolean = false,
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
    add(SearchItem.Group(type, title, compact && (more || rows.size > GroupedSearchResultLimit)))
    val count = if (compact) minOf(rows.size, GroupedSearchResultLimit) else rows.size
    for (index in 0 until count) add(item(rows[index]))
}

@Composable
private fun SearchResults(
    list: ChatListUiState,
    search: ChatSearchState,
    remote: WorkspaceSearchResults?,
    recentlyOpened: List<String>,
    modifier: Modifier,
    onOpen: (ConfirmedChat) -> Unit,
    onOpenMessage: (SearchMessageHit) -> Unit,
    onOpenWorkflow: ((SearchWorkflowHit) -> Unit)?,
    onOpenArtifact: ((SearchArtifactHit) -> Unit)?,
    onMoreArtifacts: (String, String) -> Unit,
    retry: () -> Unit,
    refreshChats: () -> Unit,
    restoreResultFocus: Boolean,
    onSelectType: (WorkspaceSearchType) -> Unit,
    onBroaden: () -> Unit,
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
    val remoteActive = keyword.isNotEmpty() && !list.offline && remote != null
    val currentRemote = remote?.takeIf { it.keyword == keyword }
    val messageRead =
        (currentRemote?.messages ?: SearchRead.Loading).takeIf {
            remoteActive && type.includes(WorkspaceSearchType.Messages)
        }
    val workflowRead =
        (currentRemote?.workflows ?: SearchRead.Loading).takeIf {
            remoteActive && onOpenWorkflow != null && type.includes(WorkspaceSearchType.Workflows)
        }
    val artifactRead =
        (currentRemote?.artifacts ?: SearchRead.Loading).takeIf {
            remoteActive && onOpenArtifact != null && type.includes(WorkspaceSearchType.Artifacts)
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
    val needsMessageChats =
        remember(messageHits, chatsById) { messageHits.any { it.threadId !in chatsById } }
    LaunchedEffect(keyword, messageRead) { if (needsMessageChats) refreshChats() }
    val workflows = (workflowRead as? SearchRead.Ready)?.rows.orEmpty()
    val artifactPage = artifactRead as? SearchRead.Ready
    val artifacts = artifactPage?.rows.orEmpty()
    val artifactCursor = artifactPage?.nextCursor
    val moreArtifactsFailed = currentRemote?.moreArtifactsFailed == true
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
    val needsChatList = showChats || needsMessageChats
    val canRetryList =
        needsChatList && !list.offline && listFailure == ChatListReadFailure.NeedsRetry
    val waitingForList =
        needsChatList && list.confirmedAt == null && !list.offline && listFailure == null ||
            needsMessageChats && list.listPhase == ChatReadPhase.Loading
    val retrying = SearchRead.Retrying in reads
    val pending = waitingForList || reads.any { it.isPending }
    fun waitingForResult(key: String): Boolean =
        when (searchResultType(key)) {
            WorkspaceSearchType.Chats -> showChats && waitingForList
            WorkspaceSearchType.Messages ->
                messageRead.isPending || needsMessageChats && waitingForList
            WorkspaceSearchType.Workflows -> workflowRead.isPending
            WorkspaceSearchType.Artifacts -> artifactRead.isPending
            WorkspaceSearchType.All -> pending
        }
    val unavailableType =
        type == WorkspaceSearchType.Artifacts && onOpenArtifact == null ||
            type == WorkspaceSearchType.Workflows && onOpenWorkflow == null
    val unavailableOffline = list.offline && !showChats
    val status =
        when {
            unavailableOffline -> R.string.chat_search_online_only
            unavailableType && keyword.isNotEmpty() -> R.string.chat_search_unavailable
            showChats && list.confirmedAt == null && list.offline ->
                R.string.chat_list_load_when_online
            needsChatList && list.confirmedAt == null && listFailure != null ->
                R.string.chat_list_first_load_failed
            retrying ||
                SearchRead.Failed in reads ||
                moreArtifactsFailed && type == WorkspaceSearchType.Artifacts ->
                R.string.chat_search_unavailable
            needsChatList && (list.sustainedRefreshFailure || canRetryList) ->
                R.string.chat_list_refresh_failed
            needsMessageChats && (listFailure != null || !waitingForList) ->
                R.string.chat_search_unavailable
            else -> null
        }
    val showSkeleton = rememberChatWaitIndicator(pending && items.isEmpty() && status == null)
    val resultFocus = remember { FocusRequester() }
    val anchor = search.pendingAnchor
    val waitingForAnchor = anchor?.let { waitingForResult(it.key) } == true
    LaunchedEffect(anchor, items, waitingForAnchor) {
        if (anchor != null) {
            val index = items.indexOfFirst { it.key == anchor.key }.takeIf { it >= 0 }
            if (index != null || !waitingForAnchor) search.restorePosition(index)
        }
    }
    val pendingFocus = search.pendingFocus.takeIf { restoreResultFocus }
    val waitingForFocus = pendingFocus?.let(::waitingForResult) == true
    LaunchedEffect(pendingFocus, anchor, items, waitingForFocus) {
        if (pendingFocus == null) return@LaunchedEffect
        val index = items.indexOfFirst { it.key == pendingFocus }
        if (index < 0 && !waitingForFocus) {
            resultFocus.requestFocus()
            search.restoreFocus()
        } else if (index >= 0 && anchor == null) {
            if (search.position.layoutInfo.visibleItemsInfo.none { it.key == pendingFocus }) {
                search.position.scrollToItem(index)
            }
        }
    }
    LazyColumn(
        modifier
            .fillMaxWidth()
            .focusRequester(resultFocus)
            .focusable()
            .testTag("chat_search_results"),
        state = search.position,
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp),
    ) {
        items(items, key = { it.key }) { row ->
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
                        highlightedSearchTitle(chat.searchTitle(untitled), keyword),
                        metadata = metadata,
                    ) {
                        search.returnToResult(row.key)
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
                        highlightedSearchTitle(chat.searchTitle(untitled), keyword),
                        snippet = messageSnippet(hit),
                        metadata = metadata,
                    ) {
                        search.returnToResult(row.key)
                        onOpenMessage(hit)
                    }
                }
                is SearchItem.Workflow -> {
                    val hit = row.workflow
                    SearchResult(
                        search,
                        row.key,
                        restoreResultFocus,
                        highlightedSearchTitle(hit.title, keyword),
                        snippet =
                            hit.description
                                ?.takeIf { it.isNotBlank() }
                                ?.let { highlightedSearchTitle(it, keyword) },
                    ) {
                        search.returnToResult(row.key)
                        onOpenWorkflow?.invoke(hit)
                    }
                }
                is SearchItem.Artifact -> {
                    val hit = row.artifact
                    SearchResult(
                        search,
                        row.key,
                        restoreResultFocus,
                        highlightedSearchTitle(hit.title, keyword),
                        metadata = stringResource(hit.kind.label()),
                    ) {
                        search.returnToResult(row.key)
                        onOpenArtifact?.invoke(hit)
                    }
                }
            }
        }
        if (
            type == WorkspaceSearchType.Artifacts && artifactCursor != null && !moreArtifactsFailed
        ) {
            item(key = "search_more_artifacts") {
                LaunchedEffect(keyword, artifactCursor) { onMoreArtifacts(keyword, artifactCursor) }
                LinearProgressIndicator(Modifier.fillMaxWidth().padding(12.dp))
            }
        }
        if (showSkeleton) item(key = "search_loading") { ChatListSkeleton() }
        if (status != null) {
            item(key = "search_status") {
                ChatContentLoadNotice(
                    status,
                    retry = retry.takeIf { canRetryList },
                    retryEnabled = list.listPhase != ChatReadPhase.Loading,
                )
            }
        } else if (items.isEmpty() && !pending) {
            item(key = "search_empty") {
                if (keyword.isEmpty()) {
                    Text(
                        stringResource(R.string.chat_search_enter_keyword),
                        Modifier.padding(12.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = searchSecondaryStyle(),
                    )
                } else {
                    SearchEmpty(
                        if (list.offline) R.string.chat_search_empty else type.emptyLabel,
                        onBroaden.takeIf { !list.offline && type != WorkspaceSearchType.All },
                    )
                }
            }
        }
        if (
            list.offline &&
                list.confirmedAt != null &&
                type == WorkspaceSearchType.All &&
                keyword.isNotEmpty()
        ) {
            item(key = "search_offline_scope") {
                Text(
                    stringResource(R.string.chat_search_offline_titles),
                    Modifier.padding(12.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = searchSecondaryStyle(),
                )
            }
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
                start = 12.dp,
                end = 12.dp,
                top = if (group.type == WorkspaceSearchType.Chats) 0.dp else 16.dp,
            ),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            modifier =
                Modifier.weight(1f).padding(top = 8.dp, bottom = 4.dp).semantics { heading() },
            style = searchSecondaryStyle().copy(fontWeight = FontWeight.SemiBold),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (group.more) {
            Box(
                Modifier.heightIn(min = 48.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .clickable(role = Role.Button, onClick = onMore)
                    .semantics { contentDescription = moreLabel }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    stringResource(R.string.chat_search_view_all),
                    style = searchSecondaryStyle(),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
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
    snippet: AnnotatedString? = null,
    metadata: String? = null,
    onOpen: () -> Unit,
) {
    val rowFocus = remember { FocusRequester() }
    val restoreFocus =
        restoreResultFocus && search.pendingFocus == key && search.pendingAnchor == null
    LaunchedEffect(restoreFocus) {
        if (restoreFocus && rowFocus.requestFocus(FocusDirection.Enter)) {
            search.restoreFocus()
        }
    }
    Column(
        Modifier.fillMaxWidth()
            .heightIn(min = ChatListRowHeight)
            .clip(ChatListRowShape)
            .focusRequester(rowFocus)
            .focusProperties { canFocus = true }
            .clickable(role = Role.Button, onClick = onOpen)
            .padding(ChatListRowPadding),
        verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically),
    ) {
        Text(title, style = chatListTitleStyle(), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (snippet != null) {
            Text(
                snippet,
                style = searchSecondaryStyle(),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (metadata != null) {
            Text(
                metadata,
                style = searchSecondaryStyle(),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun SearchEmpty(@StringRes title: Int, onBroaden: (() -> Unit)?) {
    Column(
        Modifier.padding(top = 24.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            stringResource(title),
            Modifier.padding(horizontal = 12.dp),
            style = chatListTitleStyle().copy(fontWeight = FontWeight.SemiBold),
        )
        if (onBroaden != null) {
            Box(
                Modifier.heightIn(min = 48.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .clickable(role = Role.Button, onClick = onBroaden)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text(
                    stringResource(R.string.chat_search_all_types),
                    style = searchSecondaryStyle().copy(fontWeight = FontWeight.SemiBold),
                )
            }
        }
    }
}

@Composable
private fun searchSecondaryStyle() =
    MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp, lineHeight = 20.sp)

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

private fun highlightedSearchTitle(text: String, keyword: String): AnnotatedString {
    val start =
        keyword.takeIf(String::isNotEmpty)?.let { text.indexOf(it, ignoreCase = true) } ?: -1
    return buildAnnotatedString {
        append(text)
        if (start >= 0)
            addStyle(SpanStyle(fontWeight = FontWeight.SemiBold), start, start + keyword.length)
    }
}

private fun messageSnippet(hit: SearchMessageHit): AnnotatedString {
    val text = hit.content
    val first = hit.ranges.minByOrNull { it.first }
    var from = ((first?.first ?: 0) - 20).coerceAtLeast(0)
    var to = ((first?.last?.plus(1) ?: from) + 54).coerceAtMost(text.length)
    if (from > 0 && text[from].isLowSurrogate()) from--
    if (to < text.length && text[to].isLowSurrogate()) to++
    return buildAnnotatedString {
        if (from > 0) append('…')
        val leading = length
        append(text, from, to)
        for (range in hit.ranges) {
            val start = maxOf(range.first, from)
            val end = minOf(range.last + 1, to)
            if (start < end) {
                addStyle(
                    SpanStyle(fontWeight = FontWeight.SemiBold),
                    start - from + leading,
                    end - from + leading,
                )
            }
        }
        if (to < text.length) append('…')
    }
}

private fun ConfirmedChat.searchTitle(untitled: String): String =
    title?.takeIf(String::isNotBlank) ?: untitled
