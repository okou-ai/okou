package ai.okou.android.chat

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_EVENT
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatListApiFixture
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ProjectArchive
import ai.okou.android.jsonResponse
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.*
import org.junit.Test

class ProjectSyncTest {
    @Test
    fun signedSnapshotAndTailPreserveCreatedOrderAndApplyRenamesAndDeletes() = runTest {
        ChatListApiFixture().use { fixture ->
            fixture.projects = {
                jsonResponse(
                    """{"url":"${fixture.server.url("/archive")}","latestEventId":"$CHAT_EVENT","latestSeqId":17}"""
                )
            }
            fixture.archive = {
                jsonResponse(
                    """{"projects":[{"id":"$CHAT_PROJECT","name":"Before","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}],"latestEventId":"$CHAT_EVENT","latestSeqId":17}"""
                )
            }
            fixture.projectEvents = {
                jsonResponse(
                    """{"events":[{"id":"77777777-7777-4777-8777-777777777777","seqId":23,"projectId":"$CHAT_PROJECT","kind":"renamed","name":"After","createdAt":"2026-11-14T00:00:00Z"}],"hasMore":false}"""
                )
            }
            val confirmed = ProjectSync(fixture.service).synchronize(null)
            assertEquals(23L, confirmed.cursor.seqId)
            val project = replayProjects(confirmed).single()
            assertEquals("After", project.name)
            assertEquals(CHAT_DATE, project.createdAt)
            assertEquals("2026-11-14T00:00:00Z", project.updatedAt)
            fixture.projectEvents = {
                jsonResponse(
                    """{"events":[{"id":"88888888-8888-4888-8888-888888888888","seqId":29,"projectId":"$CHAT_PROJECT","kind":"deleted","name":null,"createdAt":"2026-11-15T00:00:00Z"}],"hasMore":false}"""
                )
            }
            assertTrue(
                replayProjects(ProjectSync(fixture.service).synchronize(confirmed)).isEmpty()
            )
        }
    }

    @Test
    fun emptyProjectCursorLoadsAFreshSnapshotInsteadOfMissingCompactedProjects() = runTest {
        ChatListApiFixture().use { fixture ->
            val cached = ProjectCheckpoint(ProjectArchive(emptyList(), null, 0))
            val confirmed = ProjectSync(fixture.service).synchronize(cached)
            assertEquals("Research", replayProjects(confirmed).single().name)
            assertEquals("/api/projects/snapshot", fixture.server.takeRequest().path)
            assertEquals("/api/projects/events?sinceSeqId=0", fixture.server.takeRequest().path)
        }
    }

    @Test
    fun expiredProjectsRebuildAfterProgressAndReplayTheCanonicalEventNameWithoutExtraLimits() =
        runTest {
            ChatListApiFixture().use { fixture ->
                var snapshotSeq = 20
                val name = "x".repeat(200)
                fixture.projects = {
                    snapshotSeq += 20
                    jsonResponse(
                        """{"projects":[{"id":"$CHAT_PROJECT","name":"Before","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}],"latestEventId":"00000000-0000-4000-8000-${snapshotSeq.toString().padStart(12, '0')}","latestSeqId":$snapshotSeq}"""
                    )
                }
                fixture.projectEvents = { request ->
                    val seq = checkNotNull(request.requestUrl?.queryParameter("sinceSeqId")).toInt()
                    if (seq == 17 || seq == 41) MockResponse().setResponseCode(410)
                    else {
                        val next = seq + 1
                        jsonResponse(
                            """{"events":[{"id":"00000000-0000-4000-8000-${next.toString().padStart(12, '0')}","seqId":$next,"projectId":"$CHAT_PROJECT","kind":"renamed","name":"$name","createdAt":"$CHAT_DATE"}],"hasMore":${next == 41}}"""
                        )
                    }
                }
                val cached = ProjectCheckpoint(ProjectArchive(emptyList(), CHAT_EVENT, 17))
                val confirmed = ProjectSync(fixture.service).synchronize(cached)
                assertEquals(61L, confirmed.cursor.seqId)
                assertEquals(name, replayProjects(confirmed).single().name)
                fixture.projectEvents = { MockResponse().setResponseCode(410) }
                val error =
                    runCatching { ProjectSync(fixture.service).synchronize(null) }.exceptionOrNull()
                assertTrue(error is ApiFailure.Http && error.status == 410)
            }
        }
}
