package ai.okou.android

import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.auth.Authentication
import ai.okou.android.auth.CanonicalWorkspaceSession
import ai.okou.android.auth.ClerkAuthentication
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceSession
import android.app.Application
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStoreFile

open class OkouApplication : Application() {
    val authentication by lazy { createAuthentication() }

    open fun createAuthentication(): Authentication = ClerkAuthentication(this)

    open fun createWorkspaceSession(
        identity: WorkspaceIdentity,
        tokens: WorkspaceTokenProvider,
    ): WorkspaceSession = CanonicalWorkspaceSession(identity, tokens)

    override fun onCreate() {
        super.onCreate()
        authentication.initialize()
    }

    // Appearance storage is independent of authentication and constructed lazily.
    val appearancePreferences: DataStore<Preferences> by lazy {
        PreferenceDataStoreFactory.create { preferencesDataStoreFile("appearance") }
    }
}
