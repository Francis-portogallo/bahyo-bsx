-- Migration 017 : modes d'exclusion et potentiel performatif derive
-- version 017 | 2026-09-22 | PostgreSQL 9.6+
-- Depends on 016_atelier_recette.sql
-- Pure ASCII. No BEGIN/COMMIT.
--
-- Applique specification_modes_exclusion.md v1.0 du 22/09/2026 :
--   4.1  potentiel_performatif -> inscription_finalite (renommage)
--   4.3  modes_exclusion : TABLE dediee (et non JSONB) pour permettre
--        l'agregation des 'autre' demandee en 4.4
--   4.5  potentiellement_performatif : CALCULE, jamais stocke
--        (PG 9.6 n'a pas de colonnes generees ; une vue le fournit)
--   4.6  inscription_finalite = 'atomise' -> mode 'sans_chaine_finalite'
--        ajoute automatiquement, annotateur 'systeme'
--   7    champ_pratique : texte libre facultatif
--
-- Terminologie : « doctrine » est proscrit. Le FORMALISME 3A designe le
-- systeme (trois places, agglomeration par A3) et il est stable ; ce qui
-- evolue sont les REGLES D'APPLICATION consignees dans le manuel.

-- ============================================================
-- 4.1 — Renommage potentiel_performatif -> inscription_finalite
-- ============================================================
-- Le champ n'a jamais pretendu dire autre chose que l'inscription du
-- groupe dans une chaine de finalite. Valeurs inchangees.

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'bahyo_atelier_groupe'
               AND column_name = 'potentiel_performatif')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'bahyo_atelier_groupe'
               AND column_name = 'inscription_finalite')
  THEN
    ALTER TABLE bahyo_atelier_groupe
      RENAME COLUMN potentiel_performatif TO inscription_finalite;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'bahyo_atelier_groupe_historique'
               AND column_name = 'potentiel_performatif')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'bahyo_atelier_groupe_historique'
               AND column_name = 'inscription_finalite')
  THEN
    ALTER TABLE bahyo_atelier_groupe_historique
      RENAME COLUMN potentiel_performatif TO inscription_finalite;
  END IF;
END
$mig$;

-- Filet : si la colonne n'existait sous aucun des deux noms
ALTER TABLE bahyo_atelier_groupe
  ADD COLUMN IF NOT EXISTS inscription_finalite TEXT;
ALTER TABLE bahyo_atelier_groupe_historique
  ADD COLUMN IF NOT EXISTS inscription_finalite TEXT;

DROP INDEX IF EXISTS idx_atelier_groupe_perf;
CREATE INDEX IF NOT EXISTS idx_atelier_groupe_insc
  ON bahyo_atelier_groupe(inscription_finalite, statut);

-- ============================================================
-- 7 — Champ de pratique (facultatif, texte libre)
-- ============================================================
ALTER TABLE bahyo_atelier_groupe
  ADD COLUMN IF NOT EXISTS champ_pratique TEXT;
ALTER TABLE bahyo_atelier_groupe_historique
  ADD COLUMN IF NOT EXISTS champ_pratique TEXT;

-- ============================================================
-- 4.3 — Modes d'exclusion : TABLE dediee
-- ============================================================
-- Choix assume contre le JSONB suggere par la specification : la section
-- 4.4 demande de reperer les modes 'autre' recurrents pour les promouvoir.
-- Avec une table, c'est un GROUP BY ; avec du JSONB sur PG 9.6, c'est
-- penible et lent. L'export produit bien la liste d'objets demandee.

CREATE TABLE IF NOT EXISTS bahyo_atelier_mode_exclusion (
  id              UUID PRIMARY KEY DEFAULT bahyo_uuid(),
  groupe_id       UUID NOT NULL REFERENCES bahyo_atelier_groupe(id) ON DELETE CASCADE,
  mode            TEXT NOT NULL,   -- objet_sans_rarete | sans_chaine_finalite | autre | (extensible)
  libelle_propose TEXT,            -- obligatoire si mode = 'autre'
  justification   TEXT NOT NULL,
  annotateur_id   UUID REFERENCES bahyo_user(id) ON DELETE SET NULL,
  pose_par        TEXT NOT NULL DEFAULT 'annotateur',  -- annotateur | systeme | assistant
  version_manuel  INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (groupe_id, mode)
);

CREATE INDEX IF NOT EXISTS idx_atelier_modexcl_groupe
  ON bahyo_atelier_mode_exclusion(groupe_id);
CREATE INDEX IF NOT EXISTS idx_atelier_modexcl_mode
  ON bahyo_atelier_mode_exclusion(mode);
-- Sert au reperage des 'autre' recurrents a promouvoir (4.4)
CREATE INDEX IF NOT EXISTS idx_atelier_modexcl_autre
  ON bahyo_atelier_mode_exclusion(libelle_propose)
  WHERE mode = 'autre';

-- ============================================================
-- 4.4 — Registre des modes : permet la promotion sans migration
-- ============================================================
CREATE TABLE IF NOT EXISTS bahyo_atelier_mode_registre (
  mode            TEXT PRIMARY KEY,
  libelle         TEXT NOT NULL,
  definition      TEXT,
  actif           BOOLEAN NOT NULL DEFAULT TRUE,
  -- tracabilite de la promotion d'un 'autre' en mode de premier rang
  promu_depuis    TEXT,            -- libelle_propose d'origine
  promu_le        TIMESTAMPTZ,
  promu_par       UUID REFERENCES bahyo_user(id) ON DELETE SET NULL,
  quoi            TEXT,
  ou              TEXT,
  pourquoi        TEXT,
  ordre           INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO bahyo_atelier_mode_registre (mode, libelle, definition, ordre) VALUES
  ('objet_sans_rarete',
   'Objet sans rarete concevable',
   'L''objet sur lequel porte le BS est universellement disponible ou banal '
   || 'au point qu''aucune rarete n''est concevable, independamment de la '
   || 'qualite de sa description. Exemple de reference : la distribution '
   || 'd''eau du robinet.',
   10),
  ('sans_chaine_finalite',
   'Aucune chaine de finalite',
   'L''acte n''est inscrit dans aucun objectif exprime. Le BS existe '
   || 'formellement mais ne contribue a rien d''identifiable. Exemple de '
   || 'reference : faire une typologie de virus pour le laboratoire lambda '
   || '(le « canada dry » du BS).',
   20),
  ('autre',
   'Autre mode (a nommer)',
   'Mode rencontre a l''usage et pas encore nomme. Exige un libelle propose '
   || 'et une justification. Les libelles recurrents ont vocation a etre '
   || 'promus en mode de premier rang.',
   99)
ON CONFLICT (mode) DO NOTHING;

-- ============================================================
-- 4.5 — Vue de derivation : potentiellement_performatif
-- ============================================================
-- JAMAIS stocke. Un BS est potentiellement performatif tant qu'aucune
-- clause d'exclusion ne s'applique — negation par l'echec, meme structure
-- que la derivation de force de bahyo_horn.py.
--
--   non_valorisable             :- objet_sans_rarete.
--   non_valorisable             :- sans_chaine_finalite.
--   non_valorisable             :- <mode ulterieur>.
--   potentiellement_performatif :- not non_valorisable.

CREATE OR REPLACE VIEW bahyo_atelier_groupe_statut AS
SELECT g.id                AS groupe_id,
       g.experience_id,
       g.inscription_finalite,
       g.champ_pratique,
       g.statut,
       COUNT(m.id)         AS nb_exclusions,
       COUNT(m.id) = 0     AS potentiellement_performatif,
       COALESCE(
         array_agg(m.mode ORDER BY m.created_at) FILTER (WHERE m.id IS NOT NULL),
         ARRAY[]::TEXT[]
       )                   AS modes
FROM bahyo_atelier_groupe g
LEFT JOIN bahyo_atelier_mode_exclusion m ON m.groupe_id = g.id
GROUP BY g.id;

-- ============================================================
-- 4.6 — Coherence : atomise implique sans_chaine_finalite
-- ============================================================
-- Pose le mode automatiquement a l'insertion comme a la modification.
-- Le retrait manuel de l'entree reste possible : l'interface signale
-- l'incoherence sans bloquer, comme le demande la specification.

CREATE OR REPLACE FUNCTION bahyo_atelier_atomise_exclusion() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.inscription_finalite = 'atomise' THEN
    INSERT INTO bahyo_atelier_mode_exclusion
      (groupe_id, mode, justification, pose_par, version_manuel)
    VALUES (
      NEW.id, 'sans_chaine_finalite',
      'Ajoute automatiquement : l''inscription du groupe est qualifiee '
      || '« atomise », donc aucune chaine de finalite n''est identifiable.',
      'systeme', NEW.version_manuel
    )
    ON CONFLICT (groupe_id, mode) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_atelier_atomise_ins ON bahyo_atelier_groupe;
CREATE TRIGGER trg_atelier_atomise_ins
  AFTER INSERT ON bahyo_atelier_groupe
  FOR EACH ROW WHEN (NEW.inscription_finalite = 'atomise')
  EXECUTE PROCEDURE bahyo_atelier_atomise_exclusion();

DROP TRIGGER IF EXISTS trg_atelier_atomise_upd ON bahyo_atelier_groupe;
CREATE TRIGGER trg_atelier_atomise_upd
  AFTER UPDATE ON bahyo_atelier_groupe
  FOR EACH ROW
  WHEN (NEW.inscription_finalite = 'atomise'
        AND OLD.inscription_finalite IS DISTINCT FROM NEW.inscription_finalite)
  EXECUTE PROCEDURE bahyo_atelier_atomise_exclusion();

-- Rattrapage sur l'existant
INSERT INTO bahyo_atelier_mode_exclusion
  (groupe_id, mode, justification, pose_par, version_manuel)
SELECT g.id, 'sans_chaine_finalite',
       'Ajoute automatiquement a la migration 017 : inscription « atomise ».',
       'systeme', g.version_manuel
FROM bahyo_atelier_groupe g
WHERE g.inscription_finalite = 'atomise'
ON CONFLICT (groupe_id, mode) DO NOTHING;

-- ============================================================
-- Historique des groupes : embarquer les nouveaux champs
-- ============================================================
ALTER TABLE bahyo_atelier_groupe_historique
  ADD COLUMN IF NOT EXISTS modes_exclusion JSONB;

CREATE OR REPLACE FUNCTION bahyo_atelier_groupe_hist() RETURNS TRIGGER AS $fn$
DECLARE
  membres JSONB;
  modes   JSONB;
BEGIN
  SELECT COALESCE(json_agg(noyau_id)::jsonb, '[]'::jsonb) INTO membres
  FROM bahyo_atelier_groupe_noyau WHERE groupe_id = OLD.id;

  SELECT COALESCE(json_agg(json_build_object(
           'mode', mode, 'libelle_propose', libelle_propose,
           'justification', justification, 'pose_par', pose_par
         ) ORDER BY created_at)::jsonb, '[]'::jsonb) INTO modes
  FROM bahyo_atelier_mode_exclusion WHERE groupe_id = OLD.id;

  INSERT INTO bahyo_atelier_groupe_historique (
    groupe_id, experience_id, revision, tiers, tiers_source, finalite_exprimee,
    inscription_finalite, champ_pratique, libelle, justification, annotateur_id,
    origine, statut, version_manuel, noyau_ids, modes_exclusion,
    valide_de, valide_a
  ) VALUES (
    OLD.id, OLD.experience_id, OLD.revision, OLD.tiers, OLD.tiers_source,
    OLD.finalite_exprimee, OLD.inscription_finalite, OLD.champ_pratique,
    OLD.libelle, OLD.justification, OLD.annotateur_id, OLD.origine, OLD.statut,
    OLD.version_manuel, membres, modes, OLD.updated_at, NOW()
  );
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_atelier_groupe_hist ON bahyo_atelier_groupe;
CREATE TRIGGER trg_atelier_groupe_hist
  BEFORE UPDATE ON bahyo_atelier_groupe
  FOR EACH ROW
  WHEN (OLD.tiers                IS DISTINCT FROM NEW.tiers
     OR OLD.tiers_source         IS DISTINCT FROM NEW.tiers_source
     OR OLD.finalite_exprimee    IS DISTINCT FROM NEW.finalite_exprimee
     OR OLD.inscription_finalite IS DISTINCT FROM NEW.inscription_finalite
     OR OLD.champ_pratique       IS DISTINCT FROM NEW.champ_pratique
     OR OLD.libelle              IS DISTINCT FROM NEW.libelle
     OR OLD.justification        IS DISTINCT FROM NEW.justification
     OR OLD.statut               IS DISTINCT FROM NEW.statut)
  EXECUTE PROCEDURE bahyo_atelier_groupe_hist();

-- ============================================================
-- Vocabulaire de configuration
-- ============================================================
DELETE FROM bahyo_config WHERE cle = 'atelier_potentiel_perf';

INSERT INTO bahyo_config (cle, valeur) VALUES
  ('atelier_inscription_finalite', 'porte,latent,atomise'),
  ('atelier_modes_exclusion',      'objet_sans_rarete,sans_chaine_finalite,autre'),
  ('atelier_pose_par',             'annotateur,systeme,assistant')
ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur;

-- ============================================================
-- Autorisations
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON bahyo_atelier_mode_exclusion TO qiyo9734_postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON bahyo_atelier_mode_registre  TO qiyo9734_postgres;
GRANT SELECT                         ON bahyo_atelier_groupe_statut  TO qiyo9734_postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON bahyo_atelier_groupe         TO qiyo9734_postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON bahyo_atelier_groupe_historique TO qiyo9734_postgres;
