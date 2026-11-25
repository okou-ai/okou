package ai.okou.android

import ai.okou.android.settings.ProactiveSetting
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals

internal class ProactiveSettingsApiFixture(api: ChatListApiFixture) {
    @Volatile var suggestionsEligible = true
    @Volatile var morningEnabled = false
    @Volatile var morningNeedsTimezone = false
    @Volatile var suggestionsEnabled = false
    @Volatile var suggestionsNeedsTimezone = false
    @Volatile var cardsEnabled = false
    @Volatile var readStatus = 200
    @Volatile var morningWriteStatus = 200
    @Volatile var suggestionsWriteStatus = 200
    @Volatile var commitBeforeError = false
    @Volatile var scheduleError = false
    @Volatile var beforeMorningRead: () -> Unit = {}
    @Volatile var beforeMorningWrite: () -> Unit = {}
    val reads = CopyOnWriteArrayList<String>()
    val writes = CopyOnWriteArrayList<Pair<ProactiveSetting, Boolean>>()

    init {
        val previous = api.commandResponse
        api.commandResponse = { request ->
            val path = request.requestUrl?.encodedPath
            when (path) {
                "/api/preferences/morning-brief" -> {
                    if (request.method == "PUT") {
                        val choice = request.enabled()
                        writes += ProactiveSetting.MorningBrief to choice
                        beforeMorningWrite()
                        if (morningWriteStatus == 200 || commitBeforeError) morningEnabled = choice
                        morning(morningWriteStatus)
                    } else {
                        verifyRead(request, "morning-brief")
                        val response = morning(readStatus)
                        beforeMorningRead()
                        response
                    }
                }
                "/api/preferences/proactive-suggestions" -> {
                    verifyRead(request, "suggestions")
                    suggestions(if (suggestionsEligible) readStatus else 403)
                }
                "/api/feed/sources" -> {
                    verifyRead(request, "feed-sources")
                    jsonResponse(
                        """{"suggestions":$cardsEnabled,"whatsNew":true,"offers":true,"systemUpdates":true}""",
                    )
                }
                "/api/preferences/proactive-suggestions/with-feed" -> {
                    assertEquals("PUT", request.method)
                    val choice = request.enabled()
                    writes += ProactiveSetting.Suggestions to choice
                    if (suggestionsWriteStatus == 200 || commitBeforeError) {
                        suggestionsEnabled = choice
                        cardsEnabled = choice
                    }
                    suggestions(suggestionsWriteStatus)
                }
                else -> previous(request)
            }
        }
    }

    private fun verifyRead(request: RecordedRequest, resource: String) {
        assertEquals("GET", request.method)
        assertEquals("Bearer fixture-token", request.getHeader("Authorization"))
        reads += resource
    }

    private fun RecordedRequest.enabled(): Boolean {
        assertEquals("Bearer fixture-token", getHeader("Authorization"))
        val body = Json.parseToJsonElement(this.body.readUtf8()).jsonObject
        assertEquals(setOf("enabled"), body.keys)
        return body.getValue("enabled").jsonPrimitive.boolean
    }

    private fun morning(code: Int): MockResponse =
        preference(code, morningEnabled, morningNeedsTimezone, scheduleError)

    private fun suggestions(code: Int): MockResponse =
        preference(code, suggestionsEnabled, suggestionsNeedsTimezone)

    private fun preference(
        code: Int,
        enabled: Boolean,
        needsTimezone: Boolean = false,
        scheduleError: Boolean = false,
    ): MockResponse {
        if (code != 200) {
            return jsonResponse("""{"error":{"code":"FIXTURE","message":"Unavailable"}}""")
                .setResponseCode(code)
        }
        val status =
            when {
                !enabled -> "paused"
                scheduleError -> "error"
                needsTimezone -> "preparing"
                else -> "enabled"
            }
        val reason = if (needsTimezone) "\"missing-timezone\"" else "null"
        return jsonResponse(
            """{"enabled":$enabled,"status":"$status","unavailableReason":$reason}""",
        )
    }
}
