-- Migration 014 : economie Talent + tracabilite amont + sessions
-- version 014 | 2026-09-11 | PostgreSQL 9.6+
-- Depends on 011_users_management.sql
-- Pure ASCII. No BEGIN/COMMIT.

-- Compteur de sessions (pour didactisme adaptatif : effacement progressif)
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS sessions_count INT NOT NULL DEFAULT 0;

-- Tracabilite amont : chaque BS extrait peut pointer vers sa phrase source
ALTER TABLE bahyo_portfolio_bs_extrait ADD COLUMN IF NOT EXISTS source_id UUID;
ALTER TABLE bahyo_portfolio_bs_extrait ADD COLUMN IF NOT EXISTS source_phrase TEXT;

-- FK optionnelle vers bahyo_source (ON DELETE SET NULL pour ne pas perdre les BS)
ALTER TABLE bahyo_portfolio_bs_extrait DROP CONSTRAINT IF EXISTS bs_extrait_source_fk;
ALTER TABLE bahyo_portfolio_bs_extrait ADD CONSTRAINT bs_extrait_source_fk
  FOREIGN KEY (source_id) REFERENCES bahyo_source(id) ON DELETE SET NULL;

-- Cote projetee : preferences utilisateur (marche cible par BS, cote demandee)
ALTER TABLE bahyo_portfolio_bs_extrait ADD COLUMN IF NOT EXISTS marche_cible TEXT;
ALTER TABLE bahyo_portfolio_bs_extrait ADD COLUMN IF NOT EXISTS cote_demandee NUMERIC;

-- Table historique des consommations Talent (audit + affichage historique wallet)
CREATE TABLE IF NOT EXISTS bahyo_talent_mouvement (
  id            UUID PRIMARY KEY DEFAULT bahyo_uuid(),
  user_id       UUID NOT NULL REFERENCES bahyo_user(id) ON DELETE CASCADE,
  type          TEXT NOT NULL, -- 'CREDIT_INITIAL' | 'GAIN_BS_VALIDE' | 'COUT_BSCRAFT_A3' | 'COUT_BSCRAFT_REFORMUL' | 'COUT_BSCRAFT_ATTESTATION' | 'COUT_ANTICHAMBRE_COMPARABLES' | 'COUT_ANTICHAMBRE_SIMULATION' | 'GAIN_IPO' | 'AJUSTEMENT_ADMIN'
  montant       INT NOT NULL,  -- positif = credit, negatif = debit
  solde_apres   INT NOT NULL,
  reference_id  UUID,          -- id du BS ou de l'action liee
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_talent_mvt_user ON bahyo_talent_mouvement(user_id, created_at DESC);

-- Bareme par defaut (peut etre override dans bahyo_config)
INSERT INTO bahyo_config (cle, valeur) VALUES
  ('talent_credit_initial',           '200'),
  ('talent_gain_bs_valide',           '50'),
  ('talent_cout_bscraft_a3',          '8'),
  ('talent_cout_bscraft_reformuler',  '3'),
  ('talent_cout_bscraft_attestation', '12'),
  ('talent_cout_antichambre_compar',  '20'),
  ('talent_cout_antichambre_simul',   '15'),
  ('talent_cout_antichambre_optim',   '50')
ON CONFLICT (cle) DO NOTHING;

-- Autorisations
GRANT SELECT, INSERT, UPDATE, DELETE ON bahyo_user TO qiyo9734_postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON bahyo_portfolio_bs_extrait TO qiyo9734_postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON bahyo_talent_mouvement TO qiyo9734_postgres;
