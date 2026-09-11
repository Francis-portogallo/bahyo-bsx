-- Migration 006 : elargir la contrainte CHECK sur bahyo_source.type
-- version 006 | 2026-08-25 | PostgreSQL 9.6+
-- Depends on 000_schema_base.sql
--
-- sources.js detecte : LINKEDIN_ZIP, INSTAGRAM_ZIP, LINKEDIN_PDF, LINKEDIN_JSON,
-- CV_PDF, CV_DOCX, CERTIFICATION, ARCHIVE_ZIP, AUTRE (+ TEXTE_LIBRE via /texte-libre)
-- La contrainte initiale ne couvre que 5 valeurs. On l'elargit.
-- Pure ASCII. No BEGIN/COMMIT.

ALTER TABLE bahyo_source DROP CONSTRAINT IF EXISTS bahyo_source_type_check;

ALTER TABLE bahyo_source ADD CONSTRAINT bahyo_source_type_check
  CHECK (type IN (
    'FICHIER', 'URL', 'TEXTE_LIBRE',
    'LINKEDIN_ZIP', 'LINKEDIN_PDF', 'LINKEDIN_JSON',
    'INSTAGRAM_ZIP',
    'CV_PDF', 'CV_DOCX',
    'CERTIFICATION',
    'ARCHIVE_ZIP',
    'AUTRE'
  ));
