# Bahyo — BSX (Étage 1)

Backend for Frontend + interface unifiée servis sur `bsx.bahyo.net`.
Version actuelle : **3.0.0** (Terroir · BScraft · Antichambre).

## Structure du repo

```
bahyo-bsx/
├── .cpanel.yml            recette de déploiement O2 auto
├── .gitignore
├── package.json.example   template dépendances (à renommer en package.json au 1er push)
├── README.md              ce fichier
├── src/
│   ├── server.js          Express + monte les routeurs
│   └── routes/
│       ├── auth.js        JWT, register, login, NDA, forgot-password
│       ├── admin.js       Superadmin : whitelist, comptes, NDA, stats
│       ├── portfolio.js   BS, analyse, validation, marchés
│       ├── sources.js     Upload fichiers, parsers LN/IG ZIP
│       └── wallet.js      Économie Talent
├── public/
│   └── index.html         Frontend v3.0.0 (Terroir/BScraft/Antichambre)
└── migrations/            Toutes les SQL, ordre 000 → 014
```

## Prérequis O2 (déjà en place)

- Node.js App **bsx.bahyo.net** créée dans cPanel (v20, mode production)
- Base PostgreSQL `qiyo9734_bahyo` avec user `qiyo9734_postgres`
- `.env` dans `~/bsx/.env` (DATABASE_URL, JWT_SECRET, SMTP_*, ADMIN_EMAIL, etc.)
- Variables d'environnement dans cPanel Node.js App

## Setup initial du workflow git (à faire 1 seule fois)

### 1. Sur Mac (repo local)

```bash
# Se placer dans le dossier téléchargé
cd ~/bahyo-bsx

# Renommer le template
mv package.json.example package.json

# Créer le premier commit
git init
git add .
git commit -m "Initial: v3.0.0 refonte 3 onglets"
git branch -M main
```

### 2. Sur GitHub

- Créer un **repo privé** `bahyo-bsx` (pas de README, pas de .gitignore, pas de licence)
- Générer un **Personal Access Token** (Settings → Developer settings → Personal access tokens → Fine-grained tokens) avec permission **Contents: Read** sur ce repo

### 3. Pousser depuis Mac

```bash
git remote add origin https://github.com/VOTRE_USER/bahyo-bsx.git
git push -u origin main
```

### 4. Sur cPanel

- **Git™ Version Control** → **Create**
- **Clone URL** : `https://VOTRE_USER:GHP_TOKEN@github.com/VOTRE_USER/bahyo-bsx.git`
- **Repository Path** : `/home2/qiyo9734/bahyo-bsx-git`
- **Repository Name** : `bahyo-bsx`
- **Create**

Puis onglet **Pull or Deploy** → **Update from Remote** → **Deploy HEAD Commit**.

## Workflow quotidien

```bash
cd ~/bahyo-bsx
# éditer les fichiers
git add . && git commit -m "v3.0.1: description"
git push
```

Puis dans cPanel Git™ → **Update from Remote** + **Deploy HEAD** (2 clics).

### Auto-deploy sur push (optionnel)

- GitHub → repo `bahyo-bsx` → **Settings** → **Webhooks** → **Add webhook**
- **Payload URL** : URL fournie par cPanel Git™ Version Control (bouton "How to deploy")
- **Content type** : `application/json`
- **Just the push event**

À chaque push, cPanel pull + déploie automatiquement.

## Migrations SQL

Non gérées par git — à exécuter manuellement dans phpPgAdmin (décocher "Paginer les résultats") dans l'ordre 000 → 014. Chaque migration inclut ses propres `GRANT` pour `qiyo9734_postgres`.

## Ce qui n'est PAS dans le repo (à ne jamais commiter)

- `.env` — secrets (mot de passe DB, JWT_SECRET, clé Anthropic)
- `node_modules/`
- `public/.htaccess` — géré par cPanel
- `.cagefs/`, `uploads/*`, `backups/*`

## Vérification post-deploy

```bash
curl -s https://bsx.bahyo.net/health
```

Doit retourner un JSON avec `"version":"1.3.0"` (serveur) et un timestamp récent.

Le fichier `~/bsx/.deploy-date` est écrit à chaque déploiement automatique.

