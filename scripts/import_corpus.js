#!/usr/bin/env node
// scripts/import_corpus.js
// @version 1.0.0
// @date    2026-09-17
// Importe un corpus d'annotation dans l'atelier.
//
// Formats acceptes :
//   .json   tableau d'objets { profil, poste, secteur, categorie,
//                              texte_source, noyaux_produits[], semes_detectes{} }
//           (format echantillon_30.json)
//   .jsonl  une ligne par NOYAU, format noyaux_e2.jsonl :
//           { profil, rang, secteur, poste, noyau, origine, forme,
//             verbe_faible, objet_faible, composition, objet_prep,
//             version_decoupeur }
//           Les noyaux sont regroupes par (profil, poste) pour former
//           les experiences.
//
// Usage :
//   node scripts/import_corpus.js <fichier> --nom "Echantillon 30" \
//        [--source echantillon_30.json] [--decoupeur 0.17.1] \
//        [--limit 500] [--exploitables-seulement]
//
// Necessite DATABASE_URL dans l'environnement (lu via src/db/pool.js).
// ============================================================================
import fs       from 'fs';
import path     from 'path';
import readline from 'readline';
import dotenv   from 'dotenv';
dotenv.config();

import pool, { query, withTransaction } from '../src/db/pool.js';

// ── Arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const fichier = argv.find(a => !a.startsWith('--'));
function opt(nom, defaut = null) {
  const i = argv.indexOf(`--${nom}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : defaut;
}
const flag = nom => argv.includes(`--${nom}`);

if (!fichier || !fs.existsSync(fichier)) {
  console.error('Usage : node scripts/import_corpus.js <fichier.json|.jsonl> --nom "..."');
  process.exit(1);
}

const NOM        = opt('nom', path.basename(fichier));
const SOURCE     = opt('source', path.basename(fichier));
const DECOUPEUR  = opt('decoupeur', null);
const LIMIT      = parseInt(opt('limit', '0'), 10) || 0;
const EXPL_SEULE = flag('exploitables-seulement');

// ── Lecture ──────────────────────────────────────────────────────────────────

/** Format echantillon_30.json : deja groupe par experience */
function lireJson(f) {
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!Array.isArray(data)) throw new Error('Le JSON doit etre un tableau');
  return data.map(x => ({
    profil_ref:     String(x.profil ?? ''),
    poste:          x.poste ?? null,
    secteur:        x.secteur ?? null,
    categorie:      x.categorie ?? null,
    texte_source:   x.texte_source ?? '',
    semes_detectes: x.semes_detectes ?? null,
    noyaux: (x.noyaux_produits || []).map((t, i) => ({ rang: i, texte: t })),
  }));
}

/** Format noyaux_e2.jsonl : une ligne par noyau, a regrouper */
async function lireJsonl(f) {
  const groupes = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(f),
    crlfDelay: Infinity,
  });
  let n = 0;
  for await (const ligne of rl) {
    if (!ligne.trim()) continue;
    let o;
    try { o = JSON.parse(ligne); } catch { continue; }
    const cle = `${o.profil}||${o.poste ?? ''}`;
    if (!groupes.has(cle)) {
      groupes.set(cle, {
        profil_ref:   String(o.profil ?? ''),
        poste:        o.poste ?? null,
        secteur:      o.secteur ?? null,
        categorie:    null,
        texte_source: o.texte_source ?? '',
        semes_detectes: null,
        noyaux: [],
      });
    }
    groupes.get(cle).noyaux.push({
      rang:         o.rang ?? groupes.get(cle).noyaux.length,
      texte:        o.noyau,
      origine:      o.origine ?? null,
      forme:        o.forme ?? null,
      verbe_faible: typeof o.verbe_faible === 'boolean' ? o.verbe_faible : null,
      objet_faible: typeof o.objet_faible === 'boolean' ? o.objet_faible : null,
      composition:  o.composition ?? null,
      objet_prep:   o.objet_prep ?? null,
    });
    n++;
    if (LIMIT && groupes.size >= LIMIT) break;
  }
  console.log(`  ${n} lignes lues -> ${groupes.size} experiences`);
  return [...groupes.values()];
}

// ── Import ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`-> Import de ${fichier}`);

  const ext = path.extname(fichier).toLowerCase();
  let experiences = ext === '.jsonl' ? await lireJsonl(fichier) : lireJson(fichier);

  if (EXPL_SEULE) {
    const avant = experiences.length;
    experiences = experiences.filter(e => e.texte_source?.trim() && e.noyaux.length);
    console.log(`  Filtre exploitables : ${avant} -> ${experiences.length}`);
  }
  if (LIMIT && experiences.length > LIMIT) {
    experiences = experiences.slice(0, LIMIT);
  }

  const totalNoyaux = experiences.reduce((s, e) => s + e.noyaux.length, 0);
  console.log(`  ${experiences.length} experiences, ${totalNoyaux} noyaux a importer`);

  const corpusId = await withTransaction(async (client) => {
    const { rows } = await client.query(`
      INSERT INTO bahyo_atelier_corpus (nom, source, description, version_decoupeur)
      VALUES ($1,$2,$3,$4) RETURNING id
    `, [NOM, SOURCE,
        `${experiences.length} experiences, ${totalNoyaux} noyaux`,
        DECOUPEUR]);
    return rows[0].id;
  });
  console.log(`  Corpus cree : ${corpusId}`);

  let okExp = 0, okNoy = 0;
  for (const e of experiences) {
    try {
      await withTransaction(async (client) => {
        const { rows } = await client.query(`
          INSERT INTO bahyo_atelier_experience
            (corpus_id, profil_ref, poste, secteur, categorie, texte_source, semes_detectes)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
        `, [corpusId, e.profil_ref, e.poste, e.secteur, e.categorie,
            e.texte_source, e.semes_detectes ? JSON.stringify(e.semes_detectes) : null]);
        const expId = rows[0].id;

        for (const n of e.noyaux) {
          await client.query(`
            INSERT INTO bahyo_atelier_noyau
              (experience_id, rang, texte, origine, forme,
               verbe_faible, objet_faible, composition, objet_prep)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          `, [expId, n.rang, n.texte, n.origine ?? null, n.forme ?? null,
              n.verbe_faible ?? null, n.objet_faible ?? null,
              n.composition ?? null, n.objet_prep ?? null]);
          okNoy++;
        }
      });
      okExp++;
      if (okExp % 50 === 0) console.log(`  ... ${okExp} experiences`);
    } catch (err) {
      console.error(`  ! Echec profil ${e.profil_ref} : ${err.message}`);
    }
  }

  console.log(`\nOK : ${okExp} experiences, ${okNoy} noyaux importes.`);
  console.log(`Corpus id : ${corpusId}`);

  const { rows: stats } = await query(`
    SELECT e.categorie, COUNT(DISTINCT e.id) AS exp, COUNT(n.id) AS noyaux
    FROM bahyo_atelier_experience e
    LEFT JOIN bahyo_atelier_noyau n ON n.experience_id = e.id
    WHERE e.corpus_id = $1 GROUP BY e.categorie ORDER BY 1
  `, [corpusId]);
  console.table(stats);

  await pool.end();
}

main().catch(async (err) => {
  console.error('ERREUR :', err.message);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
