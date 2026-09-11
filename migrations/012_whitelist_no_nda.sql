-- Migration 012 : la whitelist est exemptee du NDA
-- version 012 | 2026-08-27 | PostgreSQL 9.6+
-- Depends on 011_users_management.sql + 008_nda_whitelist.sql
-- Pure ASCII. No BEGIN/COMMIT.

-- Les emails de la whitelist ne sont pas concernes par le NDA :
-- on retire l'obligation de re-signature et on marque le NDA comme "exempt"
UPDATE bahyo_user
SET force_nda_resign = FALSE,
    nda_signed_at    = COALESCE(nda_signed_at, NOW()),
    nda_version      = COALESCE(nda_version, 'exempt-whitelist')
WHERE email IN (SELECT email FROM bahyo_whitelist_email);
