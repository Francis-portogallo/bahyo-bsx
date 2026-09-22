#!/usr/bin/env node
// scripts/migrer.js
// @version 1.0.0
// @date    2026-09-22
// Execute un fichier de migration SQL instruction par instruction, en
// rapportant precisement celle qui echoue.
//
// Pourquoi ce script plutot que phpPgAdmin :
//   - phpPgAdmin enrobe les instructions dans SELECT COUNT(*) quand la
//     pagination est cochee, ce qui casse tout DDL ;
//   - il malmene l'UTF-8 au collage ;
//   - il ne dit pas QUELLE instruction a echoue dans un fichier de 250 lignes ;
//   - le decoupage naif sur « ; » casse les blocs $$ ... $$ (DO, FUNCTION).
//
// Usage :
//   node scripts/migrer.js migrations/017_modes_exclusion.sql
//   node scripts/migrer.js <fichier> --seche      (montre sans executer)
//   node scripts/migrer.js <fichier> --continuer  (n'arrete pas au 1er echec)
// ============================================================================
import fs     from 'fs';
import path   from 'path';
import dotenv from 'dotenv';
dotenv.config();
import pool, { query } from '../src/db/pool.js';

const argv    = process.argv.slice(2);
const fichier = argv.find(a => !a.startsWith('--'));
const SECHE     = argv.includes('--seche');
const CONTINUER = argv.includes('--continuer');

if (!fichier || !fs.existsSync(fichier)) {
  console.error('Usage : node scripts/migrer.js <fichier.sql> [--seche] [--continuer]');
  process.exit(1);
}

/**
 * Decoupe un script SQL en instructions.
 * Gere : chaines '...' (avec '' echappe), blocs $tag$...$tag$,
 * commentaires -- en fin de ligne et blocs slash-etoile.
 */
function decouper(sql) {
  const out = [];
  let cur = '', i = 0;
  let dansChaine = false, dansLigne = false, dansBloc = false;
  let tagDollar = null;

  while (i < sql.length) {
    const c = sql[i], d = sql.slice(i, i + 2);

    if (dansLigne) {
      if (c === '\n') dansLigne = false;
      cur += c; i++; continue;
    }
    if (dansBloc) {
      if (d === '*/') { dansBloc = false; cur += d; i += 2; continue; }
      cur += c; i++; continue;
    }
    if (tagDollar) {
      if (sql.startsWith(tagDollar, i)) {
        cur += tagDollar; i += tagDollar.length; tagDollar = null; continue;
      }
      cur += c; i++; continue;
    }
    if (dansChaine) {
      if (c === "'") {
        if (sql[i + 1] === "'") { cur += "''"; i += 2; continue; }
        dansChaine = false;
      }
      cur += c; i++; continue;
    }

    // Hors de tout contexte protege
    if (d === '--') { dansLigne = true; cur += d; i += 2; continue; }
    if (d === '/*') { dansBloc  = true; cur += d; i += 2; continue; }
    if (c === "'")  { dansChaine = true; cur += c; i++; continue; }

    const m = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
    if (m) { tagDollar = m[0]; cur += m[0]; i += m[0].length; continue; }

    if (c === ';') { out.push(cur.trim()); cur = ''; i++; continue; }

    cur += c; i++;
  }
  if (cur.trim()) out.push(cur.trim());

  // Ecarte les fragments qui ne sont que des commentaires
  return out.filter(s => {
    const nu = s.replace(/--[^\n]*/g, '')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .trim();
    return nu.length > 0;
  });
}

/** Premiere ligne significative, pour l'affichage */
function resume(sql) {
  const l = sql.split('\n')
    .map(x => x.trim())
    .filter(x => x && !x.startsWith('--'))[0] || sql.slice(0, 60);
  return l.length > 78 ? l.slice(0, 75) + '...' : l;
}

async function main() {
  const brut = fs.readFileSync(fichier, 'utf8');
  const inst = decouper(brut);

  console.log(`\nMigration : ${path.basename(fichier)}`);
  console.log(`${inst.length} instruction(s)${SECHE ? '  (execution seche)' : ''}\n`);

  if (SECHE) {
    inst.forEach((s, i) => console.log(`${String(i + 1).padStart(3)}. ${resume(s)}`));
    await pool.end();
    return;
  }

  // Trace d'execution, pour savoir ou l'on en est si ca casse
  const { rows: v } = await query('SELECT version() AS v');
  console.log(`Base : ${v[0].v.split(',')[0]}\n`);

  let ok = 0, ko = 0;
  const echecs = [];

  for (let i = 0; i < inst.length; i++) {
    const num = String(i + 1).padStart(3);
    try {
      await query(inst[i]);
      ok++;
      console.log(`  ${num}. OK    ${resume(inst[i])}`);
    } catch (err) {
      ko++;
      echecs.push({ num: i + 1, sql: inst[i], err: err.message });
      console.log(`  ${num}. ECHEC ${resume(inst[i])}`);
      console.log(`       → ${err.message}`);
      if (!CONTINUER) {
        console.log(`\n  Arret a l'instruction ${i + 1}. `
                  + `Relancer avec --continuer pour voir tous les echecs.\n`);
        break;
      }
    }
  }

  console.log(`\n${'='.repeat(66)}`);
  console.log(`  ${ok} instruction(s) passee(s), ${ko} en echec`);
  console.log(`${'='.repeat(66)}`);

  if (echecs.length) {
    console.log('\n  Detail des echecs :\n');
    for (const e of echecs) {
      console.log(`  --- instruction ${e.num} ---`);
      console.log(e.sql.split('\n').slice(0, 12).map(l => '  ' + l).join('\n'));
      console.log(`  → ${e.err}\n`);
    }
  }

  await pool.end();
  process.exit(ko ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\nERREUR FATALE :', err.message);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
