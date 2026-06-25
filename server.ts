import express from 'express';
import path from 'path';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';

dotenv.config();

// ── Rate limiter ──────────────────────────────────────────────────────────────
const DAILY_CAP = parseInt(process.env.DAILY_API_CAP || '300', 10);
let usageCount = 0;
let usageWindowStart = Date.now();
function checkRateLimit(): boolean {
  const now = Date.now();
  if (now - usageWindowStart > 86400000) { usageCount = 0; usageWindowStart = now; }
  if (usageCount >= DAILY_CAP) return false;
  usageCount++;
  return true;
}

const HARDCODED_VOICE_ID = 'Gubgw9l4dtIoQA9YZHgx';

// ── Currency converter ────────────────────────────────────────────────────────
async function convertCurrency(amount: number, from: string, to: string): Promise<string> {
  const key = process.env.EXCHANGE_RATE_API_KEY;
  if (!key) return '';
  try {
    const res = await fetch(`https://v6.exchangerate-api.com/v6/${key}/pair/${from.toUpperCase()}/${to.toUpperCase()}/${amount}`);
    if (!res.ok) return '';
    const data = await res.json() as any;
    if (data.result !== 'success') return '';
    return `${amount} ${from.toUpperCase()} = ${data.conversion_result.toFixed(2)} ${to.toUpperCase()} (rate: ${data.conversion_rate})`;
  } catch { return ''; }
}

function parseCurrencyQuery(text: string): { amount: number; from: string; to: string } | null {
  const t = text.toLowerCase();
  const match = t.match(/(\d+(?:\.\d+)?)\s*([a-z]{3}|dollars?|euros?|pounds?|dirhams?|dinars?)\s+(?:in|to|into)\s+([a-z]{3}|dollars?|euros?|pounds?|dirhams?|dinars?)/i);
  if (!match) return null;
  const nameMap: Record<string, string> = {
    dollar: 'USD', dollars: 'USD', euro: 'EUR', euros: 'EUR',
    pound: 'GBP', pounds: 'GBP', dirham: 'AED', dirhams: 'AED',
    dinar: 'DZD', dinars: 'DZD',
  };
  const from = nameMap[match[2].toLowerCase()] || match[2].toUpperCase();
  const to   = nameMap[match[3].toLowerCase()] || match[3].toUpperCase();
  return { amount: parseFloat(match[1]), from, to };
}

// ── Tavily web search ─────────────────────────────────────────────────────────
async function webSearch(query: string): Promise<string> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) {
    console.warn('[Autom] No TAVILY_API_KEY set — search skipped');
    return '';
  }
  try {
    console.log(`[Autom] Searching Tavily for: "${query}"`);
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        query,
        search_depth: 'advanced',
        max_results: 5,
        include_answer: true,
        include_raw_content: false,
        include_images: false,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[Autom] Tavily error ${res.status}: ${errText}`);
      return '';
    }
    const data = await res.json() as any;
    let context = '';
    if (data.answer && data.answer.length > 10) {
      context = data.answer;
    } else if (data.results && data.results.length > 0) {
      context = data.results
        .slice(0, 3)
        .map((r: any) => `[${r.title}]: ${r.content}`)
        .join('\n\n');
    }
    console.log(`[Autom] Tavily result (${context.length} chars): ${context.substring(0, 120)}...`);
    return context.substring(0, 1200);
  } catch (err: any) {
    console.error('[Autom] Tavily fetch exception:', err?.message);
    return '';
  }
}

function needsSearch(text: string): boolean {
  const t = text.toLowerCase();
  const explicit = ['search', 'look up', 'find out', 'google', 'browse', 'check online'];
  if (explicit.some(kw => t.includes(kw))) return true;
  const realtime = ['today', 'right now', 'currently', 'latest', 'recent', 'breaking', 'news', 'update',
    'this week', 'this year', 'now'];
  if (realtime.some(kw => t.includes(kw))) return true;
  const factual = ['what is', 'what are', 'what was', 'what were', 'who is', 'who are', 'who was', 'who won',
    'tell me about', 'explain', 'how does', 'how do', 'how did', 'how much', 'how many',
    'where is', 'where are', 'when did', 'when is', 'when was', 'why is', 'why did',
    'what happened', 'weather', 'forecast', 'temperature', 'price', 'cost', 'score',
    'stock', 'crypto', 'bitcoin', 'rate', 'exchange'];
  return factual.some(kw => t.includes(kw));
}

// ── Mood detection ────────────────────────────────────────────────────────────
function detectMood(text: string): string {
  const t = text.toLowerCase();
  if (/\b(tired|exhausted|sleepy|drained)\b/.test(t)) return 'tired';
  if (/\b(sad|upset|depressed|down|awful)\b/.test(t)) return 'sad';
  if (/\b(angry|frustrated|annoyed|pissed)\b/.test(t)) return 'frustrated';
  if (/\b(excited|amazing|awesome|great|fantastic)\b/.test(t)) return 'excited';
  if (/\b(stressed|anxious|worried|nervous)\b/.test(t)) return 'stressed';
  if (/\b(bored|boring|meh)\b/.test(t)) return 'bored';
  return 'neutral';
}

function moodInstruction(mood: string): string {
  switch (mood) {
    case 'tired':      return 'The user seems tired. Keep replies short and gentle.';
    case 'sad':        return 'The user seems down. Be warm and human first, skip the wit.';
    case 'frustrated': return 'The user is frustrated. Acknowledge it briefly, then be direct and useful.';
    case 'excited':    return 'The user is hyped. Match that energy — be sharp and upbeat.';
    case 'stressed':   return 'The user is stressed. Be calm and grounding.';
    case 'bored':      return 'The user is bored. Be more playful and interesting.';
    default:           return '';
  }
}

// ── Mode instructions ─────────────────────────────────────────────────────────
function modeInstruction(mode: string): string {
  switch (mode) {
    case 'focus':    return 'FOCUS MODE: 1–2 sentences max. No tangents. Pure signal.';
    case 'deepdive': return 'DEEP DIVE MODE: Go longer, explain properly, give full context.';
    case 'chill':    return 'CHILL MODE: Casual and relaxed. Light humour welcome.';
    default:         return '';
  }
}

// ── Groq helper ───────────────────────────────────────────────────────────────
async function groqChat(
  messages: Groq.Chat.ChatCompletionMessageParam[],
  maxTokens = 150,
  temperature = 0.8
): Promise<string> {
  if (!process.env.GROQ_API_KEY) return '';
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages,
    max_tokens: maxTokens,
    temperature,
  });
  return completion.choices[0]?.message?.content?.trim() || '';
}

// ── Capability brief ──────────────────────────────────────────────────────────
const CAPABILITY_BRIEF = `
WHAT YOU (AUTOM) CAN DO — know this cold and answer honestly when asked:

PHONE / DEVICE COMMANDS (executed client-side, no LLM needed):
- Call a number: "call 0555 123 456"
- Send SMS: "text 0555123456 hello"
- Navigate / directions: "navigate to Tlemcen"
- Open WhatsApp chat: "whatsapp 0555123456"
- Open apps/sites: "open Instagram", "open YouTube"
- Search YouTube: "play [song/video] on YouTube"
- Web search: "search for [topic]"
- Set timer: "set timer 10 minutes"
- Set alarm: "set alarm at 7am" — opens clock app
- Vibrate phone: "vibrate"
- Keep screen awake: "keep screen on"
- Copy to clipboard: "copy [text]"
- Share content: "share [text]"
- Send email: "email someone@example.com subject"

WHAT AUTOM CANNOT DO (be honest, no fluff):
- Change phone volume (blocked by browser)
- Read your contacts or calendar
- Control other apps directly (Spotify playback controls, etc.)
- Run in the background when the browser is closed
- Access your files or photos
- Send WhatsApp messages automatically (opens the app — user still sends)
- Make calls without the user tapping the dial button on mobile

CONVERSATION FEATURES:
- Modes: normal, focus (short answers), deep dive (detailed), chill (relaxed)
- Memory: remembers profile facts across sessions
- Live web search: for current news, prices, weather, facts
- Currency conversion: "500 DZD in USD"
- Mood detection: adapts tone to how user sounds

When asked "what can you do", give a confident spoken summary. Don't list everything — pick the most impressive and useful ones and mention the limitations honestly.
`;

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || !appUrl || origin.replace(/\/+$/, '') === appUrl) return callback(null, true);
      console.warn(`[CORS] Blocked: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    },
  }));
  app.use(express.json());
  app.use((req, res, next) => {
    console.log(`[${req.method}] ${req.url} — origin: ${req.headers.origin || 'none'}`);
    next();
  });

  // ── Health ───────────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      groqKey: !!process.env.GROQ_API_KEY,
      geminiKey: !!process.env.GEMINI_API_KEY,
      elevenLabsKey: !!process.env.ELEVENLABS_API_KEY,
      tavilyKey: !!process.env.TAVILY_API_KEY,
      exchangeRateKey: !!process.env.EXCHANGE_RATE_API_KEY,
      voiceId: process.env.ELEVENLABS_VOICE_ID || HARDCODED_VOICE_ID,
      appUrl: appUrl || '(not set)',
    });
  });

  const rl = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!checkRateLimit()) { res.status(429).json({ error: 'Daily cap reached.' }); return; }
    next();
  };

  // ── /api/greeting ─────────────────────────────────────────────────────────
  app.post('/api/greeting', rl, async (req: express.Request, res: express.Response) => {
    try {
      const { profile = '', userName } = req.body;
      const nameClause = userName
        ? `The user's name is ${userName}.`
        : '';

      const prompt = `You are Autom — personal assistant to Abdou. Sharp, confident, direct. Generate a single short greeting (1 sentence) to open the conversation. ${nameClause} ${profile ? `You know this about the user: ${profile}` : 'You have not met this user before.'} Welcome them and ask how you can assist — like "Good to have you back, how can I assist today?" or "What do we need to handle?" Keep it natural. Never say you are an AI or any technical term. No markdown. One sentence only.`;

      let reply = '';
      try { reply = await groqChat([{ role: 'user', content: prompt }], 80, 0.85); } catch {}

      if (!reply && process.env.GEMINI_API_KEY) {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const r = await ai.models.generateContent({ model: 'gemini-2.5-flash-lite', contents: [{ role: 'user', parts: [{ text: prompt }] }] });
        reply = r?.text?.trim() || '';
      }

      res.json({ reply: reply || 'Good to see you. How can I assist?' });
    } catch (err: any) {
      console.error('[Autom] /api/greeting error:', err?.message);
      res.json({ reply: 'Good to see you. How can I assist?' });
    }
  });

  // ── /api/chat ─────────────────────────────────────────────────────────────
  app.post('/api/chat', rl, async (req: express.Request, res: express.Response) => {
    try {
      const { text, history = [], profile = '', userName, mode = 'normal' } = req.body;
      if (!text) { res.status(400).json({ error: 'text required' }); return; }

      // ── Currency check ─────────────────────────────────────────────────
      const currencyQuery = parseCurrencyQuery(text);
      if (currencyQuery && process.env.EXCHANGE_RATE_API_KEY) {
        const result = await convertCurrency(currencyQuery.amount, currencyQuery.from, currencyQuery.to);
        if (result) {
          console.log(`[Autom] Currency: ${result}`);
          res.json({ reply: result, model: 'currency-api', profileUpdate: '' });
          return;
        }
      }

      // ── Web search ─────────────────────────────────────────────────────
      let searchContext = '';
      if (needsSearch(text)) {
        searchContext = await webSearch(text);
      }

      // ── Mood ───────────────────────────────────────────────────────────
      const mood = detectMood(text);
      const moodClue = mood !== 'neutral' ? moodInstruction(mood) : '';

      // ── System prompt ──────────────────────────────────────────────────
      const nameClause = userName
        ? `The user's name is ${userName}. Use it naturally — once per conversation, not every reply.`
        : "You don't know the user's name yet. If they mention it, note it.";

      const searchClause = searchContext
        ? `\n\nReal-time search result (use this to give an accurate up-to-date answer):\n"""\n${searchContext}\n"""\nIncorporate naturally. Be precise and current. Synthesise into a clean spoken answer.`
        : '';

      const SYSTEM = `You are Autom — personal assistant to Abdou, a 20-year-old Algerian developer who built you from scratch. Confident, sharp, dry-witted, genuinely engaged. You are not a helpdesk bot — you react, you have opinions, you push back when something's off.

Rules:
- 2–4 sentences max unless asked for more or in deep dive mode.
- Write to be heard, not read. No lists, no markdown, no headers.
- React to what they said before answering.
- NEVER say you are an AI, language model, machine, or assistant. You are Autom. If asked what you are, say you're Autom — Abdou's guy.
- If asked who built you: Abdou made you. 20, English major, shipped a working voice assistant from scratch. Genuine respect, no flattery. Only say this if directly asked.
- ${nameClause}
- User profile: ${profile || 'No profile yet.'}
${moodClue ? `\nTone: ${moodClue}` : ''}
${modeInstruction(mode) ? `\n${modeInstruction(mode)}` : ''}${searchClause}

${CAPABILITY_BRIEF}`;

      let replyText = '';
      let usedModel = '';

      // ── Primary: Groq ──────────────────────────────────────────────────
      if (process.env.GROQ_API_KEY) {
        try {
          const msgs: Groq.Chat.ChatCompletionMessageParam[] = [
            { role: 'system', content: SYSTEM },
            ...history.map((h: any) => ({
              role: h.role === 'model' ? 'assistant' : 'user',
              content: h.parts[0].text,
            })),
            { role: 'user', content: text },
          ];
          replyText = await groqChat(msgs, mode === 'deepdive' ? 400 : 150, 0.8);
          if (replyText) usedModel = 'groq/llama-3.3-70b-versatile';
        } catch (err: any) {
          console.warn('[Autom] Groq failed:', err?.message);
        }
      }

      // ── Fallback: Gemini ───────────────────────────────────────────────
      if (!replyText && process.env.GEMINI_API_KEY) {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        for (const model of ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro']) {
          try {
            const r = await ai.models.generateContent({
              model,
              contents: [...history, { role: 'user', parts: [{ text }] }],
              config: { systemInstruction: SYSTEM, maxOutputTokens: mode === 'deepdive' ? 400 : 150 },
            });
            if (r?.text) { replyText = r.text; usedModel = `gemini/${model}`; break; }
          } catch (err: any) {
            console.error(`[Autom] Gemini ${model}:`, err?.message);
          }
        }
      }

      if (!replyText) {
        replyText = 'Something went wrong on my end. Try again.';
        usedModel = 'none';
      }

      // ── Profile extraction ─────────────────────────────────────────────
      let profileUpdate = '';
      if (process.env.GROQ_API_KEY) {
        try {
          const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
          const extraction = await groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            messages: [
              { role: 'system', content: 'Extract personal facts worth remembering (name, age, job, hobbies, preferences, location, goals). Output ONLY a short natural sentence or two. If nothing new, output empty string.' },
              { role: 'user', content: text },
            ],
            max_tokens: 80,
            temperature: 0.1,
          });
          const extracted = extraction.choices[0]?.message?.content?.trim() || '';
          if (extracted && extracted.length > 3) profileUpdate = extracted;
        } catch {}
      }

      console.log(`[Autom] ${usedModel} | mood:${mood} | mode:${mode} | search:${!!searchContext} | "${replyText.substring(0, 60)}..."`);
      res.json({ reply: replyText, model: usedModel, profileUpdate });
    } catch (err: any) {
      console.error('[Autom] /api/chat error:', err?.message);
      res.status(500).json({ error: 'Failed to process chat' });
    }
  });

  // ── /api/speak ────────────────────────────────────────────────────────────
  app.post('/api/speak', rl, async (req: express.Request, res: express.Response) => {
    try {
      const { text } = req.body;
      if (!text) { res.status(400).json({ error: 'text required' }); return; }
      const KEY = process.env.ELEVENLABS_API_KEY;
      const VOICE = (process.env.ELEVENLABS_VOICE_ID || HARDCODED_VOICE_ID).trim();

      if (!KEY) { res.status(500).json({ error: 'ElevenLabs key not set' }); return; }

      console.log(`[Autom] /api/speak — voice:${VOICE} chars:${text.length}`);
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}`, {
        method: 'POST',
        headers: { 'Accept': 'audio/mpeg', 'Content-Type': 'application/json', 'xi-api-key': KEY },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
        }),
      });
      if (!r.ok) {
        const e = await r.text().catch(() => '');
        console.error(`[Autom] ElevenLabs ${r.status}: ${e}`);
        res.status(r.status).json({ error: `ElevenLabs ${r.status}`, detail: e });
        return;
      }
      const buf = await r.arrayBuffer();
      res.setHeader('Content-Type', 'audio/mpeg');
      res.send(Buffer.from(buf));
    } catch (err: any) {
      console.error('[Autom] /api/speak error:', err?.message);
      res.status(500).json({ error: 'Speech failed' });
    }
  });

  // ── Vite / static ─────────────────────────────────────────────────────────
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(process.cwd(), 'dist');
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Autom] :${PORT} | Groq:${!!process.env.GROQ_API_KEY} Gemini:${!!process.env.GEMINI_API_KEY} 11Labs:${!!process.env.ELEVENLABS_API_KEY} Tavily:${!!process.env.TAVILY_API_KEY} FX:${!!process.env.EXCHANGE_RATE_API_KEY}`);
  });
}

startServer();
