#!/usr/bin/env node
// scripts/seed_manuel.js
// @version 1.0.0
// @date    2026-09-17
// Amorce le manuel vivant de l'atelier avec le fond doctrinal de la methode 3A,
// issu de complement_transmission_atelier.md (partie 1) et du cahier de conception.
//
// Idempotent : re-executable, met a jour les sections existantes par section_cle.
// Passe par Node/pg pour eviter les problemes d'encodage UTF-8 de phpPgAdmin.
//
// Usage :  node scripts/seed_manuel.js
// ============================================================================
import dotenv from 'dotenv';
dotenv.config();
import pool, { query } from '../src/db/pool.js';

const SECTIONS = [
  {
    cle: 'definition-bs',
    titre: "Ce qu'est un BS",
    ordre: 10,
    contenu: `Un BS (BioSkill) est une micro-competence identifiee dans le parcours
professionnel d'une personne, constituee par la presence conjointe des trois
places du formalisme 3A.

A1 — L'APTITUDE
Le savoir constitue comme lieu ou l'exercice peut se deposer. Une aptitude
n'est pas une qualite personnelle (« je suis rigoureux »), c'est un
savoir-faire identifiable et transferable (« developper en Prolog »,
« appliquer la methode Kanban », « peindre a l'huile »).

A2 — L'ACTE
L'exercice effectif de l'aptitude sur un objet concret. Pas la declaration
d'un exercice (« gestion de projet »), mais l'exercice lui-meme dans son
occurrence (« mise en place de Kanban dans la chaine de montage »).

A3 — L'ATTESTATION
Le rattachement de l'acte a un tiers qui le constate. Le tiers peut etre un
employeur, un client, une autorite reglementaire, un partenaire. Ce qui
compte, c'est qu'un tiers exterieur puisse attester que l'acte a eu lieu.

Un BS n'existe que si les trois places sont occupees. Sans A3, on reste dans
le regime declaratif — on pretend avoir une competence, on ne l'atteste pas.`,
  },
  {
    cle: 'agglomeration-a3',
    titre: "L'agglomeration par unicite de A3",
    ordre: 20,
    contenu: `Les actes atomiques qui partagent une meme attestation forment un BS
composite unique. Ce principe n'est pas optionnel.

EXEMPLE
Un ingenieur qui, chez Renault, a concu un module, developpe son code, teste
ses performances et documente ses interfaces : les quatre actes partagent
l'attestation Renault. Ils ne forment pas quatre BS separes. Ils forment UN
SEUL BS composite dont l'aptitude est plus large que chaque acte pris
individuellement.

CONSEQUENCE SUR L'ORDRE LOGIQUE
A3 n'est pas un attribut ajoute a un BS deja constitue. A3 EST LE PRINCIPE DE
CONSTITUTION du BS composite. L'attestation vient d'abord, elle determine ce
qui se regroupe.

DANS L'ATELIER
C'est pourquoi le passage A3 est lance sur l'experience entiere, et non noyau
par noyau. Il produit des groupes. Chaque groupe est un candidat BS composite
que l'annotateur nomme et valide.`,
  },
  {
    cle: 'declaratif-constatif',
    titre: 'La distinction declaratif / constatif',
    ordre: 30,
    contenu: `Le socle qui permet de trier ce qui releve du formalisme 3A et ce qui n'en
releve pas est la distinction entre deux regimes d'enonciation.

LE REGIME DECLARATIF
L'enonce rapporte une posture, une qualite, une intention. « Bonne
communication », « leadership », « gestion des equipes », « esprit d'equipe ».
Ces enonces parlent de la personne, ils ne rapportent aucun exercice atteste.

LE REGIME CONSTATIF
L'enonce rapporte un exercice identifiable et rattache. « Mise en place de
Kanban chez Renault », « certification ANSM du procede », « livraison de 42
lots pour 35 clients ». Ces enonces parlent d'actes situes, attestables par
leur contexte.

La methode 3A ECARTE PAR NATURE tout ce qui est uniquement declaratif.

UN AVERTISSEMENT
Cette distinction n'est pas un jugement moral sur les personnes. Un manager de
talent peut passer sa carriere dans le registre declaratif faute d'avoir
formule ce qu'il fait dans les termes du constatif. Cela ne dit rien de sa
valeur — cela dit seulement que le texte disponible ne permet pas de
constituer des BS selon le formalisme.`,
  },
  {
    cle: 'ecartes-par-nature',
    titre: 'Ce qui est ecarte par nature',
    ordre: 40,
    contenu: `Deux categories de noyaux relevent du declaratif par nature.

LE FONCTIONNEL
Les locutions de gestion, de pilotage, de supervision, de coordination, sans
contenu procedural discriminant. « Gestion de projet », « management
d'equipe », « pilotage des operations ». Le noyau dit qu'une fonction a ete
occupee, il n'atteste d'aucun exercice.

LE RELATIONNEL
Les qualites interpersonnelles presentees comme competences. « Bonne
communication », « esprit d'equipe », « sens du contact ». Le noyau decrit une
posture, pas un savoir-faire.

DANS L'ATELIER
Ces noyaux sont annotes regime: declaratif, avec la sous-categorie identifiee.
Ils sont ecartes du corpus des BS enseignants MAIS CONSERVES comme exemples
negatifs. Le SLM doit apprendre a les reconnaitre pour les ecarter.`,
  },
  {
    cle: 'registres-eligibles',
    titre: 'Les registres eligibles',
    ordre: 50,
    contenu: `Les aptitudes qui portent un PROCEDE IDENTIFIABLE dont la mise en oeuvre est
attestable sont eligibles.

L'EXPERTISE TECHNIQUE
Savoir-faire precis dans un domaine identifie. Developpement dans un langage,
maitrise d'un outil, diagnostic dans une specialite, application d'une norme.

L'ARTISTIQUE
Creation, composition, execution d'une oeuvre identifiable dans un genre
reconnaissable.

LA REALISATION, PLUS LARGEMENT
Toute pratique structuree par un procede nommable qui produit un resultat
mesurable. Cela inclut l'INDUSTRIALISATION DE SERVICE — Kanban, Lean, Six
Sigma, ISO 9001, flux tendu, knock-down en montage industriel. Ces methodes
sont des objets techniques au meme titre qu'une expertise artisanale.

LE PRINCIPE CARDINAL
Un poste n'est pas eligible ou non eligible en soi. Un directeur qui n'a que
des locutions declaratives ne produit pas de BS. Un directeur qui a deploye
une methode identifiable chez un tiers nomme produit des BS hautement
valorisables. LA DIFFERENCE EST DANS CE QUI EST FAIT ET ATTESTE, PAS DANS LE
POSTE OCCUPE.`,
  },
  {
    cle: 'naives-orphelines',
    titre: 'Aptitudes naives et aptitudes orphelines',
    ordre: 60,
    contenu: `Deux notions a ne pas confondre.

LES APTITUDES NAIVES
Certains noyaux portent des aptitudes qui, prises isolement, ne portent pas de
potentiel performatif clair, mais qui pourraient prendre sens comme composants
d'un BS composite a venir.

Elles sont annotees regime: constatif avec « a composer » coche. Elles restent
dans la matiere disponible pour l'agglomeration.

LES APTITUDES ORPHELINES
A l'issue du travail sur A3, certaines aptitudes naives n'auront trouve aucun
groupe ou s'integrer — leur attestation ne les relie a rien d'autre. Elles
n'ont pas vocation a etre valorisees dans un marche.

Elles sont annotees regime: orphelin et rejoignent la base comme exemples
negatifs.

L'ORDRE COMPTE
On ne peut pas declarer une aptitude orpheline avant d'avoir travaille A3.
Tant que A3 n'est pas qualifie, une aptitude sans groupe reste naive, pas
orpheline.`,
  },
  {
    cle: 'constatif-performatif',
    titre: 'Constatif et performatif : le second axe',
    ordre: 70,
    contenu: `Le formalisme 3A porte une seconde distinction, qui n'est pas constitutive
mais EVALUATIVE — celle entre le constatif et le performatif.

Un BS peut etre PARFAITEMENT FORME au sens du formalisme (presence de A1, A2,
A3) et pourtant ne pas etre POTENTIELLEMENT PERFORMATIF, c'est-a-dire ne pas
porter dans un marche de competences.

« Faire une typologie de virus pour le laboratoire lambda » a les trois places
du formalisme. Mais si la typologie est isolee, sans inscription dans une
chaine de finalite (par exemple un traitement therapeutique en cours de
developpement), sa portee performative est faible. C'est le canada dry du BS.

LES TROIS VALEURS
- porte    : tiers explicite, chaine de finalite claire, actes qui
             contribuent a un resultat identifiable
- latent   : attestation presente mais finalite implicite, ou tiers implicite.
             UN TIERS IMPLICITE NE PEUT JAMAIS DEPASSER « latent », quelle que
             soit la clarte de la finalite.
- atomise  : constitution formelle sans chaine de finalite identifiable

OU SE QUALIFIE LE POTENTIEL
Principalement au niveau du BS composite issu de A3, pas au niveau du noyau
atomique.

POURQUOI C'EST CENTRAL
Un BS enseignant pour BioCraft et SkillCraft doit etre DOUBLEMENT QUALIFIE :
formellement propre (les trois places) et potentiellement performatif
(inscription dans une chaine de finalite identifiable).`,
  },
  {
    cle: 'couple-aa',
    titre: 'Le couple annotateur-assistant',
    ordre: 80,
    contenu: `L'unite de travail dans l'atelier n'est ni l'annotateur seul ni l'assistant
seul. C'est LE COUPLE AA. Chaque decision d'annotation est le produit du
dialogue entre les deux.

CE QUE FAIT L'ASSISTANT
Il propose une qualification et la justifie. Il rappelle la doctrine. Il pose
les questions qu'un noyau ambigu appelle. Il signale les incoherences avec les
cas deja traites. Il porte la competence encyclopedique — connaitre les
methodes, les procedes, les expertises qui structurent les metiers.

CE QUE FAIT L'ANNOTATEUR
Il decide. Il est souverain. Il peut passer outre les propositions de
l'assistant.

MAIS TOUT ECART DOIT ETRE EXPLICITE
Quand l'annotateur decide autrement que ce que propose l'assistant, il formule
pourquoi. Cette explicitation est consignee. Elle a trois vertus : elle
maintient l'annotateur dans la vigilance, elle enrichit la memoire
operationnelle, et un nombre significatif d'ecarts sur un meme point signale
qu'une regle doit etre revisee.

L'atelier BLOQUE la sauvegarde tant qu'un ecart detecte n'est pas explicite.
C'est volontaire.`,
  },
  {
    cle: 'les-manques',
    titre: 'Les manques : la sortie la plus precieuse',
    ordre: 90,
    contenu: `Le classement des noyaux n'est pas la finalite premiere de l'atelier.

CE QUE L'ATELIER PRODUIT DE PLUS PRECIEUX, C'EST L'IDENTIFICATION DE CE QUI
MANQUE pour qu'un BS soit correctement forme.

Un BS peut etre bien forme au sens du formalisme et rester sans signification
evidente — parce qu'il provient d'une decoupe deconnectee de son contexte. La
question n'est alors pas « comment le classer » mais « quelle information
aurait-il fallu pour conclure ».

POURQUOI C'EST CENTRAL
Chaque manque consigne, avec la question que BioCraft devrait poser pour le
combler, constitue le jeu d'entrainement de l'assistant amont. A terme, le
repertoire des manques donne la liste des questions que BioCraft doit savoir
poser a un utilisateur pour que sa matiere devienne qualifiable.

LES TYPES DE MANQUE
contexte_projet, precision_acte, perimetre, resultat_mesurable, tiers_absent,
tiers_implicite, finalite_absente, datation, procede_non_nomme, echelle.

TOUJOURS FORMULER LA QUESTION
Un manque sans sa question est a moitie perdu. « Le tiers n'est pas nomme »
est un constat. « Pour quelle entreprise ou quel client cette mission a-t-elle
ete menee ? » est un enseignement.`,
  },
  {
    cle: 'incrementalite',
    titre: "L'incrementalite comme mode d'evolution",
    ordre: 100,
    contenu: `L'atelier n'est pas une machine qu'on construit une fois et qu'on met en
production. C'est un systeme qui se construit EN MEME TEMPS QU'IL TRAVAILLE.

Chaque cas nouveau qualifie enrichit le catalogue. Chaque cas litigieux
resolu affine les regles. Chaque modification de ce manuel precise la
doctrine.

Cette incrementalite n'est pas un choix technique parmi d'autres. Elle est
structurellement necessaire — l'approche par qualification humaine assistee ne
peut se stabiliser qu'a mesure qu'elle rencontre les cas reels.

LES TROIS QUESTIONS DE TOUT CHANGEMENT
Toute evolution de ce manuel doit porter :
  QUOI     — ce qui change, precisement. Pas une formulation generale, mais
             la description exacte : un champ ajoute, une regle reformulee,
             une categorie creee.
  OU       — le lieu du changement : le schema d'annotation, le processus de
             qualification, la formation de l'assistant, l'interface, ce
             manuel.
  POURQUOI — la raison. Un cas qui n'etait pas couvert, une incoherence
             detectee, une categorie qui n'existait pas au debut. La raison
             n'est pas justificative, elle est explicative.

L'atelier REFUSE une modification du manuel qui ne porte pas ces trois
informations.`,
  },
  {
    cle: 'rigueur',
    titre: 'Formation, processus, rigueur',
    ordre: 110,
    contenu: `Trois exigences structurent le travail de l'atelier.

LA FORMATION
Le couple AA doit etre parfaitement eduque a l'approche 3A. Elle n'est pas un
prealable une fois pour toutes : c'est un etat continu. Chaque evolution de
l'approche demande de remettre a jour la formation des deux membres du couple
— ce manuel pour l'humain, le prompt systeme pour l'assistant.

LE PROCESSUS
L'approche doit etre systematique. Le meme noyau doit etre qualifie de la meme
maniere deux fois a un mois d'intervalle, quel que soit le contexte du moment.

LA RIGUEUR
Les decisions doivent tenir. Un cas litigieux tranche reste tranche, sauf si
un nouveau critere emerge qui justifie de le retrancher. La rigueur est le
respect des decisions passees comme precedents, et l'explication claire quand
on s'en ecarte.

LA CONSIGNATION
Tout ce qui se passe dans l'atelier est consigne : les decisions avec leur
schema structure, les conversations completes, les evolutions du manuel, les
cas litigieux avec leur resolution. Rien n'est perdu, tout peut etre repris.`,
  },
];

async function main() {
  console.log(`-> Seed du manuel vivant : ${SECTIONS.length} sections`);

  const QUOI     = 'Creation initiale des sections doctrinales du manuel.';
  const OU       = 'Manuel vivant de l\'atelier, sections de fond.';
  const POURQUOI = 'Amorcage : le manuel etait vide, la formation du couple AA '
                 + 'exige un socle doctrinal ecrit. Contenu issu de '
                 + 'complement_transmission_atelier.md (partie 1) du 17/09/2026.';

  let n = 0;
  for (const s of SECTIONS) {
    await query(`
      INSERT INTO bahyo_atelier_manuel
        (section_cle, titre, contenu_md, ordre,
         dernier_quoi, dernier_ou, dernier_pourquoi)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (section_cle) DO UPDATE SET
        titre = EXCLUDED.titre,
        contenu_md = EXCLUDED.contenu_md,
        ordre = EXCLUDED.ordre,
        updated_at = NOW()
    `, [s.cle, s.titre, s.contenu, s.ordre, QUOI, OU, POURQUOI]);
    n++;
    console.log(`   ${String(s.ordre).padStart(4)} ${s.cle}`);
  }

  const { rows } = await query('SELECT COUNT(*) AS n FROM bahyo_atelier_manuel');
  console.log(`\nOK : ${n} sections ecrites, ${rows[0].n} en base.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('ERREUR :', err.message);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
