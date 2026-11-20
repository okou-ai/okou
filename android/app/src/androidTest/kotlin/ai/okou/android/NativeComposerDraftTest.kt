package ai.okou.android

import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.plainDraftDocument
import ai.okou.android.chat.plainText
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiSelector
import androidx.test.uiautomator.Until
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class NativeComposerDraftTest {
    @Test
    fun heldWebDraftKeepsNativeEditingAndForegroundRefreshSaveClearAndRecreation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldChats = app.chatService
        val oldComposer = app.composerService
        val oldJournal = app.journalStore
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val directory =
            Files.createTempDirectory(app.cacheDir.toPath(), "composer-drafts-").toFile()
        val journal = ComposerJournalStore(app, directory)
        val fixture = ComposerApiFixture()
        val held = CountDownLatch(1)
        val path = "/api/agents/$CHAT_AGENT/draft"
        fixture.drafts[path] = plainDraftDocument("Saved on Web")
        fixture.beforeDraftRead = { held.await() }
        app.chatService = fixture.service
        app.composerService = fixture.service
        app.journalStore = journal
        auth.state.value = testAuthenticationState()
        val device = UiDevice.getInstance(instrumentation)
        var scenario: ActivityScenario<MainActivity>? = null
        var composerJob: Job? = null
        var listJob: Job? = null
        val failures = mutableListOf<Throwable>()
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            fun await(condition: () -> Boolean) =
                assertTrue(
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice) = condition()
                        },
                        10_000,
                    )
                )
            fun editor() =
                checkNotNull(
                    device.wait(
                        Until.findObject(
                            By.pkg(app.packageName).clazz("android.widget.EditText").enabled(true)
                        ),
                        10_000,
                    )
                )
            checkNotNull(device.wait(Until.findObject(chatListRegion(app)), 10_000))
            device
                .findObject(
                    UiSelector()
                        .packageName(app.packageName)
                        .text(app.getString(R.string.composer_new))
                )
                .click()
            checkNotNull(
                device.wait(
                    Until.findObject(
                        By.pkg(app.packageName).text(app.getString(R.string.composer_sync_loading))
                    ),
                    10_000,
                )
            )
            scenario.onActivity {
                val ready =
                    checkNotNull(
                        ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready
                    )
                composerJob = ready.composer.viewModelScope.coroutineContext[Job]
                listJob = ready.chats.viewModelScope.coroutineContext[Job]
            }
            editor().text = "Native edit while Web draft is loading"
            held.countDown()
            await { fixture.drafts[path]?.plainText() == "Native edit while Web draft is loading" }
            assertEquals("Native edit while Web draft is loading", editor().text)
            scenario.recreate()
            assertEquals("Native edit while Web draft is loading", editor().text)
            fixture.drafts[path] = plainDraftDocument("Updated on Web")
            scenario.moveToState(Lifecycle.State.CREATED)
            scenario.moveToState(Lifecycle.State.RESUMED)
            await {
                device.findObject(By.pkg(app.packageName).clazz("android.widget.EditText"))?.text ==
                    "Updated on Web"
            }
            editor().text = ""
            await { fixture.drafts[path]?.plainText() == "" }
            assertTrue(
                fixture.requests.any { it.method == "PATCH" && it.requestUrl?.encodedPath == path }
            )
        } catch (error: Throwable) {
            failures += error
            try {
                takeScreenshot().writeToTestStorage("native-composer-draft-failure.png")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            held.countDown()
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    {
                        runBlocking {
                            withTimeout(10_000) {
                                composerJob?.join()
                                listJob?.join()
                            }
                        }
                    },
                    { runBlocking { journal.close() } },
                    { fixture.close() },
                    { cache.restore() },
                    { app.restoreApiPreferences(preferences) },
                    {
                        app.chatService = oldChats
                        app.composerService = oldComposer
                        app.journalStore = oldJournal
                        auth.state.value = oldAuth
                    },
                    { check(directory.deleteRecursively()) },
                )) try {
                cleanup()
            } catch (error: Throwable) {
                failures += error
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }
}
