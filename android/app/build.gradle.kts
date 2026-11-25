plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ma.sonicod.operations"
    compileSdk = 34

    defaultConfig {
        applicationId = "ma.sonicod.operations"
        minSdk = 26
        targetSdk = 34
        versionCode = 9
        versionName = "3.7.0"
    }

    signingConfigs {
        create("sonicod") {
            // Clé fixe : les mises à jour de l'APK s'installent par-dessus l'ancienne version.
            storeFile = file("sonicod-release.jks")
            storePassword = System.getenv("SONICOD_STORE_PASSWORD") ?: "sonicod2026"
            keyAlias = "sonicod"
            keyPassword = System.getenv("SONICOD_KEY_PASSWORD") ?: "sonicod2026"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("sonicod")
        }
        debug {
            signingConfig = signingConfigs.getByName("sonicod")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("androidx.exifinterface:exifinterface:1.3.7")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
