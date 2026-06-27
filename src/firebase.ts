import { initializeApp, getApps } from 'firebase/app';
import { getAuth, GoogleAuthProvider, EmailAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey:            (import.meta as any).env.VITE_FIREBASE_API_KEY,
  authDomain:        (import.meta as any).env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         (import.meta as any).env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     (import.meta as any).env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: (import.meta as any).env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             (import.meta as any).env.VITE_FIREBASE_APP_ID,
};

// Avoid double-init in dev hot reloads
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db   = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
export const emailProvider  = new EmailAuthProvider();
