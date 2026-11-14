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
import ai.okou.android.instructions.PersonalInstructionsDraftStore
import android.app.Application
import androidx.core.app.LocaleManagerCompat
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStoreFile

open class OkouApplication : Application() {
    val chatCache by lazy { ChatCacheStore(this) }
    open val instructionsDrafts by lazy { PersonalInstructionsDraftStore(this) }
    open val composerJournal by lazy { ComposerJournalStore(this) }
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
        )

    override fun onCreate() {
        super.onCreate()
        authentication.initialize()
    }

    // Appearance storage is independent of authentication and constructed lazily.
    val appearancePreferences: DataStore<Preferences> by lazy {
        PreferenceDataStoreFactory.create { preferencesDataStoreFile("appearance") }
    }
}
