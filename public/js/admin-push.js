/* Painel admin: toca o som de caixa registradora quando chega uma notificacao de venda
   e o painel esta aberto na tela. Nao faz nada fora das paginas do admin. */
(function () {
  if (!document.querySelector('.tabs-row')) return;
  var audio = new Audio('/audio/venda.mp3');
  audio.preload = 'auto';
  var liberado = false;

  // Browsers only allow sound after a touch/click on the page: unlock it on the first one.
  function liberar() {
    if (liberado) return;
    audio.muted = true;
    var p = audio.play();
    var pronto = function () { audio.pause(); audio.currentTime = 0; audio.muted = false; liberado = true; };
    if (p && p.then) p.then(pronto).catch(function () { audio.muted = false; }); else pronto();
  }
  ['touchstart', 'click', 'keydown'].forEach(function (ev) { document.addEventListener(ev, liberar, { once: true, passive: true }); });

  window.tocarSomVenda = function () { try { audio.currentTime = 0; return audio.play(); } catch (e) { return Promise.reject(e); } };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'venda') window.tocarSomVenda().catch(function () {});
    });
  }
})();
