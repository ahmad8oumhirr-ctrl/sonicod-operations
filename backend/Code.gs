/**
 * SONICOD – Opérations (backend Google Apps Script)
 * -------------------------------------------------
 * Relie l'application Android au Google Sheet "Gestion Roteur Sonicod".
 *
 *  1) Nouvelle opération → onglet "Scanne Prepration roteur" (colonnes A→I),
 *     toujours SOUS la dernière ligne utilisée / la ligne Hsab.
 *  2) Scan des retours   → onglet "Gestion Roteur" (paires Traking / La Date) :
 *     le tracking va automatiquement dans la première case vide sous le dernier scan.
 *
 *  Pas de compte, pas de mot de passe : l'application envoie une clé (APP_KEY).
 *  Ne crée aucun onglet, ne supprime rien.
 *
 * Déploiement : Déployer > Nouveau déploiement > Application Web
 *   Exécuter en tant que : Moi     |     Accès : Tout le monde
 */

var SPREADSHEET_ID = '1ik7Oz4jcmhGiZnSwPj3cxmFffq6eHk8qguVRFXHvXbk';
var APP_KEY = 'SNC-1b7ae4568269c1f64afde3ce18d9639c';   // même clé que dans l'application

var DATA_SHEET = 'Scanne Prepration roteur';
var FIRST_DATA_ROW = 3;                 // lignes 1-2 = en-têtes

var RETOUR_SHEET = 'Gestion Roteur';
var RETOUR_HEADER_ROW = 3;              // ligne "Traking | La Date"
var RETOUR_FIRST_ROW = 4;

var PENDING_SHEET = 'Retours en attente';
var PENDING_HEADER = ['DATE ANNONCE', 'VILLE / LIVREUR', 'COLIS', 'STATUT', 'DATE RÉCEPTION', 'NOTE', 'PHOTOS', 'BON (PDF)', 'PAR', 'RÉF'];

var PHOTO_FOLDER_NAME = 'SONICOD – Photos opérations';
var WHATSAPP_GROUP = 'https://chat.whatsapp.com/LP2gQjIm7R95AYBLIj27Ad';
var MAX_PHOTOS = 10;
var TZ = 'Africa/Casablanca';

var DEFAULT_CITIES = ['Agadir', 'BENI MELAL', 'CASA', 'Chtouka', 'EL JADIDA', 'ERRACHIDIA', 'FES',
  'IBEX SUD', 'MARRAEKCH', 'OUARZAZAT', 'OUJDA', 'RABAT', 'SAFI', 'Sud', 'TANGER', 'taroudant'];
var DEFAULT_STATUSES = ['VALIDER', 'Attent Reclamation'];

/* ============================== HTTP ============================== */

function doGet(e) {
  return json_({ ok: true, app: 'SONICOD Opérations' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Requête invalide.' });
  }
  try {
    if (req.key !== APP_KEY) throw new AppError('Application non autorisée (clé incorrecte).', 'key');
    var data;
    switch (String(req.action || '')) {
      case 'ping':    data = { app: 'SONICOD Opérations' }; break;
      case 'config':  data = getConfig_(); break;
      case 'addCity': data = addCity_(req.city); break;
      case 'submit':  data = submit_(req.op, req.photos, req.who); break;
      case 'scan':    data = scan_(req); break;
      case 'addPending':     data = addPending_(req); break;
      case 'listPending':    data = listPending_(); break;
      case 'receivePending': data = receivePending_(req); break;
      default: throw new AppError('Action inconnue.');
    }
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: (err && err.message) || String(err), code: (err && err.code) || 'error' });
  }
}

function AppError(message, code) {
  this.message = message;
  this.code = code || 'error';
}
AppError.prototype = Object.create(Error.prototype);

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ============================== VILLES / STATUTS ============================== */

function getList_(key, def) {
  var raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return def.slice();
  try { var l = JSON.parse(raw); return Array.isArray(l) && l.length ? l : def.slice(); } catch (e) { return def.slice(); }
}

function getConfig_() {
  return {
    cities: getList_('cities', DEFAULT_CITIES),
    statuses: getList_('statuses', DEFAULT_STATUSES),
    whatsappGroup: WHATSAPP_GROUP
  };
}

function addCity_(city) {
  city = String(city || '').trim().slice(0, 40);
  if (!city) throw new AppError('Nom de ville vide.');
  return withLock_(function () {
    var list = getList_('cities', DEFAULT_CITIES);
    var exists = list.some(function (c) { return c.toLowerCase() === city.toLowerCase(); });
    if (!exists) {
      list.push(city);
      PropertiesService.getScriptProperties().setProperty('cities', JSON.stringify(list));
    }
    return getConfig_();
  });
}

/* ============================== OUTILS FEUILLE ============================== */

function sheet_(name) {
  var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name);
  if (!sh) throw new Error('Onglet "' + name + '" introuvable.');
  return sh;
}

function isColoredRow_(bg) {
  bg = String(bg || '').toLowerCase();
  return bg !== '' && bg !== '#ffffff' && bg !== 'white';
}

function colLetter_(c) {
  var s = '';
  while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
  return s;
}

function parseIsoDate_(s, label) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) throw new AppError(label + ' invalide.');
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
}

function dayNumber_(d) {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

/** Évite d'enregistrer deux fois la même action (double appui, réseau coupé…). */
function seen_(id) {
  var v = PropertiesService.getScriptProperties().getProperty(id);
  return v ? JSON.parse(v) : null;
}
function remember_(id, value) {
  var props = PropertiesService.getScriptProperties();
  value.t = Date.now();
  props.setProperty(id, JSON.stringify(value));
  var all = props.getProperties();
  var keys = Object.keys(all).filter(function (k) { return k.indexOf('op_') === 0 || k.indexOf('sc_') === 0 || k.indexOf('pd_') === 0; });
  if (keys.length < 4000) return;
  var limit = Date.now() - 30 * 86400000;
  keys.forEach(function (k) {
    try { if (JSON.parse(all[k]).t < limit) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}

/* ============================== 1) NOUVELLE OPÉRATION ============================== */

/** Première ligne libre sous la dernière opération ET sous la ligne Hsab (ligne colorée). */
function findTargetRow_(sh) {
  var last = Math.max(sh.getLastRow(), FIRST_DATA_ROW);
  var n = last - FIRST_DATA_ROW + 1;
  var rng = sh.getRange(FIRST_DATA_ROW, 1, n, 1);
  var vals = rng.getValues();
  var bgs = rng.getBackgrounds();
  var lastUsed = FIRST_DATA_ROW - 1;
  for (var i = 0; i < n; i++) {
    if (String(vals[i][0]).trim() !== '' || isColoredRow_(bgs[i][0])) lastUsed = FIRST_DATA_ROW + i;
  }
  var target = lastUsed + 1;
  if (target > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
  return target;
}

function copyRowFormat_(sh, r) {
  var start = Math.max(FIRST_DATA_ROW, r - 40);
  var n = r - start;
  if (n <= 0) return;
  var rng = sh.getRange(start, 1, n, 1);
  var vals = rng.getValues();
  var bgs = rng.getBackgrounds();
  for (var i = n - 1; i >= 0; i--) {
    if (String(vals[i][0]).trim() !== '' && !isColoredRow_(bgs[i][0])) {
      sh.getRange(start + i, 1, 1, 9).copyFormatToRange(sh, 1, 9, r, r);
      return;
    }
  }
}

function photoFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('photoFolderId');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) {}
  }
  var it = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER_NAME);
  props.setProperty('photoFolderId', folder.getId());
  return folder;
}

function monthFolder_(d) {
  var parent = photoFolder_();
  var name = Utilities.formatDate(d, TZ, 'yyyy-MM');
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function setPhotosCell_(cell, links, who) {
  if (!links.length) { cell.setValue(''); return; }
  var parts = [];
  var text = '';
  links.forEach(function (url, i) {
    if (i > 0) text += '  ';
    var label = '📷 ' + (i + 1);
    parts.push({ start: text.length, end: text.length + label.length, url: url });
    text += label;
  });
  if (who) text += ' · ' + who;
  var b = SpreadsheetApp.newRichTextValue().setText(text);
  parts.forEach(function (p) { b.setLinkUrl(p.start, p.end, p.url); });
  cell.setRichTextValue(b.build());
}

function submit_(op, photos, who) {
  if (!op) throw new AppError('Opération vide.');
  var opId = String(op.opId || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(opId)) throw new AppError('Identifiant d\'opération invalide.');
  var livreur = String(op.livreur || '').trim();
  if (!livreur) throw new AppError('Choisissez la ville / le livreur.');
  var colis = Number(op.colis);
  if (!(colis > 0) || Math.floor(colis) !== colis) throw new AppError('Le nombre de colis doit être un nombre entier positif.');
  var dRec = parseIsoDate_(op.dateReception, 'Date de réception');
  var dEnv = parseIsoDate_(op.dateEnvoi, 'Date d\'envoi');
  var delai = dayNumber_(dRec) - dayNumber_(dEnv);
  if (delai < 0) throw new AppError('La date d\'envoi doit être avant (ou égale à) la date de réception.');
  var statut = String(op.statut || '').trim();
  if (!statut) throw new AppError('Choisissez le statut.');
  var note = String(op.note || '').trim().slice(0, 1000);
  who = String(who || '').trim().slice(0, 30);
  photos = Array.isArray(photos) ? photos.slice(0, MAX_PHOTOS) : [];

  return withLock_(function () {
    var prev = seen_('op_' + opId);
    if (prev) return { row: prev.row, delai: prev.delai, photoLinks: prev.links || [], duplicate: true };

    // Photos → Google Drive
    var links = [];
    if (photos.length) {
      var folder = monthFolder_(dRec);
      var base = Utilities.formatDate(dRec, TZ, 'yyyy-MM-dd') + '_' + livreur.replace(/[^\w-]+/g, '_') + '_' + opId.slice(0, 8);
      photos.forEach(function (ph, i) {
        if (!ph || !ph.b64) return;
        var blob = Utilities.newBlob(Utilities.base64Decode(ph.b64), 'image/jpeg', base + '_' + (i + 1) + '.jpg');
        var file = folder.createFile(blob);
        try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
        links.push('https://drive.google.com/file/d/' + file.getId() + '/view');
      });
    }

    // Ligne dans le Google Sheet
    var sh = sheet_(DATA_SHEET);
    var r = findTargetRow_(sh);
    copyRowFormat_(sh, r);
    sh.getRange(r, 1, 1, 6).setValues([[livreur, colis, dRec, dEnv, note, statut]]);
    sh.getRange(r, 3, 1, 2).setNumberFormat('yyyy"-"mmmm"-"dd');
    sh.getRange(r, 7)
      .setFormula('=IF(OR($A' + r + '="",$C' + r + '="",$D' + r + '=""),"",INT($C' + r + ')-INT($D' + r + '))')
      .setNumberFormat('0" j"');
    var h = sh.getRange(r, 8);
    if (h.getValue() !== true && h.getValue() !== false) h.insertCheckboxes();
    h.setValue(false);
    setPhotosCell_(sh.getRange(r, 9), links, who);
    SpreadsheetApp.flush();

    remember_('op_' + opId, { row: r, delai: delai, links: links });
    return { row: r, delai: delai, photoLinks: links, duplicate: false };
  });
}

/* ============================== 2) SCAN RETOURS (Gestion Roteur) ============================== */

function normTracking_(s) {
  return String(s == null ? '' : s).replace(/[\r\n\t ]+/g, '').toUpperCase();
}

var MONTHS_ = { jan: 0, feb: 1, fev: 1, mar: 2, apr: 3, avr: 3, may: 4, mai: 4, jun: 5, jui: 6, jul: 6, aug: 7, aou: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** Valeur de la colonne "La Date" → timestamp (ou 0). */
function cellTime_(v) {
  if (v instanceof Date) return v.getTime();
  var s = String(v || '').trim();
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
  m = /^(\d{4})-([A-Za-zéû]{3})[a-zéû]*-(\d{1,2})$/.exec(s);
  if (m && MONTHS_[m[2].toLowerCase()] != null) return new Date(Number(m[1]), MONTHS_[m[2].toLowerCase()], Number(m[3])).getTime();
  return 0;
}

/**
 * Ajoute un tracking dans "Gestion Roteur".
 * Place : la paire (Traking / La Date) qui contient le scan le plus récent,
 *         première case vide en dessous de ce dernier scan.
 */
function scan_(req) {
  var tracking = normTracking_(req.tracking);
  if (!tracking || tracking.length < 4) throw new AppError('Tracking invalide.');
  var scanId = String(req.scanId || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(scanId)) throw new AppError('Identifiant de scan invalide.');
  var at = req.at ? new Date(req.at) : new Date();
  if (isNaN(at.getTime())) at = new Date();

  return withLock_(function () {
    var prev = seen_('sc_' + scanId);
    if (prev) return { tracking: tracking, cell: prev.cell, already: true };

    var sh = sheet_(RETOUR_SHEET);
    var lastCol = sh.getLastColumn();
    var header = sh.getRange(RETOUR_HEADER_ROW, 1, 1, lastCol).getDisplayValues()[0];
    var pairs = [];                                   // colonnes (1-based) "Traking"
    for (var c = 0; c < header.length - 1; c++) {
      if (/^trac?king$/i.test(String(header[c]).trim())) pairs.push(c + 1);
    }
    if (!pairs.length) throw new Error('Colonnes "Traking" introuvables dans "' + RETOUR_SHEET + '".');

    var lastRow = Math.max(sh.getLastRow(), RETOUR_FIRST_ROW);
    var n = lastRow - RETOUR_FIRST_ROW + 1;
    var vals = sh.getRange(RETOUR_FIRST_ROW, 1, n, lastCol).getValues();

    // 1) Doublon ?
    if (!req.force) {
      for (var i = 0; i < n; i++) {
        for (var p = 0; p < pairs.length; p++) {
          if (normTracking_(vals[i][pairs[p] - 1]) === tracking) {
            return { tracking: tracking, duplicate: true, where: colLetter_(pairs[p]) + (RETOUR_FIRST_ROW + i) };
          }
        }
      }
    }

    // 2) Dernier scan (date la plus récente) → paire + ligne
    var best = { t: -1, pair: pairs[0], idx: -1 };
    for (var p2 = 0; p2 < pairs.length; p2++) {
      for (var j = 0; j < n; j++) {
        if (String(vals[j][pairs[p2] - 1]).trim() === '') continue;
        var t = cellTime_(vals[j][pairs[p2]]);
        if (t >= best.t) best = { t: t, pair: pairs[p2], idx: j };
      }
    }

    // 3) Première case vide (Traking ET Date vides) sous le dernier scan
    var col = best.pair;
    var idx = best.idx + 1;
    while (idx < n && (String(vals[idx][col - 1]).trim() !== '' || String(vals[idx][col]).trim() !== '')) idx++;
    var row = RETOUR_FIRST_ROW + idx;
    if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 100);

    sh.getRange(row, col).setNumberFormat('@').setValue(tracking);
    sh.getRange(row, col + 1).setValue(at).setNumberFormat('dd/MM/yyyy');
    SpreadsheetApp.flush();

    var cell = colLetter_(col) + row;
    remember_('sc_' + scanId, { cell: cell });
    return { tracking: tracking, cell: cell, duplicate: false };
  });
}

/* ============================== 3) RETOURS EN ATTENTE (annoncés dans WhatsApp) ============================== */

function pendingSheet_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName(PENDING_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(PENDING_SHEET);
  sh.getRange(1, 1, 1, PENDING_HEADER.length).setValues([PENDING_HEADER])
    .setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#6E2B92').setHorizontalAlignment('center');
  sh.setFrozenRows(1);
  sh.setColumnWidths(1, PENDING_HEADER.length, 130);
  sh.setColumnWidth(6, 260);
  sh.hideColumns(10);
  return sh;
}

function addPending_(req) {
  var pid = String(req.pid || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(pid)) throw new AppError('Identifiant invalide.');
  var livreur = String(req.livreur || '').trim();
  if (!livreur) throw new AppError('Choisissez la ville / le livreur.');
  var colis = Number(req.colis);
  if (!(colis > 0) || Math.floor(colis) !== colis) throw new AppError('Le nombre de colis doit être un nombre entier positif.');
  var d = parseIsoDate_(req.date, 'Date');
  var note = String(req.note || '').trim().slice(0, 1000);
  var who = String(req.who || '').trim().slice(0, 30);
  var photos = Array.isArray(req.photos) ? req.photos.slice(0, MAX_PHOTOS) : [];
  var files = Array.isArray(req.files) ? req.files.slice(0, 5) : [];

  return withLock_(function () {
    var prev = seen_('pd_' + pid);
    if (prev) return { row: prev.row, duplicate: true };
    var links = [];
    if (photos.length) {
      var folder = monthFolder_(d);
      var base = 'ATTENTE_' + Utilities.formatDate(d, TZ, 'yyyy-MM-dd') + '_' + livreur.replace(/[^\w-]+/g, '_') + '_' + pid.slice(0, 8);
      photos.forEach(function (ph, i) {
        if (!ph || !ph.b64) return;
        var file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(ph.b64), 'image/jpeg', base + '_' + (i + 1) + '.jpg'));
        try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
        links.push('https://drive.google.com/file/d/' + file.getId() + '/view');
      });
    }
    // Bons (PDF…) → Drive
    var docs = [];
    files.forEach(function (f) {
      if (!f || !f.b64) return;
      var name = String(f.name || 'bon.pdf').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
      var mime = String(f.mime || 'application/pdf');
      var file = monthFolder_(d).createFile(Utilities.newBlob(Utilities.base64Decode(f.b64), mime, name));
      try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
      docs.push({ name: name, url: 'https://drive.google.com/file/d/' + file.getId() + '/view' });
    });
    var sh = pendingSheet_();
    var r = sh.getLastRow() + 1;
    sh.getRange(r, 1, 1, PENDING_HEADER.length).setValues([[d, livreur, colis, 'En attente', '', note, '', '', who, pid]]);
    if (docs.length) {
      var txt = '', runs = [];
      docs.forEach(function (doc, i) {
        if (i) txt += '\n';
        var label = '📄 ' + doc.name;
        runs.push([txt.length, txt.length + label.length, doc.url]);
        txt += label;
      });
      var rb = SpreadsheetApp.newRichTextValue().setText(txt);
      runs.forEach(function (x) { rb.setLinkUrl(x[0], x[1], x[2]); });
      sh.getRange(r, 8).setRichTextValue(rb.build());
    }
    sh.getRange(r, 1).setNumberFormat('dd/MM/yyyy');
    sh.getRange(r, 4).setBackground('#FFF4E0').setFontColor('#B45309').setFontWeight('bold');
    setPhotosCell_(sh.getRange(r, 7), links, '');
    remember_('pd_' + pid, { row: r });
    return { row: r, duplicate: false, docs: docs.length };
  });
}

function listPending_() {
  var sh = pendingSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, PENDING_HEADER.length).getValues();
  var out = [];
  vals.forEach(function (v, i) {
    if (String(v[3]).trim().toLowerCase() !== 'en attente') return;
    out.push({
      row: i + 2, pid: String(v[9]), docs: String(v[7] || '').split('📄').length - 1, date: v[0] instanceof Date ? Utilities.formatDate(v[0], TZ, 'yyyy-MM-dd') : String(v[0]),
      livreur: String(v[1]), colis: Number(v[2]) || 0, note: String(v[5]), photos: String(v[6] || '').split('📷').length - 1
    });
  });
  return out.reverse();
}

function receivePending_(req) {
  return withLock_(function () {
    var sh = pendingSheet_();
    var r = Number(req.row);
    if (!(r >= 2)) throw new AppError('Ligne invalide.');
    var v = sh.getRange(r, 1, 1, PENDING_HEADER.length).getValues()[0];
    if (String(v[9]) !== String(req.pid || '')) throw new AppError('La feuille a changé. Actualisez la liste.', 'conflict');
    var dr = req.dateReception ? parseIsoDate_(req.dateReception, 'Date de réception') : new Date();
    sh.getRange(r, 4, 1, 2).setValues([['Reçu', dr]]);
    sh.getRange(r, 4).setBackground('#E7F7EE').setFontColor('#15803D');
    sh.getRange(r, 5).setNumberFormat('dd/MM/yyyy');
    return { row: r };
  });
}

/* ============================== OUTILS ============================== */

/** À lancer une fois depuis l'éditeur : donne les autorisations et vérifie tout. */
function setup() {
  var sh = sheet_(DATA_SHEET);
  Logger.log('Opérations → prochaine ligne : ' + findTargetRow_(sh));
  sheet_(RETOUR_SHEET);
  Logger.log('Onglet Gestion Roteur OK');
  pendingSheet_();
  Logger.log('Onglet Retours en attente OK');
  Logger.log('Dossier photos : ' + photoFolder_().getUrl());
}
