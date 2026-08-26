const resultBox = document.getElementById('result');
let busy = false;

function showResult(ok, message) {
  resultBox.textContent = message;
  resultBox.className = `scan-result show ${ok ? 'ok' : 'bad'}`;
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch (e) {}
}

function speakTime(isoTime) {
  try {
    if (!window.speechSynthesis || !isoTime) return;
    const time = new Date(isoTime).toLocaleTimeString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const utterance = new SpeechSynthesisUtterance(`Validado às ${time}`);
    utterance.lang = 'pt-BR';
    window.speechSynthesis.speak(utterance);
  } catch (e) {}
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
    playBeep();
    speakTime(data.usedAt);
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
