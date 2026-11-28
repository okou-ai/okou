package ai.okou.android.settings

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.HttpRejection
import ai.okou.android.auth.WorkspaceIdentity
import java.net.UnknownHostException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class BuiltInToolsSettingsTest {
    @Test
    fun catalogFeedbackFollowsTheVisibleReadAndPreservesConfirmedRows() = runTest {
        val fixture = ToolFixture()
        var catalog = CompletableDeferred<List<DataToolFamily>>()
        var now = 0L
        val service =
            object : BuiltInToolsService by fixture {
                override suspend fun catalog() = catalog.await()
            }
        val settings = model(service) { now }
        settings.show()
        runCurrent()
        assertFalse(settings.state.value.catalog.refreshing)
        assertEquals(true, settings.state.value.enabled(webSearchTool))

        catalog.completeExceptionally(ApiFailure.Http(400, null, null, null))
        runCurrent()
        assertTrue(settings.state.value.catalog.initialFailure)
        assertNull(settings.state.value.catalog.refreshFailure)

        catalog = CompletableDeferred(fixture.families)
        settings.hidePage()
        settings.show()
        runCurrent()
        assertEquals(fixture.families, settings.state.value.catalog.value)

        now += 600_001L
        catalog = CompletableDeferred()
        settings.refresh()
        runCurrent()
        assertTrue(settings.state.value.catalog.refreshing)
        assertEquals(fixture.families, settings.state.value.catalog.value)
        settings.hidePage()
        assertFalse(settings.state.value.catalog.refreshing)

        settings.show()
        runCurrent()
        catalog.completeExceptionally(ApiFailure.Http(400, null, null, null))
        runCurrent()
        assertEquals(fixture.families, settings.state.value.catalog.value)
        assertFalse(settings.state.value.catalog.refreshing)
        assertFalse(settings.state.value.catalog.initialFailure)
        assertNotNull(settings.state.value.catalog.refreshFailure)
        settings.hidePage()
        assertNull(settings.state.value.catalog.refreshFailure)

        catalog = CompletableDeferred(fixture.families.reversed())
        settings.show()
        runCurrent()
        assertEquals(fixture.families.reversed(), settings.state.value.catalog.value)
        assertNull(settings.state.value.catalog.refreshFailure)
    }

    @Test
    fun catalogUsesTheRawServerDelayAndFallsBackForAnInvalidHeader() = runTest {
        val fixture = ToolFixture()
        val attempts = mutableListOf<Long>()
        val service =
            object : BuiltInToolsService by fixture {
                override suspend fun catalog(): List<DataToolFamily> {
                    attempts += testScheduler.currentTime
                    return when (attempts.size) {
                        1 -> throw HttpRejection(429, "1", null)
                        2 -> throw HttpRejection(503, "-1", null)
                        else -> fixture.families
                    }
                }
            }
        val settings = model(service)
        settings.show()
        runCurrent()
        advanceTimeBy(1_000L)
        runCurrent()
        assertEquals(listOf(0L, 1_000L), attempts)
        assertNull(settings.state.value.catalog.value)
        advanceTimeBy(3_000L)
        runCurrent()
        assertEquals(listOf(0L, 1_000L, 4_000L), attempts)
        assertEquals(fixture.families, settings.state.value.catalog.value)
    }

    @Test
    fun catalogUsesServerOrderAndDisablingImageGenerationPreservesTheModel() = runTest {
        val service = ToolFixture()
        val settings = model(service)
        assertNull(settings.state.value.catalog.value)
        settings.show()
        runCurrent()
        assertEquals(service.families, settings.state.value.catalog.value)
        assertEquals(initialImage, settings.state.value.displayedImage)

        settings.toggle(imageGenerationTool, false)
        runCurrent()
        assertEquals(false, settings.state.value.enabled(imageGenerationTool))
        settings.chooseImage(otherImage)
        runCurrent()
        assertEquals(initialImage, settings.state.value.displayedImage)
        assertTrue(service.imageWrites.isEmpty())

        settings.toggle(imageGenerationTool, true)
        runCurrent()
        assertEquals(true, settings.state.value.enabled(imageGenerationTool))
        assertEquals(initialImage, settings.state.value.displayedImage)
    }

    @Test
    fun rejectedImageChoiceRollsBackAndCanBeRetried() = runTest {
        val service = ToolFixture().apply { failImage = true }
        val notices = mutableListOf<SettingsNotice>()
        val settings = model(service, notice = { notices += it })
        settings.show()
        runCurrent()

        settings.chooseImage(otherImage)
        assertEquals(otherImage, settings.state.value.displayedImage)
        assertEquals(initialImage, settings.state.value.confirmedImage)
        runCurrent()
        assertEquals(initialImage, settings.state.value.displayedImage)
        assertNull(settings.state.value.pendingImage)
        assertEquals(listOf(SettingsNotice.ImageModelSaveFailed), notices)

        service.failImage = false
        settings.chooseImage(otherImage)
        runCurrent()
        assertEquals(listOf(otherImage, otherImage), service.imageWrites)
        assertEquals(otherImage, settings.state.value.confirmedImage)
        assertNull(settings.state.value.pendingImage)
        assertEquals(listOf(SettingsNotice.ImageModelSaveFailed), notices)

        service.failImage = true
        settings.chooseImage(initialImage)
        settings.leaveSettings()
        settings.show()
        runCurrent()
        assertEquals(otherImage, settings.state.value.displayedImage)
        assertNull(settings.state.value.pendingImage)
        assertEquals(listOf(SettingsNotice.ImageModelSaveFailed), notices)
    }

    @Test
    fun lostImageWriteResponseRollsBackUntilNormalRefresh() = runTest {
        val service = ToolFixture().apply { loseImageResponse = true }
        val settings = model(service)
        settings.show()
        runCurrent()

        settings.chooseImage(otherImage)
        runCurrent()
        assertEquals(listOf(otherImage), service.imageWrites)
        assertEquals(initialImage, settings.state.value.confirmedImage)
        assertNull(settings.state.value.pendingImage)
        settings.refresh()
        runCurrent()
        assertEquals(otherImage, settings.state.value.confirmedImage)
        assertEquals(listOf(otherImage), service.imageWrites)
    }

    @Test
    fun reconnectRefreshesMemberSettingsWhileTheCatalogIsStillLoading() = runTest {
        val fixture = ToolFixture()
        val catalog = CompletableDeferred<List<DataToolFamily>>()
        var online = false
        val service =
            object : BuiltInToolsService by fixture {
                override suspend fun catalog() = catalog.await()

                override suspend fun disabledTools(): Set<String> {
                    if (!online) throw ApiFailure.Network(UnknownHostException())
                    return fixture.disabledTools()
                }

                override suspend fun imageModel(): String? {
                    if (!online) throw ApiFailure.Network(UnknownHostException())
                    return fixture.imageModel()
                }
            }
        val settings = model(service)
        settings.show()
        runCurrent()
        advanceTimeBy(6_000)
        runCurrent()
        assertNull(settings.state.value.enabled(webSearchTool))
        assertNull(settings.state.value.displayedImage)

        online = true
        settings.refresh()
        runCurrent()
        assertEquals(true, settings.state.value.enabled(webSearchTool))
        assertEquals(initialImage, settings.state.value.displayedImage)
        assertNull(settings.state.value.catalog.value)
    }

    @Test
    fun reopeningDuringAToolSaveRefreshesTheOtherTogglesAfterTheSave() = runTest {
        val fixture = ToolFixture()
        val pending = CompletableDeferred<Unit>()
        val settings =
            model(
                object : BuiltInToolsService by fixture {
                    override suspend fun setEnabled(id: String, enabled: Boolean): Boolean {
                        pending.await()
                        return fixture.setEnabled(id, enabled)
                    }
                },
            )
        settings.show()
        runCurrent()
        settings.toggle(webSearchTool, false)
        runCurrent()
        settings.hidePage()
        fixture.setEnabled(imageGenerationTool, false)
        settings.show()
        runCurrent()

        pending.complete(Unit)
        runCurrent()
        assertEquals(false, settings.state.value.enabled(webSearchTool))
        assertEquals(false, settings.state.value.enabled(imageGenerationTool))
    }

    @Test
    fun overlappingRejectedImageChoiceAndDisableRestoreIndependentValues() = runTest {
        val fixture = ToolFixture()
        val modelSave = CompletableDeferred<Unit>()
        val toolSave = CompletableDeferred<Unit>()
        val settings =
            model(
                object : BuiltInToolsService by fixture {
                    override suspend fun selectImageModel(id: String): String {
                        modelSave.await()
                        throw ApiFailure.Http(400, null, null, null)
                    }

                    override suspend fun setEnabled(id: String, enabled: Boolean): Boolean {
                        toolSave.await()
                        throw ApiFailure.Http(400, null, null, null)
                    }
                },
            )
        settings.show()
        runCurrent()
        settings.chooseImage(otherImage)
        settings.toggle(imageGenerationTool, false)
        runCurrent()

        modelSave.complete(Unit)
        runCurrent()
        toolSave.complete(Unit)
        runCurrent()
        assertEquals(true, settings.state.value.enabled(imageGenerationTool))
        assertEquals(initialImage, settings.state.value.confirmedImage)
        assertEquals(initialImage, settings.state.value.displayedImage)
        assertNull(settings.state.value.pendingImage)
    }

    @Test
    fun pendingImageWriteSendsOnlyTheLatestChoiceAfterConfirmation() = runTest {
        val fixture = ToolFixture()
        val pending = CompletableDeferred<Unit>()
        val writes = mutableListOf<String>()
        val settings =
            model(
                object : BuiltInToolsService by fixture {
                    override suspend fun selectImageModel(id: String): String {
                        writes += id
                        if (id == otherImage) pending.await()
                        return fixture.selectImageModel(id)
                    }
                },
            )
        settings.show()
        runCurrent()
        settings.chooseImage(otherImage)
        runCurrent()
        settings.chooseImage("gpt-image-1")
        settings.chooseImage(initialImage)
        assertEquals(listOf(otherImage), writes)
        assertEquals(initialImage, settings.state.value.displayedImage)

        pending.complete(Unit)
        runCurrent()
        assertEquals(listOf(otherImage, initialImage), writes)
        assertEquals(initialImage, settings.state.value.confirmedImage)
        assertNull(settings.state.value.pendingImage)
    }

    @Test
    fun aNewImageChoiceReplacesAThrottledRetry() = runTest {
        val fixture = ToolFixture()
        val writes = mutableListOf<String>()
        val notices = mutableListOf<SettingsNotice>()
        val settings =
            model(
                object : BuiltInToolsService by fixture {
                    override suspend fun selectImageModel(id: String): String {
                        writes += id
                        if (id == otherImage) throw ApiFailure.Http(429, null, null, 10L)
                        return fixture.selectImageModel(id)
                    }
                },
                notice = { notices += it },
            )
        settings.show()
        runCurrent()
        settings.chooseImage(otherImage)
        runCurrent()
        assertEquals(listOf(otherImage), writes)
        assertEquals(otherImage, settings.state.value.displayedImage)

        val latest = "gpt-image-1"
        settings.chooseImage(latest)
        runCurrent()
        assertEquals(latest, settings.state.value.confirmedImage)
        assertNull(settings.state.value.pendingImage)
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(listOf(otherImage, latest), writes)
        assertTrue(notices.isEmpty())
    }

    @Test
    fun aNewerImageChoiceFollowsAnAmbiguousWriteWithoutReadingBack() = runTest {
        val fixture = ToolFixture()
        val release = CompletableDeferred<Unit>()
        var reads = 0
        val writes = mutableListOf<String>()
        val notices = mutableListOf<SettingsNotice>()
        val settings =
            model(
                object : BuiltInToolsService by fixture {
                    override suspend fun imageModel(): String? {
                        reads++
                        return fixture.imageModel()
                    }

                    override suspend fun selectImageModel(id: String): String {
                        writes += id
                        if (id == otherImage) {
                            fixture.selectImageModel(id)
                            release.await()
                            throw ApiFailure.Http(503, null, null, null)
                        }
                        return fixture.selectImageModel(id)
                    }
                },
                notice = { notices += it },
            )
        settings.show()
        runCurrent()
        settings.chooseImage(otherImage)
        runCurrent()
        settings.chooseImage("gpt-image-1")
        release.complete(Unit)
        runCurrent()

        assertEquals(listOf(otherImage, "gpt-image-1"), writes)
        assertEquals("gpt-image-1", settings.state.value.confirmedImage)
        assertEquals(1, reads)
        assertNull(settings.state.value.pendingImage)
        assertTrue(notices.isEmpty())
    }

    @Test
    fun pendingToolChangeOnlySendsTheLatestChoiceAfterConfirmation() = runTest {
        val fixture = ToolFixture()
        val pending = CompletableDeferred<Unit>()
        val writes = mutableListOf<Boolean>()
        val service =
            object : BuiltInToolsService by fixture {
                override suspend fun setEnabled(id: String, enabled: Boolean): Boolean {
                    writes += enabled
                    pending.await()
                    return fixture.setEnabled(id, enabled)
                }
            }
        val settings = model(service)
        settings.show()
        runCurrent()
        settings.toggle(webSearchTool, false)
        runCurrent()
        settings.toggle(webSearchTool, true)
        settings.toggle(webSearchTool, false)
        settings.toggle(webSearchTool, true)
        assertEquals(true, settings.state.value.enabled(webSearchTool))
        assertEquals(listOf(false), writes)

        pending.complete(Unit)
        runCurrent()
        assertEquals(listOf(false, true), writes)
        assertEquals(true, settings.state.value.enabled(webSearchTool))
        assertTrue(settings.state.value.savingTools.isEmpty())
        assertTrue(webSearchTool !in fixture.disabledTools())
    }

    @Test
    fun revertingAToolChoiceEndsTheThrottledRetry() = runTest {
        val fixture = ToolFixture()
        val writes = mutableListOf<Boolean>()
        val notices = mutableListOf<SettingsNotice>()
        val service =
            object : BuiltInToolsService by fixture {
                override suspend fun setEnabled(id: String, enabled: Boolean): Boolean {
                    writes += enabled
                    throw ApiFailure.Http(429, null, null, 10L)
                }
            }
        val settings = model(service, notice = { notices += it })
        settings.show()
        runCurrent()
        settings.toggle(webSearchTool, false)
        runCurrent()
        assertEquals(listOf(false), writes)
        assertEquals(false, settings.state.value.enabled(webSearchTool))

        settings.toggle(webSearchTool, true)
        runCurrent()
        assertTrue(settings.state.value.savingTools.isEmpty())
        assertEquals(true, settings.state.value.enabled(webSearchTool))
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(listOf(false), writes)
        assertTrue(notices.isEmpty())
    }

    @Test
    fun aNewerToolChoiceFollowsAnAmbiguousWriteWithoutReadingBack() = runTest {
        val fixture = ToolFixture()
        val loseResponse = CompletableDeferred<Unit>()
        val writes = mutableListOf<Boolean>()
        val service =
            object : BuiltInToolsService by fixture {
                override suspend fun setEnabled(id: String, enabled: Boolean): Boolean {
                    writes += enabled
                    if (!enabled) {
                        fixture.setEnabled(id, enabled)
                        loseResponse.await()
                        throw ApiFailure.Http(503, null, null, null)
                    }
                    return fixture.setEnabled(id, enabled)
                }
            }
        val notices = mutableListOf<SettingsNotice>()
        val settings = model(service, notice = { notices += it })
        settings.show()
        runCurrent()
        settings.toggle(webSearchTool, false)
        runCurrent()
        settings.toggle(webSearchTool, true)
        loseResponse.complete(Unit)
        runCurrent()

        assertEquals(listOf(false, true), writes)
        assertEquals(true, settings.state.value.enabled(webSearchTool))
        assertTrue(settings.state.value.savingTools.isEmpty())
        assertTrue(webSearchTool !in fixture.disabledTools())
        assertTrue(notices.isEmpty())
    }

    @Test
    fun latestChoiceInAReopenedSettingsVisitReceivesItsSaveFailure() = runTest {
        val fixture = ToolFixture()
        val release = CompletableDeferred<Unit>()
        val service =
            object : BuiltInToolsService by fixture {
                override suspend fun setEnabled(id: String, enabled: Boolean): Boolean {
                    if (enabled) throw ApiFailure.Http(403, null, null, null)
                    release.await()
                    throw ApiFailure.Http(503, null, null, null)
                }
            }
        val notices = mutableListOf<SettingsNotice>()
        val settings = model(service, notice = { notices += it })
        settings.show()
        runCurrent()
        settings.toggle(webSearchTool, false)
        runCurrent()

        settings.leaveSettings()
        settings.show()
        settings.toggle(webSearchTool, true)
        assertEquals(true, settings.state.value.enabled(webSearchTool))
        assertTrue(webSearchTool in settings.state.value.savingTools)
        assertTrue(notices.isEmpty())

        release.complete(Unit)
        runCurrent()

        assertEquals(true, settings.state.value.enabled(webSearchTool))
        assertTrue(settings.state.value.savingTools.isEmpty())
        assertEquals(listOf(SettingsNotice.ToolSaveFailed), notices)
    }

    @Test
    fun ambiguousToolSaveRollsBackAndReportsUncertainty() = runTest {
        val fixture = ToolFixture()
        val writes = mutableListOf<Boolean>()
        var reads = 0
        val service =
            object : BuiltInToolsService by fixture {
                override suspend fun disabledTools(): Set<String> {
                    reads++
                    return fixture.disabledTools()
                }

                override suspend fun setEnabled(id: String, enabled: Boolean): Boolean {
                    writes += enabled
                    fixture.setEnabled(id, enabled)
                    throw ApiFailure.Http(503, null, null, null)
                }
            }
        val notices = mutableListOf<SettingsNotice>()
        val settings = model(service, notice = { notices += it })
        settings.show()
        runCurrent()
        settings.toggle(webSearchTool, false)
        runCurrent()
        assertEquals(1, reads)
        assertEquals(listOf(false), writes)
        assertTrue(settings.state.value.savingTools.isEmpty())
        assertEquals(true, settings.state.value.enabled(webSearchTool))
        assertEquals(listOf(SettingsNotice.ToolSaveUnconfirmed), notices)

        settings.refresh()
        runCurrent()
        assertEquals(2, reads)
        assertEquals(listOf(false), writes)
        assertEquals(false, settings.state.value.enabled(webSearchTool))
        assertEquals(listOf(SettingsNotice.ToolSaveUnconfirmed), notices)
    }

    @Test
    fun rejectedToolWriteRestoresTheConfirmedValueAndReportsFailure() = runTest {
        val fixture = ToolFixture()
        val service =
            object : BuiltInToolsService by fixture {
                override suspend fun disabledTools(): Set<String> {
                    if (settingsWriteRejected) throw ApiFailure.Http(403, null, null, null)
                    return fixture.disabledTools()
                }

                private var settingsWriteRejected = false

                override suspend fun setEnabled(id: String, enabled: Boolean): Boolean {
                    settingsWriteRejected = true
                    throw ApiFailure.Http(403, null, null, null)
                }
            }
        val notices = mutableListOf<SettingsNotice>()
        val settings = model(service, notice = { notices += it })
        settings.show()
        runCurrent()
        settings.toggle(webSearchTool, false)
        assertEquals(false, settings.state.value.enabled(webSearchTool))
        runCurrent()

        assertTrue(settings.state.value.savingTools.isEmpty())
        assertEquals(true, settings.state.value.enabled(webSearchTool))
        assertEquals(listOf(SettingsNotice.ToolSaveFailed), notices)
    }

    private fun TestScope.model(
        service: BuiltInToolsService,
        notice: (SettingsNotice) -> Unit = {},
        nowMillis: () -> Long = System::currentTimeMillis,
    ) =
        BuiltInToolsSettings(
            backgroundScope,
            service,
            WorkspaceIdentity("https://api.okou.ai", "user-a", "session-a", "org-a"),
            cache = null,
            authorized = { true },
            onSessionFailure = {},
            nowMillis = nowMillis,
            notice = notice,
        )

    private class ToolFixture : BuiltInToolsService {
        val families =
            listOf(DataToolFamily("finance", emptyMap()), DataToolFamily("social", emptyMap()))
        val imageWrites = mutableListOf<String>()
        var failImage = false
        var loseImageResponse = false
        private var disabled = emptySet<String>()
        private var image = initialImage

        override suspend fun catalog() = families

        override suspend fun disabledTools() = disabled

        override suspend fun setEnabled(id: String, enabled: Boolean): Boolean {
            disabled = if (enabled) disabled - id else disabled + id
            return enabled
        }

        override suspend fun imageModel() = image

        override suspend fun selectImageModel(id: String): String {
            imageWrites += id
            if (failImage) throw ApiFailure.Http(400, null, null, null)
            image = id
            if (loseImageResponse) throw ApiFailure.Http(503, null, null, null)
            return image
        }
    }

    private companion object {
        const val initialImage = "gpt-image-2.5-flare"
        const val otherImage = "gpt-image-2.5-sunburst"
    }
}
