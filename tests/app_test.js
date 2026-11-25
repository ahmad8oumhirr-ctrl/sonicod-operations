// Test complet de l'application sur émulateur Android (WebView pilotée via DevTools)
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const OUT = process.env.OUT || 'results';
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => { const l = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(l); fs.appendFileSync(OUT + '/app_test.txt', l + '\n'); };
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let browser;
  for (let i = 0; i < 20 && !browser; i++) {
    try { browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null }); } catch (e) { await wait(2000); }
  }
  if (!browser) { log('ECHEC: impossible de se connecter à la WebView'); process.exit(1); }
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes('appassets')) || pages[0];
  log('URL', page.url());
  page.on('console', m => log('console.' + m.type(), m.text()));
  page.on('pageerror', e => log('PAGEERROR', e.message));
  const shot = async n => { await wait(800); const b64 = await page.screenshot({ encoding: 'base64' }); fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(b64, 'base64')); };
  const toastText = () => page.$eval('#toast', e => e.textContent).catch(() => '');
  const click = sel => page.$eval(sel, e => e.click());

  // 1) Démarrage
  await wait(4000);
  log('info', await page.evaluate(() => SonicodNative.getInfo()));
  await shot('01_operation');

  // 2) Paramètres → test connexion serveur (ping)
  await click('.nav [data-go="settings"]'); await wait(500);
  await click('#sSave'); await wait(8000);
  log('PING:', await toastText());
  await shot('02_parametres');
  log('CONFIG villes:', await page.evaluate(() => (JSON.parse(localStorage.config || '{}').cities || []).length));

  // 3) Nouvelle opération (test, sans photo)
  await click('.nav [data-go="op"]'); await wait(500);
  await page.select('#livreur', 'CASA');
  await page.$eval('#colis', e => { e.value = '1'; e.dispatchEvent(new Event('input')); });
  await page.$eval('#dateEnvoi', e => { const d = new Date(); d.setDate(d.getDate() - 2); e.value = d.toISOString().slice(0, 10); e.dispatchEvent(new Event('input')); });
  await page.$eval('#note', e => { e.value = 'TEST CLAUDE – A SUPPRIMER'; e.dispatchEvent(new Event('input')); });
  await click('#statuts .seg-btn:nth-child(1)');
  await shot('03_operation_remplie');
  await click('#send');
  for (let i = 0; i < 40; i++) { await wait(1000); if (await page.$('#share')) break; }
  log('OPERATION:', await page.$eval('#topTitle', e => e.textContent), '|', await page.$eval('#view .card', e => e.innerText).catch(() => ''));
  await shot('04_succes');

  // 4) Scanner (saisie manuelle) + doublon
  await click('.nav [data-go="scan"]'); await wait(800);
  const code = 'TESTCLAUDE' + Date.now().toString().slice(-6);
  await page.$eval('#manual', (e, c) => { e.value = c; }, code); await click('#manualB');
  for (let i = 0; i < 30; i++) { await wait(1000); const st = await page.evaluate(() => (JSON.parse(localStorage.scans || '[]')[0] || {}).status); if (st && st !== 'wait') break; }
  log('SCAN 1:', await page.evaluate(() => JSON.parse(localStorage.scans || '[]')[0]));
  await page.$eval('#manual', (e, c) => { e.value = c; }, code); await click('#manualB'); await wait(1500);
  log('SCAN 2 (doublon attendu):', await page.evaluate(() => JSON.parse(localStorage.scans || '[]')[0]));
  await shot('05_scanner');

  // 5) Retour Sorties + mode sombre
  await click('.nav [data-go="sorties"]'); await shot('06_retour_sorties');
  await click('.nav [data-go="settings"]'); await wait(300); await click('#themes .chip:nth-child(3)');
  await click('.nav [data-go="op"]'); await shot('07_sombre_operation');
  await click('.nav [data-go="scan"]'); await shot('08_sombre_scanner');
  log('FIN DU TEST');
  browser.disconnect();
})().catch(e => { log('ERREUR TEST', e.stack || e.message); process.exit(1); });
