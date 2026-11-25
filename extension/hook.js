// Monde « MAIN » de WhatsApp Web : récupère les PDF quand le bot clique dessus (sans les télécharger sur le disque).
(function () {
  let capture = false;
  const orig = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    try {
      if (capture && obj instanceof Blob && (obj.type === 'application/pdf' || obj.size > 1000 && obj.type === '')) {
        window.postMessage({ __snc: 'blob', blob: obj }, '*');
      }
    } catch (e) {}
    return orig.apply(this, arguments);
  };
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (capture && this.hasAttribute('download')) return;   // pas de téléchargement pendant la lecture du bot
    return origClick.apply(this, arguments);
  };
  window.addEventListener('message', e => {
    if (e.source === window && e.data && e.data.__snc === 'capture') capture = !!e.data.on;
  });
})();
