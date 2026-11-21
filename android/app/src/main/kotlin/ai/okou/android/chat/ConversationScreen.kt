package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.currentWindowSizeDp
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
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
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch

private const val HistoryFeedbackDelayMillis = 250L
private const val TimelineEnd = "conversation_end"
private const val TimelineInitial = "conversation_initial"
private val TimelineEndPadding = 16.dp

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
                content
                    .lastOrNull {
                        it.message.runId == runId && it.message.role == HistoryRole.Assistant
                    }
                    ?.message
                    ?.id ?: content.lastOrNull { it.message.runId == runId }?.message?.id
            }
        }
    val feedback: @Composable (() -> Unit)? =
        when {
            showSync -> ({ HistorySyncNotice() })
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
    key(model, threadId) {
        val position = rememberLazyListState()
        val runningRows =
            remember(content, activity, activeMessage) {
                if (activity == R.string.conversation_processing)
                    setOf(content.lastOrNull { it.message.id == activeMessage }?.key ?: TimelineEnd)
                else emptySet()
            }
        val runningFrame = rememberRunningWaveFrame(position, runningRows)
        val scope = rememberCoroutineScope()
        var restored by remember { mutableStateOf(false) }
        var restoredAnchor by remember { mutableStateOf<ConversationAnchor?>(null) }
        var positioned by remember { mutableStateOf(false) }
        var newReply by remember { mutableStateOf(false) }
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
        val messages = content.asReversed()
        // Measure the tail and the nearest four rows. Older rows each reserve a 20dp gap.
        val recentKeys = remember(content) { listOf(TimelineEnd) + messages.take(4).map { it.key } }
        val recentSizes = remember(position) { mutableStateMapOf<String, Int>() }
        val pastJumpThreshold by
            remember(position, jumpDistance, recentKeys) {
                derivedStateOf { position.pastEnd(jumpDistance, recentKeys, recentSizes) }
            }
        SideEffect { recentSizes.keys.retainAll(recentKeys.toSet()) }
        LaunchedEffect(model, threadId) {
            restoredAnchor = model.restoreReadingAnchor(threadId)
            restored = true
        }
        LaunchedEffect(restored, positioned, messages, state.phase, list.offline) {
            if (!restored || positioned || (!hasContent && !missing)) return@LaunchedEffect
            val anchor = restoredAnchor
            val index = messages.indexOfFirst { it.includes(anchor?.eventId) }
            // A cached checkpoint can be older than the saved anchor. Give catch-up a chance first.
            if (anchor != null && index < 0 && state.phase == HistoryPhase.Loading && !list.offline)
                return@LaunchedEffect
            if (index >= 0 && anchor != null) {
                position.scrollToItem(index + 1, with(density) { anchor.offsetDp.dp.roundToPx() })
                newReply = position.canScrollBackward
            } else {
                position.scrollToItem(0)
            }
            positioned = true
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
            state.confirmation.takeIf { positioned && atEnd && latestDisplayed && !list.offline }
        LaunchedEffect(visit, displayedConfirmation) {
            displayedConfirmation?.let { visit?.confirmDisplayed(it) }
        }
        SideEffect {
            if (positioned) {
                if (atEnd) newReply = false
                else if (lastReply != null && newestReply != null && newestReply != lastReply)
                    newReply = true
                lastReply = newestReply
            }
        }
        LaunchedEffect(model, thread?.id, position, positioned, visible, density) {
            if (!positioned || !visible || thread == null) return@LaunchedEffect
            snapshotFlow {
                    if (position.isScrollInProgress) null
                    else {
                        val first =
                            position.layoutInfo.visibleItemsInfo.firstOrNull {
                                it.index == position.firstVisibleItemIndex
                            }
                        if (!position.canScrollBackward) ReadingPosition(null)
                        else if (first?.key is String && first.key !in TimelineFixedKeys)
                            ReadingPosition(
                                ConversationAnchor(
                                    first.key as String,
                                    with(density) {
                                        position.firstVisibleItemScrollOffset.toDp().value
                                    },
                                )
                            )
                        else null
                    }
                }
                .filterNotNull()
                .collect { model.rememberReadingAnchor(threadId, it.anchor) }
        }
        val jump =
            when {
                !positioned || atEnd || !position.canScrollBackward -> null
                newReply -> R.string.conversation_new_reply
                !pastJumpThreshold -> null
                activity != null -> R.string.conversation_view_progress
                else -> R.string.conversation_jump_latest
            }
        Box(modifier.fillMaxSize()) {
            LazyColumn(
                Modifier.fillMaxSize().testTag("conversation"),
                state = position,
                reverseLayout = true,
                contentPadding =
                    PaddingValues(start = messageInset, end = messageInset, top = 24.dp),
                verticalArrangement = Arrangement.spacedBy(0.dp, Alignment.Top),
            ) {
                // A stable last item anchors the viewport even when a stream grows or the IME
                // resizes it.
                item(key = TimelineEnd) {
                    Column(
                        Modifier.fillMaxWidth()
                            .onSizeChanged { recentSizes[TimelineEnd] = it.height }
                            .padding(bottom = TimelineEndPadding)
                    ) {
                        if (activity != null && activeMessage == null && messages.isNotEmpty()) {
                            Spacer(Modifier.height(20.dp))
                            ConversationReplyHeader()
                            ConversationActivity(activity, runningFrame = runningFrame)
                        }
                        if (feedback != null || controls?.hasFeedback == true)
                            Column(
                                Modifier.padding(top = 8.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                feedback?.invoke()
                                if (controls?.hasFeedback == true) RunControlsFeedback(controls)
                            }
                    }
                }
                itemsIndexed(messages, key = { _, entry -> entry.key }) { index, entry ->
                    val trackSize =
                        if (index < 4) Modifier.onSizeChanged { recentSizes[entry.key] = it.height }
                        else Modifier
                    Column(trackSize.padding(bottom = if (index == 0) 0.dp else 20.dp)) {
                        ConversationMessageRow(
                            entry,
                            activity = activity.takeIf { entry.message.id == activeMessage },
                            revoke = controls?.revoke(entry.message.id),
                            runningFrame = runningFrame,
                        )
                        if (
                            activity != null &&
                                entry.message.id == activeMessage &&
                                entry.message.role != HistoryRole.Assistant
                        ) {
                            Spacer(Modifier.height(20.dp))
                            ConversationReplyHeader()
                            ConversationActivity(activity, runningFrame = runningFrame)
                        }
                        if (entry.message.status == "run.failed") recovery(entry.message.id)
                    }
                }
                if (messages.isEmpty()) {
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
        }
    }
}

private val TimelineFixedKeys = setOf(TimelineEnd, TimelineInitial)

private data class ReadingPosition(val anchor: ConversationAnchor?)

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
            Modifier.padding(horizontal = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(painterResource(R.drawable.ic_arrow_downward), null, Modifier.size(20.dp))
            if (labelId != R.string.conversation_jump_latest)
                Text(label, style = MaterialTheme.typography.bodySmall)
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
