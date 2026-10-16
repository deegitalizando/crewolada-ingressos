/* Fundo da identidade Crewolada: pontilhado, coroa fantasma e icones flutuantes
   (coroa, cruz, biblia, notas, fones, vinil). Entra sozinho nas paginas publicas. */
(function () {
  var body = document.body;
  if (!body || body.getAttribute('data-fx') === 'off') return;
  if (document.querySelector('.tabs-row, .page-wide') || /^\/(admin|contabilidade|downloads|validador)/.test(location.pathname)) return;

  var css = [
    '.crew-bg{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden}',
    '.crew-bg .cd{position:absolute;top:0;right:0;width:68vw;height:44vh;max-width:520px;opacity:.5;',
    'background:radial-gradient(circle,rgba(255,255,255,.55) 0 1.1px,transparent 1.8px) 0 0/10px 10px;',
    '-webkit-mask-image:linear-gradient(225deg,#000,transparent 72%);mask-image:linear-gradient(225deg,#000,transparent 72%)}',
    '.crew-bg .ghost{position:absolute;left:-14vw;top:42vh;width:min(60vw,360px);height:min(60vw,360px);color:#E5A71B;opacity:.06;transform:rotate(-8deg)}',
    '.crew-bg .f{position:absolute;color:var(--c,#E5A71B);opacity:var(--o,.22)}',
    '.crew-bg .f svg{display:block;width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 0 8px currentColor);animation:crewfloat var(--d,8s) ease-in-out var(--dl,0s) infinite alternate}',
    '.crew-bg .f.spin svg{animation:crewspin var(--d,16s) linear infinite;filter:none}',
    '@keyframes crewfloat{from{transform:translateY(0) rotate(calc(var(--r,6deg)*-1))}to{transform:translateY(-18px) rotate(var(--r,6deg))}}',
    '@keyframes crewspin{to{transform:rotate(360deg)}}',
    '@media (prefers-reduced-motion:reduce){.crew-bg .f svg{animation:none!important}}'
  ].join('');
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var sym = {
    cross: '<path d="M27 5h10v17h17v10H37v27H27V32H10V22h17z" fill="currentColor" fill-opacity=".1"/>',
    crown: '<path d="M7 46 11 19l13 13 8-18 8 18 13-13 4 27z" fill="currentColor" fill-opacity=".1"/><path d="M7 53h50"/><circle cx="11" cy="17" r="3" fill="currentColor"/><circle cx="32" cy="12" r="3" fill="currentColor"/><circle cx="53" cy="17" r="3" fill="currentColor"/>',
    bible: '<path d="M32 17C24 11 14 11 6 14v35c8-3 18-3 26 3 8-6 18-6 26-3V14c-8-3-18-3-26 3z" fill="currentColor" fill-opacity=".1"/><path d="M32 17v35M46 22v15M40 27h12"/>',
    note: '<path d="M26 46V12l24-6v32"/><path d="M26 22l24-6" stroke-width="4"/><ellipse cx="19" cy="47" rx="8" ry="6" fill="currentColor" transform="rotate(-18 19 47)"/><ellipse cx="43" cy="39" rx="8" ry="6" fill="currentColor" transform="rotate(-18 43 39)"/>',
    note1: '<path d="M28 48V10c0 14 20 12 20 30" stroke-width="2.8"/><ellipse cx="21" cy="49" rx="9" ry="6.5" fill="currentColor" transform="rotate(-18 21 49)"/>',
    phones: '<path d="M10 42V32a22 22 0 0 1 44 0v10"/><rect x="6" y="38" width="12" height="18" rx="4" fill="currentColor" fill-opacity=".15"/><rect x="46" y="38" width="12" height="18" rx="4" fill="currentColor" fill-opacity=".15"/>',
    vinyl: '<circle cx="32" cy="32" r="28"/><circle cx="32" cy="32" r="20" opacity=".6" stroke-width="1.2"/><circle cx="32" cy="32" r="13" opacity=".6" stroke-width="1.2"/><circle cx="32" cy="32" r="7" fill="currentColor" fill-opacity=".25"/>'
  };
  var PINK = '#FF1F8E', BLUE = '#1E90FF';
  // [icone, left, top, tamanho, cor, rotacao, duracao, atraso, opacidade, giratorio]
  var items = [
    ['cross', '5%', '12%', 30, null, 10, 8, -2, .2], ['note1', '86%', '20%', 28, PINK, -12, 6, -1, .3],
    ['crown', '90%', '46%', 40, null, 8, 9, -4, .2], ['note', '3%', '46%', 36, BLUE, -8, 7, -3, .26],
    ['vinyl', '80%', '70%', 58, null, 0, 16, 0, .16, 1], ['bible', '8%', '72%', 38, null, 9, 8, -5, .2],
    ['phones', '48%', '86%', 32, null, -10, 7, -2, .18], ['cross', '72%', '6%', 24, null, 12, 6, -3, .22],
    ['note1', '30%', '92%', 24, PINK, -6, 5, -1, .3]
  ];
  var html = '<div class="cd"></div><svg class="ghost" viewBox="0 0 64 64" style="fill:none;stroke:currentColor;stroke-width:1.4;stroke-linejoin:round">' + sym.crown + '</svg>';
  items.forEach(function (it) {
    html += '<span class="f' + (it[9] ? ' spin' : '') + '" style="left:' + it[1] + ';top:' + it[2] + ';width:' + it[3] + 'px;height:' + it[3] + 'px;' +
      (it[4] ? '--c:' + it[4] + ';' : '') + '--r:' + it[5] + 'deg;--d:' + it[6] + 's;--dl:' + it[7] + 's;--o:' + it[8] + '"><svg viewBox="0 0 64 64">' + sym[it[0]] + '</svg></span>';
  });
  var bg = document.createElement('div'); bg.className = 'crew-bg'; bg.setAttribute('aria-hidden', 'true'); bg.innerHTML = html;
  body.insertBefore(bg, body.firstChild);
})();
