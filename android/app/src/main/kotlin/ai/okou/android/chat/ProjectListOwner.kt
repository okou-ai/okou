package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.nextPaneFeedbackOrder
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal const val ProjectNameLimit = 120

internal enum class ProjectCreatePhase {
    Creating,
    Checking,
    Rejected,
    Unconfirmed,
    Confirmed;

    val inProgress: Boolean
        get() = this == Creating || this == Checking
}

internal data class ProjectCreation(val id: String, val phase: ProjectCreatePhase)

data class ProjectRenameRejection internal constructor(val projectId: String, val eventId: String)

enum class ProjectDeleteStatus {
    Confirmed,
    Rejected,
    ConnectionFailed,
}

@ConsistentCopyVisibility
data class ProjectDeleteFeedback
internal constructor(val projectId: String, val eventId: String, val status: ProjectDeleteStatus) {
    internal val rejected = status != ProjectDeleteStatus.Confirmed
    internal val feedbackOrder = nextPaneFeedbackOrder()
}

@ConsistentCopyVisibility
data class ProjectListUiState
internal constructor(
    val rows: List<ConfirmedProject> = emptyList(),
    val phase: ChatReadPhase = ChatReadPhase.Idle,
    val source: ChatListSource? = null,
    val cacheUnavailable: Boolean = false,
    internal val refreshFailureOrder: Long? = null,
    val renamingId: String? = null,
    val deletingId: String? = null,
    internal val unconfirmedRenameAttempts: Map<String, RenameSubmission> = emptyMap(),
    internal val confirmedRenameIds: Map<String, String> = emptyMap(),
    internal val connectionFailedRenames: Set<String> = emptySet(),
    internal val renameRejection: ProjectRenameRejection? = null,
    internal val deleteFeedback: List<ProjectDeleteFeedback> = emptyList(),
    internal val creation: ProjectCreation? = null,
) {
    val unconfirmedRenames: Set<String>
        get() = unconfirmedRenameAttempts.keys

    internal val canRename: Boolean
        get() = source != null && renamingId == null && deletingId == null

    // Acknowledged deletes can still be visible until the metadata feed catches up.
    internal fun isDeleting(id: String): Boolean =
        deletingId == id ||
            deleteFeedback.any { it.projectId == id && it.status == ProjectDeleteStatus.Confirmed }
}

internal fun newProjectOperationId(wallMillis: Long): String {
    val random = UUID.randomUUID()
    // The Project API uses the UUIDv7 timestamp to bound receipt retries.
    val timestamp = wallMillis shl 16
    val versionAndRandom = 0x7000L or (random.mostSignificantBits and 0x0fffL)
    return UUID(timestamp or versionAndRandom, random.leastSignificantBits).toString()
}

/** Project synchronization and writes share the authorized workspace lifetime. */
internal class ProjectListOwner(
    private val service: ChatListService,
    private val cache: ChatCacheStore.Lease,
    private val scope: CoroutineScope,
    private val current: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
    private val dispatcher: CoroutineDispatcher,
    private val wallMillis: () -> Long,
    private val syncChatsAfterDelete: suspend () -> Unit,
    private val isListPaneOpen: () -> Boolean,
    private val visibleListFeedbackScope: () -> Any?,
    private val readState: () -> ProjectListUiState,
    private val publish: (ProjectListUiState) -> Unit,
) {
    // Write through to the list snapshot so all Project consumers observe the same transition.
    private var state: ProjectListUiState
        get() = readState()
        set(value) = publish(value)

    private var confirmedProjects: ConfirmedProjects? = null
    private var createRequest: CreateRequest? = null
    private val createReceipts = mutableMapOf<String, ConfirmedProject>()
    private val renameReceipts = mutableMapOf<String, ProjectRenameReceipt>()
    private var projectRename: ProjectRename? = null
    private val unresolvedProjectRenames = mutableMapOf<String, ProjectRename>()
    private var projectsRestoreJob: Job? = null
    private var projectsJob: Job? = null
    private var projectsRetry: ChatDependencyRetry? = null
    private val projectSync = ProjectSync(service, dispatcher)
    private val projectInvalidations = Channel<Unit>(Channel.CONFLATED)
    private var projectsInvalidated = false

    private data class ConfirmedProjects(
        val checkpoint: ProjectCheckpoint,
        val rows: List<ConfirmedProject>,
    )

    private data class CreateRequest(val id: String, val name: String)

    private data class ProjectRename(
        val id: String,
        val name: String,
        val eventId: String,
        val connectionFailed: Boolean = false,
    ) {
        val submission: RenameSubmission
            get() = RenameSubmission(eventId, name)
    }

    private data class ProjectRenameReceipt(
        val eventId: String,
        val snapshotCursor: ChatCursor,
        val name: String,
        val laterNameUpdatedAt: ChatTimestamp?,
    )

    init {
        scope.launch {
            for (ignored in projectInvalidations) {
                while (projectsJob?.isCompleted == false) projectsJob?.join()
                if (current() && projectsInvalidated) {
                    refresh()
                    projectsJob?.join()
                }
            }
        }
    }

    fun invalidate() {
        projectsInvalidated = true
        projectInvalidations.trySend(Unit)
    }

    fun restore(afterChatCache: Job) {
        projectsRestoreJob = scope.launch {
            try {
                // Both cache reads use the store mutex. Give first chat display priority.
                afterChatCache.join()
                requireCurrent()
                val checkpoint = cache.loadProjects()?.checkpoint ?: return@launch
                requireCurrent()
                if (state.source == ChatListSource.Network) return@launch
                val restored = replayConfirmedProjects(checkpoint)
                requireCurrent()
                if (state.source != ChatListSource.Network) {
                    confirmedProjects = restored
                    publishProjects(state.copy(source = ChatListSource.Cache))
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                currentCoroutineContext().ensureActive()
                if (current()) state = state.copy(cacheUnavailable = true)
            }
        }
    }

    private suspend fun replayConfirmedProjects(checkpoint: ProjectCheckpoint): ConfirmedProjects =
        withContext(dispatcher) { ConfirmedProjects(checkpoint, replayProjects(checkpoint)) }

    private suspend fun persistProjects(checkpoint: ProjectCheckpoint): ProjectCheckpoint =
        try {
            val written = cache.saveProjects(checkpoint, System.currentTimeMillis())
            val disk = if (written) null else cache.loadProjects()?.checkpoint
            requireCurrent()
            state = state.copy(cacheUnavailable = false)
            if (disk != null && disk.cursor.seqId > checkpoint.cursor.seqId) disk else checkpoint
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            requireCurrent()
            state = state.copy(cacheUnavailable = true)
            checkpoint
        }

    fun createProject(input: String) {
        if (!current()) return
        val phase = state.creation?.phase
        val name = input.trim()
        if (
            (phase != null && phase != ProjectCreatePhase.Rejected) ||
                name.length !in 1..ProjectNameLimit
        )
            return
        submitCreation(CreateRequest(newProjectOperationId(wallMillis()), name), checking = false)
    }

    fun checkProjectCreation() {
        if (!current() || state.creation?.phase != ProjectCreatePhase.Unconfirmed) return
        createRequest?.let { submitCreation(it, checking = true) }
    }

    fun dismissProjectCreation() {
        if (!current() || state.creation?.phase?.inProgress == true) return
        createRequest = null
        state = state.copy(creation = null)
    }

    private fun submitCreation(request: CreateRequest, checking: Boolean) {
        createRequest = request
        val phase = if (checking) ProjectCreatePhase.Checking else ProjectCreatePhase.Creating
        state = state.copy(creation = ProjectCreation(request.id, phase))
        scope.launch {
            var uncertain = checking
            var retries = 0
            while (true) {
                try {
                    val observed = if (uncertain) lookupCreatedProject(request.id) else null
                    requireCurrent()
                    if (createRequest !== request) return@launch
                    val project =
                        observed
                            ?: try {
                                service.createProject(request.id, request.name)
                            } catch (error: Exception) {
                                if (error is CancellationException) throw error
                                if (
                                    !error.rejectsProjectMutation() &&
                                        !(error is ApiFailure.Network && error.connectionFailed)
                                )
                                    uncertain = true
                                throw error
                            }
                    requireCurrent()
                    if (createRequest !== request) return@launch
                    confirmCreation(project)
                    return@launch
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    requireCurrent()
                    if (createRequest !== request) return@launch
                    val retryDelay = dependencyRetryDelayMillis(error, retries)
                    if (retryDelay != null && retries < ChatDependencyRetryCount) {
                        retries++
                        delay(retryDelay)
                        requireCurrent()
                        if (createRequest !== request) return@launch
                        continue
                    }
                    if (error !is ApiFailure.Http || error.status != 404) onFailure(error)
                    requireCurrent()
                    val observed = if (uncertain) observeCreationAfterFailure(request.id) else null
                    if (createRequest !== request) return@launch
                    if (observed != null) {
                        confirmCreation(observed)
                    } else {
                        val result =
                            if (uncertain) ProjectCreatePhase.Unconfirmed
                            else ProjectCreatePhase.Rejected
                        if (!uncertain) createRequest = null
                        state = state.copy(creation = ProjectCreation(request.id, result))
                    }
                    return@launch
                }
            }
        }
    }

    private suspend fun lookupCreatedProject(id: String): ConfirmedProject? {
        requireCurrent()
        confirmedRows()
            .firstOrNull { it.id == id }
            ?.let {
                return it
            }
        return try {
            service.projectDetail(id).also { requireCurrent() }
        } catch (error: ApiFailure.Http) {
            if (error.status != 404) throw error
            null
        }
    }

    private suspend fun observeCreationAfterFailure(id: String): ConfirmedProject? =
        try {
            lookupCreatedProject(id)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: ApiFailure) {
            if (error !is ApiFailure.Http || error.status != 404) onFailure(error)
            requireCurrent()
            null
        }

    private fun confirmCreation(project: ConfirmedProject) {
        // A feed event may have reached this owner before the write response.
        val id = project.id
        if (confirmedRows().none { it.id == id } && !hasProjectReceipt(id)) {
            createReceipts[id] = project
        }
        createRequest = null
        publishProjects(state.copy(creation = ProjectCreation(id, ProjectCreatePhase.Confirmed)))
        invalidate()
    }

    internal fun renameProject(id: String, input: String): RenameSubmission? {
        val name = input.trim()
        if (
            name.length !in 1..ProjectNameLimit ||
                state.rows.none { it.id == id && it.name.trim() != name }
        )
            return null
        if (unresolvedProjectRenames[id]?.connectionFailed == false) return null
        val rename = ProjectRename(id, name, newProjectOperationId(wallMillis()))
        return if (submitProjectRename(rename)) rename.submission else null
    }

    internal fun checkProjectRename(id: String) {
        if (unresolvedProjectRenames[id]?.connectionFailed == false) refresh(verifyWrite = true)
    }

    internal fun dismissProjectRenameRejection(rejection: ProjectRenameRejection) {
        if (current() && state.renameRejection == rejection) {
            state = state.copy(renameRejection = null)
        }
    }

    fun deleteProject(id: String) {
        val snapshot = state
        if (
            !current() ||
                !snapshot.canRename ||
                snapshot.isDeleting(id) ||
                snapshot.rows.none { it.id == id }
        )
            return
        val eventId = newProjectOperationId(wallMillis())
        state =
            snapshot.copy(
                deletingId = id,
                deleteFeedback =
                    snapshot.deleteFeedback.filter { feedback ->
                        feedback.projectId != id &&
                            (feedback.rejected || snapshot.rows.any { it.id == feedback.projectId })
                    },
            )
        scope.launch {
            try {
                val failure =
                    try {
                        service.deleteProject(id, eventId)
                        null
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        requireCurrent()
                        if (error !is ApiFailure.Http || error.status != 404) onFailure(error)
                        error
                    }
                requireCurrent()
                val status =
                    when {
                        failure == null ||
                            hasProjectReceipt(eventId) ||
                            (state.source == ChatListSource.Network &&
                                state.rows.none { it.id == id }) -> ProjectDeleteStatus.Confirmed
                        failure is ApiFailure.Network && failure.connectionFailed ->
                            ProjectDeleteStatus.ConnectionFailed
                        else -> ProjectDeleteStatus.Rejected
                    }
                val snapshot = state
                state =
                    snapshot.copy(
                        deletingId = id.takeIf { status == ProjectDeleteStatus.Confirmed },
                        deleteFeedback =
                            if (status == ProjectDeleteStatus.Confirmed || isListPaneOpen()) {
                                snapshot.deleteFeedback + ProjectDeleteFeedback(id, eventId, status)
                            } else snapshot.deleteFeedback,
                    )
                if (status == ProjectDeleteStatus.Confirmed) {
                    // Catch up chats first, then use the normal retrying Project read.
                    syncChatsAfterDelete()
                    requireCurrent()
                    invalidate()
                }
            } finally {
                if (current() && state.deletingId == id) state = state.copy(deletingId = null)
            }
        }
    }

    fun dismissProjectDeleteFeedback(feedback: ProjectDeleteFeedback) {
        if (current() && feedback in state.deleteFeedback)
            state = state.copy(deleteFeedback = state.deleteFeedback - feedback)
    }

    private fun hasProjectReceipt(
        eventId: String,
        checkpoint: ProjectCheckpoint? = confirmedProjects?.checkpoint,
    ): Boolean =
        checkpoint != null &&
            (checkpoint.archive.latestEventId == eventId ||
                checkpoint.events.any { it.id == eventId })

    private fun confirmedRows(source: ChatListSource? = state.source): List<ConfirmedProject> {
        val rows = if (source == null) emptyList() else checkNotNull(confirmedProjects).rows
        if (createReceipts.isEmpty()) return rows
        val ids = rows.mapTo(hashSetOf()) { it.id }
        return (rows + createReceipts.values.filterNot { it.id in ids }).inProjectOrder()
    }

    private fun publishProjects(snapshot: ProjectListUiState) {
        val rows = confirmedRows(snapshot.source)
        val pending = projectRename
        val creation = snapshot.creation
        // A create and subsequent delete can arrive in the same batch.
        val settledCreation =
            if (
                creation != null &&
                    createRequest != null &&
                    (rows.any { it.id == creation.id } || hasProjectReceipt(creation.id))
            ) {
                createRequest = null
                creation.copy(phase = ProjectCreatePhase.Confirmed)
            } else creation
        state =
            snapshot.copy(
                creation = settledCreation,
                rows =
                    if (renameReceipts.isEmpty()) rows
                    else
                        rows.map { row ->
                            val receipt = renameReceipts[row.id]
                            if (receipt == null) row else row.copy(name = receipt.name)
                        },
                renamingId = pending?.id,
                unconfirmedRenameAttempts =
                    unresolvedProjectRenames.mapValues { it.value.submission },
                connectionFailedRenames =
                    unresolvedProjectRenames.values
                        .filter { it.connectionFailed }
                        .mapTo(hashSetOf()) { it.id },
            )
    }

    private fun submitProjectRename(rename: ProjectRename): Boolean {
        val snapshot = state
        if (!current() || !snapshot.canRename || snapshot.isDeleting(rename.id)) return false
        val baseline = confirmedRows().firstOrNull { it.id == rename.id } ?: return false
        val snapshotCursor = checkNotNull(confirmedProjects).checkpoint.snapshotCursor
        projectRename = rename
        unresolvedProjectRenames.remove(rename.id)
        val previousRejection = snapshot.renameRejection
        publishProjects(
            if (previousRejection?.projectId == rename.id) snapshot.copy(renameRejection = null)
            else snapshot,
        )
        scope.launch {
            var rejected = false
            var confirmedByReadback = false
            try {
                val receipt =
                    try {
                        service.renameProject(rename.id, rename.name, rename.eventId)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        requireCurrent()
                        if (error !is ApiFailure.Http || error.status != 404) onFailure(error)
                        if (projectRename !== rename) return@launch
                        rejected = error.rejectsProjectMutation()
                        if (rejected) return@launch
                        if (
                            error is ApiFailure.Network &&
                                error.connectionFailed &&
                                !hasProjectReceipt(rename.eventId)
                        ) {
                            unresolvedProjectRenames[rename.id] =
                                rename.copy(connectionFailed = true)
                            return@launch
                        }
                        null
                    }
                requireCurrent()
                if (receipt != null) {
                    if (projectRename === rename) {
                        projectRename = null
                        publishRenameReceipt(rename, receipt, baseline, snapshotCursor)
                    }
                    invalidate()
                    return@launch
                }
                val readBack = refreshAfterWrite()
                if (projectRename !== rename) return@launch
                val confirmedName = confirmedRows().firstOrNull { it.id == rename.id }?.name
                // The stream can deliver the receipt before the write response is lost.
                confirmedByReadback =
                    state.confirmedRenameIds[rename.id] == rename.eventId ||
                        hasProjectReceipt(rename.eventId) ||
                        readBack && confirmedName == rename.name
                if (!confirmedByReadback && confirmedName != null) {
                    // An inconclusive read retains the ID needed to match the original event.
                    unresolvedProjectRenames[rename.id] = rename.copy(connectionFailed = false)
                }
            } finally {
                if (projectRename === rename) {
                    projectRename = null
                    if (current()) {
                        val snapshot = state
                        val settled =
                            when {
                                confirmedByReadback ->
                                    snapshot.copy(
                                        confirmedRenameIds =
                                            snapshot.confirmedRenameIds +
                                                (rename.id to rename.eventId),
                                    )
                                rejected &&
                                    snapshot.confirmedRenameIds[rename.id] != rename.eventId &&
                                    !hasProjectReceipt(rename.eventId) ->
                                    snapshot.copy(
                                        renameRejection =
                                            ProjectRenameRejection(rename.id, rename.eventId),
                                    )
                                else -> snapshot
                            }
                        publishProjects(settled)
                    }
                }
            }
        }
        return true
    }

    private fun publishRenameReceipt(
        rename: ProjectRename,
        receipt: ConfirmedProject,
        baseline: ConfirmedProject,
        snapshotCursor: ChatCursor,
    ) {
        val latest = confirmedRows().firstOrNull { it.id == rename.id }
        // The route reads the current Project after committing the original operation.
        val laterNameUpdatedAt =
            receipt.updatedAt.takeIf { receipt.name != rename.name }?.let(::chatTimestamp)
        val publishName =
            latest != null &&
                if (laterNameUpdatedAt == null) {
                    !hasProjectReceipt(rename.eventId) &&
                        (confirmedProjects?.checkpoint?.snapshotCursor == snapshotCursor ||
                            latest == baseline ||
                            chatTimestamp(latest.updatedAt) < chatTimestamp(receipt.updatedAt))
                } else {
                    val latestUpdatedAt = chatTimestamp(latest.updatedAt)
                    latest == baseline ||
                        latestUpdatedAt < laterNameUpdatedAt ||
                        (latestUpdatedAt == laterNameUpdatedAt && latest.name == rename.name)
                }
        if (publishName) {
            renameReceipts[rename.id] =
                ProjectRenameReceipt(
                    rename.eventId,
                    snapshotCursor,
                    receipt.name,
                    laterNameUpdatedAt,
                )
        } else {
            renameReceipts.remove(rename.id)
        }
        val snapshot = state
        publishProjects(
            snapshot.copy(
                confirmedRenameIds = snapshot.confirmedRenameIds + (rename.id to rename.eventId),
            ),
        )
    }

    private suspend fun refreshAfterWrite(): Boolean {
        // Wait out a read that could have started before the write.
        while (projectsJob?.isCompleted == false) {
            projectsRetry?.stopRetrying()
            projectsJob?.join()
        }
        requireCurrent()
        val previousRead = projectsJob
        refresh(verifyWrite = true)
        val readBack = projectsJob
        readBack?.join()
        requireCurrent()
        return readBack !== previousRead && state.phase == ChatReadPhase.Ready
    }

    fun refresh(verifyWrite: Boolean = false) {
        if (current() && projectsJob?.isActive != true) {
            val feedbackScope = visibleListFeedbackScope().takeUnless { verifyWrite }
            val retry = if (verifyWrite) null else ChatDependencyRetry()
            projectsRetry = retry
            state = state.copy(phase = ChatReadPhase.Loading)
            projectsJob = scope.launch {
                try {
                    projectsRestoreJob?.join()
                    requireCurrent()
                    val previous = confirmedProjects
                    val checkpoint = previous?.checkpoint
                    val acknowledgedRenames =
                        if (renameReceipts.isEmpty()) emptySet()
                        else renameReceipts.values.mapTo(hashSetOf()) { it.eventId }
                    suspend fun fetch(): MetadataSyncResult<ProjectCheckpoint> {
                        projectsInvalidated = false
                        return projectSync.synchronize(checkpoint)
                    }
                    val result = retry?.read(isCurrent = current, fetch = ::fetch) ?: fetch()
                    val candidate =
                        if (result.changed) replayConfirmedProjects(result.checkpoint)
                        else checkNotNull(previous)
                    requireCurrent()
                    val saved =
                        if (candidate === previous && !state.cacheUnavailable) candidate.checkpoint
                        else persistProjects(candidate.checkpoint)
                    val selected =
                        if (saved === candidate.checkpoint) candidate
                        else replayConfirmedProjects(saved)
                    requireCurrent()
                    confirmedProjects = selected
                    fun observedProjectEvent(eventId: String): Boolean =
                        hasProjectReceipt(eventId) ||
                            (selected !== candidate &&
                                hasProjectReceipt(eventId, candidate.checkpoint))

                    if (createReceipts.isNotEmpty()) {
                        val affected =
                            selected.checkpoint.events.mapTo(hashSetOf()) { it.projectId }
                        selected.rows.mapTo(affected) { it.id }
                        selected.checkpoint.archive.projects.mapTo(affected) { it.id }
                        createReceipts.keys.removeAll(affected)
                    }
                    if (renameReceipts.isNotEmpty()) {
                        val byId = selected.rows.associateBy { it.id }
                        renameReceipts.entries.removeAll { (id, receipt) ->
                            val row = byId[id]
                            val readAfterReceipt = receipt.eventId in acknowledgedRenames
                            (row == null && id !in createReceipts) ||
                                (observedProjectEvent(receipt.eventId) &&
                                    (receipt.laterNameUpdatedAt == null ||
                                        readAfterReceipt ||
                                        (row != null &&
                                            chatTimestamp(row.updatedAt) >
                                                receipt.laterNameUpdatedAt))) ||
                                // A read started before acknowledgement can still show an
                                // earlier name. The exact event or a later snapshot settles it.
                                (readAfterReceipt &&
                                    selected.checkpoint.snapshotCursor.seqId >
                                        receipt.snapshotCursor.seqId)
                        }
                    }
                    val snapshot = state
                    var confirmedRenameIds = snapshot.confirmedRenameIds
                    fun recordConfirmedRename(id: String, eventId: String) {
                        if (renameReceipts[id]?.eventId != eventId) {
                            renameReceipts.remove(id)
                        }
                        confirmedRenameIds = confirmedRenameIds + (id to eventId)
                    }
                    projectRename?.let {
                        if (observedProjectEvent(it.eventId)) {
                            projectRename = null
                            recordConfirmedRename(it.id, it.eventId)
                        }
                    }
                    if (unresolvedProjectRenames.isNotEmpty()) {
                        val names = selected.rows.associate { it.id to it.name }
                        val appliedEvents = selected.checkpoint.events.mapTo(hashSetOf()) { it.id }
                        selected.checkpoint.archive.latestEventId?.let(appliedEvents::add)
                        unresolvedProjectRenames.entries.removeAll { (id, rename) ->
                            val applied =
                                names[id] == rename.name ||
                                    rename.eventId in appliedEvents ||
                                    (selected !== candidate &&
                                        hasProjectReceipt(rename.eventId, candidate.checkpoint))
                            if (applied) recordConfirmedRename(id, rename.eventId)
                            names[id] == null || applied
                        }
                    }
                    val resolvedRejection =
                        snapshot.renameRejection?.takeIf { observedProjectEvent(it.eventId) }
                    resolvedRejection?.let { recordConfirmedRename(it.projectId, it.eventId) }
                    publishProjects(
                        snapshot.copy(
                            phase = ChatReadPhase.Ready,
                            source = ChatListSource.Network,
                            refreshFailureOrder = null,
                            renameRejection =
                                snapshot.renameRejection.takeIf { resolvedRejection == null },
                            confirmedRenameIds = confirmedRenameIds,
                        ),
                    )
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    // A missing Projects collection does not revoke the workspace session.
                    val collectionMissing = error is ApiFailure.Http && error.status == 404
                    if (current()) {
                        if (!collectionMissing) onFailure(error)
                        if (current()) {
                            val snapshot = state
                            val failed =
                                snapshot.copy(
                                    source = snapshot.source.takeUnless { collectionMissing },
                                    phase = ChatReadPhase.Failed,
                                    refreshFailureOrder =
                                        if (
                                            feedbackScope != null &&
                                                feedbackScope === visibleListFeedbackScope()
                                        )
                                            nextPaneFeedbackOrder()
                                        else
                                            snapshot.refreshFailureOrder.takeUnless {
                                                collectionMissing
                                            },
                                )
                            if (collectionMissing) {
                                unresolvedProjectRenames.clear()
                                // Keep the confirmed checkpoint for catch-up and rename receipts.
                                publishProjects(failed)
                            } else {
                                state = failed
                            }
                        }
                    }
                } finally {
                    projectsRetry = null
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

private fun Exception.rejectsProjectMutation(): Boolean =
    when (this) {
        is ApiFailure.Unauthenticated,
        is ApiFailure.UpdateRequired -> true
        is ApiFailure.Http -> status in setOf(400, 401, 403, 404, 409)
        else -> false
    }
