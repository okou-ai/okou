package ai.okou.android.updates

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.RequiredUpdate
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.AndroidUpdatesRelease
import java.io.Closeable
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException

enum class UpdateCheck {
    Unknown,
    Checking,
    Checked,
    Failed,
}

sealed interface UpdateTransfer {
    data class Recovering(val release: AndroidUpdatesRelease?) : UpdateTransfer

    data object Idle : UpdateTransfer

    data class Downloading(val release: AndroidUpdatesRelease, val downloadedBytes: Long? = null) :
        UpdateTransfer

    data class Ready(val release: AndroidUpdatesRelease) : UpdateTransfer

    data object Failed : UpdateTransfer

    data object Interrupted : UpdateTransfer
}

enum class UpdateProblem {
    Check,
    Download,
    Integrity,
    Identity,
    Storage,
    Interrupted,
    Install,
}

class UpdateException(val problem: UpdateProblem) : IOException("App update failed: $problem")

data class UpdateUiState(
    val installedVersion: String,
    val info: AndroidUpdates? = null,
    val check: UpdateCheck = UpdateCheck.Unknown,
    val required: Boolean = false,
    val minimum: String? = null,
    val deferred: String? = null,
    val transfer: UpdateTransfer = UpdateTransfer.Recovering(null),
    val problem: UpdateProblem? = null,
    val sdk: Int,
    val offline: Boolean = false,
) {
    val candidate
        get() = info?.release

    val selectedRelease
        get() =
            when (val transfer = transfer) {
                is UpdateTransfer.Recovering -> transfer.release
                is UpdateTransfer.Downloading -> transfer.release
                is UpdateTransfer.Ready -> transfer.release
                UpdateTransfer.Idle,
                UpdateTransfer.Failed,
                UpdateTransfer.Interrupted -> null
            }

    /** Presentation only; actions bind either the discovery candidate or a selected package. */
    val displayedRelease
        get() = selectedRelease ?: candidate

    val preparing
        get() = transfer is UpdateTransfer.Recovering

    val available
        get() =
            displayedRelease?.let {
                checkNotNull(compareAndroidVersions(it.version, installedVersion)) > 0
            } == true

    fun isEligible(release: AndroidUpdatesRelease) =
        checkNotNull(compareAndroidVersions(release.version, installedVersion)) > 0 &&
            release.minimumSdk <= sdk &&
            (minimum == null || checkNotNull(compareAndroidVersions(release.version, minimum)) >= 0)

    val canDownload
        get() =
            when (transfer) {
                UpdateTransfer.Idle,
                UpdateTransfer.Failed,
                UpdateTransfer.Interrupted -> candidate?.let(::isEligible) == true
                is UpdateTransfer.Recovering,
                is UpdateTransfer.Downloading,
                is UpdateTransfer.Ready -> false
            }

    val canInstall
        get() = (transfer as? UpdateTransfer.Ready)?.release?.let(::isEligible) == true

    val announce
        get() =
            !preparing &&
                !required &&
                available &&
                (deferred != displayedRelease?.version ||
                    transfer is UpdateTransfer.Downloading ||
                    transfer is UpdateTransfer.Ready)
}

private val UpdateUiState.needsRequiredRelease: Boolean
    get() = required && displayedRelease?.let(::isEligible) != true

@Serializable
data class UpdateRecord(
    val installedVersion: String,
    val info: AndroidUpdates? = null,
    val blocked: Boolean = false,
    val minimum: String? = null,
    val deferred: String? = null,
    val checkedAt: Long = 0,
    val target: AndroidUpdatesRelease? = null,
)

interface UpdateStore {
    suspend fun load(): UpdateRecord?

    suspend fun save(record: UpdateRecord)
}

interface UpdateService : Closeable {
    suspend fun initialize()

    suspend fun check(): AndroidUpdates

    suspend fun recover(release: AndroidUpdatesRelease): File?

    suspend fun download(release: AndroidUpdatesRelease, progress: (Long) -> Unit): File
}

/** Application-owned policy and transfer; no account, Activity, or saved-state ownership. */
class AppUpdates(
    private val service: UpdateService,
    private val store: UpdateStore,
    private val version: String,
    sdk: Int,
    dispatcher: CoroutineDispatcher = Dispatchers.Main.immediate,
    private val now: () -> Long = System::currentTimeMillis,
    connectivity: Flow<Boolean> = emptyFlow(),
) : Closeable {
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val mutable = MutableStateFlow(UpdateUiState(version, sdk = sdk))
    val state = mutable.asStateFlow()
    val required = state.map { it.required }.stateIn(scope, SharingStarted.Eagerly, false)
    private val initialized = CompletableDeferred<Unit>()
    private val persistence = Mutex()
    private var checkedAt = 0L
    private var attemptedAt = 0L
    private var checkJob: Job? = null
    private var transferJob: Job? = null
    @Volatile private var transferTicket = 0L

    init {
        scope.launch {
            connectivity.collectLatest { online ->
                val reconnected = online && mutable.value.offline
                mutable.update { it.copy(offline = !online) }
                if (reconnected) {
                    initialized.await()
                    checkJob?.join()
                    check(manual = mutable.value.needsRequiredRelease)
                }
            }
        }
        scope.launch {
            try {
                val saved = store.load()?.takeIf { it.installedVersion == version }
                if (saved != null) {
                    checkedAt = saved.checkedAt
                    mutable.value =
                        mutable.value.copy(
                            info = saved.info,
                            required = saved.blocked,
                            minimum = saved.minimum,
                            deferred = saved.deferred,
                            check =
                                if (saved.info != null) UpdateCheck.Checked
                                else UpdateCheck.Unknown,
                            transfer = UpdateTransfer.Recovering(saved.target),
                        )
                }
                service.initialize()
                val target = saved?.target
                val file = target?.let { service.recover(it) }
                mutable.update {
                    it.copy(
                        transfer =
                            when {
                                target == null -> UpdateTransfer.Idle
                                file != null -> UpdateTransfer.Ready(target)
                                else -> UpdateTransfer.Interrupted
                            },
                        problem =
                            if (target != null && file == null) UpdateProblem.Interrupted else null,
                    )
                }
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                val failure = classify(error, UpdateProblem.Storage)
                mutable.update { it.copy(transfer = UpdateTransfer.Failed, problem = failure) }
            } finally {
                initialized.complete(Unit)
            }
        }
    }

    fun check(manual: Boolean = true) {
        if (checkJob?.isActive == true) return
        checkJob =
            scope.launch {
                initialized.await()
                val snapshot = mutable.value
                if (snapshot.offline) return@launch
                if (
                    !manual &&
                        !snapshot.needsRequiredRelease &&
                        checkedAt > 0 &&
                        now() - checkedAt in 0 until 86_400_000
                )
                    return@launch
                if (!manual && attemptedAt > 0 && now() - attemptedAt in 0 until 60_000)
                    return@launch
                attemptedAt = now()
                mutable.update { it.copy(check = UpdateCheck.Checking) }
                val info =
                    try {
                        service.check()
                    } catch (error: Exception) {
                        currentCoroutineContext().ensureActive()
                        classify(error, UpdateProblem.Check)
                        // A discovery failure leaves the selected package and its outcome intact.
                        mutable.update { it.copy(check = UpdateCheck.Failed) }
                        return@launch
                    }
                val floor = higherMinimum(mutable.value.minimum, info.minimumSupportedVersion)
                val blocked =
                    mutable.value.required ||
                        floor?.let { checkNotNull(compareAndroidVersions(it, version)) > 0 } == true
                checkedAt = now()
                mutable.update {
                    it.copy(
                        info = info,
                        minimum = floor,
                        required = blocked,
                        check = UpdateCheck.Checked,
                    )
                }
                retireUnsuitableTransfer()
                try {
                    persist()
                } catch (error: Exception) {
                    reportStorageFailure(error)
                }
            }
    }

    fun requireUpdate(requirement: RequiredUpdate) {
        scope.launch {
            initialized.await()
            mutable.update {
                it.copy(
                    required = true,
                    minimum = higherMinimum(it.minimum, requirement.minimumSupportedVersion),
                )
            }
            retireUnsuitableTransfer()
            try {
                persist()
            } catch (error: Exception) {
                reportStorageFailure(error)
            }
            if (mutable.value.needsRequiredRelease) check()
        }
    }

    fun defer(release: AndroidUpdatesRelease) {
        val snapshot = mutable.value
        if (snapshot.preparing || snapshot.required || snapshot.displayedRelease != release) return
        mutable.update { it.copy(deferred = release.version) }
        scope.launch {
            try {
                persist()
            } catch (error: Exception) {
                reportStorageFailure(error)
            }
        }
    }

    fun download(release: AndroidUpdatesRelease): Boolean {
        val offered = mutable.value
        if (offered.offline || !offered.canDownload || offered.candidate != release) return false
        if (transferJob?.isActive == true) return false
        transferJob =
            scope.launch {
                val snapshot = mutable.value
                if (snapshot.offline || !snapshot.canDownload || snapshot.candidate != release)
                    return@launch
                val ticket = ++transferTicket
                mutable.update {
                    it.copy(transfer = UpdateTransfer.Downloading(release), problem = null)
                }
                try {
                    persist()
                    service.download(release) { bytes ->
                        mutable.update {
                            val transfer = it.transfer
                            if (ticket == transferTicket && transfer is UpdateTransfer.Downloading)
                                it.copy(transfer = transfer.copy(downloadedBytes = bytes))
                            else it
                        }
                    }
                    currentCoroutineContext().ensureActive()
                    if (ticket == transferTicket)
                        mutable.update { it.copy(transfer = UpdateTransfer.Ready(release)) }
                } catch (error: Exception) {
                    currentCoroutineContext().ensureActive()
                    if (ticket == transferTicket) {
                        val failure = classify(error, UpdateProblem.Download)
                        mutable.update {
                            it.copy(transfer = UpdateTransfer.Failed, problem = failure)
                        }
                    }
                }
            }
        return true
    }

    private fun discardTransfer() {
        ++transferTicket
        transferJob?.cancel()
        transferJob = null
        mutable.update { it.copy(transfer = UpdateTransfer.Idle, problem = null) }
        scope.launch {
            try {
                persist()
            } catch (error: Exception) {
                reportStorageFailure(error)
            }
        }
    }

    suspend fun installationFile(release: AndroidUpdatesRelease): File? {
        val snapshot = mutable.value
        val selected = snapshot.transfer as? UpdateTransfer.Ready ?: return null
        if (selected.release != release || !snapshot.canInstall) return null
        return try {
            val file = service.recover(release) ?: throw UpdateException(UpdateProblem.Download)
            val current = mutable.value
            if (current.transfer == selected && current.canInstall) file else null
        } catch (error: Exception) {
            currentCoroutineContext().ensureActive()
            val failure = classify(error, UpdateProblem.Download)
            mutable.update {
                if (it.transfer == selected)
                    it.copy(transfer = UpdateTransfer.Failed, problem = failure)
                else it
            }
            null
        }
    }

    fun installFailed(release: AndroidUpdatesRelease) {
        mutable.update {
            if ((it.transfer as? UpdateTransfer.Ready)?.release == release)
                it.copy(problem = UpdateProblem.Install)
            else it
        }
    }

    fun clearInstallFailure(release: AndroidUpdatesRelease) {
        mutable.update {
            if (it.problem == UpdateProblem.Install && it.selectedRelease == release)
                it.copy(problem = null)
            else it
        }
    }

    private fun retireUnsuitableTransfer() {
        val snapshot = mutable.value
        val selected = snapshot.selectedRelease ?: return
        if (!snapshot.isEligible(selected)) discardTransfer()
    }

    private suspend fun persist() =
        persistence.withLock {
            val value = mutable.value
            store.save(
                UpdateRecord(
                    version,
                    value.info,
                    value.required,
                    value.minimum,
                    value.deferred,
                    checkedAt,
                    value.selectedRelease,
                )
            )
        }

    private fun reportStorageFailure(error: Exception) {
        val problem = classify(error, UpdateProblem.Storage)
        mutable.update { it.copy(problem = it.problem ?: problem) }
    }

    private fun classify(error: Exception, fallback: UpdateProblem): UpdateProblem =
        when (error) {
            is UpdateException -> error.problem
            is ApiFailure.Http -> fallback
            is IOException,
            is SerializationException -> fallback
            else -> throw error
        }

    override fun close() {
        scope.cancel()
        service.close()
    }
}

private fun higherMinimum(first: String?, second: String?): String? =
    listOfNotNull(first, second).filter(::isAndroidVersion).maxWithOrNull { left, right ->
        checkNotNull(compareAndroidVersions(left, right))
    }
