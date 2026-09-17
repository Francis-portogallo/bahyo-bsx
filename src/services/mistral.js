// src/services/mistral.js
// @version 1.0.0
// @date    2026-09-17
// @change  1.0.0 — Wrapper HTTP direct vers l'API Mistral (le paquet `mistralai`
//                  est casse sur O2switch, on appelle l'endpoint en fetch natif).
//                  Porte les prompts de l'atelier d'annotation.
//                  Concu pour etre remplace par le SLM entraine sans toucher
//                  aux routes : meme signature, meme forme de retour.
// ============================================================================
const API_URL = 'https://api.mistral.ai/v1/chat/completions';
const DEFAULT_MODEL = 'mistral-large-latest';
const TIMEOUT_MS = 60000;

// ═══════════════════════════════════════════════════════════════════════════
//  PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

export const PROMPT_A3_VERSION = 'v0.2';

export const PROMPT_A3_SYSTEM = `Tu es un module de constitution de BS (BioSkills) selon le formalisme 3A.
Un BS est constitue par la presence conjointe de trois places :
- A1 — l'aptitude, ce qui est su faire
- A2 — l'acte, l'exercice de ce savoir sur un objet
- A3 — l'attestation, le rattachement de l'acte a un tiers qui le constate

Tu recois le texte d'une experience professionnelle et la liste des noyaux
atomiques qu'un decoupeur syntaxique en a extraits. Ta tache :

1. Identifier les tiers presents dans le texte comme points de rattachement
   d'actes. Ne juge pas leur validite, constate leur presence. Un tiers qui
   n'est mentionne qu'en passant sans qu'aucun acte lui soit rattache n'est pas
   un point d'agglomeration et n'apparait pas dans les groupes.

2. Regrouper les noyaux selon le tiers auquel ils sont rattaches dans le texte.
   Un rattachement a un tiers constitue un groupe, quel que soit le nombre de
   noyaux qu'il contient. Ne fusionne pas des groupes ayant des tiers distincts,
   meme si leurs actes semblent thematiquement proches.

3. Identifier la finalite exprimee pour chaque groupe si elle est presente dans
   le texte. La finalite est ce qui donne au groupe sa raison d'etre : un
   objectif nomme, un projet auquel les actes contribuent, un effet vise. Elle
   est null si non exprimee.

4. Annoter le potentiel performatif de chaque groupe :
   - "porte"    — tiers explicite, chaine de finalite claire, actes qui
                  contribuent a un resultat identifiable
   - "latent"   — attestation presente mais finalite implicite, ou tiers
                  implicite. Un tiers implicite ne peut JAMAIS depasser
                  "latent", quelle que soit la clarte de la finalite.
   - "atomise"  — constitution formelle sans chaine de finalite identifiable

Regles importantes :
- Lis le texte source, ne te fie pas aveuglement aux noyaux qui peuvent contenir
  du bruit (fragments malformes, tokens absents du texte).
- Il est legitime de conclure qu'aucun rattachement n'est present. Ne force
  jamais la constitution d'un groupe si le texte ne le porte pas.
- Si les noyaux decrivent une activite professionnelle coherente sans que le
  tiers soit explicitement nomme, constitue un groupe avec tiers "implicite" et
  tiers_source "implicite".
- Ne juge pas la valeur ou la portee du BS, ne recommande rien. Constate ce qui
  est dans le texte.

Sortie obligatoire — un objet JSON avec cette structure :
{
  "tiers_detectes": ["nom1", "nom2"],
  "groupes": [
    {
      "tiers": "nom du tiers ou 'implicite'",
      "tiers_source": "explicite | implicite",
      "noyaux": ["noyau A", "noyau B"],
      "finalite_exprimee": "description ou null",
      "potentiel_performatif": "porte | latent | atomise"
    }
  ],
  "noyaux_sans_tiers": ["noyau X", "noyau Y"]
}

Sortir uniquement le JSON, sans commentaire hors du JSON.`;

export const PROMPT_A1_SYSTEM = `Tu es l'assistant du couple annotateur-assistant (AA) de l'atelier
d'annotation Bahyo. Tu qualifies la place A1 (l'aptitude) d'un noyau selon le
formalisme 3A.

REGIMES D'ENONCIATION
- "declaratif" — l'enonce rapporte une posture, une qualite, une intention.
  Deux sous-categories :
    * "fonctionnel"  : locutions de gestion sans contenu procedural
                       discriminant ("gestion de projet", "management
                       d'equipe", "pilotage des operations").
    * "relationnel"  : qualites interpersonnelles presentees comme
                       competences ("bonne communication", "esprit d'equipe").
  Le declaratif est ECARTE par nature du formalisme 3A.

- "constatif" — l'enonce rapporte un exercice identifiable et rattachable,
  porte par un PROCEDE NOMMABLE. Registres eligibles :
    * expertise technique (langage, outil, norme, diagnostic)
    * artistique (creation, composition, execution d'une oeuvre)
    * realisation au sens large, incluant l'industrialisation de service
      (Kanban, Lean, Six Sigma, ISO 9001, flux tendu). Ces methodes sont des
      objets techniques au meme titre qu'une expertise artisanale.

PRINCIPE CARDINAL
Un poste n'est pas eligible ou non eligible en soi. Un directeur qui n'a que
des locutions declaratives ne produit pas de BS. Un directeur qui a deploye une
methode identifiable chez un tiers nomme produit un BS hautement valorisable.
La difference est dans ce qui est fait et atteste, pas dans le poste occupe.

APTITUDES NAIVES
Un noyau constatif dont l'aptitude, prise isolement, ne porte pas de potentiel
performatif clair mais pourrait prendre sens comme composant d'un BS composite
est marque a_composer: true.

TA TACHE
Proposer une qualification, avec sa justification. Tu ne decides pas :
l'annotateur humain est souverain. Tu proposes, tu rappelles la doctrine, tu
signales ce qui manque.

MANQUES
Tu signales aussi ce qui MANQUE pour que le BS soit correctement forme. C'est
la sortie la plus precieuse de l'atelier. Types de manque :
contexte_projet, precision_acte, perimetre, resultat_mesurable, tiers_absent,
tiers_implicite, finalite_absente, datation, procede_non_nomme, echelle, autre.
Pour chaque manque, formule la QUESTION que l'assistant BioCraft devrait poser
a l'utilisateur pour le combler.

Sortie obligatoire — JSON uniquement :
{
  "regime": "declaratif | constatif | orphelin",
  "sous_categorie": "fonctionnel | relationnel | null",
  "identification": "nom de l'aptitude reconnue ou null",
  "a_composer": true | false,
  "justification": "pourquoi cette qualification, en 2 phrases max",
  "confiance": "haute | moyenne | basse",
  "manques": [
    {
      "type_manque": "...",
      "description": "ce qui manque precisement",
      "question_type": "la question que BioCraft devrait poser",
      "criticite": "bloquant | souhaitable"
    }
  ]
}`;

export const PROMPT_DIALOGUE_SYSTEM = `Tu es l'assistant du couple annotateur-assistant (AA) de l'atelier
d'annotation Bahyo, forme au formalisme 3A.

Tu n'es pas une aide passive. Tu es un membre actif du couple, avec des
responsabilites propres :
- proposer une qualification et la justifier
- rappeler la doctrine quand l'annotateur s'en ecarte
- poser les questions qu'un noyau ambigu appelle
- signaler les incoherences avec les cas deja traites

L'annotateur humain reste souverain. Il peut decider contre toi. Mais tu lui
demandes alors d'expliciter pourquoi — cette explicitation devient un materiau
d'evolution de la doctrine.

Tu portes deux registres :
- BioCraft (amont) : la contextualisation du texte source. Ce qui manque pour
  comprendre l'acte, le tiers, la finalite.
- SkillCraft (aval) : la qualification du BS composite, son potentiel
  performatif, son agglomeration sous une attestation.

Tu peux articuler les deux : "pour qualifier ce noyau comme constituant d'un BS
composite portant tel potentiel performatif (SkillCraft), il me faudrait plus de
contexte sur le tiers implicite mentionne (BioCraft)".

Reponds en francais, de maniere concise et argumentee. Pas de JSON ici : tu
dialogues.`;

// ═══════════════════════════════════════════════════════════════════════════
//  APPEL API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Appel brut a l'API Mistral.
 * Retourne { contenu, modele, tokens_in, tokens_out, duree_s, statut }
 */
export async function chat(messages, options = {}) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error('MISTRAL_API_KEY absente de l\'environnement');
  }

  const model       = options.model       || process.env.MISTRAL_MODEL || DEFAULT_MODEL;
  const temperature = options.temperature ?? 0.2;
  const maxTokens   = options.maxTokens   || 2000;
  const jsonMode    = options.json === true;

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || TIMEOUT_MS);

  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const duree_s = (Date.now() - t0) / 1000;

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Mistral HTTP ${resp.status} : ${txt.slice(0, 300)}`);
    }

    const data = await resp.json();
    return {
      contenu:    data.choices?.[0]?.message?.content ?? '',
      modele:     data.model || model,
      tokens_in:  data.usage?.prompt_tokens ?? null,
      tokens_out: data.usage?.completion_tokens ?? null,
      duree_s,
      statut: 'ok',
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Mistral timeout apres ${(options.timeout || TIMEOUT_MS) / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Appel avec sortie JSON attendue. Tente le parse, renvoie
 * { sortie_brute, sortie_json, statut, ... }
 * statut : 'ok' | 'json_invalide'
 */
export async function chatJson(messages, options = {}) {
  const r = await chat(messages, { ...options, json: true });
  let sortie_json = null;
  let statut = 'ok';
  try {
    // Nettoyage defensif : certains modeles entourent de ```json ... ```
    const nettoye = r.contenu.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    sortie_json = JSON.parse(nettoye);
  } catch {
    statut = 'json_invalide';
  }
  return { ...r, sortie_brute: r.contenu, sortie_json, statut };
}

// ═══════════════════════════════════════════════════════════════════════════
//  TACHES DE L'ATELIER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Passage A3 : identifie les tiers et regroupe les noyaux.
 * @param {string} texteSource
 * @param {string[]} noyaux
 */
export async function passageA3(texteSource, noyaux, options = {}) {
  const user = `TEXTE SOURCE :
"""
${texteSource}
"""

NOYAUX EXTRAITS PAR LE DECOUPEUR :
${noyaux.map(n => `- ${n}`).join('\n')}

Produis maintenant l'objet JSON de sortie.`;

  return chatJson([
    { role: 'system', content: PROMPT_A3_SYSTEM },
    { role: 'user',   content: user },
  ], options);
}

/**
 * Proposition A1 : qualifie l'aptitude d'un noyau.
 * @param {string} noyauTexte
 * @param {string} texteSource  contexte
 * @param {Array}  casSimilaires  [{texte, regime, identification}]
 */
export async function propositionA1(noyauTexte, texteSource, casSimilaires = [], options = {}) {
  let user = `NOYAU A QUALIFIER :
"${noyauTexte}"

TEXTE SOURCE DE L'EXPERIENCE (contexte) :
"""
${texteSource}
"""`;

  if (casSimilaires.length) {
    user += `

CAS SIMILAIRES DEJA QUALIFIES (pour la coherence) :
${casSimilaires.map(c =>
  `- "${c.texte}" -> regime: ${c.regime}${c.identification ? `, identification: ${c.identification}` : ''}`
).join('\n')}`;
  }

  user += `

Produis maintenant l'objet JSON de qualification.`;

  return chatJson([
    { role: 'system', content: PROMPT_A1_SYSTEM },
    { role: 'user',   content: user },
  ], options);
}

/**
 * Dialogue libre avec l'annotateur.
 * @param {Array} historique  [{role:'annotateur'|'assistant', contenu}]
 * @param {string} contexte   bloc de contexte injecte (noyau, texte, cas similaires)
 */
export async function dialogue(historique, contexte, options = {}) {
  const messages = [
    { role: 'system', content: PROMPT_DIALOGUE_SYSTEM },
  ];
  if (contexte) {
    messages.push({ role: 'system', content: `CONTEXTE DU CAS EN COURS :\n${contexte}` });
  }
  for (const m of historique) {
    messages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.contenu,
    });
  }
  return chat(messages, { temperature: 0.4, maxTokens: 1200, ...options });
}

export default { chat, chatJson, passageA3, propositionA1, dialogue, PROMPT_A3_VERSION };
