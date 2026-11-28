package ai.okou.android.workflows

import ai.okou.android.MemorySnapshotClock
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.WorkflowAutomation
import ai.okou.android.api.generated.WorkflowDetail
import ai.okou.android.api.generated.WorkflowDetailShadowedBy
import ai.okou.android.api.generated.WorkflowDetailVisibility
import ai.okou.android.api.generated.WorkflowRunHistory
import ai.okou.android.api.generated.WorkflowRunHistoryEntry
import ai.okou.android.api.generated.WorkflowSummary
import ai.okou.android.api.generated.WorkflowSummaryShadowedBy
import ai.okou.android.api.generated.WorkflowSummaryVisibility
import ai.okou.android.api.retryBoundedRead
import ai.okou.android.isFreshMemorySnapshot
import ai.okou.android.nextPaneFeedbackOrder
import ai.okou.android.state.WorkflowTab
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlin.time.AbstractLongTimeSource
import kotlin.time.DurationUnit
import kotlin.time.TimeMark
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

internal data class WorkflowState(
    val catalog: List<WorkflowSummary>? = null,
    val catalogStartedAt: TimeMark? = null,
    val rules: Map<String, List<WorkflowAutomation>>? = null,
    val connections: Set<String>? = null,
    val detail: WorkflowDetail? = null,
    val detailReadStart: WorkflowReadStart? = null,
    val history: WorkflowRunHistory? = null,
    val historyReadStart: WorkflowReadStart? = null,
    val catalogFailure: WorkflowReadFailure? = null,
    val rulesFailure: WorkflowReadFailure? = null,
    val connectionsFailure: WorkflowReadFailure? = null,
    val detailFailure: WorkflowReadFailure? = null,
    val historyFailure: WorkflowReadFailure? = null,
    val historyRead: WorkflowHistoryRead? = null,
    val writing: Boolean = false,
    val toggles: Map<String, WorkflowToggle> = emptyMap(),
    val issue: WorkflowWriteIssue? = null,
    val editing: WorkflowEditSession? = null,
) {
    val catalogRefreshing: Boolean
        get() = catalogStartedAt != null

    val editor: WorkflowEdit?
        get() = editing?.draft
}

internal data class WorkflowReadStart(val workflowId: String, val startedAt: TimeMark)

private fun WorkflowState.editingFor(detail: WorkflowDetail?): WorkflowEditSession? = detail?.let {
    val session = editing ?: return null
    if (writing || session.receiveConfirmed(it)) session else null
}

internal enum class WorkflowHistoryRead(val loading: Boolean, val earlier: Boolean = false) {
    Latest(true),
    Earlier(true, earlier = true),
    EarlierPaused(false, earlier = true),
}

internal enum class WorkflowTogglePhase {
    Submitting,
    Checking,
    Unconfirmed,
    Failed;

    val needsReadback: Boolean
        get() = this == Checking || this == Unconfirmed
}

internal data class WorkflowToggle(val enabled: Boolean, val phase: WorkflowTogglePhase)

internal sealed interface WorkflowReadFailure {
    data object Unavailable : WorkflowReadFailure

    // The result identifies one completed read round, even when the next round fails the same way.
    data class Failed(val sequence: Long) : WorkflowReadFailure {
        val feedbackOrder = nextPaneFeedbackOrder()
    }
}

private fun WorkflowReadFailure?.whileReading(hasContent: Boolean): WorkflowReadFailure? =
    takeUnless {
        !hasContent && it is WorkflowReadFailure.Failed
    }

internal enum class WorkflowWriteFailure {
    Failed,
    Network,
    Conflict,
    UncertainCreate,
}

internal data class WorkflowWriteIssue(
    val failure: WorkflowWriteFailure,
    val ruleId: String? = null,
    val rejectedDraft: WorkflowEdit? = null,
)

/** Confirmed data belongs to the authorized workspace and survives leaving the destination. */
class WorkflowModel
internal constructor(
    private val service: WorkflowService,
    private val authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
    private val monotonicMillis: () -> Long = MemorySnapshotClock::nowMillis,
) : ViewModel() {
    private val mutable = MutableStateFlow(WorkflowState())
    internal val state = mutable.asStateFlow()
    private val readClock =
        object : AbstractLongTimeSource(DurationUnit.MILLISECONDS) {
            override fun read() = monotonicMillis()
        }
    private var visible = false
    private var searchingCatalog = false
    private var foreground = false
    private var selected: String? = null
    private var tab = WorkflowTab.Instructions
    private var readSequence = 0L
    private val catalogRead = WorkflowRangeRead()
    private val rulesRead = WorkflowRangeRead()
    private val connectionsRead = WorkflowRangeRead()
    private val details =
        LinkedHashMap<String, CachedWorkflowDetail>(WORKFLOW_DETAIL_CACHE_CAPACITY, 0.75f, true)
    private var detailLoad: Job? = null
    private val histories =
        LinkedHashMap<String, CachedWorkflowHistory>(WORKFLOW_DETAIL_CACHE_CAPACITY, 0.75f, true)
    private var historyLoad: Job? = null
    private val readsAfterWrite = mutableSetOf<WorkflowReadScope>()

    internal fun visibilityChanged(open: Boolean, retainCurrentVisit: Boolean = false) {
        if (visible == open) return
        visible = open
        if (open) {
            if (!retainCurrentVisit) presentCachedRanges()
            refresh()
        } else stopReads(keepCatalog = searchingCatalog)
    }

    internal fun searchVisibilityChanged(open: Boolean) {
        if (searchingCatalog == open) return
        searchingCatalog = open
        if (open) {
            if (!visible && !catalogRead.readAt.isFreshMemorySnapshot(monotonicMillis())) {
                mutable.value = mutable.value.copy(catalog = null, catalogFailure = null)
            }
            refresh(catalogScope)
        } else if (!visible) {
            cancelCatalogRead()
        }
    }

    internal fun foregroundChanged(resumed: Boolean) {
        if (foreground == resumed) return
        foreground = resumed
        // Foreground changes retain the current visit, including the active editor.
        if (resumed) refresh() else stopReads(keepEarlierRequest = true)
    }

    private fun stopReads(keepCatalog: Boolean = false, keepEarlierRequest: Boolean = false) {
        stopWorkflowReads(keepCatalog)
        cancelHistoryRead(keepEarlierRequest)
        connectionsRead.cancel()
    }

    private fun stopWorkflowReads(keepCatalog: Boolean = false) {
        if (!keepCatalog) cancelCatalogRead()
        rulesRead.cancel()
        cancelDetailRead()
    }

    private fun cancelCatalogRead() {
        catalogRead.cancel()
        if (mutable.value.catalogRefreshing) {
            mutable.value = mutable.value.copy(catalogStartedAt = null)
        }
    }

    private fun cancelDetailRead() {
        detailLoad?.cancel()
        detailLoad = null
        if (mutable.value.detailReadStart != null) {
            mutable.value = mutable.value.copy(detailReadStart = null)
        }
    }

    private fun invalidateCachedDetail(id: String) {
        details[id]?.let { details[id] = it.copy(readAt = null) }
    }

    private fun cancelHistoryRead(keepEarlierRequest: Boolean = false) {
        historyLoad?.cancel()
        historyLoad = null
        val current = mutable.value
        val read =
            when (current.historyRead) {
                WorkflowHistoryRead.Earlier,
                WorkflowHistoryRead.EarlierPaused ->
                    WorkflowHistoryRead.EarlierPaused.takeIf { keepEarlierRequest }
                WorkflowHistoryRead.Latest,
                null -> null
            }
        if (read != current.historyRead || current.historyReadStart != null) {
            mutable.value =
                current.copy(
                    historyRead = read,
                    historyReadStart = null,
                    historyFailure =
                        current.historyFailure.takeUnless {
                            current.historyRead?.earlier == true && read == null
                        },
                )
        }
    }

    internal fun select(id: String?, tab: WorkflowTab = WorkflowTab.Instructions) {
        val previousSelection = selected
        val newSelection = previousSelection != id
        if (!newSelection && this.tab == tab) return
        if (
            newSelection &&
                previousSelection != null &&
                mutable.value.toggles.values.any { it.phase == WorkflowTogglePhase.Submitting }
        ) {
            // A receipt can arrive while this workflow is no longer selected.
            invalidateCachedDetail(previousSelection)
        }
        selected = id
        this.tab = tab
        cancelHistoryRead()
        if (newSelection) cancelDetailRead()
        val now = monotonicMillis()
        val cached = id?.let(details::get)
        val history = id?.let(histories::get)?.takeIf { tab == WorkflowTab.History }
        val current = mutable.value
        mutable.value =
            current.copy(
                detail =
                    if (newSelection)
                        cached?.takeIf { it.readAt.isFreshMemorySnapshot(now) }?.detail
                    else current.detail,
                history = history?.takeIf { it.readAt.isFreshMemorySnapshot(now) }?.page,
                detailFailure = current.detailFailure.takeUnless { newSelection },
                historyFailure = null,
                toggles = if (newSelection) emptyMap() else current.toggles,
                issue = current.issue.takeUnless { newSelection },
                editing = current.editing.takeUnless { newSelection },
            )
        if (id == null) {
            if (visible) presentCachedRanges()
            refresh(directoryScopes)
        } else {
            refresh(
                when (tab) {
                    WorkflowTab.Instructions -> setOf(WorkflowReadScope.Detail)
                    WorkflowTab.Automations ->
                        setOf(WorkflowReadScope.Detail, WorkflowReadScope.Connections)
                    WorkflowTab.History ->
                        setOf(WorkflowReadScope.Detail, WorkflowReadScope.History)
                },
            )
        }
    }

    private fun presentCachedRanges() {
        val current = mutable.value
        val now = monotonicMillis()
        val catalog =
            current.catalog.takeIf {
                searchingCatalog || catalogRead.readAt.isFreshMemorySnapshot(now)
            }
        val rules = current.rules.takeIf { rulesRead.readAt.isFreshMemorySnapshot(now) }
        val connections =
            current.connections.takeIf { connectionsRead.readAt.isFreshMemorySnapshot(now) }
        val detail = selected?.let {
            details[it]?.takeIf { entry -> entry.readAt.isFreshMemorySnapshot(now) }?.detail
        }
        val history =
            selected
                ?.let(histories::get)
                ?.takeIf { tab == WorkflowTab.History && it.readAt.isFreshMemorySnapshot(now) }
                ?.page
        mutable.value =
            current.copy(
                catalog = catalog,
                rules = rules,
                connections = connections,
                detail = detail,
                history = history,
                catalogFailure = current.catalogFailure.takeIf { catalog != null },
                rulesFailure = current.rulesFailure.takeIf { rules != null },
                connectionsFailure = current.connectionsFailure.takeIf { connections != null },
                detailFailure = current.detailFailure.takeIf { detail != null },
                historyFailure = current.historyFailure.takeIf { history != null },
            )
    }

    private fun refresh(scopes: Set<WorkflowReadScope> = allReadScopes) {
        if (!authorized() || !foreground || !visible && !searchingCatalog) return
        val activeScopes =
            if (visible) scopes
            else if (WorkflowReadScope.Catalog in scopes) catalogScope else return
        if (mutable.value.writing) {
            readsAfterWrite.addAll(activeScopes)
            return
        }
        for (scope in activeScopes) when (scope) {
            WorkflowReadScope.Detail -> selected?.let(::loadDetail)
            WorkflowReadScope.History ->
                if (tab == WorkflowTab.History) {
                    selected?.let { id ->
                        val current = mutable.value
                        val cursor =
                            current.history?.nextCursor.takeIf {
                                current.historyRead == WorkflowHistoryRead.EarlierPaused
                            }
                        loadHistory(id, cursor)
                    }
                }
            WorkflowReadScope.Catalog -> loadCatalog()
            WorkflowReadScope.Rules -> loadDirectoryRules()
            WorkflowReadScope.Connections -> loadConnections()
        }
    }

    private fun loadCatalog() {
        refreshRange(
            catalogRead,
            started = {
                val current = mutable.value
                mutable.value =
                    current.copy(
                        catalogStartedAt = readClock.markNow(),
                        catalogFailure =
                            current.catalogFailure.whileReading(current.catalog != null),
                    )
            },
            fetch = { service.workflows().filter { it.official == null } },
            receive = ::publishCatalog,
            denied = ::clearAccess,
            failure = {
                mutable.value = mutable.value.copy(catalogStartedAt = null, catalogFailure = it)
            },
        )
    }

    private fun loadDirectoryRules() {
        refreshRange(
            rulesRead,
            fetch = {
                service.workflowAutomations().groupBy({ it.workflow.id }, { it.automation })
            },
            receive = ::publishDirectoryRules,
            denied = {
                mutable.value =
                    mutable.value.copy(rules = null, rulesFailure = WorkflowReadFailure.Unavailable)
            },
            failure = { mutable.value = mutable.value.copy(rulesFailure = it) },
        )
    }

    private fun loadConnections() {
        refreshRange(
            connectionsRead,
            fetch = service::workflowConnections,
            receive = { connections, _ ->
                mutable.value =
                    mutable.value.copy(connections = connections, connectionsFailure = null)
            },
            denied = {
                mutable.value =
                    mutable.value.copy(
                        connections = null,
                        connectionsFailure = WorkflowReadFailure.Unavailable,
                    )
            },
            failure = { mutable.value = mutable.value.copy(connectionsFailure = it) },
        )
    }

    private fun <T> refreshRange(
        range: WorkflowRangeRead,
        started: () -> Unit = {},
        fetch: suspend () -> T,
        receive: (T, Map<String, WorkflowDirectoryUpdate?>) -> Unit,
        denied: () -> Unit,
        failure: (WorkflowReadFailure) -> Unit,
    ) {
        if (range.job?.isActive == true) return
        range.job = viewModelScope.launch {
            started()
            retryReads(failure) {
                val attempt = WorkflowRangeAttempt(++readSequence)
                range.pending = attempt
                val result =
                    try {
                        read(fetch)
                    } finally {
                        if (range.pending === attempt) range.pending = null
                    }
                if (!authorized()) return@retryReads null
                val error = result.exceptionOrNull()
                when {
                    error.denied() -> {
                        range.receipt = null
                        denied()
                        null
                    }
                    error != null -> error
                    else -> {
                        range.receipt = WorkflowReadReceipt(attempt.sequence, monotonicMillis())
                        receive(result.getOrThrow(), attempt.updates)
                        null
                    }
                }
            }
        }
    }

    private fun publishCatalog(
        directory: List<WorkflowSummary>,
        updates: Map<String, WorkflowDirectoryUpdate?>,
    ) {
        val rows =
            if (updates.isEmpty()) directory
            else
                directory.mapNotNull { row ->
                    if (row.id in updates) updates[row.id]?.applyTo(row) else row
                }
        val summaries = rows.associateBy(WorkflowSummary::id)
        val current = mutable.value
        val previouslyKnown = current.catalog.orEmpty().mapTo(mutableSetOf()) { it.id }
        previouslyKnown.addAll(details.keys)
        previouslyKnown.addAll(histories.keys)
        selected?.let(previouslyKnown::add)
        val removed = previouslyKnown.filter { it !in summaries && updates[it] == null }
        for (id in removed) {
            details.remove(id)
            histories.remove(id)
            rulesRead.pending?.updates?.set(id, null)
        }
        details.replaceAll { id, cached ->
            val summary = summaries[id]
            if (summary == null) cached
            else cached.copy(detail = cached.detail.withSummary(summary))
        }
        val lostSelected = selected?.let(removed::contains) == true
        if (lostSelected) {
            cancelDetailRead()
            cancelHistoryRead()
        }
        val detail = current.detail?.let { details[it.id]?.detail }
        mutable.value =
            current.copy(
                catalog = rows,
                catalogStartedAt = null,
                catalogFailure = null,
                rules = if (removed.isEmpty()) current.rules else current.rules?.minus(removed),
                detail = detail,
                detailReadStart = current.detailReadStart.takeUnless { lostSelected },
                history = current.history.takeUnless { lostSelected },
                historyRead = current.historyRead.takeUnless { lostSelected },
                historyReadStart = current.historyReadStart.takeUnless { lostSelected },
                historyFailure = current.historyFailure.takeUnless { lostSelected },
                detailFailure =
                    if (lostSelected) WorkflowReadFailure.Unavailable else current.detailFailure,
                editing = current.editingFor(detail),
                toggles = if (lostSelected) emptyMap() else current.toggles,
                issue = current.issue.takeUnless { lostSelected },
            )
    }

    private fun publishDirectoryRules(
        directory: Map<String, List<WorkflowAutomation>>,
        updates: Map<String, WorkflowDirectoryUpdate?>,
    ) {
        val confirmed = directory.withDirectoryUpdates(updates)
        // The detail and directory endpoints include the same caller-owned rules.
        details.replaceAll { id, cached ->
            val detail = cached.detail.withRules(confirmed[id].orEmpty())
            if (cached.detail === detail) cached else cached.copy(detail = detail)
        }
        val current = mutable.value
        val detail = current.detail?.let { details[it.id]?.detail }
        mutable.value =
            current.copy(
                rules = confirmed,
                rulesFailure = null,
                detail = detail,
                editing = current.editingFor(detail),
            )
    }

    private fun clearAccess() {
        catalogRead.invalidate()
        rulesRead.invalidate()
        connectionsRead.invalidate()
        cancelDetailRead()
        cancelHistoryRead()
        details.clear()
        histories.clear()
        mutable.value =
            mutable.value.copy(
                catalog = null,
                catalogStartedAt = null,
                rules = null,
                connections = null,
                detail = null,
                history = null,
                historyFailure = null,
                catalogFailure = WorkflowReadFailure.Unavailable,
                rulesFailure = null,
                connectionsFailure = null,
                detailFailure = WorkflowReadFailure.Unavailable,
                toggles = emptyMap(),
                editing = null,
                issue = null,
            )
    }

    private fun loadDetail(id: String) {
        if (detailLoad?.isActive == true) return
        val state = mutable.value
        val restoringAccess = state.detailFailure == WorkflowReadFailure.Unavailable
        val failure = state.detailFailure.whileReading(state.detail != null)
        if (
            failure != state.detailFailure ||
                state.toggles.any { it.value.phase == WorkflowTogglePhase.Unconfirmed }
        ) {
            mutable.value =
                state.copy(
                    detailFailure = failure,
                    toggles =
                        state.toggles.mapValues { (_, toggle) ->
                            if (toggle.phase == WorkflowTogglePhase.Unconfirmed)
                                toggle.copy(phase = WorkflowTogglePhase.Checking)
                            else toggle
                        },
                )
        }
        detailLoad = viewModelScope.launch {
            mutable.value =
                mutable.value.copy(detailReadStart = WorkflowReadStart(id, readClock.markNow()))
            retryReads(::publishDetailFailure) {
                val sequence = ++readSequence
                val response = read {
                    service.workflow(id).also {
                        if (it.id != id) throw ApiFailure.IncompatibleResponse()
                    }
                }
                if (!authorized() || selected != id) return@retryReads null
                val detail = response.getOrNull()
                val error = response.exceptionOrNull()
                when {
                    error.denied() ||
                        (error as? ApiFailure.Http)?.status == 404 ||
                        detail?.official != null -> {
                        recordDetailUpdate(id, null, sequence)
                        details.remove(id)
                        histories.remove(id)
                        cancelHistoryRead()
                        val current = mutable.value
                        mutable.value =
                            current.copy(
                                catalog = current.catalog?.filterNot { it.id == id },
                                rules = current.rules?.minus(id),
                                detail = null,
                                history = null,
                                historyFailure = null,
                                detailFailure = WorkflowReadFailure.Unavailable,
                                editing = null,
                                toggles = emptyMap(),
                                issue = null,
                            )
                        null
                    }
                    detail != null -> {
                        publishDetail(detail, sequence)
                        if (restoringAccess && mutable.value.history == null)
                            refresh(setOf(WorkflowReadScope.History))
                        null
                    }
                    else -> error
                }
            }
            if (isActive) mutable.value = mutable.value.copy(detailReadStart = null)
        }
    }

    private fun publishDetailFailure(failure: WorkflowReadFailure) {
        val current = mutable.value
        mutable.value =
            current.copy(
                detailFailure = failure,
                toggles =
                    current.toggles.mapValues { (_, toggle) ->
                        if (toggle.phase == WorkflowTogglePhase.Checking)
                            toggle.copy(phase = WorkflowTogglePhase.Unconfirmed)
                        else toggle
                    },
            )
    }

    internal fun loadEarlierRuns() {
        if (!authorized() || !visible || !foreground || tab != WorkflowTab.History) return
        val id = selected ?: return
        val cursor = mutable.value.history?.nextCursor ?: return
        loadHistory(id, cursor)
    }

    private fun loadHistory(id: String, cursor: String?) {
        if (
            historyLoad?.isActive == true ||
                mutable.value.detailFailure == WorkflowReadFailure.Unavailable
        )
            return
        val cached = histories[id]
        val current = mutable.value
        val earlier = cursor != null
        mutable.value =
            current.copy(
                historyRead =
                    if (earlier) WorkflowHistoryRead.Earlier else WorkflowHistoryRead.Latest,
                historyFailure =
                    current.historyFailure.whileReading(current.history != null).takeIf {
                        (current.historyRead?.earlier == true) == earlier
                    },
            )
        historyLoad = viewModelScope.launch {
            if (!earlier) {
                mutable.value =
                    mutable.value.copy(
                        historyReadStart = WorkflowReadStart(id, readClock.markNow()),
                    )
            }
            try {
                retryReads({ mutable.value = mutable.value.copy(historyFailure = it) }) {
                    val response = read {
                        // Revalidate through the previous oldest row. Newer runs can push that
                        // row past the previous page boundary while the user's position
                        // remains.
                        val previous = if (cursor == null) cached?.page else null
                        fetchHistory(id, cursor, previous)
                    }
                    if (!authorized() || selected != id || tab != WorkflowTab.History)
                        return@retryReads null
                    val error = response.exceptionOrNull()
                    if (error.denied() || (error as? ApiFailure.Http)?.status == 404) {
                        histories.remove(id)
                        mutable.value =
                            mutable.value.copy(
                                history = null,
                                historyFailure = WorkflowReadFailure.Unavailable,
                            )
                        return@retryReads null
                    }
                    if (error != null) return@retryReads error
                    val page = response.getOrThrow()
                    val entry =
                        if (cursor == null || cached == null) {
                            CachedWorkflowHistory(page, monotonicMillis())
                        } else {
                            cached.copy(
                                page =
                                    page.copy(
                                        runs = (cached.page.runs + page.runs).distinctBy { it.id },
                                    ),
                            )
                        }
                    histories[id] = entry
                    if (histories.size > WORKFLOW_DETAIL_CACHE_CAPACITY)
                        histories.remove(histories.keys.first())
                    mutable.value = mutable.value.copy(history = entry.page, historyFailure = null)
                    null
                }
            } finally {
                if (isActive) {
                    val current = mutable.value
                    val paused =
                        WorkflowHistoryRead.EarlierPaused.takeIf {
                            earlier && current.history != null && current.historyFailure != null
                        }
                    mutable.value = current.copy(historyRead = paused, historyReadStart = null)
                }
            }
        }
    }

    private suspend fun fetchHistory(
        id: String,
        cursor: String?,
        previous: WorkflowRunHistory?,
    ): WorkflowRunHistory {
        val oldest = previous?.runs?.lastOrNull()
        val earlierCursor = previous?.nextCursor
        val runs = mutableListOf<WorkflowRunHistoryEntry>()
        val visited = mutableSetOf<String?>()
        var before = cursor
        while (visited.add(before)) {
            val page = service.workflowRunHistory(id, before)
            val oldestIndex =
                oldest?.let { run -> page.runs.indexOfFirst { it.id == run.id } } ?: -1
            if (earlierCursor != null && oldestIndex in 0 until page.runs.lastIndex) {
                // The original cursor still points past this row. Leave the rest for Load earlier.
                runs.addAll(page.runs.take(oldestIndex + 1))
                return WorkflowRunHistory(runs.distinctBy { it.id }, earlierCursor)
            }
            runs.addAll(page.runs)
            if (
                oldest == null ||
                    page.nextCursor == null ||
                    oldestIndex >= 0 ||
                    page.runs.lastOrNull()?.let { it.createdAt < oldest.createdAt } == true
            ) {
                return page.copy(runs = runs.distinctBy { it.id })
            }
            before = page.nextCursor
        }
        throw ApiFailure.IncompatibleResponse()
    }

    private suspend fun retryReads(
        publishFailure: (WorkflowReadFailure) -> Unit,
        attempt: suspend () -> Throwable?,
    ) {
        retryBoundedRead(canRead = authorized, attempt = attempt) ?: return
        publishFailure(WorkflowReadFailure.Failed(++readSequence))
    }

    internal fun edit(value: WorkflowEdit?) {
        val state = mutable.value
        if (!authorized() || state.writing) return
        val editor = value?.let {
            val detail = state.detail ?: return
            // A user action can arrive from the frame before the confirmed values changed.
            it.updateConfirmed(detail, keepInput = state.editor != null || it.changed) ?: return
        }
        val issue =
            state.issue?.takeIf {
                editor != null &&
                    state.editing != null &&
                    (it.failure == WorkflowWriteFailure.UncertainCreate ||
                        it.failure == WorkflowWriteFailure.Network)
            }
        val editing =
            when (editor) {
                is WorkflowEdit.Instructions -> WorkflowEditSession.Instructions(editor)
                is WorkflowEdit.Rule -> WorkflowEditSession.Rule(editor)
                null -> null
            }
        mutable.value = state.copy(editing = editing, issue = issue)
    }

    internal fun canEdit(editing: WorkflowEditSession): Boolean {
        val state = mutable.value
        return state.editing === editing &&
            !state.writing &&
            authorized() &&
            state.detail?.canEdit(editing.draft) == true
    }

    internal fun editRuleOptions(
        editing: WorkflowEditSession.Rule,
        change: (WorkflowEdit.Rule) -> WorkflowEdit.Rule,
    ) {
        if (canEdit(editing)) editing.editOptions(change)
    }

    internal fun clearRejectedEdit(editing: WorkflowEditSession, issue: WorkflowWriteIssue) {
        val current = mutable.value
        if (current.editing === editing && current.issue === issue)
            mutable.value = current.copy(issue = null)
    }

    internal fun toggle(rule: WorkflowAutomation) {
        val state = mutable.value
        val confirmed = state.detail?.automations?.firstOrNull { it.id == rule.id } ?: return
        if (confirmed.enabled != rule.enabled) return
        if (!confirmed.enabled && !confirmed.canEnable(state.connections)) return
        val enabled = !confirmed.enabled
        changeRule(rule.id, toggleTo = enabled) { service.setAutomationEnabled(rule.id, enabled) }
    }

    internal fun save(editor: WorkflowEdit) {
        val state = mutable.value
        val detail = state.detail ?: return
        if (
            state.editor != editor ||
                !editor.canSave ||
                state.issue?.failure == WorkflowWriteFailure.UncertainCreate
        )
            return
        when (editor) {
            is WorkflowEdit.Instructions ->
                mutate { before ->
                    val confirmed = service.updateWorkflow(before.id, editor.updateRequest())
                    if (confirmed.id != before.id) throw ApiFailure.IncompatibleResponse()
                    publishDetail(confirmed)
                }
            is WorkflowEdit.Rule -> {
                if (editor.blockingConnection(detail, state.connections) == null) saveRule(editor)
            }
        }
    }

    private fun saveRule(editor: WorkflowEdit.Rule) {
        val id = editor.id
        if (id == null) {
            mutate(creating = true) { detail ->
                val added = service.createAutomation(detail.id, editor.value.createRequest())
                publishRules(detail, detail.automations + added)
            }
        } else {
            changeRule(id) { service.updateAutomation(id, editor.value.updateRequest()) }
        }
    }

    private fun changeRule(
        id: String,
        toggleTo: Boolean? = null,
        change: suspend () -> WorkflowAutomation,
    ) =
        mutate(ruleId = id, toggleTo = toggleTo) { detail ->
            val confirmed = change()
            if (confirmed.id != id || toggleTo != null && confirmed.enabled != toggleTo)
                throw ApiFailure.IncompatibleResponse()
            publishRules(detail, detail.automations.map { if (it.id == id) confirmed else it })
        }

    private fun mutate(
        creating: Boolean = false,
        ruleId: String? = null,
        toggleTo: Boolean? = null,
        action: suspend (WorkflowDetail) -> Unit,
    ) {
        val state = mutable.value
        val detail = state.detail ?: return
        if (!authorized() || !visible || !foreground || state.writing || detail.id != selected)
            return
        if (ruleId != null && state.toggles[ruleId]?.phase?.needsReadback == true) return
        val permitted =
            when {
                creating -> detail.canAddAutomation
                ruleId != null -> detail.canManageAutomation(ruleId)
                else -> detail.canManage
            }
        if (!permitted) {
            if (ruleId != null)
                mutable.value =
                    state.copy(issue = WorkflowWriteIssue(WorkflowWriteFailure.Failed, ruleId))
            return
        }
        if (catalogRead.job?.isActive == true) readsAfterWrite.add(WorkflowReadScope.Catalog)
        if (rulesRead.job?.isActive == true) readsAfterWrite.add(WorkflowReadScope.Rules)
        if (detailLoad?.isActive == true) readsAfterWrite.add(WorkflowReadScope.Detail)
        stopWorkflowReads()
        val toggles =
            when {
                ruleId != null && toggleTo != null ->
                    state.toggles +
                        (ruleId to WorkflowToggle(toggleTo, WorkflowTogglePhase.Submitting))
                ruleId != null && ruleId in state.toggles -> state.toggles - ruleId
                else -> state.toggles
            }
        val submittedDraft = state.editor.takeIf { toggleTo == null }
        mutable.value = mutable.value.copy(writing = true, toggles = toggles, issue = null)
        viewModelScope.launch {
            try {
                // await cancellation / scope checks before publishing from a retired session.
                action(detail)
                if (authorized() && selected == detail.id)
                    mutable.value = mutable.value.copy(editing = null)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (authorized() && selected == detail.id) {
                    reportSessionFailure(error)
                    val status = (error as? ApiFailure.Http)?.status
                    val current = mutable.value
                    if (ruleId != null && toggleTo != null && error.toggleOutcomeUnknown()) {
                        // Keep the displayed detail. Reentering it must read before toggling again.
                        invalidateCachedDetail(detail.id)
                        mutable.value =
                            current.copy(
                                toggles =
                                    current.toggles +
                                        (ruleId to
                                            WorkflowToggle(
                                                toggleTo,
                                                WorkflowTogglePhase.Checking,
                                            )),
                            )
                    } else {
                        val failure =
                            when {
                                creating && (status == null || status >= 500) ->
                                    WorkflowWriteFailure.UncertainCreate
                                error is ApiFailure.Network -> WorkflowWriteFailure.Network
                                !creating && ruleId == null && status == 409 ->
                                    WorkflowWriteFailure.Conflict
                                else -> WorkflowWriteFailure.Failed
                            }
                        val rejectedDraft = submittedDraft.takeIf {
                            failure == WorkflowWriteFailure.Failed ||
                                failure == WorkflowWriteFailure.Conflict
                        }
                        mutable.value =
                            current.copy(issue = WorkflowWriteIssue(failure, ruleId, rejectedDraft))
                    }
                    readsAfterWrite.add(WorkflowReadScope.Detail)
                }
            } finally {
                if (authorized()) {
                    val current = mutable.value
                    mutable.value =
                        current.copy(
                            writing = false,
                            toggles =
                                if (
                                    ruleId != null &&
                                        current.toggles[ruleId]?.phase ==
                                            WorkflowTogglePhase.Submitting
                                )
                                    current.toggles - ruleId
                                else current.toggles,
                        )
                    val pending = readsAfterWrite.toSet()
                    readsAfterWrite.clear()
                    refresh(pending)
                }
            }
        }
    }

    private fun publishDetail(
        response: WorkflowDetail,
        sequence: Long = ++readSequence,
        confirmsToggles: Boolean = true,
    ) {
        val id = response.id
        if (!authorized() || selected != id) return
        val current = mutable.value
        // This screen does not use the attached file bodies returned by GET.
        var detail =
            if (response.fileContents == null) response else response.copy(fileContents = null)
        // A late detail response can still supply its own fields, while shared fields use a
        // subsequently started read that has already been confirmed.
        if (catalogRead.isNewerThan(sequence)) {
            current.catalog?.firstOrNull { it.id == id }?.let { detail = detail.withSummary(it) }
        }
        if (rulesRead.isNewerThan(sequence) && current.rules != null) {
            detail = detail.withRules(current.rules[id].orEmpty())
        }
        val toggles =
            if (confirmsToggles && current.toggles.any { it.value.phase.needsReadback }) {
                current.toggles
                    .mapNotNull { (ruleId, toggle) ->
                        val rule = detail.automations.firstOrNull { it.id == ruleId }
                        when {
                            !toggle.phase.needsReadback -> ruleId to toggle
                            rule == null || rule.enabled == toggle.enabled -> null
                            else -> ruleId to toggle.copy(phase = WorkflowTogglePhase.Failed)
                        }
                    }
                    .toMap()
            } else current.toggles
        val readAt = monotonicMillis().takeUnless { toggles.any { it.value.phase.needsReadback } }
        details[id] = CachedWorkflowDetail(detail, readAt)
        if (details.size > WORKFLOW_DETAIL_CACHE_CAPACITY) details.remove(details.keys.first())
        val update = WorkflowDirectoryUpdate(detail)
        // The directory read may complete after the user has left this detail.
        recordDetailUpdate(id, update, sequence)
        val rules =
            current.rules?.let { previous ->
                when {
                    previous[id].orEmpty() == detail.automations -> previous
                    detail.automations.isEmpty() -> previous - id
                    else -> previous + (id to detail.automations)
                }
            }
        mutable.value =
            current.copy(
                detail = detail,
                editing = current.editingFor(detail),
                detailFailure = null,
                toggles = toggles,
                catalog =
                    current.catalog?.map { item ->
                        if (item.id == detail.id) update.applyTo(item) else item
                    },
                rules = rules,
            )
    }

    private fun publishRules(detail: WorkflowDetail, rules: List<WorkflowAutomation>) =
        publishDetail(detail.copy(automations = rules), confirmsToggles = false)

    private fun recordDetailUpdate(id: String, detail: WorkflowDirectoryUpdate?, sequence: Long) {
        catalogRead.pending?.record(id, detail, sequence)
        rulesRead.pending?.record(id, detail, sequence)
    }

    private suspend fun <T> read(block: suspend () -> T): Result<T> =
        try {
            val value = block()
            currentCoroutineContext().ensureActive()
            Result.success(value)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            currentCoroutineContext().ensureActive()
            if (authorized()) reportSessionFailure(error)
            Result.failure(error)
        }

    private fun reportSessionFailure(error: Exception) {
        if (
            error is ApiFailure.Unauthenticated ||
                error is ApiFailure.UpdateRequired ||
                error is ApiFailure.Http && error.status == 401
        )
            onFailure(error)
    }
}

private data class CachedWorkflowDetail(val detail: WorkflowDetail, val readAt: Long?)

private data class CachedWorkflowHistory(val page: WorkflowRunHistory, val readAt: Long)

private enum class WorkflowReadScope {
    Detail,
    History,
    Catalog,
    Rules,
    Connections,
}

private val directoryScopes =
    setOf(WorkflowReadScope.Catalog, WorkflowReadScope.Rules, WorkflowReadScope.Connections)
private val catalogScope = setOf(WorkflowReadScope.Catalog)
private val allReadScopes = WorkflowReadScope.entries.toSet()

private class WorkflowRangeRead {
    var receipt: WorkflowReadReceipt? = null
    val readAt: Long?
        get() = receipt?.completedAt

    var job: Job? = null
    var pending: WorkflowRangeAttempt? = null

    fun isNewerThan(sequence: Long): Boolean = (receipt?.sequence ?: 0L) > sequence

    fun cancel() {
        job?.cancel()
        job = null
        pending = null
    }

    fun invalidate() {
        cancel()
        receipt = null
    }
}

private data class WorkflowReadReceipt(val sequence: Long, val completedAt: Long)

private class WorkflowRangeAttempt(val sequence: Long) {
    val updates = mutableMapOf<String, WorkflowDirectoryUpdate?>()

    fun record(id: String, update: WorkflowDirectoryUpdate?, fromSequence: Long) {
        // A confirmed loss of access also removes the workflow from this in-flight result.
        if (update == null || fromSequence > sequence) updates[id] = update
    }
}

private const val WORKFLOW_DETAIL_CACHE_CAPACITY = 8

private class WorkflowDirectoryUpdate(detail: WorkflowDetail) {
    private val name = detail.name
    private val displayName = detail.displayName
    private val description = detail.description
    private val canManage = detail.canManage
    private val shadowedBy =
        detail.shadowedBy?.let { WorkflowSummaryShadowedBy(it.id, it.name, it.displayName) }
    private val visibility =
        when (detail.visibility) {
            WorkflowDetailVisibility.PUBLIC -> WorkflowSummaryVisibility.PUBLIC
            WorkflowDetailVisibility.PRIVATE -> WorkflowSummaryVisibility.PRIVATE
        }
    val automations = detail.automations

    fun applyTo(row: WorkflowSummary): WorkflowSummary =
        row.copy(
            name = name,
            displayName = displayName,
            description = description,
            canManage = canManage,
            visibility = visibility,
            shadowedBy = shadowedBy,
        )
}

private fun WorkflowDetail.withSummary(summary: WorkflowSummary): WorkflowDetail =
    copy(
        name = summary.name,
        displayName = summary.displayName,
        description = summary.description,
        canManage = summary.canManage,
        visibility =
            when (summary.visibility) {
                WorkflowSummaryVisibility.PUBLIC -> WorkflowDetailVisibility.PUBLIC
                WorkflowSummaryVisibility.PRIVATE -> WorkflowDetailVisibility.PRIVATE
            },
        shadowedBy =
            summary.shadowedBy?.let { WorkflowDetailShadowedBy(it.id, it.name, it.displayName) },
    )

private fun WorkflowDetail.withRules(rules: List<WorkflowAutomation>): WorkflowDetail =
    if (automations == rules) this else copy(automations = rules)

private fun Map<String, List<WorkflowAutomation>>.withDirectoryUpdates(
    updates: Map<String, WorkflowDirectoryUpdate?>,
): Map<String, List<WorkflowAutomation>> {
    if (updates.all { (id, update) -> this[id].orEmpty() == update?.automations.orEmpty() })
        return this
    return toMutableMap().apply {
        for ((id, update) in updates) {
            val rules = update?.automations.orEmpty()
            if (rules.isEmpty()) remove(id) else put(id, rules)
        }
    }
}

private fun Throwable?.denied() =
    this is ApiFailure.Unauthenticated ||
        this is ApiFailure.Http && (status == 401 || status == 403)

private fun Exception.toggleOutcomeUnknown(): Boolean =
    when (this) {
        is ApiFailure.Network -> !connectionFailed
        is ApiFailure.IncompatibleResponse -> true
        is ApiFailure.Http -> status == 408 || status in 500..599
        else -> false
    }
