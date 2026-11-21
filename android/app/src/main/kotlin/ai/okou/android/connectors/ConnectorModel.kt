package ai.okou.android.connectors

import ai.okou.android.api.ApiFailure
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeMark
import kotlin.time.TimeSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.HttpUrl

internal data class ConnectorRead<T>(val data: T? = null, val failures: Int = 0)

internal data class ConnectorBrowseFilter(val keyword: String?, val category: String?) {
    companion object {
        fun of(query: String, category: String?): ConnectorBrowseFilter? =
            when {
                category != null -> ConnectorBrowseFilter(null, category)
                query.isNotBlank() -> ConnectorBrowseFilter(query.trim(), null)
                else -> null
            }
    }
}

internal data class ConnectorMatches(
    val filter: ConnectorBrowseFilter,
    val entries: ConnectorRead<ConnectorBrowse> = ConnectorRead(),
)

internal enum class ConnectorProblem {
    Failed,
    BrowserUnavailable,
    AuthorizationIncomplete,
    VerificationPending,
}

internal enum class ConnectorResult {
    Authorized,
    Renamed,
    Disconnected,
}

internal data class ConnectorAction(
    val target: ConnectorAccountTarget,
    val busy: Boolean = false,
    val authorization: ConnectorAuthorization? = null,
    val browserOpened: Boolean = false,
    val reconciling: Boolean = false,
    val problem: ConnectorProblem? = null,
    val result: ConnectorResult? = null,
)

internal data class ConnectorImpact(val accountId: String, val read: ConnectorRead<Long>)

internal data class ConnectorUiState(
    val offline: Boolean = false,
    val browse: ConnectorRead<ConnectorBrowse> = ConnectorRead(),
    val connected: ConnectorRead<Map<String, ConnectedService>> = ConnectorRead(),
    val matches: ConnectorMatches? = null,
    val slug: String? = null,
    val detail: ConnectorRead<ConnectorServiceDetail> = ConnectorRead(),
    val accounts: ConnectorRead<List<ConnectorSavedAccount>> = ConnectorRead(),
    val permissions: ConnectorRead<List<ConnectorPermission>> = ConnectorRead(),
    val impact: ConnectorImpact? = null,
    val action: ConnectorAction? = null,
) {
    fun accountsFor(slug: String): List<ConnectorSavedAccount> =
        if (this.slug == slug && accounts.data != null) accounts.data
        else connected.data?.get(slug)?.accounts.orEmpty()
}

class ConnectorModel(
    private val service: ConnectorService,
    connectivity: Flow<Boolean>,
    private val authorized: () -> Boolean,
    private val sessionFailure: (Exception) -> Unit,
) : ViewModel() {
    private val mutableEnabled = MutableStateFlow(false)
    internal val enabled = mutableEnabled.asStateFlow()
    private val mutableState = MutableStateFlow(ConnectorUiState())
    internal val uiState = mutableState.asStateFlow()
    private var gateJob: Job? = null
    private var directoryJob: Job? = null
    private var matchesJob: Job? = null
    private var detailJob: Job? = null
    private var permissionJob: Job? = null
    private var impactJob: Job? = null
    private var actionJob: Job? = null
    private var deviceJob: Job? = null
    private var verificationJob: Job? = null
    private var verificationFailures = 0
    private var permissionsRequested = false
    private var open = false
    private var filter: ConnectorBrowseFilter? = null
    private var authorizationDeadline: TimeMark? = null
    private var pendingChange: PendingChange? = null

    init {
        refreshGate()
        viewModelScope.launch {
            connectivity.collect { online ->
                val changed = mutableState.value.offline == online
                mutableState.update { it.copy(offline = !online) }
                if (changed && online) {
                    refreshGate()
                    if (open) refreshVisible()
                }
            }
        }
    }

    private fun refreshGate() {
        if (gateJob?.isActive == true || !authorized()) return
        gateJob =
            viewModelScope.launch {
                load(service::enabled) { value, _ ->
                    if (value != null) mutableEnabled.value = value
                }
            }
    }

    internal fun setOpen(open: Boolean) {
        this.open = open
        if (open) {
            refreshVisible()
        } else {
            directoryJob?.cancel()
            matchesJob?.cancel()
            detailJob?.cancel()
            permissionJob?.cancel()
            impactJob?.cancel()
            verificationJob?.cancel()
        }
    }

    internal fun resume() {
        if (open) refreshVisible()
    }

    private fun refreshVisible() {
        if (mutableState.value.offline) return
        refreshDirectory()
        refreshMatches()
        refreshDetail()
        if (permissionsRequested) refreshPermissions()
        mutableState.value.impact?.let { refreshImpact(it.accountId) }
        checkAuthorization()
        reconcilePendingChange()
    }

    private fun refreshDirectory() {
        if (directoryJob?.isActive == true) return
        directoryJob =
            viewModelScope.launch {
                coroutineScope {
                    launch {
                        load({ service.discover(null, null) }) { value, failures ->
                            mutableState.update { state ->
                                state.copy(
                                    browse = ConnectorRead(value ?: state.browse.data, failures)
                                )
                            }
                        }
                    }
                    launch {
                        load(service::connected) { value, failures ->
                            mutableState.update { state ->
                                state.copy(
                                    connected =
                                        ConnectorRead(
                                            value?.mapValues { (slug, service) ->
                                                val previous = state.connected.data?.get(slug)
                                                val statuses =
                                                    previous?.accounts.orEmpty().associate {
                                                        it.id to it.status
                                                    }
                                                service.withStatuses(statuses)
                                            } ?: state.connected.data,
                                            failures,
                                        )
                                )
                            }
                        }
                        val connected = mutableState.value.connected.data ?: return@launch
                        load({ service.inspect(connected) }) { statuses, _ ->
                            if (statuses != null) {
                                mutableState.update { state ->
                                    val data =
                                        state.connected.data?.mapValues { (_, service) ->
                                            service.withStatuses(
                                                statuses,
                                                preserveScopeMismatch = true,
                                            )
                                        }
                                    state.copy(connected = state.connected.copy(data = data))
                                }
                            }
                        }
                    }
                }
            }
    }

    internal fun setFilter(next: ConnectorBrowseFilter?) {
        if (next == filter) return
        filter = next
        matchesJob?.cancel()
        matchesJob = null
        if (next != null && mutableState.value.matches?.filter != next) {
            mutableState.update { it.copy(matches = ConnectorMatches(next)) }
        }
        if (next != null) refreshMatches()
    }

    private fun refreshMatches() {
        val selected = filter ?: return
        if (matchesJob?.isActive == true) return
        matchesJob =
            viewModelScope.launch {
                if (selected.keyword != null) delay(250)
                load({ service.discover(selected.keyword, selected.category) }) { value, failures ->
                    mutableState.update { state ->
                        val previous = state.matches?.takeIf { it.filter == selected }
                        state.copy(
                            matches =
                                ConnectorMatches(
                                    selected,
                                    ConnectorRead(value ?: previous?.entries?.data, failures),
                                )
                        )
                    }
                }
            }
    }

    internal fun select(slug: String?) {
        if (mutableState.value.slug == slug) return
        detailJob?.cancel()
        detailJob = null
        permissionJob?.cancel()
        permissionJob = null
        impactJob?.cancel()
        impactJob = null
        permissionsRequested = false
        mutableState.update {
            it.copy(
                slug = slug,
                detail = ConnectorRead(),
                accounts = ConnectorRead(),
                permissions = ConnectorRead(),
                impact = null,
            )
        }
        refreshDetail()
    }

    private fun refreshDetail() {
        val slug = mutableState.value.slug ?: return
        if (detailJob?.isActive == true) return
        detailJob =
            viewModelScope.launch {
                coroutineScope {
                    launch {
                        load({ service.detail(slug) }) { value, failures ->
                            mutableState.update { state ->
                                state.copy(
                                    detail = ConnectorRead(value ?: state.detail.data, failures)
                                )
                            }
                        }
                    }
                    launch {
                        load({ service.accounts(slug) }) { value, failures ->
                            if (value != null) publishAccounts(slug, value)
                            else
                                mutableState.update { state ->
                                    state.copy(accounts = state.accounts.copy(failures = failures))
                                }
                        }
                    }
                }
            }
    }

    internal fun showPermissions() {
        permissionsRequested = true
        refreshPermissions()
    }

    internal fun hidePermissions() {
        permissionsRequested = false
        permissionJob?.cancel()
        permissionJob = null
    }

    private fun refreshPermissions() {
        val slug = mutableState.value.slug ?: return
        if (permissionJob?.isActive == true) return
        permissionJob =
            viewModelScope.launch {
                load({ service.permissions(slug) }) { value, failures ->
                    mutableState.update { state ->
                        state.copy(
                            permissions = ConnectorRead(value ?: state.permissions.data, failures)
                        )
                    }
                }
            }
    }

    internal fun prepareDisconnect(id: String) {
        impactJob?.cancel()
        impactJob = null
        mutableState.update { it.copy(impact = ConnectorImpact(id, ConnectorRead())) }
        refreshImpact(id)
    }

    internal fun clearImpact() {
        impactJob?.cancel()
        impactJob = null
        mutableState.update { it.copy(impact = null) }
    }

    private fun refreshImpact(id: String) {
        val slug = mutableState.value.slug ?: return
        if (impactJob?.isActive == true) return
        impactJob =
            viewModelScope.launch {
                load({ service.impact(slug, id) }) { value, failures ->
                    mutableState.update { state ->
                        state.copy(impact = ConnectorImpact(id, ConnectorRead(value, failures)))
                    }
                }
            }
    }

    internal fun rename(id: String, name: String) {
        val label = name.trim()
        val target = currentAccount(id) ?: return
        if (label.isEmpty() || label.length > 255) return
        change(
            PendingChange(target, ConnectorResult.Renamed) { account ->
                account?.displayName == label
            }
        ) {
            val saved = service.rename(target.slug, id, label)
            replaceAccount(target, id) { it.copy(displayName = saved) }
        }
    }

    internal fun setDefaultEnabled(id: String, enabled: Boolean) {
        val target = currentAccount(id) ?: return
        if (
            mutableState.value.accountsFor(target.slug).find { it.id == id }?.status !=
                ConnectorAccountStatus.Connected
        )
            return
        change(PendingChange(target, null) { it?.defaultEnabled == enabled }) {
            val saved = service.setDefaultEnabled(target.slug, id, enabled)
            replaceAccount(target, id) { it.copy(defaultEnabled = saved) }
        }
    }

    internal fun disconnect(id: String) {
        val target = currentAccount(id) ?: return
        val impact = mutableState.value.impact ?: return
        if (impact.accountId != id || impact.read.data == null) return
        change(PendingChange(target, ConnectorResult.Disconnected) { it == null }) {
            service.disconnect(target.slug, id)
            replaceAccount(target, id) { null }
        }
    }

    private fun change(change: PendingChange, write: suspend () -> Unit) {
        val target = change.target
        if (!canStart()) return
        invalidateConnectionReads()
        runAction(ConnectorAction(target)) {
            try {
                write()
                complete(target, change.result)
            } catch (error: Exception) {
                if (error is CancellationException || !error.uncertainWrite()) throw error
                pendingChange = change
                updateAction { it.copy(reconciling = true) }
                verifyChange(change)
            } finally {
                if (open) {
                    refreshDirectory()
                    refreshDetail()
                }
            }
        }
    }

    private fun reconcilePendingChange() {
        val pending = pendingChange ?: return
        val action = mutableState.value.action ?: return
        if (actionJob?.isActive == true || action.busy) return
        runAction(action) { verifyChange(pending) }
    }

    private suspend fun verifyChange(change: PendingChange) {
        val accounts = service.accounts(change.target.slug)
        invalidateConnectionReads()
        publishAccounts(change.target.slug, accounts)
        pendingChange = null
        if (change.matches(accounts.find { it.id == change.target.connectionId })) {
            complete(change.target, change.result)
        } else {
            updateAction { it.copy(reconciling = false, problem = ConnectorProblem.Failed) }
        }
    }

    internal fun startAuthorization(id: String?, methodId: String, values: Map<String, String>) {
        val state = mutableState.value
        val detail = state.detail.data ?: return
        val target =
            if (id == null) ConnectorAccountTarget(detail.entry.slug, null)
            else currentAccount(id) ?: return
        val method = detail.methods.firstOrNull { it.id == methodId } ?: return
        if (
            id != null &&
                state.accountsFor(target.slug).find { it.id == id }?.authMethod != methodId
        )
            return
        if (!canStart()) return
        runAction(ConnectorAction(target)) {
            when (val step = service.start(target, method, values)) {
                is ConnectorAuthorization.Receipt -> finishAuthorization(target, step.connectionId)
                else -> {
                    authorizationDeadline =
                        TimeSource.Monotonic.markNow() +
                            when (step) {
                                is ConnectorAuthorization.Device -> step.expiresIn
                                is ConnectorAuthorization.External -> step.expiresIn
                                else -> 15.minutes
                            }
                    updateAction { it.copy(authorization = step) }
                }
            }
        }
    }

    internal fun openBrowser(launch: (HttpUrl) -> Boolean) {
        val action = mutableState.value.action ?: return
        if (action.busy) return
        if (authorizationExpired()) {
            updateAction {
                it.copy(authorization = null, problem = ConnectorProblem.AuthorizationIncomplete)
            }
            return
        }
        val step = action.authorization
        val url =
            when (step) {
                is ConnectorAuthorization.Browser -> step.url
                is ConnectorAuthorization.Device -> step.url
                is ConnectorAuthorization.External -> step.url
                else -> return
            }
        if (!launch(url)) {
            updateAction { it.copy(problem = ConnectorProblem.BrowserUnavailable) }
            return
        }
        updateAction { it.copy(browserOpened = true, problem = null) }
        if (step is ConnectorAuthorization.Device) {
            beginDevicePolling(action.target, step)
        }
    }

    private fun beginDevicePolling(
        target: ConnectorAccountTarget,
        step: ConnectorAuthorization.Device,
    ) {
        if (deviceJob?.isActive == true) return
        deviceJob =
            viewModelScope.launch {
                var interval = step.interval
                while (!authorizationExpired()) {
                    delay(interval.coerceAtLeast(1.seconds))
                    if (authorizationExpired()) break
                    if (mutableState.value.offline) continue
                    try {
                        when (val result = service.pollDevice(target.slug, step)) {
                            is ConnectorDeviceResult.Waiting -> interval = result.interval
                            is ConnectorDeviceResult.Complete -> {
                                val action = mutableState.value.action ?: return@launch
                                runAction(action) {
                                    finishAuthorization(target, result.connectionId)
                                }
                                return@launch
                            }
                            ConnectorDeviceResult.Rejected -> break
                        }
                    } catch (error: Exception) {
                        if (error is CancellationException) throw error
                        reportSessionFailure(error)
                        if (!error.uncertainWrite()) break
                        interval = maxOf(interval, 5.seconds)
                    }
                }
                updateAction {
                    it.copy(
                        authorization = null,
                        problem = ConnectorProblem.AuthorizationIncomplete,
                    )
                }
            }
    }

    internal fun completeExternal(code: String) {
        val action = mutableState.value.action ?: return
        val step = action.authorization as? ConnectorAuthorization.External ?: return
        if (
            code.isBlank() || code.trim().length > 4096 || action.busy || mutableState.value.offline
        )
            return
        if (authorizationExpired()) {
            updateAction {
                it.copy(authorization = null, problem = ConnectorProblem.AuthorizationIncomplete)
            }
            return
        }
        runAction(action) {
            val connectionId = service.completeExternal(action.target.slug, step, code.trim())
            finishAuthorization(action.target, connectionId)
        }
    }

    internal fun checkAuthorization() {
        val action = mutableState.value.action ?: return
        if (action.busy || actionJob?.isActive == true || mutableState.value.offline) return
        when (val step = action.authorization) {
            is ConnectorAuthorization.Receipt ->
                runAction(action) { finishAuthorization(action.target, step.connectionId) }
            is ConnectorAuthorization.Browser -> {
                if (!action.browserOpened) return
                runAction(action) {
                    var receipt = service.oauthCompletion(action.target.slug, step.attemptId)
                    if (receipt == null) {
                        delay(700)
                        receipt = service.oauthCompletion(action.target.slug, step.attemptId)
                    }
                    if (receipt != null) finishAuthorization(action.target, receipt)
                    else
                        updateAction {
                            it.copy(
                                authorization =
                                    it.authorization.takeUnless { authorizationExpired() },
                                problem = ConnectorProblem.AuthorizationIncomplete,
                            )
                        }
                }
            }
            else -> Unit
        }
    }

    private suspend fun finishAuthorization(target: ConnectorAccountTarget, receipt: String) {
        if (target.connectionId != null && target.connectionId != receipt) {
            updateAction { it.copy(authorization = null) }
            throw ApiFailure.IncompatibleResponse()
        }
        updateAction {
            it.copy(authorization = ConnectorAuthorization.Receipt(receipt), reconciling = true)
        }
        val connected = service.accountIsConnected(target.slug, receipt)
        val accounts = service.accounts(target.slug)
        invalidateConnectionReads()
        publishAccounts(target.slug, accounts)
        if (
            connected &&
                accounts.any { it.id == receipt && it.status == ConnectorAccountStatus.Connected }
        ) {
            complete(ConnectorAccountTarget(target.slug, receipt), ConnectorResult.Authorized)
        } else {
            updateAction {
                it.copy(
                    authorization = null,
                    reconciling = false,
                    problem = ConnectorProblem.AuthorizationIncomplete,
                )
            }
        }
        if (open) {
            refreshDirectory()
            refreshDetail()
        }
    }

    internal fun dismissAction() {
        val action = mutableState.value.action
        if (action?.busy == true || action?.reconciling == true) return
        deviceJob?.cancel()
        deviceJob = null
        authorizationDeadline = null
        mutableState.update { it.copy(action = null) }
    }

    private fun authorizationExpired() = authorizationDeadline?.hasPassedNow() == true

    private fun currentAccount(id: String): ConnectorAccountTarget? {
        val state = mutableState.value
        val slug = state.slug ?: return null
        return if (state.accounts.data.orEmpty().any { it.id == id })
            ConnectorAccountTarget(slug, id)
        else null
    }

    private fun canStart(): Boolean =
        authorized() &&
            open &&
            !mutableState.value.offline &&
            actionJob?.isActive != true &&
            mutableState.value.action?.let {
                it.busy || it.reconciling || it.authorization != null
            } != true

    private fun invalidateConnectionReads() {
        directoryJob?.cancel()
        directoryJob = null
        detailJob?.cancel()
        detailJob = null
    }

    private fun replaceAccount(
        target: ConnectorAccountTarget,
        id: String,
        replace: (ConnectorSavedAccount) -> ConnectorSavedAccount?,
    ) {
        val state = mutableState.value
        val accounts =
            state.accountsFor(target.slug).mapNotNull { if (it.id == id) replace(it) else it }
        invalidateConnectionReads()
        publishAccounts(target.slug, accounts)
    }

    private fun publishAccounts(slug: String, accounts: List<ConnectorSavedAccount>) {
        mutableState.update { state ->
            val knownServices = state.connected.data
            val label =
                state.detail.data?.entry?.takeIf { it.slug == slug }?.name
                    ?: knownServices?.get(slug)?.label
            val services =
                when {
                    knownServices == null -> null
                    accounts.isEmpty() -> knownServices - slug
                    label != null -> knownServices + (slug to ConnectedService(label, accounts))
                    else -> knownServices
                }
            state.copy(
                connected = state.connected.copy(data = services),
                accounts = if (state.slug == slug) ConnectorRead(accounts) else state.accounts,
            )
        }
    }

    private fun runAction(action: ConnectorAction, block: suspend () -> Unit) {
        if (!authorized() || actionJob?.isActive == true) return
        mutableState.update { it.copy(action = action.copy(busy = true, problem = null)) }
        actionJob =
            viewModelScope.launch {
                try {
                    block()
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    reportSessionFailure(error)
                    val definitive =
                        error is ApiFailure.Http &&
                            error.status in 400..499 &&
                            error.status != 408 &&
                            error.status != 429
                    if (definitive) pendingChange = null
                    updateAction {
                        it.copy(
                            reconciling = it.reconciling && !definitive,
                            authorization =
                                if (definitive && it.reconciling) null else it.authorization,
                            problem =
                                if (!definitive && (it.reconciling || error.uncertainWrite()))
                                    ConnectorProblem.VerificationPending
                                else ConnectorProblem.Failed,
                        )
                    }
                    if (open) {
                        refreshDirectory()
                        refreshDetail()
                    }
                } finally {
                    updateAction { it.copy(busy = false) }
                    scheduleVerification()
                }
            }
    }

    private fun scheduleVerification() {
        val action = mutableState.value.action
        if (
            !open ||
                !authorized() ||
                mutableState.value.offline ||
                verificationJob?.isActive == true ||
                (pendingChange == null && action?.authorization !is ConnectorAuthorization.Receipt)
        )
            return
        val wait =
            when (verificationFailures++) {
                0 -> 2.seconds
                1 -> 8.seconds
                else -> 30.seconds
            }
        verificationJob =
            viewModelScope.launch {
                delay(wait)
                verificationJob = null
                if (open && !mutableState.value.offline) {
                    checkAuthorization()
                    reconcilePendingChange()
                }
            }
    }

    private fun complete(target: ConnectorAccountTarget, result: ConnectorResult?) {
        authorizationDeadline = null
        verificationFailures = 0
        mutableState.update { it.copy(action = ConnectorAction(target, result = result)) }
    }

    private fun updateAction(update: (ConnectorAction) -> ConnectorAction) {
        if (authorized())
            mutableState.update { state -> state.copy(action = state.action?.let(update)) }
    }

    private fun reportSessionFailure(error: Exception) {
        if (
            error is ApiFailure.Unauthenticated ||
                error is ApiFailure.UpdateRequired ||
                error is ApiFailure.Http && error.status == 401
        )
            sessionFailure(error)
    }

    private suspend fun <T : Any> load(read: suspend () -> T, publish: (T?, Int) -> Unit) {
        var failures = 0
        while (authorized()) {
            if (mutableState.value.offline) {
                delay(2.seconds)
                continue
            }
            try {
                val value = read()
                if (authorized()) publish(value, 0)
                return
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                reportSessionFailure(error)
                if (!authorized()) return
                failures++
                publish(null, failures)
                if (
                    error is ApiFailure.Http &&
                        error.status in 400..499 &&
                        error.status !in setOf(408, 429)
                )
                    return
                delay(
                    when (failures) {
                        1 -> 2.seconds
                        2 -> 8.seconds
                        else -> 30.seconds
                    }
                )
            }
        }
    }

    private data class PendingChange(
        val target: ConnectorAccountTarget,
        val result: ConnectorResult?,
        val matches: (ConnectorSavedAccount?) -> Boolean,
    )
}

private fun Exception.uncertainWrite() =
    this is ApiFailure.Network ||
        this is ApiFailure.IncompatibleResponse ||
        this is ApiFailure.Http && (status == 408 || status >= 500)

private fun ConnectedService.withStatuses(
    statuses: Map<String, ConnectorAccountStatus>,
    preserveScopeMismatch: Boolean = false,
): ConnectedService =
    copy(
        accounts =
            accounts.map { account ->
                val status = statuses[account.id] ?: account.status
                if (
                    preserveScopeMismatch &&
                        account.status == ConnectorAccountStatus.UpdatePermissions &&
                        status == ConnectorAccountStatus.Connected
                )
                    account
                else account.copy(status = status)
            }
    )

internal fun recommendedConnectors(entries: List<ConnectorEntry>): List<ConnectorEntry> =
    entries
        .asSequence()
        .filter { it.rank != null }
        .groupBy { it.category }
        .values
        .filter { it.size >= 4 }
        .mapNotNull {
            it.minWithOrNull(compareBy({ entry -> entry.rank }, { entry -> entry.name }))
        }
        .sortedWith(compareBy({ it.rank }, { it.name }))
        .take(6)
