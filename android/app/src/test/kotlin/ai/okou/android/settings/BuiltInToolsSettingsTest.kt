package ai.okou.android.settings

import ai.okou.android.api.ApiFailure
import ai.okou.android.auth.WorkspaceIdentity
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
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
