plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "ai.okou.android"
    compileSdk = 35
    defaultConfig {
        applicationId = "ai.okou.android"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        testInstrumentationRunnerArguments["useTestStorageService"] = "true"
    }
    buildTypes { debug { applicationIdSuffix = ".debug" } }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets["main"].res.srcDir(layout.buildDirectory.dir("generated/brand/res"))
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/brand/assets"))
    testOptions {
        unitTests.isIncludeAndroidResources = true
        animationsDisabled = true
        managedDevices {
            localDevices.create("pixel2Api35") {
                device = "Pixel 2"
                apiLevel = 35
                systemImageSource = "aosp"
                require64Bit = true
            }
        }
    }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

val generateBrandFonts by
    tasks.registering(Sync::class) {
        from("../../ios/Okou/Resources/Fonts/Geist.ttf") { rename { "geist.ttf" } }
        into(layout.buildDirectory.dir("generated/brand/res/font"))
    }

tasks.named("preBuild") { dependsOn(generateBrandFonts) }

val generateLicenseAssets by
    tasks.registering(Sync::class) {
        from("../../ios/Okou/Resources/Fonts") { include("*-LICENSE.txt") }
        from("../../ios/Okou/DesignSystem/Lucide-LICENSE.txt")
        into(layout.buildDirectory.dir("generated/brand/assets/licenses"))
    }

tasks.named("preBuild") { dependsOn(generateLicenseAssets) }

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.foundation)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.navigation.compose)
    implementation(libs.datastore.preferences)
    implementation(libs.coroutines.android)
    implementation(libs.retrofit)
    implementation(libs.retrofit.serialization)
    implementation(libs.okhttp)
    implementation(libs.serialization.json)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(libs.compose.ui.test)
    testImplementation(libs.lifecycle.runtime.testing)
    debugImplementation(libs.compose.ui.test.manifest)
    androidTestImplementation(libs.test.core.ktx)
    androidTestImplementation(libs.test.ext.junit)
    androidTestImplementation(libs.test.runner)
    androidTestImplementation(libs.test.uiautomator)
    androidTestImplementation(libs.test.storage)
    androidTestUtil(libs.test.services)
}
