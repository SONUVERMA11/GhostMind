/**
 * proxy-server.js — Local AI Proxy (Groq + Gemini)
 *
 * Routes:
 *   GET  /health          → Credential & provider status
 *   POST /groq/*          → Groq API (api.groq.com) — PRIMARY
 *   POST /gemini/*        → Google Gemini API        — FALLBACK
 *   POST /set-key         → Save API key to .env + keyring
 */

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const PORT = 3747;

// ─── Credential Resolution ────────────────────────────────────────────────────
function resolveGroqKey() {
  if (process.env.GROQ_API_KEY && !process.env.GROQ_API_KEY.includes('your_')) {
    return process.env.GROQ_API_KEY;
  }
  // Try keyring
  try {
    const k = execSync('secret-tool lookup service ghostmind key groq_api_key 2>/dev/null', { timeout: 2000 }).toString().trim();
    if (k) return k;
  } catch {}
  return null;
}

function resolveGeminiKey() {
  if (process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.includes('your_') && process.env.GEMINI_API_KEY.length > 10) {
    return process.env.GEMINI_API_KEY;
  }
  try {
    const k = execSync('secret-tool lookup service ghostmind key gemini_api_key 2>/dev/null', { timeout: 2000 }).toString().trim();
    if (k) return k;
  } catch {}
  return null;
}

function getCredentials() {
  const groq   = resolveGroqKey();
  const gemini = resolveGeminiKey();
  return {
    groq,
    gemini,
    hasAny:    !!(groq || gemini),
    provider:  groq ? 'groq' : (gemini ? 'gemini' : 'none'),
  };
}

// ─── Generic HTTPS Proxy ──────────────────────────────────────────────────────
function proxyRequest(res, hostname, upstreamPath, method, headers, body) {
  const options = { hostname, port: 443, path: upstreamPath, method, headers };

  const proxyReq = https.request(options, (proxyRes) => {
    const ct = proxyRes.headers['content-type'] || 'application/json';
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': ct,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[Proxy] Upstream error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Proxy error: ${err.message}`, type: 'proxy_error' } }));
    }
  });

  if (body) proxyReq.write(body);
  proxyReq.end();
}

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const creds = getCredentials();

  // ── Health check ──────────────────────────────────────────────────────────
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:         'ok',
      hasCredentials: creds.hasAny,
      provider:       creds.provider,
      hasGroq:        !!creds.groq,
      hasGemini:      !!creds.gemini,
      timestamp:      new Date().toISOString(),
    }));
    return;
  }

  // ── Save API key ──────────────────────────────────────────────────────────
  if (req.url === '/set-key' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { key, type = 'groq' } = JSON.parse(body);
        if (key) {
          const envKey  = type === 'gemini' ? 'GEMINI_API_KEY' : 'GROQ_API_KEY';
          const envPath = path.join(__dirname, '..', '..', '.env');
          let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
          if (envContent.includes(`${envKey}=`)) {
            envContent = envContent.replace(new RegExp(`${envKey}=.*`), `${envKey}=${key}`);
          } else {
            envContent += `\n${envKey}=${key}`;
          }
          fs.writeFileSync(envPath, envContent);
          process.env[envKey] = key;

          // Store in keyring
          const keyName = type === 'gemini' ? 'gemini_api_key' : 'groq_api_key';
          try {
            execSync(`echo -n "${key}" | secret-tool store --label="GhostMind ${type} key" service ghostmind key ${keyName} 2>/dev/null`);
          } catch {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, provider: type }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Groq API proxy (/groq/*) ──────────────────────────────────────────────
  if (req.url.startsWith('/groq/')) {
    if (!creds.groq) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'No Groq API key. Add it in Settings.', type: 'no_key' } }));
      return;
    }

    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const upstreamPath = req.url.replace('/groq/', '/openai/v1/');
      proxyRequest(res, 'api.groq.com', upstreamPath, req.method, {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${creds.groq}`,
        'User-Agent':    'GhostMind/1.0',
      }, body);
    });
    return;
  }

  // ── Gemini API proxy (/gemini/*) ──────────────────────────────────────────
  if (req.url.startsWith('/gemini/')) {
    if (!creds.gemini) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'No Gemini API key configured.', type: 'no_key' } }));
      return;
    }

    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const rawPath  = req.url.replace('/gemini/', '/v1beta/');
      const sep      = rawPath.includes('?') ? '&' : '?';
      const upstream = `${rawPath}${sep}key=${creds.gemini}`;
      proxyRequest(res, 'generativelanguage.googleapis.com', upstream, req.method, {
        'Content-Type': 'application/json',
      }, body);
    });
    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const creds = getCredentials();
  console.log(`\n🔮 GhostMind Proxy → http://127.0.0.1:${PORT}`);
  if (creds.groq)   console.log(`✅ Groq   API key loaded (${creds.groq.slice(0, 8)}…)`);
  if (creds.gemini) console.log(`✅ Gemini API key loaded`);
  if (!creds.hasAny) console.log(`⚠  No credentials — add key in Settings`);
  console.log(`📡 Provider: ${creds.provider.toUpperCase()}\n`);
});

module.exports = server;
