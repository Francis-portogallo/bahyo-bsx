-- ============================================================================
-- Migration 003 — ln_url sur bahyo_user
-- @version 003
-- @date    2026-08-24
-- @depends 001_portefeuille_brut.sql
-- ----------------------------------------------------------------------------
-- Contexte : auth.js Étage 1 stocke l'URL LinkedIn fournie à l'inscription
-- et la renvoie au login pour pré-remplir l'onboarding 2017.
-- Idempotent (IF NOT EXISTS / IF NOT COLUMN).
-- ============================================================================

BEGIN;

-- Colonne ln_url : URL de profil LinkedIn normalisée (sans https://www.)
ALTER TABLE bahyo_user
  ADD COLUMN IF NOT EXISTS ln_url TEXT;

-- Index pour retrouver un utilisateur par son URL LinkedIn
-- (utile pour le batch 2017 : retrouver les comptes à partir des URLs stockées)
CREATE INDEX IF NOT EXISTS idx_user_ln_url ON bahyo_user(ln_url)
  WHERE ln_url IS NOT NULL;

-- Peuplement pour les membres 2017 dont l'URL LN est déjà connue
-- À adapter selon votre table source (ex. bahyo_profil_2017, bahyo_legacy, etc.)
-- Exemple :
--   UPDATE bahyo_user u
--   SET ln_url = p.ln_url
--   FROM bahyo_profil_2017 p
--   WHERE p.email = u.email
--   AND u.ln_url IS NULL;

COMMIT;

-- ============================================================================
-- DOWN
-- ----------------------------------------------------------------------------
-- BEGIN;
-- DROP INDEX IF EXISTS idx_user_ln_url;
-- ALTER TABLE bahyo_user DROP COLUMN IF EXISTS ln_url;
-- COMMIT;
-- ============================================================================