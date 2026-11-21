package ai.okou.android.workflows

import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.R
import ai.okou.android.WorkspaceSearchField
import ai.okou.android.api.generated.WorkflowAutomation
import ai.okou.android.api.generated.WorkflowDetail
import ai.okou.android.api.generated.WorkflowSummary
import ai.okou.android.api.generated.WorkflowSummaryVisibility
import ai.okou.android.chat.ChatListSkeleton
import ai.okou.android.chat.rememberChatWaitIndicator
import ai.okou.android.state.ChatSearchState
import ai.okou.android.state.WorkflowScope
import ai.okou.android.state.WorkflowTab
import ai.okou.android.state.WorkflowsRoute
import ai.okou.android.workspaceSearchTextStyle
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
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
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect

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
    handoffFailed: Boolean,
    onClose: () -> Unit,
    onCreate: () -> Unit,
    onUse: (WorkflowDetail) -> Unit,
    sourceChatAvailable: (String) -> Boolean,
    onOpenChat: (String) -> Unit,
) {
    LifecycleResumeEffect(model) {
        model.visibilityChanged(true)
        onPauseOrDispose { model.visibilityChanged(false) }
    }
    val wide = listWidth != null
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    var discard by remember { mutableStateOf(false) }
    var restoreRow by remember { mutableStateOf<String?>(null) }
    val editor = state.editor
    fun exitEditor() {
        if (state.writing) return
        if (editor?.changed == true) discard = true else model.edit(null)
    }
    fun back() {
        when {
            editor != null -> exitEditor()
            state.writing -> Unit
            route.id != null && !wide && !handoffPending -> {
                restoreRow = route.id
                changeRoute(route.copy(id = null, tab = WorkflowTab.Instructions))
            }
            else -> onClose()
        }
    }
    BackHandler(onBack = ::back)
    if (discard) {
        AlertDialog(
            onDismissRequest = { discard = false },
            title = { Text(stringResource(R.string.workflow_discard_title)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        discard = false
                        model.edit(null)
                    }
                ) {
                    Text(stringResource(R.string.workflow_discard))
                }
            },
            dismissButton = {
                TextButton(onClick = { discard = false }) {
                    Text(stringResource(R.string.workflow_keep_editing))
                }
            },
        )
    }

    Row(
        Modifier.fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .imePadding()
    ) {
        if (wide || route.id == null) {
            WorkflowDirectory(
                state = state,
                route = route,
                query = query,
                modifier =
                    if (listWidth != null)
                        Modifier.widthIn(min = (listWidth - 1).dp, max = (listWidth - 1).dp)
                            .fillMaxHeight()
                    else Modifier.weight(1f).fillMaxHeight(),
                onBack = { if (editor != null) exitEditor() else if (!state.writing) onClose() },
                onCreate = onCreate,
                canNavigate = editor == null && !state.writing && !handoffPending,
                handoffFailed = handoffFailed,
                onScope = {
                    query.position.requestScrollToItem(0)
                    changeRoute(route.copy(scope = it))
                },
                onSelect = {
                    focus.clearFocus()
                    keyboard?.hide()
                    if (it != route.id)
                        changeRoute(route.copy(id = it, tab = WorkflowTab.Instructions))
                },
                restoreRow = restoreRow,
                onRowRestored = { restoreRow = null },
            )
        }
        if (wide) VerticalDivider(color = MaterialTheme.colorScheme.outline)
        if (wide || route.id != null) {
            Column(Modifier.weight(1f).fillMaxHeight()) {
                val detail = state.detail?.takeIf { it.id == route.id }
                if (!wide || editor != null)
                    WorkflowToolbar(
                        if (editor != null) stringResource(R.string.workflow_edit)
                        else stringResource(R.string.workspace_workflows),
                        ::back,
                    )
                when {
                    route.id == null -> WorkflowPlaceholder(R.string.workflow_select)
                    detail == null && state.detailFailure == WorkflowDetailFailure.Unavailable ->
                        WorkflowPlaceholder(R.string.workflow_unavailable)
                    detail == null && state.offline ->
                        WorkflowPlaceholder(R.string.workflow_offline)
                    detail == null && state.detailFailure != null ->
                        WorkflowPlaceholder(R.string.workflow_load_failed)
                    detail == null -> WorkflowSkeleton()
                    editor != null -> WorkflowEditor(detail, editor, state, model, ::exitEditor)
                    else ->
                        WorkflowDetailPane(
                            detail = detail,
                            state = state,
                            tab = route.tab,
                            position = positions[route.tab.ordinal],
                            wide = wide,
                            timezone = timezone,
                            onTab = { changeRoute(route.copy(tab = it)) },
                            onEdit = { model.edit(detail.editableInstructions()) },
                            onNewRule = {
                                model.edit(WorkflowEdit.Rule(null, RuleFields(timezone = timezone)))
                            },
                            onEditRule = { model.edit(it) },
                            onToggle = model::toggle,
                            handoffPending = handoffPending,
                            handoffFailed = handoffFailed,
                            onUse = { onUse(detail) },
                            sourceChatAvailable = sourceChatAvailable,
                            onOpenChat = onOpenChat,
                        )
                }
            }
        }
    }
}

@Composable
private fun WorkflowToolbar(
    title: String,
    onBack: () -> Unit,
    action: (@Composable () -> Unit)? = null,
) {
    Column {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(start = 12.dp, end = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
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
    modifier: Modifier,
    canNavigate: Boolean,
    handoffFailed: Boolean,
    onBack: () -> Unit,
    onCreate: () -> Unit,
    onScope: (WorkflowScope) -> Unit,
    onSelect: (String) -> Unit,
    restoreRow: String?,
    onRowRestored: () -> Unit,
) {
    val text = query.query.text.trim()
    val rows =
        remember(state.catalog, route.scope, text) {
            state.catalog?.filter { it.matches(route.scope, text) }.orEmpty()
        }
    val anchor = query.pendingAnchor
    LaunchedEffect(rows, anchor, state.catalog) {
        if (anchor != null && state.catalog != null)
            query.restorePosition(rows.indexOfFirst { it.id == anchor.chatId }.takeIf { it >= 0 })
    }
    Column(
        modifier.testTag("workflow_directory"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        WorkflowToolbar(stringResource(R.string.workspace_workflows), onBack) {
            TextButton(
                onClick = onCreate,
                enabled = canNavigate && state.enabled == true && !state.offline,
                modifier = Modifier.heightIn(min = 48.dp).testTag("workflow_create"),
                colors =
                    ButtonDefaults.textButtonColors(
                        contentColor = MaterialTheme.colorScheme.onBackground
                    ),
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp),
            ) {
                Icon(painterResource(R.drawable.ic_add), null, Modifier.size(18.dp))
                Spacer(Modifier.size(4.dp))
                Text(stringResource(R.string.workflow_new), style = workflowSmallStyle())
            }
        }
        if (state.enabled == false) {
            WorkflowPlaceholder(R.string.workflow_unavailable)
            return@Column
        }
        Column(
            Modifier.widthIn(max = 730.dp)
                .fillMaxWidth()
                .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            WorkflowQuery(query)
            FlowRow(
                Modifier.selectableGroup(),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                for (scope in WorkflowScope.entries) {
                    val selected = scope == route.scope
                    Box(
                        Modifier.heightIn(min = 48.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(
                                if (selected) MaterialTheme.colorScheme.secondaryContainer
                                else MaterialTheme.colorScheme.background
                            )
                            .selectable(
                                selected,
                                role = Role.RadioButton,
                                onClick = { onScope(scope) },
                            )
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(stringResource(scope.label), style = workflowSmallStyle())
                    }
                }
            }
        }
        if (handoffFailed) WorkflowNotice(R.string.workflow_draft_unavailable)
        when {
            state.catalog == null && state.offline -> WorkflowPlaceholder(R.string.workflow_offline)
            state.catalog == null && state.catalogFailed ->
                WorkflowPlaceholder(R.string.workflow_load_failed)
            state.catalog == null -> WorkflowSkeleton()
            rows.isEmpty() -> WorkflowEmpty(route.scope, text, query::reset, onScope)
            else -> {
                if (state.offline) WorkflowNotice(R.string.workflow_offline_cache)
                else if (state.catalogFailed) WorkflowNotice(R.string.workflow_refresh_failed)
                LazyColumn(
                    Modifier.widthIn(max = 730.dp).fillMaxWidth().weight(1f),
                    state = query.position,
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 20.dp),
                ) {
                    items(rows, key = { it.id }) { row ->
                        WorkflowRow(
                            row,
                            state.rules?.get(row.id) ?: state.rules?.let { emptyList() },
                            state.connections,
                            row.id == route.id,
                            canNavigate,
                            row.id == restoreRow,
                            onRowRestored,
                            onSelect = { onSelect(row.id) },
                        )
                    }
                }
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
private fun WorkflowQuery(query: ChatSearchState) {
    val name = stringResource(R.string.workflow_search)
    val requester = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    val style = workspaceSearchTextStyle()
    BasicTextField(
        value = query.query,
        onValueChange = query::edit,
        modifier =
            Modifier.fillMaxWidth()
                .focusRequester(requester)
                .onFocusChanged { focused = it.isFocused }
                .testTag("workflow_query")
                .semantics { contentDescription = name },
        textStyle = style.copy(color = colors.onBackground),
        singleLine = true,
        cursorBrush = SolidColor(colors.onBackground),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        decorationBox = { input ->
            WorkspaceSearchField(
                Modifier.fillMaxWidth(),
                focused = focused,
                hasTrailingAction = query.query.text.isNotEmpty(),
                shape = RoundedCornerShape(18.dp),
            ) {
                Box(Modifier.weight(1f).padding(vertical = 8.dp)) {
                    if (query.query.text.isEmpty())
                        Text(
                            name,
                            color = colors.onSurfaceVariant,
                            style = style,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    input()
                }
                if (query.query.text.isNotEmpty())
                    IconButton(
                        onClick = {
                            query.reset()
                            requester.requestFocus()
                        }
                    ) {
                        Icon(
                            painterResource(R.drawable.ic_close),
                            stringResource(R.string.workflow_clear_search),
                        )
                    }
            }
        },
    )
}

@Composable
private fun WorkflowEmpty(
    scope: WorkflowScope,
    text: String,
    reset: () -> Unit,
    onScope: (WorkflowScope) -> Unit,
) {
    Column(
        Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        when {
            text.isNotEmpty() -> {
                WorkflowSecondary(stringResource(R.string.workflow_no_matches))
                TextButton(onClick = reset) { Text(stringResource(R.string.workflow_clear_search)) }
            }
            scope != WorkflowScope.All -> {
                WorkflowSecondary(stringResource(R.string.workflow_empty_scope))
                TextButton(onClick = { onScope(WorkflowScope.All) }) {
                    Text(stringResource(R.string.workflow_show_all))
                }
            }
            else -> WorkflowSecondary(stringResource(R.string.workflow_empty))
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
            else R.string.workflow_shared
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
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 80.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) colors.secondaryContainer else colors.background)
            .focusRequester(requester)
            .selectable(selected, enabled = enabled, role = Role.Button, onClick = onSelect)
            .testTag("workflow_row_${item.id}")
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier.size(40.dp).background(colors.surfaceVariant, RoundedCornerShape(12.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(painterResource(glyph), null, Modifier.size(20.dp), tint = colors.onBackground)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                item.displayName ?: item.name,
                style = workflowBodyStyle(),
                fontWeight = FontWeight.SemiBold,
            )
            item.description
                ?.takeIf { it.isNotBlank() }
                ?.let {
                    Text(
                        it,
                        color = colors.onSurfaceVariant,
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
                        ) to LocalActivityStatusColor.current
                    !rules.isNullOrEmpty() ->
                        stringResource(R.string.workflow_paused) to colors.onSurfaceVariant
                    else -> null
                }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                WorkflowSecondary(listOfNotNull(scope, trigger).joinToString(" · "), small = true)
                status?.let { WorkflowStatus(it.first, it.second) }
            }
        }
        Icon(
            painterResource(R.drawable.ic_chevron_right),
            null,
            Modifier.align(Alignment.CenterVertically).size(18.dp),
            tint = colors.onBackground,
        )
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
    onTab: (WorkflowTab) -> Unit,
    onEdit: () -> Unit,
    onNewRule: () -> Unit,
    onEditRule: (WorkflowEdit.Rule) -> Unit,
    onToggle: (WorkflowAutomation) -> Unit,
    handoffPending: Boolean,
    handoffFailed: Boolean,
    onUse: () -> Unit,
    sourceChatAvailable: (String) -> Boolean,
    onOpenChat: (String) -> Unit,
) {
    val padding = if (wide) 32.dp else 20.dp
    Column(Modifier.fillMaxSize().testTag("workflow_detail")) {
        LazyColumn(
            Modifier.weight(1f)
                .widthIn(max = 730.dp)
                .fillMaxWidth()
                .align(Alignment.CenterHorizontally),
            state = position,
            contentPadding =
                PaddingValues(
                    start = padding,
                    end = padding,
                    top = if (wide) 24.dp else 16.dp,
                    bottom = 24.dp,
                ),
        ) {
            item(key = "header") { WorkflowDetailHeader(detail) }
            stickyHeader(key = "tabs") { WorkflowTabs(tab, onTab) }
            if (state.offline) item { WorkflowNotice(R.string.workflow_offline_cache) }
            else if (state.detailFailure == WorkflowDetailFailure.CouldNotLoad)
                item { WorkflowNotice(R.string.workflow_refresh_failed) }
            when (tab) {
                WorkflowTab.Instructions ->
                    item {
                        WorkflowSectionHeader(
                            R.string.workflow_instructions_heading,
                            if (detail.canManage) R.string.workflow_edit_instructions else null,
                            !state.offline && !state.writing && !handoffPending,
                            onEdit,
                        )
                        Text(
                            detail.instruction?.takeIf { it.isNotBlank() }
                                ?: stringResource(R.string.workflow_no_instructions),
                            style = workflowBodyStyle(),
                        )
                    }
                WorkflowTab.Automations -> {
                    item {
                        WorkflowSectionHeader(
                            R.string.workflow_automations,
                            if (detail.canManage) R.string.workflow_add_automation else null,
                            !state.offline && !state.writing && !handoffPending,
                            onNewRule,
                        )
                        if (state.issue != null) WorkflowNotice(R.string.workflow_write_failed)
                        if (detail.automations.isEmpty())
                            WorkflowSecondary(stringResource(R.string.workflow_no_rules))
                    }
                    items(detail.automations, key = { it.id }) { rule ->
                        WorkflowRuleRow(
                            rule,
                            state,
                            detail.canManage,
                            timezone,
                            onEditRule,
                            onToggle,
                        )
                        if (detail.automations.lastOrNull()?.id != rule.id) WorkflowDivider()
                    }
                }
                WorkflowTab.History -> {
                    val latest =
                        detail.automations
                            .filter { it.lastRunAt != null }
                            .sortedByDescending { it.lastRunAt }
                    item {
                        WorkflowSectionHeader(R.string.workflow_recent_runs)
                        if (latest.isEmpty())
                            WorkflowSecondary(stringResource(R.string.workflow_no_recent_runs))
                    }
                    items(latest, key = { it.id }) {
                        WorkflowHistoryRow(it, timezone, sourceChatAvailable, onOpenChat)
                    }
                }
            }
        }
        WorkflowDivider()
        val unavailable =
            detail.shadowedBy != null || handoffPending || state.writing || state.offline
        Column(
            Modifier.fillMaxWidth()
                .padding(start = padding, end = padding, top = 8.dp, bottom = 10.dp),
            horizontalAlignment = if (wide) Alignment.End else Alignment.CenterHorizontally,
        ) {
            if (detail.shadowedBy != null) WorkflowNotice(R.string.workflow_shadowed)
            else if (handoffFailed) WorkflowNotice(R.string.workflow_draft_unavailable)
            WorkflowAction(
                stringResource(R.string.workflow_use_in_chat),
                onUse,
                enabled = !unavailable,
                primary = true,
                modifier = (if (wide) Modifier else Modifier.fillMaxWidth()).testTag("workflow_use"),
            )
        }
    }
}

@Composable
private fun WorkflowDetailHeader(detail: WorkflowDetail) {
    Column(Modifier.padding(bottom = 12.dp)) {
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
                        MaterialTheme.colorScheme.surfaceVariant,
                        RoundedCornerShape(8.dp),
                    )
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                style =
                    MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp),
            )
            WorkflowSecondary(
                stringResource(
                    when {
                        detail.visibility.name == "PRIVATE" -> R.string.workflow_private
                        detail.canManage -> R.string.workflow_shared_manageable
                        else -> R.string.workflow_shared_usable
                    }
                ),
                small = true,
            )
        }
    }
}

@Composable
private fun WorkflowTabs(current: WorkflowTab, pick: (WorkflowTab) -> Unit) {
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background)) {
        Row(Modifier.selectableGroup()) {
            for (tab in WorkflowTab.entries) {
                val chosen = tab == current
                Box(
                    Modifier.weight(1f)
                        .heightIn(min = 48.dp)
                        .selectable(chosen, role = Role.Tab, onClick = { pick(tab) })
                        .testTag("workflow_tab_${tab.name.lowercase()}"),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(
                        Modifier.width(IntrinsicSize.Max).padding(horizontal = 4.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            stringResource(
                                when (tab) {
                                    WorkflowTab.Instructions -> R.string.workflow_instructions
                                    WorkflowTab.Automations -> R.string.workflow_automations
                                    WorkflowTab.History -> R.string.workflow_history
                                }
                            ),
                            Modifier.padding(vertical = 12.dp),
                            style =
                                MaterialTheme.typography.bodyMedium.copy(
                                    fontSize = 14.sp,
                                    lineHeight = 20.sp,
                                    fontWeight = FontWeight(550),
                                ),
                            textAlign = TextAlign.Center,
                        )
                        Box(
                            Modifier.fillMaxWidth()
                                .height(3.dp)
                                .clip(RoundedCornerShape(topStart = 3.dp, topEnd = 3.dp))
                                .background(
                                    if (chosen) LocalActivityStatusColor.current
                                    else MaterialTheme.colorScheme.background
                                )
                        )
                    }
                }
            }
        }
        WorkflowDivider()
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
internal fun WorkflowSectionHeader(
    label: Int,
    action: Int? = null,
    actionEnabled: Boolean = true,
    perform: () -> Unit = {},
) {
    Row(
        Modifier.fillMaxWidth().padding(bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            stringResource(label),
            Modifier.weight(1f).semantics { heading() },
            style = workflowBodyStyle(),
            fontWeight = FontWeight.SemiBold,
        )
        if (action != null) WorkflowAction(stringResource(action), perform, enabled = actionEnabled)
    }
}

@Composable
internal fun WorkflowAction(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    primary: Boolean = false,
) {
    val colors = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(12.dp)
    val padding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)
    if (primary) {
        Button(
            onClick,
            modifier.heightIn(min = 48.dp),
            enabled = enabled,
            shape = shape,
            colors =
                ButtonDefaults.buttonColors(
                    containerColor = colors.onBackground,
                    contentColor = colors.background,
                ),
            contentPadding = padding,
        ) {
            Text(
                label,
                style = workflowSmallStyle(),
                textAlign = TextAlign.Center,
                fontWeight = FontWeight(550),
            )
        }
    } else {
        OutlinedButton(
            onClick,
            modifier.heightIn(min = 48.dp),
            enabled = enabled,
            shape = shape,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.onBackground),
            border = BorderStroke(1.dp, colors.outline),
            contentPadding = padding,
        ) {
            Text(
                label,
                style = workflowSmallStyle(),
                textAlign = TextAlign.Center,
                fontWeight = FontWeight(550),
            )
        }
    }
}

@Composable
internal fun WorkflowDivider() = HorizontalDivider(color = MaterialTheme.colorScheme.outline)

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
private fun WorkflowSkeleton() {
    if (rememberChatWaitIndicator(true)) {
        Box(Modifier.fillMaxWidth().padding(16.dp).testTag("workflow_loading")) {
            ChatListSkeleton()
        }
    }
}

@Composable
internal fun WorkflowNotice(label: Int) {
    Text(
        stringResource(label),
        Modifier.padding(vertical = 4.dp).semantics { liveRegion = LiveRegionMode.Polite },
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = workflowSmallStyle(),
    )
}

@Composable
internal fun WorkflowStatus(label: String, color: androidx.compose.ui.graphics.Color) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(7.dp).background(color, CircleShape))
        Text(
            label,
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
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
