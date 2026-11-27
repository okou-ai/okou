package ai.okou.android.artifacts

import ai.okou.android.ContentReadFailure
import ai.okou.android.DirectoryReturnFocus
import ai.okou.android.R
import ai.okou.android.WorkspaceFilterRow
import ai.okou.android.WorkspaceSearchGroupHeading
import ai.okou.android.WorkspaceSearchInput
import ai.okou.android.WorkspaceToolDirectoryRow
import ai.okou.android.WorkspaceToolDirectoryRowSkeleton
import ai.okou.android.chat.ChatSkeletonBlock
import ai.okou.android.hasPendingSearchText
import ai.okou.android.rememberContentReadSkeleton
import ai.okou.android.restoreDirectoryFocus
import ai.okou.android.retainSearchResultsWhileComposing
import ai.okou.android.searchClearAction
import ai.okou.android.workspaceSearchFocusOutline
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.icu.util.Calendar
import android.icu.util.GregorianCalendar
import android.icu.util.TimeZone as IcuTimeZone
import android.text.format.DateFormat
import androidx.annotation.StringRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.input.InputTransformation
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.clearText
import androidx.compose.foundation.text.input.maxLengthReject
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.relocation.BringIntoViewModifierNode
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleStartEffect
import java.text.SimpleDateFormat
import java.util.Date
import java.util.TimeZone
import kotlin.math.abs

private data class ArtifactCatalogListState(
    val page: ArtifactPage?,
    val failure: ArtifactCatalogFailure?,
    val reading: ArtifactCatalogRead?,
)

@Composable
internal fun ArtifactCatalogList(
    model: ArtifactCatalogModel,
    state: ArtifactCatalogState,
    refreshSnackbar: SnackbarHostState,
    input: TextFieldState,
    query: ArtifactQuery,
    onFilter: (ArtifactFilter) -> Unit,
    position: LazyListState,
    selectedId: String?,
    returnFocus: DirectoryReturnFocus,
    onSelect: (ArtifactItem) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val filter = query.filter
    val restoreRow = returnFocus.pending?.rowKey
    val current = state.takeIf { it.query == query }
    val listState = ArtifactCatalogListState(current?.page, current?.failedRead, current?.reading)
    val (page, failure, reading) =
        when (state.failedRead) {
            ArtifactCatalogFailure.Denied,
            ArtifactCatalogFailure.Missing,
            ArtifactCatalogFailure.ChatUnavailable -> listState
            else ->
                key(input, query) {
                    retainSearchResultsWhileComposing(
                        listState,
                        hasPendingSearchText(input.text, input.composition, query.keyword),
                    )
                }
        }
    val localDates = rememberArtifactDates()
    val groups =
        remember(page, query, localDates.today, localDates.yesterday) {
            page
                ?.items
                ?.groupBy { item ->
                    if (query.keyword.isBlank()) localDates.group(checkNotNull(item.createdAt))
                    else ArtifactDay.Search
                }
                .orEmpty()
        }
    val searchFocus = remember { FocusRequester() }
    val clearQuery = searchClearAction(searchFocus) { input.clearText() }
    val allFilterFocus = remember { FocusRequester() }
    val rowFocus = remember { FocusRequester() }
    val rowStartPadding =
        ListItemDefaults.ContentPadding.calculateStartPadding(LocalLayoutDirection.current)
    val hasReturnRow = restoreRow != null && page?.items?.any { it.id == restoreRow } == true
    val canChooseAlternative =
        restoreRow != null && !hasReturnRow && page?.items?.isNotEmpty() == true
    val alternativeRows = remember { mutableMapOf<Any, FocusRequester>() }

    LaunchedEffect(model, page, failure, reading) {
        if (page?.nextCursor != null && failure == null && reading == null) {
            snapshotFlow {
                val layout = position.layoutInfo
                val last = layout.visibleItemsInfo.lastOrNull()?.index ?: -1
                last >= 0 && last >= layout.totalItemsCount - 5
            }
                .collect { if (it) model.loadNext() }
        }
    }
    Column(
        modifier
            .fillMaxHeight()
            .restoreDirectoryFocus(
                returnFocus,
                page != null || failure != null,
                position,
                rowFocus,
                searchFocus,
                rowEnabled = hasReturnRow,
                requestMissingRowAlternative = { request ->
                    val anchor = request.previousIndex ?: position.firstVisibleItemIndex
                    val nearest =
                        position.layoutInfo.visibleItemsInfo
                            .filter { it.key in alternativeRows }
                            .minByOrNull { abs(it.index - anchor) }
                    nearest?.let { alternativeRows[it.key]?.requestFocus() } == true
                },
            )
            .testTag("artifact_catalog"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        ArtifactToolbar(R.string.artifact_title, R.string.artifact_return_workspace, onClose)
        Column(
            Modifier.widthIn(max = 730.dp)
                .fillMaxWidth()
                .padding(start = 16.dp, top = 12.dp, end = 16.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            WorkspaceSearchInput(
                state = input,
                label = stringResource(R.string.artifact_search),
                onClear = clearQuery,
                modifier =
                    Modifier.fillMaxWidth().focusRequester(searchFocus).testTag("artifact_query"),
                inputTransformation = InputTransformation.maxLengthReject(256),
            )
            WorkspaceFilterRow(
                ArtifactFilter.entries,
                filter,
                Role.RadioButton,
                label = { stringResource(it.label()) },
                modifier = Modifier.fillMaxWidth(),
                optionModifier = {
                    if (it == ArtifactFilter.All) Modifier.focusRequester(allFilterFocus)
                    else Modifier
                },
                onSelect = onFilter,
            )
        }
        if (page == null && failure != null) {
            ArtifactInitialReadFailure(
                failure,
                Modifier.widthIn(max = 730.dp).weight(1f),
            )
            return@Column
        }
        val showSkeleton = rememberArtifactCatalogSkeleton(current)
        Box(Modifier.fillMaxWidth().weight(1f)) {
            LazyColumn(
                modifier =
                    Modifier.widthIn(max = 730.dp)
                        .fillMaxWidth()
                        .fillMaxHeight()
                        .align(Alignment.TopCenter)
                        .testTag("artifact_list"),
                state = position,
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 20.dp),
            ) {
                if (showSkeleton) items(4) { ArtifactRowPlaceholder() }
                if (page?.items?.isEmpty() == true) {
                    item {
                        ArtifactEmpty(
                            hasKeyword = query.keyword.isNotBlank(),
                            filtered = filter != ArtifactFilter.All,
                            onClear = clearQuery,
                            onShowAll = {
                                onFilter(ArtifactFilter.All)
                                allFilterFocus.requestFocus()
                            },
                        )
                    }
                }
                groups.forEach { (day, rows) ->
                    if (day != ArtifactDay.Search) {
                        item(key = day.name) {
                            WorkspaceSearchGroupHeading(
                                stringResource(day.label),
                                Modifier.padding(start = rowStartPadding),
                                topPadding = 8.dp,
                            )
                        }
                    }
                    items(rows, key = { it.id }) { item ->
                        val focusModifier =
                            when {
                                item.id == restoreRow ->
                                    PreserveCatalogRowPosition.focusRequester(rowFocus)
                                canChooseAlternative -> {
                                    val requester = remember { FocusRequester() }
                                    DisposableEffect(item.id, requester) {
                                        alternativeRows[item.id] = requester
                                        onDispose { alternativeRows.remove(item.id) }
                                    }
                                    PreserveCatalogRowPosition.focusRequester(requester)
                                }
                                else -> Modifier
                            }
                        ArtifactRow(
                            item = item,
                            date =
                                localDates.timestamp(
                                    checkNotNull(item.createdAt),
                                    showDay = day == ArtifactDay.Search,
                                ),
                            selected = item.id == selectedId,
                            thumbnail = model::thumbnail,
                            modifier = focusModifier,
                        ) {
                            onSelect(item)
                        }
                    }
                }
                if (failure == ArtifactCatalogFailure.More || reading == ArtifactCatalogRead.More) {
                    item(key = "catalog-page-feedback") {
                        ArtifactRowPlaceholder(pageFailed = failure == ArtifactCatalogFailure.More)
                    }
                }
            }
            ArtifactRefreshFeedback(refreshSnackbar, Modifier.align(Alignment.BottomCenter))
        }
    }
}

// Return targets are already visible. Keep their position until the focus request is consumed.
private data object PreserveCatalogRowPosition : ModifierNodeElement<CatalogRowPositionNode>() {
    override fun create() = CatalogRowPositionNode()

    override fun update(node: CatalogRowPositionNode) = Unit
}

private class CatalogRowPositionNode : Modifier.Node(), BringIntoViewModifierNode {
    override suspend fun bringIntoView(
        childCoordinates: LayoutCoordinates,
        boundsProvider: () -> Rect?,
    ) = Unit
}

@Composable
internal fun rememberArtifactCatalogSkeleton(state: ArtifactCatalogState?): Boolean =
    rememberContentReadSkeleton(
        hasContent = state?.catalog != null,
        awaitingRead = state?.initialReadRound != null,
        readScope = state?.initialReadRound,
    )

@Composable
internal fun ArtifactToolbar(
    @StringRes title: Int,
    @StringRes back: Int,
    onBack: () -> Unit,
    horizontalPadding: Dp = 12.dp,
    backFocus: FocusRequester? = null,
) {
    val backModifier = if (backFocus == null) Modifier else Modifier.focusRequester(backFocus)
    val minimum = with(LocalDensity.current) { maxOf(64.dp, 28.sp.toDp() + 16.dp) }
    Row(
        Modifier.fillMaxWidth().heightIn(min = minimum).padding(horizontal = horizontalPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        IconButton(
            onClick = onBack,
            modifier = backModifier.workspaceSearchFocusOutline(CircleShape),
        ) {
            Icon(painterResource(R.drawable.ic_arrow_back), stringResource(back))
        }
        Text(
            stringResource(title),
            Modifier.weight(1f).semantics { heading() },
            fontSize = 20.sp,
            lineHeight = 28.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
}

@Composable
private fun ArtifactRow(
    item: ArtifactItem,
    date: String,
    selected: Boolean,
    thumbnail: suspend (String) -> android.graphics.Bitmap?,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    WorkspaceToolDirectoryRow(
        title = item.title,
        selected = selected,
        onClick = onClick,
        modifier = modifier.testTag("artifact_row"),
        leading = { ArtifactThumbnail(item, thumbnail) },
    ) {
        Text(stringResource(R.string.artifact_metadata, stringResource(item.kind.label()), date))
    }
}

@Composable
private fun ArtifactThumbnail(
    item: ArtifactItem,
    thumbnail: suspend (String) -> android.graphics.Bitmap?,
) {
    val image =
        item.thumbnail?.let { url ->
            key(url) {
                val bitmap by
                    produceState<android.graphics.Bitmap?>(null) { value = thumbnail(url) }
                bitmap
            }
        }
    if (image != null) {
        Image(image.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
    } else {
        Icon(
            painterResource(item.kind.icon()),
            null,
            Modifier.size(20.dp),
            tint = MaterialTheme.colorScheme.onBackground,
        )
    }
}

@Composable
internal fun ArtifactRowPlaceholder(
    chatResources: Boolean = false,
    hasSubtitle: Boolean = true,
    pageFailed: Boolean = false,
) {
    val minimumHeight = if (hasSubtitle) 72.dp else 56.dp
    val (titleSlot, subtitleSlot) =
        with(LocalDensity.current) { maxOf(14.dp, 24.sp.toDp()) to maxOf(14.dp, 20.sp.toDp()) }
    val verticalPadding =
        if (chatResources) 16.dp
        else
            ListItemDefaults.ContentPadding.run { calculateTopPadding() + calculateBottomPadding() }
    val textHeight = titleSlot + if (hasSubtitle) subtitleSlot else 0.dp
    val bounds =
        Modifier.fillMaxWidth().heightIn(min = maxOf(minimumHeight, verticalPadding + textHeight))
    if (pageFailed) {
        // Reserve the same space after a failed page so the lower scroll bound stays stable.
        Box(bounds) {
            ArtifactReadNotice(
                ArtifactCatalogFailure.More.label(),
                Modifier.padding(horizontal = if (chatResources) 0.dp else 16.dp)
                    .padding(top = 12.dp),
            )
        }
        return
    }
    val title: @Composable () -> Unit = {
        Box(Modifier.height(titleSlot), contentAlignment = Alignment.CenterStart) {
            ChatSkeletonBlock(Modifier.width(144.dp).height(14.dp))
        }
    }
    val subtitle: @Composable () -> Unit = {
        Box(Modifier.height(subtitleSlot), contentAlignment = Alignment.CenterStart) {
            ChatSkeletonBlock(Modifier.width(80.dp).height(14.dp))
        }
    }
    val skeleton = Modifier.testTag("artifact_row_skeleton")
    if (chatResources) {
        Row(
            skeleton.then(bounds).padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ChatSkeletonBlock(Modifier.size(40.dp), cornerRadius = 12.dp)
            Column {
                title()
                if (hasSubtitle) subtitle()
            }
        }
    } else {
        WorkspaceToolDirectoryRowSkeleton(skeleton, supportingContent = subtitle, content = title)
    }
}

@Composable
private fun ArtifactEmpty(
    hasKeyword: Boolean,
    filtered: Boolean,
    onClear: () -> Unit,
    onShowAll: () -> Unit,
) {
    val label =
        when {
            hasKeyword -> R.string.artifact_no_matches
            filtered -> R.string.artifact_empty_type
            else -> R.string.artifact_empty
        }
    Column(
        Modifier.fillMaxWidth().padding(vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            stringResource(label),
            Modifier.padding(horizontal = 12.dp).semantics {
                heading()
                liveRegion = LiveRegionMode.Polite
            },
            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
            color = MaterialTheme.colorScheme.onSurface,
        )
        if (hasKeyword || filtered) {
            TextButton(
                onClick = if (hasKeyword) onClear else onShowAll,
                modifier =
                    Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp)
                        .workspaceSearchFocusOutline(ButtonDefaults.textShape),
            ) {
                Text(
                    stringResource(
                        if (hasKeyword) R.string.artifact_clear_keyword
                        else R.string.artifact_show_all,
                    ),
                )
            }
        }
    }
}

@Composable
internal fun ArtifactInitialReadFailure(
    failure: ArtifactCatalogFailure,
    modifier: Modifier = Modifier,
) {
    val area = modifier.fillMaxWidth().testTag("artifact_read_error_area")
    if (failure == ArtifactCatalogFailure.Initial) {
        BoxWithConstraints(area) {
            ContentReadFailure(
                R.string.chat_list_first_load_failed,
                Modifier.fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = maxHeight)
                    .padding(horizontal = 16.dp)
                    .testTag("artifact_read_failure"),
            )
        }
    } else {
        Box(area) {
            ArtifactReadNotice(
                failure.label(),
                Modifier.padding(start = 12.dp, end = 12.dp, top = 24.dp),
            )
        }
    }
}

@StringRes
internal fun ArtifactCatalogFailure.label(chatResources: Boolean = false): Int =
    when (this) {
        ArtifactCatalogFailure.Initial ->
            if (chatResources) R.string.chat_resources_load_failed
            else R.string.artifact_catalog_load_failed
        ArtifactCatalogFailure.Refresh -> R.string.artifact_catalog_refresh_failed
        ArtifactCatalogFailure.More -> R.string.artifact_catalog_page_failed
        ArtifactCatalogFailure.Denied -> R.string.artifact_catalog_access_denied
        ArtifactCatalogFailure.Missing -> R.string.artifact_catalog_missing
        ArtifactCatalogFailure.ChatUnavailable -> R.string.history_missing
    }

@Composable
internal fun ArtifactReadNotice(@StringRes label: Int, modifier: Modifier = Modifier) {
    Text(
        stringResource(label),
        modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
        style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

internal enum class ArtifactDay(@param:StringRes val label: Int) {
    Today(R.string.artifact_today),
    Yesterday(R.string.artifact_yesterday),
    Earlier(R.string.artifact_earlier),
    Search(R.string.artifact_search),
}

internal class ArtifactDates(
    nowMillis: Long,
    zone: TimeZone,
    private val formatTime: java.text.DateFormat,
    private val formatDate: java.text.DateFormat,
    private val formatMonthDay: java.text.DateFormat,
    private val todayLabel: String,
    private val yesterdayLabel: String,
) {
    val today: Long
    val yesterday: Long
    private val startOfYear: Long

    init {
        val calendar =
            GregorianCalendar(IcuTimeZone.getTimeZone(zone.id)).apply {
                timeInMillis = nowMillis
                // A local date begins at its first valid instant, even when midnight repeats or is
                // skipped.
                repeatedWallTimeOption = Calendar.WALLTIME_FIRST
                skippedWallTimeOption = Calendar.WALLTIME_NEXT_VALID
            }
        val localDay = calendar.get(Calendar.JULIAN_DAY)
        val firstDayOfYear = localDay - (calendar.get(Calendar.DAY_OF_YEAR) - 1)
        today = calendar.startOfDayMillis(localDay)
        yesterday = calendar.startOfDayMillis(localDay - 1)
        startOfYear = calendar.startOfDayMillis(firstDayOfYear)
        formatTime.timeZone = zone
        formatDate.timeZone = zone
        formatMonthDay.timeZone = zone
    }

    fun group(time: Long): ArtifactDay =
        when {
            time >= today -> ArtifactDay.Today
            time >= yesterday -> ArtifactDay.Yesterday
            else -> ArtifactDay.Earlier
        }

    fun timestamp(time: Long, showDay: Boolean): String {
        val value = Date(time)
        val day = group(time)
        if (day == ArtifactDay.Earlier) {
            return if (time >= startOfYear) formatMonthDay.format(value)
            else formatDate.format(value)
        }
        val clock = formatTime.format(value)
        return if (showDay) "${if (day == ArtifactDay.Today) todayLabel else yesterdayLabel} $clock"
        else clock
    }
}

@Composable
internal fun rememberArtifactDates(): ArtifactDates {
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]
    var calendarRevision by remember { mutableIntStateOf(0) }
    LifecycleStartEffect(context) {
        val receiver =
            object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    calendarRevision++
                }
            }
        val filter =
            IntentFilter(Intent.ACTION_DATE_CHANGED).apply {
                addAction(Intent.ACTION_TIME_CHANGED)
                addAction(Intent.ACTION_TIMEZONE_CHANGED)
            }
        ContextCompat.registerReceiver(
            context,
            receiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        calendarRevision++
        onStopOrDispose { context.unregisterReceiver(receiver) }
    }
    val todayLabel = stringResource(R.string.artifact_today)
    val yesterdayLabel = stringResource(R.string.artifact_yesterday)
    return remember(context, locale, calendarRevision, todayLabel, yesterdayLabel) {
        ArtifactDates(
            nowMillis = System.currentTimeMillis(),
            zone = TimeZone.getDefault(),
            formatTime = DateFormat.getTimeFormat(context),
            formatDate = DateFormat.getMediumDateFormat(context),
            formatMonthDay =
                SimpleDateFormat(DateFormat.getBestDateTimePattern(locale, "MMMd"), locale),
            todayLabel = todayLabel,
            yesterdayLabel = yesterdayLabel,
        )
    }
}

private fun Calendar.startOfDayMillis(localDay: Int): Long {
    clear()
    set(Calendar.JULIAN_DAY, localDay)
    set(Calendar.MILLISECONDS_IN_DAY, 0)
    return timeInMillis
}

private fun ArtifactFilter.label(): Int =
    when (this) {
        ArtifactFilter.All -> R.string.artifact_all
        ArtifactFilter.Files -> R.string.artifact_filter_files
        ArtifactFilter.Websites -> R.string.artifact_filter_sites
        ArtifactFilter.Images -> R.string.artifact_filter_images
        ArtifactFilter.Presentations -> R.string.artifact_filter_presentations
    }

internal fun ArtifactKind.label(): Int =
    when (this) {
        ArtifactKind.File -> R.string.artifact_file
        ArtifactKind.Website -> R.string.artifact_site
        ArtifactKind.Image -> R.string.artifact_image
        ArtifactKind.Presentation -> R.string.artifact_presentation
        ArtifactKind.Video -> R.string.artifact_video
        ArtifactKind.Avatar -> R.string.artifact_avatar
        ArtifactKind.SharedConversation -> R.string.artifact_shared_chat
    }

internal fun ArtifactKind.icon(): Int =
    when (this) {
        ArtifactKind.File -> R.drawable.ic_description
        ArtifactKind.Website -> R.drawable.ic_language
        ArtifactKind.Image -> R.drawable.ic_image
        ArtifactKind.Presentation -> R.drawable.ic_slideshow
        ArtifactKind.Video,
        ArtifactKind.Avatar -> R.drawable.ic_videocam
        ArtifactKind.SharedConversation -> R.drawable.ic_chat
    }
