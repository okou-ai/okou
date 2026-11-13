package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ProjectArchive
import ai.okou.android.api.generated.ProjectArchiveProjectsItem
import ai.okou.android.api.generated.ProjectEventsEventsItem
import ai.okou.android.api.generated.ProjectEventsEventsItemKind
import ai.okou.android.api.generated.ProjectSnapshotVariant1
import ai.okou.android.api.generated.ProjectSnapshotVariant2
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

typealias ConfirmedProject = ProjectArchiveProjectsItem

internal fun ProjectEventsEventsItem.cursor() = ChatCursor(id, seqId)

@Serializable
data class ProjectCheckpoint(
    val archive: ProjectArchive,
    val events: List<ProjectEventsEventsItem> = emptyList(),
) {
    val snapshotCursor: ChatCursor
        get() = ChatCursor(archive.latestEventId, archive.latestSeqId)

    val cursor: ChatCursor
        get() = events.lastOrNull()?.cursor() ?: snapshotCursor

    fun validate() {
        snapshotCursor.validate()
        requireChatWire(archive.projects.map { it.id }.distinct().size == archive.projects.size)
        archive.projects.forEach {
            requireChatId(it.id)
            requireChatWire(it.name.isNotBlank() && it.name.length <= 120)
        }
        var previous = snapshotCursor.seqId
        val identities = hashSetOf<String>().apply { snapshotCursor.eventId?.let(::add) }
        events.forEach {
            val next = it.cursor()
            next.validate()
            requireChatId(it.projectId)
            requireChatWire(next.seqId > previous && identities.add(it.id))
            previous = next.seqId
        }
    }
}

/** Web's Project projection: a rename cannot fabricate a missing creation. */
fun replayProjects(checkpoint: ProjectCheckpoint): List<ConfirmedProject> {
    checkpoint.validate()
    val projects = checkpoint.archive.projects.associateByTo(linkedMapOf()) { it.id }
    checkpoint.events.forEach { event ->
        if (event.kind == ProjectEventsEventsItemKind.DELETED) projects.remove(event.projectId)
        else {
            val name = event.name
            requireChatWire(name != null)
            val existing = projects[event.projectId]
            requireChatWire(event.kind != ProjectEventsEventsItemKind.RENAMED || existing != null)
            projects[event.projectId] =
                ConfirmedProject(
                    event.projectId,
                    checkNotNull(name),
                    existing?.createdAt ?: event.createdAt,
                    event.createdAt,
                )
        }
    }
    return projects.values.sortedWith(compareBy<ConfirmedProject> { it.createdAt }.thenBy { it.id })
}

/** Independent Project snapshot/tail, with Web's cursor recovery and no event compaction. */
class ProjectSync(
    private val service: ChatListService,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) {
    suspend fun synchronize(cached: ProjectCheckpoint?): ProjectCheckpoint =
        withContext(dispatcher) {
            val useCache = cached != null && cached.cursor.seqId > 0
            var state = if (useCache) checkNotNull(cached) else snapshot()
            var cursorFromSnapshot = !useCache
            state.validate()
            val identities = state.events.mapTo(hashSetOf()) { it.id }
            state.snapshotCursor.eventId?.let(identities::add)
            var hasMore = true
            while (hasMore) {
                val cursor = state.cursor
                val page =
                    try {
                        service.projectEvents(cursor.seqId)
                    } catch (error: ApiFailure.Http) {
                        if (error.status != 410 || cursorFromSnapshot) throw error
                        state = snapshot()
                        identities.clear()
                        state.snapshotCursor.eventId?.let(identities::add)
                        cursorFromSnapshot = true
                        continue
                    }
                val incoming = page.events.filter { it.seqId > cursor.seqId }
                requireChatWire(!page.hasMore || incoming.isNotEmpty())
                var previous = cursor.seqId
                incoming.forEach {
                    val next = it.cursor()
                    next.validate()
                    requireChatWire(next.seqId > previous && identities.add(it.id))
                    previous = next.seqId
                }
                state = state.copy(events = state.events + incoming)
                if (incoming.isNotEmpty()) cursorFromSnapshot = false
                hasMore = page.hasMore
            }
            state.also { it.validate() }
        }

    private suspend fun snapshot(): ProjectCheckpoint {
        val archive =
            when (val descriptor = service.projectSnapshot()) {
                is ProjectSnapshotVariant1 ->
                    ProjectArchive(
                        descriptor.projects.map {
                            ConfirmedProject(it.id, it.name, it.createdAt, it.updatedAt)
                        },
                        descriptor.latestEventId,
                        descriptor.latestSeqId,
                    )
                is ProjectSnapshotVariant2 -> service.projectArchive(descriptor.url)
            }
        return ProjectCheckpoint(archive).also { it.validate() }
    }
}
