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
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

internal data class WorkflowState(
    val enabled: Boolean? = null,
    val catalog: List<WorkflowSummary>? = null,
    val rules: Map<String, List<WorkflowAutomation>>? = null,
    val connections: Set<String>? = null,
    val detail: WorkflowDetail? = null,
    val catalogFailed: Boolean = false,
    val detailFailure: WorkflowDetailFailure? = null,
    val offline: Boolean = false,
    val writing: Boolean = false,
    val issue: WorkflowWriteIssue? = null,
    val editor: WorkflowEdit? = null,
)

internal enum class WorkflowDetailFailure {
    Unavailable,
    CouldNotLoad,
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
) : ViewModel() {
    private val mutable = MutableStateFlow(WorkflowState())
    internal val state = mutable.asStateFlow()
    private var visible = false
    private var selected: String? = null
    private var catalogLoad: Job? = null
    private var detailLoad: Job? = null
    private var retryClock: Job? = null

    internal fun connectivityChanged(offline: Boolean) {
        if (mutable.value.offline == offline) return
        mutable.value = mutable.value.copy(offline = offline)
        if (offline) {
            catalogLoad?.cancel()
            detailLoad?.cancel()
        } else refresh()
    }

    internal fun visibilityChanged(open: Boolean) {
        if (visible == open) return
        visible = open
        if (open) {
            refresh()
            retryClock =
                viewModelScope.launch {
                    while (true) {
                        delay(30_000)
                        val state = mutable.value
                        if (
                            state.catalogFailed ||
                                state.detailFailure == WorkflowDetailFailure.CouldNotLoad
                        )
                            refresh()
                    }
                }
        } else {
            retryClock?.cancel()
            catalogLoad?.cancel()
            detailLoad?.cancel()
        }
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
        if (!authorized() || !visible || mutable.value.offline || mutable.value.writing) return
        if (catalogLoad?.isActive == true) return
        catalogLoad =
            viewModelScope.launch {
                val enabled = read { service.workflowsEnabled() }
                if (!authorized()) return@launch
                when (enabled.getOrNull()) {
                    false -> {
                        detailLoad?.cancel()
                        mutable.value =
                            WorkflowState(enabled = false, offline = mutable.value.offline)
                    }
                    true -> {
                        mutable.value = mutable.value.copy(enabled = true)
                        selected?.let(::loadDetail)
                        loadCatalog()
                    }
                    null -> {
                        if (enabled.exceptionOrNull().denied()) clearAccess()
                        mutable.value = mutable.value.copy(catalogFailed = true)
                    }
                }
            }
    }

    private suspend fun loadCatalog() = coroutineScope {
        val catalog = async { read { service.workspaceCatalog() } }
        val rules = async {
            read { service.workflowAutomations().groupBy({ it.workflow.id }, { it.automation }) }
        }
        val accounts = async { read { service.workflowConnections() } }
        val workflows = catalog.await()
        if (!authorized()) return@coroutineScope
        if (workflows.exceptionOrNull().denied()) {
            clearAccess()
            rules.cancel()
            accounts.cancel()
            return@coroutineScope
        }
        mutable.value =
            mutable.value.copy(
                catalog = workflows.getOrNull() ?: mutable.value.catalog,
                catalogFailed = workflows.isFailure,
            )
        val automationRules = rules.await()
        val connections = accounts.await()
        if (!authorized()) return@coroutineScope
        val current = mutable.value
        mutable.value =
            current.copy(
                rules = automationRules.getOrNull() ?: current.rules,
                connections = connections.getOrNull() ?: current.connections,
                catalogFailed =
                    workflows.isFailure || automationRules.isFailure || connections.isFailure,
            )
    }

    private fun clearAccess() {
        detailLoad?.cancel()
        mutable.value =
            mutable.value.copy(
                catalog = null,
                rules = null,
                connections = null,
                detail = null,
                catalogFailed = true,
                detailFailure = WorkflowDetailFailure.Unavailable,
            )
    }

    private fun loadDetail(id: String) {
        val state = mutable.value
        if (
            !visible ||
                !authorized() ||
                state.enabled != true ||
                state.offline ||
                state.writing ||
                detailLoad?.isActive == true
        )
            return
        detailLoad =
            viewModelScope.launch {
                val response = read {
                    service.workflow(id).also {
                        if (it.id != id) throw ApiFailure.IncompatibleResponse()
                    }
                }
                if (!authorized() || selected != id) return@launch
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
                                detailFailure = WorkflowDetailFailure.Unavailable,
                            )
                    }
                    detail != null -> publishDetail(detail)
                    else ->
                        mutable.value =
                            mutable.value.copy(detailFailure = WorkflowDetailFailure.CouldNotLoad)
                }
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

    private fun changeRule(id: String, change: suspend () -> WorkflowAutomation) =
        mutate { detail ->
            if (detail.automations.none { it.id == id && it.official == null }) return@mutate
            val confirmed = change()
            if (confirmed.id != id) throw ApiFailure.IncompatibleResponse()
            publishRules(detail, detail.automations.map { if (it.id == id) confirmed else it })
        }

    private fun mutate(creating: Boolean = false, action: suspend (WorkflowDetail) -> Unit) {
        val state = mutable.value
        val detail = state.detail ?: return
        if (
            !authorized() ||
                !visible ||
                !detail.canManage ||
                state.enabled != true ||
                state.writing ||
                state.offline ||
                detail.id != selected
        )
            return
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
                    if (mutable.value.issue != null) refresh()
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
            Result.success(block())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
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

private fun Throwable?.denied() =
    this is ApiFailure.Unauthenticated || this is ApiFailure.Http && status in setOf(401, 403)
