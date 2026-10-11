#!/usr/bin/env node
/**
 * Audit Video Groupings Across All Modules
 *
 * Scans all materials in Firestore where type === 'youtube' or type === 'playlist'
 * and reports potential groupings by:
 * - Module
 * - Subject
 * - Author / Doctor
 * - Title keywords (e.g., lecture parts, practical parts, revision parts)
 *
 * Usage:
 *   node --env-file=.env scripts/audit-video-groupings.mjs
 */

import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
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
  console.log('Fetching all materials from Firestore...');
  const snap = await getDocs(collection(db, 'materials'));
  const allDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const videoDocs = allDocs.filter(d => d.type === 'youtube' || d.type === 'playlist');
  console.log(`Found ${videoDocs.length} total video/playlist materials across ${allDocs.length} total materials.`);

  const youtubeSingles = videoDocs.filter(d => d.type === 'youtube');
  const playlists = videoDocs.filter(d => d.type === 'playlist');

  console.log(`- Standalone YouTube: ${youtubeSingles.length}`);
  console.log(`- Playlists: ${playlists.length}`);

  // Group by moduleId
  const byModule = {};
  for (const item of youtubeSingles) {
    const mod = item.moduleId || 'unassigned';
    if (!byModule[mod]) byModule[mod] = [];
    byModule[mod].push(item);
  }

  console.log('\n=============================================');
  console.log('STANDALONE YOUTUBE VIDEOS BY MODULE:');
  console.log('=============================================');

  for (const [mod, items] of Object.entries(byModule)) {
    console.log(`\nModule: [${mod}] (${items.length} standalone videos)`);
    // Group by author or subject
    const bySubject = {};
    for (const it of items) {
      const subj = it.subject || 'Unknown Subject';
      if (!bySubject[subj]) bySubject[subj] = [];
      bySubject[subj].push(it);
    }

    for (const [subj, subjItems] of Object.entries(bySubject)) {
      console.log(`  Subject: ${subj} (${subjItems.length} items)`);
      for (const it of subjItems) {
        const authorStr = Array.isArray(it.author) ? it.author.join(', ') : (it.author || 'No author');
        console.log(`    - ID: ${it.id}`);
        console.log(`      Title: "${it.title}"`);
        if (it.titleEn) console.log(`      TitleEn: "${it.titleEn}"`);
        console.log(`      Author: ${authorStr} | Category: ${it.category || 'N/A'}`);
        console.log(`      URL: ${it.url}`);
      }
    }
  }

  // Also inspect existing playlists that have 0 or 1 track, or can be improved
  console.log('\n=============================================');
  console.log('EXISTING PLAYLISTS SUMMARY:');
  console.log('=============================================');
  for (const pl of playlists) {
    const trackCount = Array.isArray(pl.videos) ? pl.videos.length : 0;
    const isSingleVideoUrl = !pl.url?.includes('list=');
    console.log(`[${pl.moduleId || 'no-mod'}] ${pl.id} ("${pl.title}"): ${trackCount} tracks | URL: ${pl.url} | HasListParam: ${!isSingleVideoUrl}`);
  }
}

main().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
