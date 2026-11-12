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
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout

/**
 * Coque native : WebView plein écran + interception TOTALE de la télécommande.
 *
 * Démarrage à froid :
 *  - fenêtre et WebView peintes en #050608 dès la première frame (thème + setBackgroundColor) ;
 *  - le scan des applications démarre en arrière-plan AVANT la création de la WebView ;
 *  - la page s'affiche depuis son cache localStorage sans attendre le natif.
 *
 * Résilience : page rechargée au retour si elle est vide, WebView recréée si son
 * processus de rendu meurt (manque de mémoire sur le H313).
 *
 * Touches relayées à `window.onRemoteKey(nom, repeat)` :
 *   Haut/Bas/Gauche/Droite → "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
 *   OK / Entrée            → "Enter"      (au relâchement, si pas d'appui long)
 *   OK maintenu 550 ms     → "LongEnter"  (épingler / retirer du dock)
 *   Retour                 → "Back"       (le launcher ne se ferme jamais)
 *   Menu                   → "Menu"
 */
class MainActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var bridge: AndroidBridge
    private val handler = Handler(Looper.getMainLooper())
    private var pageReady = false

    // Gestion de l'appui long sur OK
    private var okDown = false
    private var okLongFired = false
    private val okLongRunnable = Runnable {
        if (okDown) {
            okLongFired = true
            sendKey("LongEnter", false)
        }
    }

    private val packageReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            bridge.onPackagesChanged()   // rescan en arrière-plan ; le JS n'est notifié que si la liste change
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.setBackgroundDrawableResource(R.color.launcher_bg)
        window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        window.addFlags(WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED)
        hideSystemUi()

        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        WebView.setWebContentsDebuggingEnabled(debuggable)

        // Le pont exécute ses notifications dans la WebView courante (même après une recréation).
        bridge = AndroidBridge(this) { script -> runJs(script) }
        bridge.warmUp() // scan + icônes en arrière-plan, en parallèle du démarrage de Chromium

        root = FrameLayout(this).apply { setBackgroundColor(BG) }
        setContentView(root)
        createWebView()

        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addAction(Intent.ACTION_PACKAGE_REMOVED)
            addAction(Intent.ACTION_PACKAGE_CHANGED)
            addAction(Intent.ACTION_PACKAGE_REPLACED)
            addDataScheme("package")
        }
        registerReceiver(packageReceiver, filter)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView() {
        pageReady = false
        webView = WebView(this).apply {
            setBackgroundColor(BG)                              // jamais de flash blanc
            setLayerType(View.LAYER_TYPE_HARDWARE, null)        // composition GPU
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            // La WebView ne doit jamais gérer le focus elle-même.
            isFocusable = false
            isFocusableInTouchMode = false
            descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                defaultFocusHighlightEnabled = false
            }

            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = true
                allowContentAccess = false
                // Les assets locaux sont lus directement : pas de cache HTTP à consulter.
                cacheMode = WebSettings.LOAD_NO_CACHE
                // Mise à l'échelle 1920×1080 → écran faite en JS (app.js › fitStage).
                useWideViewPort = true
                loadWithOverviewMode = false
                setSupportZoom(false)
                builtInZoomControls = false
                displayZoomControls = false
                textZoom = 100
                @Suppress("DEPRECATION")
                setRenderPriority(WebSettings.RenderPriority.HIGH)
            }

            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    !request.url.toString().startsWith("file:///android_asset/")

                override fun onPageFinished(view: WebView, url: String) {
                    pageReady = true
                }

                /** Processus de rendu tué (mémoire) : on recrée la WebView au lieu de planter. */
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    if (view === webView) {
                        root.removeView(view)
                        view.destroy()
                        createWebView()
                    }
                    return true
                }
            }

            addJavascriptInterface(bridge, "AndroidBridge")   // avant loadUrl : pont prêt dès la ms 0
        }
        root.addView(webView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        webView.loadUrl(START_URL)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val name = when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
            KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
            KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
            KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
            KeyEvent.KEYCODE_DPAD_CENTER,
            KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_NUMPAD_ENTER,
            KeyEvent.KEYCODE_BUTTON_A -> "Enter"
            KeyEvent.KEYCODE_BACK,
            KeyEvent.KEYCODE_ESCAPE,
            KeyEvent.KEYCODE_BUTTON_B -> "Back"
            KeyEvent.KEYCODE_MENU -> "Menu"
            else -> null
        } ?: return super.dispatchKeyEvent(event) // volume, HOME, etc. : comportement système

        if (name == "Enter") {
            handleOk(event)
            return true
        }

        if (event.action == KeyEvent.ACTION_DOWN) {
            // Retour et Menu : une seule action par appui, pas de répétition.
            val repeat = event.repeatCount > 0
            if (repeat && (name == "Back" || name == "Menu")) return true
            sendKey(name, repeat)
        }
        return true
    }

    /** OK court → "Enter" au relâchement ; OK maintenu → "LongEnter" une seule fois. */
    private fun handleOk(event: KeyEvent) {
        when (event.action) {
            KeyEvent.ACTION_DOWN -> if (event.repeatCount == 0) {
                okDown = true
                okLongFired = false
                handler.removeCallbacks(okLongRunnable)
                handler.postDelayed(okLongRunnable, LONG_PRESS_MS)
            }
            KeyEvent.ACTION_UP -> {
                handler.removeCallbacks(okLongRunnable)
                if (okDown && !okLongFired && !event.isCanceled) sendKey("Enter", false)
                okDown = false
                okLongFired = false
            }
        }
    }

    private fun sendKey(name: String, repeat: Boolean) {
        if (!pageReady) return
        runJs("window.onRemoteKey && window.onRemoteKey('$name', $repeat)")
    }

    @Deprecated("Géré par dispatchKeyEvent ; le launcher ne se ferme jamais.")
    override fun onBackPressed() { /* volontairement vide */ }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (Intent.ACTION_MAIN == intent.action && pageReady) runJs("window.Launcher && window.Launcher.onHome()")
    }

    override fun onResume() {
        super.onResume()
        hideSystemUi()
        // Réveil / boot lent : si la page n'a jamais été chargée (ou a été vidée), on la recharge.
        if (webView.url == null) {
            webView.loadUrl(START_URL)
        } else {
            webView.onResume()
            webView.resumeTimers()
            if (pageReady) runJs("window.Launcher && window.Launcher.onResume()")
        }
    }

    override fun onPause() {
        handler.removeCallbacks(okLongRunnable)
        okDown = false
        webView.onPause()
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUi()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        try { unregisterReceiver(packageReceiver) } catch (_: IllegalArgumentException) { }
        bridge.shutdown()
        webView.removeJavascriptInterface("AndroidBridge")
        webView.destroy()
        super.onDestroy()
    }

    /** Exécute un script dans la WebView courante, toujours depuis le thread UI. */
    private fun runJs(script: String) {
        handler.post {
            if (!isDestroyed) webView.evaluateJavascript(script, null)
        }
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

    companion object {
        private const val LONG_PRESS_MS = 550L
        private const val START_URL = "file:///android_asset/index.html"
        private val BG = Color.parseColor("#050608")
    }
}
