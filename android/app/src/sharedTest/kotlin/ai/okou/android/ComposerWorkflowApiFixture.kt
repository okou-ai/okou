package ai.okou.android

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** The real composer session reaches the canonical catalog, recency, and chat endpoints. */
internal class ComposerWorkflowApiFixture(composer: ComposerApiFixture) {
    val recentWrites = CopyOnWriteArrayList<List<String>>()
    val catalogReads = CopyOnWriteArrayList<Unit>()
    @Volatile var beforeCatalog: () -> Unit = {}
    @Volatile var beforeRecent: () -> Unit = {}
    @Volatile var catalogStatus = 200
    @Volatile var recent = listOf(ReviewId, ReleaseId)

    init {
        val previous = composer.chats.commandResponse
        composer.chats.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/workflows/for-composer" -> {
                    catalogReads += Unit
                    beforeCatalog()
                    if (catalogStatus == 200) jsonResponse(Catalog)
                    else
                        jsonResponse(
                                """{"error":{"code":"FORBIDDEN","message":"Catalog unavailable"}}""",
                            )
                            .setResponseCode(catalogStatus)
                }
                "/api/workflows/recent" -> {
                    beforeRecent()
                    jsonResponse("""{"workflowIds":${Json.encodeToString(recent)}}""")
                }
                "/api/workflows/recent/use" -> {
                    val ids =
                        Json.parseToJsonElement(request.body.clone().readUtf8())
                            .jsonObject
                            .getValue("workflowIds")
                            .jsonArray
                            .map { it.jsonPrimitive.content }
                    recentWrites += ids
                    recent = (ids + recent).distinct()
                    jsonResponse("""{"workflowIds":${Json.encodeToString(recent)}}""")
                }
                else -> previous(request)
            }
        }
    }

    companion object {
        const val ReleaseId = "94275ba7-29a4-41c4-8248-b623171b1300"
        const val ReviewId = "94275ba7-29a4-41c4-8248-b623171b1301"
        private val Catalog =
            """
            [
              {"id":"$ReleaseId","name":"release-check","displayName":"Release check","description":"Verify the release checklist"},
              {"id":"$ReviewId","name":"review-changes","displayName":"Review changes","description":"Review the current changes"},
              {"id":"94275ba7-29a4-41c4-8248-b623171b1302","name":"daily-digest","displayName":"Daily digest","description":"Summarize workspace activity"},
              {"id":"94275ba7-29a4-41c4-8248-b623171b1303","name":"release-notes","displayName":"Release notes","description":"Draft a release summary"},
              {"id":"94275ba7-29a4-41c4-8248-b623171b1304","name":"weekly-plan","displayName":"Weekly plan","description":null}
            ]
        """
                .trimIndent()
    }
}
