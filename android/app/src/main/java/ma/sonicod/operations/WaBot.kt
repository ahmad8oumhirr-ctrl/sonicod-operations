package ma.sonicod.operations

import android.Manifest
import android.app.Notification
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.service.notification.StatusBarNotification
import android.util.Base64
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * Bot WhatsApp sur le téléphone.
 *
 * WhatsApp ne laisse aucune application lire ses groupes. On combine donc deux choses :
 *  1. les notifications de WhatsApp (elles disent QUEL groupe a envoyé une photo / un PDF et à quelle heure) ;
 *  2. le dossier WhatsApp du téléphone (où WhatsApp enregistre les photos et documents téléchargés).
 * Chaque notification « 📷 Photo » d'un groupe retour est reliée à la photo arrivée juste après dans le dossier,
 * chaque « 📄 nom.pdf » au document du même nom. Le nombre de colis est lu sur l'étiquette (lecture de texte
 * sur le téléphone, gratuite), puis tout part dans l'onglet « Retours en attente » (même ligne que le bot Chrome).
 */
object WaBot {
    private val lock = Any()
    val PKGS = setOf("com.whatsapp.w4b", "com.whatsapp")
    private const val DAY = 24L * 3600 * 1000
    private val dayFmt get() = SimpleDateFormat("yyyy-MM-dd", Locale.US)

    /* ---------------- état (files/wabot.json) ---------------- */

    private fun file(ctx: Context) = File(ctx.filesDir, "wabot.json")

    private fun load(ctx: Context): JSONObject = try {
        val f = file(ctx)
        if (f.exists()) JSONObject(f.readText()) else JSONObject()
    } catch (e: Exception) { JSONObject() }

    private fun save(ctx: Context, o: JSONObject) {
        val tmp = File(ctx.filesDir, "wabot.tmp")
        tmp.writeText(o.toString())
        tmp.renameTo(file(ctx))
    }

    private fun <T> edit(ctx: Context, f: (JSONObject) -> T): T = synchronized(lock) {
        val o = load(ctx)
        val r = f(o)
        save(ctx, o)
        r
    }

    private fun JSONObject.obj(k: String): JSONObject = optJSONObject(k) ?: JSONObject().also { put(k, it) }
    private fun JSONObject.arr(k: String): JSONArray = optJSONArray(k) ?: JSONArray().also { put(k, it) }

    fun log(ctx: Context, s: String): Unit = edit(ctx) { o ->
        val l = o.arr("log")
        val t = SimpleDateFormat("dd/MM HH:mm", Locale.US).format(Date())
        l.put("$t  $s")
        while (l.length() > 40) l.remove(0)
    }

    fun isEnabled(ctx: Context) = synchronized(lock) { load(ctx).optBoolean("enabled", false) }

    fun setEnabled(ctx: Context, on: Boolean) {
        if (!BuildConfig.BOT) return
        edit(ctx) { it.put("enabled", on) }
        if (on) { BotWorker.schedulePeriodic(ctx); BotWorker.kick(ctx) } else { WorkManager.getInstance(ctx).cancelUniqueWork("wabot-periodic") }
    }

    /** Test sur émulateur : accepte les notifications envoyées par « adb shell cmd notification post ». */
    fun setTestMode(ctx: Context, on: Boolean) { edit(ctx) { it.put("test", on) } }
    private fun testMode(ctx: Context) = synchronized(lock) { load(ctx).optBoolean("test", false) }

    fun setGroups(ctx: Context, groups: JSONObject) { edit(ctx) { it.put("groups", groups) } }

    /** Numéros / noms dont les photos ne doivent PAS être prises (ex. l'équipe SONICOD qui poste aussi dans le groupe). */
    fun setBlocked(ctx: Context, list: JSONArray) { edit(ctx) { it.put("blocked", list) } }

    private fun digits(s: String) = s.filter { it.isDigit() }
    /** Vrai si l'expéditeur (nom affiché ou numéro) est dans la liste à ignorer. */
    fun isBlocked(blocked: JSONArray?, name: String, id: String): Boolean {
        if (blocked == null) return false
        val dn = digits(name); val di = digits(id); val nn = norm(name)
        for (i in 0 until blocked.length()) {
            val b = blocked.optString(i).trim(); if (b.isEmpty()) continue
            val db = digits(b)
            if (db.length >= 8) { val k = db.takeLast(9); if ((dn.length >= 8 && dn.endsWith(k)) || (di.length >= 8 && di.endsWith(k))) return true }
            else { val nb = norm(b); if (nb.isNotEmpty() && nn.isNotEmpty() && (nn == nb || nn.contains(nb))) return true }
        }
        return false
    }

    /* ---------------- autorisations ---------------- */

    fun hasNotifAccess(ctx: Context): Boolean {
        val s = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: return false
        return s.contains(ctx.packageName + "/")
    }

    /* Dossier WhatsApp choisi UNE fois par l'utilisateur (Android le partage avec l'app) : pas d'« accès à tous les fichiers ». */
    fun treeUri(ctx: Context): android.net.Uri? = synchronized(lock) { load(ctx).optString("tree").takeIf { it.isNotEmpty() }?.let { android.net.Uri.parse(it) } }
    fun setTree(ctx: Context, uri: android.net.Uri) { edit(ctx) { it.put("tree", uri.toString()).remove("dirs") } }

    fun hasFilesAccess(ctx: Context): Boolean {
        if (testMode(ctx) && testRoot(ctx).isDirectory) return true
        val t = treeUri(ctx) ?: return false
        return ctx.contentResolver.persistedUriPermissions.any { it.uri == t && it.isReadPermission }
    }
    private fun testRoot(ctx: Context) = File(ctx.filesDir, "wa-test/Media")

    fun status(ctx: Context): JSONObject = synchronized(lock) {
        val o = load(ctx)
        val groups = o.optJSONObject("groups") ?: JSONObject()
        // Groupes vus récemment dans les notifications (pour les ajouter en un clic)
        val seen = JSONArray()
        o.optJSONObject("seen")?.let { s ->
            s.keys().asSequence().map { it to s.optLong(it) }.sortedByDescending { it.second }.take(25)
                .forEach { (g, t) -> if (!groups.has(g)) seen.put(JSONObject().put("name", g).put("t", t)) }
        }
        val roots = try { mediaDirs(ctx, "img") + mediaDirs(ctx, "doc") } catch (e: Exception) { emptyList() }
        JSONObject()
            .put("enabled", o.optBoolean("enabled", false))
            .put("notif", hasNotifAccess(ctx))
            .put("files", hasFilesAccess(ctx))
            .put("whatsappFolder", roots.isNotEmpty())
            .put("groups", groups)
            .put("blocked", o.optJSONArray("blocked") ?: JSONArray())
            .put("senders", JSONArray().also { arr ->
                o.optJSONObject("senders")?.let { so -> so.keys().asSequence().map { so.getJSONObject(it) }.sortedByDescending { it.optLong("t") }.take(30).forEach { arr.put(it) } }
            })
            .put("seen", seen)
            .put("log", o.optJSONArray("log") ?: JSONArray())
            .put("lastRun", o.optLong("lastRun", 0))
            .put("waiting", (o.optJSONArray("events") ?: JSONArray()).let { ev ->
                var n = 0
                for (i in 0 until ev.length()) { val e = ev.getJSONObject(i); if (!e.has("f") && !e.optBoolean("x")) n++ }
                n
            })
            .put("sdk", Build.VERSION.SDK_INT)
    }

    /* ---------------- notifications WhatsApp ---------------- */

    private val COUNT_SUFFIX = Regex("""\s*\(\d+\s+[^)]*\)\s*$""")
    private val PHOTO_RE = Regex("""^\s*📷""")
    private val DOC_RE = Regex("""^\s*📄\s*(.*)$""")

    fun onNotification(ctx: Context, sbn: StatusBarNotification) {
        if (sbn.packageName !in PKGS && !(sbn.packageName == "com.android.shell" && testMode(ctx))) return
        val n = sbn.notification ?: return
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        val ex = n.extras ?: return
        val isGroup = ex.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false)
        val conv = ex.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()
        val title = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        val group = when {
            !conv.isNullOrBlank() -> conv
            isGroup -> title
            title.contains(": ") -> title.substringBefore(": ")   // anciens WhatsApp : « Groupe: Expéditeur »
            else -> ""   // discussion privée : notée seulement pour que sa photo ne soit pas prise pour celle d'un groupe
        }.replace(COUNT_SUFFIX, "").trim()

        val msgs = ArrayList<Pair<String, Long>>()
        val senders = ArrayList<Pair<String, String>>()   // nom affiché, numéro / identifiant (si WhatsApp le donne)
        val arr = ex.getParcelableArray(Notification.EXTRA_MESSAGES)
        if (arr != null && arr.isNotEmpty()) {
            for (p in arr) (p as? Bundle)?.let { b ->
                msgs.add((b.getCharSequence("text")?.toString() ?: "") to b.getLong("time", sbn.postTime))
                val person = if (Build.VERSION.SDK_INT >= 28) try { b.getParcelable<android.app.Person>("sender_person") } catch (e: Exception) { null } else null
                senders.add((b.getCharSequence("sender")?.toString() ?: person?.name?.toString() ?: "") to (person?.uri ?: person?.key ?: ""))
            }
        } else {
            msgs.add((ex.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: "") to sbn.postTime)
            senders.add((if (title.contains(": ")) title.substringAfter(": ") else "") to "")
        }

        var added = 0
        edit(ctx) { o ->
            if (group.isNotEmpty()) o.obj("seen").put(group, sbn.postTime)
            val ev = o.arr("events")
            val keys = HashSet<String>()
            for (i in 0 until ev.length()) keys.add(ev.getJSONObject(i).optString("id"))
            for ((mi, m) in msgs.withIndex()) {
                val (text, t) = m
                val (sName, sId) = senders.getOrElse(mi) { "" to "" }
                val kind: String
                var name = ""
                val d = DOC_RE.find(text)
                if (d != null) { kind = "doc"; name = d.groupValues[1].trim() }
                else if (PHOTO_RE.containsMatchIn(text)) kind = "img"
                else continue
                val id = "$group|$t|$kind|$name"
                if (id in keys) continue
                keys.add(id)
                ev.put(JSONObject().put("id", id).put("g", group).put("t", t).put("k", kind).put("n", name).put("s", sName).put("su", sId))
                if (sName.isNotEmpty() || sId.isNotEmpty()) o.obj("senders").put((sName + "|" + sId).take(120), JSONObject().put("n", sName).put("u", sId).put("g", group).put("t", t))
                added++
            }
            // on garde 4 jours
            val limit = System.currentTimeMillis() - 4 * DAY
            val keep = JSONArray()
            for (i in 0 until ev.length()) { val e = ev.getJSONObject(i); if (e.optLong("t") > limit) keep.put(e) }
            o.put("events", keep)
            val seen = o.obj("seen")
            seen.keys().asSequence().toList().forEach { if (seen.optLong(it) < limit - 10 * DAY) seen.remove(it) }
            val snd = o.obj("senders")
            if (snd.length() > 80) snd.keys().asSequence().toList().sortedBy { snd.optJSONObject(it)?.optLong("t") ?: 0 }.take(snd.length() - 60).forEach { snd.remove(it) }
        }
        if (added > 0 && isEnabled(ctx)) BotWorker.kick(ctx)
    }

    /* ---------------- dossier WhatsApp ---------------- */

    /** Un fichier du dossier WhatsApp (uri content:// ou file://). */
    data class MFile(val uri: String, val name: String, val mtime: Long, val size: Long)

    private data class Child(val id: String, val name: String, val dir: Boolean, val mtime: Long, val size: Long)

    private fun children(ctx: Context, tree: android.net.Uri, docId: String): List<Child> {
        val out = ArrayList<Child>()
        val u = android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
        val proj = arrayOf(android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID, android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE, android.provider.DocumentsContract.Document.COLUMN_LAST_MODIFIED, android.provider.DocumentsContract.Document.COLUMN_SIZE)
        ctx.contentResolver.query(u, proj, null, null, null)?.use { c ->
            while (c.moveToNext()) out.add(Child(c.getString(0), c.getString(1) ?: "", c.getString(2) == android.provider.DocumentsContract.Document.MIME_TYPE_DIR, c.getLong(3), c.getLong(4)))
        }
        return out
    }

    /** Dossiers « … Images » / « … Documents » de WhatsApp (cherchés une fois sous le dossier choisi). */
    private fun mediaDirs(ctx: Context, kind: String): List<String> {
        val suffix = if (kind == "img") " Images" else " Documents"
        if (testMode(ctx) && testRoot(ctx).isDirectory) return testRoot(ctx).listFiles { f -> f.isDirectory && f.name.endsWith(suffix) }?.map { "file:" + it.path } ?: emptyList()
        val tree = treeUri(ctx) ?: return emptyList()
        val cached = synchronized(lock) { load(ctx).optJSONObject("dirs")?.optJSONArray(kind) }
        if (cached != null && cached.length() > 0) return (0 until cached.length()).map { cached.getString(it) }
        val found = ArrayList<String>()
        var level = listOf(android.provider.DocumentsContract.getTreeDocumentId(tree))
        for (depth in 0..4) {
            val next = ArrayList<String>()
            for (id in level) for (ch in children(ctx, tree, id)) if (ch.dir) {
                if (ch.name.endsWith(suffix)) found.add(ch.id) else if (ch.name != "Sent" && ch.name != "Private" && !ch.name.startsWith(".")) next.add(ch.id)
            }
            if (found.isNotEmpty() || next.isEmpty()) break
            level = next.take(40)
        }
        if (found.isNotEmpty()) edit(ctx) { o -> o.obj("dirs").put(kind, JSONArray(found)) }
        return found
    }

    /** Fichiers reçus (pas le dossier « Sent ») des 4 derniers jours. */
    private fun mediaFiles(ctx: Context, kind: String): List<MFile> {
        val limit = System.currentTimeMillis() - 4 * DAY
        val imgRe = Regex("(?i).+\\.(jpe?g|png|webp)$")
        val out = ArrayList<MFile>()
        val tree = treeUri(ctx)
        for (d in mediaDirs(ctx, kind)) {
            if (d.startsWith("file:")) {
                File(d.removePrefix("file:")).listFiles()?.forEach { f ->
                    if (f.isFile && !f.name.startsWith(".") && f.lastModified() > limit && f.length() > 0 && (kind != "img" || imgRe.matches(f.name)))
                        out.add(MFile(android.net.Uri.fromFile(f).toString(), f.name, f.lastModified(), f.length()))
                }
            } else if (tree != null) {
                for (ch in children(ctx, tree, d)) {
                    if (ch.dir || ch.name.startsWith(".") || ch.mtime <= limit || ch.size <= 0) continue
                    if (kind == "img" && !imgRe.matches(ch.name)) continue
                    out.add(MFile(android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, ch.id).toString(), ch.name, ch.mtime, ch.size))
                }
            }
        }
        return out.sortedBy { it.mtime }
    }

    private fun open(ctx: Context, uri: String) = ctx.contentResolver.openInputStream(android.net.Uri.parse(uri))

    private fun baseName(n: String) = n.substringBeforeLast('.').replace(Regex("""\s*\(\d+\)$"""), "").trim().lowercase(Locale.ROOT)

    /* ---------------- lecture d'étiquette ---------------- */

    data class Label(val colis: Int?, val brv: String, val zone: String, val label: Boolean = false, val tracks: List<String> = emptyList(), val ticket: Boolean = false)

    fun parseLabel(text: String): Label {
        val flat = text.replace(Regex("\\s+"), " ")
        val isLabel = Regex("BON\\s*RETOUR|NOMBRE\\s*D|N[O0][A-Z]{0,4}\\s*D[EU]\\s*CO[LI]{0,2}S|\\b[BG8]R[VY][-\\s]?\\d{6,}", RegexOption.IGNORE_CASE).containsMatchIn(flat)
        // « 201 | 2/2 » = 201 colis, étiquette 2 sur 2 ; la lecture colle parfois tout : « 2012/2 » → 201 + 2/2
        var colis: Int? = null
        val ci = Regex("N[O0][A-Z]{0,4}\\s*D[EU]\\s*CO[LI]{0,2}S|NOMBRE|COLIS", RegexOption.IGNORE_CASE).find(flat)?.range?.first ?: -1
        val zoneTxt = if (ci >= 0) flat.substring(ci) else flat
        Regex("(\\d{1,6})\\s*([|lI!]?)\\s*(\\d{0,2})\\s*/\\s*(\\d{1,2})(?!\\d|\\s*/)").find(zoneTxt)?.let { p ->
            var a = p.groupValues[1]; var x = p.groupValues[3]; val y = p.groupValues[4]; val sep = p.groupValues[2]
            if (x.isEmpty() && sep.isEmpty() && a.length > y.length) {
                val cand = a.takeLast(y.length)
                if ((cand.toIntOrNull() ?: 0) in 1..(y.toIntOrNull() ?: 0)) { x = cand; a = a.dropLast(y.length) }
            }
            if (x.isNotEmpty() && a.isNotEmpty() && a.length <= 4 && (a.toIntOrNull() ?: 0) > 0) colis = a.toInt()
        }
        if (colis == null) colis = Regex("(?:NOMBRE|N[O0][A-Z]{0,4})\\s*D[EU]\\s*CO[LI]{0,2}S\\D{0,25}?(\\d{1,4})(?!\\d)", RegexOption.IGNORE_CASE).find(flat)?.groupValues?.get(1)?.toIntOrNull()
        val zone = Regex("Zone\\s*:?\\s*((?:HUB\\s+)?[A-Z][A-Za-zÉÈéè'\\- ]{2,25}?)(?=\\s+(?:Date|Magasin|T[ée]l|Adresse|NOMBRE|\\d)|$)", RegexOption.IGNORE_CASE)
            .find(flat)?.groupValues?.get(1)?.trim()?.uppercase(Locale.ROOT) ?: ""
        val brv = Regex("\\b[BG8]R[VY][-\\s]?(\\d{8,20})", RegexOption.IGNORE_CASE).find(flat)?.let { "BRV-" + it.groupValues[1] } ?: ""
        // n° de suivi visibles (ex. N875620619) : la même étiquette sur 2 photos = 1 seul colis
        val tracks = Regex("\\b[A-Z]{1,3}\\d{8,12}\\b").findAll(flat.uppercase(Locale.ROOT)).map { it.value }
            .filter { !Regex("^[BG8]R[VY]").containsMatchIn(it) }.distinct().take(20).toList()
        val c = colis
        // ticket de COMMANDE (petit colis) : n° de suivi, « SONICOD » hors bon de retour, prix en DH
        val ticket = !isLabel && (tracks.isNotEmpty() || flat.contains("SONICOD", true) || Regex("\\b\\d{2,5}(?:[.,]\\d{1,2})?\\s*DH\\b", RegexOption.IGNORE_CASE).containsMatchIn(flat))
        return Label(if (isLabel && c != null && c > 0) c else null, brv, zone, isLabel, tracks, ticket)
    }

    /** Lit le texte d'une photo sur le téléphone (ML Kit), sinon via le serveur Google. */
    fun readLabel(ctx: Context, f: File): Label? = readLabelFrom(ctx) { if (f.exists()) f.inputStream() else null }

    fun readLabelFrom(ctx: Context, opener: () -> java.io.InputStream?): Label? {
        try {
            val b = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            opener()?.use { BitmapFactory.decodeStream(it, null, b) }
            var s = 1
            while (b.outWidth / (s * 2) >= 1600 && b.outHeight / (s * 2) >= 1600) s *= 2
            val bmp = opener()?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = s }) } ?: return null
            val rec = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
            try {
                val img = InputImage.fromBitmap(bmp, 0)
                val text = Tasks.await(rec.process(img), 40, TimeUnit.SECONDS).text
                val lab = parseLabel(text)
                if (lab.label || lab.ticket) return lab
                // code-barres / QR visible et pas un bon de retour → ticket de commande
                val bc = com.google.mlkit.vision.barcode.BarcodeScanning.getClient()
                return try {
                    val codes = Tasks.await(bc.process(img), 20, TimeUnit.SECONDS)
                    val tr = codes.mapNotNull { it.rawValue?.trim() }.filter { Regex("^[A-Z]{1,3}\\d{8,12}$").matches(it) }
                    if (codes.isNotEmpty()) lab.copy(ticket = true, tracks = (lab.tracks + tr).distinct()) else lab
                } catch (e: Exception) { lab } finally { bc.close() }
            } finally {
                rec.close(); bmp.recycle()
            }
        } catch (e: Exception) {
            // module de lecture pas encore téléchargé, etc. → lecture par le serveur
        }
        return try {
            val id = PhotoStore.importImage(ctx, opener) ?: return null
            val b64 = PhotoStore.base64(ctx, id)
            PhotoStore.delete(ctx, id)
            val r = Api.post(Session.serverUrl(ctx), JSONObject().put("action", "ocrLabel").put("key", APP_KEY).put("b64", b64).toString())
            val d = r.optJSONObject("data")
            if (r.optBoolean("ok") && d != null) Label(d.optInt("colis", 0).takeIf { it > 0 }, d.optString("brv"), d.optString("zone"), d.optBoolean("label", d.optInt("colis", 0) > 0),
                d.optJSONArray("tracks")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()) else null
        } catch (e: Exception) { null }
    }

    data class Count(val colis: Int?, val source: String, val brvs: Map<String, Int>, val commandes: Int = 0)

    /**
     * COLIS = gros sacs / gros cartons (sans ticket) : 1 photo = 1 colis ; les petites commandes (avec ticket) NE COMPTENT PAS ;
     * l'étiquette « BON RETOUR » ne compte pas (son nombre est gardé dans la note).
     */
    fun countColis(reads: List<Label?>, nPhotos: Int): Count {
        val brvs = LinkedHashMap<String, Int>()
        var labels = 0; var tickets = 0
        for (d in reads) {
            if (d == null) continue
            if (d.label) { labels++; if (d.colis != null) { val k = d.brv.ifEmpty { "n" + d.colis }; brvs[k] = maxOf(brvs[k] ?: 0, d.colis) }; continue }
            if (d.ticket || d.tracks.isNotEmpty()) tickets++
        }
        val colis = maxOf(0, nPhotos - labels - tickets)
        val lab = if (brvs.isEmpty()) null else brvs.values.sum()
        return Count(colis, "$colis colis" + (if (tickets > 0) " · $tickets photo(s) de petites commandes non comptée(s)" else "") + (if (lab != null) " · étiquette : $lab" else ""), brvs, tickets)
    }

    /** Même identifiant que le bot Chrome (« wa- » + hash de « groupe|jour ») : une seule ligne par groupe et par jour. */
    fun pidOf(key: String): String = "wa-" + Math.abs(key.hashCode().toLong()).toString(16)

    /* ---------------- passage du bot ---------------- */

    /** Relie notifications et fichiers, lit les étiquettes et envoie au Sheet. Renvoie un résumé. */
    fun run(ctx: Context): JSONObject {
        val res = JSONObject()
        if (!hasFilesAccess(ctx)) { log(ctx, "⚠ Choisissez le dossier WhatsApp Business"); return res.put("ok", false).put("error", "Choisissez d'abord le dossier WhatsApp Business.") }
        if (mediaDirs(ctx, "img").isEmpty()) { log(ctx, "⚠ Dossier « WhatsApp Business Images » introuvable dans le dossier choisi"); return res.put("ok", false).put("error", "Dossier WhatsApp introuvable : choisissez « com.whatsapp.w4b ».") }

        val now = System.currentTimeMillis()
        val imgs = mediaFiles(ctx, "img")
        val docs = mediaFiles(ctx, "doc")

        // 1) relier chaque notification à son fichier
        val (groups, records) = synchronized(lock) {
            val o = load(ctx)
            val groups = o.optJSONObject("groups") ?: JSONObject()
            val claimed = HashSet<String>()
            val ev = o.optJSONArray("events") ?: JSONArray()
            val list = (0 until ev.length()).map { ev.getJSONObject(it) }.sortedBy { it.optLong("t") }
            list.forEach { e -> e.optString("f").takeIf { it.isNotEmpty() }?.let { claimed.add(it) } }
            for (e in list) {
                if (e.has("f") || e.optBoolean("x")) continue
                val t = e.optLong("t")
                val f: MFile? = if (e.optString("k") == "doc") {
                    val want = baseName(e.optString("n"))
                    docs.firstOrNull { it.uri !in claimed && want.isNotEmpty() && want != "document" && baseName(it.name) == want && it.mtime >= t - 120_000 }
                        ?: docs.firstOrNull { it.uri !in claimed && it.mtime in (t - 120_000)..(t + 6 * 3600_000) && (want.isEmpty() || want == "document") }
                } else {
                    imgs.firstOrNull { it.uri !in claimed && it.mtime in (t - 120_000)..(t + 6 * 3600_000) && now - it.mtime > 10_000 }
                }
                if (f != null) { e.put("f", f.uri).put("fn", f.name); claimed.add(f.uri) }
                else if (now - t > 6 * 3600_000) e.put("x", true)   // jamais téléchargé (téléchargement auto désactivé ?)
            }
            o.put("events", JSONArray(list))
            save(ctx, o)

            // 2) regrouper par groupe retour + jour
            val recs = LinkedHashMap<String, JSONObject>()
            for (e in list) {
                val path = e.optString("f"); if (path.isEmpty()) continue
                if (isBlocked(o.optJSONArray("blocked"), e.optString("s"), e.optString("su"))) continue   // photo d'un numéro ignoré
                val g = e.optString("g")
                val ville = matchGroup(groups, g) ?: continue
                val day = dayFmt.format(Date(e.optLong("t")))
                val key = "$g|$day"
                val r = recs.getOrPut(key) { JSONObject().put("key", key).put("g", g).put("day", day).put("ville", ville).put("img", JSONArray()).put("doc", JSONArray()) }
                r.getJSONArray(if (e.optString("k") == "doc") "doc" else "img").put(path)
                r.obj("names").put(path, e.optString("fn").ifEmpty { android.net.Uri.decode(path).substringAfterLast('/') })
            }
            groups to recs.values.toList()
        }
        if (groups.length() == 0) { log(ctx, "Aucun groupe retour configuré"); return res.put("ok", true).put("sent", 0) }

        // 3) lire les étiquettes et envoyer
        var sentN = 0; var errN = 0
        for (r in records) {
            try { if (sendRecord(ctx, r)) sentN++ } catch (e: Exception) { errN++; log(ctx, "✗ " + r.optString("g") + " : " + (e.message ?: "erreur")) }
        }
        edit(ctx) { it.put("lastRun", now) }
        if (records.isEmpty()) log(ctx, "Rien de nouveau dans les groupes retour")
        return res.put("ok", errN == 0).put("sent", sentN).put("errors", errN).put("records", records.size)
    }

    private fun norm(s: String) = s.lowercase(Locale.ROOT).replace(Regex("[^\\p{L}\\p{N}]+"), " ").trim()

    /** Ville du groupe (nom exact, sinon nom proche). */
    private fun matchGroup(groups: JSONObject, g: String): String? {
        if (g.isBlank()) return null
        if (groups.has(g)) return groups.optString(g).ifEmpty { null }
        val ng = norm(g)
        for (k in groups.keys()) { val nk = norm(k); if (nk.isNotEmpty() && (nk == ng || ng.contains(nk) || nk.contains(ng))) return groups.optString(k).ifEmpty { null } }
        return null
    }

    private fun sendRecord(ctx: Context, r: JSONObject): Boolean {
        val pid = pidOf(r.getString("key"))
        val group = r.getString("g"); val ville = r.getString("ville"); val day = r.getString("day")
        val (done, ocr) = synchronized(lock) { val o = load(ctx); (o.optJSONObject("sent")?.optJSONObject(pid) ?: JSONObject()) to (o.optJSONObject("ocr") ?: JSONObject()) }
        val doneP = done.optJSONArray("p") ?: JSONArray()
        val doneD = done.optJSONArray("d") ?: JSONArray()
        val doneSet = HashSet<String>().apply { for (i in 0 until doneP.length()) add(doneP.getString(i)); for (i in 0 until doneD.length()) add(doneD.getString(i)) }

        val imgs = r.getJSONArray("img")
        val newOcr = JSONObject()
        val reads = ArrayList<Label?>()
        for (i in 0 until imgs.length()) {
            val path = imgs.getString(i)
            val cached = ocr.optJSONObject(path)?.takeIf { it.optInt("v") == 2 }
            val lab = if (cached != null) Label(cached.optInt("c", 0).takeIf { it > 0 }, cached.optString("b"), "", cached.optBoolean("l"),
                cached.optJSONArray("t")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList(), cached.optBoolean("k"))
            else (readLabelFrom(ctx) { open(ctx, path) } ?: Label(null, "", "")).also {
                newOcr.put(path, JSONObject().put("c", it.colis ?: 0).put("b", it.brv).put("l", it.label).put("t", JSONArray(it.tracks)).put("k", it.ticket).put("v", 2))
            }
            reads.add(lab)
        }
        if (newOcr.length() > 0) edit(ctx) { o -> val c = o.obj("ocr"); newOcr.keys().forEach { c.put(it, newOcr.get(it)) }; while (c.length() > 400) c.remove(c.keys().next()) }
        val cnt = countColis(reads, imgs.length())
        val colis = cnt.colis
        val source = cnt.source
        val brvs = cnt.brvs
        val commandes = cnt.commandes

        val names = r.optJSONObject("names") ?: JSONObject()
        val nameOf = { u: String -> names.optString(u).ifEmpty { android.net.Uri.decode(u).substringAfterLast('/') } }
        val newImgs = (0 until imgs.length()).map { imgs.getString(it) }.filter { it !in doneSet }
        val dl = r.getJSONArray("doc")
        val newDocs = (0 until dl.length()).map { dl.getString(it) }.filter { it !in doneSet }
        val sameColis = (done.opt("c") as? Int ?: 0) == (colis ?: 0) && done.has("c") && done.optInt("k", -1) == commandes
        if (newImgs.isEmpty() && newDocs.isEmpty() && sameColis && done.optString("l") == ville) return false

        log(ctx, "→ $group ($day) : " + newImgs.size + " photo(s), " + newDocs.size + " PDF, " + (colis?.let { "$it colis lus" } ?: "colis non lus"))
        val brvTxt = brvs.keys.filter { it.startsWith("BRV") }
        val note = group + (if (source.isNotEmpty()) " · $source" else "") + (if (brvTxt.isNotEmpty()) " · " + brvTxt.joinToString(", ") else "")
        // envoi par paquets de 8 photos (limite du serveur : 10)
        val chunks = if (newImgs.isEmpty()) listOf(emptyList()) else newImgs.chunked(8)
        var lastRow = 0
        chunks.forEachIndexed { idx, chunk ->
            val photos = JSONArray()
            val tmp = ArrayList<String>()
            for (path in chunk) {
                // identifiant = nom du fichier WhatsApp : le Sheet ignore une photo déjà enregistrée
                try { PhotoStore.importImage(ctx) { open(ctx, path) } } catch (e: Exception) { null }
                    ?.let { id -> tmp.add(id); PhotoStore.base64(ctx, id)?.let { photos.put(JSONObject().put("b64", it).put("id", "f:" + nameOf(path))) } }
            }
            val files = JSONArray()
            if (idx == 0) for (path in newDocs) {
                val nm = nameOf(path)
                val bytes = try { open(ctx, path)?.use { it.readBytes() } } catch (e: Exception) { null }
                if (bytes != null && bytes.size in 1..15 * 1024 * 1024) files.put(JSONObject().put("b64", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("name", nm)
                    .put("mime", if (nm.endsWith(".pdf", true)) "application/pdf" else "application/octet-stream"))
            }
            val req = JSONObject().put("action", "addPending").put("key", APP_KEY).put("pid", pid).put("livreur", ville)
                .put("colis", colis ?: "").put("date", day).put("who", "Bot téléphone").put("note", note)
                .put("photos", photos).put("files", files)
            val resp = try { Api.post(Session.serverUrl(ctx), req.toString()) } finally { tmp.forEach { PhotoStore.delete(ctx, it) } }
            if (!resp.optBoolean("ok")) throw Exception(resp.optString("error", "Erreur serveur"))
            resp.optJSONObject("data")?.optJSONArray("docsRefused")?.let { a -> if (a.length() > 0) log(ctx, "Bon déjà enregistré, ignoré : " + (0 until a.length()).joinToString(", ") { a.getString(it) }) }
            lastRow = resp.optJSONObject("data")?.optInt("row") ?: 0
            // mémoriser ce qui est parti
            edit(ctx) { o ->
                val s = o.obj("sent").obj(pid)
                val p = s.arr("p"); chunk.forEach { p.put(it) }
                if (idx == 0) { val d = s.arr("d"); newDocs.forEach { d.put(it) } }
                s.put("c", colis ?: 0).put("k", commandes).put("l", ville)
                val all = o.obj("sent"); while (all.length() > 200) all.remove(all.keys().next())
            }
        }
        log(ctx, "✓ $group → $ville $colis colis" + " · +" + newImgs.size + " photo(s) · +" + newDocs.size + " PDF (ligne $lastRow)")
        return true
    }
}

/** Reçoit les notifications de WhatsApp (seulement le groupe, l'heure et le type : 📷 / 📄). Déclaré seulement dans l'app « SONICOD Bot ». */
class WaListener : android.service.notification.NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return
        try { WaBot.onNotification(applicationContext, sbn) } catch (e: Exception) {}
    }

    override fun onListenerConnected() {
        try { activeNotifications?.forEach { WaBot.onNotification(applicationContext, it) } } catch (e: Exception) {}
    }
}

/** Passage du bot : quelques minutes après une photo reçue, et toutes les heures. */
class BotWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        if (!WaBot.isEnabled(applicationContext)) return Result.success()
        return try {
            val r = WaBot.run(applicationContext)
            if (r.optInt("errors") > 0) Result.retry() else Result.success()
        } catch (e: Exception) {
            WaBot.log(applicationContext, "✗ " + (e.message ?: "erreur"))
            Result.retry()
        }
    }

    companion object {
        private val net get() = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        fun kick(ctx: Context) {
            val req = OneTimeWorkRequestBuilder<BotWorker>().setInitialDelay(3, TimeUnit.MINUTES).setConstraints(net).build()
            WorkManager.getInstance(ctx).enqueueUniqueWork("wabot-kick", ExistingWorkPolicy.KEEP, req)
        }

        fun schedulePeriodic(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<BotWorker>(1, TimeUnit.HOURS).setConstraints(net).build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("wabot-periodic", ExistingPeriodicWorkPolicy.KEEP, req)
        }
    }
}
