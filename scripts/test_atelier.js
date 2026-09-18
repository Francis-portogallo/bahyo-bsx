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

// Une coupure reseau ne doit jamais tuer la suite : on reessaie une fois,
// puis on renvoie un statut 0 que les checks traiteront comme un echec.
async function call(method, path, body, essai = 1) {
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await r.json(); } catch { /* corps vide */ }
    return { status: r.status, data };
  } catch (err) {
    const cause = err.cause?.code || err.cause?.message || err.message;
    if (essai < 3) {
      console.log(`      (reseau : ${cause} sur ${method} ${path} — nouvelle tentative ${essai + 1}/3)`);
      await new Promise(r => setTimeout(r, 1500 * essai));
      return call(method, path, body, essai + 1);
    }
    return { status: 0, data: { error: `connexion perdue : ${cause}` }, reseau: true };
  }
}
const GET   = p       => call('GET', p);
const POST  = (p, b)  => call('POST', p, b);
const PATCH = (p, b)  => call('PATCH', p, b);
const PUT   = (p, b)  => call('PUT', p, b);
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
  const liste = exps.data?.experiences;
  const n = liste?.length || 0;
  check('experiences listees', n > 0,
        Array.isArray(liste) ? `${n} experiences`
                             : `HTTP ${exps.status} — ${exps.data?.error || 'reponse inattendue'}`);

  if (!n) {
    console.log(`\n  Arret : la route /atelier/experiences ne renvoie pas de liste.`);
    console.log(`  Reponse brute : ${JSON.stringify(exps.data).slice(0, 300)}`);
    console.log(`  Cause la plus frequente : migration 016 non executee`);
    console.log(`  (colonnes statut / exploitable absentes de bahyo_atelier_experience).\n`);
    console.log(`  BILAN PARTIEL : ${R.ok} OK, ${R.ko} echec(s)\n`);
    await pool.end();
    process.exit(1);
  }

  // Choisit une experience exploitable et riche (pour avoir des tiers)
  const cible = liste.find(e => e.categorie === 'riche' && +e.nb_noyaux > 2)
             || liste.find(e => +e.nb_noyaux > 0);
  if (!cible) {
    console.log('\n  Arret : aucune experience avec des noyaux.\n');
    await pool.end();
    process.exit(1);
  }
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
        gMaj.data?.groupe?.libelle === 'TEST — BS composite renomme',
        gMaj.status === 200 ? '' : `HTTP ${gMaj.status} — ${gMaj.data?.error || ''}`);
  check('revision incrementee (trigger historique)',
        gMaj.status !== 200 || gMaj.data?.groupe?.revision >= 2,
        `revision=${gMaj.data?.groupe?.revision}`);

  // Recomposition des membres (G.2)
  const gNoy = await PUT(`/atelier/groupes/${T.groupeIds[0]}/noyaux`, { noyau_ids: [T.noyauId] });
  check('PUT membres du groupe', gNoy.status === 200,
        gNoy.status === 200 ? '' : `HTTP ${gNoy.status} — ${gNoy.data?.error || ''}`);

  // Statut orphelin (G.6)
  const orph = await PATCH(`/atelier/noyaux/${T.noyauId}/orphelin`, { statut_orphelin: 'candidat' });
  check('PATCH statut orphelin', orph.status === 200,
        orph.data?.noyau?.statut_orphelin || `HTTP ${orph.status}`);

  // Statut d'experience, dont le marquage manuel 'a_revoir' (M.3)
  const stExp = await PATCH(`/atelier/experiences/${T.expId}/statut`, { statut: 'a_revoir' });
  check('PATCH statut experience', stExp.status === 200, stExp.data?.experience?.statut);
  await PATCH(`/atelier/experiences/${T.expId}/statut`, { statut: 'en_cours' });

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

  // ── 8bis. Historique complet des reeditions (E.6) ──────────────────────────
  titre('8bis. Historique des reeditions');
  const annotCour = (await GET('/atelier/experiences/' + T.expId))
    .data.noyaux.find(n => n.id === T.noyauId)
    ?.annotations?.find(a => a.place === 'A1');
  check('annotation A1 retrouvee', !!annotCour, `revision=${annotCour?.revision}`);
  check('revision > 1 apres reeditions', (annotCour?.revision || 0) > 1,
        `${annotCour?.revision} revision(s)`);
  check('version_manuel estampillee', annotCour?.version_manuel != null,
        `v${annotCour?.version_manuel}`);

  if (annotCour?.id) {
    const h = await GET(`/atelier/annotations/${annotCour.id}/historique`);
    check('GET historique annotation', h.status === 200);
    const n = h.data?.historique?.length || 0;
    check('versions anterieures archivees', n >= 1, `${n} version(s)`);
    check('coherence revision / historique',
          n === (annotCour.revision - 1),
          `revision=${annotCour.revision}, archivees=${n}`);
    const prem = h.data?.historique?.[h.data.historique.length - 1];
    check('valeur initiale conservee', !!prem?.regime,
          prem ? `v1 : regime=${prem.regime}, ident=${prem.identification}` : '');
  }

  // ── 8ter. Versionnement du manuel (J.4 / M.2) ──────────────────────────────
  titre('8ter. Versionnement du manuel');
  const vAvant = (await GET('/atelier/referentiel')).data?.version_manuel;
  const manOk = await call('PUT', '/atelier/manuel/test-recette', {
    titre: 'TEST — section de recette',
    contenu_md: 'Section creee par le test d integration. Supprimable.',
    ordre: 999,
    quoi: 'Creation d une section de test.',
    ou: 'Manuel vivant, section test-recette.',
    pourquoi: 'Verifier le versionnement exige par J.4 du cahier de recette.',
  });
  check('PUT manuel avec les 3 questions', manOk.status === 200, `HTTP ${manOk.status}`);
  const vApres = (await GET('/atelier/referentiel')).data?.version_manuel;
  check('version globale incrementee', vApres === vAvant + 1, `v${vAvant} -> v${vApres}`);

  const vers = await GET('/atelier/manuel/test-recette/versions');
  check('historique de section accessible', (vers.data?.versions?.length || 0) >= 1,
        `${vers.data?.versions?.length} version(s)`);
  check('les 3 questions consignees',
        !!vers.data?.versions?.[0]?.quoi && !!vers.data?.versions?.[0]?.ou
        && !!vers.data?.versions?.[0]?.pourquoi);

  // ── 8quater. Export vers le SLM (Partie L) ─────────────────────────────────
  titre('8quater. Export SLM (Partie L)');
  const exp1 = await GET(`/atelier/export/experience/${T.expId}`);
  check('GET export/experience', exp1.status === 200, `HTTP ${exp1.status}`);

  const e0 = exp1.data?.experiences?.[0];
  check('schema L.2 — champs racine', !!e0
    && 'id_experience' in e0 && 'texte_source' in e0 && 'noyaux' in e0
    && 'groupes_a3' in e0 && 'dialogues' in e0 && 'manques' in e0);
  check('texte_source integral', (e0?.texte_source || '').length > 50,
        `${(e0?.texte_source || '').length} caracteres`);

  const n0 = e0?.noyaux?.[0];
  check('schema L.2 — noyau', !!n0 && 'marquages_decoupeur' in n0
    && 'version_decoupeur' in n0 && 'rang_dans_description' in n0);

  const a0 = e0?.noyaux?.flatMap(n => n.annotations || [])
                  .find(a => a.place === 'A1');
  check('schema L.2 — annotation', !!a0 && 'sous_type' in a0
    && 'candidat_composition' in a0 && 'version_manuel' in a0);
  check('historique inclus dans l export', Array.isArray(a0?.historique),
        `${a0?.historique?.length ?? '—'} version(s)`);

  const d0 = e0?.dialogues?.[0];
  check('schema L.2 — dialogue avec tours', !!d0 && Array.isArray(d0.tours)
    && d0.tours.length >= 2, `${d0?.tours?.length} tours`);
  check('documents_consultes present', Array.isArray(d0?.documents_consultes));

  check('comptages presents', !!exp1.data?.comptages?.noyaux,
        JSON.stringify(exp1.data?.comptages?.par_place));
  check('COHERENCE REFERENTIELLE (L.5)', (exp1.data?.anomalies?.length || 0) === 0,
        (exp1.data?.anomalies || []).slice(0, 2).join(' | ') || 'aucune anomalie');

  const ctrl = await GET('/atelier/export/controle');
  check('GET export/controle', ctrl.status === 200,
        ctrl.data?.coherence_referentielle);

  const expTout = await GET('/atelier/export?tout=1');
  check('GET export integral', expTout.status === 200,
        `${expTout.data?.comptages?.experiences} experiences, `
        + `${expTout.data?.comptages?.annotations} annotations`);

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
    await query(`DELETE FROM bahyo_atelier_manuel_version WHERE section_cle = 'test-recette'`);
    await query(`DELETE FROM bahyo_atelier_manuel WHERE section_cle = 'test-recette'`);
    await query(`UPDATE bahyo_atelier_noyau SET statut_orphelin = NULL WHERE id = $1`,
                [T.noyauId]);
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
