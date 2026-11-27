package ai.okou.android.connectors

import ai.okou.android.ContentReadFeedbackDelayMillis
import ai.okou.android.DirectoryReturnFocus
import ai.okou.android.R
import ai.okou.android.WorkspaceMenu
import ai.okou.android.WorkspaceMenuItem
import ai.okou.android.WorkspaceSearchGroupHeading
import ai.okou.android.WorkspaceSearchInput
import ai.okou.android.WorkspaceToolDirectoryRow
import ai.okou.android.WorkspaceToolDirectoryRowSkeleton
import ai.okou.android.chat.ChatSkeletonBlock
import ai.okou.android.hasPendingSearchText
import ai.okou.android.rememberContentReadFeedbackAfter
import ai.okou.android.rememberContentReadSkeleton
import ai.okou.android.restoreDirectoryFocus
import ai.okou.android.retainSearchResultsWhileComposing
import ai.okou.android.searchClearAction
import ai.okou.android.state.ConnectorDirectoryState
import ai.okou.android.state.rememberConnectorDirectory
import ai.okou.android.updates.updateFocusOutline
import ai.okou.android.workspaceToolListItemShapes
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.util.Locale
import kotlin.time.Duration.Companion.milliseconds

@Composable
internal fun ConnectorsPage(
    model: ConnectorModel,
    listWidth: Int?,
    initialSlug: String? = null,
    initialAccountId: String? = null,
    close: () -> Unit,
) {
    val state by model.uiState.collectAsStateWithLifecycle()
    val route = rememberConnectorDirectory(initialSlug)
    val discoverPosition = rememberLazyListState()
    val connectedPosition = rememberLazyListState()
    val directoryAnnouncements = remember(model) { ConnectorReadAnnouncements() }
    val detailAnnouncements = remember(model) { ConnectorReadAnnouncements() }
    val focus = LocalFocusManager.current
    val inputMode = LocalInputModeManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val filter =
        if (route.connected) ConnectorBrowseFilter.of("", route.category)
        else ConnectorBrowseFilter.of(route.committedQuery.text, route.category)
    val returnFocus =
        remember(route, route.connected, filter, route.committedQuery.text.trim()) {
            DirectoryReturnFocus()
        }
    val wide = listWidth != null
    val selected = route.slug
    val directoryVisible = wide || selected == null

    DisposableEffect(model) {
        model.setOpen(true)
        onDispose { model.setOpen(false) }
    }
    LifecycleStartEffect(model) {
        model.resume()
        onStopOrDispose { model.pause() }
    }
    LaunchedEffect(model, selected) { model.select(selected) }
    LaunchedEffect(model, filter) { model.setFilter(filter) }
    LaunchedEffect(model, route.connected, directoryVisible) {
        if (directoryVisible) model.enterDirectoryTab(route.connected)
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { model.resume() }

    fun closePage() {
        // A navigation exit ends the selection. Activity recreation keeps the same route.
        model.select(null)
        close()
    }

    fun back() {
        focus.clearFocus()
        keyboard?.hide()
        if (initialSlug == null && !wide && selected != null) {
            returnFocus.returningFrom("connector-$selected", inputMode.inputMode)
            route.slug = null
        } else {
            closePage()
        }
    }

    fun setQuery(value: TextFieldValue) {
        if (value.composition == null && route.committedQuery.text != value.text) {
            discoverPosition.requestScrollToItem(0)
            connectedPosition.requestScrollToItem(0)
        }
        route.editQuery(value)
    }

    fun setCategory(value: String?) {
        discoverPosition.requestScrollToItem(0)
        connectedPosition.requestScrollToItem(0)
        route.category = value
    }

    BackHandler(onBack = ::back)
    Row(
        Modifier.fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .safeDrawingPadding()
            .imePadding(),
    ) {
        if (directoryVisible) {
            ConnectorDirectory(
                route,
                state,
                filter,
                if (route.connected) connectedPosition else discoverPosition,
                directoryAnnouncements,
                selected = selected.takeIf { wide },
                returnFocus = returnFocus,
                onBack = ::back,
                editQuery = ::setQuery,
                setCategory = ::setCategory,
                open = { entry ->
                    returnFocus.cancel()
                    if (!wide || inputMode.inputMode != InputMode.Keyboard) focus.clearFocus()
                    keyboard?.hide()
                    route.slug = entry.slug
                    model.select(entry.slug, entry)
                },
                modifier =
                    (if (listWidth == null) Modifier.weight(1f) else Modifier.width(listWidth.dp))
                        .fillMaxHeight(),
            )
        }
        if (wide) VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        if (selected != null) {
            Column(Modifier.weight(1f).fillMaxHeight()) {
                if (!wide) ConnectorTopBar(stringResource(R.string.connector_title), ::back)
                val matchingState = state.takeIf { it.slug == selected }
                val entry =
                    remember(
                        state.browse.data,
                        state.matches,
                        state.connected.data,
                        route.connected,
                        filter,
                        selected,
                    ) {
                        val catalog =
                            state.matches
                                ?.takeIf { it.filter == filter }
                                ?.entries
                                ?.data
                                ?.entries
                                ?.find { it.slug == selected }
                                ?: state.browse.data?.entries?.find { it.slug == selected }
                        val connected = state.connected.data?.get(selected)?.entry
                        if (route.connected && connected != null) {
                            catalog?.copy(icon = connected.icon) ?: connected
                        } else catalog ?: connected
                    }
                key(selected) {
                    ConnectorDetails(
                        model,
                        matchingState ?: ConnectorUiState(),
                        entry ?: matchingState?.selectedPreview,
                        wide,
                        detailAnnouncements,
                        initialAccountId = initialAccountId.takeIf { selected == initialSlug },
                        onCloseInitialAccount = ::closePage,
                    )
                }
            }
        } else if (wide) {
            Box(
                Modifier.weight(1f).fillMaxHeight().padding(16.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    stringResource(R.string.connector_choose),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = connectorFeedbackType(),
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConnectorTopBar(title: String, back: () -> Unit) {
    val typography =
        MaterialTheme.typography.titleLarge.copy(
            fontSize = 20.sp,
            lineHeight = 28.sp,
            letterSpacing = 0.sp,
            fontWeight = FontWeight.SemiBold,
        )
    val height =
        with(LocalDensity.current) { (typography.lineHeight.toDp() + 16.dp).coerceAtLeast(64.dp) }
    TopAppBar(
        title = { Text(title, style = typography, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        navigationIcon = {
            IconButton(onClick = back, modifier = Modifier.padding(start = 8.dp)) {
                Icon(painterResource(R.drawable.ic_arrow_back), stringResource(R.string.back))
            }
        },
        expandedHeight = height,
        windowInsets = WindowInsets(0),
        colors =
            TopAppBarDefaults.topAppBarColors(
                containerColor = MaterialTheme.colorScheme.background,
            ),
    )
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
}

@Composable
private fun ConnectorDirectory(
    route: ConnectorDirectoryState,
    state: ConnectorUiState,
    filter: ConnectorBrowseFilter?,
    position: LazyListState,
    announcements: ConnectorReadAnnouncements,
    selected: String?,
    returnFocus: DirectoryReturnFocus,
    onBack: () -> Unit,
    editQuery: (TextFieldValue) -> Unit,
    setCategory: (String?) -> Unit,
    open: (ConnectorEntry) -> Unit,
    modifier: Modifier = Modifier,
) {
    val query = route.committedQuery.text.trim()
    val restoreRow = returnFocus.pending?.rowKey
    val searchFocus = remember { FocusRequester() }
    val clearQuery = searchClearAction(searchFocus) { editQuery(TextFieldValue()) }
    val directory =
        key(
            route,
            route.connected,
            filter,
            query,
            state.browse.failure == ConnectorReadFailure.Unavailable,
            state.connected.failure == ConnectorReadFailure.Unavailable,
            state.matches?.entries?.failure == ConnectorReadFailure.Unavailable,
            state.accounts.failure == ConnectorReadFailure.Unavailable,
        ) {
            retainSearchResultsWhileComposing(
                state,
                hasPendingSearchText(route.query.text, route.query.composition, query),
            )
        }
    val recommended = !route.connected && filter == null
    val connected = directory.connected.data
    val filtered =
        filter
            ?.takeUnless { route.connected && connected?.isEmpty() == true }
            ?.let { current ->
                directory.matches?.takeIf { it.filter == current }?.entries ?: ConnectorRead()
            }
    val catalogRead = filtered ?: directory.browse
    val serviceEntries = catalogRead.data?.entries
    val failure =
        if (route.connected)
            listOfNotNull(directory.connected.failure, filtered?.failure).maxOrNull()
        else catalogRead.failure
    val entries =
        remember(
            route.connected,
            route.category,
            query,
            recommended,
            serviceEntries,
            connected,
            directory.slug,
            directory.accounts.data,
        ) {
            when {
                route.connected -> {
                    if (filtered != null && serviceEntries == null) return@remember null
                    val bySlug = serviceEntries.orEmpty().associateBy { it.slug }
                    connected
                        ?.mapNotNull { (slug, service) ->
                            val entry =
                                bySlug[slug]?.copy(icon = service.entry.icon)
                                    ?: if (filtered != null) return@mapNotNull null
                                    else service.entry
                            if (
                                entry.matches(query) ||
                                    directory.accountsFor(slug).any { account ->
                                        account.displayName?.contains(query, ignoreCase = true) ==
                                            true ||
                                            account.identity?.contains(query, ignoreCase = true) ==
                                                true
                                    }
                            )
                                entry
                            else null
                        }
                        ?.sortedWith(compareBy { it.name.lowercase(Locale.ROOT) })
                }
                recommended -> serviceEntries?.let(::recommendedConnectors)
                else -> serviceEntries?.filter { route.category == null || it.matches(query) }
            }
        }

    val startedAt =
        when {
            entries != null || failure != null -> null
            !route.connected || connected != null -> catalogRead.startedAt
            filtered == null || serviceEntries != null -> directory.connected.startedAt
            // Connected with a cold category needs both of these results.
            else ->
                listOfNotNull(directory.connected.startedAt, filtered.startedAt)
                    .takeIf { it.size == 2 }
                    ?.minByOrNull { it.elapsedNow() }
        }
    val showSkeleton =
        key(route.connected, filter) {
            val remaining =
                remember(startedAt) {
                    startedAt?.let {
                        (ContentReadFeedbackDelayMillis.milliseconds - it.elapsedNow())
                            .inWholeMilliseconds
                            .coerceAtLeast(0)
                    }
                }
            rememberContentReadFeedbackAfter(remaining, readScope = startedAt)
        }
    val notice =
        when {
            entries == null || failure == ConnectorReadFailure.Unavailable -> null
            route.connected ->
                listOfNotNull(directory.connected.notice(), filtered?.notice())
                    .maxByOrNull(ConnectorReadNotice::round)
            else -> catalogRead.notice()
        }
    val restoreFocus = remember { FocusRequester() }
    val tabFocus = remember { List(2) { FocusRequester() } }
    val selectedTab = if (route.connected) 1 else 0
    Column(
        modifier.restoreDirectoryFocus(
            returnFocus,
            entries != null || failure != null,
            position,
            restoreFocus,
            tabFocus[selectedTab],
            rowEnabled =
                restoreRow != null && entries?.any { "connector-${it.slug}" == restoreRow } == true,
        ),
    ) {
        ConnectorTopBar(stringResource(R.string.connector_title), onBack)
        Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) directoryContent@{
            Spacer(Modifier.height(12.dp))
            ConnectorTabs(selectedTab, tabFocus) { route.connected = it }
            Spacer(Modifier.height(8.dp))
            ConnectorFilters(
                route,
                directory.browse.data?.categories ?: catalogRead.data?.categories.orEmpty(),
                searchFocus,
                editQuery,
                clearQuery,
                setCategory,
            )
            if (entries == null && failure != null) {
                val viewport =
                    if (failure == ConnectorReadFailure.Unavailable) Modifier
                    else Modifier.weight(1f)
                ConnectorReadFailureContent(
                    failure,
                    R.string.connector_load_failed,
                    viewport.testTag("connector-directory"),
                )
                return@directoryContent
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize().testTag("connector-directory"),
                    state = position,
                    contentPadding = PaddingValues(top = 8.dp, bottom = 16.dp),
                ) {
                    if (entries.isNullOrEmpty()) {
                        item {
                            when {
                                entries == null ->
                                    if (showSkeleton) ConnectorDirectorySkeleton(recommended)
                                query.isNotEmpty() ->
                                    ConnectorEmpty(
                                        R.string.connector_no_match,
                                        R.string.connector_clear,
                                        clearQuery,
                                    )
                                route.category != null ->
                                    ConnectorEmpty(
                                        R.string.connector_empty_category,
                                        R.string.connector_clear_category,
                                    ) {
                                        setCategory(null)
                                    }
                                route.connected ->
                                    ConnectorEmpty(
                                        R.string.connector_empty_connected,
                                        R.string.connector_discover_action,
                                    ) {
                                        route.connected = false
                                    }
                                else -> ConnectorEmpty(R.string.connector_no_recommendations)
                            }
                        }
                    } else {
                        if (recommended) {
                            item(key = "recommendations") {
                                WorkspaceSearchGroupHeading(
                                    stringResource(R.string.connector_recommended),
                                    Modifier.padding(horizontal = 16.dp),
                                )
                            }
                        }
                        items(entries, key = { "connector-${it.slug}" }) { entry ->
                            val restoring = restoreRow == "connector-${entry.slug}"
                            ConnectorDirectoryRow(
                                entry,
                                directory.accountsFor(entry.slug),
                                showDescription = !route.connected,
                                selected == entry.slug,
                                (if (restoring) Modifier.focusRequester(restoreFocus) else Modifier)
                                    .testTag("connector-${entry.slug}"),
                            ) {
                                open(entry)
                            }
                        }
                    }
                }
                key(route.connected, filter, query) {
                    ConnectorReadFeedbackHost(
                        notice,
                        announcements,
                        Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp),
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConnectorTabs(selected: Int, focus: List<FocusRequester>, select: (Boolean) -> Unit) {
    val accent = MaterialTheme.colorScheme.primary
    PrimaryTabRow(
        selectedTabIndex = selected,
        containerColor = MaterialTheme.colorScheme.background,
        contentColor = MaterialTheme.colorScheme.onBackground,
        indicator = {
            Box(
                Modifier.tabIndicatorOffset(selected, matchContentSize = true)
                    .height(3.dp)
                    .clip(RoundedCornerShape(topStart = 3.dp, topEnd = 3.dp))
                    .background(accent),
            )
        },
        divider = { HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant) },
    ) {
        listOf(R.string.connector_discover, R.string.connector_connected).forEachIndexed {
            index,
            label ->
            Tab(
                selected = selected == index,
                onClick = { select(index == 1) },
                modifier =
                    Modifier.heightIn(min = 48.dp)
                        .focusRequester(focus[index])
                        .updateFocusOutline(
                            RoundedCornerShape(8.dp),
                            MaterialTheme.colorScheme.onBackground,
                        )
                        .onPreviewKeyEvent { event ->
                            if (
                                event.type == KeyEventType.KeyDown &&
                                    event.key in listOf(Key.DirectionLeft, Key.DirectionRight)
                            ) {
                                select(index == 0)
                                focus[1 - index].requestFocus()
                                true
                            } else false
                        },
                text = {
                    Text(
                        stringResource(label),
                        style = MaterialTheme.typography.labelLarge,
                    )
                },
                selectedContentColor = accent,
                unselectedContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ConnectorFilters(
    route: ConnectorDirectoryState,
    categories: Set<String>,
    searchFocus: FocusRequester,
    editQuery: (TextFieldValue) -> Unit,
    clearQuery: () -> Unit,
    setCategory: (String?) -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    var restoreFocus by remember { mutableStateOf(false) }
    val categoryFocus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val colors = MaterialTheme.colorScheme
    val categoryShape = RoundedCornerShape(12.dp)
    val categoryLabel =
        route.category?.let { connectorCategory(it) }
            ?: stringResource(R.string.connector_any_category)

    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WorkspaceSearchInput(
            value = route.query,
            onValueChange = editQuery,
            label = stringResource(R.string.connector_search),
            onClear = clearQuery,
            modifier = Modifier.weight(1f).focusRequester(searchFocus).testTag("connector-search"),
            clearLabel = stringResource(R.string.connector_clear),
        )
        Box {
            IconButton(
                onClick = {
                    keyboard?.hide()
                    menu = true
                },
                modifier =
                    Modifier.size(48.dp)
                        .focusRequester(categoryFocus)
                        .updateFocusOutline(categoryShape, colors.onSurface)
                        .clip(categoryShape)
                        .background(
                            if (route.category == null) colors.background
                            else colors.secondaryContainer,
                        )
                        .semantics { stateDescription = categoryLabel },
            ) {
                Icon(
                    painterResource(R.drawable.ic_filter_list),
                    stringResource(R.string.connector_category_filter),
                )
            }
            if (menu) {
                val entries = categories.map { it to connectorCategory(it) }.sortedBy { it.second }
                fun close() {
                    menu = false
                    restoreFocus = true
                }
                WorkspaceMenu(
                    listOf(
                        WorkspaceMenuItem(
                            stringResource(R.string.connector_any_category),
                            selected = route.category == null,
                        ) {
                            setCategory(null)
                            close()
                        },
                    ) +
                        entries.map { (category, title) ->
                            WorkspaceMenuItem(title, selected = route.category == category) {
                                setCategory(category)
                                close()
                            }
                        },
                    close = ::close,
                )
            }
        }
    }
    LaunchedEffect(menu, restoreFocus) {
        if (!menu && restoreFocus) {
            restoreFocus = false
            categoryFocus.requestFocus()
        }
    }
}

@Composable
private fun ConnectorDirectoryRow(
    entry: ConnectorEntry,
    accounts: List<ConnectorSavedAccount>,
    showDescription: Boolean,
    selected: Boolean,
    modifier: Modifier,
    open: () -> Unit,
) {
    val hasDescription = (showDescription || accounts.isEmpty()) && entry.description.isNotBlank()
    WorkspaceToolDirectoryRow(
        title = entry.name,
        selected = selected,
        onClick = open,
        modifier = modifier,
        leading = { ConnectorMark(entry.icon, 20.dp) },
        supportingContent =
            if (hasDescription || accounts.isNotEmpty()) {
                {
                    Column {
                        if (hasDescription)
                            Text(entry.description, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        if (accounts.isNotEmpty()) ConnectorDirectoryStatus(accounts)
                    }
                }
            } else null,
    )
}

@Composable
private fun ConnectorDirectoryStatus(accounts: List<ConnectorSavedAccount>) {
    val available = accounts.count { it.status == ConnectorAccountStatus.Connected }
    val attention = accounts.any { it.status.needsAttention }
    val message =
        when {
            attention && accounts.size == 1 -> connectorAccountStatus(accounts.single())
            attention && available > 0 ->
                stringResource(
                    R.string.connector_ready_attention,
                    pluralStringResource(R.plurals.connector_ready_count, available, available),
                )
            attention -> stringResource(R.string.connector_needs_attention)
            available == accounts.size ->
                pluralStringResource(R.plurals.connector_connected_count, available, available)
            else ->
                pluralStringResource(
                    R.plurals.connector_accounts_count,
                    accounts.size,
                    accounts.size,
                )
        }
    val colors = MaterialTheme.colorScheme
    Row(
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (attention || available > 0) {
            Box(
                Modifier.size(7.dp)
                    .background(
                        if (attention) colors.error else MaterialTheme.colorScheme.primary,
                        CircleShape,
                    ),
            )
        }
        Text(message)
    }
}

@Composable
internal fun ConnectorChevron() {
    Icon(painterResource(R.drawable.ic_chevron_right), null, Modifier.size(18.dp))
}

@Composable
internal fun ConnectorNavigationRow(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    leadingContent: @Composable (() -> Unit)? = null,
    supportingContent: @Composable (() -> Unit)? = null,
    trailingContent: @Composable () -> Unit = { ConnectorChevron() },
    content: @Composable () -> Unit,
) {
    val shapes = workspaceToolListItemShapes()
    val colors =
        ListItemDefaults.colors(
            containerColor = Color.Transparent,
            disabledContainerColor = Color.Transparent,
        )
    ListItem(
        onClick = onClick,
        modifier =
            modifier
                .fillMaxWidth()
                .semantics { role = Role.Button }
                .updateFocusOutline(shapes.focusedShape, colors.contentColor, keyboardOnly = true),
        enabled = enabled,
        leadingContent = leadingContent,
        supportingContent = supportingContent,
        trailingContent = trailingContent,
        shapes = shapes,
        colors = colors,
        content = content,
    )
}

@Composable
private fun ConnectorDirectorySkeleton(recommended: Boolean) {
    val label = stringResource(R.string.connector_loading)
    val (titleSlot, supportingSlot) =
        with(LocalDensity.current) {
            val type = MaterialTheme.typography
            type.bodyLarge.lineHeight.toDp() to type.bodyMedium.lineHeight.toDp()
        }
    Column(Modifier.fillMaxWidth().semantics { contentDescription = label }) {
        if (recommended)
            WorkspaceSearchGroupHeading(
                stringResource(R.string.connector_recommended),
                Modifier.padding(horizontal = 16.dp),
            )
        repeat(3) {
            WorkspaceToolDirectoryRowSkeleton(
                modifier = Modifier.testTag("connector-directory-skeleton-row"),
                supportingContent = {
                    Box(Modifier.height(supportingSlot), contentAlignment = Alignment.CenterStart) {
                        ChatSkeletonBlock(Modifier.width(144.dp).height(10.dp))
                    }
                },
            ) {
                Box(Modifier.height(titleSlot), contentAlignment = Alignment.CenterStart) {
                    ChatSkeletonBlock(Modifier.width(96.dp).height(14.dp))
                }
            }
        }
    }
}

@Composable
internal fun ConnectorSkeleton(label: String, rows: Int) {
    if (!rememberContentReadSkeleton()) return
    Column(Modifier.fillMaxWidth().semantics { contentDescription = label }) {
        repeat(rows) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 80.dp).padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(
                    Modifier.size(40.dp)
                        .background(
                            MaterialTheme.colorScheme.surfaceVariant,
                            RoundedCornerShape(12.dp),
                        ),
                )
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(
                        Modifier.widthIn(max = 144.dp)
                            .fillMaxWidth()
                            .height(14.dp)
                            .background(
                                MaterialTheme.colorScheme.surfaceVariant,
                                RoundedCornerShape(4.dp),
                            ),
                    )
                    Box(
                        Modifier.widthIn(max = 220.dp)
                            .fillMaxWidth()
                            .height(10.dp)
                            .background(
                                MaterialTheme.colorScheme.surfaceVariant,
                                RoundedCornerShape(4.dp),
                            ),
                    )
                }
            }
        }
    }
}

@Composable
private fun ConnectorEmpty(title: Int, action: Int? = null, onAction: () -> Unit = {}) {
    Column(
        Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            stringResource(title),
            style = connectorBodyType().copy(fontWeight = FontWeight.SemiBold),
        )
        if (action != null)
            ConnectorButton(
                stringResource(action),
                onAction,
                treatment = ConnectorButtonTreatment.Text,
            )
    }
}

@Composable
internal fun ConnectorStatusBanner(message: Int, error: Boolean = false) {
    Text(
        stringResource(message),
        Modifier.padding(bottom = 8.dp, top = 4.dp)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(12.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        color =
            if (error) MaterialTheme.colorScheme.error
            else MaterialTheme.colorScheme.onSurfaceVariant,
        style = connectorFeedbackType(),
    )
}

@Composable
internal fun connectorBodyType() =
    MaterialTheme.typography.bodyLarge.copy(
        fontSize = 16.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.sp,
    )

@Composable
internal fun connectorSmallType() =
    MaterialTheme.typography.bodySmall.copy(
        fontSize = 13.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.sp,
    )

@Composable
internal fun connectorFeedbackType() =
    MaterialTheme.typography.bodyMedium.copy(
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.sp,
    )

@Composable
internal fun connectorAccountStatus(account: ConnectorSavedAccount): String =
    stringResource(
        when (account.status) {
            ConnectorAccountStatus.Reauthorize -> R.string.connector_needs_auth
            ConnectorAccountStatus.UpdatePermissions -> R.string.connector_needs_permissions
            ConnectorAccountStatus.Connected ->
                if (account.defaultEnabled == true) R.string.connector_default_status
                else R.string.connector_account_connected
            ConnectorAccountStatus.Unknown -> R.string.connector_account_unknown
        },
    )

internal val ConnectorAccountStatus.needsAttention: Boolean
    get() =
        this == ConnectorAccountStatus.Reauthorize ||
            this == ConnectorAccountStatus.UpdatePermissions

private fun ConnectorEntry.matches(query: String) =
    query.isEmpty() ||
        name.contains(query, ignoreCase = true) ||
        slug.contains(query, ignoreCase = true)

@Composable
private fun connectorCategory(category: String): String {
    val name =
        when (category) {
            "communication-collaboration" -> R.string.connector_category_collaboration
            "docs-files-knowledge" -> R.string.connector_category_docs
            "meetings-scheduling" -> R.string.connector_category_meetings
            "email" -> R.string.connector_category_email
            "productivity" -> R.string.connector_category_productivity
            "engineering-team-execution" -> R.string.connector_category_developer
            "data-automation-infrastructure" -> R.string.connector_category_data
            "marketing-content-growth" -> R.string.connector_category_marketing
            "sales-crm-business-operations" -> R.string.connector_category_sales
            "finance" -> R.string.connector_category_finance
            "ai" -> R.string.connector_category_ai
            "other" -> R.string.connector_category_other
            else -> null
        }
    return name?.let { stringResource(it) }
        ?: category.replace('-', ' ').replaceFirstChar { it.titlecase() }
}
