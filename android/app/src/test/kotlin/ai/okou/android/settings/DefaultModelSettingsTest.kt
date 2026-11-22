package ai.okou.android.settings

import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.DefaultModelPreference
import ai.okou.android.api.generated.DefaultModelPreferenceServiceTier
import ai.okou.android.api.generated.UpdateDefaultModelPreference
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.jsonResponse
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DefaultModelSettingsTest {
    @Test
    fun offlineEditsCoalesceAndForegroundReadsTheOtherDevicesChoice() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val model = DefaultModelSettings(backgroundScope, api.service, { true }, { throw it })
            model.visible(true)
            val loaded = model.state.first { it.options != null }
            assertEquals("gpt-test", loaded.selected?.id)
            assertEquals(ModelEffort.MEDIUM, loaded.effort)
            model.online(false)
            model.fast(true)
            model.effort(ModelEffort.HIGH)
            assertTrue(model.state.value.fast)
            assertTrue(fixture.writes.isEmpty())

            model.online(true)
            val saved = model.state.first { it.pending == null }
            assertEquals(ModelEffort.HIGH, saved.effort)
            val update = fixture.writes.single()
            assertEquals(JsonPrimitive("priority"), update["serviceTier"])
            assertEquals(
                JsonPrimitive("high"),
                update["modelSettingsPatch"]?.jsonObject?.get("effort"),
            )
            assertFalse(update.containsKey("selectedImageModel"))
            assertEquals(
                JsonPrimitive("high"),
                fixture.preference["modelSettings"]
                    ?.jsonObject
                    ?.get("claude-test")
                    ?.jsonObject
                    ?.get("effort"),
            )

            val claude = saved.options!!.choices.single { it.id == "claude-test" }
            model.select(claude.id)
            val switched = model.state.first { it.pending == null }
            assertEquals(ModelEffort.HIGH, switched.effort)
            assertFalse(switched.fast)
            assertEquals(JsonNull, fixture.writes.last()["serviceTier"])

            model.visible(false)
            fixture.selectAutoElsewhere()
            model.visible(true)
            val refreshed = model.state.first { it.preference?.selectedModel == null }
            assertNull(refreshed.selected)
            assertNull(refreshed.effort)
            assertEquals(2, fixture.writes.size)
        }
    }

    @Test
    fun initialReadFailureReplacesThePlaceholderBeforeTheFirstRetry() = runTest {
        ChatListApiFixture().use { api ->
            DefaultModelApiFixture(api)
            val respond = api.commandResponse
            val reads = AtomicInteger()
            api.commandResponse = { request ->
                if (
                    request.requestUrl?.encodedPath == "/api/user-model-preference" &&
                        reads.incrementAndGet() == 1
                )
                    jsonResponse("{}").setResponseCode(503)
                else respond(request)
            }
            val errors = Channel<Exception>(capacity = 1)
            val model =
                DefaultModelSettings(backgroundScope, api.service, { true }) {
                    check(errors.trySend(it).isSuccess)
                }
            model.visible(true)

            assertEquals(503, (errors.receive() as ApiFailure.Http).status)
            runCurrent()
            assertEquals(DefaultModelFailure.Read, model.state.value.failure)
            assertNull(model.state.value.options)
            assertEquals(1, reads.get())

            val recovered = model.state.first { it.options != null }
            assertFalse(recovered.failed)
            assertEquals("gpt-test", recovered.selected?.id)
        }
    }

    @Test
    fun cachedOptionsReportAReadFailureOnlyAfterThreeAttemptsAndThirtySeconds() = runTest {
        ChatListApiFixture().use { api ->
            DefaultModelApiFixture(api)
            var preference = api.service.defaultModelPreference()
            val catalog = api.service.recoveryCatalog()
            val models = api.service.recoveryModels()
            var unavailable = false
            val attempts = mutableListOf<Long>()
            val saving = CompletableDeferred<Unit>()
            val completeSave = CompletableDeferred<Unit>()
            val service =
                object : WorkspaceSession by api.service {
                    override suspend fun recoveryCatalog() = catalog

                    override suspend fun recoveryModels() = models

                    override suspend fun defaultModelPreference() =
                        if (unavailable) {
                            attempts += currentTime
                            throw ApiFailure.Http(503, null, null, null)
                        } else preference

                    override suspend fun updateDefaultModelPreference(
                        update: UpdateDefaultModelPreference
                    ): DefaultModelPreference {
                        saving.complete(Unit)
                        completeSave.await()
                        preference =
                            preference.copy(
                                serviceTier = DefaultModelPreferenceServiceTier.PRIORITY
                            )
                        return preference
                    }
                }
            val model = DefaultModelSettings(backgroundScope, service, { true }, {})
            model.visible(true)
            runCurrent()
            assertEquals("gpt-test", model.state.value.selected?.id)

            model.visible(false)
            unavailable = true
            val started = currentTime
            model.visible(true)
            runCurrent()
            advanceTimeBy(5_000)
            runCurrent()
            assertFalse(model.state.value.failed)
            advanceTimeBy(10_000)
            runCurrent()
            assertEquals(listOf(started, started + 5_000, started + 15_000), attempts)

            advanceTimeBy(14_999)
            runCurrent()
            assertFalse(model.state.value.failed)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(3, attempts.size)
            assertEquals(DefaultModelFailure.Read, model.state.value.failure)
            assertEquals("gpt-test", model.state.value.selected?.id)

            model.fast(true)
            runCurrent()
            assertTrue(saving.isCompleted)
            model.online(false)
            model.online(true)
            completeSave.complete(Unit)
            runCurrent()
            assertNull(model.state.value.pending)
            assertEquals(4, attempts.size)
            assertFalse(model.state.value.failed)

            unavailable = false
            advanceTimeBy(5_000)
            runCurrent()
            assertFalse(model.state.value.failed)
            assertTrue(model.state.value.fast)
        }
    }

    @Test
    fun reconnectImmediatelyConfirmsAnUnreadableSaveResponseWithoutAnotherWrite() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val respond = api.commandResponse
            api.commandResponse = { request ->
                val response = respond(request)
                if (
                    request.method == "PUT" &&
                        request.requestUrl?.encodedPath == "/api/user-model-preference"
                )
                    jsonResponse("{}")
                else response
            }
            val errors = Channel<Exception>(capacity = 1)
            val model =
                DefaultModelSettings(backgroundScope, api.service, { true }) {
                    check(errors.trySend(it).isSuccess)
                }
            model.visible(true)
            assertFalse(model.state.first { it.options != null }.fast)

            model.fast(true)

            assertTrue(errors.receive() is ApiFailure.IncompatibleResponse)
            runCurrent()
            val failedAt = currentTime
            model.online(false)
            advanceTimeBy(1_000)
            assertTrue(model.state.value.pending != null)
            model.online(true)

            val saved = model.state.first { it.pending == null }
            assertEquals(failedAt + 1_000, currentTime)
            assertTrue(saved.fast)
            assertFalse(saved.failed)
            assertEquals(JsonPrimitive("priority"), fixture.writes.single()["serviceTier"])
        }
    }

    @Test
    fun rejectedReadbackKeepsTheUnconfirmedChoiceUntilReconnect() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val respond = api.commandResponse
            val blockReadback = AtomicBoolean(true)
            val blockedReads = AtomicInteger()
            api.commandResponse = { request ->
                val response = respond(request)
                when {
                    request.requestUrl?.encodedPath != "/api/user-model-preference" -> response
                    request.method == "PUT" -> jsonResponse("{}")
                    blockReadback.get() && fixture.writes.isNotEmpty() -> {
                        blockedReads.incrementAndGet()
                        jsonResponse("{}").setResponseCode(403)
                    }
                    else -> response
                }
            }
            val model = DefaultModelSettings(backgroundScope, api.service, { true }, {})
            model.visible(true)
            assertFalse(model.state.first { it.options != null }.fast)
            model.fast(true)

            val blocked = model.state.first { it.failure == DefaultModelFailure.Save }
            assertTrue(blocked.pending != null)
            assertTrue(blocked.fast)
            assertEquals(JsonPrimitive("priority"), fixture.writes.single()["serviceTier"])
            advanceTimeBy(60_000)
            runCurrent()
            assertEquals(1, blockedReads.get())
            assertEquals(1, fixture.writes.size)

            model.online(false)
            blockReadback.set(false)
            model.online(true)
            val confirmed = model.state.first { it.pending == null }
            assertTrue(confirmed.fast)
            assertFalse(confirmed.failed)
            assertEquals(1, fixture.writes.size)
        }
    }

    @Test
    fun unconfirmedReadbacksPreserveTheBackoffForRepeatedSaveFailures() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val respond = api.commandResponse
            val saves = AtomicInteger()
            api.commandResponse = { request ->
                if (
                    request.method == "PUT" &&
                        request.requestUrl?.encodedPath == "/api/user-model-preference" &&
                        saves.incrementAndGet() <= 2
                )
                    jsonResponse("{}").setResponseCode(503)
                else respond(request)
            }
            val errors = Channel<Exception>(capacity = 2)
            val model =
                DefaultModelSettings(backgroundScope, api.service, { true }) {
                    check(errors.trySend(it).isSuccess)
                }
            model.visible(true)
            model.state.first { it.options != null }

            model.fast(true)

            assertEquals(503, (errors.receive() as ApiFailure.Http).status)
            runCurrent()
            assertFalse(model.state.value.failed)
            assertEquals(503, (errors.receive() as ApiFailure.Http).status)
            runCurrent()
            assertTrue(model.state.value.failed)
            assertTrue(model.state.value.fast)
            assertEquals(JsonNull, fixture.preference["serviceTier"])
            advanceTimeBy(29_999)
            assertEquals(2, saves.get())

            val saved = model.state.first { it.pending == null }
            assertTrue(saved.fast)
            assertFalse(saved.failed)
            assertEquals(3, saves.get())
            assertEquals(JsonPrimitive("priority"), fixture.writes.single()["serviceTier"])
        }
    }

    @Test
    fun restoredEffortTracksTheMemberExecutionRouteWithoutOverwritingTheSavedChoice() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api, piUltra = true)
            fixture.preference =
                JsonObject(
                    fixture.preference +
                        ("modelSettings" to
                            JsonObject(
                                mapOf(
                                    "gpt-test" to
                                        JsonObject(mapOf("effort" to JsonPrimitive("ultra")))
                                )
                            ))
                )
            val model = DefaultModelSettings(backgroundScope, api.service, { true }, { throw it })
            model.visible(true)

            val pi = model.state.first { it.options != null }
            assertEquals(ModelEffort.MEDIUM, pi.effort)
            assertFalse(ModelEffort.ULTRA in checkNotNull(pi.selected).efforts)
            model.effort(ModelEffort.ULTRA)
            assertNull(model.state.value.pending)

            model.visible(false)
            fixture.codexExecution = true
            model.visible(true)

            val codex = model.state.first { it.effort == ModelEffort.ULTRA }
            assertTrue(ModelEffort.ULTRA in checkNotNull(codex.selected).efforts)
            assertTrue(fixture.writes.isEmpty())
        }
    }

    @Test
    fun rejectedOfflineEditRemainsVisibleAfterTheReconnectRefresh() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val respond = api.commandResponse
            api.commandResponse = { request ->
                if (
                    request.method == "PUT" &&
                        request.requestUrl?.encodedPath == "/api/user-model-preference"
                )
                    jsonResponse("{}").setResponseCode(400)
                else respond(request)
            }
            val model =
                DefaultModelSettings(backgroundScope, api.service, { true }) {
                    assertEquals(400, (it as ApiFailure.Http).status)
                }
            model.visible(true)
            model.state.first { it.options != null }
            model.online(false)
            model.fast(true)
            fixture.gptSortOrder = 3
            model.online(true)

            val refreshed =
                model.state.first { it.options?.choices?.lastOrNull()?.id == "gpt-test" }
            assertTrue(refreshed.failed)
            assertFalse(refreshed.fast)
            assertNull(refreshed.pending)
            assertEquals(JsonNull, fixture.preference["serviceTier"])
        }
    }
}
