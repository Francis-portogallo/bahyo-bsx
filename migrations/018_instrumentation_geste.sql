-- Migration 018 : instrumentation du geste d'annotation
-- version 018 | 2026-09-22 | PostgreSQL 9.6+
-- Compatible phpPgAdmin : aucun bloc DO.
-- Depends on 017_modes_exclusion.sql
-- Pure ASCII. No BEGIN/COMMIT.
--
-- OBJET
-- Le schema d'annotation est systematique ; la traversee ne l'etait pas. Rien
-- n'obligeait a qualifier un noyau de la meme maniere deux fois, comme le
-- demande le cahier de conception en 4.2.
--
-- On instrumente donc le geste plutot que de le faire declarer. Une case a
-- cocher « avez-vous consulte les cas similaires ? » se coche sans consulter ;
-- le systeme, lui, SAIT si le panneau a ete deplie.
--
-- PRINCIPE : contraindre la traversee, jamais la conclusion. Rien ici ne
-- bloque ni n'oriente une decision. On consigne ce qui a ete fait.
--
-- CE QUI EST OBSERVE, ET CE QUI NE L'EST PAS
-- Seuls les actes reellement verifiables sont consignes : sections du
-- formalisme ouvertes, cas similaires deplies, assistant sollicite, tours de
-- dialogue, ordre de traversee des places, durees. La lecture du texte source
-- N'EST PAS consignee : le panneau est affiche en permanence, en inferer la
-- lecture serait une fiction — et une fiction dans les donnees d'entrainement
-- est pire qu'une absence.
--
-- PORTEE
-- Cette instrumentation decrit la METHODE, pas la personne. Elle sert a
-- etablir la regularite du parcours et a enrichir les exemples transmis au
-- SLM : « l'annotateur a consulte telle section, sollicite l'assistant, puis
-- diverge pour cette raison » enseigne davantage que l'annotation nue.

-- ============================================================
-- Journal d'actes
-- ============================================================
-- Un acte par ligne, detail en JSON : extensible sans migration.

CREATE TABLE IF NOT EXISTS bahyo_atelier_observation (
  id             UUID PRIMARY KEY DEFAULT bahyo_uuid(),
  annotateur_id  UUID REFERENCES bahyo_user(id) ON DELETE SET NULL,
  experience_id  UUID REFERENCES bahyo_atelier_experience(id) ON DELETE CASCADE,
  noyau_id       UUID REFERENCES bahyo_atelier_noyau(id) ON DELETE CASCADE,
  groupe_id      UUID REFERENCES bahyo_atelier_groupe(id) ON DELETE CASCADE,
  place          TEXT,
  acte           TEXT NOT NULL,
  -- Actes reconnus (extensible : aucune contrainte figee) :
  --   noyau_ouvert            ouverture d'un noyau pour qualification
  --   place_changee           bascule A1 -> A2 -> A3 (detail: de, vers)
  --   similaires_consultes    panneau des cas similaires deplie (detail: n)
  --   similaire_ouvert        un cas precis consulte (detail: annotation_id)
  --   formalisme_ouvert       tiroir du formalisme ouvert
  --   formalisme_section      section depliee (detail: section_cle)
  --   formalisme_recherche    recherche dans le formalisme (detail: terme)
  --   proposition_demandee    assistant sollicite pour une proposition
  --   dialogue_tour           un echange avec l'assistant
  --   manque_signale          un manque consigne (detail: type, detecte_par)
  --   exclusion_posee         un mode d'exclusion constate (detail: mode)
  --   annotation_enregistree  sauvegarde (detail: statut, regime, ecart)
  detail         JSONB,
  session_cle    TEXT,     -- regroupe les actes d'une meme seance de travail
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_atelier_obs_noyau
  ON bahyo_atelier_observation(noyau_id, created_at);
CREATE INDEX IF NOT EXISTS idx_atelier_obs_exp
  ON bahyo_atelier_observation(experience_id, created_at);
CREATE INDEX IF NOT EXISTS idx_atelier_obs_acte
  ON bahyo_atelier_observation(acte, created_at);
CREATE INDEX IF NOT EXISTS idx_atelier_obs_annotateur
  ON bahyo_atelier_observation(annotateur_id, created_at);
CREATE INDEX IF NOT EXISTS idx_atelier_obs_session
  ON bahyo_atelier_observation(session_cle, created_at);

-- ============================================================
-- Synthese par noyau : le parcours reconstitue
-- ============================================================
-- Ce que l'annotateur a effectivement fait avant de conclure, par noyau.
-- La duree part de la premiere ouverture et s'arrete au dernier
-- enregistrement : elle mesure le temps du cas, pas le temps de saisie.

CREATE OR REPLACE VIEW bahyo_atelier_parcours AS
SELECT o.noyau_id,
       o.annotateur_id,
       MIN(o.created_at) FILTER (WHERE o.acte = 'noyau_ouvert')           AS ouvert_a,
       MAX(o.created_at) FILTER (WHERE o.acte = 'annotation_enregistree') AS conclu_a,
       EXTRACT(EPOCH FROM (
         MAX(o.created_at) FILTER (WHERE o.acte = 'annotation_enregistree')
         - MIN(o.created_at) FILTER (WHERE o.acte = 'noyau_ouvert')
       ))                                                                 AS duree_s,
       COUNT(*)                                                           AS nb_actes,
       COUNT(*) FILTER (WHERE o.acte = 'similaires_consultes')   AS n_similaires,
       COUNT(*) FILTER (WHERE o.acte = 'formalisme_section')     AS n_formalisme,
       COUNT(*) FILTER (WHERE o.acte = 'proposition_demandee')   AS n_propositions,
       COUNT(*) FILTER (WHERE o.acte = 'dialogue_tour')          AS n_tours,
       COUNT(*) FILTER (WHERE o.acte = 'manque_signale')         AS n_manques,
       COUNT(*) FILTER (WHERE o.acte = 'annotation_enregistree') AS n_enregistrements,
       COALESCE(
         array_agg(DISTINCT o.detail->>'section_cle')
           FILTER (WHERE o.acte = 'formalisme_section'
                     AND o.detail->>'section_cle' IS NOT NULL),
         ARRAY[]::TEXT[]
       )                                                         AS sections_lues,
       COALESCE(
         array_agg(o.place ORDER BY o.created_at)
           FILTER (WHERE o.acte = 'annotation_enregistree' AND o.place IS NOT NULL),
         ARRAY[]::TEXT[]
       )                                                         AS ordre_places
FROM bahyo_atelier_observation o
WHERE o.noyau_id IS NOT NULL
GROUP BY o.noyau_id, o.annotateur_id;

-- ============================================================
-- Vocabulaire de configuration
-- ============================================================
INSERT INTO bahyo_config (cle, valeur) VALUES
  ('atelier_actes_observes',
   'noyau_ouvert,place_changee,similaires_consultes,similaire_ouvert,'
   || 'formalisme_ouvert,formalisme_section,formalisme_recherche,'
   || 'proposition_demandee,dialogue_tour,manque_signale,exclusion_posee,'
   || 'annotation_enregistree')
ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur;

-- ============================================================
-- Autorisations
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON bahyo_atelier_observation TO qiyo9734_postgres;
GRANT SELECT                         ON bahyo_atelier_parcours    TO qiyo9734_postgres;
