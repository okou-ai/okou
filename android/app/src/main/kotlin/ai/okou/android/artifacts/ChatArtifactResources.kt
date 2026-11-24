package ai.okou.android.artifacts

import ai.okou.android.ContentReadProgress
import ai.okou.android.R
import ai.okou.android.chat.ChatListSkeletonDelayMillis
import ai.okou.android.chat.ChatResourceOrigin
import ai.okou.android.chat.ConversationLink
import ai.okou.android.chat.ConversationUiState
import ai.okou.android.chat.HistoryPhase
import ai.okou.android.chat.MessageLinkAnchor
import ai.okou.android.chat.conversationLink
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
        ArtifactToolbar(
            R.string.chat_search_artifact_preview,
            R.string.back,
            onClose,
            if (wide) 28.dp else 12.dp,
        )
        ArtifactSelectionPreview(model, state, page, link, wide, saveLauncher)
    }
}

@Composable
internal fun ChatArtifactResources(
    model: ArtifactCatalogModel,
    threadId: String,
    wide: Boolean,
    onClose: () -> Unit,
    history: ConversationUiState,
    resourceFocusKey: String?,
    availableRelatedChats: Map<String, String?>,
    onResourceFocusRestored: () -> Unit,
    onOpenLink: (ConversationLink, String) -> Unit,
    onOpenWorkflow: ((String, String) -> Unit)?,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val query = remember(threadId) { ArtifactQuery(chatThreadId = threadId) }
    val page = rememberArtifactPageState()
    val saveLauncher = rememberArtifactSaveLauncher(model, page)
    val position = rememberLazyListState()
    val matchesQuery = state.query == query
    val failure = state.failedRead.takeIf { matchesQuery }
    val unavailable =
        when {
            history.phase == HistoryPhase.Missing -> ArtifactCatalogFailure.ChatUnavailable
            failure == ArtifactCatalogFailure.Denied ||
                failure == ArtifactCatalogFailure.ChatUnavailable ||
                failure == ArtifactCatalogFailure.Missing -> failure
            else -> null
        }
    val selected = page.selectedId.takeIf { unavailable == null }
    LaunchedEffect(unavailable) {
        if (unavailable != null) {
            page.selectedId = null
            page.restoreRow = null
        }
    }
    val references = history.transcript?.resources.takeIf { unavailable == null }
    val workflowIds = references?.workflowIds.orEmpty().takeIf { onOpenWorkflow != null }.orEmpty()
    LifecycleStartEffect(model, threadId) {
        model.setActive(true, query)
        onStopOrDispose { model.setActive(false) }
    }
    LaunchedEffect(model, selected) { model.select(selected) }
    LaunchedEffect(model, threadId, workflowIds) { model.relatedWorkflowIds(threadId, workflowIds) }

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
    if (unavailable != null) {
        Column(
            Modifier.fillMaxSize().testTag("chat_artifact_resources"),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            ArtifactToolbar(R.string.chat_resources, R.string.back, ::back, toolbarPadding)
            ArtifactInitialReadFailure(unavailable.label(), Modifier.widthIn(max = 768.dp))
        }
        return
    }
    if (selected != null) {
        Column(Modifier.fillMaxSize()) {
            ArtifactToolbar(
                R.string.chat_search_artifact_preview,
                R.string.chat_resources_back,
                ::back,
                toolbarPadding,
            )
            ArtifactSelectionPreview(model, state, page, selected, wide, saveLauncher)
        }
        return
    }
    val result = state.page.takeIf { matchesQuery }
    val reading = state.reading.takeIf { matchesQuery }
    val related = state.relatedChats.takeIf { matchesQuery }
    val workflows = state.workflows.takeIf { matchesQuery && workflowIds.isNotEmpty() }
    val workflowRows = workflows?.confirmed?.items.orEmpty().filter { it.id in workflowIds }
    val showWorkflowSkeleton =
        rememberChatWaitIndicator(
            workflows?.checking == true && workflows.confirmed == null,
            ChatListSkeletonDelayMillis,
        )
    val external = references?.origin as? ChatResourceOrigin.External
    val externalTitle = external?.let { resourceSourceTitle(it) }
    val forwarded =
        (references?.origin as? ChatResourceOrigin.Forwarded)?.takeIf {
            it.threadId != threadId &&
                it.threadId in availableRelatedChats &&
                related?.failure != RelatedChatReadFailure.AccessLost &&
                related?.confirmed?.unavailable(it.threadId) != true
        }
    val relatedRows =
        remember(related?.confirmed, availableRelatedChats, forwarded) {
            related?.confirmed?.rows().orEmpty().filter {
                it.threadId in availableRelatedChats && it.threadId != forwarded?.threadId
            }
        }
    val relatedError =
        when (related?.failure) {
            RelatedChatReadFailure.Temporary -> R.string.chat_resources_related_load_failed
            RelatedChatReadFailure.AccessLost -> R.string.chat_resources_related_access_lost
            null -> null
        }
    val showRelatedSkeleton =
        rememberChatWaitIndicator(
            related?.checking == true &&
                related.confirmed == null &&
                (result != null || failure != null),
            ChatListSkeletonDelayMillis,
        )
    val showSkeleton =
        rememberChatWaitIndicator(result == null && failure == null, ChatListSkeletonDelayMillis)
    val historyDelay = history.syncProgressDelayMillis.takeUnless { references == null }
    val historyStale =
        rememberChatWaitIndicator(
            historyDelay != null && history.phase == HistoryPhase.Loading,
            historyDelay ?: 0L,
        )
    val dates = rememberArtifactDates()
    val rowFocus = remember { FocusRequester() }
    val resourceFocus = remember { FocusRequester() }
    fun returnFocus(key: String): Modifier =
        if (key == resourceFocusKey) {
            Modifier.focusRequester(resourceFocus).onGloballyPositioned {
                if (resourceFocus.requestFocus()) onResourceFocusRestored()
            }
        } else Modifier
    val restoreRow = page.restoreRow
    LaunchedEffect(result, reading, failure) {
        if (result?.nextCursor != null && reading == null && failure == null) {
            snapshotFlow {
                val layout = position.layoutInfo
                val last = layout.visibleItemsInfo.lastOrNull()?.index ?: -1
                last >= 0 && last >= result.items.size - 3
            }
                .collect { nearEnd -> if (nearEnd) model.loadNext() }
        }
    }
    Column(
        Modifier.fillMaxSize().testTag("chat_artifact_resources"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        ArtifactToolbar(R.string.chat_resources, R.string.back, ::back, toolbarPadding)
        if (
            result == null &&
                failure != null &&
                externalTitle == null &&
                workflowRows.isEmpty() &&
                workflows?.failed != true &&
                !showWorkflowSkeleton &&
                forwarded == null &&
                relatedRows.isEmpty() &&
                relatedError == null &&
                !showRelatedSkeleton
        ) {
            ArtifactInitialReadFailure(
                failure.label(chatResources = true),
                Modifier.widthIn(max = 768.dp),
            )
            return@Column
        }
        Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.TopCenter) {
            LazyColumn(
                state = position,
                modifier =
                    Modifier.widthIn(max = 768.dp)
                        .fillMaxSize()
                        .padding(horizontal = 16.dp)
                        .testTag("chat_resources_list"),
                contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp),
            ) {
                if (result != null || failure == null)
                    item(key = "resource-heading") {
                        ResourceHeading(R.string.artifact_title)
                    }
                if (showSkeleton) {
                    items(3) { ArtifactRowSkeleton(height = 72.dp, horizontalPadding = 16.dp) }
                }
                if (failure != null && failure != ArtifactCatalogFailure.More) {
                    item(key = "resource-read-failure") {
                        ArtifactReadNotice(
                            failure.label(chatResources = true),
                            Modifier.padding(bottom = 12.dp),
                        )
                    }
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
                    ChatResourceRow(
                        item.title,
                        stringResource(
                            R.string.artifact_metadata,
                            stringResource(item.kind.label()),
                            dates.timestamp(checkNotNull(item.createdAt), showDay = true),
                        ),
                        item.kind.icon(),
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
                if (failure == ArtifactCatalogFailure.More) {
                    item(key = "resource-page-failure") {
                        ArtifactReadNotice(
                            failure.label(chatResources = true),
                            Modifier.padding(top = 12.dp),
                        )
                    }
                }
                if (reading == ArtifactCatalogRead.More) {
                    item { ArtifactRowSkeleton(height = 72.dp, horizontalPadding = 16.dp) }
                }
                if (external != null && externalTitle != null) {
                    item(key = "origin-heading") {
                        Spacer(Modifier.height(16.dp))
                        ResourceHeading(R.string.chat_resources_origin)
                    }
                    item(key = "origin-external") {
                        val link = remember(external) { external.sourceLink() }
                        ChatResourceRow(
                            externalTitle,
                            null,
                            if (external.kind == "mcp") R.drawable.ic_extension
                            else R.drawable.ic_chat_bubble,
                            Modifier,
                            trailingIcon = R.drawable.ic_open_in_new,
                            onClick = link?.let { { onOpenLink(it, "origin-external") } },
                        )
                    }
                }
                if (
                    workflowRows.isNotEmpty() || showWorkflowSkeleton || workflows?.failed == true
                ) {
                    item(key = "workflows-heading") {
                        Spacer(Modifier.height(16.dp))
                        ResourceHeading(R.string.chat_resources_workflows)
                    }
                    items(workflowRows, key = { "workflow:${it.id}" }) { workflow ->
                        val key = "workflow:${workflow.id}"
                        ChatResourceRow(
                            workflow.title,
                            stringResource(R.string.workflow_automations),
                            R.drawable.ic_account_tree,
                            returnFocus(key),
                        ) {
                            onOpenWorkflow?.invoke(workflow.id, key)
                        }
                    }
                    if (showWorkflowSkeleton)
                        item(key = "workflows-loading") {
                            ArtifactRowSkeleton(height = 72.dp, horizontalPadding = 16.dp)
                        }
                    if (workflows?.failed == true)
                        item(key = "workflows-read-failure") {
                            ArtifactReadNotice(
                                R.string.chat_resources_workflows_load_failed,
                                Modifier.padding(bottom = 12.dp),
                            )
                        }
                }
                if (
                    forwarded != null ||
                        relatedRows.isNotEmpty() ||
                        relatedError != null ||
                        showRelatedSkeleton
                ) {
                    item(key = "related-heading") {
                        Spacer(Modifier.height(16.dp))
                        ResourceHeading(R.string.chat_resources_related)
                    }
                    if (forwarded != null) {
                        val key = "related:${forwarded.threadId}"
                        item(key = key) {
                            ChatResourceRow(
                                availableRelatedChats[forwarded.threadId]?.takeIf {
                                    it.isNotBlank()
                                } ?: stringResource(R.string.chat_untitled),
                                stringResource(R.string.chat_resources_origin),
                                R.drawable.ic_chat,
                                returnFocus(key),
                            ) {
                                onOpenLink(
                                    ConversationLink.Chat(
                                        forwarded.threadId,
                                        MessageLinkAnchor(forwarded.runId, isRun = true),
                                    ),
                                    key,
                                )
                            }
                        }
                    }
                    items(relatedRows, key = { "related:${it.threadId}" }) { peer ->
                        val key = "related:${peer.threadId}"
                        ChatResourceRow(
                            peer.title?.takeIf { it.isNotBlank() }
                                ?: stringResource(R.string.chat_untitled),
                            null,
                            R.drawable.ic_chat,
                            returnFocus(key),
                        ) {
                            onOpenLink(ConversationLink.Chat(peer.threadId, null), key)
                        }
                    }
                    if (showRelatedSkeleton)
                        item(key = "related-loading") {
                            ArtifactRowSkeleton(height = 56.dp, horizontalPadding = 16.dp)
                        }
                    if (relatedError != null)
                        item(key = "related-read-failure") {
                            ArtifactReadNotice(
                                relatedError,
                                Modifier.padding(bottom = 12.dp),
                            )
                        }
                }
            }
            if (
                reading == ArtifactCatalogRead.SyncingStale ||
                    related?.syncingStale == true ||
                    workflows?.syncingStale == true ||
                    historyStale
            ) {
                ContentReadProgress(R.string.chat_resources_syncing)
            }
        }
    }
}

private val whatsappMessage = Regex("https://wa\\.me/[0-9]+")
private val discordMessage = Regex("https://discord\\.com/channels/(?:[0-9]+|@me)/[0-9]+/[0-9]+")

@Composable
private fun resourceSourceTitle(source: ChatResourceOrigin.External): String? =
    when (source.kind) {
        "mcp" -> source.clientName?.takeIf { it.isNotBlank() } ?: "MCP"
        "slack" -> "Slack"
        "discord" -> "Discord"
        "wechat" -> stringResource(R.string.chat_resources_wechat)
        "feishu" ->
            if (source.href?.startsWith("https://applink.larksuite.com/") == true) "Lark"
            else stringResource(R.string.chat_resources_feishu)
        "lark" -> "Lark"
        "teams" -> "Microsoft Teams"
        "telegram" -> "Telegram"
        "github" -> "GitHub"
        "agentphone" ->
            if (source.href?.matches(whatsappMessage) == true) "WhatsApp"
            else stringResource(R.string.chat_resources_messages)
        else -> null
    }

private fun ChatResourceOrigin.External.sourceLink(): ConversationLink.Web? {
    val target = href ?: return null
    if (kind == "mcp" || kind == "discord" && !target.matches(discordMessage)) return null
    val link = conversationLink(target) as? ConversationLink.Web
    return link?.takeIf { it.url.isHttps }
}

@Composable
private fun ResourceHeading(@androidx.annotation.StringRes label: Int) {
    Text(
        stringResource(label),
        Modifier.padding(start = 12.dp, bottom = 4.dp).semantics { heading() },
        style = MaterialTheme.typography.labelMedium.copy(fontSize = 13.sp, lineHeight = 20.sp),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun ChatResourceRow(
    title: String,
    subtitle: String?,
    @androidx.annotation.DrawableRes icon: Int,
    modifier: Modifier,
    @androidx.annotation.DrawableRes trailingIcon: Int = R.drawable.ic_chevron_right,
    onClick: (() -> Unit)?,
) {
    val colors = MaterialTheme.colorScheme
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = if (subtitle == null) 56.dp else 72.dp)
            .clip(RoundedCornerShape(12.dp))
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
            Icon(painterResource(icon), null, Modifier.size(20.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(
                title,
                style =
                    MaterialTheme.typography.bodyLarge.copy(fontSize = 16.sp, lineHeight = 24.sp),
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle != null)
                Text(
                    subtitle,
                    style =
                        MaterialTheme.typography.bodyMedium.copy(
                            fontSize = 14.sp,
                            lineHeight = 20.sp,
                        ),
                    color = colors.onSurfaceVariant,
                )
        }
        if (onClick != null) Icon(painterResource(trailingIcon), null, Modifier.size(24.dp))
    }
}
