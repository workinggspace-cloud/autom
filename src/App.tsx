import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, Hand, Settings, X, Download, LogOut, LogIn } from 'lucide-react';
import Ring from './components/Ring';
import { auth, db, googleProvider } from './firebase';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  setDoc,
} from 'firebase/firestore';

// @ts-ignore
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const HAS_SPEECH = !!SR;
const API_URL = ((import.meta as any).env.VITE_API_URL || '').replace(/\/+$/, '');
const HAS_FIREBASE = !!(import.meta as any).env.VITE_FIREBASE_API_KEY;

type AppState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';
type Mode = 'normal' | 'focus' | 'deepdive' | 'chill';

// ── Kill recognition ──────────────────────────────────────────────────────────
function killRecognition(ref: React.MutableRefObject<any>) {
  if (!ref.current) return;
  const r = ref.current; ref.current = null;
  r.onresult = null; r.onerror = null; r.onend = null; r.onstart = null;
  try { r.abort(); } catch (_) {}
}

// ── Storage helpers ───────────────────────────────────────────────────────────
const storage = {
  get: (k: string, fallback = '') => { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
  getJSON: <T,>(k: string, fallback: T): T => {
    try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : fallback; } catch { return fallback; }
  },
  setJSON: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ── Phone command executor ────────────────────────────────────────────────────
function executePhoneCommand(cmd: string): { executed: boolean; feedback: string } {
  const t = cmd.toLowerCase().trim();

  const callMatch = t.match(/(?:call|dial|ring)\s+([\d\s\+\-\(\)]{5,})/i);
  if (callMatch) {
    const num = callMatch[1].replace(/\s/g, '');
    window.location.href = `tel:${num}`;
    return { executed: true, feedback: `Calling ${num}.` };
  }

  const smsMatch = t.match(/(?:text|sms|message|send message to)\s+([\d\s\+]{5,})\s*(.*)/i);
  if (smsMatch) {
    const num = smsMatch[1].replace(/\s/g, '');
    const body = encodeURIComponent(smsMatch[2]?.trim() || '');
    window.location.href = `sms:${num}${body ? `?body=${body}` : ''}`;
    return { executed: true, feedback: `Opening SMS to ${num}.` };
  }

  const navMatch = t.match(/(?:navigate to|directions to|take me to|go to|open maps for)\s+(.+)/i);
  if (navMatch) {
    const dest = encodeURIComponent(navMatch[1].trim());
    window.open(`https://maps.google.com/?q=${dest}&travelmode=driving`, '_blank');
    return { executed: true, feedback: `Opening navigation to ${navMatch[1].trim()}.` };
  }

  const ytMatch = t.match(/(?:play|search youtube|youtube)\s+(.+?)(?:\s+on youtube)?$/i);
  if (ytMatch && (t.includes('youtube') || t.includes('play '))) {
    const q = encodeURIComponent(ytMatch[1].trim());
    window.open(`https://www.youtube.com/results?search_query=${q}`, '_blank');
    return { executed: true, feedback: `Searching YouTube for ${ytMatch[1].trim()}.` };
  }

  const waMatch = t.match(/(?:whatsapp)\s*([\d\+]{7,})?\s*(.*)/i);
  if (waMatch && t.includes('whatsapp')) {
    const num = waMatch[1]?.replace(/\s/g, '') || '';
    const msg = encodeURIComponent(waMatch[2]?.trim() || '');
    if (num) {
      window.open(`https://wa.me/${num}${msg ? `?text=${msg}` : ''}`, '_blank');
      return { executed: true, feedback: `Opening WhatsApp to ${num}.` };
    } else {
      window.open('https://wa.me/', '_blank');
      return { executed: true, feedback: 'Opening WhatsApp.' };
    }
  }

  const openMatch = t.match(/(?:open|launch)\s+(.+)/i);
  if (openMatch) {
    const app = openMatch[1].trim().toLowerCase();
    const appMap: Record<string, string> = {
      'instagram': 'https://instagram.com',
      'facebook': 'https://facebook.com',
      'twitter': 'https://twitter.com',
      'x': 'https://twitter.com',
      'tiktok': 'https://tiktok.com',
      'telegram': 'https://t.me',
      'gmail': 'https://mail.google.com',
      'google': 'https://google.com',
      'spotify': 'https://open.spotify.com',
      'netflix': 'https://netflix.com',
      'maps': 'https://maps.google.com',
      'google maps': 'https://maps.google.com',
      'youtube': 'https://youtube.com',
      'linkedin': 'https://linkedin.com',
      'reddit': 'https://reddit.com',
      'snapchat': 'https://snapchat.com',
    };
    const url = appMap[app] || `https://${app}.com`;
    window.open(url, '_blank');
    return { executed: true, feedback: `Opening ${openMatch[1].trim()}.` };
  }

  const timerMatch = t.match(/(?:set timer|timer for|timer|remind me in)\s+(\d+)\s*(minute|min|second|sec|hour)?s?/i);
  if (timerMatch) {
    const amount = parseInt(timerMatch[1]);
    const unit = (timerMatch[2] || 'minute').toLowerCase();
    let ms = amount * 60000;
    if (unit.startsWith('sec')) ms = amount * 1000;
    if (unit.startsWith('hour')) ms = amount * 3600000;
    const unitLabel = unit.startsWith('sec') ? 'seconds' : unit.startsWith('hour') ? 'hours' : 'minutes';
    setTimeout(() => {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Autom Timer', { body: `Your ${amount} ${unitLabel} timer is done.`, icon: '/icon.png' });
      } else {
        alert(`⏱️ Your ${amount} ${unitLabel} timer is done!`);
      }
    }, ms);
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    return { executed: true, feedback: `Timer set for ${amount} ${unitLabel}.` };
  }

  const alarmMatch = t.match(/(?:set alarm|alarm at|alarm for)\s+(\d{1,2}(?::\d{2})?(?:\s*[ap]m)?)/i);
  if (alarmMatch) {
    window.location.href = `clock://alarm`;
    return { executed: true, feedback: `Opening clock to set alarm at ${alarmMatch[1]}.` };
  }

  // NOTE: "search for X" is intentionally NOT handled here.
  // It goes to the backend so Autom can answer with Tavily web search.
  // Only "open google" explicitly opens the browser.

  const emailMatch = t.match(/(?:email|send email to|mail)\s+([\w@.\-]+)\s*(.*)/i);
  if (emailMatch) {
    const addr = emailMatch[1];
    const subject = encodeURIComponent(emailMatch[2]?.trim() || '');
    window.location.href = `mailto:${addr}${subject ? `?subject=${subject}` : ''}`;
    return { executed: true, feedback: `Opening email to ${addr}.` };
  }

  if (/vibrate|buzz/.test(t)) {
    if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]);
    return { executed: true, feedback: 'Vibrating.' };
  }

  if (/keep screen on|don.t sleep|stay awake/.test(t)) {
    if ('wakeLock' in navigator) {
      (navigator as any).wakeLock.request('screen').catch(() => {});
      return { executed: true, feedback: 'Screen will stay on.' };
    }
  }

  const copyMatch = t.match(/(?:copy)\s+(.+)/i);
  if (copyMatch) {
    navigator.clipboard?.writeText(copyMatch[1].trim()).catch(() => {});
    return { executed: true, feedback: 'Copied to clipboard.' };
  }

  const shareMatch = t.match(/(?:share)\s+(.+)/i);
  if (shareMatch && 'share' in navigator) {
    (navigator as any).share({ title: 'Shared from Autom', text: shareMatch[1].trim() }).catch(() => {});
    return { executed: true, feedback: 'Share sheet opened.' };
  }

  return { executed: false, feedback: '' };
}

// ── Levenshtein distance ──────────────────────────────────────────────────────
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

export default function App() {
  const [appState, setAppState] = useState<AppState>('idle');
  const appStateRef = useRef<AppState>('idle');
  const setS = (s: AppState) => { appStateRef.current = s; setAppState(s); };

  const [statusText, setStatusText] = useState('');
  const [mode, setMode] = useState<Mode>(() => storage.get('autom_mode', 'normal') as Mode);
  const [profile, setProfile] = useState(() => storage.get('autom_profile'));
  const [sessionHistory, setHistory] = useState<any[]>(() => storage.getJSON('autom_history', []));
  const [showSettings, setShowSettings] = useState(false);
  const [wakeWord, setWakeWord] = useState(() => storage.get('autom_wakeword', 'invoke').toLowerCase());
  const [wakeWordInput, setWakeWordInput] = useState(() => storage.get('autom_wakeword', 'invoke'));
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [pushToTalk, setPushToTalk] = useState(() => storage.get('pushToTalk', 'true') === 'true');

  // ── Auth state ─────────────────────────────────────────────────────────────
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(HAS_FIREBASE);
  const [userName, setUserName] = useState<string>('');
  // sign-in card: null = not decided, 'card' = showing, 'hidden' = dismissed
  const [signInCardState, setSignInCardState] = useState<'card' | 'badge' | 'hidden'>('card');
  // name prompt shown after sign-in
  const [showNamePrompt, setShowNamePrompt] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  const pushToTalkRef = useRef(pushToTalk);
  const wakeWordRef = useRef(wakeWord);
  const modeRef = useRef(mode);

  useEffect(() => { pushToTalkRef.current = pushToTalk; }, [pushToTalk]);
  useEffect(() => { wakeWordRef.current = wakeWord; }, [wakeWord]);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  // Persist changes (local storage fallback for guests)
  useEffect(() => { storage.set('autom_profile', profile); }, [profile]);
  useEffect(() => { storage.setJSON('autom_history', sessionHistory.slice(-20)); }, [sessionHistory]);
  useEffect(() => { storage.set('autom_mode', mode); }, [mode]);
  useEffect(() => { storage.set('pushToTalk', String(pushToTalk)); }, [pushToTalk]);

  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const wakeRef = useRef<any>(null);
  const cmdRef = useRef<any>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const speakAbortRef = useRef<AbortController | null>(null);
  const greetedRef = useRef(false);

  // ── Firestore helpers ──────────────────────────────────────────────────────
  const userRef = useRef<User | null>(null);

  const firestoreLoad = async (uid: string) => {
    try {
      const ref = doc(db, 'users', uid);
      const snap = await getDoc(ref);
      console.log('[Autom] Firestore load — exists:', snap.exists());
      if (snap.exists()) {
        const data = snap.data();
        if (data.profile) { setProfile(data.profile); storage.set('autom_profile', data.profile); }
        if (data.name)    { setUserName(data.name); }
        if (data.history) { setHistory(data.history); storage.setJSON('autom_history', data.history); }
      }
    } catch (err) {
      console.error('[Autom] Firestore load failed:', err);
    }
  };

  const firestoreSaveProfile = async (uid: string, newProfile: string) => {
    try {
      const ref = doc(db, 'users', uid);
      await setDoc(ref, { profile: newProfile }, { merge: true });
      console.log('[Autom] Firestore profile saved');
    } catch (err) {
      console.error('[Autom] Firestore profile save failed:', err);
    }
  };

  const firestoreSaveHistory = async (uid: string, history: any[]) => {
    try {
      const ref = doc(db, 'users', uid);
      await setDoc(ref, { history: history.slice(-20) }, { merge: true });
      console.log('[Autom] Firestore history saved, length:', history.length);
    } catch (err) {
      console.error('[Autom] Firestore history save failed:', err);
    }
  };

  const firestoreSaveName = async (uid: string, name: string) => {
    try {
      const ref = doc(db, 'users', uid);
      await setDoc(ref, { name }, { merge: true });
      console.log('[Autom] Firestore name saved:', name);
    } catch (err) {
      console.error('[Autom] Firestore name save failed:', err);
    }
  };

  // ── Auth listener ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!HAS_FIREBASE) return;
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      userRef.current = u;
      setAuthLoading(false);
      if (u) {
        setSignInCardState('hidden');
        await firestoreLoad(u.uid);
      }
    });
    return unsub;
  }, []);

  const handleGoogleSignIn = async () => {
    if (authBusy) return;
    setAuthBusy(true);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const u = result.user;
      // Check if new user (no name saved yet)
      const ref = doc(db, 'users', u.uid);
      const snap = await getDoc(ref);
      if (!snap.exists() || !snap.data()?.name) {
        setShowNamePrompt(true);
      }
    } catch (err: any) {
      console.error('[Autom] Sign-in error:', err?.message);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = async () => {
    try { await signOut(auth); setUserName(''); setSignInCardState('card'); } catch {}
  };

  const handleNameSubmit = async () => {
    const trimmed = nameInput.trim();
    if (user) {
      if (trimmed) {
        setUserName(trimmed);
        await firestoreSaveName(user.uid, trimmed);
        const updatedProfile = profile
          ? `Name: ${trimmed}\n${profile}`
          : `Name: ${trimmed}`;
        setProfile(updatedProfile);
        await firestoreSaveProfile(user.uid, updatedProfile);
      }
    }
    setShowNamePrompt(false);
    setNameInput('');
  };

  // Write profile to Firestore whenever it changes (signed-in only)
  const profileRef = useRef(profile);
  useEffect(() => {
    profileRef.current = profile;
    const u = userRef.current;
    if (u) firestoreSaveProfile(u.uid, profile);
  }, [profile]);

  // Write history to Firestore whenever it changes (signed-in only)
  useEffect(() => {
    const u = userRef.current;
    if (u) firestoreSaveHistory(u.uid, sessionHistory);
  }, [sessionHistory]);

  // Unlock AudioContext
  useEffect(() => {
    const unlock = () => {
      if (!audioContextRef.current)
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      if (audioContextRef.current.state === 'suspended') audioContextRef.current.resume();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // PWA install prompt
  useEffect(() => {
    const handler = (e: any) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // Notification permission
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  const installPWA = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') setInstallPrompt(null);
  };

  const getEffectiveName = () => {
    if (userName) return userName;
    const m = profile.match(/name[:\s]+([A-Za-z]+)/i) || profile.match(/^([A-Z][a-z]+)\b/);
    return m ? m[1] : null;
  };

  // ── Greeting ──────────────────────────────────────────────────────────────
  const triggerGreeting = useCallback(async () => {
    if (greetedRef.current || !API_URL) return;
    greetedRef.current = true;
    setS('thinking');
    try {
      const res = await fetch(`${API_URL}/api/greeting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, userName: getEffectiveName() }),
      });
      if (!res.ok) throw new Error('greeting failed');
      const { reply } = await res.json();
      await handleResponseText(reply, false);
    } catch {
      setS('idle');
    }
  }, [profile]);

  // ── Fuzzy wake word matching ──────────────────────────────────────────────
  const matchesWakeWord = useCallback((transcript: string, wakeWord: string): boolean => {
    const t = transcript.toLowerCase().trim();
    const w = wakeWord.toLowerCase().trim();
    if (t.includes(w)) return true;
    const words = t.split(/\s+/);
    for (const word of words) {
      if (word.length < 2) continue;
      const maxDist = Math.max(1, Math.floor(w.length / 4));
      if (levenshtein(word, w) <= maxDist) return true;
      if (word.startsWith(w) || w.startsWith(word)) return true;
    }
    return false;
  }, []);

  // ── Wake word listener ────────────────────────────────────────────────────
  const startWakeWord = useCallback(() => {
    if (!HAS_SPEECH || pushToTalkRef.current || appStateRef.current !== 'idle') return;
    killRecognition(wakeRef);
    const r = new SR();
    wakeRef.current = r;
    r.continuous = true; r.interimResults = false; r.lang = 'en-US'; r.maxAlternatives = 5;
    r.onresult = (e: any) => {
      const result = e.results[e.results.length - 1];
      for (let i = 0; i < result.length; i++) {
        const t = result[i].transcript.trim().toLowerCase();
        if (matchesWakeWord(t, wakeWordRef.current)) {
          triggerListening();
          break;
        }
      }
    };
    r.onerror = (e: any) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed') { setStatusText('Mic blocked — use Force Wake or check browser settings'); return; }
    };
    r.onend = () => {
      if (appStateRef.current === 'idle' && !pushToTalkRef.current && wakeRef.current === r)
        setTimeout(() => { if (appStateRef.current === 'idle' && !pushToTalkRef.current) { try { r.start(); } catch {} } }, 300);
    };
    try { r.start(); } catch {}
  }, []);

  // ── Trigger listening ─────────────────────────────────────────────────────
  const triggerListening = useCallback(() => {
    if (appStateRef.current !== 'idle') return;
    setS('listening'); setStatusText('');
    killRecognition(wakeRef);
    setTimeout(startCommandRec, 600);
  }, []);

  // ── Command recognition ───────────────────────────────────────────────────
  const startCommandRec = useCallback(() => {
    if (!HAS_SPEECH) { handleError('Speech not supported.'); return; }
    killRecognition(cmdRef);
    const r = new SR();
    cmdRef.current = r;
    r.continuous = false; r.interimResults = false; r.lang = 'en-US'; r.maxAlternatives = 3;
    let got = false;
    r.onresult = (e: any) => {
      got = true;
      const t = e.results[0][0].transcript.trim();
      killRecognition(cmdRef);
      processCommand(t);
    };
    r.onerror = (e: any) => {
      if (e.error === 'aborted') return;
      if (e.error === 'not-allowed') { handleError('Mic denied. Allow mic and reload.'); return; }
      if (!got) { setS('idle'); setTimeout(startWakeWord, 500); }
    };
    r.onend = () => {
      if (!got && appStateRef.current === 'listening') { setS('idle'); setTimeout(startWakeWord, 500); }
    };
    try { r.start(); } catch {
      setTimeout(() => {
        if (appStateRef.current !== 'listening') return;
        try {
          const r2 = new SR(); cmdRef.current = r2;
          r2.continuous = false; r2.interimResults = false; r2.lang = 'en-US';
          r2.onresult = r.onresult; r2.onerror = r.onerror; r2.onend = r.onend;
          r2.start();
        } catch { setS('idle'); setTimeout(startWakeWord, 500); }
      }, 400);
    }
  }, [startWakeWord]);

  // Mount: greeting + wake word
  useEffect(() => {
    const t = setTimeout(() => triggerGreeting(), 1200);
    if (!pushToTalk) setTimeout(startWakeWord, 800);
    return () => {
      clearTimeout(t);
      killRecognition(wakeRef);
      killRecognition(cmdRef);
    };
  }, []);

  useEffect(() => {
    if (pushToTalk) {
      killRecognition(wakeRef); killRecognition(cmdRef);
      setStatusText(''); setS('idle');
    } else {
      setTimeout(startWakeWord, 300);
    }
  }, [pushToTalk]);

  // ── Process command ───────────────────────────────────────────────────────
  const processCommand = async (text: string) => {
    if (!text.trim()) { setS('idle'); setTimeout(startWakeWord, 500); return; }

    // ── Memory wipe ──────────────────────────────────────────────────────
    if (/forget everything|wipe memory/i.test(text)) {
      setProfile(''); setHistory([]);
      storage.set('autom_profile', ''); storage.setJSON('autom_history', []);
      await handleResponseText('Memory wiped. Starting fresh.', true);
      return;
    }

    // ── Mode switching ───────────────────────────────────────────────────
    if (/focus mode/i.test(text))    { setMode('focus');    await handleResponseText('Focus mode on. Short answers only.', true); return; }
    if (/deep dive/i.test(text))     { setMode('deepdive'); await handleResponseText('Deep dive mode on.', true); return; }
    if (/chill mode/i.test(text))    { setMode('chill');    await handleResponseText("Chill mode. Let's relax.", true); return; }
    if (/normal mode|reset mode/i.test(text)) { setMode('normal'); await handleResponseText('Back to normal.', true); return; }

    // ── Phone commands — try before sending to LLM ───────────────────────
    const phoneResult = executePhoneCommand(text);
    if (phoneResult.executed) {
      await handleResponseText(phoneResult.feedback, true);
      return;
    }

    // ── Send to backend ──────────────────────────────────────────────────
    setS('thinking');
    if (chatAbortRef.current) chatAbortRef.current.abort();
    const abort = new AbortController();
    chatAbortRef.current = abort;

    const slowTimer = setTimeout(() => {
      if (appStateRef.current === 'thinking')
        setStatusText('Waking up server… ~30s on first request');
    }, 8000);

    try {
      const signal = (AbortSignal as any).any
        ? (AbortSignal as any).any([abort.signal, AbortSignal.timeout(90000)])
        : abort.signal;

      const res = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          history: sessionHistory,
          profile,
          userName: getEffectiveName(),
          mode: modeRef.current,
        }),
        signal,
      });

      clearTimeout(slowTimer); setStatusText('');
      if (res.status === 429) throw new Error('RATE_LIMITED');
      if (!res.ok) throw new Error(`HTTP_${res.status}`);

      const data = await res.json();
      if (abort.signal.aborted) return;

      const newHistory = [
        ...sessionHistory,
        { role: 'user', parts: [{ text }] },
        { role: 'model', parts: [{ text: data.reply }] },
      ];
      setHistory(newHistory);
      storage.setJSON('autom_history', newHistory.slice(-20));

      if (data.profileUpdate?.trim()) {
        const merged = (profile + '\n' + data.profileUpdate).trim();
        setProfile(merged);
        storage.set('autom_profile', merged);
      }

      await handleResponseText(data.reply, true);
    } catch (err: any) {
      clearTimeout(slowTimer); setStatusText('');
      if (abort.signal.aborted) return;
      if (err.message === 'RATE_LIMITED') handleError("Hit my daily cap. Try again tomorrow.");
      else if (err.name === 'TimeoutError') handleError('Timed out. Try again.');
      else handleError("Can't reach my backend.");
    }
  };

  // ── TTS ──────────────────────────────────────────────────────────────────
  const handleResponseText = async (text: string, autoListen: boolean) => {
    setS('speaking');
    if (speakAbortRef.current) speakAbortRef.current.abort();
    const abort = new AbortController();
    speakAbortRef.current = abort;

    const onDone = () => {
      setTimeout(() => {
        if (autoListen) {
          setS('listening'); setStatusText('');
          setTimeout(startCommandRec, 400);
        } else {
          setS('idle');
          if (!pushToTalkRef.current) setTimeout(startWakeWord, 500);
        }
      }, 300);
    };

    try {
      const r = await fetch(`${API_URL}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: abort.signal,
      });
      if (!r.ok) { if (!abort.signal.aborted) fallbackTTS(text, onDone); return; }
      const buf = await r.arrayBuffer();
      if (abort.signal.aborted) return;
      playAudio(buf, text, onDone);
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      if (!abort.signal.aborted) fallbackTTS(text, onDone);
    }
  };

  const playAudio = async (buf: ArrayBuffer, text: string, onDone: () => void) => {
    try {
      if (!audioContextRef.current)
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') await ctx.resume();
      const decoded = await ctx.decodeAudioData(buf);
      const src = ctx.createBufferSource();
      src.buffer = decoded; src.connect(ctx.destination);
      audioSourceRef.current = src;
      src.onended = onDone;
      src.start();
    } catch { fallbackTTS(text, onDone); }
  };

  const fallbackTTS = (text: string, onDone: () => void) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.onend = onDone; u.onerror = onDone;
      window.speechSynthesis.speak(u);
    } else { onDone(); }
  };

  const handleError = (msg: string) => {
    setS('error'); setStatusText(msg);
    fallbackTTS(msg, () => { setS('idle'); if (!pushToTalkRef.current) setTimeout(startWakeWord, 500); });
  };

  const stopSpeaking = () => {
    if (speakAbortRef.current) speakAbortRef.current.abort();
    if (chatAbortRef.current) chatAbortRef.current.abort();
    if (audioSourceRef.current) { try { audioSourceRef.current.stop(); } catch {} audioSourceRef.current = null; }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setS('idle'); setStatusText('');
    if (!pushToTalkRef.current) setTimeout(startWakeWord, 500);
  };

  const saveWakeWord = () => {
    const w = wakeWordInput.trim().toLowerCase();
    if (!w) return;
    setWakeWord(w);
    storage.set('autom_wakeword', w);
    setShowSettings(false);
  };

  // ── Mode labels ───────────────────────────────────────────────────────────
  const modeLabel: Record<Mode, string> = { normal: '', focus: 'FOCUS', deepdive: 'DEEP DIVE', chill: 'CHILL' };
  const modeColor: Record<Mode, string> = { normal: '', focus: 'text-yellow-400', deepdive: 'text-indigo-300', chill: 'text-green-400' };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="app-shell flex flex-col items-center justify-center bg-black font-sans relative"
      onClick={() => {
        if (showSettings) return;
        if (appState === 'speaking' || appState === 'thinking') stopSpeaking();
        else if (pushToTalk && appState === 'idle') triggerListening();
        else if (appState === 'listening') {
          killRecognition(cmdRef); setS('idle');
          if (!pushToTalkRef.current) setTimeout(startWakeWord, 500);
        }
      }}
    >
      {/* Background layers */}
      <div className="stars-layer" />
      <div className="scanlines" />
      <div className="scanline-sweep" />
      <div className="vignette" />
      <div className="corner-tl" /><div className="corner-tr" />
      <div className="corner-bl" /><div className="corner-br" />
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(circle at center, rgba(8,145,178,0.08) 0%, transparent 65%)', zIndex: 5 }} />

      {/* Mode badge */}
      {mode !== 'normal' && (
        <div className={`absolute top-6 z-20 font-mono text-xs tracking-widest ${modeColor[mode]} border border-current/30 px-3 py-1 rounded-full bg-black/60`}>
          {modeLabel[mode]}
        </div>
      )}

      {/* Ring */}
      <div className={`relative z-10 transition-transform duration-300 ${pushToTalk && appState === 'idle' ? 'cursor-pointer hover:scale-105 active:scale-95' : ''}`}>
        <Ring state={appState} />
      </div>

      {/* Status text */}
      <div className="relative z-10 mt-4 min-h-[2.5rem] text-center px-8 max-w-xs">
        {statusText ? (
          <p className="text-red-400/90 font-mono text-xs tracking-wide leading-relaxed">{statusText}</p>
        ) : appState === 'listening' ? (
          <p className="text-cyan-300/80 font-mono text-xs tracking-widest uppercase animate-pulse">Listening…</p>
        ) : appState === 'thinking' ? (
          <p className="text-indigo-300/70 font-mono text-xs tracking-widest uppercase animate-pulse">Thinking…</p>
        ) : appState === 'speaking' ? (
          <p className="text-cyan-400/60 font-mono text-xs tracking-widest uppercase">Tap to interrupt</p>
        ) : pushToTalk ? (
          <p className="text-cyan-500/50 font-mono text-sm tracking-widest uppercase animate-pulse">Tap to Speak</p>
        ) : null}
      </div>

      {/* Bottom-right: Settings + PTT */}
      <div className="absolute z-20 right-4 sm:right-8 bottom-safe flex flex-col items-end gap-2">
        {showSettings && (
          <div
            className="bg-gray-950 border border-cyan-900/60 rounded-xl p-4 w-72 shadow-2xl mb-2"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-3">
              <span className="text-cyan-300 font-mono text-xs tracking-widest uppercase">Settings</span>
              <button onClick={() => setShowSettings(false)} className="text-cyan-600 hover:text-cyan-300"><X className="w-4 h-4" /></button>
            </div>

            {/* Account section */}
            {HAS_FIREBASE && (
              <div className="mb-4 pb-4 border-b border-cyan-900/40">
                <label className="text-cyan-500/70 font-mono text-xs tracking-wide block mb-2">Account</label>
                {user ? (
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-cyan-200 font-mono text-sm">{userName || user.email?.split('@')[0] || 'Signed in'}</p>
                      <p className="text-cyan-700 font-mono text-xs">{user.email}</p>
                    </div>
                    <button
                      onClick={handleSignOut}
                      className="flex items-center gap-1 text-xs text-red-400/80 border border-red-900/40 rounded px-2 py-1 font-mono hover:bg-red-950/30 transition-colors"
                    >
                      <LogOut className="w-3 h-3" />
                      Sign out
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleGoogleSignIn}
                    disabled={authBusy}
                    className="w-full flex items-center justify-center gap-2 text-xs font-mono text-cyan-300 border border-cyan-800/60 rounded py-1.5 bg-black/40 hover:bg-cyan-950/30 transition-colors disabled:opacity-50"
                  >
                    <LogIn className="w-3.5 h-3.5" />
                    Sign in with Google
                  </button>
                )}
              </div>
            )}

            {/* Wake word */}
            <div className="mb-4">
              <label className="text-cyan-500/70 font-mono text-xs tracking-wide block mb-1">Wake Word</label>
              <div className="flex gap-2">
                <input
                  value={wakeWordInput}
                  onChange={e => setWakeWordInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && saveWakeWord()}
                  className="bg-black border border-cyan-800/60 text-cyan-100 font-mono text-sm rounded px-2 py-1 flex-1 outline-none focus:border-cyan-500"
                  placeholder="invoke"
                />
                <button onClick={saveWakeWord} className="text-xs text-cyan-400 border border-cyan-700/60 px-2 py-1 rounded font-mono hover:bg-cyan-900/30">Save</button>
              </div>
              <p className="text-cyan-700 font-mono text-xs mt-1">Current: "{wakeWord}"</p>
            </div>

            {/* Modes */}
            <div className="mb-4">
              <label className="text-cyan-500/70 font-mono text-xs tracking-wide block mb-2">Mode</label>
              <div className="grid grid-cols-2 gap-1.5">
                {([['normal','Normal',''],['focus','Focus','text-yellow-400'],['deepdive','Deep Dive','text-indigo-300'],['chill','Chill','text-green-400']] as [Mode,string,string][]).map(([m, label, color]) => (
                  <button key={m} onClick={() => { setMode(m); modeRef.current = m; storage.set('autom_mode', m); }}
                    className={`font-mono text-xs py-1.5 px-2 rounded border transition-colors ${mode === m ? 'bg-cyan-900/50 border-cyan-500/60 text-cyan-200' : `border-cyan-900/40 bg-black/40 ${color || 'text-cyan-600'} hover:border-cyan-700/60`}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Wipe Memory */}
            <button
              onClick={() => { setProfile(''); setHistory([]); storage.set('autom_profile', ''); storage.setJSON('autom_history', []); setShowSettings(false); }}
              className="w-full text-xs font-mono text-red-400/70 border border-red-900/40 rounded py-1.5 hover:bg-red-950/30 transition-colors"
            >
              Wipe Memory
            </button>
          </div>
        )}

        <div className="flex gap-2">
          <button onClick={(e) => { e.stopPropagation(); setShowSettings(v => !v); }}
            className="p-3 rounded-full border border-cyan-900/50 bg-gray-900/50 text-cyan-500/70 hover:text-cyan-300 transition-colors shadow-lg">
            <Settings className="w-5 h-5" />
          </button>
          <button onClick={(e) => { e.stopPropagation(); setPushToTalk(v => !v); }}
            title={pushToTalk ? 'Switch to wake-word mode' : 'Switch to push-to-talk'}
            className={`p-3 rounded-full border transition-colors shadow-lg ${pushToTalk ? 'bg-cyan-900/50 border-cyan-500/60 text-cyan-300' : 'bg-gray-900/50 border-cyan-900/50 text-cyan-500/80'}`}>
            {pushToTalk ? <Hand className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {/* Bottom-left: Force Wake + Install */}
      <div className="absolute z-20 left-4 sm:left-8 bottom-safe flex flex-col items-start gap-2">
        {installPrompt && (
          <button onClick={(e) => { e.stopPropagation(); installPWA(); }}
            className="flex items-center gap-1.5 text-xs text-cyan-400 font-mono border border-cyan-700/60 bg-black/70 px-3 py-2 rounded-lg hover:bg-cyan-950/40 transition-colors">
            <Download className="w-3.5 h-3.5" />
            Install App
          </button>
        )}
        {!pushToTalk && (
          <button onClick={(e) => { e.stopPropagation(); triggerListening(); }}
            className="text-sm text-cyan-400 active:text-cyan-200 font-mono border border-cyan-700/70 bg-black/60 px-4 py-2 rounded-lg transition-colors">
            Force Wake
          </button>
        )}
      </div>

      {/* ── Sign-in floating card (bottom center, over background) ── */}
      {HAS_FIREBASE && !authLoading && !user && signInCardState === 'card' && (
        <div
          className="absolute bottom-safe z-30 left-1/2 -translate-x-1/2 mb-4 w-[calc(100%-2rem)] max-w-sm"
          onClick={e => e.stopPropagation()}
        >
          <div className="bg-gray-950/90 border border-cyan-900/50 rounded-2xl p-4 shadow-2xl backdrop-blur-sm">
            <p className="text-cyan-300/80 font-mono text-xs text-center mb-3 tracking-wide">
              Sign in to remember you across sessions
            </p>
            <button
              onClick={handleGoogleSignIn}
              disabled={authBusy}
              className="w-full flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 text-white font-mono text-sm rounded-xl py-2.5 border border-white/10 transition-colors disabled:opacity-50"
            >
              {/* Google G */}
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              {authBusy ? 'Signing in…' : 'Continue with Google'}
            </button>
            <button
              onClick={() => setSignInCardState('badge')}
              className="w-full text-center text-cyan-700 font-mono text-xs mt-2 py-1 hover:text-cyan-500 transition-colors"
            >
              Skip for now
            </button>
          </div>
        </div>
      )}

      {/* ── Persistent sign-in badge (after skipping) ── */}
      {HAS_FIREBASE && !authLoading && !user && signInCardState === 'badge' && (
        <button
          className="absolute bottom-safe right-1/2 translate-x-1/2 mb-1 z-30 text-xs font-mono text-cyan-700/70 border border-cyan-900/30 bg-black/60 px-3 py-1 rounded-full hover:text-cyan-400 transition-colors"
          onClick={(e) => { e.stopPropagation(); setSignInCardState('card'); }}
        >
          Sign in
        </button>
      )}

      {/* ── Name prompt (after sign-in, one field only) ── */}
      {showNamePrompt && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={e => e.stopPropagation()}
        >
          <div className="bg-gray-950 border border-cyan-900/60 rounded-2xl p-6 w-[calc(100%-2rem)] max-w-xs shadow-2xl">
            <p className="text-cyan-200 font-mono text-sm text-center mb-4">What should I call you?</p>
            <input
              autoFocus
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleNameSubmit()}
              className="w-full bg-black border border-cyan-800/60 text-cyan-100 font-mono text-sm rounded-xl px-3 py-2 outline-none focus:border-cyan-500 text-center"
              placeholder="Your name"
            />
            <button
              onClick={handleNameSubmit}
              className="mt-3 w-full text-sm font-mono text-cyan-300 border border-cyan-700/60 rounded-xl py-2 hover:bg-cyan-950/30 transition-colors"
            >
              {nameInput.trim() ? 'Set name' : 'Skip'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
