package ai.okou.android.workflows

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.WorkflowAutomation
import ai.okou.android.api.generated.WorkflowDetail
import ai.okou.android.api.generated.WorkflowDetailVisibility
import ai.okou.android.api.generated.WorkflowSummary
import ai.okou.android.api.generated.WorkflowSummaryVisibility
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

internal data class WorkflowState(
    val catalog: List<WorkflowSummary>? = null,
    val rules: Map<String, List<WorkflowAutomation>>? = null,
    val connections: Set<String>? = null,
    val detail: WorkflowDetail? = null,
    val catalogFailure: WorkflowReadFailure? = null,
    val detailFailure: WorkflowReadFailure? = null,
    val writing: Boolean = false,
    val issue: WorkflowWriteIssue? = null,
    val editor: WorkflowEdit? = null,
)

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
    private val monotonicMillis: () -> Long = { System.nanoTime() / 1_000_000 },
) : ViewModel() {
    private val mutable = MutableStateFlow(WorkflowState())
    internal val state = mutable.asStateFlow()
    private var visible = false
    private var offline = false
    private var selected: String? = null
    private var catalogLoad: Job? = null
    // A null update records a workflow that the detail endpoint confirmed is unavailable.
    private var pendingDirectoryUpdates: MutableMap<String, WorkflowDirectoryUpdate?>? = null
    private var detailLoad: Job? = null
    private var refreshAfterWrite = false

    internal fun connectivityChanged(offline: Boolean) {
        if (this.offline == offline) return
        this.offline = offline
        if (!offline) {
            val current = mutable.value
            mutable.value =
                current.copy(
                    catalogFailure =
                        current.catalogFailure.takeUnless { it == WorkflowReadFailure.Offline },
                    detailFailure =
                        current.detailFailure.takeUnless { it == WorkflowReadFailure.Offline },
                    issue = current.issue.takeUnless { it?.failure == WorkflowWriteFailure.Network },
                )
            refresh()
        }
    }

    internal fun visibilityChanged(open: Boolean) {
        if (visible == open) return
        visible = open
        if (open) refresh() else stopReads()
    }

    private fun stopReads() {
        catalogLoad?.cancel()
        detailLoad?.cancel()
        val current = mutable.value
        mutable.value =
            current.copy(
                catalogFailure =
                    current.catalogFailure.takeUnless {
                        it == WorkflowReadFailure.RefreshFailed && current.catalog != null
                    },
                detailFailure =
                    current.detailFailure.takeUnless {
                        it == WorkflowReadFailure.RefreshFailed && current.detail != null
                    },
            )
    }

    internal fun select(id: String?) {
        if (selected == id) return
        selected = id
        detailLoad?.cancel()
        mutable.value =
            mutable.value.copy(detail = null, detailFailure = null, issue = null, editor = null)
        if (id != null) loadDetail(id)
    }

    private fun refresh() {
        if (!authorized() || !visible) return
        if (mutable.value.writing) {
            refreshAfterWrite = true
            return
        }
        selected?.let(::loadDetail)
        if (catalogLoad?.isActive == true) return
        catalogLoad =
            viewModelScope.launch {
                retryReads(
                    { mutable.value = mutable.value.copy(catalogFailure = it) },
                    ::loadCatalog,
                )
            }
    }

    private suspend fun loadCatalog(): Throwable? = coroutineScope {
        val updates = mutableMapOf<String, WorkflowDirectoryUpdate?>()
        pendingDirectoryUpdates = updates
        val catalog = async { read { service.workflows().filter { it.official == null } } }
        val rules = async {
            read { service.workflowAutomations().groupBy({ it.workflow.id }, { it.automation }) }
        }
        val accounts = async { read { service.workflowConnections() } }
        val automationRules =
            try {
                val workflows = catalog.await()
                if (!authorized()) return@coroutineScope null
                val catalogError = workflows.exceptionOrNull()
                if (catalogError != null) {
                    rules.cancel()
                    accounts.cancel()
                    if (catalogError.denied()) {
                        clearAccess()
                        return@coroutineScope null
                    }
                    return@coroutineScope catalogError
                }
                val directory = workflows.getOrThrow()
                val catalogRows =
                    if (updates.isEmpty()) directory
                    else
                        directory.mapNotNull { row ->
                            if (row.id in updates) updates[row.id]?.applyTo(row) else row
                        }
                mutable.value = mutable.value.copy(catalog = catalogRows)
                rules.await()
            } finally {
                if (pendingDirectoryUpdates === updates) pendingDirectoryUpdates = null
            }
        if (!authorized()) return@coroutineScope null
        val current = mutable.value
        val directoryRules = automationRules.getOrNull()
        if (directoryRules != null) {
            val rulesByWorkflow = directoryRules.withDirectoryUpdates(updates)
            // Both endpoints return the caller's automations for each visible workflow.
            val detail =
                current.detail?.let { active ->
                    val confirmed = rulesByWorkflow[active.id].orEmpty()
                    if (active.automations == confirmed) active
                    else active.copy(automations = confirmed)
                }
            mutable.value = current.copy(rules = rulesByWorkflow, detail = detail)
        } else if (automationRules.exceptionOrNull().denied()) {
            mutable.value = current.copy(rules = null)
        }

        val connections = accounts.await()
        if (!authorized()) return@coroutineScope null
        val failure =
            listOfNotNull(automationRules.exceptionOrNull(), connections.exceptionOrNull())
                .maxByOrNull { it.retryAfterMillis() ?: -1L }
        val latest = mutable.value
        mutable.value =
            latest.copy(
                connections =
                    if (connections.exceptionOrNull().denied()) null
                    else connections.getOrNull() ?: latest.connections,
                catalogFailure = if (failure == null) null else latest.catalogFailure,
            )
        failure
    }

    private fun clearAccess() {
        detailLoad?.cancel()
        mutable.value =
            mutable.value.copy(
                catalog = null,
                rules = null,
                connections = null,
                detail = null,
                catalogFailure = WorkflowReadFailure.Unavailable,
                detailFailure = WorkflowReadFailure.Unavailable,
                editor = null,
                issue = null,
            )
    }

    private fun loadDetail(id: String) {
        if (!visible || !authorized() || mutable.value.writing || detailLoad?.isActive == true)
            return
        detailLoad =
            viewModelScope.launch {
                retryReads({ mutable.value = mutable.value.copy(detailFailure = it) }) {
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
                            pendingDirectoryUpdates?.set(id, null)
                            val current = mutable.value
                            mutable.value =
                                current.copy(
                                    catalog = current.catalog?.filterNot { it.id == id },
                                    rules = current.rules?.minus(id),
                                    detail = null,
                                    detailFailure = WorkflowReadFailure.Unavailable,
                                    editor = null,
                                    issue = null,
                                )
                            null
                        }
                        detail != null -> {
                            publishDetail(detail)
                            null
                        }
                        else -> error
                    }
                }
            }
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
        if (!authorized() || !visible || state.writing || detail.id != selected) return
        if (!detail.canChange(ruleId)) {
            if (ruleId != null)
                mutable.value =
                    state.copy(issue = WorkflowWriteIssue(WorkflowWriteFailure.Failed, ruleId))
            return
        }
        refreshAfterWrite = catalogLoad?.isActive == true || detailLoad?.isActive == true
        catalogLoad?.cancel()
        detailLoad?.cancel()
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
                }
            } finally {
                if (authorized()) {
                    mutable.value = mutable.value.copy(writing = false)
                    val refreshNeeded = refreshAfterWrite || mutable.value.issue != null
                    refreshAfterWrite = false
                    if (refreshNeeded) refresh()
                }
            }
        }
    }

    private fun publishDetail(detail: WorkflowDetail) {
        if (!authorized() || selected != detail.id) return
        val update = WorkflowDirectoryUpdate(detail)
        // The directory read may complete after the user has left this detail.
        pendingDirectoryUpdates?.set(detail.id, update)
        val current = mutable.value
        mutable.value =
            current.copy(
                detail = detail,
                detailFailure = null,
                catalog =
                    current.catalog?.map { item ->
                        if (item.id == detail.id) update.applyTo(item) else item
                    },
                rules = current.rules?.plus(detail.id to detail.automations),
            )
    }

    private fun publishRules(detail: WorkflowDetail, rules: List<WorkflowAutomation>) =
        publishDetail(detail.copy(automations = rules))

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

private class WorkflowDirectoryUpdate(detail: WorkflowDetail) {
    private val name = detail.name
    private val displayName = detail.displayName
    private val description = detail.description
    private val canManage = detail.canManage
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
        )
}

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
