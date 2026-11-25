// Appels au script Google depuis l'extension (évite les blocages CORS de la page WhatsApp)
const APP_KEY = 'SNC-1b7ae4568269c1f64afde3ce18d9639c';
const DEFAULT_URL = 'https://script.google.com/macros/s/AKfycbwJ1PN16V9WjRuOVN9cky7pKRTyufnSGlPCpw-gi4BKfGoXOQS1kn8pbcrrhPimt4sx/exec';

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
    return true; // réponse asynchrone
  }
});
