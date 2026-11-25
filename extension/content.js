/* SONICOD – Bot Retours WhatsApp Web
 * Lit les photos d'étiquettes « BON RETOUR CLIENT » envoyées aujourd'hui dans les groupes retour,
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

  /** Photos (blob) du chat ouvert, envoyées le jour choisi. */
  function collectImages(dayIso) {
    const today = isoOf(new Date());
    const yesterday = isoOf(new Date(Date.now() - 86400000));
    const rows = $$('#main [role="row"]');
    let current = null;
    const out = [];
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
        out.push(img);
      });
    });
    log('Lignes lues : ' + rows.length + ' · photos du ' + fmt(dayIso) + ' : ' + out.length);
    return out;
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

  /** Analyse le chat ouvert : lecture de chaque photo du jour. */
  async function analyseOpenChat(dayIso) {
    const group = chatName();
    if (!group) { log('Ouvrez d\'abord un groupe dans WhatsApp.'); return 0; }
    const groups = (await store.get('groups')) || {};
    const imgs = collectImages(dayIso).slice(-30);
    let found = 0;
    for (let i = 0; i < imgs.length; i++) {
      log(group + ' : lecture photo ' + (i + 1) + '/' + imgs.length + '…');
      let b64;
      try { b64 = imgToB64(imgs[i]); } catch (e) { log('Photo illisible (' + e.message + ')'); continue; }
      const r = await api({ action: 'ocrLabel', b64 });
      if (!r.ok) { log('Erreur lecture : ' + r.error); if (r.network) break; continue; }
      const d = r.data;
      if (d.colis == null) continue;                    // pas une étiquette « BON RETOUR »
      const key = d.brv || (group + '|' + (d.date || dayIso) + '|' + d.colis);
      let it = results.find(x => x.key === key);
      if (!it) {
        it = { key, group, colis: d.colis, zone: d.zone, date: d.date || dayIso, brv: d.brv, parts: [], b64, thumb: 'data:image/jpeg;base64,' + b64, livreur: guessCity(group, d.zone, groups), checked: true, status: '' };
        results.push(it); found++;
      }
      if (d.part && it.parts.indexOf(d.part) < 0) it.parts.push(d.part);
      if (d.colis > it.colis) it.colis = d.colis;
      renderResults();
    }
    log(group + ' : ' + found + ' étiquette(s) trouvée(s).');
    return found;
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
    const cityOpts = sel => '<option value="">— Ville / Livreur —</option>' + cities.map(c => '<option' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>').join('');
    panel.innerHTML =
      '<div class="h"><b>⚡ SONICOD · Retours du jour</b><button id="snc-x">✕</button></div><div class="b">' +
      '<label>Jour</label><input type="date" id="snc-day" value="' + today + '">' +
      '<label>Groupe ouvert</label><div class="grp">' + (group ? esc(group) : 'Aucun – ouvrez un groupe retour') + '</div>' +
      (group ? '<label>Ce groupe correspond à</label><select id="snc-city">' + cityOpts(groups[group] || '') + '</select>' : '') +
      '<div class="row"><button class="btn" id="snc-one"' + (group ? '' : ' disabled') + '>Lire ce groupe</button>' +
      '<button class="btn o" id="snc-all"' + (Object.keys(groups).length ? '' : ' disabled') + '>Lire tous mes groupes (' + Object.keys(groups).length + ')</button></div>' +
      '<div id="snc-res"></div>' +
      '<button class="btn g" id="snc-save" style="display:none">Enregistrer « En attente »</button>' +
      '<div class="log" id="snc-log">' + esc(logLines.slice(-12).join('\n')) + '</div>' +
      '<details><summary>Mes groupes retour</summary>' +
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
    $('#snc-url').onchange = async () => { await store.set('serverUrl', $('#snc-url').value.trim()); log('Adresse enregistrée.'); };
    $('#snc-one').onclick = async () => {
      const day = $('#snc-day').value || today;
      if (citySel && citySel.value) { const g = (await store.get('groups')) || {}; g[group] = citySel.value; await store.set('groups', g); }
      busy(true); await analyseOpenChat(day); busy(false);
    };
    $('#snc-all').onclick = async () => {
      const day = $('#snc-day').value || today;
      busy(true);
      for (const g of Object.keys(groups)) {
        log('Ouverture : ' + g + '…');
        if (await openChat(g)) await analyseOpenChat(day);
        else log('Groupe introuvable : ' + g);
      }
      busy(false); renderPanel();
    };
    $('#snc-save').onclick = saveAll;
    renderResults();
  }

  function busy(on) { ['#snc-one', '#snc-all', '#snc-save'].forEach(s => { const b = $(s); if (b) b.disabled = on; }); }

  function renderResults() {
    const box = $('#snc-res');
    if (!box) return;
    box.innerHTML = results.map((r, i) =>
      '<div class="res"><img src="' + r.thumb + '"><div class="m">' +
      '<div class="t"><input type="checkbox" data-ck="' + i + '"' + (r.checked ? ' checked' : '') + (r.status === 'ok' ? ' disabled' : '') + '> ' + esc(r.group) + '</div>' +
      '<div class="s">' + esc(r.brv || 'sans n° BRV') + ' · ' + esc(r.zone || '') + ' · ' + fmt(r.date) + (r.parts.length ? ' · sacs ' + esc(r.parts.join(', ')) : '') + '</div>' +
      '<div class="row" style="margin-top:6px"><input type="number" min="1" data-n="' + i + '" value="' + r.colis + '"> <select data-v="' + i + '">' +
      '<option value="">Ville ?</option>' + cities.map(c => '<option' + (c === r.livreur ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>' +
      (r.status ? '<div class="' + (r.status === 'ok' ? 'ok' : 'err') + '">' + esc(r.msg) + '</div>' : '') +
      '</div></div>').join('');
    $$('[data-ck]').forEach(c => c.onchange = () => { results[+c.dataset.ck].checked = c.checked; });
    $$('[data-n]').forEach(c => c.oninput = () => { results[+c.dataset.n].colis = Number(c.value); });
    $$('[data-v]').forEach(c => c.onchange = () => { results[+c.dataset.v].livreur = c.value; });
    const save = $('#snc-save');
    if (save) {
      const n = results.filter(r => r.checked && r.status !== 'ok').length;
      save.style.display = results.length ? 'block' : 'none';
      save.textContent = 'Enregistrer « En attente » (' + n + ')';
    }
  }

  async function saveAll() {
    const todo = results.filter(r => r.checked && r.status !== 'ok');
    if (todo.some(r => !r.livreur)) { log('Choisissez la ville pour chaque étiquette.'); return; }
    busy(true);
    for (const r of todo) {
      const pid = 'wa-' + (r.brv ? r.brv.replace(/[^0-9]/g, '') : hash(r.key));
      const res = await api({
        action: 'addPending', pid, livreur: r.livreur, colis: r.colis, date: r.date, who: 'Bot WhatsApp',
        note: r.group + (r.brv ? ' · ' + r.brv : '') + (r.parts.length ? ' · sacs ' + r.parts.join(', ') : ''),
        photos: [{ b64: r.b64 }]
      });
      if (res.ok) { r.status = 'ok'; r.msg = res.data.duplicate ? '✓ Déjà enregistré' : '✓ Enregistré (ligne ' + res.data.row + ')'; }
      else { r.status = 'err'; r.msg = res.error || 'Erreur'; }
      renderResults();
    }
    busy(false);
    log('Enregistrement terminé.');
  }

  /* ---------------- démarrage ---------------- */
  async function start() {
    const c = await api({ action: 'config' });
    if (c.ok) cities = c.data.cities || [];
    else log('Serveur : ' + (c.error || 'injoignable'));
    ui();
  }
  const t = setInterval(() => { if ($('#side') || $('#pane-side')) { clearInterval(t); start(); } }, 1500);
})();
