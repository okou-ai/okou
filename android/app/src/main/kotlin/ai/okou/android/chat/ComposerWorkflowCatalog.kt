package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ComposerWorkflows
import ai.okou.android.api.retryBoundedRead
import android.util.AtomicFile
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

interface ComposerWorkflowService {
    suspend fun composerWorkflows(): ComposerWorkflows

    suspend fun recentComposerWorkflows(): List<String>

    suspend fun recordComposerWorkflowUse(ids: List<String>): List<String>
}

@Serializable
internal data class ComposerWorkflowSnapshot(
    val workflows: ComposerWorkflows,
    val recent: List<String>,
)

internal data class ComposerWorkflowState(
    val snapshot: ComposerWorkflowSnapshot? = null,
    val failed: Boolean = false,
)

/** The attached workspace owns these reads and recent uses independently of chat delivery. */
internal class ComposerWorkflowCatalog(
    private val service: ComposerWorkflowService,
    private val file: File,
    private val scope: CoroutineScope,
    private val authorized: () -> Boolean,
    private val report: (Exception) -> Unit,
) {
    private val mutable = MutableStateFlow(ComposerWorkflowState())
    val state = mutable.asStateFlow()
    private val cacheUpdates = Mutex()
    private val recentUpdates = Mutex()
    private var catalogRead: Job? = null
    private var recentRead: Job? = null
    private var hydrated = false
    private var confirmedRecent = emptyList<String>()

    fun refresh() {
        val pendingCatalog = refreshCatalog() ?: return
        if (recentRead?.isActive == true) return
        recentRead = scope.launch {
            pendingCatalog.join()
            recentUpdates.withLock {
                val current = mutable.value
                if (!authorized() || current.failed || current.snapshot == null) return@withLock
                val recent =
                    try {
                        service.recentComposerWorkflows()
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        reportSessionFailure(error)
                        return@withLock
                    }
                updateRecent(recent, confirmed = true)
            }
        }
    }

    private fun refreshCatalog(): Job? {
        if (!authorized()) return null
        val pending = catalogRead
        if (pending?.isActive == true) return pending
        mutable.value = mutable.value.copy(failed = false)
        return scope
            .launch {
                hydrate()
                val failure =
                    retryBoundedRead(authorized) {
                        val workflows =
                            try {
                                service.composerWorkflows()
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (error: Exception) {
                                reportSessionFailure(error)
                                return@retryBoundedRead error
                            }
                        cacheUpdates.withLock {
                            if (!authorized()) return@withLock
                            val recent = mutable.value.snapshot?.recent.orEmpty()
                            mutable.value =
                                ComposerWorkflowState(ComposerWorkflowSnapshot(workflows, recent))
                            save(ComposerWorkflowSnapshot(workflows, confirmedRecent))
                        }
                        null
                    }
                if (failure == null) return@launch
                cacheUpdates.withLock {
                    if (!authorized()) return@withLock
                    if (failure is ApiFailure.Http && failure.status in setOf(403, 404)) {
                        mutable.value = ComposerWorkflowState(failed = true)
                        confirmedRecent = emptyList()
                        withContext(cacheIo) { AtomicFile(file).delete() }
                    } else {
                        mutable.value = mutable.value.copy(failed = true)
                    }
                }
            }
            .also { catalogRead = it }
    }

    fun accepted(text: String) {
        if (!authorized()) return
        val commands = sentWorkflowNames(text)
        if (commands.isEmpty()) return
        scope.launch {
            hydrate()
            recentUpdates.withLock {
                val pending = catalogRead
                if (pending?.isActive == true) pending.join()
                else if (
                    mutable.value.snapshot?.workflows.orEmpty().count { it.name in commands } <
                        commands.size
                )
                    refreshCatalog()?.join()
                val snapshot = mutable.value.snapshot ?: return@withLock
                val ids = snapshot.workflows.filter { it.name in commands }.map { it.id }
                if (!authorized() || ids.isEmpty()) return@withLock
                val recent =
                    try {
                        service.recordComposerWorkflowUse(ids)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        reportSessionFailure(error)
                        updateRecent((ids + snapshot.recent).distinct(), confirmed = false)
                        return@withLock
                    }
                updateRecent(recent, confirmed = true)
            }
        }
    }

    // Keep a local promotion after an accepted send, and cache only the server's ordering.
    private suspend fun updateRecent(recent: List<String>, confirmed: Boolean) =
        cacheUpdates.withLock {
            val state = mutable.value
            val snapshot = state.snapshot ?: return@withLock
            if (!authorized()) return@withLock
            mutable.value = state.copy(snapshot = snapshot.copy(recent = recent))
            if (confirmed && confirmedRecent != recent) {
                confirmedRecent = recent
                save(snapshot.copy(recent = recent))
            }
        }

    private fun reportSessionFailure(error: Exception) {
        if (
            error is ApiFailure.UpdateRequired ||
                error is ApiFailure.Unauthenticated ||
                error is ApiFailure.Http && error.status == 401
        )
            report(error)
    }

    private suspend fun hydrate() = cacheUpdates.withLock {
        if (hydrated || !authorized()) return@withLock
        val saved =
            withContext(cacheIo) {
                try {
                    Json.decodeFromString<ComposerWorkflowSnapshot>(
                        AtomicFile(file).readFully().decodeToString(),
                    )
                } catch (_: IOException) {
                    null
                } catch (_: SerializationException) {
                    null
                }
            }
        if (authorized() && saved != null) {
            confirmedRecent = saved.recent
            mutable.value = ComposerWorkflowState(saved)
        }
        hydrated = true
    }

    private suspend fun save(snapshot: ComposerWorkflowSnapshot) {
        withContext(cacheIo) {
            val atomic = AtomicFile(file)
            try {
                val output = atomic.startWrite()
                try {
                    output.write(Json.encodeToString(snapshot).encodeToByteArray())
                    atomic.finishWrite(output)
                } catch (error: IOException) {
                    atomic.failWrite(output)
                    throw error
                }
            } catch (_: IOException) {
                // A confirmed response remains usable in memory when the cache cannot be written.
            }
        }
    }

    private companion object {
        // Replacement sessions with the same scope can reopen the same atomic file.
        val cacheIo = Dispatchers.IO.limitedParallelism(1)
    }
}
