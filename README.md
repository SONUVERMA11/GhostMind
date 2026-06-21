# GhostMind 👻

GhostMind is a stealth, always-on-top AI interview assistant built with Electron. It captures audio and screen questions and uses high-speed AI models (like Groq) to provide real-time answers. It is engineered to be invisible to screen-sharing software (Zoom, Teams, etc.).

> **Warning:** This tool is designed for personal assistance and practice. Users should be aware that unauthorized use of AI assistants in proctored environments may violate platform terms of service.

## 🚀 Features

- **Stealth Mode:** Invisible to screen capture and sharing software.
- **Glassmorphism UI:** A sleek, frameless, and transparent overlay that blends into your desktop.
- **Ultra-Fast AI Responses:** Integrated with Groq (Llama 3) for near-instant answers, falling back to Google Gemini if needed.
- **Real-Time Audio Capture:** Uses the Web Speech API (with a robust fallback to MediaRecorder + Whisper) to auto-detect and transcribe questions.
- **OCR Screen Scanning:** Includes a built-in OCR engine (Tesseract.js) to intelligently extract interview questions directly from your screen.
- **Local Credentials Proxy:** Runs a local proxy server to securely handle API keys (from `.env` or system keyring) without exposing them.
- **Global Hotkeys:** Quick actions for capturing questions and hiding the UI on the fly.

## ⌨️ Hotkeys

| Shortcut | Action |
| --- | --- |
| `Ctrl + Shift + Space` | Show / Hide Overlay |
| `Ctrl + Shift + A` | Auto-answer (Screenshot -> OCR -> AI) |
| `Ctrl + Shift + L` | Toggle Audio Listening |
| `Ctrl + Shift + S` | Capture Screen Text Only (OCR) |
| `Ctrl + Shift + M` | Cycle Window Position |
| `Ctrl + Shift + C` | Clear Conversation History |

## 🛠 Prerequisites

- Node.js (v18 or later recommended)
- `npm` or `yarn`
- (Linux) `fuser`, `pkill`, `xprop` (for X11 stealth bypass)

## 📦 Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/SONUVERMA11/GhostMind.git
   cd GhostMind
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Setup environment variables (optional, can also be done via the app settings):
   Create a `.env` file in the root directory:
   ```env
   GROQ_API_KEY=your_groq_key
   GEMINI_API_KEY=your_gemini_key_optional
   OPENAI_API_KEY=your_openai_whisper_key_optional
   INTERVIEW_ROLE=Software Engineer
   INTERVIEW_COMPANY=Tech Company
   ```

4. Start the app:
   ```bash
   npm start
   ```

## 🏗 Architecture

- **Main Process (`main.js`):** Manages the stealth window, X11 Compositor Bypass (`_NET_WM_BYPASS_COMPOSITOR`), global hotkeys, IPC communication, and starts the local proxy.
- **Renderer (`app.js`, `index.html`):** The React-like UI state machine, applying the custom dark glassmorphism CSS theme and animations.
- **Local Proxy (`proxy-server.js`):** Intercepts API requests to safely inject credentials from the keyring or environment before forwarding them to Groq or Gemini.
- **AI Service (`gemini.js`):** Handles prompt construction, formatting, streaming SSE responses, and automatic model fallback.
- **Audio/OCR (`audio-capture.js`, `ocr-engine.js`):** Dual-layer question detection systems.

## 📄 License

MIT
