// Gmail voice attach: adds a record button next to "Send" in every compose window;
// the recording is attached to that message as an audio file.
(() => {
  const MAX_SECONDS = 600;
  const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';

  const MP3_RATE = 22050, MP3_KBPS = 48; // mono speech: ~360 KB per minute

  // Recorded WebM/Opus -> mono 22.05 kHz -> MP3 (lamejs). Encodes in slices and yields
  // between them so a long recording does not freeze Gmail.
  async function toMp3(blob) {
    const ctx = new AudioContext();
    let decoded;
    try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close(); }
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * MP3_RATE), MP3_RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const pcm = (await off.startRendering()).getChannelData(0);

    const enc = new lamejs.Mp3Encoder(1, MP3_RATE, MP3_KBPS);
    const parts = [], BLOCK = 1152, SLICE = MP3_RATE * 5;
    for (let start = 0; start < pcm.length; start += SLICE) {
      const end = Math.min(start + SLICE, pcm.length);
      const ints = new Int16Array(end - start);
      for (let i = start; i < end; i++) {
        const v = Math.max(-1, Math.min(1, pcm[i]));
        ints[i - start] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      for (let i = 0; i < ints.length; i += BLOCK) {
        const out = enc.encodeBuffer(ints.subarray(i, i + BLOCK));
        if (out.length) parts.push(out);
      }
      await new Promise(r => setTimeout(r));
    }
    const tail = enc.flush();
    if (tail.length) parts.push(tail);
    return new Blob(parts, { type: 'audio/mpeg' });
  }

  const fmt = s =>Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

  // The compose root is the nearest ancestor that owns Gmail's hidden attachment input.
  function composeRoot(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.querySelector('input[type=file][name="Filedata"]')) return n;
    }
    return null;
  }

  // Attach through Gmail's own file input; fall back to a synthetic drop on the message body.
  function attach(root, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = root.querySelector('input[type=file][name="Filedata"]');
    if (input) {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const body = root.querySelector('div[contenteditable="true"][role="textbox"]');
    if (!body) throw new Error('no compose body');
    ['dragenter', 'dragover', 'drop'].forEach(type =>
      body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })));
  }

  function addButton(sendBtn) {
    const cell = sendBtn.closest('td') || sendBtn.parentElement;
    if (!cell || cell.querySelector('.gva-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gva-btn';
    btn.textContent = 'הקלטה';
    btn.title = 'הקלט הודעה קולית וצרף אותה לאימייל';
    cell.append(btn);

    let recorder = null, timer = 0, seconds = 0;
    const stop = () => recorder && recorder.state === 'recording' && recorder.stop();

    btn.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      if (recorder) { stop(); return; }

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        alert('אין גישה למיקרופון. יש לאשר גישה למיקרופון עבור mail.google.com.');
        return;
      }
      const chunks = [];
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = ev => ev.data.size && chunks.push(ev.data);
      recorder.onstop = async () => {
        clearInterval(timer);
        stream.getTracks().forEach(t => t.stop());
        btn.classList.remove('rec');
        if (!chunks.length) { recorder = null; btn.textContent = 'הקלטה'; return; }
        btn.disabled = true;
        btn.textContent = 'ממיר ל-MP3…';
        const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
        const root = composeRoot(btn);
        try {
          if (!root) throw new Error('no compose root');
          let file;
          try {
            file = new File([await toMp3(new Blob(chunks, { type: chunks[0].type }))], `הקלטה_${stamp}.mp3`, { type: 'audio/mpeg' });
          } catch {
            // Conversion failed: attach the original recording rather than losing it.
            const type = chunks[0].type || 'audio/webm';
            file = new File(chunks, `הקלטה_${stamp}.${type.includes('ogg') ? 'ogg' : 'webm'}`, { type });
          }
          attach(root, file);
        } catch {
          alert('לא הצלחתי לצרף את ההקלטה לאימייל.');
        } finally {
          recorder = null;
          btn.disabled = false;
          btn.textContent = 'הקלטה';
        }
      };

      recorder.start(1000);
      seconds = 0;
      btn.classList.add('rec');
      btn.textContent = 'עצור 0:00';
      timer = setInterval(() => {
        seconds++;
        btn.textContent = 'עצור ' + fmt(seconds);
        if (seconds >= MAX_SECONDS) stop();
      }, 1000);
    });
  }

  // Compose windows appear and disappear dynamically; the Send button marks each one.
  const scan = () => document.querySelectorAll('div[role="button"].T-I.aoO').forEach(addButton);
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; scan(); });
  }).observe(document.body, { childList: true, subtree: true });
  scan();
})();
