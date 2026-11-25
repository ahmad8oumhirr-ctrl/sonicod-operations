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
  let selDay = '';           // jour choisi dans le panneau (gardé quand le panneau se redessine)
  let results = [];          // étiquettes trouvées
  let logLines = [];
  const log = s => { logLines.push(s); const el = $('#snc-log'); if (el) el.textContent = logLines.slice(-12).join('\n'); };

  /* ---------------- WhatsApp Web : lecture du chat ouvert ---------------- */
  /** Liste des membres affichée sous le nom du groupe (« Aicha, Mohamed, …, You ») : ce n'est PAS le nom. */
  function looksLikeMembers(s) {
    s = String(s || '').trim();
    if (s.indexOf(',') < 0) return false;
    return /(^|,\s*)(You|Vous|Toi|أنت)\s*$/i.test(s) || s.split(',').length >= 4;
  }
  const normName = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  function chatName() {
    // 1) le groupe sélectionné dans la liste de gauche (le plus fiable)
    const sel = $('#pane-side [aria-selected="true"] span[title]');
    if (sel) { const v = (sel.getAttribute('title') || '').trim(); if (v && !looksLikeMembers(v)) return v; }
    // 2) l'en-tête du chat, sans la ligne des membres / « en ligne » / « cliquez ici »
    const h = $('#main header');
    if (!h) return '';
    const c = Array.from(h.querySelectorAll('span[title], span[dir="auto"]'))
      .map(e => (e.getAttribute('title') || e.textContent || '').trim())
      .filter(t => t && !looksLikeMembers(t) && !/^(en ligne|online|en train|typing|cliquez|click here|tap here|vu |last seen)/i.test(t));
    return c[0] || '';
  }

  /** Clé de jour d'un séparateur de date (« AUJOURD'HUI », « HIER », « 23/11/2026 »…). */
  /** Ordre des dates de ce WhatsApp : 'dm' (23/11/2026) ou 'md' (11/23/2026, WhatsApp en anglais US). Appris sur la page. */
  function dateOrder() {
    let dm = 0, md = 0;
    $$('#main [data-pre-plain-text]').forEach(e => {
      const m = /(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/.exec(e.getAttribute('data-pre-plain-text') || '');
      if (!m) return;
      if (+m[1] > 12) dm++; else if (+m[2] > 12) md++;
    });
    if (dm || md) return dm >= md ? 'dm' : 'md';
    const lang = (document.documentElement.lang || navigator.language || '').toLowerCase();
    return /^en(-us)?$/.test(lang) ? 'md' : 'dm';
  }
  const MONTHS = { jan: 1, janv: 1, january: 1, janvier: 1, feb: 2, fev: 2, 'fév': 2, february: 2, 'février': 2, fevrier: 2, mar: 3, march: 3, mars: 3, apr: 4, avr: 4, april: 4, avril: 4, may: 5, mai: 5,
    jun: 6, june: 6, juin: 6, jul: 7, july: 7, juil: 7, juillet: 7, aug: 8, august: 8, 'août': 8, aout: 8, sep: 9, sept: 9, september: 9, septembre: 9, oct: 10, october: 10, octobre: 10,
    nov: 11, november: 11, novembre: 11, dec: 12, 'déc': 12, december: 12, 'décembre': 12, decembre: 12 };
  const WEEKDAYS = { sunday: 0, dimanche: 0, 'الأحد': 0, monday: 1, lundi: 1, 'الاثنين': 1, 'الإثنين': 1, tuesday: 2, mardi: 2, 'الثلاثاء': 2, wednesday: 3, mercredi: 3, 'الأربعاء': 3,
    thursday: 4, jeudi: 4, 'الخميس': 4, friday: 5, vendredi: 5, 'الجمعة': 5, saturday: 6, samedi: 6, 'السبت': 6 };

  /** Clé de jour d'un séparateur : « AUJOURD'HUI / TODAY », « HIER / YESTERDAY », « MONDAY / LUNDI », « 23/11/2026 », « 11/23/2026 », « November 23, 2026 »… */
  function dividerDay(text, today, yesterday, order) {
    const t = text.trim();
    const u = t.toUpperCase();
    if (/AUJOURD|TODAY|اليوم/.test(u)) return today;
    if (/^HIER|YESTERDAY|أمس/.test(u)) return yesterday;
    let m = /(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/.exec(t);
    if (m) {
      let d = +m[1], mo = +m[2];
      if (d > 12) {} else if (mo > 12 || (order || 'dm') === 'md') { const x = d; d = mo; mo = x; }
      return m[3] + '-' + pad(mo) + '-' + pad(d);
    }
    const low = t.toLowerCase().replace(/[.,]/g, ' ');
    m = /(\d{1,2})\s+([a-zéûôà]+)\s+(\d{4})/.exec(low) || null;          // 23 novembre 2026
    if (m && MONTHS[m[2]]) return m[3] + '-' + pad(MONTHS[m[2]]) + '-' + pad(+m[1]);
    m = /([a-zéûôà]+)\s+(\d{1,2})\s+(\d{4})/.exec(low);                   // November 23, 2026
    if (m && MONTHS[m[1]]) return m[3] + '-' + pad(MONTHS[m[1]]) + '-' + pad(+m[2]);
    const w = Object.keys(WEEKDAYS).find(k => low.trim() === k || low.trim().startsWith(k + ' '));
    if (w != null) {                                                       // jour de la semaine = un des 7 derniers jours
      const now = new Date();
      for (let back = 2; back <= 7; back++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
        if (d.getDay() === WEEKDAYS[w]) return isoOf(d);
      }
    }
    return 'autre:' + u;
  }

  /** Date d'un message à partir de data-pre-plain-text « [17:28, 25/11/2026] Nom: ». */
  function messageDay(el, today, order) {
    const pre = el.querySelector('[data-pre-plain-text]');
    if (!pre) return null;
    const m = /(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/.exec(pre.getAttribute('data-pre-plain-text') || '');
    if (!m) return null;
    const a = +m[1], b = +m[2], y = m[3];
    const dm = y + '-' + pad(b) + '-' + pad(a);   // jj/mm/aaaa (français)
    const md = y + '-' + pad(a) + '-' + pad(b);   // mm/jj/aaaa (anglais)
    if (a > 12) return dm;
    if (b > 12) return md;
    return (order || 'dm') === 'md' ? md : dm;
  }

  /** Photos (blob) et documents PDF du chat ouvert, envoyés le jour choisi. */
  /**
   * Messages et séparateurs de jour du chat ouvert, DANS L'ORDRE de la page.
   * Le nouveau WhatsApp Web ne met pas toujours les séparateurs (« TODAY », « MONDAY », « 23/11/2026 »)
   * dans des lignes role="row" : on les cherche partout dans le chat.
   */
  function chatTimeline() {
    const main = $('#main');
    if (!main) return [];
    const today = isoOf(new Date()), yesterday = isoOf(new Date(Date.now() - 86400000)), order = dateOrder();
    const items = [];
    // messages : éléments data-id les plus extérieurs
    main.querySelectorAll('[data-id]').forEach(el => {
      if (el.parentElement && el.parentElement.closest('[data-id]')) return;
      if (el.closest('header, footer')) return;
      items.push({ type: 'msg', el });
    });
    // séparateurs : petits textes « jour » hors des messages
    main.querySelectorAll('span, div').forEach(el => {
      if (el.children.length > 1) return;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 30) return;
      if (el.closest('[data-id], header, footer, #snc-panel')) return;
      if (el.children.length === 1 && (el.children[0].textContent || '').trim() === t) return;   // garder l'élément le plus profond
      const d = dividerDay(t, today, yesterday, order);
      if (!/^autre:/.test(d)) items.push({ type: 'day', el, day: d, text: t });
    });
    items.sort((x, y) => (x.el === y.el ? 0 : (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)));
    let current = null;
    items.forEach(it => {
      if (it.type === 'day') { current = it.day; return; }
      const row = it.el.closest('[role="row"]') || it.el;
      it.row = row;
      it.day = messageDay(row, today, order) || messageDay(it.el, today, order) || current;
    });
    return items;
  }

  /** Photos (blob) et documents PDF du chat ouvert, envoyés le jour choisi. */
  function collectDay(dayIso) {
    const items = chatTimeline();
    const imgs = [], docs = [];
    let extra = 0;   // albums : WhatsApp montre 4 photos et « +3 » pour les autres
    const seenImg = new Set();
    let nMsg = 0;
    items.forEach(it => {
      if (it.type !== 'msg') return;
      nMsg++;
      if (it.day !== dayIso) return;
      const box = it.row;
      const mid = it.el.getAttribute('data-id') || '';
      let k = 0;
      box.querySelectorAll('img').forEach(img => {
        if (seenImg.has(img)) return;
        const src = img.getAttribute('src') || '';
        if (!src.startsWith('blob:')) return;
        if ((img.naturalWidth || 0) < 120 || (img.naturalHeight || 0) < 120) return;
        if (img.closest('header')) return;
        seenImg.add(img);
        img.__sncId = mid ? 'wa:' + mid + '#' + (k++) : '';   // identifiant WhatsApp du message : le même à chaque lecture
        imgs.push(img);
      });
      const plus = Array.from(box.querySelectorAll('span, div')).find(e => e.children.length === 0 && /^\+\d{1,3}$/.test((e.textContent || '').trim()));
      if (plus && k) extra += +plus.textContent.trim().slice(1);
      // document PDF : un élément dont le texte se termine par .pdf
      const nameEl = Array.from(box.querySelectorAll('span, div')).find(e => e.children.length === 0 && /\.pdf\s*$/i.test(e.textContent || ''));
      if (nameEl && !docs.some(d => d.name === nameEl.textContent.trim())) docs.push({ name: nameEl.textContent.trim(), el: nameEl });
    });
    log('Messages lus : ' + nMsg + ' · ' + fmt(dayIso) + ' : ' + imgs.length + ' photo(s), ' + docs.length + ' PDF');
    return { imgs, docs, extra };
  }

  /** Diagnostic : ce que le bot voit dans le chat ouvert (sans le texte des messages). */
  function diagnostic() {
    const main = $('#main');
    const L = [];
    L.push('SONICOD bot v' + (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '?') + ' · ' + new Date().toLocaleString('fr-FR'));
    L.push('Groupe : ' + (chatName() || '(aucun)') + ' · langue page : ' + (document.documentElement.lang || '?') + ' · ordre dates : ' + dateOrder());
    if (!main) { L.push('#main introuvable (aucun chat ouvert ?)'); return L.join('\n'); }
    const items = chatTimeline();
    const msgs = items.filter(i => i.type === 'msg'), days = items.filter(i => i.type === 'day');
    L.push('lignes role=row : ' + main.querySelectorAll('[role="row"]').length + ' · éléments data-id : ' + main.querySelectorAll('[data-id]').length + ' · messages : ' + msgs.length);
    const imgsAll = Array.from(main.querySelectorAll('img'));
    const blob = imgsAll.filter(i => (i.getAttribute('src') || '').startsWith('blob:'));
    L.push('images : ' + imgsAll.length + ' · blob : ' + blob.length + ' · blob ≥120px : ' + blob.filter(i => i.naturalWidth >= 120 && i.naturalHeight >= 120).length +
      ' · data: ' + imgsAll.filter(i => (i.getAttribute('src') || '').startsWith('data:')).length + ' · tailles blob : ' + blob.slice(0, 6).map(i => i.naturalWidth + 'x' + i.naturalHeight).join(' '));
    L.push('pre-plain-text : ' + main.querySelectorAll('[data-pre-plain-text]').length + ' · ex : ' + Array.from(main.querySelectorAll('[data-pre-plain-text]')).slice(-2).map(e => ((e.getAttribute('data-pre-plain-text') || '').match(/^\[[^\]]*\]/) || [''])[0]).join(' '));
    L.push('séparateurs de jour : ' + (days.map(d => '« ' + d.text + ' »→' + d.day).join(', ') || 'AUCUN'));
    const byDay = {};
    msgs.forEach(m => { const k = m.day || '?'; byDay[k] = byDay[k] || { m: 0, img: 0 }; byDay[k].m++; byDay[k].img += Array.from((m.row || m.el).querySelectorAll('img')).filter(i => (i.getAttribute('src') || '').startsWith('blob:')).length; });
    L.push('par jour : ' + Object.keys(byDay).map(k => k + ' = ' + byDay[k].m + ' msg / ' + byDay[k].img + ' photo(s)').join(' · '));
    L.push('PDF visibles : ' + Array.from(main.querySelectorAll('span, div')).filter(e => e.children.length === 0 && /\.pdf\s*$/i.test(e.textContent || '')).length);
    const r0 = msgs.length ? msgs[msgs.length - 1] : null;
    if (r0) L.push('dernier message : balise ' + r0.el.tagName + ' role=' + (r0.el.getAttribute('role') || '-') + ' · dans role=row : ' + !!r0.el.closest('[role="row"]'));
    return L.join('\n');
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
    // la ville écrite dans le nom du groupe (« Retour Sonicod Tanger » → TANGER) ; la zone de l'étiquette (HUB …) n'est PAS fiable
    const g = ' ' + normName(group).replace(/[^a-z0-9 ]+/g, ' ') + ' ';
    const hit = cities.find(c => { const n = normName(c); return n.length >= 3 && g.indexOf(' ' + n + ' ') >= 0; });
    return hit || '';
  }

  /** Plus ancien jour affiché dans le chat (pour remonter si le jour demandé n'est pas encore chargé). */
  function oldestShownDay() {
    const it = chatTimeline().find(i => i.day && /^\d{4}-/.test(i.day));
    return it ? it.day : null;
  }
  /** Remonte dans le chat (au plus 8 fois) tant que le jour demandé n'est pas affiché. */
  async function loadDay(dayIso) {
    for (let i = 0; i < 8; i++) {
      const o = oldestShownDay();
      if (o && o < dayIso) return;
      const first = $('#main [role="row"]');
      const pane = first && (first.closest('[tabindex="0"]') || first.parentElement);
      let sc = first; while (sc && sc !== document.body && !(sc.scrollHeight > sc.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
      if (!sc || sc === document.body) return;
      const before = $$('#main [role="row"]').length;
      sc.scrollTop = 0;
      await wait(1200);
      if ($$('#main [role="row"]').length === before && sc.scrollTop === 0 && i > 1) return;
    }
  }

  /** Étape 1 (rapide, chat ouvert) : photos du jour + bon PDF. La lecture des étiquettes se fait après. */
  async function collectOpenChat(dayIso) {
    const group = chatName();
    if (!group) { log('Ouvrez d\'abord un groupe dans WhatsApp.'); return null; }
    const groups = (await store.get('groups')) || {};
    if (dayIso < isoOf(new Date())) await loadDay(dayIso);
    const { imgs, docs, extra } = collectDay(dayIso);
    if (!imgs.length && !docs.length) { log(group + ' : rien pour ' + fmt(dayIso) + '.'); return null; }
    const rec = { key: group + '|' + dayIso, group, day: dayIso, colis: null, brvs: {}, zone: '', photos: [], labels: [], docs: [], raw: [], livreur: groups[group] || '', checked: true, status: '', photoHashes: [], photoIds: [], nPhotos: imgs.length + (extra || 0), labelUnread: 0, source: '' };
    results = results.filter(r => r.key !== rec.key);
    results.push(rec);
    for (let i = 0; i < imgs.length && i < 15; i++) {
      let b64;
      try { b64 = imgToB64(imgs[i]); } catch (e) { continue; }
      const ph = hash(b64.slice(0, 4000) + b64.length);
      const pid = imgs[i].__sncId || ('h:' + ph);
      rec.raw.push({ b64, ph });
      if (rec.photos.length < 10) { rec.photos.push(b64); rec.photoHashes.push(ph); rec.photoIds.push(pid); }
    }
    for (const d of docs.slice(0, 3)) {
      const b64 = await capturePdf(d.el);
      if (b64) rec.docs.push({ name: d.name, b64 });
      else log('PDF non récupéré : ' + d.name + ' (téléchargez-le une fois dans WhatsApp puis relancez)');
      await wait(400);
      const viewerClose = $('[data-icon="x-viewer"], [aria-label="Fermer"], [aria-label="Close"]');
      if (viewerClose) fireClick(viewerClose.closest('[role="button"]') || viewerClose);
    }
    renderResults();
    return rec;
  }

  /** Étape 2 (en arrière-plan) : lit les étiquettes (3 à la fois) puis envoie au Sheet. */
  async function processRecord(rec) {
    const cache = (await store.get('ocr')) || {};
    const fresh = {};
    let idx = 0, offline = false;
    const reads = [];
    const worker = async () => {
      while (idx < rec.raw.length && !offline) {
        const { b64, ph } = rec.raw[idx++];
        let d = cache[ph];
        if (!d) {
          const r = await api({ action: 'ocrLabel', b64 });
          if (r.ok) { d = { colis: r.data.colis, brv: r.data.brv, zone: r.data.zone, label: r.data.label, tracks: r.data.tracks || [] }; fresh[ph] = d; }
          else if (r.network) { offline = true; log('Serveur injoignable'); }
        }
        reads.push(d || null);
        if (d && d.zone && !rec.zone) rec.zone = d.zone;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (Object.keys(fresh).length) {
      const c2 = (await store.get('ocr')) || {};
      Object.assign(c2, fresh);
      const keys = Object.keys(c2); if (keys.length > 500) keys.slice(0, keys.length - 400).forEach(k => delete c2[k]);
      await store.set('ocr', c2);
    }
    delete rec.raw;
    const c = countColis(reads, rec.nPhotos);
    rec.colis = c.colis; rec.source = c.source; rec.brvs = c.brvs;
    if (!rec.livreur) rec.livreur = guessCity(rec.group, rec.zone, (await store.get('groups')) || {});
    log(rec.group + ' : ' + rec.photos.length + ' photo(s), ' + rec.docs.length + ' PDF, ' + (rec.colis == null ? 'colis non lus' : rec.colis + ' colis') + '.');
    await sendRecord(rec);                      // envoi automatique au Google Sheet
    return rec;
  }

  /**
   * Nombre de colis du groupe pour le jour :
   *  1) étiquette « BON RETOUR » : son nombre ; la même étiquette sur plusieurs photos compte UNE fois
   *     (même n° BRV, ou même nombre si le BRV n'a pas été lu) ;
   *  2) étiquette présente mais illisible → vide (« à vérifier ») plutôt qu'un chiffre faux ;
   *  3) sinon 1 photo = 1 colis, et le même n° de suivi sur 2 photos = 1 seul colis.
   */
  function countColis(reads, nPhotos) {
    const brvs = {}, loose = {};
    let unread = 0, withTrack = 0;
    const tracks = {};
    reads.forEach(d => {
      if (!d) return;
      const isLabel = d.label !== false && d.colis != null;
      if (isLabel) { if (d.brv) brvs[d.brv] = Math.max(brvs[d.brv] || 0, d.colis); else loose[d.colis] = 1; }
      else if (d.label) unread++;
      else if (d.tracks && d.tracks.length) { withTrack++; d.tracks.forEach(t => { tracks[t] = 1; }); }
    });
    const vals = Object.values(brvs);
    Object.keys(loose).forEach(n => { if (vals.indexOf(+n) < 0) brvs['n' + n] = +n; });
    if (Object.keys(brvs).length) return { colis: Object.values(brvs).reduce((a, b) => a + b, 0), source: 'étiquette', brvs };
    if (unread) return { colis: null, source: 'étiquette illisible – à vérifier', brvs };
    const labelsRead = reads.filter(d => d && d.label !== false && d.colis != null).length;
    const n = Object.keys(tracks).length + Math.max(0, nPhotos - withTrack - labelsRead);
    if (!n) return { colis: null, source: '', brvs };
    return { colis: n, source: 'compté : ' + n + ' colis' + (n !== nPhotos ? ' sur ' + nPhotos + ' photo(s)' : ' (' + nPhotos + ' photo(s))'), brvs };
  }

  /** Lire le groupe ouvert. */
  async function analyseOpenChat(dayIso) {
    const rec = await collectOpenChat(dayIso);
    if (!rec) return 0;
    await processRecord(rec);
    return 1;
  }

  /* ---------------- ouvrir un groupe par son nom ---------------- */
  function fireClick(el) {
    ['mousedown', 'mouseup', 'click'].forEach(t => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
  }
  function findChatInList(name) {
    const span = $$('#pane-side span[title]').find(s => normName(s.getAttribute('title')) === normName(name));
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
    for (let i = 0; i < 25; i++) { await wait(200); if (normName(chatName()) === normName(name)) break; }
    // attendre que les messages et les photos du chat soient affichés (stable 2 fois de suite)
    let last = -1, stable = 0;
    for (let i = 0; i < 16 && stable < 2; i++) {
      await wait(250);
      const n = $$('#main [role="row"]').length * 100 + $$('#main img[src^="blob:"]').length;
      stable = (n === last && n > 0) ? stable + 1 : 0; last = n;
    }
    const box = $('#side div[contenteditable="true"]');
    if (box && box.textContent) { box.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); }
    return normName(chatName()) === normName(name);
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
    const auto = (await store.get('auto')) || { on: true, every: 60 };
    const aLast = (await store.get('autoLast')) || 0;
    const nextAuto = new Date(Math.max(Date.now(), aLast + auto.every * 60000)).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const lastRun = (await store.get('lastRun')) || '—';
    const cityOpts = sel => '<option value="">— Ville / Livreur —</option>' + cities.map(c => '<option' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>').join('');
    panel.innerHTML =
      '<div class="h"><b>⚡ SONICOD · Retours du jour</b><button id="snc-x">✕</button></div><div class="b">' +
      '<label>Jour</label><input type="date" id="snc-day" value="' + (selDay || today) + '">' +
      '<label>Groupe ouvert</label><div class="grp">' + (group ? esc(group) : 'Aucun – ouvrez un groupe retour') + '</div>' +
      (group ? '<label>Ce groupe correspond à</label><select id="snc-city">' + cityOpts(groups[group] || '') + '</select>' : '') +
      '<div class="row"><button class="btn" id="snc-one"' + (group ? '' : ' disabled') + '>Lire ce groupe</button>' +
      '<button class="btn o" id="snc-all"' + (Object.keys(groups).length ? '' : ' disabled') + '>Lire tous mes groupes (' + Object.keys(groups).length + ')</button></div>' +
      '<div class="autobox" style="border:2px solid #CF118B"><b>🤖 Lecture automatique de tous mes groupes</b>' +
      '<select id="snc-every" style="margin-top:6px">' + [[0, 'Désactivée'], [30, 'Toutes les 30 minutes'], [60, 'Toutes les heures'], [120, 'Toutes les 2 heures'], [240, 'Toutes les 4 heures']].map(x =>
        '<option value="' + x[0] + '"' + ((auto.on ? auto.every : 0) === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select>' +
      '<div class="s" style="font-size:12px;color:#6F6680;margin-top:6px">Le bot ouvre lui-même chaque groupe, prend photos + bon PDF + nombre de colis et remplit « Retours en attente ». ' +
      'Il attend que vous n\'utilisiez pas WhatsApp, puis revient sur votre groupe. Laissez ce WhatsApp Web ouvert sur le PC.' +
      (auto.on ? '<br>Prochaine lecture vers ' + esc(nextAuto) : '') + '</div></div>' +
      '<div class="autobox"><label style="margin:0;display:flex;align-items:center;gap:8px;text-transform:none;font-size:13px;color:#1D1428"><input type="checkbox" id="snc-auto" style="width:auto"' + (sched.on ? ' checked' : '') + '> <b>En plus, chaque jour</b> à :</label>' +
      '<div class="times">' + sched.times.map((t, k) => '<span class="tchip">' + esc(t) + ' <a href="#" data-tdel="' + k + '">✕</a></span>').join('') + '</div>' +
      '<div class="row" style="align-items:center;margin-top:6px"><input type="time" id="snc-time" value="00:00" style="max-width:120px"><button class="btn o" id="snc-tadd" style="margin:0;padding:8px">＋ Ajouter l\'heure</button></div>' +
      '<div class="s" style="font-size:12px;color:#6F6680;margin-top:6px">Lit tous mes groupes (hier + aujourd\'hui). Dernière lecture : ' + esc(lastRun) + '</div>' +
      '<button class="btn o" id="snc-now" style="margin-top:8px">Tester maintenant</button></div>' +
      '<button class="btn o" id="snc-diag" style="margin-top:8px">🔍 Diagnostic (ce que le bot voit)</button><pre id="snc-diagout" style="display:none;white-space:pre-wrap;font-size:11.5px;background:#F4F0F8;color:#1D1428;border-radius:8px;padding:8px;margin-top:6px;max-height:240px;overflow:auto"></pre>' +
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
    $('#snc-day').onchange = () => { selDay = $('#snc-day').value || ''; };
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
      if (citySel && !citySel.value && !guessCity(group, '', groups)) { log('⚠ Choisissez d\'abord la ville dans « Ce groupe correspond à ».'); citySel.focus(); return; }
      busy(true); await analyseOpenChat(day); busy(false);
    };
    $('#snc-all').onclick = async () => {
      busy(true); results = []; await runAll([$('#snc-day').value || today]); busy(false); renderPanel();
    };
    const saveSched = async (sc) => { await store.set('sched', sc); chrome.runtime.sendMessage({ type: 'schedule', sched: sc }); };
    $('#snc-auto').onchange = async () => { sched.on = $('#snc-auto').checked; await store.set('lastSlot', Date.now()); await saveSched(sched); log(sched.on ? 'Programmation activée : ' + sched.times.join(', ') : 'Programmation arrêtée.'); };
    $('#snc-every').onchange = async () => {
      const v = +$('#snc-every').value;
      await store.set('auto', v ? { on: true, every: v } : { on: false, every: auto.every || 60 });
      if (v) await store.set('autoLast', 0);
      log(v ? 'Lecture automatique : toutes les ' + v + ' min (première dans moins d\'une minute si vous ne touchez pas WhatsApp).' : 'Lecture automatique arrêtée.');
      renderPanel();
    };
    $('#snc-tadd').onclick = async () => { const t = $('#snc-time').value; if (!/^\d{2}:\d{2}$/.test(t)) return; if (sched.times.indexOf(t) < 0) sched.times.push(t); sched.times.sort(); await saveSched(sched); renderPanel(); };
    $$('[data-tdel]').forEach(a => a.onclick = async e => { e.preventDefault(); sched.times.splice(+a.dataset.tdel, 1); await saveSched(sched); renderPanel(); });
    $('#snc-now').onclick = async () => { busy(true); await scheduledRun(true); busy(false); renderPanel(); };
    $('#snc-save').onclick = saveAll;
    $('#snc-diag').onclick = () => {
      const o = $('#snc-diagout'); const txt = diagnostic();
      o.style.display = 'block'; o.textContent = txt;
      try { navigator.clipboard.writeText(txt); log('Diagnostic copié : collez-le à Claude.'); } catch (e) {}
    };
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

  /** Mémoire « déjà envoyé » : mises à jour une par une (plusieurs groupes sont envoyés en même temps). */
  let sentLock = Promise.resolve();
  function withSent(fn) {
    const run = sentLock.then(async () => { const s = (await store.get('sent')) || {}; const r = fn(s); await store.set('sent', s); return r; });
    sentLock = run.catch(() => {});
    return run;
  }

  /** Envoie au Sheet seulement ce qui est nouveau (photos / PDF pas encore envoyés). */
  async function sendRecord(r) {
    if (!r.livreur) { r.status = 'err'; r.msg = 'Choisissez la ville de ce groupe (menu ci-dessus) puis relisez.'; renderResults(); return; }
    const pid = 'wa-' + hash(r.key);
    const sent = (await store.get('sent')) || {};
    const done = sent[pid] || { p: [], d: [], c: null };
    const photos = [], ph = [];
    r.photos.forEach((b64, i) => {
      const id = (r.photoIds && r.photoIds[i]) || ('h:' + r.photoHashes[i]);
      if (done.p.indexOf(id) < 0 && done.p.indexOf(r.photoHashes[i]) < 0) { photos.push({ b64, id }); ph.push(id); }
    });
    const files = r.docs.filter(d => done.d.indexOf(d.name) < 0).map(d => ({ b64: d.b64, name: d.name, mime: 'application/pdf' }));
    if (done.c === r.colis && !photos.length && !files.length && done.l === r.livreur) { r.status = 'ok'; r.msg = '✓ Déjà à jour dans le Sheet'; renderResults(); return; }
    log('Envoi ' + r.group + ' au Sheet…');
    const brv = Object.keys(r.brvs).filter(k => k.startsWith('BRV'));
    const res = await api({
      action: 'addPending', pid, livreur: r.livreur, colis: r.colis || '', date: r.day, who: 'Bot WhatsApp',
      note: r.group + (r.source ? ' · ' + r.source : '') + (brv.length ? ' · ' + brv.join(', ') : ''), photos, files
    });
    if (res.ok) {
      await withSent(all => {
        const cur = all[pid] || { p: [], d: [], c: null };
        cur.p = cur.p.concat(ph.filter(x => cur.p.indexOf(x) < 0));
        cur.d = cur.d.concat(files.map(f => f.name).filter(x => cur.d.indexOf(x) < 0));
        cur.c = r.colis; cur.l = r.livreur;
        delete all[pid]; all[pid] = cur;                     // le plus récent à la fin
        const keys = Object.keys(all); if (keys.length > 300) keys.slice(0, keys.length - 250).forEach(k => delete all[k]);
      });
      r.status = 'ok';
      if (res.data.docsRefused && res.data.docsRefused.length) log('Bon déjà enregistré, ignoré : ' + res.data.docsRefused.join(', '));
      r.msg = (!res.data.row ? '✓ Déjà dans le Sheet (doublon ignoré)' : (res.data.created ? '✓ Ajouté au Sheet' : '✓ Mis à jour') + ' (ligne ' + res.data.row + ')') + (res.data.skipped ? ' · ' + res.data.skipped + ' doublon(s) ignoré(s)' : '') +
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
    if (!Array.isArray(days)) days = [days];
    const groups = (await store.get('groups')) || {};
    const names = Object.keys(groups);
    const t0 = Date.now();
    const jobs = [];
    let active = 0, found = 0;
    const missing = [];
    for (let i = 0; i < names.length; i++) {
      const g = names[i];
      log('(' + (i + 1) + '/' + names.length + ') ' + g);
      if (await openChat(g)) {
        for (const d of days) {
          const rec = await collectOpenChat(d);
          if (!rec) continue;
          found++;
          // lecture des étiquettes + envoi en arrière-plan pendant qu'on ouvre le groupe suivant
          active++;
          jobs.push(processRecord(rec).catch(e => log('Erreur ' + g + ' : ' + e.message)).finally(() => { active--; }));
          while (active >= 4) await wait(300);
        }
      } else missing.push(g);
    }
    if (active) log('Envoi au Sheet des derniers groupes…');
    await Promise.all(jobs);
    const ok = results.filter(r => r.status === 'ok').length;
    log('✓ Terminé en ' + Math.round((Date.now() - t0) / 1000) + ' s : ' + names.length + ' groupes lus, ' + found + ' retour(s) trouvés, ' + ok + ' à jour dans le Sheet.' +
      (missing.length ? '\n⚠ Introuvables : ' + missing.join(', ') : ''));
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
  /* ---------- lecture automatique régulière (toutes les X minutes), quand vous n'utilisez pas WhatsApp ---------- */
  let lastUserAct = 0;
  ['keydown', 'mousedown', 'wheel', 'touchstart'].forEach(t => document.addEventListener(t, e => {
    if (e.isTrusted && !(e.target && e.target.closest && e.target.closest('#snc-panel, #snc-fab'))) lastUserAct = Date.now();
  }, true));
  async function autoRun(force) {
    const auto = (await store.get('auto')) || { on: true, every: 60 };
    if (autoBusy || (!auto.on && !force)) return;
    if (!$('#pane-side')) return;
    const groups = (await store.get('groups')) || {};
    if (!Object.keys(groups).length) return;
    const last = (await store.get('autoLast')) || 0;
    if (!force && Date.now() - last < auto.every * 60000) return;
    if (!force && Date.now() - lastUserAct < 120000) return;       // vous êtes en train d'utiliser WhatsApp : on attend
    const box = $('#main footer div[contenteditable="true"]');
    if (!force && box && (box.textContent || '').trim()) return;     // message en cours d'écriture
    autoBusy = true;
    await store.set('autoLast', Date.now());
    const before = chatName();
    const today = isoOf(new Date()), yesterday = isoOf(new Date(Date.now() - 86400000));
    const lastDay = await store.get('autoDay');
    log('▶ Lecture automatique (' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + ')');
    try {
      await runAll(lastDay === today ? [today] : [yesterday, today]);
      await store.set('autoDay', today);
      await store.set('lastRun', new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
    } finally {
      autoBusy = false;
      if (before && normName(chatName()) !== normName(before)) { try { await openChat(before); } catch (e) {} }   // on revient sur votre groupe
      if ($('#snc-panel') && $('#snc-panel').style.display === 'block') renderPanel();
    }
  }
  setInterval(() => { scheduledRun(false); autoRun(false); }, 30000);
  chrome.runtime.onMessage.addListener(msg => { if (msg && msg.type === 'scheduled') scheduledRun(false); });

  /* ---------------- démarrage ---------------- */
  async function start() {
    const c = await api({ action: 'config' });
    if (c.ok) cities = c.data.cities || [];
    else log('Serveur : ' + (c.error || 'injoignable'));
    if (!cities.length) cities = ['Agadir', 'BENI MELAL', 'CASA', 'Chtouka', 'EL JADIDA', 'ERRACHIDIA', 'FES', 'IBEX SUD', 'MARRAEKCH', 'OUARZAZAT', 'OUJDA', 'RABAT', 'SAFI', 'Sud', 'TANGER', 'taroudant'];
    // groupes enregistrés par erreur avec la liste des membres au lieu du nom
    const g0 = (await store.get('groups')) || {};
    const bad = Object.keys(g0).filter(looksLikeMembers);
    if (bad.length) {
      bad.forEach(k => delete g0[k]);
      await store.set('groups', g0);
      log('⚠ ' + bad.length + ' groupe(s) mal enregistré(s) (liste des membres au lieu du nom) retiré(s). Ouvrez-le(s) et choisissez la ville à nouveau.');
    }
    ui();
  }
  const t = setInterval(() => { if ($('#side') || $('#pane-side')) { clearInterval(t); start(); } }, 1500);
})();
