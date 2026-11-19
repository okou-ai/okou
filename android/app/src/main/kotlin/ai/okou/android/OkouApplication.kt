package ai.okou.android

import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.auth.Authentication
import ai.okou.android.auth.CanonicalWorkspaceSession
import ai.okou.android.auth.ClerkAuthentication
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.auth.initialLocale
import ai.okou.android.chat.ChatCacheStore
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.RunControlJournalStore
import ai.okou.android.instructions.PersonalInstructionsDraftStore
import ai.okou.android.updates.AndroidUpdateClient
import ai.okou.android.updates.AppUpdates
import ai.okou.android.updates.FileUpdateStore
import android.app.Application
import android.os.Build
import androidx.core.app.LocaleManagerCompat
import java.io.File
import okhttp3.HttpUrl.Companion.toHttpUrl

open class OkouApplication : Application() {
    open val updates by lazy {
        val directory = File(filesDir, "updates")
        AppUpdates(
            AndroidUpdateClient(
                this,
                BuildConfig.API_ORIGIN.toHttpUrl(),
                BuildConfig.VERSION_NAME,
                directory,
            ),
            FileUpdateStore(directory),
            BuildConfig.VERSION_NAME,
            Build.VERSION.SDK_INT,
        )
    }
    val chatCache by lazy { ChatCacheStore(this) }
    open val instructionsDrafts by lazy { PersonalInstructionsDraftStore(this) }
    open val composerJournal by lazy { ComposerJournalStore(this) }
    open val runControlJournal by lazy { RunControlJournalStore(this) }
    val authentication by lazy { createAuthentication() }

    open fun createAuthentication(): Authentication = ClerkAuthentication(this)

    open fun createWorkspaceSession(
        identity: WorkspaceIdentity,
        tokens: WorkspaceTokenProvider,
    ): WorkspaceSession =
        CanonicalWorkspaceSession(
            identity,
            tokens,
            // Locale.getDefault() may be the previous member's app language, not the device
            // language.
            locale = initialLocale(checkNotNull(LocaleManagerCompat.getSystemLocales(this)[0])),
            onUpdateRequired = updates::requireUpdate,
        )

    override fun onCreate() {
        super.onCreate()
        authentication.initialize()
    }
}
