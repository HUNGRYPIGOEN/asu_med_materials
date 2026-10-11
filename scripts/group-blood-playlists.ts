import {
  saveMaterialToFirestore,
  getFirestoreDb,
  incrementMaterialsVersionInFirestore
} from '../src/firebase/firestore.ts';
import { doc, deleteDoc } from 'firebase/firestore';
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
 * 6 Consolidated Playlists for Year 2 Blood Module
 */
const playlistsToSave: MaterialItem[] = [
  // 1. Dr. Fayez Practical Physiology
  {
    id: 'bld-phys-fayez-prac',
    title: 'عملي فسيولوجيا الدم - د. محمد فايز',
    titleEn: 'Blood Physiology Practical - Dr. Mohammed Fayez',
    type: 'playlist',
    category: 'practical',
    subject: 'Physiology',
    year: 2,
    moduleId: 'year2-blood',
    author: ['Dr. Fayez'],
    url: 'https://youtu.be/P4iQoMD3z50',
    description: 'سلسلة فيديوهات تجارب عملي فسيولوجيا الدم لدكتور محمد فايز تشمل وقت النزف وفصائل الدم وسرعة الترسيب والهيماتوكريت وصاهلي.',
    descriptionEn: 'Complete practical blood physiology video series by Dr. Mohammed Fayez covering bleeding time, blood groups, ESR, hematocrit, and Sahli apparatus.',
    tags: ['physiology', 'practical', 'blood', 'fayez', 'فايز', 'عملي', 'فسيولوجيا', 'year2', 'playlist'],
    videos: [
      {
        id: 'fayez-prac-bleeding-time',
        title: 'عملي فسيولوجيا الدم - تجربة وقت النزف (Bleeding Time) - د. محمد فايز',
        youtubeId: 'P4iQoMD3z50',
        url: 'https://youtu.be/P4iQoMD3z50'
      },
      {
        id: 'fayez-prac-blood-groups',
        title: 'عملي فسيولوجيا الدم - تجربة تحديد فصائل الدم (Blood Groups) - د. محمد فايز',
        youtubeId: 'vdENN7KLTp4',
        url: 'https://youtu.be/vdENN7KLTp4'
      },
      {
        id: 'fayez-prac-esr',
        title: 'عملي فسيولوجيا الدم - تجربة سرعة الترسيب (ESR) - د. محمد فايز',
        youtubeId: 'SWQaiaUHTLQ',
        url: 'https://youtu.be/SWQaiaUHTLQ'
      },
      {
        id: 'fayez-prac-hematocrit',
        title: 'عملي فسيولوجيا الدم - تجربة قياس الهيماتوكريت (Hematocrit) - د. محمد فايز',
        youtubeId: '_ji41E2kOrs',
        url: 'https://youtu.be/_ji41E2kOrs'
      },
      {
        id: 'fayez-prac-sahli',
        title: 'عملي فسيولوجيا الدم - تجربة جهاز صاهلي (Sahli apparatus) - د. محمد فايز',
        youtubeId: '71p3lSi_6ss',
        url: 'https://youtu.be/71p3lSi_6ss'
      }
    ],
    addedBy: 'Mohammed Wael',
    added_by_username: 'mohammed_wael',
    createdAt: new Date().toISOString()
  },

  // 2. Dr. Hegazy Histology Practical
  {
    id: 'bld-histo-hegazy-prac',
    title: 'عملي هستولوجي الدم (Computer Lab & Real Lab) - د. حجازي',
    titleEn: 'Blood Histology Practical (Computer Lab & Real Lab) - Dr. Hegazy',
    type: 'playlist',
    category: 'practical',
    subject: 'Histology',
    year: 2,
    moduleId: 'year2-blood',
    author: ['Dr. Hegazy'],
    url: 'https://youtu.be/eQkMptBfq6k',
    description: 'فيديوهات عملي هستولوجي موديول الدم لدكتور حجازي تشمل معمل الكمبيوتر والمعمل الحقيقي.',
    descriptionEn: 'Blood histology practical videos by Dr. Hegazy including Computer Lab and Real Lab.',
    tags: ['histology', 'practical', 'blood', 'hegazy', 'حجازي', 'عملي', 'هستولوجي', 'year2', 'playlist'],
    videos: [
      {
        id: 'hegazy-histo-complab',
        title: 'عملي هستولوجي الدم - Computer Lab - د. حجازي',
        youtubeId: 'eQkMptBfq6k',
        url: 'https://youtu.be/eQkMptBfq6k'
      },
      {
        id: 'hegazy-histo-reallab',
        title: 'عملي هستولوجي الدم - Real Lab - د. حجازي',
        youtubeId: 'N3AOjJ7Wsns',
        url: 'https://youtu.be/N3AOjJ7Wsns'
      }
    ],
    addedBy: 'Mohammed Wael',
    added_by_username: 'mohammed_wael',
    createdAt: new Date().toISOString()
  },

  // 3. Dr. Hegazy Pathology Practical
  {
    id: 'bld-patho-hegazy-prac',
    title: 'عملي باثولوجي الدم (جارات وسلايدات) - د. حجازي',
    titleEn: 'Blood Pathology Practical (Jars & Slides) - Dr. Hegazy',
    type: 'playlist',
    category: 'practical',
    subject: 'Pathology',
    year: 2,
    moduleId: 'year2-blood',
    author: ['Dr. Hegazy'],
    url: 'https://youtu.be/VR9ZK9gKzZ0',
    description: 'فيديوهات عملي باثولوجي موديول الدم لدكتور حجازي تشمل الجارات والسلايدات.',
    descriptionEn: 'Blood pathology practical videos by Dr. Hegazy covering pathology jars and microscopic slides.',
    tags: ['pathology', 'practical', 'jars', 'slides', 'باثولوجي', 'عملي', 'حجازي', 'blood', 'year2', 'playlist'],
    videos: [
      {
        id: 'hegazy-patho-jars',
        title: 'عملي باثولوجي الدم - الجارات (Jars) - د. حجازي',
        youtubeId: 'VR9ZK9gKzZ0',
        url: 'https://youtu.be/VR9ZK9gKzZ0'
      },
      {
        id: 'hegazy-patho-slides',
        title: 'عملي باثولوجي الدم - السلايدات (Slides) - د. حجازي',
        youtubeId: 'HKqyIV4RAjg',
        url: 'https://youtu.be/HKqyIV4RAjg'
      }
    ],
    addedBy: 'Mohammed Wael',
    added_by_username: 'mohammed_wael',
    createdAt: new Date().toISOString()
  },

  // 4. Dr. Karim Emad Microbiology Practical & Questions
  {
    id: 'bld-micro-kareem-prac',
    title: 'عملي وحالات وأسئلة ميكروبيولوجي الدم - د. كريم عماد',
    titleEn: 'Blood Microbiology Practical, Cases & MCQs - Dr. Karim Emad',
    type: 'playlist',
    category: 'practical',
    subject: 'Microbiology',
    year: 2,
    moduleId: 'year2-blood',
    author: ['Dr. Karim Emad'],
    url: 'https://youtu.be/-JlEVOraEW4',
    description: 'سلسلة فيديوهات عملي ميكروبيولوجي موديول الدم تشمل العملي والحالات وأسئلة الـ MCQ لدكتور كريم عماد.',
    descriptionEn: 'Blood microbiology practical series by Dr. Karim Emad covering lab practical, clinical cases, and MCQ questions.',
    tags: ['microbiology', 'practical', 'cases', 'mcq', 'عملي', 'ميكروبيولوجي', 'كريم عماد', 'blood', 'year2', 'playlist'],
    videos: [
      {
        id: 'kareem-micro-prac-lab',
        title: 'عملي ميكروبيولوجي الدم - د. كريم عماد',
        youtubeId: '-JlEVOraEW4',
        url: 'https://youtu.be/-JlEVOraEW4'
      },
      {
        id: 'kareem-micro-prac-cases',
        title: 'عملي ميكروبيولوجي الدم والحالات (Practical + Cases) - د. كريم عماد',
        youtubeId: 'nWRR88Z4deU',
        url: 'https://youtu.be/nWRR88Z4deU'
      },
      {
        id: 'kareem-micro-prac-mcq',
        title: 'أسئلة MCQ عملي ميكروبيولوجي الدم - د. كريم عماد',
        youtubeId: 'rYWGbwxViqw',
        url: 'https://youtu.be/rYWGbwxViqw'
      }
    ],
    addedBy: 'Mohammed Wael',
    added_by_username: 'mohammed_wael',
    createdAt: new Date().toISOString()
  },

  // 5. Dr. Mohammed Ashraf Microbiology Practical
  {
    id: 'bld-micro-ashraf-prac',
    title: 'عملي ميكروبيولوجي الدم - د. محمد أشرف',
    titleEn: 'Blood Microbiology Practical - Dr. Mohammed Ashraf',
    type: 'playlist',
    category: 'practical',
    subject: 'Microbiology',
    year: 2,
    moduleId: 'year2-blood',
    author: ['Dr. Mohammed Ashraf'],
    url: 'https://youtu.be/EERb0wU67h0',
    description: 'فيديوهات شرح عملي ميكروبيولوجي موديول الدم لدكتور محمد أشرف.',
    descriptionEn: 'Blood microbiology practical videos by Dr. Mohammed Ashraf.',
    tags: ['microbiology', 'practical', 'عملي', 'ميكروبيولوجي', 'محمد أشرف', 'blood', 'year2', 'playlist'],
    videos: [
      {
        id: 'ashraf-micro-prac-1',
        title: 'عملي ميكروبيولوجي الدم - د. محمد أشرف',
        youtubeId: 'EERb0wU67h0',
        url: 'https://youtu.be/EERb0wU67h0'
      },
      {
        id: 'ashraf-micro-prac-2',
        title: 'عملي ميكروبيولوجي موديول الدم (Microbiology Practical 2024) - د. محمد أشرف',
        youtubeId: '4g7dnEusy1U',
        url: 'https://youtu.be/4g7dnEusy1U'
      }
    ],
    addedBy: 'Mohammed Wael',
    added_by_username: 'mohammed_wael',
    createdAt: new Date().toISOString()
  },

  // 6. Dr. Eslam El-Radad Pathology Revision & Exam Questions
  {
    id: 'bld-patho-elradad-revision-questions',
    title: 'مراجعة وحل أسئلة باثولوجي الدم - د. إسلام الرداد',
    titleEn: 'Blood Pathology Revision & Questions - Dr. Eslam El-Radad',
    type: 'playlist',
    category: 'summaries',
    subject: 'Pathology',
    year: 2,
    moduleId: 'year2-blood',
    author: ['Dr. Eslam El-Radad'],
    url: 'https://youtu.be/fvRl-8E5tVk',
    description: 'فيديوهات مراجعة الباثولوجي وحل الأسئلة كاملاً لدكتور إسلام الرداد.',
    descriptionEn: 'Blood pathology revision and questions solving videos by Dr. Eslam El-Radad.',
    tags: ['Pathology', 'باثولوجي', 'مراجعة', 'حل أسئلة', 'إسلام الرداد', 'blood', 'year2', 'playlist'],
    videos: [
      {
        id: 'elradad-patho-revision',
        title: 'فيديو مراجعة باثولوجي - د. إسلام الرداد',
        youtubeId: 'fvRl-8E5tVk',
        url: 'https://youtu.be/fvRl-8E5tVk'
      },
      {
        id: 'elradad-patho-questions',
        title: 'فيديو حل أسئلة باثولوجي - د. إسلام الرداد',
        youtubeId: '079Rzqzc0-0',
        url: 'https://youtu.be/079Rzqzc0-0'
      }
    ],
    addedBy: 'Mohammed Wael',
    added_by_username: 'mohammed_wael',
    createdAt: new Date().toISOString()
  }
];

/**
 * Redundant standalone IDs to be deleted from Firestore
 */
const standaloneIdsToDelete: string[] = [
  // Dr. Fayez individual practicals
  'bld-phys-fayez-prac-bleeding-time',
  'bld-phys-fayez-prac-blood-groups',
  'bld-phys-fayez-prac-esr',
  'bld-phys-fayez-prac-hematocrit',
  'bld-phys-fayez-prac-sahli',

  // Dr. Hegazy histology practicals
  'bld-histo-hegazy-prac-complab',
  'bld-histo-hegazy-prac-reallab',

  // Dr. Hegazy pathology practicals
  'bld-patho-hegazy-prac-jars',
  'bld-patho-hegazy-prac-slides',

  // Dr. Karim Emad extra individual practicals (bld-micro-kareem-prac is overwritten by playlist)
  'bld-micro-kareem-prac-cases',
  'bld-micro-kareem-prac-mcq',

  // Dr. Mohammed Ashraf extra individual practical (bld-micro-ashraf-prac is overwritten by playlist)
  'bld-micro-ashraf-prac-2024',

  // Dr. Eslam El-Radad revision & question videos
  'mat_1790768207606_q53r',
  'mat_1790768207606_wkhx'
];

async function main() {
  console.log(`=== Blood Module Playlists Migration ${isDryRun ? '(DRY RUN)' : '(LIVE EXECUTION)'} ===\n`);

  console.log(`Playlists to create/update (${playlistsToSave.length}):`);
  for (const pl of playlistsToSave) {
    console.log(`  + [${pl.id}] "${pl.title}" (${pl.videos?.length || 0} tracks)`);
  }

  console.log(`\nStandalone documents to remove (${standaloneIdsToDelete.length}):`);
  for (const id of standaloneIdsToDelete) {
    console.log(`  - [${id}]`);
  }

  if (isDryRun) {
    console.log('\n[Dry Run] Validation succeeded. No writes or deletions were performed.');
    process.exit(0);
  }

  const sa = getServiceAccount();
  if (sa) {
    console.log(`\n[Auth] Authenticating via Service Account: ${sa.client_email}`);
    const token = await getAdminAccessToken(sa);
    const projectId = sa.project_id;

    console.log('\n--- Writing Playlists to Firestore (Admin REST) ---');
    for (const pl of playlistsToSave) {
      await writeFirestoreDoc(token, projectId, 'materials', pl.id, pl);
      console.log(`  ✓ Saved playlist: ${pl.id}`);
    }

    console.log('\n--- Deleting Redundant Standalone Materials (Admin REST) ---');
    for (const id of standaloneIdsToDelete) {
      try {
        await deleteFirestoreDoc(token, projectId, 'materials', id);
        console.log(`  ✓ Deleted standalone item: ${id}`);
      } catch (err) {
        console.warn(`  ! Could not delete item ${id}:`, err);
      }
    }

    console.log('\n--- Incrementing Materials Version in Firestore ---');
    await incrementMaterialsVersionAdmin(token, projectId);
    console.log('  ✓ Cache snapshot version bumped.');
  } else {
    console.log('\n[Auth] No Service Account found, using Firebase Client SDK...');
    const db = getFirestoreDb();
    if (!db) {
      console.error('Firestore is not configured!');
      process.exit(1);
    }

    console.log('\n--- Writing Playlists to Firestore ---');
    for (const pl of playlistsToSave) {
      const success = await saveMaterialToFirestore(pl);
      if (!success) {
        console.error(`Failed to save playlist: ${pl.id}`);
        process.exit(1);
      }
      console.log(`  ✓ Saved playlist: ${pl.id}`);
    }

    console.log('\n--- Deleting Redundant Standalone Materials ---');
    for (const id of standaloneIdsToDelete) {
      try {
        await deleteDoc(doc(db, 'materials', id));
        console.log(`  ✓ Deleted standalone item: ${id}`);
      } catch (err) {
        console.warn(`  ! Could not delete item ${id}:`, err);
      }
    }

    console.log('\n--- Incrementing Materials Version in Firestore ---');
    await incrementMaterialsVersionInFirestore();
    console.log('  ✓ Cache snapshot version bumped.');
  }

  console.log('\n=== Migration Completed Successfully! ===');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
