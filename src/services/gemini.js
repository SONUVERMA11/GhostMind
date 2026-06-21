/**
 * ai-service.js — Groq AI Integration (Primary)
 *
 * Uses Groq's ultra-fast inference API (OpenAI-compatible format).
 * Falls back to Gemini if Groq key is unavailable.
 *
 * Groq models (in speed/quality order):
 *  - llama-3.3-70b-versatile  → Best quality
 *  - llama-3.1-8b-instant     → Fastest
 *  - mixtral-8x7b-32768       → Great for code
 *  - gemma2-9b-it             → Lightweight fallback
 */

const GROQ_BASE  = 'http://127.0.0.1:3747/groq';
const PROXY_BASE = 'http://127.0.0.1:3747';

const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-70b-versatile',
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
];

const GEMINI_MODELS = [
  'models/gemini-2.0-flash',
  'models/gemini-2.0-flash-lite',
  'models/gemini-1.5-flash-latest',
];

const SYSTEM_PROMPT = `You are GhostMind, an expert AI interview assistant helping a candidate in real-time.

Rules:
- Be concise and direct. Under 200 words unless complexity demands more.
- For coding: provide clean working code with a brief explanation.
- For behavioral: use STAR format (Situation, Task, Action, Result).
- For system design: give high-level architecture with key components.
- Use bullet points for lists. Bold key terms with **term**.
- Answer in first person as the candidate — never break character.
- For ambiguous questions, give the most likely intended answer.

Interview Context:
- Role: {ROLE}
- Company: {COMPANY}`;

class AIService {
  constructor(role = 'Software Engineer', company = 'Tech Company') {
    this.role    = role;
    this.company = company;
    this.history = [];    // Groq/OpenAI format: [{role, content}]
    this.provider = 'groq'; // 'groq' | 'gemini'
    this.activeModel = GROQ_MODELS[0];
  }

  buildSystem() {
    return SYSTEM_PROMPT
      .replace('{ROLE}',    this.role)
      .replace('{COMPANY}', this.company);
  }

  // ─── Check health & detect provider ──────────────────────────────────────
  async checkProxy() {
    try {
      const res  = await fetch(`${PROXY_BASE}/health`);
      const data = await res.json();
      this.provider = data.provider || 'groq';
      return data;
    } catch {
      return { status: 'error', hasCredentials: false };
    }
  }

  // ─── Streaming answer via Groq ────────────────────────────────────────────
  async *answerStream(question, context = '') {
    const content = context
      ? `Context from screen:\n"${context}"\n\nQuestion: ${question}`
      : question;

    // Add to history
    this.history.push({ role: 'user', content });
    const messages = [
      { role: 'system', content: this.buildSystem() },
      ...this.history.slice(-20),
    ];

    const payload = {
      model:       this.activeModel,
      messages,
      temperature: 0.7,
      max_tokens:  1024,
      stream:      true,
    };

    let res = null;
    let usedModel = this.activeModel;

    // Try each Groq model
    for (const m of GROQ_MODELS) {
      res = await fetch(`${GROQ_BASE}/chat/completions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...payload, model: m }),
      });

      if (res.ok) {
        usedModel = m;
        this.activeModel = m;
        break;
      }

      const err = await res.json().catch(() => ({}));
      const msg = err?.error?.message || '';
      // Model not found or rate limited — try next
      if (res.status === 404 || res.status === 429 || msg.includes('not found') || msg.includes('decommissioned')) {
        console.warn(`[AI] Groq model ${m} unavailable, trying next…`);
        res = null;
        continue;
      }
      throw new Error(msg || `Groq error ${res.status}`);
    }

    // If all Groq models fail, try Gemini fallback
    if (!res || !res.ok) {
      console.warn('[AI] All Groq models failed, falling back to Gemini…');
      yield* this._geminiStream(question, context);
      return;
    }

    console.log(`[AI] Streaming via Groq/${usedModel}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText  = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: '))   continue;
        if (line === 'data: [DONE]')       continue;
        try {
          const json  = JSON.parse(line.slice(6));
          const delta = json?.choices?.[0]?.delta?.content || '';
          if (delta) { fullText += delta; yield delta; }
        } catch {}
      }
    }

    if (fullText) {
      this.history.push({ role: 'assistant', content: fullText });
    }
  }

  // ─── Gemini fallback (SSE stream) ─────────────────────────────────────────
  async *_geminiStream(question, context = '') {
    const full = context
      ? `Context from screen:\n"${context}"\n\nQuestion: ${question}`
      : question;

    // Convert history to Gemini format
    const geminiHistory = this.history.slice(-19).map(m => ({
      role:  m.role === 'assistant' ? 'model' : m.role,
      parts: [{ text: m.content }],
    }));

    const payload = {
      system_instruction: { parts: [{ text: this.buildSystem() }] },
      contents: [...geminiHistory, { role: 'user', parts: [{ text: full }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
    };

    for (const m of GEMINI_MODELS) {
      const res = await fetch(`${PROXY_BASE}/gemini/${m}:streamGenerateContent?alt=sse`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = err?.error?.message || '';
        if (res.status === 404 || msg.includes('not found')) { continue; }
        throw new Error(msg || `Gemini error ${res.status}`);
      }

      console.log(`[AI] Gemini fallback via ${m}`);
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText  = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const json = JSON.parse(line.slice(6));
            const part = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (part) { fullText += part; yield part; }
          } catch {}
        }
      }

      if (fullText) {
        this.history.push({ role: 'assistant', content: fullText });
      }
      return;
    }

    throw new Error('All AI providers failed. Check your API keys.');
  }

  clearHistory()    { this.history = []; }
  getHistoryCount() { return Math.floor(this.history.length / 2); }
  updateContext(role, company) { this.role = role; this.company = company; }
  getModelInfo()    { return `${this.provider}/${this.activeModel}`; }
}

// Keep old name for compatibility
window.GeminiService = AIService;
window.AIService     = AIService;
