const resultBox = document.getElementById('result');
let busy = false;

function showResult(ok, message) {
  resultBox.textContent = message;
  resultBox.className = `scan-result show ${ok ? 'ok' : 'bad'}`;
}

async function validateCode(code) {
  if (busy || !code) return;
  busy = true;
  try {
    const res = await fetch('/api/validar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    const ok = data.result === 'valido';
    const extra = data.buyerName ? ` (${data.buyerName})` : '';
    showResult(ok, `${data.message || ''}${extra}`);
  } catch (err) {
    showResult(false, 'Erro ao validar. Tente novamente.');
  } finally {
    setTimeout(() => {
      busy = false;
    }, 1500);
  }
}

const manualForm = document.getElementById('manual-form');
manualForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('manual-code');
  const code = input.value.trim().toUpperCase();
  validateCode(code);
  input.value = '';
});

if (window.Html5Qrcode) {
  const scanner = new Html5Qrcode('reader');
  Html5Qrcode.getCameras()
    .then((cameras) => {
      if (!cameras || !cameras.length) return;
      const cameraId = cameras.find((c) => /back|traseira|rear/i.test(c.label))?.id || cameras[0].id;
      scanner.start(
        cameraId,
        { fps: 10, qrbox: 220 },
        (decodedText) => {
          const code = decodedText.trim().toUpperCase();
          validateCode(code);
        },
        () => {}
      );
    })
    .catch(() => {
      showResult(false, 'Camera indisponivel. Use o campo manual abaixo.');
    });
}
