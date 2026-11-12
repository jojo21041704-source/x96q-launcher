package com.x96q.launcher

import android.annotation.SuppressLint
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Coque native minimale : une WebView plein écran qui affiche l'UI 10-foot
 * (assets/index.html) et lui expose le pont [AndroidBridge].
 *
 * La touche RETOUR n'est jamais transmise au système : le launcher ne se ferme pas.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var bridge: AndroidBridge
    private var pageReady = false

    /** Rafraîchit la liste quand une app est installée, mise à jour ou désinstallée. */
    private val packageReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            bridge.invalidateCache()
            callJs("window.Launcher && window.Launcher.reload()")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        window.addFlags(WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED)
        hideSystemUi()

        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        WebView.setWebContentsDebuggingEnabled(debuggable)

        bridge = AndroidBridge(this)
        bridge.warmUp() // pré-calcule les icônes en arrière-plan pendant le chargement de la page

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#07080C"))
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
            isFocusable = true
            isFocusableInTouchMode = true
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                defaultFocusHighlightEnabled = false
            }

            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true          // localStorage (favoris)
                allowFileAccess = true            // file:///android_asset/
                allowContentAccess = false
                mediaPlaybackRequiresUserGesture = true
                cacheMode = WebSettings.LOAD_NO_CACHE
                // L'UI est dessinée sur un canevas de 1920 px de large puis mise à l'échelle de l'écran.
                useWideViewPort = true
                loadWithOverviewMode = true
                setSupportZoom(false)
                builtInZoomControls = false
                displayZoomControls = false
                textZoom = 100
            }

            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    // Aucune navigation hors des assets locaux.
                    return !request.url.toString().startsWith("file:///android_asset/")
                }

                override fun onPageFinished(view: WebView, url: String) {
                    pageReady = true
                    view.requestFocus(View.FOCUS_DOWN)
                }
            }

            addJavascriptInterface(bridge, "AndroidBridge")
        }

        setContentView(webView)
        webView.loadUrl("file:///android_asset/index.html")

        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addAction(Intent.ACTION_PACKAGE_REMOVED)
            addAction(Intent.ACTION_PACKAGE_CHANGED)
            addAction(Intent.ACTION_PACKAGE_REPLACED)
            addDataScheme("package")
        }
        registerReceiver(packageReceiver, filter)
    }

    /**
     * Intercepte la télécommande avant la WebView :
     *  - RETOUR  → window.Launcher.onBack()   (jamais de fermeture du launcher)
     *  - MENU    → window.Launcher.onMenu()   (épingler / retirer des favoris)
     * Les flèches et OK sont transmis tels quels à la WebView (événements clavier JS).
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        when (event.keyCode) {
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE -> {
                if (event.action == KeyEvent.ACTION_UP && !event.isCanceled) {
                    callJs("window.Launcher && window.Launcher.onBack()")
                }
                return true
            }
            KeyEvent.KEYCODE_MENU -> {
                if (event.action == KeyEvent.ACTION_UP) {
                    callJs("window.Launcher && window.Launcher.onMenu()")
                }
                return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    @Deprecated("Remplacé par dispatchKeyEvent ; conservé pour ne jamais quitter le launcher.")
    override fun onBackPressed() {
        // Volontairement vide.
    }

    /** HOME pressé alors que le launcher est déjà au premier plan. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (Intent.ACTION_MAIN == intent.action) {
            callJs("window.Launcher && window.Launcher.onHome()")
        }
    }

    override fun onResume() {
        super.onResume()
        hideSystemUi()
        webView.onResume()
        webView.resumeTimers()
        callJs("window.Launcher && window.Launcher.onResume()")
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUi()
    }

    override fun onDestroy() {
        try {
            unregisterReceiver(packageReceiver)
        } catch (_: IllegalArgumentException) {
        }
        bridge.shutdown()
        webView.removeJavascriptInterface("AndroidBridge")
        webView.destroy()
        super.onDestroy()
    }

    private fun callJs(script: String) {
        if (!pageReady) return
        webView.post { webView.evaluateJavascript(script, null) }
    }

    @Suppress("DEPRECATION")
    private fun hideSystemUi() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            )
    }
}
