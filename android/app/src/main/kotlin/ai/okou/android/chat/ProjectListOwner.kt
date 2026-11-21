package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class ProjectRenameRejection internal constructor(val projectId: String, val eventId: String)

data class ProjectListUiState(
    val rows: List<ConfirmedProject> = emptyList(),
    val phase: ChatReadPhase = ChatReadPhase.Idle,
    val source: ChatListSource? = null,
    val cacheUnavailable: Boolean = false,
    val renamingId: String? = null,
    val unconfirmedRenames: Set<String> = emptySet(),
    internal val renameRejection: ProjectRenameRejection? = null,
) {
    internal fun canRename(offline: Boolean): Boolean =
        source != null && !offline && renamingId == null
}

/** Project synchronization and writes share the authorized workspace lifetime. */
internal class ProjectListOwner(
    private val service: ChatListService,
    private val cache: ChatCacheStore.Lease,
    private val scope: CoroutineScope,
    private val current: () -> Boolean,
    private val offline: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
    private val dispatcher: CoroutineDispatcher,
    private val wallMillis: () -> Long,
    private val readState: () -> ProjectListUiState,
    private val publish: (ProjectListUiState) -> Unit,
) {
    // Write through to the list snapshot so all Project consumers observe the same transition.
    private var state: ProjectListUiState
        get() = readState()
        set(value) = publish(value)

    private var confirmedProjects: CachedProjects? = null
    private var confirmedProjectRows = emptyList<ConfirmedProject>()
    private var projectRename: ProjectRename? = null
    private val retryableProjectRenames = mutableMapOf<String, ProjectRename>()
    private var projectsRestoreJob: Job? = null
    private var projectsJob: Job? = null
    private val projectSync = ProjectSync(service, dispatcher)
    private val projectInvalidations = Channel<Unit>(Channel.CONFLATED)

    private data class ProjectRename(val id: String, val name: String, val eventId: String)

    init {
        scope.launch {
            for (ignored in projectInvalidations) {
                projectsJob?.join()
                if (current()) {
                    refresh()
                    projectsJob?.join()
                }
            }
        }
    }

    fun invalidate() {
        projectInvalidations.trySend(Unit)
    }

    fun restore(afterChatCache: Job) {
        projectsRestoreJob =
            scope.launch {
                try {
                    // Both cache reads use the store mutex. Give first chat display priority.
                    afterChatCache.join()
                    requireCurrent()
                    val saved = cache.loadProjects() ?: return@launch
                    requireCurrent()
                    confirmedProjects = saved
                    showCachedProjects()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    currentCoroutineContext().ensureActive()
                    if (current()) state = state.copy(cacheUnavailable = true)
                }
            }
    }

    private suspend fun showCachedProjects() {
        val saved = confirmedProjects ?: return
        if (!current() || state.source == ChatListSource.Network) return
        val rows = withContext(dispatcher) { replayProjects(saved.checkpoint) }
        requireCurrent()
        if (state.source != ChatListSource.Network)
            publishProjects(rows, state.copy(source = ChatListSource.Cache))
    }

    private suspend fun persistProjects(saved: CachedProjects): CachedProjects =
        try {
            val written = cache.saveProjects(saved.checkpoint, saved.confirmedAt)
            val disk = if (written) null else cache.loadProjects()
            requireCurrent()
            state = state.copy(cacheUnavailable = false)
            if (disk != null && disk.checkpoint.cursor.seqId > saved.checkpoint.cursor.seqId) disk
            else saved
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            requireCurrent()
            state = state.copy(cacheUnavailable = true)
            saved
        }

    internal fun renameProject(id: String, input: String) {
        val name = input.trim()
        if (name.length !in 1..120 || confirmedProjectRows.none { it.id == id && it.name != name })
            return
        submitProjectRename(ProjectRename(id, name, newProjectOperationId()))
    }

    private fun newProjectOperationId(): String {
        val random = UUID.randomUUID()
        // The Project API uses the UUIDv7 timestamp to bound receipt retries.
        val timestamp = wallMillis() shl 16
        val versionAndRandom = 0x7000L or (random.mostSignificantBits and 0x0fffL)
        return UUID(timestamp or versionAndRandom, random.leastSignificantBits).toString()
    }

    internal fun retryProjectRename(id: String) {
        retryableProjectRenames[id]?.let(::submitProjectRename)
    }

    internal fun dismissProjectRenameRejection(rejection: ProjectRenameRejection) {
        if (current() && state.renameRejection == rejection) {
            state = state.copy(renameRejection = null)
        }
    }

    private fun hasProjectReceipt(eventId: String): Boolean =
        confirmedProjects?.checkpoint?.let { checkpoint ->
            checkpoint.archive.latestEventId == eventId ||
                checkpoint.events.any { it.id == eventId }
        } == true

    private fun publishProjects(
        rows: List<ConfirmedProject>,
        snapshot: ProjectListUiState = state,
    ) {
        confirmedProjectRows = rows
        val pending = projectRename
        state =
            snapshot.copy(
                rows =
                    if (pending == null) rows
                    else
                        rows.map { project ->
                            if (project.id == pending.id) project.copy(name = pending.name)
                            else project
                        },
                renamingId = pending?.id,
                unconfirmedRenames = retryableProjectRenames.keys.toSet(),
            )
    }

    private fun submitProjectRename(rename: ProjectRename) {
        val snapshot = state
        if (
            !current() ||
                !snapshot.canRename(offline()) ||
                confirmedProjectRows.none { it.id == rename.id }
        )
            return
        projectRename = rename
        retryableProjectRenames.remove(rename.id)
        val previousRejection = snapshot.renameRejection
        publishProjects(
            confirmedProjectRows,
            if (previousRejection?.projectId == rename.id) snapshot.copy(renameRejection = null)
            else snapshot,
        )
        scope.launch {
            var rejected = false
            try {
                try {
                    service.renameProject(rename.id, rename.name, rename.eventId)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    requireCurrent()
                    if (error !is ApiFailure.Http || error.status != 404) onFailure(error)
                    rejected =
                        when (error) {
                            is ApiFailure.Unauthenticated,
                            is ApiFailure.UpdateRequired -> true
                            is ApiFailure.Http -> error.status in setOf(400, 401, 403, 404, 409)
                            else -> false
                        }
                    if (rejected) return@launch
                }
                requireCurrent()
                // Wait out a read that could have started before the write.
                while (projectsJob?.isCompleted == false) projectsJob?.join()
                requireCurrent()
                val previousRead = projectsJob
                refresh()
                val readBack = projectsJob
                readBack?.join()
                requireCurrent()
                val confirmedName = confirmedProjectRows.firstOrNull { it.id == rename.id }?.name
                val observedName =
                    readBack !== previousRead &&
                        state.phase == ChatReadPhase.Ready &&
                        confirmedName == rename.name
                // The stream can deliver the receipt before the write response is lost.
                if (!observedName && !hasProjectReceipt(rename.eventId) && confirmedName != null) {
                    // The server deduplicates retries by this Project event ID.
                    retryableProjectRenames[rename.id] = rename
                }
            } finally {
                projectRename = null
                if (current()) {
                    val snapshot = state
                    // A retry can be rejected after the original write was confirmed.
                    val settled =
                        if (rejected && !hasProjectReceipt(rename.eventId))
                            snapshot.copy(
                                renameRejection = ProjectRenameRejection(rename.id, rename.eventId)
                            )
                        else snapshot
                    publishProjects(confirmedProjectRows, settled)
                }
            }
        }
    }

    fun refresh() {
        if (current() && !offline() && projectsJob?.isActive != true) {
            state = state.copy(phase = ChatReadPhase.Loading)
            projectsJob =
                scope.launch {
                    try {
                        projectsRestoreJob?.join()
                        requireCurrent()
                        val previous = confirmedProjects
                        val result = projectSync.synchronize(previous?.checkpoint)
                        val candidate =
                            if (!result.changed && previous != null && !state.cacheUnavailable)
                                previous
                            else CachedProjects(result.checkpoint, System.currentTimeMillis())
                        val projected =
                            withContext(dispatcher) { replayProjects(candidate.checkpoint) }
                        requireCurrent()
                        val saved =
                            if (candidate === previous) candidate else persistProjects(candidate)
                        val rows =
                            if (saved === candidate) projected
                            else withContext(dispatcher) { replayProjects(saved.checkpoint) }
                        requireCurrent()
                        confirmedProjects = saved
                        if (retryableProjectRenames.isNotEmpty()) {
                            val names = rows.associate { it.id to it.name }
                            val appliedEvents = saved.checkpoint.events.mapTo(hashSetOf()) { it.id }
                            saved.checkpoint.archive.latestEventId?.let(appliedEvents::add)
                            retryableProjectRenames.entries.removeAll { (id, rename) ->
                                names[id] == null ||
                                    names[id] == rename.name ||
                                    rename.eventId in appliedEvents
                            }
                        }
                        publishProjects(
                            rows,
                            state.copy(phase = ChatReadPhase.Ready, source = ChatListSource.Network),
                        )
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        // A missing Projects collection does not revoke the workspace session.
                        if (error is ApiFailure.Http && error.status == 404) {
                            if (current()) {
                                retryableProjectRenames.clear()
                                publishProjects(
                                    emptyList(),
                                    state.copy(source = null, phase = ChatReadPhase.Failed),
                                )
                            }
                        } else if (current()) {
                            onFailure(error)
                            if (current()) state = state.copy(phase = ChatReadPhase.Failed)
                        }
                    }
                }
        }
    }

    private suspend fun requireCurrent() {
        currentCoroutineContext().ensureActive()
        if (!current()) throw CancellationException("Project owner retired")
    }

    fun close() {
        projectInvalidations.close()
    }
}
