package ai.okou.android

import ai.okou.android.auth.SessionModel
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = ChatListApplication::class)
class ArtifactCatalogRootTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val app
        get() = compose.activity.application as ChatListApplication

    @Test
    fun firstDisplayAndSourceReturnUseTheNativeCatalogAndReferenceAuthority() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val firstPage = CountDownLatch(1)
        fixture.beforeCatalog = { firstPage.await() }
        app.responseGate.countDown()
        try {
            awaitText(fixture.sourceTitle)
            assertTrue(fixture.catalogQueries.isEmpty())
            compose.onNodeWithContentDescription("Artifacts").performClick()
            compose.onNodeWithTag("artifact_catalog").assertIsDisplayed()
            compose.onNodeWithContentDescription("Search artifacts").assertIsDisplayed()
            compose.onNodeWithText(fixture.summary.title).assertDoesNotExist()
        } finally {
            firstPage.countDown()
        }
        awaitText(fixture.summary.title)
        compose.onNodeWithText("Today").assertIsDisplayed()
        compose.onNodeWithText("Yesterday").assertIsDisplayed()
        compose.onNodeWithText("Earlier").assertIsDisplayed()
        compose.onNodeWithText(fixture.summary.title).assertHeightIsAtLeast(80.dp)
        compose.onNodeWithTag("artifact_query").performTextReplacement("Product launch")
        awaitText(fixture.summary.title)
        compose.onNodeWithText("Yesterday").assertDoesNotExist()
        compose.onNodeWithText(fixture.summary.title).performClick()
        awaitText("Preview only", partial = true)
        compose.onNodeWithText("Save file").assertDoesNotExist()
        compose
            .onNodeWithText("View source conversation")
            .assertHeightIsAtLeast(48.dp)
            .performClick()
        compose.onNodeWithTag("conversation").assertIsDisplayed()
        compose.onNodeWithContentDescription("Back to artifact preview").performClick()
        awaitText("View source conversation")
        compose.onNodeWithContentDescription("Back to artifacts").performClick()
        awaitText(fixture.summary.title)
        compose.onNodeWithText(fixture.checklist.title).assertDoesNotExist()
        assertTrue(fixture.catalogQueries.contains(null to "Product launch"))
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun wideFiltersKeepThePreviewAndDownloadRechecksTheGrant() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.pageSize = 2
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.image.title)
        assertTrue(fixture.catalogQueries.size >= 3)
        compose.onNodeWithText(fixture.checklist.title).performClick()
        awaitText("Save file")
        compose.onNodeWithText("Images").performClick()
        compose.waitUntil(10_000) { fixture.catalogQueries.contains("image" to null) }
        compose.onNodeWithTag("artifact_preview_title").assertIsDisplayed()
        compose.onNodeWithText("Save file").assertIsDisplayed()
        val model =
            ViewModelProvider(compose.activity)[SessionModel::class.java]
                .uiState
                .value
                .ready!!
                .artifacts
        val saved = ByteArrayOutputStream()
        compose.runOnIdle { model.save(fixture.checklist.id) { saved } }
        awaitText("File saved")
        assertEquals(fixture.checklistBody, saved.toString(Charsets.UTF_8.name()))
        fixture.downloadGranted = false
        compose.runOnIdle {
            model.save(fixture.checklist.id) { error("Denied save opened the destination") }
        }
        awaitText("Download access is unavailable")
        compose.onNodeWithText("Save file").assertDoesNotExist()
        assertEquals(2, fixture.requestedDownloads.size)
    }

    @Test
    fun workspaceSearchKeepsArtifactScopeThroughPreviewAndSourceBack() {
        val fixture =
            ArtifactApiFixture(app.fixture).apply {
                pageSize = 1
                install()
            }
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Search workspace").performClick()
        val scope = compose.onNodeWithTag("search_type_Artifacts")
        val query = compose.onNodeWithTag("chat_search_query")
        scope.performClick()
        query.performTextReplacement("Product launch")
        awaitText(fixture.site.title)
        compose.onNodeWithText(fixture.summary.title).performClick()
        awaitText("Artifact preview")
        awaitText("View source conversation")
        compose.onNodeWithText("View source conversation").performClick()
        compose.onNodeWithTag("conversation").assertIsDisplayed()
        compose.onNodeWithContentDescription("Back to artifact preview").performClick()
        awaitText("View source conversation")
        compose.onNodeWithContentDescription("Close artifact preview").performClick()
        query.assertTextContains("Product launch")
        scope.assertIsSelected()
        compose.onNodeWithText(fixture.summary.title).assertIsDisplayed()
        assertTrue(fixture.catalogQueries.all { it.second == "Product launch" })
    }

    @After
    fun close() {
        app.responseGate.countDown()
        compose.runOnIdle { compose.activity.viewModelStore.clear() }
        app.fixture.close()
        app.cacheSnapshot.restore()
    }

    private fun awaitText(value: String, partial: Boolean = false) {
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithText(value, substring = partial)
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
    }
}
