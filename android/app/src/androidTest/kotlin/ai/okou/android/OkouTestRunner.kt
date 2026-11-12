package ai.okou.android

import android.app.Application
import android.content.Context
import androidx.test.runner.AndroidJUnitRunner

class OkouTestRunner : AndroidJUnitRunner() {
    override fun newApplication(cl: ClassLoader, className: String, context: Context): Application =
        super.newApplication(cl, TestOkouApplication::class.java.name, context)
}
