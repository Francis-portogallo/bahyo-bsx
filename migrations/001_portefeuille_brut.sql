-- Migration 001 : portefeuille brut (Etage 1, extraction)
-- version 001 | 2026-08-24 | PostgreSQL 9.6+
-- Depends on 000_schema_base.sql (bahyo_uuid() must exist)
-- No BEGIN/COMMIT. No special characters. VECTOR replaced by TEXT.

-- ENUM des forces (idempotent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bahyo_force') THEN
    CREATE TYPE bahyo_force AS ENUM ('verifiee', 'potentielle', 'detaillee', 'candidat');
  END IF;
END$$;

-- Colonnes de provenance sur bahyo_portfolio_user
ALTER TABLE bahyo_portfolio_user
  ADD COLUMN IF NOT EXISTS contrat_version          TEXT,
  ADD COLUMN IF NOT EXISTS provenance_segmentation  TEXT,
  ADD COLUMN IF NOT EXISTS provenance_definition    TEXT,
  ADD COLUMN IF NOT EXISTS provenance_qualification TEXT,
  ADD COLUMN IF NOT EXISTS source_resume            TEXT,
  ADD COLUMN IF NOT EXISTS extraction_at            TIMESTAMPTZ;

-- BS retenus
CREATE TABLE IF NOT EXISTS bahyo_portfolio_bs_extrait (
  id               UUID PRIMARY KEY DEFAULT bahyo_uuid(),
  portfolio_id     UUID NOT NULL REFERENCES bahyo_portfolio_user(id) ON DELETE CASCADE,
  ref_locale       TEXT NOT NULL,
  aptitude         TEXT NOT NULL,
  acte             TEXT,
  verdict          TEXT NOT NULL DEFAULT 'competence' CHECK (verdict = 'competence'),
  force            bahyo_force NOT NULL,
  tiers            TEXT,
  extrait          TEXT,
  embedding        TEXT,
  valide_par_user  BOOLEAN NOT NULL DEFAULT FALSE,
  rang             TEXT,
  note_utilisateur TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_extrait_portfolio_ref UNIQUE (portfolio_id, ref_locale)
);

CREATE INDEX IF NOT EXISTS idx_extrait_portfolio ON bahyo_portfolio_bs_extrait(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_extrait_force     ON bahyo_portfolio_bs_extrait(force);
CREATE INDEX IF NOT EXISTS idx_extrait_valide    ON bahyo_portfolio_bs_extrait(portfolio_id, valide_par_user);

-- Candidats ecartes
CREATE TABLE IF NOT EXISTS bahyo_portfolio_ecarte (
  id           UUID PRIMARY KEY DEFAULT bahyo_uuid(),
  portfolio_id UUID NOT NULL REFERENCES bahyo_portfolio_user(id) ON DELETE CASCADE,
  ref_locale   TEXT NOT NULL,
  aptitude     TEXT NOT NULL,
  acte         TEXT,
  verdict      TEXT NOT NULL DEFAULT 'rejet' CHECK (verdict = 'rejet'),
  raison       TEXT NOT NULL,
  extrait      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ecarte_portfolio_ref UNIQUE (portfolio_id, ref_locale)
);

CREATE INDEX IF NOT EXISTS idx_ecarte_portfolio ON bahyo_portfolio_ecarte(portfolio_id);
