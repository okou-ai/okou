package ai.okou.android.workflows

import ai.okou.android.ContentReadFailure
import ai.okou.android.OkouConfirmationDialog
import ai.okou.android.R
import ai.okou.android.WorkspaceFeedbackTimeout
import ai.okou.android.WorkspaceFilterRow
import ai.okou.android.WorkspaceSearchInput
import ai.okou.android.WorkspaceToolDirectoryRow
import ai.okou.android.api.generated.WorkflowAutomation
import ai.okou.android.api.generated.WorkflowDetail
import ai.okou.android.api.generated.WorkflowDetailVisibility
import ai.okou.android.api.generated.WorkflowSummary
import ai.okou.android.api.generated.WorkflowSummaryVisibility
import ai.okou.android.chat.ChatListTextAction
import ai.okou.android.chat.ChatSkeletonBlock
import ai.okou.android.rememberContentReadSkeleton
import ai.okou.android.retainSearchResultsWhileComposing
import ai.okou.android.searchClearAction
import ai.okou.android.state.ChatSearchState
import ai.okou.android.state.WorkflowConnectorVisit
import ai.okou.android.state.WorkflowDraftAction
import ai.okou.android.state.WorkflowScope
import ai.okou.android.state.WorkflowTab
import ai.okou.android.state.WorkflowsRoute
import ai.okou.android.state.rememberWorkflowDiscardConfirmation
import ai.okou.android.state.rememberWorkflowEditorReturnFocus
import ai.okou.android.updates.updateFocusOutline
import ai.okou.android.workspaceSearchFocusOutline
import androidx.activity.compose.BackHandler
import androidx.annotation.StringRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRowDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.InputModeManager
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private const val SECTION_EDITOR_FOCUS = "section"

@Composable
internal fun WorkflowScreen(
    model: WorkflowModel,
    state: WorkflowState,
    route: WorkflowsRoute,
    changeRoute: (WorkflowsRoute) -> Unit,
    query: ChatSearchState,
    positions: List<LazyListState>,
    listWidth: Int?,
    timezone: String,
    handoffPending: Boolean,
    createError: Int?,
    useError: Int?,
    readAnnouncements: WorkflowReadAnnouncements,
    actionSnackbar: SnackbarHostState,
    onClose: () -> Unit,
    onCreate: (Boolean) -> Unit,
    onUse: (WorkflowDetail, Boolean) -> Unit,
    onDraftFocusRestored: () -> Unit,
    onViewConnection: ((slug: String, ruleId: String?) -> Unit)?,
    connectionReturn: WorkflowConnectorVisit?,
    onConnectionFocusRestored: () -> Unit,
    sourceChatAvailable: (String) -> Boolean,
    restoreHistoryRunId: String?,
    onHistoryFocusRestored: () -> Unit,
    onOpenChat: (runId: String, threadId: String) -> Unit,
    directEntry: Boolean = false,
) {
    val wide = listWidth != null
    val focus = LocalFocusManager.current
    val inputMode = LocalInputModeManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val editing = state.editing
    val detail = state.detail?.takeIf { it.id == route.id }
    SideEffect {
        readAnnouncements.directory.retainAll(
            listOfNotNull(state.catalogFailure, state.rulesFailure, state.connectionsFailure),
        )
        readAnnouncements.detail.retainAll(
            listOfNotNull(state.detailFailure, state.connectionsFailure, state.historyFailure),
        )
    }
    val connectionReadApplies =
        if (editing != null)
            (editing.draft as? WorkflowEdit.Rule)?.value?.trigger?.source?.connector != null
        else
            route.tab == WorkflowTab.Automations &&
                detail?.automations?.any { it.source.connector != null } == true
    val detailNotice =
        if (detail == null) null
        else
            listOfNotNull(
                    state.detailFailure.notice(),
                    state.connectionReadNotice().takeIf { connectionReadApplies },
                    state.historyFailure.notice().takeIf {
                        editing == null &&
                            route.tab == WorkflowTab.History &&
                            state.history != null &&
                            state.historyRead?.earlier != true
                    },
                )
                .maxByOrNull { it.failure.sequence }
    // Keep the action timeout with the detail pane across tab and editor changes.
    if (route.id != null) WorkspaceFeedbackTimeout(actionSnackbar)
    val detailFeedback: @Composable () -> Unit = {
        key(route.id, route.tab, editing != null) {
            WorkflowReadFeedbackHost(detailNotice, readAnnouncements.detail, actionSnackbar)
        }
    }
    var editorReturnFocus by rememberWorkflowEditorReturnFocus(route.id, route.tab)
    var discard by rememberWorkflowDiscardConfirmation(route.id, editing != null)
    var restoreRow by remember { mutableStateOf<String?>(null) }
    val draftFocusAction = route.draftReturn?.action
    val canNavigate = editing == null && !state.writing
    fun exitEditor() {
        val current = model.state.value
        if (current.writing || current.editing !== editing) return
        if (editing?.draft?.changed == true) discard = true else model.edit(null)
    }
    fun back() {
        when {
            editing != null -> exitEditor()
            state.writing -> Unit
            route.id != null && !wide && !directEntry && !handoffPending -> {
                restoreRow = route.id
                changeRoute(route.copy(id = null, tab = WorkflowTab.Instructions))
            }
            else -> onClose()
        }
    }
    BackHandler(onBack = ::back)
    if (discard && editing != null && detail != null) {
        OkouConfirmationDialog(
            title = stringResource(R.string.workflow_discard_title),
            confirm = stringResource(R.string.workflow_discard),
            dismissLabel = stringResource(R.string.workflow_keep_editing),
            onDismiss = { discard = false },
            onConfirm = {
                discard = false
                if (model.state.value.editing === editing) model.edit(null)
            },
        ) {
            Text(
                stringResource(
                    R.string.workflow_discard_detail,
                    detail.displayName ?: detail.name,
                ),
            )
        }
    }

    Row(
        Modifier.fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .imePadding(),
    ) {
        if (wide || route.id == null) {
            WorkflowDirectory(
                state = state,
                route = route,
                query = query,
                announced = readAnnouncements.directory,
                modifier =
                    if (listWidth != null)
                        Modifier.widthIn(min = (listWidth - 1).dp, max = (listWidth - 1).dp)
                            .fillMaxHeight()
                    else Modifier.weight(1f).fillMaxHeight(),
                onBack = { if (editing != null) exitEditor() else if (!state.writing) onClose() },
                onCreate = onCreate,
                restoreCreateFocus =
                    !handoffPending && draftFocusAction == WorkflowDraftAction.Create,
                onCreateFocusRestored = onDraftFocusRestored,
                canNavigate = canNavigate && !handoffPending,
                keepCreateFocus =
                    canNavigate && handoffPending && draftFocusAction == WorkflowDraftAction.Create,
                createError = createError,
                onScope = {
                    if (it != route.scope) {
                        query.position.requestScrollToItem(0)
                        changeRoute(route.copy(scope = it))
                    }
                },
                onSelect = {
                    if (!wide || inputMode.inputMode != InputMode.Keyboard) focus.clearFocus()
                    keyboard?.hide()
                    if (it != route.id)
                        changeRoute(route.copy(id = it, tab = WorkflowTab.Instructions))
                },
                restoreRow = restoreRow,
                onRowRestored = { restoreRow = null },
            )
        }
        if (wide) VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        if (wide || route.id != null) {
            Column(Modifier.weight(1f).fillMaxHeight()) {
                if (!wide || editing != null)
                    WorkflowToolbar(
                        if (editing != null) stringResource(R.string.workflow_edit)
                        else stringResource(R.string.workspace_workflows),
                        ::back,
                    )
                when {
                    route.id == null -> WorkflowPlaceholder(R.string.workflow_select)
                    detail == null ->
                        WorkflowPendingDetail(wide, state.detailFailure, detailFeedback)
                    editing != null ->
                        WorkflowEditor(
                            detail,
                            editing,
                            state,
                            model,
                            wide,
                            feedback = detailFeedback,
                            discarding = discard,
                            onCancel = ::exitEditor,
                            onViewConnection =
                                onViewConnection?.let { open -> { slug -> open(slug, null) } },
                            restoreConnectionFocus =
                                connectionReturn != null && connectionReturn.ruleId == null,
                            onConnectionFocusRestored = onConnectionFocusRestored,
                        )
                    else ->
                        WorkflowDetailPane(
                            detail = detail,
                            state = state,
                            tab = route.tab,
                            position = positions[route.tab.ordinal],
                            wide = wide,
                            timezone = timezone,
                            feedback = detailFeedback,
                            onTab = { if (it != route.tab) changeRoute(route.copy(tab = it)) },
                            editorReturnFocus = editorReturnFocus,
                            onEditorFocusRestored = { editorReturnFocus = null },
                            onEdit = { edit, focused ->
                                editorReturnFocus = edit.focusKey.takeIf { focused }
                                model.edit(edit)
                            },
                            onToggle = model::toggle,
                            onViewConnection = onViewConnection,
                            connectionReturn = connectionReturn,
                            onConnectionFocusRestored = onConnectionFocusRestored,
                            handoffPending = handoffPending,
                            useError = useError,
                            onUse = { focused -> onUse(detail, focused) },
                            restoreUseFocus =
                                !handoffPending && draftFocusAction == WorkflowDraftAction.Use,
                            keepUseFocus =
                                handoffPending && draftFocusAction == WorkflowDraftAction.Use,
                            onUseFocusRestored = onDraftFocusRestored,
                            sourceChatAvailable = sourceChatAvailable,
                            restoreHistoryRunId = restoreHistoryRunId,
                            onHistoryFocusRestored = onHistoryFocusRestored,
                            onOpenChat = onOpenChat,
                            onEarlierRuns = model::loadEarlierRuns,
                        )
                }
            }
        }
    }
}

private val WorkflowEdit.focusKey: String
    get() = (this as? WorkflowEdit.Rule)?.id?.let(::ruleEditorFocusKey) ?: SECTION_EDITOR_FOCUS

private fun ruleEditorFocusKey(ruleId: String) = "rule:$ruleId"

@Composable
private fun WorkflowToolbar(
    title: String,
    onBack: () -> Unit,
    action: (@Composable () -> Unit)? = null,
) {
    Column {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = onBack,
                modifier = Modifier.workspaceSearchFocusOutline(CircleShape),
            ) {
                Icon(painterResource(R.drawable.ic_arrow_back), stringResource(R.string.back))
            }
            Text(
                title,
                Modifier.weight(1f).semantics { heading() },
                style =
                    MaterialTheme.typography.titleLarge.copy(
                        fontSize = 20.sp,
                        lineHeight = 28.sp,
                        fontWeight = FontWeight.SemiBold,
                    ),
            )
            action?.invoke()
        }
        WorkflowDivider()
    }
}

@Composable
private fun WorkflowDirectory(
    state: WorkflowState,
    route: WorkflowsRoute,
    query: ChatSearchState,
    announced: MutableSet<WorkflowReadFailure.Failed>,
    modifier: Modifier,
    canNavigate: Boolean,
    keepCreateFocus: Boolean,
    createError: Int?,
    onBack: () -> Unit,
    onCreate: (Boolean) -> Unit,
    restoreCreateFocus: Boolean,
    onCreateFocusRestored: () -> Unit,
    onScope: (WorkflowScope) -> Unit,
    onSelect: (String) -> Unit,
    restoreRow: String?,
    onRowRestored: () -> Unit,
) {
    val text = query.keyword
    val searchFocus = remember { FocusRequester() }
    val clearQuery = searchClearAction(searchFocus, query::clearQuery)
    val displayedState =
        if (state.catalogFailure == WorkflowReadFailure.Unavailable) state
        else key(query) { retainSearchResultsWhileComposing(state, query.hasPendingInput) }
    val catalog =
        remember(displayedState.catalog, state.catalog) {
            val displayed = displayedState.catalog
            val current = state.catalog
            when {
                current == null -> null
                displayed == null || displayed === current -> displayed
                else -> {
                    // Preserve composition order without restoring rows removed by the current
                    // catalog.
                    val visibleIds = current.mapTo(mutableSetOf()) { it.id }
                    displayed.filter { it.id in visibleIds }
                }
            }
        }
    val rules = displayedState.rules.takeIf { state.rules != null }
    val connections = displayedState.connections.takeIf { state.connections != null }
    val rows =
        remember(catalog, route.scope, text) {
            catalog?.filter { it.matches(route.scope, text) }.orEmpty()
        }
    val accessFeedback =
        if (catalog == null) null
        else if (state.rulesFailure == WorkflowReadFailure.Unavailable)
            R.string.workflow_rules_load_failed
        else state.connectionAccessFeedback()
    val readNotice =
        if (catalog == null) null
        else
            listOfNotNull(
                    state.catalogFailure.notice(R.string.workflow_catalog_refresh_failed),
                    state.rulesFailure.notice(
                        if (state.rules == null) R.string.workflow_rules_load_failed
                        else R.string.workflow_refresh_failed,
                    ),
                    state.connectionReadNotice(),
                )
                .maxByOrNull { it.failure.sequence }
    KeepWorkflowReadStart(query.position, accessFeedback != null)
    val anchor = query.pendingAnchor
    LaunchedEffect(rows, anchor, catalog, accessFeedback != null) {
        if (anchor != null && catalog != null) {
            val rowIndex = rows.indexOfFirst { it.id == anchor.key }
            query.restorePosition(
                when {
                    rowIndex >= 0 -> rowIndex + if (accessFeedback == null) 0 else 1
                    anchor.key == DIRECTORY_READ_FEEDBACK && accessFeedback != null -> 0
                    else -> null
                },
            )
        }
    }
    Column(
        modifier.testTag("workflow_directory"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        WorkflowToolbar(stringResource(R.string.workspace_workflows), onBack) {
            val enabled =
                (canNavigate || keepCreateFocus) &&
                    state.catalogFailure != WorkflowReadFailure.Unavailable
            val actionFocus =
                rememberWorkflowReturnFocus(restoreCreateFocus, enabled, onCreateFocusRestored)
            val shape = RoundedCornerShape(12.dp)
            TextButton(
                onClick = { if (!keepCreateFocus) onCreate(actionFocus.keyboardFocused) },
                enabled = enabled,
                modifier =
                    actionFocus.modifier
                        .semantics { if (keepCreateFocus) disabled() }
                        .heightIn(min = 48.dp)
                        .updateFocusOutline(shape, MaterialTheme.colorScheme.onBackground)
                        .testTag("workflow_create"),
                shape = shape,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Icon(painterResource(R.drawable.ic_add), null, Modifier.size(18.dp))
                Spacer(Modifier.size(6.dp))
                Text(
                    stringResource(R.string.workflow_new),
                    style = workflowSmallStyle(),
                    fontWeight = FontWeight(550),
                )
            }
        }
        if (state.catalogFailure == WorkflowReadFailure.Unavailable) {
            Box(Modifier.widthIn(max = 730.dp).fillMaxWidth()) {
                WorkflowInitialReadError(R.string.workflow_unavailable)
            }
            return@Column
        }
        Column(
            Modifier.widthIn(max = 730.dp)
                .fillMaxWidth()
                .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (createError != null) WorkflowNotice(createError)
            WorkspaceSearchInput(
                value = query.query,
                onValueChange = query::edit,
                label = stringResource(R.string.workflow_search),
                onClear = clearQuery,
                modifier =
                    Modifier.fillMaxWidth()
                        .focusRequester(searchFocus)
                        .onFocusChanged { if (!it.isFocused) query.cancelComposition() }
                        .testTag("workflow_query"),
                clearLabel = stringResource(R.string.workflow_clear_search),
            )
            WorkspaceFilterRow(
                WorkflowScope.entries,
                route.scope,
                Role.RadioButton,
                label = { stringResource(it.label) },
                modifier = Modifier.fillMaxWidth(),
                optionModifier = { Modifier.testTag("workflow_scope_${it.name}") },
                onSelect = onScope,
            )
        }
        Box(Modifier.weight(1f).widthIn(max = 730.dp).fillMaxWidth()) {
            when {
                catalog == null && state.catalogFailure != null ->
                    WorkflowReadFailureContent(Modifier.fillMaxSize().padding(horizontal = 16.dp))
                catalog == null -> WorkflowSkeleton(directory = true)
                else ->
                    LazyColumn(
                        Modifier.fillMaxSize(),
                        state = query.position,
                        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 20.dp),
                    ) {
                        if (accessFeedback != null)
                            item(key = DIRECTORY_READ_FEEDBACK) {
                                WorkflowNotice(accessFeedback, PaddingValues(bottom = 12.dp))
                            }
                        if (rows.isEmpty())
                            item(key = "workflow_directory_empty") {
                                WorkflowEmpty(
                                    route.scope,
                                    text,
                                    clearQuery,
                                    onScope,
                                    topPadding = if (accessFeedback == null) 24.dp else 0.dp,
                                )
                            }
                        items(rows, key = { it.id }) { row ->
                            WorkflowRow(
                                row,
                                rules?.let { it[row.id].orEmpty() },
                                connections,
                                row.id == route.id,
                                canNavigate,
                                row.id == restoreRow,
                                onRowRestored,
                                onSelect = { onSelect(row.id) },
                            )
                        }
                    }
            }
            Box(Modifier.align(Alignment.BottomCenter)) {
                key(route.scope, text) { WorkflowReadFeedbackHost(readNotice, announced) }
            }
        }
    }
}

internal fun WorkflowSummary.matches(scope: WorkflowScope, query: String): Boolean {
    val visible =
        when (scope) {
            WorkflowScope.All -> true
            WorkflowScope.Private -> visibility == WorkflowSummaryVisibility.PRIVATE
            WorkflowScope.Shared -> visibility == WorkflowSummaryVisibility.PUBLIC
        }
    return visible &&
        (displayName?.contains(query, ignoreCase = true) == true ||
            description?.contains(query, ignoreCase = true) == true ||
            "/$name".contains(query, ignoreCase = true))
}

private val WorkflowScope.label: Int
    get() =
        when (this) {
            WorkflowScope.All -> R.string.workflow_all
            WorkflowScope.Private -> R.string.workflow_private
            WorkflowScope.Shared -> R.string.workflow_shared
        }

@Composable
private fun WorkflowEmpty(
    scope: WorkflowScope,
    text: String,
    reset: () -> Unit,
    onScope: (WorkflowScope) -> Unit,
    topPadding: Dp,
) {
    val hasQuery = text.isNotEmpty()
    val scoped = scope != WorkflowScope.All
    val title =
        when {
            hasQuery -> R.string.workflow_no_matches
            scoped -> R.string.workflow_empty_scope
            else -> R.string.workflow_empty
        }
    Column(
        Modifier.fillMaxWidth().padding(top = topPadding),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            stringResource(title),
            Modifier.padding(horizontal = 12.dp).semantics {
                heading()
                liveRegion = LiveRegionMode.Polite
            },
            style = workflowBodyStyle().copy(fontWeight = FontWeight.SemiBold),
        )
        val recovery = Modifier.workspaceSearchFocusOutline(RoundedCornerShape(12.dp))
        when {
            hasQuery ->
                ChatListTextAction(R.string.workflow_clear_search, recovery, onClick = reset)
            scoped ->
                ChatListTextAction(R.string.workflow_show_all, recovery) {
                    onScope(WorkflowScope.All)
                }
        }
    }
}

@Composable
private fun WorkflowRow(
    item: WorkflowSummary,
    rules: List<WorkflowAutomation>?,
    connections: Set<String>?,
    selected: Boolean,
    enabled: Boolean,
    restoreFocus: Boolean,
    onRestored: () -> Unit,
    onSelect: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val sources = remember(rules) { rules.orEmpty().map { it.source }.distinct() }
    val glyph = sources.singleOrNull()?.icon ?: R.drawable.ic_account_tree
    val scope =
        stringResource(
            if (item.visibility == WorkflowSummaryVisibility.PRIVATE) R.string.workflow_private
            else R.string.workflow_shared,
        )
    val trigger =
        when {
            rules == null -> null
            sources.isEmpty() -> stringResource(R.string.workflow_manual)
            else -> sources.map { stringResource(it.label) }.joinToString(" · ")
        }
    val requester = remember { FocusRequester() }
    LaunchedEffect(restoreFocus, enabled) {
        if (restoreFocus && enabled) {
            requester.requestFocus()
            onRestored()
        }
    }
    WorkspaceToolDirectoryRow(
        title = item.displayName ?: item.name,
        selected = selected,
        onClick = onSelect,
        modifier = Modifier.focusRequester(requester).testTag("workflow_row_${item.id}"),
        enabled = enabled,
        leading = {
            Icon(painterResource(glyph), null, Modifier.size(20.dp), tint = colors.onBackground)
        },
    ) { supportingColor ->
        item.description
            ?.takeIf { it.isNotBlank() }
            ?.let {
                Text(
                    it,
                    color = supportingColor,
                    style = workflowSmallStyle(),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        val enabledCount = rules.orEmpty().count { it.enabled }
        val status =
            when {
                rules.orEmpty().any { it.needsConnection(connections) } ->
                    stringResource(R.string.workflow_needs_connection) to colors.error
                enabledCount > 0 ->
                    pluralStringResource(
                        R.plurals.workflow_enabled_count,
                        enabledCount,
                        enabledCount,
                    ) to MaterialTheme.colorScheme.primary
                !rules.isNullOrEmpty() ->
                    stringResource(R.string.workflow_paused) to colors.onSurfaceVariant
                else -> null
            }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                listOfNotNull(scope, trigger).joinToString(" · "),
                color = supportingColor,
                style = workflowSmallStyle(),
            )
            status?.let { WorkflowStatus(it.first, it.second, supportingColor) }
        }
    }
}

@Composable
private fun WorkflowDetailPane(
    detail: WorkflowDetail,
    state: WorkflowState,
    tab: WorkflowTab,
    position: LazyListState,
    wide: Boolean,
    timezone: String,
    feedback: @Composable () -> Unit,
    onTab: (WorkflowTab) -> Unit,
    editorReturnFocus: String?,
    onEditorFocusRestored: () -> Unit,
    onEdit: (WorkflowEdit, Boolean) -> Unit,
    onToggle: (WorkflowAutomation) -> Unit,
    onViewConnection: ((slug: String, ruleId: String?) -> Unit)?,
    connectionReturn: WorkflowConnectorVisit?,
    onConnectionFocusRestored: () -> Unit,
    handoffPending: Boolean,
    useError: Int?,
    onUse: (Boolean) -> Unit,
    restoreUseFocus: Boolean,
    keepUseFocus: Boolean,
    onUseFocusRestored: () -> Unit,
    sourceChatAvailable: (String) -> Boolean,
    restoreHistoryRunId: String?,
    onHistoryFocusRestored: () -> Unit,
    onOpenChat: (runId: String, threadId: String) -> Unit,
    onEarlierRuns: () -> Unit,
) {
    val padding = if (wide) 32.dp else 20.dp
    val contentWidth = Modifier.widthIn(max = 730.dp).fillMaxWidth()
    val listPadding =
        PaddingValues(
            start = padding,
            end = padding,
            top = if (wide) 24.dp else 16.dp,
            bottom = 24.dp,
        )
    // An empty loading layout must not clamp the saved position of a long history.
    val pendingHistory = tab == WorkflowTab.History && state.history == null
    val listState = if (pendingHistory) rememberLazyListState() else position
    val historyLayout =
        if (pendingHistory) remember(listPadding) { WorkflowHistoryLayout(listPadding) } else null
    val editEnabled = !state.writing && !handoffPending
    Column(
        Modifier.fillMaxSize().testTag("workflow_detail"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(contentWidth.weight(1f)) {
            LazyColumn(
                Modifier.fillMaxSize().then(historyLayout?.list ?: Modifier),
                state = listState,
                contentPadding = listPadding,
            ) {
                item(key = "header") {
                    WorkflowDetailHeader(detail, historyLayout?.detail ?: Modifier)
                }
                stickyHeader(key = "tabs") {
                    WorkflowTabs(tab, onTab, historyLayout?.tabs ?: Modifier)
                }
                when (tab) {
                    WorkflowTab.Instructions ->
                        item {
                            WorkflowSectionHeader(R.string.workflow_instructions_heading) {
                                if (detail.canManage) {
                                    WorkflowEditorAction(
                                        R.string.workflow_edit_instructions,
                                        enabled = editEnabled,
                                        restoreFocus = editorReturnFocus == SECTION_EDITOR_FOCUS,
                                        onFocusRestored = onEditorFocusRestored,
                                    ) { focused ->
                                        onEdit(detail.editableInstructions(), focused)
                                    }
                                }
                            }
                            Text(
                                detail.instruction?.takeIf { it.isNotBlank() }
                                    ?: stringResource(R.string.workflow_no_instructions),
                                style = workflowBodyStyle(),
                            )
                        }
                    WorkflowTab.Automations -> {
                        item(key = "workflow_trigger_rules_heading") {
                            WorkflowSectionHeader(R.string.workflow_trigger_rules) {
                                if (detail.canAddAutomation) {
                                    WorkflowEditorAction(
                                        R.string.workflow_add_automation,
                                        enabled = editEnabled,
                                        restoreFocus = editorReturnFocus == SECTION_EDITOR_FOCUS,
                                        onFocusRestored = onEditorFocusRestored,
                                    ) { focused ->
                                        onEdit(
                                            WorkflowEdit.Rule(
                                                null,
                                                RuleFields(timezone = timezone),
                                            ),
                                            focused,
                                        )
                                    }
                                }
                            }
                        }
                        val connectionFeedback =
                            state.connectionAccessFeedback().takeIf {
                                detail.automations.any { it.source.connector != null }
                            }
                        if (connectionFeedback != null)
                            item(key = "workflow_connections_read_feedback") {
                                WorkflowNotice(connectionFeedback, PaddingValues(bottom = 12.dp))
                            }
                        if (detail.automations.isEmpty())
                            item(key = "workflow_no_rules") {
                                WorkflowSecondary(stringResource(R.string.workflow_no_rules))
                            }
                        items(detail.automations, key = { it.id }) { rule ->
                            WorkflowRuleRow(
                                rule = rule,
                                state = state,
                                actionsEnabled = !handoffPending,
                                timezone = timezone,
                                onEdit = onEdit,
                                restoreEditorFocus =
                                    editorReturnFocus == ruleEditorFocusKey(rule.id),
                                onEditorFocusRestored = onEditorFocusRestored,
                                onToggle = onToggle,
                                onViewConnection = onViewConnection,
                                restoreConnectionFocus = connectionReturn?.ruleId == rule.id,
                                onConnectionFocusRestored = onConnectionFocusRestored,
                            )
                            if (detail.automations.lastOrNull()?.id != rule.id) WorkflowDivider()
                        }
                    }
                    WorkflowTab.History -> {
                        val history = state.history
                        val earlier = state.historyRead?.earlier == true
                        item(key = "history_heading") {
                            WorkflowSectionHeader(
                                R.string.workflow_recent_runs,
                                historyLayout?.heading ?: Modifier,
                            )
                        }
                        if (history == null) {
                            item(key = "history_pending") {
                                WorkflowHistoryPending(
                                    state.historyFailure,
                                    historyLayout?.body ?: Modifier,
                                )
                            }
                        } else if (history.runs.isEmpty()) {
                            item(key = "history_empty") {
                                WorkflowSecondary(stringResource(R.string.workflow_no_recent_runs))
                            }
                        }
                        items(history?.runs.orEmpty(), key = { it.id }) { run ->
                            WorkflowHistoryRow(
                                run = run,
                                timezone = timezone,
                                sourceChatAvailable = sourceChatAvailable,
                                sourceNavigationEnabled = !handoffPending,
                                restoreFocus = run.id == restoreHistoryRunId,
                                onFocusRestored = onHistoryFocusRestored,
                                onOpenChat = onOpenChat,
                            )
                        }
                        if (history?.nextCursor != null) {
                            if (earlier && state.historyFailure != null)
                                item(key = "workflow_history_page_feedback") {
                                    WorkflowNotice(
                                        R.string.workflow_history_earlier_failed,
                                        PaddingValues(top = 12.dp),
                                    )
                                }
                            item(key = "history_earlier") {
                                ChatListTextAction(
                                    if (state.historyRead == WorkflowHistoryRead.Earlier)
                                        R.string.workflow_history_loading
                                    else R.string.workflow_history_earlier,
                                    onClick = onEarlierRuns,
                                    enabled = !handoffPending && state.historyRead?.loading != true,
                                    modifier =
                                        Modifier.workspaceSearchFocusOutline(
                                                RoundedCornerShape(12.dp),
                                            )
                                            .testTag("workflow_earlier_runs"),
                                )
                            }
                        }
                    }
                }
            }
            Box(Modifier.align(Alignment.BottomCenter)) { feedback() }
        }
        WorkflowUseBar(
            wide = wide,
            enabled =
                detail.shadowedBy == null && (!handoffPending || keepUseFocus) && !state.writing,
            pending = keepUseFocus,
            notice = if (detail.shadowedBy != null) R.string.workflow_shadowed else useError,
            onUse = onUse,
            restoreFocus = restoreUseFocus,
            onFocusRestored = onUseFocusRestored,
        )
    }
}

@Composable
private fun WorkflowPendingDetail(
    wide: Boolean,
    failure: WorkflowReadFailure?,
    feedback: @Composable () -> Unit,
) {
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.weight(1f).widthIn(max = 730.dp).fillMaxWidth()) {
            when (failure) {
                null -> WorkflowSkeleton(directory = false)
                WorkflowReadFailure.Unavailable ->
                    WorkflowInitialReadError(R.string.workflow_unavailable)
                is WorkflowReadFailure.Failed ->
                    WorkflowReadFailureContent(
                        Modifier.fillMaxSize().padding(horizontal = if (wide) 32.dp else 20.dp),
                    )
            }
            Box(Modifier.align(Alignment.BottomCenter)) { feedback() }
        }
        WorkflowUseBar(wide = wide, enabled = false, onUse = {})
    }
}

@Composable
private fun WorkflowUseBar(
    wide: Boolean,
    enabled: Boolean,
    notice: Int? = null,
    restoreFocus: Boolean = false,
    pending: Boolean = false,
    onFocusRestored: () -> Unit = {},
    onUse: (Boolean) -> Unit,
) {
    WorkflowDivider()
    Column(
        Modifier.widthIn(max = 730.dp)
            .fillMaxWidth()
            .padding(horizontal = if (wide) 32.dp else 20.dp)
            .padding(top = 8.dp, bottom = 10.dp),
        horizontalAlignment = if (wide) Alignment.End else Alignment.CenterHorizontally,
    ) {
        if (notice != null) WorkflowNotice(notice, PaddingValues(bottom = 8.dp))
        val actionFocus = rememberWorkflowReturnFocus(restoreFocus, enabled, onFocusRestored)
        WorkflowAction(
            stringResource(R.string.workflow_use_in_chat),
            { if (!pending) onUse(actionFocus.keyboardFocused) },
            enabled = enabled,
            primary = true,
            modifier =
                actionFocus.modifier
                    .semantics { if (pending) disabled() }
                    .then(if (wide) Modifier else Modifier.fillMaxWidth())
                    .testTag("workflow_use"),
        )
    }
}

@Composable
private fun WorkflowDetailHeader(detail: WorkflowDetail, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    Column(modifier.padding(bottom = 20.dp)) {
        Text(
            detail.displayName ?: detail.name,
            Modifier.semantics { heading() }.testTag("workflow_detail_title"),
            style =
                MaterialTheme.typography.headlineSmall.copy(
                    fontSize = 24.sp,
                    lineHeight = 32.sp,
                    fontWeight = FontWeight.SemiBold,
                ),
        )
        detail.description
            ?.takeIf { it.isNotBlank() }
            ?.let { Text(it, Modifier.padding(top = 8.dp), style = workflowBodyStyle()) }
        FlowRow(
            Modifier.padding(top = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "/${detail.name}",
                Modifier.background(
                        colors.tertiaryContainer,
                        RoundedCornerShape(8.dp),
                    )
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                color = colors.onTertiaryContainer,
                style =
                    MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp),
            )
            WorkflowSecondary(
                stringResource(
                    when {
                        detail.visibility == WorkflowDetailVisibility.PRIVATE ->
                            R.string.workflow_private
                        detail.canManage -> R.string.workflow_shared_manageable
                        else -> R.string.workflow_shared_usable
                    },
                ),
                small = true,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WorkflowTabs(
    current: WorkflowTab,
    pick: (WorkflowTab) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val tabs = WorkflowTab.entries
    val tabFocus = remember { List(WorkflowTab.entries.size) { FocusRequester() } }
    val stepRight = if (LocalLayoutDirection.current == LayoutDirection.Ltr) 1 else -1
    Column(modifier.fillMaxWidth().background(colors.background)) {
        PrimaryTabRow(
            selectedTabIndex = current.ordinal,
            containerColor = colors.background,
            indicator = {
                TabRowDefaults.PrimaryIndicator(
                    Modifier.tabIndicatorOffset(current.ordinal, matchContentSize = true),
                    width = Dp.Unspecified,
                    height = 3.dp,
                    shape = RoundedCornerShape(topStart = 3.dp, topEnd = 3.dp),
                    color = colors.primary,
                )
            },
            divider = { WorkflowDivider() },
        ) {
            tabs.forEachIndexed { index, tab ->
                Tab(
                    selected = tab == current,
                    onClick = { pick(tab) },
                    modifier =
                        Modifier.heightIn(min = 48.dp)
                            .focusRequester(tabFocus[index])
                            .updateFocusOutline(RoundedCornerShape(8.dp), colors.onBackground)
                            .onPreviewKeyEvent { event ->
                                val next =
                                    when (event.key) {
                                        Key.DirectionLeft ->
                                            (index - stepRight + tabs.size) % tabs.size
                                        Key.DirectionRight ->
                                            (index + stepRight + tabs.size) % tabs.size
                                        Key.MoveHome -> 0
                                        Key.MoveEnd -> tabs.lastIndex
                                        else -> return@onPreviewKeyEvent false
                                    }
                                if (event.type == KeyEventType.KeyDown) {
                                    tabFocus[next].requestFocus()
                                    pick(tabs[next])
                                }
                                true
                            }
                            .testTag("workflow_tab_${tab.name.lowercase()}"),
                    selectedContentColor = colors.primary,
                    unselectedContentColor = colors.onSurfaceVariant,
                ) {
                    Text(
                        stringResource(
                            when (tab) {
                                WorkflowTab.Instructions -> R.string.workflow_instructions
                                WorkflowTab.Automations -> R.string.workflow_automations
                                WorkflowTab.History -> R.string.workflow_history
                            },
                        ),
                        Modifier.padding(horizontal = 8.dp, vertical = 8.dp),
                        style =
                            MaterialTheme.typography.bodyMedium.copy(
                                fontSize = 14.sp,
                                lineHeight = 20.sp,
                                fontWeight = FontWeight(550),
                            ),
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun WorkflowSectionHeader(
    label: Int,
    modifier: Modifier = Modifier,
    action: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier.fillMaxWidth().padding(bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            stringResource(label),
            Modifier.weight(1f).semantics { heading() },
            style = workflowBodyStyle(),
            fontWeight = FontWeight.SemiBold,
        )
        action?.invoke()
    }
}

internal class WorkflowActionFocus(private val inputMode: InputModeManager) {
    val requester = FocusRequester()
    private var focused = false
    val modifier = Modifier.focusRequester(requester).onFocusChanged { focused = it.isFocused }
    val keyboardFocused: Boolean
        get() = focused && inputMode.inputMode == InputMode.Keyboard
}

@Composable
internal fun rememberWorkflowReturnFocus(
    restoreFocus: Boolean,
    enabled: Boolean,
    onFocusRestored: () -> Unit,
): WorkflowActionFocus {
    val input = LocalInputModeManager.current
    val focus = remember(input) { WorkflowActionFocus(input) }
    LaunchedEffect(restoreFocus, enabled) {
        if (
            restoreFocus &&
                enabled &&
                (input.inputMode != InputMode.Keyboard || focus.requester.requestFocus())
        ) {
            onFocusRestored()
        }
    }
    return focus
}

@Composable
internal fun WorkflowAction(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    primary: Boolean = false,
    @StringRes pendingStatus: Int? = null,
    showPendingProgress: Boolean = true,
) {
    val colors = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(12.dp)
    val padding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)
    val showProgress = pendingStatus != null && showPendingProgress
    val pendingSemantics =
        if (pendingStatus != null) {
            val status = stringResource(pendingStatus)
            Modifier.clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
                stateDescription = status
                if (showProgress) liveRegion = LiveRegionMode.Polite
                disabled()
            }
        } else Modifier
    val click = { if (pendingStatus == null) onClick() }
    val content: @Composable () -> Unit = {
        Box(contentAlignment = Alignment.Center) {
            Text(
                label,
                color = if (showProgress) Color.Transparent else Color.Unspecified,
                style = workflowSmallStyle(),
                textAlign = TextAlign.Center,
                fontWeight = FontWeight(550),
            )
            if (showProgress) {
                CircularProgressIndicator(
                    Modifier.size(16.dp),
                    color = LocalContentColor.current,
                    strokeWidth = 2.dp,
                )
            }
        }
    }
    if (primary) {
        Button(
            click,
            modifier
                .heightIn(min = 48.dp)
                .updateFocusOutline(shape, colors.onPrimary)
                .then(pendingSemantics),
            enabled = enabled,
            shape = shape,
            contentPadding = padding,
        ) {
            content()
        }
    } else {
        var focused by remember { mutableStateOf(false) }
        val keyboardFocused =
            focused && LocalInputModeManager.current.inputMode == InputMode.Keyboard
        OutlinedButton(
            click,
            modifier
                .heightIn(min = 48.dp)
                .onFocusChanged { focused = it.isFocused }
                .then(pendingSemantics),
            enabled = enabled,
            shape = shape,
            border =
                if (enabled && keyboardFocused) BorderStroke(2.dp, colors.onBackground)
                else ButtonDefaults.outlinedButtonBorder(enabled),
            contentPadding = padding,
        ) {
            content()
        }
    }
}

@Composable
internal fun WorkflowDivider() = HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

@Composable
internal fun WorkflowSecondary(text: String, small: Boolean = false) {
    Text(
        text,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style =
            if (small) workflowSmallStyle()
            else workflowBodyStyle().copy(fontSize = 14.sp, lineHeight = 20.sp),
    )
}

@Composable
private fun WorkflowPlaceholder(label: Int) {
    Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.Center) {
        Text(
            stringResource(label),
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = workflowBodyStyle().copy(fontSize = 14.sp, lineHeight = 20.sp),
        )
    }
}

@Composable
private fun WorkflowSkeleton(directory: Boolean) {
    if (rememberContentReadSkeleton()) {
        val label = stringResource(R.string.workspace_workflows)
        Column(
            Modifier.fillMaxWidth().padding(16.dp).testTag("workflow_loading").semantics {
                contentDescription = label
                progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate
            },
        ) {
            if (directory) {
                repeat(5) {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 80.dp).padding(12.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        ChatSkeletonBlock(Modifier.size(40.dp), 12.dp)
                        Column(
                            Modifier.weight(1f),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            ChatSkeletonBlock(Modifier.fillMaxWidth(.7f).height(14.dp))
                            ChatSkeletonBlock(Modifier.fillMaxWidth(.5f).height(14.dp))
                        }
                    }
                }
            } else {
                ChatSkeletonBlock(Modifier.fillMaxWidth(.6f).height(24.dp))
                Spacer(Modifier.height(12.dp))
                ChatSkeletonBlock(Modifier.fillMaxWidth(.8f).height(14.dp))
            }
        }
    }
}

private const val DIRECTORY_READ_FEEDBACK = "workflow_directory_read_feedback"

@Composable
private fun KeepWorkflowReadStart(position: LazyListState, hasFeedback: Boolean) {
    val previous = remember(position) { mutableStateOf(hasFeedback) }
    SideEffect {
        if (previous.value != hasFeedback) {
            // Rows keep their keyed offset mid-list. A reader at the top sees new feedback.
            if (!position.canScrollBackward) position.requestScrollToItem(0)
            previous.value = hasFeedback
        }
    }
}

@Composable
internal fun WorkflowInitialReadError(label: Int) {
    WorkflowNotice(label, PaddingValues(start = 12.dp, top = 24.dp, end = 12.dp))
}

@Composable
internal fun WorkflowReadFailureContent(modifier: Modifier) {
    ContentReadFailure(
        R.string.chat_list_first_load_failed,
        modifier.fillMaxWidth().testTag("workflow_read_failure"),
    )
}

@Composable
internal fun WorkflowNotice(label: Int, padding: PaddingValues = PaddingValues(vertical = 4.dp)) {
    Text(
        stringResource(label),
        Modifier.padding(padding).semantics { liveRegion = LiveRegionMode.Polite },
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = workflowBodyStyle().copy(fontSize = 14.sp, lineHeight = 20.sp),
    )
}

@Composable
internal fun WorkflowStatus(
    label: String,
    color: Color,
    textColor: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(7.dp).background(color, CircleShape))
        Text(
            label,
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp),
            color = textColor,
        )
    }
}

@Composable
internal fun workflowBodyStyle() =
    MaterialTheme.typography.bodyLarge.copy(
        fontSize = 16.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.sp,
    )

@Composable
internal fun workflowSmallStyle() =
    MaterialTheme.typography.bodySmall.copy(
        fontSize = 13.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.sp,
    )
