package ai.okou.android.workflows

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
import ai.okou.android.state.WorkflowTab
import android.os.SystemClock
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

internal data class WorkflowState(
    val catalog: List<WorkflowSummary>? = null,
    val rules: Map<String, List<WorkflowAutomation>>? = null,
    val connections: Set<String>? = null,
    val detail: WorkflowDetail? = null,
    val history: WorkflowRunHistory? = null,
    val catalogFailure: WorkflowReadFailure? = null,
    val rulesFailure: WorkflowReadFailure? = null,
    val connectionsFailure: WorkflowReadFailure? = null,
    val detailFailure: WorkflowReadFailure? = null,
    val historyFailure: WorkflowReadFailure? = null,
    val historyRead: WorkflowHistoryRead? = null,
    val writing: Boolean = false,
    val issue: WorkflowWriteIssue? = null,
    val editor: WorkflowEdit? = null,
)

internal enum class WorkflowHistoryRead {
    Latest,
    Earlier,
}

internal enum class WorkflowReadFailure {
    Unavailable,
    Offline,
    CouldNotLoad,
    RefreshFailed,
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
)

/** Confirmed data belongs to the authorized workspace and survives leaving the destination. */
class WorkflowModel
internal constructor(
    private val service: WorkflowService,
    private val authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
    private val monotonicMillis: () -> Long = SystemClock::elapsedRealtime,
) : ViewModel() {
    private val mutable = MutableStateFlow(WorkflowState())
    internal val state = mutable.asStateFlow()
    private var visible = false
    private var foreground = false
    private var offline = false
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

    internal fun connectivityChanged(offline: Boolean) {
        if (this.offline == offline) return
        this.offline = offline
        if (!offline) {
            val current = mutable.value
            if (current.catalogFailure.canRecheckOnReconnect()) catalogRead.cancel()
            if (current.rulesFailure.canRecheckOnReconnect()) rulesRead.cancel()
            if (current.connectionsFailure.canRecheckOnReconnect()) connectionsRead.cancel()
            if (current.detailFailure.canRecheckOnReconnect()) cancelDetailRead()
            if (current.historyFailure.canRecheckOnReconnect()) cancelHistoryRead()
            mutable.value =
                current.copy(
                    catalogFailure =
                        current.catalogFailure.takeUnless { it == WorkflowReadFailure.Offline },
                    rulesFailure =
                        current.rulesFailure.takeUnless { it == WorkflowReadFailure.Offline },
                    connectionsFailure =
                        current.connectionsFailure.takeUnless { it == WorkflowReadFailure.Offline },
                    detailFailure =
                        current.detailFailure.takeUnless { it == WorkflowReadFailure.Offline },
                    historyFailure =
                        current.historyFailure.takeUnless { it == WorkflowReadFailure.Offline },
                    historyRead = mutable.value.historyRead,
                    issue = current.issue.takeUnless { it?.failure == WorkflowWriteFailure.Network },
                )
            val now = monotonicMillis()
            refresh(
                buildSet {
                    if (
                        !catalogRead.readAt.isFresh(now) ||
                            current.catalogFailure.canRecheckOnReconnect()
                    )
                        add(WorkflowReadScope.Catalog)
                    if (
                        !rulesRead.readAt.isFresh(now) ||
                            current.rulesFailure.canRecheckOnReconnect()
                    )
                        add(WorkflowReadScope.Rules)
                    if (
                        !connectionsRead.readAt.isFresh(now) ||
                            current.connectionsFailure.canRecheckOnReconnect()
                    )
                        add(WorkflowReadScope.Connections)
                    if (
                        !selected?.let { details[it]?.readAt }.isFresh(now) ||
                            current.detailFailure.canRecheckOnReconnect()
                    )
                        add(WorkflowReadScope.Detail)
                    if (
                        !selected?.let { histories[it]?.readAt }.isFresh(now) ||
                            current.historyFailure.canRecheckOnReconnect()
                    )
                        add(WorkflowReadScope.History)
                }
            )
        }
    }

    internal fun visibilityChanged(open: Boolean) {
        if (visible == open) return
        visible = open
        if (open) {
            presentCachedRanges()
            refresh()
        } else stopReads()
    }

    internal fun foregroundChanged(resumed: Boolean) {
        if (foreground == resumed) return
        foreground = resumed
        // Foreground changes retain the current visit, including the active editor.
        if (resumed) refresh() else stopReads()
    }

    private fun stopReads() {
        stopWorkflowReads()
        cancelHistoryRead()
        connectionsRead.cancel()
    }

    private fun stopWorkflowReads() {
        catalogRead.cancel()
        rulesRead.cancel()
        cancelDetailRead()
    }

    private fun cancelDetailRead() {
        detailLoad?.cancel()
        detailLoad = null
    }

    private fun cancelHistoryRead() {
        historyLoad?.cancel()
        historyLoad = null
        if (mutable.value.historyRead != null)
            mutable.value = mutable.value.copy(historyRead = null)
    }

    internal fun select(id: String?, tab: WorkflowTab = WorkflowTab.Instructions) {
        val newSelection = selected != id
        if (!newSelection && this.tab == tab) return
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
                    if (newSelection) cached?.takeIf { it.readAt.isFresh(now) }?.detail
                    else current.detail,
                history = history?.takeIf { it.readAt.isFresh(now) }?.page,
                detailFailure = current.detailFailure.takeUnless { newSelection },
                historyFailure = null,
                issue = current.issue.takeUnless { newSelection },
                editor = current.editor.takeUnless { newSelection },
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
                }
            )
        }
    }

    private fun presentCachedRanges() {
        val current = mutable.value
        val now = monotonicMillis()
        val catalog = current.catalog.takeIf { catalogRead.readAt.isFresh(now) }
        val rules = current.rules.takeIf { rulesRead.readAt.isFresh(now) }
        val connections = current.connections.takeIf { connectionsRead.readAt.isFresh(now) }
        val detail =
            selected?.let { details[it]?.takeIf { entry -> entry.readAt.isFresh(now) }?.detail }
        val history =
            selected
                ?.let(histories::get)
                ?.takeIf { tab == WorkflowTab.History && it.readAt.isFresh(now) }
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
        if (!authorized() || !visible || !foreground) return
        if (mutable.value.writing) {
            readsAfterWrite.addAll(scopes)
            return
        }
        for (scope in scopes) when (scope) {
            WorkflowReadScope.Detail -> selected?.let(::loadDetail)
            WorkflowReadScope.History ->
                if (tab == WorkflowTab.History) selected?.let { loadHistory(it, null) }
            WorkflowReadScope.Catalog -> loadCatalog()
            WorkflowReadScope.Rules -> loadDirectoryRules()
            WorkflowReadScope.Connections -> loadConnections()
        }
    }

    private fun loadCatalog() {
        refreshRange(
            catalogRead,
            fetch = { service.workflows().filter { it.official == null } },
            receive = ::publishCatalog,
            denied = ::clearAccess,
            failure = { mutable.value = mutable.value.copy(catalogFailure = it) },
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
        fetch: suspend () -> T,
        receive: (T, Map<String, WorkflowDirectoryUpdate?>) -> Unit,
        denied: () -> Unit,
        failure: (WorkflowReadFailure) -> Unit,
    ) {
        if (range.job?.isActive == true) return
        range.job =
            viewModelScope.launch {
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
        mutable.value =
            current.copy(
                catalog = rows,
                catalogFailure = null,
                rules = if (removed.isEmpty()) current.rules else current.rules?.minus(removed),
                detail = current.detail?.let { details[it.id]?.detail },
                history = current.history.takeUnless { lostSelected },
                historyRead = current.historyRead.takeUnless { lostSelected },
                historyFailure = current.historyFailure.takeUnless { lostSelected },
                detailFailure =
                    if (lostSelected) WorkflowReadFailure.Unavailable else current.detailFailure,
                editor = current.editor.takeUnless { lostSelected },
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
        mutable.value =
            current.copy(
                rules = confirmed,
                rulesFailure = null,
                detail = current.detail?.let { details[it.id]?.detail },
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
                rules = null,
                connections = null,
                detail = null,
                history = null,
                historyFailure = null,
                catalogFailure = WorkflowReadFailure.Unavailable,
                rulesFailure = null,
                connectionsFailure = null,
                detailFailure = WorkflowReadFailure.Unavailable,
                editor = null,
                issue = null,
            )
    }

    private fun loadDetail(id: String) {
        if (detailLoad?.isActive == true) return
        detailLoad =
            viewModelScope.launch {
                retryReads({ mutable.value = mutable.value.copy(detailFailure = it) }) {
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
                                    editor = null,
                                    issue = null,
                                )
                            null
                        }
                        detail != null -> {
                            publishDetail(detail, sequence)
                            null
                        }
                        else -> error
                    }
                }
            }
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
        mutable.value =
            mutable.value.copy(
                historyRead =
                    if (cursor == null) WorkflowHistoryRead.Latest else WorkflowHistoryRead.Earlier
            )
        historyLoad =
            viewModelScope.launch {
                try {
                    retryReads({ mutable.value = mutable.value.copy(historyFailure = it) }) {
                        val response = read {
                            // Revalidate through the previous oldest row. Newer runs can push that
                            // row past the previous page boundary while the user's position
                            // remains.
                            val through =
                                if (cursor == null) cached?.page?.runs?.lastOrNull() else null
                            fetchHistory(id, cursor, through)
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
                                            runs =
                                                (cached.page.runs + page.runs).distinctBy { it.id }
                                        )
                                )
                            }
                        histories[id] = entry
                        if (histories.size > WORKFLOW_DETAIL_CACHE_CAPACITY)
                            histories.remove(histories.keys.first())
                        mutable.value =
                            mutable.value.copy(history = entry.page, historyFailure = null)
                        null
                    }
                } finally {
                    if (isActive) mutable.value = mutable.value.copy(historyRead = null)
                }
            }
    }

    private suspend fun fetchHistory(
        id: String,
        cursor: String?,
        through: WorkflowRunHistoryEntry?,
    ): WorkflowRunHistory {
        val runs = mutableListOf<WorkflowRunHistoryEntry>()
        val visited = mutableSetOf<String?>()
        var before = cursor
        while (visited.add(before)) {
            val page = service.workflowRunHistory(id, before)
            runs.addAll(page.runs)
            if (
                through == null ||
                    page.nextCursor == null ||
                    page.runs.any { it.id == through.id } ||
                    page.runs.lastOrNull()?.let { it.createdAt < through.createdAt } == true
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
    ) = coroutineScope {
        var failures = 0
        var firstFailureAt = 0L
        var notice: Job? = null
        try {
            while (authorized()) {
                val error = attempt() ?: break
                if (offline && error is ApiFailure.Network) {
                    publishFailure(WorkflowReadFailure.Offline)
                    break
                }
                val retryAfter = error.retryAfterMillis()
                if (retryAfter == null) {
                    publishFailure(WorkflowReadFailure.RefreshFailed)
                    break
                }
                if (failures == 0) {
                    firstFailureAt = monotonicMillis()
                    publishFailure(WorkflowReadFailure.CouldNotLoad)
                }
                if (failures == 2) {
                    notice = launch {
                        delay((30_000L - (monotonicMillis() - firstFailureAt)).coerceAtLeast(0))
                        if (authorized()) publishFailure(WorkflowReadFailure.RefreshFailed)
                    }
                }
                delay(maxOf(workflowRetryDelays[failures], retryAfter))
                failures = (failures + 1).coerceAtMost(workflowRetryDelays.lastIndex)
            }
        } finally {
            notice?.cancel()
        }
    }

    internal fun edit(value: WorkflowEdit?) {
        val state = mutable.value
        val ruleId = (value as? WorkflowEdit.Rule)?.id
        if (
            !authorized() ||
                state.writing ||
                value != null && state.detail?.canChange(ruleId) != true
        )
            return
        val issue =
            state.issue?.takeIf {
                value != null &&
                    state.editor != null &&
                    (it.failure == WorkflowWriteFailure.UncertainCreate ||
                        it.failure == WorkflowWriteFailure.Network)
            }
        mutable.value = state.copy(editor = value, issue = issue)
    }

    internal fun toggle(rule: WorkflowAutomation) {
        val state = mutable.value
        val confirmed = state.detail?.automations?.firstOrNull { it.id == rule.id } ?: return
        if (confirmed.enabled != rule.enabled) return
        if (!confirmed.enabled && !confirmed.canEnable(state.connections)) return
        changeRule(rule.id) { service.setAutomationEnabled(rule.id, !rule.enabled) }
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
                    val request = editor.value.changesFrom(editor.original)
                    val confirmed = service.updateWorkflow(before.id, request)
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

    private fun changeRule(id: String, change: suspend () -> WorkflowAutomation) =
        mutate(ruleId = id) { detail ->
            val confirmed = change()
            if (confirmed.id != id) throw ApiFailure.IncompatibleResponse()
            publishRules(detail, detail.automations.map { if (it.id == id) confirmed else it })
        }

    private fun mutate(
        creating: Boolean = false,
        ruleId: String? = null,
        action: suspend (WorkflowDetail) -> Unit,
    ) {
        val state = mutable.value
        val detail = state.detail ?: return
        if (!authorized() || !visible || !foreground || state.writing || detail.id != selected)
            return
        if (!detail.canChange(ruleId)) {
            if (ruleId != null)
                mutable.value =
                    state.copy(issue = WorkflowWriteIssue(WorkflowWriteFailure.Failed, ruleId))
            return
        }
        if (catalogRead.job?.isActive == true) readsAfterWrite.add(WorkflowReadScope.Catalog)
        if (rulesRead.job?.isActive == true) readsAfterWrite.add(WorkflowReadScope.Rules)
        if (detailLoad?.isActive == true) readsAfterWrite.add(WorkflowReadScope.Detail)
        stopWorkflowReads()
        mutable.value = state.copy(writing = true, issue = null)
        viewModelScope.launch {
            try {
                // await cancellation / scope checks before publishing from a retired session.
                action(detail)
                if (authorized() && selected == detail.id)
                    mutable.value = mutable.value.copy(editor = null)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (authorized() && selected == detail.id) {
                    reportSessionFailure(error)
                    val status = (error as? ApiFailure.Http)?.status
                    val failure =
                        when {
                            creating && (status == null || status >= 500) ->
                                WorkflowWriteFailure.UncertainCreate
                            error is ApiFailure.Network -> WorkflowWriteFailure.Network
                            !creating && ruleId == null && status == 409 ->
                                WorkflowWriteFailure.Conflict
                            else -> WorkflowWriteFailure.Failed
                        }
                    mutable.value = mutable.value.copy(issue = WorkflowWriteIssue(failure, ruleId))
                    readsAfterWrite.add(WorkflowReadScope.Detail)
                }
            } finally {
                if (authorized()) {
                    mutable.value = mutable.value.copy(writing = false)
                    val pending = readsAfterWrite.toSet()
                    readsAfterWrite.clear()
                    refresh(pending)
                }
            }
        }
    }

    private fun publishDetail(response: WorkflowDetail, sequence: Long = ++readSequence) {
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
        details[id] = CachedWorkflowDetail(detail, monotonicMillis())
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
                detailFailure = null,
                catalog =
                    current.catalog?.map { item ->
                        if (item.id == detail.id) update.applyTo(item) else item
                    },
                rules = rules,
            )
    }

    private fun publishRules(detail: WorkflowDetail, rules: List<WorkflowAutomation>) =
        publishDetail(detail.copy(automations = rules))

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

private data class CachedWorkflowDetail(val detail: WorkflowDetail, val readAt: Long)

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

private const val WORKFLOW_CACHE_TTL_MILLIS = 600_000L
private const val WORKFLOW_DETAIL_CACHE_CAPACITY = 8

private fun Long?.isFresh(now: Long): Boolean =
    this != null && now - this in 0 until WORKFLOW_CACHE_TTL_MILLIS

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
    updates: Map<String, WorkflowDirectoryUpdate?>
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

private val workflowRetryDelays = listOf(5_000L, 10_000L, 20_000L, 40_000L, 60_000L)

private fun WorkflowReadFailure?.canRecheckOnReconnect() =
    this == WorkflowReadFailure.Offline ||
        this == WorkflowReadFailure.CouldNotLoad ||
        this == WorkflowReadFailure.RefreshFailed

private fun Throwable?.denied() =
    this is ApiFailure.Unauthenticated ||
        this is ApiFailure.Http && (status == 401 || status == 403)

private fun Throwable.retryAfterMillis(): Long? =
    when (this) {
        is ApiFailure.Network -> 0L
        is ApiFailure.Http ->
            if (status == 408 || status == 429 || status in 500..599)
                (retryAfterSeconds ?: 0L).coerceIn(0, Long.MAX_VALUE / 1_000) * 1_000
            else null
        else -> null
    }
