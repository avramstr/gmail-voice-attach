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

  // The message body of the compose window holding el. Gmail marks it g_editable; the other
  // selectors are fallbacks in case that changes.
  const BODY_SEL = '[g_editable="true"], div.editable[contenteditable="true"], div[contenteditable="true"][role="textbox"]';
  function composeBody(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const b = n.querySelector(BODY_SEL);
      if (b) return b;
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
    const body = composeBody(root);
    if (!body) throw new Error('no compose body');
    ['dragenter', 'dragover', 'drop'].forEach(type =>
      body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })));
  }

  const stamp = () => new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');

  // Minimal ZIP writer (STORE, no compression: PNG and WebM are already compressed).
  // Bit 11 marks the file names as UTF-8 so Hebrew names survive.
  const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  async function makeZip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const name = enc.encode(f.name), data = new Uint8Array(await f.arrayBuffer()), crc = crc32(data);
      const head = new DataView(new ArrayBuffer(30));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, date, 2],
       [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, name.length, 2], [28, 0, 2]]
        .forEach(([o, v, n]) => n === 4 ? head.setUint32(o, v, true) : head.setUint16(o, v, true));
      const cd = new DataView(new ArrayBuffer(46));
      [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, date, 2],
       [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, name.length, 2], [42, offset, 4]]
        .forEach(([o, v, n]) => n === 4 ? cd.setUint32(o, v, true) : cd.setUint16(o, v, true));
      parts.push(head, name, data);
      central.push(cd, name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    [[0, 0x06054b50, 4], [8, files.length, 2], [10, files.length, 2], [12, cdSize, 4], [16, offset, 4]]
      .forEach(([o, v, n]) => n === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true));
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  async function attachZipped(btn, file, zipName) {
    const root = composeRoot(btn);
    if (!root) throw new Error('no compose root');
    attach(root, new File([await makeZip([file])], zipName, { type: 'application/zip' }));
  }

  // Screenshot: hands off to the Windows snipping overlay (the same one as Win+Shift+S), which puts
  // the snip on the clipboard. When the user comes back to Chrome, the caret is put back in the body
  // and the clipboard is pasted there - Gmail only inlines an image from a trusted paste, and
  // execCommand('paste') is one when the extension holds clipboardRead. The clipboard is emptied
  // first, so a cancelled snip pastes nothing instead of whatever was copied before.
  function takeScreenshot(btn) {
    const body = composeBody(btn);
    const sel = getSelection();
    const saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const range = saved && body && body.contains(saved.commonAncestorContainer) ? saved : null;
    navigator.clipboard.writeText('').catch(() => {});
    const a = document.createElement('a');
    a.href = 'ms-screenclip:';
    a.click();

    const toast = document.createElement('div');
    toast.className = 'gva-toast';
    toast.textContent = 'גזור את האזור הרצוי – הוא ייכנס לאימייל';
    document.body.append(toast);
    if (!body) {
      toast.textContent = 'אחרי הגזירה לחץ בגוף האימייל ואז Ctrl+V';
      setTimeout(() => toast.remove(), 30000);
      return;
    }

    // Polls focus instead of relying on blur/focus events, which do not always fire around the
    // snipping overlay.
    let away = false, auto = false, done = false;
    const watch = setInterval(() => {
      if (!document.hasFocus()) away = true;
      else if (away) { away = false; setTimeout(paste, 150); }
    }, 250);
    const finish = () => {
      done = true;
      clearInterval(watch);
      toast.remove();
      body.removeEventListener('paste', onUserPaste, true);
    };
    const onUserPaste = () => { if (!auto) setTimeout(finish, 500); };
    async function paste() {
      if (done) return;
      body.focus();
      if (range) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const before = body.querySelectorAll('img').length;
      auto = true;
      const ok = document.execCommand('paste');
      auto = false;
      if (!ok) {
        toast.textContent = 'לחץ Ctrl+V כדי להכניס את הגזירה לאימייל';
        return;
      }
      for (let n = 0; n < 50 && !done; n++) {
        if (body.querySelectorAll('img').length > before) return finish();
        await new Promise(r => setTimeout(r, 100));
      }
      if (!done) toast.textContent = `לחץ Ctrl+V כדי להכניס את הגזירה לאימייל`;
    }
    body.addEventListener('paste', onUserPaste, true);
    setTimeout(() => done || finish(), 120000);
  }

  // Screen video: screen/window/tab plus its audio when shared, mixed with the microphone.
  const VIDEO_MAX_SECONDS = 600, VIDEO_BPS = 1_500_000; // ~11 MB per minute
  const videoMime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';

  function addScreenButtons(cell) {
    const make = (cls, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gva-btn gva-icon ' + cls;
      b.title = title;
      b.ariaLabel = title;
      cell.append(b);
      return b;
    };
    const shotBtn = make('gva-shot', 'גזירת מסך לתוך גוף האימייל');
    const vidBtn = make('gva-vid', 'הקלטת וידאו של המסך – צרף כ-ZIP');

    shotBtn.addEventListener('mousedown', e => e.preventDefault()); // keep the caret in the body
    shotBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      takeScreenshot(shotBtn);
    });

    let recorder = null, timer = 0;
    vidBtn.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      if (recorder) { recorder.state === 'recording' && recorder.stop(); return; }

      let screen;
      try {
        screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: true, selfBrowserSurface: 'include' });
      } catch { return; }
      let mic = null;
      try { mic = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { /* record without narration */ }

      const audioCtx = new AudioContext(), mix = audioCtx.createMediaStreamDestination();
      [screen, mic].forEach(s => s && s.getAudioTracks().length && audioCtx.createMediaStreamSource(s).connect(mix));
      const tracks = [...screen.getVideoTracks(), ...mix.stream.getAudioTracks()];
      const chunks = [];
      recorder = new MediaRecorder(new MediaStream(tracks),
        Object.assign({ videoBitsPerSecond: VIDEO_BPS }, videoMime ? { mimeType: videoMime } : {}));
      recorder.ondataavailable = ev => ev.data.size && chunks.push(ev.data);
      // Chrome's own "Stop sharing" bar ends the video track; treat it like the stop button.
      screen.getVideoTracks()[0].addEventListener('ended', () => recorder && recorder.state === 'recording' && recorder.stop());
      recorder.onstop = async () => {
        clearInterval(timer);
        [screen, mic].forEach(s => s && s.getTracks().forEach(t => t.stop()));
        audioCtx.close();
        vidBtn.classList.remove('rec', 'gva-wide');
        vidBtn.textContent = '';
        try {
          if (!chunks.length) return;
          vidBtn.disabled = true;
          const s = stamp();
          await attachZipped(vidBtn, new File(chunks, `וידאו-מסך_${s}.webm`, { type: 'video/webm' }), `וידאו-מסך_${s}.zip`);
        } catch {
          alert('לא הצלחתי לצרף את הווידאו לאימייל.');
        } finally {
          recorder = null;
          vidBtn.disabled = false;
        }
      };

      recorder.start(1000);
      let seconds = 0;
      vidBtn.classList.add('rec', 'gva-wide');
      vidBtn.textContent = 'עצור 0:00';
      timer = setInterval(() => {
        seconds++;
        vidBtn.textContent = 'עצור ' + fmt(seconds);
        if (seconds >= VIDEO_MAX_SECONDS && recorder.state === 'recording') recorder.stop();
      }, 1000);
    });
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
    addScreenButtons(cell);

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
        const s = stamp();
        const root = composeRoot(btn);
        try {
          if (!root) throw new Error('no compose root');
          let file;
          try {
            file = new File([await toMp3(new Blob(chunks, { type: chunks[0].type }))], `הקלטה_${s}.mp3`, { type: 'audio/mpeg' });
          } catch {
            // Conversion failed: attach the original recording rather than losing it.
            const type = chunks[0].type || 'audio/webm';
            file = new File(chunks, `הקלטה_${s}.${type.includes('ogg') ? 'ogg' : 'webm'}`, { type });
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
