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

/** One cache and refresh per attached workspace composer. Sending never waits for this owner. */
internal class ComposerWorkflowCatalog(
    private val service: ComposerWorkflowService,
    private val file: File,
    private val scope: CoroutineScope,
    private val authorized: () -> Boolean,
    private val report: (Exception) -> Unit,
) {
    private val mutable = MutableStateFlow(ComposerWorkflowState())
    val state = mutable.asStateFlow()
    private val updates = Mutex()
    private var read: Job? = null
    private var hydrated = false

    fun refresh() {
        if (!authorized() || read?.isActive == true) return
        mutable.value = mutable.value.copy(failed = false)
        read = scope.launch {
            hydrate()
            val failure =
                retryBoundedRead(authorized) {
                    try {
                        val workflows = service.composerWorkflows()
                        if (authorized()) {
                            updates.withLock {
                                val recent = readRecent()
                                if (authorized())
                                    publish(ComposerWorkflowSnapshot(workflows, recent))
                            }
                        }
                        null
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        reportSessionFailure(error)
                        error
                    }
                }
            if (!authorized() || failure == null) return@launch
            updates.withLock {
                if (failure is ApiFailure.Http && failure.status in setOf(403, 404)) {
                    mutable.value = ComposerWorkflowState(failed = true)
                    withContext(Dispatchers.IO) { AtomicFile(file).delete() }
                } else {
                    mutable.value = mutable.value.copy(failed = true)
                }
            }
        }
    }

    private suspend fun readRecent(): List<String> =
        try {
            service.recentComposerWorkflows()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            reportSessionFailure(error)
            mutable.value.snapshot?.recent.orEmpty()
        }

    fun accepted(text: String) {
        if ('/' !in text) return
        val commands = text.split(whitespace).filter { it.startsWith("/") }.toSet()
        if (commands.isEmpty()) return
        scope.launch {
            hydrate()
            if (mutable.value.snapshot == null) {
                refresh()
                read?.join()
            }
            updates.withLock {
                val snapshot = mutable.value.snapshot ?: return@withLock
                val ids = snapshot.workflows.filter { "/${it.name}" in commands }.map { it.id }
                if (!authorized() || ids.isEmpty()) return@withLock
                val recent =
                    try {
                        service.recordComposerWorkflowUse(ids)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        reportSessionFailure(error)
                        (ids + snapshot.recent).distinct().take(50)
                    }
                if (authorized()) publish(snapshot.copy(recent = recent))
            }
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

    private suspend fun hydrate() = updates.withLock {
        if (hydrated || !authorized()) return@withLock
        val saved =
            withContext(Dispatchers.IO) {
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
        if (authorized() && saved != null) mutable.value = ComposerWorkflowState(saved)
        hydrated = true
    }

    private suspend fun publish(snapshot: ComposerWorkflowSnapshot) {
        mutable.value = ComposerWorkflowState(snapshot)
        withContext(Dispatchers.IO) {
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
        val whitespace = Regex("(?U)\\s+")
    }
}
