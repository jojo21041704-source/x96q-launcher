# Conserve les méthodes exposées à la WebView (utile si la minification est activée en release).
-keepclassmembers class com.x96q.launcher.AndroidBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
