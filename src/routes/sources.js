// src/routes/sources.js
// @version 1.4.0
// @date    2026-08-25
// @change  1.4.0 — POST /sources/url : enregistre une URL de profil public
//                  (LinkedIn ou Instagram) comme source de reference (metadata,
//                  pas de scraping). Types LINKEDIN_URL / INSTAGRAM_URL /
//                  URL a ajouter dans la contrainte CHECK (migration 007).
//          1.3.0 — Suffixage auto des noms de fichiers en doublon pour un meme
//                  user : "profile.pdf" -> "profile (2).pdf", "profile (3).pdf"...
//                  Message d'info renvoye au client si suffixe applique.
//          1.2.0 — GET /sources : retire la colonne embedding_calcule (non presente
//                  au schema 000). Retourne aussi contenu_present (bool) au lieu
//                  du contenu complet, et longueur_texte.
//          1.1.0 — Étage 1 : parser ZIP LinkedIn (CSV) + Instagram (JSON),
//                  détection automatique via detecterType(), limite 25 MB,
//                  est_reference=TRUE sur ZIP réseaux sociaux
//          1.0.0 — Version initiale BFF Bahyo (PDF/DOCX/TXT uniquement, 10 MB)
// ============================================================================
// Changements Étage 1 :
//   - ZIP ajouté aux formats acceptés (multer fileFilter + extractText)
//   - parseLinkedinZip() : lit Positions.csv, Education.csv, Skills.csv,
//     Profile.csv, Recommendations_Received.csv → corpus texte structuré
//   - parseInstagramZip() : lit personal_information.json, posts (optionnel)
//   - detecterType() reconnaît LINKEDIN_ZIP et INSTAGRAM_ZIP
//   - Limite de taille portée à MAX_FILE_SIZE_MB (défaut 25 MB) pour les ZIP
//
// Dépendance requise : npm install adm-zip
// ============================================================================
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import AdmZip from 'adm-zip';
import { query } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const dir = process.env.UPLOAD_DIR || './uploads';
    await fs.mkdir(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const ALLOWED_EXTS = ['.pdf', '.docx', '.doc', '.txt', '.json', '.zip'];

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 25) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTS.includes(ext)) cb(null, true);
    else cb(new Error(`Format non supporté. Formats acceptés : ${ALLOWED_EXTS.join(', ')}`));
  },
});

// ── CSV parser minimal (gère les champs entre guillemets) ─────────────────────
function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      // Guillemet double à l'intérieur d'un champ guillemété → guillemet littéral
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQ = !inQ; }
    } else if (c === ',' && !inQ) {
      result.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const vals = parseCsvLine(line);
      return Object.fromEntries(headers.map((h, i) => [h, (vals[i] || '').trim()]));
    });
}

// ── Parser ZIP LinkedIn ───────────────────────────────────────────────────────
// Structure attendue de l'export LinkedIn (Settings → Data Privacy → Get a copy) :
//   Profile.csv, Positions.csv, Education.csv, Skills.csv,
//   Recommendations_Received.csv, Certifications.csv, Languages.csv
//
// Produit un corpus texte structuré consommable par la chaîne d'extraction.
function parseLinkedinZip(filePath) {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();

  const readCsv = (fileName) => {
    const entry = entries.find(e =>
      path.basename(e.entryName).toLowerCase() === fileName.toLowerCase()
    );
    if (!entry) return [];
    try {
      return parseCsv(entry.getData().toString('utf-8'));
    } catch { return []; }
  };

  const profile     = readCsv('Profile.csv');
  const positions   = readCsv('Positions.csv');
  const education   = readCsv('Education.csv');
  const skills      = readCsv('Skills.csv');
  const recos       = readCsv('Recommendations_Received.csv');
  const certifs     = readCsv('Certifications.csv');
  const languages   = readCsv('Languages.csv');

  const lines = [];

  // ── Profil ────────────────────────────────────────────────
  if (profile[0]) {
    const p = profile[0];
    const name = [p['First Name'], p['Last Name']].filter(Boolean).join(' ');
    lines.push('## Profil');
    if (name)             lines.push(`Nom : ${name}`);
    if (p['Headline'])    lines.push(`Titre : ${p['Headline']}`);
    if (p['Industry'])    lines.push(`Secteur : ${p['Industry']}`);
    if (p['Geo Location'])lines.push(`Localisation : ${p['Geo Location']}`);
    if (p['Summary'])     lines.push(`\nRésumé :\n${p['Summary']}`);
    lines.push('');
  }

  // ── Expériences ───────────────────────────────────────────
  if (positions.length) {
    lines.push('## Expériences professionnelles');
    positions.forEach(pos => {
      const title   = pos['Title'] || pos['Titre'] || '';
      const company = pos['Company Name'] || pos['Entreprise'] || '';
      const start   = pos['Started On'] || pos['Début'] || '';
      const end     = pos['Finished On'] || pos['Fin'] || 'présent';
      const desc    = pos['Description'] || '';
      const loc     = pos['Location'] || pos['Lieu'] || '';

      lines.push(`### ${title}${company ? ` — ${company}` : ''}${loc ? ` (${loc})` : ''}`);
      if (start) lines.push(`Période : ${start} – ${end}`);
      if (desc)  lines.push(desc);
      lines.push('');
    });
  }

  // ── Formation ─────────────────────────────────────────────
  if (education.length) {
    lines.push('## Formation');
    education.forEach(edu => {
      const school = edu['School Name'] || edu['École'] || '';
      const degree = edu['Degree Name'] || edu['Diplôme'] || '';
      const field  = edu['Field Of Study'] || edu['Domaine'] || '';
      const start  = edu['Start Date'] || edu['Début'] || '';
      const end    = edu['End Date'] || edu['Fin'] || '';
      const desc   = edu['Description'] || '';

      lines.push(`### ${[degree, field].filter(Boolean).join(' en ')}${school ? ` — ${school}` : ''}`);
      if (start || end) lines.push(`Période : ${start}${end ? ` – ${end}` : ''}`);
      if (desc) lines.push(desc);
      lines.push('');
    });
  }

  // ── Compétences ───────────────────────────────────────────
  if (skills.length) {
    lines.push('## Compétences déclarées');
    const skillNames = skills
      .map(s => s['Name'] || s['Compétence'] || '')
      .filter(Boolean);
    lines.push(skillNames.join(', '));
    lines.push('');
  }

  // ── Certifications ────────────────────────────────────────
  if (certifs.length) {
    lines.push('## Certifications');
    certifs.forEach(c => {
      const name   = c['Name'] || c['Nom'] || '';
      const org    = c['Authority'] || c['Organisme'] || '';
      const date   = c['Started On'] || c['Date'] || '';
      const expiry = c['Finished On'] || '';
      if (name) lines.push(`- ${name}${org ? ` — ${org}` : ''}${date ? ` (${date}${expiry ? ` → ${expiry}` : ''})` : ''}`);
    });
    lines.push('');
  }

  // ── Langues ───────────────────────────────────────────────
  if (languages.length) {
    lines.push('## Langues');
    languages.forEach(l => {
      const name  = l['Name'] || l['Langue'] || '';
      const level = l['Proficiency'] || l['Niveau'] || '';
      if (name) lines.push(`- ${name}${level ? ` (${level})` : ''}`);
    });
    lines.push('');
  }

  // ── Recommandations reçues ────────────────────────────────
  if (recos.length) {
    lines.push('## Recommandations reçues');
    recos.forEach(r => {
      const from = [r['Recommender First Name'], r['Recommender Last Name']].filter(Boolean).join(' ');
      const text = r['Text'] || r['Texte'] || '';
      if (text) lines.push(`De ${from || 'un contact'} :\n${text}`);
      lines.push('');
    });
  }

  const corpus = lines.join('\n').trim();
  if (corpus.length < 100) {
    throw new Error('Archive LinkedIn vide ou structure non reconnue. Vérifiez que vous avez bien sélectionné les données Profil lors de l\'export.');
  }
  return corpus;
}

// ── Parser ZIP Instagram ──────────────────────────────────────────────────────
// Structure attendue de l'export Instagram (Paramètres → Votre activité → Télécharger vos informations) :
//   personal_information.json, professional_information.json
function parseInstagramZip(filePath) {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();

  const readJson = (fileName) => {
    const entry = entries.find(e =>
      path.basename(e.entryName).toLowerCase() === fileName.toLowerCase()
    );
    if (!entry) return null;
    try {
      return JSON.parse(entry.getData().toString('utf-8'));
    } catch { return null; }
  };

  const personal = readJson('personal_information.json');
  const pro      = readJson('professional_information.json');

  const lines = [];
  lines.push('## Profil Instagram');

  if (personal) {
    const pi = personal.profile_user?.[0]?.string_map_data;
    if (pi) {
      const name     = pi['Name']?.value || '';
      const username = pi['Username']?.value || '';
      const bio      = pi['Bio']?.value || '';
      if (name)     lines.push(`Nom : ${name}`);
      if (username) lines.push(`Compte : @${username}`);
      if (bio)      lines.push(`Bio : ${bio}`);
    }
  }

  if (pro) {
    const pp = pro.profile_business?.[0]?.string_map_data;
    if (pp) {
      const cat = pp['Category']?.value || '';
      if (cat) lines.push(`Catégorie professionnelle : ${cat}`);
    }
  }

  lines.push('');
  const corpus = lines.join('\n').trim();
  if (corpus.length < 30) {
    throw new Error('Archive Instagram vide ou structure non reconnue.');
  }
  return corpus;
}

// ── Extraction texte (tous formats) ──────────────────────────────────────────
async function extractText(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  try {
    if (ext === '.zip') {
      // Détecter LinkedIn vs Instagram par le contenu de l'archive
      const zip = new AdmZip(filePath);
      const entryNames = zip.getEntries().map(e => e.entryName.toLowerCase());
      const isLinkedin  = entryNames.some(n => n.includes('positions') || n.includes('profile.csv'));
      const isInstagram = entryNames.some(n => n.includes('personal_information'));
      if (isLinkedin)  return parseLinkedinZip(filePath);
      if (isInstagram) return parseInstagramZip(filePath);
      throw new Error('Archive ZIP non reconnue. Formats supportés : export LinkedIn ou export Instagram.');
    }
    if (ext === '.txt' || ext === '.json') {
      return await fs.readFile(filePath, 'utf-8');
    }
    if (ext === '.pdf') {
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
      const buffer   = await fs.readFile(filePath);
      const data     = await pdfParse(buffer);
      return data.text;
    }
    if (ext === '.docx' || ext === '.doc') {
      const mammoth = (await import('mammoth')).default;
      const result  = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }
    return '';
  } catch (err) {
    console.error('[SOURCES] Erreur extraction texte:', err.message);
    throw err;  // On remonte l'erreur pour un message précis à l'utilisateur
  }
}

// ── Suffixage automatique en cas de doublon nom fichier ──────────────────────
// "profile.pdf" -> "profile (2).pdf" -> "profile (3).pdf" ...
async function suffixerSiDoublon(userId, nomOriginal) {
  const ext  = path.extname(nomOriginal);
  const base = nomOriginal.slice(0, nomOriginal.length - ext.length);

  const { rows } = await query(
    `SELECT nom_fichier FROM bahyo_source
     WHERE user_id = $1 AND (nom_fichier = $2 OR nom_fichier ~ $3)`,
    [
      userId,
      nomOriginal,
      '^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\([0-9]+\\)' + ext.replace(/\./g, '\\.') + '$'
    ]
  );

  if (rows.length === 0) return nomOriginal;

  // Trouver le plus grand suffixe existant
  const noms = rows.map(r => r.nom_fichier);
  let maxN = 1;
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\((\\d+)\\)' + ext.replace(/\./g, '\\.') + '$');
  noms.forEach(n => {
    const m = n.match(re);
    if (m) { const v = parseInt(m[1]); if (v > maxN) maxN = v; }
  });
  return `${base} (${maxN + 1})${ext}`;
}

// ── Détection du type de source ───────────────────────────────────────────────
function detecterType(originalName, filePath) {
  const nom = originalName.toLowerCase();
  const ext = path.extname(nom);

  if (ext === '.zip') {
    try {
      const zip = new AdmZip(filePath);
      const names = zip.getEntries().map(e => e.entryName.toLowerCase());
      if (names.some(n => n.includes('positions') || n.includes('profile.csv'))) return 'LINKEDIN_ZIP';
      if (names.some(n => n.includes('personal_information'))) return 'INSTAGRAM_ZIP';
    } catch { /* fall through */ }
    return 'ARCHIVE_ZIP';
  }
  if (nom.includes('linkedin')) return 'LINKEDIN_PDF';
  if (nom.endsWith('.json') && nom.includes('positions')) return 'LINKEDIN_JSON';
  if (nom.includes('cv') || nom.includes('curriculum')) return 'CV_PDF';
  if (nom.endsWith('.docx') || nom.endsWith('.doc')) return 'CV_DOCX';
  if (nom.includes('certif') || nom.includes('diplome') || nom.includes('attestation')) return 'CERTIFICATION';
  return 'AUTRE';
}

// ─── POST /sources/upload ──────────────────────────────────────────────────────
router.post('/upload', requireAuth, upload.single('fichier'), async (req, res) => {
  let filePath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier reçu' });
    }

    filePath = req.file.path;
    const userId = req.user.id;

    let texte;
    try {
      texte = await extractText(filePath, req.file.originalname);
    } catch (extractErr) {
      await fs.unlink(filePath).catch(() => {});
      return res.status(422).json({ error: extractErr.message });
    }

    if (!texte || texte.trim().length < 50) {
      await fs.unlink(filePath).catch(() => {});
      return res.status(400).json({
        error: 'Impossible d\'extraire du texte de ce fichier. Vérifiez qu\'il n\'est pas scanné ou protégé.',
      });
    }

    const type = detecterType(req.file.originalname, filePath);

    // Le fil directeur (LinkedIn ou Instagram) est marqué est_reference = TRUE
    const estReference = ['LINKEDIN_ZIP', 'LINKEDIN_PDF', 'INSTAGRAM_ZIP'].includes(type);

    // Suffixage automatique si le nom existe deja pour cet user
    const nomFinal = await suffixerSiDoublon(userId, req.file.originalname);
    const suffixe  = nomFinal !== req.file.originalname;

    const { rows } = await query(
      `INSERT INTO bahyo_source
         (user_id, type, nom_fichier, taille_octets, contenu_texte, est_reference, poids_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, type, nom_fichier, taille_octets, est_reference, created_at`,
      [userId, type, nomFinal, req.file.size, texte, estReference, estReference ? 1.0 : 0.5]
    );

    await fs.unlink(filePath).catch(() => {});

    res.status(201).json({
      message: suffixe
        ? `Source importée. Nom modifié pour éviter le doublon : "${nomFinal}"`
        : 'Source importée avec succès',
      source: rows[0],
      nom_original: req.file.originalname,
      suffixe_applique: suffixe,
      apercu_texte: texte.substring(0, 400) + (texte.length > 400 ? '…' : ''),
      longueur_texte: texte.length,
    });
  } catch (err) {
    if (filePath) await fs.unlink(filePath).catch(() => {});
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `Fichier trop volumineux. Maximum : ${process.env.MAX_FILE_SIZE_MB || 25} MB`,
      });
    }
    console.error('[SOURCES] Erreur upload:', err.message);
    res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
});

// ─── POST /sources/url ────────────────────────────────────────────────────────
// Enregistre une URL de profil public (LinkedIn ou Instagram) comme source de reference.
// Le contenu de la page n'est pas scrape (respect des CGU) — l'URL sert de metadata et
// d'ancre pour la qualification des BS.
router.post('/url', requireAuth, async (req, res) => {
  try {
    const { url, reseau } = req.body;
    const userId = req.user.id;

    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'URL invalide (doit commencer par http:// ou https://)' });
    }
    if (url.length > 500) {
      return res.status(400).json({ error: 'URL trop longue' });
    }

    // Detection auto si reseau non fourni
    const urlLc = url.toLowerCase();
    let type = 'URL';
    if (reseau === 'ln' || urlLc.includes('linkedin.com')) type = 'LINKEDIN_URL';
    else if (reseau === 'ig' || urlLc.includes('instagram.com')) type = 'INSTAGRAM_URL';

    const { rows } = await query(
      `INSERT INTO bahyo_source
         (user_id, type, nom_fichier, taille_octets, contenu_texte, est_reference, poids_reference)
       VALUES ($1, $2, $3, $4, $5, TRUE, 1.0)
       RETURNING id, type, nom_fichier, taille_octets, est_reference, created_at`,
      [userId, type, url, url.length, url]
    );

    res.status(201).json({
      message: 'URL enregistree comme profil public de reference',
      source: rows[0],
    });
  } catch (err) {
    console.error('[SOURCES] Erreur URL:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /sources/texte-libre ────────────────────────────────────────────────
router.post('/texte-libre', requireAuth, async (req, res) => {
  try {
    const { texte } = req.body;
    const userId = req.user.id;

    if (!texte || texte.trim().length < 50) {
      return res.status(400).json({ error: 'Texte trop court (minimum 50 caractères)' });
    }

    const { rows } = await query(
      `INSERT INTO bahyo_source (user_id, type, nom_fichier, taille_octets, contenu_texte)
       VALUES ($1, 'TEXTE_LIBRE', 'Texte libre', $2, $3)
       RETURNING id, type, nom_fichier, taille_octets, created_at`,
      [userId, texte.length, texte]
    );

    res.status(201).json({ message: 'Texte ajouté', source: rows[0] });
  } catch (err) {
    console.error('[SOURCES] Erreur texte libre:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /sources/:id/texte ───────────────────────────────────────────────────
router.get('/:id/texte', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT contenu_texte FROM bahyo_source WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Source introuvable' });
    res.type('text/plain').send(rows[0].contenu_texte || '');
  } catch (err) {
    console.error('[SOURCES] Erreur texte:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── PUT /sources/:id/reference ───────────────────────────────────────────────
router.put('/:id/reference', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { poids = 1.0 } = req.body;
    const userId = req.user.id;

    const { rows: check } = await query(
      'SELECT id FROM bahyo_source WHERE id = $1 AND user_id = $2', [id, userId]
    );
    if (!check[0]) return res.status(404).json({ error: 'Source introuvable' });

    await query('UPDATE bahyo_source SET est_reference = FALSE WHERE user_id = $1', [userId]);
    await query(
      'UPDATE bahyo_source SET est_reference = TRUE, poids_reference = $1 WHERE id = $2',
      [poids, id]
    );

    res.json({ message: 'Point de référence défini', source_id: id });
  } catch (err) {
    console.error('[SOURCES] Erreur référence:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /sources ──────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, type, nom_fichier, taille_octets, est_reference,
              poids_reference,
              LEFT(contenu_texte, 200) as apercu,
              LENGTH(contenu_texte) as longueur_texte,
              (contenu_texte IS NOT NULL AND LENGTH(contenu_texte) > 0) as contenu_present,
              created_at
       FROM bahyo_source WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ sources: rows });
  } catch (err) {
    console.error('[SOURCES] Erreur liste:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── DELETE /sources/:id ───────────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      'DELETE FROM bahyo_source WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Source introuvable' });
    res.json({ message: 'Source supprimée' });
  } catch (err) {
    console.error('[SOURCES] Erreur suppression:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;