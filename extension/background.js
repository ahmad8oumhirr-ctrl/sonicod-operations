// Appels au script Google + réveil programmé du bot (chaque jour aux heures choisies)
const APP_KEY = 'SNC-1b7ae4568269c1f64afde3ce18d9639c';
const DEFAULT_URL = 'https://script.google.com/macros/s/AKfycbwJ1PN16V9WjRuOVN9cky7pKRTyufnSGlPCpw-gi4BKfGoXOQS1kn8pbcrrhPimt4sx/exec';
const WA = 'https://web.whatsapp.com/';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'api') {
    chrome.storage.local.get(['serverUrl'], async (st) => {
      const url = st.serverUrl || DEFAULT_URL;
      try {
        const res = await fetch(url, { method: 'POST', body: JSON.stringify(Object.assign({ key: APP_KEY }, msg.body)), redirect: 'follow' });
        const txt = await res.text();
        try { sendResponse(JSON.parse(txt)); } catch (e) { sendResponse({ ok: false, error: 'Réponse inattendue du serveur (vérifiez le déploiement).' }); }
      } catch (e) {
        sendResponse({ ok: false, network: true, error: 'Pas de connexion : ' + e.message });
      }
    });
    return true;
  }
  if (msg && msg.type === 'schedule') setAlarms(msg.sched);
});

/** Une alarme par heure choisie, répétée chaque jour. */
function setAlarms(sched) {
  chrome.alarms.clearAll(() => {
    if (!sched || !sched.on) return;
    (sched.times || []).forEach(t => {
      const m = /^(\d{2}):(\d{2})$/.exec(t); if (!m) return;
      const now = new Date();
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +m[1], +m[2]);
      if (at <= now) at.setDate(at.getDate() + 1);
      chrome.alarms.create('snc-' + t, { when: at.getTime(), periodInMinutes: 1440 });
    });
  });
}

chrome.runtime.onInstalled.addListener(() => chrome.storage.local.get(['sched'], st => setAlarms(st.sched)));
chrome.runtime.onStartup.addListener(() => chrome.storage.local.get(['sched'], st => setAlarms(st.sched)));

/** À l'heure : on met WhatsApp Web au premier plan (sinon Chrome ralentit l'onglet) et on lance le bot. */
chrome.alarms.onAlarm.addListener(() => {
  chrome.tabs.query({ url: WA + '*' }, tabs => {
    if (tabs && tabs.length) {
      const t = tabs[0];
      chrome.tabs.update(t.id, { active: true }, () => {
        chrome.windows.update(t.windowId, { focused: true }, () => {
          setTimeout(() => chrome.tabs.sendMessage(t.id, { type: 'scheduled' }, () => void chrome.runtime.lastError), 3000);
        });
      });
    } else {
      chrome.tabs.create({ url: WA, active: true, pinned: true });   // le bot démarre tout seul à l'ouverture
    }
  });
});
