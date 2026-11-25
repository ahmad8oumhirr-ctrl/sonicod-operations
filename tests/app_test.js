// Test complet de l'application sur émulateur Android : la WebView est pilotée via le protocole DevTools.
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const OUT = process.env.OUT || 'results';
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => { const l = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(l); fs.appendFileSync(OUT + '/app_test.txt', l + '\n'); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

(async () => {
  let target;
  for (let i = 0; i < 30 && !target; i++) {
    try { const list = await getJson('http://127.0.0.1:9222/json/list'); target = list.find(t => t.type === 'page' && /appassets/.test(t.url)); } catch (e) {}
    if (!target) await wait(2000);
  }
  if (!target) { log('ECHEC: WebView introuvable'); process.exit(1); }
  log('Cible:', target.url);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  let id = 0; const pending = {};
  ws.on('message', m => { const d = JSON.parse(m); if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; } if (d.method === 'Runtime.exceptionThrown') log('EXCEPTION JS', d.params.exceptionDetails.text, d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') log('console.error', d.params.args.map(a => a.value || a.description).join(' ')); });
  const send = (method, params = {}) => new Promise(r => {
    const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending[i]) { delete pending[i]; log('DÉLAI DÉPASSÉ: ' + method); r({ result: { result: { value: null } } }); } }, 25000);
  });
  await send('Runtime.enable');
  await send('Page.enable');
  const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) return 'ERREUR: ' + (r.result.exceptionDetails.exception || {}).description; return r.result.result.value; };
  const shot = async n => {
    await wait(900);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(r.result.data, 'base64'));
    else require('child_process').execSync(`adb exec-out screencap -p > ${OUT}/${n}.png`);
  };
  const click = sel => js(`(function(){var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'absent: ${sel}'; e.click(); return 'ok';})()`);
  const setVal = (sel, v) => js(`(function(){var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'absent'; e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); return 'ok';})()`);
  const toast = () => js(`document.querySelector('#toast').textContent`);
  const lastScan = () => js(`(JSON.parse(localStorage.scans||'[]')[0]||null)`);

  await wait(3000);
  log('INFO natif:', await js('SonicodNative.getInfo()'));
  log('Écran initial:', await js(`document.querySelector('#topTitle').textContent`));
  await shot('01_operation');

  // Paramètres → ping serveur
  await click('.nav [data-go="settings"]'); await wait(500);
  await click('#sSave');
  for (let i = 0; i < 20; i++) { await wait(1000); const t = await toast(); if (/Connecté|injoignable|invalide|Enregistré|autoris|inattendue/i.test(t)) break; }
  log('PING (Paramètres):', await toast());
  await shot('02_parametres');
  log('Villes chargées:', await js(`(JSON.parse(localStorage.config||'{}').cities||[]).length`));

  // Validation : envoyer formulaire vide
  await click('.nav [data-go="op"]'); await wait(500);
  await click('#send'); await wait(500);
  log('Validation vide → erreurs:', await js(`[].map.call(document.querySelectorAll('.field.err .msg'),function(e){return e.textContent})`));

  // Nouvelle opération test
  await setVal('#livreur', 'CASA'); await setVal('#colis', '1');
  const d2 = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  await setVal('#dateEnvoi', d2); await setVal('#note', 'TEST CLAUDE APP – A SUPPRIMER');
  await click('#statuts .seg-btn:nth-child(1)');
  await shot('03_operation_remplie');
  await click('#send');
  for (let i = 0; i < 60; i++) { await wait(1000); if (await js(`!!document.querySelector('#share')`)) break; }
  log('OPERATION:', await js(`document.querySelector('#topTitle').textContent + ' | ' + (document.querySelector('#view .card')||{}).innerText`));
  await shot('04_succes');

  // Scanner : saisie manuelle + doublon
  await click('.nav [data-go="scan"]'); await wait(800);
  const code = 'TESTAPP' + Date.now().toString().slice(-7);
  await setVal('#manual', code); await click('#manualB');
  for (let i = 0; i < 40; i++) { await wait(1000); const s = await lastScan(); if (s && s.status !== 'wait') break; }
  log('SCAN 1:', await lastScan());
  await setVal('#manual', code); await click('#manualB'); await wait(1500);
  log('SCAN 2 (doublon attendu):', await lastScan());
  log('Colis du lot:', await js(`document.querySelector('#sessN').textContent`));
  log('Bouton Terminer actif:', await js(`!document.querySelector('#finishB').disabled`));
  await shot('05_scanner');

  // Retours des groupes (En attente)
  await click('.nav [data-go="attente"]');
  for (let i = 0; i < 20; i++) { await wait(1000); const t = await js(`document.querySelector('#topSub').textContent`); if (/attente|bot/.test(t)) break; }
  log('EN ATTENTE:', await js(`document.querySelector('#topSub').textContent + ' | ' + (document.querySelector('#pList')||{}).innerText.slice(0,300)`));
  await shot('06_en_attente');

  // Retour Sorties
  await click('.nav [data-go="sorties"]'); await wait(500);
  await click('#soSend'); await wait(400); log('Retour Sorties sans photo →', await toast());
  await shot('07_retour_sorties');

  // Mode sombre
  await click('.nav [data-go="settings"]'); await wait(300); await click('#themes .chip:nth-child(3)');
  await click('.nav [data-go="op"]'); await shot('08_sombre_operation');
  await click('.nav [data-go="scan"]'); await shot('09_sombre_scanner');
  await click('.nav [data-go="settings"]'); await wait(300); await click('#themes .chip:nth-child(1)');
  log('FIN DU TEST');
  ws.close(); process.exit(0);
})().catch(e => { log('ERREUR TEST', e.stack || e.message); process.exit(1); });
