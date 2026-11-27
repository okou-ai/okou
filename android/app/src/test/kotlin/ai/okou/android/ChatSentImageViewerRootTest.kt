package ai.okou.android

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.swipeRight
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = ChatListApplication::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
internal class ChatSentImageViewerRootTest : ArtifactCatalogRootTestFixture() {
    @Test
    fun startsAtTheTappedImageAndReturnsToItsMessageAfterPaging() {
        val fixture = openConversation()
        compose.onNodeWithContentDescription(fixture.second).performClick()
        awaitPage(2)
        awaitImage(fixture.second)
        compose.waitUntil(10_000) { fixture.originalReads.contains(fixture.second) }
        assertEquals(listOf(fixture.second), fixture.originalReads.toList())

        compose.activityRule.scenario.recreate()
        awaitPage(2)
        awaitImage(fixture.second)
        compose.onNodeWithTag("artifact_image_transform").performKeyInput {
            pressKey(Key.DirectionLeft)
        }
        awaitPage(1)
        awaitImage(fixture.first)
        compose.waitUntil(10_000) { fixture.originalReads.contains(fixture.first) }
        assertEquals(fixture.first, fixture.originalReads.last())

        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        awaitText(fixture.prompt)
        compose.onNodeWithContentDescription(fixture.second).assertIsDisplayed()
        compose.onNodeWithText("Notes.txt").assertIsDisplayed()
    }

    @Test
    fun dragKeepsTheCurrentPageUntilSettledAndRevokedItemCanBeLeft() {
        val fixture = openConversation()
        compose.onNodeWithContentDescription(fixture.first).performClick()
        awaitPage(1)
        awaitImage(fixture.first)
        fixture.denied = fixture.second
        val pager = compose.onNodeWithTag("image_viewer_pager")
        pager.performTouchInput {
            down(center)
            moveBy(Offset(-width * .35f, 0f))
        }
        compose.onNodeWithContentDescription("Image 1 of 2").assertIsDisplayed()
        assertTrue(fixture.second !in fixture.originalReads)
        pager.performTouchInput {
            moveBy(Offset(-width * .40f, 0f))
            up()
        }
        awaitPage(2)
        awaitText("Image unavailable")
        compose.onNodeWithTag("artifact_image_transform").assertDoesNotExist()
        compose.onNodeWithContentDescription("Image actions").assertDoesNotExist()
        assertTrue(fixture.second !in fixture.originalReads)

        pager.performTouchInput { swipeRight() }
        awaitPage(1)
        awaitImage(fixture.first)
    }

    private fun openConversation(): ChatImageGalleryFixture {
        val fixture = ChatImageGalleryFixture(app.fixture)
        fixture.install()
        app.responseGate.countDown()
        awaitText("Personal chat")
        compose.onNodeWithText("Personal chat").performClick()
        awaitText(fixture.prompt)
        return fixture
    }

    private fun awaitPage(number: Int) =
        compose.waitUntilExactlyOneExists(hasContentDescription("Image $number of 2"), 10_000)

    private fun awaitImage(filename: String) =
        compose.waitUntilExactlyOneExists(
            hasTestTag("artifact_image_transform") and hasContentDescription(filename),
            10_000,
        )
}
