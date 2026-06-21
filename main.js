const { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } = require('electron');
const path = require('path');
const { execSync, exec, fork } = require('child_process');
require('dotenv').config();

// ─── Start Local Proxy Server ──────────────────────────────────────────────────
let proxyProcess = null;

function startProxyServer() {
  // Kill any previous proxy on this port first
  try { execSync('fuser -k 3747/tcp 2>/dev/null'); } catch {}

  const proxyPath = path.join(__dirname, 'src', 'services', 'proxy-server.js');
  proxyProcess = fork(proxyPath, [], {
    silent: false,
    env: { ...process.env },
  });
  proxyProcess.on('error', (err) => console.error('[Proxy] Failed to start:', err));
  proxyProcess.on('exit', (code) => {
    if (code !== 0) console.warn(`[Proxy] Exited with code ${code}`);
  });
  console.log('[Main] Local proxy server started (port 3747)');
}

let mainWindow = null;
let overlayVisible = true;
let currentPosition = 'top-right';
const positions = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'center-right'];

// ─── Window Position Calculator ───────────────────────────────────────────────
function getWindowBounds(position) {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const W = parseInt(process.env.OVERLAY_WIDTH) || 480;
  const H = parseInt(process.env.OVERLAY_HEIGHT) || 700;
  const MARGIN = 12;
  const map = {
    'top-right':     { x: sw - W - MARGIN, y: MARGIN },
    'top-left':      { x: MARGIN,           y: MARGIN },
    'bottom-right':  { x: sw - W - MARGIN, y: sh - H - MARGIN },
    'bottom-left':   { x: MARGIN,           y: sh - H - MARGIN },
    'center-right':  { x: sw - W - MARGIN, y: Math.floor((sh - H) / 2) },
  };
  return { ...map[position], width: W, height: H };
}

// ─── Create Stealth Overlay Window ────────────────────────────────────────────
function createWindow() {
  const bounds = getWindowBounds(currentPosition);

  mainWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    focusable: true,
    hasShadow: false,
    type: 'toolbar',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      experimentalFeatures: true,   // Enables Web Speech API
    },
  });

  // ─── Auto-grant microphone & media permissions ─────────────────────────
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = ['media', 'microphone', 'audioCapture', 'desktopCapture', 'display-capture'];
      callback(allowed.includes(permission));
    }
  );
  mainWindow.webContents.session.setPermissionCheckHandler(
    (_webContents, permission) => {
      const allowed = ['media', 'microphone', 'audioCapture', 'desktopCapture', 'display-capture'];
      return allowed.includes(permission);
    }
  );

  // ─── STEALTH: Prevent screen capture ────────────────────────────────────
  mainWindow.setContentProtection(true);      // Primary stealth mechanism
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 2); // Highest z-level
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setIgnoreMouseEvents(false);

  // ─── Load UI ─────────────────────────────────────────────────────────────
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  // ─── Apply X11 Window Hints (extra stealth for Xorg) ─────────────────────
  mainWindow.once('ready-to-show', () => {
    applyX11StealthHints();
    mainWindow.show();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── X11 Stealth Hints ────────────────────────────────────────────────────────
function applyX11StealthHints() {
  if (process.platform !== 'linux') return;
  try {
    const wid = mainWindow.getNativeWindowHandle().readUInt32LE(0).toString(16);
    // Bypass compositor — makes window invisible to capture tools
    exec(`xprop -id 0x${wid} -f _NET_WM_BYPASS_COMPOSITOR 32c -set _NET_WM_BYPASS_COMPOSITOR 2 2>/dev/null`);
    // Set window type to "utility" — less likely to be captured
    exec(`xprop -id 0x${wid} -f _NET_WM_WINDOW_TYPE 32a -set _NET_WM_WINDOW_TYPE _NET_WM_WINDOW_TYPE_UTILITY 2>/dev/null`);
    console.log('[Stealth] X11 bypass hints applied');
  } catch (e) {
    console.log('[Stealth] X11 hints skipped (Wayland or unavailable)');
  }
}

// ─── Global Hotkeys ───────────────────────────────────────────────────────────
function registerHotkeys() {
  // Toggle show/hide overlay
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (!mainWindow) return;
    overlayVisible = !overlayVisible;
    overlayVisible ? mainWindow.show() : mainWindow.hide();
  });

  // One-shot: screenshot + OCR + AI answer
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    mainWindow?.webContents.send('hotkey', 'auto-answer');
  });

  // Toggle continuous audio listening
  globalShortcut.register('CommandOrControl+Shift+L', () => {
    mainWindow?.webContents.send('hotkey', 'toggle-listen');
  });

  // Screenshot OCR only
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    mainWindow?.webContents.send('hotkey', 'screenshot-ocr');
  });

  // Clear history
  globalShortcut.register('CommandOrControl+Shift+C', () => {
    mainWindow?.webContents.send('hotkey', 'clear-history');
  });

  // Cycle overlay position
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    const idx = positions.indexOf(currentPosition);
    currentPosition = positions[(idx + 1) % positions.length];
    const bounds = getWindowBounds(currentPosition);
    mainWindow?.setBounds(bounds);
  });

  console.log('[Hotkeys] Registered: Ctrl+Shift+{Space, A, L, S, C, M}');
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('get-env', (_event, key) => process.env[key] || '');
ipcMain.handle('get-config', () => ({
  role:       process.env.INTERVIEW_ROLE    || 'Software Engineer',
  company:    process.env.INTERVIEW_COMPANY || 'Tech Company',
  geminiKey:  process.env.GEMINI_API_KEY   || '',
  whisperKey: process.env.OPENAI_API_KEY   || '',
  proxyUrl:   'http://127.0.0.1:3747',
  useProxy:   true,
}));

ipcMain.handle('proxy-health', async () => {
  try {
    const res = await fetch('http://127.0.0.1:3747/health');
    return res.json();
  } catch {
    return { status: 'error', hasCredentials: false };
  }
});

ipcMain.handle('proxy-set-key', async (_event, key) => {
  try {
    const res = await fetch('http://127.0.0.1:3747/set-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    return res.json();
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.on('resize-window', (_event, { width, height }) => {
  mainWindow?.setSize(width, height);
});

ipcMain.on('set-opacity', (_event, val) => {
  mainWindow?.setOpacity(parseFloat(val));
});

ipcMain.on('quit-app', () => {
  app.quit();
});

// ─── App Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  startProxyServer();                     // Start proxy FIRST
  setTimeout(() => {
    createWindow();                       // Create window after proxy is ready
    registerHotkeys();                    // Hotkeys MUST be after app.isReady()
  }, 900);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  try { if (app.isReady()) globalShortcut.unregisterAll(); } catch {}
  proxyProcess?.kill();
});


// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
