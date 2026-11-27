package ai.okou.android.settings

import ai.okou.android.ChatListApiFixture
import ai.okou.android.ProactiveSettingsApiFixture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class ProactiveSettingsModelTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun morningLoadsIndependentlyAndSuggestionsWritesBothChannelsFromPartial() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = ProactiveSettingsApiFixture(api).apply { suggestionsEligible = false }
            val model = model(api)
            runCurrent()
            assertTrue(fixture.reads.isEmpty())

            model.visible(true)
            assertEquals(false, model.morningBrief.state.first { it.confirmed != null }.enabled)
            model.suggestions.state.first { it.hidden }
            assertTrue(fixture.reads.containsAll(listOf("morning-brief", "suggestions")))

            fixture.suggestionsEligible = true
            fixture.cardsEnabled = true
            model.visible(false)
            model.visible(true)
            val partial = model.suggestions.state.first { it.confirmed?.partial == true }
            assertEquals(false, partial.confirmed?.enabled)
            assertEquals(true, partial.confirmed?.cardsEnabled)
            model.suggestions.choose(false)
            model.suggestions.state.first {
                it.confirmed?.matches(false) == true && it.choice == null
            }
            assertEquals(listOf(ProactiveSetting.Suggestions to false), fixture.writes)
            assertFalse(fixture.cardsEnabled)
        }
    }

    @Test
    fun rapidChangesKeepTheLatestIntentWhileTheOtherServiceCanSave() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = ProactiveSettingsApiFixture(api)
            val writeStarted = CountDownLatch(1)
            val writeResponse = CountDownLatch(1)
            fixture.beforeMorningWrite = {
                writeStarted.countDown()
                check(writeResponse.await(10, TimeUnit.SECONDS))
            }
            val model = model(api)
            try {
                model.visible(true)
                model.morningBrief.state.first { it.confirmed != null }
                model.suggestions.state.first { it.confirmed != null }
                model.morningBrief.choose(true)
                assertEquals(true, model.morningBrief.state.value.enabled)
                withContext(Dispatchers.IO) { assertTrue(writeStarted.await(10, TimeUnit.SECONDS)) }
                model.morningBrief.choose(false)
                assertEquals(false, model.morningBrief.state.value.enabled)
                model.suggestions.choose(true)
                model.suggestions.state.first {
                    it.confirmed?.matches(true) == true && it.choice == null
                }
                assertEquals(
                    listOf(
                        ProactiveSetting.MorningBrief to true,
                        ProactiveSetting.Suggestions to true,
                    ),
                    fixture.writes,
                )
                writeResponse.countDown()
                model.morningBrief.state.first {
                    it.confirmed?.matches(false) == true && it.choice == null
                }
                assertEquals(
                    listOf(true, false),
                    fixture.writes
                        .filter { it.first == ProactiveSetting.MorningBrief }
                        .map { it.second },
                )
            } finally {
                writeResponse.countDown()
            }
        }
    }

    @Test
    fun schedulingErrorPreservesTheSavedChoiceAndRejectionRestoresIt() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = ProactiveSettingsApiFixture(api).apply { scheduleError = true }
            val model = model(api)
            model.visible(true)
            model.morningBrief.state.first { it.confirmed != null }
            model.morningBrief.choose(true)
            val confirmed =
                model.morningBrief.state.first {
                    it.confirmed?.status == ProactiveStatus.Error && it.choice == null
                }
            assertEquals(true, confirmed.enabled)

            fixture.morningWriteStatus = 400
            val feedback =
                async(start = CoroutineStart.UNDISPATCHED) {
                    model.saveFailures.first { it.isNotEmpty() }.single().value
                }
            model.morningBrief.choose(false)
            assertEquals(false, model.morningBrief.state.value.enabled)
            assertEquals(ProactiveSetting.MorningBrief, feedback.await())
            assertEquals(true, model.morningBrief.state.value.enabled)
            assertEquals(listOf(true, false), fixture.writes.map { it.second })
        }
    }

    @Test
    fun revertingAQueuedToggleSkipsTheWriteWhenTheEarlierChoiceIsRejected() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = ProactiveSettingsApiFixture(api).apply { morningWriteStatus = 400 }
            val writeStarted = CountDownLatch(1)
            val releaseWrite = CountDownLatch(1)
            fixture.beforeMorningWrite = {
                writeStarted.countDown()
                check(releaseWrite.await(10, TimeUnit.SECONDS))
            }
            val model = model(api)
            try {
                model.visible(true)
                model.morningBrief.state.first { it.confirmed?.matches(false) == true }
                model.morningBrief.choose(true)
                withContext(Dispatchers.IO) { assertTrue(writeStarted.await(10, TimeUnit.SECONDS)) }
                model.morningBrief.choose(false)
                assertEquals(false, model.morningBrief.state.value.enabled)
                releaseWrite.countDown()

                val settled = model.morningBrief.state.first { it.choice == null }
                assertEquals(false, settled.enabled)
                assertEquals(listOf(ProactiveSetting.MorningBrief to true), fixture.writes)
                runCurrent()
                assertTrue(model.saveFailures.value.isEmpty())
            } finally {
                releaseWrite.countDown()
            }
        }
    }

    @Test
    fun exhaustedReadbackRollsBackAndLateServerStateSyncsWithoutResending() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = ProactiveSettingsApiFixture(api)
            val model = model(api)
            model.visible(true)
            model.morningBrief.state.first { it.confirmed != null }
            fixture.morningWriteStatus = 503
            val failure =
                async(start = CoroutineStart.UNDISPATCHED) {
                    model.saveFailures.first { it.isNotEmpty() }.single().value
                }
            model.morningBrief.choose(true)
            val checking = model.morningBrief.state.first { it.checking }
            assertEquals(true, checking.enabled)
            assertEquals(false, checking.confirmed?.enabled)
            assertFalse(failure.isCompleted)
            val rolledBack = model.morningBrief.state.first { it.choice == null }
            assertFalse(rolledBack.checking)
            assertTrue(rolledBack.canChoose)
            assertEquals(false, rolledBack.enabled)
            assertEquals(ProactiveSetting.MorningBrief, failure.await())
            assertEquals(4, fixture.reads.count { it == "morning-brief" })

            fixture.morningEnabled = true
            model.refresh()
            model.morningBrief.state.first { it.enabled == true && !it.checking }
            assertEquals(listOf(ProactiveSetting.MorningBrief to true), fixture.writes)
        }
    }

    @Test
    fun aNewerToggleSurvivesAnExhaustedReadback() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = ProactiveSettingsApiFixture(api).apply { morningWriteStatus = 503 }
            val model = model(api)
            model.visible(true)
            model.morningBrief.state.first { it.confirmed != null }
            model.morningBrief.choose(true)
            model.morningBrief.state.first { it.checking }

            fixture.morningWriteStatus = 200
            model.morningBrief.choose(false)
            assertEquals(false, model.morningBrief.state.value.enabled)
            assertEquals(listOf(true), fixture.writes.map { it.second })

            val confirmed = model.morningBrief.state.first { it.choice == null }
            assertEquals(false, confirmed.confirmed?.enabled)
            assertFalse(confirmed.checking)
            assertEquals(listOf(true, false), fixture.writes.map { it.second })
            assertEquals(4, fixture.reads.count { it == "morning-brief" })
        }
    }

    @Test
    fun aQueuedRefreshWaitsForTheChoiceAfterCancellingItsOlderRead() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = ProactiveSettingsApiFixture(api)
            val scope =
                CoroutineScope(
                    backgroundScope.coroutineContext + UnconfinedTestDispatcher(testScheduler),
                )
            val model = model(api, scope = scope)
            model.visible(true)
            model.morningBrief.state.first { it.confirmed != null }

            val oldReadStarted = CountDownLatch(1)
            val oldReadResponse = CountDownLatch(1)
            val writeStarted = CountDownLatch(1)
            val writeResponse = CountDownLatch(1)
            val firstRefreshValue = CompletableDeferred<Boolean>()
            fixture.beforeMorningRead = {
                if (oldReadStarted.count != 0L) {
                    oldReadStarted.countDown()
                    check(oldReadResponse.await(10, TimeUnit.SECONDS))
                } else {
                    firstRefreshValue.complete(fixture.morningEnabled)
                }
            }
            fixture.beforeMorningWrite = {
                writeStarted.countDown()
                check(writeResponse.await(10, TimeUnit.SECONDS))
            }
            try {
                model.refresh()
                withContext(Dispatchers.IO) {
                    assertTrue(oldReadStarted.await(10, TimeUnit.SECONDS))
                }
                model.refresh()
                model.morningBrief.choose(true)
                withContext(Dispatchers.IO) { assertTrue(writeStarted.await(10, TimeUnit.SECONDS)) }
                oldReadResponse.countDown()
                writeResponse.countDown()
                model.morningBrief.state.first {
                    it.confirmed?.matches(true) == true && it.choice == null
                }
                assertTrue(firstRefreshValue.await())
            } finally {
                oldReadResponse.countDown()
                writeResponse.countDown()
            }
        }
    }

    @Test
    fun aRefreshDuringAnOldReadObservesTheNewTimezone() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = ProactiveSettingsApiFixture(api).apply { morningNeedsTimezone = true }
            val readStarted = CountDownLatch(1)
            val release = CountDownLatch(1)
            fixture.beforeMorningRead = {
                readStarted.countDown()
                check(release.await(10, TimeUnit.SECONDS))
            }
            val model = model(api)
            try {
                model.visible(true)
                withContext(Dispatchers.IO) { assertTrue(readStarted.await(10, TimeUnit.SECONDS)) }
                fixture.morningNeedsTimezone = false
                model.refresh()
                release.countDown()
                model.morningBrief.state.first { it.confirmed?.needsTimezone == false }
                assertEquals(2, fixture.reads.count { it == "morning-brief" })
            } finally {
                release.countDown()
            }
        }
    }

    @Test
    fun confirmedCacheIsRestoredOnlyForItsAuthorizedWorkspace() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = ProactiveSettingsApiFixture(api).apply { morningEnabled = true }
            val file = temporary.newFolder().resolve("proactive.preferences_pb")
            val cache = WorkspaceSettingsCache.create(backgroundScope) { file }
            val model = model(api, cache)
            model.visible(true)
            model.morningBrief.state.first { it.confirmed != null }
            val cached =
                cache.load(
                    api.identity,
                    ProactiveSetting.MorningBrief.cacheKey,
                    ProactivePreference.serializer(),
                )
            assertEquals(true, cached?.value?.enabled)
            assertNull(
                cache.load(
                    api.identity.copy(userId = "retired-member"),
                    ProactiveSetting.MorningBrief.cacheKey,
                    ProactivePreference.serializer(),
                ),
            )
            assertNull(
                cache.load(
                    api.identity.copy(workspaceId = "other-org"),
                    ProactiveSetting.MorningBrief.cacheKey,
                    ProactivePreference.serializer(),
                ),
            )

            val reopened = model(api, cache)
            reopened.visible(true)
            val restored = reopened.morningBrief.state.first { it.confirmed != null }
            assertEquals(true, restored.enabled)
            assertTrue(restored.canChoose)
        }
    }

    @Test
    fun retiredWorkspaceCannotPublishAReadReleasedAfterItsAuthorizationChanges() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = ProactiveSettingsApiFixture(api)
            val readStarted = CountDownLatch(1)
            val readResponse = CountDownLatch(1)
            fixture.beforeMorningRead = {
                readStarted.countDown()
                check(readResponse.await(10, TimeUnit.SECONDS))
            }
            val job = Job(backgroundScope.coroutineContext[Job])
            var authorized = true
            val model =
                model(
                    api,
                    scope = CoroutineScope(backgroundScope.coroutineContext + job),
                    authorized = { authorized },
                )
            try {
                model.visible(true)
                withContext(Dispatchers.IO) { assertTrue(readStarted.await(10, TimeUnit.SECONDS)) }
                val inFlight = job.children.toList()
                authorized = false
                readResponse.countDown()
                inFlight.forEach { it.join() }
                assertNull(model.morningBrief.state.value.confirmed)
            } finally {
                readResponse.countDown()
                job.cancelAndJoin()
            }
        }
    }

    private fun TestScope.model(
        api: ChatListApiFixture,
        cache: WorkspaceSettingsCache? = null,
        scope: CoroutineScope = backgroundScope,
        authorized: () -> Boolean = { true },
    ) =
        ProactiveSettingsModel(
            scope,
            api.service.proactivePreferences,
            api.identity,
            cache,
            authorized,
        ) {}
}
