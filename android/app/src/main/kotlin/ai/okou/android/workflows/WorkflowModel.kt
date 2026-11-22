package ai.okou.android.workflows

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.CreateWorkflowAutomationRequest
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequest
import ai.okou.android.api.generated.UpdateWorkflowRequest
import ai.okou.android.api.generated.WorkflowAutomation
import ai.okou.android.api.generated.WorkflowDetail
import ai.okou.android.api.generated.WorkflowSummary
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
    val offline: Boolean = false,
    val writing: Boolean = false,
    val issue: WorkflowWriteIssue? = null,
    val editor: WorkflowEdit? = null,
)

internal enum class WorkflowReadFailure {
    Unavailable,
    CouldNotLoad,
    RefreshFailed,
}

internal enum class WorkflowWriteIssue {
    Failed,
    UncertainCreate,
}

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
    private var selected: String? = null
    private var catalogLoad: Job? = null
    private var detailLoad: Job? = null
    private var refreshAfterWrite = false

    internal fun connectivityChanged(offline: Boolean) {
        if (mutable.value.offline == offline) return
        mutable.value = mutable.value.copy(offline = offline)
        if (offline) stopReads() else refresh()
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
        if (!authorized() || !visible || mutable.value.offline) return
        if (mutable.value.writing) {
            refreshAfterWrite = true
            return
        }
        if (catalogLoad?.isActive == true) return
        selected?.let(::loadDetail)
        catalogLoad =
            viewModelScope.launch {
                retryReads(
                    { mutable.value = mutable.value.copy(catalogFailure = it) },
                    ::loadCatalog,
                )
            }
    }

    private suspend fun loadCatalog(): Throwable? = coroutineScope {
        val catalog = async { read { service.workflows().filter { it.official == null } } }
        val rules = async {
            read { service.workflowAutomations().groupBy({ it.workflow.id }, { it.automation }) }
        }
        val accounts = async { read { service.workflowConnections() } }
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
        mutable.value = mutable.value.copy(catalog = workflows.getOrThrow())
        val automationRules = rules.await()
        val connections = accounts.await()
        if (!authorized()) return@coroutineScope null
        val failure =
            listOfNotNull(automationRules.exceptionOrNull(), connections.exceptionOrNull())
                .maxByOrNull { it.retryAfterMillis() ?: -1L }
        val current = mutable.value
        mutable.value =
            current.copy(
                rules =
                    if (automationRules.exceptionOrNull().denied()) null
                    else automationRules.getOrNull() ?: current.rules,
                connections =
                    if (connections.exceptionOrNull().denied()) null
                    else connections.getOrNull() ?: current.connections,
                catalogFailure = if (failure == null) null else current.catalogFailure,
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
        val state = mutable.value
        if (
            !visible ||
                !authorized() ||
                state.offline ||
                state.writing ||
                detailLoad?.isActive == true
        )
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
                            val current = mutable.value
                            mutable.value =
                                current.copy(
                                    catalog = current.catalog?.filterNot { it.id == id },
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

    internal fun updateInstructions(request: UpdateWorkflowRequest) = mutate { before ->
        val detail = service.updateWorkflow(before.id, request)
        if (detail.id != before.id) throw ApiFailure.IncompatibleResponse()
        publishDetail(detail)
    }

    internal fun edit(value: WorkflowEdit?) {
        val state = mutable.value
        if (!authorized() || state.writing || value != null && state.detail?.canManage != true)
            return
        val issue = state.issue.takeIf { it == WorkflowWriteIssue.UncertainCreate && value != null }
        mutable.value = state.copy(editor = value, issue = issue)
    }

    internal fun toggle(rule: WorkflowAutomation) {
        val confirmed = mutable.value.detail?.automations?.firstOrNull { it.id == rule.id }
        if (confirmed?.enabled != rule.enabled) return
        changeRule(rule.id) { service.setAutomationEnabled(rule.id, !rule.enabled) }
    }

    internal fun saveRule(
        id: String?,
        create: CreateWorkflowAutomationRequest?,
        update: UpdateWorkflowAutomationRequest?,
    ) {
        if (id == null && create != null) {
            mutate(creating = true) { detail ->
                val added = service.createAutomation(detail.id, create)
                publishRules(detail, detail.automations + added)
            }
        } else if (id != null && update != null) {
            changeRule(id) { service.updateAutomation(id, update) }
        }
    }

    private fun changeRule(id: String, change: suspend () -> WorkflowAutomation) {
        val current = mutable.value
        if (current.detail?.automations?.none { it.id == id && it.official == null } == true) {
            if (authorized() && !current.writing)
                mutable.value = current.copy(issue = WorkflowWriteIssue.Failed)
            return
        }
        mutate { detail ->
            val confirmed = change()
            if (confirmed.id != id) throw ApiFailure.IncompatibleResponse()
            publishRules(detail, detail.automations.map { if (it.id == id) confirmed else it })
        }
    }

    private fun mutate(creating: Boolean = false, action: suspend (WorkflowDetail) -> Unit) {
        val state = mutable.value
        val detail = state.detail ?: return
        if (
            !authorized() ||
                !visible ||
                !detail.canManage ||
                state.writing ||
                state.offline ||
                detail.id != selected
        )
            return
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
                    mutable.value =
                        mutable.value.copy(
                            issue =
                                if (creating && (status == null || status >= 500))
                                    WorkflowWriteIssue.UncertainCreate
                                else WorkflowWriteIssue.Failed
                        )
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
        val current = mutable.value
        mutable.value =
            current.copy(
                detail = detail,
                detailFailure = null,
                catalog =
                    current.catalog?.map { item ->
                        if (item.id == detail.id)
                            item.copy(
                                name = detail.name,
                                displayName = detail.displayName,
                                description = detail.description,
                                canManage = detail.canManage,
                            )
                        else item
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
