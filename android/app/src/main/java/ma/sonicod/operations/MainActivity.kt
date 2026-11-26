package ma.sonicod.operations

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.webkit.WebViewAssetLoader
import androidx.work.WorkManager
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private val io = Executors.newCachedThreadPool()

    private var cameraCallback: String? = null
    private var cameraFile: File? = null
    private var pickCallback: String? = null

    /** Contenu partagé depuis WhatsApp (photos, PDF, texte), en attente d'être lu par la page. */
    @Volatile private var pendingShare: String? = null

    /** Photo prise alors que l'application a été relancée par Android (mémoire) : récupérée au rechargement. */
    @Volatile private var orphanPhotos = JSONArray()

    private val takePicture = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val f = cameraFile
        val cb = cameraCallback
        if (cb == null) {
            if (ok && f != null && f.exists()) io.execute {
                PhotoStore.importFile(this, f)?.let { id ->
                    synchronized(this) { orphanPhotos.put(JSONObject().put("id", id).put("thumb", PhotoStore.thumbDataUrl(this, id))) }
                }
                f.delete()
                runOnUiThread { webView.evaluateJavascript("window.sonicodOrphans && window.sonicodOrphans()", null) }
            }
            cameraFile = null
            return@registerForActivityResult
        }
        cameraCallback = null
        cameraFile = null
        if (!ok || f == null) {
            reply(cb, JSONObject().put("ok", true).put("photos", JSONArray()))
            return@registerForActivityResult
        }
        io.execute {
            val photos = JSONArray()
            PhotoStore.importFile(this, f)?.let { id ->
                photos.put(JSONObject().put("id", id).put("thumb", PhotoStore.thumbDataUrl(this, id)))
            }
            f.delete()
            reply(cb, JSONObject().put("ok", true).put("photos", photos))
        }
    }

    /** Scanner intégré (ScanActivity) ; si la caméra échoue → scanner Google en secours. */
    private var scanCallback: String? = null
    private val scanLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        val cb = scanCallback ?: return@registerForActivityResult
        scanCallback = null
        val v = res.data?.getStringExtra("value")
        when {
            res.resultCode == RESULT_OK && !v.isNullOrBlank() -> reply(cb, JSONObject().put("ok", true).put("value", v))
            res.resultCode == RESULT_FIRST_USER -> gmsScan(cb, res.data?.getStringExtra("error"))
            else -> reply(cb, JSONObject().put("ok", false).put("cancelled", true))
        }
    }

    private fun gmsScan(cb: String, firstError: String?) {
        try {
            val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_ALL_FORMATS).enableAutoZoom().build()
            GmsBarcodeScanning.getClient(this, options).startScan()
                .addOnSuccessListener { b -> reply(cb, JSONObject().put("ok", true).put("value", b.rawValue ?: "")) }
                .addOnCanceledListener { reply(cb, JSONObject().put("ok", false).put("cancelled", true)) }
                .addOnFailureListener { reply(cb, JSONObject().put("ok", false).put("error", firstError ?: "Scanner indisponible – utilisez la saisie manuelle")) }
        } catch (e: Exception) {
            reply(cb, JSONObject().put("ok", false).put("error", firstError ?: "Scanner indisponible."))
        }
    }

    /** La caméra doit être autorisée (l'app déclare CAMERA pour le scanner intégré) avant d'ouvrir l'appareil photo. */
    private var afterCameraPerm: ((Boolean) -> Unit)? = null
    private val cameraPerm = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        val f = afterCameraPerm; afterCameraPerm = null; f?.invoke(ok)
    }
    private fun withCamera(f: (Boolean) -> Unit) {
        if (androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) f(true)
        else { afterCameraPerm = f; cameraPerm.launch(android.Manifest.permission.CAMERA) }
    }

    /** Android 8–10 : autorisation de lire le dossier WhatsApp (bot téléphone). */
    /** Choix du dossier WhatsApp Business (une seule fois ; Android le partage avec l'app, sans « accès à tous les fichiers »). */
    private val pickTree = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) {
            try { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (e: Exception) {}
            WaBot.setTree(this, uri)
            io.execute { val ok = WaBot.hasFilesAccess(this); runOnUiThread { Toast.makeText(this, if (ok) "Dossier WhatsApp enregistré ✓" else "Choisissez le dossier com.whatsapp.w4b", Toast.LENGTH_LONG).show() } }
        }
        webView.evaluateJavascript("window.sonicodBotRefresh && window.sonicodBotRefresh()", null)
    }

    private val storagePerm = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        webView.evaluateJavascript("window.sonicodBotRefresh && window.sonicodBotRefresh()", null)
    }

    private val pickImages = registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(10)) { uris ->
        val cb = pickCallback ?: return@registerForActivityResult
        pickCallback = null
        io.execute {
            val photos = JSONArray()
            uris.forEach { uri ->
                try {
                    PhotoStore.importUri(this, uri)?.let { id ->
                        photos.put(JSONObject().put("id", id).put("thumb", PhotoStore.thumbDataUrl(this, id)))
                    }
                } catch (e: Exception) {
                    // image illisible : ignorée
                }
            }
            reply(cb, JSONObject().put("ok", true).put("photos", photos))
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        cameraFile?.let { outState.putString("cameraFile", it.path) }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        savedInstanceState?.getString("cameraFile")?.let { cameraFile = File(it) }
        webView = WebView(this)
        setContentView(webView)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = true
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == "appassets.androidplatform.net") return false
                openExternal(url)
                return true
            }
        }
        webView.addJavascriptInterface(Bridge(), "SonicodNative")
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript("window.sonicodBack ? String(window.sonicodBack()) : 'false'") { r ->
                    if (r?.contains("true") != true) finish()
                }
            }
        })

        // Toujours recharger la page : l'état est gardé dans le téléphone (localStorage),
        // et une restauration ratée donnerait un écran blanc.
        webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")

        handleShare(intent)
        io.execute { PhotoStore.cleanup(this, OpQueue.photoIdsInQueue(this)); DocStore.cleanup(this) }
        if (OpQueue.list(this).isNotEmpty()) SyncWorker.schedule(this)
        // Bot téléphone : seulement dans l'app « SONICOD Bot » (l'app des agents n'a pas d'accès aux notifications)
        if (BuildConfig.BOT && WaBot.isEnabled(this)) BotWorker.schedulePeriodic(this)
        else WorkManager.getInstance(this).cancelUniqueWork("wabot-periodic")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleShare(intent)
    }

    /** « Partager → SONICOD » depuis WhatsApp : on importe les photos et on garde le texte. */
    private fun handleShare(intent: Intent?) {
        if (intent == null) return
        val action = intent.action
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
        val uris = ArrayList<Uri>()
        if (action == Intent.ACTION_SEND_MULTIPLE) {
            IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { uris.addAll(it) }
        } else {
            IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { uris.add(it) }
        }
        val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: ""
        intent.action = null   // ne pas retraiter le même partage
        io.execute {
            val photos = JSONArray()
            val files = JSONArray()
            uris.take(10).forEach { uri ->
                try {
                    val type = contentResolver.getType(uri) ?: ""
                    if (type.startsWith("image/")) {
                        PhotoStore.importUri(this, uri)?.let { id ->
                            photos.put(JSONObject().put("id", id).put("thumb", PhotoStore.thumbDataUrl(this, id)))
                        }
                    } else {
                        val name = displayName(uri) ?: "bon.pdf"
                        DocStore.importUri(this, uri)?.let { id ->
                            files.put(JSONObject().put("id", id).put("name", name).put("mime", type.ifEmpty { "application/pdf" }))
                        }
                    }
                } catch (e: Exception) {
                }
            }
            pendingShare = JSONObject().put("photos", photos).put("files", files).put("text", text).toString()
            runOnUiThread {
                if (::webView.isInitialized) webView.evaluateJavascript("window.sonicodShareReady && window.sonicodShareReady()", null)
            }
        }
    }

    private fun openAppInfo() {
        try { startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) } catch (e: Exception) {}
    }

    private fun displayName(uri: Uri): String? = try {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (e: Exception) {
        null
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) webView.evaluateJavascript("window.sonicodResume && window.sonicodResume()", null)
    }

    /** Renvoie un résultat à la page (window.__nativeCb). */
    private fun reply(cb: String, data: JSONObject) {
        val js = "window.__nativeCb && window.__nativeCb(" + JSONObject.quote(cb) + "," + JSONObject.quote(data.toString()) + ")"
        runOnUiThread { webView.evaluateJavascript(js, null) }
    }

    private fun isInstalled(pkg: String): Boolean = try {
        packageManager.getPackageInfo(pkg, 0)
        true
    } catch (e: PackageManager.NameNotFoundException) {
        false
    }

    private fun whatsappPackage(): String? = listOf("com.whatsapp", "com.whatsapp.w4b").firstOrNull { isInstalled(it) }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (e: Exception) {
            Toast.makeText(this, "Impossible d'ouvrir le lien", Toast.LENGTH_SHORT).show()
        }
    }

    private fun copyToClipboard(text: String) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("SONICOD", text))
    }

    /** Fonctions appelées par l'interface (JavaScript). */
    inner class Bridge {

        @JavascriptInterface
        fun getInfo(): String = JSONObject()
            .put("serverUrl", Session.serverUrl(this@MainActivity))
            .put("name", Session.name(this@MainActivity))
            .put("version", BuildConfig.VERSION_NAME)
            .put("whatsapp", whatsappPackage() != null)
            .put("bot", BuildConfig.BOT)
            .put("systemDark", (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES)
            .toString()

        @JavascriptInterface
        fun setServerUrl(url: String) {
            Session.setServerUrl(this@MainActivity, url)
            if (OpQueue.list(this@MainActivity).isNotEmpty()) SyncWorker.schedule(this@MainActivity)
        }

        @JavascriptInterface
        fun setName(name: String) = Session.setName(this@MainActivity, name)

        /** Couleur des barres système selon le thème (clair / sombre). */
        /** Couleurs des barres Android (haut / bas) selon le style choisi. */
        @JavascriptInterface
        fun setBars(status: String, nav: String) {
            runOnUiThread {
                try {
                    window.statusBarColor = android.graphics.Color.parseColor(status)
                    window.navigationBarColor = android.graphics.Color.parseColor(nav)
                } catch (e: Exception) {}
            }
        }

        @JavascriptInterface
        fun setDark(dark: Boolean) {
            runOnUiThread {
                window.navigationBarColor = if (dark) 0xFF141019.toInt() else 0xFFFFFFFF.toInt()
                window.statusBarColor = if (dark) 0xFF1E1129.toInt() else 0xFF4A1D66.toInt()
            }
        }

        /** Ouvre le scanner de code-barres (Google). Réponse : {ok, value} ou {ok:false, cancelled}. */
        @JavascriptInterface
        fun scanBarcode(cb: String) {
            runOnUiThread {
                try {
                    scanCallback = cb
                    scanLauncher.launch(Intent(this@MainActivity, ScanActivity::class.java))
                } catch (e: Exception) {
                    scanCallback = null
                    gmsScan(cb, null)
                }
            }
        }

        /** Bip + vibration : court si OK, long si erreur / doublon. */
        @JavascriptInterface
        fun feedback(ok: Boolean) {
            try {
                ToneGenerator(AudioManager.STREAM_NOTIFICATION, 90).apply {
                    startTone(if (ok) ToneGenerator.TONE_PROP_BEEP else ToneGenerator.TONE_SUP_ERROR, if (ok) 150 else 450)
                    android.os.Handler(mainLooper).postDelayed({ release() }, 700)
                }
            } catch (e: Exception) {
            }
            try {
                val vib: Vibrator = if (Build.VERSION.SDK_INT >= 31) {
                    (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
                } else {
                    getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                }
                vib.vibrate(VibrationEffect.createOneShot(if (ok) 60L else 400L, VibrationEffect.DEFAULT_AMPLITUDE))
            } catch (e: Exception) {
            }
        }

        /** Appel générique au serveur. La réponse arrive via window.__nativeCb(cb, json). */
        @JavascriptInterface
        fun api(cb: String, body: String) {
            io.execute {
                val res = try {
                    val req = JSONObject(body).put("key", APP_KEY)
                    Api.post(Session.serverUrl(this@MainActivity), req.toString())
                } catch (e: IOException) {
                    JSONObject().put("ok", false).put("network", true).put("error", "Pas de connexion internet.")
                } catch (e: ServerException) {
                    JSONObject().put("ok", false).put("code", e.code).put("error", e.message)
                } catch (e: Exception) {
                    JSONObject().put("ok", false).put("error", e.message ?: "Erreur")
                }
                reply(cb, res)
            }
        }

        @JavascriptInterface
        fun takePhoto(cb: String) {
            runOnUiThread { withCamera { granted ->
                if (!granted) { reply(cb, JSONObject().put("ok", false).put("error", "Autorisez la caméra.")); return@withCamera }
                try {
                    val dir = File(cacheDir, "camera").apply { mkdirs() }
                    val f = File(dir, UUID.randomUUID().toString() + ".jpg")
                    val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.files", f)
                    cameraCallback = cb
                    cameraFile = f
                    takePicture.launch(uri)
                } catch (e: Exception) {
                    cameraCallback = null
                    reply(cb, JSONObject().put("ok", false).put("error", "Caméra indisponible."))
                }
            } }
        }

        @JavascriptInterface
        fun pickPhotos(cb: String) {
            runOnUiThread {
                try {
                    pickCallback = cb
                    pickImages.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                } catch (e: Exception) {
                    pickCallback = null
                    reply(cb, JSONObject().put("ok", false).put("error", "Galerie indisponible."))
                }
            }
        }

        /** Renvoie (une seule fois) le contenu partagé depuis WhatsApp, ou "". */
        /* ---------- Bot WhatsApp du téléphone ---------- */
        @JavascriptInterface
        fun botStatus(): String = if (BuildConfig.BOT) WaBot.status(this@MainActivity).toString() else ""

        @JavascriptInterface
        fun botSetEnabled(on: Boolean) = WaBot.setEnabled(this@MainActivity, on)

        @JavascriptInterface
        fun botSetGroups(json: String) { try { WaBot.setGroups(this@MainActivity, JSONObject(json)) } catch (e: Exception) {} }

        @JavascriptInterface
        fun botOpenNotif() = runOnUiThread {
            try { startActivity(Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) } catch (e: Exception) { openAppInfo() }
        }

        @JavascriptInterface
        fun botOpenFiles() = runOnUiThread {
            // s'ouvre directement sur Android/media/com.whatsapp.w4b : il suffit d'appuyer sur « Utiliser ce dossier »
            val start = android.provider.DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:Android/media/com.whatsapp.w4b")
            try { pickTree.launch(start) } catch (e: Exception) { try { pickTree.launch(null) } catch (e2: Exception) {} }
        }

        @JavascriptInterface
        fun botTestMode(on: Boolean) = WaBot.setTestMode(this@MainActivity, on)

        @JavascriptInterface
        fun botOpenAppInfo() = runOnUiThread { openAppInfo() }

        @JavascriptInterface
        fun botRun(cb: String) {
            io.execute {
                val r = try { WaBot.run(this@MainActivity) } catch (e: Exception) { JSONObject().put("ok", false).put("error", e.message ?: "Erreur") }
                reply(cb, r)
            }
        }

        /** Lit le nombre de colis sur les étiquettes des photos partagées. */
        @JavascriptInterface
        fun ocrPhotos(cb: String, idsJson: String) {
            io.execute {
                val ids = try { JSONArray(idsJson) } catch (e: Exception) { JSONArray() }
                val reads = ArrayList<WaBot.Label?>()
                for (i in 0 until ids.length()) {
                    val f = PhotoStore.file(this@MainActivity, ids.optString(i)) ?: continue
                    reads.add(WaBot.readLabel(this@MainActivity, f))
                }
                val cnt = WaBot.countColis(reads, ids.length())
                val colis: Any = cnt.colis ?: JSONObject.NULL
                val source = cnt.source
                val brvs = cnt.brvs
                reply(cb, JSONObject().put("ok", true).put("colis", colis).put("source", source)
                    .put("brvs", JSONArray(brvs.keys.filter { it.startsWith("BRV") })))
            }
        }

        @JavascriptInterface
        fun takeOrphans(): String = synchronized(this@MainActivity) {
            val v = orphanPhotos.toString()
            orphanPhotos = JSONArray()
            v
        }

        @JavascriptInterface
        fun takeShared(): String {
            val v = pendingShare ?: return ""
            pendingShare = null
            return v
        }

        /** Envoie une action au serveur en y joignant des photos (base64). */
        @JavascriptInterface
        fun apiWithPhotos(cb: String, body: String, photoIdsJson: String, docsJson: String) {
            io.execute {
                val ctx = this@MainActivity
                val res = try {
                    val req = JSONObject(body).put("key", APP_KEY).put("who", Session.name(ctx))
                    val ids = JSONArray(photoIdsJson)
                    val photos = JSONArray()
                    for (i in 0 until ids.length()) {
                        PhotoStore.base64(ctx, ids.getString(i))?.let { photos.put(JSONObject().put("b64", it)) }
                    }
                    req.put("photos", photos)
                    val docs = JSONArray(docsJson.ifEmpty { "[]" })
                    val files = JSONArray()
                    for (i in 0 until docs.length()) {
                        val d = docs.getJSONObject(i)
                        DocStore.base64(ctx, d.optString("id"))?.let {
                            files.put(JSONObject().put("b64", it).put("name", d.optString("name")).put("mime", d.optString("mime", "application/pdf")))
                        }
                    }
                    req.put("files", files)
                    Api.post(Session.serverUrl(ctx), req.toString())
                } catch (e: IOException) {
                    JSONObject().put("ok", false).put("network", true).put("error", "Pas de connexion internet.")
                } catch (e: ServerException) {
                    JSONObject().put("ok", false).put("code", e.code).put("error", e.message)
                } catch (e: Exception) {
                    JSONObject().put("ok", false).put("error", e.message ?: "Erreur")
                }
                reply(cb, res)
            }
        }

        @JavascriptInterface
        fun photoThumb(id: String): String = PhotoStore.thumbDataUrl(this@MainActivity, id)

        @JavascriptInterface
        fun deletePhoto(id: String) = PhotoStore.delete(this@MainActivity, id)

        /**
         * Enregistre l'opération dans le Google Sheet (+ photos).
         * Sans réseau : l'opération est mise en file d'attente et envoyée automatiquement plus tard.
         */
        @JavascriptInterface
        fun submit(cb: String, opJson: String, photoIdsJson: String) {
            io.execute {
                val ctx = this@MainActivity
                val res = try {
                    val op = JSONObject(opJson)
                    val ids = JSONArray(photoIdsJson)
                    try {
                        val data = Submitter.send(ctx, op, ids)
                        JSONObject().put("ok", true).put("data", data)
                    } catch (e: IOException) {
                        OpQueue.add(ctx, op, ids, "Pas de connexion")
                        SyncWorker.schedule(ctx)
                        JSONObject().put("ok", true).put("queued", true)
                    }
                } catch (e: ServerException) {
                    JSONObject().put("ok", false).put("code", e.code).put("error", e.message)
                } catch (e: Exception) {
                    JSONObject().put("ok", false).put("error", e.message ?: "Erreur")
                }
                reply(cb, res)
            }
        }

        @JavascriptInterface
        fun queue(): String {
            val arr = JSONArray()
            OpQueue.list(this@MainActivity).forEach { item ->
                val op = item.getJSONObject("op")
                arr.put(
                    JSONObject()
                        .put("opId", op.optString("opId"))
                        .put("livreur", op.optString("livreur"))
                        .put("colis", op.optInt("colis"))
                        .put("dateReception", op.optString("dateReception"))
                        .put("photos", item.optJSONArray("photoIds")?.length() ?: 0)
                        .put("attempts", item.optInt("attempts"))
                        .put("lastError", item.optString("lastError"))
                        .put("createdAt", item.optLong("createdAt"))
                )
            }
            return arr.toString()
        }

        @JavascriptInterface
        fun syncNow(cb: String) {
            io.execute {
                val ctx = this@MainActivity
                val done = Submitter.flushQueue(ctx)
                if (!done) SyncWorker.schedule(ctx)
                reply(cb, JSONObject().put("ok", true).put("network", done).put("pending", OpQueue.list(ctx).size))
            }
        }

        @JavascriptInterface
        fun removeQueued(opId: String) {
            OpQueue.remove(this@MainActivity, opId)
        }

        /**
         * Ouvre WhatsApp avec le message et les photos (l'utilisateur choisit le groupe et appuie sur Envoyer).
         * Renvoie "whatsapp", "chooser" ou "error". Ne confirme JAMAIS l'envoi.
         */
        @JavascriptInterface
        fun shareWhatsApp(text: String, photoIdsJson: String, line1: String, line2: String): String {
            val ctx = this@MainActivity
            return try {
                if (text.isNotEmpty()) copyToClipboard(text)
                val ids = JSONArray(photoIdsJson)
                val n = ids.length()
                val uris = ArrayList<Uri>()
                for (i in 0 until n) {
                    val id = ids.getString(i)
                    // Photo avec bandeau (ville, colis, statut, date, photo i/n) ; sinon l'originale
                    val f = (try {
                        PhotoStore.stamped(ctx, id, line1, line2 + " · photo " + (i + 1) + "/" + n)
                    } catch (e: Throwable) {
                        null
                    }) ?: PhotoStore.file(ctx, id) ?: continue
                    uris.add(FileProvider.getUriForFile(ctx, "$packageName.files", f))
                }
                val intent = when {
                    uris.size > 1 -> Intent(Intent.ACTION_SEND_MULTIPLE).apply {
                        type = "image/jpeg"
                        putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                    }
                    uris.size == 1 -> Intent(Intent.ACTION_SEND).apply {
                        type = "image/jpeg"
                        putExtra(Intent.EXTRA_STREAM, uris[0])
                    }
                    else -> Intent(Intent.ACTION_SEND).apply { type = "text/plain" }
                }
                if (text.isNotEmpty()) intent.putExtra(Intent.EXTRA_TEXT, text)
                if (uris.isNotEmpty()) {
                    val clip = ClipData.newRawUri("photos", uris[0])
                    for (k in 1 until uris.size) clip.addItem(ClipData.Item(uris[k]))
                    intent.clipData = clip
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                val pkg = whatsappPackage()
                runOnUiThread {
                    try {
                        if (pkg != null) {
                            intent.setPackage(pkg)
                            startActivity(intent)
                        } else {
                            startActivity(Intent.createChooser(intent, "Partager"))
                        }
                    } catch (e: Exception) {
                        startActivity(Intent.createChooser(intent.setPackage(null), "Partager"))
                    }
                }
                if (pkg != null) "whatsapp" else "chooser"
            } catch (e: Exception) {
                "error"
            }
        }

        /** Ouvre exactement le lien d'invitation du groupe WhatsApp SONICOD. */
        @JavascriptInterface
        fun openWhatsAppGroup() {
            runOnUiThread {
                val uri = Uri.parse(WHATSAPP_GROUP_LINK)
                val pkg = whatsappPackage()
                try {
                    val i = Intent(Intent.ACTION_VIEW, uri)
                    if (pkg != null) i.setPackage(pkg)
                    startActivity(i)
                } catch (e: Exception) {
                    openExternal(uri)
                }
            }
        }

        /** Ouvre un autre groupe WhatsApp (ex. « Retour Sorties »), lien exact chat.whatsapp.com. */
        @JavascriptInterface
        fun openWhatsAppLink(url: String) {
            if (!url.startsWith("https://chat.whatsapp.com/")) return
            runOnUiThread {
                val uri = Uri.parse(url)
                val pkg = whatsappPackage()
                try {
                    val i = Intent(Intent.ACTION_VIEW, uri)
                    if (pkg != null) i.setPackage(pkg)
                    startActivity(i)
                } catch (e: Exception) {
                    openExternal(uri)
                }
            }
        }

        @JavascriptInterface
        fun openUrl(url: String) {
            if (url.startsWith("https://")) runOnUiThread { openExternal(Uri.parse(url)) }
        }

        @JavascriptInterface
        fun copyText(text: String) {
            runOnUiThread { copyToClipboard(text) }
        }

        @JavascriptInterface
        fun toast(msg: String) {
            runOnUiThread { Toast.makeText(this@MainActivity, msg, Toast.LENGTH_SHORT).show() }
        }
    }
}
