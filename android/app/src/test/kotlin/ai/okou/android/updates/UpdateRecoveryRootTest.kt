package ai.okou.android.updates

import ai.okou.android.BuildConfig
import ai.okou.android.MainActivity
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.auth.Authentication
import ai.okou.android.auth.AuthenticationState
import android.os.Build
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

class UpdateRecoveryApplication : TestOkouApplication() {
    internal val selected = updateRelease("99.0.0")
    internal val latest = updateRelease("99.1.0")
    internal val fixture =
        ControlledUpdates().apply {
            heldRecovery = CompletableDeferred()
            response = AndroidUpdates(null, latest)
        }
    internal val cachedFile by lazy {
        File(filesDir, "updates/recovered.apk").apply {
            parentFile!!.mkdirs()
            writeText("Verified package service fixture")
        }
    }

    override val updates by lazy {
        fixture.downloaded = cachedFile
        AppUpdates(
            fixture,
            MemoryUpdateStore(
                UpdateRecord(
                    BuildConfig.VERSION_NAME,
                    AndroidUpdates(null, latest),
                    blocked = true,
                    minimum = selected.version,
                    checkedAt = System.currentTimeMillis(),
                    target = selected,
                )
            ),
            BuildConfig.VERSION_NAME,
            Build.VERSION.SDK_INT,
        )
    }

    override fun createAuthentication(): Authentication = TestAuthentication(AuthenticationState())
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = UpdateRecoveryApplication::class)
class UpdateRecoveryRootTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val app
        get() = compose.activity.application as UpdateRecoveryApplication

    @After
    fun closeOwner() {
        app.fixture.heldRecovery!!.complete(Unit)
        app.updates.close()
        app.cachedFile.delete()
    }

    @Test
    fun recoveryKeepsPackageIdentityAndControlsUnavailableAcrossRecreation() {
        compose.onNodeWithText("Preparing…").assertIsDisplayed().assertHasNoClickAction()
        compose.onNodeWithText("New version: 99.0.0").assertExists()
        compose.onNodeWithText("Download update").assertDoesNotExist()
        compose.onNodeWithText("Allow update installation").assertDoesNotExist()
        compose.activityRule.scenario.recreate()
        compose.onNodeWithText("Preparing…").assertIsDisplayed().assertHasNoClickAction()
        app.fixture.heldRecovery!!.complete(Unit)
        compose.waitUntil(10_000) { app.updates.state.value.canInstall }
        compose.onNodeWithText("New version: 99.0.0").assertExists()
        compose.onNodeWithText("Continue installation").assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithText("Allow update installation").assertDoesNotExist()
        assertTrue(app.fixture.downloadedReleases.isEmpty())
        assertTrue(app.updates.state.value.required)
    }

    @Test
    fun missingRecoveredPackageOffersTheLatestDownloadAfterPreparation() {
        compose.onNodeWithText("Preparing…").assertIsDisplayed().assertHasNoClickAction()
        app.cachedFile.delete()
        app.fixture.downloaded = null
        app.fixture.heldRecovery!!.complete(Unit)
        compose.waitUntil(10_000) { app.updates.state.value.canDownload }
        compose.onNodeWithText("New version: 99.1.0").assertExists()
        compose
            .onNodeWithText("Retry download")
            .assertIsDisplayed()
            .assertIsEnabled()
            .performClick()
        compose.waitUntil(10_000) { app.fixture.downloadedReleases.isNotEmpty() }
        assertEquals(listOf(app.latest), app.fixture.downloadedReleases)
        compose.onNodeWithText("Preparing…").assertIsDisplayed().assertHasNoClickAction()
        assertTrue(app.updates.state.value.required)
    }
}
