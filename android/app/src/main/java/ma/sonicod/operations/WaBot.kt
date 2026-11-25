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
        edit(ctx) { it.put("enabled", on) }
        if (on) { BotWorker.schedulePeriodic(ctx); BotWorker.kick(ctx) } else { WorkManager.getInstance(ctx).cancelUniqueWork("wabot-periodic") }
    }

    /** Test sur émulateur : accepte les notifications envoyées par « adb shell cmd notification post ». */
    fun setTestMode(ctx: Context, on: Boolean) { edit(ctx) { it.put("test", on) } }
    private fun testMode(ctx: Context) = synchronized(lock) { load(ctx).optBoolean("test", false) }

    fun setGroups(ctx: Context, groups: JSONObject) { edit(ctx) { it.put("groups", groups) } }

    /* ---------------- autorisations ---------------- */

    fun hasNotifAccess(ctx: Context): Boolean {
        val s = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: return false
        return s.contains(ctx.packageName + "/")
    }

    fun hasFilesAccess(ctx: Context): Boolean = when {
        Build.VERSION.SDK_INT >= 30 -> Environment.isExternalStorageManager()
        else -> ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    }

    fun status(ctx: Context): JSONObject = synchronized(lock) {
        val o = load(ctx)
        val groups = o.optJSONObject("groups") ?: JSONObject()
        // Groupes vus récemment dans les notifications (pour les ajouter en un clic)
        val seen = JSONArray()
        o.optJSONObject("seen")?.let { s ->
            s.keys().asSequence().map { it to s.optLong(it) }.sortedByDescending { it.second }.take(25)
                .forEach { (g, t) -> if (!groups.has(g)) seen.put(JSONObject().put("name", g).put("t", t)) }
        }
        val roots = mediaRoots().map { it.path }
        JSONObject()
            .put("enabled", o.optBoolean("enabled", false))
            .put("notif", hasNotifAccess(ctx))
            .put("files", hasFilesAccess(ctx))
            .put("whatsappFolder", roots.isNotEmpty())
            .put("groups", groups)
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
        val arr = ex.getParcelableArray(Notification.EXTRA_MESSAGES)
        if (arr != null && arr.isNotEmpty()) {
            for (p in arr) (p as? Bundle)?.let { b ->
                msgs.add((b.getCharSequence("text")?.toString() ?: "") to b.getLong("time", sbn.postTime))
            }
        } else {
            msgs.add((ex.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: "") to sbn.postTime)
        }

        var added = 0
        edit(ctx) { o ->
            if (group.isNotEmpty()) o.obj("seen").put(group, sbn.postTime)
            val ev = o.arr("events")
            val keys = HashSet<String>()
            for (i in 0 until ev.length()) keys.add(ev.getJSONObject(i).optString("id"))
            for ((text, t) in msgs) {
                val kind: String
                var name = ""
                val d = DOC_RE.find(text)
                if (d != null) { kind = "doc"; name = d.groupValues[1].trim() }
                else if (PHOTO_RE.containsMatchIn(text)) kind = "img"
                else continue
                val id = "$group|$t|$kind|$name"
                if (id in keys) continue
                keys.add(id)
                ev.put(JSONObject().put("id", id).put("g", group).put("t", t).put("k", kind).put("n", name))
                added++
            }
            // on garde 4 jours
            val limit = System.currentTimeMillis() - 4 * DAY
            val keep = JSONArray()
            for (i in 0 until ev.length()) { val e = ev.getJSONObject(i); if (e.optLong("t") > limit) keep.put(e) }
            o.put("events", keep)
            val seen = o.obj("seen")
            seen.keys().asSequence().toList().forEach { if (seen.optLong(it) < limit - 10 * DAY) seen.remove(it) }
        }
        if (added > 0 && isEnabled(ctx)) BotWorker.kick(ctx)
    }

    /* ---------------- dossier WhatsApp ---------------- */

    fun mediaRoots(): List<File> {
        val ext = Environment.getExternalStorageDirectory()
        return listOf(
            File(ext, "Android/media/com.whatsapp.w4b/WhatsApp Business/Media"),
            File(ext, "WhatsApp Business/Media"),
            File(ext, "Android/media/com.whatsapp/WhatsApp/Media"),
            File(ext, "WhatsApp/Media")
        ).filter { it.isDirectory }
    }

    /** Fichiers reçus (pas le dossier « Sent ») des 4 derniers jours. */
    private fun mediaFiles(kind: String): List<File> {
        val limit = System.currentTimeMillis() - 4 * DAY
        val out = ArrayList<File>()
        for (root in mediaRoots()) {
            val dirs = root.listFiles { f -> f.isDirectory && (if (kind == "img") f.name.endsWith(" Images") else f.name.endsWith(" Documents")) } ?: continue
            for (d in dirs) d.listFiles()?.forEach { f ->
                if (f.isFile && !f.name.startsWith(".") && f.lastModified() > limit && f.length() > 0) {
                    val ok = if (kind == "img") f.name.matches(Regex("(?i).+\\.(jpe?g|png|webp)$")) else true
                    if (ok) out.add(f)
                }
            }
        }
        return out.sortedBy { it.lastModified() }
    }

    private fun baseName(n: String) = n.substringBeforeLast('.').replace(Regex("""\s*\(\d+\)$"""), "").trim().lowercase(Locale.ROOT)

    /* ---------------- lecture d'étiquette ---------------- */

    data class Label(val colis: Int?, val brv: String, val zone: String, val label: Boolean = false, val tracks: List<String> = emptyList())

    fun parseLabel(text: String): Label {
        val flat = text.replace(Regex("\\s+"), " ")
        var colis = Regex("NOMBRE\\s*D[EU]\\s*COLIS\\D{0,25}?(\\d{1,4})", RegexOption.IGNORE_CASE).find(flat)?.groupValues?.get(1)?.toIntOrNull()
        val ci = flat.indexOf("COLIS", ignoreCase = true)
        val zoneTxt = if (ci >= 0) flat.substring(ci) else flat
        val p = Regex("(\\d{1,4})\\s*[|lI!]?\\s*(\\d{1,2})\\s*/\\s*(\\d{1,2})(?!\\d|\\s*/)").find(zoneTxt)
        if (colis == null && p != null) colis = p.groupValues[1].toIntOrNull()
        val zone = Regex("Zone\\s*:?\\s*((?:HUB\\s+)?[A-Z][A-Za-zÉÈéè'\\- ]{2,25}?)(?=\\s+(?:Date|Magasin|T[ée]l|Adresse|NOMBRE|\\d)|$)", RegexOption.IGNORE_CASE)
            .find(flat)?.groupValues?.get(1)?.trim()?.uppercase(Locale.ROOT) ?: ""
        val brv = Regex("\\b[BG8]R[VY][-\\s]?(\\d{8,20})", RegexOption.IGNORE_CASE).find(flat)?.let { "BRV-" + it.groupValues[1] } ?: ""
        // étiquette / bon (tolère les erreurs de lecture : « NOWE DE COLS », « GRV »…)
        val isLabel = Regex("BON\\s*RETOUR|NOMBRE\\s*D|N[O0][A-Z]{0,4}\\s*D[EU]\\s*CO[LI]{0,2}S|\\b[BG8]R[VY][-\\s]?\\d{6,}", RegexOption.IGNORE_CASE).containsMatchIn(flat)
        // n° de suivi visibles (ex. N875620619) : la même étiquette sur 2 photos = 1 seul colis
        val tracks = Regex("\\b[A-Z]{1,3}\\d{8,12}\\b").findAll(flat.uppercase(Locale.ROOT)).map { it.value }
            .filter { !Regex("^[BG8]R[VY]").containsMatchIn(it) }.distinct().take(20).toList()
        return Label(if (isLabel && colis != null && colis > 0) colis else null, brv, zone, isLabel, tracks)
    }

    /** Lit le texte d'une photo sur le téléphone (ML Kit), sinon via le serveur Google. */
    fun readLabel(ctx: Context, f: File): Label? {
        try {
            val b = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(f.path, b)
            var s = 1
            while (b.outWidth / (s * 2) >= 1600 && b.outHeight / (s * 2) >= 1600) s *= 2
            val bmp = BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = s }) ?: return null
            val rec = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
            try {
                val text = Tasks.await(rec.process(InputImage.fromBitmap(bmp, 0)), 40, TimeUnit.SECONDS).text
                return parseLabel(text)
            } finally {
                rec.close(); bmp.recycle()
            }
        } catch (e: Exception) {
            // module de lecture pas encore téléchargé, etc. → lecture par le serveur
        }
        return try {
            val id = PhotoStore.importFile(ctx, f) ?: return null
            val b64 = PhotoStore.base64(ctx, id)
            PhotoStore.delete(ctx, id)
            val r = Api.post(Session.serverUrl(ctx), JSONObject().put("action", "ocrLabel").put("key", APP_KEY).put("b64", b64).toString())
            val d = r.optJSONObject("data")
            if (r.optBoolean("ok") && d != null) Label(d.optInt("colis", 0).takeIf { it > 0 }, d.optString("brv"), d.optString("zone"), d.optBoolean("label", d.optInt("colis", 0) > 0),
                d.optJSONArray("tracks")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()) else null
        } catch (e: Exception) { null }
    }

    data class Count(val colis: Int?, val source: String, val brvs: Map<String, Int>)

    /**
     * Nombre de colis (mêmes règles que le bot Chrome) :
     *  1) étiquette « BON RETOUR » : la même étiquette sur plusieurs photos compte une fois ;
     *  2) étiquette illisible → vide (« à vérifier ») ;
     *  3) sinon 1 photo = 1 colis, et le même n° de suivi sur 2 photos = 1 colis.
     */
    fun countColis(reads: List<Label?>, nPhotos: Int): Count {
        val brvs = LinkedHashMap<String, Int>()
        val loose = LinkedHashSet<Int>()
        val tracks = HashSet<String>()
        var unread = 0; var withTrack = 0; var labelsRead = 0
        for (d in reads) {
            if (d == null) continue
            if (d.label && d.colis != null) { labelsRead++; if (d.brv.isNotEmpty()) brvs[d.brv] = maxOf(brvs[d.brv] ?: 0, d.colis) else loose.add(d.colis) }
            else if (d.label) unread++
            else if (d.tracks.isNotEmpty()) { withTrack++; tracks.addAll(d.tracks) }
        }
        loose.forEach { n -> if (n !in brvs.values) brvs["n$n"] = n }
        if (brvs.isNotEmpty()) return Count(brvs.values.sum(), "étiquette", brvs)
        if (unread > 0) return Count(null, "étiquette illisible – à vérifier", brvs)
        val n = tracks.size + maxOf(0, nPhotos - withTrack - labelsRead)
        if (n == 0) return Count(null, "", brvs)
        return Count(n, "compté : $n colis" + (if (n != nPhotos) " sur $nPhotos photo(s)" else " ($nPhotos photo(s))"), brvs)
    }

    /** Même identifiant que le bot Chrome (« wa- » + hash de « groupe|jour ») : une seule ligne par groupe et par jour. */
    fun pidOf(key: String): String = "wa-" + Math.abs(key.hashCode().toLong()).toString(16)

    /* ---------------- passage du bot ---------------- */

    /** Relie notifications et fichiers, lit les étiquettes et envoie au Sheet. Renvoie un résumé. */
    fun run(ctx: Context): JSONObject {
        val res = JSONObject()
        if (!hasFilesAccess(ctx)) { log(ctx, "⚠ Accès aux fichiers WhatsApp refusé"); return res.put("ok", false).put("error", "Autorisez l'accès aux fichiers.") }
        if (mediaRoots().isEmpty()) { log(ctx, "⚠ Dossier WhatsApp introuvable"); return res.put("ok", false).put("error", "Dossier WhatsApp introuvable sur ce téléphone.") }

        val now = System.currentTimeMillis()
        val imgs = mediaFiles("img")
        val docs = mediaFiles("doc")

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
                val f: File? = if (e.optString("k") == "doc") {
                    val want = baseName(e.optString("n"))
                    docs.firstOrNull { it.path !in claimed && want.isNotEmpty() && want != "document" && baseName(it.name) == want && it.lastModified() >= t - 120_000 }
                        ?: docs.firstOrNull { it.path !in claimed && it.lastModified() in (t - 120_000)..(t + 6 * 3600_000) && (want.isEmpty() || want == "document") }
                } else {
                    imgs.firstOrNull { it.path !in claimed && it.lastModified() in (t - 120_000)..(t + 6 * 3600_000) && now - it.lastModified() > 10_000 }
                }
                if (f != null) { e.put("f", f.path); claimed.add(f.path) }
                else if (now - t > 6 * 3600_000) e.put("x", true)   // jamais téléchargé (téléchargement auto désactivé ?)
            }
            o.put("events", JSONArray(list))
            save(ctx, o)

            // 2) regrouper par groupe retour + jour
            val recs = LinkedHashMap<String, JSONObject>()
            for (e in list) {
                val path = e.optString("f"); if (path.isEmpty()) continue
                val g = e.optString("g")
                val ville = matchGroup(groups, g) ?: continue
                val day = dayFmt.format(Date(e.optLong("t")))
                val key = "$g|$day"
                val r = recs.getOrPut(key) { JSONObject().put("key", key).put("g", g).put("day", day).put("ville", ville).put("img", JSONArray()).put("doc", JSONArray()) }
                r.getJSONArray(if (e.optString("k") == "doc") "doc" else "img").put(path)
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
            val cached = ocr.optJSONObject(path)
            val lab = if (cached != null) Label(cached.optInt("c", 0).takeIf { it > 0 }, cached.optString("b"), "", cached.optBoolean("l"),
                cached.optJSONArray("t")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList())
            else (readLabel(ctx, File(path)) ?: Label(null, "", "")).also {
                newOcr.put(path, JSONObject().put("c", it.colis ?: 0).put("b", it.brv).put("l", it.label).put("t", JSONArray(it.tracks)))
            }
            reads.add(lab)
        }
        if (newOcr.length() > 0) edit(ctx) { o -> val c = o.obj("ocr"); newOcr.keys().forEach { c.put(it, newOcr.get(it)) }; while (c.length() > 400) c.remove(c.keys().next()) }
        val cnt = countColis(reads, imgs.length())
        val colis = cnt.colis
        val source = cnt.source
        val brvs = cnt.brvs

        val newImgs = (0 until imgs.length()).map { imgs.getString(it) }.filter { it !in doneSet && File(it).exists() }
        val dl = r.getJSONArray("doc")
        val newDocs = (0 until dl.length()).map { dl.getString(it) }.filter { it !in doneSet && File(it).exists() }
        val sameColis = (done.opt("c") as? Int ?: 0) == (colis ?: 0) && done.has("c")
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
                PhotoStore.importFile(ctx, File(path))?.let { id -> tmp.add(id); PhotoStore.base64(ctx, id)?.let { photos.put(JSONObject().put("b64", it).put("id", "f:" + File(path).name)) } }
            }
            val files = JSONArray()
            if (idx == 0) for (path in newDocs) {
                val f = File(path)
                if (f.length() in 1..15L * 1024 * 1024) files.put(JSONObject().put("b64", Base64.encodeToString(f.readBytes(), Base64.NO_WRAP)).put("name", f.name)
                    .put("mime", if (f.name.endsWith(".pdf", true)) "application/pdf" else "application/octet-stream"))
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
                s.put("c", colis ?: 0).put("l", ville)
                val all = o.obj("sent"); while (all.length() > 200) all.remove(all.keys().next())
            }
        }
        log(ctx, "✓ $group → $ville " + (colis?.let { "$it colis" } ?: "colis ?") + " · +" + newImgs.size + " photo(s) · +" + newDocs.size + " PDF (ligne $lastRow)")
        return true
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
