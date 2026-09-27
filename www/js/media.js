// Talaffuz (matnni ovozga aylantirish) va shadowing uchun ovoz yozish.

function nativePlugin(name) {
  const cap = window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins[name]) {
    return cap.Plugins[name];
  }
  return null;
}

export async function speak(text, rate = 0.9) {
  const tts = nativePlugin('TextToSpeech');
  if (tts) {
    try { await tts.stop(); } catch (_) { /* e'tiborsiz */ }
    return tts.speak({ text, lang: 'en-US', rate, pitch: 1.0, volume: 1.0, category: 'playback' });
  }
  if ('speechSynthesis' in window) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = rate;
    const voice = speechSynthesis.getVoices().find((v) => /^en[-_]US/i.test(v.lang))
      || speechSynthesis.getVoices().find((v) => /^en/i.test(v.lang));
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
    return;
  }
  throw new Error('Qurilmada talaffuz (TTS) mavjud emas');
}

// Ekran yo'nalishi: 'landscape', 'portrait' yoki null (telefon o'zi aylantiradi).
export function setOrientation(mode) {
  const so = nativePlugin('ScreenOrientation');
  const done = (p) => { if (p && p.catch) p.catch(() => {}); };
  try {
    if (so) done(mode ? so.lock({ orientation: mode }) : so.unlock());
    else if (screen.orientation && screen.orientation.lock) {
      if (mode) done(screen.orientation.lock(mode));
      else screen.orientation.unlock();
    }
  } catch (_) { /* hamma qurilmalarda ham ishlamaydi */ }
}

// Tizim panellarini (soat, navigatsiya tugmalari) yashirish yoki qaytarish.
// Ilovada — o'zimizning Immersive plagini, brauzerda — Fullscreen API.
// Hech qachon kutib qolmaymiz: ba'zi WebView'larda bu va'dalar hech qachon tugamaydi.
export function setSystemBarsHidden(hidden) {
  const im = nativePlugin('Immersive');
  try {
    if (im) {
      const p = hidden ? im.enter() : im.exit();
      if (p && p.catch) p.catch(() => {});
      return;
    }
    if (hidden && document.documentElement.requestFullscreen && !document.fullscreenElement) {
      const p = document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      if (p && p.catch) p.catch(() => {});
    } else if (!hidden && document.fullscreenElement && document.exitFullscreen) {
      const p = document.exitFullscreen();
      if (p && p.catch) p.catch(() => {});
    }
  } catch (_) { /* e'tiborsiz */ }
}

export class VoiceRecorder {
  constructor() {
    this.stream = null;
    this.rec = null;
    this.chunks = [];
    this.url = null;
  }

  get recording() {
    return !!(this.rec && this.rec.state === 'recording');
  }

  async start() {
    if (this.recording) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      throw new Error('Bu qurilmada ovoz yozish qoʻllab-quvvatlanmaydi');
    }
    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    }
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream);
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.done = new Promise((resolve) => {
      this.rec.onstop = () => {
        if (this.url) URL.revokeObjectURL(this.url);
        const blob = new Blob(this.chunks, { type: this.rec.mimeType || 'audio/webm' });
        this.url = blob.size ? URL.createObjectURL(blob) : null;
        resolve(this.url);
      };
    });
    this.rec.start();
  }

  async stop() {
    if (!this.recording) return this.url;
    this.rec.stop();
    return this.done;
  }

  play() {
    if (!this.url) return null;
    const a = new Audio(this.url);
    a.play().catch(() => {});
    return a;
  }

  release() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }
}
