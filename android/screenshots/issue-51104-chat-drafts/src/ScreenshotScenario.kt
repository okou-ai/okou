package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ComposerApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.SessionModel
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.workspaceStorageKey
import ai.okou.android.chat.ComposerJournal
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.ComposerPersistence
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.chat.plainText
import ai.okou.android.chatListRegion
import ai.okou.android.testAuthenticationState
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun restoresAndEditsADraftWithoutMovingTheComposer() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousChats = app.chatService
        val previousComposer = app.composerService
        val previousJournal = app.journalStore
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val device = UiDevice.getInstance(instrumentation)
        val root = Files.createTempDirectory(app.cacheDir.toPath(), "draft-proof-").toFile()
        val directory = root.resolve("journal")
        val backup = root.resolve("journal-backup")
        val journal = ComposerJournalStore(app, directory)
        val identity = WorkspaceIdentity(BuildConfig.API_ORIGIN, "user-a", "session-a", "org-a")
        val draft = "Review launch notes"
        val edited = "Review launch copy"
        val editor = By.pkg(app.packageName).clazz("android.widget.EditText").enabled(true)
        val send = By.pkg(app.packageName).desc(app.getString(R.string.composer_send)).enabled(true)

        fun await(reason: String, predicate: () -> Boolean) {
            check(device.wait(object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice) = predicate()
            }, 15_000)) { reason }
        }

        ComposerApiFixture().use { fixture ->
            try {
                runBlocking {
                    journal.persist(identity, ComposerJournal(format = 3, retainedDrafts = mapOf("new:" to draft))).await()
                }
                app.chatService = fixture.service
                app.composerService = fixture.service
                app.journalStore = journal
                auth.state.value = testAuthenticationState()
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    checkNotNull(device.wait(Until.findObject(chatListRegion(app)), 15_000))
                    val newChat = By.pkg(app.packageName).text(app.getString(R.string.composer_new))
                    checkNotNull(device.wait(Until.findObject(newChat), 10_000)).click()
                    lateinit var composer: ai.okou.android.chat.ChatComposerModel
                    scenario.onActivity {
                        val ready = checkNotNull(ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready)
                        check(ready.identity.workspaceStorageKey() == identity.workspaceStorageKey())
                        composer = ready.composer
                    }
                    val path = "/api/chat-drafts/composer"
                    await("Legacy input was not adopted and saved") {
                        device.findObject(editor)?.text == draft &&
                            device.hasObject(send) &&
                            fixture.drafts[path]?.plainText() == draft &&
                            composer.uiState.value.persistence == ComposerPersistence.Durable
                    }
                    check(!device.hasObject(By.text(app.getString(R.string.composer_restore_draft))))
                    val initialBounds = checkNotNull(device.findObject(editor)).visibleBounds
                    ScreenshotCapture.capture("draft-restored.png")

                    check(directory.renameTo(backup))
                    directory.writeText("The fixture prevents this directory from accepting writes.")
                    checkNotNull(device.findObject(editor)).text = edited
                    await("Edited draft or Send did not survive the failed local write") {
                        composer.uiState.value.persistence == ComposerPersistence.Failed &&
                            device.findObject(editor)?.text == edited &&
                            device.hasObject(send)
                    }
                    check(composer.uiState.value.canSend(ComposerTarget()))
                    check(!device.hasObject(By.text(app.getString(R.string.composer_local_failed))))
                    check(checkNotNull(device.findObject(editor)).visibleBounds == initialBounds)
                    check(fixture.drafts[path]?.plainText() == draft)
                    check(fixture.inputs.isEmpty())
                    ScreenshotCapture.capture("draft-local-write-failed.png")
                }
            } finally {
                if (backup.isDirectory) {
                    check(directory.delete())
                    check(backup.renameTo(directory))
                }
                runBlocking { withTimeout(10_000) { journal.close() } }
                auth.state.value = previousAuth
                app.chatService = previousChats
                app.composerService = previousComposer
                app.journalStore = previousJournal
                app.restoreApiPreferences(preferences)
                cache.restore()
                check(root.deleteRecursively())
            }
        }
    }
}
