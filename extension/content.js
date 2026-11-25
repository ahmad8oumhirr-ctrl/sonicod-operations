/* SONICOD – Bot Retours WhatsApp Web
 * Lit les photos des colis, le bon PDF et les étiquettes « BON RETOUR CLIENT » envoyés le jour choisi dans les groupes retour,
 * récupère le nombre de colis (lecture d'image Google) et enregistre « En attente » dans le Google Sheet.
 */
(function () {
  'use strict';
  if (window.__sonicodBot) return;
  window.__sonicodBot = true;

  /* ---------------- outils ---------------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const pad = n => (n < 10 ? '0' : '') + n;
  const isoOf = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const fmt = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? m[3] + '/' + m[2] + '/' + m[1] : (iso || ''); };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = { get: k => new Promise(r => chrome.storage.local.get([k], v => r(v[k]))), set: (k, v) => new Promise(r => chrome.storage.local.set({ [k]: v }, r)) };
  const api = body => new Promise(r => chrome.runtime.sendMessage({ type: 'api', body }, res => r(res || { ok: false, error: 'Pas de réponse' })));
  const hash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h).toString(16); };

  let cities = [];
  let results = [];          // étiquettes trouvées
  let logLines = [];
  const log = s => { logLines.push(s); const el = $('#snc-log'); if (el) el.textContent = logLines.slice(-12).join('\n'); };

  /* ---------------- WhatsApp Web : lecture du chat ouvert ---------------- */
  function chatName() {
    const h = $('#main header');
    if (!h) return '';
    const t = h.querySelector('span[title]') || h.querySelector('span[dir="auto"]');
    return t ? (t.getAttribute('title') || t.textContent || '').trim() : '';
  }

  /** Clé de jour d'un séparateur de date (« AUJOURD'HUI », « HIER », « 23/11/2026 »…). */
  function dividerDay(text, today, yesterday) {
    const t = text.trim().toUpperCase();
    if (/AUJOURD|TODAY|اليوم/.test(t)) return today;
    if (/^HIER|YESTERDAY|أمس/.test(t)) return yesterday;
    const m = /(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/.exec(t);
    if (m) return m[3] + '-' + pad(+m[2]) + '-' + pad(+m[1]);
    return 'autre:' + t;
  }

  /** Date d'un message à partir de data-pre-plain-text « [17:28, 25/11/2026] Nom: ». */
  function messageDay(el, today) {
    const pre = el.querySelector('[data-pre-plain-text]');
    if (!pre) return null;
    const m = /(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/.exec(pre.getAttribute('data-pre-plain-text') || '');
    if (!m) return null;
    const a = +m[1], b = +m[2], y = m[3];
    const dm = y + '-' + pad(b) + '-' + pad(a);   // jj/mm/aaaa (français)
    const md = y + '-' + pad(a) + '-' + pad(b);   // mm/jj/aaaa (anglais)
    if (a > 12) return dm;
    if (b > 12) return md;
    return dm === today || md !== today ? dm : md;
  }

  /** Photos (blob) et documents PDF du chat ouvert, envoyés le jour choisi. */
  function collectDay(dayIso) {
    const today = isoOf(new Date());
    const yesterday = isoOf(new Date(Date.now() - 86400000));
    const rows = $$('#main [role="row"]');
    let current = null;
    const imgs = [], docs = [];
    rows.forEach(row => {
      const msg = row.querySelector('[data-id]');
      if (!msg) { const txt = (row.innerText || '').trim(); if (txt && txt.length < 40) current = dividerDay(txt, today, yesterday); return; }
      const day = messageDay(row, today) || current;
      if (day !== dayIso) return;
      row.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src') || '';
        if (!src.startsWith('blob:')) return;
        if ((img.naturalWidth || 0) < 120 || (img.naturalHeight || 0) < 120) return;
        if (img.closest('header')) return;
        imgs.push(img);
      });
      // document PDF : un élément dont le texte se termine par .pdf
      const nameEl = Array.from(row.querySelectorAll('span, div')).find(e => e.children.length === 0 && /\.pdf\s*$/i.test(e.textContent || ''));
      if (nameEl) docs.push({ name: nameEl.textContent.trim(), el: nameEl });
    });
    log('Lignes lues : ' + rows.length + ' · ' + fmt(dayIso) + ' : ' + imgs.length + ' photo(s), ' + docs.length + ' PDF');
    return { imgs, docs };
  }

  /** Récupère le contenu d'un PDF en cliquant dessus (capturé par hook.js, sans téléchargement). */
  function capturePdf(el) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (done) return; done = true; window.removeEventListener('message', onMsg); window.postMessage({ __snc: 'capture', on: false }, '*'); resolve(v); };
      const onMsg = e => {
        if (e.source !== window || !e.data || e.data.__snc !== 'blob') return;
        const fr = new FileReader();
        fr.onload = () => finish(String(fr.result).split(',')[1]);
        fr.onerror = () => finish(null);
        fr.readAsDataURL(e.data.blob);
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ __snc: 'capture', on: true }, '*');
      const target = el.closest('[role="button"]') || el.closest('[data-id] div[tabindex]') || el;
      fireClick(target);
      setTimeout(() => finish(null), 12000);
    });
  }

  function imgToB64(img) {
    const max = 1800;
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }

  /** Ville / livreur : réglage du groupe, sinon déduit de la zone (« HUB AGADIR » → Agadir). */
  function guessCity(group, zone, groups) {
    if (groups[group]) return groups[group];
    const z = (zone || '').toUpperCase().replace(/^HUB\s+/, '');
    const hit = cities.find(c => z && (z.indexOf(c.toUpperCase()) >= 0 || c.toUpperCase().indexOf(z) >= 0));
    if (hit) return hit;
    if (/CASABLANCA/.test(z)) return cities.find(c => /^CASA$/i.test(c)) || 'CASA';
    return '';
  }

  /** Analyse le chat ouvert : photos du jour + bon PDF + nombre de colis (étiquettes). */
  async function analyseOpenChat(dayIso) {
    const group = chatName();
    if (!group) { log('Ouvrez d\'abord un groupe dans WhatsApp.'); return 0; }
    const groups = (await store.get('groups')) || {};
    const { imgs, docs } = collectDay(dayIso);
    if (!imgs.length && !docs.length) { log(group + ' : rien pour ce jour.'); return 0; }
    const rec = { key: group + '|' + dayIso, group, day: dayIso, colis: null, brvs: {}, zone: '', photos: [], labels: [], docs: [], livreur: groups[group] || '', checked: true, status: '', photoHashes: [] };
    results = results.filter(r => r.key !== rec.key);
    results.push(rec);
    // Photos : on garde tout (max 10) et on lit les étiquettes
    for (let i = 0; i < imgs.length && i < 15; i++) {
      log(group + ' : photo ' + (i + 1) + '/' + imgs.length + '…');
      let b64;
      try { b64 = imgToB64(imgs[i]); } catch (e) { log('Photo illisible'); continue; }
      const ph = hash(b64.slice(0, 4000) + b64.length);
      const cache = (await store.get('ocr')) || {};
      let r = cache[ph] ? { ok: true, data: cache[ph] } : await api({ action: 'ocrLabel', b64 });
      if (r.ok && !cache[ph]) {
        cache[ph] = { colis: r.data.colis, brv: r.data.brv, zone: r.data.zone };
        const keys = Object.keys(cache); if (keys.length > 400) keys.slice(0, 100).forEach(k => delete cache[k]);
        await store.set('ocr', cache);
      }
      const isLabel = r.ok && r.data.colis != null;
      if (isLabel) {
        const d = r.data, k = d.brv || ('n' + d.colis);
        rec.brvs[k] = Math.max(rec.brvs[k] || 0, d.colis);
        if (d.zone && !rec.zone) rec.zone = d.zone;
        rec.labels.push(b64);
      } else if (!r.ok && r.network) { log('Serveur injoignable'); break; }
      if (rec.photos.length < 10) { rec.photos.push(b64); rec.photoHashes.push(ph); }
      rec.colis = Object.keys(rec.brvs).length ? Object.values(rec.brvs).reduce((a, b) => a + b, 0) : null;
      if (!rec.livreur) rec.livreur = guessCity(group, rec.zone, groups);
      renderResults();
    }
    // Bon(s) PDF
    for (const d of docs.slice(0, 3)) {
      log(group + ' : lecture du bon ' + d.name + '…');
      const b64 = await capturePdf(d.el);
      if (b64) rec.docs.push({ name: d.name, b64 });
      else log('PDF non récupéré : ' + d.name + ' (téléchargez-le une fois dans WhatsApp puis relancez)');
      await wait(600);
      const viewerClose = $('[data-icon="x-viewer"], [aria-label="Fermer"], [aria-label="Close"]');
      if (viewerClose) fireClick(viewerClose.closest('[role="button"]') || viewerClose);
      renderResults();
    }
    log(group + ' : ' + rec.photos.length + ' photo(s), ' + rec.docs.length + ' PDF, ' + (rec.colis == null ? 'colis non lus' : rec.colis + ' colis') + '.');
    await sendRecord(rec);                      // envoi automatique au Google Sheet
    return 1;
  }

  /* ---------------- ouvrir un groupe par son nom ---------------- */
  function fireClick(el) {
    ['mousedown', 'mouseup', 'click'].forEach(t => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
  }
  function findChatInList(name) {
    const span = $$('#pane-side span[title]').find(s => s.getAttribute('title') === name);
    return span ? (span.closest('[role="listitem"]') || span.closest('[role="row"]') || span.closest('div[tabindex]') || span) : null;
  }
  async function openChat(name) {
    let el = findChatInList(name);
    if (!el) {
      const box = $('#side div[contenteditable="true"]');
      if (box) {
        box.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, name);
        await wait(1800);
        el = findChatInList(name);
      }
    }
    if (!el) return false;
    fireClick(el);
    for (let i = 0; i < 20; i++) { await wait(300); if (chatName() === name) break; }
    await wait(1500);                                   // chargement des messages / photos
    const box = $('#side div[contenteditable="true"]');
    if (box && box.textContent) { box.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); }
    return chatName() === name;
  }

  /* ---------------- panneau ---------------- */
  function ui() {
    const fab = document.createElement('button');
    fab.id = 'snc-fab';
    fab.innerHTML = '<img src="' + chrome.runtime.getURL('icon48.png') + '">SONICOD Retours';
    document.body.appendChild(fab);
    const panel = document.createElement('div');
    panel.id = 'snc-panel';
    panel.style.display = 'none';
    document.body.appendChild(panel);
    fab.onclick = () => { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; if (panel.style.display === 'block') renderPanel(); };
  }

  async function renderPanel() {
    const panel = $('#snc-panel');
    const groups = (await store.get('groups')) || {};
    const url = (await store.get('serverUrl')) || '';
    const group = chatName();
    const today = isoOf(new Date());
    const sched = (await store.get('sched')) || { on: false, times: ['00:00'] };
    const lastRun = (await store.get('lastRun')) || '—';
    const cityOpts = sel => '<option value="">— Ville / Livreur —</option>' + cities.map(c => '<option' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>').join('');
    panel.innerHTML =
      '<div class="h"><b>⚡ SONICOD · Retours du jour</b><button id="snc-x">✕</button></div><div class="b">' +
      '<label>Jour</label><input type="date" id="snc-day" value="' + today + '">' +
      '<label>Groupe ouvert</label><div class="grp">' + (group ? esc(group) : 'Aucun – ouvrez un groupe retour') + '</div>' +
      (group ? '<label>Ce groupe correspond à</label><select id="snc-city">' + cityOpts(groups[group] || '') + '</select>' : '') +
      '<div class="row"><button class="btn" id="snc-one"' + (group ? '' : ' disabled') + '>Lire ce groupe</button>' +
      '<button class="btn o" id="snc-all"' + (Object.keys(groups).length ? '' : ' disabled') + '>Lire tous mes groupes (' + Object.keys(groups).length + ')</button></div>' +
      '<div class="autobox"><label style="margin:0;display:flex;align-items:center;gap:8px;text-transform:none;font-size:13px;color:#1D1428"><input type="checkbox" id="snc-auto" style="width:auto"' + (sched.on ? ' checked' : '') + '> <b>Chaque jour automatiquement</b> à :</label>' +
      '<div class="times">' + sched.times.map((t, k) => '<span class="tchip">' + esc(t) + ' <a href="#" data-tdel="' + k + '">✕</a></span>').join('') + '</div>' +
      '<div class="row" style="align-items:center;margin-top:6px"><input type="time" id="snc-time" value="00:00" style="max-width:120px"><button class="btn o" id="snc-tadd" style="margin:0;padding:8px">＋ Ajouter l\'heure</button></div>' +
      '<div class="s" style="font-size:12px;color:#6F6680;margin-top:6px">Lit tous mes groupes (hier + aujourd\'hui). Dernière lecture : ' + esc(lastRun) + '</div>' +
      '<button class="btn o" id="snc-now" style="margin-top:8px">Tester maintenant</button></div>' +
      '<div id="snc-res"></div>' +
      '<button class="btn g" id="snc-save" style="display:none">Renvoyer au Sheet</button>' +
      '<div class="log" id="snc-log">' + esc(logLines.slice(-12).join('\n')) + '</div>' +
      '<div class="autobox"><b>Ajouter un groupe retour</b>' +
      '<label>Nom du groupe (exactement comme dans WhatsApp)</label><input id="snc-gname" placeholder="Ex : Roteur Rushliv Casa">' +
      '<label>Ville / Livreur</label><select id="snc-gcity">' + cityOpts('') + '</select>' +
      '<button class="btn" id="snc-gadd" style="margin-top:8px">＋ Ajouter</button></div>' +
      '<details open><summary>Mes groupes retour (' + Object.keys(groups).length + ')</summary>' +
      (Object.keys(groups).length ? Object.keys(groups).map(g => '<div class="grp">' + esc(g) + ' → ' + esc(groups[g] || '?') + ' <a href="#" data-del="' + esc(g) + '" style="float:right;color:#DC2626">retirer</a></div>').join('') : '<p>Aucun. Ouvrez un groupe et choisissez sa ville ci-dessus.</p>') +
      '<label>Adresse du script (…/exec)</label><input id="snc-url" placeholder="(par défaut)" value="' + esc(url) + '">' +
      '</details></div>';
    $('#snc-x').onclick = () => { panel.style.display = 'none'; };
    const citySel = $('#snc-city');
    if (citySel) citySel.onchange = async () => {
      const g = (await store.get('groups')) || {};
      if (citySel.value) g[group] = citySel.value; else delete g[group];
      await store.set('groups', g);
      renderPanel();
    };
    $$('[data-del]').forEach(a => a.onclick = async e => { e.preventDefault(); const g = (await store.get('groups')) || {}; delete g[a.getAttribute('data-del')]; await store.set('groups', g); renderPanel(); });
    $('#snc-gadd').onclick = async () => {
      const n = $('#snc-gname').value.trim(), c = $('#snc-gcity').value;
      if (!n) { log('Écrivez le nom du groupe.'); return; }
      if (!c) { log('Choisissez la ville du groupe.'); return; }
      const g = (await store.get('groups')) || {}; g[n] = c; await store.set('groups', g);
      log('Groupe ajouté : ' + n + ' → ' + c); renderPanel();
    };
    $('#snc-url').onchange = async () => { await store.set('serverUrl', $('#snc-url').value.trim()); log('Adresse enregistrée.'); };
    $('#snc-one').onclick = async () => {
      const day = $('#snc-day').value || today;
      if (citySel && citySel.value) { const g = (await store.get('groups')) || {}; g[group] = citySel.value; await store.set('groups', g); }
      busy(true); await analyseOpenChat(day); busy(false);
    };
    $('#snc-all').onclick = async () => {
      busy(true); await runAll($('#snc-day').value || today); busy(false); renderPanel();
    };
    const saveSched = async (sc) => { await store.set('sched', sc); chrome.runtime.sendMessage({ type: 'schedule', sched: sc }); };
    $('#snc-auto').onchange = async () => { sched.on = $('#snc-auto').checked; await store.set('lastSlot', Date.now()); await saveSched(sched); log(sched.on ? 'Programmation activée : ' + sched.times.join(', ') : 'Programmation arrêtée.'); };
    $('#snc-tadd').onclick = async () => { const t = $('#snc-time').value; if (!/^\d{2}:\d{2}$/.test(t)) return; if (sched.times.indexOf(t) < 0) sched.times.push(t); sched.times.sort(); await saveSched(sched); renderPanel(); };
    $$('[data-tdel]').forEach(a => a.onclick = async e => { e.preventDefault(); sched.times.splice(+a.dataset.tdel, 1); await saveSched(sched); renderPanel(); });
    $('#snc-now').onclick = async () => { busy(true); await scheduledRun(true); busy(false); renderPanel(); };
    $('#snc-save').onclick = saveAll;
    renderResults();
  }

  function busy(on) { ['#snc-one', '#snc-all', '#snc-save'].forEach(s => { const b = $(s); if (b) b.disabled = on; }); }

  function renderResults() {
    const box = $('#snc-res');
    if (!box) return;
    box.innerHTML = results.map((r, i) =>
      '<div class="res"><div class="m">' +
      '<div class="t">' + esc(r.group) + ' · ' + fmt(r.day) + '</div>' +
      '<div class="thumbs">' + r.photos.map(b => '<img src="data:image/jpeg;base64,' + b + '">').join('') + '</div>' +
      '<div class="s">' + r.photos.length + ' photo(s)' + (r.docs.length ? ' · ' + r.docs.map(d => '📄 ' + esc(d.name)).join(', ') : ' · pas de PDF') +
      (Object.keys(r.brvs).length ? ' · ' + Object.keys(r.brvs).length + ' étiquette(s)' : '') + (r.zone ? ' · ' + esc(r.zone) : '') + '</div>' +
      '<div class="row" style="margin-top:6px"><input type="number" min="1" placeholder="Colis" data-n="' + i + '" value="' + (r.colis == null ? '' : r.colis) + '"> <select data-v="' + i + '">' +
      '<option value="">Ville ?</option>' + cities.map(c => '<option' + (c === r.livreur ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>' +
      (r.status ? '<div class="' + (r.status === 'ok' ? 'ok' : 'err') + '">' + esc(r.msg) + '</div>' : '') +
      '</div></div>').join('');
    $$('[data-ck]').forEach(c => c.onchange = () => { results[+c.dataset.ck].checked = c.checked; });
    $$('[data-n]').forEach(c => c.onchange = () => { const r = results[+c.dataset.n]; r.colis = c.value === '' ? null : Number(c.value); sendRecord(r); });
    $$('[data-v]').forEach(c => c.onchange = async () => { const r = results[+c.dataset.v]; r.livreur = c.value; const g = (await store.get('groups')) || {}; if (c.value) { g[r.group] = c.value; await store.set('groups', g); } sendRecord(r); });
    const save = $('#snc-save');
    if (save) {
      const n = results.filter(r => r.status === 'err').length;
      save.style.display = n ? 'block' : 'none';
      save.textContent = 'Renvoyer au Sheet (' + n + ')';
    }
  }

  /** Envoie au Sheet seulement ce qui est nouveau (photos / PDF pas encore envoyés). */
  async function sendRecord(r) {
    if (!r.livreur) { r.status = 'err'; r.msg = 'Choisissez la ville de ce groupe (menu ci-dessus) puis relisez.'; renderResults(); return; }
    const pid = 'wa-' + hash(r.key);
    const sent = (await store.get('sent')) || {};
    const done = sent[pid] || { p: [], d: [], c: null };
    const photos = [], ph = [];
    r.photos.forEach((b64, i) => { const h = r.photoHashes[i]; if (done.p.indexOf(h) < 0) { photos.push({ b64 }); ph.push(h); } });
    const files = r.docs.filter(d => done.d.indexOf(d.name) < 0).map(d => ({ b64: d.b64, name: d.name, mime: 'application/pdf' }));
    if (done.c === r.colis && !photos.length && !files.length && done.l === r.livreur) { r.status = 'ok'; r.msg = '✓ Déjà à jour dans le Sheet'; renderResults(); return; }
    log('Envoi ' + r.group + ' au Sheet…');
    const brv = Object.keys(r.brvs).filter(k => k.startsWith('BRV'));
    const res = await api({
      action: 'addPending', pid, livreur: r.livreur, colis: r.colis || '', date: r.day, who: 'Bot WhatsApp',
      note: r.group + (brv.length ? ' · ' + brv.join(', ') : ''), photos, files
    });
    if (res.ok) {
      done.p = done.p.concat(ph); done.d = done.d.concat(files.map(f => f.name)); done.c = r.colis; done.l = r.livreur;
      sent[pid] = done;
      const keys = Object.keys(sent); if (keys.length > 300) keys.slice(0, 100).forEach(k => delete sent[k]);
      await store.set('sent', sent);
      r.status = 'ok';
      r.msg = (res.data.created ? '✓ Ajouté au Sheet' : '✓ Mis à jour') + ' (ligne ' + res.data.row + ')' +
        (res.data.addedPhotos ? ' · +' + res.data.addedPhotos + ' photo(s)' : '') + (res.data.addedDocs ? ' · +' + res.data.addedDocs + ' PDF' : '');
    } else { r.status = 'err'; r.msg = res.error || 'Erreur'; }
    renderResults();
  }

  async function saveAll() {
    busy(true);
    for (const r of results.filter(x => x.status !== 'ok')) await sendRecord(r);
    busy(false);
  }

  /* ---------------- programmation (chaque jour aux heures choisies) ---------------- */
  let autoBusy = false;

  /** Lit tous les groupes enregistrés, pour un ou plusieurs jours (chaque groupe n'est ouvert qu'une fois). */
  async function runAll(days) {
    const groups = (await store.get('groups')) || {};
    for (const g of Object.keys(groups)) {
      log('Ouverture : ' + g + '…');
      if (await openChat(g)) { for (const d of days) await analyseOpenChat(d); }
      else log('Groupe introuvable : ' + g);
    }
    await store.set('lastRun', new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
  }

  /** Dernier créneau programmé déjà passé (ex. « 2026-11-25 00:00 »), ou null. */
  function lastSlot(times) {
    const now = new Date();
    let best = null;
    [0, 1].forEach(back => {
      const d = new Date(now.getTime() - back * 86400000);
      (times || []).forEach(t => {
        const m = /^(\d{2}):(\d{2})$/.exec(t); if (!m) return;
        const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), +m[1], +m[2]);
        if (at <= now && (!best || at > best)) best = at;
      });
    });
    return best;
  }

  /** Lancement programmé : lit HIER et AUJOURD'HUI (utile pour 00:00), sans doublon grâce au Sheet. */
  async function scheduledRun(force) {
    const sched = (await store.get('sched')) || { on: false, times: ['00:00'] };
    if (autoBusy || (!sched.on && !force)) return;
    if (!$('#pane-side')) return;                     // WhatsApp pas encore chargé : on réessaie plus tard
    const slot = lastSlot(sched.times);
    const done = (await store.get('lastSlot')) || 0;
    if (!force && (!slot || slot.getTime() <= done)) return;
    autoBusy = true;
    await store.set('lastSlot', slot ? slot.getTime() : Date.now());
    log('▶ Lecture programmée (' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + ')');
    try {
      const today = isoOf(new Date()), yesterday = isoOf(new Date(Date.now() - 86400000));
      await runAll([yesterday, today]);
      log('✓ Lecture programmée terminée.');
    } finally { autoBusy = false; }
  }
  setInterval(() => { scheduledRun(false); }, 30000);
  chrome.runtime.onMessage.addListener(msg => { if (msg && msg.type === 'scheduled') scheduledRun(false); });

  /* ---------------- démarrage ---------------- */
  async function start() {
    const c = await api({ action: 'config' });
    if (c.ok) cities = c.data.cities || [];
    else log('Serveur : ' + (c.error || 'injoignable'));
    ui();
  }
  const t = setInterval(() => { if ($('#side') || $('#pane-side')) { clearInterval(t); start(); } }, 1500);
})();
