#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verifier_export.py — controle d'un export de l'atelier d'annotation Bahyo.

Implemente la Partie L.6 du cahier de recette du 18 septembre 2026 :
parcourt la structure, compte, et verifie qu'aucun champ n'est manquant.

C'est le script que la conversation SLM utilisera pour recetter le fichier
avant de constituer le jeu d'apprentissage.

Usage :
    python3 verifier_export.py export.json
    python3 verifier_export.py export.json --verbeux
    python3 verifier_export.py export.json --strict   # sort en erreur au 1er manque

Aucune dependance externe.
"""
import json
import sys
from collections import Counter, defaultdict

# ── Schema attendu — Partie L.2 du cahier de recette ─────────────────────────
CHAMPS_EXPERIENCE = [
    "id_experience", "profil", "poste", "secteur", "categorie",
    "texte_source", "date_import", "statut", "noyaux", "groupes_a3",
    "dialogues", "manques",
]
CHAMPS_NOYAU = [
    "id_noyau", "texte", "origine", "forme", "marquages_decoupeur",
    "version_decoupeur", "rang_dans_description", "annotations",
]
CHAMPS_MARQUAGES = ["verbe_faible", "objet_faible", "composition", "objet_prep"]
CHAMPS_ANNOTATION = [
    "id_annotation", "place", "regime", "identification", "sous_type",
    "candidat_composition", "annotateur", "horodatage", "version_manuel",
]
CHAMPS_GROUPE = [
    "id_groupe", "tiers", "tiers_source", "noyaux_membres",
    "finalite_exprimee", "inscription_finalite", "modes_exclusion",
    "potentiellement_performatif", "nom_bs_composite",
    "annotateur", "horodatage",
]
CHAMPS_MODE_EXCLUSION = ["mode", "justification", "annotateur", "horodatage"]
CHAMPS_DIALOGUE = [
    "id_dialogue", "contexte", "place", "type_dialogue", "tours",
    "resultat", "documents_consultes",
]
CHAMPS_TOUR = ["role", "contenu", "horodatage"]
CHAMPS_MANQUE = [
    "id_manque", "contexte", "type", "description", "statut",
    "resolution", "annotateur", "horodatage",
]

VOCAB = {
    "place": {"A1", "A2", "A3"},
    "regime": {"declaratif", "constatif", "orphelin", None},
    "sous_type": {"fonctionnel", "relationnel", "autre", None},
    "inscription_finalite": {"porte", "latent", "atomise", None},
    "mode_exclusion": {"objet_sans_rarete", "sans_chaine_finalite", "autre"},
    "tiers_source": {"explicite", "implicite", None},
    "categorie": {"sans_seme", "avec_tiers_seul", "riche", None},
    "statut_experience": {"nouveau", "en_cours", "annote", "a_revoir"},
    "statut_manque": {"ouvert", "en_discussion", "resolu"},
}

# ── Rapport ──────────────────────────────────────────────────────────────────
PBS = []
AVERTS = []


def pb(msg):
    PBS.append(msg)


def avert(msg):
    AVERTS.append(msg)


def champs_manquants(obj, attendus, ou):
    """Verifie la PRESENCE des cles (une valeur None est admise, une cle absente non)."""
    for c in attendus:
        if c not in obj:
            pb(f"{ou} : champ '{c}' ABSENT")


def verifier(doc, verbeux=False):
    if "experiences" not in doc:
        pb("racine : cle 'experiences' absente — ce n'est pas un export de l'atelier")
        return {}

    exps = doc["experiences"]
    c = Counter()
    par_place = Counter()
    par_regime = Counter()
    par_inscription = Counter()
    par_mode_exclusion = Counter()
    libelles_autre = Counter()
    champs_pratique = Counter()
    par_type_manque = Counter()
    par_statut_exp = Counter()
    questions_biocraft = defaultdict(set)
    annotateurs = Counter()
    versions_manuel = Counter()

    c["experiences"] = len(exps)

    for e in exps:
        ref_e = f"experience {e.get('id_experience', '?')} ({e.get('poste', '?')})"
        champs_manquants(e, CHAMPS_EXPERIENCE, ref_e)
        par_statut_exp[e.get("statut")] += 1

        if e.get("categorie") not in VOCAB["categorie"]:
            pb(f"{ref_e} : categorie inconnue '{e.get('categorie')}'")
        if e.get("statut") not in VOCAB["statut_experience"]:
            pb(f"{ref_e} : statut inconnu '{e.get('statut')}'")

        # L.3 — texte source integral, non tronque
        ts = e.get("texte_source")
        if e.get("exploitable") and not (ts or "").strip():
            pb(f"{ref_e} : marquee exploitable mais texte_source vide")
        if ts and (ts.rstrip().endswith("...") or ts.rstrip().endswith("…")):
            avert(f"{ref_e} : texte_source se termine par des points de suspension "
                  f"— verifier qu'il n'est pas tronque")

        ids_noyaux = set()

        for n in e.get("noyaux", []):
            ref_n = f"{ref_e} / noyau {n.get('id_noyau', '?')}"
            champs_manquants(n, CHAMPS_NOYAU, ref_n)
            ids_noyaux.add(n.get("id_noyau"))
            c["noyaux"] += 1

            mq = n.get("marquages_decoupeur")
            if not isinstance(mq, dict):
                pb(f"{ref_n} : marquages_decoupeur n'est pas un objet")
            else:
                champs_manquants(mq, CHAMPS_MARQUAGES, f"{ref_n}/marquages")

            if not (n.get("texte") or "").strip():
                pb(f"{ref_n} : texte vide")
            if n.get("rang_dans_description") is None:
                avert(f"{ref_n} : rang_dans_description absent — ordre non garanti")

            for a in n.get("annotations", []):
                ref_a = f"{ref_n} / annotation {a.get('place', '?')}"
                champs_manquants(a, CHAMPS_ANNOTATION, ref_a)
                c["annotations"] += 1
                par_place[a.get("place")] += 1
                if a.get("regime"):
                    par_regime[a["regime"]] += 1
                if a.get("annotateur"):
                    annotateurs[a["annotateur"]] += 1
                if a.get("version_manuel") is not None:
                    versions_manuel[a["version_manuel"]] += 1
                else:
                    pb(f"{ref_a} : version_manuel absente — tracabilite "
                       f"d'incrementalite rompue (L.4)")

                if a.get("place") not in VOCAB["place"]:
                    pb(f"{ref_a} : place invalide '{a.get('place')}'")
                if a.get("regime") not in VOCAB["regime"]:
                    pb(f"{ref_a} : regime invalide '{a.get('regime')}'")
                if a.get("sous_type") not in VOCAB["sous_type"]:
                    pb(f"{ref_a} : sous_type invalide '{a.get('sous_type')}'")
                if a.get("regime") == "declaratif" and not a.get("sous_type"):
                    avert(f"{ref_a} : declaratif sans sous_type "
                          f"(fonctionnel / relationnel attendu)")
                if a.get("ecart_assistant") and not (a.get("ecart_explication") or "").strip():
                    pb(f"{ref_a} : ecart avec l'assistant NON explicite "
                       f"— contraire aux regles d'application (F.3)")
                if a.get("ecart_assistant"):
                    c["annotations_avec_ecart"] += 1

                # Historique complet des reeditions (E.6)
                h = a.get("historique")
                if h is None:
                    avert(f"{ref_a} : pas de cle 'historique' "
                          f"(export lance avec ?historique=0 ?)")
                else:
                    c["revisions_archivees"] += len(h)
                    rev = a.get("revision")
                    if rev is not None and len(h) != rev - 1:
                        avert(f"{ref_a} : revision={rev} mais {len(h)} version(s) "
                              f"archivee(s) — attendu {rev - 1}")

        # ── Groupes A3 ────────────────────────────────────────────────────────
        for g in e.get("groupes_a3", []):
            ref_g = f"{ref_e} / groupe {g.get('id_groupe', '?')}"
            champs_manquants(g, CHAMPS_GROUPE, ref_g)
            c["groupes"] += 1
            par_inscription[g.get("inscription_finalite")] += 1

            if g.get("inscription_finalite") not in VOCAB["inscription_finalite"]:
                pb(f"{ref_g} : inscription_finalite invalide "
                   f"'{g.get('inscription_finalite')}'")
            if g.get("tiers_source") not in VOCAB["tiers_source"]:
                pb(f"{ref_g} : tiers_source invalide '{g.get('tiers_source')}'")

            # P.3 — plafond latent pour tiers implicite, porte desormais
            # sur inscription_finalite
            if g.get("tiers_source") == "implicite" and \
               g.get("inscription_finalite") == "porte":
                pb(f"{ref_g} : VIOLATION DU FORMALISME — tiers implicite "
                   f"annote 'porte' (plafond 'latent' du prompt A3 v0.2)")

            # ── P.5 — modes d'exclusion (specification du 22/09/2026) ──────
            modes_g = g.get("modes_exclusion")
            if modes_g is None:
                pb(f"{ref_g} : cle 'modes_exclusion' ABSENTE")
                modes_g = []
            noms_modes = []
            for m in modes_g:
                ref_m = f"{ref_g} / mode {m.get('mode', '?')}"
                champs_manquants(m, CHAMPS_MODE_EXCLUSION, ref_m)
                nom = m.get("mode")
                noms_modes.append(nom)
                c["modes_exclusion"] += 1
                par_mode_exclusion[nom] += 1
                if nom not in VOCAB["mode_exclusion"]:
                    avert(f"{ref_m} : mode hors du jeu initial — promotion "
                          f"enregistree au registre ?")
                if not (m.get("justification") or "").strip():
                    pb(f"{ref_m} : justification absente — exigee pour chaque mode")
                if nom == "autre":
                    lp = (m.get("libelle_propose") or "").strip()
                    if not lp:
                        pb(f"{ref_m} : mode 'autre' sans libelle_propose")
                    else:
                        libelles_autre[lp] += 1

            # 4.5 — derivation : potentiellement_performatif = (modes vide)
            pp = g.get("potentiellement_performatif")
            attendu = len(modes_g) == 0
            if pp is None:
                pb(f"{ref_g} : potentiellement_performatif ABSENT (champ derive attendu)")
            elif pp != attendu:
                pb(f"{ref_g} : potentiellement_performatif={pp} INCOHERENT avec "
                   f"{len(modes_g)} mode(s) d'exclusion (attendu {attendu})")
            elif pp:
                c["groupes_potentiellement_performatifs"] += 1

            # 4.6 — atomise implique sans_chaine_finalite
            if g.get("inscription_finalite") == "atomise" \
               and "sans_chaine_finalite" not in noms_modes:
                pb(f"{ref_g} : inscription 'atomise' sans le mode "
                   f"'sans_chaine_finalite' (regle 4.6)")

            if g.get("champ_pratique"):
                champs_pratique[g["champ_pratique"]] += 1

            # L.5 — coherence referentielle
            for nid in g.get("noyaux_membres", []):
                if nid not in ids_noyaux:
                    pb(f"{ref_g} : noyau membre {nid} ABSENT de l'experience")
            if not g.get("noyaux_membres"):
                avert(f"{ref_g} : groupe sans aucun noyau membre")

        # ── Dialogues ─────────────────────────────────────────────────────────
        for d in e.get("dialogues", []):
            ref_d = f"{ref_e} / dialogue {d.get('id_dialogue', '?')}"
            champs_manquants(d, CHAMPS_DIALOGUE, ref_d)
            c["dialogues"] += 1

            ctx = d.get("contexte") or {}
            if ctx.get("type") == "noyau" and ctx.get("id") not in ids_noyaux:
                pb(f"{ref_d} : contexte noyau {ctx.get('id')} ABSENT de l'experience")

            tours = d.get("tours") or []
            if not tours:
                pb(f"{ref_d} : dialogue sans aucun tour")
            for i, t in enumerate(tours):
                champs_manquants(t, CHAMPS_TOUR, f"{ref_d}/tour {i + 1}")
                if not (t.get("contenu") or "").strip():
                    pb(f"{ref_d}/tour {i + 1} : contenu vide")
                c["tours"] += 1

            # B.5 — jamais de resume cote stockage
            roles = [t.get("role") for t in tours]
            if roles and roles.count("annotateur") == 0:
                avert(f"{ref_d} : aucun tour de l'annotateur — fil incomplet ?")

        # ── Manques ───────────────────────────────────────────────────────────
        for m in e.get("manques", []):
            ref_m = f"{ref_e} / manque {m.get('id_manque', '?')}"
            champs_manquants(m, CHAMPS_MANQUE, ref_m)
            c["manques"] += 1
            par_type_manque[m.get("type")] += 1

            if m.get("statut") not in VOCAB["statut_manque"]:
                pb(f"{ref_m} : statut invalide '{m.get('statut')}'")
            if m.get("statut") == "resolu" and not (m.get("resolution") or "").strip():
                pb(f"{ref_m} : marque resolu sans texte de resolution (H.2)")

            ctx = m.get("contexte") or {}
            if ctx.get("type") == "noyau" and ctx.get("id") not in ids_noyaux:
                pb(f"{ref_m} : contexte noyau {ctx.get('id')} ABSENT de l'experience")

            # Le coeur pedagogique : la question que BioCraft devra poser
            q = m.get("question_type")
            if q:
                c["manques_avec_question"] += 1
                questions_biocraft[m.get("type")].add(q)
            else:
                avert(f"{ref_m} : manque sans 'question_type' — "
                      f"un manque sans sa question est a moitie perdu")

    return {
        "compteurs": c,
        "par_place": par_place,
        "par_regime": par_regime,
        "par_inscription": par_inscription,
        "par_mode_exclusion": par_mode_exclusion,
        "libelles_autre": libelles_autre,
        "champs_pratique": champs_pratique,
        "par_type_manque": par_type_manque,
        "par_statut_exp": par_statut_exp,
        "questions_biocraft": questions_biocraft,
        "annotateurs": annotateurs,
        "versions_manuel": versions_manuel,
    }


def bloc(titre, compteur, total=None):
    print(f"\n  {titre}")
    if not compteur:
        print("    (aucun)")
        return
    for k, v in sorted(compteur.items(), key=lambda x: -x[1]):
        pct = f"  {v / total * 100:5.1f} %" if total else ""
        print(f"    {str(k):<28} {v:>6}{pct}")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    verbeux = "--verbeux" in sys.argv
    strict = "--strict" in sys.argv

    if not args:
        print(__doc__)
        sys.exit(1)

    chemin = args[0]
    try:
        with open(chemin, encoding="utf-8") as f:
            doc = json.load(f)
    except json.JSONDecodeError as e:
        print(f"JSON invalide : {e}")
        sys.exit(2)
    except OSError as e:
        print(f"Lecture impossible : {e}")
        sys.exit(2)

    print("=" * 70)
    print("  CONTROLE D'EXPORT — atelier d'annotation Bahyo")
    print("=" * 70)

    meta = doc.get("meta", {})
    if meta:
        print(f"\n  Genere le    : {meta.get('genere_le')}")
        print(f"  Portee       : {meta.get('portee')}")
        print(f"  Schema       : {meta.get('version_schema')}")
        print(f"  Manuel       : v{meta.get('version_manuel_courante')}")
        print(f"  Historique   : {'inclus' if meta.get('historique_inclus') else 'EXCLU'}")
    else:
        avert("racine : bloc 'meta' absent")

    res = verifier(doc, verbeux)
    if not res:
        print("\n  Document inexploitable.")
        sys.exit(3)

    c = res["compteurs"]

    print("\n" + "-" * 70)
    print("  COMPTAGES (L.6)")
    print("-" * 70)
    for cle in ["experiences", "noyaux", "annotations", "revisions_archivees",
                "groupes", "groupes_potentiellement_performatifs",
                "modes_exclusion", "dialogues", "tours", "manques",
                "manques_avec_question", "annotations_avec_ecart"]:
        print(f"    {cle:<28} {c[cle]:>6}")

    bloc("Annotations par place", res["par_place"], c["annotations"] or None)
    bloc("Annotations par regime", res["par_regime"], c["annotations"] or None)
    bloc("Groupes par inscription dans la finalite", res["par_inscription"], c["groupes"] or None)
    bloc("Modes d'exclusion constates", res["par_mode_exclusion"])
    bloc("Experiences par statut", res["par_statut_exp"], c["experiences"] or None)
    bloc("Manques par type", res["par_type_manque"], c["manques"] or None)
    bloc("Annotateurs", res["annotateurs"])
    bloc("Versions des regles d'application referencees", res["versions_manuel"])
    if res["champs_pratique"]:
        bloc("Champs de pratique", res["champs_pratique"])

    # 4.4 — les libelles 'autre' recurrents meritent une promotion
    if res["libelles_autre"]:
        print("\n" + "-" * 70)
        print("  MODES 'AUTRE' CANDIDATS A LA PROMOTION")
        print("-" * 70)
        for lib, n in res["libelles_autre"].most_common():
            marque = "  <-- recurrent" if n >= 3 else ""
            print(f"    {n:>3}x  {lib}{marque}")

    # Le repertoire des questions — la matiere d'entrainement de BioCraft
    qb = res["questions_biocraft"]
    if qb:
        print("\n" + "-" * 70)
        print("  REPERTOIRE DES QUESTIONS BIOCRAFT")
        print("-" * 70)
        for t, qs in sorted(qb.items()):
            print(f"\n  {t} ({len(qs)} question(s) distinctes)")
            for q in sorted(qs)[: (None if verbeux else 3)]:
                print(f"    - {q}")
            if not verbeux and len(qs) > 3:
                print(f"    ... et {len(qs) - 3} autre(s) (--verbeux pour tout voir)")

    # Anomalies signalees par le serveur lui-meme
    srv = doc.get("anomalies") or []
    if srv:
        print("\n" + "-" * 70)
        print(f"  ANOMALIES SIGNALEES PAR LE SERVEUR ({len(srv)})")
        print("-" * 70)
        for a in srv[: (None if verbeux else 10)]:
            print(f"    ! {a}")
        if not verbeux and len(srv) > 10:
            print(f"    ... et {len(srv) - 10} autre(s)")

    print("\n" + "=" * 70)
    if PBS:
        print(f"  {len(PBS)} PROBLEME(S) BLOQUANT(S)")
        print("=" * 70)
        for p in PBS[: (None if verbeux else 25)]:
            print(f"    x {p}")
        if not verbeux and len(PBS) > 25:
            print(f"    ... et {len(PBS) - 25} autre(s) (--verbeux pour tout voir)")
    else:
        print("  AUCUN PROBLEME BLOQUANT — structure conforme au schema L.2")
        print("=" * 70)

    if AVERTS:
        print(f"\n  {len(AVERTS)} avertissement(s)")
        for a in AVERTS[: (None if verbeux else 15)]:
            print(f"    ~ {a}")
        if not verbeux and len(AVERTS) > 15:
            print(f"    ... et {len(AVERTS) - 15} autre(s)")

    print()
    if PBS and strict:
        sys.exit(1)
    sys.exit(1 if PBS else 0)


if __name__ == "__main__":
    main()
