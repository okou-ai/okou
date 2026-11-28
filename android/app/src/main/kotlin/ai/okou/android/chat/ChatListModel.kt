package ai.okou.android.chat

import ai.okou.android.FeedbackReceipt
import ai.okou.android.R
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.continuousRetryDelays
import ai.okou.android.api.generated.CanonicalOptional
import ai.okou.android.api.generated.ChatEventsEventsItemVariant1
import ai.okou.android.api.generated.Indicators
import ai.okou.android.api.generated.IndicatorsThreadsValue
import ai.okou.android.api.generated.SetThreadModelRequest
import ai.okou.android.api.generated.SetThreadModelRequestCodexServiceTier
import ai.okou.android.api.generated.SetThreadModelRequestReasoningEffort
import ai.okou.android.api.generated.ThreadDetail
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.contentReadStaleDelayMillis
import ai.okou.android.nextPaneFeedbackOrder
import ai.okou.android.settings.ModelEffort
import ai.okou.android.settings.isAutoDefaultModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.yield

private const val listRetryProgressThreshold = 3
private const val unreadSnapshotRenewalMillis = 30_000L

internal fun chatSyncNoticeDelayMillis(confirmedAt: Long, now: Long): Long =
    contentReadStaleDelayMillis(confirmedAt.coerceAtMost(now), now)

enum class ChatReadPhase {
    Idle,
    Loading,
    Ready,
    Failed,
}

enum class ChatListReadFailure {
    Retrying,
    NeedsRetry,
}

enum class ChatListFilter {
    Inbox,
    Unread,
    Archived,
    Muted,
}

enum class ChatListSource {
    Cache,
    Network,
}

data class ChatMarkAllReadResult(
    val confirmed: Int,
    val requested: Int,
) {
    internal val feedbackOrder = nextPaneFeedbackOrder()
    internal val hasFailures: Boolean
        get() = confirmed < requested
}

class ChatReadIntent
internal constructor(
    internal val action: ChatRowAction,
    internal val through: String?,
    internal val undoRequest: ChatRowUndo? = null,
) {
    // Indicators use the server's fixed-width UTC ISO timestamps.
    // A locally marked unread row can still lack a server watermark on the next action.
    internal fun isUnread(serverUnreadAt: String?): Boolean =
        action == ChatRowAction.MarkUnread ||
            (through != null && serverUnreadAt != null && serverUnreadAt > through)
}

enum class ChatRowAction(
    internal val updatesChat: Boolean = true,
    internal val updatesIndicators: Boolean = true,
    internal val changesPinOrder: Boolean = false,
) {
    MarkRead(updatesChat = false),
    MarkUnread(updatesChat = false),
    Mute,
    Unmute,
    Archive,
    Unarchive,
    Delete,
    Rename(updatesIndicators = false),
    MoveProject(updatesIndicators = false),
    Pin(updatesIndicators = false, changesPinOrder = true),
    Unpin(updatesIndicators = false, changesPinOrder = true),
    MovePinUp(updatesIndicators = false, changesPinOrder = true),
    MovePinDown(updatesIndicators = false, changesPinOrder = true),
}

internal data class ChatProjectDestination(val id: String?, val name: String?)

@ConsistentCopyVisibility
data class ChatMoveNotice
internal constructor(
    val eventId: String,
    val threadId: String,
    val projectId: String?,
    val projectName: String?,
) {
    internal fun resolve(state: ChatListUiState): ChatMoveNotice? {
        if (
            state.projectList.deletingId != null ||
                !matchesMembership(state.confirmedThreads) ||
                (state.confirmedThreads !== state.threads && !matchesMembership(state.threads))
        )
            return null
        val name = projectId?.let { id ->
            state.projects.firstOrNull { it.id == id }?.name ?: return null
        }
        return if (projectName == name) this else copy(projectName = name)
    }

    private fun matchesMembership(threads: List<ConfirmedChat>): Boolean = threads.any {
        it.id == threadId && it.hidden != true && it.projectId == projectId
    }
}

class ChatRowActionFailure
internal constructor(
    val action: ChatRowAction,
    internal val rejected: Boolean = false,
    internal val edits: List<ChatRowEdit> = emptyList(),
    internal val connectionFailed: Boolean = false,
    internal val conversationId: String? = null,
    internal val feedbackWorkflowId: String? = null,
    internal val renameThreadId: String? = null,
    internal val fromUndo: Boolean = false,
) {
    internal val feedbackOrder = nextPaneFeedbackOrder()
    internal val feedbackConversationId: String?
        get() = conversationId.takeUnless { action == ChatRowAction.Delete }
}

@ConsistentCopyVisibility
data class RenameSubmission internal constructor(val eventId: String, val name: String)

internal enum class ChatUndoPhase {
    Offered,
    Applying,
}

@ConsistentCopyVisibility
data class ChatRowUndo
internal constructor(
    val threadId: String,
    val action: ChatRowAction,
    internal val sequence: Long,
    internal val phase: ChatUndoPhase = ChatUndoPhase.Offered,
    internal val fromConversation: Boolean = false,
) {
    internal val inverse: ChatRowAction
        get() =
            when (action) {
                ChatRowAction.Archive -> ChatRowAction.Unarchive
                ChatRowAction.Unarchive -> ChatRowAction.Archive
                ChatRowAction.MarkRead -> ChatRowAction.MarkUnread
                else -> error("Chat action cannot be undone")
            }
}

data class ChatListUiState(
    val threads: List<ConfirmedChat> = emptyList(),
    val listPhase: ChatReadPhase = ChatReadPhase.Idle,
    val listReadFailure: ChatListReadFailure? = null,
    internal val listReadStartedAt: Long? = null,
    val listRetryProgressVisible: Boolean = false,
    internal val listRefreshFailureOrder: Long? = null,
    val confirmedAt: Long? = null,
    val source: ChatListSource? = null,
    val cacheUnavailable: Boolean = false,
    val projectList: ProjectListUiState = ProjectListUiState(),
    internal val chatMoveNotice: ChatMoveNotice? = null,
    val indicators: Indicators? = null,
    internal val draftThreadIds: Set<String>? = null,
    val indicatorsPhase: ChatReadPhase = ChatReadPhase.Idle,
    internal val indicatorsNonRetryableFailure: Boolean = false,
    internal val indicatorsConfirmedAt: Long? = null,
    internal val indicatorsReadStartedAt: Long? = null,
    internal val indicatorsRetryProgressVisible: Boolean = false,
    internal val indicatorsRefreshFailureOrder: Long? = null,
    val filter: ChatListFilter = ChatListFilter.Inbox,
    val pendingRowActions: Map<String, ChatRowAction> = emptyMap(),
    internal val rowActionFailures: List<ChatRowActionFailure> = emptyList(),
    internal val unconfirmedRenames: Map<String, RenameSubmission> = emptyMap(),
    internal val confirmedRenameIds: Map<String, String> = emptyMap(),
    internal val conversationModelEdits: Map<String, ConversationModelEdits> = emptyMap(),
    val rowUndo: ChatRowUndo? = null,
    internal val conversationUndo: ChatRowUndo? = null,
    val markingAllRead: Boolean = false,
    internal val markAllReadResults: List<ChatMarkAllReadResult> = emptyList(),
    internal val cachedUnread: CachedUnread? = null,
    internal val readIntents: Map<String, ChatReadIntent> = emptyMap(),
    internal val confirmedThreads: List<ConfirmedChat> = emptyList(),
    internal val threadsByRecency: List<ConfirmedChat> = emptyList(),
    internal val acceptedNewChats: List<ProvisionalChat> = emptyList(),
) {
    val projects: List<ConfirmedProject>
        get() = projectList.rows

    val projectsPhase: ChatReadPhase
        get() = projectList.phase

    val projectsSource: ChatListSource?
        get() = projectList.source

    val projectCacheUnavailable: Boolean
        get() = projectList.cacheUnavailable

    val renamingProjectId: String?
        get() = projectList.renamingId

    val unconfirmedProjectRenames: Set<String>
        get() = projectList.unconfirmedRenames

    internal val projectRenameRejection: ProjectRenameRejection?
        get() = projectList.renameRejection

    // The Project feed and both views of chat membership must have caught up to the deletion.
    internal val projectDeleteFeedback: List<ProjectDeleteFeedback>
        get() =
            projectList.deleteFeedback.filterNot { feedback ->
                feedback.status == ProjectDeleteStatus.Confirmed &&
                    (projectsSource != ChatListSource.Network ||
                        projects.any { it.id == feedback.projectId } ||
                        source != ChatListSource.Network ||
                        confirmedThreads.any { it.projectId == feedback.projectId } ||
                        (confirmedThreads !== threads &&
                            threads.any { it.projectId == feedback.projectId }))
            }
}

private fun ChatListUiState.withRowFailure(failure: ChatRowActionFailure): ChatListUiState =
    copy(
        rowActionFailures =
            rowActionFailures.filterNot {
                !it.rejected &&
                    it.feedbackConversationId == failure.feedbackConversationId &&
                    it.feedbackWorkflowId == failure.feedbackWorkflowId
            } + failure,
    )

private fun ChatListUiState.activeUndo(fromConversation: Boolean): ChatRowUndo? =
    if (fromConversation) conversationUndo else rowUndo

private fun ChatListUiState.withUndo(
    fromConversation: Boolean,
    undo: ChatRowUndo?,
): ChatListUiState = if (fromConversation) copy(conversationUndo = undo) else copy(rowUndo = undo)

private fun ChatListUiState.discardReadIntent(
    threadId: String,
    intent: ChatReadIntent,
    previous: ChatReadIntent?,
): ChatListUiState {
    if (readIntents[threadId] !== intent) return this
    return copy(
        readIntents =
            if (previous == null) readIntents - threadId else readIntents + (threadId to previous),
    )
}

internal val ChatListUiState.canRenameProject: Boolean
    get() = projectList.canRename

internal val ChatListUiState.canDeleteProject: Boolean
    get() =
        projectList.canRename && pendingRowActions.values.none { it == ChatRowAction.MoveProject }

internal fun ChatListUiState.projectDestinations(
    thread: ConfirmedChat,
): List<ChatProjectDestination> = buildList {
    if (thread.projectId != null) add(ChatProjectDestination(null, null))
    projects.forEach { project ->
        if (project.id != thread.projectId && !projectList.isDeleting(project.id)) {
            add(ChatProjectDestination(project.id, project.name))
        }
    }
}

internal val ChatListUiState.displayUnreadAt: Map<String, String>?
    get() = indicators?.unreadAt ?: cachedUnread?.unreadAt

private val ChatListUiState.unreadConfirmedAt: Long?
    get() = indicatorsConfirmedAt ?: cachedUnread?.confirmedAt

private fun cacheWasStaleAtReadStart(confirmedAt: Long?, startedAt: Long?): Boolean =
    confirmedAt != null &&
        startedAt != null &&
        chatSyncNoticeDelayMillis(confirmedAt, startedAt) == 0L

private val ChatListUiState.listReadStartedStale: Boolean
    get() = cacheWasStaleAtReadStart(confirmedAt, listReadStartedAt)

internal val ChatListUiState.listRefreshProgressVisible: Boolean
    get() = listReadStartedStale || listRetryProgressVisible

internal val ChatListUiState.indicatorsRefreshProgressVisible: Boolean
    get() =
        cacheWasStaleAtReadStart(unreadConfirmedAt, indicatorsReadStartedAt) ||
            indicatorsRetryProgressVisible

internal val ChatListUiState.waitingForUnreadIndicators: Boolean
    get() =
        filter == ChatListFilter.Unread &&
            displayUnreadAt == null &&
            (readIntents.isEmpty() ||
                threads.none { it.hidden != true && it.muted != true && isUnread(it.id) })

internal val ChatListUiState.hasUsableList: Boolean
    get() = confirmedAt != null && !waitingForUnreadIndicators

internal fun ChatListUiState.needsProjectsToConfirmEmptyInbox(
    provisionalChats: List<ProvisionalChat>,
): Boolean =
    filter == ChatListFilter.Inbox &&
        projectsSource == null &&
        projects.isEmpty() &&
        threads.none { !it.archived && it.hidden != true } &&
        provisionalChats.none { provisional -> threads.none { it.id == provisional.threadId } }

private fun ChatListUiState.clearRefreshFailures() =
    copy(
        listRefreshFailureOrder = null,
        indicatorsRefreshFailureOrder = null,
        projectList = projectList.copy(refreshFailureOrder = null),
    )

internal fun ChatListUiState.isUnread(threadId: String): Boolean {
    val serverUnreadAt = displayUnreadAt?.get(threadId)
    return readIntents[threadId]?.isUnread(serverUnreadAt) ?: (serverUnreadAt != null)
}

internal fun ChatListUiState.unreadChatIds(): Set<String> {
    val serverUnread = displayUnreadAt.orEmpty().keys
    if (readIntents.isEmpty()) return serverUnread
    return serverUnread.toMutableSet().apply {
        for (id in readIntents.keys) {
            if (isUnread(id)) add(id) else remove(id)
        }
    }
}

internal fun ChatListUiState.rowActions(
    thread: ConfirmedChat,
    group: ChatListGroup? = null,
    index: Int = -1,
): List<ChatRowAction> = buildList {
    if (source != null && pendingRowActions.values.none { it.changesPinOrder }) {
        val pinned = thread.pinnedAt != null
        if (pinned) add(ChatRowAction.Unpin)
        // A refresh retains the last synchronized rank scope while it fetches the next one.
        if (
            group != null &&
                source == ChatListSource.Network &&
                listPhase != ChatReadPhase.Failed &&
                listReadFailure == null &&
                projectsSource != null &&
                (group.projectId == null || group.project != null)
        ) {
            if (!pinned) add(ChatRowAction.Pin)
            else {
                if (group.pinNeighbor(index, -1) != null) add(ChatRowAction.MovePinUp)
                if (group.pinNeighbor(index, 1) != null) add(ChatRowAction.MovePinDown)
            }
        }
    }
    if (displayUnreadAt != null && thread.muted != true) {
        add(if (isUnread(thread.id)) ChatRowAction.MarkRead else ChatRowAction.MarkUnread)
    }
    if (source != null) {
        add(ChatRowAction.Rename)
        if (
            projectsSource != null &&
                projectList.deletingId == null &&
                (thread.projectId != null || projects.any { !projectList.isDeleting(it.id) })
        )
            add(ChatRowAction.MoveProject)
        add(if (thread.muted == true) ChatRowAction.Unmute else ChatRowAction.Mute)
        add(if (thread.archived) ChatRowAction.Unarchive else ChatRowAction.Archive)
        add(ChatRowAction.Delete)
    }
}

internal fun ChatListUiState.markAllReadTargets(): Map<String, String> {
    val unreadAt = indicators?.unreadAt ?: return emptyMap()
    if (markingAllRead || unreadAt.isEmpty()) {
        return emptyMap()
    }
    // The Unread view includes every matching chat before collapse or viewport filtering.
    val targets = buildMap {
        for (group in chatListGroups(this@markAllReadTargets, ChatListFilter.Unread)) {
            for (thread in group.threads) {
                unreadAt[thread.id]?.let { put(thread.id, it) }
            }
        }
    }
    return if (targets.keys.any { it in pendingRowActions }) emptyMap() else targets
}

/** Workspace-retained HTTP observations; no row collector owns synchronization or durable state. */
class ChatListModel(
    private val service: ChatListService,
    cacheStore: ChatCacheStore,
    private val identity: WorkspaceIdentity,
    private val authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
    realtime: RealtimeService? = null,
    private val monotonicMillis: () -> Long = { System.nanoTime() / 1_000_000 },
    private val wallMillis: () -> Long = System::currentTimeMillis,
    initialFilter: ChatListFilter = ChatListFilter.Inbox,
    private val remoteAccessVerified: () -> Boolean = { true },
    initiallyInForeground: Boolean = true,
) : ViewModel() {
    private val mutable = MutableStateFlow(ChatListUiState(filter = initialFilter))
    val uiState = mutable.asStateFlow()
    @Volatile private var retired = false
    internal val cache = cacheStore.open(identity) { current() }
    private val artifactChanges = MutableSharedFlow<ChatChanges>()
    internal val artifactCatalogChanges = artifactChanges.asSharedFlow()
    private val readWrites = mutableMapOf<String, Job>()
    val history =
        ConversationHistoryModel(
            service,
            cache,
            viewModelScope,
            { current() },
            onFailure,
            { invalidateIndicators() },
            dispatcher,
            precedingReadWrite = { readWrites[it] },
            wallMillis = wallMillis,
            markRead = ::markReadWithReceipt,
        )
    private val sync = ChatListSync(service, dispatcher)
    private var confirmed: CachedChats? = null
    private val projection = ChatListProjection()
    private val pendingRenameIds = mutableMapOf<String, String>()
    private val rowMutations =
        ChatRowMutationOwner(
            service,
            projection,
            dispatcher,
            wallMillis,
            requireCurrent = ::requireCurrent,
            onFailure = onFailure,
            publishRows = { publishRows() },
            awaitListRead = ::awaitListRead,
        )
    private val projectOwner =
        ProjectListOwner(
            service,
            cache,
            viewModelScope,
            current = ::current,
            onFailure = onFailure,
            dispatcher = dispatcher,
            wallMillis = wallMillis,
            syncChatsAfterDelete = { awaitListRead { true } },
            isListPaneOpen = { listFeedbackScope != null },
            visibleListFeedbackScope = { visibleListFeedbackScope },
            readState = { mutable.value.projectList },
            publish = { reconcileProjectMoves(mutable.value.copy(projectList = it)) },
        )
    private var cacheRead = false
    private var restoreJob: Job? = null
    private var indicatorsJob: Job? = null
    private var draftIndexRead: DraftIndexRead? = null
    internal var draftIndexRequestVersion = 0L
        private set

    private var confirmedDraftIndexVersion = 0L
    private var indicatorsRetry: ChatDependencyRetry? = null
    private var indicatorFailures = 0
    private var indicatorRetryAt: Long? = null
    private val indicatorReadReceipts = mutableMapOf<String, ChatTimestamp>()
    private val readConfirmations = mutableMapOf<String, ReadConfirmation>()
    private var batchReadIntents: Map<String, ChatReadIntent>? = null
    private val writes = Mutex()

    private class DraftIndexRead {
        val presenceOverrides = mutableMapOf<String, Boolean>()
    }

    private class ListReadBatch {
        var refresh = false
        var userRequested = false
        val discardOnSuccess = mutableSetOf<String>()
        val confirmations = mutableListOf<ListConfirmation>()
    }

    private class ListConfirmation(
        val needsRead: () -> Boolean,
        val done: CompletableDeferred<Boolean>,
    )

    private enum class ReadWriteOrigin {
        Row,
        Batch,
    }

    private class ReadConfirmation(
        val intent: ChatReadIntent,
        val receiptCoversIntent: Boolean,
        val retainUntilConfirmed: Boolean,
        val projectedIntent: ChatReadIntent? = null,
        val rejected: Boolean = false,
        val connectionFailed: Boolean = false,
        val alreadySatisfied: Boolean = false,
        var unconfirmedInverse: ChatReadIntent? = null,
    ) {
        var confirmedByReadback = false

        val confirmed: Boolean
            get() = receiptCoversIntent || confirmedByReadback
    }

    private class PreparedListRebase(
        val baseline: ChatCheckpoint,
        val result: ChatListSync.Result,
        val projection: ReplayedChats,
    )

    private var pendingListRead: ListReadBatch? = null
    private val rowDiscardsAfterRead = mutableSetOf<String>()
    private val acceptedChatsToVerify = mutableSetOf<String>()
    private val verifyingAcceptedChats = mutableSetOf<String>()
    internal var onAcceptedChatMissing: ((String) -> Unit)? = null
    // Reconciliation survives transport backoff and lasts until a read publishes successfully.
    private var completedActivityReconciliation: Any? = null
    private var listRetry: Job? = null
    private var listRetryAt: Long? = null
    private var listFailures = 0
    private var listIsVisible = true
    private var listInForeground = initiallyInForeground
    private var listReadScope = Any()
    private val needsListRead: Boolean
        get() = listIsVisible && listInForeground

    // A conversation can keep list reads active after the list pane leaves the screen.
    private var listFeedbackScope: Any? = Any()
    private val visibleListFeedbackScope: Any?
        get() = listFeedbackScope.takeIf { needsListRead }

    private var listRefreshJob: Job? = null
    private var listRebaseJob: Job? = null
    private var readyListRebase: PreparedListRebase? = null
    private val listReadRequests = Channel<Unit>(Channel.CONFLATED)
    private val indicatorInvalidations = Channel<Unit>(Channel.CONFLATED)
    private val unreadCacheWrites = Channel<CachedUnread>(Channel.CONFLATED)
    private val chatConfirmationWrites = Channel<CachedChats>(Channel.CONFLATED)
    private var indicatorsInvalidated = false
    private var immediateIndicators = false
    private var readCursorChanged = false
    private var indicatorsStartedAt: Long? = null
    val warming =
        ChatHistoryWarming(
            service,
            cache,
            viewModelScope,
            { current() },
            candidates = {
                val state = mutable.first { it.source != null && it.indicators != null }
                withContext(dispatcher) {
                    (state.threads
                            .filter { it.hidden != true }
                            .sortedWith(
                                compareByDescending<ConfirmedChat> { it.sortAt }
                                    .thenByDescending { it.id },
                            )
                            .take(100)
                            .map { it.id } + checkNotNull(state.indicators).threads.keys)
                        .distinct()
                }
            },
            selected = { history.uiState.value.thread?.id },
            onFailure,
            dispatcher,
            monotonicMillis,
            onUnavailable = history::forgetWarmedHistory,
        )
    val updates =
        ChatUpdatesModel(
            realtime,
            viewModelScope,
            { current() },
            onFailure,
            history.output,
            foregroundChanged = warming::foreground,
        ) { changes ->
            if (current()) {
                if (changes.resync || changes.list) {
                    refreshList()
                    projectOwner.invalidate()
                }
                if (changes.resync || changes.indicators || changes.readCursor)
                    requestIndicators(
                        immediate = changes.resync || changes.readCursor,
                        verifyReadCursors = changes.resync || changes.readCursor,
                    )
                if (changes.resync) {
                    history.invalidate()
                    history.invalidateDetail()
                } else {
                    changes.messageThreads.forEach { history.invalidate(it) }
                    changes.detailThreads.forEach { history.invalidateDetail(it) }
                }
                if (changes.resync || changes.messageThreads.isNotEmpty()) warming.invalidate()
                if (
                    changes.resync ||
                        changes.list ||
                        changes.messageThreads.isNotEmpty() ||
                        changes.artifactThreads.isNotEmpty()
                ) {
                    viewModelScope.launch { artifactChanges.emit(changes) }
                }
            }
        }

    init {
        viewModelScope.launch { for (ignored in listReadRequests) readPendingListBatch() }
        viewModelScope.launch {
            for (saved in chatConfirmationWrites) cache.renewChatConfirmation(saved)
        }
        viewModelScope.launch {
            var saved: CachedUnread? = null
            for (snapshot in unreadCacheWrites) {
                if (
                    saved != null &&
                        saved.unreadAt == snapshot.unreadAt &&
                        snapshot.confirmedAt - saved.confirmedAt in
                            0 until unreadSnapshotRenewalMillis
                )
                    continue
                if (cache.saveUnread(snapshot)) saved = snapshot
            }
        }
        viewModelScope.launch {
            for (ignored in indicatorInvalidations) {
                awaitIndicatorRead()
                if (!indicatorsInvalidated) continue
                val remaining =
                    indicatorsStartedAt?.let { (it + 1_000 - monotonicMillis()).coerceAtLeast(0) }
                        ?: 0
                if (!immediateIndicators && remaining > 0)
                    withTimeoutOrNull(remaining) {
                        // New status demand does not postpone the deadline. A read-cursor signal
                        // wakes it immediately and cannot be downgraded by later status demand.
                        while (needsListRead && !immediateIndicators) indicatorInvalidations
                            .receive()
                    }
                // A refresh may have covered this demand while the worker was throttled.
                awaitIndicatorRead()
                if (indicatorsInvalidated && needsListRead && current()) {
                    readIndicators()
                    indicatorsJob?.join()
                }
            }
        }
    }

    /** The commit identifies when a newer checkpoint already on disk needs to be loaded. */
    private suspend fun persistChats(saved: CachedChats): CachedChats = writes.withLock {
        requireCurrent()
        try {
            val written = cache.save(saved.checkpoint, saved.confirmedAt)
            val disk = if (!written) cache.load() else null
            requireCurrent()
            mutable.value = mutable.value.copy(cacheUnavailable = false)
            if (disk != null && disk.checkpoint.cursor.seqId > saved.checkpoint.cursor.seqId) disk
            else saved
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            requireCurrent()
            mutable.value = mutable.value.copy(cacheUnavailable = true)
            saved
        }
    }

    private fun current() = !retired && authorized()

    private suspend fun requireCurrent() {
        currentCoroutineContext().ensureActive()
        if (!current()) throw CancellationException("Chat owner retired")
    }

    fun selectFilter(value: ChatListFilter) {
        val state = mutable.value
        if (!current() || state.filter == value) return
        mutable.value = state.clearRefreshFailures().copy(filter = value)
        if (
            value == ChatListFilter.Unread &&
                (state.indicators == null ||
                    state.indicatorsPhase == ChatReadPhase.Failed ||
                    state.indicatorsConfirmedAt?.let {
                        chatSyncNoticeDelayMillis(it, wallMillis()) == 0L
                    } == true)
        ) {
            refreshIndicators()
        }
    }

    internal fun dismissListRefreshFailure(order: Long) {
        if (!current()) return
        val state = mutable.value
        mutable.value =
            when (order) {
                state.listRefreshFailureOrder -> state.copy(listRefreshFailureOrder = null)
                state.indicatorsRefreshFailureOrder ->
                    state.copy(indicatorsRefreshFailureOrder = null)
                state.projectList.refreshFailureOrder ->
                    state.copy(projectList = state.projectList.copy(refreshFailureOrder = null))
                else -> return
            }
    }

    internal fun markAllRead() {
        if (!current()) return
        val state = mutable.value
        val targets = state.markAllReadTargets()
        if (targets.isEmpty()) return
        val intents = targets.mapValues { (_, time) ->
            ChatReadIntent(ChatRowAction.MarkRead, time)
        }

        batchReadIntents = intents
        val write = CompletableDeferred<Unit>()
        intents.keys.forEach { readWrites[it] = write }
        mutable.value =
            state.copy(
                pendingRowActions =
                    state.pendingRowActions + targets.keys.associateWith { ChatRowAction.MarkRead },
                readIntents = state.readIntents + intents,
                markingAllRead = true,
                markAllReadResults = state.markAllReadResults.filter { it.hasFailures },
            )
        viewModelScope.launch {
            var result: ChatMarkAllReadResult? = null
            try {
                val confirmations =
                    try {
                        coroutineScope {
                            intents
                                .map { (id, intent) ->
                                    async {
                                        writeReadIntent(
                                            id,
                                            intent,
                                            origin = ReadWriteOrigin.Batch,
                                            priorProjection = state.readIntents[id],
                                        )
                                    }
                                }
                                .awaitAll()
                        }
                    } finally {
                        targets.keys.forEach { readWrites.remove(it) }
                        write.complete(Unit)
                        if (current()) {
                            val state = mutable.value
                            mutable.value =
                                state.copy(
                                    pendingRowActions = state.pendingRowActions - targets.keys,
                                )
                        }
                    }
                if (confirmations.any { !it.rejected && !it.confirmed }) {
                    readIndicatorsAfterWrite { id ->
                        intents[id]?.let { readConfirmations[id]?.intent === it } == true
                    }
                } else if (confirmations.any { !it.connectionFailed }) {
                    indicatorsRetry?.stopRetrying()
                    invalidateIndicators()
                }
                requireCurrent()
                val latest = mutable.value
                val unsettled =
                    confirmations.filterNot { it.confirmed }.mapTo(hashSetOf()) { it.intent }
                val unverifiedProjections =
                    intents.keys.filter { latest.readIntents[it] in unsettled }
                if (unverifiedProjections.isNotEmpty()) {
                    // If the indicator read failed, only remove this batch's unverified display.
                    // A later indicator read still uses the original write confirmations.
                    mutable.value =
                        latest.copy(
                            readIntents = latest.readIntents - unverifiedProjections.toSet(),
                        )
                }
                result =
                    ChatMarkAllReadResult(
                        confirmations.count { it.confirmed },
                        targets.size,
                    )
            } finally {
                batchReadIntents = null
                if (current()) {
                    val state = mutable.value
                    mutable.value =
                        state.copy(
                            markingAllRead = false,
                            markAllReadResults =
                                result?.let { state.markAllReadResults + it }
                                    ?: state.markAllReadResults,
                        )
                }
            }
        }
    }

    internal fun dismissMarkAllReadResult(result: ChatMarkAllReadResult) {
        val state = mutable.value
        if (current() && state.markAllReadResults.any { it === result })
            mutable.value =
                state.copy(
                    markAllReadResults = state.markAllReadResults.filterNot { it === result },
                )
    }

    private suspend fun writeReadIntent(
        threadId: String,
        intent: ChatReadIntent,
        origin: ReadWriteOrigin,
        conversationId: String? = null,
        priorProjection: ChatReadIntent? = null,
    ): ReadConfirmation {
        val recover = origin != ReadWriteOrigin.Batch
        val reportFailure = recover && intent.undoRequest == null
        var alreadySatisfied = false
        suspend fun writeRead(): Boolean {
            requireCurrent()
            val receipt =
                if (intent.action == ChatRowAction.MarkUnread) service.markUnread(threadId)
                else service.markRead(threadId)
            return intent.matchesReadCursor(receipt.lastReadAt)
        }
        val received =
            try {
                if (recover) {
                    ChatWriteRetries().run { retrying ->
                        // The server can still show the old value while an inverse is unconfirmed.
                        if (
                            retrying &&
                                readConfirmations[threadId].unconfirmedInverseOf(intent) == null
                        ) {
                            requireCurrent()
                            alreadySatisfied =
                                readThreadForConfirmation(threadId)?.let {
                                    intent.matchesReadCursor(it.lastReadAt)
                                } == true
                        }
                        // Preflight can stop the retry. The subsequent indicator read owns the
                        // display.
                        alreadySatisfied || writeRead()
                    }
                } else {
                    writeRead()
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                requireCurrent()
                if (error !is ApiFailure.Http || error.status != 404) onFailure(error)
                requireCurrent()
                val connectionFailed = error is ApiFailure.Network && error.connectionFailed
                if (
                    connectionFailed ||
                        error is ApiFailure.Http && error.status in 400..499 && error.status != 408
                ) {
                    val state = mutable.value
                    val earlier =
                        readConfirmations[threadId]?.projectedIntent?.takeIf {
                            it === priorProjection
                        }
                    val rolledBack = state.discardReadIntent(threadId, intent, earlier)
                    mutable.value =
                        if (reportFailure)
                            rolledBack.withRowFailure(
                                ChatRowActionFailure(
                                    intent.action,
                                    rejected = true,
                                    connectionFailed = connectionFailed,
                                    conversationId = conversationId,
                                ),
                            )
                        else rolledBack
                    return ReadConfirmation(
                        intent,
                        receiptCoversIntent = false,
                        retainUntilConfirmed = recover,
                        rejected = true,
                        connectionFailed = connectionFailed,
                    )
                }
                false
            }
        requireCurrent()
        val state = mutable.value
        val publish = received && origin == ReadWriteOrigin.Batch
        // A write awaiting confirmation can leave an earlier projection visible until readback.
        val projectedIntent = if (publish) intent else state.readIntents[threadId]
        val unconfirmedInverse =
            if (recover && !received) readConfirmations[threadId].unconfirmedInverseOf(intent)
            else null
        return ReadConfirmation(
                intent,
                received,
                recover,
                projectedIntent,
                alreadySatisfied = alreadySatisfied,
                unconfirmedInverse = unconfirmedInverse,
            )
            .also {
                readConfirmations[threadId] = it
                if (publish) {
                    mutable.value =
                        state.copy(readIntents = state.readIntents + (threadId to intent))
                }
            }
    }

    private fun ReadConfirmation?.unconfirmedInverseOf(intent: ChatReadIntent): ChatReadIntent? =
        this?.takeUnless { it.receiptCoversIntent || it.intent.action == intent.action }?.intent

    private fun ChatReadIntent.matchesReadCursor(lastReadAt: String?): Boolean =
        if (action == ChatRowAction.MarkUnread) lastReadAt == null
        else lastReadAt?.let { covers(chatTimestamp(it)) } == true

    private fun ChatReadIntent.covers(watermark: ChatTimestamp): Boolean =
        through?.let { watermark >= chatTimestamp(it) } ?: true

    private suspend fun readThreadForConfirmation(threadId: String): ThreadDetail? =
        try {
            service.threadDetail(threadId).also { requireCurrent() }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            requireCurrent()
            if (error is ApiFailure.Unauthenticated || error is ApiFailure.UpdateRequired)
                onFailure(error)
            requireCurrent()
            null
        }

    private var undoSequence = 0L
    private var latestOfferedListUndo = 0L
    private var latestOfferedConversationUndo = 0L
    private var listUndoClearedThrough = 0L

    internal fun undoRowAction(undo: ChatRowUndo): Boolean {
        val state = mutable.value
        if (
            !current() ||
                state.activeUndo(undo.fromConversation) !== undo ||
                undo.phase != ChatUndoPhase.Offered ||
                undo.threadId in state.pendingRowActions
        )
            return false
        if (
            state.undoTarget(undo) == null ||
                !performRowAction(
                    undo.threadId,
                    undo.inverse,
                    value = null,
                    undoRequest = undo,
                    fromConversation = undo.fromConversation,
                )
        )
            failRowUndo(undo)
        return true
    }

    internal fun dismissRowUndo(undo: ChatRowUndo) {
        val state = mutable.value
        if (current() && state.activeUndo(undo.fromConversation)?.sequence == undo.sequence)
            mutable.value = state.withUndo(undo.fromConversation, null)
    }

    private fun failRowUndo(undo: ChatRowUndo) {
        if (!current()) return
        val state = mutable.value
        val remainingUndo =
            state.activeUndo(undo.fromConversation)?.takeUnless { it.sequence == undo.sequence }
        val failure =
            ChatRowActionFailure(
                undo.inverse,
                rejected = true,
                conversationId = undo.threadId.takeIf { undo.fromConversation },
                fromUndo = true,
            )
        mutable.value =
            state
                .withUndo(undo.fromConversation, remainingUndo)
                .copy(rowActionFailures = state.rowActionFailures + failure)
    }

    internal fun clearListRowUndo() {
        // Commands from the previous list visit may still finish.
        listUndoClearedThrough = undoSequence
        mutable.value.rowUndo?.let(::dismissRowUndo)
    }

    private fun ChatListUiState.undoTarget(undo: ChatRowUndo): ConfirmedChat? =
        threads
            .firstOrNull { it.id == undo.threadId && it.hidden != true }
            ?.takeIf { thread ->
                when (undo.action) {
                    ChatRowAction.Archive -> thread.archived
                    ChatRowAction.Unarchive -> !thread.archived
                    ChatRowAction.MarkRead -> !isUnread(thread.id) && thread.muted != true
                    else -> error("Chat action cannot be undone")
                }
            }

    private fun ChatListUiState.hasConfirmedUnread(threadId: String): Boolean =
        displayUnreadAt?.containsKey(threadId) == true &&
            isUnread(threadId) &&
            threads.any { it.id == threadId && it.hidden != true && it.muted != true }

    private inline fun ChatListUiState.pruneInvalidUndo(
        shouldValidate: (ChatRowUndo) -> Boolean,
    ): ChatListUiState {
        val list = rowUndo?.takeUnless {
            it.phase == ChatUndoPhase.Offered && shouldValidate(it) && undoTarget(it) == null
        }
        val conversation = conversationUndo?.takeUnless {
            it.phase == ChatUndoPhase.Offered && shouldValidate(it) && undoTarget(it) == null
        }
        return if (list === rowUndo && conversation === conversationUndo) this
        else copy(rowUndo = list, conversationUndo = conversation)
    }

    private fun recordConfirmedUndo(threadId: String, candidate: ChatRowUndo?) {
        if (!current()) return
        val previous = mutable.value
        val state = previous.pruneInvalidUndo { it.threadId == threadId }
        val latestOfferedUndo =
            if (candidate?.fromConversation == true) latestOfferedConversationUndo
            else latestOfferedListUndo
        if (
            candidate != null &&
                candidate.sequence > latestOfferedUndo &&
                (candidate.fromConversation || candidate.sequence > listUndoClearedThrough) &&
                state.undoTarget(candidate) != null
        ) {
            if (candidate.fromConversation) latestOfferedConversationUndo = candidate.sequence
            else latestOfferedListUndo = candidate.sequence
            mutable.value = state.withUndo(candidate.fromConversation, candidate)
        } else if (state !== previous) mutable.value = state
    }

    internal fun performRowAction(
        threadId: String,
        action: ChatRowAction,
        fromConversation: Boolean = false,
        feedbackWorkflowId: String? = null,
    ): Boolean =
        action != ChatRowAction.MoveProject &&
            performRowAction(
                threadId,
                action,
                value = null,
                fromConversation = fromConversation,
                feedbackWorkflowId = feedbackWorkflowId,
            )

    internal fun renameThread(
        threadId: String,
        title: String,
        fromConversation: Boolean = false,
    ): RenameSubmission? {
        val submission = RenameSubmission(UUID.randomUUID().toString(), title.trim())
        return submission.takeIf {
            performRowAction(
                threadId,
                ChatRowAction.Rename,
                it.name,
                fromConversation = fromConversation,
                renameEventId = it.eventId,
            )
        }
    }

    internal fun moveThreadToProject(
        threadId: String,
        projectId: String?,
        fromConversation: Boolean = false,
    ): Boolean =
        performRowAction(
            threadId,
            ChatRowAction.MoveProject,
            projectId,
            fromConversation = fromConversation,
        )

    private fun performRowAction(
        threadId: String,
        action: ChatRowAction,
        value: String?,
        undoRequest: ChatRowUndo? = null,
        fromConversation: Boolean = false,
        feedbackWorkflowId: String? = null,
        renameEventId: String? = null,
    ): Boolean {
        if (!current()) return false
        val state = mutable.value
        val thread =
            state.threads.firstOrNull { it.id == threadId && it.hidden != true } ?: return false
        if (threadId in state.pendingRowActions) return false
        if (
            action == ChatRowAction.Rename &&
                (value.isNullOrBlank() ||
                    value == thread.title?.trim() ||
                    threadId in state.unconfirmedRenames)
        )
            return false
        val movingProject = action == ChatRowAction.MoveProject
        val pinGroup =
            if (action.changesPinOrder) chatListGroups(state).firstOrNull { thread in it.threads }
            else null
        val index = pinGroup?.threads?.indexOf(thread) ?: -1
        if (action !in state.rowActions(thread, pinGroup, index)) return false
        if (movingProject && state.projectDestinations(thread).none { it.id == value }) return false
        val conversationId = threadId.takeIf { fromConversation }
        val archiveAction = action == ChatRowAction.Archive || action == ChatRowAction.Unarchive
        val undo =
            if (
                undoRequest == null &&
                    (archiveAction ||
                        action == ChatRowAction.MarkRead && state.filter == ChatListFilter.Unread)
            )
                ChatRowUndo(threadId, action, ++undoSequence, fromConversation = fromConversation)
            else null
        val readSession =
            if (action == ChatRowAction.MarkUnread) history.readSessionFor(threadId) else null
        val acknowledgement = readSession?.pendingAutomaticRead
        val intent =
            if (!action.updatesChat) {
                ChatReadIntent(action, state.displayUnreadAt?.get(threadId), undoRequest)
            } else null
        val priorReadProjection = state.readIntents[threadId]
        val write =
            if (!action.updatesChat || action == ChatRowAction.Unmute) {
                CompletableDeferred<Unit>().also { readWrites[threadId] = it }
            } else null
        val pending =
            state.copy(
                pendingRowActions = state.pendingRowActions + (threadId to action),
                rowActionFailures =
                    if (action == ChatRowAction.Rename)
                        state.rowActionFailures.filterNot { it.renameThreadId == threadId }
                    else state.rowActionFailures,
                projectList =
                    if (movingProject)
                        state.projectList.copy(
                            deleteFeedback =
                                state.projectList.deleteFeedback.filterNot {
                                    it.status == ProjectDeleteStatus.Confirmed &&
                                        state.projects.none { project ->
                                            project.id == it.projectId
                                        }
                                },
                        )
                    else state.projectList,
                readIntents =
                    if (intent == null) state.readIntents
                    else state.readIntents + (threadId to intent),
            )
        if (renameEventId != null) pendingRenameIds[threadId] = renameEventId
        mutable.value =
            if (undoRequest == null) pending
            else
                pending.withUndo(fromConversation, undoRequest.copy(phase = ChatUndoPhase.Applying))
        viewModelScope.launch {
            try {
                val edits =
                    try {
                        if (action.updatesChat)
                            rowMutations.prepareEdits(
                                threadId,
                                action,
                                value,
                                pinGroup,
                                index,
                                state,
                                renameEventId,
                            )
                        else emptyList()
                    } catch (_: IllegalArgumentException) {
                        requireCurrent()
                        mutable.value =
                            mutable.value.withRowFailure(
                                ChatRowActionFailure(
                                    action,
                                    rejected = true,
                                    conversationId = conversationId,
                                    feedbackWorkflowId = feedbackWorkflowId,
                                    renameThreadId =
                                        threadId.takeIf { action == ChatRowAction.Rename },
                                ),
                            )
                        return@launch
                    }
                val confirmation: ReadConfirmation?
                val submission: ChatRowMutationOwner.Submission?
                try {
                    acknowledgement?.join()
                    requireCurrent()
                    if (undoRequest != null) {
                        val latest = mutable.value
                        // Validate against the latest state without this attempt's own projection.
                        val earlier =
                            readConfirmations[threadId]?.projectedIntent?.takeIf {
                                it === priorReadProjection
                            }
                        val beforeInverse =
                            if (intent == null) latest
                            else latest.discardReadIntent(threadId, intent, earlier)
                        if (beforeInverse.undoTarget(undoRequest) == null) {
                            if (beforeInverse !== latest) mutable.value = beforeInverse
                            if (intent != null && beforeInverse.hasConfirmedUnread(threadId)) {
                                dismissRowUndo(undoRequest)
                            } else failRowUndo(undoRequest)
                            return@launch
                        }
                    }
                    // New acknowledgements wait behind this write. Stop the original visit only
                    // once the inverse is going to be sent.
                    readSession?.stopAutomaticRead()
                    if (intent != null) {
                        confirmation =
                            writeReadIntent(
                                threadId,
                                intent,
                                origin = ReadWriteOrigin.Row,
                                conversationId = conversationId,
                                priorProjection = priorReadProjection,
                            )
                        submission = null
                    } else {
                        confirmation = null
                        submission =
                            rowMutations.submit(
                                action,
                                edits,
                                optimistic = action != ChatRowAction.Rename,
                            ) {
                                // Acknowledge replies that arrived while this chat was muted.
                                markReadWithReceipt(threadId)
                            }
                    }
                } finally {
                    if (write != null) {
                        readWrites.remove(threadId)
                        write.complete(Unit)
                    }
                    if (intent != null && undoRequest == null && current()) {
                        val state = mutable.value
                        mutable.value =
                            state.copy(pendingRowActions = state.pendingRowActions - threadId)
                    }
                }
                requireCurrent()
                if (submission?.renameAcknowledged == true) {
                    if (projection.hasUnsettledEdits(submission.edits)) refreshList()
                    return@launch
                }
                if (renameEventId != null && pendingRenameIds[threadId] != renameEventId)
                    return@launch
                val rollback = submission?.let(rowMutations::discardRejected)
                val rolledBack = rollback != null
                if (rolledBack) {
                    val state = mutable.value
                    publishRows(
                        if (
                            rollback == ChatRowMutationOwner.Rollback.CheckMissingDelete ||
                                undoRequest != null
                        )
                            state
                        else
                            state.withRowFailure(
                                ChatRowActionFailure(
                                    action,
                                    rejected = true,
                                    connectionFailed =
                                        rollback == ChatRowMutationOwner.Rollback.ConnectionFailed,
                                    conversationId = conversationId,
                                    feedbackWorkflowId = feedbackWorkflowId,
                                    renameThreadId =
                                        threadId.takeIf { action == ChatRowAction.Rename },
                                ),
                            ),
                    )
                    if (rollback == ChatRowMutationOwner.Rollback.MissingTarget) {
                        refreshList()
                        if (movingProject) refreshMetadata()
                    }
                }
                val confirmedRead = confirmation?.receiptCoversIntent
                val settledRead = confirmation?.rejected == true || confirmedRead == true
                if (undoRequest != null && (settledRead || rolledBack)) {
                    if (rollback == ChatRowMutationOwner.Rollback.Rejected) refreshList()
                    if (
                        confirmedRead == true ||
                            (intent != null && mutable.value.hasConfirmedUnread(threadId))
                    ) {
                        dismissRowUndo(undoRequest)
                    } else failRowUndo(undoRequest)
                    invalidateIndicators()
                    return@launch
                }
                if (
                    undoRequest == null &&
                        confirmation?.alreadySatisfied == false &&
                        confirmedRead == true
                )
                    recordConfirmedUndo(threadId, undo)
                val confirmedEdits = coroutineScope {
                    if (archiveAction || rolledBack && action.updatesIndicators)
                        invalidateIndicators()
                    else if (action.updatesIndicators)
                        launch {
                            readIndicatorsAfterWrite {
                                it == threadId && confirmation?.receiptCoversIntent == false
                            }
                        }
                    if (submission == null) return@coroutineScope false
                    val confirmation =
                        rowMutations.confirm(
                            submission,
                            rollback,
                            conversationId,
                            feedbackWorkflowId,
                        )
                    val failure = confirmation.failure
                    if (undoRequest == null) {
                        if (failure != null) {
                            val previous = mutable.value
                            val state =
                                previous
                                    .withRowFailure(failure)
                                    .copy(
                                        unconfirmedRenames =
                                            if (action == ChatRowAction.Rename && !failure.rejected)
                                                projection.unconfirmedRenames()
                                            else previous.unconfirmedRenames,
                                    )
                            if (movingProject) reconcileProjectMoves(state, rowsChanged = true)
                            else mutable.value = state
                        } else if (!rolledBack) {
                            if (confirmation.ownWriteConfirmed) recordConfirmedUndo(threadId, undo)
                            if (movingProject) {
                                // Project metadata can arrive before the chat event readback.
                                if (!confirmation.ownWriteConfirmed)
                                    reconcileProjectMoves(mutable.value, rowsChanged = true)
                                recordConfirmedProjectMove(edits.single())
                            }
                        }
                    }
                    failure == null
                }
                requireCurrent()
                val unconfirmedRead =
                    confirmation?.confirmed == false &&
                        !confirmation.rejected &&
                        readConfirmations[threadId] === confirmation &&
                        mutable.value.readIntents[threadId] === confirmation.intent
                if (unconfirmedRead) {
                    mutable.value =
                        mutable.value.discardReadIntent(threadId, confirmation.intent, null)
                }
                when {
                    undoRequest != null -> {
                        if (confirmedEdits || confirmation?.confirmed == true) {
                            dismissRowUndo(undoRequest)
                        } else failRowUndo(undoRequest)
                    }
                    unconfirmedRead ->
                        mutable.value =
                            mutable.value.withRowFailure(
                                ChatRowActionFailure(
                                    action,
                                    rejected = true,
                                    conversationId = conversationId,
                                ),
                            )
                }
            } finally {
                if (
                    (intent == null || undoRequest != null) &&
                        current() &&
                        (renameEventId == null || pendingRenameIds.remove(threadId, renameEventId))
                ) {
                    mutable.value =
                        mutable.value.copy(
                            pendingRowActions = mutable.value.pendingRowActions - threadId,
                        )
                }
            }
        }
        return true
    }

    private fun publishRows(state: ChatListUiState = mutable.value) {
        val rows = projection.rows()
        val confirmedRenameIds = projection.confirmedRenameIds
        var pendingRowActions = state.pendingRowActions
        if (pendingRenameIds.isNotEmpty()) {
            pendingRenameIds.entries.removeAll { (threadId, eventId) ->
                if (confirmedRenameIds[threadId] != eventId) false
                else {
                    pendingRowActions = pendingRowActions - threadId
                    true
                }
            }
        }
        publishWithCurrentMoveNotice(
            state
                .copy(
                    threads = rows.threads,
                    confirmedThreads = projection.confirmedRows.threads,
                    threadsByRecency = rows.byRecency,
                    acceptedNewChats = projection.acceptedNewChats,
                    pendingRowActions = pendingRowActions,
                    rowActionFailures =
                        if (state.rowActionFailures.isEmpty()) state.rowActionFailures
                        else
                            state.rowActionFailures.filter {
                                it.edits.isEmpty() || projection.hasUnsettledEdits(it.edits)
                            },
                    unconfirmedRenames = projection.unconfirmedRenames(),
                    confirmedRenameIds = confirmedRenameIds,
                )
                .pruneInvalidUndo { it.threadId !in pendingRowActions },
        )
    }

    private fun publishWithCurrentMoveNotice(state: ChatListUiState) {
        val notice = state.chatMoveNotice?.resolve(state)
        mutable.value =
            if (notice === state.chatMoveNotice) state else state.copy(chatMoveNotice = notice)
    }

    private fun reconcileProjectMoves(state: ChatListUiState, rowsChanged: Boolean = false) {
        val discarded =
            state.projectsSource == ChatListSource.Network &&
                projection.discardUnconfirmedMovesToMissingProjects(state.projects)
        if (rowsChanged || discarded) publishRows(state) else publishWithCurrentMoveNotice(state)
    }

    private fun recordConfirmedProjectMove(edit: ChatRowEdit) {
        val state = mutable.value
        val notice = ChatMoveNotice(edit.eventId, edit.threadId, edit.value, projectName = null)
        notice.resolve(state)?.let { mutable.value = state.copy(chatMoveNotice = it) }
    }

    internal fun retainAcceptedNewChats(chats: List<ProvisionalChat>, restored: Boolean = false) {
        if (!current() || chats.isEmpty()) return
        // A new draft can replace the composer target while these chats await their list rows.
        val state = mutable.value
        projection.retainAcceptedNewChats(chats)
        mutable.value = state.copy(acceptedNewChats = projection.acceptedNewChats)
        if (restored) {
            chats.mapTo(acceptedChatsToVerify) { it.threadId }
            if (state.source == ChatListSource.Network) verifyAcceptedChats()
        }
    }

    private fun verifyAcceptedChats() {
        if (acceptedChatsToVerify.isEmpty()) return
        val accepted = projection.acceptedNewChats
        acceptedChatsToVerify.retainAll(accepted.map { it.threadId }.toSet())
        for (chat in accepted) {
            val id = chat.threadId
            if (id !in acceptedChatsToVerify || !verifyingAcceptedChats.add(id)) continue
            viewModelScope.launch {
                try {
                    verifyAcceptedChat(id)
                } finally {
                    verifyingAcceptedChats.remove(id)
                }
            }
        }
    }

    private suspend fun verifyAcceptedChat(id: String) {
        // Consume the current request before reading so a newer snapshot can request another read.
        while (acceptedChatsToVerify.remove(id)) {
            requireCurrent()
            if (projection.acceptedNewChats.none { it.threadId == id }) return
            try {
                service.threadDetail(id)
                requireCurrent()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                requireCurrent()
                if (error is ApiFailure.Http && error.status == 404) {
                    acceptedChatsToVerify.remove(id)
                    if (projection.removeMissingAcceptedChat(id)) {
                        mutable.value =
                            mutable.value.copy(acceptedNewChats = projection.acceptedNewChats)
                        onAcceptedChatMissing?.invoke(id)
                    }
                    return
                }
                if (
                    error is ApiFailure.Unauthenticated ||
                        error is ApiFailure.UpdateRequired ||
                        error is ApiFailure.Http && error.status == 401
                ) {
                    onFailure(error)
                }
                // Wait for another list publication unless newer verification is already queued.
                if (acceptedChatsToVerify.add(id)) return
            }
        }
    }

    internal fun reloadAfterRowActionFailure() {
        requestListRead(projection.retryEvents(), userRequested = true)
    }

    internal fun checkRowActionFailure(failure: ChatRowActionFailure) {
        if (!current() || failure !in mutable.value.rowActionFailures || failure.rejected) return
        if (failure.renameThreadId != null) checkChatRename(failure.renameThreadId)
        else reloadAfterRowActionFailure()
    }

    internal fun checkChatRename(threadId: String) {
        if (threadId in mutable.value.unconfirmedRenames) requestListRead(userRequested = true)
    }

    internal fun dismissRowActionFailure(failure: ChatRowActionFailure) {
        val state = mutable.value
        if (current() && failure in state.rowActionFailures)
            mutable.value = state.copy(rowActionFailures = state.rowActionFailures - failure)
    }

    internal fun dismissChatMoveNotice(notice: ChatMoveNotice) {
        if (current() && mutable.value.chatMoveNotice == notice) {
            mutable.value = mutable.value.copy(chatMoveNotice = null)
        }
    }

    private suspend fun markReadWithReceipt(threadId: String) {
        val previous = readConfirmations[threadId]
        val lastReadAt = service.markRead(threadId).lastReadAt
        requireCurrent()
        val watermark = lastReadAt?.let(::chatTimestamp) ?: return
        var state = mutable.value
        val undo = previous?.intent?.undoRequest
        if (previous != null && undo != null && readConfirmations[threadId] === previous) {
            // A newly confirmed read supersedes the earlier unread Undo for this chat.
            readConfirmations.remove(threadId)
            state = state.discardReadIntent(threadId, previous.intent, null)
            if (state.activeUndo(undo.fromConversation)?.sequence == undo.sequence) {
                state = state.withUndo(undo.fromConversation, null)
            }
        }
        // The current indicator request can still return unread evidence from before this receipt.
        if (indicatorsJob?.isActive == true) {
            val previousWatermark = indicatorReadReceipts[threadId]
            if (previousWatermark == null || watermark > previousWatermark)
                indicatorReadReceipts[threadId] = watermark
        }
        val indicators = state.indicators
        val saved = state.cachedUnread
        mutable.value =
            if (indicators != null) {
                state.copy(indicators = indicators.acknowledgeUnread(threadId, watermark))
            } else if (saved != null) {
                val unreadAt = saved.unreadAt.acknowledgeUnread(threadId, watermark)
                state.copy(cachedUnread = saved.copy(unreadAt = unreadAt))
            } else state
    }

    private fun Indicators.acknowledgeUnread(
        threadId: String,
        watermark: ChatTimestamp,
    ): Indicators {
        val remainingUnread = unreadAt.acknowledgeUnread(threadId, watermark)
        if (remainingUnread === unreadAt) return this
        val remainingThreads =
            if (threads[threadId] == IndicatorsThreadsValue.UNREAD) threads - threadId else threads
        return copy(threads = remainingThreads, unreadAt = remainingUnread)
    }

    private fun Map<String, String>.acknowledgeUnread(
        threadId: String,
        watermark: ChatTimestamp,
    ): Map<String, String> {
        val unread = this[threadId] ?: return this
        return if (chatTimestamp(unread) <= watermark) this - threadId else this
    }

    internal fun showOutgoingActivity(pending: PendingText) {
        if (!current() || pending.create != null) return
        val id = pending.send.chatThreadSortEventId ?: return
        if (projection.showOutgoing(id, pending.threadId)) publishRows()
    }

    internal fun acknowledgeOutgoingActivity(pending: PendingText) {
        if (!current()) return
        // Send accepts the input before the server's list sort work finishes.
        projection.completeOutgoing(pending.send.chatThreadSortEventId)
    }

    internal fun saveConversationModel(
        threadId: String,
        model: String?,
        effort: ModelEffort?,
        fast: Boolean?,
        selectingModel: Boolean = false,
    ) {
        if (!current() || !remoteAccessVerified()) return
        val state = mutable.value
        val chat =
            state.confirmedThreads.firstOrNull { it.id == threadId && it.hidden != true } ?: return
        val edits = state.conversationModelEdits[threadId] ?: ConversationModelEdits()
        val expected =
            if (selectingModel) null else chat.withModelEdits(edits).selectedModel ?: return
        val request =
            SetThreadModelRequest(
                model = model,
                reasoningEffort =
                    effort?.let { SetThreadModelRequestReasoningEffort.valueOf(it.name) },
                codexServiceTier =
                    if (fast == null) CanonicalOptional.Absent
                    else
                        CanonicalOptional.Present(
                            SetThreadModelRequestCodexServiceTier.FAST.takeIf { fast },
                        ),
                eventId = UUID.randomUUID().toString(),
                serviceTierEventId = UUID.randomUUID().toString(),
            )
        val edit = ConversationModelEdit(request, expected)
        publishModelEdits(
            threadId,
            edits.copy(pending = edits.pending + edit, failures = emptyList()),
        )
        if (edits.pending.isEmpty()) writeConversationModel(threadId)
    }

    private fun writeConversationModel(threadId: String) {
        val edits = checkNotNull(mutable.value.conversationModelEdits[threadId])
        val request = edits.pending.first().request
        publishModelEdits(threadId, edits.copy(phase = ConversationModelSave.Saving))
        viewModelScope.launch {
            val accepted =
                try {
                    service.setThreadModel(threadId, request)
                    true
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: ApiFailure) {
                    requireCurrent()
                    onFailure(error)
                    requireCurrent()
                    if (
                        error is ApiFailure.Http &&
                            error.status in 400..499 &&
                            error.status !in setOf(408, 425, 429) ||
                            error is ApiFailure.Network && error.connectionFailed ||
                            error is ApiFailure.Unauthenticated ||
                            error is ApiFailure.UpdateRequired
                    ) {
                        finishConversationModelWrite(threadId, R.string.chat_model_save_rejected)
                        return@launch
                    }
                    false
                }
            requireCurrent()
            val pending = checkNotNull(mutable.value.conversationModelEdits[threadId])
            publishModelEdits(
                threadId,
                pending.copy(phase = ConversationModelSave.Checking, accepted = accepted),
            )
            checkConversationModelWrite(threadId)
        }
    }

    internal fun retryConversationModelCheck(threadId: String) {
        if (!current()) return
        val edits = mutable.value.conversationModelEdits[threadId] ?: return
        if (edits.phase != ConversationModelSave.NeedsCheck) return
        publishModelEdits(threadId, edits.copy(phase = ConversationModelSave.Checking))
        viewModelScope.launch { checkConversationModelWrite(threadId) }
    }

    internal fun dismissConversationModelFailure(threadId: String, receipt: FeedbackReceipt<Int>) {
        if (!current()) return
        val edits = mutable.value.conversationModelEdits[threadId] ?: return
        if (receipt in edits.failures) {
            publishModelEdits(threadId, edits.copy(failures = edits.failures - receipt))
        }
    }

    private suspend fun checkConversationModelWrite(threadId: String) {
        val read = readListForConfirmation { true }
        requireCurrent()
        if (read && reconcileConversationModelWrite(threadId)) return
        val edits = checkNotNull(mutable.value.conversationModelEdits[threadId])
        publishModelEdits(threadId, edits.copy(phase = ConversationModelSave.NeedsCheck))
    }

    private fun reconcileConversationModelWrite(threadId: String): Boolean {
        val edits = checkNotNull(mutable.value.conversationModelEdits[threadId])
        val request = edits.pending.first().request
        val row = mutable.value.confirmedThreads.firstOrNull { it.id == threadId }
        val observed =
            edits.accepted ||
                row == null ||
                row.matchesModelWrite(request) ||
                confirmed?.checkpoint?.events?.any {
                    it is ChatEventsEventsItemVariant1 &&
                        it.chatThreadId == threadId &&
                        it.id == request.eventId
                } == true
        // After a lost response, a read may arrive before the write commits.
        if (observed) finishConversationModelWrite(threadId, failure = null)
        return observed
    }

    private fun finishConversationModelWrite(threadId: String, failure: Int?) {
        val state = mutable.value
        val edits = checkNotNull(state.conversationModelEdits[threadId])
        val chat = state.confirmedThreads.firstOrNull { it.id == threadId && it.hidden != true }
        val remaining = chat?.let { edits.pending.drop(1).rebaseOn(it) }.orEmpty()
        val failures = edits.failures + listOfNotNull(failure?.let(::FeedbackReceipt))
        publishModelEdits(
            threadId,
            ConversationModelEdits(pending = remaining, failures = failures),
        )
        if (remaining.isNotEmpty()) writeConversationModel(threadId)
    }

    private fun publishModelEdits(threadId: String, edits: ConversationModelEdits) {
        val state = mutable.value
        val updates =
            if (edits.pending.isEmpty() && edits.failures.isEmpty())
                state.conversationModelEdits - threadId
            else state.conversationModelEdits + (threadId to edits)
        mutable.value = state.copy(conversationModelEdits = updates)
    }

    private fun ConfirmedChat.matchesModelWrite(request: SetThreadModelRequest): Boolean {
        val tier = request.codexServiceTier
        return selectedModel.takeUnless(::isAutoDefaultModel) == request.model &&
            (request.reasoningEffort == null ||
                modelSettings?.get(selectedModel)?.effort?.name == request.reasoningEffort.name) &&
            (tier !is CanonicalOptional.Present || serviceTier == tier.value.toChatServiceTier())
    }

    internal fun refreshAfterSendFailure(pending: PendingText, rejected: Boolean) {
        if (!current()) return
        if (projection.completeOutgoing(pending.send.chatThreadSortEventId, rejected)) publishRows()
        refreshList()
    }

    fun refreshAfterSend(threadId: String) {
        refreshList()
        if (history.uiState.value.thread?.id == threadId) history.refreshAfterSend(threadId)
    }

    fun refresh() {
        if (!current() || !remoteAccessVerified()) return
        // Activity resume refreshes this owner even while workspace preferences are loading.
        restoreCache()
        requestListRead(resetCompletedActivity = true)
        if (listInForeground) refreshMetadata()
        refreshIndicators()
        refreshDraftIndex()
    }

    internal fun activityForegroundChanged(foreground: Boolean) {
        val wasReading = needsListRead
        listInForeground = foreground
        if (foreground) {
            // A write's readback can outlive a list visit. Catch up after it finishes.
            if (!wasReading && indicatorsJob?.isActive == true) {
                requestIndicators(immediate = true, verifyReadCursors = true)
            }
            refresh()
        } else if (wasReading) {
            endListReadScope()
        }
    }

    internal fun listVisibilityChanged(visible: Boolean) {
        if (visible == listIsVisible) return
        listIsVisible = visible
        if (!listInForeground || !current()) return
        if (visible) {
            if (remoteAccessVerified()) {
                requestListRead()
                requestIndicators(immediate = true, verifyReadCursors = true)
            }
            val state = mutable.value
            if (state.projectsPhase == ChatReadPhase.Failed) refreshMetadata()
            refreshDraftIndex()
        } else {
            endListReadScope()
        }
    }

    internal fun listPaneVisibilityChanged(visible: Boolean) {
        if (visible == (listFeedbackScope != null)) return
        listFeedbackScope = if (visible) Any() else null
        if (!visible && current()) {
            val state = mutable.value.clearRefreshFailures()
            mutable.value =
                state.copy(
                    projectList =
                        state.projectList.copy(
                            deleteFeedback =
                                state.projectList.deleteFeedback.filterNot { it.rejected },
                        ),
                )
        }
    }

    private fun endListReadScope() {
        listReadScope = Any()
        if (listFeedbackScope != null) listFeedbackScope = Any()
        val listRefresh = listRefreshJob
        val indicatorRefresh = indicatorsJob.takeIf { indicatorsRetry != null }
        listRebaseJob?.cancel()
        readyListRebase = null
        pendingListRead?.refresh = false
        resetListReadFailures()
        resetIndicatorReadFailures()
        indicatorsInvalidated = false
        immediateIndicators = false
        readCursorChanged = false
        indicatorsStartedAt = null
        if (current()) {
            val state = mutable.value
            mutable.value =
                state
                    .clearRefreshFailures()
                    .copy(
                        listPhase =
                            if (listRefresh == null && state.listPhase == ChatReadPhase.Loading)
                                state.listPhase
                            else settledListPhase(state),
                        listReadFailure = null,
                        listReadStartedAt = null,
                        listRetryProgressVisible = false,
                        indicatorsPhase =
                            if (indicatorRefresh == null) state.indicatorsPhase
                            else if (state.indicators != null) ChatReadPhase.Ready
                            else ChatReadPhase.Idle,
                        indicatorsReadStartedAt = null,
                        indicatorsRetryProgressVisible = false,
                    )
        }
        listRefresh?.cancel()
        indicatorRefresh?.cancel()
        // Wake the invalidation worker if it is delaying a now-obsolete read.
        indicatorInvalidations.trySend(Unit)
    }

    private fun scheduleListRetry(retryAt: Long) {
        listRetry?.cancel()
        listRetry = viewModelScope.launch {
            val wait = retryAt - monotonicMillis()
            // A zero-delay retry must wait for the current failure to finish publishing.
            if (wait > 0) delay(wait) else yield()
            listRetry = null
            listRetryAt = null
            refreshList()
        }
    }

    internal fun restoreStartupCache(prepared: Deferred<PreparedChatList?>) {
        restoreCache(prepared)
    }

    private fun restoreCache(prepared: Deferred<PreparedChatList?>? = null) {
        if (cacheRead) return
        cacheRead = true
        viewModelScope.launch { restoreUnread() }
        val chatRestore = viewModelScope.launch {
            try {
                val startup = prepared?.await()?.takeIf { it.identity == identity }
                val saved = startup?.saved ?: cache.load() ?: return@launch
                val rows =
                    startup?.rows ?: withContext(dispatcher) { replayChatList(saved.checkpoint) }
                requireCurrent()
                val state = mutable.value
                confirmed = saved
                projection.restore(saved.checkpoint, rows)
                publishRows(
                    state.copy(confirmedAt = saved.confirmedAt, source = ChatListSource.Cache),
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                currentCoroutineContext().ensureActive()
                if (current()) mutable.value = mutable.value.copy(cacheUnavailable = true)
            }
        }
        restoreJob = chatRestore
        projectOwner.restore(afterChatCache = chatRestore)
    }

    private suspend fun restoreUnread() {
        val saved = cache.loadUnread() ?: return
        requireCurrent()
        val state = mutable.value
        if (state.indicators == null) mutable.value = state.copy(cachedUnread = saved)
    }

    private fun listReadBatch(): ListReadBatch =
        pendingListRead ?: ListReadBatch().also { pendingListRead = it }

    fun refreshList() = requestListRead()

    internal suspend fun resolveSearchChats(chatIds: Set<String>): Set<String> {
        fun missingChats() =
            chatIds.toMutableSet().apply {
                mutable.value.threadsByRecency.forEach { remove(it.id) }
            }

        requireCurrent()
        val request = currentCoroutineContext()
        // The list worker can skip the catch-up if another read already found the chats.
        awaitListRead { request.isActive && canRefreshList() && missingChats().isNotEmpty() }
        requireCurrent()
        return missingChats()
    }

    internal fun retryList() = requestListRead(userRequested = true)

    private fun canRefreshList() = listRetryAt == null

    private fun requestListRead(
        discardOnSuccess: Set<String> = emptySet(),
        userRequested: Boolean = false,
        resetCompletedActivity: Boolean = userRequested,
    ) {
        if (!current()) return
        if (resetCompletedActivity) completedActivityReconciliation = Any()
        if (!userRequested && discardOnSuccess.isEmpty() && (!needsListRead || !canRefreshList()))
            return
        val batch = listReadBatch()
        batch.refresh = true
        batch.userRequested = batch.userRequested || userRequested
        batch.discardOnSuccess.addAll(discardOnSuccess)
        listReadRequests.trySend(Unit)
    }

    private suspend fun awaitListRead(needsRead: () -> Boolean) {
        readListForConfirmation(needsRead)
    }

    private suspend fun readListForConfirmation(needsRead: () -> Boolean): Boolean {
        val completion = CompletableDeferred<Boolean>(currentCoroutineContext()[Job])
        val batch = listReadBatch()
        batch.confirmations.add(ListConfirmation(needsRead, completion))
        listReadRequests.trySend(Unit)
        return completion.await()
    }

    private suspend fun readPendingListBatch() {
        val batch = pendingListRead
        pendingListRead = null
        val unconfirmed =
            batch?.confirmations.orEmpty().filter { confirmation ->
                if (confirmation.needsRead()) true
                else {
                    confirmation.done.complete(true)
                    false
                }
            }
        // Signals received during a read share the next batch. A write can skip it if an
        // earlier read settled its event IDs; cursorless refresh signals still need a read.
        if (batch != null) {
            val explicitRead =
                batch.userRequested ||
                    unconfirmed.isNotEmpty() ||
                    batch.discardOnSuccess.isNotEmpty()
            if (explicitRead) {
                completeListBatch(batch, unconfirmed)
                return
            }
            if (batch.refresh && needsListRead && canRefreshList()) {
                runListRefresh { completeListBatch(batch, unconfirmed) }
                return
            }
        }

        // The same worker publishes both results, with pending refreshes taking priority.
        val rebased = readyListRebase ?: return
        readyListRebase = null
        if (!needsListRead || confirmed?.checkpoint !== rebased.baseline) return
        // Keep unseen mutation IDs available to the next incremental confirmation read.
        if (
            projection.hasPendingMutations &&
                rebased.result.checkpoint.snapshotCursor.seqId > rebased.baseline.cursor.seqId
        )
            return
        runListRefresh {
            try {
                publishList(rebased.result, emptySet(), rebased.projection)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                requireCurrent()
                onFailure(error)
            }
        }
    }

    private suspend fun runListRefresh(read: suspend () -> Unit) = coroutineScope {
        // Cancel a visit's work without cancelling the worker or its queued explicit reads.
        val job = launch(start = CoroutineStart.LAZY) { read() }
        listRefreshJob = job
        try {
            job.join()
        } finally {
            listRefreshJob = null
        }
    }

    private suspend fun completeListBatch(batch: ListReadBatch, pending: List<ListConfirmation>) {
        listRebaseJob?.cancel()
        readyListRebase = null
        try {
            val read = readList(batch)
            // A normal chat refresh can also settle a model write after a failed readback.
            if (read) {
                mutable.value.conversationModelEdits.forEach { (threadId, edits) ->
                    if (edits.phase == ConversationModelSave.NeedsCheck)
                        reconcileConversationModelWrite(threadId)
                }
            }
            pending.forEach { it.done.complete(read) }
        } finally {
            pending.forEach { it.done.cancel() }
        }
    }

    private suspend fun readList(batch: ListReadBatch): Boolean {
        restoreJob?.join()
        requireCurrent()
        // Explicit readbacks can outlive the visit that started them.
        val retryScope = listReadScope.takeIf { needsListRead }
        val feedbackScope = visibleListFeedbackScope
        // Keep the exact IDs selected by an explicit refresh until a read succeeds.
        rowDiscardsAfterRead.addAll(batch.discardOnSuccess)
        val previous = mutable.value
        mutable.value =
            previous.copy(
                listPhase = ChatReadPhase.Loading,
                listReadFailure =
                    previous.listReadFailure?.takeIf { it == ChatListReadFailure.Retrying },
                listReadStartedAt = previous.listReadStartedAt ?: wallMillis(),
            )
        return try {
            // A normal catch-up still needs the sort event. Resume or an explicit refresh can
            // restore the canonical order for completed attempts after a successful read.
            val reconciliation = completedActivityReconciliation
            val finishedActivity =
                if (reconciliation != null) projection.completedOutgoingAttempts() else emptyMap()
            val acknowledgedRenames = projection.acknowledgedRenameIds()
            val result = sync.synchronize(confirmed?.checkpoint)
            publishList(
                result,
                rowDiscardsAfterRead,
                finishedActivity = finishedActivity,
                renamesAcknowledgedBeforeRead = acknowledgedRenames,
            )
            rowDiscardsAfterRead.clear()
            if (completedActivityReconciliation === reconciliation)
                completedActivityReconciliation = null
            if (
                needsListRead && result.shouldRebase && confirmed?.checkpoint === result.checkpoint
            ) {
                startListRebase(result.checkpoint)
            }
            true
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            requireCurrent()
            val retryDelay = chatReadRetryDelayMillis(error, listFailures)
            fail(error) { state ->
                val failed = state.copy(listPhase = ChatReadPhase.Failed)
                if (retryDelay == null) {
                    resetListReadFailures()
                    failed.copy(
                        listReadFailure = ChatListReadFailure.NeedsRetry,
                        listReadStartedAt = null,
                        listRetryProgressVisible = false,
                        listRefreshFailureOrder =
                            if (
                                batch.refresh &&
                                    feedbackScope != null &&
                                    feedbackScope === visibleListFeedbackScope &&
                                    state.hasUsableList
                            )
                                nextPaneFeedbackOrder()
                            else state.listRefreshFailureOrder,
                    )
                } else if (needsListRead && retryScope === listReadScope) {
                    recordListReadFailure(retryDelay)
                    failed.copy(
                        listReadFailure = ChatListReadFailure.Retrying,
                        listRetryProgressVisible =
                            state.confirmedAt != null &&
                                (state.listRetryProgressVisible ||
                                    listFailures >= listRetryProgressThreshold ||
                                    state.listReadStartedStale),
                    )
                } else {
                    state.copy(listPhase = settledListPhase(state), listReadStartedAt = null)
                }
            }
            false
        }
    }

    private fun settledListPhase(state: ChatListUiState) =
        if (state.source == ChatListSource.Network) ChatReadPhase.Ready else ChatReadPhase.Idle

    private fun resetListReadFailures() {
        listRetry?.cancel()
        listRetry = null
        listRetryAt = null
        listFailures = 0
    }

    private fun recordListReadFailure(delayMillis: Long) {
        listFailures = (listFailures + 1).coerceAtMost(continuousRetryDelays.size)
        val retryAt = retryDeadlineMillis(delayMillis)
        listRetryAt = retryAt
        scheduleListRetry(retryAt)
    }

    private fun retryDeadlineMillis(delayMillis: Long): Long {
        val now = monotonicMillis()
        return now + minOf(delayMillis, Long.MAX_VALUE - now.coerceAtLeast(0L))
    }

    private fun startListRebase(checkpoint: ChatCheckpoint) {
        listRebaseJob = viewModelScope.launch {
            try {
                val rebased = sync.rebase(checkpoint) ?: return@launch
                val projection = withContext(dispatcher) { replayChatList(rebased.checkpoint) }
                requireCurrent()
                readyListRebase = PreparedListRebase(checkpoint, rebased, projection)
                listReadRequests.trySend(Unit)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                requireCurrent()
                onFailure(error)
            }
        }
    }

    private suspend fun publishList(
        result: ChatListSync.Result,
        discardOnSuccess: Set<String>,
        preparedProjection: ReplayedChats? = null,
        finishedActivity: Map<String, ChatListProjection.OutgoingAttempt> = emptyMap(),
        renamesAcknowledgedBeforeRead: Set<String> = emptySet(),
    ) {
        requireCurrent()
        val previous = confirmed
        val checkpoint = result.checkpoint
        val replayed =
            preparedProjection
                ?: if (checkpoint === previous?.checkpoint) projection.confirmedRows
                else withContext(dispatcher) { replayChatList(checkpoint) }
        requireCurrent()
        val refreshed = CachedChats(checkpoint, wallMillis())
        val saved =
            if (!result.changed && previous != null && !mutable.value.cacheUnavailable) {
                refreshed.also {
                    if (it.confirmedAt != previous.confirmedAt) chatConfirmationWrites.trySend(it)
                }
            } else persistChats(refreshed)
        val rows =
            if (saved.checkpoint === checkpoint) replayed
            else withContext(dispatcher) { replayChatList(saved.checkpoint) }
        requireCurrent()
        confirmed = saved
        val projectionChanged =
            projection.reconcile(
                result,
                saved.checkpoint,
                rows,
                discardOnSuccess,
                finishedActivity,
                renamesAcknowledgedBeforeRead,
            )
        val previousState = mutable.value
        val state =
            previousState.copy(
                confirmedAt = saved.confirmedAt,
                source = ChatListSource.Network,
                listPhase = ChatReadPhase.Ready,
                listReadFailure = null,
                listReadStartedAt = null,
                listRetryProgressVisible = false,
                listRefreshFailureOrder = null,
            )
        resetListReadFailures()
        if (projectionChanged) publishRows(state) else mutable.value = state
        // Snapshot absence can also mean a creation raced the read. Verify by thread ID.
        if (result.replacedSnapshot)
            projection.acceptedNewChats.mapTo(acceptedChatsToVerify) { it.threadId }
        verifyAcceptedChats()
    }

    fun refreshMetadata() {
        if (!current()) return
        projectOwner.refresh()
    }

    internal fun renameProject(id: String, input: String) = projectOwner.renameProject(id, input)

    internal fun createProject(name: String) = projectOwner.createProject(name)

    internal fun checkProjectCreation() = projectOwner.checkProjectCreation()

    internal fun dismissProjectCreation() = projectOwner.dismissProjectCreation()

    internal fun checkProjectRename(id: String) = projectOwner.checkProjectRename(id)

    internal fun dismissProjectRenameRejection(rejection: ProjectRenameRejection) =
        projectOwner.dismissProjectRenameRejection(rejection)

    internal fun deleteProject(id: String) {
        if (mutable.value.canDeleteProject) projectOwner.deleteProject(id)
    }

    internal fun dismissProjectDeleteFeedback(feedback: ProjectDeleteFeedback) =
        projectOwner.dismissProjectDeleteFeedback(feedback)

    private fun invalidateIndicators() {
        requestIndicators(immediate = true)
    }

    private fun requestIndicators(immediate: Boolean, verifyReadCursors: Boolean = false) {
        if (!needsListRead || !current() || !remoteAccessVerified()) return
        indicatorsInvalidated = true
        immediateIndicators = immediateIndicators || immediate
        readCursorChanged = readCursorChanged || verifyReadCursors
        indicatorInvalidations.trySend(Unit)
    }

    private suspend fun awaitIndicatorRead(beforeWriteReadback: Boolean = false) {
        while (indicatorsJob?.isCompleted == false) {
            if (beforeWriteReadback) indicatorsRetry?.stopRetrying()
            indicatorsJob?.join()
        }
    }

    private suspend fun readIndicatorsAfterWrite(verifyPendingRead: ((String) -> Boolean)? = null) {
        // A read already in flight may have started before the write.
        awaitIndicatorRead(beforeWriteReadback = true)
        requireCurrent()
        readIndicators(verifyPendingRead, afterWrite = true)
        indicatorsJob?.join()
    }

    fun refreshIndicators() {
        if (!needsListRead || !remoteAccessVerified()) return
        val read = indicatorsJob
        if (read?.isCompleted != false) {
            readIndicators(
                verifyPendingRead = { readConfirmations[it]?.retainUntilConfirmed == true },
            )
        } else if (read.isCancelled) {
            // The old read still owns cleanup. Its replacement goes through the worker.
            requestIndicators(immediate = true, verifyReadCursors = true)
        }
    }

    private fun resetIndicatorReadFailures() {
        indicatorFailures = 0
        indicatorRetryAt = null
    }

    private fun refreshDraftIndex() {
        if (!current() || draftIndexRead != null) return
        val read = DraftIndexRead()
        val version = ++draftIndexRequestVersion
        draftIndexRead = read
        viewModelScope.launch {
            try {
                val ids = service.draftThreadIds().toMutableSet()
                requireCurrent()
                for ((id, present) in read.presenceOverrides) {
                    if (present) ids.add(id) else ids.remove(id)
                }
                confirmedDraftIndexVersion = version
                mutable.value = mutable.value.copy(draftThreadIds = ids)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                requireCurrent()
                onFailure(error)
            } finally {
                if (draftIndexRead === read) draftIndexRead = null
            }
        }
    }

    internal fun confirmDraftPresence(
        threadId: String,
        present: Boolean,
        indexVersionAtStart: Long = draftIndexRequestVersion,
    ) {
        if (!current() || indexVersionAtStart < confirmedDraftIndexVersion) return
        // Compare reads by request start. Acknowledged saves use the latest version on completion.
        if (indexVersionAtStart == draftIndexRequestVersion)
            draftIndexRead?.presenceOverrides?.set(threadId, present)
        val state = mutable.value
        val ids = state.draftThreadIds ?: return
        if ((threadId in ids) != present) {
            val updated = if (present) ids + threadId else ids - threadId
            mutable.value = state.copy(draftThreadIds = updated)
        }
    }

    private fun readIndicators(
        verifyPendingRead: ((String) -> Boolean)? = null,
        afterWrite: Boolean = false,
    ) {
        if (!current() || indicatorsJob?.isCompleted == false) return
        val feedbackScope = visibleListFeedbackScope.takeUnless { afterWrite }
        val retry =
            if (afterWrite) null
            else
                ChatDependencyRetry(
                    previousFailures = indicatorFailures,
                    waitBeforeReadMillis =
                        indicatorRetryAt?.let { (it - monotonicMillis()).coerceAtLeast(0L) },
                )
        indicatorsRetry = retry
        val previous = mutable.value
        mutable.value =
            previous.copy(
                indicatorsPhase = ChatReadPhase.Loading,
                indicatorsNonRetryableFailure = false,
                // Write verification can take over the active indicator read during backoff.
                indicatorsReadStartedAt = previous.indicatorsReadStartedAt ?: wallMillis(),
            )
        indicatorsJob = viewModelScope.launch {
            var verifyInvalidatedCursors = false
            try {
                suspend fun fetch(): Pair<Map<String, ReadConfirmation>, Indicators> {
                    if (!afterWrite) {
                        // A retry also covers invalidations received before this request.
                        indicatorRetryAt = null
                        verifyInvalidatedCursors = verifyInvalidatedCursors || readCursorChanged
                        indicatorsInvalidated = false
                        readCursorChanged = false
                        immediateIndicators = false
                    }
                    indicatorsStartedAt = monotonicMillis()
                    indicatorReadReceipts.clear()
                    // Responses can only settle writes that finished before this request.
                    val eligible = readConfirmations.toMap()
                    return eligible to service.indicators()
                }
                val (eligible, result) =
                    retry?.read(
                        isCurrent = { needsListRead && current() },
                        continuous = true,
                        onRetry = { failures ->
                            indicatorFailures = failures
                            val state = mutable.value
                            if (
                                failures >= listRetryProgressThreshold &&
                                    !state.indicatorsRetryProgressVisible
                            )
                                mutable.value = state.copy(indicatorsRetryProgressVisible = true)
                        },
                        fetch = ::fetch,
                    ) ?: fetch()
                requireCurrent()
                var checkedCursors: MutableMap<String, ThreadDetail>? = null
                if (verifyInvalidatedCursors || verifyPendingRead != null) {
                    for ((id, confirmation) in eligible) {
                        if (
                            confirmation.receiptCoversIntent ||
                                (verifyPendingRead?.invoke(id) != true &&
                                    (!verifyInvalidatedCursors ||
                                        !confirmation.retainUntilConfirmed)) ||
                                readConfirmations[id] !== confirmation
                        )
                            continue
                        if (
                            confirmation.intent.action == ChatRowAction.MarkUnread &&
                                confirmation.unconfirmedInverse == null &&
                                id in result.unreadAt
                        )
                            continue
                        val detail = readThreadForConfirmation(id) ?: continue
                        val cursors =
                            checkedCursors
                                ?: mutableMapOf<String, ThreadDetail>().also {
                                    checkedCursors = it
                                }
                        cursors[id] = detail
                    }
                }
                val unreadConfirmedAt = wallMillis()
                var reconciled =
                    indicatorReadReceipts.entries.fold(result) { status, (id, watermark) ->
                        status.acknowledgeUnread(id, watermark)
                    }
                val state = mutable.value
                val settledVisible = mutableSetOf<String>()
                for ((id, confirmation) in eligible) {
                    if (readConfirmations[id] !== confirmation) continue
                    val inverse = confirmation.unconfirmedInverse
                    val observedUnread =
                        confirmation.intent.action == ChatRowAction.MarkUnread &&
                            inverse == null &&
                            id in result.unreadAt
                    // A bounded indicator result can miss a chat. Read the cursor itself when
                    // needed, but wait for different evidence if an inverse may still be
                    // pending.
                    val cursorConfirmed =
                        checkedCursors?.get(id)?.let { detail ->
                            val cursor = detail.lastReadAt
                            if (inverse == null) {
                                val matches = confirmation.intent.matchesReadCursor(cursor)
                                if (matches && cursor != null)
                                    reconciled =
                                        reconciled.acknowledgeUnread(id, chatTimestamp(cursor))
                                matches
                            } else {
                                if (inverse.matchesReadCursor(cursor))
                                    confirmation.unconfirmedInverse = null
                                false
                            }
                        } == true
                    val confirmed =
                        confirmation.receiptCoversIntent ||
                            observedUnread ||
                            cursorConfirmed ||
                            (confirmation.intent.action == ChatRowAction.MarkRead &&
                                indicatorReadReceipts[id]?.let {
                                    confirmation.intent.covers(it)
                                } == true)
                    confirmation.confirmedByReadback =
                        confirmed && !confirmation.receiptCoversIntent
                    // An intervening refresh must leave ambiguous writes for the batch's readback.
                    if (
                        !confirmed &&
                            (confirmation.retainUntilConfirmed ||
                                batchReadIntents?.get(id) === confirmation.intent)
                    )
                        continue
                    val projectedIntent = confirmation.projectedIntent
                    if (projectedIntent != null && state.readIntents[id] === projectedIntent) {
                        settledVisible.add(id)
                    }
                    readConfirmations.remove(id)
                }
                resetIndicatorReadFailures()
                mutable.value =
                    state
                        .copy(
                            indicators = reconciled,
                            indicatorsPhase = ChatReadPhase.Ready,
                            indicatorsConfirmedAt = unreadConfirmedAt,
                            indicatorsReadStartedAt = null,
                            indicatorsRetryProgressVisible = false,
                            indicatorsRefreshFailureOrder = null,
                            cachedUnread = null,
                            readIntents = state.readIntents - settledVisible,
                        )
                        .pruneInvalidUndo { it.threadId !in state.pendingRowActions }
                unreadCacheWrites.trySend(CachedUnread(unreadConfirmedAt, reconciled.unreadAt))
            } catch (superseded: ChatDependencyRetry.Superseded) {
                // A verification for another write cannot consume a realtime cursor signal.
                if (verifyInvalidatedCursors || readCursorChanged)
                    requestIndicators(immediate = true, verifyReadCursors = true)
                throw superseded
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                val retryDelay = dependencyRetryDelayMillis(error, indicatorFailures)
                fail(error) { state ->
                    if (afterWrite && retryDelay != null && needsListRead) {
                        indicatorFailures =
                            (indicatorFailures + 1).coerceAtMost(continuousRetryDelays.size)
                        indicatorRetryAt = retryDeadlineMillis(retryDelay)
                    } else resetIndicatorReadFailures()
                    val resumeListIndicators = indicatorRetryAt != null
                    state.copy(
                        indicatorsPhase = ChatReadPhase.Failed,
                        indicatorsNonRetryableFailure = retryDelay == null,
                        indicatorsReadStartedAt =
                            state.indicatorsReadStartedAt.takeIf {
                                resumeListIndicators
                            },
                        indicatorsRetryProgressVisible =
                            resumeListIndicators && indicatorFailures >= listRetryProgressThreshold,
                        indicatorsRefreshFailureOrder =
                            if (
                                retryDelay == null &&
                                    feedbackScope != null &&
                                    feedbackScope === visibleListFeedbackScope
                            )
                                nextPaneFeedbackOrder()
                            else state.indicatorsRefreshFailureOrder,
                    )
                }
                if (indicatorRetryAt != null) requestIndicators(immediate = true)
            } finally {
                indicatorsRetry = null
                indicatorReadReceipts.clear()
            }
        }
    }

    private fun fail(error: Exception, update: (ChatListUiState) -> ChatListUiState) {
        if (!current()) return
        onFailure(error)
        if (current()) mutable.value = update(mutable.value)
    }

    override fun onCleared() {
        retired = true
        updates.close()
        warming.close()
        resetListReadFailures()
        listReadRequests.close()
        pendingListRead?.confirmations?.forEach { it.done.cancel() }
        pendingListRead = null
        readyListRebase = null
        projectOwner.close()
        indicatorInvalidations.close()
        unreadCacheWrites.close()
        chatConfirmationWrites.close()
        history.close()
        cache.close()
    }
}
