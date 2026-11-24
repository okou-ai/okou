package ai.okou.android.settings

import ai.okou.android.api.ApiFailure
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class BuiltInToolsSettingsTest {
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
    fun unconfirmedImageDraftCanBeRetriedAndIsDiscardedOnExit() = runTest {
        val service = ToolFixture().apply { failImage = true }
        val settings = model(service)
        settings.show()
        runCurrent()

        settings.chooseImage(otherImage)
        runCurrent()
        assertTrue(settings.state.value.imageFailed)
        assertEquals(otherImage, settings.state.value.displayedImage)
        assertEquals(initialImage, settings.state.value.confirmedImage)

        service.failImage = false
        settings.chooseImage(otherImage)
        runCurrent()
        assertFalse(settings.state.value.imageFailed)
        assertEquals(listOf(otherImage, otherImage), service.imageWrites)
        assertEquals(otherImage, settings.state.value.confirmedImage)

        service.failImage = true
        settings.chooseImage(initialImage)
        runCurrent()
        settings.hidePage()
        settings.show()
        runCurrent()
        assertTrue(settings.state.value.imageFailed)
        assertEquals(initialImage, settings.state.value.displayedImage)

        settings.leaveSettings()
        settings.show()
        runCurrent()
        assertFalse(settings.state.value.imageFailed)
        assertEquals(otherImage, settings.state.value.displayedImage)
    }

    @Test
    fun lostImageWriteResponseUsesReadbackWithoutRepeatingTheWrite() = runTest {
        val service = ToolFixture().apply { loseImageResponse = true }
        val settings = model(service)
        settings.show()
        runCurrent()

        settings.chooseImage(otherImage)
        runCurrent()
        assertEquals(listOf(otherImage), service.imageWrites)
        assertEquals(otherImage, settings.state.value.confirmedImage)
        assertNull(settings.state.value.draftImage)
        assertFalse(settings.state.value.imageFailed)
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
        advanceTimeBy(settingsReadRetryDelayMillis * (settingsReadAttempts - 1))
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
    fun failedImageChoiceSurvivesARejectedDisableWhileItIsSaving() = runTest {
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
        assertEquals(otherImage, settings.state.value.displayedImage)
        assertTrue(settings.state.value.imageFailed)
    }

    @Test
    fun refreshClearsAFailedImageDraftOnceTheServerConfirmsIt() = runTest {
        val fixture = ToolFixture()
        var readUnavailable = false
        val settings =
            model(
                object : BuiltInToolsService by fixture {
                    override suspend fun selectImageModel(id: String): String {
                        fixture.selectImageModel(id)
                        readUnavailable = true
                        throw ApiFailure.Http(503, null, null, null)
                    }

                    override suspend fun imageModel(): String? {
                        if (readUnavailable) throw ApiFailure.Network(UnknownHostException())
                        return fixture.imageModel()
                    }
                },
            )
        settings.show()
        runCurrent()
        settings.chooseImage(otherImage)
        runCurrent()
        advanceTimeBy(settingsReadRetryDelayMillis * (settingsReadAttempts - 1))
        runCurrent()
        assertEquals(otherImage, settings.state.value.displayedImage)
        assertTrue(settings.state.value.imageFailed)

        readUnavailable = false
        settings.refresh()
        runCurrent()
        assertEquals(otherImage, settings.state.value.confirmedImage)
        assertNull(settings.state.value.draftImage)
        assertFalse(settings.state.value.imageFailed)
        assertEquals(listOf(otherImage), fixture.imageWrites)
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

    private fun TestScope.model(service: BuiltInToolsService) =
        BuiltInToolsSettings(
            backgroundScope,
            service,
            WorkspaceIdentity("https://api.okou.ai", "user-a", "session-a", "org-a"),
            cache = null,
            authorized = { true },
            onSessionFailure = {},
            notice = {},
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
