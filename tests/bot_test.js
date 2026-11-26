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
  await js(`SonicodNative.botSetBlocked(JSON.stringify(['Karim']))`);
  await js(`SonicodNative.botSetEnabled(true)`);   // les photos de Karim ne doivent pas être prises
  await wait(3000);
  let st = JSON.parse(await js('SonicodNative.botStatus()'));
  log('statut:', { notif: st.notif, files: st.files, dossierWhatsApp: st.whatsappFolder, ignorés: st.blocked });

  const D = 'files/wa-test/Media';   // en test : dossier privé de l'app (en vrai : dossier WhatsApp choisi par l'utilisateur)
  const RA = c => { try { return cp.execFileSync('adb', ['shell', `run-as ${P} sh -c '${c}'`], { encoding: 'utf8' }).trim(); } catch (e) { return 'ERR ' + (e.stderr || e.message); } };
  log('dossier créé:', RA(`mkdir -p "${D}/WhatsApp Business Images" "${D}/WhatsApp Business Documents" && ls "${D}"`));
  st = JSON.parse(await js('SonicodNative.botStatus()'));
  log('dossier WhatsApp trouvé:', st.whatsappFolder);

  // notification de groupe : une photo + un bon PDF ; et une autre d'un groupe non suivi
  log('notif 1:', sh(`adb shell "cmd notification post -S messaging --conversation 'Retour CASA Sonicod' --message 'Ahmed:📷 2 colis retour' --message 'Ahmed:📄 BRV-2026112500123.pdf' casa1 'x'"`));
  await wait(1500);
  log('notif Karim (ignoré):', sh(`adb shell "cmd notification post -S messaging --conversation 'Retour CASA Sonicod' --message 'Karim:📷 Photo' casa2 'x'"`));
  log('notif privée:', sh(`adb shell "cmd notification post -S messaging --conversation '' --message 'Youssef:📷 Photo' prive1 'x'"`));
  log('notif 2:', sh(`adb shell "cmd notification post -S messaging --conversation 'Famille' --message 'Ali:📷 Photo' fam1 'x'"`));
  await wait(3000);
  sh('adb push test.jpg /data/local/tmp/k.jpg'); sh('adb shell chmod 644 /data/local/tmp/k.jpg');
  sh('adb push label.jpg /data/local/tmp/l.jpg'); sh('adb push bon.pdf /data/local/tmp/b.pdf'); sh('adb shell chmod 644 /data/local/tmp/l.jpg /data/local/tmp/b.pdf');
  RA(`cp /data/local/tmp/k.jpg "${D}/WhatsApp Business Images/IMG-20261125-WA0001.jpg" && cp /data/local/tmp/b.pdf "${D}/WhatsApp Business Documents/BRV-2026112500123.pdf" && sleep 2 && cp /data/local/tmp/l.jpg "${D}/WhatsApp Business Images/IMG-20261126-WA0002.jpg" && sleep 3 && cp /data/local/tmp/k.jpg "${D}/WhatsApp Business Images/IMG-20261126-WA0003.jpg" && sleep 3 && cp /data/local/tmp/k.jpg "${D}/WhatsApp Business Images/IMG-20261126-WA0004.jpg" && sleep 3 && cp /data/local/tmp/k.jpg "${D}/WhatsApp Business Images/IMG-20261126-WA0005.jpg"`);
  st = JSON.parse(await js('SonicodNative.botStatus()'));
  log('groupes vus (non suivis):', (st.seen || []).map(x => x.name), '| en attente de fichier:', st.waiting);
  await wait(15000);
  log('PASSAGE DU BOT…');
  log('résultat:', await natRun());
  st = JSON.parse(await js('SonicodNative.botStatus()'));
  log('JOURNAL:\n' + (st.log || []).join('\n'));
  // photo arrivée SANS notification (WA0003) : doit apparaître dans « Reçu sans notification »
  await wait(100000);
  log('passage après 90 s:', await natRun());
  st = JSON.parse(await js('SonicodNative.botStatus()'));
  log('SANS NOTIFICATION:', (st.orphans || []).map(o => o.n));
  await js(`SonicodNative.botAssignOrphans(JSON.stringify(${JSON.stringify((st.orphans || []).map(o => o.u))}), 'Retour CASA Sonicod')`);
  log('après choix du groupe:', await natRun());
  st = JSON.parse(await js('SonicodNative.botStatus()'));
  log('JOURNAL après choix:', (st.log || []).slice(-3), '| reste sans groupe:', (st.orphans || []).length);
  log('2e passage (rien de nouveau attendu):', await natRun());
  st = JSON.parse(await js('SonicodNative.botStatus()'));
  log('JOURNAL fin:', (st.log || []).slice(-2));
  await js(`(function(){location.hash='';document.querySelector('[data-go="attente"]').click();setTimeout(function(){var b=document.querySelector('#goBot');if(b)b.click();},800);})()`);
  await wait(2500);
  cp.execSync(`adb exec-out screencap -p > ${OUT}/10_bot.png`);
  log('FIN TEST BOT');
  process.exit(0);
})();
