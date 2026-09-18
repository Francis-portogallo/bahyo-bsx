#!/usr/bin/env node
// scripts/test_atelier.js
// @version 1.0.0
// @date    2026-09-17
// Test d'integration de l'atelier : frappe les VRAIES routes HTTP en production
// et verifie la persistance en relisant depuis l'API.
//
// Le jeton est forge localement a partir de JWT_SECRET (pas de mot de passe
// manipule). Le compte cible doit avoir is_annotateur = TRUE.
//
// Usage :
//   node scripts/test_atelier.js --email francis.portogallo@gmail.com
//   node scripts/test_atelier.js --email ... --base http://127.0.0.1:3001
//   node scripts/test_atelier.js --email ... --clean     (supprime les traces du test)
//   node scripts/test_atelier.js --email ... --avec-ia   (inclut les appels Mistral, ~15s)
// ============================================================================
import dotenv from 'dotenv';
dotenv.config();
import jwt from 'jsonwebtoken';
import pool, { query } from '../src/db/pool.js';

const argv = process.argv.slice(2);
const opt  = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = n => argv.includes(`--${n}`);

const EMAIL   = opt('email');
const BASE    = opt('base', 'https://bsx.bahyo.net').replace(/\/$/, '');
const AVEC_IA = flag('avec-ia');
const CLEAN   = flag('clean');

if (!EMAIL) { console.error('Usage : node scripts/test_atelier.js --email <email annotateur>'); process.exit(1); }

// ── Rapport ──────────────────────────────────────────────────────────────────
const R = { ok: 0, ko: 0, lignes: [] };
function check(nom, cond, detail = '') {
  const s = cond ? 'OK  ' : 'ECHEC';
  if (cond) R.ok++; else R.ko++;
  R.lignes.push(`  [${s}] ${nom}${detail ? '  — ' + detail : ''}`);
  console.log(`  [${s}] ${nom}${detail ? '  — ' + detail : ''}`);
}
function titre(t) { console.log(`\n== ${t} ${'='.repeat(Math.max(0, 62 - t.length))}`); }

// ── Client HTTP ──────────────────────────────────────────────────────────────
let TOKEN = null;
async function call(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* corps vide */ }
  return { status: r.status, data };
}
const GET   = p       => call('GET', p);
const POST  = (p, b)  => call('POST', p, b);
const PATCH = (p, b)  => call('PATCH', p, b);
const DEL   = p       => call('DELETE', p);

// ── Etat du test ─────────────────────────────────────────────────────────────
const T = { userId: null, expId: null, noyauId: null, manqueId: null, groupeIds: [] };

async function main() {
  console.log(`\nTest atelier — cible ${BASE}`);
  console.log(`Annotateur : ${EMAIL}${AVEC_IA ? '  (avec appels Mistral)' : '  (sans IA, ajouter --avec-ia)'}\n`);

  // ── 0. Jeton ───────────────────────────────────────────────────────────────
  titre('0. Preparation');
  const { rows: u } = await query(
    'SELECT id, is_annotateur, is_superadmin FROM bahyo_user WHERE email = $1', [EMAIL]
  );
  if (!u[0]) { console.error(`Compte ${EMAIL} introuvable.`); process.exit(1); }
  T.userId = u[0].id;
  check('compte trouve', true, T.userId);
  check('role annotateur', u[0].is_annotateur || u[0].is_superadmin,
        u[0].is_annotateur ? 'is_annotateur' : 'superadmin');

  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET absent de .env'); process.exit(1); }
  TOKEN = jwt.sign({ id: T.userId, userId: T.userId, sub: T.userId },
                   process.env.JWT_SECRET, { expiresIn: '15m' });
  check('jeton forge', !!TOKEN);

  // ── 1. Acces et referentiel ────────────────────────────────────────────────
  titre('1. Acces protege');
  const ref = await GET('/atelier/referentiel');
  check('GET /atelier/referentiel', ref.status === 200, `HTTP ${ref.status}`);
  check('vocabulaire regimes', ref.data?.regimes?.includes('constatif'));
  check('vocabulaire potentiels', ref.data?.potentiels_performatifs?.join(',') === 'porte,latent,atomise');

  const sansJeton = await fetch(BASE + '/atelier/referentiel');
  check('refus sans jeton', sansJeton.status === 401 || sansJeton.status === 403,
        `HTTP ${sansJeton.status}`);

  // ── 2. Corpus et experiences ───────────────────────────────────────────────
  titre('2. Corpus importe');
  const corpus = await GET('/atelier/corpus');
  check('au moins un corpus', (corpus.data?.corpus?.length || 0) > 0,
        `${corpus.data?.corpus?.length} corpus`);

  const exps = await GET('/atelier/experiences?limit=200');
  const n = exps.data?.experiences?.length || 0;
  check('experiences listees', n > 0, `${n} experiences`);

  // Choisit une experience exploitable et riche (pour avoir des tiers)
  const cible = exps.data.experiences.find(e => e.categorie === 'riche' && +e.nb_noyaux > 2)
             || exps.data.experiences.find(e => +e.nb_noyaux > 0);
  T.expId = cible.id;
  check('experience cible choisie', !!T.expId, `${cible.poste} (${cible.nb_noyaux} noyaux)`);

  const detail = await GET('/atelier/experiences/' + T.expId);
  check('detail experience', detail.status === 200 && detail.data.noyaux.length > 0,
        `${detail.data?.noyaux?.length} noyaux`);
  check('texte source present', !!detail.data?.experience?.texte_source?.trim());
  T.noyauId = detail.data.noyaux[0].id;

  // ── 3. Dynamique des annotations ───────────────────────────────────────────
  titre('3. Dynamique des annotations');

  // 3a. Creation en brouillon
  const a1 = await POST(`/atelier/noyaux/${T.noyauId}/annotation`, {
    place: 'A1', regime: 'constatif', identification: 'TEST-Kanban',
    a_composer: true, commentaire: 'annotation de test', statut: 'brouillon',
  });
  check('POST annotation A1 (brouillon)', a1.status === 200, `HTTP ${a1.status}`);
  const annotId = a1.data?.annotation?.id;
  check('id retourne', !!annotId);

  // 3b. Relecture : la valeur est bien persistee
  const relu1 = await GET('/atelier/experiences/' + T.expId);
  const nRelu = relu1.data.noyaux.find(x => x.id === T.noyauId);
  const aRelu = (nRelu.annotations || []).find(x => x.place === 'A1');
  check('PERSISTANCE annotation', !!aRelu, aRelu ? `regime=${aRelu.regime}` : 'absente');
  check('valeurs conformes',
        aRelu?.regime === 'constatif' && aRelu?.identification === 'TEST-Kanban'
        && aRelu?.a_composer === true);

  // 3c. Upsert : re-poster ne duplique pas, met a jour
  const a1b = await POST(`/atelier/noyaux/${T.noyauId}/annotation`, {
    place: 'A1', regime: 'constatif', identification: 'TEST-Kanban-v2', statut: 'valide',
  });
  check('POST identique (upsert)', a1b.status === 200);
  check('meme id conserve', a1b.data?.annotation?.id === annotId, 'pas de doublon');
  check('valeur mise a jour', a1b.data?.annotation?.identification === 'TEST-Kanban-v2');
  check('statut mis a jour', a1b.data?.annotation?.statut === 'valide');

  const relu2 = await GET('/atelier/experiences/' + T.expId);
  const nb = (relu2.data.noyaux.find(x => x.id === T.noyauId).annotations || [])
             .filter(x => x.place === 'A1').length;
  check('une seule annotation A1', nb === 1, `${nb} trouvee(s)`);

  // 3d. Places independantes
  const a2 = await POST(`/atelier/noyaux/${T.noyauId}/annotation`, {
    place: 'A2', regime: 'constatif', identification: 'TEST-acte', statut: 'brouillon',
  });
  check('POST annotation A2', a2.status === 200);
  check('A2 distincte de A1', a2.data?.annotation?.id !== annotId);

  // 3e. Validation du vocabulaire
  const bad = await POST(`/atelier/noyaux/${T.noyauId}/annotation`, {
    place: 'A1', regime: 'inexistant',
  });
  check('refus regime invalide', bad.status === 400, `HTTP ${bad.status}`);

  const badPlace = await POST(`/atelier/noyaux/${T.noyauId}/annotation`, { place: 'A9' });
  check('refus place invalide', badPlace.status === 400, `HTTP ${badPlace.status}`);

  // 3f. REGLE DOCTRINALE : ecart non explicite refuse
  const ecartNu = await POST(`/atelier/noyaux/${T.noyauId}/annotation`, {
    place: 'A1', regime: 'declaratif', sous_categorie: 'fonctionnel',
    proposition_assistant: { regime: 'constatif', identification: 'Kanban' },
    ecart_assistant: true, ecart_explication: null,
  });
  check('REFUS ecart non explicite', ecartNu.status === 400
        && ecartNu.data?.code === 'ECART_NON_EXPLICITE', `HTTP ${ecartNu.status}`);

  const ecartCourt = await POST(`/atelier/noyaux/${T.noyauId}/annotation`, {
    place: 'A1', regime: 'declaratif', ecart_assistant: true, ecart_explication: 'non',
  });
  check('REFUS explication trop courte', ecartCourt.status === 400);

  const ecartOk = await POST(`/atelier/noyaux/${T.noyauId}/annotation`, {
    place: 'A1', regime: 'declaratif', sous_categorie: 'fonctionnel',
    identification: 'TEST-Kanban-v2',
    proposition_assistant: { regime: 'constatif', identification: 'Kanban' },
    ecart_assistant: true,
    ecart_explication: 'Le noyau ne nomme aucun procede, il enonce une fonction occupee.',
    statut: 'valide',
  });
  check('ACCEPTE ecart explicite', ecartOk.status === 200, `HTTP ${ecartOk.status}`);
  check('ecart persiste', ecartOk.data?.annotation?.ecart_assistant === true);
  check('explication persistee',
        (ecartOk.data?.annotation?.ecart_explication || '').includes('procede'));

  // ── 4. Manques ─────────────────────────────────────────────────────────────
  titre('4. Manques (coeur pedagogique)');
  const mq = await POST('/atelier/manques', {
    noyau_id: T.noyauId, place: 'A1', type_manque: 'tiers_absent',
    description: 'TEST — aucun tiers attestataire nomme dans le texte',
    question_type: 'TEST — Pour quelle entreprise cette mission a-t-elle ete menee ?',
    criticite: 'bloquant', detecte_par: 'annotateur',
  });
  check('POST manque', mq.status === 200, `HTTP ${mq.status}`);
  T.manqueId = mq.data?.manque?.id;

  const mqRelu = await GET('/atelier/experiences/' + T.expId);
  const trouve = (mqRelu.data.manques || []).find(m => m.id === T.manqueId);
  check('PERSISTANCE manque', !!trouve);
  check('question_type persistee', (trouve?.question_type || '').includes('entreprise'));
  check('criticite persistee', trouve?.criticite === 'bloquant');

  const rep = await GET('/atelier/manques/repertoire');
  const ligne = (rep.data?.repertoire || []).find(r => r.type_manque === 'tiers_absent');
  check('repertoire BioCraft alimente', !!ligne, ligne ? `${ligne.occurrences} occurrence(s)` : '');
  check('question dans le repertoire',
        (ligne?.questions || []).some(q => (q || '').includes('entreprise')));

  const mqVide = await POST('/atelier/manques', { noyau_id: T.noyauId, type_manque: 'autre' });
  check('refus manque sans description', mqVide.status === 400);

  // ── 5. Conversations ───────────────────────────────────────────────────────
  titre('5. Sauvegarde des conversations');
  if (AVEC_IA) {
    const avant = await GET('/atelier/messages?noyau_id=' + T.noyauId);
    const nAvant = avant.data?.messages?.length || 0;

    const dlg = await POST('/atelier/dialogue', {
      noyau_id: T.noyauId, experience_id: T.expId, place: 'A1',
      message: "TEST — Ce noyau nomme-t-il un procede identifiable ? Reponds en une phrase.",
    });
    check('POST /atelier/dialogue', dlg.status === 200, `HTTP ${dlg.status}`);
    check('reponse assistant non vide', (dlg.data?.reponse || '').length > 10,
          `${(dlg.data?.reponse || '').length} car. en ${dlg.data?.duree_s}s`);

    const apres = await GET('/atelier/messages?noyau_id=' + T.noyauId);
    const msgs = apres.data?.messages || [];
    check('PERSISTANCE : 2 messages ajoutes', msgs.length === nAvant + 2,
          `${nAvant} -> ${msgs.length}`);

    const dern = msgs.slice(-2);
    check('message annotateur enregistre', dern[0]?.role === 'annotateur'
          && dern[0]?.contenu.includes('TEST'));
    check('reponse assistant enregistree', dern[1]?.role === 'assistant'
          && dern[1]?.contenu.length > 10);
    check('modele trace', !!dern[1]?.modele, dern[1]?.modele);
    check('place tracee', dern[1]?.place === 'A1');

    // Second tour : l'historique doit etre repris
    const dlg2 = await POST('/atelier/dialogue', {
      noyau_id: T.noyauId, experience_id: T.expId, place: 'A1',
      message: 'TEST — Et si le tiers etait implicite ?',
    });
    check('second tour de dialogue', dlg2.status === 200);
    const apres2 = await GET('/atelier/messages?noyau_id=' + T.noyauId);
    check('PERSISTANCE : 4 messages au total', (apres2.data?.messages?.length || 0) === nAvant + 4,
          `${apres2.data?.messages?.length} messages`);

    const dlgVide = await POST('/atelier/dialogue', { noyau_id: T.noyauId, message: '  ' });
    check('refus message vide', dlgVide.status === 400);
  } else {
    console.log('  (passe — relancer avec --avec-ia pour tester le dialogue Mistral)');
  }

  // ── 6. Groupes A3 ──────────────────────────────────────────────────────────
  titre('6. Groupes A3');

  // Regle du plafond latent, testable sans IA
  const plafond = await POST('/atelier/groupes', {
    experience_id: T.expId, tiers: 'implicite', tiers_source: 'implicite',
    potentiel_performatif: 'porte',
  });
  check('REFUS plafond latent (implicite ne peut pas porter)',
        plafond.status === 400 && plafond.data?.code === 'PLAFOND_LATENT',
        `HTTP ${plafond.status}`);

  const gOk = await POST('/atelier/groupes', {
    experience_id: T.expId, tiers: 'TEST-Renault', tiers_source: 'explicite',
    finalite_exprimee: 'TEST — deploiement de la methode sur la chaine',
    potentiel_performatif: 'porte', noyau_ids: [T.noyauId],
    libelle: 'TEST — BS composite', justification: 'test d agglomeration',
  });
  check('POST groupe manuel', gOk.status === 200, `HTTP ${gOk.status}`);
  if (gOk.data?.groupe?.id) T.groupeIds.push(gOk.data.groupe.id);

  const gRelu = await GET('/atelier/experiences/' + T.expId);
  const gTrouve = (gRelu.data.groupes || []).find(g => g.id === T.groupeIds[0]);
  check('PERSISTANCE groupe', !!gTrouve);
  check('noyau rattache au groupe', (gTrouve?.noyau_ids || []).includes(T.noyauId));
  check('finalite persistee', (gTrouve?.finalite_exprimee || '').includes('deploiement'));

  const gMaj = await PATCH('/atelier/groupes/' + T.groupeIds[0],
                           { libelle: 'TEST — BS composite renomme', statut: 'valide' });
  check('PATCH groupe', gMaj.status === 200 &&
        gMaj.data?.groupe?.libelle === 'TEST — BS composite renomme');

  if (AVEC_IA) {
    const a3 = await POST(`/atelier/experiences/${T.expId}/passage-a3`, { creer_groupes: true });
    check('passage A3 Mistral', a3.status === 200, `HTTP ${a3.status}`);
    check('passage trace en base', !!a3.data?.passage?.id,
          `${a3.data?.passage?.duree_s}s, ${a3.data?.passage?.tokens_in} tokens in`);
    check('sortie JSON valide', a3.data?.passage?.statut === 'ok',
          a3.data?.passage?.statut);
    const cres = a3.data?.groupes || [];
    check('groupes proposes', cres.length > 0, `${cres.length} groupe(s)`);
    check('origine = assistant', cres.every(g => g.origine === 'assistant'));
    check('plafond latent applique par le serveur',
          cres.every(g => !(g.tiers_source === 'implicite' && g.potentiel_performatif === 'porte')));
    cres.forEach(g => T.groupeIds.push(g.id));
  }

  // ── 7. Catalogue et stats ──────────────────────────────────────────────────
  titre('7. Catalogue et tableau de bord');
  const cat = await GET('/atelier/catalogue?place=A1');
  check('GET catalogue', cat.status === 200, `${cat.data?.catalogue?.length} cas valides`);
  check('cas de test present', (cat.data?.catalogue || [])
        .some(c => (c.identification || '').startsWith('TEST-')));

  const st = await GET('/atelier/stats');
  check('GET stats', st.status === 200);
  check('compteurs coherents', +st.data?.global?.annotations >= 2,
        `${st.data?.global?.annotations} annotations, ${st.data?.global?.manques} manques`);
  check('ecarts comptes', +st.data?.ecarts_assistant >= 1, `${st.data?.ecarts_assistant} ecart(s)`);

  // ── 8. Manuel ──────────────────────────────────────────────────────────────
  titre('8. Manuel vivant');
  const man = await GET('/atelier/manuel');
  check('GET manuel', man.status === 200, `${man.data?.sections?.length} sections`);
  check('manuel amorce', (man.data?.sections?.length || 0) >= 10,
        'lancer seed_manuel.js si 0');

  const manBad = await call('PUT', '/atelier/manuel/test-section',
                            { titre: 'T', contenu_md: 'C' });
  check('REFUS modification sans les 3 questions',
        manBad.status === 400 && manBad.data?.code === 'TROIS_QUESTIONS',
        `HTTP ${manBad.status}`);

  // ── 9. Nettoyage ───────────────────────────────────────────────────────────
  titre('9. Nettoyage');
  if (CLEAN) {
    await query(`DELETE FROM bahyo_atelier_message WHERE noyau_id = $1 AND contenu LIKE 'TEST%'`, [T.noyauId]);
    await query(`DELETE FROM bahyo_atelier_message WHERE noyau_id = $1 AND role = 'assistant'
                 AND created_at > NOW() - INTERVAL '10 minutes'`, [T.noyauId]);
    await query(`DELETE FROM bahyo_atelier_manque WHERE description LIKE 'TEST%'`);
    if (T.groupeIds.length) {
      await query(`DELETE FROM bahyo_atelier_groupe WHERE id = ANY($1)`, [T.groupeIds]);
    }
    await query(`DELETE FROM bahyo_atelier_annotation
                 WHERE noyau_id = $1 AND annotateur_id = $2
                   AND (identification LIKE 'TEST%' OR commentaire LIKE '%test%')`,
                [T.noyauId, T.userId]);
    console.log('  Traces du test supprimees.');
  } else {
    console.log('  Traces conservees (relancer avec --clean pour les supprimer).');
    console.log(`  Experience de test : ${BASE}/atelier.html  ->  ${cible.poste}`);
  }

  // ── Bilan ──────────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(66)}`);
  console.log(`  BILAN : ${R.ok} OK, ${R.ko} echec(s)`);
  if (R.ko) {
    console.log('\n  Echecs :');
    R.lignes.filter(l => l.includes('[ECHEC]')).forEach(l => console.log(l));
  }
  console.log(`${'='.repeat(66)}\n`);

  await pool.end();
  process.exit(R.ko ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\nERREUR FATALE :', err.message);
  console.error(err.stack?.split('\n').slice(1, 4).join('\n'));
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
