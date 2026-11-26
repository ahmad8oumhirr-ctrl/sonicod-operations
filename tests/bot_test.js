/* Test du bot téléphone sur l'émulateur : notification « WhatsApp » simulée + fichiers dans le dossier WhatsApp Business. */
const WebSocket = require('ws'); const http = require('http'); const fs = require('fs'); const cp = require('child_process');
const OUT = process.env.OUT || 'results';
const log = (...a) => { const l = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(l); fs.appendFileSync(OUT + '/bot_test.txt', l + '\n'); };
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
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pending[i]) { delete pending[i]; r({ result: { result: { value: 'DÉLAI' } } }); } }, 240000); });
  await send('Runtime.enable');
  const js = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result.exceptionDetails ? 'ERREUR ' + JSON.stringify(r.result.exceptionDetails) : r.result.result.value; };
  const natRun = () => js(`new Promise(function(res){var id='t'+Date.now();var o=window.__nativeCb;window.__nativeCb=function(i,j){if(i===id){window.__nativeCb=o;res(j);}else o(i,j);};SonicodNative.botRun(id);})`);

  const P = 'ma.sonicod.operations.bot';
  log('autorisation notifications:', sh(`adb shell cmd notification allow_listener ${P}/ma.sonicod.operations.WaListener`) || 'ok');
  await js(`SonicodNative.botTestMode(true)`);
  await js(`SonicodNative.botSetGroups(JSON.stringify({'Retour CASA Sonicod':'CASA'}))`);
  await wait(3000);
  let st = JSON.parse(await js('SonicodNative.botStatus()'));
  log('statut:', { notif: st.notif, files: st.files, dossierWhatsApp: st.whatsappFolder });

  const D = '/sdcard/Android/data/' + P + '/files/wa-test/Media';   // en test : dossier de l'app (en vrai : dossier choisi par l'utilisateur)
  sh(`adb shell "mkdir -p '${D}/WhatsApp Business Images' '${D}/WhatsApp Business Documents'"`);
  log('dossier créé:', sh(`adb shell "ls '${D}'"`));
  st = JSON.parse(await js('SonicodNative.botStatus()'));
  log('dossier WhatsApp trouvé:', st.whatsappFolder);

  // notification de groupe : une photo + un bon PDF ; et une autre d'un groupe non suivi
  log('notif 1:', sh(`adb shell "cmd notification post -S messaging --conversation 'Retour CASA Sonicod' --message 'Ahmed:📷 Photo' --message 'Ahmed:📄 BRV-2026112500123.pdf' casa1 'x'"`));
  log('notif privée:', sh(`adb shell "cmd notification post -S messaging --conversation '' --message 'Youssef:📷 Photo' prive1 'x'"`));
  log('notif 2:', sh(`adb shell "cmd notification post -S messaging --conversation 'Famille' --message 'Ali:📷 Photo' fam1 'x'"`));
  await wait(3000);
  sh(`adb push label.jpg "${D}/WhatsApp Business Images/IMG-20261125-WA0001.jpg"`);
  sh(`adb push bon.pdf "${D}/WhatsApp Business Documents/BRV-2026112500123.pdf"`);
  sh(`adb shell "touch '${D}/WhatsApp Business Images/IMG-20261125-WA0001.jpg' '${D}/WhatsApp Business Documents/BRV-2026112500123.pdf'"`);
  log('push:', sh(`adb shell "ls '${D}/WhatsApp Business Images'"`)); log('fichiers:', sh(`adb shell "ls -l '${D}/WhatsApp Business Images' '${D}/WhatsApp Business Documents'"`));
  st = JSON.parse(await js('SonicodNative.botStatus()'));
  log('groupes vus (non suivis):', (st.seen || []).map(x => x.name), '| en attente de fichier:', st.waiting);
  await wait(15000);
  log('PASSAGE DU BOT…');
  log('résultat:', await natRun());
  st = JSON.parse(await js('SonicodNative.botStatus()'));
  log('JOURNAL:\n' + (st.log || []).join('\n'));
  log('2e passage (rien de nouveau attendu):', await natRun());
  st = JSON.parse(await js('SonicodNative.botStatus()'));
  log('JOURNAL fin:', (st.log || []).slice(-2));
  await js(`(function(){location.hash='';document.querySelector('[data-go="attente"]').click();setTimeout(function(){var b=document.querySelector('#goBot');if(b)b.click();},800);})()`);
  await wait(2500);
  cp.execSync(`adb exec-out screencap -p > ${OUT}/10_bot.png`);
  log('FIN TEST BOT');
  process.exit(0);
})();
