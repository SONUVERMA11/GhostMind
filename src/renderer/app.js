/**
 * app.js — GhostMind Renderer Process
 * Main application logic: mode management, AI answering, UI updates
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  mode: 'manual',       // 'manual' | 'audio' | 'ocr' | 'auto'
  isAnswering: false,
  isListening: false,
  config: {},
  gemini: null,
  audio: null,
  ocr: null,
};

// ─── DOM References ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const DOM = {
  statusDot:       $('status-dot'),
  statusText:      $('status-text'),
  questionInput:   $('question-input'),
  btnAnswer:       $('btn-answer'),
  btnOcr:          $('btn-ocr'),
  btnCopy:         $('btn-copy'),
  btnClear:        $('btn-clear'),
  btnSettings:     $('btn-settings'),
  btnMinimize:     $('btn-minimize'),
  btnQuit:         $('btn-quit'),
  btnSaveSettings: $('btn-save-settings'),
  answerContent:   $('answer-content'),
  exchangeCount:   $('exchange-count'),
  transcriptBox:   $('transcript-box'),
  transcriptText:  $('transcript-text'),
  settingsPanel:   $('settings-panel'),
  toast:           $('toast'),
  // Mode buttons
  modeBtns:        document.querySelectorAll('.mode-btn'),
  // Settings inputs
  sGroqKey:        $('s-groq-key'),
  sGeminiKey:      $('s-gemini-key'),
  sWhisperKey:     $('s-whisper-key'),
  sRole:           $('s-role'),
  sCompany:        $('s-company'),
  sOpacity:        $('s-opacity'),
};

// ─── Initialization ───────────────────────────────────────────────────────────
async function init() {
  setStatus('loading', 'Starting proxy…');

  // Load config from main process
  state.config = await window.ghostAPI.getConfig();

  // Populate settings panel
  DOM.sGeminiKey.value  = state.config.geminiKey  || '';
  DOM.sWhisperKey.value = state.config.whisperKey || '';
  DOM.sRole.value       = state.config.role        || 'Software Engineer';
  DOM.sCompany.value    = state.config.company     || 'Tech Company';

  // Initialize Gemini service (routes through local proxy)
  state.gemini = new GeminiService(
    state.config.role,
    state.config.company
  );

  // Check proxy health
  setStatus('loading', 'Checking credentials…');
  const health = await window.ghostAPI.proxyHealth();

  if (health.hasCredentials) {
    const credLabel = health.hasGroq
      ? `⚡ Groq`
      : (health.hasGemini ? '🔑 Gemini' : '✅ Ready');
    setStatus('ready', credLabel);
    showToast(`👻 Ready — using ${credLabel.replace(/^.\s/, '')}`, 'success');
  } else {
    // Check if user saved a key in localStorage
    const savedKey = localStorage.getItem('gm_gemini_key');
    if (savedKey) {
      await window.ghostAPI.proxySetKey(savedKey);
      setStatus('ready', '🔑 Saved Key');
      showToast('👻 GhostMind ready', 'success');
    } else {
      setStatus('error', 'No credentials');
      showToast('⚙ Add Gemini API key in Settings', 'error');
    }
  }

  // Initialize audio
  state.audio = new AudioCaptureService(state.config.whisperKey);

  // Initialize OCR (silent background load)
  state.ocr = new OCREngine();
  state.ocr.init().then(ok => console.log('[OCR] Ready:', ok));

  // Register hotkey events
  window.ghostAPI.onHotkey(handleHotkey);

  // Bind all UI events
  bindEvents();

  console.log('[GhostMind] Initialized — proxy:', health.status);
}

// ─── Event Bindings ───────────────────────────────────────────────────────────
function bindEvents() {
  // Mode buttons
  DOM.modeBtns.forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // Answer button
  DOM.btnAnswer.addEventListener('click', handleAnswer);

  // Enter key to submit
  DOM.questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleAnswer();
  });

  // Scan screen button
  DOM.btnOcr.addEventListener('click', handleOcrScan);

  // Copy button
  DOM.btnCopy.addEventListener('click', copyLastAnswer);

  // Clear button
  DOM.btnClear.addEventListener('click', clearHistory);

  // Settings button
  DOM.btnSettings.addEventListener('click', toggleSettings);

  // Minimize
  DOM.btnMinimize.addEventListener('click', () => {
    // Main process handles actual hiding via hotkey
    showToast('Use Ctrl+Shift+Space to hide', 'info');
  });

  // Quit
  DOM.btnQuit.addEventListener('click', () => window.ghostAPI.quit());

  // Save settings
  DOM.btnSaveSettings.addEventListener('click', saveSettings);

  // Opacity slider
  DOM.sOpacity.addEventListener('input', (e) => {
    window.ghostAPI.setOpacity(e.target.value);
  });

  // Close settings when clicking outside (on answer panel)
  DOM.answerContent.addEventListener('click', () => {
    if (DOM.settingsPanel.style.display !== 'none') toggleSettings();
  });
}

// ─── Mode Management ──────────────────────────────────────────────────────────
async function setMode(mode) {
  const prevMode = state.mode;
  state.mode = mode;

  // Update active button
  DOM.modeBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  // Teardown previous mode
  if (prevMode === 'audio' || prevMode === 'auto') await stopAudioMode();
  if (prevMode === 'ocr'   || prevMode === 'auto') stopOcrMode();

  // Setup new mode
  switch (mode) {
    case 'audio':
      await startAudioMode();
      break;
    case 'ocr':
      startOcrAutoMode();
      break;
    case 'auto':
      await startAudioMode();
      startOcrAutoMode();
      break;
    case 'manual':
    default:
      DOM.transcriptBox.style.display = 'none';
      setStatus('ready', 'Manual mode');
      break;
  }
}

// ─── Audio Mode ───────────────────────────────────────────────────────────────
async function startAudioMode() {
  DOM.transcriptBox.style.display = 'block';
  DOM.transcriptText.textContent  = 'Starting microphone…';
  setStatus('active', 'Listening…');

  // Re-create audio service each time (clears stale state)
  state.audio = new AudioCaptureService(state.config.whisperKey || '');

  try {
    const result = await state.audio.start(
      async ({ text, isFinal }) => {
        DOM.transcriptText.textContent = text || 'Listening…';
        if (isFinal && isQuestion(text)) {
          DOM.questionInput.value = text;
          await doAnswer(text);
        }
      },
      (err) => {
        // Non-fatal inline error — show in transcript box, don't crash mode
        DOM.transcriptText.textContent = `⚠ ${err}`;
        showToast(err, 'error');
      }
    );
    state.isListening = true;
    DOM.transcriptText.textContent = `Listening via ${result?.method || 'mic'}…`;
    setStatus('active', '🎤 Listening');
  } catch (e) {
    // Fatal — mic completely unavailable
    DOM.transcriptBox.style.display = 'none';
    showToast(e.message, 'error');
    setStatus('error', 'No mic');
    // Revert button to manual
    state.mode = 'manual';
    DOM.modeBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.mode === 'manual'));
  }
}

async function stopAudioMode() {
  state.audio?.stop();
  state.isListening = false;
  DOM.transcriptBox.style.display = 'none';
}

// ─── OCR Auto Mode ─────────────────────────────────────────────────────────────
function startOcrAutoMode() {
  setStatus('active', 'Scanning…');
  // Scan every 8 seconds
  state.ocr.startAutoScan(8000, async (question, fullText) => {
    if (question && question !== state.lastOcrQuestion) {
      state.lastOcrQuestion = question;
      DOM.questionInput.value = question;
      await doAnswer(question, fullText);
    }
  });
}

function stopOcrMode() {
  state.ocr?.stopAutoScan();
}

// ─── Question Detection ───────────────────────────────────────────────────────
function isQuestion(text) {
  if (!text || text.length < 8) return false;
  const patterns = [
    /\?/,
    /^(what|how|why|when|where|who|which|can|could|would|should|explain|describe|tell|define|implement|write|create|design|solve|find|compare|list|give|provide)\b/i,
  ];
  return patterns.some(p => p.test(text.trim()));
}

// ─── OCR One-Shot ─────────────────────────────────────────────────────────────
async function handleOcrScan() {
  setStatus('active', 'Scanning…');
  DOM.btnOcr.disabled = true;

  try {
    const text = await state.ocr.captureAndRead();
    if (!text?.trim()) {
      showToast('No text detected on screen', 'error');
      return;
    }

    const questions = state.ocr.extractQuestions(text);
    if (questions.length > 0) {
      DOM.questionInput.value = questions[0];
      showToast(`Detected: "${questions[0].slice(0, 40)}…"`, 'success');
      await doAnswer(questions[0], text);
    } else {
      // Use raw OCR text as context
      DOM.questionInput.value = text.slice(0, 300);
      showToast('Screen text captured — edit if needed', 'info');
    }
  } catch (err) {
    if (err.message.includes('Permission')) {
      showToast('Allow screen sharing when prompted', 'error');
    } else {
      showToast(`OCR failed: ${err.message}`, 'error');
    }
  } finally {
    DOM.btnOcr.disabled = false;
    setStatus('ready', 'Ready');
  }
}

// ─── Core Answer Handler ──────────────────────────────────────────────────────
async function handleAnswer() {
  const question = DOM.questionInput.value.trim();
  if (!question) {
    showToast('Please enter a question', 'error');
    return;
  }
  await doAnswer(question);
}

async function doAnswer(question, screenContext = '') {
  if (state.isAnswering) return;

  // Check if proxy has any credentials
  const health = await window.ghostAPI.proxyHealth().catch(() => ({ hasCredentials: false }));
  if (!health.hasCredentials) {
    showToast('⚡ Add your Groq API key in Settings ⚙', 'error');
    return;
  }

  state.isAnswering = true;
  setStatus('active', 'Thinking…');
  DOM.btnAnswer.classList.add('loading');
  DOM.btnAnswer.textContent = '⏳ Thinking…';

  // Add question block to UI
  const msgBlock = createMessageBlock(question);
  clearEmptyState();
  DOM.answerContent.appendChild(msgBlock);
  DOM.answerContent.scrollTop = DOM.answerContent.scrollHeight;

  // Create answer element with typing cursor
  const answerEl = msgBlock.querySelector('.msg-answer');
  answerEl.innerHTML = '<span class="typing-cursor"></span>';

  try {
    let fullAnswer = '';

    // Use streaming for typewriter effect
    for await (const chunk of state.gemini.answerStream(question, screenContext)) {
      fullAnswer += chunk;
      answerEl.innerHTML = formatAnswer(fullAnswer) + '<span class="typing-cursor"></span>';
      DOM.answerContent.scrollTop = DOM.answerContent.scrollHeight;
    }

    // Final render without cursor
    answerEl.innerHTML = formatAnswer(fullAnswer);
    
    // Update exchange count
    DOM.exchangeCount.textContent = `${state.gemini.getHistoryCount()} exchange${state.gemini.getHistoryCount() !== 1 ? 's' : ''}`;

    setStatus('ready', 'Ready');
  } catch (err) {
    answerEl.innerHTML = `<span style="color: var(--red)">❌ ${err.message}</span>`;
    setStatus('error', 'Error');
    showToast(err.message, 'error');
  } finally {
    state.isAnswering = false;
    DOM.btnAnswer.classList.remove('loading');
    DOM.btnAnswer.textContent = '⚡ Answer';
  }
}

// ─── Message Block Builder ────────────────────────────────────────────────────
function createMessageBlock(question) {
  const block = document.createElement('div');
  block.className = 'msg-block';
  block.innerHTML = `
    <div class="msg-question">Q: ${escapeHtml(question.slice(0, 200))}</div>
    <div class="msg-answer"></div>
  `;
  return block;
}

// ─── Answer Formatter ─────────────────────────────────────────────────────────
function formatAnswer(text) {
  // Convert markdown-ish to HTML
  let html = escapeHtml(text);

  // Code blocks ```lang\n...\n```
  html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code>${code.trim()}</code></pre>`
  );

  // Inline code `...`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold **...**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Bullet lists (- item or * item)
  html = html.replace(/^[•\-\*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

  // Numbered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Paragraphs
  html = html.split('\n\n').map(p => {
    if (p.includes('<li>') || p.includes('<pre>')) return p;
    return `<p>${p.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  return html;
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function clearEmptyState() {
  const empty = DOM.answerContent.querySelector('.empty-state');
  if (empty) empty.remove();
}

// ─── Hotkey Handlers ──────────────────────────────────────────────────────────
async function handleHotkey(action) {
  switch (action) {
    case 'auto-answer':
      await handleOcrScan();
      if (DOM.questionInput.value) await handleAnswer();
      break;
    case 'toggle-listen':
      setMode(state.mode === 'audio' ? 'manual' : 'audio');
      break;
    case 'screenshot-ocr':
      await handleOcrScan();
      break;
    case 'clear-history':
      clearHistory();
      break;
  }
}

// ─── Utility Functions ────────────────────────────────────────────────────────
function clearHistory() {
  state.gemini?.clearHistory();
  DOM.answerContent.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">🧠</div>
      <p>History cleared. Ask a new question!</p>
    </div>
  `;
  DOM.exchangeCount.textContent = '0 exchanges';
  showToast('Conversation cleared', 'success');
}

function copyLastAnswer() {
  const lastAnswer = DOM.answerContent.querySelector('.msg-block:last-child .msg-answer');
  if (!lastAnswer) return;
  navigator.clipboard.writeText(lastAnswer.innerText);
  showToast('Copied to clipboard', 'success');
}

function setStatus(type, text) {
  DOM.statusDot.className = `status-dot ${type === 'loading' ? '' : type}`;
  DOM.statusText.textContent = text;
}

function toggleSettings() {
  const visible = DOM.settingsPanel.style.display !== 'none';
  DOM.settingsPanel.style.display = visible ? 'none' : 'flex';
}

function saveSettings() {
  const groqKey    = DOM.sGroqKey?.value.trim();
  const geminiKey  = DOM.sGeminiKey.value.trim();
  const whisperKey = DOM.sWhisperKey.value.trim();
  const role       = DOM.sRole.value.trim()    || 'Software Engineer';
  const company    = DOM.sCompany.value.trim() || 'Tech Company';

  // Persist locally
  if (groqKey)    localStorage.setItem('gm_groq_key',    groqKey);
  if (geminiKey)  localStorage.setItem('gm_gemini_key',  geminiKey);
  if (whisperKey) localStorage.setItem('gm_whisper_key', whisperKey);
  localStorage.setItem('gm_role',    role);
  localStorage.setItem('gm_company', company);

  // Push Groq key to proxy (saves to .env + keyring)
  const savePromises = [];
  if (groqKey) {
    savePromises.push(
      window.ghostAPI.proxySetKey(groqKey).then(r =>
        console.log('[Settings] Groq key saved:', r)
      )
    );
  }
  if (geminiKey) {
    savePromises.push(
      window.ghostAPI.proxySetKey(geminiKey).then(r =>
        console.log('[Settings] Gemini key saved:', r)
      )
    );
  }

  Promise.all(savePromises).then(() => {
    showToast('⚡ Keys saved!', 'success');
    setStatus('ready', groqKey ? '⚡ Groq' : '🔑 Gemini');
  });

  // Update AI service
  state.gemini = new AIService(role, company);
  state.audio  = new AudioCaptureService(whisperKey);
  toggleSettings();
}

let toastTimer = null;
function showToast(msg, type = '') {
  DOM.toast.textContent = msg;
  DOM.toast.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { DOM.toast.className = 'toast'; }, 3000);
}

// ─── Load Persisted Settings ──────────────────────────────────────────────────
function loadPersistedSettings() {
  const groqKey   = localStorage.getItem('gm_groq_key');
  const gemKey    = localStorage.getItem('gm_gemini_key');
  const whisperKey= localStorage.getItem('gm_whisper_key');
  const role      = localStorage.getItem('gm_role');
  const company   = localStorage.getItem('gm_company');

  if (groqKey   && DOM.sGroqKey)   { DOM.sGroqKey.value   = groqKey; }
  if (gemKey    && DOM.sGeminiKey) { DOM.sGeminiKey.value  = gemKey; }
  if (whisperKey) { state.config.whisperKey = whisperKey; DOM.sWhisperKey.value = whisperKey; }
  if (role)       { state.config.role = role;       DOM.sRole.value = role; }
  if (company)    { state.config.company = company; DOM.sCompany.value = company; }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  loadPersistedSettings();
  await init();
});
