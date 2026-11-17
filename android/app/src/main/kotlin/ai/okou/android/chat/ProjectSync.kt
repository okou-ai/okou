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

private fun ConfirmedProject.effectiveSortOrder(): String =
    sortOrder ?: "a0${chatTime(createdAt).toString().padStart(17, '0')}1"

private fun compareProjectBytes(left: String, right: String): Int {
    val lhs = left.toByteArray(Charsets.UTF_8)
    val rhs = right.toByteArray(Charsets.UTF_8)
    for (index in 0 until minOf(lhs.size, rhs.size)) {
        val difference = (lhs[index].toInt() and 255) - (rhs[index].toInt() and 255)
        if (difference != 0) return difference
    }
    return lhs.size.compareTo(rhs.size)
}

/** Web's Project projection: metadata changes cannot fabricate a missing creation. */
fun replayProjects(checkpoint: ProjectCheckpoint): List<ConfirmedProject> {
    checkpoint.validate()
    val projects = checkpoint.archive.projects.associateByTo(linkedMapOf()) { it.id }
    checkpoint.events.forEach { event ->
        val existing = projects[event.projectId]
        when (event.kind) {
            ProjectEventsEventsItemKind.DELETED -> projects.remove(event.projectId)
            ProjectEventsEventsItemKind.SORT_UPDATED -> {
                requireChatWire(existing != null && event.sortOrder != null)
                projects[event.projectId] =
                    checkNotNull(existing)
                        .copy(sortOrder = event.sortOrder, updatedAt = event.createdAt)
            }
            ProjectEventsEventsItemKind.CREATED,
            ProjectEventsEventsItemKind.RENAMED -> {
                val name = event.name
                requireChatWire(name != null)
                requireChatWire(
                    event.kind != ProjectEventsEventsItemKind.RENAMED || existing != null
                )
                projects[event.projectId] =
                    ConfirmedProject(
                        id = event.projectId,
                        name = checkNotNull(name),
                        createdAt = existing?.createdAt ?: event.createdAt,
                        updatedAt = event.createdAt,
                        sortOrder = event.sortOrder ?: existing?.sortOrder,
                    )
            }
        }
    }
    return projects.values.sortedWith { left, right ->
        compareProjectBytes(left.effectiveSortOrder(), right.effectiveSortOrder()).takeIf {
            it != 0
        } ?: compareProjectBytes(left.id, right.id)
    }
}

/** Independent Project snapshot/tail, with Web's cursor recovery and no event compaction. */
class ProjectSync(
    private val service: ChatListService,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) {
    suspend fun synchronize(cached: ProjectCheckpoint?): MetadataSyncResult<ProjectCheckpoint> =
        withContext(dispatcher) {
            // Project's zero sequence is a valid cached cursor, unlike chat's absent cursor.
            var state = cached ?: snapshot()
            var replacement = cached == null
            var cursorFromSnapshot = replacement
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
                        replacement = true
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
            state.validate()
            MetadataSyncResult(state, changed = replacement || state.cursor != cached?.cursor)
        }

    private suspend fun snapshot(): ProjectCheckpoint {
        val archive =
            when (val descriptor = service.projectSnapshot()) {
                is ProjectSnapshotVariant1 ->
                    ProjectArchive(
                        descriptor.projects.map {
                            ConfirmedProject(
                                it.id,
                                it.name,
                                it.createdAt,
                                it.updatedAt,
                                it.sortOrder,
                            )
                        },
                        descriptor.latestEventId,
                        descriptor.latestSeqId,
                    )
                is ProjectSnapshotVariant2 -> service.projectArchive(descriptor.url)
            }
        return ProjectCheckpoint(archive).also { it.validate() }
    }
}
