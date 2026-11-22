package ai.okou.android.artifacts

import ai.okou.android.R
import ai.okou.android.chat.rememberChatWaitIndicator
import ai.okou.android.state.rememberArtifactPageState
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
internal fun ChatArtifactResources(
    model: ArtifactCatalogModel,
    threadId: String,
    wide: Boolean,
    onClose: () -> Unit,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val query = remember(threadId) { ArtifactQuery(chatThreadId = threadId) }
    val page = rememberArtifactPageState()
    val position = rememberLazyListState()
    val selected = page.selectedId
    LifecycleStartEffect(model, threadId) {
        model.setActive(true, query)
        onStopOrDispose { model.setActive(false) }
    }
    LaunchedEffect(model, selected) { model.select(selected) }

    fun back() {
        if (selected == null) onClose()
        else {
            page.restoreRow = selected
            page.selectedId = null
            model.select(null)
        }
    }

    BackHandler(onBack = ::back)
    val toolbarPadding = if (wide) 28.dp else 12.dp
    if (selected != null) {
        Column(Modifier.fillMaxSize()) {
            ArtifactToolbar(
                R.string.artifact_title,
                R.string.chat_resources_back,
                ::back,
                toolbarPadding,
            )
            ArtifactSelectionPreview(model, state, page, selected, wide)
        }
        return
    }
    val result = state.page.takeIf { state.query == query }
    val problem = state.problem.takeIf { state.query == query }
    val showSkeleton =
        rememberChatWaitIndicator(result == null && problem == null && !state.offline)
    val dates = rememberArtifactDates()
    val rowFocus = remember { FocusRequester() }
    val restoreRow = page.restoreRow
    LaunchedEffect(result, state.reading, problem, state.offline) {
        if (
            result?.nextCursor != null && state.reading == null && problem == null && !state.offline
        ) {
            snapshotFlow {
                    val layout = position.layoutInfo
                    val last = layout.visibleItemsInfo.lastOrNull()?.index ?: -1
                    last >= 0 && last >= layout.totalItemsCount - 5
                }
                .collect { nearEnd -> if (nearEnd) model.loadNext() }
        }
    }
    Column(
        Modifier.fillMaxSize().testTag("chat_artifact_resources"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        ArtifactToolbar(R.string.chat_resources, R.string.back, ::back, toolbarPadding)
        LazyColumn(
            state = position,
            modifier = Modifier.widthIn(max = 768.dp).fillMaxWidth().padding(horizontal = 16.dp),
            contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp),
        ) {
            item {
                Text(
                    stringResource(R.string.artifact_title),
                    Modifier.padding(start = 12.dp, bottom = 4.dp).semantics { heading() },
                    style =
                        MaterialTheme.typography.labelMedium.copy(
                            fontSize = 13.sp,
                            lineHeight = 20.sp,
                        ),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (state.offline)
                item {
                    ResourceNotice(
                        if (result == null) R.string.artifact_offline_catalog
                        else R.string.artifact_offline_cached
                    )
                }
            if (showSkeleton) {
                items(3) { ArtifactRowSkeleton(height = 72.dp, horizontalPadding = 16.dp) }
            }
            if (result?.items?.isEmpty() == true) item { ResourceNotice(R.string.artifact_empty) }
            items(result?.items.orEmpty(), key = { it.id }) { item ->
                ChatArtifactResourceRow(
                    item,
                    dates.timestamp(item.createdAt, showDay = true),
                    if (item.id == restoreRow) {
                        Modifier.focusRequester(rowFocus).onGloballyPositioned {
                            if (page.restoreRow == item.id) {
                                page.restoreRow = null
                                rowFocus.requestFocus()
                            }
                        }
                    } else Modifier,
                ) {
                    page.selectedId = item.id
                    model.select(item.id, item)
                }
            }
            problem?.let { error -> item { ResourceNotice(error.label()) } }
            if (result != null && state.reading == ArtifactCatalogRead.More) {
                item { ArtifactRowSkeleton(height = 72.dp, horizontalPadding = 16.dp) }
            }
        }
    }
}

@Composable
private fun ResourceNotice(label: Int) {
    Text(
        stringResource(label),
        Modifier.padding(vertical = 12.dp).semantics { liveRegion = LiveRegionMode.Polite },
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun ChatArtifactResourceRow(
    item: ArtifactItem,
    timestamp: String,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 72.dp)
            .clip(RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
            Icon(painterResource(item.kind.icon()), null, Modifier.size(20.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(
                item.title,
                style =
                    MaterialTheme.typography.bodyLarge.copy(fontSize = 16.sp, lineHeight = 24.sp),
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                stringResource(
                    R.string.artifact_metadata,
                    stringResource(item.kind.label()),
                    timestamp,
                ),
                style =
                    MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp),
                color = colors.onSurfaceVariant,
            )
        }
        Icon(painterResource(R.drawable.ic_chevron_right), null, Modifier.size(24.dp))
    }
}
