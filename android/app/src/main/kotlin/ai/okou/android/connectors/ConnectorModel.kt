package ai.okou.android.connectors

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ConnectorDetailConnectorAuthMethodsItemGrantKind
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.util.Locale
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeMark
import kotlin.time.TimeSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.HttpUrl

internal const val CONNECTOR_ACCOUNT_NAME_LIMIT = 255
private const val RECENT_READ_LIMIT = 8
private const val ACCOUNT_READBACK_LIMIT = 3
private val CONNECTOR_READ_LIFETIME = 10.minutes

internal data class ConnectorBrowseFilter(val keyword: String?, val category: String?) {
    companion object {
        fun of(query: String, category: String?): ConnectorBrowseFilter? =
            when {
                category != null -> ConnectorBrowseFilter(null, category)
                query.isNotBlank() ->
                    ConnectorBrowseFilter(query.trim().lowercase(Locale.ROOT), null)
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
    Network,
    BrowserUnavailable,
    AuthorizationIncomplete,
    AuthorizationUnconfirmed,
    VerificationPending,
    VerificationNetwork,
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
) {
    val blocksOtherActions: Boolean
        get() = busy || reconciling || authorization != null
}

internal data class ConnectorImpact(val accountId: String, val read: ConnectorRead<Long>)

internal data class ConnectorUiState(
    val offline: Boolean = false,
    val browse: ConnectorRead<ConnectorBrowse> = ConnectorRead(),
    val connected: ConnectorRead<Map<String, ConnectedService>> = ConnectorRead(),
    val matches: ConnectorMatches? = null,
    val slug: String? = null,
    val detail: ConnectorRead<ConnectorServiceDetail> = ConnectorRead(),
    val accounts: ConnectorRead<List<ConnectorSavedAccount>> = ConnectorRead(),
    val cachedAccounts: ConnectorRead<List<ConnectorSavedAccount>>? = null,
    val permissions: ConnectorRead<List<ConnectorPermission>> = ConnectorRead(),
    val impact: ConnectorImpact? = null,
    val action: ConnectorAction? = null,
) {
    val canChangeAccounts: Boolean
        get() = accounts.data != null && action?.blocksOtherActions != true

    fun accountsFor(slug: String): List<ConnectorSavedAccount> {
        if (this.slug == slug && accounts.data != null) return accounts.data
        if (this.slug == slug && accounts.failure == ConnectorReadFailure.Unavailable)
            return emptyList()
        val overview = connected.data
        if (overview != null) return overview[slug]?.accounts.orEmpty()
        return cachedAccounts.takeIf { this.slug == slug }?.data.orEmpty()
    }
}

private data class ServiceReadSnapshot(
    val detail: ConnectorRead<ConnectorServiceDetail>,
    val accounts: ConnectorRead<List<ConnectorSavedAccount>>,
    val permissions: ConnectorRead<List<ConnectorPermission>>,
)

class ConnectorModel(
    private val service: ConnectorService,
    connectivity: Flow<Boolean>,
    private val authorized: () -> Boolean,
    private val readClock: TimeSource = TimeSource.Monotonic,
    private val sessionFailure: (Exception) -> Unit,
) : ViewModel() {
    private val mutableState = MutableStateFlow(ConnectorUiState())
    internal val uiState = mutableState.asStateFlow()
    private val recentMatches =
        LinkedHashMap<ConnectorBrowseFilter, ConnectorRead<ConnectorBrowse>>(
            RECENT_READ_LIMIT,
            0.75f,
            true,
        )
    private val recentServices =
        LinkedHashMap<String, ServiceReadSnapshot>(RECENT_READ_LIMIT, 0.75f, true)
    private var browseJob: Job? = null
    private var connectedJob: Job? = null
    private var inspectionJob: Job? = null
    private var matchesJob: Job? = null
    private var detailJob: Job? = null
    private var accountsJob: Job? = null
    private var permissionJob: Job? = null
    private var impactJob: Job? = null
    private var actionJob: Job? = null
    private var deviceJob: Job? = null
    private var verificationJob: Job? = null
    private var verificationFailures = 0
    private var permissionsRequested = false
    private var open = false
    private var foreground = true
    private var filter: ConnectorBrowseFilter? = null
    private var authorizationDeadline: TimeMark? = null
    private var pendingChange: PendingChange? = null

    init {
        viewModelScope.launch {
            connectivity.collect { online ->
                if (mutableState.value.offline != online) return@collect
                if (!online) {
                    cancelReads()
                    mutableState.update { it.copy(offline = true) }
                } else {
                    if (mutableState.value.impact?.read?.failure != null) {
                        impactJob?.cancel()
                        impactJob = null
                    }
                    mutableState.update { state ->
                        state.copy(
                            offline = false,
                            browse = state.browse.confirmed(),
                            connected = state.connected.confirmed(),
                            matches =
                                state.matches?.let { it.copy(entries = it.entries.confirmed()) },
                            detail = state.detail.confirmed(),
                            accounts = state.accounts.confirmed(),
                            permissions = state.permissions.confirmed(),
                        )
                    }
                    if (open) refreshVisible()
                }
            }
        }
    }

    internal fun setOpen(open: Boolean) {
        if (this.open == open) return
        this.open = open
        if (open) {
            mutableState.update { state ->
                val accounts = state.accounts.confirmed().retaining(state.cachedAccounts).forEntry()
                state.copy(
                    browse = state.browse.forEntry(),
                    connected = state.connected.forEntry(),
                    matches = state.matches?.let { it.copy(entries = it.entries.forEntry()) },
                    detail = state.detail.forEntry(),
                    accounts =
                        ConnectorRead(failure = accounts.failure, expiresAt = accounts.expiresAt),
                    cachedAccounts = accounts.takeIf { it.data != null },
                    permissions = state.permissions.forEntry(),
                )
            }
            refreshVisible()
        } else {
            hidePermissions()
            clearImpact()
            pauseReads()
        }
    }

    internal fun pause() {
        foreground = false
        pauseReads()
    }

    private fun pauseReads() {
        cancelReads()
        impactJob?.cancel()
        verificationJob?.cancel()
    }

    internal fun resume() {
        foreground = true
        if (open) refreshVisible()
    }

    internal fun enterDirectoryTab(connected: Boolean) {
        mutableState.update { state ->
            val matches = state.matches?.let { it.copy(entries = it.entries.forEntry()) }
            if (connected) state.copy(connected = state.connected.forEntry(), matches = matches)
            else state.copy(browse = state.browse.forEntry(), matches = matches)
        }
        if (open && foreground && !mutableState.value.offline) {
            refreshDirectory(browse = !connected, accounts = connected)
            refreshMatches()
        }
    }

    private fun refreshVisible() {
        if (!foreground || mutableState.value.offline) return
        refreshDirectory()
        refreshMatches()
        refreshDetail()
        if (permissionsRequested) refreshPermissions()
        mutableState.value.impact?.let { refreshImpact(it.accountId) }
        checkAuthorization()
        reconcilePendingChange()
    }

    private fun refreshDirectory(browse: Boolean = true, accounts: Boolean = true) {
        if (browse && browseJob?.isActive != true) {
            browseJob =
                viewModelScope.launch {
                    load({ service.discover(null, null) }) { read ->
                        val unavailable = read.failure == ConnectorReadFailure.Unavailable
                        if (unavailable) {
                            matchesJob?.cancel()
                            recentMatches.clear()
                        }
                        mutableState.update { state ->
                            state.copy(
                                browse = read.retaining(state.browse),
                                matches =
                                    if (unavailable) state.matches?.copy(entries = read)
                                    else state.matches,
                            )
                        }
                    }
                }
        }
        if (accounts && connectedJob?.isActive != true) {
            connectedJob =
                viewModelScope.launch {
                    load(service::connected) { read ->
                        val value = read.data
                        mutableState.update { state ->
                            val connected =
                                value?.mapValues { (slug, service) ->
                                    val statuses =
                                        state.connected.data
                                            ?.get(slug)
                                            ?.accounts
                                            .orEmpty()
                                            .associate { it.id to it.status }
                                    service.withStatuses(statuses)
                                }
                            state.copy(
                                connected = read.copy(data = connected).retaining(state.connected)
                            )
                        }
                        if (value != null) inspectConnected(value)
                    }
                }
        }
    }

    private fun inspectConnected(connected: Map<String, ConnectedService>) {
        inspectionJob?.cancel()
        inspectionJob =
            viewModelScope.launch {
                load({ service.inspect(connected) }) { read ->
                    val statuses = read.data
                    if (statuses != null) {
                        mutableState.update { state ->
                            val data =
                                state.connected.data?.mapValues { (_, service) ->
                                    service.withStatuses(statuses, preserveScopeMismatch = true)
                                }
                            state.copy(connected = state.connected.copy(data = data))
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
        if (next != null) {
            val cached = recentMatches[next]?.forEntry()
            mutableState.update {
                it.copy(matches = ConnectorMatches(next, cached ?: ConnectorRead()))
            }
            if (cached?.data == null) refreshMatches()
        }
    }

    private fun refreshMatches() {
        val selected = filter ?: return
        if (matchesJob?.isActive == true) return
        matchesJob =
            viewModelScope.launch {
                if (selected.keyword != null) delay(250)
                load({ service.discover(selected.keyword, selected.category) }) { read ->
                    if (filter != selected) return@load
                    if (read.isConfirmed) recentMatches.rememberRead(selected, read)
                    mutableState.update { state ->
                        val previous = state.matches?.takeIf { it.filter == selected }
                        state.copy(
                            matches = ConnectorMatches(selected, read.retaining(previous?.entries))
                        )
                    }
                }
            }
    }

    internal fun select(slug: String?) {
        val previous = mutableState.value
        if (previous.slug == slug) return
        previous.slug?.let { previousSlug ->
            val snapshot =
                ServiceReadSnapshot(
                    previous.detail.confirmed(),
                    previous.accounts.confirmed().retaining(previous.cachedAccounts),
                    previous.permissions.confirmed(),
                )
            if (
                snapshot.detail.isConfirmed ||
                    snapshot.accounts.isConfirmed ||
                    snapshot.permissions.isConfirmed
            ) {
                recentServices.rememberRead(previousSlug, snapshot)
            } else recentServices.remove(previousSlug)
        }
        cancelDetailReads()
        hidePermissions()
        impactJob?.cancel()
        impactJob = null
        val cached = slug?.let(recentServices::get)
        val accounts = cached?.accounts?.forEntry()
        mutableState.update {
            it.copy(
                slug = slug,
                detail = cached?.detail?.forEntry() ?: ConnectorRead(),
                accounts =
                    ConnectorRead(failure = accounts?.failure, expiresAt = accounts?.expiresAt),
                cachedAccounts = accounts?.takeIf { it.data != null },
                permissions = cached?.permissions?.forEntry() ?: ConnectorRead(),
                impact = null,
            )
        }
        refreshDetail()
    }

    private fun refreshDetail() {
        val slug = mutableState.value.slug ?: return
        if (detailJob?.isActive != true) {
            detailJob =
                viewModelScope.launch {
                    load({ service.detail(slug) }) { read ->
                        val unavailable = read.failure == ConnectorReadFailure.Unavailable
                        if (unavailable) {
                            permissionJob?.cancel()
                            permissionJob = null
                        }
                        mutableState.update { state ->
                            state.copy(
                                detail = read.retaining(state.detail),
                                permissions =
                                    if (unavailable)
                                        ConnectorRead(
                                            failure = read.failure,
                                            expiresAt = read.expiresAt,
                                        )
                                    else state.permissions,
                            )
                        }
                    }
                }
        }
        if (accountsJob?.isActive != true) {
            accountsJob =
                viewModelScope.launch {
                    load({ service.accounts(slug) }) { read ->
                        if (read.data != null) publishAccounts(slug, read.data)
                        else
                            mutableState.update { state ->
                                val unavailable = read.failure == ConnectorReadFailure.Unavailable
                                state.copy(
                                    accounts = read.retaining(state.accounts),
                                    cachedAccounts =
                                        state.cachedAccounts.takeUnless { unavailable },
                                    connected =
                                        if (unavailable)
                                            state.connected.copy(
                                                data = state.connected.data?.minus(slug)
                                            )
                                        else state.connected,
                                )
                            }
                    }
                }
        }
    }

    internal fun showPermissions() {
        if (!permissionsRequested) {
            mutableState.update { it.copy(permissions = it.permissions.forEntry()) }
        }
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
                load({ service.permissions(slug) }) { read ->
                    mutableState.update { state ->
                        state.copy(permissions = read.retaining(state.permissions))
                    }
                }
            }
    }

    internal fun prepareDisconnect(id: String) {
        if (!canStart() || currentAccount(id) == null) return
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
                retryConnectorRead(
                    read = { service.impact(slug, id) },
                    canRead = { authorized() && open && foreground },
                    onError = ::reportSessionFailure,
                    publish = { read ->
                        mutableState.update { state ->
                            state.copy(
                                impact = ConnectorImpact(id, read.retaining(state.impact?.read))
                            )
                        }
                    },
                    canRetry = { !mutableState.value.offline },
                )
            }
    }

    internal fun rename(id: String, name: String) {
        val label = name.trim()
        val target = currentAccount(id) ?: return
        if (label.isEmpty() || label.length > CONNECTOR_ACCOUNT_NAME_LIMIT) return
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
                if (
                    error is CancellationException ||
                        error.connectionFailed() ||
                        !error.hasUncertainResponse()
                ) {
                    throw error
                }
                pendingChange = change
                updateAction {
                    it.copy(reconciling = true, problem = ConnectorProblem.VerificationPending)
                }
                if (!mutableState.value.offline) verifyChange(change)
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
        runAction(action) {
            verifyChange(pending)
            if (open) {
                refreshDirectory()
                refreshDetail()
            }
        }
    }

    private suspend fun verifyChange(change: PendingChange) {
        val accounts = service.accounts(change.target.slug)
        invalidateConnectionReads()
        publishAccounts(change.target.slug, accounts)
        if (change.matches(accounts.find { it.id == change.target.connectionId })) {
            pendingChange = null
            complete(change.target, change.result)
            return
        }

        // The read can race a commit after a lost response. Keep checking the original account.
        change.unmatchedReads++
        val keepChecking = change.unmatchedReads < ACCOUNT_READBACK_LIMIT
        if (!keepChecking) {
            pendingChange = null
            verificationFailures = 0
        }
        updateAction {
            it.copy(reconciling = keepChecking, problem = ConnectorProblem.VerificationPending)
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
            state.action?.target == target &&
                state.action.problem == ConnectorProblem.AuthorizationUnconfirmed
        )
            return
        if (
            id != null &&
                state.accountsFor(target.slug).find { it.id == id }?.authMethod != methodId
        )
            return
        if (!canStart()) return
        val mayAuthorize =
            method.grantKind == ConnectorDetailConnectorAuthMethodsItemGrantKind.MANUAL ||
                method.grantKind == ConnectorDetailConnectorAuthMethodsItemGrantKind.NONE ||
                method.grantKind == ConnectorDetailConnectorAuthMethodsItemGrantKind.AUTOMATIC
        runAction(ConnectorAction(target), mayAuthorize = mayAuthorize) {
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
        if (!open || !authorized() || action.busy) return
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
                        if (!error.hasUncertainResponse()) break
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
        if (!open || code.isBlank() || code.trim().length > 4096 || action.busy) return
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
        if (!open || action.busy || actionJob?.isActive == true) return
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
        verificationJob?.cancel()
        verificationJob = null
        verificationFailures = 0
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
            foreground &&
            actionJob?.isActive != true &&
            mutableState.value.canChangeAccounts

    private fun invalidateConnectionReads() {
        browseJob?.cancel()
        connectedJob?.cancel()
        inspectionJob?.cancel()
        cancelDetailReads()
    }

    private fun cancelReads() {
        invalidateConnectionReads()
        matchesJob?.cancel()
        permissionJob?.cancel()
    }

    private fun cancelDetailReads() {
        detailJob?.cancel()
        accountsJob?.cancel()
    }

    private fun replaceAccount(
        target: ConnectorAccountTarget,
        id: String,
        replace: (ConnectorSavedAccount) -> ConnectorSavedAccount?,
    ) {
        val slug = target.slug
        fun update(accounts: List<ConnectorSavedAccount>) =
            accounts.mapNotNull { if (it.id == id) replace(it) else it }

        invalidateConnectionReads()
        recentServices[slug]?.let { cached ->
            recentServices[slug] =
                cached.copy(
                    accounts = cached.accounts.copy(data = cached.accounts.data?.let(::update))
                )
        }
        mutableState.update { state ->
            val overview = state.connected.data
            val service = overview?.get(slug)
            val updated =
                if (overview == null || service == null) overview
                else {
                    val accounts = update(service.accounts)
                    if (accounts.isEmpty()) overview - slug
                    else overview + (slug to service.copy(accounts = accounts))
                }
            state.copy(
                connected = state.connected.copy(data = updated),
                accounts =
                    if (state.slug == slug)
                        state.accounts.copy(data = state.accounts.data?.let(::update))
                    else state.accounts,
                cachedAccounts =
                    if (state.slug == slug)
                        state.cachedAccounts?.let { it.copy(data = it.data?.let(::update)) }
                    else state.cachedAccounts,
            )
        }
    }

    private fun publishAccounts(slug: String, accounts: List<ConnectorSavedAccount>) {
        val confirmed =
            ConnectorRead(accounts, expiresAt = readClock.markNow() + CONNECTOR_READ_LIFETIME)
        val cached = recentServices[slug]
        if (cached != null) recentServices[slug] = cached.copy(accounts = confirmed)
        mutableState.update { state ->
            val knownServices = state.connected.data
            val label =
                state.detail.data?.entry?.takeIf { it.slug == slug }?.name
                    ?: knownServices?.get(slug)?.label
                    ?: cached?.detail?.data?.entry?.name
            val services =
                when {
                    knownServices == null -> null
                    accounts.isEmpty() -> knownServices - slug
                    label != null -> knownServices + (slug to ConnectedService(label, accounts))
                    else -> knownServices
                }
            state.copy(
                connected = state.connected.copy(data = services),
                accounts = if (state.slug == slug) confirmed else state.accounts,
                cachedAccounts = if (state.slug == slug) null else state.cachedAccounts,
            )
        }
    }

    private fun runAction(
        action: ConnectorAction,
        mayAuthorize: Boolean = false,
        block: suspend () -> Unit,
    ) {
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
                    val canRetryBrowserReceipt =
                        error.hasUncertainResponse() && !authorizationExpired()
                    if (definitive) pendingChange = null
                    updateAction {
                        val verifying =
                            !definitive &&
                                (it.reconciling ||
                                    it.awaitingBrowserReceipt && canRetryBrowserReceipt)
                        it.copy(
                            reconciling = it.reconciling && !definitive,
                            authorization =
                                if (definitive && it.reconciling) null else it.authorization,
                            problem =
                                when {
                                    verifying && error.connectionFailed() ->
                                        ConnectorProblem.VerificationNetwork
                                    verifying -> ConnectorProblem.VerificationPending
                                    error.connectionFailed() -> ConnectorProblem.Network
                                    mayAuthorize && error.hasUncertainResponse() ->
                                        ConnectorProblem.AuthorizationUnconfirmed
                                    else -> ConnectorProblem.Failed
                                },
                        )
                    }
                    if (
                        mutableState.value.action?.problem ==
                            ConnectorProblem.AuthorizationUnconfirmed
                    ) {
                        // The user can inspect the saved accounts after closing the form.
                        // A read started before the attempt cannot establish that list.
                        invalidateConnectionReads()
                        mutableState.update { state ->
                            if (state.slug != action.target.slug) state
                            else
                                state.copy(
                                    accounts = ConnectorRead(),
                                    cachedAccounts =
                                        state.accounts.takeIf { it.data != null }
                                            ?: state.cachedAccounts,
                                )
                        }
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
        val authReadback =
            action?.authorization is ConnectorAuthorization.Receipt ||
                action?.let {
                    it.awaitingBrowserReceipt &&
                        (it.problem == ConnectorProblem.VerificationPending ||
                            it.problem == ConnectorProblem.VerificationNetwork)
                } == true
        if (
            !open ||
                !foreground ||
                !authorized() ||
                mutableState.value.offline ||
                verificationJob?.isActive == true ||
                (pendingChange == null && !authReadback)
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
                if (open && foreground && !mutableState.value.offline) {
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

    private suspend fun <T : Any> load(read: suspend () -> T, publish: (ConnectorRead<T>) -> Unit) =
        retryConnectorRead(
            read,
            canRead = { authorized() && open && foreground && !mutableState.value.offline },
            onError = ::reportSessionFailure,
            publish = {
                publish(
                    if (it.isConfirmed)
                        it.copy(expiresAt = readClock.markNow() + CONNECTOR_READ_LIFETIME)
                    else it
                )
            },
        )

    private class PendingChange(
        val target: ConnectorAccountTarget,
        val result: ConnectorResult?,
        val matches: (ConnectorSavedAccount?) -> Boolean,
    ) {
        var unmatchedReads = 0
    }
}

private fun <K, V> LinkedHashMap<K, V>.rememberRead(key: K, value: V) {
    this[key] = value
    if (size > RECENT_READ_LIMIT) remove(keys.first())
}

private val ConnectorAction.awaitingBrowserReceipt: Boolean
    get() = browserOpened && authorization is ConnectorAuthorization.Browser

private fun Exception.hasUncertainResponse() =
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
