package ai.okou.android.updates

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.RequiredUpdate
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.api.retryAfterDelayMillis
import java.io.Closeable
import java.io.EOFException
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketException
import java.net.UnknownHostException
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeMark
import kotlin.time.TimeSource
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException

enum class UpdateCheck {
    Unknown,
    Checking,
    Checked,
    Failed,
    Waiting,
}

sealed interface UpdateTransfer {
    data class Recovering(val release: AndroidUpdatesRelease?) : UpdateTransfer

    data object Idle : UpdateTransfer

    data class Downloading(val release: AndroidUpdatesRelease, val downloadedBytes: Long? = null) :
        UpdateTransfer

    data class Waiting(val release: AndroidUpdatesRelease) : UpdateTransfer

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
    val transfer: UpdateTransfer = UpdateTransfer.Recovering(null),
    val problem: UpdateProblem? = null,
    val sdk: Int,
) {
    val candidate
        get() = info?.release

    val selectedRelease
        get() =
            when (val transfer = transfer) {
                is UpdateTransfer.Recovering -> transfer.release
                is UpdateTransfer.Downloading -> transfer.release
                is UpdateTransfer.Waiting -> transfer.release
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

    internal val offeredRelease
        get() = displayedRelease?.takeIf(::meetsVersionRequirement)

    private fun meetsVersionRequirement(release: AndroidUpdatesRelease) =
        checkNotNull(compareAndroidVersions(release.version, installedVersion)) > 0 &&
            (minimum == null || checkNotNull(compareAndroidVersions(release.version, minimum)) >= 0)

    fun isEligible(release: AndroidUpdatesRelease) =
        meetsVersionRequirement(release) && release.minimumSdk <= sdk

    val canDownload
        get() =
            when (transfer) {
                UpdateTransfer.Idle,
                UpdateTransfer.Failed,
                UpdateTransfer.Interrupted -> candidate?.let(::isEligible) == true
                is UpdateTransfer.Recovering,
                is UpdateTransfer.Downloading,
                is UpdateTransfer.Waiting,
                is UpdateTransfer.Ready -> false
            }

    val canInstall
        get() = (transfer as? UpdateTransfer.Ready)?.release?.let(::isEligible) == true
}

private val UpdateUiState.needsRequiredRelease: Boolean
    get() = required && displayedRelease?.let(::isEligible) != true

private fun UpdateUiState.canRetryPackage(release: AndroidUpdatesRelease?): Boolean {
    val current = candidate ?: return false
    return release != null &&
        current.version == release.version &&
        current.sha256 == release.sha256 &&
        isEligible(current)
}

private fun UpdateUiState.withoutObsoleteFailure(previousCandidate: AndroidUpdatesRelease?) =
    if (
        (transfer == UpdateTransfer.Failed || transfer == UpdateTransfer.Interrupted) &&
            !canRetryPackage(previousCandidate)
    )
        copy(transfer = UpdateTransfer.Idle, problem = null)
    else this

private fun UpdateUiState.withDownloadFailure(
    release: AndroidUpdatesRelease,
    failure: UpdateProblem,
    phase: UpdateTransfer = UpdateTransfer.Failed,
) =
    if (canRetryPackage(release)) copy(transfer = phase, problem = failure)
    else copy(transfer = UpdateTransfer.Idle, problem = null)

@Serializable
data class UpdateRecord(
    val installedVersion: String,
    val info: AndroidUpdates? = null,
    val blocked: Boolean = false,
    val minimum: String? = null,
    val checkedAt: Long = 0,
    val target: AndroidUpdatesRelease? = null,
)

interface UpdateStore {
    suspend fun load(): UpdateRecord?

    suspend fun save(record: UpdateRecord)
}

interface UpdateService : Closeable {
    suspend fun initialize(retainedRelease: AndroidUpdatesRelease?)

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
    private val clock: TimeSource = TimeSource.Monotonic,
) : Closeable {
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val mutable = MutableStateFlow(UpdateUiState(version, sdk = sdk))
    val state = mutable.asStateFlow()
    val required = state.map { it.required }.stateIn(scope, SharingStarted.Eagerly, false)
    private val initialized = CompletableDeferred<Unit>()
    private val persistence = Mutex()
    private var checkedAt = 0L
    private var automaticCheckAfter: TimeMark? = null
    private var checkJob: Job? = null
    private var transferJob: Job? = null
    private val checkRetry = RetryDelay()
    private val downloadRetry = RetryDelay()
    @Volatile private var transferTicket = 0L

    init {
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
                            check =
                                if (saved.info != null) UpdateCheck.Checked
                                else UpdateCheck.Unknown,
                            transfer = UpdateTransfer.Recovering(saved.target),
                        )
                }
                val target = saved?.target?.takeIf(mutable.value::isEligible)
                service.initialize(target)
                val file = target?.let { service.recover(it) }
                mutable.update {
                    when {
                        target == null -> it.copy(transfer = UpdateTransfer.Idle)
                        file != null -> it.copy(transfer = UpdateTransfer.Ready(target))
                        else ->
                            it.withDownloadFailure(
                                target,
                                UpdateProblem.Interrupted,
                                UpdateTransfer.Interrupted,
                            )
                    }
                }
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                val failure = classify(error, UpdateProblem.Storage)
                mutable.update {
                    val selected = it.selectedRelease
                    if (selected == null || failure == UpdateProblem.Storage)
                        it.copy(transfer = UpdateTransfer.Failed, problem = failure)
                    else it.withDownloadFailure(selected, failure)
                }
            } finally {
                initialized.complete(Unit)
            }
        }
    }

    fun check(manual: Boolean = true) {
        val pendingCheck = checkJob
        if (pendingCheck?.isActive == true) {
            if (!manual) return
            if (initialized.isCompleted) {
                checkRetry.advance()
                return
            }
            // No request has started yet. Preserve the manual action through initialization.
            pendingCheck.cancel()
        }
        checkJob = scope.launch {
            initialized.await()
            if (!manual) {
                if (automaticCheckAfter?.hasNotPassedNow() == true) return@launch
                val recentlyChecked =
                    checkedAt > 0 && now() - checkedAt in 0 until 10.minutes.inWholeMilliseconds
                if (recentlyChecked && !mutable.value.needsRequiredRelease) return@launch
            }
            val info = readRelease() ?: return@launch
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
                    .withoutObsoleteFailure(it.candidate)
            }
            retireUnsuitableTransfer()
            try {
                persist()
            } catch (error: Exception) {
                reportStorageFailure(error)
            }
        }
    }

    private suspend fun readRelease(): AndroidUpdates? {
        automaticCheckAfter = null
        var retries = 0
        while (true) {
            mutable.update { it.copy(check = UpdateCheck.Checking) }
            try {
                return service.check().also { currentCoroutineContext().ensureActive() }
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                classify(error, UpdateProblem.Check)
                val retryable = error.isTemporaryNetworkFailure()
                if (!retryable || retries == 2) {
                    if (retryable) {
                        automaticCheckAfter = error.retryAfter()?.let { clock.markNow() + it }
                    }
                    mutable.update { it.copy(check = UpdateCheck.Failed) }
                    return null
                }
                retries++
                checkRetry.awaitNextAttempt(error) {
                    mutable.update { it.copy(check = UpdateCheck.Waiting) }
                }
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
                    .withoutObsoleteFailure(it.candidate)
            }
            retireUnsuitableTransfer()
            try {
                persist()
            } catch (error: Exception) {
                reportStorageFailure(error)
            }
            if (mutable.value.needsRequiredRelease) check(manual = false)
        }
    }

    fun download(release: AndroidUpdatesRelease, advanceRetry: Boolean = false): Boolean {
        val offered = mutable.value
        if (transferJob?.isActive == true) {
            return advanceRetry &&
                (offered.transfer as? UpdateTransfer.Waiting)?.release == release &&
                downloadRetry.advance()
        }
        if (!offered.canDownload || offered.candidate != release) return false
        transferJob = scope.launch {
            val snapshot = mutable.value
            if (!snapshot.canDownload || snapshot.candidate != release) return@launch
            val ticket = ++transferTicket
            mutable.update {
                it.copy(transfer = UpdateTransfer.Downloading(release), problem = null)
            }
            downloadSelected(release, ticket)
        }
        return true
    }

    private suspend fun downloadSelected(release: AndroidUpdatesRelease, ticket: Long) {
        var retries = 0
        while (ticket == transferTicket) {
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
                    mutable.update {
                        it.copy(transfer = UpdateTransfer.Ready(release), problem = null)
                    }
                return
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                if (ticket != transferTicket) return
                val failure = classify(error, UpdateProblem.Download)
                if (!error.isTemporaryNetworkFailure() || retries == 2) {
                    mutable.update { it.withDownloadFailure(release, failure) }
                    return
                }
                retries++
                downloadRetry.awaitNextAttempt(error) {
                    mutable.update {
                        it.copy(transfer = UpdateTransfer.Waiting(release), problem = failure)
                    }
                }
                if (ticket != transferTicket) return
                mutable.update {
                    it.copy(transfer = UpdateTransfer.Downloading(release), problem = null)
                }
            }
        }
    }

    private class RetryDelay {
        private var pending: CompletableDeferred<Unit>? = null

        fun advance() = pending?.complete(Unit) == true

        suspend fun awaitNextAttempt(error: Exception, showWaiting: () -> Unit) {
            val signal = CompletableDeferred<Unit>()
            pending = signal
            try {
                showWaiting()
                withTimeoutOrNull(error.retryAfter() ?: 3.seconds) { signal.await() }
            } finally {
                if (pending === signal) pending = null
            }
        }
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
                if (it.transfer == selected) it.withDownloadFailure(release, failure) else it
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

    private suspend fun persist() = persistence.withLock {
        val value = mutable.value
        store.save(
            UpdateRecord(
                installedVersion = version,
                info = value.info,
                blocked = value.required,
                minimum = value.minimum,
                checkedAt = checkedAt,
                target = value.selectedRelease,
            ),
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
            is ApiFailure.Network -> fallback
            is IOException,
            is SerializationException -> fallback
            else -> throw error
        }

    override fun close() {
        scope.cancel()
        service.close()
    }
}

private fun Exception.retryAfter() =
    retryAfterDelayMillis((this as? ApiFailure.Http)?.retryAfterSeconds)?.milliseconds

private fun Exception.isTemporaryNetworkFailure(): Boolean =
    when (this) {
        is ApiFailure.Http -> status == 408 || status == 429 || status in 500..599
        is ApiFailure.Network,
        is InterruptedIOException,
        is SocketException,
        is UnknownHostException,
        is EOFException -> true
        else -> false
    }

private fun higherMinimum(first: String?, second: String?): String? =
    listOfNotNull(first, second).filter(::isAndroidVersion).maxWithOrNull { left, right ->
        checkNotNull(compareAndroidVersions(left, right))
    }
