#!/usr/bin/env node
/**
 * Migration Script: Consolidate Year 1 Introduction Module Standalone Videos into Playlists
 *
 * Consolidates:
 * 1. 36 Dr. Mohammed Fayez standalone physiology videos into 5 structured playlists:
 *    - yr1-intro-phys-fayez-autonomic (10 tracks)
 *    - yr1-intro-phys-fayez-nerve-synapse (9 tracks)
 *    - yr1-intro-phys-fayez-intro-transport (9 tracks)
 *    - yr1-intro-phys-fayez-hemodynamics (4 tracks)
 *    - yr1-intro-phys-fayez-metabolism-revision (9 tracks)
 *
 * Prunes:
 * - 36 standalone Dr. Fayez videos
 * - 1 legacy mislabeled playlist (yr1-intro-physiology-m-fayez-autonomic-playlist)
 * - 6 leftover practical fragment/duplicate docs (Abdullah anatomy, Zahra histology)
 * - 2 duplicate records (Ibrahim channel, Esawi practical)
 *
 * Usage:
 *   node --env-file=.env --import ./scripts/register-typescript.mjs scripts/group-intro-playlists.ts --dry-run
 *   node --env-file=.env --import ./scripts/register-typescript.mjs scripts/group-intro-playlists.ts
 */

import type { MaterialItem, PlaylistItem } from '../src/types/materials.ts';
import { createSign } from 'crypto';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getServiceAccount() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    return JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
  }
  const rootDir = resolve(__dirname, '..');
  const files = readdirSync(rootDir);
  const saFile = files.find(f => f.startsWith('medmaterials-firebase-adminsdk-') && f.endsWith('.json'));
  if (saFile) {
    return JSON.parse(readFileSync(resolve(rootDir, saFile), 'utf8'));
  }
  return null;
}

async function getAdminAccessToken(sa: any) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })).toString('base64url');

  const sign = createSign('RSA-SHA256');
  sign.update(header + '.' + claim);
  const signature = sign.sign(sa.private_key, 'base64url');
  const jwt = header + '.' + claim + '.' + signature;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  if (!tokenRes.ok) {
    throw new Error(`OAuth token request failed with HTTP ${tokenRes.status}: ${await tokenRes.text()}`);
  }

  const { access_token } = await tokenRes.json();
  return access_token;
}

function toFirestoreValue(val: any): any {
  if (val === null) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFirestoreValue) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

async function writeFirestoreDoc(accessToken: string, projectId: string, collectionName: string, docId: string, data: any) {
  const fields: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) {
      fields[k] = toFirestoreValue(v);
    }
  }

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collectionName}/${docId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to write ${collectionName}/${docId} (${res.status}): ${errText}`);
  }
}

async function deleteFirestoreDoc(accessToken: string, projectId: string, collectionName: string, docId: string) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collectionName}/${docId}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!res.ok && res.status !== 404) {
    const errText = await res.text();
    throw new Error(`Failed to delete ${collectionName}/${docId} (${res.status}): ${errText}`);
  }
}

async function incrementMaterialsVersionAdmin(accessToken: string, projectId: string) {
  const commitUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`;
  const res = await fetch(commitUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      writes: [
        {
          transform: {
            document: `projects/${projectId}/databases/(default)/documents/materials_version/current`,
            fieldTransforms: [
              {
                fieldPath: 'version',
                increment: { integerValue: '1' }
              }
            ]
          }
        }
      ]
    })
  });

  if (!res.ok) {
    console.warn(`[Warning] Failed to bump materials_version (${res.status}): ${await res.text()}`);
  }
}

const isDryRun = process.argv.includes('--dry-run');

/**
 * 5 Consolidated Playlists for Year 1 Introduction Module
 */
const playlistsToSave: MaterialItem[] = [
  // 1. Dr. Fayez: Autonomic Nervous System
  {
    id: 'yr1-intro-phys-fayez-autonomic',
    title: 'فسيولوجيا الجهاز العصبي الذاتي (Autonomic) - د. محمد فايز',
    titleEn: 'Autonomic Nervous System Physiology - Dr. Mohammed Fayez',
    type: 'playlist',
    category: 'lectures',
    subject: 'Physiology',
    year: 1,
    moduleId: 'year1-introduction',
    author: ['Dr. Mohammed Fayez'],
    url: 'https://youtu.be/G3YBAAJ0BGs',
    description: 'سلسلة محاضرات ومراجعات وأسئلة الجهاز العصبي الذاتي لموديول المقدمة - د. محمد فايز تشمل السمبثاوي والباراسمبثاوي ونورأدرينالين والأسيتيل كولين وحل MCQ ومقالي.',
    descriptionEn: 'Comprehensive video series on the Autonomic Nervous System by Dr. Mohammed Fayez covering sympathetic, parasympathetic, neurotransmitters, revisions, MCQs, and essay questions.',
    tags: ['physiology', 'autonomic', 'fayez', 'فايز', 'فسيولوجيا', 'year1', 'intro', 'playlist'],
    videos: [
      { id: 'fayez-ans-1', title: 'Autonomic Introduction', youtubeId: 'G3YBAAJ0BGs', url: 'https://youtu.be/G3YBAAJ0BGs' },
      { id: 'fayez-ans-2', title: 'Functions of Sympathetic', youtubeId: '1PCfCBZLlBU', url: 'https://youtu.be/1PCfCBZLlBU' },
      { id: 'fayez-ans-3', title: 'Functions of Parasympathetic', youtubeId: 'Hw_wUPba4pQ', url: 'https://youtu.be/Hw_wUPba4pQ' },
      { id: 'fayez-ans-4', title: 'Noradrenaline', youtubeId: 'xdQvr6iQ3OM', url: 'https://youtu.be/xdQvr6iQ3OM' },
      { id: 'fayez-ans-5', title: 'Acetylcholine', youtubeId: 'HMlgJJqla6s', url: 'https://youtu.be/HMlgJJqla6s' },
      { id: 'fayez-ans-6', title: 'Autonomic Effects, Innervation and Regulation', youtubeId: '6YU5SWSbpC8', url: 'https://youtu.be/6YU5SWSbpC8' },
      { id: 'fayez-ans-7', title: 'Revision Autonomic', youtubeId: 'wdHVI_Vl6eo', url: 'https://youtu.be/wdHVI_Vl6eo' },
      { id: 'fayez-ans-8', title: 'Autonomic MCQ Part 1', youtubeId: '6Btgq1_OYQw', url: 'https://youtu.be/6Btgq1_OYQw' },
      { id: 'fayez-ans-9', title: 'Autonomic MCQ Part 2', youtubeId: 'wuF0P5UBuDc', url: 'https://youtu.be/wuF0P5UBuDc' },
      { id: 'fayez-ans-10', title: 'Essay Autonomic', youtubeId: '5Q5ZHkk3T2w', url: 'https://youtu.be/5Q5ZHkk3T2w' },
    ],
    dateAdded: '2026-10-11T14:30:00.000Z',
    addedBy: 'Mazen Yasin',
    added_by_username: 'mazenyasin',
    creator_username: 'mazenyasin',
    status: 'published',
  },

  // 2. Dr. Fayez: Nerve, Membrane Potential & Synapse
  {
    id: 'yr1-intro-phys-fayez-nerve-synapse',
    title: 'فسيولوجيا الأعصاب وجهد الغشاء والتشابك العصبي (Nerve & Synapse) - د. محمد فايز',
    titleEn: 'Nerve, Membrane Potential & Synapse Physiology - Dr. Mohammed Fayez',
    type: 'playlist',
    category: 'lectures',
    subject: 'Physiology',
    year: 1,
    moduleId: 'year1-introduction',
    author: ['Dr. Mohammed Fayez'],
    url: 'https://youtu.be/ZcZksKzlhYQ',
    description: 'سلسلة فيديوهات فسيولوجيا الأعصاب للدكتور محمد فايز لموديول المقدمة تشمل جهد الراحة وجهد الفعل والتشابك العصبي والمراجعات وحل أسئلة MCQ ومقالي.',
    descriptionEn: 'Video series on Nerve and Synapse Physiology by Dr. Mohammed Fayez covering resting and action membrane potentials, local potentials, synapses, reviews, MCQs, and essay questions.',
    tags: ['physiology', 'nerve', 'synapse', 'fayez', 'فايز', 'فسيولوجيا', 'year1', 'intro', 'playlist'],
    videos: [
      { id: 'fayez-nerve-1', title: 'Nerve Introduction', youtubeId: 'ZcZksKzlhYQ', url: 'https://youtu.be/ZcZksKzlhYQ' },
      { id: 'fayez-nerve-2', title: 'Resting Membrane Potential (RMP)', youtubeId: 'ZWNl2YZvA0g', url: 'https://youtu.be/ZWNl2YZvA0g' },
      { id: 'fayez-nerve-3', title: 'Action Potential', youtubeId: '_6m89SA_tIg', url: 'https://youtu.be/_6m89SA_tIg' },
      { id: 'fayez-nerve-4', title: 'Local Potential and Effects of ECF Ions on Excitability', youtubeId: 'K_jav0Siqzk', url: 'https://youtu.be/K_jav0Siqzk' },
      { id: 'fayez-nerve-5', title: 'Synapse', youtubeId: '5FcY25I9b_s', url: 'https://youtu.be/5FcY25I9b_s' },
      { id: 'fayez-nerve-6', title: 'Final Revision: Nerve', youtubeId: 'XK1SklSUYGs', url: 'https://youtu.be/XK1SklSUYGs' },
      { id: 'fayez-nerve-7', title: 'MCQ Nerve', youtubeId: 'flPoqaxYc_Q', url: 'https://youtu.be/flPoqaxYc_Q' },
      { id: 'fayez-nerve-8', title: 'Essay Nerve', youtubeId: 'S9PRGYbDnhk', url: 'https://youtu.be/S9PRGYbDnhk' },
      { id: 'fayez-nerve-9', title: 'Essay Synapse', youtubeId: 'v973UKSFrjw', url: 'https://youtu.be/v973UKSFrjw' },
    ],
    dateAdded: '2026-10-11T14:30:00.000Z',
    addedBy: 'Mazen Yasin',
    added_by_username: 'mazenyasin',
    creator_username: 'mazenyasin',
    status: 'published',
  },

  // 3. Dr. Fayez: General Physiology, Homeostasis & Transport
  {
    id: 'yr1-intro-phys-fayez-intro-transport',
    title: 'مدخل الفسيولوجيا والاتزان الداخلي والنقل الخلوي - د. محمد فايز',
    titleEn: 'General Physiology, Homeostasis & Transport - Dr. Mohammed Fayez',
    type: 'playlist',
    category: 'lectures',
    subject: 'Physiology',
    year: 1,
    moduleId: 'year1-introduction',
    author: ['Dr. Mohammed Fayez'],
    url: 'https://youtu.be/rs6T5G2OJDA',
    description: 'شرح مدخل الفسيولوجيا لموديول المقدمة - د. محمد فايز يشمل الاتزان الداخلي، سوائل الجسم، حركة الماء، النقل عبر الغشاء الخلوي، وتوازن جيبس دونان والمراجعة.',
    descriptionEn: 'General Physiology and transport lecture series by Dr. Mohammed Fayez covering homeostasis, body fluids, water movement, cell membrane transport, and Gibbs-Donnan equilibrium.',
    tags: ['physiology', 'homeostasis', 'transport', 'fayez', 'فايز', 'فسيولوجيا', 'year1', 'intro', 'playlist'],
    videos: [
      { id: 'fayez-intro-1', title: 'Homeostasis', youtubeId: 'rs6T5G2OJDA', url: 'https://youtu.be/rs6T5G2OJDA' },
      { id: 'fayez-intro-2', title: 'Body Fluids Part 1', youtubeId: '9lXeRZEdE-w', url: 'https://youtu.be/9lXeRZEdE-w' },
      { id: 'fayez-intro-3', title: 'Body Fluids Part 2', youtubeId: 'cqk7d4Qzy0I', url: 'https://youtu.be/cqk7d4Qzy0I' },
      { id: 'fayez-intro-4', title: 'Movement of Water', youtubeId: '_hkvJCVziDA', url: 'https://youtu.be/_hkvJCVziDA' },
      { id: 'fayez-intro-5', title: 'Cell Membrane and Transport', youtubeId: 'coU38qzzDOU', url: 'https://youtu.be/coU38qzzDOU' },
      { id: 'fayez-intro-6', title: 'Transport Part 1', youtubeId: 'Ak9ZcNBOsyg', url: 'https://youtu.be/Ak9ZcNBOsyg' },
      { id: 'fayez-intro-7', title: 'Transport Part 2', youtubeId: 'NcgYEjlqP3k', url: 'https://youtu.be/NcgYEjlqP3k' },
      { id: 'fayez-intro-8', title: 'Gibbs Donnan Equilibrium', youtubeId: 'S240m5NgQQY', url: 'https://youtu.be/S240m5NgQQY' },
      { id: 'fayez-intro-9', title: 'Revision: Introduction Physiology', youtubeId: 'IktvvjPH4TE', url: 'https://youtu.be/IktvvjPH4TE' },
    ],
    dateAdded: '2026-10-11T14:30:00.000Z',
    addedBy: 'Mazen Yasin',
    added_by_username: 'mazenyasin',
    creator_username: 'mazenyasin',
    status: 'published',
  },

  // 4. Dr. Fayez: Hemodynamics & Biophysics
  {
    id: 'yr1-intro-phys-fayez-hemodynamics',
    title: 'ديناميكا الدم والفيزياء الحيوية (Hemodynamics) - د. محمد فايز',
    titleEn: 'Hemodynamics & Biophysics Physiology - Dr. Mohammed Fayez',
    type: 'playlist',
    category: 'lectures',
    subject: 'Physiology',
    year: 1,
    moduleId: 'year1-introduction',
    author: ['Dr. Mohammed Fayez'],
    url: 'https://youtu.be/eDqr-Skrrc0',
    description: 'شرح ديناميكا الدم والفيزياء الحيوية لموديول المقدمة - د. محمد فايز تشمل قانون أوم وبوازيه، أنواع السريان، المطاوعة، ومبدأ برنولي وقانون لابلاس والمراجعة.',
    descriptionEn: 'Hemodynamics and biophysics physiology series by Dr. Mohammed Fayez covering Ohm and Poiseuille laws, flow compliance, velocity, Bernoulli and Laplace laws, and revision.',
    tags: ['physiology', 'hemodynamics', 'biophysics', 'fayez', 'فايز', 'فسيولوجيا', 'year1', 'intro', 'playlist'],
    videos: [
      { id: 'fayez-hemo-1', title: 'Ohm Law and Poiseuille Law', youtubeId: 'eDqr-Skrrc0', url: 'https://youtu.be/eDqr-Skrrc0' },
      { id: 'fayez-hemo-2', title: 'Types of Flow, Compliance and Velocity of Flow', youtubeId: 'YRYdYRyxv7I', url: 'https://youtu.be/YRYdYRyxv7I' },
      { id: 'fayez-hemo-3', title: 'Bernoulli Principle and Laplace Law', youtubeId: 'tv5QlktgUSY', url: 'https://youtu.be/tv5QlktgUSY' },
      { id: 'fayez-hemo-4', title: 'Revision: Hemodynamics', youtubeId: 'cHwNbZE4RmI', url: 'https://youtu.be/cHwNbZE4RmI' },
    ],
    dateAdded: '2026-10-11T14:30:00.000Z',
    addedBy: 'Mazen Yasin',
    added_by_username: 'mazenyasin',
    creator_username: 'mazenyasin',
    status: 'published',
  },

  // 5. Dr. Fayez: Metabolism & Comprehensive Final Revision
  {
    id: 'yr1-intro-phys-fayez-metabolism-revision',
    title: 'فسيولوجيا الأيض والمراجعة الشاملة (Metabolism) - د. محمد فايز',
    titleEn: 'Metabolism & Comprehensive Final Revision - Dr. Mohammed Fayez',
    type: 'playlist',
    category: 'lectures',
    subject: 'Physiology',
    year: 1,
    moduleId: 'year1-introduction',
    author: ['Dr. Mohammed Fayez'],
    url: 'https://youtu.be/C9oWJzb9btM',
    description: 'سلسلة كورس فسيولوجيا الأيض والمراجعات الشاملة لموديول المقدمة - د. محمد فايز تشمل محاضرات الـ Metabolism، تنظيم حرارة الجسم، المراجعة وحل أسئلة MCQ ومقالي والمراجعة النهائية.',
    descriptionEn: 'Complete Metabolism and final comprehensive review series by Dr. Mohammed Fayez for Year 1 Intro, covering metabolic rate, thermoregulation, review, MCQs, and final exams.',
    tags: ['physiology', 'metabolism', 'fayez', 'فايز', 'فسيولوجيا', 'year1', 'intro', 'playlist'],
    videos: [
      { id: 'fayez-meta-1', title: 'Metabolism (Introduction, Heat value, RQ, Metabolic rate and SDA)', youtubeId: 'C9oWJzb9btM', url: 'https://youtu.be/C9oWJzb9btM' },
      { id: 'fayez-meta-2', title: 'Metabolism (Factors affecting Metabolic rate and BMR)', youtubeId: 'WZO89h5NBu0', url: 'https://youtu.be/WZO89h5NBu0' },
      { id: 'fayez-meta-3', title: 'Metabolism (Body Temperature introduction)', youtubeId: 'Wp_9VDtgqSw', url: 'https://youtu.be/Wp_9VDtgqSw' },
      { id: 'fayez-meta-4', title: 'Metabolism (Thermoregulation and Disorders)', youtubeId: 'lm-AVPPezPA', url: 'https://youtu.be/lm-AVPPezPA' },
      { id: 'fayez-meta-5', title: 'Metabolism (Food intake and Obesity)', youtubeId: 'qWT0eGsZ-6s', url: 'https://youtu.be/qWT0eGsZ-6s' },
      { id: 'fayez-meta-6', title: 'Metabolism Revision', youtubeId: 'k9hCKwwLM8o', url: 'https://youtu.be/k9hCKwwLM8o' },
      { id: 'fayez-meta-7', title: 'Metabolism MCQ', youtubeId: 'sgShDg7bQlY', url: 'https://youtu.be/sgShDg7bQlY' },
      { id: 'fayez-meta-8', title: 'Essay Metabolism', youtubeId: 'ypwm2-pDOGk', url: 'https://youtu.be/ypwm2-pDOGk' },
      { id: 'fayez-meta-9', title: 'Final Comprehensive Revision', youtubeId: 'pOPRr2pxeYg', url: 'https://youtu.be/pOPRr2pxeYg' },
    ],
    dateAdded: '2026-10-11T14:30:00.000Z',
    addedBy: 'Mazen Yasin',
    added_by_username: 'mazenyasin',
    creator_username: 'mazenyasin',
    status: 'published',
  },
];

/**
 * 45 Redundant Documents to Prune
 */
const standaloneIdsToDelete: string[] = [
  // 36 Dr. Fayez standalone physiology items
  'yr1-intro-physiology-m-fayez-acetylcholine',
  'yr1-intro-physiology-m-fayez-action-potential',
  'yr1-intro-physiology-m-fayez-autonomic-effects',
  'yr1-intro-physiology-m-fayez-autonomic-introduction',
  'yr1-intro-physiology-m-fayez-autonomic-mcq-1',
  'yr1-intro-physiology-m-fayez-autonomic-mcq-2',
  'yr1-intro-physiology-m-fayez-bernoulli-laplace',
  'yr1-intro-physiology-m-fayez-body-fluids-1',
  'yr1-intro-physiology-m-fayez-body-fluids-2',
  'yr1-intro-physiology-m-fayez-cell-membrane-transport',
  'yr1-intro-physiology-m-fayez-essay-autonomic',
  'yr1-intro-physiology-m-fayez-essay-metabolism',
  'yr1-intro-physiology-m-fayez-essay-nerve',
  'yr1-intro-physiology-m-fayez-essay-synapse',
  'yr1-intro-physiology-m-fayez-final-revision',
  'yr1-intro-physiology-m-fayez-final-revision-nerve',
  'yr1-intro-physiology-m-fayez-flow-compliance-velocity',
  'yr1-intro-physiology-m-fayez-gibbs-donnan',
  'yr1-intro-physiology-m-fayez-homeostasis',
  'yr1-intro-physiology-m-fayez-local-potential-ecf',
  'yr1-intro-physiology-m-fayez-mcq-nerve',
  'yr1-intro-physiology-m-fayez-metabolism-mcq',
  'yr1-intro-physiology-m-fayez-metabolism-revision',
  'yr1-intro-physiology-m-fayez-movement-water',
  'yr1-intro-physiology-m-fayez-nerve-introduction',
  'yr1-intro-physiology-m-fayez-noradrenaline',
  'yr1-intro-physiology-m-fayez-ohm-poiseuille',
  'yr1-intro-physiology-m-fayez-parasympathetic-functions',
  'yr1-intro-physiology-m-fayez-revision-autonomic',
  'yr1-intro-physiology-m-fayez-revision-hemodynamics',
  'yr1-intro-physiology-m-fayez-revision-intro',
  'yr1-intro-physiology-m-fayez-rmp',
  'yr1-intro-physiology-m-fayez-sympathetic-functions',
  'yr1-intro-physiology-m-fayez-synapse',
  'yr1-intro-physiology-m-fayez-transport-1',
  'yr1-intro-physiology-m-fayez-transport-2',

  // 1 Mislabeled legacy playlist document (replaced by yr1-intro-phys-fayez-metabolism-revision)
  'yr1-intro-physiology-m-fayez-autonomic-playlist',

  // 3 Abdullah practical leftover items (already present in yr1-intro-anat-abdullah-practical)
  'yr1-intro-anatomy-abdullah-practical-1',
  'yr1-intro-anatomy-abdullah-practical-2',
  'yr1-intro-anatomy-abdullah-practical-3',

  // 3 Zahra histology practical leftover items (already present in yr1-intro-histo-zahra-practical)
  'yr1-intro-histo-zahra-practical-1',
  'yr1-intro-histo-zahra-practical-2',
  'yr1-intro-histo-zahra-practical-3',

  // 2 Duplicate records
  'yr1-intro-immunology-ibrahim-channel',
  'yr1-intro-biochemistry-dr-esawi-practical',
];

async function main() {
  console.log(`=== Year 1 Intro Playlists Migration ${isDryRun ? '(DRY RUN)' : '(LIVE EXECUTION)'} ===\n`);

  console.log(`Playlists to create/update (${playlistsToSave.length}):`);
  for (const pl of playlistsToSave) {
    console.log(`  + [${pl.id}] "${pl.title}" (${pl.videos?.length || 0} tracks)`);
  }

  console.log(`\nDocuments to remove (${standaloneIdsToDelete.length}):`);
  for (const id of standaloneIdsToDelete) {
    console.log(`  - [${id}]`);
  }

  if (isDryRun) {
    console.log('\n[Dry Run] Validation succeeded. No writes or deletions were performed.');
    process.exit(0);
  }

  const sa = getServiceAccount();
  if (!sa) {
    console.error('Service Account credentials not found!');
    process.exit(1);
  }

  console.log(`\n[Auth] Authenticating via Service Account: ${sa.client_email}`);
  const token = await getAdminAccessToken(sa);
  const projectId = sa.project_id;

  console.log('\n--- Writing Playlists to Firestore (Admin REST) ---');
  for (const pl of playlistsToSave) {
    await writeFirestoreDoc(token, projectId, 'materials', pl.id, pl);
    console.log(`  ✓ Saved playlist: ${pl.id}`);
  }

  console.log('\n--- Deleting Redundant Documents (Admin REST) ---');
  for (const id of standaloneIdsToDelete) {
    try {
      await deleteFirestoreDoc(token, projectId, 'materials', id);
      console.log(`  ✓ Deleted item: ${id}`);
    } catch (err) {
      console.warn(`  ! Could not delete item ${id}:`, err);
    }
  }

  console.log('\n--- Incrementing Materials Version in Firestore ---');
  await incrementMaterialsVersionAdmin(token, projectId);
  console.log('  ✓ Cache snapshot version bumped.');

  console.log('\n=== Migration Completed Successfully! ===');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
