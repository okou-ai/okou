package ai.okou.android.artifacts

import ai.okou.android.R
import ai.okou.android.WorkspaceSearchField
import ai.okou.android.chat.rememberChatWaitIndicator
import android.text.format.DateFormat
import androidx.annotation.StringRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.InputTransformation
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.clearText
import androidx.compose.foundation.text.input.maxLengthReject
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
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
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date

@Composable
internal fun ArtifactCatalogList(
    model: ArtifactCatalogModel,
    state: ArtifactCatalogState,
    input: TextFieldState,
    filter: ArtifactFilter,
    onFilter: (ArtifactFilter) -> Unit,
    position: LazyListState,
    selectedId: String?,
    restoreRow: String?,
    onFocusRestored: () -> Unit,
    onSelect: (ArtifactItem) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val query = ArtifactQuery(filter, input.text.toString().trim())
    val page = state.page.takeIf { state.query == query }
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
    val rowFocus = remember { FocusRequester() }
    val noticePadding = Modifier.padding(16.dp)

    LaunchedEffect(restoreRow, page) {
        if (restoreRow != null && page != null) {
            if (position.layoutInfo.visibleItemsInfo.any { it.key == restoreRow }) {
                rowFocus.requestFocus()
            } else searchFocus.requestFocus()
            onFocusRestored()
        }
    }
    LaunchedEffect(model, page, state.problem, state.reading, state.offline) {
        if (
            page?.nextCursor != null &&
                state.problem == null &&
                state.reading == null &&
                !state.offline
        ) {
            snapshotFlow {
                    val layout = position.layoutInfo
                    val last = layout.visibleItemsInfo.lastOrNull()?.index ?: -1
                    last >= 0 && last >= layout.totalItemsCount - 5
                }
                .collect { if (it) model.loadNext() }
        }
    }
    Column(
        modifier.fillMaxHeight().testTag("artifact_catalog"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        ArtifactToolbar(R.string.artifact_title, R.string.artifact_return_workspace, onClose)
        Column(
            Modifier.widthIn(max = 730.dp)
                .fillMaxWidth()
                .padding(start = 16.dp, top = 12.dp, end = 16.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            ArtifactSearch(input, searchFocus)
            ArtifactFilters(filter, onFilter)
        }
        if (state.offline && page?.items?.isNotEmpty() == true) {
            ArtifactListNotice(R.string.artifact_offline_cached, noticePadding)
        }
        val showSkeleton =
            rememberChatWaitIndicator(page == null && !state.offline && state.problem == null)
        LazyColumn(
            modifier =
                Modifier.widthIn(max = 730.dp).fillMaxWidth().weight(1f).testTag("artifact_list"),
            state = position,
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 20.dp),
        ) {
            if (page == null) {
                when {
                    state.offline ->
                        item {
                            ArtifactListNotice(R.string.artifact_offline_catalog, noticePadding)
                        }
                    state.problem != null ->
                        item { ArtifactListNotice(state.problem.label(), noticePadding) }
                    showSkeleton -> items(4) { ArtifactRowSkeleton() }
                }
            } else if (page.items.isEmpty()) {
                item {
                    when {
                        state.offline ->
                            ArtifactListNotice(R.string.artifact_offline_catalog, noticePadding)
                        query.keyword.isNotBlank() ->
                            ArtifactEmpty(
                                R.string.artifact_no_matches,
                                R.string.chat_search_clear,
                            ) {
                                input.clearText()
                            }
                        filter != ArtifactFilter.All ->
                            ArtifactEmpty(
                                R.string.artifact_empty_type,
                                R.string.artifact_show_all,
                            ) {
                                onFilter(ArtifactFilter.All)
                            }
                        else -> ArtifactListNotice(R.string.artifact_empty, noticePadding)
                    }
                }
            }
            groups.forEach { (day, rows) ->
                if (day != ArtifactDay.Search) {
                    item(key = day.name) {
                        Text(
                            stringResource(day.label),
                            Modifier.padding(start = 12.dp, top = 8.dp, bottom = 4.dp).semantics {
                                heading()
                            },
                            style = artifactSmallText(),
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                items(rows, key = { it.id }) { item ->
                    ArtifactRow(
                        item = item,
                        date =
                            localDates.timestamp(
                                checkNotNull(item.createdAt),
                                showDay = day == ArtifactDay.Search,
                            ),
                        selected = item.id == selectedId,
                        offline = state.offline,
                        thumbnail = model::thumbnail,
                        modifier =
                            if (item.id == restoreRow) Modifier.focusRequester(rowFocus)
                            else Modifier,
                    ) {
                        onSelect(item)
                    }
                }
            }
            if (page?.items?.isNotEmpty() == true && !state.offline) {
                state.problem?.let { problem ->
                    item { ArtifactListNotice(problem.label(), noticePadding) }
                }
                if (state.reading == ArtifactCatalogRead.More) item { ArtifactRowSkeleton() }
            }
        }
    }
}

@Composable
internal fun ArtifactToolbar(
    @StringRes title: Int,
    @StringRes back: Int,
    onBack: () -> Unit,
    horizontalPadding: Dp = 12.dp,
) {
    val minimum = with(LocalDensity.current) { maxOf(64.dp, 28.sp.toDp() + 16.dp) }
    Row(
        Modifier.fillMaxWidth().heightIn(min = minimum).padding(horizontal = horizontalPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        IconButton(onClick = onBack, modifier = Modifier.size(48.dp)) {
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
    HorizontalDivider(color = MaterialTheme.colorScheme.outline)
}

@Composable
private fun ArtifactSearch(input: TextFieldState, focus: FocusRequester) {
    val colors = MaterialTheme.colorScheme
    val keyboard = LocalSoftwareKeyboardController.current
    val label = stringResource(R.string.artifact_search)
    val textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.onSurface)
    var focused by remember { mutableStateOf(false) }
    BasicTextField(
        state = input,
        inputTransformation = InputTransformation.maxLengthReject(256),
        modifier =
            Modifier.fillMaxWidth()
                .focusRequester(focus)
                .onFocusChanged { focused = it.isFocused }
                .testTag("artifact_query")
                .semantics { contentDescription = label },
        textStyle = textStyle,
        lineLimits = TextFieldLineLimits.SingleLine,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        onKeyboardAction = { keyboard?.hide() },
        cursorBrush = SolidColor(colors.onSurface),
        decorator = { field ->
            WorkspaceSearchField(
                Modifier.fillMaxWidth(),
                focused = focused,
                hasTrailingAction = input.text.isNotEmpty(),
                shape = RoundedCornerShape(18.dp),
            ) {
                Box(Modifier.weight(1f).padding(vertical = 8.dp)) {
                    if (input.text.isEmpty()) {
                        Text(
                            label,
                            style = textStyle,
                            color = colors.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    field()
                }
                if (input.text.isNotEmpty()) {
                    IconButton(
                        onClick = {
                            input.clearText()
                            focus.requestFocus()
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
}

@Composable
private fun ArtifactFilters(selected: ArtifactFilter, onFilter: (ArtifactFilter) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(12.dp)
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for (filter in ArtifactFilter.entries) {
            val current = filter == selected
            Box(
                Modifier.heightIn(min = 48.dp)
                    .widthIn(min = 48.dp)
                    .clip(shape)
                    .background(if (current) colors.secondaryContainer else colors.background)
                    .selectable(selected = current, role = Role.RadioButton) { onFilter(filter) }
                    .padding(8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    stringResource(filter.label()),
                    style = artifactSmallText(),
                    color = if (current) colors.onSecondaryContainer else colors.onSurface,
                )
            }
        }
    }
}

@Composable
private fun ArtifactRow(
    item: ArtifactItem,
    date: String,
    selected: Boolean,
    offline: Boolean,
    thumbnail: suspend (String, Boolean) -> android.graphics.Bitmap?,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val foreground = if (selected) colors.onSecondaryContainer else colors.onSurface
    val meta = if (selected) foreground else colors.onSurfaceVariant
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 80.dp)
            .clip(RoundedCornerShape(8.dp))
            .then(if (selected) Modifier.background(colors.secondaryContainer) else Modifier)
            .selectable(selected = selected, role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .testTag("artifact_row"),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ArtifactThumbnail(item, offline, thumbnail)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                item.title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
                color = foreground,
            )
            Text(
                stringResource(R.string.artifact_metadata, stringResource(item.kind.label()), date),
                style = artifactSmallText(),
                color = meta,
            )
        }
        Icon(
            painterResource(R.drawable.ic_chevron_right),
            contentDescription = null,
            modifier = Modifier.align(Alignment.CenterVertically).size(18.dp),
            tint = foreground,
        )
    }
}

@Composable
private fun ArtifactThumbnail(
    item: ArtifactItem,
    offline: Boolean,
    thumbnail: suspend (String, Boolean) -> android.graphics.Bitmap?,
) {
    val bitmap by
        produceState<android.graphics.Bitmap?>(null, item.thumbnail, offline) {
            value = item.thumbnail?.let { thumbnail(it, offline) }
        }
    val colors = MaterialTheme.colorScheme
    Box(
        Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(colors.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        val image = bitmap
        if (image != null) {
            Image(
                image.asImageBitmap(),
                null,
                Modifier.fillMaxSize(),
                contentScale = ContentScale.Fit,
            )
        } else {
            Icon(
                painterResource(item.kind.icon()),
                null,
                Modifier.size(20.dp),
                tint = colors.onSurface,
            )
        }
    }
}

@Composable
internal fun ArtifactRowSkeleton(height: Dp = 80.dp, horizontalPadding: Dp = 12.dp) {
    val fill = MaterialTheme.colorScheme.surfaceVariant
    Row(
        Modifier.fillMaxWidth()
            .height(height)
            .padding(horizontal = horizontalPadding, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Spacer(Modifier.size(40.dp).background(fill, RoundedCornerShape(12.dp)))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Spacer(Modifier.width(144.dp).height(16.dp).background(fill, RoundedCornerShape(4.dp)))
            Spacer(Modifier.width(80.dp).height(12.dp).background(fill, RoundedCornerShape(4.dp)))
        }
    }
}

@Composable
private fun ArtifactEmpty(@StringRes label: Int, @StringRes action: Int, onClick: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(top = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        ArtifactListNotice(label)
        ArtifactAction(action, onClick = onClick)
    }
}

@Composable
private fun ArtifactListNotice(@StringRes label: Int, modifier: Modifier = Modifier) {
    Text(
        stringResource(label),
        Modifier.fillMaxWidth().then(modifier).semantics { liveRegion = LiveRegionMode.Polite },
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
    )
}

@Composable
internal fun artifactSmallText() =
    MaterialTheme.typography.bodyMedium.copy(
        fontSize = 13.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.sp,
    )

internal enum class ArtifactDay(@param:StringRes val label: Int) {
    Today(R.string.artifact_today),
    Yesterday(R.string.artifact_yesterday),
    Earlier(R.string.artifact_earlier),
    Search(R.string.artifact_search),
}

internal class ArtifactDates(
    val today: Long,
    val yesterday: Long,
    private val formatTime: java.text.DateFormat,
    private val formatDate: java.text.DateFormat,
    private val formatMonthDay: java.text.DateFormat,
    private val startOfYear: Long,
    private val todayLabel: String,
    private val yesterdayLabel: String,
) {
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
    val calendar =
        Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
    val today = calendar.timeInMillis
    val startOfYear =
        (calendar.clone() as Calendar).apply { set(Calendar.DAY_OF_YEAR, 1) }.timeInMillis
    calendar.add(Calendar.DATE, -1)
    val yesterday = calendar.timeInMillis
    val todayLabel = stringResource(R.string.artifact_today)
    val yesterdayLabel = stringResource(R.string.artifact_yesterday)
    return remember(context, locale, today, yesterday, todayLabel, yesterdayLabel) {
        ArtifactDates(
            today,
            yesterday,
            DateFormat.getTimeFormat(context),
            DateFormat.getMediumDateFormat(context),
            SimpleDateFormat(DateFormat.getBestDateTimePattern(locale, "MMMd"), locale),
            startOfYear,
            todayLabel,
            yesterdayLabel,
        )
    }
}

private fun ArtifactFilter.label(): Int =
    when (this) {
        ArtifactFilter.All -> R.string.artifact_all
        ArtifactFilter.Files -> R.string.artifact_filter_files
        ArtifactFilter.Websites -> R.string.artifact_filter_sites
        ArtifactFilter.Images -> R.string.artifact_filter_images
        ArtifactFilter.Presentations -> R.string.artifact_filter_presentations
        ArtifactFilter.Videos -> R.string.artifact_filter_videos
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

internal fun ArtifactProblem.label(): Int =
    when (this) {
        ArtifactProblem.Denied -> R.string.artifact_access_denied
        ArtifactProblem.Missing -> R.string.artifact_missing
        ArtifactProblem.Temporary,
        ArtifactProblem.Unavailable -> R.string.artifact_unavailable
        ArtifactProblem.Unsupported -> R.string.artifact_preview_unsupported
    }
