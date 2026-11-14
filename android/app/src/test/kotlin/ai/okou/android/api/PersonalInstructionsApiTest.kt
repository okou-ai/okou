package ai.okou.android.api

import ai.okou.android.BuildConfig
import ai.okou.android.InstructionsApiFixture
import ai.okou.android.api.generated.ApiHeaders
import ai.okou.android.auth.CanonicalWorkspaceSession
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class PersonalInstructionsApiTest {
    @Test
    fun canonicalConditionalRequestsKeepOwnerVersionHeadersAndIntentionalEmptyContent() =
        runBlocking {
            InstructionsApiFixture().use { fixture ->
                assertTrue(fixture.service.personalInstructionsEnabled())
                val initial = fixture.service.personalInstructions()
                val content = "**你好** 👋\nPersonal instructions"
                val saved = fixture.service.updatePersonalInstructions(content, initial.version)
                assertEquals(content, saved.content)
                val sent = fixture.requests.single { it.method == "PUT" }
                assertEquals("/api/instructions", sent.path)
                assertEquals("Bearer fixture-token", sent.getHeader("Authorization"))
                assertEquals("Android", sent.getHeader(ApiHeaders.TYPE_HEADER))
                assertEquals(BuildConfig.VERSION_NAME, sent.getHeader(ApiHeaders.VERSION_HEADER))
                val body = Json.parseToJsonElement(sent.body.clone().readUtf8()).jsonObject
                assertEquals(setOf("content", "ifVersion"), body.keys)
                assertEquals(content, body.getValue("content").jsonPrimitive.content)
                assertEquals(initial.version, body.getValue("ifVersion").jsonPrimitive.content)
                assertEquals(
                    "",
                    fixture.service.updatePersonalInstructions("", saved.version).content,
                )
                var conflict: ApiFailure.Http? = null
                try {
                    fixture.service.updatePersonalInstructions("stale overwrite", initial.version)
                } catch (error: ApiFailure.Http) {
                    conflict = error
                }
                assertEquals(409, conflict?.status)
                assertEquals("", fixture.saved.content)
                fixture.responseOwner = "another-user"
                var rejected = false
                try {
                    fixture.service.personalInstructions()
                } catch (_: ApiFailure.IncompatibleResponse) {
                    rejected = true
                }
                assertTrue(rejected)
                fixture.responseOwner = null
                val other =
                    CanonicalWorkspaceSession(
                        fixture.identity.copy(workspaceId = "another-org"),
                        WorkspaceTokenProvider { "fixture-token" },
                    )
                try {
                    rejected = false
                    try {
                        other.personalInstructions()
                    } catch (_: ApiFailure.IncompatibleResponse) {
                        rejected = true
                    }
                    assertTrue(rejected)
                } finally {
                    other.close()
                }
            }
        }

    @Test
    fun aDisconnectedPutIsNotAutomaticallyReplayedAndAuthoritativeReadShowsItsCommit() =
        runBlocking {
            InstructionsApiFixture().use { fixture ->
                val saved = fixture.service.personalInstructions()
                fixture.disconnectSave = true
                var unknown = false
                try {
                    fixture.service.updatePersonalInstructions(
                        "Accepted before disconnect",
                        saved.version,
                    )
                } catch (_: ApiFailure.Network) {
                    unknown = true
                }
                assertTrue(unknown)
                assertEquals(1, fixture.requests.count { it.method == "PUT" })
                assertEquals(
                    "Accepted before disconnect",
                    fixture.service.personalInstructions().content,
                )
            }
        }
}
