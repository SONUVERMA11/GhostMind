/**
 * audio-capture.js — System Audio Capture (Electron-compatible)
 *
 * Strategy:
 *  1. Web Speech API  → Works in Electron with experimentalFeatures:true
 *  2. MediaRecorder   → getUserMedia fallback with proper permission handling
 *  3. Manual mode     → Silent fallback (user types question manually)
 */

class AudioCaptureService {
  constructor(whisperApiKey = '') {
    this.whisperApiKey      = whisperApiKey;
    this.isListening        = false;
    this.speechRecognition  = null;
    this.mediaRecorder      = null;
    this.stream             = null;
    this.onTranscript       = null;
    this.onError            = null;
    this.method             = null; // 'webSpeech' | 'mediaRecorder' | null
    this._interimTimer      = null;
    this._finalBuffer       = '';
    this._restartTimer      = null;
  }

  // ─── Start (tries Web Speech first, then MediaRecorder) ──────────────────
  async start(onTranscript, onError) {
    if (this.isListening) return;
    this.onTranscript = onTranscript;
    this.onError      = onError;
    this.isListening  = true;

    // Try 1: Web Speech API
    if (await this._tryWebSpeech()) {
      this.method = 'webSpeech';
      console.log('[Audio] Using Web Speech API');
      return { method: 'webSpeech' };
    }

    // Try 2: MediaRecorder + Whisper
    try {
      await this._startMediaRecorder();
      this.method = 'mediaRecorder';
      console.log('[Audio] Using MediaRecorder');
      return { method: 'mediaRecorder' };
    } catch (err) {
      this.isListening = false;
      this.method = null;
      const msg = this._friendlyMicError(err);
      this.onError?.(msg);
      throw new Error(msg);
    }
  }

  // ─── Web Speech API ────────────────────────────────────────────────────────
  async _tryWebSpeech() {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      console.warn('[Audio] Web Speech API not available in this Electron version');
      return false;
    }

    return new Promise((resolve) => {
      try {
        const sr = new SpeechRecognition();
        sr.continuous      = true;
        sr.interimResults  = true;
        sr.lang            = 'en-US';
        sr.maxAlternatives = 1;

        // Test it can actually start
        sr.onstart  = () => { this.speechRecognition = sr; resolve(true); };
        sr.onerror  = (e) => {
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            console.warn('[Audio] Web Speech blocked:', e.error);
            resolve(false);
          }
          // Other errors — still working
        };
        sr.onend    = () => {
          // Auto-restart if we're still supposed to be listening
          if (this.isListening && this.method === 'webSpeech') {
            clearTimeout(this._restartTimer);
            this._restartTimer = setTimeout(() => {
              try { sr.start(); } catch {}
            }, 500);
          }
        };

        sr.onresult = (event) => {
          let interim = '';
          let final   = '';

          for (let i = event.resultIndex; i < event.results.length; i++) {
            const t = event.results[i][0].transcript;
            if (event.results[i].isFinal) final += t + ' ';
            else interim += t;
          }

          if (interim) {
            this.onTranscript?.({ text: interim, isFinal: false });
            // Treat as final after 2.5s silence
            clearTimeout(this._interimTimer);
            this._finalBuffer += interim;
            this._interimTimer = setTimeout(() => {
              if (this._finalBuffer.trim()) {
                this.onTranscript?.({ text: this._finalBuffer.trim(), isFinal: true });
                this._finalBuffer = '';
              }
            }, 2500);
          }

          if (final) {
            clearTimeout(this._interimTimer);
            this._finalBuffer = '';
            this.onTranscript?.({ text: final.trim(), isFinal: true });
          }
        };

        sr.start();

        // Timeout — if onstart not called in 2s, assume unavailable
        setTimeout(() => {
          if (!this.speechRecognition) {
            try { sr.stop(); } catch {}
            resolve(false);
          }
        }, 2000);
      } catch (e) {
        console.warn('[Audio] Web Speech init error:', e.message);
        resolve(false);
      }
    });
  }

  // ─── MediaRecorder ─────────────────────────────────────────────────────────
  async _startMediaRecorder() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        sampleRate: 16000,
        channelCount: 1,
      },
    });

    this.mediaRecorder = new MediaRecorder(this.stream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm',
    });

    const chunks = [];
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    this.mediaRecorder.onstop = async () => {
      if (!chunks.length) return;
      const blob = new Blob(chunks, { type: 'audio/webm' });
      chunks.length = 0;
      if (this.whisperApiKey) {
        await this._whisperTranscribe(blob);
      } else {
        this.onError?.('Add an OpenAI key for audio transcription, or type manually');
      }
    };

    this.mediaRecorder.start(5000); // 5-second chunks
  }

  // ─── Whisper transcription ─────────────────────────────────────────────────
  async _whisperTranscribe(blob) {
    try {
      const fd = new FormData();
      fd.append('file', blob, 'audio.webm');
      fd.append('model', 'whisper-1');
      fd.append('language', 'en');

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.whisperApiKey}` },
        body: fd,
      });
      if (!res.ok) throw new Error(`Whisper ${res.status}`);
      const { text } = await res.json();
      if (text?.trim()) {
        this.onTranscript?.({ text: text.trim(), isFinal: true });
      }
    } catch (err) {
      this.onError?.(`Transcription error: ${err.message}`);
    }
  }

  // ─── Friendly error messages ───────────────────────────────────────────────
  _friendlyMicError(err) {
    const msg = err?.message || String(err);
    if (msg.includes('Permission') || msg.includes('allowed') || msg.includes('NotAllowed')) {
      return 'Microphone blocked. Allow mic access in your system settings for Electron.';
    }
    if (msg.includes('NotFound') || msg.includes('Requested device not found')) {
      return 'No microphone detected. Connect a mic and try again.';
    }
    if (msg.includes('NotReadable') || msg.includes('hardware')) {
      return 'Microphone is in use by another app. Close it and try again.';
    }
    return `Audio error: ${msg}`;
  }

  // ─── Stop ──────────────────────────────────────────────────────────────────
  stop() {
    this.isListening = false;
    clearTimeout(this._interimTimer);
    clearTimeout(this._restartTimer);

    try { this.speechRecognition?.stop(); } catch {}
    try { this.mediaRecorder?.stop();     } catch {}
    this.stream?.getTracks().forEach(t => t.stop());

    this.speechRecognition = null;
    this.mediaRecorder     = null;
    this.stream            = null;
    this.method            = null;
    this._finalBuffer      = '';
    console.log('[Audio] Stopped');
  }

  getMethod() { return this.method; }
}

window.AudioCaptureService = AudioCaptureService;
