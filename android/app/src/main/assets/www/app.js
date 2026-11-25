/* SONICOD – interface de l'application (français) — sans compte, sans admin */
(function () {
  'use strict';

  var NATIVE = window.SonicodNative || null;
  var GROUP_LINK = 'https://chat.whatsapp.com/LP2gQjIm7R95AYBLIj27Ad';

  /* ================= outils ================= */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isoOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayIso() { return isoOf(new Date()); }
  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : (iso || '—');
  }
  function ic(name, cls) { return '<svg' + (cls ? ' class="' + cls + '"' : '') + '><use href="#i-' + name + '"/></svg>'; }
  function hhmm(isoTs) { var d = new Date(isoTs); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function localDay(isoTs) { return isoOf(new Date(isoTs)); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }
  function store(k, v) {
    try {
      if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null');
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { return null; }
  }
  function initials(s) { return String(s || '?').trim().slice(0, 2).toUpperCase(); }

  var toastTimer;
  function toast(msg, kind) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 3000);
  }

  /* ================= pont natif ================= */
  var cbs = {}, cbn = 0;
  window.__nativeCb = function (id, json) {
    var f = cbs[id]; delete cbs[id];
    if (f) { try { f(JSON.parse(json)); } catch (e) { f({ ok: false, error: 'Réponse illisible' }); } }
  };
  function nat(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve) {
      if (!NATIVE) { resolve({ ok: false, error: 'Disponible seulement dans l\'application Android.' }); return; }
      var id = 'c' + (++cbn);
      cbs[id] = resolve;
      NATIVE[method].apply(NATIVE, [id].concat(args));
    });
  }
  function info() {
    if (NATIVE) { try { return JSON.parse(NATIVE.getInfo()); } catch (e) {} }
    return { serverUrl: store('serverUrl') || '', name: store('name') || '', version: 'web', whatsapp: false,
      systemDark: !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) };
  }
  function feedback(ok) { if (NATIVE && NATIVE.feedback) NATIVE.feedback(!!ok); }

  /** Appel au script Google (la clé est ajoutée par l'application). */
  function api(action, data) {
    var body = Object.assign({ action: action }, data || {});
    if (NATIVE) return nat('api', JSON.stringify(body));
    return fetch(info().serverUrl, { method: 'POST', body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, network: true, error: 'Pas de connexion internet.' }; });
  }

  /* ================= thème clair / sombre ================= */
  function applyTheme() {
    var pref = store('theme') || 'auto';
    var dark = pref === 'dark' || (pref === 'auto' && info().systemDark);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    if (NATIVE && NATIVE.setDark) NATIVE.setDark(dark);
  }

  /* ================= état ================= */
  var state = {
    config: store('config') || {
      cities: ['Agadir', 'BENI MELAL', 'CASA', 'Chtouka', 'EL JADIDA', 'ERRACHIDIA', 'FES', 'IBEX SUD', 'MARRAEKCH', 'OUARZAZAT', 'OUJDA', 'RABAT', 'SAFI', 'Sud', 'TANGER', 'taroudant'],
      statuses: ['VALIDER', 'Attent Reclamation']
    },
    draft: null,
    last: null,
    route: 'op',
    history: [],
    scans: store('scans') || [],
    session: store('session') || [],
    rafale: store('rafale') !== false,
    scanning: false,
    sending: false
  };

  function newDraft() {
    return { opId: uuid(), livreur: '', colis: '', dateReception: todayIso(), dateEnvoi: '', note: '', statut: '', photos: [] };
  }

  function loadConfig() {
    return api('config').then(function (res) {
      if (res.ok) { state.config = res.data; store('config', res.data); }
      return state.config;
    });
  }

  /* ================= navigation ================= */
  var ROUTES = {};
  function go(route, params, opts) {
    opts = opts || {};
    if (!info().serverUrl && route !== 'settings') route = 'settings';
    if (!opts.replace && state.route && state.route !== route) state.history.push(state.route);
    if (state.history.length > 30) state.history.shift();
    state.route = route;
    state.params = params || {};
    closeSheet();
    render();
    window.scrollTo(0, 0);
  }
  function back() {
    if (!$('#sheetWrap').classList.contains('hidden')) { closeSheet(); return true; }
    if (state.route === 'op') return false;
    var prev = state.route === 'success' ? 'op' : (state.history.pop() || 'op');
    go(prev, {}, { replace: true });
    return true;
  }
  window.sonicodBack = back;
  window.sonicodResume = function () { applyTheme(); refreshSyncPill(); retryScans(); if (window.sonicodShareReady) window.sonicodShareReady(); };

  function setHeader(title, sub) {
    $('#topTitle').textContent = title || '';
    $('#topSub').textContent = sub || '';
  }

  function render() {
    $$('#nav button').forEach(function (b) { b.classList.toggle('on', state.route === b.getAttribute('data-go')); });
    (ROUTES[state.route] || ROUTES.op)(state.params || {});
    refreshSyncPill();
  }

  function view(html) { $('#view').innerHTML = html; }

  /* ================= feuille modale ================= */
  function openSheet(html) {
    $('#sheet').innerHTML = html;
    $('#sheetWrap').classList.remove('hidden');
    return $('#sheet');
  }
  function closeSheet() { $('#sheetWrap').classList.add('hidden'); $('#sheet').innerHTML = ''; }
  function confirmBox(title, text, okLabel) {
    return new Promise(function (resolve) {
      var s = openSheet('<h2>' + esc(title) + '</h2><p class="muted">' + esc(text) + '</p>' +
        '<button class="btn btn-primary" id="cOk">' + esc(okLabel || 'Confirmer') + '</button>' +
        '<button class="btn btn-outline" id="cNo">Annuler</button>');
      $('#cOk', s).onclick = function () { closeSheet(); resolve(true); };
      $('#cNo', s).onclick = function () { closeSheet(); resolve(false); };
    });
  }
  function promptBox(title, placeholder) {
    return new Promise(function (resolve) {
      var s = openSheet('<h2>' + esc(title) + '</h2><div class="field"><input class="input" id="pV" placeholder="' + esc(placeholder || '') + '"></div>' +
        '<button class="btn btn-primary" id="pOk">Ajouter</button><button class="btn btn-outline" id="pNo">Annuler</button>');
      setTimeout(function () { var i = $('#pV', s); if (i) i.focus(); }, 100);
      $('#pOk', s).onclick = function () { var v = $('#pV', s).value.trim(); closeSheet(); resolve(v || null); };
      $('#pNo', s).onclick = function () { closeSheet(); resolve(null); };
    });
  }

  /* ================= attente de synchro ================= */
  function opQueue() {
    if (!NATIVE) return [];
    try { return JSON.parse(NATIVE.queue()); } catch (e) { return []; }
  }
  function pendingScans() { return state.scans.filter(function (s) { return s.status === 'wait'; }); }
  function refreshSyncPill() {
    var n = opQueue().length + pendingScans().length;
    var p = $('#syncPill');
    p.classList.toggle('hidden', !n);
    p.textContent = '⟳ ' + n + ' en attente';
  }

  /* ================= NOUVELLE OPÉRATION ================= */
  ROUTES.op = function () {
    setHeader('Nouvelle opération', 'Remplissez puis appuyez sur ENVOYER');
    if (!state.draft) state.draft = newDraft();
    var d = state.draft, c = state.config;
    var cities = c.cities.slice();
    if (d.livreur && cities.indexOf(d.livreur) < 0) cities.unshift(d.livreur);
    var q = opQueue().length;
    view(
      (q ? '<div class="note">' + q + ' opération(s) en attente d\'internet – envoi automatique.</div>' : '') +
      '<div class="card"><div class="sec"><span class="num">1</span><b>Destination</b></div>' +
      '<div class="field" id="f-livreur"><label>Ville / Livreur</label><select class="input" id="livreur"><option value="">Choisir…</option>' +
      cities.map(function (x) { return '<option' + (x === d.livreur ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') +
      '<option value="__add">＋ Autre ville…</option></select></div>' +
      '<div class="field" id="f-colis"><label>Nombre de colis scannés</label><input class="input" id="colis" type="number" inputmode="numeric" pattern="[0-9]*" min="1" step="1" placeholder="Ex : 134" value="' + esc(d.colis) + '"></div>' +
      '</div>' +
      '<div class="card"><div class="sec"><span class="num">2</span><b>Dates</b></div><div class="row2">' +
      '<div class="field" id="f-dateReception"><label>Réception (scan)</label><input class="input" id="dateReception" type="date" value="' + esc(d.dateReception) + '"></div>' +
      '<div class="field" id="f-dateEnvoi"><label>Date d\'envoi</label><input class="input" id="dateEnvoi" type="date" value="' + esc(d.dateEnvoi) + '"></div>' +
      '</div></div>' +
      '<div class="card"><div class="sec"><span class="num">3</span><b>Statut &amp; note</b></div>' +
      '<div class="field" id="f-statut"><div class="seg" id="statuts">' +
      c.statuses.map(function (s) {
        var k = /^valid/i.test(s) ? 'ok' : (/reclam/i.test(s) ? 'wait' : '');
        return '<button type="button" class="seg-btn ' + k + (s === d.statut ? ' on' : '') + '" data-s="' + esc(s) + '"><i></i>' + esc(s) + '</button>';
      }).join('') + '</div></div>' +
      '<div class="field"><label>Note <span class="opt">(facultatif)</span></label><textarea class="input" id="note" placeholder="Ex : KHASSA COLI DYAL 23 NOVEMBRE">' + esc(d.note) + '</textarea></div>' +
      '</div>' +
      '<div class="card"><div class="sec"><span class="num">4</span><b>Photos</b><small id="phCount"></small></div>' +
      '<div class="photo-btns"><button type="button" class="pbtn" id="cam">' + ic('cam') + 'Prendre une photo</button><button type="button" class="pbtn" id="gal">' + ic('img') + 'Choisir une photo</button></div>' +
      '<div class="photos" id="photos"></div></div>' +
      '<button class="btn btn-primary" id="send">' + ic('send') + 'ENVOYER</button>'
    );
    renderPhotos();

    var sync = function () {
      var lv = $('#livreur').value;
      if (lv !== '__add') d.livreur = lv;
      d.colis = $('#colis').value.trim();
      d.dateReception = $('#dateReception').value; d.dateEnvoi = $('#dateEnvoi').value; d.note = $('#note').value;
    };
    $$('#view input, #view select, #view textarea').forEach(function (el) {
      el.addEventListener('input', function () { sync(); var f = el.closest('.field'); if (f) clearErr(f); });
      el.addEventListener('change', sync);
    });
    $('#livreur').addEventListener('change', function () {
      if ($('#livreur').value !== '__add') return;
      $('#livreur').value = d.livreur || '';
      promptBox('Nouvelle ville / livreur', 'Ex : TIZNIT').then(function (v) {
        if (!v) return;
        d.livreur = v;
        if (state.config.cities.indexOf(v) < 0) state.config.cities.push(v);
        store('config', state.config);
        render();
        api('addCity', { city: v }).then(function (r) { if (r.ok) { state.config = r.data; store('config', r.data); } });
      });
    });
    $$('#statuts .seg-btn').forEach(function (b) {
      b.onclick = function () {
        d.statut = b.getAttribute('data-s');
        $$('#statuts .seg-btn').forEach(function (x) { x.classList.toggle('on', x === b); });
        clearErr($('#f-statut'));
      };
    });
    $('#cam').onclick = function () { addPhotos('takePhoto'); };
    $('#gal').onclick = function () { addPhotos('pickPhotos'); };
    $('#send').onclick = function () { sync(); submitOp(); };
  };

  function renderPhotos() {
    var d = state.draft, box = $('#photos');
    if (!box) return;
    $('#phCount').textContent = d.photos.length ? d.photos.length + ' photo(s)' : 'facultatif';
    box.innerHTML = d.photos.map(function (p, i) {
      return '<div class="ph"><img src="' + esc(p.thumb) + '" alt=""><span class="n">' + (i + 1) + '</span><button type="button" class="x" data-i="' + i + '">✕</button></div>';
    }).join('');
    $$('.x', box).forEach(function (b) {
      b.onclick = function () {
        var p = d.photos.splice(Number(b.getAttribute('data-i')), 1)[0];
        if (p && NATIVE) NATIVE.deletePhoto(p.id);
        renderPhotos();
      };
    });
  }

  function addPhotos(method) {
    var d = state.draft;
    if (d.photos.length >= 10) { toast('Maximum 10 photos par opération', 'err'); return; }
    nat(method).then(function (res) {
      if (!res.ok) { toast(res.error || 'Erreur photo', 'err'); return; }
      (res.photos || []).forEach(function (p) { if (d.photos.length < 10) d.photos.push(p); });
      renderPhotos();
    });
  }

  function setErr(id, msg) {
    var f = $('#f-' + id); if (!f) return;
    f.classList.add('err');
    var m = $('.msg', f); if (!m) { m = document.createElement('div'); m.className = 'msg'; f.appendChild(m); }
    m.textContent = msg;
  }
  function clearErr(f) { f.classList.remove('err'); var m = $('.msg', f); if (m) m.remove(); }

  function validate(d) {
    var errs = {};
    if (!d.livreur) errs.livreur = 'Choisissez la ville / le livreur.';
    if (!/^\d+$/.test(d.colis) || Number(d.colis) <= 0) errs.colis = 'Entrez un nombre entier positif.';
    if (!d.dateReception) errs.dateReception = 'Choisissez la date de réception.';
    if (!d.dateEnvoi) errs.dateEnvoi = 'Choisissez la date d\'envoi.';
    if (d.dateReception && d.dateEnvoi && d.dateEnvoi > d.dateReception) errs.dateEnvoi = 'La date d\'envoi doit être avant la réception.';
    if (!d.statut) errs.statut = 'Choisissez le statut.';
    return errs;
  }

  function submitOp() {
    var d = state.draft;
    var errs = validate(d);
    var keys = Object.keys(errs);
    keys.forEach(function (k) { setErr(k, errs[k]); });
    if (keys.length) {
      toast('Vérifiez les champs en rouge', 'err');
      var f = $('#f-' + keys[0]); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    var op = { opId: d.opId, livreur: d.livreur, colis: Number(d.colis), dateReception: d.dateReception, dateEnvoi: d.dateEnvoi, note: d.note.trim(), statut: d.statut };
    var ids = d.photos.map(function (p) { return p.id; });
    var b = $('#send');
    b.disabled = true;
    b.innerHTML = '<i class="spin"></i> ' + (ids.length ? 'Enregistrement et envoi des photos…' : 'Enregistrement…');
    // On passe tout de suite à l'écran WhatsApp ; l'enregistrement continue en arrière-plan.
    var L = { op: op, photoIds: ids, pending: true, queued: false, data: null, draft: d };
    state.last = L;
    state.draft = null;
    go('success', {}, { replace: true });
    nat('submit', JSON.stringify(op), JSON.stringify(ids)).then(function (res) {
      L.pending = false;
      if (!res.ok) { L.error = res.error || 'Erreur'; }
      else { L.queued = !!res.queued; L.data = res.data || null; }
      if (state.route === 'success' && state.last === L) updateSaveStatus();
      else if (L.error) toast('Opération NON enregistrée : ' + L.error, 'err');
    });
  }

  /** Carte d'état de l'enregistrement (en cours / enregistrée / hors ligne / erreur). */
  function updateSaveStatus() {
    var L = state.last, el = $('#saveStatus');
    if (!L || !el) return;
    if (L.pending) {
      el.innerHTML = '<div class="success-ic run"><i class="spin"></i></div><b>Enregistrement dans Google Sheets…</b>' +
        '<p class="muted small">Vous pouvez déjà envoyer sur WhatsApp.' + (L.photoIds.length ? ' Les photos sont envoyées en arrière-plan.' : '') + '</p>';
      setHeader('Enregistrement…', L.op.livreur + ' · ' + L.op.colis + ' colis');
    } else if (L.error) {
      el.innerHTML = '<div class="success-ic err">!</div><b>Pas enregistrée</b><p class="small" style="color:var(--red)">' + esc(L.error) + '</p>' +
        '<button class="btn btn-primary" id="fixOp">Corriger l\'opération</button>';
      setHeader('Erreur', L.op.livreur);
      $('#fixOp').onclick = function () { state.draft = L.draft; state.draft.opId = uuid(); go('op', {}, { replace: true }); };
    } else if (L.queued) {
      el.innerHTML = '<div class="success-ic wait">' + ic('sync') + '</div><b>Pas de connexion internet</b><p class="muted small">Gardée sur le téléphone, envoi automatique dès le retour d\'internet.</p>';
      setHeader('Enregistrée hors ligne', L.op.livreur + ' · ' + L.op.colis + ' colis');
    } else {
      el.innerHTML = '<div class="success-ic">' + ic('check') + '</div><b>Enregistrée dans Google Sheets</b><p class="muted small">Ligne ' + esc(L.data && L.data.row) +
        (L.data && L.data.photoLinks && L.data.photoLinks.length ? ' · ' + L.data.photoLinks.length + ' photo(s) sauvegardée(s)' : '') + '</p>';
      setHeader('Opération enregistrée', L.op.livreur + ' · ' + L.op.colis + ' colis');
    }
  }

  function whatsappText(op) {
    return 'SONICOD – NOUVELLE OPÉRATION\n\n' +
      'Ville / Livreur: ' + op.livreur + '\n' +
      'Colis scannés: ' + op.colis + '\n' +
      'Date réception: ' + fmtDate(op.dateReception) + '\n' +
      'Date d\'envoi: ' + fmtDate(op.dateEnvoi) + '\n' +
      'Note: ' + (op.note || '—') + '\n' +
      'Statut: ' + op.statut;
  }

  /* ================= SUCCÈS + WHATSAPP ================= */
  ROUTES.success = function () {
    var L = state.last;
    if (!L) { go('op', {}, { replace: true }); return; }
    var text = whatsappText(L.op);
    setHeader('Opération', L.op.livreur + ' · ' + L.op.colis + ' colis');
    view(
      '<div class="card center" id="saveStatus"></div>' +
      '<div class="card"><div class="sec"><b>Message WhatsApp</b></div><div class="msgbox">' + esc(text) + '</div>' +
      (L.photoIds.length ? '<p class="small muted">+ ' + L.photoIds.length + ' photo(s) jointe(s)</p>' : '') + '</div>' +
      '<button class="btn btn-green" id="share">' + ic('wa') + 'Envoyer sur WhatsApp (photos + message)</button>' +
      '<div id="waNote"></div>' +
      '<div style="height:12px"></div>' +
      '<button class="btn btn-primary" id="again">' + ic('box') + ' Nouvelle opération</button>'
    );
    updateSaveStatus();
    $('#share').onclick = function () {
      if (!NATIVE) { toast('Disponible dans l\'application Android', 'err'); return; }
      var st = /^valid/i.test(L.op.statut) ? 'Retour validé' : (/reclam/i.test(L.op.statut) ? 'Attente réclamation' : L.op.statut);
      var line1 = L.op.livreur.toUpperCase() + ' · ' + L.op.colis + ' colis scannés';
      var line2 = st + ' · ' + fmtDate(L.op.dateReception);
      $('#share').disabled = true; $('#share').innerHTML = '<i class="spin"></i> Préparation des photos…';
      setTimeout(function () {
      var r = NATIVE.shareWhatsApp(text, JSON.stringify(L.photoIds), line1, line2);
      $('#share').disabled = false; $('#share').innerHTML = ic('wa') + 'Envoyer sur WhatsApp (photos + message)';
      $('#waNote').innerHTML = r === 'error'
        ? '<div class="note" style="margin-top:12px">Impossible d\'ouvrir le partage. Le message a été copié : ouvrez le groupe et collez-le.</div>'
        : '<div class="note info" style="margin-top:12px">' + (r === 'whatsapp' ? 'WhatsApp est ouvert.' : 'Choisissez WhatsApp dans la liste.') +
          ' Dans la liste « Envoyer à », choisissez le groupe <b>SONICOD</b> puis appuyez sur <b>Envoyer</b> ➤. Le message est aussi copié (à coller si besoin).</div>';
      }, 50);
    };
    $('#again').onclick = function () { go('op', {}, { replace: true }); };
  };

  /* ================= SCANNER RETOURS (Gestion Roteur) ================= */
  function saveScans() {
    if (state.scans.length > 300) state.scans = state.scans.slice(0, 300);
    store('scans', state.scans);
  }

  function normTracking(v) { return String(v || '').replace(/[\r\n\t ]+/g, '').toUpperCase(); }

  ROUTES.scan = function () {
    if (!state.lotPhotos) state.lotPhotos = store('lotPhotos') || [];
    if (!state.lotStart) state.lotStart = store('lotStart') || new Date().toISOString();
    if (store('lotStage') === 'photos') { photoStage(); return; }
    var n = sessionItems().length;
    setHeader('Scanner retours', 'Les colis vont directement dans Gestion Roteur');
    view(
      '<div class="steps"><span class="on">1 Scanner</span><i></i><span>2 Terminer ✓</span><i></i><span>3 Photos → groupe</span></div>' +
      '<button class="scan-btn" id="scanBtn">' + ic('scan') + '<span>SCANNER</span></button>' +
      '<div class="card" style="margin-top:14px">' +
      '<div class="sec"><b>Colis scannés</b><small><b class="big" id="sessN">' + n + '</b></small></div>' +
      '<div class="inrow" style="margin-bottom:6px"><input class="input mono" id="manual" placeholder="Saisie manuelle : N123456789" autocapitalize="characters" spellcheck="false" autocomplete="off"><button class="btn btn-primary btn-sm" id="manualB">OK</button></div>' +
      '<div class="list" id="scanList">' + scanListHtml() + '</div></div>' +
      '<button class="btn btn-finish" id="finishB"' + (n ? '' : ' disabled') + '>' + ic('check') + '<span id="finishT">TERMINER LE SCAN' + (n ? ' (' + n + ')' : '') + '</span></button>' +
      '<p class="small muted center" style="margin-top:8px">Après « Terminer », la caméra s\'ouvre pour photographier les colis.</p>'
    );
    $('#scanBtn').onclick = function () { scanLoop(); };
    $('#finishB').onclick = function () {
      if (!sessionItems().length) return;
      store('lotStage', 'photos');
      photoStage();
      setTimeout(function () { lotPhoto('takePhoto'); }, 300);      // la caméra s'ouvre directement
    };
    var m = $('#manual');
    var addManual = function () { var v = m.value; m.value = ''; if (normTracking(v)) addTracking(v); };
    $('#manualB').onclick = addManual;
    m.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); addManual(); } };
    bindScanList();
    retryScans();
  };

  /** Étape 3 : photos du lot puis envoi au groupe. */
  function photoStage() {
    var n = sessionItems().length;
    setHeader('Photos des colis', n + ' colis enregistrés dans Gestion Roteur');
    view(
      '<div class="steps"><span>1 Scanner</span><i></i><span>2 Terminer ✓</span><i></i><span class="on">3 Photos → groupe</span></div>' +
      '<div class="card"><div class="sec"><b>Photos des colis</b><small id="lotPhotosCount"></small></div>' +
      '<div class="photos" id="lotPhotos"></div>' +
      '<div class="photo-btns" style="margin-top:12px"><button type="button" class="pbtn" id="lotCam">' + ic('cam') + 'Prendre une photo</button><button type="button" class="pbtn" id="lotGal">' + ic('img') + 'Galerie</button></div></div>' +
      '<button class="btn btn-green" id="lotSend">' + ic('wa') + 'Envoyer au groupe WhatsApp</button>' +
      '<div id="lotOut"></div>' +
      '<button class="btn btn-outline" id="backScan">' + ic('scan') + 'Revenir au scan</button>'
    );
    redrawLotPhotos();
    $('#lotCam').onclick = function () { lotPhoto('takePhoto'); };
    $('#lotGal').onclick = function () { lotPhoto('pickPhotos'); };
    $('#lotSend').onclick = function () { sendLot(); };
    $('#backScan').onclick = function () { store('lotStage', 'scan'); render(); };
  }
  function redrawLotPhotos() {
    renderPhotoGrid(state.lotPhotos, '#lotPhotos', '#lotPhotosCount', function () { store('lotPhotos', state.lotPhotos); });
  }
  function lotPhoto(method) {
    addPhotosTo(state.lotPhotos, method, function () { store('lotPhotos', state.lotPhotos); redrawLotPhotos(); });
  }

  function scanListHtml() {
    var since = state.lotStart || '';
    var items = state.scans.filter(function (x) { return x.at >= since; }).slice(0, 80);
    if (!items.length) return '<div class="empty">Appuyez sur SCANNER pour commencer</div>';
    return items.map(function (s) {
      var badge, line;
      if (s.status === 'ok') { badge = '<span class="badge b-ok">✓ ' + esc(s.cell) + '</span>'; line = 'Ajouté dans Gestion Roteur'; }
      else if (s.status === 'dup') { badge = '<span class="badge b-err">Doublon</span>'; line = 'Déjà dans la feuille : ' + esc(s.where); }
      else if (s.status === 'wait') { badge = '<span class="badge b-wait">⟳ ' + (s.offline ? 'Hors ligne' : 'Envoi…') + '</span>'; line = s.offline ? 'Envoi dès le retour d\'internet' : 'Envoi vers Gestion Roteur'; }
      else { badge = '<span class="badge b-err">Erreur</span>'; line = esc(s.msg || ''); }
      return '<div class="item"><div class="main"><div class="t1 mono">' + esc(s.tracking) + ' ' + badge + '</div>' +
        '<div class="t2">' + hhmm(s.at) + ' · ' + line + '</div></div>' +
        (s.status === 'dup' || s.status === 'err' ? '<button class="btn btn-outline btn-sm" data-force="' + esc(s.id) + '">' + (s.status === 'dup' ? 'Ajouter' : 'Réessayer') + '</button>' : '') +
        '</div>';
    }).join('');
  }
  function refreshScanList() {
    var el = $('#scanList');
    if (el && state.route === 'scan') {
      el.innerHTML = scanListHtml(); bindScanList();
      var n = sessionItems().length;
      $('#sessN').textContent = n;
      $('#finishB').disabled = !n;
      $('#finishT').textContent = 'TERMINER LE SCAN' + (n ? ' (' + n + ')' : '');
    }
    refreshSyncPill();
  }
  function bindScanList() {
    $$('[data-force]').forEach(function (b) {
      b.onclick = function () {
        var s = state.scans.filter(function (x) { return x.id === b.getAttribute('data-force'); })[0];
        if (!s) return;
        var force = s.status === 'dup';
        var run = function () {
          s.id = uuid();
          s.status = 'wait'; s.force = force; addToSession(s); saveScans(); refreshScanList();
          pumpScans();
        };
        if (force) confirmBox('Ajouter quand même ?', s.tracking + ' existe déjà (' + s.where + '). Il sera ajouté une 2e fois.', 'Ajouter').then(function (ok) { if (ok) run(); });
        else run();
      };
    });
  }

  function flash(s) {
    var el = $('#scanBtn');
    if (!el) return;
    el.classList.remove('flash-ok', 'flash-dup');
    void el.offsetWidth;
    el.classList.add(s.status === 'dup' || s.status === 'err' ? 'flash-dup' : 'flash-ok');
  }

  function addTracking(raw) {
    var tracking = normTracking(raw);
    if (!tracking) return Promise.resolve(null);
    var s = { id: uuid(), tracking: tracking, at: new Date().toISOString(), status: 'wait' };
    // Déjà scanné sur ce téléphone (ajouté ou en attente) ?
    var mine = state.scans.filter(function (x) { return x.tracking === tracking && (x.status === 'ok' || x.status === 'wait'); })[0];
    if (mine) {
      s.status = 'dup'; s.where = mine.cell ? 'case ' + mine.cell : 'scan en attente';
      state.scans.unshift(s); saveScans(); refreshScanList(); feedback(false); flash(s);
      toast('⚠ Doublon : ' + tracking, 'err');
      return Promise.resolve(s);
    }
    state.scans.unshift(s); addToSession(s); saveScans(); refreshScanList();
    feedback(true); flash(s);
    pumpScans();                       // envoi au Sheet en arrière-plan (le scanner n'attend pas)
    return Promise.resolve(s);
  }

  /** File d'envoi : un scan après l'autre, sans bloquer l'écran. */
  function pumpScans() {
    if (state.sending) { state.again = true; return; }
    var s = state.scans.slice().reverse().filter(function (x) { return x.status === 'wait' && !x.offline; })[0];
    if (!s) { state.offlineMode = false; return; }
    state.sending = true;
    api('scan', { tracking: s.tracking, scanId: s.id, at: s.at, force: !!s.force }).then(function (r) {
      state.sending = false;
      applyScanResult(s, r);
      if (s.status === 'dup') { feedback(false); toast('⚠ Doublon : ' + s.tracking + ' (' + s.where + ')', 'err'); }
      else if (s.status === 'err') { feedback(false); toast(s.msg || 'Erreur', 'err'); }
      else if (r.network) {
        // pas d'internet : on garde tout, nouvel essai plus tard
        state.scans.forEach(function (x) { if (x.status === 'wait') x.offline = true; });
        saveScans(); refreshScanList();
        setTimeout(function () { state.scans.forEach(function (x) { delete x.offline; }); pumpScans(); }, 20000);
        return;
      }
      saveScans(); refreshScanList();
      pumpScans();
    });
  }

  function sessionItems() {
    return state.scans.filter(function (x) { return state.session.indexOf(x.id) >= 0 && (x.status === 'ok' || x.status === 'wait'); });
  }
  function addToSession(s) {
    if ((s.status === 'ok' || s.status === 'wait') && state.session.indexOf(s.id) < 0) {
      state.session.push(s.id); store('session', state.session);
    }
  }

  function applyScanResult(s, r) {
    if (r.ok && r.data.duplicate) { s.status = 'dup'; s.where = 'case ' + r.data.where; }
    else if (r.ok) { s.status = 'ok'; s.cell = r.data.cell; }
    else if (r.network) { s.status = 'wait'; }
    else { s.status = 'err'; s.msg = r.error; }
    delete s.force;
  }

  function sendScan(s) {
    return api('scan', { tracking: s.tracking, scanId: s.id, at: s.at, force: !!s.force }).then(function (r) {
      applyScanResult(s, r);
      if (s.status === 'ok') { feedback(true); toast('✓ ' + s.tracking + ' → ' + s.cell, 'ok'); }
      else if (s.status === 'dup') { feedback(false); toast('⚠ Doublon : ' + s.tracking + ' (' + s.where + ')', 'err'); }
      else if (s.status === 'wait') { feedback(true); toast('Hors ligne : scan gardé, envoi plus tard'); }
      else { feedback(false); toast(s.msg || 'Erreur', 'err'); }
      addToSession(s);
      saveScans(); refreshScanList(); flash(s);
      return s;
    });
  }

  /** Relance l'envoi des scans en attente. */
  function retryScans(manual) {
    state.scans.forEach(function (x) { delete x.offline; });
    if (manual && !pendingScans().length) toast('Rien en attente ✓', 'ok');
    pumpScans();
  }

  function scanLoop() {
    if (state.scanning) return;
    state.scanning = true;
    nat('scanBarcode').then(function (r) {
      state.scanning = false;
      if (!r.ok) {
        if (!r.cancelled) toast(r.error || 'Scanner indisponible – utilisez la saisie manuelle', 'err');
        return;
      }
      addTracking(r.value).then(function (s) {
        if (!s) return;
        // En continu : le scanner se rouvre, sauf doublon / erreur (l'agent doit voir l'alerte)
        if (state.rafale && state.route === 'scan' && (s.status === 'ok' || s.status === 'wait')) setTimeout(scanLoop, 400);
      });
    });
  }

  /* ================= LOT SCANNÉ → PHOTOS → GROUPE ================= */
  /** Envoie le lot scanné (photos avec bandeau + liste des trackings) sur WhatsApp. */
  function sendLot() {
    var items = sessionItems();
    var photos = state.lotPhotos || [];
    if (!items.length) { toast('Scannez d\'abord les colis', 'err'); return; }
    if (!photos.length) { toast('Prenez au moins une photo des colis', 'err'); return; }
    if (!NATIVE) { toast('Disponible dans l\'application Android', 'err'); return; }
    var n = items.length, date = todayIso();
    var trackings = items.map(function (x) { return x.tracking; }).reverse();
    var text = 'SONICOD – RETOURS SCANNÉS\n\nDate: ' + fmtDate(date) + '\nColis: ' + n + '\n\n' + trackings.join('\n');
    var b = $('#lotSend'); b.disabled = true; b.innerHTML = '<i class="spin"></i> Préparation des photos…';
    setTimeout(function () {
      var r = NATIVE.shareWhatsApp(text, JSON.stringify(photos.map(function (p) { return p.id; })),
        'RETOURS SCANNÉS · ' + n + ' colis', 'Gestion Roteur · ' + fmtDate(date));
      b.disabled = false; b.innerHTML = ic('wa') + 'Envoyer au groupe WhatsApp';
      $('#lotOut').innerHTML = '<div class="note info" style="margin-top:12px">' + (r === 'error'
        ? 'Impossible d\'ouvrir WhatsApp. Le message a été copié.'
        : 'Dans WhatsApp, choisissez le groupe puis appuyez sur <b>Envoyer</b> ➤.') + '</div>' +
        '<button class="btn btn-primary" id="lotNew">' + ic('check') + 'C\'est envoyé – nouveau scan</button>';
      $('#lotNew').onclick = function () {
        state.session = []; store('session', []);
        state.lotPhotos = []; store('lotPhotos', []);
        state.lotStart = new Date().toISOString(); store('lotStart', state.lotStart);
        store('lotStage', 'scan');
        render(); toast('Nouveau scan ✓', 'ok');
      };
    }, 50);
  }

  /** Grille de photos réutilisable (aperçu + suppression). */
  function renderPhotoGrid(list, boxSel, countSel, onChange) {
    var box = $(boxSel); if (!box) return;
    var cEl = $(countSel); if (cEl) cEl.textContent = list.length ? list.length + ' photo(s)' : '';
    box.innerHTML = list.map(function (p, i) {
      return '<div class="ph"><img src="' + esc(p.thumb) + '" alt=""><span class="n">' + (i + 1) + '</span><button type="button" class="x" data-i="' + i + '">✕</button></div>';
    }).join('');
    $$('.x', box).forEach(function (b) {
      b.onclick = function () {
        var p = list.splice(Number(b.getAttribute('data-i')), 1)[0];
        if (p && NATIVE) NATIVE.deletePhoto(p.id);
        if (onChange) onChange();
        renderPhotoGrid(list, boxSel, countSel, onChange);
      };
    });
  }
  function addPhotosTo(list, method, done) {
    if (list.length >= 10) { toast('Maximum 10 photos', 'err'); return; }
    nat(method).then(function (res) {
      if (!res.ok) { toast(res.error || 'Erreur photo', 'err'); return; }
      (res.photos || []).forEach(function (p) { if (list.length < 10) list.push(p); });
      done();
    });
  }

  /* ================= RETOURS EN ATTENTE (annoncés dans les groupes WhatsApp) ================= */
  function newPend() { return { pid: uuid(), livreur: '', colis: '', date: todayIso(), note: '', photos: [], files: [], shared: '' }; }
  function savePend() { store('pend', state.pend); }

  ROUTES.attente = function () {
    if (!state.pend) state.pend = store('pend') || newPend();
    if (!state.pendList) state.pendList = store('pendList') || [];
    var o = state.pend, c = state.config;
    var cities = c.cities.slice();
    if (o.livreur && cities.indexOf(o.livreur) < 0) cities.unshift(o.livreur);
    setHeader('Retours en attente', 'Annoncés dans les groupes WhatsApp');
    view(
      (o.shared ? '<div class="note info"><b>Reçu depuis WhatsApp</b><div class="share-box" style="margin:8px 0 0">' + esc(o.shared) + '</div></div>' : '') +
      '<div class="card"><div class="sec"><span class="num">＋</span><b>Nouveau retour annoncé</b></div>' +
      '<div class="field" id="f-pLivreur"><label>Ville / Livreur</label><select class="input" id="pLivreur"><option value="">Choisir…</option>' +
      cities.map(function (x) { return '<option' + (x === o.livreur ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') +
      '<option value="__add">＋ Autre ville…</option></select></div>' +
      '<div class="row2"><div class="field" id="f-pColis"><label>Colis</label><input class="input" id="pColis" type="number" inputmode="numeric" min="1" placeholder="Ex : 3" value="' + esc(o.colis) + '"></div>' +
      '<div class="field" id="f-pDate"><label>Date</label><input class="input" id="pDate" type="date" value="' + esc(o.date) + '"></div></div>' +
      '<div class="field"><label>Note <span class="opt">(facultatif)</span></label><textarea class="input" id="pNote" placeholder="Ex : BRV-2611…  /  2 sacs">' + esc(o.note) + '</textarea></div>' +
      '<div class="photo-btns"><button type="button" class="pbtn" id="pCam">' + ic('cam') + 'Photo</button><button type="button" class="pbtn" id="pGal">' + ic('img') + 'Galerie</button></div>' +
      '<div class="photos" id="pPhotos"></div>' +
      ((o.files || []).length ? '<div class="docs">' + o.files.map(function (f, i) { return '<div class="doc">📄 <span>' + esc(f.name) + '</span><button type="button" class="x2" data-doc="' + i + '">✕</button></div>'; }).join('') + '</div>' : '') +
      '<button class="btn btn-primary" id="pSave" style="margin-top:14px">' + ic('clock') + 'Enregistrer « En attente »</button></div>' +
      '<div class="card"><div class="sec"><b>Retours en attente</b><small><button class="btn btn-ghost btn-sm" id="pReload">' + ic('sync') + 'Actualiser</button></small></div>' +
      '<div class="list" id="pList">' + pendListHtml() + '</div></div>'
    );
    var redraw = function () { renderPhotoGrid(o.photos, '#pPhotos', '#none', savePend); };
    redraw();
    var sync = function () {
      var lv = $('#pLivreur').value; if (lv !== '__add') o.livreur = lv;
      o.colis = $('#pColis').value.trim(); o.date = $('#pDate').value; o.note = $('#pNote').value; savePend();
    };
    ['#pColis', '#pDate', '#pNote'].forEach(function (sel) { $(sel).addEventListener('input', function () { sync(); var f = $(sel).closest('.field'); if (f) clearErr(f); }); });
    $('#pLivreur').addEventListener('change', function () {
      if ($('#pLivreur').value !== '__add') { sync(); clearErr($('#f-pLivreur')); return; }
      $('#pLivreur').value = o.livreur || '';
      promptBox('Nouvelle ville / livreur', 'Ex : TIZNIT').then(function (v) {
        if (!v) return;
        o.livreur = v; savePend();
        if (state.config.cities.indexOf(v) < 0) state.config.cities.push(v);
        store('config', state.config); render();
        api('addCity', { city: v }).then(function (r) { if (r.ok) { state.config = r.data; store('config', r.data); } });
      });
    });
    $('#pCam').onclick = function () { addPhotosTo(o.photos, 'takePhoto', function () { savePend(); redraw(); }); };
    $('#pGal').onclick = function () { addPhotosTo(o.photos, 'pickPhotos', function () { savePend(); redraw(); }); };
    $('#pReload').onclick = function () { loadPending(true); };
    $$('[data-doc]').forEach(function (b) { b.onclick = function () { o.files.splice(Number(b.getAttribute('data-doc')), 1); savePend(); render(); }; });
    $('#pSave').onclick = function () { sync(); savePending(); };
    bindPendList();
    loadPending(false);
  };

  function pendListHtml() {
    var l = state.pendList || [];
    if (!l.length) return '<div class="empty">Aucun retour en attente</div>';
    return l.map(function (p, i) {
      return '<div class="item pend-item"><div class="av">' + esc(initials(p.livreur)) + '</div><div class="main">' +
        '<div class="t1">' + esc(p.livreur) + ' <span class="badge b-wait">' + p.colis + ' colis</span></div>' +
        '<div class="t2">' + esc(fmtDate(p.date)) + (p.photos ? ' · 📷 ' + p.photos : '') + (p.docs ? ' · 📄 ' + p.docs : '') + (p.note ? ' · ' + esc(p.note) : '') + '</div></div>' +
        '<button class="btn btn-recv btn-sm" data-recv="' + i + '">' + ic('check') + 'Reçu</button></div>';
    }).join('');
  }
  function bindPendList() {
    $$('[data-recv]').forEach(function (b) {
      b.onclick = function () {
        var p = state.pendList[Number(b.getAttribute('data-recv'))];
        if (!p) return;
        confirmBox('Retour reçu ?', p.livreur + ' · ' + p.colis + ' colis (annoncé le ' + fmtDate(p.date) + '). Il passera à « Reçu » et la Nouvelle opération sera pré-remplie.', 'Oui, reçu').then(function (ok) {
          if (!ok) return;
          b.disabled = true;
          api('receivePending', { row: p.row, pid: p.pid, dateReception: todayIso() }).then(function (r) {
            if (!r.ok) { b.disabled = false; toast(r.error || 'Erreur', 'err'); if (r.code === 'conflict') loadPending(true); return; }
            state.pendList = state.pendList.filter(function (x) { return x !== p; }); store('pendList', state.pendList);
            state.draft = newDraft();
            state.draft.livreur = p.livreur; state.draft.colis = String(p.colis);
            state.draft.dateEnvoi = p.date <= todayIso() ? p.date : ''; state.draft.note = p.note || '';
            go('op');
            toast('Complétez le statut puis ENVOYER', 'ok');
          });
        });
      };
    });
  }
  function loadPending(manual) {
    api('listPending').then(function (r) {
      if (!r.ok) { if (manual) toast(r.network ? 'Pas de connexion' : (r.error || 'Erreur'), 'err'); return; }
      state.pendList = r.data; store('pendList', r.data);
      var el = $('#pList');
      if (el && state.route === 'attente') { el.innerHTML = pendListHtml(); bindPendList(); }
      if (manual) toast('Liste à jour ✓', 'ok');
    });
  }
  function savePending() {
    var o = state.pend, errs = {};
    if (!o.livreur) errs.pLivreur = 'Choisissez la ville / le livreur.';
    if (!/^\d+$/.test(o.colis) || Number(o.colis) <= 0) errs.pColis = 'Nombre de colis ?';
    if (!o.date) errs.pDate = 'Date ?';
    var keys = Object.keys(errs);
    keys.forEach(function (k) { setErr(k, errs[k]); });
    if (keys.length) { toast('Vérifiez les champs en rouge', 'err'); return; }
    var body = { action: 'addPending', pid: o.pid, livreur: o.livreur, colis: Number(o.colis), date: o.date, note: o.note.trim() };
    var ids = o.photos.map(function (p) { return p.id; });
    var b = $('#pSave'); b.disabled = true; b.innerHTML = '<i class="spin"></i> Enregistrement…';
    var docs = (o.files || []).map(function (f) { return { id: f.id, name: f.name, mime: f.mime }; });
    var p = NATIVE ? nat('apiWithPhotos', JSON.stringify(body), JSON.stringify(ids), JSON.stringify(docs)) : api('addPending', body);
    p.then(function (r) {
      b.disabled = false; b.innerHTML = ic('clock') + 'Enregistrer « En attente »';
      if (!r.ok) { toast(r.error || 'Erreur', 'err'); return; }
      toast('✓ ' + o.livreur + ' · ' + o.colis + ' colis en attente' + (docs.length ? ' + bon PDF' : ''), 'ok');
      state.pendList.unshift({ row: r.data.row, pid: o.pid, livreur: o.livreur, colis: Number(o.colis), date: o.date, note: o.note.trim(), photos: ids.length, docs: docs.length });
      store('pendList', state.pendList);
      state.pend = newPend(); savePend();
      render();
      loadPending(false);
    });
  }

  /** Contenu partagé depuis WhatsApp → formulaire « En attente » pré-rempli. */
  function checkShared() {
    if (!NATIVE || !NATIVE.takeShared) return;
    var raw = NATIVE.takeShared();
    if (!raw) return;
    var sh; try { sh = JSON.parse(raw); } catch (e) { return; }
    var o = newPend();
    o.photos = (sh.photos || []).slice(0, 10);
    var text = String(sh.text || '').trim();
    o.files = (sh.files || []).filter(function (f) { return f && f.id; });
    var names = o.files.map(function (f) { return f.name; }).join(', ');
    o.shared = [text, names].filter(Boolean).join('\n');
    o.note = text.slice(0, 200) || names.replace(/\.pdf$/i, '');
    var m = /(\d{1,4})\s*(colis|coli|cols|kolis)/i.exec(text);
    if (m) o.colis = m[1];
    var low = text.toLowerCase();
    (state.config.cities || []).forEach(function (cty) { if (!o.livreur && low.indexOf(cty.toLowerCase()) >= 0) o.livreur = cty; });
    state.pend = o; savePend();
    go('attente');
    toast('Reçu depuis WhatsApp : complétez puis Enregistrer', 'ok');
  }
  window.sonicodShareReady = checkShared;

  /* ================= RETOUR SORTIES (photos → groupe WhatsApp) ================= */
  function newSortie() { return { date: todayIso(), note: '', photos: [], sent: false }; }

  ROUTES.sorties = function () {
    setHeader('Retour Sorties', 'Photos avec la date → Ramassage Sonicod');
    if (!state.sortie) state.sortie = newSortie();
    var o = state.sortie;
    view(
      '<div class="card"><div class="sec"><span class="num">1</span><b>Date</b></div>' +
      '<div class="field"><input class="input" id="soDate" type="date" value="' + esc(o.date) + '"></div></div>' +
      '<div class="card"><div class="sec"><span class="num">2</span><b>Photos</b><small id="soCount"></small></div>' +
      '<div class="photo-btns"><button type="button" class="pbtn" id="soCam">' + ic('cam') + 'Prendre une photo</button><button type="button" class="pbtn" id="soGal">' + ic('img') + 'Choisir une photo</button></div>' +
      '<div class="photos" id="soPhotos"></div></div>' +
      '<div class="card"><div class="sec"><span class="num">3</span><b>Note</b><small>facultatif</small></div>' +
      '<div class="field"><textarea class="input" id="soNote" placeholder="Ex : 3 sacs pour CASA">' + esc(o.note) + '</textarea></div></div>' +
      '<button class="btn btn-green" id="soSend">' + ic('wa') + 'Envoyer sur WhatsApp</button>' +
      '<div id="soNoteOut"></div>' +
      (o.sent ? '<button class="btn btn-ghost" id="soNew">Nouvelle sortie</button>' : '')
    );
    renderSortiePhotos();
    $('#soDate').onchange = $('#soDate').oninput = function () { o.date = this.value; };
    $('#soNote').oninput = function () { o.note = this.value; };
    $('#soCam').onclick = function () { addSortiePhotos('takePhoto'); };
    $('#soGal').onclick = function () { addSortiePhotos('pickPhotos'); };
    var nb = $('#soNew'); if (nb) nb.onclick = function () { state.sortie = newSortie(); render(); };
    $('#soSend').onclick = function () {
      if (!o.date) { toast('Choisissez la date', 'err'); return; }
      if (!o.photos.length) { toast('Ajoutez au moins une photo', 'err'); return; }
      if (!NATIVE) { toast('Disponible dans l\'application Android', 'err'); return; }
      var n = o.photos.length;
      var text = 'SONICOD – RETOUR SORTIES\n\nDate: ' + fmtDate(o.date) + '\nPhotos: ' + n + (o.note.trim() ? '\nNote: ' + o.note.trim() : '');
      var b = $('#soSend'); b.disabled = true; b.innerHTML = '<i class="spin"></i> Préparation des photos…';
      setTimeout(function () {
        var r = NATIVE.shareWhatsApp(text, JSON.stringify(o.photos.map(function (p) { return p.id; })),
          'RETOUR SORTIES · ' + fmtDate(o.date), 'SONICOD' + (o.note.trim() ? ' · ' + o.note.trim().slice(0, 40) : ''));
        b.disabled = false; b.innerHTML = ic('wa') + 'Envoyer sur WhatsApp';
        o.sent = true;
        $('#soNoteOut').innerHTML = '<div class="note info" style="margin-top:12px">' + (r === 'error'
          ? 'Impossible d\'ouvrir le partage. Le message a été copié.'
          : 'Dans la liste « Envoyer à », choisissez le groupe <b>Ramassage Sonicod</b> puis appuyez sur <b>Envoyer</b> ➤.') + '</div>' +
          '<button class="btn btn-ghost" id="soNew2">Nouvelle sortie</button>';
        $('#soNew2').onclick = function () { state.sortie = newSortie(); render(); };
      }, 50);
    };
  };

  function openGroup(url) {
    if (NATIVE && NATIVE.openWhatsAppLink) NATIVE.openWhatsAppLink(url); else window.open(url, '_blank');
  }

  function renderSortiePhotos() {
    var o = state.sortie, box = $('#soPhotos');
    if (!box) return;
    $('#soCount').textContent = o.photos.length ? o.photos.length + ' photo(s)' : '';
    box.innerHTML = o.photos.map(function (p, i) {
      return '<div class="ph"><img src="' + esc(p.thumb) + '" alt=""><span class="n">' + (i + 1) + '</span><button type="button" class="x" data-i="' + i + '">✕</button></div>';
    }).join('');
    $$('.x', box).forEach(function (b) {
      b.onclick = function () {
        var p = o.photos.splice(Number(b.getAttribute('data-i')), 1)[0];
        if (p && NATIVE) NATIVE.deletePhoto(p.id);
        renderSortiePhotos();
      };
    });
  }

  function addSortiePhotos(method) {
    var o = state.sortie;
    if (o.photos.length >= 10) { toast('Maximum 10 photos', 'err'); return; }
    nat(method).then(function (res) {
      if (!res.ok) { toast(res.error || 'Erreur photo', 'err'); return; }
      (res.photos || []).forEach(function (p) { if (o.photos.length < 10) o.photos.push(p); });
      o.sent = false;
      renderSortiePhotos();
    });
  }

  /* ================= PARAMÈTRES ================= */
  ROUTES.settings = function () {
    var inf = info();
    var first = !inf.serverUrl;
    setHeader(first ? 'Bienvenue' : 'Paramètres', first ? 'Une seule fois : collez l\'adresse du serveur' : 'SONICOD v' + inf.version);
    var theme = store('theme') || 'auto';
    var q = opQueue();
    view(
      '<div class="card"><label class="kv"><span><b>Scan en continu</b><br><span class="small muted">Le scanner se rouvre après chaque colis</span></span>' +
      '<span class="switch"><input type="checkbox" id="rafale"' + (state.rafale ? ' checked' : '') + '><span></span></span></label></div>' +
      '<div class="card"><div class="sec"><b>Apparence</b></div><div class="chips" id="themes">' +
      [['auto', '⚙ Auto'], ['light', '☀ Clair'], ['dark', '☾ Sombre']].map(function (t) {
        return '<button class="chip' + (t[0] === theme ? ' on' : '') + '" data-t="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</div></div>' +
      '<div class="card">' +
      '<div class="field"><label>Votre prénom <span class="opt">(facultatif – affiché à côté des photos)</span></label><input class="input" id="sName" value="' + esc(inf.name) + '" placeholder="Ex : Soufiane"></div>' +
      '<div class="field"><label>Adresse du serveur (Apps Script …/exec)</label><input class="input" id="sUrl" value="' + esc(inf.serverUrl) + '" placeholder="https://script.google.com/macros/s/…/exec" autocapitalize="none" spellcheck="false"></div>' +
      '<button class="btn btn-primary" id="sSave">Enregistrer</button></div>' +
      (q.length ? '<div class="card"><div class="sec"><b>Opérations en attente</b><small>' + q.length + '</small></div><div class="list">' + q.map(function (o) {
        return '<div class="item"><div class="av">' + esc(initials(o.livreur)) + '</div><div class="main"><div class="t1">' + esc(o.livreur) + ' · ' + esc(o.colis) + ' colis</div>' +
          '<div class="t2">' + esc(fmtDate(o.dateReception)) + ' · ' + o.photos + ' photo(s)</div>' +
          (o.lastError ? '<div class="t2" style="color:var(--red);white-space:normal">' + esc(o.lastError) + '</div>' : '') +
          '</div><button class="btn btn-danger btn-sm" data-del="' + esc(o.opId) + '">✕</button></div>';
      }).join('') + '</div><button class="btn btn-ghost" id="syncNow">⟳ Envoyer maintenant</button></div>' : '')
    );
    $('#rafale').onchange = function () { state.rafale = this.checked; store('rafale', state.rafale); };
    $$('#themes .chip').forEach(function (b) {
      b.onclick = function () { store('theme', b.getAttribute('data-t')); applyTheme(); render(); };
    });
    $('#sSave').onclick = function () {
      var url = $('#sUrl').value.trim(), name = $('#sName').value.trim();
      if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url)) { toast('Adresse du serveur invalide', 'err'); return; }
      if (NATIVE) { NATIVE.setServerUrl(url); NATIVE.setName(name); } else { store('serverUrl', url); store('name', name); }
      var b = $('#sSave'); b.disabled = true; b.innerHTML = '<i class="spin"></i> Vérification…';
      api('ping').then(function (r) {
        b.disabled = false; b.textContent = 'Enregistrer';
        if (r.ok) { toast('Connecté au Google Sheet ✓', 'ok'); loadConfig(); if (first) go('op', {}, { replace: true }); }
        else toast(r.network ? 'Enregistré (pas de connexion pour vérifier)' : (r.error || 'Serveur injoignable'), r.network ? '' : 'err');
      });
    };
    var sn = $('#syncNow');
    if (sn) sn.onclick = function () {
      sn.disabled = true; sn.innerHTML = '<i class="spin"></i> Envoi…';
      nat('syncNow').then(function (r) {
        toast(r.pending ? (r.network ? r.pending + ' opération(s) refusée(s) – voir l\'erreur' : 'Toujours pas de connexion') : 'Synchronisation terminée ✓', r.pending ? 'err' : 'ok');
        render();
      });
    };
    $$('[data-del]').forEach(function (b) {
      b.onclick = function () {
        confirmBox('Supprimer cette opération ?', 'Elle ne sera jamais envoyée dans Google Sheets.', 'Supprimer').then(function (ok) {
          if (ok) { NATIVE.removeQueued(b.getAttribute('data-del')); render(); }
        });
      };
    });
  };

  /* ================= démarrage ================= */
  applyTheme();
  if (window.matchMedia) {
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme); } catch (e) {}
  }
  $('#sheetBg').onclick = closeSheet;
  $$('#nav button').forEach(function (b) { b.onclick = function () { go(b.getAttribute('data-go')); }; });
  $('#syncPill').onclick = function () { go('settings'); };
  go('op', {}, { replace: true });
  if (info().serverUrl) { loadConfig(); retryScans(); }
  checkShared();
})();
