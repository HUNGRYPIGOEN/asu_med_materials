#!/usr/bin/env node
/**
 * Detailed inspection of year1-introduction videos and playlists
 */
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, getDoc } from 'firebase/firestore';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = resolve(__dirname, '../.env');
if (existsSync(envPath)) {
  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    const val = rest.join('=').replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) {
      process.env[key] = val;
    }
  }
}

const firebaseConfig = {
  apiKey: process.env.PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.PUBLIC_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function main() {
  const snap = await getDocs(collection(db, 'materials'));
  const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const introDocs = docs.filter(d => d.moduleId === 'year1-introduction' && (d.type === 'youtube' || d.type === 'playlist'));

  console.log(`=== YEAR 1 INTRODUCTION VIDEOS (${introDocs.length} items) ===\n`);

  // 1. Dr. Fayez videos
  const fayezVideos = introDocs.filter(d => 
    (Array.isArray(d.author) && d.author.some(a => a.toLowerCase().includes('fayez'))) ||
    (typeof d.author === 'string' && d.author.toLowerCase().includes('fayez')) ||
    d.id.includes('fayez')
  );
  console.log(`--- Dr. Fayez Materials (${fayezVideos.length}) ---`);
  for (const f of fayezVideos) {
    console.log(`[${f.type}] ${f.id} | ${f.category} | "${f.title}" | tracks: ${f.videos?.length || 0} | ${f.url}`);
    if (f.videos && f.videos.length > 0) {
      console.log(`    Playlist tracks:`);
      for (const t of f.videos) {
        console.log(`      * ${t.id}: "${t.title}" (${t.youtubeId || t.url})`);
      }
    }
  }

  // 2. Abdullah Anatomy items
  console.log(`\n--- Abdullah Anatomy Materials ---`);
  const abdullahItems = introDocs.filter(d => d.id.includes('abdullah'));
  for (const a of abdullahItems) {
    console.log(`[${a.type}] ${a.id} | "${a.title}" | tracks: ${a.videos?.length || 0} | ${a.url}`);
    if (a.videos) {
      for (const t of a.videos) console.log(`      * ${t.id}: "${t.title}" (${t.youtubeId || t.url})`);
    }
  }

  // 3. Zahra Histology items
  console.log(`\n--- Zahra Histology Materials ---`);
  const zahraItems = introDocs.filter(d => d.id.includes('zahra'));
  for (const z of zahraItems) {
    console.log(`[${z.type}] ${z.id} | "${z.title}" | tracks: ${z.videos?.length || 0} | ${z.url}`);
    if (z.videos) {
      for (const t of z.videos) console.log(`      * ${t.id}: "${t.title}" (${t.youtubeId || t.url})`);
    }
  }

  // 4. Check all other standalone youtube videos
  console.log(`\n--- Other Standalone YouTube in year1-introduction ---`);
  const otherYoutube = introDocs.filter(d => d.type === 'youtube' && !d.id.includes('fayez') && !d.id.includes('abdullah') && !d.id.includes('zahra'));
  for (const o of otherYoutube) {
    console.log(`[${o.subject}] ${o.id} | "${o.title}" | author: ${o.author} | ${o.url}`);
  }

  // 5. Check duplicate playlists
  console.log(`\n--- Duplicate / Similar Playlists in year1-introduction ---`);
  const playlists = introDocs.filter(d => d.type === 'playlist');
  const urlMap = {};
  for (const p of playlists) {
    const u = p.url?.trim();
    if (!urlMap[u]) urlMap[u] = [];
    urlMap[u].push(p.id);
  }
  for (const [u, ids] of Object.entries(urlMap)) {
    if (ids.length > 1) {
      console.log(`DUPLICATE PLAYLIST URL: ${u}`);
      console.log(`  IDs: ${ids.join(', ')}`);
    }
  }
}

main().catch(console.error);
