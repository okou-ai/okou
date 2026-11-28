package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ComposerApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.chat.AttachmentFailure
import ai.okou.android.chat.ChatAttachmentReference
import ai.okou.android.chat.ComposerJournal
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.DraftChatAttachment
import ai.okou.android.chat.EditableComposerDraft
import ai.okou.android.chat.restoredAttachment
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun failedAttachmentsCanBeReviewedKeptOrSkipped() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val authentication = app.authentication as TestAuthentication
        val oldAuth = authentication.state.value
        val oldChat = app.chatService
        val oldComposer = app.composerService
        val initialPreferences = app.initialPreferences
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val oldJournal = app.journalStore
        val directory = Files.createTempDirectory(app.cacheDir.toPath(), "skip-attachments-").toFile()
        val journal = ComposerJournalStore(app, directory)
        val prompt = "Send the review notes."
        val failed = listOf(
            DraftChatAttachment("42391eff-72d2-4c18-ac1a-acbb18e471c0", "release-checklist.pdf",
                "application/pdf", failure = AttachmentFailure.SourceUnavailable),
            DraftChatAttachment("52391eff-72d2-4c18-ac1a-acbb18e471c0", "launch-schedule.txt",
                "text/plain", failure = AttachmentFailure.UploadFailed),
        )
        val uploaded = ChatAttachmentReference(
            "12391eff-72d2-4c18-ac1a-acbb18e471c0", "review-notes.txt", "text/plain", 42,
            "/artifacts/b5e27f6a307e428f8144c897a5b4ef10.txt",
        ).restoredAttachment()
        fun item(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 10_000)) { selector.toString() }

        val releaseSend = CountDownLatch(1)
        ComposerApiFixture().use { fixture ->
            fixture.beforeSendReturn = { check(releaseSend.await(30, TimeUnit.SECONDS)) }
            try {
                runBlocking {
                    journal.persist(
                        fixture.identity.copy(apiOrigin = BuildConfig.API_ORIGIN),
                        ComposerJournal(
                            format = 3,
                            drafts = mapOf(
                                "thread:$CHAT_PERSONAL" to EditableComposerDraft(
                                    text = prompt, dirty = true, attachments = failed + uploaded,
                                ),
                            ),
                        ),
                    ).await()
                }
                app.chatService = fixture.service
                app.composerService = fixture.service
                app.journalStore = journal
                app.initialPreferences = testPreferences().copy(theme = UserPreferencesTheme.LIGHT)
                authentication.state.value = testAuthenticationState()
                ActivityScenario.launch(MainActivity::class.java).use {
                    item(By.text("Personal chat")).click()
                    val send = By.desc(app.getString(R.string.composer_send)).enabled(true)
                    val title = By.text(app.getString(R.string.composer_skip_attachments_title))
                    val editor = By.clazz("android.widget.EditText").text(prompt)
                    item(editor)
                    item(send).click()
                    item(title)
                    failed.forEach { item(By.text(it.filename)) }
                    val confirm = By.text(app.getString(R.string.composer_skip_attachments_send))
                    val edit = By.text(app.getString(R.string.composer_skip_attachments_edit))
                    val density = app.resources.displayMetrics.density
                    check(item(confirm).visibleBounds.height() >= (48 * density).toInt())
                    ScreenshotCapture.capture("01-confirmation.png")
                    item(edit).click()
                    check(device.wait(Until.gone(title), 10_000))
                    item(editor)
                    check(fixture.inputs.isEmpty())
                    ScreenshotCapture.capture("02-return-to-editing.png")
                    item(send).click()
                    item(confirm).click()
                    check(device.wait(Until.gone(editor), 10_000))
                    item(By.text(prompt))
                    item(By.text(uploaded.filename))
                    check(device.wait(object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice) = fixture.inputs.size == 1
                    }, 10_000))
                    val request = fixture.inputs.values.single().toString()
                    check(request.contains(uploaded.filename) && failed.none { request.contains(it.filename) })
                    ScreenshotCapture.capture("03-sending.png")
                    releaseSend.countDown()
                }
            } finally {
                releaseSend.countDown()
                authentication.state.value = oldAuth
                app.chatService = oldChat
                app.composerService = oldComposer
                app.journalStore = oldJournal
                app.initialPreferences = initialPreferences
                runBlocking { journal.close() }
                cache.restore()
                app.restoreApiPreferences(preferences)
                directory.deleteRecursively()
            }
        }
    }
}
