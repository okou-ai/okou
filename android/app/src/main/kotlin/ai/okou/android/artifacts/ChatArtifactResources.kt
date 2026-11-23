package ai.okou.android.artifacts

import ai.okou.android.R
import ai.okou.android.chat.ChatListSkeletonDelayMillis
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
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
internal fun ChatArtifactLinkPreview(
    model: ArtifactCatalogModel,
    link: String,
    wide: Boolean,
    onClose: () -> Unit,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val page = rememberArtifactPageState()
    val saveLauncher = rememberArtifactSaveLauncher(model, page)
    LifecycleStartEffect(model, link) {
        model.select(link)
        model.setActive(true, showCatalog = false)
        onStopOrDispose { model.setActive(false) }
    }
    BackHandler(onBack = onClose)
    Column(Modifier.fillMaxSize()) {
        ArtifactToolbar(R.string.artifact_title, R.string.back, onClose, if (wide) 28.dp else 12.dp)
        ArtifactSelectionPreview(model, state, page, link, wide, saveLauncher)
    }
}

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
    val saveLauncher = rememberArtifactSaveLauncher(model, page)
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
            ArtifactSelectionPreview(model, state, page, selected, wide, saveLauncher)
        }
        return
    }
    val result = state.page.takeIf { state.query == query }
    val failure = state.failedRead.takeIf { state.query == query }
    val reading = state.reading.takeIf { state.query == query }
    val showSkeleton =
        rememberChatWaitIndicator(result == null && failure == null, ChatListSkeletonDelayMillis)
    val dates = rememberArtifactDates()
    val rowFocus = remember { FocusRequester() }
    val restoreRow = page.restoreRow
    LaunchedEffect(result, reading, failure) {
        if (result?.nextCursor != null && reading == null && failure == null) {
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
        if (result == null && failure != null) {
            ArtifactInitialReadFailure(
                failure.label(chatResources = true),
                Modifier.widthIn(max = 768.dp),
            )
            return@Column
        }
        Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.TopCenter) {
            LazyColumn(
                state = position,
                modifier = Modifier.widthIn(max = 768.dp).fillMaxSize().padding(horizontal = 16.dp),
                contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp),
            ) {
                item(key = "resource-heading") {
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
                if (showSkeleton) {
                    items(3) { ArtifactRowSkeleton(height = 72.dp, horizontalPadding = 16.dp) }
                }
                if (result?.items?.isEmpty() == true) {
                    item {
                        ArtifactReadNotice(
                            R.string.artifact_empty,
                            Modifier.padding(vertical = 12.dp),
                        )
                    }
                }
                items(result?.items.orEmpty(), key = { it.id }) { item ->
                    ChatArtifactResourceRow(
                        item,
                        dates.timestamp(checkNotNull(item.createdAt), showDay = true),
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
                if (failure != null) {
                    item(key = "resource-read-failure") {
                        ArtifactReadNotice(
                            failure.label(chatResources = true),
                            Modifier.padding(vertical = 8.dp),
                        )
                    }
                }
                if (reading == ArtifactCatalogRead.More) {
                    item { ArtifactRowSkeleton(height = 72.dp, horizontalPadding = 16.dp) }
                }
            }
            if (reading == ArtifactCatalogRead.SyncingStale) {
                val label = stringResource(R.string.chat_resources_syncing)
                val colors = MaterialTheme.colorScheme
                LinearProgressIndicator(
                    Modifier.fillMaxWidth().semantics { contentDescription = label },
                    color = colors.primary,
                    trackColor =
                        colors.primary.copy(alpha = 0.18f).compositeOver(colors.background),
                )
            }
        }
    }
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
