package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.currentWindowSizeDp
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListItemInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

private const val HistoryFeedbackDelayMillis = 250L
private const val TimelineEnd = "conversation_end"
private const val TimelineInitial = "conversation_initial"
private const val TimelineActivity = "conversation_activity"
private val TimelineEndPadding = 16.dp

private data class ConversationActivityRow(@StringRes val label: Int, val showHeader: Boolean) :
    ConversationTimelineRow {
    override val key = TimelineActivity
}

@Composable
internal fun ConversationRoute(
    model: ConversationHistoryModel,
    threadId: String,
    list: ChatListUiState,
    modifier: Modifier = Modifier,
    visible: Boolean = true,
    composer: ChatComposerModel? = null,
    historyAvailable: Boolean = true,
    realtime: ChatUpdatesModel? = null,
    controls: ConversationRunControls? = null,
    artifactActions: ChatArtifactActions? = null,
    findTarget: ConversationFindTarget? = null,
    linkPosition: ConversationLinkPosition? = null,
    onLink: ((ConversationLink, ConversationLinkSource) -> Unit)? = null,
    onLinkFocusRestored: () -> Unit = {},
    linkFocusKey: String? = null,
    onLinkUnavailable: (() -> Unit)? = null,
    messageSequence: Long? = null,
    onSearchMessageResolved: (Long, Boolean) -> Unit = { _, _ -> },
    recovery: @Composable (failureId: String) -> Unit = {},
) {
    // Deferred work must acknowledge this composition's confirmation, never a newer State.value.
    val state = model.uiState.collectAsStateWithLifecycle().value
    val output = model.output.state.collectAsStateWithLifecycle().value
    val input = composer?.uiState?.collectAsStateWithLifecycle()
    val localMessages by
        remember(input, threadId) {
            derivedStateOf { input?.value?.messagesFor(threadId).orEmpty() }
        }
    val thread = state.thread?.takeIf { historyAvailable && it.id == threadId }
    val transcript = state.transcript.takeIf { thread != null }
    val content =
        remember(transcript, output, threadId, localMessages) {
            val confirmed = transcript?.withOutput(output, threadId).orEmpty()
            val rendered = conversationMessages(confirmed)
            val previews =
                localMessages.filterNot { it.eventId in transcript?.persistedIds.orEmpty() }
            rendered +
                previews.map { preview ->
                    ConversationMessage(
                        HistoryMessage(
                            preview.eventId,
                            null,
                            HistoryRole.User,
                            listOf(HistoryBlock(HistoryBlockKind.Text, preview.text)),
                        ),
                        deliveryStatus =
                            preview.disposition?.label()
                                ?: if (preview.sending) R.string.composer_sending
                                else R.string.composer_unconfirmed,
                    )
                }
        }
    val hasContent = transcript != null || content.isNotEmpty()
    val missing = thread != null && state.phase == HistoryPhase.Missing
    val firstReadFailed = !hasContent && thread != null && state.initialReadFailed
    val waitingForHistory =
        historyAvailable &&
            !list.offline &&
            !hasContent &&
            !firstReadFailed &&
            (thread == null || state.phase == HistoryPhase.Loading)
    val showSkeleton = key(threadId) { rememberChatWaitIndicator(waitingForHistory) }
    val showSync =
        key(threadId) {
            rememberChatWaitIndicator(
                transcript != null && state.phase == HistoryPhase.Loading && !list.offline,
                delayMillis = HistoryFeedbackDelayMillis,
            )
        }
    val realtimePhase = realtime?.phase?.collectAsStateWithLifecycle()?.value
    val reconnect = realtime.takeIf { !list.offline && realtimePhase == RealtimePhase.Unavailable }
    val showRealtimeConnecting =
        key(threadId) {
            rememberChatWaitIndicator(
                realtimePhase == RealtimePhase.Connecting &&
                    !waitingForHistory &&
                    !firstReadFailed &&
                    !list.offline,
                delayMillis = HistoryFeedbackDelayMillis,
            )
        }
    val visit =
        rememberConversationReadVisit(
            model,
            threadId,
            state.generation,
            visible && historyAvailable,
        )
    val readState = visit?.readState?.collectAsStateWithLifecycle()?.value
    val historyNotice =
        when {
            thread == null || list.offline || firstReadFailed -> null
            state.phase == HistoryPhase.Failed -> R.string.history_failed
            readState == HistoryReadState.Failed -> R.string.history_read_failed
            state.cacheUnavailable && hasContent -> R.string.chat_cache_unavailable
            else -> null
        }
    val activeRun = controls?.currentRunId ?: transcript?.activeRunId
    val execution = transcript?.execution?.takeUnless { list.offline || missing }
    val activity =
        when (execution) {
            HistoryExecution.Running -> R.string.conversation_processing
            HistoryExecution.Queued -> R.string.history_queued
            else -> null
        }
    val activeMessage =
        remember(content, activeRun) {
            activeRun?.let { runId ->
                content.lastOrNull {
                    it.message.runId == runId && it.message.role == HistoryRole.Assistant
                } ?: content.lastOrNull { it.message.runId == runId }
            }
        }
    val incomingTimeline =
        remember(content, activity, activeMessage) {
            val messages = content.asReversed()
            if (activity == null || messages.isEmpty()) messages
            else
                buildList<ConversationTimelineRow> {
                    addAll(messages)
                    // Reverse layout places the status below its owning message.
                    val index =
                        messages.indexOfFirst { it.key == activeMessage?.key }.coerceAtLeast(0)
                    add(
                        index,
                        ConversationActivityRow(
                            activity,
                            activeMessage?.message?.role != HistoryRole.Assistant,
                        ),
                    )
                }
        }
    val showHistorySyncNotice = showSync && (activity == null || content.isEmpty())
    val feedback: @Composable (() -> Unit)? =
        when {
            showHistorySyncNotice -> ({ HistorySyncNotice() })
            reconnect != null && !firstReadFailed -> ({
                    RealtimeNotice(reconnect, RealtimePhase.Unavailable)
                })
            historyNotice != null -> ({
                    ChatContentLoadNotice(
                        historyNotice,
                        horizontalPadding = 0.dp,
                        retry =
                            if (historyNotice == R.string.chat_cache_unavailable) null
                            else model::refresh,
                    )
                })
            realtime != null && showRealtimeConnecting -> ({
                    RealtimeNotice(realtime, RealtimePhase.Connecting)
                })
            else -> null
        }
    val window = currentWindowSizeDp()
    val messageInset = if (window.width >= 600) 32.dp else 24.dp
    val linkTarget = linkPosition?.destination
    val searchEventId =
        remember(transcript, messageSequence) {
            messageSequence?.let { sequence ->
                transcript
                    ?.messages
                    ?.firstOrNull { it.sourceSeqId == sequence && it.visibleInConversation() }
                    ?.id
            }
        }
    val requestedSearchTarget =
        remember(messageSequence, searchEventId) {
            searchEventId?.let { ConversationFindTarget(it, null) }
        }
    var revealedSearchTarget by
        remember(model, threadId) { mutableStateOf<ConversationFindTarget?>(null) }
    val searchTarget = if (messageSequence == null) revealedSearchTarget else requestedSearchTarget
    val readingTarget = findTarget ?: linkTarget ?: searchTarget
    val waitingForSearch =
        messageSequence != null && searchTarget == null && !list.offline && !missing
    LaunchedEffect(model, thread?.id, messageSequence, list.offline) {
        val sequence = messageSequence ?: return@LaunchedEffect
        if (thread != null && !list.offline && model.searchMessageIsMissing(threadId, sequence)) {
            revealedSearchTarget = null
            onSearchMessageResolved(sequence, false)
        }
    }
    val searchPositioned = requestedSearchTarget?.positioned == true
    LaunchedEffect(messageSequence, requestedSearchTarget, searchPositioned) {
        if (messageSequence != null && requestedSearchTarget != null && searchPositioned) {
            revealedSearchTarget = requestedSearchTarget
            onSearchMessageResolved(messageSequence, true)
        }
    }
    val targetMessageId =
        remember(readingTarget, content) {
            when {
                readingTarget == null -> null
                !readingTarget.isRun -> readingTarget.id
                else ->
                    content
                        .asSequence()
                        .flatMap { (it.earlier + it.message).asSequence() }
                        .firstOrNull { it.runId == readingTarget.id }
                        ?.id
            }
        }
    key(model, threadId) {
        val position = rememberLazyListState()
        val holdTimeline by
            remember(position) {
                derivedStateOf {
                    position.isScrollInProgress &&
                        position.canScrollBackward &&
                        position.firstVisibleRowIsStatus()
                }
            }
        // Compose anchors to the first row's key. If that key is a status row, defer row changes
        // until its message can be re-anchored without cancelling the reader's gesture.
        var presentedTimeline by remember { mutableStateOf(incomingTimeline) }
        val timeline = if (holdTimeline) presentedTimeline else incomingTimeline
        SideEffect { presentedTimeline = timeline }
        val runningRows =
            if (activity == R.string.conversation_processing) setOf(TimelineActivity)
            else emptySet()
        val runningFrame = rememberRunningWaveFrame(position, runningRows)
        val scope = rememberCoroutineScope()
        var restored by remember(linkPosition) { mutableStateOf(false) }
        var restoredAnchor by remember(linkPosition) { mutableStateOf<ConversationAnchor?>(null) }
        var positioned by remember(linkPosition, searchTarget) { mutableStateOf(false) }
        var findViewport by remember { mutableStateOf<LayoutCoordinates?>(null) }
        var hasSeenLatest by remember { mutableStateOf(false) }
        var newReply by remember { mutableStateOf(false) }
        val previewId = content.lastOrNull()?.takeIf { it.deliveryStatus != null }?.message?.id
        var lastPreviewId by remember { mutableStateOf(previewId) }
        val newestReply =
            remember(content) {
                content
                    .lastOrNull {
                        it.message.role == HistoryRole.Assistant && it.message.blocks.isNotEmpty()
                    }
                    ?.message
                    ?.id
            }
        var lastReply by remember { mutableStateOf<String?>(null) }
        val atEnd by
            remember(position) {
                derivedStateOf {
                    position.layoutInfo.totalItemsCount > 0 && !position.canScrollBackward
                }
            }
        val density = LocalDensity.current
        val jumpDistance = with(density) { 80.dp.roundToPx() }
        // Measure the tail and the nearest four rows, including their message spacing.
        val recentKeys =
            remember(timeline) { listOf(TimelineEnd) + timeline.take(4).map { it.key } }
        val recentSizes = remember(position) { mutableStateMapOf<String, Int>() }
        val pastJumpThreshold by
            remember(position, jumpDistance, recentKeys) {
                derivedStateOf { position.pastEnd(jumpDistance, recentKeys, recentSizes) }
            }
        SideEffect { recentSizes.keys.retainAll(recentKeys.toSet()) }
        LaunchedEffect(model, threadId, linkPosition) {
            val source = linkPosition?.source
            restoredAnchor =
                if (source != null) source.anchor else model.restoreReadingAnchor(threadId)
            restored = true
        }
        val foundIndex =
            remember(targetMessageId, timeline) {
                if (targetMessageId == null) -1
                else
                    timeline.indexOfFirst {
                        it is ConversationMessage && it.includes(targetMessageId)
                    }
            }
        val pendingFind = readingTarget?.takeUnless { it.positioned }
        LaunchedEffect(
            restored,
            positioned,
            timeline,
            state.phase,
            list.offline,
            readingTarget,
            waitingForSearch,
        ) {
            if (!restored || positioned || waitingForSearch || (!hasContent && !missing))
                return@LaunchedEffect
            val anchor = restoredAnchor
            val index =
                timeline.indexOfFirst { it is ConversationMessage && it.includes(anchor?.eventId) }
            val jumpIndex = if (pendingFind == null) -1 else foundIndex
            // A cached checkpoint can be older than the saved anchor. Give catch-up a chance first.
            if (
                (pendingFind != null && jumpIndex < 0 || anchor != null && index < 0) &&
                    state.phase == HistoryPhase.Loading &&
                    !list.offline
            )
                return@LaunchedEffect
            val row = (if (jumpIndex >= 0) jumpIndex else index) + 1
            val offset =
                if (jumpIndex < 0 && index >= 0 && anchor != null)
                    with(density) { anchor.offsetDp.dp.roundToPx() }
                else 0
            if (pendingFind == null) {
                position.scrollToItem(row, offset)
            } else {
                // A reader's gesture can cancel the scroll without cancelling this entry.
                coroutineScope { launch { position.scrollToItem(row, offset) }.join() }
                if (jumpIndex < 0) pendingFind.finishPositioning()
            }
            positioned = true
        }
        if (onLinkUnavailable != null) {
            val missingLinkTarget =
                positioned && linkTarget != null && readingTarget === linkTarget && foundIndex < 0
            LaunchedEffect(missing, firstReadFailed, missingLinkTarget, linkPosition) {
                if (missing || firstReadFailed || missingLinkTarget) onLinkUnavailable()
            }
        }
        val awaitingFindPosition = foundIndex >= 0 && pendingFind != null
        val revealTarget = pendingFind?.takeIf { positioned && foundIndex >= 0 }
        if (revealTarget != null) {
            val findRowKey = timeline[foundIndex].key
            LaunchedEffect(position, findRowKey) {
                // A folded reply may still be laying out when the reader scrolls away.
                snapshotFlow { position.layoutInfo.visibleItemsInfo.none { it.key == findRowKey } }
                    .first { it }
                revealTarget.finishPositioning()
            }
        }
        val revealFindHit: (suspend (LayoutCoordinates) -> Unit)? =
            if (revealTarget != null) {
                { hit ->
                    try {
                        val viewport =
                            snapshotFlow { findViewport?.takeIf { it.isAttached } }
                                .filterNotNull()
                                .first()
                        if (hit.isAttached) {
                            val bounds = viewport.localBoundingBoxOf(hit, clipBounds = false)
                            val targetTop =
                                (viewport.size.height - bounds.height).coerceAtLeast(0f) / 2f
                            // The timeline scrolls in reverse layout order.
                            position.scrollBy(targetTop - bounds.top)
                        }
                    } finally {
                        revealTarget.finishPositioning()
                    }
                }
            } else null
        LaunchedEffect(readingTarget, pendingFind) {
            if (pendingFind == null) readingTarget?.expireHighlight()
        }
        val readingReady = positioned && !awaitingFindPosition && !waitingForSearch
        LaunchedEffect(positioned, previewId) {
            // A newly submitted local preview is an action in this chat. A restored preview
            // belongs to the original attempt and should leave the restored reading position.
            if (positioned && previewId != null && previewId != lastPreviewId) {
                pendingFind?.finishPositioning()
                position.scrollToItem(0)
            }
            lastPreviewId = previewId
        }
        val latestConfirmed =
            remember(transcript, content) {
                val id = transcript?.messages?.lastOrNull { it.visibleInConversation() }?.id
                content.lastOrNull { it.includes(id) }?.key
            }
        val latestDisplayed by
            remember(position, latestConfirmed) {
                derivedStateOf {
                    val laidOut = position.layoutInfo.visibleItemsInfo
                    laidOut.any { it.key == TimelineEnd } &&
                        (latestConfirmed == null || laidOut.any { it.key == latestConfirmed })
                }
            }
        val displayedConfirmation =
            state.confirmation.takeIf { readingReady && atEnd && latestDisplayed && !list.offline }
        LaunchedEffect(visit, displayedConfirmation) {
            displayedConfirmation?.let { visit?.confirmDisplayed(it) }
        }
        SideEffect {
            if (readingReady) {
                if (atEnd && visible && latestDisplayed) {
                    hasSeenLatest = true
                    newReply = false
                } else if (!atEnd) {
                    position.keepMessageWhenStatusMoves(timeline)
                    if (newestReply != null && newestReply != lastReply) newReply = true
                }
            }
            lastReply = newestReply
        }
        LaunchedEffect(model, thread?.id, position, readingReady, visible, density) {
            if (!readingReady || !visible || thread == null) return@LaunchedEffect
            snapshotFlow {
                    when {
                        position.isScrollInProgress -> null
                        !position.canScrollBackward -> ReadingPosition(null)
                        else ->
                            position.firstVisibleMessage()?.let {
                                ReadingPosition(it.readingAnchor(density))
                            }
                    }
                }
                .filterNotNull()
                .collect { model.rememberReadingAnchor(threadId, it.anchor) }
        }
        val jump =
            when {
                !readingReady || atEnd || !position.canScrollBackward -> null
                newReply || (!hasSeenLatest && list.isUnread(threadId)) ->
                    R.string.conversation_new_reply
                !pastJumpThreshold -> null
                activity != null -> R.string.conversation_view_progress
                else -> R.string.conversation_jump_latest
            }
        val links =
            onLink?.let { open ->
                ConversationLinkActions(
                    { link, key ->
                        val anchor =
                            position
                                .firstVisibleMessage()
                                ?.takeIf { position.canScrollBackward }
                                ?.readingAnchor(density)
                        open(link, ConversationLinkSource(key, anchor))
                    },
                    linkFocusKey.takeIf { readingReady },
                    onLinkFocusRestored,
                )
            }
        Box(modifier.fillMaxSize()) {
            LazyColumn(
                Modifier.fillMaxSize()
                    .testTag("conversation")
                    .then(
                        if (awaitingFindPosition)
                            Modifier.onGloballyPositioned { findViewport = it }
                        else Modifier
                    ),
                state = position,
                reverseLayout = true,
                contentPadding =
                    PaddingValues(
                        start = messageInset,
                        end = messageInset,
                        top = 24.dp,
                        bottom = TimelineEndPadding,
                    ),
                verticalArrangement = Arrangement.spacedBy(0.dp, Alignment.Top),
            ) {
                // A stable last item anchors the viewport even when a stream grows or the IME
                // resizes it.
                item(key = TimelineEnd) {
                    Column(
                        Modifier.fillMaxWidth().onSizeChanged {
                            recentSizes[TimelineEnd] = it.height
                        }
                    ) {
                        if (feedback != null || controls?.hasFeedback == true)
                            Column(
                                Modifier.padding(top = if (showHistorySyncNotice) 4.dp else 8.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                feedback?.invoke()
                                if (controls?.hasFeedback == true) RunControlsFeedback(controls)
                            }
                    }
                }
                itemsIndexed(timeline, key = { _, entry -> entry.key }) { index, entry ->
                    val trackSize =
                        if (index < 4) Modifier.onSizeChanged { recentSizes[entry.key] = it.height }
                        else Modifier
                    when (entry) {
                        is ConversationActivityRow ->
                            Column(
                                trackSize
                                    .fillMaxWidth()
                                    .padding(top = if (entry.showHeader) 20.dp else 8.dp)
                            ) {
                                if (entry.showHeader) ConversationReplyHeader()
                                ConversationActivity(entry.label, runningFrame = runningFrame)
                            }
                        is ConversationMessage -> {
                            val highlight =
                                readingTarget
                                    ?.takeIf { positioned && entry.includes(targetMessageId) }
                                    ?.let {
                                        ConversationFindHighlight(
                                            it,
                                            revealFindHit,
                                            checkNotNull(targetMessageId),
                                        )
                                    }
                            // Keep a message's lower edge independent of a new reply below it.
                            Column(
                                trackSize.padding(
                                    top = if (index == timeline.lastIndex) 0.dp else 20.dp
                                )
                            ) {
                                ConversationMessageRow(
                                    entry,
                                    revoke = controls?.revoke(entry.message.id),
                                    artifactActions = artifactActions,
                                    findHighlight = highlight,
                                    links = links,
                                )
                                if (entry.message.status == "run.failed") recovery(entry.message.id)
                            }
                        }
                    }
                }
                if (timeline.isEmpty()) {
                    item(key = TimelineInitial) {
                        when {
                            missing -> Text(stringResource(R.string.history_missing))
                            list.offline && !hasContent ->
                                Text(stringResource(R.string.conversation_history_offline))
                            firstReadFailed ->
                                ChatContentLoadNotice(
                                    R.string.chat_list_first_load_failed,
                                    horizontalPadding = 0.dp,
                                    retry = reconnect?.let { it::retry } ?: model::refresh,
                                    retryEnabled =
                                        reconnect != null || state.phase != HistoryPhase.Loading,
                                )
                            waitingForHistory -> if (showSkeleton) ConversationSkeleton()
                            transcript != null -> Text(stringResource(R.string.history_empty))
                        }
                    }
                }
            }
            if (positioned && !atEnd && position.canScrollBackward) {
                Box(
                    Modifier.align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .height(24.dp)
                        .background(
                            Brush.verticalGradient(
                                listOf(Color.Transparent, MaterialTheme.colorScheme.background)
                            )
                        )
                )
            }
            if (jump != null) {
                ConversationJump(
                    jump,
                    modifier =
                        Modifier.align(
                                if (window.height < 480) Alignment.BottomEnd
                                else Alignment.BottomCenter
                            )
                            .padding(bottom = 4.dp, end = if (window.height < 480) 12.dp else 0.dp),
                    onClick = { scope.launch { position.scrollToItem(0) } },
                )
            }
            if (positioned && findTarget != null && foundIndex < 0) {
                Text(
                    stringResource(R.string.conversation_find_unavailable),
                    Modifier.align(Alignment.TopCenter)
                        .background(MaterialTheme.colorScheme.surface)
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .semantics { liveRegion = LiveRegionMode.Polite },
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

private val TimelineFixedKeys = setOf(TimelineEnd, TimelineInitial, TimelineActivity)

private data class ReadingPosition(val anchor: ConversationAnchor?)

private fun LazyListItemInfo.readingAnchor(density: Density): ConversationAnchor =
    ConversationAnchor(key as String, with(density) { (-offset).toDp().value })

private fun LazyListState.firstVisibleMessage(): LazyListItemInfo? =
    layoutInfo.visibleItemsInfo.firstOrNull { it.key !in TimelineFixedKeys }

private fun LazyListState.firstVisibleRowIsStatus(): Boolean {
    val index = firstVisibleItemIndex
    return layoutInfo.visibleItemsInfo.any { it.index == index && it.key in TimelineFixedKeys }
}

private fun LazyListState.keepMessageWhenStatusMoves(timeline: List<ConversationTimelineRow>) {
    if (isScrollInProgress || !firstVisibleRowIsStatus()) return
    val message = firstVisibleMessage() ?: return
    val newIndex = timeline.indexOfFirst { it.key == message.key } + 1
    // Compose would otherwise anchor to the status row while it moves to a different message.
    if (newIndex > 0 && newIndex != message.index) requestScrollToItem(newIndex, -message.offset)
}

private fun LazyListState.pastEnd(
    threshold: Int,
    newestKeys: List<String>,
    measured: Map<String, Int>,
): Boolean {
    val first = firstVisibleItemIndex
    if (first >= newestKeys.size) return true
    var distance = firstVisibleItemScrollOffset
    for (index in 0 until first) {
        distance += measured[newestKeys[index]] ?: return true
    }
    return distance > threshold
}

@Composable
private fun rememberConversationReadVisit(
    model: ConversationHistoryModel,
    threadId: String,
    generation: Long,
    visible: Boolean,
): ConversationReadSession? {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var visit by
        remember(model, threadId, generation) { mutableStateOf<ConversationReadSession?>(null) }
    DisposableEffect(model, threadId, generation, lifecycle, visible) {
        fun update() {
            if (visible && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                if (visit == null) visit = model.beginVisit(threadId, generation)
            } else {
                visit?.let(model::endVisit)
                visit = null
            }
        }
        val observer = LifecycleEventObserver { _, _ -> update() }
        lifecycle.addObserver(observer)
        update()
        onDispose {
            lifecycle.removeObserver(observer)
            visit?.let(model::endVisit)
            visit = null
        }
    }
    return visit
}

@Composable
private fun ConversationJump(labelId: Int, modifier: Modifier, onClick: () -> Unit) {
    val label = stringResource(labelId)
    val colors = MaterialTheme.colorScheme
    val iconOnly = labelId == R.string.conversation_jump_latest
    Surface(
        onClick = onClick,
        modifier =
            modifier
                .heightIn(min = 48.dp)
                .semantics {
                    contentDescription = label
                    if (labelId == R.string.conversation_new_reply)
                        liveRegion = LiveRegionMode.Polite
                }
                .testTag("conversation_jump"),
        shape = CircleShape,
        color = colors.surface,
        contentColor = colors.onSurface,
        border = androidx.compose.foundation.BorderStroke(1.dp, colors.outline),
        shadowElevation = 2.dp,
    ) {
        Row(
            Modifier.padding(
                horizontal = if (iconOnly) 14.dp else 12.dp,
                vertical = if (iconOnly) 0.dp else 8.dp,
            ),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                painterResource(R.drawable.ic_arrow_downward),
                null,
                Modifier.size(if (iconOnly) 20.dp else 16.dp),
            )
            if (!iconOnly)
                Text(
                    label,
                    style =
                        MaterialTheme.typography.bodySmall.copy(
                            fontSize = 13.sp,
                            lineHeight = 20.sp,
                        ),
                )
        }
    }
}

@Composable
private fun HistorySyncNotice() {
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(
            Modifier.size(14.dp),
            color = color,
            strokeWidth = 2.dp,
            strokeCap = StrokeCap.Round,
        )
        Text(
            stringResource(R.string.history_syncing),
            color = color,
            fontSize = 13.sp,
            lineHeight = 20.sp,
        )
    }
}

@Composable
private fun ConversationSkeleton() {
    val label = stringResource(R.string.history_loading)
    Column(
        Modifier.fillMaxWidth().semantics { contentDescription = label },
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        repeat(2) { turn ->
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                ChatSkeletonBlock(
                    Modifier.align(Alignment.End)
                        .fillMaxWidth(if (turn == 0) .44f else .35f)
                        .height(if (turn == 0) 52.dp else 40.dp),
                    cornerRadius = 16.dp,
                )
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(
                        Modifier.heightIn(min = 48.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        ChatSkeletonBlock(Modifier.size(24.dp))
                        ChatSkeletonBlock(Modifier.width(48.dp).height(12.dp))
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        ChatSkeletonBlock(Modifier.fillMaxWidth(.72f).height(14.dp))
                        ChatSkeletonBlock(Modifier.fillMaxWidth(.88f).height(14.dp))
                        if (turn == 0) ChatSkeletonBlock(Modifier.fillMaxWidth(.54f).height(14.dp))
                    }
                }
            }
        }
    }
}
