import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: "__FIREBASE_API__",
  authDomain: "ivory-plane-406700.firebaseapp.com",
  databaseURL: "https://ivory-plane-406700-default-rtdb.firebaseio.com",
  projectId: "ivory-plane-406700",
  storageBucket: "ivory-plane-406700.firebasestorage.app",
  messagingSenderId: "360125182471",
  appId: "1:360125182471:web:a50fde959d1b09936530a2",
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
