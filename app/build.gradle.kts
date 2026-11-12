plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.x96q.launcher"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.x96q.launcher"
        minSdk = 21
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // Les polices woff2 sont déjà compressées : inutile de les recompresser dans l'APK.
    androidResources {
        noCompress += listOf("woff2")
    }
}

// Aucune dépendance AndroidX : coque native minimale, APK léger (~1 Mo).
dependencies { }
