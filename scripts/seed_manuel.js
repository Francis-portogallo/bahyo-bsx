#!/usr/bin/env node
// scripts/seed_manuel.js
// @version 1.2.0
// @date    2026-09-22
// Amorce le manuel vivant de l'atelier avec le FORMALISME 3A et ses REGLES
// D'APPLICATION, issus de complement_transmission_atelier.md (partie 1), du
// cahier de conception et de specification_modes_exclusion.md v1.0.
//
// Terminologie : le terme « doctrine » est proscrit. Le FORMALISME designe le
// systeme, qui est stable ; les REGLES D'APPLICATION designent ce qui evolue.
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
    contenu: `Un BS (BioSkill) est une micro-compétence identifiée dans le parcours
professionnel d'une personne, constituée par la présence conjointe des trois
places du formalisme 3A.

A₁ — L'APTITUDE
Le savoir constitué comme lieu où l'exercice peut se déposer. Une aptitude
n'est pas une qualité personnelle (« je suis rigoureux »), c'est un
savoir-faire identifiable et transférable (« développer en Prolog »,
« appliquer la méthode Kanban », « peindre à l'huile »).

A₂ — L'ACTE
L'exercice effectif de l'aptitude sur un objet concret. Pas la déclaration
d'un exercice (« gestion de projet »), mais l'exercice lui-même dans son
occurrence (« mise en place de Kanban dans la chaîne de montage »).

A₃ — L'ATTESTATION
Le rattachement de l'acte à un tiers qui le constate. Le tiers peut être un
employeur, un client, une autorité réglementaire, un partenaire. Ce qui
compte, c'est qu'un tiers extérieur puisse attester que l'acte a eu lieu.

Un BS n'existe que si les trois places sont occupées. Sans A₃, on reste dans
le régime déclaratif — on prétend avoir une compétence, on ne l'atteste pas.`,
  },
  {
    cle: 'agglomeration-a3',
    titre: "L'agglomération par unicité de A₃",
    ordre: 20,
    contenu: `Les actes atomiques qui partagent une même attestation forment un BS
composite unique. Ce principe n'est pas optionnel.

EXEMPLE
Un ingénieur qui, chez Renault, a conçu un module, développé son code, testé
ses performances et documenté ses interfaces : les quatre actes partagent
l'attestation Renault. Ils ne forment pas quatre BS séparés. Ils forment UN
SEUL BS composite dont l'aptitude est plus large que chaque acte pris
individuellement.

CONSÉQUENCE SUR L'ORDRE LOGIQUE
A₃ n'est pas un attribut ajouté à un BS déjà constitué. A₃ EST LE PRINCIPE DE
CONSTITUTION du BS composite. L'attestation vient d'abord, elle détermine ce
qui se regroupe.

DANS L'ATELIER
C'est pourquoi le passage A₃ est lancé sur l'expérience entière, et non noyau
par noyau. Il produit des groupes. Chaque groupe est un candidat BS composite
que l'annotateur nomme et valide.`,
  },
  {
    cle: 'declaratif-constatif',
    titre: 'La distinction déclaratif / constatif',
    ordre: 30,
    contenu: `Le socle qui permet de trier ce qui relève du formalisme 3A et ce qui n'en
relève pas est la distinction entre deux régimes d'énonciation.

LE RÉGIME DÉCLARATIF
L'énoncé rapporte une posture, une qualité, une intention. « Bonne
communication », « leadership », « gestion des équipes », « esprit d'équipe ».
Ces énoncés parlent de la personne, ils ne rapportent aucun exercice attesté.

LE RÉGIME CONSTATIF
L'énoncé rapporte un exercice identifiable et rattaché. « Mise en place de
Kanban chez Renault », « certification ANSM du procédé », « livraison de 42
lots pour 35 clients ». Ces énoncés parlent d'actes situés, attestables par
leur contexte.

La méthode 3A ÉCARTE PAR NATURE tout ce qui est uniquement déclaratif.

UN AVERTISSEMENT
Cette distinction n'est pas un jugement moral sur les personnes. Un manager de
talent peut passer sa carrière dans le registre déclaratif faute d'avoir
formulé ce qu'il fait dans les termes du constatif. Cela ne dit rien de sa
valeur — cela dit seulement que le texte disponible ne permet pas de
constituer des BS selon le formalisme.`,
  },
  {
    cle: 'ecartes-par-nature',
    titre: 'Ce qui est écarté par nature',
    ordre: 40,
    contenu: `Deux catégories de noyaux relèvent du déclaratif par nature.

LE FONCTIONNEL
Les locutions de gestion, de pilotage, de supervision, de coordination, sans
contenu procédural discriminant. « Gestion de projet », « management
d'équipe », « pilotage des opérations ». Le noyau dit qu'une fonction a été
occupée, il n'atteste d'aucun exercice.

LE RELATIONNEL
Les qualités interpersonnelles présentées comme compétences. « Bonne
communication », « esprit d'équipe », « sens du contact ». Le noyau décrit une
posture, pas un savoir-faire.

DANS L'ATELIER
Ces noyaux sont annotés régime : déclaratif, avec la sous-catégorie identifiée.
Ils sont écartés du corpus des BS enseignants MAIS CONSERVÉS comme exemples
négatifs. Le SLM doit apprendre à les reconnaître pour les écarter.`,
  },
  {
    cle: 'registres-eligibles',
    titre: 'Les registres éligibles',
    ordre: 50,
    contenu: `Les aptitudes qui portent un PROCÉDÉ IDENTIFIABLE dont la mise en œuvre est
attestable sont éligibles.

L'EXPERTISE TECHNIQUE
Savoir-faire précis dans un domaine identifié. Développement dans un langage,
maîtrise d'un outil, diagnostic dans une spécialité, application d'une norme.

L'ARTISTIQUE
Création, composition, exécution d'une œuvre identifiable dans un genre
reconnaissable.

LA RÉALISATION, PLUS LARGEMENT
Toute pratique structurée par un procédé nommable qui produit un résultat
mesurable. Cela inclut l'INDUSTRIALISATION DE SERVICE — Kanban, Lean, Six
Sigma, ISO 9001, flux tendu, knock-down en montage industriel. Ces méthodes
sont des objets techniques au même titre qu'une expertise artisanale.

LE PRINCIPE CARDINAL
Un poste n'est pas éligible ou non éligible en soi. Un directeur qui n'a que
des locutions déclaratives ne produit pas de BS. Un directeur qui a déployé
une méthode identifiable chez un tiers nommé produit des BS hautement
valorisables. LA DIFFÉRENCE EST DANS CE QUI EST FAIT ET ATTESTÉ, PAS DANS LE
POSTE OCCUPÉ.`,
  },
  {
    cle: 'naives-orphelines',
    titre: 'Aptitudes naïves et aptitudes orphelines',
    ordre: 60,
    contenu: `Deux notions à ne pas confondre.

LES APTITUDES NAÏVES
Certains noyaux portent des aptitudes qui, prises isolément, ne portent pas de
potentiel performatif clair, mais qui pourraient prendre sens comme composants
d'un BS composite à venir.

Elles sont annotées régime : constatif avec « à composer » coché. Elles restent
dans la matière disponible pour l'agglomération.

LES APTITUDES ORPHELINES
À l'issue du travail sur A₃, certaines aptitudes naïves n'auront trouvé aucun
groupe où s'intégrer — leur attestation ne les relie à rien d'autre. Elles
n'ont pas vocation à être valorisées dans un marché.

Elles sont annotées régime : orphelin et rejoignent la base comme exemples
négatifs.

L'ORDRE COMPTE
On ne peut pas déclarer une aptitude orpheline avant d'avoir travaillé A₃.
Tant que A₃ n'est pas qualifié, une aptitude sans groupe reste naïve, pas
orpheline.`,
  },
  {
    cle: 'constatif-performatif',
    titre: 'Constatif et performatif : le second axe',
    ordre: 70,
    contenu: `Le formalisme 3A porte une seconde distinction, qui n'est pas constitutive
mais ÉVALUATIVE — celle entre le constatif et le performatif.

Un BS peut être PARFAITEMENT FORMÉ au sens du formalisme (présence de A₁, A₂,
A₃) et pourtant ne pas être POTENTIELLEMENT PERFORMATIF, c'est-à-dire ne pas
porter dans un marché de compétences.

DEUX AXES INDÉPENDANTS, PAS UNE ÉCHELLE
Il ne s'agit pas d'un seul curseur mais de deux propriétés distinctes, dont
les quatre combinaisons existent réellement.

L'INSCRIPTION DANS UNE CHAÎNE DE FINALITÉ — ce que l'annotateur saisit :
  - porte    : tiers explicite, finalité claire, actes contribuant à un
               résultat identifiable
  - latent   : attestation présente mais finalité implicite, ou tiers
               implicite. UN TIERS IMPLICITE NE PEUT JAMAIS DÉPASSER
               « latent », quelle que soit la clarté de la finalité.
  - atomise  : aucune chaîne de finalité identifiable

LES MODES D'EXCLUSION — ce que l'annotateur constate (voir la section
suivante).

Les quatre combinaisons :
  inscrit + objet rare        → le cas recherché
  inscrit + objet banal       → « distribution d'eau du robinet » parfaitement
                                décrite : formellement impeccable, sans valeur
                                possible
  non inscrit + objet rare    → « typologie de virus » isolée : le canada dry
  ni l'un ni l'autre          → rien à en tirer

Un champ unique à valeurs exclusives perdrait l'information dans deux de ces
quatre cas. C'est pourquoi les deux axes sont saisis séparément.

OÙ SE QUALIFIE LE POTENTIEL
Au niveau du BS composite issu de A₃, pas au niveau du noyau atomique.

POURQUOI C'EST CENTRAL
Un BS enseignant pour BioCraft et SkillCraft doit être DOUBLEMENT QUALIFIÉ :
formellement propre (les trois places) et potentiellement performatif (aucun
mode d'exclusion constaté).`,
  },
  {
    cle: 'modes-exclusion',
    titre: "Les modes d'exclusion : ne jamais juger positivement",
    ordre: 75,
    contenu: `Le formalisme ne produit jamais une valeur positive. La valeur relève du
marché, qui lui est extérieur. Ce que le formalisme produit est un STATUT PAR
DÉFAUT : un BS est potentiellement performatif tant qu'aucune clause
d'exclusion ne s'applique à lui.

LA DÉRIVATION
C'est une négation par l'échec, la même structure que la dérivation de force
du moteur Horn :

    non_valorisable             :- objet_sans_rarete.
    non_valorisable             :- sans_chaine_finalite.
    non_valorisable             :- <mode ultérieur>.
    potentiellement_performatif :- not non_valorisable.

VOTRE GESTE
Vous ne jugez jamais positivement. Vous CONSTATEZ DES EXCLUSIONS, ou vous
n'en constatez pas. Le statut se dérive tout seul et n'est jamais saisissable.
C'est un travail plus rapide, plus sûr, moins exposé au doute que d'évaluer un
potentiel — et c'est ce geste-là qui sera transmis au modèle.

LES DEUX MODES ÉTABLIS

objet_sans_rarete — l'objet sur lequel porte le BS est universellement
disponible ou banal au point qu'aucune rareté n'est concevable, quelle que
soit la qualité de sa description. Cas de référence : la distribution d'eau
du robinet. Le texte peut être impeccable, le tiers nommé, la chaîne de
finalité explicite — le BS reste sans valeur possible sur un marché.

sans_chaine_finalite — l'acte n'est inscrit dans aucun objectif exprimé. Le
BS existe formellement mais ne contribue à rien d'identifiable. Cas de
référence : faire une typologie de virus pour le laboratoire lambda.

LE MODE OUVERT
autre — pour un mode rencontré et pas encore nommé. Il exige un LIBELLÉ
PROPOSÉ en plus de la justification. Nommez ce que vous croyez avoir
rencontré, même maladroitement : les libellés qui reviennent seront promus en
modes de premier rang.

POURQUOI CETTE INFORMATION NE PEUT VENIR QUE DE VOUS
Aucune analyse de surface ne sépare « gérer la distribution d'eau potable »
de « gérer la distribution d'un principe actif sous contrainte ANSM ».
Structure syntaxique identique, marquages identiques, même allure de noyau
bien formé. Le découpeur ne peut pas les distinguer, le classifieur non plus :
il n'existe aucun signal de surface pour cela. Le jugement porte sur la rareté
POSSIBLE de l'objet, ce qui suppose une connaissance du monde professionnel
que la chaîne de caractères ne contient pas.

L'assistant est raisonnablement fiable sur sans_chaine_finalite, qui se lit
dans le texte. Il l'est beaucoup moins sur objet_sans_rarete. Sur ce mode,
sa proposition n'a pas l'autorité qu'elle a ailleurs.

LA RÈGLE DE COHÉRENCE
Si l'inscription est « atomise », le mode sans_chaine_finalite est ajouté
automatiquement. Si vous le retirez, l'atelier signale l'incohérence sans
bloquer : c'est alors l'inscription qu'il faut réviser.

LA MORPHOLOGIE SE DÉCOUVRE PAR SES BORNES
Le jeu de modes n'est pas figé. Ce que peut être un BS potentiellement
performatif se dessine à mesure qu'on rencontre ce qu'il ne peut pas être.
Chaque « autre » bien nommé fait avancer cette découverte.`,
  },
  {
    cle: 'couple-aa',
    titre: 'Le couple annotateur-assistant',
    ordre: 80,
    contenu: `L'unité de travail dans l'atelier n'est ni l'annotateur seul ni l'assistant
seul. C'est LE COUPLE AA. Chaque décision d'annotation est le produit du
dialogue entre les deux.

CE QUE FAIT L'ASSISTANT
Il propose une qualification et la justifie. Il rappelle les règles
d'application. Il pose
les questions qu'un noyau ambigu appelle. Il signale les incohérences avec les
cas déjà traités. Il porte la compétence encyclopédique — connaître les
méthodes, les procédés, les expertises qui structurent les métiers.

CE QUE FAIT L'ANNOTATEUR
Il décide. Il est souverain. Il peut passer outre les propositions de
l'assistant.

MAIS TOUT ÉCART DOIT ÊTRE EXPLICITÉ
Quand l'annotateur décide autrement que ce que propose l'assistant, il formule
pourquoi. Cette explicitation est consignée. Elle a trois vertus : elle
maintient l'annotateur dans la vigilance, elle enrichit la mémoire
opérationnelle, et un nombre significatif d'écarts sur un même point signale
qu'une règle doit être révisée.

L'atelier BLOQUE la sauvegarde tant qu'un écart détecté n'est pas explicité.
C'est volontaire.`,
  },
  {
    cle: 'les-manques',
    titre: 'Les manques : la sortie la plus précieuse',
    ordre: 90,
    contenu: `Le classement des noyaux n'est pas la finalité première de l'atelier.

CE QUE L'ATELIER PRODUIT DE PLUS PRÉCIEUX, C'EST L'IDENTIFICATION DE CE QUI
MANQUE pour qu'un BS soit correctement formé.

Un BS peut être bien formé au sens du formalisme et rester sans signification
évidente — parce qu'il provient d'une découpe déconnectée de son contexte. La
question n'est alors pas « comment le classer » mais « quelle information
aurait-il fallu pour conclure ».

POURQUOI C'EST CENTRAL
Chaque manque consigné, avec la question que BioCraft devrait poser pour le
combler, constitue le jeu d'entraînement de l'assistant amont. À terme, le
répertoire des manques donne la liste des questions que BioCraft doit savoir
poser à un utilisateur pour que sa matière devienne qualifiable.

LES TYPES DE MANQUE
contexte_projet, precision_acte, perimetre, resultat_mesurable, tiers_absent,
tiers_implicite, finalite_absente, datation, procede_non_nomme, echelle.

TOUJOURS FORMULER LA QUESTION
Un manque sans sa question est à moitié perdu. « Le tiers n'est pas nommé »
est un constat. « Pour quelle entreprise ou quel client cette mission a-t-elle
été menée ? » est un enseignement.`,
  },
  {
    cle: 'incrementalite',
    titre: "L'incrémentalité comme mode d'évolution",
    ordre: 100,
    contenu: `L'atelier n'est pas une machine qu'on construit une fois et qu'on met en
production. C'est un système qui se construit EN MÊME TEMPS QU'IL TRAVAILLE.

Chaque cas nouveau qualifié enrichit le catalogue. Chaque cas litigieux
résolu affine les règles. Chaque modification de ce manuel précise les
règles d'application — le formalisme 3A lui-même, lui, ne bouge pas.

Cette incrémentalité n'est pas un choix technique parmi d'autres. Elle est
structurellement nécessaire — l'approche par qualification humaine assistée ne
peut se stabiliser qu'à mesure qu'elle rencontre les cas réels.

LES TROIS QUESTIONS DE TOUT CHANGEMENT
Toute évolution de ce manuel doit porter :
  QUOI     — ce qui change, précisément. Pas une formulation générale, mais
             la description exacte : un champ ajouté, une règle reformulée,
             une catégorie créée.
  OÙ       — le lieu du changement : le schéma d'annotation, le processus de
             qualification, la formation de l'assistant, l'interface, ce
             manuel.
  POURQUOI — la raison. Un cas qui n'était pas couvert, une incohérence
             détectée, une catégorie qui n'existait pas au début. La raison
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
Le couple AA doit être parfaitement éduqué à l'approche 3A. Elle n'est pas un
préalable une fois pour toutes : c'est un état continu. Chaque évolution de
l'approche demande de remettre à jour la formation des deux membres du couple
— ce manuel pour l'humain, le prompt système pour l'assistant.

LE PROCESSUS
L'approche doit être systématique. Le même noyau doit être qualifié de la même
manière deux fois à un mois d'intervalle, quel que soit le contexte du moment.

LA RIGUEUR
Les décisions doivent tenir. Un cas litigieux tranché reste tranché, sauf si
un nouveau critère émerge qui justifie de le retrancher. La rigueur est le
respect des décisions passées comme précédents, et l'explication claire quand
on s'en écarte.

LA CONSIGNATION
Tout ce qui se passe dans l'atelier est consigné : les décisions avec leur
schéma structuré, les conversations complètes, les évolutions du manuel, les
cas litigieux avec leur résolution. Rien n'est perdu, tout peut être repris.`,
  },
];

async function main() {
  console.log(`-> Seed du manuel vivant : ${SECTIONS.length} sections`);

  const QUOI     = 'Creation des sections du formalisme et de ses regles d application.';
  const OU       = 'Manuel vivant de l\'atelier, sections de fond.';
  const POURQUOI = 'Amorcage : le manuel etait vide, la formation du couple AA '
                 + 'exige un socle ecrit. Contenu issu de '
                 + 'complement_transmission_atelier.md (partie 1) du 17/09/2026 et de '
                 + 'specification_modes_exclusion.md v1.0 du 22/09/2026.';

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
