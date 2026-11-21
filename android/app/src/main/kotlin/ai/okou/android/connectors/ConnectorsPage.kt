package ai.okou.android.connectors

import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.R
import ai.okou.android.WorkspaceMenu
import ai.okou.android.WorkspaceMenuItem
import ai.okou.android.state.ConnectorDirectoryState
import ai.okou.android.state.rememberConnectorDirectory
import ai.okou.android.workspaceSearchControlHeight
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
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalDensity
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
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.util.Locale

@Composable
internal fun ConnectorsPage(model: ConnectorModel, listWidth: Int?, close: () -> Unit) {
    val state by model.uiState.collectAsStateWithLifecycle()
    val route = rememberConnectorDirectory()
    val discoverPosition = rememberLazyListState()
    val connectedPosition = rememberLazyListState()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    var restoreRow by remember { mutableStateOf<String?>(null) }
    val filter =
        if (route.connected) null else ConnectorBrowseFilter.of(route.query.text, route.category)
    val wide = listWidth != null
    val selected = route.slug

    DisposableEffect(model) {
        model.setOpen(true)
        onDispose { model.setOpen(false) }
    }
    LaunchedEffect(model, selected) { model.select(selected) }
    LaunchedEffect(model, filter) { model.setFilter(filter) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { model.resume() }

    fun back() {
        focus.clearFocus()
        keyboard?.hide()
        if (!wide && selected != null) {
            restoreRow = selected
            route.slug = null
        } else {
            close()
        }
    }

    fun setQuery(value: TextFieldValue) {
        if (route.query.text != value.text) {
            discoverPosition.requestScrollToItem(0)
            connectedPosition.requestScrollToItem(0)
        }
        route.query = value
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
            .imePadding()
    ) {
        if (wide || selected == null) {
            Column(
                (if (listWidth == null) Modifier.weight(1f) else Modifier.width(listWidth.dp))
                    .fillMaxHeight()
            ) {
                ConnectorTopBar(stringResource(R.string.connector_title), ::back)
                ConnectorDirectory(
                    route,
                    state,
                    filter,
                    if (route.connected) connectedPosition else discoverPosition,
                    selected = selected.takeIf { wide },
                    restoreRow = restoreRow,
                    onRestored = { restoreRow = null },
                    editQuery = ::setQuery,
                    setCategory = ::setCategory,
                    open = { slug ->
                        focus.clearFocus()
                        keyboard?.hide()
                        route.slug = slug
                    },
                )
            }
        }
        if (wide) VerticalDivider(color = MaterialTheme.colorScheme.outline)
        if (selected != null) {
            Column(Modifier.weight(1f).fillMaxHeight()) {
                if (!wide) ConnectorTopBar(stringResource(R.string.connector_title), ::back)
                val matchingState = state.takeIf { it.slug == selected }
                val entry =
                    remember(state.browse.data, state.matches, state.connected.data, selected) {
                        state.browse.data?.entries?.find { it.slug == selected }
                            ?: state.matches?.entries?.data?.entries?.find { it.slug == selected }
                            ?: state.connected.data?.get(selected)?.let {
                                ConnectorEntry(selected, it.label, "", null, null)
                            }
                    }
                key(selected) {
                    ConnectorDetails(
                        model,
                        matchingState ?: ConnectorUiState(offline = state.offline),
                        entry,
                        wide,
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
            IconButton(onClick = back, modifier = Modifier.padding(start = 12.dp)) {
                Icon(painterResource(R.drawable.ic_arrow_back), stringResource(R.string.back))
            }
        },
        expandedHeight = height,
        windowInsets = WindowInsets(0),
        colors =
            TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
    )
    HorizontalDivider(color = MaterialTheme.colorScheme.outline)
}

@Composable
private fun ConnectorDirectory(
    route: ConnectorDirectoryState,
    state: ConnectorUiState,
    filter: ConnectorBrowseFilter?,
    position: LazyListState,
    selected: String?,
    restoreRow: String?,
    onRestored: () -> Unit,
    editQuery: (TextFieldValue) -> Unit,
    setCategory: (String?) -> Unit,
    open: (String) -> Unit,
) {
    val query = route.query.text.trim()
    val recommended = !route.connected && filter == null
    val serviceEntries = state.browse.data?.entries
    val connected = state.connected.data
    val read =
        when {
            route.connected -> state.connected
            filter != null ->
                state.matches?.takeIf { it.filter == filter }?.entries ?: ConnectorRead()
            else -> state.browse
        }
    val entries =
        remember(
            route.connected,
            route.category,
            query,
            recommended,
            serviceEntries,
            connected,
            read,
        ) {
            when {
                route.connected -> {
                    val bySlug = serviceEntries.orEmpty().associateBy { it.slug }
                    connected
                        ?.mapNotNull { (slug, service) ->
                            val entry =
                                bySlug[slug] ?: ConnectorEntry(slug, service.label, "", null, null)
                            if (route.category != null && entry.category != route.category) null
                            else if (
                                entry.matches(query) ||
                                    service.accounts.any { account ->
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
                else ->
                    state.matches
                        ?.takeIf { it.filter == filter }
                        ?.entries
                        ?.data
                        ?.entries
                        ?.filter { route.category == null || it.matches(query) }
            }
        }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(12.dp))
        ConnectorTabs(route.connected) { route.connected = it }
        Spacer(Modifier.height(8.dp))
        ConnectorFilters(route, state.browse.data?.categories.orEmpty(), editQuery, setCategory)
        val restoreFocus = remember { FocusRequester() }
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth().testTag("connector-directory"),
            state = position,
            contentPadding = PaddingValues(top = 8.dp, bottom = 16.dp),
        ) {
            if (entries.isNullOrEmpty()) {
                item {
                    when {
                        entries == null ->
                            if (!state.offline && read.failures == 0) {
                                ConnectorSkeleton(
                                    stringResource(R.string.connector_loading),
                                    rows = 3,
                                )
                            } else if (!state.offline) {
                                ConnectorEmpty(R.string.connector_load_failed)
                            }
                        query.isNotEmpty() ->
                            ConnectorEmpty(R.string.connector_no_match, R.string.connector_clear) {
                                editQuery(TextFieldValue())
                            }
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
                        Text(
                            stringResource(R.string.connector_recommended),
                            Modifier.padding(start = 12.dp, top = 8.dp, end = 12.dp, bottom = 4.dp)
                                .semantics { heading() },
                            style = connectorSmallType().copy(fontWeight = FontWeight.SemiBold),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                items(entries, key = { "connector-${it.slug}" }) { entry ->
                    val restoring = restoreRow == entry.slug
                    ConnectorDirectoryRow(
                        entry,
                        state.accountsFor(entry.slug),
                        selected == entry.slug,
                        (if (restoring) Modifier.focusRequester(restoreFocus) else Modifier)
                            .testTag("connector-${entry.slug}"),
                    ) {
                        open(entry.slug)
                    }
                    if (restoring)
                        LaunchedEffect(entry.slug) {
                            restoreFocus.requestFocus()
                            onRestored()
                        }
                }
            }
        }
        if (state.offline) ConnectorStatusBanner(R.string.connector_offline)
        else if (read.failures >= 3 && !entries.isNullOrEmpty()) {
            ConnectorStatusBanner(R.string.connector_refresh_failed)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConnectorTabs(connected: Boolean, select: (Boolean) -> Unit) {
    val selected = if (connected) 1 else 0
    val focus = remember { List(2) { FocusRequester() } }
    PrimaryTabRow(
        selectedTabIndex = selected,
        containerColor = MaterialTheme.colorScheme.background,
        contentColor = MaterialTheme.colorScheme.onBackground,
        indicator = {
            Box(
                Modifier.tabIndicatorOffset(selected, matchContentSize = true)
                    .height(3.dp)
                    .clip(RoundedCornerShape(topStart = 3.dp, topEnd = 3.dp))
                    .background(LocalActivityStatusColor.current)
            )
        },
        divider = { HorizontalDivider(color = MaterialTheme.colorScheme.outline) },
    ) {
        listOf(R.string.connector_discover, R.string.connector_connected).forEachIndexed {
            index,
            label ->
            Tab(
                selected = selected == index,
                onClick = { select(index == 1) },
                modifier =
                    Modifier.heightIn(min = 48.dp).focusRequester(focus[index]).onPreviewKeyEvent {
                        event ->
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
                        style = connectorFeedbackType().copy(fontWeight = FontWeight(550)),
                    )
                },
                selectedContentColor = MaterialTheme.colorScheme.onBackground,
                unselectedContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ConnectorFilters(
    route: ConnectorDirectoryState,
    categories: Set<String>,
    editQuery: (TextFieldValue) -> Unit,
    setCategory: (String?) -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    var restoreFocus by remember { mutableStateOf(false) }
    val categoryFocus = remember { FocusRequester() }
    val searchFocus = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }
    val keyboard = LocalSoftwareKeyboardController.current
    val colors = MaterialTheme.colorScheme
    val label = stringResource(R.string.connector_search)
    val shape = RoundedCornerShape(18.dp)
    val categoryLabel =
        route.category?.let { connectorCategory(it) }
            ?: stringResource(R.string.connector_any_category)

    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BasicTextField(
            value = route.query,
            onValueChange = editQuery,
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
            textStyle = connectorBodyType().copy(color = colors.onSurface),
            cursorBrush = SolidColor(colors.onSurface),
            modifier =
                Modifier.weight(1f)
                    .focusRequester(searchFocus)
                    .onFocusChanged { focused = it.isFocused }
                    .testTag("connector-search")
                    .semantics { contentDescription = label },
            decorationBox = { field ->
                Row(
                    Modifier.fillMaxWidth()
                        .heightIn(min = workspaceSearchControlHeight())
                        .clip(shape)
                        .background(colors.surfaceVariant)
                        .border(
                            if (focused) 2.dp else 1.dp,
                            if (focused) LocalActivityStatusColor.current else colors.outline,
                            shape,
                        )
                        .padding(
                            start = 12.dp,
                            end = if (route.query.text.isEmpty()) 12.dp else 0.dp,
                        ),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        painterResource(R.drawable.ic_search),
                        null,
                        Modifier.size(20.dp),
                        tint = colors.onSurfaceVariant,
                    )
                    Box(Modifier.weight(1f).padding(vertical = 8.dp)) {
                        if (route.query.text.isEmpty()) {
                            Text(
                                label,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                style = connectorBodyType(),
                                color = colors.onSurfaceVariant,
                            )
                        }
                        field()
                    }
                    if (route.query.text.isNotEmpty()) {
                        IconButton(
                            onClick = {
                                editQuery(TextFieldValue())
                                searchFocus.requestFocus()
                            }
                        ) {
                            Icon(
                                painterResource(R.drawable.ic_close),
                                stringResource(R.string.connector_clear),
                                Modifier.size(20.dp),
                            )
                        }
                    }
                }
            },
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
                        .clip(RoundedCornerShape(12.dp))
                        .background(
                            if (route.category == null) colors.background
                            else colors.secondaryContainer
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
                        }
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
    selected: Boolean,
    modifier: Modifier,
    open: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 80.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) colors.surfaceVariant else colors.background)
            .selectable(selected = selected, role = Role.Button, onClick = open)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ConnectorIcon(entry, large = false, modifier = Modifier.align(Alignment.Top))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(entry.name, style = connectorBodyType().copy(fontWeight = FontWeight.SemiBold))
            if (entry.description.isNotBlank()) {
                Text(
                    entry.description,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    style = connectorSmallType(),
                    color = colors.onSurfaceVariant,
                )
            }
            if (accounts.isNotEmpty()) ConnectorDirectoryStatus(accounts)
        }
        ConnectorChevron()
    }
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
                        if (attention) colors.error else LocalActivityStatusColor.current,
                        CircleShape,
                    )
            )
        }
        Text(
            message,
            style =
                MaterialTheme.typography.bodySmall.copy(
                    fontSize = 12.sp,
                    lineHeight = 16.sp,
                    letterSpacing = 0.sp,
                ),
            color = colors.onSurfaceVariant,
        )
    }
}

@Composable
internal fun ConnectorIcon(entry: ConnectorEntry, large: Boolean, modifier: Modifier = Modifier) {
    val icon =
        when {
            entry.slug in setOf("google-calendar", "outlook-calendar", "calendly") ->
                R.drawable.ic_event
            entry.slug in setOf("gmail", "outlook-mail", "resend") -> R.drawable.ic_mail
            entry.category == "meetings-scheduling" -> R.drawable.ic_event
            entry.category == "docs-files-knowledge" -> R.drawable.ic_folder
            else -> R.drawable.ic_extension
        }
    Box(
        modifier
            .size(if (large) 48.dp else 40.dp)
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(painterResource(icon), null, Modifier.size(if (large) 24.dp else 20.dp))
    }
}

@Composable
internal fun ConnectorChevron() {
    Icon(painterResource(R.drawable.ic_chevron_right), null, Modifier.size(18.dp))
}

@Composable
internal fun ConnectorSkeleton(label: String, rows: Int) {
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
                        )
                )
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(
                        Modifier.widthIn(max = 144.dp)
                            .fillMaxWidth()
                            .height(14.dp)
                            .background(
                                MaterialTheme.colorScheme.surfaceVariant,
                                RoundedCornerShape(4.dp),
                            )
                    )
                    Box(
                        Modifier.widthIn(max = 220.dp)
                            .fillMaxWidth()
                            .height(10.dp)
                            .background(
                                MaterialTheme.colorScheme.surfaceVariant,
                                RoundedCornerShape(4.dp),
                            )
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
internal fun ConnectorStatusBanner(message: Int) {
    Text(
        stringResource(message),
        Modifier.padding(bottom = 8.dp, top = 4.dp)
            .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(12.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        color = MaterialTheme.colorScheme.onSurfaceVariant,
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
        }
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
