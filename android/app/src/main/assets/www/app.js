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
    var pal = store('pal') || 'sonicod';
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-pal', pal);
    var bars = { sonicod: dark ? ['#8E0F66', '#140E19'] : ['#B3127D', '#FFFFFF'], jaune: dark ? ['#000000', '#111114'] : ['#111013', '#FFFFFF'], violet: dark ? ['#1E1129', '#141019'] : ['#4A1D66', '#FFFFFF'] }[pal];
    if (NATIVE && NATIVE.setBars && bars) NATIVE.setBars(bars[0], bars[1]);
    else if (NATIVE && NATIVE.setDark) NATIVE.setDark(dark);
  }

  /* ================= état ================= */
  var state = {
    config: store('config') || {
      cities: ['Agadir', 'BENI MELAL', 'CASA', 'Chtouka', 'EL JADIDA', 'ERRACHIDIA', 'FES', 'IBEX SUD', 'MARRAEKCH', 'OUARZAZAT', 'OUJDA', 'RABAT', 'SAFI', 'Sud', 'TANGER', 'taroudant'],
      statuses: ['VALIDER', 'Attent Reclamation']
    },
    draft: store('draft'),
    last: null,
    route: 'op',
    history: [],
    scans: store('scans') || [],
    session: store('session') || [],
    rafale: store('rafale') !== false,
    scanning: false,
    sending: false
  };

  function saveDraft() { try { store('draft', state.draft); } catch (e) {} }
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
  /** Photo prise pendant qu'Android relançait l'application : on l'ajoute au formulaire en cours. */
  window.sonicodOrphans = function () {
    if (!NATIVE || !NATIVE.takeOrphans) return;
    var arr = []; try { arr = JSON.parse(NATIVE.takeOrphans()); } catch (e) {}
    if (!arr.length) return;
    if (store('lotStage') === 'photos') { state.lotPhotos = (store('lotPhotos') || []).concat(arr).slice(0, 10); store('lotPhotos', state.lotPhotos); }
    else { if (!state.draft) state.draft = newDraft(); state.draft.photos = state.draft.photos.concat(arr).slice(0, 10); saveDraft(); }
    render(); toast('Photo récupérée ✓', 'ok');
  };
  window.sonicodResume = function () { applyTheme(); refreshSyncPill(); retryScans(); if (state.route === 'bot') render(); };
  window.sonicodBotRefresh = function () { if (state.route === 'bot') render(); };
  /** Photos / bon PDF partagés depuis WhatsApp → écran « Partager ». */
  window.sonicodShareReady = function () {
    if (!NATIVE || !NATIVE.takeShared) return;
    var s = NATIVE.takeShared(); if (!s) return;
    try { state.share = JSON.parse(s); } catch (e) { return; }
    if (!(state.share.photos || []).length && !(state.share.files || []).length) { toast('Rien à importer', 'err'); return; }
    state.share.pid = ''; state.share.group = ''; state.share.livreur = ''; state.share.date = todayIso(); state.share.colis = ''; state.share.ocr = 'wait';
    go('partage');
  };

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
      saveDraft();
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
        d.statut = b.getAttribute('data-s'); saveDraft();
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
        saveDraft();
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
      saveDraft();
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
    state.draft = null; store('draft', null);
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
      el.innerHTML = '<div class="success-ic err">!</div><b>Pas enregistrée</b><p class="small" style="color:var(--bad)">' + esc(L.error) + '</p>' +
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
      (L.photoIds.length
        ? '<div class="card"><div class="sec"><b>Photos pour WhatsApp</b><small>' + L.photoIds.length + '</small></div>' +
          '<div class="photos">' + ((L.draft && L.draft.photos) || []).map(function (p, i) { return '<div class="ph"><img src="' + esc(p.thumb) + '" alt=""><span class="n">' + (i + 1) + '</span></div>'; }).join('') + '</div></div>'
        : '') +
      '<button class="btn btn-green" id="share">' + ic('wa') + 'Envoyer sur WhatsApp</button>' +
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
      var r = NATIVE.shareWhatsApp(L.photoIds.length ? '' : text, JSON.stringify(L.photoIds), line1, line2);
      $('#share').disabled = false; $('#share').innerHTML = ic('wa') + 'Envoyer sur WhatsApp';
      $('#waNote').innerHTML = r === 'error'
        ? '<div class="note" style="margin-top:12px">Impossible d\'ouvrir WhatsApp.</div>'
        : '<div class="note info" style="margin-top:12px">' + (r === 'whatsapp' ? 'WhatsApp est ouvert.' : 'Choisissez WhatsApp dans la liste.') +
          ' Choisissez le groupe <b>SONICOD</b> puis appuyez sur <b>Envoyer</b> ➤.</div>';
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
      var r = NATIVE.shareWhatsApp('', JSON.stringify(photos.map(function (p) { return p.id; })),
        'RETOURS SCANNÉS · ' + n + ' colis', 'Gestion Roteur · ' + fmtDate(date));
      b.disabled = false; b.innerHTML = ic('wa') + 'Envoyer au groupe WhatsApp';
      $('#lotOut').innerHTML = '<div class="note info" style="margin-top:12px">' + (r === 'error'
        ? 'Impossible d\'ouvrir WhatsApp.'
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
    if (!state.pendList) state.pendList = store('pendList') || [];
    var w = state.pendList.filter(function (p) { return p.statut !== 'VALIDER'; }).length;
    setHeader('Retours des groupes', w ? w + ' en attente · ajoutés par le bot WhatsApp' : 'Ajoutés automatiquement par le bot WhatsApp');
    var bs = botStatus();
    var botOn = bs && bs.enabled && bs.notif && bs.files;
    view(
      (bs ? '<button class="botbar ' + (botOn ? 'on' : 'off') + '" id="goBot"><span class="dot"></span><span class="bt"><b>Bot WhatsApp du téléphone</b><br><small>' +
        (botOn ? 'Actif · ' + Object.keys(bs.groups || {}).length + ' groupe(s) suivis' : 'Inactif – appuyez pour l\'activer') + '</small></span>' + ic('gear') + '</button>' : '') +
      '<div class="sec" style="margin:0 2px 10px"><b>Par groupe et par jour</b><small><button class="btn btn-ghost btn-sm" id="pReload">' + ic('sync') + 'Actualiser</button></small></div>' +
      '<div id="pList">' + pendListHtml() + '</div>'
    );
    $('#pReload').onclick = function () { loadPending(true); };
    var gb = $('#goBot'); if (gb) gb.onclick = function () { go('bot'); };
    bindPendList();
    loadPending(false);
  };

  function driveId(url) { var m = /[-\w]{25,}/.exec(String(url || '')); return m ? m[0] : ''; }
  function daysBetween(a, b) {
    var x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a || ''), y = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b || '');
    if (!x || !y) return null;
    return Math.round((Date.UTC(+y[1], +y[2] - 1, +y[3]) - Date.UTC(+x[1], +x[2] - 1, +x[3])) / 86400000);
  }
  /** Retard : depuis la date du groupe jusqu'à aujourd'hui (ou jusqu'à la validation). */
  function retardHtml(p) {
    var waiting = p.statut !== 'VALIDER';
    var n = daysBetween(p.date, waiting ? todayIso() : (p.dateValidation || ''));
    if (n == null) return '';
    if (!waiting) return '<span class="ret ret-ok">✓ validé en ' + (n <= 0 ? 'le jour même' : n + ' jour' + (n > 1 ? 's' : '')) + '</span>';
    var cls = n >= 3 ? 'ret-late' : (n >= 1 ? 'ret-warn' : 'ret-ok');
    return '<span class="ret ' + cls + '">⏱ ' + (n <= 0 ? 'Aujourd\'hui' : n + ' jour' + (n > 1 ? 's' : '') + ' de retard') + '</span>';
  }
  function pendItemHtml(p, i) {
    var waiting = p.statut !== 'VALIDER';
    var thumbs = (p.photoLinks || []).slice(0, 6).map(function (u) {
      return '<a href="#" class="pth" data-url="' + esc(u) + '"><img loading="lazy" src="https://drive.google.com/thumbnail?id=' + encodeURIComponent(driveId(u)) + '&sz=w200" alt=""></a>';
    }).join('');
    var docs = (p.docs || []).map(function (d) {
      return '<a href="#" class="pdoc" data-url="' + esc(d.url) + '">📄 ' + esc(String(d.label || 'Bon PDF').replace(/^📄\s*/, '')) + '</a>';
    }).join('');
    return '<div class="pend" data-pi="' + i + '">' +
      '<div class="pend-h"><div class="av">' + esc(initials(p.livreur)) + '</div><div class="main"><div class="t1">' + esc(p.livreur) +
      ' <span class="badge ' + (waiting ? 'b-wait' : 'b-ok') + '">' + (waiting ? 'En attente' : 'VALIDER') + '</span></div>' +
      '<div class="t2">' + (p.colis == null ? '?' : p.colis) + ' colis' + (p.commandes != null ? ' · ' + p.commandes + ' commande(s)' : '') + ' · ' + esc(fmtDate(p.date)) + (p.dateValidation ? ' · validé le ' + esc(fmtDate(p.dateValidation)) : '') + '</div>' +
      '<div>' + retardHtml(p) + '</div>' +
      (p.note ? '<div class="t2">' + esc(p.note) + '</div>' : '') + '</div></div>' +
      (thumbs ? '<div class="pthumbs">' + thumbs + '</div>' : '') +
      (docs ? '<div class="pdocs">' + docs + '</div>' : '') +
      (waiting ? '<button class="btn btn-recv" data-recv="' + i + '">' + ic('check') + 'VALIDER</button>' : '') +
      '</div>';
  }
  function pendListHtml() {
    var l = state.pendList || [];
    var w = l.filter(function (p) { return p.statut !== 'VALIDER'; }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var v = l.filter(function (p) { return p.statut === 'VALIDER'; });
    var html = w.length ? w.map(function (p) { return pendItemHtml(p, l.indexOf(p)); }).join('') : '<div class="empty">Aucun retour en attente ✓</div>';
    if (v.length) html += '<details class="pvalid"><summary>Validés (7 derniers jours) · ' + v.length + '</summary>' + v.map(function (p) { return pendItemHtml(p, l.indexOf(p)); }).join('') + '</details>';
    return html;
  }
  function bindPendList() {
    $$('.pth, .pdoc').forEach(function (a) {
      a.onclick = function (e) { e.preventDefault(); var u = a.getAttribute('data-url'); if (NATIVE) NATIVE.openUrl(u); else window.open(u); };
    });
    $$('[data-recv]').forEach(function (b) {
      b.onclick = function () {
        var p = state.pendList[Number(b.getAttribute('data-recv'))];
        if (!p) return;
        var sh = openSheet('<h2>Valider ce retour ?</h2><p class="muted">' + esc(p.livreur) + ' · ' + p.colis + ' colis · ' + esc(fmtDate(p.date)) + '</p>' +
          '<button class="btn btn-recv" id="vOk">' + ic('check') + 'VALIDER</button>' +
          '<button class="btn btn-primary" id="vOp">' + ic('box') + 'VALIDER + Nouvelle opération</button>' +
          '<button class="btn btn-outline" id="vNo">Annuler</button>');
        var run = function (withOp) {
          closeSheet();
          b.disabled = true;
          api('receivePending', { row: p.row, pid: p.pid, dateReception: todayIso() }).then(function (r) {
            if (!r.ok) { b.disabled = false; toast(r.error || 'Erreur', 'err'); if (r.code === 'conflict') loadPending(true); return; }
            p.statut = 'VALIDER'; p.dateValidation = todayIso(); store('pendList', state.pendList);
            toast('✓ ' + p.livreur + ' validé', 'ok');
            var card = b.closest('.pend');
            if (card && !withOp) {
              card.style.height = card.offsetHeight + 'px';
              card.classList.add('leaving');
              setTimeout(function () { render(); }, 650);
              return;
            }
            if (withOp) {
              state.draft = newDraft();
              state.draft.livreur = p.livreur; state.draft.colis = String(p.colis);
              state.draft.dateEnvoi = p.date <= todayIso() ? p.date : ''; state.draft.note = p.note || '';
              go('op');
            } else render();
          });
        };
        $('#vOk', sh).onclick = function () { run(false); };
        $('#vOp', sh).onclick = function () { run(true); };
        $('#vNo', sh).onclick = closeSheet;
      };
    });
  }
  function loadPending(manual) {
    api('listPending').then(function (r) {
      if (!r.ok) { if (manual) toast(r.network ? 'Pas de connexion' : (r.error || 'Erreur'), 'err'); return; }
      state.pendList = r.data; store('pendList', r.data);
      var el = $('#pList');
      if (el && state.route === 'attente') {
        el.innerHTML = pendListHtml(); bindPendList();
        var w = r.data.filter(function (p) { return p.statut !== 'VALIDER'; }).length;
        setHeader('Retours des groupes', w ? w + ' en attente · ajoutés par le bot WhatsApp' : 'Ajoutés automatiquement par le bot WhatsApp');
      }
      if (manual) toast('Liste à jour ✓', 'ok');
    });
  }
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
        var r = NATIVE.shareWhatsApp('', JSON.stringify(o.photos.map(function (p) { return p.id; })),
          'RETOUR SORTIES · ' + fmtDate(o.date), 'SONICOD' + (o.note.trim() ? ' · ' + o.note.trim().slice(0, 40) : ''));
        b.disabled = false; b.innerHTML = ic('wa') + 'Envoyer sur WhatsApp';
        o.sent = true;
        $('#soNoteOut').innerHTML = '<div class="note info" style="margin-top:12px">' + (r === 'error'
          ? 'Impossible d\'ouvrir WhatsApp.'
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

  /* ================= BOT WHATSAPP DU TÉLÉPHONE ================= */
  function botStatus() {
    if (!NATIVE || !NATIVE.botStatus) return null;
    try { return JSON.parse(NATIVE.botStatus()); } catch (e) { return null; }
  }
  /** Même calcul que le bot Chrome : une seule ligne par groupe et par jour. */
  function jhash(str) { var h = 0; for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return Math.abs(h).toString(16); }
  function cityOptions(sel) {
    return '<option value="">Ville…</option>' + (state.config.cities || []).map(function (c) {
      return '<option' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
  }
  function pickCity(title) {
    return new Promise(function (resolve) {
      var s = openSheet('<h2>' + esc(title) + '</h2><p class="muted">Ce groupe correspond à quelle ville ?</p><div class="chips cities">' +
        (state.config.cities || []).map(function (c) { return '<button class="chip" data-c="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') +
        '</div><button class="btn btn-outline" id="pcNo">Annuler</button>');
      $$('[data-c]', s).forEach(function (b) { b.onclick = function () { closeSheet(); resolve(b.getAttribute('data-c')); }; });
      $('#pcNo', s).onclick = function () { closeSheet(); resolve(null); };
    });
  }

  ROUTES.bot = function () {
    var st = botStatus();
    setHeader('Bot WhatsApp', 'Photos + bon PDF + colis → Retours en attente');
    if (!st) { view('<div class="empty">Disponible dans l\'application Android.</div>'); return; }
    var groups = st.groups || {};
    var names = Object.keys(groups);
    var step = function (ok, n, title, sub, btn, id) {
      return '<div class="bstep ' + (ok ? 'ok' : '') + '"><span class="num">' + (ok ? '✓' : n) + '</span><div class="main"><b>' + title + '</b><br><span class="small muted">' + sub + '</span></div>' +
        (ok ? '' : '<button class="btn btn-primary btn-sm" id="' + id + '">' + btn + '</button>') + '</div>';
    };
    var last = st.lastRun ? new Date(st.lastRun) : null;
    var blocked = (st.blocked || []).slice();
    var sendersFree = [];
    (st.senders || []).forEach(function (x) {
      var num = String(x.u || '').replace(/^tel:/, '').replace(/@.*$/, '');
      var label = (x.n || '') + (/\d{8,}/.test(num.replace(/\D/g, '')) && (x.n || '').replace(/\D/g, '').slice(-9) !== num.replace(/\D/g, '').slice(-9) ? ' · ' + num : '');
      var key = /\d{8,}/.test(num.replace(/\D/g, '')) ? num : (x.n || '');
      if (!key || blocked.indexOf(key) >= 0 || sendersFree.some(function (y) { return y.key === key; })) return;
      sendersFree.push({ key: key, label: label || key });
    });
    view(
      '<div class="card"><div class="sec"><b>1 · Autorisations</b></div>' +
      step(st.notif, 1, 'Lire les notifications WhatsApp', 'Pour savoir quel groupe envoie une photo ou un PDF.', 'Activer', 'bNotif') +
      (!st.notif && st.sdk >= 33 ? '<div class="note info small">Si Android dit « Paramètre restreint » : <a href="#" id="bInfo">Infos de l\'appli</a> → ⋮ en haut → <b>Autoriser les paramètres restreints</b>, puis réessayez.</div>' : '') +
      step(st.files, 2, 'Choisir le dossier WhatsApp Business', 'Une seule fois. Android ouvre « com.whatsapp.w4b » : appuyez sur « Utiliser ce dossier » puis « Autoriser ».', 'Choisir', 'bFiles') +
      (st.files && !st.whatsappFolder ? '<div class="note err small">Dans ce dossier, « WhatsApp Business Images » est introuvable : appuyez à nouveau sur Choisir et prenez <b>Android › media › com.whatsapp.w4b</b>.</div><button class="btn btn-ghost btn-sm" id="bFiles2">Choisir à nouveau</button>' : '') +
      '<div class="note info small">Dans WhatsApp Business : <b>Paramètres → Stockage et données → Téléchargement auto</b> : cochez <b>Photos</b> et <b>Documents</b>. Ne mettez pas les groupes retour en silencieux.</div>' +
      '</div>' +
      '<div class="card"><label class="kv"><span><b>2 · Bot activé</b><br><span class="small muted">Envoi automatique quelques minutes après chaque photo</span></span>' +
      '<span class="switch"><input type="checkbox" id="bOn"' + (st.enabled ? ' checked' : '') + '><span></span></span></label></div>' +
      '<div class="card"><div class="sec"><b>3 · Mes groupes retour</b><small>' + names.length + '</small></div>' +
      (names.length ? '<div class="list">' + names.map(function (g, i) {
        return '<div class="item"><div class="av">' + esc(initials(groups[g])) + '</div><div class="main"><div class="t1">' + esc(g) + '</div>' +
          '<select class="input input-sm" data-gv="' + i + '">' + cityOptions(groups[g]) + '</select></div>' +
          '<button class="btn btn-danger btn-sm" data-gd="' + i + '">✕</button></div>';
      }).join('') + '</div>' : '<p class="muted small">Aucun groupe. Ajoutez-les ci-dessous.</p>') +
      (st.seen && st.seen.length ? '<div class="sec" style="margin-top:12px"><b>Groupes vus récemment</b><small>appuyez pour ajouter</small></div><div class="chips">' +
        st.seen.map(function (x, i) { return '<button class="chip" data-gs="' + i + '">＋ ' + esc(x.name) + '</button>'; }).join('') + '</div>'
        : '<p class="muted small" style="margin-top:8px">Les groupes qui vous envoient des messages apparaîtront ici.</p>') +
      '<button class="btn btn-ghost" id="bAdd">＋ Ajouter un groupe par son nom</button></div>' +
      '<div class="card"><div class="sec"><b>4 · Numéros à ignorer</b><small>' + (st.blocked || []).length + '</small></div>' +
      '<p class="muted small" style="margin-top:0">Les photos et PDF envoyés par ces numéros (ou noms) ne sont pas pris.</p>' +
      ((st.blocked || []).length ? '<div class="list">' + st.blocked.map(function (x, i) {
        return '<div class="item"><div class="av">🚫</div><div class="main"><div class="t1">' + esc(x) + '</div></div><button class="btn btn-danger btn-sm" data-bd="' + i + '">✕</button></div>';
      }).join('') + '</div>' : '') +
      '<div class="row2" style="margin-top:8px;grid-template-columns:1fr auto"><input class="input" id="bNum" inputmode="tel" placeholder="Ex : 0612345678 ou un nom"><button class="btn btn-primary btn-sm" id="bNumAdd">Ajouter</button></div>' +
      (sendersFree.length ? '<div class="sec" style="margin-top:12px"><b>Ont envoyé récemment</b><small>appuyez pour ignorer</small></div><div class="chips">' +
        sendersFree.map(function (x, i) { return '<button class="chip" data-sb="' + i + '">🚫 ' + esc(x.label) + '</button>'; }).join('') + '</div>' : '') +
      '</div>' +
      '<button class="btn btn-primary" id="bRun">' + ic('sync') + 'Lire maintenant</button>' +
      '<div class="card"><div class="sec"><b>Journal</b><small>' + (last ? 'dernier passage ' + pad(last.getHours()) + ':' + pad(last.getMinutes()) : '') +
      (st.waiting ? ' · ' + st.waiting + ' fichier(s) en attente de téléchargement' : '') + '</small></div>' +
      '<pre class="blog">' + esc((st.log || []).slice(-15).reverse().join('\n') || '—') + '</pre></div>'
    );
    var saveGroups = function () { NATIVE.botSetGroups(JSON.stringify(groups)); render(); };
    var addGroup = function (name) {
      if (!name) return;
      pickCity(name).then(function (c) { if (!c) return; groups[name] = c; saveGroups(); toast('Groupe ajouté ✓', 'ok'); });
    };
    var n1 = $('#bNotif'); if (n1) n1.onclick = function () { NATIVE.botOpenNotif(); };
    var n2 = $('#bFiles'); if (n2) n2.onclick = function () { NATIVE.botOpenFiles(); };
    var n2b = $('#bFiles2'); if (n2b) n2b.onclick = function () { NATIVE.botOpenFiles(); };
    var n3 = $('#bInfo'); if (n3) n3.onclick = function (e) { e.preventDefault(); NATIVE.botOpenAppInfo(); };
    $('#bOn').onchange = function () {
      if (this.checked && !names.length) { this.checked = false; toast('Ajoutez d\'abord un groupe retour', 'err'); return; }
      NATIVE.botSetEnabled(this.checked); toast(this.checked ? 'Bot activé ✓' : 'Bot arrêté', this.checked ? 'ok' : ''); render();
    };
    $$('[data-gv]').forEach(function (sel) { sel.onchange = function () { var g = names[+sel.getAttribute('data-gv')]; if (sel.value) { groups[g] = sel.value; saveGroups(); } }; });
    $$('[data-gd]').forEach(function (b) {
      b.onclick = function () { var g = names[+b.getAttribute('data-gd')]; confirmBox('Retirer ce groupe ?', g, 'Retirer').then(function (ok) { if (ok) { delete groups[g]; saveGroups(); } }); };
    });
    $$('[data-gs]').forEach(function (b) { b.onclick = function () { addGroup(st.seen[+b.getAttribute('data-gs')].name); }; });
    var saveBlocked = function () { NATIVE.botSetBlocked(JSON.stringify(blocked)); render(); };
    $('#bNumAdd').onclick = function () {
      var v = $('#bNum').value.trim(); if (!v) return;
      if (blocked.indexOf(v) < 0) blocked.push(v);
      saveBlocked(); toast('Ajouté : ses photos ne seront pas prises', 'ok');
    };
    $$('[data-bd]').forEach(function (b) { b.onclick = function () { blocked.splice(+b.getAttribute('data-bd'), 1); saveBlocked(); }; });
    $$('[data-sb]').forEach(function (b) { b.onclick = function () { var x = sendersFree[+b.getAttribute('data-sb')]; if (blocked.indexOf(x.key) < 0) blocked.push(x.key); saveBlocked(); toast('Ignoré : ' + x.label, 'ok'); }; });
    $('#bAdd').onclick = function () { promptBox('Nom exact du groupe WhatsApp', 'Ex : Retour CASA Sonicod').then(addGroup); };
    $('#bRun').onclick = function () {
      if (!st.files) { toast('Choisissez d\'abord le dossier WhatsApp Business', 'err'); return; }
      var b = this; b.disabled = true; b.innerHTML = '<i class="spin"></i> Lecture des groupes…';
      nat('botRun').then(function (r) {
        toast(r.ok ? (r.sent ? '✓ ' + r.sent + ' groupe(s) envoyé(s) au Sheet' : 'Rien de nouveau ✓') : (r.error || 'Erreur – voir le journal'), r.ok ? 'ok' : 'err');
        render();
      });
    };
  };

  /* ================= PARTAGER (WhatsApp → Gestion Retour) ================= */
  ROUTES.partage = function () {
    var sh = state.share;
    if (!sh) { go('attente', {}, { replace: true }); return; }
    setHeader('Retour d\'un groupe', 'Photos et bon reçus dans WhatsApp → En attente');
    var st = botStatus() || {};
    var groups = st.groups || {};
    var gnames = Object.keys(groups);
    view(
      '<div class="card"><div class="sec"><span class="num">1</span><b>Reçu</b><small>' + sh.photos.length + ' photo(s) · ' + sh.files.length + ' PDF</small></div>' +
      '<div class="photos">' + sh.photos.map(function (p, i) { return '<div class="ph"><img src="' + esc(p.thumb) + '" alt=""><span class="n">' + (i + 1) + '</span></div>'; }).join('') + '</div>' +
      (sh.files.length ? '<div class="pdocs">' + sh.files.map(function (f) { return '<span class="pdoc">📄 ' + esc(f.name) + '</span>'; }).join('') + '</div>' : '') + '</div>' +
      '<div class="card"><div class="sec"><span class="num">2</span><b>Groupe / ville</b></div>' +
      (gnames.length ? '<div class="chips" id="shG">' + gnames.map(function (g, i) {
        return '<button class="chip' + (sh.group === g ? ' on' : '') + '" data-sg="' + i + '">' + esc(g) + ' · ' + esc(groups[g]) + '</button>';
      }).join('') + '</div>' : '') +
      '<div class="field"><select class="input" id="shV">' + cityOptions(sh.livreur) + '</select></div></div>' +
      '<div class="card"><div class="sec"><span class="num">3</span><b>Date et colis</b></div>' +
      '<div class="row2"><div class="field"><label>Date</label><input class="input" type="date" id="shD" value="' + esc(sh.date) + '"></div>' +
      '<div class="field"><label>Colis <span class="opt" id="shO">' + (sh.ocr === 'wait' || sh.ocr === 'run' ? 'lecture…' : esc(sh.source || '')) + '</span></label>' +
      '<input class="input" type="number" min="1" inputmode="numeric" id="shC" value="' + esc(sh.colis) + '" placeholder="?"></div></div></div>' +
      '<button class="btn btn-recv" id="shSend">' + ic('check') + 'Envoyer dans « En attente »</button>' +
      '<button class="btn btn-ghost" id="shNo">Annuler</button>'
    );
    $$('[data-sg]').forEach(function (b) {
      b.onclick = function () { sh.group = gnames[+b.getAttribute('data-sg')]; sh.livreur = groups[sh.group]; render(); };
    });
    $('#shV').onchange = function () { sh.livreur = this.value; if (sh.group && groups[sh.group] !== sh.livreur) sh.group = ''; render(); };
    $('#shD').onchange = function () { sh.date = this.value; };
    $('#shC').oninput = function () { sh.colis = this.value; };
    $('#shNo').onclick = function () { state.share = null; go('attente', {}, { replace: true }); };
    if (sh.ocr === 'wait' && sh.photos.length && NATIVE && NATIVE.ocrPhotos) {
      sh.ocr = 'run';
      nat('ocrPhotos', JSON.stringify(sh.photos.map(function (p) { return p.id; }))).then(function (r) {
        sh.ocr = r.colis ? 'ok' : 'none';
        if (r.colis && !sh.colis) sh.colis = String(r.colis);
        sh.ocrColis = r.colis ? String(r.colis) : '';
        sh.commandes = r.commandes == null ? '' : r.commandes;
        sh.brvs = r.brvs || []; sh.source = r.source || '';
        if (state.route === 'partage' && state.share === sh) render();
      });
    } else if (sh.ocr === 'wait') sh.ocr = 'none';
    $('#shSend').onclick = function () {
      if (!sh.livreur) { toast('Choisissez le groupe ou la ville', 'err'); return; }
      if (!sh.date) { toast('Choisissez la date', 'err'); return; }
      var b = this; b.disabled = true; b.innerHTML = '<i class="spin"></i> Envoi au Sheet…';
      var pid = 'wa-' + jhash((sh.group || sh.livreur) + '|' + sh.date);
      var note = (sh.group || 'Partage WhatsApp') + (sh.source && String(sh.colis) === String(sh.ocrColis) ? ' · ' + sh.source : '') + (sh.brvs && sh.brvs.length ? ' · ' + sh.brvs.join(', ') : '');
      nat('apiWithPhotos', JSON.stringify({ action: 'addPending', pid: pid, livreur: sh.livreur, colis: sh.colis === '' ? '' : sh.colis, commandes: sh.commandes === undefined ? '' : sh.commandes, date: sh.date, note: note }),
        JSON.stringify(sh.photos.map(function (p) { return p.id; })), JSON.stringify(sh.files)).then(function (r) {
        if (!r.ok) { b.disabled = false; b.innerHTML = ic('check') + 'Envoyer dans « En attente »'; toast(r.error || 'Erreur', 'err'); return; }
        sh.photos.forEach(function (p) { NATIVE.deletePhoto(p.id); });
        state.share = null;
        toast(r.data && r.data.created ? '✓ Ajouté dans En attente' : '✓ Ajouté au retour du jour', 'ok');
        go('attente', {}, { replace: true });
        loadPending(false);
      });
    };
  };

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
      (info().bot ? '<button class="btn btn-outline" id="sBot">' + ic('wa') + 'Bot WhatsApp du téléphone</button>' : '') +
      '<div class="card"><div class="sec"><b>Couleurs</b></div><div class="pal-row" id="pals">' +
      [['sonicod', 'Sonicod', 'linear-gradient(135deg,#E0168F,#8E2BC0)'], ['jaune', 'Noir & Jaune', 'linear-gradient(135deg,#111 50%,#FFD60A 50%)'], ['violet', 'Violet', '#6E2B92']].map(function (x) {
        return '<button class="pal' + ((store('pal') || 'sonicod') === x[0] ? ' on' : '') + '" data-pal="' + x[0] + '"><i style="background:' + x[2] + '"></i>' + x[1] + '</button>';
      }).join('') + '</div></div>' +
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
          (o.lastError ? '<div class="t2" style="color:var(--bad);white-space:normal">' + esc(o.lastError) + '</div>' : '') +
          '</div><button class="btn btn-danger btn-sm" data-del="' + esc(o.opId) + '">✕</button></div>';
      }).join('') + '</div><button class="btn btn-ghost" id="syncNow">⟳ Envoyer maintenant</button></div>' : '')
    );
    var sb = $('#sBot'); if (sb) sb.onclick = function () { go('bot'); };
    $$('#pals .pal').forEach(function (b) { b.onclick = function () { store('pal', b.getAttribute('data-pal')); applyTheme(); render(); }; });
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
  go(info().bot ? 'bot' : 'op', {}, { replace: true });
  setTimeout(function () { window.sonicodOrphans(); window.sonicodShareReady(); }, 800);
  if (info().serverUrl) { loadConfig(); retryScans(); }
})();
