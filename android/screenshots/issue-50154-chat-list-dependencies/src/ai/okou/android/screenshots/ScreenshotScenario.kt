package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.auth.OpeningWorkspace
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.awaitKeyboardFocus
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.ProjectExpansionModel
import ai.okou.android.chatListRegion
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.content.res.Configuration
import android.os.LocaleList
import android.view.KeyEvent
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun capturesChatListDependencyRecovery() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val savedAuth = auth.state.value
        val savedService = app.chatService
        val savedOnline = app.connectivity.value
        val savedPreferences = app.snapshotApiPreferences()
        val savedInitialPreferences = app.initialPreferences
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val savedLocales = localeManager.applicationLocales
        val targetLocales = LocaleList.forLanguageTags("zh-Hant")
        val labels =
            app.createConfigurationContext(
                Configuration(app.resources.configuration).apply { setLocales(targetLocales) }
            )
        val savedCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val preferenceFile = app.noBackupFilesDir.resolve("project-expansion.preferences_pb")
        val originalExpansion = preferenceFile.takeIf { it.isFile }?.readBytes()
        val fixture = ChatListApiFixture()
        val releaseFirstRead = CountDownLatch(1)
        val indicatorAttempts = AtomicInteger()
        val metadataFailures = AtomicInteger()
        val warmIndicatorFailures = AtomicInteger()
        val failWarmRefresh = AtomicBoolean()
        val goodIndicators = fixture.indicators
        val goodMetadata = fixture.projectEvents
        fixture.indicators = {
            val attempt = indicatorAttempts.incrementAndGet()
            if (attempt == 1) releaseFirstRead.await()
            when {
                attempt <= 3 -> MockResponse().setResponseCode(503)
                failWarmRefresh.get() -> {
                    warmIndicatorFailures.incrementAndGet()
                    MockResponse().setResponseCode(503)
                }
                else -> goodIndicators()
            }
        }
        fixture.projectEvents = { request ->
            if (failWarmRefresh.get()) {
                metadataFailures.incrementAndGet()
                MockResponse().setResponseCode(503)
            } else goodMetadata(request)
        }
        app.chatService = fixture.service
        app.connectivity.value = true
        auth.state.value = testAuthenticationState(user = "chat-dependencies-${UUID.randomUUID()}")
        val failures = mutableListOf<Throwable>()
        var scenario: ActivityScenario<MainActivity>? = null
        var jobs = emptyList<Job>()
        val filter = By.pkg(app.packageName).desc(labels.getString(R.string.chat_filter))
        val loading = By.pkg(app.packageName).desc(labels.getString(R.string.chat_loading))
        val syncing = By.pkg(app.packageName).desc(labels.getString(R.string.chat_syncing))
        val unread = By.pkg(app.packageName).text(labels.getString(R.string.chat_unread))
        val status =
            By.pkg(app.packageName).text(labels.getString(R.string.chat_list_first_load_failed))
        val retry = By.pkg(app.packageName).text(labels.getString(R.string.retry))
        val project = By.pkg(app.packageName).text("Research")
        val projectChat = By.pkg(app.packageName).text("Project chat")
        val oldSaveNotice = By.pkg(app.packageName).text("專案展開狀態無法保留至下次。")
        val oldReadNotice = By.pkg(app.packageName).text("暫時無法讀取已儲存的專案展開狀態。")

        fun selectFilter(label: Int) {
            device.await(filter).click()
            device.await(By.pkg(app.packageName).text(labels.getString(label))).click()
        }

        try {
            app.initialPreferences = testPreferences().copy(locale = UserPreferencesLocale.ZH_HANT)
            instrumentation.runOnMainSync { localeManager.applicationLocales = targetLocales }
            val activity = ActivityScenario.launch(MainActivity::class.java)
            scenario = activity
            device.awaitChatList(labels)
            val (chats, expansion) = activity.owners()
            jobs =
                listOfNotNull(
                    chats.viewModelScope.coroutineContext[Job],
                    expansion.viewModelScope.coroutineContext[Job],
                )
            device.await(By.pkg(app.packageName).text("Personal chat"))
            device.await(project)
            selectFilter(R.string.chat_unread)
            val heading = By.copy(unread).hasAncestor(chatListRegion(labels))
            device.await(heading)
            val skeletonBounds = device.await(loading).visibleBounds
            val filterBounds = device.await(filter).visibleBounds
            assertEquals(1, indicatorAttempts.get())
            assertFalse(device.hasObject(status))
            ScreenshotCapture.capture("unread-loading.png")

            releaseFirstRead.countDown()
            device.awaitState("The first three Unread attempts should have failed") {
                chats.uiState.value.indicatorsRetryProgressVisible
            }
            assertEquals(3, indicatorAttempts.get())
            assertEquals(skeletonBounds, device.await(loading).visibleBounds)
            assertEquals(filterBounds, device.await(filter).visibleBounds)
            assertFalse(device.hasObject(retry))
            assertFalse(device.hasObject(status))
            assertFalse(device.hasObject(syncing))
            ScreenshotCapture.capture("unread-retrying.png")

            device.await(project)
            assertEquals(4, indicatorAttempts.get())
            assertFalse(device.hasObject(status))
            assertEquals(filterBounds, device.await(filter).visibleBounds)
            ScreenshotCapture.capture("unread-recovered.png")

            device.await(project).click()
            device.await(projectChat)
            device.awaitState("The expansion and unread data should be confirmed") {
                chats.uiState.value.indicatorsPhase == ChatReadPhase.Ready &&
                    !expansion.state.value.hasLocalChoices
            }
            val rowBeforeRefresh = device.await(project).visibleBounds
            failWarmRefresh.set(true)
            activity.onActivity {
                chats.refreshMetadata()
                chats.refreshIndicators()
            }
            device.awaitState("Both background reads should wait for recovery") {
                metadataFailures.get() == 1 &&
                    warmIndicatorFailures.get() == 1 &&
                    chats.uiState.value.projectsPhase == ChatReadPhase.Loading &&
                    chats.uiState.value.indicatorsPhase == ChatReadPhase.Loading
            }
            assertEquals(rowBeforeRefresh, device.await(project).visibleBounds)
            device.await(projectChat)
            device.await(By.pkg(app.packageName).text("暫時無法取得專案資訊。"))
            device.await(syncing)
            assertEquals(3, metadataFailures.get())
            assertEquals(3, warmIndicatorFailures.get())
            device.await(projectChat)
            assertFalse(device.hasObject(retry))
            ScreenshotCapture.capture("chat-list-retained-dependencies.png")
            failWarmRefresh.set(false)
            activity.onActivity { chats.refreshMetadata() }
            device.awaitState("Warm reads should finish before checking local storage") {
                chats.uiState.value.projectsPhase == ChatReadPhase.Ready &&
                    chats.uiState.value.indicatorsPhase == ChatReadPhase.Ready
            }

            selectFilter(R.string.chat_inbox)
            device.await(project).click()
            assertTrue(device.wait(Until.gone(projectChat), 10_000))
            device.awaitState("The collapsed expansion should be recorded") {
                !expansion.state.value.hasLocalChoices &&
                    expansion.state.value.expandedIds?.isEmpty() == true
            }
            // A directory at the DataStore destination rejects the atomic preference write.
            if (preferenceFile.exists()) check(preferenceFile.delete())
            check(preferenceFile.mkdir())
            device.await(filter).click()
            device.await(By.pkg(app.packageName).text(labels.getString(R.string.chat_inbox)))
            instrumentation.setInTouchMode(false)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            device.awaitKeyboardFocus(By.copy(filter))
            val focusedProject = By.copy(project).focused(true)
            val focusedProjectContainer = By.focused(true).hasChild(By.copy(project))
            for (move in 1..10) {
                if (device.hasObject(focusedProject) || device.hasObject(focusedProjectContainer))
                    break
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_TAB))
            }
            device.awaitKeyboardFocus(By.copy(project))
            val headerBeforeToggle = device.await(project).visibleBounds
            val expansionScope = checkNotNull(expansion.viewModelScope.coroutineContext[Job])
            val existingWork = expansionScope.children.toSet()
            assertTrue(device.pressDPadCenter())
            var saveJob: Job? = null
            device.awaitState("The Project toggle starts a background save") {
                saveJob = expansionScope.children.singleOrNull { it !in existingWork }
                saveJob != null
            }
            device.await(projectChat)
            val expandedHeader = device.await(project).visibleBounds
            assertEquals(headerBeforeToggle.top, expandedHeader.top)
            assertEquals(headerBeforeToggle.left, expandedHeader.left)
            device.awaitKeyboardFocus(By.copy(project))
            runBlocking { withTimeout(15_000) { checkNotNull(saveJob).join() } }
            assertTrue(expansion.state.value.hasLocalChoices)
            assertTrue(preferenceFile.isDirectory)
            device.await(projectChat)
            device.awaitKeyboardFocus(By.copy(project))
            assertEquals(expandedHeader, device.await(project).visibleBounds)
            assertEquals(filterBounds, device.await(filter).visibleBounds)
            assertFalse(device.hasObject(oldSaveNotice))
            assertFalse(device.hasObject(oldReadNotice))
            assertFalse(device.hasObject(retry))
            ScreenshotCapture.capture("project-expansion-save-failed-silent.png")
        } catch (error: Throwable) {
            failures.add(error)
        } finally {
            releaseFirstRead.countDown()
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { jobs.forEach { it.join() } } } },
                    {
                        if (preferenceFile.exists()) check(preferenceFile.delete())
                        if (originalExpansion != null) preferenceFile.writeBytes(originalExpansion)
                    },
                    { fixture.close() },
                    { savedCache.restore() },
                    { app.restoreApiPreferences(savedPreferences) },
                    { app.initialPreferences = savedInitialPreferences },
                    {
                        instrumentation.runOnMainSync { localeManager.applicationLocales = savedLocales }
                    },
                    { app.chatService = savedService },
                    { app.connectivity.value = savedOnline },
                    { auth.state.value = savedAuth },
                    { instrumentation.setInTouchMode(true) },
                )) {
                try {
                    cleanup()
                } catch (error: Throwable) {
                    failures.add(error)
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    private fun ActivityScenario<MainActivity>.owners():
        Pair<ChatListModel, ProjectExpansionModel> {
        var owners: Pair<ChatListModel, ProjectExpansionModel>? = null
        onActivity {
            val state = ViewModelProvider(it)[SessionModel::class.java].uiState.value
            val opening = state.opening as? OpeningWorkspace.Authorized
            owners =
                state.ready?.let { it.chats to it.projectExpansion }
                    ?: opening?.let { it.chats to it.projectExpansion }
        }
        return checkNotNull(owners)
    }

    private fun UiDevice.await(selector: BySelector) =
        checkNotNull(wait(Until.findObject(selector), 10_000L)) { "Missing $selector" }

    private fun UiDevice.awaitState(message: String, ready: () -> Boolean) {
        check(
            wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice) = ready()
                },
                10_000L,
            ),
        ) {
            message
        }
    }
}
