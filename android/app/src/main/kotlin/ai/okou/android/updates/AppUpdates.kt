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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException

fun androidVersionCode(version: String): Long? {
    if (!Regex("\\d+\\.\\d+\\.\\d+").matches(version)) return null
    val parts = version.split('.').map { it.toLongOrNull() ?: return null }
    if (parts[0] > 2147 || parts[1] >= 1000 || parts[2] >= 1000) return null
    return (parts[0] * 1_000_000 + parts[1] * 1000 + parts[2]).takeIf { it in 1..Int.MAX_VALUE }
}

enum class UpdateCheck {
    Unknown,
    Checking,
    Checked,
    Failed,
}

enum class UpdateTransfer {
    Idle,
    Downloading,
    Ready,
    Failed,
    Interrupted,
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
    val transfer: UpdateTransfer = UpdateTransfer.Idle,
    val target: AndroidUpdatesRelease? = null,
    val downloadedBytes: Long = 0,
    val problem: UpdateProblem? = null,
    val sdk: Int,
) {
    val release
        get() =
            when (transfer) {
                UpdateTransfer.Downloading,
                UpdateTransfer.Ready -> target
                else -> info?.release
            }

    val available
        get() =
            release?.let { it.versionCode > checkNotNull(androidVersionCode(installedVersion)) } ==
                true

    val suitable
        get() =
            available &&
                release!!.minimumSdk <= sdk &&
                (minimum == null ||
                    release!!.versionCode >= checkNotNull(androidVersionCode(minimum)))

    val announce
        get() =
            !required &&
                available &&
                (deferred != release?.version ||
                    transfer == UpdateTransfer.Downloading ||
                    transfer == UpdateTransfer.Ready)
}

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

    suspend fun recover(release: AndroidUpdatesRelease?): File?

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
                            target = saved.target,
                        )
                }
                service.initialize()
                val file = service.recover(saved?.target)
                if (saved?.target != null) {
                    mutable.update {
                        it.copy(
                            transfer =
                                if (file != null) UpdateTransfer.Ready
                                else UpdateTransfer.Interrupted,
                            problem = if (file == null) UpdateProblem.Interrupted else null,
                        )
                    }
                }
            } catch (error: Exception) {
                report(error, UpdateProblem.Storage)
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
                if (!manual && checkedAt > 0 && now() - checkedAt in 0 until 86_400_000)
                    return@launch
                if (!manual && attemptedAt > 0 && now() - attemptedAt in 0 until 60_000)
                    return@launch
                attemptedAt = now()
                mutable.update { it.copy(check = UpdateCheck.Checking) }
                try {
                    val info = service.check()
                    val floor = higherMinimum(mutable.value.minimum, info.minimumSupportedVersion)
                    val blocked =
                        mutable.value.required ||
                            floor?.let {
                                checkNotNull(androidVersionCode(it)) > androidVersionCode(version)!!
                            } == true
                    checkedAt = now()
                    mutable.update {
                        it.copy(
                            info = info,
                            minimum = floor,
                            required = blocked,
                            check = UpdateCheck.Checked,
                            problem = if (it.problem == UpdateProblem.Check) null else it.problem,
                        )
                    }
                    retireUnsuitableTransfer()
                    persist()
                } catch (error: Exception) {
                    currentCoroutineContext().ensureActive()
                    report(error, UpdateProblem.Check)
                    mutable.update { it.copy(check = UpdateCheck.Failed) }
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
                report(error, UpdateProblem.Storage)
            }
            check(manual = true)
        }
    }

    fun defer() {
        scope.launch {
            initialized.await()
            if (mutable.value.required) return@launch
            mutable.update { it.copy(deferred = it.release?.version) }
            try {
                persist()
            } catch (error: Exception) {
                report(error, UpdateProblem.Storage)
            }
        }
    }

    fun download() {
        if (transferJob?.isActive == true) return
        transferJob =
            scope.launch {
                initialized.await()
                val snapshot = mutable.value
                if (
                    snapshot.transfer == UpdateTransfer.Ready ||
                        snapshot.transfer == UpdateTransfer.Downloading
                )
                    return@launch
                val release = snapshot.release?.takeIf { snapshot.suitable } ?: return@launch
                val ticket = ++transferTicket
                mutable.update {
                    it.copy(
                        target = release,
                        transfer = UpdateTransfer.Downloading,
                        downloadedBytes = 0,
                        problem = null,
                    )
                }
                try {
                    persist()
                    service.download(release) { bytes ->
                        mutable.update {
                            if (ticket == transferTicket) it.copy(downloadedBytes = bytes) else it
                        }
                    }
                    currentCoroutineContext().ensureActive()
                    if (ticket == transferTicket)
                        mutable.update { it.copy(transfer = UpdateTransfer.Ready) }
                } catch (error: Exception) {
                    currentCoroutineContext().ensureActive()
                    if (ticket == transferTicket) {
                        report(error, UpdateProblem.Download)
                        mutable.update { it.copy(transfer = UpdateTransfer.Failed) }
                    }
                }
            }
    }

    fun cancelDownload() {
        ++transferTicket
        transferJob?.cancel()
        transferJob = null
        mutable.update {
            it.copy(
                transfer = UpdateTransfer.Idle,
                target = null,
                downloadedBytes = 0,
                problem = null,
            )
        }
        scope.launch {
            try {
                persist()
            } catch (error: Exception) {
                report(error, UpdateProblem.Storage)
            }
        }
    }

    suspend fun installationFile(): File? {
        initialized.await()
        val snapshot = mutable.value
        val release =
            snapshot.release?.takeIf {
                snapshot.suitable && snapshot.transfer == UpdateTransfer.Ready
            } ?: return null
        return try {
            val file = service.recover(release) ?: throw UpdateException(UpdateProblem.Download)
            if (mutable.value.release == release && mutable.value.suitable) file else null
        } catch (error: Exception) {
            currentCoroutineContext().ensureActive()
            val failure = classify(error, UpdateProblem.Download)
            mutable.update {
                if (it.release == release && it.transfer == UpdateTransfer.Ready)
                    it.copy(transfer = UpdateTransfer.Failed, problem = failure)
                else it
            }
            null
        }
    }

    fun installFailed() {
        mutable.update { it.copy(problem = UpdateProblem.Install) }
    }

    private fun retireUnsuitableTransfer() {
        if (mutable.value.target != null && !mutable.value.suitable) cancelDownload()
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
                    value.target,
                )
            )
        }

    private fun report(error: Exception, fallback: UpdateProblem) {
        val problem = classify(error, fallback)
        mutable.update { it.copy(problem = problem) }
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
    listOfNotNull(first, second)
        .filter { androidVersionCode(it) != null }
        .maxByOrNull { androidVersionCode(it)!! }
