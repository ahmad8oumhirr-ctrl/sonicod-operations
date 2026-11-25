/* Ouvre le scanner intégré sur l'émulateur, vérifie qu'il s'affiche (caméra), puis Retour → « annulé ». */
const WebSocket = require('ws'); const http = require('http'); const fs = require('fs'); const cp = require('child_process');
const OUT = process.env.OUT || 'results';
const log = (...a) => { const l = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(l); fs.appendFileSync(OUT + '/scan_test.txt', l + '\n'); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
const sh = c => { try { return cp.execSync(c, { encoding: 'utf8' }).trim(); } catch (e) { return 'ERR ' + (e.stderr || e.message); } };
(async () => {
  let target;
  for (let i = 0; i < 20 && !target; i++) { try { target = (await getJson('http://127.0.0.1:9222/json/list')).find(t => t.type === 'page' && /appassets/.test(t.url)); } catch (e) {} if (!target) await wait(2000); }
  if (!target) { log('ECHEC: WebView introuvable'); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => ws.on('open', r));
  let id = 0; const pending = {};
  ws.on('message', m => { const d = JSON.parse(m); if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; } });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pending[i]) { delete pending[i]; r({ result: { result: { value: 'DÉLAI' } } }); } }, 60000); });
  await send('Runtime.enable');
  const js = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result.exceptionDetails ? 'ERREUR ' + JSON.stringify(r.result.exceptionDetails) : r.result.result.value; };
  log('autorisation caméra:', sh('adb shell pm grant ma.sonicod.operations android.permission.CAMERA') || 'ok');
  await js(`window.__scanRes=null;(function(){var id='s'+Date.now();var o=window.__nativeCb;window.__nativeCb=function(i,j){if(i===id){window.__nativeCb=o;window.__scanRes=j;}else o(i,j);};SonicodNative.scanBarcode(id);})()`);
  await wait(6000);
  log('activité au premier plan:', sh(`adb shell "dumpsys activity activities | grep -m1 -E 'mResumedActivity|topResumedActivity'"`));
  cp.execSync(`adb exec-out screencap -p > ${OUT}/11_scanner_integre.png`);
  sh('adb shell input keyevent KEYCODE_BACK');
  await wait(2500);
  log('réponse après Retour:', await js('window.__scanRes'));
  // couleurs : style Sonicod par défaut
  log('style:', await js(`document.documentElement.getAttribute('data-pal')`));
  cp.execSync(`adb exec-out screencap -p > ${OUT}/12_couleurs.png`);
  log('FIN TEST SCANNER');
  process.exit(0);
})();
