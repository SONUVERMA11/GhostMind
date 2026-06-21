/**
 * ocr-engine.js — Screen OCR Service
 * Captures a screenshot and extracts text using Tesseract.js
 * Detects questions intelligently from the extracted text
 */

class OCREngine {
  constructor() {
    this.worker = null;
    this.isReady = false;
    this.isProcessing = false;
    this.lastScreenText = '';
    this.autoScanInterval = null;
  }

  // ─── Initialize Tesseract Worker ──────────────────────────────────────────
  async init(onProgress) {
    try {
      // Tesseract.js loaded via CDN in index.html
      this.worker = await Tesseract.createWorker('eng', 1, {
        logger: (m) => {
          if (m.status === 'recognizing text' && onProgress) {
            onProgress(Math.floor(m.progress * 100));
          }
        },
        workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
        langPath: 'https://tessdata.projectnaptha.com/4.0.0',
        corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js',
      });

      await this.worker.setParameters({
        tessedit_pageseg_mode: '6',  // Assume uniform block of text
        preserve_interword_spaces: '1',
      });

      this.isReady = true;
      console.log('[OCR] Tesseract worker ready');
      return true;
    } catch (err) {
      console.error('[OCR] Init failed:', err);
      return false;
    }
  }

  // ─── Capture Screen → OCR ─────────────────────────────────────────────────
  async captureAndRead() {
    if (this.isProcessing) return null;
    this.isProcessing = true;

    try {
      // Temporarily hide our overlay to get a clean screenshot
      document.body.style.opacity = '0';
      await new Promise(r => setTimeout(r, 80));

      // Use getDisplayMedia to capture screen
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { mediaSource: 'screen', width: { max: 1920 }, height: { max: 1080 } },
        audio: false,
      });

      // Grab a single frame
      const track = stream.getVideoTracks()[0];
      const imageCapture = new ImageCapture(track);
      const bitmap = await imageCapture.grabFrame();
      track.stop();
      stream.getTracks().forEach(t => t.stop());

      // Restore overlay
      document.body.style.opacity = '1';

      // Convert to canvas → data URL
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const dataUrl = canvas.toDataURL('image/png');

      // Run OCR
      return await this.readImage(dataUrl);
    } catch (err) {
      document.body.style.opacity = '1';
      console.error('[OCR] Capture failed:', err);
      throw err;
    } finally {
      this.isProcessing = false;
    }
  }

  // ─── Run OCR on image ─────────────────────────────────────────────────────
  async readImage(imageSource) {
    if (!this.isReady || !this.worker) throw new Error('OCR not initialized');
    const { data: { text } } = await this.worker.recognize(imageSource);
    this.lastScreenText = text;
    return text;
  }

  // ─── Extract Questions from OCR Text ─────────────────────────────────────
  extractQuestions(text) {
    if (!text) return [];

    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 10);
    const questions = [];

    // Patterns that strongly indicate a question
    const questionPatterns = [
      /\?$/,                                          // Ends with ?
      /^(what|how|why|when|where|who|which|can|could|would|should|do|does|did|is|are|explain|describe|tell|define|implement|write|create|design|solve|find|calculate|compare|list)/i,
      /\b(question|problem|challenge|task|exercise)\b/i,
    ];

    for (const line of lines) {
      const isQuestion = questionPatterns.some(p => p.test(line));
      if (isQuestion && line.length > 15) {
        questions.push(line);
      }
    }

    // If no explicit questions found, return the largest meaningful block
    if (questions.length === 0) {
      const meaningfulLines = lines.filter(l => l.length > 30);
      if (meaningfulLines.length > 0) {
        questions.push(meaningfulLines[0]);
      }
    }

    return questions;
  }

  // ─── Start Auto-Scan ──────────────────────────────────────────────────────
  startAutoScan(intervalMs, onNewQuestion) {
    this.stopAutoScan();
    this.autoScanInterval = setInterval(async () => {
      try {
        const text = await this.captureAndRead();
        if (!text) return;
        const questions = this.extractQuestions(text);
        if (questions.length > 0) {
          onNewQuestion(questions[0], text);
        }
      } catch (e) {
        // Silently ignore auto-scan errors
      }
    }, intervalMs);
  }

  stopAutoScan() {
    if (this.autoScanInterval) {
      clearInterval(this.autoScanInterval);
      this.autoScanInterval = null;
    }
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────
  async terminate() {
    this.stopAutoScan();
    await this.worker?.terminate();
    this.isReady = false;
  }
}

window.OCREngine = OCREngine;
