package ai.okou.android

import android.app.Application
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStoreFile

class OkouApplication : Application() {
    // One process owner; constructing the application does not read preferences or start IO.
    val appearancePreferences: DataStore<Preferences> by lazy {
        PreferenceDataStoreFactory.create { preferencesDataStoreFile("appearance") }
    }
}
